/**
 * Rows-only envelopes (docs/BLOCK_STORAGE-DESIGN.md §10.4, P3b): `content_json` holds `[]`,
 * `body_rows_only = 1`, and every reader, sync and state write goes to the block rows —
 * also while a ledger change has the envelope queued, and also with the read switch off.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { assembleContent } from "@shared/narrator-blocks/storage";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

// narrator-service must be imported before narrator-persistence (pre-existing cycle).
const { narratorService } = await import("../narrator-service");
const { narratorStore } = await import("../narrator-store");
const { narratorPersistence } = await import("../narrator-persistence");
const { settings } = await import("../../lib/settings");
const blockSync = await import("../narrator-block-sync");
const scans = await import("../narrator-block-scans");
const bodies = await import("../narrator-body-writes");
const { queryModelHistory, sqliteHistoryQuery } = await import(
	"../agent-runtime/model-history-query"
);
const { runDisplayPageQuery } = await import("../../lib/db-worker/display-page-query");
const { loadModelHistorySource } = await import("../agent-runtime/model-history-source");
const { exportBodiesFromBlocks } = await import("../narrator-export");

const NOW = "2026-10-01T00:00:00.000Z";

beforeEach(() => {
	cleanDb(sqlite);
	sqlite.run("INSERT INTO narrators (id, title, created_at, updated_at) VALUES ('n1', 'N', ?, ?)", [
		NOW,
		NOW,
	]);
	scans.noteRowsOnlyEnvelopes(undefined);
});
afterEach(() => {
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
	return { inputId: input.id, stepId: step.id, toolCallId };
}

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

const column = (messageId: string) =>
	sqlite
		.prepare("SELECT content_json AS c, body_rows_only AS r FROM narrator_messages WHERE id = ?")
		.get(messageId) as { c: string; r: number };

/** What the clearing job does to one envelope: its projection goes, its rows stay. */
function makeRowsOnly(messageId: string): void {
	sqlite.run(
		`UPDATE narrator_messages SET content_json = '[]', body_rows_only = 1,
			state_revision = state_revision + 1 WHERE id = ?`,
		[messageId],
	);
	scans.noteRowsOnlyEnvelopes(true);
}

const queue = (messageId: string) =>
	sqlite.run("INSERT OR IGNORE INTO narrator_block_sync_queue (message_id) VALUES (?)", [
		messageId,
	]);

async function modelBodies(fromBlocks: boolean) {
	const source = await queryModelHistory(sqliteHistoryQuery(sqlite), {
		narratorId: "n1",
		versioned: true,
		bodiesFromBlocks: fromBlocks,
	});
	return new Map<string, unknown>(source.messages.map((row) => [row.id, row.contentJson]));
}

describe("rows-only envelopes", () => {
	test("every reader assembles them from their rows", async () => {
		const { inputId, stepId } = await conversation();
		const expected = new Map([inputId, stepId].map((id) => [id, assembled(id)]));
		makeRowsOnly(inputId);
		makeRowsOnly(stepId);
		expect(await modelBodies(true)).toEqual(expected);
		const page = runDisplayPageQuery(sqlite, {
			kind: "displayPageMessages",
			messageIds: [inputId, stepId],
			ioBudget: 1000,
			deadlineAt: Date.now() + 10_000,
			bodiesFromBlocks: true,
		});
		expect(new Map(page.messages.map((m) => [m.id, m.contentJson]))).toEqual(expected);
		expect(bodies.readEnvelopeBody(db, stepId)).toEqual(expected.get(stepId));
		// The page enriches tool_use elements with their ledger; the elements are the rows'.
		const pretext = await narratorService.getPretextDocumentPage("n1");
		const shape = (content: unknown) =>
			(content as Array<{ type: string; id?: string }>).map(({ type, id }) => ({ type, id }));
		expect(shape(pretext.messages.find((m) => m.id === stepId)?.contentJson)).toEqual(
			shape(expected.get(stepId)),
		);
	});

	test("a queued one still reads its rows, and its sync rebuilds from them", async () => {
		const { stepId } = await conversation();
		const body = assembled(stepId);
		makeRowsOnly(stepId);
		queue(stepId);
		expect(bodies.readEnvelopeBody(db, stepId)).toEqual(body);
		expect((await modelBodies(true)).get(stepId)).toEqual(body);
		blockSync.flushChangedEnvelopes();
		expect(assembled(stepId)).toEqual(body);
		expect(column(stepId)).toEqual({ c: "[]", r: 1 });
	});

	test("a ledger change on one re-derives its tool block from the rows", async () => {
		const { stepId, toolCallId } = await conversation();
		const body = assembled(stepId);
		makeRowsOnly(stepId);
		sqlite.run("UPDATE narrator_tool_calls SET status = 'fail' WHERE id = ?", [toolCallId ?? ""]);
		blockSync.flushChangedEnvelopes();
		expect(assembled(stepId)).toEqual(body);
		expect(
			sqlite
				.prepare("SELECT phase FROM narrator_blocks WHERE message_id = ? AND kind = 'tool'")
				.get(stepId),
		).toEqual({ phase: "done" });
	});

	test("a state write lands on the rows, queued or not", async () => {
		const { stepId } = await conversation();
		makeRowsOnly(stepId);
		queue(stepId);
		expect(
			await narratorPersistence.patchReasoningTranslation(stepId, 0, "pensando", {
				id: "r1",
				text: "thinking",
			}),
		).toBe(true);
		expect(assembled(stepId)[0]).toMatchObject({ id: "r1", translatedText: "pensando" });
	});

	test("the audit and a column resync leave them alone", async () => {
		const { stepId } = await conversation();
		const body = assembled(stepId);
		makeRowsOnly(stepId);
		expect(blockSync.auditRecentEnvelopes()).toEqual([]);
		db.transaction(() => blockSync.resyncFromColumn(stepId));
		expect(assembled(stepId)).toEqual(body);
	});

	test("with the read switch off, they are still read from their rows", async () => {
		const { stepId } = await conversation();
		const body = assembled(stepId);
		makeRowsOnly(stepId);
		settings.narratorBlocks.read = false;
		expect(scans.blockReadsEnabled()).toBe(true);
		expect(bodies.readEnvelopeBody(db, stepId)).toEqual(body);
		// Readers that decide for themselves (model history, export) follow the same rule.
		const source = await loadModelHistorySource({ backend: "sqlite", sqlite }, "n1");
		expect<unknown>(source.messages.find((m) => m.id === stepId)?.contentJson).toEqual(body);
		expect(exportBodiesFromBlocks()).toBe(true);
		// Once none is rows-only, the switch takes effect again.
		sqlite.run("UPDATE narrator_messages SET content_json = ?, body_rows_only = 0 WHERE id = ?", [
			JSON.stringify(body),
			stepId,
		]);
		scans.noteRowsOnlyEnvelopes(undefined);
		expect(scans.blockReadsEnabled()).toBe(false);
	});
});

describe("with compactJson on", () => {
	beforeEach(() => {
		settings.narratorBlocks.compactJson = true;
	});
	afterEach(() => {
		settings.narratorBlocks.compactJson = false;
	});

	test("new envelopes keep their body only in their rows", async () => {
		const { inputId, stepId } = await conversation();
		for (const id of [inputId, stepId]) expect(column(id)).toEqual({ c: "[]", r: 1 });
		expect(assembled(inputId)).toEqual([{ type: "text", text: "list the files" }]);
		const history = await modelBodies(true);
		expect(history.get(inputId)).toEqual(assembled(inputId));
		expect(history.get(stepId)).toEqual(assembled(stepId));
		expect((assembled(stepId) as Array<{ type: string }>).map((e) => e.type)).toEqual([
			"reasoning",
			"tool_use",
		]);
	});

	test("compact markers keep their projection, so their lifecycle stays visible", async () => {
		await narratorStore.appendInput("n1", "before the compact");
		const marker = await narratorPersistence.persistCompactingMessage("n1");
		expect(column(marker.id).r).toBe(0);
		expect(
			sqlite
				.prepare("SELECT compact_pending AS p FROM narrator_messages WHERE id = ?")
				.get(marker.id),
		).toEqual({ p: 1 });
		await narratorPersistence.finalizeCompactingMessage(marker.id, "n1", "summary");
		expect(column(marker.id).r).toBe(0);
		expect(JSON.parse(column(marker.id).c)[0]).toMatchObject({
			type: "compact",
			summary: "summary",
		});
	});

	test("a copy of a shared rows-only envelope is rows-only and holds the same body", async () => {
		const { stepId } = await conversation();
		sqlite.run(
			"INSERT INTO narrators (id, title, created_at, updated_at) VALUES ('n2', 'B', ?, ?)",
			[NOW, NOW],
		);
		sqlite.run(
			"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES ('r2', 'n2', ?, 0)",
			[stepId],
		);
		const body = assembled(stepId);
		const copyId = await narratorPersistence.copyOnWriteMessage("n2", stepId, {
			contentText: "copied",
		});
		expect(copyId).not.toBe(stepId);
		expect(column(copyId)).toEqual({ c: "[]", r: 1 });
		expect(assembled(copyId)).toEqual(body);
	});

	test("edits and state writes keep a rows-only envelope rows-only", async () => {
		const { stepId } = await conversation();
		await narratorPersistence.patchReasoningTranslation(stepId, 0, "pensando", {
			id: "r1",
			text: "thinking",
		});
		expect(column(stepId)).toEqual({ c: "[]", r: 1 });
		expect(assembled(stepId)[0]).toMatchObject({ translatedText: "pensando" });
		await narratorService.deleteMessageBlock("n1", stepId, 0, { skipRevert: true });
		expect(column(stepId)).toEqual({ c: "[]", r: 1 });
		expect((assembled(stepId) as Array<{ type: string }>).map((e) => e.type)).toEqual(["tool_use"]);
	});

	test("once the switch is off, the next rewrite writes the projection back", async () => {
		const { inputId } = await conversation();
		expect(column(inputId).r).toBe(1);
		settings.narratorBlocks.compactJson = false;
		const edited = [{ type: "text", text: "edited" }];
		await narratorPersistence.copyOnWriteMessage("n1", inputId, {
			contentJson: edited,
			contentText: "edited",
		});
		expect(column(inputId)).toEqual({ c: JSON.stringify(edited), r: 0 });
		expect(assembled(inputId)).toEqual(edited);
	});

	test("the switch has no effect while block reads are off", async () => {
		settings.narratorBlocks.read = false;
		const { inputId } = await conversation();
		expect(column(inputId).r).toBe(0);
	});
});
