import { test } from "node:test";
import assert from "node:assert/strict";

import {
	MAX_TITLE_LENGTH,
	consumeFirstHeading,
	extractFirstHeading,
	findFirstHeadingLine,
	normaliseForHeadingMatch,
	normaliseTitle,
	resolveTitle,
	stripFrontmatter,
	stripLeadingSymbols,
	truncateTitle,
	type TitleResolutionSettings,
} from "../src/titleResolution";

const opts = (
	titleSource: TitleResolutionSettings["titleSource"],
	consume: TitleResolutionSettings["consumeFirstHeading"] = "never",
): TitleResolutionSettings => ({ titleSource, consumeFirstHeading: consume });

// ---------------------------------------------------------------------------
// Precedence (F1)
// ---------------------------------------------------------------------------

test("connie-title wins over every other source, in every mode", () => {
	const fm = { "connie-title": "Explicit", title: "Frontmatter" };
	const body = "# Heading\n\ntext";
	for (const source of ["filename", "first-heading", "frontmatter"] as const) {
		const r = resolveTitle("basename", fm, body, opts(source));
		assert.equal(r.title, "Explicit");
		assert.equal(r.source, "connie-title");
	}
});

test('titleSource "frontmatter" takes the title field, then the H1, then the basename', () => {
	const body = "# Heading\n\ntext";
	assert.deepEqual(
		{ ...resolveTitle("base", { title: "From FM" }, body, opts("frontmatter")) },
		{ title: "From FM", source: "frontmatter", truncated: false },
	);
	assert.equal(resolveTitle("base", {}, body, opts("frontmatter")).title, "Heading");
	assert.equal(resolveTitle("base", {}, "no heading here", opts("frontmatter")).title, "base");
});

test('titleSource "first-heading" ignores the frontmatter title field', () => {
	const r = resolveTitle("base", { title: "From FM" }, "# Heading", opts("first-heading"));
	assert.equal(r.title, "Heading");
	assert.equal(r.source, "first-heading");
});

test('titleSource "filename" ignores both the title field and the H1', () => {
	const r = resolveTitle("base", { title: "From FM" }, "# Heading", opts("filename"));
	assert.equal(r.title, "base");
	assert.equal(r.source, "filename");
});

test("a source that normalises to empty falls through to the next one", () => {
	// Whitespace-only and quote-only values must not win over the H1.
	assert.equal(resolveTitle("base", { title: "   " }, "# Heading", opts("frontmatter")).title, "Heading");
	assert.equal(resolveTitle("base", { "connie-title": '""' }, "# Heading", opts("frontmatter")).title, "Heading");
	// An emoji-only heading strips to nothing, so the basename wins.
	assert.equal(resolveTitle("base", {}, "# 🚀", opts("frontmatter")).title, "base");
});

test("a non-string frontmatter title is stringified", () => {
	assert.equal(resolveTitle("base", { title: 2026 }, "", opts("frontmatter")).title, "2026");
	const date = new Date("2026-09-01T00:00:00.000Z");
	assert.equal(resolveTitle("base", { title: date }, "", opts("frontmatter")).title, "2026-09-01T00:00:00.000Z");
});

// ---------------------------------------------------------------------------
// Normalisation and truncation
// ---------------------------------------------------------------------------

test("normaliseTitle strips surrounding quotes and collapses whitespace", () => {
	assert.equal(normaliseTitle('  "Radar   Architecture"  '), "Radar Architecture");
	assert.equal(normaliseTitle("'quoted'"), "quoted");
	assert.equal(normaliseTitle(undefined), "");
	assert.equal(normaliseTitle(null), "");
});

test("stripLeadingSymbols removes leading emoji and symbol runs only", () => {
	assert.equal(stripLeadingSymbols("🚀 Launch"), "Launch");
	assert.equal(stripLeadingSymbols("→ Next steps"), "Next steps");
	// An interior emoji is part of the title and must survive.
	assert.equal(stripLeadingSymbols("Launch 🚀 day"), "Launch 🚀 day");
});

test("a title longer than 255 characters is truncated at 252 with an ellipsis", () => {
	const long = "x".repeat(300);
	const t = truncateTitle(long);
	assert.equal(t.truncated, true);
	assert.equal(t.title.length, MAX_TITLE_LENGTH);
	assert.equal(t.title.endsWith("..."), true);
	assert.equal(t.title.slice(0, MAX_TITLE_LENGTH - 3), "x".repeat(MAX_TITLE_LENGTH - 3));

	const resolved = resolveTitle("base", { "connie-title": long }, "", opts("frontmatter"));
	assert.equal(resolved.truncated, true);
	assert.equal(resolved.title.length, MAX_TITLE_LENGTH);

	// A title exactly at the limit is left alone.
	assert.equal(truncateTitle("y".repeat(MAX_TITLE_LENGTH)).truncated, false);
});

// ---------------------------------------------------------------------------
// Heading discovery
// ---------------------------------------------------------------------------

test("findFirstHeadingLine ignores headings inside fenced code", () => {
	const lines = ["```", "# not a heading", "```", "", "# Real one", "text"];
	const found = findFirstHeadingLine(lines);
	assert.equal(found?.text, "Real one");
	assert.equal(found?.index, 4);
	// Only H1 is a title candidate — a deeper heading is body structure.
	assert.equal(findFirstHeadingLine(["## Section", "# Title"])?.text, "Title");
});

test("stripFrontmatter removes only a leading YAML block", () => {
	// The block's own trailing newline is left in place; heading consumption
	// re-attaches the untouched frontmatter head, so the body offset must match.
	assert.equal(stripFrontmatter("---\ntitle: x\n---\nbody"), "\nbody");
	assert.equal(stripFrontmatter("body\n---\nnot frontmatter\n---"), "body\n---\nnot frontmatter\n---");
});

test("extractFirstHeading skips the frontmatter block", () => {
	assert.equal(extractFirstHeading("---\ntitle: Not this\n---\n# Body heading"), "Body heading");
});

// ---------------------------------------------------------------------------
// Heading consumption (F1)
// ---------------------------------------------------------------------------

test('consumeFirstHeading "never" leaves the body untouched', () => {
	const md = "# Heading\n\nbody";
	assert.equal(consumeFirstHeading(md, "Heading", "never"), md);
});

test('consumeFirstHeading "always" removes the heading and one blank line after it', () => {
	assert.equal(consumeFirstHeading("# Anything\n\nbody", "Unrelated title", "always"), "body");
	// Only ONE blank line is consumed; the rest of the body's spacing survives.
	assert.equal(consumeFirstHeading("# H\n\n\nbody", "H", "always"), "\nbody");
});

test('"when-matching" consumes an H1 that restates the title through an identifier prefix', () => {
	// The spec's worked example: the H1 carries the identifier, the title adds a
	// disambiguating qualifier, and they must still be recognised as the same.
	const md = "# L3-01-01: Convert Platform Supply\n\nbody";
	const title = "L3-01-01 Convert Platform Supply (Radar)";
	assert.equal(consumeFirstHeading(md, title, "when-matching"), "body");
});

test('"when-matching" ignores leading emoji and case but keeps a genuinely different heading', () => {
	assert.equal(consumeFirstHeading("# 🚀 Radar Architecture\n\nbody", "radar architecture", "when-matching"), "body");
	const different = "# Overview\n\nbody";
	assert.equal(consumeFirstHeading(different, "Radar Architecture", "when-matching"), different);
});

test("heading consumption never touches the frontmatter block", () => {
	const md = "---\ntitle: T\n---\n# T\n\nbody";
	assert.equal(consumeFirstHeading(md, "T", "always"), "---\ntitle: T\n---\nbody");
});

test("a body with no heading is returned unchanged in every mode", () => {
	const md = "just text\n\nmore text";
	for (const mode of ["always", "when-matching"] as const) {
		assert.equal(consumeFirstHeading(md, "T", mode), md);
	}
});

test("normaliseForHeadingMatch folds prefix, emoji, qualifier and case together", () => {
	assert.equal(normaliseForHeadingMatch("🚀 L3-01: Convert Supply (Radar)"), "convert supply");
	assert.equal(normaliseForHeadingMatch("L3-01 Convert Supply"), "convert supply");
});
