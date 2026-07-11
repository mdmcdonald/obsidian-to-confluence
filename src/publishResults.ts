import type { UploadAdfFileResult } from "@markdown-confluence/lib";
import type { TitleRename } from "./adaptors/obsidian";

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
}
