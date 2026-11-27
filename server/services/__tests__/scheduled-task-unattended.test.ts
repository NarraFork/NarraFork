import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestDb } from "../../../tests/setup";
import { narratorMessages, narrators, narratorToolCalls } from "../../db/schema";
import type { PermissionResult } from "../../lib/agent";
import { localBackend } from "../../lib/agent/execution/registry";
import { appendRuntimePolicyTrait, parseRuntimePolicyTraits } from "../../lib/runtime-policy-trait";
import { settings } from "../../lib/settings";
import { isRuntimeToolAllowed, resolveRuntimePolicy } from "../agent-runtime/policy";
import {
	getUnattendedPermissionMessage,
	listRegisteredScheduledRuns,
	registerScheduledRun,
	type ScheduledRunRegistration,
	UNATTENDED_PERMISSION_MESSAGE,
	unattendedPermissionDecision,
	unregisterScheduledRun,
} from "../scheduled-run-registry";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const realRunService = { ...(await import("../scheduled-task-run-service")) };
const registrations = new Map<string, ScheduledRunRegistration>();
const handled: Array<{ runId: string; reason: string }> = [];
const blocked: Array<{ runId: string; reason: string | null }> = [];
mock.module("../scheduled-task-run-service", () => ({
	...realRunService,
	lookupScheduledRun: async (id: string) => registrations.get(id),
	recordScheduledAutoHandled: async (runId: string, reason: string) => {
		handled.push({ runId, reason });
	},
	markScheduledRunBlocked: async (runId: string, reason: string | null) => {
		blocked.push({ runId, reason });
	},
}));
const realNarratorService = { ...(await import("../narrator-service")) };
mock.module("../narrator-service", () => ({
	...realNarratorService,
	narratorService: { ...realNarratorService.narratorService, updateStatus: async () => {} },
}));
const broadcasts: Array<Record<string, unknown>> = [];
const realWs = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({
	...realWs,
	broadcastToNarrator: (_id: string, message: Record<string, unknown>) => broadcasts.push(message),
}));
const { prepareScheduledTaskSession } = await import("../narrator-session");
const { handlePermission, resolvePermission } = await import("../narrator-permission");
const { pendingPermissions } = await import("../narrator-session-state");
let sequence = 0;
const controllers: AbortController[] = [];

async function request(
	toolName: string,
	options: {
		onBlocked?: "auto" | "wait";
		reportOnly?: boolean;
		requireReport?: boolean;
		input?: Record<string, unknown>;
		runtimeReadOnly?: boolean;
		plan?: boolean;
	} = {},
) {
	const id = `unattended-${++sequence}`;
	const now = new Date().toISOString();
	const input = options.input ?? {};
	await db.insert(narrators).values({
		id,
		permissionMode: "default",
		questionReflectionOverride: "off",
		traits: options.plan ? ["plan"] : [],
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(narratorMessages).values({
		id: `${id}-message`,
		narratorId: id,
		role: "assistant",
		contentJson: [],
		createdAt: now,
	});
	await db.insert(narratorToolCalls).values({
		id: `${id}-call`,
		narratorId: id,
		messageId: `${id}-message`,
		toolUseId: `${id}-use`,
		toolName,
		inputJson: input,
		status: "initializing",
		createdAt: now,
	});
	registrations.set(id, {
		runId: `${id}-run`,
		taskId: `${id}-task`,
		narratorId: id,
		ownerUserId: null,
		onBlocked: options.onBlocked ?? "auto",
		blockedWaitMinutes: 30,
		deadlineAt: null,
		permissionMode: "default",
		modelPolicy: "follow",
		model: null,
		reportOnly: options.reportOnly,
		requireReport: options.requireReport,
	});
	const controller = new AbortController();
	controllers.push(controller);
	const result = handlePermission(
		id,
		controller.signal,
		toolName,
		input,
		`${id}-use`,
		process.cwd(),
		"en",
		undefined,
		toolName === "ExitPlanMode"
			? {
					executionBackend: localBackend,
					executionTarget: {
						deviceId: localBackend.deviceId,
						backendKind: localBackend.kind,
						cwd: process.cwd(),
						pathFlavor: localBackend.pathFlavor ?? localBackend.paths.flavor,
						runtimeGeneration: localBackend.runtimeGeneration ?? 0,
						selectionSource: "local_default",
					},
				}
			: undefined,
		undefined,
		options.runtimeReadOnly
			? { permissionMode: "readOnly", allowKnowledgeWrite: false }
			: undefined,
	);
	return { id, result, controller };
}

async function waitForPending(id: string, result: Promise<PermissionResult>) {
	let completed = false;
	void result.then(() => {
		completed = true;
	});
	const deadline = Date.now() + 2000;
	while (!pendingPermissions.has(`${id}-call`) && !completed && Date.now() < deadline)
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	expect(completed).toBe(false);
	expect(pendingPermissions.has(`${id}-call`)).toBe(true);
}

afterEach(async () => {
	for (const controller of controllers.splice(0)) controller.abort();
	registrations.clear();
	for (const run of listRegisteredScheduledRuns()) unregisterScheduledRun(run.runId);
	broadcasts.length = 0;
	handled.length = 0;
	blocked.length = 0;
	await db.delete(narratorToolCalls);
	await db.delete(narratorMessages);
	await db.delete(narrators);
});
afterAll(() => sqlite.close());

describe("unattended permission narrowing", () => {
	test("permission guidance preserves the legacy default and makes reporting optional", () => {
		expect(getUnattendedPermissionMessage()).toBe(UNATTENDED_PERMISSION_MESSAGE);
		expect(getUnattendedPermissionMessage()).toContain("ScheduledTaskReport");
		expect(getUnattendedPermissionMessage(false)).not.toContain("ScheduledTaskReport");
		expect(getUnattendedPermissionMessage(false)).toContain("final response");
	});

	test("optional-report runs deny interactive approval without demanding a report tool", async () => {
		for (const toolName of ["AskUserQuestion", "CustomMutation"]) {
			const { result } = await request(toolName, { requireReport: false });
			expect(await result).toMatchObject({
				behavior: "deny",
				message: expect.stringContaining(getUnattendedPermissionMessage(false)),
			});
		}
		const report = await request("ScheduledTaskReport", {
			requireReport: false,
			runtimeReadOnly: true,
			input: { outcome: "no_change" },
		});
		expect((await report.result).behavior).toBe("allow");
		expect(pendingPermissions.size).toBe(0);
	});

	test("auto mode rejects synchronous/async questions and entering plan before an early allow", async () => {
		for (const toolName of ["AskUserQuestion", "Ask", "EnterPlanMode"]) {
			const { result } = await request(toolName, { input: { async: true } });
			expect((await result).behavior).toBe("deny");
		}
		const synchronous = await request("AskUserQuestion", { input: { async: false } });
		expect((await synchronous.result).behavior).toBe("deny");
		expect(pendingPermissions.size).toBe(0);
		expect(handled.map((item) => item.reason)).toEqual([
			"question",
			"question",
			"plan",
			"question",
		]);
		// A malformed routed request is denied even earlier, never elevated by auto.
		const rule = await request("RequestPermissionRule");
		expect((await rule.result).behavior).toBe("deny");
	});

	test("auto mode refuses an ordinary permission ask instead of waiting for a person", async () => {
		const { result } = await request("CustomMutation");
		expect(await result).toMatchObject({
			behavior: "deny",
			message: expect.stringContaining("unattended"),
		});
		expect(pendingPermissions.size).toBe(0);
	});

	test("wait mode retains the actual approval promise and marks the run blocked", async () => {
		const { id, result } = await request("CustomMutation", { onBlocked: "wait" });
		await waitForPending(id, result);
		expect(blocked).toEqual([{ runId: `${id}-run`, reason: "permission" }]);
		expect(await resolvePermission(`${id}-call`, "deny")).toBe(true);
		expect((await result).behavior).toBe("deny");
	});

	test("report-only reminder refuses business tools even when they would otherwise auto-allow", async () => {
		for (const toolName of ["TeamStatus", "Send", "CustomMutation"]) {
			const { result } = await request(toolName, { reportOnly: true });
			expect(await result).toMatchObject({
				behavior: "deny",
				message: expect.stringContaining("only call ScheduledTaskReport"),
			});
		}
		const { result } = await request("ScheduledTaskReport", {
			reportOnly: true,
			input: { outcome: "no_change" },
		});
		expect((await result).behavior).toBe("allow");
	});

	test("runtime read-only ceilings still deny mutations while allowing bound self-report", async () => {
		const mutation = await request("CustomMutation", { runtimeReadOnly: true });
		expect((await mutation.result).behavior).toBe("deny");
		const report = await request("ScheduledTaskReport", {
			runtimeReadOnly: true,
			input: { outcome: "no_change" },
		});
		expect((await report.result).behavior).toBe("allow");
	});

	test("an existing valid plan can auto-approve, but not through a runtime read-only ceiling", async () => {
		const previous = settings.agent.planModeAllowInlinePlan;
		settings.agent.planModeAllowInlinePlan = true;
		try {
			const input = {
				mode: "inline",
				inline_plan: "Inspect the existing code and report the findings without changes.",
			};
			const allowed = await request("ExitPlanMode", { plan: true, input });
			expect((await allowed.result).behavior).toBe("allow");
			const restricted = await request("ExitPlanMode", {
				plan: true,
				input,
				runtimeReadOnly: true,
			});
			expect((await restricted.result).behavior).toBe("deny");
			expect(pendingPermissions.size).toBe(0);
		} finally {
			settings.agent.planModeAllowInlinePlan = previous;
		}
	});

	test("existing plan approval only narrows asks and never replaces denies/fatal decisions", () => {
		for (const decision of ["deny", "fatal"] as const) {
			expect(
				unattendedPermissionDecision({
					onBlocked: "auto",
					toolName: "ExitPlanMode",
					isPlanMode: true,
					decision,
				}),
			).toBeUndefined();
		}
		expect(
			unattendedPermissionDecision({
				onBlocked: "auto",
				toolName: "ExitPlanMode",
				isPlanMode: true,
				decision: "ask",
			}),
		).toBe("allow");
		expect(
			unattendedPermissionDecision({
				onBlocked: "auto",
				toolName: "ExitPlanMode",
				isPlanMode: false,
				decision: "ask",
			}),
		).toBe("deny");
		expect(
			unattendedPermissionDecision({
				onBlocked: "wait",
				toolName: "ExitPlanMode",
				isPlanMode: true,
				decision: "ask",
			}),
		).toBeUndefined();
		expect(
			unattendedPermissionDecision({ onBlocked: "auto", toolName: "Read", decision: "allow" }),
		).toBeUndefined();
	});
});

async function configuration(overrides: Partial<ScheduledRunRegistration> = {}) {
	const { id, result } = await request("ScheduledTaskReport");
	await result;
	const registered = registrations.get(id);
	if (!registered) throw new Error("Expected the fixture registration");
	const traits = appendRuntimePolicyTrait(["standalone", "plan"], {
		version: 1,
		readOnly: true,
		deny: ["planApproval", "spawnAgent"],
	});
	await db
		.update(narrators)
		.set({
			permissionMode: "readOnly",
			systemPrompt: "old human prompt",
			model: "saved:model",
			traits,
			planMode: true,
			previousPermissionMode: "default",
			planFileId: "old-plan",
			runtimeRegistrationJson: { version: 1 },
		})
		.where(eq(narrators.id, id));
	const registration = registerScheduledRun({
		...registered,
		permissionMode: "bypassPermissions",
		modelPolicy: "follow",
		systemPrompt: "task prompt",
		...overrides,
	});
	return {
		registration,
		input: { narratorId: id, runId: registration.runId, userId: null },
		traits,
	};
}

describe("scheduled session configuration", () => {
	test("business dispatch synchronizes prompt and soft permissions without lifting hard ceilings", async () => {
		const { input, traits, registration } = await configuration();
		await prepareScheduledTaskSession(input);
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, input.narratorId) });
		expect(row?.permissionMode).toBe("bypassPermissions");
		expect(row?.systemPrompt).toBe("task prompt");
		expect(row?.model).toBe("saved:model");
		expect(row?.traits).toEqual(traits.filter((trait) => trait !== "plan"));
		expect(row?.planMode).toBe(false);
		expect(row?.planFileId).toBeNull();
		expect(row?.previousPermissionMode).toBeNull();
		expect(row?.runtimeRegistrationJson).toEqual({ version: 1 });
		const policy = resolveRuntimePolicy(parseRuntimePolicyTraits(row?.traits));
		expect(isRuntimeToolAllowed(policy, "Write")).toBe(false);
		expect(policy.capabilities.planApproval).toBe(false);
		expect(policy.capabilities.spawnAgent).toBe(false);
		expect(broadcasts).toContainEqual({
			type: "permission_mode_changed",
			narratorId: input.narratorId,
			permissionMode: "bypassPermissions",
		});
		expect(
			broadcasts.some((event) => event.type === "plan_mode_changed" && event.planMode === false),
		).toBe(true);
		registration.systemPrompt = null;
		await prepareScheduledTaskSession(input);
		expect(
			(await db.query.narrators.findFirst({ where: eq(narrators.id, input.narratorId) }))
				?.systemPrompt,
		).toBeNull();
	});

	test("follow and temporary preserve the saved model; sync changes it without a restore write", async () => {
		for (const modelPolicy of ["follow", "temporary", "sync"] as const) {
			const { input } = await configuration({ modelPolicy, model: "task:chosen" });
			await prepareScheduledTaskSession(input);
			const row = await db.query.narrators.findFirst({ where: eq(narrators.id, input.narratorId) });
			expect(row?.model).toBe(modelPolicy === "sync" ? "task:chosen" : "saved:model");
		}
	});

	test("a reporting reminder does not resynchronize any business configuration", async () => {
		const { input, registration, traits } = await configuration({
			modelPolicy: "sync",
			model: "task:chosen",
		});
		await prepareScheduledTaskSession({ ...input, nudge: true });
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, input.narratorId) });
		expect(row?.permissionMode).toBe("readOnly");
		expect(row?.systemPrompt).toBe("old human prompt");
		expect(row?.model).toBe("saved:model");
		expect(row?.traits).toEqual(traits);
		expect(registration.reportOnly).toBe(true);
	});
});
