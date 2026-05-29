import { Vault, MetadataCache, App, TFile } from "obsidian";
import {
	ConfluenceUploadSettings,
	BinaryFile,
	FilesToUpload,
	LoaderAdaptor,
	MarkdownFile,
	ConfluencePageConfig,
} from "@markdown-confluence/lib";
import { lookup } from "mime-types";
import SparkMD5 from "spark-md5";
import { preprocessLatex } from "../LatexPreprocessor";
import {
	preprocessComments,
	preprocessWikilinks,
	WikilinkResolution,
} from "../obsidianPreprocess";

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
		for (const { path, title } of titles) {
			const rename = this.dedupMap.get(path);
			this.publishTitleByPath.set(path, rename ? rename.renamedTitle : title);
		}

		if (this.dedupMap.size > 0) {
			console.log(`[Confluence] Deduplicating ${this.dedupMap.size} colliding page title(s)`);
		}
	}

	getTitleRenames(): TitleRename[] {
		return Array.from(this.dedupMap.values());
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

		// Obsidian-specific syntax the library's CommonMark parser can't handle.
		// Order matters: strip comments first (so commented-out links/math are
		// not processed), resolve wikilinks, then LaTeX. Each pass protects code.
		contents = preprocessComments(contents);
		contents = preprocessWikilinks(contents, {
			resolve: (target) => this.resolveWikilink(target, file.path),
			onWarning: (msg) => console.log(`[Confluence] ${msg}`),
		});
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
