import { describe, expect, test } from "bun:test";
import type { ToolEditPreview } from "@shared/tool-edit-preview";
import { buildToolEditDiff, toolEditSelection } from "./tool-edit-diff";
import { isToolEditReference, toolEditReferenceKey } from "./tool-edit-reference";

const preview: ToolEditPreview = {
	toolCallId: "pk",
	toolUseId: "sdk",
	filePath: "/work/a.ts",
	deviceId: "RemoteCase",
	before: { status: "available", content: "one\nold\nlast\n" },
	after: { status: "available", content: "one\nnew\nlast\n" },
	source: "evidence",
};

describe("historical Edit diff", () => {
	test("opens around the first actual change with real line numbers after a long prefix", () => {
		const prefix = "unchanged\n".repeat(20_000);
		const diff = buildToolEditDiff(`${prefix}old\nend\n`, `${prefix}new\nend\n`);
		expect(diff.firstChange).toEqual({ oldLine: 20_001, newLine: 20_001 });
		expect(diff.lines).toHaveLength(6);
		expect(diff.lines[0]?.oldLineNo).toBe(19_998);
		expect(diff.lines.find((row) => row.type === "removed")).toMatchObject({
			content: "old",
			oldLineNo: 20_001,
		});
		expect(diff.lines.find((row) => row.type === "added")).toMatchObject({
			content: "new",
			newLineNo: 20_001,
		});
		expect(diff.hunks[0]?.range).toBe("-19998,5 +19998,5");
		expect(diff.truncated).toBe(false);
	});

	test("keeps all replacement sites as separate exact hunks", () => {
		const middle = "unchanged\n".repeat(30);
		const diff = buildToolEditDiff(`old\n${middle}old\n`, `new\n${middle}new\n`);
		expect(diff.hunks).toHaveLength(2);
		expect(diff.lines.filter((row) => row.type === "removed").map((row) => row.oldLineNo)).toEqual([
			1, 32,
		]);
		expect(diff.lines.filter((row) => row.type === "added").map((row) => row.newLineNo)).toEqual([
			1, 32,
		]);
		expect(diff.lines.filter((row) => row.type === "context")).toHaveLength(6);
	});

	test("empty/new files, deletions, CRLF, unchanged files and missing final newlines", () => {
		expect(buildToolEditDiff("", "created\n").hunks[0]?.range).toBe("-0,0 +1,1");
		expect(buildToolEditDiff("removed\n", "").hunks[0]?.range).toBe("-1,1 +0,0");
		expect(buildToolEditDiff("", "created\n").lines).toEqual([
			{ type: "added", content: "created", newLineNo: 1 },
		]);
		expect(buildToolEditDiff("removed\n", "").lines).toEqual([
			{ type: "removed", content: "removed", oldLineNo: 1 },
		]);
		expect(buildToolEditDiff("a\r\nold", "a\r\nnew").firstChange).toEqual({
			oldLine: 2,
			newLine: 2,
		});
		expect(buildToolEditDiff("same\n", "same\n").lines).toEqual([]);
		expect(buildToolEditDiff("", "").hunks).toEqual([]);
	});

	test("old/new jump ranges retain the recorded difference in length", () => {
		const data = { ...preview, location: { startLine: 2, endLine: 3, newEndLine: 5 } };
		expect(toolEditSelection(data, "old", null)).toEqual({
			startLineNumber: 2,
			startColumn: 1,
			endLineNumber: 4,
			endColumn: 1,
		});
		expect(toolEditSelection(data, "new", null)?.endLineNumber).toBe(6);
		const diff = buildToolEditDiff("one\nold\nlast", "one\nnew\nlast");
		expect(toolEditSelection(preview, "new", diff)?.startLineNumber).toBe(2);
		expect(toolEditSelection(preview, "old", null)).toBeUndefined();
	});

	test("oversized source and painted rows are explicitly bounded", () => {
		expect(buildToolEditDiff("x".repeat(2 * 1024 * 1024 + 1), "").unavailable).toBe(true);
		const diff = buildToolEditDiff("", "new\n".repeat(5_001));
		expect(diff.lines.length).toBeLessThanOrEqual(5_000);
		expect(diff.truncated || diff.unavailable).toBe(true);
		expect(buildToolEditDiff("", "x".repeat(8_000)).truncated).toBe(true);
	});
});

describe("historical resource identity", () => {
	test("separates repeated SDK ids and preserves authoritative message/attempt refs", () => {
		const ref = { narratorId: "n", toolUseId: "same", toolCallId: "one", executionAttempt: 1 };
		expect(isToolEditReference(ref)).toBe(true);
		expect(toolEditReferenceKey(ref)).not.toBe(toolEditReferenceKey({ ...ref, toolCallId: "two" }));
		expect(toolEditReferenceKey(ref)).not.toBe(
			toolEditReferenceKey({ ...ref, executionAttempt: 2 }),
		);
		expect(toolEditReferenceKey(ref)).not.toBe(
			toolEditReferenceKey({ ...ref, narratorId: "other" }),
		);
		expect(isToolEditReference({ ...ref, executionAttempt: -1 })).toBe(false);
		expect(isToolEditReference({ ...ref, narratorId: "" })).toBe(false);
		expect(isToolEditReference({ ...ref, toolUseId: "x".repeat(513) })).toBe(false);
	});
});
