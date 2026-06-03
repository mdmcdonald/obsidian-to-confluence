// Plans the re-parenting needed after a publish.
//
// On Confluence Data Center the `ancestors` field is unreliable for setting a
// page's parent — observed on martin's instance to be ignored on UPDATE and on
// CREATE — so folder-under-folder doesn't nest: child folders land flat under the
// configured parent page, both for already-existing pages AND brand-new ones. The
// reliable DC fix is the dedicated move endpoint (`PUT /content/{id}/move/append/
// {targetId}`). This module compares each page's ACTUAL current parent (what
// Confluence saved) against its INTENDED parent and returns the moves required,
// so it corrects the hierarchy regardless of whether create/update honoured
// `ancestors`.
//
// Pure (no library/Obsidian deps) so it is unit/harness-testable.

export interface ReparentNode {
	file?: { pageId?: string; pageTitle?: string };
	/** Intended ancestor chain (page ids, root-first); last element is the direct parent. */
	ancestors?: string[];
	/** The page's CURRENT ancestors in Confluence (root-first), as returned by the API. */
	existingPageData?: { ancestors?: { id?: string }[] };
}

export interface ReparentMove {
	pageId: string;
	targetId: string;
	title: string;
}

/**
 * Return the moves needed so every page sits under its intended parent. A node is
 * moved only when its current direct parent differs from the intended one (so
 * already-correct pages — including top-level pages already under the parent — are
 * skipped, and a steady-state republish issues no moves). Nodes without a resolved
 * pageId or intended parent (e.g. the root carrier) are skipped.
 */
export function planReparents(nodes: ReparentNode[]): ReparentMove[] {
	const moves: ReparentMove[] = [];
	for (const node of nodes) {
		const chain = node.ancestors ?? [];
		const pageId = node.file?.pageId;
		if (chain.length === 0 || !pageId) continue;
		const intended = chain[chain.length - 1];
		if (!intended) continue;
		const existing = node.existingPageData?.ancestors ?? [];
		const current = existing.length ? existing[existing.length - 1]?.id : undefined;
		if (String(current) === String(intended)) continue; // already correctly parented
		moves.push({ pageId, targetId: intended, title: node.file?.pageTitle ?? pageId });
	}
	return moves;
}
