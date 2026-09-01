/**
 * Dry-run report formatter (F6).
 *
 * "Check Confluence links and titles" runs the whole publish pipeline up to —
 * but not including — the network: it resolves every title, folder title and
 * link, collects the diagnostics, and writes them into one markdown note the
 * author can work through before a bulk publish. Nothing is uploaded and no
 * frontmatter is touched.
 *
 * Pure (string in, string out) so the report layout is testable from a fixture.
 */

import {
	LINK_DIAGNOSTIC_KINDS,
	DIAGNOSTIC_LABEL,
	LinkDiagnostic,
	LinkDiagnosticKind,
	summariseDiagnostics,
} from "./linkDiagnostics";
import type { FolderTitleOrigin, LandingConflict } from "./folderTree";

export interface DryRunCounts {
	publishablePages: number;
	folderPages: number;
	excludedByGlob: number;
	excludedByFrontmatter: number;
}

export interface DryRunRename {
	filePath: string;
	originalTitle: string;
	renamedTitle: string;
}

export interface DryRunFolderTitle {
	relPath: string;
	title: string;
	origin: FolderTitleOrigin;
}

export interface DryRunLabelPreview {
	/** Number of distinct labels the publish would apply across all pages. */
	distinct: number;
	/** Labels the vocabulary allowlist rejected, with how often they appeared. */
	dropped: { label: string; count: number }[];
	/** The most frequent labels, already sorted and truncated by the caller. */
	top: { label: string; count: number }[];
}

export interface DryRunInput {
	folderToPublish: string;
	/** ISO timestamp; injectable so the fixture test is deterministic. */
	generatedAt: string;
	counts: DryRunCounts;
	renames: DryRunRename[];
	landingConflicts: LandingConflict[];
	folderTitles: DryRunFolderTitle[];
	diagnostics: LinkDiagnostic[];
	labels: DryRunLabelPreview;
}

/** Everything `plugin.runDryRun()` hands back, for a test harness or the modal. */
export interface DryRunResult extends DryRunInput {
	/** Vault path the report was written to (empty if writing failed). */
	reportPath: string;
	/** Rendered markdown, so a caller can inspect it without reading the vault. */
	report: string;
}

/** Escape the pipe characters that would break a markdown table cell. */
function cell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

const SECTION_TITLES = [
	"Summary",
	"Title renames",
	"Landing conflicts",
	"Folder titles",
	"Diagnostics",
	"Label preview",
] as const;

/** The report's section headings, in order — used by the tests and the TOC. */
export const DRY_RUN_SECTIONS: readonly string[] = SECTION_TITLES;

function renderSummary(input: DryRunInput, summary: Record<LinkDiagnosticKind, number>): string[] {
	const lines: string[] = ["## Summary", "", "| Measure | Count |", "| --- | ---: |"];
	lines.push(`| Publishable pages | ${input.counts.publishablePages} |`);
	lines.push(`| Folder pages | ${input.counts.folderPages} |`);
	lines.push(`| Excluded by glob | ${input.counts.excludedByGlob} |`);
	lines.push(`| Excluded by frontmatter | ${input.counts.excludedByFrontmatter} |`);
	lines.push(`| Title renames | ${input.renames.length} |`);
	lines.push(`| Landing conflicts | ${input.landingConflicts.length} |`);
	for (const kind of LINK_DIAGNOSTIC_KINDS) {
		lines.push(`| ${cell(DIAGNOSTIC_LABEL[kind])} (\`${kind}\`) | ${summary[kind]} |`);
	}
	lines.push("");
	return lines;
}

function renderRenames(input: DryRunInput): string[] {
	const lines: string[] = ["## Title renames", ""];
	if (input.renames.length === 0) {
		lines.push("None — every page title is already unique.", "");
		return lines;
	}
	lines.push(
		"Several notes resolved to the same Confluence title, so each was given a",
		"stable hash suffix. Give them distinct titles to remove the suffixes.",
		"",
		"| Note | Resolved title | Published as |",
		"| --- | --- | --- |",
	);
	for (const r of input.renames) {
		lines.push(`| \`${cell(r.filePath)}\` | ${cell(r.originalTitle)} | ${cell(r.renamedTitle)} |`);
	}
	lines.push("");
	return lines;
}

function renderLandingConflicts(input: DryRunInput): string[] {
	const lines: string[] = ["## Landing conflicts", ""];
	if (input.landingConflicts.length === 0) {
		lines.push("None — every folder has at most one landing-page candidate.", "");
		return lines;
	}
	lines.push(
		"These folders contain more than one file that qualifies as the folder page",
		"(`index.md`, then `README.md`, then a file named like the folder). The first",
		"candidate wins; remove or rename the others.",
		"",
	);
	for (const c of input.landingConflicts) {
		lines.push(`- \`${c.folderRelPath || "(publish root)"}\``);
		c.candidates.forEach((candidate, i) => {
			lines.push(`  ${i === 0 ? "- **used**" : "- ignored"}: \`${candidate}\``);
		});
	}
	lines.push("");
	return lines;
}

const ORIGIN_LABEL: Record<FolderTitleOrigin, string> = {
	landing: "landing file",
	"display-map": "display map",
	segment: "folder name",
	qualified: "qualified (collision)",
	hash: "hash suffix (collision)",
};

function renderFolderTitles(input: DryRunInput): string[] {
	const lines: string[] = ["## Folder titles", ""];
	if (input.folderTitles.length === 0) {
		lines.push("No folder pages — the publish set is flat.", "");
		return lines;
	}
	lines.push("| Folder | Page title | Source |", "| --- | --- | --- |");
	for (const f of input.folderTitles) {
		lines.push(`| \`${cell(f.relPath)}\` | ${cell(f.title)} | ${ORIGIN_LABEL[f.origin]} |`);
	}
	lines.push("");
	return lines;
}

function renderDiagnostics(input: DryRunInput): string[] {
	const lines: string[] = ["## Diagnostics", ""];
	if (input.diagnostics.length === 0) {
		lines.push("None — every link and title resolved.", "");
		return lines;
	}
	const byKind = new Map<LinkDiagnosticKind, LinkDiagnostic[]>();
	for (const d of input.diagnostics) {
		const arr = byKind.get(d.kind) ?? [];
		arr.push(d);
		byKind.set(d.kind, arr);
	}
	for (const kind of LINK_DIAGNOSTIC_KINDS) {
		const items = byKind.get(kind);
		if (!items || items.length === 0) continue;
		lines.push(`### ${DIAGNOSTIC_LABEL[kind]} (${items.length})`, "");
		const bySource = new Map<string, LinkDiagnostic[]>();
		for (const d of items) {
			const arr = bySource.get(d.sourcePath) ?? [];
			arr.push(d);
			bySource.set(d.sourcePath, arr);
		}
		for (const sourcePath of [...bySource.keys()].sort()) {
			lines.push(`- \`${sourcePath || "(unknown page)"}\``);
			for (const d of bySource.get(sourcePath) as LinkDiagnostic[]) {
				const shown = d.display && d.display !== d.target ? ` (${d.display})` : "";
				lines.push(`  - ${d.sourcePath || "?"} → ${d.target}${shown}`);
			}
		}
		lines.push("");
	}
	return lines;
}

function renderLabels(input: DryRunInput): string[] {
	const lines: string[] = ["## Label preview", ""];
	lines.push(`Distinct labels: **${input.labels.distinct}**`, "");
	if (input.labels.dropped.length > 0) {
		lines.push(`Dropped by the vocabulary allowlist (${input.labels.dropped.length}):`, "");
		for (const d of input.labels.dropped) lines.push(`- \`${cell(d.label)}\` × ${d.count}`);
		lines.push("");
	} else {
		lines.push("No labels were dropped by the vocabulary allowlist.", "");
	}
	if (input.labels.top.length > 0) {
		lines.push("| Label | Pages |", "| --- | ---: |");
		for (const t of input.labels.top) lines.push(`| \`${cell(t.label)}\` | ${t.count} |`);
		lines.push("");
	}
	return lines;
}

/**
 * Render the full markdown report. Sections always appear, in a fixed order,
 * even when empty — a reader scanning for "Landing conflicts" should see
 * "None", not an absent heading.
 */
export function formatDryRunReport(input: DryRunInput): string {
	const summary = summariseDiagnostics(input.diagnostics);
	const lines: string[] = [
		"---",
		"connie-publish: false",
		"---",
		"",
		"# Confluence publish check",
		"",
		`Folder to publish: \`${input.folderToPublish || "(vault root)"}\``,
		"",
		`Generated: ${input.generatedAt}`,
		"",
		"This report is generated. Nothing was published and no note was modified.",
		"",
		...renderSummary(input, summary),
		...renderRenames(input),
		...renderLandingConflicts(input),
		...renderFolderTitles(input),
		...renderDiagnostics(input),
		...renderLabels(input),
	];
	return (
		lines
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trimEnd() + "\n"
	);
}
