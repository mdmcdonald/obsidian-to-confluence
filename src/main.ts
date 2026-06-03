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
import { PublishRecord, detectOrphans, exceedsRemovalCap } from "./publishState";
import { CompletedModal } from "./CompletedModal";
import { ObsidianConfluenceClient } from "./MyBaseClient";
import { StructuredPublisher } from "./StructuredPublisher";
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
	/** Skip publishing notes whose rendered content is unchanged since last publish. */
	skipUnchanged: boolean;
	/** Emit a Page Properties panel from each note's frontmatter. */
	showMetadataPanel: boolean;
	/** Project taxonomy frontmatter (subject, type) onto Confluence labels. */
	mapTaxonomyToLabels: boolean;
	/** Mirror the vault folder hierarchy as nested Confluence pages. */
	preserveFolderStructure: boolean;
	/** What to do with a Confluence page whose source note was deleted/unpublished. */
	onDeletedNote: DeletedNoteAction;
	/**
	 * Safety cap: if a single full publish would remove more than this many
	 * pages, skip removal and report instead (guards against a misconfigured
	 * "Folder to publish" orphaning the whole space). 0 = no limit.
	 */
	maxDeletePerPublish: number;
	/**
	 * Per-path publish record (Confluence pageId + content hash) used by
	 * skip-unchanged and deletion detection. Keyed by vault path.
	 */
	publishedPages: Record<string, PublishRecord>;
	/** Epoch ms of last publish completion. Status-bar uses for "X min ago". */
	lastPublishedAt?: number;
	lastPublishSucceeded?: number;
	lastPublishFailed?: number;
}

export type DeletedNoteAction = "off" | "report" | "archive" | "trash";

function humanizeMillis(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	const d = Math.floor(h / 24);
	return `${d}d`;
}

interface FailedFile {
	fileName: string;
	reason: string;
}

interface OrphanSummary {
	action: DeletedNoteAction;
	ok: number;
	failed: number;
	ids: string[];
	/** pageIds actually removed (archived/trashed). Used to prune state. */
	removed: string[];
}

interface UploadResults {
	errorMessage: string | null;
	failedFiles: FailedFile[];
	filesUploadResult: UploadAdfFileResult[];
	renamedFiles: TitleRename[];
	/** Count of notes skipped as unchanged (skip-unchanged). */
	skipped?: number;
	/** Result of handling pages whose source note was removed, if any. */
	orphansHandled?: OrphanSummary | null;
}

export default class ConfluencePlugin extends Plugin {
	settings!: ObsidianPluginSettings;
	private isSyncing = false;
	workspace!: Workspace;
	publisher!: Publisher;
	adaptor!: ObsidianAdaptor;
	private statusBarEl: HTMLElement | null = null;

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
		this.adaptor.showMetadataPanel = this.settings.showMetadataPanel;
		this.adaptor.mapTaxonomyToLabels = this.settings.mapTaxonomyToLabels;
		this.adaptor.preserveFolderStructure = this.settings.preserveFolderStructure;

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
		this.publisher = this.settings.preserveFolderStructure
			? new StructuredPublisher(
					this.adaptor,
					settingsLoader,
					confluenceClient,
					[mermaidPlugin],
				)
			: new Publisher(
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

	async doPublish(publishFilter?: string, force = false): Promise<UploadResults> {
		const fullPublish = !publishFilter;
		console.log(`[Confluence] === Publish start (filter: ${publishFilter ?? "(all)"}${force ? ", force" : ""}) ===`);

		const paths = publishFilter
			? [publishFilter]
			: await this.adaptor.getAllPublishableFilePaths();

		// Pre-flight: build the publish context against the whole vault (not just
		// this batch). This computes the effective Confluence title for every
		// publishable file — needed both to resolve [[wikilinks]] to the right
		// page title and to rename any titles that would collide (the latter
		// only when the deduplicateTitles setting is on).
		await this.adaptor.computePublishContext(this.settings.deduplicateTitles);

		const aggregate: UploadResults = {
			errorMessage: null,
			failedFiles: [],
			filesUploadResult: [],
			renamedFiles: this.adaptor.getTitleRenames(),
			skipped: 0,
			orphansHandled: null,
		};

		// Skip-unchanged: hash each candidate's rendered content and skip those
		// matching the last publish. Only applies to a full publish — an explicit
		// single-file publish always goes through. The hash is still computed so
		// it can be stored after publishing.
		const hashByPath = new Map<string, string>();
		const publishPaths: string[] = [];
		let skipped = 0;
		const canSkip = fullPublish && this.settings.skipUnchanged && !force;
		for (const path of paths) {
			let hash: string;
			try {
				hash = `${await this.adaptor.computePublishHash(path)}|${this.settings.mermaidQuality || "high"}`;
			} catch {
				publishPaths.push(path); // can't hash → let the real publish surface the error
				continue;
			}
			hashByPath.set(path, hash);
			const prev = this.settings.publishedPages[path];
			if (canSkip && prev?.pageId && prev.hash === hash) {
				skipped++;
			} else {
				publishPaths.push(path);
			}
		}
		aggregate.skipped = skipped;

		const batchSize = Math.max(1, this.settings.batchSize || 20);
		const batches: string[][] = [];
		for (let i = 0; i < publishPaths.length; i += batchSize) {
			batches.push(publishPaths.slice(i, i + batchSize));
		}

		console.log(`[Confluence] ${publishPaths.length} to publish, ${skipped} unchanged, in ${batches.length} batch(es) of ${batchSize}`);

		// Note: we do NOT early-return when there is nothing to publish — on a
		// full publish, reconciliation still runs so deletions are detected even
		// if every note is unchanged (skipped) or all notes were removed.

		const notice = new Notice("Publishing to Confluence…", 0);
		const renderProgress = (batchIdx: number) => {
			const done = Math.min(batchIdx * batchSize, publishPaths.length);
			const msg = `Batch ${batchIdx}/${batches.length} — ${done}/${publishPaths.length} (✓${aggregate.filesUploadResult.length} ✗${aggregate.failedFiles.length}${skipped ? ` ⏭${skipped}` : ""})`;
			notice.setMessage(`Publishing to Confluence\n${msg}`);
			this.refreshStatusBar(`Confluence: ${msg}`);
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
			// Update the per-path publish record (for skip-unchanged) and, on a
			// full publish, archive/trash pages whose source note is now gone.
			try {
				aggregate.orphansHandled = await this.reconcilePublishState(
					paths,
					publishPaths,
					hashByPath,
					aggregate,
					fullPublish,
				);
			} catch (e) {
				console.error("[Confluence] Publish-state reconciliation failed:", e);
			}
		} finally {
			const orph = aggregate.orphansHandled;
			const orphMsg = orph && orph.ok ? `  ${orph.action === "trash" ? "🗑" : "📦"}${orph.ok}` : "";
			notice.setMessage(
				`Confluence publish done — ✓${aggregate.filesUploadResult.length} ✗${aggregate.failedFiles.length}${skipped ? ` ⏭${skipped}` : ""}${orphMsg}`,
			);
			setTimeout(() => notice.hide(), 3000);
			await this.persistPublishState(
				aggregate.filesUploadResult.length,
				aggregate.failedFiles.length,
			);
		}

		console.log(`[Confluence] === Publish Complete: ${aggregate.filesUploadResult.length} ok, ${aggregate.failedFiles.length} failed, ${skipped} skipped ===`);
		return aggregate;
	}

	/**
	 * After a publish, refresh the per-path publish record (pageId + content
	 * hash) used by skip-unchanged, and — on a full publish — detect pages whose
	 * source note is no longer publishable and hand them to handleOrphans.
	 *
	 * Orphan detection is keyed on pageId, not path, so a moved note (whose
	 * connie-page-id travels with it) is never treated as a deletion.
	 */
	private async reconcilePublishState(
		allPaths: string[],
		publishPaths: string[],
		hashByPath: Map<string, string>,
		aggregate: UploadResults,
		fullPublish: boolean,
	): Promise<OrphanSummary | null> {
		const next: Record<string, PublishRecord> = { ...this.settings.publishedPages };

		// Authoritative pageId per successfully-published path (from the result).
		const pageIdByPath = new Map<string, string>();
		for (const r of aggregate.filesUploadResult) {
			const af = r.adfFile as { absoluteFilePath?: string; pageId?: string } | undefined;
			if (af?.absoluteFilePath && af.pageId) {
				pageIdByPath.set(af.absoluteFilePath, String(af.pageId));
			}
		}

		// Record successful publishes; skipped files keep their existing record;
		// failed publishes are left untouched so they retry next time. We record
		// the pageId even if the hash is missing (computePublishHash threw) so
		// deletion tracking stays correct — an empty hash just never matches, so
		// the file republishes until a real hash is captured.
		for (const path of publishPaths) {
			const pageId = pageIdByPath.get(path);
			if (pageId) next[path] = { pageId, hash: hashByPath.get(path) ?? "" };
		}

		let orphansHandled: OrphanSummary | null = null;

		if (fullPublish) {
			// Safety valve: if NOTHING is publishable but pages are tracked, this
			// is almost certainly a misconfiguration (e.g. a wrong "Folder to
			// publish") rather than a real mass-deletion. Skip orphan handling so
			// we never archive/trash the entire space by accident.
			const trackedCount = Object.keys(this.settings.publishedPages).length;
			if (allPaths.length === 0 && trackedCount > 0) {
				console.warn(`[Confluence] 0 publishable notes found but ${trackedCount} page(s) tracked — skipping deletion to avoid mass-removal from a likely misconfiguration. Check "Folder to publish"; use "Reset publish cache" if this is intentional.`);
				new Notice("Confluence: 0 publishable notes — skipping deletion (likely misconfiguration).");
				this.settings.publishedPages = next;
				return null;
			}
			// Detect orphaned pages (move-safe: a reused pageId is never an orphan).
			const currentSet = new Set(allPaths);
			const { kept, orphanPageIds } = detectOrphans(next, currentSet);
			// Orphan path→record map (for retaining ones we couldn't remove).
			const orphanEntries = Object.entries(next).filter(
				([p, rec]) => !currentSet.has(p) && rec.pageId && orphanPageIds.includes(rec.pageId),
			);

			// Safety valve #2: a suspiciously large orphan set almost always means
			// a misconfiguration (e.g. a "Folder to publish" typo dropping most
			// notes) rather than a real bulk deletion. For destructive modes, skip
			// removal and report instead — and keep the full record (no pruning)
			// so it re-evaluates correctly once the misconfig is fixed.
			const cap = this.settings.maxDeletePerPublish ?? 25;
			const destructive = this.settings.onDeletedNote === "archive" || this.settings.onDeletedNote === "trash";
			if (destructive && exceedsRemovalCap(orphanPageIds.length, cap)) {
				console.warn(`[Confluence] ${orphanPageIds.length} orphaned page(s) exceeds the safety limit (${cap}) — NOT removing them. Check "Folder to publish"; raise "Max pages to remove per publish" (or set 0) if this is intentional. Page IDs: ${orphanPageIds.join(", ")}`);
				new Notice(`Confluence: ${orphanPageIds.length} pages would be removed — over the safety limit of ${cap}. Skipped; see console.`, 10000);
				this.settings.publishedPages = next; // keep everything tracked
				return { action: "report", ok: 0, failed: orphanPageIds.length, ids: orphanPageIds, removed: [] };
			}

			if (orphanPageIds.length > 0 && this.settings.onDeletedNote !== "off") {
				orphansHandled = await this.handleOrphans(orphanPageIds, this.settings.onDeletedNote);
			} else if (orphanPageIds.length > 0) {
				console.log(`[Confluence] ${orphanPageIds.length} orphaned page(s) detected; deletion is off.`);
			}

			// Prune state, but RETAIN any orphan whose page we did not actually
			// remove, so it is not silently forgotten: a failed/unsupported
			// archive is retried, and orphans seen in "report" mode persist until
			// really removed. Only "off" drops orphan records without tracking.
			const removed = new Set(orphansHandled?.removed ?? []);
			const finalState = { ...kept };
			if (this.settings.onDeletedNote !== "off") {
				for (const [p, rec] of orphanEntries) {
					if (!removed.has(rec.pageId)) finalState[p] = rec;
				}
			}
			this.settings.publishedPages = finalState;
			return orphansHandled;
		}

		this.settings.publishedPages = next;
		return orphansHandled;
	}

	/** Archive / trash / report Confluence pages whose source note is gone. */
	private async handleOrphans(pageIds: string[], mode: DeletedNoteAction): Promise<OrphanSummary> {
		if (mode === "report") {
			console.log(`[Confluence] Orphaned page(s) (source note removed): ${pageIds.join(", ")}`);
			new Notice(`Confluence: ${pageIds.length} orphaned page(s) — see console (deletion set to report-only)`);
			return { action: "report", ok: 0, failed: 0, ids: pageIds, removed: [] };
		}
		const client = this.getConfluenceClient();
		let ok = 0;
		let failed = 0;
		let archiveUnsupported = false;
		const removed: string[] = [];
		for (const id of pageIds) {
			// Confluence page ids are positive integers; refuse anything else so a
			// corrupted record can never target page 0 or a malformed id.
			if (!/^[1-9][0-9]*$/.test(id)) {
				failed++;
				console.error(`[Confluence] Skipping orphan with invalid pageId ${JSON.stringify(id)}`);
				continue;
			}
			try {
				if (mode === "archive") {
					await client.content.archivePages({ pages: [{ id: Number(id) }] });
				} else {
					await client.content.deleteContent({ id });
				}
				ok++;
				removed.push(id);
				console.log(`[Confluence] ${mode === "archive" ? "Archived" : "Trashed"} orphaned page ${id}`);
			} catch (e) {
				failed++;
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const status = (e as any)?.response?.status;
				// 405/404 on the bulk-archive endpoint means this Confluence Data
				// Center version doesn't expose POST /rest/api/content/archive.
				if (mode === "archive" && (status === 405 || status === 404)) {
					archiveUnsupported = true;
				}
				console.error(`[Confluence] Failed to ${mode} orphaned page ${id} (status ${status ?? "?"}):`, e);
			}
		}
		if (archiveUnsupported) {
			console.warn(`[Confluence] The archive REST endpoint (POST /rest/api/content/archive) is not available on this Confluence Data Center version. Set "When a note is deleted" to "Move to trash" or "Report only".`);
			new Notice(`Confluence: this server doesn't support the archive API — ${pageIds.length - ok} page(s) left in place. Switch "When a note is deleted" to Trash or Report.`, 12000);
		}
		return { action: mode, ok, failed, ids: pageIds, removed };
	}

	private setupStatusBar(): void {
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("confluence-status-bar");
		this.statusBarEl.style.cursor = "pointer";
		this.statusBarEl.setAttribute("aria-label", "Click to publish current file to Confluence");
		this.statusBarEl.addEventListener("click", () => this.publishCurrentFromStatusBar());
		this.refreshStatusBar();
		// Refresh "X min ago" once a minute so the relative time stays current.
		this.registerInterval(window.setInterval(() => this.refreshStatusBar(), 60_000));
	}

	private refreshStatusBar(override?: string): void {
		if (!this.statusBarEl) return;
		if (override !== undefined) {
			this.statusBarEl.setText(override);
			return;
		}
		const last = this.settings.lastPublishedAt;
		if (!last) {
			this.statusBarEl.setText("Confluence: never published");
			return;
		}
		const ago = humanizeMillis(Date.now() - last);
		const failed = this.settings.lastPublishFailed ?? 0;
		const succeeded = this.settings.lastPublishSucceeded ?? 0;
		const summary = failed > 0
			? `✗ ${failed} failed (${succeeded} ok)`
			: `✓ ${succeeded} ok`;
		this.statusBarEl.setText(`Confluence: ${summary} · ${ago} ago`);
	}

	private publishCurrentFromStatusBar(): void {
		if (this.isSyncing) {
			new Notice("Publish already in progress");
			return;
		}
		const currentPath = this.activeLeafPath(this.workspace);
		if (!currentPath) {
			new Notice("No active markdown file to publish");
			return;
		}
		this.isSyncing = true;
		this.doPublish(currentPath)
			.then((stats) => {
				new CompletedModal(this.app, { uploadResults: stats }).open();
			})
			.catch((error) => {
				console.error("[Confluence] Publish from status bar failed:", error);
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

	/** Persist publish state without re-running init() (which rebuilds the Publisher). */
	private async persistPublishState(succeeded: number, failed: number): Promise<void> {
		this.settings.lastPublishedAt = Date.now();
		this.settings.lastPublishSucceeded = succeeded;
		this.settings.lastPublishFailed = failed;
		await this.saveData(this.settings);
		this.refreshStatusBar();
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

		this.setupStatusBar();

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
			id: "force-publish-all",
			name: "Force republish all to Confluence (ignore unchanged)",
			checkCallback: (checking: boolean) => {
				if (!this.isSyncing) {
					if (!checking) {
						this.isSyncing = true;
						this.doPublish(undefined, true)
							.then((stats) => {
								new CompletedModal(this.app, {
									uploadResults: stats,
								}).open();
							})
							.catch((error) => {
								console.error("[Confluence] Force republish all failed:", error);
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
				skipUnchanged: true,
				showMetadataPanel: true,
				mapTaxonomyToLabels: false,
				preserveFolderStructure: true,
				onDeletedNote: "off" as DeletedNoteAction,
				maxDeletePerPublish: 25,
				publishedPages: {},
			},
			await this.loadData(),
		);
		if (!this.settings.publishedPages) this.settings.publishedPages = {};
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
