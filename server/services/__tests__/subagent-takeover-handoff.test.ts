import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { db } from "../../db";
import { narratorMessageRefs, narratorMessages, narrators } from "../../db/schema";
import { type ProviderAdapter, registerExternalProviderResolver } from "../../lib/agent/provider";
import { generateId } from "../../lib/id";
import { getExecutionOwner } from "../agent-runtime/ownership";
import * as passExecutor from "../narrator-executor";
import { activeNarrators } from "../narrator-session-state";
import { drainPendingInjections, takePendingInjectionBatch } from "../parent-injection-queue";

/*
 * Attribution of a run's result notice: the run executes as its own registered
 * principal (never borrowed from a related session) and its detached result notice is
 * attributed to the principal the run ended with. Same rule for every session.
 */
const provider: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: async () => ({ history: [] }),
	injectSystemPrompt: () => {},
	chat() {
		throw new Error("Attribution test must never call a model");
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
const unregisterProvider = registerExternalProviderResolver({
	resolve: (name) => (name === "attrtest" ? provider : null),
	listReadiness: () => [],
});
afterAll(() => unregisterProvider());

const ids: string[] = [];
afterEach(async () => {
	for (const id of ids) {
		getExecutionOwner(id)?.release();
		activeNarrators.delete(id);
		await drainPendingInjections(id);
	}
	if (ids.length) {
		const { backgroundTasks } = await import("../../db/schema");
		await db.delete(backgroundTasks).where(inArray(backgroundTasks.id, ids));
		await db.delete(narratorMessageRefs).where(inArray(narratorMessageRefs.narratorId, ids));
		await db.delete(narratorMessages).where(inArray(narratorMessages.narratorId, ids));
		await db.delete(narrators).where(inArray(narrators.id, ids));
	}
	ids.length = 0;
});

async function fixture(principal: string | null) {
	const parentId = generateId();
	const childId = generateId();
	ids.push(childId, parentId);
	const now = new Date().toISOString();
	await db.insert(narrators).values([
		{ id: parentId, variant: "primary", status: "working", createdAt: now, updatedAt: now },
		{
			id: childId,
			variant: "subagent:general",
			type: "subagent",
			parentNarratorId: parentId,
			status: "idle",
			model: "attrtest:model",
			cwd: process.env.HOME,
			autoContinuationOverride: "off",
			createdAt: now,
			updatedAt: now,
		},
	]);
	// A detached run as Agent(background) registers it: task row + run relations.
	const { backgroundTaskService } = await import("../background-task-service");
	const task = await backgroundTaskService.createAgentTask({
		id: childId,
		subagentNarratorId: childId,
		subagentType: "general",
		binding: {
			deliverTo: { narratorId: parentId, toolUseId: "origin-tool" },
			principal: { userId: principal },
		},
	});
	return { parentId, childId, runId: task.logicalRunId ?? undefined };
}

describe("run result attribution", () => {
	for (const principal of ["B", null] as const) {
		test(`a detached run's notice is attributed to its principal (${principal})`, async () => {
			const { parentId, childId, runId } = await fixture(principal);
			const users: Array<string | null | undefined> = [];
			const execute = spyOn(passExecutor, "executeAgentLoop").mockImplementation(async () => {
				users.push(activeNarrators.get(childId)?._currentUserId);
				return {
					finalText: "final result",
					hasError: false,
					shouldUpdateTitle: false,
					completedNaturally: true,
					completedAssistantTurn: true,
				};
			});
			try {
				const { startNarratorRun } = await import("../agent-runtime/run");
				const handle = await startNarratorRun({
					narratorId: childId,
					locale: "en",
					text: "finish",
					resumeRunId: runId,
				});
				expect(handle.started).toBe(true);
				await handle.terminal;
				// The run executed as its own registered principal.
				expect(users).toEqual([principal]);
				// The notice reaches the destination's inbox once published.
				const { runtimePublication } = await import("../agent-runtime/publication");
				await runtimePublication.flushRecipient(parentId);
				const batch = await takePendingInjectionBatch(parentId);
				expect(batch?.entries.length).toBeGreaterThan(0);
				expect(batch?.userId).toBe(principal);
			} finally {
				execute.mockRestore();
			}
		});
	}

	test("an explicit principal of a new input wins over the registered one", async () => {
		const { childId, runId } = await fixture("B");
		const users: Array<string | null | undefined> = [];
		const execute = spyOn(passExecutor, "executeAgentLoop").mockImplementation(async () => {
			users.push(activeNarrators.get(childId)?._currentUserId);
			return {
				finalText: "ok",
				hasError: false,
				shouldUpdateTitle: false,
				completedNaturally: true,
				completedAssistantTurn: true,
			};
		});
		try {
			const { startNarratorRun } = await import("../agent-runtime/run");
			const handle = await startNarratorRun({
				narratorId: childId,
				locale: "en",
				text: "finish",
				resumeRunId: runId,
				principal: "A",
			});
			await handle.terminal;
			expect(users).toEqual(["A"]);
		} finally {
			execute.mockRestore();
		}
	});
});
