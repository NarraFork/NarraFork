import { describe, expect, test } from "bun:test";
import type { PermissionResult, ToolContext } from "../../types";
import { createHookAdminTool, type HookServiceLike } from "../hook-admin";

function makeCtx(
	options: {
		userId?: string | null;
		permission?: PermissionResult;
		onPermission?: (input: Record<string, unknown>) => void;
	} = {},
): ToolContext {
	return {
		narratorId: "hook-admin-test",
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
	service: HookServiceLike;
	hooks: Map<string, Record<string, unknown>>;
	calls: string[];
} {
	const hooks = new Map<string, Record<string, unknown>>();
	const calls: string[] = [];
	return {
		hooks,
		calls,
		service: {
			listAll: async () => [...hooks.values()],
			get: async (id) => hooks.get(id),
			create: async (data) => {
				calls.push("create");
				const hook = { id: `h${hooks.size + 1}`, ...data, createdAt: "now", updatedAt: "now" };
				hooks.set(hook.id as string, hook);
				return hook;
			},
			update: async (id, data) => {
				calls.push("update");
				const next = { ...hooks.get(id), ...data, updatedAt: "now" };
				hooks.set(id, next);
				return next;
			},
			delete: async (id) => {
				calls.push(`delete:${id}`);
				hooks.delete(id);
			},
		},
	};
}

describe("HookAdmin tool", () => {
	test("lists hooks and never echoes header values", async () => {
		const { service, hooks } = makeService();
		hooks.set("h1", {
			id: "h1",
			event: "PreToolUse",
			matcher: "Bash",
			type: "http",
			url: "https://example.com/hook",
			headers: { Authorization: "Bearer sekrit" },
			enabled: true,
			timeout: 30,
		});
		const tool = createHookAdminTool({ service, isAdminUser: () => false });

		const result = await tool.execute({ action: "list" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("h1");
		expect(result.output).toContain("Authorization");
		expect(result.output).not.toContain("sekrit");
	});

	test("get returns a single hook and misses are errors", async () => {
		const { service, hooks } = makeService();
		hooks.set("h1", {
			id: "h1",
			event: "Stop",
			type: "command",
			command: "echo done",
			enabled: true,
		});
		const tool = createHookAdminTool({ service, isAdminUser: () => false });

		const found = await tool.execute({ action: "get", id: "h1" }, makeCtx());
		expect(found.isError).toBeFalsy();
		expect(found.output).toContain("echo done");

		const missing = await tool.execute({ action: "get", id: "nope" }, makeCtx());
		expect(missing.isError).toBe(true);
	});

	test("rejects non-admin users for create", async () => {
		const { service, calls } = makeService();
		const tool = createHookAdminTool({ service, isAdminUser: () => false });

		const result = await tool.execute(
			{ action: "create", event: "Stop", type: "command", command: "echo hi" },
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("administrators");
		expect(calls).toHaveLength(0);
	});

	test("does not create when the user denies permission", async () => {
		const { service, calls } = makeService();
		const tool = createHookAdminTool({ service, isAdminUser: () => true });
		let permissionRequested = false;

		const result = await tool.execute(
			{ action: "create", event: "Stop", type: "command", command: "echo hi" },
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

	test("creates a command hook for admins after approval", async () => {
		const { service, calls } = makeService();
		const tool = createHookAdminTool({ service, isAdminUser: () => true });

		const result = await tool.execute(
			{
				action: "create",
				event: "PostToolUse",
				matcher: "Edit",
				type: "command",
				command: "echo done",
				timeout: 15,
			},
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(calls).toEqual(["create"]);
		expect(result.output).toContain("PostToolUse");
	});

	test("rejects a command-type create without a command", async () => {
		const { service, calls } = makeService();
		const tool = createHookAdminTool({ service, isAdminUser: () => true });

		const result = await tool.execute(
			{ action: "create", event: "Stop", type: "command" },
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Invalid hook configuration");
		expect(calls).toHaveLength(0);
	});

	test("update cannot clear the command of a command hook", async () => {
		const { service, calls, hooks } = makeService();
		hooks.set("h1", {
			id: "h1",
			event: "Stop",
			type: "command",
			command: "echo hi",
			enabled: true,
		});
		const tool = createHookAdminTool({ service, isAdminUser: () => true });

		const result = await tool.execute({ action: "update", id: "h1", command: null }, makeCtx());
		expect(result.isError).toBe(true);
		expect(result.output).toContain("command");
		expect(calls).toHaveLength(0);
	});

	test("update modifies an existing hook", async () => {
		const { service, calls, hooks } = makeService();
		hooks.set("h1", {
			id: "h1",
			event: "Stop",
			type: "command",
			command: "echo hi",
			enabled: true,
		});
		const tool = createHookAdminTool({ service, isAdminUser: () => true });

		const result = await tool.execute(
			{ action: "update", id: "h1", enabled: false, timeout: 60 },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(calls).toEqual(["update"]);
		expect(hooks.get("h1")?.enabled).toBe(false);
		expect(hooks.get("h1")?.timeout).toBe(60);
	});

	test("delete removes the hook", async () => {
		const { service, calls, hooks } = makeService();
		hooks.set("h1", {
			id: "h1",
			event: "Stop",
			type: "command",
			command: "echo hi",
			enabled: true,
		});
		const tool = createHookAdminTool({ service, isAdminUser: () => true });

		const result = await tool.execute({ action: "delete", id: "h1" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(calls).toEqual(["delete:h1"]);
		expect(hooks.has("h1")).toBe(false);
	});
});
