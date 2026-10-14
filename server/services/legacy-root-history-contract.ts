export interface LegacyRootHistoryInput {
	/** Trusted resolver output only, never a client-supplied database filename. */
	databasePath: string;
	projectId: string;
	chapterIds: string[];
	narratorIds: string[];
	workspacePaths: string[];
	snapshotShadowKeys: string[];
	shadowDirectories: string[];
}

export interface LegacyRootHistoryGuard {
	id: string;
	messageVersion: number;
	messageStructureVersion: number;
	nextSeq: number;
}

export interface LegacyRootHistoryResult {
	status: "empty" | "history" | "unknown";
	digest: string;
	reason?: string;
	guards?: LegacyRootHistoryGuard[];
}

// Deliberately conservative: existence of a tool, scope, operation, patch or original
// is history, even when its current pointers are null. This is NOT history adoption.
export const LEGACY_ROOT_HISTORY_LIMITS = {
	inputs: 128,
	rows: 10_000,
	bytes: 2 * 1024 * 1024,
	filesystemEntries: 512,
	milliseconds: 3_000,
	page: 64,
} as const;

export const LEGACY_ROOT_CHAPTER_POINTERS = [
	"fork_point",
	"merge_commit_sha",
	"pre_merge_target_sha",
	"merge_snapshot_commit_sha",
	"pre_merge_target_snapshot_sha",
	"merged_source_snapshot_sha",
	"head_commit_sha",
	"start_commit_sha",
	"snapshot_commit_sha",
	"dormant_snapshot_commit_sha",
	"parked_snapshot_commit_sha",
	"parked_snapshot_base_tree",
	"anchor_commit_sha",
] as const;

// Required current-schema surface. Preparing LIMIT 0 verifies it without loading
// content_json, original_content, files_json, input/output_json or blob bodies.
export const LEGACY_ROOT_HISTORY_COLUMNS: Record<string, readonly string[]> = {
	chapters: [
		"id",
		"project_id",
		"snapshot_shadow_key",
		"commit_count",
		...LEGACY_ROOT_CHAPTER_POINTERS,
	],
	chapter_commits: ["id", "chapter_id", "sha"],
	file_attributions: [
		"id",
		"device_id",
		"workspace_path",
		"narrator_id",
		"operation_id",
		"effect_id",
		"scope_id",
	],
	narrators: [
		"id",
		"chapter_id",
		"refs_inherited_from",
		"message_version",
		"message_structure_version",
		"next_seq",
	],
	narrator_message_refs: ["id", "narrator_id", "message_id", "seq"],
	narrator_messages: ["id", "narrator_id", "commit_sha", "tree_hash_after", "snapshot_commit_sha"],
	narrator_tool_calls: [
		"id",
		"narrator_id",
		"message_id",
		"tree_hash_before",
		"tree_hash_after",
		"file_change_operation_id",
		"owned_paths_json",
	],
	narrator_file_snapshots: ["id", "narrator_id", "device_id", "file_path", "original_content"],
	narrator_patches: ["id", "narrator_id", "message_id", "before_hash", "after_hash", "files_json"],
	worktree_tree_snapshots: ["id", "device_id", "worktree_path", "tree_hash", "snapshot_commit_sha"],
	file_change_scopes: ["id", "device_id", "canonical_root"],
	file_change_operations: ["id", "project_id", "narrator_id", "tool_call_id"],
	file_change_effects: [
		"id",
		"scope_id",
		"operation_id",
		"before_blob_digest",
		"intended_after_blob_digest",
		"observed_after_blob_digest",
	],
	snapshot_captures: [
		"id",
		"scope_id",
		"operation_id",
		"tree_hash",
		"snapshot_commit_sha",
		"manifest_blob_digest",
	],
	file_change_execution_segments: ["id", "narrator_id"],
	merge_sessions: [
		"id",
		"target_chapter_id",
		"source_chapter_ids",
		"pre_merge_tree",
		"conflict_tree",
		"pre_merge_target_snapshot",
		"merge_source_snapshot",
		"pre_merge_target_sha",
	],
};
