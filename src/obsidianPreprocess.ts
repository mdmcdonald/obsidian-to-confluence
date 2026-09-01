/**
 * Preprocessing passes for Obsidian-specific markdown syntax that the bundled
 * @markdown-confluence/lib parser does not understand (it is plain CommonMark
 * with `html: false`):
 *
 *   - Comments  %%...%%   → stripped entirely (hidden in Obsidian reading view).
 *   - Wikilinks [[Page]]  → an inline-code sentinel carrying the *resolved*
 *                           Confluence page title / anchor / display text, which
 *                           AdfToStorageFormat decodes into an <ac:link> macro.
 *   - Relative markdown links to notes, FOLDERS and non-markdown assets → the
 *                           same sentinel, or a rewritten href, or plain text.
 *
 * Links are resolved here (not in AdfToStorageFormat) because this is the only
 * stage with access to the source file path + the title-dedup map, both of
 * which are required to map a link target to the exact Confluence page title.
 *
 * Both passes run on text segments only (see markdownTokenizer) so syntax inside
 * code spans / fences is preserved.
 */

import { transformText } from "./markdownTokenizer";
import { LinkDiagnostic, LinkDiagnosticKind, diagnosticMessage, makeDiagnostic } from "./linkDiagnostics";

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

// Obsidian comments: inline `%%comment%%` and multi-line `%%\n...\n%%`.
// Non-greedy so the shortest span between two `%%` is removed (comments do not
// nest in Obsidian).
const COMMENT_RE = /%%[\s\S]*?%%/g;

export function preprocessComments(md: string): string {
	return transformText(md, (t) => t.replace(COMMENT_RE, ""));
}

// ---------------------------------------------------------------------------
// Table cells: a cell whose content starts with ">" (e.g. "| >= 0.95 |") is
// mis-parsed as a blockquote, dropping the ">" and indenting the value. Escape
// a ">" that begins a cell so it stays literal. Common in engineering tables
// (thresholds like ">= 0.95", "> 100 km").
// ---------------------------------------------------------------------------

export function preprocessTableCells(md: string): string {
	return transformText(md, (text) =>
		text
			.split("\n")
			.map((line) => (/\|.*\|/.test(line) ? line.replace(/(\|[\t ]*)>/g, "$1\\>") : line))
			.join("\n"),
	);
}

// ---------------------------------------------------------------------------
// Wikilinks
// ---------------------------------------------------------------------------

export interface WikilinkResolution {
	/** True if the target resolves to any vault file. */
	inVault: boolean;
	/** True if the target resolves to a *publishable* vault file. */
	publishable: boolean;
	/**
	 * The resolved Confluence page title (post title-dedup) when publishable;
	 * otherwise the plain basename (used only for fallback display).
	 */
	title?: string;
	/**
	 * True when the target exists in the vault but an exclusion rule (or an
	 * explicit `connie-publish: false`) keeps it out of the publish set — the
	 * link is dead for a reason the author chose, so it reports as
	 * "target-excluded" rather than "target-not-published".
	 */
	excluded?: boolean;
}

export type WikilinkResolver = (rawTarget: string) => WikilinkResolution;

/** Outcome of resolving a relative link that points at a folder. */
export type FolderResolution = { kind: "page"; title: string } | { kind: "not-published" } | { kind: "not-a-folder" };

/** Outcome of resolving a relative link that points at a non-markdown asset. */
export type AssetResolution =
	/** Upload the file to the linking page and emit an ri:attachment link. */
	| { kind: "attachment"; filename: string }
	/** Rewrite the href to an external base URL, keeping the link text. */
	| { kind: "url"; href: string }
	/** Render the label as plain text (the honest default for a dead href). */
	| { kind: "text" }
	/** Not an asset we handle — leave the original markdown untouched. */
	| { kind: "not-an-asset" };

export type FolderResolver = (relativeTarget: string) => FolderResolution;
export type AssetResolver = (relativeTarget: string) => AssetResolution;

export interface WikilinkPayload {
	/**
	 * "page": link to another Confluence page.
	 * "anchor": same-page anchor.
	 * "attachment": link to a file attached to THIS page.
	 */
	kind: "page" | "anchor" | "attachment";
	/** Target page title for kind "page". */
	title?: string;
	/** Attachment filename for kind "attachment". */
	filename?: string;
	/** Verbatim heading text for a heading link, if any. */
	anchor?: string;
	/** Plain-text display shown for the link. */
	display: string;
}

export const WIKILINK_SENTINEL_PREFIX = "confluence-wikilink:";

function toBase64(s: string): string {
	if (typeof Buffer !== "undefined") {
		return Buffer.from(s, "utf8").toString("base64");
	}
	// Browser/Electron-renderer fallback: btoa is latin1-only, so round-trip
	// through percent-encoding to survive multi-byte UTF-8.
	return btoa(unescape(encodeURIComponent(s)));
}

function fromBase64(b: string): string {
	if (typeof Buffer !== "undefined") {
		return Buffer.from(b, "base64").toString("utf8");
	}
	return decodeURIComponent(escape(atob(b)));
}

export function encodeWikilink(payload: WikilinkPayload): string {
	return "`" + WIKILINK_SENTINEL_PREFIX + toBase64(JSON.stringify(payload)) + "`";
}

export function decodeWikilink(sentinelText: string): WikilinkPayload | null {
	if (!sentinelText.startsWith(WIKILINK_SENTINEL_PREFIX)) return null;
	const encoded = sentinelText.substring(WIKILINK_SENTINEL_PREFIX.length);
	try {
		return JSON.parse(fromBase64(encoded)) as WikilinkPayload;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Metadata panel (frontmatter → Confluence Page Properties macro)
// ---------------------------------------------------------------------------

/** A single rendered value in the metadata panel: plain text or a page link. */
export interface MetaValue {
	text: string;
	link?: { title: string; anchor?: string; display: string };
}
export interface MetaField {
	label: string;
	values: MetaValue[];
}

/** Fenced-code language used to smuggle the metadata payload past the parser. */
export const METADATA_FENCE_LANG = "confluence-metadata";

/** Encode metadata fields as a fenced code block (survives the markdown parser). */
export function encodeMetadataBlock(fields: MetaField[]): string {
	return "```" + METADATA_FENCE_LANG + "\n" + toBase64(JSON.stringify(fields)) + "\n```";
}

export function decodeMetadataBlock(base64Body: string): MetaField[] | null {
	try {
		return JSON.parse(fromBase64(base64Body.trim())) as MetaField[];
	} catch {
		return null;
	}
}

// [[ ... ]] not preceded by "!" (embeds/transclusions) or "[" (so the inner
// "[[" of a "[[[" run is not matched). Inner content has no newline and does
// not start with "[". Non-greedy stop at the first "]]".
const WIKILINK_RE = /(?<![![])\[\[(?!\[)([^\n]*?)\]\]/g;

interface ParsedWikilink {
	pageName: string; // "" for a same-file link ([[#heading]])
	anchor?: string; // heading text (verbatim), undefined for block refs
	isBlockRef: boolean; // [[Page#^blockId]]
	alias?: string;
}

function parseWikilink(inner: string): ParsedWikilink {
	// Alias: everything after the first "|".
	const pipeIdx = inner.indexOf("|");
	const targetPart = pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner;
	const aliasRaw = pipeIdx >= 0 ? inner.slice(pipeIdx + 1).trim() : undefined;
	const alias = aliasRaw && aliasRaw.length > 0 ? aliasRaw : undefined;

	// Heading / block fragment: everything after the first "#".
	const hashIdx = targetPart.indexOf("#");
	const pageName = hashIdx >= 0 ? targetPart.slice(0, hashIdx).trim() : targetPart.trim();
	const fragment = hashIdx >= 0 ? targetPart.slice(hashIdx + 1).trim() : "";

	let anchor: string | undefined;
	let isBlockRef = false;
	if (fragment.length > 0) {
		if (fragment.startsWith("^")) {
			isBlockRef = true; // block reference — no Confluence equivalent
		} else {
			anchor = fragment;
		}
	}
	return { pageName, anchor, isBlockRef, alias };
}

function defaultDisplay(parsed: ParsedWikilink): string {
	if (parsed.alias) return parsed.alias;
	if (parsed.pageName.length === 0) {
		// Same-file link: [[#Heading]] shows the heading.
		return parsed.anchor ?? "";
	}
	if (parsed.anchor) return `${parsed.pageName} > ${parsed.anchor}`;
	return parsed.pageName;
}

export interface WikilinkPreprocessOptions {
	resolve: WikilinkResolver;
	/** Optional sink for diagnostics about links that could not be linked. */
	onWarning?: (message: string) => void;
	/** Structured diagnostics (F5). `onWarning` is kept as a thin adapter. */
	onDiagnostic?: (diagnostic: LinkDiagnostic) => void;
	/** Vault path of the page being processed; recorded on every diagnostic. */
	sourcePath?: string;
	/** Resolve a relative target that names a folder (markdown links only). */
	resolveFolder?: FolderResolver;
	/** Resolve a relative target that names a non-markdown asset. */
	resolveAsset?: AssetResolver;
	/** Resolve a site-absolute ("/path/to/note") target. */
	resolveAbsolute?: WikilinkResolver;
}

/** Emit to both sinks so existing string-only callers keep working. */
function makeReporter(options: WikilinkPreprocessOptions) {
	const { onWarning, onDiagnostic, sourcePath = "" } = options;
	return (kind: LinkDiagnosticKind, target: string, display?: string) => {
		if (!onWarning && !onDiagnostic) return;
		const diagnostic = makeDiagnostic(kind, sourcePath, target, display);
		onDiagnostic?.(diagnostic);
		onWarning?.(diagnosticMessage(diagnostic));
	};
}

export function preprocessWikilinks(md: string, options: WikilinkPreprocessOptions): string {
	const { resolve } = options;
	const report = makeReporter(options);
	return transformText(md, (text) =>
		text.replace(WIKILINK_RE, (whole, inner: string) => {
			const trimmedInner = inner.trim();
			if (trimmedInner.length === 0) return whole; // "[[]]" — leave as-is
			// [[mention:...]] is a library-specific feature; let the library
			// handle it rather than treat it as a page link.
			if (trimmedInner.startsWith("mention:")) return whole;

			const parsed = parseWikilink(inner);
			const display = defaultDisplay(parsed) || trimmedInner;

			// Same-file link ([[#Heading]] / [[#^block]]).
			if (parsed.pageName.length === 0) {
				if (parsed.isBlockRef || !parsed.anchor) {
					report("block-ref-dropped", trimmedInner, display);
					return display;
				}
				return encodeWikilink({
					kind: "anchor",
					anchor: parsed.anchor,
					display,
				});
			}

			const res = resolve(parsed.pageName);
			if (!res.inVault) {
				report("target-not-in-vault", trimmedInner, display);
				return display;
			}
			if (!res.publishable || res.title === undefined) {
				report(res.excluded ? "target-excluded" : "target-not-published", trimmedInner, display);
				return display;
			}

			let anchor = parsed.anchor;
			if (parsed.isBlockRef) {
				report("block-ref-dropped", trimmedInner, display);
				anchor = undefined;
			}
			return encodeWikilink({
				kind: "page",
				title: res.title,
				anchor,
				display,
			});
		}),
	);
}

// Markdown links to vault files: [text](../path/Page.md) / (Page.md#Heading),
// plus folder links ([text](../radar/)) and asset links ([script](run.py)).
// These are real cross-references but render as dead links (href="#") in
// Confluence, so each is resolved to a page link, an attachment link, an
// external URL or plain text. Link text allows one level of nested brackets
// ([Type [Enum]](x.md)).
const MD_FILE_LINK_RE = /(?<!!)\[((?:[^\][\n]|\[[^\]\n]*\])+)\]\(([^)\s]+?)(#[^)\s]*)?\)/g;

/** The extension of a link target, lowercased and without the dot ("" if none). */
export function linkExtension(target: string): string {
	const lastSegment = target.split("/").pop() ?? "";
	const dot = lastSegment.lastIndexOf(".");
	if (dot <= 0) return "";
	return lastSegment.slice(dot + 1).toLowerCase();
}

export function preprocessMarkdownLinks(md: string, options: WikilinkPreprocessOptions): string {
	const { resolve, resolveFolder, resolveAsset, resolveAbsolute } = options;
	const report = makeReporter(options);
	return transformText(md, (text) =>
		text.replace(MD_FILE_LINK_RE, (whole, label: string, url: string, frag: string | undefined) => {
			if (/^[a-z]+:/i.test(url) || url.startsWith("#") || url.startsWith("//")) {
				return whole; // external/scheme/protocol-relative/same-page — leave alone
			}
			let decoded: string;
			try {
				decoded = decodeURIComponent(url);
			} catch {
				decoded = url;
			}

			const rawAnchor = frag?.slice(1);
			// Confluence has heading anchors but no equivalent for Obsidian block refs.
			const anchor = rawAnchor && !rawAnchor.startsWith("^") ? rawAnchor : undefined;

			// 4d. Site-absolute path: "/Knowledge/domain/radar/index.md".
			if (decoded.startsWith("/")) {
				if (!resolveAbsolute) return whole;
				const res = resolveAbsolute(decoded);
				if (!res.inVault || !res.publishable || res.title === undefined) {
					report("absolute-link-unresolved", url, label);
					return label;
				}
				return encodeWikilink({ kind: "page", title: res.title, anchor, display: label });
			}

			// Markdown note link — the original behaviour.
			if (/\.md$/i.test(decoded)) {
				// Preserve the path rather than collapsing it to a basename. Obsidian's
				// resolver uses the source note to interpret ../ and disambiguate duplicate
				// filenames; dropping that path could silently link to the wrong page.
				const linkPath = decoded.replace(/\.md$/i, "").trim();
				if (!linkPath) return whole;
				const res = resolve(linkPath);
				if (!res.inVault || !res.publishable || res.title === undefined) {
					report(
						!res.inVault ? "target-not-in-vault" : res.excluded ? "target-excluded" : "target-not-published",
						url,
						label,
					);
					return label; // fall back to the link text
				}
				return encodeWikilink({
					kind: "page",
					title: res.title,
					anchor,
					display: label,
				});
			}

			const ext = linkExtension(decoded);

			// 4b. Folder link: no extension, or an explicit trailing "/".
			if (resolveFolder && (ext === "" || decoded.endsWith("/"))) {
				const folder = resolveFolder(decoded);
				if (folder.kind === "page") {
					return encodeWikilink({ kind: "page", title: folder.title, anchor, display: label });
				}
				if (folder.kind === "not-published") {
					report("folder-not-published", url, label);
					return label;
				}
				// not-a-folder → fall through to the asset check below.
			}

			// 4c. Asset link: a non-markdown file the reader is meant to open.
			if (resolveAsset && ext !== "") {
				const asset = resolveAsset(decoded);
				if (asset.kind === "attachment") {
					return encodeWikilink({ kind: "attachment", filename: asset.filename, display: label });
				}
				if (asset.kind === "url") {
					return `[${label}](${asset.href})`;
				}
				if (asset.kind === "text") {
					report("asset-link-dropped", url, label);
					return label;
				}
			}

			return whole;
		}),
	);
}
