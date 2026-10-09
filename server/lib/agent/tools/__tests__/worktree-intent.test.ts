import { beforeEach, describe, expect, test } from "bun:test";
import type { WorktreeCreateResult, WorktreeListResult } from "@shared/narrator-worktrees";
import { AppError } from "../../../errors";
import {
	type WorktreeCreateRequest,
	worktreeListSchema,
} from "../../../validators/narrator-worktrees";
import { resolveToolJsonSchema } from "../../tool-registry";
import type { ToolContext, ToolDefinition } from "../../types";
import { createAgentWorktreeTools, worktreeTool } from "../worktree";

const created: WorktreeCreateResult = {
	outcome: "created",
	worktree: {
		path: "/repo/.worktrees/fix",
		head: "abc",
		branch: "refs/heads/fix",
		detached: false,
		locked: false,
		prunable: false,
	},
	residuals: { destinationExists: true, branchExists: true },
};
const listed: WorktreeListResult = {
	repositoryKey: "repo",
	entries: created.worktree ? [created.worktree] : [],
	truncated: false,
	capabilities: {
		list: true,
		create: true,
		switch: false,
		delete: false,
		prune: false,
		remote: false,
	},
};
let requests: WorktreeCreateRequest[];
let listInputs: unknown[];
let recoveryIds: string[];
let result: WorktreeCreateResult;
let failure: Error | undefined;
let tools: Map<string, ToolDefinition>;
let ctx: ToolContext;
const intent = { branchName: "fix", destinationPath: "/repo/.worktrees/fix" };

beforeEach(() => {
	requests = [];
	listInputs = [];
	recoveryIds = [];
	result = created;
	failure = undefined;
	ctx = {
		narratorId: "narrator",
		userId: "actor",
		cwd: "/repo",
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" }),
		workspaceContext: {
			revision: 4,
			deviceId: "local",
			cwd: "/repo",
			pathFlavor: "posix",
			contextKey: "context",
			git: { workspaceKey: "workspace", repositoryKey: "repo", rootPath: "/repo" },
			capabilities: { switchDirectory: true },
		},
	};
	tools = new Map(
		createAgentWorktreeTools(
			{
				list: async (_principal, _narrator, input) => {
					listInputs.push(input);
					return listed;
				},
				create: async (_principal, _narrator, input) => {
					requests.push(input as WorktreeCreateRequest);
					if (failure) throw failure;
					return result;
				},
				getOperation: async (_principal, _narrator, id) => {
					recoveryIds.push(id);
					if (failure) throw failure;
					return result;
				},
			},
			async () => "actor",
		).map((tool) => [tool.name, tool]),
	);
});

function toolOf(name: string) {
	const tool = tools.get(name);
	if (!tool) throw new Error(`Missing tool ${name}`);
	return tool;
}
function frozenWorkspace() {
	const workspace = ctx.workspaceContext;
	if (!workspace?.git) throw new Error("Missing fixture workspace");
	return { ...workspace, git: workspace.git };
}
function routingOf(name: string) {
	const routing = toolOf(name).executionRouting;
	if (!routing || routing.kind !== "single") throw new Error("Expected single routing");
	return routing;
}
const execute = async (name: string, input: Record<string, unknown>, context = ctx) => {
	const result = await toolOf(name).execute(input, context);
	return { ...result, data: JSON.parse(result.output) };
};

describe("intent-only worktree tools", () => {
	test("HTTP list query supplies defaults and coerces bounded page sizes", () => {
		expect(worktreeListSchema.parse({ workspaceKey: "workspace" })).toEqual({
			workspaceKey: "workspace",
			limit: 20,
			sort: "lastCommitAt",
			order: "desc",
			search: "",
		});
		expect(worktreeListSchema.parse({ workspaceKey: "workspace", limit: "100" }).limit).toBe(100);
		for (const limit of ["", "0", "101", "2.5", "NaN"]) {
			expect(worktreeListSchema.safeParse({ workspaceKey: "workspace", limit }).success).toBe(
				false,
			);
		}
	});
	test("advertises four flat schemas with honest required fields and bounds", () => {
		expect([...tools.keys()]).toEqual([
			"ListWorktrees",
			"CreateWorktree",
			"AttachWorktree",
			"GetWorktreeOperation",
		]);
		for (const tool of tools.values()) {
			const schema = resolveToolJsonSchema(tool);
			expect(schema.type).toBe("object");
			expect(schema.anyOf).toBeUndefined();
			expect(schema.additionalProperties).toBe(false);
			const props = schema.properties as Record<string, Record<string, unknown>>;
			for (const field of ["workspaceKey", "expectedRevision", "requestId", "action", "branch"])
				expect(props[field]).toBeUndefined();
		}
		const schema = resolveToolJsonSchema(toolOf("CreateWorktree"));
		expect(schema.required).toEqual(["branchName", "destinationPath"]);
		expect(
			(schema.properties as Record<string, Record<string, unknown>>).destinationPath.maxLength,
		).toBe(4096);
		expect(resolveToolJsonSchema(toolOf("AttachWorktree")).required).toEqual([
			"branchName",
			"destinationPath",
		]);
		expect(resolveToolJsonSchema(toolOf("GetWorktreeOperation")).required).toEqual(["operationId"]);
		expect(
			(
				resolveToolJsonSchema(toolOf("GetWorktreeOperation")).properties as Record<
					string,
					Record<string, unknown>
				>
			).operationId.pattern,
		).toBe("^wt1_[a-f0-9]{64}$");
		expect(worktreeTool.isAvailable?.()).toBe(false);
	});

	test("list accepts empty input and the provider compatibility confirm", async () => {
		expect(resolveToolJsonSchema(toolOf("ListWorktrees")).required).toEqual(["confirm"]);
		for (const input of [{}, { confirm: true }]) {
			const output = await execute("ListWorktrees", input);
			expect(output.isError).toBeUndefined();
			expect(output.metadata?.workspaceWorktrees).toBeDefined();
		}
		expect(listInputs).toEqual([{ workspaceKey: "workspace" }, { workspaceKey: "workspace" }]);
		expect(requests).toHaveLength(0);
	});

	test("list forwards bounded pagination/search/sort without compatibility fields", async () => {
		const query = { limit: 30, cursor: "snapshot:20", sort: "name", order: "asc", search: " fix " };
		const output = await execute("ListWorktrees", { ...query, confirm: true });
		expect(output.isError).toBeUndefined();
		expect(listInputs).toEqual([{ ...query, search: "fix", workspaceKey: "workspace" }]);
		for (const invalid of [
			{ limit: 0 },
			{ limit: 101 },
			{ limit: "20" },
			{ sort: "head" },
			{ order: "up" },
			{ cursor: "" },
			{ search: "x".repeat(513) },
		]) {
			expect((await execute("ListWorktrees", invalid)).isError).toBe(true);
		}
		expect(listInputs).toHaveLength(1);
	});

	test("binds frozen host context and supplies HEAD without exposing platform tokens", async () => {
		const output = await execute("CreateWorktree", intent);
		expect(output.isError).toBe(false);
		expect(output.data.operationId).toMatch(/^wt1_[a-f0-9]{64}$/);
		expect(requests[0]).toEqual({
			workspaceKey: "workspace",
			expectedRevision: 4,
			requestId: output.data.operationId,
			destinationPath: intent.destinationPath,
			branch: { kind: "new", name: "fix" },
			baseRef: "HEAD",
		});
		expect(output.data.worktree).toEqual(created.worktree);
	});

	test("attaches existing branch without baseRef or hidden model naming", async () => {
		await execute("AttachWorktree", intent);
		expect(requests[0].branch).toEqual({ kind: "existing", name: "fix" });
		expect(requests[0].baseRef).toBeUndefined();
		expect((await execute("AttachWorktree", { ...intent, baseRef: "HEAD" })).data.error.code).toBe(
			"INVALID_ARGUMENT",
		);
		expect(requests).toHaveLength(1);
	});

	test("operation identity is stable across provider call IDs and explicit default HEAD", async () => {
		const a = await execute("CreateWorktree", intent, { ...ctx, currentToolUseId: "call-a" });
		const b = await execute(
			"CreateWorktree",
			{ ...intent, baseRef: "HEAD" },
			{ ...ctx, currentToolUseId: "call-b" },
		);
		expect(a.data.operationId).toBe(b.data.operationId);
	});

	test("different intent, actor, narrator or frozen workspace produces distinct identities", async () => {
		const ids = new Set<string>();
		ids.add((await execute("CreateWorktree", intent)).data.operationId);
		for (const input of [
			{ ...intent, branchName: "other" },
			{ ...intent, destinationPath: "/repo/other" },
			{ ...intent, baseRef: "main" },
		])
			ids.add((await execute("CreateWorktree", input)).data.operationId);
		ids.add((await execute("AttachWorktree", intent)).data.operationId);
		for (const context of [
			{ ...ctx, userId: "other" },
			{ ...ctx, narratorId: "other" },
			{ ...ctx, workspaceContext: { ...frozenWorkspace(), revision: 5 } },
			{
				...ctx,
				workspaceContext: {
					...frozenWorkspace(),
					git: { ...frozenWorkspace().git, workspaceKey: "other" },
				},
			},
			{
				...ctx,
				workspaceContext: {
					...frozenWorkspace(),
					git: { ...frozenWorkspace().git, repositoryKey: "other" },
				},
			},
		])
			ids.add((await execute("CreateWorktree", intent, context)).data.operationId);
		expect(ids.size).toBe(10);
	});

	test("rejects missing, malformed, extra and wrong-type intent before any service call", async () => {
		for (const input of [
			{},
			{ branchName: "fix" },
			{ ...intent, branchName: 5 },
			{ ...intent, branchName: "" },
			{ ...intent, destinationPath: "a".repeat(4097) },
			{ ...intent, expectedRevision: 4 },
			{ ...intent, branch: { kind: "new" } },
		]) {
			const output = await execute("CreateWorktree", input);
			expect(output.isError).toBe(true);
			expect(output.data.dispatched).toBe(false);
			expect(output.data.error.code).toBe("INVALID_ARGUMENT");
			expect(output.output.length).toBeLessThan(2400);
		}
		expect(requests).toHaveLength(0);
		const tool = toolOf("CreateWorktree");
		const parsed = tool.parameters.safeParse({});
		if (parsed.success) throw new Error("Expected validation failure");
		if (!tool.formatValidationError) throw new Error("Missing validation formatter");
		expect(JSON.parse(tool.formatValidationError(parsed.error)).dispatched).toBe(false);
	});

	test("missing, stale, remote, fractional or string revision fails closed, without coercion", async () => {
		for (const workspaceContext of [
			undefined,
			{ ...frozenWorkspace(), deviceId: "remote" },
			{ ...frozenWorkspace(), revision: 4.5 },
			{ ...frozenWorkspace(), revision: "4" as unknown as number },
			{ ...frozenWorkspace(), git: undefined },
		]) {
			const output = await execute("CreateWorktree", intent, { ...ctx, workspaceContext });
			expect(output.data.error.code).toBe("WORKTREE_CONTEXT_REQUIRED");
			expect(output.data.dispatched).toBe(false);
		}
		const stale = await execute("CreateWorktree", intent, {
			...ctx,
			assertWorkspaceCurrent: () => {
				throw new AppError("stale", 409, "WORKSPACE_CONTEXT_STALE");
			},
		});
		expect(stale.data.error.code).toBe("WORKSPACE_CONTEXT_STALE");
		expect(requests).toHaveLength(0);
	});

	test("remote routed execution and missing host actor cannot fall back to local creation", async () => {
		const remote = await execute("CreateWorktree", intent, {
			...ctx,
			executionTarget: {
				deviceId: "remote",
				backendKind: "remote",
				cwd: "/repo",
				selectionSource: "session_default",
			},
		});
		expect(remote.data.error.code).toBe("WORKTREE_CONTEXT_REQUIRED");
		const anonymous = await execute("CreateWorktree", intent, { ...ctx, userId: undefined });
		expect(anonymous.data.error.code).toBe("WORKTREE_ACTOR_REQUIRED");
		expect(anonymous.data.dispatched).toBe(false);
		expect(requests).toHaveLength(0);
	});
	test("unknown returns its stable operationId and an explicit recovery instruction", async () => {
		result = { ...created, outcome: "unknown", worktree: null };
		const output = await execute("CreateWorktree", intent);
		expect(output.isError).toBe(true);
		expect(output.data.nextAction).toContain("GetWorktreeOperation");
		expect(output.data.dispatched).toBeUndefined();
		const recovery = await execute(
			"GetWorktreeOperation",
			{ operationId: output.data.operationId },
			{ ...ctx, workspaceContext: { ...frozenWorkspace(), revision: 99 } },
		);
		expect(recoveryIds).toEqual([output.data.operationId]);
		expect(requests).toHaveLength(1);
		expect(recovery.data.operationId).toBe(output.data.operationId);
	});

	test("exceptions after entering service never falsely promise no dispatch", async () => {
		failure = new Error("could be after dispatch");
		const output = await execute("CreateWorktree", intent);
		expect(output.data.operationId).toMatch(/^wt1_/);
		expect(output.data.dispatched).toBeUndefined();
		expect(output.data.nextAction).toContain("GetWorktreeOperation");
		failure = new AppError("missing receipt", 404, "WORKTREE_REQUEST_NOT_FOUND");
		const recovery = await execute("GetWorktreeOperation", {
			operationId: output.data.operationId,
		});
		expect(recovery.data.nextAction).toContain("do not infer");
	});

	test("routing marks mutations as writes to the exact advertised destination", () => {
		for (const name of ["CreateWorktree", "AttachWorktree"]) {
			const routing = routingOf(name);
			expect(routing.resolve(intent, {} as never)).toEqual({
				key: "worktree",
				operation: "write",
				path: intent.destinationPath,
			});
		}
		for (const name of ["ListWorktrees", "GetWorktreeOperation"]) {
			const routing = routingOf(name);
			expect(routing.resolve({}, {} as never)).toEqual({ key: "worktree", operation: "read" });
		}
	});
});
