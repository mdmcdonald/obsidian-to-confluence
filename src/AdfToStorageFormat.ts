/**
 * Converts Atlassian Document Format (ADF) JSON to Confluence storage format (XHTML).
 *
 * The @markdown-confluence/lib Publisher sends content as atlas_doc_format,
 * but many Confluence instances silently ignore it. This converter produces
 * the universally-supported storage (XHTML) format instead, without needing
 * to call any Confluence API endpoint.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdfNode = any;

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function convertChildren(node: AdfNode): string {
	if (!node.content || !Array.isArray(node.content)) return "";
	return node.content.map(convertNode).join("");
}

function convertText(node: AdfNode): string {
	let html = escapeHtml(node.text ?? "");
	if (node.marks && Array.isArray(node.marks)) {
		// Apply marks inside-out (first mark is outermost)
		for (const mark of [...node.marks].reverse()) {
			html = applyMark(mark, html);
		}
	}
	return html;
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
		case "link":
			return `<a href="${escapeHtml(mark.attrs?.href ?? "")}">${innerHtml}</a>`;
		default:
			return innerHtml;
	}
}

function convertCodeBlock(node: AdfNode): string {
	const language = node.attrs?.language;
	const code = node.content
		?.map((child: AdfNode) => child.text ?? "")
		.join("") ?? "";
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

function convertMedia(node: AdfNode): string {
	const attrs = node.attrs ?? {};
	const filename = attrs.__fileName || attrs.alt || "";
	const width = attrs.width ? ` ac:width="${attrs.width}"` : "";

	if (attrs.type === "external") {
		return (
			`<ac:image${width}>` +
			`<ri:url ri:value="${escapeHtml(attrs.url ?? "")}" />` +
			`</ac:image>`
		);
	}

	// File attachment
	if (filename) {
		return (
			`<ac:image${width}>` +
			`<ri:attachment ri:filename="${escapeHtml(filename)}" />` +
			`</ac:image>`
		);
	}

	// Fallback: if we have a collection/id but no filename, try attachment by ID
	return "";
}

function convertPanel(node: AdfNode): string {
	const panelType = node.attrs?.panelType ?? "info";
	return (
		`<ac:structured-macro ac:name="panel">` +
		`<ac:parameter ac:name="panelType">${escapeHtml(panelType)}</ac:parameter>` +
		`<ac:rich-text-body>${convertChildren(node)}</ac:rich-text-body>` +
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

function convertTable(node: AdfNode): string {
	const width = node.attrs?.width;
	const layout = node.attrs?.layout;
	let style = "";
	if (width) style += `width: ${width}px;`;
	const styleAttr = style ? ` style="${style}"` : "";
	const classAttr = layout ? ` class="${escapeHtml(layout)}"` : "";
	return `<table${classAttr}${styleAttr}><tbody>${convertChildren(node)}</tbody></table>`;
}

function convertTableCell(tag: string, node: AdfNode): string {
	const attrs = node.attrs ?? {};
	const parts: string[] = [];
	if (attrs.colspan && attrs.colspan > 1) parts.push(` colspan="${attrs.colspan}"`);
	if (attrs.rowspan && attrs.rowspan > 1) parts.push(` rowspan="${attrs.rowspan}"`);
	if (attrs.background) parts.push(` style="background-color: ${escapeHtml(attrs.background)}"`);
	return `<${tag}${parts.join("")}>${convertChildren(node)}</${tag}>`;
}

function convertNode(node: AdfNode): string {
	if (!node || !node.type) return "";

	switch (node.type) {
		case "doc":
			return convertChildren(node);
		case "paragraph":
			return `<p>${convertChildren(node)}</p>`;
		case "heading": {
			const level = node.attrs?.level ?? 1;
			return `<h${level}>${convertChildren(node)}</h${level}>`;
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
		case "blockquote":
			return `<blockquote>${convertChildren(node)}</blockquote>`;
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
			return `<li><ac:task><ac:task-status>${checked ? "complete" : "incomplete"}</ac:task-status><ac:task-body>${convertChildren(node)}</ac:task-body></ac:task></li>`;
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
 */
export function convertAdfToStorageFormat(adf: AdfNode): string {
	if (!adf) return "";
	if (adf.type === "doc") {
		return convertChildren(adf);
	}
	// If it's not a doc node, try to convert it directly
	return convertNode(adf);
}
