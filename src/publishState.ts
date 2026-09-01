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
	/**
	 * The labels the PLUGIN applied at the last publish. Anything on the remote
	 * page outside this set was added by a human in Confluence and must survive
	 * a republish (F8). Absent on records written before label ownership existed.
	 */
	labels?: string[];
}

export interface OrphanResult {
	/** Records to keep (every currently-publishable path). */
	kept: Record<string, PublishRecord>;
	/** Distinct pageIds whose source note is gone and may be reported or trashed. */
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
export function detectOrphans(records: Record<string, PublishRecord>, currentPaths: ReadonlySet<string>): OrphanResult {
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

// ---------------------------------------------------------------------------
// Label ownership (F8)
// ---------------------------------------------------------------------------

export interface LabelChangePlan {
	/** Labels the plugin must add to the remote page. */
	toAdd: string[];
	/**
	 * Labels the plugin must remove: ones IT applied last time and no longer
	 * derives. A label a human added in Confluence is never in `previousOwned`,
	 * so it is never removed.
	 */
	toRemove: string[];
	/**
	 * Labels present remotely that the plugin does not own and must therefore
	 * restore if the bundled library strips them during its own label pass.
	 */
	toPreserve: string[];
}

/**
 * Diff the label sets for one page.
 *
 * `previousOwned` is what the plugin applied at the last publish (from the
 * publish record), `current` is what it derives now, `remote` is what the page
 * actually carries. Ownership is what makes a republish non-destructive: the
 * plugin only ever removes labels it put there itself.
 *
 * Pure, so the (destructive) removal logic is unit-testable in isolation.
 */
export function planLabelChanges(
	previousOwned: readonly string[] | undefined,
	current: readonly string[],
	remote: readonly string[],
): LabelChangePlan {
	const owned = new Set(previousOwned ?? []);
	const now = new Set(current);
	const there = new Set(remote);

	const toAdd = current.filter((l) => !there.has(l));
	const toRemove = [...owned].filter((l) => !now.has(l) && there.has(l));
	const toPreserve = remote.filter((l) => !owned.has(l) && !now.has(l));

	return { toAdd, toRemove, toPreserve };
}
