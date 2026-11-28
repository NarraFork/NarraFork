// 父进程侧：专用只读快照进程。业务协议与 5 分钟执行预算不由队列重定义。
import { fileURLToPath } from "node:url";
import { hotSafe } from "../lib/hot-safe";
import { WorkerHandle } from "../lib/worker-runtime/lifecycle";
import { TaskQueue } from "../lib/worker-runtime/queue";
import {
	DB_SNAPSHOT_KINDS_ENV,
	DB_SNAPSHOT_OUTPUT_ENV,
	DB_SNAPSHOT_SOURCE_ENV,
	DB_SNAPSHOT_WORKER_FLAG,
	type SnapshotBuildResult,
} from "./snapshot-protocol";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 16 * 1024;
const owner = hotSafe("narrafork.snapshotBuild.owner", () => ({
	queue: new TaskQueue({ concurrency: 2, maxQueued: 8, maxQueuedBytes: 8 * MAX_INPUT_BYTES }),
	handles: new Set<WorkerHandle<Bun.Subprocess<"ignore", "pipe", "ignore">>>(),
	closing: undefined as Promise<void> | undefined,
}));

function buildCommand(): string[] {
	if (import.meta.url.includes("$bunfs/") || import.meta.url.includes("%7EBUN/"))
		return [process.execPath, DB_SNAPSHOT_WORKER_FLAG];
	return [
		process.execPath,
		fileURLToPath(new URL("../index.ts", import.meta.url)),
		DB_SNAPSHOT_WORKER_FLAG,
	];
}

async function readBounded(
	stream: ReadableStream<Uint8Array>,
	overflow: () => void,
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let out = "";
	let bytes = 0;
	try {
		while (bytes < MAX_OUTPUT_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;
			out += decoder.decode(value.subarray(0, MAX_OUTPUT_BYTES - bytes), { stream: true });
			bytes += value.byteLength;
			if (bytes >= MAX_OUTPUT_BYTES) overflow();
		}
		return out + decoder.decode();
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

/** Close admission first; a successful return confirms every source DB descriptor was closed. */
export function closeSnapshotBuilds(): Promise<void> {
	if (owner.closing) return owner.closing;
	const drained = owner.queue.close();
	owner.closing = (async () => {
		await Promise.all([...owner.handles].map((handle) => handle.close()));
		await drained;
	})();
	return owner.closing;
}

/** Never copies/compacts on the HTTP thread, including when creation or shutdown fails. */
export async function buildSnapshotInSubprocess(input: {
	sourcePath: string;
	outputPath: string;
	requests: boolean;
	sessions: boolean;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<void> {
	const kinds = [input.requests ? "requests" : "", input.sessions ? "sessions" : ""]
		.filter(Boolean)
		.join(",");
	if (!kinds) throw new Error("snapshot requested with nothing selected");
	const bytes = Buffer.byteLength(input.sourcePath) + Buffer.byteLength(input.outputPath);
	if (bytes > MAX_INPUT_BYTES) throw new Error("snapshot input limit exceeded");
	// No prior total deadline: execution still receives its original complete phase budget.
	const permit = await owner.queue.acquire({ deadlineAt: Infinity, bytes, signal: input.signal });
	let handle: WorkerHandle<Bun.Subprocess<"ignore", "pipe", "ignore">> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	const stop = () => {
		stopped = true;
		void handle?.close().catch(() => {});
	};
	try {
		permit.signal.throwIfAborted();
		if (owner.closing) throw new Error("snapshot builder closed");
		handle = WorkerHandle.subprocess(buildCommand(), {
			env: {
				...process.env,
				[DB_SNAPSHOT_SOURCE_ENV]: input.sourcePath,
				[DB_SNAPSHOT_OUTPUT_ENV]: input.outputPath,
				[DB_SNAPSHOT_KINDS_ENV]: kinds,
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			windowsHide: true,
		});
		owner.handles.add(handle);
		permit.signal.addEventListener("abort", stop, { once: true });
		timer = setTimeout(stop, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		const [stdout, exitCode] = await Promise.all([
			readBounded(handle.resource.stdout, stop),
			handle.exited,
		]);
		if (stopped || owner.closing) throw new Error("snapshot builder stopped");
		let report: SnapshotBuildResult | undefined;
		try {
			report = JSON.parse(stdout) as SnapshotBuildResult;
		} catch {
			// Missing/truncated reports are not a successful empty snapshot.
		}
		if (exitCode !== 0 || report?.ok !== true)
			throw new Error(
				`snapshot builder failed (exit ${exitCode}): ${report?.error ?? "no report"}`,
			);
	} finally {
		clearTimeout(timer);
		permit.signal.removeEventListener("abort", stop);
		if (handle) {
			await handle.close();
			owner.handles.delete(handle);
		}
		permit.release();
	}
}
