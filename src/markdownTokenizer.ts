/**
 * Shared markdown segmentation used by the preprocessing passes
 * (LaTeX math, Obsidian comments, wikilinks).
 *
 * It splits a markdown document into "text" segments and "protected" segments.
 * Protected segments are fenced code blocks (``` / ~~~), indented-fence content,
 * and inline code spans (`...`). Preprocessors transform only the text segments,
 * so Obsidian syntax that happens to appear inside code is left untouched.
 *
 * Concatenating every segment's `text` reproduces the input byte-for-byte.
 *
 * Assumes LF (\n) line endings — callers normalise CRLF before preprocessing.
 */

export interface Segment {
	kind: "text" | "protected";
	text: string;
}

function tokenizeInlineCode(text: string): Segment[] {
	const segments: Segment[] = [];
	const re = /`([^`\n]+)`/g;
	let lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		if (m.index > lastIndex) {
			segments.push({ kind: "text", text: text.slice(lastIndex, m.index) });
		}
		segments.push({ kind: "protected", text: m[0] });
		lastIndex = m.index + m[0].length;
	}
	if (lastIndex < text.length) {
		segments.push({ kind: "text", text: text.slice(lastIndex) });
	}
	return segments;
}

/**
 * Split markdown into text / protected segments. Fenced code blocks are
 * protected wholesale; remaining text is further split on inline code spans.
 */
export function segmentMarkdown(md: string): Segment[] {
	const segments: Segment[] = [];
	// Lookbehind split keeps the trailing "\n" on each line so concatenation
	// reproduces the input exactly.
	const lines = md.split(/(?<=\n)/);
	let inFence: "```" | "~~~" | null = null;
	let buffer: string[] = [];

	const flushText = () => {
		if (buffer.length === 0) return;
		segments.push(...tokenizeInlineCode(buffer.join("")));
		buffer = [];
	};
	const flushProtected = () => {
		if (buffer.length === 0) return;
		segments.push({ kind: "protected", text: buffer.join("") });
		buffer = [];
	};

	for (const line of lines) {
		const stripped = line.replace(/\n$/, "");
		if (inFence) {
			buffer.push(line);
			const closeRe = new RegExp(`^[\\t ]*${inFence}[\\t ]*$`);
			if (closeRe.test(stripped)) {
				flushProtected();
				inFence = null;
			}
		} else {
			const m = /^[\t ]*(```|~~~)/.exec(stripped);
			if (m) {
				flushText();
				buffer.push(line);
				inFence = m[1] as "```" | "~~~";
			} else {
				buffer.push(line);
			}
		}
	}
	if (inFence) flushProtected();
	else flushText();
	return segments;
}

/**
 * Apply `fn` to every non-protected text segment of `md`, leaving fenced and
 * inline code untouched, and reassemble.
 */
export function transformText(md: string, fn: (text: string) => string): string {
	return segmentMarkdown(md)
		.map((s) => (s.kind === "text" ? fn(s.text) : s.text))
		.join("");
}
