import { describe, expect, test } from "bun:test";
import { messageBody, rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { createSourceText } from "@shared/pretext-layout/source-text";
import {
	buildTopLevelStreamingChunksMsg,
	findLatestSpecTasksToolUseId,
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
