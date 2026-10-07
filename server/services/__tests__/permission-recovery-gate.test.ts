import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import {
	bindPermissionRecovery,
	getPermissionRecovery,
	isRecoveredHumanPermission,
	type PersistedRecoveryGate,
	recoveryReflection,
} from "../../lib/agent/recovery-gate";
import { toolRegistry } from "../../lib/agent/tool-registry";
import type { AgentConfig, PermissionHandlerOptions } from "../../lib/agent/types";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
const realService = { ...(await import("../narrator-service")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
mock.module("../narrator-service", () => ({
	...realService,
	narratorService: { ...realService.narratorService, updateStatus: async () => {} },
}));
const { handlePermission, resolvePermission, cancelDangerReflection } = await import(
	"../narrator-permission"
);
const { pendingPermissions, pendingDangerReflections } = await import("../narrator-session-state");
const realProvider = { ...(await import("../../lib/agent/provider")) };
let reflectionStarts = 0;
mock.module("../../lib/agent/provider", () => ({
	...realProvider,
	resolveProviderAndModel: () => {
		reflectionStarts++;
		throw new Error("simulated recovery provider unavailable");
	},
}));
const { executePersistedToolAfterReflections } = await import("../../lib/agent/loop");
const {
	cleanupTaskReflection,
	createTaskReflectionDecision,
	getTaskReflectionAwaitingUser,
	takeOverTaskReflection,
	confirmTaskReflection,
} = await import("../../lib/agent/tools/task-reflection");

const ID = "recovered-gate";
const OWNER = "recovered-owner";
const USE = "recovered-use";
const gate: PersistedRecoveryGate = { id: ID, status: "pending" };
let controller = new AbortController();
afterEach(() => {
	controller.abort();
	pendingPermissions.get(ID)?.cleanup();
	pendingDangerReflections.get(ID)?.cleanup();
	cleanupTaskReflection(ID);
	cleanDb(sqlite);
	controller = new AbortController();
});
afterAll(() => {
	mock.module("../../db", () => realDb);
	mock.module("../narrator-service", () => realService);
	mock.module("../../lib/agent/provider", () => realProvider);
	mock.restore();
	sqlite.close();
});

async function seed() {
	const now = new Date().toISOString();
	await db
		.insert(narrators)
		.values({ id: OWNER, permissionMode: "bypassPermissions", createdAt: now, updatedAt: now });
	await db.insert(narratorMessages).values({
		id: "recovered-message",
		narratorId: OWNER,
		role: "assistant",
		contentJson: [],
		createdAt: now,
	});
	await db
		.insert(narratorMessageRefs)
		.values({ id: "recovered-ref", narratorId: OWNER, messageId: "recovered-message", seq: 1 });
	await db.insert(narratorToolCalls).values({
		id: ID,
		executionAttempt: 1,
		executionIdentityVersion: 1,
		narratorId: OWNER,
		messageId: "recovered-message",
		toolUseId: USE,
		toolName: "RecoveryProbe",
		inputJson: { value: 42 },
		status: "pending",
		createdAt: now,
	});
}

function request(restored: PersistedRecoveryGate) {
	const ready = Promise.withResolvers<void>();
	const options: PermissionHandlerOptions = { onAwaitingUserDecision: () => ready.resolve() };
	bindPermissionRecovery(options, restored);
	const result = handlePermission(
		OWNER,
		controller.signal,
		"RecoveryProbe",
		{ value: 42 },
		USE,
		process.cwd(),
		"en",
		undefined,
		options,
	);
	return { result, ready: ready.promise };
}

describe("persisted permission gates", () => {
	test("recovery wrapper ignores stale pregrant and executes only after the original user wait", async () => {
		await seed();
		let executions = 0;
		toolRegistry.register({
			name: "RecoveryProbe",
			description: "recovery test",
			parameters: z.object({ value: z.number() }),
			execute: async () => {
				executions++;
				return { output: "approved execution" };
			},
		});
		const ready = Promise.withResolvers<void>();
		const config: AgentConfig = {
			narratorId: OWNER,
			conversationId: "recovery-conversation",
			model: "codex:gpt-5.5",
			provider: "codex",
			cwd: process.cwd(),
			signal: controller.signal,
			onToolExecutionStarting: async (_id, binding) => binding,
			onToolExecutionFinalAuthorization: async () => ({ assertStillCurrent() {} }),
			permissionHandler: (name, input, useId, options) => {
				if (options) {
					const original = options.onAwaitingUserDecision;
					options.onAwaitingUserDecision = () => {
						original?.();
						ready.resolve();
					};
				}
				return handlePermission(
					OWNER,
					controller.signal,
					name,
					input,
					useId,
					process.cwd(),
					"en",
					undefined,
					options,
				);
			},
		};
		const result = executePersistedToolAfterReflections(
			{ name: "RecoveryProbe", input: { value: 42 }, toolUseId: USE },
			config,
			[],
			{
				toolCallBinding: { toolCallId: ID, attempt: 1 },
				preGrantedPermission: { behavior: "allow" },
				recoveryGate: gate,
			},
		);
		await Promise.race([
			ready.promise,
			result.then((value) => {
				throw new Error(`Recovery returned before its user gate: ${value.output}`);
			}),
		]);
		expect(executions).toBe(0);
		expect(pendingPermissions.has(ID)).toBe(true);
		await resolvePermission(ID, "allow");
		expect((await result).output).toBe("approved execution");
		expect(executions).toBe(1);
	});
	test("automatic danger recovery uses the loop runner and fails closed when its provider fails", async () => {
		await seed();
		let executions = 0;
		toolRegistry.register({
			name: "RecoveryProbe",
			description: "recovery test",
			parameters: z.object({ value: z.number() }),
			execute: async () => {
				executions++;
				return { output: "unexpected execution" };
			},
		});
		const beforeStarts = reflectionStarts;
		const config: AgentConfig = {
			narratorId: OWNER,
			conversationId: "recovery-conversation",
			model: "codex:gpt-5.5",
			provider: "codex",
			cwd: process.cwd(),
			signal: controller.signal,
			onToolExecutionStarting: async (_id, binding) => binding,
			onToolExecutionFinalAuthorization: async () => ({ assertStillCurrent() {} }),
			permissionHandler: (name, input, useId, options) =>
				handlePermission(
					OWNER,
					controller.signal,
					name,
					input,
					useId,
					process.cwd(),
					"en",
					undefined,
					options,
				),
		};
		const result = await executePersistedToolAfterReflections(
			{ name: "RecoveryProbe", input: { value: 42 }, toolUseId: USE },
			config,
			[],
			{
				toolCallBinding: { toolCallId: ID, attempt: 1 },
				recoveryGate: {
					...gate,
					permissionSuggestions: [
						{
							type: "danger_reflection",
							status: "running",
							requestId: ID,
							fingerprint: "original-fingerprint",
							danger: {
								severity: "high",
								summary: "Original warning",
								consequences: [],
								saferAlternatives: [],
							},
						},
					],
				},
			},
		);
		expect(reflectionStarts).toBeGreaterThan(beforeStarts);
		expect(result.isError).toBe(true);
		expect(result.output).not.toContain("unresolved dangerReflection");
		expect(executions).toBe(0);
		expect(pendingDangerReflections.has(ID)).toBe(false);
	});

	test("manual pending cannot become auto-approved after policy changes to bypass", async () => {
		await seed();
		const { result, ready } = request(gate);
		await ready;
		expect(pendingPermissions.get(ID)?.input).toEqual({ value: 42 });
		const row = await db.query.narratorToolCalls.findFirst({ where: eq(narratorToolCalls.id, ID) });
		expect(row?.status).toBe("pending");
		expect(row?.permissionDecidedAt).toBeNull();
		await resolvePermission(ID, "deny");
		expect((await result).behavior).toBe("deny");
	});

	test("awaiting_user danger restores the same registry identity without running AI", async () => {
		await seed();
		const { result, ready } = request({
			...gate,
			permissionSuggestions: [
				{
					type: "danger_reflection",
					status: "awaiting_user",
					requestId: ID,
					fingerprint: "original-fingerprint",
					danger: {
						severity: "high",
						summary: "Original warning",
						consequences: [],
						saferAlternatives: [],
					},
				},
			],
		});
		await ready;
		const pause = await result;
		expect(pause.behavior).toBe("dangerReflection");
		expect(pendingDangerReflections.get(ID)?.reflectionStoppedByUser).toBe(true);
		expect(pendingDangerReflections.get(ID)?.fingerprint).toBe("original-fingerprint");
		await cancelDangerReflection(ID, "human denied", "user");
		if (pause.behavior === "dangerReflection") expect((await pause.decision).behavior).toBe("deny");
	});

	test("restored task identity and start time remain human-owned", async () => {
		await seed();
		const originalTime = "2025-01-02T03:04:05.000Z";
		const decision = createTaskReflectionDecision(ID, {
			narratorId: OWNER,
			broadcastTargetId: OWNER,
			toolUseId: USE,
			toolName: "Write",
			inputJson: {},
			mutations: [],
			toolCallId: ID,
			restoredStartedAt: originalTime,
		});
		await takeOverTaskReflection(ID, "Restored wait");
		expect(getTaskReflectionAwaitingUser(ID)?.startedAt).toBe(Date.parse(originalTime));
		expect(
			await confirmTaskReflection(ID, "adequate evidence for this task", undefined, "reflection"),
		).toBe(false);
		expect(
			await confirmTaskReflection(ID, "user confirmed this persisted task", undefined, "user"),
		).toBe(true);
		expect((await decision).action).toBe("confirm");
	});

	test("already-started recovery is refused before admission or permission", async () => {
		const handler = mock(async () => ({ behavior: "allow" as const }));
		const result = await executePersistedToolAfterReflections(
			{ name: "RecoveryProbe", input: {}, toolUseId: USE },
			{
				narratorId: OWNER,
				conversationId: "recovery-conversation",
				model: "codex:gpt-5.5",
				provider: "codex",
				cwd: process.cwd(),
				signal: controller.signal,
				permissionHandler: handler,
			},
			[],
			{ recoveryGate: { ...gate, executionStartedAt: new Date().toISOString() } },
		);
		expect(result.isError).toBe(true);
		expect(handler).not.toHaveBeenCalled();
	});

	test("metadata is call-local and terminal or automatic gates are not human permissions", () => {
		const one: PermissionHandlerOptions = {};
		const two: PermissionHandlerOptions = {};
		bindPermissionRecovery(one, gate);
		expect(getPermissionRecovery(one)).toBe(gate);
		expect(getPermissionRecovery(two)).toBeUndefined();
		expect(isRecoveredHumanPermission(gate)).toBe(true);
		expect(isRecoveredHumanPermission({ ...gate, permissionDecidedAt: "approved" })).toBe(false);
		const automatic = {
			...gate,
			permissionSuggestions: [{ type: "plan_reflection", status: "running" }],
		};
		expect(recoveryReflection(automatic)?.type).toBe("plan_reflection");
		expect(isRecoveredHumanPermission(automatic)).toBe(false);
	});
});
