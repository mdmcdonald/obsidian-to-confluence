/**
 * Typed link/title diagnostics (F5).
 *
 * Anything a user has to act on — a link that could not be resolved, a folder
 * with two landing candidates, a title that had to be shortened — is DATA, not
 * a console line: it is aggregated per page, shown in the completion modal and
 * written into the dry-run report (F6).
 *
 * Pure and dependency-free so both the preprocessing passes and the tests can
 * import it without pulling in Obsidian.
 */

export type LinkDiagnosticKind =
	| "target-not-in-vault"
	| "target-excluded"
	| "target-not-published"
	| "ambiguous-stem-resolved"
	| "ambiguous-stem-unresolved"
	| "folder-not-published"
	| "asset-link-dropped"
	| "absolute-link-unresolved"
	| "block-ref-dropped"
	| "landing-conflict"
	| "title-truncated"
	| "root-landing-refused"
	| "title-collides-in-space";

export type DiagnosticSeverity = "error" | "warning";

export interface LinkDiagnostic {
	kind: LinkDiagnosticKind;
	severity: DiagnosticSeverity;
	/** Vault path of the page the diagnostic was raised from. */
	sourcePath: string;
	/** The link target / folder / title the diagnostic is about. */
	target: string;
	/** The link text shown to the reader, when it differs from the target. */
	display?: string;
}

/** Every kind, in report order. */
export const LINK_DIAGNOSTIC_KINDS: readonly LinkDiagnosticKind[] = [
	"target-not-in-vault",
	"target-excluded",
	"target-not-published",
	"ambiguous-stem-resolved",
	"ambiguous-stem-unresolved",
	"folder-not-published",
	"asset-link-dropped",
	"absolute-link-unresolved",
	"block-ref-dropped",
	"landing-conflict",
	"title-truncated",
	"root-landing-refused",
	"title-collides-in-space",
];

/** Default severity per kind. A link that silently points at the wrong page is
 * an error; one that degrades to readable plain text is a warning. */
export const DIAGNOSTIC_SEVERITY: Record<LinkDiagnosticKind, DiagnosticSeverity> = {
	"target-not-in-vault": "warning",
	"target-excluded": "warning",
	"target-not-published": "warning",
	"ambiguous-stem-resolved": "warning",
	"ambiguous-stem-unresolved": "error",
	"folder-not-published": "warning",
	"asset-link-dropped": "warning",
	"absolute-link-unresolved": "warning",
	"block-ref-dropped": "warning",
	"landing-conflict": "error",
	"title-truncated": "warning",
	"root-landing-refused": "warning",
	"title-collides-in-space": "error",
};

/** One-line human summary per kind, used by the report and the modal. */
export const DIAGNOSTIC_LABEL: Record<LinkDiagnosticKind, string> = {
	"target-not-in-vault": "Link target not found in the vault",
	"target-excluded": "Link target is excluded from publishing",
	"target-not-published": "Link target is not published",
	"ambiguous-stem-resolved": "Ambiguous link resolved to the publishable candidate",
	"ambiguous-stem-unresolved": "Ambiguous link — several publishable candidates",
	"folder-not-published": "Folder link has no published folder page",
	"asset-link-dropped": "Asset link rendered as plain text",
	"absolute-link-unresolved": "Absolute path did not resolve to a published page",
	"block-ref-dropped": "Block reference dropped (no Confluence equivalent)",
	"landing-conflict": "Folder has more than one landing-file candidate",
	"title-truncated": "Title shortened to fit Confluence's 255-character limit",
	"root-landing-refused": "Root landing not written into the parent page",
	"title-collides-in-space": "Title already used by a page outside the publish tree",
};

export type DiagnosticSink = (diagnostic: LinkDiagnostic) => void;

/** Build a diagnostic, filling in the kind's default severity. */
export function makeDiagnostic(
	kind: LinkDiagnosticKind,
	sourcePath: string,
	target: string,
	display?: string,
): LinkDiagnostic {
	return {
		kind,
		severity: DIAGNOSTIC_SEVERITY[kind],
		sourcePath,
		target,
		...(display !== undefined ? { display } : {}),
	};
}

/** The console/`onWarning` rendering of a diagnostic (back-compat string sink). */
export function diagnosticMessage(d: LinkDiagnostic): string {
	const shown = d.display && d.display !== d.target ? ` (shown as "${d.display}")` : "";
	return `${DIAGNOSTIC_LABEL[d.kind]}: ${d.target}${shown} — in ${d.sourcePath || "(unknown page)"}`;
}

/** Count diagnostics per kind. Every kind is present, so callers can render 0s. */
export function summariseDiagnostics(diagnostics: readonly LinkDiagnostic[]): Record<LinkDiagnosticKind, number> {
	const summary = {} as Record<LinkDiagnosticKind, number>;
	for (const kind of LINK_DIAGNOSTIC_KINDS) summary[kind] = 0;
	for (const d of diagnostics) summary[d.kind] = (summary[d.kind] ?? 0) + 1;
	return summary;
}

export interface PageDiagnosticCount {
	sourcePath: string;
	errors: number;
	warnings: number;
	diagnostics: LinkDiagnostic[];
}

/**
 * Group diagnostics by source page, worst first (most errors, then most
 * warnings, then path) — the ordering the completion modal shows.
 */
export function rankPagesByDiagnostics(diagnostics: readonly LinkDiagnostic[]): PageDiagnosticCount[] {
	const byPage = new Map<string, PageDiagnosticCount>();
	for (const d of diagnostics) {
		let entry = byPage.get(d.sourcePath);
		if (!entry) {
			entry = { sourcePath: d.sourcePath, errors: 0, warnings: 0, diagnostics: [] };
			byPage.set(d.sourcePath, entry);
		}
		entry.diagnostics.push(d);
		if (d.severity === "error") entry.errors++;
		else entry.warnings++;
	}
	return [...byPage.values()].sort(
		(a, b) => b.errors - a.errors || b.warnings - a.warnings || a.sourcePath.localeCompare(b.sourcePath),
	);
}
