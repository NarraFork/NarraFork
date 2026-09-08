import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	fileChangeOperations,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";
import type { AgentConfig, ToolCallBinding, ToolContext } from "../../lib/agent/types";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const realProvider = { ...(await import("../../lib/agent/provider")) };
let providerTurn = 0;
let scenario: "eager" | "write" | "streaming" = "eager";
let resolveStarted = () => {};
let started = Promise.resolve();
const order: string[] = [];
const executed: ToolContext[] = [];
const provider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		params.onRequestStart?.();
		if (++providerTurn > 2) {
			yield { text: "done" };
			return;
		}
		const name = scenario === "write" ? "Write" : "TestBoundRead";
		if (scenario === "streaming") {
			yield { toolUseChunk: { toolUseId: "call_0", name, input: '{"value":"ok"}' } };
			yield { toolUseChunk: { toolUseId: "call_0", stop: true } };
		} else {
			yield { toolUses: [{ toolUseId: "call_0", name, input: { value: "ok" } }] };
		}
		if (scenario !== "write") {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				started,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("eager execution waited for a future event")),
						1500,
					);
				}),
			]).finally(() => clearTimeout(timer));
		}
		yield { text: "after tool" };
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
mock.module("../../lib/agent/provider", () => ({
	...realProvider,
	resolveProviderAndModel: () => ({
		requestedProvider: "test",
		requestedModel: "test:model",
		provider: "test",
		model: "test:model",
		adapter: provider,
	}),
}));
const { toolRegistry } = await import("../../lib/agent/tool-registry");
const { executeTool } = await import("../../lib/agent/tool-executor");
const { agentLoop } = await import("../../lib/agent/loop");
const { narratorPersistence } = await import("../narrator-persistence");
const { processEvent } = await import("../narrator-event-handler");
const { executeAgentLoop } = await import("../narrator-executor");
const { handlePermission, resolvePermission, reprocessAllPendingPermissions } = await import(
	"../narrator-permission"
);
const { pendingPermissions } = await import("../narrator-session-state");
const { latestToolCallAttempts, narratorMessageQueries } = await import("../narrator-messages");
const originalWrite = toolRegistry.get("Write");
const testHome: string = process.env.NARRAFORK_HOME ?? "";
if (!testHome || process.env.NARRAFORK_TEST !== "1")
	throw new Error("Isolated bunfig preload required");
const writePath = join(testHome, "unbound-write-must-not-exist");
function requiredBinding(ctx: ToolContext): ToolCallBinding {
	if (!ctx.toolCallBinding) throw new Error("Tool context lost its binding");
	return ctx.toolCallBinding;
}

toolRegistry.register({
	name: "TestBoundRead",
	description: "binding test",
	metadata: { readOnly: true },
	parameters: z.object({ value: z.string() }),
	execute: async (_input, ctx) => {
		executed.push(ctx);
		order.push("execute");
		resolveStarted();
		return { output: `result:${executed.length}` };
	},
});
toolRegistry.register({
	name: "TestBoundAsk",
	description: "permission binding test",
	parameters: z.object({}),
	execute: async (_input, ctx) => {
		executed.push(ctx);
		return { output: "approved" };
	},
});
toolRegistry.register({
	name: "Write",
	description: "real write sentinel",
	parameters: z.object({ value: z.string() }),
	execute: async (_input, ctx) => {
		executed.push(ctx);
		await Bun.write(writePath, "must not happen");
		return { output: "written" };
	},
});

const now = "2026-09-07T10:00:00.000Z";
async function seedNarrator(
	id = "n",
	permissionMode: "default" | "bypassPermissions" = "bypassPermissions",
) {
	await db.insert(narrators).values({ id, permissionMode, createdAt: now, updatedAt: now });
}
async function seedRow(
	id = "row",
	narratorId = "n",
	messageId = "message",
	toolUseId = "call_0",
	attempt = 1,
) {
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId,
		role: "assistant",
		contentJson: [{ type: "tool_use", id: toolUseId, name: "TestBoundAsk", input: {} }],
		createdAt: now,
	});
	await db.insert(narratorMessageRefs).values({
		id: `ref-${messageId}`,
		narratorId,
		messageId,
		seq: Number(id === "older" ? 2 : 1),
	});
	await db.insert(narratorToolCalls).values({
		id,
		narratorId,
		messageId,
		toolUseId,
		toolName: "TestBoundAsk",
		inputJson: {},
		executionAttempt: attempt,
		executionIdentityVersion: 1,
		status: "initializing",
		createdAt: now,
	});
	return { toolCallId: id, attempt };
}
function context(narratorId = "n") {
	let partial: string | undefined;
	return {
		narratorId,
		broadcastTargetId: narratorId === "child" ? "parent" : narratorId,
		...(narratorId === "child" ? { parentToolUseId: "parent-agent" } : {}),
		conversationId: `conv-${narratorId}`,
		getPartialMessageId: () => partial,
		setPartialMessageId: (id: string | undefined) => {
			partial = id;
		},
		getContextUsagePct: () => undefined,
		getMeterUsage: () => undefined,
		getMeterUnit: () => undefined,
		getTokenUsage: () => undefined,
		setContextUsagePct: () => {},
		setMeterData: () => {},
		setTokenUsage: () => {},
		toolCallIdsMap: new Map<string, string>(),
	};
}
function config(narratorId = "n"): AgentConfig {
	return {
		narratorId,
		conversationId: `conv-${narratorId}`,
		provider: "test",
		model: "test:model",
		cwd: testHome,
		signal: new AbortController().signal,
		requireToolCallBinding: true,
		silentToolCallThreshold: -1,
		permissionHandler: async () => ({ behavior: "allow" }),
		onToolExecutionStarting: (toolUseId, binding, startedAt) =>
			narratorPersistence.claimToolCallExecution(narratorId, toolUseId, binding, startedAt),
	};
}
async function untilPending(id: string) {
	for (let i = 0; i < 100; i++) {
		if (pendingPermissions.has(id)) return;
		await Bun.sleep(5);
	}
	throw new Error("permission did not become pending");
}
beforeEach(() => {
	cleanDb(sqlite);
	executed.length = 0;
	order.length = 0;
	providerTurn = 0;
	started = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
});
afterEach(async () => {
	for (const id of pendingPermissions.keys()) await resolvePermission(id, "deny");
	sqlite.run("DROP TRIGGER IF EXISTS reject_binding_insert");
	sqlite.run("DROP TRIGGER IF EXISTS reject_permission_update");
	sqlite.run("DROP TRIGGER IF EXISTS reject_start_update");
});
afterAll(() => {
	toolRegistry.unregister("TestBoundRead");
	toolRegistry.unregister("TestBoundAsk");
	toolRegistry.unregister("Write");
	if (originalWrite) toolRegistry.register(originalWrite);
	mock.module("../../lib/agent/provider", () => realProvider);
	mock.module("../../db", () => realDb);
	mock.restore();
	sqlite.close();
});

describe("真实工具行执行绑定", () => {
	for (const stream of ["eager", "streaming"] as const)
		test(`${stream}: 持久屏障先于执行，同ID跨消息不复用旧map`, async () => {
			await seedNarrator();
			await seedRow("stale", "n", "old-message", "call_0", 7);
			scenario = stream;
			const ctx = context();
			ctx.toolCallIdsMap.set("call_0", "stale");
			const cfg = config();
			await executeAgentLoop(
				{ config: cfg, userText: "run", history: [], eventContext: ctx },
				{
					eventSource: agentLoop(cfg, "run", []),
					processEventFn: async (event, ec, hooks) => {
						const result = await processEvent(event, ec, hooks);
						if (event.type === "block_complete" && event.block.type === "tool_use")
							order.push("durable");
						if (event.type === "assistant_message") order.push("assistant");
						return result;
					},
				},
			);
			expect(executed).toHaveLength(2);
			expect(order.indexOf("durable")).toBeLessThan(order.indexOf("execute"));
			expect(order.indexOf("execute")).toBeLessThan(order.indexOf("assistant"));
			const bindings = executed.map(requiredBinding);
			expect(new Set(bindings.map((b) => b.toolCallId)).size).toBe(2);
			for (const binding of bindings) {
				expect(binding.attempt).toBe(1);
				expect(binding.toolCallId).not.toBe("stale");
			}
			expect(
				(await db.query.narratorToolCalls.findFirst({ where: eq(narratorToolCalls.id, "stale") }))
					?.executionAttempt,
			).toBe(7);
		});

	test("工具块落库失败时真实Write不执行", async () => {
		await seedNarrator();
		scenario = "write";
		sqlite.run(
			"CREATE TRIGGER reject_binding_insert BEFORE INSERT ON narrator_tool_calls BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END",
		);
		await expect(
			executeAgentLoop({
				config: config(),
				userText: "write",
				history: [],
				eventContext: context(),
			}),
		).rejects.toThrow("persistence barrier");
		expect(executed).toHaveLength(0);
		expect(await Bun.file(writePath).exists()).toBe(false);
	});

	test("缺少当前回执即拒绝Write，不等待未来tool_call", async () => {
		await expect(
			executeTool({ toolUseId: "call_0", name: "Write", input: { value: "x" } }, config()),
		).rejects.toThrow("durable execution receipt");
		expect(executed).toHaveLength(0);
		expect(await Bun.file(writePath).exists()).toBe(false);
	});

	test("权限等待与重处理保持预留attempt1，批准后只认领一次", async () => {
		await seedNarrator("n", "default");
		const binding = await seedRow();
		const cfg = config();
		cfg.permissionHandler = (name, input, toolUseId, options) =>
			handlePermission("n", cfg.signal, name, input, toolUseId, cfg.cwd, "en", undefined, options);
		const execution = executeTool({ toolUseId: "call_0", name: "TestBoundAsk", input: {} }, cfg, {
			toolCallBinding: binding,
		});
		await untilPending("row");
		expect(
			(await db.query.narratorToolCalls.findFirst({ where: eq(narratorToolCalls.id, "row") }))
				?.executionAttempt,
		).toBe(1);
		expect(reprocessAllPendingPermissions("n")).toBe(1);
		await untilPending("row");
		expect(
			(await db.query.narratorToolCalls.findFirst({ where: eq(narratorToolCalls.id, "row") }))
				?.executionAttempt,
		).toBe(1);
		await resolvePermission("row", "allow");
		await execution;
		expect(executed[0].toolCallBinding).toEqual({ toolCallId: "row", attempt: 1 });
		await expect(
			narratorPersistence.claimToolCallExecution(
				"n",
				"call_0",
				{ toolCallId: "row", attempt: 1 },
				Date.now(),
			),
		).rejects.toThrow("already started");
		expect(executed).toHaveLength(1);
	});

	test("结果与权限只更新对应PK，不更新其他消息/叙述者同ID", async () => {
		await seedNarrator();
		await seedNarrator("other");
		const binding = await seedRow("current");
		await seedRow("older", "n", "old");
		await seedRow("foreign", "other", "foreign-message");
		await handlePermission(
			"n",
			new AbortController().signal,
			"TestBoundAsk",
			{},
			"call_0",
			testHome,
			"en",
			undefined,
			{ toolCallBinding: binding },
		);
		await processEvent(
			{
				type: "tool_result",
				toolName: "TestBoundAsk",
				toolUseId: "call_0",
				toolCallBinding: binding,
				output: "new",
				isError: false,
				updatedInput: { changed: true },
			},
			context(),
		);
		const rows = await db.query.narratorToolCalls.findMany();
		await expect(
			narratorPersistence.updateToolCallResult("call_0", { status: "fail", output: "ambiguous" }),
		).rejects.toThrow("exact tool-call row id");
		await expect(
			narratorPersistence.overwriteToolCallInput("call_0", { unsafe: true }),
		).rejects.toThrow("exact tool-call row id");
		expect(rows.find((row) => row.id === "current")?.outputJson).toBe("new");
		for (const id of ["older", "foreign"]) {
			expect(rows.find((row) => row.id === id)?.status).toBe("initializing");
			expect(rows.find((row) => row.id === id)?.inputJson).toEqual({});
		}
		await expect(
			narratorPersistence.getToolCallBinding("n", "old", "call_0", "current"),
		).rejects.toThrow("current narrator/message");
	});

	test("COW重跑新行递增，旧fork事实/审批不改，展示和模型只取最新attempt", async () => {
		await seedNarrator();
		await seedNarrator("fork");
		const source = await seedRow("source", "n", "shared", "call_0", 1);
		await db
			.update(narratorToolCalls)
			.set({
				status: "fail",
				outputJson: "denied",
				permissionDecidedBy: "user",
				permissionDecidedAt: now,
				permissionDenyMessage: "no",
				executionStartedAt: now,
			})
			.where(eq(narratorToolCalls.id, source.toolCallId));
		await db
			.insert(narratorMessageRefs)
			.values({ id: "fork-ref", narratorId: "fork", messageId: "shared", seq: 1 });
		const before = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, "source"),
		});
		const prepared = await narratorPersistence.prepareToolCallAttempt("fork", "source");
		expect(prepared.requiresFreshPermission).toBe(true);
		expect(prepared.toolCall.id).not.toBe("source");
		expect(prepared.toolCall.messageId).not.toBe("shared");
		expect(prepared.toolCall.executionAttempt).toBe(2);
		expect(prepared.toolCall.permissionDecidedBy).toBeNull();
		expect(prepared.toolCall.executionStartedAt).toBeNull();
		expect(prepared.toolCall.fileChangeOperationId).toBeNull();
		expect(
			await db.query.narratorToolCalls.findFirst({ where: eq(narratorToolCalls.id, "source") }),
		).toEqual(before);
		const forkRows = await db.query.narratorToolCalls.findMany({
			where: eq(narratorToolCalls.messageId, prepared.toolCall.messageId),
		});
		expect(latestToolCallAttempts(forkRows.slice().reverse()).map((r) => r.id)).toEqual([
			prepared.toolCall.id,
		]);
		expect(
			(await narratorMessageQueries.getModelHistorySinceLastCompact("fork"))[0].toolCalls.map(
				(r) => r.id,
			),
		).toEqual([prepared.toolCall.id]);
		await expect(
			narratorPersistence.prepareToolCallAttempt(
				"fork",
				forkRows.find((r) => r.id !== prepared.toolCall.id)?.id ?? "missing-clone",
			),
		).rejects.toThrow("newer execution attempt");
		const ownBinding = await narratorPersistence.getToolCallBinding(
			"fork",
			prepared.toolCall.messageId,
			"call_0",
			prepared.toolCall.id,
		);
		await narratorPersistence.claimToolCallExecution("fork", "call_0", ownBinding, Date.now());
		expect(
			(
				await db.query.narratorToolCalls.findFirst({
					where: and(
						eq(narratorToolCalls.id, prepared.toolCall.id),
						eq(narratorToolCalls.narratorId, "fork"),
					),
				})
			)?.executionAttempt,
		).toBe(2);
	});

	test("恢复未开始的persisted行复用身份，已开始的禁止盲重放", async () => {
		await seedNarrator();
		const binding = await seedRow();
		const resumed = await narratorPersistence.prepareToolCallAttempt("n", "row", true);
		expect(resumed.toolCall.executionAttempt).toBe(1);
		expect(resumed.toolCall.id).toBe("row");
		await narratorPersistence.claimToolCallExecution("n", "call_0", binding, Date.now());
		await expect(narratorPersistence.prepareToolCallAttempt("n", "row", true)).rejects.toThrow(
			"reconciliation",
		);
	});

	test("旧版本和COW克隆不能绑定或自动恢复，显式重跑创建可信新行", async () => {
		await seedNarrator();
		await seedNarrator("fork");
		await seedRow("legacy");
		await db
			.update(narratorToolCalls)
			.set({ executionIdentityVersion: 0, executionAttempt: 0 })
			.where(eq(narratorToolCalls.id, "legacy"));
		await expect(
			narratorPersistence.getToolCallBinding("n", "message", "call_0", "legacy"),
		).rejects.toThrow("current narrator/message");
		await expect(narratorPersistence.prepareToolCallAttempt("n", "legacy", true)).rejects.toThrow(
			"Legacy or COW",
		);
		const retry = await narratorPersistence.prepareToolCallAttempt("n", "legacy");
		expect(retry.toolCall.executionIdentityVersion).toBe(1);
		expect(retry.toolCall.executionOriginToolCallId).toBeNull();
		await db
			.insert(narratorMessageRefs)
			.values({ id: "clone-ref", narratorId: "fork", messageId: "message", seq: 1 });
		const messageId = await narratorPersistence.copyOnWriteMessage("fork", "message");
		const clone = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.messageId, messageId),
				eq(narratorToolCalls.executionOriginToolCallId, retry.toolCall.id),
			),
		});
		if (!clone) throw new Error("missing COW clone");
		expect(clone.executionAttempt).toBe(1);
		await expect(
			narratorPersistence.getToolCallBinding("fork", messageId, "call_0", clone.id),
		).rejects.toThrow("current narrator/message");
		await expect(
			narratorPersistence.prepareToolCallAttempt("fork", clone.id, true),
		).rejects.toThrow("Legacy or COW");
	});

	test("COW仅复制operation引用，真实新attempt不继承旧操作和计费", async () => {
		await seedNarrator();
		await seedNarrator("fork");
		await seedRow("source", "n", "shared");
		await db.insert(fileChangeOperations).values({
			id: "op",
			sourceInstanceId: "instance",
			sourceKind: "tool",
			sourceId: "source",
			attempt: 1,
			actorSubjectKey: "n",
			actorJson: {
				kind: "primary",
				subjectKey: "n",
				narratorId: "n",
				userId: null,
				label: null,
				deleted: false,
				parentSubjectKey: null,
			},
			startedAt: now,
			updatedAt: now,
		});
		await db
			.update(narratorToolCalls)
			.set({ fileChangeOperationId: "op", outputTokens: 100, totalCost: 2 })
			.where(eq(narratorToolCalls.id, "source"));
		await db
			.insert(narratorMessageRefs)
			.values({ id: "fork-ref", narratorId: "fork", messageId: "shared", seq: 1 });
		const retry = await narratorPersistence.prepareToolCallAttempt("fork", "source");
		const rows = await db.query.narratorToolCalls.findMany({
			where: eq(narratorToolCalls.messageId, retry.toolCall.messageId),
		});
		expect(rows.filter((row) => row.fileChangeOperationId === "op")).toHaveLength(1);
		expect(retry.toolCall.fileChangeOperationId).toBeNull();
		expect(retry.toolCall.totalCost).toBe(0);
		expect(retry.toolCall.outputTokens).toBe(0);
		expect(await db.query.fileChangeOperations.findMany()).toHaveLength(1);
	});

	test("权限决定持久化失败不启动工具", async () => {
		await seedNarrator("n", "default");
		const binding = await seedRow();
		const cfg = config();
		cfg.permissionHandler = (name, input, toolUseId, options) =>
			handlePermission("n", cfg.signal, name, input, toolUseId, cfg.cwd, "en", undefined, options);
		const execution = executeTool({ toolUseId: "call_0", name: "TestBoundAsk", input: {} }, cfg, {
			toolCallBinding: binding,
		});
		await untilPending("row");
		sqlite.run(
			"CREATE TRIGGER reject_permission_update BEFORE UPDATE ON narrator_tool_calls WHEN NEW.permission_decided_by = 'user' BEGIN SELECT RAISE(ABORT, 'approval persistence failed'); END",
		);
		expect(await resolvePermission("row", "allow")).toBe(false);
		expect((await execution).isError).toBe(true);
		expect(executed).toHaveLength(0);
		expect(
			(await db.query.narratorToolCalls.findFirst({ where: eq(narratorToolCalls.id, "row") }))
				?.executionStartedAt,
		).toBeNull();
	});

	test("开始认领落库失败不写文件，两个恢复调用最多执行一次", async () => {
		await seedNarrator();
		const binding = await seedRow();
		sqlite.run(
			"CREATE TRIGGER reject_start_update BEFORE UPDATE ON narrator_tool_calls WHEN NEW.execution_started_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'start persistence failed'); END",
		);
		await expect(
			executeTool({ toolUseId: "call_0", name: "Write", input: { value: "x" } }, config(), {
				toolCallBinding: binding,
			}),
		).rejects.toThrow("start persistence failed");
		expect(await Bun.file(writePath).exists()).toBe(false);
		expect(executed).toHaveLength(0);
		sqlite.run("DROP TRIGGER reject_start_update");
		const results = await Promise.allSettled(
			[1, 2].map(() =>
				executeTool({ toolUseId: "call_0", name: "TestBoundAsk", input: {} }, config(), {
					toolCallBinding: binding,
				}),
			),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(executed).toHaveLength(1);
	});

	test("生产消费者拒绝旧map无回执结果，不接纳其他消息的行", async () => {
		await seedNarrator();
		const binding = await seedRow();
		const ctx = context();
		ctx.toolCallIdsMap.set("call_0", binding.toolCallId);
		await expect(
			executeAgentLoop(
				{ config: config(), userText: "", history: [], eventContext: ctx },
				{
					eventSource: (async function* () {
						yield {
							type: "tool_result" as const,
							toolName: "TestBoundAsk",
							toolUseId: "call_0",
							output: "wrong",
							isError: false,
						};
					})(),
				},
			),
		).rejects.toThrow("no persisted execution receipt");
		expect(
			(await db.query.narratorToolCalls.findFirst({ where: eq(narratorToolCalls.id, "row") }))
				?.outputJson,
		).toBeNull();
	});

	test("结论原PK在同ID消息及COW后仍唯一定位，不能按latest猜测", async () => {
		await seedNarrator();
		await seedNarrator("fork");
		await seedRow("source", "n", "shared");
		await seedRow("older", "n", "other-message");
		await expect(
			narratorPersistence.resolveToolCallConclusionReference("n", "call_0", {}),
		).rejects.toThrow("original tool-call row or message");
		expect(
			await narratorPersistence.resolveToolCallConclusionReference("n", "call_0", {
				toolCallId: "source",
			}),
		).toEqual({ toolCallId: "source", messageId: "shared" });
		await db
			.insert(narratorMessageRefs)
			.values({ id: "fork-shared", narratorId: "fork", messageId: "shared", seq: 1 });
		const privateMessageId = await narratorPersistence.copyOnWriteMessage("n", "shared");
		const target = await narratorPersistence.resolveToolCallConclusionReference("n", "call_0", {
			toolCallId: "source",
		});
		expect(target.messageId).toBe(privateMessageId);
		expect(target.toolCallId).not.toBe("source");
		await narratorPersistence.updateToolCallResult(
			"call_0",
			{ status: "success", output: "private conclusion" },
			target.messageId,
			target.toolCallId,
		);
		expect(
			(await db.query.narratorToolCalls.findFirst({ where: eq(narratorToolCalls.id, "source") }))
				?.outputJson,
		).toBeNull();
		expect(
			(await db.query.narratorToolCalls.findFirst({ where: eq(narratorToolCalls.id, "older") }))
				?.outputJson,
		).toBeNull();
	});

	test("创建时保存真实Agent来源，拒绝别的parent和未执行来源", async () => {
		await seedNarrator();
		await seedNarrator("other");
		const binding = await seedRow("source");
		await db
			.update(narratorToolCalls)
			.set({ toolName: "Agent" })
			.where(eq(narratorToolCalls.id, "source"));
		const { narratorService } = await import("../narrator-service");
		const input = {
			parentNarratorId: "n",
			subagentType: "general",
			cwd: testHome,
			originToolCallId: "source",
		};
		await expect(narratorService.createSubagent(input)).rejects.toThrow("executing Agent row");
		await narratorPersistence.claimToolCallExecution("n", "call_0", binding, Date.now());
		const child = await narratorService.createSubagent(input);
		expect(child.originToolCallId).toBe("source");
		expect(child.subagentOriginKind).toBe("tool");
		expect(
			await narratorPersistence.resolveSubagentConclusionReference(child.id, "n", "call_0"),
		).toMatchObject({ toolCallId: "source", messageId: "message", originToolCallId: "source" });
		await expect(
			narratorService.createSubagent({ ...input, parentNarratorId: "other" }),
		).rejects.toThrow("parent's executing Agent row");
		await expect(
			narratorPersistence.resolveSubagentConclusionReference(child.id, "other", "call_0"),
		).rejects.toThrow("trusted parent tool-call origin");
		await expect(
			narratorPersistence.resolveSubagentConclusionReference(
				child.id,
				"n",
				"call_0",
				"different-row",
			),
		).rejects.toThrow("watcher");
	});

	test("子代理来源解析跨COW只更新当前parent的副本，legacy与primary拒绝", async () => {
		await seedNarrator();
		await seedNarrator("fork");
		await seedNarrator("other");
		const binding = await seedRow("source", "n", "shared");
		await db
			.update(narratorToolCalls)
			.set({ toolName: "Agent" })
			.where(eq(narratorToolCalls.id, "source"));
		await narratorPersistence.claimToolCallExecution("n", "call_0", binding, Date.now());
		const { narratorService } = await import("../narrator-service");
		const child = await narratorService.createSubagent({
			parentNarratorId: "n",
			subagentType: "general",
			cwd: testHome,
			originToolCallId: "source",
		});
		const { registerConclusionWatcher, getConclusionWatcher, removeConclusionWatcher } =
			await import("../subagent-manual-override");
		registerConclusionWatcher(child.id, "n", "call_0", child.originToolCallId ?? undefined);
		await db
			.insert(narratorMessageRefs)
			.values({ id: "fork-ref", narratorId: "fork", messageId: "shared", seq: 1 });
		const privateMessageId = await narratorPersistence.copyOnWriteMessage("n", "shared");
		const watcher = getConclusionWatcher(child.id);
		const target = await narratorPersistence.resolveSubagentConclusionReference(
			child.id,
			"n",
			"call_0",
			watcher?.originToolCallId,
		);
		expect(target.messageId).toBe(privateMessageId);
		expect(target.toolCallId).not.toBe("source");
		await narratorPersistence.updateToolCallResult(
			"call_0",
			{ status: "success", output: "child conclusion" },
			target.messageId,
			target.toolCallId,
		);
		expect(
			(await db.query.narratorToolCalls.findFirst({ where: eq(narratorToolCalls.id, "source") }))
				?.outputJson,
		).toBeNull();
		await db
			.update(narrators)
			.set({ originToolCallId: "source", parentNarratorId: "n" })
			.where(eq(narrators.id, "other"));
		await expect(
			narratorPersistence.resolveSubagentConclusionReference("other", "n", "call_0"),
		).rejects.toThrow("trusted parent tool-call origin");
		await db.update(narrators).set({ originToolCallId: null }).where(eq(narrators.id, child.id));
		await expect(
			narratorPersistence.resolveSubagentConclusionReference(child.id, "n", "call_0"),
		).rejects.toThrow("trusted parent tool-call origin");
		removeConclusionWatcher(child.id);
	});

	test("实际Agent工具经runner创建子代理时保留ctx主键", async () => {
		await seedNarrator();
		const binding = await seedRow("agent-source");
		await seedRow("older", "n", "other-agent-message");
		await db
			.update(narratorToolCalls)
			.set({ toolName: "Agent" })
			.where(eq(narratorToolCalls.id, "agent-source"));
		const { agentTool } = await import("../../lib/agent/tools/task");
		const previous = toolRegistry.get("Agent");
		toolRegistry.register(agentTool);
		// A text-only child turn makes this a real spawn/return path without external I/O.
		providerTurn = 10;
		try {
			const result = await executeTool(
				{
					toolUseId: "call_0",
					name: "Agent",
					input: { prompt: "verify origin", subagent_type: "general", description: "origin child" },
				},
				config(),
				{ toolCallBinding: binding },
			);
			const children = await db.query.narrators.findMany({
				where: eq(narrators.parentNarratorId, "n"),
			});
			expect(result.isError).not.toBe(true);
			expect(children).toHaveLength(1);
			expect(children[0].originToolCallId).toBe("agent-source");
			const originRow = await db.query.narratorToolCalls.findFirst({
				where: eq(narratorToolCalls.id, "agent-source"),
			});
			const otherRow = await db.query.narratorToolCalls.findFirst({
				where: eq(narratorToolCalls.id, "older"),
			});
			expect(originRow?.resultMessageId).not.toBeNull();
			expect(otherRow?.resultMessageId).toBeNull();
		} finally {
			toolRegistry.unregister("Agent");
			if (previous) toolRegistry.register(previous);
		}
	});

	test("子代理工具绑定自己的行而非父Agent行，后台闭包保留binding", async () => {
		await seedNarrator("parent");
		await seedNarrator("child");
		await seedRow("parent-row", "parent", "parent-message", "parent-agent");
		const ctx = context("child");
		const cfg = config("child");
		scenario = "eager";
		await executeAgentLoop({ config: cfg, userText: "child", history: [], eventContext: ctx });
		const binding = requiredBinding(executed[0]);
		expect(binding.toolCallId).not.toBe("parent-row");
		const persisted = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, binding.toolCallId),
		});
		expect(persisted?.narratorId).toBe("child");
		await Promise.resolve();
		expect(executed[0].toolCallBinding).toBe(binding);
	});
});
