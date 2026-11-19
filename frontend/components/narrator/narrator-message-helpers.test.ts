import { describe, expect, test } from "bun:test";
import { messageBody, rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { createSourceText } from "@shared/pretext-layout/source-text";
import {
	buildTopLevelStreamingChunksMsg,
	findLatestSpecTasksToolUseId,
	foldStreamingToolFields,
	normalizeReflectionAfterToolStatus,
	resolveAllToolCallsFromMsg,
	type TopLevelStreamingChunk,
	topLevelStreamingChunkToToolFields,
} from "./narrator-message-helpers";
import type { NarratorMsg } from "./narrator-panel-types";

/** A row; a body in `overrides` is split again as this row's, as the server would. */
function msg(overrides: Partial<NarratorMsg> = {}): NarratorMsg {
	const { blocks, ...rest } = overrides;
	return rowWithElements(
		{
			id: "m1",
			narratorId: "n1",
			parentToolUseId: null,
			role: "assistant",
			contentText: null,
			toolCalls: [],
			createdAt: "2026-01-01T00:00:00.000Z",
			...rest,
		},
		messageBody({ blocks }),
	) as NarratorMsg;
}

describe("decoded streaming prompt lengths", () => {
	function feed(
		previous: TopLevelStreamingChunk | undefined,
		inputCharsTotal: number,
		streamingField: { name: string; delta: string; startsField?: boolean; offset?: number },
		toolUseId = "agent",
	): TopLevelStreamingChunk {
		return {
			...previous,
			toolUseId,
			toolName: "Agent",
			inputCharsTotal,
			...foldStreamingToolFields(previous, { toolUseId, inputCharsTotal, streamingField }),
		};
	}

	test("keeps raw decoded length beyond the bounded tail and across description generation", () => {
		let chunk = feed(undefined, 20050, {
			name: "prompt",
			delta: "x".repeat(20000),
			offset: 0,
			startsField: true,
		});
		expect(chunk.streamingFieldValue?.length).toBe(16000);
		expect(chunk.streamingPromptChars).toBe(20000);
		const preview = chunk.streamingFieldValue;
		chunk = feed(chunk, 20051, { name: "prompt", delta: "x", offset: 20000 });
		expect(chunk.streamingFieldValue).toBe(preview);
		expect(chunk.streamingPromptChars).toBe(20001);
		chunk = feed(chunk, 22000, {
			name: "description",
			delta: "description".repeat(100),
			offset: 0,
			startsField: true,
		});
		expect(chunk.streamingPromptChars).toBe(20001);
		expect(chunk.extractedFields?.prompt?.length).toBe(16000);
		const input = topLevelStreamingChunkToToolFields(chunk).inputJson as Record<string, unknown>;
		expect(input._streamingPromptChars).toBe(20001);
		const synthetic = buildTopLevelStreamingChunksMsg([chunk], "n", null);
		expect(synthetic?.toolCalls?.[0]?.inputJson).toEqual(input);
	});

	test("counts original CRLF units and split CR/LF deltas, not normalized range offsets", () => {
		const body = "x\r\n".repeat(7000);
		let chunk = feed(undefined, body.length + 50, {
			name: "prompt",
			delta: body,
			offset: 0,
			startsField: true,
		});
		expect(chunk.streamingPromptChars).toBe(21000);
		expect(chunk.streamingFieldRanges?.prompt.endOffset).toBe(14000);
		chunk = feed(chunk, body.length + 51, { name: "prompt", delta: "\r", offset: 21000 });
		chunk = feed(chunk, body.length + 52, { name: "prompt", delta: "\n", offset: 21001 });
		expect(chunk.streamingPromptChars).toBe(21002);
		expect(chunk.streamingFieldRanges?.prompt.endOffset).toBe(14001);
	});

	test("uses raw offsets after a reconnect gap and suppresses unknown or malformed tails", () => {
		const unknown = feed(undefined, 50000, { name: "prompt", delta: "tail" });
		expect(unknown.streamingPromptChars).toBeNull();
		const restored = feed(unknown, 50005, { name: "prompt", delta: "next", offset: 24000 });
		expect(restored.streamingPromptChars).toBe(24004);
		for (const offset of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
			expect(
				feed(undefined, 100, { name: "prompt", delta: "x", offset, startsField: true })
					.streamingPromptChars,
			).toBeNull();
		}
	});

	test("does not replay an old offset or borrow a different tool's prior prompt length", () => {
		const first = feed(undefined, 20050, {
			name: "prompt",
			delta: "x".repeat(20000),
			offset: 0,
			startsField: true,
		});
		const old = feed(first, 20050, { name: "prompt", delta: "old", offset: 20 });
		expect(old.streamingPromptChars).toBe(20000);
		expect(old.streamingFieldValue).toBe(first.streamingFieldValue);
		const other = feed(first, 20055, { name: "prompt", delta: "tail" }, "other-agent");
		expect(other.streamingPromptChars).toBeNull();
	});

	test("supports older offset-less servers only after an explicit uninterrupted field start", () => {
		let chunk = feed(undefined, 20050, {
			name: "prompt",
			delta: "x".repeat(20000),
			startsField: true,
		});
		chunk = feed(chunk, 20051, { name: "prompt", delta: "x" });
		expect(chunk.streamingPromptChars).toBe(20001);
		chunk = feed(chunk, 20051, { name: "prompt", delta: "x" });
		expect(chunk.streamingPromptChars).toBe(20001);
	});
});

describe("streaming source-range projection", () => {
	test("preserves empty active fields and range metadata in both synthetic representations", () => {
		const range = createSourceText("", { epoch: "edit:new", originKnown: false }).range;
		const chunk: TopLevelStreamingChunk = {
			toolUseId: "edit",
			toolName: "Edit",
			inputCharsTotal: 5,
			streamingFieldName: "new_string",
			streamingFieldValue: "",
			streamingFieldRanges: { new_string: range },
		};
		const input = topLevelStreamingChunkToToolFields(chunk).inputJson;
		expect(input).toMatchObject({
			_streamingFieldValue: "",
			_streamingFieldRanges: { new_string: range },
		});
		const synthetic = buildTopLevelStreamingChunksMsg([chunk], "n", "2026-09-07T00:00:00Z");
		expect(synthetic?.toolCalls?.[0]?.inputJson).toEqual(input);
		expect(synthetic ? resolveAllToolCallsFromMsg(synthetic)[0]?.inputJson : undefined).toEqual(
			input,
		);
	});

	test("retains ranges after completed input stops using streaming content markers", () => {
		const range = createSourceText("", { epoch: "edit:new", complete: true }).range;
		const chunk: TopLevelStreamingChunk = {
			toolUseId: "edit",
			toolName: "Edit",
			inputCharsTotal: 5,
			_started: true,
			_status: "success",
			_input: { old_string: "old", new_string: "" },
			streamingFieldName: "new_string",
			streamingFieldValue: "stale preview",
			streamingFieldRanges: { new_string: range },
		};
		const input = topLevelStreamingChunkToToolFields(chunk).inputJson as Record<string, unknown>;
		expect(input).toMatchObject({
			old_string: "old",
			new_string: "",
			_streamingFieldRanges: { new_string: range },
		});
		expect(Object.hasOwn(input, "_streamingFieldValue")).toBe(false);
		expect(chunk._input).toEqual({ old_string: "old", new_string: "" });
	});
});

describe("normalizeReflectionAfterToolStatus", () => {
	const runningReflection = {
		kind: "danger_reflection" as const,
		status: "running" as const,
		requestId: "danger-1",
		reason: "Checking a dangerous command",
	};

	test("keeps an approved reflection active while the tool is running", () => {
		expect(normalizeReflectionAfterToolStatus(runningReflection, "running", false)).toBe(
			runningReflection,
		);
	});

	test("only infers aborted when the tool reaches a failed terminal state", () => {
		expect(normalizeReflectionAfterToolStatus(runningReflection, "fail", false)).toMatchObject({
			status: "aborted",
			requestId: "danger-1",
		});
	});

	test("does not infer aborted while a permission is still pending", () => {
		expect(normalizeReflectionAfterToolStatus(runningReflection, "fail", true)).toBe(
			runningReflection,
		);
	});

	// A gate whose reflection write was lost (busy SQLite inside a catch that swallows) while
	// the tool went on to succeed leaves a row that is terminal but still says "running". The
	// card then renders "危险反思正在检查此操作" with a live timer counting from the tool's
	// start, which is why old rows showed absurd durations. A succeeded tool means the gate
	// let it through, so converge on confirmed.
	test("converges a stale running reflection once the tool succeeded", () => {
		expect(normalizeReflectionAfterToolStatus(runningReflection, "success", false)).toMatchObject({
			status: "confirmed",
			requestId: "danger-1",
		});
	});

	test("leaves a resolved reflection untouched", () => {
		const failed = { ...runningReflection, status: "failed" as const };
		expect(normalizeReflectionAfterToolStatus(failed, "success", false)).toBe(failed);
	});
});

describe("findLatestSpecTasksToolUseId", () => {
	const tasksBlock = (id: string) => ({
		type: "tool_use" as const,
		id,
		name: "Write",
		input: { file_path: "spec://tasks.json", content: "{}" },
	});

	test("returns the last spec tasks tool-use id from contentJson", () => {
		const messages = [
			msg(rowWithElements({ id: "m1" }, [tasksBlock("t1")] as never)),
			msg(rowWithElements({ id: "m2" }, [tasksBlock("t2")] as never)),
		];
		expect(findLatestSpecTasksToolUseId(messages)).toBe("t2");
	});

	test("ignores non-tasks file operations", () => {
		const messages = [
			msg(
				rowWithElements({}, [
					{
						type: "tool_use",
						id: "other",
						name: "Write",
						input: { file_path: "src/index.ts", content: "x" },
					},
				] as never),
			),
		];
		expect(findLatestSpecTasksToolUseId(messages)).toBeNull();
	});

	test("reads spec tasks ops from toolCalls records too", () => {
		const messages = [
			msg({
				toolCalls: [
					{
						toolUseId: "tc-tasks",
						toolName: "Read",
						inputJson: { file_path: "spec://tasks.json" },
					},
				] as never,
			}),
		];
		expect(findLatestSpecTasksToolUseId(messages)).toBe("tc-tasks");
	});

	test("returns null when there are no spec tasks ops", () => {
		expect(findLatestSpecTasksToolUseId([msg(), msg()])).toBeNull();
		expect(findLatestSpecTasksToolUseId([])).toBeNull();
	});
});
