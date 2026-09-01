/**
 * Exclusion globs for the publish set (F3).
 *
 * `connie-publish: false` is a per-file opt-out that has to be written into
 * every excluded note. For a 2,700-page corpus the exclusions are structural
 * ("everything under _templates", "all .canvas files"), so they belong in one
 * list — inline in settings and/or a vault-relative file the corpus owns.
 *
 * Pure and dependency-free (no glob library): a small glob→RegExp converter is
 * all this needs, and it keeps the plugin bundle unchanged.
 */

/** A compiled predicate: true when the (publish-folder-relative) path is excluded. */
export type ExcludePredicate = (relativePath: string) => boolean;

interface CompiledPattern {
	regex: RegExp;
	negated: boolean;
}

/** Regex metacharacters that must be escaped when they appear literally. */
const REGEX_SPECIALS = new Set(["\\", "^", "$", ".", "|", "+", "(", ")", "{", "}"]);

/**
 * Convert one glob to an anchored RegExp source.
 *
 *   `**` matches across directory separators, `*` and `?` do not,
 *   `[abc]` / `[!abc]` are character classes,
 *   a trailing `/` means "everything under this directory",
 *   a pattern with no `/` matches at any depth (like .gitignore).
 */
export function globToRegExpSource(glob: string): string {
	let pattern = glob;
	if (pattern.endsWith("/")) pattern = `${pattern}**`;
	if (!pattern.includes("/")) pattern = `**/${pattern}`;

	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "*") {
			const isDouble = pattern[i + 1] === "*";
			if (isDouble) {
				i++;
				if (pattern[i + 1] === "/") {
					// "**/" also matches zero directories, so "**/x" matches "x".
					i++;
					out += "(?:[^/]+/)*";
				} else {
					out += ".*";
				}
			} else {
				out += "[^/]*";
			}
			continue;
		}
		if (ch === "?") {
			out += "[^/]";
			continue;
		}
		if (ch === "[") {
			const close = pattern.indexOf("]", i + 1);
			if (close > i + 1) {
				let body = pattern.slice(i + 1, close);
				if (body.startsWith("!")) body = `^${body.slice(1)}`;
				out += `[${body.replace(/\\/g, "\\\\")}]`;
				i = close;
				continue;
			}
			out += "\\[";
			continue;
		}
		out += REGEX_SPECIALS.has(ch) ? `\\${ch}` : ch;
	}
	return `^${out}$`;
}

/** Every ancestor directory of a path, deepest last ("a/b/c.md" → ["a", "a/b"]). */
function ancestorPaths(relativePath: string): string[] {
	const parts = relativePath.split("/").filter((s) => s.length > 0);
	const out: string[] = [];
	for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
	return out;
}

/**
 * Compile a pattern list into a single predicate. Patterns are applied in
 * order and the LAST match wins, so a `!` negation after a broad exclusion
 * re-includes what it names. Matching is case-sensitive and uses POSIX
 * separators, against the path relative to the configured publish folder.
 *
 * A pattern also matches a path when it matches one of the path's ancestor
 * directories, so a bare `_templates` excludes everything inside it.
 */
export function compileExcludes(patterns: readonly string[]): ExcludePredicate {
	const compiled: CompiledPattern[] = [];
	for (const raw of patterns) {
		const trimmed = raw.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const negated = trimmed.startsWith("!");
		const body = negated ? trimmed.slice(1).trim() : trimmed;
		if (!body) continue;
		try {
			compiled.push({ regex: new RegExp(globToRegExpSource(body)), negated });
		} catch (e) {
			console.warn(`[Confluence] Ignoring invalid exclusion pattern ${JSON.stringify(raw)}:`, e);
		}
	}
	if (compiled.length === 0) return () => false;

	return (relativePath: string): boolean => {
		const candidates = [relativePath, ...ancestorPaths(relativePath)];
		let excluded = false;
		for (const { regex, negated } of compiled) {
			if (candidates.some((c) => regex.test(c))) excluded = !negated;
		}
		return excluded;
	};
}

/** Strip an unescaped trailing `#` comment and surrounding quotes from a line. */
function cleanListEntry(line: string): string {
	const hash = line.indexOf(" #");
	const body = hash >= 0 ? line.slice(0, hash) : line;
	return body
		.trim()
		.replace(/^["']|["']$/g, "")
		.trim();
}

/**
 * Read exclusion patterns out of a vault file.
 *
 * A YAML file uses the top-level key `exclude:` holding a list of strings
 * (block or inline flow style); everything else is treated as plain text, one
 * pattern per line with `#` comments. Deliberately a scanner rather than a YAML
 * dependency — the shape accepted is exactly the shape documented.
 */
export function parseExcludeFile(content: string, format: "yaml" | "text"): string[] {
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	if (format !== "yaml") {
		return lines.map((l) => (l.trim().startsWith("#") ? "" : cleanListEntry(l))).filter((l) => l.length > 0);
	}

	const out: string[] = [];
	let inExclude = false;
	for (const line of lines) {
		if (!inExclude) {
			const m = /^exclude:\s*(.*)$/.exec(line);
			if (!m) continue;
			const inline = m[1].trim();
			if (inline.startsWith("[")) {
				// Flow style: exclude: ["a/**", "b"]
				const body = inline.replace(/^\[/, "").replace(/\]\s*$/, "");
				for (const part of body.split(",")) {
					const v = cleanListEntry(part);
					if (v) out.push(v);
				}
				continue; // a flow list is complete on its own line
			}
			inExclude = true;
			continue;
		}
		if (line.trim() === "" || line.trim().startsWith("#")) continue;
		const item = /^\s*-\s+(.*)$/.exec(line);
		if (item) {
			const v = cleanListEntry(item[1]);
			if (v) out.push(v);
			continue;
		}
		// A non-indented, non-list line ends the block.
		if (!/^\s/.test(line)) inExclude = false;
	}
	return out;
}

/** Choose the parse format from a vault-relative filename. */
export function excludeFileFormat(path: string): "yaml" | "text" {
	return /\.ya?ml$/i.test(path.trim()) ? "yaml" : "text";
}
