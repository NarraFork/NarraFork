import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import { NotFoundError } from "../../lib/errors";
import { runtimePublication } from "../agent-runtime/publication";
import {
	invalidateRecoveryTarget,
	releaseRecoveryHandoff,
	reserveRecoveryHandoff,
	resetRecoveryHandoffForTests,
	waitForRecoveryHandoffReady,
} from "../recovery-handoff";

const realNarratorServiceModule = { ...(await import("../narrator-service")) };
const realNarratorPersistenceModule = { ...(await import("../narrator-persistence")) };
const realContinuationModule = { ...(await import("../tool-continuation-service")) };
const realNarratorSessionModule = { ...(await import("../narrator-session")) };
const realAgentCommunicationModule = { ...(await import("../agent-communication")) };
const updateCoordinator = await import("../update-coordinator");
const { setObservedRestartHandoffForTests } = await import("../../lib/restart-handoff");

/** Marker nonce every test manifest is bound to unless it is exercising a mismatch. */
const HANDOFF_NONCE = "test-handoff-nonce";

/** Present this process as the replacement spawned by the manifest's update attempt. */
function actAsReplacementProcess(markerNonce: string | undefined = HANDOFF_NONCE): void {
	setObservedRestartHandoffForTests(markerNonce ? { markerNonce } : {});
}

let loadMode: "missing" | "transient" | "idle" | "working" | "archived" = "transient";
let requestedProtectionEpoch: import("../tool-continuation-service").EpochScope | null = null;
let renewCalls = 0;
let renewClaimSucceeds = true;
let executePersistedCalls = 0;
let continueNarratorCalls = 0;
let cancelInterruptibleGate: Promise<void> | null = null;
let markCancelInterruptibleStarted: (() => void) | null = null;
let continueNarratorResult: { ok: boolean } = { ok: true };
let continueNarratorImpl: (() => Promise<{ ok: boolean }>) | null = null;
let useRealLegacyContinuation = false;
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
let onAwaitMounted: (() => void) | null = null;
const updatedToolResults: Array<{ args: unknown[] }> = [];
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
			// Real start admission resolves the narrator's DB root even when this test
			// replaces its service projection. Keep that fixture identity real as well.
			const now = new Date().toISOString();
			db.insert(narrators)
				.values({ id, type: "primary", variant: "primary", createdAt: now, updatedAt: now })
				.onConflictDoNothing()
				.run();
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
			updateEpoch: import("../tool-continuation-service").EpochScope,
			recoveryToken: string,
		) => {
			const updated = continuationRows
				.filter(
					(row) =>
						row.narratorId === narratorId &&
						(typeof updateEpoch === "string"
							? row.updateEpoch === updateEpoch
							: updateEpoch.includes(row.updateEpoch)) &&
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
			updateEpoch: import("../tool-continuation-service").EpochScope,
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
						(typeof updateEpoch === "string"
							? row.updateEpoch === updateEpoch
							: updateEpoch.includes(row.updateEpoch)) &&
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
	// The one recovery entry. A recovering Agent continuation re-enters its delegated
	// session's own run through it exactly like an owner continuation does; the test
	// only tells them apart by which session is continued.
	continueNarrator: async (
		narratorId: string,
		locale?: string,
		_reply?: boolean,
		_user?: string | null,
		run?: Record<string, unknown>,
	) => {
		if (continuationRows.some((row) => row.payloadJson?.subagentId === narratorId)) {
			resumedAgentCalls.push({ narratorId, locale, ...run });
			return { ok: true, terminal: resumedAgentCompletion };
		}
		continueNarratorCalls += 1;
		return continueNarratorImpl ? continueNarratorImpl() : continueNarratorResult;
	},
	continueNarratorAfterPlannedUpdate: async (
		...args: Parameters<typeof realNarratorSessionModule.continueNarratorAfterPlannedUpdate>
	) => {
		continueNarratorCalls += 1;
		if (useRealLegacyContinuation)
			return realNarratorSessionModule.continueNarratorAfterPlannedUpdate(...args);
		return continueNarratorImpl ? continueNarratorImpl() : continueNarratorResult;
	},
	abortActiveNarratorLoopForPlannedUpdateRecovery: () => {
		abortActiveRecoveryLoopCalls += 1;
		return true;
	},
}));

let sendSubagentCalls = 0;
mock.module("../agent-communication", () => ({
	...realAgentCommunicationModule,
	sendSubagentMessageDetailed: async () => {
		sendSubagentCalls++;
		throw new Error("recovery must never re-send a message");
	},
	awaitAgentResultDetailed: async (input: Record<string, unknown>) => {
		awaitAgentCalls.push(input);
		onAwaitMounted?.();
		return awaitAgentResult;
	},
}));

const {
	buildRecoveredAwaitToolOutput,
	getPlannedUpdateStartupProtection,
	resolveAgentExecutionDeadline,
	restoreNarratorsAfterPlannedUpdate,
	runContinuationRecoveryGroups,
	startContinuationClaimRenewal,
} = await import("../update-recovery-service");
type ToolContinuationRecord = import("../tool-continuation-service").ToolContinuationRecord;
type ToolContinuationRecoveryItem =
	import("../tool-continuation-service").ToolContinuationRecoveryItem;

beforeAll(() => {
	updateCoordinator.resetUpdateCoordinationForTests();
});

afterEach(() => {
	resetRecoveryHandoffForTests();
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
	useRealLegacyContinuation = false;
	beforeConditionalToolResultWrite = null;
	beforeMarkResultWritten = null;
	afterOwnerPending = null;
	ownerStartedCalls = 0;
	abortActiveRecoveryLoopCalls = 0;
	executePersistedToolCallImpl = async () => ({ ok: true, shouldContinue: true });
	resumedAgentCalls.length = 0;
	awaitAgentCalls.length = 0;
	onAwaitMounted = null;
	sendSubagentCalls = 0;
	updatedToolResults.length = 0;
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
	cleanDb(sqlite);
});

afterAll(() => {
	mock.module("../narrator-service", () => realNarratorServiceModule);
	mock.module("../narrator-persistence", () => realNarratorPersistenceModule);
	mock.module("../tool-continuation-service", () => realContinuationModule);
	mock.module("../narrator-session", () => realNarratorSessionModule);
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

async function prepareRecovery(
	targets: import("../update-coordinator").NarratorRecoveryTarget[] = [],
	sources: import("../recovery-handoff").RecoverySource[] = [],
) {
	// These are current-protocol scheduling fixtures, not fabricated legacy proofs.
	// Persist their original run/slot and exact origin before simulating replacement.
	for (const item of recoveryQueue) {
		const record = item.record;
		if (record.kind !== "foreground_agent" && record.kind !== "background_agent") continue;
		const subagentId = record.payloadJson?.subagentId;
		if (typeof subagentId !== "string") continue;
		const now = new Date().toISOString();
		db.insert(narrators)
			.values({
				id: record.narratorId,
				type: "primary",
				variant: "primary",
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoNothing()
			.run();
		db.insert(narratorMessages)
			.values({
				id: item.messageId,
				narratorId: record.narratorId,
				role: "assistant",
				contentJson: [],
				createdAt: now,
			})
			.onConflictDoNothing()
			.run();
		db.insert(narratorMessageRefs)
			.values({
				id: `ref-${item.messageId}`,
				narratorId: record.narratorId,
				messageId: item.messageId,
				seq: 1,
			})
			.onConflictDoNothing()
			.run();
		db.insert(narratorToolCalls)
			.values({
				id: record.toolCallId,
				narratorId: record.narratorId,
				messageId: item.messageId,
				toolUseId: toolCallResults.get(record.toolCallId)?.toolUseId ?? record.toolCallId,
				toolName: "Agent",
				inputJson: item.input,
				status: "running",
				executionIdentityVersion: 1,
				executionAttempt: 1,
				executionStartedAt: now,
				createdAt: now,
			})
			.onConflictDoNothing()
			.run();
		db.insert(narrators)
			.values({
				id: subagentId,
				type: "subagent",
				variant: "subagent:general",
				parentNarratorId: record.narratorId,
				originToolCallId: record.toolCallId,
				subagentOriginKind: "tool",
				status: "working",
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoNothing()
			.run();
		const run = runtimePublication.startRun({
			narratorId: subagentId,
			binding: { deliverTo: { narratorId: record.narratorId, toolUseId: "test-tool-use" } },
		}).publication!;
		record.payloadJson = { ...record.payloadJson, logicalRunId: run.logicalRunId };
	}
	updateCoordinator.writePlannedUpdateRecoverySnapshot({
		version: 2,
		updateEpoch: "epoch",
		targetVersion: "4.0.0",
		capturedAt: new Date().toISOString(),
		handoffMarkerNonce: HANDOFF_NONCE,
		narrators: targets,
		...(sources.length ? { sources } : {}),
	});
	actAsReplacementProcess();
	return getPlannedUpdateStartupProtection();
}

function sendAwaitSnapshot(input: {
	toolUseId: string;
	requesterId?: string;
	responders: string[];
	deadlineAt?: string;
}): import("../legacy-send-await").LegacySendAwaitSnapshot & {
	waiters: Array<Record<string, unknown>>;
} {
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
	for (const kind of ["foreground_agent", "await_agent", "pending_permission"] as const) {
		test(`independent legacy narrator starts while ${kind} is unfinished`, async () => {
			loadMode = "idle";
			const gate = Promise.withResolvers<void>();
			const record = continuationRecord(`long-${kind}`, "owner", {
				kind,
				payloadJson: { subagentId: "child", targetId: "child" },
			});
			continuationRows = [record];
			recoveryQueue = [recoveryItem(record, "message", 0)];
			resumedAgentCompletion = gate.promise.then(() => "done");
			awaitAgentResult = gate.promise.then(() => ({
				id: "child",
				status: "completed",
				formatted: "done",
			}));
			executePersistedToolCallImpl = async () => {
				await gate.promise;
				return { ok: true, shouldContinue: true };
			};
			loadMode = "working";
			const startup = await prepareRecovery([{ narratorId: "legacy", locale: "en" }]);
			loadMode = "idle";
			if (kind === "await_agent") {
				const now = new Date().toISOString();
				db.insert(narrators)
					.values({
						id: "owner",
						type: "primary",
						variant: "primary",
						createdAt: now,
						updatedAt: now,
					})
					.run();
				db.insert(narratorMessages)
					.values({
						id: "message",
						narratorId: "owner",
						role: "assistant",
						contentJson: [],
						createdAt: now,
					})
					.run();
				db.insert(narratorToolCalls)
					.values({
						id: record.toolCallId,
						narratorId: "owner",
						messageId: "message",
						toolUseId: record.toolCallId,
						toolName: "Await",
						inputJson: {},
						status: "running",
						createdAt: now,
					})
					.run();
			}
			const mounting = restoreNarratorsAfterPlannedUpdate(startup);
			await new Promise((resolve) => setTimeout(resolve, 20));
			try {
				expect(continueNarratorCalls).toBe(1);
			} finally {
				gate.resolve();
				const recovery = await mounting;
				await recovery?.completion;
			}
		});
	}

	test("a failed queue mount does not skip independent legacy recovery", async () => {
		loadMode = "idle";
		const record = continuationRecord("bad-send", "owner", { kind: "send_await" });
		continuationRows = [record];
		recoveryQueue = [recoveryItem(record, "message", 0)];
		loadMode = "working";
		const startup = await prepareRecovery([{ narratorId: "legacy", locale: "en" }]);
		loadMode = "idle";
		await expect(restoreNarratorsAfterPlannedUpdate(startup)).rejects.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(continueNarratorCalls).toBe(1);
	});
	test("a sibling mount failure keeps a live owner's interrupt controller until it finishes", async () => {
		loadMode = "idle";
		const gate = Promise.withResolvers<void>();
		const live = continuationRecord("live-permission", "live", { kind: "pending_permission" });
		const failed = continuationRecord("bad-agent", "failed", { kind: "foreground_agent" });
		continuationRows = [live, failed];
		recoveryQueue = [
			recoveryItem(live, "live-message", 0),
			recoveryItem(failed, "failed-message", 0),
		];
		executePersistedToolCallImpl = async () => {
			await gate.promise;
			return { ok: true, shouldContinue: true };
		};
		const startup = await prepareRecovery();
		await expect(restoreNarratorsAfterPlannedUpdate(startup)).rejects.toThrow("missing subagentId");
		expect(executePersistedCalls).toBe(1);
		expect(realNarratorSessionModule.interruptNarrator("live")).toBe(true);
		gate.resolve();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(continuationRows.find((row) => row.toolCallId === live.toolCallId)?.state).toBe(
			"cancelled",
		);
	});

	test("a pending legacy cancellation during a handoff reservation cannot revive on release", async () => {
		loadMode = "working";
		const startup = await prepareRecovery([{ narratorId: "legacy", locale: "en" }]);
		loadMode = "idle";
		const ticket = reserveRecoveryHandoff();
		await waitForRecoveryHandoffReady(ticket);
		const handle = await restoreNarratorsAfterPlannedUpdate(startup);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(continueNarratorCalls).toBe(0);
		invalidateRecoveryTarget("legacy");
		releaseRecoveryHandoff(ticket);
		await handle?.completion;
		expect(continueNarratorCalls).toBe(0);
	});

	test("handoff does not wait for approval and pauses the old completion until cancellation", async () => {
		loadMode = "idle";
		const gate = Promise.withResolvers<void>();
		const record = continuationRecord("long-permission", "owner", { kind: "pending_permission" });
		continuationRows = [record];
		recoveryQueue = [recoveryItem(record, "message", 0)];
		executePersistedToolCallImpl = async () => {
			await gate.promise;
			return { ok: true, shouldContinue: true };
		};
		const startup = await prepareRecovery();
		const handle = await restoreNarratorsAfterPlannedUpdate(startup);
		updateCoordinator.scheduleUpdate(undefined, "system_shutdown", {
			supportedRecoveryManifestVersions: [1, 2, 3],
		});
		await updateCoordinator.waitForScheduledRecoveryHandoff();
		const next = updateCoordinator.writePreparedUpdateRecoverySnapshot();
		expect(next.sources?.map((source) => source.updateEpoch)).toEqual(["epoch"]);
		gate.resolve();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(continueNarratorCalls).toBe(0);
		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()?.updateEpoch).toBe(
			next.updateEpoch,
		);
		updateCoordinator.cancelScheduledUpdate();
		updateCoordinator.rollbackPreparedUpdateRecoverySnapshot(next.updateEpoch);
		updateCoordinator.releasePreparedUpdateRecoveryHandoff(next.updateEpoch);
		await handle?.completion;
		expect(continueNarratorCalls).toBe(1);
		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).toBeNull();
	});

	for (const kind of ["planned", "ordinary"] as const) {
		test(`current root legacy target outranks completed same-ID ${kind} source target`, async () => {
			loadMode = "working";
			const startup = await prepareRecovery(
				[{ narratorId: "legacy", locale: "en" }],
				[
					{
						updateEpoch: "old-source",
						kind,
						capturedAt: "2026-10-01T00:00:00.000Z",
						narrators: [{ narratorId: "legacy", locale: "en" }],
						pendingNarratorIds: [],
					},
				],
			);
			loadMode = "idle";
			const handle = await restoreNarratorsAfterPlannedUpdate(startup);
			await handle?.completion;
			expect(continueNarratorCalls).toBe(1);
		});
	}

	test("v3 combines root and source tools into one ordered message and one owner delivery", async () => {
		loadMode = "idle";
		const first = continuationRecord("root-write", "owner");
		const second = continuationRecord("source-write", "owner", { updateEpoch: "old-source" });
		continuationRows = [first, second];
		recoveryQueue = [
			recoveryItem(first, "same-message", 0),
			recoveryItem(second, "same-message", 1),
		];
		const gate = Promise.withResolvers<void>();
		const started: string[] = [];
		executePersistedToolCallImpl = async (input) => {
			started.push(input?.toolCallId ?? "missing");
			if (input?.toolCallId === first.toolCallId) await gate.promise;
			return { ok: true, shouldContinue: true };
		};
		const startup = await prepareRecovery(
			[],
			[
				{
					updateEpoch: "old-source",
					kind: "planned",
					capturedAt: "2026-10-01T00:00:00.000Z",
					narrators: [{ narratorId: "owner", locale: "en" }],
					pendingNarratorIds: ["owner"],
				},
			],
		);
		startup.protection = { ...startup.protection, narratorIds: new Set(["owner"]) };
		expect(requestedProtectionEpoch).toEqual(["epoch", "old-source"]);
		const handle = await restoreNarratorsAfterPlannedUpdate(startup);
		expect(started).toEqual(["root-write"]);
		expect(continueNarratorCalls).toBe(0);
		gate.resolve();
		await handle?.completion;
		expect(started).toEqual(["root-write", "source-write"]);
		expect(continueNarratorCalls).toBe(1);
		expect(ownerStartedCalls).toBe(1);
		expect(continuationRows.map((row) => row.updateEpoch)).toEqual(["epoch", "old-source"]);
		expect(new Set(continuationRows.map((row) => row.payloadJson?.recoveryToken)).size).toBe(1);
	});

	test("manual startup claims prepared work once and resumes through existing recovery", async () => {
		loadMode = "working";
		setObservedRestartHandoffForTests(null);
		updateCoordinator.writePlannedUpdateRecoverySnapshot({
			version: 2,
			updateEpoch: "manual-shutdown",
			capturedAt: new Date().toISOString(),
			resumeOnNextStartup: true,
			narrators: [{ narratorId: "n1", locale: "en" }],
		});
		const startup = await getPlannedUpdateStartupProtection();
		expect(startup.snapshot?.resumeOnNextStartup).toBe(true);
		expect(startup.protection).toBe(startupProtection);
		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).toMatchObject({
			evidenceOnly: true,
			updateEpoch: "manual-shutdown",
		});
		expect(
			updateCoordinator.consumePlannedUpdateRecoverySnapshot()?.resumeOnNextStartup,
		).toBeUndefined();
		const recovery = await restoreNarratorsAfterPlannedUpdate(startup);
		await recovery?.completion;
		expect(continueNarratorCalls).toBe(1);
		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).toBeNull();
		expect((await getPlannedUpdateStartupProtection()).snapshot).toBeNull();
	});

	test("failed manual recovery cannot authorize another ordinary boot", async () => {
		loadMode = "working";
		setObservedRestartHandoffForTests(null);
		continueNarratorImpl = async () => {
			throw new Error("recovery failed");
		};
		updateCoordinator.writePlannedUpdateRecoverySnapshot({
			version: 2,
			updateEpoch: "manual-failure",
			capturedAt: new Date().toISOString(),
			resumeOnNextStartup: true,
			narrators: [{ narratorId: "n1", locale: "en" }],
		});
		const startup = await getPlannedUpdateStartupProtection();
		const recovery = await restoreNarratorsAfterPlannedUpdate(startup);
		await expect(recovery?.completion).rejects.toThrow("Failed to mount");
		expect(continueNarratorCalls).toBe(1);
		expect((await getPlannedUpdateStartupProtection()).snapshot).toBeNull();
		expect(continueNarratorCalls).toBe(1);
	});
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

	test.each([
		true,
		false,
	])("publishes only owned targets before a bounded discovery read fails (owned=%s)", async (owned) => {
		updateCoordinator.writePlannedUpdateRecoverySnapshot({
			version: 2,
			updateEpoch: "discovery-failure",
			capturedAt: new Date().toISOString(),
			handoffMarkerNonce: HANDOFF_NONCE,
			narrators: [{ narratorId: "owner", locale: "en" }],
		});
		actAsReplacementProcess(owned ? HANDOFF_NONCE : "another-process");
		const { toolContinuationService: service } = await import("../tool-continuation-service");
		const read = spyOn(service, "listByEpoch").mockRejectedValue(
			new Error("Continuation recovery payload budget exceeded"),
		);
		const targets: string[] = [];
		try {
			const startup = getPlannedUpdateStartupProtection({
				onTargetsDiscovered: (ids) => targets.push(...ids),
			});
			if (owned) await expect(startup).rejects.toThrow("payload budget exceeded");
			else expect((await startup).snapshot).toBeNull();
			expect(targets).toEqual(owned ? ["owner"] : []);
		} finally {
			read.mockRestore();
		}
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

		// The next process is not this update's replacement, so the leftover cannot resume anything.
		resetRecoveryHandoffForTests();
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

describe("retired Send await checkpoints", () => {
	test("closes a legacy checkpoint with its recorded reply and never re-sends", async () => {
		loadMode = "idle";
		const snapshot = sendAwaitSnapshot({ toolUseId: "legacy-send", responders: ["a", "b"] });
		snapshot.prefixSections.push("Sent to sibling; message queued.");
		snapshot.prefixTargets.push({ id: "sibling", label: "sibling", status: "queued" });
		snapshot.waiters[0].result = { status: "replied", message: "the answer" };
		const record = continuationRecord("tool-legacy-send", "owner", {
			kind: "send_await",
			state: "waiting",
			payloadJson: { sendAwait: snapshot },
		});
		toolCallResults.set(record.toolCallId, {
			id: record.toolCallId,
			toolUseId: snapshot.toolUseId,
			messageId: "message-legacy-send",
			status: "running",
			outputJson: null,
		});
		continuationRows = [record];
		recoveryQueue = [recoveryItem(record, "message-legacy-send", 0)];
		const prepared = await prepareRecovery();

		const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
		await recovery?.completion;

		expect(updatedToolResults).toHaveLength(1);
		const [, result] = updatedToolResults[0].args as [
			string,
			{ output: { _text: string; _metadata: { targets: Array<{ id: string; status: string }> } } },
		];
		expect(result.output._text).toContain("Sent to sibling; message queued.");
		expect(result.output._text).toContain("the answer");
		expect(result.output._text).toContain("Send no longer waits for replies");
		expect(result.output._metadata.targets.map((target) => [target.id, target.status])).toEqual([
			["sibling", "queued"],
			["a", "completed"],
			["b", "queued"],
		]);
		expect(sendSubagentCalls).toBe(0);
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
		// Readiness and another close attempt do not wait for human approval or Agent completion.
		const recovery = await restoring;
		const ticket = reserveRecoveryHandoff();
		await waitForRecoveryHandoffReady(ticket);
		expect(awaitStarted).toBe(false);
		releaseRecoveryHandoff(ticket);
		releaseAgent();
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
		// Readiness and another close attempt do not wait for human approval or Agent completion.
		const recovery = await restoring;
		const ticket = reserveRecoveryHandoff();
		await waitForRecoveryHandoffReady(ticket);
		expect(awaitStarted).toBe(false);
		releaseRecoveryHandoff(ticket);
		releaseAgent();
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
				'<background_task_id>background-worker</background_task_id>\n\nBackground task started. Await({ type: "agent", id: "background-worker" })',
			status: "success",
		});
		expect(
			continuationRows.every(
				(row) => row.payloadJson?.recoveryPhase === "owner_continuation_started",
			),
		).toBe(true);
		finishBackground("<subagent_id>child-background</subagent_id>\n\ndone");
	});

	test.each([
		'Background task started. Use Await({ type: "agent", id }) with this ID to get results, or Send({ id, message }) to continue.',
		'Background task started. Await({ type: "agent", id: "background-worker" })',
	])("does not rewrite an existing background Agent start ToolResult: %s", async (receipt) => {
		let finishBackground = (_value: string) => {};
		resumedAgentCompletion = new Promise<string>((resolve) => {
			finishBackground = resolve;
		});
		const output = `<background_task_id>background-worker</background_task_id>\n\n${receipt}`;
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

	test.each([
		true,
		false,
	])("background recovery resumes only a severed foreground owner (severed=%s)", async (severed) => {
		loadMode = severed ? "working" : "idle";
		const childFinished = Promise.withResolvers<string>();
		resumedAgentCompletion = childFinished.promise;
		const record = continuationRecord("background-only", "owner", {
			kind: "background_agent",
			payloadJson: { subagentId: "background-child", backgroundTaskId: "background-child" },
		});
		toolCallResults.set(record.toolCallId, {
			id: record.toolCallId,
			toolUseId: record.toolCallId,
			messageId: "background-message",
			status: "running",
			outputJson: null,
		});
		continuationRows = [record];
		recoveryQueue = [recoveryItem(record, "background-message", 0)];
		const prepared = await prepareRecovery([{ narratorId: "owner", locale: "en" }]);
		prepared.protection = {
			...prepared.protection,
			narratorIds: new Set(["owner", "background-child"]),
		};
		loadMode = "idle";
		try {
			const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
			await recovery?.completion;
			expect(resumedAgentCalls).toHaveLength(1);
			expect(continueNarratorCalls).toBe(severed ? 1 : 0);
			expect(continuationRows[0]?.payloadJson?.recoveryPhase).toBe("owner_continuation_started");
		} finally {
			childFinished.resolve("done");
		}
	});

	async function prepareBackgroundOwner() {
		sqlite
			.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
			.run("acl-user", "acl-user", "unused", new Date().toISOString());
		loadMode = "working";
		const childFinished = Promise.withResolvers<string>();
		resumedAgentCompletion = childFinished.promise;
		const record = continuationRecord("background-race", "owner", {
			kind: "background_agent",
			payloadJson: { subagentId: "background-child", backgroundTaskId: "background-child" },
		});
		toolCallResults.set(record.toolCallId, {
			id: record.toolCallId,
			toolUseId: record.toolCallId,
			messageId: "background-message",
			status: "running",
			outputJson: null,
		});
		continuationRows = [record];
		recoveryQueue = [recoveryItem(record, "background-message", 0)];
		const prepared = await prepareRecovery([
			{ narratorId: "owner", locale: "en", userId: "acl-user" },
		]);
		prepared.protection = {
			...prepared.protection,
			narratorIds: new Set(["owner", "background-child"]),
		};
		loadMode = "idle";
		return { prepared, childFinished };
	}

	test("interrupt during legacy owner lookup cannot restart its foreground turn", async () => {
		const { prepared, childFinished } = await prepareBackgroundOwner();
		const entered = Promise.withResolvers<void>();
		const lookup = Promise.withResolvers<void>();
		const { narratorService } = await import("../narrator-service");
		const getById = narratorService.getById;
		const lookupSpy = spyOn(narratorService, "getById").mockImplementation(async (id) => {
			if (id === "owner") {
				entered.resolve();
				await lookup.promise;
			}
			return getById(id);
		});
		let recovery: Awaited<ReturnType<typeof restoreNarratorsAfterPlannedUpdate>> = null;
		try {
			recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
			await entered.promise;
			expect(realNarratorSessionModule.interruptNarrator("owner")).toBe(true);
			lookup.resolve();
			await recovery?.completion;
			expect(continueNarratorCalls).toBe(0);
			expect(resumedAgentCalls).toHaveLength(1);
			expect((resumedAgentCalls[0]?.cancelSignal as AbortSignal | undefined)?.aborted).not.toBe(
				true,
			);
		} finally {
			lookup.resolve();
			lookupSpy.mockRestore();
			childFinished.resolve("done");
		}
	});

	test("interrupt inside real continuation history admission cannot abort a later user run", async () => {
		const { prepared, childFinished } = await prepareBackgroundOwner();
		useRealLegacyContinuation = true;
		const entered = Promise.withResolvers<void>();
		const history = Promise.withResolvers<void>();
		const newRunFinished = Promise.withResolvers<void>();
		const interruptFinalizer = Promise.withResolvers<void>();
		const finalizerEntered = Promise.withResolvers<void>();
		cancelInterruptibleGate = interruptFinalizer.promise;
		markCancelInterruptibleStarted = finalizerEntered.resolve;
		const { narratorService } = await import("../narrator-service");
		const { activeNarrators } = await import("../narrator-session-state");
		const runtime = await import("../agent-runtime/orchestrator");
		const historySpy = spyOn(narratorService, "getModelHistorySinceLastCompact").mockImplementation(
			async () => {
				entered.resolve();
				await history.promise;
				return [];
			},
		);
		const launches: string[] = [];
		const runtimeSpy = spyOn(runtime, "runAgentLoopUnlocked").mockImplementation(
			async (active, _owner, text) => {
				active._loopRunning = true;
				launches.push(text);
				await newRunFinished.promise;
				active._loopRunning = false;
				return { started: true };
			},
		);
		const next = {
			narratorId: "owner",
			alive: true,
			abortController: new AbortController(),
			locale: "en",
			events: new EventEmitter(),
			cwd: process.cwd(),
			// A direct start runs as the user who sent the turn.
			_currentUserId: "acl-user",
		} as import("../narrator-session-state").ActiveNarrator;
		let newRun: Promise<{ started: boolean }> | undefined;
		try {
			const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
			await entered.promise;
			expect(realNarratorSessionModule.interruptNarrator("owner")).toBe(true);
			// The newer start is genuinely queued behind the old continuation admission.
			activeNarrators.set("owner", next);
			newRun = realNarratorSessionModule.runAgentLoop(next, "new user turn");
			history.resolve();
			await finalizerEntered.promise;
			expect(launches).toEqual([]);
			interruptFinalizer.resolve();
			await recovery?.completion;
			// The queued start prepares its run outside the admission, after the finalizer.
			for (let i = 0; i < 200 && launches.length === 0; i++) await Bun.sleep(5);
			expect(launches).toEqual(["new user turn"]);
			expect(next.abortController.signal.aborted).toBe(false);
			expect((resumedAgentCalls[0]?.cancelSignal as AbortSignal | undefined)?.aborted).not.toBe(
				true,
			);
			const persisted =
				await realNarratorServiceModule.narratorService.getModelHistorySinceLastCompact("owner");
			expect(persisted.filter((message) => message.role === "user")).toHaveLength(0);
		} finally {
			history.resolve();
			interruptFinalizer.resolve();
			newRunFinished.resolve();
			await newRun;
			activeNarrators.delete("owner");
			historySpy.mockRestore();
			runtimeSpy.mockRestore();
			childFinished.resolve("done");
		}
	});

	test.each([
		{ toolTail: false, gate: "status" },
		{ toolTail: true, gate: "status" },
		{ toolTail: false, gate: "enqueue" },
		{ toolTail: false, gate: "claim" },
	])("real continuation keeps interrupt coverage through loop dispatch (%j)", async ({
		toolTail,
		gate,
	}) => {
		const { prepared, childFinished } = await prepareBackgroundOwner();
		useRealLegacyContinuation = true;
		const { narratorService } = await import("../narrator-service");
		const { activeNarrators } = await import("../narrator-session-state");
		const runtime = await import("../agent-runtime/orchestrator");
		const statusEntered = Promise.withResolvers<void>();
		const statusGate = Promise.withResolvers<void>();
		const buffer = await import("../narrator-buffer");
		if (gate === "claim")
			await buffer.enqueueBufferedMessage(
				"owner",
				"queued real input",
				undefined,
				null,
				"acl-user",
			);
		const inbox = await import("../agent-runtime/inbox");
		const claim = inbox.claimInboxHead;
		const claimSpy = spyOn(inbox, "claimInboxHead").mockImplementation(async (...args) => {
			const row = await claim(...args);
			if (gate === "claim") {
				statusEntered.resolve();
				await statusGate.promise;
			}
			return row;
		});
		const enqueue = buffer.enqueueBufferedMessage;
		const enqueueSpy = spyOn(buffer, "enqueueBufferedMessage").mockImplementation(
			async (...args) => {
				const accepted = await enqueue(...args);
				if (gate === "enqueue") {
					statusEntered.resolve();
					await statusGate.promise;
				}
				return accepted;
			},
		);
		const historySpy = spyOn(narratorService, "getModelHistorySinceLastCompact").mockResolvedValue(
			toolTail
				? ([
						{
							id: "tool-tail",
							role: "assistant",
							contentJson: [{ type: "tool_use", id: "tool-use", name: "Bash" }],
						},
					] as never)
				: [],
		);
		const getById = narratorService.getById;
		const getSpy = spyOn(narratorService, "getById").mockImplementation(async (id) => ({
			...(await getById(id)),
			title: "Existing",
		}));
		const statusSpy = spyOn(narratorService, "updateStatus").mockImplementation(
			async (_id, status) => {
				if (status === "working") {
					statusEntered.resolve();
					await statusGate.promise;
				}
			},
		);
		const runtimeSpy = spyOn(runtime, "runAgentLoopUnlocked").mockResolvedValue({ started: true });
		const active = {
			narratorId: "owner",
			alive: true,
			abortController: new AbortController(),
			locale: "en",
			events: new EventEmitter(),
			cwd: process.cwd(),
		} as import("../narrator-session-state").ActiveNarrator;
		activeNarrators.set("owner", active);
		let recovery: Awaited<ReturnType<typeof restoreNarratorsAfterPlannedUpdate>> = null;
		try {
			recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
			await statusEntered.promise;
			expect(active._currentUserId).toBe("acl-user");
			expect(realNarratorSessionModule.interruptNarrator("owner")).toBe(true);
			statusGate.resolve();
			await recovery?.completion;
			expect(runtimeSpy).not.toHaveBeenCalled();
			expect(await buffer.getBufferedMessagesAsync("owner")).toHaveLength(gate === "claim" ? 1 : 0);
			expect((resumedAgentCalls[0]?.cancelSignal as AbortSignal | undefined)?.aborted).not.toBe(
				true,
			);
		} finally {
			statusGate.resolve();
			await recovery?.completion;
			activeNarrators.delete("owner");
			historySpy.mockRestore();
			getSpy.mockRestore();
			statusSpy.mockRestore();
			enqueueSpy.mockRestore();
			claimSpy.mockRestore();
			runtimeSpy.mockRestore();
			childFinished.resolve("done");
		}
	});

	test.each([
		"plain",
		"queued",
		"queued-bash",
		"queued-bash-interrupt",
	])("real background owner continuation hands off with accepted user identity (%s)", async (input) => {
		const { prepared, childFinished } = await prepareBackgroundOwner();
		useRealLegacyContinuation = true;
		const { narratorService } = await import("../narrator-service");
		const { activeNarrators, hasNarratorRuntimeClaim } = await import("../narrator-session-state");
		const runtime = await import("../agent-runtime/orchestrator");
		const finishLoop = Promise.withResolvers<void>();
		const buffer = await import("../narrator-buffer");
		if (input !== "plain") {
			sqlite
				.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
				.run("queued-user", "queued-user", "unused", new Date().toISOString());
			await buffer.enqueueBufferedMessage(
				"owner",
				"queued user turn",
				undefined,
				null,
				"queued-user",
				null,
				undefined,
				"back",
				input.includes("bash") ? "test-command" : null,
			);
		}
		const narratorModule = await import("../narrator-service");
		const bashSpy = spyOn(narratorModule, "handleBashCommand").mockImplementation(
			async (_id, _command, _raw, userId, options) => {
				expect(userId).toBe("queued-user");
				expect(options?.signal?.aborted).toBe(false);
				if (input === "queued-bash-interrupt") {
					expect(realNarratorSessionModule.interruptNarrator("owner")).toBe(true);
					expect(options?.signal?.aborted).toBe(true);
				}
				return { type: "bash", id: "test-bash", output: "done", isError: false };
			},
		);
		const historySpy = spyOn(narratorService, "getModelHistorySinceLastCompact").mockResolvedValue(
			[],
		);
		const getById = narratorService.getById;
		const getSpy = spyOn(narratorService, "getById").mockImplementation(async (id) => ({
			...(await getById(id)),
			title: "Existing",
		}));
		const active = {
			narratorId: "owner",
			alive: true,
			abortController: new AbortController(),
			locale: "en",
			events: new EventEmitter(),
			cwd: process.cwd(),
		} as import("../narrator-session-state").ActiveNarrator;
		activeNarrators.set("owner", active);
		const runtimeSpy = spyOn(runtime, "runAgentLoopUnlocked").mockImplementation(
			async (current, owner, _text, _images, _run, prePromptBashCommand) => {
				expect(owner.isCurrent()).toBe(true);
				current._loopRunning = true;
				if (prePromptBashCommand)
					await narratorModule.handleBashCommand(
						"owner",
						prePromptBashCommand,
						"",
						current._currentUserId ?? undefined,
						{ signal: current.abortController.signal },
					);
				await finishLoop.promise;
				current._loopRunning = false;
				return { started: true };
			},
		);
		try {
			const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
			await recovery?.completion;
			expect(runtimeSpy).toHaveBeenCalledTimes(1);
			expect(active._currentUserId).toBe(input === "plain" ? "acl-user" : "queued-user");
			expect(bashSpy).toHaveBeenCalledTimes(input.includes("bash") ? 1 : 0);
			expect(hasNarratorRuntimeClaim("owner")).toBe(false);
			expect(await buffer.getBufferedMessagesAsync("owner")).toHaveLength(0);
			if (input !== "queued-bash-interrupt")
				expect(realNarratorSessionModule.interruptNarrator("owner")).toBe(true);
			expect(active.abortController.signal.aborted).toBe(true);
			expect((resumedAgentCalls[0]?.cancelSignal as AbortSignal | undefined)?.aborted).not.toBe(
				true,
			);
			if (input !== "plain") {
				const history =
					await realNarratorServiceModule.narratorService.getModelHistorySinceLastCompact("owner");
				expect(history.filter((row) => row.role === "user").map((row) => row.contentText)).toEqual([
					"queued user turn",
				]);
			}
		} finally {
			finishLoop.resolve();
			// Serialize with runtime ownership release before the next isolated case.
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(realNarratorSessionModule.isLoopRunning("owner")).toBe(false);
			activeNarrators.delete("owner");
			historySpy.mockRestore();
			getSpy.mockRestore();
			bashSpy.mockRestore();
			runtimeSpy.mockRestore();
			childFinished.resolve("done");
		}
	});

	test("long queued Bash transfers to real runtime before a short recovery handoff", async () => {
		const { prepared, childFinished } = await prepareBackgroundOwner();
		useRealLegacyContinuation = true;
		const buffer = await import("../narrator-buffer");
		sqlite
			.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
			.run("queued-user", "queued-user", "unused", new Date().toISOString());
		await buffer.enqueueBufferedMessage(
			"owner",
			"queued long Bash turn",
			undefined,
			null,
			"queued-user",
			null,
			undefined,
			"back",
			"test-long-command",
		);
		const narratorModule = await import("../narrator-service");
		const { narratorService } = narratorModule;
		const { activeNarrators } = await import("../narrator-session-state");
		const runtime = await import("../agent-runtime/orchestrator");
		const executor = await import("../narrator-executor");
		const { bashTool } = await import("../../lib/agent/tools/bash");
		const bashEntered = Promise.withResolvers<AbortSignal>();
		const finishBash = Promise.withResolvers<void>();
		const finishedRuntime = Promise.withResolvers<void>();
		const historySpy = spyOn(narratorService, "getModelHistorySinceLastCompact").mockResolvedValue(
			[],
		);
		const getById = narratorService.getById;
		const getSpy = spyOn(narratorService, "getById").mockImplementation(async (id) => ({
			...(await getById(id)),
			title: "Existing",
		}));
		const statusSpy = spyOn(narratorService, "updateStatus").mockImplementation(
			realNarratorServiceModule.narratorService.updateStatus,
		);
		const handleSpy = spyOn(narratorModule, "handleBashCommand").mockImplementation(
			realNarratorServiceModule.handleBashCommand,
		);
		const toolSpy = spyOn(bashTool, "execute").mockImplementation(async (_input, context) => {
			bashEntered.resolve(context.signal);
			await finishBash.promise;
			return { output: "cancelled test command", isError: false };
		});
		const executorSpy = spyOn(executor, "executeAgentLoop").mockImplementation(async () => {
			throw new Error("Interrupted Bash must never request a model turn");
		});
		const runUnlocked = runtime.runAgentLoopUnlocked;
		const runtimeSpy = spyOn(runtime, "runAgentLoopUnlocked").mockImplementation((...args) => {
			const running = runUnlocked(...args);
			void running.then(() => finishedRuntime.resolve(), finishedRuntime.reject);
			return running;
		});
		const active = {
			narratorId: "owner",
			conversationId: "test-long-bash",
			model: "test-model",
			provider: "anthropic",
			systemPrompt: null,
			alive: true,
			abortController: new AbortController(),
			locale: "en",
			events: new EventEmitter(),
			cwd: process.cwd(),
			_substatus: new Set(),
			_enabledOptionalTools: new Set(),
			_disabledTools: new Set(),
			_blockedSkills: { all: false, names: new Set<string>() },
			_preparedPlanModes: new Map(),
		} as import("../narrator-session-state").ActiveNarrator;
		activeNarrators.set("owner", active);
		let ticket: ReturnType<typeof reserveRecoveryHandoff> | undefined;
		let recovery: Awaited<ReturnType<typeof restoreNarratorsAfterPlannedUpdate>> = null;
		try {
			recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
			const bashSignal = await bashEntered.promise;
			ticket = reserveRecoveryHandoff();
			await expect(waitForRecoveryHandoffReady(ticket, { timeoutMs: 40 })).resolves.toBeUndefined();
			expect(active._loopRunning).toBe(true);
			expect(active._currentUserId).toBe("queued-user");
			expect(handleSpy.mock.calls[0]?.[3]).toBe("queued-user");
			releaseRecoveryHandoff(ticket);
			ticket = undefined;
			await recovery?.completion;
			expect(toolSpy).toHaveBeenCalledTimes(1);
			expect(realNarratorSessionModule.interruptNarrator("owner")).toBe(true);
			expect(bashSignal.aborted).toBe(true);
			expect((resumedAgentCalls[0]?.cancelSignal as AbortSignal | undefined)?.aborted).not.toBe(
				true,
			);
			finishBash.resolve();
			await finishedRuntime.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(runtimeSpy).toHaveBeenCalledTimes(1);
			expect(toolSpy).toHaveBeenCalledTimes(1);
			expect(executorSpy).not.toHaveBeenCalled();
			expect(realNarratorSessionModule.isLoopRunning("owner")).toBe(false);
			const row = await realNarratorServiceModule.narratorService.getById("owner");
			expect(row.status).toBe("idle");
			expect(JSON.parse(row.substatus)).toContain("interrupted");
		} finally {
			if (ticket) {
				try {
					releaseRecoveryHandoff(ticket);
				} catch {
					/* Readiness timeout already released it. */
				}
			}
			if (!active.abortController.signal.aborted)
				realNarratorSessionModule.interruptNarrator("owner");
			finishBash.resolve();
			await recovery?.completion;
			if (runtimeSpy.mock.calls.length) await finishedRuntime.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			activeNarrators.delete("owner");
			historySpy.mockRestore();
			getSpy.mockRestore();
			statusSpy.mockRestore();
			handleSpy.mockRestore();
			toolSpy.mockRestore();
			executorSpy.mockRestore();
			runtimeSpy.mockRestore();
			childFinished.resolve("done");
		}
	});

	test.each([
		false,
		true,
	])("independent legacy cancellation settles late working write before next start (newRun=%s)", async (startNewRun) => {
		loadMode = "working";
		useRealLegacyContinuation = true;
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id: "legacy",
			type: "primary",
			variant: "primary",
			status: "working",
			createdAt: now,
			updatedAt: now,
		});
		const prepared = await prepareRecovery([{ narratorId: "legacy", locale: "en" }]);
		const { narratorService } = await import("../narrator-service");
		const { activeNarrators, hasNarratorRuntimeClaim } = await import("../narrator-session-state");
		const runtime = await import("../agent-runtime/orchestrator");
		const entered = Promise.withResolvers<void>();
		const workingGate = Promise.withResolvers<void>();
		const finishNewRun = Promise.withResolvers<void>();
		const realStatus = realNarratorServiceModule.narratorService.updateStatus;
		const getSpy = spyOn(narratorService, "getById").mockImplementation(
			realNarratorServiceModule.narratorService.getById,
		);
		const historySpy = spyOn(narratorService, "getModelHistorySinceLastCompact").mockResolvedValue([
			{
				id: "legacy-tool-tail",
				role: "assistant",
				contentJson: [{ type: "tool_use", id: "legacy-tool", name: "Bash" }],
			},
		] as never);
		const statusSpy = spyOn(narratorService, "updateStatus").mockImplementation(async (...args) => {
			if (args[1] === "working") {
				entered.resolve();
				await workingGate.promise;
			}
			return realStatus(...args);
		});
		const active = {
			narratorId: "legacy",
			alive: true,
			abortController: new AbortController(),
			locale: "en",
			events: new EventEmitter(),
			cwd: process.cwd(),
		} as import("../narrator-session-state").ActiveNarrator;
		activeNarrators.set("legacy", active);
		const launches: string[] = [];
		const runtimeSpy = spyOn(runtime, "runAgentLoopUnlocked").mockImplementation(
			async (current, _owner, text) => {
				launches.push(text);
				current._loopRunning = true;
				await realStatus("legacy", "working");
				await finishNewRun.promise;
				current._loopRunning = false;
				return { started: true };
			},
		);
		let newRun: Promise<{ started: boolean }> | undefined;
		try {
			const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
			await entered.promise;
			expect(realNarratorSessionModule.interruptNarrator("legacy")).toBe(true);
			if (startNewRun) {
				const next = { ...active, abortController: new AbortController() };
				activeNarrators.set("legacy", next);
				// The legacy row has no owner: this turn runs anonymously.
				newRun = realNarratorSessionModule.runAgentLoop(next, "new legacy user turn", undefined, {
					principal: null,
				});
			}
			workingGate.resolve();
			await recovery?.completion;
			// A queued start prepares its run outside the admission, after the finalizer.
			for (let i = 0; startNewRun && i < 200 && launches.length === 0; i++) await Bun.sleep(5);
			const row = await realNarratorServiceModule.narratorService.getById("legacy");
			expect(row.status).toBe(startNewRun ? "working" : "idle");
			if (!startNewRun) {
				expect(JSON.parse(row.substatus)).toContain("interrupted");
				expect(row.lastStopReason).toBe("user_interrupt");
			}
			expect(launches).toEqual(startNewRun ? ["new legacy user turn"] : []);
			expect(hasNarratorRuntimeClaim("legacy")).toBe(false);
		} finally {
			workingGate.resolve();
			finishNewRun.resolve();
			await newRun;
			activeNarrators.delete("legacy");
			getSpy.mockRestore();
			historySpy.mockRestore();
			statusSpy.mockRestore();
			runtimeSpy.mockRestore();
		}
	});

	test("background owner handoff reservation never waits on its own nested advance", async () => {
		const { prepared, childFinished } = await prepareBackgroundOwner();
		const reserved = Promise.withResolvers<ReturnType<typeof reserveRecoveryHandoff>>();
		const severed = prepared.severedNarratorIds;
		prepared.severedNarratorIds = {
			...severed,
			has(id: string) {
				const ticket = reserveRecoveryHandoff();
				reserved.resolve(ticket);
				return severed.has(id);
			},
		} as ReadonlySet<string>;
		let ticket: ReturnType<typeof reserveRecoveryHandoff> | undefined;
		let recovery: Awaited<ReturnType<typeof restoreNarratorsAfterPlannedUpdate>> = null;
		try {
			recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
			ticket = await reserved.promise;
			await expect(waitForRecoveryHandoffReady(ticket, { timeoutMs: 40 })).resolves.toBeUndefined();
		} finally {
			if (ticket) {
				try {
					releaseRecoveryHandoff(ticket);
				} catch {
					/* Timeout already releases the ticket. */
				}
			}
			await recovery?.completion;
			childFinished.resolve("done");
		}
	});

	test("an invalidated background owner is not resumed after its child mounts", async () => {
		loadMode = "working";
		const record = continuationRecord("background-invalidated", "owner", {
			kind: "background_agent",
			payloadJson: { subagentId: "background-child", backgroundTaskId: "background-child" },
		});
		toolCallResults.set(record.toolCallId, {
			id: record.toolCallId,
			toolUseId: record.toolCallId,
			messageId: "background-message",
			status: "running",
			outputJson: null,
		});
		continuationRows = [record];
		recoveryQueue = [recoveryItem(record, "background-message", 0)];
		const prepared = await prepareRecovery([{ narratorId: "owner", locale: "en" }]);
		prepared.protection = {
			...prepared.protection,
			narratorIds: new Set(["owner", "background-child"]),
		};
		invalidateRecoveryTarget("owner");
		loadMode = "idle";
		const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
		await recovery?.completion;
		expect(continueNarratorCalls).toBe(0);
	});

	test("failed background parent continuation is visible and retains recovery evidence", async () => {
		loadMode = "working";
		const record = continuationRecord("background-parent-failed", "owner", {
			kind: "background_agent",
			payloadJson: { subagentId: "background-child", backgroundTaskId: "background-child" },
		});
		toolCallResults.set(record.toolCallId, {
			id: record.toolCallId,
			toolUseId: record.toolCallId,
			messageId: "background-message",
			status: "running",
			outputJson: null,
		});
		continuationRows = [record];
		recoveryQueue = [recoveryItem(record, "background-message", 0)];
		const prepared = await prepareRecovery([{ narratorId: "owner", locale: "en" }]);
		prepared.protection = {
			...prepared.protection,
			narratorIds: new Set(["owner", "background-child"]),
		};
		sqlite.prepare("UPDATE narrators SET status = 'working' WHERE id = 'owner'").run();
		loadMode = "idle";
		continueNarratorImpl = async () => {
			throw new Error("foreground continuation failed");
		};
		const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
		await expect(recovery?.completion).rejects.toThrow("Failed to mount 1 legacy narrator");
		expect(continueNarratorCalls).toBe(1);
		const row = sqlite
			.prepare("SELECT status, substatus, error_message FROM narrators WHERE id = 'owner'")
			.get() as { status: string; substatus: string; error_message: string };
		expect(row.status).toBe("idle");
		expect(JSON.parse(row.substatus)).toContain("error");
		expect(row.error_message).toContain("Startup recovery failed");
		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).not.toBeNull();
	});

	test("token binding failure releases all registrations before any execution starts", async () => {
		loadMode = "idle";
		const first = continuationRecord("first-result", "first", { state: "completed" });
		const second = continuationRecord("second-result", "second", { state: "completed" });
		continuationRows = [first, second];
		recoveryQueue = [
			recoveryItem(first, "first-message", 0),
			recoveryItem(second, "second-message", 0),
		];
		const prepared = await prepareRecovery();
		const { toolContinuationService: service } = await import("../tool-continuation-service");
		const { hasNarratorRuntimeClaim } = await import("../narrator-session-state");
		const bind = service.bindRecoveryTokenForNarrator;
		const binding = spyOn(service, "bindRecoveryTokenForNarrator").mockImplementation(
			async (...args) => {
				if (args[0] === "second") throw new Error("binding failed");
				return bind(...args);
			},
		);
		try {
			await expect(restoreNarratorsAfterPlannedUpdate(prepared)).rejects.toThrow("binding failed");
			expect(hasNarratorRuntimeClaim("first")).toBe(false);
			expect(hasNarratorRuntimeClaim("second")).toBe(false);
			expect(executePersistedCalls).toBe(0);
			expect(continueNarratorCalls).toBe(0);
		} finally {
			binding.mockRestore();
		}
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

	test("continues the same Agent run without re-timing it", async () => {
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

		// The run that was executing before the update (registered by the fixture).
		const runId = record.payloadJson?.logicalRunId;
		expect(typeof runId).toBe("string");
		const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
		expect(resumedAgentCalls).toHaveLength(1);
		// The absolute deadline is a registered fact of that run: recovery re-enters the
		// run by id and never supplies a fresh timeout that could restart it.
		expect(resumedAgentCalls[0]).toMatchObject({
			narratorId: "child-deadline",
			resumeRunId: runId,
			recovered: true,
		});
		for (const key of ["timeoutMs", "executionDeadlineAt", "executionTimeoutMs", "binding"])
			expect(resumedAgentCalls[0]).not.toHaveProperty(key);
		await recovery?.completion;
	});

	for (const expired of [false, true]) {
		test(`M3 pre-registration Agent checkpoint preserves its original absolute deadline, expired=${expired}`, async () => {
			loadMode = "idle";
			const deadlineAt = new Date(Date.now() + (expired ? -1000 : 10_000)).toISOString();
			const record = continuationRecord("legacy-deadline-tool", "owner", {
				kind: "foreground_agent",
				state: "waiting",
				payloadJson: {
					subagentId: "legacy-deadline-child",
					executionDeadlineAt: deadlineAt,
					executionTimeoutMs: 30_000,
				},
			});
			toolCallResults.set(record.toolCallId, {
				id: record.toolCallId,
				toolUseId: record.toolCallId,
				messageId: "legacy-deadline-message",
				status: "running",
				outputJson: null,
			});
			continuationRows = [record];
			recoveryQueue = [recoveryItem(record, "legacy-deadline-message", 0)];
			const prepared = await prepareRecovery();
			// Simulate an old binary: the logical run/checkpoint exists, no registration yet.
			await db
				.update(narrators)
				.set({ runtimeRegistrationJson: null })
				.where(eq(narrators.id, "legacy-deadline-child"));
			const recovery = await restoreNarratorsAfterPlannedUpdate(prepared);
			expect(resumedAgentCalls).toHaveLength(1);
			expect(resumedAgentCalls[0]).toMatchObject({
				resumeRunId: record.payloadJson?.logicalRunId,
				binding: {
					principal: { userId: null },
					deadlineAt,
					deliverTo: { narratorId: "owner", toolUseId: "legacy-deadline-tool" },
				},
			});
			await recovery?.completion;
		});
	}

	test("parent interrupt reaches recovered foreground Agent and Await", async () => {
		loadMode = "idle";
		const awaitMounted = Promise.withResolvers<void>();
		onAwaitMounted = awaitMounted.resolve;
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
		try {
			expect(resumedAgentCalls).toHaveLength(1);
			await awaitMounted.promise;
			expect(awaitAgentCalls).toHaveLength(1);
			const agentSignal = resumedAgentCalls[0]?.cancelSignal as AbortSignal;
			const awaitSignal = awaitAgentCalls[0]?.signal as AbortSignal;
			expect(agentSignal.aborted).toBe(false);
			expect(awaitSignal.aborted).toBe(false);
			expect(realNarratorSessionModule.interruptNarrator("owner")).toBe(true);
			expect(agentSignal.aborted).toBe(true);
			expect(awaitSignal.aborted).toBe(true);
		} finally {
			realNarratorSessionModule.interruptNarrator("owner");
			finishAgent("<subagent_id>child-interrupt</subagent_id>\n\ninterrupted");
			finishAwait({ id: "child-interrupt", status: "aborted", formatted: "interrupted" });
			await recovery?.completion;
		}
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
		// A background run is not bound to the parent's attempt: nothing it holds can be
		// aborted by the parent's interrupt.
		expect(resumedAgentCalls[0]?.cancelSignal).toBeUndefined();
		expect(realNarratorSessionModule.interruptNarrator("owner")).toBe(true);
		await cancellationStart;
		releaseCancellation();
		await Bun.sleep(0);
		expect(continuationRows[0]?.state).toBe("cancelled");
		releaseResultWrite();
		await recovery?.completion;

		expect(backgroundSettled).toBe(false);
		expect(continuationRows[0]?.state).toBe("cancelled");
		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).toBeNull();
		finishBackground("<subagent_id>background-only-child</subagent_id>\n\ndone");
		await resumedAgentCompletion;
	});

	test("parent interrupt resolves mixed background delivery without failing recovery", async () => {
		loadMode = "idle";
		const awaitMounted = Promise.withResolvers<void>();
		onAwaitMounted = awaitMounted.resolve;
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
		try {
			await resultWriteReached;
			expect(resumedAgentCalls).toHaveLength(1);
			await awaitMounted.promise;
			expect(awaitAgentCalls).toHaveLength(1);
			// A background continuation has no caller cancellation to inherit.
			expect(resumedAgentCalls[0]?.cancelSignal).toBeUndefined();
			const awaitSignal = awaitAgentCalls[0]?.signal as AbortSignal;
			expect(realNarratorSessionModule.interruptNarrator("owner")).toBe(true);
			await cancellationStart;
			expect(awaitSignal.aborted).toBe(true);
			releaseCancellation();
			await Bun.sleep(0);
			expect(continuationRows.every((row) => row.state === "cancelled")).toBe(true);
			finishAwait({ id: "foreground-mixed-child", status: "aborted", formatted: "interrupted" });
			releaseResultWrite();
			await recovery?.completion;

			expect(backgroundSettled).toBe(false);
			expect(continuationRows.every((row) => row.state === "cancelled")).toBe(true);
			expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).toBeNull();
		} finally {
			realNarratorSessionModule.interruptNarrator("owner");
			releaseCancellation();
			finishAwait({ id: "foreground-mixed-child", status: "aborted", formatted: "interrupted" });
			releaseResultWrite();
			finishBackground("<subagent_id>background-mixed-child</subagent_id>\n\ndone");
			await recovery?.completion;
			await resumedAgentCompletion;
		}
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
