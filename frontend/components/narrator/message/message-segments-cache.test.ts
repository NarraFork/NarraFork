import { describe, expect, test } from "bun:test";
import type { ContentBlock, NarratorMsg } from "../narrator-panel-types";
import { MessageSegmentationCache, type RenderSegment, segmentMessages } from "./message-segments";

function message(id: string, contentJson: ContentBlock[] = []): NarratorMsg {
	return {
		id,
		narratorId: "narrator",
		parentToolUseId: null,
		role: "assistant",
		contentJson,
		contentText: null,
		toolCalls: [],
		children: [],
		createdAt: "2026-01-01T00:00:00.000Z",
	} as NarratorMsg;
}

function toolMessage(id: string): NarratorMsg {
	return message(id, [{ type: "tool_use", id: `tool-${id}`, name: "Read", input: {} }]);
}

function toolItems(segments: RenderSegment[]) {
	return segments.flatMap((segment) => (segment.kind === "tool-run" ? segment.items : []));
}

function expectColdEqual(messages: NarratorMsg[], cache: MessageSegmentationCache) {
	const actual = segmentMessages(messages, { cache });
	expect(actual).toEqual(segmentMessages(messages));
	return actual;
}

describe("MessageSegmentationCache", () => {
	test("500 historical messages reuse classifications, resolved calls and items over 20 tail updates", () => {
		let classificationReads = 0;
		let resolutionReads = 0;
		const history = Array.from({ length: 500 }, (_, index) => {
			const msg = toolMessage(String(index));
			const block = msg.contentJson[0];
			Object.defineProperty(block, "type", {
				enumerable: true,
				get() {
					classificationReads++;
					return "tool_use";
				},
			});
			Object.defineProperty(block, "inputJson", {
				enumerable: true,
				get() {
					resolutionReads++;
					return undefined;
				},
			});
			return msg;
		});
		const cache = new MessageSegmentationCache();
		const first = segmentMessages(history, { cache });
		const firstItems = toolItems(first);
		expect(classificationReads).toBe(1000);
		expect(resolutionReads).toBe(500);
		for (let index = 0; index < 20; index++) {
			const streamingMsg = toolMessage("__streaming__");
			streamingMsg.contentJson.push({ type: "text", text: `tail ${index}` });
			classificationReads = 0;
			resolutionReads = 0;
			const hot = segmentMessages(history, { cache, streamingMsg });
			expect(classificationReads).toBe(0);
			expect(resolutionReads).toBe(0);
			const hotItems = toolItems(hot);
			for (let i = 0; i < 500; i++) {
				expect(hotItems[i]).toBe(firstItems[i]);
				expect(hotItems[i].tc).toBe(firstItems[i].tc);
			}
			expect(hot).toEqual(segmentMessages(history, { streamingMsg }));
			expect(cache.size).toBe(500);
			expect(cache.atomCount).toBe(500);
		}
		expect(first).toHaveLength(1);
		expect(toolItems(first)).toHaveLength(500);
	});

	test("edits, append, trim and same-id replacements rebuild only changed materials", () => {
		const cache = new MessageSegmentationCache();
		const a = toolMessage("a");
		const b = toolMessage("b");
		const first = expectColdEqual([a, b], cache);
		const original = structuredClone(first);
		const [firstA, firstB] = toolItems(first);
		const replacement = { ...a, contentJson: [...a.contentJson, { type: "text", text: "edit" }] };
		const edited = expectColdEqual([replacement, b], cache);
		expect(toolItems(edited)[0]).not.toBe(firstA);
		expect(toolItems(edited)[1]).toBe(firstB);
		expect(cache.size).toBe(2);
		const bCopy = { ...b };
		const c = toolMessage("c");
		const appended = expectColdEqual([replacement, bCopy, c], cache);
		expect(toolItems(appended)[1]).not.toBe(firstB);
		expect(toolItems(appended)[1].msg).toBe(bCopy);
		expectColdEqual([c], cache);
		expect(cache.size).toBe(1);
		expect(cache.atomCount).toBe(1);
		expectColdEqual([], cache);
		expect(cache.size).toBe(0);
		expect(cache.atomCount).toBe(0);
		expect(first).toEqual(original);
	});

	test("same-object direct role/content/toolCalls/children replacements invalidate materials", () => {
		const cache = new MessageSegmentationCache();
		const msg = toolMessage("direct");
		const first = toolItems(expectColdEqual([msg], cache))[0];
		msg.toolCalls = [{ id: "row", toolUseId: "tool-direct", toolName: "Read", status: "success" }];
		const rowChanged = toolItems(expectColdEqual([msg], cache))[0];
		expect(rowChanged).not.toBe(first);
		expect(rowChanged.tc.status).toBe("success");
		const child = { ...message("child"), parentToolUseId: "tool-direct" };
		msg.children = [child];
		const childrenChanged = toolItems(expectColdEqual([msg], cache))[0];
		expect(childrenChanged).not.toBe(rowChanged);
		expect(childrenChanged.children).toEqual([child]);
		expect(childrenChanged.isSubagent).toBe(true);
		msg.contentJson = [{ type: "text", text: "replacement" }];
		expectColdEqual([msg], cache);
		msg.role = "user";
		expect(expectColdEqual([msg], cache)).toEqual([{ kind: "message", msg }]);
	});

	test("explicit invalidation and clear refresh nested in-place changes", () => {
		const cache = new MessageSegmentationCache();
		const msg = toolMessage("a");
		const stable = toolMessage("stable");
		const [first, stableItem] = toolItems(expectColdEqual([msg, stable], cache));
		msg.contentJson[0].name = "Send";
		cache.invalidate("a");
		const [updated, same] = toolItems(expectColdEqual([msg, stable], cache));
		expect(updated).not.toBe(first);
		expect(updated.tc.toolName).toBe("Send");
		expect(same).toBe(stableItem);
		msg.children.push({ ...message("child"), parentToolUseId: "tool-a" });
		cache.invalidate();
		expect(cache.size).toBe(0);
		expect(toolItems(expectColdEqual([msg, stable], cache))[0].children).toHaveLength(1);
		cache.clear();
		expect(cache.size).toBe(0);
		expect(cache.atomCount).toBe(0);
		expect(toolItems(expectColdEqual([msg, stable], cache))[1]).not.toBe(stableItem);
	});

	test("prunes the current effective window and never retains synthetic versions", () => {
		const cache = new MessageSegmentationCache();
		const a = toolMessage("a");
		const b = toolMessage("b");
		const firstA = toolItems(expectColdEqual([a, b], cache))[0];
		segmentMessages([b], { cache, streamingMsg: toolMessage("c") });
		expect(cache.size).toBe(2);
		const nextA = toolItems(expectColdEqual([a, b], cache))[0];
		expect(nextA).not.toBe(firstA);
		expect(cache.size).toBe(2);
		for (let index = 0; index < 10; index++) {
			expectColdEqual([b, toolMessage("__streaming__")], cache);
			expect(cache.size).toBe(1);
		}
	});

	test("message and atom budgets skip caching without changing output or retaining old versions", () => {
		const cache = new MessageSegmentationCache({ maxMessages: 2, maxAtoms: 3 });
		const a = toolMessage("a");
		const b = toolMessage("b");
		const c = toolMessage("c");
		const first = toolItems(expectColdEqual([a, b, c], cache));
		const next = toolItems(expectColdEqual([a, b, c], cache));
		expect(next[0]).toBe(first[0]);
		expect(next[1]).toBe(first[1]);
		expect(next[2]).not.toBe(first[2]);
		expect(cache.size).toBe(2);
		expect(cache.atomCount).toBe(2);
		const oversized = message(
			"a",
			Array.from({ length: 4 }, () => ({ type: "text", text: "x" })),
		);
		expectColdEqual([oversized, b], cache);
		expect(cache.size).toBe(1);
		expect(cache.atomCount).toBe(1);
		const smaller = message("a", [
			{ type: "text", text: "one" },
			{ type: "text", text: "two" },
		]);
		expectColdEqual([smaller, b], cache);
		expect(cache.size).toBe(2);
		expect(cache.atomCount).toBe(3);
		for (let index = 0; index < 20; index++) {
			expectColdEqual([toolMessage("a"), b], cache);
			expect(cache.size).toBe(2);
			expect(cache.atomCount).toBe(2);
		}
	});

	test("aggregate atom budget skips otherwise individually cacheable messages", () => {
		const cache = new MessageSegmentationCache({ maxMessages: 10, maxAtoms: 3 });
		const a = toolMessage("a");
		const b = toolMessage("b");
		a.contentJson.push({ type: "text", text: "a" });
		b.contentJson.push({ type: "text", text: "b" });
		const first = toolItems(expectColdEqual([a, b], cache));
		const second = toolItems(expectColdEqual([a, b], cache));
		expect(second[0]).toBe(first[0]);
		expect(second[1]).not.toBe(first[1]);
		expect(cache.size).toBe(1);
		expect(cache.atomCount).toBe(2);
	});

	test("separate owners cannot retain or invalidate each other's materials", () => {
		const firstCache = new MessageSegmentationCache();
		const secondCache = new MessageSegmentationCache();
		const msg = toolMessage("shared");
		const first = toolItems(expectColdEqual([msg], firstCache))[0];
		const second = toolItems(expectColdEqual([msg], secondCache))[0];
		expect(first).not.toBe(second);
		expect(first.tc).not.toBe(second.tc);
		firstCache.clear();
		expect(toolItems(expectColdEqual([msg], secondCache))[0]).toBe(second);
	});

	test("invalid budgets cannot disable finite retention limits", () => {
		for (const limit of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => new MessageSegmentationCache({ maxMessages: limit })).toThrow(RangeError);
			expect(() => new MessageSegmentationCache({ maxAtoms: limit })).toThrow(RangeError);
		}
	});

	test("uncached oversized and zero-budget messages remain correct", () => {
		for (const options of [{ maxMessages: 0 }, { maxAtoms: 0 }]) {
			const cache = new MessageSegmentationCache(options);
			expectColdEqual([toolMessage("a")], cache);
			expect(cache.size).toBe(0);
			expect(cache.atomCount).toBe(0);
		}
	});

	test("cold and hot paths retain unknown fallback, empty reasoning, retry IDs and child semantics", () => {
		const cache = new MessageSegmentationCache();
		const a = toolMessage("a");
		const b = message("b", [
			{ type: "reasoning", text: "" },
			{ type: "tool_use", id: "repeat", name: "Task", status: "running", tcId: "retry-2" },
			{ type: "tool_use", id: "repeat", name: "Task", tcId: "retry-1" },
			{ type: "text", text: "break" },
			{ type: "tool_use", id: "last", name: "Read" },
		]);
		b.toolCalls = [{ id: "retry-1", toolUseId: "repeat", toolName: "Task", status: "success" }];
		b.children = [{ ...message("child"), parentToolUseId: "repeat" }];
		const unknown = message("unknown", [{ type: "future_block" }]);
		const mixed = message("mixed", [
			{ type: "future_block" },
			{ type: "image_generation" },
			{ type: "web_search" },
			{ type: "file_reference" },
			{ type: "text_file" },
			{ type: "image" },
			{ type: "thinking", thinking: "visible" },
		]);
		const messages = [a, b, unknown, message("empty"), mixed, { ...a, id: "user", role: "user" }];
		const cold = segmentMessages(messages);
		const cached = expectColdEqual(messages, cache);
		expect(expectColdEqual(messages, cache)).toEqual(cold);
		expect(cached[0]).toMatchObject({ kind: "tool-run", sourceMessages: [a, b] });
		const items = toolItems(cached);
		expect(items[1].tc.id).toBe("retry-2");
		expect(items[2].tc.id).toBe("retry-2");
		expect(items[1].children).toEqual(b.children);
		expect(items[1].isSubagent).toBe(true);
		expect(cached).toContainEqual({ kind: "message", msg: unknown });
	});
});
