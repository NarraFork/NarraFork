/**
 * Reflecting on a plan that is ALREADY blocked on its approval card.
 *
 * The loop's own gate runs before the permission is raised; once the plan waits, the only way to
 * review it is the runner that loop published for the length of the wait. These cases pin the
 * decision mapping this new path adds — approve on confirm, send the feedback back to the model
 * on revise, and leave the card with the person when the review cannot decide — because those
 * are the outcomes a person sees instead of their own approve/deny click.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestDb } from "../../../tests/setup";
import { narratorMessages, narrators, narratorToolCalls } from "../../db/schema";
import type { PermissionResult } from "../../lib/agent";
import type { PendingPlanReflectionGateResult } from "../../lib/agent/pending-plan-reflection";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
const realNarratorWsModule = { ...(await import("../../websocket/narrator-ws")) };
const realNarratorServiceModule = { ...(await import("../narrator-service")) };

mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const broadcasts: Array<{ target: string; message: Record<string, unknown> }> = [];
mock.module("../../websocket/narrator-ws", () => ({
	...realNarratorWsModule,
	broadcastToNarrator: (narratorId: string, message: Record<string, unknown>) => {
		broadcasts.push({ target: narratorId, message });
	},
}));
mock.module("../narrator-service", () => ({
	...realNarratorServiceModule,
	narratorService: {
		...realNarratorServiceModule.narratorService,
		updateStatus: async () => {},
	},
}));

const {
	isPendingPlanReflectionAvailable,
	reflectPendingExitPlanMode,
	startAutomaticPlanReflectionForNarrator,
} = await import("../narrator-permission");
const { pendingPermissions, pendingPlanApproverSource, pendingPlanCompact } = await import(
	"../narrator-session-state"
);
const {
	cleanupExitPlanReflection,
	confirmExitPlanReflection,
	createExitPlanReflectionDecision,
	handOverExitPlanReflection,
	markExitPlanReflectionStarted,
} = await import("../../lib/agent/tools/exit-plan-reflection");

const NARRATOR_ID = "plan-reflection-pending-narrator";
const MESSAGE_ID = "plan-reflection-pending-message";
const TOOL_CALL_ID = "plan-reflection-pending-tool-call";
const TOOL_USE_ID = "plan-reflection-pending-tool-use";

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWsModule);
	mock.module("../narrator-service", () => realNarratorServiceModule);
	mock.restore();
});

beforeEach(async () => {
	broadcasts.length = 0;
	pendingPlanApproverSource.delete(NARRATOR_ID);
	pendingPlanCompact.delete(NARRATOR_ID);
	await db.delete(narratorToolCalls).where(eq(narratorToolCalls.id, TOOL_CALL_ID));
	await db.delete(narratorMessages).where(eq(narratorMessages.id, MESSAGE_ID));
	await db.delete(narrators).where(eq(narrators.id, NARRATOR_ID));
	await db.insert(narrators).values({
		id: NARRATOR_ID,
		permissionMode: "bypassPermissions",
		planReflectionAutoApproveOverride: "on",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	});
	await db.insert(narratorMessages).values({
		id: MESSAGE_ID,
		narratorId: NARRATOR_ID,
		role: "assistant",
		contentJson: [],
		createdAt: "2026-01-01T00:00:00.000Z",
	});
	await db.insert(narratorToolCalls).values({
		id: TOOL_CALL_ID,
		narratorId: NARRATOR_ID,
		messageId: MESSAGE_ID,
		toolUseId: TOOL_USE_ID,
		toolName: "ExitPlanMode",
		status: "pending",
		inputJson: { plan: "Add the regression test, then run it." },
		createdAt: "2026-01-01T00:00:00.000Z",
	});
});

afterEach(() => {
	pendingPermissions.delete(TOOL_CALL_ID);
});

const PLAN_INPUT = { plan: "Add the regression test, then run it." };

interface PendingFixture {
	resolved: PermissionResult[];
	setRunner: (
		run: (input: Record<string, unknown>) => Promise<PendingPlanReflectionGateResult>,
	) => void;
}

function registerPending(): PendingFixture {
	const resolved: PermissionResult[] = [];
	const controller = new AbortController();
	let runner: (input: Record<string, unknown>) => Promise<PendingPlanReflectionGateResult> =
		async () => ({
			decision: { action: "manual" },
			input: PLAN_INPUT,
		});
	pendingPermissions.set(TOOL_CALL_ID, {
		resolve: (result) => resolved.push(result),
		cleanup: () => pendingPermissions.delete(TOOL_CALL_ID),
		input: PLAN_INPUT,
		narratorId: NARRATOR_ID,
		toolName: "ExitPlanMode",
		toolUseId: TOOL_USE_ID,
		broadcastTargetId: NARRATOR_ID,
		cwd: "/tmp",
		locale: "en",
		signal: controller.signal,
		planReflection: (input) => runner(input),
	});
	return {
		resolved,
		setRunner: (run) => {
			runner = run;
		},
	};
}

async function toolCallRow() {
	return db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.id, TOOL_CALL_ID),
		columns: {
			status: true,
			permissionDecidedBy: true,
			permissionDenyMessage: true,
			permissionSuggestions: true,
			permissionDecisionReason: true,
		},
	});
}

describe("reflecting on a pending plan approval", () => {
	test("reports availability only while a runner is attached", () => {
		expect(isPendingPlanReflectionAvailable(TOOL_CALL_ID)).toBe(false);
		registerPending();
		expect(isPendingPlanReflectionAvailable(TOOL_CALL_ID)).toBe(true);
	});

	test("confirm approves the waiting plan and attributes the approval to the reflection", async () => {
		const fixture = registerPending();
		fixture.setRunner(async () => ({
			decision: { action: "confirm", reflection: "Ready" },
			input: PLAN_INPUT,
		}));
		const outcome = await reflectPendingExitPlanMode(TOOL_CALL_ID);
		expect(outcome).toEqual({ status: "approved", decision: "confirm" });
		expect(fixture.resolved).toEqual([{ behavior: "allow", updatedInput: PLAN_INPUT }]);
		expect(pendingPlanApproverSource.get(NARRATOR_ID)).toBe("reflection");
		const row = await toolCallRow();
		expect(row?.status).toBe("running");
		expect(row?.permissionDecidedBy).toBe("reflection");
	});

	test("confirm_compact also arms the post-approval context reset", async () => {
		const fixture = registerPending();
		fixture.setRunner(async () => ({
			decision: { action: "confirm_compact", reflection: "Ready" },
			input: PLAN_INPUT,
		}));
		const outcome = await reflectPendingExitPlanMode(TOOL_CALL_ID);
		expect(outcome).toEqual({ status: "approved", decision: "confirm_compact" });
		expect(pendingPlanCompact.has(NARRATOR_ID)).toBe(true);
	});

	test("revise denies the plan with the review's feedback, which the model must act on", async () => {
		const fixture = registerPending();
		fixture.setRunner(async () => ({
			decision: { action: "revise", feedback: "Split step 3 into two steps." },
			input: PLAN_INPUT,
		}));
		const outcome = await reflectPendingExitPlanMode(TOOL_CALL_ID);
		expect(outcome).toEqual({ status: "revising" });
		expect(fixture.resolved).toHaveLength(1);
		const denial = fixture.resolved[0];
		expect(denial.behavior).toBe("deny");
		if (denial.behavior !== "deny") throw new Error("Expected a denial");
		expect(denial.message).toContain("Split step 3 into two steps.");
		expect(denial.rawMessage).toBe(true);
		const row = await toolCallRow();
		expect(row?.status).toBe("fail");
		expect(row?.permissionDecidedBy).toBe("reflection");
	});

	test("an undecidable review leaves the approval with the person", async () => {
		const fixture = registerPending();
		fixture.setRunner(async () => ({
			decision: { action: "human", reason: "Plan reflection could not finish" },
			input: PLAN_INPUT,
		}));
		const outcome = await reflectPendingExitPlanMode(TOOL_CALL_ID);
		expect(outcome).toEqual({
			status: "awaiting_user",
			reason: "Plan reflection could not finish",
		});
		expect(fixture.resolved).toHaveLength(0);
		expect(pendingPermissions.has(TOOL_CALL_ID)).toBe(true);
		const row = await toolCallRow();
		expect(row?.status).toBe("pending");
	});

	test("a request with no runner is not reflectable", async () => {
		pendingPermissions.set(TOOL_CALL_ID, {
			resolve: () => {},
			cleanup: () => pendingPermissions.delete(TOOL_CALL_ID),
			input: PLAN_INPUT,
			narratorId: NARRATOR_ID,
			toolName: "ExitPlanMode",
			toolUseId: TOOL_USE_ID,
			broadcastTargetId: NARRATOR_ID,
			cwd: "/tmp",
			locale: "en",
			signal: new AbortController().signal,
		});
		expect(isPendingPlanReflectionAvailable(TOOL_CALL_ID)).toBe(false);
		const outcome = await reflectPendingExitPlanMode(TOOL_CALL_ID);
		expect(outcome.status).toBe("unavailable");
	});

	test("the automatic path follows the permission-mode gate", async () => {
		const fixture = registerPending();
		let calls = 0;
		fixture.setRunner(async () => {
			calls += 1;
			return { decision: { action: "confirm" }, input: PLAN_INPUT };
		});
		// `default` is not one of the modes the loop reflects in, so turning the switch on must
		// not silently approve the plan either.
		await db
			.update(narrators)
			.set({ permissionMode: "default" })
			.where(eq(narrators.id, NARRATOR_ID));
		const blocked = await reflectPendingExitPlanMode(TOOL_CALL_ID, { automatic: true });
		expect(blocked.status).toBe("unavailable");
		expect(calls).toBe(0);
		expect(isPendingPlanReflectionAvailable(TOOL_CALL_ID)).toBe(true);
	});

	test("a manual start during the automatic path's mode check does not run a second review", async () => {
		const fixture = registerPending();
		let calls = 0;
		let release: (() => void) | undefined;
		fixture.setRunner(async () => {
			calls += 1;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { decision: { action: "human", reason: "handed back" }, input: PLAN_INPUT };
		});
		// The automatic path awaits a DB read before its review; the click lands in that gap.
		const automatic = reflectPendingExitPlanMode(TOOL_CALL_ID, { automatic: true });
		expect(isPendingPlanReflectionAvailable(TOOL_CALL_ID)).toBe(false);
		const manual = await reflectPendingExitPlanMode(TOOL_CALL_ID);
		expect(manual).toEqual({
			status: "awaiting_user",
			reason: "Plan reflection is already running",
		});
		while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
		release();
		expect(await automatic).toEqual({ status: "awaiting_user", reason: "handed back" });
		expect(calls).toBe(1);
		expect(isPendingPlanReflectionAvailable(TOOL_CALL_ID)).toBe(true);
	});

	test("a verdict never settles a replacement wait registered under the same id", async () => {
		const fixture = registerPending();
		let release: (() => void) | undefined;
		fixture.setRunner(async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { decision: { action: "confirm" }, input: PLAN_INPUT };
		});
		const reflecting = reflectPendingExitPlanMode(TOOL_CALL_ID);
		while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
		// Reprocessing (e.g. a switch to Bypass) re-resolves the plan file into a NEW pending entry
		// under the same tool-call id; the running review never read that version.
		const replacementResolved: PermissionResult[] = [];
		const original = pendingPermissions.get(TOOL_CALL_ID);
		if (!original) throw new Error("Expected the original pending entry");
		original.cleanup();
		pendingPermissions.set(TOOL_CALL_ID, {
			...original,
			input: { plan: "Version B, saved while the review ran." },
			planReflectionRunning: undefined,
			planReflectionAbort: undefined,
			resolve: (result) => replacementResolved.push(result),
		});
		release();
		expect(await reflecting).toEqual({ status: "awaiting_user", reason: "Already resolved" });
		expect(replacementResolved).toHaveLength(0);
		expect(fixture.resolved).toHaveLength(0);
		expect(pendingPermissions.has(TOOL_CALL_ID)).toBe(true);
		expect(pendingPlanApproverSource.has(NARRATOR_ID)).toBe(false);
	});

	test("a verdict is dropped when its initiator lost write access during the review", async () => {
		for (const decision of [
			{ action: "confirm" as const, reflection: "Ready" },
			{ action: "revise" as const, feedback: "Split step 3." },
		]) {
			const fixture = registerPending();
			fixture.setRunner(async () => ({ decision, input: PLAN_INPUT }));
			let checks = 0;
			const outcome = await reflectPendingExitPlanMode(TOOL_CALL_ID, {
				assertStillAllowed: async () => {
					checks += 1;
					throw new Error("Narrator not found");
				},
			});
			expect(outcome).toEqual({
				status: "awaiting_user",
				reason: "The person who started this reflection may no longer decide it",
			});
			expect(checks).toBe(1);
			// Nothing was decided: the plan stays with whoever may still decide it.
			expect(fixture.resolved).toHaveLength(0);
			expect(pendingPermissions.has(TOOL_CALL_ID)).toBe(true);
			expect(pendingPlanApproverSource.has(NARRATOR_ID)).toBe(false);
			expect((await toolCallRow())?.status).toBe("pending");
			expect(isPendingPlanReflectionAvailable(TOOL_CALL_ID)).toBe(true);
			pendingPermissions.delete(TOOL_CALL_ID);
		}
	});

	test("an initiator who keeps write access gets the verdict applied", async () => {
		const fixture = registerPending();
		fixture.setRunner(async () => ({ decision: { action: "confirm" }, input: PLAN_INPUT }));
		let checks = 0;
		const outcome = await reflectPendingExitPlanMode(TOOL_CALL_ID, {
			assertStillAllowed: async () => {
				checks += 1;
			},
		});
		expect(outcome).toEqual({ status: "approved", decision: "confirm" });
		expect(checks).toBe(1);
		expect(fixture.resolved).toEqual([{ behavior: "allow", updatedInput: PLAN_INPUT }]);
	});

	test("turning the switch on reflects every blocked plan of the session", async () => {
		const fixture = registerPending();
		let calls = 0;
		let started: (() => void) | undefined;
		const ran = new Promise<void>((resolve) => {
			started = resolve;
		});
		fixture.setRunner(async () => {
			calls += 1;
			started?.();
			return { decision: { action: "confirm" }, input: PLAN_INPUT };
		});
		expect(startAutomaticPlanReflectionForNarrator(NARRATOR_ID)).toBe(1);
		await ran;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls).toBe(1);
		expect(fixture.resolved).toHaveLength(1);
	});

	test("an on-demand review never writes the person's approval row", async () => {
		// The row is the person's pending approval: the panel hides rows carrying a non-awaiting
		// reflection, and restart recovery reads them as reflection gates. A review started on
		// demand must leave it exactly as the approval wrote it, whatever the review does.
		const meta = {
			narratorId: NARRATOR_ID,
			broadcastTargetId: NARRATOR_ID,
			toolUseId: TOOL_USE_ID,
			toolName: "ExitPlanMode",
			inputJson: PLAN_INPUT,
			toolCallId: TOOL_CALL_ID,
			onDemand: true,
		};
		const started = createExitPlanReflectionDecision("exit_plan_on_demand_a", meta);
		expect(await markExitPlanReflectionStarted("exit_plan_on_demand_a")).toBe(true);
		expect(await handOverExitPlanReflection("exit_plan_on_demand_a", { reason: "undecided" })).toBe(
			true,
		);
		expect((await started).action).toBe("human");
		const confirmed = createExitPlanReflectionDecision("exit_plan_on_demand_b", meta);
		await markExitPlanReflectionStarted("exit_plan_on_demand_b");
		expect(await confirmExitPlanReflection("exit_plan_on_demand_b", "Ready")).toBe(true);
		expect((await confirmed).action).toBe("confirm");
		cleanupExitPlanReflection("exit_plan_on_demand_a");
		cleanupExitPlanReflection("exit_plan_on_demand_b");
		const row = await toolCallRow();
		expect(row?.status).toBe("pending");
		expect(row?.permissionSuggestions ?? null).toBeNull();
		expect(row?.permissionDecidedBy ?? null).toBeNull();
		expect(row?.permissionDecisionReason ?? null).toBeNull();
		// Live clients still follow the review.
		expect(broadcasts.map((entry) => entry.message.type)).toEqual(
			expect.arrayContaining(["plan_reflection_started", "plan_reflection_stopped"]),
		);
	});
});
