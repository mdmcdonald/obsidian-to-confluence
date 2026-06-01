/**
 * Pure string transforms for sanitising mermaid SVG before rasterisation.
 * Kept dependency-free (no mermaid/obsidian imports) so they can be unit-tested.
 */

export function escapeXmlText(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * Decode the HTML entities mermaid puts in its foreignObject labels (it
 * HTML-encodes label text, so `A & B` arrives as `A &amp; B`). Decoding here,
 * before escapeXmlText re-encodes for XML, makes `&amp;` render as `&` rather
 * than as the literal text "&amp;". `&amp;` is decoded last so a sequence like
 * `&amp;lt;` resolves to `&lt;`, not `<`.
 */
export function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;|&#0*39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
		.replace(/&amp;/g, "&");
}

/**
 * Extract the visible text lines from a mermaid foreignObject's inner HTML.
 * Honours `<br>` and block boundaries (`</div>`, `</p>`) as line breaks, strips
 * remaining tags, and decodes HTML entities so e.g. `Line1<br/>R &amp; D`
 * becomes ["Line1", "R & D"].
 */
export function extractLabelLines(inner: string): string[] {
	const withBreaks = inner
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(?:div|p)>/gi, "\n")
		.replace(/<[^>]+>/g, "");
	const decoded = decodeHtmlEntities(withBreaks);
	const lines = decoded
		.split("\n")
		.map((l) => l.replace(/\s+/g, " ").trim())
		.filter((l) => l.length > 0);
	return lines.length > 0 ? lines : [""];
}

function getAttr(attrs: string, name: string): string | undefined {
	const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
	return m ? m[1] : undefined;
}

/**
 * Replace every <foreignObject> in the SVG with a native SVG <text> at the
 * same centre. Electron's createImageBitmap and <img> data-URL paths both
 * refuse SVGs containing foreignObject — mermaid uses it for HTML labels in
 * most non-flowchart diagram types (sequence, class, state, ER, gantt, ...).
 *
 * Uses string replacement rather than DOMParser+XMLSerializer because a prior
 * commit (b1f8021 → reverted in 50775b6) found that round-tripping the
 * mermaid SVG through the DOM corrupted it in ways that broke rasterization.
 * HTML styling inside labels is lost; textual content (incl. <br> line breaks
 * and HTML entities like &amp;) survives.
 */
export function replaceForeignObjects(
	svg: string,
	onReplaced?: (count: number) => void,
): string {
	if (!svg.includes("<foreignObject")) return svg;
	let replaced = 0;
	const out = svg.replace(
		/<foreignObject\b([^>]*)>([\s\S]*?)<\/foreignObject>/gi,
		(_match, attrs: string, inner: string) => {
			replaced++;
			const x = parseFloat(getAttr(attrs, "x") || "0");
			const y = parseFloat(getAttr(attrs, "y") || "0");
			const width = parseFloat(getAttr(attrs, "width") || "0");
			const height = parseFloat(getAttr(attrs, "height") || "0");
			const cx = x + width / 2;
			const cy = y + height / 2;

			// Split into visual lines honouring <br> and block boundaries, with
			// HTML entities decoded (so "&amp;" → "&", "<br/>" → a line break).
			const lines = extractLabelLines(inner);

			const baseAttrs = `text-anchor="middle" font-family="sans-serif" font-size="14"`;
			if (lines.length === 1) {
				return `<text x="${cx}" y="${cy}" dominant-baseline="central" ${baseAttrs}>${escapeXmlText(lines[0])}</text>`;
			}
			const lineHeight = 16;
			const startY = cy - (lineHeight * (lines.length - 1)) / 2;
			const tspans = lines
				.map(
					(line, i) =>
						`<tspan x="${cx}" y="${startY + i * lineHeight}">${escapeXmlText(line)}</tspan>`,
				)
				.join("");
			return `<text ${baseAttrs}>${tspans}</text>`;
		},
	);
	if (replaced > 0) onReplaced?.(replaced);
	return out;
}

/**
 * Drop any inline `background:` style that mermaid attaches to elements —
 * the previous SVGMermaidRenderer found these caused some renderers to
 * reject the SVG. Run before dimension fix-up.
 */
export function stripBackgroundStyles(svg: string): string {
	return svg.replace(/style="([^"]*)"/gi, (_m, style: string) => {
		const cleaned = style
			.split(";")
			.map((s) => s.trim())
			.filter((s) => s.length > 0 && !/^background\s*:/i.test(s))
			.join("; ");
		return `style="${cleaned}"`;
	});
}
