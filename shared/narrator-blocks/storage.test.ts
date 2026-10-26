import { describe, expect, test } from "bun:test";
import type { DecodableMessage } from "./decode";
import { assembleContent, matchBlocks, splitEnvelope } from "./storage";

function message(
	role: DecodableMessage["role"],
	contentJson: unknown,
	extra: Partial<DecodableMessage> = {},
): DecodableMessage {
	return {
		id: "m1",
		role,
		contentJson,
		contentText: null,
		parentToolUseId: null,
		...extra,
	};
}

const rows = (row: DecodableMessage, streaming = false) =>
	splitEnvelope(row, { streaming }).blocks.map((block) => ({
		payload: block.payload,
		state: block.state,
	}));

const SHAPES: Record<string, DecodableMessage> = {
	"assistant step with tools and a display-only result": message(
		"assistant",
		[
			{ type: "reasoning", id: "r1", text: "think", translatedText: "想", outputIndex: 0 },
			{ type: "text", id: "t1", text: "Running.", outputIndex: 1, completed: true },
			{ type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } },
			{ type: "tool_result", tool_use_id: "call_1", content: "a.txt" },
			{ type: "web_search", id: "ws_1", query: "bun" },
			{ type: "redacted_thinking", data: "xyz" },
		],
		{
			toolCalls: [
				{
					toolUseId: "call_1",
					toolName: "Bash",
					inputJson: {},
					outputJson: "a",
					status: "success",
				},
			],
		},
	),
	"user input with attachments": message(
		"user",
		[
			{ type: "image", imageId: "img1", mediaType: "image/png" },
			{ type: "text_file", filename: "a.md", fileId: "f1", size: 3 },
			{ type: "text", text: "look" },
		],
		{ contentText: "look" },
	),
	"review feedback card": message(
		"user",
		[
			{ type: "text", text: "Review findings" },
			{ type: "review_feedback", reviewId: "rv1", applied: true },
		],
		{ origin: "system", contentText: "Review findings" },
	),
	"running compact marker": message("system", [
		{ type: "compact", status: "compacting", summary: "", attempts: [{ status: "running" }] },
	]),
	"system injection with a companion card": message(
		"sys",
		[
			{ type: "system_injection", source: "spec_update", modelText: "Spec changed" },
			{ type: "spec_card", title: "Spec", isLatest: false },
		],
		{ contentText: "Spec changed" },
	),
	"malformed elements": message("assistant", [null, "stray", { type: "text", text: "ok" }, 7]),
	"assistant without decodable blocks": message("assistant", [{ type: "info", message: "x" }]),
	"empty assistant step": message("assistant", []),
};

describe("block storage codec", () => {
	test("reasoning generations and translated ranges are reader state, never model payload", () => {
		const part = {
			id: "p1",
			generation: "g1",
			start: 0,
			end: 5,
			sourceText: "think",
			translatedText: "思考",
		};
		for (const type of ["reasoning", "thinking"]) {
			const raw = {
				type,
				id: "r1",
				text: "think",
				translatedText: "想",
				translationGeneration: "g1",
				translationParts: [part],
			};
			const [block] = splitEnvelope(message("assistant", [raw])).blocks;
			expect(block.payload.raw).toEqual([{ type, id: "r1", text: "think" }]);
			expect(block.state).toEqual({
				raw: [{ translatedText: "想", translationGeneration: "g1", translationParts: [part] }],
			});
			expect(block.canonical?.state).toEqual({
				translatedText: "想",
				translationGeneration: "g1",
				translationParts: [part],
			});
			expect(assembleContent([{ payload: block.payload, state: block.state }])).toEqual([raw]);
		}
	});
	for (const [name, row] of Object.entries(SHAPES)) {
		test(`round-trips: ${name}`, () => {
			expect(assembleContent(rows(row))).toEqual(row.contentJson as unknown[]);
		});
	}

	test("each element belongs to exactly one block; leftovers ride with the block before", () => {
		const { blocks } = splitEnvelope(SHAPES["assistant step with tools and a display-only result"]);
		expect(blocks.map((block) => [block.kind, block.payload.raw.length])).toEqual([
			["reasoning", 1],
			["output", 1],
			["tool", 2],
			["tool", 1],
			["reasoning", 1],
		]);
		expect(blocks[2]).toMatchObject({ subtype: "Bash", wireId: "call_1", phase: "done" });
	});

	test("a non-assistant envelope is one block with its decoded kind and model text", () => {
		const [input] = splitEnvelope(SHAPES["user input with attachments"]).blocks;
		expect(input).toMatchObject({
			key: "envelope",
			kind: "input",
			subtype: null,
			modelText: "look",
		});
		const [review] = splitEnvelope(SHAPES["review feedback card"]).blocks;
		expect(review).toMatchObject({ kind: "context", subtype: "review_feedback" });
	});

	test("reader-only fields live in state, not in the payload", () => {
		const { blocks } = splitEnvelope(SHAPES["assistant step with tools and a display-only result"]);
		expect(blocks[0].payload.raw[0]).not.toHaveProperty("translatedText");
		expect(blocks[0].state).toEqual({ raw: [{ translatedText: "想" }] });
		const [compact] = splitEnvelope(SHAPES["running compact marker"]).blocks;
		expect(compact.payload.raw[0]).toEqual({ type: "compact", summary: "" });
		expect(compact.phase).toBe("open");
	});

	test("keys stay put when the step grows, so rows keep their identity", () => {
		const before = splitEnvelope(
			message("assistant", [
				{ type: "text", text: "a" },
				{ type: "tool_use", id: "c1", name: "Read", input: {} },
			]),
		).blocks.map((block) => block.key);
		const after = splitEnvelope(
			message("assistant", [
				{ type: "text", text: "a, more" },
				{ type: "tool_use", id: "c1", name: "Read", input: {} },
				{ type: "text", text: "b" },
			]),
		).blocks.map((block) => block.key);
		expect(after.slice(0, 2)).toEqual(before);
		expect(after[2]).toBe("text#1");
	});

	test("an incomplete checkpoint is open while streaming and aborted afterwards", () => {
		const row = message("assistant", [{ type: "text", id: "t", text: "par", completed: false }]);
		expect(splitEnvelope(row, { streaming: true }).blocks[0].phase).toBe("open");
		expect(splitEnvelope(row).blocks[0].phase).toBe("aborted");
	});

	test("a tool block follows its adopted ledger attempt", () => {
		const step = (status: string, outputJson: unknown) =>
			splitEnvelope(
				message("assistant", [{ type: "tool_use", id: "c", name: "Write", input: {} }], {
					toolCalls: [{ toolUseId: "c", toolName: "Write", inputJson: {}, outputJson, status }],
				}),
			).blocks[0].phase;
		expect(step("running", null)).toBe("open");
		expect(step("success", "ok")).toBe("done");
		expect(step("fail", { _text: "bad input", _broken: true })).toBe("failed");
	});
});

describe("matchBlocks", () => {
	const text = (n: number, body: string) => ({ key: `text#${n}`, payload: body });
	const tool = (id: string) => ({ key: `tool_use:${id}`, payload: `call ${id}` });

	test("a removed id-less block's row is not continued by the one that moves up", () => {
		expect(
			matchBlocks([text(0, "A"), tool("c1"), text(1, "B")], [tool("c1"), text(0, "B")]),
		).toEqual([1, 2]);
	});

	test("of identical blocks, the alignment keeps the ones around the same identities", () => {
		const before = [text(0, "ok"), tool("c1"), text(1, "ok")];
		expect(matchBlocks(before, [tool("c1"), text(0, "ok")])).toEqual([1, 2]);
		expect(matchBlocks(before, [text(0, "ok"), tool("c1")])).toEqual([0, 1]);
	});

	test("a block edited or streamed in place keeps its row", () => {
		expect(matchBlocks([text(0, "Hel")], [text(0, "Hello")])).toEqual([0]);
		expect(
			matchBlocks(
				[text(0, "A"), tool("c1"), text(1, "B")],
				[text(0, "B"), tool("c1"), text(1, "B")],
			),
		).toEqual([0, 1, 2]);
	});

	test("an identity follows its block wherever it moves; types never cross", () => {
		expect(matchBlocks([tool("c1"), tool("c2")], [tool("c2"), tool("c1")])).toEqual([1, 0]);
		expect(
			matchBlocks([{ key: "reasoning#0", payload: "r" }], [{ key: "text#0", payload: "t" }]),
		).toEqual([undefined]);
		expect(matchBlocks([tool("c1")], [tool("c9")])).toEqual([undefined]);
	});
});
