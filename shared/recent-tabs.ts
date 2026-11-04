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

/**
 * `workspace`, `group` and `chapter` are retired: they still decode from historical
 * data, but the sidebar never stores them any more (workspace groups became folders).
 */
export type RecentTabType =
	| "chapter"
	| "narrator"
	| "project"
	| "workspace"
	| "subagent"
	| "group"
	| "folder";

export type RecentTabsSection = "projects" | "work";

/** Members shown by an open-but-not-expanded folder when the user never chose a number. */
export const RECENT_TAB_FOLDER_DEFAULT_PREVIEW = 3;
export const RECENT_TAB_FOLDER_TITLE_MAX_CHARS = 100;

/** Icon keys a folder may carry. The client maps each key to a Tabler icon. */
export const RECENT_TAB_FOLDER_ICONS = [
	"folder",
	"star",
	"heart",
	"flag",
	"bookmark",
	"bolt",
	"flame",
	"rocket",
	"bug",
	"code",
	"terminal",
	"book",
	"bulb",
	"briefcase",
	"home",
	"flask",
	"palette",
	"music",
	"world",
	"lock",
] as const;
export type RecentTabFolderIcon = (typeof RECENT_TAB_FOLDER_ICONS)[number];

/** Colour keys a folder may carry; Mantine palette names. */
export const RECENT_TAB_FOLDER_COLORS = [
	"gray",
	"red",
	"pink",
	"grape",
	"violet",
	"indigo",
	"blue",
	"cyan",
	"teal",
	"green",
	"lime",
	"yellow",
	"orange",
] as const;
export type RecentTabFolderColor = (typeof RECENT_TAB_FOLDER_COLORS)[number];

/** Durable recent-tab fields. Live status details are returned separately as runtime patches. */
export interface PersistedRecentTab {
	type: RecentTabType;
	id: string;
	narratorId?: string;
	parentNarratorId?: string;
	/**
	 * The folder this tab belongs to (a `type: "folder"` tab's id). Members follow
	 * their folder's header contiguously in the flat order; folders never nest.
	 */
	folderId?: string;
	title: string;
	subtitle?: string;
	status?: string;
	lastVisitedAt: number;
	/**
	 * Top-level tab or folder: pinned to the top of the list. Folder member: pinned to
	 * the top of its folder.
	 */
	pinned?: boolean;
	isScheduled?: boolean;
	/** Folder tabs only. */
	folderIcon?: RecentTabFolderIcon;
	folderColor?: RecentTabFolderColor;
	/** Folder tabs only; absent means {@link RECENT_TAB_FOLDER_DEFAULT_PREVIEW}. */
	folderPreviewCount?: number;
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
