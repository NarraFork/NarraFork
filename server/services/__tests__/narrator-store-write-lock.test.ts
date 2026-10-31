/**
 * 存储写事务必须等得住别的连接短暂持锁。
 *
 * 线上原错误是「Tool result could not be persisted: database is locked」：事务以 `syncQueueMark()`
 * 的 SELECT 开头，deferred 事务已经是读者，升级写锁时 SQLite 不调用 busy handler，直接报
 * locked。这里用真实库文件、真实 `settleTool` 复现同一形态：另一条连接在主连接即将写入时
 * 持住写锁，落库必须等它释放后才成功，而不是立刻失败。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Worker } from "node:worker_threads";

const { sqlite } = await import("../../db");
const { closePrefixSnapshotStore } = await import("../narrator-prefix-snapshots");
// narrator-service 必须先于 narrator-persistence 加载（既有循环依赖）。
await import("../narrator-service");
const { narratorStore } = await import("../narrator-store");

const BUSY_TIMEOUT_MS =
	(sqlite.prepare("PRAGMA busy_timeout").get() as { timeout: number } | null)?.timeout ?? 250;

/** 持锁时长短于一次 busy_timeout：等待中的写必须在锁释放后拿下，不能立刻失败。 */
const HOLD_MS = Math.max(50, Math.round(BUSY_TIMEOUT_MS * 0.4));

/**
 * 另一条连接持有写锁，并在主连接发出写入信号后 `holdMs` 才提交。连接在 worker 线程里，
 * 主线程的同步忙等才不会把持锁方一起卡住。
 */
const HOLD_LOCK = `
const { Database } = require("bun:sqlite");
const { parentPort, workerData } = require("node:worker_threads");
const gate = new Int32Array(workerData.gate);
const db = new Database(workerData.path);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
db.run("BEGIN IMMEDIATE");
parentPort.postMessage("locked");
Atomics.wait(gate, 0, 0, 5000);
sleep(workerData.holdMs);
db.run("COMMIT");
db.close();
parentPort.postMessage("released");
`;

async function withLockHeldWhileWriting(run: () => unknown): Promise<unknown> {
	const gate = new SharedArrayBuffer(4);
	const worker = new Worker(HOLD_LOCK, {
		eval: true,
		workerData: { path: sqlite.filename, gate, holdMs: HOLD_MS },
	});
	const waitFor = (expected: string) =>
		new Promise<void>((resolve, reject) => {
			worker.on("message", (message) => {
				if (message === expected) resolve();
			});
			worker.once("error", reject);
		});
	const released = waitFor("released");
	await waitFor("locked");
	try {
		Atomics.store(new Int32Array(gate), 0, 1);
		Atomics.notify(new Int32Array(gate), 0);
		return await run();
	} finally {
		await released;
		await worker.terminate();
	}
}

afterAll(async () => {
	await closePrefixSnapshotStore();
	sqlite.close();
});

describe("store writes under another connection's write lock", () => {
	test("tool_result 落库等到写锁释放后成功", async () => {
		const now = new Date().toISOString();
		sqlite.run("INSERT INTO narrators (id, created_at, updated_at) VALUES ('n-lock', ?, ?)", [
			now,
			now,
		]);
		const step = await narratorStore.openStep("n-lock", { uuid: "u-lock", session_id: "s-lock" });
		const toolCallId = await narratorStore.writeStepItem(step.id, "n-lock", {
			type: "tool_use",
			id: "call-lock",
			name: "Bash",
			input: { command: "ls" },
		});
		if (!toolCallId) throw new Error("tool call row was not written");

		await withLockHeldWhileWriting(() =>
			narratorStore.settleTool(
				"call-lock",
				{ output: "ok", status: "success" },
				step.id,
				toolCallId,
			),
		);

		const row = sqlite
			.prepare("SELECT status FROM narrator_tool_calls WHERE id = ?")
			.get(toolCallId) as { status: string } | null;
		expect(row?.status).toBe("success");
	});
});
