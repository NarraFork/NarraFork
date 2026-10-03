/** Local narrator worktree management. No remote cwd, removal, pruning or implicit switching. */
export interface WorktreeEntry {
	path: string;
	head: string | null;
	branch: string | null;
	detached: boolean;
	locked: boolean;
	prunable: boolean;
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
export interface WorktreeListResult {
	repositoryKey: string | null;
	entries: WorktreeEntry[];
	truncated: boolean;
	capabilities: {
		list: boolean;
		create: boolean;
		switch: false;
		delete: false;
		prune: false;
		remote: false;
		reason?: string;
	};
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
