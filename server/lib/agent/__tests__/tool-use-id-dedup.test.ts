import { describe, expect, test } from "bun:test";
import type { DbMessage } from "../provider";
import {
	allocateUniqueToolUseId,
	applyToolUseIdRemap,
	collectToolUseIdsFromHistory,
	remapToolResultIds,
	reserveUniqueToolUseIds,
	uniquifyDbMessageToolUseIds,
} from "../tool-use-id-dedup";
import type { AgentToolUse } from "../types";

function assistantMessage(id: string, toolUseIds: string[]): DbMessage {
	return {
		id,
		role: "assistant",
		contentText: null,
		parentToolUseId: null,
		messageUuid: null,
		contentJson: [
			{ type: "text", text: `msg ${id}` },
			...toolUseIds.map((toolUseId) => ({
				type: "tool_use",
				id: toolUseId,
				name: "Bash",
				input: { command: "echo hi" },
			})),
		],
		toolCalls: toolUseIds.map((toolUseId) => ({
			toolUseId,
			toolName: "Bash",
			inputJson: { command: "echo hi" },
			outputJson: "ok",
			status: "success",
		})),
	};
}

function toolUseIdsOf(msg: DbMessage): string[] {
	return (msg.toolCalls ?? []).map((tc) => tc.toolUseId);
}

function contentToolUseIdsOf(msg: DbMessage): string[] {
	const blocks = Array.isArray(msg.contentJson)
		? (msg.contentJson as Array<Record<string, unknown>>)
		: [];
	return blocks
		.filter((b) => b.type === "tool_use")
		.map((b) => b.id)
		.filter((id): id is string => typeof id === "string");
}

describe("uniquifyDbMessageToolUseIds", () => {
	test("well-behaved history is returned untouched (same array reference)", () => {
		const messages = [assistantMessage("m1", ["call_1"]), assistantMessage("m2", ["call_2"])];
		expect(uniquifyDbMessageToolUseIds(messages)).toBe(messages);
	});

	test("跨消息重复的 tool_use ID 被改名，首次出现保持不变", () => {
		// The grok-4.5 case: every assistant turn reuses "call_go_0".
		const messages = [
			assistantMessage("m1", ["call_go_0"]),
			assistantMessage("m2", ["call_go_0"]),
			assistantMessage("m3", ["call_go_0"]),
		];
		const result = uniquifyDbMessageToolUseIds(messages);

		const all = result.flatMap(toolUseIdsOf);
		expect(all).toHaveLength(3);
		expect(new Set(all).size).toBe(3);
		// First occurrence is stable so older turns keep the id the model already saw.
		expect(all[0]).toBe("call_go_0");
		expect(all[1]).not.toBe("call_go_0");
		expect(all[2]).not.toBe(all[1]);

		// Input is never mutated — the DB rows keep the original ids.
		expect(messages.flatMap(toolUseIdsOf)).toEqual(["call_go_0", "call_go_0", "call_go_0"]);
	});

	test("contentJson 的 tool_use 块与 toolCalls 保持同一 ID", () => {
		const messages = [assistantMessage("m1", ["call_go_0"]), assistantMessage("m2", ["call_go_0"])];
		const result = uniquifyDbMessageToolUseIds(messages);

		for (const msg of result) {
			// Providers look up stored blocks by id against the tool-call rows; a mismatch
			// would silently drop the tool_use from the replayed turn.
			expect(contentToolUseIdsOf(msg)).toEqual(toolUseIdsOf(msg));
		}
	});

	test("同一消息内多个 tool_use 共用一个 ID 时按顺序分配", () => {
		const messages = [assistantMessage("m1", ["call_go_0", "call_go_0", "call_go_0"])];
		const result = uniquifyDbMessageToolUseIds(messages);

		const ids = toolUseIdsOf(result[0]);
		expect(new Set(ids).size).toBe(3);
		expect(contentToolUseIdsOf(result[0])).toEqual(ids);
	});

	test("生成的 ID 保持可辨识且长度受限", () => {
		const long = `call_${"x".repeat(200)}`;
		const id = allocateUniqueToolUseId(long, new Set([long]));
		expect(id.length).toBeLessThanOrEqual(56);
		expect(id).toContain("_nfdup");
	});

	test("大量重复时仍能全部分配到唯一 ID", () => {
		const messages = Array.from({ length: 120 }, (_, i) =>
			assistantMessage(`m${i}`, ["call_go_0"]),
		);
		const all = uniquifyDbMessageToolUseIds(messages).flatMap(toolUseIdsOf);
		expect(all).toHaveLength(120);
		expect(new Set(all).size).toBe(120);
	});
});

describe("collectToolUseIdsFromHistory", () => {
	test("识别 Anthropic 形态的 tool_use 与 tool_result", () => {
		const history = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call_go_0", name: "Bash", input: {} }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "call_go_0", content: "ok" }],
			},
		];
		expect(collectToolUseIdsFromHistory(history)).toEqual(new Set(["call_go_0"]));
	});

	test("识别 OpenAI completions / responses 形态", () => {
		const history = [
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{ id: "call_a", type: "function", function: { name: "Bash", arguments: "{}" } },
				],
			},
			{ role: "tool", tool_call_id: "call_a", content: "ok" },
			{ type: "function_call", call_id: "call_b", name: "Bash", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_b", output: "ok" },
		];
		expect(collectToolUseIdsFromHistory(history)).toEqual(new Set(["call_a", "call_b"]));
	});

		const history = [
			{
					content: "",
				},
			},
			{
					content: "",
				},
			},
		];
	});

	test("普通消息 ID 不会被误认为工具 ID", () => {
		const history = [{ role: "assistant", id: "msg_123", content: [{ type: "text", text: "hi" }] }];
		expect(collectToolUseIdsFromHistory(history).has("msg_123")).toBe(false);
	});
});

describe("reserveUniqueToolUseIds + remapToolResultIds", () => {
	function toolUse(id: string): AgentToolUse {
		return { toolUseId: id, name: "Bash", input: {} };
	}

	test("与历史冲突的 ID 被改名，未冲突的保持原样", () => {
		const used = new Set(["call_go_0"]);
		const toolUses = [toolUse("call_go_0"), toolUse("call_fresh")];
		const remap = reserveUniqueToolUseIds(toolUses, used);

		expect(remap.size).toBe(1);
		expect(remap.get("call_go_0")).toBeDefined();
		expect(remap.has("call_fresh")).toBe(false);
		// The live objects keep the provider's id — persistence/UI/permissions use it.
		expect(toolUses.map((tu) => tu.toolUseId)).toEqual(["call_go_0", "call_fresh"]);
		// Both ids (renamed and fresh) are now reserved against later turns.
		expect(used.has("call_fresh")).toBe(true);
		expect(used.has(remap.get("call_go_0") as string)).toBe(true);
	});

	test("applyToolUseIdRemap 产生历史用副本而不改动原对象", () => {
		const used = new Set(["call_go_0"]);
		const toolUses = [toolUse("call_go_0")];
		const remap = reserveUniqueToolUseIds(toolUses, used);
		const forHistory = applyToolUseIdRemap(toolUses, remap);
		const renamed = remap.get("call_go_0") as string;

		expect(forHistory[0].toolUseId).toBe(renamed);
		expect(toolUses[0].toolUseId).toBe("call_go_0");
	});

	test("工具结果 ID 跟随改名，保持 tool_use ↔ tool_result 配对", () => {
		const used = new Set(["call_go_0"]);
		const toolUses = [toolUse("call_go_0")];
		const remap = reserveUniqueToolUseIds(toolUses, used);
		const renamed = remap.get("call_go_0") as string;

		const anthropicResults = [{ type: "tool_result", tool_use_id: "call_go_0", content: "ok" }];
		const oaiResults = [{ role: "tool", tool_call_id: "call_go_0", content: "ok" }];
		const responsesResults = [{ type: "function_call_output", call_id: "call_go_0", output: "ok" }];

		expect(remapToolResultIds(anthropicResults, remap)).toBe(1);
		expect(remapToolResultIds(oaiResults, remap)).toBe(1);
		expect(remapToolResultIds(responsesResults, remap)).toBe(1);

		expect(anthropicResults[0].tool_use_id).toBe(renamed);
		expect(oaiResults[0].tool_call_id).toBe(renamed);
		expect(responsesResults[0].call_id).toBe(renamed);
	});

	test("空 remap 时不触碰结果", () => {
		const results = [{ type: "tool_result", tool_use_id: "call_a", content: "ok" }];
		expect(remapToolResultIds(results, new Map())).toBe(0);
		expect(results[0].tool_use_id).toBe("call_a");
	});
});
