/**
 * background-completion-delivery.test.ts — finished background work reaches the
 * conversation exactly once, whichever path delivers it.
 *
 * Before this migration, `bg_agent` had TWO delivery paths reading ONE queue:
 *
 *   busy parent → an `after_tools` side-car attached to another message
 *   idle parent → a real `sys` message row plus a wake-up
 *
 * Both now write a message row through `deliverInjection`; they differ only in
 * `schedule` (`onNextTurn` vs `none`, the latter because the idle caller already holds
 * the continuation lock and starts the loop itself). That makes the delivery uniform,
 * but it also means a double drain would now write the SAME row twice instead of
 * producing one row and one aside. These tests pin the exclusivity that prevents it.
 *
 * The queue is the real module — its get-then-delete drain is the mechanism under test,
 * so stubbing it would test nothing.
 *
 * Since completions and inbound `Send` reports were merged into ONE ordered queue
 * (`parent-injection-queue`), the drain here is the shared one; this file keeps asserting
 * the exclusivity and the result-capping that belong to THIS producer, while cross-kind
 * ordering is covered in `parent-injection-queue.test.ts`.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
	type CompletedBgSubagentNotification,
	formatBackgroundCompletionNotifications,
	pushBgCompletionNotification,
} from "../bg-completion-queue";
import { drainPendingInjections, runItems } from "../parent-injection-queue";

/** Completions for one parent, in queue order. */
function drainCompletions(parentNarratorId: string): CompletedBgSubagentNotification[] {
	return runItems(drainPendingInjections(parentNarratorId), "bg_agent").map((e) => e.task);
}

const PARENT = "bg-delivery-parent";

function notification(
	over: Partial<CompletedBgSubagentNotification> = {},
): CompletedBgSubagentNotification {
	return {
		id: "task-1",
		title: "Map the providers",
		status: "completed",
		resultPreview: "found 7 buildHistory sites",
		result: "found 7 buildHistory sites, listed with line numbers",
		...over,
	};
}

beforeEach(() => {
	// Leave no notification behind for the next test; the queue is module-level state.
	drainPendingInjections(PARENT);
	drainPendingInjections("other-parent");
});

describe("the queue can only be drained once", () => {
	it("hands the notifications to the first caller and nothing to the second", () => {
		// This is what makes busy/idle exclusive: whichever path drains first OWNS the
		// content, so the other cannot deliver it again.
		pushBgCompletionNotification(PARENT, notification());
		expect(drainCompletions(PARENT)).toHaveLength(1);
		expect(drainCompletions(PARENT)).toHaveLength(0);
	});

	it("an empty drain reports nothing, so neither path writes a row", () => {
		// Both call sites treat an empty drain as "produce no injection" — the idle path
		// additionally declines to start a turn.
		expect(drainCompletions(PARENT)).toEqual([]);
	});

	it("keeps notifications for one parent out of another's drain", () => {
		pushBgCompletionNotification(PARENT, notification({ id: "mine" }));
		pushBgCompletionNotification("other-parent", notification({ id: "theirs" }));
		expect(drainCompletions(PARENT).map((t) => t.id)).toEqual(["mine"]);
		expect(drainCompletions("other-parent").map((t) => t.id)).toEqual(["theirs"]);
	});

	it("accumulates several completions into one delivery", () => {
		// Several tasks finishing while the parent works must arrive as ONE row, not one
		// row each — otherwise a fan-out of ten subagents floods the timeline.
		for (const id of ["a", "b", "c"]) pushBgCompletionNotification(PARENT, notification({ id }));
		expect(drainCompletions(PARENT).map((t) => t.id)).toEqual(["a", "b", "c"]);
	});
});

describe("the two paths differ only in how much result they include", () => {
	it("busy: a preview, because the full output is one Await away", () => {
		const text = formatBackgroundCompletionNotifications([notification()], {
			includeResult: false,
		});
		expect(text).toContain("Result preview: found 7 buildHistory sites");
		expect(text).not.toContain("listed with line numbers");
		// The follow-up instruction is present either way; it is how the model gets the
		// rest without another injection.
		expect(text).toContain('Await({ type: "agent", id: "task-1" })');
	});

	it("idle: the full result, because a turn is being started to deal with it", () => {
		const text = formatBackgroundCompletionNotifications([notification()], {
			includeResult: true,
		});
		expect(text).toContain("listed with line numbers");
	});

	it("a truncated result says so, and says how to read the rest", () => {
		const text = formatBackgroundCompletionNotifications(
			[notification({ resultTruncated: true })],
			{ includeResult: true },
		);
		expect(text).toContain("truncated");
		expect(text).toContain('Await({ type: "agent", id: "task-1" })');
	});

	it("an empty result is stated rather than left blank", () => {
		const text = formatBackgroundCompletionNotifications(
			[notification({ result: "", resultPreview: "" })],
			{ includeResult: true },
		);
		expect(text).toContain("(empty)");
	});

	it("caps an oversized result at push time and flags it", () => {
		// The cap lives in the queue, not in either delivery path, so both inherit it.
		pushBgCompletionNotification(PARENT, notification({ result: "x".repeat(20_000) }));
		const [drained] = drainCompletions(PARENT);
		expect(drained.resultTruncated).toBe(true);
		expect((drained.result ?? "").length).toBe(12_000);
	});
});
