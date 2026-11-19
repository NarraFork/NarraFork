import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { testEnvironment } from "../../../../tests/preload";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../../../db/schema";
import { getNarratorWorkerTestDb } from "../../../services/__tests__/narrator-worker-fixture";
import { generateId } from "../../id";
import type { AgentConfig, AgentToolUse } from "../types";

const fixture = getNarratorWorkerTestDb();
const { db, sqlite } = fixture;
await fixture.ready;
const realDbModule = { ...(await import("../../../db")) };
mock.module("../../../db", () => ({ ...realDbModule, db, sqlite }));
const { executeTool } = await import("../tool-executor");
const { toolRegistry } = await import("../tool-registry");
const { writeTool } = await import("../tools/write");
const { handlePermission } = await import("../../../services/narrator-permission");
const { narratorPersistence } = await import("../../../services/narrator-persistence");
const { buildFinalToolStartAuthorization } = await import(
	"../../../services/tool-final-start-authorization"
);
const restorers: Array<() => void> = [];
const directories: string[] = [];

afterEach(async () => {
	for (const restore of restorers.splice(0).reverse()) restore();
	if (sqlite.inTransaction) sqlite.run("ROLLBACK");
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});
afterAll(async () => {
	(await import("../../../services/narrator-block-sync")).stopBlockSyncSweep();
	mock.module("../../../db", () => realDbModule);
	await fixture.close();
});

async function realWrite() {
	const cwd = await mkdtemp(join(testEnvironment.narraforkHome, "final-authorization-"));
	directories.push(cwd);
	const userId = generateId(),
		narratorId = generateId(),
		messageId = generateId(),
		callId = generateId(),
		toolUseId = generateId();
	const time = new Date().toISOString();
	db.insert(users)
		.values({
			id: userId,
			username: userId,
			passwordHash: "isolated-fixture",
			role: "user",
			createdAt: time,
		})
		.run();
	db.insert(narrators)
		.values({
			id: narratorId,
			cwd,
			ownerUserId: userId,
			permissionMode: "bypassPermissions",
			createdAt: time,
			updatedAt: time,
		})
		.run();
	const path = join(cwd, "effect.txt");
	const input = { file_path: path, content: "approved" };
	const tu: AgentToolUse = { name: "Write", toolUseId, input };
	db.insert(narratorMessages)
		.values({
			id: messageId,
			narratorId,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: toolUseId, name: "Write", input }],
			createdAt: time,
		})
		.run();
	db.insert(narratorMessageRefs).values({ id: generateId(), narratorId, messageId, seq: 1 }).run();
	db.insert(narratorToolCalls)
		.values({
			id: callId,
			narratorId,
			messageId,
			toolUseId,
			toolName: "Write",
			inputJson: input,
			status: "initializing",
			executionAttempt: 1,
			executionIdentityVersion: 1,
			createdAt: time,
		})
		.run();
	const binding = { toolCallId: callId, attempt: 1 };
	const count = { invocation: 0, execute: 0 };
	const original = toolRegistry.get("Write");
	toolRegistry.register(writeTool);
	restorers.push(() => {
		toolRegistry.unregister("Write");
		if (original) toolRegistry.register(original);
	});
	const actualExecute = writeTool.execute;
	const spy = spyOn(writeTool, "execute").mockImplementation((input, ctx) => {
		count.execute++;
		return actualExecute(input, ctx);
	});
	restorers.push(() => spy.mockRestore());
	const config: AgentConfig = {
		narratorId,
		conversationId: generateId(),
		model: "test:model",
		provider: "test",
		cwd,
		userId,
		signal: new AbortController().signal,
		requireToolCallBinding: true,
		permissionHandler: (name, args, useId, options) =>
			handlePermission(narratorId, config.signal, name, args, useId, cwd, "en", undefined, options),
		onExecutionTargetResolved: (useId, target, receipt) =>
			narratorPersistence.updateToolCallExecutionTarget(narratorId, useId, target, receipt),
		onExecutionPlanResolved: (useId, plan, receipt) =>
			narratorPersistence.updateToolCallExecutionPlan(narratorId, useId, plan, receipt),
		onToolExecutionStarting: (useId, receipt, startedAt) =>
			narratorPersistence.claimToolCallExecution(narratorId, useId, receipt, startedAt),
		onToolExecutionInvoking: () => {
			count.invocation++;
		},
	};
	config.onToolExecutionFinalAuthorization = buildFinalToolStartAuthorization(config);
	return {
		config,
		count,
		narratorId,
		callId,
		path,
		run: () => executeTool(tu, config, { toolCallBinding: binding }),
	};
}

describe("final synchronous authorization after Worker preparation", () => {
	test("owner revocation while preparation waits prevents invocation and file writes", async () => {
		const f = await realWrite();
		const entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		f.config.onToolExecutionBefore = async () => {
			entered.resolve();
			await release.promise;
		};
		const running = f.run();
		await Promise.race([
			entered.promise,
			running.then((result) => {
				throw new Error(`Preparation ended early: ${result.output}`);
			}),
		]);
		db.update(narrators).set({ ownerUserId: null }).where(eq(narrators.id, f.narratorId)).run();
		release.resolve();
		expect((await running).isError).toBe(true);
		expect(f.count).toEqual({ invocation: 0, execute: 0 });
		expect(existsSync(f.path)).toBe(false);
	});

	test("raw attempt mutation after an observer is rejected before tool.execute", async () => {
		const f = await realWrite();
		f.config.onEvent = (event) => {
			if (event.type === "tool_executing")
				db.update(narratorToolCalls)
					.set({ executionAttempt: 2 })
					.where(eq(narratorToolCalls.id, f.callId))
					.run();
		};
		expect((await f.run()).isError).toBe(true);
		expect(f.count).toEqual({ invocation: 0, execute: 0 });
		expect(existsSync(f.path)).toBe(false);
	});

	test("the final check and invocation retain their synchronous boundary", () => {
		const executor = readFileSync(new URL("../tool-executor.ts", import.meta.url), "utf8");
		const start = executor.indexOf(
			"finalTicket?.assertStillCurrent();",
			executor.indexOf("// No await or observer callback"),
		);
		const invoke = executor.indexOf("config.onToolExecutionInvoking?.(tu);", start);
		const execute = executor.indexOf("result = await tool.execute(effectiveInput, ctx);", invoke);
		expect(start).toBeGreaterThan(0);
		expect(invoke).toBeGreaterThan(start);
		expect(execute).toBeGreaterThan(invoke);
		expect(executor.slice(start, execute).replace(/\/\/[^\n]*/g, "")).not.toMatch(/\bawait\b/);
	});
});
