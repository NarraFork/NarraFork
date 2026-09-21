import { describe, expect, test } from "bun:test";
import { OutputContentAccumulator } from "../output-content";
import type { AgentEvent } from "../types";

function blocks(events: Iterable<AgentEvent>) {
	return [...events].flatMap((event) => (event.type === "block_complete" ? [event.block] : []));
}

describe("output content lifecycle", () => {
	test("a lane change commits the previous block before the next lane's delta", () => {
		const content = new OutputContentAccumulator();
		blocks(content.begin("reasoning"));
		const reasoning = content.append("reasoning", "thought");
		expect(blocks(content.begin("text"))).toEqual([
			{
				type: "reasoning",
				id: reasoning.blockId,
				revision: reasoning.blockRevision,
				outputIndex: 0,
				rawTextLength: 7,
				text: "thought",
				providerMetadata: undefined,
			},
		]);
		const text = content.append("text", "answer");
		expect(blocks(content.beforeExternal("tool-1"))).toEqual([
			{
				type: "text",
				id: text.blockId,
				revision: text.blockRevision,
				outputIndex: 1,
				rawTextLength: 6,
				text: "answer",
			},
		]);
		expect(blocks(content.flush())).toEqual([]);
	});

	test("checkpoint retains the raw baseline for later deltas of the SAME item", () => {
		const content = new OutputContentAccumulator();
		const lane = { blockId: "native-item", outputIndex: 0 };
		blocks(content.begin("text", lane));
		const first = content.append("text", "before", lane);
		const checkpoint = blocks(content.beforeExternal("tool-1", 1));
		expect(checkpoint[0]).toMatchObject({ id: first.blockId, revision: 1, text: "before" });
		blocks(content.begin("text", lane));
		const later = content.append("text", "+after", lane);
		expect(later.blockId).toBe(first.blockId);
		expect(later.blockRevision).toBeGreaterThan(first.blockRevision);
		expect(blocks(content.flush())[0]).toMatchObject({
			id: first.blockId,
			revision: 2,
			text: "before+after",
		});
		expect(blocks(content.flush())).toEqual([]);
	});

	test("late reasoning credentials patch the original complete item", () => {
		const content = new OutputContentAccumulator();
		const lane = { blockId: "rs-1", outputIndex: 0 };
		const streamed = content.append("reasoning", "full reasoning", lane, {
			openai: { itemId: "rs-1" },
		});
		blocks(content.beforeExternal("tool-1", 1));
		const updates = blocks(
			content.reasoningMetadata(
				{ openai: { reasoningEncryptedContent: "cipher" }, signatureSource: "gateway-a" },
				lane,
			),
		);
		expect(updates).toHaveLength(1);
		expect(updates[0]).toMatchObject({
			type: "reasoning",
			id: streamed.blockId,
			revision: 2,
			text: "full reasoning",
			providerMetadata: {
				openai: { itemId: "rs-1", reasoningEncryptedContent: "cipher" },
				signatureSource: "gateway-a",
			},
		});
		expect(
			blocks(
				content.reasoningMetadata(
					{ openai: { reasoningEncryptedContent: "cipher" }, signatureSource: "gateway-a" },
					lane,
				),
			),
		).toEqual([]);
		expect(blocks(content.flush())).toEqual([]);
	});

	test("native complete publishes even thinking without a signature", () => {
		const content = new OutputContentAccumulator();
		const lane = { blockId: "thinking-0", outputIndex: 0 };
		const streamed = content.append("reasoning", "ordinary thought", lane);
		expect(
			blocks(content.boundary({ kind: "reasoning", phase: "complete", ...lane }))[0],
		).toMatchObject({ id: streamed.blockId, text: "ordinary thought" });
		expect(blocks(content.flush())).toEqual([]);
	});

	test("fallback text→tool→text keeps distinct ids and real order", () => {
		const content = new OutputContentAccumulator();
		const first = content.append("text", "first");
		blocks(content.beforeExternal("tool-1"));
		blocks(content.begin("text"));
		const second = content.append("text", "second");
		expect(second.blockId).not.toBe(first.blockId);
		const external = { type: "tool_use" as const, toolUseId: "tool-1", name: "Read", input: {} };
		const ordered = content.orderedContent([external]);
		expect(ordered.map((block) => block.type)).toEqual(["text", "tool_use", "text"]);
		expect(content.orderedContent([external])).toEqual(ordered);
	});

	test("different content parts sharing a native output index do not merge", () => {
		const content = new OutputContentAccumulator();
		content.append("text", "part zero", { blockId: "message/part0", outputIndex: 0 });
		blocks(content.begin("text", { blockId: "message/part1", outputIndex: 0 }));
		content.append("text", "part one", { blockId: "message/part1", outputIndex: 0 });
		const ordered = content.orderedContent();
		expect(ordered).toHaveLength(2);
		expect(ordered[0]).not.toHaveProperty("id", "message/part0");
		expect(ordered[0]).toMatchObject({ text: "part zero" });
		expect(ordered[1]).toMatchObject({ text: "part one" });
	});

	test("late citations stay local to the second text block", () => {
		const content = new OutputContentAccumulator();
		content.append("text", "first ", { blockId: "t0", outputIndex: 0 });
		blocks(content.begin("text", { blockId: "t1", outputIndex: 1 }));
		const second = content.append("text", "second", { blockId: "t1", outputIndex: 1 });
		blocks(content.flush());
		const updated = blocks(
			content.addCitations(
				[{ startIndex: 0, endIndex: 6, url: "https://example.test/source", outputIndex: 1 }],
				{ blockId: "t1" },
			),
		);
		expect(updated).toHaveLength(1);
		expect(updated[0]).toMatchObject({
			id: second.blockId,
			revision: 2,
			text: "second",
			citations: [{ startIndex: 0, endIndex: 6 }],
		});
		expect(content.orderedContent()[0]).not.toHaveProperty("citations");
	});

	test("citation cleanup does not mutate the raw text needed for a later delta", () => {
		const content = new OutputContentAccumulator();
		const lane = { blockId: "t0", outputIndex: 0 };
		content.append("text", "answer\ue200cite\ue202turn0search1\ue201", lane);
		expect(blocks(content.flush())[0]).toMatchObject({ text: "answer" });
		content.append("text", " tail", lane);
		expect(blocks(content.flush())[0]).toMatchObject({ text: "answer tail", revision: 2 });
	});

	test("a retry reusing the native lane gets a different display identity", () => {
		const content = new OutputContentAccumulator();
		const first = content.append("text", "abandoned", { blockId: "t0", outputIndex: 0 });
		blocks(content.flush());
		content.reset();
		const retried = content.append("text", "new attempt", { blockId: "t0", outputIndex: 0 });
		expect(retried.blockId).not.toBe(first.blockId);
		expect(retried.blockRevision).toBe(1);
		expect(blocks(content.flush())).toHaveLength(1);
	});

	test("a metadata-only native reasoning item preserves encrypted replay state", () => {
		const content = new OutputContentAccumulator();
		const lane = { blockId: "rs-hidden", outputIndex: 0 };
		blocks(
			content.reasoningMetadata(
				{ openai: { itemId: "rs-hidden", reasoningEncryptedContent: "encrypted" } },
				lane,
			),
		);
		const completed = blocks(content.boundary({ kind: "reasoning", phase: "complete", ...lane }));
		expect(completed).toHaveLength(1);
		expect(completed[0]).toMatchObject({
			type: "reasoning",
			text: "",
			providerMetadata: { openai: { itemId: "rs-hidden", reasoningEncryptedContent: "encrypted" } },
		});
	});
});

describe("unindexed metadata before and after content", () => {
	test("unindexed citations use turn coordinates across text→tool→text", () => {
		const content = new OutputContentAccumulator();
		content.append("text", "first ");
		blocks(content.beforeExternal("tool-1"));
		blocks(content.begin("text"));
		content.append("text", "second");
		blocks(content.addCitations([{ startIndex: 6, endIndex: 12, url: "https://example.test/c" }]));
		const output = content.orderedContent().filter((block) => block.type === "text");
		expect(output[0].citations).toBeUndefined();
		expect(output[1]).toMatchObject({
			text: "second",
			citations: [{ startIndex: 0, endIndex: 6 }],
		});
	});

	test("unindexed citation arriving before the first delta attaches to the eventual body", () => {
		const content = new OutputContentAccumulator();
		blocks(content.addCitations([{ startIndex: 0, endIndex: 5, url: "https://example.test/c" }]));
		content.append("text", "hello");
		const output = blocks(content.flush());
		expect(output).toHaveLength(1);
		expect(output[0]).toMatchObject({ text: "hello", citations: [{ startIndex: 0, endIndex: 5 }] });
	});

	test("unindexed reasoning metadata arriving first belongs to the subsequent text", () => {
		const content = new OutputContentAccumulator();
		blocks(content.reasoningMetadata({ signatureSource: "native-source" }));
		const streamed = content.append("reasoning", "exact reasoning");
		expect(streamed.blockTextOffset).toBe(0);
		const output = blocks(content.flush());
		expect(output).toHaveLength(1);
		expect(output[0]).toMatchObject({
			text: "exact reasoning",
			id: streamed.blockId,
			providerMetadata: { signatureSource: "native-source" },
		});
	});
});

describe("display blocks and compatibility replay agree", () => {
	test("metadata-first references rebase to the same second item in aggregate text", () => {
		const content = new OutputContentAccumulator();
		content.append("text", "first ", { blockId: "t0", outputIndex: 0 });
		blocks(content.boundary({ kind: "text", phase: "complete", blockId: "t0", outputIndex: 0 }));
		blocks(
			content.addCitations(
				[{ startIndex: 0, endIndex: 6, url: "https://example.test/c", outputIndex: 1 }],
				{ blockId: "t1" },
			),
		);
		content.append("text", "second", { blockId: "t1", outputIndex: 1 });
		expect(content.finalizeText()).toMatchObject({
			text: "first second",
			citations: [{ startIndex: 6, endIndex: 12 }],
		});
		const block = content
			.orderedContent()
			.find((block) => block.type === "text" && block.text === "second");
		expect(block).toMatchObject({ citations: [{ startIndex: 0, endIndex: 6 }] });
	});

	test("an indexed redacted block retains arrival order before anonymous text", () => {
		const content = new OutputContentAccumulator();
		content.observeExternal("redacted:0", 0);
		content.append("text", "after hidden reasoning");
		const external = { type: "redacted_thinking" as const, data: "secret", outputIndex: 0 };
		expect(content.orderedContent([external]).map((block) => block.type)).toEqual([
			"redacted_thinking",
			"text",
		]);
		expect(content.orderedContent([external])).toEqual(content.orderedContent([external]));
	});
});
