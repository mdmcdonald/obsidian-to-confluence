/**
 * Page-title resolution (F1).
 *
 * The Confluence page title IS the navigation label a reader clicks, so it must
 * come from the author's frontmatter wherever one exists rather than from the
 * filename. This module owns the precedence chain, the normalisation applied to
 * a raw title, and the optional consumption of the body's first heading (so the
 * page doesn't repeat its own title).
 *
 * Pure and dependency-free (no Obsidian, no library) so it can be unit-tested.
 */

/** Where a page's title comes from, before `connie-title` overrides. */
export type TitleSource = "frontmatter" | "first-heading" | "filename";

/** Whether the body's first `# heading` is removed after it became the title. */
export type ConsumeFirstHeading = "never" | "when-matching" | "always";

/** Confluence rejects titles longer than 255 characters. */
export const MAX_TITLE_LENGTH = 255;

export interface TitleResolutionSettings {
	titleSource: TitleSource;
	consumeFirstHeading: ConsumeFirstHeading;
}

/** Which rule produced the title — surfaced in the dry-run report. */
export type ResolvedTitleSource = "connie-title" | "frontmatter" | "first-heading" | "filename";

export interface ResolvedTitle {
	title: string;
	source: ResolvedTitleSource;
	/** True when the title was longer than 255 chars and had to be shortened. */
	truncated: boolean;
}

const ATX_HEADING_RE = /^([\t ]*)#[\t ]+(.+?)[\t ]*$/;
const FENCE_OPEN_RE = /^[\t ]*(```|~~~)/;

export interface HeadingLine {
	index: number;
	indent: string;
	text: string;
}

/**
 * Find the first ATX heading line that is NOT inside a fenced code block.
 * Matches how the library extracts the page title (its parser never produces a
 * heading from inside a code fence), so a `# ...` line inside ``` is ignored.
 * Returns the matching line index and captured groups, or null.
 */
export function findFirstHeadingLine(lines: string[]): HeadingLine | null {
	let inFence: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (inFence) {
			if (new RegExp(`^[\\t ]*${inFence}[\\t ]*$`).test(line)) inFence = null;
			continue;
		}
		const fence = FENCE_OPEN_RE.exec(line);
		if (fence) {
			inFence = fence[1];
			continue;
		}
		const h = ATX_HEADING_RE.exec(line);
		if (h) return { index: i, indent: h[1], text: h[2].trim() };
	}
	return null;
}

/** Strip a leading YAML frontmatter block, returning just the body. */
export function stripFrontmatter(content: string): string {
	if (!content.startsWith("---\n")) return content;
	const end = content.indexOf("\n---", 4);
	if (end < 0) return content;
	return content.substring(end + 4);
}

/** The first body heading's text, or undefined. Frontmatter is skipped. */
export function extractFirstHeading(content: string): string | undefined {
	return findFirstHeadingLine(stripFrontmatter(content).split("\n"))?.text;
}

// Leading decoration authors put in front of a heading: emoji, pictographs and
// symbol characters (▪ → ★ ✅ …), plus any whitespace around them.
const LEADING_DECORATION_RE = /^[\p{Extended_Pictographic}\p{S}\s]+/u;

/** Remove leading emoji / symbol decoration from a title or heading. */
export function stripLeadingSymbols(value: string): string {
	return value.replace(LEADING_DECORATION_RE, "");
}

/**
 * Normalise a raw title: stringify, strip surrounding quotes (YAML that arrives
 * pre-quoted), collapse internal whitespace runs, trim. Returns "" when nothing
 * usable remains, so the caller can fall through to the next source.
 */
export function normaliseTitle(value: unknown): string {
	if (value == null) return "";
	// Dates arrive as Date objects from the YAML parser; ISO is the least
	// surprising rendering and stays stable across runs.
	const raw = value instanceof Date ? value.toISOString() : String(value);
	return raw
		.replace(/^\s*["']|["']\s*$/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Shorten an over-long title deterministically (Confluence caps at 255). */
export function truncateTitle(title: string): { title: string; truncated: boolean } {
	if (title.length <= MAX_TITLE_LENGTH) return { title, truncated: false };
	return { title: `${title.slice(0, MAX_TITLE_LENGTH - 3)}...`, truncated: true };
}

function firstNonEmpty(fm: Record<string, unknown> | undefined, key: string): string {
	if (!fm) return "";
	return normaliseTitle(fm[key]);
}

/**
 * Resolve the raw page title for a file, BEFORE dedup renaming.
 *
 * Precedence:
 *   1. frontmatter `connie-title` (the library's own override — always wins)
 *   2. frontmatter `title`                    (titleSource "frontmatter")
 *   3. the first body ATX heading             (titleSource "frontmatter" or "first-heading")
 *   4. the file's basename
 *
 * A source that normalises to an empty string falls through to the next one.
 */
export function resolveTitle(
	basename: string,
	frontmatter: Record<string, unknown> | undefined,
	content: string,
	settings: TitleResolutionSettings,
): ResolvedTitle {
	const finish = (title: string, source: ResolvedTitleSource): ResolvedTitle => {
		const t = truncateTitle(title);
		return { title: t.title, source, truncated: t.truncated };
	};

	const connie = firstNonEmpty(frontmatter, "connie-title");
	if (connie) return finish(connie, "connie-title");

	if (settings.titleSource === "frontmatter") {
		const fmTitle = firstNonEmpty(frontmatter, "title");
		if (fmTitle) return finish(fmTitle, "frontmatter");
	}

	if (settings.titleSource === "frontmatter" || settings.titleSource === "first-heading") {
		const heading = extractFirstHeading(content);
		if (heading) {
			const cleaned = normaliseTitle(stripLeadingSymbols(heading));
			if (cleaned) return finish(cleaned, "first-heading");
		}
	}

	return finish(normaliseTitle(basename) || basename, "filename");
}

// A corpus identifier prefix an author repeats in the H1 but that the final
// title may render differently (or omit): "L3-01-01:", "DO-178C-01", "L2-06".
const IDENTIFIER_PREFIX_RE = /^[A-Z]{1,3}\d?[A-Z]?-\d{2}(-\d{2})?:?\s*/;
// A trailing qualifier the plugin itself may have appended for uniqueness —
// the dedup hash suffix "Title (a1b2c3)" or a disambiguating "(Radar)".
const TRAILING_QUALIFIER_RE = /\s*\([^()]*\)\s*$/;

/**
 * Fold a title / heading down to the text they must share for the heading to be
 * considered a restatement of the title: leading emoji, a repeated identifier
 * prefix, a trailing parenthetical qualifier and case are all ignored.
 */
export function normaliseForHeadingMatch(value: string): string {
	return stripLeadingSymbols(value)
		.replace(IDENTIFIER_PREFIX_RE, "")
		.replace(TRAILING_QUALIFIER_RE, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/**
 * Remove the body's first ATX heading (and one blank line after it) when the
 * mode calls for it, so a page whose title already says "Radar architecture"
 * doesn't open by repeating it. Frontmatter is never touched.
 */
export function consumeFirstHeading(content: string, finalTitle: string, mode: ConsumeFirstHeading): string {
	if (mode === "never") return content;

	// Operate on the whole document but locate the heading relative to the body,
	// so a "# " line inside frontmatter can never be mistaken for the title.
	const hasFrontmatter = content.startsWith("---\n");
	const body = hasFrontmatter ? stripFrontmatter(content) : content;
	const head = hasFrontmatter ? content.slice(0, content.length - body.length) : "";

	const lines = body.split("\n");
	const heading = findFirstHeadingLine(lines);
	if (!heading) return content;

	if (mode === "when-matching") {
		const a = normaliseForHeadingMatch(heading.text);
		const b = normaliseForHeadingMatch(finalTitle);
		if (!a || a !== b) return content;
	}

	let removeTo = heading.index + 1;
	if (lines[removeTo] !== undefined && lines[removeTo].trim() === "") removeTo++;
	lines.splice(heading.index, removeTo - heading.index);
	return head + lines.join("\n");
}
