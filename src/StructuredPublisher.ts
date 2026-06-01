/**
 * A Publisher subclass that preserves the vault's folder hierarchy in Confluence.
 *
 * The stock `Publisher.publish()` builds its page tree from
 * `createFolderStructure(files)` — which collapses the folder hierarchy when it
 * sees a batched/filtered subset of files (see folderTree.ts for the why). This
 * override replaces only that one step with `adaptor.buildLocalAdfTree(files)`,
 * which builds a tree against the GLOBAL structure (stable root, unique folder
 * titles). Everything else (page existence, content upload, labels) is the
 * library's unchanged machinery.
 */
import { Publisher } from "@markdown-confluence/lib";
import { ensureAllFilesExistInConfluence } from "@markdown-confluence/lib/dist/TreeConfluence.js";
import type ObsidianAdaptor from "./adaptors/obsidian";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export class StructuredPublisher extends Publisher {
	private structuredAdaptor: ObsidianAdaptor;

	constructor(
		adaptor: ObsidianAdaptor,
		settingsLoader: Any,
		confluenceClient: Any,
		adfProcessingPlugins: Any,
	) {
		super(adaptor, settingsLoader, confluenceClient, adfProcessingPlugins);
		this.structuredAdaptor = adaptor;
	}

	override async publish(publishFilter?: string): Promise<Any> {
		// Mirror of Publisher.publish() (pinned @markdown-confluence/lib@5.5.2),
		// swapping only the tree-building step. NOTE: this reaches the library's
		// instance fields (myAccountId/adaptor/settingsLoader/confluenceClient)
		// and publishFile() via a cast — if a future library version renames
		// those, this breaks at runtime, so the dependency is pinned.
		const self = this as Any;
		const settings = self.settingsLoader.load();
		if (!self.myAccountId) {
			const currentUser = await self.confluenceClient.users.getCurrentUser();
			self.myAccountId = currentUser.accountId;
		}
		const parentPage = await self.confluenceClient.content.getContentById({
			id: settings.confluenceParentId,
			expand: ["body.atlas_doc_format", "space"],
		});
		if (!parentPage.space) {
			throw new Error("Missing Space Key");
		}
		const spaceToPublishTo = parentPage.space;

		const files = await self.adaptor.getMarkdownFilesToUpload();
		// ── the only change vs. the stock publisher ──────────────────────────
		const folderTree = await this.structuredAdaptor.buildLocalAdfTree(files, settings);
		// ─────────────────────────────────────────────────────────────────────

		let confluencePagesToPublish = await ensureAllFilesExistInConfluence(
			self.confluenceClient,
			self.adaptor,
			folderTree,
			spaceToPublishTo.key,
			parentPage.id,
			parentPage.id,
			settings,
		);

		if (publishFilter) {
			confluencePagesToPublish = confluencePagesToPublish.filter(
				(file: Any) => file.file.absoluteFilePath === publishFilter,
			);
		}

		const adrFileTasks = confluencePagesToPublish.map((file: Any) => self.publishFile(file));
		return await Promise.all(adrFileTasks);
	}
}
