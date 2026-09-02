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
 *   - a STABLE root = the common path of the WHOLE publishable set (so every
 *     batch nests identically), and
 *   - globally-unique folder titles taken from each folder's landing file (or a
 *     display-name map), parent-qualified only when they would collide, and
 *   - README / index / eponymous file promotion to the folder's landing page.
 *
 * Pure and dependency-injected (the markdown→ADF conversion is passed in) so it
 * can be unit-tested without the library or Obsidian.
 */

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

/**
 * Whether a vault file belongs to a configured publishing folder. Comparison is
 * segment-aware: `Docs-old/page.md` is not inside `Docs`. Empty and `/` both
 * mean the vault root for backwards compatibility with earlier documentation.
 */
export function isPathInFolder(filePath: string, folderPath: string): boolean {
	const folder = splitPath(folderPath.trim()).join("/");
	if (!folder) return true;
	const file = splitPath(filePath).join("/");
	return file === folder || file.startsWith(`${folder}/`);
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

/**
 * Resolve a relative link target against the DIRECTORY of the linking file,
 * the way Obsidian and a markdown renderer do: `../` walks up, `./` and empty
 * segments are dropped. Returns a vault path with no leading slash. Walking
 * above the vault root is clamped to the root rather than producing "..".
 */
export function resolveRelativePath(sourceFilePath: string, target: string): string {
	const dir = splitPath(sourceFilePath).slice(0, -1);
	const out = [...dir];
	for (const segment of target.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			out.pop();
			continue;
		}
		out.push(segment);
	}
	return out.join("/");
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

/** A folder with more than one file that could be its landing page. */
export interface LandingConflict {
	folderRelPath: string;
	/** Every candidate, in priority order; the first one is the one used. */
	candidates: string[];
}

export interface DerivedStructure {
	commonPath: string;
	/** All intermediate folders (relative to commonPath), parent-before-child. */
	folders: FolderInfo[];
	/** folderRelPath → the vault path of its README/index/eponymous landing file. */
	indexFileByFolder: Map<string, string>;
	/** vault file path → its containing folder's relPath ("" = directly at root). */
	folderOfFile: Map<string, string>;
	/** Folders where several files qualified as the landing page (F6 reports these). */
	landingConflicts: LandingConflict[];
	/**
	 * The landing file of the publish ROOT, when one exists. Only promoted onto
	 * the configured parent page when `publishRootLanding` is on (F7); it is
	 * never a folder page, because the root has no folder page of its own.
	 */
	rootLandingFile?: string;
}

/**
 * Landing-file priority, highest first. Deterministic (not "first found in
 * vault order") so a folder's page never changes identity between runs.
 */
function landingRank(fileName: string, folderName: string): number {
	const stem = stripExt(fileName).toLowerCase();
	if (stem === "index") return 0;
	if (stem === "readme") return 1;
	if (stem === folderName.toLowerCase()) return 2;
	return -1;
}

/**
 * Derive the folder hierarchy + per-folder landing file from the FULL set of
 * publishable file paths. Computed once over everything so the result is stable
 * regardless of which subset a batch publishes.
 */
export function deriveStructure(allFilePaths: string[]): DerivedStructure {
	const commonPath = commonPathOf(allFilePaths);
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

	// Identify each folder's landing file by a FIXED priority: index.md, then
	// README.md, then a file named like the folder. A folder with more than one
	// candidate is a diagnostic (the author should pick one) but still resolves
	// deterministically.
	const indexFileByFolder = new Map<string, string>();
	const landingConflicts: LandingConflict[] = [];
	let rootLandingFile: string | undefined;

	const pickLanding = (folderRelPath: string, files: string[], folderName: string) => {
		const ranked = files
			.map((fp) => ({ fp, rank: landingRank(basename(fp), folderName) }))
			.filter((c) => c.rank >= 0)
			.sort((a, b) => a.rank - b.rank || a.fp.localeCompare(b.fp));
		if (ranked.length === 0) return undefined;
		if (ranked.length > 1) {
			landingConflicts.push({ folderRelPath, candidates: ranked.map((c) => c.fp) });
		}
		return ranked[0].fp;
	};

	for (const [folderRelPath, files] of filesInFolder) {
		if (folderRelPath === "") {
			// The root has no folder page. A landing file here is only usable when
			// `publishRootLanding` promotes it onto the configured parent page (F7);
			// the root folder name is the deepest segment of the common path.
			rootLandingFile = pickLanding("", files, basename(commonPath));
			continue;
		}
		const landing = pickLanding(folderRelPath, files, basename(folderRelPath));
		if (landing) indexFileByFolder.set(folderRelPath, landing);
	}

	// Order folders parent-before-child for deterministic title assignment.
	const ordered = [...folders.values()].sort(
		(a, b) => a.segments.length - b.segments.length || a.relPath.localeCompare(b.relPath),
	);

	return {
		commonPath,
		folders: ordered,
		indexFileByFolder,
		folderOfFile,
		landingConflicts,
		...(rootLandingFile ? { rootLandingFile } : {}),
	};
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

/** Where a folder's final title came from — surfaced in the dry-run report. */
export type FolderTitleOrigin = "landing" | "display-map" | "segment" | "qualified" | "hash";

export interface FolderTitleOptions {
	/**
	 * The title this folder would like: its landing file's resolved title, or a
	 * display-name override. Returning undefined keeps the bare segment name.
	 */
	preferredTitle?: (folderRelPath: string) => { title: string; origin: FolderTitleOrigin } | undefined;
}

export interface FolderTitleResult {
	titles: Map<string, string>;
	origins: Map<string, FolderTitleOrigin>;
}

/**
 * Assign a unique title to every folder.
 *
 * A folder keeps its preferred title (landing file title, display-name entry,
 * or bare segment name) ONLY if that title is globally unique — no other folder
 * and no file page uses it. Otherwise EVERY folder sharing the title is
 * qualified with its PARENT'S PREFERRED TITLE ("Radar Architecture / Operational
 * functions (L1A)"), deepening as needed, with a "Name (hash6)" last resort.
 * Qualifying all colliding folders symmetrically (rather than letting the first
 * keep the bare name) keeps a folder's title stable when an unrelated sibling
 * is added or removed.
 *
 * The qualifier is the ancestor's PREFERRED title, not its final one: a reader
 * sees the landing/display name they recognise, and a parent that was itself
 * qualified or hashed does not drag that suffix into every descendant. In
 * "segment" mode preferred titles are just path segments, so qualification is
 * byte-for-byte what it was before folder titles became configurable.
 */
export function computeFolderTitlesDetailed(
	folders: FolderInfo[],
	takenTitles: Iterable<string>,
	opts: FolderTitleOptions = {},
): FolderTitleResult {
	const fileTitles = new Set<string>(takenTitles);

	// Resolve each folder's preferred title first, so collisions are counted on
	// the titles we actually intend to publish, not on raw path segments.
	const preferred = new Map<string, string>();
	const origins = new Map<string, FolderTitleOrigin>();
	for (const f of folders) {
		const pref = opts.preferredTitle?.(f.relPath);
		const seg = basename(f.relPath);
		preferred.set(f.relPath, pref?.title || seg);
		origins.set(f.relPath, pref?.title ? pref.origin : "segment");
	}

	const baseCount = new Map<string, number>();
	for (const f of folders) {
		const b = preferred.get(f.relPath) as string;
		baseCount.set(b, (baseCount.get(b) ?? 0) + 1);
	}

	const taken = new Set<string>(fileTitles);
	const result = new Map<string, string>();

	for (const f of folders) {
		const base = preferred.get(f.relPath) as string;
		const mustQualify = (baseCount.get(base) ?? 0) > 1 || fileTitles.has(base);
		let chosen: string | undefined;
		let origin: FolderTitleOrigin = origins.get(f.relPath) ?? "segment";

		if (!mustQualify && !taken.has(base)) {
			chosen = base;
		} else {
			// Walk up the ancestry, prefixing each ancestor's PREFERRED title, so
			// the qualifier a reader sees names the page they'd click through.
			const ancestors: string[] = [];
			let rel = f.parentRel;
			while (rel) {
				ancestors.push(preferred.get(rel) ?? basename(rel));
				const segs = splitPath(rel);
				rel = segs.slice(0, -1).join("/");
			}
			for (let depth = 1; depth <= ancestors.length; depth++) {
				const candidate = [...ancestors.slice(0, depth).reverse(), base].join(" / ");
				if (!taken.has(candidate)) {
					chosen = candidate;
					origin = "qualified";
					break;
				}
			}
		}

		if (chosen === undefined) {
			chosen = `${base} (${hash6(f.relPath)})`;
			while (taken.has(chosen)) chosen = `${chosen}_`;
			origin = "hash";
		}

		taken.add(chosen);
		result.set(f.relPath, chosen);
		origins.set(f.relPath, origin);
	}
	return { titles: result, origins };
}

/**
 * The file-page titles a folder title must not collide with.
 *
 * A landing file is not a page of its own — it IS its folder's page — so its
 * title must not count as "taken by a file" when its folder asks for that very
 * title. Without this, every folder titled from its landing collides with
 * itself and is qualified or hashed ("Radar / Radar Architecture",
 * "Domain Knowledge (e79397)"). The promoted root landing is excluded for the
 * same reason: it becomes the parent page, not a sibling.
 */
export function titlesExcludingLandings(
	titlesByPath: ReadonlyMap<string, string>,
	structure: Pick<DerivedStructure, "indexFileByFolder">,
	alsoExclude: Iterable<string> = [],
): string[] {
	const landings = new Set<string>(structure.indexFileByFolder.values());
	for (const path of alsoExclude) landings.add(path);
	const out: string[] = [];
	for (const [path, title] of titlesByPath) {
		if (!landings.has(path)) out.push(title);
	}
	return out;
}

/** Backwards-compatible wrapper returning just the title map. */
export function computeFolderTitles(
	folders: FolderInfo[],
	takenTitles: Iterable<string>,
	opts: FolderTitleOptions = {},
): Map<string, string> {
	return computeFolderTitlesDetailed(folders, takenTitles, opts).titles;
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

// --- Children Display macro (F11) ------------------------------------------

export type ChildrenMacroMode = "off" | "container-only" | "generated-landings" | "all";

/**
 * A Children Display macro as an ADF inlineExtension, which
 * AdfToStorageFormat.convertExtension renders as `<ac:structured-macro
 * ac:name="children">`. Depth 1 + title sort gives a folder page a clickable
 * index of its immediate children.
 */
export function childrenMacroNode(): Any {
	return {
		type: "paragraph",
		content: [
			{
				type: "inlineExtension",
				attrs: {
					extensionType: "com.atlassian.confluence.macro.core",
					extensionKey: "children",
					parameters: {
						macroParams: {
							depth: { value: "1" },
							sort: { value: "title" },
						},
					},
				},
			},
		],
	};
}

/** Whether a folder page in this mode gets a Children Display macro appended. */
export function wantsChildrenMacro(mode: ChildrenMacroMode, hasLanding: boolean, generatedLanding: boolean): boolean {
	switch (mode) {
		case "off":
			return false;
		case "all":
			return true;
		case "container-only":
			return !hasLanding;
		case "generated-landings":
			return hasLanding && generatedLanding;
	}
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
	/** Children Display macro policy (F11). Defaults to "off". */
	childrenMacro?: ChildrenMacroMode;
	/**
	 * The publish root's landing file, promoted into the root carrier so its
	 * content becomes the configured parent page's body (F7). Undefined keeps
	 * today's behaviour: the root file is published as an ordinary child page.
	 */
	rootLandingFile?: string;
	/** The configured parent page's current title; the root is never renamed. */
	rootPageTitle?: string;
}

interface RawNode {
	name: string;
	children: Map<string, RawNode>;
	markdownFile?: Any; // the source MarkdownFile for a leaf
}

/** Deep-ish clone of an ADF document before we append to its content array. */
function withAppendedContent(contents: Any, extra: Any): Any {
	if (!contents || typeof contents !== "object") return contents;
	const content = Array.isArray(contents.content) ? [...contents.content, extra] : [extra];
	return { ...contents, content };
}

/**
 * Build a LocalAdfFileTreeNode for `markdownFiles` (a batch) using the global
 * structure context. The root is the stable common path; folder nodes get
 * unique titles; a folder's README/index/eponymous file becomes its page.
 */
export function buildTree(markdownFiles: Any[], ctx: BuildTreeContext): FolderTreeNode {
	const root: RawNode = { name: ctx.commonPath, children: new Map() };
	const childrenMode: ChildrenMacroMode = ctx.childrenMacro ?? "off";

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
		// The root landing file becomes the root carrier's body, not a child page.
		if (ctx.rootLandingFile && ctx.rootLandingFile === f.absoluteFilePath) {
			promoted.add(f.absoluteFilePath);
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
			root.children.set(leafName, {
				name: leafName,
				children: new Map(),
				markdownFile: f,
			});
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
		node.children.set(leafName, {
			name: leafName,
			children: new Map(),
			markdownFile: f,
		});
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

	const isGenerated = (mf: Any): boolean => mf?.frontmatter?.generated === true;

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
			const landingRaw = landingPath ? findPromotedSource(markdownFiles, landingPath) : undefined;
			if (landingRaw) {
				const converted = ctx.convertFile(landingRaw);
				file = { ...converted, pageTitle: title };
				if (wantsChildrenMacro(childrenMode, true, isGenerated(landingRaw))) {
					file.contents = withAppendedContent(file.contents, childrenMacroNode());
				}
			} else {
				file = makeFolderFile(title, ctx);
				if (childrenMode === "container-only" || childrenMode === "all") {
					// Replace the Page Tree placeholder with a Children Display index.
					file.contents = { type: "doc", version: 1, content: [childrenMacroNode()] };
				}
			}
		} else {
			// Root carrier (mapped to the configured parent page; never created).
			const rootLandingRaw = ctx.rootLandingFile ? findPromotedSource(markdownFiles, ctx.rootLandingFile) : undefined;
			if (rootLandingRaw) {
				const converted = ctx.convertFile(rootLandingRaw);
				// The parent page keeps its own title — only its body is replaced.
				file = { ...converted, pageTitle: ctx.rootPageTitle ?? converted.pageTitle };
			} else {
				file = makeFolderFile(raw.name, ctx);
			}
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
