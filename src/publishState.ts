/**
 * Pure helpers for the per-note publish record that backs skip-unchanged and
 * deletion detection. Kept free of Obsidian/Confluence APIs so the (destructive)
 * orphan logic can be unit-tested in isolation.
 */

export interface PublishRecord {
	/** Confluence page id this note was last published to. */
	pageId: string;
	/** Hash of the rendered content at last publish (skip-unchanged). */
	hash: string;
}

export interface OrphanResult {
	/** Records to keep (every currently-publishable path). */
	kept: Record<string, PublishRecord>;
	/** Distinct pageIds whose source note is gone and should be archived/trashed. */
	orphanPageIds: string[];
}

/**
 * Diff the merged publish records against the set of currently-publishable
 * paths. A record whose path is no longer publishable is pruned; its pageId is
 * an orphan UNLESS the same pageId is still used by another current path — i.e.
 * the note was moved/renamed (its connie-page-id travels with it), not deleted.
 * Orphan detection is therefore keyed on pageId, not path, and never returns a
 * pageId that is still live.
 */
export function detectOrphans(
	records: Record<string, PublishRecord>,
	currentPaths: ReadonlySet<string>,
): OrphanResult {
	const currentPageIds = new Set<string>();
	for (const p of currentPaths) {
		const rec = records[p];
		if (rec?.pageId) currentPageIds.add(rec.pageId);
	}

	const kept: Record<string, PublishRecord> = {};
	const orphans = new Set<string>();
	for (const [path, rec] of Object.entries(records)) {
		if (currentPaths.has(path)) {
			kept[path] = rec;
			continue;
		}
		if (rec.pageId && !currentPageIds.has(rec.pageId)) {
			orphans.add(rec.pageId);
		}
	}
	return { kept, orphanPageIds: [...orphans] };
}

/**
 * Safety valve for destructive deletion: a single publish removing more than
 * `cap` pages is treated as a likely misconfiguration (e.g. a "Folder to
 * publish" typo) and blocked. `cap` of 0 disables the limit.
 */
export function exceedsRemovalCap(orphanCount: number, cap: number): boolean {
	return cap > 0 && orphanCount > cap;
}
