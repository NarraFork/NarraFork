import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import {
	buildReflectionNoticeData,
	getReflectionSuggestion,
	reflectionTitleKeyPrefix,
	reflectionTitleKeySuffix,
} from "@shared/pretext-layout/reflection";
import { eq } from "drizzle-orm";
import { reflectionResolvedStatus } from "../../../frontend/components/narrator/vlist/vlist-live-events";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorMessages, narrators, narratorToolCalls } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
const realWsModule = { ...(await import("../../websocket/narrator-ws")) };
const realServiceModule = { ...(await import("../narrator-service")) };
const broadcasts: Array<{ target: string; message: Record<string, unknown> }> = [];
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
mock.module("../../websocket/narrator-ws", () => ({
	...realWsModule,
	broadcastToNarrator: (target: string, message: Record<string, unknown>) => {
		broadcasts.push({ target, message });
	},
}));
mock.module("../narrator-service", () => ({
	...realServiceModule,
	narratorService: { ...realServiceModule.narratorService, updateStatus: async () => {} },
}));
const {
	cancelExitPlanReflection,
	cleanupExitPlanReflection,
	createExitPlanReflectionDecision,
	getExitPlanReflectionNarratorId,
	markExitPlanReflectionStarted,
} = await import("../../lib/agent/tools/exit-plan-reflection");
const {
	cleanupTaskReflection,
	createTaskReflectionDecision,
	hasPendingTaskReflection,
	markTaskReflectionStarted,
	reviseTaskReflection,
	takeOverTaskReflection,
} = await import("../../lib/agent/tools/task-reflection");

const OWNER = "reflection-failure-child";
const PARENT = "reflection-failure-parent";
const TOOL_CALL = "reflection-failure-tool";
const TOOL_USE = "reflection-failure-use";
const REQUEST = "reflection-failure-request";
const REASON = "Provider unavailable before a decision could be reached";
const NEXT_STEPS = "Retry the check after the provider recovers";

afterEach(() => {
	cleanupExitPlanReflection(REQUEST);
	cleanupTaskReflection(REQUEST);
	broadcasts.length = 0;
	cleanDb(sqlite);
});
afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realWsModule);
	mock.module("../narrator-service", () => realServiceModule);
	mock.restore();
	sqlite.close();
});

async function seed() {
	const now = new Date().toISOString();
	await db.insert(narrators).values([
		{ id: PARENT, createdAt: now, updatedAt: now },
		{ id: OWNER, parentNarratorId: PARENT, createdAt: now, updatedAt: now },
	]);
	await db.insert(narratorMessages).values({
		id: "reflection-failure-message",
		narratorId: OWNER,
		role: "assistant",
		contentJson: [],
		createdAt: now,
	});
	await db.insert(narratorToolCalls).values({
		id: TOOL_CALL,
		narratorId: OWNER,
		messageId: "reflection-failure-message",
		toolUseId: TOOL_USE,
		toolName: "ExitPlanMode",
		status: "pending",
		createdAt: now,
	});
	// Omit toolCallId to exercise the actual narrator/tool-use lookup too.
	return {
		narratorId: OWNER,
		broadcastTargetId: PARENT,
		parentToolUseId: "reflection-parent-tool",
		toolUseId: TOOL_USE,
		toolName: "ExitPlanMode",
		inputJson: { plan: "test plan" },
	};
}

function notice(suggestions: unknown) {
	expect(Array.isArray(suggestions)).toBe(true);
	const reflection = getReflectionSuggestion(Array.isArray(suggestions) ? suggestions : []);
	expect(reflection).not.toBeNull();
	if (!reflection) throw new Error("Missing reflection suggestion");
	return buildReflectionNoticeData(
		reflection,
		`${reflectionTitleKeyPrefix(reflection.kind)}Reflection${reflectionTitleKeySuffix(reflection.status)}`,
	);
}

describe("plan/task reflection failure persistence and live cards", () => {
	for (const kind of ["plan_reflection", "task_reflection"] as const) {
		for (const failed of [true, false]) {
			test(`${kind}: ${failed ? "system failure" : "ordinary revision"} survives reload and fan-out`, async () => {
				const meta = await seed();
				const decision =
					kind === "plan_reflection"
						? createExitPlanReflectionDecision(REQUEST, meta)
						: createTaskReflectionDecision(REQUEST, { ...meta, mutations: [{ kind: "complete" }] });
				if (kind === "plan_reflection") await markExitPlanReflectionStarted(REQUEST);
				else await markTaskReflectionStarted(REQUEST);
				broadcasts.length = 0;
				const resolved =
					kind === "plan_reflection"
						? await cancelExitPlanReflection(REQUEST, REASON, failed ? { failed: true } : undefined)
						: await reviseTaskReflection(
								REQUEST,
								REASON,
								NEXT_STEPS,
								"reflection",
								failed ? { failed: true } : undefined,
							);
				expect(resolved).toBe(true);
				expect(await decision).toMatchObject({ action: "revise", feedback: REASON });
				expect(getExitPlanReflectionNarratorId(REQUEST)).toBeNull();
				expect(hasPendingTaskReflection(REQUEST)).toBe(false);
				const row = await db.query.narratorToolCalls.findFirst({
					where: eq(narratorToolCalls.id, TOOL_CALL),
				});
				expect(row?.status).toBe("fail");
				expect(row?.permissionDecidedBy).toBeNull();
				expect(row?.permissionDecidedAt).toBeTruthy();
				expect(row?.errorMessage).toContain(REASON);
				const expectedStatus = failed ? "failed" : "cancelled";
				expect(row?.permissionSuggestions).toMatchObject([
					{
						type: kind,
						status: expectedStatus,
						requestId: REQUEST,
						reason: REASON,
						resolvedAt: expect.any(String),
					},
				]);
				const persistedNotice = notice(row?.permissionSuggestions ?? []);
				expect(persistedNotice.title).toBe(
					`${kind === "plan_reflection" ? "plan" : "task"}Reflection${failed ? "Failed" : "Cancelled"}`,
				);
				expect(persistedNotice.summary).toBe(REASON);
				expect(persistedNotice.hasTakeOver).toBeUndefined();
				if (kind === "task_reflection") expect(persistedNotice.nextSteps).toBe(NEXT_STEPS);
				expect(broadcasts.map((entry) => entry.target)).toEqual([OWNER, PARENT]);
				for (const { target, message } of broadcasts) {
					expect(message).toMatchObject({
						type: `${kind}_resolved`,
						decision: failed ? "failed" : "deny",
						reason: REASON,
						ownerNarratorId: OWNER,
					});
					expect(message.parentToolUseId).toBe(
						target === PARENT ? "reflection-parent-tool" : undefined,
					);
					// Apply the production live-card status mapping to the actual broadcast.
					const liveNotice = notice([
						{
							type: kind,
							status: reflectionResolvedStatus(kind, String(message.decision)),
							reason: message.reason,
							nextSteps: message.nextSteps,
							requestId: message.requestId,
						},
					]);
					expect(liveNotice).toEqual(persistedNotice);
				}
			});
		}
	}

	test("manual task revision remains cancelled without granting approval", async () => {
		const meta = await seed();
		const decision = createTaskReflectionDecision(REQUEST, { ...meta, mutations: [] });
		await takeOverTaskReflection(REQUEST);
		expect(await reviseTaskReflection(REQUEST, REASON, NEXT_STEPS)).toBe(false);
		expect(await reviseTaskReflection(REQUEST, REASON, NEXT_STEPS, "user")).toBe(true);
		expect(await decision).toMatchObject({ action: "revise" });
		const row = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, TOOL_CALL),
		});
		expect(row?.permissionDecidedBy).toBeNull();
		expect(notice(row?.permissionSuggestions ?? []).title).toBe("taskReflectionCancelled");
	});
});
