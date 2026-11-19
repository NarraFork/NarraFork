/**
 * The block backfill (docs/BLOCK_STORAGE-DESIGN.md §10.3): legacy envelopes gain block
 * rows that assemble back to their stored content, without touching anything the model
 * reads or any revision that would invalidate its caches.
 */

import type { SQLQueryBindings } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { assembleContent } from "@shared/narrator-blocks/storage";
import { cleanDb } from "../../../tests/setup";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const workerFixture = getNarratorWorkerTestDb();
const { db, sqlite } = workerFixture;
await workerFixture.ready;
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

// narrator-service must be imported before narrator-persistence (pre-existing cycle).
await import("../narrator-service");
const { narratorStore } = await import("../narrator-store");
const { narratorPersistence } = await import("../narrator-persistence");
const { settings } = await import("../../lib/settings");
const blockSync = await import("../narrator-block-sync");
const backfill = await import("../narrator-block-backfill");
const blockIndex = await import("../narrator-block-index");
const workerPool = await import("../../lib/db-worker/pool");
const workerCore = await import("../../lib/db-worker/block-backfill-query");
const { logger } = await import("../../lib/logger");
const {
	runBlockBackfillSlice,
	runBlockVerifySlice,
	runBlockReindexSlice,
	runBlockProjectionSlice,
	runBlockIndexQueueSlice,
} = await import("../../lib/db-worker/block-backfill-query");
const readIndex: import("../narrator-block-index").IndexQueueReader = async (params) =>
	runBlockIndexQueueSlice(sqlite, params);

const NOW = "2026-10-01T00:00:00.000Z";

const { ensureFts } = await import("../../db/fts");
ensureFts(sqlite, { wasClean: true });

/** Explicit unit-test reader on the fixture connection; production only uses workers. */
const inline = {
	backfill: async (params: Parameters<typeof runBlockBackfillSlice>[1]) =>
		runBlockBackfillSlice(sqlite, params),
	verify: async (params: Parameters<typeof runBlockVerifySlice>[1]) =>
		runBlockVerifySlice(sqlite, params),
	reindex: async (params: Parameters<typeof runBlockReindexSlice>[1]) =>
		runBlockReindexSlice(sqlite, params),
};

/** Run the jobs to the end, then write the search text the store and the jobs queued. */
async function drain(): Promise<number> {
	await blockIndex.drainBlockIndexQueue(readIndex);
	let slices = 0;
	while (await backfill.runBlockJobSlice(inline)) slices++;
	await blockIndex.drainBlockIndexQueue(readIndex);
	return slices;
}

/** Write with block storage off: what a database from before P1 holds. */
async function legacy<T>(write: () => Promise<T>): Promise<T> {
	settings.narratorBlocks.write = false;
	try {
		return await write();
	} finally {
		settings.narratorBlocks.write = true;
	}
}

function envelope(messageId: string) {
	return sqlite
		.prepare(
			`SELECT body_format AS bodyFormat, body_revision AS bodyRevision, body_bytes AS bodyBytes,
				content_json AS contentJson
			 FROM narrator_messages WHERE id = ?`,
		)
		.get(messageId) as {
		bodyFormat: number;
		bodyRevision: number;
		bodyBytes: number;
		contentJson: string;
	};
}

function assembled(messageId: string): unknown[] {
	const rows = sqlite
		.prepare("SELECT payload, state FROM narrator_blocks WHERE message_id = ? ORDER BY ordinal")
		.all(messageId) as Array<{ payload: string; state: string | null }>;
	return assembleContent(
		rows.map((row) => ({
			payload: JSON.parse(row.payload),
			state: row.state ? JSON.parse(row.state) : null,
		})),
	);
}

const historyRevision = () =>
	(
		sqlite.prepare("SELECT model_history_revision AS n FROM narrators WHERE id = 'n1'").get() as {
			n: number;
		}
	).n;

beforeEach(() => {
	// Backfill assertions intentionally compare the legacy compatibility projection.
	settings.narratorBlocks.compactJson = false;
	// Fixtures drive synchronization explicitly; keep the timer producer outside their writes.
	blockSync.stopBlockSyncSweep();
	blockIndex.resetBlockIndexForTests();
	cleanDb(sqlite);
	sqlite.run("INSERT INTO narrators (id, title, created_at, updated_at) VALUES ('n1', 'N', ?, ?)", [
		NOW,
		NOW,
	]);
	sqlite.run("DELETE FROM narrator_block_backfill");
	sqlite.run("DELETE FROM narrator_block_diagnostics");
	backfill.resetBlockJobPacingForTests();
});
afterEach(() => {
	settings.narratorBlocks.write = true;
});
afterAll(async () => {
	blockSync.stopBlockSyncSweep();
	mock.module("../../db", () => realDbModule);
	await workerFixture.close();
});

describe("block backfill", () => {
	test("legacy envelopes gain rows equal to their content, and nothing the model reads moves", async () => {
		const { input, step, toolCallId } = await legacy(async () => {
			const input = await narratorStore.appendInput("n1", "list the files");
			const step = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
			await narratorStore.writeStepItem(step.id, "n1", {
				type: "reasoning",
				id: "r1",
				text: "thinking",
				completed: true,
				outputIndex: 0,
			});
			const toolCallId = await narratorStore.writeStepItem(step.id, "n1", {
				type: "tool_use",
				id: "c1",
				name: "Bash",
				input: { command: "ls" },
				outputIndex: 1,
			});
			await narratorStore.settleTool(
				"c1",
				{ output: "a.txt", status: "success" },
				step.id,
				toolCallId,
			);
			return { input, step, toolCallId };
		});
		expect(envelope(input.id).bodyFormat).toBe(1);
		const revisions = [envelope(input.id).bodyRevision, envelope(step.id).bodyRevision];
		const history = historyRevision();

		await drain();

		for (const id of [input.id, step.id]) {
			expect(envelope(id).bodyFormat).toBe(2);
			expect(assembled(id)).toEqual(JSON.parse(envelope(id).contentJson));
			expect(envelope(id).bodyBytes).toBeGreaterThan(0);
		}
		// Storage changed shape only: no revision moved, so no cache was invalidated.
		expect([envelope(input.id).bodyRevision, envelope(step.id).bodyRevision]).toEqual(revisions);
		expect(historyRevision()).toBe(history);
		const tool = sqlite
			.prepare("SELECT id, phase FROM narrator_blocks WHERE message_id = ? AND kind = 'tool'")
			.get(step.id) as { id: string; phase: string };
		expect(tool.phase).toBe("done");
		expect(
			sqlite
				.prepare("SELECT block_id AS blockId FROM narrator_tool_calls WHERE id = ?")
				.get(toolCallId ?? ""),
		).toEqual({ blockId: tool.id });
		// The block search index covers the converted rows.
		expect(
			sqlite
				.prepare("SELECT count(*) AS n FROM narrator_blocks_fts WHERE narrator_blocks_fts MATCH ?")
				.get('"list the files"'),
		).toEqual({ n: 1 });
		expect(sqlite.prepare("SELECT count(*) AS n FROM narrator_block_sync_queue").get()).toEqual({
			n: 0,
		});
		expect(backfill.blockBackfillStatus().convert).toMatchObject({ complete: true, processed: 2 });
		// Running again finds nothing to do.
		expect(await backfill.runBlockJobSlice(inline)).toBe(false);
	});

	test("an envelope that changed after the worker read it is converted from what it holds now", async () => {
		const input = await legacy(() => narratorStore.appendInput("n1", "before"));
		const stale = await inline.backfill({
			kind: "blockBackfillSlice",
			afterRowid: 0,
			maxEnvelopes: 100,
			maxSourceBytes: 1 << 22,
			budgetMs: 1000,
		});
		sqlite.run("UPDATE narrator_messages SET content_json = ?, content_text = ? WHERE id = ?", [
			JSON.stringify([{ type: "text", text: "after" }]),
			"after",
			input.id,
		]);
		await backfill.runBlockJobSlice({ ...inline, backfill: async () => stale });
		expect(envelope(input.id).bodyFormat).toBe(2);
		expect(assembled(input.id)).toEqual([{ type: "text", text: "after" }]);
	});

	test("a state-only write after the worker read the envelope is not lost", async () => {
		const step = await legacy(async () => {
			const opened = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
			await narratorStore.writeStepItem(opened.id, "n1", {
				type: "reasoning",
				id: "r1",
				text: "thinking",
				completed: true,
				outputIndex: 0,
			});
			return opened;
		});
		const stale = await inline.backfill({
			kind: "blockBackfillSlice",
			afterRowid: 0,
			maxEnvelopes: 100,
			maxSourceBytes: 1 << 22,
			budgetMs: 1000,
		});
		// A translation lands while the slice is in flight: state moves, the body does not.
		const { bodyRevision } = envelope(step.id);
		expect(await narratorPersistence.patchReasoningTranslation(step.id, 0, "思考")).toBeTruthy();
		expect(envelope(step.id).bodyRevision).toBe(bodyRevision);
		await backfill.runBlockJobSlice({ ...inline, backfill: async () => stale });
		expect(envelope(step.id).bodyFormat).toBe(2);
		expect(assembled(step.id)).toEqual(JSON.parse(envelope(step.id).contentJson));
		expect(JSON.stringify(assembled(step.id))).toContain("思考");
	});

	test("unreadable content is recorded and left legacy; the job moves past it", async () => {
		sqlite.run(
			`INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at)
			 VALUES ('odd', 'n1', 'user', '"not an array"', ?)`,
			[NOW],
		);
		await drain();
		expect(envelope("odd").bodyFormat).toBe(1);
		expect(
			sqlite.prepare("SELECT kind FROM narrator_block_diagnostics WHERE message_id = 'odd'").get(),
		).toEqual({ kind: "undecodable" });
		expect(backfill.blockBackfillStatus().convert?.complete).toBe(true);
	});

	test("verify records and repairs block rows that drifted from their envelope", async () => {
		const input = await narratorStore.appendInput("n1", "dual-written");
		sqlite.run("UPDATE narrator_blocks SET payload = ? WHERE message_id = ?", [
			JSON.stringify({ raw: [{ type: "text", text: "drifted" }] }),
			input.id,
		]);
		await drain();
		expect(
			sqlite
				.prepare("SELECT kind FROM narrator_block_diagnostics WHERE message_id = ?")
				.get(input.id),
		).toEqual({ kind: "mismatch" });
		expect(assembled(input.id)).toEqual(JSON.parse(envelope(input.id).contentJson));
		expect(backfill.blockBackfillStatus().verify?.complete).toBe(true);
	});

	test("a paused job runs no slices until resumed", async () => {
		const input = await legacy(() => narratorStore.appendInput("n1", "waiting"));
		backfill.setBlockBackfillPaused(true);
		expect(await backfill.runBlockJobSlice(inline)).toBe(false);
		expect(envelope(input.id).bodyFormat).toBe(1);
		sqlite.run("UPDATE narrator_block_backfill SET paused = 0");
		await drain();
		expect(envelope(input.id).bodyFormat).toBe(2);
	});

	test("content holding reader-only fields mid-element converts and verifies clean", async () => {
		// Written before block storage: `isLatest` between other fields, not after them.
		const card = {
			type: "merge_summary",
			sourceChapterId: "ch1",
			isLatest: true,
			summary: "s",
			modelText: "merged",
		};
		sqlite.run(
			`INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at)
			 VALUES ('card', 'n1', 'system', ?, ?)`,
			[JSON.stringify([card]), NOW],
		);
		await drain();
		expect(envelope("card").bodyFormat).toBe(2);
		// Same content; the rows put reader-only fields last, as the store writes them.
		expect(assembled("card")).toEqual([card]);
		expect(Object.keys(assembled("card")[0] as object).at(-1)).toBe("isLatest");
		expect(sqlite.prepare("SELECT count(*) AS n FROM narrator_block_diagnostics").get()).toEqual({
			n: 0,
		});
		expect(blockSync.auditRecentEnvelopes()).toEqual([]);
	});

	test("legacy envelopes written after convert finished send it back to them", async () => {
		await legacy(() => narratorStore.appendInput("n1", "first"));
		await drain();
		expect(backfill.blockBackfillStatus().convert?.complete).toBe(true);
		// Written while block writes were off: the job does not convert while they are off.
		settings.narratorBlocks.write = false;
		const later = await narratorStore.appendInput("n1", "later");
		backfill.rearmBlockConvert();
		expect(backfill.blockBackfillStatus().convert?.complete).toBe(false);
		expect(await backfill.runBlockJobSlice(inline)).toBe(false);
		expect(envelope(later.id).bodyFormat).toBe(1);
		settings.narratorBlocks.write = true;
		await drain();
		expect(envelope(later.id).bodyFormat).toBe(2);
		expect(assembled(later.id)).toEqual(JSON.parse(envelope(later.id).contentJson));
		// Nothing left to convert: re-arming is a no-op.
		backfill.rearmBlockConvert();
		expect(backfill.blockBackfillStatus().convert?.complete).toBe(true);
	});

	test("slices stop at the envelope limit and resume from the cursor", async () => {
		const ids: string[] = [];
		await legacy(async () => {
			for (let index = 0; index < 7; index++)
				ids.push((await narratorStore.appendInput("n1", `message ${index}`)).id);
		});
		const first = await inline.backfill({
			kind: "blockBackfillSlice",
			afterRowid: 0,
			maxEnvelopes: 3,
			maxSourceBytes: 1 << 22,
			budgetMs: 1000,
		});
		expect(first.envelopes.map((planned) => planned.id)).toEqual(ids.slice(0, 3));
		expect(first.done).toBe(false);
		const rest = await inline.backfill({
			kind: "blockBackfillSlice",
			afterRowid: first.lastRowid,
			maxEnvelopes: 100,
			maxSourceBytes: 1 << 22,
			budgetMs: 1000,
		});
		expect(rest.envelopes.map((planned) => planned.id)).toEqual(ids.slice(3));
		expect(rest.done).toBe(true);
	});
});

function seedLegacy(count: number, text = "small") {
	const insert = sqlite.prepare(
		`INSERT INTO narrator_messages (id,narrator_id,role,content_json,body_format,created_at)
		 VALUES (?,'n1','user',?,1,?)`,
	);
	for (let index = 0; index < count; index++)
		insert.run(`bounded-${index}`, JSON.stringify([{ type: "text", text }]), NOW);
	return runBlockBackfillSlice(sqlite, {
		kind: "blockBackfillSlice",
		afterRowid: 0,
		maxEnvelopes: 100,
		maxSourceBytes: 4 * 1024 * 1024,
		budgetMs: 1000,
	});
}

/** Logical item/commit costs and real zero-delay turns; never assert host wall-clock speed. */
function applyProbe(
	options: {
		job?: "convert" | "verify";
		clockStep?: number;
		commitCost?: number;
		failTransaction?: number;
		onCommit?: (count: number) => void;
		onWait?: (delay: number) => void;
	} = {},
) {
	let now = 10_000;
	let turns = 0;
	let calls = 0;
	const waits: number[] = [];
	const states: Array<{
		cursor: number;
		processed: number;
		complete: number;
		queued: number;
		turns: number;
		started: number;
		ended: number;
	}> = [];
	const time = spyOn(performance, "now").mockImplementation(() => (now += options.clockStep ?? 0));
	const originalTimeout = globalThis.setTimeout;
	const timers = spyOn(globalThis, "setTimeout").mockImplementation(
		new Proxy(originalTimeout, {
			apply(target, receiver, args) {
				const [handler, delay = 0, ...handlerArgs] = args;
				waits.push(Number(delay));
				options.onWait?.(Number(delay));
				return Reflect.apply(target, receiver, [
					() => {
						now += Number(delay);
						if (typeof handler === "function") Reflect.apply(handler, undefined, handlerArgs);
					},
					0,
				]);
			},
		}),
	);
	const transaction = sqlite.transaction.bind(sqlite);
	const transactions = spyOn(sqlite, "transaction").mockImplementation((write) => {
		const call = ++calls;
		const wrapped = transaction(
			new Proxy(write, {
				apply(target, receiver, args) {
					const result = Reflect.apply(target, receiver, args);
					if (call === options.failTransaction) throw new Error("deterministic apply rollback");
					return result;
				},
			}),
		);
		return new Proxy(wrapped, {
			apply(target, receiver, args) {
				const started = now;
				const result = Reflect.apply(target, receiver, args);
				now += options.commitCost ?? 0;
				const state = sqlite
					.prepare("SELECT cursor,processed,complete FROM narrator_block_backfill WHERE job = ?")
					.get(options.job ?? "convert") as { cursor: number; processed: number; complete: number };
				const queued = (
					sqlite.prepare("SELECT count(*) AS n FROM narrator_block_sync_queue").get() as {
						n: number;
					}
				).n;
				states.push({ ...state, queued, turns, started, ended: now });
				originalTimeout(() => {
					turns++;
				}, 0);
				options.onCommit?.(states.length);
				return result;
			},
		});
	});
	return {
		states,
		waits,
		restore() {
			transactions.mockRestore();
			timers.mockRestore();
			time.mockRestore();
		},
	};
}

describe("bounded block apply", () => {
	test("one reader slice commits eight-visited prefixes, including gone and undecodable items, with real turns", async () => {
		const slice = seedLegacy(21);
		const gone = slice.envelopes[2];
		sqlite.run("DELETE FROM narrator_messages WHERE id = ?", [gone.id]);
		slice.envelopes[5].blocks = null;
		let reads = 0;
		const probe = applyProbe();
		try {
			await backfill.runBlockJobSlice({
				...inline,
				backfill: async () => {
					reads++;
					return slice;
				},
			});
		} finally {
			probe.restore();
		}
		expect(reads).toBe(1);
		expect(probe.states.map((state) => state.processed)).toEqual([8, 16, 21]);
		expect(probe.states.map((state) => state.cursor)).toEqual(
			[7, 15, 20].map((index) => slice.envelopes[index].rowid),
		);
		expect(probe.states.map((state) => state.complete)).toEqual([0, 0, 1]);
		expect(probe.states.map((state) => state.turns)).toEqual([0, 1, 2]);
		// The final paced turn checks bounded repair metadata without opening an empty transaction.
		expect(probe.waits).toEqual([0, 0, 0, 0]);
		expect(envelope(slice.envelopes[5].id).bodyFormat).toBe(1);
		expect(
			sqlite
				.prepare("SELECT kind FROM narrator_block_diagnostics WHERE message_id = ?")
				.get(slice.envelopes[5].id),
		).toEqual({ kind: "undecodable" });
	});

	test("time is checked between items, and complete transaction cost shrinks later prefixes", async () => {
		const slice = seedLegacy(12);
		const probe = applyProbe({ clockStep: 25 });
		try {
			await backfill.runBlockJobSlice({ ...inline, backfill: async () => slice });
		} finally {
			probe.restore();
		}
		expect(probe.states.map((state) => state.processed)).toEqual(
			Array.from({ length: 12 }, (_, index) => index + 1),
		);
		expect(probe.waits.slice(1).every((wait) => wait > 0)).toBe(true);
		expect(probe.states.at(-1)?.complete).toBe(1);
		backfill.resetBlockJobPacingForTests();
		sqlite.run("DELETE FROM narrator_messages");
		sqlite.run("DELETE FROM narrator_block_backfill");
		const another = seedLegacy(21);
		const commits = applyProbe({ commitCost: 80 });
		try {
			await backfill.runBlockJobSlice({ ...inline, backfill: async () => another });
		} finally {
			commits.restore();
		}
		expect(commits.states.slice(0, 4).map((state) => state.processed)).toEqual([8, 12, 14, 15]);
		expect(commits.states.at(-1)?.processed).toBe(21);
	});

	test("one indivisible slow item reports its cost and full transaction overshoot", async () => {
		const slice = seedLegacy(1);
		const warnings = spyOn(logger, "warn");
		const probe = applyProbe({ clockStep: 80 });
		let logs: unknown[] = [];
		try {
			await backfill.runBlockJobSlice({ ...inline, backfill: async () => slice });
			logs = [...warnings.mock.calls];
		} finally {
			probe.restore();
			warnings.mockRestore();
		}
		expect(logs).toContainEqual([
			"Slow block backfill transaction",
			expect.objectContaining({
				job: "convert",
				visited: 1,
				maxItemMs: 80,
				nextVisited: 4,
				sourceBytes: slice.envelopes[0].sourceBytes,
				overshootMs: expect.any(Number),
				elapsedMs: expect.any(Number),
			}),
		]);
		expect(probe.states.at(-1)?.complete).toBe(1);
	});

	test("UTF-8 prepared bytes stop a batch before the next item, and one oversized item still progresses", async () => {
		const slice = seedLegacy(3, "界".repeat(10_000));
		expect(
			slice.envelopes.every(
				(item) => item.sourceBytes > 64 * 1024 && item.sourceBytes < 128 * 1024,
			),
		).toBe(true);
		const probe = applyProbe();
		try {
			await backfill.runBlockJobSlice({ ...inline, backfill: async () => slice });
		} finally {
			probe.restore();
		}
		expect(probe.states.map((state) => state.processed)).toEqual([1, 2, 3]);
		backfill.resetBlockJobPacingForTests();
		sqlite.run("DELETE FROM narrator_messages");
		sqlite.run("DELETE FROM narrator_block_backfill");
		const large = seedLegacy(2, "界".repeat(20_000));
		expect(large.envelopes[0].sourceBytes).toBeGreaterThan(128 * 1024);
		const oversize = applyProbe();
		try {
			await backfill.runBlockJobSlice({ ...inline, backfill: async () => large });
		} finally {
			oversize.restore();
		}
		expect(oversize.states.map((state) => state.processed)).toEqual([1, 2]);
		expect(oversize.states.at(-1)?.complete).toBe(1);
	});

	test("failed prefix rolls back its rows and cursor, then resumes from the last committed prefix", async () => {
		const slice = seedLegacy(21);
		const probe = applyProbe({ failTransaction: 2 });
		try {
			await expect(
				backfill.runBlockJobSlice({ ...inline, backfill: async () => slice }),
			).rejects.toThrow("deterministic apply rollback");
		} finally {
			probe.restore();
		}
		expect(backfill.blockBackfillStatus().convert).toMatchObject({
			cursor: slice.envelopes[7].rowid,
			processed: 8,
			complete: false,
		});
		expect(envelope(slice.envelopes[8].id).bodyFormat).toBe(1);
		const resumed: number[] = [];
		const retry = applyProbe();
		try {
			await backfill.runBlockJobSlice({
				...inline,
				backfill: async (params) => {
					resumed.push(params.afterRowid);
					return inline.backfill(params);
				},
			});
		} finally {
			retry.restore();
		}
		expect(resumed).toEqual([slice.envelopes[7].rowid]);
		expect(backfill.blockBackfillStatus().convert).toMatchObject({ processed: 21, complete: true });
	});

	test.each([
		"paused",
		"cursor",
	] as const)("a %s change between turns discards the prepared tail", async (change) => {
		const slice = seedLegacy(17);
		const probe = applyProbe({
			onCommit: (count) => {
				if (count === 1)
					sqlite.run(
						change === "paused"
							? "UPDATE narrator_block_backfill SET paused = 1 WHERE job = 'convert'"
							: "UPDATE narrator_block_backfill SET cursor = 0 WHERE job = 'convert'",
					);
			},
		});
		try {
			await backfill.runBlockJobSlice({ ...inline, backfill: async () => slice });
		} finally {
			probe.restore();
		}
		expect(envelope(slice.envelopes[8].id).bodyFormat).toBe(1);
		expect(backfill.blockBackfillStatus().convert).toMatchObject({ processed: 8, complete: false });
	});

	test("changed-plan repairs use paced bounded transactions and their durable queue survives rollback", async () => {
		const slice = seedLegacy(10);
		sqlite.run("UPDATE narrator_messages SET content_json = ?", [
			JSON.stringify([{ type: "text", text: "current" }]),
		]);
		const probe = applyProbe({ failTransaction: 4 });
		try {
			await expect(
				backfill.runBlockJobSlice({ ...inline, backfill: async () => slice }),
			).rejects.toThrow("deterministic apply rollback");
		} finally {
			probe.restore();
		}
		// Recovery reserves a full byte budget per target: the first repair commits one,
		// and the second repair rolls back without dropping any of the remaining nine.
		expect(probe.states.map((state) => state.queued)).toEqual([8, 10, 9]);
		expect(probe.states.map((state) => state.processed)).toEqual([8, 10, 10]);
		expect(sqlite.prepare("SELECT count(*) AS n FROM narrator_block_sync_queue").get()).toEqual({
			n: 9,
		});
		expect(backfill.blockBackfillStatus().convert).toMatchObject({ complete: true, processed: 10 });
		backfill.resetBlockJobPacingForTests();
		const retry = applyProbe();
		try {
			expect(
				await backfill.runBlockJobSlice({
					...inline,
					backfill: async () => {
						throw new Error("already converted");
					},
				}),
			).toBe(true);
		} finally {
			retry.restore();
		}
		expect(sqlite.prepare("SELECT count(*) AS n FROM narrator_block_sync_queue").get()).toEqual({
			n: 0,
		});
		for (const item of slice.envelopes)
			expect(assembled(item.id)).toEqual([{ type: "text", text: "current" }]);
	});

	test("repair metadata pages reach debt beyond skipped entries and reconsider earlier skips", async () => {
		const insert = sqlite.prepare(
			`INSERT INTO narrator_messages (id,narrator_id,role,content_json,body_format,created_at)
			 VALUES (?,'n1','user',?,1,?)`,
		);
		for (let index = 0; index < 120; index++) {
			const id = `queue-skip-${index}`;
			insert.run(id, JSON.stringify([{ type: "text", text: "legacy skip" }]), NOW);
			sqlite.run("INSERT INTO narrator_block_sync_queue (message_id) VALUES (?)", [id]);
		}
		const current = [{ type: "text", text: "界".repeat(20_000) }];
		insert.run("queue-target", JSON.stringify(current), NOW);
		sqlite.run("UPDATE narrator_messages SET body_format = 2 WHERE id = 'queue-target'");
		const target = sqlite
			.prepare("SELECT rowid FROM narrator_messages WHERE id = 'queue-target'")
			.get() as { rowid: number };
		backfill.blockBackfillStatus();
		sqlite.run("UPDATE narrator_block_backfill SET complete = 1,cursor = ? WHERE job = 'convert'", [
			target.rowid,
		]);
		sqlite.run("UPDATE narrator_block_backfill SET paused = 1 WHERE job IN ('verify','reindex')");
		const reads: Array<{ sql: string; limit: number; rows: number }> = [];
		const allSpies: Array<{ mockRestore(): void }> = [];
		const prepare = sqlite.prepare.bind(sqlite);
		const queries = spyOn(sqlite, "prepare").mockImplementation(
			<Row, Params extends SQLQueryBindings | SQLQueryBindings[]>(sql: string, params?: Params) => {
				const statement = prepare<Row, Params>(sql, params);
				if (sql.includes("WITH pending AS MATERIALIZED")) {
					const all = statement.all.bind(statement);
					allSpies.push(
						spyOn(statement, "all").mockImplementation((...bindings) => {
							const rows = all(...bindings);
							reads.push({ sql, limit: Number(bindings[1]), rows: rows.length });
							return rows;
						}),
					);
				}
				return statement;
			},
		);
		const probe = applyProbe();
		try {
			// One finite slice scans a hundred skips, and still reports work for the next page.
			expect(await backfill.runBlockJobSlice(inline)).toBe(true);
			expect(reads.reduce((count, read) => count + read.rows, 0)).toBe(100);
			expect(assembled("queue-target")).toEqual([]);
			expect(await backfill.runBlockJobSlice(inline)).toBe(true);
			expect(assembled("queue-target")).toEqual(current);
			// This entry was skipped in the first page, but remains durable and is rechecked.
			sqlite.run("UPDATE narrator_messages SET body_format = 2 WHERE id = 'queue-skip-0'");
			expect(await backfill.runBlockJobSlice(inline)).toBe(true);
			expect(assembled("queue-skip-0")).toEqual([{ type: "text", text: "legacy skip" }]);
			// End-of-pass all-skip tails let the runner stop instead of cycling forever.
			expect(await backfill.runBlockJobSlice(inline)).toBe(false);
			sqlite.run("UPDATE narrator_messages SET body_format = 2 WHERE id = 'queue-skip-1'");
			expect(await backfill.runBlockJobSlice(inline)).toBe(true);
			expect(assembled("queue-skip-1")).toEqual([{ type: "text", text: "legacy skip" }]);
		} finally {
			probe.restore();
			queries.mockRestore();
			for (const spy of allSpies) spy.mockRestore();
		}
		expect(reads.length).toBeGreaterThan(1);
		for (const read of reads) {
			expect(read.limit).toBeGreaterThan(0);
			expect(read.limit).toBeLessThanOrEqual(8);
			expect(read.rows).toBeLessThanOrEqual(read.limit);
			expect(read.sql).not.toMatch(/\b(?:content_json|length|cast)\b/i);
		}
	});

	test("shutdown after stale-plan flips leaves repair debt for a fresh lifecycle", async () => {
		const slice = seedLegacy(3);
		sqlite.run("UPDATE narrator_messages SET content_json = ?", [
			JSON.stringify([{ type: "text", text: "after restart" }]),
		]);
		let stopping: Promise<void> | undefined;
		const probe = applyProbe({
			onCommit: (count) => {
				if (count === 1)
					stopping = backfill.stopBlockBackgroundJobs({ deadlineAt: Date.now() + 1000 });
			},
		});
		try {
			await expect(
				backfill.runBlockJobSlice({ ...inline, backfill: async () => slice }),
			).rejects.toThrow();
			await stopping;
		} finally {
			probe.restore();
		}
		expect(probe.states).toHaveLength(1);
		expect(sqlite.prepare("SELECT count(*) AS n FROM narrator_block_sync_queue").get()).toEqual({
			n: 3,
		});
		backfill.resetBlockJobPacingForTests();
		const retry = applyProbe();
		try {
			await backfill.runBlockJobSlice(inline);
		} finally {
			retry.restore();
		}
		for (const item of slice.envelopes)
			expect(assembled(item.id)).toEqual([{ type: "text", text: "after restart" }]);
		expect(backfill.blockBackfillStatus().convert).toMatchObject({
			complete: true,
			paused: false,
			processed: 3,
		});
	});

	test("shutdown aborts pacing before another prefix and drains waiting callers", async () => {
		const slice = seedLegacy(17);
		let stopping: Promise<void> | undefined;
		let shutdownRequested = false;
		const probe = applyProbe({
			commitCost: 100,
			onWait: (delay) => {
				if (delay > 0 && !shutdownRequested) {
					shutdownRequested = true;
					queueMicrotask(() => {
						stopping = backfill.stopBlockBackgroundJobs({ deadlineAt: Date.now() + 1000 });
					});
				}
			},
		});
		try {
			await expect(
				backfill.runBlockJobSlice({ ...inline, backfill: async () => slice }),
			).rejects.toThrow();
			await stopping;
		} finally {
			probe.restore();
		}
		expect(stopping).toBeDefined();
		expect(probe.states).toHaveLength(1);
		expect(backfill.blockBackfillStatus().convert).toMatchObject({
			complete: false,
			paused: false,
			processed: 8,
		});
	});

	test("concurrent readers share pacing and a stale cursor cannot write twice", async () => {
		const slice = seedLegacy(17);
		const probe = applyProbe({ commitCost: 10 });
		try {
			await Promise.all(
				[1, 2].map(() => backfill.runBlockJobSlice({ ...inline, backfill: async () => slice })),
			);
		} finally {
			probe.restore();
		}
		expect(backfill.blockBackfillStatus().convert).toMatchObject({ complete: true, processed: 17 });
		for (let index = 1; index < probe.states.length; index++)
			expect(probe.states[index].started - probe.states[index - 1].ended).toBeGreaterThanOrEqual(
				30,
			);
	});

	test("verify preserves ordered matching and mismatched candidates when applying prefixes", async () => {
		const source = seedLegacy(17);
		const convert = applyProbe();
		try {
			await backfill.runBlockJobSlice({ ...inline, backfill: async () => source });
		} finally {
			convert.restore();
		}
		for (const index of [3, 9, 16])
			sqlite.run("UPDATE narrator_blocks SET payload = ? WHERE message_id = ?", [
				JSON.stringify({ raw: [{ type: "text", text: "drifted" }] }),
				source.envelopes[index].id,
			]);
		const slice = await inline.verify({
			kind: "blockVerifySlice",
			afterRowid: 0,
			maxEnvelopes: 100,
			maxSourceBytes: 4 * 1024 * 1024,
			budgetMs: 1000,
		});
		expect(slice.visited.map((item) => item.mismatched)).toEqual(
			source.envelopes.map((_, index) => [3, 9, 16].includes(index)),
		);
		const probe = applyProbe({ job: "verify" });
		try {
			await backfill.runBlockJobSlice({ ...inline, verify: async () => slice });
		} finally {
			probe.restore();
		}
		expect(probe.states.map((state) => state.processed)).toEqual([8, 16, 17]);
		expect(probe.states.map((state) => state.cursor)).toEqual(
			[7, 15, 16].map((index) => source.envelopes[index].rowid),
		);
		expect(probe.states.map((state) => state.complete)).toEqual([0, 0, 1]);
		for (const item of source.envelopes)
			expect(assembled(item.id)).toEqual(JSON.parse(envelope(item.id).contentJson));
	});

	test("a reader without ordered verify candidates fails before advancing", async () => {
		const source = seedLegacy(1);
		const convert = applyProbe();
		try {
			await backfill.runBlockJobSlice({ ...inline, backfill: async () => source });
		} finally {
			convert.restore();
		}
		const slice = await inline.verify({
			kind: "blockVerifySlice",
			afterRowid: 0,
			maxEnvelopes: 100,
			maxSourceBytes: 4 * 1024 * 1024,
			budgetMs: 1000,
		});
		const missing = { ...slice, visited: undefined } as unknown as typeof slice;
		await expect(
			backfill.runBlockJobSlice({ ...inline, verify: async () => missing }),
		).rejects.toThrow("missing ordered candidates");
		expect(backfill.blockBackfillStatus().verify).toMatchObject({
			complete: false,
			cursor: 0,
			processed: 0,
		});
	});
});

describe("block reindex", () => {
	/** Every block id the block index finds for `term`. */
	const indexed = (term: string) =>
		(
			sqlite
				.prepare(
					`SELECT b.id FROM narrator_blocks_fts JOIN narrator_blocks b ON b.rowid = narrator_blocks_fts.rowid
					 WHERE narrator_blocks_fts MATCH ? ORDER BY b.id`,
				)
				.all(`"${term}"`) as Array<{ id: string }>
		).map((row) => row.id);

	async function conversation(): Promise<string> {
		await narratorStore.appendInput("n1", "where are the gooseberries");
		const step = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
		await narratorStore.writeStepItem(step.id, "n1", {
			type: "text",
			id: "t1",
			text: "The gooseberries are in the cellar.",
			completed: true,
			outputIndex: 0,
		});
		const toolCallId = await narratorStore.writeStepItem(step.id, "n1", {
			type: "tool_use",
			id: "c1",
			name: "Grep",
			input: { pattern: "quince" },
			outputIndex: 1,
		});
		await narratorStore.settleTool(
			"c1",
			{ output: "jam/quince.md", status: "success" },
			step.id,
			toolCallId,
		);
		// The store queues the search text; the index job writes it.
		await blockIndex.drainBlockIndexQueue(readIndex);
		return step.id;
	}

	test("runs after verify and leaves every revision where it was", async () => {
		await conversation();
		const revisions = () =>
			sqlite
				.prepare("SELECT id, body_revision, state_revision FROM narrator_messages ORDER BY id")
				.all();
		const before = revisions();
		const history = historyRevision();
		await drain();
		const status = backfill.blockBackfillStatus();
		expect([status.convert?.complete, status.verify?.complete, status.reindex?.complete]).toEqual([
			true,
			true,
			true,
		]);
		expect(status.reindex?.processed).toBe(2);
		expect(revisions()).toEqual(before);
		expect(historyRevision()).toBe(history);
	});

	test("rebuilds a cleared block index as the store wrote it", async () => {
		await conversation();
		const terms = ["gooseberries", "cellar", "quince", "Grep"];
		const written = terms.map(indexed);
		expect(written.every((ids) => ids.length > 0)).toBe(true);
		await drain();
		sqlite.run("DELETE FROM narrator_blocks_fts");
		expect(terms.map(indexed)).toEqual(terms.map(() => []));
		sqlite.run("UPDATE narrator_block_backfill SET cursor = 0, complete = 0 WHERE job = 'reindex'");
		await drain();
		expect(terms.map(indexed)).toEqual(written);
	});

	test("reaches rows-only envelopes too", async () => {
		const stepId = await conversation();
		await drain();
		sqlite.run(
			"UPDATE narrator_messages SET content_json = '[]', body_rows_only = 1 WHERE id = ?",
			[stepId],
		);
		sqlite.run("DELETE FROM narrator_blocks_fts");
		sqlite.run("UPDATE narrator_block_backfill SET cursor = 0, complete = 0 WHERE job = 'reindex'");
		await drain();
		expect(indexed("quince")).toHaveLength(1);
		expect(indexed("cellar")).toHaveLength(1);
	});

	test("rows-only output replacement and explicit full reindex keep all tool text and assets current", async () => {
		const stepId = await conversation();
		await drain();
		sqlite.run(
			"UPDATE narrator_messages SET content_json = '[]', body_rows_only = 1 WHERE id = ?",
			[stepId],
		);
		const tool = sqlite
			.prepare(
				"SELECT id, payload, state, revision FROM narrator_blocks WHERE message_id = ? AND kind = 'tool'",
			)
			.get(stepId) as { id: string; payload: string; state: string | null; revision: number };
		sqlite.run("UPDATE narrator_tool_calls SET output_json = ? WHERE message_id = ?", [
			JSON.stringify({
				_text: "replacement marmalade",
				_images: [{ imageId: "reindex-image", mediaType: "image/png", uploadNarratorId: "n1" }],
			}),
			stepId,
		]);
		blockSync.flushChangedEnvelopeTargets([stepId]);
		await blockIndex.drainBlockIndexQueue(readIndex);
		expect(indexed("jam/quince.md")).toEqual([]);
		expect(indexed("replacement marmalade")).toEqual([tool.id]);
		expect(
			sqlite
				.prepare("SELECT id, payload, state, revision FROM narrator_blocks WHERE id = ?")
				.get(tool.id),
		).toEqual(tool);
		const written = ["cellar", "quince", "replacement marmalade"].map(indexed);
		expect(written.every((ids) => ids.length === 1)).toBe(true);
		sqlite.run("DELETE FROM narrator_blocks_fts");
		blockSync.reindexEnvelope(stepId);
		await blockIndex.drainBlockIndexQueue(readIndex);
		expect(["cellar", "quince", "replacement marmalade"].map(indexed)).toEqual(written);
		sqlite.run("DELETE FROM narrator_blocks_fts");
		sqlite.run("UPDATE narrator_block_backfill SET cursor = 0, complete = 0 WHERE job = 'reindex'");
		await drain();
		expect(["cellar", "quince", "replacement marmalade"].map(indexed)).toEqual(written);
		expect(
			sqlite
				.prepare("SELECT asset_id, role FROM narrator_block_assets WHERE block_id = ?")
				.all(tool.id),
		).toEqual([{ asset_id: "reindex-image", role: "tool_image" }]);
		expect(envelope(stepId).contentJson).toBe("[]");
	});
	const reindexParams = {
		kind: "blockReindexSlice" as const,
		afterRowid: 0,
		maxEnvelopes: 100,
		maxSourceBytes: 1 << 22,
		maxIndexChars: 1 << 20,
		budgetMs: 1000,
	};

	test("the worker computes every missing block's text; none falls back to the main thread", async () => {
		const stepId = await conversation();
		sqlite.run("DELETE FROM narrator_blocks_fts");
		const slice = runBlockReindexSlice(sqlite, reindexParams);
		expect(slice.done).toBe(true);
		expect(slice.envelopes.map((envelope) => envelope.resync)).toEqual([false, false]);
		const step = slice.envelopes.find((envelope) => envelope.id === stepId);
		expect(step?.blocks.map((block) => /cellar|quince/.test(block.text ?? ""))).toEqual([
			true,
			true,
		]);
	});

	/** Rows of the block index's own storage: any write to the index adds or changes some. */
	const indexStorage = () =>
		sqlite.prepare("SELECT id, block FROM narrator_blocks_fts_data ORDER BY id").all();

	test("entries already in the index are left as they are", async () => {
		await conversation();
		const before = indexStorage();
		const slice = runBlockReindexSlice(sqlite, reindexParams);
		expect(
			slice.envelopes.flatMap((envelope) => envelope.blocks.map((block) => block.text)),
		).toEqual([null, null, null]);
		await drain();
		expect(backfill.blockBackfillStatus().reindex).toMatchObject({ complete: true, processed: 2 });
		expect(indexStorage()).toEqual(before);
	});

	test("a block missing from the index regains its entry; its neighbours are left", async () => {
		const stepId = await conversation();
		await drain();
		const tool = sqlite
			.prepare("SELECT rowid FROM narrator_blocks WHERE message_id = ? AND kind = 'tool'")
			.get(stepId) as { rowid: number };
		sqlite.run("DELETE FROM narrator_blocks_fts WHERE rowid = ?", [tool.rowid]);
		expect(indexed("quince")).toEqual([]);
		const slice = runBlockReindexSlice(sqlite, reindexParams);
		const step = slice.envelopes.find((envelope) => envelope.id === stepId);
		expect(step?.blocks.map((block) => block.text === null)).toEqual([true, false]);
		sqlite.run(
			"UPDATE narrator_block_backfill SET cursor = 0, complete = 0, processed = 0 WHERE job = 'reindex'",
		);
		await drain();
		expect(indexed("quince")).toHaveLength(1);
		expect(indexed("cellar")).toHaveLength(1);
	});

	test("an envelope rewritten after the read is reindexed from what it holds now", async () => {
		const stepId = await conversation();
		await drain();
		sqlite.run("DELETE FROM narrator_blocks_fts");
		sqlite.run("UPDATE narrator_block_backfill SET cursor = 0, complete = 0 WHERE job = 'reindex'");
		let raced = false;
		const racing = {
			...inline,
			reindex: async (params: Parameters<typeof runBlockReindexSlice>[1]) => {
				const slice = await inline.reindex(params);
				if (!raced) {
					raced = true;
					sqlite.run(
						`UPDATE narrator_blocks SET revision = revision + 1,
							payload = json_set(payload, '$.raw[0].text', 'The persimmons are in the attic.')
						 WHERE message_id = ? AND kind = 'output'`,
						[stepId],
					);
				}
				return slice;
			},
		};
		while (await backfill.runBlockJobSlice(racing));
		await blockIndex.drainBlockIndexQueue(readIndex);
		expect(indexed("persimmons")).toHaveLength(1);
		expect(indexed("cellar")).toEqual([]);
		expect(indexed("quince")).toHaveLength(1);
	});

	test("a ledger change synced after the read is reindexed from what it holds now", async () => {
		await conversation();
		await drain();
		sqlite.run("DELETE FROM narrator_blocks_fts");
		sqlite.run("UPDATE narrator_block_backfill SET cursor = 0, complete = 0 WHERE job = 'reindex'");
		let raced = false;
		const racing = {
			...inline,
			reindex: async (params: Parameters<typeof runBlockReindexSlice>[1]) => {
				const slice = await inline.reindex(params);
				if (!raced) {
					raced = true;
					// The tool's block row stays as read; only the ledger moves, and its sync runs.
					sqlite.run("UPDATE narrator_tool_calls SET output_json = ? WHERE tool_use_id = 'c1'", [
						JSON.stringify("jam/medlar.md"),
					]);
					blockSync.flushChangedEnvelopes();
				}
				return slice;
			},
		};
		while (await backfill.runBlockJobSlice(racing));
		await blockIndex.drainBlockIndexQueue(readIndex);
		expect(indexed("medlar")).toHaveLength(1);
		expect(indexed("jam/quince")).toEqual([]);
	});

	/** Five envelopes (six blocks) whose index was lost, with reindex set to start over. */
	async function lostIndex(): Promise<void> {
		await conversation();
		for (const text of ["damsons", "greengages", "loquats"])
			await narratorStore.appendInput("n1", `where are the ${text}`);
		await drain();
		sqlite.run("DELETE FROM narrator_blocks_fts");
		sqlite.run(
			"UPDATE narrator_block_backfill SET cursor = 0, complete = 0, processed = 0 WHERE job = 'reindex'",
		);
	}

	/** A reader after which every clock reading is 60ms on: each write takes the whole budget. */
	function slowWrites() {
		let clock: ReturnType<typeof spyOn> | undefined;
		const reader = {
			...inline,
			reindex: async (params: Parameters<typeof runBlockReindexSlice>[1]) => {
				const slice = await inline.reindex(params);
				let now = performance.now();
				clock ??= spyOn(performance, "now").mockImplementation(() => (now += 60));
				return slice;
			},
		};
		return { reader, restore: () => clock?.mockRestore() };
	}

	const indexedOnce = ["cellar", "quince", "damsons", "greengages", "loquats"];

	test("a slice is written a block at a time, in short transactions", async () => {
		await lostIndex();
		blockSync.stopBlockSyncSweep();
		const slow = slowWrites();
		const transaction = sqlite.transaction.bind(sqlite);
		const origins: string[] = [];
		const transactions = spyOn(sqlite, "transaction").mockImplementation((write) => {
			if (origins.length < 12)
				origins.push(
					(new Error("SQLite transaction call site").stack ?? "Stack unavailable").slice(0, 2048),
				);
			return transaction(write);
		});
		let count = 0;
		try {
			expect(await backfill.runBlockJobSlice(slow.reader)).toBe(true);
			count = transactions.mock.calls.length;
		} finally {
			slow.restore();
			transactions.mockRestore();
		}
		// Five envelopes, six blocks: the step's two blocks went in two transactions.
		expect(count, `SQLite transaction call sites:\n${origins.join("\n\n")}`).toBe(6);
		expect(backfill.blockBackfillStatus().reindex).toMatchObject({ complete: true, processed: 5 });
		for (const term of indexedOnce) expect(indexed(term)).toHaveLength(1);
	}, 20_000);

	test("a transaction stops at its index text budget, which grows while commits stay short", async () => {
		const fruits = ["apricots", "bilberries", "cloudberries", "dewberries", "elderberries"];
		for (const fruit of fruits)
			await narratorStore.appendInput("n1", `${fruit} ${"x".repeat(20_000)}`);
		await drain();
		sqlite.run("DELETE FROM narrator_blocks_fts");
		sqlite.run(
			"UPDATE narrator_block_backfill SET cursor = 0, complete = 0, processed = 0 WHERE job = 'reindex'",
		);
		backfill.resetBlockJobPacingForTests();
		let clock: ReturnType<typeof spyOn> | undefined;
		const frozen = {
			...inline,
			reindex: async (params: Parameters<typeof runBlockReindexSlice>[1]) => {
				const slice = await inline.reindex(params);
				// Every transaction takes no time: only the text budget ends one.
				clock ??= spyOn(performance, "now").mockReturnValue(performance.now());
				return slice;
			},
		};
		const transactions = spyOn(sqlite, "transaction");
		let count = 0;
		try {
			expect(await backfill.runBlockJobSlice(frozen)).toBe(true);
			count = transactions.mock.calls.length;
		} finally {
			clock?.mockRestore();
			transactions.mockRestore();
		}
		// 32K characters: two 20K blocks. Grown to 40K, which two more do not reach: the other
		// three. Without the growth the last one would take a third transaction.
		expect(count).toBe(2);
		expect(backfill.blockBackfillStatus().reindex).toMatchObject({ complete: true, processed: 5 });
		for (const fruit of fruits) expect(indexed(fruit)).toHaveLength(1);
	});

	test("pausing between a slice's transactions stops it where it is", async () => {
		await lostIndex();
		const slow = slowWrites();
		const transaction = sqlite.transaction.bind(sqlite);
		let calls = 0;
		const transactions = spyOn(sqlite, "transaction").mockImplementation((write) => {
			if (++calls === 3)
				sqlite.run("UPDATE narrator_block_backfill SET paused = 1 WHERE job = 'reindex'");
			return transaction(write);
		});
		try {
			expect(await backfill.runBlockJobSlice(slow.reader)).toBe(true);
		} finally {
			slow.restore();
			transactions.mockRestore();
		}
		// The input and the step's first block were written; the cursor stays before the step.
		expect(backfill.blockBackfillStatus().reindex).toMatchObject({
			complete: false,
			paused: true,
			processed: 1,
		});
		expect(await backfill.runBlockJobSlice(inline)).toBe(false);
		sqlite.run("UPDATE narrator_block_backfill SET paused = 0 WHERE job = 'reindex'");
		await drain();
		expect(backfill.blockBackfillStatus().reindex).toMatchObject({ complete: true, processed: 5 });
		for (const term of indexedOnce) expect(indexed(term)).toHaveLength(1);
	}, 20_000);

	test("a slice stops at its index text budget, and a queued envelope is left to the sync", async () => {
		const stepId = await conversation();
		sqlite.run("DELETE FROM narrator_blocks_fts");
		const first = runBlockReindexSlice(sqlite, { ...reindexParams, maxIndexChars: 1 });
		expect(first.envelopes).toHaveLength(1);
		expect(first.done).toBe(false);
		sqlite.run("INSERT OR IGNORE INTO narrator_block_sync_queue (message_id) VALUES (?)", [stepId]);
		const slice = runBlockReindexSlice(sqlite, reindexParams);
		expect(slice.envelopes.find((envelope) => envelope.id === stepId)).toMatchObject({
			resync: true,
			blocks: [],
		});
	});
});

const workerFailures: Array<[string, Error]> = [
	["disabled", new workerPool.WorkersUnavailableError("disabled_by_env")],
	["zero concurrency", new workerPool.WorkersUnavailableError("concurrency_zero")],
	["creation failure", new workerPool.WorkersUnavailableError("worker_spawn_failed")],
	["ready failure", new workerPool.WorkersUnavailableError("worker_unavailable")],
	["exit", new Error("database worker closed")],
	["timeout", new workerPool.DbReadTaskTimeoutError("database read task timed out")],
	["cancel", new Error("database read task aborted")],
	["pool shutdown", new workerPool.WorkersUnavailableError("pool_shutdown")],
];

/** No failure category authorizes decoding a slice on the service thread. */
describe("production block readers fail closed", () => {
	for (const [job, kind, core] of [
		["convert", "blockBackfillSlice", "runBlockBackfillSlice"],
		["verify", "blockVerifySlice", "runBlockVerifySlice"],
		["reindex", "blockReindexSlice", "runBlockReindexSlice"],
	] as const) {
		for (const [failure, error] of workerFailures) {
			test(`${job}: ${failure} preserves the durable cursor without inline decoding`, async () => {
				for (const name of ["convert", "verify", "reindex"])
					sqlite.run(
						`INSERT INTO narrator_block_backfill (job, cursor, processed, complete, updated_at)
						 VALUES (?, 17, 3, ?, ?)`,
						[name, name === job ? 0 : 1, NOW],
					);
				sqlite.run(
					`INSERT INTO narrator_messages
					 (rowid, id, narrator_id, role, content_json, body_format, created_at)
					 VALUES (100, 'pending', 'n1', 'user', ?, ?, ?)`,
					[
						JSON.stringify([{ type: "text", text: "pending content" }]),
						job === "convert" ? 1 : 2,
						NOW,
					],
				);
				const before = sqlite.query("SELECT * FROM narrator_messages WHERE id = 'pending'").get();
				const read = spyOn(workerPool, "runReadTask").mockRejectedValue(error);
				const decode = spyOn(workerCore, core);
				const transactions = spyOn(sqlite, "transaction");
				try {
					await expect(backfill.runBlockJobSlice()).rejects.toBe(error);
					expect(read).toHaveBeenCalledTimes(1);
					expect(read.mock.calls[0]?.[1]).toMatchObject({ kind, afterRowid: 17 });
					expect(decode).not.toHaveBeenCalled();
					expect(transactions).not.toHaveBeenCalled();
					expect(backfill.blockBackfillStatus()[job]).toMatchObject({
						cursor: 17,
						processed: 3,
						complete: false,
					});
					expect(
						sqlite.query("SELECT * FROM narrator_messages WHERE id = 'pending'").get(),
					).toEqual(before);
				} finally {
					read.mockRestore();
					decode.mockRestore();
					transactions.mockRestore();
				}
			});
		}
	}

	for (const [failure, error] of workerFailures) {
		test(`index: ${failure} keeps queued work without inline decoding`, async () => {
			await narratorStore.appendInput("n1", "queued index text");
			const before = sqlite
				.query("SELECT * FROM narrator_block_index_queue ORDER BY block_id")
				.all();
			expect(before.length).toBeGreaterThan(0);
			const read = spyOn(workerPool, "runReadTask").mockRejectedValue(error);
			const decode = spyOn(workerCore, "runBlockIndexQueueSlice");
			const transactions = spyOn(sqlite, "transaction");
			const warn = spyOn(logger, "warn").mockImplementation(() => {});
			try {
				await blockIndex.runBlockIndex();
				expect(read).toHaveBeenCalledTimes(1);
				expect(read.mock.calls[0]?.[1]).toMatchObject({ kind: "blockIndexQueueSlice" });
				expect(decode).not.toHaveBeenCalled();
				expect(transactions).not.toHaveBeenCalled();
				expect(
					sqlite.query("SELECT * FROM narrator_block_index_queue ORDER BY block_id").all(),
				).toEqual(before);
			} finally {
				read.mockRestore();
				decode.mockRestore();
				transactions.mockRestore();
				warn.mockRestore();
				blockIndex.resetBlockIndexForTests();
			}
		});
	}

	test("a failed index slice schedules only a bounded delayed retry", async () => {
		await narratorStore.appendInput("n1", "retryable index text");
		const read = spyOn(workerPool, "runReadTask").mockRejectedValue(
			new workerPool.WorkersUnavailableError("disabled_by_env"),
		);
		const timers = spyOn(globalThis, "setTimeout");
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		blockIndex.setBlockIndexAutoRunForTests(true);
		try {
			await blockIndex.runBlockIndex();
			expect(read).toHaveBeenCalledTimes(1);
			expect(owedForRetry()).toBeGreaterThan(0);
			expect(timers.mock.calls).toHaveLength(1);
			expect(timers.mock.calls[0]?.[1]).toBe(30_000);
		} finally {
			blockIndex.setBlockIndexAutoRunForTests(false);
			read.mockRestore();
			timers.mockRestore();
			warn.mockRestore();
			blockIndex.resetBlockIndexForTests();
		}
	});

	function owedForRetry(): number {
		return sqlite.query("SELECT block_id FROM narrator_block_index_queue").all().length;
	}

	test("the background backfill stops on worker failure with its cursor intact", async () => {
		const error = new workerPool.WorkersUnavailableError("disabled_by_env");
		const read = spyOn(workerPool, "runReadTask").mockRejectedValue(error);
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			backfill.startBlockBackfill();
			const deadline = Date.now() + 2_000;
			while (backfill.blockBackfillStatus().running && Date.now() < deadline) await Bun.sleep(1);
			expect(backfill.blockBackfillStatus()).toMatchObject({
				running: false,
				convert: { cursor: 0, processed: 0, complete: false },
			});
			expect(read).toHaveBeenCalledTimes(1);
			expect(warn).toHaveBeenCalledWith("Block backfill stopped; it resumes at the next start", {
				error: String(error),
			});
		} finally {
			read.mockRestore();
			warn.mockRestore();
		}
	});
});

test("background shutdown drains an active slice without changing persisted pause state", async () => {
	sqlite.run(
		"INSERT INTO narrator_messages (id,narrator_id,role,content_json,body_format,created_at) VALUES ('shutdown-source','n1','assistant','[{\"type\":\"text\",\"text\":\"source\"}]',1,?)",
		[NOW],
	);
	let release: () => void = () => {
		throw new Error("Slice was not started");
	};
	const pending = backfill.runBlockJobSlice({
		...inline,
		backfill: (params) =>
			new Promise((resolve) => {
				release = () => resolve(runBlockBackfillSlice(sqlite, params));
			}),
	});
	const stored = () =>
		sqlite
			.prepare("SELECT job,paused,cursor,complete FROM narrator_block_backfill ORDER BY job")
			.all();
	const before = stored();
	const stopping = backfill.stopBlockBackgroundJobs({ deadlineAt: Date.now() + 1000 });
	release();
	await expect(pending).rejects.toThrow();
	await stopping;
	expect(stored()).toEqual(before);
	expect(envelope("shutdown-source").bodyFormat).toBe(1);
	expect(await backfill.runBlockJobSlice(inline)).toBe(false);
	expect(await backfill.runProjectionSlice()).toBe(false);
});

test.each([
	"convert",
	"verify",
	"reindex",
	"clear",
	"restore",
] as const)("%s rechecks shutdown at the final write boundary after zero pacing", async (job) => {
	const previous = { ...settings.narratorBlocks };
	settings.narratorBlocks.write = true;
	settings.narratorBlocks.read = true;
	settings.narratorBlocks.compactJson = false;
	let stopping: Promise<void> | undefined;
	try {
		for (const [id, format] of [
			["shutdown-legacy", 1],
			["shutdown-block", 2],
		] as const) {
			sqlite.run(
				'INSERT INTO narrator_messages (id,narrator_id,role,content_json,body_format,created_at) VALUES (?,\'n1\',\'assistant\',\'[{"type":"text","text":"source"}]\',?,?)',
				[id, format, NOW],
			);
		}
		blockSync.syncEnvelopeNow("shutdown-block");
		backfill.blockBackfillStatus();
		sqlite.run(
			"UPDATE narrator_block_backfill SET complete = 1, paused = 0 WHERE job IN ('convert','verify','reindex')",
		);
		sqlite.run("UPDATE narrator_block_backfill SET paused = 1 WHERE job IN ('clear','restore')");
		sqlite.run(
			"UPDATE narrator_block_backfill SET cursor = 0, complete = 0, paused = 0 WHERE job = ?",
			[job],
		);
		if (job === "clear") settings.narratorBlocks.compactJson = true;
		if (job === "restore")
			sqlite.run(
				"UPDATE narrator_messages SET content_json = '[]', body_rows_only = 1 WHERE id = 'shutdown-block'",
			);
		const stored = () =>
			sqlite
				.prepare(
					"SELECT job,paused,cursor,complete,processed FROM narrator_block_backfill ORDER BY job",
				)
				.all();
		const before = stored();
		const beforeLegacy = envelope("shutdown-legacy");
		const beforeBlock = envelope("shutdown-block");
		const gap = <T>(snapshot: T): Promise<T> => {
			queueMicrotask(() =>
				queueMicrotask(() => {
					stopping = backfill.stopBlockBackgroundJobs({ deadlineAt: Date.now() + 1000 });
				}),
			);
			return Promise.resolve(snapshot);
		};
		const pending =
			job === "clear" || job === "restore"
				? backfill.runProjectionSlice((params) => gap(runBlockProjectionSlice(sqlite, params)))
				: backfill.runBlockJobSlice({
						backfill: (params) => gap(runBlockBackfillSlice(sqlite, params)),
						verify: (params) => gap(runBlockVerifySlice(sqlite, params)),
						reindex: (params) => gap(runBlockReindexSlice(sqlite, params)),
					});
		await expect(pending).rejects.toThrow();
		expect(stopping).toBeDefined();
		await stopping;
		expect(stored()).toEqual(before);
		expect(envelope("shutdown-legacy")).toEqual(beforeLegacy);
		expect(envelope("shutdown-block")).toEqual(beforeBlock);
	} finally {
		await stopping;
		Object.assign(settings.narratorBlocks, previous);
	}
});

const indexShutdownSnapshot = () => ({
	queue: sqlite
		.prepare("SELECT block_id, version FROM narrator_block_index_queue ORDER BY block_id")
		.all(),
	index: sqlite.prepare("SELECT id, block FROM narrator_blocks_fts_data ORDER BY id").all(),
});

test.each([
	"runner",
	"drain",
] as const)("background shutdown waits for an active index %s reader and prevents its writes", async (mode) => {
	await narratorStore.appendInput("n1", "queued index shutdown");
	const before = indexShutdownSnapshot();
	expect(before.queue).toHaveLength(1);
	let release = () => {};
	let readerSignal: AbortSignal | undefined;
	const reader: Parameters<typeof blockIndex.drainBlockIndexQueue>[0] = (params, signal) => {
		readerSignal = signal;
		const snapshot = runBlockIndexQueueSlice(sqlite, params);
		return new Promise((resolve) => {
			release = () => resolve(snapshot);
		});
	};
	blockIndex.setBlockIndexAutoRunForTests(true);
	const transactions = spyOn(sqlite, "transaction");
	const pending = (
		mode === "runner" ? blockIndex.runBlockIndex(reader) : blockIndex.drainBlockIndexQueue(reader)
	).then(
		() => null,
		(error: unknown) => error,
	);
	let stopped = false;
	const stopping = backfill.stopBlockBackgroundJobs({ deadlineAt: Date.now() + 1000 }).then(() => {
		stopped = true;
	});
	const timers = spyOn(globalThis, "setTimeout");
	try {
		expect(readerSignal?.aborted).toBe(true);
		await Promise.resolve();
		await Promise.resolve();
		expect(stopped).toBe(false);
		expect(transactions).not.toHaveBeenCalled();
		release();
		const error = await pending;
		if (mode === "drain") expect(error).toMatchObject({ name: "AbortError" });
		else expect(error).toBeNull();
		await stopping;
		expect(stopped).toBe(true);
		blockIndex.scheduleBlockIndex();
		await blockIndex.runBlockIndex(reader);
		await expect(blockIndex.drainBlockIndexQueue(readIndex)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(transactions).not.toHaveBeenCalled();
		expect(timers).not.toHaveBeenCalled();
		expect(indexShutdownSnapshot()).toEqual(before);
	} finally {
		release();
		await Promise.allSettled([pending, stopping]);
		timers.mockRestore();
		transactions.mockRestore();
		blockIndex.setBlockIndexAutoRunForTests(false);
	}
});

test("background shutdown cancels an index pacing wait before its next transaction", async () => {
	await narratorStore.appendInput("n1", "first indexed before shutdown");
	await narratorStore.appendInput("n1", "second queued through shutdown");
	const slice = runBlockIndexQueueSlice(sqlite, {
		kind: "blockIndexQueueSlice",
		maxBlocks: 10,
		maxIndexChars: 1 << 20,
		budgetMs: 1000,
	});
	expect(slice.entries).toHaveLength(2);
	let enterWait = () => {};
	const waiting = new Promise<void>((resolve) => {
		enterWait = resolve;
	});
	let resumeWait: (() => void) | undefined;
	let clock = 1000;
	const performanceClock = spyOn(performance, "now").mockImplementation(() => (clock += 10));
	const originalTimeout = globalThis.setTimeout;
	const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: () => void,
		delay?: number,
	) => {
		const timer = originalTimeout(callback, delay);
		if (!resumeWait && delay !== undefined && delay > 0 && delay <= 30_000) {
			resumeWait = callback;
			enterWait();
		}
		return timer;
	}) as typeof setTimeout);
	const transactions = spyOn(sqlite, "transaction");
	let reads = 0;
	blockIndex.setBlockIndexAutoRunForTests(true);
	const pending = blockIndex.runBlockIndex(async () => {
		const entries = slice.entries.slice(reads, reads + 1);
		reads++;
		return { entries, more: reads === 1 };
	});
	let stopping: Promise<void> | undefined;
	try {
		await waiting;
		expect(reads).toBe(2);
		expect(transactions).toHaveBeenCalledTimes(1);
		const beforeStop = indexShutdownSnapshot();
		expect(beforeStop.queue).toHaveLength(1);
		stopping = backfill.stopBlockBackgroundJobs({ deadlineAt: Date.now() + 1000 });
		const scheduledAtStop = timers.mock.calls.length;
		await stopping;
		await pending;
		// Even an already-dispatched timer callback cannot reopen the write boundary.
		resumeWait?.();
		await Promise.resolve();
		blockIndex.scheduleBlockIndex();
		expect(transactions).toHaveBeenCalledTimes(1);
		expect(timers.mock.calls).toHaveLength(scheduledAtStop);
		expect(indexShutdownSnapshot()).toEqual(beforeStop);
	} finally {
		stopping ??= backfill.stopBlockBackgroundJobs({ deadlineAt: Date.now() + 1000 });
		await Promise.allSettled([pending, stopping]);
		transactions.mockRestore();
		timers.mockRestore();
		performanceClock.mockRestore();
		blockIndex.setBlockIndexAutoRunForTests(false);
	}
});

test("index rechecks shutdown at the final write boundary after zero pacing", async () => {
	await narratorStore.appendInput("n1", "index zero pacing shutdown");
	const before = indexShutdownSnapshot();
	const transactions = spyOn(sqlite, "transaction");
	let stopping: Promise<void> | undefined;
	const pending = blockIndex.runBlockIndex((params) => {
		const snapshot = runBlockIndexQueueSlice(sqlite, params);
		queueMicrotask(() =>
			queueMicrotask(() => {
				stopping = backfill.stopBlockBackgroundJobs({ deadlineAt: Date.now() + 1000 });
			}),
		);
		return Promise.resolve(snapshot);
	});
	try {
		await pending;
		expect(stopping).toBeDefined();
		await stopping;
		expect(transactions).not.toHaveBeenCalled();
		expect(indexShutdownSnapshot()).toEqual(before);
	} finally {
		await Promise.allSettled([pending, stopping]);
		transactions.mockRestore();
	}
});

test.each([
	"deadline",
	"cancel",
] as const)("index readers keep the block shutdown barrier bounded by its %s", async (mode) => {
	await narratorStore.appendInput("n1", "bounded index shutdown");
	const before = indexShutdownSnapshot();
	let release = () => {};
	const pending = blockIndex.runBlockIndex(
		(params) =>
			new Promise((resolve) => {
				const snapshot = runBlockIndexQueueSlice(sqlite, params);
				release = () => resolve(snapshot);
			}),
	);
	const controller = new AbortController();
	const transactions = spyOn(sqlite, "transaction");
	const stopping = backfill.stopBlockBackgroundJobs({
		deadlineAt: Date.now() + (mode === "deadline" ? 0 : 1000),
		signal: controller.signal,
	});
	try {
		if (mode === "cancel") controller.abort(new Error("Cancel index shutdown test"));
		await expect(stopping).rejects.toThrow(
			mode === "deadline" ? "deadline exceeded" : "Cancel index shutdown test",
		);
		expect(transactions).not.toHaveBeenCalled();
		release();
		await pending;
		expect(transactions).not.toHaveBeenCalled();
		expect(indexShutdownSnapshot()).toEqual(before);
	} finally {
		release();
		await Promise.allSettled([pending, stopping]);
		transactions.mockRestore();
	}
});
