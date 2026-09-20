/**
 * partial-assistant-visibility.test.ts — An empty partial assistant shell must not
 * enter the client sync stream; real blocks must.
 *
 * ── The reported bug ──────────────────────────────────────────────────────────
 *
 * "reasoning 之后连续多次调用工具，前端一段时间看不到 reasoning，连带后面的
 * assistant 文本也消失，等一些工具执行完才重新出现。"
 *
 * Cause: `createPartialAssistantMessage` allocated a ref and bumped
 * `messageVersion` on an EMPTY `contentJson` row. Catch-up delivered that blank
 * assistant into the document while `appendBlockToMessage` wrote reasoning/text
 * into the same row WITHOUT bump or broadcast. Live-row hand-off could then retire
 * streaming blocks against a committed copy that still had nothing to show; content
 * only reappeared when a later reload read the DB.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

/** Broadcasts are the observable wire contract for the partial publication path. */
interface Broadcast {
	narratorId: string;
	// biome-ignore lint/suspicious/noExplicitAny: websocket frames are dynamic JSON
	message: any;
}
const broadcasts: Broadcast[] = [];
const realNarratorWs = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({
	...realNarratorWs,
	// biome-ignore lint/suspicious/noExplicitAny: websocket frames are dynamic JSON
	broadcastToNarrator: (narratorId: string, message: any) => {
		broadcasts.push({ narratorId, message });
	},
}));

// narrator-service must be imported before narrator-persistence: the two form a
// pre-existing import cycle (see seq-store-contract.test.ts).
await import("../narrator-service");
const { narratorPersistence } = await import("../narrator-persistence");
const { narratorMessageQueries } = await import("../narrator-messages");

const NOW = "2026-08-20T10:00:00.000Z";

function seedNarrator(
	id = "n1",
	options: {
		variant?: string;
		type?: "primary" | "subagent";
		parentNarratorId?: string | null;
	} = {},
) {
	sqlite
		.prepare(
			"INSERT INTO narrators (id, variant, type, parent_narrator_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.run(
			id,
			options.variant ?? "primary",
			options.type ?? "primary",
			options.parentNarratorId ?? null,
			NOW,
			NOW,
		);
}

function messageVersionOf(id = "n1"): number {
	const row = sqlite.prepare("SELECT message_version AS v FROM narrators WHERE id = ?").get(id) as
		| { v: number }
		| undefined;
	return row?.v ?? 0;
}

beforeEach(() => {
	cleanDb(sqlite);
	broadcasts.length = 0;
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWs);
	mock.restore();
	cleanDb(sqlite);
});

describe("partial assistant visibility", () => {
	test("createPartialAssistantMessage does not announce an empty shell", async () => {
		seedNarrator();
		const before = messageVersionOf();
		const partial = await narratorPersistence.createPartialAssistantMessage("n1", {
			uuid: "partial-1",
			session_id: "s",
		});
		expect(partial.id).toBeTruthy();
		expect(partial.seq).toBeGreaterThanOrEqual(0);
		// Ref/seq exist for later appends; sync version must not move.
		expect(messageVersionOf()).toBe(before);
	});

	test("appendBlockToMessage publishes reasoning into the sync stream", async () => {
		seedNarrator();
		const partial = await narratorPersistence.createPartialAssistantMessage("n1", {
			uuid: "partial-2",
			session_id: "s",
		});
		expect(messageVersionOf()).toBe(0);

		await narratorPersistence.appendBlockToMessage(partial.id, "n1", {
			type: "reasoning",
			text: "**分析**\n\n先确认现状。",
		});

		expect(messageVersionOf()).toBeGreaterThan(0);
		const raw = sqlite
			.prepare("SELECT content_json AS c FROM narrator_messages WHERE id = ?")
			.get(partial.id) as { c: string } | undefined;
		const blocks: unknown[] = raw?.c ? JSON.parse(raw.c) : [];
		expect(blocks.some((b) => (b as { type?: string }).type === "reasoning")).toBe(true);

		// Catch-up that follows a version bump must be able to see the same body.
		const page = await narratorMessageQueries.getPretextDocumentPage("n1", { limit: 10 });
		const delivered = page.messages.find((m) => m.id === partial.id);
		expect(delivered).toBeDefined();
		const deliveredBlocks = Array.isArray(delivered?.contentJson) ? delivered.contentJson : [];
		expect(
			deliveredBlocks.some(
				(b: { type?: string; text?: string }) =>
					b.type === "reasoning" && typeof b.text === "string" && b.text.includes("分析"),
			),
		).toBe(true);
	});

	test("appendBlockToMessage publishes assistant text after reasoning", async () => {
		seedNarrator();
		const partial = await narratorPersistence.createPartialAssistantMessage("n1", {
			uuid: "partial-3",
			session_id: "s",
		});
		await narratorPersistence.appendBlockToMessage(partial.id, "n1", {
			type: "reasoning",
			text: "想一下",
		});
		const afterReasoning = messageVersionOf();
		await narratorPersistence.appendBlockToMessage(partial.id, "n1", {
			type: "text",
			text: "我先定位这段逻辑。",
		});
		expect(messageVersionOf()).toBeGreaterThan(afterReasoning);

		const page = await narratorMessageQueries.getPretextDocumentPage("n1", { limit: 10 });
		const delivered = page.messages.find((m) => m.id === partial.id);
		const deliveredBlocks = Array.isArray(delivered?.contentJson) ? delivered.contentJson : [];
		expect(
			deliveredBlocks.some(
				(b: { type?: string; text?: string }) => b.type === "text" && b.text?.includes("定位"),
			),
		).toBe(true);
	});

	test("subagent empty partial waits to bump both versions and broadcasts both copies", async () => {
		seedNarrator("parent");
		seedNarrator("child", {
			variant: "subagent:general",
			type: "subagent",
			parentNarratorId: "parent",
		});

		const partial = await narratorPersistence.createPartialAssistantMessage("child", {
			uuid: "partial-child",
			session_id: "s",
			parent_tool_use_id: "toolu-parent",
		});
		expect(messageVersionOf("parent")).toBe(0);
		expect(messageVersionOf("child")).toBe(0);
		expect(broadcasts).toHaveLength(0);

		await narratorPersistence.appendBlockToMessage(partial.id, "child", {
			type: "text",
			text: "子代理已完成。",
		});

		expect(messageVersionOf("parent")).toBe(1);
		expect(messageVersionOf("child")).toBe(1);
		expect(broadcasts).toHaveLength(2);

		const parentFrame = broadcasts.find((frame) => frame.narratorId === "parent");
		const childFrame = broadcasts.find((frame) => frame.narratorId === "child");
		expect(parentFrame?.message.type).toBe("message_updated");
		expect(childFrame?.message.type).toBe("message_updated");
		expect(parentFrame?.message.message.parentToolUseId).toBe("toolu-parent");
		expect(childFrame?.message.message.parentToolUseId).toBeNull();
	});

	test("broadcast tool I/O is projected while the database keeps complete JSON", async () => {
		seedNarrator();
		const partial = await narratorPersistence.createPartialAssistantMessage("n1", {
			uuid: "partial-tool",
			session_id: "s",
		});
		const input = { command: `input-${"i".repeat(2400)}`, short: "kept" };
		const output = { stdout: `output-${"o".repeat(2400)}`, exitCode: 0 };
		const toolUseId = "toolu-projected";
		const toolCallId = await narratorPersistence.appendBlockToMessage(partial.id, "n1", {
			type: "tool_use",
			id: toolUseId,
			name: "Bash",
			input,
		});
		expect(toolCallId).toBeTruthy();
		if (!toolCallId) throw new Error("tool_use append must produce a tool-call row id");

		await narratorPersistence.updateToolCallResult(
			toolUseId,
			{ output, status: "success" },
			partial.id,
			toolCallId,
		);
		broadcasts.length = 0;
		await narratorPersistence.appendBlockToMessage(partial.id, "n1", {
			type: "text",
			text: "命令已完成。",
		});

		expect(broadcasts).toHaveLength(1);
		const frame = broadcasts[0];
		expect(frame?.message.type).toBe("message_updated");
		const broadcastMessage = frame?.message.message;
		const broadcastToolCall = broadcastMessage.toolCalls.find(
			(call: { toolUseId?: string }) => call.toolUseId === toolUseId,
		);
		const broadcastToolBlock = broadcastMessage.contentJson.find(
			(block: { type?: string; id?: string }) =>
				block.type === "tool_use" && block.id === toolUseId,
		);
		expect(broadcastToolCall.inputJson.command).toMatchObject({ _truncated: true });
		expect(broadcastToolCall.outputJson.stdout).toMatchObject({ _truncated: true });
		expect(broadcastToolCall.inputJson.command.preview.length).toBeLessThan(input.command.length);
		expect(broadcastToolCall.outputJson.stdout.preview.length).toBeLessThan(output.stdout.length);
		expect(broadcastToolBlock.inputJson.command).toBe(broadcastToolCall.inputJson.command);
		expect(broadcastToolBlock.outputJson.stdout).toBe(broadcastToolCall.outputJson.stdout);

		const stored = sqlite
			.prepare(
				"SELECT input_json AS input, output_json AS output FROM narrator_tool_calls WHERE id = ?",
			)
			.get(toolCallId) as { input: string; output: string };
		expect(JSON.parse(stored.input)).toEqual(input);
		expect(JSON.parse(stored.output)).toEqual(output);
	});
});
