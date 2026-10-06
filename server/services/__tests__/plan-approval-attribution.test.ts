/**
 * plan-approval-attribution.test.ts — the "plan approved, begin execution" turn must
 * name whoever actually approved the plan.
 *
 * The turn is persisted as `role: "user"`, so the bubble it paints claims authorship.
 * Four producers reach it and they used to collapse into two: with no `createdBy` the
 * header said "you" and the bubble painted on the reader's side, which told a reader
 * they had approved a plan the reflection auto-approved on their behalf.
 *
 * The precedence is the load-bearing part, and specifically that a recorded human
 * approver OUTRANKS the reflection marker: the marker can outlive a failed approval
 * (the loop clears it on error, but a leak must not be able to relabel a person's
 * decision as the machine's), while an approver id is only ever written by a real UI
 * decision.
 */

import { describe, expect, test } from "bun:test";
import { parseOriginLabel } from "@shared/message-origin";
import { resolvePlanApprovalAttribution } from "../plan-approval-attribution";

/** The origin source a resolved attribution carries, or null for a bare origin. */
function sourceOf(result: ReturnType<typeof resolvePlanApprovalAttribution>): string | null {
	return parseOriginLabel(result.originOptions.originLabel)?.source ?? null;
}

describe("resolvePlanApprovalAttribution", () => {
	test("chained feedback is authored by whoever typed it", () => {
		const result = resolvePlanApprovalAttribution({
			hasFeedback: true,
			feedbackUserId: "u-typist",
			approverId: "u-other",
			approverSource: "reflection",
		});
		expect(result.createdBy).toBe("u-typist");
		expect(result.originOptions.origin).toBe("user");
		// Somebody wrote this text; no source label is needed to explain it.
		expect(sourceOf(result)).toBeNull();
	});

	test("feedback with no recorded userId is still a human turn (no label)", () => {
		// Legacy rows can carry feedback text without an id. It was still typed by a
		// person, so it must not fall through to the auto-continuation card.
		const result = resolvePlanApprovalAttribution({ hasFeedback: true, feedbackUserId: null });
		expect(result.createdBy).toBeUndefined();
		expect(result.originOptions.origin).toBe("user");
		expect(sourceOf(result)).toBeNull();
	});

	test("a human approver is attributed to their account", () => {
		const result = resolvePlanApprovalAttribution({
			hasFeedback: false,
			approverId: "u-approver",
			approverSource: "user",
		});
		expect(result.createdBy).toBe("u-approver");
		expect(result.originOptions.origin).toBe("user");
		expect(sourceOf(result)).toBeNull();
	});

	test("a human approver OUTRANKS a leaked reflection marker", () => {
		// The regression this guards: a `reflection` marker surviving a failed approval
		// must not relabel the next real person's decision as the machine's.
		const result = resolvePlanApprovalAttribution({
			hasFeedback: false,
			approverId: "u-approver",
			approverSource: "reflection",
		});
		expect(result.createdBy).toBe("u-approver");
		expect(sourceOf(result)).toBeNull();
	});

	test("the plan reflection gets its own identity, authored by no account", () => {
		const result = resolvePlanApprovalAttribution({
			hasFeedback: false,
			approverSource: "reflection",
		});
		// `origin: "user"` keeps it a bubble (the model must read it as an instruction);
		// the label is what moves it to the left with the "计划反思" name.
		expect(result.originOptions.origin).toBe("user");
		expect(sourceOf(result)).toBe("planReflection");
		expect(result.createdBy).toBeUndefined();
	});

	test("neither approver nor source falls back to the auto-continuation card", () => {
		const result = resolvePlanApprovalAttribution({ hasFeedback: false });
		expect(result.originOptions.origin).toBe("system");
		expect(sourceOf(result)).toBe("autoContinuation");
		expect(result.createdBy).toBeUndefined();
	});
});
