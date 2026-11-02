// 父进程侧：在子进程里构建导出快照（只读源库），带超时与输出上限。
//
// 与 integrity-check 的自 spawn 方式一致：编译态直接用自身可执行文件 + flag，
// 开发态用同一个入口文件，两种运行环境共享一条代码路径。

import { fileURLToPath } from "node:url";
import {
	DB_SNAPSHOT_KINDS_ENV,
	DB_SNAPSHOT_OUTPUT_ENV,
	DB_SNAPSHOT_SOURCE_ENV,
	DB_SNAPSHOT_WORKER_FLAG,
	type SnapshotBuildResult,
} from "./snapshot-protocol";

/** 大库的 INSERT…SELECT + VACUUM 可能几十秒；超过这个上限视为失败并杀掉子进程。 */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

function isCompiledRuntime(): boolean {
	return import.meta.url.includes("$bunfs/") || import.meta.url.includes("%7EBUN/");
}

function buildCommand(): string[] {
	if (isCompiledRuntime()) return [process.execPath, DB_SNAPSHOT_WORKER_FLAG];
	const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
	return [process.execPath, entry, DB_SNAPSHOT_WORKER_FLAG];
}

async function readBounded(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let out = "";
	let bytes = 0;
	try {
		while (bytes < MAX_OUTPUT_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			bytes += value.byteLength;
			out += decoder.decode(value, { stream: true });
		}
		out += decoder.decode();
	} catch {
		// 部分输出仍可用于诊断
	} finally {
		try {
			await reader.cancel();
		} catch {
			// best effort
		}
	}
	return out;
}

/**
 * 在子进程里把导入需要的表复制成快照。
 *
 * 失败时抛出可读错误（导出方据此报错，不会留下半个包）；源库始终保持只读。
 */
export async function buildSnapshotInSubprocess(input: {
	sourcePath: string;
	outputPath: string;
	requests: boolean;
	sessions: boolean;
	timeoutMs?: number;
}): Promise<void> {
	const kinds = [input.requests ? "requests" : "", input.sessions ? "sessions" : ""]
		.filter(Boolean)
		.join(",");
	if (!kinds) throw new Error("snapshot requested with nothing selected");
	const [command, ...args] = buildCommand();
	const child = Bun.spawn([command as string, ...args], {
		env: {
			...process.env,
			[DB_SNAPSHOT_SOURCE_ENV]: input.sourcePath,
			[DB_SNAPSHOT_OUTPUT_ENV]: input.outputPath,
			[DB_SNAPSHOT_KINDS_ENV]: kinds,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		const [stdout, exitCode] = await Promise.all([readBounded(child.stdout), child.exited]);
		if (exitCode !== 0) {
			let detail = "";
			try {
				detail = (JSON.parse(stdout) as SnapshotBuildResult).error ?? "";
			} catch {
				detail = stdout.slice(0, 200);
			}
			throw new Error(`snapshot builder failed (exit ${exitCode})${detail ? `: ${detail}` : ""}`);
		}
	} finally {
		clearTimeout(timer);
	}
}
