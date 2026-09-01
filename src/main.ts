import { Plugin, Notice, MarkdownView, Workspace, TFile, normalizePath } from "obsidian";
import {
	ConfluenceUploadSettings,
	Publisher,
	ConfluencePageConfig,
	MermaidRendererPlugin,
	UploadAdfFileResult,
} from "@markdown-confluence/lib";
import { MermaidElectronPNGRenderer, PNGQuality } from "./MermaidElectronPNGRenderer";
import { ConfluenceSettingTab } from "./ConfluenceSettingTab";
import ObsidianAdaptor from "./adaptors/obsidian";
import { PublishRecord, detectOrphans, exceedsRemovalCap } from "./publishState";
import { CompletedModal } from "./CompletedModal";
import { ObsidianConfluenceClient } from "./MyBaseClient";
import { StructuredPublisher, ROOT_MANAGED_PROPERTY, mayWriteRootLanding } from "./StructuredPublisher";
import { DataCenterSettingsLoader } from "./DataCenterSettingsLoader";
import { isPathInFolder, type ChildrenMacroMode } from "./folderTree";
import { DeletedNoteAction, FailedFile, OrphanSummary, UploadResults } from "./publishResults";
import { LinkDiagnostic, summariseDiagnostics } from "./linkDiagnostics";
import { DEFAULT_NAVIGATION_SETTINGS, type AdaptorNavigationSettings } from "./adaptors/obsidian";
import type { ConsumeFirstHeading, TitleSource } from "./titleResolution";
import type { AssetLinkMode } from "./attachments";
import type { LatexRendering } from "./AdfToStorageFormat";
import type { TaxonomyLabelField } from "./taxonomyLabels";
import { formatDryRunReport, type DryRunInput, type DryRunResult } from "./dryRun";
import {
	ConfluencePerPageForm,
	ConfluencePerPageUIValues,
	mapFrontmatterToConfluencePerPageUIValues,
} from "./ConfluencePerPageForm";

export interface ObsidianPluginSettings extends ConfluenceUploadSettings.ConfluenceSettings {
	mermaidQuality?: PNGQuality; // 'low' | 'medium' | 'high', defaults to 'high'
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
	// -- Navigation publishing (see docs/navigation-publishing-spec.md) ------
	/** Where a page's title comes from before `connie-title` overrides it. */
	titleSource: TitleSource;
	/** Whether the body's first heading is removed once it became the title. */
	consumeFirstHeading: ConsumeFirstHeading;
	/** Folder pages titled by their landing file, or by the folder name. */
	folderTitleSource: "segment" | "landing";
	/** Folder path (or basename) → the title its page should carry. */
	folderDisplayNames: Record<string, string>;
	/** Glob patterns excluded from the publish set, one per line in settings. */
	excludeGlobs: string[];
	/** Vault-relative YAML/text file holding more exclusion patterns. */
	excludeListFile: string;
	/** How a relative link to a non-markdown file is published. */
	assetLinkMode: AssetLinkMode;
	/** Base URL used by assetLinkMode "base-url". */
	assetLinkBaseUrl: string;
	/** File extensions treated as linkable assets. */
	assetLinkExtensions: string[];
	/** Which frontmatter fields feed the Confluence label set. */
	labelSources: Record<TaxonomyLabelField, boolean>;
	/** Vault-relative YAML vocabulary; labels outside it are dropped. */
	labelAllowlistFile: string;
	/** Per-source label prefixes, e.g. { type: "type-" }. */
	labelPrefixes: Record<string, string>;
	/** Maximum labels applied per page (0 = uncapped). */
	labelMaxPerPage: number;
	/** Publish the root folder's landing file into the configured parent page. */
	publishRootLanding: boolean;
	/** Children Display macro policy for folder pages. */
	childrenMacro: ChildrenMacroMode;
	/** Vault path the "Check Confluence links and titles" report is written to. */
	dryRunReportPath: string;
	/** LaTeX rendering strategy (Appfire macros, or a readable code fallback). */
	latexRendering: LatexRendering;
	/** Maximum retries per API request on 429 / 5xx / network errors. */
	retryMax: number;
	/** Base retry backoff in milliseconds (doubled each attempt). */
	retryBaseMs: number;
	/** Per-request timeout in milliseconds (0 = no timeout). */
	requestTimeoutMs: number;
	/** Epoch ms of last publish completion. Status-bar uses for "X min ago". */
	lastPublishedAt?: number;
	lastPublishSucceeded?: number;
	lastPublishFailed?: number;
}

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

function dataCenterPageUrl(baseUrl: string, pageId: string): string {
	return `${baseUrl.trim().replace(/\/+$/, "")}/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}`;
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
			host: this.settings.confluenceBaseUrl.trim().replace(/\/+$/, ""),

			authentication: authentication as any,
			debugLogging: this.settings.debugLogging,
			latexRendering: this.settings.latexRendering ?? "appfire",
			retryMax: this.settings.retryMax ?? 3,
			retryBaseMs: this.settings.retryBaseMs ?? 1000,
			requestTimeoutMs: this.settings.requestTimeoutMs ?? 60000,
			middlewares: {
				onError(e) {
					console.error("Confluence API Error:", e);
					if (
						e &&
						typeof e === "object" &&
						"response" in e &&
						e.response &&
						typeof e.response === "object" &&
						"data" in e.response
					) {
						(e as { message?: string }).message =
							typeof e.response.data === "string" ? e.response.data : JSON.stringify(e.response.data);
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
		this.adaptor = new ObsidianAdaptor(vault, metadataCache, this.settings, this.app);
		this.adaptor.showMetadataPanel = this.settings.showMetadataPanel;
		this.adaptor.mapTaxonomyToLabels = this.settings.mapTaxonomyToLabels;
		this.adaptor.preserveFolderStructure = this.settings.preserveFolderStructure;
		this.adaptor.nav = this.navigationSettings();

		const quality = this.settings.mermaidQuality || "high";
		const mermaidRenderer = new MermaidElectronPNGRenderer(quality, this);
		const mermaidPlugin = new MermaidRendererPlugin(mermaidRenderer);

		console.log(
			`[Confluence] Initializing client for ${this.settings.confluenceBaseUrl} (user: ${this.settings.atlassianUserName || "(PAT)"})`,
		);

		const confluenceClient = this.getConfluenceClient();

		// Empty folder means vault root. Keep the loader's normalization isolated
		// from the persisted settings object.
		const loaderSettings = {
			...this.settings,
			folderToPublish: this.settings.folderToPublish || "/",
		};
		const settingsLoader = new DataCenterSettingsLoader(loaderSettings);
		this.publisher = this.settings.preserveFolderStructure
			? new StructuredPublisher(this.adaptor, settingsLoader, confluenceClient, [mermaidPlugin])
			: new Publisher(this.adaptor, settingsLoader, confluenceClient, [mermaidPlugin]);
	}

	/** The navigation/publishing subset of settings the adaptor needs. */
	private navigationSettings(): AdaptorNavigationSettings {
		const s = this.settings;
		return {
			titleSource: s.titleSource ?? DEFAULT_NAVIGATION_SETTINGS.titleSource,
			consumeFirstHeading: s.consumeFirstHeading ?? DEFAULT_NAVIGATION_SETTINGS.consumeFirstHeading,
			folderTitleSource: s.folderTitleSource ?? DEFAULT_NAVIGATION_SETTINGS.folderTitleSource,
			folderDisplayNames: s.folderDisplayNames ?? {},
			excludeGlobs: s.excludeGlobs ?? [],
			excludeListFile: s.excludeListFile ?? "",
			assetLinkMode: s.assetLinkMode ?? DEFAULT_NAVIGATION_SETTINGS.assetLinkMode,
			assetLinkBaseUrl: s.assetLinkBaseUrl ?? "",
			assetLinkExtensions: s.assetLinkExtensions ?? DEFAULT_NAVIGATION_SETTINGS.assetLinkExtensions,
			labelSources: s.labelSources ?? DEFAULT_NAVIGATION_SETTINGS.labelSources,
			labelAllowlistFile: s.labelAllowlistFile ?? "",
			labelPrefixes: s.labelPrefixes ?? {},
			labelMaxPerPage: s.labelMaxPerPage ?? 0,
			publishRootLanding: s.publishRootLanding ?? false,
			childrenMacro: s.childrenMacro ?? "off",
			dryRunReportPath: s.dryRunReportPath ?? DEFAULT_NAVIGATION_SETTINGS.dryRunReportPath,
		};
	}

	/**
	 * F7 safety check, run ONCE per publish before any write: may the configured
	 * parent page's body be replaced by the publish root's landing file?
	 *
	 * Permitted only when the page is empty, when the publishing account was its
	 * last editor, or when a previous run already claimed it with the
	 * `connie-managed-root` content property. Anything else is refused and the
	 * landing file publishes as an ordinary child page, as it does today.
	 */
	private async prepareRootLanding(): Promise<LinkDiagnostic | null> {
		this.adaptor.rootLandingAllowed = false;
		this.adaptor.rootPageTitle = undefined;
		if (!this.settings.publishRootLanding) return null;
		const client = this.getConfluenceClient();
		const id = this.settings.confluenceParentId;
		try {
			const parent: any = await client.content.getContentById({
				id,
				expand: ["body.storage", "version", "history"],
			});
			this.adaptor.rootPageTitle = parent?.title;
			let hasManagedProperty = false;
			try {
				await (client as any).sendRequest({
					url: `/api/content/${id}/property/${ROOT_MANAGED_PROPERTY}`,
					method: "GET",
				});
				hasManagedProperty = true;
			} catch {
				hasManagedProperty = false; // 404 → never claimed by this plugin
			}
			let myAccountId: string | undefined;
			try {
				myAccountId = (await client.users.getCurrentUser())?.accountId;
			} catch {
				myAccountId = undefined;
			}
			const decision = mayWriteRootLanding({
				bodyText: typeof parent?.body?.storage?.value === "string" ? parent.body.storage.value : "",
				lastUpdatedBy: parent?.version?.by?.accountId,
				createdBy: parent?.history?.createdBy?.accountId,
				myAccountId,
				hasManagedProperty,
			});
			if (decision.allowed) {
				this.adaptor.rootLandingAllowed = true;
				return null;
			}
			console.warn(`[Confluence] Root landing refused: ${decision.reason}`);
			return {
				kind: "root-landing-refused",
				severity: "warning",
				sourcePath: "(publish root)",
				target: decision.reason,
			};
		} catch (e) {
			console.warn("[Confluence] Could not evaluate the parent page for root-landing promotion:", e);
			return null;
		}
	}

	/**
	 * Merge one batch's successful uploads into the persisted publish record and
	 * save immediately (F9). Without this, a run interrupted at page 2,000 would
	 * re-publish everything next time.
	 */
	private async checkpointBatch(successes: UploadAdfFileResult[], hashByPath: Map<string, string>): Promise<void> {
		let changed = false;
		for (const r of successes) {
			const af = r.adfFile as { absoluteFilePath?: string; pageId?: string } | undefined;
			if (!af?.absoluteFilePath || !af.pageId) continue;
			this.settings.publishedPages[af.absoluteFilePath] = {
				pageId: String(af.pageId),
				hash: hashByPath.get(af.absoluteFilePath) ?? "",
				labels: this.adaptor.getLabelsFor(af.absoluteFilePath),
			};
			changed = true;
		}
		if (!changed) return;
		try {
			await this.saveData(this.settings);
		} catch (e) {
			console.warn("[Confluence] Could not checkpoint publish state after a batch:", e);
		}
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

			// Build a context-path-safe Data Center view URL from the resolved page ID
			// rather than rewriting a Cloud-specific `/wiki/spaces/` path.
			for (const result of adrFiles) {
				const uploadedFile = result.successfulUploadResult?.adfFile as
					| { pageId?: string; pageUrl?: string }
					| undefined;
				const nodeFile = result.node?.file as { pageId?: string; pageUrl?: string } | undefined;
				const pageId = uploadedFile?.pageId ?? nodeFile?.pageId;
				if (pageId) {
					const pageUrl = dataCenterPageUrl(this.settings.confluenceBaseUrl, String(pageId));
					if (uploadedFile) uploadedFile.pageUrl = pageUrl;
					if (nodeFile) nodeFile.pageUrl = pageUrl;
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
					console.error(
						`[Confluence] Page was last updated by a different account — check that your API credentials own these pages.`,
					);
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

	/**
	 * F6 — "Check Confluence links and titles".
	 *
	 * Runs the whole publish pipeline up to but not including the network:
	 * resolves the publish set, every page and folder title, and every link,
	 * then writes what it found into one markdown note in the vault. Nothing is
	 * uploaded, no frontmatter is written, and no Confluence credentials are
	 * needed — this is the pass an author works through before a bulk publish.
	 *
	 * Exposed as a plugin method (not just a command) so a harness can drive it.
	 */
	async runDryRun(): Promise<DryRunResult> {
		this.adaptor.nav = this.navigationSettings();
		// Root-landing promotion needs the network to decide, and the dry run is
		// deliberately offline, so report the intent rather than probing.
		this.adaptor.rootLandingAllowed = false;
		this.adaptor.rootPageTitle = undefined;

		await this.adaptor.computePublishContext(this.settings.deduplicateTitles);
		const paths = await this.adaptor.getAllPublishableFilePaths();

		// Rendering each page is what produces the link diagnostics, the derived
		// label set and the attachment list; a page that fails to render is a
		// finding in its own right rather than a reason to abandon the report.
		for (const path of paths) {
			try {
				await this.adaptor.loadMarkdownFile(path);
			} catch (e) {
				console.warn(`[Confluence] Dry run could not render ${path}:`, e);
			}
		}

		const folderTitles = this.adaptor.getFolderTitles();
		const exclusions = this.adaptor.getExclusionCounts();
		const derived = this.adaptor.getAllDerivedLabels();
		const dropped = this.adaptor.getDroppedLabelCounts();

		const input: DryRunInput = {
			folderToPublish: this.settings.folderToPublish || "(vault root)",
			generatedAt: new Date().toISOString(),
			counts: {
				publishablePages: paths.length,
				folderPages: folderTitles.length,
				excludedByGlob: exclusions.glob,
				excludedByFrontmatter: exclusions.frontmatter,
			},
			renames: this.adaptor.getTitleRenames().map((r) => ({
				filePath: r.filePath,
				originalTitle: r.originalTitle,
				renamedTitle: r.renamedTitle,
			})),
			landingConflicts: this.adaptor.getLandingConflicts(),
			folderTitles,
			diagnostics: this.adaptor.getDiagnostics(),
			labels: {
				distinct: derived.size,
				dropped: [...dropped.entries()]
					.map(([label, count]) => ({ label, count }))
					.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
				top: [...derived.entries()]
					.map(([label, count]) => ({ label, count }))
					.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
					.slice(0, 30),
			},
		};

		const report = formatDryRunReport(input);
		const reportPath = await this.writeDryRunReport(report);
		return { ...input, report, reportPath };
	}

	/**
	 * Write the dry-run report into the vault and open it. Returns the path it
	 * landed at, or "" when the write failed — a report we could not save is
	 * still returned in memory rather than lost.
	 */
	private async writeDryRunReport(report: string): Promise<string> {
		const path = normalizePath((this.settings.dryRunReportPath || "").trim() || "_confluence-check.md");
		try {
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) {
				await this.app.vault.modify(existing, report);
			} else {
				const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
				if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
					await this.app.vault.createFolder(folder);
				}
				await this.app.vault.create(path, report);
			}
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file);
			return path;
		} catch (e) {
			console.error("[Confluence] Could not write the dry-run report:", e);
			new Notice(`Confluence check: could not write ${path} — see the console.`);
			return "";
		}
	}

	async doPublish(publishFilter?: string, force = false): Promise<UploadResults> {
		const fullPublish = !publishFilter;
		console.log(`[Confluence] === Publish start (filter: ${publishFilter ?? "(all)"}${force ? ", force" : ""}) ===`);

		const paths = publishFilter ? [publishFilter] : await this.adaptor.getAllPublishableFilePaths();

		// Pre-flight: build the publish context against the whole vault (not just
		// this batch). This computes the effective Confluence title for every
		// publishable file — needed both to resolve [[wikilinks]] to the right
		// page title and to rename any titles that would collide (the latter
		// only when the deduplicateTitles setting is on).
		this.adaptor.nav = this.navigationSettings();
		const rootDiagnostic = await this.prepareRootLanding();
		await this.adaptor.computePublishContext(this.settings.deduplicateTitles);

		// F8: tell the publisher which labels IT applied last time, so a republish
		// only ever removes plugin-owned labels and restores anyone else's.
		if (this.publisher instanceof StructuredPublisher) {
			this.publisher.previousOwnedLabels = new Map(
				Object.entries(this.settings.publishedPages).map(([path, rec]) => [path, rec.labels ?? []]),
			);
		}

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

		console.log(
			`[Confluence] ${publishPaths.length} to publish, ${skipped} unchanged, in ${batches.length} batch(es) of ${batchSize}`,
		);

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
					await this.checkpointBatch(successes, hashByPath);
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
			// full publish, report/trash pages whose source note is now gone.
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
			const diagnostics = this.adaptor.getDiagnostics();
			if (rootDiagnostic) diagnostics.push(rootDiagnostic);
			aggregate.diagnostics = diagnostics;
			aggregate.diagnosticSummary = summariseDiagnostics(diagnostics);
			const orph = aggregate.orphansHandled;
			const orphMsg = orph && orph.ok ? `  ${orph.action === "trash" ? "🗑" : "📦"}${orph.ok}` : "";
			notice.setMessage(
				`Confluence publish done — ✓${aggregate.filesUploadResult.length} ✗${aggregate.failedFiles.length}${skipped ? ` ⏭${skipped}` : ""}${orphMsg}`,
			);
			setTimeout(() => notice.hide(), 3000);
			await this.persistPublishState(aggregate.filesUploadResult.length, aggregate.failedFiles.length);
		}

		console.log(
			`[Confluence] === Publish Complete: ${aggregate.filesUploadResult.length} ok, ${aggregate.failedFiles.length} failed, ${skipped} skipped ===`,
		);
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
		const next: Record<string, PublishRecord> = {
			...this.settings.publishedPages,
		};

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
			if (pageId) {
				next[path] = {
					pageId,
					hash: hashByPath.get(path) ?? "",
					// Remember exactly which labels the plugin applied, so the next
					// publish can remove only its own (F8).
					labels: this.adaptor.getLabelsFor(path),
				};
			}
		}

		let orphansHandled: OrphanSummary | null = null;

		if (fullPublish) {
			// Safety valve: if NOTHING is publishable but pages are tracked, this
			// is almost certainly a misconfiguration (e.g. a wrong "Folder to
			// publish") rather than a real mass-deletion. Skip orphan handling so
			// we never trash the entire space by accident.
			const trackedCount = Object.keys(this.settings.publishedPages).length;
			if (allPaths.length === 0 && trackedCount > 0) {
				console.warn(
					`[Confluence] 0 publishable notes found but ${trackedCount} page(s) tracked — skipping deletion to avoid mass-removal from a likely misconfiguration. Check "Folder to publish"; use "Reset publish cache" if this is intentional.`,
				);
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
			const destructive = this.settings.onDeletedNote === "trash";
			if (destructive && exceedsRemovalCap(orphanPageIds.length, cap)) {
				console.warn(
					`[Confluence] ${orphanPageIds.length} orphaned page(s) exceeds the safety limit (${cap}) — NOT removing them. Check "Folder to publish"; raise "Max pages to remove per publish" (or set 0) if this is intentional. Page IDs: ${orphanPageIds.join(", ")}`,
				);
				new Notice(
					`Confluence: ${orphanPageIds.length} pages would be removed — over the safety limit of ${cap}. Skipped; see console.`,
					10000,
				);
				this.settings.publishedPages = next; // keep everything tracked
				return {
					action: "report",
					ok: 0,
					failed: orphanPageIds.length,
					ids: orphanPageIds,
					removed: [],
				};
			}

			if (orphanPageIds.length > 0 && this.settings.onDeletedNote !== "off") {
				orphansHandled = await this.handleOrphans(orphanPageIds, this.settings.onDeletedNote);
			} else if (orphanPageIds.length > 0) {
				console.log(`[Confluence] ${orphanPageIds.length} orphaned page(s) detected; deletion is off.`);
			}

			// Prune state, but RETAIN any orphan whose page we did not actually
			// remove, so it is not silently forgotten: a failed/unsupported
			// trash is retried, and orphans seen in "report" mode persist until
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

	/** Trash or report Confluence pages whose source note is gone. */
	private async handleOrphans(pageIds: string[], mode: DeletedNoteAction): Promise<OrphanSummary> {
		if (mode === "report" || mode === "off") {
			console.log(`[Confluence] Orphaned page(s) (source note removed): ${pageIds.join(", ")}`);
			new Notice(`Confluence: ${pageIds.length} orphaned page(s) — see console (deletion set to report-only)`);
			return { action: "report", ok: 0, failed: 0, ids: pageIds, removed: [] };
		}
		const client = this.getConfluenceClient();
		let ok = 0;
		let failed = 0;
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
				await client.content.deleteContent({ id });
				ok++;
				removed.push(id);
				console.log(`[Confluence] Trashed orphaned page ${id}`);
			} catch (e) {
				failed++;

				const status = (e as any)?.response?.status;
				console.error(`[Confluence] Failed to trash orphaned page ${id} (status ${status ?? "?"}):`, e);
			}
		}
		return { action: "trash", ok, failed, ids: pageIds, removed };
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
		const summary = failed > 0 ? `✗ ${failed} failed (${succeeded} ok)` : `✓ ${succeeded} ok`;
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
			id: "check-links",
			name: "Check Confluence links and titles (dry run)",
			checkCallback: (checking: boolean) => {
				if (this.isSyncing) return false;
				if (checking) return true;
				this.isSyncing = true;
				const notice = new Notice("Checking Confluence links and titles…", 0);
				this.runDryRun()
					.then((result) => {
						const errors = result.diagnostics.filter((d) => d.severity === "error").length;
						const warnings = result.diagnostics.length - errors;
						notice.setMessage(
							`Confluence check done — ${result.counts.publishablePages} page(s), ` +
								`${result.renames.length} rename(s), ✗${errors} ⚠${warnings}`,
						);
						setTimeout(() => notice.hide(), 5000);
					})
					.catch((error) => {
						notice.hide();
						console.error("[Confluence] Link/title check failed:", error);
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
					const frontMatter = this.app.metadataCache.getCache(view.file.path)?.frontmatter;
					const file = view.file;
					const enabledForPublishing =
						(isPathInFolder(file.path, this.settings.folderToPublish) &&
							(!frontMatter || frontMatter["connie-publish"] !== false)) ||
						(frontMatter && frontMatter["connie-publish"] === true);
					return !enabledForPublishing;
				}

				this.app.fileManager.processFrontMatter(view.file, (frontmatter) => {
					if (view.file && isPathInFolder(view.file.path, this.settings.folderToPublish)) {
						delete frontmatter["connie-publish"];
					} else {
						frontmatter["connie-publish"] = true;
					}
				});
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
					const frontMatter = this.app.metadataCache.getCache(view.file.path)?.frontmatter;
					const file = view.file;
					const enabledForPublishing =
						(isPathInFolder(file.path, this.settings.folderToPublish) &&
							(!frontMatter || frontMatter["connie-publish"] !== false)) ||
						(frontMatter && frontMatter["connie-publish"] === true);
					return enabledForPublishing;
				}

				this.app.fileManager.processFrontMatter(view.file, (frontmatter) => {
					if (view.file && isPathInFolder(view.file.path, this.settings.folderToPublish)) {
						frontmatter["connie-publish"] = false;
					} else {
						delete frontmatter["connie-publish"];
					}
				});
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

				const frontMatter = this.app.metadataCache.getCache(view.file.path)?.frontmatter;

				const file = view.file;

				new ConfluencePerPageForm(this.app, {
					config: ConfluencePageConfig.conniePerPageConfig,
					initialValues: mapFrontmatterToConfluencePerPageUIValues(frontMatter),
					onSubmit: (values, close) => {
						const valuesToSet: Partial<ConfluencePageConfig.ConfluencePerPageAllValues> = {};
						for (const propertyKey in values) {
							if (Object.prototype.hasOwnProperty.call(values, propertyKey)) {
								const element = values[propertyKey as keyof ConfluencePerPageUIValues];
								if (element.isSet) {
									valuesToSet[propertyKey as keyof ConfluencePerPageUIValues] = element.value as never;
								}
							}
						}
						this.adaptor.updateMarkdownValues(file.path, valuesToSet);
						close();
					},
				}).open();
				return true;
			},
		});

		this.addSettingTab(new ConfluenceSettingTab(this.app, this));
	}

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
				...DEFAULT_NAVIGATION_SETTINGS,
				latexRendering: "appfire" as LatexRendering,
				retryMax: 3,
				retryBaseMs: 1000,
				requestTimeoutMs: 60000,
			},
			await this.loadData(),
		);
		if (!this.settings.publishedPages) this.settings.publishedPages = {};
		// Page archive is a Confluence Cloud API, not a documented Data Center
		// content operation. Safely migrate the old setting to report-only.
		if ((this.settings.onDeletedNote as string) === "archive") {
			console.warn('[Confluence] Migrating unsupported deleted-note action "archive" to "report".');
			this.settings.onDeletedNote = "report";
		}
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
			const data = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
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
