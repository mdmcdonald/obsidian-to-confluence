/**
 * Title pre-flight: keep a page-title collision from failing a whole batch.
 *
 * Confluence titles are unique per space. When a note has no `connie-page-id`
 * the library finds its page by title, and if that title already belongs to a
 * page OUTSIDE the configured parent's subtree it throws — from inside the
 * tree-creation pass, before any page in the batch is written and before the
 * per-file error handling exists. The whole batch fails, every file in it
 * reports the same message, and because folder pages are re-resolved by title
 * in every batch, one colliding folder title fails every batch that touches it.
 *
 * This module runs the same lookup first, over the batch tree, and prunes the
 * colliding node (and its subtree, which cannot be created under a page we
 * cannot create). The rest of the batch publishes; the pruned notes are
 * reported individually with the page that holds the title.
 *
 * Pure apart from the injected lookup, so the pruning is unit-testable.
 */
import type { FolderTreeNode } from "./folderTree";

/** What a by-title search found: the page and its ancestor chain (root-first). */
export interface TitleLookupResult {
	id: string;
	ancestorIds: string[];
}

/** Search the space for a page with this exact title; undefined when absent. */
export type TitleLookup = (title: string) => Promise<TitleLookupResult | undefined>;

export type CollisionKind =
	/** The holder is outside the parent's subtree; the library would throw. */
	| "outside-tree"
	/** The holder is inside the tree but was published from a DIFFERENT note; the library would silently overwrite it. */
	| "owned-by-other-note";

export interface TitleCollision {
	/** Vault path of the note (or the folder's synthetic path) that wanted the title. */
	sourcePath: string;
	title: string;
	/** The page that already holds the title. */
	pageId: string;
	kind: CollisionKind;
	/** For "owned-by-other-note": the vault path that page was published from. */
	holderSource?: string;
}

export interface SkippedFile {
	sourcePath: string;
	reason: string;
}

export interface PreflightResult {
	/** The tree with colliding subtrees removed. */
	tree: FolderTreeNode;
	collisions: TitleCollision[];
	/** Every real note dropped from this batch, with a reason for the results modal. */
	skipped: SkippedFile[];
}

export interface PreflightOptions {
	lookup: TitleLookup;
	/** The configured parent page id; a holder is "inside" when this is an ancestor. */
	topPageId: string;
	/**
	 * Which vault path a Confluence page was last published from (the plugin's
	 * publish record), so a title that resolves to ANOTHER note's page — inside
	 * the tree, where the library would reuse it without complaint — is caught
	 * before that note's content is overwritten and its page moved.
	 */
	ownerOf?: (pageId: string) => string | undefined;
	/**
	 * Optional cache shared across batches: title → lookup result (null = absent).
	 * Folder titles recur in every batch; without this each is searched N times.
	 */
	cache?: Map<string, TitleLookupResult | null>;
}

/** A synthetic folder carrier ("__folder__/Title") is not a note the user can act on. */
function isRealNote(file: { absoluteFilePath?: unknown } | undefined): boolean {
	return typeof file?.absoluteFilePath === "string" && !file.absoluteFilePath.startsWith("__folder__/");
}

function collectNotes(node: FolderTreeNode, out: string[]): void {
	if (isRealNote(node.file)) out.push(node.file.absoluteFilePath);
	for (const child of node.children) collectNotes(child, out);
}

export function collisionReason(title: string, pageId: string): string {
	return (
		`Title "${title}" is already used by Confluence page ${pageId}, which is not under the configured parent page. ` +
		`Confluence titles are unique per space: rename this note (or its folder's landing title), or move or delete that page.`
	);
}

export function ownedByOtherReason(title: string, pageId: string, holderSource: string): string {
	return (
		`Title "${title}" is already used by Confluence page ${pageId}, which was published from "${holderSource}". ` +
		`Publishing this note would overwrite that page and move it here. Give one of the two a different title.`
	);
}

/** A synthetic folder carrier is not another note: a folder gaining a landing file keeps its page. */
function isSyntheticOwner(path: string | undefined): boolean {
	return typeof path === "string" && path.startsWith("__folder__/");
}

export function descendantReason(folderTitle: string, pageId: string): string {
	return `Not published: its folder page "${folderTitle}" cannot be created — that title is already used by Confluence page ${pageId} outside the publish tree.`;
}

/**
 * Walk the batch tree and drop every node whose title is held by a page
 * outside the parent's subtree. The root is never checked — it IS the parent
 * page. A node that already knows its page id is found by id, not title, so it
 * is never a collision either.
 */
export async function pruneTitleCollisions(tree: FolderTreeNode, options: PreflightOptions): Promise<PreflightResult> {
	const { lookup, topPageId, ownerOf } = options;
	const cache = options.cache ?? new Map<string, TitleLookupResult | null>();
	const collisions: TitleCollision[] = [];
	const skipped: SkippedFile[] = [];

	const find = async (title: string): Promise<TitleLookupResult | undefined> => {
		if (cache.has(title)) return cache.get(title) ?? undefined;
		const found = await lookup(title);
		cache.set(title, found ?? null);
		return found;
	};

	const visit = async (node: FolderTreeNode, isRoot: boolean): Promise<FolderTreeNode | null> => {
		if (!isRoot) {
			const file = node.file;
			const title = typeof file?.pageTitle === "string" ? file.pageTitle : "";
			const knowsPage = file?.pageId !== undefined && file?.pageId !== null && file?.pageId !== "";
			if (title && !knowsPage && file?.contentType !== "blogpost") {
				const found = await find(title);
				if (found) {
					const insideTree = found.ancestorIds.some((id) => String(id) === String(topPageId));
					const sourcePath = typeof file?.absoluteFilePath === "string" ? file.absoluteFilePath : title;
					let collision: TitleCollision | undefined;
					if (!insideTree) {
						collision = { sourcePath, title, pageId: found.id, kind: "outside-tree" };
					} else if (ownerOf) {
						const owner = ownerOf(found.id);
						if (owner && owner !== sourcePath && !isSyntheticOwner(owner) && !isSyntheticOwner(sourcePath)) {
							collision = { sourcePath, title, pageId: found.id, kind: "owned-by-other-note", holderSource: owner };
						}
					}
					if (collision) {
						collisions.push(collision);
						const own =
							collision.kind === "outside-tree"
								? collisionReason(title, found.id)
								: ownedByOtherReason(title, found.id, collision.holderSource ?? "");
						if (isRealNote(file)) skipped.push({ sourcePath, reason: own });
						const descendants: string[] = [];
						for (const child of node.children) collectNotes(child, descendants);
						for (const path of descendants) {
							skipped.push({ sourcePath: path, reason: descendantReason(title, found.id) });
						}
						return null;
					}
				}
			}
		}
		const children: FolderTreeNode[] = [];
		for (const child of node.children) {
			const kept = await visit(child, false);
			if (kept) children.push(kept);
		}
		return { ...node, children };
	};

	const pruned = (await visit(tree, true)) as FolderTreeNode;
	return { tree: pruned, collisions, skipped };
}
