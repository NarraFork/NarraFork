import { describe, expect, it } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api";
import { messageBody, rowWithElements } from "@shared/narrator-blocks/message-blocks";
import type { PersistedToolLiveUpdate } from "./useVListStreamingMessage";
import { toolCompletedPatch } from "./vlist-live-events";
import { patchToolLiveOutput } from "./vlist-live-patch";
import { PersistedToolLiveCoalescer } from "./vlist-persisted-tool-live";

function runningToolDoc(status = "running"): TreeMessage[] {
	const input = { command: "bun run build" };
	return [
		rowWithElements(
			{
				id: "m1",
				narratorId: "n1",
				parentToolUseId: null,
				role: "assistant",
				contentText: null,
				toolCalls: [
					{
						id: "tc-1",
						narratorId: "n1",
						messageId: "m1",
						toolUseId: "tu-1",
						toolName: "Bash",
						inputJson: input,
						status,
						createdAt: "2026-01-01T00:00:00.000Z",
					},
				],
				createdAt: "2026-01-01T00:00:00.000Z",
			},
			[{ type: "tool_use", id: "tu-1", name: "Bash", input, inputJson: input, status }],
		) as unknown as TreeMessage,
	];
}

function liveFields(messages: readonly TreeMessage[]) {
	const tc = messages[0]?.toolCalls?.[0] as unknown as Record<string, unknown> | undefined;
	const blocks = messageBody(messages[0] as never) as readonly Record<string, unknown>[];
	const block = blocks.find((b) => b.type === "tool_use");
	return { tc, block };
}

describe("patchToolLiveOutput", () => {
	it("writes the live body onto a running committed card (row + block)", () => {
		const result = patchToolLiveOutput(runningToolDoc(), "tu-1", {
			output: "[1/3] compiling…",
			progress: { completed: 0, total: 3 },
		});
		expect(result.changed).toBe(true);
		const { tc, block } = liveFields(result.messages);
		expect(tc?._streamingOutput).toBe("[1/3] compiling…");
		expect(block?._streamingOutput).toBe("[1/3] compiling…");
		expect(tc?._structuredProgress).toEqual({ completed: 0, total: 3 });
	});

	it("keeps messageVersion-relevant structure: same message count, same ids", () => {
		const doc = runningToolDoc();
		const result = patchToolLiveOutput(doc, "tu-1", { output: "x" });
		expect(result.messages).toHaveLength(doc.length);
		expect(result.messages[0]?.id).toBe(doc[0]?.id);
	});

	it("refuses a late frame once the card is terminal", () => {
		const doc = runningToolDoc("success");
		const result = patchToolLiveOutput(doc, "tu-1", { output: "late" });
		expect(result.changed).toBe(false);
		expect(result.messages).toBe(doc);
	});

	it("refuses an unknown tool and an empty update", () => {
		const doc = runningToolDoc();
		expect(patchToolLiveOutput(doc, "tu-x", { output: "x" }).changed).toBe(false);
		expect(patchToolLiveOutput(doc, "tu-1", {}).changed).toBe(false);
	});

	it("completion clears the live body so the card matches a reload", () => {
		const live = patchToolLiveOutput(runningToolDoc(), "tu-1", {
			output: "running…",
			progress: { completed: 1, total: 3 },
		}).messages;
		const done = toolCompletedPatch({ toolUseId: "tu-1", status: "success", output: "ok" })(live);
		const { tc, block } = liveFields(done.messages);
		expect(tc?.status).toBe("success");
		expect(tc?._streamingOutput).toBeUndefined();
		expect(tc?._structuredProgress).toBeUndefined();
		expect(block?._streamingOutput).toBeUndefined();
		expect(block?._structuredProgress).toBeUndefined();
	});
});

describe("PersistedToolLiveCoalescer", () => {
	function harness() {
		let now = 0;
		const applied: PersistedToolLiveUpdate[] = [];
		const timers: { at: number; fn: () => void; live: boolean }[] = [];
		const coalescer = new PersistedToolLiveCoalescer(
			{
				apply: (update) => applied.push(update),
				now: () => now,
				setTimer: (fn, ms) => {
					const timer = { at: now + ms, fn, live: true };
					timers.push(timer);
					return timer as never;
				},
				clearTimer: (handle) => {
					(handle as unknown as { live: boolean }).live = false;
				},
			},
			400,
		);
		const advance = (ms: number) => {
			now += ms;
			for (const timer of timers) {
				if (timer.live && timer.at <= now) {
					timer.live = false;
					timer.fn();
				}
			}
		};
		return { coalescer, applied, advance };
	}

	it("applies the first frame at once and coalesces the burst into one trailing patch", () => {
		const { coalescer, applied, advance } = harness();
		coalescer.push({ toolUseId: "t", output: "a" });
		expect(applied).toEqual([{ toolUseId: "t", output: "a" }]);
		coalescer.push({ toolUseId: "t", output: "a\nb" });
		coalescer.push({ toolUseId: "t", progress: { completed: 1, total: 2 } });
		coalescer.push({ toolUseId: "t", output: "a\nb\nc" });
		expect(applied).toHaveLength(1);
		advance(399);
		expect(applied).toHaveLength(1);
		advance(1);
		expect(applied[1]).toEqual({
			toolUseId: "t",
			output: "a\nb\nc",
			progress: { completed: 1, total: 2 },
		});
	});

	it("rate-limits each tool independently", () => {
		const { coalescer, applied } = harness();
		coalescer.push({ toolUseId: "a", output: "1" });
		coalescer.push({ toolUseId: "b", output: "1" });
		expect(applied.map((u) => u.toolUseId)).toEqual(["a", "b"]);
	});

	it("a tool whose window elapsed is forgotten and applies at once again", () => {
		const { coalescer, applied, advance } = harness();
		coalescer.push({ toolUseId: "a", output: "1" });
		advance(400);
		coalescer.push({ toolUseId: "b", output: "1" });
		coalescer.push({ toolUseId: "a", output: "2" });
		expect(applied.map((u) => `${u.toolUseId}:${u.output}`)).toEqual(["a:1", "b:1", "a:2"]);
	});

	it("dispose drops pending frames", () => {
		const { coalescer, applied, advance } = harness();
		coalescer.push({ toolUseId: "t", output: "a" });
		coalescer.push({ toolUseId: "t", output: "b" });
		coalescer.dispose();
		advance(1000);
		expect(applied).toHaveLength(1);
	});
});
