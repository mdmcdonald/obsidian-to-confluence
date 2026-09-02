import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveStructure, computeFolderTitles, buildTree } from "../src/folderTree";
import { planReparents } from "../src/reparent";
import { pruneTitleCollisions } from "../src/titlePreflight";
import { ensureAllFilesExistInConfluence } from "@markdown-confluence/lib/dist/TreeConfluence.js";

// End-to-end harness: runs the user's folder structure through the REAL library
// tree-resolution (ensureAllFilesExistInConfluence) against a mock that models
// Confluence Data Center — `ancestors` honoured on CREATE, ignored on UPDATE — and
// applies the SHIPPING re-parent plan (planReparents) via a modelled move endpoint.
// Guards the "folder-under-folder" bug: a folder page that already exists flat must
// be re-parented under its intended parent.

const ADF = { type: "doc", version: 1, content: [] };
const adfStr = JSON.stringify(ADF);
const PARENT = "PARENT"; // configured Confluence parent page id

// `honorCreate` models whether the target Confluence applies `ancestors` on CREATE.
// martin's Data Center does NOT (fresh folder-under-folder lands flat under the
// parent), so the default models that worst case. Either way `ancestors` is ignored
// on UPDATE. The move-endpoint re-parent pass must produce correct nesting regardless.
function mockClient(preexisting: Record<string, { title: string; parent: string }> = {}, honorCreate = false) {
	let n = 0;
	const pages: Record<string, { id: string; title: string; parent: string }> = {};
	for (const [id, p] of Object.entries(preexisting)) pages[id] = { id, ...p };
	const byTitle = (t: string) => Object.values(pages).find((p) => p.title === t);
	const toContent = (p: { id: string; title: string; parent: string }) => ({
		id: p.id,
		title: p.title,
		type: "page",
		space: { key: "SP" },
		version: { number: 1, by: { accountId: "ME" } },
		body: { atlas_doc_format: { value: adfStr } },
		// Root-first chain, walked from the real parent links so a page under a
		// DIFFERENT parent does not pretend to be under PARENT.
		ancestors: (() => {
			const chain: { id: string }[] = [];
			let cur: string | undefined = p.parent;
			while (cur && pages[cur]) {
				chain.unshift({ id: cur });
				cur = pages[cur].parent;
			}
			if (cur) chain.unshift({ id: cur });
			return chain;
		})(),
	});
	return {
		pages,
		client: {
			users: { getCurrentUser: async () => ({ accountId: "ME" }) },
			content: {
				getContentById: async ({ id }: any) => {
					if (!pages[id]) { const e: any = new Error("404"); e.response = { status: 404 }; throw e; }
					return toContent(pages[id]);
				},
				getContent: async ({ title }: any) => {
					const m = byTitle(title);
					return { results: m ? [toContent(m)] : [] };
				},
				createContent: async (req: any) => {
					const id = `ID${++n}`;
					const requested = req.ancestors?.[req.ancestors.length - 1]?.id ?? PARENT;
					// DC that ignores create-ancestors drops the new page flat under the parent.
					const parent = honorCreate ? requested : PARENT;
					pages[id] = { id, title: req.title, parent };
					return toContent(pages[id]);
				},
				updateContent: async (_req: any) => ({}), // DC ignores `ancestors` on UPDATE (no re-parent)
			},
			contentLabels: {
				getLabelsForContent: async () => ({ results: [] }),
				addLabelsToContent: async () => ({}),
				removeLabelFromContentUsingQueryParameter: async () => ({}),
			},
			contentAttachments: { getAttachments: async () => ({ results: [] }) },
		},
	};
}

const adaptor: any = { updateMarkdownValues: async () => {} };
const settings: any = { confluenceBaseUrl: "https://wiki.example", folderToPublish: "TopFolder" };

function mkFile(p: string) {
	return {
		absoluteFilePath: p,
		pageTitle: p.split("/").pop()!.replace(/\.md$/, ""),
		fileName: p.split("/").pop()!,
		frontmatter: {},
		tags: [],
		pageId: undefined,
		dontChangeParentPageId: false,
		contentType: "page",
		blogPostDate: undefined,
	};
}

async function run(paths: string[], preexisting: Record<string, { title: string; parent: string }> = {}, honorCreate = false) {
	const structure = deriveStructure(paths);
	const folderTitle = computeFolderTitles(structure.folders, paths.map((p) => p.split("/").pop()!.replace(/\.md$/, "")));
	const files = paths.map(mkFile);
	const tree = buildTree(files, {
		commonPath: structure.commonPath,
		folderTitle,
		indexFileByFolder: structure.indexFileByFolder,
		folderFileAdf: { ...ADF },
		convertFile: (mf: any) => ({ folderName: "", absoluteFilePath: mf.absoluteFilePath, fileName: mf.fileName, contents: { ...ADF }, pageTitle: mf.pageTitle, frontmatter: {}, tags: [], pageId: mf.pageId, dontChangeParentPageId: false, contentType: "page", blogPostDate: undefined }),
	});
	const mc = mockClient(preexisting, honorCreate);
	const published: any[] = await ensureAllFilesExistInConfluence(mc.client as any, adaptor, tree as any, "SP", PARENT, PARENT, settings);
	// Apply the shipping re-parent plan, modelling the move endpoint as re-parenting.
	const moves = planReparents(published);
	for (const m of moves) if (mc.pages[m.pageId]) mc.pages[m.pageId].parent = m.targetId;
	return { mc, published, moves };
}

const PATHS = [
	"TopFolder/Folder1/File1.md",
	"TopFolder/Folder2/File2.md",
	"TopFolder/Folder3/Folder4/File3.md",
];

const idOf = (mc: any, title: string) => Object.keys(mc.pages).find((k) => mc.pages[k].title === title);
const parentOf = (mc: any, title: string) => { const id = idOf(mc, title); return id ? mc.pages[id].parent : undefined; };

test("FRESH publish on a DC that ignores create-ancestors: folders land flat, the move pass nests them", async () => {
	// martin's case: brand-new folders, but DC drops every created page flat under
	// the parent — so folder-under-folder does NOT nest on create. The move pass
	// must re-home everything to its intended parent.
	const { mc, moves } = await run(PATHS); // honorCreate=false (default)
	// Every page that isn't a direct child of the parent landed flat and needed a move.
	assert.deepEqual(
		new Set(moves.map((m) => m.title)),
		new Set(["File1", "File2", "Folder4", "File3"]),
		"the 4 non-top-level pages are re-parented",
	);
	// Final hierarchy is fully nested, including folder-under-folder.
	assert.equal(parentOf(mc, "Folder1"), PARENT);
	assert.equal(parentOf(mc, "File1"), idOf(mc, "Folder1"));
	assert.equal(parentOf(mc, "Folder3"), PARENT);
	assert.equal(parentOf(mc, "Folder4"), idOf(mc, "Folder3"), "Folder4 (folder-under-folder) ends up under Folder3");
	assert.equal(parentOf(mc, "File3"), idOf(mc, "Folder4"));
});

test("on a DC that honours create-ancestors, a fresh publish nests with no moves needed", async () => {
	const { mc, moves } = await run(PATHS, {}, /* honorCreate */ true);
	assert.equal(parentOf(mc, "Folder4"), idOf(mc, "Folder3"));
	assert.equal(moves.length, 0, "nothing to move when create-ancestors are honoured");
});

test("steady state: republish over an ALREADY-nested tree issues no moves (no churn)", async () => {
	// All pages already exist, correctly nested → adopted by title, nothing to move.
	const nested = {
		EF1: { title: "Folder1", parent: PARENT }, Efile1: { title: "File1", parent: "EF1" },
		EF2: { title: "Folder2", parent: PARENT }, Efile2: { title: "File2", parent: "EF2" },
		EF3: { title: "Folder3", parent: PARENT },
		EF4: { title: "Folder4", parent: "EF3" }, Efile3: { title: "File3", parent: "EF4" },
	};
	const { moves } = await run(PATHS, nested);
	assert.equal(moves.length, 0, "no re-parenting when the hierarchy is already correct");
});

// --- pure planReparents edge cases ---------------------------------------------
test("planReparents: skips root carrier, unresolved pages, and already-correct pages", () => {
	const moves = planReparents([
		{ file: { pageId: "P", pageTitle: "root" }, ancestors: [] },              // root carrier (no chain)
		{ file: { pageTitle: "unresolved" }, ancestors: ["X", "Y"] },              // no pageId
		{ file: { pageId: "A", pageTitle: "ok" }, ancestors: ["TOP", "B"], existingPageData: { ancestors: [{ id: "TOP" }, { id: "B" }] } }, // correct
		{ file: { pageId: "C", pageTitle: "move-me" }, ancestors: ["TOP", "D"], existingPageData: { ancestors: [{ id: "TOP" }] } },          // flat → move under D
	]);
	assert.deepEqual(moves, [{ pageId: "C", targetId: "D", title: "move-me" }]);
});

// --- F7: the root landing must never be moved ----------------------------------

test("F7: promoting the root landing plans no move for the parent page itself", async () => {
	// With publishRootLanding on, the publish root's index note becomes the body
	// of the CONFIGURED PARENT page. That page is not ours to re-parent: it lives
	// wherever the user put it, and a move would tear it out of their space.
	const PATHS_WITH_ROOT = ["TopFolder/index.md", ...PATHS];
	const structure = deriveStructure(PATHS_WITH_ROOT);
	assert.equal(structure.rootLandingFile, "TopFolder/index.md");

	const folderTitle = computeFolderTitles(
		structure.folders,
		PATHS_WITH_ROOT.map((p) => p.split("/").pop()!.replace(/\.md$/, "")),
	);
	const files = PATHS_WITH_ROOT.map(mkFile);
	const tree = buildTree(files, {
		commonPath: structure.commonPath,
		folderTitle,
		indexFileByFolder: structure.indexFileByFolder,
		folderFileAdf: { ...ADF },
		convertFile: (mf: any) => ({
			folderName: "",
			absoluteFilePath: mf.absoluteFilePath,
			fileName: mf.fileName,
			contents: { ...ADF },
			pageTitle: mf.pageTitle,
			frontmatter: {},
			tags: [],
			pageId: mf.pageId,
			dontChangeParentPageId: false,
			contentType: "page",
			blogPostDate: undefined,
		}),
		rootLandingFile: "TopFolder/index.md",
		rootPageTitle: "Knowledge Base",
	});

	// The root carrier now holds the landing note under the parent's own title.
	assert.equal((tree as any).file.absoluteFilePath, "TopFolder/index.md");
	assert.equal((tree as any).file.pageTitle, "Knowledge Base");

	const mc = mockClient({}, false);
	const published: any[] = await ensureAllFilesExistInConfluence(
		mc.client as any,
		adaptor,
		tree as any,
		"SP",
		PARENT,
		PARENT,
		settings,
	);
	const moves = planReparents(published);

	// No move targets the parent page, and the landing note never became a page
	// of its own to be moved.
	assert.equal(
		moves.some((m) => m.pageId === PARENT),
		false,
		JSON.stringify(moves),
	);
	assert.equal(
		moves.some((m) => m.title === "index" || m.title === "Knowledge Base"),
		false,
		JSON.stringify(moves),
	);
	// The rest of the tree is re-parented exactly as it is without a root landing.
	assert.deepEqual(new Set(moves.map((m) => m.title)), new Set(["File1", "File2", "Folder4", "File3"]));
});

test("F7: a root node carrying the parent id is skipped by the re-parent plan", () => {
	// The root carrier is published with the parent's own pageId and no intended
	// ancestor chain, which is what keeps it out of every move plan.
	const moves = planReparents([
		{ file: { pageId: PARENT, pageTitle: "Knowledge Base" }, ancestors: [] },
		{
			file: { pageId: "CHILD", pageTitle: "A child" },
			ancestors: [PARENT],
			existingPageData: { ancestors: [] },
		},
	]);
	assert.deepEqual(moves, [{ pageId: "CHILD", targetId: PARENT, title: "A child" }]);
});

// --- title pre-flight: a collision must not fail the batch --------------------

test("a title held outside the tree used to abort the whole batch; pre-flight isolates it", async () => {
	// A page titled "Folder1" already exists under a DIFFERENT parent.
	const stray = { STRAY: { title: "Folder1", parent: "OTHER_PARENT" } };

	// Without the pre-flight, the library throws from tree creation and nothing
	// in the batch is published.
	await assert.rejects(() => run(PATHS, stray), /Folder1 is trying to overwrite a page outside the page tree/);

	// With it, the colliding subtree is dropped and the rest publishes and nests.
	const structure = deriveStructure(PATHS);
	const folderTitle = computeFolderTitles(structure.folders, PATHS.map((p) => p.split("/").pop()!.replace(/\.md$/, "")));
	const tree = buildTree(PATHS.map(mkFile), {
		commonPath: structure.commonPath,
		folderTitle,
		indexFileByFolder: structure.indexFileByFolder,
		folderFileAdf: { ...ADF },
		convertFile: (mf: any) => ({
			folderName: "",
			absoluteFilePath: mf.absoluteFilePath,
			fileName: mf.fileName,
			contents: { ...ADF },
			pageTitle: mf.pageTitle,
			frontmatter: {},
			tags: [],
			pageId: mf.pageId,
			dontChangeParentPageId: false,
			contentType: "page",
			blogPostDate: undefined,
		}),
	});
	const mc = mockClient(stray, false);
	const lookup = async (title: string) => {
		const r = await mc.client.content.getContent({ title });
		const page = r.results[0];
		return page ? { id: page.id, ancestorIds: page.ancestors.map((a: any) => String(a.id)) } : undefined;
	};
	const preflight = await pruneTitleCollisions(tree, { lookup, topPageId: PARENT });

	assert.deepEqual(
		preflight.collisions.map((c) => [c.title, c.pageId]),
		[["Folder1", "STRAY"]],
	);
	assert.deepEqual(
		preflight.skipped.map((s) => s.sourcePath),
		["TopFolder/Folder1/File1.md"],
	);

	const published: any[] = await ensureAllFilesExistInConfluence(
		mc.client as any,
		adaptor,
		preflight.tree as any,
		"SP",
		PARENT,
		PARENT,
		settings,
	);
	const moves = planReparents(published);
	for (const m of moves) if (mc.pages[m.pageId]) mc.pages[m.pageId].parent = m.targetId;

	// Everything else was created and nested; the stray page was left alone.
	assert.equal(parentOf(mc, "Folder2"), PARENT);
	assert.equal(parentOf(mc, "File2"), idOf(mc, "Folder2"));
	assert.equal(parentOf(mc, "Folder4"), idOf(mc, "Folder3"));
	assert.equal(parentOf(mc, "File3"), idOf(mc, "Folder4"));
	assert.equal(mc.pages.STRAY.parent, "OTHER_PARENT");
	assert.equal(idOf(mc, "File1"), undefined, "the colliding folder's child was not created flat somewhere");
});
