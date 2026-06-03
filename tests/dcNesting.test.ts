import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveStructure, computeFolderTitles, buildTree } from "../src/folderTree";
import { planReparents } from "../src/reparent";
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
		ancestors: p.parent === PARENT ? [{ id: PARENT }] : [{ id: PARENT }, { id: p.parent }],
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
