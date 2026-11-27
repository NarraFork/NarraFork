import { describe, expect, spyOn, test } from "bun:test";
import { db } from "@server/db";
import { users } from "@server/db/schema";
import { eq } from "drizzle-orm";
import { scheduledTaskService } from "../../../../services/scheduled-task-service";
import { summarizeSubagentToolCall } from "../../../../services/subagent-activity";
import { ADMIN_ONLY_LOAD_TOOLS } from "../../../../services/tool-load-markers";
import { getBuiltinRoutine, getBuiltinToolNames } from "../../../builtin-routines";
import { toolRegistry } from "../../tool-registry";
import { OPTIONAL_TOOLS } from "../index";
import { scheduledTaskTool } from "../scheduled-task";
import { isScheduledTaskReadAction, SCHEDULED_TASK_ACTIONS } from "../scheduled-task-actions";
import { previewScheduledTask, resolveScheduledTaskApproval } from "../scheduled-task-policy";
import {
	scheduledTaskParametersSchema,
	validateScheduledTaskArguments,
} from "../scheduled-task-schema";
import { caller, dailyTask, taskFor } from "./scheduled-task-fixtures";

describe("ScheduledTask registration", () => {
	test("is optional and off by default", () => {
		const routine = getBuiltinRoutine("scheduled_task");
		expect(routine?.defaultEnabled).toBeUndefined();
		expect(routine?.tool).toBeDefined();
		if (!routine?.tool) throw new Error("scheduled_task routine is missing its tool definition");
		expect(getBuiltinToolNames(routine.tool)).toEqual(["ScheduledTask"]);
		expect(OPTIONAL_TOOLS.has("ScheduledTask")).toBe(true);
	});

	test("removes the redundant admin tool without restricting the unified tool's loading", () => {
		expect(toolRegistry.get("ScheduledTask")).toBe(scheduledTaskTool);
		expect(toolRegistry.get("ScheduledTaskAdmin")).toBeUndefined();
		expect(OPTIONAL_TOOLS.has("ScheduledTaskAdmin")).toBe(false);
		expect(getBuiltinRoutine("scheduled_task_admin")).toBeUndefined();
		expect(ADMIN_ONLY_LOAD_TOOLS.has("ScheduledTaskAdmin")).toBe(false);
		expect(ADMIN_ONLY_LOAD_TOOLS.has("ScheduledTask")).toBe(false);
	});

	/**
	 * The permission layer classifies by action, so a new action reaching the tool
	 * without being classified would be silently gated as mutating. That is the safe
	 * direction, but it should be a deliberate choice rather than an oversight, so the
	 * two lists are pinned together here.
	 */
	test("every action is classified as read or mutating", () => {
		const reads = SCHEDULED_TASK_ACTIONS.filter(isScheduledTaskReadAction);
		expect(reads).toEqual(["list", "targets", "get", "runs", "preview"]);
		const mutating = SCHEDULED_TASK_ACTIONS.filter((a) => !isScheduledTaskReadAction(a));
		expect(mutating).toEqual(["create", "update", "enable", "disable", "delete", "run_now"]);
	});

	test("unknown action strings are not treated as reads", () => {
		for (const value of ["", "LIST", "purge", "run", undefined, null, 1, {}]) {
			expect(isScheduledTaskReadAction(value)).toBe(false);
		}
	});
});

/**
 * These reject before any service call, so they need no database. Each asserts the
 * tool refuses rather than letting the service produce a less specific error.
 */
describe("ScheduledTask argument validation", () => {
	const ctx = {
		narratorId: "n1",
		cwd: "/tmp",
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" as const }),
	};

	async function run(args: Record<string, unknown>) {
		return scheduledTaskTool.execute(args, ctx);
	}

	test("rejects an unknown action without reaching the service", async () => {
		const result = await run({ action: "purge" });
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Invalid ScheduledTask arguments");
	});

	test("rejects retired admin action aliases and flat create fields before IO", async () => {
		for (const action of ["toggle", "run"]) {
			const result = await run({ action, id: "t1", enabled: true });
			expect(result.isError).toBe(true);
			expect(result.output).toContain("Invalid ScheduledTask arguments");
		}
		const result = await run({ action: "create", ...dailyTask });
		expect(result.isError).toBe(true);
		expect(result.output).toContain(
			"create requires task.name, task.prompt, task.schedule or task.cronExpr",
		);
	});

	test("requires an id for id-based actions", async () => {
		for (const action of ["get", "update", "enable", "disable", "delete", "run_now", "runs"]) {
			const result = await run({ action, task: { name: "x" } });
			expect(result.isError).toBe(true);
			expect(result.output).toContain("'id' is required");
		}
	});

	test("create names every missing required field at once", async () => {
		const result = await run({ action: "create", task: { name: "Nightly" } });
		expect(result.isError).toBe(true);
		expect(result.output).toContain("task.cronExpr");
		expect(result.output).toContain("task.prompt");
	});

	test("rejects a syntactically valid cron that never fires", () => {
		// Feb 30th parses but has no next run.
		expect(() => previewScheduledTask({ cronExpr: "0 0 30 2 *", timezone: "UTC" })).toThrow(
			"Invalid cron expression",
		);
	});

	test("rejects an unknown timezone", () => {
		expect(() =>
			previewScheduledTask({ cronExpr: "0 9 * * *", timezone: "Mars/Olympus" }),
		).toThrow();
	});

	test("project runContext requires a writable project", async () => {
		const fixture = await caller();
		const result = await scheduledTaskTool.execute(
			{
				action: "create",
				task: { name: "In project", cronExpr: "0 9 * * *", prompt: "hi", runContext: "project" },
			},
			fixture.ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Project");
	});

	test("the removed chapter runContext is refused", async () => {
		const result = await run({
			action: "create",
			task: {
				name: "In chapter",
				cronExpr: "0 9 * * *",
				prompt: "hi",
				runContext: "chapter",
				projectId: "p1",
			},
		});
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Invalid ScheduledTask arguments");
		expect(result.output).toContain("runContext");
	});

	test("update with no fields is refused instead of writing an empty patch", async () => {
		const result = await run({ action: "update", id: "t1", task: {} });
		expect(result.isError).toBe(true);
		expect(result.output).toContain("at least one field");
	});

	test("run-history limit is capped by the schema", async () => {
		const result = await run({ action: "runs", id: "t1", limit: 5000 });
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Invalid ScheduledTask arguments");
	});

	test("targets accepts bounded search pages without widening run-history limits", () => {
		const parse = (args: Record<string, unknown>) => {
			const parsed = scheduledTaskParametersSchema.parse(args);
			validateScheduledTaskArguments(parsed);
			return parsed;
		};
		expect(
			parse({ action: "targets", q: "x".repeat(200), limit: 100, cursor: "x".repeat(2048) }).limit,
		).toBe(100);
		for (const args of [
			{ action: "targets", q: "x".repeat(201) },
			{ action: "targets", limit: 101 },
			{ action: "targets", cursor: "x".repeat(2049) },
			{ action: "runs", id: "t1", limit: 51 },
			{ action: "runs", id: "t1", cursor: "x".repeat(101) },
		])
			expect(() => parse(args)).toThrow();
	});

	test("validates target and busy settings without filling partial updates", () => {
		const input = scheduledTaskParametersSchema.parse({
			action: "update",
			id: "task",
			task: { requireReport: false },
		});
		expect(input.task).toEqual({ requireReport: false });
		for (const task of [
			{ narratorMode: "unknown" },
			{ targetNarratorId: "" },
			{ contextPolicy: "erase" },
			{ onBusy: "force" },
			{ busyWaitMinutes: 0 },
			{ busyWaitMinutes: 1441 },
			{ busyWaitMinutes: 1.5 },
			{ requireReport: "false" },
		])
			expect(
				scheduledTaskParametersSchema.safeParse({ action: "update", id: "task", task }).success,
			).toBe(false);
	});

	test("an over-long prompt is refused before it can be persisted", async () => {
		const result = await run({
			action: "create",
			task: { name: "Huge", cronExpr: "0 9 * * *", prompt: "x".repeat(50_001) },
		});
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Invalid ScheduledTask arguments");
	});
});

describe("ScheduledTask unified administrator ACL", () => {
	test("an administrator can read another owner's private task without list prompt leakage", async () => {
		const admin = await caller("admin");
		const owner = await caller();
		const task = await taskFor(owner);
		const listing = await scheduledTaskTool.execute({ action: "list" }, admin.ctx);
		expect(listing.isError).toBeFalsy();
		const payload = JSON.parse(listing.output);
		expect(payload.tasks.some((row: { id: string }) => row.id === task.id)).toBe(true);
		expect(payload.truncated).toBe(false);
		expect(listing.output).not.toContain("PRIVATE_TASK_PROMPT");
		expect(listing.output).not.toContain("PRIVATE_SYSTEM_PROMPT");
		for (const action of ["get", "runs"])
			expect(
				(await scheduledTaskTool.execute({ action, id: task.id }, admin.ctx)).isError,
			).toBeFalsy();
	});

	test("administrator creation uses the same structured input and current owner identity", async () => {
		const admin = await caller("admin");
		const approved = await resolveScheduledTaskApproval(admin.ctx, {
			action: "create",
			task: dailyTask,
		});
		const result = await scheduledTaskTool.execute(approved.input, admin.ctx);
		expect(result.isError).toBeFalsy();
		const task = JSON.parse(result.output);
		expect(task.ownerUserId).toBe(admin.userId);
		expect(task.permissionMode).toBe("default");
	});

	test.each([
		"update",
		"enable",
		"disable",
		"delete",
		"run_now",
	])("an administrator can %s another owner's task through the unified tool", async (action) => {
		const admin = await caller("admin");
		const owner = await caller();
		const task = await taskFor(owner);
		const approved = await resolveScheduledTaskApproval(admin.ctx, {
			action,
			id: task.id,
			...(action === "update" ? { task: { name: "Admin reviewed name" } } : {}),
		});
		const run =
			action === "run_now"
				? spyOn(scheduledTaskService, "runTask").mockResolvedValue(undefined)
				: undefined;
		try {
			const result = await scheduledTaskTool.execute(approved.input, admin.ctx);
			expect(result.isError).toBeFalsy();
			if (action === "run_now") {
				expect(run).toHaveBeenCalledWith(task.id, {
					manual: true,
					principal: admin.principal,
					expectedUpdatedAt: task.updatedAt,
				});
				expect(result.title).toContain("not task completion");
			} else {
				const saved = await scheduledTaskService.get(task.id);
				if (action === "delete") expect(saved).toBeUndefined();
				else {
					expect(saved?.ownerUserId).toBe(owner.userId);
					if (action === "update") expect(saved?.name).toBe("Admin reviewed name");
					else expect(saved?.enabled).toBe(action === "enable");
				}
			}
		} finally {
			run?.mockRestore();
		}
	});

	test("demotion rejects stale cross-owner approvals and reads but preserves owner rights", async () => {
		const admin = await caller("admin");
		const owner = await caller();
		const own = await taskFor(admin);
		const foreign = await taskFor(owner);
		const ownApproval = await resolveScheduledTaskApproval(admin.ctx, {
			action: "disable",
			id: own.id,
		});
		const foreignApprovals = await Promise.all(
			["get", "runs", "update", "enable", "disable", "delete", "run_now"].map((action) =>
				resolveScheduledTaskApproval(admin.ctx, {
					action,
					id: foreign.id,
					...(action === "update" ? { task: { name: "No longer authorized" } } : {}),
				}),
			),
		);
		await db.update(users).set({ role: "user" }).where(eq(users.id, admin.userId));
		const run = spyOn(scheduledTaskService, "runTask").mockResolvedValue(undefined);
		try {
			for (const approved of foreignApprovals) {
				const result = await scheduledTaskTool.execute(approved.input, admin.ctx);
				expect(result.isError).toBe(true);
			}
			expect(run).not.toHaveBeenCalled();
			expect(await scheduledTaskService.get(foreign.id)).toMatchObject({
				ownerUserId: owner.userId,
				name: dailyTask.name,
				enabled: true,
			});
			const listing = await scheduledTaskTool.execute({ action: "list" }, admin.ctx);
			expect(listing.isError).toBeFalsy();
			expect(listing.output).toContain(own.id);
			expect(listing.output).not.toContain(foreign.id);
			expect((await scheduledTaskTool.execute(ownApproval.input, admin.ctx)).isError).toBeFalsy();
			expect((await scheduledTaskService.get(own.id))?.enabled).toBe(false);
		} finally {
			run.mockRestore();
		}
	});
});

describe("ScheduledTask activity summary", () => {
	test("prefers the task name over the opaque id", () => {
		expect(
			summarizeSubagentToolCall("ScheduledTask", {
				action: "create",
				taskName: "Nightly sync",
				// `targetId` is the hints field the query maps `$.id` into.
				targetId: "AbCdEfGhIjKlMnOpQrStU",
			}),
		).toBe("create: Nightly sync");
	});

	test("falls back to the id when no name is present", () => {
		expect(
			summarizeSubagentToolCall("ScheduledTask", { action: "delete", targetId: "task-123" }),
		).toBe("delete: task-123");
	});

	test("never surfaces the prompt body", () => {
		const summary = summarizeSubagentToolCall("ScheduledTask", {
			action: "create",
			taskName: "Report",
			// A hints object never carries `prompt`, but assert the formatter ignores it
			// even if a future query starts selecting one.
			prompt: "SECRET INSTRUCTION",
		} as never);
		expect(summary).not.toContain("SECRET");
	});
});
