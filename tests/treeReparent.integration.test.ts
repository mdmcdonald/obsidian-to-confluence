import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveStructure, computeFolderTitles, buildTree } from "../src/folderTree";
import { ensureAllFilesExistInConfluence } from "@markdown-confluence/lib/dist/TreeConfluence.js";
import { isEqual } from "@markdown-confluence/lib/dist/isEqual.js";

const ADF = { type: "doc", version: 1, content: [] };
const adfStr = JSON.stringify(ADF);

// In-memory Confluence simulating the BUGGED end state: pages exist FLAT under
// the parent. We want to see whether publishing our (correct, nested) tree
// computes a re-parent.
function makeClient(pages: Record<string, any>) {
	let n = 0;
	const calls: any = { create: [], update: [] };
	const toContent = (p: any) => ({
		id: p.id,
		title: p.title,
		type: p.type ?? "page",
		space: { key: "SP" },
		version: { number: 1, by: { accountId: "ME" } },
		body: { atlas_doc_format: { value: p.bodyAdf ?? adfStr } },
		ancestors: p.ancestors ?? [],
	});
	return {
		calls,
		client: {
			users: { getCurrentUser: async () => ({ accountId: "ME" }) },
			content: {
				getContentById: async ({ id }: any) => {
					if (!pages[id]) {
						const e: any = new Error("404");
						e.response = { status: 404 };
						throw e;
					}
					return toContent(pages[id]);
				},
				getContent: async ({ title }: any) => {
					const m = Object.values(pages).find((p: any) => p.title === title);
					return { results: m ? [toContent(m)] : [] };
				},
				createContent: async (req: any) => {
					const id = `NEW${++n}`;
					pages[id] = { id, title: req.title, type: req.type, ancestors: req.ancestors ?? [], bodyAdf: req.body.atlas_doc_format.value };
					calls.create.push({ id, title: req.title, ancestors: req.ancestors });
					return toContent(pages[id]);
				},
				updateContent: async (req: any) => {
					calls.update.push({ id: req.id, ancestors: req.ancestors });
					if (pages[req.id]) pages[req.id].ancestors = req.ancestors;
					return toContent(pages[req.id] ?? { id: req.id, title: req.title, ancestors: req.ancestors });
				},
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
const settings: any = { confluenceBaseUrl: "https://wiki.example", folderToPublish: "" };

test("INTEGRATION: our tree re-parents pre-existing flat pages via the library", async () => {
	// Our correct, nested tree for the single deep file, rooted at vault.
	const ALL = ["FolderWithNoFiles/FolderWithFiles/File.md"];
	const s = deriveStructure(ALL, "");
	const folderTitle = computeFolderTitles(s.folders, ["File"]);
	const tree = buildTree(
		[{ absoluteFilePath: "FolderWithNoFiles/FolderWithFiles/File.md", pageTitle: "File", fileName: "File.md", frontmatter: {}, tags: [], pageId: "FILE", dontChangeParentPageId: false, contentType: "page", blogPostDate: undefined } as any],
		{
			commonPath: s.commonPath,
			folderTitle,
			indexFileByFolder: s.indexFileByFolder,
			folderFileAdf: { ...ADF },
			convertFile: (mf: any) => ({ folderName: "", absoluteFilePath: mf.absoluteFilePath, fileName: mf.fileName, contents: { ...ADF }, pageTitle: mf.pageTitle, frontmatter: {}, tags: [], pageId: mf.pageId, dontChangeParentPageId: false, contentType: "page", blogPostDate: undefined }),
		},
	);

	// Pre-existing FLAT state (the bug): both folders + the file directly under PARENT.
	const pages: Record<string, any> = {
		PARENT: { id: "PARENT", title: "Parent", ancestors: [] },
		FWNF: { id: "FWNF", title: "FolderWithNoFiles", ancestors: [{ id: "PARENT" }] },
		FWF: { id: "FWF", title: "FolderWithFiles", ancestors: [{ id: "PARENT" }] },
		FILE: { id: "FILE", title: "File", ancestors: [{ id: "PARENT" }] },
	};
	const { client } = makeClient(pages);

	const published: any[] = await ensureAllFilesExistInConfluence(
		client as any, adaptor, tree as any, "SP", "PARENT", "PARENT", settings,
	);

	const byTitle = (t: string) => published.find((p) => p.file.pageTitle === t);
	const fwnf = byTitle("FolderWithNoFiles");
	const fwf = byTitle("FolderWithFiles");
	const file = byTitle("File");

	assert.ok(fwnf && fwf && file, "all three nodes present");

	// DESIRED chains should be nested.
	assert.deepEqual(fwnf.ancestors, ["PARENT"], "FolderWithNoFiles under PARENT");
	assert.deepEqual(fwf.ancestors, ["PARENT", "FWNF"], "FolderWithFiles under FolderWithNoFiles");
	assert.deepEqual(file.ancestors, ["PARENT", "FWNF", "FWF"], "File under FolderWithFiles");

	// Replicate updatePageContent's re-parent decision for the page that must MOVE
	// (FolderWithFiles: currently under PARENT, should move under FolderWithNoFiles).
	const existingPageDetails = { title: "FolderWithFiles", type: "page", ancestors: fwf.existingPageData.ancestors };
	const newPageDetails = { title: fwf.file.pageTitle, type: fwf.file.contentType, ancestors: fwf.ancestors.map((a: string) => ({ id: a })) };
	assert.equal(isEqual(existingPageDetails, newPageDetails), false, "re-parent SHOULD be detected (PUT) for FolderWithFiles");
});
