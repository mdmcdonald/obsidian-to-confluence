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

			const requestContentType =
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

			const response = await requestUrl(modifiedRequestConfig);

			if (response.status >= 400) {
				throw new HTTPError(`Received a ${response.status}`, {
					status: response.status,
					data: response.text,
				});
			}

			const callbackResponseHandler =
				callback && ((data: T): void => callback(null, data));
			const defaultResponseHandler = (data: T): T => data;

			const responseHandler =
				callbackResponseHandler ?? defaultResponseHandler;

			const responseData = response.json;
			this.config.middlewares?.onResponse?.(responseData);

			return responseHandler(responseData);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} catch (e: any) {
			console.warn({ httpError: e, requestConfig });
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
