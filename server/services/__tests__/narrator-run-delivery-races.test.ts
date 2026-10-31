/**
 * How a run's result reaches its destination when control actions race the finalizer,
 * and when a session projected as a background task runs again. Only the model pass is
 * scripted; run service, orchestrator, task projection and publication are real.
 *
 *  A. detach vs finalizer, both orders: one delivery, a terminal task row (or none),
 *     and the caller receives what was actually delivered to it.
 *  B. a released hold leaves no durable `taken_over` mirror behind.
 *  C. a new run of an ended background task reopens the task row for that run; its
 *     terminal is delivered once, to the new run, past an Await of the old one.
 *  D. every run re-announces the destination's tool card with the model it uses.
 *  F. a parked held result is delivered under the run's registered principal.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import {
	backgroundTasks,
	fileChangeExecutionSegments,
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	runtimeAwaitedTerminalConsumptions,
	runtimePublicationOutbox,
	userPreferences,
	users,
} from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";
import { readRuntimeRegistrationColumn } from "../../lib/validators/runtime-registration";

import type { ExecuteLoopOptions, ExecuteLoopResult } from "../narrator-executor";

// The snapshot worker shares the preload-isolated file-backed database.
const { db, sqlite } = await import("../../db");
const { closePrefixSnapshotStore } = await import("../narrator-prefix-snapshots");
const broadcasts: Array<{ target: string; event: Record<string, unknown> }> = [];
const realWs = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({
	...realWs,
	broadcastToNarrator: (target: string, event: Record<string, unknown>) => {
		broadcasts.push({ target, event });
	},
}));
const { registerExternalProviderResolver } = await import("../../lib/agent/provider");
const { settings } = await import("../../lib/settings");
const executor = await import("../narrator-executor");
const { DISABLED_TOOLS_TRAIT_PREFIX, upsertEncodedTrait } = await import(
	"../../lib/narrator-custom-traits"
);
const { awaitRunHold, controlRun, hydrateRunHolds, startNarratorRun, wakeHeldRun } = await import(
	"../agent-runtime/run"
);
const { getExecutionOwner, getRunControl, getRunHold, setRunHold } = await import(
	"../agent-runtime/ownership"
);
const { createAgentMessageDelivery } = await import("../agent-message-delivery");
const inbox = await import("../agent-runtime/inbox");
const session = await import("../narrator-session");
const buffer = await import("../narrator-buffer");
const { backgroundTaskService } = await import("../background-task-service");
const { getRuntimePublicationService, runtimePublication } = await import(
	"../agent-runtime/publication"
);
const { activeNarrators } = await import("../narrator-session-state");
const parentInjection = await import("../parent-injection-queue");

const provider: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: async () => ({ history: [] }),
	injectSystemPrompt: () => {},
	chat() {
		throw new Error("Test must never call a model");
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
const unregisterProvider = registerExternalProviderResolver({
	resolve: (name) => (name === "test" ? provider : null),
	listReadiness: () => [],
});

const CALLER = "race-caller";
const RUN = "race-run";
const ORIGIN = "race-origin";
const ORIGIN_ROW = "race-origin-row";
const NOW = "2026-09-30T00:00:00.000Z";
let cwd: string;
let seq = 0;

beforeEach(async () => {
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
	seq = 0;
	broadcasts.length = 0;
	settings.agent.autoContinuationMode = "off";
	cwd = mkdtempSync(join(tmpdir(), "nf-run-races-"));
	runtimePublication.stop();
});
afterEach(async () => {
	getExecutionOwner(RUN)?.release();
	activeNarrators.delete(RUN);
	setRunHold(RUN, undefined);
	mock.restore();
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
	rmSync(cwd, { recursive: true, force: true });
});
afterAll(async () => {
	await closePrefixSnapshotStore();
	unregisterProvider();
	mock.module("../../websocket/narrator-ws", () => realWs);
});

function seed() {
	db.insert(narrators)
		.values([
			{ id: CALLER, variant: "primary", cwd, createdAt: NOW, updatedAt: NOW },
			{
				id: RUN,
				type: "subagent",
				variant: "subagent:general",
				parentNarratorId: CALLER,
				subagentType: "general",
				cwd,
				status: "idle",
				model: "test:model",
				autoContinuationOverride: "off",
				createdAt: NOW,
				updatedAt: NOW,
			},
		])
		.run();
	db.insert(narratorMessages)
		.values({
			id: "origin-message",
			narratorId: CALLER,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: ORIGIN, name: "Agent", input: {} }],
			createdAt: NOW,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: "origin-ref", narratorId: CALLER, messageId: "origin-message", seq: seq++ })
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: ORIGIN_ROW,
			narratorId: CALLER,
			messageId: "origin-message",
			toolUseId: ORIGIN,
			toolName: "Agent",
			inputJson: {},
			outputJson: "PENDING",
			status: "running",
			executionIdentityVersion: 1,
			executionAttempt: 1,
			createdAt: NOW,
		})
		.run();
}

const binding = (extra: Record<string, unknown> = {}) => ({
	deliverTo: { narratorId: CALLER, toolUseId: ORIGIN, toolCallId: ORIGIN_ROW, attempt: 1 },
	cancelWith: { narratorId: CALLER, toolCallId: ORIGIN_ROW, attempt: 1 },
	principal: { userId: null },
	...extra,
});

/** A background session: its runs deliver through the task row. */
const backgroundBinding = () => {
	const base = binding({ cancelWith: undefined });
	return { ...base, deliverTo: { ...base.deliverTo, viaTask: true as const } };
};

/** Scripted model passes: each step may block, then replies with a persisted answer. */
function scriptPasses(
	steps: Array<(options: ExecuteLoopOptions) => Promise<Partial<ExecuteLoopResult> | undefined>>,
) {
	const calls: ExecuteLoopOptions[] = [];
	spyOn(executor, "executeAgentLoop").mockImplementation(async (options) => {
		calls.push(options);
		const step = steps[calls.length - 1];
		const result = (step ? await step(options) : undefined) ?? {};
		const finalText = result.finalText ?? `reply ${calls.length}`;
		const id = `reply-${calls.length}-${seq}`;
		db.insert(narratorMessages)
			.values({
				id,
				narratorId: RUN,
				role: "assistant",
				contentText: finalText,
				contentJson: [{ type: "text", text: finalText }],
				parentToolUseId: ORIGIN,
				createdAt: NOW,
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: `ref-${id}`, narratorId: RUN, messageId: id, seq: seq++ })
			.run();
		return { finalText, hasError: false, shouldUpdateTitle: false, ...result } as ExecuteLoopResult;
	});
	return calls;
}

const toolOutput = () =>
	String(
		db.select().from(narratorToolCalls).where(eq(narratorToolCalls.id, ORIGIN_ROW)).get()
			?.outputJson,
	);
const taskRow = () => db.select().from(backgroundTasks).where(eq(backgroundTasks.id, RUN)).get();
const sessionRow = () => db.select().from(narrators).where(eq(narrators.id, RUN)).get();
const delivered = (logicalRunId: string | undefined) =>
	db
		.select()
		.from(runtimePublicationOutbox)
		.where(eq(runtimePublicationOutbox.logicalRunId, logicalRunId ?? ""))
		.all()
		.filter((row) => row.eventKind !== "started" && row.state !== "reserved");
const consumed = (logicalRunId: string | undefined) =>
	db
		.select()
		.from(runtimeAwaitedTerminalConsumptions)
		.where(eq(runtimeAwaitedTerminalConsumptions.logicalRunId, logicalRunId ?? ""))
		.all();
const notices = () =>
	db
		.select()
		.from(narratorBufferedMessages)
		.where(
			and(
				eq(narratorBufferedMessages.narratorId, CALLER),
				eq(narratorBufferedMessages.kind, "task_notice"),
			),
		)
		.all();

async function settle(condition: () => boolean) {
	for (let i = 0; i < 400 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
	expect(condition()).toBe(true);
}

describe("A. detach and the finalizer", () => {
	test("finalizer first: a later detach is refused and the caller gets the terminal", async () => {
		seed();
		const gate = Promise.withResolvers<void>();
		scriptPasses([
			async () => {
				await gate.promise;
				return { finalText: "the real answer" };
			},
		]);
		// Hold the finalizer between its claim and its delivery.
		const publication = getRuntimePublicationService();
		const commit = publication.commitAgentTerminal.bind(publication);
		const inCommit = Promise.withResolvers<void>();
		const releaseCommit = Promise.withResolvers<void>();
		spyOn(publication, "commitAgentTerminal").mockImplementation(async (input) => {
			inCommit.resolve();
			await releaseCommit.promise;
			return commit(input);
		});
		const handle = await startNarratorRun({
			narratorId: RUN,
			locale: "en",
			text: "work",
			binding: binding(),
			foreground: true,
		});
		await settle(() => !!getRunControl(RUN)?.logicalRunId);
		gate.resolve();
		await inCommit.promise;
		expect(await controlRun(RUN, { kind: "detach" })).toBe(false);
		releaseCommit.resolve();
		const result = await handle.foreground;
		expect(result.handoff).toBeUndefined();
		expect(result.output).toContain("the real answer");
		// Delivered once, as the caller's own tool result (stored and consumed together,
		// never a notice); no task row was created.
		const terminal = await handle.terminal;
		expect(consumed(terminal.logicalRunId)).toHaveLength(1);
		expect(delivered(terminal.logicalRunId)).toHaveLength(0);
		expect(publication.commitAgentTerminal).toHaveBeenCalledTimes(1);
		expect(taskRow()).toBeUndefined();
		expect(sessionRow()?.isBackground).toBe(false);
	});

	test("detach first: the finalizer waits for the task row and delivers through it", async () => {
		seed();
		const gate = Promise.withResolvers<void>();
		scriptPasses([
			async () => {
				await gate.promise;
				return { finalText: "answer after detach" };
			},
		]);
		// Hold the detach inside the task-row registration.
		const create = backgroundTaskService.createAgentTask.bind(backgroundTaskService);
		const inCreate = Promise.withResolvers<void>();
		const releaseCreate = Promise.withResolvers<void>();
		spyOn(backgroundTaskService, "createAgentTask").mockImplementation(async (opts) => {
			inCreate.resolve();
			await releaseCreate.promise;
			return create(opts);
		});
		const handle = await startNarratorRun({
			narratorId: RUN,
			locale: "en",
			text: "work",
			binding: binding(),
			foreground: true,
		});
		await settle(() => !!getRunControl(RUN)?.logicalRunId);
		const detached = controlRun(RUN, { kind: "detach" });
		await inCreate.promise;
		// The run ends while the detach is still registering its task row.
		gate.resolve();
		await settle(() => getRunControl(RUN)?.finalizing === true);
		releaseCreate.resolve();
		expect(await detached).toBe(true);
		const handoff = await handle.foreground;
		expect(handoff.handoff).toBe(true);
		expect(handoff.output).toContain("<background_task_id>");
		const terminal = await handle.terminal;
		// Delivered once through the task row, which ends terminal; never consumed as a
		// foreground result, and the handoff is not mistaken for a conclusion.
		expect(taskRow()?.status).toBe("completed");
		expect(taskRow()?.logicalRunId).toBe(terminal.logicalRunId);
		expect(taskRow()?.output).toContain("answer after detach");
		expect(delivered(terminal.logicalRunId)).toHaveLength(1);
		expect(consumed(terminal.logicalRunId)).toHaveLength(0);
		expect(toolOutput()).not.toContain("answer after detach");
	});

	test("a failed detach hands nothing back: the caller still gets the terminal", async () => {
		seed();
		const gate = Promise.withResolvers<void>();
		scriptPasses([
			async () => {
				await gate.promise;
				return { finalText: "kept in the foreground" };
			},
		]);
		spyOn(backgroundTaskService, "createAgentTask").mockRejectedValueOnce(
			new Error("task row unavailable"),
		);
		const handle = await startNarratorRun({
			narratorId: RUN,
			locale: "en",
			text: "work",
			binding: binding(),
			foreground: true,
		});
		await settle(() => !!getRunControl(RUN)?.logicalRunId);
		await expect(controlRun(RUN, { kind: "detach" })).rejects.toThrow("task row unavailable");
		expect(getRunControl(RUN)?.waiter).toBeDefined();
		gate.resolve();
		const result = await handle.foreground;
		expect(result.handoff).toBeUndefined();
		expect(result.output).toContain("kept in the foreground");
		expect(taskRow()).toBeUndefined();
		expect(sessionRow()?.isBackground).toBe(false);
	});
});

describe("B. a released hold", () => {
	test("a release during the run drops the durable mirror when the run ends", async () => {
		seed();
		const gate = Promise.withResolvers<void>();
		scriptPasses([
			async () => {
				await gate.promise;
				return { finalText: "held answer" };
			},
		]);
		await controlRun(RUN, { kind: "hold" });
		expect(sessionRow()?.substatus ?? []).toContain("taken_over");
		const handle = await startNarratorRun({
			narratorId: RUN,
			locale: "en",
			text: "work",
			binding: binding(),
		});
		await settle(() => !!getRunControl(RUN)?.logicalRunId);
		// Deferred: the run is mid-turn, so the release takes effect when it ends.
		expect(await controlRun(RUN, { kind: "release" })).toBe(true);
		expect(getRunHold(RUN)?.released).toBe(true);
		gate.resolve();
		await handle.terminal;
		await settle(() => !getExecutionOwner(RUN));
		expect(getRunHold(RUN)).toBeUndefined();
		expect(sessionRow()?.substatus ?? []).not.toContain("taken_over");
		// A restart restores no hold from it.
		expect((await hydrateRunHolds()).has(RUN)).toBe(false);
	});

	test("hydrateRunHolds restores every held session past one page", async () => {
		seed();
		const ids = Array.from({ length: 501 }, (_, i) => `held-${String(i).padStart(4, "0")}`);
		db.insert(narrators)
			.values(
				ids.map((id) => ({
					id,
					variant: "primary",
					cwd,
					substatus: JSON.stringify(["taken_over"]),
					createdAt: NOW,
					updatedAt: NOW,
				})),
			)
			.run();
		try {
			const held = await hydrateRunHolds();
			expect(held.size).toBe(ids.length);
			expect(held.has(ids.at(-1) as string)).toBe(true);
		} finally {
			for (const id of ids) setRunHold(id, undefined);
		}
	});
});

describe("background and detached terminal source transactions", () => {
	for (const detached of [false, true]) {
		async function launch() {
			seed();
			const entered = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			const calls = scriptPasses([
				async () => {
					entered.resolve();
					await gate.promise;
					return { finalText: "same immutable terminal answer" };
				},
			]);
			let resumeRunId: string | undefined;
			if (!detached) {
				const task = await backgroundTaskService.createAgentTask({
					id: RUN,
					subagentNarratorId: RUN,
					subagentType: "general",
					alias: "retry-task",
					binding: binding({ cancelWith: undefined }),
				});
				resumeRunId = task.logicalRunId ?? undefined;
				db.update(narrators)
					.set({ isBackground: true, backgroundStatus: "running" })
					.where(eq(narrators.id, RUN))
					.run();
			}
			const handle = await startNarratorRun({
				narratorId: RUN,
				locale: "en",
				text: "work",
				...(detached ? { binding: binding(), foreground: true } : { resumeRunId }),
			});
			await entered.promise;
			if (detached) {
				expect(await controlRun(RUN, { kind: "detach" })).toBe(true);
				expect((await handle.foreground).handoff).toBe(true);
			}
			return { handle, gate, calls, runId: getRunControl(RUN)?.logicalRunId };
		}
		if (!detached)
			test("background completion waiter observes idle only after the same-run finalizer settles", async () => {
				const { handle, gate } = await launch();
				const { narratorService } = await import("../narrator-service");
				const update = narratorService.updateStatus.bind(narratorService);
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				spyOn(narratorService, "updateStatus").mockImplementation(async (...args) => {
					if (args[0] === RUN && args[1] === "idle") {
						entered.resolve();
						await release.promise;
					}
					return update(...args);
				});
				let received = false;
				const waiting = backgroundTaskService.waitForCompletion(RUN, 1_000).then((result) => {
					received = true;
					return result;
				});
				gate.resolve();
				await entered.promise;
				try {
					expect(taskRow()?.status).toBe("completed");
					expect(received).toBe(false);
					const abort = new AbortController();
					const cancelled = backgroundTaskService.waitForCompletion(RUN, 1_000, abort.signal);
					abort.abort();
					expect((await cancelled).status).toBe("aborted");
					expect((await backgroundTaskService.waitForCompletion(RUN, 1)).status).toBe("timeout");
				} finally {
					release.resolve();
				}
				expect((await waiting).status).toBe("completed");
				await handle.completion;
				expect(sessionRow()?.status).toBe("idle");
			});
		test(`${detached ? "detached" : "background"} retries one failed source commit without a second terminal or model pass`, async () => {
			const { handle, gate, calls, runId } = await launch();
			const commit = backgroundTaskService.markCompleted.bind(backgroundTaskService);
			const writes = spyOn(backgroundTaskService, "markCompleted");
			let attempts = 0;
			writes.mockImplementation(async (...args) => {
				if (++attempts === 1) throw new Error("SQLITE_BUSY injected source transaction");
				return commit(...args);
			});
			gate.resolve();
			expect((await handle.completion).finalText).toBe("same immutable terminal answer");
			expect(attempts).toBe(2);
			expect(calls).toHaveLength(1);
			expect(taskRow()).toMatchObject({
				status: "completed",
				logicalRunId: runId,
				output: "same immutable terminal answer",
			});
			expect(delivered(runId)).toHaveLength(1);
		});
		test(`${detached ? "detached" : "background"} exhausted source commit keeps its reservation and restarts with the exact saved terminal`, async () => {
			const { handle, gate, calls, runId } = await launch();
			let attempts = 0;
			let queuedId = "";
			const writes = spyOn(backgroundTaskService, "markCompleted").mockImplementation(async () => {
				if (++attempts === 3)
					queuedId = (
						await buffer.enqueueBufferedMessage(RUN, "work queued behind failed terminal")
					).id;
				throw new Error("SQLITE_BUSY exhausted source transaction");
			});
			gate.resolve();
			await expect(handle.completion).rejects.toThrow("exhausted source transaction");
			expect(writes).toHaveBeenCalledTimes(3);
			expect(taskRow()?.status).toBe("running");
			expect(sessionRow()?.backgroundResult).toBe("same immutable terminal answer");
			expect(sessionRow()?.backgroundCompletedAt).not.toBeNull();
			expect(
				db
					.select()
					.from(runtimePublicationOutbox)
					.where(eq(runtimePublicationOutbox.logicalRunId, runId ?? ""))
					.all()
					.some((row) => row.state === "reserved" && row.eventKind === "terminal"),
			).toBe(true);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(getExecutionOwner(RUN)).toBeUndefined();
			expect(calls).toHaveLength(1);
			expect(await buffer.getBufferedMessagesAsync(RUN)).toHaveLength(1);
			// Isolate terminal recovery from a later user continuation.
			await buffer.removeBufferedMessage(RUN, queuedId);
			writes.mockRestore();
			activeNarrators.delete(RUN); // restart loses the live session, not its durable answer
			await backgroundTaskService.recoverStaleTasksAfterRestart(new Set());
			expect(calls).toHaveLength(1);
			expect(taskRow()).toMatchObject({
				status: "completed",
				logicalRunId: runId,
				output: "same immutable terminal answer",
			});
			expect(delivered(runId)).toHaveLength(1);
			expect(sessionRow()?.status).toBe("idle");
		});
	}
});

describe("C. a new run of an ended background task", () => {
	async function endedBackgroundTask() {
		seed();
		scriptPasses([async () => ({ finalText: "first run answer" })]);
		const task = await backgroundTaskService.createAgentTask({
			id: RUN,
			subagentNarratorId: RUN,
			subagentType: "general",
			alias: "race-alias",
			binding: binding({ cancelWith: undefined }),
		});
		// The registration alone makes later runs deliver through the task row.
		expect(
			readRuntimeRegistrationColumn(sessionRow()?.runtimeRegistrationJson)?.run?.deliverTo?.viaTask,
		).toBe(true);
		const first = await startNarratorRun({
			narratorId: RUN,
			locale: "en",
			text: "",
			resumeRunId: task.logicalRunId ?? undefined,
		});
		const firstTerminal = await first.terminal;
		await settle(() => !getExecutionOwner(RUN));
		expect(taskRow()?.status).toBe("completed");
		return firstTerminal.logicalRunId as string;
	}

	test("the task row reopens for the new run and settles to its own terminal once", async () => {
		const firstRunId = await endedBackgroundTask();
		// The old result was already read by an Await of the old run.
		await getRuntimePublicationService().consumeAwaitedTerminal({
			producerKind: "agent",
			taskId: RUN,
			logicalRunId: firstRunId,
			recipientId: CALLER,
		});
		runtimePublication.flushRecipient(CALLER);
		const noticesBefore = notices().length;
		const gate = Promise.withResolvers<void>();
		mock.restore();
		scriptPasses([
			async () => {
				await gate.promise;
				return { finalText: "second run answer" };
			},
		]);
		const recorded = spyOn(parentInjection, "recordTaskNoticeUser");
		const second = await startNarratorRun({ narratorId: RUN, locale: "en", text: "again" });
		await settle(() => !!getRunControl(RUN)?.logicalRunId);
		const secondRunId = getRunControl(RUN)?.logicalRunId;
		expect(secondRunId).not.toBe(firstRunId);
		// Published as running, for the run that is actually executing.
		expect(taskRow()).toMatchObject({ status: "running", logicalRunId: secondRunId });
		expect(sessionRow()?.backgroundStatus).toBe("running");
		// An Await started now waits for the new run, not the consumed old one.
		const waited = backgroundTaskService.waitForCompletion(RUN, 3_000);
		gate.resolve();
		const terminal = await second.terminal;
		expect(terminal.logicalRunId).toBe(secondRunId);
		expect((await waited).status).toBe("completed");
		expect(taskRow()).toMatchObject({ status: "completed", logicalRunId: secondRunId });
		expect(taskRow()?.output).toContain("second run answer");
		// The old Await's consumption is keyed by the old run: the new terminal is
		// delivered once, as a notice of the new run.
		expect(consumed(secondRunId)).toHaveLength(0);
		expect(delivered(secondRunId)).toHaveLength(1);
		runtimePublication.flushRecipient(CALLER);
		const fresh = notices().slice(noticesBefore);
		expect(fresh).toHaveLength(1);
		expect(fresh[0].dedupeKey).toContain(secondRunId as string);
		expect(recorded).toHaveBeenCalledTimes(1);
	});

	test("retrying a denied tool republishes the task as running, then its new terminal", async () => {
		const firstRunId = await endedBackgroundTask();
		// The ended run's last turn is a tool call the user denied.
		db.insert(narratorMessages)
			.values({
				id: "denied-message",
				narratorId: RUN,
				role: "assistant",
				contentJson: [
					{ type: "tool_use", id: "denied-use", name: "Read", input: { file_path: "missing" } },
				],
				parentToolUseId: ORIGIN,
				createdAt: NOW,
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: "denied-ref", narratorId: RUN, messageId: "denied-message", seq: seq++ })
			.run();
		db.insert(narratorToolCalls)
			.values({
				id: "denied-call",
				narratorId: RUN,
				messageId: "denied-message",
				toolUseId: "denied-use",
				toolName: "Read",
				inputJson: { file_path: join(cwd, "missing.txt") },
				outputJson: "Denied",
				status: "fail",
				permissionDecidedBy: "user",
				executionIdentityVersion: 1,
				executionAttempt: 1,
				createdAt: NOW,
			})
			.run();
		runtimePublication.flushRecipient(CALLER);
		expect(notices().map((row) => row.dedupeKey)).toEqual([expect.stringContaining(firstRunId)]);
		const noticesBefore = notices().length;
		mock.restore();
		const gate = Promise.withResolvers<void>();
		scriptPasses([
			async () => {
				await gate.promise;
				return { finalText: "after the retried tool" };
			},
		]);
		const { reExecuteDeniedToolCall } = await import("../narrator-session");
		const retried = reExecuteDeniedToolCall(RUN, "denied-use", "en");
		await settle(() => !!getRunControl(RUN)?.logicalRunId);
		const retryRunId = getRunControl(RUN)?.logicalRunId;
		expect(retryRunId).not.toBe(firstRunId);
		expect(taskRow()).toMatchObject({ status: "running", logicalRunId: retryRunId });
		expect(sessionRow()?.backgroundStatus).toBe("running");
		gate.resolve();
		expect(await retried).toMatchObject({ ok: true });
		await settle(() => !getExecutionOwner(RUN));
		expect(taskRow()).toMatchObject({ status: "completed", logicalRunId: retryRunId });
		expect(taskRow()?.output).toContain("after the retried tool");
		runtimePublication.flushRecipient(CALLER);
		const fresh = notices().slice(noticesBefore);
		expect(fresh).toHaveLength(1);
		expect(fresh[0].dedupeKey).toContain(retryRunId as string);
	});
});

describe("D. the destination's card follows each run", () => {
	test("a continued run re-announces the card with its new model", async () => {
		seed();
		scriptPasses([async () => ({ finalText: "one" }), async () => ({ finalText: "two" })]);
		const first = await startNarratorRun({
			narratorId: RUN,
			locale: "en",
			text: "work",
			binding: binding(),
		});
		await first.terminal;
		await settle(() => !getExecutionOwner(RUN));
		db.update(narrators).set({ model: "test:other-model" }).where(eq(narrators.id, RUN)).run();
		const second = await startNarratorRun({ narratorId: RUN, locale: "en", text: "more" });
		await second.terminal;
		const starts = broadcasts.filter(({ event }) => event.type === "subagent_started");
		expect(starts).toHaveLength(2);
		expect(starts.every(({ target }) => target === CALLER)).toBe(true);
		expect(starts[0].event).toMatchObject({ subagentNarratorId: RUN, model: "test:model" });
		expect(starts[1].event).toMatchObject({
			subagentNarratorId: RUN,
			toolUseId: ORIGIN,
			model: "test:other-model",
		});
	});
});

describe("hold protocol regressions", () => {
	async function parked(foreground = true, withBinding = true) {
		seed();
		const calls = scriptPasses([async () => ({ finalText: "immutable held answer" })]);
		await controlRun(RUN, { kind: "hold" });
		const handle = await startNarratorRun({
			narratorId: RUN,
			locale: "en",
			text: "work",
			foreground,
			...(withBinding
				? { binding: binding() }
				: { principal: null, binding: { principal: { userId: null } } }),
		});
		await settle(() => !!getRunControl(RUN)?.wake);
		return { handle, calls, runId: getRunControl(RUN)?.logicalRunId };
	}

	for (const kind of ["modelOverride", "controlCommand"] as const) {
		test(`C1 held ${kind} gets one fresh epoch and original promises settle on release`, async () => {
			const { handle, calls, runId } = await parked();
			const epoch = getExecutionOwner(RUN)?.epoch;
			const api = await import("../agent-runtime/run");
			const wait = api.awaitRunHold;
			let waits = 0;
			spyOn(api, "awaitRunHold").mockImplementation(async (...args) => {
				if (++waits > 8) throw new Error("Repeated hold wait instead of fresh pass");
				return wait(...args);
			});
			db.insert(users)
				.values({
					id: "human",
					username: "human",
					passwordHash: "fixture",
					role: "admin",
					createdAt: NOW,
				})
				.run();
			const commands = await import("../command-service");
			const handlers = await import("../narrator-service");
			const resolve = spyOn(commands, "resolveCommand").mockResolvedValue({
				resolved: true,
				loadTool: "Read",
			} as never);
			const load = spyOn(handlers, "handleLoadToolCommand").mockResolvedValue(undefined as never);
			const queued = await buffer.enqueueBufferedMessage(
				RUN,
				kind === "modelOverride" ? "fresh input" : "/load Read",
				undefined,
				undefined,
				"human",
				undefined,
				undefined,
				"back",
				undefined,
				undefined,
				"fifo",
				kind === "modelOverride"
					? { modelOverride: { model: "test:other-model", mode: "temporary" } }
					: { controlCommand: true },
			);
			expect(queued.ok).toBe(true);
			expect(wakeHeldRun(RUN)).toBe(true);
			await settle(() => getExecutionOwner(RUN)?.epoch !== epoch && !!getRunControl(RUN)?.wake);
			expect(getRunControl(RUN)?.logicalRunId).toBe(runId);
			expect(sessionRow()?.runtimeRegistrationJson).toMatchObject({
				run: { principal: { userId: "human" } },
			});
			expect(getRunHold(RUN)?.released).toBe(false);
			expect(calls).toHaveLength(kind === "modelOverride" ? 2 : 1);
			expect(waits).toBeLessThan(4);
			if (kind === "modelOverride") expect(calls[1]?.config.model).toBe("test:other-model");
			if (kind === "controlCommand") {
				expect(resolve).toHaveBeenCalledTimes(1);
				expect(load).toHaveBeenCalledTimes(1);
			}
			expect(await buffer.getBufferedMessagesAsync(RUN)).toHaveLength(0);
			expect(consumed(runId)).toHaveLength(0);
			await controlRun(RUN, { kind: "release" });
			const results = await Promise.all([handle.foreground, handle.terminal, handle.completion]);
			expect(results.every((r) => r.logicalRunId === runId)).toBe(true);
			expect(getExecutionOwner(RUN)).toBeUndefined();
			expect(consumed(runId)).toHaveLength(1);
		});
	}

	test("C1/C2 withdrawn modelOverride plus Send restores principal before the fresh pass and final tool gate", async () => {
		seed();
		db.insert(users)
			.values({ id: "human-a", username: "human-a", passwordHash: "x", createdAt: NOW })
			.run();
		// Give A real write ACL as well as its user-level tool restriction. The
		// final-start gate must reach the disabled-tool check, not fail invisibility.
		for (const id of [CALLER, RUN])
			db.update(narrators).set({ ownerUserId: "human-a" }).where(eq(narrators.id, id)).run();
		db.update(narrators).set({ aclRootNarratorId: CALLER }).where(eq(narrators.id, RUN)).run();
		db.insert(userPreferences)
			.values({
				id: "human-a-prefs",
				userId: "human-a",
				traits: upsertEncodedTrait([], DISABLED_TOOLS_TRAIT_PREFIX, {
					version: 1,
					tools: ["Write"],
				}),
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		const calls = scriptPasses([
			async () => ({ finalText: "first" }),
			async () => ({ finalText: "Send answer" }),
		]);
		await controlRun(RUN, { kind: "hold" });
		const handle = await startNarratorRun({
			narratorId: RUN,
			locale: "en",
			text: "work",
			binding: binding({ principal: { userId: "human-a" } }),
			foreground: true,
		});
		await settle(() => !!getRunControl(RUN)?.wake);
		const queued = await buffer.enqueueBufferedMessage(
			RUN,
			"withdrawn override",
			undefined,
			undefined,
			"human-a",
			undefined,
			undefined,
			"back",
			undefined,
			undefined,
			"fifo",
			{ modelOverride: { model: "test:other", mode: "temporary" } },
		);
		const prepare = session.prepareQueuedRunInput;
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		spyOn(session, "prepareQueuedRunInput").mockImplementation(async (...args) => {
			entered.resolve();
			await resume.promise;
			return prepare(...args);
		});
		wakeHeldRun(RUN);
		await entered.promise;
		await buffer.removeBufferedMessage(RUN, queued.id);
		db.insert(narratorMessages)
			.values({
				id: "send-msg",
				narratorId: CALLER,
				role: "assistant",
				contentJson: [],
				createdAt: NOW,
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: "send-ref", narratorId: CALLER, messageId: "send-msg", seq: seq++ })
			.run();
		db.insert(narratorToolCalls)
			.values({
				id: "send-call",
				narratorId: CALLER,
				messageId: "send-msg",
				toolUseId: "send-use",
				toolName: "Send",
				status: "running",
				executionIdentityVersion: 1,
				executionAttempt: 1,
				executionSegmentId: "send-segment",
				createdAt: NOW,
			})
			.run();
		db.insert(fileChangeExecutionSegments)
			.values({
				id: "send-segment",
				narratorId: CALLER,
				sourceToolCallId: "send-call",
				sourceExecutionAttempt: 1,
				createdAt: NOW,
			})
			.run();
		const delivery = createAgentMessageDelivery(
			RUN,
			{ id: CALLER, title: "Caller", label: "caller", type: "general", isParent: true },
			"send-use",
			"Send replacing withdrawn input",
			{ toolCallId: "send-call", attempt: 1 },
		);
		await inbox.enqueueInboxAgent(delivery, delivery.text, { userId: "sender-not-the-principal" });
		resume.resolve();
		await settle(() => calls.length === 2 && !!getRunControl(RUN)?.wake);
		expect(getRunControl(RUN)?.principal).toBe("human-a");
		const config = calls[1]?.config;
		expect(config?.userId).toBe("human-a");
		expect(config?.disabledTools).toContain("Write");
		const finalGate = config?.onToolExecutionFinalAuthorization;
		if (!finalGate) throw new Error("Missing final-start gate");
		await expect(
			finalGate({
				toolUse: { name: "Write", toolUseId: "blocked-write", input: {} },
				effectiveInput: {},
				binding: { toolCallId: "blocked-write", attempt: 1 },
			} as Parameters<typeof finalGate>[0]),
		).rejects.toThrow("Tool disabled by the current effective traits: Write");
		await controlRun(RUN, { kind: "release" });
		await handle.completion;
		expect(calls).toHaveLength(2);
	});

	test("C2 input wake then withdrawal and release cannot repark the owner", async () => {
		const { handle, runId } = await parked();
		const claim = inbox.claimInboxHead;
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		spyOn(inbox, "claimInboxHead").mockImplementation(async (...args) => {
			entered.resolve();
			await gate.promise;
			return claim(...args);
		});
		const queued = await buffer.enqueueBufferedMessage(RUN, "withdraw me");
		wakeHeldRun(RUN);
		await entered.promise;
		await buffer.removeBufferedMessage(RUN, queued.id);
		expect(await controlRun(RUN, { kind: "release" })).toBe(true);
		gate.resolve();
		await Promise.all([handle.foreground, handle.terminal, handle.completion]);
		expect(getExecutionOwner(RUN)).toBeUndefined();
		expect(consumed(runId)).toHaveLength(1);
	});

	test("R8 cancellation falls back to unified control after the task lookup resolves false", async () => {
		const { handle } = await parked();
		spyOn(backgroundTaskService, "cancel").mockResolvedValue(false);
		const { cancelBackgroundTask } = await import("../subagent-runner");
		expect(await cancelBackgroundTask(RUN)).toBe(true);
		const result = await handle.completion;
		expect(result.interrupted).toBe(true);
		expect(getExecutionOwner(RUN)).toBeUndefined();
	});

	test("C2 awaiting an already absent hold is a release", async () => {
		const { handle } = await parked();
		const owner = getExecutionOwner(RUN);
		const run = getRunControl(RUN);
		if (!owner || !run) throw new Error("Parked fixture has no owner/run");
		setRunHold(RUN, undefined);
		expect(await awaitRunHold(owner, run, async () => false)).toBe("release");
		run?.wake?.("release");
		await handle.completion;
	});

	test("C5 failed terminal commit retains hold and reservation for same-answer retry", async () => {
		const { handle, calls, runId } = await parked();
		const pub = getRuntimePublicationService();
		spyOn(pub, "commitAgentTerminal").mockRejectedValueOnce(new Error("injected terminal failure"));
		await controlRun(RUN, { kind: "release" });
		await expect(handle.completion).rejects.toThrow("injected terminal failure");
		expect(getRunHold(RUN)?.result?.finalText).toBe("immutable held answer");
		expect(sessionRow()?.substatus).toContain("taken_over");
		expect(
			db
				.select()
				.from(runtimePublicationOutbox)
				.where(eq(runtimePublicationOutbox.logicalRunId, runId ?? ""))
				.all()
				.some((r) => r.state === "reserved"),
		).toBe(true);
		expect(await controlRun(RUN, { kind: "release" })).toBe(true);
		expect(await controlRun(RUN, { kind: "release" })).toBe(false);
		expect(toolOutput()).toContain("immutable held answer");
		expect(delivered(runId)).toHaveLength(1);
		expect(calls).toHaveLength(1);
		expect(getRunHold(RUN)).toBeUndefined();
	});

	test("C5 an ordinary held session without deliverTo clears memory and durable mirror", async () => {
		const { handle, runId } = await parked(false, false);
		await controlRun(RUN, { kind: "release" });
		expect((await handle.completion).logicalRunId).toBe(runId);
		expect(getRunHold(RUN)).toBeUndefined();
		expect(sessionRow()?.substatus).not.toContain("taken_over");
		expect((await hydrateRunHolds()).has(RUN)).toBe(false);
	});

	test("C6 a hold acquired during final pre-idle drain parks instead of publishing", async () => {
		seed();
		db.update(narrators).set({ status: "working" }).where(eq(narrators.id, RUN)).run();
		const calls = scriptPasses([async () => ({ finalText: "answer at drain" })]);
		const drain = session.drainAndPersistPendingInjections;
		let afterModelDrains = 0;
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		spyOn(session, "drainAndPersistPendingInjections").mockImplementation(async (...args) => {
			if (calls.length && ++afterModelDrains === 2) {
				entered.resolve();
				await gate.promise;
			}
			return drain(...args);
		});
		const handle = await startNarratorRun({
			narratorId: RUN,
			locale: "en",
			text: "work",
			binding: binding(),
			foreground: true,
		});
		let terminal = false;
		void handle.terminal.then(() => {
			terminal = true;
		});
		await entered.promise;
		expect(await controlRun(RUN, { kind: "hold" })).toBe(true);
		gate.resolve();
		await settle(() => !!getRunControl(RUN)?.wake);
		expect(terminal).toBe(false);
		expect(consumed(getRunControl(RUN)?.logicalRunId)).toHaveLength(0);
		await controlRun(RUN, { kind: "release" });
		await handle.completion;
	});

	test("C6 finalizing refuses takeover and idle follows terminal commit", async () => {
		seed();
		db.update(narrators).set({ status: "working" }).where(eq(narrators.id, RUN)).run();
		scriptPasses([async () => ({ finalText: "terminal before idle" })]);
		const pub = getRuntimePublicationService();
		const commit = pub.commitAgentTerminal.bind(pub);
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		spyOn(pub, "commitAgentTerminal").mockImplementation(async (input) => {
			entered.resolve();
			await gate.promise;
			return commit(input);
		});
		const handle = await startNarratorRun({
			narratorId: RUN,
			locale: "en",
			text: "work",
			binding: binding(),
			foreground: true,
		});
		await entered.promise;
		expect(sessionRow()?.status).not.toBe("idle");
		expect(await controlRun(RUN, { kind: "hold" })).toBe(false);
		expect(getRunHold(RUN)).toBeUndefined();
		gate.resolve();
		await handle.completion;
		expect(sessionRow()?.status).toBe("idle");
	});

	test("C4 cold release owns delivery while a new start and duplicate release race it", async () => {
		seed();
		const pub = getRuntimePublicationService();
		const old = (
			await pub.startRun({
				narratorId: RUN,
				binding: backgroundBinding(),
			})
		).publication!;
		db.insert(backgroundTasks)
			.values({
				id: RUN,
				type: "agent",
				status: "running",
				parentNarratorId: CALLER,
				subagentNarratorId: RUN,
				logicalRunId: old.logicalRunId,
				alias: "cold-release-task",
				startedAt: NOW,
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		db.update(narrators)
			.set({ isBackground: true, backgroundStatus: "running" })
			.where(eq(narrators.id, RUN))
			.run();
		await controlRun(RUN, { kind: "hold" });
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		spyOn(session, "getSubagentFinalText").mockImplementation(async () => {
			entered.resolve();
			await gate.promise;
			return "old answer";
		});
		const release = controlRun(RUN, { kind: "release" });
		await entered.promise;
		expect(
			(
				await startNarratorRun({
					narratorId: RUN,
					locale: "en",
					text: "new work",
					binding: backgroundBinding(),
				})
			).started,
		).toBe(false);
		expect(await controlRun(RUN, { kind: "release" })).toBe(false);
		// Identity comparison: even a replacement hold must not be erased by old delivery.
		const replacement = { released: false };
		setRunHold(RUN, replacement);
		gate.resolve();
		expect(await release).toBe(true);
		expect(getRunHold(RUN)).toBe(replacement);
		expect(delivered(old.logicalRunId)).toHaveLength(1);
		expect(sessionRow()?.logicalRunId).toBe(old.logicalRunId);
		expect(taskRow()).toMatchObject({
			logicalRunId: old.logicalRunId,
			status: "completed",
			output: "old answer",
		});
		const modelGate = Promise.withResolvers<void>();
		scriptPasses([
			async () => {
				await modelGate.promise;
				return { finalText: "new answer" };
			},
		]);
		const next = await startNarratorRun({
			narratorId: RUN,
			locale: "en",
			text: "new work",
			binding: backgroundBinding(),
		});
		await settle(() => !!getRunControl(RUN)?.logicalRunId);
		expect(getRunControl(RUN)?.logicalRunId).not.toBe(old.logicalRunId);
		await settle(
			() =>
				taskRow()?.status === "running" &&
				taskRow()?.logicalRunId === getRunControl(RUN)?.logicalRunId,
		);
		expect(getRunHold(RUN)).toBe(replacement);
		await controlRun(RUN, { kind: "release" });
		modelGate.resolve();
		await next.completion;
	});

	test("R6 input accepted during a failing cold release runs without a second external wake and keeps the hold", async () => {
		seed();
		await getRuntimePublicationService().startRun({
			narratorId: RUN,
			binding: binding(),
		});
		await controlRun(RUN, { kind: "hold" });
		const hold = getRunHold(RUN);
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		spyOn(session, "getSubagentFinalText").mockImplementation(async () => {
			entered.resolve();
			await gate.promise;
			return "held old answer";
		});
		spyOn(session, "updateToolCallConclusion").mockRejectedValueOnce(
			new Error("cold release commit failed"),
		);
		const calls = scriptPasses([async () => ({ finalText: "accepted human input answer" })]);
		const release = controlRun(RUN, { kind: "release" });
		await entered.promise;
		expect((await buffer.enqueueBufferedMessage(RUN, "accepted during release")).ok).toBe(true);
		expect(await inbox.wakeInboxIfEligible(RUN, "en")).toBe(false);
		gate.resolve();
		await expect(release).rejects.toThrow("cold release commit failed");
		await settle(() => calls.length === 1 && !!getRunControl(RUN)?.wake);
		expect(getRunHold(RUN)).toBe(hold);
		expect(getRunHold(RUN)?.released).toBe(false);
		expect(await buffer.getBufferedMessagesAsync(RUN)).toHaveLength(0);
		const terminal = getRunControl(RUN)?.terminal;
		await controlRun(RUN, { kind: "cancel", reason: "test cleanup" });
		await terminal;
	});

	test("M4 recovery uses committed terminal without executing the model again", async () => {
		seed();
		const pub = getRuntimePublicationService();
		const registered = (
			await pub.startRun({
				narratorId: RUN,
				binding: binding(),
			})
		).publication!;
		await pub.commitAgentTerminal({
			run: registered,
			eventKind: "completed",
			text: "committed before crash",
			summary: "crash fixture",
		});
		db.update(narrators).set({ status: "working" }).where(eq(narrators.id, RUN)).run();
		const execute = spyOn(executor, "executeAgentLoop").mockImplementation(async () => {
			throw new Error("must not rerun model");
		});
		const handle = await startNarratorRun({
			narratorId: RUN,
			locale: "en",
			text: "",
			recovered: true,
			resumeRunId: registered.logicalRunId,
		});
		expect((await handle.completion).finalText).toBe("committed before crash");
		expect(execute).not.toHaveBeenCalled();
		expect(delivered(registered.logicalRunId)).toHaveLength(1);
		expect(toolOutput()).toContain("committed before crash");
	});

	for (const eventKind of ["failed", "timed_out", "cancelled"] as const) {
		for (const foreground of [false, true])
			test(`M4 recovered ${eventKind} preserves its immutable classification (foreground=${foreground})`, async () => {
				seed();
				const pub = getRuntimePublicationService();
				const registered = (
					await pub.startRun({
						narratorId: RUN,
						binding: binding(),
					})
				).publication!;
				const text = `immutable ${eventKind} before crash`;
				await pub.commitAgentTerminal({
					run: registered,
					eventKind,
					text,
					summary: "crash fixture",
					...(foreground ? { delivery: "foreground" as const } : {}),
				});
				db.update(narrators).set({ status: "working" }).where(eq(narrators.id, RUN)).run();
				const execute = spyOn(executor, "executeAgentLoop").mockImplementation(async () => {
					throw new Error("must not rerun model");
				});
				const handle = await startNarratorRun({
					narratorId: RUN,
					locale: "en",
					text: "",
					recovered: true,
					resumeRunId: registered.logicalRunId,
				});
				expect(await handle.completion).toMatchObject({
					finalText: text,
					hasError: eventKind !== "cancelled",
					timedOut: eventKind === "timed_out",
					interrupted: eventKind === "cancelled",
				});
				expect(execute).not.toHaveBeenCalled();
				expect(delivered(registered.logicalRunId)).toHaveLength(foreground ? 0 : 1);
				expect(
					(await pub.readAgentTerminalResult(registered, { includeEventKind: true }))?.eventKind,
				).toBe(eventKind);
			});
	}

	test("M8 labels are parsed exactly and each hydration query scans one bounded primary-key page", async () => {
		seed();
		db.update(narrators).set({ substatus: '["taken-over"]' }).where(eq(narrators.id, RUN)).run();
		const selects: string[] = [];
		const prepare = sqlite.prepare.bind(sqlite);
		spyOn(sqlite, "prepare").mockImplementation((query, ...rest) => {
			selects.push(query);
			return prepare(query, ...rest);
		});
		expect((await hydrateRunHolds()).has(RUN)).toBe(false);
		const scans = selects.filter(
			(q) => q.includes('"substatus"') && q.includes('from "narrators"'),
		);
		expect(scans.length).toBeGreaterThan(0);
		for (const query of scans) {
			expect(query.toLowerCase()).not.toContain("like");
			expect(query.toLowerCase()).toContain("limit");
			expect(query).toContain('"narrators"."id" >');
		}
	});
});

describe("F. a parked held result", () => {
	test("release delivers it under the run's registered principal", async () => {
		seed();
		db.insert(narrators)
			.values({ id: "user-principal", variant: "primary", cwd, createdAt: NOW, updatedAt: NOW })
			.run();
		// After a restart only the durable facts are left: the registered run (with its
		// reserved terminal), its last answer and the `taken_over` mirror.
		await getRuntimePublicationService().startRun({
			narratorId: RUN,
			binding: binding({ principal: { userId: "registered-user" } }),
		});
		db.insert(narratorMessages)
			.values({
				id: "parked-answer",
				narratorId: RUN,
				role: "assistant",
				contentText: "parked answer",
				contentJson: [{ type: "text", text: "parked answer" }],
				parentToolUseId: ORIGIN,
				createdAt: NOW,
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: "parked-ref", narratorId: RUN, messageId: "parked-answer", seq: seq++ })
			.run();
		await controlRun(RUN, { kind: "hold" });
		setRunHold(RUN, undefined);
		expect((await hydrateRunHolds()).has(RUN)).toBe(true);
		const recorded = spyOn(parentInjection, "recordTaskNoticeUser");
		expect(await controlRun(RUN, { kind: "release" })).toBe(true);
		expect(recorded).toHaveBeenCalledWith(RUN, "registered-user");
		expect(toolOutput()).toContain("parked answer");
		expect(getRunHold(RUN)).toBeUndefined();
		expect(sessionRow()?.substatus ?? []).not.toContain("taken_over");
	});
});
