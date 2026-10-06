import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";
import {
	consumeSearchExecutionTurn,
	getSearchExecutionScope,
	withSearchExecutionScope,
} from "../../lib/search/execution-scope";
import type { ExecuteLoopResult } from "../narrator-executor";
import type { ActiveNarrator } from "../narrator-session-state";
import type { SubagentExecOptions } from "../subagent-executor";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
// Context now imports publication services; load it only after binding the isolated DB.
const { createRuntimeEventContext } = await import("../agent-runtime/context");
const { getExecutionOwner, tryClaimExecution } = await import("../agent-runtime/ownership");
const sessionModule = await import("../narrator-session");
const { runAgentLoop } = sessionModule;
const executorModule = await import("../subagent-executor");
const { executeSubagent, buildSubagentEventContext } = executorModule;
const { executeBackgroundTask, runForegroundLoop, startForegroundRun, startContinuedSubagent } =
	await import("../subagent-runner");
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
const unregisterProvider = registerExternalProviderResolver((name) =>
	name === "test" ? provider : null,
);

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
		state.activeSubagentSettings.delete(id);
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
function child(narratorId = CHILD): SubagentExecOptions {
	return {
		narratorId,
		parentNarratorId: ROOT,
		toolUseId: "spawn-tool",
		subagentType: "general",
		prompt: "owner test",
		cwd: process.env.HOME as string,
		model: "test:model",
		provider: "test",
		locale: "zh-CN",
		signal: new AbortController().signal,
		systemPrompt: "test",
		initialHistory: [],
	};
}

/** Pause real entry adapters after admission, before any model/file preparation. */
function preparationBarrier(expectedIds: string[]) {
	const entered = new Map(expectedIds.map((id) => [id, Promise.withResolvers<void>()]));
	const done = Promise.withResolvers<void>();
	spyOn(narratorService, "getById").mockImplementation(async (id) => {
		entered.get(id)?.resolve();
		await done.promise;
		throw new Error("controlled preparation failure");
	});
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

describe("publication release respects the runtime inbox wake decision", () => {
	for (const mode of ["foreground", "background", "resume", "deferred-resume"] as const) {
		for (const allowInboxWake of [false, true]) {
			test(`${mode}: allowInboxWake=${allowInboxWake}`, async () => {
				const orchestrator = await import("../agent-runtime/orchestrator");
				const inbox = await import("../agent-runtime/inbox");
				const { runtimePublication } = await import("../agent-runtime/publication");
				spyOn(orchestrator, "runAgentLoopUnlocked").mockResolvedValue({
					started: true,
					finalText: allowInboxWake ? "done" : "Balance exhausted / retries exhausted",
					hasError: !allowInboxWake,
					allowInboxWake,
				});
				const wake = spyOn(inbox, "wakeInboxIfEligible").mockResolvedValue(false);
				if (mode === "background") {
					runtimePublication.startAgentRun({ narratorId: CHILD, parentNarratorId: ROOT });
					await executeBackgroundTask(child());
				} else if (mode === "foreground") {
					const run = startForegroundRun({
						...child(),
						subagentId: CHILD,
						initialHistory: [],
						customDef: null,
					});
					expect((await run.terminal).allowInboxWake).toBe(allowInboxWake);
				} else {
					const run = await startContinuedSubagent({
						subagentId: CHILD,
						parentNarratorId: ROOT,
						toolUseId: "origin-tool",
						prompt: "continue",
						locale: "en",
						signal: new AbortController().signal,
						persistPrompt: false,
						initialHistory: [],
						initialTrailingToolResults: [],
						skipConclusionDelivery: true,
						deferPublicationRelease: mode === "deferred-resume",
					});
					await run.terminalCompletion;
					if (mode === "deferred-resume") {
						expect(wake).not.toHaveBeenCalled();
						expect(getExecutionOwner(CHILD)).toBeDefined();
						run.releasePublication?.();
					}
				}
				// The release schedules its dynamic import without awaiting the wake.
				await new Promise((resolve) => setImmediate(resolve));
				expect(getExecutionOwner(CHILD)).toBeUndefined();
				expect(wake.mock.calls.filter(([id]) => id === CHILD)).toHaveLength(allowInboxWake ? 1 : 0);
			});
		}
	}
});

describe("shared execution owner through real entry adapters", () => {
	for (const first of ["primary", "subagent"] as const) {
		test(`${first} blocks both entry adapters for the same narrator`, async () => {
			const gate = preparationBarrier([CHILD]);
			const running = failedPreparation(
				first === "primary" ? runAgentLoop(active(CHILD), "start") : executeSubagent(child()),
			);
			try {
				await gate.entered;
				const owner = getExecutionOwner(CHILD);
				expect(owner?.kind).toBe(first);
				expect(state.isNarratorRuntimeBusy(CHILD)).toBe(true);
				expect(state.narratorLoopAdmissions.has(CHILD)).toBe(true);
				expect(await runAgentLoop(active(CHILD), "duplicate")).toEqual({ started: false });
				await expect(executeSubagent(child())).rejects.toMatchObject({
					code: "NARRATOR_EXECUTION_BUSY",
				});
				const updateStatus = spyOn(narratorService, "updateStatus");
				await expect(executeBackgroundTask(child())).rejects.toMatchObject({
					code: "NARRATOR_EXECUTION_BUSY",
				});
				const foreground = startForegroundRun({
					...child(),
					subagentId: CHILD,
					initialHistory: [],
					customDef: null,
				});
				await expect(foreground.foreground).rejects.toMatchObject({
					code: "NARRATOR_EXECUTION_BUSY",
				});
				await expect(foreground.terminal).rejects.toMatchObject({
					code: "NARRATOR_EXECUTION_BUSY",
				});
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

	for (const first of ["primary", "subagent"] as const) {
		test(`${first} late failed preparation cannot clear its successor`, async () => {
			const gate = preparationBarrier([CHILD]);
			const session = active(CHILD);
			state.activeNarrators.set(CHILD, session);
			const run = failedPreparation(
				first === "primary" ? runAgentLoop(session, "old") : executeSubagent(child()),
			);
			try {
				await gate.entered;
				const old = getExecutionOwner(CHILD);
				if (!old) throw new Error("expected admitted owner");
				old.release();
				const successor = tryClaimExecution(CHILD, "primary");
				if (!successor) throw new Error("expected successor");
				state.registerActiveSubagent(CHILD, "successor:model", null);
				gate.release();
				await run;
				expect(getExecutionOwner(CHILD)).toBe(successor);
				expect(state.activeNarrators.get(CHILD)).toBe(session);
				expect(session.alive).toBe(true);
				expect(state.activeSubagentSettings.get(CHILD)?.model).toBe("successor:model");
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
			failedPreparation(executeSubagent(child(CHILD))),
			failedPreparation(executeSubagent(child(SIBLING))),
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
		const run = failedPreparation(executeSubagent(child()));
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

	test("a root revert rejects child preparation before it claims an epoch", async () => {
		const reservation = state.reserveNarratorRevertAdmission(ROOT);
		const getById = spyOn(narratorService, "getById");
		try {
			await expect(executeSubagent(child())).rejects.toMatchObject({
				code: "NARRATOR_REVERT_IN_PROGRESS",
			});
			expect(getById).not.toHaveBeenCalled();
			expect(getExecutionOwner(CHILD)).toBeUndefined();
		} finally {
			reservation.release();
		}
	});
});

describe("runner owns the entire finalization and publication", () => {
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
				runForegroundLoop({
					...child(),
					subagentType: "search",
					subagentId: CHILD,
					initialHistory: [],
					customDef: null,
				}),
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
				runForegroundLoop({
					...child(),
					subagentType: "search",
					subagentId: CHILD,
					initialHistory: [],
					customDef: null,
				}),
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
					runForegroundLoop({
						...child(),
						subagentType: "search",
						subagentId: CHILD,
						initialHistory: [],
						customDef: null,
					}),
				),
			).rejects.toThrow(failure.message);
			expect(update).toHaveBeenCalledWith(CHILD, "idle", {
				substatus: ["error"],
				errorMessage: failure.message,
				errorCode: failure.errorCode,
				diagnostics: failure.diagnostics,
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
					runForegroundLoop({
						...child(),
						subagentType: "search",
						subagentId: CHILD,
						initialHistory: [],
						customDef: null,
					}),
				),
			).resolves.toBeString();
			expect(execute).toHaveBeenCalledTimes(1);
			expect(getExecutionOwner(CHILD)).toBeUndefined();
		});
	}
	for (const background of [false, true]) {
		test(`${background ? "background" : "foreground"} refuses competing starts while finalizer is awaiting`, async () => {
			const directExecutor = executeSubagent;
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
			if (background) {
				// Direct runner fixtures must register the same durable run slots as task creation.
				const { runtimePublication } = await import("../agent-runtime/publication");
				runtimePublication.startAgentRun({ narratorId: CHILD, parentNarratorId: ROOT });
			}
			const completion = background
				? executeBackgroundTask(child())
				: startForegroundRun({
						...child(),
						subagentId: CHILD,
						initialHistory: [],
						customDef: null,
					}).terminal;
			try {
				await entered.promise;
				const owner = getExecutionOwner(CHILD);
				expect(owner?.kind).toBe("subagent");
				expect(state.isNarratorRuntimeBusy(CHILD)).toBe(true);
				expect(await runAgentLoop(active(CHILD), "competing primary")).toEqual({ started: false });
				await expect(directExecutor(child())).rejects.toMatchObject({
					code: "NARRATOR_EXECUTION_BUSY",
				});
				await expect(executeBackgroundTask(child())).rejects.toMatchObject({
					code: "NARRATOR_EXECUTION_BUSY",
				});
				expect(getExecutionOwner(CHILD)).toBe(owner);
			} finally {
				release.resolve();
				await completion;
			}
			expect(getExecutionOwner(CHILD)).toBeUndefined();
			expect(state.hasNarratorAdmissionWork(ROOT)).toBe(false);
		});
	}

	test("continued background publication retains the borrowed owner after the inner runner ends", async () => {
		await db
			.update(narrators)
			.set({ model: "test:model", cwd: process.env.HOME })
			.where(eq(narrators.id, CHILD));
		spyOn(passExecutor, "executeAgentLoop").mockResolvedValue({
			shouldUpdateTitle: false,
			completedNaturally: true,
			completedAssistantTurn: true,
			finalText: "continued result",
			hasError: false,
		});
		spyOn(sessionModule, "startBackgroundCompletionContinuationIfPossible").mockResolvedValue({
			started: false,
		});
		// P2 publishes the terminal state only with the caller's exact conclusion transaction.
		// Exercise its real ownership handoff instead of waiting for a pre-publication status read.
		const run = await startContinuedSubagent({
			subagentId: CHILD,
			parentNarratorId: ROOT,
			toolUseId: "origin-tool",
			prompt: "continue",
			locale: "en",
			signal: new AbortController().signal,
			persistPrompt: false,
			initialHistory: [],
			initialTrailingToolResults: [],
			preserveBackground: true,
			deferPublicationRelease: true,
		});
		try {
			await run.terminalCompletion;
			expect(run.takeResumedBackgroundAnnouncement?.()).toMatchObject({
				subagentId: CHILD,
				parentNarratorId: ROOT,
				status: "completed",
			});
			expect(getExecutionOwner(CHILD)?.kind).toBe("subagent");
			expect(await runAgentLoop(active(CHILD), "competing publication")).toEqual({
				started: false,
			});
			await expect(executeBackgroundTask(child())).rejects.toMatchObject({
				code: "NARRATOR_EXECUTION_BUSY",
			});
		} finally {
			await run.terminalCompletion;
			run.releasePublication?.();
			await run.completion;
		}
		expect(getExecutionOwner(CHILD)).toBeUndefined();
	});

	test("borrowing an owner does not permit duplicate executor passes or release the runner", async () => {
		const owner = tryClaimExecution(CHILD, "subagent");
		if (!owner) throw new Error("expected runner owner");
		const gate = preparationBarrier([CHILD]);
		const run = failedPreparation(executeSubagent(child(), owner));
		try {
			await gate.entered;
			await expect(executeSubagent(child(), owner)).rejects.toMatchObject({
				code: "NARRATOR_EXECUTION_BUSY",
			});
		} finally {
			gate.release();
			await run;
		}
		expect(getExecutionOwner(CHILD)).toBe(owner);
		owner.release();
	});

	test("a suspended foreground runner resumes the same epoch through its control channel", async () => {
		const manual = await import("../subagent-manual-override");
		const takeover = await import("../subagent-takeover");
		const { isExecutionSuspended } = await import("../agent-runtime/ownership");
		await db.update(narrators).set({ model: "test:model" }).where(eq(narrators.id, CHILD));
		const execute = spyOn(passExecutor, "executeAgentLoop").mockResolvedValue({
			shouldUpdateTitle: false,
			completedNaturally: true,
			completedAssistantTurn: true,
			finalText: "one pass",
			hasError: false,
		});
		const entered = Promise.withResolvers<void>();
		const originalWait = manual.waitForManualOverride;
		spyOn(manual, "waitForManualOverride").mockImplementation((...args) => {
			const control = originalWait(...args);
			entered.resolve();
			return control;
		});
		takeover.markTakenOver(CHILD);
		const run = startForegroundRun({
			...child(),
			subagentId: CHILD,
			initialHistory: [],
			customDef: null,
		});
		try {
			await entered.promise;
			const owner = getExecutionOwner(CHILD);
			expect(owner).toBeDefined();
			expect(isExecutionSuspended(CHILD)).toBe(true);
			expect(sessionModule.isLoopRunning(CHILD)).toBe(false);
			expect(state.isNarratorRuntimeBusy(CHILD)).toBe(true);
			expect(await runAgentLoop(active(CHILD), "competing suspended loop")).toEqual({
				started: false,
			});
			takeover.clearTakenOver(CHILD);
			expect(
				manual.resumeManualOverride(CHILD, {
					prompt: "resume",
					history: [],
					trailingToolResults: [],
				}),
			).toBe(true);
			expect(getExecutionOwner(CHILD)).toBe(owner);
			await run.terminal;
			expect(execute).toHaveBeenCalledTimes(2);
			expect(getExecutionOwner(CHILD)).toBeUndefined();
		} finally {
			takeover.clearTakenOver(CHILD);
			manual.clearManualOverrideRuntimes();
			await run.terminal;
		}
	});

	test("expired finalizer cannot clear a successor queue or status", async () => {
		const old = tryClaimExecution(CHILD, "subagent");
		if (!old) throw new Error("expected old owner");
		old.release();
		const current = tryClaimExecution(CHILD, "subagent");
		if (!current) throw new Error("expected successor");
		const accepted = await executorModule.pushSubagentBufferedMessage(CHILD, "keep me");
		expect(accepted.ok).toBe(true);
		const queued = executorModule.getSubagentBufferedMessages(CHILD);
		expect(queued).toHaveLength(1);
		expect(queued[0]).toMatchObject({ id: accepted.id, text: "keep me" });
		const update = spyOn(narratorService, "updateStatus");
		try {
			await executorModule.finalizeSubagent(CHILD, ROOT, "old-origin", false, null, { owner: old });
			expect(executorModule.getSubagentBufferedMessages(CHILD)).toEqual(queued);
			expect(update).not.toHaveBeenCalled();
			expect(getExecutionOwner(CHILD)).toBe(current);
		} finally {
			executorModule.clearSubagentBufferedMessages(CHILD);
		}
	});
});

describe("epoch CAS and legacy projections", () => {
	test("old releases cannot clear a new owner or its session/settings view", () => {
		const old = tryClaimExecution(CHILD, "subagent");
		if (!old) throw new Error("expected old owner");
		expect(old.release()).toBe(true);
		const current = tryClaimExecution(CHILD, "primary");
		if (!current) throw new Error("expected current owner");
		const session = active(CHILD);
		state.activeNarrators.set(CHILD, session);
		state.registerActiveSubagent(CHILD, "new:model", null);
		expect(old.epoch).not.toBe(current.epoch);
		expect(old.isCurrent()).toBe(false);
		expect(old.release()).toBe(false);
		expect(getExecutionOwner(CHILD)).toBe(current);
		expect(state.activeNarrators.get(CHILD)).toBe(session);
		expect([...state.activeNarrators]).toEqual([[CHILD, session]]);
		expect(state.activeSubagentSettings.get(CHILD)?.model).toBe("new:model");
		state.activeNarrators.clear();
		state.activeSubagentSettings.clear();
		expect(state.isNarratorRuntimeBusy(CHILD)).toBe(true);
	});

	test("runtime busy claims do not own the execution slot", () => {
		const release = state.claimNarratorRuntime(ROOT, "recovery-publication");
		try {
			const owner = tryClaimExecution(ROOT, "primary");
			if (!owner) throw new Error("expected execution owner");
			expect(owner).not.toBeNull();
			expect(tryClaimExecution(ROOT, "subagent")).toBeNull();
			owner.release();
			expect(state.isNarratorRuntimeBusy(ROOT)).toBe(true);
		} finally {
			release();
		}
	});
});

describe("shared event context", () => {
	test("child initializes provider/model/locale before any request event", () => {
		const context = buildSubagentEventContext(
			CHILD,
			ROOT,
			"spawn",
			"conversation",
			"test:model",
			"test",
			"zh-CN",
		);
		expect(context).toMatchObject({
			narratorId: CHILD,
			broadcastTargetId: ROOT,
			provider: "test",
			providerPrefix: "test",
			model: "test:model",
			locale: "zh-CN",
			parentToolUseId: "spawn",
			subagentModel: "test:model",
		});
		context.setMeterData(12, "tokens");
		expect(context.getMeterUsage()).toBe(12);
		const next = buildSubagentEventContext(
			CHILD,
			ROOT,
			"spawn",
			"conversation",
			"test:model",
			"test",
			"en",
		);
		expect(next.getMeterUsage()).toBeUndefined();
		expect(next.toolCallIdsMap).not.toBe(context.toolCallIdsMap);
		expect(context.apiRequestsMap).toBeUndefined();
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
