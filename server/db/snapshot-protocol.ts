import type { ProviderSettingsTargetKind } from "../../shared/provider-settings";

// 导出快照构建子进程的协议：flag、环境变量、表清单。
//
// 与 integrity-protocol 同构：父进程按 flag 自 spawn，本进程只读源库、只写目标库，
// 不导入任何应用模块，因此不会打开主库的写连接、也不会拿实例锁。

export const DB_SNAPSHOT_WORKER_FLAG = "--narrafork-db-snapshot";
export const DB_SNAPSHOT_SOURCE_ENV = "NARRAFORK_SNAPSHOT_SOURCE";
export const DB_SNAPSHOT_OUTPUT_ENV = "NARRAFORK_SNAPSHOT_OUTPUT";
/** `requests,sessions` 的子集；缺省表示两类都要。 */
export const DB_SNAPSHOT_KINDS_ENV = "NARRAFORK_SNAPSHOT_KINDS";
export const DB_SNAPSHOT_PROVIDER_SETTINGS = "providers";
export const PROVIDER_SETTINGS_SEALED_ENTRY = "provider-settings.sealed.json";
export const PROVIDER_SETTINGS_TRANSFER_LIMITS = { records: 512, bytes: 4 * 1024 * 1024 } as const;

/**
 * 导入会读的表（外加 settings 里的 providers）。快照只带它们。
 * 新表不会自动进来：要跨机迁移就必须加进这里，并在 `applyImport` 里 `copyTable`。
 */
export const SNAPSHOT_TABLES = {
	// Provider settings are copied with host ciphertext/key ownership columns removed.
	providers: ["plugin_provider_settings"],
	requests: ["api_requests"],
	sessions: [
		// 顺序即建表顺序：消息指向会话，块指向消息。
		"narrators",
		// Explicit NULL roots are durable; peers are restored only after target-side ACL checks.
		"narrator_communication_nodes",
		"narrator_communication_peers",
		"narrator_messages",
		"narrator_message_refs",
		"narrator_tool_calls",
		// `body_rows_only = 1` 时正文只在块行里，content_json 是空数组。
		"narrator_blocks",
		// Prefix epoch / updates / tools manifests and all their content-addressed children.
		"narrator_text_snapshots",
		// Per-user folder placement remembered between archive and unarchive.
		"recent_tab_archive_marks",
		// Personal folder-level Git identity picks. Import validates the referenced user and
		// identity in the target database, and never reassigns a pick across users.
		"folder_git_identity_bindings",
	],
} as const;

/** Stable identities only; never credentials, display names, plugin packages or grants. */
export interface ProviderSettingsTransferTarget {
	kind: ProviderSettingsTargetKind;
	id: string;
}

export interface SnapshotBuildResult {
	ok: boolean;
	error?: string;
	providerSettingsCount?: number;
	/** Validated source records whose mapped extension address was already staged. */
	providerSettingsSkipped?: number;
	providerSettingsSealed?: boolean;
}
