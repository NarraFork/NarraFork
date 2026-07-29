import { describe, expect, it } from "bun:test";
import {
	applyStreamingToolChunk,
	applyStreamingToolCompleted,
	applyStreamingToolLongRunning,
	applyStreamingToolOutput,
	applyStreamingToolStarted,
	collectPersistedToolUseIds,
	createStreamingToolStore,
	dropPersistedStreamingTools,
	streamingToolChunks,
} from "./streaming-tool-chunks";

describe("applyStreamingToolChunk — arguments being written", () => {
	it("creates an entry on the first chunk so the card appears immediately", () => {
		const store = createStreamingToolStore();
		expect(
			applyStreamingToolChunk(store, { toolUseId: "t1", toolName: "Bash", inputCharsTotal: 12 }),
		).toBe(true);
		const [chunk] = streamingToolChunks(store);
		expect(chunk?.toolUseId).toBe("t1");
		expect(chunk?.inputCharsTotal).toBe(12);
		expect(chunk?._started).toBeUndefined();
	});

	it("overwrites running totals but ACCUMULATES a streamed field", () => {
		const store = createStreamingToolStore();
		applyStreamingToolChunk(store, {
			toolUseId: "t1",
			toolName: "Write",
			inputCharsTotal: 10,
			streamingField: { name: "content", delta: "第一段" },
		});
		applyStreamingToolChunk(store, {
			toolUseId: "t1",
			toolName: "Write",
			inputCharsTotal: 25,
			streamingField: { name: "content", delta: "第二段" },
		});
		const [chunk] = streamingToolChunks(store);
		// A total is replaced; a delta stream is joined.
		expect(chunk?.inputCharsTotal).toBe(25);
		expect(chunk?.streamingFieldValue).toBe("第一段第二段");
	});

	it("restarts the accumulation when the streamed field changes", () => {
		const store = createStreamingToolStore();
		applyStreamingToolChunk(store, {
			toolUseId: "t1",
			toolName: "Edit",
			inputCharsTotal: 5,
			streamingField: { name: "old_string", delta: "AAA" },
		});
		applyStreamingToolChunk(store, {
			toolUseId: "t1",
			toolName: "Edit",
			inputCharsTotal: 9,
			streamingField: { name: "new_string", delta: "BBB" },
		});
		const [chunk] = streamingToolChunks(store);
		expect(chunk?.streamingFieldName).toBe("new_string");
		expect(chunk?.streamingFieldValue).toBe("BBB");
	});

	it("ignores a late argument chunk for an already-started tool", () => {
		const store = createStreamingToolStore();
		applyStreamingToolChunk(store, { toolUseId: "t1", toolName: "Bash", inputCharsTotal: 8 });
		applyStreamingToolStarted(store, {
			toolUseId: "t1",
			toolName: "Bash",
			input: { command: "ls" },
		});
		// Out-of-order delivery must not demote a running card back to "writing args".
		expect(
			applyStreamingToolChunk(store, { toolUseId: "t1", toolName: "Bash", inputCharsTotal: 9 }),
		).toBe(false);
		expect(streamingToolChunks(store)[0]?._status).toBe("running");
	});

	it("rejects an event with no tool id", () => {
		const store = createStreamingToolStore();
		expect(
			applyStreamingToolChunk(store, { toolUseId: "", toolName: "Bash", inputCharsTotal: 1 }),
		).toBe(false);
		expect(store.size).toBe(0);
	});

	it("keeps multiple concurrent tools in arrival order", () => {
		const store = createStreamingToolStore();
		applyStreamingToolChunk(store, { toolUseId: "t1", toolName: "Read", inputCharsTotal: 3 });
		applyStreamingToolChunk(store, { toolUseId: "t2", toolName: "Grep", inputCharsTotal: 4 });
		applyStreamingToolChunk(store, { toolUseId: "t1", toolName: "Read", inputCharsTotal: 6 });
		expect(streamingToolChunks(store).map((chunk) => chunk.toolUseId)).toEqual(["t1", "t2"]);
	});
});

describe("applyStreamingToolStarted / Completed — lifecycle", () => {
	it("promotes an unseen tool (started may arrive with no prior chunk)", () => {
		const store = createStreamingToolStore();
		expect(
			applyStreamingToolStarted(store, {
				toolUseId: "t9",
				toolName: "Bash",
				input: { command: "npm test" },
				streamStartedAt: 1234,
			}),
		).toBe(true);
		const [chunk] = streamingToolChunks(store);
		expect(chunk?._started).toBe(true);
		expect(chunk?._status).toBe("running");
		expect(chunk?._input).toEqual({ command: "npm test" });
		expect(chunk?._startedAt).toBe(1234);
	});

	it("records the terminal status and output, keeping the entry", () => {
		const store = createStreamingToolStore();
		applyStreamingToolStarted(store, { toolUseId: "t1", toolName: "Bash" });
		expect(
			applyStreamingToolCompleted(store, {
				toolUseId: "t1",
				status: "success",
				output: { stdout: "done" },
				durationMs: 42,
			}),
		).toBe(true);
		const [chunk] = streamingToolChunks(store);
		// Kept on purpose: dropping it here would blank the card until the persisted
		// message arrives.
		expect(chunk?._status).toBe("success");
		expect(chunk?._output).toEqual({ stdout: "done" });
		expect(chunk?._durationMs).toBe(42);
	});

	it("ignores completion for a tool the row never showed", () => {
		const store = createStreamingToolStore();
		expect(applyStreamingToolCompleted(store, { toolUseId: "ghost", status: "success" })).toBe(
			false,
		);
		expect(store.size).toBe(0);
	});

	it("marks a live tool long-running, idempotently", () => {
		const store = createStreamingToolStore();
		applyStreamingToolStarted(store, { toolUseId: "t1", toolName: "Bash" });
		expect(applyStreamingToolLongRunning(store, "t1")).toBe(true);
		expect(streamingToolChunks(store)[0]?._longRunning).toBe(true);
		// Repeats must not force a re-render.
		expect(applyStreamingToolLongRunning(store, "t1")).toBe(false);
		expect(applyStreamingToolLongRunning(store, "unknown")).toBe(false);
	});
});

describe("applyStreamingToolOutput — live stdout", () => {
	it("records output for a known running tool", () => {
		const store = createStreamingToolStore();
		applyStreamingToolStarted(store, { toolUseId: "t1", toolName: "Bash" });
		expect(applyStreamingToolOutput(store, "t1", "line 1\nline 2")).toBe(true);
		expect(streamingToolChunks(store)[0]?._streamingOutput).toBe("line 1\nline 2");
	});

	it("reports no change when the preview is identical", () => {
		const store = createStreamingToolStore();
		applyStreamingToolStarted(store, { toolUseId: "t1", toolName: "Bash" });
		applyStreamingToolOutput(store, "t1", "same");
		expect(applyStreamingToolOutput(store, "t1", "same")).toBe(false);
	});

	it("bounds a runaway output instead of growing without limit", () => {
		const store = createStreamingToolStore();
		applyStreamingToolStarted(store, { toolUseId: "t1", toolName: "Bash" });
		applyStreamingToolOutput(store, "t1", "x".repeat(400_000));
		const preview = streamingToolChunks(store)[0]?._streamingOutput ?? "";
		expect(preview.length).toBeLessThan(400_000);
	});

	it("ignores output for a tool that is not live", () => {
		const store = createStreamingToolStore();
		expect(applyStreamingToolOutput(store, "unknown", "data")).toBe(false);
	});
});

describe("dropPersistedStreamingTools — per-tool hand-off", () => {
	it("removes only the tools that are now persisted", () => {
		const store = createStreamingToolStore();
		applyStreamingToolChunk(store, { toolUseId: "t1", toolName: "Read", inputCharsTotal: 2 });
		applyStreamingToolChunk(store, { toolUseId: "t2", toolName: "Grep", inputCharsTotal: 2 });
		expect(dropPersistedStreamingTools(store, new Set(["t1"]))).toBe(true);
		expect(streamingToolChunks(store).map((chunk) => chunk.toolUseId)).toEqual(["t2"]);
	});

	it("reports no change when nothing matches", () => {
		const store = createStreamingToolStore();
		applyStreamingToolChunk(store, { toolUseId: "t1", toolName: "Read", inputCharsTotal: 2 });
		expect(dropPersistedStreamingTools(store, new Set(["other"]))).toBe(false);
		expect(dropPersistedStreamingTools(store, new Set())).toBe(false);
	});
});

describe("collectPersistedToolUseIds", () => {
	it("reads ids from toolCalls and from tool_use content blocks", () => {
		const ids = collectPersistedToolUseIds([
			{ toolCalls: [{ toolUseId: "a" }] },
			{
				contentJson: [
					{ type: "tool_use", id: "b" },
					{ type: "text", text: "x" },
				],
			},
		]);
		expect([...ids].sort()).toEqual(["a", "b"]);
	});

	it("walks child messages (a subagent page owns its children's tools)", () => {
		const ids = collectPersistedToolUseIds([
			{ toolCalls: [{ toolUseId: "parent" }], children: [{ toolCalls: [{ toolUseId: "child" }] }] },
		]);
		expect([...ids].sort()).toEqual(["child", "parent"]);
	});

	it("skips malformed entries", () => {
		const ids = collectPersistedToolUseIds([
			{ toolCalls: [{ toolUseId: "" }, {}, { toolUseId: 7 }] },
			{ contentJson: [{ type: "tool_use" }] },
			{},
		]);
		expect(ids.size).toBe(0);
	});
});
