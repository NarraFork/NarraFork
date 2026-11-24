import { describe, expect, test } from "bun:test";
import type {
	WorktreeRemovalPlan,
	WorktreeRemovalRequest,
	WorktreeRemovalResult,
} from "@shared/narrator-worktrees";
import { removalBlockers, WorktreeRemovalFlow } from "./worktree-removal-flow";

const result = (outcome: WorktreeRemovalResult["outcome"]): WorktreeRemovalResult => ({
	outcome,
	worktree: null,
	effects: {
		relocated: 0,
		archivedSubagents: 0,
		cancelledTasks: 0,
		closedBrowsers: 0,
		closedTerminals: 0,
		prunedRegistrations: 0,
		removedTreeSnapshots: 0,
	},
	relocatedTo: null,
});

const plan = (patch: Partial<WorktreeRemovalPlan> = {}): WorktreeRemovalPlan => ({
	status: "ready",
	expectedRevision: 7,
	worktree: {
		path: "/repo/.worktrees/feature",
		branch: "refs/heads/feature",
		head: null,
		detached: false,
		locked: false,
		prunable: false,
		mode: "remove",
		pruneSiblings: 0,
		present: true,
		registered: true,
		registrationId: "registration",
		state: "ready",
		dirty: false,
		dirtyFileCount: 0,
		dirtyExact: true,
		unreachableCommits: 0,
	},
	dependents: [],
	inventory: {
		backgroundTasks: 0,
		browserSessions: 0,
		terminals: 0,
		containers: 0,
		volumeSnapshots: 0,
		treeSnapshots: 0,
	},
	blockers: [],
	confirmations: [],
	relocateTo: "/repo",
	...patch,
});

interface Harness {
	flow: WorktreeRemovalFlow;
	states: () => number;
	removals: () => WorktreeRemovalRequest[];
	archived: () => string[];
}

function harness(options: {
	plans: WorktreeRemovalPlan[];
	failRemoval?: unknown;
	planFromError?: (error: unknown) => WorktreeRemovalPlan | undefined;
	archiveError?: unknown;
}): Harness {
	const states: unknown[] = [];
	const removals: WorktreeRemovalRequest[] = [];
	const archived: string[] = [];
	let index = 0;
	const flow = new WorktreeRemovalFlow(
		{
			plan: async () => {
				const next = options.plans[Math.min(index, options.plans.length - 1)];
				index += 1;
				if (!next) throw new Error("no plan");
				return next;
			},
			remove: async (input) => {
				removals.push(input);
				if (options.failRemoval) throw options.failRemoval;
				return result("removed");
			},
			archive: async (id) => {
				if (options.archiveError) throw options.archiveError;
				archived.push(id);
			},
			...(options.planFromError ? { planFromError: options.planFromError } : {}),
		},
		(state) => states.push(state),
		() => ({ workspaceKey: "workspace", path: "/repo/.worktrees/feature" }),
	);
	return {
		flow,
		states: () => states.length,
		removals: () => removals,
		archived: () => archived,
	};
}

describe("worktree removal flow", () => {
	test("submits only after every confirmation the plan asks for", async () => {
		const dirty = plan({ confirmations: ["force"] });
		dirty.worktree = {
			...dirty.worktree,
			head: "a".repeat(40),
			dirty: true,
			dirtyFileCount: 2,
			unreachableCommits: 1,
		};
		const { flow, removals } = harness({ plans: [dirty] });
		await flow.load();
		expect(flow.canSubmit).toBe(false);
		expect(flow.outstanding).toEqual(["force"]);
		flow.toggle("force", true);
		expect(flow.canSubmit).toBe(true);
		await flow.submit();
		expect(removals()).toEqual([
			{
				expectedRevision: 7,
				force: true,
				// The confirmation carries exactly the loss the plan showed.
				confirmedLoss: { head: "a".repeat(40), dirtyFileCount: 2, unreachableCommits: 1 },
				path: plan().worktree.path,
				workspaceKey: "workspace",
				acknowledgeUnregistered: undefined,
			},
		]);
		expect(flow.state.step).toBe("done");
	});

	test("ignores a confirmation the plan did not ask for", async () => {
		const { flow } = harness({ plans: [plan()] });
		await flow.load();
		flow.toggle("force", true);
		expect(flow.state.confirmed).toEqual([]);
		expect(flow.canSubmit).toBe(true);
	});

	test("never submits a blocked plan, even with confirmations", async () => {
		const { flow, removals } = harness({
			plans: [
				plan({
					status: "blocked",
					blockers: [
						{
							code: "WORKTREE_REMOVAL_DEPENDENT_NOT_ARCHIVED",
							params: { count: 1 },
							dependents: [
								{ id: "other", title: "Other", status: "idle", kind: "primary", running: false },
							],
						},
					],
					confirmations: ["force"],
				}),
			],
		});
		await flow.load();
		flow.toggle("force", true);
		expect(flow.canSubmit).toBe(false);
		expect(flow.blockingDependents.map((dependent) => dependent.id)).toEqual(["other"]);
		await flow.submit();
		expect(removals()).toEqual([]);
		expect(removalBlockers(flow.state.plan)[0]?.code).toBe(
			"WORKTREE_REMOVAL_DEPENDENT_NOT_ARCHIVED",
		);
	});

	test("archiving a blocker re-reads the plan and drops the stale confirmation", async () => {
		const { flow, archived } = harness({
			plans: [plan({ confirmations: ["force"] }), plan({ confirmations: [] })],
		});
		await flow.load();
		flow.toggle("force", true);
		await flow.archiveDependent("other");
		expect(archived()).toEqual(["other"]);
		expect(flow.state.confirmed).toEqual([]);
		expect(flow.state.plan?.confirmations).toEqual([]);
	});

	test("a refused removal adopts the plan the server sent", async () => {
		const fresh = plan({
			status: "blocked",
			blockers: [{ code: "WORKTREE_REMOVAL_BUSY" }],
		});
		const { flow } = harness({
			plans: [plan()],
			failRemoval: new Error("Worktree removal is blocked"),
			planFromError: () => fresh,
		});
		await flow.load();
		const submitted = await flow.submit();
		expect(submitted).toBeUndefined();
		expect(flow.state.plan).toBe(fresh);
		expect(flow.state.error).toBe("Worktree removal is blocked");
		expect(flow.state.busy).toBe(false);
	});

	test("an archive failure keeps the plan and reports the reason", async () => {
		const { flow } = harness({ plans: [plan()], archiveError: new Error("denied") });
		await flow.load();
		await flow.archiveDependent("other");
		expect(flow.state.error).toBe("denied");
		expect(flow.state.plan?.status).toBe("ready");
	});
});
