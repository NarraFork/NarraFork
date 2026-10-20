import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { getTestDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";
import type { ActiveNarrator } from "../narrator-session-state";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const provider = await import("../../lib/agent/provider");
const executor = await import("../narrator-executor");
const pipeline = await import("../../lib/agent/pipeline-state");
const state = await import("../narrator-session-state");
const { runAgentLoopUnlocked } = await import("../agent-runtime/orchestrator");
const { tryClaimExecution } = await import("../agent-runtime/ownership");
const { backgroundOccupancyStore } = await import("../background-occupancy-store");
const { settings } = await import("../../lib/settings");
const noNetwork = async (): Promise<never> => {
	throw new Error("Fixture must not contact a provider");
};
const adapter: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	chat() {
		throw new Error("Fixture must not stream a provider");
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: noNetwork,
	generateWithMeta: noNetwork,
	generateWithHistory: noNetwork,
};
const unregister = provider.registerExternalProviderResolver({
	resolve: (name) => (name === "shutdownfixture" ? adapter : null),
	listReadiness: () => [],
});
afterAll(() => {
	backgroundOccupancyStore.resetForTests();
	unregister();
	mock.restore();
});

test("freezing during a model pass prevents the same epoch from starting its continuation", async () => {
	const id = "shutdown-continuation-fixture";
	const now = new Date().toISOString();
	const model = "shutdownfixture:model";
	db.insert(narrators)
		.values({
			id,
			type: "primary",
			variant: "primary",
			model,
			cwd: process.env.HOME,
			autoContinuationOverride: "off",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	settings.agent.autoContinuationMode = "off";
	await backgroundOccupancyStore.start();
	const active: ActiveNarrator = {
		narratorId: id,
		conversationId: "shutdown-fixture",
		cwd: process.env.HOME as string,
		model,
		provider: "shutdownfixture",
		systemPrompt: null,
		events: new EventEmitter(),
		alive: true,
		locale: "en",
		abortController: new AbortController(),
		_enabledOptionalTools: new Set(),
		_disabledTools: new Set(),
		_blockedSkills: { all: false, names: new Set() },
		_substatus: new Set(),
	};
	const owner = tryClaimExecution(id, "run");
	if (!owner) throw new Error("Missing fixture execution owner");
	state.activeNarrators.set(id, active);
	const persistenceFailure = new DOMException("fixture final persistence cancelled", "AbortError");
	spyOn(pipeline, "clearPipelineStateIfActive").mockRejectedValue(persistenceFailure);
	const pass = spyOn(executor, "executeAgentLoop").mockImplementation(async () => {
		state.freezeNarratorAdmissionForShutdown();
		expect(active.abortController.signal.aborted).toBe(false);
		// Workspace invalidation normally starts another pass in this same epoch.
		active._workspacePassInvalidated = true;
		return {
			finalText: "finished",
			hasError: false,
			shouldUpdateTitle: false,
			completedAssistantTurn: true,
			completedNaturally: true,
		};
	});
	try {
		await runAgentLoopUnlocked(active, owner, "fixture");
		expect(pass).toHaveBeenCalledTimes(1);
		expect(state.getNarratorShutdownSignal().aborted).toBe(false);
		await expect(state.drainNarratorAdmissionWork(new AbortController().signal)).rejects.toBe(
			persistenceFailure,
		);
	} finally {
		owner.release();
		state.activeNarrators.delete(id);
	}
});
