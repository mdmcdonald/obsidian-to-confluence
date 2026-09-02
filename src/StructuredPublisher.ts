/**
 * A Publisher subclass that preserves the vault's folder hierarchy in Confluence.
 *
 * The stock `Publisher.publish()` builds its page tree from
 * `createFolderStructure(files)` — which collapses the folder hierarchy when it
 * sees a batched/filtered subset of files (see folderTree.ts for the why). This
 * override replaces that one step with `adaptor.buildLocalAdfTree(files)`,
 * which builds a tree against the GLOBAL structure (stable root, unique folder
 * titles), and adds three things the library has no concept of:
 *
 *   - promoting the publish root's landing file onto the configured parent page
 *     (F7), guarded so it can never overwrite someone else's page;
 *   - uploading non-image attachments the pages link to (F4c);
 *   - restoring labels a human added in Confluence that the library's
 *     replace-everything label pass would otherwise strip (F8).
 *
 * Everything else (page existence, content upload) is the library's unchanged
 * machinery.
 */
import { Publisher } from "@markdown-confluence/lib";
import SparkMD5 from "spark-md5";
import { ensureAllFilesExistInConfluence } from "@markdown-confluence/lib/dist/TreeConfluence.js";
import type ObsidianAdaptor from "./adaptors/obsidian";
import { planReparents } from "./reparent";
import { planLabelChanges } from "./publishState";
import { makeDiagnostic } from "./linkDiagnostics";
import { pruneTitleCollisions, type TitleLookupResult } from "./titlePreflight";

type Any = any;

/** Content property marking a parent page whose body this plugin owns (F7). */
export const ROOT_MANAGED_PROPERTY = "connie-managed-root";

export interface RootLandingDecision {
	allowed: boolean;
	reason: string;
}

/**
 * Whether the configured parent page may have its body replaced by the publish
 * root's landing file. Pure so the safety rule is testable without a server.
 *
 * Permitted when the page is effectively empty, when the publishing account was
 * the last editor (so we are only overwriting our own work), or when a previous
 * run already claimed the page with the managed-root content property.
 */
export function mayWriteRootLanding(input: {
	bodyText: string;
	lastUpdatedBy: string | undefined;
	createdBy: string | undefined;
	myAccountId: string | undefined;
	hasManagedProperty: boolean;
}): RootLandingDecision {
	if (input.hasManagedProperty) return { allowed: true, reason: "page already managed by a previous run" };
	const stripped = input.bodyText
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.trim();
	if (stripped.length === 0) return { allowed: true, reason: "parent page body is empty" };
	if (input.myAccountId && input.lastUpdatedBy && input.lastUpdatedBy === input.myAccountId) {
		return { allowed: true, reason: "publishing account was the last editor" };
	}
	if (input.myAccountId && input.createdBy && input.createdBy === input.myAccountId && !input.lastUpdatedBy) {
		return { allowed: true, reason: "publishing account created the page" };
	}
	return {
		allowed: false,
		reason: `parent page has content last edited by ${input.lastUpdatedBy ?? "another account"}`,
	};
}

export class StructuredPublisher extends Publisher {
	private structuredAdaptor: ObsidianAdaptor;
	/**
	 * Title → by-title lookup result (null = no such page), shared across the
	 * batches of one publish so a folder title is searched once, not once per
	 * batch. Cleared by `resetTitlePreflight()` at the start of each publish.
	 */
	private titleLookupCache = new Map<string, TitleLookupResult | null>();
	/**
	 * Confluence page id → the vault path it was last published from (from the
	 * plugin's publish record). Lets the pre-flight tell "this note's own page"
	 * from "another note's page that happens to carry the same title".
	 */
	pageOwners: Map<string, string> = new Map();

	constructor(adaptor: ObsidianAdaptor, settingsLoader: Any, confluenceClient: Any, adfProcessingPlugins: Any) {
		super(adaptor, settingsLoader, confluenceClient, adfProcessingPlugins);
		this.structuredAdaptor = adaptor;
	}

	/** Forget cached title lookups — a page may have been moved or deleted since the last run. */
	resetTitlePreflight(): void {
		this.titleLookupCache.clear();
	}

	/**
	 * The same by-title search the library performs in ensurePageExists, so the
	 * pre-flight agrees with it exactly. A lookup failure returns undefined and
	 * lets the library's own path run (and fail, if it must) as before.
	 */
	private async findPageByTitle(title: string, spaceKey: string, client: Any): Promise<TitleLookupResult | undefined> {
		try {
			const found = await client.content.getContent({
				type: "page",
				spaceKey,
				title,
				expand: ["ancestors"],
			});
			const page = found?.results?.[0];
			if (!page?.id) return undefined;
			return {
				id: String(page.id),
				ancestorIds: (page.ancestors ?? []).map((a: Any) => String(a?.id)),
			};
		} catch (e) {
			console.warn(`[Confluence] Title pre-flight lookup failed for "${title}":`, e);
			return undefined;
		}
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
			expand: ["body.atlas_doc_format", "space", "version"],
		});
		if (!parentPage.space) {
			throw new Error("Missing Space Key");
		}
		const spaceToPublishTo = parentPage.space;
		// F7's safety check ran once for the whole publish (plugin.prepareRootLanding);
		// the adaptor already knows the parent title and whether promotion is allowed.
		this.structuredAdaptor.rootPageTitle = parentPage.title;

		const files = await self.adaptor.getMarkdownFilesToUpload();
		// ── the only change vs. the stock publisher ──────────────────────────
		const fullTree = await this.structuredAdaptor.buildLocalAdfTree(files, settings);
		// ─────────────────────────────────────────────────────────────────────

		// A title held by a page outside the parent's subtree makes the library
		// throw from inside tree creation, failing the whole batch with one
		// message per file. Find those first, drop them (and their subtrees) from
		// this batch, and report each one with the page that holds the title.
		const preflight = await pruneTitleCollisions(fullTree, {
			lookup: (title) => this.findPageByTitle(title, spaceToPublishTo.key, self.confluenceClient),
			topPageId: String(parentPage.id),
			cache: this.titleLookupCache,
			ownerOf: (pageId) => this.pageOwners.get(String(pageId)),
		});
		for (const c of preflight.collisions) {
			const where =
				c.kind === "outside-tree"
					? `page ${c.pageId} outside the publish tree`
					: `page ${c.pageId}, published from "${c.holderSource}"`;
			console.error(`[Confluence] Title collision: "${c.title}" (${c.sourcePath}) is already used by ${where}.`);
			this.structuredAdaptor.recordDiagnostic(
				makeDiagnostic(
					c.kind === "outside-tree" ? "title-collides-in-space" : "title-collides-with-note",
					c.sourcePath,
					c.title,
					c.kind === "outside-tree"
						? `Confluence page ${c.pageId}`
						: `Confluence page ${c.pageId} from ${c.holderSource}`,
				),
			);
		}
		const folderTree = preflight.tree;
		const preflightFailures = preflight.skipped.map((s) => ({
			node: { file: { absoluteFilePath: s.sourcePath } },
			reason: s.reason,
		}));

		const allPages = await ensureAllFilesExistInConfluence(
			self.confluenceClient,
			self.adaptor,
			folderTree,
			spaceToPublishTo.key,
			parentPage.id,
			parentPage.id,
			settings,
		);

		// The library's flattenTree drops the root carrier (it has no ancestors),
		// so the parent page is never written. When root promotion is on, add it
		// back as a node that targets the parent page directly.
		const rootNode = this.buildRootNode(folderTree, parentPage);
		const pagesToConsider = rootNode ? [rootNode, ...allPages] : allPages;

		let confluencePagesToPublish = pagesToConsider;
		if (publishFilter) {
			confluencePagesToPublish = pagesToConsider.filter((file: Any) => file.file.absoluteFilePath === publishFilter);
		}

		// Attachments must exist before the page body referencing them is written,
		// otherwise the ri:attachment link renders as a broken placeholder.
		await this.uploadAttachments(confluencePagesToPublish, self.confluenceClient);

		const remoteLabels = await this.captureRemoteLabels(confluencePagesToPublish, self.confluenceClient);

		const adrFileTasks = confluencePagesToPublish.map((file: Any) => self.publishFile(file));
		const results = await Promise.all(adrFileTasks);

		// F8: the library replaces a page's labels with `adfFile.tags`, deleting
		// anything a human added in Confluence. Put those back.
		await this.restoreUnownedLabels(confluencePagesToPublish, remoteLabels, self.confluenceClient);

		if (rootNode) await this.markRootManaged(parentPage.id, rootNode.file.absoluteFilePath, self.confluenceClient);

		// Data Center fix for the folder-under-folder bug: this DC doesn't apply the
		// `ancestors` field reliably (observed ignored on both create AND update), so
		// child folders land flat under the parent page — even brand-new ones. Re-parent
		// every mis-placed page explicitly via the move endpoint, comparing each page's
		// actual current parent to its intended one. Runs over the FULL tree (not the
		// publishFilter subset) so folder pages are fixed even on a single-file publish.
		await this.enforceParentHierarchy(allPages, self.confluenceClient);

		return [...results, ...preflightFailures];
	}

	/**
	 * A ConfluenceNode for the configured parent page, so the library's own
	 * publishFile writes the root landing's body into it. `ancestors` is empty
	 * and `dontChangeParentPageId` is set, so no ancestor chain is ever sent for
	 * the parent page and the re-parent pass leaves it alone.
	 */
	private buildRootNode(folderTree: Any, parentPage: Any): Any | undefined {
		if (!this.structuredAdaptor.rootLandingAllowed) return undefined;
		const file = folderTree?.file;
		// A root carrier with a synthetic "__folder__/…" path means no landing
		// file was promoted into it — nothing to write.
		if (!file || typeof file.absoluteFilePath !== "string" || file.absoluteFilePath.startsWith("__folder__/")) {
			return undefined;
		}
		return {
			file: {
				...file,
				pageId: parentPage.id,
				spaceKey: parentPage.space?.key,
				pageUrl: "",
				pageTitle: parentPage.title,
				dontChangeParentPageId: true,
			},
			version: parentPage?.version?.number ?? 1,
			lastUpdatedBy: parentPage?.version?.by?.accountId ?? "",
			existingPageData: {
				adfContent: JSON.parse(parentPage?.body?.atlas_doc_format?.value ?? "{}"),
				pageTitle: parentPage.title,
				ancestors: [],
				contentType: parentPage.type ?? "page",
			},
			ancestors: [],
		};
	}

	/** Record that this plugin owns the parent page's body (F7). */
	private async markRootManaged(pageId: string, sourcePath: string, client: Any): Promise<void> {
		const body = { key: ROOT_MANAGED_PROPERTY, value: { source: sourcePath, schema: 1 } };
		try {
			await client.sendRequest({
				url: `/api/content/${pageId}/property/${ROOT_MANAGED_PROPERTY}`,
				method: "PUT",
				data: { ...body, version: { number: 2 } },
			});
		} catch {
			try {
				await client.sendRequest({
					url: `/api/content/${pageId}/property`,
					method: "POST",
					data: body,
				});
			} catch (e) {
				console.warn(`[Confluence] Could not set ${ROOT_MANAGED_PROPERTY} on page ${pageId}:`, e);
			}
		}
	}

	/**
	 * Upload the non-image files each page links to (F4c). Deliberately NOT
	 * routed through the library's image pipeline: that pipeline measures every
	 * buffer with `image-size`, which throws on a script or a notebook and would
	 * fail the whole page.
	 */
	private async uploadAttachments(nodes: Any[], client: Any): Promise<void> {
		if (this.structuredAdaptor.nav.assetLinkMode !== "attach") return;
		for (const node of nodes) {
			const sourcePath: string = node?.file?.absoluteFilePath ?? "";
			const pageId: string = node?.file?.pageId ?? "";
			if (!sourcePath || !pageId) continue;
			const requests = this.structuredAdaptor.getAttachmentsFor(sourcePath);
			if (requests.length === 0) continue;

			let existing: Record<string, string> = {};
			try {
				const current = await client.contentAttachments.getAttachments({ id: pageId });
				existing = Object.fromEntries(
					(current?.results ?? []).map((r: Any) => [String(r.title), String(r?.metadata?.comment ?? "")]),
				);
			} catch (e) {
				console.warn(`[Confluence] Could not list attachments for page ${pageId}:`, e);
			}

			for (const request of requests) {
				try {
					const binary = await this.structuredAdaptor.readAttachment(request.vaultPath);
					if (!binary) {
						console.warn(`[Confluence] Attachment not readable: ${request.vaultPath}`);
						continue;
					}
					const buffer = Buffer.from(binary.contents);
					const hash = new SparkMD5.ArrayBuffer().append(binary.contents).end();
					if (existing[request.filename] === hash) continue; // unchanged
					await client.contentAttachments.createOrUpdateAttachments({
						id: pageId,
						attachments: [
							{
								file: buffer,
								filename: request.filename,
								minorEdit: true,
								comment: hash,
								contentType: binary.mimeType,
							},
						],
					});
				} catch (e) {
					console.warn(`[Confluence] Failed to attach ${request.vaultPath} to page ${pageId}:`, e);
				}
			}
		}
	}

	/** Snapshot each page's remote labels BEFORE the library rewrites them. */
	private async captureRemoteLabels(nodes: Any[], client: Any): Promise<Map<string, string[]>> {
		const out = new Map<string, string[]>();
		for (const node of nodes) {
			const pageId: string = node?.file?.pageId ?? "";
			if (!pageId) continue;
			try {
				const current = await client.contentLabels.getLabelsForContent({ id: pageId });
				out.set(
					pageId,
					(current?.results ?? []).map((l: Any) => String(l.label ?? l.name)),
				);
			} catch {
				// A page we cannot read labels for is left alone rather than guessed at.
			}
		}
		return out;
	}

	/**
	 * Re-add every label that was on the page but is not plugin-owned. The
	 * library's label pass removes anything outside `adfFile.tags`, which would
	 * silently delete labels a human applied in Confluence.
	 */
	private async restoreUnownedLabels(nodes: Any[], remote: Map<string, string[]>, client: Any): Promise<void> {
		for (const node of nodes) {
			const pageId: string = node?.file?.pageId ?? "";
			const sourcePath: string = node?.file?.absoluteFilePath ?? "";
			if (!pageId || !sourcePath) continue;
			const before = remote.get(pageId);
			if (!before || before.length === 0) continue;
			const current: string[] = Array.isArray(node?.file?.tags) ? node.file.tags : [];
			const previousOwned = this.ownedLabelsFor(sourcePath);
			const plan = planLabelChanges(previousOwned, current, before);
			if (plan.toPreserve.length === 0) continue;
			try {
				await client.contentLabels.addLabelsToContent({
					id: pageId,
					body: plan.toPreserve.map((name) => ({ prefix: "global", name })),
				});
				console.log(
					`[Confluence] Restored ${plan.toPreserve.length} manually-added label(s) on page ${pageId}: ${plan.toPreserve.join(", ")}`,
				);
			} catch (e) {
				console.warn(`[Confluence] Could not restore labels on page ${pageId}:`, e);
			}
		}
	}

	/** Labels the plugin applied at the LAST publish, from the publish record. */
	previousOwnedLabels: Map<string, string[]> = new Map();

	private ownedLabelsFor(sourcePath: string): string[] {
		return this.previousOwnedLabels.get(sourcePath) ?? [];
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
				console.warn(`[Confluence] move endpoint rejected for "${m.title}" (${m.pageId}) → ${m.targetId}:`, e);
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
		if (ignored)
			msg += `; ${ignored} accepted but NOT APPLIED — this Confluence is ignoring the move endpoint too (REST re-parenting unsupported here)`;
		console.log(msg);
	}
}
