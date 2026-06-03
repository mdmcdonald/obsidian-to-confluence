// Projects a note's taxonomy frontmatter (e.g. `subject`, `type`) onto
// Confluence labels, which — unlike the Page Properties panel — are clickable
// and feed label search, the Content-by-Label macro, and label pages. Kept
// dependency-free (no `obsidian` import) so it can be unit-tested directly.

/** Frontmatter fields that can be projected onto Confluence labels. */
export type TaxonomyLabelField =
	| "subject"
	| "type"
	| "domain"
	| "status"
	| "lifecycle_phase";

/**
 * Slugify a taxonomy term / scalar into a Confluence-label-safe token. Confluence
 * labels can't contain spaces and are effectively lowercase, so we strip a leading
 * `namespace:` prefix, lowercase, and collapse every run of non-alphanumeric
 * characters to a single hyphen — e.g. "Machine Learning" → "machine-learning",
 * "Risk & Compliance" → "risk-compliance". Unicode letters/digits are preserved
 * (`\p{L}\p{N}`), so accented and non-Latin terms survive. Returns "" if nothing
 * usable remains (caller drops empties).
 */
export function slugifyLabel(value: unknown): string {
	return String(value ?? "")
		.replace(/^["']|["']$/g, "") // strip surrounding quotes
		.replace(/^[a-z][a-z0-9]*:/i, "") // strip leading namespace prefix
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-") // any run of non-alnum → single hyphen
		.replace(/^-+|-+$/g, ""); // trim leading/trailing hyphens
}

function toList(v: unknown): unknown[] {
	if (v == null) return [];
	return Array.isArray(v) ? v : [v];
}

/**
 * Derive Confluence labels from a note's frontmatter for the requested taxonomy
 * fields. Returns slugified, de-duplicated labels (empty slugs dropped), ordered
 * by field then value. `type` falls back to `document_type`. Pure — no Obsidian
 * deps, so it's unit-testable.
 */
export function deriveTaxonomyLabels(
	frontmatter: Record<string, unknown> | undefined,
	fields: readonly TaxonomyLabelField[],
): string[] {
	if (!frontmatter) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (raw: unknown) => {
		const slug = slugifyLabel(raw);
		if (slug && !seen.has(slug)) {
			seen.add(slug);
			out.push(slug);
		}
	};
	for (const field of fields) {
		if (field === "type") {
			const t = frontmatter.type ?? frontmatter.document_type;
			if (t != null) add(t);
		} else {
			for (const v of toList(frontmatter[field])) add(v);
		}
	}
	return out;
}

/**
 * Merge derived taxonomy labels into any pre-existing `tags` value, preserving
 * the existing entries verbatim (so author-set tags keep working as before) and
 * appending the new slugs. De-dupes exact matches; non-string existing entries
 * are dropped (matching the library's own `tags` reader).
 */
export function mergeTags(existing: unknown, derived: readonly string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (s: string) => {
		if (s && !seen.has(s)) {
			seen.add(s);
			out.push(s);
		}
	};
	for (const v of toList(existing)) {
		if (typeof v === "string") push(v);
	}
	for (const s of derived) push(s);
	return out;
}
