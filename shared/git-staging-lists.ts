import type { GitStatusFilterChar } from "./git-status-page";
import type { GitStagingObservationState } from "./git-workspace-events";

/** Stable identity for changes conservatively classified outside the active list. */
export const GIT_STAGING_UNASSIGNED_LIST_ID = "__narrafork_unassigned__";
export const GIT_STAGING_UNASSIGNED_LIST_NAME = "Unassigned";

/** Dynamic changes are owned by exactly one list in the worktree SQLite database. */
export const GIT_STAGING_LIMITS = Object.freeze({
	maxFilesPerOperation: 1_000,
	maxUnitsPerOperation: 5_000,
	maxPathChars: 4_096,
	maxRequestBytes: 1_048_576,
	maxSummaryLists: 1_024,
	maxSummaryBytes: 1_024 * 1_024,
	maxRowsPerList: 5_000,
	maxPathBytes: 8 * 1_024 * 1_024,
	maxPageRows: 200,
	maxPageBytes: 256 * 1_024,
	maxDirectoryPrefixes: 2_048,
	maxDirectoryPrefixChars: 256 * 1_024,
	maxStatsOperations: 1_000_000,
	maxDiffBytes: 256 * 1_024,
	maxNameChars: 120,
	readTimeoutMs: 15_000,
	writeTimeoutMs: 120_000,
});

export interface GitStagingCapability {
	supported: boolean;
	reason?: string;
}

export type GitStagingState =
	| "uninitialized"
	| "ready"
	| "stale"
	| "incomplete"
	| "conflict"
	| "recovering";

export interface GitStagingVersion {
	generation: number;
	observationId: string | null;
}

export interface GitStagingList {
	id: string;
	name: string;
	/** Per-list content identity, independent of metadata and other lists' writes. */
	snapshotVersion: string;
	active: boolean;
	fileCount: number;
	unitCount: number;
	added: number;
	removed: number;
	needsReviewCount: number;
	stats: GitStagingStatsBuckets;
}

export interface GitStagingSummary extends GitStagingVersion {
	capability: GitStagingCapability;
	workspaceKey: string;
	initialized: boolean;
	activeListId: string | null;
	scannedAt: number | null;
	state: GitStagingState;
	lists: GitStagingList[];
	/** All changed paths, deduplicated across ownership lists. */
	stats: GitStagingStatsBuckets;
}

/** Binary and gitlink changes have no source-code line count. */
export type GitStagingFileStats =
	| { kind: "text"; added: number; removed: number }
	| { kind: "binary" }
	| { kind: "gitlink" };

export type GitStagingStatsStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U" | "X" | "B";

export interface GitStagingStatsTotal {
	files: number;
	/** Text only; binary files and gitlinks are counted separately. */
	added: number;
	removed: number;
	binaryFiles: number;
	gitlinkFiles: number;
}

export type GitStagingStatsBuckets = Partial<Record<GitStagingStatsStatus, GitStagingStatsTotal>>;

export interface GitStagingPageStats {
	/** Aggregates cover the complete version, independently of file pagination. */
	complete: true;
	total: GitStagingStatsBuckets;
	/** Only this page's ancestor directories; each covers all its descendants. */
	directories: Array<{ path: string; byStatus: GitStagingStatsBuckets }>;
}

export interface GitStagingFile {
	fileId: string;
	path: string;
	oldPath?: string;
	status: string;
	stats: GitStagingFileStats;
	unitCount: number;
	needsReviewCount: number;
}

export interface GitStagingFilesPage extends GitStagingVersion {
	workspaceKey: string;
	listId: string;
	files: GitStagingFile[];
	nextCursor: string | null;
	complete: boolean;
	snapshotVersion: string;
	stats: GitStagingPageStats;
}

export type GitStagingUnitKind =
	| "text"
	| "binary"
	| "symlink"
	| "gitlink"
	| "mode"
	| "create"
	| "delete"
	| "rename";

/** Backend identities and half-open line ranges; display hunks are never write requests. */
export interface GitStagingUnit {
	id: string;
	fileId: string;
	path: string;
	oldPath?: string;
	kind: GitStagingUnitKind;
	listId: string;
	baseStart: number;
	baseEnd: number;
	workStart: number;
	workEnd: number;
	added: number;
	removed: number;
	/** v1 compatibility: new observations always emit false. */
	needsReview: boolean;
	/** v1 compatibility: omitted after a normal sync upgrades legacy ownership. */
	reviewReason?: string;
}

/** Display-only ranges in parseUnifiedDiff(diff).lines; never a write selector. */
export interface GitStagingUnitDiffMapping {
	unitId: string;
	/** Zero-based, half-open ranges containing only this unit's added/removed rows. */
	lineRanges: Array<{ start: number; end: number }>;
}

export interface GitStagingDiff extends GitStagingVersion {
	path: string;
	diff: string;
	truncated: boolean;
	snapshotVersion: string;
	units: GitStagingUnit[];
	/** Complete, proven projections only; absent for older or truncated previews. */
	unitMappings?: GitStagingUnitDiffMapping[];
}

export interface GitStagingCommitIdentity {
	name: string;
	email: string;
}

export interface GitStagingExpectedVersion {
	expectedGeneration: number;
	observationId: string;
}

/** Authorization is supplied by the route, never this DTO. */
export type GitStagingAction =
	| { action: "init" }
	| { action: "sync" }
	| (GitStagingExpectedVersion & { action: "create"; name: string })
	| (GitStagingExpectedVersion & { action: "rename"; listId: string; name: string })
	| (GitStagingExpectedVersion & { action: "activate"; listId: string })
	| (GitStagingExpectedVersion & { action: "delete"; listId: string })
	| (GitStagingExpectedVersion & {
			action: "move";
			fromListId: string;
			toListId: string;
			unitIds?: string[];
			paths?: string[];
			scope?: { filter?: GitStatusFilterChar[]; directory?: string };
			/** Select every unit owned by fromListId, including files outside loaded pages. */
			all?: true;
	  })
	| (GitStagingExpectedVersion & {
			action: "commit";
			listId: string;
			message: string;
			identity?: GitStagingCommitIdentity;
	  })
	| (GitStagingExpectedVersion & { action: "recover"; operationId: string });

export interface GitStagingActionResult extends GitStagingVersion {
	outcome: "applied" | "partial";
	listId?: string;
	affectedListIds: string[];
	commitOid?: string;
	operationId?: string;
	reason?: string;
	/** The sync request's covered observation target; not a replacement for CAS. */
	observation?: GitStagingObservationState;
	/** A sync waiter completes at this target even if a newer dirty epoch is pending. */
	observationTargetEpoch?: number;
}
