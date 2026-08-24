/**
 * Step-completion detection.
 *
 * The failure this file exists to catch is "a step can never be completed", which
 * in the running app looks like a user staring at a step list that refuses to
 * advance — with no error anywhere. The opposite (a step satisfied before the user
 * did anything) is just as silent and skips the lesson's point entirely, so both
 * directions are asserted for every kind.
 */

import { describe, expect, test } from "bun:test";
import type { TutorialCompletion, TutorialStep } from "@shared/tutorial/lessons";
import {
	activeStepId,
	isCompletionSatisfied,
	isLessonComplete,
	satisfiedStepIds,
	type TutorialObservations,
} from "./tutorial-completion";

const NARRATOR = "narrator-1";

function observations(overrides: Partial<TutorialObservations> = {}): TutorialObservations {
	return { narratorId: NARRATOR, frames: [], ...overrides };
}

function step(id: string, completion: TutorialCompletion): TutorialStep {
	return { id, instruction: id, completion };
}

describe("userSentMessage", () => {
	const completion: TutorialCompletion = { kind: "userSentMessage" };

	test("unsatisfied before the user sends anything", () => {
		expect(isCompletionSatisfied(completion, observations())).toBe(false);
	});

	test("satisfied once a message was sent", () => {
		expect(isCompletionSatisfied(completion, observations({ userSentMessage: true }))).toBe(true);
	});
});

describe("narratorIdle", () => {
	const completion: TutorialCompletion = { kind: "narratorIdle" };

	test("a freshly created idle narrator does NOT satisfy it", () => {
		// A new narrator is idle before it has done anything. Accepting that would
		// complete "wait for the turn to finish" instantly and skip the lesson.
		expect(isCompletionSatisfied(completion, observations({ narratorStatus: "idle" }))).toBe(false);
	});

	test("still unsatisfied while the narrator is working", () => {
		expect(
			isCompletionSatisfied(
				completion,
				observations({ userSentMessage: true, narratorStatus: "working" }),
			),
		).toBe(false);
	});

	test("satisfied when it returns to idle after a user message", () => {
		expect(
			isCompletionSatisfied(
				completion,
				observations({ userSentMessage: true, narratorStatus: "idle" }),
			),
		).toBe(true);
	});
});

describe("permissionResolved", () => {
	test("unsatisfied with no permission frame", () => {
		expect(isCompletionSatisfied({ kind: "permissionResolved" }, observations())).toBe(false);
	});

	test("either decision satisfies an unpinned step", () => {
		// Denying is a legitimate thing to learn; requiring "allow" would trap a user
		// who denied on purpose.
		for (const decision of ["allow", "deny"] as const) {
			expect(
				isCompletionSatisfied(
					{ kind: "permissionResolved" },
					observations({
						frames: [{ type: "permission_resolved", narratorId: NARRATOR, decision }],
					}),
				),
			).toBe(true);
		}
	});

	test("a pinned decision rejects the other one", () => {
		expect(
			isCompletionSatisfied(
				{ kind: "permissionResolved", decision: "deny" },
				observations({
					frames: [{ type: "permission_resolved", narratorId: NARRATOR, decision: "allow" }],
				}),
			),
		).toBe(false);
	});

	test("a frame for another narrator is ignored", () => {
		expect(
			isCompletionSatisfied(
				{ kind: "permissionResolved" },
				observations({
					frames: [{ type: "permission_resolved", narratorId: "someone-else", decision: "allow" }],
				}),
			),
		).toBe(false);
	});
});

describe("toolCompleted", () => {
	const completion: TutorialCompletion = { kind: "toolCompleted", toolName: "Read" };

	test("unsatisfied for a different tool", () => {
		expect(
			isCompletionSatisfied(
				completion,
				observations({
					frames: [
						{ type: "tool_completed", narratorId: NARRATOR, toolName: "Bash", status: "success" },
					],
				}),
			),
		).toBe(false);
	});

	test("satisfied for the named tool", () => {
		expect(
			isCompletionSatisfied(
				completion,
				observations({
					frames: [
						{ type: "tool_completed", narratorId: NARRATOR, toolName: "Read", status: "success" },
					],
				}),
			),
		).toBe(true);
	});

	test("a failed call still counts", () => {
		// The card's lifecycle is what the lesson teaches. Gating on success would
		// strand a user on an environment-specific failure they cannot fix from here.
		expect(
			isCompletionSatisfied(
				completion,
				observations({
					frames: [
						{ type: "tool_completed", narratorId: NARRATOR, toolName: "Read", status: "fail" },
					],
				}),
			),
		).toBe(true);
	});

	test("a frame with no terminal status does not count", () => {
		expect(
			isCompletionSatisfied(
				completion,
				observations({
					frames: [{ type: "tool_completed", narratorId: NARRATOR, toolName: "Read" }],
				}),
			),
		).toBe(false);
	});
});

describe("subagentSpawned", () => {
	const completion: TutorialCompletion = { kind: "subagentSpawned" };

	test("unsatisfied without a subagent frame", () => {
		expect(
			isCompletionSatisfied(
				completion,
				observations({
					frames: [
						{ type: "tool_completed", narratorId: NARRATOR, toolName: "Read", status: "success" },
					],
				}),
			),
		).toBe(false);
	});

	test("satisfied by a parent-side frame carrying subagentNarratorId", () => {
		// Judged on the PARENT's stream: the child has its own narrator id, so a
		// same-narrator filter would discard exactly the evidence needed.
		expect(
			isCompletionSatisfied(
				completion,
				observations({
					frames: [
						{
							type: "tool_completed",
							narratorId: NARRATOR,
							toolName: "Agent",
							status: "success",
							subagentNarratorId: "child-1",
						},
					],
				}),
			),
		).toBe(true);
	});

	test("another narrator's subagent does not count", () => {
		expect(
			isCompletionSatisfied(
				completion,
				observations({
					frames: [{ type: "tool_completed", narratorId: "other", subagentNarratorId: "child-1" }],
				}),
			),
		).toBe(false);
	});
});

describe("chapter and spec conditions", () => {
	test("chapterForked reads the edge kinds", () => {
		expect(isCompletionSatisfied({ kind: "chapterForked" }, observations())).toBe(false);
		expect(
			isCompletionSatisfied(
				{ kind: "chapterForked" },
				observations({ chapterEdgeKinds: ["fork"] }),
			),
		).toBe(true);
	});

	test("a merge edge does not satisfy the fork step", () => {
		expect(
			isCompletionSatisfied(
				{ kind: "chapterForked" },
				observations({ chapterEdgeKinds: ["merge"] }),
			),
		).toBe(false);
	});

	test("chapterMerged reads the edge kinds", () => {
		expect(
			isCompletionSatisfied(
				{ kind: "chapterMerged" },
				observations({ chapterEdgeKinds: ["fork", "merge"] }),
			),
		).toBe(true);
	});

	test("specTaskWritten needs at least one task", () => {
		expect(
			isCompletionSatisfied({ kind: "specTaskWritten" }, observations({ specTaskCount: 0 })),
		).toBe(false);
		expect(
			isCompletionSatisfied({ kind: "specTaskWritten" }, observations({ specTaskCount: 1 })),
		).toBe(true);
	});
});

describe("manual", () => {
	test("never auto-satisfies", () => {
		// Advanced by the user clicking through. If it auto-satisfied, a "read this"
		// step would vanish before it was read.
		expect(
			isCompletionSatisfied(
				{ kind: "manual" },
				observations({ userSentMessage: true, narratorStatus: "idle", specTaskCount: 5 }),
			),
		).toBe(false);
	});
});

describe("step sequencing", () => {
	const steps: TutorialStep[] = [
		step("send", { kind: "userSentMessage" }),
		step("read", { kind: "toolCompleted", toolName: "Read" }),
		step("idle", { kind: "narratorIdle" }),
	];

	test("satisfiedStepIds reports only what actually happened", () => {
		expect(satisfiedStepIds(steps, observations({ userSentMessage: true }))).toEqual(["send"]);
	});

	test("the active step is the first gap, not the furthest reached", () => {
		// Steps are ordered instructions. Jumping past an incomplete one would show
		// the user instructions for work they never did.
		const obs = observations({ userSentMessage: true, narratorStatus: "idle" });
		expect(activeStepId(steps, [], obs)).toBe("read");
	});

	test("recorded steps are skipped even if no longer observable", () => {
		// Progress is persisted; a page reload loses the frame history, so a recorded
		// step must not become active again.
		expect(activeStepId(steps, ["send", "read"], observations())).toBe("idle");
	});

	test("null once every step is done or satisfied", () => {
		expect(activeStepId(steps, ["send", "read", "idle"], observations())).toBeNull();
	});

	test("isLessonComplete requires every step", () => {
		expect(isLessonComplete(steps, ["send", "read"])).toBe(false);
		expect(isLessonComplete(steps, ["send", "read", "idle"])).toBe(true);
	});

	test("an empty lesson is never complete", () => {
		// Guards against a data bug (a lesson with no steps) rendering as finished.
		expect(isLessonComplete([], [])).toBe(false);
	});
});
