import { test } from "node:test";
import assert from "node:assert/strict";

import {
	collisionReason,
	descendantReason,
	pruneTitleCollisions,
	type TitleLookup,
	type TitleLookupResult,
} from "../src/titlePreflight";
import type { FolderTreeNode } from "../src/folderTree";

const TOP = "TOP";

const leaf = (path: string, title: string, pageId?: string): FolderTreeNode => ({
	name: path.split("/").pop()!,
	children: [],
	file: { absoluteFilePath: path, pageTitle: title, pageId, contentType: "page" },
});
const folder = (title: string, children: FolderTreeNode[], pageId?: string): FolderTreeNode => ({
	name: title,
	children,
	file: { absoluteFilePath: `__folder__/${title}`, pageTitle: title, pageId, contentType: "page" },
});
const root = (children: FolderTreeNode[]): FolderTreeNode => ({
	name: "r",
	children,
	file: { absoluteFilePath: "__folder__/r", pageTitle: "Parent", contentType: "page" },
});

/** A lookup over a fixed space: title → holder, counting calls. */
function space(holders: Record<string, TitleLookupResult>) {
	const calls: string[] = [];
	const lookup: TitleLookup = async (title) => {
		calls.push(title);
		return holders[title];
	};
	return { lookup, calls };
}

const inside = (id: string): TitleLookupResult => ({ id, ancestorIds: ["HOME", TOP] });
const outside = (id: string): TitleLookupResult => ({ id, ancestorIds: ["HOME", "ELSEWHERE"] });

// ---------------------------------------------------------------------------

test("a title held by a page outside the tree is pruned and reported", async () => {
	const s = space({ Radar: outside("999") });
	const tree = root([folder("Radar", [leaf("r/radar/x.md", "X")]), leaf("r/other.md", "Other")]);
	const result = await pruneTitleCollisions(tree, { lookup: s.lookup, topPageId: TOP });

	assert.deepEqual(result.collisions, [
		{ sourcePath: "__folder__/Radar", title: "Radar", pageId: "999", kind: "outside-tree" },
	]);
	// The folder and its subtree are gone; the unrelated sibling survives.
	assert.deepEqual(
		result.tree.children.map((c) => c.name),
		["other.md"],
	);
});

test("a colliding folder's descendants are reported with the folder's reason, the folder itself is not a note", async () => {
	const s = space({ Radar: outside("999") });
	const tree = root([folder("Radar", [leaf("r/radar/x.md", "X"), folder("Sub", [leaf("r/radar/sub/y.md", "Y")])])]);
	const result = await pruneTitleCollisions(tree, { lookup: s.lookup, topPageId: TOP });

	assert.deepEqual(
		result.skipped.map((k) => k.sourcePath),
		["r/radar/x.md", "r/radar/sub/y.md"],
	);
	for (const k of result.skipped) assert.equal(k.reason, descendantReason("Radar", "999"));
	// Descendants are never looked up — their parent cannot exist.
	assert.deepEqual(s.calls, ["Radar"]);
});

test("a colliding note reports its own reason", async () => {
	const s = space({ "Start Here": outside("42") });
	const tree = root([leaf("r/index.md", "Start Here")]);
	const result = await pruneTitleCollisions(tree, { lookup: s.lookup, topPageId: TOP });
	assert.deepEqual(result.skipped, [{ sourcePath: "r/index.md", reason: collisionReason("Start Here", "42") }]);
	assert.match(collisionReason("Start Here", "42"), /page 42/);
	assert.match(collisionReason("Start Here", "42"), /rename/);
});

test("a title held by a page INSIDE the tree is not a collision", async () => {
	const s = space({ Radar: inside("123") });
	const tree = root([folder("Radar", [leaf("r/radar/x.md", "X")])]);
	const result = await pruneTitleCollisions(tree, { lookup: s.lookup, topPageId: TOP });
	assert.deepEqual(result.collisions, []);
	assert.deepEqual(result.skipped, []);
	assert.equal(result.tree.children.length, 1);
	assert.equal(result.tree.children[0].children.length, 1);
});

test("a title with no page at all is not a collision", async () => {
	const s = space({});
	const tree = root([leaf("r/new.md", "Brand New")]);
	const result = await pruneTitleCollisions(tree, { lookup: s.lookup, topPageId: TOP });
	assert.deepEqual(result.collisions, []);
	assert.equal(result.tree.children.length, 1);
});

test("a node that already knows its page id is never looked up", async () => {
	// The library finds it by id, which bypasses the title guard entirely.
	const s = space({ Radar: outside("999") });
	const tree = root([leaf("r/radar.md", "Radar", "555")]);
	const result = await pruneTitleCollisions(tree, { lookup: s.lookup, topPageId: TOP });
	assert.deepEqual(s.calls, []);
	assert.deepEqual(result.collisions, []);
});

test("the root carrier is never looked up — it is the parent page", async () => {
	const s = space({ Parent: outside("1") });
	const result = await pruneTitleCollisions(root([leaf("r/a.md", "A")]), { lookup: s.lookup, topPageId: TOP });
	assert.deepEqual(s.calls, ["A"]);
	assert.deepEqual(result.collisions, []);
});

test("the ancestor check tolerates numeric ids from the API", async () => {
	const s = space({ Radar: { id: "7", ancestorIds: [String(1), String(TOP)] } });
	const tree = root([folder("Radar", [])]);
	const result = await pruneTitleCollisions(tree, { lookup: s.lookup, topPageId: TOP });
	assert.deepEqual(result.collisions, []);
});

test("a shared cache means a recurring folder title is searched once across batches", async () => {
	const s = space({ Radar: inside("123"), Gone: outside("9") });
	const cache = new Map();
	const batch1 = root([folder("Radar", [leaf("r/radar/a.md", "A")]), folder("Gone", [leaf("r/gone/g.md", "G")])]);
	const batch2 = root([folder("Radar", [leaf("r/radar/b.md", "B")]), folder("Gone", [leaf("r/gone/h.md", "H")])]);

	const r1 = await pruneTitleCollisions(batch1, { lookup: s.lookup, topPageId: TOP, cache });
	const r2 = await pruneTitleCollisions(batch2, { lookup: s.lookup, topPageId: TOP, cache });

	// Radar, Gone, A, B — each title once; G and H are pruned descendants.
	assert.deepEqual([...s.calls].sort(), ["A", "B", "Gone", "Radar"]);
	assert.equal(r1.collisions.length, 1);
	assert.equal(r2.collisions.length, 1, "the cached collision still prunes in the next batch");
	assert.deepEqual(
		r2.tree.children.map((c) => c.name),
		["Radar"],
	);
});

test("a cached absence is not re-searched either", async () => {
	const s = space({});
	const cache = new Map();
	await pruneTitleCollisions(root([leaf("r/a.md", "A")]), { lookup: s.lookup, topPageId: TOP, cache });
	await pruneTitleCollisions(root([leaf("r/a.md", "A")]), { lookup: s.lookup, topPageId: TOP, cache });
	assert.deepEqual(s.calls, ["A"]);
});

test("the input tree is not mutated", async () => {
	const s = space({ Radar: outside("999") });
	const tree = root([folder("Radar", [leaf("r/radar/x.md", "X")]), leaf("r/other.md", "Other")]);
	const before = JSON.stringify(tree);
	await pruneTitleCollisions(tree, { lookup: s.lookup, topPageId: TOP });
	assert.equal(JSON.stringify(tree), before);
});

// ---------------------------------------------------------------------------
// Inside the tree, but somebody else's page
// ---------------------------------------------------------------------------

test("a title resolving to ANOTHER note's page inside the tree is a collision, not a reuse", async () => {
	// Two domains each have a "04_Nodes" folder. Radar's was published first;
	// left alone, the library would find it by title and write land's content
	// into it, then the move pass would drag it (children and all) under land.
	const s = space({ "04_Nodes": inside("777") });
	const owners = new Map([["777", "r/radar/architecture/04_Nodes/index.md"]]);
	const tree = root([leaf("r/land/architecture/04_Nodes/index.md", "04_Nodes")]);
	const result = await pruneTitleCollisions(tree, {
		lookup: s.lookup,
		topPageId: TOP,
		ownerOf: (id) => owners.get(id),
	});
	assert.deepEqual(result.collisions, [
		{
			sourcePath: "r/land/architecture/04_Nodes/index.md",
			title: "04_Nodes",
			pageId: "777",
			kind: "owned-by-other-note",
			holderSource: "r/radar/architecture/04_Nodes/index.md",
		},
	]);
	assert.equal(result.tree.children.length, 0);
	assert.match(result.skipped[0].reason, /published from "r\/radar\/architecture\/04_Nodes\/index\.md"/);
	assert.match(result.skipped[0].reason, /would overwrite/);
});

test("a title resolving to this note's OWN page (by record) is fine", async () => {
	const s = space({ "04_Nodes": inside("777") });
	const owners = new Map([["777", "r/radar/architecture/04_Nodes/index.md"]]);
	const tree = root([leaf("r/radar/architecture/04_Nodes/index.md", "04_Nodes")]);
	const result = await pruneTitleCollisions(tree, { lookup: s.lookup, topPageId: TOP, ownerOf: (id) => owners.get(id) });
	assert.deepEqual(result.collisions, []);
	assert.equal(result.tree.children.length, 1);
});

test("a page with no recorded owner is reused as before", async () => {
	const s = space({ Radar: inside("123") });
	const tree = root([leaf("r/radar.md", "Radar")]);
	const result = await pruneTitleCollisions(tree, { lookup: s.lookup, topPageId: TOP, ownerOf: () => undefined });
	assert.deepEqual(result.collisions, []);
});

test("a folder that gains a landing file keeps its placeholder page", async () => {
	// The page was created as a synthetic "__folder__/Guide" carrier; now
	// Guide/index.md exists and is promoted. Same folder, same page.
	const s = space({ Guide: inside("55") });
	const owners = new Map([["55", "__folder__/Guide"]]);
	const tree = root([{ ...leaf("r/Guide/index.md", "Guide"), children: [leaf("r/Guide/topic.md", "Topic")] }]);
	const result = await pruneTitleCollisions(tree, { lookup: s.lookup, topPageId: TOP, ownerOf: (id) => owners.get(id) });
	assert.deepEqual(result.collisions, []);
});

test("a placeholder folder never claims another placeholder's page as a collision", async () => {
	// Two scoped publishes with segment titles both produce "__folder__/04_Nodes".
	// The synthetic path carries no folder identity, so this cannot be told
	// apart from a republish of the same folder; it is left to the user's title
	// policy (landing-mode titles are domain-specific) rather than guessed.
	const s = space({ "04_Nodes": inside("777") });
	const owners = new Map([["777", "__folder__/04_Nodes"]]);
	const tree = root([folder("04_Nodes", [])]);
	const result = await pruneTitleCollisions(tree, { lookup: s.lookup, topPageId: TOP, ownerOf: (id) => owners.get(id) });
	assert.deepEqual(result.collisions, []);
});

test("outside-tree still wins over ownership, and reports as such", async () => {
	const s = space({ Radar: outside("999") });
	const owners = new Map([["999", "r/radar.md"]]);
	const tree = root([leaf("r/radar.md", "Radar")]);
	const result = await pruneTitleCollisions(tree, { lookup: s.lookup, topPageId: TOP, ownerOf: (id) => owners.get(id) });
	assert.equal(result.collisions[0].kind, "outside-tree");
});
