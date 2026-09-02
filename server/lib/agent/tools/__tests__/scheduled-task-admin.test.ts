import { describe, expect, test } from "bun:test";
import type { PermissionResult, ToolContext } from "../../types";
import {
	createScheduledTaskAdminTool,
	type ScheduledTaskServiceLike,
} from "../scheduled-task-admin";

function makeCtx(
	options: {
		userId?: string | null;
		permission?: PermissionResult;
		onPermission?: (input: Record<string, unknown>) => void;
	} = {},
): ToolContext {
	return {
		narratorId: "scheduled-task-admin-test",
		cwd: "/tmp",
		signal: new AbortController().signal,
		locale: "en",
		userId: options.userId ?? "admin-user",
		currentToolUseId: "tool-use-1",
		requestPermission: async (_toolName, input) => {
			options.onPermission?.(input);
			return options.permission ?? { behavior: "allow" };
		},
	};
}

function makeService(): {
	service: ScheduledTaskServiceLike;
	tasks: Map<string, Record<string, unknown>>;
	calls: string[];
} {
	const tasks = new Map<string, Record<string, unknown>>();
	const calls: string[] = [];
	return {
		tasks,
		calls,
		service: {
			list: async () => [...tasks.values()],
			get: async (id) => tasks.get(id),
			create: async (input) => {
				calls.push("create");
				const task = { id: `t${tasks.size + 1}`, ...input, createdAt: "now", updatedAt: "now" };
				tasks.set(task.id as string, task);
				return task;
			},
			update: async (id, input) => {
				calls.push(`update:${id}`);
				const next = { ...tasks.get(id), ...input, updatedAt: "now" };
				tasks.set(id, next);
				return next;
			},
			setEnabled: async (id, enabled) => {
				calls.push(`toggle:${id}:${enabled}`);
				const next = { ...tasks.get(id), enabled };
				tasks.set(id, next);
				return next;
			},
			delete: async (id) => {
				calls.push(`delete:${id}`);
				tasks.delete(id);
			},
			runTask: async (id, opts) => {
				calls.push(`run:${id}:${opts?.manual === true ? "manual" : "auto"}`);
			},
			listRuns: async () => ({
				runs: [{ id: "r1", taskId: "t1", status: "success", durationMs: 100 }],
				nextCursor: null,
			}),
		},
	};
}

const VALID_CREATE = {
	action: "create",
	name: "daily digest",
	cronExpr: "0 9 * * *",
	prompt: "Summarize yesterday's work",
};

describe("ScheduledTaskAdmin tool", () => {
	test("lists tasks and truncates long prompts", async () => {
		const { service, tasks } = makeService();
		tasks.set("t1", {
			id: "t1",
			name: "digest",
			cronExpr: "0 9 * * *",
			enabled: true,
			prompt: "x".repeat(5_000),
		});
		const tool = createScheduledTaskAdminTool({ service, isAdminUser: () => false });

		const result = await tool.execute({ action: "list" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("digest");
		expect(result.output).toContain("truncated");
	});

	test("get and runs read a single task without admin checks", async () => {
		const { service, tasks } = makeService();
		tasks.set("t1", { id: "t1", name: "digest", cronExpr: "0 9 * * *", enabled: true });
		const tool = createScheduledTaskAdminTool({ service, isAdminUser: () => false });

		const got = await tool.execute({ action: "get", id: "t1" }, makeCtx());
		expect(got.isError).toBeFalsy();
		expect(got.output).toContain("digest");

		const runs = await tool.execute({ action: "runs", id: "t1", limit: 5 }, makeCtx());
		expect(runs.isError).toBeFalsy();
		expect(runs.output).toContain("r1");

		const missing = await tool.execute({ action: "get", id: "nope" }, makeCtx());
		expect(missing.isError).toBe(true);
	});

	test("rejects non-admin users for create", async () => {
		const { service, calls } = makeService();
		const tool = createScheduledTaskAdminTool({ service, isAdminUser: () => false });

		const result = await tool.execute(VALID_CREATE, makeCtx());
		expect(result.isError).toBe(true);
		expect(result.output).toContain("administrators");
		expect(calls).toHaveLength(0);
	});

	test("does not create when the user denies permission", async () => {
		const { service, calls } = makeService();
		const tool = createScheduledTaskAdminTool({ service, isAdminUser: () => true });
		let permissionRequested = false;

		const result = await tool.execute(
			VALID_CREATE,
			makeCtx({
				permission: { behavior: "deny", message: "No" },
				onPermission: () => {
					permissionRequested = true;
				},
			}),
		);
		expect(permissionRequested).toBe(true);
		expect(result.isError).toBe(true);
		expect(calls).toHaveLength(0);
	});

	test("rejects an invalid cron expression", async () => {
		const { service, calls } = makeService();
		const tool = createScheduledTaskAdminTool({ service, isAdminUser: () => true });

		const result = await tool.execute({ ...VALID_CREATE, cronExpr: "not a cron" }, makeCtx());
		expect(result.isError).toBe(true);
		expect(result.output).toContain("cron");
		expect(calls).toHaveLength(0);
	});

	test("creates a task for admins after approval", async () => {
		const { service, calls, tasks } = makeService();
		const tool = createScheduledTaskAdminTool({ service, isAdminUser: () => true });

		const result = await tool.execute(VALID_CREATE, makeCtx({ userId: "u1" }));
		expect(result.isError).toBeFalsy();
		expect(calls).toEqual(["create"]);
		expect(tasks.get("t1")?.name).toBe("daily digest");
		expect(tasks.get("t1")?.createdBy).toBe("u1");
	});

	test("toggle requires an enabled boolean", async () => {
		const { service, calls, tasks } = makeService();
		tasks.set("t1", { id: "t1", name: "digest", cronExpr: "0 9 * * *", enabled: true });
		const tool = createScheduledTaskAdminTool({ service, isAdminUser: () => true });

		const bad = await tool.execute({ action: "toggle", id: "t1" }, makeCtx());
		expect(bad.isError).toBe(true);
		expect(calls).toHaveLength(0);

		const ok = await tool.execute({ action: "toggle", id: "t1", enabled: false }, makeCtx());
		expect(ok.isError).toBeFalsy();
		expect(calls).toEqual(["toggle:t1:false"]);
	});

	test("run triggers an immediate manual run", async () => {
		const { service, calls, tasks } = makeService();
		tasks.set("t1", { id: "t1", name: "digest", cronExpr: "0 9 * * *", enabled: true });
		const tool = createScheduledTaskAdminTool({ service, isAdminUser: () => true });

		const result = await tool.execute({ action: "run", id: "t1" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(calls).toEqual(["run:t1:manual"]);
	});

	test("update and delete work after approval", async () => {
		const { service, calls, tasks } = makeService();
		tasks.set("t1", { id: "t1", name: "digest", cronExpr: "0 9 * * *", enabled: true });
		const tool = createScheduledTaskAdminTool({ service, isAdminUser: () => true });

		const updated = await tool.execute(
			{ action: "update", id: "t1", cronExpr: "0 10 * * *" },
			makeCtx(),
		);
		expect(updated.isError).toBeFalsy();
		expect(calls).toEqual(["update:t1"]);
		expect(tasks.get("t1")?.cronExpr).toBe("0 10 * * *");

		const deleted = await tool.execute({ action: "delete", id: "t1" }, makeCtx());
		expect(deleted.isError).toBeFalsy();
		expect(calls).toContain("delete:t1");
		expect(tasks.has("t1")).toBe(false);
	});
});
