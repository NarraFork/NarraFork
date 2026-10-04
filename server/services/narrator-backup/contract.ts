import type { NarratorBackupProfile, NarratorRestoreMapping } from "@shared/narrator-backup";
import type { ArchiveRow } from "../project-archive/main-store";

export interface BackupActor {
	userId: string;
	isAdmin: boolean;
}
export const BACKUP_TABLES = {
	narrators:
		"id chapter_id api_conversation_id fork_message_id type subagent_type title inherit_mode parent_narrator_id origin_tool_call_id subagent_origin_kind context_summary context_summary_chars context_system_chars context_tools_chars context_char_revision model system_prompt permission_mode previous_permission_mode reasoning_effort fast_mode fast_mode_override relaxed_plan message_count total_cost_usd last_message_at status substatus plan_mode cwd workspace_revision workspace_context error_message refs_inherited_from refs_backfill_cursor enabled_tools variant traits handle handle_fold is_background background_status background_result background_completed_at is_ask_in_passing turn_started_at message_version message_structure_version default_device_id context_project_id owner_user_id visibility write_audience acl_root_narrator_id next_seq created_at updated_at",
	narrator_grants: "id narrator_id principal_type principal_id access granted_by created_at",
	narrator_messages:
		"id narrator_id sdk_message_uuid parent_tool_use_id role content_json content_text context_chars_json tokens_in cost_usd cost_status cost_missing_fields turn_usage_json provider model output_tokens cached_input_tokens cache_creation_input_tokens cache_creation_5m_tokens cache_creation_1h_tokens reasoning_tokens ttft_ms duration_ms context_percent meter_usage meter_unit commit_sha tree_hash_after snapshot_commit_sha command_text created_by origin origin_label edited_at edited_by original_content_json created_at",
	narrator_message_refs:
		"id narrator_id message_id seq is_compact segment_compact_id injection_consumed_at",
	narrator_tool_calls:
		"id narrator_id message_id tool_use_id tool_name input_json output_json input_chars output_chars execution_device_id execution_cwd execution_path_flavor resolved_file_path canonical_file_path runtime_generation execution_targets_json device_selection_source status duration_ms stream_started_at stream_completed_at permission_started_at execution_started_at completed_at error_message permission_decided_by permission_decided_at permission_deny_message permission_decision_reason permission_suggestions is_background execution_identity_version execution_origin_tool_call_id execution_attempt execution_segment_id file_change_operation_id is_file_history_checkpoint tree_hash_before tree_hash_after owned_paths_json input_tokens output_tokens cache_creation_tokens cache_read_tokens cache_creation_5m_tokens cache_creation_1h_tokens input_cost output_cost cache_creation_cost cache_read_cost total_cost cost_status cost_missing_fields provider model result_message_id created_at",
	narrator_whitelist_dirs:
		"id narrator_id path path_flavor path_key access_level enabled target_kind target_value device_scope created_at updated_at",
	narrator_blacklist_dirs:
		"id narrator_id path path_flavor path_key deny_level enabled target_kind target_value device_scope created_at updated_at",
	narrator_whitelist_cmds:
		"id narrator_id pattern enabled target_kind target_value device_scope created_at updated_at",
	narrator_blacklist_cmds:
		"id narrator_id pattern enabled target_kind target_value device_scope created_at updated_at",
	permission_rule_requests:
		"id narrator_id tool_call_id tool_use_id attempt proposal_json proposal_hash reason scope device_id context_revision status rule_id approval_source approval_user_id reflection_conclusion error created_at updated_at",
	narrator_worktree_resources:
		"id owner_narrator_id device_id repository_key worktree_path state create_request_id created_at updated_at",
	narrator_file_snapshots:
		"id narrator_id device_id file_path original_content original_encoding is_binary created_at",
	spec_namespaces: "id narrator_id forked_from_namespace_id created_at updated_at",
	spec_file_revisions:
		"id namespace_id path content content_hash parent_revision_id source_tool_use_id source_message_id created_by created_at",
	spec_namespace_files: "id namespace_id path revision_id deleted updated_at",
	spec_protected_tasks:
		"id namespace_id text_hash text status first_revision_id last_revision_id created_at updated_at completed_at deleted_at",
} as const;
export type BackupTable = keyof typeof BACKUP_TABLES;
export const BACKUP_REQUIRED_COLUMNS: Partial<Record<BackupTable, readonly string[]>> = {
	narrators: [
		"id",
		"owner_user_id",
		"visibility",
		"write_audience",
		"context_project_id",
		"default_device_id",
		"workspace_context",
		"workspace_revision",
		"refs_inherited_from",
		"refs_backfill_cursor",
	],
	narrator_messages: ["id", "narrator_id", "content_json"],
	narrator_message_refs: ["id", "narrator_id", "message_id", "seq", "is_compact"],
	narrator_tool_calls: [
		"id",
		"message_id",
		"execution_identity_version",
		"execution_origin_tool_call_id",
		"execution_attempt",
	],
};
export interface BackupReadQuery {
	table: BackupTable;
	column: string;
	values: readonly string[];
	after?: string;
	limit?: number;
	/** Exclusive effective lazy/fork prefix; only valid for narrator_message_refs. */
	beforeSeq?: number;
	subagentsOnly?: boolean;
}
/** SQLite implementations are used ONLY inside a worker, never on HTTP's event loop. */
export interface NarratorBackupMainStore {
	columns(table: BackupTable): Promise<string[]>;
	read(query: BackupReadQuery): Promise<ArchiveRow[]>;
	/** Consistent read snapshot; must not materialize or write lazy refs in the source. */
	snapshot<T>(action: () => Promise<T>): Promise<T>;
	/** Revalidate IDs/ACL/resource unique paths and insert atomically; conflicts always reject. */
	restore(state: BackupState, actor: BackupActor, check: () => void): Promise<void>;
}
export interface BackupState {
	rows: Partial<Record<BackupTable, ArchiveRow[]>>;
}
export interface BackupObject {
	key: string;
	kind: "git-tree" | "git-blob" | "git-commit" | "upload" | "file-blob" | "worktree-journal";
	digest: string;
	size: number;
	dependencies: string[];
}
export interface BackupManifest {
	format: "narrafork-narrator-backup-v1";
	profile: NarratorBackupProfile;
	sourceInstanceId: string;
	actorUserId: string;
	narratorIds: string[];
	projectIds: string[];
	columns: Partial<Record<BackupTable, string[]>>;
	objects: BackupObject[];
	roots: string[];
	exclusions: string[];
	createdAt: string;
	productionDiskRestoreAllowed: false;
	/** Original runtime/approval/policy state remains here; restore neutralizes executable state. */
	manualActivationRequired: true;
	/** Self-contained source proof; never contains the application's private key. */
	attestation?: { algorithm: "hmac-sha256-v1"; signature: string };
}
export const STATE_EXCLUSIONS = [
	"workspace-bytes",
	"ignored-files",
	"volumes",
	"device-tokens",
	"credentials",
	"oauth-grants",
	"global-settings",
	"leases",
	"write-claims",
	"queues",
	"execution-receipts",
	"git-object-bytes",
	"file-blob-bytes",
	"historical-upload-bytes",
	"worktree-journal-bytes",
	"legacy-file-snapshot-bytes-without-raw-evidence",
];
export const TREE_EXCLUSIONS = STATE_EXCLUSIONS.filter(
	(x) =>
		![
			"workspace-bytes",
			"git-object-bytes",
			"file-blob-bytes",
			"historical-upload-bytes",
			"worktree-journal-bytes",
		].includes(x),
);
export function quoteBackupIdentifier(value: string): string {
	if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw new Error("Invalid backup identifier");
	return `"${value}"`;
}
export function backupColumns(table: BackupTable): string[] {
	return BACKUP_TABLES[table].split(" ");
}
export function isBackupTable(value: string): value is BackupTable {
	return Object.hasOwn(BACKUP_TABLES, value);
}
export function mappingBlockers(
	state: BackupState,
	mapping: NarratorRestoreMapping = {},
): string[] {
	const missing = new Set<string>();
	const require = (kind: keyof NarratorRestoreMapping, value: unknown) => {
		if (typeof value === "string" && value && !mapping[kind]?.[value])
			missing.add(`mapping-required:${kind}:${value}`);
	};
	for (const [table, rows] of Object.entries(state.rows)) {
		for (const row of rows) {
			for (const field of ["owner_user_id", "granted_by", "approval_user_id"])
				require("users", row[field]);
			if (table === "narrator_messages") {
				require("users", row.created_by);
				require("users", row.edited_by);
			}
			if (table === "narrator_grants" && row.principal_type === "user")
				require("users", row.principal_id);
			require("projects", row.context_project_id);
			for (const field of ["default_device_id", "execution_device_id", "device_id"])
				require("devices", row[field]);
			for (const field of [
				"cwd",
				"execution_cwd",
				"resolved_file_path",
				"canonical_file_path",
				"worktree_path",
				"file_path",
			])
				require("paths", row[field]);
			if (table.endsWith("_dirs")) require("paths", row.path);
			if (table === "narrators" && row.cwd && row.default_device_id == null)
				require("devices", "local");
			if (typeof row.workspace_context === "string") {
				const context = JSON.parse(row.workspace_context);
				require("devices", context.deviceId);
				require("paths", context.cwd);
				require("paths", context.git?.rootPath);
				require("projects", context.contextProjectId);
			}
		}
	}
	return [...missing];
}
