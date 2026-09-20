import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { executeTool } from "../../lib/agent/tool-executor";
import { toolRegistry } from "../../lib/agent/tool-registry";
import type { AgentConfig, AgentToolUse, ToolResult } from "../../lib/agent/types";
import {
	getUpdateCoordinationStatus,
	resetUpdateCoordinationForTests,
} from "../update-coordinator";

const name = "__SnapshotLifecycleTest";
const binding = { toolCallId: "lifecycle-row", attempt: 1 };

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function config(controller = new AbortController()): AgentConfig {
	return {
		narratorId: "snapshot-lifecycle",
		conversationId: "snapshot-lifecycle",
		model: "test",
		provider: "anthropic",
		cwd: process.cwd(),
		signal: controller.signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		requireToolCallBinding: true,
		onToolExecutionStarting: async (_id, receipt) => receipt,
	};
}

function register(execute: () => Promise<ToolResult>) {
	toolRegistry.register({
		name,
		description: "lifecycle test",
		parameters: z.object({ value: z.string().optional() }),
		execute,
	});
}

function run(settings: AgentConfig) {
	const toolUse: AgentToolUse = { name, toolUseId: "lifecycle-call", input: { value: "original" } };
	return executeTool(toolUse, settings, { toolCallBinding: binding });
}

afterEach(() => {
	toolRegistry.unregister(name);
	resetUpdateCoordinationForTests();
});

describe("awaited tool execution lifecycle", () => {
	test("awaits before after authorization, then claims/executes, and awaits after before settling", async () => {
		const events: string[] = [];
		const beforeEntered = deferred();
		const beforeRelease = deferred();
		const afterEntered = deferred();
		const afterRelease = deferred();
		const result = { output: "written", metadata: { path: "redirected" } };
		register(async () => {
			events.push("execute");
			return result;
		});
		const settings = config();
		settings.permissionHandler = async () => {
			events.push("permission");
			return { behavior: "allow", updatedInput: { value: "redirected" } };
		};
		settings.onToolExecutionBefore = async (context) => {
			expect(context.binding).toEqual(binding);
			expect(context.toolUse.input).toEqual({ value: "original" });
			expect(context.effectiveInput).toEqual({ value: "redirected" });
			events.push("before");
			beforeEntered.resolve();
			await beforeRelease.promise;
		};
		let releasedAt = 0;
		settings.onToolExecutionStarting = async (_id, receipt, startedAt) => {
			expect(startedAt).toBeGreaterThanOrEqual(releasedAt);
			events.push("claim");
			return receipt;
		};
		settings.onEvent = (event) => {
			if (event.type === "tool_executing") events.push("running");
		};
		settings.onToolExecutionAfter = async (context) => {
			expect(context.result).toBe(result);
			expect(context.error).toBeUndefined();
			expect(context.effectiveInput).toEqual({ value: "redirected" });
			events.push("after");
			afterEntered.resolve();
			await afterRelease.promise;
		};
		let settled = false;
		const pending = run(settings).then((value) => {
			settled = true;
			return value;
		});
		await beforeEntered.promise;
		expect(events).toEqual(["permission", "before"]);
		releasedAt = Date.now();
		beforeRelease.resolve();
		await afterEntered.promise;
		expect(events).toEqual(["permission", "before", "claim", "running", "execute", "after"]);
		expect(settled).toBe(false);
		afterRelease.resolve();
		expect((await pending).output).toBe("written");
	});

	test("permission denial does not open a snapshot claim", async () => {
		let calls = 0;
		register(async () => {
			calls++;
			return { output: "unexpected" };
		});
		const settings = config();
		settings.permissionHandler = async () => ({ behavior: "deny", message: "denied" });
		settings.onToolExecutionBefore = () => {
			calls++;
		};
		settings.onToolExecutionAfter = () => {
			calls++;
		};
		expect((await run(settings)).isError).toBe(true);
		expect(calls).toBe(0);
	});

	test("abort during capture skips execution but awaits paired cleanup", async () => {
		const controller = new AbortController();
		const events: string[] = [];
		register(async () => {
			events.push("execute");
			return { output: "unexpected" };
		});
		const settings = config(controller);
		settings.onToolExecutionBefore = () => {
			events.push("before");
			controller.abort();
		};
		settings.onToolExecutionStarting = async (_id, receipt) => {
			events.push("claim");
			return receipt;
		};
		settings.onToolExecutionAfter = (context) => {
			expect(context.result).toBeUndefined();
			expect(context.error).toBeDefined();
			events.push("after");
		};
		expect((await run(settings)).isError).toBe(true);
		expect(events).toEqual(["before", "after"]);
		expect(getUpdateCoordinationStatus().pendingOrdinaryExecutionCount).toBe(0);
	});

	test("durable start failure rejects only after paired cleanup and releases admission", async () => {
		const failure = new Error("durable claim unavailable");
		const events: string[] = [];
		register(async () => {
			events.push("execute");
			return { output: "unexpected" };
		});
		const settings = config();
		settings.onToolExecutionBefore = () => {
			events.push("before");
		};
		settings.onToolExecutionStarting = async () => {
			throw failure;
		};
		settings.onToolExecutionAfter = (context) => {
			expect(context.error).toBe(failure);
			events.push("after");
		};
		await expect(run(settings)).rejects.toThrow(failure.message);
		expect(events).toEqual(["before", "after"]);
		expect(getUpdateCoordinationStatus().pendingOrdinaryExecutionCount).toBe(0);
	});

	test("thrown execution still completes cleanup and preserves the error", async () => {
		const failure = new Error("write failed after partial change");
		register(async () => {
			throw failure;
		});
		let cleaned = false;
		const settings = config();
		settings.onToolExecutionAfter = (context) => {
			expect(context.error).toBe(failure);
			cleaned = true;
		};
		const result = await run(settings);
		expect(result.isError).toBe(true);
		expect(result.output).toContain(failure.message);
		expect(cleaned).toBe(true);
	});

	test("snapshot observer failures are fail-open and still pair cleanup", async () => {
		const events: string[] = [];
		register(async () => {
			events.push("execute");
			return { output: "ok" };
		});
		const settings = config();
		settings.onToolExecutionBefore = () => {
			events.push("before");
			throw new Error("capture unavailable");
		};
		settings.onToolExecutionAfter = () => {
			events.push("after");
			throw new Error("persist unavailable");
		};
		const result = await run(settings);
		expect(result.isError).not.toBe(true);
		expect(result.output).toBe("ok");
		expect(events).toEqual(["before", "execute", "after"]);
	});
});
