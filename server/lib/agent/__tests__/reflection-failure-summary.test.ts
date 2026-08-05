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
	test("leads with the gate name and carries the concrete cause", () => {
		const message = buildReflectionFallbackMessage(
			"Danger reflection",
			"provider error: 520 upstream unavailable",
		);
		expect(message).toBe(
			"Danger reflection could not decide: provider error: 520 upstream unavailable",
		);
	});

	test("falls back to the historical wording when no cause is known", () => {
		const message = buildReflectionFallbackMessage("taskReflection", undefined);
		expect(message).toContain("taskReflection");
		expect(message).toContain("did not reach a decision");
	});
});
