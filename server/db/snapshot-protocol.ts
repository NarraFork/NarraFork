// 导出快照构建子进程的协议：flag、环境变量、表清单。
//
// 与 integrity-protocol 同构：父进程按 flag 自 spawn，本进程只读源库、只写目标库，
// 不导入任何应用模块，因此不会打开主库的写连接、也不会拿实例锁。

export const DB_SNAPSHOT_WORKER_FLAG = "--narrafork-db-snapshot";
export const DB_SNAPSHOT_SOURCE_ENV = "NARRAFORK_SNAPSHOT_SOURCE";
export const DB_SNAPSHOT_OUTPUT_ENV = "NARRAFORK_SNAPSHOT_OUTPUT";
/** `requests,sessions` 的子集；缺省表示两类都要。 */
export const DB_SNAPSHOT_KINDS_ENV = "NARRAFORK_SNAPSHOT_KINDS";

/** 导入只读这 5 张表（外加 settings 里的 providers），快照因此只带它们。 */
export const SNAPSHOT_TABLES = {
	requests: ["api_requests"],
	sessions: [
		// 顺序即建表顺序：narrator_messages 的外键指向 narrators。
		"narrators",
		"narrator_messages",
		"narrator_message_refs",
		"narrator_tool_calls",
	],
} as const;

export interface SnapshotBuildResult {
	ok: boolean;
	error?: string;
}
