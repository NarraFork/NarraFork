import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { backgroundTasks, narratorMessages, narrators, narratorToolCalls } from "../db/schema";
import {
	measureSerializedCharacters,
	queueContextCharacterRefresh,
} from "../lib/context-characters";
import {
	flushRuntimePublications,
	getRuntimePublicationService,
} from "./agent-runtime/publication";

function readAgentLogicalRunId(narratorId: string): string | undefined {
	return (
		db
			.select({ logicalRunId: narrators.logicalRunId })
			.from(narrators)
			.where(eq(narrators.id, narratorId))
			.get()?.logicalRunId ?? undefined
	);
}

import {
	groupToolExecutions,
	isAgentDependentToolExecutionGroup,
} from "../lib/agent/tool-execution-groups";
import { listRunningAwaits } from "../lib/agent/tools/await";
import { NotFoundError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { isSubagentVariant } from "../lib/narrator-utils";
import { getToolMessage, type Locale } from "../lib/prompt-i18n";
import { getObservedRestartHandoff } from "../lib/restart-handoff";
import {
	type AgentReplyWaitRunSnapshot,
	getRunningAgentReplyWaitRunSnapshot,
	waitForAgentReplyWaitRunStability,
} from "./agent-reply-waiter";
import {
	hasPersistedToolContinuationResult,
	isToolContinuationOwnerMounted,
	type ToolContinuationProtectionSets,
	type ToolContinuationRecord,
	type ToolContinuationRecoveryItem,
	toolContinuationService,
} from "./tool-continuation-service";
import {
	capturePlannedUpdateRecoverySnapshot,
	classifyRecoveryManifestOwnership,
	consumePlannedUpdateRecoverySnapshot,
	type PlannedUpdateRecoverySnapshot,
	removePlannedUpdateRecoverySnapshot,
} from "./update-coordinator";

export const CLAIM_LEASE_MS = 5 * 60_000;
export const CLAIM_RENEW_INTERVAL_MS = 30_000;
/**
 * Row ceiling for the two checkpoint scans of non-terminal tool calls.
 *
 * Both the fence's coverage count (`listActiveToolCallIds`) and this module's
 * continuation writer read the same set, so they must agree on how many rows a
 * checkpoint is willing to look at — a limit on one side only would let the fence
 * demand coverage for rows the writer never saw. Defined here because
 * update-service imports this module, not the other way round.
 *
 * The extra 1 is the overflow probe: reaching the limit means the real count is
 * unbounded, which is a bug to surface rather than a set to silently truncate.
 * Abandoned non-terminal rows accumulate from ordinary provider errors, so this
 * scan grows with the age of an installation and cannot be left unbounded.
 */
export const CHECKPOINT_ACTIVE_TOOL_LIMIT = 10_001;
const NON_IDEMPOTENT_KINDS = new Set<ToolContinuationRecord["kind"]>([
	"deferred_tool",
	"pending_permission",
]);
const RENEWABLE_KINDS = new Set<ToolContinuationRecord["kind"]>([
	"deferred_tool",
	"pending_permission",
	"foreground_agent",
	"background_agent",
	"await_agent",
	"send_await",
]);
const EXECUTION_UNKNOWN_ERROR =
	"Tool execution outcome is unknown after the server restart; the tool was not retried to avoid duplicate side effects.";
const EMPTY_PROTECTION: ToolContinuationProtectionSets = {
	toolCallIds: new Set(),
	narratorIds: new Set(),
	backgroundTaskIds: new Set(),
};

function payloadString(payload: Record<string, unknown> | null, key: string): string | undefined {
	const value = payload?.[key];
	return typeof value === "string" && value ? value : undefined;
}

function payloadNumber(payload: Record<string, unknown> | null, key: string): number | undefined {
	const value = payload?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestampMs(value: string | number | Date | null | undefined): number | null {
	if (value == null) return null;
	const parsed =
		value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function sendAwaitSnapshotFromPayload(
	payload: Record<string, unknown> | null,
): AgentReplyWaitRunSnapshot | null {
	const value = payload?.sendAwait;
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const snapshot = value as Partial<AgentReplyWaitRunSnapshot>;
	if (
		typeof snapshot.toolUseId !== "string" ||
		typeof snapshot.requesterId !== "string" ||
		!Array.isArray(snapshot.waiters) ||
		!Array.isArray(snapshot.prefixSections) ||
		!Array.isArray(snapshot.prefixTargets)
	) {
		return null;
	}
	// Old checkpoints legitimately lack these fields. If present, validate without
	// inferring revision from a current mailbox row or silently repairing malformed identity.
	for (const target of [...snapshot.waiters, ...snapshot.prefixTargets]) {
		if (!target || typeof target !== "object" || Array.isArray(target)) return null;
		for (const key of ["deliveryId", "recipientRefId"] as const) {
			const pointer = target[key];
			if (
				pointer !== undefined &&
				(typeof pointer !== "string" || pointer.length === 0 || Buffer.byteLength(pointer) > 512)
			)
				return null;
		}
		if (
			target.revision !== undefined &&
			(!Number.isSafeInteger(target.revision) || target.revision < 1)
		)
			return null;
		if (
			(target.recipientRefId !== undefined || target.revision !== undefined) &&
			target.deliveryId === undefined
		)
			return null;
	}
	return snapshot as AgentReplyWaitRunSnapshot;
}

function earliestPendingSendAwaitDeadline(snapshot: AgentReplyWaitRunSnapshot): string | null {
	let earliest = Number.POSITIVE_INFINITY;
	for (const waiter of snapshot.waiters) {
		if (waiter.result) continue;
		const deadline = Date.parse(waiter.deadlineAt);
		if (Number.isFinite(deadline)) earliest = Math.min(earliest, deadline);
	}
	return Number.isFinite(earliest) ? new Date(earliest).toISOString() : null;
}

export async function waitForStableSendAwaitCheckpoint(
	input: { toolCallId: string; toolUseId: string },
	hooks: {
		loadStatus?: () => Promise<string | null>;
		pause?: () => Promise<void>;
	} = {},
): Promise<AgentReplyWaitRunSnapshot | null> {
	const loadStatus =
		hooks.loadStatus ??
		(async () => {
			const current = await db.query.narratorToolCalls.findFirst({
				where: eq(narratorToolCalls.id, input.toolCallId),
				columns: { status: true },
			});
			return current?.status ?? null;
		});
	const pause = hooks.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
	for (;;) {
		const snapshot =
			getRunningAgentReplyWaitRunSnapshot(input.toolUseId) ??
			(await waitForAgentReplyWaitRunStability(input.toolUseId));
		if (snapshot) return snapshot;
		const status = await loadStatus();
		if (!status || !["initializing", "pending", "running"].includes(status)) return null;
		// A granted Send await can be between the durable running row and its in-memory
		// waiter registration. Wait for that setup to stabilize or for the tool to finish;
		// never classify the possibly-delivered Send as a deferred re-execution.
		await pause();
	}
}

export interface SendAwaitCheckpointVerification {
	stable: boolean;
	unstableToolCallIds: string[];
}

function sameSendAwaitSnapshot(
	left: AgentReplyWaitRunSnapshot | null,
	right: AgentReplyWaitRunSnapshot | null,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Reverse-check every Send await already persisted for this epoch. A terminal tool row is
 * authoritative and atomically advances the continuation to result_written; an active row is
 * stable only while its durable snapshot exactly matches the current process-local waiter run.
 */
export async function verifySendAwaitCheckpointEpoch(
	updateEpoch: string,
): Promise<SendAwaitCheckpointVerification> {
	const rows = await toolContinuationService.listSendAwaitCheckpointRows(updateEpoch);
	const unstableToolCallIds: string[] = [];
	for (const { record, toolCallStatus } of rows) {
		if (isToolContinuationOwnerMounted(record) || record.state === "cancelled") continue;
		if (toolCallStatus === "success" || toolCallStatus === "fail") {
			await toolContinuationService.reconcileSendAwaitResult(record.toolCallId, updateEpoch);
			continue;
		}
		if (hasPersistedToolContinuationResult(record)) continue;

		const currentSnapshot = getRunningAgentReplyWaitRunSnapshot(
			sendAwaitSnapshotFromPayload(record.payloadJson)?.toolUseId ?? "",
		);
		const persistedSnapshot = sendAwaitSnapshotFromPayload(record.payloadJson);
		if (!currentSnapshot || !sameSendAwaitSnapshot(currentSnapshot, persistedSnapshot)) {
			unstableToolCallIds.push(record.toolCallId);
			if (currentSnapshot) {
				await toolContinuationService.checkpointSendAwait({
					toolCallId: record.toolCallId,
					narratorId: record.narratorId,
					updateEpoch,
					deadlineAt: earliestPendingSendAwaitDeadline(currentSnapshot),
					payloadJson: { ...(record.payloadJson ?? {}), sendAwait: currentSnapshot },
				});
			}
		}
	}
	return { stable: unstableToolCallIds.length === 0, unstableToolCallIds };
}

export function resolveAgentExecutionDeadline(input: {
	runtimeDeadlineAt?: string | null;
	runtimeTimeoutMs?: number | null;
	toolInput: Record<string, unknown> | null;
	startedAt?: string | number | Date | null;
	defaultTimeoutMs?: number;
}): { executionDeadlineAt: string | null; executionTimeoutMs: number | null } {
	const rawTimeout = input.toolInput?.timeout;
	const configuredTimeout =
		typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout >= 0
			? rawTimeout
			: input.defaultTimeoutMs;
	const executionTimeoutMs =
		input.runtimeTimeoutMs ?? (configuredTimeout === 0 ? null : (configuredTimeout ?? null));
	if (input.runtimeDeadlineAt) {
		return { executionDeadlineAt: input.runtimeDeadlineAt, executionTimeoutMs };
	}
	const startedAt = timestampMs(input.startedAt);
	return {
		executionDeadlineAt:
			startedAt !== null && executionTimeoutMs !== null
				? new Date(startedAt + executionTimeoutMs).toISOString()
				: null,
		executionTimeoutMs,
	};
}

function localeFor(snapshot: PlannedUpdateRecoverySnapshot, narratorId: string): Locale {
	return (snapshot.narrators.find((target) => target.narratorId === narratorId)?.locale ??
		"en") as Locale;
}

/**
 * Whether a non-terminal tool-call row belongs to work this process is actually still running.
 *
 * A tool row is NOT proof of live work. Three ordinary paths leave `initializing`/`pending`/
 * `running` rows behind on a narrator that finished long ago:
 *
 *   - a provider/loop error, whose non-Aborted cleanup branch deliberately leaves in-flight
 *     rows alone (see narrator-subagent-recovery's header: that leak is the input its
 *     recovery card is built for),
 *   - a permission request whose process died before the user answered,
 *   - any crash between "tool row written" and "result written".
 *
 * Those rows can be arbitrarily old. Checkpointing them writes a continuation, which the
 * replacement process then delivers to its owner via `continueNarrator` — reviving a narrator
 * the user considered finished and making a stale plan act on current code. The narrator's own
 * `status` cannot distinguish the cases either: an errored turn leaves `idle`, but a turn killed
 * mid-flight leaves `working`/`waiting` forever, so a dead narrator reads as busy.
 *
 * The authority is therefore this process's in-memory registry, not the database: a narrator is
 * live only while it holds a registered agent loop or execution lease, both of which are released
 * in a `finally`. `capturePlannedUpdateRecoverySnapshot` builds the manifest from exactly those
 * two registries, so reusing its narrator list keeps checkpoint coverage and manifest membership
 * from disagreeing.
 *
 * Background agents are the deliberate exception: a background task outlives its parent's turn,
 * so its parent is legitimately absent from the registries. Those rows are keyed off the
 * `background_tasks` table instead and never consult this predicate.
 */
export function isLiveNarratorForCheckpoint(
	snapshot: Pick<PlannedUpdateRecoverySnapshot, "narrators">,
	narratorId: string,
): boolean {
	return snapshot.narrators.some((target) => target.narratorId === narratorId);
}

class ContinuationClaimLostError extends Error {
	constructor(toolCallId: string) {
		super(`Continuation claim was lost for tool call ${toolCallId}`);
		this.name = "ContinuationClaimLostError";
	}
}

export interface ContinuationClaimRenewal {
	run<T>(operation: Promise<T>): Promise<T>;
	verify(): Promise<void>;
	stop(): void;
}

export function startContinuationClaimRenewal(
	toolCallId: string,
	claimToken: string,
	abortController: AbortController,
	options: { leaseMs?: number; intervalMs?: number } = {},
): ContinuationClaimRenewal {
	const leaseMs = options.leaseMs ?? CLAIM_LEASE_MS;
	const intervalMs = options.intervalMs ?? CLAIM_RENEW_INTERVAL_MS;
	if (leaseMs <= 0 || intervalMs <= 0 || intervalMs * 3 >= leaseMs) {
		throw new Error("Continuation claim renewal interval must be significantly shorter than lease");
	}

	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lostError: ContinuationClaimLostError | null = null;
	let rejectLost: (error: ContinuationClaimLostError) => void = () => {};
	const lost = new Promise<never>((_resolve, reject) => {
		rejectLost = reject;
	});
	// The recovery path races every long operation against this promise. Tests may intentionally
	// trigger loss before attaching their assertion, so keep the rejection handled as well.
	void lost.catch(() => {});

	const loseClaim = () => {
		if (stopped || lostError) return;
		lostError = new ContinuationClaimLostError(toolCallId);
		abortController.abort(lostError);
		rejectLost(lostError);
	};
	const renew = async (): Promise<void> => {
		if (stopped) return;
		try {
			const renewed = await toolContinuationService.renewClaim(toolCallId, {
				claimToken,
				deadlineAt: new Date(Date.now() + leaseMs).toISOString(),
			});
			if (!renewed) loseClaim();
		} catch {
			loseClaim();
		}
	};
	const schedule = () => {
		if (stopped || lostError) return;
		timer = setTimeout(async () => {
			await renew();
			schedule();
		}, intervalMs);
	};
	schedule();

	return {
		run: <T>(operation: Promise<T>) => Promise.race([operation, lost]),
		verify: async () => {
			if (lostError) throw lostError;
			await renew();
			if (lostError) throw lostError;
		},
		stop: () => {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = null;
		},
	};
}

function groupContinuationRecoveryItems(
	items: ToolContinuationRecoveryItem[],
): ToolContinuationRecoveryItem[][] {
	const groups = new Map<string, ToolContinuationRecoveryItem[]>();
	for (const item of items) {
		const key = `${item.record.narratorId}\u0000${item.messageId}`;
		const group = groups.get(key);
		if (group) group.push(item);
		else groups.set(key, [item]);
	}
	return [...groups.values()].map((group) =>
		group.sort(
			(a, b) =>
				a.toolUseOrder - b.toolUseOrder ||
				a.toolCallCreatedAt.localeCompare(b.toolCallCreatedAt) ||
				a.record.toolCallId.localeCompare(b.record.toolCallId),
		),
	);
}

export async function runContinuationRecoveryGroups(
	items: ToolContinuationRecoveryItem[],
	restore: (
		record: ToolContinuationRecord,
		item: ToolContinuationRecoveryItem,
		index: number,
		group: ToolContinuationRecoveryItem[],
	) => Promise<void>,
): Promise<void> {
	await Promise.all(
		groupContinuationRecoveryItems(items).map(async (messageItems) => {
			const executionGroups = groupToolExecutions(messageItems);
			let activeRuns: Promise<void>[] = [];
			for (const [groupIndex, executionGroup] of executionGroups.entries()) {
				const previousGroup = executionGroups[groupIndex - 1];
				if (!isAgentDependentToolExecutionGroup(previousGroup, executionGroup)) {
					await Promise.all(activeRuns);
					activeRuns = [];
				}
				const completion = Promise.all(
					executionGroup.map((item) => {
						const index = messageItems.indexOf(item);
						return restore(item.record, item, index, messageItems);
					}),
				).then(() => undefined);
				// The next serial barrier consumes this promise, but attach a handler now so an
				// early failure cannot become an unhandled rejection while an Agent is still running.
				void completion.catch(() => {});
				activeRuns.push(completion);
			}
			await Promise.all(activeRuns);
		}),
	);
}
/** Persist every process-owned wait that may still be live when the replacement starts. */
export async function checkpointPlannedUpdateContinuations(): Promise<PlannedUpdateRecoverySnapshot> {
	const snapshot = capturePlannedUpdateRecoverySnapshot();
	const runningAwaits = new Map(listRunningAwaits().map((entry) => [entry.toolUseId, entry]));
	const { BACKGROUND_TASK_TIMEOUT_MS, listRunningSubagentExecutions } = await import(
		"./subagent-runner"
	);
	const runningAgents = listRunningSubagentExecutions();
	const runningAgentByToolUseId = new Map(runningAgents.map((entry) => [entry.toolUseId, entry]));
	const runningAgentBySubagentId = new Map(runningAgents.map((entry) => [entry.subagentId, entry]));
	// Only rows owned by a narrator this process is still running may become continuations.
	// See isLiveNarratorForCheckpoint: an unfiltered scan resurrects narrators whose turn
	// ended long ago but left non-terminal tool rows behind.
	//
	// Bounded and column-scoped to match listActiveToolCallIds, which counts the same set for
	// the fence. Selecting whole rows pulled `output_json` for every abandoned call in the
	// database — the one large column this scan never reads — inside a loop that runs up to
	// CHECKPOINT_MAX_ROUNDS times per fence.
	const allNonTerminalToolCalls = await db
		.select({
			id: narratorToolCalls.id,
			narratorId: narratorToolCalls.narratorId,
			toolUseId: narratorToolCalls.toolUseId,
			toolName: narratorToolCalls.toolName,
			inputJson: narratorToolCalls.inputJson,
			status: narratorToolCalls.status,
			executionStartedAt: narratorToolCalls.executionStartedAt,
			createdAt: narratorToolCalls.createdAt,
		})
		.from(narratorToolCalls)
		.where(inArray(narratorToolCalls.status, ["initializing", "pending", "running"]))
		.limit(CHECKPOINT_ACTIVE_TOOL_LIMIT);
	if (allNonTerminalToolCalls.length >= CHECKPOINT_ACTIVE_TOOL_LIMIT) {
		throw new Error(
			`Planned-update checkpoint exceeds the ${CHECKPOINT_ACTIVE_TOOL_LIMIT - 1}-row safety limit`,
		);
	}
	const toolCalls = allNonTerminalToolCalls.filter((toolCall) =>
		isLiveNarratorForCheckpoint(snapshot, toolCall.narratorId),
	);
	const abandonedToolCallCount = allNonTerminalToolCalls.length - toolCalls.length;
	if (abandonedToolCallCount > 0) {
		logger.info("Skipped non-terminal tool calls with no live narrator during checkpoint", {
			updateEpoch: snapshot.updateEpoch,
			skipped: abandonedToolCallCount,
		});
	}
	// Scoped to the unfinished calls instead of every subagent message in the database:
	// the origin map is only consulted for these tool_use ids, and the unscoped version
	// read ~72k rows to build 3.1k mappings when 8 were needed. Empty input means no
	// query at all, which is the common case on a healthy restart.
	const originToolUseIds = toolCalls.flatMap((toolCall) =>
		toolCall.toolUseId ? [toolCall.toolUseId] : [],
	);
	const subagentByOrigin = new Map<string, string>();
	if (originToolUseIds.length > 0) {
		const linkedSubagentMessages = await db
			.select({
				narratorId: narratorMessages.narratorId,
				parentToolUseId: narratorMessages.parentToolUseId,
			})
			.from(narratorMessages)
			.where(inArray(narratorMessages.parentToolUseId, originToolUseIds));
		for (const message of linkedSubagentMessages) {
			if (message.parentToolUseId && !subagentByOrigin.has(message.parentToolUseId)) {
				subagentByOrigin.set(message.parentToolUseId, message.narratorId);
			}
		}
	}

	for (const toolCall of toolCalls) {
		if (toolCall.status === "pending") {
			await toolContinuationService.upsert({
				toolCallId: toolCall.id,
				narratorId: toolCall.narratorId,
				updateEpoch: snapshot.updateEpoch,
				kind: "pending_permission",
				state: "waiting",
				payloadJson: { permissionMode: "normal", toolName: toolCall.toolName },
			});
			continue;
		}
		if (toolCall.status === "initializing") {
			await toolContinuationService.upsert({
				toolCallId: toolCall.id,
				narratorId: toolCall.narratorId,
				updateEpoch: snapshot.updateEpoch,
				kind: "deferred_tool",
				payloadJson: { permissionMode: "normal", toolName: toolCall.toolName },
			});
			continue;
		}
		const input = toolCall.inputJson as Record<string, unknown> | null;
		if (toolCall.toolName === "Send" && input?.await === true) {
			const sendAwait = await waitForStableSendAwaitCheckpoint({
				toolCallId: toolCall.id,
				toolUseId: toolCall.toolUseId,
			});
			if (!sendAwait) continue;
			await toolContinuationService.checkpointSendAwait({
				toolCallId: toolCall.id,
				narratorId: toolCall.narratorId,
				updateEpoch: snapshot.updateEpoch,
				deadlineAt: earliestPendingSendAwaitDeadline(sendAwait),
				payloadJson: { sendAwait },
			});
			continue;
		}
		if (toolCall.toolName === "Agent") {
			const subagentId = subagentByOrigin.get(toolCall.toolUseId);
			if (!subagentId) continue;
			const runtime =
				runningAgentByToolUseId.get(toolCall.toolUseId) ?? runningAgentBySubagentId.get(subagentId);
			const deadline = resolveAgentExecutionDeadline({
				runtimeDeadlineAt: runtime?.executionDeadlineAt,
				runtimeTimeoutMs: runtime?.timeoutMs,
				toolInput: input,
				startedAt: runtime?.startedAt ?? toolCall.executionStartedAt ?? toolCall.createdAt,
			});
			await toolContinuationService.upsert({
				toolCallId: toolCall.id,
				narratorId: toolCall.narratorId,
				updateEpoch: snapshot.updateEpoch,
				kind: "foreground_agent",
				payloadJson: {
					subagentId,
					logicalRunId: runtime?.logicalRunId ?? readAgentLogicalRunId(subagentId),
					...deadline,
				},
			});
			continue;
		}
		const awaitEntry = runningAwaits.get(toolCall.toolUseId);
		if (
			toolCall.toolName === "Await" &&
			(awaitEntry?.awaitType === "agent" || input?.type === "agent")
		) {
			const targetId =
				awaitEntry?.targetId ?? (typeof input?.id === "string" ? input.id : undefined);
			if (!targetId) continue;
			const existingContinuation = await toolContinuationService.getByToolCallId(toolCall.id);
			const deadlineAt =
				awaitEntry?.deadlineAt ??
				payloadString(existingContinuation?.payloadJson ?? null, "awaitDeadlineAt") ??
				new Date(
					Date.now() + (typeof input?.timeout === "number" ? input.timeout : 600_000),
				).toISOString();
			await toolContinuationService.upsert({
				toolCallId: toolCall.id,
				narratorId: toolCall.narratorId,
				updateEpoch: snapshot.updateEpoch,
				kind: "await_agent",
				state: "waiting",
				deadlineAt,
				payloadJson: { targetId, awaitDeadlineAt: deadlineAt },
			});
		}
	}

	const runningBackgroundAgents = await db
		.select()
		.from(backgroundTasks)
		.where(and(eq(backgroundTasks.type, "agent"), eq(backgroundTasks.status, "running")));
	for (const task of runningBackgroundAgents) {
		if (!task.toolUseId) continue;
		const toolCall = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.toolUseId, task.toolUseId),
		});
		if (!toolCall) continue;
		const subagentId = task.subagentNarratorId ?? task.id;
		const runtime =
			runningAgentBySubagentId.get(subagentId) ?? runningAgentByToolUseId.get(task.toolUseId);
		const deadline = resolveAgentExecutionDeadline({
			runtimeDeadlineAt: runtime?.executionDeadlineAt,
			runtimeTimeoutMs: runtime?.timeoutMs,
			toolInput: toolCall.inputJson as Record<string, unknown> | null,
			startedAt: runtime?.startedAt ?? task.startedAt ?? toolCall.executionStartedAt,
			defaultTimeoutMs: BACKGROUND_TASK_TIMEOUT_MS,
		});
		await toolContinuationService.upsert({
			toolCallId: toolCall.id,
			narratorId: toolCall.narratorId,
			updateEpoch: snapshot.updateEpoch,
			kind: "background_agent",
			payloadJson: {
				backgroundTaskId: task.id,
				logicalRunId:
					runtime?.logicalRunId ?? task.logicalRunId ?? readAgentLogicalRunId(subagentId),
				backgroundTaskAlias: task.alias,
				subagentId,
				parentNarratorId: task.parentNarratorId,
				...deadline,
			},
		});
	}

	logger.info("Checkpointed planned-update tool continuations", {
		updateEpoch: snapshot.updateEpoch,
		count: (await toolContinuationService.listByEpoch(snapshot.updateEpoch)).length,
	});
	return snapshot;
}

/**
 * Statuses that prove a narrator was cut off mid-turn rather than stopped deliberately.
 *
 * A user interrupt, an error, and a normal completion all persist a terminal `idle` row before the
 * process goes away (`["interrupted"]`, `["error"]`, `["unread"]`). Only work that was still
 * running when the process was replaced remains `working`/`waiting`. Reading this BEFORE generic
 * startup recovery is essential: `recoverOnStartup` rewrites every `working`/`waiting` row to
 * `idle ["interrupted"]`, after which an update-severed turn is indistinguishable from a turn the
 * user stopped on purpose.
 */
const UPDATE_SEVERED_STATUSES = new Set(["working", "waiting"]);

/**
 * Narrators from the manifest that were still mid-turn when this process took over.
 *
 * Absent from the map means "do not resume": either the row is already terminal (the user stopped
 * it, it failed, or it finished) or its status could not be read. Missing evidence is never
 * treated as permission to resume.
 */
async function loadUpdateSeveredNarrators(
	snapshot: PlannedUpdateRecoverySnapshot,
): Promise<Set<string>> {
	const severed = new Set<string>();
	if (snapshot.narrators.length === 0) return severed;
	const { narratorService } = await import("./narrator-service");
	for (const target of snapshot.narrators) {
		try {
			const narrator = await narratorService.getById(target.narratorId);
			if (UPDATE_SEVERED_STATUSES.has(narrator.status)) severed.add(target.narratorId);
		} catch (error) {
			if (error instanceof NotFoundError) continue;
			logger.warn("Could not classify a planned-update narrator before generic recovery", {
				narratorId: target.narratorId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return severed;
}

/** Read the manifest epoch before generic startup cleanup mutates any protected row. */
export async function getPlannedUpdateStartupProtection(): Promise<{
	snapshot: PlannedUpdateRecoverySnapshot | null;
	protection: ToolContinuationProtectionSets;
	/** Manifest narrators observed mid-turn before generic recovery rewrote their status. */
	severedNarratorIds: ReadonlySet<string>;
}> {
	const snapshot = consumePlannedUpdateRecoverySnapshot();
	if (!snapshot) {
		return { snapshot: null, protection: EMPTY_PROTECTION, severedNarratorIds: new Set() };
	}

	// Ownership is decided before anything is resumed. A manifest this process does not own is
	// removed rather than left in place: keeping it is exactly what made abandoned narrators
	// restart on every subsequent boot.
	const ownership = classifyRecoveryManifestOwnership(snapshot, getObservedRestartHandoff());
	if (!ownership.owned) {
		logger.warn("Discarding a planned-update recovery manifest this process does not own", {
			reason: ownership.reason,
			updateEpoch: snapshot.updateEpoch,
			targetVersion: snapshot.targetVersion ?? null,
			capturedAt: snapshot.capturedAt,
			narratorCount: snapshot.narrators.length,
		});
		removePlannedUpdateRecoverySnapshot({ expectedEpoch: snapshot.updateEpoch });
		return { snapshot: null, protection: EMPTY_PROTECTION, severedNarratorIds: new Set() };
	}

	return {
		snapshot,
		protection: await toolContinuationService.getProtectionSets(snapshot.updateEpoch),
		severedNarratorIds: await loadUpdateSeveredNarrators(snapshot),
	};
}

async function finalizeInterruptedRecoveryParent(
	narratorId: string,
	updateEpoch: string,
	locale: Locale,
	recoveryToken: string,
): Promise<void> {
	const errorMessage = "Narrator interrupted by user";
	// Keep narrator persistence/service lazy: update-service is imported before the full narrator
	// graph during startup and update checks, so eager imports here create a TDZ cycle.
	const [{ narratorPersistence }, { narratorService }] = await Promise.all([
		import("./narrator-persistence"),
		import("./narrator-service"),
	]);
	await toolContinuationService.cancelInterruptibleForNarrator(narratorId, updateEpoch, {
		errorMessage,
		recoveryToken,
		includeOwnerStarted: true,
		includeBackgroundAgentOwner: true,
	});
	// Re-read every row owned by this recovery token so retrying after a partial finalizer is
	// idempotent: cancellation may already be durable while its ToolResult write was delayed.
	const cancelled = (await toolContinuationService.listByEpoch(updateEpoch)).filter(
		(record) =>
			record.narratorId === narratorId &&
			record.state === "cancelled" &&
			record.payloadJson?.recoveryToken === recoveryToken,
	);
	if (cancelled.length === 0) return;

	// Background Agent cancellation retires only the parent's delivery bookkeeping. Its
	// already-running task/result row must remain untouched while ordinary interrupted tools
	// receive their terminal ToolResult below.
	const interruptedToolResults = cancelled.filter((record) => record.kind !== "background_agent");
	const sendAwaits = interruptedToolResults.filter((record) => record.kind === "send_await");
	if (sendAwaits.length > 0) {
		const { formatSendAwaitSnapshotWithFallback } = await import("./agent-communication");
		for (const record of sendAwaits) {
			const snapshot = sendAwaitSnapshotFromPayload(record.payloadJson);
			if (!snapshot) continue;
			const toolCall = await toolContinuationService.getToolCallResult(record.toolCallId);
			if (!toolCall || toolCall.status === "success" || toolCall.status === "fail") continue;
			const result = formatSendAwaitSnapshotWithFallback(snapshot, { status: "aborted" });
			await narratorPersistence.updateToolCallResultIfActive(
				toolCall.toolUseId,
				{
					output: buildRecoveredSendAwaitToolOutput(snapshot, result),
					status: "success",
					completedAt: Date.now(),
				},
				toolCall.messageId,
				toolCall.id,
			);
		}
	}
	const ordinary = interruptedToolResults.filter((record) => record.kind !== "send_await");
	if (ordinary.length > 0) {
		const changed = await db
			.update(narratorToolCalls)
			.set({
				status: "fail",
				errorMessage,
				outputJson: getToolMessage("interruptedByUser", locale),
				outputChars: measureSerializedCharacters(getToolMessage("interruptedByUser", locale)),
				completedAt: new Date().toISOString(),
			})
			.where(
				and(
					inArray(
						narratorToolCalls.id,
						ordinary.map((record) => record.toolCallId),
					),
					inArray(narratorToolCalls.status, ["initializing", "pending", "running"]),
				),
			)
			.returning({ messageId: narratorToolCalls.messageId });
		for (const row of changed) queueContextCharacterRefresh(narratorId, row.messageId);
	}
	await narratorService.updateStatus(narratorId, "idle", {
		substatus: ["interrupted"],
		skipErrorMessage: true,
	});
}

type OwnerContinuationOutcome = "started" | "mounted" | "deferred";

async function continueOwnerWhenReady(
	record: ToolContinuationRecord,
): Promise<OwnerContinuationOutcome> {
	const { narratorService } = await import("./narrator-service");
	let owner: Awaited<ReturnType<typeof narratorService.getById>>;
	try {
		owner = await narratorService.getById(record.narratorId);
	} catch (error) {
		if (error instanceof NotFoundError) return "mounted";
		throw error;
	}
	if (isSubagentVariant(owner.variant)) {
		const epochRows = await toolContinuationService.listByEpoch(record.updateEpoch);
		const owningAgentContinuation = epochRows.find(
			(row) =>
				(row.kind === "foreground_agent" || row.kind === "background_agent") &&
				payloadString(row.payloadJson, "subagentId") === owner.id &&
				row.state !== "cancelled",
		);
		if (owningAgentContinuation) {
			return hasPersistedToolContinuationResult(owningAgentContinuation) ? "mounted" : "deferred";
		}
		const { resumeSubagent } = await import("./subagent-resume");
		try {
			const resumed = await resumeSubagent({
				subagentId: owner.id,
				resumeLogicalRunId: owner.logicalRunId ?? undefined,
				intent: "continue_tool_results",
				actor: "parent_agent",
				locale: "en",
				allowRunningRestart: true,
				skipStaleAttach: true,
			});
			if (resumed.started) return "started";
		} catch (error) {
			const current = await narratorService.getById(owner.id).catch(() => null);
			if (current?.status === "working" || current?.status === "waiting") return "mounted";
			throw error;
		}
		const current = await narratorService.getById(owner.id).catch(() => null);
		if (current?.status === "working" || current?.status === "waiting") return "mounted";
		throw new Error(`Subagent owner continuation did not start for ${owner.id}`);
	}
	const { continueNarrator } = await import("./narrator-session");
	const continued = await continueNarrator(owner.id);
	if (continued.ok) return "started";
	const current = await narratorService.getById(owner.id).catch(() => null);
	if (current?.status === "working" || current?.status === "waiting") return "mounted";
	throw new Error(`Narrator owner continuation did not start for ${owner.id}`);
}

async function restorePersistedTool(
	record: ToolContinuationRecord,
	toolName: string,
	onMounted: () => void,
): Promise<void> {
	const { executePersistedToolCall } = await import("./narrator-session");
	const permissionMode =
		record.payloadJson?.permissionGranted === true ||
		record.payloadJson?.permissionMode === "preGranted"
			? "preGranted"
			: "normal";
	const execution = executePersistedToolCall({
		toolCallId: record.toolCallId,
		narratorId: record.narratorId,
		permissionMode,
	});
	const waitsForAgentRegistration = toolName === "Agent";
	if (!waitsForAgentRegistration) onMounted();
	const result = await execution;
	if (!result.ok) throw new Error(`Persisted tool call could not resume: ${result.reason}`);
	// Agent aliases are registered only after the Agent tool returns its start/completion result.
	// Do not release a following Await/Send barrier before that durable registration exists.
	if (waitsForAgentRegistration) onMounted();
}

async function waitForChildContinuationResults(
	subagentId: string,
	updateEpoch: string,
	signal: AbortSignal,
): Promise<void> {
	while (await toolContinuationService.hasUnwrittenResultsForNarrator(subagentId, updateEpoch)) {
		if (signal.aborted) throw signal.reason ?? new Error("Agent continuation recovery was aborted");
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				clearTimeout(timer);
				reject(signal.reason ?? new Error("Agent continuation recovery was aborted"));
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			}, 25);
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}
}

function persistedToolOutputText(output: unknown): string | null {
	if (typeof output === "string") return output;
	if (typeof output !== "object" || output === null || Array.isArray(output)) return null;
	const text = (output as { _text?: unknown })._text;
	return typeof text === "string" ? text : null;
}

function hasPersistedBackgroundAgentStartResult(input: {
	status: string;
	outputJson: unknown;
}): boolean {
	if (input.status !== "success") return false;
	const output = persistedToolOutputText(input.outputJson);
	return (
		output?.includes("<background_task_id>") === true && output.includes("Background task started.")
	);
}

async function persistRecoveredBackgroundAgentStartResult(
	record: ToolContinuationRecord,
	subagentId: string,
): Promise<void> {
	const toolCall = await toolContinuationService.getToolCallResult(record.toolCallId);
	if (!toolCall) throw new Error("Background Agent tool call was deleted before recovery");
	if (hasPersistedBackgroundAgentStartResult(toolCall)) return;

	const backgroundTaskId = payloadString(record.payloadJson, "backgroundTaskId") ?? subagentId;
	const taskIdOrAlias =
		payloadString(record.payloadJson, "backgroundTaskAlias") ?? backgroundTaskId;
	const [{ buildBackgroundAgentStartOutput }, { narratorService }] = await Promise.all([
		import("./subagent-runner"),
		import("./narrator-service"),
	]);
	await narratorService.updateToolCallResult(
		toolCall.toolUseId,
		{
			output: buildBackgroundAgentStartOutput(taskIdOrAlias),
			status: "success",
			completedAt: Date.now(),
		},
		toolCall.messageId,
		toolCall.id,
	);
}

async function restoreAgent(
	record: ToolContinuationRecord,
	background: boolean,
	locale: Locale,
	signal: AbortSignal,
	onMounted: () => void,
): Promise<void> {
	const subagentId = payloadString(record.payloadJson, "subagentId");
	if (!subagentId) throw new Error("Agent continuation is missing subagentId");
	const executionDeadlineAt = payloadString(record.payloadJson, "executionDeadlineAt") ?? null;
	const executionTimeoutMs = payloadNumber(record.payloadJson, "executionTimeoutMs") ?? null;
	const deadlineMs = timestampMs(executionDeadlineAt);
	const remainingExecutionTimeoutMs =
		deadlineMs === null ? undefined : Math.max(deadlineMs - Date.now(), 0);
	await waitForChildContinuationResults(subagentId, record.updateEpoch, signal);
	const { resumeSubagent } = await import("./subagent-resume");
	const resumeLogicalRunId =
		payloadString(record.payloadJson, "logicalRunId") ??
		readAgentLogicalRunId(subagentId) ??
		(await getRuntimePublicationService().getAgentRun(subagentId, record.narratorId)).logicalRunId;
	const resumed = await resumeSubagent({
		subagentId,
		intent: "continue_tool_results",
		actor: "parent_agent",
		locale,
		signal,
		allowRunningRestart: true,
		skipStaleAttach: true,
		preserveBackground: background,
		skipConclusionDelivery: background,
		resumableUpdateLease: true,
		resumeLogicalRunId,
		timeoutMs: remainingExecutionTimeoutMs,
		executionDeadlineAt,
		executionTimeoutMs,
	});
	if (!resumed.started || !resumed.terminalCompletion) {
		throw new Error("Agent continuation did not expose terminal completion");
	}
	if (
		!(await toolContinuationService.markOwnerContinuationStartedForNarrator(
			subagentId,
			record.updateEpoch,
		))
	) {
		throw new Error(`Failed to persist mounted child continuation for ${subagentId}`);
	}
	if (background) {
		await persistRecoveredBackgroundAgentStartResult(record, subagentId);
		void resumed.terminalCompletion.catch((error) => {
			logger.error("Recovered background Agent terminal completion failed", {
				subagentId,
				toolCallId: record.toolCallId,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		onMounted();
		return;
	}
	onMounted();
	await resumed.terminalCompletion;
	if (signal.aborted) throw signal.reason ?? new Error("Agent continuation recovery was aborted");
}

export function buildRecoveredAwaitToolOutput(
	targetId: string,
	result: { id: string; status: string; formatted: string },
): { _text: string; _metadata: Record<string, unknown> } {
	return {
		_text: result.formatted,
		_metadata: {
			kind: "await",
			awaitType: "agent",
			targetId,
			resolvedId: result.id,
			subagentId: result.id,
			status: result.status,
		},
	};
}

export function buildRecoveredSendAwaitToolOutput(
	snapshot: AgentReplyWaitRunSnapshot,
	result: { output: string; targets: unknown[] },
): { _text: string; _metadata: Record<string, unknown> } {
	return {
		_text: result.output,
		_metadata: {
			kind: "send",
			targets: result.targets,
			doInterrupt: snapshot.doInterrupt,
			await: true,
		},
	};
}

async function restoreAwait(
	record: ToolContinuationRecord,
	signal: AbortSignal,
	onMounted: () => void,
): Promise<void> {
	const targetId = payloadString(record.payloadJson, "targetId");
	if (!targetId) throw new Error("Await continuation is missing targetId");
	const awaitDeadlineAt = payloadString(record.payloadJson, "awaitDeadlineAt") ?? record.deadlineAt;
	const remainingMs = Math.max(
		(awaitDeadlineAt ? Date.parse(awaitDeadlineAt) : Date.now()) - Date.now(),
		0,
	);
	const { awaitAgentResultDetailed } = await import("./agent-communication");
	const waiting = awaitAgentResultDetailed({
		callerNarratorId: record.narratorId,
		id: targetId,
		timeoutMs: remainingMs,
		signal,
	});
	onMounted();
	const result = await waiting;
	if (signal.aborted) throw signal.reason ?? new Error("Await continuation recovery was aborted");
	const toolCall = await db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.id, record.toolCallId),
	});
	if (!toolCall) throw new Error("Await tool call was deleted before recovery");
	const { narratorService } = await import("./narrator-service");
	await narratorService.updateToolCallResult(
		toolCall.toolUseId,
		{
			output: buildRecoveredAwaitToolOutput(targetId, result),
			status: "success",
			completedAt: Date.now(),
		},
		toolCall.messageId,
		toolCall.id,
	);
}

async function waitForPersistedSendAwaitResult(
	toolCallId: string,
	signal: AbortSignal,
): Promise<"persisted" | "stopped"> {
	for (;;) {
		const toolCall = await toolContinuationService.getToolCallResult(toolCallId);
		if (!toolCall || toolCall.status === "success" || toolCall.status === "fail") {
			return "persisted";
		}
		if (signal.aborted) return "stopped";
		await new Promise<void>((resolve) => {
			const onAbort = () => {
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			}, 10);
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}
}

async function restoreSendAwait(
	record: ToolContinuationRecord,
	signal: AbortSignal,
	onMounted: () => void,
): Promise<void> {
	const snapshot = sendAwaitSnapshotFromPayload(record.payloadJson);
	if (!snapshot) throw new Error("Send await continuation is missing its waiter snapshot");
	const { restoreSendAwaitFromSnapshot } = await import("./agent-communication");
	const localAbort = new AbortController();
	const waiterSignal = AbortSignal.any([signal, localAbort.signal]);
	// The async function registers every pending request synchronously before its first await.
	// Marking mounted immediately after the call therefore means responders can safely resume.
	const waiting = restoreSendAwaitFromSnapshot(snapshot, waiterSignal);
	onMounted();
	const persistedResult = waitForPersistedSendAwaitResult(record.toolCallId, localAbort.signal);
	const winner = await Promise.race([
		waiting.then((result) => ({ kind: "waiter" as const, result })),
		persistedResult.then((status) => ({ kind: "database" as const, status })),
	]);
	if (winner.kind === "database") {
		if (winner.status === "persisted") {
			// The old process won the settlement race after checkpointing. Retire the restored
			// waiter and trust its already-durable ToolResult instead of writing a second result.
			localAbort.abort(new Error("Send await ToolResult was persisted by the previous process"));
			await waiting;
			return;
		}
		throw new Error("Send await ToolResult monitor stopped before waiter completion");
	}
	localAbort.abort();
	if (signal.aborted) {
		throw signal.reason ?? new Error("Send await continuation recovery was aborted");
	}
	const toolCall = await toolContinuationService.getToolCallResult(record.toolCallId);
	if (!toolCall) throw new Error("Send tool call was deleted before recovery");
	if (toolCall.status === "success" || toolCall.status === "fail") return;
	const { narratorPersistence } = await import("./narrator-persistence");
	const updated = await narratorPersistence.updateToolCallResultIfActive(
		toolCall.toolUseId,
		{
			output: buildRecoveredSendAwaitToolOutput(snapshot, winner.result),
			status: "success",
			completedAt: Date.now(),
		},
		toolCall.messageId,
		toolCall.id,
	);
	if (updated) return;
	const terminal = await toolContinuationService.getToolCallResult(record.toolCallId);
	if (terminal?.status === "success" || terminal?.status === "fail") return;
	throw new Error("Send ToolResult conditional write lost without a durable terminal result");
}

async function restoreClaimedContinuation(
	record: ToolContinuationRecord,
	toolName: string,
	snapshot: PlannedUpdateRecoverySnapshot,
	signal: AbortSignal,
	onMounted: () => void,
): Promise<void> {
	switch (record.kind) {
		case "deferred_tool":
		case "pending_permission":
			await restorePersistedTool(record, toolName, onMounted);
			return;
		case "foreground_agent":
			await restoreAgent(record, false, localeFor(snapshot, record.narratorId), signal, onMounted);
			return;
		case "background_agent":
			await restoreAgent(record, true, localeFor(snapshot, record.narratorId), signal, onMounted);
			return;
		case "await_agent":
			await restoreAwait(record, signal, onMounted);
			return;
		case "send_await":
			await restoreSendAwait(record, signal, onMounted);
	}
}

async function writeRecoveryToolError(
	record: ToolContinuationRecord,
	recoveryStatus: "execution_unknown" | "failed",
	errorMessage: string,
): Promise<boolean> {
	const toolCall = await db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.id, record.toolCallId),
	});
	if (!toolCall) return false;
	const { narratorService } = await import("./narrator-service");
	await narratorService.updateToolCallResult(
		toolCall.toolUseId,
		{
			output: {
				_text: errorMessage,
				_metadata: { kind: "continuation_recovery", recoveryStatus },
			},
			status: "fail",
			errorMessage,
			completedAt: Date.now(),
		},
		toolCall.messageId,
		toolCall.id,
	);
	return true;
}

async function writeAndFinalizeRecoveryFailure(
	record: ToolContinuationRecord,
	recoveryStatus: "execution_unknown" | "failed",
	errorMessage: string,
): Promise<ToolContinuationRecord | null> {
	if (!(await writeRecoveryToolError(record, recoveryStatus, errorMessage))) return null;
	return toolContinuationService.finalizeRecoveryFailure(record.toolCallId, {
		errorMessage,
		payloadJson: {
			...(record.payloadJson ?? {}),
			recoveryStatus,
			toolErrorWritten: true,
			recoveryPhase: "result_written",
		},
	});
}

async function repairPendingRecoveryFailure(
	record: ToolContinuationRecord,
): Promise<ToolContinuationRecord | null> {
	if (!NON_IDEMPOTENT_KINDS.has(record.kind) || record.state !== "failed") return null;
	const recoveryStatus = record.payloadJson?.recoveryStatus;
	if (recoveryStatus !== "execution_unknown" && recoveryStatus !== "failed") return null;
	if (record.payloadJson?.toolErrorWritten === true) return record;
	const errorMessage = record.errorMessage ?? EXECUTION_UNKNOWN_ERROR;
	return writeAndFinalizeRecoveryFailure(record, recoveryStatus, errorMessage);
}

async function resolveExpiredNonIdempotentClaim(
	record: ToolContinuationRecord,
): Promise<ToolContinuationRecord | null> {
	if (!NON_IDEMPOTENT_KINDS.has(record.kind) || record.state !== "resuming" || !record.claimToken) {
		return null;
	}
	const failed = await toolContinuationService.markExecutionUnknown(record.toolCallId, {
		claimToken: record.claimToken,
		errorMessage: EXECUTION_UNKNOWN_ERROR,
		payloadJson: {
			...(record.payloadJson ?? {}),
			recoveryStatus: "execution_unknown",
			toolErrorWritten: false,
		},
	});
	if (!failed) return null;
	return writeAndFinalizeRecoveryFailure(failed, "execution_unknown", EXECUTION_UNKNOWN_ERROR);
}

async function waitForClaimExpiry(record: ToolContinuationRecord): Promise<void> {
	if (!record.deadlineAt) return;
	const waitMs = Math.max(Date.parse(record.deadlineAt) - Date.now() + 1, 0);
	if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

interface ParentRecoveryInterrupt {
	token: string;
	signal: AbortSignal;
	finalizeInterrupt: () => Promise<void>;
}

async function claimAndRestoreExecution(
	record: ToolContinuationRecord,
	toolName: string,
	snapshot: PlannedUpdateRecoverySnapshot,
	parentInterrupt: ParentRecoveryInterrupt | undefined,
	onMounted: () => void,
): Promise<ToolContinuationRecord> {
	let current = (await toolContinuationService.getByToolCallId(record.toolCallId)) ?? record;
	if (current.kind === "send_await") {
		current =
			(await toolContinuationService.reconcileSendAwaitResult(
				current.toolCallId,
				current.updateEpoch,
			)) ?? current;
	}
	if (current.state === "cancelled") {
		onMounted();
		return current;
	}
	if (hasPersistedToolContinuationResult(current)) {
		onMounted();
		return current;
	}
	const repaired = await repairPendingRecoveryFailure(current);
	if (repaired) {
		onMounted();
		return repaired;
	}

	const claimToken = generateId();
	let claimed = await toolContinuationService.claim(record.toolCallId, {
		claimToken,
		deadlineAt: new Date(Date.now() + CLAIM_LEASE_MS).toISOString(),
	});
	if (!claimed) {
		current = (await toolContinuationService.getByToolCallId(record.toolCallId)) ?? current;
		if (current.state === "cancelled") {
			onMounted();
			return current;
		}
		if (hasPersistedToolContinuationResult(current)) {
			onMounted();
			return current;
		}
		const repairedCurrent = await repairPendingRecoveryFailure(current);
		if (repairedCurrent) {
			onMounted();
			return repairedCurrent;
		}
		if (current.state !== "resuming") {
			throw new Error(`Continuation ${record.toolCallId} could not be claimed`);
		}
		await waitForClaimExpiry(current);
		current = (await toolContinuationService.getByToolCallId(record.toolCallId)) ?? current;
		if (current.state === "cancelled") {
			onMounted();
			return current;
		}
		if (hasPersistedToolContinuationResult(current)) {
			onMounted();
			return current;
		}
		const repairedExpired = await repairPendingRecoveryFailure(current);
		if (repairedExpired) {
			onMounted();
			return repairedExpired;
		}
		const executionUnknown = await resolveExpiredNonIdempotentClaim(current);
		if (executionUnknown) {
			onMounted();
			return executionUnknown;
		}
		claimed = await toolContinuationService.claim(record.toolCallId, {
			claimToken,
			deadlineAt: new Date(Date.now() + CLAIM_LEASE_MS).toISOString(),
		});
		if (!claimed) throw new Error(`Continuation ${record.toolCallId} lost its recovery claim`);
	}

	const abortController = new AbortController();
	const renewal = RENEWABLE_KINDS.has(claimed.kind)
		? startContinuationClaimRenewal(record.toolCallId, claimToken, abortController)
		: null;
	const restorationSignal =
		parentInterrupt && claimed.kind !== "background_agent"
			? AbortSignal.any([abortController.signal, parentInterrupt.signal])
			: abortController.signal;
	try {
		const restoration = restoreClaimedContinuation(
			claimed,
			toolName,
			snapshot,
			restorationSignal,
			onMounted,
		);
		if (renewal) {
			await renewal.run(restoration);
			await renewal.verify();
		} else {
			await restoration;
		}
		const resultWritten = await toolContinuationService.markResultWritten(record.toolCallId, {
			claimToken,
		});
		if (!resultWritten) {
			const currentAfterRestore = await toolContinuationService.getByToolCallId(record.toolCallId);
			if (currentAfterRestore?.state === "cancelled") {
				// Parent interrupt may retire a background Agent's parent-delivery continuation
				// while its detached runner keeps executing. That cancellation is authoritative;
				// do not turn the expected claim loss into recovery/readiness failure.
				onMounted();
				return currentAfterRestore;
			}
			throw new Error(`Failed to persist tool result recovery phase for ${record.toolCallId}`);
		}
		return resultWritten;
	} catch (error) {
		if (parentInterrupt?.signal.aborted) {
			// Abort propagation is synchronous, while the durable interrupt finalizer is async.
			// Join that same token-scoped finalizer before classifying the recovery outcome so a
			// normal user interrupt can never be persisted as a failed continuation.
			await parentInterrupt.finalizeInterrupt();
			const interrupted = await toolContinuationService.getByToolCallId(record.toolCallId);
			if (interrupted?.state === "cancelled") {
				onMounted();
				return interrupted;
			}
			throw new Error(`Interrupted continuation ${record.toolCallId} was not cancelled`);
		}
		const message = error instanceof Error ? error.message : String(error);
		const payloadJson = NON_IDEMPOTENT_KINDS.has(claimed.kind)
			? { ...(claimed.payloadJson ?? {}), recoveryStatus: "failed", toolErrorWritten: false }
			: undefined;
		const failed = await toolContinuationService.fail(record.toolCallId, {
			claimToken,
			errorMessage: message,
			payloadJson,
		});
		if (failed && NON_IDEMPOTENT_KINDS.has(failed.kind)) {
			const finalized = await writeAndFinalizeRecoveryFailure(failed, "failed", message);
			if (finalized) return finalized;
		}
		throw error;
	} finally {
		renewal?.stop();
	}
}

async function settleInterruptedOwnerDelivery(
	record: ToolContinuationRecord,
	parentInterrupt: ParentRecoveryInterrupt,
): Promise<boolean> {
	if (!parentInterrupt.signal.aborted) return false;
	const { abortActiveNarratorLoopForPlannedUpdateRecovery } = await import("./narrator-session");
	abortActiveNarratorLoopForPlannedUpdateRecovery(record.narratorId, parentInterrupt.token);
	await parentInterrupt.finalizeInterrupt();
	const current = await toolContinuationService.getByToolCallId(record.toolCallId);
	if (current?.state === "cancelled") return true;
	if (current && isToolContinuationOwnerMounted(current)) return true;
	throw new Error(`Interrupted owner delivery ${record.toolCallId} was not cancelled`);
}

async function deliverRecoveredMessageOwner(
	record: ToolContinuationRecord,
	messageId: string,
	parentInterrupt?: ParentRecoveryInterrupt,
): Promise<void> {
	const rows = await toolContinuationService.markOwnerContinuationPendingForMessage(
		messageId,
		record.updateEpoch,
		parentInterrupt?.token,
	);
	if (!rows) {
		if (parentInterrupt && (await settleInterruptedOwnerDelivery(record, parentInterrupt))) return;
		throw new Error(`Tool results are not ready for owner delivery of ${messageId}`);
	}
	if (rows.every(isToolContinuationOwnerMounted)) return;

	// The pending write can race a user interrupt. Re-read the token-scoped durable state before
	// starting the owner so a delayed finalizer is joined instead of being mistaken for failure.
	const pending = await toolContinuationService.getByToolCallId(record.toolCallId);
	if (pending?.state === "cancelled") return;
	if (parentInterrupt) {
		if (pending?.payloadJson?.recoveryToken !== parentInterrupt.token) {
			throw new Error(`Owner delivery recovery token changed for ${record.toolCallId}`);
		}
		if (await settleInterruptedOwnerDelivery(record, parentInterrupt)) return;
	}

	const onlyBackgroundAgents = rows.every((row) => row.kind === "background_agent");
	if (!onlyBackgroundAgents) {
		const outcome = await continueOwnerWhenReady(record);
		// An interrupt can land after continueNarrator's admission check but before its active loop
		// becomes visible to interruptNarrator. Abort that newly-started loop without recursively
		// re-triggering planned-update control, then join the token's durable finalizer.
		if (parentInterrupt && (await settleInterruptedOwnerDelivery(record, parentInterrupt))) return;
		if (outcome === "deferred") return;
	}
	const started = await toolContinuationService.markOwnerContinuationStartedForMessage(
		messageId,
		record.updateEpoch,
		parentInterrupt?.token,
	);
	if (parentInterrupt && (await settleInterruptedOwnerDelivery(record, parentInterrupt))) return;
	if (!started) {
		throw new Error(`Failed to persist owner continuation delivery for ${messageId}`);
	}
}

interface RecoveryQueueHandle {
	mounted: Promise<void>;
	completion: Promise<void>;
}

function restoreRecoveryQueue(
	queue: ToolContinuationRecoveryItem[],
	snapshot: PlannedUpdateRecoverySnapshot,
	parentInterrupts: ReadonlyMap<string, ParentRecoveryInterrupt>,
): RecoveryQueueHandle {
	const mountedPromises: Promise<void>[] = [];
	type ScheduledRun = {
		mounted: Promise<void>;
		executionMounted: Promise<void>;
		markReady: () => void;
		run: () => Promise<ToolContinuationRecord>;
		prestarted?: Promise<ToolContinuationRecord>;
	};
	const plans = groupContinuationRecoveryItems(queue).map((messageItems) => {
		const executionGroups = groupToolExecutions(messageItems);
		const runs = new Map<ToolContinuationRecoveryItem, ScheduledRun>();

		for (const [groupIndex, executionGroup] of executionGroups.entries()) {
			const previousGroup = executionGroups[groupIndex - 1];
			const followsAgentMountBarrier = isAgentDependentToolExecutionGroup(
				previousGroup,
				executionGroup,
			);
			for (const item of executionGroup) {
				const {
					promise: mounted,
					resolve: resolveMounted,
					reject: rejectMounted,
				} = Promise.withResolvers<void>();
				const {
					promise: executionMounted,
					resolve: resolveExecutionMounted,
					reject: rejectExecutionMounted,
				} = Promise.withResolvers<void>();
				mountedPromises.push(mounted);
				let mountedSettled = false;
				let executionMountedSettled = false;
				const markReady = () => {
					if (mountedSettled) return;
					mountedSettled = true;
					resolveMounted();
				};
				const markExecutionMounted = () => {
					if (!executionMountedSettled) {
						executionMountedSettled = true;
						resolveExecutionMounted();
					}
					markReady();
				};
				const rejectMounts = (error: unknown) => {
					if (!executionMountedSettled) {
						executionMountedSettled = true;
						rejectExecutionMounted(error);
					}
					if (!mountedSettled) {
						mountedSettled = true;
						rejectMounted(error);
					}
				};
				// Most queued groups are safe to report as mounted before execution. The direct
				// Await/Send follower of an Agent is different: its real waiter/message setup must
				// wait for the Agent's durable registration and therefore has an execution-mounted gate.
				void executionMounted.catch(() => {});
				const scheduled: ScheduledRun = {
					mounted,
					executionMounted,
					markReady,
					run: async () => {
						try {
							if (isToolContinuationOwnerMounted(item.record)) {
								markExecutionMounted();
								return item.record;
							}
							if (
								(item.record.kind === "deferred_tool" ||
									item.record.kind === "pending_permission") &&
								item.toolName === "Agent"
							) {
								// A not-yet-started foreground Agent may run for a long time. Count it as
								// protected for overall startup readiness, while keeping executionMounted
								// pending until its alias has actually been registered.
								markReady();
							}
							return await claimAndRestoreExecution(
								item.record,
								item.toolName,
								snapshot,
								parentInterrupts.get(item.record.narratorId),
								markExecutionMounted,
							);
						} catch (error) {
							rejectMounts(error);
							throw error;
						}
					},
				};
				runs.set(item, scheduled);
				// Later groups are queued behind an earlier barrier and count as safely mounted,
				// except Send await and an Agent-dependent Await/Send group: both need their real
				// responder/waiter setup to exist before planned-update recovery becomes ready.
				if (groupIndex > 0 && item.record.kind !== "send_await" && !followsAgentMountBarrier) {
					markReady();
				}
			}
		}
		return { messageItems, executionGroups, runs };
	});

	// Globally install every Send await waiter before any Agent/Await continuation can run.
	// These prestarts perform no delivery and therefore may safely bypass message barriers;
	// their result promises are still consumed at the original execution-group position.
	const sendMounts: Promise<void>[] = [];
	for (const plan of plans) {
		for (const item of plan.messageItems) {
			if (item.record.kind !== "send_await" || isToolContinuationOwnerMounted(item.record))
				continue;
			const scheduled = plan.runs.get(item);
			if (!scheduled) throw new Error("Send await recovery item was not scheduled");
			scheduled.prestarted = scheduled.run();
			// A prestart failure rejects `mounted`, which fails the barrier below before the
			// execution loop can reach this item's original position. Observe the run promise now
			// so the same error is not also reported as an unhandled rejection; the loop still
			// consumes it (and propagates it) whenever it does get that far.
			void scheduled.prestarted.catch(() => {});
			sendMounts.push(scheduled.mounted);
		}
	}
	const sendWaitersMounted = Promise.all(sendMounts).then(() => undefined);

	const messageCompletions = plans.map((plan) =>
		(async () => {
			await sendWaitersMounted;
			let activeRuns: Promise<ToolContinuationRecord>[] = [];
			for (const [groupIndex, executionGroup] of plan.executionGroups.entries()) {
				const previousGroup = plan.executionGroups[groupIndex - 1];
				const followsAgentMountBarrier = isAgentDependentToolExecutionGroup(
					previousGroup,
					executionGroup,
				);
				if (followsAgentMountBarrier && previousGroup) {
					// An Await/Send after Agent must not race the spawn, but it only depends on
					// the Agent being registered/running — not on its terminal completion. Keep
					// the previous group's completion active so the next ordinary barrier still
					// waits for both groups.
					await Promise.all(
						previousGroup.map((item) => {
							const scheduled = plan.runs.get(item);
							if (!scheduled) throw new Error("Recovery item was not scheduled");
							return scheduled.executionMounted;
						}),
					);
				} else {
					await Promise.all(activeRuns);
					activeRuns = [];
				}

				for (const item of executionGroup) {
					const scheduled = plan.runs.get(item);
					if (!scheduled) throw new Error("Recovery item was not scheduled");
					const run = scheduled.prestarted ?? scheduled.run();
					// Keep errors observed while a later Agent-dependent group is being mounted;
					// the next normal barrier or final join still propagates the same rejection.
					void run.catch(() => {});
					activeRuns.push(run);
				}
			}
			await Promise.all(activeRuns);
			await deliverRecoveredMessageOwner(
				plan.messageItems[0].record,
				plan.messageItems[0].messageId,
				parentInterrupts.get(plan.messageItems[0].record.narratorId),
			);
		})(),
	);
	return {
		mounted: Promise.all(mountedPromises).then(() => undefined),
		completion: Promise.all(messageCompletions).then(() => undefined),
	};
}

/**
 * Resume manifest narrators that have no durable tool continuation to drive them.
 *
 * Two rules keep this from reviving abandoned work:
 *
 *  - Only narrators observed mid-turn before generic recovery ran are resumed. `continueNarrator`
 *    feeds a "Continue." turn when there is no tool-result packet to replay, so resuming a session
 *    the user interrupted (or one that already failed) makes an old plan act on current code.
 *  - A failure here is never written back to the manifest. The manifest is owned by one spawned
 *    replacement process, so a retry entry could only ever be consumed by a startup that does not
 *    own it — which is precisely how abandoned narrators came back on every boot. The failure is
 *    reported (and logged) instead, and the manifest is dropped with the rest of this epoch.
 */
async function restoreLegacyNarrators(
	snapshot: PlannedUpdateRecoverySnapshot,
	protection: ToolContinuationProtectionSets,
	severedNarratorIds: ReadonlySet<string>,
): Promise<void> {
	const { narratorService } = await import("./narrator-service");
	const failures: string[] = [];
	let skipped = 0;
	for (const target of snapshot.narrators) {
		if (protection.narratorIds.has(target.narratorId)) continue;
		if (!severedNarratorIds.has(target.narratorId)) {
			skipped++;
			continue;
		}
		try {
			const narrator = await narratorService.getById(target.narratorId);
			if (isSubagentVariant(narrator.variant)) continue;
			const { continueNarrator } = await import("./narrator-session");
			const continued = await continueNarrator(
				target.narratorId,
				target.locale as Locale,
				target.replyInUserLanguage ?? false,
				target.userId ?? null,
			);
			if (!continued.ok) {
				const current = await narratorService.getById(target.narratorId);
				if (current.status !== "working" && current.status !== "waiting") {
					throw new Error("Legacy narrator continuation did not start");
				}
			}
		} catch (error) {
			if (error instanceof NotFoundError) continue;
			failures.push(target.narratorId);
			logger.warn("Failed to resume legacy planned-update narrator", {
				narratorId: target.narratorId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (skipped > 0) {
		logger.info("Skipped planned-update narrators that were not severed by the update", {
			updateEpoch: snapshot.updateEpoch,
			skipped,
		});
	}
	if (failures.length > 0) {
		throw new Error(
			`Failed to mount ${failures.length} legacy narrator continuations: ${failures.join(", ")}`,
		);
	}
}

/**
 * Consume messages a user queued while recovery held these narrators busy.
 *
 * `pushBufferedMessage` accepts input for a narrator whose runtime is claimed by a
 * loop-less recovery stage, which is what keeps a post-restart send from starting a
 * second agent loop beside the work being restored. The queue then needs an owner.
 * Recovery paths that call `continueNarrator` provide one; a background-agents-only
 * epoch does not, so this sweep is the sole consumer for that case.
 *
 * Best-effort per narrator: a failure here must never turn a successful recovery into
 * a reported failure, and `resumeBufferedMessagesIfIdle` already declines whenever
 * another owner exists or the narrator must not be woken.
 */
async function drainQueuedMessagesAfterRecovery(
	snapshot: PlannedUpdateRecoverySnapshot,
	narratorIds: readonly string[],
): Promise<void> {
	if (narratorIds.length === 0) return;
	const { resumeBufferedMessagesIfIdle } = await import("./narrator-session");
	for (const narratorId of narratorIds) {
		const target = snapshot.narrators.find((entry) => entry.narratorId === narratorId);
		await resumeBufferedMessagesIfIdle(
			narratorId,
			localeFor(snapshot, narratorId),
			target?.replyInUserLanguage ?? false,
		).catch((error) => {
			logger.warn("Failed to resume queued messages after planned-update recovery", {
				narratorId,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}
}

export interface PlannedUpdateRecoveryHandle {
	/** Resolves after every long-running recovery and owner delivery reaches a safe boundary. */
	completion: Promise<void>;
}

/**
 * Mount ordered continuation recovery in memory and return without waiting for Agent/Await,
 * permission, or AskUserQuestion terminal completion. The returned completion drives readiness
 * failure reporting and manifest cleanup in the background.
 */
export async function restoreNarratorsAfterPlannedUpdate(prepared?: {
	snapshot: PlannedUpdateRecoverySnapshot | null;
	protection: ToolContinuationProtectionSets;
	severedNarratorIds?: ReadonlySet<string>;
}): Promise<PlannedUpdateRecoveryHandle | null> {
	const startup = prepared ?? (await getPlannedUpdateStartupProtection());
	const { snapshot, protection } = startup;
	const severedNarratorIds = startup.severedNarratorIds ?? new Set<string>();
	if (!snapshot) {
		flushRuntimePublications();
		return null;
	}
	const queue = (
		await toolContinuationService.listRecoveryQueueByEpoch(snapshot.updateEpoch)
	).filter(({ record }) => record.state !== "cancelled" && !isToolContinuationOwnerMounted(record));
	const { registerPlannedUpdateRecoveryController } = await import("./narrator-session");
	const parentControls = new Map<
		string,
		{
			controller: AbortController;
			registration: ReturnType<typeof registerPlannedUpdateRecoveryController>;
		}
	>();
	for (const narratorId of new Set(queue.map(({ record }) => record.narratorId))) {
		const controller = new AbortController();
		const recoveryToken = generateId();
		await toolContinuationService.bindRecoveryTokenForNarrator(
			narratorId,
			snapshot.updateEpoch,
			recoveryToken,
		);
		const registration = registerPlannedUpdateRecoveryController(
			narratorId,
			controller,
			(token) =>
				finalizeInterruptedRecoveryParent(
					narratorId,
					snapshot.updateEpoch,
					localeFor(snapshot, narratorId),
					token,
				),
			{
				token: recoveryToken,
				// The subagents this owner re-drives in the foreground. Named individually
				// because their continuation runs on a signal that is not this narrator's,
				// so an interrupt cannot otherwise find them — and so it cannot reach the
				// parent's other children either.
				foregroundSubagentIds: queue.flatMap(({ record }) => {
					if (record.narratorId !== narratorId || record.kind !== "foreground_agent") return [];
					const subagentId = payloadString(record.payloadJson, "subagentId");
					return subagentId ? [subagentId] : [];
				}),
			},
		);
		parentControls.set(narratorId, { controller, registration });
	}
	const queueRecovery = restoreRecoveryQueue(
		queue,
		snapshot,
		new Map(
			[...parentControls].map(([narratorId, control]) => [
				narratorId,
				{
					token: control.registration.token,
					signal: control.controller.signal,
					finalizeInterrupt: control.registration.finalizeInterrupt,
				},
			]),
		),
	);
	try {
		await queueRecovery.mounted;
	} catch (error) {
		// `completion` was created eagerly alongside `mounted` and shares its rejection. Nobody
		// will ever await it on this path, so observe it here — otherwise the same failure is
		// reported a second time as a process-level unhandled rejection.
		void queueRecovery.completion.catch(() => {});
		for (const control of parentControls.values()) control.registration.unregister();
		throw error;
	}

	const completion = (async () => {
		try {
			await queueRecovery.completion;
			const unfinished = (await toolContinuationService.listByEpoch(snapshot.updateEpoch)).filter(
				(row) => !isToolContinuationOwnerMounted(row),
			);
			if (unfinished.length > 0) {
				throw new Error(`${unfinished.length} continuation owner deliveries remain unfinished`);
			}
			await restoreLegacyNarrators(snapshot, protection, severedNarratorIds);
			// Only clear the manifest this recovery pass owns. If a newer update already replaced it,
			// the epoch guard keeps the newer manifest intact.
			removePlannedUpdateRecoverySnapshot({ expectedEpoch: snapshot.updateEpoch });
		} finally {
			for (const control of parentControls.values()) control.registration.unregister();
			// Only now, with every runtime claim released, can queued input be judged
			// orphaned. Messages sent while recovery held these narrators busy are
			// consumed by whichever loop recovery started; a background-agents-only
			// epoch starts no loop at all, so those queues would otherwise stay stuck.
			await drainQueuedMessagesAfterRecovery(snapshot, [...parentControls.keys()]);
			flushRuntimePublications();
		}
	})();
	void completion.catch((error) => {
		logger.error("Planned-update background continuation recovery failed", {
			updateEpoch: snapshot.updateEpoch,
			error: error instanceof Error ? error.message : String(error),
		});
	});
	return { completion };
}
