import { describe, expect, test } from "bun:test";
import {
	applyPlanApproval,
	dropDeferredPlanApproval,
	type PlanApprovalState,
	runDeferredPlanApproval,
} from "./plan-approval-restart";

function recorder() {
	const steps: string[] = [];
	return {
		steps,
		restart: (state: PlanApprovalState) => ({
			compact: async () => {
				steps.push(`compact:${state._planApprovedContinue ?? "unmarked"}`);
			},
			abort: () => {
				steps.push(`abort:${state._planApprovedContinue ?? "unmarked"}`);
			},
		}),
	};
}

describe("plan approval restart", () => {
	test("with no open response it compacts, marks and aborts at once", async () => {
		const state: PlanApprovalState = {};
		const { steps, restart } = recorder();

		await applyPlanApproval(state, "compact", restart(state));

		// Marked after the compact and before the abort, as the abort cleanup reads it.
		expect(steps).toEqual(["compact:unmarked", "abort:compact"]);
		expect(state._planApprovalFinish).toBeUndefined();
	});

	test("during an open response it marks at once and restarts only once finalized", async () => {
		const state: PlanApprovalState = { _partialMessageId: "partial" };
		const { steps, restart } = recorder();

		await applyPlanApproval(state, "continue", restart(state));

		// Marked so shouldStop starts nothing after the approval, but the response keeps
		// streaming: nothing compacts or aborts it yet.
		expect(state._planApprovedContinue).toBe("continue");
		expect(steps).toEqual([]);

		state._partialMessageId = undefined;
		await runDeferredPlanApproval(state);
		expect(steps).toEqual(["compact:continue", "abort:continue"]);
		expect(state._planApprovalFinish).toBeUndefined();

		// Finalizing again (a later response) does not restart twice.
		await runDeferredPlanApproval(state);
		expect(steps).toHaveLength(2);
	});

	test("a pass that ends before finalization drops the pending approval", async () => {
		const state: PlanApprovalState = { _partialMessageId: "partial" };
		const { steps, restart } = recorder();
		await applyPlanApproval(state, "compact", restart(state));

		dropDeferredPlanApproval(state);

		expect(state._planApprovedContinue).toBeUndefined();
		expect(state._planApprovalFinish).toBeUndefined();
		await runDeferredPlanApproval(state);
		expect(steps).toEqual([]);
	});

	test("dropping leaves an approval that already restarted the pass intact", async () => {
		const state: PlanApprovalState = {};
		const { restart } = recorder();
		await applyPlanApproval(state, "continue", restart(state));

		dropDeferredPlanApproval(state);

		// The abort it caused is the plan restart the cleanup must recognise.
		expect(state._planApprovedContinue).toBe("continue");
	});
});
