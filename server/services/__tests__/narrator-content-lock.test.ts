import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { cleanDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";
import type { AgentConfig, AgentEvent, ToolCallBinding } from "../../lib/agent/types";
import type { EventHandlerContext } from "../narrator-event-handler";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
const { db, sqlite } = fixture;
await fixture.ready;
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const realCharacters = { ...(await import("../../lib/context-characters")) };
let onRefresh: (() => void) | undefined;
const refreshes: string[] = [];
mock.module("../../lib/context-characters", () => ({
	...realCharacters,
	queueContextCharacterRefresh: (_narratorId: string, messageId?: string) => {
		onRefresh?.();
		refreshes.push(messageId ?? "");
	},
	hasPendingContextCharacterRefresh: () => false,
}));
const realWs = { ...(await import("../../websocket/narrator-ws")) };
const publications: unknown[] = [];
let onPublication: (() => void) | undefined;
mock.module("../../websocket/narrator-ws", () => ({
	...realWs,
	broadcastToNarrator: (_narratorId: string, message: { type: string }) => {
		if (message.type !== "message_updated") return;
		onPublication?.();
		publications.push(message);
	},
}));
const realWorkerRead = { ...(await import("../../db/worker-read")) };
let onRead: (() => void) | undefined;
mock.module("../../db/worker-read", () => ({
	...realWorkerRead,
	readQuery: (...args: Parameters<typeof realWorkerRead.readQuery>) => {
		onRead?.();
		return realWorkerRead.readQuery(...args);
	},
}));
await import("../narrator-service");
const { narratorPersistence } = await import("../narrator-persistence");
const { flushChangedEnvelopes, stopBlockSyncSweep } = await import("../narrator-block-sync");
const { stopBlockIndex } = await import("../narrator-block-index");
const { logger } = await import("../../lib/logger");
const {
	clearStreamingSnapshot,
	getStreamingSnapshot,
	processEvent,
	CriticalEventPersistenceError,
} = await import("../narrator-event-handler");
const { executeAgentLoop } = await import("../narrator-executor");
const diagnostics: Array<{ level: string; data: Record<string, unknown> }> = [];
const blocks = [
	{ type: "text", id: "text", revision: 1, text: "private assistant text" },
	{ type: "reasoning", id: "reasoning", revision: 1, text: "private reasoning" },
	{ type: "tool_use", id: "provider-tool", name: "Bash", input: { command: "private input" } },
] as const;

/** Only this test file's WAL database is opened by the lock owner. */
async function holdWriterLock(deferred = false) {
	const signal = new Int32Array(new SharedArrayBuffer(8));
	if (!deferred) Atomics.store(signal, 0, 1);
	const worker = new Worker(
		`const { Database } = require("bun:sqlite");
		const { parentPort, workerData } = require("node:worker_threads");
		const signal = new Int32Array(workerData.signal);
		const sqlite = new Database(workerData.path, { readwrite: true, create: false });
		try {
			if (workerData.deferred) {
				parentPort.postMessage("ready");
				if (Atomics.wait(signal, 0, 0, 4000) === "timed-out") throw new Error("Lock acquisition timed out");
			}
			sqlite.exec("BEGIN IMMEDIATE");
			Atomics.store(signal, 1, 1);
			Atomics.notify(signal, 1);
			if (!workerData.deferred) parentPort.postMessage("locked");
			if (Atomics.wait(signal, 0, 1, 4000) === "timed-out") throw new Error("Lock release timed out");
			sqlite.exec("COMMIT");
			Atomics.store(signal, 1, 2);
			Atomics.notify(signal, 1);
		} finally { sqlite.close(); }
		parentPort.close();`,
		{ eval: true, workerData: { path: sqlite.filename, signal: signal.buffer, deferred } },
	);
	const exited = once(worker, "exit");
	try {
		expect(await once(worker, "message", { signal: AbortSignal.timeout(3000) })).toEqual([
			deferred ? "ready" : "locked",
		]);
	} catch (error) {
		await worker.terminate();
		await exited;
		throw error;
	}
	const release = () => {
		Atomics.store(signal, 0, 2);
		Atomics.notify(signal, 0);
	};
	return {
		release,
		acquire() {
			Atomics.store(signal, 0, 1);
			Atomics.notify(signal, 0);
			if (Atomics.load(signal, 1) === 0) Atomics.wait(signal, 1, 0, 2000);
			expect(Atomics.load(signal, 1)).toBe(1);
		},
		async close() {
			release();
			expect(await exited).toEqual([0]);
			expect(Atomics.load(signal, 1)).toBe(2);
		},
	};
}

async function createPartial() {
	sqlite
		.prepare("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)")
		.run("n", "2026-11-02T00:00:00Z", "2026-11-02T00:00:00Z");
	const partial = await narratorPersistence.createPartialAssistantMessage("n", {
		uuid: crypto.randomUUID(),
		session_id: "s",
	});
	// Opening the shell has its own successful context notification, outside this boundary.
	expect(refreshes).toEqual([partial.id]);
	refreshes.length = 0;
	return partial;
}

function stored(messageId: string): unknown[] {
	const row = sqlite
		.prepare("SELECT content_json AS content FROM narrator_messages WHERE id = ?")
		.get(messageId) as { content: string };
	return JSON.parse(row.content);
}

function context(messageId: string): EventHandlerContext {
	return {
		narratorId: "n",
		broadcastTargetId: "n",
		conversationId: "s",
		locale: "en",
		getContextUsagePct: () => undefined,
		getMeterUsage: () => undefined,
		getMeterUnit: () => undefined,
		getTokenUsage: () => undefined,
		getPartialMessageId: () => messageId,
		setPartialMessageId: () => {},
		setContextUsagePct: () => {},
		setMeterData: () => {},
		setTokenUsage: () => {},
	};
}

async function rejected(work: Promise<unknown>): Promise<unknown> {
	try {
		await work;
	} catch (error) {
		return error;
	}
	throw new Error("Expected a persistence failure");
}

function stateRows() {
	return {
		blocks: sqlite.prepare("SELECT * FROM narrator_blocks ORDER BY id").all(),
		ledger: sqlite.prepare("SELECT * FROM narrator_tool_calls ORDER BY id").all(),
		segments: sqlite.prepare("SELECT * FROM file_change_execution_segments ORDER BY id").all(),
		sync: sqlite.prepare("SELECT * FROM narrator_block_sync_queue ORDER BY message_id").all(),
		index: sqlite.prepare("SELECT * FROM narrator_block_index_queue ORDER BY block_id").all(),
	};
}

beforeEach(() => {
	cleanDb(sqlite);
	refreshes.length = 0;
	publications.length = 0;
	onRefresh = undefined;
	onPublication = undefined;
	onRead = undefined;
	diagnostics.length = 0;
	for (const level of ["warn", "error"] as const)
		spyOn(logger, level).mockImplementation((message, data) => {
			if (message === "Assistant content persistence failed")
				diagnostics.push({ level, data: { ...data } });
		});
});
afterEach(() => {
	onRefresh = undefined;
	onPublication = undefined;
	onRead = undefined;
	clearStreamingSnapshot("n");
	mock.restore();
	flushChangedEnvelopes();
	stopBlockIndex();
	for (const { data } of diagnostics) {
		expect(Object.keys(data).sort()).toEqual([
			"attempt",
			"code",
			"committed",
			"errno",
			"operation",
			"phase",
		]);
		expect(JSON.stringify(data)).not.toContain("private");
		expect(JSON.stringify(data)).not.toContain("SELECT");
	}
});
afterAll(async () => {
	stopBlockSyncSweep();
	mock.module("../../db", () => realDb);
	mock.module("../../lib/context-characters", () => realCharacters);
	mock.module("../../websocket/narrator-ws", () => realWs);
	mock.module("../../db/worker-read", () => realWorkerRead);
	await fixture.close();
});

describe("assistant content write locks", () => {
	for (const block of blocks) {
		test(`${block.type} recovers from a real short writer lock before publishing its committed receipt`, async () => {
			const partial = await createPartial();
			const lock = await holdWriterLock();
			const transaction = db.transaction.bind(db);
			let attempts = 0;
			let observedLock: unknown;
			const transactionSpy = spyOn(db, "transaction").mockImplementation((write, config) => {
				attempts++;
				try {
					return transaction(write, config);
				} catch (error) {
					observedLock = error;
					// The independent owner releases even while SQLite blocks the calling thread.
					lock.release();
					throw error;
				}
			});
			onRefresh = () => {
				expect(sqlite.inTransaction).toBe(false);
				expect(stored(partial.id)).toMatchObject([block]);
			};
			let receipt: string | undefined;
			let failure: unknown;
			try {
				receipt = await narratorPersistence.appendBlockToMessage(partial.id, "n", block);
			} catch (error) {
				failure = error;
			} finally {
				transactionSpy.mockRestore();
				await lock.close();
			}
			expect(observedLock).toMatchObject({ code: "SQLITE_BUSY" });
			expect(failure).toBeUndefined();
			expect(attempts).toBe(2);
			expect(stored(partial.id)).toMatchObject([block]);
			expect(refreshes).toEqual([partial.id]);
			expect(publications).toHaveLength(1);
			const calls = sqlite
				.prepare("SELECT id, execution_segment_id AS segment FROM narrator_tool_calls")
				.all() as { id: string; segment: string }[];
			expect(calls).toHaveLength(block.type === "tool_use" ? 1 : 0);
			if (block.type === "tool_use") {
				expect(receipt).toBe(calls[0].id);
				expect(
					sqlite
						.prepare("SELECT source_tool_call_id AS id FROM file_change_execution_segments")
						.all(),
				).toEqual([{ id: receipt }]);
			} else expect(receipt).toBeUndefined();
			expect(diagnostics).toMatchObject([
				{
					level: "warn",
					data: {
						operation: "appendBlockToMessage",
						phase: "transaction",
						attempt: 1,
						committed: false,
						code: "SQLITE_BUSY",
						errno: 5,
					},
				},
			]);
		});
	}
});

describe("assistant content barriers under writer contention", () => {
	for (const block of blocks) {
		test(`${block.type} exhausts three real lock attempts without advancing the tool generator`, async () => {
			const partial = await createPartial();
			const ctx = context(partial.id);
			const before = stateRows();
			const lock = await holdWriterLock();
			const transaction = db.transaction.bind(db);
			let lastDriverError: unknown;
			const starts: number[] = [];
			const transactionSpy = spyOn(db, "transaction").mockImplementation((write, config) => {
				starts.push(performance.now());
				expect(config?.behavior).toBe("immediate");
				try {
					return transaction(write, config);
				} catch (error) {
					lastDriverError = error;
					throw error;
				}
			});
			let executed = 0;
			let receipts = 0;
			let closed = false;
			async function* source(): AsyncGenerator<AgentEvent> {
				try {
					if (block.type === "tool_use") {
						yield {
							type: "tool_use_chunk",
							toolUseId: block.id,
							toolName: block.name,
							inputCharsTotal: 10,
						};
						yield {
							type: "block_complete",
							block: {
								type: "tool_use",
								toolUseId: block.id,
								name: block.name,
								input: block.input,
							},
							onToolPersisted: () => {
								receipts++;
							},
						};
					} else {
						yield {
							type: block.type === "text" ? "stream_text" : "stream_reasoning",
							blockId: block.id,
							blockRevision: 1,
							blockTextOffset: 0,
							text: block.text,
						};
						yield { type: "block_complete", block };
					}
					executed++;
					yield { type: "tool_call", toolUseId: "forbidden", toolName: "Bash", input: {} };
				} finally {
					closed = true;
				}
			}
			const config: AgentConfig = {
				narratorId: "n",
				conversationId: "s",
				model: "test",
				provider: "test",
				cwd: "/repo",
				signal: new AbortController().signal,
				permissionHandler: async () => ({ behavior: "allow" }),
			};
			let error: unknown;
			try {
				error = await rejected(
					executeAgentLoop(
						{ config, userText: "", history: { rows: [] }, eventContext: ctx },
						{ eventSource: source() },
					),
				);
			} finally {
				transactionSpy.mockRestore();
				await lock.close();
			}
			expect(error).toBeInstanceOf(CriticalEventPersistenceError);
			expect((error as Error).cause).toBe(lastDriverError);
			expect(lastDriverError).toMatchObject({ code: "SQLITE_BUSY", errno: 5 });
			expect(starts).toHaveLength(3);
			expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(200);
			expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(400);
			expect(executed).toBe(0);
			expect(receipts).toBe(0);
			expect(closed).toBe(true);
			expect(stored(partial.id)).toEqual([]);
			expect(stateRows()).toEqual(before);
			expect(refreshes).toEqual([]);
			expect(publications).toEqual([]);
			const snapshot = getStreamingSnapshot("n");
			if (block.type === "tool_use")
				expect(snapshot?.toolChunks.get(block.id)).toMatchObject({ toolUseId: block.id });
			else expect(snapshot?.streamingBlocks).toMatchObject([block]);
			expect(
				diagnostics.map(({ level, data }) => [level, data.phase, data.attempt, data.committed]),
			).toEqual([
				["warn", "transaction", 1, false],
				["warn", "transaction", 2, false],
				["error", "transaction", 3, false],
			]);
		});
	}

	test("tool execution receipt is released only after the recovered transaction and publication", async () => {
		const partial = await createPartial();
		const ctx = context(partial.id);
		const lock = await holdWriterLock();
		const transaction = db.transaction.bind(db);
		let executed = 0;
		let receipt: ToolCallBinding | undefined;
		const transactionSpy = spyOn(db, "transaction").mockImplementation((write, config) => {
			expect(executed).toBe(0);
			expect(receipt).toBeUndefined();
			try {
				return transaction(write, config);
			} catch (error) {
				lock.release();
				throw error;
			}
		});
		onRefresh = onPublication = () => {
			expect(executed).toBe(0);
			expect(receipt).toBeUndefined();
		};
		async function* source(): AsyncGenerator<AgentEvent> {
			yield {
				type: "block_complete",
				block: { type: "tool_use", toolUseId: "authorized", name: "Bash", input: {} },
				onToolPersisted: (binding) => {
					expect(publications).toHaveLength(1);
					receipt = binding;
				},
			};
			expect(receipt?.toolCallId).toBeTruthy();
			executed++;
		}
		const config: AgentConfig = {
			narratorId: "n",
			conversationId: "s",
			model: "test",
			provider: "test",
			cwd: "/repo",
			signal: new AbortController().signal,
			permissionHandler: async () => ({ behavior: "allow" }),
		};
		try {
			await executeAgentLoop(
				{ config, userText: "", history: { rows: [] }, eventContext: ctx },
				{ eventSource: source() },
			);
		} finally {
			transactionSpy.mockRestore();
			await lock.close();
		}
		expect(executed).toBe(1);
		expect(ctx.toolExecutionReceipts?.get("authorized")?.binding).toEqual(receipt);
		expect(sqlite.prepare("SELECT id FROM narrator_tool_calls").all()).toEqual([
			{ id: receipt?.toolCallId },
		]);
	});
});

describe("assistant content rollback and publication boundaries", () => {
	test("a rolled-back tool attempt discards its receipt and rereads the concurrent body", async () => {
		const partial = await createPartial();
		const before = stateRows();
		const transaction = db.transaction.bind(db);
		const lockError = Object.assign(new Error("private query SELECT with private input"), {
			cause: { code: "SQLITE_BUSY_SNAPSHOT", errno: 517 },
		});
		let attempts = 0;
		let rolledBackId: string | undefined;
		const concurrent = { type: "text", id: "concurrent", revision: 1, text: "concurrent writer" };
		const transactionSpy = spyOn(db, "transaction").mockImplementation((write, config) => {
			attempts++;
			try {
				return transaction((tx) => {
					const result = write(tx);
					if (attempts === 1) {
						rolledBackId = (
							sqlite.prepare("SELECT id FROM narrator_tool_calls").get() as { id: string }
						).id;
						expect(stored(partial.id)).toHaveLength(1);
						throw lockError;
					}
					return result;
				}, config);
			} catch (error) {
				expect(stateRows()).toEqual(before);
				expect(stored(partial.id)).toEqual([]);
				expect(refreshes).toEqual([]);
				sqlite
					.prepare("UPDATE narrator_messages SET content_json = ? WHERE id = ?")
					.run(JSON.stringify([concurrent]), partial.id);
				throw error;
			}
		});
		let receipt: string | undefined;
		try {
			receipt = await narratorPersistence.appendBlockToMessage(partial.id, "n", blocks[2]);
		} finally {
			transactionSpy.mockRestore();
		}
		expect(attempts).toBe(2);
		expect(rolledBackId).toBeTruthy();
		expect(receipt).not.toBe(rolledBackId);
		expect(stored(partial.id)).toMatchObject([concurrent, blocks[2]]);
		expect(sqlite.prepare("SELECT id FROM narrator_tool_calls").all()).toEqual([{ id: receipt }]);
		expect(
			sqlite.prepare("SELECT source_tool_call_id AS id FROM file_change_execution_segments").all(),
		).toEqual([{ id: receipt }]);
		expect(sqlite.prepare("SELECT * FROM narrator_block_sync_queue").all()).toEqual([]);
		expect(refreshes).toEqual([partial.id]);
		expect(publications).toHaveLength(1);
		expect(diagnostics).toMatchObject([
			{
				data: {
					phase: "transaction",
					attempt: 1,
					code: "SQLITE_BUSY_SNAPSHOT",
					errno: 517,
					committed: false,
				},
			},
		]);
	});

	test("a real postcommit version lock retries only its SQL and not the ledger or notification", async () => {
		const partial = await createPartial();
		const lock = await holdWriterLock(true);
		const transactionSpy = spyOn(db, "transaction");
		const update = db.update.bind(db);
		let versionAttempts = 0;
		const updateSpy = spyOn(db, "update").mockImplementation((table) => {
			if (Object.is(table, narrators)) {
				versionAttempts++;
				if (versionAttempts === 2) lock.release();
			}
			return update(table);
		});
		onRefresh = () => {
			expect(sqlite.inTransaction).toBe(false);
			expect(stored(partial.id)).toMatchObject([blocks[2]]);
			lock.acquire();
		};
		let receipt: string | undefined;
		try {
			receipt = await narratorPersistence.appendBlockToMessage(partial.id, "n", blocks[2]);
		} finally {
			updateSpy.mockRestore();
			await lock.close();
		}
		expect(transactionSpy).toHaveBeenCalledTimes(1);
		expect(versionAttempts).toBe(2);
		expect(refreshes).toEqual([partial.id]);
		expect(publications).toHaveLength(1);
		expect(sqlite.prepare("SELECT id FROM narrator_tool_calls").all()).toEqual([{ id: receipt }]);
		expect(
			sqlite.prepare("SELECT source_tool_call_id AS id FROM file_change_execution_segments").all(),
		).toEqual([{ id: receipt }]);
		expect(
			sqlite.prepare("SELECT message_version AS v FROM narrators WHERE id = 'n'").get(),
		).toEqual({ v: 1 });
		expect(diagnostics).toMatchObject([
			{
				level: "warn",
				data: { phase: "version-write", attempt: 1, code: "SQLITE_BUSY", committed: true },
			},
		]);
	});

	test("version retry exhaustion preserves the committed content and original failure", async () => {
		const partial = await createPartial();
		const failure = Object.assign(new Error("private version SELECT"), {
			code: "SQLITE_LOCKED_SHAREDCACHE",
			errno: 262,
		});
		const transactionSpy = spyOn(db, "transaction");
		const update = db.update.bind(db);
		let versions = 0;
		spyOn(db, "update").mockImplementation((table) => {
			if (Object.is(table, narrators)) {
				versions++;
				throw failure;
			}
			return update(table);
		});
		expect(
			await rejected(narratorPersistence.appendBlockToMessage(partial.id, "n", blocks[2])),
		).toBe(failure);
		expect(transactionSpy).toHaveBeenCalledTimes(1);
		expect(versions).toBe(3);
		expect(stored(partial.id)).toMatchObject([blocks[2]]);
		expect(stateRows().ledger).toHaveLength(1);
		expect(stateRows().segments).toHaveLength(1);
		expect(refreshes).toEqual([partial.id]);
		expect(publications).toEqual([]);
		expect(diagnostics.map(({ data }) => [data.phase, data.attempt, data.committed])).toEqual([
			["version-write", 1, true],
			["version-write", 2, true],
			["version-write", 3, true],
		]);
	});

	for (const phase of ["notification", "broadcast"] as const) {
		test(`${phase} lock-shaped callback failure is propagated without replaying committed work`, async () => {
			const partial = await createPartial();
			const failure = Object.assign(new Error("database is locked: private callback SELECT"), {
				code: "SQLITE_BUSY",
				errno: 5,
			});
			let calls = 0;
			const fail = () => {
				calls++;
				throw failure;
			};
			if (phase === "notification") onRefresh = fail;
			else onPublication = fail;
			const transactionSpy = spyOn(db, "transaction");
			expect(
				await rejected(narratorPersistence.appendBlockToMessage(partial.id, "n", blocks[2])),
			).toBe(failure);
			expect(calls).toBe(1);
			expect(transactionSpy).toHaveBeenCalledTimes(1);
			expect(stored(partial.id)).toMatchObject([blocks[2]]);
			expect(stateRows().ledger).toHaveLength(1);
			expect(stateRows().segments).toHaveLength(1);
			expect(publications).toEqual([]);
			expect(diagnostics).toMatchObject([
				{
					level: "error",
					data: { phase, attempt: 1, committed: true, code: "SQLITE_BUSY", errno: 5 },
				},
			]);
		});
	}

	test("a nested busy cause from a worker read is not retried or republished", async () => {
		const partial = await createPartial();
		const failure = Object.assign(new Error("private worker SELECT"), {
			code: "DB_READ_FAILED",
			cause: { code: "SQLITE_BUSY", errno: 5 },
		});
		let reads = 0;
		onRead = () => {
			reads++;
			throw failure;
		};
		const transactionSpy = spyOn(db, "transaction");
		expect(
			await rejected(narratorPersistence.appendBlockToMessage(partial.id, "n", blocks[0])),
		).toBe(failure);
		expect(reads).toBe(1);
		expect(transactionSpy).toHaveBeenCalledTimes(1);
		expect(stored(partial.id)).toMatchObject([blocks[0]]);
		expect(refreshes).toEqual([partial.id]);
		expect(publications).toEqual([]);
		expect(
			sqlite.prepare("SELECT message_version AS v FROM narrators WHERE id = 'n'").get(),
		).toEqual({ v: 1 });
		expect(diagnostics).toMatchObject([
			{ data: { phase: "publication-read", attempt: 1, committed: true } },
		]);
	});

	test("an observer failure resumes the same checkpoint notification without duplicating its block or ledger", async () => {
		const partial = await createPartial();
		const ctx = context(partial.id);
		await processEvent(
			{
				type: "block_complete",
				block: { type: "tool_use", toolUseId: "prior-tool", name: "Bash", input: {} },
			},
			ctx,
		);
		const priorReceipt = ctx.toolExecutionReceipts?.get("prior-tool");
		refreshes.length = 0;
		publications.length = 0;
		await processEvent(
			{
				type: "stream_text",
				blockId: blocks[0].id,
				blockRevision: 1,
				blockTextOffset: 0,
				text: blocks[0].text,
			},
			ctx,
		);
		const failure = new Error("private observer failed before queue registration");
		let calls = 0;
		onRefresh = () => {
			if (++calls === 1) throw failure;
		};
		const checkpoint = { type: "block_complete", block: blocks[0] } as const;
		expect(await rejected(processEvent(checkpoint, ctx))).toBe(failure);
		expect(refreshes).toEqual([]);
		expect(getStreamingSnapshot("n")?.streamingBlocks).toMatchObject([blocks[0]]);
		await processEvent(checkpoint, ctx);
		await processEvent(checkpoint, ctx);
		expect(calls).toBe(2);
		expect(refreshes).toEqual([partial.id]);
		expect(publications).toHaveLength(1);
		expect(stored(partial.id)).toMatchObject([{ type: "tool_use", id: "prior-tool" }, blocks[0]]);
		expect(sqlite.prepare("SELECT id FROM narrator_tool_calls").all()).toEqual([
			{ id: priorReceipt?.binding.toolCallId },
		]);
		expect(stateRows().segments).toHaveLength(1);
		expect(ctx.toolExecutionReceipts?.get("prior-tool")).toEqual(priorReceipt);
		expect(getStreamingSnapshot("n")?.streamingBlocks).toEqual([]);
	});

	test("a publication retry retains an already successful context notification", async () => {
		const partial = await createPartial();
		const ctx = context(partial.id);
		const failure = new Error("private publication unavailable");
		onPublication = () => {
			throw failure;
		};
		const checkpoint = { type: "block_complete", block: blocks[0] } as const;
		expect(await rejected(processEvent(checkpoint, ctx))).toBe(failure);
		expect(refreshes).toEqual([partial.id]);
		onPublication = undefined;
		await processEvent(checkpoint, ctx);
		expect(refreshes).toEqual([partial.id]);
		expect(publications).toHaveLength(1);
		expect(stored(partial.id)).toMatchObject([blocks[0]]);
	});

	test("an unchanged republish does not notify content observers twice", async () => {
		const partial = await createPartial();
		await narratorPersistence.appendBlockToMessage(partial.id, "n", blocks[0]);
		await narratorPersistence.appendBlockToMessage(partial.id, "n", blocks[0], {
			republishUnchanged: true,
		});
		expect(refreshes).toEqual([partial.id]);
		expect(publications).toHaveLength(2);
		expect(stored(partial.id)).toMatchObject([blocks[0]]);
	});
});

describe("assistant content lock classification and diagnostics", () => {
	for (const [name, failure] of [
		[
			"nested driver code",
			new Error("private outer SELECT", {
				cause: { code: "SQLITE_LOCKED_SHAREDCACHE", errno: 262 },
			}),
		],
		["extended numeric errno", Object.assign(new Error("private payload"), { errno: 773 })],
		["nested extended numeric errno", new Error("private outer", { cause: { errno: 517 } })],
		["exact legacy lock message", new Error("database table is locked")],
	] as const) {
		test(`retries ${name} without exposing the original error payload`, async () => {
			const partial = await createPartial();
			const transaction = db.transaction.bind(db);
			let attempts = 0;
			spyOn(db, "transaction").mockImplementation((write, config) => {
				attempts++;
				if (attempts === 1) throw failure;
				return transaction(write, config);
			});
			await narratorPersistence.appendBlockToMessage(partial.id, "n", blocks[0]);
			expect(attempts).toBe(2);
			expect(stored(partial.id)).toMatchObject([blocks[0]]);
			expect(diagnostics).toMatchObject([
				{ level: "warn", data: { phase: "transaction", attempt: 1, committed: false } },
			]);
		});
	}

	for (const [name, failure] of [
		[
			"non-lock driver code",
			Object.assign(new Error("database is locked"), {
				code: "SQLITE_CONSTRAINT_UNIQUE",
				errno: 2067,
			}),
		],
		["non-lock numeric errno", Object.assign(new Error("database is locked"), { errno: 19 })],
		["arbitrary locked text", new Error("private observer says database is locked")],
	] as const) {
		test(`does not retry ${name} and retains the original exception`, async () => {
			const partial = await createPartial();
			const before = stateRows();
			const transactionSpy = spyOn(db, "transaction").mockImplementation(() => {
				throw failure;
			});
			expect(
				await rejected(narratorPersistence.appendBlockToMessage(partial.id, "n", blocks[0])),
			).toBe(failure);
			expect(transactionSpy).toHaveBeenCalledTimes(1);
			expect(stateRows()).toEqual(before);
			expect(stored(partial.id)).toEqual([]);
			expect(refreshes).toEqual([]);
			expect(publications).toEqual([]);
			expect(diagnostics).toMatchObject([
				{ level: "error", data: { phase: "transaction", attempt: 1, committed: false } },
			]);
		});
	}

	test("a real constraint abort rolls back once without retrying its locked-looking message", async () => {
		const partial = await createPartial();
		const before = stateRows();
		sqlite.run(
			"CREATE TEMP TRIGGER fail_content_constraint BEFORE UPDATE OF content_json ON narrator_messages BEGIN SELECT RAISE(ABORT, 'database is locked'); END",
		);
		const transactionSpy = spyOn(db, "transaction");
		let failure: unknown;
		try {
			failure = await rejected(
				narratorPersistence.appendBlockToMessage(partial.id, "n", blocks[2]),
			);
		} finally {
			sqlite.run("DROP TRIGGER fail_content_constraint");
		}
		expect(failure).toMatchObject({ code: "SQLITE_CONSTRAINT_TRIGGER", errno: 1811 });
		expect(transactionSpy).toHaveBeenCalledTimes(1);
		expect(stateRows()).toEqual(before);
		expect(stored(partial.id)).toEqual([]);
		expect(refreshes).toEqual([]);
		expect(publications).toEqual([]);
		expect(diagnostics).toMatchObject([
			{
				data: {
					phase: "transaction",
					attempt: 1,
					code: "SQLITE_CONSTRAINT_TRIGGER",
					errno: 1811,
					committed: false,
				},
			},
		]);
	});

	for (const phase of ["notification", "broadcast"] as const) {
		for (const errno of [999_999_999, -1, 5.25, Number.POSITIVE_INFINITY]) {
			test(`${phase} diagnostics redact callback-supplied codes and invalid errno ${errno}`, async () => {
				const partial = await createPartial();
				const failure = Object.assign(new Error("private callback SELECT"), {
					code: "PRIVATE_TOKEN_ABC",
					errno,
					cause: { code: "SQLITE_PRIVATE_TOKEN_ABC", errno },
				});
				const fail = () => {
					throw failure;
				};
				if (phase === "notification") onRefresh = fail;
				else onPublication = fail;
				expect(
					await rejected(narratorPersistence.appendBlockToMessage(partial.id, "n", blocks[0])),
				).toBe(failure);
				expect(diagnostics).toEqual([
					{
						level: "error",
						data: {
							operation: "appendBlockToMessage",
							phase,
							attempt: 1,
							committed: true,
							code: null,
							errno: null,
						},
					},
				]);
				expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_TOKEN_ABC");
			});
		}
	}

	test("a diagnostic sink failure cannot replace the original structured cause", async () => {
		const partial = await createPartial();
		const cause = { code: "SQLITE_CONSTRAINT_UNIQUE", errno: 2067 };
		const failure = new Error("private payload SELECT ".repeat(1000), { cause });
		spyOn(db, "transaction").mockImplementation(() => {
			throw failure;
		});
		spyOn(logger, "error").mockImplementation(() => {
			throw new Error("diagnostic sink unavailable");
		});
		expect(
			await rejected(narratorPersistence.appendBlockToMessage(partial.id, "n", blocks[0])),
		).toBe(failure);
		expect(failure.cause).toBe(cause);
	});
});
