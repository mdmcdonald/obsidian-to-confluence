import { Plugin, Notice, MarkdownView, Workspace, loadMermaid } from "obsidian";
import {
	ConfluenceUploadSettings,
	Publisher,
	ConfluencePageConfig,
	StaticSettingsLoader,
	renderADFDoc,
	MermaidRendererPlugin,
	UploadAdfFileResult,
} from "@markdown-confluence/lib";
import { MermaidElectronPNGRenderer, PNGQuality } from "./MermaidElectronPNGRenderer";
import { ConfluenceSettingTab } from "./ConfluenceSettingTab";
import ObsidianAdaptor from "./adaptors/obsidian";
import { CompletedModal } from "./CompletedModal";
import { ObsidianConfluenceClient } from "./MyBaseClient";
import {
	ConfluencePerPageForm,
	ConfluencePerPageUIValues,
	mapFrontmatterToConfluencePerPageUIValues,
} from "./ConfluencePerPageForm";
import { Mermaid } from "mermaid";

export interface ObsidianPluginSettings
	extends ConfluenceUploadSettings.ConfluenceSettings {
	mermaidQuality?: PNGQuality;  // 'low' | 'medium' | 'high', defaults to 'high'
	isDataCenter: boolean;
	usePersonalAccessToken: boolean;
	accessToken: string;
	atlassianPassword: string;
}

interface FailedFile {
	fileName: string;
	reason: string;
}

interface UploadResults {
	errorMessage: string | null;
	failedFiles: FailedFile[];
	filesUploadResult: UploadAdfFileResult[];
}

export default class ConfluencePlugin extends Plugin {
	settings!: ObsidianPluginSettings;
	private isSyncing = false;
	workspace!: Workspace;
	publisher!: Publisher;
	adaptor!: ObsidianAdaptor;

	activeLeafPath(workspace: Workspace) {
		const activeView = workspace.getActiveViewOfType(MarkdownView);
		if (activeView && activeView.file) {
			console.log("Active file path:", activeView.file.path);
			return activeView.file.path;
		}
		console.log("No active markdown file found");
		return undefined;
	}

	getConfluenceClient(): ObsidianConfluenceClient {
		// Determine Auth Config
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let authentication: any = {};
		if (this.settings.isDataCenter) {
			if (this.settings.usePersonalAccessToken) {
				authentication = {
					bearer: this.settings.accessToken,
				};
			} else {
				authentication = {
					basic: {
						username: this.settings.atlassianUserName,
						password: this.settings.atlassianPassword,
					},
				};
			}
		} else {
			authentication = {
				basic: {
					email: this.settings.atlassianUserName,
					apiToken: this.settings.atlassianApiToken,
				},
			};
		}

		// Determine URL Suffix
		const urlSuffix = this.settings.isDataCenter ? "/rest" : "/wiki/rest";

		return new ObsidianConfluenceClient(
			{
				host: this.settings.confluenceBaseUrl,
				authentication: authentication,
				middlewares: {
					onError(e) {
						console.error("Confluence API Error:", e);
						if (
							"response" in e &&
							e.response &&
							"data" in e.response
						) {
							e.message =
								typeof e.response.data === "string"
									? e.response.data
									: JSON.stringify(e.response.data);
						}
					},
					onResponse: (data: unknown) => {
						if (this.settings.isDataCenter) {
							polyfillRecursive(data);
						}
						return data;
					},
				},
			},
			urlSuffix,
		);
	}

	async init() {
		await this.loadSettings();
		const { vault, metadataCache, workspace } = this.app;
		this.workspace = workspace;
		this.adaptor = new ObsidianAdaptor(
			vault,
			metadataCache,
			this.settings,
			this.app,
		);

		// Always use PNG now - Atlassian's SVG support is garbage after 20 years
		const quality = this.settings.mermaidQuality || "high";
		const mermaidRenderer = new MermaidElectronPNGRenderer(quality);
		const mermaidPlugin = new MermaidRendererPlugin(mermaidRenderer);

		console.log(
			`Using Electron PNG renderer (quality: ${quality}) - no external dependencies`,
		);

		console.log("Initializing Confluence client with:", {
			host: this.settings.confluenceBaseUrl,
			email: this.settings.atlassianUserName,
			hasApiToken: !!this.settings.atlassianApiToken,
			isDataCenter: this.settings.isDataCenter,
		});

		const confluenceClient = this.getConfluenceClient();

		const settingsLoader = new StaticSettingsLoader(this.settings);
		this.publisher = new Publisher(
			this.adaptor,
			settingsLoader,
			confluenceClient,
			[mermaidPlugin],
		);
	}


	async doPublish(publishFilter?: string): Promise<UploadResults> {
		console.log("[Confluence] === Starting Publish ===");
		console.log("[Confluence] Filter:", publishFilter ?? "(all files)");
		console.log("[Confluence] Settings:", {
			baseUrl: this.settings.confluenceBaseUrl,
			userName: this.settings.atlassianUserName,
			hasApiToken: !!this.settings.atlassianApiToken,
			folderToPublish: this.settings.folderToPublish,
			confluenceParentId: this.settings.confluenceParentId,
			firstHeadingPageTitle: this.settings.firstHeadingPageTitle,
			isDataCenter: this.settings.isDataCenter,
		});

		const adrFiles = await this.publisher.publish(publishFilter);

		// The library hardcodes /wiki/spaces/ in page URLs, which is correct
		// for Cloud but wrong for Data Center (which uses /spaces/).
		if (this.settings.isDataCenter) {
			for (const result of adrFiles) {
				if (result.successfulUploadResult) {
					result.successfulUploadResult.adfFile.pageUrl =
						result.successfulUploadResult.adfFile.pageUrl.replace("/wiki/spaces/", "/spaces/");
				}
				if (result.node?.file?.pageUrl) {
					result.node.file.pageUrl = result.node.file.pageUrl.replace("/wiki/spaces/", "/spaces/");
				}
			}
		}

		console.log(`[Confluence] Publisher returned ${adrFiles.length} file result(s)`);

		const returnVal: UploadResults = {
			errorMessage: null,
			failedFiles: [],
			filesUploadResult: [],
		};

		adrFiles.forEach((element) => {
			if (element.successfulUploadResult) {
				const result = element.successfulUploadResult;
				console.log(`[Confluence] SUCCESS: ${result.adfFile.absoluteFilePath} -> ${result.adfFile.pageUrl} (content: ${result.contentResult}, images: ${result.imageResult}, labels: ${result.labelResult})`);
				returnVal.filesUploadResult.push(result);
				return;
			}

			const reason = element.reason ?? "No Reason Provided";
			console.error(`[Confluence] FAILED: ${element.node.file.absoluteFilePath} -> ${reason}`);

			// Log extra context for common failure modes
			if (reason.includes("last updated by another user")) {
				console.error(`[Confluence] This usually means the page was just created or edited by a different account. Check that your API credentials match the account that owns these pages.`);
			}
			if (reason.includes("outside the page tree")) {
				console.error(`[Confluence] A page with this title already exists in a different location in Confluence.`);
			}

			returnVal.failedFiles.push({
				fileName: element.node.file.absoluteFilePath,
				reason,
			});
		});

		console.log(`[Confluence] === Publish Complete: ${returnVal.filesUploadResult.length} succeeded, ${returnVal.failedFiles.length} failed ===`);

		return returnVal;
	}

	override async onload() {
		await this.init();

		this.addRibbonIcon("cloud", "Publish to Confluence", async () => {
			if (this.isSyncing) {
				new Notice("Syncing already on going");
				return;
			}

			// Check if folder to publish is configured
			if (!this.settings.folderToPublish) {
				new Notice("Please configure 'Folder to Publish' in plugin settings");
				return;
			}

			this.isSyncing = true;
			try {
				const stats = await this.doPublish();
				new CompletedModal(this.app, {
					uploadResults: stats,
				}).open();
			} catch (error) {
				const errorMessage = extractErrorMessage(error);
				console.error("[Confluence] Publish failed with top-level error:", error);
				new CompletedModal(this.app, {
					uploadResults: {
						errorMessage,
						failedFiles: [],
						filesUploadResult: [],
					},
				}).open();
			} finally {
				this.isSyncing = false;
			}
		});

		this.addCommand({
			id: "adf-to-markdown",
			name: "ADF To Markdown",
			callback: async () => {
				console.log("HMMMM");
				const json = JSON.parse(
					'{"type":"doc","content":[{"type":"paragraph","content":[{"text":"Testing","type":"text"}]}],"version":1}',
				);
				console.log({ json });

				const confluenceClient = this.getConfluenceClient();
				const testingPage =
					await confluenceClient.content.getContentById({
						id: "9732097",
						expand: ["body.atlas_doc_format", "space"],
					});
				const adf = JSON.parse(
					testingPage.body?.atlas_doc_format?.value ||
						'{type: "doc", content:[]}',
				);
				renderADFDoc(adf);
			},
		});

		this.addCommand({
			id: "publish-current",
			name: "Publish Current File to Confluence",
			checkCallback: (checking: boolean) => {
				if (!this.isSyncing) {
					if (!checking) {
						const currentPath = this.activeLeafPath(this.workspace);
						if (!currentPath) {
							new Notice("No active markdown file to publish");
							return false;
						}
						this.isSyncing = true;
						this.doPublish(currentPath)
							.then((stats) => {
								new CompletedModal(this.app, {
									uploadResults: stats,
								}).open();
							})
							.catch((error) => {
								console.error("[Confluence] Publish current file failed:", error);
								new CompletedModal(this.app, {
									uploadResults: {
										errorMessage: extractErrorMessage(error),
										failedFiles: [],
										filesUploadResult: [],
									},
								}).open();
							})
							.finally(() => {
								this.isSyncing = false;
							});
					}
					return true;
				}
				return true;
			},
		});

		this.addCommand({
			id: "publish-all",
			name: "Publish All to Confluence",
			checkCallback: (checking: boolean) => {
				if (!this.isSyncing) {
					if (!checking) {
						// Check if folder to publish is configured
						if (!this.settings.folderToPublish) {
							new Notice("Please configure 'Folder to Publish' in plugin settings");
							return false;
						}
						this.isSyncing = true;
						this.doPublish()
							.then((stats) => {
								new CompletedModal(this.app, {
									uploadResults: stats,
								}).open();
							})
							.catch((error) => {
								console.error("[Confluence] Publish all failed:", error);
								new CompletedModal(this.app, {
									uploadResults: {
										errorMessage: extractErrorMessage(error),
										failedFiles: [],
										filesUploadResult: [],
									},
								}).open();
							})
							.finally(() => {
								this.isSyncing = false;
							});
					}
				}
				return true;
			},
		});

		this.addCommand({
			id: "enable-publishing",
			name: "Enable publishing to Confluence",
			editorCheckCallback: (checking, _editor, view) => {
				if (!view.file) {
					return false;
				}

				if (checking) {
					const frontMatter = this.app.metadataCache.getCache(
						view.file.path,
					)?.frontmatter;
					const file = view.file;
					const enabledForPublishing =
						(file.path.startsWith(this.settings.folderToPublish) &&
							(!frontMatter ||
								frontMatter["connie-publish"] !== false)) ||
						(frontMatter && frontMatter["connie-publish"] === true);
					return !enabledForPublishing;
				}

				this.app.fileManager.processFrontMatter(
					view.file,
					(frontmatter) => {
						if (
							view.file &&
							view.file.path.startsWith(
								this.settings.folderToPublish,
							)
						) {
							delete frontmatter["connie-publish"];
						} else {
							frontmatter["connie-publish"] = true;
						}
					},
				);
				return true;
			},
		});

		this.addCommand({
			id: "disable-publishing",
			name: "Disable publishing to Confluence",
			editorCheckCallback: (checking, _editor, view) => {
				if (!view.file) {
					return false;
				}

				if (checking) {
					const frontMatter = this.app.metadataCache.getCache(
						view.file.path,
					)?.frontmatter;
					const file = view.file;
					const enabledForPublishing =
						(file.path.startsWith(this.settings.folderToPublish) &&
							(!frontMatter ||
								frontMatter["connie-publish"] !== false)) ||
						(frontMatter && frontMatter["connie-publish"] === true);
					return enabledForPublishing;
				}

				this.app.fileManager.processFrontMatter(
					view.file,
					(frontmatter) => {
						if (
							view.file &&
							view.file.path.startsWith(
								this.settings.folderToPublish,
							)
						) {
							frontmatter["connie-publish"] = false;
						} else {
							delete frontmatter["connie-publish"];
						}
					},
				);
				return true;
			},
		});

		this.addCommand({
			id: "page-settings",
			name: "Update Confluence Page Settings",
			editorCallback: (_editor, view) => {
				if (!view.file) {
					return false;
				}

				const frontMatter = this.app.metadataCache.getCache(
					view.file.path,
				)?.frontmatter;

				const file = view.file;

				new ConfluencePerPageForm(this.app, {
					config: ConfluencePageConfig.conniePerPageConfig,
					initialValues:
						mapFrontmatterToConfluencePerPageUIValues(frontMatter),
					onSubmit: (values, close) => {
						const valuesToSet: Partial<ConfluencePageConfig.ConfluencePerPageAllValues> =
							{};
						for (const propertyKey in values) {
							if (
								Object.prototype.hasOwnProperty.call(
									values,
									propertyKey,
								)
							) {
								const element =
									values[
										propertyKey as keyof ConfluencePerPageUIValues
									];
								if (element.isSet) {
									valuesToSet[
										propertyKey as keyof ConfluencePerPageUIValues
									] = element.value as never;
								}
							}
						}
						this.adaptor.updateMarkdownValues(
							file.path,
							valuesToSet,
						);
						close();
					},
				}).open();
				return true;
			},
		});

		this.addSettingTab(new ConfluenceSettingTab(this.app, this));
	}

	override async onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			ConfluenceUploadSettings.DEFAULT_SETTINGS,
			{
				mermaidQuality: "high" as PNGQuality, // Default to high quality PNG
				isDataCenter: false,
				usePersonalAccessToken: false,
				accessToken: "",
				atlassianPassword: "",
			},
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		await this.init();
	}
}

function extractErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		// Include the response data if it's an HTTPError
		if ("response" in error && typeof (error as any).response === "object") {
			const resp = (error as any).response;
			const data = typeof resp.data === "string"
				? resp.data
				: JSON.stringify(resp.data);
			return `${error.message}\n\nAPI Response (status ${resp.status ?? "unknown"}):\n${data?.substring(0, 500) ?? "(empty)"}`;
		}
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	try {
		return JSON.stringify(error, null, 2);
	} catch {
		return String(error);
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function polyfillRecursive(obj: any) {
	if (obj && typeof obj === "object") {
		if ("username" in obj && !("accountId" in obj)) {
			obj.accountId = obj.username;
		}
		for (const key in obj) {
			if (Object.prototype.hasOwnProperty.call(obj, key)) {
				polyfillRecursive(obj[key]);
			}
		}
	}
}
