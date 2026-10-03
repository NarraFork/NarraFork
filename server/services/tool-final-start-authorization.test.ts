import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import {
	narratorBlacklistDirs,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../db/schema";
import { localBackend } from "../lib/agent/execution/registry";
import { executeTool } from "../lib/agent/tool-executor";
import { toolRegistry } from "../lib/agent/tool-registry";
import { bashTool } from "../lib/agent/tools/bash";
import { writeTool } from "../lib/agent/tools/write";
import type { AgentConfig, AgentToolUse, ToolCallBinding } from "../lib/agent/types";
import { generateId } from "../lib/id";
import { executionPolicyEngine } from "./execution-policy/engine";
import { handlePermission } from "./narrator-permission";
import { narratorPersistence } from "./narrator-persistence";
import { permissionPolicyChanges, permissionRuleService } from "./permission-rule-service";
import { buildFinalToolStartAuthorization } from "./tool-final-start-authorization";

const { db } = await import("../db");
toolRegistry.register(writeTool);
toolRegistry.register(bashTool);
let cwd: string, owner: string, parentId: string;
let actorIds: string[] = [],
	messageIds: string[] = [],
	callIds: string[] = [];
let writeSpy: ReturnType<typeof spyOn>, execSpy: ReturnType<typeof spyOn>;
const now = () => new Date().toISOString();
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "nf-final-start-"));
	owner = generateId();
	parentId = generateId();
	await db
		.insert(users)
		.values({ id: owner, username: owner, passwordHash: "fixture", createdAt: now() });
	await db.insert(narrators).values({
		id: parentId,
		title: "root",
		cwd,
		ownerUserId: owner,
		permissionMode: "bypassPermissions",
		createdAt: now(),
		updatedAt: now(),
	});
	actorIds = [parentId];
	messageIds = [];
	callIds = [];
	writeSpy = spyOn(localBackend, "writeFileBytes");
	execSpy = spyOn(localBackend, "execCommand");
});
afterEach(async () => {
	writeSpy.mockRestore();
	execSpy.mockRestore();
	for (const id of actorIds) executionPolicyEngine.invalidate(id);
	if (callIds.length)
		await db.delete(narratorToolCalls).where(inArray(narratorToolCalls.id, callIds));
	if (messageIds.length) {
		await db.delete(narratorMessageRefs).where(inArray(narratorMessageRefs.messageId, messageIds));
		await db.delete(narratorMessages).where(inArray(narratorMessages.id, messageIds));
	}
	for (const id of [...actorIds].reverse()) await db.delete(narrators).where(eq(narrators.id, id));
	await db.delete(users).where(eq(users.id, owner));
	await rm(cwd, { recursive: true, force: true });
});
async function actor(kind: "primary" | "subagent") {
	if (kind === "primary") return parentId;
	const id = generateId();
	actorIds.push(id);
	await db.insert(narrators).values({
		id,
		title: "child",
		cwd,
		type: "subagent",
		variant: "subagent:general",
		parentNarratorId: parentId,
		aclRootNarratorId: parentId,
		ownerUserId: owner,
		permissionMode: "bypassPermissions",
		createdAt: now(),
		updatedAt: now(),
	});
	return id;
}
async function fixture(
	kind: "primary" | "subagent",
	toolName: "Write" | "Bash",
	explicitGuard = true,
) {
	const id = await actor(kind),
		messageId = generateId(),
		callId = generateId(),
		toolUseId = generateId();
	const output = join(cwd, "effect.txt");
	const input: Record<string, unknown> =
		toolName === "Write"
			? { file_path: output, content: "changed" }
			: { command: "printf spawned > effect.txt", timeout: 2000 };
	const tu: AgentToolUse = { name: toolName, toolUseId, input };
	messageIds.push(messageId);
	callIds.push(callId);
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId: id,
		role: "assistant",
		contentJson: [{ type: "tool_use", id: toolUseId, name: toolName, input }],
		createdAt: now(),
	});
	await db
		.insert(narratorMessageRefs)
		.values({ id: generateId(), narratorId: id, messageId, seq: 1 });
	await db.insert(narratorToolCalls).values({
		id: callId,
		narratorId: id,
		messageId,
		toolUseId,
		toolName,
		inputJson: input,
		status: "initializing",
		executionAttempt: 1,
		executionIdentityVersion: 1,
		createdAt: now(),
	});
	const binding: ToolCallBinding = { toolCallId: callId, attempt: 1 };
	const config: AgentConfig = {
		narratorId: id,
		conversationId: generateId(),
		model: "test:model",
		provider: "test",
		cwd,
		userId: owner,
		signal: new AbortController().signal,
		requireToolCallBinding: true,
		permissionHandler: (name, args, useId, options) =>
			handlePermission(
				id,
				config.signal,
				name,
				args,
				useId,
				cwd,
				"en",
				kind === "subagent" ? parentId : undefined,
				options,
			),
		onExecutionTargetResolved: (useId, target, receipt) =>
			narratorPersistence.updateToolCallExecutionTarget(id, useId, target, receipt),
		onExecutionPlanResolved: (useId, plan, receipt) =>
			narratorPersistence.updateToolCallExecutionPlan(id, useId, plan, receipt),
		onToolExecutionStarting: (useId, receipt, startedAt) =>
			narratorPersistence.claimToolCallExecution(id, useId, receipt, startedAt),
	};
	if (explicitGuard)
		config.onToolExecutionFinalAuthorization = buildFinalToolStartAuthorization(config);
	return { config, tu, binding, output, id, callId };
}
async function missing(path: string) {
	try {
		await access(path);
		return false;
	} catch {
		return true;
	}
}

// Only the awaited preparation hook is held. The permission handler, final-start
// policy service, SQLite rows/cache invalidation and Write/Bash implementations are real.
describe("real final-start policy after snapshot/slot waits", () => {
	for (const kind of ["primary", "subagent"] as const)
		for (const tool of ["Write", "Bash"] as const) {
			test(`${kind} ${tool}: a newly added ancestor blacklist wins over the prior real allow`, async () => {
				const f = await fixture(kind, tool);
				let entered!: () => void, release!: () => void;
				const ready = new Promise<void>((resolve) => {
					entered = resolve;
				});
				const held = new Promise<void>((resolve) => {
					release = resolve;
				});
				f.config.onToolExecutionBefore = async () => {
					entered();
					await held;
				};
				const execution = executeTool(f.tu, f.config, { toolCallBinding: f.binding });
				await ready;
				try {
					const row = await db.query.narratorToolCalls.findFirst({
						where: eq(narratorToolCalls.id, f.callId),
						columns: { permissionDecidedBy: true },
					});
					expect(row?.permissionDecidedBy).toBe("auto");
					await permissionRuleService.createNarratorRule(
						parentId,
						tool === "Write"
							? {
									ruleType: "directoryBlacklist",
									value: {
										path: cwd,
										denyLevel: "denyWrite",
										targetKind: "host",
										pathFlavor: "posix",
									},
								}
							: { ruleType: "commandBlacklist", value: { pattern: "printf*", targetKind: "host" } },
					);
				} finally {
					release();
				}
				const result = await execution;
				expect(result.isError).toBe(true);
				expect(await missing(f.output)).toBe(true);
				expect(writeSpy).not.toHaveBeenCalled();
				expect(execSpy).not.toHaveBeenCalled();
			});
		}
	test("durable direct/recovery runners cannot bypass final policy by omitting the explicit hook", async () => {
		const f = await fixture("primary", "Write", false);
		f.config.onToolExecutionBefore = async () => {
			await permissionRuleService.createNarratorRule(parentId, {
				ruleType: "directoryBlacklist",
				value: { path: cwd, denyLevel: "denyWrite", targetKind: "host", pathFlavor: "posix" },
			});
		};
		const result = await executeTool(f.tu, f.config, { toolCallBinding: f.binding });
		expect(result.isError).toBe(true);
		expect(await missing(f.output)).toBe(true);
		expect(writeSpy).not.toHaveBeenCalled();
	});
	test("a real positive Write control still writes when the admitted policy remains valid", async () => {
		const f = await fixture("primary", "Write");
		const result = await executeTool(f.tu, f.config, { toolCallBinding: f.binding });
		expect(result.isError).not.toBe(true);
		expect(await readFile(f.output, "utf8")).toBe("changed");
		expect(await missing(f.output)).toBe(false);
	});
	test("a real positive Bash control dispatches a process only when the policy remains valid", async () => {
		const f = await fixture("primary", "Bash");
		const result = await executeTool(f.tu, f.config, { toolCallBinding: f.binding });
		expect(result.isError).not.toBe(true);
		expect(await readFile(f.output, "utf8")).toBe("spawned");
		expect(execSpy).toHaveBeenCalled();
	});
	test("real subagent positive controls can Write and dispatch Bash when the policy is unchanged", async () => {
		const write = await fixture("subagent", "Write");
		const written = await executeTool(write.tu, write.config, { toolCallBinding: write.binding });
		expect(written.isError).not.toBe(true);
		expect(await readFile(write.output, "utf8")).toBe("changed");
		const bash = await fixture("subagent", "Bash");
		const executed = await executeTool(bash.tu, bash.config, { toolCallBinding: bash.binding });
		expect(executed.isError).not.toBe(true);
		expect(await readFile(bash.output, "utf8")).toBe("spawned");
		expect(execSpy).toHaveBeenCalled();
	});
	test("revoking the actual triggering actor's ownership during preparation denies the previously allowed Write", async () => {
		const f = await fixture("primary", "Write");
		f.config.onToolExecutionBefore = async () => {
			await db.update(narrators).set({ ownerUserId: null }).where(eq(narrators.id, parentId));
		};
		const result = await executeTool(f.tu, f.config, { toolCallBinding: f.binding });
		expect(result.isError).toBe(true);
		expect(await missing(f.output)).toBe(true);
		expect(execSpy).not.toHaveBeenCalled();
	});
	test("an ACL change in the final executing event is caught synchronously before Write I/O", async () => {
		const f = await fixture("primary", "Write");
		f.config.onEvent = (event) => {
			if (event.type === "tool_executing")
				db.update(narrators).set({ ownerUserId: null }).where(eq(narrators.id, parentId)).run();
		};
		const result = await executeTool(f.tu, f.config, { toolCallBinding: f.binding });
		expect(result.isError).toBe(true);
		expect(await missing(f.output)).toBe(true);
		expect(result.output).toContain("Actor ACL changed");
	});
	test("a blacklist inserted by the executing-event callback is caught by the synchronous final fence", async () => {
		const f = await fixture("primary", "Write");
		f.config.onEvent = (event) => {
			if (event.type !== "tool_executing") return;
			const ruleId = generateId();
			db.insert(narratorBlacklistDirs)
				.values({
					id: ruleId,
					narratorId: parentId,
					path: cwd,
					pathKey: localBackend.paths.identityKey(cwd),
					pathFlavor: "posix",
					targetKind: "host",
					denyLevel: "denyWrite",
					enabled: true,
					createdAt: now(),
				})
				.run();
			permissionPolicyChanges.emit({
				type: "permission:policy_changed",
				narratorId: parentId,
				ruleType: "directoryBlacklist",
				ruleId,
				change: "created",
				changedAt: now(),
			});
		};
		const result = await executeTool(f.tu, f.config, { toolCallBinding: f.binding });
		expect(result.isError).toBe(true);
		expect(await missing(f.output)).toBe(true);
		expect(writeSpy).not.toHaveBeenCalled();
	});
});
