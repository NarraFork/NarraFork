import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { NotFoundError } from "../../lib/errors";

const realNarratorServiceModule = { ...(await import("../narrator-service")) };
const realNarratorPersistenceModule = { ...(await import("../narrator-persistence")) };
const realContinuationModule = { ...(await import("../tool-continuation-service")) };
const realNarratorSessionModule = { ...(await import("../narrator-session")) };
const realSubagentResumeModule = { ...(await import("../subagent-resume")) };
const realAgentCommunicationModule = { ...(await import("../agent-communication")) };
const realAgentReplyWaiterModule = { ...(await import("../agent-reply-waiter")) };
const updateCoordinator = await import("../update-coordinator");
const { setObservedRestartHandoffForTests } = await import("../../lib/restart-handoff");

/** Marker nonce every test manifest is bound to unless it is exercising a mismatch. */
const HANDOFF_NONCE = "test-handoff-nonce";

/** Present this process as the replacement spawned by the manifest's update attempt. */
function actAsReplacementProcess(markerNonce: string | undefined = HANDOFF_NONCE): void {
	setObservedRestartHandoffForTests(markerNonce ? { markerNonce } : {});
}

let loadMode: "missing" | "transient" | "idle" | "working" | "archived" = "transient";
let requestedProtectionEpoch: string | null = null;
let renewCalls = 0;
let renewClaimSucceeds = true;
let executePersistedCalls = 0;
let continueNarratorCalls = 0;
let cancelInterruptibleGate: Promise<void> | null = null;
let markCancelInterruptibleStarted: (() => void) | null = null;
let continueNarratorResult: { ok: boolean } = { ok: true };
let continueNarratorImpl: (() => Promise<{ ok: boolean }>) | null = null;
let beforeConditionalToolResultWrite: (() => void | Promise<void>) | null = null;
let beforeMarkResultWritten: ((toolCallId: string) => void | Promise<void>) | null = null;
let afterOwnerPending: (() => void | Promise<void>) | null = null;
let ownerStartedCalls = 0;
let abortActiveRecoveryLoopCalls = 0;
let executePersistedToolCallImpl: (input?: {
	toolCallId: string;
}) => Promise<{ ok: true; shouldContinue: true }> = async () => ({
	ok: true,
	shouldContinue: true,
});
const resumedAgentCalls: Array<Record<string, unknown>> = [];
const awaitAgentCalls: Array<Record<string, unknown>> = [];
const updatedToolResults: Array<{ args: unknown[] }> = [];
let expectedPendingReplyProbe: {
	requesterId: string;
	responderId: string;
	scope: import("../agent-reply-waiter").AgentReplyScope;
} | null = null;
const replyWaiterPresenceAtAgentResume: boolean[] = [];
const toolCallResults = new Map<
	string,
	import("../tool-continuation-service").ToolContinuationToolCallResult
>();
let resumedAgentCompletion: Promise<string> = Promise.resolve(
	"<subagent_id>child</subagent_id>\n\ndone",
);
let awaitAgentResult: Promise<Record<string, unknown>> = Promise.resolve({
	id: "child",
	status: "completed",
	formatted: "Subagent child completed.\n\nResult:\ndone",
});
let recoveryQueue: import("../tool-continuation-service").ToolContinuationRecoveryItem[] = [];
let continuationRows: import("../tool-continuation-service").ToolContinuationRecord[] = [];
const startupProtection = {
	toolCallIds: new Set(["protected-tool"]),
	narratorIds: new Set(["protected-narrator"]),
	backgroundTaskIds: new Set(["protected-background-task"]),
};

function replaceContinuation(
	record: import("../tool-continuation-service").ToolContinuationRecord,
): void {
	continuationRows = continuationRows.map((row) =>
		row.toolCallId === record.toolCallId ? record : row,
	);
	recoveryQueue = recoveryQueue.map((item) =>
		item.record.toolCallId === record.toolCallId ? { ...item, record } : item,
	);
}

mock.module("../narrator-service", () => ({
	...realNarratorServiceModule,
	narratorService: {
		...realNarratorServiceModule.narratorService,
		getById: async (id: string) => {
			if (loadMode === "missing") throw new NotFoundError("Narrator", id);
			if (loadMode === "transient") throw new Error("temporary database failure");
			return {
				id,
				variant: "primary",
				status: loadMode === "working" ? "working" : loadMode === "archived" ? "archived" : "idle",
			} as never;
		},
		updateStatus: async () => {},
		updateToolCallResult: async (...args: unknown[]) => {
			updatedToolResults.push({ args });
			const toolCallId = args[3];
			const result = args[1] as { output?: unknown; status?: string } | undefined;
			if (typeof toolCallId === "string") {
				const current = toolCallResults.get(toolCallId);
				if (current) {
					toolCallResults.set(toolCallId, {
						...current,
						status: (result?.status ?? current.status) as typeof current.status,
						outputJson: result?.output ?? current.outputJson,
					});
				}
			}
		},
	},
}));

mock.module("../narrator-persistence", () => ({
	...realNarratorPersistenceModule,
	narratorPersistence: {
		...realNarratorPersistenceModule.narratorPersistence,
		updateToolCallResultIfActive: async (...args: unknown[]) => {
			await beforeConditionalToolResultWrite?.();
			const toolCallId = args[3];
			if (typeof toolCallId !== "string") return false;
			const current = toolCallResults.get(toolCallId);
			if (!current || !["initializing", "pending", "running"].includes(current.status)) {
				return false;
			}
			const result = args[1] as { output?: unknown; status?: string } | undefined;
			updatedToolResults.push({ args });
			toolCallResults.set(toolCallId, {
				...current,
				status: (result?.status ?? current.status) as typeof current.status,
				outputJson: result?.output ?? current.outputJson,
			});
			return true;
		},
	},
}));

mock.module("../tool-continuation-service", () => ({
	...realContinuationModule,
	toolContinuationService: {
		...realContinuationModule.toolContinuationService,
		listByEpoch: async () => continuationRows,
		listRecoveryQueueByEpoch: async () => recoveryQueue,
		getByToolCallId: async (toolCallId: string) =>
			continuationRows.find((row) => row.toolCallId === toolCallId) ?? null,
		getToolCallResult: async (toolCallId: string) => toolCallResults.get(toolCallId) ?? null,
		reconcileSendAwaitResult: async (toolCallId: string) => {
			const current = continuationRows.find((row) => row.toolCallId === toolCallId);
			const toolCall = toolCallResults.get(toolCallId);
			if (
				!current ||
				current.kind !== "send_await" ||
				!toolCall ||
				!(toolCall.status === "success" || toolCall.status === "fail")
			) {
				return current ?? null;
			}
			const reconciled = {
				...current,
				state: "completed" as const,
				claimToken: null,
				deadlineAt: null,
				payloadJson: { ...(current.payloadJson ?? {}), recoveryPhase: "result_written" },
			};
			replaceContinuation(reconciled);
			return reconciled;
		},
		bindRecoveryTokenForNarrator: async (
			narratorId: string,
			updateEpoch: string,
			recoveryToken: string,
		) => {
			const updated = continuationRows
				.filter(
					(row) =>
						row.narratorId === narratorId &&
						row.updateEpoch === updateEpoch &&
						row.state !== "cancelled" &&
						row.payloadJson?.recoveryPhase !== "owner_continuation_started",
				)
				.map((row) => ({
					...row,
					payloadJson: { ...(row.payloadJson ?? {}), recoveryToken },
				}));
			for (const row of updated) replaceContinuation(row);
			return updated;
		},
		claim: async (toolCallId: string, input: { claimToken?: string; deadlineAt: string }) => {
			const current = continuationRows.find((row) => row.toolCallId === toolCallId);
			if (!current || !["paused", "waiting"].includes(current.state)) return null;
			const claimed = {
				...current,
				state: "resuming" as const,
				claimToken: input.claimToken ?? "claim",
				deadlineAt: input.deadlineAt,
			};
			replaceContinuation(claimed);
			return claimed;
		},
		markResultWritten: async (toolCallId: string, input: { claimToken: string }) => {
			await beforeMarkResultWritten?.(toolCallId);
			const current = continuationRows.find((row) => row.toolCallId === toolCallId);
			if (!current || current.claimToken !== input.claimToken) return null;
			const updated = {
				...current,
				payloadJson: { ...(current.payloadJson ?? {}), recoveryPhase: "result_written" },
			};
			replaceContinuation(updated);
			return updated;
		},
		markOwnerContinuationPendingForMessage: async (
			messageId: string,
			_updateEpoch: string,
			recoveryToken?: string,
		) => {
			const ids = new Set(
				recoveryQueue
					.filter((item) => item.messageId === messageId)
					.map((item) => item.record.toolCallId),
			);
			const updated = continuationRows
				.filter(
					(row) =>
						ids.has(row.toolCallId) &&
						row.state !== "cancelled" &&
						(!recoveryToken || row.payloadJson?.recoveryToken === recoveryToken),
				)
				.map((row) => ({
					...row,
					payloadJson: {
						...(row.payloadJson ?? {}),
						recoveryPhase: "owner_continuation_pending",
					},
				}));
			for (const row of updated) replaceContinuation(row);
			await afterOwnerPending?.();
			return updated;
		},
		markOwnerContinuationStartedForMessage: async (
			messageId: string,
			_updateEpoch: string,
			recoveryToken?: string,
		) => {
			ownerStartedCalls += 1;
			const ids = new Set(
				recoveryQueue
					.filter((item) => item.messageId === messageId)
					.map((item) => item.record.toolCallId),
			);
			const updated = continuationRows
				.filter(
					(row) =>
						ids.has(row.toolCallId) &&
						row.state !== "cancelled" &&
						row.payloadJson?.recoveryPhase === "owner_continuation_pending" &&
						(!recoveryToken || row.payloadJson?.recoveryToken === recoveryToken),
				)
				.map((row) => ({
					...row,
					state: "completed" as const,
					claimToken: null,
					payloadJson: {
						...(row.payloadJson ?? {}),
						recoveryPhase: "owner_continuation_started",
					},
				}));
			for (const row of updated) replaceContinuation(row);
			return updated;
		},
		hasUnwrittenResultsForNarrator: async () => false,
		markOwnerContinuationStartedForNarrator: async () => true,
		cancelInterruptibleForNarrator: async (
			narratorId: string,
			updateEpoch: string,
			input:
				| string
				| {
						recoveryToken?: string;
						includeOwnerStarted?: boolean;
						includeBackgroundAgentOwner?: boolean;
				  } = {},
		) => {
			markCancelInterruptibleStarted?.();
			await cancelInterruptibleGate;
			const recoveryToken = typeof input === "string" ? undefined : input.recoveryToken;
			const includeOwnerStarted =
				typeof input === "string" ? false : input.includeOwnerStarted === true;
			const includeBackgroundAgentOwner =
				typeof input === "string" ? false : input.includeBackgroundAgentOwner === true;
			const cancelled = continuationRows
				.filter(
					(row) =>
						row.narratorId === narratorId &&
						row.updateEpoch === updateEpoch &&
						(includeBackgroundAgentOwner || row.kind !== "background_agent") &&
						(!recoveryToken || row.payloadJson?.recoveryToken === recoveryToken) &&
						row.state !== "cancelled" &&
						(row.state !== "completed" ||
							(includeOwnerStarted &&
								(row.payloadJson?.recoveryPhase === "owner_continuation_pending" ||
									row.payloadJson?.recoveryPhase === "owner_continuation_started"))),
				)
				.map((row) => ({ ...row, state: "cancelled" as const, claimToken: null }));
			for (const row of cancelled) replaceContinuation(row);
			return cancelled;
		},
		fail: async (toolCallId: string, input: { claimToken: string; errorMessage: string }) => {
			const current = continuationRows.find((row) => row.toolCallId === toolCallId);
			if (!current || current.claimToken !== input.claimToken) return null;
			const failed = {
				...current,
				state: "failed" as const,
				claimToken: null,
				errorMessage: input.errorMessage,
			};
			replaceContinuation(failed);
			return failed;
		},
		renewClaim: async () => {
			renewCalls += 1;
			return renewClaimSucceeds ? ({} as never) : null;
		},
		getProtectionSets: async (updateEpoch: string) => {
			requestedProtectionEpoch = updateEpoch;
			return startupProtection;
		},
	},
}));

mock.module("../narrator-session", () => ({
	...realNarratorSessionModule,
	executePersistedToolCall: async (input: { toolCallId: string }) => {
		executePersistedCalls += 1;
		return executePersistedToolCallImpl(input);
	},
	continueNarrator: async () => {
		continueNarratorCalls += 1;
		return continueNarratorImpl ? continueNarratorImpl() : continueNarratorResult;
	},
	abortActiveNarratorLoopForPlannedUpdateRecovery: () => {
		abortActiveRecoveryLoopCalls += 1;
		return true;
	},
}));

mock.module("../subagent-resume", () => ({
	...realSubagentResumeModule,
	resumeSubagent: async (input: Record<string, unknown>) => {
		resumedAgentCalls.push(input);
		if (expectedPendingReplyProbe) {
			replyWaiterPresenceAtAgentResume.push(
				realAgentReplyWaiterModule.hasPendingAgentReply(
					expectedPendingReplyProbe.requesterId,
					expectedPendingReplyProbe.responderId,
					expectedPendingReplyProbe.scope,
				),
			);
		}
		return {
			started: true,
			resumedSuspendedRunner: false,
			originToolUseId: "origin",
			terminalCompletion: resumedAgentCompletion,
		};
	},
}));

mock.module("../agent-communication", () => ({
	...realAgentCommunicationModule,
	awaitAgentResultDetailed: async (input: Record<string, unknown>) => {
		awaitAgentCalls.push(input);
		return awaitAgentResult;
	},
}));

const {
	buildRecoveredAwaitToolOutput,
	buildRecoveredSendAwaitToolOutput,
	getPlannedUpdateStartupProtection,
	resolveAgentExecutionDeadline,
	restoreNarratorsAfterPlannedUpdate,
	runContinuationRecoveryGroups,
	startContinuationClaimRenewal,
	waitForStableSendAwaitCheckpoint,
} = await import("../update-recovery-service");
type ToolContinuationRecord = import("../tool-continuation-service").ToolContinuationRecord;
type ToolContinuationRecoveryItem =
	import("../tool-continuation-service").ToolContinuationRecoveryItem;

beforeAll(() => {
	updateCoordinator.resetUpdateCoordinationForTests();
});

afterEach(() => {
	loadMode = "transient";
	requestedProtectionEpoch = null;
	renewCalls = 0;
	renewClaimSucceeds = true;
	executePersistedCalls = 0;
	continueNarratorCalls = 0;
	cancelInterruptibleGate = null;
	markCancelInterruptibleStarted = null;
	continueNarratorResult = { ok: true };
	continueNarratorImpl = null;
	beforeConditionalToolResultWrite = null;
	beforeMarkResultWritten = null;
	afterOwnerPending = null;
	ownerStartedCalls = 0;
	abortActiveRecoveryLoopCalls = 0;
	executePersistedToolCallImpl = async () => ({ ok: true, shouldContinue: true });
	resumedAgentCalls.length = 0;
	awaitAgentCalls.length = 0;
	updatedToolResults.length = 0;
	expectedPendingReplyProbe = null;
	replyWaiterPresenceAtAgentResume.length = 0;
	realAgentReplyWaiterModule.clearPendingAgentReplyWaits();
	toolCallResults.clear();
	resumedAgentCompletion = Promise.resolve("<subagent_id>child</subagent_id>\n\ndone");
	awaitAgentResult = Promise.resolve({
		id: "child",
		status: "completed",
		formatted: "Subagent child completed.\n\nResult:\ndone",
	});
	recoveryQueue = [];
	continuationRows = [];
	setObservedRestartHandoffForTests(null);
	updateCoordinator.resetUpdateCoordinationForTests();
});

afterAll(() => {
	mock.module("../narrator-service", () => realNarratorServiceModule);
	mock.module("../narrator-persistence", () => realNarratorPersistenceModule);
	mock.module("../tool-continuation-service", () => realContinuationModule);
	mock.module("../narrator-session", () => realNarratorSessionModule);
	mock.module("../subagent-resume", () => realSubagentResumeModule);
	mock.module("../agent-communication", () => realAgentCommunicationModule);
	mock.restore();
});

function continuationRecord(
	toolCallId: string,
	narratorId: string,
	overrides: Partial<ToolContinuationRecord> = {},
): ToolContinuationRecord {
	return {
		id: `continuation-${toolCallId}`,
		toolCallId,
		narratorId,
		updateEpoch: "epoch",
		kind: "deferred_tool",
		state: "paused",
		payloadJson: null,
		deadlineAt: null,
		claimToken: null,
		claimedAt: null,
		errorMessage: null,
		completedAt: null,
		createdAt: "2026-07-20T00:00:00.000Z",
		updatedAt: "2026-07-20T00:00:00.000Z",
		...overrides,
	};
}

function recoveryItem(
	record: ToolContinuationRecord,
	messageId: string,
	toolUseOrder: number,
	toolName = record.kind === "foreground_agent" || record.kind === "background_agent"
		? "Agent"
		: record.kind === "await_agent"
			? "Await"
			: record.kind === "send_await"
				? "Send"
				: "Write",
	input: Record<string, unknown> = {},
): ToolContinuationRecoveryItem {
	return {
		record,
		messageId,
		messageCreatedAt: "2026-07-20T00:00:00.000Z",
		toolCallCreatedAt: "2026-07-20T00:00:00.000Z",
		toolUseOrder,
		toolName,
		input,
	};
}

async function prepareRecovery() {
	updateCoordinator.writePlannedUpdateRecoverySnapshot({
		version: 2,
		updateEpoch: "epoch",
		targetVersion: "4.0.0",
		capturedAt: new Date().toISOString(),
		handoffMarkerNonce: HANDOFF_NONCE,
		narrators: [],
	});
	actAsReplacementProcess();
	return getPlannedUpdateStartupProtection();
}

function sendAwaitSnapshot(input: {
	toolUseId: string;
	requesterId?: string;
	responders: string[];
	deadlineAt?: string;
}): import("../agent-reply-waiter").AgentReplyWaitRunSnapshot {
	const requesterId = input.requesterId ?? "owner";
	const deadlineAt = input.deadlineAt ?? new Date(Date.now() + 60_000).toISOString();
	return {
		toolUseId: input.toolUseId,
		requesterId,
		doInterrupt: false,
		prefixSections: [],
		prefixTargets: [],
		waiters: input.responders.map((responderId, index) => ({
			toolUseId: input.toolUseId,
			requestId: `${input.toolUseId}-request-${index}`,
			requesterId,
			responderId,
			scope: { type: "parent-child", id: `${requesterId}\u0000${responderId}` },
			deadlineAt,
			label: `target-${index + 1}`,
			title: `Target ${index + 1}`,
			deliveryNote: `Delivered to ${responderId} once.`,
		})),
	};
}

describe("planned update recovery snapshot", () => {
	test("loads startup protection from the manifest epoch before generic recovery", async () => {
		updateCoordinator.writePlannedUpdateRecoverySnapshot({
			version: 2,
			updateEpoch: "update-protection-epoch",
			targetVersion: "4.0.0",
			capturedAt: new Date().toISOString(),
			handoffMarkerNonce: HANDOFF_NONCE,
			narrators: [],
		});
		actAsReplacementProcess();

		const startup = await getPlannedUpdateStartupProtection();

		expect(requestedProtectionEpoch).toBe("update-protection-epoch");
		expect(startup.snapshot?.updateEpoch).toBe("update-protection-epoch");
		expect(startup.protection).toBe(startupProtection);
	});

	test("reports a failed legacy resume without writing the target back to the manifest", async () => {
		// A retry entry could only ever be claimed by a startup that does not own this manifest,
		// which is exactly how abandoned narrators were resumed on every later boot.
		loadMode = "working";
		continueNarratorImpl = async () => {
			throw new Error("temporary database failure");
		};
		updateCoordinator.writePlannedUpdateRecoverySnapshot({
			version: 2,
			updateEpoch: "epoch",
			targetVersion: "4.0.0",
			capturedAt: new Date().toISOString(),
			handoffMarkerNonce: HANDOFF_NONCE,
			narrators: [{ narratorId: "n1", locale: "en" }],
		});
		actAsReplacementProcess();

		const recovery = await restoreNarratorsAfterPlannedUpdate();
		await expect(recovery?.completion).rejects.toThrow("Failed to mount 1 legacy narrator");

		expect(continueNarratorCalls).toBe(1);
		// The failure is reported, not converted into a standing retry instruction: the manifest is
		// left exactly as written (for diagnosis) and still carries the consumed handoff nonce.
		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).toMatchObject({
			updateEpoch: "epoch",
			handoffMarkerNonce: HANDOFF_NONCE,
			narrators: [{ narratorId: "n1", locale: "en" }],
		});

		// The next startup is not this update's replacement, so the leftover cannot resume anything.
		setObservedRestartHandoffForTests(null);
		continueNarratorCalls = 0;
		const nextStartup = await getPlannedUpdateStartupProtection();
		expect(nextStartup.snapshot).toBeNull();
		expect(await restoreNarratorsAfterPlannedUpdate(nextStartup)).toBeNull();
		expect(continueNarratorCalls).toBe(0);
		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).toBeNull();
	});

	test("drops targets whose narrators were deleted", async () => {
		loadMode = "missing";
		updateCoordinator.writePlannedUpdateRecoverySnapshot({
			version: 1,
			targetVersion: "4.0.0",
			capturedAt: new Date().toISOString(),
			narrators: [{ narratorId: "deleted", locale: "en" }],
		});
		actAsReplacementProcess();

		const recovery = await restoreNarratorsAfterPlannedUpdate();
		await recovery?.completion;

		expect(continueNarratorCalls).toBe(0);
		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).toBeNull();
	});

	test("discards a manifest when this process was not spawned by an update handoff", async () => {
		// The abandoned-narrator regression: a manifest left behind by a failed update (or an
		// unfinished recovery pass) must not be re-consumed by an ordinary manual restart.
		loadMode = "working";
		updateCoordinator.writePlannedUpdateRecoverySnapshot({
			version: 2,
			updateEpoch: "orphan-epoch",
			targetVersion: "4.0.0",
			capturedAt: new Date().toISOString(),
			handoffMarkerNonce: HANDOFF_NONCE,
			narrators: [{ narratorId: "abandoned", locale: "en" }],
		});
		setObservedRestartHandoffForTests(null);

		const startup = await getPlannedUpdateStartupProtection();
		expect(startup.snapshot).toBeNull();
		expect(await restoreNarratorsAfterPlannedUpdate(startup)).toBeNull();

		expect(continueNarratorCalls).toBe(0);
		expect(requestedProtectionEpoch).toBeNull();
		// Removed rather than left behind: keeping it is what made it fire again on the next boot.
		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).toBeNull();
	});

	test("discards a manifest belonging to a different update attempt", async () => {
		loadMode = "working";
		updateCoordinator.writePlannedUpdateRecoverySnapshot({
			version: 2,
			updateEpoch: "other-epoch",
			targetVersion: "4.0.0",
			capturedAt: new Date().toISOString(),
			handoffMarkerNonce: "nonce-from-an-earlier-attempt",
			narrators: [{ narratorId: "abandoned", locale: "en" }],
		});
		actAsReplacementProcess("nonce-of-this-attempt");

		const startup = await getPlannedUpdateStartupProtection();

		expect(startup.snapshot).toBeNull();
		expect(continueNarratorCalls).toBe(0);
		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).toBeNull();
	});

	test("discards an evidence-only manifest written by a failed update attempt", async () => {
		loadMode = "working";
		updateCoordinator.writePlannedUpdateRecoverySnapshot({
			version: 2,
			updateEpoch: "failed-epoch",
			targetVersion: "4.0.0",
			capturedAt: new Date().toISOString(),
			evidenceOnly: true,
			narrators: [{ narratorId: "abandoned", locale: "en" }],
		});
		// Even a genuine replacement process must not act on a failure record.
		actAsReplacementProcess();

		const startup = await getPlannedUpdateStartupProtection();

		expect(startup.snapshot).toBeNull();
		expect(continueNarratorCalls).toBe(0);
		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).toBeNull();
	});

	test("accepts a nonce-less manifest written by an older binary", async () => {
		loadMode = "working";
		updateCoordinator.writePlannedUpdateRecoverySnapshot({
			version: 1,
			targetVersion: "4.0.0",
			capturedAt: new Date().toISOString(),
			narrators: [{ narratorId: "n1", locale: "en" }],
		});
		actAsReplacementProcess();

		const recovery = await restoreNarratorsAfterPlannedUpdate();
		await recovery?.completion;

		expect(continueNarratorCalls).toBe(1);
		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).toBeNull();
	});

	for (const status of ["idle", "archived"] as const) {
		test(`does not resume a manifest narrator that is already ${status}`, async () => {
			// A user interrupt, an error, and a normal finish all persist a terminal row before
			// shutdown. Resuming those feeds a "Continue." turn into an abandoned session.
			loadMode = status === "idle" ? "idle" : "archived";
			updateCoordinator.writePlannedUpdateRecoverySnapshot({
				version: 2,
				updateEpoch: "epoch",
				targetVersion: "4.0.0",
				capturedAt: new Date().toISOString(),
				handoffMarkerNonce: HANDOFF_NONCE,
				narrators: [{ narratorId: "abandoned", locale: "en" }],
			});
			actAsReplacementProcess();

			const recovery = await restoreNarratorsAfterPlannedUpdate();
			await recovery?.completion;

			expect(continueNarratorCalls).toBe(0);
			expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).toBeNull();
		});
	}

	test("resumes a manifest narrator that was still mid-turn when the update replaced the process", async () => {
		loadMode = "working";
		updateCoordinator.writePlannedUpdateRecoverySnapshot({
			version: 2,
			updateEpoch: "epoch",
			targetVersion: "4.0.0",
			capturedAt: new Date().toISOString(),
			handoffMarkerNonce: HANDOFF_NONCE,
			narrators: [{ narratorId: "severed", locale: "en" }],
		});
		actAsReplacementProcess();

		const recovery = await restoreNarratorsAfterPlannedUpdate();
		await recovery?.completion;

		expect(continueNarratorCalls).toBe(1);
		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).toBeNull();
	});
});

describe("planned update Send await checkpoint stabilization", () => {
	test("waits for an active Send setup to publish its waiter snapshot", async () => {
		const run = realAgentReplyWaiterModule.beginAgentReplyWaitRun({
			toolUseId: "checkpoint-send-setup",
			requesterId: "owner",
		});
		const handle = realAgentReplyWaiterModule.registerAgentReplyWait({
			requesterId: "owner",
			responderId: "checkpoint-target",
			scope: { type: "parent-child", id: "owner\u0000checkpoint-target" },
			deadlineAt: new Date(Date.now() + 60_000).toISOString(),
			run,
			deliveryNote: "Delivered before checkpoint.",
		});
		let resolved = false;
		const checkpoint = waitForStableSendAwaitCheckpoint(
			{ toolCallId: "tool-checkpoint-setup", toolUseId: run.toolUseId },
			{ loadStatus: async () => "running", pause: async () => {} },
		).then((snapshot) => {
			resolved = true;
			return snapshot;
		});
		await Bun.sleep(0);
		expect(resolved).toBe(false);

		run.markStable();
		expect(await checkpoint).toMatchObject({
			toolUseId: run.toolUseId,
			waiters: [expect.objectContaining({ requestId: handle.requestId })],
		});
		handle.cancel();
		run.complete();
	});

	test("waits for an active row with no waiter run to finish instead of deferring or respawning it", async () => {
		const statuses = ["running", "success"];
		let statusReads = 0;
		const snapshot = await waitForStableSendAwaitCheckpoint(
			{ toolCallId: "tool-checkpoint-window", toolUseId: "send-window-no-run" },
			{
				loadStatus: async () => statuses[statusReads++] ?? "success",
				pause: async () => {},
			},
		);

		expect(snapshot).toBeNull();
		expect(statusReads).toBe(2);
	});
});

describe("planned update continuation scheduling", () => {
	test("uses loop grouping semantics with serial barriers and parallel-safe runs", async () => {
		const events: string[] = [];
		let releaseWrite = () => {};
		const writeGate = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		let releaseFirstAgent = () => {};
		const firstAgentGate = new Promise<void>((resolve) => {
			releaseFirstAgent = resolve;
		});
		let releaseStrictBash = () => {};
		const strictBashGate = new Promise<void>((resolve) => {
			releaseStrictBash = resolve;
		});
		let independentStarted = () => {};
		const independentStart = new Promise<void>((resolve) => {
			independentStarted = resolve;
		});
		const write = continuationRecord("tool-write", "narrator-a");
		const firstAgent = continuationRecord("tool-agent-1", "narrator-a", {
			kind: "foreground_agent",
		});
		const read = continuationRecord("tool-read", "narrator-a");
		const awaitAgent = continuationRecord("tool-await", "narrator-a", {
			kind: "await_agent",
		});
		const strictBash = continuationRecord("tool-bash", "narrator-a");
		const secondAgent = continuationRecord("tool-agent-2", "narrator-a", {
			kind: "foreground_agent",
		});
		const independent = continuationRecord("tool-independent", "narrator-b");

		const running = runContinuationRecoveryGroups(
			[
				recoveryItem(secondAgent, "message-a", 5),
				recoveryItem(strictBash, "message-a", 4, "Bash", { strict_serial: true }),
				recoveryItem(awaitAgent, "message-a", 3),
				recoveryItem(read, "message-a", 2, "Read"),
				recoveryItem(firstAgent, "message-a", 1),
				recoveryItem(write, "message-a", 0),
				recoveryItem(independent, "message-b", 0),
			],
			async (record) => {
				events.push(`${record.toolCallId}:start`);
				if (record.toolCallId === write.toolCallId) await writeGate;
				if (record.toolCallId === firstAgent.toolCallId) await firstAgentGate;
				if (record.toolCallId === strictBash.toolCallId) await strictBashGate;
				if (record.toolCallId === independent.toolCallId) independentStarted();
				events.push(`${record.toolCallId}:end`);
			},
		);

		await independentStart;
		await Bun.sleep(0);
		expect(events).toContain("tool-write:start");
		expect(events).toContain("tool-independent:start");
		expect(events).not.toContain("tool-agent-1:start");

		releaseWrite();
		await Bun.sleep(0);
		expect(events).toContain("tool-agent-1:start");
		expect(events).toContain("tool-read:start");
		// Recovery treats the Agent's runner handoff as its grouping boundary, matching
		// the live Agent tool's immediate start result rather than its terminal completion.
		expect(events).toContain("tool-await:start");
		expect(events).not.toContain("tool-bash:start");

		releaseFirstAgent();
		await Bun.sleep(0);
		expect(events).toContain("tool-bash:start");
		expect(events).not.toContain("tool-agent-2:start");

		releaseStrictBash();
		await running;
		expect(events.indexOf("tool-agent-2:start")).toBeGreaterThan(events.indexOf("tool-bash:end"));
	});

	test("does not release deferred Await until a preceding deferred Agent registers", async () => {
		loadMode = "idle";
		const agent = continuationRecord("tool-deferred-agent", "owner", {
			// Checkpoint rows created by older builds may omit payloadJson.toolName;
			// recovery must use the authoritative toolName selected with the queue item.
			payloadJson: { permissionGranted: true },
		});
		const awaitAgent = continuationRecord("tool-deferred-await", "owner", {
			payloadJson: { toolName: "Await", permissionGranted: true },
		});
		continuationRows = [agent, awaitAgent];
		recoveryQueue = [
			recoveryItem(agent, "message-deferred-agent-await", 0, "Agent"),
			recoveryItem(awaitAgent, "message-deferred-agent-await", 1, "Await"),
		];
		let releaseAgent = () => {};
		const agentGate = new Promise<void>((resolve) => {
			releaseAgent = resolve;
		});
		let agentRegistered = false;
		let awaitStarted = false;
		executePersistedToolCallImpl = async (input) => {
			if (input?.toolCallId === agent.toolCallId) {
				await agentGate;
				agentRegistered = true;
				return { ok: true, shouldContinue: true };
			}
			if (input?.toolCallId === awaitAgent.toolCallId) {
				awaitStarted = true;
				expect(agentRegistered).toBe(true);
			}
			return { ok: true, shouldContinue: true };
		};
		const prepared = await prepareRecovery();

		const restoring = restoreNarratorsAfterPlannedUpdate(prepared);
		await Bun.sleep(0);
		expect(executePersistedCalls).toBe(1);
		expect(awaitStarted).toBe(false);
		releaseAgent();
		const recovery = await restoring;
		await recovery?.completion;
		expect(awaitStarted).toBe(true);
	});

	test("does not release deferred Await before a pending Agent permission recovery registers", async () => {
		loadMode = "idle";
		const agent = continuationRecord("tool-pending-agent", "owner", {
			kind: "pending_permission",
			payloadJson: { permissionMode: "normal" },
		});
		const awaitAgent = continuationRecord("tool-await-pending-agent", "owner", {
			payloadJson: { permissionGranted: true },
		});
		continuationRows = [agent, awaitAgent];
		recoveryQueue = [
			recoveryItem(agent, "message-pending-agent-await", 0, "Agent"),
			recoveryItem(awaitAgent, "message-pending-agent-await", 1, "Await"),
		];
		let releaseAgent = () => {};
		const agentGate = new Promise<void>((resolve) => {
			releaseAgent = resolve;
		});
		let agentRegistered = false;
		let awaitStarted = false;
		executePersistedToolCallImpl = async (input) => {
			if (input?.toolCallId === agent.toolCallId) {
				await agentGate;
				agentRegistered = true;
				return { ok: true, shouldContinue: true };
			}
			if (input?.toolCallId === awaitAgent.toolCallId) {
				awaitStarted = true;
				expect(agentRegistered).toBe(true);
			}
			return { ok: true, shouldContinue: true };
		};
		const prepared = await prepareRecovery();

		const restoring = restoreNarratorsAfterPlannedUpdate(prepared);
		await Bun.sleep(0);
		expect(executePersistedCalls).toBe(1);
		expect(awaitStarted).toBe(false);
		releaseAgent();
		const recovery = await restoring;
		await recovery?.completion;
		expect(awaitStarted).toBe(true);
	});

	test("keeps Write before Agent and delivers the owner after the whole message", async () => {
		loadMode = "idle";
		let releaseWrite = () => {};
		const writeGate = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		executePersistedToolCallImpl = async () => {
			await writeGate;
			return { ok: true, shouldContinue: true };
		};
		const write = continuationRecord("tool-message-write", "owner", { state: "waiting" });
		const agent = continuationRecord("tool-message-agent", "owner", {
			kind: "foreground_agent",
			state: "waiting",
			payloadJson: { subagentId: "child-message" },
		});
		continuationRows = [write, agent];
		recoveryQueue = [
			recoveryItem(agent, "message-ordered", 1),
			recoveryItem(write, "message-ordered", 0),
		];
		const prepared = await prepareRecovery();

		const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
		expect(executePersistedCalls).toBe(1);
		expect(resumedAgentCalls).toHaveLength(0);
		expect(continueNarratorCalls).toBe(0);

		releaseWrite();
		await Bun.sleep(0);
		expect(resumedAgentCalls).toHaveLength(1);
		await recovery?.completion;
		expect(continueNarratorCalls).toBe(1);
		expect(
			continuationRows.every(
				(row) => row.payloadJson?.recoveryPhase === "owner_continuation_started",
			),
		).toBe(true);
	});

	test("writes a missing background start result and runs Write without waiting for terminal state", async () => {
		loadMode = "idle";
		let finishBackground = (_value: string) => {};
		resumedAgentCompletion = new Promise<string>((resolve) => {
			finishBackground = resolve;
		});
		let markWriteStarted = () => {};
		const writeStarted = new Promise<void>((resolve) => {
			markWriteStarted = resolve;
		});
		executePersistedToolCallImpl = async () => {
			markWriteStarted();
			return { ok: true, shouldContinue: true };
		};
		const backgroundAgent = continuationRecord("tool-background-missing-start", "owner", {
			kind: "background_agent",
			state: "waiting",
			payloadJson: {
				backgroundTaskId: "child-background",
				backgroundTaskAlias: "background-worker",
				subagentId: "child-background",
			},
		});
		const write = continuationRecord("tool-after-background", "owner", { state: "waiting" });
		toolCallResults.set(backgroundAgent.toolCallId, {
			id: backgroundAgent.toolCallId,
			toolUseId: "tool-use-background",
			messageId: "message-background-write",
			status: "running",
			outputJson: null,
		});
		continuationRows = [backgroundAgent, write];
		recoveryQueue = [
			recoveryItem(backgroundAgent, "message-background-write", 0),
			recoveryItem(write, "message-background-write", 1),
		];
		const prepared = await prepareRecovery();

		const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
		await expect(
			Promise.race([
				writeStarted.then(() => "started" as const),
				new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
			]),
		).resolves.toBe("started");
		await expect(
			Promise.race([
				recovery?.completion.then(() => "completed" as const),
				new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
			]),
		).resolves.toBe("completed");

		expect(resumedAgentCalls).toHaveLength(1);
		expect(executePersistedCalls).toBe(1);
		expect(updatedToolResults).toHaveLength(1);
		expect(updatedToolResults[0]?.args[1] as Record<string, unknown>).toMatchObject({
			output:
				'<background_task_id>background-worker</background_task_id>\n\nBackground task started. Use Await({ type: "agent", id }) with this ID to get results, or Send({ id, message }) to continue.',
			status: "success",
		});
		expect(
			continuationRows.every(
				(row) => row.payloadJson?.recoveryPhase === "owner_continuation_started",
			),
		).toBe(true);
		finishBackground("<subagent_id>child-background</subagent_id>\n\ndone");
	});

	test("does not rewrite an existing background Agent start ToolResult", async () => {
		let finishBackground = (_value: string) => {};
		resumedAgentCompletion = new Promise<string>((resolve) => {
			finishBackground = resolve;
		});
		const output =
			'<background_task_id>background-worker</background_task_id>\n\nBackground task started. Use Await({ type: "agent", id }) with this ID to get results, or Send({ id, message }) to continue.';
		const backgroundAgent = continuationRecord("tool-background-existing-start", "owner", {
			kind: "background_agent",
			state: "waiting",
			payloadJson: {
				backgroundTaskId: "child-background",
				backgroundTaskAlias: "background-worker",
				subagentId: "child-background",
			},
		});
		toolCallResults.set(backgroundAgent.toolCallId, {
			id: backgroundAgent.toolCallId,
			toolUseId: "tool-use-background-existing",
			messageId: "message-background-existing",
			status: "success",
			outputJson: {
				_text: output,
				_metadata: {
					kind: "agent",
					backgroundTaskId: "child-background",
					subagentId: "child-background",
					status: "running",
				},
			},
		});
		continuationRows = [backgroundAgent];
		recoveryQueue = [recoveryItem(backgroundAgent, "message-background-existing", 0)];
		const prepared = await prepareRecovery();

		const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
		await expect(
			Promise.race([
				recovery?.completion.then(() => "completed" as const),
				new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
			]),
		).resolves.toBe("completed");

		expect(updatedToolResults).toHaveLength(0);
		expect(continuationRows[0]?.payloadJson?.recoveryPhase).toBe("owner_continuation_started");
		finishBackground("<subagent_id>child-background</subagent_id>\n\ndone");
	});

	test("preserves an explicit Agent timeout as an absolute execution deadline", () => {
		const startedAt = Date.parse("2026-07-20T12:00:00.000Z");
		const resolved = resolveAgentExecutionDeadline({
			toolInput: { timeout: 30_000 },
			startedAt,
		});

		expect(resolved).toEqual({
			executionDeadlineAt: "2026-07-20T12:00:30.000Z",
			executionTimeoutMs: 30_000,
		});
		expect(
			resolveAgentExecutionDeadline({
				runtimeDeadlineAt: "2026-07-20T12:00:12.000Z",
				runtimeTimeoutMs: 30_000,
				toolInput: { timeout: 30_000 },
				startedAt,
			}),
		).toEqual({
			executionDeadlineAt: "2026-07-20T12:00:12.000Z",
			executionTimeoutMs: 30_000,
		});
	});

	test("passes only the remaining Agent deadline to the continued runner", async () => {
		loadMode = "idle";
		const deadlineAt = new Date(Date.now() + 10_000).toISOString();
		const record = continuationRecord("tool-agent-deadline", "owner", {
			kind: "foreground_agent",
			state: "waiting",
			payloadJson: {
				subagentId: "child-deadline",
				executionDeadlineAt: deadlineAt,
				executionTimeoutMs: 30_000,
			},
		});
		continuationRows = [record];
		recoveryQueue = [recoveryItem(record, "message-agent-deadline", 0)];
		const prepared = await prepareRecovery();

		const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
		expect(resumedAgentCalls).toHaveLength(1);
		const remaining = resumedAgentCalls[0]?.timeoutMs as number;
		expect(remaining).toBeGreaterThan(0);
		expect(remaining).toBeLessThanOrEqual(10_000);
		expect(resumedAgentCalls[0]).toMatchObject({
			executionDeadlineAt: deadlineAt,
			executionTimeoutMs: 30_000,
		});
		await recovery?.completion;
	});

	test("parent interrupt reaches recovered foreground Agent and Await", async () => {
		loadMode = "idle";
		let finishAgent = (_value: string) => {};
		resumedAgentCompletion = new Promise<string>((resolve) => {
			finishAgent = resolve;
		});
		let finishAwait = (_value: Record<string, unknown>) => {};
		awaitAgentResult = new Promise<Record<string, unknown>>((resolve) => {
			finishAwait = resolve;
		});
		const agent = continuationRecord("tool-interrupt-agent", "owner", {
			kind: "foreground_agent",
			state: "waiting",
			payloadJson: { subagentId: "child-interrupt" },
		});
		const awaitRecord = continuationRecord("tool-interrupt-await", "owner", {
			kind: "await_agent",
			state: "waiting",
			payloadJson: {
				targetId: "child-interrupt",
				awaitDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
			},
		});
		continuationRows = [agent, awaitRecord];
		recoveryQueue = [
			recoveryItem(agent, "message-interrupt", 0),
			recoveryItem(awaitRecord, "message-interrupt", 1),
		];
		const prepared = await prepareRecovery();

		const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
		expect(resumedAgentCalls).toHaveLength(1);
		expect(awaitAgentCalls).toHaveLength(1);
		const agentSignal = resumedAgentCalls[0]?.signal as AbortSignal;
		const awaitSignal = awaitAgentCalls[0]?.signal as AbortSignal;
		expect(agentSignal.aborted).toBe(false);
		expect(awaitSignal.aborted).toBe(false);

		expect(realNarratorSessionModule.interruptNarrator("owner")).toBe(true);
		expect(agentSignal.aborted).toBe(true);
		expect(awaitSignal.aborted).toBe(true);
		finishAgent("<subagent_id>child-interrupt</subagent_id>\n\ninterrupted");
		finishAwait({ id: "child-interrupt", status: "aborted", formatted: "interrupted" });
		await recovery?.completion;
		expect(continuationRows.every((row) => row.state === "cancelled")).toBe(true);
		expect(continueNarratorCalls).toBe(0);
	});

	test("parent interrupt retires pure background parent delivery without aborting its runner", async () => {
		loadMode = "idle";
		let finishBackground = (_value: string) => {};
		let backgroundSettled = false;
		resumedAgentCompletion = new Promise<string>((resolve) => {
			finishBackground = resolve;
		}).then((value) => {
			backgroundSettled = true;
			return value;
		});
		const background = continuationRecord("tool-interrupt-background-only", "owner", {
			kind: "background_agent",
			state: "waiting",
			payloadJson: {
				backgroundTaskId: "background-only-task",
				backgroundTaskAlias: "background-only",
				subagentId: "background-only-child",
			},
		});
		toolCallResults.set(background.toolCallId, {
			id: background.toolCallId,
			toolUseId: "tool-use-interrupt-background-only",
			messageId: "message-interrupt-background-only",
			status: "success",
			outputJson: {
				_text:
					"<background_task_id>background-only</background_task_id>\n\nBackground task started.",
			},
		});
		continuationRows = [background];
		recoveryQueue = [recoveryItem(background, "message-interrupt-background-only", 0)];
		let releaseResultWrite = () => {};
		const resultWriteGate = new Promise<void>((resolve) => {
			releaseResultWrite = resolve;
		});
		let markResultWriteReached = () => {};
		const resultWriteReached = new Promise<void>((resolve) => {
			markResultWriteReached = resolve;
		});
		beforeMarkResultWritten = async (toolCallId) => {
			if (toolCallId !== background.toolCallId) return;
			markResultWriteReached();
			await resultWriteGate;
		};
		let releaseCancellation = () => {};
		cancelInterruptibleGate = new Promise<void>((resolve) => {
			releaseCancellation = resolve;
		});
		let cancellationStarted = () => {};
		const cancellationStart = new Promise<void>((resolve) => {
			cancellationStarted = resolve;
		});
		markCancelInterruptibleStarted = cancellationStarted;
		const prepared = await prepareRecovery();

		const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
		await resultWriteReached;
		const backgroundSignal = resumedAgentCalls[0]?.signal as AbortSignal;
		expect(backgroundSignal.aborted).toBe(false);
		expect(realNarratorSessionModule.interruptNarrator("owner")).toBe(true);
		await cancellationStart;
		expect(backgroundSignal.aborted).toBe(false);
		releaseCancellation();
		await Bun.sleep(0);
		expect(continuationRows[0]?.state).toBe("cancelled");
		releaseResultWrite();
		await recovery?.completion;

		expect(backgroundSignal.aborted).toBe(false);
		expect(backgroundSettled).toBe(false);
		expect(continuationRows[0]?.state).toBe("cancelled");
		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).toBeNull();
		finishBackground("<subagent_id>background-only-child</subagent_id>\n\ndone");
		await resumedAgentCompletion;
	});

	test("parent interrupt resolves mixed background delivery without failing recovery", async () => {
		loadMode = "idle";
		let finishBackground = (_value: string) => {};
		let backgroundSettled = false;
		resumedAgentCompletion = new Promise<string>((resolve) => {
			finishBackground = resolve;
		}).then((value) => {
			backgroundSettled = true;
			return value;
		});
		let finishAwait = (_value: Record<string, unknown>) => {};
		awaitAgentResult = new Promise<Record<string, unknown>>((resolve) => {
			finishAwait = resolve;
		});
		const background = continuationRecord("tool-interrupt-background-mixed", "owner", {
			kind: "background_agent",
			state: "waiting",
			payloadJson: {
				backgroundTaskId: "background-mixed-task",
				backgroundTaskAlias: "background-mixed",
				subagentId: "background-mixed-child",
			},
		});
		const awaitRecord = continuationRecord("tool-interrupt-await-mixed", "owner", {
			kind: "await_agent",
			state: "waiting",
			payloadJson: {
				targetId: "foreground-mixed-child",
				awaitDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
			},
		});
		toolCallResults.set(background.toolCallId, {
			id: background.toolCallId,
			toolUseId: "tool-use-interrupt-background-mixed",
			messageId: "message-interrupt-mixed",
			status: "success",
			outputJson: {
				_text:
					"<background_task_id>background-mixed</background_task_id>\n\nBackground task started.",
			},
		});
		continuationRows = [background, awaitRecord];
		recoveryQueue = [
			recoveryItem(background, "message-interrupt-mixed", 0),
			recoveryItem(awaitRecord, "message-interrupt-mixed", 1),
		];
		let releaseResultWrite = () => {};
		const resultWriteGate = new Promise<void>((resolve) => {
			releaseResultWrite = resolve;
		});
		let markResultWriteReached = () => {};
		const resultWriteReached = new Promise<void>((resolve) => {
			markResultWriteReached = resolve;
		});
		beforeMarkResultWritten = async (toolCallId) => {
			if (toolCallId !== background.toolCallId) return;
			markResultWriteReached();
			await resultWriteGate;
		};
		let releaseCancellation = () => {};
		cancelInterruptibleGate = new Promise<void>((resolve) => {
			releaseCancellation = resolve;
		});
		let cancellationStarted = () => {};
		const cancellationStart = new Promise<void>((resolve) => {
			cancellationStarted = resolve;
		});
		markCancelInterruptibleStarted = cancellationStarted;
		const prepared = await prepareRecovery();

		const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
		await resultWriteReached;
		expect(resumedAgentCalls).toHaveLength(1);
		expect(awaitAgentCalls).toHaveLength(1);
		const backgroundSignal = resumedAgentCalls[0]?.signal as AbortSignal;
		const awaitSignal = awaitAgentCalls[0]?.signal as AbortSignal;
		expect(realNarratorSessionModule.interruptNarrator("owner")).toBe(true);
		await cancellationStart;
		expect(backgroundSignal.aborted).toBe(false);
		expect(awaitSignal.aborted).toBe(true);
		releaseCancellation();
		await Bun.sleep(0);
		expect(continuationRows.every((row) => row.state === "cancelled")).toBe(true);
		finishAwait({ id: "foreground-mixed-child", status: "aborted", formatted: "interrupted" });
		releaseResultWrite();
		await recovery?.completion;

		expect(backgroundSignal.aborted).toBe(false);
		expect(backgroundSettled).toBe(false);
		expect(continuationRows.every((row) => row.state === "cancelled")).toBe(true);
		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).toBeNull();
		finishBackground("<subagent_id>background-mixed-child</subagent_id>\n\ndone");
		await resumedAgentCompletion;
	});

	test("recovered Await output matches the uninterrupted tool result shape", () => {
		expect(
			buildRecoveredAwaitToolOutput("worker", {
				id: "child-1",
				status: "completed",
				formatted: "Subagent child-1 completed.\n\nResult:\ndone",
			}),
		).toEqual({
			_text: "Subagent child-1 completed.\n\nResult:\ndone",
			_metadata: {
				kind: "await",
				awaitType: "agent",
				targetId: "worker",
				resolvedId: "child-1",
				subagentId: "child-1",
				status: "completed",
			},
		});
	});

	test("restores multi-target Send replies in original target order with equivalent output metadata", async () => {
		const snapshot = sendAwaitSnapshot({
			toolUseId: "send-multi-order",
			responders: ["responder-a", "responder-b"],
		});
		const waiting = realAgentCommunicationModule.restoreSendAwaitFromSnapshot(
			snapshot,
			new AbortController().signal,
		);
		await Bun.sleep(0);
		expect(
			realAgentReplyWaiterModule.resolvePendingAgentReply({
				fromNarratorId: "responder-b",
				toNarratorId: "owner",
				scope: snapshot.waiters[1].scope,
				replyTo: snapshot.waiters[1].requestId,
				message: "second target replied first",
			}),
		).toMatchObject({ matched: true });
		expect(
			realAgentReplyWaiterModule.resolvePendingAgentReply({
				fromNarratorId: "responder-a",
				toNarratorId: "owner",
				scope: snapshot.waiters[0].scope,
				replyTo: snapshot.waiters[0].requestId,
				message: "first target replied second",
			}),
		).toMatchObject({ matched: true });

		const result = await waiting;
		expect(result.targets.map((target) => target.id)).toEqual(["target-1", "target-2"]);
		expect(result.output.indexOf("first target replied second")).toBeLessThan(
			result.output.indexOf("second target replied first"),
		);
		expect(buildRecoveredSendAwaitToolOutput(snapshot, result)).toEqual({
			_text: result.output,
			_metadata: {
				kind: "send",
				targets: result.targets,
				doInterrupt: false,
				await: true,
			},
		});
	});

	test("restored Send uses the original absolute deadline and never redelivers its message", async () => {
		const snapshot = sendAwaitSnapshot({
			toolUseId: "send-expired-deadline",
			responders: ["deadline-target"],
			deadlineAt: new Date(Date.now() - 1).toISOString(),
		});
		const result = await realAgentCommunicationModule.restoreSendAwaitFromSnapshot(
			snapshot,
			new AbortController().signal,
		);

		expect(result.targets).toEqual([
			expect.objectContaining({ id: "target-1", status: "timeout", awaited: true }),
		]);
		expect(result.output).toContain("Timed out waiting for a Send reply");
		// Recovery consumes only the restored waiter. A late reply sees an expired request,
		// proving no second Send delivery/request id was created.
		expect(
			realAgentReplyWaiterModule.resolvePendingAgentReply({
				fromNarratorId: "deadline-target",
				toNarratorId: "owner",
				scope: snapshot.waiters[0].scope,
				replyTo: snapshot.waiters[0].requestId,
				message: "late",
			}),
		).toMatchObject({ matched: false, error: expect.stringContaining("expired") });
	});

	for (const oldProcessStatus of ["completed", "timeout", "aborted"] as const) {
		test(`uses an old-process ${oldProcessStatus} ToolResult that arrives after Send recovery mounts`, async () => {
			loadMode = "idle";
			const snapshot = sendAwaitSnapshot({
				toolUseId: `send-old-process-${oldProcessStatus}`,
				responders: ["old-process-target"],
			});
			const sendRecord = continuationRecord(`tool-old-process-${oldProcessStatus}`, "owner", {
				kind: "send_await",
				state: "waiting",
				payloadJson: { sendAwait: snapshot },
			});
			toolCallResults.set(sendRecord.toolCallId, {
				id: sendRecord.toolCallId,
				toolUseId: snapshot.toolUseId,
				messageId: `message-old-process-${oldProcessStatus}`,
				status: "running",
				outputJson: null,
			});
			continuationRows = [sendRecord];
			recoveryQueue = [recoveryItem(sendRecord, `message-old-process-${oldProcessStatus}`, 0)];
			const prepared = await prepareRecovery();

			const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
			expect(
				realAgentReplyWaiterModule.hasPendingAgentReply(
					"owner",
					"old-process-target",
					snapshot.waiters[0].scope,
				),
			).toBe(true);
			toolCallResults.set(sendRecord.toolCallId, {
				...(toolCallResults.get(sendRecord.toolCallId) as NonNullable<
					ReturnType<typeof toolCallResults.get>
				>),
				status: "success",
				outputJson: {
					_text: `old process settled: ${oldProcessStatus}`,
					_metadata: {
						kind: "send",
						targets: [{ id: "target-1", status: oldProcessStatus, awaited: true }],
						await: true,
					},
				},
			});

			await recovery?.completion;
			expect(updatedToolResults).toHaveLength(0);
			expect(continuationRows[0]).toMatchObject({
				state: "completed",
				payloadJson: { recoveryPhase: "owner_continuation_started" },
			});
			expect(
				realAgentReplyWaiterModule.hasPendingAgentReply(
					"owner",
					"old-process-target",
					snapshot.waiters[0].scope,
				),
			).toBe(false);
		});
	}

	test("preserves an old-process terminal Send result written after the final active read", async () => {
		loadMode = "idle";
		const snapshot = sendAwaitSnapshot({
			toolUseId: "send-terminal-write-race",
			responders: ["terminal-race-target"],
		});
		const sendRecord = continuationRecord("tool-terminal-write-race", "owner", {
			kind: "send_await",
			state: "waiting",
			payloadJson: { sendAwait: snapshot },
		});
		toolCallResults.set(sendRecord.toolCallId, {
			id: sendRecord.toolCallId,
			toolUseId: snapshot.toolUseId,
			messageId: "message-terminal-write-race",
			status: "running",
			outputJson: null,
		});
		continuationRows = [sendRecord];
		recoveryQueue = [recoveryItem(sendRecord, "message-terminal-write-race", 0)];
		beforeConditionalToolResultWrite = () => {
			beforeConditionalToolResultWrite = null;
			const current = toolCallResults.get(sendRecord.toolCallId);
			if (!current) throw new Error("missing raced Send tool call");
			toolCallResults.set(sendRecord.toolCallId, {
				...current,
				status: "success",
				outputJson: {
					_text: "old process terminal reply wins",
					_metadata: {
						kind: "send",
						targets: [{ id: "target-1", status: "completed", awaited: true }],
						await: true,
					},
				},
			});
		};
		const prepared = await prepareRecovery();

		const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
		expect(
			realAgentReplyWaiterModule.resolvePendingAgentReply({
				fromNarratorId: "terminal-race-target",
				toNarratorId: "owner",
				scope: snapshot.waiters[0].scope,
				replyTo: snapshot.waiters[0].requestId,
				message: "replacement process reply",
			}),
		).toMatchObject({ matched: true });
		await recovery?.completion;

		expect(updatedToolResults).toHaveLength(0);
		expect(toolCallResults.get(sendRecord.toolCallId)?.outputJson).toMatchObject({
			_text: "old process terminal reply wins",
			_metadata: { targets: [{ status: "completed" }] },
		});
		expect(continuationRows[0]).toMatchObject({
			state: "completed",
			payloadJson: { recoveryPhase: "owner_continuation_started" },
		});
	});

	test("globally mounts Send waiters before resuming any Agent continuation", async () => {
		loadMode = "idle";
		const snapshot = sendAwaitSnapshot({
			toolUseId: "send-priority-use",
			responders: ["reply-target"],
		});
		expectedPendingReplyProbe = {
			requesterId: "owner",
			responderId: "reply-target",
			scope: snapshot.waiters[0].scope,
		};
		const sendRecord = continuationRecord("tool-send-priority", "owner", {
			kind: "send_await",
			state: "waiting",
			payloadJson: { sendAwait: snapshot },
		});
		const agentRecord = continuationRecord("tool-agent-after-send-mount", "owner", {
			kind: "foreground_agent",
			state: "waiting",
			payloadJson: { subagentId: "agent-after-send-mount" },
		});
		toolCallResults.set(sendRecord.toolCallId, {
			id: sendRecord.toolCallId,
			toolUseId: snapshot.toolUseId,
			messageId: "message-send-priority",
			status: "running",
			outputJson: null,
		});
		continuationRows = [agentRecord, sendRecord];
		recoveryQueue = [
			recoveryItem(agentRecord, "message-agent-priority", 0),
			recoveryItem(sendRecord, "message-send-priority", 0),
		];
		const prepared = await prepareRecovery();

		const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
		expect(replyWaiterPresenceAtAgentResume).toEqual([true]);
		expect(
			realAgentReplyWaiterModule.resolvePendingAgentReply({
				fromNarratorId: "reply-target",
				toNarratorId: "owner",
				scope: snapshot.waiters[0].scope,
				replyTo: snapshot.waiters[0].requestId,
				message: "mounted before agent",
			}),
		).toMatchObject({ matched: true });
		await recovery?.completion;
		expect(updatedToolResults).toContainEqual({
			args: expect.arrayContaining([
				snapshot.toolUseId,
				expect.objectContaining({
					status: "success",
					output: expect.objectContaining({
						_metadata: expect.objectContaining({ kind: "send", await: true }),
					}),
				}),
			]),
		});
	});

	test("parent interrupt aborts recovered Send wait without stopping its target semantics", async () => {
		loadMode = "idle";
		const snapshot = sendAwaitSnapshot({
			toolUseId: "send-parent-interrupt-use",
			responders: ["still-running-target"],
		});
		const sendRecord = continuationRecord("tool-send-parent-interrupt", "owner", {
			kind: "send_await",
			state: "waiting",
			payloadJson: { sendAwait: snapshot },
		});
		toolCallResults.set(sendRecord.toolCallId, {
			id: sendRecord.toolCallId,
			toolUseId: snapshot.toolUseId,
			messageId: "message-send-parent-interrupt",
			status: "running",
			outputJson: null,
		});
		continuationRows = [sendRecord];
		recoveryQueue = [recoveryItem(sendRecord, "message-send-parent-interrupt", 0)];
		let releaseCancellation = () => {};
		cancelInterruptibleGate = new Promise<void>((resolve) => {
			releaseCancellation = resolve;
		});
		let cancellationStarted = () => {};
		const cancellationStart = new Promise<void>((resolve) => {
			cancellationStarted = resolve;
		});
		markCancelInterruptibleStarted = cancellationStarted;
		const prepared = await prepareRecovery();

		const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
		expect(
			realAgentReplyWaiterModule.hasPendingAgentReply(
				"owner",
				"still-running-target",
				snapshot.waiters[0].scope,
			),
		).toBe(true);
		expect(realNarratorSessionModule.interruptNarrator("owner")).toBe(true);
		await cancellationStart;
		await expect(
			Promise.race([
				recovery?.completion.then(() => "completed" as const),
				new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20)),
			]),
		).resolves.toBe("pending");
		releaseCancellation();
		await recovery?.completion;
		expect(continuationRows[0]?.state).toBe("cancelled");
		const sendWrites = updatedToolResults
			.map(({ args }) => args[1] as { output?: { _metadata?: { targets?: unknown[] } } })
			.filter((result) => result.output?._metadata?.targets);
		expect(sendWrites.at(-1)?.output?._metadata?.targets).toEqual([
			expect.objectContaining({ id: "target-1", status: "aborted", awaited: true }),
		]);
		expect(resumedAgentCalls).toHaveLength(0);
	});

	test("mounts pending permission recovery without waiting for the interactive promise", async () => {
		loadMode = "idle";
		const record = continuationRecord("tool-permission", "owner", {
			kind: "pending_permission",
			state: "waiting",
			payloadJson: { permissionMode: "normal" },
		});
		continuationRows = [record];
		recoveryQueue = [recoveryItem(record, "message-permission", 0)];
		let releaseExecution = () => {};
		const executionGate = new Promise<void>((resolve) => {
			releaseExecution = resolve;
		});
		let markExecutionStarted = () => {};
		const executionStarted = new Promise<void>((resolve) => {
			markExecutionStarted = resolve;
		});
		executePersistedToolCallImpl = async () => {
			markExecutionStarted();
			await executionGate;
			return { ok: true, shouldContinue: true };
		};
		const prepared = await prepareRecovery();

		const mounted = await Promise.race([
			restoreNarratorsAfterPlannedUpdate(prepared),
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
		]);

		expect(mounted).not.toBe("timeout");
		await executionStarted;
		expect(executePersistedCalls).toBe(1);
		releaseExecution();
		if (mounted !== "timeout") await mounted?.completion;
		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).toBeNull();
	});

	test("joins a delayed finalizer when interrupt lands after owner pending", async () => {
		loadMode = "idle";
		const record = continuationRecord("tool-owner-pending-interrupt", "owner", {
			state: "completed",
			payloadJson: { recoveryPhase: "result_written" },
		});
		continuationRows = [record];
		recoveryQueue = [recoveryItem(record, "message-owner-pending-interrupt", 0)];
		let releaseCancellation = () => {};
		cancelInterruptibleGate = new Promise<void>((resolve) => {
			releaseCancellation = resolve;
		});
		let cancellationStarted = () => {};
		const cancellationStart = new Promise<void>((resolve) => {
			cancellationStarted = resolve;
		});
		markCancelInterruptibleStarted = cancellationStarted;
		afterOwnerPending = () => {
			afterOwnerPending = null;
			expect(realNarratorSessionModule.interruptNarrator("owner")).toBe(true);
		};
		const prepared = await prepareRecovery();

		const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
		await cancellationStart;
		expect(continueNarratorCalls).toBe(0);
		expect(ownerStartedCalls).toBe(0);
		await expect(
			Promise.race([
				recovery?.completion.then(() => "completed" as const),
				new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20)),
			]),
		).resolves.toBe("pending");

		releaseCancellation();
		await recovery?.completion;
		expect(continuationRows[0]?.state).toBe("cancelled");
		expect(continueNarratorCalls).toBe(0);
		expect(ownerStartedCalls).toBe(0);
		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).toBeNull();
	});

	test("aborts an owner loop interrupted concurrently with continue without marking it started", async () => {
		loadMode = "idle";
		const record = continuationRecord("tool-owner-start-interrupt", "owner", {
			state: "completed",
			payloadJson: { recoveryPhase: "result_written" },
		});
		continuationRows = [record];
		recoveryQueue = [recoveryItem(record, "message-owner-start-interrupt", 0)];
		let interruptResult = false;
		continueNarratorImpl = async () => {
			interruptResult = realNarratorSessionModule.interruptNarrator("owner");
			return { ok: true };
		};
		const prepared = await prepareRecovery();

		const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
		await recovery?.completion;

		expect(interruptResult).toBe(true);
		expect(continueNarratorCalls).toBe(1);
		expect(abortActiveRecoveryLoopCalls).toBe(1);
		expect(ownerStartedCalls).toBe(0);
		expect(continuationRows[0]?.state).toBe("cancelled");
		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).toBeNull();
	});

	test("retries owner delivery after restart without re-executing a written result", async () => {
		loadMode = "idle";
		const record = continuationRecord("tool-written", "owner", {
			state: "resuming",
			claimToken: "old-claim",
			payloadJson: { recoveryPhase: "result_written" },
		});
		continuationRows = [record];
		recoveryQueue = [recoveryItem(record, "message-written", 0)];
		const prepared = await prepareRecovery();

		const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
		await recovery?.completion;

		expect(executePersistedCalls).toBe(0);
		expect(continueNarratorCalls).toBe(1);
		expect(continuationRows[0]?.payloadJson?.recoveryPhase).toBe("owner_continuation_started");
		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).toBeNull();
	});

	test("treats continueNarrator false as mounted only when the owner is already running", async () => {
		loadMode = "working";
		continueNarratorResult = { ok: false };
		const record = continuationRecord("tool-mounted", "owner", {
			state: "completed",
			payloadJson: { recoveryPhase: "result_written" },
		});
		continuationRows = [record];
		recoveryQueue = [recoveryItem(record, "message-mounted", 0)];
		const prepared = await prepareRecovery();

		const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
		await recovery?.completion;

		expect(continuationRows[0]?.payloadJson?.recoveryPhase).toBe("owner_continuation_started");
		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).toBeNull();
	});

	test("keeps the manifest when owner continuation never starts", async () => {
		loadMode = "idle";
		continueNarratorResult = { ok: false };
		const record = continuationRecord("tool-undelivered", "owner", {
			state: "completed",
			payloadJson: { recoveryPhase: "result_written" },
		});
		continuationRows = [record];
		recoveryQueue = [recoveryItem(record, "message-undelivered", 0)];
		const prepared = await prepareRecovery();

		const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
		await expect(recovery?.completion).rejects.toThrow("did not start");

		expect(continuationRows[0]?.payloadJson?.recoveryPhase).toBe("owner_continuation_pending");
		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).not.toBeNull();
	});

	test("renews a claim and stops scheduling renewals after stop", async () => {
		const abortController = new AbortController();
		const renewal = startContinuationClaimRenewal("tool-renew", "claim-token", abortController, {
			leaseMs: 100,
			intervalMs: 10,
		});
		await new Promise((resolve) => setTimeout(resolve, 35));
		expect(renewCalls).toBeGreaterThanOrEqual(2);
		expect(abortController.signal.aborted).toBe(false);

		renewal.stop();
		const callsAfterStop = renewCalls;
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(renewCalls).toBe(callsAfterStop);
	});

	test("aborts an in-flight recovery when claim renewal loses CAS ownership", async () => {
		renewClaimSucceeds = false;
		const abortController = new AbortController();
		const renewal = startContinuationClaimRenewal("tool-lost", "claim-token", abortController, {
			leaseMs: 100,
			intervalMs: 5,
		});
		const inFlight = new Promise<void>((_resolve, reject) => {
			abortController.signal.addEventListener(
				"abort",
				() => reject(abortController.signal.reason),
				{ once: true },
			);
		});

		await expect(renewal.run(inFlight)).rejects.toThrow("Continuation claim was lost");
		expect(abortController.signal.aborted).toBe(true);
		renewal.stop();
	});

	test("reports a mount failure once instead of leaking an unhandled rejection", async () => {
		// `mounted` and `completion` are created together and share the same rejection. When mount
		// fails, the caller only ever awaits `mounted`, so `completion` must still be observed
		// internally — otherwise the identical failure resurfaces as a process-level unhandled
		// rejection and looks like a second, unrelated fault.
		const record = continuationRecord("tool-mount-failure", "owner", { kind: "await_agent" });
		continuationRows = [record];
		// An Await continuation with no targetId cannot be restored, so its run rejects.
		recoveryQueue = [recoveryItem(record, "message-mount-failure", 0)];
		const prepared = await prepareRecovery();

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			await expect(restoreNarratorsAfterPlannedUpdate(prepared)).rejects.toThrow(
				"missing targetId",
			);
			// Give the rejection a chance to be reported if nothing handled it.
			await Bun.sleep(10);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		expect(unhandled).toEqual([]);
	});
});
