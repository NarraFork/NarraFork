import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { cleanDb } from "../../../tests/setup";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	permissionRuleRequests,
	users,
} from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";
import type { ActiveNarrator } from "../narrator-session-state";
import { closeRuntimeTestDb, getRuntimeTestDb } from "./agent-runtime-test-database";

// A real isolated WAL database and real run/orchestrator/finalizers. Only the model-pass
// seam is scripted: no network, server lifecycle, production signals or process shutdown.
const { db, sqlite, ready } = getRuntimeTestDb();
await ready;
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const coordinator = await import("../update-coordinator");
const executor = await import("../narrator-executor");
const session = await import("../narrator-session");
const runs = await import("../agent-runtime/run");
const { getExecutionOwner, getRunControl } = await import("../agent-runtime/ownership");
const { CheckpointStop, freezeCheckpointStopAdmission, isCheckpointStop } = await import(
	"../agent-runtime/checkpoint-stop"
);
const { executeTool } = await import("../../lib/agent/tool-executor");
const { toolRegistry } = await import("../../lib/agent/tool-registry");
const { requestPermissionRuleTool } = await import("../../lib/agent/tools/request-permission-rule");
const { checkpointPreparedUpdateFence } = await import("../update-service");
const { getPlannedUpdateStartupProtection } = await import("../update-recovery-service");
const { activeNarrators, claimNarratorRuntime, hasNarratorRuntimeClaim } = await import(
	"../narrator-session-state"
);
const { backgroundOccupancyStore } = await import("../background-occupancy-store");
const { settings } = await import("../../lib/settings");
const provider = await import("../../lib/agent/provider");
const { closePrefixSnapshotStore } = await import("../narrator-prefix-snapshots");
let providerScript: ProviderAdapter["chat"] | undefined;
const adapter: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: async (messages) => ({
		history: messages.map((message) => ({ role: message.role, content: message.contentJson })),
	}),
	injectSystemPrompt() {},
	chat(params) {
		if (!providerScript) throw new Error("Fixture must not contact a model");
		return providerScript(params);
	},
	generate: async () => {
		throw new Error("Fixture must not generate a title");
	},
	generateWithMeta: async () => {
		throw new Error("Fixture must not generate a summary");
	},
	generateWithHistory: async () => {
		throw new Error("Fixture must not generate history");
	},
};
const unregister = provider.registerExternalProviderResolver({
	resolve: (name) => (name === "checkpointfixture" ? adapter : null),
	listReadiness: () => [],
});
const ids = ["checkpoint-primary", "checkpoint-parent", "checkpoint-child"];
let expectedRunCleanupFailures = 0;
let releaseCheckpointUnwind: (() => void) | undefined;
beforeEach(async () => {
	providerScript = undefined;
	coordinator.resetUpdateCoordinationForTests();
	backgroundOccupancyStore.resetForTests();
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
	await backgroundOccupancyStore.start();
	settings.agent.autoContinuationMode = "off";
	const now = new Date().toISOString();
	db.insert(users)
		.values({ id: "checkpoint-user", username: "fixture", passwordHash: "fixture", createdAt: now })
		.run();
	for (const id of ids)
		db.insert(narrators)
			.values({
				id,
				title: "Checkpoint fixture",
				model: "checkpointfixture:model",
				cwd: process.env.HOME,
				autoContinuationOverride: "off",
				createdAt: now,
				updatedAt: now,
			})
			.run();
	backgroundOccupancyStore.refreshNarrators(ids);
	await backgroundOccupancyStore.flush();
});
afterEach(async () => {
	releaseCheckpointUnwind?.();
	releaseCheckpointUnwind = undefined;
	try {
		coordinator.resetUpdateCoordinationForTests();
		if (expectedRunCleanupFailures)
			await expect(
				runs.drainNarratorRunCompletions({ deadlineAt: Date.now() + 2_000 }),
			).rejects.toThrow("cleanup failed");
		else await runs.drainNarratorRunCompletions({ deadlineAt: Date.now() + 2_000 });
		expect(runs.getNarratorRunShutdownSnapshot().failed).toBe(expectedRunCleanupFailures);
		await session.drainNarratorSessionTails({ deadlineAt: Date.now() + 2_000 });
		for (const id of ids) {
			getExecutionOwner(id)?.release();
			activeNarrators.delete(id);
			backgroundOccupancyStore.setRuntimeLive(id, false);
		}
		await backgroundOccupancyStore.flush();
	} finally {
		mock.restore();
	}
});
afterAll(async () => {
	await closeRuntimeTestDb(sqlite, { sessionTails: true });
	backgroundOccupancyStore.resetForTests();
	unregister();
	mock.module("../../db", () => realDb);
});
function active(id: string): ActiveNarrator {
	const narrator: ActiveNarrator = {
		narratorId: id,
		conversationId: `${id}-conversation`,
		cwd: process.env.HOME as string,
		model: "checkpointfixture:model",
		provider: "checkpointfixture",
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
	// Prepared sessions participate in the same live-identity fence as ensureNarrator().
	activeNarrators.set(id, narrator);
	return narrator;
}
async function publishCheckpoint(restarting = true) {
	const epoch = coordinator.getUpdateCoordinationStatus().updateEpoch;
	if (!epoch) throw new Error("Fixture update has no epoch");
	await coordinator.waitForScheduledRecoveryHandoff();
	coordinator.beginQuiescingTools();
	const snapshot = await checkpointPreparedUpdateFence(epoch);
	const published = coordinator.writePreparedUpdateRecoverySnapshot({
		...snapshot,
		resumeOnNextStartup: true,
	});
	if (restarting) coordinator.markUpdateRestarting();
	// The fixture closes only the checkpoint admission latch; application main closes
	// the actual run/publication/inbox producers before setting this latch.
	freezeCheckpointStopAdmission();
	return published;
}

test("signal shutdown unwinds prepared maintenance runs before database drain", async () => {
	const entered = Promise.withResolvers<void>();
	let passes = 0;
	spyOn(executor, "executeAgentLoop").mockImplementation(async ({ config }) => {
		passes++;
		coordinator.scheduleUpdate(undefined, "system_shutdown");
		const parked = coordinator.beginNarratorResponseActivity(config.narratorId, config.signal);
		entered.resolve();
		await parked;
		throw new Error("A prepared shutdown must not reopen the model gate");
	});
	await session.acceptUserMessage(ids[0], "checkpoint input", { userId: "checkpoint-user" });
	await entered.promise;
	const snapshot = await publishCheckpoint(false);
	expect(coordinator.getUpdateCoordinationStatus().phase).toBe("quiescing_tools");
	expect(runs.getNarratorRunShutdownSnapshot().pending).toBe(1);
	expect(session.getNarratorSessionTailStatus()).toEqual({ pending: 2, failed: 0 });
	const running = activeNarrators.get(ids[0]);
	if (!running) throw new Error("Missing live fixture session");
	const terminalEvents: string[] = [];
	running.events.on("event", (event) => {
		if (event.type === "done" || event.type === "error") terminalEvents.push(event.type);
	});
	try {
		// Execute the actual signal wiring without importing main or signaling a server.
		const main = await Bun.file(new URL("../../main.ts", import.meta.url)).text();
		const shutdownStart = main.indexOf("async function performGracefulShutdown(");
		const start = main.indexOf("httpLifecycle.abortAll();", shutdownStart);
		const end = main.indexOf("const shutdownRequestId", start);
		expect(shutdownStart).toBeGreaterThanOrEqual(0);
		expect(start).toBeGreaterThan(shutdownStart);
		expect(end).toBeGreaterThan(start);
		const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
			`async function close() { ${main.slice(start, end)} }`,
		);
		const close = new Function(
			"httpLifecycle",
			"producerOutcome",
			"step",
			"stopCheckpointedNarratorRuns",
			"options",
			"prepareSignalRestartRecovery",
			"markUpdateRestarting",
			`${code}\nreturn close();`,
		);
		const { prepareSignalRestartRecovery } = await import("../restart-recovery-service");
		const stages: string[] = [];
		let checkpointStops: unknown;
		await close(
			{ abortAll() {} },
			"ok",
			async (label: string, action: () => unknown) => {
				stages.push(label);
				const result = await action();
				if (label === "checkpointRuns.pause") checkpointStops = result;
				return "ok";
			},
			coordinator.stopCheckpointedNarratorRuns,
			{ reason: "signal" },
			prepareSignalRestartRecovery,
			coordinator.markUpdateRestarting,
		);
		expect(checkpointStops).toBe(1);
		expect(stages).toEqual(["restartRecovery.prepare", "checkpointRuns.pause"]);
		await runs.drainNarratorRunCompletions({ deadlineAt: Date.now() + 2_000 });
		await session.drainNarratorSessionTails({ deadlineAt: Date.now() + 2_000 });
		expect(runs.getNarratorRunShutdownSnapshot().pending).toBe(0);
		expect(session.getNarratorSessionTailStatus()).toEqual({ pending: 0, failed: 0 });
		expect(coordinator.getUpdateCoordinationStatus().phase).toBe("restarting");
		expect(passes).toBe(1);
		expect(terminalEvents).toEqual([]);
		expect(running.abortController.signal.aborted).toBe(false);
		expect(getExecutionOwner(ids[0])).toBeUndefined();
		expect(db.select().from(narrators).where(eq(narrators.id, ids[0])).get()).toMatchObject({
			status: "working",
			logicalRunId: snapshot.narrators[0]?.logicalRunId,
		});
	} finally {
		// A regression must not leave this fixture's real run/session promises parked.
		coordinator.markUpdateRestarting();
		coordinator.stopCheckpointedNarratorRuns();
		await runs.drainNarratorRunCompletions({ deadlineAt: Date.now() + 2_000 });
		await session.drainNarratorSessionTails({ deadlineAt: Date.now() + 2_000 });
	}
});

test("one parked loop retains both real session tails until checkpoint unwind finishes", async () => {
	const entered = Promise.withResolvers<void>();
	const unwindEntered = Promise.withResolvers<void>();
	const releaseUnwind = Promise.withResolvers<void>();
	releaseCheckpointUnwind = releaseUnwind.resolve;
	let passes = 0;
	const stopHooks: string[] = [];
	const { hookService } = await import("../hook-service");
	spyOn(hookService, "runHooks").mockImplementation(async (event) => {
		if (event === "Stop") stopHooks.push(event);
		return { outcome: "success" };
	});
	spyOn(executor, "executeAgentLoop").mockImplementation(async ({ config }) => {
		passes++;
		coordinator.scheduleUpdate(undefined, "system_shutdown");
		const parked = coordinator.beginNarratorResponseActivity(config.narratorId, config.signal);
		entered.resolve();
		try {
			await parked;
			throw new Error("Gate must not reopen");
		} finally {
			// The real run and both session callers must await the model pass's unwind.
			unwindEntered.resolve();
			await releaseUnwind.promise;
		}
	});
	try {
		await session.acceptUserMessage(ids[0], "checkpoint input", { userId: "checkpoint-user" });
		await entered.promise;
		expect(session.getNarratorSessionTailStatus()).toEqual({ pending: 2, failed: 0 });
		const running = activeNarrators.get(ids[0]);
		if (!running) throw new Error("Missing live fixture session");
		const terminalEvents: string[] = [];
		running.events.on("event", (event) => {
			if (event.type === "done" || event.type === "error") terminalEvents.push(event.type);
		});
		const runId = db
			.select({ run: narrators.logicalRunId })
			.from(narrators)
			.where(eq(narrators.id, ids[0]))
			.get()?.run;
		expect(runId).toBeTruthy();
		expect(coordinator.stopCheckpointedNarratorRuns()).toBe(0);
		const snapshot = await publishCheckpoint();
		expect(coordinator.stopCheckpointedNarratorRuns()).toBe(1);
		await unwindEntered.promise;
		expect(session.getNarratorSessionTailStatus()).toEqual({ pending: 2, failed: 0 });
		expect(getExecutionOwner(ids[0])).toBeDefined();
		expect(runs.getNarratorRunShutdownSnapshot().pending).toBe(1);
		releaseUnwind.resolve();
		await runs.drainNarratorRunCompletions({ deadlineAt: Date.now() + 2_000 });
		await session.drainNarratorSessionTails({ deadlineAt: Date.now() + 2_000 });
		expect(session.getNarratorSessionTailStatus()).toEqual({ pending: 0, failed: 0 });
		expect(runs.getNarratorRunShutdownSnapshot().pending).toBe(0);
		const saved = db
			.select({
				status: narrators.status,
				logicalRunId: narrators.logicalRunId,
				backgroundStatus: narrators.backgroundStatus,
			})
			.from(narrators)
			.where(eq(narrators.id, ids[0]))
			.get();
		expect(saved).toMatchObject({ status: "working", logicalRunId: runId });
		expect(saved?.backgroundStatus).not.toBe("completed");
		expect(passes).toBe(1);
		expect(stopHooks).toEqual([]);
		expect(terminalEvents).toEqual([]);
		expect(running.abortController.signal.aborted).toBe(false);
		expect(running._resumeBufferedAfterLoop).toBe(false);
		expect(getExecutionOwner(ids[0])).toBeUndefined();
		expect(coordinator.getUpdateCoordinationStatus().phase).toBe("restarting");
		// The replacement has a fresh process-local handoff registry, with the same durable rows.
		coordinator.resetUpdateCoordinationForTests();
		coordinator.writePlannedUpdateRecoverySnapshot(snapshot);
		const recovered = await getPlannedUpdateStartupProtection({ claimAuthorization: false });
		expect(recovered.severedNarratorIds.has(ids[0])).toBe(true);
		expect(
			recovered.snapshot?.narrators.some(
				(target) => target.narratorId === ids[0] && target.logicalRunId === runId,
			),
		).toBe(true);
	} finally {
		releaseUnwind.resolve();
		releaseCheckpointUnwind = undefined;
	}
});

test("a failure-handler checkpoint pause retains Stop hooks and temporary model state", async () => {
	const entered = Promise.withResolvers<void>();
	const fail = Promise.withResolvers<void>();
	releaseCheckpointUnwind = fail.resolve;
	const stopHooks: string[] = [];
	const { hookService } = await import("../hook-service");
	spyOn(hookService, "runHooks").mockImplementation(async (event) => {
		if (event === "Stop") stopHooks.push(event);
		return { outcome: "success" };
	});
	spyOn(executor, "executeAgentLoop").mockImplementation(async () => {
		entered.resolve();
		await fail.promise;
		throw new Error("Provider teardown failed during restart");
	});
	db.update(narrators)
		.set({ pendingModelRestore: "checkpointfixture:original" })
		.where(eq(narrators.id, ids[0]))
		.run();
	await session.acceptUserMessage(ids[0], "checkpoint input", { userId: "checkpoint-user" });
	await entered.promise;
	coordinator.scheduleUpdate(undefined, "system_shutdown");
	await publishCheckpoint();
	expect(coordinator.stopCheckpointedNarratorRuns()).toBe(0);
	const running = activeNarrators.get(ids[0]);
	if (!running) throw new Error("Missing live fixture session");
	expect(coordinator.checkpointStopForSignal(running.abortController.signal, ids[0])).toBeDefined();
	fail.resolve();
	await runs.drainNarratorRunCompletions({ deadlineAt: Date.now() + 2_000 });
	await session.drainNarratorSessionTails({ deadlineAt: Date.now() + 2_000 });
	expect(stopHooks).toEqual([]);
	expect(db.select().from(narrators).where(eq(narrators.id, ids[0])).get()).toMatchObject({
		status: "working",
		model: "checkpointfixture:model",
		pendingModelRestore: "checkpointfixture:original",
	});
});

for (const claimTiming of ["none", "before-child-register", "before-stop"] as const) {
	test(`foreground parent-child checkpoint authority respects recovery claim timing=${claimTiming}`, async () => {
		const childEntered = Promise.withResolvers<void>();
		let childHandle: Awaited<ReturnType<typeof runs.startNarratorRun>> | undefined;
		let calls = 0;
		let releaseClaim: (() => void) | undefined;
		const claimRecoveryConsumer = () => {
			expect(getExecutionOwner(ids[1])).toBeDefined();
			releaseClaim = claimNarratorRuntime(ids[1], `checkpoint-recovery-${claimTiming}`);
			expect(hasNarratorRuntimeClaim(ids[1])).toBe(true);
		};
		try {
			spyOn(executor, "executeAgentLoop").mockImplementation(async ({ config }) => {
				calls++;
				if (config.narratorId === ids[1]) {
					if (claimTiming === "before-child-register") {
						// The parent run already exists, while the child has not registered its loop.
						claimRecoveryConsumer();
						expect(
							coordinator
								.capturePlannedUpdateRecoverySnapshot()
								.narrators.some((target) => target.narratorId === ids[2]),
						).toBe(false);
					}
					childHandle = await runs.startNarratorRun({
						narratorId: ids[2],
						active: active(ids[2]),
						locale: "en",
						text: "",
						principal: "checkpoint-user",
						foreground: true,
						binding: {
							principal: { userId: "checkpoint-user" },
							deliverTo: {
								narratorId: ids[1],
								toolUseId: "checkpoint-agent",
								toolCallId: "checkpoint-agent-row",
								attempt: 1,
							},
						},
					});
					await childHandle.foreground;
					throw new Error("Child must not deliver a fabricated result");
				}
				coordinator.scheduleUpdate(undefined, "system_shutdown");
				const parked = coordinator.beginNarratorResponseActivity(config.narratorId, config.signal);
				childEntered.resolve();
				await parked;
				throw new Error("Child model must stay parked");
			});
			const now = new Date().toISOString();
			db.insert(narratorMessages)
				.values({
					id: "checkpoint-agent-message",
					narratorId: ids[1],
					role: "assistant",
					contentJson: [],
					createdAt: now,
				})
				.run();
			db.insert(narratorMessages)
				.values({
					id: "checkpoint-child-input",
					narratorId: ids[2],
					parentToolUseId: "checkpoint-agent",
					role: "user",
					contentJson: [],
					createdAt: now,
				})
				.run();
			db.insert(narratorMessageRefs)
				.values({
					id: "checkpoint-agent-ref",
					narratorId: ids[1],
					messageId: "checkpoint-agent-message",
					seq: 1,
				})
				.run();
			db.insert(narratorToolCalls)
				.values({
					id: "checkpoint-agent-row",
					narratorId: ids[1],
					messageId: "checkpoint-agent-message",
					toolUseId: "checkpoint-agent",
					toolName: "Agent",
					inputJson: {},
					status: "running",
					executionAttempt: 1,
					executionIdentityVersion: 1,
					executionStartedAt: now,
					createdAt: now,
				})
				.run();
			db.update(narrators).set({ status: "working" }).where(eq(narrators.id, ids[1])).run();
			db.update(narrators).set({ status: "working" }).where(eq(narrators.id, ids[2])).run();
			const parent = await runs.startNarratorRun({
				narratorId: ids[1],
				active: active(ids[1]),
				locale: "en",
				text: "",
				principal: "checkpoint-user",
			});
			void parent.completion.catch(() => {});
			await childEntered.promise;
			const checkpoint = await publishCheckpoint();
			if (claimTiming === "before-stop") claimRecoveryConsumer();
			if (claimTiming !== "none") {
				expect(coordinator.stopCheckpointedNarratorRuns()).toBe(0);
				expect(runs.getNarratorRunShutdownSnapshot().pending).toBe(2);
				expect(
					checkpoint.narrators.some(
						(target) => target.narratorId === ids[2] && target.logicalRunId,
					),
				).toBe(true);
				await expect(
					runs.drainNarratorRunCompletions({ deadlineAt: Date.now() - 1 }),
				).rejects.toThrow("deadline");
				expect(runs.getNarratorRunShutdownSnapshot().pending).toBe(2);
				expect(
					db
						.select({ status: narratorToolCalls.status })
						.from(narratorToolCalls)
						.where(eq(narratorToolCalls.id, "checkpoint-agent-row"))
						.get()?.status,
				).toBe("running");
				for (const id of [ids[1], ids[2]]) expect(getExecutionOwner(id)).toBeDefined();
				// Withdrawing the separate consumer permits a fresh authorization decision;
				// neither manifest eligibility nor this recovered child's identity was discarded.
				releaseClaim?.();
				expect(hasNarratorRuntimeClaim(ids[1])).toBe(false);
			}
			expect(coordinator.stopCheckpointedNarratorRuns()).toBe(1);
			const results = await Promise.allSettled([
				parent.completion,
				parent.terminal,
				childHandle?.completion,
				childHandle?.terminal,
			]);
			for (const result of results) {
				expect(result.status).toBe("rejected");
				if (result.status === "rejected") expect(isCheckpointStop(result.reason)).toBe(true);
			}
			if (results[0].status === "rejected")
				expect(results[0].reason.identity.narratorId).toBe(ids[1]);
			if (results[2].status === "rejected")
				expect(results[2].reason.identity.narratorId).toBe(ids[2]);
			expect(
				db
					.select({ status: narratorToolCalls.status })
					.from(narratorToolCalls)
					.where(eq(narratorToolCalls.id, "checkpoint-agent-row"))
					.get()?.status,
			).toBe("running");
			for (const id of [ids[1], ids[2]])
				expect(
					db.select({ status: narrators.status }).from(narrators).where(eq(narrators.id, id)).get()
						?.status,
				).toBe("working");
			expect(calls).toBe(2);
			expect(runs.getNarratorRunShutdownSnapshot().pending).toBe(0);
		} finally {
			releaseClaim?.();
		}
	});
}

for (const detached of [false, true]) {
	test(`background checkpoint survives its parent's turn ending, detached=${detached}`, async () => {
		const entered = Promise.withResolvers<void>();
		const park = Promise.withResolvers<void>();
		const parked = Promise.withResolvers<void>();
		const unregisterParent = coordinator.registerNarratorLoop(ids[1], "en", {
			logicalRunId: "finished-parent-run",
			executionEpoch: "finished-parent-owner",
		});
		spyOn(executor, "executeAgentLoop").mockImplementation(async ({ config }) => {
			entered.resolve();
			await park.promise;
			coordinator.scheduleUpdate(undefined, "system_shutdown");
			const waiting = coordinator.beginNarratorResponseActivity(config.narratorId, config.signal);
			parked.resolve();
			await waiting;
			return { finalText: "resumed", hasError: false, shouldUpdateTitle: false };
		});
		const now = new Date().toISOString();
		db.insert(narratorMessages)
			.values({
				id: "background-agent-message",
				narratorId: ids[1],
				role: "assistant",
				contentJson: [],
				createdAt: now,
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({
				id: "background-agent-ref",
				narratorId: ids[1],
				messageId: "background-agent-message",
				seq: 1,
			})
			.run();
		db.insert(narratorMessages)
			.values({
				id: "background-child-input",
				narratorId: ids[2],
				parentToolUseId: "background-agent",
				role: "user",
				contentJson: [],
				createdAt: now,
			})
			.run();
		db.insert(narratorToolCalls)
			.values({
				id: "background-agent-row",
				narratorId: ids[1],
				messageId: "background-agent-message",
				toolUseId: "background-agent",
				toolName: "Agent",
				inputJson: {},
				status: "running",
				executionAttempt: 1,
				executionIdentityVersion: 1,
				executionStartedAt: now,
				createdAt: now,
			})
			.run();
		db.update(narrators).set({ status: "working" }).where(eq(narrators.id, ids[2])).run();
		const child = await runs.startNarratorRun({
			narratorId: ids[2],
			active: active(ids[2]),
			locale: "en",
			text: "",
			principal: "checkpoint-user",
			foreground: detached,
			binding: {
				principal: { userId: "checkpoint-user" },
				deliverTo: {
					narratorId: ids[1],
					toolUseId: "background-agent",
					toolCallId: "background-agent-row",
					attempt: 1,
				},
			},
		});
		void child.completion.catch(() => {});
		try {
			await entered.promise;
			if (detached) expect(await runs.controlRun(ids[2], { kind: "detach" })).toBe(true);
			unregisterParent();
			park.resolve();
			await parked.promise;
			await publishCheckpoint();
			expect(coordinator.stopCheckpointedNarratorRuns()).toBe(1);
			const outcome = await child.completion.catch((error) => error);
			expect(isCheckpointStop(outcome)).toBe(true);
			expect(outcome.identity.narratorId).toBe(ids[2]);
			expect(runs.getNarratorRunShutdownSnapshot().pending).toBe(0);
		} finally {
			unregisterParent();
			park.resolve();
			coordinator.resetUpdateCoordinationForTests();
			await child.completion.catch(() => {});
		}
	});
}

for (const failPersistence of [false, true]) {
	test(`real provider Agent and companion settlement preserve checkpoint state, persistenceFailure=${failPersistence}`, async () => {
		const { agentTool } = await import("../../lib/agent/tools/task");
		const oldAgent = toolRegistry.get("Agent");
		const companionStarted = Promise.withResolvers<void>();
		const releaseCompanion = Promise.withResolvers<void>();
		const childParked = Promise.withResolvers<string>();
		let companionSignal: AbortSignal | undefined;
		let companionId: string | undefined;
		let companionModelCalls = 0;
		let modelCalls = 0;
		let parentSettled = false;
		const parentActive = active(ids[1]);
		toolRegistry.register({
			...agentTool,
			execute: async (input, context) => {
				if ((input as { prompt?: string }).prompt === "controlled-companion") {
					companionSignal = context.signal;
					const result = await agentTool.execute(input, context);
					companionStarted.resolve();
					await releaseCompanion.promise;
					return result;
				}
				await companionStarted.promise;
				return agentTool.execute(input, context);
			},
		});
		providerScript = async function* (params) {
			if (params.stickySessionKey === companionId) {
				companionModelCalls++;
				params.onRequestStart?.();
				yield { text: "checkpoint companion result" };
				return;
			}
			modelCalls++;
			if (params.stickySessionKey !== ids[1])
				throw new Error("Checkpointed child must not start its model");
			params.onRequestStart?.();
			yield {
				toolUses: [
					{
						toolUseId: "actual-await",
						name: "Agent",
						input: {
							prompt: "controlled-companion",
							description: "Controlled companion",
							subagent_type: "general",
						},
					},
					{
						toolUseId: "actual-agent",
						name: "Agent",
						input: {
							prompt: "Park at the persisted response gate",
							description: "Checkpoint child",
							subagent_type: "general",
						},
					},
				],
			};
		};
		const realBegin = coordinator.beginNarratorResponseActivity;
		spyOn(coordinator, "beginNarratorResponseActivity").mockImplementation(
			(id, signal, options) => {
				if (id !== ids[1] && !options?.isReflection) {
					const origin = db
						.select({ toolUseId: narratorMessages.parentToolUseId })
						.from(narratorMessages)
						.where(
							and(
								eq(narratorMessages.narratorId, id),
								eq(narratorMessages.parentToolUseId, "actual-await"),
							),
						)
						.get();
					if (origin?.toolUseId === "actual-await") {
						companionId = id;
						return realBegin(id, signal, options);
					}
					coordinator.scheduleUpdate(undefined, "system_shutdown");
					const parked = realBegin(id, signal, options);
					childParked.resolve(id);
					return parked;
				}
				return realBegin(id, signal, options);
			},
		);
		db.update(narrators)
			.set({
				status: "working",
				permissionMode: "bypassPermissions",
				ownerUserId: "checkpoint-user",
			})
			.where(eq(narrators.id, ids[1]))
			.run();
		let parent: Awaited<ReturnType<typeof runs.startNarratorRun>> | undefined;
		try {
			parent = await runs.startNarratorRun({
				narratorId: ids[1],
				active: parentActive,
				locale: "en",
				text: "Run a foreground checkpoint child",
				principal: "checkpoint-user",
			});
			void parent.completion.then(
				() => {
					parentSettled = true;
				},
				() => {
					parentSettled = true;
				},
			);
			const childId = await childParked.promise;
			await companionStarted.promise;
			const child = getRunControl(childId);
			if (!child || !companionSignal) throw new Error("Real child or companion did not start");
			expect(companionSignal).not.toBe(parentActive.abortController.signal);
			await publishCheckpoint();
			expect(coordinator.stopCheckpointedNarratorRuns()).toBe(1);
			expect(
				coordinator.checkpointStopForSignal(companionSignal, ids[1])?.identity.narratorId,
			).toBe(ids[1]);
			expect(isCheckpointStop(await child.terminal.catch((error) => error))).toBe(true);
			expect(parentSettled).toBe(false);
			expect(getExecutionOwner(ids[1])).toBeDefined();
			expect(runs.getNarratorRunShutdownSnapshot().pending).toBe(1);
			await expect(
				runs.drainNarratorRunCompletions({ deadlineAt: Date.now() - 1 }),
			).rejects.toThrow("deadline");
			expect(runs.getNarratorRunShutdownSnapshot().pending).toBe(1);
			let persistFailures = 0;
			if (failPersistence) {
				const { narratorStore } = await import("../narrator-store");
				const settle = narratorStore.settleTool;
				spyOn(narratorStore, "settleTool").mockImplementation(async (...args) => {
					if (args[0] === "actual-await") {
						persistFailures++;
						throw new Error("Injected companion result write failure");
					}
					return await settle(...args);
				});
			}
			releaseCompanion.resolve();
			const outcome = await parent.completion.catch((error) => error);
			expect(isCheckpointStop(outcome)).toBe(true);
			if (!isCheckpointStop(outcome)) throw new Error("Parent did not preserve checkpoint control");
			if (failPersistence) {
				// Non-lock settlement errors surface after one attempt.
				expect(persistFailures).toBe(1);
				expect(outcome.cleanupFailure).toMatchObject({ name: "CriticalEventPersistenceError" });
				expectedRunCleanupFailures++;
				expect(runs.getNarratorRunShutdownSnapshot().failed).toBe(expectedRunCleanupFailures);
				await expect(
					runs.drainNarratorRunCompletions({ deadlineAt: Date.now() + 1_000 }),
				).rejects.toThrow("cleanup failed");
			}
			const tools = db
				.select({
					toolUseId: narratorToolCalls.toolUseId,
					status: narratorToolCalls.status,
					output: narratorToolCalls.outputJson,
				})
				.from(narratorToolCalls)
				.where(eq(narratorToolCalls.narratorId, ids[1]))
				.all();
			expect(tools.find((tool) => tool.toolUseId === "actual-agent")?.status).toBe("running");
			expect(tools.find((tool) => tool.toolUseId === "actual-await")).toMatchObject({
				status: failPersistence ? "running" : "success",
			});
			if (!failPersistence)
				expect(
					JSON.stringify(tools.find((tool) => tool.toolUseId === "actual-await")?.output),
				).toContain("checkpoint companion result");
			const saved = db
				.select({
					status: narrators.status,
					error: narrators.errorMessage,
					backgroundCompletedAt: narrators.backgroundCompletedAt,
					logicalRunId: narrators.logicalRunId,
				})
				.from(narrators)
				.where(eq(narrators.id, ids[1]))
				.get();
			expect(saved?.error).toBeNull();
			expect(saved?.backgroundCompletedAt).toBeNull();
			expect(saved?.logicalRunId).toBeTruthy();
			expect(
				db
					.select({ status: narrators.status })
					.from(narrators)
					.where(eq(narrators.id, ids[1]))
					.get()?.status,
			).toBe("working");
			expect(modelCalls).toBe(1);
			expect(companionModelCalls).toBe(1);
			expect(runs.getNarratorRunShutdownSnapshot().pending).toBe(0);
		} finally {
			releaseCompanion.resolve();
			coordinator.resetUpdateCoordinationForTests();
			await parent?.completion.catch(() => {});
			toolRegistry.unregister("Agent");
			if (oldAgent) toolRegistry.register(oldAgent);
		}
	}, 15_000);
}

for (const mode of ["checkpoint", "cancel", "uncovered"] as const) {
	test(`permission-rule approval keeps its exact checkpoint boundary for ${mode}`, async () => {
		const previous = toolRegistry.get("RequestPermissionRule");
		toolRegistry.register(requestPermissionRuleTool);
		const id = ids[0];
		const now = new Date().toISOString();
		const identity = {
			narratorId: id,
			logicalRunId: "request-run",
			executionEpoch: "request-owner",
		};
		const controller = new AbortController();
		const unregisterLoop = coordinator.registerNarratorLoop(id, "en", identity);
		coordinator.bindCheckpointGateActor(controller.signal, identity);
		db.update(narrators)
			.set({ status: "waiting", logicalRunId: identity.logicalRunId })
			.where(eq(narrators.id, id))
			.run();
		db.insert(narratorMessages)
			.values({
				id: "request-message",
				narratorId: id,
				role: "assistant",
				contentJson: [],
				createdAt: now,
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: "request-ref", narratorId: id, messageId: "request-message", seq: 1 })
			.run();
		db.insert(narratorToolCalls)
			.values({
				id: "request-tool",
				narratorId: id,
				messageId: "request-message",
				toolUseId: "request-use",
				toolName: "RequestPermissionRule",
				inputJson: {},
				status: "pending",
				executionAttempt: 1,
				executionIdentityVersion: 1,
				createdAt: now,
			})
			.run();
		db.insert(permissionRuleRequests)
			.values({
				id: "request-audit",
				narratorId: id,
				toolCallId: "request-tool",
				toolUseId: "request-use",
				attempt: 1,
				proposalJson: { input: {}, rule: {} },
				proposalHash: "fixture",
				reason: "fixture",
				scope: "narrator",
				deviceId: "local",
				contextRevision: "fixture",
				status: "approved",
				approvalSource: "user",
				approvalUserId: "checkpoint-user",
			})
			.run();
		try {
			const operation = executeTool(
				{
					name: "RequestPermissionRule",
					toolUseId: "request-use",
					input: { ruleType: "commandWhitelist", pattern: "git status", reason: "fixture" },
				},
				{
					narratorId: id,
					conversationId: "request-conversation",
					provider: "fixture",
					model: "fixture:model",
					cwd: process.env.HOME as string,
					signal: controller.signal,
					permissionHandler: async (_name, _input, _toolUseId, options) => {
						if (mode === "cancel") {
							controller.abort("User interrupted");
							return { behavior: "allow" as const };
						}
						if (mode === "uncovered") throw new CheckpointStop("uncovered-epoch", identity);
						options?.onAwaitingUserDecision?.();
						coordinator.scheduleUpdate(undefined, "system_shutdown");
						await publishCheckpoint();
						coordinator.stopCheckpointedNarratorRuns();
						const stop = coordinator.checkpointStopForSignal(controller.signal, id);
						if (!stop) throw new Error("Fixture owner did not receive checkpoint authority");
						throw stop;
					},
				},
				{ toolCallBinding: { toolCallId: "request-tool", attempt: 1 } },
			);
			if (mode === "checkpoint")
				expect(isCheckpointStop(await operation.catch((error) => error))).toBe(true);
			else expect((await operation).isError).toBe(true);
			const audit = db
				.select()
				.from(permissionRuleRequests)
				.where(eq(permissionRuleRequests.id, "request-audit"))
				.get();
			expect(audit?.status).toBe(
				mode === "checkpoint" ? "approved" : mode === "cancel" ? "cancelled" : "failed",
			);
			expect(audit?.approvalUserId).toBe("checkpoint-user");
		} finally {
			unregisterLoop();
			toolRegistry.unregister("RequestPermissionRule");
			if (previous) toolRegistry.register(previous);
		}
	});
}

test("the same real result-persistence failure outside checkpoint drain remains an ordinary failed run", async () => {
	const previous = toolRegistry.get("Read");
	toolRegistry.register({
		name: "Read",
		description: "Controlled receipt",
		parameters: z.object({ type: z.literal("agent"), id: z.string() }),
		execute: async () => ({ output: "ordinary result" }),
	});
	let attempts = 0;
	const { narratorStore } = await import("../narrator-store");
	const settle = narratorStore.settleTool;
	spyOn(narratorStore, "settleTool").mockImplementation(async (...args) => {
		if (args[0] === "ordinary-await") {
			attempts++;
			throw new Error("Ordinary companion result write failure");
		}
		return await settle(...args);
	});
	providerScript = async function* (params) {
		params.onRequestStart?.();
		yield {
			toolUses: [
				{ toolUseId: "ordinary-await", name: "Read", input: { type: "agent", id: "controlled" } },
			],
		};
	};
	db.update(narrators)
		.set({ status: "working", permissionMode: "bypassPermissions", ownerUserId: "checkpoint-user" })
		.where(eq(narrators.id, ids[1]))
		.run();
	try {
		const handle = await runs.startNarratorRun({
			narratorId: ids[1],
			active: active(ids[1]),
			locale: "en",
			text: "Persist ordinary receipt",
			principal: "checkpoint-user",
		});
		const outcome = await handle.completion;
		expect(outcome.hasError).toBe(true);
		expect(isCheckpointStop(outcome)).toBe(false);
		// Non-lock settlement errors surface after one attempt.
		expect(attempts).toBe(1);
		const saved = db
			.select({ status: narrators.status, error: narrators.errorMessage })
			.from(narrators)
			.where(eq(narrators.id, ids[1]))
			.get();
		expect(saved?.status).toBe("idle");
		expect(saved?.error).toContain("Tool result could not be persisted");
		expect(runs.getNarratorRunShutdownSnapshot().failed).toBe(expectedRunCleanupFailures);
	} finally {
		toolRegistry.unregister("Read");
		if (previous) toolRegistry.register(previous);
	}
}, 10_000);
