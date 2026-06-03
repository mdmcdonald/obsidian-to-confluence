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

		const allPages = await ensureAllFilesExistInConfluence(
			self.confluenceClient,
			self.adaptor,
			folderTree,
			spaceToPublishTo.key,
			parentPage.id,
			parentPage.id,
			settings,
		);

		let confluencePagesToPublish = allPages;
		if (publishFilter) {
			confluencePagesToPublish = allPages.filter(
				(file: Any) => file.file.absoluteFilePath === publishFilter,
			);
		}

		const adrFileTasks = confluencePagesToPublish.map((file: Any) => self.publishFile(file));
		const results = await Promise.all(adrFileTasks);

		// Data Center fix: Confluence Server/DC ignores the `ancestors` field on
		// content create/update, so the nested tree we send otherwise lands FLAT
		// under the parent page. (Same class of DC quirk this client already works
		// around for ADF→storage conversion and attachment PUT→POST.) Enforce the
		// intended hierarchy explicitly via the move endpoint. Runs over the FULL
		// tree — not the publishFilter subset — so folder pages get parented too.
		await this.enforceParentHierarchy(allPages, self.confluenceClient);

		return results;
	}

	/**
	 * Force each page under its intended parent via `PUT /content/{id}/move/append/{targetId}`,
	 * because Data Center ignores `ancestors` on create/update. Skips pages already
	 * correctly parented (by comparing intended vs. current direct parent), and walks
	 * parent-before-child (flattenTree order) so a parent exists before its children
	 * are appended. Failures are logged, not fatal — if an older DC lacks the move
	 * endpoint we surface it rather than silently flattening.
	 */
	private async enforceParentHierarchy(nodes: Any[], client: Any): Promise<void> {
		let moved = 0;
		let failed = 0;
		for (const node of nodes) {
			const chain: string[] = node.ancestors ?? [];
			const pageId: string | undefined = node.file?.pageId;
			if (chain.length === 0 || !pageId) continue; // root carrier / unresolved
			const intendedParent = chain[chain.length - 1];
			const existing = node.existingPageData?.ancestors ?? [];
			const currentParent = existing.length ? existing[existing.length - 1]?.id : undefined;
			if (!intendedParent || String(currentParent) === String(intendedParent)) continue;
			try {
				await client.sendRequest({
					url: `/api/content/${pageId}/move/append/${intendedParent}`,
					method: "PUT",
				});
				moved++;
			} catch (e) {
				failed++;
				console.warn(
					`[Confluence] Could not re-parent "${node.file?.pageTitle}" (${pageId}) under ${intendedParent}:`,
					e,
				);
			}
		}
		if (moved || failed) {
			console.log(
				`[Confluence] Data Center re-parent pass: ${moved} page(s) moved${failed ? `, ${failed} failed (move endpoint may be unavailable)` : ""}.`,
			);
		}
	}
}
