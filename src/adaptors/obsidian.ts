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
	type TaxonomyLabelField,
} from "../taxonomyLabels";
import {
	deriveStructure,
	computeFolderTitles,
	buildTree,
	assertUniqueTitles,
	splitPath,
	relativeTo,
	type DerivedStructure,
	type FolderTreeNode,
} from "../folderTree";
import {
	preprocessComments,
	preprocessWikilinks,
	preprocessMarkdownLinks,
	preprocessTableCells,
	WikilinkResolution,
	MetaField,
	MetaValue,
	encodeMetadataBlock,
} from "../obsidianPreprocess";

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
	["capabilities", "Capabilities"],
	["external_interfaces", "External interfaces"],
];

/**
 * Frontmatter fields projected onto Confluence labels when `mapTaxonomyToLabels`
 * is on. Categorical facets only — `id` is unique-per-page and the relationship
 * fields are page links, neither of which makes a useful navigational label.
 */
const TAXONOMY_LABEL_FIELDS: readonly TaxonomyLabelField[] = ["subject", "type"];

function fmList(v: unknown): string[] {
	if (v == null) return [];
	const arr = Array.isArray(v) ? v : [v];
	return arr.map((x) => String(x).replace(/^["']|["']$/g, "").trim()).filter((s) => s.length > 0);
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

const ATX_HEADING_RE = /^([\t ]*)#[\t ]+(.+?)[\t ]*$/;
const FENCE_OPEN_RE = /^[\t ]*(```|~~~)/;

/**
 * Find the first ATX heading line that is NOT inside a fenced code block.
 * Matches how the library extracts the page title (its parser never produces a
 * heading from inside a code fence), so a `# ...` line inside ``` is ignored.
 * Returns the matching line index and captured groups, or null.
 */
function findFirstHeadingLine(
	lines: string[],
): { index: number; indent: string; text: string } | null {
	let inFence: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (inFence) {
			if (new RegExp(`^[\\t ]*${inFence}[\\t ]*$`).test(line)) inFence = null;
			continue;
		}
		const fence = FENCE_OPEN_RE.exec(line);
		if (fence) {
			inFence = fence[1];
			continue;
		}
		const h = ATX_HEADING_RE.exec(line);
		if (h) return { index: i, indent: h[1], text: h[2].trim() };
	}
	return null;
}

function extractFirstH1(content: string): string | undefined {
	// Skip YAML frontmatter if present
	let body = content;
	if (body.startsWith("---\n")) {
		const end = body.indexOf("\n---", 4);
		if (end > 0) body = body.substring(end + 4);
	}
	return findFirstHeadingLine(body.split("\n"))?.text;
}

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
	/** frontmatter `id` → final Confluence title, for resolving ontology refs. */
	private idToTitle: Map<string, string> = new Map();
	/** Set by the plugin: emit a Page Properties panel from frontmatter. */
	showMetadataPanel = false;
	/** Set by the plugin: project taxonomy frontmatter onto Confluence labels. */
	mapTaxonomyToLabels = false;
	/** Set by the plugin: preserve the vault folder hierarchy in Confluence. */
	preserveFolderStructure = true;
	/** Global folder structure (commonPath, folders, landing files), per publish. */
	private structure: DerivedStructure | undefined;
	/** folderRelPath → unique Confluence title. */
	private folderTitleByPath: Map<string, string> = new Map();
	/** landing file vault path → its folder's title (for skip-unchanged hashing). */
	private landingToFolderTitle: Map<string, string> = new Map();

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

	private isPublishable(file: TFile): boolean {
		if (file.path.endsWith(".excalidraw")) return false;
		const fileFM = this.metadataCache.getCache(file.path);
		if (!fileFM) return false;
		const frontMatter = fileFM.frontmatter;
		return (
			(file.path.startsWith(this.settings.folderToPublish) &&
				(!frontMatter || frontMatter["connie-publish"] !== false)) ||
			(!!frontMatter && frontMatter["connie-publish"] === true)
		);
	}

	async getAllPublishableFilePaths(): Promise<string[]> {
		return this.vault
			.getMarkdownFiles()
			.filter((f) => this.isPublishable(f))
			.map((f) => f.path);
	}

	/**
	 * Walk every publishable file and compute its effective Confluence page
	 * title (basename, or first H1 when firstHeadingPageTitle is on). Two things
	 * are produced and stored on the adaptor:
	 *
	 *  1. `publishTitleByPath` — the final title each publishable file is
	 *     published under (always built; needed for wikilink resolution).
	 *  2. `dedupMap` — for any title shared by 2+ files, a unique renamed title
	 *     (`Title (<6-char md5 of path>)`). Only populated when the
	 *     `deduplicateTitles` setting is on; consulted by loadMarkdownFile.
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
	 * Cost note: when firstHeadingPageTitle is on this reads every publishable
	 * file (cachedRead) to extract its H1 — unavoidable, since resolving any
	 * [[link]] requires knowing the target's title. When it is off (the default)
	 * no file contents are read. Even for a single-file publish the whole
	 * publishable set is walked, because a published page may link to any other.
	 */
	async computePublishContext(deduplicateTitles: boolean): Promise<void> {
		this.dedupMap.clear();
		this.publishTitleByPath.clear();
		this.idToTitle.clear();
		const paths = await this.getAllPublishableFilePaths();

		const titles: { path: string; title: string }[] = [];
		for (const path of paths) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;
			let title = file.basename;
			if (this.settings.firstHeadingPageTitle) {
				try {
					const content = await this.vault.cachedRead(file);
					const h1 = extractFirstH1(content);
					if (h1) title = h1;
				} catch {
					// fall back to basename
				}
			}
			titles.push({ path, title });
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
				const key = String(id).replace(/^["']|["']$/g, "").trim();
				if (key) this.idToTitle.set(key, finalTitle);
			}
		}

		if (this.dedupMap.size > 0) {
			console.log(`[Confluence] Deduplicating ${this.dedupMap.size} colliding page title(s)`);
		}

		// Folder structure, rooted at the configured publish scope (folderToPublish)
		// — NOT the common path of the file set, which shifts as files are added or
		// removed and collapses shared folders onto the parent page (the "two
		// separate trees" bug). Rooting at the fixed scope keeps the hierarchy
		// stable across batches and runs. Folder titles are deduped against the
		// file titles too.
		this.structure = undefined;
		this.folderTitleByPath.clear();
		this.landingToFolderTitle.clear();
		if (this.preserveFolderStructure && paths.length > 0) {
			const structure = deriveStructure(paths, this.settings.folderToPublish);
			this.folderTitleByPath = computeFolderTitles(
				structure.folders,
				this.publishTitleByPath.values(),
			);
			this.structure = structure;

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
					const key = String(id).replace(/^["']|["']$/g, "").trim();
					if (key) this.idToTitle.set(key, folderTitle);
				}
			}
			console.log(`[Confluence] Preserving folder structure: ${structure.folders.length} folder(s), root "${structure.commonPath || "(vault)"}"`);
		}
	}

	getTitleRenames(): TitleRename[] {
		return Array.from(this.dedupMap.values());
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
		const allFiles = extra.length ? [...markdownFiles, ...extra] : markdownFiles;

		const tree = buildTree(allFiles, {
			commonPath: structure.commonPath,
			folderTitle: this.folderTitleByPath,
			indexFileByFolder: structure.indexFileByFolder,
			folderFileAdf: folderFile,
			convertFile: (mf) => convertMDtoADF(mf, settings),
		});
		assertUniqueTitles(tree); // the safety check the library's tree builder runs
		return tree;
	}

	/**
	 * Resolve a wikilink target (page name only — no #heading or |alias) to the
	 * Confluence page it should link to. Used by preprocessWikilinks.
	 */
	resolveWikilink(rawTarget: string, sourcePath: string): WikilinkResolution {
		const dest = this.metadataCache.getFirstLinkpathDest(rawTarget, sourcePath);
		if (!dest) return { inVault: false, publishable: false };
		const title = this.publishTitleByPath.get(dest.path);
		if (title !== undefined) {
			return { inVault: true, publishable: true, title };
		}
		return { inVault: true, publishable: false, title: dest.basename };
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
			return { text: display ?? bare, link: { title: res.title, anchor, display: display ?? bare } };
		}
		// 2) by ontology graph id
		const byId = this.idToTitle.get(bare);
		if (byId !== undefined) {
			return { text: display ?? byId, link: { title: byId, anchor, display: display ?? byId } };
		}
		// 3) plain, humanised
		return { text: display ?? humaniseRef(value) };
	}

	/**
	 * Build the metadata panel sentinel from a file's frontmatter, or null if
	 * there is nothing worth showing. Relationship/ontology fields are resolved
	 * to page links; `subject` taxonomy terms and scalars are humanised text.
	 */
	private buildMetadataBlock(
		frontmatter: Record<string, unknown> | undefined,
		sourcePath: string,
	): string | null {
		if (!frontmatter) return null;
		const fields: MetaField[] = [];
		const push = (label: string, values: MetaValue[]) => {
			if (values.length) fields.push({ label, values });
		};

		const typeVal = frontmatter.type ?? frontmatter.document_type;
		if (typeVal != null) push("Type", [{ text: humaniseRef(String(typeVal)) }]);
		for (const [key, label] of META_SCALAR_FIELDS) {
			const vals = fmList(frontmatter[key]).map((v) => ({ text: humaniseRef(v) }));
			push(label, vals);
		}
		// subject = taxonomy terms (not pages) — humanise.
		push("Subject", fmList(frontmatter.subject).map((v) => ({ text: humaniseRef(v) })));
		// relationships → links where resolvable.
		for (const [key, label] of META_REL_FIELDS) {
			push(label, fmList(frontmatter[key]).map((v) => this.resolveMetaRef(v, sourcePath)));
		}
		return fields.length ? encodeMetadataBlock(fields) : null;
	}

	/**
	 * Hash of the fully-rendered markdown a file would publish (post dedup-rename,
	 * comments, wikilink resolution, and LaTeX). Used by skip-unchanged to decide
	 * whether a republish is needed without doing the expensive ADF parse / mermaid
	 * render. Captures content, effective title, wikilink-target titles (baked into
	 * the sentinels) and dedup renames; it does NOT capture changes to embedded
	 * binary files (e.g. an image edited in place) — use Force republish for those.
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
			? (md.frontmatter.tags as unknown[])
					.filter((t): t is string => typeof t === "string")
					.sort()
			: [];
		const base = `${md.pageTitle} ${folderTitle} ${md.contents}`;
		return SparkMD5.hash(tags.length ? `${base} tags=${tags.join(",")}` : base);
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

		let pageTitle = file.basename;
		const rename = this.dedupMap.get(file.path);
		if (rename) {
			pageTitle = rename.renamedTitle;
			// When firstHeadingPageTitle is on, the library overrides pageTitle
			// using the first H1 from content. Rewrite that H1 so the library's
			// extraction agrees with our renamed title.
			if (this.settings.firstHeadingPageTitle) {
				const lines = contents.split("\n");
				const heading = findFirstHeadingLine(lines);
				if (heading) {
					lines[heading.index] = `${heading.indent}# ${rename.renamedTitle}`;
					contents = lines.join("\n");
				}
			}
		}

		// Surface frontmatter as a Page Properties panel at the top of the page
		// (the library otherwise strips frontmatter entirely). Inserted as a
		// protected fenced sentinel, so the passes below leave it untouched.
		if (this.showMetadataPanel) {
			const block = this.buildMetadataBlock(frontMatter, file.path);
			if (block) contents = insertAfterFrontmatter(contents, block);
		}

		// Project taxonomy frontmatter onto Confluence labels (clickable/filterable,
		// unlike the read-only metadata panel). The library publishes whatever ends
		// up in `frontmatter.tags` as labels, so we merge derived slugs in there —
		// preserving any author-set `tags`. The label set also feeds computePublishHash
		// so a taxonomy-only edit still triggers a republish to re-sync labels.
		if (this.mapTaxonomyToLabels) {
			const derived = deriveTaxonomyLabels(parsedFrontMatter, TAXONOMY_LABEL_FIELDS);
			if (derived.length) {
				parsedFrontMatter.tags = mergeTags(parsedFrontMatter.tags, derived);
			}
		}

		// Obsidian-specific syntax the library's CommonMark parser can't handle.
		// Order matters: strip comments first (so commented-out links/math are
		// not processed), resolve wikilinks, then LaTeX. Each pass protects code.
		const resolve = (target: string) => this.resolveWikilink(target, file.path);
		const onWarning = (msg: string) => console.log(`[Confluence] ${msg}`);
		contents = preprocessComments(contents);
		contents = preprocessWikilinks(contents, { resolve, onWarning });
		contents = preprocessMarkdownLinks(contents, { resolve, onWarning });
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

	async readBinary(
		path: string,
		referencedFromFilePath: string,
	): Promise<BinaryFile | false> {
		const testing = this.metadataCache.getFirstLinkpathDest(
			path,
			referencedFromFilePath,
		);
		if (testing) {
			if (
				!SUPPORTED_IMAGE_EXTENSIONS.includes(
					testing.extension.toLowerCase(),
				)
			) {
				return false;
			}
			const files = await this.vault.readBinary(testing);
			const mimeType =
				lookup(testing.extension) || "application/octet-stream";
			return {
				contents: files,
				filePath: testing.path,
				filename: testing.name,
				mimeType: mimeType,
			};
		}

		return false;
	}
	async updateMarkdownValues(
		absoluteFilePath: string,
		values: Partial<ConfluencePageConfig.ConfluencePerPageAllValues>,
	): Promise<void> {
		const config = ConfluencePageConfig.conniePerPageConfig;
		const file = this.app.vault.getAbstractFileByPath(absoluteFilePath);
		if (file instanceof TFile) {
			this.app.fileManager.processFrontMatter(file, (fm) => {
				for (const propertyKey in config) {
					if (!config.hasOwnProperty(propertyKey)) {
						continue;
					}

					const { key } =
						config[
							propertyKey as keyof ConfluencePageConfig.ConfluencePerPageConfig
						];
					const value =
						values[
							propertyKey as keyof ConfluencePageConfig.ConfluencePerPageAllValues
						];
					if (propertyKey in values) {
						fm[key] = value;
					}
				}
			});
		}
	}
}
