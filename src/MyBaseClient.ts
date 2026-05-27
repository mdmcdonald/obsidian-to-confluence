import {
	Api,
	Callback,
	Client,
	Config,
	RequestConfig,
} from "confluence.js";
import { requestUrl } from "obsidian";
import { RequiredConfluenceClient } from "@markdown-confluence/lib";
import { convertAdfToStorageFormat } from "./AdfToStorageFormat";

async function getAuthenticationToken(
	authentication: Config.Authentication | undefined,
): Promise<string | undefined> {
	if (!authentication) return undefined;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const bearer = (authentication as any).bearer;
	if (bearer) {
		return `Bearer ${bearer}`;
	}

	if ("basic" in authentication && authentication.basic) {
		if (
			"username" in authentication.basic &&
			"password" in authentication.basic
		) {
			const { username, password } = authentication.basic;
			return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
		}
	}

	return undefined;
}

const ATLASSIAN_TOKEN_CHECK_FLAG = "X-Atlassian-Token";
const ATLASSIAN_TOKEN_CHECK_NOCHECK_VALUE = "no-check";

/**
 * Optional shape on the client config used to gate verbose logging.
 * Set from main.ts when constructing the client.
 */
export interface VerbosityConfig {
	debugLogging?: boolean;
}

export class MyBaseClient implements Client {
	protected readonly urlSuffix = "/rest";
	// Maps attachment IDs (and fileIds) to filenames, populated from attachment
	// upload responses. Used during ADF-to-storage conversion so that media nodes
	// created by MermaidRendererPlugin (which lack __fileName) can be resolved.
	protected attachmentFileMap: Map<string, string> = new Map();

	constructor(protected readonly config: Config & VerbosityConfig) {}

	protected debug(...args: unknown[]): void {
		if (this.config.debugLogging) {
			console.log(...args);
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
			// Convert atlas_doc_format to storage (XHTML) format for content updates.
			// The @markdown-confluence/lib Publisher sends content as atlas_doc_format,
			// but Data Center silently ignores it via REST v1, accepting the request
			// but leaving the page body empty. Converting to storage format locally
			// is universally supported.
			if (
				requestConfig.method?.toUpperCase() === "PUT" &&
				requestConfig.url?.match(/^\/api\/content\//) &&
				requestConfig.data?.body?.atlas_doc_format
			) {
				const adfBody = requestConfig.data.body.atlas_doc_format;
				this.debug(`[Confluence API] Converting ADF to storage format (attachmentFileMap: ${this.attachmentFileMap.size} entries)`);
				try {
					const adfJson = JSON.parse(adfBody.value);
					if (this.config.debugLogging) {
						const mediaNodes: string[] = [];
						const findMedia = (node: unknown) => {
							if (!node || typeof node !== "object") return;
							const n = node as Record<string, unknown>;
							if (n.type === "media") {
								const a = (n.attrs ?? {}) as Record<string, unknown>;
								mediaNodes.push(JSON.stringify({ type: a.type, id: a.id, collection: a.collection, __fileName: a.__fileName, url: a.url }));
							}
							if (Array.isArray(n.content)) {
								for (const child of n.content) findMedia(child);
							}
						};
						findMedia(adfJson);
						if (mediaNodes.length > 0) {
							this.debug(`[Confluence API] ADF contains ${mediaNodes.length} media node(s):`, mediaNodes.join(", "));
						}
					}
					let storageValue = convertAdfToStorageFormat(adfJson, this.attachmentFileMap);
					// The library hardcodes /wiki/spaces/ in content links; rewrite for DC.
					storageValue = storageValue.replace(/\/wiki\/spaces\//g, "/spaces/");
					requestConfig.data = {
						...requestConfig.data,
						body: {
							storage: {
								value: storageValue,
								representation: "storage",
							},
						},
					};
					this.debug(`[Confluence API] Storage format (${storageValue.length} chars): ${storageValue.substring(0, 200)}`);
				} catch (conversionError) {
					console.warn(
						"[Confluence API] Local ADF-to-storage conversion failed, falling back to atlas_doc_format:",
						conversionError instanceof Error ? conversionError.message : String(conversionError),
					);
				}
			}

			// Data Center does not support PUT on /child/attachment (returns 405).
			// The confluence.js library uses PUT for createOrUpdateAttachments,
			// which works on Cloud but not DC. Track that we rewrote it so we
			// can handle "duplicate filename" errors with a retry below.
			let isRewrittenAttachmentPost = false;
			if (
				requestConfig.method?.toUpperCase() === "PUT" &&
				requestConfig.url?.match(/\/child\/attachment\/?$/)
			) {
				this.debug("[Confluence API] Rewriting PUT to POST for attachment upload");
				requestConfig.method = "POST";
				isRewrittenAttachmentPost = true;
			}

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

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			let requestBody: any[];
			if (requestContentType.startsWith("multipart/form-data")) {
				const formHeaders = requestConfig.data.getHeaders();
				// slice() gives a clean ArrayBuffer — Node Buffers can share a
				// pooled ArrayBuffer, so .buffer alone may include unrelated data.
				const buf: Buffer = requestConfig.data.getBuffer();
				const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
				requestBody = [formHeaders, arrayBuffer];
			} else {
				requestBody = [{}, JSON.stringify(requestConfig.data)];
			}

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
					Authorization: await getAuthenticationToken(this.config.authentication),
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
			this.debug(`[Confluence API] ${method} ${url}`);

			if (this.config.debugLogging && requestConfig.data && (method === "PUT" || method === "POST")) {
				const bodyStr = typeof requestBody[1] === "string" ? requestBody[1] : "(binary)";
				const bodyPreview = bodyStr.length > 500 ? bodyStr.substring(0, 500) + `... (${bodyStr.length} chars total)` : bodyStr;
				this.debug(`[Confluence API] Request body: ${bodyPreview}`);
			}

			const response = await requestUrl(modifiedRequestConfig);

			this.debug(`[Confluence API] Response: ${response.status} (${response.text?.length ?? 0} chars)`);

			if (this.config.debugLogging && method === "PUT" && requestConfig.url?.match(/^\/api\/content\//)) {
				const respPreview = (response.text ?? "").substring(0, 500);
				this.debug(`[Confluence API] Update response body: ${respPreview}`);
			}

			if (this.config.debugLogging && requestConfig.url?.match(/\/child\/attachment/)) {
				try {
					const parsed = response.json;
					if (parsed?.results && Array.isArray(parsed.results)) {
						this.debug(`[Confluence API] Attachment response: ${parsed.results.length} result(s)`);
						if (parsed.results.length > 0) {
							const first = parsed.results[0];
							this.debug(`[Confluence API] First attachment structure:`, JSON.stringify({
								id: first.id,
								type: first.type,
								title: first.title,
								hasMetadata: !!first.metadata,
								metadataComment: first.metadata?.comment ?? "(absent)",
								hasExtensions: !!first.extensions,
								extensionKeys: first.extensions ? Object.keys(first.extensions) : [],
								extensionsFileId: first.extensions?.fileId ?? "(absent)",
								extensionsCollectionName: first.extensions?.collectionName ?? "(absent)",
								hasContainer: !!first.container,
								containerId: first.container?.id ?? "(absent)",
							}));
						}
					}
				} catch {
					// Non-JSON response, skip
				}
			}

			const callbackResponseHandler =
				callback && ((data: T): void => callback(null, data));
			const defaultResponseHandler = (data: T): T => data;
			const responseHandler =
				callbackResponseHandler ?? defaultResponseHandler;

			// Post-process response data (polyfill container, track filenames,
			// call middlewares) and return via responseHandler.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const processAndReturn = (respData: any): void | T => {
				if (requestConfig.url?.match(/\/child\/attachment/)) {
					const pidMatch = requestConfig.url.match(/\/api\/content\/([^/]+)\/child\/attachment/);
					if (pidMatch) {
						const pid = pidMatch[1];
						if (respData?.results && Array.isArray(respData.results)) {
							for (const r of respData.results) {
								if (r && typeof r === "object" && !r.container) {
									r.container = { id: pid, type: "page" };
									this.debug(`[Confluence API] Polyfilled missing container on attachment ${r.id} with pageId=${pid}`);
								}
							}
						}
					}
				}
				this.config.middlewares?.onResponse?.(respData);
				if (respData?.results && Array.isArray(respData.results)) {
					for (const r of respData.results) {
						if (r?.type === "attachment" && r?.id && r?.title) {
							this.attachmentFileMap.set(String(r.id), String(r.title));
							if (r?.extensions?.fileId && r.extensions.fileId !== r.id) {
								this.attachmentFileMap.set(String(r.extensions.fileId), String(r.title));
							}
						}
					}
				}
				return responseHandler(respData);
			};

			if (response.status >= 400) {
				const errorBody = response.text || "(empty response)";

				// Data Center: POST to /child/attachment fails with "same file name"
				// when the attachment already exists. Cloud's PUT handles this
				// automatically. Retry by finding the existing attachment and
				// using the update-data endpoint.
				if (
					isRewrittenAttachmentPost &&
					errorBody.includes("same file name")
				) {
					const pageIdMatch = requestConfig.url?.match(/\/api\/content\/([^/]+)\/child\/attachment/);
					if (pageIdMatch) {
						const pageId = pageIdMatch[1];
						this.debug(`[Confluence API] Attachment exists, looking up existing attachments for page ${pageId}...`);

						const listUrl = `${this.config.host}${this.urlSuffix}/api/content/${pageId}/child/attachment?limit=200`;
						const authHeader = await getAuthenticationToken(this.config.authentication);
						const listResponse = await requestUrl({
							url: listUrl,
							method: "GET",
							headers: this.removeUndefinedProperties({
								"User-Agent": "Obsidian.md",
								Accept: "application/json",
								Authorization: authHeader,
							}),
							throw: false,
						});

						if (listResponse.status === 200) {
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							const existingAttachments = listResponse.json?.results as any[];
							if (existingAttachments) {
								const filenameMatch = errorBody.match(/same file name[^:]*:\s*(.+?)(?:\s*$|")/);
								const targetFilename = filenameMatch?.[1]?.trim();
								const existing = targetFilename
									? existingAttachments.find((a: { title: string }) => a.title === targetFilename)
									: null;

								if (existing?.id) {
									this.debug(`[Confluence API] Found existing attachment id=${existing.id} title="${existing.title}", updating via data endpoint`);

									const updateUrl = `${this.config.host}${this.urlSuffix}/api/content/${pageId}/child/attachment/${existing.id}/data`;
									const retryResponse = await requestUrl({
										url: updateUrl,
										method: "POST",
										headers: modifiedRequestConfig.headers,
										body: modifiedRequestConfig.body,
										contentType: modifiedRequestConfig.contentType,
										throw: false,
									});

									if (retryResponse.status < 400) {
										this.debug(`[Confluence API] Attachment update succeeded (${retryResponse.status})`);
										const retryData = retryResponse.text?.trim()
											? retryResponse.json
											: {};

										// Wrap single result in results array for consistency
										// eslint-disable-next-line @typescript-eslint/no-explicit-any
										const wrappedData = (retryData as any)?.results ? retryData : { results: [retryData] };

										return processAndReturn(wrappedData);
									} else {
										console.error(`[Confluence API] Attachment update failed (${retryResponse.status}): ${retryResponse.text?.substring(0, 500)}`);
									}
								} else {
									console.warn(`[Confluence API] Could not find existing attachment matching "${targetFilename}" among ${existingAttachments.length} attachments`);
								}
							}
						}
					}
				}

				console.error(`[Confluence API] Error ${response.status}: ${errorBody.substring(0, 1000)}`);
				throw new HTTPError(`Received a ${response.status}: ${errorBody.substring(0, 200)}`, {
					status: response.status,
					data: response.text,
				});
			}

			const responseData =
				response.text && response.text.trim().length > 0
					? response.json
					: {};

			return processAndReturn(responseData);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} catch (e: any) {
			const method = requestConfig.method?.toUpperCase() ?? "GET";
			const path = requestConfig.url ?? "(unknown)";

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
	constructor(config: Config & VerbosityConfig) {
		super(config);
	}
	content = new Api.Content(this);
	space = new Api.Space(this);
	contentAttachments = new Api.ContentAttachments(this);
	contentLabels = new Api.ContentLabels(this);
	users = new Api.Users(this);
}
