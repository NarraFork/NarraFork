import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	backgroundTasks,
	fileChangeExecutionSegments,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";
import {
	consumeSearchExecutionTurn,
	getSearchExecutionScope,
	withSearchExecutionScope,
} from "../../lib/search/execution-scope";
import type { ExecuteLoopResult } from "../narrator-executor";
import type { ActiveNarrator } from "../narrator-session-state";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
// Context now imports publication services; load it only after binding the isolated DB.
const { createRuntimeEventContext } = await import("../agent-runtime/context");
const { createRuntimeMapView, getExecutionOwner, setExecutionSuspended, tryClaimExecution } =
	await import("../agent-runtime/ownership");
const { backgroundOccupancyStore } = await import("../background-occupancy-store");
const sessionModule = await import("../narrator-session");
const { runAgentLoop } = sessionModule;
const bufferModule = await import("../narrator-buffer");
const { listDeliveringRuns, startNarratorRun } = await import("../agent-runtime/run");
const state = await import("../narrator-session-state");
const { narratorService } = await import("../narrator-service");
const passExecutor = await import("../narrator-executor");
const { registerExternalProviderResolver } = await import("../../lib/agent/provider");
const { settings } = await import("../../lib/settings");
const provider: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	chat() {
		throw new Error("Ownership test must never call a model");
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
const unregisterProvider = registerExternalProviderResolver({
	resolve: (name) => (name === "test" ? provider : null),
	listReadiness: () => [],
});

const ROOT = "runtime-owner-root";
const CHILD = "runtime-owner-child";
const SIBLING = "runtime-owner-sibling";
const ids = [ROOT, CHILD, SIBLING];

beforeEach(() => {
	cleanDb(sqlite);
	settings.agent.autoContinuationMode = "off";
	const now = new Date().toISOString();
	for (const id of ids) {
		db.insert(narrators)
			.values({
				id,
				type: id === ROOT ? "primary" : "subagent",
				variant: id === ROOT ? "primary" : "subagent:general",
				parentNarratorId: id === ROOT ? null : ROOT,
				// A delegated session: an ordinary session whose run delivers to a call.
				runtimeRegistrationJson:
					id === ROOT
						? { version: 1, run: { logicalRunId: `seed-${id}`, principal: { userId: null } } }
						: {
								version: 1,
								run: {
									logicalRunId: `seed-${id}`,
									principal: { userId: null },
									deliverTo: { narratorId: ROOT, toolUseId: "spawn-tool" },
								},
							},
				model: "test:model",
				cwd: process.env.HOME,
				autoContinuationOverride: "off",
				createdAt: now,
				updatedAt: now,
			})
			.run();
	}
});
afterEach(() => {
	for (const id of ids) {
		getExecutionOwner(id)?.release();
		state.activeNarrators.delete(id);
	}
	mock.restore();
});
afterAll(() => {
	unregisterProvider();
	mock.module("../../db", () => realDb);
});

function active(narratorId: string): ActiveNarrator {
	return {
		narratorId,
		conversationId: "owner-test-conversation",
		cwd: process.env.HOME as string,
		model: "test:model",
		provider: "test",
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
}
/** Start a run through the single run entry and settle on its true terminal. */
async function runOf(narratorId: string, text = "owner test") {
	const handle = await startNarratorRun({ narratorId, locale: "zh-CN", text });
	if (!handle.started)
		throw Object.assign(new Error("Narrator already has an execution owner"), {
			code: "NARRATOR_EXECUTION_BUSY",
		});
	return handle.completion;
}

/** Pause real entry adapters after admission, before any model/file preparation. */
function preparationBarrier(expectedIds: string[]) {
	const entered = new Map(expectedIds.map((id) => [id, Promise.withResolvers<void>()]));
	const done = Promise.withResolvers<void>();
	const hold = async (id: string): Promise<never> => {
		entered.get(id)?.resolve();
		await done.promise;
		throw new Error("controlled preparation failure");
	};
	spyOn(narratorService, "getById").mockImplementation(hold);
	// A run started without a prepared session constructs it first.
	spyOn(sessionModule, "ensureNarrator").mockImplementation(hold);
	return {
		entered: Promise.all([...entered.values()].map((gate) => gate.promise)),
		release: () => done.resolve(),
	};
}
function failedPreparation(run: Promise<unknown>) {
	return run.then(
		() => {
			throw new Error("entry unexpectedly completed");
		},
		(error: unknown) => {
			expect(String(error)).toContain("controlled preparation failure");
		},
	);
}

describe("owner release respects the runtime inbox wake decision", () => {
	// Same run entry for a session that delivers to a call (CHILD) and one that does not.
	for (const id of [CHILD, ROOT]) {
		for (const allowInboxWake of [false, true]) {
			test(`${id === CHILD ? "delivering" : "plain"}: allowInboxWake=${allowInboxWake}`, async () => {
				const orchestrator = await import("../agent-runtime/orchestrator");
				const inbox = await import("../agent-runtime/inbox");
				spyOn(orchestrator, "runAgentLoopUnlocked").mockResolvedValue({
					started: true,
					finalText: allowInboxWake ? "done" : "Balance exhausted / retries exhausted",
					hasError: !allowInboxWake,
					allowInboxWake,
				});
				spyOn(inbox, "hasInboxKind").mockResolvedValue(true);
				const wake = spyOn(inbox, "wakeInboxIfEligible").mockResolvedValue(false);
				const handle = await startNarratorRun({
					narratorId: id,
					locale: "en",
					text: "run",
					principal: null,
					deliver: false,
				});
				expect(handle.started).toBe(true);
				await handle.terminal;
				// Release schedules async work before waking the inbox. Wait for that
				// boundary, not one event-loop tick that can leak into the next test.
				if (allowInboxWake) {
					await waitUntil(() => wake.mock.calls.some(([target]) => target === id));
				} else {
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				expect(getExecutionOwner(id)).toBeUndefined();
				expect(wake.mock.calls.filter(([target]) => target === id)).toHaveLength(
					allowInboxWake ? 1 : 0,
				);
			});
		}
	}
});

describe("continued subagents remain checkpointable during maintenance", () => {
	const TOOL = "__ContinuedSubagentOrdinaryTest";
	const coordinator = import("../update-coordinator");

	afterEach(async () => {
		(await import("../../lib/agent/tool-registry")).toolRegistry.unregister(TOOL);
		(await coordinator).resetUpdateCoordinationForTests();
	});

	for (const entry of ["continue", "Send"] as const) {
		for (const timing of ["paused-before-dispatch", "already-executing"] as const) {
			test(`${entry}: ${timing} preserves ordinary drain and exactly-once dispatch`, async () => {
				const update = await coordinator;
				const { executeTool } = await import("../../lib/agent/tool-executor");
				const { toolRegistry } = await import("../../lib/agent/tool-registry");
				const runModule = await import("../agent-runtime/run");
				const { sendSubagentMessage } = await import("../agent-communication");
				const entered = Promise.withResolvers<void>();
				const releaseTool = Promise.withResolvers<void>();
				const loopFinished = Promise.withResolvers<void>();
				let executions = 0;
				// The continued session runs through the one run entry; observe its handle.
				let run: Awaited<ReturnType<typeof startNarratorRun>> | undefined;
				spyOn(runModule, "startNarratorRun").mockImplementation(async (input) => {
					run = await startNarratorRun(input);
					return run;
				});
				toolRegistry.register({
					name: TOOL,
					description: "Controlled ordinary tool inside a real continued runner",
					parameters: z.object({}),
					execute: async () => {
						executions++;
						entered.resolve();
						await releaseTool.promise;
						return { output: "ordinary tool finished" };
					},
				});
				// Only model execution and tool receipt callbacks are simulated. The runner,
				// Send mailbox, tool admission, continuation storage, and update gate are real.
				const execute = spyOn(passExecutor, "executeAgentLoop").mockImplementation(
					async ({ config }) => {
						const now = new Date().toISOString();
						const toolUse = { toolUseId: "continued-ordinary", name: TOOL, input: {} };
						const binding = { toolCallId: "continued-tool-row", attempt: 1 };
						await db.insert(narratorMessages).values({
							id: "continued-assistant-message",
							narratorId: CHILD,
							role: "assistant",
							contentJson: [],
							createdAt: now,
						});
						await db.insert(narratorToolCalls).values({
							id: binding.toolCallId,
							narratorId: CHILD,
							messageId: "continued-assistant-message",
							toolUseId: toolUse.toolUseId,
							toolName: TOOL,
							inputJson: {},
							createdAt: now,
						});
						if (timing === "paused-before-dispatch") {
							update.scheduleUpdate("continued-run-test");
							update.beginQuiescingTools();
						}
						const result = await executeTool(toolUse, {
							narratorId: CHILD,
							conversationId: config.conversationId,
							model: config.model,
							provider: config.provider,
							cwd: config.cwd,
							signal: config.signal,
							permissionHandler: async () => ({ behavior: "allow" }),
							requireToolCallBinding: true,
							toolExecutionBindings: new WeakMap([[toolUse, binding]]),
							onToolExecutionStarting: async (_toolUseId, receipt) => receipt,
							onToolExecutionFinalAuthorization: async () => ({ assertStillCurrent() {} }),
						});
						loopFinished.resolve();
						return {
							finalText: result.output,
							hasError: result.isError ?? false,
							shouldUpdateTitle: false,
							completedAssistantTurn: true,
							completedNaturally: true,
						};
					},
				);
				await db
					.update(narrators)
					.set({ subagentOriginKind: "standalone" })
					.where(eq(narrators.id, CHILD));
				try {
					if (entry === "Send") {
						const now = new Date().toISOString();
						await db.insert(narratorMessages).values({
							id: "sender-message",
							narratorId: ROOT,
							role: "assistant",
							contentJson: [],
							createdAt: now,
						});
						await db.insert(narratorMessageRefs).values({
							id: "sender-ref",
							narratorId: ROOT,
							messageId: "sender-message",
							seq: 1,
						});
						await db.insert(narratorToolCalls).values({
							id: "sender-tool",
							narratorId: ROOT,
							messageId: "sender-message",
							toolUseId: "send-continuation",
							toolName: "Send",
							executionAttempt: 1,
							executionIdentityVersion: 1,
							status: "running",
							createdAt: now,
						});
						await db.insert(fileChangeExecutionSegments).values({
							id: "sender-segment",
							narratorId: ROOT,
							sourceToolCallId: "sender-tool",
							sourceExecutionAttempt: 1,
							createdAt: now,
						});
						await db
							.update(narratorToolCalls)
							.set({ executionSegmentId: "sender-segment" })
							.where(eq(narratorToolCalls.id, "sender-tool"));
						const sent = await sendSubagentMessage({
							toolCallBinding: {
								toolCallId: "sender-tool",
								attempt: 1,
								executionSegmentId: "sender-segment",
							},
							callerNarratorId: ROOT,
							id: CHILD,
							message: "Continue with an ordinary tool",
							toolUseId: "send-continuation",
							signal: new AbortController().signal,
							locale: "en",
						});
						expect(sent).toContain("Sent to");
						await waitUntil(() => run !== undefined);
					} else {
						const { acceptUserMessage } = await import("../narrator-session");
						await acceptUserMessage(CHILD, "Continue with an ordinary tool", { userId: null });
						await waitUntil(() => run !== undefined);
					}
					expect(run?.started).toBe(true);
					if (timing === "paused-before-dispatch") {
						await waitUntil(() => update.getUpdateCoordinationStatus().pausedToolCount === 1);
						expect(executions).toBe(0);
						expect(update.getUpdateCoordinationStatus()).toMatchObject({
							pendingOrdinaryExecutionCount: 0,
						});
						// The continued run is in the checkpoint inventory planned updates read.
						expect(listDeliveringRuns().some((entry) => entry.narratorId === CHILD)).toBe(true);
						const { toolContinuationService } = await import("../tool-continuation-service");
						const epoch = update.getUpdateCoordinationStatus().updateEpoch;
						expect(epoch).toBeString();
						expect(await toolContinuationService.listByEpoch(epoch ?? "")).toContainEqual(
							expect.objectContaining({
								toolCallId: "continued-tool-row",
								narratorId: CHILD,
								kind: "deferred_tool",
								state: "paused",
							}),
						);
						await update.waitForOrdinaryToolDrain();
						// Cancelling maintenance reopens the gate; the pending tool runs once.
						update.cancelScheduledUpdate("continued-run-test cancellation");
						update.failScheduledUpdate("continued-run-test cancellation", { cancelled: true });
						await entered.promise;
						expect(executions).toBe(1);
					} else {
						await entered.promise;
						update.scheduleUpdate("continued-run-test");
						update.beginQuiescingTools();
						expect(update.getUpdateCoordinationStatus()).toMatchObject({
							pendingOrdinaryExecutionCount: 1,
						});
						expect(listDeliveringRuns().some((entry) => entry.narratorId === CHILD)).toBe(true);
						let drained = false;
						const drain = update.waitForOrdinaryToolDrain().then(() => {
							drained = true;
						});
						await new Promise((resolve) => setImmediate(resolve));
						expect(drained).toBe(false);
						releaseTool.resolve();
						await drain;
						expect(drained).toBe(true);
						update.cancelScheduledUpdate("continued-run-test cancellation");
						update.failScheduledUpdate("continued-run-test cancellation", { cancelled: true });
					}
					releaseTool.resolve();
					await loopFinished.promise;
					await run?.terminal;
					expect(executions).toBe(1);
					expect(execute).toHaveBeenCalledTimes(1);
					expect(listDeliveringRuns().some((entry) => entry.narratorId === CHILD)).toBe(false);
				} finally {
					releaseTool.resolve();
					if (update.isUpdateScheduled()) update.failScheduledUpdate("continued-run-test cleanup");
					await run?.terminal;
				}
			});
		}
	}
});

async function waitUntil(predicate: () => boolean) {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for subagent runtime boundary");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

describe("shared execution owner through real entry adapters", () => {
	// Both entries are the same run service; "session" passes a prepared ActiveNarrator.
	for (const first of ["session", "run"] as const) {
		test(`${first} entry blocks every other start for the same narrator`, async () => {
			const gate = preparationBarrier([CHILD]);
			const running = failedPreparation(
				first === "session" ? runAgentLoop(active(CHILD), "start") : runOf(CHILD),
			);
			try {
				await gate.entered;
				const owner = getExecutionOwner(CHILD);
				expect(owner?.kind).toBe("run");
				expect(state.isNarratorRuntimeBusy(CHILD)).toBe(true);
				expect(state.narratorLoopAdmissions.has(CHILD)).toBe(true);
				expect(await runAgentLoop(active(CHILD), "duplicate")).toEqual({ started: false });
				const updateStatus = spyOn(narratorService, "updateStatus");
				// A competing start (a delegation, a wake, a recovery) is refused, not queued
				// as a second executor, and touches no status.
				expect(
					(await startNarratorRun({ narratorId: CHILD, locale: "en", text: "x" })).started,
				).toBe(false);
				expect(
					(
						await startNarratorRun({
							narratorId: CHILD,
							locale: "en",
							text: "x",
							foreground: true,
						})
					).started,
				).toBe(false);
				expect(updateStatus).not.toHaveBeenCalled();
				expect(getExecutionOwner(CHILD)).toBe(owner);
			} finally {
				gate.release();
				await running;
			}
			expect(getExecutionOwner(CHILD)).toBeUndefined();
			expect(state.isNarratorRuntimeBusy(CHILD)).toBe(false);
		});
	}

	for (const first of ["session", "run"] as const) {
		test(`${first} late failed preparation cannot clear its successor`, async () => {
			const gate = preparationBarrier([CHILD]);
			const session = active(CHILD);
			state.activeNarrators.set(CHILD, session);
			const run = failedPreparation(
				first === "session" ? runAgentLoop(session, "old") : runOf(CHILD),
			);
			try {
				await gate.entered;
				const old = getExecutionOwner(CHILD);
				if (!old) throw new Error("expected admitted owner");
				old.release();
				const successor = tryClaimExecution(CHILD, "run");
				if (!successor) throw new Error("expected successor");
				gate.release();
				await run;
				expect(getExecutionOwner(CHILD)).toBe(successor);
				expect(state.activeNarrators.get(CHILD)).toBe(session);
				expect(session.alive).toBe(true);
			} finally {
				gate.release();
				await run;
			}
		});
	}

	test("parent and two children run concurrently without holding the start mutex", async () => {
		const gate = preparationBarrier(ids);
		const runs = [
			failedPreparation(runAgentLoop(active(ROOT), "parent")),
			failedPreparation(runOf(CHILD)),
			failedPreparation(runOf(SIBLING)),
		];
		try {
			await gate.entered;
			for (const id of ids) expect(state.isNarratorRuntimeBusy(id)).toBe(true);
			expect(new Set(state.listNarratorAdmissionOwners(ROOT))).toEqual(new Set(ids));
			await state.withNarratorMutationAdmission(ROOT, async () => "permission feedback");
			await state.withNarratorStartAdmission(CHILD, async () => "short independent transition");
		} finally {
			gate.release();
			await Promise.all(runs);
		}
		expect(state.hasNarratorAdmissionWork(ROOT)).toBe(false);
	});

	test("a child does not make its idle parent busy", async () => {
		const gate = preparationBarrier([CHILD]);
		const run = failedPreparation(runOf(CHILD));
		try {
			await gate.entered;
			expect(state.isNarratorRuntimeBusy(CHILD)).toBe(true);
			expect(state.isNarratorRuntimeBusy(ROOT)).toBe(false);
			expect(state.hasNarratorAdmissionWork(ROOT)).toBe(true);
		} finally {
			gate.release();
			await run;
		}
	});

	test("a revert of the session rejects a run start before it claims an epoch", async () => {
		const reservation = state.reserveNarratorRevertAdmission(CHILD);
		const getById = spyOn(narratorService, "getById");
		try {
			await expect(runOf(CHILD)).rejects.toMatchObject({
				code: "NARRATOR_REVERT_IN_PROGRESS",
			});
			expect(getById).not.toHaveBeenCalled();
			expect(getExecutionOwner(CHILD)).toBeUndefined();
		} finally {
			reservation.release();
		}
	});
});

/**
 * A search channel's delegated run, the way the search router consumes it: the run's
 * true terminal, a failed terminal surfacing as a rejection so the next channel runs.
 */
async function searchChannel(): Promise<string> {
	const handle = await startNarratorRun({
		narratorId: CHILD,
		locale: "zh-CN",
		text: "search",
		principal: null,
		deliver: false,
	});
	const terminal = await handle.terminal;
	if (terminal.hasError || terminal.interrupted || terminal.timedOut)
		throw new Error(terminal.finalText || "Search subagent failed");
	return terminal.output;
}

describe("the run service owns the entire finalization", () => {
	test("search channel failures reject only after releasing the child execution owner", async () => {
		spyOn(passExecutor, "executeAgentLoop").mockResolvedValue({
			shouldUpdateTitle: false,
			completedNaturally: false,
			completedAssistantTurn: false,
			finalText: "native provider failed",
			hasError: true,
		});
		await expect(
			withSearchExecutionScope({ provider: "test", model: "test:model", maxTurns: 2 }, () =>
				searchChannel(),
			),
		).rejects.toThrow("native provider failed");
		expect(getExecutionOwner(CHILD)).toBeUndefined();
		expect(getSearchExecutionScope()).toBeUndefined();
	});
	test("search turn exhaustion cannot start a fresh continuation pass", async () => {
		settings.agent.autoContinuationMode = "always";
		const execute = spyOn(passExecutor, "executeAgentLoop").mockImplementation(async () => {
			consumeSearchExecutionTurn();
			return {
				shouldUpdateTitle: false,
				completedNaturally: false,
				completedAssistantTurn: false,
				finalText: "incomplete search",
				hasError: true,
				maxTurnsExceeded: true,
			};
		});
		await expect(
			withSearchExecutionScope({ provider: "test", model: "test:model", maxTurns: 1 }, () =>
				searchChannel(),
			),
		).rejects.toThrow("turn budget exhausted");
		expect(execute).toHaveBeenCalledTimes(1);
		expect(getExecutionOwner(CHILD)).toBeUndefined();
	});
	const upstreamDiagnostics = {
		schema: "narrafork.error-diagnostics.v1" as const,
		statusCode: 503,
		requestId: "last-budgeted-request",
	};
	const exhaustedFailures: Array<{
		name: string;
		pass: Partial<ExecuteLoopResult>;
		message: string;
		errorCode?: string;
		diagnostics?: typeof upstreamDiagnostics;
	}> = [
		{
			name: "silent disconnect",
			pass: { silentDisconnect: true },
			message: "Codex WebSocket silent disconnect",
		},
		{
			name: "payment required",
			pass: {
				paymentRequired: { message: "Insufficient upstream balance", resumeAction: "retry" },
			},
			message: "Insufficient upstream balance",
			errorCode: "payment_required",
		},
		{
			name: "retryable error with unlimited retry permission",
			pass: {
				retryableError: "Upstream connection reset",
				retryableErrorCode: "ECONNRESET",
				retryableDiagnostics: upstreamDiagnostics,
				bypassRetryLimit: true,
			},
			message: "Upstream connection reset",
			errorCode: "ECONNRESET",
			diagnostics: upstreamDiagnostics,
		},
		{
			name: "model unavailable",
			pass: {
				modelUnavailable: {
					message: "Upstream credentials unavailable",
					provider: "test",
					model: "test:model",
					diagnostics: upstreamDiagnostics,
				},
			},
			message: "Upstream credentials unavailable",
			diagnostics: upstreamDiagnostics,
		},
		{
			name: "ordinary upstream error despite a done signal",
			pass: {
				hasError: true,
				completedNaturally: true,
				finalText: "Error: Upstream rejected tool state",
				errorCode: "invalid_tool_state",
				errorDiagnostics: upstreamDiagnostics,
			},
			message: "Error: Upstream rejected tool state",
			errorCode: "invalid_tool_state",
			diagnostics: upstreamDiagnostics,
		},
		{
			name: "aborted pass",
			pass: { aborted: true },
			message: "Aborted",
		},
		{
			name: "context overflow",
			pass: { contextLengthExceeded: true },
			message: "Error: context length exceeded",
		},
		...[
			{
				name: "output truncation",
				pass: { interrupted: true, interruptedReason: "completion_limit" },
			},
			{
				name: "resumable error",
				pass: { interrupted: true, interruptedReason: "resumable_error" },
			},
			{ name: "completed assistant turn without done", pass: {} },
			{ name: "missing natural completion signal", pass: { completedNaturally: undefined } },
			{ name: "max turns without hasError", pass: { maxTurnsExceeded: true } },
		].map(({ name, pass }) => ({
			name,
			pass: pass as Partial<ExecuteLoopResult>,
			message: "Search execution turn budget exhausted",
		})),
	];
	for (const failure of exhaustedFailures) {
		test(`search budget exhaustion rejects ${failure.name} without replay`, async () => {
			settings.agent.autoContinuationMode = "always";
			const update = spyOn(narratorService, "updateStatus");
			const execute = spyOn(passExecutor, "executeAgentLoop").mockImplementation(async () => {
				expect(getSearchExecutionScope()?.remainingTurns).toBe(1);
				consumeSearchExecutionTurn();
				return {
					shouldUpdateTitle: false,
					completedNaturally: false,
					completedAssistantTurn: true,
					finalText: "partial output must not become a successful answer",
					hasError: false,
					...failure.pass,
				};
			});
			await expect(
				withSearchExecutionScope({ provider: "test", model: "test:model", maxTurns: 1 }, () =>
					searchChannel(),
				),
			).rejects.toThrow(failure.message);
			const finalStatus = update.mock.calls.filter(([id]) => id === CHILD).at(-1);
			expect(finalStatus?.[1]).toBe("idle");
			expect(finalStatus?.[2]).toMatchObject({
				substatus: ["error"],
				errorMessage: failure.message,
				errorCode: failure.errorCode,
				diagnostics: failure.diagnostics,
			});
			expect(await narratorService.getById(CHILD)).toMatchObject({
				status: "idle",
				errorMessage: failure.message,
			});
			expect(execute).toHaveBeenCalledTimes(1);
			expect(getExecutionOwner(CHILD)).toBeUndefined();
			expect(getSearchExecutionScope()).toBeUndefined();
		});
	}
	for (const finalText of ["natural search answer", ""]) {
		test(`search budget permits explicit natural completion with ${finalText ? "text" : "empty text"}`, async () => {
			settings.agent.autoContinuationMode = "always";
			const execute = spyOn(passExecutor, "executeAgentLoop").mockImplementation(async () => {
				consumeSearchExecutionTurn();
				return {
					shouldUpdateTitle: false,
					completedNaturally: true,
					completedAssistantTurn: true,
					finalText,
					hasError: false,
				};
			});
			await expect(
				withSearchExecutionScope({ provider: "test", model: "test:model", maxTurns: 1 }, () =>
					searchChannel(),
				),
			).resolves.toBeString();
			expect(execute).toHaveBeenCalledTimes(1);
			expect(getExecutionOwner(CHILD)).toBeUndefined();
		});
	}
	for (const foreground of [true, false]) {
		test(`${foreground ? "foreground" : "detached"} run refuses competing starts while its finalizer is awaiting`, async () => {
			spyOn(sessionModule, "startBackgroundCompletionContinuationIfPossible").mockResolvedValue({
				started: false,
			});
			spyOn(passExecutor, "executeAgentLoop").mockResolvedValue({
				shouldUpdateTitle: false,
				completedNaturally: true,
				completedAssistantTurn: true,
				finalText: "finished pass",
				hasError: false,
			});
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const realUpdate = narratorService.updateStatus.bind(narratorService);
			spyOn(narratorService, "updateStatus").mockImplementation(async (...args) => {
				if (args[0] === CHILD && args[1] === "idle") {
					entered.resolve();
					await release.promise;
				}
				return realUpdate(...args);
			});
			const handle = await startNarratorRun({
				narratorId: CHILD,
				locale: "en",
				text: "run",
				principal: null,
				foreground,
				deliver: false,
			});
			try {
				await entered.promise;
				const owner = getExecutionOwner(CHILD);
				expect(owner?.kind).toBe("run");
				expect(state.isNarratorRuntimeBusy(CHILD)).toBe(true);
				expect(await runAgentLoop(active(CHILD), "competing primary")).toEqual({ started: false });
				expect(
					(await startNarratorRun({ narratorId: CHILD, locale: "en", text: "x" })).started,
				).toBe(false);
				expect(getExecutionOwner(CHILD)).toBe(owner);
			} finally {
				release.resolve();
				await handle.terminal;
			}
			expect(getExecutionOwner(CHILD)).toBeUndefined();
			expect(state.hasNarratorAdmissionWork(ROOT)).toBe(false);
		});
	}

	test("an existing owner rejects duplicate starts without releasing the run", async () => {
		const owner = tryClaimExecution(CHILD, "run");
		if (!owner) throw new Error("expected runner owner");
		// The production admission owner, not a redundant per-pass reservation,
		// excludes every competing run start.
		expect(tryClaimExecution(CHILD, "run")).toBeNull();
		// A separate run start never borrows the owner it does not hold.
		expect((await startNarratorRun({ narratorId: CHILD, locale: "en", text: "x" })).started).toBe(
			false,
		);
		expect(getExecutionOwner(CHILD)).toBe(owner);
		owner.release();
	});

	test("a held run parks on the same epoch and resumes through the control channel", async () => {
		const { getRunControl, isExecutionSuspended, setRunHold } = await import(
			"../agent-runtime/ownership"
		);
		const { controlRun } = await import("../agent-runtime/run");
		const execute = spyOn(passExecutor, "executeAgentLoop").mockResolvedValue({
			shouldUpdateTitle: false,
			completedNaturally: true,
			completedAssistantTurn: true,
			finalText: "one pass",
			hasError: false,
		});
		setRunHold(CHILD, { released: false });
		const handle = await startNarratorRun({
			narratorId: CHILD,
			locale: "en",
			text: "run",
			principal: null,
			deliver: false,
		});
		try {
			await waitUntil(() => !!getRunControl(CHILD)?.wake);
			const owner = getExecutionOwner(CHILD);
			expect(owner).toBeDefined();
			expect(isExecutionSuspended(CHILD)).toBe(true);
			expect(sessionModule.isLoopRunning(CHILD)).toBe(false);
			expect(state.isNarratorRuntimeBusy(CHILD)).toBe(true);
			expect(await runAgentLoop(active(CHILD), "competing suspended loop")).toEqual({
				started: false,
			});
			// Queued input wakes the same run; the release lets it end after that turn.
			const { enqueueBufferedMessage } = await import("../narrator-buffer");
			await enqueueBufferedMessage(CHILD, "resume");
			setRunHold(CHILD, { released: true });
			getRunControl(CHILD)?.wake?.("input");
			expect(getExecutionOwner(CHILD)).toBe(owner);
			await handle.terminal;
			expect(execute).toHaveBeenCalledTimes(2);
			expect(getExecutionOwner(CHILD)).toBeUndefined();
		} finally {
			await controlRun(CHILD, { kind: "cancel" });
			setRunHold(CHILD, undefined);
			await handle.terminal;
		}
	});

	test("a failed run keeps queued input for an explicit retry", async () => {
		spyOn(passExecutor, "executeAgentLoop").mockImplementation(async () => {
			// Input arrives while the failing pass runs.
			await bufferModule.enqueueBufferedMessage(CHILD, "keep me");
			return {
				shouldUpdateTitle: false,
				completedNaturally: false,
				completedAssistantTurn: false,
				finalText: "provider failed",
				hasError: true,
			};
		});
		const wake = spyOn(await import("../agent-runtime/inbox"), "wakeInboxIfEligible");
		try {
			const handle = await startNarratorRun({
				narratorId: CHILD,
				locale: "en",
				text: "run",
				principal: null,
				deliver: false,
			});
			expect((await handle.terminal).hasError).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 20));
			// Not consumed by the failing run and not auto-woken past the failure.
			expect((await bufferModule.getBufferedMessages(CHILD)).map((m) => m.text)).toEqual([
				"keep me",
			]);
			expect(wake.mock.calls.filter(([id]) => id === CHILD)).toHaveLength(0);
			expect(getExecutionOwner(CHILD)).toBeUndefined();
		} finally {
			await bufferModule.clearBufferedMessages(CHILD);
		}
	});

	test("an expired owner's release cannot clear a successor run or its queue", async () => {
		const old = tryClaimExecution(CHILD, "run");
		if (!old) throw new Error("expected old owner");
		old.release();
		const current = tryClaimExecution(CHILD, "run");
		if (!current) throw new Error("expected successor");
		const accepted = await bufferModule.enqueueBufferedMessage(CHILD, "keep me");
		expect(accepted.ok).toBe(true);
		const queued = await bufferModule.getBufferedMessages(CHILD);
		try {
			expect(old.release()).toBe(false);
			expect(await bufferModule.getBufferedMessages(CHILD)).toEqual(queued);
			expect(getExecutionOwner(CHILD)).toBe(current);
		} finally {
			await bufferModule.clearBufferedMessages(CHILD);
		}
	});
});

describe("epoch CAS and legacy projections", () => {
	test("occupancy liveness keeps the remaining session or execution owner live", () => {
		const publish = spyOn(backgroundOccupancyStore, "setRuntimeLive").mockImplementation(() => {});
		const first = tryClaimExecution(CHILD, "run");
		if (!first) throw new Error("expected owner");
		expect(publish).toHaveBeenLastCalledWith(CHILD, true);
		state.activeNarrators.set(CHILD, active(CHILD));
		first.release();
		expect(publish).toHaveBeenLastCalledWith(CHILD, true);
		state.activeNarrators.delete(CHILD);
		expect(publish).toHaveBeenLastCalledWith(CHILD, false);

		const second = tryClaimExecution(CHILD, "run");
		if (!second) throw new Error("expected second owner");
		state.activeNarrators.set(CHILD, active(CHILD));
		state.activeNarrators.delete(CHILD);
		expect(publish).toHaveBeenLastCalledWith(CHILD, true);
		expect(first.release()).toBe(false);
		expect(publish).toHaveBeenLastCalledWith(CHILD, true);
		second.release();
		expect(publish).toHaveBeenLastCalledWith(CHILD, false);
	});

	test("occupancy liveness follows tool-replay views, including clear", () => {
		const publish = spyOn(backgroundOccupancyStore, "setRuntimeLive").mockImplementation(() => {});
		const replay = createRuntimeMapView("toolReplayCompletion");
		replay.set(CHILD, Promise.resolve());
		expect(publish).toHaveBeenLastCalledWith(CHILD, true);
		replay.clear();
		expect(publish).toHaveBeenLastCalledWith(CHILD, false);
	});

	test("occupancy suspension preserves session presence and resumes the same owner", () => {
		const publish = spyOn(backgroundOccupancyStore, "setRuntimeLive").mockImplementation(() => {});
		const owner = tryClaimExecution(CHILD, "run");
		if (!owner) throw new Error("expected owner");
		try {
			setExecutionSuspended(owner, true);
			expect(publish).toHaveBeenLastCalledWith(CHILD, false);
			state.activeNarrators.set(CHILD, active(CHILD));
			expect(publish).toHaveBeenLastCalledWith(CHILD, true);
			state.activeNarrators.clear();
			expect(publish).toHaveBeenLastCalledWith(CHILD, false);
			setExecutionSuspended(owner, false);
			expect(publish).toHaveBeenLastCalledWith(CHILD, true);
		} finally {
			owner.release();
		}
	});

	test("status and substatus refresh occupancy after persistence, but rejected CAS does not", async () => {
		const observed: { status: string; substatus: string }[] = [];
		const refresh = spyOn(backgroundOccupancyStore, "refreshNarrator").mockImplementation((id) => {
			const row = db
				.select({ status: narrators.status, substatus: narrators.substatus })
				.from(narrators)
				.where(eq(narrators.id, id))
				.get();
			if (!row) throw new Error("refresh must observe a committed narrator");
			observed.push(row);
		});
		await narratorService.updateStatus(CHILD, "working");
		expect(observed.at(-1)?.status).toBe("working");
		refresh.mockClear();
		expect(await narratorService.compareAndSetStatus(CHILD, "idle", "waiting")).toBe(false);
		expect(refresh).not.toHaveBeenCalled();
		expect(await narratorService.compareAndSetStatus(CHILD, "working", "idle")).toBe(true);
		expect(observed.at(-1)?.status).toBe("idle");
		await narratorService.addSubstatus(CHILD, "taken_over");
		expect(JSON.parse(observed.at(-1)?.substatus ?? "[]")).toContain("taken_over");
		await narratorService.removeSubstatus(CHILD, "taken_over");
		expect(JSON.parse(observed.at(-1)?.substatus ?? "[]")).not.toContain("taken_over");
	});

	test("narrator removal refreshes surviving forks only after detach and task cascade commit", async () => {
		db.update(narrators)
			.set({ type: "primary", variant: "primary" })
			.where(eq(narrators.id, SIBLING))
			.run();
		const now = new Date().toISOString();
		db.insert(backgroundTasks)
			.values({
				id: "occupancy-cascaded-task",
				parentNarratorId: ROOT,
				subagentNarratorId: CHILD,
				type: "agent",
				status: "running",
				startedAt: now,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		const remove = backgroundOccupancyStore.removeNarrators.bind(backgroundOccupancyStore);
		const refresh = backgroundOccupancyStore.refreshNarrators.bind(backgroundOccupancyStore);
		const removals = spyOn(backgroundOccupancyStore, "removeNarrators").mockImplementation(
			(ids) => {
				for (const id of ids) {
					expect(
						db.select({ id: narrators.id }).from(narrators).where(eq(narrators.id, id)).get(),
					).toBeUndefined();
				}
				expect(db.select({ id: backgroundTasks.id }).from(backgroundTasks).get()).toBeUndefined();
				remove(ids);
			},
		);
		const refreshes = spyOn(backgroundOccupancyStore, "refreshNarrators").mockImplementation(
			(ids) => {
				if (ids.includes(SIBLING)) {
					expect(
						db
							.select({ parent: narrators.parentNarratorId })
							.from(narrators)
							.where(eq(narrators.id, SIBLING))
							.get()?.parent,
					).toBeNull();
				}
				refresh(ids);
			},
		);
		await narratorService.remove(ROOT);
		expect(removals).toHaveBeenCalledWith([CHILD]);
		expect(removals).toHaveBeenCalledWith([ROOT]);
		expect(refreshes).toHaveBeenCalledWith([SIBLING]);
	});

	test("old releases cannot clear a new owner or its session view", () => {
		const old = tryClaimExecution(CHILD, "run");
		if (!old) throw new Error("expected old owner");
		expect(old.release()).toBe(true);
		const current = tryClaimExecution(CHILD, "run");
		if (!current) throw new Error("expected current owner");
		const session = active(CHILD);
		state.activeNarrators.set(CHILD, session);
		expect(old.epoch).not.toBe(current.epoch);
		expect(old.isCurrent()).toBe(false);
		expect(old.release()).toBe(false);
		expect(getExecutionOwner(CHILD)).toBe(current);
		expect(state.activeNarrators.get(CHILD)).toBe(session);
		expect([...state.activeNarrators]).toEqual([[CHILD, session]]);
		state.activeNarrators.clear();
		expect(state.isNarratorRuntimeBusy(CHILD)).toBe(true);
	});

	test("runtime busy claims do not own the execution slot", () => {
		const release = state.claimNarratorRuntime(ROOT, "recovery-publication");
		try {
			const owner = tryClaimExecution(ROOT, "run");
			if (!owner) throw new Error("expected execution owner");
			expect(owner).not.toBeNull();
			expect(tryClaimExecution(ROOT, "run")).toBeNull();
			owner.release();
			expect(state.isNarratorRuntimeBusy(ROOT)).toBe(true);
		} finally {
			release();
		}
	});
});

describe("shared event context", () => {
	test("a delivering run's pass context carries its placement and pass-local state", async () => {
		const contexts: Array<import("../narrator-event-handler").EventHandlerContext> = [];
		spyOn(passExecutor, "executeAgentLoop").mockImplementation(async (options) => {
			contexts.push(options.eventContext);
			options.eventContext.setMeterData(12, "tokens");
			return {
				shouldUpdateTitle: false,
				completedNaturally: contexts.length > 1,
				completedAssistantTurn: true,
				finalText: "done",
				hasError: false,
				interrupted: contexts.length === 1,
				interruptedReason: "completion_limit",
			};
		});
		const handle = await startNarratorRun({
			narratorId: CHILD,
			locale: "zh-CN",
			text: "run",
			principal: null,
			deliver: false,
		});
		await handle.terminal;
		expect(contexts.length).toBeGreaterThanOrEqual(2);
		expect(contexts[0]).toMatchObject({
			narratorId: CHILD,
			broadcastTargetId: ROOT,
			provider: "test",
			providerPrefix: "test",
			model: "test:model",
			locale: "zh-CN",
			parentToolUseId: "spawn-tool",
		});
		// Request bookkeeping is per pass; no map is shared across passes.
		expect(contexts[1].toolCallIdsMap).not.toBe(contexts[0].toolCallIdsMap);
	});

	test("primary retains caller-owned metering, SSE, TTFT and substatus accessors", () => {
		const session = active(ROOT);
		const context = createRuntimeEventContext({
			narratorId: ROOT,
			conversationId: "conversation",
			model: "test:model",
			provider: "test",
			locale: "zh-CN",
			sseEmitter: session.events,
			getTtftMs: () => session._ttftMs,
			setTtftMs: (ms) => {
				session._ttftMs = ms;
			},
			getSubstatus: () => session._substatus,
			getMeterUsage: () => session._lastMeterUsage,
			setMeterData: (usage) => {
				session._lastMeterUsage = usage;
			},
		});
		context.setMeterData(4, "tokens");
		context.setTtftMs?.(25);
		expect(context.sseEmitter).toBe(session.events);
		expect(context.getMeterUsage()).toBe(4);
		expect(session._lastMeterUsage).toBe(4);
		expect(context.getTtftMs?.()).toBe(25);
		expect(context.getSubstatus?.()).toBe(session._substatus);
	});
});
