import { test } from "node:test";
import assert from "node:assert/strict";

import {
	commonPathOf,
	relativeTo,
	splitPath,
	deriveStructure,
	computeFolderTitles,
	buildTree,
} from "../src/folderTree";

// ---------------------------------------------------------------------------
// path helpers
// ---------------------------------------------------------------------------

test("commonPathOf returns the deepest shared segment prefix", () => {
	assert.equal(commonPathOf(["a/b/c.md", "a/b/d.md"]), "a/b");
	assert.equal(commonPathOf(["a/b/c.md", "a/x/d.md"]), "a");
	assert.equal(commonPathOf(["a/c.md", "b/d.md"]), "");
	assert.equal(commonPathOf(["only/one/file.md"]), "only/one/file.md");
	assert.equal(commonPathOf([]), "");
});

test("relativeTo strips a base prefix", () => {
	assert.equal(relativeTo("a/b", "a/b/c/d.md"), "c/d.md");
	assert.equal(relativeTo("", "a/b.md"), "a/b.md");
	assert.equal(relativeTo("a/b", "a/b/f.md"), "f.md");
	assert.deepEqual(splitPath("/a//b/"), ["a", "b"]);
});

// ---------------------------------------------------------------------------
// deriveStructure
// ---------------------------------------------------------------------------

test("deriveStructure finds folders, READMEs, and per-file folder", () => {
	const s = deriveStructure([
		"root/A/readme.md",
		"root/A/x.md",
		"root/B/sub/y.md",
		"root/top.md",
	]);
	assert.equal(s.commonPath, "root");
	assert.deepEqual(s.folders.map((f) => f.relPath).sort(), ["A", "B", "B/sub"]);
	// README in A is its landing file
	assert.equal(s.indexFileByFolder.get("A"), "root/A/readme.md");
	// B/sub has no readme/index/eponymous → no landing
	assert.equal(s.indexFileByFolder.has("B/sub"), false);
	// per-file folder
	assert.equal(s.folderOfFile.get("root/A/x.md"), "A");
	assert.equal(s.folderOfFile.get("root/top.md"), ""); // directly at root
});

test("a file at the common root is never promoted (would be lost)", () => {
	const s = deriveStructure(["root/readme.md", "root/A/x.md"]);
	assert.equal(s.commonPath, "root");
	assert.equal(s.indexFileByFolder.has(""), false); // root readme not a landing
});

test("an eponymous file (folder-named) is the folder landing page", () => {
	// sibling "Other" keeps the common path at "root" so "Radar" is a real folder
	const s = deriveStructure(["root/Radar/Radar.md", "root/Radar/x.md", "root/Other/z.md"]);
	assert.equal(s.commonPath, "root");
	assert.equal(s.indexFileByFolder.get("Radar"), "root/Radar/Radar.md");
});

// ---------------------------------------------------------------------------
// computeFolderTitles
// ---------------------------------------------------------------------------

test("folder titles are parent-qualified on collision and avoid file titles", () => {
	const s = deriveStructure([
		"r/radar/architecture/x.md",
		"r/ew/architecture/y.md",
		"r/standalone.md",
	]);
	const titles = computeFolderTitles(s.folders, ["standalone", "ew"]);
	const vals = [...titles.values()];
	// both "architecture" folders are qualified symmetrically (neither bare)
	assert.equal(titles.get("radar/architecture"), "radar / architecture");
	assert.equal(titles.get("ew/architecture"), "ew / architecture");
	assert.ok(!vals.includes("architecture"));
	// all unique
	assert.equal(new Set(vals).size, vals.length);
	// "ew" folder collides with the seeded file title "ew" → must differ
	assert.notEqual(titles.get("ew"), "ew");
});

test("a uniquely-named folder keeps its bare name (stable when siblings change)", () => {
	const s = deriveStructure(["r/onlyone/x.md", "r/other/y.md"]);
	const titles = computeFolderTitles(s.folders, []);
	assert.equal(titles.get("onlyone"), "onlyone");
});

test("folder titles fall back to a hash when fully qualified still collides", () => {
	const s = deriveStructure(["a/dup/f.md", "b/dup/g.md"]);
	// seed BOTH possible qualifications as taken to force the hash branch
	const titles = computeFolderTitles(s.folders, ["dup", "a / dup", "b / dup", "a", "b"]);
	for (const v of titles.values()) {
		if (v.startsWith("dup")) assert.match(v, /^dup \([0-9a-f]{6}\)/);
	}
	assert.equal(new Set(titles.values()).size, titles.size);
});

// ---------------------------------------------------------------------------
// buildTree
// ---------------------------------------------------------------------------

const convertFile = (mf: { pageTitle: string; absoluteFilePath: string }) => ({
	...mf,
	contents: { type: "doc" },
});
const folderFileAdf = { type: "doc", folder: true };
const mk = (p: string) => ({
	pageTitle: p.split("/").pop()!.replace(/\.md$/, ""),
	absoluteFilePath: p,
	fileName: p.split("/").pop()!,
	frontmatter: {},
	tags: [],
	pageId: undefined,
	dontChangeParentPageId: false,
	contentType: "page",
});

function ctxFor(allPaths: string[]) {
	const s = deriveStructure(allPaths);
	const folderTitle = computeFolderTitles(
		s.folders,
		allPaths.map((p) => p.split("/").pop()!.replace(/\.md$/, "")),
	);
	return {
		commonPath: s.commonPath,
		folderTitle,
		indexFileByFolder: s.indexFileByFolder,
		folderFileAdf,
		convertFile,
	};
}

// Collect (title, depth, isFolder, srcPath) for every non-root node.
function flatten(node: any, depth = 0, isRoot = true, out: any[] = []) {
	if (!isRoot) {
		const isFolder = !!node.file?.contents?.folder;
		out.push({ title: node.file?.pageTitle, depth, isFolder, src: node.file?.absoluteFilePath });
	}
	for (const c of node.children) flatten(c, depth + 1, false, out);
	return out;
}

test("buildTree preserves full nesting for a single deep file (the bug)", () => {
	const ALL = [
		"content/domain/radar/architecture/L2-06.md",
		"content/domain/radar/architecture/L2-39.md",
		"content/domain/ew/architecture/L2-06.md",
	];
	const ctx = ctxFor(ALL);
	// Publish ONLY the single deep file (worst-case batch).
	const tree = buildTree([mk("content/domain/radar/architecture/L2-06.md")], ctx);
	const titles = flatten(tree).map((n) => n.title);
	// radar, an architecture folder, and the file — full chain, not collapsed
	assert.ok(titles.includes("radar"), JSON.stringify(titles));
	assert.ok(titles.some((t) => /architecture/.test(t)), JSON.stringify(titles));
	assert.ok(titles.includes("L2-06"), JSON.stringify(titles));
});

test("buildTree promotes a README to the folder page (titled by folder)", () => {
	// sibling keeps common path at "root" so "Guide" is an intermediate folder
	const ALL = ["root/Guide/README.md", "root/Guide/topic.md", "root/other.md"];
	const ctx = ctxFor(ALL);
	const tree = buildTree(ALL.map(mk), ctx);
	const nodes = flatten(tree);
	const guide = nodes.find((n) => n.title === "Guide");
	assert.ok(guide, JSON.stringify(nodes));
	// the README is the folder page (real source path, not a placeholder)
	assert.equal(guide.src, "root/Guide/README.md");
	// no separate "README" page
	assert.equal(nodes.some((n) => n.title === "README"), false);
	// topic is a child file under the folder
	assert.ok(nodes.some((n) => n.title === "topic" && n.src === "root/Guide/topic.md"));
});

test("buildTree is consistent across batches (same folder → same title)", () => {
	const ALL = [
		"r/a/architecture/x.md",
		"r/b/architecture/y.md",
	];
	const ctx = ctxFor(ALL);
	const t1 = flatten(buildTree([mk("r/a/architecture/x.md")], ctx)).find((n) => n.isFolder && /architecture/.test(n.title));
	const t2 = flatten(buildTree(ALL.map(mk), ctx)).find((n) => !n.isFolder && n.src === "r/a/architecture/x.md");
	// the architecture folder under "a" has a stable title regardless of batch
	const aArch = flatten(buildTree(ALL.map(mk), ctx)).find((n) => n.isFolder && n.src?.startsWith("__folder__") === false);
	void t2; void aArch;
	assert.ok(t1, "folder present in single-file batch");
	// recompute the a/architecture title directly and confirm it matches both builds
	const want = ctx.folderTitle.get("a/architecture");
	const single = flatten(buildTree([mk("r/a/architecture/x.md")], ctx)).find((n) => n.title === want);
	const full = flatten(buildTree(ALL.map(mk), ctx)).find((n) => n.title === want);
	assert.ok(single && full, `title "${want}" present in both batch builds`);
});

// ---------------------------------------------------------------------------
// Rooting at the publish scope (folderToPublish) — the "two separate trees" fix
// ---------------------------------------------------------------------------

function ctxRooted(allPaths: string[], root: string) {
	const s = deriveStructure(allPaths, root);
	const folderTitle = computeFolderTitles(
		s.folders,
		allPaths.map((p) => p.split("/").pop()!.replace(/\.md$/, "")),
	);
	return { commonPath: s.commonPath, folderTitle, indexFileByFolder: s.indexFileByFolder, folderFileAdf, convertFile };
}

// Full "Title/Title/..." paths of every non-root node (folder or file).
function titlePaths(node: any, prefix = "", isRoot = true, out: string[] = []): string[] {
	const here = isRoot ? "" : prefix ? `${prefix}/${node.file?.pageTitle}` : node.file?.pageTitle;
	if (!isRoot) out.push(here);
	for (const c of node.children) titlePaths(c, here, false, out);
	return out;
}

test("deriveStructure roots at the publish scope, preserving a shared parent folder (the split bug)", () => {
	const ALL = [
		"FolderWithNoFiles/FolderWithFiles/File.md",
		"FolderWithNoFiles/AnotherFolder/Other.md",
	];
	// Old behaviour (root = file-set common path): FolderWithNoFiles collapses
	// onto the parent and its subfolders become top-level siblings.
	const collapsed = deriveStructure(ALL);
	assert.equal(collapsed.commonPath, "FolderWithNoFiles");
	assert.equal(collapsed.folders.some((f) => f.relPath === "FolderWithFiles"), true);

	// Fixed (root = vault, folderToPublish ""): FolderWithNoFiles is a real folder.
	const s = deriveStructure(ALL, "");
	assert.equal(s.commonPath, "");
	assert.deepEqual(s.folders.map((f) => f.relPath).sort(), [
		"FolderWithNoFiles",
		"FolderWithNoFiles/AnotherFolder",
		"FolderWithNoFiles/FolderWithFiles",
	]);

	const paths = titlePaths(buildTree(ALL.map(mk), ctxRooted(ALL, "")));
	assert.ok(paths.includes("FolderWithNoFiles/FolderWithFiles/File"), JSON.stringify(paths));
	assert.ok(paths.includes("FolderWithNoFiles/AnotherFolder/Other"), JSON.stringify(paths));
	// FolderWithFiles must NOT be hoisted to a top-level tree.
	assert.equal(paths.includes("FolderWithFiles"), false, JSON.stringify(paths));
});

test("deriveStructure preserves folders for a single deep file when rooted at the vault", () => {
	const ALL = ["FolderWithNoFiles/FolderWithFiles/File.md"];
	// Old behaviour swallowed even the filename into the common path → no folders.
	assert.equal(deriveStructure(ALL).commonPath, "FolderWithNoFiles/FolderWithFiles/File.md");
	assert.deepEqual(deriveStructure(ALL).folders, []);

	const s = deriveStructure(ALL, "");
	assert.deepEqual(s.folders.map((f) => f.relPath), [
		"FolderWithNoFiles",
		"FolderWithNoFiles/FolderWithFiles",
	]);
	assert.ok(titlePaths(buildTree(ALL.map(mk), ctxRooted(ALL, ""))).includes("FolderWithNoFiles/FolderWithFiles/File"));
});

test("a fixed publish-scope root keeps a folder's level stable as the file set changes", () => {
	const folderOf = (s: ReturnType<typeof deriveStructure>) =>
		s.folders.map((f) => f.relPath).filter((p) => p.startsWith("FolderWithNoFiles")).sort();
	const a = deriveStructure(["FolderWithNoFiles/FolderWithFiles/File.md"], "");
	const b = deriveStructure(["TopNote.md", "FolderWithNoFiles/FolderWithFiles/File.md"], "");
	// The shared subtree is identical regardless of the unrelated TopNote — so a
	// folder created in one run is never orphaned by a level shift in the next.
	assert.deepEqual(folderOf(a), folderOf(b));
	assert.deepEqual(folderOf(a), ["FolderWithNoFiles", "FolderWithNoFiles/FolderWithFiles"]);
});

test("files under the publish-scope folder nest under the parent (the scope folder is not a page)", () => {
	const ALL = ["Confluence Pages/Guide/topic.md", "Confluence Pages/intro.md"];
	const s = deriveStructure(ALL, "Confluence Pages");
	assert.equal(s.commonPath, "Confluence Pages");
	assert.deepEqual(s.folders.map((f) => f.relPath), ["Guide"]);
	assert.equal(s.folderOfFile.get("Confluence Pages/intro.md"), "");
	const paths = titlePaths(buildTree(ALL.map(mk), ctxRooted(ALL, "Confluence Pages")));
	assert.ok(paths.includes("Guide/topic"), JSON.stringify(paths));
	assert.ok(paths.includes("intro"), JSON.stringify(paths));
	assert.equal(paths.some((p) => p.startsWith("Confluence Pages")), false, JSON.stringify(paths));
});

test("root is normalised: '/', '' and trailing slashes behave sensibly", () => {
	const ALL = ["A/B/x.md"];
	assert.equal(deriveStructure(ALL, "/").commonPath, "");
	assert.equal(deriveStructure(ALL, "").commonPath, "");
	assert.equal(deriveStructure(ALL, "A/").commonPath, "A");
	assert.equal(deriveStructure(ALL, "A").commonPath, "A");
});
