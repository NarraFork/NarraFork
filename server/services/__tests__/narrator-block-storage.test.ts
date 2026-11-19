/**
 * Block storage dual-write (docs/BLOCK_STORAGE-DESIGN.md P1): every block-format envelope
 * keeps `narrator_blocks` rows that assemble back to its stored content, through the
 * store's own writes and through the queue for everyone else's.
 */

import { Database } from "bun:sqlite";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { assembleContent } from "@shared/narrator-blocks/storage";
import { clearedToolOutput } from "@shared/storage-retention";
import { DrizzleQueryError, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { cleanDb } from "../../../tests/setup";
import { narratorMessages, narratorToolCalls } from "../../db/schema";
import {
	captureWorkerRejection,
	captureWorkerRejectionThrower,
	getNarratorWorkerTestDb,
} from "./narrator-worker-fixture";

// The file-backed fixture serializes the complete schema, including dual-write triggers.
const workerFixture = getNarratorWorkerTestDb();
const { db, sqlite } = workerFixture;
await workerFixture.ready;
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

// narrator-service must be imported before narrator-persistence (pre-existing cycle).
await import("../narrator-service");
const { narratorStore } = await import("../narrator-store");
const { narratorPersistence } = await import("../narrator-persistence");
const blockSync = await import("../narrator-block-sync");
const blockIndex = await import("../narrator-block-index");
const { runBlockIndexQueueSlice } = await import("../../lib/db-worker/block-backfill-query");
const readIndex: import("../narrator-block-index").IndexQueueReader = async (params) =>
	runBlockIndexQueueSlice(sqlite, params);
const turns = await import("../narrator-turns");
const epochs = await import("../narrator-epochs");
const { toolRegistry } = await import("../../lib/agent/tool-registry");
const { clearModelHistorySourceCacheForTest } = await import(
	"../agent-runtime/model-history-source"
);
const { closePrefixSnapshotStore } = await import("../narrator-prefix-snapshots");
const { ensureFts } = await import("../../db/fts");
const { logger } = await import("../../lib/logger");
const { eventBus } = await import("../../lib/event-bus");
const contextCharacters = await import("../../lib/context-characters");
const { processEvent } = await import("../narrator-event-handler");
ensureFts(sqlite, { wasClean: true });

const NOW = "2026-10-01T00:00:00.000Z";

beforeEach(async () => {
	(await import("../../lib/settings")).settings.narratorBlocks.compactJson = false;
	blockSync.stopBlockSyncSweep();
	blockIndex.resetBlockIndexForTests();
	await closePrefixSnapshotStore();
	clearModelHistorySourceCacheForTest();
	cleanDb(sqlite);
	sqlite.run("DELETE FROM narrator_blocks_fts");
	for (const id of ["n1", "n2"])
		sqlite.run("INSERT INTO narrators (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [
			id,
			`Narrator ${id}`,
			NOW,
			NOW,
		]);
});
afterEach(() => {
	blockSync.stopBlockSyncSweep();
	blockIndex.stopBlockIndex();
});
afterAll(async () => {
	blockSync.stopBlockSyncSweep();
	blockIndex.stopBlockIndex();
	await closePrefixSnapshotStore();
	clearModelHistorySourceCacheForTest();
	await workerFixture.close();
	mock.module("../../db", () => realDbModule);
});

interface BlockRow {
	id: string;
	kind: string;
	subtype: string | null;
	phase: string;
	attemptId: string | null;
	originBlockId: string | null;
	wireId: string | null;
	payload: string;
	state: string | null;
}

function blocks(messageId: string): BlockRow[] {
	return sqlite
		.prepare(
			`SELECT id, kind, subtype, phase, attempt_id AS attemptId, origin_block_id AS originBlockId,
				wire_id AS wireId, payload, state
			 FROM narrator_blocks WHERE message_id = ? ORDER BY ordinal`,
		)
		.all(messageId) as BlockRow[];
}

function assembled(messageId: string): unknown[] {
	return assembleContent(
		blocks(messageId).map((row) => ({
			payload: JSON.parse(row.payload),
			state: row.state ? JSON.parse(row.state) : null,
		})),
	);
}

function envelope(messageId: string) {
	return sqlite
		.prepare(
			`SELECT narrator_id AS narratorId, author_narrator_id AS authorNarratorId,
				body_format AS bodyFormat, turn_id AS turnId, content_json AS contentJson
			 FROM narrator_messages WHERE id = ?`,
		)
		.get(messageId) as {
		narratorId: string;
		authorNarratorId: string | null;
		bodyFormat: number;
		turnId: string | null;
		contentJson: string;
	};
}

const content = (messageId: string) => JSON.parse(envelope(messageId).contentJson) as unknown[];

const queued = () =>
	(sqlite.prepare("SELECT count(*) AS n FROM narrator_block_sync_queue").get() as { n: number }).n;

/** A separate thread owns the lock, so main-thread SQLite never prevents its release. */
async function holdWriterLock() {
	const signal = new Int32Array(new SharedArrayBuffer(4));
	const worker = new Worker(
		`const { Database } = require("bun:sqlite");
		const { parentPort, workerData } = require("node:worker_threads");
		const signal = new Int32Array(workerData.signal);
		const sqlite = new Database(workerData.path, { readwrite: true, create: false });
		try {
			sqlite.exec("BEGIN IMMEDIATE");
			parentPort.postMessage("locked");
			if (Atomics.wait(signal, 0, 0, 5000) === "timed-out") throw new Error("Lock release timed out");
			sqlite.exec("COMMIT");
			Atomics.store(signal, 0, 2);
			Atomics.notify(signal, 0);
		} finally {
			sqlite.close();
		}
		parentPort.close();`,
		{ eval: true, workerData: { path: sqlite.filename, signal: signal.buffer } },
	);
	try {
		expect(await once(worker, "message", { signal: AbortSignal.timeout(4000) })).toEqual([
			"locked",
		]);
	} catch (error) {
		await worker.terminate();
		throw error;
	}
	return {
		release() {
			Atomics.compareExchange(signal, 0, 0, 1);
			Atomics.notify(signal, 0);
		},
		waitUntilReleased() {
			if (Atomics.load(signal, 0) !== 2) Atomics.wait(signal, 0, 1, 3000);
			expect(Atomics.load(signal, 0)).toBe(2);
		},
		close: () => worker.terminate(),
	};
}

/** Observe real prefix-worker busy/success phases without replacing its SQLite writes. */
function prefixWriter(signal: Int32Array<SharedArrayBuffer>) {
	const worker = new Worker(
		`const { Database } = require("bun:sqlite");
		const { workerData } = require("node:worker_threads");
		const signal = new Int32Array(workerData.signal);
		const query = Database.prototype.query;
		Database.prototype.query = function (text) {
			const statement = query.call(this, text);
			if (!text.startsWith("UPDATE narrator_text_snapshots")) return statement;
			const all = statement.all.bind(statement);
			statement.all = (...parameters) => {
				try {
					const rows = all(...parameters);
					Atomics.store(signal, 0, 2);
					Atomics.notify(signal, 0);
					return rows;
				} catch (error) {
					if (error.code === "SQLITE_BUSY") {
						Atomics.store(signal, 0, 1);
						Atomics.notify(signal, 0);
					}
					throw error;
				}
			};
			return statement;
		};
		require(workerData.modulePath);`,
		{
			eval: true,
			workerData: {
				modulePath: new URL("../narrator-prefix-snapshots-worker.ts", import.meta.url).pathname,
				signal: signal.buffer,
			},
		},
	);
	return {
		async request(message: unknown) {
			const response = once(worker, "message", { signal: AbortSignal.timeout(4000) });
			worker.postMessage(message);
			const [value] = await response;
			expect(value.error).toBeUndefined();
			return value;
		},
		close: () => worker.terminate(),
	};
}

describe("block storage dual-write", () => {
	test("a streamed step keeps one row per item, equal to its content", async () => {
		const step = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
		expect(envelope(step.id)).toMatchObject({ bodyFormat: 2, authorNarratorId: "n1" });

		await narratorStore.writeStepItem(
			step.id,
			"n1",
			{ type: "text", id: "t1", text: "Hel", completed: false, outputIndex: 0 },
			{ attemptId: "a1" },
		);
		const [open] = blocks(step.id);
		expect(open).toMatchObject({ kind: "output", phase: "open", attemptId: "a1" });

		await narratorStore.writeStepItem(
			step.id,
			"n1",
			{ type: "text", id: "t1", text: "Hello", completed: true, outputIndex: 0 },
			{ attemptId: "a1" },
		);
		const [sealed] = blocks(step.id);
		// The checkpoint rewrote the same row, not a new one.
		expect(sealed).toMatchObject({ id: open.id, phase: "done" });

		const toolCallId = await narratorStore.writeStepItem(
			step.id,
			"n1",
			{ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" }, outputIndex: 1 },
			{ attemptId: "a1" },
		);
		const tool = blocks(step.id)[1];
		expect(tool).toMatchObject({ kind: "tool", subtype: "Bash", wireId: "c1", phase: "open" });
		const ledger = () =>
			sqlite
				.prepare("SELECT block_id AS blockId FROM narrator_tool_calls WHERE id = ?")
				.get(toolCallId ?? "") as { blockId: string | null };
		expect(ledger().blockId).toBe(tool.id);

		await narratorStore.settleTool(
			"c1",
			{ output: "a.txt", status: "success" },
			step.id,
			toolCallId,
		);
		expect(blocks(step.id)[1]).toMatchObject({ id: tool.id, phase: "done" });
		expect(assembled(step.id)).toEqual(content(step.id));
		expect(queued()).toBe(0);
	});

	test("a discarded attempt loses exactly the blocks it created", async () => {
		const step = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
		await narratorStore.writeStepItem(
			step.id,
			"n1",
			{ type: "text", id: "t1", text: "kept", completed: true, outputIndex: 0 },
			{ attemptId: "a1" },
		);
		await narratorStore.writeStepItem(
			step.id,
			"n1",
			{ type: "text", id: "t2", text: "replayed", completed: true, outputIndex: 1 },
			{ attemptId: "a2" },
		);
		await narratorStore.writeStepItem(
			step.id,
			"n1",
			{ type: "tool_use", id: "c2", name: "Read", input: { file_path: "x" }, outputIndex: 2 },
			{ attemptId: "a2" },
		);
		// A baseline past the end would drop nothing: the attempt id decides.
		const discarded = await narratorStore.discardAttempt("n1", step.id, 99, "a2");
		expect(discarded).toMatchObject({ discardedBlocks: 2, removedToolUseIds: ["c2"] });
		const messageId = discarded?.messageId ?? step.id;
		expect(content(messageId)).toEqual([
			expect.objectContaining({ type: "text", id: "t1", text: "kept" }),
		]);
		expect(blocks(messageId).map((row) => row.attemptId)).toEqual(["a1"]);
		expect(
			sqlite
				.prepare("SELECT count(*) AS n FROM narrator_tool_calls WHERE tool_use_id = 'c2'")
				.get(),
		).toEqual({ n: 0 });
		// Nothing of a1 is touched by discarding an attempt that wrote nothing.
		expect(await narratorStore.discardAttempt("n1", messageId, 99, "a3")).toBeNull();
	});

	test("a copy belongs to its holder, keeps its author, and points at the blocks it copies", async () => {
		const input = await narratorStore.appendInput("n1", "shared question");
		sqlite.run(
			"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES ('r2', 'n2', ?, 0)",
			[input.id],
		);
		const [source] = blocks(input.id);
		const copyId = await narratorPersistence.copyOnWriteMessage("n2", input.id, {
			contentJson: [{ type: "text", text: "edited question" }],
			contentText: "edited question",
		});
		expect(copyId).not.toBe(input.id);
		expect(envelope(copyId)).toMatchObject({ narratorId: "n2", authorNarratorId: "n1" });
		expect(blocks(copyId)).toEqual([
			expect.objectContaining({ kind: "input", originBlockId: source.id }),
		]);
		expect(assembled(copyId)).toEqual(content(copyId));
		// The original is untouched for the narrator still holding it.
		expect(content(input.id)).toEqual([{ type: "text", text: "shared question" }]);
	});

	test("a write outside the store converges through the queue", async () => {
		const input = await narratorStore.appendInput("n1", "before");
		sqlite.run("UPDATE narrator_messages SET content_json = ?, content_text = ? WHERE id = ?", [
			JSON.stringify([{ type: "text", text: "after" }]),
			"after",
			input.id,
		]);
		expect(queued()).toBe(1);
		blockSync.flushChangedEnvelopes();
		expect(queued()).toBe(0);
		expect(assembled(input.id)).toEqual([{ type: "text", text: "after" }]);
	});

	test("the dual-write audit finds and repairs rows that differ from their envelope", async () => {
		const input = await narratorStore.appendInput("n1", "audited");
		expect(blockSync.auditRecentEnvelopes()).toEqual([]);
		sqlite.run("UPDATE narrator_blocks SET payload = ? WHERE message_id = ?", [
			JSON.stringify({ raw: [{ type: "text", text: "tampered" }] }),
			input.id,
		]);
		expect(blockSync.auditRecentEnvelopes()).toEqual([input.id]);
		expect(assembled(input.id)).toEqual(content(input.id));
	});

	test("a legacy-format envelope keeps no rows and queues nothing", () => {
		sqlite.run(
			`INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at)
			 VALUES ('legacy', 'n1', 'user', '[{"type":"text","text":"old"}]', ?)`,
			[NOW],
		);
		sqlite.run(
			`UPDATE narrator_messages SET content_json = '[{"type":"text","text":"new"}]' WHERE id = 'legacy'`,
		);
		expect(queued()).toBe(0);
		expect(blocks("legacy")).toEqual([]);
	});
});

describe("tool result dirty selection", () => {
	async function tool(id = "call", stepId?: string) {
		const messageId =
			stepId ?? (await narratorStore.openStep("n1", { uuid: id, session_id: "s" })).id;
		const toolCallId = await narratorStore.writeStepItem(messageId, "n1", {
			type: "tool_use",
			id,
			name: "Bash",
			input: { command: id },
		});
		blockSync.stopBlockSyncSweep();
		return { messageId, toolCallId };
	}

	function dirtyInputs(count: number) {
		for (let i = 0; i < count; i++) {
			const id = `unrelated-${i}`;
			sqlite.run(
				`INSERT INTO narrator_messages (id, narrator_id, role, body_format, content_json, created_at)
				 VALUES (?, ?, 'user', 2, '[{"type":"text","text":"before"}]', ?)`,
				[id, i % 2 ? "n1" : "n2", NOW],
			);
			blockSync.syncEnvelopeNow(id);
			sqlite.run("UPDATE narrator_messages SET content_json = ? WHERE id = ?", [
				JSON.stringify([{ type: "text", text: `after-${i}` }]),
				id,
			]);
		}
	}

	const indexQueue = () =>
		sqlite
			.prepare("SELECT block_id, version FROM narrator_block_index_queue ORDER BY block_id")
			.all();

	function indexed(term: string): string[] {
		return (
			sqlite
				.prepare(
					`SELECT b.wire_id AS id FROM narrator_blocks_fts
					 JOIN narrator_blocks b ON b.rowid = narrator_blocks_fts.rowid
					 WHERE narrator_blocks_fts MATCH ? ORDER BY b.wire_id`,
				)
				.all(`"${term}"`) as Array<{ id: string }>
		).map((row) => row.id);
	}

	const imageOutput = (text: string, imageId: string) => ({
		_text: text,
		_images: [{ imageId, mediaType: "image/png", uploadNarratorId: "n1" }],
	});

	test("preview metadata preserves exact attempt selection and cleared payload state", async () => {
		const target = await tool();
		const { readNarratorToolPreview, validateNarratorToolRead } = await import(
			"../narrator-read-snapshots"
		);
		const input = {
			narratorId: "n1",
			toolUseId: "call",
			reference: {
				toolCallId: target.toolCallId as string,
				messageId: target.messageId,
				executionAttempt: 1,
			},
		};
		expect(validateNarratorToolRead(input)).toBe(true);
		expect(readNarratorToolPreview(sqlite, input)).toMatchObject({
			id: target.toolCallId,
			executionAttempt: 1,
			payloadCleared: false,
		});
		const legacyAttempt = { ...input, reference: { ...input.reference, executionAttempt: 0 } };
		expect(validateNarratorToolRead(legacyAttempt)).toBe(true);
		expect(() => readNarratorToolPreview(sqlite, legacyAttempt)).toThrow("ToolCall not found");
		expect(
			validateNarratorToolRead({
				...input,
				reference: { ...input.reference, executionAttempt: -1 },
			}),
		).toBe(false);
		sqlite.run("UPDATE narrator_tool_calls SET output_json = ? WHERE id = ?", [
			JSON.stringify(clearedToolOutput(NOW)),
			target.toolCallId as string,
		]);
		expect(readNarratorToolPreview(sqlite, input)).toMatchObject({ payloadCleared: true });
	});

	test("settlement holds the write lock before its first queue SELECT", async () => {
		const target = await tool();
		const contender = new Database(sqlite.filename, { readwrite: true, create: false });
		contender.run("PRAGMA busy_timeout = 0");
		const mark = blockSync.syncQueueMark;
		let checked = false;
		const queueMark = spyOn(blockSync, "syncQueueMark").mockImplementation(() => {
			expect(sqlite.inTransaction).toBe(true);
			try {
				contender.exec("BEGIN IMMEDIATE");
				throw new Error("Settlement has not acquired its write lock");
			} catch (error) {
				expect(error).toMatchObject({ code: "SQLITE_BUSY", errno: 5 });
				checked = true;
			}
			return mark();
		});
		try {
			await narratorStore.settleTool(
				"call",
				{ status: "success" },
				target.messageId,
				target.toolCallId,
			);
			expect(checked).toBe(true);
			expect(queueMark).toHaveBeenCalledTimes(1);
		} finally {
			queueMark.mockRestore();
			if (contender.inTransaction) contender.exec("ROLLBACK");
			contender.close();
		}
	});

	test("the real prefix snapshot worker waits for settlement's writer then commits", async () => {
		const target = await tool();
		const hash = "a".repeat(64);
		sqlite.run(
			"INSERT INTO narrator_text_snapshots (sha256, text, byte_size, created_at) VALUES (?, 'snapshot', 8, ?)",
			[hash, NOW],
		);
		const signal = new Int32Array(new SharedArrayBuffer(4));
		const worker = prefixWriter(signal);
		const mark = blockSync.syncQueueMark;
		let touched: Promise<unknown> | undefined;
		try {
			expect(await worker.request({ action: "ping" })).toEqual({ ready: true });
			const queueMark = spyOn(blockSync, "syncQueueMark").mockImplementation(() => {
				touched = worker.request({
					action: "task",
					backend: { backend: "sqlite", path: sqlite.filename },
					operation: "touch",
					value: [hash],
					cacheBytes: 1024,
					deadline: Date.now() + 4000,
				});
				// A shared phase signal, rather than a main-thread timer, proves that the
				// worker actually tried to write while this transaction owned the lock.
				Atomics.wait(signal, 0, 0, 3000);
				expect(Atomics.load(signal, 0)).toBe(1);
				expect(
					sqlite
						.prepare("SELECT created_at FROM narrator_text_snapshots WHERE sha256 = ?")
						.get(hash),
				).toEqual({ created_at: NOW });
				return mark();
			});
			try {
				await narratorStore.settleTool(
					"call",
					{ status: "success", output: "serialized result" },
					target.messageId,
					target.toolCallId,
				);
				expect(queueMark).toHaveBeenCalledTimes(1);
			} finally {
				queueMark.mockRestore();
			}
			await touched;
			expect(Atomics.load(signal, 0)).toBe(2);
			expect(
				sqlite.prepare("SELECT created_at FROM narrator_text_snapshots WHERE sha256 = ?").get(hash),
			).not.toEqual({ created_at: NOW });
			expect(blocks(target.messageId)[0].phase).toBe("done");
		} finally {
			await worker.close();
			await touched?.catch(() => {});
		}
	});

	test.each([
		"released",
		"held",
	] as const)("an independent writer lock is %s across bounded attempts", async (mode) => {
		const persistent = mode === "held";
		const target = await tool();
		const beforeVersion = sqlite
			.prepare("SELECT message_version FROM narrators WHERE id = 'n1'")
			.get();
		const holder = await holdWriterLock();
		const transaction = db.transaction.bind(db);
		const attempts = spyOn(db, "transaction").mockImplementation((write, config) => {
			expect(config?.behavior).toBe("immediate");
			return transaction(write, config);
		});
		const delays: number[] = [];
		const timeout = globalThis.setTimeout;
		const timers = spyOn(globalThis, "setTimeout").mockImplementation(
			Object.assign((...args: Parameters<typeof timeout>) => {
				const [, delay] = args;
				if (delay === 200 || delay === 400 || delay === 800 || delay === 1600) {
					expect(sqlite.inTransaction).toBe(false);
					delays.push(delay);
				}
				return timeout(...args);
			}, timeout),
		);
		const retryLogs: unknown[] = [];
		const warn = spyOn(logger, "warn").mockImplementation((message, metadata) => {
			if (message.startsWith("updateToolCallResult failed")) {
				expect(sqlite.inTransaction).toBe(false);
				retryLogs.push(metadata);
				if (!persistent) {
					holder.release();
					holder.waitUntilReleased();
				}
			}
		});
		const errors = spyOn(logger, "error").mockImplementation(() => {});
		const changed = mock(() => {});
		const publication = mock(() => {});
		eventBus.on("narrator:tool_changed", changed);
		try {
			const settle = narratorStore.settleTool(
				"call",
				{ status: "success", output: "lock result", onPersist: publication },
				target.messageId,
				target.toolCallId,
			);
			if (persistent) {
				expect(await captureWorkerRejection(settle)).toMatchObject({
					code: "SQLITE_BUSY",
					errno: 5,
				});
				expect(attempts).toHaveBeenCalledTimes(5);
				expect(delays).toEqual([200, 400, 800, 1600]);
				expect(publication).not.toHaveBeenCalled();
				expect(changed).not.toHaveBeenCalled();
				expect(
					sqlite.prepare("SELECT message_version FROM narrators WHERE id = 'n1'").get(),
				).toEqual(beforeVersion);
				expect(blocks(target.messageId)[0].phase).toBe("open");
			} else {
				expect(await settle).toMatchObject({ id: target.toolCallId });
				expect(attempts).toHaveBeenCalledTimes(2);
				expect(delays).toEqual([200]);
				expect(publication).toHaveBeenCalledTimes(1);
				expect(changed).toHaveBeenCalledTimes(1);
				expect(blocks(target.messageId)[0].phase).toBe("done");
			}
			expect(retryLogs).toHaveLength(persistent ? 4 : 1);
			expect(JSON.stringify(retryLogs)).toContain("phase=transaction, code=SQLITE_BUSY, errno=5");
			expect(JSON.stringify(retryLogs)).not.toContain("lock result");
			expect(sqlite.inTransaction).toBe(false);
		} finally {
			eventBus.off("narrator:tool_changed", changed);
			holder.release();
			await holder.close();
			timers.mockRestore();
			warn.mockRestore();
			errors.mockRestore();
			attempts.mockRestore();
		}
	});

	test.each([
		"success",
		"fail",
	] as const)("a retried active-only recovery preserves an existing %s receipt and publication", async (status) => {
		const target = await tool();
		await narratorStore.settleTool(
			"call",
			{ status, output: "original terminal output" },
			target.messageId,
			target.toolCallId,
		);
		const snapshot = () => ({
			tool: sqlite
				.query("SELECT * FROM narrator_tool_calls WHERE id = ?")
				.get(target.toolCallId ?? ""),
			blocks: blocks(target.messageId),
			versions: sqlite.query("SELECT id, message_version FROM narrators ORDER BY id").all(),
			queue: indexQueue(),
		});
		const before = snapshot();
		const transaction = db.transaction.bind(db);
		let attempt = 0;
		const transactions = spyOn(db, "transaction").mockImplementation((write, config) => {
			if (++attempt === 1)
				throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY", errno: 5 });
			return transaction(write, config);
		});
		const publication = mock(() => {});
		try {
			expect(
				await narratorStore.settleTool(
					"call",
					{
						status: "fail",
						output: "recovery explanation",
						onlyIfActive: true,
						expectedBinding: {
							narratorId: "n1",
							toolCallId: target.toolCallId as string,
							attempt: 1,
						},
						onPersist: publication,
					},
					target.messageId,
					target.toolCallId,
				),
			).toBeUndefined();
			expect(transactions).toHaveBeenCalledTimes(2);
			expect(publication).not.toHaveBeenCalled();
			expect(snapshot()).toEqual(before);
		} finally {
			transactions.mockRestore();
		}
	});

	test.each([
		"code",
		"extended-errno",
		"message",
	] as const)("a wrapped lock error retries from its driver's %s", async (kind) => {
		const target = await tool();
		const driver = Object.assign(
			new Error(kind === "message" ? "database is locked" : "driver fault"),
			kind === "code" ? { code: "SQLITE_BUSY" } : kind === "extended-errno" ? { errno: 517 } : {},
		);
		const original = new DrizzleQueryError(
			"UPDATE private_query_marker SET value = ?",
			["private-param-marker"],
			driver,
		);
		const transaction = db.transaction.bind(db);
		let attempt = 0;
		const transactions = spyOn(db, "transaction").mockImplementation((write, config) => {
			if (++attempt === 1) throw original;
			return transaction(write, config);
		});
		const logs: unknown[] = [];
		const warn = spyOn(logger, "warn").mockImplementation((message, data) => {
			if (message.startsWith("updateToolCallResult failed")) logs.push(data);
		});
		const publication = mock(() => {});
		try {
			expect(
				await narratorStore.settleTool(
					"call",
					{
						status: "success",
						output: "wrapped busy result",
						onPersist: publication,
					},
					target.messageId,
					target.toolCallId,
				),
			).toMatchObject({ id: target.toolCallId });
			expect(transactions).toHaveBeenCalledTimes(2);
			expect(publication).toHaveBeenCalledTimes(1);
			expect(logs).toHaveLength(1);
			expect(JSON.stringify(logs)).toContain("phase=transaction");
			expect(JSON.stringify(logs)).not.toContain("private-");
			expect(blocks(target.messageId)[0].phase).toBe("done");
		} finally {
			warn.mockRestore();
			transactions.mockRestore();
		}
	});

	test.each([
		"plain",
		"misleading-code",
	] as const)("a %s query wrapper preserves a non-lock callback failure in one attempt", async (kind) => {
		const target = await tool();
		// Inject an explicit wrapper; synchronous Bun SQLite normally throws the driver error directly.
		const driver = Object.assign(
			new Error("constraint fault"),
			kind === "misleading-code" ? { code: "SQLITE_CONSTRAINT_TRIGGER", errno: 1811 } : {},
		);
		const original = Object.assign(
			new DrizzleQueryError(
				"UPDATE private_query_marker SET value = ?",
				["SQLITE_BUSY database is locked private-param-marker"],
				driver,
			),
			kind === "misleading-code" ? { code: "SQLITE_BUSY", errno: 5 } : {},
		);
		const publication = mock(() => {
			throw original;
		});
		const transactions = spyOn(db, "transaction");
		const logs: unknown[] = [];
		const errorLog = spyOn(logger, "error").mockImplementation((_message, data) => {
			logs.push(data);
		});
		try {
			expect(
				await captureWorkerRejection(
					narratorStore.settleTool(
						"call",
						{
							status: "success",
							output: "SQLITE_BUSY database is locked private-result-marker",
							onPersist: publication,
						},
						target.messageId,
						target.toolCallId,
					),
				),
			).toBe(original);
			expect(transactions).toHaveBeenCalledTimes(1);
			expect(publication).toHaveBeenCalledTimes(1);
			expect(blocks(target.messageId)[0].phase).toBe("open");
			expect(logs).toHaveLength(1);
			expect(JSON.stringify(logs)).not.toContain("private-");
		} finally {
			errorLog.mockRestore();
			transactions.mockRestore();
		}
	});

	test("a writer during backoff cannot make the committed version timestamp move backwards", async () => {
		const target = await tool();
		const before = sqlite
			.prepare("SELECT message_version AS version FROM narrators WHERE id = 'n1'")
			.get() as { version: number };
		const other = new Database(sqlite.filename, { readwrite: true, create: false });
		const transaction = db.transaction.bind(db);
		let attempt = 0;
		const transactions = spyOn(db, "transaction").mockImplementation((write, config) => {
			if (++attempt === 1)
				throw Object.assign(new Error("driver lock"), { code: "SQLITE_BUSY", errno: 5 });
			return transaction(write, config);
		});
		const interveningAt = "2026-10-01T00:00:01.000Z";
		const committedAt = "2026-10-01T00:00:02.000Z";
		let intervened = false;
		let interleavingError: unknown;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const warn = spyOn(logger, "warn").mockImplementation((message) => {
			if (!message.startsWith("updateToolCallResult failed")) return;
			timer = setTimeout(() => {
				try {
					expect(sqlite.inTransaction).toBe(false);
					setSystemTime(new Date(interveningAt));
					other.run(
						"UPDATE narrators SET message_version = message_version + 1, updated_at = ? WHERE id = 'n1'",
						[interveningAt],
					);
					intervened = true;
					setSystemTime(new Date(committedAt));
				} catch (error) {
					interleavingError = error;
				}
			}, 0);
		});
		const refresh = spyOn(contextCharacters, "queueContextCharacterRefresh").mockImplementation(
			() => {},
		);
		setSystemTime(new Date(NOW));
		try {
			await narratorStore.settleTool(
				"call",
				{
					status: "success",
					expectedBinding: {
						narratorId: "n1",
						toolCallId: target.toolCallId as string,
						attempt: 1,
					},
					includeLegacyParentVersions: true,
				},
				target.messageId,
				target.toolCallId,
			);
			expect(interleavingError).toBeUndefined();
			expect(intervened).toBe(true);
			expect(transactions).toHaveBeenCalledTimes(2);
			expect(
				sqlite
					.prepare("SELECT message_version AS version, updated_at FROM narrators WHERE id = 'n1'")
					.get(),
			).toEqual({ version: before.version + 2, updated_at: committedAt });
			expect(
				sqlite
					.prepare("SELECT completed_at FROM narrator_tool_calls WHERE id = ?")
					.get(target.toolCallId as string),
			).toEqual({ completed_at: NOW });
		} finally {
			setSystemTime();
			if (timer) clearTimeout(timer);
			refresh.mockRestore();
			warn.mockRestore();
			transactions.mockRestore();
			other.close();
		}
	});

	test("settlement reaches its target beyond 64 dirty messages and leaves other narrators untouched", async () => {
		sqlite.run(
			`INSERT INTO narrator_messages (id, narrator_id, role, body_format, content_json, created_at)
			 VALUES ('zz-target', 'n1', 'assistant', 2, '[]', ?)`,
			[NOW],
		);
		sqlite.run(
			`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq)
			 VALUES ('target-ref', 'n1', 'zz-target', 0)`,
		);
		const target = await tool("call", "zz-target");
		dirtyInputs(70);
		sqlite.run("INSERT INTO narrator_block_sync_queue (message_id) VALUES (?)", [target.messageId]);
		expect(
			sqlite.prepare("SELECT message_id FROM narrator_block_sync_queue LIMIT 64").all(),
		).not.toContainEqual({ message_id: target.messageId });
		const before = Array.from({ length: 70 }, (_, i) => blocks(`unrelated-${i}`));
		await narratorStore.settleTool(
			"call",
			{ output: "target settled", status: "success", resultMessageId: "unrelated-69" },
			undefined,
			target.toolCallId,
		);
		expect(blocks(target.messageId)[0].phase).toBe("done");
		expect(indexed("target settled")).toEqual([]);
		// Use the production-sized bounded slice to reach past the unrelated queued envelopes.
		await blockIndex.drainBlockIndexQueue(async (params) =>
			runBlockIndexQueueSlice(sqlite, params),
		);
		expect(indexed("target settled")).toEqual(["call"]);
		expect(queued()).toBe(70);
		expect(Array.from({ length: 70 }, (_, i) => blocks(`unrelated-${i}`))).toEqual(before);
		expect(blockSync.flushChangedEnvelopes()).toBe(64);
		expect(queued()).toBe(6);
		expect(blockSync.flushChangedEnvelopes()).toBe(6);
		for (let i = 0; i < 70; i++)
			expect(assembled(`unrelated-${i}`)).toEqual([{ type: "text", text: `after-${i}` }]);
	});

	test("settling B converges A's older dirty output and both image links even with unchanged A blocks", async () => {
		const a = await tool("A");
		const b = await tool("B", a.messageId);
		const assets = () =>
			sqlite
				.prepare(
					`SELECT b.wire_id AS tool, a.asset_id AS asset, a.role
					 FROM narrator_block_assets a JOIN narrator_blocks b ON b.id = a.block_id
					 WHERE b.message_id = ? ORDER BY tool, asset`,
				)
				.all(a.messageId);
		await narratorStore.settleTool(
			"A",
			{ output: imageOutput("former apple", "old-image"), status: "success" },
			a.messageId,
			a.toolCallId,
		);
		await blockIndex.drainBlockIndexQueue(readIndex);
		expect(indexed("former apple")).toEqual(["A"]);
		const before = blocks(a.messageId)[0];
		sqlite.run("UPDATE narrator_tool_calls SET output_json = ? WHERE id = ?", [
			JSON.stringify(imageOutput("fresh apricot", "image-a")),
			a.toolCallId as string,
		]);
		await narratorStore.settleTool(
			"B",
			{ output: imageOutput("fresh blueberry", "image-b"), status: "success" },
			b.messageId,
			b.toolCallId,
		);
		expect(blocks(a.messageId)[0]).toEqual(before);
		expect(queued()).toBe(0);
		expect(assets()).toEqual([
			{ tool: "A", asset: "image-a", role: "tool_image" },
			{ tool: "B", asset: "image-b", role: "tool_image" },
		]);
		await blockIndex.drainBlockIndexQueue(readIndex);
		expect(indexed("former apple")).toEqual([]);
		expect(indexed("fresh apricot")).toEqual(["A"]);
		expect(indexed("fresh blueberry")).toEqual(["B"]);
		// Another settlement with identical block payload/state must still replace B's output.
		await narratorStore.settleTool(
			"B",
			{ output: imageOutput("ripe blackberry", "replacement-b"), status: "success" },
			b.messageId,
			b.toolCallId,
		);
		expect(assets()).toEqual([
			{ tool: "A", asset: "image-a", role: "tool_image" },
			{ tool: "B", asset: "replacement-b", role: "tool_image" },
		]);
		expect(queued()).toBe(0);
		await blockIndex.drainBlockIndexQueue(readIndex);
		expect(indexed("fresh blueberry")).toEqual([]);
		expect(indexed("ripe blackberry")).toEqual(["B"]);
	});

	test("an actual-input rewrite syncs its result once and does not drain unrelated work", async () => {
		const target = await tool();
		dirtyInputs(1);
		sqlite.run("CREATE TEMP TABLE test_asset_writes (n INTEGER)");
		sqlite.run(
			`CREATE TEMP TRIGGER count_asset_writes AFTER INSERT ON narrator_block_assets
			 BEGIN INSERT INTO test_asset_writes VALUES (1); END`,
		);
		try {
			await narratorStore.settleTool(
				"call",
				{
					output: imageOutput("sanitized result", "result-image"),
					status: "success",
					input: { command: "sanitized command" },
				},
				target.messageId,
				target.toolCallId,
			);
			expect(sqlite.prepare("SELECT count(*) AS n FROM test_asset_writes").get()).toEqual({ n: 1 });
			expect(assembled(target.messageId)).toEqual([
				expect.objectContaining({ input: { command: "sanitized command" } }),
			]);
			expect(queued()).toBe(1);
			expect(assembled("unrelated-0")).toEqual([{ type: "text", text: "before" }]);
		} finally {
			sqlite.run("DROP TRIGGER count_asset_writes");
			sqlite.run("DROP TABLE test_asset_writes");
		}
	});

	test("a zero-row callback syncs its new envelopes and leaves earlier pending work queued", async () => {
		const target = await tool();
		dirtyInputs(1);
		sqlite.run(
			`CREATE TEMP TRIGGER ignore_result BEFORE UPDATE OF output_json ON narrator_tool_calls
			 BEGIN SELECT RAISE(IGNORE); END`,
		);
		try {
			await narratorStore.settleTool(
				"call",
				{ output: "ignored", status: "success" },
				target.messageId,
				target.toolCallId,
			);
			expect(queued()).toBe(1);
			let callbackRan = false;
			await narratorStore.settleTool(
				"call",
				{
					output: "ignored",
					status: "success",
					onPersist: () => {
						callbackRan = true;
						sqlite.run("UPDATE narrator_messages SET content_json = ? WHERE id = 'unrelated-0'", [
							JSON.stringify([{ type: "text", text: "callback body" }]),
						]);
						sqlite.run(
							`INSERT INTO narrator_messages (id, narrator_id, role, body_format, content_json, created_at)
							 VALUES ('callback-new', 'n1', 'user', 2, ?, ?)`,
							[JSON.stringify([{ type: "text", text: "new callback body" }]), NOW],
						);
					},
				},
				target.messageId,
				target.toolCallId,
			);
			expect(callbackRan).toBe(true);
			expect(queued()).toBe(1);
			expect(assembled("callback-new")).toEqual([{ type: "text", text: "new callback body" }]);
			expect(assembled("unrelated-0")).toEqual([{ type: "text", text: "before" }]);
			expect(content("unrelated-0")).toEqual([{ type: "text", text: "callback body" }]);
			expect(blockSync.flushChangedEnvelopeTargets(["unrelated-0"])).toBe(1);
			expect(assembled("unrelated-0")).toEqual([{ type: "text", text: "callback body" }]);
			await expect(
				narratorStore.settleTool("call", {
					status: "success",
					expectedBinding: {
						narratorId: "n1",
						toolCallId: target.toolCallId as string,
						attempt: 1,
					},
				}),
			).rejects.toThrow("stale");
		} finally {
			sqlite.run("DROP TRIGGER ignore_result");
		}
	});

	test("publication callback faults roll back result, actual input, companion body, assets and indexes together", async () => {
		const target = await tool();
		dirtyInputs(1);
		blockSync.flushChangedEnvelopeTargets(["unrelated-0"]);
		await blockIndex.drainBlockIndexQueue(readIndex);
		const beforeIndexQueue = indexQueue();
		const beforeTarget = blocks(target.messageId);
		const beforeCompanion = blocks("unrelated-0");
		const companionBody = () =>
			sqlite
				.prepare(
					"SELECT content_json, content_text, body_bytes FROM narrator_messages WHERE id = 'unrelated-0'",
				)
				.get();
		const beforeBody = companionBody();
		const original = new Error("publication intent body fault");
		let sawResultInsideTransaction = false;
		expect(
			await captureWorkerRejection(
				narratorStore.settleTool(
					"call",
					{
						status: "success",
						output: imageOutput("publication result", "publication-image"),
						input: { command: "publication command marker" },
						onPersist: (tx) => {
							sawResultInsideTransaction =
								tx
									.select({ status: narratorToolCalls.status })
									.from(narratorToolCalls)
									.where(eq(narratorToolCalls.id, target.toolCallId as string))
									.get()?.status === "success";
							tx.update(narratorMessages)
								.set({
									contentJson: [{ type: "text", text: "publication body marker" }],
									contentText: "publication body marker",
								})
								.where(eq(narratorMessages.id, "unrelated-0"))
								.run();
							blockSync.flushChangedEnvelopeTargets(["unrelated-0"]);
							expect(assembled("unrelated-0")).toEqual([
								{ type: "text", text: "publication body marker" },
							]);
							expect(assembled(target.messageId)).toEqual([
								expect.objectContaining({ input: { command: "publication command marker" } }),
							]);
							expect(indexQueue()).toEqual(
								expect.arrayContaining([
									expect.objectContaining({ block_id: blocks(target.messageId)[0].id }),
									expect.objectContaining({ block_id: blocks("unrelated-0")[0].id }),
								]),
							);
							expect(indexed("publication body marker")).toEqual([]);
							expect(indexed("publication command marker")).toEqual([]);
							throw original;
						},
					},
					target.messageId,
					target.toolCallId,
				),
			),
		).toBe(original);
		expect(sawResultInsideTransaction).toBe(true);
		expect(
			sqlite
				.prepare("SELECT status, output_json, input_json FROM narrator_tool_calls WHERE id = ?")
				.get(target.toolCallId as string),
		).toEqual({ status: "initializing", output_json: null, input_json: '{"command":"call"}' });
		expect(blocks(target.messageId)).toEqual(beforeTarget);
		expect(blocks("unrelated-0")).toEqual(beforeCompanion);
		expect(companionBody()).toEqual(beforeBody);
		expect(indexQueue()).toEqual(beforeIndexQueue);
		expect(await blockIndex.drainBlockIndexQueue(readIndex)).toBe(0);
		expect(indexed("publication body marker")).toEqual([]);
		expect(indexed("publication command marker")).toEqual([]);
		expect(indexed("after-0")).toHaveLength(1);
		expect(sqlite.prepare("SELECT asset_id FROM narrator_block_assets").all()).toEqual([]);
		expect(queued()).toBe(0);
	});

	test("a constraint fault with lock keywords rolls back result, input, blocks and publication in one attempt", async () => {
		const target = await tool();
		dirtyInputs(1);
		blockSync.flushChangedEnvelopeTargets(["unrelated-0"]);
		const beforeTarget = blocks(target.messageId);
		const beforeCompanion = blocks("unrelated-0");
		const beforeQueue = indexQueue();
		const version = () =>
			sqlite.prepare("SELECT message_version, updated_at FROM narrators WHERE id = 'n1'").get();
		const beforeVersion = version();
		sqlite.run("CREATE TEMP TABLE test_publications (id TEXT)");
		sqlite.run(`CREATE TEMP TRIGGER reject_result_version BEFORE UPDATE OF message_version ON narrators
			WHEN NEW.id = 'n1' BEGIN SELECT RAISE(ABORT, 'SQLITE_BUSY database is locked version write fault'); END`);
		const changed = mock(() => {});
		const refresh = spyOn(contextCharacters, "queueContextCharacterRefresh");
		const attempts = spyOn(db, "transaction");
		eventBus.on("narrator:tool_changed", changed);
		let published = false;
		try {
			const error = await captureWorkerRejection(
				narratorStore.settleTool(
					"call",
					{
						status: "success",
						output: imageOutput("atomic result", "atomic-image"),
						input: { command: "atomic command" },
						onPersist: (tx) => {
							expect(sqlite.inTransaction).toBe(true);
							expect(blocks(target.messageId)[0].phase).toBe("done");
							tx.update(narratorMessages)
								.set({ contentJson: [{ type: "text", text: "atomic companion" }] })
								.where(eq(narratorMessages.id, "unrelated-0"))
								.run();
							sqlite.run("INSERT INTO test_publications VALUES ('publication')");
							published = true;
						},
					},
					target.messageId,
					target.toolCallId,
				),
			);
			expect(error).toMatchObject({ code: "SQLITE_CONSTRAINT_TRIGGER", errno: 1811 });
			expect(published).toBe(true);
			expect(attempts).toHaveBeenCalledTimes(1);
			expect(
				sqlite
					.prepare("SELECT status, output_json, input_json FROM narrator_tool_calls WHERE id = ?")
					.get(target.toolCallId as string),
			).toEqual({ status: "initializing", output_json: null, input_json: '{"command":"call"}' });
			expect(blocks(target.messageId)).toEqual(beforeTarget);
			expect(blocks("unrelated-0")).toEqual(beforeCompanion);
			expect(content("unrelated-0")).toEqual([{ type: "text", text: "after-0" }]);
			expect(indexQueue()).toEqual(beforeQueue);
			expect(sqlite.prepare("SELECT * FROM test_publications").all()).toEqual([]);
			expect(sqlite.prepare("SELECT asset_id FROM narrator_block_assets").all()).toEqual([]);
			expect(version()).toEqual(beforeVersion);
			expect(queued()).toBe(0);
			expect(refresh).not.toHaveBeenCalled();
			expect(changed).not.toHaveBeenCalled();
		} finally {
			eventBus.off("narrator:tool_changed", changed);
			refresh.mockRestore();
			attempts.mockRestore();
			sqlite.run("DROP TRIGGER reject_result_version");
			sqlite.run("DROP TABLE test_publications");
		}
	});

	test.each([
		"legacy",
		"actual",
		"bound-legacy",
		"empty-parent",
		"skip",
	] as const)("version targets preserve %s parent semantics and deduplicate owners", async (mode) => {
		sqlite.run(
			"INSERT INTO narrators (id, title, created_at, updated_at) VALUES ('n3', 'third', ?, ?)",
			[NOW, NOW],
		);
		sqlite.run("UPDATE narrators SET type = 'subagent', parent_narrator_id = 'n2' WHERE id = 'n1'");
		for (const owner of ["n1", "n3"]) {
			const step = await narratorStore.openStep(owner, { uuid: owner, session_id: "s" });
			await narratorStore.writeStepItem(step.id, owner, {
				type: "tool_use",
				id: "shared-parent",
				name: "Bash",
				input: {},
			});
		}
		const target = await tool();
		if (mode === "empty-parent")
			sqlite.run(
				"UPDATE narrator_tool_calls SET tool_use_id = '' WHERE narrator_id = 'n3' AND tool_use_id = 'shared-parent'",
			);
		sqlite.run("UPDATE narrator_messages SET parent_tool_use_id = ? WHERE id = ?", [
			mode === "empty-parent" ? "" : "shared-parent",
			target.messageId,
		]);
		const versions = () =>
			sqlite
				.prepare("SELECT id, message_version AS version, updated_at FROM narrators ORDER BY id")
				.all() as Array<{ id: string; version: number; updated_at: string }>;
		const before = versions();
		await narratorStore.settleTool(
			"call",
			{
				status: "success",
				...(mode === "actual" || mode === "bound-legacy"
					? {
							expectedBinding: {
								narratorId: "n1",
								toolCallId: target.toolCallId as string,
								attempt: 1,
							},
						}
					: {}),
				...(mode === "bound-legacy" ? { includeLegacyParentVersions: true } : {}),
				...(mode === "skip" ? { bumpMessageVersion: false } : {}),
			},
			target.messageId,
			target.toolCallId,
		);
		const changedIds =
			mode === "skip"
				? []
				: mode === "actual"
					? ["n1", "n2"]
					: mode === "empty-parent"
						? ["n1"]
						: ["n1", "n3"];
		const after = versions();
		for (let index = 0; index < before.length; index++) {
			const changed = changedIds.includes(before[index].id);
			expect(after[index].version).toBe(before[index].version + (changed ? 1 : 0));
			if (!changed) expect(after[index].updated_at).toBe(before[index].updated_at);
		}
	});

	test.each([
		"context-characters",
		"tool-changed",
		"both",
	] as const)("a committed result survives %s notification failure without replay", async (phase) => {
		const target = await tool();
		const before = sqlite
			.prepare("SELECT message_version AS version FROM narrators WHERE id = 'n1'")
			.get() as { version: number };
		const original = Object.assign(new Error("private-input-output-sql-marker"), {
			code: "E_NOTIFY",
			errno: 7,
		});
		const refresh = spyOn(contextCharacters, "queueContextCharacterRefresh").mockImplementation(
			() => {
				expect(sqlite.inTransaction).toBe(false);
				if (phase !== "tool-changed") throw original;
			},
		);
		const emit = spyOn(eventBus, "emit").mockImplementation((event) => {
			if (event.type === "narrator:tool_changed" && phase !== "context-characters") throw original;
		});
		const logs: unknown[] = [];
		const warn = spyOn(logger, "warn").mockImplementation((message, data) => {
			if (message !== "Tool result notification failed") return;
			logs.push(data);
			if (phase === "both") throw new Error("diagnostic sink fault");
		});
		const transactions = spyOn(db, "transaction");
		const publication = mock(() => {});
		try {
			expect(
				await narratorStore.settleTool(
					"call",
					{
						status: "success",
						output: "committed notification result",
						onPersist: publication,
					},
					target.messageId,
					target.toolCallId,
				),
			).toMatchObject({ id: target.toolCallId });
			expect(transactions).toHaveBeenCalledTimes(1);
			expect(publication).toHaveBeenCalledTimes(1);
			expect(refresh).toHaveBeenCalledTimes(1);
			expect(
				emit.mock.calls.filter(([event]) => event.type === "narrator:tool_changed"),
			).toHaveLength(1);
			expect(
				sqlite.prepare("SELECT message_version AS version FROM narrators WHERE id = 'n1'").get(),
			).toEqual({ version: before.version + 1 });
			expect(blocks(target.messageId)[0].phase).toBe("done");
			expect(logs).toHaveLength(phase === "both" ? 2 : 1);
			for (const log of logs)
				expect(log).toMatchObject({
					operation: "updateToolCallResult",
					code: "E_NOTIFY",
					errno: 7,
				});
			expect(logs).toEqual(
				phase === "both"
					? [
							expect.objectContaining({ phase: "context-characters" }),
							expect.objectContaining({ phase: "tool-changed" }),
						]
					: [expect.objectContaining({ phase })],
			);
			expect(JSON.stringify(logs)).not.toContain("private-");
		} finally {
			transactions.mockRestore();
			warn.mockRestore();
			emit.mockRestore();
			refresh.mockRestore();
		}
	});

	test("callbacks sync their precise result and at most 64 newly queued companion envelopes", async () => {
		const target = await tool();
		dirtyInputs(70);
		sqlite.run("INSERT INTO narrator_block_sync_queue (message_id) VALUES (?)", [target.messageId]);
		await narratorStore.settleTool(
			"call",
			{
				status: "success",
				output: "callback result",
				onPersist: () => {
					for (let i = 0; i < 65; i++)
						sqlite.run(
							`INSERT INTO narrator_messages (id, narrator_id, role, body_format, content_json, created_at)
							 VALUES (?, 'n1', 'user', 2, ?, ?)`,
							[`callback-${i}`, JSON.stringify([{ type: "text", text: `callback-${i}` }]), NOW],
						);
				},
			},
			target.messageId,
			target.toolCallId,
		);
		expect(blocks(target.messageId)[0].phase).toBe("done");
		expect(queued()).toBe(71);
		for (let i = 0; i < 70; i++)
			expect(assembled(`unrelated-${i}`)).toEqual([{ type: "text", text: "before" }]);
		for (let i = 0; i < 64; i++)
			expect(assembled(`callback-${i}`)).toEqual([{ type: "text", text: `callback-${i}` }]);
		expect(blocks("callback-64")).toEqual([]);
		expect(blockSync.flushChangedEnvelopeTargets(["callback-64"])).toBe(1);
		expect(assembled("callback-64")).toEqual([{ type: "text", text: "callback-64" }]);
		expect(queued()).toBe(70);
		await blockIndex.drainBlockIndexQueue(async (params) =>
			runBlockIndexQueueSlice(sqlite, params),
		);
		expect(indexed("callback result")).toEqual(["call"]);
	});

	test("an empty returned message identity leaves earlier unrelated work for the sweep", async () => {
		const target = await tool();
		// Empty identifiers pass the real NOT NULL/FK constraints but are not usable sync targets.
		// Keep the referenced envelope present so settlement itself reaches the fallback boundary.
		sqlite.run(
			`INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at)
			 VALUES ('', 'n1', 'assistant', '[]', ?)`,
			[NOW],
		);
		sqlite.run("UPDATE narrator_tool_calls SET message_id = '' WHERE id = ?", [
			target.toolCallId as string,
		]);
		dirtyInputs(1);
		const settled = await narratorStore.settleTool(
			"call",
			{ status: "success", output: "fallback result" },
			undefined,
			target.toolCallId,
		);
		expect(settled).toMatchObject({ id: target.toolCallId, messageId: "" });
		expect(
			sqlite
				.prepare("SELECT message_id, status FROM narrator_tool_calls WHERE id = ?")
				.get(target.toolCallId as string),
		).toEqual({ message_id: "", status: "success" });
		expect(queued()).toBe(1);
		expect(assembled("unrelated-0")).toEqual([{ type: "text", text: "before" }]);
		expect(blockSync.flushChangedEnvelopeTargets(["unrelated-0"])).toBe(1);
		expect(assembled("unrelated-0")).toEqual([{ type: "text", text: "after-0" }]);
	});

	test("target flush deduplicates dirty ids and defers search text while preserving legacy bodies", async () => {
		dirtyInputs(1);
		sqlite.run(
			`INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at)
			 VALUES ('legacy-target', 'n1', 'user', '[]', ?)`,
			[NOW],
		);
		sqlite.run("INSERT INTO narrator_block_sync_queue (message_id) VALUES ('legacy-target')");
		const stats = blockSync.createBlockSyncStats();
		let tick = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => ++tick);
		try {
			expect(
				blockSync.withBlockSyncStats(stats, () =>
					blockSync.flushChangedEnvelopeTargets([
						"unrelated-0",
						"unrelated-0",
						"legacy-target",
						"missing",
					]),
				),
			).toBe(2);
		} finally {
			clock.mockRestore();
		}
		expect(stats).toMatchObject({
			messages: 2,
			ledgerRows: 0,
			blockVisits: 2,
			blockWrites: 1,
			indexTextCount: 0,
			indexTextMs: 0,
			indexQueued: 1,
			ftsWrites: 0,
			ftsDeletes: 0,
			ftsMs: 0,
		});
		expect(stats.messageSyncMs).toBeGreaterThan(stats.maxMessageSyncMs);
		expect(stats.maxMessageSyncMs).toBeGreaterThan(0);
		expect(stats.indexQueueMs).toBeGreaterThan(0);
		expect(blocks("legacy-target")).toEqual([]);
		expect(queued()).toBe(0);
		expect(indexed("after-0")).toEqual([]);
		expect(indexQueue()).toHaveLength(1);
		const collected = { ...stats };
		blockSync.reindexEnvelope("unrelated-0");
		expect(stats).toEqual(collected);
		expect(await blockIndex.drainBlockIndexQueue(readIndex)).toBe(1);
		expect(indexed("after-0")).toHaveLength(1);
		expect(stats).toEqual(collected);
	});

	test("target sync failure rolls back output, blocks, dirty state and terminal notifications", async () => {
		const target = await tool();
		const changed = mock(() => {});
		const completed: string[] = [];
		const broadcast = (event: { message: { type: string } }) => {
			if (event.message.type === "tool_completed") completed.push(event.message.type);
		};
		eventBus.on("narrator:tool_changed", changed);
		eventBus.on("narrator:message_broadcast", broadcast);
		sqlite.run(
			`CREATE TEMP TRIGGER reject_tool_block BEFORE UPDATE ON narrator_blocks
			 WHEN NEW.kind = 'tool' BEGIN SELECT RAISE(ABORT, 'target sync fault'); END`,
		);
		const before = blocks(target.messageId);
		try {
			expect(
				await captureWorkerRejectionThrower(
					narratorStore.settleTool(
						"call",
						{ status: "success", output: "must rollback" },
						target.messageId,
						target.toolCallId,
					),
				),
			).toThrow("target sync fault");
			expect(
				await captureWorkerRejectionThrower(
					processEvent(
						{
							type: "tool_result",
							toolName: "Bash",
							toolUseId: "call",
							toolCallBinding: { toolCallId: target.toolCallId as string, attempt: 1 },
							output: "must not announce completion",
							isError: false,
						},
						{
							narratorId: "n1",
							broadcastTargetId: "n1",
							conversationId: "s",
							getPartialMessageId: () => undefined,
							getContextUsagePct: () => undefined,
							getMeterUsage: () => undefined,
							getMeterUnit: () => undefined,
							getTokenUsage: () => undefined,
							setPartialMessageId: () => {},
							setContextUsagePct: () => {},
							setMeterData: () => {},
							setTokenUsage: () => {},
							toolCallIdsMap: new Map([["call", target.toolCallId as string]]),
						},
					),
				),
			).toThrow("Tool result could not be persisted");
			expect(completed).toEqual([]);
			expect(
				sqlite
					.prepare("SELECT output_json, status FROM narrator_tool_calls WHERE id = ?")
					.get(target.toolCallId as string),
			).toEqual({ output_json: null, status: "initializing" });
			expect(blocks(target.messageId)).toEqual(before);
			expect(queued()).toBe(0);
			expect(changed).not.toHaveBeenCalled();
		} finally {
			eventBus.off("narrator:tool_changed", changed);
			eventBus.off("narrator:message_broadcast", broadcast);
			sqlite.run("DROP TRIGGER reject_tool_block");
		}
	});
});

describe("tool result transaction diagnostics", () => {
	test("each retry observes only its complete transaction and commits publication and version once", async () => {
		const step = await narratorStore.openStep("n1", { uuid: "retry-step", session_id: "s" });
		const toolCallId = await narratorStore.writeStepItem(step.id, "n1", {
			type: "tool_use",
			id: "retry-call",
			name: "Bash",
			input: { command: "original" },
		});
		blockSync.stopBlockSyncSweep();
		sqlite.run("CREATE TEMP TABLE retry_publications (id TEXT)");
		const before = sqlite
			.prepare("SELECT message_version AS version FROM narrators WHERE id = 'n1'")
			.get() as { version: number };
		const transaction = db.transaction.bind(db);
		let attempt = 0;
		let elapsed = 0;
		let wall = Date.now() + 100_000;
		const clock = spyOn(performance, "now").mockImplementation(() => elapsed);
		const wallClock = spyOn(Date, "now").mockImplementation(() => wall);
		const transactions = spyOn(db, "transaction").mockImplementation((write, config) => {
			try {
				return transaction((tx) => {
					const value = write(tx);
					if (++attempt < 5)
						throw Object.assign(new Error("SQLITE_BUSY private-result-marker"), {
							code: "SQLITE_BUSY",
							errno: 5,
						});
					return value;
				}, config);
			} finally {
				elapsed += 30;
				wall += 60_000;
			}
		});
		const timeout = globalThis.setTimeout;
		const timers = spyOn(globalThis, "setTimeout").mockImplementation(
			Object.assign((...args: Parameters<typeof timeout>) => {
				const [, delay] = args;
				if (delay === 200 || delay === 400 || delay === 800 || delay === 1600) {
					expect(sqlite.inTransaction).toBe(false);
					elapsed += delay;
				}
				return timeout(...args);
			}, timeout),
		);
		const logs: Array<{ message: string; data: Record<string, unknown> }> = [];
		const warn = spyOn(logger, "warn").mockImplementation((message, data) => {
			expect(sqlite.inTransaction).toBe(false);
			logs.push({ message, data: data ?? {} });
		});
		const publication = mock(() => sqlite.run("INSERT INTO retry_publications VALUES ('result')"));
		const refresh = spyOn(contextCharacters, "queueContextCharacterRefresh").mockImplementation(
			() => {},
		);
		const changed = mock(() => {});
		eventBus.on("narrator:tool_changed", changed);
		try {
			await narratorStore.settleTool(
				"retry-call",
				{ status: "success", output: "private-result-marker", onPersist: publication },
				step.id,
				toolCallId,
			);
			expect(transactions).toHaveBeenCalledTimes(5);
			expect(publication).toHaveBeenCalledTimes(5);
			expect(sqlite.prepare("SELECT * FROM retry_publications").all()).toEqual([{ id: "result" }]);
			expect(
				sqlite.prepare("SELECT message_version AS version FROM narrators WHERE id = 'n1'").get(),
			).toEqual({ version: before.version + 1 });
			expect(refresh).toHaveBeenCalledTimes(1);
			expect(changed).toHaveBeenCalledTimes(1);
			const attempts = logs.filter((log) => log.message === "Slow tool result transaction");
			expect(attempts).toHaveLength(5);
			expect(attempts.map((log) => log.data.outcome)).toEqual([
				"rolled_back",
				"rolled_back",
				"rolled_back",
				"rolled_back",
				"committed",
			]);
			for (const { data } of attempts)
				expect(data).toMatchObject({
					transactionMs: 30,
					syncMode: "callback",
					messages: 1,
					ledgerRows: 1,
					blockWrites: 1,
				});
			expect(JSON.stringify(logs)).not.toContain("private-result-marker");
		} finally {
			eventBus.off("narrator:tool_changed", changed);
			refresh.mockRestore();
			warn.mockRestore();
			timers.mockRestore();
			transactions.mockRestore();
			wallClock.mockRestore();
			clock.mockRestore();
			sqlite.run("DROP TABLE retry_publications");
		}
	});

	test("timing includes commit and rollback, logs bounded metadata at most once per minute, and stays best effort", async () => {
		const step = await narratorStore.openStep("n1", { uuid: "diagnostic-step", session_id: "s" });
		const toolCallId = await narratorStore.writeStepItem(step.id, "n1", {
			type: "tool_use",
			id: "diagnostic-call",
			name: "Bash",
			input: { command: "private-input-marker" },
		});
		blockSync.stopBlockSyncSweep();
		let elapsed = 0;
		let transactionCost = 0;
		let wall = Date.now() + 1_000_000;
		const logs: Array<Record<string, unknown>> = [];
		const clock = spyOn(performance, "now").mockImplementation(() => elapsed);
		const wallClock = spyOn(Date, "now").mockImplementation(() => wall);
		const transaction = db.transaction.bind(db);
		const transactions = spyOn(db, "transaction").mockImplementation((write, config) => {
			try {
				return transaction(write, config);
			} finally {
				// Added after the real transaction has committed or rolled back, not in its callback.
				elapsed += transactionCost;
			}
		});
		const warn = spyOn(logger, "warn").mockImplementation((message, data) => {
			if (message !== "Slow tool result transaction") return;
			expect(sqlite.inTransaction).toBe(false);
			logs.push(data ?? {});
		});
		const settle = (output: string) =>
			narratorStore.settleTool(
				"diagnostic-call",
				{ status: "success", output, bumpMessageVersion: false },
				step.id,
				toolCallId,
			);
		try {
			// Advance through the production logging boundary once to drain history from earlier
			// tests, then begin a fresh minute without adding a production-only reset API.
			transactionCost = 25;
			await settle("diagnostic window initialization");
			expect(logs).toHaveLength(1);
			wall += 60_000;
			logs.length = 0;
			transactionCost = 24;
			await settle("private-output-marker");
			expect(logs).toEqual([]);
			transactionCost = 25;
			await settle("private-updated-output-marker");
			expect(logs).toHaveLength(1);
			expect(logs[0]).toMatchObject({
				operation: "updateToolCallResult",
				syncMode: "targeted",
				outcome: "committed",
				transactionMs: 25,
				suppressed: 0,
				maxTransactionMs: 25,
				messages: 1,
				ledgerRows: 1,
				blockVisits: 2,
				blockWrites: 1,
				indexTextCount: 0,
				indexTextMs: 0,
				indexQueued: 1,
				ftsWrites: 0,
				ftsDeletes: 0,
				ftsMs: 0,
			});
			expect(logs[0].plannedBodyBytes).toBeGreaterThan(0);
			wall++;
			transactionCost = 80;
			await settle("suppressed output");
			wall += 59_998;
			transactionCost = 100;
			await settle("suppressed output");
			expect(logs).toHaveLength(1);
			wall++;
			transactionCost = 30;
			await settle("suppressed output");
			expect(logs).toHaveLength(2);
			expect(logs[1]).toMatchObject({
				suppressed: 2,
				maxTransactionMs: 100,
				transactionMs: 30,
				messages: 1,
				ledgerRows: 1,
				blockVisits: 1,
				blockWrites: 0,
				plannedBodyBytes: 0,
				indexQueued: 0,
			});

			warn.mockImplementation((message, data) => {
				if (message === "Slow tool result transaction") {
					expect(sqlite.inTransaction).toBe(false);
					logs.push(data ?? {});
					throw new Error("diagnostic sink fault");
				}
			});
			wall += 60_000;
			transactionCost = 40;
			await settle("committed with failed logger");
			expect(
				sqlite
					.prepare("SELECT output_json FROM narrator_tool_calls WHERE id = ?")
					.get(toolCallId as string),
			).toEqual({ output_json: '"committed with failed logger"' });
			const original = new Error("publication intent original fault");
			wall += 60_000;
			expect(
				await captureWorkerRejection(
					narratorStore.settleTool(
						"diagnostic-call",
						{
							status: "fail",
							output: "rolled back output",
							onPersist: () => {
								throw original;
							},
						},
						step.id,
						toolCallId,
					),
				),
			).toBe(original);
			expect(logs.at(-1)).toMatchObject({
				syncMode: "callback",
				outcome: "rolled_back",
				transactionMs: 40,
			});
			expect(
				sqlite
					.prepare("SELECT output_json FROM narrator_tool_calls WHERE id = ?")
					.get(toolCallId as string),
			).toEqual({ output_json: '"committed with failed logger"' });
			const keys = [
				"operation",
				"syncMode",
				"outcome",
				"transactionMs",
				"suppressed",
				"maxTransactionMs",
				"messages",
				"messageSyncMs",
				"maxMessageSyncMs",
				"ledgerRows",
				"blockVisits",
				"blockWrites",
				"plannedBodyBytes",
				"indexTextCount",
				"indexTextMs",
				"indexQueued",
				"indexQueueMs",
				"ftsWrites",
				"ftsDeletes",
				"ftsMs",
			].sort();
			for (const log of logs) {
				expect(Object.keys(log).sort()).toEqual(keys);
				for (const [key, value] of Object.entries(log))
					if (!["operation", "syncMode", "outcome"].includes(key))
						expect(typeof value === "number" && Number.isFinite(value)).toBe(true);
				expect(JSON.stringify(log)).not.toContain("private-");
			}
			const logsBeforeReindex = logs.length;
			const createStats = spyOn(blockSync, "createBlockSyncStats");
			try {
				blockSync.reindexEnvelope(step.id);
				expect(createStats).not.toHaveBeenCalled();
				expect(logs).toHaveLength(logsBeforeReindex);
			} finally {
				createStats.mockRestore();
			}
			clock.mockImplementation(() => {
				throw new Error("diagnostic clock fault");
			});
			await settle("committed with failed clock");
		} finally {
			warn.mockRestore();
			transactions.mockRestore();
			wallClock.mockRestore();
			clock.mockRestore();
		}
	});
});

describe("narrator turns", () => {
	test("a run is one row: its trigger, its envelopes, its counts", async () => {
		const input = await narratorStore.appendInput("n1", "go");
		const turnId = turns.startTurn("n1");
		expect(turnId).toBeString();
		expect(envelope(input.id).turnId).toBe(turnId);

		const step = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
		expect(envelope(step.id).turnId).toBe(turnId);
		turns.recordTurnStep("n1", "anthropic:claude", { inputTokens: 10, completionTokens: 4 });
		turns.recordTurnToolCall("n1");
		turns.endTurn("n1", turnId, { status: "completed", stopReason: "end_turn" });

		const row = sqlite
			.prepare(
				`SELECT status, trigger_message_id AS triggerMessageId, stop_reason AS stopReason,
					step_count AS stepCount, tool_call_count AS toolCallCount, usage_json AS usageJson
				 FROM narrator_turns WHERE id = ?`,
			)
			.get(turnId ?? "") as Record<string, unknown>;
		expect(row).toMatchObject({
			status: "completed",
			triggerMessageId: input.id,
			stopReason: "end_turn",
			stepCount: 1,
			toolCallCount: 1,
		});
		expect(JSON.parse(String(row.usageJson))).toMatchObject({
			"anthropic:claude": { requests: 1, inputTokens: 10, outputTokens: 4 },
		});
		// Idle writes belong to no run.
		const idle = await narratorStore.appendInput("n1", "later");
		expect(envelope(idle.id).turnId).toBeNull();
	});

	test("a run cut off by a restart ends interrupted", async () => {
		const turnId = turns.startTurn("n1");
		expect(turns.recoverInterruptedTurns()).toBe(1);
		expect(
			sqlite
				.prepare("SELECT status, stop_reason AS stopReason FROM narrator_turns WHERE id = ?")
				.get(turnId ?? ""),
		).toEqual({ status: "interrupted", stopReason: "restart" });
		// The in-memory run of the old process is gone with it; a late end is a no-op.
		turns.endTurn("n1", turnId, { status: "completed", stopReason: "end_turn" });
		expect(
			sqlite.prepare("SELECT status FROM narrator_turns WHERE id = ?").get(turnId ?? ""),
		).toEqual({ status: "interrupted" });
	});
});

describe("epoch reconcile", () => {
	const managed = new Set(["WebFetch", "Knowledge"]);
	const target = (fingerprint: string) => () => ({ fingerprint, cacheTtlMs: 5 * 60_000 });

	async function rows() {
		const { narratorService } = await import("../narrator-service");
		return narratorService.getModelHistorySinceLastCompact("n1");
	}

	async function stepAt(createdAt: string) {
		const step = await narratorStore.openStep("n1", {
			uuid: crypto.randomUUID(),
			session_id: "s",
			provider: "anthropic",
			model: "claude",
		});
		sqlite.run("UPDATE narrator_messages SET created_at = ? WHERE id = ?", [createdAt, step.id]);
	}

	const reconcile = async (current: string[], fingerprint: string, now: number) =>
		(
			await epochs.reconcileEpoch({
				narratorId: "n1",
				messages: await rows(),
				managed,
				current,
				model: "claude",
				provider: "anthropic",
				noticeText: (kind, name) => `${kind}:${name}`,
				now,
				resolveTarget: target(fingerprint),
			})
		).changed;

	test("cache age and tool loads never open another epoch", async () => {
		await stepAt("2026-10-01T00:00:00.000Z");
		expect(await reconcile([], "t", Date.parse("2026-10-01T00:00:01.000Z"))).toBe(true);
		const baseline = await rows();
		const initial = baseline.at(-1);
		if (!initial) throw new Error("Expected the initial epoch marker");
		expect(initial.contentJson).toMatchObject([
			{ type: "epoch", epoch: { reason: "initial", target: "t", toolNames: [] } },
		]);
		const later = Date.parse("2026-10-01T01:00:00.000Z");
		expect(await reconcile([], "t", later)).toBe(false);
		await narratorStore.appendToolChange("n1", {
			type: "tool_loaded",
			toolName: "WebFetch",
			toolNames: ["WebFetch"],
			text: "loaded",
		});
		const withLoad = await rows();
		expect(await reconcile(["WebFetch"], "t", later)).toBe(false);
		expect(await rows()).toEqual(withLoad);
		expect<unknown>(withLoad.slice(0, baseline.length)).toEqual(baseline);
		expect(
			withLoad
				.filter((row) => (row.contentJson as { type?: string }[])[0]?.type === "epoch")
				.map((row) => row.id),
		).toEqual([initial.id]);
		expect(await reconcile(["WebFetch"], "t", Date.parse("2026-10-01T00:00:01.000Z"))).toBe(false);
	});

	test("legacy epoch recovery and same-name registry changes do not open epochs", async () => {
		const { toolRegistry } = await import("../../lib/agent/tool-registry");
		const name = "mcp__epoch_test__run";
		const definition = {
			name,
			description: "old",
			parameters: z.object({}),
			rawJsonSchema: { type: "object", properties: {} },
			execute: async () => ({ output: "ok" }),
		};
		toolRegistry.register(definition);
		try {
			await narratorStore.openEpoch("n1", {
				reason: "manual",
				target: "t",
				toolNames: [name],
			});
			const upgrade = async () =>
				(
					await epochs.reconcileEpoch({
						narratorId: "n1",
						messages: await rows(),
						managed: new Set([name]),
						current: [name],
						model: "claude",
						provider: "anthropic",
						noticeText: () => "changed",
						resolveTarget: target("t"),
					})
				).changed;
			const initialRows = await rows();
			// Recovery preserves a legacy boundary rather than manufacturing a registry epoch.
			expect(await upgrade()).toBe(false);
			expect(await upgrade()).toBe(false);
			toolRegistry.register({ ...definition, description: "new" });
			expect(
				(
					await epochs.reconcileEpoch({
						narratorId: "n1",
						messages: await rows(),
						managed: new Set([name]),
						current: [name],
						model: "claude",
						provider: "anthropic",
						noticeText: () => "changed",
						resolveTarget: target("t"),
					})
				).changed,
			).toBe(false);
			expect(await rows()).toEqual(initialRows);
		} finally {
			toolRegistry.unregister(name);
		}
	});

	test("request history rebuild preserves the first schema despite a live registry replacement", async () => {
		const { toolRegistry } = await import("../../lib/agent/tool-registry");
		const { buildContextManagementHooks } = await import("../narrator-session");
		const runtimeHistory = await import("../agent-runtime/history");
		const { deriveToolLoadingState, selectRequestTools } = await import(
			"../../lib/agent/tool-loading"
		);
		const realReconcile = epochs.reconcileEpoch;
		const reconcileSpy = spyOn(epochs, "reconcileEpoch").mockImplementation((input) =>
			realReconcile({ ...input, resolveTarget: target("request-test") }),
		);
		// Keep the DB/epoch/state derivation real; only bypass provider-specific wire encoding.
		const projectionSpy = spyOn(runtimeHistory, "buildRuntimeHistory").mockImplementation(
			async (options) => {
				const sourceMessages = [...(options.sourceMessages ?? [])];
				if (!options.toolLoading) throw new Error("Expected request loading state");
				return {
					history: [],
					sourceMessages,
					modelMessages: sourceMessages,
					replayedInjectionMessageIds: [],
					currentText: "",
					currentInputText: "",
					currentInputPersisted: false,
					endsWithToolResults: false,
					endsWithInput: false,
					toolLoading: deriveToolLoadingState(
						sourceMessages,
						options.toolLoading.managed,
						options.toolLoading.current,
						options.toolLoading.epoch,
						options.toolLoading.candidates,
					),
					toolCandidates: options.toolLoading.candidates,
				};
			},
		);
		const name = "mcp__request_schema__run";
		const definition = {
			name,
			description: "request schema",
			parameters: z.object({}),
			rawJsonSchema: { type: "object", properties: { old: { type: "string" } } },
			execute: async () => ({ output: "ok" }),
		};
		toolRegistry.register(definition);
		try {
			const hooks = buildContextManagementHooks({
				narratorId: "n1",
				locale: "en",
				getModel: () => "claude",
				getProvider: () => "anthropic",
				getToolLoading: () => ({
					managed: new Set([name]),
					current: new Set([name]),
					candidates: toolRegistry.all(),
					registryRevision: toolRegistry.revision,
				}),
			});
			const first = await hooks.rebuildRequestHistory();
			const firstSnapshot = first.toolLoading?.definitionSnapshots?.find(
				(tool) => tool.name === name,
			);
			expect(firstSnapshot).toEqual({
				name,
				description: definition.description,
				parameters: definition.rawJsonSchema,
			});
			expect(first.toolCandidates?.find((tool) => tool.name === name)?.rawJsonSchema).toBe(
				definition.rawJsonSchema,
			);
			const firstRows = await rows();
			const replacement = { type: "object", properties: { updated: { type: "number" } } };
			toolRegistry.register({ ...definition, rawJsonSchema: replacement });
			const second = await hooks.rebuildRequestHistory();
			expect(second.toolLoading?.definitionSnapshots).toEqual(
				first.toolLoading?.definitionSnapshots,
			);
			// Execution sees the live implementation, but the wire declaration stays frozen.
			expect(second.toolCandidates?.find((tool) => tool.name === name)?.rawJsonSchema).toBe(
				replacement,
			);
			const firstWire = selectRequestTools(
				first.toolCandidates ?? [],
				first.toolLoading,
				"replace_tools",
			).tools;
			const secondWire = selectRequestTools(
				second.toolCandidates ?? [],
				second.toolLoading,
				"replace_tools",
			).tools;
			expect(epochs.snapshotToolDefinitions(secondWire)).toEqual(
				epochs.snapshotToolDefinitions(firstWire),
			);
			expect(secondWire.find((tool) => tool.name === name)?.rawJsonSchema).toEqual(
				definition.rawJsonSchema,
			);
			expect(second.toolLoading?.epochMarkerId).toBe(first.toolLoading?.epochMarkerId);
			expect(await rows()).toEqual(firstRows);
		} finally {
			toolRegistry.unregister(name);
			reconcileSpy.mockRestore();
			projectionSpy.mockRestore();
		}
	});

	test("inside a frozen epoch, a load that bypassed /load becomes a system notice", async () => {
		await narratorStore.openEpoch("n1", {
			reason: "manual",
			target: "t",
			toolNames: [],
			registryRevision: toolRegistry.revision,
		});
		await stepAt(new Date().toISOString());
		expect(await reconcile(["Knowledge"], "t", Date.now())).toBe(true);
		const notice = (await rows()).at(-1);
		expect(notice).toMatchObject({
			role: "user",
			origin: "system",
			contentJson: [
				{
					type: "tool_loaded",
					toolName: "Knowledge",
					toolNames: ["Knowledge"],
					text: "tool_loaded:Knowledge",
				},
			],
		});
		expect(await reconcile(["Knowledge"], "t", Date.now())).toBe(false);
	});
});
