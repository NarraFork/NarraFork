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
import { getToolMessage, type Locale } from "../lib/prompt-i18n";
import { getObservedRestartHandoff } from "../lib/restart-handoff";
import { executionPrincipalOf } from "../lib/runtime-source";
import {
	type RunBindingInput,
	readRuntimeRegistrationColumn,
} from "../lib/validators/runtime-registration";
import { buildRetiredSendAwaitToolOutput, sendAwaitSnapshotFromPayload } from "./legacy-send-await";
import {
	getRecoverySource,
	getRegisteredRecoverySource,
	invalidateRecoveryTarget,
	type RecoverySource,
	type RecoverySourceHandle,
	registerRecoverySource,
	withRecoveryAdvance,
} from "./recovery-handoff";
import {
	type EpochScope,
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
	writePlannedUpdateRecoverySnapshot,
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

function timestampMs(value: string | number | Date | null | undefined): number | null {
	if (value == null) return null;
	const parsed =
		value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
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
	return (recoveryTargets(snapshot).find((target) => target.narratorId === narratorId)?.locale ??
		"en") as Locale;
}

export function recoveryEpochScope(snapshot: PlannedUpdateRecoverySnapshot): EpochScope {
	return snapshot.sources?.length
		? [snapshot.updateEpoch, ...snapshot.sources.map((source) => source.updateEpoch)]
		: snapshot.updateEpoch;
}

function recoveryTargets(snapshot: PlannedUpdateRecoverySnapshot) {
	return [
		...new Map(
			[
				...(snapshot.sources?.flatMap((source) => source.narrators) ?? []),
				...snapshot.narrators,
			].map((target) => [target.narratorId, target]),
		).values(),
	];
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
	options: { leaseMs?: number; intervalMs?: number; updateEpoch?: string } = {},
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
				updateEpoch: options.updateEpoch,
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
	const [{ BACKGROUND_TASK_TIMEOUT_MS }, { listDeliveringRuns }] = await Promise.all([
		import("./subagent-runner"),
		import("./agent-runtime/run"),
	]);
	// The live run registry: absolute deadlines and run ids are registered facts.
	const runningAgents = listDeliveringRuns().map((run) => ({
		...run,
		subagentId: run.narratorId,
		executionDeadlineAt: run.deadlineAt,
		timeoutMs: null,
	}));
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

	for (const [index, toolCall] of toolCalls.entries()) {
		if (index > 0 && index % 100 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
		if (toolCall.status === "pending") {
			await toolContinuationService.checkpoint({
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
			await toolContinuationService.checkpoint({
				toolCallId: toolCall.id,
				narratorId: toolCall.narratorId,
				updateEpoch: snapshot.updateEpoch,
				kind: "deferred_tool",
				payloadJson: { permissionMode: "normal", toolName: toolCall.toolName },
			});
			continue;
		}
		const input = toolCall.inputJson as Record<string, unknown> | null;
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
			await toolContinuationService.checkpoint({
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
			await toolContinuationService.checkpoint({
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
		await toolContinuationService.checkpoint({
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

	const checkpointRows = await toolContinuationService.listByEpoch(recoveryEpochScope(snapshot));
	if (snapshot.sources?.length) {
		const evidence = new Map<string, { toolCallId: string; executionAttempt: number }[]>();
		for (let offset = 0; offset < checkpointRows.length; offset += 100) {
			const batch = checkpointRows.slice(offset, offset + 100);
			const calls = await db
				.select({
					id: narratorToolCalls.id,
					executionAttempt: narratorToolCalls.executionAttempt,
					executionStartedAt: narratorToolCalls.executionStartedAt,
					status: narratorToolCalls.status,
				})
				.from(narratorToolCalls)
				.where(
					inArray(
						narratorToolCalls.id,
						batch.map((row) => row.toolCallId),
					),
				);
			for (const call of calls) {
				if (call.executionStartedAt != null || !["initializing", "pending"].includes(call.status))
					continue;
				const epoch = batch.find((row) => row.toolCallId === call.id)?.updateEpoch;
				if (epoch)
					evidence.set(epoch, [
						...(evidence.get(epoch) ?? []),
						{
							toolCallId: call.id,
							executionAttempt: call.executionAttempt,
						},
					]);
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		snapshot.sources = snapshot.sources.map((source) => ({
			...source,
			unstartedTools: evidence.get(source.updateEpoch) ?? [],
		}));
	}
	logger.info("Checkpointed planned-update tool continuations", {
		updateEpoch: snapshot.updateEpoch,
		count: checkpointRows.length,
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
	for (const [index, target] of snapshot.narrators.entries()) {
		if (index > 0 && index % 100 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
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
export async function getPlannedUpdateStartupProtection(
	options: {
		claimAuthorization?: boolean;
		onTargetsDiscovered?: (narratorIds: readonly string[]) => void;
	} = {},
): Promise<{
	snapshot: PlannedUpdateRecoverySnapshot | null;
	protection: ToolContinuationProtectionSets;
	/** Manifest narrators observed mid-turn before generic recovery rewrote their status. */
	severedNarratorIds: ReadonlySet<string>;
}> {
	const snapshot = consumePlannedUpdateRecoverySnapshot();
	if (!snapshot) {
		return { snapshot: null, protection: EMPTY_PROTECTION, severedNarratorIds: new Set() };
	}

	if (options.claimAuthorization !== false && getRegisteredRecoverySource(snapshot.updateEpoch)) {
		// Already claimed by this process: preserve evidence and never clear a live cold claim.
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

	// Publish only owned, bounded manifest targets before continuation validation can fail.
	options.onTargetsDiscovered?.(recoveryTargets(snapshot).map((target) => target.narratorId));
	let claimedSnapshot = snapshot;
	if (snapshot.resumeOnNextStartup && options.claimAuthorization !== false) {
		// Claim before mounting any owner. Keep evidence for this recovery pass, but a later
		// ordinary boot must not replay the authorization if recovery crashes or fails.
		claimedSnapshot = writePlannedUpdateRecoverySnapshot(
			{ ...snapshot, resumeOnNextStartup: false, evidenceOnly: true },
			{ expectedEpoch: snapshot.updateEpoch },
		);
	}

	const scope = recoveryEpochScope(snapshot);
	// This bounded load checks the combined row/payload budget before any cold repair or mount.
	const records = await toolContinuationService.listByEpoch(scope);
	let protection = await toolContinuationService.getProtectionSets(scope);
	const severedNarratorIds = await loadUpdateSeveredNarrators(snapshot);
	if (options.claimAuthorization !== false) {
		const sources: RecoverySource[] = [
			{
				updateEpoch: snapshot.updateEpoch,
				kind: "planned",
				capturedAt: snapshot.capturedAt,
				narrators: snapshot.narrators,
				pendingNarratorIds: snapshot.narrators
					.filter(
						(target) =>
							severedNarratorIds.has(target.narratorId) ||
							records.some(
								(row) =>
									row.narratorId === target.narratorId && !isToolContinuationOwnerMounted(row),
							),
					)
					.map((target) => target.narratorId),
			},
			...(snapshot.sources ?? []),
		];
		for (const source of sources)
			registerRecoverySource(
				source,
				source.updateEpoch === snapshot.updateEpoch
					? { manifestIdentity: JSON.stringify(claimedSnapshot) }
					: undefined,
			);
		const evidence = snapshot.sources?.flatMap((source) => source.unstartedTools ?? []) ?? [];
		if (evidence.length > 0 || snapshot.sources?.length) {
			const pass = toolContinuationService.beginColdRecoveryPass({
				rootEpoch: snapshot.updateEpoch,
				sourceEpochs: sources.map((source) => source.updateEpoch),
				unstartedTools: evidence,
			});
			try {
				for (const [index, receipt] of evidence.entries()) {
					if (index > 0 && index % 100 === 0)
						await new Promise((resolve) => setTimeout(resolve, 0));
					const record = records.find((row) => row.toolCallId === receipt.toolCallId);
					if (!record || !NON_IDEMPOTENT_KINDS.has(record.kind) || record.state !== "resuming")
						continue;
					await toolContinuationService.controlledColdTakeover(
						{
							toolCallId: record.toolCallId,
							narratorId: record.narratorId,
							updateEpoch: record.updateEpoch,
							kind: record.kind,
							state: "paused",
							payloadJson: record.payloadJson,
							deadlineAt: record.deadlineAt,
						},
						{
							sourceEpoch: record.updateEpoch,
							executionAttempt: receipt.executionAttempt,
							authorization: pass.authorization,
						},
					);
					if (index > 0 && index % 100 === 0)
						await new Promise((resolve) => setTimeout(resolve, 0));
				}
				// A permission/deferred Agent may have started after the handoff receipt. Reattach
				// only its persisted original child; never execute the original Agent tool again.
				for (const [index, record] of records.entries()) {
					if (index > 0 && index % 100 === 0)
						await new Promise((resolve) => setTimeout(resolve, 0));
					if (
						record.state === "cancelled" ||
						hasPersistedToolContinuationResult(record) ||
						!snapshot.sources?.some((source) => source.updateEpoch === record.updateEpoch)
					)
						continue;
					const call = await db.query.narratorToolCalls.findFirst({
						where: eq(narratorToolCalls.id, record.toolCallId),
						columns: { toolName: true, executionStartedAt: true, executionAttempt: true },
					});
					if (call?.toolName !== "Agent" || call.executionStartedAt == null) continue;
					const child = await db.query.narrators.findFirst({
						where: and(
							eq(narrators.originToolCallId, record.toolCallId),
							eq(narrators.parentNarratorId, record.narratorId),
						),
						columns: { id: true, logicalRunId: true },
					});
					if (!child?.logicalRunId) continue;
					const background = await db.query.backgroundTasks.findFirst({
						where: and(
							eq(backgroundTasks.subagentNarratorId, child.id),
							eq(backgroundTasks.status, "running"),
						),
						columns: { id: true, alias: true },
					});
					await toolContinuationService.controlledColdReattachAgent(
						{
							toolCallId: record.toolCallId,
							narratorId: record.narratorId,
							updateEpoch: record.updateEpoch,
							kind: background ? "background_agent" : "foreground_agent",
							payloadJson: {
								...record.payloadJson,
								subagentId: child.id,
								logicalRunId: child.logicalRunId,
								...(background
									? { backgroundTaskId: background.id, backgroundTaskAlias: background.alias }
									: {}),
							},
						},
						{
							sourceEpoch: record.updateEpoch,
							executionAttempt: call.executionAttempt,
							authorization: pass.authorization,
							subagentId: child.id,
							logicalRunId: child.logicalRunId,
						},
					);
					if (index > 0 && index % 100 === 0)
						await new Promise((resolve) => setTimeout(resolve, 0));
				}
			} finally {
				pass.close();
			}
			// Reattachment can add a child/task absent from the original pending-permission row.
			protection = await toolContinuationService.getProtectionSets(scope);
		}
	}
	for (const source of snapshot.sources ?? []) {
		// Explicit handoff eligibility survives generic cleanup's idle/interrupted rewrite.
		for (const id of source.pendingNarratorIds) {
			if (source.kind === "planned") severedNarratorIds.add(id);
			else protection.narratorIds.add(id);
		}
	}
	return { snapshot, protection, severedNarratorIds };
}

async function finalizeInterruptedRecoveryParent(
	narratorId: string,
	updateEpoch: EpochScope,
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
	// A legacy Send await already delivered its message: close it, never fail it.
	const sendAwaits = interruptedToolResults.filter((record) => record.kind === "send_await");
	if (sendAwaits.length > 0) {
		for (const record of sendAwaits) {
			const snapshot = sendAwaitSnapshotFromPayload(record.payloadJson);
			if (!snapshot) continue;
			const toolCall = await toolContinuationService.getToolCallResult(record.toolCallId);
			if (!toolCall || toolCall.status === "success" || toolCall.status === "fail") continue;
			await narratorPersistence.updateToolCallResultIfActive(
				toolCall.toolUseId,
				{
					output: buildRetiredSendAwaitToolOutput(snapshot),
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
	recoveringToolCallIds?: ReadonlySet<string>,
	scope: EpochScope = record.updateEpoch,
): Promise<OwnerContinuationOutcome> {
	const { narratorService } = await import("./narrator-service");
	let owner: Awaited<ReturnType<typeof narratorService.getById>>;
	try {
		owner = await narratorService.getById(record.narratorId);
	} catch (error) {
		if (error instanceof NotFoundError) return "mounted";
		throw error;
	}
	// A session whose run another continuation re-drives (it owes that run's result to
	// a recovering tool call) is mounted by that continuation, not here.
	const epochRows = await toolContinuationService.listByEpoch(scope);
	const owningAgentContinuation = epochRows.find(
		(row) =>
			(row.kind === "foreground_agent" || row.kind === "background_agent") &&
			payloadString(row.payloadJson, "subagentId") === owner.id &&
			row.state !== "cancelled",
	);
	if (
		owningAgentContinuation &&
		(!recoveringToolCallIds || recoveringToolCallIds.has(owningAgentContinuation.toolCallId))
	) {
		return hasPersistedToolContinuationResult(owningAgentContinuation) ? "mounted" : "deferred";
	}
	const { continueNarrator } = await import("./narrator-session");
	const continued = await continueNarrator(owner.id, "en", false, undefined, {
		resumeRunId: owner.logicalRunId ?? undefined,
		recovered: true,
		// An ordinary restart's own run already delivered (or never owed) its result.
		deliver: !(record.payloadJson?.ordinaryRestart === true && !owningAgentContinuation),
	});
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
	// Only admission is critical; approval and execution may remain live for hours.
	const { execution } = await withRecoveryAdvance(record.updateEpoch, () => ({
		execution: executePersistedToolCall({
			toolCallId: record.toolCallId,
			narratorId: record.narratorId,
			permissionMode,
		}),
	}));
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
	updateEpoch: EpochScope,
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
	scope: EpochScope,
): Promise<void> {
	const subagentId = payloadString(record.payloadJson, "subagentId");
	if (!subagentId) throw new Error("Agent continuation is missing subagentId");
	await waitForChildContinuationResults(subagentId, scope, signal);
	const resumeLogicalRunId =
		payloadString(record.payloadJson, "logicalRunId") ??
		readAgentLogicalRunId(subagentId) ??
		(await getRuntimePublicationService().getAgentRun(subagentId, record.narratorId)).logicalRunId;
	// New registrations win. A pre-registration checkpoint still carries its original
	// absolute deadline: materialize it once, never turn it back into a fresh timeout.
	const source = await db.query.narrators.findFirst({
		where: eq(narrators.id, subagentId),
		columns: { runtimeRegistrationJson: true, ownerUserId: true },
	});
	let legacyBinding: RunBindingInput | undefined;
	if (!readRuntimeRegistrationColumn(source?.runtimeRegistrationJson)?.run) {
		const call = await toolContinuationService.getToolCallResult(record.toolCallId);
		if (!call) throw new Error("Agent continuation's spawning call no longer exists");
		legacyBinding = {
			deliverTo: {
				narratorId: record.narratorId,
				toolUseId: call.toolUseId,
				toolCallId: record.toolCallId,
			},
			principal: executionPrincipalOf(source ?? {}) ?? { userId: null },
			deadlineAt: payloadString(record.payloadJson, "executionDeadlineAt"),
		};
	}
	const { continueNarrator } = await import("./narrator-session");
	const resumed = await withRecoveryAdvance(record.updateEpoch, () =>
		continueNarrator(subagentId, locale, false, undefined, {
			resumeRunId: resumeLogicalRunId,
			recovered: true,
			...(legacyBinding ? { binding: legacyBinding } : {}),
			...(background ? {} : { cancelSignal: signal }),
		}),
	);
	if (!resumed.ok || !resumed.terminal) {
		throw new Error("Agent continuation did not expose terminal completion");
	}
	const terminalCompletion = resumed.terminal;
	if (!(await toolContinuationService.markOwnerContinuationStartedForNarrator(subagentId, scope))) {
		throw new Error(`Failed to persist mounted child continuation for ${subagentId}`);
	}
	if (background) {
		await persistRecoveredBackgroundAgentStartResult(record, subagentId);
		void terminalCompletion.catch((error) => {
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
	await terminalCompletion;
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
	const { waiting } = await withRecoveryAdvance(record.updateEpoch, () => ({
		waiting: awaitAgentResultDetailed({
			callerNarratorId: record.narratorId,
			id: targetId,
			timeoutMs: remainingMs,
			signal,
		}),
	}));
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

/**
 * Close a Send await checkpointed by a process from before Send stopped waiting. Its
 * messages were delivered; the call ends with the outcome the checkpoint recorded.
 */
async function restoreSendAwait(
	record: ToolContinuationRecord,
	onMounted: () => void,
): Promise<void> {
	const snapshot = sendAwaitSnapshotFromPayload(record.payloadJson);
	if (!snapshot) throw new Error("Send await continuation is missing its waiter snapshot");
	onMounted();
	const toolCall = await toolContinuationService.getToolCallResult(record.toolCallId);
	if (!toolCall) throw new Error("Send tool call was deleted before recovery");
	if (toolCall.status === "success" || toolCall.status === "fail") return;
	const { narratorPersistence } = await import("./narrator-persistence");
	const updated = await narratorPersistence.updateToolCallResultIfActive(
		toolCall.toolUseId,
		{
			output: buildRetiredSendAwaitToolOutput(snapshot),
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
			await restoreAgent(
				record,
				false,
				localeFor(snapshot, record.narratorId),
				signal,
				onMounted,
				recoveryEpochScope(snapshot),
			);
			return;
		case "background_agent":
			await restoreAgent(
				record,
				true,
				localeFor(snapshot, record.narratorId),
				signal,
				onMounted,
				recoveryEpochScope(snapshot),
			);
			return;
		case "await_agent":
			await restoreAwait(record, signal, onMounted);
			return;
		case "send_await":
			await restoreSendAwait(record, onMounted);
	}
}

async function writeRecoveryToolError(
	record: ToolContinuationRecord,
	recoveryStatus: "execution_unknown" | "failed",
	errorMessage: string,
): Promise<boolean> {
	const toolCall = await db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.id, record.toolCallId),
		columns: { id: true, toolUseId: true, messageId: true, status: true },
	});
	if (!toolCall) return false;
	if (toolCall.status === "success" || toolCall.status === "fail") return true;
	const { narratorPersistence } = await import("./narrator-persistence");
	await narratorPersistence.updateToolCallResultIfActive(
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
		updateEpoch: record.updateEpoch,
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
		updateEpoch: record.updateEpoch,
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
	if (current.updateEpoch !== record.updateEpoch)
		throw new Error(`Continuation epoch changed for ${record.toolCallId}`);
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
	// A prior process may have persisted the actual result and died before advancing the
	// continuation phase. Terminal tool rows win over expired non-idempotent claims.
	// Background Agent success is only its start receipt, so its child still needs mounting.
	const persistedCall = await db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.id, current.toolCallId),
		columns: { status: true },
	});
	if (
		current.kind !== "background_agent" &&
		(persistedCall?.status === "success" || persistedCall?.status === "fail")
	) {
		const resultClaim =
			current.state === "resuming" && current.claimToken
				? current
				: await toolContinuationService.claim(current.toolCallId, {
						updateEpoch: current.updateEpoch,
						claimToken: generateId(),
						deadlineAt: new Date(Date.now() + CLAIM_LEASE_MS).toISOString(),
					});
		if (resultClaim?.claimToken) {
			const written = await toolContinuationService.markResultWritten(current.toolCallId, {
				updateEpoch: current.updateEpoch,
				claimToken: resultClaim.claimToken,
			});
			if (written) {
				onMounted();
				return written;
			}
		}
		const latest = await toolContinuationService.getByToolCallId(current.toolCallId);
		if (latest?.state === "cancelled" || (latest && hasPersistedToolContinuationResult(latest))) {
			onMounted();
			return latest;
		}
		throw new Error(`Could not reconcile persisted terminal result for ${current.toolCallId}`);
	}
	const repaired = await repairPendingRecoveryFailure(current);
	if (repaired) {
		onMounted();
		return repaired;
	}

	const claimToken = generateId();
	let claimed = await withRecoveryAdvance(recoveryEpochScope(snapshot), () =>
		toolContinuationService.claim(record.toolCallId, {
			updateEpoch: record.updateEpoch,
			claimToken,
			deadlineAt: new Date(Date.now() + CLAIM_LEASE_MS).toISOString(),
		}),
	);
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
		claimed = await withRecoveryAdvance(recoveryEpochScope(snapshot), () =>
			toolContinuationService.claim(record.toolCallId, {
				updateEpoch: record.updateEpoch,
				claimToken,
				deadlineAt: new Date(Date.now() + CLAIM_LEASE_MS).toISOString(),
			}),
		);
		if (!claimed) throw new Error(`Continuation ${record.toolCallId} lost its recovery claim`);
	}

	const abortController = new AbortController();
	const renewal = RENEWABLE_KINDS.has(claimed.kind)
		? startContinuationClaimRenewal(record.toolCallId, claimToken, abortController, {
				updateEpoch: record.updateEpoch,
			})
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
			updateEpoch: record.updateEpoch,
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
			updateEpoch: record.updateEpoch,
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
	recoveringToolCallIds?: ReadonlySet<string>,
	scope: EpochScope = record.updateEpoch,
): Promise<void> {
	const rows = await toolContinuationService.markOwnerContinuationPendingForMessage(
		messageId,
		scope,
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
		const outcome = await continueOwnerWhenReady(record, recoveringToolCallIds, scope);
		// An interrupt can land after continueNarrator's admission check but before its active loop
		// becomes visible to interruptNarrator. Abort that newly-started loop without recursively
		// re-triggering planned-update control, then join the token's durable finalizer.
		if (parentInterrupt && (await settleInterruptedOwnerDelivery(record, parentInterrupt))) return;
		if (outcome === "deferred") return;
	}
	const started = await toolContinuationService.markOwnerContinuationStartedForMessage(
		messageId,
		scope,
		parentInterrupt?.token,
	);
	if (parentInterrupt && (await settleInterruptedOwnerDelivery(record, parentInterrupt))) return;
	if (!started) {
		throw new Error(`Failed to persist owner continuation delivery for ${messageId}`);
	}
}

interface RecoveryQueueHandle {
	mounted: Promise<void>;
	/** Installation attempts, not terminal Send replies; rejection is reported by mounted. */
	sendWaitersSettled: Promise<void>;
	completion: Promise<void>;
	ownerCompletions: ReadonlyMap<string, Promise<void>>;
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
		rejectMounts: (error: unknown) => void;
		run: () => Promise<ToolContinuationRecord>;
		started?: Promise<ToolContinuationRecord>;
	};
	const plans = groupContinuationRecoveryItems(queue).map((messageItems) => {
		const executionGroups = groupToolExecutions(messageItems);
		const runs = new Map<ToolContinuationRecoveryItem, ScheduledRun>();

		for (const [groupIndex, executionGroup] of executionGroups.entries()) {
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
					rejectMounts,
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
				// Ordinary restart has installed a durable queued owner already. Its HTTP readiness
				// must not wait for a child's human gate, while executionMounted still keeps
				// Agent-dependent Await/Send behind the actual child/alias registration.
				if (snapshot.updateEpoch.startsWith("restart-")) markReady();
				// Queued followers are safe for HTTP readiness even while an Agent is waiting
				// for human approval. Their executionMounted dependency still prevents actual
				// Await/Send execution before alias registration.
				if (groupIndex > 0) markReady();
			}
		}
		return { messageItems, executionGroups, runs };
	});

	const messageCompletions = plans.map((plan) =>
		(async () => {
			try {
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
						const run = scheduled.run();
						scheduled.started = run;
						// Keep errors observed while a later Agent-dependent group is being mounted;
						// the next normal barrier or final join still propagates the same rejection.
						void run.catch(() => {});
						activeRuns.push(run);
					}
				}
				await Promise.all(activeRuns);
				await withRecoveryAdvance(recoveryEpochScope(snapshot), () =>
					deliverRecoveredMessageOwner(
						plan.messageItems[0].record,
						plan.messageItems[0].messageId,
						parentInterrupts.get(plan.messageItems[0].record.narratorId),
						new Set(queue.map((item) => item.record.toolCallId)),
						recoveryEpochScope(snapshot),
					),
				);
			} catch (error) {
				for (const scheduled of plan.runs.values()) scheduled.rejectMounts(error);
				throw error;
			} finally {
				// A sibling failure must not release this owner while another execution is live.
				await Promise.allSettled(
					[...plan.runs.values()].flatMap((run) => (run.started ? [run.started] : [])),
				);
			}
		})(),
	);
	const owners = new Map<string, Promise<void>[]>();
	for (const [index, plan] of plans.entries()) {
		const id = plan.messageItems[0].record.narratorId;
		owners.set(id, [...(owners.get(id) ?? []), messageCompletions[index]]);
	}
	return {
		mounted: Promise.all(mountedPromises).then(() => undefined),
		// Send no longer installs reply waiters, so nothing gates the legacy work behind it.
		sendWaitersSettled: Promise.resolve(),
		completion: Promise.all(messageCompletions).then(() => undefined),
		ownerCompletions: new Map(
			[...owners].map(([id, promises]) => [
				id,
				Promise.allSettled(promises).then((outcomes) => {
					const failure = outcomes.find((outcome) => outcome.status === "rejected");
					if (failure?.status === "rejected") throw failure.reason;
				}),
			]),
		),
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
 *    reported (and logged) instead, and the consumed manifest is retained as failure evidence.
 */
async function restoreLegacyNarrators(
	snapshot: PlannedUpdateRecoverySnapshot,
	protection: ToolContinuationProtectionSets,
	severedNarratorIds: ReadonlySet<string>,
	controls?: ReadonlyMap<
		string,
		{
			controller: AbortController;
			registration: import("./narrator-session").PlannedUpdateRecoveryRegistration;
		}
	>,
): Promise<void> {
	const { narratorService } = await import("./narrator-service");
	const {
		continueNarratorAfterPlannedUpdate,
		registerPlannedUpdateRecoveryController,
		isLoopRunning,
	} = await import("./narrator-session");
	const { withNarratorStartAdmission } = await import("./narrator-session-state");
	const failures: string[] = [];
	let skipped = 0;
	for (const target of recoveryTargets(snapshot)) {
		if (protection.narratorIds.has(target.narratorId)) continue;
		// A current root target is a newer run than a historical source with the same ID.
		const source = snapshot.narrators.some((entry) => entry.narratorId === target.narratorId)
			? undefined
			: snapshot.sources?.find((entry) => entry.pendingNarratorIds.includes(target.narratorId));
		if (source?.kind === "ordinary") continue;
		const epoch = source?.updateEpoch ?? snapshot.updateEpoch;
		if (!severedNarratorIds.has(target.narratorId)) {
			skipped++;
			continue;
		}
		try {
			await withRecoveryAdvance(recoveryEpochScope(snapshot), () =>
				withNarratorStartAdmission(target.narratorId, async () => {
					const registered = getRecoverySource(epoch);
					if (registered && !registered.pendingNarratorIds.includes(target.narratorId)) return;
					const existing = controls?.get(target.narratorId);
					const controller = existing?.controller ?? new AbortController();
					const registration =
						existing?.registration ??
						registerPlannedUpdateRecoveryController(target.narratorId, controller);
					try {
						if (controller.signal.aborted) return;
						const narrator = await narratorService.getById(target.narratorId);
						controller.signal.throwIfAborted();
						if (narrator.status === "archived") {
							invalidateRecoveryTarget(target.narratorId);
							return;
						}
						const run = source?.logicalRuns?.find(
							(entry) => entry.narratorId === target.narratorId,
						);
						if (run && run.logicalRunId !== (narrator.logicalRunId ?? null)) {
							invalidateRecoveryTarget(target.narratorId);
							return;
						}
						const continued = await continueNarratorAfterPlannedUpdate(
							target.narratorId,
							registration.token,
							target.locale as Locale,
							target.replyInUserLanguage ?? false,
							target.userId ?? null,
							{ resumeRunId: narrator.logicalRunId ?? undefined, recovered: true },
						);
						controller.signal.throwIfAborted();
						if (!continued.ok && !isLoopRunning(target.narratorId)) {
							throw new Error("Legacy narrator continuation did not start");
						}
						const original = getRegisteredRecoverySource(epoch);
						const current = getRecoverySource(epoch);
						if (current && original)
							registerRecoverySource(original).update({
								...current,
								pendingNarratorIds: current.pendingNarratorIds.filter(
									(id) => id !== target.narratorId,
								),
							});
					} catch (error) {
						if (!controller.signal.aborted) throw error;
						await registration.finalizeInterrupt();
						// Async preparation (especially updateStatus(working)) may have finished
						// AFTER the interrupt finalizer. Settle last, before this start admission
						// can release a newer user run; this also covers legacy-only epochs.
						await narratorService.updateStatus(target.narratorId, "idle", {
							substatus: ["interrupted"],
							skipErrorMessage: true,
						});
					} finally {
						if (!existing) registration.unregister();
					}
				}),
			);
		} catch (error) {
			if (error instanceof NotFoundError) {
				invalidateRecoveryTarget(target.narratorId);
				continue;
			}
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
export async function restoreNarratorsAfterPlannedUpdate(
	prepared?: {
		snapshot: PlannedUpdateRecoverySnapshot | null;
		protection: ToolContinuationProtectionSets;
		severedNarratorIds?: ReadonlySet<string>;
	},
	options: {
		/** Ordinary restart owns a separate manifest, never the update handoff authorization. */
		onQueueCompleted?: () => Promise<void>;
		/** Ordinary independent children share the global Send waiter installation barrier. */
		onSendWaitersSettled?: () => Promise<void>;
		includedNarratorIds?: ReadonlySet<string>;
	} = {},
): Promise<PlannedUpdateRecoveryHandle | null> {
	const startup = prepared ?? (await getPlannedUpdateStartupProtection());
	const { snapshot, protection } = startup;
	const severedNarratorIds = startup.severedNarratorIds ?? new Set<string>();
	if (!snapshot) {
		flushRuntimePublications();
		return null;
	}
	const scope = recoveryEpochScope(snapshot);
	const sourceHandles = new Map<string, RecoverySourceHandle>();
	for (const epoch of typeof scope === "string" ? [scope] : scope) {
		const source = getRegisteredRecoverySource(epoch);
		if (source) sourceHandles.set(epoch, registerRecoverySource(source));
	}
	const queue = (await toolContinuationService.listRecoveryQueueByEpoch(scope)).filter(
		({ record }) =>
			record.state !== "cancelled" &&
			!isToolContinuationOwnerMounted(record) &&
			(!options.includedNarratorIds || options.includedNarratorIds.has(record.narratorId)),
	);
	const { registerPlannedUpdateRecoveryController } = await import("./narrator-session");
	const parentControls = new Map<
		string,
		{
			controller: AbortController;
			registration: ReturnType<typeof registerPlannedUpdateRecoveryController>;
		}
	>();
	try {
		for (const narratorId of new Set(queue.map(({ record }) => record.narratorId))) {
			const controller = new AbortController();
			const recoveryToken = generateId();
			await withRecoveryAdvance(scope, () =>
				toolContinuationService.bindRecoveryTokenForNarrator(narratorId, scope, recoveryToken),
			);
			const registration = registerPlannedUpdateRecoveryController(
				narratorId,
				controller,
				(token) =>
					finalizeInterruptedRecoveryParent(
						narratorId,
						scope,
						localeFor(snapshot, narratorId),
						token,
					),
				{
					token: recoveryToken,
					foregroundSubagentIds: queue.flatMap(({ record }) => {
						if (record.narratorId !== narratorId || record.kind !== "foreground_agent") return [];
						const subagentId = payloadString(record.payloadJson, "subagentId");
						return subagentId ? [subagentId] : [];
					}),
				},
			);
			parentControls.set(narratorId, { controller, registration });
		}
	} catch (error) {
		// No queue has started yet: release partial registrations so startup failure
		// reconciliation can distinguish these owners from genuinely mounted work.
		for (const control of parentControls.values()) control.registration.unregister();
		throw error;
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
	const backgroundOnlyOwners = new Set(parentControls.keys());
	for (const { record } of queue) {
		if (record.kind !== "background_agent") backgroundOnlyOwners.delete(record.narratorId);
	}
	const ownerReleases = [...queueRecovery.ownerCompletions].map(([id, settled]) => {
		const release = (async () => {
			try {
				try {
					await settled;
					// Keep interrupt coverage until the actual foreground execution takes over.
					// This helper owns its advance; nesting it here makes a handoff reservation
					// wait for the outer advance while the inner waits for that reservation.
					if (!options.onQueueCompleted && backgroundOnlyOwners.has(id)) {
						const narratorIds = new Set(protection.narratorIds);
						narratorIds.delete(id);
						await restoreLegacyNarrators(
							snapshot,
							{ ...protection, narratorIds },
							new Set(severedNarratorIds.has(id) ? [id] : []),
							parentControls,
						);
					}
				} finally {
					// Wait for this owner's actual executions, not an aggregate sibling failure.
					parentControls.get(id)?.registration.unregister();
				}
				await withRecoveryAdvance(scope, async () => {
					const rows = (await toolContinuationService.listByEpoch(scope)).filter(
						(row) => row.narratorId === id,
					);
					if (
						rows.every((row) => row.state === "cancelled" || isToolContinuationOwnerMounted(row))
					) {
						for (const [epoch, handle] of sourceHandles) {
							const source = getRecoverySource(epoch);
							if (source)
								handle.update({
									...source,
									pendingNarratorIds: source.pendingNarratorIds.filter((target) => target !== id),
								});
						}
					}
					const { reconcileRunningStatus } = await import("./narrator-session");
					await reconcileRunningStatus(id);
				});
				// Queue wake may itself acquire recovery admission. Never hold an epoch
				// advance across that nested entry point.
				if (!parentControls.get(id)?.controller.signal.aborted)
					await drainQueuedMessagesAfterRecovery(snapshot, [id]);
			} catch (error) {
				const { failUnownedStartupRecovery } = await import("./narrator-session");
				await failUnownedStartupRecovery([id], error);
				throw error;
			} finally {
				flushRuntimePublications();
			}
		})();
		// A mount failure may make the caller return before background owners settle.
		void release.catch(() => {});
		return release;
	});
	// Independent legacy work only waits for global Send waiter installation attempts.
	// Ordinary restart has its own qualified targets and must never take this branch.
	const legacyRecovery = options.onQueueCompleted
		? queueRecovery.sendWaitersSettled.then(() => options.onSendWaitersSettled?.())
		: queueRecovery.sendWaitersSettled.then(async () => {
				const driven = new Set(
					queue.flatMap(({ record }) => [
						record.narratorId,
						...(typeof record.payloadJson?.subagentId === "string"
							? [record.payloadJson.subagentId]
							: []),
					]),
				);
				await Promise.all([
					restoreLegacyNarrators(snapshot, protection, severedNarratorIds),
					...(snapshot.sources
						?.filter((source) => source.kind === "ordinary")
						.map(async (source) => {
							const { restoreCarriedOrdinaryTargets } = await import("./restart-recovery-service");
							await restoreCarriedOrdinaryTargets(source, driven);
						}) ?? []),
				]);
			});
	void legacyRecovery.catch(() => {});
	void queueRecovery.completion.catch(() => {});
	try {
		await queueRecovery.mounted;
		if (options.onSendWaitersSettled) await legacyRecovery;
	} catch (error) {
		// `completion` was created eagerly alongside `mounted` and shares its rejection. Nobody
		// will ever await it on this path, so observe it here — otherwise the same failure is
		// reported a second time as a process-level unhandled rejection.
		void queueRecovery.completion.catch(() => {});
		// Owner release remains attached to its actual executions, never this aggregate rejection.
		await legacyRecovery.catch((legacyError) => {
			logger.error("Independent legacy recovery failed", { error: String(legacyError) });
		});
		throw error;
	}

	const completion = (async () => {
		try {
			await Promise.all([queueRecovery.completion, legacyRecovery]);
			const unfinished = (await toolContinuationService.listByEpoch(scope)).filter(
				(row) =>
					!isToolContinuationOwnerMounted(row) &&
					(!options.includedNarratorIds || options.includedNarratorIds.has(row.narratorId)),
			);
			if (unfinished.length > 0) {
				throw new Error(`${unfinished.length} continuation owner deliveries remain unfinished`);
			}
			await Promise.all(ownerReleases);
			await withRecoveryAdvance(scope, async () => {
				if (options.onQueueCompleted) {
					await options.onQueueCompleted();
				} else {
					for (const source of snapshot.sources ?? []) {
						if (source.kind !== "ordinary") continue;
						const { removeCarriedOrdinaryManifest } = await import("./restart-recovery-service");
						await removeCarriedOrdinaryManifest(source.updateEpoch);
					}
					// Only clear the manifest this recovery pass owns, never a newer root.
					removePlannedUpdateRecoverySnapshot({ expectedEpoch: snapshot.updateEpoch });
				}
				for (const [epoch, handle] of sourceHandles) {
					if (!getRecoverySource(epoch)?.pendingNarratorIds.length) handle.retire();
				}
			});
		} finally {
			// Observe releases without allowing a failed owner to release another live owner.
			void Promise.all(ownerReleases).catch((error) => {
				logger.error("Recovery owner release failed", { error: String(error) });
			});
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
