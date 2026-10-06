import { describe, expect, it } from "bun:test";
import { buildTailMeta, type TailMetaMessage, type TailMetaOptions } from "./vlist-tail-meta";

const OPTS: TailMetaOptions = {
	statusReady: true,
	streamingMsgId: "__streaming_tool_chunks__",
	findSpecTasksToolUseId: () => null,
};

describe("buildTailMeta", () => {
	it("finds the last real message (skips streaming + error system)", () => {
		const messages: TailMetaMessage[] = [
			{ id: "a1", role: "assistant" },
			{ id: "s1", role: "system", contentJson: [{ type: "error" }] },
			{ id: "__streaming_tool_chunks__", role: "assistant" },
		];
		const meta = buildTailMeta(messages, OPTS);
		// tail-first: streaming skipped, error system skipped → a1
		expect(meta.lastRealMessage).toEqual({ id: "a1", role: "assistant" });
	});

	it("finds the last user message id, skipping optimistic ids", () => {
		const messages: TailMetaMessage[] = [
			{ id: "u1", role: "user" },
			{ id: "a1", role: "assistant" },
			{ id: "optimistic-123", role: "user" },
		];
		const meta = buildTailMeta(messages, OPTS);
		expect(meta.lastUserMessageId).toBe("u1");
	});

	it("captures contextPercent + turnUsageJson from the tail-most carrier", () => {
		const messages: TailMetaMessage[] = [
			{ id: "a1", role: "assistant", contextPercent: 40, turnUsageJson: { input_tokens: 1 } },
			{ id: "a2", role: "assistant", contextPercent: 75, turnUsageJson: { input_tokens: 2 } },
		];
		const meta = buildTailMeta(messages, OPTS);
		// scans tail-first → a2's 75 wins
		expect(meta.contextPercent).toBe(75);
		expect(meta.turnUsageJson).toEqual({ input_tokens: 2 });
	});

	it("passes through statusReady", () => {
		const meta = buildTailMeta([{ id: "a1", role: "assistant" }], {
			...OPTS,
			statusReady: false,
		});
		expect(meta.statusReady).toBe(false);
	});

	it("injects the spec-tasks tool-use id resolver", () => {
		const meta = buildTailMeta([{ id: "a1", role: "assistant" }], {
			...OPTS,
			findSpecTasksToolUseId: () => "tu-42",
		});
		expect(meta.latestSpecTasksToolUseId).toBe("tu-42");
	});

	it("handles an empty list with null/undefined fields", () => {
		const meta = buildTailMeta([], OPTS);
		expect(meta.lastRealMessage).toBeNull();
		expect(meta.lastUserMessageId).toBeUndefined();
		expect(meta.contextPercent).toBeUndefined();
	});

	it("skips messages without an id", () => {
		const messages: TailMetaMessage[] = [
			{ id: "a1", role: "assistant" },
			{ role: "user" }, // no id
		];
		const meta = buildTailMeta(messages, OPTS);
		expect(meta.lastRealMessage).toEqual({ id: "a1", role: "assistant" });
		expect(meta.lastUserMessageId).toBeUndefined();
	});
});
