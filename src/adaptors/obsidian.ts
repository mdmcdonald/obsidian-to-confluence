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

export interface TitleRename {
	filePath: string;
	originalTitle: string;
	renamedTitle: string;
}

function extractFirstH1(content: string): string | undefined {
	// Skip YAML frontmatter if present
	let body = content;
	if (body.startsWith("---\n")) {
		const end = body.indexOf("\n---", 4);
		if (end > 0) body = body.substring(end + 4);
	}
	const m = body.match(/^[\t ]*#[\t ]+(.+?)[\t ]*$/m);
	return m ? m[1].trim() : undefined;
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
	/** Populated by computeTitleDedupMap(); applied in loadMarkdownFile(). */
	private dedupMap: Map<string, TitleRename> = new Map();

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
	 * Walk every publishable file, compute its effective Confluence page title
	 * (basename or first H1 when firstHeadingPageTitle is on), and for any
	 * title shared by two or more files produce a unique renamed title by
	 * appending ` (<6-char md5 of path>)`. Results stored on the adaptor and
	 * consulted by loadMarkdownFile.
	 *
	 * Path-based hash is deterministic across re-publishes — the same file
	 * always gets the same suffix.
	 */
	async computeTitleDedupMap(): Promise<void> {
		this.dedupMap.clear();
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

		if (this.dedupMap.size > 0) {
			console.log(`[Confluence] Deduplicating ${this.dedupMap.size} colliding page title(s)`);
		}
	}

	getTitleRenames(): TitleRename[] {
		return Array.from(this.dedupMap.values());
	}

	clearTitleDedupMap(): void {
		this.dedupMap.clear();
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
				contents = contents.replace(
					/^([\t ]*)#[\t ]+.+?[\t ]*$/m,
					`$1# ${rename.renamedTitle.replace(/\$/g, "$$$$")}`,
				);
			}
		}

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
