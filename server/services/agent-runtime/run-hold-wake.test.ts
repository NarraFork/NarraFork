import { afterAll, expect, mock, spyOn, test } from "bun:test";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import { readNativeRows } from "../../db/worker-read";
import { closeRuntimeTestDb, getRuntimeTestDb } from "../__tests__/agent-runtime-test-database";
import type { EventHandlerContext } from "../narrator-event-handler";
import {
	isExecutionSuspended,
	type RunControl,
	setExecutionSuspended,
	setRunControl,
	setRunHold,
	tryClaimExecution,
} from "./ownership";

const { db, sqlite, ready } = getRuntimeTestDb();
await ready;
mock.module("../../db", () => ({
	db,
	sqlite,
	activeDatabaseBackend: "sqlite",
	postgresRuntime: null,
}));
const { narratorService } = await import("../narrator-service");
const { awaitRunHold, startNarratorRun } = await import("./run");
const {
	clearStreamingSnapshot,
	getSubagentOutputCounts,
	processEvent,
	retireSubagentOutputCharCount,
	startSubagentOutputCharCount,
} = await import("../narrator-event-handler");
const status = spyOn(narratorService, "updateStatus").mockResolvedValue({} as never);
const substatus = spyOn(narratorService, "updateSubstatus").mockResolvedValue(undefined);
let serial = 0;
afterAll(async () => {
	status.mockRestore();
	substatus.mockRestore();
	await closeRuntimeTestDb(sqlite, { sessionTails: true });
	mock.restore();
});

async function parkedFixture() {
	const id = `held-worker-gate-${++serial}`;
	const owner = tryClaimExecution(id, "run");
	if (!owner) throw new Error("Expected a fresh execution owner");
	const run: RunControl = {
		startedAt: Date.now(),
		cancel: new AbortController(),
		timedOut: false,
		terminal: Promise.resolve({
			started: true,
			output: "",
			finalText: "",
			hasError: false,
			interrupted: false,
			timedOut: false,
		}),
	};
	const hold = { released: false };
	setRunControl(owner, run);
	setRunHold(id, hold);
	const observed = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const pending = awaitRunHold(owner, run, async () => {
		const rows = await readNativeRows(
			sqlite,
			"SELECT id FROM narrator_buffered_messages WHERE narrator_id=? LIMIT 1",
			[id],
			{ executionPolicy: "worker-required", maxRows: 1 },
		);
		observed.resolve();
		await gate.promise;
		return rows.length > 0;
	});
	await observed.promise;
	const wake = run.wake;
	if (!wake) throw new Error("Expected this hold's waiter");
	return {
		id,
		owner,
		run,
		hold,
		pending,
		wake,
		releaseProbe: () => gate.resolve(),
		async close() {
			run.cancel.abort("test cleanup");
			gate.resolve();
			await pending;
			setRunControl(owner, undefined);
			setRunHold(id, undefined);
			owner.release();
		},
	};
}

for (const first of ["input", "release"] as const) {
	test(`first ${first} wake survives a later release while a Worker probe returns`, async () => {
		const current = await parkedFixture();
		try {
			expect(isExecutionSuspended(current.id)).toBe(true);
			current.wake(first);
			current.hold.released = true;
			current.wake(first === "input" ? "release" : "input");
			current.releaseProbe();
			expect(await current.pending).toBe(first);
			expect(current.owner.isCurrent()).toBe(true);
			expect(current.run.wake).toBeUndefined();
			expect(isExecutionSuspended(current.id)).toBe(false);
		} finally {
			await current.close();
		}
	});
}

test("whole-run cancellation wins while the Worker input probe is pending", async () => {
	const current = await parkedFixture();
	try {
		current.wake("input");
		current.run.cancel.abort("cancel during Worker probe");
		current.releaseProbe();
		expect(await current.pending).toBe("cancel");
		expect(current.run.wake).toBeUndefined();
	} finally {
		await current.close();
	}
});

function countContext(
	id: string,
	parent: string,
	logicalRunId: string,
): EventHandlerContext & {
	subagentOutputIdentity: NonNullable<EventHandlerContext["subagentOutputIdentity"]>;
} {
	return {
		narratorId: id,
		broadcastTargetId: parent,
		parentToolUseId: "count-agent",
		subagentOutputIdentity: {
			childNarratorId: id,
			logicalRunId,
			toolUseId: "count-agent",
			toolCallId: `${id}-tool`,
			attempt: 1,
		},
		conversationId: "count-conversation",
		getContextUsagePct: () => undefined,
		getMeterUsage: () => undefined,
		getMeterUnit: () => undefined,
		getPartialMessageId: () => undefined,
		getTokenUsage: () => undefined,
		setPartialMessageId: () => {},
		setContextUsagePct: () => {},
		setMeterData: () => {},
		setTokenUsage: () => {},
	};
}

function countBody(ctx: EventHandlerContext, text: string, blockId: string) {
	return processEvent(
		{ type: "stream_text", blockId, blockRevision: 1, blockTextOffset: 0, text },
		ctx,
	);
}

test("a held logical run preserves counts and replay spans when its execution owner rotates to a new pass", async () => {
	const current = await parkedFixture();
	const parent = `${current.id}-parent`;
	const logicalRunId = `${current.id}-logical`;
	current.run.logicalRunId = logicalRunId;
	current.run.deliverTo = {
		narratorId: parent,
		toolUseId: "count-agent",
		toolCallId: `${current.id}-tool`,
		attempt: 1,
	};
	const ctx = countContext(current.id, parent, logicalRunId);
	let next: ReturnType<typeof tryClaimExecution> = null;
	try {
		startSubagentOutputCharCount(current.id, logicalRunId);
		await countBody(ctx, "first", "pass-one");
		expect(isExecutionSuspended(current.id)).toBe(true);
		expect(getSubagentOutputCounts(parent)[0]?.count).toBe(5);
		current.wake("input");
		current.releaseProbe();
		expect(await current.pending).toBe("input");
		expect(current.owner.release()).toBe(true);
		next = tryClaimExecution(current.id, "run");
		if (!next) throw new Error("Expected fresh-pass owner");
		setRunControl(next, current.run);
		clearStreamingSnapshot(current.id);
		startSubagentOutputCharCount(current.id, logicalRunId);
		await countBody(ctx, "first", "pass-one");
		await countBody(ctx, "second", "pass-two");
		expect(getSubagentOutputCounts(parent)).toEqual([
			{ ...ctx.subagentOutputIdentity, count: 11, active: true },
		]);
	} finally {
		retireSubagentOutputCharCount(current.id, logicalRunId);
		if (next) {
			setRunControl(next, undefined);
			next.release();
		}
		clearStreamingSnapshot(current.id);
		await current.close();
	}
});

for (const interrupted of [false, true]) {
	test(`executeRun's ${interrupted ? "interrupted" : "completed"} terminal finalizer retires its count`, async () => {
		const id = `count-terminal-${++serial}`;
		const parent = `${id}-parent`;
		const now = new Date().toISOString();
		await db.insert(narrators).values([
			{ id, title: "Child", createdAt: now, updatedAt: now },
			{ id: parent, title: "Parent", createdAt: now, updatedAt: now },
		]);
		await db.insert(narratorMessages).values({
			id: `${id}-message`,
			narratorId: parent,
			role: "assistant",
			createdAt: now,
			contentJson: [{ type: "tool_use", id: "count-agent", name: "Agent", input: {} }],
		});
		await db.insert(narratorMessageRefs).values({
			id: `${id}-ref`,
			narratorId: parent,
			messageId: `${id}-message`,
			seq: 0,
		});
		await db.insert(narratorToolCalls).values({
			id: `${id}-tool`,
			narratorId: parent,
			messageId: `${id}-message`,
			toolUseId: "count-agent",
			toolName: "Agent",
			inputJson: {},
			status: "initializing",
			executionIdentityVersion: 1,
			executionAttempt: 1,
			createdAt: now,
		});
		const { narratorPersistence } = await import("../narrator-persistence");
		await narratorPersistence.claimToolCallExecution(
			parent,
			"count-agent",
			{ toolCallId: `${id}-tool`, attempt: 1 },
			Date.now(),
		);
		const orchestrator = await import("./orchestrator");
		let runId: string | undefined;
		const pass = spyOn(orchestrator, "runAgentLoopUnlocked").mockImplementation(
			async (_active, _owner, _text, _images, run) => {
				runId = run?.logicalRunId;
				if (!runId || !run) throw new Error("Expected registered logical run");
				expect(getSubagentOutputCounts(parent)[0]?.count).toBe(0);
				const ctx = countContext(id, parent, runId);
				await countBody(ctx, "first", "first");
				await countBody(ctx, "second", "second");
				expect(getSubagentOutputCounts(parent)[0]?.count).toBe(11);
				if (interrupted) run.cancel.abort("test interruption");
				return { started: true, finalText: "finished", aborted: interrupted };
			},
		);
		try {
			const handle = await startNarratorRun({
				narratorId: id,
				locale: "en",
				text: "work",
				principal: null,
				foreground: true,
				deliver: false,
				active: { _currentUserId: null } as import("../narrator-session-state").ActiveNarrator,
				binding: {
					principal: { userId: null },
					deliverTo: {
						narratorId: parent,
						toolUseId: "count-agent",
						toolCallId: `${id}-tool`,
						attempt: 1,
					},
				},
			});
			const result = await handle.completion;
			expect(result.started).toBe(true);
			expect(result.interrupted).toBe(interrupted);
			expect(pass).toHaveBeenCalledTimes(1);
			expect(getSubagentOutputCounts(parent)).toEqual([]);
			if (runId) {
				await countBody(countContext(id, parent, runId), "late", "late");
				expect(getSubagentOutputCounts(parent)).toEqual([]);
			}
		} finally {
			pass.mockRestore();
			if (runId) retireSubagentOutputCharCount(id, runId);
			clearStreamingSnapshot(id);
		}
	});
}

test("an old probe cannot clear or unsuspend a replacement waiter", async () => {
	const current = await parkedFixture();
	try {
		current.wake("input");
		const replacement = () => {};
		current.run.wake = replacement;
		setExecutionSuspended(current.owner, true);
		current.releaseProbe();
		expect(await current.pending).toBe("input");
		expect(current.run.wake).toBe(replacement);
		expect(isExecutionSuspended(current.id)).toBe(true);
	} finally {
		await current.close();
	}
});
