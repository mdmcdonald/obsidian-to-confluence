import { test } from "node:test";
import assert from "node:assert/strict";

import { DRY_RUN_SECTIONS, formatDryRunReport, type DryRunInput } from "../src/dryRun";
import { makeDiagnostic } from "../src/linkDiagnostics";
import { compileExcludes } from "../src/publishFilter";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const EMPTY: DryRunInput = {
	folderToPublish: "Knowledge",
	generatedAt: "2026-09-01T09:00:00.000Z",
	counts: { publishablePages: 0, folderPages: 0, excludedByGlob: 0, excludedByFrontmatter: 0 },
	renames: [],
	landingConflicts: [],
	folderTitles: [],
	diagnostics: [],
	labels: { distinct: 0, dropped: [], top: [] },
};

const FULL: DryRunInput = {
	folderToPublish: "Knowledge",
	generatedAt: "2026-09-01T09:00:00.000Z",
	counts: { publishablePages: 2700, folderPages: 222, excludedByGlob: 41, excludedByFrontmatter: 7 },
	renames: [{ filePath: "Knowledge/a/overview.md", originalTitle: "Overview", renamedTitle: "Overview (a1b2c3)" }],
	landingConflicts: [
		{ folderRelPath: "domain/radar", candidates: ["Knowledge/domain/radar/index.md", "Knowledge/domain/radar/README.md"] },
	],
	folderTitles: [
		{ relPath: "domain/radar", title: "Radar", origin: "landing" },
		{ relPath: "04_Nodes", title: "Node catalogue", origin: "display-map" },
		{ relPath: "misc", title: "misc", origin: "segment" },
		{ relPath: "ew/architecture", title: "ew / architecture", origin: "qualified" },
		{ relPath: "dup", title: "dup (4a1a73)", origin: "hash" },
	],
	diagnostics: [
		makeDiagnostic("target-not-in-vault", "Knowledge/a.md", "Missing Page", "the missing page"),
		makeDiagnostic("target-not-in-vault", "Knowledge/b.md", "Also Missing"),
		makeDiagnostic("ambiguous-stem-unresolved", "Knowledge/a.md", "Overview", "x.md, y.md"),
		makeDiagnostic("asset-link-dropped", "Knowledge/c.md", "run.py"),
	],
	labels: {
		distinct: 120,
		dropped: [{ label: "adhoc", count: 9 }],
		top: [
			{ label: "radar", count: 300 },
			{ label: "type-hub", count: 40 },
		],
	},
};

// ---------------------------------------------------------------------------
// Structure (F6)
// ---------------------------------------------------------------------------

test("the report contains every section, in order, even when empty", () => {
	for (const input of [EMPTY, FULL]) {
		const report = formatDryRunReport(input);
		let cursor = -1;
		for (const section of DRY_RUN_SECTIONS) {
			const at = report.indexOf(`## ${section}`);
			assert.ok(at >= 0, `missing section "${section}"`);
			assert.ok(at > cursor, `section "${section}" is out of order`);
			cursor = at;
		}
	}
});

test("the sections are exactly the six the specification names", () => {
	assert.deepEqual(
		[...DRY_RUN_SECTIONS],
		["Summary", "Title renames", "Landing conflicts", "Folder titles", "Diagnostics", "Label preview"],
	);
});

test("the report is itself marked unpublishable and says nothing was written", () => {
	const report = formatDryRunReport(EMPTY);
	assert.ok(report.startsWith("---\nconnie-publish: false\n---\n"));
	assert.match(report, /Nothing was published and no note was modified/);
	assert.match(report, /Folder to publish: `Knowledge`/);
	assert.match(report, /Generated: 2026-09-01T09:00:00\.000Z/);
	assert.ok(report.endsWith("\n"));
});

test("an empty run reports None rather than omitting the headings", () => {
	const report = formatDryRunReport(EMPTY);
	assert.match(report, /## Title renames\n\nNone/);
	assert.match(report, /## Landing conflicts\n\nNone/);
	assert.match(report, /## Diagnostics\n\nNone/);
	assert.match(report, /No folder pages/);
});

// ---------------------------------------------------------------------------
// Counts (F6)
// ---------------------------------------------------------------------------

test("the summary counts agree with the input it was given", () => {
	const report = formatDryRunReport(FULL);
	assert.match(report, /\| Publishable pages \| 2700 \|/);
	assert.match(report, /\| Folder pages \| 222 \|/);
	assert.match(report, /\| Excluded by glob \| 41 \|/);
	assert.match(report, /\| Excluded by frontmatter \| 7 \|/);
	assert.match(report, /\| Title renames \| 1 \|/);
	assert.match(report, /\| Landing conflicts \| 1 \|/);
});

test("the per-kind counts agree with the diagnostics passed in", () => {
	const report = formatDryRunReport(FULL);
	assert.match(report, /\(`target-not-in-vault`\) \| 2 \|/);
	assert.match(report, /\(`ambiguous-stem-unresolved`\) \| 1 \|/);
	assert.match(report, /\(`asset-link-dropped`\) \| 1 \|/);
	// A kind with no occurrences is still listed, at zero.
	assert.match(report, /\(`block-ref-dropped`\) \| 0 \|/);
});

// ---------------------------------------------------------------------------
// Content (F6)
// ---------------------------------------------------------------------------

test("renames list the note, its resolved title and what it publishes as", () => {
	const report = formatDryRunReport(FULL);
	assert.match(report, /`Knowledge\/a\/overview\.md` \| Overview \| Overview \(a1b2c3\)/);
});

test("a landing conflict marks the winning candidate and the ignored ones", () => {
	const report = formatDryRunReport(FULL);
	assert.match(report, /- \*\*used\*\*: `Knowledge\/domain\/radar\/index\.md`/);
	assert.match(report, /- ignored: `Knowledge\/domain\/radar\/README\.md`/);
});

test("every folder title names where it came from", () => {
	const report = formatDryRunReport(FULL);
	assert.match(report, /`domain\/radar` \| Radar \| landing file/);
	assert.match(report, /`04_Nodes` \| Node catalogue \| display map/);
	assert.match(report, /`misc` \| misc \| folder name/);
	assert.match(report, /`ew\/architecture` \| ew \/ architecture \| qualified \(collision\)/);
	assert.match(report, /`dup` \| dup \(4a1a73\) \| hash suffix \(collision\)/);
});

test("diagnostics are grouped by kind and then by source page", () => {
	const report = formatDryRunReport(FULL);
	const section = report.slice(report.indexOf("## Diagnostics"), report.indexOf("## Label preview"));
	assert.match(section, /### Link target not found in the vault \(2\)/);
	assert.match(section, /### Ambiguous link — several publishable candidates \(1\)/);
	// Sources sort within a kind, so the report is stable across runs.
	assert.ok(section.indexOf("`Knowledge/a.md`") < section.indexOf("`Knowledge/b.md`"));
	// The display text is shown only when it differs from the target.
	assert.match(section, /→ Missing Page \(the missing page\)/);
	assert.match(section, /→ Also Missing$/m);
});

test("the label preview shows the distinct total, the drops and the top labels", () => {
	const report = formatDryRunReport(FULL);
	assert.match(report, /Distinct labels: \*\*120\*\*/);
	assert.match(report, /Dropped by the vocabulary allowlist \(1\)/);
	assert.match(report, /- `adhoc` × 9/);
	assert.match(report, /\| `radar` \| 300 \|/);
	assert.match(report, /\| `type-hub` \| 40 \|/);
});

test("with no allowlist in play the label section says so", () => {
	assert.match(formatDryRunReport(EMPTY), /No labels were dropped by the vocabulary allowlist/);
});

test("a pipe in a title cannot break the markdown table", () => {
	const report = formatDryRunReport({
		...EMPTY,
		folderTitles: [{ relPath: "a", title: "Left | Right", origin: "segment" }],
	});
	assert.match(report, /Left \\\| Right/);
});

// ---------------------------------------------------------------------------
// The report is kept out of the publish set (F6)
// ---------------------------------------------------------------------------

test("the default report path is excluded from publishing by its own frontmatter", () => {
	// isPublishable() also excludes the configured path by name; the frontmatter
	// is the belt-and-braces that survives the path being changed after a run.
	assert.ok(formatDryRunReport(EMPTY).startsWith("---\nconnie-publish: false"));
});

test("a report written inside the publish folder can also be excluded by glob", () => {
	const excluded = compileExcludes(["_confluence-check.md"]);
	assert.equal(excluded("_confluence-check.md"), true);
	assert.equal(excluded("notes/real-page.md"), false);
});
