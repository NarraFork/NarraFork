/**
 * Local narrator worktree management. This service never switches the caller's
 * working directory — the CreateWorktree/AttachWorktree tools do that after a
 * creation — and never handles a remote cwd. Removal exists only for worktrees with a
 * resource record (`recorded`), and never prunes anything but the removed entry.
 */
export interface WorktreeEntry {
	path: string;
	head: string | null;
	branch: string | null;
	detached: boolean;
	locked: boolean;
	prunable: boolean;
	/** List-only approximate directory creation time (filesystem birthtime), not Git registration. */
	createdAt?: number | null;
	/** List-only HEAD commit time in milliseconds, including detached HEAD; unknown is null. */
	lastCommitAt?: number | null;
	/**
	 * List-only: NarraFork created this checkout and still holds its resource record, so
	 * it may be removed. Absent or false for everything else, including old `.worktrees/`
	 * directories that predate the record.
	 */
	recorded?: boolean;
}
export interface WorktreeCreateRequest {
	expectedRevision: number;
	workspaceKey: string;
	requestId: string;
	destinationPath: string;
	/** Name may be omitted only for new branches; the resolved name is persisted before Git. */
	branch: { kind: "new" | "existing"; name?: string };
	baseRef?: string;
}
export interface WorktreeCreateResult {
	outcome: "created" | "failed" | "unknown";
	worktree: WorktreeEntry | null;
	residuals: { destinationExists: boolean | null; branchExists: boolean | null };
	error?: { code: string; message: string };
}
export interface WorktreePrepareRequest {
	expectedRevision: number;
	workspaceKey: string;
	/** Explicit branch name wins over model naming. */
	name?: string;
	requirement?: string;
	/** Advanced explicit override, preferred over name/model suggestions. */
	branchName?: string;
	/** Advanced final destination; unused default paths are never probed for collisions. */
	destinationPath?: string;
}
/** Read-only recovery uses the exact original creation proposal, even after its revision changed. */
export type WorktreeReconcileRequest = WorktreeCreateRequest;
export interface WorktreePrepareResult {
	branchName: string;
	worktreeName: string;
	destinationPath: string;
}
export interface WorktreeListQuery {
	limit?: number;
	cursor?: string;
	sort?: "lastCommitAt" | "createdAt" | "name";
	order?: "asc" | "desc";
	search?: string;
}
export interface WorktreeListResult {
	/** Omitted only by older hosts; new list responses always include pagination. */
	nextCursor?: string | null;
	hasMore?: boolean;
	repositoryKey: string | null;
	entries: WorktreeEntry[];
	truncated: boolean;
	capabilities: {
		list: boolean;
		create: boolean;
		switch: false;
		/** Recorded worktrees can be removed (see `WorktreeEntry.recorded`). */
		delete: boolean;
		prune: false;
		remote: false;
		reason?: string;
	};
}

export interface WorktreeRemovalQuery {
	workspaceKey: string;
	/** Exact path from the worktree list; it must have a resource record. */
	path: string;
	/** Commits are "kept" when reachable from this ref or the branch upstream. Default HEAD. */
	baseRef?: string;
}
/** What removing a worktree would lose, measured right now. */
export interface WorktreeRemovalReport {
	path: string;
	/** Short branch name; null for a detached checkout. */
	branch: string | null;
	head: string | null;
	base: { ref: string; sha: string };
	upstream: { ref: string; sha: string } | null;
	/** Uncommitted (changed, staged or untracked, not ignored) paths. */
	uncommittedFiles: number;
	/** False when the count is a lower bound (listing cap reached). */
	uncommittedExact: boolean;
	/** Commits reachable from `head` and from neither `base` nor `upstream`. */
	unmergedCommits: number;
	/** The checkout directory is already gone; only Git's entry remains. */
	missing: boolean;
}
/**
 * A person's confirmation that the loss in a report may be discarded. It is only valid
 * while HEAD is unchanged and neither count has grown.
 */
export interface WorktreeRemovalDiscard {
	head: string | null;
	uncommittedFiles: number;
	unmergedCommits: number;
}
export interface WorktreeRemoveRequest extends WorktreeRemovalQuery {
	/** Also delete the branch: only when Git or is-ancestor proves it merged, or `discard`. */
	deleteBranch?: boolean;
	discard?: WorktreeRemovalDiscard;
}
export interface WorktreeRemoveResult {
	removed: true;
	path: string;
	report: WorktreeRemovalReport;
	/** Whether the resource row was deleted; retained when something still references it. */
	record: "retired" | "retained";
	branch: {
		name: string;
		deleted: boolean;
		/** merged: `git branch -d`; contained: tip is in the base; forced: confirmed discard. */
		method?: "merged" | "contained" | "forced";
		error?: { code: string; message: string };
	} | null;
}

/** Bounded display metadata survives leaf projection without parsing truncated JSON. */
export function worktreeListPreview(result: WorktreeListResult) {
	const maxEntries = 100;
	let truncated = result.truncated || result.entries.length > maxEntries;
	const clip = (value: string, limit: number) => {
		if (value.length <= limit) return value;
		truncated = true;
		return `${value.slice(0, limit - 1)}…`;
	};
	const entries = result.entries.slice(0, maxEntries).map((entry) => ({
		path: clip(entry.path, 1024),
		branch: entry.branch === null ? null : clip(entry.branch, 256),
		detached: entry.detached,
	}));
	// At most 100 rows × (1024 + 256) chars, below the aggregate projection budget.
	return { entries, truncated };
}
