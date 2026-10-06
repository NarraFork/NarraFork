import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { narratorMessageRefs, narratorMessages, narrators } from "../../db/schema";
import { generateId } from "../../lib/id";
import { parseSubstatus } from "../../lib/narrator-utils";
import { settings } from "../../lib/settings";
import * as websocket from "../../websocket/narrator-ws";
import * as completionQueue from "../bg-completion-queue";
import { narratorService } from "../narrator-service";
import { drainPendingInjections, takePendingInjectionBatch } from "../parent-injection-queue";
import { clearAliasRegistry } from "../subagent-alias";
import { getBackgroundAbortControllers } from "../subagent-detach";
import * as executor from "../subagent-executor";
import { listRunningSubagentExecutions, runSubagent } from "../subagent-runner";
import { clearTakenOver, isBackgroundTakenOver, isTakenOver } from "../subagent-takeover";

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
		await until(
			() => !listRunningSubagentExecutions().some((run) => run.subagentId === activeChildId),
		);
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
		await db.delete(narratorMessageRefs).where(inArray(narratorMessageRefs.narratorId, ids));
		await db.delete(narratorMessages).where(inArray(narratorMessages.narratorId, ids));
		// Child first: parentNarratorId is a real FK.
		for (const id of [...ids].reverse()) await db.delete(narrators).where(eq(narrators.id, id));
	}
	ids.length = 0;
});

async function launch(takeoverByUser: boolean, outcome: "success" | "error" | "throw") {
	let settle: (() => void) | undefined;
	const held = new Promise<void>((resolve) => {
		settle = resolve;
	});
	releaseExecution = () => settle?.();
	let observedAtStart: { held: boolean; backgroundHeld: boolean; substatus: unknown } | undefined;
	const execute = spyOn(executor, "executeSubagent").mockImplementation(async (options) => {
		activeChildId = options.narratorId;
		ids.push(activeChildId);
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, activeChildId) });
		observedAtStart = {
			held: isTakenOver(activeChildId),
			backgroundHeld: isBackgroundTakenOver(activeChildId),
			substatus: parseSubstatus(row?.substatus),
		};
		await held;
		if (outcome === "throw") throw new Error("Simulated initial execution exception");
		return {
			finalText: outcome === "error" ? "Simulated initial turn error" : "Initial turn completed",
			finalUserId: null,
			hasError: outcome === "error",
			allowInboxWake: false,
		};
	});
	restoreSpies.push(() => execute.mockRestore());

	// Promise timeout proves creation is non-blocking while the executor is held.
	// takeover deliberately omits background: true: creation must force it.
	let timer: ReturnType<typeof setTimeout> | undefined;
	const output = await Promise.race([
		runSubagent({
			parentNarratorId: parentId,
			toolUseId: generateId(),
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
	expect(output).toContain("<background_task_id>");
	return { output, observedAtStart, childId: activeChildId as string };
}

describe("Agent creation in user takeover mode", () => {
	for (const outcome of ["success", "error", "throw"] as const) {
		test(`initial ${outcome} parks idle[taken_over] without parent completion`, async () => {
			const { output, observedAtStart, childId } = await launch(true, outcome);
			expect(observedAtStart).toEqual({
				held: true,
				backgroundHeld: true,
				substatus: ["taken_over"],
			});
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
			await until(() => !listRunningSubagentExecutions().some((run) => run.subagentId === childId));
			const idle = await db.query.narrators.findFirst({ where: eq(narrators.id, childId) });
			expect(idle?.status).toBe("idle");
			expect(parseSubstatus(idle?.substatus)).toEqual(["taken_over"]);
			expect(idle?.isBackground).toBe(false);
			expect(idle?.backgroundStatus).toBeNull();
			expect(idle?.backgroundResult).toBeNull();
			expect(idle?.traits).not.toContain("background");
			expect(isTakenOver(childId)).toBe(true);
			expect(await takePendingInjectionBatch(parentId)).toBeNull();
			expect(completionQueue.pushBgCompletionNotification).not.toHaveBeenCalled();
		});
	}

	test("failed takeover startup clears the hold and cancels the unmounted task", async () => {
		let failedChildId: string | undefined;
		const addSubstatus = spyOn(narratorService, "addSubstatus").mockImplementation(async (id) => {
			failedChildId = id;
			ids.push(id);
			throw new Error("Simulated takeover persistence failure");
		});
		const execute = spyOn(executor, "executeSubagent");
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
		expect(isBackgroundTakenOver(childId)).toBe(false);
		expect(getBackgroundAbortControllers().has(childId)).toBe(false);
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
		expect(observedAtStart?.backgroundHeld).toBe(false);
		expect(output).toContain("Background task started.");
		expect(output).toContain("Await({");
		releaseExecution?.();
		await until(() => !listRunningSubagentExecutions().some((run) => run.subagentId === childId));
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, childId) });
		expect(row?.backgroundStatus).toBe("completed");
		expect(row?.backgroundResult).toContain("Initial turn completed");
		expect(row?.substatus).not.toContain("taken_over");
		expect(isTakenOver(childId)).toBe(false);
		expect(completionQueue.pushBgCompletionNotification).toHaveBeenCalledWith(
			parentId,
			expect.objectContaining({
				id: childId,
				status: "completed",
				result: "Initial turn completed",
			}),
		);
	});
});
