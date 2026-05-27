/**
 * Rewrites Obsidian-style LaTeX math delimiters into syntax the library's
 * markdown→ADF parser preserves verbatim:
 *
 *   $$...$$   →   ```latex-math-block ... ``` (block fence with custom lang)
 *   $...$     →   `latex-math-inline:...`     (inline code with sentinel prefix)
 *
 * Fenced code blocks, indented code blocks (≥4 leading spaces), and inline code
 * spans are protected — math delimiters inside them are left alone.
 *
 * The downstream converter (AdfToStorageFormat.ts) recognises these forms and
 * emits the Appfire LaTeX Math macros (`mathblock` / `mathinline`).
 */

const BLOCK_MATH_RE = /\$\$([\s\S]+?)\$\$/g;

// $..$ — single char or multi-char content, no whitespace adjacent to the $,
// not preceded by a backslash. The (?:...)? group accepts the single-char case.
const INLINE_MATH_RE = /(?<!\\)\$([^\s$\n](?:[^$\n]*?[^\s$\n])?)\$/g;

interface Token {
	kind: "text" | "protected";
	text: string;
}

function looksLikeMath(content: string): boolean {
	// Heuristic: typical math contains at least one letter or backslash.
	// "$50 + $20" (no letters, no backslash) is currency, not math — skip.
	return /[a-zA-Z\\]/.test(content);
}

function tokenizeInlineCode(text: string): Token[] {
	const tokens: Token[] = [];
	const re = /`([^`\n]+)`/g;
	let lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		if (m.index > lastIndex) {
			tokens.push({ kind: "text", text: text.slice(lastIndex, m.index) });
		}
		tokens.push({ kind: "protected", text: m[0] });
		lastIndex = m.index + m[0].length;
	}
	if (lastIndex < text.length) {
		tokens.push({ kind: "text", text: text.slice(lastIndex) });
	}
	return tokens;
}

function tokenize(md: string): Token[] {
	const tokens: Token[] = [];
	// Lookbehind split keeps the trailing "\n" on each line so concatenation
	// reproduces the input exactly.
	const lines = md.split(/(?<=\n)/);
	let inFence: "```" | "~~~" | null = null;
	let buffer: string[] = [];

	const flushText = () => {
		if (buffer.length === 0) return;
		tokens.push(...tokenizeInlineCode(buffer.join("")));
		buffer = [];
	};
	const flushProtected = () => {
		if (buffer.length === 0) return;
		tokens.push({ kind: "protected", text: buffer.join("") });
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
	return tokens;
}

function processText(text: string): string {
	text = text.replace(BLOCK_MATH_RE, (_match, eq: string) => {
		const trimmed = eq.replace(/^\n+/, "").replace(/\n+$/, "");
		// Surrounding blank lines so the fenced block is recognised as block-level.
		return `\n\n\`\`\`latex-math-block\n${trimmed}\n\`\`\`\n\n`;
	});
	text = text.replace(INLINE_MATH_RE, (whole, content: string) => {
		if (!looksLikeMath(content)) return whole;
		return `\`latex-math-inline:${content}\``;
	});
	return text;
}

export function preprocessLatex(md: string): string {
	const tokens = tokenize(md);
	return tokens
		.map((t) => (t.kind === "text" ? processText(t.text) : t.text))
		.join("");
}
