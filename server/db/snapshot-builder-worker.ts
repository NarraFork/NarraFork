/**
 * 导出快照构建子进程。
 *
 * 只做一件事：从主库**只读**打开，把导入需要的 5 张表按原 DDL 复制到一个新库里。
 * 放在独立进程是因为 `INSERT … SELECT` 与 `VACUUM` 是 O(数据量) 的同步操作，
 * 在主线程跑会卡住 HTTP/WS/Agent（bun:sqlite 是同步 API）。
 *
 * 不复制索引与触发器：导入只依赖主键与列集合；触发器若一并复制，导入时会重复写 FTS，
 * 而主库自己的触发器会负责维护搜索索引。
 */

import { Database } from "bun:sqlite";
import {
	DB_SNAPSHOT_KINDS_ENV,
	DB_SNAPSHOT_OUTPUT_ENV,
	DB_SNAPSHOT_SOURCE_ENV,
	SNAPSHOT_TABLES,
	type SnapshotBuildResult,
} from "./snapshot-protocol";

function selectedTables(): { all: string[]; copied: string[] } {
	const raw = process.env[DB_SNAPSHOT_KINDS_ENV]?.trim();
	// 缺省（或空）按“两类都要”处理：父进程总是显式传值，这里只是兜底。
	const kinds = raw ? new Set(raw.split(",").map((part) => part.trim())) : undefined;
	const requests = !kinds || kinds.has("requests");
	const sessions = !kinds || kinds.has("sessions");
	const copied = [
		...(requests ? SNAPSHOT_TABLES.requests : []),
		...(sessions ? SNAPSHOT_TABLES.sessions : []),
	];
	// 未选中的类别也建一张空表：导入侧按“三张核心表必须存在”做结构校验，
	// 空表体积可忽略，却免去导入为「缺表」再分叉一条路径。
	return {
		all: [...SNAPSHOT_TABLES.requests, ...SNAPSHOT_TABLES.sessions],
		copied,
	};
}

function build(): SnapshotBuildResult {
	const source = process.env[DB_SNAPSHOT_SOURCE_ENV]?.trim();
	const output = process.env[DB_SNAPSHOT_OUTPUT_ENV]?.trim();
	if (!source || !output) return { ok: false, error: "missing snapshot paths" };

	const { all, copied } = selectedTables();
	if (copied.length === 0) return { ok: false, error: "nothing selected" };

	let src: Database | undefined;
	let out: Database | undefined;
	try {
		src = new Database(source, { readonly: true });
		out = new Database(output);
		out.run("PRAGMA journal_mode = WAL");
		out.run("ATTACH DATABASE ? AS src", [source]);
		try {
			// 用 `CREATE TABLE … AS SELECT … WHERE 0` 建表：列名/列序与源库完全一致，
			// 也就不依赖 `sqlite_master` 的 DDL 文本与真实列是否同步。
			// 快照只需要列结构——导入靠主库自己的约束做 `INSERT OR IGNORE`。
			out.transaction(() => {
				for (const table of all) {
					out?.run(`CREATE TABLE main.${table} AS SELECT * FROM src.${table} WHERE 0`);
				}
			})();
			out.transaction(() => {
				for (const table of copied) {
					out?.run(`INSERT INTO main.${table} SELECT * FROM src.${table}`);
				}
			})();
		} finally {
			out.run("DETACH DATABASE src");
		}
		// 让文件的空闲页回收，导出的体积就是数据本身的体积。
		out.run("VACUUM");
		return { ok: true };
	} catch (error) {
		return { ok: false, error: String(error).slice(0, 500) };
	} finally {
		try {
			out?.close();
		} catch {
			// 关闭失败不影响结果判定
		}
		try {
			src?.close();
		} catch {
			// 同上
		}
	}
}

const result = build();
process.stdout.write(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
