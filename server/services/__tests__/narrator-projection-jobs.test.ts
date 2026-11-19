/**
 * The projection jobs (docs/BLOCK_STORAGE-DESIGN.md §10.4, P3b): `clear` drops verified
 * envelopes' `content_json`, leaving them rows-only; `restore` writes it back from the rows.
 * Neither changes what any reader reads, and each skips an envelope that changed after it
 * was read.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
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
const { getDefaults, reloadSettings, settings } = await import("../../lib/settings");
const blockSync = await import("../narrator-block-sync");
const scans = await import("../narrator-block-scans");
const bodies = await import("../narrator-body-writes");
const backfill = await import("../narrator-block-backfill");
const workerPool = await import("../../lib/db-worker/pool");
const workerCore = await import("../../lib/db-worker/block-backfill-query");
const { logger } = await import("../../lib/logger");
const {
	runBlockBackfillSlice,
	runBlockVerifySlice,
	runBlockReindexSlice,
	runBlockProjectionSlice,
} = await import("../../lib/db-worker/block-backfill-query");
const { queryModelHistory, sqliteHistoryQuery } = await import(
	"../agent-runtime/model-history-query"
);

const NOW = "2026-10-01T00:00:00.000Z";

/** Explicit unit-test reader on the fixture connection; production only uses workers. */
const inline = {
	backfill: async (params: Parameters<typeof runBlockBackfillSlice>[1]) =>
		runBlockBackfillSlice(sqlite, params),
	verify: async (params: Parameters<typeof runBlockVerifySlice>[1]) =>
		runBlockVerifySlice(sqlite, params),
	reindex: async (params: Parameters<typeof runBlockReindexSlice>[1]) =>
		runBlockReindexSlice(sqlite, params),
};
const read = async (params: Parameters<typeof runBlockProjectionSlice>[1]) =>
	runBlockProjectionSlice(sqlite, params);

beforeEach(() => {
	// Exercise the old dual-write/rollback path explicitly despite stable single-copy defaults.
	settings.narratorBlocks.compactJson = false;
	blockSync.stopBlockSyncSweep();
	backfill.resetBlockJobPacingForTests();
	cleanDb(sqlite);
	sqlite.run("INSERT INTO narrators (id, title, created_at, updated_at) VALUES ('n1', 'N', ?, ?)", [
		NOW,
		NOW,
	]);
	sqlite.run("DELETE FROM narrator_block_backfill");
	sqlite.run("DELETE FROM narrator_block_diagnostics");
	scans.noteRowsOnlyEnvelopes(undefined);
});
afterEach(async () => {
	backfill.stopProjectionJobs();
	await startupSettled();
	settings.narratorBlocks.compactJson = false;
	settings.narratorBlocks.read = true;
	scans.noteRowsOnlyEnvelopes(undefined);
});
afterAll(async () => {
	blockSync.stopBlockSyncSweep();
	mock.module("../../db", () => realDbModule);
	await workerFixture.close();
});

async function conversation() {
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
	await narratorStore.settleTool("c1", { output: "a.txt", status: "success" }, step.id, toolCallId);
	await narratorPersistence.persistCompactingMessage("n1");
	const marker = sqlite
		.prepare("SELECT id FROM narrator_messages WHERE compact_pending = 1")
		.get() as { id: string };
	await narratorPersistence.finalizeCompactingMessage(marker.id, "n1", "summary");
	return { inputId: input.id, stepId: step.id, markerId: marker.id };
}

/** Convert and verify run to the end: what `clear` waits for. */
async function backfilled(): Promise<void> {
	while (await backfill.runBlockJobSlice(inline));
}

/** Until the background projection runner has stopped. */
async function settled(): Promise<void> {
	while (backfill.blockBackfillStatus().projectionRunning) await Bun.sleep(2);
}

/** Wait for the same startup chain used by the server, including automatically queued clear. */
async function startupSettled(): Promise<void> {
	while (true) {
		const status = backfill.blockBackfillStatus();
		if (!status.running && !status.projectionRunning) return;
		await Bun.sleep(2);
	}
}

const column = (messageId: string) =>
	sqlite
		.prepare("SELECT content_json AS c, body_rows_only AS r FROM narrator_messages WHERE id = ?")
		.get(messageId) as { c: string; r: number };

function assembled(messageId: string): unknown[] {
	const rows = sqlite
		.prepare("SELECT payload, state FROM narrator_blocks WHERE message_id = ? ORDER BY ordinal")
		.all(messageId) as Array<{ payload: string; state: string | null }>;
	return assembleContent(
		rows.map((row) => ({
			payload: JSON.parse(row.payload),
			state: row.state === null ? null : JSON.parse(row.state),
		})),
	);
}

async function modelBodies() {
	const source = await queryModelHistory(sqliteHistoryQuery(sqlite), {
		narratorId: "n1",
		versioned: true,
		bodiesFromBlocks: true,
	});
	return new Map(source.messages.map((row) => [row.id, row.contentJson]));
}

/** Every envelope's body as readers read it (model history starts at the compact marker). */
function readerBodies(): Map<string, unknown> {
	const ids = sqlite
		.prepare("SELECT id FROM narrator_messages WHERE narrator_id = 'n1' ORDER BY id")
		.all() as Array<{ id: string }>;
	return new Map(ids.map(({ id }) => [id, bodies.readEnvelopeBody(db, id)]));
}

const revisions = () =>
	sqlite
		.prepare(
			"SELECT id, body_revision AS b FROM narrator_messages WHERE narrator_id = 'n1' ORDER BY id",
		)
		.all() as Array<{ id: string; b: number }>;

async function cleared() {
	const ids = await conversation();
	await backfilled();
	settings.narratorBlocks.compactJson = true;
	backfill.startProjectionJob("clear", read);
	await settled();
	return ids;
}

function blockedBy(start: () => unknown): string | undefined {
	try {
		start();
	} catch (error) {
		return (error as { statusCode?: number; message: string }).statusCode === 409
			? (error as Error).message
			: String(error);
	}
	return undefined;
}

describe("automatic single-copy upgrade", () => {
	test("startup chains convert/verify/reindex into clear without UI access; all readers stay identical", async () => {
		const { inputId, stepId, markerId } = await conversation();
		const before = readerBodies();
		const history = await modelBodies();
		const bumps = revisions();
		settings.narratorBlocks = getDefaults().narratorBlocks;
		const fresh = await narratorStore.appendInput("n1", "single copy by default");
		expect(column(fresh.id)).toEqual({ c: "[]", r: 1 });
		expect(bodies.readEnvelopeBody(db, fresh.id)).toEqual([
			{ type: "text", text: "single copy by default" },
		]);
		let reads = 0;
		backfill.startBlockBackfill(inline, async (params) => {
			reads++;
			const status = backfill.blockBackfillStatus();
			for (const job of [status.convert, status.verify, status.reindex])
				expect(job?.complete).toBe(true);
			return read(params);
		});
		// Startup only schedules work: it does not scan or decode the database synchronously.
		expect(reads).toBe(0);
		await startupSettled();
		expect(reads).toBeGreaterThan(0);
		for (const id of [inputId, stepId]) expect(column(id)).toEqual({ c: "[]", r: 1 });
		expect(column(markerId).r).toBe(0);
		const after = readerBodies();
		after.delete(fresh.id);
		expect(after).toEqual(before);
		const afterHistory = await modelBodies();
		afterHistory.delete(fresh.id);
		expect(afterHistory).toEqual(history);
		expect(revisions().filter((row) => row.id !== fresh.id)).toEqual(bumps);
		expect(backfill.blockBackfillStatus().clear).toMatchObject({ complete: true, processed: 2 });
	});

	test("the first upgraded backend resumes old paused jobs and clears projections without a frontend visit", async () => {
		settings.narratorBlocks.write = false;
		const { inputId, stepId, markerId } = await conversation();
		const before = readerBodies();
		backfill.blockBackfillStatus();
		sqlite.run("UPDATE narrator_block_backfill SET paused = 1");
		settings.narratorBlocks = getDefaults().narratorBlocks;
		backfill.startBlockBackfill(inline, read);
		await startupSettled();
		const status = backfill.blockBackfillStatus();
		for (const job of [status.convert, status.verify, status.reindex, status.clear])
			expect(job).toMatchObject({ complete: true, paused: false });
		expect(status.restore?.paused).toBe(true);
		for (const id of [inputId, stepId]) expect(column(id)).toEqual({ c: "[]", r: 1 });
		expect(column(markerId).r).toBe(0);
		expect(readerBodies()).toEqual(before);
		expect(reloadSettings().narratorBlocks.singleCopyBackfillResumeVersion).toBe(1);
	});

	test("new job metadata still schedules automatic clear when the settings receipt already exists", async () => {
		const { inputId } = await conversation();
		settings.narratorBlocks = {
			...getDefaults().narratorBlocks,
			singleCopyBackfillResumeVersion: 1,
		};
		backfill.startBlockBackfill(inline, read);
		await startupSettled();
		expect(column(inputId)).toEqual({ c: "[]", r: 1 });
		expect(backfill.blockBackfillStatus().clear).toMatchObject({ complete: true, paused: false });
	});

	test("an explicit backfill pause after the upgrade stays paused across startup and settings reload", async () => {
		await conversation();
		settings.narratorBlocks = getDefaults().narratorBlocks;
		backfill.startBlockBackfill(inline, read);
		await startupSettled();
		expect(settings.narratorBlocks.singleCopyBackfillResumeVersion).toBe(1);
		settings.narratorBlocks.write = false;
		const legacy = await narratorStore.appendInput("n1", "new legacy content after upgrade");
		settings.narratorBlocks.write = true;
		backfill.setBlockBackfillPaused(true);
		reloadSettings();
		backfill.startBlockBackfill(inline, read);
		await startupSettled();
		const status = backfill.blockBackfillStatus();
		for (const job of [status.convert, status.verify, status.reindex])
			expect(job?.paused).toBe(true);
		expect(status.convert?.complete).toBe(false);
		expect(column(legacy.id)).toEqual({
			c: JSON.stringify([{ type: "text", text: "new legacy content after upgrade" }]),
			r: 0,
		});
	});

	test("an explicit projection pause after the upgrade is not undone by automatic startup", async () => {
		await conversation();
		settings.narratorBlocks = getDefaults().narratorBlocks;
		backfill.startBlockBackfill(inline, read);
		await startupSettled();
		settings.narratorBlocks.compactJson = false;
		const input = await narratorStore.appendInput("n1", "keep this projection paused");
		settings.narratorBlocks.compactJson = true;
		backfill.stopProjectionJobs();
		reloadSettings();
		backfill.startBlockBackfill(inline, read);
		await startupSettled();
		expect(backfill.blockBackfillStatus().clear?.paused).toBe(true);
		expect(column(input.id).r).toBe(0);
		backfill.startProjectionJob("clear", read);
		await settled();
		expect(column(input.id)).toEqual({ c: "[]", r: 1 });
	});

	test("waits for paused reindex and automatically clears when the existing chain resumes", async () => {
		const { inputId } = await conversation();
		backfill.blockBackfillStatus();
		sqlite.run("UPDATE narrator_block_backfill SET paused = 1 WHERE job = 'reindex'");
		// This is a deliberate pause after the one-time legacy-pause upgrade, not a rollout pause.
		sqlite.run("UPDATE narrator_block_backfill SET paused = 0 WHERE job = 'clear'");
		settings.narratorBlocks = {
			...getDefaults().narratorBlocks,
			singleCopyBackfillResumeVersion: 1,
		};
		let reads = 0;
		const tracked: typeof read = async (params) => {
			reads++;
			return read(params);
		};
		backfill.startBlockBackfill(inline, tracked);
		await startupSettled();
		expect(reads).toBe(0);
		expect(column(inputId).r).toBe(0);
		expect(backfill.blockBackfillStatus().blocked.clear).toBe("backfill_incomplete");
		sqlite.run("UPDATE narrator_block_backfill SET paused = 0 WHERE job = 'reindex'");
		backfill.startBlockBackfill(inline, tracked);
		await startupSettled();
		expect(reads).toBeGreaterThan(0);
		expect(column(inputId)).toEqual({ c: "[]", r: 1 });
	});

	test("startup resumes an interrupted clear from its durable cursor and retains unread projections on error", async () => {
		const { inputId, stepId } = await conversation();
		await backfilled();
		settings.narratorBlocks = getDefaults().narratorBlocks;
		let reads = 0;
		backfill.startBlockBackfill(inline, async (params) => {
			if (++reads > 1) throw new Error("projection worker unavailable");
			return read({ ...params, maxEnvelopes: 1 });
		});
		await startupSettled();
		const interrupted = backfill.blockBackfillStatus().clear;
		expect(interrupted).toMatchObject({ complete: false, paused: false, processed: 1 });
		expect(interrupted?.cursor).toBeGreaterThan(0);
		expect(column(inputId)).toEqual({ c: "[]", r: 1 });
		expect(column(stepId).r).toBe(0);
		const original = column(stepId).c;
		expect(JSON.parse(original).length).toBeGreaterThan(0);
		const cursors: number[] = [];
		backfill.startBlockBackfill(inline, async (params) => {
			cursors.push(params.afterRowid);
			return read(params);
		});
		await startupSettled();
		expect(cursors[0]).toBe(interrupted?.cursor ?? -1);
		expect(column(stepId)).toEqual({ c: "[]", r: 1 });
		expect(assembled(stepId)).toEqual(JSON.parse(original));
		expect(backfill.blockBackfillStatus().clear).toMatchObject({ complete: true, processed: 2 });
	});

	test("a completed pre-upgrade clear is rearmed on startup after a deliberate restore", async () => {
		const { inputId } = await cleared();
		settings.narratorBlocks.compactJson = false;
		backfill.startProjectionJob("restore", read);
		await settled();
		expect(column(inputId).r).toBe(0);
		expect(backfill.blockBackfillStatus().clear?.complete).toBe(true);
		settings.narratorBlocks = getDefaults().narratorBlocks;
		backfill.startBlockBackfill(inline, read);
		await startupSettled();
		expect(column(inputId)).toEqual({ c: "[]", r: 1 });
		expect(backfill.blockBackfillStatus().clear).toMatchObject({ complete: true, processed: 2 });
	});

	test("undecodable legacy content retains its original projection during automatic upgrade", async () => {
		settings.narratorBlocks.write = false;
		const input = await narratorStore.appendInput("n1", "original");
		const malformed = JSON.stringify("not an array");
		sqlite.run("UPDATE narrator_messages SET content_json = ? WHERE id = ?", [malformed, input.id]);
		settings.narratorBlocks = getDefaults().narratorBlocks;
		backfill.startBlockBackfill(inline, read);
		await startupSettled();
		expect(column(input.id)).toEqual({ c: malformed, r: 0 });
		expect(
			sqlite
				.prepare("SELECT kind FROM narrator_block_diagnostics WHERE message_id = ?")
				.get(input.id),
		).toEqual({ kind: "undecodable" });
	});
});

/** Start a manual slice without the timer producer; persisted gates are still exercised. */
function armProjection(job: "clear" | "restore") {
	backfill.blockBackfillStatus();
	sqlite.run(
		"UPDATE narrator_block_backfill SET complete = 1 WHERE job IN ('convert','verify','reindex')",
	);
	sqlite.run("UPDATE narrator_block_backfill SET paused = 1 WHERE job IN ('clear','restore')");
	sqlite.run(
		"UPDATE narrator_block_backfill SET cursor = 0,processed = 0,complete = 0,paused = 0 WHERE job = ?",
		[job],
	);
	settings.narratorBlocks.compactJson = job === "clear";
}

function projectionProbe(
	job: "clear" | "restore",
	options: {
		failTransaction?: number;
		commitCost?: number;
		onCommit?: (count: number) => void;
	} = {},
) {
	let now = 10_000;
	let calls = 0;
	let turns = 0;
	const states: Array<{
		cursor: number;
		processed: number;
		complete: number;
		paused: number;
		turns: number;
		started: number;
		ended: number;
	}> = [];
	const clock = spyOn(performance, "now").mockImplementation(() => now);
	const originalTimeout = globalThis.setTimeout;
	const timers = spyOn(globalThis, "setTimeout").mockImplementation(
		new Proxy(originalTimeout, {
			apply(target, receiver, args) {
				const [handler, delay = 0, ...handlerArgs] = args;
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
		return new Proxy(
			transaction(
				new Proxy(write, {
					apply(target, receiver, args) {
						const result = Reflect.apply(target, receiver, args);
						if (call === options.failTransaction) throw new Error("projection apply rollback");
						return result;
					},
				}),
			),
			{
				apply(target, receiver, args) {
					const started = now;
					const result = Reflect.apply(target, receiver, args);
					now += options.commitCost ?? 0;
					const state = sqlite
						.prepare(
							"SELECT cursor,processed,complete,paused FROM narrator_block_backfill WHERE job = ?",
						)
						.get(job) as { cursor: number; processed: number; complete: number; paused: number };
					states.push({ ...state, turns, started, ended: now });
					originalTimeout(() => {
						turns++;
					}, 0);
					options.onCommit?.(states.length);
					return result;
				},
			},
		);
	});
	return {
		states,
		restore() {
			transactions.mockRestore();
			timers.mockRestore();
			clock.mockRestore();
		},
	};
}

async function manyProjections(count = 17) {
	const ids: string[] = [];
	for (let index = 0; index < count; index++)
		ids.push((await narratorStore.appendInput("n1", `projection-${index}`)).id);
	blockSync.stopBlockSyncSweep();
	return ids;
}

async function rowsOnlyProjections(count = 17) {
	const ids = await manyProjections(count);
	armProjection("clear");
	const probe = projectionProbe("clear");
	try {
		await backfill.runProjectionSlice(read);
	} finally {
		probe.restore();
	}
	backfill.resetBlockJobPacingForTests();
	armProjection("restore");
	return ids;
}

describe("bounded projection apply", () => {
	test("clear advances ordered match, marker, queued, gone and mismatch prefixes without inflating processed", async () => {
		const first = await conversation();
		const extra = await manyProjections(14);
		const ids = [first.inputId, first.stepId, first.markerId, ...extra];
		for (const index of [0, 9, 16])
			sqlite.run("UPDATE narrator_blocks SET payload = ? WHERE message_id = ?", [
				JSON.stringify({ raw: [{ type: "text", text: "drifted" }] }),
				ids[index],
			]);
		sqlite.run("INSERT INTO narrator_block_sync_queue (message_id) VALUES (?)", [ids[5]]);
		armProjection("clear");
		const slice = await read({
			kind: "blockProjectionSlice",
			job: "clear",
			afterRowid: 0,
			maxEnvelopes: 100,
			maxSourceBytes: 4 * 1024 * 1024,
			budgetMs: 1000,
		});
		expect(slice.visited.map((item) => item.id)).toEqual(ids);
		expect(slice.visited[2].envelope).toBeUndefined();
		expect(slice.visited[5].envelope).toBeUndefined();
		expect(slice.mismatched).toEqual([ids[0], ids[9], ids[16]]);
		sqlite.transaction(() => {
			// This input's refs restrict deletion; its block rows and queues cascade.
			sqlite.run("DELETE FROM narrator_message_refs WHERE message_id = ?", [ids[7]]);
			sqlite.run("DELETE FROM narrator_messages WHERE id = ?", [ids[7]]);
		})();
		expect(sqlite.prepare("SELECT id FROM narrator_messages WHERE id = ?").get(ids[7])).toBeNull();
		const probe = projectionProbe("clear");
		try {
			await backfill.runProjectionSlice(async () => slice);
		} finally {
			probe.restore();
		}
		expect(probe.states.map((state) => state.cursor)).toEqual(
			[7, 15, 16].map((index) => slice.visited[index].rowid),
		);
		expect(probe.states.map((state) => state.processed)).toEqual([4, 11, 11]);
		expect(probe.states.map((state) => state.complete)).toEqual([0, 0, 1]);
		expect(probe.states.map((state) => state.turns)).toEqual([0, 1, 2]);
		for (const index of [0, 9, 16]) {
			expect(column(ids[index]).r).toBe(0);
			expect(assembled(ids[index])).toEqual(JSON.parse(column(ids[index]).c));
			expect(
				sqlite
					.prepare("SELECT kind FROM narrator_block_diagnostics WHERE message_id = ?")
					.get(ids[index]),
			).toEqual({ kind: "mismatch" });
		}
	});

	test("clear mismatch repair and its cursor roll back together before retry", async () => {
		const ids = await manyProjections();
		sqlite.run("UPDATE narrator_blocks SET payload = ? WHERE message_id = ?", [
			JSON.stringify({ raw: [{ type: "text", text: "drifted" }] }),
			ids[9],
		]);
		armProjection("clear");
		const probe = projectionProbe("clear", { failTransaction: 2 });
		try {
			await expect(backfill.runProjectionSlice(read)).rejects.toThrow("projection apply rollback");
		} finally {
			probe.restore();
		}
		expect(backfill.blockBackfillStatus().clear).toMatchObject({ complete: false, processed: 8 });
		expect(column(ids[8]).r).toBe(0);
		expect(
			sqlite
				.prepare("SELECT kind FROM narrator_block_diagnostics WHERE message_id = ?")
				.get(ids[9]),
		).toBeNull();
		const retry = projectionProbe("clear");
		try {
			await backfill.runProjectionSlice(read);
		} finally {
			retry.restore();
		}
		expect(backfill.blockBackfillStatus().clear).toMatchObject({ complete: true, processed: 16 });
		expect(assembled(ids[9])).toEqual(JSON.parse(column(ids[9]).c));
	});

	test("restore completes only after the final prefix and keeps its successful-write count", async () => {
		const ids = await rowsOnlyProjections();
		const probe = projectionProbe("restore");
		try {
			await backfill.runProjectionSlice(read);
		} finally {
			probe.restore();
		}
		expect(probe.states.map((state) => state.processed)).toEqual([8, 16, 17]);
		expect(probe.states.map((state) => state.complete)).toEqual([0, 0, 1]);
		expect(probe.states.map((state) => state.turns)).toEqual([0, 1, 2]);
		for (const id of ids) expect(column(id)).toEqual({ c: JSON.stringify(assembled(id)), r: 0 });
	});

	test("restore pass progress excludes a rolled-back final prefix before its no-progress decision", async () => {
		const ids = await rowsOnlyProjections();
		const source = await read({
			kind: "blockProjectionSlice",
			job: "restore",
			afterRowid: 0,
			maxEnvelopes: 100,
			maxSourceBytes: 4 * 1024 * 1024,
			budgetMs: 1000,
		});
		const skipped = {
			...source,
			visited: source.visited.map((item, index) =>
				index === 16 ? item : { ...item, envelope: undefined },
			),
		};
		const probe = projectionProbe("restore", { failTransaction: 3 });
		try {
			await expect(backfill.runProjectionSlice(async () => skipped)).rejects.toThrow(
				"projection apply rollback",
			);
		} finally {
			probe.restore();
		}
		expect(backfill.blockBackfillStatus().restore).toMatchObject({
			cursor: source.visited[15].rowid,
			complete: false,
			processed: 0,
			paused: false,
		});
		expect(column(ids[16]).r).toBe(1);
		const retry = projectionProbe("restore");
		try {
			await backfill.runProjectionSlice(async (params) => {
				const slice = await read(params);
				return {
					...slice,
					visited: slice.visited.map((item) => ({ ...item, envelope: undefined })),
				};
			});
		} finally {
			retry.restore();
		}
		expect(backfill.blockBackfillStatus().restore).toMatchObject({
			cursor: 0,
			complete: false,
			processed: 0,
			paused: true,
		});
		sqlite.run("UPDATE narrator_block_backfill SET paused = 0 WHERE job = 'restore'");
		const finish = projectionProbe("restore");
		try {
			await backfill.runProjectionSlice(read);
		} finally {
			finish.restore();
		}
		expect(backfill.blockBackfillStatus().restore).toMatchObject({ complete: true, processed: 17 });
	});

	test("restore shutdown preserves the rows-only tail and resumes after a fresh lifecycle", async () => {
		const ids = await rowsOnlyProjections();
		let stopping: Promise<void> | undefined;
		const probe = projectionProbe("restore", {
			onCommit: (count) => {
				if (count === 1)
					stopping = backfill.stopBlockBackgroundJobs({ deadlineAt: Date.now() + 1000 });
			},
		});
		try {
			await expect(backfill.runProjectionSlice(read)).rejects.toThrow();
			await stopping;
		} finally {
			probe.restore();
		}
		expect(backfill.blockBackfillStatus().restore).toMatchObject({
			complete: false,
			paused: false,
			processed: 8,
		});
		expect(column(ids[8]).r).toBe(1);
		backfill.resetBlockJobPacingForTests();
		const retry = projectionProbe("restore");
		try {
			await backfill.runProjectionSlice(read);
		} finally {
			retry.restore();
		}
		expect(backfill.blockBackfillStatus().restore).toMatchObject({ complete: true, processed: 17 });
	});

	test("restore prepared byte costs use UTF-8 even if stored body sizes understate them", async () => {
		for (let index = 0; index < 3; index++)
			await narratorStore.appendInput("n1", "界".repeat(25_000));
		blockSync.stopBlockSyncSweep();
		armProjection("clear");
		const clear = projectionProbe("clear");
		try {
			await backfill.runProjectionSlice(read);
		} finally {
			clear.restore();
		}
		backfill.resetBlockJobPacingForTests();
		sqlite.run("UPDATE narrator_messages SET body_bytes = 0");
		armProjection("restore");
		const slice = await read({
			kind: "blockProjectionSlice",
			job: "restore",
			afterRowid: 0,
			maxEnvelopes: 100,
			maxSourceBytes: 4 * 1024 * 1024,
			budgetMs: 1000,
		});
		for (const item of slice.visited)
			expect(item.sourceBytes).toBe(Buffer.byteLength(item.envelope?.json ?? ""));
		const restore = projectionProbe("restore");
		try {
			await backfill.runProjectionSlice(async () => slice);
		} finally {
			restore.restore();
		}
		expect(restore.states.map((state) => state.processed)).toEqual([1, 2, 3]);
	});

	test("projection and conversion callers serialize their shared pacing turns", async () => {
		await rowsOnlyProjections();
		sqlite.run("UPDATE narrator_block_backfill SET complete = 0,cursor = 0 WHERE job = 'convert'");
		const probe = projectionProbe("restore", { commitCost: 10 });
		try {
			await Promise.all([backfill.runProjectionSlice(read), backfill.runBlockJobSlice(inline)]);
		} finally {
			probe.restore();
		}
		expect(backfill.blockBackfillStatus().restore).toMatchObject({ complete: true, processed: 17 });
		for (let index = 1; index < probe.states.length; index++)
			expect(probe.states[index].started - probe.states[index - 1].ended).toBeGreaterThanOrEqual(
				30,
			);
	});

	test("projection readers must describe skipped candidates before a cursor can advance", async () => {
		await manyProjections(1);
		armProjection("clear");
		await expect(
			backfill.runProjectionSlice(async (params) => {
				const source = await read(params);
				return { ...source, visited: undefined } as unknown as typeof source;
			}),
		).rejects.toThrow("missing ordered candidates");
		expect(backfill.blockBackfillStatus().clear).toMatchObject({
			cursor: 0,
			complete: false,
			processed: 0,
		});
	});
});

describe("clear", () => {
	test("drops verified projections; compact markers keep theirs; nothing reads differently", async () => {
		const { inputId, stepId, markerId } = await conversation();
		await backfilled();
		const before = readerBodies();
		const history = await modelBodies();
		const bumps = revisions();
		settings.narratorBlocks.compactJson = true;
		const started = backfill.startProjectionJob("clear", read);
		expect(started.clear?.paused).toBe(false);
		await settled();
		for (const id of [inputId, stepId]) expect(column(id)).toEqual({ c: "[]", r: 1 });
		expect(column(markerId).r).toBe(0);
		expect(readerBodies()).toEqual(before);
		expect(await modelBodies()).toEqual(history);
		// A state-only write: no revision moved, nothing waits on a sync.
		expect(revisions()).toEqual(bumps);
		expect(sqlite.prepare("SELECT count(*) AS n FROM narrator_block_sync_queue").get()).toEqual({
			n: 0,
		});
		const status = backfill.blockBackfillStatus();
		expect(status.clear).toMatchObject({ complete: true, processed: 2 });
		expect(status.rowsOnly).toBe(true);
		// Rows-only envelopes keep block reads on.
		settings.narratorBlocks.read = false;
		expect(scans.blockReadsEnabled()).toBe(true);
	});

	test("needs compactJson in effect and a finished backfill", async () => {
		await conversation();
		expect(blockedBy(() => backfill.startProjectionJob("clear", read))).toContain(
			"compact_json_off",
		);
		settings.narratorBlocks.compactJson = true;
		expect(blockedBy(() => backfill.startProjectionJob("clear", read))).toContain(
			"backfill_incomplete",
		);
		expect(backfill.blockBackfillStatus().blocked.clear).toBe("backfill_incomplete");
		await backfilled();
		expect(backfill.blockBackfillStatus().blocked).toEqual({
			clear: null,
			restore: "compact_json_on",
		});
	});

	test("skips an envelope written after it was read, and a later run clears it", async () => {
		const { inputId, stepId } = await conversation();
		await backfilled();
		settings.narratorBlocks.compactJson = true;
		// A translation lands between the read and the apply (written with its projection).
		let raced = false;
		const racing = async (params: Parameters<typeof read>[0]) => {
			const slice = await read(params);
			if (!raced) {
				raced = true;
				settings.narratorBlocks.compactJson = false;
				await narratorPersistence.patchReasoningTranslation(stepId, 0, "pensando", {
					id: "r1",
					text: "thinking",
				});
				settings.narratorBlocks.compactJson = true;
			}
			return slice;
		};
		backfill.startProjectionJob("clear", racing);
		await settled();
		expect(column(inputId).r).toBe(1);
		expect(column(stepId).r).toBe(0);
		backfill.startProjectionJob("clear", read);
		await settled();
		expect(column(stepId)).toEqual({ c: "[]", r: 1 });
		expect(assembled(stepId)[0]).toMatchObject({ translatedText: "pensando" });
	});

	test("records rows that differ from their projection instead of clearing it", async () => {
		const { inputId } = await conversation();
		await backfilled();
		sqlite.run("UPDATE narrator_blocks SET payload = ? WHERE message_id = ?", [
			JSON.stringify({ raw: [{ type: "text", text: "drifted" }] }),
			inputId,
		]);
		settings.narratorBlocks.compactJson = true;
		backfill.startProjectionJob("clear", read);
		await settled();
		expect(column(inputId).r).toBe(0);
		expect(
			sqlite
				.prepare("SELECT kind FROM narrator_block_diagnostics WHERE message_id = ?")
				.get(inputId),
		).toEqual({ kind: "mismatch" });
		expect(assembled(inputId)).toEqual(JSON.parse(column(inputId).c));
	});

	test("stops where it is once compactJson goes off", async () => {
		const { inputId } = await conversation();
		await backfilled();
		settings.narratorBlocks.compactJson = true;
		backfill.startProjectionJob("clear", async (params) => {
			settings.narratorBlocks.compactJson = false;
			return read(params);
		});
		await settled();
		// What was read while it went off is not applied.
		expect(column(inputId).r).toBe(0);
		expect(backfill.blockBackfillStatus().clear).toMatchObject({ paused: true, complete: false });
		expect(await backfill.runProjectionSlice(read)).toBe(false);
	});
});

describe("restore", () => {
	test("writes every projection back, and the read switch takes effect again", async () => {
		const { inputId, stepId } = await cleared();
		const expected = new Map([inputId, stepId].map((id) => [id, assembled(id)]));
		const before = readerBodies();
		const history = await modelBodies();
		const bumps = revisions();
		expect(blockedBy(() => backfill.startProjectionJob("restore", read))).toContain(
			"compact_json_on",
		);
		settings.narratorBlocks.compactJson = false;
		backfill.startProjectionJob("restore", read);
		await settled();
		for (const [id, body] of expected)
			expect(column(id)).toEqual({ c: JSON.stringify(body), r: 0 });
		expect(readerBodies()).toEqual(before);
		expect(await modelBodies()).toEqual(history);
		expect(revisions()).toEqual(bumps);
		const status = backfill.blockBackfillStatus();
		expect(status.restore).toMatchObject({ complete: true, processed: 2 });
		expect(status.rowsOnly).toBe(false);
		settings.narratorBlocks.read = false;
		expect(scans.blockReadsEnabled()).toBe(false);
		expect(bodies.readEnvelopeBody(db, stepId)).toEqual(expected.get(stepId));
	});

	test("skips rows that moved after they were read; the next pass writes what they hold", async () => {
		const { inputId, stepId } = await cleared();
		settings.narratorBlocks.compactJson = false;
		let raced = false;
		backfill.startProjectionJob("restore", async (params) => {
			const slice = await read(params);
			if (!raced) {
				raced = true;
				// A sync rewriting state alone moves no revision of the envelope's.
				sqlite.run(`UPDATE narrator_blocks SET state = ? WHERE message_id = ? AND ordinal = 0`, [
					JSON.stringify({ raw: [{ translatedText: "pensando" }] }),
					stepId,
				]);
			}
			return slice;
		});
		await settled();
		expect(column(inputId).r).toBe(0);
		expect(column(stepId)).toEqual({ c: JSON.stringify(assembled(stepId)), r: 0 });
		expect(JSON.parse(column(stepId).c)[0]).toMatchObject({ translatedText: "pensando" });
		expect(backfill.blockBackfillStatus().restore?.complete).toBe(true);
	});

	test("a write since the read stored its own projection, which the job leaves alone", async () => {
		const { stepId } = await cleared();
		let writerProjection: string | undefined;
		settings.narratorBlocks.compactJson = false;
		backfill.startProjectionJob("restore", async (params) => {
			const slice = await read(params);
			await narratorPersistence.patchReasoningTranslation(stepId, 0, "pensando", {
				id: "r1",
				text: "thinking",
			});
			writerProjection = column(stepId).c;
			return slice;
		});
		await settled();
		const stored = column(stepId);
		const projectedBody = JSON.parse(stored.c);
		if (typeof writerProjection !== "string")
			throw new Error("Writer projection was not captured after translation");
		expect(stored.c).toBe(writerProjection);
		expect(stored.r).toBe(0);
		expect(projectedBody).toEqual(assembled(stepId));
		expect(projectedBody[0]).toMatchObject({ translatedText: "pensando" });
	});

	test("starting one job stops the other where it is", async () => {
		const { inputId } = await conversation();
		await backfilled();
		settings.narratorBlocks.compactJson = true;
		backfill.startProjectionJob("clear", async (params) => {
			await Bun.sleep(5);
			return read(params);
		});
		// While clear's first slice is still being read.
		settings.narratorBlocks.compactJson = false;
		const status = backfill.startProjectionJob("restore", read);
		expect(status.clear?.paused).toBe(true);
		expect(status.restore?.paused).toBe(false);
		await settled();
		expect(column(inputId).r).toBe(0);
		expect(backfill.blockBackfillStatus()).toMatchObject({
			clear: { paused: true, complete: false },
			restore: { complete: true },
			rowsOnly: false,
		});
	});
});

/** Hold only pressure waits; slice/apply timers retain their real event-loop behavior. */
function projectionPressureTurns() {
	const originalTimeout = globalThis.setTimeout;
	const originalClear = globalThis.clearTimeout;
	const pending = new Set<ReturnType<typeof setTimeout>>();
	const turns: Array<{ fire(): void }> = [];
	const waiters: Array<(turn: { fire(): void }) => void> = [];
	const timers = spyOn(globalThis, "setTimeout").mockImplementation(
		new Proxy(originalTimeout, {
			apply(target, receiver, args) {
				const [handler, delay, ...handlerArgs] = args;
				if (delay !== 500) return Reflect.apply(target, receiver, args);
				const timer = originalTimeout(() => {}, 60_000);
				timer.unref();
				pending.add(timer);
				const turn = {
					// Deliberately callable after cancellation, to exercise stale queued callbacks.
					fire() {
						pending.delete(timer);
						originalClear(timer);
						Reflect.apply(handler, undefined, handlerArgs);
					},
				};
				const waiter = waiters.shift();
				if (waiter) waiter(turn);
				else turns.push(turn);
				return timer;
			},
		}),
	);
	const clears = spyOn(globalThis, "clearTimeout").mockImplementation(
		new Proxy(originalClear, {
			apply(target, receiver, args) {
				pending.delete(args[0]);
				return Reflect.apply(target, receiver, args);
			},
		}),
	);
	return {
		pending,
		next(): Promise<{ fire(): void }> {
			const turn = turns.shift();
			return turn ? Promise.resolve(turn) : new Promise((resolve) => waiters.push(resolve));
		},
		restore() {
			for (const timer of pending) originalClear(timer);
			pending.clear();
			clears.mockRestore();
			timers.mockRestore();
		},
	};
}

const busyProjectionPool = {
	available: true,
	reason: null,
	shouldYield: true,
	queued: 1,
	normalHeld: 0,
	normalCapacity: 1,
};

describe("projection read-pressure yielding", () => {
	for (const job of ["clear", "restore"] as const) {
		test(`${job}: pressure waits hold no read or cursor and resume automatically`, async () => {
			if (job === "restore") await rowsOnlyProjections(1);
			else {
				await manyProjections(1);
				armProjection(job);
			}
			const pressure = spyOn(workerPool, "getDbReadSchedulingPressure").mockReturnValue({
				...busyProjectionPool,
			});
			const reader = mock(read);
			const worker = spyOn(workerPool, "runReadTask");
			const turns = projectionPressureTurns();
			const before = backfill.startProjectionJob(job, reader)[job];
			const sql = spyOn(sqlite, "prepare");
			try {
				const first = await turns.next();
				expect(turns.pending.size).toBe(1);
				expect(pressure).toHaveBeenCalledTimes(1);
				expect(sql).not.toHaveBeenCalled();
				expect(reader).not.toHaveBeenCalled();
				expect(worker).not.toHaveBeenCalled();
				first.fire();
				const second = await turns.next();
				expect(turns.pending.size).toBe(1);
				expect(pressure).toHaveBeenCalledTimes(2);
				expect(sql).not.toHaveBeenCalled();
				expect(backfill.blockBackfillStatus()[job]).toEqual(before);
				pressure.mockReturnValue({ ...busyProjectionPool, shouldYield: false, queued: 0 });
				second.fire();
				await settled();
				expect(reader).toHaveBeenCalledTimes(1);
				expect(worker).not.toHaveBeenCalled();
				expect(turns.pending.size).toBe(0);
				expect(backfill.blockBackfillStatus()[job]).toMatchObject({
					complete: true,
					paused: false,
					processed: 1,
				});
			} finally {
				backfill.stopProjectionJobs();
				sql.mockRestore();
				turns.restore();
				pressure.mockRestore();
				worker.mockRestore();
			}
		});
	}

	test("a completed slice leaves no pressure timer even if the next snapshot would be busy", async () => {
		await manyProjections(1);
		armProjection("clear");
		const pressure = spyOn(workerPool, "getDbReadSchedulingPressure")
			.mockReturnValueOnce({ ...busyProjectionPool, shouldYield: false, queued: 0 })
			.mockReturnValue({ ...busyProjectionPool });
		const reader = mock(read);
		const turns = projectionPressureTurns();
		try {
			backfill.startProjectionJob("clear", reader);
			await settled();
			expect(reader).toHaveBeenCalledTimes(1);
			expect(pressure).toHaveBeenCalledTimes(1);
			expect(turns.pending.size).toBe(0);
		} finally {
			backfill.stopProjectionJobs();
			turns.restore();
			pressure.mockRestore();
		}
	});

	test("pressure appearing after a committed slice delays only the next slice", async () => {
		const ids = await manyProjections(2);
		armProjection("clear");
		const pressure = spyOn(workerPool, "getDbReadSchedulingPressure")
			.mockReturnValueOnce({ ...busyProjectionPool, shouldYield: false, queued: 0 })
			.mockReturnValue({ ...busyProjectionPool, queued: 0, normalHeld: 1 });
		const reader = mock((params: Parameters<typeof read>[0]) =>
			read({ ...params, maxEnvelopes: 1 }),
		);
		const turns = projectionPressureTurns();
		try {
			backfill.startProjectionJob("clear", reader);
			const first = await turns.next();
			expect(reader).toHaveBeenCalledTimes(1);
			expect(column(ids[0]).r).toBe(1);
			expect(column(ids[1]).r).toBe(0);
			const before = backfill.blockBackfillStatus().clear;
			expect(before).toMatchObject({ processed: 1, paused: false, complete: false });
			const sql = spyOn(sqlite, "prepare");
			try {
				// A recovering shared owner also yields with no queued or currently held task.
				pressure.mockReturnValue({ ...busyProjectionPool, queued: 0 });
				first.fire();
				const second = await turns.next();
				expect(sql).not.toHaveBeenCalled();
				expect(reader).toHaveBeenCalledTimes(1);
				expect(backfill.blockBackfillStatus().clear).toEqual(before);
				pressure.mockReturnValue({ ...busyProjectionPool, shouldYield: false, queued: 0 });
				second.fire();
				await settled();
				expect(reader.mock.calls.length).toBeGreaterThan(1);
				expect(backfill.blockBackfillStatus().clear).toMatchObject({
					processed: 2,
					complete: true,
					paused: false,
				});
			} finally {
				sql.mockRestore();
			}
		} finally {
			backfill.stopProjectionJobs();
			turns.restore();
			pressure.mockRestore();
		}
	});

	test("pause cancels the sole pressure timer and an old turn cannot revive a resumed job", async () => {
		await manyProjections(1);
		armProjection("clear");
		const pressure = spyOn(workerPool, "getDbReadSchedulingPressure").mockReturnValue({
			...busyProjectionPool,
		});
		const reader = mock(read);
		const resumed = mock(read);
		const turns = projectionPressureTurns();
		try {
			backfill.startProjectionJob("clear", reader);
			const stale = await turns.next();
			backfill.stopProjectionJobs();
			expect(turns.pending.size).toBe(0);
			expect(backfill.blockBackfillStatus()).toMatchObject({
				projectionRunning: false,
				clear: { cursor: 0, processed: 0, paused: true, complete: false },
			});
			pressure.mockReturnValue({ ...busyProjectionPool, shouldYield: false, queued: 0 });
			backfill.startProjectionJob("clear", resumed);
			stale.fire();
			await settled();
			expect(reader).not.toHaveBeenCalled();
			expect(resumed).toHaveBeenCalledTimes(1);
			expect(turns.pending.size).toBe(0);
		} finally {
			backfill.stopProjectionJobs();
			turns.restore();
			pressure.mockRestore();
		}
	});

	test("changing jobs replaces the pending turn and its captured reader", async () => {
		await manyProjections(1);
		armProjection("clear");
		const pressure = spyOn(workerPool, "getDbReadSchedulingPressure").mockReturnValue({
			...busyProjectionPool,
		});
		const clear = mock(read);
		const restore = mock(read);
		const turns = projectionPressureTurns();
		try {
			backfill.startProjectionJob("clear", clear);
			const stale = await turns.next();
			settings.narratorBlocks.compactJson = false;
			backfill.startProjectionJob("restore", restore);
			expect(turns.pending.size).toBe(0);
			const current = await turns.next();
			expect(turns.pending.size).toBe(1);
			pressure.mockReturnValue({ ...busyProjectionPool, shouldYield: false, queued: 0 });
			stale.fire();
			expect(clear).not.toHaveBeenCalled();
			expect(restore).not.toHaveBeenCalled();
			expect(turns.pending.size).toBe(1);
			current.fire();
			await settled();
			expect(clear).not.toHaveBeenCalled();
			expect(restore).toHaveBeenCalledTimes(1);
			expect(backfill.blockBackfillStatus()).toMatchObject({
				clear: { paused: true, processed: 0 },
				restore: { complete: true, paused: false },
			});
		} finally {
			backfill.stopProjectionJobs();
			turns.restore();
			pressure.mockRestore();
		}
	});

	test("shutdown cancels a pressure wait without changing durable pause or progress", async () => {
		await manyProjections(1);
		armProjection("clear");
		const pressure = spyOn(workerPool, "getDbReadSchedulingPressure").mockReturnValue({
			...busyProjectionPool,
		});
		const reader = mock(read);
		const turns = projectionPressureTurns();
		try {
			const before = backfill.startProjectionJob("clear", reader).clear;
			const stale = await turns.next();
			await backfill.stopBlockBackgroundJobs({ deadlineAt: Date.now() + 1000 });
			expect(turns.pending.size).toBe(0);
			expect(backfill.blockBackfillStatus().clear).toEqual(before);
			backfill.resetBlockJobPacingForTests();
			pressure.mockReturnValue({ ...busyProjectionPool, shouldYield: false, queued: 0 });
			stale.fire();
			await Bun.sleep(1);
			expect(reader).not.toHaveBeenCalled();
			expect(backfill.blockBackfillStatus().projectionRunning).toBe(false);
		} finally {
			backfill.stopProjectionJobs();
			turns.restore();
			pressure.mockRestore();
		}
	});

	test("job changes drain the old in-flight slice before starting a new reader", async () => {
		await manyProjections(1);
		armProjection("clear");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const first = mock(async (params: Parameters<typeof read>[0]) => {
			entered.resolve();
			await release.promise;
			return read(params);
		});
		const second = mock(read);
		const pressure = spyOn(workerPool, "getDbReadSchedulingPressure").mockReturnValue({
			...busyProjectionPool,
			shouldYield: false,
			queued: 0,
		});
		try {
			backfill.startProjectionJob("clear", first);
			await entered.promise;
			settings.narratorBlocks.compactJson = false;
			backfill.startProjectionJob("restore", second);
			await Bun.sleep(1);
			expect(second).not.toHaveBeenCalled();
			release.resolve();
			await settled();
			expect(first).toHaveBeenCalledTimes(1);
			expect(second).toHaveBeenCalledTimes(1);
			expect(backfill.blockBackfillStatus().clear).toMatchObject({ paused: true, cursor: 0 });
		} finally {
			release.resolve();
			backfill.stopProjectionJobs();
			await settled();
			pressure.mockRestore();
		}
	});

	for (const reason of ["disabled_by_env", "invalid_concurrency"]) {
		test(`${reason} follows the worker failure path instead of waiting indefinitely`, async () => {
			await manyProjections(1);
			armProjection("clear");
			const pressure = spyOn(workerPool, "getDbReadSchedulingPressure").mockReturnValue({
				...busyProjectionPool,
				available: false,
				reason,
				shouldYield: false,
			});
			const error = new Error("projection worker unavailable");
			const worker = spyOn(workerPool, "runReadTask").mockRejectedValue(error);
			const decode = spyOn(workerCore, "runBlockProjectionSlice");
			const warn = spyOn(logger, "warn").mockImplementation(() => {});
			const turns = projectionPressureTurns();
			try {
				backfill.startProjectionJob("clear");
				await settled();
				expect(worker).toHaveBeenCalledTimes(1);
				expect(decode).not.toHaveBeenCalled();
				expect(turns.pending.size).toBe(0);
				expect(backfill.blockBackfillStatus().clear).toMatchObject({
					cursor: 0,
					processed: 0,
					paused: false,
					complete: false,
				});
				expect(warn).toHaveBeenCalledWith("Projection job stopped; it resumes at the next start", {
					error: String(error),
				});
			} finally {
				backfill.stopProjectionJobs();
				turns.restore();
				warn.mockRestore();
				decode.mockRestore();
				worker.mockRestore();
				pressure.mockRestore();
			}
		});
	}
});

/** Run the actual lifecycle/runner declarations against legacy hotSafe state and controlled turns. */
function legacyProjectionHarness(normal = false) {
	const source = readFileSync(new URL("../narrator-block-backfill.ts", import.meta.url), "utf8");
	const section = (start: string, end: string) => {
		const from = source.indexOf(start);
		const to = source.indexOf(end, from);
		if (from < 0 || to < from)
			throw new Error(`Missing projection lifecycle declaration: ${start}`);
		return source.slice(from, to).replace(/^export /gm, "");
	};
	const declarations = [
		section("export async function stopBlockBackgroundJobs(", "\nconst state ="),
		section("function cancelProjectionTurn()", "\nlet schema:"),
		section("export function startProjectionJob(", "/** The projection job that was started"),
		section(
			"export function startBlockBackfill(",
			"\nexport interface BlockBackfillStatus",
		).replace("function startBlockBackfill(", "function requestBackfill("),
		section("function upgradeLegacyProjectionRunner()", "\nupgradeLegacyProjectionRunner();"),
	].join("\n");
	const timers = new Map<number, { callback(): void; delay: number }>();
	let nextTimer = 0;
	const schedule = (callback: () => void, delay = 0) => {
		const id = ++nextTimer;
		timers.set(id, { callback, delay });
		return id;
	};
	const release = Promise.withResolvers<void>();
	const legacyBackgroundJobs = {
		stopping: false,
		controller: new AbortController(),
		active: new Set<Promise<boolean>>(),
	};
	const backgroundJobs = {
		stopping: false,
		controller: new AbortController(),
		active: new Set<Promise<boolean>>(),
	};
	const controller = legacyBackgroundJobs.controller;
	const state = { running: normal };
	const jobs = {
		clear: { complete: false, paused: false },
		restore: { complete: false, paused: true },
	};
	const empty = {
		visited: [],
		envelopes: [],
		mismatched: [],
		checked: 0,
		lastRowid: 0,
		done: true,
	};
	const defaultReader = mock(async () => empty);
	const defaultBlockReader = {
		backfill: mock(async () => empty),
		verify: mock(async () => empty),
		reindex: mock(async () => empty),
	};
	const projection = {
		running: !normal,
		inFlight: false,
		epoch: 0,
		timer: undefined as number | undefined,
		pendingRead: undefined as typeof defaultReader | undefined,
		upgrade: undefined as Promise<void> | undefined,
		upgradeTimer: undefined as number | undefined,
		upgradeResume: false,
		upgradeBackfill: undefined as
			| { reader: typeof defaultBlockReader; readProjection: typeof defaultReader }
			| undefined,
	};
	const activeProjection = () =>
		(["clear", "restore"] as const).find((job) => !jobs[job].complete && !jobs[job].paused);
	let maxReads = 0;
	let legacyReads = 0;
	const runProjectionSlice = async (reader: typeof defaultReader) => {
		const job = activeProjection();
		if (backgroundJobs.stopping || !job) return false;
		const pending = reader().then(() => {
			jobs[job].complete = true;
			return true;
		});
		backgroundJobs.active.add(pending);
		maxReads = Math.max(maxReads, backgroundJobs.active.size + legacyBackgroundJobs.active.size);
		try {
			return await pending;
		} finally {
			backgroundJobs.active.delete(pending);
		}
	};
	const legacySlice = async () => {
		if (legacyBackgroundJobs.stopping) return false;
		legacyReads++;
		const pending = release.promise.then(() => true); // Deliberately ignores abort.
		legacyBackgroundJobs.active.add(pending);
		maxReads = Math.max(maxReads, backgroundJobs.active.size + legacyBackgroundJobs.active.size);
		try {
			return await pending;
		} finally {
			legacyBackgroundJobs.active.delete(pending);
		}
	};
	// Frozen pre-epoch runner: its successful callback always queues one more untracked turn.
	const legacyNext = () => {
		void legacySlice().then((ran) => {
			if (ran) schedule(legacyNext, 0);
			else projection.running = false;
		});
	};
	const automaticClears: string[] = [];
	if (normal)
		schedule(() => {
			state.running = false;
			if (!jobs.clear.paused) {
				automaticClears.push("clear");
				jobs.restore.paused = true;
				jobs.clear.paused = false;
			}
		}, 0);
	else legacyNext();
	let resumeBackfill = (_read: typeof defaultReader) => {};
	const resume = mock((_reader: typeof defaultBlockReader, readProjection: typeof defaultReader) =>
		resumeBackfill(readProjection),
	);
	const dependencies = {
		legacyBackgroundJobs,
		backgroundJobs,
		state,
		projection,
		legacyProjectionRunner: true,
		setTimeout: schedule,
		clearTimeout: (id: number) => timers.delete(id),
		workerProjectionReader: defaultReader,
		workerReader: defaultBlockReader,
		getDbReadSchedulingPressure: () => ({ shouldYield: false }),
		runProjectionSlice,
		hasSchema: () => true,
		activeProjection,
		projectionBlocked: () => null,
		jobState: (job: keyof typeof jobs) => jobs[job],
		PROJECTION_JOBS: ["clear", "restore"],
		pauseProjection: (job: keyof typeof jobs) => {
			jobs[job].paused = true;
		},
		database: {
			sqlite: {
				prepare: () => ({
					run: (_at: string, job: keyof typeof jobs) => {
						jobs[job].paused = false;
						jobs[job].complete = false;
					},
				}),
			},
		},
		blockBackfillStatus: () => ({ projectionRunning: projection.running, ...jobs }),
		startBlockBackfill: resume,
		stopBlockIndexBackgroundJobs: async () => {},
		logger: { warn: mock(() => {}) },
		AppError: Error,
	};
	const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(declarations);
	const api = new Function(
		...Object.keys(dependencies),
		`${compiled}\nreturn { upgradeLegacyProjectionRunner, startProjectionRunner, startProjectionJob,
			stopProjectionJobs, stopBlockBackgroundJobs, requestBackfill };`,
	)(...Object.values(dependencies)) as {
		upgradeLegacyProjectionRunner(): void;
		startProjectionRunner(reader?: typeof defaultReader): void;
		startProjectionJob(job: keyof typeof jobs, reader?: typeof defaultReader): void;
		stopProjectionJobs(): void;
		stopBlockBackgroundJobs(options: { deadlineAt: number }): Promise<void>;
		requestBackfill(reader: typeof defaultBlockReader, readProjection: typeof defaultReader): void;
	};
	resumeBackfill = (reader) => api.startProjectionRunner(reader);
	return {
		api,
		jobs,
		projection,
		backgroundJobs,
		legacyBackgroundJobs,
		controller,
		defaultReader,
		defaultBlockReader,
		timers,
		release,
		automaticClears,
		resume,
		maxReads: () => maxReads,
		legacyReads: () => legacyReads,
		async turn(delay: number) {
			const entry = [...timers].find(([, timer]) => timer.delay === delay);
			if (!entry) throw new Error(`Missing ${delay}ms lifecycle turn`);
			timers.delete(entry[0]);
			entry[1].callback();
			for (let flush = 0; flush < 8; flush++) await Promise.resolve();
		},
		async flush() {
			for (let flush = 0; flush < 8; flush++) await Promise.resolve();
		},
	};
}

describe("legacy projection runner upgrade", () => {
	test("an ignoring-abort old slice and its final timer drain before a changed-job reader starts", async () => {
		const fixture = legacyProjectionHarness();
		const restore = mock(async () => ({
			visited: [],
			envelopes: [],
			mismatched: [],
			checked: 0,
			lastRowid: 0,
			done: true,
		}));
		fixture.api.upgradeLegacyProjectionRunner();
		expect(fixture.controller.signal.aborted).toBe(true);
		fixture.api.startProjectionJob("restore", restore);
		await fixture.turn(500);
		expect(restore).not.toHaveBeenCalled();
		expect(fixture.projection.running).toBe(true);
		fixture.release.resolve();
		await fixture.flush();
		await fixture.turn(500);
		expect(restore).not.toHaveBeenCalled();
		await fixture.turn(0); // Old runner observes stopping and sets its natural exit marker.
		await fixture.turn(500);
		expect(fixture.backgroundJobs.controller).not.toBe(fixture.controller);
		expect(fixture.backgroundJobs.controller.signal.aborted).toBe(false);
		expect(fixture.legacyBackgroundJobs.stopping).toBe(true);
		expect(fixture.controller.signal.aborted).toBe(true);
		await fixture.turn(0);
		expect(restore).toHaveBeenCalledTimes(1);
		expect(fixture.defaultReader).not.toHaveBeenCalled();
		expect(fixture.legacyReads()).toBe(1);
		expect(fixture.maxReads()).toBe(1);
		expect(fixture.jobs.clear.paused).toBe(true);
		expect(fixture.jobs.restore.complete).toBe(true);
		expect(fixture.timers.size).toBe(0);
	});

	for (const action of ["stop", "shutdown"] as const) {
		test(`${action} during upgrade drains old callbacks without restarting`, async () => {
			const fixture = legacyProjectionHarness();
			fixture.api.upgradeLegacyProjectionRunner();
			let stopped: Promise<void> | undefined;
			if (action === "stop") fixture.api.stopProjectionJobs();
			else stopped = fixture.api.stopBlockBackgroundJobs({ deadlineAt: Date.now() + 10_000 });
			expect(fixture.projection.running).toBe(true);
			fixture.release.resolve();
			await fixture.flush();
			await fixture.turn(0);
			await fixture.turn(500);
			await stopped;
			expect(fixture.defaultReader).not.toHaveBeenCalled();
			expect(fixture.timers.size).toBe(0);
			expect(fixture.projection.running).toBe(false);
			expect(fixture.backgroundJobs.stopping).toBe(action === "shutdown");
			if (action === "stop")
				for (const job of Object.values(fixture.jobs)) expect(job.paused).toBe(true);
		});
	}

	for (const normal of [false, true]) {
		test(`an explicit backfill request preserves both injected readers during old ${normal ? "normal" : "projection"} work`, async () => {
			const fixture = legacyProjectionHarness(normal);
			const projectionReader = mock(async () => ({
				visited: [],
				envelopes: [],
				mismatched: [],
				checked: 0,
				lastRowid: 0,
				done: true,
			}));
			const blockReader = { ...fixture.defaultBlockReader };
			fixture.api.upgradeLegacyProjectionRunner();
			fixture.api.requestBackfill(blockReader, projectionReader);
			expect(fixture.resume).not.toHaveBeenCalled();
			fixture.release.resolve();
			await fixture.flush();
			await fixture.turn(0);
			await fixture.turn(500);
			expect(fixture.resume).toHaveBeenCalledWith(blockReader, projectionReader);
			await fixture.turn(0);
			expect(projectionReader).toHaveBeenCalledTimes(1);
			expect(fixture.defaultReader).not.toHaveBeenCalled();
			expect(fixture.timers.size).toBe(0);
		});
	}

	for (const latest of ["projection", "backfill"] as const) {
		test(`the latest ${latest} start supplies the reader after upgrade`, async () => {
			const fixture = legacyProjectionHarness();
			const result = {
				visited: [],
				envelopes: [],
				mismatched: [],
				checked: 0,
				lastRowid: 0,
				done: true,
			};
			const backfillReader = mock(async () => result);
			const explicitReader = mock(async () => result);
			fixture.api.upgradeLegacyProjectionRunner();
			if (latest === "projection") {
				fixture.api.requestBackfill(fixture.defaultBlockReader, backfillReader);
				fixture.api.startProjectionJob("restore", explicitReader);
			} else {
				fixture.api.startProjectionJob("restore", explicitReader);
				fixture.api.requestBackfill(fixture.defaultBlockReader, backfillReader);
			}
			fixture.release.resolve();
			await fixture.flush();
			await fixture.turn(0);
			await fixture.turn(500);
			await fixture.turn(0);
			expect(latest === "projection" ? explicitReader : backfillReader).toHaveBeenCalledTimes(1);
			expect(latest === "projection" ? backfillReader : explicitReader).not.toHaveBeenCalled();
			expect(fixture.defaultReader).not.toHaveBeenCalled();
			expect(fixture.timers.size).toBe(0);
		});
	}

	for (const explicitRestore of [false, true]) {
		test(`legacy normal exit preserves ${explicitRestore ? "explicit restore" : "automatic clear"} intent`, async () => {
			const fixture = legacyProjectionHarness(true);
			fixture.api.upgradeLegacyProjectionRunner();
			if (explicitRestore) fixture.api.startProjectionJob("restore");
			await fixture.turn(0); // Baseline normal runner's final metadata/automatic-clear branch.
			await fixture.turn(500);
			await fixture.turn(0);
			expect(fixture.automaticClears).toEqual(explicitRestore ? [] : ["clear"]);
			expect(fixture.jobs[explicitRestore ? "restore" : "clear"].complete).toBe(true);
			expect(fixture.defaultReader).toHaveBeenCalledTimes(1);
			expect(fixture.maxReads()).toBe(1);
			expect(fixture.resume).toHaveBeenCalledTimes(1);
			expect(fixture.timers.size).toBe(0);
		});
	}
});

describe("production projection reader never decodes on the service thread", () => {
	const failures: Array<[string, Error]> = [
		["disabled", new workerPool.WorkersUnavailableError("disabled_by_env")],
		["zero concurrency", new workerPool.WorkersUnavailableError("concurrency_zero")],
		["creation failure", new workerPool.WorkersUnavailableError("worker_spawn_failed")],
		["ready failure", new workerPool.WorkersUnavailableError("worker_unavailable")],
		["exit", new Error("database worker closed")],
		["timeout", new workerPool.DbReadTaskTimeoutError("database read task timed out")],
		["cancel", new Error("database read task aborted")],
		["pool shutdown", new workerPool.WorkersUnavailableError("pool_shutdown")],
	];
	for (const job of ["clear", "restore"] as const) {
		for (const [failure, error] of failures) {
			test(`${job}: ${failure} stops with the projection and cursor unchanged`, async () => {
				const input = await narratorStore.appendInput("n1", "projection fixture");
				for (const name of ["convert", "verify", "reindex"])
					sqlite.run(
						"INSERT INTO narrator_block_backfill (job, complete, updated_at) VALUES (?, 1, ?)",
						[name, NOW],
					);
				sqlite.run(
					`INSERT INTO narrator_block_backfill (job, cursor, processed, paused, updated_at)
					 VALUES (?, 17, 3, 1, ?)`,
					[job, NOW],
				);
				if (job === "restore")
					sqlite.run(
						"UPDATE narrator_messages SET content_json = '[]', body_rows_only = 1 WHERE id = ?",
						[input.id],
					);
				settings.narratorBlocks.compactJson = job === "clear";
				const before = column(input.id);
				const worker = spyOn(workerPool, "runReadTask").mockRejectedValue(error);
				const decode = spyOn(workerCore, "runBlockProjectionSlice");
				const warn = spyOn(logger, "warn").mockImplementation(() => {});
				try {
					backfill.startProjectionJob(job);
					await settled();
					expect(worker).toHaveBeenCalledTimes(1);
					expect(worker.mock.calls[0]?.[1]).toMatchObject({
						kind: "blockProjectionSlice",
						job,
						afterRowid: 17,
					});
					expect(decode).not.toHaveBeenCalled();
					expect(column(input.id)).toEqual(before);
					expect(backfill.blockBackfillStatus()[job]).toMatchObject({
						cursor: 17,
						processed: 3,
						complete: false,
					});
					expect(backfill.blockBackfillStatus().projectionRunning).toBe(false);
					expect(warn).toHaveBeenCalledWith(
						"Projection job stopped; it resumes at the next start",
						{ error: String(error) },
					);
				} finally {
					worker.mockRestore();
					decode.mockRestore();
					warn.mockRestore();
				}
			});
		}
	}
});
