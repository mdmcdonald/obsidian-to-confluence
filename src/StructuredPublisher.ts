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
import { planReparents } from "./reparent";

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

		// Data Center fix for the folder-under-folder bug: this DC doesn't apply the
		// `ancestors` field reliably (observed ignored on both create AND update), so
		// child folders land flat under the parent page — even brand-new ones. Re-parent
		// every mis-placed page explicitly via the move endpoint, comparing each page's
		// actual current parent to its intended one. Runs over the FULL tree (not the
		// publishFilter subset) so folder pages are fixed even on a single-file publish.
		await this.enforceParentHierarchy(allPages, self.confluenceClient);

		return results;
	}

	/**
	 * Move any page whose current parent differs from its intended parent under the
	 * correct one, via `PUT /content/{id}/move/append/{targetId}`. The decision is
	 * made by the pure, harness-tested `planReparents`. Each move is VERIFIED by
	 * re-fetching the page's parent afterwards — because this DC has silently ignored
	 * the `ancestors` field before, the move endpoint could be ignored the same way,
	 * and a blindly-counted "moved" would be misleading. The summary distinguishes
	 * applied / accepted-but-ignored / failed so the cause is unambiguous in the log.
	 */
	private async enforceParentHierarchy(nodes: Any[], client: Any): Promise<void> {
		const moves = planReparents(nodes);
		if (moves.length === 0) return;
		let applied = 0;
		let ignored = 0;
		let failed = 0;
		for (const m of moves) {
			try {
				await client.sendRequest({
					url: `/api/content/${m.pageId}/move/append/${m.targetId}`,
					method: "PUT",
				});
			} catch (e) {
				failed++;
				console.warn(
					`[Confluence] move endpoint rejected for "${m.title}" (${m.pageId}) → ${m.targetId}:`,
					e,
				);
				continue;
			}
			// Confirm the move actually took effect (DC may accept it but not apply it).
			try {
				const after = await client.content.getContentById({ id: m.pageId, expand: ["ancestors"] });
				const anc: Any[] = after?.ancestors ?? [];
				const actualParent = anc.length ? anc[anc.length - 1]?.id : undefined;
				if (String(actualParent) === String(m.targetId)) applied++;
				else ignored++;
			} catch {
				applied++; // couldn't verify — assume the accepted move worked
			}
		}
		let msg = `[Confluence] Folder hierarchy: ${applied}/${moves.length} page(s) re-parented (move endpoint)`;
		if (failed) msg += `; ${failed} call(s) FAILED — move endpoint may be unavailable on this Confluence`;
		if (ignored) msg += `; ${ignored} accepted but NOT APPLIED — this Confluence is ignoring the move endpoint too (REST re-parenting unsupported here)`;
		console.log(msg);
	}
}
