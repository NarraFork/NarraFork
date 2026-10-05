/**
 * reflection-failure-summary.test.ts — a failed reflection gate must NAME its cause.
 *
 * Every gate used to collapse every non-decision into one fixed sentence ("did not call
 * DangerConfirm or DangerCancel in its single allowed response"). That sentence is a claim
 * about the MODEL's behaviour, so it actively misled whenever the real cause was elsewhere:
 * a provider 520, an exhausted retry chain, a malformed stream, or a crash all read as "the
 * model ignored its instructions". `observed.errors` held the truth but only reached the log.
 *
 * These tests pin the mapping from observation to user-facing reason, and the retry
 * accounting that makes "we tried" visible.
 */

import { describe, expect, test } from "bun:test";
import {
	buildExitPlanReflectionDeniedToolResult,
	buildReflectionFallbackMessage,
	type ReflectionLoopObservation,
	summarizeReflectionFailure,
} from "../loop";

function observation(
	overrides: Partial<ReflectionLoopObservation> = {},
): ReflectionLoopObservation {
	return {
		assistantMessages: 1,
		assistantText: "",
		assistantTextPreview: "",
		toolCalls: [],
		toolResults: [],
		errors: [],
		invalidStates: [],
		retries: 0,
		...overrides,
	};
}

describe("summarizeReflectionFailure", () => {
	test("a successful decision has no failure at all", () => {
		expect(
			summarizeReflectionFailure(
				observation({
					toolCalls: ["DangerConfirm"],
					toolResults: [{ toolName: "DangerConfirm", isError: false, outputPreview: "ok" }],
				}),
			),
		).toBeUndefined();
	});

	test("a provider error is reported verbatim rather than blamed on the model", () => {
		const summary = summarizeReflectionFailure(
			observation({ errors: ["OpenAI API error 520: upstream unavailable"] }),
		);
		expect(summary).toContain("provider error");
		expect(summary).toContain("520");
	});

	test("retry count is folded into a provider error so effort is visible", () => {
		const summary = summarizeReflectionFailure(
			observation({ errors: ["rate limited"], retries: 3 }),
		);
		expect(summary).toContain("after 3 retries");
		expect(summary).toContain("rate limited");
	});

	test("a single retry reads as singular", () => {
		const summary = summarizeReflectionFailure(observation({ errors: ["boom"], retries: 1 }));
		expect(summary).toContain("after 1 retry");
		expect(summary).not.toContain("1 retries");
	});

	test("an HTML error page is flattened and clipped instead of flooding the card", () => {
		const html = `<!DOCTYPE html><html><head><title>520</title></head><body>${"x".repeat(4000)}</body></html>`;
		const summary = summarizeReflectionFailure(observation({ errors: [html] }));
		expect(summary).not.toContain("<");
		expect(summary?.length).toBeLessThan(400);
		expect(summary?.endsWith("…")).toBe(true);
	});

	test("an invalid provider response is named as a protocol fault", () => {
		const summary = summarizeReflectionFailure(
			observation({ invalidStates: ["missing_tool_use: stream ended mid tool call"] }),
		);
		expect(summary).toContain("invalid provider response");
		expect(summary).toContain("missing_tool_use");
	});

	test("an errored decision tool names the tool and its output", () => {
		const summary = summarizeReflectionFailure(
			observation({
				toolCalls: ["DangerCancel"],
				toolResults: [
					{ toolName: "DangerCancel", isError: true, outputPreview: "already resolved" },
				],
			}),
		);
		expect(summary).toContain("DangerCancel");
		expect(summary).toContain("already resolved");
	});

	test("retries with no decision and no error still explain themselves", () => {
		const summary = summarizeReflectionFailure(
			observation({ retries: 2, lastRetryMessage: "stream stale" }),
		);
		expect(summary).toContain("no decision after 2 retries");
		expect(summary).toContain("stream stale");
	});

	test("an empty response is distinguished from a talkative one", () => {
		expect(summarizeReflectionFailure(observation({ assistantMessages: 0 }))).toContain(
			"empty response",
		);
		expect(summarizeReflectionFailure(observation({ assistantMessages: 1 }))).toContain(
			"without calling a decision tool",
		);
	});

	test("a crash is reported as a crash even with no observed events", () => {
		const summary = summarizeReflectionFailure(observation({ assistantMessages: 0 }), {
			threw: true,
		});
		expect(summary).toContain("crashed");
	});

	test("hard errors outrank a crash flag, because they are more specific", () => {
		const summary = summarizeReflectionFailure(observation({ errors: ["connection reset"] }), {
			threw: true,
		});
		expect(summary).toContain("connection reset");
	});
});

describe("buildReflectionFallbackMessage", () => {
	test("names a provider failure and gives actionable main-session guidance", () => {
		const message = buildReflectionFallbackMessage(
			"Danger reflection",
			"provider error: 520 upstream unavailable",
		);
		expect(message).toContain("Operation safety check could not complete");
		expect(message).toContain("model service request failed");
		expect(message).toContain("not authorized to execute");
		expect(message).toContain("request human handling");
	});

	test("unknown cause explains the decision ceiling and preserves task state", () => {
		const message = buildReflectionFallbackMessage("taskReflection", undefined);
		expect(message).toContain("at most two responses");
		expect(message).toContain("original task status is preserved");
	});

	for (const locale of ["en", "zh-CN"] as const) {
		test(`internal correction instructions never leak to the main session (${locale})`, () => {
			const message = buildReflectionFallbackMessage(
				"ExitPlanMode reflection",
				"the Edit tool call was rejected: Tool Edit has no durable execution receipt; call ExitPlanRevise",
				locale,
			);
			expect(message).not.toContain("ExitPlanRevise");
			expect(message).not.toContain("durable execution receipt");
			expect(message).toContain("ExitPlanMode");
			expect(message).toContain(locale === "zh-CN" ? "计划尚未提交" : "plan was not submitted");
			expect(message).toContain(
				locale === "zh-CN" ? "不代表计划内容被否决" : "not a rejection of the plan's content",
			);
		});
	}
});

describe("plan check failure is not a plan revision decision", () => {
	for (const locale of ["en", "zh-CN"] as const) {
		test(`a failed check preserves main-session retry guidance (${locale})`, () => {
			const feedback = buildReflectionFallbackMessage(
				"ExitPlanMode reflection",
				"the Edit tool call was rejected",
				locale,
			);
			const result = buildExitPlanReflectionDeniedToolResult(
				{ action: "revise", feedback },
				locale,
				true,
			);
			expect(result.isError).toBe(true);
			expect(result.output).toBe(feedback);
			expect(result.output).not.toContain("ExitPlanRevise");
			expect(result.output).not.toContain(
				locale === "zh-CN" ? "请先修改计划" : "Revise the plan first",
			);
		});
		test(`a substantive revision still carries concrete content feedback (${locale})`, () => {
			const result = buildExitPlanReflectionDeniedToolResult(
				{ action: "revise", feedback: "Add a cancellation test" },
				locale,
			);
			expect(result.output).toContain("Add a cancellation test");
			expect(result.output).toContain(
				locale === "zh-CN" ? "请先修改计划" : "Revise the plan first",
			);
		});
	}
});
