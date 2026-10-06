import { describe, expect, mock, test } from "bun:test";
import type {
	WorktreeCreateRequest,
	WorktreeCreateResult,
	WorktreePrepareRequest,
} from "@shared/narrator-worktrees";
import type { WorkspaceContext } from "@shared/workspace-context";
import {
	type WorktreeDraft,
	WorktreeFlow,
	type WorktreeFlowPorts,
	type WorktreeStep,
} from "./worktree-flow";

const context: WorkspaceContext = {
	revision: 7,
	deviceId: "local",
	cwd: "/repo",
	pathFlavor: "posix",
	contextKey: "old",
	git: { workspaceKey: "wk", repositoryKey: "rk", rootPath: "/repo" },
	capabilities: { switchDirectory: true },
};
const draft: WorktreeDraft = {
	name: "",
	requirement: "",
	branchOverride: "",
	destinationPath: "",
	baseRef: "",
};
const created: WorktreeCreateResult = {
	outcome: "created",
	worktree: {
		path: "/worktrees/fix",
		branch: "fix",
		head: "head",
		detached: false,
		locked: false,
		prunable: false,
	},
	residuals: { destinationExists: true, branchExists: true },
};
function setup(overrides: Partial<WorktreeFlowPorts> = {}) {
	const calls: string[] = [];
	const prepare = mock(async (input: WorktreePrepareRequest) => {
		calls.push("prepare");
		return {
			branchName: input.branchName ?? "fix",
			worktreeName: "fix",
			destinationPath: input.destinationPath ?? "/worktrees/fix",
		};
	});
	const create = mock(async (_input: WorktreeCreateRequest) => {
		calls.push("create");
		return created;
	});
	const switchPath = mock(async () => {
		calls.push("switch");
	});
	const reconcile = mock(async (_input: WorktreeCreateRequest) => created);
	let idCounter = 0;
	const requestId = mock(() => `request-${++idCounter}`);
	const steps: WorktreeStep[] = [];
	const flow = new WorktreeFlow(
		{ prepare, create, reconcile, switch: switchPath, requestId, ...overrides },
		(state) => steps.push(state.step),
	);
	return { flow, prepare, create, reconcile, switchPath, calls, steps };
}
describe("quick worktree flow", () => {
	test.each([
		"branch",
		"destination",
	])("advanced %s override is validated before unused default collisions", async (kind) => {
		const prepare = mock(async (input: WorktreePrepareRequest) => {
			if (kind === "branch" && !input.branchName) throw new Error("default fix branch exists");
			if (kind === "destination" && !input.destinationPath)
				throw new Error("default destination exists");
			return {
				branchName: input.branchName ?? "fix",
				worktreeName: "fix",
				destinationPath: input.destinationPath ?? "/worktrees/fix-2",
			};
		});
		const s = setup({ prepare });
		await s.flow.submit({ ...draft, name: "fix" }, context);
		expect(s.create).not.toHaveBeenCalled();
		await s.flow.submit(
			{
				...draft,
				name: "fix",
				...(kind === "branch" ? { branchOverride: "fix-2" } : { destinationPath: "/custom/new" }),
			},
			context,
		);
		expect(s.create).toHaveBeenCalledTimes(1);
		expect(s.create.mock.calls[0]?.[0]).toMatchObject(
			kind === "branch" ? { branch: { name: "fix-2" } } : { destinationPath: "/custom/new" },
		);
	});
	test("unknown recovery reads the original frozen request and never regenerates its id", async () => {
		const create = mock(async (_request: WorktreeCreateRequest): Promise<WorktreeCreateResult> => {
			throw new Error("lost response");
		});
		const s = setup({ create });
		await s.flow.submit({ ...draft, requirement: "repair" }, context);
		const original = s.flow.state.createRequest;
		if (!original) throw new Error("Original creation proposal was not retained");
		expect(Object.isFrozen(original)).toBe(true);
		expect(Object.isFrozen(original?.branch)).toBe(true);
		await s.flow.reconcile();
		expect(s.reconcile.mock.calls[0]?.[0]).toEqual(original);
		expect(s.reconcile.mock.calls[0]?.[0].expectedRevision).toBe(7);
		expect(s.flow.state.createdPath).toBe("/worktrees/fix");
		expect(s.switchPath).not.toHaveBeenCalled();
		await s.flow.switchCreated();
		expect(s.flow.state.step).toBe("done");
		expect(create).toHaveBeenCalledTimes(1);
	});
	test.each([
		"unknown",
		"failed",
	] as const)("verified %s permits only the corresponding safe next action", async (outcome) => {
		const create = mock(
			async (_input: WorktreeCreateRequest): Promise<WorktreeCreateResult> => ({
				...created,
				outcome: "unknown",
				worktree: null,
			}),
		);
		const reconcile = mock(
			async (_input: WorktreeCreateRequest): Promise<WorktreeCreateResult> => ({
				...created,
				outcome,
				worktree: null,
			}),
		);
		const s = setup({ create, reconcile });
		await s.flow.submit({ ...draft, name: "fix" }, context);
		await s.flow.reconcile();
		await s.flow.submit({ ...draft, name: "new" }, { ...context, revision: 9 });
		expect(create).toHaveBeenCalledTimes(outcome === "failed" ? 2 : 1);
		expect(reconcile.mock.calls[0]?.[0].expectedRevision).toBe(7);
	});
	test("404 or denied receipt cannot be treated as proof of creation failure", async () => {
		const s = setup({
			create: async () => ({ ...created, outcome: "unknown", worktree: null }),
			reconcile: async () => {
				throw Object.assign(new Error("receipt unavailable"), { status: 404 });
			},
		});
		await s.flow.submit({ ...draft, name: "fix" }, context);
		await s.flow.reconcile();
		expect(s.flow.state.unknown).toBe(true);
		expect(s.flow.state.confirmedFailure).toBe(false);
	});
	test("name only needs no requirement and creates then switches", async () => {
		const s = setup();
		await s.flow.submit({ ...draft, name: "fix" }, context);
		expect(s.prepare.mock.calls[0]?.[0]).toEqual({
			expectedRevision: 7,
			workspaceKey: "wk",
			name: "fix",
		});
		expect(s.calls).toEqual(["prepare", "create", "switch"]);
		expect(s.flow.state.step).toBe("done");
		expect(s.steps).toContain("prepare");
		expect(s.steps).toContain("create");
		expect(s.steps).toContain("switch");
	});
	test("requirement only invokes naming once without confirmation or extra fields", async () => {
		const s = setup();
		await s.flow.submit({ ...draft, requirement: "Repair authentication" }, context);
		expect(s.prepare.mock.calls[0]?.[0]).toEqual({
			expectedRevision: 7,
			workspaceKey: "wk",
			requirement: "Repair authentication",
		});
		expect(s.create.mock.calls[0]?.[0]).toEqual({
			expectedRevision: 7,
			workspaceKey: "wk",
			requestId: "request-1",
			destinationPath: "/worktrees/fix",
			branch: { kind: "new", name: "fix" },
		});
	});
	test("both values are forwarded, with optional advanced overrides", async () => {
		const s = setup();
		await s.flow.submit(
			{
				...draft,
				name: "named",
				requirement: "keep hint",
				branchOverride: "override",
				destinationPath: "/custom/new",
				baseRef: "base",
			},
			context,
		);
		expect(s.prepare.mock.calls[0]?.[0]).toMatchObject({ name: "named", requirement: "keep hint" });
		expect(s.create.mock.calls[0]?.[0]).toMatchObject({
			branch: { kind: "new", name: "override" },
			destinationPath: "/custom/new",
			baseRef: "base",
		});
	});
	test("empty input does not invoke any endpoint", async () => {
		const s = setup();
		await s.flow.submit({ ...draft, name: " " }, context);
		expect(s.flow.state.error).toBe("empty");
		expect(s.calls).toEqual([]);
	});
	test("capability denial does not invoke any endpoint", async () => {
		const s = setup();
		await s.flow.submit(
			{ ...draft, name: "fix" },
			{ ...context, capabilities: { switchDirectory: false, reason: "chapter unsupported" } },
		);
		expect(s.flow.state.error).toBe("chapter unsupported");
		expect(s.calls).toEqual([]);
	});
	test("prepare freezes original draft/revision/workspace even when mutable UI cache changes", async () => {
		let release: (() => void) | undefined;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const input = { ...draft, requirement: "original", baseRef: "main" };
		const mutable = {
			...context,
			git: { ...context.git, workspaceKey: "original-wk", repositoryKey: "rk", rootPath: "/repo" },
		};
		const persisted = mock(async (_request: WorktreeCreateRequest, _draft: WorktreeDraft) => {});
		const s = setup({
			prepare: async () => {
				await waiting;
				return {
					branchName: "model-summary-original",
					destinationPath: "/prepared-original",
					worktreeName: "original",
				};
			},
			persist: persisted,
		});
		const submitting = s.flow.submit(input, mutable);
		input.requirement = "edited";
		input.baseRef = "other";
		mutable.revision = 99;
		mutable.git.workspaceKey = "new-wk";
		release?.();
		await submitting;
		expect(s.create.mock.calls[0]?.[0]).toMatchObject({
			expectedRevision: 7,
			workspaceKey: "original-wk",
			branch: { name: "model-summary-original" },
			baseRef: "main",
			destinationPath: "/prepared-original",
		});
		expect(persisted.mock.calls[0]?.[1].requirement).toBe("original");
	});
	test("double submit while preparing dispatches a single creation", async () => {
		let release: (() => void) | undefined;
		const ready = new Promise<void>((resolve) => {
			release = resolve;
		});
		const prepare = mock(async () => {
			await ready;
			return { branchName: "fix", worktreeName: "fix", destinationPath: "/worktrees/fix" };
		});
		const s = setup({ prepare });
		const first = s.flow.submit({ ...draft, name: "fix" }, context);
		await s.flow.submit({ ...draft, name: "fix" }, context);
		expect(prepare).toHaveBeenCalledTimes(1);
		release?.();
		await first;
		expect(s.create).toHaveBeenCalledTimes(1);
	});
	test.each([
		"invalid name",
		"collision",
		"summary timeout",
	])("prepare failure %s remains retryable, not successful", async (message) => {
		const s = setup({
			prepare: mock(async () => {
				throw new Error(message);
			}),
		});
		await s.flow.submit({ ...draft, requirement: "repair" }, context);
		expect(s.flow.state.error).toBe(message);
		expect(s.flow.state.unknown).toBe(false);
		expect(s.create).not.toHaveBeenCalled();
	});
	test("busy 409 preserves created worktree; retry only switches", async () => {
		const switching = mock(async (): Promise<void> => {
			throw Object.assign(new Error("busy 409"), { status: 409 });
		});
		const s = setup({ switch: switching });
		await s.flow.submit({ ...draft, name: "fix" }, context);
		expect(s.flow.state.createdPath).toBe("/worktrees/fix");
		expect(s.flow.state.step).toBe("switch");
		expect(s.flow.state.error).toBe("busy 409");
		await s.flow.submit({ ...draft, name: "fix" }, context);
		expect(s.create).toHaveBeenCalledTimes(1);
		switching.mockImplementation(async () => {});
		await s.flow.switchCreated();
		expect(switching).toHaveBeenCalledTimes(2);
		expect(s.create).toHaveBeenCalledTimes(1);
		expect(s.flow.state.step).toBe("done");
	});
	test("unknown result blocks blind create retry and never switches", async () => {
		const s = setup({
			create: mock(async () => ({ ...created, outcome: "unknown" as const, worktree: null })),
		});
		await s.flow.submit({ ...draft, name: "fix" }, context);
		await s.flow.submit({ ...draft, name: "fix" }, context);
		expect(s.prepare).toHaveBeenCalledTimes(1);
		expect(s.switchPath).not.toHaveBeenCalled();
		expect(s.flow.state.unknown).toBe(true);
	});
	test("network failure after create dispatch is unknown and never blindly retried", async () => {
		const create = mock(async () => {
			throw new Error("network disconnected");
		});
		const s = setup({ create });
		await s.flow.submit({ ...draft, name: "fix" }, context);
		await s.flow.submit({ ...draft, name: "fix" }, context);
		expect(create).toHaveBeenCalledTimes(1);
		expect(s.flow.state.unknown).toBe(true);
		expect(s.switchPath).not.toHaveBeenCalled();
	});
});
