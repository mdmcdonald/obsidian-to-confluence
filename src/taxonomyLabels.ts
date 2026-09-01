// Projects a note's taxonomy frontmatter (e.g. `subject`, `type`) onto
// Confluence labels, which — unlike the Page Properties panel — are clickable
// and feed label search, the Content-by-Label macro, and label pages. Kept
// dependency-free (no `obsidian` import) so it can be unit-tested directly.

/** Frontmatter fields that can be projected onto Confluence labels. */
export type TaxonomyLabelField = "tags" | "subject" | "type" | "domain" | "status" | "lifecycle_phase";

/** Which frontmatter fields feed the label set (F8). */
export type LabelSources = Record<TaxonomyLabelField, boolean>;

/** Confluence truncates long labels; 255 is the documented ceiling. */
export const MAX_LABEL_LENGTH = 255;

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
		.replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
		.slice(0, MAX_LABEL_LENGTH)
		.replace(/-+$/g, ""); // a slice can leave a trailing hyphen
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
 *
 * `prefixes` maps a source field to a string prefixed BEFORE uniqueness, so a
 * `type: hub` becomes `type-hub` and can coexist with a plain `hub` tag.
 */
export function deriveTaxonomyLabels(
	frontmatter: Record<string, unknown> | undefined,
	fields: readonly TaxonomyLabelField[],
	prefixes: Readonly<Record<string, string>> = {},
): string[] {
	if (!frontmatter) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (raw: unknown, field: TaxonomyLabelField) => {
		const slug = slugifyLabel(raw);
		if (!slug) return;
		const prefix = prefixes[field] ?? "";
		const label = (prefix ? `${prefix}${slug}` : slug).slice(0, MAX_LABEL_LENGTH);
		if (label && !seen.has(label)) {
			seen.add(label);
			out.push(label);
		}
	};
	for (const field of fields) {
		if (field === "type") {
			const t = frontmatter.type ?? frontmatter.document_type;
			if (t != null) add(t, field);
		} else {
			for (const v of toList(frontmatter[field])) add(v, field);
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

// ---------------------------------------------------------------------------
// Vocabulary allowlist (F8)
// ---------------------------------------------------------------------------

/**
 * Build a lookup of allowed labels from a controlled-vocabulary file. Every
 * string under ANY top-level list in the YAML counts as an allowed term, so the
 * corpus's `tag_vocabulary.yaml` can be copied in unchanged whatever its
 * grouping. Terms are compared in normalised (slugified) form.
 *
 * Deliberately a scanner rather than a YAML dependency: it accepts block lists
 * (`- term`) and inline flow lists (`key: [a, b]`), which is the whole shape a
 * vocabulary file needs.
 */
export function parseLabelAllowlist(content: string): Set<string> {
	const allowed = new Set<string>();
	const add = (raw: string) => {
		const slug = slugifyLabel(raw);
		if (slug) allowed.add(slug);
	};
	for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const item = /^-\s+(.*)$/.exec(trimmed);
		if (item) {
			const value = item[1].split(" #")[0].trim();
			// A list entry that is itself a mapping ("- name: foo") contributes its value.
			const asMap = /^[A-Za-z0-9_-]+:\s*(.+)$/.exec(value);
			add(asMap ? asMap[1] : value);
			continue;
		}
		const flow = /^[A-Za-z0-9_-]+:\s*\[(.*)\]\s*$/.exec(trimmed);
		if (flow) {
			for (const part of flow[1].split(",")) add(part);
		}
	}
	return allowed;
}

/**
 * Drop labels that are not in the controlled vocabulary. An empty allowlist
 * means "no vocabulary configured" and lets everything through.
 *
 * `prefixes` are the configured per-field prefixes. A vocabulary file lists the
 * taxonomy's own terms ("hub"), not the plugin's presentation of them
 * ("type-hub"), so a label is also admitted when it matches an allowed term
 * once a configured prefix is stripped. Without this, turning on a prefix and a
 * vocabulary together — the documented baseline — would drop every label the
 * prefixed field produces.
 */
export function filterByAllowlist(
	labels: readonly string[],
	allowed: ReadonlySet<string> | undefined,
	prefixes: Readonly<Record<string, string>> = {},
): { kept: string[]; dropped: string[] } {
	if (!allowed || allowed.size === 0) return { kept: [...labels], dropped: [] };
	const configured = Object.values(prefixes).filter((p) => p.length > 0);
	const isAllowed = (label: string): boolean => {
		if (allowed.has(label) || allowed.has(slugifyLabel(label))) return true;
		return configured.some((prefix) => label.startsWith(prefix) && allowed.has(label.slice(prefix.length)));
	};
	const kept: string[] = [];
	const dropped: string[] = [];
	for (const label of labels) {
		if (isAllowed(label)) kept.push(label);
		else dropped.push(label);
	}
	return { kept, dropped };
}

/** Apply the per-page cap (0 = uncapped), keeping the first N in order. */
export function capLabels(labels: readonly string[], max: number): string[] {
	if (!max || max <= 0) return [...labels];
	return labels.slice(0, max);
}
