import { describe, expect, it } from "bun:test";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
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
			rowWithElements({ id: "s1", role: "system" }, [{ type: "error" }]),
			{ id: "__streaming_tool_chunks__", role: "assistant" },
		];
		const meta = buildTailMeta(messages, OPTS);
		// tail-first: streaming skipped, error system skipped → a1
		expect(meta.lastRealMessage).toEqual({ id: "a1", role: "assistant" });
	});

	for (const role of ["user", "assistant", "sys"]) {
		it(`preserves the ${role} tail behind hidden epoch markers`, () => {
			const messages: TailMetaMessage[] = [
				{ id: "turn", role },
				rowWithElements({ id: "epoch-1", role: "system" }, [{ type: "epoch" }]),
				rowWithElements({ id: "epoch-2", role: "system" }, [{ type: "epoch" }]),
				rowWithElements({ id: "error", role: "system" }, [{ type: "error" }]),
				{ id: OPTS.streamingMsgId, role: "assistant" },
			];
			const meta = buildTailMeta(messages, OPTS);
			// Retry sees the unanswered user; Continue retains assistant/injection tails.
			expect(meta.lastRealMessage).toEqual({ id: "turn", role });
			expect(meta.lastUserMessageId).toBe(role === "user" ? "turn" : undefined);
		});
	}

	it("has no conversation tail when only an epoch marker exists", () => {
		const meta = buildTailMeta(
			[rowWithElements({ id: "epoch", role: "system" }, [{ type: "epoch" }])],
			OPTS,
		);
		expect(meta.lastRealMessage).toBeNull();
		expect(meta.lastUserMessageId).toBeUndefined();
	});

	it("does not skip a compact boundary along with hidden epoch markers", () => {
		const meta = buildTailMeta(
			[
				{ id: "user", role: "user" },
				rowWithElements({ id: "compact", role: "system" }, [{ type: "compact" }]),
				rowWithElements({ id: "epoch", role: "system" }, [{ type: "epoch" }]),
			],
			OPTS,
		);
		expect(meta.lastRealMessage).toEqual({ id: "compact", role: "system" });
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
