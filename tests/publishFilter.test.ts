import { test } from "node:test";
import assert from "node:assert/strict";

import { compileExcludes, excludeFileFormat, globToRegExpSource, parseExcludeFile } from "../src/publishFilter";

// ---------------------------------------------------------------------------
// Glob semantics (F3)
// ---------------------------------------------------------------------------

test("** crosses directory boundaries, * does not", () => {
	const deep = compileExcludes(["**/_drafts/**"]);
	assert.equal(deep("a/b/_drafts/note.md"), true);
	assert.equal(deep("_drafts/note.md"), true);
	assert.equal(deep("a/_drafts/deep/nested/note.md"), true);
	assert.equal(deep("a/drafts/note.md"), false);

	// A single * never swallows the separator, so an anchored pattern stays
	// within one directory level.
	const anchored = compileExcludes(["notes/*.md"]);
	assert.equal(anchored("notes/a.md"), true);
	assert.equal(anchored("notes/deep/a.md"), false);
});

test("a pattern with no slash matches at any depth, like .gitignore", () => {
	const p = compileExcludes(["*.canvas"]);
	assert.equal(p("board.canvas"), true);
	assert.equal(p("a/b/board.canvas"), true);
	assert.equal(p("board.md"), false);
	// Spelling the depth out explicitly is equivalent.
	assert.equal(compileExcludes(["**/*.canvas"])("a/b/board.canvas"), true);
});

test("? matches exactly one character and [] is a character class", () => {
	const q = compileExcludes(["note?.md"]);
	assert.equal(q("note1.md"), true);
	assert.equal(q("note.md"), false);
	assert.equal(q("note12.md"), false);

	const cls = compileExcludes(["draft[0-9].md"]);
	assert.equal(cls("draft7.md"), true);
	assert.equal(cls("draftx.md"), false);
});

test("a bare directory name excludes everything beneath it", () => {
	const p = compileExcludes(["_templates"]);
	assert.equal(p("_templates"), true);
	assert.equal(p("_templates/note.md"), true);
	assert.equal(p("_templates/deep/note.md"), true);
	assert.equal(p("templates/note.md"), false);
});

test("a leading ! re-includes, and the last matching pattern wins", () => {
	const p = compileExcludes(["archive/**", "!archive/keep/**"]);
	assert.equal(p("archive/old.md"), true);
	assert.equal(p("archive/keep/important.md"), false);

	// Order matters: reversing the pair re-excludes the carve-out.
	const reversed = compileExcludes(["!archive/keep/**", "archive/**"]);
	assert.equal(reversed("archive/keep/important.md"), true);
});

test("matching is case-sensitive and uses POSIX separators", () => {
	const p = compileExcludes(["Archive/**"]);
	assert.equal(p("Archive/note.md"), true);
	assert.equal(p("archive/note.md"), false);
});

test("blank lines, comments and a bare ! are ignored; an empty list excludes nothing", () => {
	const p = compileExcludes(["", "   ", "# a comment", "!", "drafts/**"]);
	assert.equal(p("drafts/x.md"), true);
	assert.equal(p("other/x.md"), false);
	assert.equal(compileExcludes([])("anything.md"), false);
});

test("regex metacharacters in a pattern are literal", () => {
	const p = compileExcludes(["notes (old)/**"]);
	assert.equal(p("notes (old)/x.md"), true);
	assert.equal(p("notes old/x.md"), false);
	// The source is anchored, so a pattern never matches a longer sibling name.
	assert.match(globToRegExpSource("a"), /^\^/);
	assert.match(globToRegExpSource("a"), /\$$/);
});

test("patterns are relative to the publish folder, not the vault root", () => {
	// The caller passes "domain/radar/index.md" for the vault path
	// "Knowledge/domain/radar/index.md", so a pattern naming the publish folder
	// itself must NOT match.
	const p = compileExcludes(["domain/**"]);
	assert.equal(p("domain/radar/index.md"), true);
	assert.equal(p("Knowledge/domain/radar/index.md"), false);
});

// ---------------------------------------------------------------------------
// Exclusion list files (F3)
// ---------------------------------------------------------------------------

test("a YAML list file reads the top-level exclude: block", () => {
	const yaml = [
		"# corpus governance",
		"version: 1",
		"exclude:",
		"  - '_templates/**'",
		'  - "**/*.canvas"',
		"  # a comment inside the block",
		"  - drafts/**   # trailing comment",
		"",
		"include:",
		"  - not-an-exclusion",
	].join("\n");
	assert.deepEqual(parseExcludeFile(yaml, "yaml"), ["_templates/**", "**/*.canvas", "drafts/**"]);
});

test("a YAML flow-style exclude list is read on one line", () => {
	assert.deepEqual(parseExcludeFile('exclude: ["a/**", \'b\']', "yaml"), ["a/**", "b"]);
});

test("a YAML file with no exclude key yields nothing", () => {
	assert.deepEqual(parseExcludeFile("version: 1\nother:\n  - x", "yaml"), []);
});

test("a plain-text list file is one pattern per line with # comments", () => {
	const text = ["# drafts", "_drafts/**", "", "  *.canvas  ", "keep.md # keep this one out too"].join("\r\n");
	assert.deepEqual(parseExcludeFile(text, "text"), ["_drafts/**", "*.canvas", "keep.md"]);
});

test("the parse format is chosen from the file extension", () => {
	assert.equal(excludeFileFormat("a/b/exclusions.yaml"), "yaml");
	assert.equal(excludeFileFormat("a/b/exclusions.YML"), "yaml");
	assert.equal(excludeFileFormat("a/b/exclusions.txt"), "text");
	assert.equal(excludeFileFormat("a/b/exclusions"), "text");
});

test("inline globs and file globs compose into one predicate", () => {
	const patterns = ["_drafts/**", ...parseExcludeFile("exclude:\n  - '**/*.canvas'", "yaml")];
	const p = compileExcludes(patterns);
	assert.equal(p("_drafts/x.md"), true);
	assert.equal(p("a/b/board.canvas"), true);
	assert.equal(p("a/b/note.md"), false);
});
