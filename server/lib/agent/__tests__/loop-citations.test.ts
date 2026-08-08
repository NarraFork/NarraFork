/**
 * loop-citations.test.ts — the loop is the single gate between provider output and
 * everything persisted or replayed. Three invariants live here:
 *
 *  1. provider-internal `citeturn…` markers never reach the VISIBLE text of
 *     `block_complete`, `assistant_message`, or `pushAssistantTurn` (the model
 *     history — if they did, the model would keep reproducing them and the leak
 *     would be self-sustaining);
 *  2. structured annotations survive as `citations` on the text block, where the
 *     internal ref is allowed to live as metadata;
 *  3. a turn with no citations produces byte-identical output to before.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import type { ProviderAdapter } from "../provider";
import { toolRegistry } from "../tool-registry";
import type { AgentConfig, AgentEvent } from "../types";

type Scenario =
	| "marker_only"
	| "annotations"
	| "annotations_and_marker"
	| "two_items_annotation"
	| "item_boundary"
	| "abort_mid_prefix"
	| "plain"
	| "marker_then_tool";

let scenario: Scenario = "marker_only";
let attempt = 0;
/** Text handed to pushAssistantTurn — i.e. what the NEXT turn's model sees. */
const historyText: string[] = [];

const PUA_START = "\ue200";
const PUA_MID = "\ue202";
const PUA_END = "\ue201";
const MARKER = `${PUA_START}cite${PUA_MID}turn0search1${PUA_END}`;

const testProvider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		attempt++;
		params.onRequestStart?.();
		if (scenario === "marker_only") {
			// Split across arbitrary provider deltas: none of the partial envelope may
			// cross the loop's stream_text boundary.
			yield { text: `结论成立${PUA_START}ci` };
			yield { text: `te${PUA_MID}turn0sea` };
			yield { text: `rch1${PUA_END}` };
			return;
		}
		if (scenario === "marker_then_tool") {
			if (attempt === 1) {
				// Text + a tool call: this is the shape that makes the loop push the
				// assistant turn into the model history.
				yield { text: `第一段结论${MARKER}` };
				yield { toolUses: [{ toolUseId: "tu_1", name: "CitationProbe", input: { value: "x" } }] };
				return;
			}
			yield { text: "收尾" };
			return;
		}
		if (scenario === "annotations") {
			yield { text: "answer text" };
			yield {
				textCitations: [{ startIndex: 0, endIndex: 11, url: "https://example.test/a", title: "A" }],
			};
			return;
		}
		if (scenario === "annotations_and_marker") {
			yield { text: `ab ${MARKER} cd` };
			// Annotation indices address the RAW provider text.
			const raw = `ab ${MARKER} cd`;
			yield {
				textCitations: [
					{ startIndex: raw.length - 2, endIndex: raw.length, url: "https://example.test/b" },
				],
			};
			return;
		}
		if (scenario === "two_items_annotation") {
			// Two text items. The annotation belongs to item 1 and its indices are
			// RELATIVE TO THAT ITEM ("second" → end index 6), not to the joined text.
			yield { text: "first ", textOutputIndex: 0 };
			yield { textItemDone: true, textOutputIndex: 0 };
			yield { text: "second", textOutputIndex: 1 };
			yield {
				textCitations: [
					{ startIndex: 0, endIndex: 6, url: "https://example.test/c", outputIndex: 1 },
				],
			};
			yield { textItemDone: true, textOutputIndex: 1 };
			return;
		}
		if (scenario === "abort_mid_prefix") {
			// Prose whose tail is an opener PREFIX, then the stream dies. The parser is
			// still withholding those bytes when the abort path runs.
			yield { text: `结论已经确认${PUA_START}ci` };
			yield { invalidState: { reason: "stream_closed", message: "connection lost" } };
			return;
		}
		if (scenario === "item_boundary") {
			// A literal partial opener at item 0's end must be released BEFORE item 1.
			// Flushing only at response end would reorder the stream as "AB<partial>".
			yield { text: `A${PUA_START}ci`, textOutputIndex: 0 };
			yield { textItemDone: true, textOutputIndex: 0 };
			yield { text: "B", textOutputIndex: 1 };
			yield { textItemDone: true, textOutputIndex: 1 };
			return;
		}
		yield { text: "plain answer" };
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: (_history, text) => {
		historyText.push(text);
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};

const realProviderModule = { ...(await import("../provider")) };

mock.module("../provider", () => ({
	getProvider: () => testProvider,
	resolveProviderAndModel: () => ({
		requestedProvider: "test",
		requestedModel: "test:model",
		provider: "test",
		adapter: testProvider,
		model: "test:model",
	}),
}));

const { agentLoop } = await import("../loop");

toolRegistry.register({
	name: "CitationProbe",
	description: "Test tool that lets the loop reach pushAssistantTurn",
	parameters: z.object({ value: z.string() }),
	execute: async () => ({ output: "ok" }),
});

afterAll(() => {
	mock.module("../provider", () => realProviderModule);
	toolRegistry.unregister("CitationProbe");
	mock.restore();
});

function makeConfig(signal: AbortSignal): AgentConfig {
	return {
		narratorId: "n-citations",
		conversationId: "conv-citations",
		model: "test:model",
		provider: "test",
		cwd: "/tmp",
		signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		retryBackoffCeilMs: 1,
	};
}

async function runTurn(next: Scenario): Promise<AgentEvent[]> {
	scenario = next;
	attempt = 0;
	historyText.length = 0;
	const ac = new AbortController();
	const events: AgentEvent[] = [];
	for await (const event of agentLoop(makeConfig(ac.signal), "ask", [])) {
		events.push(event);
	}
	return events;
}

function textBlocks(events: AgentEvent[]) {
	return events.flatMap((event) =>
		event.type === "block_complete" && event.block.type === "text" ? [event.block] : [],
	);
}

function assistantMessages(events: AgentEvent[]) {
	return events.flatMap((event) => (event.type === "assistant_message" ? [event] : []));
}

function streamedText(events: AgentEvent[]): string {
	return events.flatMap((event) => (event.type === "stream_text" ? [event.text] : [])).join("");
}

describe("inline marker stripping", () => {
	test("markers are removed from the persisted block and the assistant message", async () => {
		const events = await runTurn("marker_only");

		const blocks = textBlocks(events);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).toBe("结论成立");
		// The internal ref survives as METADATA (it is never rendered verbatim).
		expect(blocks[0].citations).toEqual([
			{ startIndex: 4, endIndex: 4, sources: [{ sourceRef: "turn0search1" }] },
		]);

		const messages = assistantMessages(events);
		expect(messages).toHaveLength(1);
		expect(messages[0].text).toBe("结论成立");
		expect(messages[0].text).not.toContain("turn0search1");
	});

	test("the stream boundary emits only visible text, matching Codex", async () => {
		const events = await runTurn("marker_only");

		// Before the Codex-alignment change raw marker deltas crossed WebSocket and
		// every renderer had to rediscover and hide them. Now the joined stream is
		// already the same clean prose as block_complete/assistant_message.
		expect(streamedText(events)).toBe("结论成立");
		for (const event of events) {
			const visible: string[] = [];
			if (event.type === "stream_text") visible.push(event.text);
			if (event.type === "assistant_message") visible.push(event.text);
			if (event.type === "block_complete" && event.block.type === "text") {
				visible.push(event.block.text);
			}
			for (const text of visible) {
				expect(text).not.toContain("turn0search1");
				expect(text).not.toContain(PUA_START);
				expect(text).not.toContain("cite");
			}
		}
	});

	/**
	 * An abort path persists the RAW accumulated text, so it must first release
	 * whatever the stream parser is still holding as a possible opener prefix.
	 * Otherwise the live view ends up shorter than the block persisted in the same
	 * tick, and the difference reappears on reload.
	 */
	test("abort releases the withheld opener prefix before persisting", async () => {
		const events = await runTurn("abort_mid_prefix");

		const block = textBlocks(events)[0];
		expect(block).toBeDefined();
		// Fail open: an opener that never completed stays visible, matching Codex.
		expect(block.text).toBe(`结论已经确认${PUA_START}ci`);
		// The stream must carry exactly what was persisted — no silent shortfall.
		expect(streamedText(events)).toBe(block.text);
	});

	test("finishes each output item before the next item streams", async () => {
		const events = await runTurn("item_boundary");

		expect(streamedText(events)).toBe(`A${PUA_START}ciB`);
		expect(textBlocks(events)[0].text).toBe(`A${PUA_START}ciB`);
	});

	test("the next turn's model history receives the cleaned text", async () => {
		await runTurn("marker_then_tool");

		// Turn 1 had text + a tool call, so its assistant turn entered the history.
		expect(historyText.length).toBeGreaterThan(0);
		expect(historyText[0]).toBe("第一段结论");
		for (const text of historyText) {
			expect(text).not.toContain("turn0search1");
			expect(text).not.toContain("cite");
		}
	});
});

describe("structured annotations", () => {
	test("are attached to the text block and the assistant message", async () => {
		const events = await runTurn("annotations");

		const blocks = textBlocks(events);
		expect(blocks[0].text).toBe("answer text");
		expect(blocks[0].citations).toEqual([
			{
				startIndex: 0,
				endIndex: 11,
				sources: [{ url: "https://example.test/a", title: "A" }],
			},
		]);
		expect(assistantMessages(events)[0].citations).toHaveLength(1);
		// The visible text stays clean prose, without Markdown link syntax.
		expect(assistantMessages(events)[0].text).toBe("answer text");
	});

	test("a second output item's annotation anchors by item-relative index", async () => {
		const events = await runTurn("two_items_annotation");

		const block = textBlocks(events)[0];
		expect(block.text).toBe("first second");
		// Item-relative [0,6) inside item 1 → [6,12) in the joined text. Without the
		// per-item base offset this would anchor at [0,6) and cite "first ".
		expect(block.citations).toEqual([
			{ startIndex: 6, endIndex: 12, sources: [{ url: "https://example.test/c" }] },
		]);
	});

	test("annotation indices are remapped after markers shift the text", async () => {
		const events = await runTurn("annotations_and_marker");

		const blocks = textBlocks(events);
		// Raw "ab <envelope> cd" → cleaned "ab  cd"; the annotation covering the raw
		// tail must land inside the cleaned text, not past its end.
		expect(blocks[0].text).toBe("ab  cd");
		const citations = blocks[0].citations ?? [];
		expect(citations.some((c) => c.sources.some((s) => s.url === "https://example.test/b"))).toBe(
			true,
		);
		for (const citation of citations) {
			expect(citation.endIndex).toBeLessThanOrEqual(6);
		}
	});
});

describe("no-citation turns are unchanged", () => {
	test("a plain answer carries no citations field at all", async () => {
		const events = await runTurn("plain");

		const blocks = textBlocks(events);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).toBe("plain answer");
		expect(blocks[0].citations).toBeUndefined();
		expect(assistantMessages(events)[0].citations).toBeUndefined();
	});
});
