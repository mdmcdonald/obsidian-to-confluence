import { test } from "node:test";
import assert from "node:assert/strict";

import { segmentMarkdown, transformText } from "../src/markdownTokenizer";
import { preprocessLatex } from "../src/LatexPreprocessor";
import {
	preprocessComments,
	preprocessWikilinks,
	encodeWikilink,
	decodeWikilink,
	WikilinkResolution,
} from "../src/obsidianPreprocess";
import { convertAdfToStorageFormat } from "../src/AdfToStorageFormat";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HL_OPEN = `<span style="background-color: rgb(255,248,179)">`;
const HL_CLOSE = `</span>`;

/** Decode a `confluence-wikilink:...` markdown sentinel back to its payload. */
function decodeSentinel(markdown: string) {
	const inner = markdown.replace(/^`/, "").replace(/`$/, "");
	return decodeWikilink(inner);
}

/** Wrap inline ADF nodes in a doc>paragraph and convert to storage format. */
function para(...content: unknown[]): string {
	return convertAdfToStorageFormat({
		type: "doc",
		content: [{ type: "paragraph", content }],
	});
}

const txt = (text: string, marks?: string[]) => ({
	type: "text",
	text,
	...(marks ? { marks: marks.map((m) => ({ type: m })) } : {}),
});

const publishable = (title: string): WikilinkResolution => ({
	inVault: true,
	publishable: true,
	title,
});

// ---------------------------------------------------------------------------
// markdownTokenizer
// ---------------------------------------------------------------------------

test("transformText leaves fenced code blocks untouched", () => {
	const md = "before ==x==\n```\n==y== inside code\n```\nafter ==z==";
	const out = transformText(md, (t) => t.replaceAll("==", "@@"));
	assert.equal(
		out,
		"before @@x@@\n```\n==y== inside code\n```\nafter @@z@@",
	);
});

test("transformText leaves inline code untouched", () => {
	const out = transformText("a `==code==` b", (t) => t.replaceAll("==", "@@"));
	assert.equal(out, "a `==code==` b");
});

test("segmentMarkdown round-trips byte-for-byte", () => {
	const md = "para\n\n```js\ncode\n```\n\n`inline` and ~~~\nfence\n~~~\n";
	assert.equal(segmentMarkdown(md).map((s) => s.text).join(""), md);
});

// ---------------------------------------------------------------------------
// LatexPreprocessor (regression — must keep working after tokenizer refactor)
// ---------------------------------------------------------------------------

test("inline math becomes a sentinel", () => {
	assert.equal(preprocessLatex("$E=mc^2$"), "`latex-math-inline:E=mc^2`");
});

test("block math becomes a latex-math-block fence", () => {
	const out = preprocessLatex("$$\na+b\n$$");
	assert.ok(out.includes("```latex-math-block\na+b\n```"));
});

test("currency is left alone", () => {
	assert.equal(preprocessLatex("I have $50 and $20"), "I have $50 and $20");
});

test("math inside a code fence is left alone", () => {
	const md = "```\n$x$\n```";
	assert.equal(preprocessLatex(md), md);
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

test("inline comment is stripped", () => {
	assert.equal(preprocessComments("a %%secret%% b"), "a  b");
});

test("multi-line block comment is stripped", () => {
	assert.equal(preprocessComments("x\n%%\nline1\nline2\n%%\ny"), "x\n\ny");
});

test("comment markers inside code are preserved", () => {
	assert.equal(preprocessComments("`%%not a comment%%`"), "`%%not a comment%%`");
	const fence = "```\n%%keep%%\n```";
	assert.equal(preprocessComments(fence), fence);
});

// ---------------------------------------------------------------------------
// Wikilink encode/decode
// ---------------------------------------------------------------------------

test("wikilink payload round-trips through base64 (incl. unicode + specials)", () => {
	const payload = {
		kind: "page" as const,
		title: 'Über & "Q&A" <Draft>',
		anchor: "Heading One",
		display: "café → ☕",
	};
	const encoded = encodeWikilink(payload);
	assert.ok(encoded.startsWith("`confluence-wikilink:"));
	assert.deepEqual(decodeSentinel(encoded), payload);
});

// ---------------------------------------------------------------------------
// preprocessWikilinks
// ---------------------------------------------------------------------------

test("simple publishable wikilink", () => {
	const out = preprocessWikilinks("see [[Page]] now", {
		resolve: () => publishable("Page"),
	});
	const m = out.match(/`confluence-wikilink:[^`]+`/);
	assert.ok(m, "expected a sentinel");
	assert.deepEqual(decodeSentinel(m![0]), {
		kind: "page",
		title: "Page",
		display: "Page",
	});
	assert.ok(out.startsWith("see ") && out.endsWith(" now"));
});

test("aliased wikilink uses alias as display", () => {
	const out = preprocessWikilinks("[[Page|the alias]]", {
		resolve: () => publishable("Page"),
	});
	assert.deepEqual(decodeSentinel(out), {
		kind: "page",
		title: "Page",
		display: "the alias",
	});
});

test("heading wikilink carries anchor + Obsidian-style display", () => {
	const out = preprocessWikilinks("[[Page#Some Heading]]", {
		resolve: () => publishable("Page"),
	});
	assert.deepEqual(decodeSentinel(out), {
		kind: "page",
		title: "Page",
		anchor: "Some Heading",
		display: "Page > Some Heading",
	});
});

test("block-ref wikilink drops the anchor, links to the page", () => {
	const out = preprocessWikilinks("[[Page#^abc123]]", {
		resolve: () => publishable("Page"),
	});
	assert.deepEqual(decodeSentinel(out), {
		kind: "page",
		title: "Page",
		display: "Page",
	});
});

test("same-page heading link emits an anchor with no page", () => {
	const out = preprocessWikilinks("[[#Local Heading]]", {
		resolve: () => {
			throw new Error("resolver should not be called for same-page links");
		},
	});
	assert.deepEqual(decodeSentinel(out), {
		kind: "anchor",
		anchor: "Local Heading",
		display: "Local Heading",
	});
});

test("dedup-renamed target links to the renamed title", () => {
	const out = preprocessWikilinks("[[Architecture]]", {
		resolve: () => publishable("Architecture (a3f9c2)"),
	});
	assert.equal(decodeSentinel(out)!.title, "Architecture (a3f9c2)");
});

test("target not in vault falls back to plain text", () => {
	const warnings: string[] = [];
	const out = preprocessWikilinks("[[Ghost]]", {
		resolve: () => ({ inVault: false, publishable: false }),
		onWarning: (m) => warnings.push(m),
	});
	assert.equal(out, "Ghost");
	assert.equal(warnings.length, 1);
});

test("non-publishable vault file falls back to plain text", () => {
	const out = preprocessWikilinks("[[Draft|My Draft]]", {
		resolve: () => ({ inVault: true, publishable: false, title: "Draft" }),
	});
	assert.equal(out, "My Draft");
});

test("embeds (![[...]]) are not treated as wikilinks", () => {
	const out = preprocessWikilinks("![[Some Note]]", {
		resolve: () => publishable("Some Note"),
	});
	assert.equal(out, "![[Some Note]]");
});

test("wikilinks inside code are not processed", () => {
	const fence = "```\n[[Page]]\n```";
	assert.equal(
		preprocessWikilinks(fence, { resolve: () => publishable("Page") }),
		fence,
	);
});

test("[[mention:...]] is left for the library to handle", () => {
	assert.equal(
		preprocessWikilinks("[[mention:bob]]", { resolve: () => publishable("x") }),
		"[[mention:bob]]",
	);
});

test("leftover wikilinks: href (embed) renders as plain text, not a broken anchor", () => {
	const linked = para({
		type: "text",
		text: "Note",
		marks: [{ type: "link", attrs: { href: "wikilinks:Note" } }],
	});
	assert.equal(linked, "<p>Note</p>");
});

test("ordinary external links still render as anchors", () => {
	const linked = para({
		type: "text",
		text: "site",
		marks: [{ type: "link", attrs: { href: "https://example.com" } }],
	});
	assert.equal(linked, `<p><a href="https://example.com">site</a></p>`);
});

// ---------------------------------------------------------------------------
// Highlights (AdfToStorageFormat)
// ---------------------------------------------------------------------------

test("plain highlight becomes a background-color span", () => {
	assert.equal(para(txt("==hi==")), `<p>${HL_OPEN}hi${HL_CLOSE}</p>`);
});

test("highlight preserves inner formatting across nodes", () => {
	const out = para(txt("=="), txt("bold", ["strong"]), txt("=="));
	assert.equal(out, `<p>${HL_OPEN}<strong>bold</strong>${HL_CLOSE}</p>`);
});

test("flanking: spaces adjacent to markers disqualify the highlight", () => {
	assert.equal(para(txt("== x ==")), `<p>== x ==</p>`);
});

test("unmatched marker renders literally", () => {
	assert.equal(para(txt("a == b")), `<p>a == b</p>`);
});

test("two highlights in one paragraph", () => {
	assert.equal(
		para(txt("==a== ==b==")),
		`<p>${HL_OPEN}a${HL_CLOSE} ${HL_OPEN}b${HL_CLOSE}</p>`,
	);
});

test("markers inside inline code are not highlighted", () => {
	assert.equal(para(txt("==x==", ["code"])), `<p><code>==x==</code></p>`);
});

// ---------------------------------------------------------------------------
// Wikilink rendering (AdfToStorageFormat)
// ---------------------------------------------------------------------------

function wikilinkNode(payload: Parameters<typeof encodeWikilink>[0]) {
	const inner = encodeWikilink(payload).replace(/^`/, "").replace(/`$/, "");
	return txt(inner, ["code"]);
}

test("page wikilink renders an ac:link by title", () => {
	const out = para(wikilinkNode({ kind: "page", title: "My Page", display: "My Page" }));
	assert.equal(
		out,
		`<p><ac:link><ri:page ri:content-title="My Page" /><ac:plain-text-link-body><![CDATA[My Page]]></ac:plain-text-link-body></ac:link></p>`,
	);
});

test("heading wikilink renders ac:anchor with spaces removed", () => {
	const out = para(
		wikilinkNode({ kind: "page", title: "P", anchor: "My Heading", display: "P > My Heading" }),
	);
	assert.ok(out.includes(`<ac:link ac:anchor="MyHeading">`));
	assert.ok(out.includes(`<ri:page ri:content-title="P" />`));
});

test("same-page anchor wikilink omits ri:page", () => {
	const out = para(wikilinkNode({ kind: "anchor", anchor: "Local", display: "Local" }));
	assert.equal(
		out,
		`<p><ac:link ac:anchor="Local"><ac:plain-text-link-body><![CDATA[Local]]></ac:plain-text-link-body></ac:link></p>`,
	);
});

test("special characters in the title are XML-escaped", () => {
	const out = para(wikilinkNode({ kind: "page", title: 'Q&A "x"', display: "d" }));
	assert.ok(out.includes(`ri:content-title="Q&amp;A &quot;x&quot;"`));
});

test("highlight wrapping a wikilink renders both", () => {
	const out = para(
		txt("==see "),
		wikilinkNode({ kind: "page", title: "Page", display: "Page" }),
		txt("=="),
	);
	assert.equal(
		out,
		`<p>${HL_OPEN}see <ac:link><ri:page ri:content-title="Page" /><ac:plain-text-link-body><![CDATA[Page]]></ac:plain-text-link-body></ac:link>${HL_CLOSE}</p>`,
	);
});

// ---------------------------------------------------------------------------
// Fixes from adversarial review
// ---------------------------------------------------------------------------

test("highlights render inside table cells (direct inline content)", () => {
	const out = convertAdfToStorageFormat({
		type: "doc",
		content: [
			{
				type: "table",
				content: [
					{
						type: "tableRow",
						content: [{ type: "tableCell", content: [txt("==hi==")] }],
					},
				],
			},
		],
	});
	assert.ok(out.includes(`<td>${HL_OPEN}hi${HL_CLOSE}</td>`), out);
});

test("highlights still work when a table cell wraps a paragraph", () => {
	const out = convertAdfToStorageFormat({
		type: "doc",
		content: [
			{
				type: "table",
				content: [
					{
						type: "tableRow",
						content: [
							{
								type: "tableCell",
								content: [{ type: "paragraph", content: [txt("==hi==")] }],
							},
						],
					},
				],
			},
		],
	});
	assert.ok(out.includes(`<td><p>${HL_OPEN}hi${HL_CLOSE}</p></td>`), out);
});

test("empty text nodes between markers don't defeat the highlight", () => {
	const out = para(txt("=="), txt(""), txt("x"), txt(""), txt("=="));
	assert.equal(out, `<p>${HL_OPEN}x${HL_CLOSE}</p>`);
});

test("[[[triple]]] brackets are not treated as a wikilink", () => {
	const out = preprocessWikilinks("[[[Page]]]", {
		resolve: () => publishable("Page"),
	});
	assert.equal(out, "[[[Page]]]");
});

test("[[Page#Heading|Alias]] combines heading + alias", () => {
	const out = preprocessWikilinks("[[Page#Heading|Alias]]", {
		resolve: () => publishable("Page"),
	});
	assert.deepEqual(decodeSentinel(out), {
		kind: "page",
		title: "Page",
		anchor: "Heading",
		display: "Alias",
	});
});

test("integration: comments → wikilinks → latex, in pipeline order", () => {
	let md = "a [[Link]] b %%hidden $z$ and [[X]]%% c $y$ d";
	md = preprocessComments(md);
	md = preprocessWikilinks(md, { resolve: () => publishable("Link") });
	md = preprocessLatex(md);
	assert.ok(!md.includes("%%"), "comment removed");
	assert.ok(!md.includes("hidden"), "commented content removed");
	assert.ok(md.includes("`confluence-wikilink:"), "live wikilink encoded");
	assert.ok(md.includes("`latex-math-inline:y`"), "live math encoded");
});

test("panel nodes map to DC admonition macros (info/note/warning/tip)", () => {
	const panel = (panelType: string) =>
		convertAdfToStorageFormat({
			type: "doc",
			content: [{ type: "panel", attrs: { panelType }, content: [{ type: "paragraph", content: [txt("body")] }] }],
		});
	assert.equal(panel("info"), `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>body</p></ac:rich-text-body></ac:structured-macro>`);
	assert.ok(panel("warning").includes(`ac:name="warning"`));
	assert.ok(panel("note").includes(`ac:name="note"`));
	assert.ok(panel("success").includes(`ac:name="tip"`));
	assert.ok(panel("error").includes(`ac:name="warning"`));
	// Library collapses tip/abstract/etc. to "custom" — degrades to info.
	assert.ok(panel("custom").includes(`ac:name="info"`));
	// No Cloud-style panelType parameter should be emitted.
	assert.ok(!panel("info").includes("panelType"));
});

test("panel title (same line) is lifted into the macro title parameter", () => {
	const out = convertAdfToStorageFormat({
		type: "doc",
		content: [
			{
				type: "panel",
				attrs: { panelType: "note" },
				content: [
					{ type: "paragraph", content: [txt("My note"), { type: "hardBreak" }, txt("body line")] },
				],
			},
		],
	});
	assert.equal(
		out,
		`<ac:structured-macro ac:name="note"><ac:parameter ac:name="title">My note</ac:parameter><ac:rich-text-body><p>body line</p></ac:rich-text-body></ac:structured-macro>`,
	);
});

test("panel title as its own paragraph (blank line) is lifted into the title", () => {
	const out = convertAdfToStorageFormat({
		type: "doc",
		content: [
			{
				type: "panel",
				attrs: { panelType: "warning" },
				content: [
					{ type: "paragraph", content: [txt("Warning")] },
					{ type: "paragraph", content: [txt("watch out")] },
				],
			},
		],
	});
	assert.ok(out.includes(`<ac:structured-macro ac:name="warning"><ac:parameter ac:name="title">Warning</ac:parameter>`), out);
	assert.ok(out.includes(`<ac:rich-text-body><p>watch out</p></ac:rich-text-body>`), out);
});

test("a leftover [!type] marker (trailing-whitespace case) never surfaces as a title", () => {
	// Library failed to strip the marker: first body text is the bare marker.
	const out = convertAdfToStorageFormat({
		type: "doc",
		content: [
			{
				type: "panel",
				attrs: { panelType: "note" },
				content: [
					{ type: "paragraph", content: [txt("[!note]"), { type: "hardBreak" }, txt("body")] },
				],
			},
		],
	});
	assert.equal(
		out,
		`<ac:structured-macro ac:name="note"><ac:rich-text-body><p>body</p></ac:rich-text-body></ac:structured-macro>`,
	);
	assert.ok(!out.includes("[!"), out);
});

test("a marker left in the body (inline-formatted first line) is stripped", () => {
	// Library failed to strip the marker because the first line had inline code.
	const out = convertAdfToStorageFormat({
		type: "doc",
		content: [
			{
				type: "panel",
				attrs: { panelType: "note" },
				content: [
					{
						type: "paragraph",
						content: [txt("[!note] See "), txt("id:", ["code"]), txt(" for details")],
					},
				],
			},
		],
	});
	assert.ok(!out.includes("[!"), out);
	assert.ok(out.includes(`<p>See <code>id:</code> for details</p>`), out);
});

test("unknown blockquote callout type falls back to info, never literal [!type]", () => {
	const out = convertAdfToStorageFormat({
		type: "doc",
		content: [
			{
				type: "blockquote",
				content: [{ type: "paragraph", content: [txt("[!whatever]\nbody")] }],
			},
		],
	});
	assert.ok(out.includes(`ac:name="info"`), out);
	assert.ok(!out.includes("[!"), `must not leak the marker: ${out}`);
});

test("integration: a wikilink inside a comment is removed, not linked", () => {
	let md = "keep %%[[Secret]]%% end";
	md = preprocessComments(md);
	const calls: string[] = [];
	md = preprocessWikilinks(md, {
		resolve: (t) => {
			calls.push(t);
			return publishable(t);
		},
	});
	assert.equal(md, "keep  end");
	assert.deepEqual(calls, [], "resolver not called for commented-out link");
});

