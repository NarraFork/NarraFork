/**
 * Rewrites start from an envelope's rows, not its `content_json` (docs/BLOCK_STORAGE-DESIGN.md
 * §10.4, P3a). Each test detaches the column from the body first — it stops holding the
 * body, as it will once P3b stops writing it, and no sync is queued for it — and checks
 * that the operation reads the body from the rows and builds the new rows from what it
 * wrote.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createContextWorkState } from "@shared/context-work-state";
import { assembleContent } from "@shared/narrator-blocks/storage";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

// narrator-service must be imported before narrator-persistence (pre-existing cycle).
const { narratorService } = await import("../narrator-service");
const { narratorStore } = await import("../narrator-store");
const { narratorPersistence } = await import("../narrator-persistence");
const blockSync = await import("../narrator-block-sync");
const bodies = await import("../narrator-body-writes");
const session = await import("../narrator-session");

const NOW = "2026-10-01T00:00:00.000Z";

beforeEach(() => {
	cleanDb(sqlite);
	for (const id of ["n1", "n2"])
		sqlite.run("INSERT INTO narrators (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [
			id,
			`Narrator ${id}`,
			NOW,
			NOW,
		]);
});
afterAll(() => {
	blockSync.stopBlockSyncSweep();
	mock.module("../../db", () => realDbModule);
	sqlite.close();
});

/** What the envelope's rows assemble to. */
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
	JSON.parse(
		(
			sqlite
				.prepare("SELECT content_json AS c FROM narrator_messages WHERE id = ?")
				.get(messageId) as {
				c: string;
			}
		).c,
	);

const rowIds = (messageId: string) =>
	(
		sqlite
			.prepare("SELECT id FROM narrator_blocks WHERE message_id = ? ORDER BY ordinal")
			.all(messageId) as Array<{ id: string }>
	).map((row) => row.id);

/**
 * Make `content_json` stop holding the body without queueing a sync (a write that moves
 * `state_revision` is one the triggers leave alone).
 */
function detachColumn(messageId: string): void {
	sqlite.run(
		"UPDATE narrator_messages SET content_json = '[]', state_revision = state_revision + 1 WHERE id = ?",
		[messageId],
	);
	expect(sqlite.prepare("SELECT count(*) AS n FROM narrator_block_sync_queue").get()).toEqual({
		n: 0,
	});
}

async function step() {
	const opened = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
	const write = (item: Parameters<typeof narratorStore.writeStepItem>[2]) =>
		narratorStore.writeStepItem(opened.id, "n1", item);
	await write({ type: "reasoning", id: "r1", text: "think", completed: true, outputIndex: 0 });
	await write({ type: "text", id: "t1", text: "Hello.", completed: true, outputIndex: 1 });
	return opened.id;
}

function share(messageId: string) {
	sqlite.run(
		"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES ('r2', 'n2', ?, 0)",
		[messageId],
	);
}

describe("the body layer", () => {
	test("an insert and a rewrite build the rows from the body handed over", () => {
		db.transaction((tx) => {
			bodies.insertEnvelope(tx, {
				id: "m1",
				narratorId: "n1",
				role: "user",
				bodyFormat: 2,
				contentJson: [{ type: "text", text: "first" }],
				contentText: "first",
				createdAt: NOW,
			});
		});
		expect(assembled("m1")).toEqual([{ type: "text", text: "first" }]);
		const [blockId] = rowIds("m1");
		db.transaction((tx) =>
			bodies.writeEnvelopeBody(tx, "m1", [{ type: "text", text: "second" }], {
				set: { contentText: "second" },
			}),
		);
		expect(assembled("m1")).toEqual([{ type: "text", text: "second" }]);
		expect(rowIds("m1")).toEqual([blockId]);
		expect(bodies.readEnvelope(db, "m1")).toMatchObject({
			contentText: "second",
			contentJson: [{ type: "text", text: "second" }],
		});
	});

	test("a sync without a body keeps the rows the envelope's body is", async () => {
		const messageId = await step();
		const before = assembled(messageId);
		detachColumn(messageId);
		db.transaction(() => blockSync.syncEnvelopeNow(messageId));
		expect(assembled(messageId)).toEqual(before);
		expect(bodies.readEnvelopeBody(db, messageId)).toEqual(before);
	});
});

describe("rewrites read the rows", () => {
	test("a copy-on-write copies the body from the rows", async () => {
		const messageId = await step();
		const body = assembled(messageId);
		share(messageId);
		detachColumn(messageId);
		const copyId = await narratorPersistence.copyOnWriteMessage("n2", messageId, {
			contentText: "edited",
		});
		expect(copyId).not.toBe(messageId);
		expect(assembled(copyId)).toEqual(body);
		expect(column(copyId)).toEqual(body);
		expect(assembled(messageId)).toEqual(body);
	});

	test("an unshared rewrite writes its body and rebuilds the rows from it", async () => {
		const messageId = await step();
		detachColumn(messageId);
		const edited = [{ type: "text", text: "Rewritten." }];
		const id = await narratorPersistence.copyOnWriteMessage("n1", messageId, {
			contentJson: edited,
			contentText: "Rewritten.",
		});
		expect(id).toBe(messageId);
		expect(assembled(messageId)).toEqual(edited);
		expect(column(messageId)).toEqual(edited);
	});

	test("a state patch changes the rows' state and keeps the rest of the body", async () => {
		const messageId = await step();
		const body = assembled(messageId) as Array<Record<string, unknown>>;
		detachColumn(messageId);
		expect(
			await narratorPersistence.patchReasoningTranslation(messageId, 0, "pensar", {
				id: "r1",
				text: "think",
			}),
		).toBe(true);
		expect(assembled(messageId)).toEqual([{ ...body[0], translatedText: "pensar" }, body[1]]);
	});

	test("a body patch rebuilds the rows from the patched body", async () => {
		const messageId = await step();
		const body = assembled(messageId) as Array<Record<string, unknown>>;
		detachColumn(messageId);
		narratorPersistence.patchState(messageId, (content) => content.slice(0, 1));
		expect(assembled(messageId)).toEqual([body[0]]);
	});
});

describe("store writes read the rows", () => {
	test("a step item lands among the items the rows hold", async () => {
		const messageId = await step();
		const body = assembled(messageId);
		detachColumn(messageId);
		await narratorStore.writeStepItem(messageId, "n1", {
			type: "text",
			id: "t2",
			text: "More.",
			completed: true,
			outputIndex: 2,
		});
		expect(assembled(messageId)).toEqual([
			...body,
			expect.objectContaining({ type: "text", id: "t2", text: "More." }),
		]);
		expect(column(messageId)).toEqual(assembled(messageId));
	});

	test("a tool call's input is overwritten in the body the rows hold", async () => {
		const messageId = await step();
		const call = await narratorStore.writeStepItem(messageId, "n1", {
			type: "tool_use",
			id: "c1",
			name: "Bash",
			input: { command: "ls" },
			outputIndex: 2,
		});
		const body = assembled(messageId) as Array<Record<string, unknown>>;
		detachColumn(messageId);
		await narratorPersistence.overwriteToolCallInput("c1", { command: "ls -la" }, call);
		expect(assembled(messageId)).toEqual([
			body[0],
			body[1],
			{ ...body[2], input: { command: "ls -la" } },
		]);
	});

	test("a compact finalizes from the marker the rows hold", async () => {
		await narratorStore.appendInput("n1", "before the compact");
		const marker = await narratorPersistence.persistCompactingMessage("n1");
		detachColumn(marker.id);
		const done = await narratorPersistence.finalizeCompactingMessage(marker.id, "n1", "summary");
		expect(done?.contentJson).toEqual([
			expect.objectContaining({ type: "compact", status: "compacted", summary: "summary" }),
		]);
		expect(assembled(marker.id)).toEqual(done?.contentJson as unknown[]);
	});

	test("a compact atomically persists observed work state with its handoff summary", async () => {
		await narratorStore.appendInput("n1", "before the compact");
		const marker = await narratorPersistence.persistCompactingMessage("n1");
		const workState = createContextWorkState({
			narratorId: "n1",
			capturedAt: NOW,
			workspace: { cwd: null, deviceId: null, revision: null, projectId: null },
			tasks: {
				revision: "tasks-v1",
				tasks: [{ text: "Keep unfinished work", status: "doing", protected: true }],
			},
			receipts: [],
		});
		const done = await narratorPersistence.finalizeCompactingMessage(
			marker.id,
			"n1",
			"model prose",
			undefined,
			{ workState },
		);
		expect(done?.contentJson).toEqual([
			expect.objectContaining({
				status: "compacted",
				workState,
				summary: expect.stringContaining("Keep unfinished work"),
			}),
		]);
		expect(assembled(marker.id)).toEqual(done?.contentJson as unknown[]);
		const row = sqlite.prepare("SELECT context_summary FROM narrators WHERE id = ?").get("n1") as {
			context_summary: string;
		};
		expect(row.context_summary).toContain("not authorization");
		expect(row.context_summary).toContain("model prose");
	});

	test("invalid or cross-narrator work state cannot advance a compact marker", async () => {
		await narratorStore.appendInput("n1", "before the compact");
		const marker = await narratorPersistence.persistCompactingMessage("n1");
		const before = assembled(marker.id);
		const state = createContextWorkState({
			narratorId: "n2",
			capturedAt: NOW,
			workspace: { cwd: null, deviceId: null, revision: null, projectId: null },
			tasks: null,
			receipts: [],
		});
		for (const workState of [
			state,
			{ ...state, version: 2 },
			{ ...state, narratorId: "n1", permissions: "all" },
		]) {
			await expect(
				narratorPersistence.finalizeCompactingMessage(marker.id, "n1", "summary", undefined, {
					workState,
				} as never),
			).rejects.toThrow(/work.state/i);
			expect(assembled(marker.id)).toEqual(before);
		}
	});

	test("an empty successful summary never commits a compact boundary", async () => {
		await narratorStore.appendInput("n1", "before the compact");
		const marker = await narratorPersistence.persistCompactingMessage("n1");
		const before = assembled(marker.id);
		await expect(
			narratorPersistence.finalizeCompactingMessage(marker.id, "n1", "   "),
		).rejects.toThrow(/empty summary/i);
		expect(assembled(marker.id)).toEqual(before);
	});

	test("a finalize whose marker moved on loses the compare-and-set", async () => {
		await narratorStore.appendInput("n1", "before the compact");
		const marker = await narratorPersistence.persistCompactingMessage("n1");
		const finished = await narratorPersistence.finalizeCompactingMessage(marker.id, "n1", "first");
		expect(finished).not.toBeNull();
		// A second finalize of the same attempt finds the marker compacted already.
		expect(
			await narratorPersistence.finalizeCompactingMessage(marker.id, "n1", "second"),
		).toBeNull();
		expect(assembled(marker.id)).toEqual([
			expect.objectContaining({ status: "compacted", summary: "first" }),
		]);
	});

	test("a segment compact retains work state and rejects empty or invalid handoffs", async () => {
		const input = await narratorStore.appendInput("n1", "hidden");
		const { message } = await narratorPersistence.persistSegmentCompactMarker("n1", [input.id]);
		const before = assembled(message.id);
		await expect(narratorPersistence.finalizeSegmentCompact(message.id, "n1", " ")).rejects.toThrow(
			/empty summary/i,
		);
		expect(assembled(message.id)).toEqual(before);
		const workState = createContextWorkState({
			narratorId: "n1",
			capturedAt: NOW,
			workspace: { cwd: null, deviceId: null, revision: null, projectId: null },
			tasks: null,
			receipts: [],
		});
		await expect(
			narratorPersistence.finalizeSegmentCompact(message.id, "n1", "summary", undefined, {
				workState: { ...workState, narratorId: "n2" },
			}),
		).rejects.toThrow(/work.state/i);
		expect(assembled(message.id)).toEqual(before);
		const done = await narratorPersistence.finalizeSegmentCompact(
			message.id,
			"n1",
			"summary",
			undefined,
			{ workState },
		);
		expect(done?.contentJson).toEqual([
			expect.objectContaining({
				status: "compacted",
				workState,
				summary: expect.stringContaining("not authorization"),
			}),
		]);
	});

	test("a finished segment rejects late success and failure writes", async () => {
		const input = await narratorStore.appendInput("n1", "hidden");
		const { message } = await narratorPersistence.persistSegmentCompactMarker("n1", [input.id]);
		expect(
			await narratorPersistence.finalizeSegmentCompact(message.id, "n1", "first"),
		).not.toBeNull();
		const before = assembled(message.id);
		expect(await narratorPersistence.finalizeSegmentCompact(message.id, "n1", "late")).toBeNull();
		expect(
			await narratorPersistence.finalizeSegmentCompact(message.id, "n1", "failure", undefined, {
				status: "failed",
			}),
		).toBeNull();
		expect(assembled(message.id)).toEqual(before);
		expect(
			sqlite
				.query(
					"SELECT segment_compact_id AS marker FROM narrator_message_refs WHERE narrator_id = 'n1' AND message_id = ?",
				)
				.get(input.id),
		).toEqual({ marker: message.id });
	});

	test("a segment without its owning ref or full hidden set cannot finalize", async () => {
		const input = await narratorStore.appendInput("n1", "hidden");
		const { message } = await narratorPersistence.persistSegmentCompactMarker("n1", [input.id]);
		const before = assembled(message.id);
		sqlite.run("UPDATE narrator_message_refs SET segment_compact_id = NULL WHERE message_id = ?", [
			input.id,
		]);
		expect(await narratorPersistence.finalizeSegmentCompact(message.id, "n1", "stale")).toBeNull();
		sqlite.run("DELETE FROM narrator_message_refs WHERE narrator_id = 'n1' AND message_id = ?", [
			message.id,
		]);
		expect(await narratorPersistence.finalizeSegmentCompact(message.id, "n1", "orphan")).toBeNull();
		expect(assembled(message.id)).toEqual(before);
	});

	test("a shared segment finalizes copy-on-write and retains the sibling's hidden set", async () => {
		const input = await narratorStore.appendInput("n1", "hidden");
		const { message } = await narratorPersistence.persistSegmentCompactMarker("n1", [input.id]);
		const before = assembled(message.id);
		sqlite.run(
			"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq, is_compact, segment_compact_id) SELECT 'sibling-' || id, 'n2', message_id, seq, is_compact, segment_compact_id FROM narrator_message_refs WHERE narrator_id = 'n1'",
		);
		const done = await narratorPersistence.finalizeSegmentCompact(message.id, "n1", "first");
		expect(done).not.toBeNull();
		expect(done?.id).not.toBe(message.id);
		expect(assembled(message.id)).toEqual(before);
		expect(
			sqlite
				.query(
					"SELECT narrator_id AS narrator, segment_compact_id AS marker FROM narrator_message_refs WHERE message_id = ? ORDER BY narrator_id",
				)
				.all(input.id),
		).toEqual([
			{ narrator: "n1", marker: done?.id },
			{ narrator: "n2", marker: message.id },
		]);
		expect(await narratorPersistence.finalizeSegmentCompact(message.id, "n1", "stale")).toBeNull();
	});

	test("a segment compact's summary is rewritten from the rows", async () => {
		const input = await narratorStore.appendInput("n1", "hidden");
		const { message } = await narratorPersistence.persistSegmentCompactMarker("n1", [input.id]);
		await narratorPersistence.finalizeSegmentCompact(message.id, "n1", "first summary");
		detachColumn(message.id);
		await narratorPersistence.updateSegmentCompactSummary("n1", message.id, "second summary");
		expect(assembled(message.id)).toEqual([
			{ type: "segment_compact", status: "compacted", summary: "second summary", messageCount: 1 },
		]);
	});

	test("a discarded attempt drops its blocks from the rows' body", async () => {
		const opened = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
		await narratorStore.writeStepItem(
			opened.id,
			"n1",
			{ type: "text", id: "t1", text: "kept", completed: true, outputIndex: 0 },
			{ attemptId: "a1" },
		);
		await narratorStore.writeStepItem(
			opened.id,
			"n1",
			{ type: "text", id: "t2", text: "dropped", completed: true, outputIndex: 1 },
			{ attemptId: "a2" },
		);
		detachColumn(opened.id);
		await narratorStore.discardAttempt("n1", opened.id, 1, "a2");
		expect(assembled(opened.id)).toEqual([
			expect.objectContaining({ type: "text", id: "t1", text: "kept" }),
		]);
	});
});

describe("history edits read the rows", () => {
	test("deleting a block keeps the others the rows hold", async () => {
		const messageId = await step();
		const body = assembled(messageId);
		detachColumn(messageId);
		await narratorService.deleteMessageBlock("n1", messageId, 1, { skipRevert: true });
		expect(assembled(messageId)).toEqual([body[0]]);
		expect(column(messageId)).toEqual([body[0]]);
	});

	test("editing an output block rewrites it within the body the rows hold", async () => {
		const messageId = await step();
		const body = assembled(messageId) as Array<Record<string, unknown>>;
		const [, outputBlock] = rowIds(messageId);
		detachColumn(messageId);
		await session.editOutputBlock("n1", outputBlock, "Edited.", null);
		expect(assembled(messageId)).toEqual([
			body[0],
			expect.objectContaining({ type: "text", text: "Edited." }),
		]);
	});

	test("a compact summary is rewritten from the rows", async () => {
		const plan = await narratorPersistence.persistPlanMessage("n1", "first plan");
		detachColumn(plan.id);
		await narratorService.updateCompactSummary("n1", plan.id, "second plan");
		expect(assembled(plan.id)).toEqual([
			{ type: "compact", status: "compacted", subtype: "plan", summary: "second plan" },
		]);
	});
});

describe("output recovery reads the rows", () => {
	async function streaming() {
		const opened = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
		await narratorStore.writeStepItem(opened.id, "n1", {
			type: "text",
			id: "t1",
			text: "Done.",
			completed: true,
			outputIndex: 0,
		});
		await narratorStore.writeStepItem(opened.id, "n1", {
			type: "text",
			id: "t2",
			text: "Half",
			completed: false,
			outputIndex: 1,
		});
		return opened.id;
	}

	test("a cold cleanup drops the incomplete output the rows hold", async () => {
		const messageId = await streaming();
		detachColumn(messageId);
		const { cleanupIncompleteNarratorOutput } = await import("../narrator-output-recovery");
		expect(await cleanupIncompleteNarratorOutput("n1")).toEqual({ messageId, removedBlocks: 1 });
		expect(assembled(messageId)).toEqual([
			expect.objectContaining({ type: "text", id: "t1", text: "Done." }),
		]);
	});

	test("completing the output marks what the rows hold complete", async () => {
		const messageId = await streaming();
		detachColumn(messageId);
		const { completeAssistantOutput } = await import("../narrator-output-recovery");
		await completeAssistantOutput("n1", messageId);
		expect(assembled(messageId)).toEqual([
			expect.objectContaining({ id: "t1", completed: true }),
			expect.objectContaining({ id: "t2", text: "Half", completed: true }),
		]);
	});
});

describe("bounded body reads", () => {
	test("a body read from its rows has the length the column measured", async () => {
		const messageId = await step();
		await narratorPersistence.patchReasoningTranslation(messageId, 0, "思考：译文", {
			id: "r1",
			text: "think",
		});
		const { bodyLengthSql, boundedBodyText } = await import("../../lib/narrator-bodies");
		const length = () =>
			(
				sqlite
					.prepare(`SELECT ${bodyLengthSql("m", true)} AS n FROM narrator_messages m WHERE id = ?`)
					.get(messageId) as { n: number }
			).n;
		const columnBytes = Buffer.byteLength(JSON.stringify(column(messageId)));
		expect(length()).toBe(columnBytes);
		detachColumn(messageId);
		expect(length()).toBe(columnBytes);
		const text = boundedBodyText(sqlite, messageId, true, { maxBytes: 1 << 20 });
		expect(JSON.parse(text ?? "null")).toEqual(assembled(messageId));
		expect(Buffer.byteLength(text ?? "")).toBe(columnBytes);
		expect(boundedBodyText(sqlite, messageId, true, { maxBytes: columnBytes - 1 })).toBeUndefined();
		expect(
			boundedBodyText(sqlite, messageId, true, { maxBytes: 1 << 20, exactBytes: columnBytes + 1 }),
		).toBeUndefined();
	});
});
