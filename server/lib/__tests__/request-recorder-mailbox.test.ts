import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import type { RecordingSettings, SavedRecording } from "../../../shared/request-recording";
import { DEFAULT_DISK_SAFETY } from "../disk-safety-config";
import { RequestRecorderClient } from "../request-recorder";
import {
	RECORDING_QUEUE_BYTES,
	REQUEST_RECORDING_SAVED_DIR,
	type RecorderOperation,
} from "../request-recorder-protocol";
import { settings } from "../settings";

const configuration: RecordingSettings = {
	ringEnabled: true,
	ringRequestBytes: 1024 * 1024,
	ringResponseBytes: 1024 * 1024,
	autoPin: "off",
};
// Pause only the main-side pump to deterministically fill its mailbox. Every queued operation
// is subsequently handled by the real recorder worker; no worker/store methods are mocked.
interface MailboxState {
	ready: boolean;
	retryAt: number;
	worker?: Worker;
	retiring?: Promise<void>;
	queued: Array<{ id: number; bytes: number; op: RecorderOperation }>;
	queuedBytes: number;
	inflightBytes: number;
	recordings: Map<string, { beginId: number; endId?: number }>;
	waiters: Map<number, unknown>;
	pump(): void;
}
let home: string;
let client: RequestRecorderClient;
let state: MailboxState;
let originalDiskSafety: typeof settings.diskSafety;
const begin = (requestId: string): Extract<RecorderOperation, { type: "begin" }> => ({
	type: "begin",
	identity: { requestId, narratorId: "n1", provider: "fixture", model: "fixture" },
	continuous: false,
	errorsOnly: false,
});
function bounded() {
	expect(state.queuedBytes + state.inflightBytes).toBeLessThanOrEqual(RECORDING_QUEUE_BYTES);
	expect(state.queued.length).toBeLessThanOrEqual(2048);
	expect(state.recordings.size).toBeLessThanOrEqual(128);
	expect(state.queuedBytes).toBe(
		state.queued.reduce((sum, item) => {
			const bytes =
				item.op.type === "chunk"
					? item.op.data.byteLength +
						Buffer.byteLength(JSON.stringify({ ...item.op, data: undefined }))
					: Buffer.byteLength(JSON.stringify(item.op));
			expect(item.bytes).toBe(bytes);
			return sum + bytes;
		}, 0),
	);
}
async function resume() {
	state.ready = true;
	state.pump();
	await client.call({ type: "flush" });
}
async function snapshot() {
	const saved = await client.call<SavedRecording>({ type: "save", narratorId: "n1" });
	const hash = createHash("sha256").update("n1").digest("hex");
	const manifest = JSON.parse(
		await readFile(
			join(home, REQUEST_RECORDING_SAVED_DIR, hash, saved.id, "manifest.json"),
			"utf8",
		),
	) as {
		requests: Array<{
			identity: { requestId: string; apiRequestId?: string };
			status: string;
			gapReasons: string[];
			metadata: Array<{ value: Record<string, unknown> }>;
		}>;
	};
	return { saved, records: manifest.requests };
}
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "recording-mailbox-"));
	originalDiskSafety = settings.diskSafety;
	settings.diskSafety = { ...DEFAULT_DISK_SAFETY, mode: "off" };
	client = new RequestRecorderClient(home);
	state = client as unknown as MailboxState;
	client.configure(configuration);
	await client.call({ type: "flush" });
});
afterEach(async () => {
	await client.close();
	settings.diskSafety = originalDiskSafety;
	await rm(home, { recursive: true, force: true });
});

describe("真实 recorder worker 的有界可靠控制邮箱", () => {
	test("metadata 与 configure 控制 flood 后 bind/gap/finish 仍送达，满载 RPC 立即失败", async () => {
		await client.call(begin("flood"));
		state.ready = false;
		for (let index = 0; index < 3200; index++) {
			client.capture({ type: "meta", requestId: "flood", side: "response", value: { index } });
		}
		bounded();
		for (let index = 0; index < 2400; index++) {
			expect(
				client.capture({
					type: "configure",
					settings: {
						...configuration,
						ringRequestBytes: 1024 * 1024 + index,
					},
				}),
			).toBe(true);
		}
		bounded();
		await expect(client.call({ type: "list", narratorId: "n1" })).rejects.toMatchObject({
			code: "RECORDING_BUSY",
		});
		await expect(client.call(begin("rejected-begin"))).rejects.toMatchObject({
			code: "RECORDING_BUSY",
		});
		expect(state.waiters.size).toBe(0);
		expect(state.recordings.size).toBe(1);
		expect(client.capture({ type: "bind", requestId: "flood", apiRequestId: "api-one" })).toBe(
			true,
		);
		expect(
			client.capture({
				type: "gap",
				requestId: "flood",
				side: "request",
				bytes: 0,
				reason: "fixture missing",
			}),
		).toBe(true);
		expect(client.capture({ type: "end", requestId: "flood" })).toBe(true);
		bounded();
		expect(state.recordings.get("flood")?.endId).toBeDefined();
		await resume();
		expect(state.recordings.size).toBe(0);
		const { saved, records } = await snapshot();
		expect(saved.partial).toBe(false);
		expect(saved.truncated).toBe(true);
		expect(records[0].status).toBe("complete");
		expect(records[0].identity.apiRequestId).toBe("api-one");
		expect(records[0].gapReasons.join(";")).toContain("metadata missing");
		expect(records[0].gapReasons.join(";")).toContain("fixture missing");
	}, 30_000);

	test("4 MiB 包含 metadata、chunk envelope 与缺失控制消息，按字节过载仍可 finish", async () => {
		await client.call(begin("bytes"));
		state.ready = false;
		for (let index = 0; index < 700; index++) {
			client.capture({
				type: "meta",
				requestId: "bytes",
				side: "response",
				value: { index, header: "x".repeat(8192) },
			});
			expect(state.queuedBytes + state.inflightBytes).toBeLessThanOrEqual(RECORDING_QUEUE_BYTES);
		}
		const data = new Uint8Array(65536);
		for (let packet = 0; packet < 80; packet++) {
			client.capture({
				type: "chunk",
				requestId: "bytes",
				side: "response",
				kind: "message",
				data: data.slice(),
				packet,
				offset: 0,
				total: data.length,
				time: "fixture",
			});
		}
		bounded();
		expect(client.capture({ type: "end", requestId: "bytes" })).toBe(true);
		bounded();
		await resume();
		const { saved, records } = await snapshot();
		expect(saved.partial).toBe(false);
		expect(saved.truncated).toBe(true);
		expect(records[0].gapReasons.join(";")).toContain("mailbox overload");
	}, 30_000);

	test("控制 metadata 字节 flood 与 128 条大终结消息共用 4 MiB，终结不会丢失", async () => {
		state.ready = false;
		for (let index = 0; index < 128; index++)
			expect(client.capture(begin(`large-terminal-${index}`))).toBe(true);
		const heavyConfiguration = { ...configuration, padding: "x".repeat(15_000) };
		for (let index = 0; index < 300; index++) {
			expect(client.capture({ type: "configure", settings: heavyConfiguration })).toBe(true);
			bounded();
		}
		for (let index = 0; index < 128; index++) {
			const requestId = `large-terminal-${index}`;
			expect(client.capture({ type: "bind", requestId, apiRequestId: `api-${index}` })).toBe(true);
			client.capture({
				type: "meta",
				requestId,
				side: "response",
				value: { header: "y".repeat(8192) },
			});
			expect(
				client.capture({
					type: "end",
					requestId,
					error: "\u0000".repeat(index === 0 ? 4000 : 2500),
				}),
			).toBe(true);
			bounded();
		}
		expect(state.recordings.size).toBe(128);
		await resume();
		expect(state.recordings.size).toBe(0);
		await client.call(begin("after-large-controls"));
		await client.call({ type: "end", requestId: "after-large-controls" });
		const { saved, records } = await snapshot();
		expect(saved.requestCount).toBe(129);
		expect(saved.partial).toBe(false);
		expect(saved.truncated).toBe(true);
		expect(records.filter((record) => record.status === "error").length).toBe(128);
		expect(
			records
				.find((record) => record.identity.requestId === "large-terminal-0")
				?.gapReasons.join(";"),
		).toContain("terminal metadata truncated");
	}, 30_000);

	test("同步 begin/finish burst 最多 128 closing，只有 end ACK 才释放 admission", async () => {
		for (let round = 0; round < 2; round++) {
			state.ready = false;
			let accepted = 0;
			for (let index = 0; index < 1000; index++) {
				const requestId = `round-${round}-${index}`;
				if (!client.capture(begin(requestId))) continue;
				accepted++;
				expect(client.capture({ type: "end", requestId })).toBe(true);
			}
			expect(accepted).toBe(128);
			expect(state.recordings.size).toBe(128);
			expect([...state.recordings.values()].every((record) => record.endId != null)).toBe(true);
			await expect(client.call(begin("quota-rejected"))).rejects.toMatchObject({
				code: "RECORDING_BUSY",
			});
			expect(state.waiters.size).toBe(0);
			bounded();
			await resume();
			expect(state.recordings.size).toBe(0);
		}
		const { saved, records } = await snapshot();
		expect(saved.requestCount).toBe(256);
		expect(saved.partial).toBe(false);
		expect(records.every((record) => record.status === "complete")).toBe(true);
	}, 30_000);

	test("128 个 worker begin 异步失败会释放配额而非永久耗槽", async () => {
		await client.call({
			type: "configure",
			settings: configuration,
			diskSafety: {
				...DEFAULT_DISK_SAFETY,
				mode: "enforce",
				blockFreeMb: Number.MAX_SAFE_INTEGER,
			},
		});
		const firstFailure = await client.call(begin("rpc-first"), AbortSignal.timeout(2000)).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(firstFailure).toMatchObject({ code: "RECORDING_DISK_PRESSURE" });
		state.ready = false;
		for (let index = 0; index < 128; index++)
			expect(client.capture(begin(`failed-${index}`))).toBe(true);
		expect(client.capture(begin("over-quota"))).toBe(false);
		await resume();
		expect(state.recordings.size).toBe(0);
		// Await the actual reply before asserting: Bun's asynchronous error matcher can starve
		// worker message delivery until a main-thread timer fires.
		const failed = await client.call(begin("rpc-failed"), AbortSignal.timeout(2000)).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failed).toMatchObject({ code: "RECORDING_DISK_PRESSURE" });
		expect(state.recordings.size).toBe(0);
		expect(state.waiters.size).toBe(0);
		await client.call({
			type: "configure",
			settings: configuration,
			diskSafety: { ...DEFAULT_DISK_SAFETY, mode: "off" },
		});
		// The store intentionally caches its disk-safety decision for one second.
		await new Promise((resolve) => setTimeout(resolve, 1100));
		await client.call(begin("working-again"));
		await client.call({ type: "end", requestId: "working-again" });
		expect((await snapshot()).saved.partial).toBe(false);
	}, 30_000);

	test("真实 worker 故障清理 pending RPC/quota，并能在 backoff 后重新录制", async () => {
		await client.call(begin("before-crash"));
		state.ready = false;
		for (let index = 0; index < 127; index++) {
			expect(client.capture(begin(`queued-${index}`))).toBe(true);
			expect(client.capture({ type: "end", requestId: `queued-${index}` })).toBe(true);
		}
		const pending = client.call({ type: "flush" }).then(
			() => undefined,
			(error: unknown) => error,
		);
		const worker = state.worker;
		expect(worker).toBeDefined();
		await worker?.terminate();
		expect(await pending).toBeInstanceOf(Error);
		// Caller failure does not return admission: await the common handle's exit cleanup.
		await state.retiring;
		expect(state.recordings.size).toBe(0);
		expect(state.waiters.size).toBe(0);
		expect(state.queuedBytes + state.inflightBytes).toBe(0);
		await expect(client.call(begin("backoff"))).rejects.toMatchObject({ code: "RECORDING_BUSY" });
		expect(state.waiters.size).toBe(0);
		state.retryAt = 0;
		client.configure(configuration);
		await client.call(begin("after-crash"));
		await client.call({ type: "end", requestId: "after-crash" });
		expect(state.recordings.size).toBe(0);
		expect(
			(await snapshot()).records.find((record) => record.identity.requestId === "after-crash")
				?.status,
		).toBe("complete");
	}, 30_000);

	test("begin RPC 取消不遗留记录，end RPC 取消仍可靠送达终结", async () => {
		state.ready = false;
		const queuedAbort = new AbortController();
		const queued = client.call(begin("cancelled-queued"), queuedAbort.signal);
		queuedAbort.abort();
		await expect(queued).rejects.toMatchObject({ code: "RECORDING_TIMEOUT" });
		expect(state.recordings.size).toBe(0);
		expect(state.waiters.size).toBe(0);
		await resume();

		const postedAbort = new AbortController();
		const posted = client.call(begin("cancelled-posted"), postedAbort.signal);
		postedAbort.abort();
		await expect(posted).rejects.toMatchObject({ code: "RECORDING_TIMEOUT" });
		await client.call({ type: "flush" });
		expect(state.recordings.size).toBe(0);

		await client.call(begin("cancelled-end"));
		state.ready = false;
		const endAbort = new AbortController();
		const ending = client.call({ type: "end", requestId: "cancelled-end" }, endAbort.signal);
		endAbort.abort();
		await expect(ending).rejects.toMatchObject({ code: "RECORDING_TIMEOUT" });
		expect(state.recordings.size).toBe(1);
		expect(state.queued.some((item) => item.op.type === "end")).toBe(true);
		await resume();
		expect(state.recordings.size).toBe(0);
		const { records } = await snapshot();
		expect(records.find((record) => record.identity.requestId === "cancelled-posted")?.status).toBe(
			"aborted",
		);
		expect(records.find((record) => record.identity.requestId === "cancelled-end")?.status).toBe(
			"complete",
		);
	}, 30_000);

	test("正常 metadata/configure 顺序不被 coalescing 无故覆盖，序列化错误不会挂 waiter", async () => {
		await client.call(begin("ordered"));
		state.ready = false;
		for (let index = 0; index < 10; index++) {
			client.capture({ type: "meta", requestId: "ordered", side: "response", value: { index } });
			client.capture({
				type: "configure",
				settings: { ...configuration, ringRequestBytes: 1000 + index },
			});
		}
		expect(state.queued.filter((item) => item.op.type === "configure").length).toBe(10);
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		await expect(
			client.call({ type: "meta", requestId: "ordered", side: "request", value: circular }),
		).rejects.toThrow();
		expect(state.waiters.size).toBe(0);
		expect(
			client.capture({ type: "meta", requestId: "ordered", side: "request", value: circular }),
		).toBe(false);
		expect(client.capture({ type: "end", requestId: "ordered" })).toBe(true);
		await resume();
		const { saved, records } = await snapshot();
		expect(records[0].metadata.map((meta) => meta.value.index)).toEqual(
			Array.from({ length: 10 }, (_, index) => index),
		);
		expect(saved.truncated).toBe(true);
		expect(saved.partial).toBe(false);
	});
});
