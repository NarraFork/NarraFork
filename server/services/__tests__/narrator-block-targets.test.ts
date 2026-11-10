/**
 * Operations addressed by block id (docs/BLOCK_STORAGE-DESIGN.md §5.5): each target is a
 * whole block, resolved to the elements it holds, whether its envelope has rows or is
 * still legacy and decoded on read.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { assembleContent } from "@shared/narrator-blocks/storage";
import { cleanDb, getTestDb, readTestMessageContent } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

// narrator-service must be imported before narrator-persistence (pre-existing cycle).
const { narratorService } = await import("../narrator-service");
const { narratorStore } = await import("../narrator-store");
const { settings } = await import("../../lib/settings");
const compactJson = settings.narratorBlocks.compactJson;
const blockSync = await import("../narrator-block-sync");
const targets = await import("../narrator-block-targets");
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
afterEach(() => {
	settings.narratorBlocks.write = true;
	settings.narratorBlocks.compactJson = compactJson;
});
afterAll(() => {
	blockSync.stopBlockSyncSweep();
	mock.module("../../db", () => realDbModule);
	sqlite.close();
});

interface Row {
	id: string;
	kind: string;
	payload: string;
	state: string | null;
	originalPayload: string | null;
}

function rows(messageId: string): Row[] {
	return sqlite
		.prepare(
			`SELECT id, kind, payload, state, original_payload AS originalPayload
			 FROM narrator_blocks WHERE message_id = ? ORDER BY ordinal`,
		)
		.all(messageId) as Row[];
}

function content(messageId: string): Array<Record<string, unknown>> {
	return readTestMessageContent(sqlite, messageId);
}

function assembled(messageId: string): unknown[] {
	return assembleContent(
		rows(messageId).map((row) => ({
			payload: JSON.parse(row.payload),
			state: row.state ? JSON.parse(row.state) : null,
		})),
	);
}

const ledger = (messageId: string) =>
	sqlite
		.prepare("SELECT tool_use_id AS toolUseId FROM narrator_tool_calls WHERE message_id = ?")
		.all(messageId) as Array<{ toolUseId: string }>;

/**
 * An assistant step of two reasoning items (a run), a text, a tool call and a second
 * text: the case where index-addressed edits merged texts across the tool.
 */
async function step(narratorId = "n1") {
	const opened = await narratorStore.openStep(narratorId, { uuid: "u", session_id: "s" });
	const write = (item: Parameters<typeof narratorStore.writeStepItem>[2]) =>
		narratorStore.writeStepItem(opened.id, narratorId, item);
	await write({
		type: "reasoning",
		id: "r1",
		text: "first thought",
		completed: true,
		outputIndex: 0,
	});
	await write({
		type: "reasoning",
		id: "r2",
		text: "second thought",
		completed: true,
		outputIndex: 1,
	});
	await write({
		type: "text",
		id: "t1",
		text: "Before the tool.",
		completed: true,
		outputIndex: 2,
		citations: [{ startIndex: 0, endIndex: 6, sources: [{ title: "Doc", url: "https://e.x" }] }],
	});
	const toolCallId = await write({
		type: "tool_use",
		id: "c1",
		name: "Bash",
		input: { command: "ls" },
		outputIndex: 3,
	});
	await narratorStore.settleTool(
		"c1",
		{ output: "a.txt", status: "success" },
		opened.id,
		toolCallId,
	);
	await write({ type: "text", id: "t2", text: "After the tool.", completed: true, outputIndex: 4 });
	return opened.id;
}

const blockOf = (messageId: string, kind: string, nth = 0) =>
	rows(messageId).filter((row) => row.kind === kind)[nth].id;

describe("resolving block ids", () => {
	test("a block row resolves to the element range it holds", async () => {
		const input = await narratorStore.appendInput("n1", "list the files");
		const stepId = await step();
		const [inputTarget, run1, run2, text1, tool, text2] = targets.resolveBlockTargets("n1", [
			blockOf(input.id, "input"),
			blockOf(stepId, "reasoning", 0),
			blockOf(stepId, "reasoning", 1),
			blockOf(stepId, "output", 0),
			blockOf(stepId, "tool"),
			blockOf(stepId, "output", 1),
		]);
		expect([inputTarget.from, inputTarget.to]).toEqual([0, content(input.id).length]);
		expect(
			[run1, run2, text1, tool, text2].map((target) => content(stepId)[target.from].type),
		).toEqual(["reasoning", "reasoning", "text", "tool_use", "text"]);
		expect(tool).toMatchObject({ kind: "tool", wireId: "c1", messageId: stepId });
		expect(text2.to).toBe(content(stepId).length);
	});

	test("a legacy envelope's blocks resolve through the ids the decoder gives them", async () => {
		settings.narratorBlocks.write = false;
		const stepId = await step();
		expect(rows(stepId)).toEqual([]);
		const tool = content(stepId).findIndex((element) => element.type === "tool_use");
		const [target] = targets.resolveBlockTargets("n1", [`${stepId}:${tool}`]);
		expect(target).toMatchObject({ rowId: null, kind: "tool", wireId: "c1", from: tool });
	});

	test("a block outside the narrator's history, or one replaced since, is refused", async () => {
		const stepId = await step();
		expect(() => targets.resolveBlockTargets("n2", [blockOf(stepId, "tool")])).toThrow();
		expect(() => targets.resolveBlockTargets("n1", [`${stepId}:99`])).toThrow(
			"Message history changed",
		);
		expect(() => targets.resolveBlockTargets("n1", ["no-such-block"])).toThrow();
	});

	test("a tool block's call element is found past elements that ride with it", async () => {
		// Exercise a legacy writer changing the dual-written projection.
		settings.narratorBlocks.compactJson = false;
		const stepId = await step();
		const tool = content(stepId).find((element) => element.type === "tool_use");
		// Content written outside the store: an element without a block of its own leads.
		sqlite.run("UPDATE narrator_messages SET content_json = ? WHERE id = ?", [
			JSON.stringify([{ type: "bash_display", text: "$ ls" }, tool]),
			stepId,
		]);
		const [target] = targets.resolveBlockTargets("n1", [blockOf(stepId, "tool")]);
		expect([target.from, target.to]).toEqual([0, 2]);
		expect(targets.toolElementIndex(target)).toBe(1);
	});

	test("converted envelopes resolve without parsing their content", async () => {
		const stepId = await step();
		const tool = blockOf(stepId, "tool");
		const [before] = targets.resolveBlockTargets("n1", [tool]);
		sqlite.run("UPDATE narrator_messages SET content_json = '\"unreadable\"' WHERE id = ?", [
			stepId,
		]);
		sqlite.run("DELETE FROM narrator_block_sync_queue");
		expect(targets.resolveBlockTargets("n1", [tool])).toEqual([before]);
	});

	test("an envelope waiting in the sync queue is brought current first", async () => {
		settings.narratorBlocks.compactJson = false;
		const stepId = await step();
		const kept = blockOf(stepId, "tool");
		sqlite.run("UPDATE narrator_messages SET content_json = ? WHERE id = ?", [
			JSON.stringify(content(stepId).filter((element) => element.id !== "r1")),
			stepId,
		]);
		const [target] = targets.resolveBlockTargets("n1", [kept]);
		// The tool block kept its id; it moved one element up.
		expect(content(stepId)[target.from]).toMatchObject({ type: "tool_use", id: "c1" });
		expect(sqlite.prepare("SELECT count(*) AS n FROM narrator_block_sync_queue").get()).toEqual({
			n: 0,
		});
	});
});

describe("operations by block id", () => {
	test("deleting a tool block removes every ledger attempt of its call", async () => {
		const stepId = await step();
		sqlite.run(
			`INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name,
				input_json, output_json, status, execution_attempt, created_at)
			 VALUES ('retry', 'n1', ?, 'c1', 'Bash', '{}', '"again"', 'success', 2, ?)`,
			[stepId, NOW],
		);
		expect(ledger(stepId)).toHaveLength(2);
		const result = await narratorService.deleteBlocks("n1", [blockOf(stepId, "tool")], {
			skipRevert: true,
		});
		expect(result.results).toEqual([
			expect.objectContaining({ messageId: stepId, messageDeleted: false }),
		]);
		expect(ledger(stepId)).toEqual([]);
		expect(content(stepId).map((element) => element.type)).toEqual([
			"reasoning",
			"reasoning",
			"text",
			"text",
		]);
		// The deletion rebuilds the envelope's rows in its own transaction.
		expect(assembled(stepId)).toEqual(content(stepId));
	});

	test("deleting an input block removes the whole message, attachments included", async () => {
		const input = await narratorStore.appendInput("n1", "see this", [
			{ type: "image", imageId: "img1", filename: "a.png", mediaType: "image/png" },
			{ type: "text", text: "see this" },
		]);
		await narratorService.deleteBlocks("n1", [blockOf(input.id, "input")], { skipRevert: true });
		expect(
			sqlite
				.prepare("SELECT count(*) AS n FROM narrator_message_refs WHERE message_id = ?")
				.get(input.id),
		).toEqual({ n: 0 });
	});

	test("rolling back to a reasoning run keeps the whole run", async () => {
		const stepId = await step();
		const later = await narratorStore.appendInput("n1", "and then?");
		await session.rollbackToBlocks(
			"n1",
			[blockOf(stepId, "reasoning", 0), blockOf(stepId, "reasoning", 1)],
			{ skipRevert: true },
		);
		expect(content(stepId).map((element) => element.id)).toEqual(["r1", "r2"]);
		expect(
			sqlite
				.prepare("SELECT count(*) AS n FROM narrator_message_refs WHERE message_id = ?")
				.get(later.id),
		).toEqual({ n: 0 });
	});

	test("editing an output block changes only that block, and restore brings it back", async () => {
		const stepId = await step();
		const before = content(stepId);
		const second = blockOf(stepId, "output", 1);
		const edited = await session.editOutputBlock("n1", second, "Rewritten after the tool.", null);
		expect(edited.blockId).toBe(second);
		const after = content(stepId);
		// The first text, the run and the tool are untouched and in place.
		expect(after.slice(0, 4)).toEqual(before.slice(0, 4));
		expect(after[4]).toEqual({
			type: "text",
			id: "t2",
			text: "Rewritten after the tool.",
			completed: true,
		});
		expect(
			JSON.parse(rows(stepId).find((row) => row.id === second)?.originalPayload ?? "null"),
		).toEqual({
			raw: [before[4]],
		});
		expect(assembled(stepId)).toEqual(after);

		await session.restoreOutputBlock("n1", second);
		expect(content(stepId)).toEqual(before);
		expect(rows(stepId).every((row) => row.originalPayload === null)).toBe(true);
		const edits = sqlite
			.prepare(
				"SELECT edited_at AS editedAt, original_content_json AS original FROM narrator_messages WHERE id = ?",
			)
			.get(stepId);
		expect(edits).toEqual({ editedAt: null, original: null });
	});

	test("an edit keeps only the citations whose span still reads the same", async () => {
		const stepId = await step();
		await session.editOutputBlock("n1", blockOf(stepId, "output", 0), "Before everything.", null);
		expect(content(stepId)[2]).toMatchObject({ text: "Before everything." });
		expect(content(stepId)[2].citations).toHaveLength(1);
		await session.editOutputBlock("n1", blockOf(stepId, "output", 0), "Nothing alike.", null);
		expect(content(stepId)[2].citations).toBeUndefined();
		// The second edit kept the body from before the first one.
		expect(
			JSON.parse(rows(stepId).find((row) => row.kind === "output")?.originalPayload ?? "null")
				.raw[0].text,
		).toBe("Before the tool.");
	});

	test("editing a shared envelope copies it for the editor; the copy can be restored", async () => {
		const stepId = await step();
		sqlite.run(
			"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES ('fork-ref', 'n2', ?, 1)",
			[stepId],
		);
		const original = content(stepId);
		const edited = await session.editOutputBlock("n1", blockOf(stepId, "output", 1), "Mine.", null);
		expect(edited.messageId).not.toBe(stepId);
		expect(content(stepId)).toEqual(original);
		expect(content(edited.messageId)[4]).toMatchObject({ text: "Mine." });
		await session.restoreOutputBlock("n1", edited.blockId);
		expect(content(edited.messageId)).toEqual(original);
	});

	test("an unconverted envelope gets its rows when one of its blocks is edited", async () => {
		settings.narratorBlocks.write = false;
		const stepId = await step();
		settings.narratorBlocks.write = true;
		const text = content(stepId).findIndex((element) => element.id === "t2");
		const edited = await session.editOutputBlock("n1", `${stepId}:${text}`, "Converted.", null);
		expect(rows(stepId).length).toBeGreaterThan(0);
		expect(rows(stepId).find((row) => row.id === edited.blockId)?.originalPayload).not.toBeNull();
		expect(assembled(stepId)).toEqual(content(stepId));
	});

	test("only output blocks are edited, and a block's detail carries its full body", async () => {
		const stepId = await step();
		await expect(session.editOutputBlock("n1", blockOf(stepId, "tool"), "x", null)).rejects.toThrow(
			"Only an output block",
		);
		const [target] = targets.resolveBlockTargets("n1", [blockOf(stepId, "reasoning", 1)]);
		expect(targets.blockDetail(target)).toMatchObject({
			kind: "reasoning",
			phase: "done",
			elements: [expect.objectContaining({ id: "r2", text: "second thought" })],
			originalElements: null,
		});
	});
});

/** A step of id-less texts around a tool call: blocks keyed only by type and position. */
async function idlessStep(texts: [string, string], narratorId = "n1") {
	const opened = await narratorStore.openStep(narratorId, { uuid: "u", session_id: "s" });
	const write = (item: Parameters<typeof narratorStore.writeStepItem>[2]) =>
		narratorStore.writeStepItem(opened.id, narratorId, item);
	await write({ type: "text", text: texts[0], completed: true, outputIndex: 0 } as never);
	await write({
		type: "tool_use",
		id: "c1",
		name: "Bash",
		input: { command: "ls" },
		outputIndex: 1,
	});
	await write({ type: "text", text: texts[1], completed: true, outputIndex: 2 } as never);
	return opened.id;
}

const texts = (messageId: string) =>
	content(messageId)
		.filter((element) => element.type === "text")
		.map((element) => element.text);

describe("block ids survive deletes and edits of their neighbours", () => {
	test("a retried delete fails instead of removing the block that moved up", async () => {
		const stepId = await idlessStep(["Alpha", "Beta"]);
		const [alpha, beta] = [blockOf(stepId, "output", 0), blockOf(stepId, "output", 1)];
		await narratorService.deleteBlocks("n1", [alpha], { skipRevert: true });
		expect(texts(stepId)).toEqual(["Beta"]);
		expect(blockOf(stepId, "output")).toBe(beta);
		await expect(
			narratorService.deleteBlocks("n1", [alpha], { skipRevert: true }),
		).rejects.toThrow();
		expect(texts(stepId)).toEqual(["Beta"]);
	});

	test("of two identical texts, the one not deleted keeps its id", async () => {
		for (const deleted of [0, 1]) {
			cleanDb(sqlite);
			sqlite.run(
				"INSERT INTO narrators (id, title, created_at, updated_at) VALUES ('n1', 'N', ?, ?)",
				[NOW, NOW],
			);
			const stepId = await idlessStep(["Done.", "Done."]);
			const ids = [blockOf(stepId, "output", 0), blockOf(stepId, "output", 1)];
			await narratorService.deleteBlocks("n1", [ids[deleted]], { skipRevert: true });
			expect(rows(stepId).map((row) => row.id)).not.toContain(ids[deleted]);
			expect(blockOf(stepId, "output")).toBe(ids[1 - deleted]);
		}
	});

	test("a deleted block's pre-edit body stays with it, in place or in a copy", async () => {
		for (const shared of [false, true]) {
			cleanDb(sqlite);
			for (const id of ["n1", "n2"])
				sqlite.run(
					"INSERT INTO narrators (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
					[id, id, NOW, NOW],
				);
			const stepId = await idlessStep(["Alpha original", "Beta original"]);
			await session.editOutputBlock("n1", blockOf(stepId, "output", 0), "Alpha edited", null);
			if (shared)
				sqlite.run(
					"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES ('fork-ref', 'n2', ?, 1)",
					[stepId],
				);
			await narratorService.deleteBlocks("n1", [blockOf(stepId, "output", 0)], {
				skipRevert: true,
			});
			const messageId = (
				sqlite
					.prepare("SELECT message_id AS id FROM narrator_message_refs WHERE narrator_id = 'n1'")
					.get() as { id: string }
			).id;
			expect(messageId === stepId).toBe(!shared);
			expect(texts(messageId)).toEqual(["Beta original"]);
			expect(rows(messageId).every((row) => row.originalPayload === null)).toBe(true);
			// Restoring the remaining text is a no-op, not a revival of the deleted one's body.
			await session.restoreOutputBlock("n1", blockOf(messageId, "output")).catch(() => undefined);
			expect(texts(messageId)).toEqual(["Beta original"]);
		}
	});

	test("an edit in place keeps the edited block's id and its neighbours'", async () => {
		const stepId = await idlessStep(["Alpha", "Beta"]);
		const before = rows(stepId).map((row) => row.id);
		await session.editOutputBlock("n1", before[0], "Beta", null);
		expect(texts(stepId)).toEqual(["Beta", "Beta"]);
		expect(rows(stepId).map((row) => row.id)).toEqual(before);
	});

	test("a decoded id goes stale once a delete gives its envelope rows", async () => {
		settings.narratorBlocks.write = false;
		const stepId = await idlessStep(["Alpha", "Beta"]);
		settings.narratorBlocks.write = true;
		expect(rows(stepId)).toEqual([]);
		const decoded = `${stepId}:0`;
		await narratorService.deleteBlocks("n1", [decoded], { skipRevert: true });
		expect(texts(stepId)).toEqual(["Beta"]);
		expect(assembled(stepId)).toEqual(content(stepId));
		await expect(
			narratorService.deleteBlocks("n1", [decoded], { skipRevert: true }),
		).rejects.toThrow("Message history changed");
		expect(texts(stepId)).toEqual(["Beta"]);
	});
});
