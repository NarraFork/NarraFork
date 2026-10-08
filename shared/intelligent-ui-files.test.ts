import { describe, expect, test } from "bun:test";
import {
	INTELLIGENT_UI_ENTRY,
	INTELLIGENT_UI_FILE_LIMITS,
	readIntelligentUiFileReference,
} from "./intelligent-ui-files";

const reference = {
	version: 1 as const,
	toolUseId: "tool-use",
	toolCallId: "tool-call",
	deviceId: "local",
	workspaceKey: "workspace",
	cwd: "/project",
	directory: "/project/.narrafork/intelligent_ui/订单-form-abc",
	entry: INTELLIGENT_UI_ENTRY,
	title: "订单表单",
};

describe("file-backed IntelligentUI metadata", () => {
	test("keeps only the ordinary-file reference, not source or revisions", () => {
		expect(readIntelligentUiFileReference({ ...reference, document: "private", epoch: 3 })).toEqual(
			reference,
		);
	});

	test("rejects legacy document references and malformed values", () => {
		for (const value of [
			null,
			[],
			"ui",
			{ uiId: "old", revision: "old" },
			{ ...reference, version: 2 },
		]) {
			expect(readIntelligentUiFileReference(value)).toBeNull();
		}
		for (const key of Object.keys(reference).filter((key) => key !== "version")) {
			for (const value of [null, undefined, "", "x".repeat(4097)]) {
				expect(readIntelligentUiFileReference({ ...reference, [key]: value })).toBeNull();
			}
		}
	});

	test("limits compile input/output without inventing a history quota", () => {
		expect(INTELLIGENT_UI_FILE_LIMITS.fileBytes).toBe(512 * 1024);
		expect(INTELLIGENT_UI_FILE_LIMITS.sourceBytes).toBe(2 * 1024 * 1024);
		expect(INTELLIGENT_UI_FILE_LIMITS.outputBytes).toBe(4 * 1024 * 1024);
		expect(INTELLIGENT_UI_FILE_LIMITS.files).toBe(128);
		expect(INTELLIGENT_UI_FILE_LIMITS.timeoutMs).toBe(15_000);
		expect("historyRefs" in INTELLIGENT_UI_FILE_LIMITS).toBe(false);
	});
});
