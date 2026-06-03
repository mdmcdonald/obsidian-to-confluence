import { test } from "node:test";
import assert from "node:assert/strict";

import {
	slugifyLabel,
	deriveTaxonomyLabels,
	mergeTags,
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
