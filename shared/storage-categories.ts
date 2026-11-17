/**
 * Storage-page categories.
 *
 * Shared so the settings tabs, the scan API, and the background job agree on the
 * same set. Order is the display order on the summary tab.
 */
export const STORAGE_CATEGORY_KEYS = [
	"database",
	"uploads",
	"chatAttachments",
	"shares",
	"worktrees",
	"treeSnapshots",
	"requestRecordings",
	"savedRequestRecordings",
	"dormantIgnored",
	"coordinatorOutputs",
	"containers",
] as const;

export type StorageCategoryKey = (typeof STORAGE_CATEGORY_KEYS)[number];

export function isStorageCategoryKey(value: string): value is StorageCategoryKey {
	return (STORAGE_CATEGORY_KEYS as readonly string[]).includes(value);
}

/** i18n suffix under `storageScanProgress_` in the settings namespace. */
export const STORAGE_CATEGORY_PROGRESS_MESSAGE: Record<StorageCategoryKey, string> = {
	database: "scanning_database",
	uploads: "scanning_uploads",
	chatAttachments: "scanning_chat_attachments",
	shares: "scanning_shares",
	worktrees: "scanning_worktrees",
	treeSnapshots: "scanning_tree_snapshots",
	requestRecordings: "scanning_request_recordings",
	savedRequestRecordings: "scanning_saved_request_recordings",
	dormantIgnored: "scanning_dormant_ignored",
	coordinatorOutputs: "scanning_coordinator_outputs",
	containers: "scanning_containers",
};
