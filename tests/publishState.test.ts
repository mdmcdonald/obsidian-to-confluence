import { test } from "node:test";
import assert from "node:assert/strict";

import { detectOrphans, exceedsRemovalCap, planLabelChanges, PublishRecord } from "../src/publishState";

const rec = (pageId: string, hash = "h"): PublishRecord => ({ pageId, hash });

test("deleted note → its page is orphaned and pruned", () => {
	const records = { "a.md": rec("1"), "b.md": rec("2") };
	const { kept, orphanPageIds } = detectOrphans(records, new Set(["a.md"]));
	assert.deepEqual(kept, { "a.md": rec("1") });
	assert.deepEqual(orphanPageIds, ["2"]);
});

test("moved note (same pageId, new path) is NOT orphaned", () => {
	// note moved old.md → new.md; connie-page-id travels, so new.md has pageId 1
	const records = { "old.md": rec("1"), "new.md": rec("1") };
	const { kept, orphanPageIds } = detectOrphans(records, new Set(["new.md"]));
	assert.deepEqual(orphanPageIds, []); // pageId 1 still live under new.md
	assert.deepEqual(kept, { "new.md": rec("1") }); // old.md pruned, new.md kept
});

test("all current paths are kept", () => {
	const records = { "a.md": rec("1"), "b.md": rec("2") };
	const { kept, orphanPageIds } = detectOrphans(records, new Set(["a.md", "b.md"]));
	assert.deepEqual(kept, records);
	assert.deepEqual(orphanPageIds, []);
});

test("first run / empty records → nothing orphaned", () => {
	const { kept, orphanPageIds } = detectOrphans({}, new Set(["a.md", "b.md"]));
	assert.deepEqual(kept, {});
	assert.deepEqual(orphanPageIds, []);
});

test("multiple distinct orphans, deduped", () => {
	const records = {
		"a.md": rec("1"),
		"b.md": rec("2"),
		"c.md": rec("2"), // duplicate pageId (defensive)
		"d.md": rec("3"),
	};
	const { orphanPageIds } = detectOrphans(records, new Set());
	assert.deepEqual(new Set(orphanPageIds), new Set(["1", "2", "3"]));
	assert.equal(orphanPageIds.length, 3, "deduped");
});

test("record without a pageId is pruned but not archived", () => {
	const records: Record<string, PublishRecord> = { "a.md": { pageId: "", hash: "h" } };
	const { kept, orphanPageIds } = detectOrphans(records, new Set());
	assert.deepEqual(kept, {});
	assert.deepEqual(orphanPageIds, []);
});

test("removal cap blocks a suspiciously large orphan set", () => {
	assert.equal(exceedsRemovalCap(26, 25), true);
	assert.equal(exceedsRemovalCap(25, 25), false); // exactly at the cap is allowed
	assert.equal(exceedsRemovalCap(1, 25), false);
	assert.equal(exceedsRemovalCap(1000, 0), false); // 0 disables the cap
});

test("delete + move together", () => {
	// b moved to b2 (pageId 2 stays live); c deleted (pageId 3 orphaned)
	const records = { "a.md": rec("1"), "b.md": rec("2"), "b2.md": rec("2"), "c.md": rec("3") };
	const { kept, orphanPageIds } = detectOrphans(records, new Set(["a.md", "b2.md"]));
	assert.deepEqual(orphanPageIds, ["3"]);
	assert.deepEqual(kept, { "a.md": rec("1"), "b2.md": rec("2") });
});

// ---------------------------------------------------------------------------
// F8 — label ownership
//
// The rule the whole feature turns on: the plugin only ever removes labels it
// applied itself. Anything a human added in Confluence survives a republish.
// ---------------------------------------------------------------------------

test("a first publish adds its labels and removes nothing", () => {
	const plan = planLabelChanges(undefined, ["radar", "type-hub"], []);
	assert.deepEqual(plan.toAdd, ["radar", "type-hub"]);
	assert.deepEqual(plan.toRemove, []);
	assert.deepEqual(plan.toPreserve, []);
});

test("a label the plugin owned and no longer derives is removed", () => {
	const plan = planLabelChanges(["radar", "legacy"], ["radar"], ["radar", "legacy"]);
	assert.deepEqual(plan.toAdd, []);
	assert.deepEqual(plan.toRemove, ["legacy"]);
});

test("a label a human added in Confluence is never removed, only preserved", () => {
	const plan = planLabelChanges(["radar"], ["radar"], ["radar", "added-by-hand"]);
	assert.deepEqual(plan.toRemove, []);
	assert.deepEqual(plan.toPreserve, ["added-by-hand"]);
	assert.deepEqual(plan.toAdd, []);
});

test("a manual label the plugin now also derives is not listed for preservation", () => {
	// It is in `current`, so the normal publish path applies it anyway.
	const plan = planLabelChanges(["radar"], ["radar", "added-by-hand"], ["radar", "added-by-hand"]);
	assert.deepEqual(plan.toPreserve, []);
	assert.deepEqual(plan.toAdd, []);
	assert.deepEqual(plan.toRemove, []);
});

test("a label the plugin owned but that is already gone remotely is not re-removed", () => {
	const plan = planLabelChanges(["radar", "legacy"], ["radar"], ["radar"]);
	assert.deepEqual(plan.toRemove, []);
});

test("a derived label missing remotely is added", () => {
	const plan = planLabelChanges(["radar"], ["radar", "new-one"], ["radar"]);
	assert.deepEqual(plan.toAdd, ["new-one"]);
});

test("an unchanged republish issues no label operations at all", () => {
	const labels = ["radar", "type-hub"];
	const plan = planLabelChanges(labels, labels, labels);
	assert.deepEqual(plan.toAdd, []);
	assert.deepEqual(plan.toRemove, []);
	assert.deepEqual(plan.toPreserve, []);
});

test("a page the plugin has never touched keeps every remote label", () => {
	const plan = planLabelChanges(undefined, [], ["theirs-1", "theirs-2"]);
	assert.deepEqual(plan.toRemove, []);
	assert.deepEqual(plan.toPreserve, ["theirs-1", "theirs-2"]);
});

test("the publish record carries the labels the plugin applied", () => {
	const record: PublishRecord = { pageId: "1", hash: "h", labels: ["radar"] };
	assert.deepEqual(record.labels, ["radar"]);
	// A record written before F8 has no labels, which reads as "owns nothing".
	const legacy: PublishRecord = { pageId: "1", hash: "h" };
	assert.deepEqual(planLabelChanges(legacy.labels, [], ["theirs"]).toRemove, []);
});
