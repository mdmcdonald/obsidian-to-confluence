import {
	Api,
	Callback,
	Client,
	Config,
	RequestConfig,
} from "confluence.js";
import { requestUrl } from "obsidian";
import { RequiredConfluenceClient } from "@markdown-confluence/lib";

async function getAuthenticationToken(
	authentication: Config.Authentication | undefined,
	requestData?: { baseURL: string; url: string; method: string },
): Promise<string | undefined> {
	if (!authentication) return undefined;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	if ((authentication as any).bearer) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return `Bearer ${(authentication as any).bearer}`;
	}

	if ("basic" in authentication && authentication.basic) {
		if (
			"email" in authentication.basic &&
			"apiToken" in authentication.basic
		) {
			const { email, apiToken } = authentication.basic;
			return `Basic ${Buffer.from(`${email}:${apiToken}`).toString(
				"base64",
			)}`;
		}
		if (
			"username" in authentication.basic &&
			"password" in authentication.basic
		) {
			const { username, password } = authentication.basic;
			return `Basic ${Buffer.from(`${username}:${password}`).toString(
				"base64",
			)}`;
		}
	}

	return undefined;
}

const ATLASSIAN_TOKEN_CHECK_FLAG = "X-Atlassian-Token";
const ATLASSIAN_TOKEN_CHECK_NOCHECK_VALUE = "no-check";

export class MyBaseClient implements Client {
	protected urlSuffix = "/wiki/rest";

	constructor(
		protected readonly config: Config,
		urlSuffix?: string,
	) {
		if (urlSuffix) {
			this.urlSuffix = urlSuffix;
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	protected paramSerializer(parameters: Record<string, any>): string {
		if (!parameters) {
			return "";
		}
		const parts: string[] = [];

		Object.entries(parameters).forEach(([key, value]) => {
			if (value === null || typeof value === "undefined") {
				return;
			}

			if (Array.isArray(value)) {
				// eslint-disable-next-line no-param-reassign
				value = value.join(",");
			}

			if (value instanceof Date) {
				// eslint-disable-next-line no-param-reassign
				value = value.toISOString();
			} else if (value !== null && typeof value === "object") {
				// eslint-disable-next-line no-param-reassign
				value = JSON.stringify(value);
			} else if (value instanceof Function) {
				const part = value();

				return part && parts.push(part);
			}

			parts.push(`${this.encode(key)}=${this.encode(value)}`);

			return;
		});

		return parts.join("&");
	}

	protected encode(value: string) {
		return encodeURIComponent(value)
			.replace(/%3A/gi, ":")
			.replace(/%24/g, "$")
			.replace(/%2C/gi, ",")
			.replace(/%20/g, "+")
			.replace(/%5B/gi, "[")
			.replace(/%5D/gi, "]");
	}

	protected removeUndefinedProperties(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		obj: Record<string, any>,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	): Record<string, any> {
		return Object.entries(obj)
			.filter(([, value]) => typeof value !== "undefined")
			.reduce(
				(accumulator, [key, value]) => ({
					...accumulator,
					[key]: value,
				}),
				{},
			);
	}

	async sendRequest<T>(
		requestConfig: RequestConfig,
		callback: never,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		telemetryData?: any,
	): Promise<T>;
	async sendRequest<T>(
		requestConfig: RequestConfig,
		callback: Callback<T>,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		telemetryData?: any,
	): Promise<void>;
	async sendRequest<T>(
		requestConfig: RequestConfig,
		callback: Callback<T> | never,
	): Promise<void | T> {
		try {
			const contentType = (requestConfig.headers ?? {})[
				"content-type"
			]?.toString();
			if (requestConfig.headers && contentType) {
				requestConfig.headers["Content-Type"] = contentType;
				delete requestConfig?.headers["content-type"];
			}

			const params = this.paramSerializer(requestConfig.params);

			let requestContentType =
				(requestConfig.headers ?? {})["Content-Type"]?.toString() ??
				"application/json";

			const requestBody = requestContentType.startsWith(
				"multipart/form-data",
			)
				? [
						requestConfig.data.getHeaders(),
						requestConfig.data.getBuffer().buffer,
				  ]
				: [{}, JSON.stringify(requestConfig.data)];

			if (
				requestBody[0] &&
				"content-type" in requestBody[0] &&
				requestBody[0]["content-type"]
			) {
				requestContentType = requestBody[0]["content-type"];
			}

			const modifiedRequestConfig = {
				...requestConfig,
				headers: this.removeUndefinedProperties({
					"User-Agent": "Obsidian.md",
					Accept: "application/json",
					[ATLASSIAN_TOKEN_CHECK_FLAG]: this.config
						.noCheckAtlassianToken
						? ATLASSIAN_TOKEN_CHECK_NOCHECK_VALUE
						: undefined,
					...this.config.baseRequestConfig?.headers,
					Authorization:
						await getAuthenticationToken(
							this.config.authentication,
							{
								// eslint-disable-next-line @typescript-eslint/naming-convention
								baseURL: this.config.host,
								url: `${this.config.host}${this.urlSuffix}`,
								method: requestConfig.method ?? "GET",
							},
						),
					...requestConfig.headers,
					"Content-Type": requestContentType,
					...requestBody[0],
				}),
				url: `${this.config.host}${this.urlSuffix}${requestConfig.url}?${params}`,
				body: requestBody[1],
				method: requestConfig.method?.toUpperCase() ?? "GET",
				contentType: requestContentType,
				throw: false,
			};
			delete modifiedRequestConfig.data;

			const method = modifiedRequestConfig.method;
			const url = modifiedRequestConfig.url;
			console.log(`[Confluence API] ${method} ${url}`);

			// Log request body for content mutations (but truncate large bodies)
			if (requestConfig.data && (method === "PUT" || method === "POST")) {
				const bodyStr = typeof requestBody[1] === "string" ? requestBody[1] : "(binary)";
				const bodyPreview = bodyStr.length > 500 ? bodyStr.substring(0, 500) + `... (${bodyStr.length} chars total)` : bodyStr;
				console.log(`[Confluence API] Request body: ${bodyPreview}`);
			}

			const response = await requestUrl(modifiedRequestConfig);

			console.log(`[Confluence API] Response: ${response.status} (${response.text?.length ?? 0} chars)`);

			if (response.status >= 400) {
				const errorBody = response.text || "(empty response)";
				console.error(`[Confluence API] Error ${response.status}: ${errorBody.substring(0, 1000)}`);
				throw new HTTPError(`Received a ${response.status}: ${errorBody.substring(0, 200)}`, {
					status: response.status,
					data: response.text,
				});
			}

			const callbackResponseHandler =
				callback && ((data: T): void => callback(null, data));
			const defaultResponseHandler = (data: T): T => data;

			const responseHandler =
				callbackResponseHandler ?? defaultResponseHandler;

			const responseData =
				response.text && response.text.trim().length > 0
					? response.json
					: {};
			this.config.middlewares?.onResponse?.(responseData);

			return responseHandler(responseData);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} catch (e: any) {
			const method = requestConfig.method?.toUpperCase() ?? "GET";
			const path = requestConfig.url ?? "(unknown)";

			// Extract the most useful error message
			let errorDetail = "";
			if (e instanceof HTTPError) {
				errorDetail = typeof e.response.data === "string"
					? e.response.data.substring(0, 500)
					: JSON.stringify(e.response.data).substring(0, 500);
			} else if (e instanceof Error) {
				errorDetail = e.message;
			} else {
				errorDetail = JSON.stringify(e).substring(0, 500);
			}
			console.error(`[Confluence API] ${method} ${path} failed: ${errorDetail}`);

			const err = e.isAxiosError && e.response ? e.response.data : e;

			const callbackErrorHandler =
				callback && ((error: any) => callback(error));
			const defaultErrorHandler = (error: Error) => {
				throw error;
			};

			const errorHandler = callbackErrorHandler ?? defaultErrorHandler;

			this.config.middlewares?.onError?.(err);

			return errorHandler(err);
		}
	}
}

export interface ErrorData {
	data: unknown;
	status: number;
}

export class HTTPError extends Error {
	constructor(
		msg: string,
		public response: ErrorData,
	) {
		super(msg);

		// Set the prototype explicitly.
		Object.setPrototypeOf(this, HTTPError.prototype);
	}
}

export class ObsidianConfluenceClient
	extends MyBaseClient
	implements RequiredConfluenceClient
{
	constructor(config: Config, urlSuffix?: string) {
		super(config, urlSuffix);
	}
	content = new Api.Content(this);
	space = new Api.Space(this);
	contentAttachments = new Api.ContentAttachments(this);
	contentLabels = new Api.ContentLabels(this);
	users = new Api.Users(this);
}
