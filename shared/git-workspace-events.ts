import type { GitLineStatsFile } from "./git-line-stats";
import type { GitStatusPageCacheState } from "./git-status-page";

/** Published SQLite observation plus database/WAL identities, sampled in the Worker. */
export interface GitStagingWatchState {
	fingerprint: string;
	databaseIdentity: string;
	generation: number;
	observationId: string | null;
	listIds: string[];
}

/** Scheduling state, not an ownership version or an authorization grant. */
export interface GitStagingObservationState {
	instanceId: string;
	stateSequence: number;
	epoch: number;
	completedEpoch: number;
	round: number;
	status: "pending" | "observing" | "failed" | "settled";
	generation: number;
	observationId: string | null;
	errorCode?: string;
}

export type GitWorkspaceCategory = "worktree" | "index" | "refs" | "head" | "stash";
export type GitWorkspaceView = "summary" | "details";

/** File-page validation is independent of conservative statistical refresh categories. */
export interface GitStatusPagesWatchState {
	statusPagesChanged: boolean;
	statusPagesReliable: boolean;
}

/** A projection of shared Git facts, never permissions or modification attribution. */
export interface GitWorkspaceSnapshot {
	/** Published paging cache state, independent from summary/detail measurement completion. */
	statusPages?: GitStatusPageCacheState;
	revision: number;
	updating: boolean;
	status?: {
		hasChanges: boolean;
		staged: number;
		unstaged: number;
		untracked: number;
		totalFiles: number;
		totalFilesExact?: boolean;
		headSha: string;
		branch: string;
		truncated?: boolean;
		/** Only present in the details projection. */
		files?: Array<{ status: string; path: string; oldPath?: string }>;
	};
	lineStats?: {
		linesAdded: number;
		linesRemoved: number;
		complete: boolean;
		/** Only present in the details projection; totals cover the whole measurement. */
		files?: GitLineStatsFile[];
	};
	statusError?: string;
	lineStatsError?: string;
	/** The transmitted detail list was capped, independently of measurement completeness. */
	detailsTruncated?: boolean;
}

export interface GitWorkspaceSubscribe {
	type: "git_workspace_subscribe";
	subscriptionId: string;
	narratorId?: string;
	workspaceKey?: string;
	view?: GitWorkspaceView;
}
export type GitWorkspaceClientMessage =
	| GitWorkspaceSubscribe
	| {
			type: "git_workspace_unsubscribe" | "git_workspace_refresh";
			subscriptionId: string;
	  };
/** An omitted affectedListIds invalidates all groups; versions identify the published observation. */
export interface GitStagingListsChanged {
	workspaceKey: string;
	listId?: string;
	metadataChanged?: boolean;
	metadataListId?: string;
	affectedListIds?: string[];
	generation?: number;
	observationId?: string | null;
}

export interface GitWorkspaceEventIdentity {
	subscriptionId: string;
	version: number;
	workspaceKey: string;
	repositoryKey: string;
	narratorId?: string;
}
/** Errors revoke authorization continuity until a newer subscribed acknowledgement. */
export type GitWorkspaceErrorKind = "retryable" | "denied" | "workspace_changed" | "unavailable";

export interface GitWorkspaceError {
	type: "git_workspace_error";
	subscriptionId: string;
	/** GIT_WORKSPACE_SUBSCRIPTION_LIMIT rejects registration; retry with a new subscription id. */
	code: string;
	message: string;
	/** Optional only for compatibility with older servers; new servers always include it. */
	kind?: GitWorkspaceErrorKind;
	/** Shares the subscription's increasing sequence with acknowledgements and facts. */
	version?: number;
	/** True only while automatic reauthorization is scheduled or in flight. */
	retrying?: boolean;
}

export type GitWorkspaceServerMessage =
	| ({ type: "git_workspace_subscribed" } & GitWorkspaceEventIdentity)
	| ({
			type: "git_workspace_staging_observation";
			observation: GitStagingObservationState;
	  } & GitWorkspaceEventIdentity)
	| ({ type: "git_workspace_staging_lists_changed" } & GitStagingListsChanged &
			GitWorkspaceEventIdentity)
	| ({
			type: "git_workspace_changed";
			categories: GitWorkspaceCategory[];
			statusPagesChanged?: boolean;
			statusPagesReliable?: boolean;
	  } & GitWorkspaceEventIdentity)
	| ({
			type: "git_workspace_snapshot";
			view: GitWorkspaceView;
			snapshot: GitWorkspaceSnapshot;
	  } & GitWorkspaceEventIdentity)
	| GitWorkspaceError;
