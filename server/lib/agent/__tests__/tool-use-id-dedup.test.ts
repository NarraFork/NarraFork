import { describe, expect, test } from "bun:test";
import type { DbMessage } from "../provider";
import {
	allocateUniqueToolUseId,
	applyToolUseIdRemap,
	collectToolUseIdsFromHistory,
	isWireSafeToolUseId,
	remapToolResultIds,
	reserveUniqueToolUseIds,
	toWireSafeToolUseId,
	uniquifyDbMessageToolUseIds,
} from "../tool-use-id-dedup";
import type { AgentToolUse } from "../types";

/** The pattern NUG validates tool ids against. */
const WIRE_PATTERN = /^[a-zA-Z0-9_-]+$/;

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

	test("每个候选都被占用时仍然返回，而不是死循环", () => {
		// The allocator's fallback is a random tail, so its exit condition depends on
		// `Math.random` missing a set. That loop runs SYNCHRONOUSLY on the server's only
		// JS thread: unbounded, its worst case is a wedged event loop that takes every
		// session down, and the symptom ("the whole app stopped responding") points
		// nowhere near a tool-id naming helper.
		//
		// A Set that claims to contain EVERYTHING forces the pathological branch on the
		// first probe, which no realistic history can do. Passing means the allocator
		// degrades to a wider id; failing means this test never returns.
		const everything: ReadonlySet<string> = {
			has: () => true,
			size: Number.MAX_SAFE_INTEGER,
			// The allocator only calls `has`; the rest satisfies the type.
			keys: () => [][Symbol.iterator](),
			values: () => [][Symbol.iterator](),
			entries: () => [][Symbol.iterator](),
			forEach: () => {},
			[Symbol.iterator]: () => [][Symbol.iterator](),
		} as unknown as ReadonlySet<string>;

		const id = allocateUniqueToolUseId("call_stuck", everything);

		expect(id).toContain("_nfdup");
		// Still wire-safe and still within the length gateways validate: degrading must
		// not produce an id that the next request rejects.
		expect(id).toMatch(WIRE_PATTERN);
		expect(id.length).toBeLessThanOrEqual(56);
	});

	// --- character set ---

	test("含冒号的 ID 即使不重复也被改写（Bash:0 回归）", () => {
		// Real failure: a session whose early turns were produced by an upstream minting
		// `Bash:0` / `Read:0`. Anthropic accepted them, so they reached the DB; NUG
		// then rejected the whole replayed history with
		// `tool_use.id: String should match pattern '^[a-zA-Z0-9_-]+$'`.
		const messages = [
			assistantMessage("m1", ["Bash:0"]),
			assistantMessage("m2", ["Edit:0"]),
			assistantMessage("m3", ["toolu_01Normal"]),
		];
		const result = uniquifyDbMessageToolUseIds(messages);
		const all = result.flatMap(toolUseIdsOf);

		expect(all).toEqual(["Bash_0", "Edit_0", "toolu_01Normal"]);
		for (const id of all) expect(id).toMatch(WIRE_PATTERN);
		// contentJson must follow, or the provider drops the block when resolving it
		// against the tool-call rows.
		expect(result.flatMap(contentToolUseIdsOf)).toEqual(all);
		// DB rows are untouched.
		expect(messages.flatMap(toolUseIdsOf)).toEqual(["Bash:0", "Edit:0", "toolu_01Normal"]);
	});

	test("净化后撞车的两个不同 ID 仍各自唯一", () => {
		// `a:0` and `a.0` both sanitize to `a_0`; checking uniqueness before sanitizing
		// would let them collide on the wire.
		const messages = [assistantMessage("m1", ["a:0"]), assistantMessage("m2", ["a.0"])];
		const all = uniquifyDbMessageToolUseIds(messages).flatMap(toolUseIdsOf);

		expect(new Set(all).size).toBe(2);
		for (const id of all) expect(id).toMatch(WIRE_PATTERN);
	});

	test("净化与去重同时发生时结果既唯一又合法", () => {
		const messages = [
			assistantMessage("m1", ["Bash:0"]),
			assistantMessage("m2", ["Bash:0"]),
			assistantMessage("m3", ["Bash:0"]),
		];
		const all = uniquifyDbMessageToolUseIds(messages).flatMap(toolUseIdsOf);

		expect(new Set(all).size).toBe(3);
		for (const id of all) expect(id).toMatch(WIRE_PATTERN);
	});

	test("净化是确定性的，同一 ID 每次重建都得到同一替换", () => {
		// Stability is what lets the DB keep the original id: nothing persists the mapping,
		// so a differing replacement between rebuilds would break tool_use ↔ tool_result
		// pairing across a restart.
		const build = () => uniquifyDbMessageToolUseIds([assistantMessage("m1", ["Bash:0"])]);
		expect(build().flatMap(toolUseIdsOf)).toEqual(build().flatMap(toolUseIdsOf));
	});

	test("超长 ID 在 DB 重建路径中被截断，tool_use 块与 tool call 保持配对", () => {
		// End-to-end over the buildHistory path: the Responses API's 64-char call_id
		// ceiling must hold for the whole replayed history, not just freshly minted ids.
		const longId = `call_${"g".repeat(78)}`;
		const messages = [assistantMessage("m1", [longId])];
		const result = uniquifyDbMessageToolUseIds(messages);
		expect(result).not.toBe(messages);
		const [rewrittenId] = toolUseIdsOf(result[0]);
		expect(rewrittenId.length).toBeLessThanOrEqual(64);
		expect(rewrittenId).toMatch(WIRE_PATTERN);
		expect(contentToolUseIdsOf(result[0])).toEqual([rewrittenId]);
	});

	test("已合法的历史保持同一数组引用（无额外拷贝）", () => {
		const messages = [assistantMessage("m1", ["toolu_01a-b_c"]), assistantMessage("m2", ["x"])];
		expect(uniquifyDbMessageToolUseIds(messages)).toBe(messages);
	});
});

describe("toWireSafeToolUseId", () => {
	test("合法 ID 原样返回", () => {
		for (const id of ["toolu_01abc", "call-1", "A_b-9"]) {
			expect(isWireSafeToolUseId(id)).toBe(true);
			expect(toWireSafeToolUseId(id)).toBe(id);
		}
	});

	test("非法字符被替换为下划线", () => {
		expect(toWireSafeToolUseId("Bash:0")).toBe("Bash_0");
		expect(toWireSafeToolUseId("tool.call:1")).toBe("tool_call_1");
		expect(toWireSafeToolUseId("工具:0")).toBe("___0");
	});

	test("全部字符非法时回落到可用名字而非空串", () => {
		// An empty id would be rejected by the same validator (`+` requires ≥1 char).
		expect(toWireSafeToolUseId("")).toBe("tool");
		expect(toWireSafeToolUseId(":::")).toMatch(WIRE_PATTERN);
	});

	test("点号也被视为非法（NUG 通道不接受）", () => {
		expect(isWireSafeToolUseId("call.1")).toBe(false);
		expect(toWireSafeToolUseId("call.1")).toMatch(WIRE_PATTERN);
	});

	test("超长 ID 被确定性截断到 64 字符以内", () => {
		// Observed with grok-4.6 behind an OpenAI-compatible proxy: 82-char call ids that
		// the originating channel accepts but the Responses API (64-char ceiling) rejects
		// on replay after a channel switch.
		const longId = `call_${"a".repeat(77)}`;
		expect(longId.length).toBe(82);
		expect(isWireSafeToolUseId(longId)).toBe(false);
		const rewritten = toWireSafeToolUseId(longId);
		expect(rewritten.length).toBeLessThanOrEqual(64);
		expect(rewritten).toMatch(WIRE_PATTERN);
		expect(rewritten).toContain("_nfh");
		// Deterministic: history rebuilds must produce the same replacement every time.
		expect(toWireSafeToolUseId(longId)).toBe(rewritten);
	});

	test("共享前缀的两个超长 ID 截断后仍然不同", () => {
		// Plain truncation would collapse these; the hash suffix keeps them apart.
		const first = toWireSafeToolUseId(`call_${"a".repeat(76)}x`);
		const second = toWireSafeToolUseId(`call_${"a".repeat(76)}y`);
		expect(first).not.toBe(second);
	});

	test("恰好 64 字符的合法 ID 原样返回", () => {
		const id = "c".repeat(64);
		expect(isWireSafeToolUseId(id)).toBe(true);
		expect(toWireSafeToolUseId(id)).toBe(id);
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

	test("识别嵌套形态", () => {
		const history = [
			{
					content: "",
					toolUses: [{ toolUseId: "call_nug", name: "Bash", input: {} }],
				},
			},
			{
					content: "",
				},
			},
		];
		expect(collectToolUseIdsFromHistory(history)).toEqual(new Set(["call_nug"]));
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
		const nestedResults = [{ toolUseId: "call_go_0", status: "success", content: [] }];

		expect(remapToolResultIds(anthropicResults, remap)).toBe(1);
		expect(remapToolResultIds(oaiResults, remap)).toBe(1);
		expect(remapToolResultIds(responsesResults, remap)).toBe(1);
		expect(remapToolResultIds(nestedResults, remap)).toBe(1);

		expect(anthropicResults[0].tool_use_id).toBe(renamed);
		expect(oaiResults[0].tool_call_id).toBe(renamed);
		expect(responsesResults[0].call_id).toBe(renamed);
		expect(nestedResults[0].toolUseId).toBe(renamed);
	});

	test("空 remap 时不触碰结果", () => {
		const results = [{ type: "tool_result", tool_use_id: "call_a", content: "ok" }];
		expect(remapToolResultIds(results, new Map())).toBe(0);
		expect(results[0].tool_use_id).toBe("call_a");
	});

	test("含非法字符的 ID 即使未与历史冲突也被改写", () => {
		const used = new Set<string>();
		const toolUses = [toolUse("Bash:0")];
		const remap = reserveUniqueToolUseIds(toolUses, used);

		expect(remap.get("Bash:0")).toBe("Bash_0");
		expect(used.has("Bash_0")).toBe(true);
		// Live objects keep the provider's id — persistence/UI/permissions key off it.
		expect(toolUses[0].toolUseId).toBe("Bash:0");
	});

	test("净化后的 ID 与历史已有 ID 冲突时再改名", () => {
		const used = new Set(["Bash_0"]);
		const remap = reserveUniqueToolUseIds([toolUse("Bash:0")], used);
		const next = remap.get("Bash:0") as string;

		expect(next).not.toBe("Bash_0");
		expect(next).toMatch(WIRE_PATTERN);
	});

	test("净化后的工具结果 ID 跟随改名，配对不断", () => {
		const used = new Set<string>();
		const remap = reserveUniqueToolUseIds([toolUse("Bash:0")], used);
		const renamed = remap.get("Bash:0") as string;

		const nestedResults = [{ toolUseId: "Bash:0", status: "success", content: [] }];
		expect(remapToolResultIds(nestedResults, remap)).toBe(1);
		expect(nestedResults[0].toolUseId).toBe(renamed);
		expect(renamed).toMatch(WIRE_PATTERN);
	});
});
