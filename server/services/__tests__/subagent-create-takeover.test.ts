import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
	fileChangeExecutionSegments,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import type { ToolCallBinding } from "../../lib/agent/types";
import { generateId } from "../../lib/id";
import { parseSubstatus } from "../../lib/narrator-utils";
import { settings } from "../../lib/settings";
import * as websocket from "../../websocket/narrator-ws";
import {
	getExecutionOwner,
	getRunControl,
	getRunHold,
	setRunHold,
} from "../agent-runtime/ownership";
import * as completionQueue from "../bg-completion-queue";
import * as passExecutor from "../narrator-executor";
import { narratorService } from "../narrator-service";
import { drainPendingInjections, takePendingInjectionBatch } from "../parent-injection-queue";
import { clearAliasRegistry } from "../subagent-alias";
import { readSubagentExecutionBoundary } from "../subagent-execution-boundary";
import { runSubagent } from "../subagent-runner";

const isTakenOver = (id: string) => !!getRunHold(id);
const clearTakenOver = (id: string) => setRunHold(id, undefined);
/** No run of `id` is live: the run service released its owner. */
const runEnded = (id: string) => !getExecutionOwner(id) && !getRunControl(id);

// tests/preload.ts gives this real DB a temporary NARRAFORK_HOME. Only delete
// rows owned by this fixture; never sweep a shared DB or touch a running service.
const ids: string[] = [];
const MODEL = "anthropic:claude-sonnet-4-20250514";
const originalProviders = settings.anthropicProviders;
const originalDefaultModel = settings.agent.defaultModel;
const originalAllowedModels = settings.agent.subagentAllowedModels;
const broadcasts: Array<{ target: string; event: unknown }> = [];
let parentId: string;
let releaseExecution: (() => void) | undefined;
let activeChildId: string | undefined;
let restoreSpies: Array<() => void> = [];

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for background runner");
		await Bun.sleep(5);
	}
}

beforeEach(async () => {
	parentId = generateId();
	ids.push(parentId);
	broadcasts.length = 0;
	activeChildId = undefined;
	releaseExecution = undefined;
	settings.anthropicProviders = [
		{
			id: "takeover-create-test",
			name: "Test provider (no network)",
			prefix: "anthropic",
			apiKey: "not-a-real-key",
			baseUrl: "https://takeover-create.invalid",
			defaultModel: "claude-sonnet-4-20250514",
		},
	];
	settings.agent.defaultModel = MODEL;
	settings.agent.subagentAllowedModels = { general: [MODEL], explore: [], plan: [] };
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id: parentId,
		type: "primary",
		variant: "primary",
		status: "working",
		model: MODEL,
		cwd: process.env.HOME,
		createdAt: now,
		updatedAt: now,
	});
	const broadcast = spyOn(websocket, "broadcastToNarrator").mockImplementation((target, event) => {
		broadcasts.push({ target, event });
	});
	// Keep normal completion publication real, but do not launch a parent model loop.
	const wake = spyOn(completionQueue, "pushBgCompletionNotification").mockImplementation(() => {});
	const network = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			() => {
				throw new Error("Real model/network access is forbidden in takeover creation tests");
			},
			{ preconnect: () => {} },
		),
	);
	restoreSpies = [
		() => broadcast.mockRestore(),
		() => wake.mockRestore(),
		() => network.mockRestore(),
	];
});

afterEach(async () => {
	// Release even when an assertion failed, then wait for the fire-and-forget
	// runner's finally block before removing its rows or restoring the executor.
	releaseExecution?.();
	if (activeChildId) {
		const child = activeChildId;
		await until(() => runEnded(child));
	}
	for (const restore of restoreSpies.reverse()) restore();
	settings.anthropicProviders = originalProviders;
	settings.agent.defaultModel = originalDefaultModel;
	settings.agent.subagentAllowedModels = originalAllowedModels;
	for (const id of ids) {
		clearTakenOver(id);
		drainPendingInjections(id);
		clearAliasRegistry(id);
	}
	if (ids.length) {
		await db.delete(narratorToolCalls).where(inArray(narratorToolCalls.narratorId, ids));
		await db
			.delete(fileChangeExecutionSegments)
			.where(inArray(fileChangeExecutionSegments.narratorId, ids));
		await db.delete(narratorMessageRefs).where(inArray(narratorMessageRefs.narratorId, ids));
		await db.delete(narratorMessages).where(inArray(narratorMessages.narratorId, ids));
		// Child first: parentNarratorId is a real FK.
		for (const id of [...ids].reverse()) await db.delete(narrators).where(eq(narrators.id, id));
	}
	ids.length = 0;
});

/** A durable v1 receipt for the parent's Agent call, as the live tool executor records it. */
async function insertParentAgentCall(toolUseId: string) {
	const now = new Date().toISOString();
	const callId = generateId();
	const segmentId = generateId();
	const messageId = generateId();
	await db.insert(fileChangeExecutionSegments).values({
		id: segmentId,
		narratorId: parentId,
		sourceToolCallId: callId,
		sourceExecutionAttempt: 1,
		createdAt: now,
	});
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId: parentId,
		role: "assistant",
		contentJson: [],
		createdAt: now,
	});
	await db
		.insert(narratorMessageRefs)
		.values({ id: generateId(), narratorId: parentId, messageId, seq: 1 });
	await db.insert(narratorToolCalls).values({
		id: callId,
		messageId,
		narratorId: parentId,
		toolUseId,
		toolName: "Agent",
		inputJson: {},
		status: "running",
		executionStartedAt: now,
		executionAttempt: 1,
		executionIdentityVersion: 1,
		executionSegmentId: segmentId,
		createdAt: now,
	});
	return { toolCallId: callId, attempt: 1, executionSegmentId: segmentId };
}

async function launch(
	takeoverByUser: boolean,
	outcome: "success" | "error" | "throw",
	parentCall?: { toolUseId: string; toolCallBinding: ToolCallBinding },
) {
	let settle: (() => void) | undefined;
	const held = new Promise<void>((resolve) => {
		settle = resolve;
	});
	releaseExecution = () => settle?.();
	let observedAtStart: { held: boolean; substatus: unknown } | undefined;
	// Only the model pass is simulated; the run service, hold and finalizer are real.
	const execute = spyOn(passExecutor, "executeAgentLoop").mockImplementation(async (options) => {
		activeChildId = options.config.narratorId as string;
		ids.push(activeChildId);
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, activeChildId) });
		observedAtStart = {
			held: isTakenOver(activeChildId),
			substatus: parseSubstatus(row?.substatus),
		};
		await held;
		if (outcome === "throw") throw new Error("Simulated initial execution exception");
		return {
			finalText: outcome === "error" ? "Simulated initial turn error" : "Initial turn completed",
			hasError: outcome === "error",
			shouldUpdateTitle: false,
			completedNaturally: outcome === "success",
			completedAssistantTurn: outcome === "success",
		};
	});
	restoreSpies.push(() => execute.mockRestore());

	// Promise timeout proves creation is non-blocking while the executor is held.
	// takeover deliberately omits background: true: creation must force it.
	let timer: ReturnType<typeof setTimeout> | undefined;
	const output = await Promise.race([
		runSubagent({
			parentNarratorId: parentId,
			toolUseId: parentCall?.toolUseId ?? generateId(),
			...(parentCall ? { toolCallBinding: parentCall.toolCallBinding } : {}),
			subagentType: "general",
			prompt: "Initial prompt must execute without waiting for user input",
			cwd: process.env.HOME as string,
			title: "Creation takeover regression",
			model: MODEL,
			locale: "en",
			signal: new AbortController().signal,
			...(takeoverByUser ? { takeoverByUser: true } : { background: true }),
		}),
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("Creation blocked on initial execution")), 2_000);
		}),
	]).finally(() => clearTimeout(timer));
	await until(() => observedAtStart !== undefined);
	expect(execute).toHaveBeenCalledTimes(1);
	expect(output).toContain("<background_task_id>creation-takeover-regression</background_task_id>");
	expect(output).toContain(`[Creation takeover regression](nf-agent://open?id=${activeChildId})`);
	expect(output).not.toContain("nf-agent://open?id=creation-takeover-regression");
	return { output, observedAtStart, childId: activeChildId as string };
}

describe("Agent creation in user takeover mode", () => {
	for (const outcome of ["success", "error", "throw"] as const) {
		test(`initial ${outcome} parks idle[taken_over] without parent completion`, async () => {
			const { output, observedAtStart, childId } = await launch(true, outcome);
			// The hold exists before the first turn starts.
			expect(observedAtStart?.held).toBe(true);
			expect(observedAtStart?.substatus).toContain("taken_over");
			expect(output).toMatch(/user takeover/i);
			expect(output).not.toContain("Await({");
			expect(broadcasts).toContainEqual({
				target: parentId,
				event: expect.objectContaining({
					type: "subagent_takeover_changed",
					subagentNarratorId: childId,
					takenOver: true,
				}),
			});
			const running = await db.query.narrators.findFirst({ where: eq(narrators.id, childId) });
			expect(running?.isBackground).toBe(true);
			expect(running?.backgroundStatus).toBe("running");
			expect(running?.traits).toContain("background");

			releaseExecution?.();
			// The first turn ends (whatever its outcome) and the same run parks at its
			// hold: owner retained, nothing delivered to the caller.
			await until(async () => {
				const row = await db.query.narrators.findFirst({ where: eq(narrators.id, childId) });
				return row?.status === "idle" && !!getRunControl(childId)?.wake;
			});
			const idle = await db.query.narrators.findFirst({ where: eq(narrators.id, childId) });
			const tags = parseSubstatus(idle?.substatus);
			expect(tags).toEqual(["taken_over"]);
			expect(idle?.backgroundStatus).toBe("running");
			expect(idle?.backgroundResult).toBeNull();
			expect(isTakenOver(childId)).toBe(true);
			expect(await takePendingInjectionBatch(parentId)).toBeNull();
			expect(completionQueue.pushBgCompletionNotification).not.toHaveBeenCalled();
			// Ending the parked run (the hold's cancellation) lets afterEach observe it end.
			const { controlRun } = await import("../agent-runtime/run");
			await controlRun(childId, { kind: "cancel", reason: "test cleanup" });
		});
	}

	test("failed takeover startup clears the hold and cancels the unmounted task", async () => {
		let failedChildId: string | undefined;
		const addSubstatus = spyOn(narratorService, "addSubstatus").mockImplementation(async (id) => {
			failedChildId = id;
			ids.push(id);
			throw new Error("Simulated takeover persistence failure");
		});
		const execute = spyOn(passExecutor, "executeAgentLoop");
		restoreSpies.push(
			() => addSubstatus.mockRestore(),
			() => execute.mockRestore(),
		);
		await expect(
			runSubagent({
				parentNarratorId: parentId,
				toolUseId: generateId(),
				subagentType: "general",
				prompt: "Must not execute when takeover setup fails",
				cwd: process.env.HOME as string,
				model: MODEL,
				locale: "en",
				signal: new AbortController().signal,
				takeoverByUser: true,
			}),
		).rejects.toThrow("Simulated takeover persistence failure");
		expect(failedChildId).toBeDefined();
		const childId = failedChildId as string;
		expect(isTakenOver(childId)).toBe(false);
		expect(getExecutionOwner(childId)).toBeUndefined();
		expect(execute).not.toHaveBeenCalled();
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, childId) });
		expect(row?.status).toBe("idle");
		expect(row?.backgroundStatus).toBe("cancelled");
		expect(parseSubstatus(row?.substatus)).not.toContain("taken_over");
		expect(completionQueue.pushBgCompletionNotification).not.toHaveBeenCalled();
		expect(await takePendingInjectionBatch(parentId)).toBeNull();
	});

	test("ordinary background creation still completes and publishes a parent notice", async () => {
		const { output, observedAtStart, childId } = await launch(false, "success");
		expect(observedAtStart?.held).toBe(false);
		expect(output).toContain("Background task started.");
		expect(output).toContain("Watch({");
		releaseExecution?.();
		await until(() => runEnded(childId));
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, childId) });
		expect(row?.backgroundStatus).toBe("completed");
		expect(row?.backgroundResult).toContain("Initial turn completed");
		expect(row?.substatus).not.toContain("taken_over");
		expect(isTakenOver(childId)).toBe(false);
		// The parent's notice is the durable terminal publication of this run.
		const { runtimePublicationOutbox, narratorBufferedMessages } = await import("../../db/schema");
		const outbox = await db
			.select()
			.from(runtimePublicationOutbox)
			.where(eq(runtimePublicationOutbox.taskId, childId));
		const delivered = await db
			.select()
			.from(narratorBufferedMessages)
			.where(eq(narratorBufferedMessages.narratorId, parentId));
		expect(
			outbox.some((row) => row.eventKind === "completed" && row.recipientId === parentId) ||
				delivered.some((row) => JSON.stringify(row).includes(childId)),
		).toBe(true);
	});

	test("background creation records the parent Agent call as the run's exact receipt", async () => {
		const toolUseId = generateId();
		const toolCallBinding = await insertParentAgentCall(toolUseId);
		const { childId } = await launch(false, "success", { toolUseId, toolCallBinding });
		// Without it, the card's file changes fall back to legacy/unscoped attribution.
		expect(await readSubagentExecutionBoundary(childId)).toEqual({
			sourceToolCallId: toolCallBinding.toolCallId,
			executionAttempt: 1,
			executionIdentityVersion: 1,
			executionSegmentId: toolCallBinding.executionSegmentId,
		});
		releaseExecution?.();
		await until(() => runEnded(childId));
	});
});
