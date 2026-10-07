import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, type SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { cleanDb } from "../../../tests/setup";

const originToolUseId = "origin-tool-use";
const parentNarratorId = "parent-narrator";
const startCalls: Array<Record<string, unknown>> = [];
const persistedCalls: Array<Record<string, unknown>> = [];
const conclusionCalls: Array<Record<string, unknown>> = [];
const retriedToolCalls: Array<Record<string, unknown>> = [];
let beforeDeniedRetryIo: (() => Promise<void>) | undefined;
let deniedRetryShouldContinue = true;
const editedMessageCalls: Array<Record<string, unknown>> = [];
const deleteMessagesAfterCalls: Array<Record<string, unknown>> = [];
const foregroundResolvers = new Map<string, (output: string) => void>();
const terminalResolvers = new Map<string, (output: string) => void>();
// Simulates the origin-resolution outcome: null means the subagent has never
// been started by its parent (no originating Agent tool call exists), i.e. a
// plugin-recruited team temp worker.
let originResult: { parentToolUseId: string } | null = { parentToolUseId: originToolUseId };
// Subagents whose narrator record reports a stale "working" status (created but
// never actually run).
const workingSubagentIds = new Set<string>();
const standaloneSubagentIds = new Set<string>();
const unknownOriginIds = new Set<string>();
const mismatchedMarkerIds = new Set<string>();
const databaseNarratorIds = new Set<string>();
const announcements: unknown[] = [];
// Fixture mailbox heads consumed by a mailbox wake, and who consumed them.
const queuedMailboxInputs: string[] = [];
const mailboxConsumeCalls: string[] = [];
/**
 * One-shot hook run inside the resume preparation window (after the manual-override
 * claim, before the mailbox head is consumed). Used to park a `pendingTerminal` on
 * the claimed entry mid-resume without racing the real timer.
 */
let duringPrepare: (() => void) | undefined;
let realConclusionResolver: typeof import("../narrator-persistence").narratorPersistence.resolveSubagentConclusionReference;
let realResolverChild: ReturnType<typeof makeNarrator> | null = null;
let realResolverOriginal: Record<string, unknown> | null = null;
let loadedTrailingToolResults: unknown[] = [];
let clearManualOverrideRuntimes: typeof import("../subagent-manual-override").clearManualOverrideRuntimes;
let waitForManualOverride: typeof import("../subagent-manual-override").waitForManualOverride;
let hasActiveSubagentResumeRun: typeof import("../subagent-resume").hasActiveSubagentResumeRun;
let resumeSubagent: typeof import("../subagent-resume").resumeSubagent;
let acquireNarratorRevertAdmission: typeof import("../narrator-session").acquireNarratorRevertAdmission;
let startupAdmissionBarrier: { entered: () => void; wait: Promise<void> } | undefined;
let publicationAdmissionBarrier: { entered: () => void; wait: Promise<void> } | undefined;

// Real module namespaces captured before mocking, so afterAll can re-point the
// GLOBAL module mocks back to the real implementations. Bun's mock.module is
// process-wide and mock.restore() does NOT undo it, so without an explicit
// re-point these mocks (esp. lib/settings' resolveProvider) leak into every
// later-loaded suite and break e.g. provider-resolution / resolve-aggregation.
const realModules: Record<string, () => unknown> = {};

/**
 * Per-narrator status, so a test can present a zombie `working` row.
 *
 * Defaults to `idle`; absent from the map means idle. `reconcileRunningStatus` is mocked
 * to clear the entry, which is exactly what the real one does to a row whose runtime
 * owner is gone.
 */
const statusOverrides = new Map<string, string>();
/** Every narrator id `resumeSubagent` asked to reconcile, in order. */
const reconcileCalls: string[] = [];

function makeNarrator(id: string) {
	return {
		id,
		type: "subagent",
		variant: "subagent:general",
		parentNarratorId,
		originToolCallId:
			standaloneSubagentIds.has(id) || unknownOriginIds.has(id) ? null : `parent-tool-row-${id}`,
		subagentOriginKind:
			standaloneSubagentIds.has(id) || mismatchedMarkerIds.has(id) ? "standalone" : null,
		status: statusOverrides.get(id) ?? "idle",
		substatus: ["unread"],
		errorMessage: null,
		model: "test-model",
		cwd: ".",
		contextSummary: null,
	};
}

beforeAll(async () => {
	// Snapshot each module into a plain object NOW (before mocking below). A live
	// import namespace would otherwise reflect the mocked functions by the time
	// afterAll re-points, re-installing the mock instead of restoring the real
	// module. Bun's mock.module is process-wide and mock.restore() does not undo it.
	const realNarratorSession = { ...(await import("../narrator-session")) };
	const realEditAndRegenerate = realNarratorSession.editAndRegenerate;
	acquireNarratorRevertAdmission = realNarratorSession.acquireNarratorRevertAdmission;
	const realNarratorServiceModule = { ...(await import("../narrator-service")) };
	const realNarratorService = realNarratorServiceModule.narratorService;
	const realSettings = { ...(await import("../../lib/settings")) };
	const realDbModule = { ...(await import("../../db")) };
	const realDb = realDbModule.db;
	const query = {
		...realDb.query,
		narratorMessages: {
			...realDb.query.narratorMessages,
			findMany: realDb.query.narratorMessages.findMany.bind(realDb.query.narratorMessages),
			findFirst: mock(async (options?: { columns?: Record<string, boolean> }) =>
				options?.columns?.parentToolUseId
					? originResult
					: realDb.query.narratorMessages.findFirst(options as never),
			),
		},
		narratorToolCalls: {
			...realDb.query.narratorToolCalls,
			findFirst: mock(async (options?: { columns?: Record<string, boolean> }) =>
				realResolverOriginal && options?.columns?.executionOriginToolCallId
					? realResolverOriginal
					: realDb.query.narratorToolCalls.findFirst(options as never),
			),
		},
		narrators: {
			...realDb.query.narrators,
			findFirst: mock(async (options?: { columns?: Record<string, boolean>; where?: SQL }) => {
				// Scheduling fixtures have synthetic rows; model the same three-column
				// admission projection without hiding the real-database provenance cases.
				if (
					options?.where &&
					options.columns?.id &&
					options.columns.variant &&
					options.columns.parentNarratorId
				) {
					const id = new SQLiteSyncDialect().sqlToQuery(options.where).params[0];
					if (
						typeof id === "string" &&
						id !== "n1" &&
						id !== "n2" &&
						!databaseNarratorIds.has(id)
					) {
						return {
							id,
							variant: id === parentNarratorId ? "primary" : "subagent:general",
							parentNarratorId: id === parentNarratorId ? null : parentNarratorId,
						};
					}
				}
				return options?.columns?.pendingModelRestore
					? { pendingModelRestore: null }
					: realResolverChild && options?.columns?.originToolCallId
						? realResolverChild
						: realDb.query.narrators.findFirst(options as never);
			}),
		},
	};
	const dbProxy = new Proxy(realDb, {
		get(target, property, receiver) {
			if (property === "query") return query;
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	// Snapshot the real websocket module before overriding it, so afterAll can
	// restore it (mock.restore() alone leaves the global module mock in place).
	const realNarratorWs = { ...(await import("../../websocket/narrator-ws")) };

	mock.module("../../db", () => ({ ...realDbModule, db: dbProxy }));
	realModules["../../db"] = () => realDbModule;

	mock.module("../../websocket/narrator-ws", () => ({
		broadcastToNarrator: mock(() => {}),
	}));
	realModules["../../websocket/narrator-ws"] = () => realNarratorWs;

	mock.module("../../lib/settings", () => ({
		...realSettings,
		resolveEffectiveModel: (model?: string | null) => model || "test-model",
		resolveProvider: () => "test-provider",
	}));
	realModules["../../lib/settings"] = () => ({ ...realSettings });

	const isEditTestNarrator = (id: string) => id === "n1" || id === "n2";
	mock.module("../narrator-service", () => ({
		...realNarratorServiceModule,
		narratorService: {
			...realNarratorService,
			getById: mock(async (id: string) => {
				// Persistent until it observes a claimed entry: getById runs before the
				// manual-override claim as well, and an abort that early settles the
				// waiting entry (no pendingTerminal) instead of parking a terminal on it.
				if (duringPrepare) duringPrepare();
				if (id === parentNarratorId)
					return {
						...makeNarrator(id),
						variant: "primary",
						type: "primary",
						parentNarratorId: null,
					};
				if (isEditTestNarrator(id) || databaseNarratorIds.has(id)) {
					return realNarratorService.getById(id);
				}
				const narrator = makeNarrator(id);
				if (workingSubagentIds.has(id)) narrator.status = "working";
				return narrator;
			}),
			getModelHistorySinceLastCompact: mock(async (id: string) =>
				isEditTestNarrator(id) || databaseNarratorIds.has(id)
					? realNarratorService.getModelHistorySinceLastCompact(id)
					: [
							{
								id: `edited-user-message-${id}`,
								narratorId: id,
								role: "user",
								contentText: "edited prompt",
								contentJson: [{ type: "text", text: "edited prompt" }],
							},
						],
			),
			deleteMessagesAfter: mock(
				(...args: Parameters<typeof realNarratorService.deleteMessagesAfter>) => {
					// Recorded because the rollback decision is invisible in the result:
					// whether this truncation reverts files is carried entirely by the
					// third argument, and dropping it silently reverts.
					deleteMessagesAfterCalls.push({
						narratorId: args[0],
						messageId: args[1],
						opts: args[2],
					});
					return isEditTestNarrator(args[0]) || databaseNarratorIds.has(args[0])
						? realNarratorService.deleteMessagesAfter(...args)
						: Promise.resolve({ deletedMessageIds: [] });
				},
			),
			persistSubagentUserMessage: mock(
				async (
					narratorId: string,
					text: string,
					parentToolUseId: string,
					options?: Record<string, unknown>,
				) => {
					persistedCalls.push({ narratorId, text, parentToolUseId, options });
					return {
						id: `user-message-${persistedCalls.length}`,
						narratorId,
						role: "user",
						contentText: text,
						parentToolUseId,
					};
				},
			),
			updateStatus: mock((...args: Parameters<typeof realNarratorService.updateStatus>) =>
				isEditTestNarrator(args[0]) ? realNarratorService.updateStatus(...args) : Promise.resolve(),
			),
			isMessageSharedByMultipleNarrators: mock((messageId: string) =>
				messageId === "m1"
					? realNarratorService.isMessageSharedByMultipleNarrators(messageId)
					: Promise.resolve(false),
			),
			copyOnWriteToolCallMessage: mock(
				(...args: Parameters<typeof realNarratorService.copyOnWriteToolCallMessage>) =>
					isEditTestNarrator(args[0])
						? realNarratorService.copyOnWriteToolCallMessage(...args)
						: Promise.resolve("private-message"),
			),
		},
	}));
	realModules["../narrator-service"] = () => realNarratorServiceModule;

	const realPersistenceModule = { ...(await import("../narrator-persistence")) };
	realConclusionResolver =
		realPersistenceModule.narratorPersistence.resolveSubagentConclusionReference.bind(
			realPersistenceModule.narratorPersistence,
		);
	// Scheduling fixtures retain a known slot; provenance regressions below explicitly
	// pass through the real resolver. A missing origin can no longer silently succeed.
	spyOn(
		realPersistenceModule.narratorPersistence,
		"resolveSubagentConclusionReference",
	).mockImplementation(async (subagentId, parentId, toolUseId) => {
		if (realResolverChild || standaloneSubagentIds.has(subagentId)) {
			return realConclusionResolver(subagentId, parentId, toolUseId);
		}
		if (parentId !== parentNarratorId) throw new Error("Wrong fixture parent");
		return {
			toolCallId: `parent-tool-row-${subagentId}`,
			messageId: "parent-message",
			originToolCallId: `parent-tool-row-${subagentId}`,
		};
	});

	const realSubagentExecutor = { ...(await import("../subagent-executor")) };
	const realSubagentRunner = { ...(await import("../subagent-runner")) };

	mock.module("../subagent-executor", () => ({
		pushSubagentBufferedMessage: mock(() => ({
			ok: true,
			bufferedAt: new Date().toISOString(),
			id: "buffered-message",
		})),
		loadSubagentHistory: mock(async () => ({
			history: [{ role: "user", content: "history" }],
			trailingToolResults: loadedTrailingToolResults,
		})),
		// Stands in for the mailbox head: a mailbox wake consumes this row instead of
		// persisting its own prompt. Each call drains one queued fixture entry.
		consumeNextBufferedSubagentMessage: mock(async (opts: { narratorId: string }) => {
			mailboxConsumeCalls.push(opts.narratorId);
			const next = queuedMailboxInputs.shift();
			return next
				? {
						prompt: next,
						currentInput: next,
						history: [{ role: "user", content: "history" }],
						trailingToolResults: [],
						userId: "mailbox-user",
					}
				: null;
		}),
	}));
	realModules["../subagent-executor"] = () => realSubagentExecutor;

	mock.module("../subagent-runner", () => ({
		combineSubagentAbortSignals: (...signals: Array<AbortSignal | undefined>) => {
			const distinct = [...new Set(signals.filter((signal): signal is AbortSignal => !!signal))];
			if (distinct.length === 0) return new AbortController().signal;
			if (distinct.length === 1) return distinct[0];
			return AbortSignal.any(distinct);
		},
		resolveBackgroundCompletionOutcome: (input: {
			timedOut: boolean;
			hasError: boolean;
			contextLengthExceeded?: boolean;
			aborted?: boolean;
		}) =>
			input.timedOut
				? "timeout"
				: input.hasError || input.contextLengthExceeded || input.aborted
					? "failed"
					: "completed",
		waitForBackgroundTask: mock(async () => ({ status: "running", result: null })),
		announceResumedBackgroundTask: mock(async (announcement: unknown) => {
			announcements.push(announcement);
		}),
		startContinuedSubagent: mock(async (input: Record<string, unknown>) => {
			startCalls.push(input);
			if (startupAdmissionBarrier) {
				startupAdmissionBarrier.entered();
				await startupAdmissionBarrier.wait;
			}
			const subagentId = String(input.subagentId);
			// The fake model runner still performs real durable run admission. Publication
			// must not be mocked away merely because model execution is controlled here.
			const { narrators } = await import("../../db/schema");
			const { runtimePublication } = await import("../agent-runtime/publication");
			const recipientId = String(input.parentNarratorId);
			const now = new Date().toISOString();
			realDb
				.insert(narrators)
				.values({
					id: recipientId,
					type: "primary",
					variant: "primary",
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoNothing()
				.run();
			realDb
				.insert(narrators)
				.values({
					id: subagentId,
					type: "subagent",
					variant: "subagent:general",
					parentNarratorId: recipientId,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoNothing()
				.run();
			const publicationRun = runtimePublication.startAgentRun({
				narratorId: subagentId,
				parentNarratorId: recipientId,
			});
			const completion = new Promise<string>((resolve) => {
				foregroundResolvers.set(subagentId, resolve);
			});
			const terminalCompletion = new Promise<string>((resolve) => {
				terminalResolvers.set(subagentId, resolve);
			});
			return {
				runId: `run-${startCalls.length}`,
				completion,
				terminalCompletion,
				// Part of the contract: the resume path claims any owed resumed-background
				// notice after delivering the conclusion. A mock without it made every
				// terminal completion throw.
				takeResumedBackgroundAnnouncement: () =>
					!input.skipConclusionDelivery &&
					(standaloneSubagentIds.has(subagentId) || databaseNarratorIds.has(subagentId))
						? {
								subagentId,
								parentNarratorId: recipientId,
								logicalRunId: publicationRun.logicalRunId,
								status: "completed",
								wakeParent: true,
								locale: input.locale,
							}
						: undefined,
				userMessage: {
					id: `user-message-${startCalls.length}`,
					narratorId: subagentId,
					role: "user",
					contentText: input.prompt,
					parentToolUseId: originToolUseId,
				},
			};
		}),
	}));
	realModules["../subagent-runner"] = () => realSubagentRunner;

	mock.module("../narrator-session", () => ({
		...realNarratorSession,
		getSubagentFinalText: mock(async () => "mock final text"),
		startParentInboundContinuationIfPossible: mock(async () => ({ started: false })),
		// Stands in for the real reconcile: repairs a `working` row with no runtime owner
		// by dropping it to idle, and reports whether it changed anything. Recorded so a
		// test can assert resume consults it BEFORE judging the status — the ordering is
		// the whole point, and a mock that only counted calls would not show it.
		reconcileRunningStatus: mock(async (narratorId: string) => {
			reconcileCalls.push(narratorId);
			if (!statusOverrides.has(narratorId)) return false;
			statusOverrides.delete(narratorId);
			return true;
		}),
		editAndRegenerate: mock(
			async (
				narratorId: string,
				messageId: string,
				content: string,
				locale: string,
				replyInUserLanguage: boolean,
				options: Record<string, unknown>,
			) => {
				if (narratorId === "n1" || narratorId === "n2") {
					return realEditAndRegenerate(
						narratorId,
						messageId,
						content,
						locale as "en",
						replyInUserLanguage,
						options,
					);
				}
				editedMessageCalls.push({
					narratorId,
					messageId,
					content,
					locale,
					replyInUserLanguage,
					options,
				});
				return { ok: true };
			},
		),
		getSubagentResultMessageId: mock(async () => "result-message"),
		reExecuteDeniedToolCall: mock(
			async (
				narratorId: string,
				toolUseId: string,
				locale: string,
				replyInUserLanguage: boolean,
				userId: string | null | undefined,
				options: Record<string, unknown>,
			) => {
				await (options.onAdmitted as (() => Promise<void>) | undefined)?.();
				await beforeDeniedRetryIo?.();
				retriedToolCalls.push({
					narratorId,
					toolUseId,
					locale,
					replyInUserLanguage,
					userId,
					options,
				});
				return { ok: true, shouldContinue: deniedRetryShouldContinue };
			},
		),
		updateToolCallConclusion: mock(async (input: Record<string, unknown>) => {
			conclusionCalls.push(input);
			if (publicationAdmissionBarrier) {
				publicationAdmissionBarrier.entered();
				await publicationAdmissionBarrier.wait;
			}
		}),
	}));
	realModules["../narrator-session"] = () => realNarratorSession;

	({ clearManualOverrideRuntimes, waitForManualOverride } = await import(
		"../subagent-manual-override"
	));
	({ hasActiveSubagentResumeRun, resumeSubagent } = await import("../subagent-resume"));
});

async function publishForeground(subagentId: string, output: string) {
	foregroundResolvers.get(subagentId)?.(output);
	await Bun.sleep(0);
}

async function finishRun(subagentId: string, output = "done") {
	const formatted = `<subagent_id>${subagentId}</subagent_id>\n\n${output}`;
	foregroundResolvers.get(subagentId)?.(formatted);
	terminalResolvers.get(subagentId)?.(formatted);
	for (let i = 0; i < 20 && hasActiveSubagentResumeRun(subagentId); i++) {
		await Bun.sleep(5);
	}
}

describe("resume lifecycle shares the root's file-revert admission", () => {
	test("starting is occupied before the runner returns a terminal handle", async () => {
		const entered = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		startupAdmissionBarrier = { entered: entered.resolve, wait: proceed.promise };
		const pending = resumeSubagent({
			subagentId: "admission-starting",
			intent: "follow_up",
			actor: "user",
			prompt: "start",
			locale: "en",
		});
		await entered.promise;
		try {
			const { isNarratorRuntimeBusy } = await import("../narrator-session-state");
			expect(isNarratorRuntimeBusy(parentNarratorId)).toBe(false);
			await expect(
				acquireNarratorRevertAdmission(parentNarratorId, {
					signal: new AbortController().signal,
					interrupt: false,
				}),
			).rejects.toMatchObject({ statusCode: 409, code: "NARRATOR_REVERT_BUSY" });
		} finally {
			proceed.resolve();
			const started = await pending;
			await finishRun("admission-starting");
			await started.terminalCompletion;
			startupAdmissionBarrier = undefined;
		}
	});

	test("terminal execution is not quiescent while its conclusion is still publishing", async () => {
		const entered = Promise.withResolvers<void>();
		const publish = Promise.withResolvers<void>();
		publicationAdmissionBarrier = { entered: entered.resolve, wait: publish.promise };
		const started = await resumeSubagent({
			subagentId: "admission-delivering",
			intent: "follow_up",
			actor: "user",
			prompt: "start",
			locale: "en",
		});
		terminalResolvers.get("admission-delivering")?.("final output");
		await entered.promise;
		let exclusive: Promise<() => void> | undefined;
		let granted = false;
		try {
			await expect(
				acquireNarratorRevertAdmission(parentNarratorId, {
					signal: new AbortController().signal,
					interrupt: false,
				}),
			).rejects.toMatchObject({ code: "NARRATOR_REVERT_BUSY" });
			exclusive = acquireNarratorRevertAdmission(parentNarratorId, {
				signal: new AbortController().signal,
				interrupt: true,
			}).then((release) => {
				granted = true;
				return release;
			});
			await Promise.resolve();
			expect(granted).toBe(false);
			expect(hasActiveSubagentResumeRun("admission-delivering")).toBe(true);
		} finally {
			publish.resolve();
			await started.terminalCompletion;
			const release = await exclusive;
			release?.();
			publicationAdmissionBarrier = undefined;
		}
		expect(granted).toBe(true);
		expect(hasActiveSubagentResumeRun("admission-delivering")).toBe(false);
	});

	test("all resume intents refuse an exclusive revert before retry/edit/persistence", async () => {
		const release = await acquireNarratorRevertAdmission(parentNarratorId, {
			signal: new AbortController().signal,
			interrupt: false,
		});
		try {
			for (const intent of [
				"follow_up",
				"retry_last_input",
				"continue_tool_results",
				"retry_denied_tool",
				"regenerate_edited_message",
			] as const) {
				await expect(
					resumeSubagent({
						subagentId: "admission-blocked",
						intent,
						actor: "user",
						prompt: "start",
						retryToolUseId: "tool",
						editMessageId: "message",
						editContent: "changed",
						locale: "en",
					}),
				).rejects.toMatchObject({ statusCode: 409, code: "NARRATOR_REVERT_IN_PROGRESS" });
			}
			expect(startCalls).toHaveLength(0);
			expect(persistedCalls).toHaveLength(0);
			expect(retriedToolCalls).toHaveLength(0);
			expect(editedMessageCalls).toHaveLength(0);
			expect(deleteMessagesAfterCalls).toHaveLength(0);
		} finally {
			release();
		}
	});
});

afterEach(async () => {
	beforeDeniedRetryIo = undefined;
	deniedRetryShouldContinue = true;
	for (const subagentId of [...terminalResolvers.keys()]) {
		await finishRun(subagentId);
	}
	startupAdmissionBarrier = undefined;
	publicationAdmissionBarrier = undefined;
	startCalls.length = 0;
	persistedCalls.length = 0;
	conclusionCalls.length = 0;
	retriedToolCalls.length = 0;
	editedMessageCalls.length = 0;
	deleteMessagesAfterCalls.length = 0;
	loadedTrailingToolResults = [];
	reconcileCalls.length = 0;
	statusOverrides.clear();
	originResult = { parentToolUseId: originToolUseId };
	workingSubagentIds.clear();
	standaloneSubagentIds.clear();
	unknownOriginIds.clear();
	mismatchedMarkerIds.clear();
	databaseNarratorIds.clear();
	announcements.length = 0;
	queuedMailboxInputs.length = 0;
	mailboxConsumeCalls.length = 0;
	duringPrepare = undefined;
	realResolverChild = null;
	realResolverOriginal = null;
	clearManualOverrideRuntimes();
	foregroundResolvers.clear();
	terminalResolvers.clear();
	const { sqlite } = await import("../../db");
	cleanDb(sqlite);
});

afterAll(() => {
	// Re-point every globally-mocked module back to its real implementation.
	// Bun's mock.module is process-wide and mock.restore() does not undo it, so
	// without this the divergent lib/settings / narrator-service / etc. mocks
	// leak into later-loaded suites (e.g. provider-resolution, resolve-aggregation).
	for (const [specifier, factory] of Object.entries(realModules)) {
		mock.module(specifier, factory);
	}
	mock.restore();
});

/**
 * A subagent row left at `working` with nobody behind it must not become a dead end.
 *
 * Nothing else repairs one. The parent's interrupt path only settles subagents whose
 * owning Agent tool call was cancelled (deliberately, so it cannot kill a subagent the
 * user is driving from its own panel), and startup recovery only runs at startup. A row
 * orphaned mid-run — its owning turn died, a detach setup threw — used to refuse every
 * resume with "Subagent is already running", and the card offers no other action.
 *
 * So resume reconciles first and then judges, exactly like every primary-narrator entry
 * point. The ordering is the assertion: reconciling AFTER the status check would repair
 * the row and still refuse the request that triggered the repair.
 */
describe("resumeSubagent status reconciliation", () => {
	test("repairs a zombie working row and admits the resume", async () => {
		const subagentId = "resume-zombie-row";
		statusOverrides.set(subagentId, "working");

		const result = await resumeSubagent({
			subagentId,
			intent: "follow_up",
			actor: "user",
			prompt: "continue",
			createdBy: "user-1",
			locale: "en",
		});

		expect(result.started).toBe(true);
		expect(reconcileCalls).toEqual([subagentId]);
		// The repaired status was re-read rather than assumed: had resume kept its stale
		// copy of the row, this would have thrown "already running" above.
		expect(startCalls).toHaveLength(1);
		await finishRun(subagentId);
	});

	test("still refuses a subagent whose runtime owner is alive", async () => {
		const subagentId = "resume-live-owner";
		// `reconcileRunningStatus` returns false for a row with a live owner, so the status
		// stays `working` and the guard below must still fire.
		statusOverrides.set(subagentId, "working");
		const { reconcileRunningStatus } = await import("../narrator-session");
		(
			reconcileRunningStatus as unknown as { mockImplementationOnce: (fn: unknown) => void }
		).mockImplementationOnce(async (narratorId: string) => {
			reconcileCalls.push(narratorId);
			return false;
		});

		await expect(
			resumeSubagent({
				subagentId,
				intent: "follow_up",
				actor: "user",
				prompt: "continue",
				createdBy: "user-1",
				locale: "en",
			}),
		).rejects.toThrow("already running");
		expect(reconcileCalls).toEqual([subagentId]);
		expect(startCalls).toHaveLength(0);
	});
});

describe("resumeSubagent", () => {
	test("real plugin creation persists provenance across database reads and repeated resumes", async () => {
		const { db } = await import("../../db");
		const { narrators, narratorMessages, narratorMessageRefs } = await import("../../db/schema");
		const { eq } = await import("drizzle-orm");
		const { createNarratorForPlugin } = await import("../narrator-session");
		const { narratorService } = await import("../narrator-service");
		const parentId = "plugin-durable-parent";
		const now = new Date().toISOString();
		const childIds: string[] = [];
		databaseNarratorIds.add(parentId);
		await db.insert(narrators).values({ id: parentId, cwd: ".", createdAt: now, updatedAt: now });
		try {
			const worker = await createNarratorForPlugin({
				type: "subagent",
				parentNarratorId: parentId,
			});
			childIds.push(worker.narratorId);
			databaseNarratorIds.add(worker.narratorId);
			const stored = await db.query.narrators.findFirst({
				where: eq(narrators.id, worker.narratorId),
			});
			expect(stored).toMatchObject({ subagentOriginKind: "standalone", originToolCallId: null });
			// No registry or creation-returned object is supplied to resume: every getById
			// reloads the durable row, including the second follow-up.
			originResult = null;
			for (let turn = 0; turn < 2; turn++) {
				const result = await resumeSubagent({
					subagentId: worker.narratorId,
					intent: "follow_up",
					actor: "parent_agent",
					prompt: "inspect",
					locale: "en",
				});
				expect(result.originToolUseId).toBe(`standalone-${worker.narratorId}`);
				expect(startCalls[turn].skipConclusionDelivery).toBeUndefined();
				await db
					.update(narrators)
					.set({ status: "idle" })
					.where(eq(narrators.id, worker.narratorId));
				await finishRun(worker.narratorId);
				await expect(result.terminalCompletion).resolves.toContain("done");
				expect(hasActiveSubagentResumeRun(worker.narratorId)).toBe(false);
				originResult = { parentToolUseId: result.originToolUseId };
			}
			expect(conclusionCalls).toHaveLength(0);
			expect(announcements).toHaveLength(2);
			const unknown = await narratorService.createSubagent({
				parentNarratorId: parentId,
				subagentType: "general",
				cwd: ".",
			});
			childIds.push(unknown.id);
			expect(unknown.subagentOriginKind).toBeNull();
			await expect(
				narratorService.createSubagent({
					parentNarratorId: parentId,
					subagentType: "general",
					cwd: ".",
					subagentOriginKind: "standalone",
					originToolCallId: "forbidden",
				}),
			).rejects.toThrow("cannot have an Agent tool-call origin");
		} finally {
			for (const id of childIds) {
				await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, id));
				await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, id));
				await db.delete(narrators).where(eq(narrators.id, id));
			}
			await db.delete(narrators).where(eq(narrators.id, parentId));
		}
	});
	test("starts a never-started plugin temp worker despite its stale working status", async () => {
		// A team temp worker recruited directly through the plugin API has no
		// originating Agent tool call (resolveSubagentOriginToolUseId fails) and
		// reports a stale "working" status. Resume must treat it as startable —
		// synthesizing a standalone origin — instead of rejecting it with
		// "already running" or stranding the message in the buffer.
		originResult = null;
		standaloneSubagentIds.add("temp-worker-1");
		realResolverChild = makeNarrator("temp-worker-1");
		await expect(
			realConclusionResolver("temp-worker-1", parentNarratorId, "standalone-untrusted"),
		).rejects.toThrow("no trusted parent tool-call origin");
		workingSubagentIds.add("temp-worker-1");
		const result = await resumeSubagent({
			subagentId: "temp-worker-1",
			intent: "follow_up",
			actor: "parent_agent",
			prompt: "inspect the panel",
			createdBy: null,
			locale: "en",
		});

		expect(result.started).toBe(true);
		expect(startCalls).toHaveLength(1);
		expect(startCalls[0]).toMatchObject({
			subagentId: "temp-worker-1",
			prompt: "inspect the panel",
			// The stale "working" status must be overridden via allowRunningRestart
			// so the runner's status guard accepts the never-started subagent.
			allowRunningRestart: true,
		});
		// The synthesized standalone origin is what gets persisted as the
		// parent tool-use link — no real Agent tool call exists.
		expect(String(startCalls[0].toolUseId ?? "")).toMatch(/^standalone-/);

		await finishRun("temp-worker-1");
		await expect(result.terminalCompletion).resolves.toContain("done");
		expect(hasActiveSubagentResumeRun("temp-worker-1")).toBe(false);
		expect(conclusionCalls).toHaveLength(0);
		expect(announcements).toHaveLength(1);
		expect(startCalls[0].skipConclusionDelivery).toBeUndefined();

		// The first run persists its transport link. It does not become a real Agent
		// origin on follow-up, nor does the worker bypass live-run status validation.
		originResult = { parentToolUseId: result.originToolUseId };
		workingSubagentIds.clear();
		const followUp = await resumeSubagent({
			subagentId: "temp-worker-1",
			intent: "follow_up",
			actor: "user",
			prompt: "inspect again",
			locale: "en",
		});
		expect(followUp.originToolUseId).toBe(result.originToolUseId);
		expect(startCalls[1].allowRunningRestart).toBe(false);
		await finishRun("temp-worker-1");
		await expect(followUp.terminalCompletion).resolves.toContain("done");
		expect(conclusionCalls).toHaveLength(0);
		expect(announcements).toHaveLength(2);
	});

	test("does not authorize a missing origin or a standalone-prefixed transport", async () => {
		originResult = null;
		await expect(
			resumeSubagent({
				subagentId: "broken-ordinary-missing-link",
				intent: "follow_up",
				actor: "user",
				prompt: "continue",
				locale: "en",
			}),
		).rejects.toThrow("original Agent tool call");
		expect(startCalls).toHaveLength(0);

		const subagentId = "broken-ordinary-prefixed-link";
		unknownOriginIds.add(subagentId);
		realResolverChild = makeNarrator(subagentId);
		originResult = { parentToolUseId: "standalone-forged" };
		const result = await resumeSubagent({
			subagentId,
			intent: "follow_up",
			actor: "user",
			prompt: "continue",
			locale: "en",
		});
		terminalResolvers.get(subagentId)?.("done");
		await expect(result.terminalCompletion).rejects.toThrow("no trusted parent tool-call origin");
		await Bun.sleep(0);
		expect(conclusionCalls).toHaveLength(0);
		expect(announcements).toHaveLength(0);
		expect(hasActiveSubagentResumeRun(subagentId)).toBe(false);
	});

	test("ordinary child resolves its real database slot before conclusion delivery", async () => {
		const { db } = await import("../../db");
		const { narrators, narratorMessages, narratorMessageRefs, narratorToolCalls } = await import(
			"../../db/schema"
		);
		const { eq } = await import("drizzle-orm");
		const subagentId = "ordinary-real-slot";
		const toolCallId = `parent-tool-row-${subagentId}`;
		const messageId = "ordinary-real-slot-message";
		const now = new Date().toISOString();
		// tests/preload.ts isolates this database from all real user data.
		await db.insert(narrators).values({ id: parentNarratorId, createdAt: now, updatedAt: now });
		try {
			await db.insert(narratorMessages).values({
				id: messageId,
				narratorId: parentNarratorId,
				role: "assistant",
				contentJson: [{ type: "tool_use", id: originToolUseId, name: "Agent", input: {} }],
				createdAt: now,
			});
			await db.insert(narratorMessageRefs).values({
				id: `${messageId}-ref`,
				narratorId: parentNarratorId,
				messageId,
				seq: 1,
			});
			await db.insert(narratorToolCalls).values({
				id: toolCallId,
				narratorId: parentNarratorId,
				messageId,
				toolUseId: originToolUseId,
				toolName: "Agent",
				inputJson: {},
				executionAttempt: 1,
				executionIdentityVersion: 1,
				status: "success",
				createdAt: now,
			});
			realResolverChild = makeNarrator(subagentId);
			const result = await resumeSubagent({
				subagentId,
				intent: "follow_up",
				actor: "user",
				prompt: "continue",
				locale: "en",
			});
			await finishRun(subagentId);
			await expect(result.terminalCompletion).resolves.toContain("done");
			expect(conclusionCalls).toHaveLength(1);
			expect(conclusionCalls[0]).toMatchObject({
				subagentId,
				parentNarratorId,
				toolCallId,
				messageId,
				toolUseId: originToolUseId,
			});
		} finally {
			await db.delete(narratorToolCalls).where(eq(narratorToolCalls.id, toolCallId));
			await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.messageId, messageId));
			await db.delete(narratorMessages).where(eq(narratorMessages.id, messageId));
			await db.delete(narrators).where(eq(narrators.id, subagentId));
			await db.delete(narrators).where(eq(narrators.id, parentNarratorId));
		}
	});

	test("ordinary origin mismatch still rejects through the real resolver", async () => {
		const subagentId = "ordinary-origin-mismatch";
		realResolverChild = makeNarrator(subagentId);
		realResolverOriginal = {
			narratorId: "foreign-parent",
			toolUseId: originToolUseId,
			toolName: "Agent",
			executionIdentityVersion: 1,
			executionOriginToolCallId: null,
		};
		const result = await resumeSubagent({
			subagentId,
			intent: "follow_up",
			actor: "user",
			prompt: "continue",
			locale: "en",
		});
		terminalResolvers.get(subagentId)?.("done");
		await expect(result.terminalCompletion).rejects.toThrow("not the parent's original Agent row");
		await Bun.sleep(0);
		expect(conclusionCalls).toHaveLength(0);
		expect(hasActiveSubagentResumeRun(subagentId)).toBe(false);
	});

	test("standalone explicit skipConclusionDelivery preserves runner announcement suppression", async () => {
		const subagentId = "standalone-explicit-skip";
		standaloneSubagentIds.add(subagentId);
		originResult = null;
		const result = await resumeSubagent({
			subagentId,
			intent: "follow_up",
			actor: "user",
			prompt: "continue",
			locale: "en",
			skipConclusionDelivery: true,
		});
		await finishRun(subagentId);
		await expect(result.terminalCompletion).resolves.toContain("done");
		expect(conclusionCalls).toHaveLength(0);
		expect(announcements).toHaveLength(0);
		expect(startCalls[0].skipConclusionDelivery).toBe(true);
		expect(hasActiveSubagentResumeRun(subagentId)).toBe(false);
	});

	test("standalone marker cannot bypass the resolver when an origin PK exists", async () => {
		const subagentId = "ordinary-with-invalid-marker";
		mismatchedMarkerIds.add(subagentId);
		realResolverChild = makeNarrator(subagentId);
		realResolverOriginal = {
			narratorId: "foreign-parent",
			toolUseId: originToolUseId,
			toolName: "Agent",
			executionIdentityVersion: 1,
			executionOriginToolCallId: null,
		};
		const result = await resumeSubagent({
			subagentId,
			intent: "follow_up",
			actor: "user",
			prompt: "continue",
			locale: "en",
		});
		terminalResolvers.get(subagentId)?.("done");
		await expect(result.terminalCompletion).rejects.toThrow("not the parent's original Agent row");
		await Bun.sleep(0);
		expect(conclusionCalls).toHaveLength(0);
		expect(hasActiveSubagentResumeRun(subagentId)).toBe(false);
	});

	test("serializes one active resumed run and delivers its conclusion once", async () => {
		const subagentId = "resume-concurrency";
		const first = await resumeSubagent({
			subagentId,
			intent: "follow_up",
			actor: "user",
			prompt: "continue",
			createdBy: "user-1",
			locale: "en",
		});

		expect(first.started).toBe(true);
		expect(typeof first.token).toBe("string");
		expect(hasActiveSubagentResumeRun(subagentId)).toBe(true);
		await expect(
			resumeSubagent({
				subagentId,
				intent: "follow_up",
				actor: "user",
				prompt: "duplicate",
				createdBy: "user-1",
				locale: "en",
			}),
		).rejects.toThrow("active resumed run");
		expect(startCalls).toHaveLength(1);

		await finishRun(subagentId, "final answer");
		expect(hasActiveSubagentResumeRun(subagentId)).toBe(false);
		expect(conclusionCalls).toHaveLength(1);
		expect(conclusionCalls[0]).toMatchObject({
			subagentId,
			parentNarratorId,
			toolUseId: originToolUseId,
			toolCallId: `parent-tool-row-${subagentId}`,
			messageId: "parent-message",
			finalText: "final answer",
			resultMessageId: "result-message",
		});
	});

	test("serializes truly concurrent resume attempts", async () => {
		const subagentId = "resume-simultaneous";
		const attempts = await Promise.allSettled([
			resumeSubagent({
				subagentId,
				intent: "follow_up",
				actor: "user",
				prompt: "first concurrent attempt",
				locale: "en",
			}),
			resumeSubagent({
				subagentId,
				intent: "follow_up",
				actor: "user",
				prompt: "second concurrent attempt",
				locale: "en",
			}),
		]);

		expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
		expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
		expect(startCalls).toHaveLength(1);
		await finishRun(subagentId);
	});

	test("does not publish a resumed conclusion when foreground only returns a detach handoff", async () => {
		const subagentId = "resume-detach-handoff";
		await resumeSubagent({
			subagentId,
			intent: "follow_up",
			actor: "user",
			prompt: "continue then detach",
			createdBy: "user-1",
			locale: "en",
		});

		await publishForeground(
			subagentId,
			`<background_task_id>${subagentId}</background_task_id>\n\nDetached`,
		);
		expect(conclusionCalls).toHaveLength(0);
		expect(hasActiveSubagentResumeRun(subagentId)).toBe(true);

		await finishRun(subagentId, "real terminal answer");
		expect(conclusionCalls).toHaveLength(1);
		expect(conclusionCalls[0]).toMatchObject({ finalText: "real terminal answer" });
	});

	test("exposes terminal completion and forwards planned-update restart options", async () => {
		const subagentId = "resume-planned-update";
		const result = await resumeSubagent({
			subagentId,
			intent: "continue_tool_results",
			actor: "parent_agent",
			locale: "en",
			allowRunningRestart: true,
			skipStaleAttach: true,
			preserveBackground: true,
			skipConclusionDelivery: true,
			resumableUpdateLease: true,
		});

		expect(result.terminalCompletion).toBeInstanceOf(Promise);
		expect(startCalls[0]).toMatchObject({
			subagentId,
			allowRunningRestart: true,
			skipStaleAttach: true,
			preserveBackground: true,
			resumableUpdateLease: true,
		});
		const abortController = startCalls[0]?.abortController;
		expect(abortController).toBeInstanceOf(AbortController);
		expect(startCalls[0]?.signal).toBe((abortController as AbortController).signal);
		await finishRun(subagentId, "recovered result");
		await expect(result.terminalCompletion).resolves.toContain("recovered result");
		expect(conclusionCalls).toHaveLength(0);
	});

	test("combines claim-loss and persistent user-cancel signals for background recovery", async () => {
		const claimLossSubagentId = "resume-claim-loss-abort";
		const claimLossController = new AbortController();
		const persistentController = new AbortController();
		await resumeSubagent({
			subagentId: claimLossSubagentId,
			intent: "continue_tool_results",
			actor: "parent_agent",
			locale: "en",
			signal: claimLossController.signal,
			abortController: persistentController,
			preserveBackground: true,
			skipConclusionDelivery: true,
		});

		const claimLossSignal = startCalls[0]?.signal as AbortSignal;
		expect(startCalls[0]?.abortController).toBe(persistentController);
		expect(claimLossSignal.aborted).toBe(false);
		claimLossController.abort(new Error("claim lost"));
		expect(claimLossSignal.aborted).toBe(true);
		expect(persistentController.signal.aborted).toBe(false);

		const userCancelSubagentId = "resume-user-cancel-abort";
		const userCancelUpstream = new AbortController();
		const userCancelController = new AbortController();
		await resumeSubagent({
			subagentId: userCancelSubagentId,
			intent: "continue_tool_results",
			actor: "parent_agent",
			locale: "en",
			signal: userCancelUpstream.signal,
			abortController: userCancelController,
			preserveBackground: true,
			skipConclusionDelivery: true,
		});

		const userCancelSignal = startCalls[1]?.signal as AbortSignal;
		expect(userCancelSignal.aborted).toBe(false);
		userCancelController.abort("cancelled by user");
		expect(userCancelSignal.aborted).toBe(true);
		expect(userCancelUpstream.signal.aborted).toBe(false);

		await finishRun(claimLossSubagentId);
		await finishRun(userCancelSubagentId);
	});

	test("forwards an explicit controller and update lease to the continued runner", async () => {
		const subagentId = "resume-explicit-lifecycle";
		const abortController = new AbortController();
		const updateExecutionLease = {
			kind: "resumable" as const,
			token: "existing-lease",
			setNarratorId: mock(() => {}),
			release: mock(() => {}),
		};

		await resumeSubagent({
			subagentId,
			intent: "follow_up",
			actor: "parent_agent",
			prompt: "continue with existing admission",
			locale: "en",
			abortController,
			updateExecutionLease,
		});

		expect(startCalls[0]?.abortController).toBe(abortController);
		expect(startCalls[0]?.signal).toBe(abortController.signal);
		expect(startCalls[0]?.updateExecutionLease).toBe(updateExecutionLease);
		await finishRun(subagentId);
	});

	test("forwards attachments, command text, user identity, and parent reply capability", async () => {
		const subagentId = "resume-context";
		const image = {
			imageId: "image-1",
			filename: "diagram.png",
			mediaType: "image/png",
		};
		const textFile = new File(["notes"], "notes.txt", { type: "text/plain" });

		await resumeSubagent({
			subagentId,
			intent: "follow_up",
			actor: "parent_agent",
			prompt: "inspect attachments",
			images: [image],
			textFiles: [textFile],
			commandText: "/inspect attachments",
			createdBy: "user-2",
			locale: "en",
		});

		expect(startCalls).toHaveLength(1);
		expect(startCalls[0]).toMatchObject({
			subagentId,
			prompt: "inspect attachments",
			images: [image],
			textFiles: [textFile],
			commandText: "/inspect attachments",
			createdBy: "user-2",
			userId: "user-2",
			canReportToParent: true,
		});
		await finishRun(subagentId);
	});

	test("routes denied-tool result continuation through the same resume service", async () => {
		const subagentId = "resume-denied-tool";
		const { db } = await import("../../db");
		const { narrators } = await import("../../db/schema");
		const now = new Date().toISOString();
		await db
			.insert(narrators)
			.values([
				{ id: parentNarratorId, createdAt: now, updatedAt: now },
				{
					id: subagentId,
					parentNarratorId,
					variant: "subagent:general",
					type: "subagent",
					logicalRunId: "previous-run",
					createdAt: now,
					updatedAt: now,
				},
			])
			.onConflictDoNothing();
		let runAtIo: string | undefined;
		beforeDeniedRetryIo = async () => {
			const { resolveSubagentExecutionSegment } = await import("../subagent-execution-boundary");
			const run = await db
				.select({ logicalRunId: narrators.logicalRunId })
				.from(narrators)
				.where(eq(narrators.id, subagentId))
				.get();
			const segment = await resolveSubagentExecutionSegment(subagentId, run?.logicalRunId);
			expect(segment?.sourceInputId).toStartWith("subagent-run:");
			runAtIo = segment?.sourceInputId?.slice("subagent-run:".length);
			expect(runAtIo).not.toBe("previous-run");
		};
		loadedTrailingToolResults = [{ type: "tool_result", toolUseId: "denied-tool-use" }];

		const result = await resumeSubagent({
			subagentId,
			intent: "retry_denied_tool",
			actor: "user",
			retryToolUseId: "denied-tool-use",
			createdBy: "user-4",
			locale: "zh-CN",
			replyInUserLanguage: true,
		});

		expect(result.started).toBe(true);
		expect(retriedToolCalls).toEqual([
			{
				narratorId: subagentId,
				toolUseId: "denied-tool-use",
				locale: "zh-CN",
				replyInUserLanguage: true,
				userId: "user-4",
				options: { autoContinue: false, onAdmitted: expect.any(Function) },
			},
		]);
		expect(startCalls[0]).toMatchObject({
			subagentId,
			persistPrompt: false,
			initialHistory: [{ role: "user", content: "history" }],
			initialTrailingToolResults: [{ type: "tool_result", toolUseId: "denied-tool-use" }],
			resumeLogicalRunId: runAtIo,
			fileChangeStartedAt: expect.any(String),
		});
		await finishRun(subagentId);
	});

	for (const failure of ["stopped", "thrown"] as const) {
		test(`publishes background denied-tool retry states after persistence (${failure})`, async () => {
			const subagentId = `resume-background-denied-${failure}`;
			const { db } = await import("../../db");
			const { narrators, backgroundTasks } = await import("../../db/schema");
			const { backgroundTaskService } = await import("../background-task-service");
			const now = new Date().toISOString();
			databaseNarratorIds.add(subagentId);
			await db.insert(narrators).values([
				{ id: parentNarratorId, createdAt: now, updatedAt: now },
				{
					id: subagentId,
					parentNarratorId,
					variant: "subagent:general",
					type: "subagent",
					isBackground: true,
					backgroundStatus: "failed",
					backgroundResult: "old failure",
					backgroundCompletedAt: now,
					logicalRunId: "previous-run",
					createdAt: now,
					updatedAt: now,
				},
			]);
			await db.insert(backgroundTasks).values({
				id: subagentId,
				parentNarratorId,
				subagentNarratorId: subagentId,
				type: "agent",
				status: "failed",
				output: "old failure",
				completedAt: now,
				logicalRunId: "previous-run",
				startedAt: now,
				createdAt: now,
				updatedAt: now,
			});
			const statuses: string[] = [];
			const notification = spyOn(
				backgroundTaskService,
				"notifyDerivedStatusChanged",
			).mockImplementation((parentId, taskId) => {
				expect(parentId).toBe(parentNarratorId);
				expect(taskId).toBe(subagentId);
				const narrator = db.select().from(narrators).where(eq(narrators.id, taskId)).get();
				const task = db.select().from(backgroundTasks).where(eq(backgroundTasks.id, taskId)).get();
				expect<string | null | undefined>(task?.status).toBe(narrator?.backgroundStatus);
				expect(task?.logicalRunId).toBe(narrator?.logicalRunId);
				expect(task?.logicalRunId).not.toBe("previous-run");
				expect(task?.output).toBe(narrator?.backgroundResult);
				expect(task?.completedAt).toBe(narrator?.backgroundCompletedAt);
				if (task?.status === "running") {
					expect(task.output).toBeNull();
					expect(task.completedAt).toBeNull();
				} else {
					expect(task?.output).toStartWith("Re-execution failed:");
					expect(task?.completedAt).toBeString();
				}
				statuses.push(task?.status ?? "missing");
			});
			beforeDeniedRetryIo = async () => {
				expect(statuses).toEqual(["running"]);
				if (failure === "thrown") throw new Error("retry I/O failed");
			};
			deniedRetryShouldContinue = false;
			try {
				const resume = resumeSubagent({
					subagentId,
					intent: "retry_denied_tool",
					actor: "user",
					retryToolUseId: "denied-tool-use",
					locale: "en",
				});
				if (failure === "thrown") {
					await expect(resume).rejects.toThrow("retry I/O failed");
				} else {
					expect((await resume).started).toBe(false);
				}
				expect(statuses).toEqual(["running", "failed"]);
				expect(notification).toHaveBeenCalledTimes(2);
				expect(startCalls).toHaveLength(0);
			} finally {
				notification.mockRestore();
			}
		});
	}

	test("edits and regenerates a subagent without creating a generic narrator session", async () => {
		const subagentId = "resume-edited-message";
		const image = new File(["png"], "new.png", { type: "image/png" });
		const textFile = new File(["notes"], "new.txt", { type: "text/plain" });

		const result = await resumeSubagent({
			subagentId,
			intent: "regenerate_edited_message",
			actor: "user",
			editMessageId: "user-message-to-edit",
			editContent: "edited prompt",
			editKeepImageIds: ["old-image"],
			editNewImages: [image],
			editKeepTextFilePaths: ["/work/old.txt"],
			editNewTextFiles: [textFile],
			createdBy: "user-5",
			locale: "en",
			replyInUserLanguage: true,
		});

		expect(result.started).toBe(true);
		expect(editedMessageCalls).toEqual([
			{
				narratorId: subagentId,
				messageId: "user-message-to-edit",
				content: "edited prompt",
				locale: "en",
				replyInUserLanguage: true,
				options: {
					keepImageIds: ["old-image"],
					newImages: [image],
					keepTextFilePaths: ["/work/old.txt"],
					newTextFiles: [textFile],
					userId: "user-5",
					deferContinuation: true,
					// Omitted by the caller => revert, the behaviour every edit had.
					revertFiles: true,
				},
			},
		]);
		expect(startCalls[0]).toMatchObject({
			subagentId,
			prompt: "edited prompt",
			persistPrompt: false,
			userId: "user-5",
		});
		await finishRun(subagentId);
	});

	// Guards the wiring that made this bug possible: editing a subagent message goes
	// through resumeSubagent rather than calling editAndRegenerate, so a dropped field
	// silently discards the user's choice instead of failing.
	test("forwards the revert choice and scope when editing a subagent message", async () => {
		const subagentId = "resume-edited-message-skip-revert";

		const result = await resumeSubagent({
			subagentId,
			intent: "regenerate_edited_message",
			actor: "user",
			editMessageId: "user-message-to-edit",
			editContent: "edited prompt",
			editRevertFiles: false,
			editRevertScope: "workspace",
			createdBy: "user-6",
			locale: "en",
		});

		expect(result.started).toBe(true);
		expect(editedMessageCalls[0]?.options).toMatchObject({
			revertFiles: false,
			revertScope: "workspace",
		});
		await finishRun(subagentId);
	});

	// An edit resume rewrites its intent to `retry_last_input`, so the truncation the
	// retry performs runs AFTER the edit already made (or deliberately skipped) the
	// rollback. Reverting a second time would undo files the user asked to keep, and
	// once the edit's regeneration is live it can fail on the workspace-write guard —
	// surfacing as "something is writing to this workspace" for a rollback nobody
	// asked for, with the edit already applied.
	test("does not revert a second time when an edit resume becomes a retry", async () => {
		const subagentId = "resume-edited-message-no-double-revert";

		const result = await resumeSubagent({
			subagentId,
			intent: "regenerate_edited_message",
			actor: "user",
			editMessageId: "user-message-to-edit",
			editContent: "edited prompt",
			editRevertFiles: false,
			createdBy: "user-7",
			locale: "en",
		});

		expect(result.started).toBe(true);
		// The retry-side truncation must explicitly skip the rollback.
		const retryTruncation = deleteMessagesAfterCalls.at(-1);
		expect(retryTruncation?.narratorId).toBe(subagentId);
		expect(retryTruncation?.opts).toMatchObject({ skipRevert: true });
		await finishRun(subagentId);
	});

	// Plain retries and automatic recovery must preserve files unless rollback is explicit.
	test("a plain retry preserves the truncated messages' file changes by default", async () => {
		const subagentId = "resume-plain-retry-preserves-files";

		const result = await resumeSubagent({
			subagentId,
			intent: "retry_last_input",
			actor: "user",
			createdBy: "user-8",
			locale: "en",
		});

		expect(result.started).toBe(true);
		const truncation = deleteMessagesAfterCalls.at(-1);
		expect(truncation?.narratorId).toBe(subagentId);
		expect(truncation?.opts).toMatchObject({ skipRevert: true });
		await finishRun(subagentId);
	});

	test("a plain retry after history-only rollback preserves real database checkpoints and files", async () => {
		const { db } = await import("../../db");
		const { narrators, narratorMessages, narratorMessageRefs, narratorToolCalls } = await import(
			"../../db/schema"
		);
		const { eq } = await import("drizzle-orm");
		const { narratorService } = await import("../narrator-service");
		const subagentId = "resume-database-history-only";
		const cwd = mkdtempSync(join(tmpdir(), "nf-subagent-retry-"));
		const path = join(cwd, "kept.txt");
		const now = new Date().toISOString();
		databaseNarratorIds.add(subagentId);
		try {
			writeFileSync(path, "kept file bytes\n");
			db.insert(narrators)
				.values([
					{ id: parentNarratorId, cwd, createdAt: now, updatedAt: now },
					{
						id: subagentId,
						type: "subagent",
						variant: "subagent:general",
						parentNarratorId,
						cwd,
						status: "idle",
						createdAt: now,
						updatedAt: now,
					},
				])
				.run();
			const message = (id: string, seq: number, role: "user" | "assistant") => {
				db.insert(narratorMessages)
					.values({
						id,
						narratorId: subagentId,
						role,
						contentText: role === "user" ? "retry my request" : null,
						contentJson:
							role === "user"
								? [{ type: "text", text: "retry my request" }]
								: [{ type: "tool_use", id: "edit", name: "Edit" }],
						createdAt: now,
					})
					.run();
				db.insert(narratorMessageRefs)
					.values({ id: `ref-${id}`, narratorId: subagentId, messageId: id, seq })
					.run();
			};
			message("retry-user", 0, "user");
			message("retry-answer", 1, "assistant");
			db.insert(narratorToolCalls)
				.values({
					id: "retry-edit-call",
					narratorId: subagentId,
					messageId: "retry-answer",
					toolUseId: "edit",
					toolName: "Edit",
					inputJson: { file_path: path, old_string: "before", new_string: "kept" },
					status: "success",
					executionDeviceId: "local",
					executionCwd: cwd,
					executionPathFlavor: "posix",
					resolvedFilePath: path,
					createdAt: now,
				})
				.run();
			const evidence = () => ({
				messages: db
					.select()
					.from(narratorMessages)
					.where(eq(narratorMessages.narratorId, subagentId))
					.all(),
				refs: db
					.select()
					.from(narratorMessageRefs)
					.where(eq(narratorMessageRefs.narratorId, subagentId))
					.all(),
				tools: db
					.select()
					.from(narratorToolCalls)
					.where(eq(narratorToolCalls.narratorId, subagentId))
					.all(),
			});
			const deleted = await narratorService.deleteMessagesAfter(subagentId, "retry-user", {
				skipRevert: true,
			});
			expect(deleted.deletedMessageIds).toEqual(["retry-answer"]);
			const kept = evidence();
			expect(kept.messages.filter((row) => row.role === "disp")).toHaveLength(1);
			expect(kept.refs.filter((row) => row.segmentCompactId !== null)).toHaveLength(1);
			expect(kept.tools).toHaveLength(1);
			expect(kept.tools[0]).toMatchObject({
				isFileHistoryCheckpoint: true,
				executionOriginToolCallId: "retry-edit-call",
			});
			deleteMessagesAfterCalls.length = 0;
			const result = await resumeSubagent({
				subagentId,
				intent: "retry_last_input",
				actor: "user",
				locale: "en",
				// Isolate retry preparation from the unrelated standalone announcement fixture.
				skipConclusionDelivery: true,
			});
			expect(result.started).toBe(true);
			expect(deleteMessagesAfterCalls).toEqual([
				{ narratorId: subagentId, messageId: "retry-user", opts: { skipRevert: true } },
			]);
			expect(startCalls).toHaveLength(1);
			expect(startCalls[0]).toMatchObject({
				subagentId,
				prompt: "retry my request",
				persistPrompt: false,
			});
			expect(evidence()).toEqual(kept);
			expect(readFileSync(path, "utf8")).toBe("kept file bytes\n");
			await finishRun(subagentId);
			await expect(result.terminalCompletion).resolves.toContain("done");
		} finally {
			await finishRun(subagentId);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("a plain retry explicitly requesting rollback forwards skipRevert false", async () => {
		const subagentId = "resume-plain-retry-explicit-revert";

		const result = await resumeSubagent({
			subagentId,
			intent: "retry_last_input",
			actor: "user",
			retryRevertFiles: true,
			createdBy: "user-8",
			locale: "en",
		});

		expect(result.started).toBe(true);
		const truncation = deleteMessagesAfterCalls.at(-1);
		expect(truncation?.narratorId).toBe(subagentId);
		expect(truncation?.opts).toMatchObject({ skipRevert: false });
		await finishRun(subagentId);
	});

	test("standalone manual override retains the existing runner and publication authority", async () => {
		const subagentId = "standalone-manual-override";
		standaloneSubagentIds.add(subagentId);
		originResult = null;
		const first = await resumeSubagent({
			subagentId,
			intent: "follow_up",
			actor: "user",
			prompt: "start",
			locale: "en",
		});
		originResult = { parentToolUseId: first.originToolUseId };
		const waiting = waitForManualOverride(
			subagentId,
			new AbortController().signal,
			parentNarratorId,
			first.originToolUseId,
		);
		const resumed = await resumeSubagent({
			subagentId,
			intent: "follow_up",
			actor: "user",
			prompt: "resume manually",
			locale: "en",
		});
		expect(resumed.resumedSuspendedRunner).toBe(true);
		expect(startCalls).toHaveLength(1);
		expect(persistedCalls[0].parentToolUseId).toBe(first.originToolUseId);
		await expect(waiting).resolves.toMatchObject({ action: "resume", prompt: "resume manually" });
		await finishRun(subagentId);
		await expect(first.terminalCompletion).resolves.toContain("done");
		expect(conclusionCalls).toHaveLength(0);
		expect(announcements).toHaveLength(1);
		expect(hasActiveSubagentResumeRun(subagentId)).toBe(false);
	});

	test("a parent Send wakes a suspended (taken-over) runner by consuming its mailbox row once", async () => {
		// The parent's message is already accepted in the mailbox. Waking the suspended
		// runner must consume THAT row, not persist `prompt` as a second copy: the old
		// path wrote the message now and again when the queue drained on the next turn.
		const subagentId = "mailbox-wake-suspended";
		const waiting = waitForManualOverride(
			subagentId,
			new AbortController().signal,
			parentNarratorId,
			originToolUseId,
		);
		queuedMailboxInputs.push("[Message from the parent narrator]\nplease also check X");
		const result = await resumeSubagent({
			subagentId,
			intent: "follow_up",
			actor: "parent_agent",
			mailboxInput: true,
			prompt: "[Message from the parent narrator]\nplease also check X",
			locale: "en",
		});
		expect(result.resumedSuspendedRunner).toBe(true);
		expect(startCalls).toHaveLength(0);
		expect(persistedCalls).toHaveLength(0);
		expect(mailboxConsumeCalls).toEqual([subagentId]);
		await expect(waiting).resolves.toMatchObject({
			action: "resume",
			prompt: "[Message from the parent narrator]\nplease also check X",
			userId: "mailbox-user",
		});
	});

	test("a terminal that fired before consume leaves the mailbox row queued", async () => {
		// Timeout / parent-abort settles the claim with a terminal. That must not take
		// the mailbox row with it: checking only AFTER consume dropped the queued
		// message, and releaseManualOverrideClaim restores the claim — not the message.
		const subagentId = "mailbox-wake-terminal-wins";
		const ac = new AbortController();
		const waiting = waitForManualOverride(subagentId, ac.signal, parentNarratorId, originToolUseId);
		queuedMailboxInputs.push("[Message from the parent narrator]\nlater work");
		// Aborts only once the manual-override claim is held (prepareResumeTurn's getById):
		// recordTerminal then parks a pendingTerminal on the claimed entry instead of
		// settling the still-waiting one.
		const { getManualOverrideRuntime } = await import("../subagent-manual-override");
		duringPrepare = () => {
			if (getManualOverrideRuntime(subagentId)?.phase !== "claimed") return;
			duringPrepare = undefined;
			ac.abort();
		};
		await expect(
			resumeSubagent({
				subagentId,
				intent: "follow_up",
				actor: "parent_agent",
				mailboxInput: true,
				prompt: "[Message from the parent narrator]\nlater work",
				locale: "en",
			}),
		).rejects.toThrow("Subagent suspension ended while the resume was preparing");
		expect(mailboxConsumeCalls).toEqual([]);
		expect(queuedMailboxInputs).toEqual(["[Message from the parent narrator]\nlater work"]);
		await expect(waiting).resolves.toMatchObject({
			action: "finish",
			finalText: "Parent narrator interrupted",
		});
	});

	test("a mailbox wake with no queued head leaves the suspended runner waiting", async () => {
		const subagentId = "mailbox-wake-empty";
		const waiting = waitForManualOverride(
			subagentId,
			new AbortController().signal,
			parentNarratorId,
			originToolUseId,
		);
		await expect(
			resumeSubagent({
				subagentId,
				intent: "follow_up",
				actor: "parent_agent",
				mailboxInput: true,
				locale: "en",
			}),
		).rejects.toThrow("Mailbox head is not available");
		// Released back to waiting, so a later real input can still resume it.
		expect(
			(await import("../subagent-manual-override")).getManualOverrideRuntime(subagentId)?.phase,
		).toBe("waiting");
		clearManualOverrideRuntimes();
		await expect(waiting).resolves.toMatchObject({ action: "finish" });
	});

	test("resumes a suspended original runner instead of starting another engine", async () => {
		const subagentId = "resume-manual-override";
		const waiting = waitForManualOverride(
			subagentId,
			new AbortController().signal,
			parentNarratorId,
			originToolUseId,
		);
		const image = {
			imageId: "image-2",
			filename: "screen.png",
			mediaType: "image/png",
		};

		const result = await resumeSubagent({
			subagentId,
			intent: "follow_up",
			actor: "user",
			prompt: "continue in the original runner",
			images: [image],
			commandText: "/continue",
			createdBy: "user-3",
			locale: "en",
		});

		expect(result.resumedSuspendedRunner).toBe(true);
		expect(startCalls).toHaveLength(0);
		expect(persistedCalls).toHaveLength(1);
		expect(persistedCalls[0]).toMatchObject({
			narratorId: subagentId,
			text: "continue in the original runner",
			parentToolUseId: originToolUseId,
			options: {
				images: [image],
				commandText: "/continue",
				createdBy: "user-3",
			},
		});
		await expect(waiting).resolves.toMatchObject({
			action: "resume",
			prompt: "continue in the original runner",
			userId: "user-3",
		});
	});
});
