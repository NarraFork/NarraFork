import { describe, expect, test } from "bun:test";
import { classifyReflectionReasonSummary } from "./reflection-reason";

describe("classifyReflectionReasonSummary", () => {
	test("omits empty input", () => {
		expect(classifyReflectionReasonSummary(undefined)).toBeNull();
		expect(classifyReflectionReasonSummary(null)).toBeNull();
		expect(classifyReflectionReasonSummary("   ")).toBeNull();
	});

	test("omits status restatements that only echo the localized title", () => {
		expect(classifyReflectionReasonSummary("Plan reflection is checking this plan")).toEqual({
			kind: "omit",
		});
		expect(classifyReflectionReasonSummary("Task reflection aborted")).toEqual({ kind: "omit" });
		expect(classifyReflectionReasonSummary("Danger reflection aborted")).toEqual({
			kind: "omit",
		});
		expect(
			classifyReflectionReasonSummary("Plan reflection stopped; awaiting user decision"),
		).toEqual({ kind: "omit" });
	});

	test("maps distinct system facts to label keys", () => {
		expect(classifyReflectionReasonSummary("Narrator aborted")).toEqual({
			kind: "label",
			key: "reflectionReasonNarratorAborted",
		});
		expect(classifyReflectionReasonSummary("Danger reflection pause cancelled by user")).toEqual({
			kind: "label",
			key: "reflectionReasonDangerCancelledByUser",
		});
	});

	test("passes custom content through unchanged", () => {
		expect(classifyReflectionReasonSummary("Provider unavailable before a decision")).toEqual({
			kind: "content",
			text: "Provider unavailable before a decision",
		});
	});

	test("re-labels danger assessment summaries instead of leaving English chrome", () => {
		expect(
			classifyReflectionReasonSummary("Git reset may rewrite the current worktree/index state."),
		).toEqual({
			kind: "label",
			key: "dangerCopy_gitResetSummary",
		});
		expect(classifyReflectionReasonSummary("rm deletes files recursively.")).toEqual({
			kind: "label",
			key: "dangerCopy_deleteFilesRecursiveSummary",
			params: { name: "rm" },
		});
		expect(
			classifyReflectionReasonSummary("Danger reflection: Shell command safety analysis failed."),
		).toEqual({
			kind: "label",
			key: "dangerCopy_shellAnalysisFailedSummary",
		});
	});

	test("strips the Danger reflection: chrome prefix and keeps the summary", () => {
		expect(classifyReflectionReasonSummary("Danger reflection: deletes the database")).toEqual({
			kind: "content",
			text: "deletes the database",
		});
		expect(classifyReflectionReasonSummary("Danger reflection:")).toEqual({ kind: "omit" });
	});

	test("splits the statusReason next-steps concatenation", () => {
		expect(
			classifyReflectionReasonSummary("Fix the schema first.\n\nNext steps: rerun migrate"),
		).toEqual({
			kind: "content",
			text: "Fix the schema first.",
			nextSteps: "rerun migrate",
		});
	});

	test("keeps next-steps when the reason head is only chrome", () => {
		expect(
			classifyReflectionReasonSummary("Task reflection aborted\n\nNext steps: ask the user"),
		).toEqual({
			kind: "content",
			text: "",
			nextSteps: "ask the user",
		});
		expect(
			classifyReflectionReasonSummary("Narrator aborted\n\nNext steps: inspect the tree"),
		).toEqual({
			kind: "label",
			key: "reflectionReasonNarratorAborted",
			nextSteps: "inspect the tree",
		});
	});
});
