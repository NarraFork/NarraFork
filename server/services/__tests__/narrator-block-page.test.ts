/**
 * Messages in the block-keyed protocol v2 (docs/BLOCK_STORAGE-DESIGN.md §8.1): a page's
 * rows become envelopes naming their blocks, and the blocks carry exactly the elements
 * v1 sends, under the ids the block-id API resolves.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { PretextDocumentPageResult } from "@frontend/lib/api/types";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

// narrator-service must be imported before narrator-persistence (pre-existing cycle).
const { narratorService } = await import("../narrator-service");
const { narratorStore } = await import("../narrator-store");
const { settings } = await import("../../lib/settings");
const blockSync = await import("../narrator-block-sync");
const targets = await import("../narrator-block-targets");
const page = await import("../narrator-block-page");
const { decodeBlockPage } = await import("@frontend/lib/block-protocol");
const { messageBlocks, splitRowBlocks } = await import("@shared/narrator-blocks/message-blocks");

/** A decoded value without the block sidecar the client adds to every row. */
/** The value with each decoded row's body back as the elements its blocks hold. */
function withBodies<T>(value: T): T {
	return JSON.parse(JSON.stringify(value), (_key, field) => {
		if (!field || typeof field !== "object" || !Array.isArray(field.blocks)) return field;
		const { blocks, ...row } = field as { blocks: Array<{ elements: unknown[] }> };
		return { ...row, contentJson: blocks.flatMap((block) => block.elements) };
	});
}

/** v1 rows as the client keeps them: flat, each row then the rows nested under it. */
type V1Row = { id: string; children?: V1Row[] };
function flatRows(rows: readonly V1Row[], parentMessageId?: string): unknown[] {
	return rows.flatMap(({ children = [], ...row }) => [
		parentMessageId ? { ...row, parentMessageId } : row,
		...flatRows(children, row.id),
	]);
}

const NOW = "2026-10-01T00:00:00.000Z";

beforeEach(() => {
	cleanDb(sqlite);
	sqlite.run("INSERT INTO narrators (id, title, created_at, updated_at) VALUES ('n1', 'N', ?, ?)", [
		NOW,
		NOW,
	]);
});
afterEach(() => {
	settings.narratorBlocks.write = true;
});
afterAll(() => {
	blockSync.stopBlockSyncSweep();
	mock.module("../../db", () => realDbModule);
	sqlite.close();
});

async function conversation() {
	const input = await narratorStore.appendInput("n1", "list the files");
	const step = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
	const write = (item: Parameters<typeof narratorStore.writeStepItem>[2]) =>
		narratorStore.writeStepItem(step.id, "n1", item);
	await write({ type: "reasoning", id: "r1", text: "think", completed: true, outputIndex: 0 });
	await write({ type: "text", id: "t1", text: "Running ls.", completed: true, outputIndex: 1 });
	const call = await write({
		type: "tool_use",
		id: "c1",
		name: "Bash",
		input: { command: "ls" },
		outputIndex: 2,
	});
	await narratorStore.settleTool("c1", { output: "a.txt", status: "success" }, step.id, call);
	await write({ type: "text", id: "t2", text: "Found a.txt.", completed: true, outputIndex: 3 });
	return { input, stepId: step.id };
}

const rowIds = (messageId: string) =>
	(
		sqlite
			.prepare("SELECT id FROM narrator_blocks WHERE message_id = ? ORDER BY ordinal")
			.all(messageId) as Array<{ id: string }>
	).map((row) => row.id);

/** Each envelope's blocks, concatenated, are the v1 row's `contentJson`. */
function expectSameBodies(
	v1: Array<{ id: string; contentJson: unknown }>,
	v2: ReturnType<typeof page.toBlockPage>,
) {
	const blocks = new Map(v2.blocks.map((block) => [block.id, block]));
	expect(v2.messages.map((message) => message.id)).toEqual(v1.map((message) => message.id));
	for (const [index, envelope] of v2.messages.entries()) {
		expect(envelope).not.toHaveProperty("contentJson");
		const elements = envelope.blockIds.flatMap((id) => blocks.get(id)?.elements ?? []);
		expect(elements).toEqual(v1[index].contentJson as unknown[]);
	}
}

describe("the message page in protocol v2", () => {
	test("block-format envelopes carry their rows' ids, and the bodies v1 sends", async () => {
		const { input, stepId } = await conversation();
		const v1 = await narratorService.getPretextDocumentPage("n1");
		const v2 = page.toBlockPage(structuredClone(v1));
		expect(v2.protocol).toBe(2);
		expect({ ...v2, messages: [], blocks: [] }).toMatchObject({
			minSeq: v1.minSeq,
			maxSeq: v1.maxSeq,
			hasPrev: v1.hasPrev,
			hasNext: v1.hasNext,
			messageVersion: v1.messageVersion,
		});
		expectSameBodies(v1.messages, v2);
		const byId = new Map(v2.messages.map((message) => [message.id, message]));
		expect(byId.get(input.id)?.blockIds).toEqual(rowIds(input.id));
		expect(byId.get(stepId)?.blockIds).toEqual(rowIds(stepId));
		const tool = v2.blocks.find((block) => block.kind === "tool");
		expect(tool).toMatchObject({ wireId: "c1", phase: "done", messageId: stepId });
		expect(v2.blocks.map((block) => block.kind)).toEqual([
			"input",
			"reasoning",
			"output",
			"tool",
			"output",
		]);
	});

	test("a legacy envelope's blocks carry the decoded ids the block-id API resolves", async () => {
		settings.narratorBlocks.write = false;
		const { stepId } = await conversation();
		const v1 = await narratorService.getPretextDocumentPage("n1");
		const v2 = page.toBlockPage(structuredClone(v1));
		expectSameBodies(v1.messages, v2);
		const stepBlocks = v2.blocks.filter((block) => block.messageId === stepId);
		expect(stepBlocks.every((block) => block.id.startsWith(`${stepId}:`))).toBe(true);
		const resolved = targets.resolveBlockTargets(
			"n1",
			stepBlocks.map((block) => block.id),
		);
		expect(resolved.map((target) => target.to - target.from)).toEqual(
			stepBlocks.map((block) => block.elements.length),
		);
		// A row the client builds itself is split into these same blocks.
		for (const message of v1.messages)
			expect(
				splitRowBlocks(message, message.contentJson).map(({ named: _named, ...block }) => ({
					...block,
					elements: [...block.elements] as unknown[],
				})),
			).toEqual(
				v2.blocks
					.filter((block) => block.messageId === message.id)
					.map(({ messageId: _messageId, ordinal: _ordinal, ...block }) => block),
			);
	});

	test("an envelope rewritten outside the store is synced before its ids are sent", async () => {
		const { stepId } = await conversation();
		const before = rowIds(stepId);
		const content = JSON.parse(
			(
				sqlite
					.prepare("SELECT content_json AS c FROM narrator_messages WHERE id = ?")
					.get(stepId) as {
					c: string;
				}
			).c,
		) as Array<{ id?: string }>;
		sqlite.run("UPDATE narrator_messages SET content_json = ? WHERE id = ?", [
			JSON.stringify(content.filter((element) => element.id !== "t1")),
			stepId,
		]);
		const v1 = await narratorService.getPretextDocumentPage("n1");
		const v2 = page.toBlockPage(structuredClone(v1));
		expectSameBodies(v1.messages, v2);
		const ids = v2.messages.find((message) => message.id === stepId)?.blockIds ?? [];
		expect(ids).toEqual(rowIds(stepId));
		// The other blocks kept their ids through the sync.
		expect(ids).toEqual(before.filter((_, index) => index !== 1));
	});
});

describe("the client's decoder", () => {
	test("gives back the page's rows, each holding its named blocks", async () => {
		const { stepId } = await conversation();
		const v1 = await narratorService.getPretextDocumentPage("n1");
		const decoded = decodeBlockPage(
			page.toBlockPage(structuredClone(v1)) as unknown as PretextDocumentPageResult,
		);
		expect(withBodies(decoded)).toEqual(
			JSON.parse(JSON.stringify({ ...v1, messages: flatRows(v1.messages as V1Row[]) })),
		);
		const step = decoded.messages.find((message) => message.id === stepId);
		if (!step) throw new Error("step row missing");
		const blocks = messageBlocks(step);
		expect(blocks.map((block) => block.id)).toEqual(rowIds(stepId));
		expect(blocks.every((block) => block.named)).toBe(true);
		expect(blocks.map((block) => [block.from, block.from + block.elements.length])).toEqual([
			[0, 1],
			[1, 2],
			[2, 3],
			[3, 4],
		]);
	});

	test("lays nested rows out flat after the row they belong to", () => {
		const child = {
			id: "c1",
			narratorId: "n1",
			role: "assistant",
			parentToolUseId: "agent1",
			contentText: null,
			contentJson: [{ type: "text", text: "from the child" }],
			children: [],
		};
		const v1 = {
			messages: [
				{
					id: "p1",
					narratorId: "n1",
					role: "assistant",
					parentToolUseId: null,
					contentText: null,
					contentJson: [{ type: "tool_use", id: "agent1", name: "Agent", input: {} }],
					children: [child],
				},
			],
			hasPrev: false,
		};
		const decoded = decodeBlockPage(page.toBlockPage(structuredClone(v1)) as unknown as typeof v1);
		expect(withBodies(decoded) as unknown).toEqual({ ...v1, messages: flatRows(v1.messages) });
		expect(decoded.messages.map((row) => row.id)).toEqual(["p1", "c1"]);
	});
});
