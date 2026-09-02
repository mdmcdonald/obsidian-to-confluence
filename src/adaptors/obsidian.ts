import { Vault, MetadataCache, App, TFile } from "obsidian";
import {
	ConfluenceUploadSettings,
	BinaryFile,
	FilesToUpload,
	LoaderAdaptor,
	MarkdownFile,
	ConfluencePageConfig,
	convertMDtoADF,
} from "@markdown-confluence/lib";
import { folderFile } from "@markdown-confluence/lib/dist/FolderFile.js";
import { lookup } from "mime-types";
import SparkMD5 from "spark-md5";
import { preprocessLatex } from "../LatexPreprocessor";
import {
	deriveTaxonomyLabels,
	mergeTags,
	slugifyLabel,
	filterByAllowlist,
	capLabels,
	parseLabelAllowlist,
	type TaxonomyLabelField,
} from "../taxonomyLabels";
import {
	deriveStructure,
	computeFolderTitlesDetailed,
	buildTree,
	assertUniqueTitles,
	splitPath,
	relativeTo,
	isPathInFolder,
	resolveRelativePath,
	titlesExcludingLandings,
	type ChildrenMacroMode,
	type DerivedStructure,
	type FolderTitleOrigin,
	type FolderTreeNode,
	type LandingConflict,
} from "../folderTree";
import {
	preprocessComments,
	preprocessWikilinks,
	preprocessMarkdownLinks,
	preprocessTableCells,
	linkExtension,
	AssetResolution,
	FolderResolution,
	WikilinkResolution,
	MetaField,
	MetaValue,
	encodeMetadataBlock,
} from "../obsidianPreprocess";
import { LinkDiagnostic, makeDiagnostic } from "../linkDiagnostics";
import { compileExcludes, excludeFileFormat, parseExcludeFile, type ExcludePredicate } from "../publishFilter";
import {
	consumeFirstHeading,
	findFirstHeadingLine,
	resolveTitle,
	type ConsumeFirstHeading,
	type TitleSource,
} from "../titleResolution";
import {
	attachmentNameFor,
	isAssetExtension,
	joinBaseUrl,
	DEFAULT_ASSET_EXTENSIONS,
	type AssetLinkMode,
	type AttachmentRequest,
} from "../attachments";

/** Frontmatter fields shown in the metadata panel, in display order. */
const META_SCALAR_FIELDS: [string, string][] = [
	["id", "ID"],
	["status", "Status"],
	["lifecycle_phase", "Lifecycle"],
	["domain", "Domain"],
	["authorship", "Authorship"],
];
const META_REL_FIELDS: [string, string][] = [
	["parent", "Parent"],
	["specializationOf", "Specialisation of"],
	["wasInfluencedBy", "Influenced by"],
	["requires", "Requires"],
	["references", "References"],
	// Wider relationship vocabulary (F12): SKOS/Dublin-Core style predicates the
	// corpus uses to express decomposition and conformance.
	["is-part-of", "Part of"],
	["has-part", "Has part"],
	["conforms-to", "Conforms to"],
	["replaces", "Replaces"],
	["broader", "Broader"],
	["related", "Related"],
	["capabilities", "Capabilities"],
	["external_interfaces", "External interfaces"],
];

/** Label shown for the computed inverse-of-`parent` row (F12). */
const DECOMPOSED_INTO_LABEL = "Decomposed into";

// Increment when conversion semantics change. Without this salt, notes whose
// Markdown is unchanged would keep an old publish hash and never receive storage
// format fixes until the user manually forced a full republish.
// v3: title resolution (F1), folder titles from landings (F2), folder/asset/
// absolute link resolution (F4), root landing (F7) and the label policy (F8)
// all change rendered output.
const PUBLISH_HASH_SCHEMA_VERSION = "dc-storage-v3";

function fmList(v: unknown): string[] {
	if (v == null) return [];
	const arr = Array.isArray(v) ? v : [v];
	return arr
		.map((x) =>
			String(x)
				.replace(/^["']|["']$/g, "")
				.trim(),
		)
		.filter((s) => s.length > 0);
}

/** Make a graph ID / taxonomy term human-readable (strip namespace, de-slug). */
function humaniseRef(v: string): string {
	return v
		.replace(/^["']|["']$/g, "")
		.replace(/^[a-z][a-z0-9]*:/i, "")
		.replace(/--/g, " ")
		.replace(/[_-]/g, " ")
		.trim();
}

/** Insert a block immediately after the YAML frontmatter (or at the top). */
function insertAfterFrontmatter(contents: string, block: string): string {
	if (contents.startsWith("---\n")) {
		const end = contents.indexOf("\n---", 4);
		if (end >= 0) {
			let lineEnd = contents.indexOf("\n", end + 4);
			if (lineEnd < 0) lineEnd = contents.length;
			return contents.slice(0, lineEnd + 1) + "\n" + block + "\n" + contents.slice(lineEnd + 1);
		}
	}
	return block + "\n\n" + contents;
}

export interface TitleRename {
	filePath: string;
	originalTitle: string;
	renamedTitle: string;
}

/** Plugin-owned settings the adaptor needs beyond the library's own. */
export interface AdaptorNavigationSettings {
	titleSource: TitleSource;
	consumeFirstHeading: ConsumeFirstHeading;
	folderTitleSource: "segment" | "landing";
	folderDisplayNames: Record<string, string>;
	excludeGlobs: string[];
	excludeListFile: string;
	assetLinkMode: AssetLinkMode;
	assetLinkBaseUrl: string;
	assetLinkExtensions: string[];
	labelSources: Record<TaxonomyLabelField, boolean>;
	labelAllowlistFile: string;
	labelPrefixes: Record<string, string>;
	labelMaxPerPage: number;
	publishRootLanding: boolean;
	childrenMacro: ChildrenMacroMode;
	dryRunReportPath: string;
}

export const DEFAULT_NAVIGATION_SETTINGS: AdaptorNavigationSettings = {
	titleSource: "filename",
	consumeFirstHeading: "never",
	folderTitleSource: "segment",
	folderDisplayNames: {},
	excludeGlobs: [],
	excludeListFile: "",
	assetLinkMode: "text",
	assetLinkBaseUrl: "",
	assetLinkExtensions: [...DEFAULT_ASSET_EXTENSIONS],
	labelSources: { tags: true, subject: true, type: true, domain: false, status: false, lifecycle_phase: false },
	labelAllowlistFile: "",
	labelPrefixes: {},
	labelMaxPerPage: 0,
	publishRootLanding: false,
	childrenMacro: "off",
	dryRunReportPath: "_confluence-check.md",
};

const SUPPORTED_IMAGE_EXTENSIONS = [
	"bmp",
	"cur",
	"dds",
	"gif",
	"heif",
	"icns",
	"ico",
	"jpeg",
	"jpg",
	"j2c",
	"jp2",
	"ktx",
	"png",
	"pnm",
	"psd",
	"svg",
	"tga",
	"tiff",
	"webp",
];

export default class ObsidianAdaptor implements LoaderAdaptor {
	vault: Vault;
	metadataCache: MetadataCache;
	settings: ConfluenceUploadSettings.ConfluenceSettings;
	app: App;
	/** If set, getMarkdownFilesToUpload restricts to paths in this set. */
	batchFilter: Set<string> | undefined;
	/** Populated by computePublishContext(); applied in loadMarkdownFile(). */
	private dedupMap: Map<string, TitleRename> = new Map();
	/**
	 * Effective Confluence page title (post-dedup) for every publishable file,
	 * keyed by vault path. Populated by computePublishContext() and consulted by
	 * resolveWikilink() so [[links]] target the exact title each page is
	 * published under.
	 */
	private publishTitleByPath: Map<string, string> = new Map();
	/** Raw (pre-dedup) resolved title per path — the folder-title preference. */
	private rawTitleByPath: Map<string, string> = new Map();
	/**
	 * lower-cased file stem → every PUBLISHABLE path with that stem. Built once
	 * per publish so ambiguous-stem resolution is O(1) per link rather than a
	 * scan of the whole publish set (which, at corpus scale, is a scan per link).
	 */
	private publishableByStem: Map<string, string[]> = new Map();
	/** frontmatter `id` → final Confluence title, for resolving ontology refs. */
	private idToTitle: Map<string, string> = new Map();
	/** Set by the plugin: emit a Page Properties panel from frontmatter. */
	showMetadataPanel = false;
	/** Set by the plugin: project taxonomy frontmatter onto Confluence labels. */
	mapTaxonomyToLabels = false;
	/** Set by the plugin: preserve the vault folder hierarchy in Confluence. */
	preserveFolderStructure = true;
	/** Navigation/publishing settings owned by the plugin (not the library). */
	nav: AdaptorNavigationSettings = { ...DEFAULT_NAVIGATION_SETTINGS };
	/** Global folder structure (commonPath, folders, landing files), per publish. */
	private structure: DerivedStructure | undefined;
	/** folderRelPath → unique Confluence title. */
	private folderTitleByPath: Map<string, string> = new Map();
	/** folderRelPath → where its title came from (dry-run reporting). */
	private folderTitleOrigin: Map<string, FolderTitleOrigin> = new Map();
	/** landing file vault path → its folder's title (for skip-unchanged hashing). */
	private landingToFolderTitle: Map<string, string> = new Map();
	/** Compiled exclusion predicate, rebuilt each computePublishContext(). */
	private excludes: ExcludePredicate = () => false;
	/** Vocabulary allowlist for labels; empty means "no vocabulary configured". */
	private labelAllowlist: Set<string> = new Set();
	/** Diagnostics collected per source page during loadMarkdownFile(). */
	private diagnosticsByPath: Map<string, LinkDiagnostic[]> = new Map();
	/** Attachments each page must upload: sourcePath → [{vaultPath, filename}]. */
	private attachmentsByPath: Map<string, AttachmentRequest[]> = new Map();
	/** Labels the plugin derived for each page in this run (label ownership). */
	private labelsByPath: Map<string, string[]> = new Map();
	/** Labels the vocabulary allowlist rejected, with frequency (dry run). */
	private droppedLabelCounts: Map<string, number> = new Map();
	/** Counts of what the exclusion rules removed, for the dry-run summary. */
	private exclusionCounts = { glob: 0, frontmatter: 0 };
	/** page title of a file → the pages whose `parent` points at it (F12). */
	private childrenByParentPath: Map<string, string[]> = new Map();
	/** The configured parent page's title, when the root landing is promoted. */
	rootPageTitle: string | undefined;
	/** True when the root landing may be written onto the parent page (F7). */
	rootLandingAllowed = false;

	constructor(
		vault: Vault,
		metadataCache: MetadataCache,
		settings: ConfluenceUploadSettings.ConfluenceSettings,
		app: App,
	) {
		this.vault = vault;
		this.metadataCache = metadataCache;
		this.settings = settings;
		this.app = app;
	}

	// -- publish set ---------------------------------------------------------

	/** The publish-folder-relative path used for exclusion matching. */
	private relativeToPublishFolder(vaultPath: string): string {
		return relativeTo(this.settings.folderToPublish ?? "", vaultPath);
	}

	private isPublishable(file: TFile): boolean {
		if (file.path.endsWith(".excalidraw")) return false;
		// The dry-run report is generated INTO the vault; never publish it back.
		if (this.nav.dryRunReportPath && file.path === this.nav.dryRunReportPath.trim()) return false;
		const fileFM = this.metadataCache.getCache(file.path);
		if (!fileFM) return false;
		const frontMatter = fileFM.frontmatter;
		const optedIn = !!frontMatter && frontMatter["connie-publish"] === true;
		const optedOut = !!frontMatter && frontMatter["connie-publish"] === false;

		if (optedOut) return false;
		const inScope = isPathInFolder(file.path, this.settings.folderToPublish) || optedIn;
		if (!inScope) return false;

		// An explicit `connie-publish: true` beats a matching exclusion glob —
		// the note's author has overruled the corpus-wide rule.
		if (!optedIn && this.excludes(this.relativeToPublishFolder(file.path))) return false;
		return true;
	}

	/** True when a vault file is deliberately kept out of the publish set. */
	private isExcluded(vaultPath: string): boolean {
		const fm = this.metadataCache.getCache(vaultPath)?.frontmatter;
		if (fm && fm["connie-publish"] === false) return true;
		if (fm && fm["connie-publish"] === true) return false;
		return this.excludes(this.relativeToPublishFolder(vaultPath));
	}

	/** Why a file is NOT publishable — used only by the dry-run counters. */
	private exclusionReason(file: TFile): "glob" | "frontmatter" | null {
		const frontMatter = this.metadataCache.getCache(file.path)?.frontmatter;
		if (frontMatter && frontMatter["connie-publish"] === false) return "frontmatter";
		if (frontMatter && frontMatter["connie-publish"] === true) return null;
		if (!isPathInFolder(file.path, this.settings.folderToPublish)) return null;
		if (this.excludes(this.relativeToPublishFolder(file.path))) return "glob";
		return null;
	}

	async getAllPublishableFilePaths(): Promise<string[]> {
		return this.vault
			.getMarkdownFiles()
			.filter((f) => this.isPublishable(f))
			.map((f) => f.path);
	}

	/** Read the configured exclusion-list file (if any) and compile the globs. */
	private async compileExclusionRules(): Promise<void> {
		const patterns = [...(this.nav.excludeGlobs ?? [])];
		const listPath = (this.nav.excludeListFile ?? "").trim();
		if (listPath) {
			const file = this.app.vault.getAbstractFileByPath(listPath);
			if (file instanceof TFile) {
				try {
					const content = await this.vault.cachedRead(file);
					patterns.push(...parseExcludeFile(content, excludeFileFormat(listPath)));
				} catch (e) {
					console.warn(`[Confluence] Could not read exclusion list ${listPath}:`, e);
				}
			} else {
				console.warn(`[Confluence] Exclusion list file not found: ${listPath}`);
			}
		}
		this.excludes = compileExcludes(patterns);
	}

	/** Read the configured label vocabulary file (if any). */
	private async loadLabelAllowlist(): Promise<void> {
		this.labelAllowlist = new Set();
		const path = (this.nav.labelAllowlistFile ?? "").trim();
		if (!path) return;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			console.warn(`[Confluence] Label vocabulary file not found: ${path}`);
			return;
		}
		try {
			this.labelAllowlist = parseLabelAllowlist(await this.vault.cachedRead(file));
		} catch (e) {
			console.warn(`[Confluence] Could not read label vocabulary ${path}:`, e);
		}
	}

	// -- publish context -----------------------------------------------------

	/**
	 * Walk every publishable file and compute its effective Confluence page
	 * title (see titleResolution.ts). Three things are produced and stored on
	 * the adaptor:
	 *
	 *  1. `publishTitleByPath` — the final title each publishable file is
	 *     published under (always built; needed for wikilink resolution).
	 *  2. `dedupMap` — for any title shared by 2+ files, a unique renamed title
	 *     (`Title (<6-char md5 of path>)`). Only populated when the
	 *     `deduplicateTitles` setting is on; consulted by loadMarkdownFile.
	 *  3. The folder structure and folder titles, computed over the WHOLE set so
	 *     they are stable regardless of which subset a batch publishes.
	 *
	 * The path-based hash is deterministic across re-publishes, so a file always
	 * gets the same suffix and its inbound links stay stable.
	 *
	 * Must be called before a publish run (doPublish does this) so loadMarkdownFile
	 * and resolveWikilink see a fully-populated context.
	 *
	 * @param deduplicateTitles when true, colliding titles are renamed; the
	 *   title map is built regardless (wikilink resolution needs it either way).
	 *
	 * Cost note: resolving any [[link]] requires knowing the target's title, so
	 * unless titles come from filenames alone this reads every publishable file
	 * (cachedRead). Even for a single-file publish the whole publishable set is
	 * walked, because a published page may link to any other.
	 */
	async computePublishContext(deduplicateTitles: boolean): Promise<void> {
		this.dedupMap.clear();
		this.publishTitleByPath.clear();
		this.publishableByStem.clear();
		this.rawTitleByPath.clear();
		this.idToTitle.clear();
		this.diagnosticsByPath.clear();
		this.attachmentsByPath.clear();
		this.labelsByPath.clear();
		this.droppedLabelCounts.clear();
		this.childrenByParentPath.clear();
		this.exclusionCounts = { glob: 0, frontmatter: 0 };

		await this.compileExclusionRules();
		await this.loadLabelAllowlist();

		const paths = await this.getAllPublishableFilePaths();

		// Count what the exclusion rules removed (dry-run summary only).
		for (const file of this.vault.getMarkdownFiles()) {
			const reason = this.exclusionReason(file);
			if (reason === "glob") this.exclusionCounts.glob++;
			else if (reason === "frontmatter") this.exclusionCounts.frontmatter++;
		}

		// Title resolution needs file contents unless every title comes from a
		// filename; skip the reads when it does.
		const needsContent = this.nav.titleSource !== "filename" || this.settings.firstHeadingPageTitle;

		const titles: { path: string; title: string }[] = [];
		for (const path of paths) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;
			const frontmatter = this.metadataCache.getCache(path)?.frontmatter as Record<string, unknown> | undefined;
			let content = "";
			if (needsContent) {
				try {
					content = await this.vault.cachedRead(file);
				} catch {
					content = "";
				}
			}
			const resolved = resolveTitle(file.basename, frontmatter, content, {
				titleSource: this.effectiveTitleSource(),
				consumeFirstHeading: this.nav.consumeFirstHeading,
			});
			if (resolved.truncated) {
				this.addDiagnostic(makeDiagnostic("title-truncated", path, resolved.title));
			}
			titles.push({ path, title: resolved.title });
			this.rawTitleByPath.set(path, resolved.title);
		}

		const byTitle = new Map<string, { path: string; title: string }[]>();
		for (const t of titles) {
			const arr = byTitle.get(t.title);
			if (arr) arr.push(t);
			else byTitle.set(t.title, [t]);
		}

		if (deduplicateTitles) {
			for (const [originalTitle, group] of byTitle) {
				if (group.length <= 1) continue;
				for (const { path } of group) {
					const hash = SparkMD5.hash(path).substring(0, 6);
					this.dedupMap.set(path, {
						filePath: path,
						originalTitle,
						renamedTitle: `${originalTitle} (${hash})`,
					});
				}
			}
		}

		// Final published title per file: renamed if deduped, else effective.
		// Also map each file's frontmatter `id` (the graph/ontology ID) to its
		// title so metadata relationships (wasInfluencedBy etc.) can link.
		for (const { path, title } of titles) {
			const rename = this.dedupMap.get(path);
			const finalTitle = rename ? rename.renamedTitle : title;
			this.publishTitleByPath.set(path, finalTitle);
			const id = this.metadataCache.getCache(path)?.frontmatter?.id;
			if (id != null) {
				const key = String(id)
					.replace(/^["']|["']$/g, "")
					.trim();
				if (key) this.idToTitle.set(key, finalTitle);
			}
		}

		if (this.dedupMap.size > 0) {
			console.log(`[Confluence] Deduplicating ${this.dedupMap.size} colliding page title(s)`);
		}

		// Folder structure (computed over the WHOLE set so it is stable across
		// batches). Folder titles are deduped against the file titles too.
		this.structure = undefined;
		this.folderTitleByPath.clear();
		this.folderTitleOrigin.clear();
		this.landingToFolderTitle.clear();
		if (this.preserveFolderStructure && paths.length > 0) {
			const structure = deriveStructure(paths);
			// A landing file becomes its folder's page, so its own title is not a
			// competing file title — otherwise every landing-titled folder would
			// collide with itself and be qualified or hashed.
			const promotedRoot =
				this.nav.publishRootLanding && this.rootLandingAllowed ? structure.rootLandingFile : undefined;
			const takenByFiles = titlesExcludingLandings(
				this.publishTitleByPath,
				structure,
				promotedRoot ? [promotedRoot] : [],
			);
			const { titles: folderTitles, origins } = computeFolderTitlesDetailed(structure.folders, takenByFiles, {
				preferredTitle: (rel) => this.preferredFolderTitle(rel, structure),
			});
			this.folderTitleByPath = folderTitles;
			this.folderTitleOrigin = origins;
			this.structure = structure;

			for (const conflict of structure.landingConflicts) {
				this.addDiagnostic(
					makeDiagnostic(
						"landing-conflict",
						conflict.candidates[0] ?? "",
						conflict.folderRelPath || "(publish root)",
						conflict.candidates.join(", "),
					),
				);
			}

			// A folder's README/index/eponymous file IS the folder page, so its
			// effective title becomes the folder title — point inbound wikilinks
			// and ontology refs at the folder, not the consumed file's old title.
			for (const [folderRel, landingPath] of structure.indexFileByFolder) {
				const folderTitle = this.folderTitleByPath.get(folderRel);
				if (!folderTitle) continue;
				this.publishTitleByPath.set(landingPath, folderTitle);
				this.landingToFolderTitle.set(landingPath, folderTitle);
				const id = this.metadataCache.getCache(landingPath)?.frontmatter?.id;
				if (id != null) {
					const key = String(id)
						.replace(/^["']|["']$/g, "")
						.trim();
					if (key) this.idToTitle.set(key, folderTitle);
				}
			}

			// The root landing (F7) publishes as the configured parent page, so
			// inbound links to it must use the parent page's title.
			const rootLanding = this.rootLandingPath();
			if (rootLanding && this.rootPageTitle) {
				this.publishTitleByPath.set(rootLanding, this.rootPageTitle);
				this.landingToFolderTitle.set(rootLanding, this.rootPageTitle);
			}

			console.log(
				`[Confluence] Preserving folder structure: ${structure.folders.length} folder(s), root "${structure.commonPath || "(vault)"}"`,
			);
		}

		this.buildStemIndex();

		// Inverse of `parent` (F12): which published pages decompose from each page.
		this.buildDecompositionIndex(paths);
	}

	/** The library setting must not fight the plugin's own title resolution. */
	private effectiveTitleSource(): TitleSource {
		if (this.nav.titleSource === "filename" && this.settings.firstHeadingPageTitle) {
			// Legacy configuration: the library's own toggle maps to first-heading.
			return "first-heading";
		}
		return this.nav.titleSource;
	}

	/** The publish root's landing file, when root promotion is enabled and safe. */
	private rootLandingPath(): string | undefined {
		if (!this.nav.publishRootLanding || !this.rootLandingAllowed) return undefined;
		return this.structure?.rootLandingFile;
	}

	/**
	 * The title a folder page would like: its landing file's resolved title,
	 * else a display-name override (by relative path, then by basename), else
	 * the bare folder-name segment.
	 */
	private preferredFolderTitle(
		folderRelPath: string,
		structure: DerivedStructure,
	): { title: string; origin: FolderTitleOrigin } | undefined {
		if (this.nav.folderTitleSource !== "landing") return undefined;
		const landing = structure.indexFileByFolder.get(folderRelPath);
		if (landing) {
			const title = this.rawTitleByPath.get(landing);
			if (title) return { title, origin: "landing" };
		}
		const map = this.nav.folderDisplayNames ?? {};
		const byPath = map[folderRelPath];
		if (typeof byPath === "string" && byPath.trim()) return { title: byPath.trim(), origin: "display-map" };
		const base = splitPath(folderRelPath).pop() ?? "";
		const byBase = map[base];
		if (typeof byBase === "string" && byBase.trim()) return { title: byBase.trim(), origin: "display-map" };
		return undefined;
	}

	/** Build the inverse of the `parent` relationship over the publish set. */
	private buildDecompositionIndex(paths: string[]): void {
		for (const path of paths) {
			const fm = this.metadataCache.getCache(path)?.frontmatter;
			if (!fm) continue;
			for (const raw of fmList(fm["parent"])) {
				const parentPath = this.resolveMetaRefPath(raw, path);
				if (!parentPath || parentPath === path) continue;
				const arr = this.childrenByParentPath.get(parentPath) ?? [];
				arr.push(path);
				this.childrenByParentPath.set(parentPath, arr);
			}
		}
	}

	getTitleRenames(): TitleRename[] {
		return Array.from(this.dedupMap.values());
	}

	getLandingConflicts(): LandingConflict[] {
		return this.structure?.landingConflicts ?? [];
	}

	getFolderTitles(): { relPath: string; title: string; origin: FolderTitleOrigin }[] {
		return [...this.folderTitleByPath.entries()]
			.map(([relPath, title]) => ({
				relPath,
				title,
				origin: this.folderTitleOrigin.get(relPath) ?? ("segment" as FolderTitleOrigin),
			}))
			.sort((a, b) => a.relPath.localeCompare(b.relPath));
	}

	getExclusionCounts(): { glob: number; frontmatter: number } {
		return { ...this.exclusionCounts };
	}

	getDiagnostics(): LinkDiagnostic[] {
		const out: LinkDiagnostic[] = [];
		for (const list of this.diagnosticsByPath.values()) out.push(...list);
		return out;
	}

	getDiagnosticsFor(sourcePath: string): LinkDiagnostic[] {
		return this.diagnosticsByPath.get(sourcePath) ?? [];
	}

	/** Attachments the given page must upload before its content is published. */
	getAttachmentsFor(sourcePath: string): AttachmentRequest[] {
		return this.attachmentsByPath.get(sourcePath) ?? [];
	}

	/** The labels this run derived for a page — the plugin's owned label set. */
	getLabelsFor(sourcePath: string): string[] {
		return this.labelsByPath.get(sourcePath) ?? [];
	}

	getDroppedLabelCounts(): Map<string, number> {
		return new Map(this.droppedLabelCounts);
	}

	getAllDerivedLabels(): Map<string, number> {
		const counts = new Map<string, number>();
		for (const labels of this.labelsByPath.values()) {
			for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
		}
		return counts;
	}

	/** Record a diagnostic raised outside the adaptor (e.g. the publisher's title pre-flight). */
	recordDiagnostic(diagnostic: LinkDiagnostic): void {
		this.addDiagnostic(diagnostic);
	}

	private addDiagnostic(diagnostic: LinkDiagnostic): void {
		const arr = this.diagnosticsByPath.get(diagnostic.sourcePath) ?? [];
		arr.push(diagnostic);
		this.diagnosticsByPath.set(diagnostic.sourcePath, arr);
	}

	/**
	 * Build the library's page tree for a batch of files, preserving the global
	 * folder hierarchy (see folderTree.ts). Used by StructuredPublisher in place
	 * of the library's batch-collapsing createFolderStructure.
	 */
	async buildLocalAdfTree(
		markdownFiles: MarkdownFile[],
		settings: ConfluenceUploadSettings.ConfluenceSettings,
	): Promise<FolderTreeNode> {
		const structure = this.structure;
		if (!structure) {
			// Should not happen (computePublishContext runs first), but never crash.
			throw new Error("Folder structure not computed before publish");
		}

		// A folder's landing file (README/index) IS its page content. If a batch
		// touches a folder but its landing file was filtered out (e.g. unchanged,
		// skip-unchanged), load it on demand so the folder page keeps its content
		// instead of being overwritten with a blank placeholder.
		const have = new Set(markdownFiles.map((f) => f.absoluteFilePath));
		const touched = new Set<string>();
		for (const f of markdownFiles) {
			const segs = splitPath(relativeTo(structure.commonPath, f.absoluteFilePath)).slice(0, -1);
			for (let i = 1; i <= segs.length; i++) touched.add(segs.slice(0, i).join("/"));
		}
		const extra: MarkdownFile[] = [];
		for (const folderRel of touched) {
			const landing = structure.indexFileByFolder.get(folderRel);
			if (landing && !have.has(landing)) {
				try {
					extra.push(await this.loadMarkdownFile(landing));
				} catch (e) {
					console.warn(`[Confluence] Could not load folder landing file ${landing}:`, e);
				}
			}
		}
		// The root landing carries the configured parent page's body; it must be
		// present in every batch that publishes the root carrier.
		const rootLanding = this.rootLandingPath();
		if (rootLanding && !have.has(rootLanding)) {
			try {
				extra.push(await this.loadMarkdownFile(rootLanding));
			} catch (e) {
				console.warn(`[Confluence] Could not load root landing file ${rootLanding}:`, e);
			}
		}
		const allFiles = extra.length ? [...markdownFiles, ...extra] : markdownFiles;

		const tree = buildTree(allFiles, {
			commonPath: structure.commonPath,
			folderTitle: this.folderTitleByPath,
			indexFileByFolder: structure.indexFileByFolder,
			folderFileAdf: folderFile,
			convertFile: (mf) => convertMDtoADF(mf, settings),
			childrenMacro: this.nav.childrenMacro,
			...(rootLanding ? { rootLandingFile: rootLanding, rootPageTitle: this.rootPageTitle } : {}),
		});
		assertUniqueTitles(tree); // the safety check the library's tree builder runs
		return tree;
	}

	// -- link resolution -----------------------------------------------------

	/**
	 * Resolve a wikilink target (page name only — no #heading or |alias) to the
	 * Confluence page it should link to. Used by preprocessWikilinks.
	 *
	 * When Obsidian's own resolver lands on a file that is NOT published, the
	 * publishable candidates sharing the target's stem are considered too (F4a):
	 * in a corpus with many same-named notes, a link written against a stem is
	 * far more likely to mean the one published page than the excluded draft.
	 */
	resolveWikilink(rawTarget: string, sourcePath: string): WikilinkResolution {
		const dest = this.metadataCache.getFirstLinkpathDest(rawTarget, sourcePath);
		const destTitle = dest ? this.publishTitleByPath.get(dest.path) : undefined;
		if (dest && destTitle !== undefined && rawTarget.includes("/")) {
			// An explicit path resolved to a published page — no ambiguity to resolve.
			return { inVault: true, publishable: true, title: destTitle };
		}

		const stem = (rawTarget.split("/").pop() ?? rawTarget).replace(/\.md$/i, "").trim();
		const candidates = this.publishableCandidatesForStem(stem);

		if (destTitle !== undefined && candidates.length <= 1) {
			return { inVault: true, publishable: true, title: destTitle };
		}
		if (candidates.length === 1) {
			const only = candidates[0];
			if (!dest || dest.path !== only) {
				this.addDiagnostic(makeDiagnostic("ambiguous-stem-resolved", sourcePath, rawTarget, only));
			}
			return { inVault: true, publishable: true, title: this.publishTitleByPath.get(only) as string };
		}
		if (candidates.length > 1) {
			const chosen = dest && this.publishTitleByPath.has(dest.path) ? dest.path : candidates[0];
			this.addDiagnostic(makeDiagnostic("ambiguous-stem-unresolved", sourcePath, rawTarget, candidates.join(", ")));
			return { inVault: true, publishable: true, title: this.publishTitleByPath.get(chosen) as string };
		}

		if (!dest) return { inVault: false, publishable: false };
		// In the vault but not published: say so precisely, so the author can tell
		// a deliberate exclusion from a note that was simply never in scope.
		return { inVault: true, publishable: false, title: dest.basename, excluded: this.isExcluded(dest.path) };
	}

	/** Index every publishable path by its lower-cased file stem. */
	private buildStemIndex(): void {
		this.publishableByStem.clear();
		for (const path of this.publishTitleByPath.keys()) {
			const stem = (path.split("/").pop() ?? "").replace(/\.md$/i, "").toLowerCase();
			if (!stem) continue;
			const arr = this.publishableByStem.get(stem) ?? [];
			arr.push(path);
			this.publishableByStem.set(stem, arr);
		}
		for (const arr of this.publishableByStem.values()) arr.sort();
	}

	/** Publishable files whose basename (sans extension) equals `stem`. */
	private publishableCandidatesForStem(stem: string): string[] {
		if (!stem) return [];
		return this.publishableByStem.get(stem.toLowerCase()) ?? [];
	}

	/** Resolve a relative markdown link that names a folder (F4b). */
	private resolveFolderLink(relativeTarget: string, sourcePath: string): FolderResolution {
		const structure = this.structure;
		if (!structure) return { kind: "not-a-folder" };
		const cleaned = relativeTarget.replace(/\/+$/, "");
		const vaultPath = resolveRelativePath(sourcePath, cleaned);
		if (!vaultPath) return { kind: "not-a-folder" };
		if (!isPathInFolder(vaultPath, this.settings.folderToPublish)) return { kind: "not-a-folder" };

		const abstract = this.app.vault.getAbstractFileByPath(vaultPath);
		// A TFile here means the target is a file with no extension, not a folder.
		if (abstract instanceof TFile) return { kind: "not-a-folder" };
		if (!abstract) return { kind: "not-a-folder" };

		const folderRel = relativeTo(structure.commonPath, vaultPath);
		const title = this.folderTitleByPath.get(folderRel);
		if (title) return { kind: "page", title };
		// A directory that exists in the vault but has no page: every file under it
		// was excluded, or folder structure is off.
		return { kind: "not-published" };
	}

	/** Resolve a relative markdown link that names a non-markdown asset (F4c). */
	private resolveAssetLink(relativeTarget: string, sourcePath: string): AssetResolution {
		const ext = linkExtension(relativeTarget);
		if (!isAssetExtension(ext, this.nav.assetLinkExtensions ?? DEFAULT_ASSET_EXTENSIONS)) {
			return { kind: "not-an-asset" };
		}
		const vaultPath = resolveRelativePath(sourcePath, relativeTarget);
		const file = this.app.vault.getAbstractFileByPath(vaultPath);
		if (!(file instanceof TFile)) return { kind: "text" };

		switch (this.nav.assetLinkMode) {
			case "base-url": {
				const base = (this.nav.assetLinkBaseUrl ?? "").trim();
				if (!base) return { kind: "text" };
				return { kind: "url", href: joinBaseUrl(base, file.path) };
			}
			case "attach": {
				const claimed = this.attachmentClaimsFor(sourcePath);
				const filename = attachmentNameFor(file.path, claimed);
				const requests = this.attachmentsByPath.get(sourcePath) ?? [];
				if (!requests.some((r) => r.vaultPath === file.path)) {
					requests.push({ vaultPath: file.path, filename });
					this.attachmentsByPath.set(sourcePath, requests);
				}
				return { kind: "attachment", filename };
			}
			default:
				return { kind: "text" };
		}
	}

	/** Per-page attachment name reservations, rebuilt each time a page renders. */
	private attachmentClaims: Map<string, Map<string, string>> = new Map();

	private attachmentClaimsFor(sourcePath: string): Map<string, string> {
		let claims = this.attachmentClaims.get(sourcePath);
		if (!claims) {
			claims = new Map();
			this.attachmentClaims.set(sourcePath, claims);
		}
		return claims;
	}

	/** Resolve a site-absolute markdown link ("/domain/radar/index.md") (F4d). */
	private resolveAbsoluteLink(target: string): WikilinkResolution {
		const stripped = target.replace(/^\/+/, "");
		if (!stripped) return { inVault: false, publishable: false };
		const folder = splitPath(this.settings.folderToPublish ?? "").join("/");
		const withoutMd = stripped.replace(/\.md$/i, "");
		const candidates = [
			folder ? `${folder}/${withoutMd}.md` : `${withoutMd}.md`,
			folder ? `${folder}/${stripped}` : stripped,
			`${withoutMd}.md`,
			stripped,
		];
		for (const candidate of candidates) {
			const title = this.publishTitleByPath.get(candidate);
			if (title !== undefined) return { inVault: true, publishable: true, title };
		}
		for (const candidate of candidates) {
			if (this.app.vault.getAbstractFileByPath(candidate) instanceof TFile) {
				return { inVault: true, publishable: false, excluded: this.isExcluded(candidate) };
			}
		}
		return { inVault: false, publishable: false };
	}

	/**
	 * Resolve a single metadata relationship value to a link where possible.
	 * Handles [[wikilinks]] (by filename), bare names (by filename), and the
	 * corpus's namespaced graph IDs (e.g. "eoir:EOIR-Overview") via the id map.
	 * Falls back to a humanised plain-text value.
	 */
	private resolveMetaRef(value: string, sourcePath: string): MetaValue {
		let target = value.replace(/^["']|["']$/g, "").trim();
		const wl = target.match(/^\[\[(.+?)\]\]$/);
		if (wl) target = wl[1].trim();
		let display: string | undefined;
		if (target.includes("|")) {
			const i = target.indexOf("|");
			display = target.slice(i + 1).trim();
			target = target.slice(0, i).trim();
		}
		const hashIdx = target.indexOf("#");
		const bare = (hashIdx >= 0 ? target.slice(0, hashIdx) : target).trim();
		const frag = hashIdx >= 0 ? target.slice(hashIdx + 1).trim() : "";
		// Heading anchors carry through; block refs (^id) have no Confluence
		// equivalent and are dropped (link to the page only).
		const anchor = frag && !frag.startsWith("^") ? frag : undefined;

		// 1) by filename (wikilink-style)
		const res = this.resolveWikilink(bare, sourcePath);
		if (res.publishable && res.title !== undefined) {
			return {
				text: display ?? bare,
				link: { title: res.title, anchor, display: display ?? bare },
			};
		}
		// 2) by ontology graph id
		const byId = this.idToTitle.get(bare);
		if (byId !== undefined) {
			return {
				text: display ?? byId,
				link: { title: byId, anchor, display: display ?? byId },
			};
		}
		// 3) plain, humanised
		return { text: display ?? humaniseRef(value) };
	}

	/** The vault path a relationship value points at, if it names a published page. */
	private resolveMetaRefPath(value: string, sourcePath: string): string | undefined {
		let target = value.replace(/^["']|["']$/g, "").trim();
		const wl = target.match(/^\[\[(.+?)\]\]$/);
		if (wl) target = wl[1].trim();
		if (target.includes("|")) target = target.slice(0, target.indexOf("|")).trim();
		const hashIdx = target.indexOf("#");
		const bare = (hashIdx >= 0 ? target.slice(0, hashIdx) : target).trim();
		if (!bare) return undefined;
		const dest = this.metadataCache.getFirstLinkpathDest(bare, sourcePath);
		if (dest && this.publishTitleByPath.has(dest.path)) return dest.path;
		const candidates = this.publishableCandidatesForStem(bare.split("/").pop() ?? bare);
		return candidates.length === 1 ? candidates[0] : undefined;
	}

	/**
	 * Build the metadata panel sentinel from a file's frontmatter, or null if
	 * there is nothing worth showing. Relationship/ontology fields are resolved
	 * to page links; `subject` taxonomy terms and scalars are humanised text.
	 */
	private buildMetadataBlock(frontmatter: Record<string, unknown> | undefined, sourcePath: string): string | null {
		const fields: MetaField[] = [];
		const push = (label: string, values: MetaValue[]) => {
			if (values.length) fields.push({ label, values });
		};

		if (frontmatter) {
			const typeVal = frontmatter.type ?? frontmatter.document_type;
			if (typeVal != null) push("Type", [{ text: humaniseRef(String(typeVal)) }]);
			for (const [key, label] of META_SCALAR_FIELDS) {
				const vals = fmList(frontmatter[key]).map((v) => ({
					text: humaniseRef(v),
				}));
				push(label, vals);
			}
			// subject = taxonomy terms (not pages) — humanise.
			push(
				"Subject",
				fmList(frontmatter.subject).map((v) => ({ text: humaniseRef(v) })),
			);
			// relationships → links where resolvable.
			for (const [key, label] of META_REL_FIELDS) {
				push(
					label,
					fmList(frontmatter[key]).map((v) => this.resolveMetaRef(v, sourcePath)),
				);
			}
		}

		// Computed inverse of `parent` (F12): the pages that decompose from this one.
		const children = this.childrenByParentPath.get(sourcePath) ?? [];
		if (children.length > 0) {
			const values: MetaValue[] = children
				.map((childPath) => this.publishTitleByPath.get(childPath))
				.filter((t): t is string => typeof t === "string")
				.sort((a, b) => a.localeCompare(b))
				.map((title) => ({ text: title, link: { title, display: title } }));
			push(DECOMPOSED_INTO_LABEL, values);
		}

		return fields.length ? encodeMetadataBlock(fields) : null;
	}

	// -- hashing / loading ---------------------------------------------------

	/**
	 * Hash of the fully-rendered markdown a file would publish (post dedup-rename,
	 * comments, wikilink resolution, and LaTeX). Used by skip-unchanged to decide
	 * whether a republish is needed without doing the expensive ADF parse / mermaid
	 * render. Captures content, effective title, wikilink-target titles (baked into
	 * the sentinels), dedup renames, the label set and any attached asset's bytes;
	 * it does NOT capture changes to embedded IMAGES (e.g. a picture edited in
	 * place) — use Force republish for those.
	 */
	async computePublishHash(absoluteFilePath: string): Promise<string> {
		const md = await this.loadMarkdownFile(absoluteFilePath);
		// A folder landing file is published under its FOLDER's title (not its own
		// pageTitle), so fold that in — otherwise a folder-title change (e.g. a new
		// colliding sibling) wouldn't trigger a republish of the landing page.
		const folderTitle = this.landingToFolderTitle.get(absoluteFilePath) ?? "";
		// Fold the published label set into the hash so a taxonomy-only change (which,
		// with the metadata panel off, wouldn't touch `contents`) still triggers a
		// republish to re-sync labels. Sorted for stability; only appended when there
		// are tags, so tagless notes keep their existing hash (no mass re-publish).
		const tags = Array.isArray(md.frontmatter?.tags)
			? (md.frontmatter.tags as unknown[]).filter((t): t is string => typeof t === "string").sort()
			: [];
		// Attachments are page content too: an edited script must republish its page.
		const attachments = await this.hashAttachments(absoluteFilePath);
		return SparkMD5.hash(
			JSON.stringify({
				schema: PUBLISH_HASH_SCHEMA_VERSION,
				pageTitle: md.pageTitle,
				folderTitle,
				contents: md.contents,
				tags,
				attachments,
			}),
		);
	}

	/** Content hash of every attachment a page links to, in stable order. */
	private async hashAttachments(sourcePath: string): Promise<string[]> {
		const requests = this.attachmentsByPath.get(sourcePath);
		if (!requests || requests.length === 0) return [];
		const out: string[] = [];
		for (const req of [...requests].sort((a, b) => a.filename.localeCompare(b.filename))) {
			const file = this.app.vault.getAbstractFileByPath(req.vaultPath);
			if (!(file instanceof TFile)) continue;
			try {
				const bytes = await this.vault.readBinary(file);
				out.push(`${req.filename}:${new SparkMD5.ArrayBuffer().append(bytes).end()}`);
			} catch {
				out.push(`${req.filename}:unreadable`);
			}
		}
		return out;
	}

	async getMarkdownFilesToUpload(): Promise<FilesToUpload> {
		const filesToPublish: TFile[] = [];
		for (const file of this.vault.getMarkdownFiles()) {
			if (this.batchFilter && !this.batchFilter.has(file.path)) continue;
			if (!this.isPublishable(file)) continue;
			filesToPublish.push(file);
		}

		const filesToUpload: MarkdownFile[] = [];
		for (const file of filesToPublish) {
			filesToUpload.push(await this.loadMarkdownFile(file.path));
		}
		return filesToUpload;
	}

	/** Derive, normalise, filter, prefix and cap a page's Confluence labels (F8). */
	private applyLabelPolicy(parsedFrontMatter: Record<string, unknown>, sourcePath: string): void {
		const sources = this.nav.labelSources ?? DEFAULT_NAVIGATION_SETTINGS.labelSources;
		// `tags` are normalised like every other source: an author writing
		// "DO-178C" and a taxonomy term "do-178c" must land on one label.
		const authorTags = sources.tags
			? fmList(parsedFrontMatter.tags)
					.map((t) => slugifyLabel(t))
					.filter((t) => t.length > 0)
			: [];

		const derivedFields = this.mapTaxonomyToLabels
			? (Object.keys(sources) as TaxonomyLabelField[]).filter((f) => f !== "tags" && sources[f])
			: [];
		const derived = derivedFields.length
			? deriveTaxonomyLabels(parsedFrontMatter, derivedFields, this.nav.labelPrefixes ?? {})
			: [];

		const merged = mergeTags(authorTags, derived);
		const { kept, dropped } = filterByAllowlist(merged, this.labelAllowlist, this.nav.labelPrefixes ?? {});
		for (const label of dropped) {
			this.droppedLabelCounts.set(label, (this.droppedLabelCounts.get(label) ?? 0) + 1);
		}
		const final = capLabels(kept, this.nav.labelMaxPerPage ?? 0);
		this.labelsByPath.set(sourcePath, final);
		parsedFrontMatter.tags = final;
	}

	async loadMarkdownFile(absoluteFilePath: string): Promise<MarkdownFile> {
		const file = this.app.vault.getAbstractFileByPath(absoluteFilePath);
		if (!(file instanceof TFile)) {
			throw new Error("Not a TFile");
		}

		const fileFM = this.metadataCache.getCache(file.path);
		if (!fileFM) {
			throw new Error("Missing File in Metadata Cache");
		}
		const frontMatter = fileFM.frontmatter;

		const parsedFrontMatter: Record<string, unknown> = {};
		if (frontMatter) {
			for (const [key, value] of Object.entries(frontMatter)) {
				parsedFrontMatter[key] = value;
			}
		}

		let contents = await this.vault.cachedRead(file);

		// Normalize CRLF so the library's regex-based frontmatter and markdown
		// parsing don't misbehave on Windows-saved notes.
		contents = contents.replace(/\r\n/g, "\n");

		// Rendering a page is idempotent: clear anything the previous render of
		// THIS page recorded so a re-render can't accumulate duplicates.
		this.diagnosticsByPath.set(
			file.path,
			(this.diagnosticsByPath.get(file.path) ?? []).filter((d) => d.kind === "title-truncated"),
		);
		this.attachmentsByPath.delete(file.path);
		this.attachmentClaims.delete(file.path);

		// The publish context resolved this file's title already; fall back to a
		// direct resolve for a caller that skipped computePublishContext.
		const resolvedTitle =
			this.publishTitleByPath.get(file.path) ??
			resolveTitle(file.basename, parsedFrontMatter, contents, {
				titleSource: this.effectiveTitleSource(),
				consumeFirstHeading: this.nav.consumeFirstHeading,
			}).title;

		let pageTitle = resolvedTitle;
		const rename = this.dedupMap.get(file.path);
		if (rename) {
			pageTitle = rename.renamedTitle;
			// With the library's own first-heading title extraction on, it would
			// override pageTitle from the body's H1. Rewrite that H1 so the
			// library's extraction agrees with our renamed title.
			if (this.settings.firstHeadingPageTitle && this.effectiveTitleSource() === "first-heading") {
				const lines = contents.split("\n");
				const heading = findFirstHeadingLine(lines);
				if (heading) {
					lines[heading.index] = `${heading.indent}# ${rename.renamedTitle}`;
					contents = lines.join("\n");
				}
			}
		}

		// Feed the resolved title back through the frontmatter key the library
		// already reads, so ConniePageConfig agrees with the plugin instead of
		// re-deriving a title from the body. The vault file is never modified.
		if (typeof parsedFrontMatter["connie-title"] !== "string" || !parsedFrontMatter["connie-title"]) {
			parsedFrontMatter["connie-title"] = pageTitle;
		}

		// Drop the body's own H1 when it merely restates the title (F1).
		contents = consumeFirstHeading(contents, pageTitle, this.nav.consumeFirstHeading);

		// Surface frontmatter as a Page Properties panel at the top of the page
		// (the library otherwise strips frontmatter entirely). Inserted as a
		// protected fenced sentinel, so the passes below leave it untouched.
		if (this.showMetadataPanel) {
			const block = this.buildMetadataBlock(frontMatter, file.path);
			if (block) contents = insertAfterFrontmatter(contents, block);
		}

		// Project taxonomy frontmatter onto Confluence labels (clickable/filterable,
		// unlike the read-only metadata panel). The library publishes whatever ends
		// up in `frontmatter.tags` as labels, so the policy's output goes there. The
		// label set also feeds computePublishHash so a taxonomy-only edit still
		// triggers a republish to re-sync labels.
		this.applyLabelPolicy(parsedFrontMatter, file.path);

		// Obsidian-specific syntax the library's CommonMark parser can't handle.
		// Order matters: strip comments first (so commented-out links/math are
		// not processed), resolve wikilinks, then LaTeX. Each pass protects code.
		const linkOptions = {
			resolve: (target: string) => this.resolveWikilink(target, file.path),
			onDiagnostic: (d: LinkDiagnostic) => this.addDiagnostic(d),
			sourcePath: file.path,
			resolveFolder: (target: string) => this.resolveFolderLink(target, file.path),
			resolveAsset: (target: string) => this.resolveAssetLink(target, file.path),
			resolveAbsolute: (target: string) => this.resolveAbsoluteLink(target),
		};
		contents = preprocessComments(contents);
		contents = preprocessWikilinks(contents, linkOptions);
		contents = preprocessMarkdownLinks(contents, linkOptions);
		contents = preprocessTableCells(contents);
		contents = preprocessLatex(contents);

		return {
			pageTitle,
			folderName: file.parent?.name || "",
			absoluteFilePath: file.path,
			fileName: file.name,
			contents,
			frontmatter: parsedFrontMatter,
		};
	}

	async readBinary(path: string, referencedFromFilePath: string): Promise<BinaryFile | false> {
		const testing = this.metadataCache.getFirstLinkpathDest(path, referencedFromFilePath);
		if (testing) {
			if (!SUPPORTED_IMAGE_EXTENSIONS.includes(testing.extension.toLowerCase())) {
				return false;
			}
			const files = await this.vault.readBinary(testing);
			const mimeType = lookup(testing.extension) || "application/octet-stream";
			return {
				contents: files,
				filePath: testing.path,
				filename: testing.name,
				mimeType: mimeType,
			};
		}

		return false;
	}

	/**
	 * Read an arbitrary vault file for attachment upload (F4c). Unlike
	 * `readBinary` this is NOT restricted to images and never feeds the
	 * library's image pipeline — the library measures every buffer it uploads
	 * with `image-size`, which throws on a script or a notebook.
	 */
	async readAttachment(vaultPath: string): Promise<BinaryFile | false> {
		const file = this.app.vault.getAbstractFileByPath(vaultPath);
		if (!(file instanceof TFile)) return false;
		const contents = await this.vault.readBinary(file);
		return {
			contents,
			filePath: file.path,
			filename: file.name,
			mimeType: lookup(file.extension) || "application/octet-stream",
		};
	}

	async updateMarkdownValues(
		absoluteFilePath: string,
		values: Partial<ConfluencePageConfig.ConfluencePerPageAllValues>,
	): Promise<void> {
		const config = ConfluencePageConfig.conniePerPageConfig;
		const file = this.app.vault.getAbstractFileByPath(absoluteFilePath);
		if (file instanceof TFile) {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				for (const propertyKey in config) {
					if (!config.hasOwnProperty(propertyKey)) {
						continue;
					}

					const { key } = config[propertyKey as keyof ConfluencePageConfig.ConfluencePerPageConfig];
					const value = values[propertyKey as keyof ConfluencePageConfig.ConfluencePerPageAllValues];
					if (propertyKey in values) {
						fm[key] = value;
					}
				}
			});
		}
	}
}
