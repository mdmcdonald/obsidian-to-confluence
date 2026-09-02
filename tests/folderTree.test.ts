import { test } from "node:test";
import assert from "node:assert/strict";

import {
	commonPathOf,
	isPathInFolder,
	relativeTo,
	splitPath,
	deriveStructure,
	computeFolderTitles,
	computeFolderTitlesDetailed,
	buildTree,
	childrenMacroNode,
	wantsChildrenMacro,
	titlesExcludingLandings,
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

test("publishing-folder checks are segment-aware and support vault root", () => {
	assert.equal(isPathInFolder("Docs/page.md", "Docs"), true);
	assert.equal(isPathInFolder("Docs/sub/page.md", "Docs/"), true);
	assert.equal(isPathInFolder("Docs-old/page.md", "Docs"), false);
	assert.equal(isPathInFolder("anything/page.md", ""), true);
	assert.equal(isPathInFolder("anything/page.md", "/"), true);
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
// F2 — deterministic landing selection
// ---------------------------------------------------------------------------

test("landing selection is index.md, then README.md, then the eponymous file", () => {
	// All three candidates present: index wins.
	const all = deriveStructure(["r/Guide/index.md", "r/Guide/README.md", "r/Guide/Guide.md", "r/other.md"]);
	assert.equal(all.indexFileByFolder.get("Guide"), "r/Guide/index.md");

	// README beats the eponymous file.
	const readme = deriveStructure(["r/Guide/README.md", "r/Guide/Guide.md", "r/other.md"]);
	assert.equal(readme.indexFileByFolder.get("Guide"), "r/Guide/README.md");

	// The eponymous file is the last resort.
	const epon = deriveStructure(["r/Guide/Guide.md", "r/Guide/topic.md", "r/other.md"]);
	assert.equal(epon.indexFileByFolder.get("Guide"), "r/Guide/Guide.md");
});

test("landing selection is case-insensitive", () => {
	const s = deriveStructure(["r/Guide/INDEX.md", "r/Guide/topic.md", "r/other.md"]);
	assert.equal(s.indexFileByFolder.get("Guide"), "r/Guide/INDEX.md");
	const s2 = deriveStructure(["r/Guide/ReadMe.md", "r/Guide/topic.md", "r/other.md"]);
	assert.equal(s2.indexFileByFolder.get("Guide"), "r/Guide/ReadMe.md");
});

test("a folder with several landing candidates is reported as a conflict", () => {
	const s = deriveStructure(["r/Guide/index.md", "r/Guide/README.md", "r/other.md"]);
	assert.equal(s.landingConflicts.length, 1);
	const conflict = s.landingConflicts[0];
	assert.equal(conflict.folderRelPath, "Guide");
	// Candidates are listed in priority order, so the report can mark the winner.
	assert.deepEqual(conflict.candidates, ["r/Guide/index.md", "r/Guide/README.md"]);
	// It still resolves deterministically rather than failing.
	assert.equal(s.indexFileByFolder.get("Guide"), "r/Guide/index.md");
});

test("a folder with exactly one candidate raises no conflict", () => {
	const s = deriveStructure(["r/Guide/index.md", "r/Guide/topic.md", "r/other.md"]);
	assert.deepEqual(s.landingConflicts, []);
});

// ---------------------------------------------------------------------------
// F2 — folder titles from landings and display names
// ---------------------------------------------------------------------------

/** A preferredTitle function backed by a plain map, for the tests below. */
const prefer =
	(map: Record<string, { title: string; origin: any }>) =>
	(relPath: string): { title: string; origin: any } | undefined =>
		map[relPath];

test("a folder takes its landing file's resolved title", () => {
	const s = deriveStructure(["r/radar/index.md", "r/radar/x.md", "r/other.md"]);
	const { titles, origins } = computeFolderTitlesDetailed(s.folders, [], {
		preferredTitle: prefer({ radar: { title: "Radar", origin: "landing" } }),
	});
	assert.equal(titles.get("radar"), "Radar");
	assert.equal(origins.get("radar"), "landing");
});

test("the display map is consulted by basename and by relative path, path winning", () => {
	const s = deriveStructure(["r/a/04_Nodes/x.md", "r/b/04_Nodes/y.md", "r/other.md"]);
	// The adaptor resolves path-before-basename; the map here models the result.
	const { titles, origins } = computeFolderTitlesDetailed(s.folders, [], {
		preferredTitle: prefer({
			"a/04_Nodes": { title: "Radar node catalogue", origin: "display-map" },
			"b/04_Nodes": { title: "EW node catalogue", origin: "display-map" },
		}),
	});
	assert.equal(titles.get("a/04_Nodes"), "Radar node catalogue");
	assert.equal(titles.get("b/04_Nodes"), "EW node catalogue");
	assert.equal(origins.get("a/04_Nodes"), "display-map");
});

test("two folders preferring the same title are both qualified by their parent", () => {
	const s = deriveStructure(["r/radar/layer/x.md", "r/ew/layer/y.md", "r/other.md"]);
	const preferred = {
		radar: { title: "Radar Architecture", origin: "landing" as const },
		ew: { title: "EW Architecture", origin: "landing" as const },
		"radar/layer": { title: "Operational functions (L1A)", origin: "landing" as const },
		"ew/layer": { title: "Operational functions (L1A)", origin: "landing" as const },
	};
	const { titles, origins } = computeFolderTitlesDetailed(s.folders, [], { preferredTitle: prefer(preferred) });

	// The qualifier is the parent page title a reader would click, not the segment.
	assert.equal(titles.get("radar/layer"), "Radar Architecture / Operational functions (L1A)");
	assert.equal(titles.get("ew/layer"), "EW Architecture / Operational functions (L1A)");
	assert.equal(origins.get("radar/layer"), "qualified");
	// The parents themselves are unique and keep their preferred titles.
	assert.equal(titles.get("radar"), "Radar Architecture");
	assert.equal(titles.get("ew"), "EW Architecture");
	// Every title in the tree is still unique.
	const vals = [...titles.values()];
	assert.equal(new Set(vals).size, vals.length);
});

test("a preferred title colliding with a file page title is qualified too", () => {
	const s = deriveStructure(["r/radar/layer/x.md", "r/other.md"]);
	const { titles } = computeFolderTitlesDetailed(s.folders, ["Operational functions"], {
		preferredTitle: prefer({
			radar: { title: "Radar", origin: "landing" },
			"radar/layer": { title: "Operational functions", origin: "landing" },
		}),
	});
	assert.notEqual(titles.get("radar/layer"), "Operational functions");
	assert.equal(titles.get("radar/layer"), "Radar / Operational functions");
});

test("segment mode reproduces the pre-existing titles exactly", () => {
	// No preferredTitle at all is the "segment" configuration.
	const s = deriveStructure(["r/radar/architecture/x.md", "r/ew/architecture/y.md", "r/standalone.md"]);
	const titles = computeFolderTitles(s.folders, ["standalone"]);
	assert.equal(titles.get("radar"), "radar");
	assert.equal(titles.get("ew"), "ew");
	assert.equal(titles.get("radar/architecture"), "radar / architecture");
	assert.equal(titles.get("ew/architecture"), "ew / architecture");
});

test("a preferredTitle returning undefined falls back to the folder name", () => {
	const s = deriveStructure(["r/named/x.md", "r/plain/y.md", "r/other.md"]);
	const { titles, origins } = computeFolderTitlesDetailed(s.folders, [], {
		preferredTitle: prefer({ named: { title: "A Real Name", origin: "landing" } }),
	});
	assert.equal(titles.get("named"), "A Real Name");
	assert.equal(titles.get("plain"), "plain");
	assert.equal(origins.get("plain"), "segment");
});

// ---------------------------------------------------------------------------
// F7 — root landing promoted into the parent page
// ---------------------------------------------------------------------------

test("deriveStructure identifies the root landing file but never makes it a folder", () => {
	const s = deriveStructure(["r/index.md", "r/a/x.md", "r/b/y.md"]);
	assert.equal(s.rootLandingFile, "r/index.md");
	// The root is not a folder page: only a and b are.
	assert.deepEqual(s.folders.map((f) => f.relPath).sort(), ["a", "b"]);
	assert.equal(s.indexFileByFolder.has(""), false);
});

test("the root landing is only promoted when buildTree is given it", () => {
	const ALL = ["r/index.md", "r/a/x.md"];
	const s = deriveStructure(ALL);
	const base = {
		commonPath: s.commonPath,
		folderTitle: computeFolderTitles(s.folders, []),
		indexFileByFolder: s.indexFileByFolder,
		folderFileAdf,
		convertFile,
	};

	// Setting off (no rootLandingFile): the note is an ordinary child page.
	const off = flatten(buildTree(ALL.map(mk), base));
	assert.ok(
		off.some((n) => n.src === "r/index.md" && !n.isFolder),
		JSON.stringify(off),
	);

	// Setting on: the note is consumed by the root carrier, not published again.
	const onTree: any = buildTree(ALL.map(mk), {
		...base,
		rootLandingFile: "r/index.md",
		rootPageTitle: "Knowledge Base",
	});
	const on = flatten(onTree);
	assert.equal(
		on.some((n) => n.src === "r/index.md"),
		false,
		JSON.stringify(on),
	);
	// The root carrier holds the converted landing content and the parent's title.
	assert.equal(onTree.file.absoluteFilePath, "r/index.md");
	assert.equal(onTree.file.pageTitle, "Knowledge Base");
	assert.deepEqual(onTree.file.contents, { type: "doc" });
});

test("without a root landing the root carrier stays the blank placeholder", () => {
	const ALL = ["r/a/x.md", "r/b/y.md"];
	const s = deriveStructure(ALL);
	const tree: any = buildTree(ALL.map(mk), {
		commonPath: s.commonPath,
		folderTitle: computeFolderTitles(s.folders, []),
		indexFileByFolder: s.indexFileByFolder,
		folderFileAdf,
		convertFile,
	});
	assert.deepEqual(tree.file.contents, folderFileAdf);
});

// ---------------------------------------------------------------------------
// F11 — Children Display macro
// ---------------------------------------------------------------------------

test("wantsChildrenMacro implements each mode", () => {
	// off: never.
	assert.equal(wantsChildrenMacro("off", true, true), false);
	assert.equal(wantsChildrenMacro("off", false, false), false);
	// all: always.
	assert.equal(wantsChildrenMacro("all", true, false), true);
	assert.equal(wantsChildrenMacro("all", false, false), true);
	// container-only: folders with no landing file.
	assert.equal(wantsChildrenMacro("container-only", false, false), true);
	assert.equal(wantsChildrenMacro("container-only", true, false), false);
	// generated-landings: only a landing marked generated.
	assert.equal(wantsChildrenMacro("generated-landings", true, true), true);
	assert.equal(wantsChildrenMacro("generated-landings", true, false), false);
	assert.equal(wantsChildrenMacro("generated-landings", false, true), false);
});

test("the children macro node is a depth-1, title-sorted inline extension", () => {
	const node: any = childrenMacroNode();
	const ext = node.content[0];
	assert.equal(ext.type, "inlineExtension");
	assert.equal(ext.attrs.extensionKey, "children");
	assert.equal(ext.attrs.extensionType, "com.atlassian.confluence.macro.core");
	assert.equal(ext.attrs.parameters.macroParams.depth.value, "1");
	assert.equal(ext.attrs.parameters.macroParams.sort.value, "title");
});

test("a generated landing gets the macro appended after its own body", () => {
	const ALL = ["r/Guide/index.md", "r/Guide/topic.md", "r/other.md"];
	const s = deriveStructure(ALL);
	const base = {
		commonPath: s.commonPath,
		folderTitle: computeFolderTitles(s.folders, []),
		indexFileByFolder: s.indexFileByFolder,
		folderFileAdf,
		// Model a converted document with real body content.
		convertFile: (mf: any) => ({ ...mf, contents: { type: "doc", content: [{ type: "paragraph" }] } }),
	};
	const files = ALL.map((p) => ({ ...mk(p), frontmatter: p.endsWith("index.md") ? { generated: true } : {} }));

	const withMacro: any = buildTree(files, { ...base, childrenMacro: "generated-landings" });
	const guide = withMacro.children.find((c: any) => c.name === "Guide");
	assert.equal(guide.file.contents.content.length, 2, "body paragraph plus the macro");
	assert.equal(guide.file.contents.content[1].content[0].attrs.extensionKey, "children");

	// A non-generated landing is untouched in this mode.
	const without: any = buildTree(ALL.map(mk), { ...base, childrenMacro: "generated-landings" });
	const guide2 = without.children.find((c: any) => c.name === "Guide");
	assert.equal(guide2.file.contents.content.length, 1);
});

test("container-only replaces the Page Tree placeholder on a landing-less folder", () => {
	const ALL = ["r/Bare/x.md", "r/other.md"];
	const s = deriveStructure(ALL);
	const tree: any = buildTree(ALL.map(mk), {
		commonPath: s.commonPath,
		folderTitle: computeFolderTitles(s.folders, []),
		indexFileByFolder: s.indexFileByFolder,
		folderFileAdf,
		convertFile,
		childrenMacro: "container-only",
	});
	const bare = tree.children.find((c: any) => c.name === "Bare");
	assert.notDeepEqual(bare.file.contents, folderFileAdf);
	assert.equal(bare.file.contents.content[0].content[0].attrs.extensionKey, "children");
});

test("the off mode leaves every folder page exactly as it is today", () => {
	const ALL = ["r/Bare/x.md", "r/Guide/index.md", "r/other.md"];
	const s = deriveStructure(ALL);
	const tree: any = buildTree(ALL.map(mk), {
		commonPath: s.commonPath,
		folderTitle: computeFolderTitles(s.folders, []),
		indexFileByFolder: s.indexFileByFolder,
		folderFileAdf,
		convertFile,
	});
	const bare = tree.children.find((c: any) => c.name === "Bare");
	assert.deepEqual(bare.file.contents, folderFileAdf);
	const guide = tree.children.find((c: any) => c.name === "Guide");
	assert.deepEqual(guide.file.contents, { type: "doc" });
});

// ---------------------------------------------------------------------------
// F2 — a landing file's title must not compete with its own folder
// ---------------------------------------------------------------------------

test("titlesExcludingLandings drops landing files and the promoted root landing", () => {
	const s = deriveStructure(["r/index.md", "r/radar/index.md", "r/radar/x.md", "r/other.md"]);
	const titles = new Map([
		["r/index.md", "Start Here"],
		["r/radar/index.md", "Radar"],
		["r/radar/x.md", "X"],
		["r/other.md", "Other"],
	]);
	assert.deepEqual(titlesExcludingLandings(titles, s).sort(), ["Other", "Start Here", "X"]);
	assert.deepEqual(titlesExcludingLandings(titles, s, ["r/index.md"]).sort(), ["Other", "X"]);
});

test("a folder titled from its landing keeps that title instead of colliding with itself", () => {
	// Reproduces the corpus: domain/index.md is titled "Domain Knowledge" and the
	// folder wants the same. Counting the landing as a file page hashed the folder.
	const s = deriveStructure(["r/domain/index.md", "r/domain/radar/index.md", "r/domain/radar/x.md", "r/other.md"]);
	const titles = new Map([
		["r/domain/index.md", "Domain Knowledge"],
		["r/domain/radar/index.md", "Radar"],
		["r/domain/radar/x.md", "X"],
		["r/other.md", "Other"],
	]);
	const preferred = (rel: string) => {
		const landing = s.indexFileByFolder.get(rel);
		const t = landing ? titles.get(landing) : undefined;
		return t ? { title: t, origin: "landing" as const } : undefined;
	};

	// The buggy input: every title, landings included.
	const buggy = computeFolderTitlesDetailed(s.folders, titles.values(), { preferredTitle: preferred });
	assert.match(buggy.titles.get("domain")!, /^Domain Knowledge \([0-9a-f]{6}\)$/);
	assert.equal(buggy.titles.get("domain/radar"), "Domain Knowledge / Radar");

	// The fixed input.
	const fixed = computeFolderTitlesDetailed(s.folders, titlesExcludingLandings(titles, s), {
		preferredTitle: preferred,
	});
	assert.equal(fixed.titles.get("domain"), "Domain Knowledge");
	assert.equal(fixed.titles.get("domain/radar"), "Radar");
	assert.equal(fixed.origins.get("domain"), "landing");
	assert.equal(fixed.origins.get("domain/radar"), "landing");
});

test("a NON-landing file with the folder's preferred title still forces qualification", () => {
	const s = deriveStructure(["r/domain/index.md", "r/domain/radar/index.md", "r/domain/radar/x.md", "r/radar-overview.md"]);
	const titles = new Map([
		["r/domain/index.md", "Domain Knowledge"],
		["r/domain/radar/index.md", "Radar"],
		["r/domain/radar/x.md", "X"],
		["r/radar-overview.md", "Radar"], // a real page, not a landing
	]);
	const preferred = (rel: string) => {
		const landing = s.indexFileByFolder.get(rel);
		const t = landing ? titles.get(landing) : undefined;
		return t ? { title: t, origin: "landing" as const } : undefined;
	};
	const { titles: out } = computeFolderTitlesDetailed(s.folders, titlesExcludingLandings(titles, s), {
		preferredTitle: preferred,
	});
	assert.equal(out.get("domain/radar"), "Domain Knowledge / Radar");
});

test("an eponymous landing no longer collides with its folder in segment mode", () => {
	// Guide/Guide.md is the landing; its basename equals the folder name. Before,
	// the folder was qualified against its own landing.
	const s = deriveStructure(["r/Guide/Guide.md", "r/Guide/topic.md", "r/other.md"]);
	const titles = new Map([
		["r/Guide/Guide.md", "Guide"],
		["r/Guide/topic.md", "topic"],
		["r/other.md", "other"],
	]);
	assert.equal(computeFolderTitles(s.folders, titlesExcludingLandings(titles, s)).get("Guide"), "Guide");
});
