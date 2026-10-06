/**
 * vlist-spec-tasks-pin.test.ts — locks the vlist-local "latest tasks.json call"
 * identification to the chunked path's rule (`tool-display.isSpecTasksToolUse` +
 * `narrator-message-helpers.findLatestSpecTasksToolUseId`): the pin and the
 * task-board spinner must always name the SAME card.
 */

import { describe, expect, test } from "bun:test";
import { findLatestSpecTasksToolUseId } from "../narrator-message-helpers";
import type { NarratorMsg } from "../narrator-panel-types";
import {
	findLatestSpecTasksToolUseIdInMessages,
	isSpecTasksToolCall,
	type SpecTasksMessageLike,
} from "./vlist-spec-tasks-pin";

describe("isSpecTasksToolCall", () => {
	test("matches Read/Write/Edit on spec://tasks.json", () => {
		for (const name of ["Read", "Write", "Edit"]) {
			expect(isSpecTasksToolCall(name, { file_path: "spec://tasks.json" })).toBe(true);
		}
	});

	test("rejects other paths and other tools", () => {
		expect(isSpecTasksToolCall("Write", { file_path: "spec://index.md" })).toBe(false);
		expect(isSpecTasksToolCall("Bash", { file_path: "spec://tasks.json" })).toBe(false);
		expect(isSpecTasksToolCall("Write", {})).toBe(false);
		expect(isSpecTasksToolCall("Write", undefined)).toBe(false);
		expect(isSpecTasksToolCall(undefined, { file_path: "spec://tasks.json" })).toBe(false);
	});

	test("reads the streaming path field, so a still-typing call pins identically", () => {
		expect(isSpecTasksToolCall("Write", { _streamingFilePath: "spec://tasks.json" })).toBe(true);
	});
});

describe("findLatestSpecTasksToolUseIdInMessages", () => {
	function msg(
		id: string,
		tool: { id: string; name: string; input: unknown } | null,
	): SpecTasksMessageLike {
		return {
			contentJson: tool
				? [{ type: "tool_use", id: tool.id, name: tool.name, input: tool.input }]
				: [],
			toolCalls: tool ? [{ toolUseId: tool.id, toolName: tool.name, inputJson: tool.input }] : [],
		};
	}

	test("returns null when nothing touched tasks.json", () => {
		expect(findLatestSpecTasksToolUseIdInMessages([])).toBeNull();
		expect(
			findLatestSpecTasksToolUseIdInMessages([
				msg("m1", { id: "t1", name: "Read", input: { file_path: "a.ts" } }),
			]),
		).toBeNull();
	});

	test("the LAST tasks op wins, across blocks and toolCalls", () => {
		const messages = [
			msg("m1", { id: "t1", name: "Write", input: { file_path: "spec://tasks.json" } }),
			msg("m2", { id: "t2", name: "Read", input: { file_path: "other.ts" } }),
			msg("m3", { id: "t3", name: "Edit", input: { file_path: "spec://tasks.json" } }),
		];
		expect(findLatestSpecTasksToolUseIdInMessages(messages)).toBe("t3");
	});

	test("agrees with the chunked-path helper on the same tree", () => {
		const messages = [
			msg("m1", { id: "t1", name: "Write", input: { file_path: "spec://tasks.json" } }),
			msg("m2", { id: "t2", name: "Read", input: { file_path: "other.ts" } }),
		];
		const local = findLatestSpecTasksToolUseIdInMessages(messages);
		const shared = findLatestSpecTasksToolUseId(messages as unknown as NarratorMsg[]);
		expect(local).toBe(shared);
		expect(local).toBe("t1");
	});
});
