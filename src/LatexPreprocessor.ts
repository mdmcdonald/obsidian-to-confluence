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

import { transformText } from "./markdownTokenizer";

const BLOCK_MATH_RE = /\$\$([\s\S]+?)\$\$/g;

// $..$ — single char or multi-char content, no whitespace adjacent to the $,
// not preceded by a backslash. The (?:...)? group accepts the single-char case.
const INLINE_MATH_RE = /(?<!\\)\$([^\s$\n](?:[^$\n]*?[^\s$\n])?)\$/g;

function looksLikeMath(content: string): boolean {
	// Heuristic: typical math contains at least one letter or backslash.
	// "$50 + $20" (no letters, no backslash) is currency, not math — skip.
	return /[a-zA-Z\\]/.test(content);
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
	return transformText(md, processText);
}
