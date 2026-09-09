import { describe, expect, it } from "bun:test";
import {
	createDiffDocument,
	getDiffRowAnchor,
	projectDiffDocument,
	resolveDiffSourcePoint,
} from "@shared/pretext-layout/diff-core";
import { normalizeSourceText } from "@shared/pretext-layout/source-text";
import {
	buildTopLevelStreamingChunksMsg,
	resolveAllToolCallsFromMsg,
	topLevelStreamingChunkToToolFields,
} from "../narrator-message-helpers";
import {
	applyStreamingToolChunk,
	applyStreamingToolCompleted,
	applyStreamingToolExecuting,
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
		// Out-of-order delivery must not demote a promoted card back to "writing args".
		expect(
			applyStreamingToolChunk(store, { toolUseId: "t1", toolName: "Bash", inputCharsTotal: 9 }),
		).toBe(false);
		expect(streamingToolChunks(store)[0]?._status).toBe("initializing");
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
		// `initializing`, NOT `running`: `tool_started` means the input finished parsing,
		// and the permission gate sits after it. `tool_executing` is what proves execution.
		expect(chunk?._status).toBe("initializing");
		expect(chunk?._input).toEqual({ command: "npm test" });
		expect(chunk?._startedAt).toBe(1234);
	});

	it("turns a tool RUNNING only once execution actually begins", () => {
		// The lifecycle thefive-state shimmer depends on: `tool_started` (input parsed) is
		// NOT execution; `tool_executing` (permission granted) is.
		const store = createStreamingToolStore();
		applyStreamingToolStarted(store, { toolUseId: "t1", toolName: "Bash" });
		expect(streamingToolChunks(store)[0]?._status).toBe("initializing");
		expect(applyStreamingToolExecuting(store, { toolUseId: "t1" })).toBe(true);
		expect(streamingToolChunks(store)[0]?._status).toBe("running");
	});

	it("⚠️ keeps RUNNING when tool_started arrives LATE — and still lands the input", () => {
		// The regression this guard exists for. `loop.ts` starts eager execution BEFORE it
		// yields `tool_call`, so for most tools `tool_executing` reaches the client first
		// and `tool_started` lands after it.
		//
		// BOTH assertions are required. Guarding by dropping the whole late event would
		// satisfy the status check while losing `_input` — and `_input` is carried ONLY by
		// `tool_started`, so the card would render with no command and no file path. That
		// trades a colour bug for missing content, which is worse.
		const store = createStreamingToolStore();
		applyStreamingToolExecuting(store, { toolUseId: "t1" });
		expect(streamingToolChunks(store)[0]?._status).toBe("running");

		applyStreamingToolStarted(store, {
			toolUseId: "t1",
			toolName: "Bash",
			input: { command: "npm test" },
			streamStartedAt: 4321,
		});
		const [chunk] = streamingToolChunks(store);
		expect(chunk?._status).toBe("running");
		expect(chunk?._input).toEqual({ command: "npm test" });
		expect(chunk?._startedAt).toBe(4321);
		expect(chunk?.toolName).toBe("Bash");
	});

	it("never reopens a tool that already finished", () => {
		// A reconnect can replay `tool_executing` after the `tool_completed` that
		// superseded it. Letting it through would spin a finished card forever, because
		// nothing completes it a second time.
		const store = createStreamingToolStore();
		applyStreamingToolStarted(store, { toolUseId: "t1", toolName: "Bash" });
		applyStreamingToolCompleted(store, { toolUseId: "t1", status: "success" });
		applyStreamingToolExecuting(store, { toolUseId: "t1" });
		expect(streamingToolChunks(store)[0]?._status).toBe("success");
		// A late `tool_started` must not reopen it either.
		applyStreamingToolStarted(store, { toolUseId: "t1", toolName: "Bash" });
		expect(streamingToolChunks(store)[0]?._status).toBe("success");
	});

	it("creates the entry when executing arrives for an unknown tool", () => {
		// Deliberately unlike `applyStreamingToolOutput`, which ignores unknown ids:
		// out-of-order delivery makes this the FIRST frame for a tool, so discarding it
		// would lose the only fact it carries.
		const store = createStreamingToolStore();
		expect(applyStreamingToolExecuting(store, { toolUseId: "t-new" })).toBe(true);
		const [chunk] = streamingToolChunks(store);
		expect(chunk?._status).toBe("running");
		// A tool that is executing has necessarily finished parsing its input, so the card
		// must render as a real card rather than an argument-progress placeholder.
		expect(chunk?._started).toBe(true);
	});

	it("rejects an executing event with no tool id", () => {
		const store = createStreamingToolStore();
		expect(applyStreamingToolExecuting(store, { toolUseId: "" })).toBe(false);
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

describe("streaming field source ranges", () => {
	it("keeps proven field origins and epochs through matching, replacement and full input", () => {
		const store = createStreamingToolStore();
		applyStreamingToolChunk(store, {
			toolUseId: "edit",
			toolName: "Edit",
			inputCharsTotal: 30,
			streamingField: { name: "old_string", delta: "keep\n", startsField: true },
		});
		const oldEpoch = store.get("edit")?.streamingFieldRanges?.old_string.epoch;
		applyStreamingToolChunk(store, {
			toolUseId: "edit",
			toolName: "Edit",
			inputCharsTotal: 60,
			extractedFields: { old_string: "keep\ndrop" },
			metadata: { startLine: 445 },
			streamingField: { name: "new_string", delta: "keep\n", startsField: true },
		});
		const entry = store.get("edit");
		expect(entry?.streamingFieldRanges?.old_string).toMatchObject({
			epoch: oldEpoch,
			originKnown: true,
			complete: true,
		});
		expect(entry?.streamingFieldRanges?.new_string).toMatchObject({
			originKnown: true,
			complete: false,
			streaming: true,
			startOffset: 0,
		});
		const newEpoch = entry?.streamingFieldRanges?.new_string.epoch;
		applyStreamingToolChunk(store, {
			toolUseId: "edit",
			toolName: "Edit",
			inputCharsTotal: 65,
			streamingField: { name: "new_string", delta: "add" },
		});
		applyStreamingToolStarted(store, {
			toolUseId: "edit",
			toolName: "Edit",
			input: { old_string: "keep\ndrop", new_string: "keep\nadded" },
		});
		expect(store.get("edit")?.streamingFieldRanges?.new_string).toMatchObject({
			epoch: newEpoch,
			originKnown: true,
			complete: true,
			startOffset: 0,
		});
		expect(store.get("edit")?.streamingFieldRanges?.new_string.streaming).toBeUndefined();
	});

	it("does not infer a field origin from an unmarked first delta", () => {
		const store = createStreamingToolStore();
		applyStreamingToolChunk(store, {
			toolUseId: "edit",
			toolName: "Edit",
			inputCharsTotal: 800,
			streamingField: { name: "new_string", delta: "tail" },
		});
		expect(store.get("edit")?.streamingFieldRanges?.new_string.originKnown).toBe(false);
		applyStreamingToolChunk(store, {
			toolUseId: "edit",
			toolName: "Edit",
			inputCharsTotal: 900,
			streamingField: { name: "new_string", delta: "replacement", startsField: true },
		});
		expect(store.get("edit")?.streamingFieldValue).toBe("replacement");
		expect(store.get("edit")?.streamingFieldRanges?.new_string.originKnown).toBe(true);
	});

	it("keeps one epoch and normalized coordinates while a live field crosses 16k and CRLF chunks", () => {
		const store = createStreamingToolStore();
		let inputCharsTotal = 0;
		let received = "";
		let epoch: string | undefined;
		for (const delta of ["a".repeat(15_999), "\r", "\nline", "\r\nmore\n"]) {
			received += delta;
			inputCharsTotal += delta.length;
			applyStreamingToolChunk(store, {
				toolUseId: "edit",
				toolName: "Edit",
				inputCharsTotal,
				streamingField: { name: "new_string", delta },
			});
			const entry = store.get("edit");
			const range = entry?.streamingFieldRanges?.new_string;
			const tail = normalizeSourceText(entry?.streamingFieldValue ?? "");
			const normalized = normalizeSourceText(received);
			epoch ??= range?.epoch;
			expect(range?.epoch).toBe(epoch);
			expect(range?.endOffset).toBe(normalized.length);
			expect(range?.startOffset).toBe(normalized.length - tail.length);
			expect((entry?.streamingFieldValue ?? "").length).toBeLessThanOrEqual(16_000);
		}
		expect(store.get("edit")?.streamingFieldRanges?.new_string.startColumn).toBeGreaterThan(0);
	});

	it("preserves finished fields AND ranges when switching old→new and when metadata arrives", () => {
		const store = createStreamingToolStore();
		applyStreamingToolChunk(store, {
			toolUseId: "edit",
			toolName: "Edit",
			inputCharsTotal: 12,
			streamingField: { name: "old_string", delta: "old\ntext" },
		});
		applyStreamingToolChunk(store, {
			toolUseId: "edit",
			toolName: "Edit",
			inputCharsTotal: 20,
			streamingField: { name: "new_string", delta: "" },
		});
		const oldRange = store.get("edit")?.streamingFieldRanges?.old_string;
		applyStreamingToolChunk(store, {
			toolUseId: "edit",
			toolName: "Edit",
			inputCharsTotal: 22,
			metadata: { filePath: "a.ts" },
		});
		const entry = store.get("edit");
		if (!entry) throw new Error("missing chunk");
		expect(entry.extractedFields?.old_string).toBe("old\ntext");
		expect(entry.streamingFieldRanges?.old_string).toEqual(oldRange);
		expect(entry.streamingFieldRanges?.new_string).toBeDefined();
		const fields = topLevelStreamingChunkToToolFields(entry);
		expect(fields.inputJson).toMatchObject({
			_streamingFieldValue: "",
			_streamingFieldRanges: entry.streamingFieldRanges,
			_streamingFields: { old_string: "old\ntext" },
		});
	});

	it("marks reconnect snapshots with an unknown origin without discarding their retained text", () => {
		const store = createStreamingToolStore();
		store.set("edit", {
			toolUseId: "edit",
			toolName: "Edit",
			inputCharsTotal: 500,
			streamingFieldName: "new_string",
			streamingFieldValue: "observed\r",
		});
		applyStreamingToolChunk(store, {
			toolUseId: "edit",
			toolName: "Edit",
			inputCharsTotal: 505,
			streamingField: { name: "new_string", delta: "\ntail" },
		});
		const entry = store.get("edit");
		expect(entry?.streamingFieldValue).toBe("observed\r\ntail");
		expect(entry?.streamingFieldRanges?.new_string).toMatchObject({
			originKnown: false,
			startOffset: 0,
			endOffset: 13,
			endLine: 1,
			endColumn: 4,
		});
	});

	it("does not repeat a final delta that accompanies an authoritative completed field", () => {
		const store = createStreamingToolStore();
		applyStreamingToolChunk(store, {
			toolUseId: "edit",
			toolName: "Edit",
			inputCharsTotal: 4,
			streamingField: { name: "old_string", delta: "a" },
		});
		applyStreamingToolChunk(store, {
			toolUseId: "edit",
			toolName: "Edit",
			inputCharsTotal: 8,
			extractedFields: { old_string: "abc" },
			streamingField: { name: "old_string", delta: "bc" },
		});
		expect(store.get("edit")?.streamingFieldValue).toBe("abc");
		expect(store.get("edit")?.streamingFieldRanges?.old_string).toMatchObject({
			originKnown: true,
			complete: true,
			endOffset: 3,
		});
	});

	it("retains verified remaps through started/completed and both synthetic tool representations", () => {
		const store = createStreamingToolStore();
		applyStreamingToolChunk(store, {
			toolUseId: "edit",
			toolName: "Edit",
			inputCharsTotal: 20,
			extractedFields: { old_string: "old" },
			streamingField: { name: "new_string", delta: "tail\nlast" },
		});
		const streamed = store.get("edit");
		const first = createDiffDocument({
			oldText: "old",
			newText: streamed?.streamingFieldValue ?? "",
			newRange: streamed?.streamingFieldRanges?.new_string,
			focusSide: "new",
		});
		const reader = getDiffRowAnchor(first, 1, "new");
		const focus = first.focus;
		if (!reader || !focus) throw new Error("missing anchor");
		applyStreamingToolStarted(store, {
			toolUseId: "edit",
			toolName: "Edit",
			input: { old_string: "old", new_string: "header\ntail\nlast" },
		});
		applyStreamingToolCompleted(store, { toolUseId: "edit", status: "success" });
		const completed = store.get("edit");
		if (!completed) throw new Error("missing completed chunk");
		const doc = createDiffDocument({
			oldText: "old",
			newText: "header\ntail\nlast",
			newRange: completed.streamingFieldRanges?.new_string,
		});
		expect(resolveDiffSourcePoint(doc, reader)).toMatchObject({ lost: false, point: { line: 1 } });
		expect(resolveDiffSourcePoint(doc, focus)).toMatchObject({ lost: false, point: { line: 2 } });
		const fields = topLevelStreamingChunkToToolFields(completed);
		expect(fields.inputJson).toMatchObject({
			_streamingFieldRanges: completed.streamingFieldRanges,
		});
		const synthetic = buildTopLevelStreamingChunksMsg([completed], "n", "2026-09-07T00:00:00Z");
		expect(synthetic?.toolCalls?.[0]?.inputJson).toEqual(fields.inputJson);
		expect(synthetic ? resolveAllToolCallsFromMsg(synthetic)[0]?.inputJson : undefined).toEqual(
			fields.inputJson,
		);
	});

	it("promotes a 16k completed extracted field to its verified complete coordinates", () => {
		const full = `prefix\n${"row\r\n".repeat(4_000)}`;
		const store = createStreamingToolStore();
		applyStreamingToolChunk(store, {
			toolUseId: "edit",
			toolName: "Edit",
			inputCharsTotal: full.length,
			extractedFields: { old_string: full },
			streamingField: { name: "new_string", delta: "" },
		});
		const streamed = store.get("edit");
		const oldRange = streamed?.streamingFieldRanges?.old_string;
		expect(streamed?.extractedFields?.old_string.length).toBeLessThanOrEqual(16_000);
		expect(oldRange?.startOffset).toBeGreaterThan(0);
		applyStreamingToolStarted(store, {
			toolUseId: "edit",
			toolName: "Edit",
			input: { old_string: full, new_string: "" },
		});
		expect(store.get("edit")?.streamingFieldRanges?.old_string).toMatchObject({
			epoch: oldRange?.epoch,
			originKnown: true,
			complete: true,
			startOffset: 0,
		});
		expect(store.get("edit")?.streamingFieldRanges?.new_string).toMatchObject({
			originKnown: true,
			complete: true,
			startOffset: 0,
			endOffset: 0,
		});
	});

	it("uses a new epoch for discontinuous snapshots and never jumps a reader to focus", () => {
		const store = createStreamingToolStore();
		applyStreamingToolChunk(store, {
			toolUseId: "edit",
			toolName: "Edit",
			inputCharsTotal: 50,
			streamingField: { name: "new_string", delta: "same\ntail" },
		});
		const previous = store.get("edit");
		const doc = createDiffDocument({
			oldText: "",
			newText: "same\ntail",
			newRange: previous?.streamingFieldRanges?.new_string,
		});
		applyStreamingToolChunk(store, {
			toolUseId: "edit",
			toolName: "Edit",
			inputCharsTotal: 8,
			streamingField: { name: "new_string", delta: "same\nother\nlatest" },
		});
		const next = store.get("edit");
		expect(next?.streamingFieldRanges?.new_string.epoch).not.toBe(
			previous?.streamingFieldRanges?.new_string.epoch,
		);
		const replacement = createDiffDocument({
			oldText: "",
			newText: next?.streamingFieldValue ?? "",
			newRange: next?.streamingFieldRanges?.new_string,
			focusSide: "new",
		});
		const paused = projectDiffDocument(replacement, { anchor: doc.focus });
		expect(paused).toMatchObject({
			anchorLost: true,
			anchorLossReason: "epoch",
			anchor: { line: 0 },
		});
		expect(replacement.focus?.line).toBe(2);
	});
});
