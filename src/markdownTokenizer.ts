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
	let emittedThrough = 0;
	let i = 0;

	const isEscaped = (at: number): boolean => {
		let slashes = 0;
		for (let p = at - 1; p >= 0 && text[p] === "\\"; p--) slashes++;
		return slashes % 2 === 1;
	};

	while (i < text.length) {
		if (text[i] !== "`" || isEscaped(i)) {
			i++;
			continue;
		}
		let openerEnd = i;
		while (text[openerEnd] === "`") openerEnd++;
		const delimiterLength = openerEnd - i;

		let close = openerEnd;
		while (close < text.length) {
			close = text.indexOf("`", close);
			if (close < 0) break;
			let closeEnd = close;
			while (text[closeEnd] === "`") closeEnd++;
			if (!isEscaped(close) && closeEnd - close === delimiterLength) break;
			close = closeEnd;
		}
		if (close < 0) {
			i = openerEnd;
			continue;
		}

		if (i > emittedThrough) {
			segments.push({ kind: "text", text: text.slice(emittedThrough, i) });
		}
		const protectedEnd = close + delimiterLength;
		segments.push({ kind: "protected", text: text.slice(i, protectedEnd) });
		emittedThrough = protectedEnd;
		i = protectedEnd;
	}

	if (emittedThrough < text.length) {
		segments.push({ kind: "text", text: text.slice(emittedThrough) });
	}
	return segments;
}

interface Fence {
	marker: "`" | "~";
	length: number;
}

function openingFence(line: string): Fence | null {
	const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
	if (!match) return null;
	const run = match[1];
	// A backtick fence's info string cannot itself contain a backtick.
	if (run[0] === "`" && match[2].includes("`")) return null;
	return { marker: run[0] as Fence["marker"], length: run.length };
}

function closesFence(line: string, fence: Fence): boolean {
	const match = /^ {0,3}(`+|~+)[\t ]*$/.exec(line);
	return !!match && match[1][0] === fence.marker && match[1].length >= fence.length;
}

function isIndentedCodeLine(line: string): boolean {
	return /^(?: {4}|\t)/.test(line);
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
	let inFence: Fence | null = null;
	let inIndentedCode = false;
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
			if (closesFence(stripped, inFence)) {
				flushProtected();
				inFence = null;
			}
		} else {
			const fence = openingFence(stripped);
			if (fence) {
				if (inIndentedCode) {
					flushProtected();
					inIndentedCode = false;
				}
				flushText();
				buffer.push(line);
				inFence = fence;
			} else if (isIndentedCodeLine(stripped)) {
				if (!inIndentedCode) flushText();
				inIndentedCode = true;
				buffer.push(line);
			} else if (inIndentedCode && stripped.trim() === "") {
				// Blank lines within an indented code block remain protected.
				buffer.push(line);
			} else {
				if (inIndentedCode) {
					flushProtected();
					inIndentedCode = false;
				}
				buffer.push(line);
			}
		}
	}
	if (inFence || inIndentedCode) flushProtected();
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
