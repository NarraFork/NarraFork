/**
 * The narrator message stream in protocol v2 (docs/BLOCK_STORAGE-DESIGN.md §8.2): a
 * connection that negotiates v2 receives envelopes + blocks and block-addressed deltas,
 * and a streamed element's block id is the id its row gets at the next checkpoint.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../db")) };
mock.module("../db", () => ({ ...realDbModule, db, sqlite }));

// narrator-service must be imported before narrator-persistence (pre-existing cycle).
await import("../services/narrator-service");
const { narratorStore } = await import("../services/narrator-store");
const blockSync = await import("../services/narrator-block-sync");
const { broadcastToNarrator, getNarratorConnections, handleNarratorWS } = await import(
	"./narrator-ws"
);
const protocol = await import("./narrator-block-protocol");
const { decodeBlockFrame } = await import("@frontend/lib/block-protocol");

/** A decoded value with each row's body back as the elements its blocks hold. */
function withBodies<T>(value: T): T {
	return JSON.parse(JSON.stringify(value), (_key, field) => {
		if (!field || typeof field !== "object" || !Array.isArray(field.blocks)) return field;
		const { blocks, ...row } = field as { blocks: Array<{ elements: unknown[] }> };
		return { ...row, contentJson: blocks.flatMap((block) => block.elements) };
	});
}

/** What a client's decoder makes of one broadcast, as the row it was built from. */
const roundTrip = (frame: Parameters<typeof protocol.toBlockFrames>[0]) =>
	withBodies(
		protocol
			.toBlockFrames(frame)
			.flatMap((item) => decodeBlockFrame(item as unknown as Record<string, unknown>)),
	);

const NOW = "2026-10-01T00:00:00.000Z";

type Sent = Record<string, unknown>;
type FakeWs = Parameters<typeof handleNarratorWS.open>[0];
const opened: FakeWs[] = [];

function openWs() {
	const sent: Sent[] = [];
	const ws = {
		data: {
			channel: "narrator" as const,
			connectedAt: Date.now(),
			lastPongAt: Date.now(),
			subscribedNarrators: new Set<string>(),
			catchingUpNarrators: new Map(),
			catchUpBuffers: new Map(),
			userId: "ws-test-user",
		},
		send(payload: string) {
			sent.push(JSON.parse(payload) as Sent);
		},
		close() {},
	} as unknown as FakeWs;
	handleNarratorWS.open(ws);
	opened.push(ws);
	return { ws, sent };
}

beforeEach(() => {
	cleanDb(sqlite);
	sqlite.run(
		`INSERT INTO narrators (id, title, status, substatus, visibility, created_at, updated_at)
		 VALUES ('n1', 'N', 'idle', '[]', 'public', ?, ?)`,
		[NOW, NOW],
	);
});
afterEach(() => {
	for (const ws of opened.splice(0)) handleNarratorWS.close(ws);
	getNarratorConnections().clear();
});
afterAll(() => {
	blockSync.stopBlockSyncSweep();
	mock.module("../db", () => realDbModule);
	sqlite.close();
});

const delta = (elementId: string, text: string, type = "text_delta") => ({
	type: "stream_event" as const,
	narratorId: "n1",
	event: { type: "content_block_delta", delta: { type, text, id: elementId, revision: 1 } },
});

const rowOf = (messageId: string, kind: string) =>
	sqlite
		.prepare("SELECT id FROM narrator_blocks WHERE message_id = ? AND kind = ? ORDER BY ordinal")
		.get(messageId, kind) as { id: string } | null;

function messageRow(messageId: string) {
	const row = sqlite
		.prepare(
			"SELECT id, narrator_id AS narratorId, role, content_json AS contentJson FROM narrator_messages WHERE id = ?",
		)
		.get(messageId) as { id: string; narratorId: string; role: string; contentJson: string };
	return { ...row, contentJson: JSON.parse(row.contentJson) };
}

describe("block ids of streaming items", () => {
	test("a streamed text opens under the block id its row gets at the checkpoint", async () => {
		const [open, first] = protocol.toBlockFrames(delta("att1:0", "Hel"));
		expect(open).toMatchObject({ type: "block_opened", kind: "output", elementId: "att1:0" });
		expect(first).toMatchObject({ type: "block_delta", text: "Hel" });
		const blockId = (open as { blockId: string }).blockId;
		expect((first as { blockId: string }).blockId).toBe(blockId);
		expect(protocol.toBlockFrames(delta("att1:0", "lo"))).toEqual([
			expect.objectContaining({ type: "block_delta", blockId, text: "lo" }),
		]);

		const step = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
		await narratorStore.writeStepItem(step.id, "n1", {
			type: "text",
			id: "att1:0",
			text: "Hello",
			completed: true,
			outputIndex: 0,
		});
		expect(rowOf(step.id, "output")?.id).toBe(blockId);

		const [upserted] = protocol.toBlockFrames({
			type: "message_updated",
			narratorId: "n1",
			message: messageRow(step.id),
		});
		expect(upserted).toMatchObject({
			type: "message_upserted",
			cause: "message_updated",
			messages: [expect.objectContaining({ id: step.id, blockIds: [blockId] })],
			blocks: [expect.objectContaining({ id: blockId, kind: "output" })],
		});
		expect(upserted).not.toHaveProperty("message");
	});

	test("a tool call's first input chunk opens its block under its row's id", async () => {
		const chunk = {
			type: "tool_use_chunk" as const,
			narratorId: "n1",
			toolCallId: null,
			toolUseId: "call_9",
			toolName: "Bash",
			inputCharsTotal: 0,
		};
		const [open, passed] = protocol.toBlockFrames(chunk);
		expect(open).toMatchObject({ type: "block_opened", kind: "tool", wireId: "call_9" });
		expect(passed).toBe(chunk);
		expect(protocol.toBlockFrames({ ...chunk, inputCharsTotal: 12 })).toHaveLength(1);

		const step = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
		await narratorStore.writeStepItem(step.id, "n1", {
			type: "tool_use",
			id: "call_9",
			name: "Bash",
			input: { command: "ls" },
			outputIndex: 0,
		});
		expect(rowOf(step.id, "tool")?.id).toBe((open as { blockId: string }).blockId);
	});

	test("a row written before anyone asked keeps the id later deltas use", async () => {
		const step = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
		await narratorStore.writeStepItem(step.id, "n1", {
			type: "reasoning",
			id: "att2:0",
			text: "thinking",
			completed: false,
			outputIndex: 0,
		});
		const row = rowOf(step.id, "reasoning")?.id;
		expect(protocol.toBlockFrames(delta("att2:0", " more", "reasoning_delta"))).toEqual([
			expect.objectContaining({ type: "block_delta", blockId: row, kind: "reasoning" }),
		]);
	});

	test("the reconnect snapshot names each live item's block id", () => {
		const snapshot = protocol.toBlockSnapshot({
			type: "streaming_snapshot",
			narratorId: "n1",
			streamingBlocks: [{ type: "text", id: "att3:0", text: "partial" }],
			toolChunks: [{ toolUseId: "call_7", toolName: "Read", toolCallId: null, inputCharsTotal: 3 }],
		});
		expect(snapshot.protocol).toBe(2);
		const [text] = snapshot.streamingBlocks as unknown as Array<{ blockId: string }>;
		const [tool] = snapshot.toolChunks as unknown as Array<{ blockId: string }>;
		expect(protocol.toBlockFrames(delta("att3:0", "!"))).toEqual([
			expect.objectContaining({ type: "block_delta", blockId: text.blockId }),
		]);
		expect(tool.blockId).toEqual(expect.any(String));
	});

	test("a catch-up carries its rows, children included, as envelopes + blocks", async () => {
		const input = await narratorStore.appendInput("n1", "hello");
		const frame = protocol.toBlockCatchUp({
			type: "catch_up",
			narratorId: "n1",
			topLevel: [messageRow(input.id)],
			orphanChildren: [],
			subagentActivities: [],
			messageVersion: 3,
		});
		expect(frame).toMatchObject({
			type: "catch_up",
			protocol: 2,
			messageVersion: 3,
			messages: [expect.objectContaining({ id: input.id })],
			blocks: [expect.objectContaining({ kind: "input" })],
		});
		expect(frame).not.toHaveProperty("topLevel");
	});
});

describe("tool lifecycle frames", () => {
	test("name the tool block of their ledger attempt", async () => {
		const step = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
		const callRowId = await narratorStore.writeStepItem(step.id, "n1", {
			type: "tool_use",
			id: "call_led",
			name: "Bash",
			input: { command: "ls" },
			outputIndex: 0,
		});
		const block = rowOf(step.id, "tool")?.id;
		const completed = {
			type: "tool_completed" as const,
			narratorId: "n1",
			toolCallId: callRowId as string,
			toolUseId: "call_led",
			status: "success",
		};
		expect(protocol.toBlockFrames(completed)).toEqual([{ ...completed, blockId: block }]);
		// Without the attempt's id, the newest attempt of the call decides.
		expect(protocol.toBlockFrames({ ...completed, toolCallId: null })).toEqual([
			{ ...completed, toolCallId: null, blockId: block },
		]);
		const unknown = { ...completed, toolCallId: null, toolUseId: "call_none" };
		expect(protocol.toBlockFrames(unknown)).toEqual([unknown]);
	});
});

describe("every subscriber gets the block-keyed protocol", () => {
	async function subscribe(ws: FakeWs, version?: 1 | 2) {
		await handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "messages",
			narratorIds: ["n1"],
			...(version ? { protocol: version } : {}),
		});
	}

	test("message rows reach every subscriber as envelopes, whatever protocol it named", async () => {
		const subscribers = [openWs(), openWs(), openWs()];
		await subscribe(subscribers[0].ws, 2);
		await subscribe(subscribers[1].ws, 1);
		await subscribe(subscribers[2].ws);
		const input = await narratorStore.appendInput("n1", "hi");
		for (const { sent } of subscribers) sent.length = 0;
		broadcastToNarrator("n1", {
			type: "message_updated",
			narratorId: "n1",
			message: messageRow(input.id),
		});
		for (const { sent } of subscribers) {
			expect(sent.some((frame) => frame.type === "message_protocol")).toBe(false);
			expect(sent).toEqual([
				expect.objectContaining({ type: "message_upserted", cause: "message_updated" }),
			]);
		}
	});

	test("a frame that cannot be built asks the client to reload", async () => {
		const { ws, sent } = openWs();
		await subscribe(ws);
		const input = await narratorStore.appendInput("n1", "hi");
		sent.length = 0;
		sqlite.run("ALTER TABLE narrator_blocks RENAME TO narrator_blocks_moved");
		try {
			broadcastToNarrator("n1", {
				type: "message_updated",
				narratorId: "n1",
				message: messageRow(input.id),
			});
		} finally {
			sqlite.run("ALTER TABLE narrator_blocks_moved RENAME TO narrator_blocks");
		}
		expect(sent).toEqual([{ type: "full_reload", narratorId: "n1" }]);
	});
});

describe("the client's decoder", () => {
	test("gives back each v1 frame a v2 subscriber was sent", async () => {
		const input = await narratorStore.appendInput("n1", "hello");
		for (const type of ["message", "user_message", "message_updated"] as const) {
			const frame = { type, narratorId: "n1", message: messageRow(input.id) };
			expect(roundTrip(frame)).toEqual([JSON.parse(JSON.stringify(frame))]);
		}
		const text = {
			type: "stream_event" as const,
			narratorId: "n1",
			event: {
				type: "content_block_delta",
				delta: { type: "text_delta", text: "Hi", id: "att5:0", revision: 2, textOffset: 4 },
				fileReferenceContext: { blockId: "att5:0" },
				outputIndex: 1,
			},
		};
		expect(roundTrip(text)).toEqual([text]);
		const reasoning = {
			type: "stream_event" as const,
			narratorId: "parent",
			event: {
				type: "content_block_delta",
				delta: { type: "reasoning_delta", text: "hmm", id: "att6:0", outputIndex: 0 },
				subagentToolUseId: "agent1",
				subagentNarratorId: "n1",
			},
		};
		expect(roundTrip(reasoning)).toEqual([reasoning]);
		const chunk = {
			type: "tool_use_chunk" as const,
			narratorId: "n1",
			toolCallId: null,
			toolUseId: "call_rt",
			toolName: "Bash",
			inputCharsTotal: 0,
		};
		expect(roundTrip(chunk)).toEqual([chunk]);
	});

	test("gives back a catch-up's rows flat, each nested row after its parent, and orphan children", async () => {
		const parent = await narratorStore.appendInput("n1", "parent");
		const orphan = await narratorStore.appendInput("n1", "orphan");
		const child = await narratorStore.appendInput("n1", "child");
		const rest = {
			type: "catch_up",
			narratorId: "n1",
			subagentActivities: [],
			cursor: { parentLastMessageId: parent.id },
			messageVersion: 4,
		};
		const frame = {
			...rest,
			topLevel: [
				{ ...messageRow(parent.id), children: [{ ...messageRow(child.id), children: [] }] },
			],
			orphanChildren: [{ ...messageRow(orphan.id), children: [] }],
		};
		const decoded = decodeBlockFrame(protocol.toBlockCatchUp(frame));
		expect(withBodies(decoded)).toEqual([
			JSON.parse(
				JSON.stringify({
					...rest,
					topLevel: [
						messageRow(parent.id),
						{ ...messageRow(child.id), parentMessageId: parent.id },
					],
					orphanChildren: [messageRow(orphan.id)],
				}),
			),
		]);
	});
});
