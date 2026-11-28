import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { connectCompiledWorker } from "../compiled-worker";
import { DEFAULT_DISK_SAFETY } from "../disk-safety-config";
import { hotSafe } from "../hot-safe";
import { logger } from "../logger";
import { getNarraforkHome } from "../narrafork-home";
import {
	closeRequestRecorderWorkers,
	createRequestRecording,
	downloadSavedRecording,
	RequestRecorderClient,
	saveRequestRecording,
} from "../request-recorder";
import type { RecorderOperation } from "../request-recorder-protocol";
import { RequestRecorderStore } from "../request-recorder-store";
import { settings } from "../settings";
import { WorkerCleanupError, WorkerHandle } from "../worker-runtime/lifecycle";
import type { TaskQueue } from "../worker-runtime/queue";

const configuration = {
	ringEnabled: true,
	ringRequestBytes: 1024 * 1024,
	ringResponseBytes: 1024 * 1024,
	autoPin: "off" as const,
};
const begin = (requestId: string): RecorderOperation => ({
	type: "begin",
	identity: { requestId, narratorId: "n1", provider: "fixture", model: "fixture" },
	continuous: false,
	errorsOnly: false,
});
const chunk = (requestId: string): RecorderOperation => ({
	type: "chunk",
	requestId,
	side: "response",
	kind: "body",
	data: new Uint8Array([65, 66, 67]),
	packet: 1,
	offset: 0,
	total: 3,
	time: "fixture",
});
interface ClientState {
	worker?: Worker;
	ready: boolean;
	retryAt: number;
	retiring?: Promise<void>;
	resources: TaskQueue;
	recordingAdmission: TaskQueue;
	calls: TaskQueue;
	recordings: Map<string, unknown>;
	operationTimers: Map<number, unknown>;
	inflight: Map<number, unknown>;
	queued: unknown[];
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}
async function until(check: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Fixture observation timed out");
		await Bun.sleep(1);
	}
}
let home: string;
let diskSafety: typeof settings.diskSafety;
const clients: RequestRecorderClient[] = [];
const releases: (() => void)[] = [];
const spies: Array<{ mockRestore(): void }> = [];
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "recording-lifecycle-"));
	diskSafety = settings.diskSafety;
	settings.diskSafety = { ...DEFAULT_DISK_SAFETY, mode: "off" };
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.allSettled(clients.splice(0).map((client) => client.close()));
	for (const spy of spies.splice(0)) spy.mockRestore();
	settings.diskSafety = diskSafety;
	await rm(home, { recursive: true, force: true });
});
function fixture(
	data: Record<string, unknown> = {},
	options: {
		readyTimeoutMs?: number;
		operationTimeoutMs?: number;
		exitGate?: Promise<void>;
		invalidEntry?: boolean;
	} = {},
) {
	let starts = 0;
	let reallyExited = false;
	const sent: RecorderOperation[] = [];
	const client = new RequestRecorderClient(home, {
		readyTimeoutMs: options.readyTimeoutMs ?? 2000,
		operationTimeoutMs: options.operationTimeoutMs ?? 2000,
		archiveTimeoutMs: 2000,
		connect: async (_paths, connectionOptions) => {
			starts++;
			const connection = await connectCompiledWorker(
				[
					new URL(
						options.invalidEntry
							? "./request-recorder-absent.fixture.ts"
							: "./request-recorder-lifecycle.fixture.ts",
						import.meta.url,
					).href,
				],
				{
					...connectionOptions,
					workerOptions: { workerData: data },
				},
			);
			void connection.handle.exited.then(() => {
				reallyExited = true;
			});
			const send = connection.worker.postMessage.bind(connection.worker);
			const spy = spyOn(connection.worker, "postMessage").mockImplementation(
				(message, transfer) => {
					if ("op" in message) sent.push(message.op);
					return send(message, transfer);
				},
			);
			spies.push(spy);
			if (!options.exitGate) return connection;
			const handle = new WorkerHandle(
				connection.worker,
				connection.handle.exited.then(async (code) => {
					await options.exitGate;
					return code;
				}),
				() => connection.handle.close(),
			);
			return { ...connection, handle };
		},
	});
	clients.push(client);
	return {
		client,
		state: client as unknown as ClientState,
		sent,
		get starts() {
			return starts;
		},
		get reallyExited() {
			return reallyExited;
		},
	};
}
function forbidMainExecution() {
	const execute = spyOn(RequestRecorderStore.prototype, "execute");
	const archive = spyOn(RequestRecorderStore.prototype, "buildArchive");
	spies.push(execute, archive);
	return () => {
		expect(execute).not.toHaveBeenCalled();
		expect(archive).not.toHaveBeenCalled();
	};
}

describe("请求录制公共 admission 与真实退出", () => {
	test("创建失败和未 ready 均有界失败，没有主线程执行或重放", async () => {
		const assertIsolated = forbidMainExecution();
		for (const options of [{ invalidEntry: true }, { readyTimeoutMs: 30 }]) {
			const run = fixture({ mode: "not-ready" }, options);
			const failure = await run.client.call({ type: "flush" }).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(Error);
			await run.state.retiring;
			expect(run.starts).toBe(1);
			expect(run.state.resources.stats.active).toBe(0);
			expect(run.client.capture(begin("cannot-replay"))).toBe(false);
		}
		assertIsolated();
	});

	test("end ACK 延迟期间所有 128 个录制额度仍被占用", async () => {
		const run = fixture({ endDelay: 100 });
		await run.client.call({ type: "flush" });
		for (let index = 0; index < 128; index++) {
			const requestId = `closing-${index}`;
			expect(run.client.capture(begin(requestId))).toBe(true);
			expect(run.client.capture({ type: "end", requestId })).toBe(true);
		}
		expect(run.state.recordingAdmission.stats.active).toBe(128);
		expect(run.client.capture(begin("over-quota"))).toBe(false);
		await until(() => run.state.recordings.size === 0);
		expect(run.state.recordingAdmission.stats.active).toBe(0);
		await run.client.close();
		expect(run.reallyExited).toBe(true);
	});

	test("运行故障和 capture ACK 超时均等待真实退出后归还额度，期间不重建", async () => {
		const assertIsolated = forbidMainExecution();
		const warnings = spyOn(logger, "warn").mockImplementation(() => {
			throw new Error("logger failed");
		});
		spies.push(warnings);
		for (const mode of ["crash", "stall"]) {
			const exit = deferred();
			releases.push(exit.resolve);
			const run = fixture({ mode }, { exitGate: exit.promise, operationTimeoutMs: 1000 });
			await run.client.call(begin(mode));
			expect(run.client.capture(chunk(mode))).toBe(true);
			await until(() => !!run.state.retiring);
			await until(() => run.reallyExited);
			expect(run.state.resources.stats.active).toBe(1);
			expect(run.state.recordingAdmission.stats.active).toBe(1);
			expect(run.state.inflight.size).toBeGreaterThan(0);
			run.state.retryAt = 0;
			expect(run.client.capture(begin("replacement"))).toBe(false);
			expect(run.starts).toBe(1);
			expect(run.sent.filter((op) => op.type === "chunk")).toHaveLength(1);
			exit.resolve();
			await run.state.retiring;
			expect(run.state.resources.stats.active).toBe(0);
			expect(run.state.recordingAdmission.stats.active).toBe(0);
			expect(run.state.operationTimers.size).toBe(0);
			await expect(run.client.close()).rejects.toBeInstanceOf(Error);
		}
		for (const [, fields] of warnings.mock.calls) {
			expect(fields).toEqual({
				failed: true,
				queued: expect.any(Number),
				inflight: expect.any(Number),
			});
		}
		assertIsolated();
	});

	test("end 没有 ACK 会有界失败，而不是提前归还录制额度", async () => {
		const exit = deferred();
		releases.push(exit.resolve);
		const run = fixture({ endDelay: 5000 }, { exitGate: exit.promise, operationTimeoutMs: 500 });
		await run.client.call(begin("end-timeout"));
		expect(run.client.capture({ type: "end", requestId: "end-timeout" })).toBe(true);
		await until(() => !!run.state.retiring);
		expect(run.state.recordingAdmission.stats.active).toBe(1);
		exit.resolve();
		await run.state.retiring;
		expect(run.state.recordingAdmission.stats.active).toBe(0);
		await expect(run.client.close()).rejects.toMatchObject({ code: "RECORDING_TIMEOUT" });
	});

	test("close 排空独立归档和 end 后才 flush，并等待真实 exit，拒绝新录制/RPC", async () => {
		const exit = deferred();
		releases.push(exit.resolve);
		const run = fixture(
			{ endDelay: 40, archiveDelay: 80, flushDelay: 40 },
			{ exitGate: exit.promise },
		);
		await run.client.call(begin("open-at-close"));
		const archive = run.client.call({ type: "archive", narratorId: "n1", saveId: "save" });
		let closed = false;
		const closing = run.client.close().then(() => {
			closed = true;
		});
		expect(run.client.close()).toBe(run.client.close());
		expect(run.client.capture(begin("late"))).toBe(false);
		await expect(run.client.call({ type: "list", narratorId: "n1" })).rejects.toMatchObject({
			code: "RECORDING_CLOSED",
		});
		await archive;
		await until(() => run.reallyExited);
		expect(run.sent.map((op) => op.type)).toEqual(["begin", "archive", "end", "flush"]);
		expect(closed).toBe(false);
		expect(run.state.resources.stats.active).toBe(1);
		exit.resolve();
		await closing;
		expect(closed).toBe(true);
		expect(run.state.resources.stats.active).toBe(0);
		expect(run.state.calls.stats.active).toBe(0);
	});

	test("pending start 的关闭等待原 worker 排空，迟到 ready 不创建替代者", async () => {
		const run = fixture({ readyDelay: 80 });
		expect(run.client.capture(begin("pending"))).toBe(true);
		const closing = run.client.close();
		expect(run.client.capture(begin("rejected"))).toBe(false);
		await closing;
		expect(run.starts).toBe(1);
		expect(run.reallyExited).toBe(true);
		expect(run.sent.map((op) => op.type)).toEqual(["begin", "end", "flush"]);
	});

	test("真实 store 的生产 close 终结活动 capture 并写出最后 flush", async () => {
		const client = new RequestRecorderClient(home);
		clients.push(client);
		client.configure(configuration);
		await client.call(begin("real-close"));
		expect(client.capture(chunk("real-close"))).toBe(true);
		await client.close();
		const state = client as unknown as ClientState;
		expect(state.resources.stats.active).toBe(0);
		const store = new RequestRecorderStore(home);
		const detail = await store.detail("n1", "real-close");
		expect(detail.status).toBe("aborted");
		expect(detail.responsePreview).toBe("ABC");
	});

	test("ready 前 capture 超时会等待 pending start 的真实退出，不发布迟到 worker", async () => {
		const assertIsolated = forbidMainExecution();
		const run = fixture({ readyDelay: 180 }, { operationTimeoutMs: 50 });
		expect(run.client.capture(begin("startup-timeout"))).toBe(true);
		await until(() => !!run.state.retiring);
		expect(run.state.resources.stats.active).toBe(1);
		expect(run.state.recordingAdmission.stats.active).toBe(1);
		run.state.retryAt = 0;
		expect(run.client.capture(begin("must-not-replace"))).toBe(false);
		await run.state.retiring;
		expect(run.reallyExited).toBe(true);
		expect(run.starts).toBe(1);
		expect(run.sent).toHaveLength(0);
		expect(run.state.resources.stats.active).toBe(0);
		await expect(run.client.close()).rejects.toMatchObject({ code: "RECORDING_TIMEOUT" });
		assertIsolated();
	});

	test("失败启动的 WorkerCleanupError 保留真实 handle 和额度，close 不伪装成功", async () => {
		const assertIsolated = forbidMainExecution();
		const native = WorkerHandle.thread(
			new URL("./request-recorder-lifecycle.fixture.ts", import.meta.url),
			{
				workerData: { mode: "not-ready" },
			},
		);
		releases.push(() => {
			void native.close();
		});
		const retained = new WorkerHandle(native.resource, native.exited, () => {
			throw new Error("Fixture termination was not confirmed");
		});
		let starts = 0;
		const client = new RequestRecorderClient(home, {
			connect: async () => {
				starts++;
				throw new WorkerCleanupError(
					retained as WorkerHandle<unknown>,
					new Error("Fixture startup failed"),
				);
			},
		});
		clients.push(client);
		const state = client as unknown as ClientState;
		const failed = await client.call(begin("retained-start")).catch((error: unknown) => error);
		expect(failed).toBeInstanceOf(WorkerCleanupError);
		await state.retiring?.catch(() => {});
		expect(state.resources.stats.active).toBe(1);
		expect(state.recordingAdmission.stats.active).toBe(1);
		state.retryAt = 0;
		expect(client.capture(begin("cannot-replace"))).toBe(false);
		expect(starts).toBe(1);
		await expect(client.close()).rejects.toBeInstanceOf(Error);
		await native.close();
		assertIsolated();
	});

	test("旧 hotSafe owner 无 handle 所有权证据时 fail closed，不创建替代 worker", async () => {
		const registry = hotSafe(
			"request-recording-clients",
			() => new Map<string, RequestRecorderClient>(),
		);
		const fake = {
			configure() {
				throw new Error("legacy owner must never be invoked");
			},
		};
		registry.set(getNarraforkHome(), fake as unknown as RequestRecorderClient);
		try {
			await expect(saveRequestRecording("n1")).rejects.toMatchObject({
				code: "RECORDING_RESTART_REQUIRED",
			});
		} finally {
			registry.delete(getNarraforkHome());
		}
	});

	test("5 个同步并发下载保持 4 个跨归档/传输租约，第 5 个返回原 429 且不启动归档", async () => {
		const assertIsolated = forbidMainExecution();
		const archivePath = join(home, "fixture.zip");
		await writeFile(archivePath, new Uint8Array([0x50, 0x4b, 3, 4]));
		const run = fixture({ archiveDelay: 30, archive: { path: archivePath, bytes: 4 } });
		const registry = hotSafe(
			"request-recording-clients",
			() => new Map<string, RequestRecorderClient>(),
		);
		registry.set(getNarraforkHome(), run.client);
		const owner = hotSafe("request-recording-runtime-owner.v1", () => ({
			downloads: undefined as unknown as TaskQueue,
		}));
		const downloads = Array.from({ length: 5 }, () => downloadSavedRecording("n1", "fixture-save"));
		const results = await Promise.allSettled(downloads);
		const responses = results.flatMap((result) =>
			result.status === "fulfilled" ? [result.value] : [],
		);
		try {
			expect(responses).toHaveLength(4);
			expect(results[4]).toMatchObject({
				status: "rejected",
				reason: { statusCode: 429, code: "RECORDING_BUSY" },
			});
			expect(run.sent.filter((op) => op.type === "archive")).toHaveLength(4);
			expect(owner.downloads.stats.active).toBe(4);
			await expect(downloadSavedRecording("n1", "fixture-save")).rejects.toMatchObject({
				statusCode: 429,
				code: "RECORDING_BUSY",
			});
			expect(run.sent.filter((op) => op.type === "archive")).toHaveLength(4);
			assertIsolated();
		} finally {
			await Promise.all(responses.map((response) => response.body?.cancel()));
			registry.delete(getNarraforkHome());
		}
		expect(owner.downloads.stats.active).toBe(0);
	});

	test("全体生产 close 等待下载租约且永久禁用新单，没有主线程回算", async () => {
		// Last test deliberately exercises the permanent process-level shutdown latch.
		const registry = hotSafe(
			"request-recording-clients",
			() => new Map<string, RequestRecorderClient>(),
		);
		const run = fixture();
		registry.set(getNarraforkHome(), run.client);
		const owner = hotSafe("request-recording-runtime-owner.v1", () => ({
			downloads: undefined as unknown as TaskQueue,
		}));
		const lease = await owner.downloads.acquire({ deadlineAt: Infinity });
		let closed = false;
		const closing = closeRequestRecorderWorkers().then(() => {
			closed = true;
		});
		await run.client.close();
		expect(closed).toBe(false);
		lease.release();
		await closing;
		const assertIsolated = forbidMainExecution();
		expect(
			createRequestRecording({
				requestId: "disabled",
				narratorId: "n1",
				provider: "fixture",
				model: "fixture",
			}),
		).toBeUndefined();
		await expect(saveRequestRecording("n1")).rejects.toMatchObject({ code: "RECORDING_CLOSED" });
		await expect(downloadSavedRecording("n1", "save")).rejects.toMatchObject({
			code: "RECORDING_CLOSED",
		});
		expect(run.starts).toBe(0);
		assertIsolated();
		registry.delete(getNarraforkHome());
	});
});
