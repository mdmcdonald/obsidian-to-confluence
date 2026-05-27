import { Plugin, Notice, MarkdownView, Workspace } from "obsidian";
import {
	ConfluenceUploadSettings,
	Publisher,
	ConfluencePageConfig,
	StaticSettingsLoader,
	MermaidRendererPlugin,
	UploadAdfFileResult,
} from "@markdown-confluence/lib";
import { MermaidElectronPNGRenderer, PNGQuality } from "./MermaidElectronPNGRenderer";
import { ConfluenceSettingTab } from "./ConfluenceSettingTab";
import ObsidianAdaptor, { TitleRename } from "./adaptors/obsidian";
import { CompletedModal } from "./CompletedModal";
import { ObsidianConfluenceClient } from "./MyBaseClient";
import {
	ConfluencePerPageForm,
	ConfluencePerPageUIValues,
	mapFrontmatterToConfluencePerPageUIValues,
} from "./ConfluencePerPageForm";

export interface ObsidianPluginSettings
	extends ConfluenceUploadSettings.ConfluenceSettings {
	mermaidQuality?: PNGQuality;  // 'low' | 'medium' | 'high', defaults to 'high'
	usePersonalAccessToken: boolean;
	accessToken: string;
	atlassianPassword: string;
	batchSize: number;
	batchDelayMs: number;
	debugLogging: boolean;
	deduplicateTitles: boolean;
}

interface FailedFile {
	fileName: string;
	reason: string;
}

interface UploadResults {
	errorMessage: string | null;
	failedFiles: FailedFile[];
	filesUploadResult: UploadAdfFileResult[];
	renamedFiles: TitleRename[];
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
		const authentication = this.settings.usePersonalAccessToken
			? { bearer: this.settings.accessToken }
			: {
				basic: {
					username: this.settings.atlassianUserName,
					password: this.settings.atlassianPassword,
				},
			};

		return new ObsidianConfluenceClient({
			host: this.settings.confluenceBaseUrl,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			authentication: authentication as any,
			debugLogging: this.settings.debugLogging,
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
					polyfillRecursive(data);
					return data;
				},
			},
		});
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

		const quality = this.settings.mermaidQuality || "high";
		const mermaidRenderer = new MermaidElectronPNGRenderer(quality, this);
		const mermaidPlugin = new MermaidRendererPlugin(mermaidRenderer);

		console.log(`[Confluence] Initializing client for ${this.settings.confluenceBaseUrl} (user: ${this.settings.atlassianUserName || "(PAT)"})`);

		const confluenceClient = this.getConfluenceClient();

		// The library's SettingsLoader.validateSettings rejects empty
		// folderToPublish, but we allow it to mean "publish everything".
		// Pass a placeholder to satisfy validation; the adaptor uses
		// this.settings directly where startsWith("") matches all paths.
		const loaderSettings = !this.settings.folderToPublish
			? { ...this.settings, folderToPublish: "/" }
			: this.settings;
		const settingsLoader = new StaticSettingsLoader(loaderSettings);
		this.publisher = new Publisher(
			this.adaptor,
			settingsLoader,
			confluenceClient,
			[mermaidPlugin],
		);
	}


	/**
	 * Publish a single batch of files. Restricts the adaptor's view to just
	 * these files so the library's tree-resolution + publish phases don't
	 * fan out across the entire vault.
	 */
	private async publishBatch(batchPaths: string[]): Promise<{
		successes: UploadAdfFileResult[];
		failures: FailedFile[];
	}> {
		this.adaptor.batchFilter = new Set(batchPaths);
		try {
			const adrFiles = await this.publisher.publish();

			// Library hardcodes Cloud /wiki/spaces/ in page URLs — rewrite for DC.
			for (const result of adrFiles) {
				if (result.successfulUploadResult) {
					result.successfulUploadResult.adfFile.pageUrl =
						result.successfulUploadResult.adfFile.pageUrl.replace("/wiki/spaces/", "/spaces/");
				}
				if (result.node?.file?.pageUrl) {
					result.node.file.pageUrl = result.node.file.pageUrl.replace("/wiki/spaces/", "/spaces/");
				}
			}

			const successes: UploadAdfFileResult[] = [];
			const failures: FailedFile[] = [];
			for (const element of adrFiles) {
				if (element.successfulUploadResult) {
					successes.push(element.successfulUploadResult);
					continue;
				}
				const reason = element.reason ?? "No Reason Provided";
				console.error(`[Confluence] FAILED ${element.node.file.absoluteFilePath}: ${reason}`);
				if (reason.includes("last updated by another user")) {
					console.error(`[Confluence] Page was last updated by a different account — check that your API credentials own these pages.`);
				}
				if (reason.includes("outside the page tree")) {
					console.error(`[Confluence] A page with this title already exists in a different location in Confluence.`);
				}
				failures.push({ fileName: element.node.file.absoluteFilePath, reason });
			}
			return { successes, failures };
		} finally {
			this.adaptor.batchFilter = undefined;
		}
	}

	async doPublish(publishFilter?: string): Promise<UploadResults> {
		console.log(`[Confluence] === Publish start (filter: ${publishFilter ?? "(all)"}) ===`);

		const paths = publishFilter
			? [publishFilter]
			: await this.adaptor.getAllPublishableFilePaths();

		// Pre-flight: rename any files whose effective Confluence title would
		// collide with another publishable file. Computed against the whole
		// vault (not just this batch) so cross-batch collisions are also
		// resolved. Skipped entirely when the setting is off.
		if (this.settings.deduplicateTitles) {
			await this.adaptor.computeTitleDedupMap();
		} else {
			this.adaptor.clearTitleDedupMap();
		}

		const batchSize = Math.max(1, this.settings.batchSize || 20);
		const batches: string[][] = [];
		for (let i = 0; i < paths.length; i += batchSize) {
			batches.push(paths.slice(i, i + batchSize));
		}

		console.log(`[Confluence] Publishing ${paths.length} file(s) in ${batches.length} batch(es) of ${batchSize}`);

		const aggregate: UploadResults = {
			errorMessage: null,
			failedFiles: [],
			filesUploadResult: [],
			renamedFiles: this.adaptor.getTitleRenames(),
		};

		if (paths.length === 0) {
			console.log(`[Confluence] === Publish Complete: nothing to publish ===`);
			return aggregate;
		}

		const notice = new Notice("Publishing to Confluence…", 0);
		const renderProgress = (batchIdx: number) => {
			const done = Math.min(batchIdx * batchSize, paths.length);
			notice.setMessage(
				`Publishing to Confluence\nBatch ${batchIdx}/${batches.length} — ${done}/${paths.length} files (✓${aggregate.filesUploadResult.length}  ✗${aggregate.failedFiles.length})`,
			);
		};

		try {
			for (let i = 0; i < batches.length; i++) {
				renderProgress(i + 1);
				try {
					const { successes, failures } = await this.publishBatch(batches[i]);
					aggregate.filesUploadResult.push(...successes);
					aggregate.failedFiles.push(...failures);
				} catch (err) {
					const reason = extractErrorMessage(err);
					console.error(`[Confluence] Batch ${i + 1} threw:`, err);
					for (const path of batches[i]) {
						aggregate.failedFiles.push({ fileName: path, reason });
					}
				}
				if (this.settings.batchDelayMs > 0 && i < batches.length - 1) {
					await new Promise((r) => setTimeout(r, this.settings.batchDelayMs));
				}
			}
		} finally {
			notice.setMessage(
				`Confluence publish done — ✓${aggregate.filesUploadResult.length}  ✗${aggregate.failedFiles.length}`,
			);
			setTimeout(() => notice.hide(), 3000);
		}

		console.log(`[Confluence] === Publish Complete: ${aggregate.filesUploadResult.length} succeeded, ${aggregate.failedFiles.length} failed ===`);
		return aggregate;
	}

	/** Used by the settings tab "Clear cache" button. */
	async clearMermaidCache(): Promise<number> {
		const adapter = this.app.vault.adapter;
		const dir = `${this.manifest.dir}/mermaid-cache`;
		if (!(await adapter.exists(dir))) return 0;
		const { files } = await adapter.list(dir);
		let removed = 0;
		for (const f of files) {
			await adapter.remove(f);
			removed++;
		}
		return removed;
	}

	override async onload() {
		await this.init();

		// Default to keeping pages in place on republish.
		// Users can set `connie-dont-change-parent-page: false` to opt into moving.
		ConfluencePageConfig.conniePerPageConfig.dontChangeParentPageId.default = true;

		this.addRibbonIcon("cloud", "Publish to Confluence", async () => {
			if (this.isSyncing) {
				new Notice("Syncing already on going");
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
						renamedFiles: [],
					},
				}).open();
			} finally {
				this.isSyncing = false;
			}
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
										renamedFiles: [],
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
										renamedFiles: [],
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
				mermaidQuality: "high" as PNGQuality,
				usePersonalAccessToken: false,
				accessToken: "",
				atlassianPassword: "",
				batchSize: 20,
				batchDelayMs: 0,
				debugLogging: false,
				deduplicateTitles: true,
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
		// Data Center attachment responses differ from Cloud in several ways.
		// The library expects Cloud-style fields. Polyfill them for Data Center:
		//
		// Publisher.js:82-91 builds currentAttachments using:
		//   - curr.metadata.comment       → CRASH if metadata absent
		//   - curr.extensions.fileId       → absent on DC
		//   - curr.extensions.collectionName → absent on DC
		//
		// Attachments.js:37,87 reads:
		//   - attachmentUploadResponse.extensions.fileId → absent on DC
		//
		if ("type" in obj && obj.type === "attachment" && "id" in obj) {
			// Ensure extensions object exists
			if (!obj.extensions) {
				obj.extensions = {};
			}
			// Polyfill fileId from the attachment's top-level id
			if (!obj.extensions.fileId) {
				obj.extensions.fileId = obj.id;
			}
			// Polyfill collectionName from the container id
			if (!obj.extensions.collectionName && obj.container?.id) {
				obj.extensions.collectionName = `contentId-${obj.container.id}`;
			}
			// Ensure metadata.comment exists (used as file hash for dedup)
			if (!obj.metadata) {
				obj.metadata = {};
			}
			if (obj.metadata.comment === undefined) {
				obj.metadata.comment = "";
			}
		}
		for (const key in obj) {
			if (Object.prototype.hasOwnProperty.call(obj, key)) {
				polyfillRecursive(obj[key]);
			}
		}
	}
}
