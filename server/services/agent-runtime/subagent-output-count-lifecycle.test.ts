import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ParsedStreamEvent } from "@shared/agent-protocol/types";
import { rowsAsHistory } from "../../../tests/fixtures/model-input";
import { testEnvironment } from "../../../tests/preload";
import { narrators } from "../../db/schema";
import type { ChatParams, ProviderAdapter } from "../../lib/agent/provider";
import type { ToolCallBinding } from "../../lib/agent/types";
import type { EventHandlerContext } from "../narrator-event-handler";

const { db } = await import("../../db");
const { closePrefixSnapshotStore } = await import("../narrator-prefix-snapshots");
// Preserve the service/persistence initialization order used by the real session host.
await import("../narrator-service");
const { narratorPersistence } = await import("../narrator-persistence");
const { processEvent, getStreamingSnapshot, getSubagentOutputCounts, clearStreamingSnapshot } =
	await import("../narrator-event-handler");
const session = await import("../narrator-session");
const { activeNarrators } = await import("../narrator-session-state");
const ownership = await import("./ownership");
const { controlRun, startNarratorRun } = await import("./run");
const inbox = await import("./inbox");
const { handleNarratorWS, getNarratorConnections } = await import("../../websocket/narrator-ws");
const { registerExternalProviderResolver } = await import("../../lib/agent/provider");
const { settings } = await import("../../lib/settings");

let chat: (params: ChatParams) => AsyncGenerator<ParsedStreamEvent> =
	(): AsyncGenerator<ParsedStreamEvent> => {
		throw new Error("A lifecycle test must supply its controlled provider");
	};
const provider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: rowsAsHistory,
	injectSystemPrompt: () => {},
	chat: (params) => chat(params),
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
const unregisterProvider = registerExternalProviderResolver({
	resolve: (prefix) => (prefix === "countlifecycle" ? provider : null),
	listReadiness: () => [],
});
const savedContinuation = settings.agent.autoContinuationMode;
const savedTreeSnapshots = settings.workspace.treeSnapshotsEnabled;
settings.agent.autoContinuationMode = "off";
settings.workspace.treeSnapshotsEnabled = false;

type FakeWs = Parameters<typeof handleNarratorWS.open>[0];
const sockets: FakeWs[] = [];
const handles: import("./run").RunHandle[] = [];
const ids = new Set<string>();
const releases: Array<() => void> = [];
let serial = 0;
let cwd = "";
beforeEach(() => {
	cwd = mkdtempSync(join(testEnvironment.narraforkHome, "count-lifecycle-"));
});
afterEach(async () => {
	for (const id of ids) ownership.getRunControl(id)?.cancel.abort("test cleanup");
	for (const release of releases.splice(0)) release();
	await Promise.all(handles.splice(0).map((handle) => handle.completion.catch(() => {})));
	for (const ws of sockets.splice(0)) handleNarratorWS.close(ws);
	getNarratorConnections().clear();
	for (const id of ids) {
		clearStreamingSnapshot(id);
		activeNarrators.delete(id);
		ownership.setRunHold(id, undefined);
	}
	ids.clear();
	rmSync(cwd, { recursive: true, force: true });
});
afterAll(async () => {
	unregisterProvider();
	settings.agent.autoContinuationMode = savedContinuation;
	settings.workspace.treeSnapshotsEnabled = savedTreeSnapshots;
	await closePrefixSnapshotStore();
	(await import("../narrator-block-sync")).stopBlockSyncSweep();
	mock.restore();
});

async function subscribe(narratorId: string) {
	const frames: Array<Record<string, unknown>> = [];
	const ws = {
		data: {
			channel: "narrator" as const,
			connectedAt: Date.now(),
			lastPongAt: Date.now(),
			subscribedNarrators: new Set<string>(),
			catchingUpNarrators: new Map(),
			catchUpBuffers: new Map(),
			userId: "count-lifecycle-viewer",
		},
		send(payload: string) {
			frames.push(JSON.parse(payload));
		},
		close() {},
	} as unknown as FakeWs;
	handleNarratorWS.open(ws);
	sockets.push(ws);
	await handleNarratorWS.message(ws, {
		type: "subscribe",
		kind: "messages",
		narratorIds: [narratorId],
	});
	return frames;
}

async function registeredPair() {
	const child = `count-live-child-${++serial}`;
	const parent = `count-live-parent-${serial}`;
	ids.add(child);
	ids.add(parent);
	const now = new Date().toISOString();
	await db.insert(narrators).values(
		[parent, child].map((id): typeof narrators.$inferInsert => ({
			id,
			title: id,
			type: "primary" as const,
			variant: "primary",
			traits: ["standalone"],
			model: "countlifecycle:base",
			autoContinuationOverride: "off",
			permissionMode: "bypassPermissions",
			visibility: "public" as const,
			cwd,
			createdAt: now,
			updatedAt: now,
		})),
	);
	const frames = await subscribe(parent);
	let partialId: string | undefined;
	const context: EventHandlerContext = {
		narratorId: parent,
		broadcastTargetId: parent,
		conversationId: `${parent}-conversation`,
		getContextUsagePct: () => undefined,
		getMeterUsage: () => undefined,
		getMeterUnit: () => undefined,
		getPartialMessageId: () => partialId,
		getTokenUsage: () => undefined,
		setPartialMessageId: (id) => {
			partialId = id;
		},
		setContextUsagePct: () => {},
		setMeterData: () => {},
		setTokenUsage: () => {},
	};
	const persisted: ToolCallBinding[] = [];
	await processEvent(
		{
			type: "block_complete",
			block: {
				type: "tool_use",
				toolUseId: "count-agent",
				name: "Agent",
				input: { prompt: "work" },
			},
			onToolPersisted: (binding) => {
				persisted.push(binding);
			},
		},
		context,
	);
	const initial = persisted[0];
	if (!initial) throw new Error("Persistence must return the original execution receipt");
	const prepared = await narratorPersistence.prepareToolCallAttempt(parent, initial.toolCallId);
	const receipt = await narratorPersistence.getToolCallBinding(
		parent,
		prepared.toolCall.messageId,
		"count-agent",
		prepared.toolCall.id,
	);
	await narratorPersistence.claimToolCallExecution(parent, "count-agent", receipt, Date.now());
	if (!context.toolExecutionReceipts)
		throw new Error("Persistence must retain its execution receipt map");
	context.toolExecutionReceipts.set("count-agent", {
		messageId: prepared.toolCall.messageId,
		binding: receipt,
	});
	await processEvent(
		{ type: "tool_call", toolUseId: "count-agent", toolName: "Agent", input: { prompt: "work" } },
		context,
	);
	expect(receipt.attempt).toBeGreaterThan(1);
	expect(frames.findLast((frame) => frame.type === "tool_started")).toMatchObject({
		toolCallId: receipt.toolCallId,
		executionAttempt: receipt.attempt,
	});
	expect(getStreamingSnapshot(parent)?.toolChunks.get("count-agent")).toMatchObject({
		toolCallId: receipt.toolCallId,
		executionAttempt: receipt.attempt,
	});
	return {
		child,
		parent,
		frames,
		binding: {
			principal: { userId: null },
			deliverTo: {
				narratorId: parent,
				toolUseId: "count-agent",
				toolCallId: receipt.toolCallId,
				attempt: receipt.attempt,
			},
		},
	};
}

test("real executeRun, hold and fresh model pass keep the same run's committed reply count", async () => {
	const pair = await registeredPair();
	const first = Promise.withResolvers<void>();
	const second = Promise.withResolvers<void>();
	const firstReturn = Promise.withResolvers<void>();
	const secondReturn = Promise.withResolvers<void>();
	releases.push(firstReturn.resolve, secondReturn.resolve);
	let requests = 0;
	chat = async function* (params) {
		params.onRequestStart?.();
		if (++requests === 1) {
			yield { text: "first" };
			first.resolve();
			await firstReturn.promise;
		} else if (requests === 2) {
			yield { text: "second" };
			second.resolve();
			await secondReturn.promise;
		} else throw new Error("Unexpected extra model request");
	};
	const handle = await startNarratorRun({
		narratorId: pair.child,
		locale: "en",
		text: "work",
		principal: null,
		binding: pair.binding,
		foreground: true,
		deliver: false,
	});
	handles.push(handle);
	await first.promise;
	const run = ownership.getRunControl(pair.child);
	const logicalRunId = run?.logicalRunId;
	if (!run || !logicalRunId) throw new Error("Expected an admitted live logical run");
	const epoch = ownership.getExecutionOwner(pair.child)?.epoch;
	expect(getSubagentOutputCounts(pair.parent)[0]?.count).toBe(5);
	const parked = Promise.withResolvers<void>();
	const realProbe = inbox.hasInboxKind;
	const probe = spyOn(inbox, "hasInboxKind").mockImplementation(async (...args) => {
		const result = await realProbe(...args);
		if (args[0] === pair.child && ownership.getRunControl(pair.child)?.wake) parked.resolve();
		return result;
	});
	try {
		expect(await controlRun(pair.child, { kind: "hold" })).toBe(true);
		firstReturn.resolve();
		await parked.promise;
		expect(ownership.isExecutionSuspended(pair.child)).toBe(true);
		expect(getSubagentOutputCounts(pair.parent)[0]?.count).toBe(5);
		await session.acceptUserMessage(pair.child, "next model pass", {
			locale: "en",
			userId: null,
			executionIntent: { modelOverride: { model: "countlifecycle:next", mode: "temporary" } },
		});
		await second.promise;
		expect(ownership.getRunControl(pair.child)).toBe(run);
		expect(ownership.getExecutionOwner(pair.child)?.epoch).not.toBe(epoch);
		expect(getSubagentOutputCounts(pair.parent)).toEqual([
			{
				childNarratorId: pair.child,
				logicalRunId,
				toolUseId: "count-agent",
				toolCallId: pair.binding.deliverTo.toolCallId,
				attempt: pair.binding.deliverTo.attempt,
				count: 11,
				active: true,
			},
		]);
		expect(
			pair.frames.filter(
				(frame) =>
					frame.type === "tool_output" &&
					(frame.subagentOutputCount as { active?: boolean } | undefined)?.active === false,
			),
		).toEqual([]);
		await controlRun(pair.child, { kind: "release" });
		secondReturn.resolve();
		expect((await handle.completion).hasError).toBe(false);
		expect(getSubagentOutputCounts(pair.parent)).toEqual([]);
	} finally {
		probe.mockRestore();
		firstReturn.resolve();
		secondReturn.resolve();
	}
}, 15_000);

test("real close captures the old run before abort and its delayed cleanup preserves a later run", async () => {
	const pair = await registeredPair();
	const first = Promise.withResolvers<void>();
	const second = Promise.withResolvers<void>();
	const secondReturn = Promise.withResolvers<void>();
	const cleanupEntered = Promise.withResolvers<void>();
	const cleanupReturn = Promise.withResolvers<void>();
	const cleanupDone = Promise.withResolvers<void>();
	releases.push(secondReturn.resolve, cleanupReturn.resolve);
	let requests = 0;
	chat = async function* (params) {
		params.onRequestStart?.();
		if (++requests === 1) {
			yield { text: "old" };
			first.resolve();
			await new Promise<void>((resolve) => {
				if (params.signal.aborted) resolve();
				else params.signal.addEventListener("abort", () => resolve(), { once: true });
			});
		} else if (requests === 2) {
			yield { text: "new body" };
			second.resolve();
			await secondReturn.promise;
		} else throw new Error("Unexpected extra model request");
	};
	const firstHandle = await startNarratorRun({
		narratorId: pair.child,
		locale: "en",
		text: "first run",
		principal: null,
		binding: pair.binding,
		foreground: true,
		deliver: false,
	});
	handles.push(firstHandle);
	await first.promise;
	const oldRunId = ownership.getRunControl(pair.child)?.logicalRunId;
	const oldSession = activeNarrators.get(pair.child);
	if (!oldSession || !oldRunId) throw new Error("Expected the first real running session");
	const browser = await import("../../lib/browser/session");
	const realCleanup = browser.cleanupNarrator;
	const cleanup = spyOn(browser, "cleanupNarrator").mockImplementation(async (...args) => {
		cleanupEntered.resolve();
		await cleanupReturn.promise;
		try {
			await realCleanup(...args);
		} finally {
			cleanupDone.resolve();
		}
	});
	const realGetRun = ownership.getRunControl;
	const readsAfterAbort: boolean[] = [];
	const read = spyOn(ownership, "getRunControl").mockImplementation((id) => {
		if (id === pair.child) readsAfterAbort.push(oldSession.abortController.signal.aborted);
		return realGetRun(id);
	});
	try {
		session.closeNarrator(pair.child);
		read.mockRestore();
		expect(readsAfterAbort.length).toBeGreaterThan(0);
		expect(readsAfterAbort[0]).toBe(false);
		expect(oldSession.abortController.signal.aborted).toBe(true);
		expect(getSubagentOutputCounts(pair.parent)).toEqual([]);
		await cleanupEntered.promise;
		await firstHandle.completion;
		const nextHandle = await startNarratorRun({
			narratorId: pair.child,
			locale: "en",
			text: "next run",
			principal: null,
			binding: pair.binding,
			foreground: true,
			deliver: false,
		});
		handles.push(nextHandle);
		await second.promise;
		const newRunId = ownership.getRunControl(pair.child)?.logicalRunId;
		expect(newRunId).not.toBe(oldRunId);
		cleanupReturn.resolve();
		await cleanupDone.promise;
		expect(getSubagentOutputCounts(pair.parent)[0]).toMatchObject({
			logicalRunId: newRunId,
			count: 8,
			active: true,
		});
		secondReturn.resolve();
		await nextHandle.completion;
		expect(getSubagentOutputCounts(pair.parent)).toEqual([]);
	} finally {
		read.mockRestore();
		cleanupReturn.resolve();
		secondReturn.resolve();
		cleanup.mockRestore();
	}
}, 15_000);
