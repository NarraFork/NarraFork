/**
 * Local narrator worktree management.
 *
 * This service never switches the caller's working directory — the
 * CreateWorktree/AttachWorktree tools do that after a creation — and never handles
 * remote cwd. Removal is supported, but only as an explicit user action on a local
 * worktree: the retirement path first relocates every session that still depends on
 * the directory, closes its runtime objects, and only then removes the checkout
 * through the protected lifecycle channel.
 *
 * Only the named path is ever destroyed. `git worktree prune` cannot be aimed at one
 * path, though, so a `prune` removal also drops every other stale registration in the
 * repository; `pruneSiblings` reports exactly how many before the caller confirms, and
 * a `remove` never touches anything but its own checkout.
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
		delete: boolean;
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

/**
 * Explicit removal of one local worktree.
 *
 * Removal is never implied by another action: the caller names the exact path, passes
 * the workspace revision its plan was taken under, and confirms each obstacle the
 * server reported. `expectedRevision` is stale-proofing, not authorization — the
 * protected retirement channel re-checks reality before anything is destroyed.
 */
export interface WorktreeRemovalRequest {
	expectedRevision: number;
	workspaceKey: string;
	path: string;
	/** The caller saw the reported loss and still wants the checkout gone. */
	force?: boolean;
	/**
	 * Required with `force`: the plan's HEAD and loss counts exactly as the person saw
	 * them. A plan that changed since (in either direction) is refused, not forced.
	 */
	confirmedLoss?: WorktreeRemovalConfirmedLoss;
	/** The worktree has no NarraFork owner record; deleting it is the caller's explicit call. */
	acknowledgeUnregistered?: boolean;
}
export interface WorktreeRemovalConfirmedLoss {
	head: string | null;
	dirtyFileCount: number;
	unreachableCommits: number;
}
export interface WorktreeRemovalPlanRequest {
	workspaceKey: string;
	path: string;
}
/** One session whose effective working directory lives inside the worktree. */
export interface WorktreeDependent {
	id: string;
	title: string | null;
	status: "idle" | "working" | "waiting" | "archived";
	/** `self` is the requesting narrator; a subagent is closed with its parent's tree. */
	kind: "self" | "primary" | "subagent";
	running: boolean;
}
/**
 * A reason the server refuses right now. `code` is stable and translated by the client;
 * the server never returns display text.
 */
export interface WorktreeRemovalBlocker {
	code: string;
	params?: Record<string, string | number>;
	dependents?: WorktreeDependent[];
}
/** Runtime objects that removal closes. Listed so the confirmation is informed. */
export interface WorktreeRemovalInventory {
	backgroundTasks: number;
	browserSessions: number;
	terminals: number;
	containers: number;
	volumeSnapshots: number;
	treeSnapshots: number;
}
export type WorktreeRemovalConfirmation = "force" | "acknowledgeUnregistered";
export interface WorktreeRemovalPlan {
	status: "ready" | "blocked";
	expectedRevision: number;
	worktree: {
		path: string;
		branch: string | null;
		head: string | null;
		detached: boolean;
		locked: boolean;
		prunable: boolean;
		/**
		 * What the removal will actually do to the checkout.
		 *
		 * `remove` deletes a present checkout through Git, `prune` drops Git's
		 * registration of an already-deleted one, and `rows` retires NarraFork's own
		 * durable rows for a path Git no longer lists — never a directory on disk.
		 */
		mode: "remove" | "prune" | "rows";
		/**
		 * Other stale registrations removed together with this one. Always 0: the entry of
		 * a deleted checkout is removed by path (`git worktree remove`), never by
		 * `git worktree prune`. Kept for older clients.
		 */
		pruneSiblings: number;
		/** The directory is still on disk. An absent one is pruned, never deleted. */
		present: boolean;
		/** A durable `narrator_worktree_resources` owner row exists for this path. */
		registered: boolean;
		registrationId: string | null;
		state: "preparing" | "ready" | "unknown" | null;
		dirty: boolean;
		/**
		 * Uncommitted paths (untracked files counted one by one). Ignored files are not
		 * counted but are deleted with the directory; skip-worktree/assume-unchanged edits
		 * are invisible to Git. A lower bound when `dirtyExact` is false.
		 */
		dirtyFileCount: number;
		dirtyExact: boolean;
		/** Commits only this (detached) checkout reaches: no branch, remote ref or tag has them. */
		unreachableCommits: number;
	};
	dependents: WorktreeDependent[];
	inventory: WorktreeRemovalInventory;
	blockers: WorktreeRemovalBlocker[];
	confirmations: WorktreeRemovalConfirmation[];
	/** Repository root every dependent is relocated to first; null when none exists. */
	relocateTo: string | null;
}
export interface WorktreeRemovalEffects {
	relocated: number;
	archivedSubagents: number;
	cancelledTasks: number;
	closedBrowsers: number;
	closedTerminals: number;
	prunedRegistrations: number;
	removedTreeSnapshots: number;
}
export interface WorktreeRemovalResult {
	outcome: "removed" | "already_absent" | "failed";
	worktree: WorktreeEntry | null;
	effects: WorktreeRemovalEffects;
	relocatedTo: string | null;
	error?: {
		code: string;
		message: string;
		residuals?: Record<string, boolean | null>;
	};
}
