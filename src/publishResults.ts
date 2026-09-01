import type { UploadAdfFileResult } from "@markdown-confluence/lib";
import type { TitleRename } from "./adaptors/obsidian";
import type { LinkDiagnostic, LinkDiagnosticKind } from "./linkDiagnostics";

export type { LinkDiagnostic, LinkDiagnosticKind } from "./linkDiagnostics";

export type DeletedNoteAction = "off" | "report" | "trash";

export interface FailedFile {
	fileName: string;
	reason: string;
}

export interface OrphanSummary {
	action: Exclude<DeletedNoteAction, "off">;
	ok: number;
	failed: number;
	ids: string[];
	/** Page IDs actually removed. Used to prune persisted publish state. */
	removed: string[];
}

export interface UploadResults {
	errorMessage: string | null;
	failedFiles: FailedFile[];
	filesUploadResult: UploadAdfFileResult[];
	renamedFiles: TitleRename[];
	/** Count of notes skipped as unchanged. */
	skipped?: number;
	/** Result of handling pages whose source note was removed, if any. */
	orphansHandled?: OrphanSummary | null;
	/**
	 * Every link/title problem found while rendering this publish (F5). These
	 * never fail a publish — they are what the dry run (F6) exists to fix.
	 */
	diagnostics?: LinkDiagnostic[];
	/** Counts per diagnostic kind, for the completion modal's summary row. */
	diagnosticSummary?: Record<LinkDiagnosticKind, number>;
}
