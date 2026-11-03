// 导出快照构建子进程的协议：flag、环境变量、表清单。
//
// 与 integrity-protocol 同构：父进程按 flag 自 spawn，本进程只读源库、只写目标库，
// 不导入任何应用模块，因此不会打开主库的写连接、也不会拿实例锁。

export const DB_SNAPSHOT_WORKER_FLAG = "--narrafork-db-snapshot";
export const DB_SNAPSHOT_SOURCE_ENV = "NARRAFORK_SNAPSHOT_SOURCE";
export const DB_SNAPSHOT_OUTPUT_ENV = "NARRAFORK_SNAPSHOT_OUTPUT";
/** `requests,sessions` 的子集；缺省表示两类都要。 */
export const DB_SNAPSHOT_KINDS_ENV = "NARRAFORK_SNAPSHOT_KINDS";

/**
 * 导入会读的表（外加 settings 里的 providers）。快照只带它们。
 * 新表不会自动进来：要跨机迁移就必须加进这里，并在 `applyImport` 里 `copyTable`。
 */
export const SNAPSHOT_TABLES = {
	requests: ["api_requests"],
	sessions: [
		// 顺序即建表顺序：消息指向会话，块指向消息。
		"narrators",
		"narrator_messages",
		"narrator_message_refs",
		"narrator_tool_calls",
		// `body_rows_only = 1` 时正文只在块行里，content_json 是空数组。
		"narrator_blocks",
		// Prefix epoch / updates / tools manifests and all their content-addressed children.
		"narrator_text_snapshots",
	],
} as const;

export interface SnapshotBuildResult {
	ok: boolean;
	error?: string;
}
