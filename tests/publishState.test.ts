import { test } from "node:test";
import assert from "node:assert/strict";

import { detectOrphans, exceedsRemovalCap, PublishRecord } from "../src/publishState";

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
