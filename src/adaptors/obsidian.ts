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
import { preprocessLatex } from "../LatexPreprocessor";

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
		contents = preprocessLatex(contents);

		return {
			pageTitle: file.basename,
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
