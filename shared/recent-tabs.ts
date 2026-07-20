export const RECENT_TABS_STORAGE_LIMIT = 500;
export const RECENT_TABS_PAGE_SIZE = 50;
export const RECENT_TABS_LIVE_LIMIT = 100;
export const RECENT_TABS_WS_BATCH_SIZE = 100;
export const NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION = 500;
export const NARRATOR_WS_SUBSCRIPTION_LIMIT_ERROR_CODE = "NARRATOR_SUBSCRIPTION_LIMIT_EXCEEDED";
export const RECENT_TABS_LEGACY_LIMIT = 20;
export const RECENT_TABS_STALE_CURSOR_CODE = "STALE_CURSOR";
export const RECENT_TABS_UNDO_CONFLICT_CODE = "RECENT_TABS_UNDO_CONFLICT";

export interface NarratorWsSubscriptionLimitError {
	type: "error";
	code: typeof NARRATOR_WS_SUBSCRIPTION_LIMIT_ERROR_CODE;
	message: string;
	maxSubscriptions: typeof NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION;
}

export type RecentTabType = "chapter" | "narrator" | "project" | "workspace" | "subagent" | "group";

export type RecentTabsSection = "projects" | "work";

/** Durable recent-tab fields. Live status details are returned separately as runtime patches. */
export interface PersistedRecentTab {
	type: RecentTabType;
	id: string;
	narratorId?: string;
	parentNarratorId?: string;
	workspaceId?: string | null;
	title: string;
	subtitle?: string;
	status?: string;
	lastVisitedAt: number;
	pinned?: boolean;
	isScheduled?: boolean;
}

/** Incremental operations used by mutation responses and user-scoped WebSocket deltas. */
export type RecentTabsOperation =
	| {
			type: "upsert";
			key: string;
			tab: PersistedRecentTab;
			beforeKey: string | null;
			afterKey: string | null;
	  }
	| { type: "remove"; key: string }
	| {
			type: "move";
			key: string;
			beforeKey: string | null;
			afterKey: string | null;
	  };

export interface RecentTabsPageResult {
	items: PersistedRecentTab[];
	revision: number;
	hasMore: boolean;
	nextCursor: string | null;
}

export interface RecentTabsMutationResult {
	changed: boolean;
	baseRevision: number;
	revision: number;
	operations: RecentTabsOperation[];
	removedCount?: number;
	undoToken?: string;
}

export interface RecentTabsDelta {
	type: "user:recent_tabs_delta";
	baseRevision: number;
	revision: number;
	operations: RecentTabsOperation[];
	/** Zero-based frame index for one committed delta. */
	batchIndex: number;
	/** Total frame count; clients apply the revision only after collecting every frame. */
	batchCount: number;
}

export interface RecentTabRuntimePatch {
	key: string;
	patch: Record<string, unknown>;
}

export interface RecentTabsRuntimeResult {
	revision: number;
	patches: RecentTabRuntimePatch[];
}
