/**
 * The projection jobs (docs/BLOCK_STORAGE-DESIGN.md §10.4, P3b): `clear` drops verified
 * envelopes' `content_json`, leaving them rows-only; `restore` writes it back from the rows.
 * Neither changes what any reader reads, and each skips an envelope that changed after it
 * was read.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { assembleContent } from "@shared/narrator-blocks/storage";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

// narrator-service must be imported before narrator-persistence (pre-existing cycle).
await import("../narrator-service");
const { narratorStore } = await import("../narrator-store");
const { narratorPersistence } = await import("../narrator-persistence");
const { settings } = await import("../../lib/settings");
const blockSync = await import("../narrator-block-sync");
const scans = await import("../narrator-block-scans");
const bodies = await import("../narrator-body-writes");
const backfill = await import("../narrator-block-backfill");
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

/** Read slices on the test connection, as the inline fallback does. */
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
	await settled();
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
		.all();

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
