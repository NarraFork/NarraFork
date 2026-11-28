/** Shared wire types and pure status semantics. No application/runtime dependencies. */
export const GIT_STATUS_FILTER_CHARS = ["A", "M", "D", "R", "C", "U"] as const;
export type GitStatusFilterChar = (typeof GIT_STATUS_FILTER_CHARS)[number];
export type GitStatusPageSection = "staged" | "unstaged";
export const GIT_STATUS_PAGE_DEFAULT_LIMIT = 100;
export const GIT_STATUS_PAGE_MAX_LIMIT = 200;
export const GIT_STATUS_PAGE_MAX_BYTES = 256 * 1024;

/** Workspace-scoped cache identity; never an actor's pagination snapshot identifier. */
export interface GitStatusPageCacheState {
	status: "pending" | "ready" | "error";
	workerEpoch: string;
	memberVersion: number;
	statsVersion: number;
	updating: boolean;
	/** Member/source production failure. */
	errorCode?: string;
	/** Statistics production failure; member observations remain independently usable. */
	statsErrorCode?: string;
	message?: string;
}

export interface GitStatusPageUnavailable {
	status: "pending" | "error";
	cache: GitStatusPageCacheState;
}

/** Ready keeps the existing page DTO at the top level. */
export type GitStatusPageResult =
	| (GitStatusPage & { status: "ready"; cache: GitStatusPageCacheState })
	| GitStatusPageUnavailable;
export type GitStatusPageStatsResponse =
	| (GitStatusPageStatsResult & { status: "ready"; cache: GitStatusPageCacheState })
	| GitStatusPageUnavailable;

export interface GitStatusPageQuery {
	cursor?: string;
	limit?: number;
	filter?: GitStatusFilterChar[];
}

export interface GitStatusPageStatsRow {
	type: "file" | "directory";
	section: GitStatusPageSection;
	path: string;
}

export interface GitStatusPageStatsQuery {
	snapshotId: string;
	filter?: GitStatusFilterChar[];
	rows: GitStatusPageStatsRow[];
}

export interface GitStatusPageStatsResult {
	snapshotId: string;
	rows: Array<GitStatusPageStatsRow & { added?: number; removed?: number; complete: boolean }>;
}

export interface GitStatusPageFile {
	path: string;
	status: string;
	oldPath?: string;
	linesAdded?: number;
	linesRemoved?: number;
	stagedLinesAdded?: number;
	stagedLinesRemoved?: number;
	unstagedLinesAdded?: number;
	unstagedLinesRemoved?: number;
}

export type GitStatusPageLimitReason =
	| "records"
	| "bytes"
	| "timeout"
	| "remote-truncated"
	| "remote-incomplete";

export interface GitStatusPageCounts {
	/** Counts describe the scanned snapshot, never the current page. */
	totalFiles: number;
	staged: number;
	/** Tracked worktree changes; untracked is a separate count. */
	unstaged: number;
	untracked: number;
	/** Unique files with at least one matching section. */
	filteredFiles: number;
	filteredStaged: number;
	/** Matching worktree rows, including untracked additions. */
	filteredUnstaged: number;
	/** Unfiltered row counts: AM contributes both A and M. */
	badgeCounts: Record<GitStatusFilterChar, number>;
	/** False means every count is a lower bound on an incomplete scan. */
	exact: boolean;
}

export interface GitStatusPage {
	snapshotId: string;
	/** Idle-expiry upper bound in Unix milliseconds; invalidation/eviction may occur sooner. */
	expiresAt: number;
	/** Unique files; use gitStatusMatchesSection when rendering each section. */
	files: GitStatusPageFile[];
	nextCursor: string | null;
	/** More cached matches, not a claim that the underlying scan was complete. */
	hasMore: boolean;
	/** Only true when Git reached natural EOF within all scanning budgets. */
	complete: boolean;
	limitReason?: GitStatusPageLimitReason;
	counts: GitStatusPageCounts;
}

/** Proof attached only to filtered/directory batch writes; file sets are verified by the Worker. */
export interface GitStatusPageScopeProof {
	snapshotId: string;
	filter: GitStatusFilterChar[];
	section: GitStatusPageSection;
	/** Repository-relative directory; omitted for the whole matching section. */
	directory?: string;
}

export interface GitStatusPageValidation {
	changed: boolean;
	/** True only after comparing a complete fresh bounded scan with cached observations. */
	reliable: boolean;
}

export type GitStatusPageErrorCode =
	| "GIT_STATUS_PAGE_INVALID_QUERY"
	| "GIT_STATUS_PAGE_INVALID_CURSOR"
	| "GIT_STATUS_PAGE_EXPIRED"
	| "GIT_STATUS_PAGE_BUSY"
	| "GIT_STATUS_PAGE_CLOSED"
	| "GIT_STATUS_PAGE_CANCELLED"
	| "GIT_STATUS_PAGE_SOURCE_FAILED"
	| "GIT_STATUS_PAGE_RECORD_TOO_LARGE";

export function isGitStatusFilterChar(value: unknown): value is GitStatusFilterChar {
	return (
		typeof value === "string" && (GIT_STATUS_FILTER_CHARS as readonly string[]).includes(value)
	);
}

export function normalizeGitStatusFilter(
	filter: readonly GitStatusFilterChar[] = [],
): GitStatusFilterChar[] {
	return GIT_STATUS_FILTER_CHARS.filter((char) => filter.includes(char));
}

export function gitStatusInSection(status: string, section: GitStatusPageSection): boolean {
	if (section === "staged") return !!status[0] && status[0] !== " " && status[0] !== "?";
	return status === "??" || (!!status[1] && status[1] !== " " && status[1] !== "?");
}

/** Matches the panel's per-section badge, including pair-wide conflict handling. */
export function gitStatusBadgeChar(
	status: string,
	section: GitStatusPageSection,
): GitStatusFilterChar {
	const [x, y] = status;
	if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "U";
	if (status.startsWith("?")) return "A";
	const own = section === "staged" ? x : y;
	const other = section === "staged" ? y : x;
	if (isGitStatusFilterChar(own)) return own;
	return isGitStatusFilterChar(other) ? other : "M";
}

export function gitStatusMatchesSection(
	status: string,
	section: GitStatusPageSection,
	filter: readonly GitStatusFilterChar[] = [],
): boolean {
	return (
		gitStatusInSection(status, section) &&
		(filter.length === 0 || filter.includes(gitStatusBadgeChar(status, section)))
	);
}
