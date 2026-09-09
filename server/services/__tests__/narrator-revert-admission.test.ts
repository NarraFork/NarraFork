import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const session = await import("../narrator-session");
const state = await import("../narrator-session-state");
const { narratorService } = await import("../narrator-service");
const compact = await import("../narrator-compact");
const { deliverInjection } = await import("../narrator-injection");
const { resumeSubagent } = await import("../subagent-resume");
const runner = await import("../subagent-runner");
const pipeline = await import("../../lib/agent/pipeline-state");
const uploads = await import("../../lib/uploads");
const { pushBufferedMessage } = await import("../narrator-buffer");
const { getBackgroundAbortControllers } = await import("../subagent-detach");
const executor = await import("../../lib/agent/tool-executor");
const { narratorPersistence } = await import("../narrator-persistence");
const prepareToolCallAttempt = narratorPersistence.prepareToolCallAttempt.bind(narratorPersistence);
const { sendSubagentMessageDetailed } = await import("../agent-communication");
const { drainPendingInjections } = await import("../parent-injection-queue");

const ROOT = "revert-admission-root";
const CHILD = "revert-admission-child";
const OTHER = "revert-admission-unrelated";
const pendingReleases: Array<() => void> = [];
const rejection = { statusCode: 409, code: "NARRATOR_REVERT_IN_PROGRESS" };

function deferred() {
	return Promise.withResolvers<void>();
}

async function acquire(interrupt = false, signal = new AbortController().signal) {
	const release = await session.acquireNarratorRevertAdmission(ROOT, { interrupt, signal });
	pendingReleases.push(release);
	return release;
}

function makeActive(alive = true): import("../narrator-session-state").ActiveNarrator {
	return {
		narratorId: ROOT,
		conversationId: "test-conversation",
		cwd: process.env.HOME as string,
		model: "test:model",
		provider: "test",
		systemPrompt: null,
		events: new EventEmitter(),
		alive,
		locale: "en",
		abortController: new AbortController(),
		_enabledOptionalTools: new Set(),
		_disabledTools: new Set(),
		_blockedSkills: { all: false, names: new Set() },
		_substatus: new Set(),
	};
}

beforeEach(() => {
	cleanDb(sqlite);
	const now = new Date().toISOString();
	for (const id of [ROOT, OTHER]) {
		db.insert(narrators)
			.values({
				id,
				type: "primary",
				variant: "primary",
				status: "idle",
				cwd: process.env.HOME,
				createdAt: now,
				updatedAt: now,
			})
			.run();
	}
	db.insert(narrators)
		.values({
			id: CHILD,
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId: ROOT,
			status: "idle",
			createdAt: now,
			updatedAt: now,
		})
		.run();
});

afterEach(() => {
	state.bufferedMessages.clear();
	db.delete(narratorBufferedMessages).run();
	for (const release of pendingReleases.splice(0)) release();
	state.activeNarrators.clear();
	getBackgroundAbortControllers().clear();
	drainPendingInjections(ROOT);
	mock.restore();
});

afterAll(() => {
	mock.module("../../db", () => realDb);
});

function childExecutionInput() {
	return {
		narratorId: CHILD,
		subagentId: CHILD,
		parentNarratorId: ROOT,
		toolUseId: "tool",
		subagentType: "general",
		prompt: "input",
		cwd: ".",
		model: "test:model",
		provider: "test",
		locale: "en",
		signal: new AbortController().signal,
		systemPrompt: "test",
		initialHistory: [] as unknown[],
		customDef: null,
	};
}

const blockedEntries: Array<[string, () => Promise<unknown>]> = [
	["direct background runner", () => runner.executeBackgroundTask(childExecutionInput())],
	[
		"direct foreground runner",
		() => {
			const run = runner.startForegroundRun(childExecutionInput());
			return Promise.all([run.foreground, run.terminal]);
		},
	],
	["ensure", () => session.ensureNarrator(ROOT, "en")],
	["plugin narrator deletion", () => session.deleteNarratorForPlugin(ROOT)],
	[
		"send with attachment",
		() =>
			session.sendMessage(ROOT, "send", undefined, "en", false, null, null, [
				new File(["must not write"], "admission.txt"),
			]),
	],
	["continue", () => session.continueNarrator(ROOT)],
	["retry", () => session.retryLastMessage(ROOT)],
	["direct loop", () => session.runAgentLoop(makeActive(), "direct")],
	["automatic spec", () => session.startSpecContinuationIfPossible(ROOT)],
	["automatic background", () => session.startBackgroundCompletionContinuationIfPossible(ROOT)],
	["automatic inbound", () => session.startParentInboundContinuationIfPossible(ROOT)],
	["automatic injection", () => session.startInjectionContinuationIfPossible(ROOT)],
	["buffer", () => session.resumeBufferedMessagesIfIdle(ROOT)],
	["tool reexecution", () => session.reExecuteDeniedToolCall(ROOT, "tool")],
	[
		"persisted tool recovery",
		() => session.executePersistedToolCall({ narratorId: ROOT, toolCallId: "tool-row" }),
	],
	["edit/regenerate", () => session.editAndRegenerate(ROOT, "message", "replacement")],
	["assistant edit", () => session.editAssistantMessage(ROOT, "message", "replacement")],
	["assistant restore", () => session.restoreAssistantMessage(ROOT, "message")],
	["rollback block", () => session.rollbackToBlock(ROOT, "message", 0)],
	["history injection", () => deliverInjection(ROOT, { content: "injected", source: "test" })],
	["partial cleanup", () => session.cleanupPartialMessage("message", ROOT)],
	["partial finalization", () => session.finalizeOrCleanupPartialMessage("message", ROOT)],
	["tool interruption cleanup", () => session.markInterruptedToolCallsForMessage(ROOT, "message")],
	[
		"taken-over background publication",
		() => runner.finalizeTakenOverBackgroundSubagent(CHILD, ROOT, "tool", false, "done"),
	],
	["segment compact", () => compact.runSegmentCompact(ROOT, "en", ["message"])],
	["history compact", () => compact.runCustomCompact(ROOT, "en")],
	["plan compact", () => compact.runPlanCompact(ROOT, "plan")],
	["retry compact", () => compact.retryFailedCompact(ROOT, "en", "message")],
	["delete message", () => narratorService.deleteMessage(ROOT, "message", { skipRevert: true })],
	[
		"delete suffix",
		() => narratorService.deleteMessagesAfter(ROOT, "message", { skipRevert: true }),
	],
	[
		"delete block",
		() => narratorService.deleteMessageBlock(ROOT, "message", 0, { skipRevert: true }),
	],
	["delete compact", () => narratorService.deleteCompactMessage(ROOT, "message")],
	["edit compact", () => narratorService.updateCompactSummary(ROOT, "message", "replacement")],
	[
		"resume child",
		() =>
			resumeSubagent({
				subagentId: CHILD,
				intent: "follow_up",
				actor: "user",
				prompt: "child input",
				locale: "en",
			}),
	],
	[
		"create child",
		() =>
			runner.runSubagent({
				parentNarratorId: ROOT,
				toolUseId: "tool",
				subagentType: "general",
				prompt: "child input",
				cwd: ".",
				signal: new AbortController().signal,
				locale: "en",
			}),
	],
	[
		"continue child",
		() =>
			runner.startContinuedSubagent({
				subagentId: CHILD,
				parentNarratorId: ROOT,
				toolUseId: "tool",
				prompt: "child input",
				signal: new AbortController().signal,
				locale: "en",
			}),
	],
	[
		"publish child",
		() =>
			session.updateToolCallConclusion({
				subagentId: CHILD,
				parentNarratorId: ROOT,
				toolUseId: "tool",
				finalText: "done",
				hasError: false,
			}),
	],
];

describe("exclusive revert blocks every service entry before writes", () => {
	for (const [label, run] of blockedEntries) {
		test(label, async () => {
			const releaseRuntime = state.claimNarratorRuntime(ROOT, "queue-setup");
			await pushBufferedMessage(ROOT, "preserved queued input");
			releaseRuntime();
			await acquire();
			const before = sqlite.query("SELECT * FROM narrators ORDER BY id").all();
			const messages = sqlite.query("SELECT * FROM narrator_messages").all();
			const queue = sqlite.query("SELECT * FROM narrator_buffered_messages").all();
			const save = spyOn(uploads, "saveTextFileToWorktree").mockImplementation(async () => {
				throw new Error("Unexpected attachment write");
			});
			await expect(run()).rejects.toMatchObject(rejection);
			expect(save).not.toHaveBeenCalled();
			expect(sqlite.query("SELECT * FROM narrators ORDER BY id").all()).toEqual(before);
			expect(sqlite.query("SELECT * FROM narrator_messages").all()).toEqual(messages);
			expect(sqlite.query("SELECT * FROM narrator_buffered_messages").all()).toEqual(queue);
			expect(state.bufferedMessages.get(ROOT)?.map((entry) => entry.text)).toEqual([
				"preserved queued input",
			]);
		});
	}
});

test("admission root traversal and acquisition read only bounded identity metadata", async () => {
	const largeText = "large narrator payload ".repeat(16_384);
	db.update(narrators).set({ systemPrompt: largeText, contextSummary: largeText }).run();
	const fullRow = spyOn(narratorService, "getById").mockImplementation(async () => {
		throw new Error("Admission must not load a full narrator row");
	});
	const lookup = spyOn(db.query.narrators, "findFirst");
	expect(await state.resolveNarratorAdmissionRoot(CHILD)).toBe(ROOT);
	await acquire();
	expect(fullRow).not.toHaveBeenCalled();
	expect(lookup).toHaveBeenCalledTimes(3);
	for (const [options] of lookup.mock.calls) {
		expect(options?.columns).toEqual({ id: true, variant: true, parentNarratorId: true });
	}
});

test("minimal admission reads preserve missing narrator errors", async () => {
	for (const request of [
		() => state.resolveNarratorAdmissionRoot("missing-admission-narrator"),
		() =>
			session.acquireNarratorRevertAdmission("missing-admission-narrator", {
				signal: new AbortController().signal,
				interrupt: false,
			}),
	]) {
		await expect(request()).rejects.toMatchObject({
			statusCode: 404,
			code: "NOT_FOUND",
			message: "Narrator not found: missing-admission-narrator",
		});
	}
});

test("minimal root metadata still follows variant rather than type and detects cycles", async () => {
	db.update(narrators)
		.set({ type: "subagent", parentNarratorId: CHILD })
		.where(eq(narrators.id, ROOT))
		.run();
	expect(await state.resolveNarratorAdmissionRoot(CHILD)).toBe(ROOT);
	db.update(narrators).set({ variant: "subagent:general" }).where(eq(narrators.id, ROOT)).run();
	await expect(state.resolveNarratorAdmissionRoot(CHILD)).rejects.toMatchObject({
		statusCode: 409,
		code: "NARRATOR_ADMISSION_ROOT_INVALID",
	});
});

test("release drains preserved buffered input exactly once", async () => {
	const releaseRuntime = state.claimNarratorRuntime(ROOT, "queue-setup");
	await pushBufferedMessage(ROOT, "deliver once after revert");
	releaseRuntime();
	const release = await acquire();
	const committed = deferred();
	const persist = narratorService.persistUserMessage;
	spyOn(narratorService, "persistUserMessage").mockImplementation(async (...args) => {
		const message = await persist(...args);
		committed.resolve();
		return message;
	});
	state.activeNarrators.set(ROOT, makeActive());
	release();
	release();
	await committed.promise;
	await state.waitForNarratorAdmissionWork(ROOT, AbortSignal.timeout(5_000));
	expect(state.bufferedMessages.get(ROOT)).toBeUndefined();
	expect(await db.select().from(narratorBufferedMessages)).toEqual([]);
	expect(
		(await db.select().from(narratorMessages)).filter(
			(message) => message.role === "user" && message.contentText === "deliver once after revert",
		),
	).toHaveLength(1);
});

async function seedAwaitReexecution(recovery: boolean, suffix = "") {
	const messageId = `rerun-message${suffix}`;
	const toolCallId = `rerun-row${suffix}`;
	const toolUseId = `rerun-await${suffix}`;
	const now = new Date().toISOString();
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId: ROOT,
		role: "assistant",
		contentJson: [{ type: "tool_use", id: toolUseId, name: "Await", input: { id: CHILD } }],
		createdAt: now,
	});
	await db.insert(narratorMessageRefs).values({
		id: `ref${suffix}`,
		narratorId: ROOT,
		messageId,
		seq: suffix ? 2 : 1,
	});
	await db.insert(narratorToolCalls).values({
		id: toolCallId,
		narratorId: ROOT,
		messageId,
		toolUseId,
		toolName: "Await",
		inputJson: { id: CHILD },
		executionIdentityVersion: 1,
		executionAttempt: 1,
		status: recovery ? "initializing" : "fail",
		permissionDecidedBy: recovery ? null : "user",
		createdAt: now,
	});
	// A normal retry must initially have no active session. Install the lightweight
	// fixture only after the real admission and persisted-attempt checks have run.
	spyOn(narratorPersistence, "prepareToolCallAttempt").mockImplementation(async (...args) => {
		const result = await prepareToolCallAttempt(...args);
		state.activeNarrators.set(ROOT, makeActive());
		return result;
	});
	return { toolCallId, toolUseId };
}

for (const recovery of [false, true]) {
	test(`${recovery ? "recovery" : "denied retry"} Await releases the start mutex for independent child Send(parent)`, async () => {
		const row = await seedAwaitReexecution(recovery);
		await db.update(narrators).set({ isBackground: true }).where(eq(narrators.id, CHILD));
		const entered = deferred();
		const sendNow = deferred();
		const done = deferred();
		const finish = deferred();
		const child = state.withNarratorWorkAdmission(CHILD, async () => {
			await sendNow.promise;
			const result = await sendSubagentMessageDetailed({
				callerNarratorId: CHILD,
				id: "parent",
				message: "independent child is ready",
				toolUseId: "child-send",
				signal: new AbortController().signal,
				locale: "en",
			});
			done.resolve();
			expect(result.targets).toEqual([expect.objectContaining({ status: "queued" })]);
		});
		const execute = spyOn(executor, "executeTool").mockImplementation(
			async (tool, config, options) => {
				const binding = options?.toolCallBinding;
				if (!binding) throw new Error("Missing exact tool-call binding");
				await config.onToolExecutionStarting?.(tool.toolUseId, binding, Date.now());
				entered.resolve();
				await done.promise;
				await finish.promise;
				return { output: "child completed", isError: false, durationMs: 1 };
			},
		);
		const outerClaim = recovery
			? state.claimNarratorRuntime(ROOT, "recovery-controller")
			: () => {};
		const running = recovery
			? session.executePersistedToolCall({ narratorId: ROOT, toolCallId: row.toolCallId })
			: session.reExecuteDeniedToolCall(ROOT, row.toolUseId, "en", false, null, {
					autoContinue: true,
				});
		try {
			await entered.promise;
			expect(state.isNarratorRuntimeBusy(ROOT)).toBe(true);
			expect(await session.reconcileRunningStatus(ROOT)).toBe(false);
			expect(await session.reExecuteDeniedToolCall(ROOT, row.toolUseId)).toEqual({
				ok: false,
				reason: "narrator_busy",
			});
			expect(await session.runAgentLoop(makeActive(), "second loop")).toEqual({ started: false });
			expect(await session.startParentInboundContinuationIfPossible(ROOT)).toEqual({
				started: false,
			});
			sendNow.resolve();
			await child;
			await expect(acquire()).rejects.toMatchObject({ code: "NARRATOR_REVERT_BUSY" });
			outerClaim();
			const active = state.activeNarrators.get(ROOT);
			if (!active) throw new Error("Reexecution lost its active session");
			const aborted = deferred();
			active.abortController.signal.addEventListener("abort", () => aborted.resolve(), {
				once: true,
			});
			let granted = false;
			const exclusive = acquire(true).then((release) => {
				granted = true;
				return release;
			});
			await aborted.promise;
			expect(granted).toBe(false);
			finish.resolve();
			expect(await running).toEqual({ ok: true, shouldContinue: true });
			await exclusive;
			expect(granted).toBe(true);
			expect(execute).toHaveBeenCalledTimes(1);
			expect(state.hasNarratorRuntimeClaim(ROOT)).toBe(false);
			expect(state.hasNarratorAdmissionWork(ROOT)).toBe(false);
		} finally {
			outerClaim();
			sendNow.resolve();
			done.resolve();
			finish.resolve();
			await Promise.allSettled([child, running]);
		}
	});
}

test("parallel persisted recovery requests serialize execution without retaining the start mutex", async () => {
	const first = await seedAwaitReexecution(true);
	const second = await seedAwaitReexecution(true, "-second");
	const entered = deferred();
	const finish = deferred();
	const order: string[] = [];
	const execute = spyOn(executor, "executeTool").mockImplementation(async (tool) => {
		order.push(tool.toolUseId);
		if (tool.toolUseId === first.toolUseId) {
			entered.resolve();
			await finish.promise;
		}
		return { output: "recovered", isError: false, durationMs: 1 };
	});
	const releaseOuter = state.claimNarratorRuntime(ROOT, "recovery-batch");
	const a = session.executePersistedToolCall({ narratorId: ROOT, toolCallId: first.toolCallId });
	await entered.promise;
	const b = session.executePersistedToolCall({ narratorId: ROOT, toolCallId: second.toolCallId });
	try {
		expect(await session.startParentInboundContinuationIfPossible(ROOT)).toEqual({
			started: false,
		});
		expect(execute).toHaveBeenCalledTimes(1);
		finish.resolve();
		expect(await a).toEqual({ ok: true, shouldContinue: true });
		expect(await b).toEqual({ ok: true, shouldContinue: true });
		expect(order).toEqual([first.toolUseId, second.toolUseId]);
		expect(state.hasNarratorRuntimeClaim(ROOT)).toBe(true);
	} finally {
		finish.resolve();
		await Promise.allSettled([a, b]);
		releaseOuter();
	}
	expect(state.isNarratorRuntimeBusy(ROOT)).toBe(false);
	await acquire();
});

test("successful retry hands its foreground slot to automatic continuation", async () => {
	const row = await seedAwaitReexecution(false);
	spyOn(executor, "executeTool").mockResolvedValue({
		output: "replayed result",
		isError: false,
		durationMs: 1,
	});
	const history = narratorService.getModelHistorySinceLastCompact.bind(narratorService);
	const continuation = spyOn(narratorService, "getModelHistorySinceLastCompact").mockImplementation(
		async (...args) => {
			// This is the continuation's initial history read, still inside the handoff lock.
			expect(state.hasNarratorRuntimeClaim(ROOT)).toBe(false);
			return history(...args);
		},
	);
	expect(await session.reExecuteDeniedToolCall(ROOT, row.toolUseId)).toEqual({ ok: true });
	expect(continuation).toHaveBeenCalled();
	await state.waitForNarratorAdmissionWork(ROOT, AbortSignal.timeout(5_000));
	expect(state.hasNarratorRuntimeClaim(ROOT)).toBe(false);
});

test("failed reexecution releases its work and runtime claims after cleanup", async () => {
	const row = await seedAwaitReexecution(true);
	spyOn(executor, "executeTool").mockRejectedValue(new Error("controlled execution failure"));
	expect(
		await session.executePersistedToolCall({ narratorId: ROOT, toolCallId: row.toolCallId }),
	).toEqual({
		ok: true,
		shouldContinue: false,
	});
	expect(state.isNarratorRuntimeBusy(ROOT)).toBe(false);
	expect(state.activeNarrators.has(ROOT)).toBe(false);
	expect(state.hasNarratorAdmissionWork(ROOT)).toBe(false);
	await acquire();
});

test("cancellation retries the real loop finalizer's consumed waiting-gate wakeup", async () => {
	const entered = deferred();
	const cleanup = deferred();
	spyOn(pipeline, "clearPipelineStateIfActive").mockImplementation(async () => {
		entered.resolve();
		await cleanup.promise;
		return false;
	});
	const active = makeActive(false);
	state.activeNarrators.set(ROOT, active);
	const running = session.runAgentLoop(active, "");
	await entered.promise;
	await pushBufferedMessage(ROOT, "after refused finalizer wakeup");
	const controller = new AbortController();
	const interrupted = deferred();
	active.abortController.signal.addEventListener("abort", () => interrupted.resolve(), {
		once: true,
	});
	const requested = acquire(true, controller.signal).catch((error: unknown) => error);
	await interrupted.promise;
	cleanup.resolve();
	await running;
	expect(active._resumeBufferedAfterLoop).toBe(false);
	expect(state.bufferedMessages.get(ROOT)).toHaveLength(1);
	const committed = deferred();
	const persist = narratorService.persistUserMessage;
	spyOn(narratorService, "persistUserMessage").mockImplementation(async (...args) => {
		const message = await persist(...args);
		committed.resolve();
		return message;
	});
	state.activeNarrators.set(ROOT, makeActive());
	controller.abort(new Error("cancel after finalizer"));
	expect(await requested).toBeInstanceOf(Error);
	await committed.promise;
	await state.waitForNarratorAdmissionWork(ROOT, AbortSignal.timeout(5_000));
	expect(state.bufferedMessages.get(ROOT)).toBeUndefined();
	expect(
		(await db.select().from(narratorMessages)).filter((message) => message.role === "user"),
	).toHaveLength(1);
});

for (const timeout of [false, true]) {
	for (const settlesLate of [false, true]) {
		test(`${timeout ? "timeout" : "cancel"} wakes buffered input when work settles ${settlesLate ? "after" : "before"} release`, async () => {
			const entered = deferred();
			const finish = deferred();
			const active = makeActive();
			state.activeNarrators.set(ROOT, active);
			const work = state.withNarratorWorkAdmission(ROOT, async () => {
				const releaseRuntime = state.claimNarratorRuntime(ROOT, "late-work");
				try {
					entered.resolve();
					await finish.promise;
				} finally {
					releaseRuntime();
				}
			});
			await entered.promise;
			const text = `${timeout}-${settlesLate} queued input`;
			await pushBufferedMessage(ROOT, text);
			const committed = deferred();
			const persist = narratorService.persistUserMessage;
			spyOn(narratorService, "persistUserMessage").mockImplementation(async (...args) => {
				const message = await persist(...args);
				committed.resolve();
				return message;
			});
			const interrupted = deferred();
			active.abortController.signal.addEventListener("abort", () => interrupted.resolve(), {
				once: true,
			});
			const controller = new AbortController();
			const signal = timeout ? AbortSignal.timeout(25) : controller.signal;
			const requested = acquire(true, signal).then(
				() => null,
				(error: unknown) => error,
			);
			await interrupted.promise;
			if (!settlesLate) {
				finish.resolve();
				await work;
				// Reproduce the loop finalizer's already-consumed, gate-refused wakeup.
				await expect(session.resumeBufferedMessagesIfIdle(ROOT)).rejects.toMatchObject(rejection);
			}
			state.activeNarrators.set(ROOT, makeActive());
			if (!timeout) controller.abort(new Error("cancel waiting revert"));
			expect(await requested).toBeInstanceOf(Error);
			expect(state.isNarratorRevertAdmissionBlocked(ROOT)).toBe(false);
			if (settlesLate) {
				expect(await session.resumeBufferedMessagesIfIdle(ROOT)).toEqual({ resumed: false });
				expect(state.bufferedMessages.get(ROOT)).toHaveLength(1);
				finish.resolve();
				await work;
			}
			await committed.promise;
			await state.waitForNarratorAdmissionWork(ROOT, AbortSignal.timeout(5_000));
			expect(state.bufferedMessages.get(ROOT)).toBeUndefined();
			expect(await db.select().from(narratorBufferedMessages)).toEqual([]);
			expect(
				(await db.select().from(narratorMessages)).filter(
					(message) => message.role === "user" && message.contentText === text,
				),
			).toHaveLength(1);
		});
	}
}

test("SSE feed refuses without persisting a user message", async () => {
	await acquire();
	const events = [];
	for await (const event of session.startSession(ROOT, "SSE input")) events.push(event.type);
	expect(events).toEqual(["error", "done"]);
	expect(await db.select().from(narratorMessages)).toEqual([]);
});

test("a primary fork is independent; ownership follows child parent links, not cwd", async () => {
	await acquire();
	await deliverInjection(OTHER, { content: "other narrator", source: "test" });
	expect(await db.select().from(narratorMessages)).toHaveLength(1);
	await expect(
		deliverInjection(CHILD, { content: "child narrator", source: "test" }),
	).rejects.toMatchObject(rejection);
	await expect(
		session.acquireNarratorRevertAdmission(CHILD, {
			signal: new AbortController().signal,
			interrupt: false,
		}),
	).rejects.toMatchObject({ statusCode: 409, code: "NARRATOR_REVERT_SUBAGENT_UNSUPPORTED" });
});

test("continuation admission wins before its first write: non-interrupting revert refuses", async () => {
	const entered = deferred();
	const proceed = deferred();
	const history = spyOn(narratorService, "getModelHistorySinceLastCompact").mockImplementation(
		async () => {
			entered.resolve();
			await proceed.promise;
			throw new Error("controlled pre-write stop");
		},
	);
	const continuation = session.continueNarrator(ROOT).catch((error) => error);
	await entered.promise;
	try {
		await expect(acquire()).rejects.toMatchObject({
			statusCode: 409,
			code: "NARRATOR_REVERT_BUSY",
		});
		expect(await db.select().from(narratorMessages)).toEqual([]);
	} finally {
		proceed.resolve();
		await continuation;
		history.mockRestore();
	}
	await acquire();
});

test("complete finally remains busy after _loopRunning and alive clear", async () => {
	const entered = deferred();
	const cleanup = deferred();
	const clear = spyOn(pipeline, "clearPipelineStateIfActive").mockImplementation(async () => {
		entered.resolve();
		await cleanup.promise;
		return false;
	});
	const active = makeActive(false);
	state.activeNarrators.set(ROOT, active);
	const running = session.runAgentLoop(active, "");
	await entered.promise;
	const controller = new AbortController();
	let granted = false;
	let exclusive: Promise<() => void> | undefined;
	try {
		expect(active._loopRunning).toBe(false);
		expect(active.alive).toBe(false);
		expect(session.isLoopRunning(ROOT)).toBe(true);
		await expect(acquire()).rejects.toMatchObject({ code: "NARRATOR_REVERT_BUSY" });
		exclusive = acquire(true, controller.signal).then((release) => {
			granted = true;
			return release;
		});
		await Promise.resolve();
		expect(granted).toBe(false);
	} finally {
		cleanup.resolve();
		await running;
		await exclusive;
		clear.mockRestore();
	}
	expect(granted).toBe(true);
	expect(state.hasNarratorAdmissionWork(ROOT)).toBe(false);
});

test("interrupt waits for background child publication without changing parent normal busy", async () => {
	const entered = deferred();
	const publish = deferred();
	const controller = new AbortController();
	getBackgroundAbortControllers().set(CHILD, controller);
	const work = state.withNarratorWorkAdmission(CHILD, async () => {
		entered.resolve();
		await publish.promise;
		await deliverInjection(ROOT, { source: "test", content: "child publication" });
	});
	await entered.promise;
	expect(state.isNarratorRuntimeBusy(ROOT)).toBe(false);
	await expect(acquire()).rejects.toMatchObject({ code: "NARRATOR_REVERT_BUSY" });
	const aborted = new Promise<void>((resolve) =>
		controller.signal.addEventListener("abort", () => resolve(), { once: true }),
	);
	const exclusive = acquire(true);
	await aborted;
	expect(state.isNarratorRevertAdmissionBlocked(ROOT)).toBe(true);
	publish.resolve();
	await work;
	await exclusive;
	expect((await db.select().from(narratorMessages))[0]?.contentText).toBe("child publication");
});

test("cancellation before acquisition releases only the waiting reservation", async () => {
	const entered = deferred();
	const leave = deferred();
	const work = state.withNarratorStartAdmission(ROOT, async () => {
		entered.resolve();
		await leave.promise;
	});
	await entered.promise;
	const active = makeActive();
	state.activeNarrators.set(ROOT, active);
	const interrupted = deferred();
	active.abortController.signal.addEventListener("abort", () => interrupted.resolve(), {
		once: true,
	});
	const controller = new AbortController();
	const requested = acquire(true, controller.signal);
	await interrupted.promise;
	expect(state.isNarratorRevertAdmissionBlocked(ROOT)).toBe(true);
	controller.abort(new Error("cancel pending acquisition"));
	// Capture the reason after abort; no ownership can have been granted while work is live.
	await expect(requested).rejects.toThrow("cancel pending acquisition");
	expect(state.isNarratorRevertAdmissionBlocked(ROOT)).toBe(false);
	leave.resolve();
	await work;
	await acquire();
});

test("already aborted requests leak no reservation; acquired lease ignores abort and release is idempotent", async () => {
	await expect(acquire(false, AbortSignal.abort(new Error("already cancelled")))).rejects.toThrow(
		"already cancelled",
	);
	const controller = new AbortController();
	const release = await acquire(false, controller.signal);
	controller.abort();
	await expect(
		deliverInjection(ROOT, { source: "test", content: "not yet" }),
	).rejects.toMatchObject(rejection);
	release();
	const nextRelease = await acquire();
	release();
	await expect(
		deliverInjection(ROOT, { source: "test", content: "still held" }),
	).rejects.toMatchObject(rejection);
	nextRelease();
	await deliverInjection(ROOT, { source: "test", content: "released" });
	expect((await db.select().from(narratorMessages))[0]?.contentText).toBe("released");
});

test("legacy resume-to-edit and start-to-resume orders share one reentrant mutex", async () => {
	const { withSubagentResumeLock } = await import("../subagent-resume");
	const entered = deferred();
	const proceed = deferred();
	const order: string[] = [];
	const legacy = withSubagentResumeLock(CHILD, async () => {
		entered.resolve();
		await proceed.promise;
		await state.withNarratorStartAdmission(CHILD, async () => {
			order.push("legacy/edit");
		});
	});
	await entered.promise;
	const resume = state.withNarratorStartAdmission(CHILD, () =>
		withSubagentResumeLock(CHILD, async () => {
			order.push("start/resume");
		}),
	);
	proceed.resolve();
	await Promise.all([legacy, resume]);
	expect(order).toEqual(["legacy/edit", "start/resume"]);
});

test("an outer request's work lease does not make interruptAndWaitForIdle wait for itself", async () => {
	const active = makeActive();
	active._loopRunning = true;
	state.activeNarrators.set(ROOT, active);
	active.abortController.signal.addEventListener(
		"abort",
		() => {
			active._loopRunning = false;
			active.alive = false;
		},
		{ once: true },
	);
	await state.withNarratorWorkAdmission(ROOT, async () => {
		expect(state.hasNarratorAdmissionWork(ROOT)).toBe(true);
		expect(await session.interruptAndWaitForIdle(ROOT, { timeoutMs: 500 })).toBe(true);
		expect(state.hasNarratorAdmissionWork(ROOT)).toBe(true);
	});
});

test("nested start transactions are reentrant but escaped async work cannot reuse expired admission", async () => {
	const later = deferred();
	let escaped!: Promise<unknown>;
	await state.withNarratorStartAdmission(ROOT, async () => {
		await state.withNarratorStartAdmission(ROOT, async () => {});
		escaped = later.promise.then(() => deliverInjection(ROOT, { source: "test", content: "late" }));
	});
	await acquire();
	later.resolve();
	await expect(escaped).rejects.toMatchObject(rejection);
});
