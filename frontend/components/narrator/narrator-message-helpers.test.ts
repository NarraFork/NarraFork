import { describe, expect, test } from "bun:test";
import {
	findLatestSpecTasksToolUseId,
	normalizeReflectionAfterToolStatus,
	preserveCompleteStreamedOutput,
	preserveLiveSubagentActivity,
} from "./narrator-message-helpers";
import type { NarratorMsg } from "./narrator-panel-types";

function msg(overrides: Partial<NarratorMsg> = {}): NarratorMsg {
	return {
		id: "m1",
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: [],
		contentText: null,
		toolCalls: [],
		children: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	} as NarratorMsg;
}

describe("preserveLiveSubagentActivity", () => {
	test("keeps a known model when a terminal refresh carries an empty activity model", () => {
		const existing = msg({
			contentJson: [
				{
					type: "tool_use",
					id: "parent-tool",
					name: "Agent",
					_subagentActivity: {
						subagentNarratorId: "sub-1",
						model: "known-model",
						latestToolCalls: [],
					},
				},
			],
			toolCalls: [
				{
					toolUseId: "parent-tool",
					toolName: "Agent",
					_subagentActivity: {
						subagentNarratorId: "sub-1",
						model: "known-model",
						latestToolCalls: [],
					},
				},
			],
		});
		const incoming = msg({
			contentJson: [
				{
					type: "tool_use",
					id: "parent-tool",
					name: "Agent",
					_subagentActivity: {
						subagentNarratorId: "sub-1",
						model: "",
						latestToolCalls: [],
					},
				},
			],
			toolCalls: [
				{
					toolUseId: "parent-tool",
					toolName: "Agent",
					_subagentActivity: {
						subagentNarratorId: "sub-1",
						model: null,
						latestToolCalls: [],
					},
				},
			],
		});

		const preserved = preserveLiveSubagentActivity(existing, incoming);

		expect(preserved.contentJson[0]._subagentActivity?.model).toBe("known-model");
		expect(preserved.toolCalls?.[0]._subagentActivity?.model).toBe("known-model");
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
			msg({ id: "m1", contentJson: [tasksBlock("t1")] as never }),
			msg({ id: "m2", contentJson: [tasksBlock("t2")] as never }),
		];
		expect(findLatestSpecTasksToolUseId(messages)).toBe("t2");
	});

	test("ignores non-tasks file operations", () => {
		const messages = [
			msg({
				contentJson: [
					{
						type: "tool_use",
						id: "other",
						name: "Write",
						input: { file_path: "src/index.ts", content: "x" },
					},
				] as never,
			}),
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

/**
 * `preserveCompleteStreamedOutput` is the one truncation consumer that is NOT a
 * display path: it decides whether the complete output the client streamed live
 * should replace the (shorter) preview that arrives with `tool_completed`.
 *
 * It is also the highest-risk site of the field-level truncation change: the
 * wrapper shape did not change, so a stale root-level probe compiles cleanly and
 * fails silently — the full output would be discarded and the card would fall back
 * to the preview with no error anywhere.
 */
describe("preserveCompleteStreamedOutput", () => {
	const full = "line1\nline2\nline3";

	test("restores a bare-string truncated output (behaviour lock)", () => {
		const result = preserveCompleteStreamedOutput(
			{ _truncated: true, preview: "line1", fullLength: full.length },
			full,
		);
		expect(result.preserved).toBe(true);
		expect(result.output).toBe(full);
	});

	test("restores a truncated _text IN PLACE and keeps _metadata", () => {
		const metadata = { action: "search", results: [{ id: "m1" }] };
		const result = preserveCompleteStreamedOutput(
			{
				_text: { _truncated: true, preview: "line1", fullLength: full.length },
				_metadata: metadata,
			},
			full,
		);
		expect(result.preserved).toBe(true);
		// The sibling metadata drives every structured card; flattening to a plain
		// string here would degrade the card to a generic JSON dump.
		expect(result.output).toEqual({ _text: full, _metadata: metadata });
	});

	test("does NOT preserve when the streamed text is shorter than the original", () => {
		const result = preserveCompleteStreamedOutput(
			{ _text: { _truncated: true, preview: "line1", fullLength: 9999 } },
			full,
		);
		expect(result.preserved).toBe(false);
	});

	test("does NOT preserve when the truncated leaf is a field other than _text", () => {
		// `streamedOutput` is the output BODY, so it cannot stand in for some other
		// truncated field.
		const payload = { detail: { _truncated: true, preview: "x", fullLength: 3000 } };
		const result = preserveCompleteStreamedOutput(payload, full);
		expect(result.preserved).toBe(false);
		expect(result.output).toBe(payload);
	});

	test("leaves an untruncated payload and a missing streamed string alone", () => {
		const plain = { _text: "short" };
		expect(preserveCompleteStreamedOutput(plain, full)).toEqual({
			output: plain,
			preserved: false,
		});
		expect(preserveCompleteStreamedOutput(plain, undefined)).toEqual({
			output: plain,
			preserved: false,
		});
	});
});
