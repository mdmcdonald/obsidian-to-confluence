import { test } from "node:test";
import assert from "node:assert/strict";

import {
	slugifyLabel,
	deriveTaxonomyLabels,
	mergeTags,
	parseLabelAllowlist,
	filterByAllowlist,
	capLabels,
	MAX_LABEL_LENGTH,
} from "../src/taxonomyLabels";

// ---------------------------------------------------------------------------
// slugifyLabel
// ---------------------------------------------------------------------------

test("slugifyLabel: spaces become hyphens, lowercased", () => {
	assert.equal(slugifyLabel("Machine Learning"), "machine-learning");
});

test("slugifyLabel: punctuation runs collapse to one hyphen ('&' dropped)", () => {
	assert.equal(slugifyLabel("Risk & Compliance"), "risk-compliance");
	assert.equal(slugifyLabel("A / B / C"), "a-b-c");
});

test("slugifyLabel: strips a leading namespace prefix", () => {
	assert.equal(slugifyLabel("taxonomy:ai-ethics"), "ai-ethics");
	assert.equal(slugifyLabel("kb:Machine Learning"), "machine-learning");
});

test("slugifyLabel: already-slug and surrounding noise", () => {
	assert.equal(slugifyLabel("  already-slugged  "), "already-slugged");
	assert.equal(slugifyLabel('"Quoted Term"'), "quoted-term");
	assert.equal(slugifyLabel("machine_learning"), "machine-learning");
});

test("slugifyLabel: preserves unicode letters/digits", () => {
	assert.equal(slugifyLabel("Café Ops"), "café-ops");
	assert.equal(slugifyLabel("机器学习"), "机器学习");
});

test("slugifyLabel: empty / nullish / pure-punctuation → ''", () => {
	assert.equal(slugifyLabel(""), "");
	assert.equal(slugifyLabel(null), "");
	assert.equal(slugifyLabel(undefined), "");
	assert.equal(slugifyLabel("---"), "");
	assert.equal(slugifyLabel("&&&"), "");
});

// ---------------------------------------------------------------------------
// deriveTaxonomyLabels
// ---------------------------------------------------------------------------

test("deriveTaxonomyLabels: subject list + type scalar", () => {
	const fm = {
		subject: ["Machine Learning", "Risk & Compliance"],
		type: "Reference Architecture",
	};
	assert.deepEqual(deriveTaxonomyLabels(fm, ["subject", "type"]), [
		"machine-learning",
		"risk-compliance",
		"reference-architecture",
	]);
});

test("deriveTaxonomyLabels: a scalar subject is treated as a single term", () => {
	assert.deepEqual(deriveTaxonomyLabels({ subject: "Data Mesh" }, ["subject"]), [
		"data-mesh",
	]);
});

test("deriveTaxonomyLabels: type falls back to document_type", () => {
	assert.deepEqual(
		deriveTaxonomyLabels({ document_type: "Decision Record" }, ["type"]),
		["decision-record"],
	);
});

test("deriveTaxonomyLabels: de-dupes terms that slug to the same value (case-fold)", () => {
	assert.deepEqual(deriveTaxonomyLabels({ subject: ["AI", "ai", "Ai"] }, ["subject"]), [
		"ai",
	]);
	// Internal punctuation collapses to a hyphen, so "A.I." is a distinct slug
	// (we don't silently merge it into "ai").
	assert.deepEqual(deriveTaxonomyLabels({ subject: ["AI", "A.I."] }, ["subject"]), [
		"ai",
		"a-i",
	]);
});

test("deriveTaxonomyLabels: only requested fields are projected", () => {
	const fm = { subject: ["Alpha"], domain: "should-be-ignored", type: "Beta" };
	assert.deepEqual(deriveTaxonomyLabels(fm, ["subject"]), ["alpha"]);
});

test("deriveTaxonomyLabels: missing frontmatter / fields → []", () => {
	assert.deepEqual(deriveTaxonomyLabels(undefined, ["subject", "type"]), []);
	assert.deepEqual(deriveTaxonomyLabels({}, ["subject", "type"]), []);
});

// ---------------------------------------------------------------------------
// mergeTags
// ---------------------------------------------------------------------------

test("mergeTags: appends derived after existing, preserving existing verbatim", () => {
	assert.deepEqual(mergeTags(["existing", "Keep Me"], ["machine-learning"]), [
		"existing",
		"Keep Me",
		"machine-learning",
	]);
});

test("mergeTags: handles undefined / scalar existing", () => {
	assert.deepEqual(mergeTags(undefined, ["a", "b"]), ["a", "b"]);
	assert.deepEqual(mergeTags("solo", ["a"]), ["solo", "a"]);
});

test("mergeTags: drops non-string existing entries and de-dupes exact matches", () => {
	assert.deepEqual(mergeTags(["a", 42, "a"], ["a", "b"]), ["a", "b"]);
});

// ---------------------------------------------------------------------------
// F8 — normalisation of real corpus terms
// ---------------------------------------------------------------------------

test("slugifyLabel normalises the terms the knowledge corpus actually uses", () => {
	assert.equal(slugifyLabel("DO-178C"), "do-178c");
	assert.equal(slugifyLabel("L3"), "l3");
	assert.equal(slugifyLabel("Risk & Compliance"), "risk-compliance");
	// A namespace prefix is a taxonomy convention, not part of the label.
	assert.equal(slugifyLabel("topic:Radar Systems"), "radar-systems");
	// Unicode letters and digits survive.
	assert.equal(slugifyLabel("Systèmes Radar"), "systèmes-radar");
});

test("slugifyLabel is applied to tags too, not just derived fields", () => {
	// Today tags pass through verbatim; F8 normalises them like everything else.
	const labels = deriveTaxonomyLabels({ tags: ["Machine Learning", "DO-178C"] }, ["tags"]);
	assert.deepEqual(labels, ["machine-learning", "do-178c"]);
});

test("a label is capped at 255 characters without a trailing hyphen", () => {
	const slug = slugifyLabel("a".repeat(300));
	assert.equal(slug.length, MAX_LABEL_LENGTH);
	const spaced = slugifyLabel(`${"a".repeat(MAX_LABEL_LENGTH - 1)} b`);
	assert.equal(spaced.endsWith("-"), false);
});

// ---------------------------------------------------------------------------
// F8 — prefixes
// ---------------------------------------------------------------------------

test("a prefix is applied per source field, before uniqueness", () => {
	const labels = deriveTaxonomyLabels({ type: "hub", tags: ["hub"] }, ["tags", "type"], { type: "type-" });
	// The bare tag and the prefixed type coexist rather than collapsing.
	assert.deepEqual(labels, ["hub", "type-hub"]);
});

test("an unprefixed field is unaffected by another field's prefix", () => {
	const labels = deriveTaxonomyLabels({ type: "hub", subject: "radar" }, ["subject", "type"], { type: "type-" });
	assert.deepEqual(labels, ["radar", "type-hub"]);
});

test("type falls back to document_type, prefix and all", () => {
	assert.deepEqual(deriveTaxonomyLabels({ document_type: "Hub Page" }, ["type"], { type: "type-" }), ["type-hub-page"]);
});

// ---------------------------------------------------------------------------
// F8 — the vocabulary allowlist
// ---------------------------------------------------------------------------

test("parseLabelAllowlist reads every string under any top-level list", () => {
	const yaml = [
		"# controlled vocabulary",
		"subjects:",
		"  - Radar Systems",
		"  - DO-178C",
		"types:",
		"  - hub",
		"  - name: reference   # a mapping entry contributes its value",
		"inline: [alpha, beta]",
	].join("\n");
	const allowed = parseLabelAllowlist(yaml);
	assert.equal(allowed.has("radar-systems"), true);
	assert.equal(allowed.has("do-178c"), true);
	assert.equal(allowed.has("hub"), true);
	assert.equal(allowed.has("reference"), true);
	assert.equal(allowed.has("alpha"), true);
	assert.equal(allowed.has("beta"), true);
	assert.equal(allowed.has("subjects"), false);
});

test("filtering keeps allowlisted labels and reports the rest", () => {
	const allowed = parseLabelAllowlist("terms:\n  - radar\n  - hub");
	const { kept, dropped } = filterByAllowlist(["radar", "adhoc", "hub"], allowed);
	assert.deepEqual(kept, ["radar", "hub"]);
	assert.deepEqual(dropped, ["adhoc"]);
});

test("a vocabulary listing the bare term also admits its prefixed variant", () => {
	// The documented baseline turns on BOTH a vocabulary file and a type- prefix.
	// The vocabulary lists the taxonomy's terms, not the plugin's rendering of
	// them, so the prefix must not silently drop every type-derived label.
	const allowed = parseLabelAllowlist("terms:\n  - hub");
	const { kept, dropped } = filterByAllowlist(["type-hub"], allowed, { type: "type-" });
	assert.deepEqual(kept, ["type-hub"]);
	assert.deepEqual(dropped, []);

	// With no prefix configured, "type-hub" is simply not an allowed term.
	assert.deepEqual(filterByAllowlist(["type-hub"], allowed).dropped, ["type-hub"]);
	// A prefixed label whose bare term is NOT in the vocabulary is still dropped.
	assert.deepEqual(filterByAllowlist(["type-adhoc"], allowed, { type: "type-" }).dropped, ["type-adhoc"]);
});

test("no allowlist configured lets every label through", () => {
	for (const allowed of [undefined, new Set<string>()]) {
		const { kept, dropped } = filterByAllowlist(["anything", "at-all"], allowed);
		assert.deepEqual(kept, ["anything", "at-all"]);
		assert.deepEqual(dropped, []);
	}
});

// ---------------------------------------------------------------------------
// F8 — the per-page cap
// ---------------------------------------------------------------------------

test("capLabels keeps the first N in order, and 0 means uncapped", () => {
	assert.deepEqual(capLabels(["a", "b", "c"], 2), ["a", "b"]);
	assert.deepEqual(capLabels(["a", "b", "c"], 0), ["a", "b", "c"]);
	assert.deepEqual(capLabels(["a", "b", "c"], 10), ["a", "b", "c"]);
});
