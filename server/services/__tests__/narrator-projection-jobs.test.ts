/**
 * The projection jobs (docs/BLOCK_STORAGE-DESIGN.md §10.4, P3b): `clear` drops verified
 * envelopes' `content_json`, leaving them rows-only; `restore` writes it back from the rows.
 * Neither changes what any reader reads, and each skips an envelope that changed after it
 * was read.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { assembleContent } from "@shared/narrator-blocks/storage";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
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
afterAll(() => {
	blockSync.stopBlockSyncSweep();
	mock.module("../../db", () => realDbModule);
	sqlite.close();
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
		settings.narratorBlocks.compactJson = false;
		backfill.startProjectionJob("restore", async (params) => {
			const slice = await read(params);
			await narratorPersistence.patchReasoningTranslation(stepId, 0, "pensando", {
				id: "r1",
				text: "thinking",
			});
			return slice;
		});
		await settled();
		expect(column(stepId)).toEqual({ c: JSON.stringify(assembled(stepId)), r: 0 });
		expect(JSON.parse(column(stepId).c)[0]).toMatchObject({ translatedText: "pensando" });
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
