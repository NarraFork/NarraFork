import { afterAll, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { contextUpdateOf } from "@shared/prefix-context";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import { narrators, users } from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";
import { registerExternalProviderResolver } from "../../lib/agent/provider";
import { settings } from "../../lib/settings";
import { runAgentLoopUnlocked } from "../agent-runtime/orchestrator";
import { getExecutionOwner, setRunControl, tryClaimExecution } from "../agent-runtime/ownership";
import { backgroundOccupancyStore } from "../background-occupancy-store";
import * as communication from "../narrator-communication";
import * as executor from "../narrator-executor";
import { closePrefixSnapshotStore } from "../narrator-prefix-snapshots";
import { type ActiveNarrator, activeNarrators } from "../narrator-session-state";

const id = "communication-request-boundary";
const adapter: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: async (messages) => ({
		history: messages.map((message) => ({ role: message.role, content: message.contentJson })),
	}),
	injectSystemPrompt: () => {},
	chat() {
		throw new Error("No network in the request-boundary fixture");
	},
	generate: async () => {
		throw new Error("No title generation in the fixture");
	},
	generateWithMeta: async () => {
		throw new Error("No summary generation in the fixture");
	},
	generateWithHistory: async () => {
		throw new Error("No history generation in the fixture");
	},
};
const unregister = registerExternalProviderResolver({
	resolve: (name) => (name === "communicationfixture" ? adapter : null),
	listReadiness: () => [],
});
afterAll(async () => {
	getExecutionOwner(id)?.release();
	activeNarrators.delete(id);
	await closePrefixSnapshotStore();
	backgroundOccupancyStore.resetForTests();
	unregister();
});

test("an already-running model request rebuild reads the latest communication targets", async () => {
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
	backgroundOccupancyStore.resetForTests();
	await backgroundOccupancyStore.start();
	settings.agent.autoContinuationMode = "off";
	const now = new Date().toISOString();
	db.insert(users)
		.values({ id: "principal", username: "principal", passwordHash: "fixture", createdAt: now })
		.run();
	db.insert(narrators)
		.values({
			id,
			type: "primary",
			variant: "primary",
			ownerUserId: "principal",
			model: "communicationfixture:model",
			cwd: process.env.HOME,
			autoContinuationOverride: "off",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	const active = {
		narratorId: id,
		conversationId: "communication-boundary-conversation",
		cwd: process.env.HOME,
		model: "communicationfixture:model",
		provider: "communicationfixture",
		systemPrompt: null,
		events: new EventEmitter(),
		alive: true,
		locale: "en",
		abortController: new AbortController(),
		_enabledOptionalTools: new Set(),
		_disabledTools: new Set(),
		_blockedSkills: { all: false, names: new Set() },
		_substatus: new Set(),
	} as ActiveNarrator;
	const owner = tryClaimExecution(id, "run");
	if (!owner) throw new Error("Missing fixture execution owner");
	activeNarrators.set(id, active);
	const runControl = {
		startedAt: Date.now(),
		cancel: new AbortController(),
		timedOut: false,
		terminal: new Promise<never>(() => {}),
	};
	setRunControl(owner, runControl);
	backgroundOccupancyStore.setRuntimeLive(id, true);
	let connected = true;
	const list = spyOn(communication, "listCommunicationTargets").mockImplementation(
		async (source, options) => {
			expect(source).toBe(id);
			expect(options?.signal).toBeInstanceOf(AbortSignal);
			return [
				{
					id: connected ? "first-peer" : "replacement-peer",
					title: "Exact peer",
					handle: null,
					status: "idle",
				},
			];
		},
	);
	const execute = spyOn(executor, "executeAgentLoop").mockImplementation(async (options) => {
		expect(options.config.systemPrompt).toContain('"id":"first-peer"');
		connected = false;
		const rebuilt = await options.config.rebuildRequestHistory?.();
		if (!rebuilt) throw new Error("Request rebuild hook missing");
		const updates = rebuilt.rows.flatMap((row) =>
			Array.isArray(row.contentJson)
				? row.contentJson.map(contextUpdateOf).filter((value) => value !== undefined)
				: [],
		);
		const changes = updates
			.flatMap((update) => update.changes)
			.filter((change) => change.key === "communication");
		expect(changes).toHaveLength(1);
		expect(changes[0]?.value).toContain('"id":"replacement-peer"');
		expect(changes[0]?.value).not.toContain('"id":"first-peer"');
		expect(getExecutionOwner(id)).toBe(owner);
		return {
			finalText: "done",
			hasError: false,
			shouldUpdateTitle: false,
			completedAssistantTurn: true,
			completedNaturally: true,
		};
	});
	try {
		await runAgentLoopUnlocked(active, owner, "Request preparation fixture", undefined, runControl);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
	} finally {
		execute.mockRestore();
		list.mockRestore();
	}
});
