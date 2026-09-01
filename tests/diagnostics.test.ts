import { test } from "node:test";
import assert from "node:assert/strict";

import {
	DIAGNOSTIC_LABEL,
	DIAGNOSTIC_SEVERITY,
	LINK_DIAGNOSTIC_KINDS,
	diagnosticMessage,
	makeDiagnostic,
	rankPagesByDiagnostics,
	summariseDiagnostics,
	type LinkDiagnostic,
	type LinkDiagnosticKind,
} from "../src/linkDiagnostics";
import {
	preprocessMarkdownLinks,
	preprocessWikilinks,
	type AssetResolution,
	type FolderResolution,
	type WikilinkResolution,
} from "../src/obsidianPreprocess";

// ---------------------------------------------------------------------------
// Tables (F5)
// ---------------------------------------------------------------------------

test("every diagnostic kind has a severity and a human label", () => {
	for (const kind of LINK_DIAGNOSTIC_KINDS) {
		assert.ok(DIAGNOSTIC_SEVERITY[kind], `${kind} has no severity`);
		assert.ok(DIAGNOSTIC_LABEL[kind]?.length, `${kind} has no label`);
	}
	// The kind list and the severity table must not drift apart.
	assert.deepEqual([...LINK_DIAGNOSTIC_KINDS].sort(), Object.keys(DIAGNOSTIC_SEVERITY).sort());
	assert.deepEqual([...LINK_DIAGNOSTIC_KINDS].sort(), Object.keys(DIAGNOSTIC_LABEL).sort());
});

test("a link that silently points at the wrong page is an error, degraded text a warning", () => {
	assert.equal(DIAGNOSTIC_SEVERITY["ambiguous-stem-unresolved"], "error");
	assert.equal(DIAGNOSTIC_SEVERITY["landing-conflict"], "error");
	assert.equal(DIAGNOSTIC_SEVERITY["target-not-in-vault"], "warning");
	assert.equal(DIAGNOSTIC_SEVERITY["asset-link-dropped"], "warning");
});

test("makeDiagnostic fills in the kind's default severity", () => {
	const d = makeDiagnostic("ambiguous-stem-unresolved", "a/b.md", "Target", "shown");
	assert.deepEqual(d, {
		kind: "ambiguous-stem-unresolved",
		severity: "error",
		sourcePath: "a/b.md",
		target: "Target",
		display: "shown",
	});
});

test("summariseDiagnostics reports a zero for every kind, and counts what it was given", () => {
	const summary = summariseDiagnostics([
		makeDiagnostic("target-not-in-vault", "a.md", "x"),
		makeDiagnostic("target-not-in-vault", "b.md", "y"),
		makeDiagnostic("block-ref-dropped", "a.md", "z"),
	]);
	assert.equal(Object.keys(summary).length, LINK_DIAGNOSTIC_KINDS.length);
	assert.equal(summary["target-not-in-vault"], 2);
	assert.equal(summary["block-ref-dropped"], 1);
	assert.equal(summary["asset-link-dropped"], 0);
});

test("rankPagesByDiagnostics puts the worst page first and keeps its diagnostics", () => {
	const diagnostics = [
		makeDiagnostic("target-not-in-vault", "few.md", "a"),
		makeDiagnostic("ambiguous-stem-unresolved", "many.md", "b"),
		makeDiagnostic("ambiguous-stem-unresolved", "many.md", "c"),
		makeDiagnostic("target-not-in-vault", "many.md", "d"),
	];
	const ranked = rankPagesByDiagnostics(diagnostics);
	assert.equal(ranked[0].sourcePath, "many.md");
	assert.equal(ranked[0].errors, 2);
	assert.equal(ranked[0].warnings, 1);
	assert.equal(ranked[0].diagnostics.length, 3);
	assert.equal(ranked[1].sourcePath, "few.md");
	assert.equal(ranked[1].errors, 0);
});

test("pages with equal counts are ordered by path, so a report is stable", () => {
	const ranked = rankPagesByDiagnostics([
		makeDiagnostic("target-not-in-vault", "b.md", "x"),
		makeDiagnostic("target-not-in-vault", "a.md", "y"),
	]);
	assert.deepEqual(
		ranked.map((r) => r.sourcePath),
		["a.md", "b.md"],
	);
});

// ---------------------------------------------------------------------------
// Emission from the preprocessors (F5)
// ---------------------------------------------------------------------------

const notInVault: WikilinkResolution = { inVault: false, publishable: false };
const excluded: WikilinkResolution = { inVault: true, publishable: false, excluded: true };
const unpublished: WikilinkResolution = { inVault: true, publishable: false };
const page = (title: string): WikilinkResolution => ({ inVault: true, publishable: true, title });

/** Run a preprocessor and collect the diagnostics it emitted. */
function collect(
	run: (opts: {
		resolve: (t: string) => WikilinkResolution;
		resolveFolder?: (t: string) => FolderResolution;
		resolveAsset?: (t: string) => AssetResolution;
		resolveAbsolute?: (t: string) => WikilinkResolution;
		sourcePath: string;
		onDiagnostic: (d: LinkDiagnostic) => void;
		onWarning: (s: string) => void;
	}) => string,
	overrides: Partial<{
		resolve: (t: string) => WikilinkResolution;
		resolveFolder: (t: string) => FolderResolution;
		resolveAsset: (t: string) => AssetResolution;
		resolveAbsolute: (t: string) => WikilinkResolution;
	}> = {},
) {
	const diagnostics: LinkDiagnostic[] = [];
	const warnings: string[] = [];
	const out = run({
		resolve: () => notInVault,
		sourcePath: "src/page.md",
		onDiagnostic: (d) => diagnostics.push(d),
		onWarning: (s) => warnings.push(s),
		...overrides,
	});
	return { out, diagnostics, warnings, kinds: diagnostics.map((d) => d.kind) };
}

test("each wikilink failure emits exactly one diagnostic of its kind", () => {
	const cases: [WikilinkResolution, LinkDiagnosticKind][] = [
		[notInVault, "target-not-in-vault"],
		[excluded, "target-excluded"],
		[unpublished, "target-not-published"],
	];
	for (const [resolution, kind] of cases) {
		const r = collect((o) => preprocessWikilinks("see [[Target]]", o), { resolve: () => resolution });
		assert.deepEqual(r.kinds, [kind]);
		assert.equal(r.diagnostics[0].sourcePath, "src/page.md");
		assert.equal(r.diagnostics[0].target, "Target");
		// The link degrades to its display text rather than vanishing.
		assert.equal(r.out, "see Target");
	}
});

test("a block reference emits block-ref-dropped once and keeps the page link", () => {
	const r = collect((o) => preprocessWikilinks("see [[Target#^abc123]]", o), { resolve: () => page("Target Page") });
	assert.deepEqual(r.kinds, ["block-ref-dropped"]);
	assert.match(r.out, /confluence-wikilink:/);
});

test("a same-file block reference emits block-ref-dropped and falls back to text", () => {
	const r = collect((o) => preprocessWikilinks("see [[#^abc]]", o));
	assert.deepEqual(r.kinds, ["block-ref-dropped"]);
});

test("a resolved link emits no diagnostic at all", () => {
	const r = collect((o) => preprocessWikilinks("see [[Target]]", o), { resolve: () => page("Target Page") });
	assert.deepEqual(r.kinds, []);
});

test("an unresolved folder link emits folder-not-published once", () => {
	const r = collect((o) => preprocessMarkdownLinks("see [Radar](../radar/)", o), {
		resolveFolder: () => ({ kind: "not-published" }),
	});
	assert.deepEqual(r.kinds, ["folder-not-published"]);
	assert.equal(r.out, "see Radar");
});

test("a dropped asset link emits asset-link-dropped once", () => {
	const r = collect((o) => preprocessMarkdownLinks("see [script](run.py)", o), {
		resolveAsset: () => ({ kind: "text" }),
	});
	assert.deepEqual(r.kinds, ["asset-link-dropped"]);
	assert.equal(r.out, "see script");
});

test("an unresolved absolute path emits absolute-link-unresolved once", () => {
	const r = collect((o) => preprocessMarkdownLinks("see [Note](/Knowledge/gone.md)", o), {
		resolveAbsolute: () => notInVault,
	});
	assert.deepEqual(r.kinds, ["absolute-link-unresolved"]);
	assert.equal(r.out, "see Note");
});

test("a markdown note link reports the reason it failed, not a generic one", () => {
	assert.deepEqual(
		collect((o) => preprocessMarkdownLinks("[a](x.md)", o), { resolve: () => excluded }).kinds,
		["target-excluded"],
	);
	assert.deepEqual(
		collect((o) => preprocessMarkdownLinks("[a](x.md)", o), { resolve: () => unpublished }).kinds,
		["target-not-published"],
	);
	assert.deepEqual(
		collect((o) => preprocessMarkdownLinks("[a](x.md)", o), { resolve: () => notInVault }).kinds,
		["target-not-in-vault"],
	);
});

test("the summary counts match the diagnostics the preprocessors emitted", () => {
	// A and B are missing; C resolves, so only its block reference is dropped.
	const r = collect((o) => preprocessWikilinks("[[A]] and [[B]] and [[C#^x]]", o), {
		resolve: (t) => (t === "C" ? page("C Page") : notInVault),
	});
	const summary = summariseDiagnostics(r.diagnostics);
	assert.equal(summary["target-not-in-vault"], 2);
	assert.equal(summary["block-ref-dropped"], 1);
	assert.equal(
		Object.values(summary).reduce((a, b) => a + b, 0),
		r.diagnostics.length,
	);
});

// ---------------------------------------------------------------------------
// Backwards compatibility (F5)
// ---------------------------------------------------------------------------

test("existing onWarning callers still receive a string per diagnostic", () => {
	const r = collect((o) => preprocessWikilinks("see [[Target]]", o));
	assert.equal(r.warnings.length, 1);
	assert.equal(typeof r.warnings[0], "string");
	assert.match(r.warnings[0], /Target/);
	assert.match(r.warnings[0], /src\/page\.md/);
});

test("a caller providing only onWarning still gets its string", () => {
	const warnings: string[] = [];
	preprocessWikilinks("see [[Target]]", {
		resolve: () => notInVault,
		sourcePath: "a.md",
		onWarning: (s) => warnings.push(s),
	});
	assert.equal(warnings.length, 1);
});

test("a caller providing neither sink is not an error", () => {
	assert.equal(preprocessWikilinks("see [[Target]]", { resolve: () => notInVault }), "see Target");
});

test("diagnosticMessage names the kind, the target and the source page", () => {
	const message = diagnosticMessage(makeDiagnostic("target-excluded", "a/b.md", "Target", "shown"));
	assert.match(message, /Target/);
	assert.match(message, /a\/b\.md/);
	assert.ok(message.includes(DIAGNOSTIC_LABEL["target-excluded"]));
});
