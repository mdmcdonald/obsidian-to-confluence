/**
 * Preprocessing passes for Obsidian-specific markdown syntax that the bundled
 * @markdown-confluence/lib parser does not understand (it is plain CommonMark
 * with `html: false`):
 *
 *   - Comments  %%...%%   → stripped entirely (hidden in Obsidian reading view).
 *   - Wikilinks [[Page]]  → an inline-code sentinel carrying the *resolved*
 *                           Confluence page title / anchor / display text, which
 *                           AdfToStorageFormat decodes into an <ac:link> macro.
 *
 * Wikilinks are resolved here (not in AdfToStorageFormat) because this is the
 * only stage with access to the source file path + the title-dedup map, both of
 * which are required to map a link target to the exact Confluence page title.
 *
 * Both passes run on text segments only (see markdownTokenizer) so syntax inside
 * code spans / fences is preserved.
 */

import { transformText } from "./markdownTokenizer";

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
}

export type WikilinkResolver = (rawTarget: string) => WikilinkResolution;

export interface WikilinkPayload {
	/** "page": link to another Confluence page. "anchor": same-page anchor. */
	kind: "page" | "anchor";
	/** Target page title for kind "page". */
	title?: string;
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
	return (
		"`" +
		WIKILINK_SENTINEL_PREFIX +
		toBase64(JSON.stringify(payload)) +
		"`"
	);
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
	const pageName =
		hashIdx >= 0 ? targetPart.slice(0, hashIdx).trim() : targetPart.trim();
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
}

export function preprocessWikilinks(
	md: string,
	options: WikilinkPreprocessOptions,
): string {
	const { resolve, onWarning } = options;
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
					onWarning?.(`Block reference has no Confluence equivalent: [[${trimmedInner}]] — left as text`);
					return display;
				}
				return encodeWikilink({ kind: "anchor", anchor: parsed.anchor, display });
			}

			const res = resolve(parsed.pageName);
			if (!res.inVault) {
				onWarning?.(`Wikilink target not found in vault: [[${trimmedInner}]] — left as text`);
				return display;
			}
			if (!res.publishable || res.title === undefined) {
				onWarning?.(`Wikilink target is not published: [[${trimmedInner}]] — left as text`);
				return display;
			}

			let anchor = parsed.anchor;
			if (parsed.isBlockRef) {
				onWarning?.(`Block reference dropped (linking to page only): [[${trimmedInner}]]`);
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
