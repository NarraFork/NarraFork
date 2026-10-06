import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import type { AgentConfig, ToolContext } from "../../lib/agent/types";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { executeTool } = await import("../../lib/agent/tool-executor");
await import("../narrator-service");
const { narratorPersistence: persistence } = await import("../narrator-persistence");
const { toolRegistry } = await import("../../lib/agent/tool-registry");
const { scheduleUpdate, beginQuiescingTools, resetUpdateCoordinationForTests } = await import(
	"../update-coordinator"
);
const originals = [toolRegistry.get("Eval"), toolRegistry.get("Read")];
let readCount = 0;
let action: (ctx: ToolContext) => Promise<{ output: string; isError?: boolean }>;
const binding = { toolCallId: "parent-row", attempt: 1 };
const content = [{ type: "tool_use", id: "eval", name: "Eval", input: {} }];

function config(): AgentConfig {
	return {
		narratorId: "n",
		conversationId: "c",
		provider: "test",
		model: "test",
		cwd: process.cwd(),
		signal: new AbortController().signal,
		requireToolCallBinding: true,
		permissionHandler: async () => ({ behavior: "allow" }),
		onInternalReadAuthorization: async (id, receipt) => {
			await persistence.validateToolCallBinding("n", id, receipt);
		},
		onInternalReadCreated: (id, receipt, input, seq) =>
			persistence.createInternalRead("n", id, receipt, input, seq),
		onInternalReadCompleted: (id, receipt, result) =>
			persistence.completeInternalRead("n", id, receipt, result),
		onToolExecutionStarting: (id, receipt, time) =>
			persistence.claimToolCallExecution("n", id, receipt, time),
		onExecutionTargetResolved: async () => {},
		onExecutionPlanResolved: async () => {},
	};
}
async function run(cfg = config()) {
	return executeTool({ name: "Eval", toolUseId: "eval", input: {} }, cfg, {
		toolCallBinding: binding,
	});
}
async function childRow() {
	return db.query.narratorToolCalls.findFirst({ where: eq(narratorToolCalls.toolName, "Read") });
}
beforeEach(async () => {
	cleanDb(sqlite);
	readCount = 0;
	const now = new Date().toISOString();
	await db.insert(narrators).values({ id: "n", createdAt: now, updatedAt: now });
	await db
		.insert(narratorMessages)
		.values({ id: "m", narratorId: "n", role: "assistant", contentJson: content, createdAt: now });
	await db
		.insert(narratorMessageRefs)
		.values({ id: "ref", narratorId: "n", messageId: "m", seq: 1 });
	await db.insert(narratorToolCalls).values({
		id: binding.toolCallId,
		narratorId: "n",
		messageId: "m",
		toolUseId: "eval",
		toolName: "Eval",
		inputJson: {},
		status: "initializing",
		executionAttempt: 1,
		executionIdentityVersion: 1,
		createdAt: now,
	});
	toolRegistry.register({
		name: "Eval",
		description: "test",
		parameters: z.object({}),
		execute: async (_, ctx) => action(ctx),
	});
	toolRegistry.register({
		name: "Read",
		description: "test",
		parameters: z.object({ file_path: z.string() }),
		execute: async (input, ctx) => {
			readCount++;
			expect(input).not.toHaveProperty("__internalRead");
			expect(ctx.executeRead).toBeUndefined();
			expect(ctx.toolCallBinding?.toolCallId).not.toBe(binding.toolCallId);
			return { output: "complete text", metadata: { complete: true } };
		},
	});
	action = async (ctx) => {
		if (!ctx.executeRead) throw new Error("Missing bridge");
		return ctx.executeRead({ file_path: "/test" }, ctx.signal);
	};
});
afterAll(() => {
	toolRegistry.unregister("Eval");
	toolRegistry.unregister("Read");
	for (const tool of originals) if (tool) toolRegistry.register(tool);
	mock.module("../../db", () => realDb);
	mock.restore();
	sqlite.close();
});

test("内部Read持久行关联真实父attempt，不修改模型消息", async () => {
	const result = await run();
	expect(result.isError).not.toBe(true);
	expect(readCount).toBe(1);
	const child = await childRow();
	expect(child?.messageId).toBe("m");
	expect(child?.executionOriginToolCallId).toBeNull();
	expect(child?.inputJson).toEqual({
		file_path: "/test",
		__internalRead: { parentToolCallId: "parent-row", parentAttempt: 1, sequence: 1 },
	});
	expect(child?.status).toBe("success");
	expect(child?.outputJson).toMatchObject({
		output: "complete text",
		metadata: { complete: true },
	});
	const message = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, "m"),
	});
	expect(message?.contentJson).toEqual(content);
});

test("外层绑定错误拒绝且不创建子行", async () => {
	await expect(
		persistence.createInternalRead("n", "eval", { ...binding, attempt: 2 }, {}, 1),
	).rejects.toThrow();
	expect(await childRow()).toBeUndefined();
});

test("子Read独立权限拒绝也落结果", async () => {
	const cfg = config();
	const permissions: string[] = [];
	cfg.permissionHandler = async (name, _input, _id, options) => {
		permissions.push(name);
		if (name === "Read") {
			expect(options?.toolCallBinding?.toolCallId).not.toBe(binding.toolCallId);
			return { behavior: "deny", message: "read denied" };
		}
		return { behavior: "allow" };
	};
	expect((await run(cfg)).isError).toBe(true);
	expect(permissions).toEqual(["Eval", "Read"]);
	expect(readCount).toBe(0);
	expect((await childRow())?.status).toBe("fail");
});

test("取消后的子Read不触发I/O但留下失败行", async () => {
	action = async (ctx) => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		if (!ctx.executeRead) throw new Error("Missing bridge");
		return ctx.executeRead({ file_path: "/test" }, controller.signal);
	};
	expect((await run()).isError).toBe(true);
	expect(readCount).toBe(0);
	expect((await childRow())?.status).toBe("fail");
});

test("工具过滤不可通过内部Read绕过", async () => {
	const cfg = config();
	cfg.toolFilter = (tool) => tool.name !== "Read";
	expect((await run(cfg)).isError).toBe(true);
	expect(readCount).toBe(0);
	expect((await childRow())?.status).toBe("fail");
});

test("持父lease时更新门关闭立即拒绝且结果持久化", async () => {
	action = async (ctx) => {
		scheduleUpdate("test");
		beginQuiescingTools();
		if (!ctx.executeRead) throw new Error("Missing bridge");
		return ctx.executeRead({ file_path: "/test" }, ctx.signal);
	};
	try {
		const result = await run();
		expect(result.isError).toBe(true);
		expect(result.output).toContain("update admission is closed");
		expect(readCount).toBe(0);
		expect((await childRow())?.status).toBe("fail");
	} finally {
		resetUpdateCoordinationForTests();
	}
}, 2000);

test("子权限批准后发现取消仍不得执行Read", async () => {
	const cfg = config();
	const controller = new AbortController();
	cfg.signal = controller.signal;
	cfg.permissionHandler = async (name) => {
		if (name === "Read") controller.abort(new Error("cancelled during permission"));
		return { behavior: "allow" };
	};
	expect((await run(cfg)).isError).toBe(true);
	expect(readCount).toBe(0);
	expect((await childRow())?.status).toBe("fail");
});

test("缺少任何持久回调不暴露桥", async () => {
	const cfg = config();
	cfg.onInternalReadCompleted = undefined;
	action = async (ctx) => {
		expect(ctx.executeRead).toBeUndefined();
		expect(ctx.recheckAuthorization).toBeUndefined();
		return { output: "ok" };
	};
	await run(cfg);
	expect(await childRow()).toBeUndefined();
});
