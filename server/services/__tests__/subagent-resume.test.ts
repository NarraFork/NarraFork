import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

const originToolUseId = "origin-tool-use";
const parentNarratorId = "parent-narrator";
const startCalls: Array<Record<string, unknown>> = [];
const persistedCalls: Array<Record<string, unknown>> = [];
const conclusionCalls: Array<Record<string, unknown>> = [];
const retriedToolCalls: Array<Record<string, unknown>> = [];
const editedMessageCalls: Array<Record<string, unknown>> = [];
const deleteMessagesAfterCalls: Array<Record<string, unknown>> = [];
const foregroundResolvers = new Map<string, (output: string) => void>();
const terminalResolvers = new Map<string, (output: string) => void>();
let loadedTrailingToolResults: unknown[] = [];
let clearManualOverrideRuntimes: typeof import("../subagent-manual-override").clearManualOverrideRuntimes;
let waitForManualOverride: typeof import("../subagent-manual-override").waitForManualOverride;
let hasActiveSubagentResumeRun: typeof import("../subagent-resume").hasActiveSubagentResumeRun;
let resumeSubagent: typeof import("../subagent-resume").resumeSubagent;

// Real module namespaces captured before mocking, so afterAll can re-point the
// GLOBAL module mocks back to the real implementations. Bun's mock.module is
// process-wide and mock.restore() does NOT undo it, so without an explicit
// re-point these mocks (esp. lib/settings' resolveProvider) leak into every
// later-loaded suite and break e.g. provider-resolution / resolve-aggregation.
const realModules: Record<string, () => unknown> = {};

function makeNarrator(id: string) {
	return {
		id,
		variant: "subagent:general",
		parentNarratorId,
		status: "idle",
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
	const realNarratorServiceModule = { ...(await import("../narrator-service")) };
	const realNarratorService = realNarratorServiceModule.narratorService;
	const realSettings = { ...(await import("../../lib/settings")) };
	const realDbModule = { ...(await import("../../db")) };
	const realDb = realDbModule.db;
	const query = {
		...realDb.query,
		narratorMessages: {
			...realDb.query.narratorMessages,
			findFirst: mock(async (options?: { columns?: Record<string, boolean> }) =>
				options?.columns?.parentToolUseId
					? { parentToolUseId: originToolUseId }
					: realDb.query.narratorMessages.findFirst(options as never),
			),
		},
		narrators: {
			...realDb.query.narrators,
			findFirst: mock(async (options?: { columns?: Record<string, boolean> }) =>
				options?.columns?.pendingModelRestore
					? { pendingModelRestore: null }
					: realDb.query.narrators.findFirst(options as never),
			),
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
			getById: mock(async (id: string) =>
				isEditTestNarrator(id) ? realNarratorService.getById(id) : makeNarrator(id),
			),
			getModelHistorySinceLastCompact: mock(async (id: string) =>
				isEditTestNarrator(id)
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
					return isEditTestNarrator(args[0])
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
			getToolCallByToolUseId: mock(async () => ({ messageId: "parent-message" })),
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
		startContinuedSubagent: mock(async (input: Record<string, unknown>) => {
			startCalls.push(input);
			const subagentId = String(input.subagentId);
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
				retriedToolCalls.push({
					narratorId,
					toolUseId,
					locale,
					replyInUserLanguage,
					userId,
					options,
				});
				return { ok: true, shouldContinue: true };
			},
		),
		updateToolCallConclusion: mock(async (input: Record<string, unknown>) => {
			conclusionCalls.push(input);
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

afterEach(async () => {
	for (const subagentId of [...terminalResolvers.keys()]) {
		await finishRun(subagentId);
	}
	startCalls.length = 0;
	persistedCalls.length = 0;
	conclusionCalls.length = 0;
	retriedToolCalls.length = 0;
	editedMessageCalls.length = 0;
	deleteMessagesAfterCalls.length = 0;
	loadedTrailingToolResults = [];
	clearManualOverrideRuntimes();
	foregroundResolvers.clear();
	terminalResolvers.clear();
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

describe("resumeSubagent", () => {
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
				options: { autoContinue: false },
			},
		]);
		expect(startCalls[0]).toMatchObject({
			subagentId,
			persistPrompt: false,
			initialHistory: [{ role: "user", content: "history" }],
			initialTrailingToolResults: [{ type: "tool_result", toolUseId: "denied-tool-use" }],
		});
		await finishRun(subagentId);
	});

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

	// The default is load-bearing for the other callers of this intent (a plain
	// retry, the Codex image-generation fix, recharge resume): they never edited
	// anything, so their truncation must still roll files back.
	test("a plain retry still reverts the truncated messages' file changes", async () => {
		const subagentId = "resume-plain-retry-reverts";

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
		expect(truncation?.opts).toMatchObject({ skipRevert: false });
		await finishRun(subagentId);
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
