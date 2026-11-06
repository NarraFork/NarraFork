/** Revert results. Legacy history stays read-only; file writes use fixed per-file plans. */
import type {
	FileChangeEvidenceUncertaintyWarning,
	FileChangeRevertApplyResponse,
	FileChangeRevertFileResult,
} from "@shared/file-change-protocol";
import { db } from "../db";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { AppError } from "../lib/errors";

/** Workspace scope is explicit; missing narrator evidence never widens the selection. */
export type RevertScope = "narrator" | "workspace";
export const DEFAULT_REVERT_SCOPE: RevertScope = "narrator";
export type RevertWarning =
	| FileChangeEvidenceUncertaintyWarning
	| {
			code: "WORKSPACE_SCOPE_DISCARDED_OTHERS";
			otherActorCount: number;
			externalCount: number;
			unserializedCount: number;
			humanCount: number;
			sampleFilePaths: string[];
	  }
	| { code: "SUBAGENT_CHANGES_REVERTED"; changeCount: number; sampleFilePaths: string[] };

export interface RevertResult extends FileChangeRevertApplyResponse {
	warnings?: RevertWarning[];
}

/** An explicitly empty/read-only selection, rather than a missing history item. */
export function emptyRevertResult(): RevertResult {
	return {
		planId: "",
		status: "committed",
		journalStatus: "committed",
		settling: false,
		reason: null,
		files: [],
		historyStatus: "complete",
		historyCommitted: false,
	};
}

/** Preserve the item that could not be restored; an unavailable item is never an empty success. */
export function unavailableSnapshotRevert(
	reason: string,
	filePath = "(history)",
	files?: FileChangeRevertFileResult[],
): RevertResult {
	return {
		planId: "",
		status: "failed",
		journalStatus: "failed",
		settling: false,
		reason,
		files: files?.length
			? files
			: [{ deviceId: LOCAL_DEVICE_ID, filePath, status: "not_attempted", reason }],
		historyStatus: "unavailable",
		historyCommitted: false,
	};
}

/** Carries actual file outcomes even when the later, independent history transaction fails. */
export class SnapshotRevertError extends AppError {
	constructor(public readonly result: RevertResult) {
		super(
			`File rollback or history update did not complete; original history was retained. ${result.reason ?? "Inspect the per-file results."}`,
			409,
			"SNAPSHOT_REVERT_FAILED",
		);
		this.name = "SnapshotRevertError";
	}
}

/**
 * A partial-coverage plan the user confirmed as "restore available files": every
 * file it covers succeeded and history was intentionally left uncommitted.
 */
export function isAvailableFilesRestored(result: RevertResult): boolean {
	return (
		result.status === "partial" &&
		result.journalStatus === "partial" &&
		result.reason === "SELECTED_HISTORY_UNAVAILABLE" &&
		!result.historyCommitted &&
		!result.settling &&
		result.files.every((file) => file.status === "applied" || file.status === "unchanged")
	);
}

export function assertSnapshotRevertComplete(result: RevertResult): void {
	if (
		result.status !== "committed" ||
		result.settling ||
		result.files.some((file) => file.status !== "applied" && file.status !== "unchanged")
	) {
		throw new SnapshotRevertError(result);
	}
}

export function snapshotHistoryFailure(result: RevertResult, error: unknown): SnapshotRevertError {
	return new SnapshotRevertError({
		...result,
		status: result.files.some((file) => file.status === "applied") ? "partial" : "failed",
		reason: error instanceof AppError ? error.code : "HISTORY_COMMIT_FAILED",
		historyStatus: "unavailable",
		historyCommitted: false,
	});
}

/** Same explicit workspace precedence as the session; never falls back to the user's home. */
export async function resolveNarratorCwd(narratorId: string): Promise<string | null> {
	const narrator = await db.query.narrators.findFirst({
		where: (row, { eq }) => eq(row.id, narratorId),
		columns: { cwd: true, contextProjectId: true },
	});
	if (!narrator) return null;
	if (narrator.cwd) return narrator.cwd;
	const projectId = narrator.contextProjectId;
	if (projectId) {
		const project = await db.query.projects.findFirst({
			where: (row, { eq }) => eq(row.id, projectId),
			columns: { gitPath: true },
		});
		if (project?.gitPath) return project.gitPath;
	}
	return null;
}
