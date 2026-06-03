/**
 * Folder-structure-preserving tree builder.
 *
 * The bundled @markdown-confluence/lib builds its Confluence page tree from
 * `findCommonPath()` of whatever file set a single `publisher.publish()` call
 * sees. Because we batch (and skip unchanged files), each call sees a SUBSET,
 * so the common prefix is deeper per call and the real folder hierarchy
 * collapses (see the user-reported bug). The library also titles folder
 * placeholder pages by their bare path segment, so same-named folders
 * (`architecture`, `knowledge`, `README`…) collide across the corpus.
 *
 * This module rebuilds the tree with:
 *   - a STABLE root = the configured publish scope (`folderToPublish`), which
 *     maps onto the Confluence parent page. This is fixed regardless of which
 *     files are publishable, so every batch — and every separate publish run —
 *     nests identically. (Rooting at the *common path of the file set* instead,
 *     as an earlier version did, was the bug: that prefix shifts as files are
 *     added/removed, collapsing shared folders onto the parent and hoisting
 *     their subfolders to the top — the "two separate trees" report.)
 *   - globally-unique, parent-qualified folder titles (so folders reconcile by
 *     title across batches instead of merging), and
 *   - README / index / eponymous file promotion to the folder's landing page.
 *
 * Pure and dependency-injected (the markdown→ADF conversion is passed in) so it
 * can be unit-tested without the library or Obsidian.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface FolderTreeNode {
	name: string;
	children: FolderTreeNode[];
	file?: Any; // LocalAdfFile once filled
}

// --- POSIX-style path helpers (Obsidian vault paths always use "/") ---------

export function splitPath(p: string): string[] {
	return p.split("/").filter((s) => s.length > 0);
}

/** Longest common leading SEGMENT prefix of the given paths (like the lib). */
export function commonPathOf(paths: string[]): string {
	if (paths.length === 0) return "";
	const parts = paths.map(splitPath);
	const first = parts[0];
	let len = first.length;
	for (let i = 1; i < parts.length; i++) {
		const p = parts[i];
		let k = 0;
		while (k < len && k < p.length && p[k] === first[k]) k++;
		len = k;
		if (len === 0) break;
	}
	return first.slice(0, len).join("/");
}

/** Path of `full` relative to directory `base` (both segment-aligned). */
export function relativeTo(base: string, full: string): string {
	const b = splitPath(base);
	const f = splitPath(full);
	let i = 0;
	while (i < b.length && i < f.length && b[i] === f[i]) i++;
	return f.slice(i).join("/");
}

function basename(relPath: string): string {
	const parts = splitPath(relPath);
	return parts[parts.length - 1] ?? "";
}

function stripExt(name: string): string {
	return name.replace(/\.md$/i, "");
}

// --- Structure derivation ---------------------------------------------------

export interface FolderInfo {
	relPath: string; // folder path relative to the common root, e.g. "radar/architecture"
	segments: string[]; // its path segments
	parentRel: string; // parent folder's relPath ("" = a top-level folder)
}

export interface DerivedStructure {
	/** The publish-scope root that maps onto the Confluence parent page; all
	 * structure is relative to it. "" = vault root (publish everything). */
	commonPath: string;
	/** All intermediate folders (relative to commonPath), parent-before-child. */
	folders: FolderInfo[];
	/** folderRelPath → the vault path of its README/index/eponymous landing file. */
	indexFileByFolder: Map<string, string>;
	/** vault file path → its containing folder's relPath ("" = directly at root). */
	folderOfFile: Map<string, string>;
}

const INDEX_BASENAMES = new Set(["index", "readme"]);

/**
 * Derive the folder hierarchy + per-folder landing file from the FULL set of
 * publishable file paths. Computed once over everything so the result is stable
 * regardless of which subset a batch publishes.
 *
 * `root` is the publish scope (the `folderToPublish` setting) that maps onto the
 * Confluence parent page; all structure is computed relative to it. It is
 * normalised (leading/trailing/empty segments stripped), so "", "/", and
 * "Confluence Pages/" all behave sensibly. Pass it explicitly in production —
 * the default (common path of the file set) is a convenience for tests and is
 * NOT set-stable (see the module header).
 */
export function deriveStructure(
	allFilePaths: string[],
	root: string = commonPathOf(allFilePaths),
): DerivedStructure {
	const commonPath = splitPath(root).join("/");
	const folders = new Map<string, FolderInfo>();
	const folderOfFile = new Map<string, string>();
	const filesInFolder = new Map<string, string[]>();

	const ensureFolder = (relPath: string) => {
		if (relPath === "" || folders.has(relPath)) return;
		const segments = splitPath(relPath);
		const parentRel = segments.slice(0, -1).join("/");
		ensureFolder(parentRel);
		folders.set(relPath, { relPath, segments, parentRel });
	};

	for (const fp of allFilePaths) {
		const rel = relativeTo(commonPath, fp); // e.g. "A/B/file.md" or "file.md"
		const parts = splitPath(rel);
		const folderRelPath = parts.slice(0, -1).join("/");
		ensureFolder(folderRelPath);
		folderOfFile.set(fp, folderRelPath);
		const arr = filesInFolder.get(folderRelPath) ?? [];
		arr.push(fp);
		filesInFolder.set(folderRelPath, arr);
	}

	// Identify each folder's landing file: README/index, else a file whose name
	// equals the folder name (eponymous). NOT applied to the root ("") — a file
	// at the common root maps onto the configured parent page and would be lost.
	const indexFileByFolder = new Map<string, string>();
	for (const [folderRelPath, files] of filesInFolder) {
		if (folderRelPath === "") continue;
		const folderName = basename(folderRelPath).toLowerCase();
		let pick: string | undefined;
		let eponymous: string | undefined;
		for (const fp of files) {
			const stem = stripExt(basename(fp)).toLowerCase();
			if (INDEX_BASENAMES.has(stem)) {
				pick = pick ?? fp;
			}
			if (stem === folderName) eponymous = eponymous ?? fp;
		}
		const landing = pick ?? eponymous;
		if (landing) indexFileByFolder.set(folderRelPath, landing);
	}

	// Order folders parent-before-child for deterministic title assignment.
	const ordered = [...folders.values()].sort((a, b) =>
		a.segments.length - b.segments.length || a.relPath.localeCompare(b.relPath),
	);

	return { commonPath, folders: ordered, indexFileByFolder, folderOfFile };
}

// --- Folder title assignment (parent-qualified, collision-safe) -------------

function hash6(s: string): string {
	// Small deterministic FNV-1a hash → 6 hex chars (no crypto dependency).
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

/**
 * Assign a unique title to every folder.
 *
 * A folder keeps its bare name ONLY if that name is globally unique (no other
 * folder and no file page uses it). Otherwise EVERY folder sharing the name is
 * parent-qualified ("Parent / Name", then "Grandparent / Parent / Name", …),
 * with a "Name (hash6)" fallback. Qualifying all colliding folders symmetrically
 * (rather than letting the first keep the bare name) keeps a folder's title
 * stable when an unrelated sibling is added or removed.
 */
export function computeFolderTitles(
	folders: FolderInfo[],
	takenTitles: Iterable<string>,
): Map<string, string> {
	const fileTitles = new Set<string>(takenTitles);
	// Count how many folders share each bare basename.
	const baseCount = new Map<string, number>();
	for (const f of folders) {
		const b = basename(f.relPath);
		baseCount.set(b, (baseCount.get(b) ?? 0) + 1);
	}

	const taken = new Set<string>(fileTitles);
	const result = new Map<string, string>();
	for (const f of folders) {
		const base = basename(f.relPath);
		const mustQualify = (baseCount.get(base) ?? 0) > 1 || fileTitles.has(base);
		let chosen: string | undefined;
		const startDepth = mustQualify ? 2 : 1;
		for (let depth = startDepth; depth <= f.segments.length; depth++) {
			const candidate = f.segments.slice(f.segments.length - depth).join(" / ");
			if (!taken.has(candidate)) {
				chosen = candidate;
				break;
			}
		}
		// If we forced qualification but the folder has only one segment (a
		// top-level folder colliding with a file title), fall through to hash.
		if (chosen === undefined && !mustQualify) chosen = base;
		if (chosen === undefined) {
			chosen = `${base} (${hash6(f.relPath)})`;
			while (taken.has(chosen)) chosen = `${chosen}_`;
		}
		taken.add(chosen);
		result.set(f.relPath, chosen);
	}
	return result;
}

/**
 * Throw if any two publishable nodes in the tree share a page title — the same
 * sanity check the library's createFolderStructure runs, which we bypass.
 */
export function assertUniqueTitles(root: FolderTreeNode): void {
	const seen = new Set<string>();
	const walk = (node: FolderTreeNode, isRoot: boolean) => {
		if (!isRoot && node.file?.pageTitle) {
			const t = node.file.pageTitle as string;
			if (seen.has(t)) {
				throw new Error(`Page title "${t}" is not unique across the publish tree (folder-structure mode).`);
			}
			seen.add(t);
		}
		for (const c of node.children) walk(c, false);
	};
	walk(root, true);
}

// --- Tree assembly ----------------------------------------------------------

export interface BuildTreeContext {
	commonPath: string;
	/** folderRelPath → unique title. */
	folderTitle: Map<string, string>;
	/** folderRelPath → landing file's vault path. */
	indexFileByFolder: Map<string, string>;
	/** Blank ADF document used for folders that have no landing file. */
	folderFileAdf: Any;
	/** convertMDtoADF(markdownFile) → LocalAdfFile (parses markdown to ADF). */
	convertFile: (markdownFile: Any) => Any;
}

interface RawNode {
	name: string;
	children: Map<string, RawNode>;
	markdownFile?: Any; // the source MarkdownFile for a leaf
}

/**
 * Build a LocalAdfFileTreeNode for `markdownFiles` (a batch) using the global
 * structure context. The root is the stable common path; folder nodes get
 * unique titles; a folder's README/index/eponymous file becomes its page.
 */
export function buildTree(markdownFiles: Any[], ctx: BuildTreeContext): FolderTreeNode {
	const root: RawNode = { name: ctx.commonPath, children: new Map() };

	const promoted = new Set<string>(); // vault paths consumed as a folder landing page
	for (const f of markdownFiles) {
		const rel = relativeTo(ctx.commonPath, f.absoluteFilePath);
		const parts = splitPath(rel);
		const folderSegs = parts.slice(0, -1);
		const folderRelPath = folderSegs.join("/");
		const landing = ctx.indexFileByFolder.get(folderRelPath);
		if (landing === f.absoluteFilePath) {
			promoted.add(f.absoluteFilePath); // handled as the folder page, not a leaf
		}
	}

	// Insert leaf files (excluding promoted landing files).
	for (const f of markdownFiles) {
		if (promoted.has(f.absoluteFilePath)) continue;
		const rel = relativeTo(ctx.commonPath, f.absoluteFilePath);
		const parts = splitPath(rel);
		if (parts.length === 0) {
			// The file IS the common path (single-file publish). Attach it as a
			// direct child of the root using its basename.
			const leafName = splitPath(f.absoluteFilePath).pop() ?? "page";
			root.children.set(leafName, { name: leafName, children: new Map(), markdownFile: f });
			continue;
		}
		let node = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const seg = parts[i];
			let child = node.children.get(seg);
			if (!child) {
				child = { name: seg, children: new Map() };
				node.children.set(seg, child);
			}
			node = child;
		}
		const leafName = parts[parts.length - 1];
		node.children.set(leafName, { name: leafName, children: new Map(), markdownFile: f });
	}

	// Ensure folder nodes exist for promoted landing files too (so the folder
	// page is created even if it has no other children in this batch).
	for (const f of markdownFiles) {
		if (!promoted.has(f.absoluteFilePath)) continue;
		const rel = relativeTo(ctx.commonPath, f.absoluteFilePath);
		const folderSegs = splitPath(rel).slice(0, -1);
		let node = root;
		for (const seg of folderSegs) {
			let child = node.children.get(seg);
			if (!child) {
				child = { name: seg, children: new Map() };
				node.children.set(seg, child);
			}
			node = child;
		}
	}

	// Resolve a folder node's relPath by walking names from the root.
	const finalize = (raw: RawNode, parentRel: string, isRoot: boolean): FolderTreeNode => {
		const relPath = isRoot ? "" : parentRel ? `${parentRel}/${raw.name}` : raw.name;
		const childNodes: FolderTreeNode[] = [];
		let file: Any | undefined;

		if (raw.markdownFile) {
			// Leaf file node — convert to LocalAdfFile (pageTitle/pageId already
			// set on the MarkdownFile via loadMarkdownFile + frontmatter).
			file = ctx.convertFile(raw.markdownFile);
		} else if (!isRoot) {
			// Folder node — landing file becomes its page, else a blank placeholder.
			const title = ctx.folderTitle.get(relPath) ?? raw.name;
			const landingPath = ctx.indexFileByFolder.get(relPath);
			const landingRaw = landingPath
				? findPromotedSource(markdownFiles, landingPath)
				: undefined;
			if (landingRaw) {
				const converted = ctx.convertFile(landingRaw);
				file = { ...converted, pageTitle: title };
			} else {
				file = makeFolderFile(title, ctx);
			}
		} else {
			// Root carrier (mapped to the configured parent page; never created).
			file = makeFolderFile(raw.name, ctx);
		}

		for (const child of raw.children.values()) {
			childNodes.push(finalize(child, relPath, false));
		}
		return { name: raw.name, children: childNodes, file };
	};

	return finalize(root, "", true);
}

function findPromotedSource(markdownFiles: Any[], path: string): Any | undefined {
	return markdownFiles.find((f) => f.absoluteFilePath === path);
}

function makeFolderFile(title: string, ctx: BuildTreeContext): Any {
	return {
		folderName: title,
		absoluteFilePath: `__folder__/${title}`,
		fileName: `${title}.md`,
		contents: ctx.folderFileAdf,
		pageTitle: title,
		frontmatter: {},
		tags: [],
		pageId: undefined,
		dontChangeParentPageId: false,
		contentType: "page",
		blogPostDate: undefined,
	};
}
