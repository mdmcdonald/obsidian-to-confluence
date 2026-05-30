/**
 * Converts Atlassian Document Format (ADF) JSON to Confluence storage format (XHTML).
 *
 * The @markdown-confluence/lib Publisher sends content as atlas_doc_format,
 * but many Confluence instances silently ignore it. This converter produces
 * the universally-supported storage (XHTML) format instead, without needing
 * to call any Confluence API endpoint.
 */

import {
	decodeWikilink,
	WIKILINK_SENTINEL_PREFIX,
	WikilinkPayload,
	decodeMetadataBlock,
	METADATA_FENCE_LANG,
	MetaField,
} from "./obsidianPreprocess";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdfNode = any;

// Obsidian highlight ==text==. Confluence DC has no native highlight feature or
// macro (Cloud-only), so we emit a best-effort inline span. background-color on
// a span renders in DC but is undocumented and may be normalised/stripped on a
// later editor round-trip; rgb() matches what Confluence's editor itself emits.
// rgb(255,248,179) == #fff8b3, an Obsidian-yellow.
const HIGHLIGHT_OPEN = `<span style="background-color: rgb(255,248,179)">`;
const HIGHLIGHT_CLOSE = `</span>`;

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// Inline HTML the parser (html:false) hands us as literal text but which is
// valid in Confluence storage format — authors use these in markdown (notably
// <br> for line breaks in table cells, and <sub>/<sup> for technical notation).
const SAFE_INLINE_HTML = new Set([
	"br", "sub", "sup", "b", "strong", "i", "em", "u", "s", "del", "ins",
	"kbd", "abbr", "mark", "small", "cite", "q", "var", "samp",
]);
const INLINE_TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^<>]*?(\/?)>/g;

/**
 * Like escapeHtml, but passes a whitelist of safe inline HTML tags through
 * unescaped (attributes stripped; `<br>` normalised to `<br/>`). Used for plain
 * text nodes so e.g. `a<br>b` and `H<sub>2</sub>O` render rather than showing
 * literal `&lt;br&gt;`. A `<` that is not one of these tags (`a < b`, `x<5`,
 * `<note>`) is still escaped normally.
 */
function escapeHtmlAllowingInline(text: string): string {
	if (text.indexOf("<") === -1) return escapeHtml(text);
	let out = "";
	let last = 0;
	let m: RegExpExecArray | null;
	INLINE_TAG_RE.lastIndex = 0;
	while ((m = INLINE_TAG_RE.exec(text)) !== null) {
		const tag = m[2].toLowerCase();
		if (!SAFE_INLINE_HTML.has(tag)) continue;
		out += escapeHtml(text.slice(last, m.index));
		if (tag === "br") out += "<br/>";
		else if (m[1] === "/") out += `</${tag}>`;
		else if (m[3] === "/") out += `<${tag}/>`;
		else out += `<${tag}>`;
		last = INLINE_TAG_RE.lastIndex;
	}
	out += escapeHtml(text.slice(last));
	return out;
}

function convertChildren(node: AdfNode): string {
	if (!node.content || !Array.isArray(node.content)) return "";
	return node.content.map(convertNode).join("");
}

function convertText(node: AdfNode): string {
	// Inline LaTeX: text with a `code` mark whose content is prefixed with
	// "latex-math-inline:" was produced by LatexPreprocessor. Emit the
	// Appfire mathinline macro and skip the normal code wrapping.
	const rawText: string = node.text ?? "";
	const hasCodeMark =
		Array.isArray(node.marks) &&
		node.marks.some((m: AdfNode) => m?.type === "code");

	// Wikilink: an inline-code sentinel produced by preprocessWikilinks carrying
	// the resolved Confluence page title / anchor / display. Emit an ac:link.
	if (hasCodeMark && rawText.startsWith(WIKILINK_SENTINEL_PREFIX)) {
		const payload = decodeWikilink(rawText);
		if (payload) return renderWikilink(payload);
		// Should not happen (we encode these ourselves) — surface it rather
		// than silently emitting the raw sentinel as code.
		console.warn(`[ADF→Storage] Failed to decode wikilink sentinel: ${rawText.slice(0, 80)}`);
	}

	const LATEX_INLINE_PREFIX = "latex-math-inline:";
	if (hasCodeMark && rawText.startsWith(LATEX_INLINE_PREFIX)) {
		const eq = rawText.substring(LATEX_INLINE_PREFIX.length);
		return (
			`<ac:structured-macro ac:name="mathinline">` +
			`<ac:parameter ac:name="body">${escapeHtml(eq)}</ac:parameter>` +
			`</ac:structured-macro>`
		);
	}

	// Inline code stays fully escaped (literal); other text may contain a small
	// whitelist of inline HTML (e.g. <br>, <sub>) that should render.
	let html = hasCodeMark ? escapeHtml(rawText) : escapeHtmlAllowingInline(rawText);
	if (node.marks && Array.isArray(node.marks)) {
		// Apply marks inside-out (first mark is outermost)
		for (const mark of [...node.marks].reverse()) {
			html = applyMark(mark, html);
		}
	}
	return html;
}

function escapeCdataEnd(text: string): string {
	// CDATA sections terminate at "]]>". Splitting it into two CDATA sections
	// preserves the literal bytes safely.
	return text.replace(/]]>/g, "]]]]><![CDATA[>");
}

function renderWikilink(p: WikilinkPayload): string {
	const body = `<ac:plain-text-link-body><![CDATA[${escapeCdataEnd(p.display ?? "")}]]></ac:plain-text-link-body>`;
	// Confluence heading auto-anchors are the heading text with whitespace
	// removed (case + punctuation preserved) — verified against Atlassian DC
	// docs. NB: fragile for headings with special characters, but the page
	// link still resolves even when the anchor does not.
	const anchorAttr = p.anchor
		? ` ac:anchor="${escapeHtml(p.anchor.replace(/\s+/g, ""))}"`
		: "";
	if (p.kind === "anchor") {
		// Same-page heading link — no <ri:page>.
		return `<ac:link${anchorAttr}>${body}</ac:link>`;
	}
	return (
		`<ac:link${anchorAttr}>` +
		`<ri:page ri:content-title="${escapeHtml(p.title ?? "")}" />` +
		body +
		`</ac:link>`
	);
}

/**
 * Render a frontmatter metadata block as a Confluence Page Properties (details)
 * macro: a 2-column property/value table. Relationship values resolved to a page
 * become ac:links; everything else is plain text. The details macro also lets
 * Confluence roll these up in a Page Properties Report.
 */
function renderMetadataPanel(fields: MetaField[]): string {
	const rows = fields
		.filter((f) => f.values && f.values.length > 0)
		.map((f) => {
			const vals = f.values
				.map((v) =>
					v.link
						? renderWikilink({
								kind: "page",
								title: v.link.title,
								anchor: v.link.anchor,
								display: v.link.display,
							})
						: escapeHtmlAllowingInline(v.text),
				)
				.join(", ");
			return `<tr><th><p>${escapeHtml(f.label)}</p></th><td><p>${vals}</p></td></tr>`;
		})
		.join("");
	if (!rows) return "";
	return (
		`<ac:structured-macro ac:name="details">` +
		`<ac:rich-text-body><table><tbody>${rows}</tbody></table></ac:rich-text-body>` +
		`</ac:structured-macro>`
	);
}

// --- Obsidian highlight (==text==) rendering ------------------------------
// `==` passes through the library's CommonMark parser as literal text, so the
// markers survive into the ADF (split across sibling nodes when the highlight
// wraps formatting, e.g. ==**bold**==). We detect them on the flattened inline
// token stream so inner formatting is preserved.

function isScannableText(node: AdfNode): boolean {
	if (!node || node.type !== "text" || typeof node.text !== "string") return false;
	// Highlights never apply inside inline code / our sentinels.
	if (Array.isArray(node.marks) && node.marks.some((m: AdfNode) => m?.type === "code")) {
		return false;
	}
	return true;
}

type InlineToken = { marker: true } | { marker: false; node: AdfNode };

function leadingNonSpace(node: AdfNode): boolean {
	if (node?.type === "text" && typeof node.text === "string") return /^\S/.test(node.text);
	return true; // formatted / atomic inline node — treat as visible content
}
function trailingNonSpace(node: AdfNode): boolean {
	if (node?.type === "text" && typeof node.text === "string") return /\S$/.test(node.text);
	return true;
}

/**
 * Render an inline content array, converting Obsidian highlight runs
 * (==text==) into background-color spans while preserving any inner formatting.
 *
 * Pairing is non-nested and honours CommonMark flanking: an opening `==` must
 * be immediately followed by a non-space character and a closing `==`
 * immediately preceded by one, matching Obsidian's reading-view behaviour
 * (so `== text ==` is NOT a highlight). Unpaired markers render literally.
 */
function convertInlineContent(content: AdfNode[] | undefined): string {
	if (!Array.isArray(content) || content.length === 0) return "";

	// 1. Flatten to tokens, splitting scannable text nodes on "==".
	const toks: InlineToken[] = [];
	for (const node of content) {
		// Drop empty text nodes: they render to nothing but would break the
		// flanking adjacency check (a "" neighbour has no leading/trailing char).
		if (node?.type === "text" && node.text === "") continue;
		if (!isScannableText(node)) {
			toks.push({ marker: false, node });
			continue;
		}
		const text: string = node.text;
		let last = 0;
		let idx = text.indexOf("==", last);
		if (idx < 0) {
			toks.push({ marker: false, node });
			continue;
		}
		while (idx >= 0) {
			if (idx > last) {
				toks.push({ marker: false, node: { ...node, text: text.slice(last, idx) } });
			}
			toks.push({ marker: true });
			last = idx + 2;
			idx = text.indexOf("==", last);
		}
		if (last < text.length) {
			toks.push({ marker: false, node: { ...node, text: text.slice(last) } });
		}
	}

	// 2. Pair markers (first valid opener → next valid closer).
	const canOpen = (i: number): boolean => {
		const t = toks[i + 1];
		return !!t && !t.marker && leadingNonSpace(t.node);
	};
	const canClose = (i: number): boolean => {
		const t = toks[i - 1];
		return !!t && !t.marker && trailingNonSpace(t.node);
	};
	const openMarkers = new Set<number>();
	const closeMarkers = new Set<number>();
	let pendingOpen: number | null = null;
	for (let i = 0; i < toks.length; i++) {
		if (!toks[i].marker) continue;
		if (pendingOpen === null) {
			if (canOpen(i)) pendingOpen = i;
		} else if (canClose(i)) {
			openMarkers.add(pendingOpen);
			closeMarkers.add(i);
			pendingOpen = null;
		}
	}

	// 3. Emit.
	let out = "";
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i];
		if (t.marker) {
			if (openMarkers.has(i)) out += HIGHLIGHT_OPEN;
			else if (closeMarkers.has(i)) out += HIGHLIGHT_CLOSE;
			else out += "==";
		} else {
			out += convertNode(t.node);
		}
	}
	return out;
}

function applyMark(mark: AdfNode, innerHtml: string): string {
	switch (mark.type) {
		case "strong":
			return `<strong>${innerHtml}</strong>`;
		case "em":
			return `<em>${innerHtml}</em>`;
		case "code":
			return `<code>${innerHtml}</code>`;
		case "strike":
			return `<s>${innerHtml}</s>`;
		case "underline":
			return `<u>${innerHtml}</u>`;
		case "subsup":
			if (mark.attrs?.type === "sub") return `<sub>${innerHtml}</sub>`;
			if (mark.attrs?.type === "sup") return `<sup>${innerHtml}</sup>`;
			return innerHtml;
		case "textColor":
			return `<span style="color: ${escapeHtml(mark.attrs?.color ?? "")}">${innerHtml}</span>`;
		case "link": {
			const href: string = mark.attrs?.href ?? "";
			// A leftover "wikilinks:" href means the library parsed a [[...]] we
			// did not preprocess — e.g. the [[...]] inside an embed ![[...]].
			// Render as plain text rather than emit a broken anchor.
			if (href.startsWith("wikilinks:")) return innerHtml;
			return `<a href="${escapeHtml(href)}">${innerHtml}</a>`;
		}
		default:
			return innerHtml;
	}
}

function convertCodeBlock(node: AdfNode): string {
	const language = node.attrs?.language;
	const code = node.content
		?.map((child: AdfNode) => child.text ?? "")
		.join("") ?? "";

	// Metadata panel: a fenced sentinel produced from frontmatter by the adaptor.
	// Emit a Confluence Page Properties (details) macro.
	if (language === METADATA_FENCE_LANG) {
		const fields = decodeMetadataBlock(code);
		return fields ? renderMetadataPanel(fields) : "";
	}

	// Block LaTeX: language sentinel set by LatexPreprocessor. Emit the
	// Appfire mathblock macro instead of a generic code macro.
	if (language === "latex-math-block") {
		return (
			`<ac:structured-macro ac:name="mathblock">` +
			`<ac:plain-text-body><![CDATA[${escapeCdataEnd(code)}]]></ac:plain-text-body>` +
			`</ac:structured-macro>`
		);
	}

	const langParam = language
		? `<ac:parameter ac:name="language">${escapeHtml(language)}</ac:parameter>`
		: "";
	return (
		`<ac:structured-macro ac:name="code">` +
		langParam +
		`<ac:plain-text-body><![CDATA[${code}]]></ac:plain-text-body>` +
		`</ac:structured-macro>`
	);
}

// Module-level reference to the active file map during conversion.
// Set by convertAdfToStorageFormat() and used by convertMedia() to resolve
// attachment filenames for media nodes that only have collection/id (e.g. mermaid).
let activeFileMap: Map<string, string> | undefined;

function convertMedia(node: AdfNode): string {
	const attrs = node.attrs ?? {};
	let filename = attrs.__fileName || attrs.alt || "";
	const width = attrs.width ? ` ac:width="${attrs.width}"` : "";

	if (attrs.type === "external") {
		return (
			`<ac:image${width}>` +
			`<ri:url ri:value="${escapeHtml(attrs.url ?? "")}" />` +
			`</ac:image>`
		);
	}

	// If no filename, try resolving from the attachment file map (populated
	// from attachment upload responses). This handles media nodes created by
	// MermaidRendererPlugin which only have collection/id but no __fileName.
	if (!filename && attrs.id && activeFileMap) {
		const lookupId = String(attrs.id);
		filename = activeFileMap.get(lookupId) ?? "";
		console.log(`[ADF→Storage] Media filename lookup: id="${lookupId}" → ${filename ? `"${filename}"` : "(not found)"}, map size=${activeFileMap.size}`);
	}

	// File attachment
	if (filename) {
		return (
			`<ac:image${width}>` +
			`<ri:attachment ri:filename="${escapeHtml(filename)}" />` +
			`</ac:image>`
		);
	}

	// Fallback: no filename could be resolved
	console.warn(`[ADF→Storage] Media node with no resolvable filename: id=${attrs.id}, collection=${attrs.collection}`);
	return "";
}

// ADF panelType → Confluence DC admonition macro name. DC has NO generic
// "panel" macro that understands a panelType parameter (that is Cloud/ADF
// only) — info/note/warning/tip are separate first-class macros. The bundled
// library pre-converts Obsidian callouts to panel nodes but collapses many
// types (tip, abstract, todo, question, example, quote, bug, danger) to
// "custom" before we see them, so those degrade to "info".
const PANEL_TYPE_TO_DC_MACRO: Record<string, string> = {
	info: "info",
	note: "note",
	warning: "warning",
	error: "warning",
	success: "tip",
	custom: "info",
};

/**
 * The library bakes the callout title (the user's title, or the capitalised
 * type when none was given) into the panel body as the first text node,
 * followed by a hardBreak before the body (same source line) or as its own
 * paragraph (blank line after the marker). Lift it into the macro's `title`
 * parameter so it renders in the panel header, matching convertCallout. Falls
 * back to leaving the node untouched for any shape we don't recognise.
 */
function extractPanelTitle(node: AdfNode): { title: string | undefined; body: AdfNode } {
	const content = node.content;
	if (!Array.isArray(content) || content.length === 0) return { title: undefined, body: node };
	const first = content[0];
	if (first?.type !== "paragraph" || !Array.isArray(first.content) || first.content.length === 0) {
		return { title: undefined, body: node };
	}
	const inline = first.content;
	const head = inline[0];
	if (head?.type !== "text" || typeof head.text !== "string" || head.text.length === 0) {
		return { title: undefined, body: node };
	}
	// Title + hardBreak + rest of the body on the same source line.
	if (inline.length >= 2 && inline[1]?.type === "hardBreak") {
		const rest = inline.slice(2);
		const restParas = rest.length > 0 ? [{ ...first, content: rest }] : [];
		const body = { ...node, content: [...restParas, ...content.slice(1)] };
		if (Array.isArray(body.content) && body.content.length > 0) {
			return { title: head.text, body };
		}
		return { title: undefined, body: node }; // would leave an empty body — keep inline
	}
	// Title is its own paragraph (blank line separated it from the body).
	if (inline.length === 1 && content.length >= 2) {
		return { title: head.text, body: { ...node, content: content.slice(1) } };
	}
	return { title: undefined, body: node };
}

/**
 * The bundled library sometimes fails to strip the `[!type]` marker — e.g. when
 * trailing whitespace after the marker becomes a markdown hard break — leaving
 * it in the title text. Strip a leftover marker so it never surfaces literally.
 */
function stripLeftoverCalloutMarker(title: string): string | undefined {
	const m = title.match(/^[\t ]*\[!([a-zA-Z]+)\][-+]?[\t ]*(.*)$/);
	if (!m) return title;
	const rest = m[2].trim();
	return rest.length > 0 ? rest : undefined;
}

/**
 * Remove a leading `[!type]` marker the library left in the panel body. It
 * fails to strip the marker when the callout's first line carries inline
 * formatting (inline code, math, links), leaving e.g. "[!note] …" as the first
 * body text. If the marker was the whole first text node, also drop a following
 * hardBreak (the trailing-whitespace case).
 */
function stripLeadingMarker(node: AdfNode): AdfNode {
	const content = node.content;
	if (!Array.isArray(content) || content.length === 0) return node;
	const first = content[0];
	if (first?.type !== "paragraph" || !Array.isArray(first.content) || first.content.length === 0) {
		return node;
	}
	const inline = first.content;
	const head = inline[0];
	if (head?.type !== "text" || typeof head.text !== "string") return node;
	const m = head.text.match(/^[\t ]*\[!([a-zA-Z]+)\][-+]?[\t ]*/);
	if (!m) return node;
	const rest = head.text.slice(m[0].length);
	let newInline: AdfNode[];
	if (rest.length > 0) {
		newInline = [{ ...head, text: rest }, ...inline.slice(1)];
	} else {
		newInline = inline.slice(1);
		if (newInline[0]?.type === "hardBreak") newInline = newInline.slice(1);
	}
	const newContent =
		newInline.length > 0
			? [{ ...first, content: newInline }, ...content.slice(1)]
			: content.slice(1);
	return { ...node, content: newContent };
}

function convertPanel(node: AdfNode): string {
	const panelType: string = node.attrs?.panelType ?? "info";
	const macro = PANEL_TYPE_TO_DC_MACRO[panelType] ?? "info";
	const extracted = extractPanelTitle(stripLeadingMarker(node));
	const body = extracted.body;
	const title = extracted.title !== undefined ? stripLeftoverCalloutMarker(extracted.title) : undefined;
	const titleParam = title
		? `<ac:parameter ac:name="title">${escapeHtml(title)}</ac:parameter>`
		: "";
	return (
		`<ac:structured-macro ac:name="${macro}">` +
		titleParam +
		`<ac:rich-text-body>${convertChildren(body)}</ac:rich-text-body>` +
		`</ac:structured-macro>`
	);
}

// Obsidian callout type → Confluence built-in panel macro name.
// Confluence DC has info / note / tip / warning as first-class macros;
// anything not on that list maps to the closest fit.
const CALLOUT_TYPE_MAP: Record<string, string> = {
	info: "info",
	abstract: "info",
	summary: "info",
	tldr: "info",
	example: "info",
	note: "note",
	todo: "note",
	question: "note",
	help: "note",
	important: "note",
	tip: "tip",
	hint: "tip",
	success: "tip",
	check: "tip",
	done: "tip",
	warning: "warning",
	caution: "warning",
	attention: "warning",
	failure: "warning",
	fail: "warning",
	missing: "warning",
	danger: "warning",
	error: "warning",
	bug: "warning",
};

/**
 * Detect an Obsidian callout encoded as a blockquote whose first paragraph
 * starts with `[!type]` (optionally `[!type]+` / `[!type]-` for foldable,
 * and an optional title on the same line). Returns the Confluence macro
 * name, optional title, and a modified node tree with the marker stripped.
 * Returns null if this isn't a callout — caller falls back to plain
 * blockquote rendering.
 *
 * NB: the bundled library's own callout plugin normally pre-converts
 * `> [!type]` blockquotes into `panel` nodes (handled by convertPanel) before
 * we get here, so this path is a fallback. It is kept because it maps the
 * original callout type directly (preserving e.g. `tip`, which the library
 * otherwise collapses to a generic "custom" panel).
 */
function detectCallout(blockquote: AdfNode):
	| { macro: string; title: string | undefined; body: AdfNode }
	| null {
	const content = blockquote?.content;
	if (!Array.isArray(content) || content.length === 0) return null;
	const firstPara = content[0];
	if (firstPara?.type !== "paragraph") return null;
	const paraContent = firstPara.content;
	if (!Array.isArray(paraContent) || paraContent.length === 0) return null;
	const firstText = paraContent[0];
	if (firstText?.type !== "text" || typeof firstText.text !== "string") return null;

	// `[!type]` at the very start, optional fold marker, optional title up to newline.
	const m = firstText.text.match(/^\[!([a-zA-Z]+)\][+-]?[\t ]*([^\n]*)/);
	if (!m) return null;
	const calloutType = m[1].toLowerCase();
	// Unknown callout types fall back to an info panel (matching Obsidian, which
	// renders an unrecognised [!type] as a default callout) rather than leaking
	// the literal `[!type]` marker into the page as a plain blockquote.
	const macro = CALLOUT_TYPE_MAP[calloutType] ?? "info";

	const restOfFirstLine = m[2].trim();
	const remainderAfterMarker = firstText.text.substring(m[0].length).replace(/^\n/, "");

	// Build a body that's the blockquote stripped of the marker line.
	let bodyFirstPara: AdfNode | null;
	if (remainderAfterMarker.length === 0 && paraContent.length === 1) {
		// Whole first paragraph was just the marker (title may have been on
		// same line and is now consumed). Drop the paragraph entirely.
		bodyFirstPara = null;
	} else {
		const newFirstTextNodes: AdfNode[] = [];
		if (remainderAfterMarker.length > 0) {
			newFirstTextNodes.push({ ...firstText, text: remainderAfterMarker });
		}
		bodyFirstPara = {
			...firstPara,
			content: [...newFirstTextNodes, ...paraContent.slice(1)],
		};
		// If the first paragraph still has zero content nodes after stripping,
		// drop it (avoid emitting an empty <p></p>).
		if (Array.isArray(bodyFirstPara.content) && bodyFirstPara.content.length === 0) {
			bodyFirstPara = null;
		}
	}

	const bodyContent = bodyFirstPara
		? [bodyFirstPara, ...content.slice(1)]
		: content.slice(1);

	return {
		macro,
		title: restOfFirstLine.length > 0 ? restOfFirstLine : undefined,
		body: { ...blockquote, content: bodyContent },
	};
}

function convertCallout(macro: string, title: string | undefined, body: AdfNode): string {
	const titleParam = title
		? `<ac:parameter ac:name="title">${escapeHtml(title)}</ac:parameter>`
		: "";
	return (
		`<ac:structured-macro ac:name="${macro}">` +
		titleParam +
		`<ac:rich-text-body>${convertChildren(body)}</ac:rich-text-body>` +
		`</ac:structured-macro>`
	);
}

function convertExpand(node: AdfNode): string {
	const title = node.attrs?.title ?? "";
	return (
		`<ac:structured-macro ac:name="expand">` +
		`<ac:parameter ac:name="title">${escapeHtml(title)}</ac:parameter>` +
		`<ac:rich-text-body>${convertChildren(node)}</ac:rich-text-body>` +
		`</ac:structured-macro>`
	);
}

function cellPlainText(node: AdfNode): string {
	const collect = (n: AdfNode): string => {
		if (!n) return "";
		if (n.type === "text") return n.text ?? "";
		if (Array.isArray(n.content)) return n.content.map(collect).join("");
		return "";
	};
	return collect(node).trim();
}

// A measurement-like cell: a number (optionally a comparator/sign prefix, a
// short unit, or a numeric range). Markdown table alignment (:---:) is discarded
// by the bundled parser, so we right-align columns that are mostly numeric — the
// main thing that makes data tables look professional.
function isNumericCell(text: string): boolean {
	const t = text.replace(/^[<>≤≥~±=\s]+/, "").trim();
	if (!/^[0-9]/.test(t)) return false;
	return /^[0-9][0-9.,]*( ?[a-zA-Z%×°µ/]{1,6})?( ?[-–—] ?[0-9][0-9.,]*( ?[a-zA-Z%×°µ/]{1,6})?)?$/.test(t);
}

// Empty / placeholder cells are neutral — they shouldn't stop a numeric column
// from being right-aligned.
function isPlaceholderCell(text: string): boolean {
	return text === "" || /^(n\/?a|tbd|tbc|—|–|-{1,3}|\.{1,3}|\?|✓|✗|✔|✘|x)$/i.test(text);
}

function convertTable(node: AdfNode): string {
	const width = node.attrs?.width;
	const layout = node.attrs?.layout;
	let style = "";
	if (width) style += `width: ${width}px;`;
	const styleAttr = style ? ` style="${style}"` : "";
	const classAttr = layout ? ` class="${escapeHtml(layout)}"` : "";

	const rows: AdfNode[] = Array.isArray(node.content) ? node.content : [];
	// Decide per-column right-alignment from the data rows (skip the header).
	const numeric: number[] = [];
	const dataCount: number[] = [];
	rows.forEach((row, ri) => {
		if (ri === 0) return;
		let ci = 0;
		(row.content ?? []).forEach((cell: AdfNode) => {
			const txt = cellPlainText(cell);
			if (!isPlaceholderCell(txt)) {
				dataCount[ci] = (dataCount[ci] ?? 0) + 1;
				if (isNumericCell(txt)) numeric[ci] = (numeric[ci] ?? 0) + 1;
			}
			ci += Math.max(1, cell.attrs?.colspan ?? 1);
		});
	});
	const rightCol = dataCount.map(
		(dc, ci) => dc >= 2 && (numeric[ci] ?? 0) >= dc * 0.6,
	);

	const body = rows
		.map((row) => {
			let ci = 0;
			const cells = (row.content ?? [])
				.map((cell: AdfNode) => {
					const tag = cell.type === "tableHeader" ? "th" : "td";
					const align = rightCol[ci] ? "right" : undefined;
					ci += Math.max(1, cell.attrs?.colspan ?? 1);
					return convertTableCell(tag, cell, align);
				})
				.join("");
			return `<tr>${cells}</tr>`;
		})
		.join("");
	return `<table${classAttr}${styleAttr}><tbody>${body}</tbody></table>`;
}

function convertTableCell(tag: string, node: AdfNode, align?: string): string {
	const attrs = node.attrs ?? {};
	const parts: string[] = [];
	if (attrs.colspan && attrs.colspan > 1) parts.push(` colspan="${attrs.colspan}"`);
	if (attrs.rowspan && attrs.rowspan > 1) parts.push(` rowspan="${attrs.rowspan}"`);
	const styles: string[] = [];
	if (attrs.background) styles.push(`background-color: ${escapeHtml(attrs.background)}`);
	if (align) styles.push(`text-align: ${align}`);
	if (styles.length) parts.push(` style="${styles.join("; ")}"`);
	// convertInlineContent (not convertChildren) so ==highlights== render in
	// cells too. Harmless when a cell wraps block content (paragraphs): those
	// nodes are passed through convertNode unchanged.
	return `<${tag}${parts.join("")}>${convertInlineContent(node.content)}</${tag}>`;
}

function convertNode(node: AdfNode): string {
	if (!node || !node.type) return "";

	switch (node.type) {
		case "doc":
			return convertChildren(node);
		case "paragraph":
			return `<p>${convertInlineContent(node.content)}</p>`;
		case "heading": {
			const level = node.attrs?.level ?? 1;
			return `<h${level}>${convertInlineContent(node.content)}</h${level}>`;
		}
		case "text":
			return convertText(node);
		case "hardBreak":
			return `<br />`;
		case "rule":
			return `<hr />`;
		case "bulletList":
			return `<ul>${convertChildren(node)}</ul>`;
		case "orderedList":
			return `<ol>${convertChildren(node)}</ol>`;
		case "listItem":
			return `<li>${convertChildren(node)}</li>`;
		case "blockquote": {
			const callout = detectCallout(node);
			if (callout) {
				return convertCallout(callout.macro, callout.title, callout.body);
			}
			return `<blockquote>${convertChildren(node)}</blockquote>`;
		}
		case "codeBlock":
			return convertCodeBlock(node);
		case "table":
			return convertTable(node);
		case "tableRow":
			return `<tr>${convertChildren(node)}</tr>`;
		case "tableHeader":
			return convertTableCell("th", node);
		case "tableCell":
			return convertTableCell("td", node);
		case "mediaSingle":
			return convertChildren(node);
		case "mediaGroup":
			return convertChildren(node);
		case "media":
			return convertMedia(node);
		case "inlineCard":
			return `<a href="${escapeHtml(node.attrs?.url ?? "")}">${escapeHtml(node.attrs?.url ?? "")}</a>`;
		case "emoji":
			return node.attrs?.text ?? node.attrs?.shortName ?? "";
		case "panel":
			return convertPanel(node);
		case "expand":
		case "nestedExpand":
			return convertExpand(node);
		case "status": {
			const text = node.attrs?.text ?? "";
			const color = node.attrs?.color ?? "neutral";
			return (
				`<ac:structured-macro ac:name="status">` +
				`<ac:parameter ac:name="title">${escapeHtml(text)}</ac:parameter>` +
				`<ac:parameter ac:name="colour">${escapeHtml(color)}</ac:parameter>` +
				`</ac:structured-macro>`
			);
		}
		case "taskList":
			return `<ul class="task-list">${convertChildren(node)}</ul>`;
		case "taskItem": {
			const checked = node.attrs?.state === "DONE" ? "checked " : "";
			return `<li><ac:task><ac:task-status>${checked ? "complete" : "incomplete"}</ac:task-status><ac:task-body>${convertInlineContent(node.content)}</ac:task-body></ac:task></li>`;
		}
		case "mention": {
			const accountId = node.attrs?.id ?? "";
			return `<ac:link><ri:user ri:account-id="${escapeHtml(accountId)}" /></ac:link>`;
		}
		default:
			// Unknown node type: render children if any, otherwise empty
			console.warn(`[ADF→Storage] Unknown node type: ${node.type}`);
			return convertChildren(node);
	}
}

/**
 * Convert an ADF document (as parsed JSON object) to Confluence storage format XHTML.
 * @param adf The ADF document JSON
 * @param fileMap Optional map of attachment ID → filename, used to resolve media nodes
 *               that only have id/collection (e.g. mermaid chart attachments)
 */
export function convertAdfToStorageFormat(adf: AdfNode, fileMap?: Map<string, string>): string {
	activeFileMap = fileMap;
	try {
		if (!adf) return "";
		if (adf.type === "doc") {
			return convertChildren(adf);
		}
		// If it's not a doc node, try to convert it directly
		return convertNode(adf);
	} finally {
		activeFileMap = undefined;
	}
}
