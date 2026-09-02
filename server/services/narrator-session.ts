import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { formatOriginLabel, type MessageOriginOptions } from "@shared/message-origin";
import { isDanglingReasoningOnlyAssistantMessage } from "@shared/reasoning-content";
import {
	MAX_EDIT_IMAGES_PER_MESSAGE,
	MAX_EDIT_TEXT_FILES_PER_MESSAGE,
	MAX_NARRATOR_ATTACHMENT_BYTES,
} from "@shared/text-file-types";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, sqlite } from "../db";
import {
	chapters,
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
} from "../db/schema";
import { buildHistory, type ReasoningEffort, resolveProviderAndModel } from "../lib/agent";
import { diagnosticsFromError } from "../lib/agent/error-diagnostics";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import {
	acknowledgePipelineExitConfirmation,
	clearPipelineStateIfActive,
} from "../lib/agent/pipeline-state";
import { getMissingWorkingDirectoryRecovery, SHELL_TOOL_NAME } from "../lib/agent/tools/bash";
import {
	clearBehaviorFenceEditGrant,
	grantBehaviorFenceEdit,
} from "../lib/agent/tools/behavior-fence-grant";
import { KNOWLEDGE_KIND_DENY_CORE, OPTIONAL_TOOLS, REVIEW_TOOLS } from "../lib/agent/tools/index";
import { AsyncMutex } from "../lib/async-mutex";
import { buildAttachedFilesHint } from "../lib/attached-files";
import {
	type BooleanOverride,
	type DangerReflectionOverride,
	normalizeAutoContinuationMode,
	normalizeBooleanOverride,
	normalizeDangerReflectionOverride,
	resolveAutoContinuationMode,
	resolveBooleanOverride,
} from "../lib/boolean-override";
import { getBuiltinToolNames, getBuiltinToolRoutines } from "../lib/builtin-routines";
import { withDbRetry } from "../lib/db-resilience";
import { resolveInjectedDevices } from "../lib/device-injection-trait";
import { NotFoundError, ValidationError } from "../lib/errors";
import { resolveFastModeForUser } from "../lib/fast-mode";
import { hotSafe } from "../lib/hot-safe";
import { InjectionCadence } from "../lib/injection-cadence";
import { logger } from "../lib/logger";
import {
	formatSubagentModelRestrictionDescription,
	getBlockedSkills,
	getDisabledToolSet,
} from "../lib/narrator-custom-traits";
import {
	addTrait,
	isKnowledgeStewardNarrator,
	isPlanModeTrait,
	isReadOnlySubagentVariant,
	isSubagentVariant,
	parseSubstatus,
	parseTraits,
	redactDraftTraits,
} from "../lib/narrator-utils";
import { nugAvailabilityPoller } from "../lib/nug-availability-poller";
import { resolveKnownUnavailableNugModel } from "../lib/nug-model-availability";
import { markNugCachedModelUnavailable } from "../lib/nug-model-cache";
import {
	normalizeLegacyPlanPreviousPermissionMode,
	resolveEffectiveRelaxedPlan,
} from "../lib/permission-modes";
import { resolveExistingPlanFileRelPath } from "../lib/plan-file-path";
import { getHome } from "../lib/platform";
import {
	getBlockedTaskActionInstruction,
	getToolMessage,
	getToolMessageWithParams,
	type Locale,
} from "../lib/prompt-i18n";
import {
	FOLLOW_DEFAULT_MODEL,
	getAutoCompactKeepPairs,
	getAutoCompactPruneThreshold,
	getContextThresholds,
	getSettingsRevision,
	isAnthropicProvider,
	resolveDefaultReasoningEffort,
	resolveEffectiveModel,
	resolveProvider,
	settings,
	usesCodexModel,
	usesStatefulModel,
} from "../lib/settings";
import { sideCarBodyWithText } from "../lib/sidecar-templates";
import type { ImageRef, PersistedUserImageBlock, TextFileRef } from "../lib/uploads";
import {
	copyTextFileToWorktree,
	deleteCreatedAttachmentFiles,
	deleteUploadedImage,
	getImagePath,
	getUploadedImageInfo,
	imageRefToContentBlock,
	imageToBase64,
	isFileWithinWorktree,
	saveTextFileToWorktree,
	saveUploadedImage,
	validateTextFile,
	validateUploadedImage,
	validImageDimension,
} from "../lib/uploads";
import { generateWordSlug } from "../lib/words";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { backgroundTaskService } from "./background-task-service";
import { formatBackgroundCompletionNotifications } from "./bg-completion-queue";
import { gitService } from "./git-service";
import { getStatusSummaryCached, invalidateStatus } from "./git-status-cache";
import { knowledgeInjection } from "./knowledge-injection";
import { knowledgeService } from "./knowledge-service";
import { resolveNarratorSessionCwd } from "./narrator-cwd";
import {
	clearStreamingSnapshot,
	type EventHandlerContext,
	type EventHooks,
	processEvent,
	type TokenUsageSnapshot,
} from "./narrator-event-handler";
import { type ExecuteLoopResult, executeAgentLoop } from "./narrator-executor";
import { deliverInjection } from "./narrator-injection";
import { isFirstUserTurn } from "./narrator-message-count";
import { resolveNarratorProjectId as resolveSharedNarratorProjectId } from "./narrator-project";
import { buildEffectiveSystemPrompt } from "./narrator-prompt";
import {
	getContextOverflowFailureError,
	getFirstTokenTimeoutMs,
	getMaxTransientRetries,
	getPipelineUnusedToolCallThreshold,
	getRetryBackoffCeilMs,
	getSilentToolCallThreshold,
	handleContextOverflow,
	handleTransientError,
	MAX_CONTEXT_OVERFLOW_RETRIES,
	resetContextOverflowRetriesAfterProgress,
} from "./narrator-recovery";
import {
	enrichToolUseBlocks,
	handleBashCommand,
	narratorService,
	truncateToolIO,
} from "./narrator-service";
import { clearAliasRegistry, clearTeamFileChanges } from "./narrator-subagent";
import {
	generateAndSetTitle,
	generateQuickTitle,
	setProvisionalTitleFromUserMessage,
} from "./narrator-title";
import {
	abandonSessionTreeSnapshots,
	abandonTreeSnapshot,
	declaredWorktreePaths,
	recordTreeSnapshotAfter,
	recordTreeSnapshotBefore,
} from "./narrator-tree-snapshot-hooks";
import { resolveContinueTurnTiming } from "./narrator-turn-timing";
import {
	assertOAuthNarratorRuntimeActive,
	type OAuthNarratorRuntimePolicy,
} from "./oauth-narrator-runtime-policy";
import { formatParentInboundMessages } from "./parent-inbound-queue";
import { drainPendingInjections, type PendingInjection } from "./parent-injection-queue";
import { resolvePlanApprovalAttribution } from "./plan-approval-attribution";
import { reviewService } from "./review-service";
import { broadcastSpecChanged } from "./spec-broadcast";
import { buildBehaviorFenceBody, buildSpecTaskDigestBody } from "./spec-reminder";
import { compileSpecTasks, parseSpecTasksDocument } from "./spec-task-service";
import { drainSpecUpdatesForNarrator } from "./spec-update-queue";
import { specVfsService } from "./spec-vfs-service";
import {
	deleteConclusionFileId,
	getConclusionEntry,
	setConclusionFileId,
} from "./subagent-conclusion";
import { appendSubagentFileChanges } from "./subagent-file-changes";
import { agentResultTag, resolveAgentLabel } from "./subagent-label";
import {
	getConclusionWatcher,
	getManualOverrideMap,
	registerConclusionWatcher,
	removeConclusionWatcher,
	resolveManualOverride,
} from "./subagent-manual-override";
import {
	clearTakenOver,
	consumePendingBackgroundFinalize,
	consumePendingStopTakeover,
	isTakenOver,
} from "./subagent-takeover";
import { isMcpToolAllowedForNarrator } from "./subagent-tools";
import { resolveEffectiveTraits } from "./trait-layer-service";
import { registerNarratorLoop } from "./update-coordinator";
import { worktreeWatcher } from "./worktree-watcher";

// === In-memory state (imported from narrator-session-state) ===

import type {
	ActiveNarrator,
	BufferCreator,
	BufferedMessage,
	NarratorEvent,
	SavedBufferedFile,
} from "./narrator-session-state";
import {
	activeNarrators,
	activeSubagentSettings,
	bufferedMessages,
	claimNarratorRuntime,
	clearActiveHistoryCompactPending,
	clearPlanModePromptRebuild,
	compactLocks,
	consumePlanModePromptRebuild,
	hasPendingHistoryCompact,
	isNarratorRuntimeBusy,
	knowledgeInjectionCycleStates,
	narratorCreationLocks,
	pendingFeedback,
	pendingPermissions,
	pendingPlanApprover,
	pendingPlanApproverSource,
	pendingPlanCompact,
	pendingPlanDiff,
	planModeAskedOnce,
	pruneLocks,
	recordNarratorRuntimeModel,
	resetActiveUpstreamSession,
	updateActiveSubagentModel,
	updateActiveSubagentReasoningEffort,
} from "./narrator-session-state";

export type { PersistedUserImageBlock };
// Re-exported so existing imports (tests, other services) keep working; the
// implementation lives in ../lib/uploads next to ImageRef.
export { imageRefToContentBlock };

interface PlannedUpdateRecoveryControl {
	token: string;
	controller: AbortController;
	onInterrupt?: (token: string) => void | Promise<void>;
	interruptFinalizer: Promise<void> | null;
	/**
	 * Subagents this recovery owner is waiting on, if any.
	 *
	 * A list rather than a flag because the recovery path re-drives a foreground
	 * Agent through `resumeSubagent`, whose run signal is deliberately independent
	 * of the parent — so nothing else can identify which subagents belong to it.
	 * Empty means "this owner holds no subagent", which is the correct answer for
	 * the Await batch: those awaits own only the parent-side wait, and the agents
	 * they watch must keep running.
	 */
	foregroundSubagentIds: readonly string[];
}

export interface PlannedUpdateRecoveryRegistration {
	token: string;
	unregister: () => void;
	finalizeInterrupt: () => Promise<void>;
}

const plannedUpdateRecoveryControls = hotSafe<Map<string, PlannedUpdateRecoveryControl>>(
	"narrafork:plannedUpdateRecoveryControls",
	() => new Map(),
);

/** Register a parent-scoped planned-update recovery controller with stale-owner-safe cleanup. */
export function registerPlannedUpdateRecoveryController(
	narratorId: string,
	controller: AbortController,
	onInterrupt?: (token: string) => void | Promise<void>,
	options: { foregroundSubagentIds?: readonly string[]; token?: string } = {},
): PlannedUpdateRecoveryRegistration {
	const token = options.token ?? randomUUID();
	const control: PlannedUpdateRecoveryControl = {
		token,
		controller,
		onInterrupt,
		interruptFinalizer: null,
		foregroundSubagentIds: options.foregroundSubagentIds ?? [],
	};
	plannedUpdateRecoveryControls.set(narratorId, control);
	// These recovery stages drive a narrator with NO activeNarrators entry, yet they
	// legitimately hold it in `working`. Claim the runtime for the registration's
	// lifetime so the zombie-status reconcile does not mistake that for an orphaned
	// row and flip a genuinely busy narrator back to idle mid-recovery.
	const releaseRuntimeClaim = claimNarratorRuntime(narratorId, token);
	const finalizeInterrupt = (): Promise<void> => {
		if (control.interruptFinalizer) return control.interruptFinalizer;
		const current = plannedUpdateRecoveryControls.get(narratorId);
		if (current !== control || current.token !== token) return Promise.resolve();
		control.interruptFinalizer = Promise.resolve().then(() => control.onInterrupt?.(token));
		return control.interruptFinalizer;
	};
	return {
		token,
		finalizeInterrupt,
		unregister: () => {
			releaseRuntimeClaim();
			if (plannedUpdateRecoveryControls.get(narratorId)?.token === token) {
				plannedUpdateRecoveryControls.delete(narratorId);
			}
		},
	};
}

function interruptPlannedUpdateRecovery(narratorId: string): {
	interrupted: boolean;
	foregroundSubagentIds: readonly string[];
} {
	const control = plannedUpdateRecoveryControls.get(narratorId);
	if (!control) return { interrupted: false, foregroundSubagentIds: [] };
	control.controller.abort(new Error("Narrator interrupted by user"));
	if (!control.interruptFinalizer) {
		control.interruptFinalizer = Promise.resolve().then(() => control.onInterrupt?.(control.token));
	}
	void control.interruptFinalizer.catch((error) => {
		logger.warn("Failed to finalize planned-update narrator interrupt", {
			narratorId,
			error: error instanceof Error ? error.message : String(error),
		});
	});
	return {
		interrupted: true,
		foregroundSubagentIds: control.foregroundSubagentIds,
	};
}

// === Imported from extracted modules ===

import {
	dbClearAllBuffered,
	dbConsumeBuffered,
	getBufferedMessages,
	loadBufferedTextFiles,
	toBufferSummary,
} from "./narrator-buffer";
import {
	awaitCompactCompletion,
	pruneToolCalls,
	runCustomCompact,
	runPlanCompact,
	shouldFinalizeAbortBeforeRecovery,
	triggerMidTurnCompact,
} from "./narrator-compact";
import { handlePermission, resolvePermissionOrDangerReflection } from "./narrator-permission";
import {
	reconstructToolExecutionTarget,
	recoverStaleCompactingMessages,
} from "./narrator-persistence";
import {
	commitPreparedEnterPlanModeResult,
	ensureNarratorPlanFileId,
	exitNarratorPlanMode,
	prepareNarratorPlanMode,
} from "./narrator-plan-mode";
import type { RevertScope, RevertWarning } from "./snapshot-revert";

// Tools that may modify files on disk — git status is tracked after these complete
const FILE_MUTATING_TOOLS = new Set(["Write", "Edit", SHELL_TOOL_NAME]);
const MAX_CONTINUATION_STALL_TURNS = 3;

/**
 * How long `interruptAndWaitForIdle` waits for an aborted loop to actually leave.
 *
 * An abort lands at the loop's next await point, so the wait covers whatever is
 * currently in flight: a model request being cancelled, a tool being torn down, and
 * the loop's own `finally` cleanup. Kept well under the HTTP request budget so a
 * stuck loop degrades into a reported warning rather than a hanging request.
 */
const INTERRUPT_IDLE_TIMEOUT_MS = 15_000;
const INTERRUPT_IDLE_POLL_MS = 50;

export interface ContinuationStallState {
	count: number;
	key?: string;
	suppressed: boolean;
}

export function computeContinuationStallState(
	kind: "task" | "blocked",
	result: Pick<ExecuteLoopResult, "hadToolUses" | "taskReflectionDenialFingerprint">,
	previous: Pick<ContinuationStallState, "count" | "key">,
): ContinuationStallState {
	const denialFingerprint = result.taskReflectionDenialFingerprint?.trim();
	const stallKey = denialFingerprint
		? `task-reflection:${denialFingerprint}`
		: result.hadToolUses
			? undefined
			: `no-tools:${kind}`;
	if (!stallKey) return { count: 0, key: undefined, suppressed: false };

	const count = previous.key === stallKey ? previous.count + 1 : 1;
	const limit = kind === "blocked" ? 1 : MAX_CONTINUATION_STALL_TURNS;
	return { count, key: stallKey, suppressed: count >= limit };
}

function parseQueuedNewCommand(message: string, commandText?: string | null) {
	const raw = commandText?.trim().startsWith("/new") ? commandText.trim() : message.trim();
	const match = raw.match(/^\/new(?:\s+([\s\S]*))?$/);
	if (!match) return null;
	return { rawCommand: raw, initialMessage: match[1]?.trim() ?? "" };
}

/**
 * Recognize a buffered `/goal <objective>` command. When the narrator was busy,
 * the route queues the raw command instead of appending the protected task
 * immediately; on consumption we parse it here and run executeQueuedGoalCommand.
 * Returns null (fall through to a normal model turn) when there is no objective.
 */
export function parseQueuedGoalCommand(message: string, commandText?: string | null) {
	const raw = commandText?.trim().startsWith("/goal") ? commandText.trim() : message.trim();
	const match = raw.match(/^\/goal(?:\s+([\s\S]*))?$/);
	if (!match) return null;
	const objective = match[1]?.trim() ?? "";
	if (!objective) return null;
	return { rawCommand: raw, objective };
}

function normalizeOptionalBooleanOverride(value: unknown): BooleanOverride | undefined {
	return value == null ? undefined : normalizeBooleanOverride(value);
}

function normalizeOptionalDangerReflectionOverride(
	value: unknown,
): DangerReflectionOverride | undefined {
	return value == null ? undefined : normalizeDangerReflectionOverride(value);
}

/**
 * Resolve the remote devices this session may route to. Best-effort: any error
 * yields an empty list so no new remote choices are exposed. A persisted remote
 * default is deliberately retained; routed tools then fail closed until the
 * device is available or the user explicitly switches to local.
 */
async function resolveSessionDevices(
	projectId: string | null,
	actingUserId?: string | null,
): Promise<import("../lib/agent").AgentConfig["availableDevices"]> {
	try {
		const { getSessionDevices } = await import("./device-connection-service");
		return await getSessionDevices(projectId, actingUserId);
	} catch {
		return [];
	}
}

type SessionDevice = NonNullable<import("../lib/agent").AgentConfig["availableDevices"]>[number];

export function filterOAuthSessionDevices(
	devices: readonly SessionDevice[],
	runtime: Pick<OAuthNarratorRuntimePolicy, "deviceIds">,
): SessionDevice[] {
	const authorizedDeviceIds = new Set(runtime.deviceIds);
	return devices.filter((device) => authorizedDeviceIds.has(device.id));
}

export function resolveNarratorDefaultDeviceRequest(
	requestedDeviceId: string | null,
	devices: readonly SessionDevice[],
	options: { allowLocal: boolean; authorizedDeviceIds?: ReadonlySet<string> },
): string | null {
	const requested = requestedDeviceId?.trim() || null;
	if (!requested || requested === LOCAL_DEVICE_ID) {
		if (!options.allowLocal) {
			throw new ValidationError("OAuth narrators may not execute on the local server");
		}
		return null;
	}
	const match = devices.find((device) => device.id === requested || device.slug === requested);
	if (!match || (options.authorizedDeviceIds && !options.authorizedDeviceIds.has(match.id))) {
		throw new ValidationError(`Unknown or unauthorized device: ${requested}`);
	}
	if (!match.online) throw new ValidationError(`Device is offline: ${match.name}`);
	return match.id;
}

async function persistNarratorDefaultDevice(
	narratorId: string,
	deviceId: string | null,
): Promise<boolean> {
	try {
		const updated = await db
			.update(narrators)
			.set({ defaultDeviceId: deviceId, updatedAt: new Date().toISOString() })
			.where(eq(narrators.id, narratorId))
			.returning({ id: narrators.id });
		return updated.length === 1;
	} catch (err) {
		logger.warn("Failed to persist session default device", {
			narratorId,
			deviceId,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

export async function commitNarratorDefaultDevice(
	narratorId: string,
	active: Pick<ActiveNarrator, "_defaultDeviceId"> | null | undefined,
	deviceId: string | null,
	persist: (
		narratorId: string,
		deviceId: string | null,
	) => Promise<boolean> = persistNarratorDefaultDevice,
): Promise<boolean> {
	try {
		const persisted = await persist(narratorId, deviceId);
		if (!persisted) return false;
		if (active) active._defaultDeviceId = deviceId;
		return true;
	} catch (err) {
		logger.warn("Failed to commit session default device", {
			narratorId,
			deviceId,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

/** Persist a SwitchDevice request before changing the live session target. */
async function applySessionDefaultDevice(
	narratorId: string,
	active: ActiveNarrator,
	deviceId: string | null,
): Promise<boolean> {
	return commitNarratorDefaultDevice(narratorId, active, deviceId);
}

/**
 * Local wrapper kept only for its "narrator must exist" contract: the callers
 * below are acting on a live session and a missing row is a real error, whereas
 * the shared resolver reports an unknown project as null. The resolution itself
 * lives in `narrator-project.ts` (single source of truth).
 */
async function resolveNarratorProjectId(narratorId: string): Promise<string | null> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { chapterId: true, contextProjectId: true },
	});
	if (!narrator) throw new NotFoundError("Narrator", narratorId);
	return await resolveSharedNarratorProjectId(narrator);
}

export async function getNarratorExecutionDeviceState(narratorId: string): Promise<{
	defaultDeviceId: string | null;
	devices: NonNullable<import("../lib/agent").AgentConfig["availableDevices"]>;
}> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { defaultDeviceId: true },
	});
	if (!narrator) throw new NotFoundError("Narrator", narratorId);
	const projectId = await resolveNarratorProjectId(narratorId);
	const runtime = await assertOAuthNarratorRuntimeActive(narratorId);
	const devices = (await resolveSessionDevices(projectId)) ?? [];
	return {
		defaultDeviceId: runtime?.defaultDeviceId ?? narrator.defaultDeviceId,
		devices: runtime ? filterOAuthSessionDevices(devices, runtime) : devices,
	};
}

export async function setNarratorDefaultDevice(
	narratorId: string,
	requestedDeviceId: string | null,
): Promise<{ defaultDeviceId: string | null }> {
	const runtime = await assertOAuthNarratorRuntimeActive(narratorId);
	const projectId = await resolveNarratorProjectId(narratorId);
	const projectDevices = (await resolveSessionDevices(projectId)) ?? [];
	const devices = runtime ? filterOAuthSessionDevices(projectDevices, runtime) : projectDevices;
	const resolvedDeviceId = resolveNarratorDefaultDeviceRequest(requestedDeviceId, devices, {
		allowLocal: !runtime,
		...(runtime ? { authorizedDeviceIds: new Set(runtime.deviceIds) } : {}),
	});

	const active = activeNarrators.get(narratorId);
	const committed = await commitNarratorDefaultDevice(
		narratorId,
		active?.alive ? active : null,
		resolvedDeviceId,
	);
	if (!committed) throw new NotFoundError("Narrator", narratorId);
	return { defaultDeviceId: resolvedDeviceId };
}

async function executeQueuedNewCommand(
	active: ActiveNarrator,
	buffered: BufferedMessage,
	initialMessage: string,
): Promise<string> {
	const sourceNarrator = await narratorService.getById(active.narratorId);
	const newNarrator = await narratorService.create({
		chapterId: null,
		model: sourceNarrator.model ?? undefined,
		systemPrompt: sourceNarrator.systemPrompt ?? undefined,
		permissionMode: sourceNarrator.permissionMode ?? undefined,
		reasoningEffort: sourceNarrator.reasoningEffort ?? undefined,
		fastModeOverride: normalizeBooleanOverride(sourceNarrator.fastModeOverride),
		relaxedPlan: sourceNarrator.relaxedPlan ?? undefined,
		planReflectionAutoApproveOverride: normalizeOptionalBooleanOverride(
			sourceNarrator.planReflectionAutoApproveOverride,
		),
		dangerReflectionOverride: normalizeOptionalDangerReflectionOverride(
			sourceNarrator.dangerReflectionOverride,
		),
		cwd: active.cwd,
		// The person who queued `/new` owns the session it spawns. Falling back to the
		// source narrator's owner keeps it out of "ownerless" territory when the
		// buffered message has no recorded author (system-queued paths).
		ownerUserId: buffered.createdBy ?? sourceNarrator.ownerUserId,
	});

	if (initialMessage) {
		await sendMessage(
			newNarrator.id,
			initialMessage,
			buffered.images,
			active.locale,
			active._replyInUserLanguage ?? false,
			undefined,
			buffered.createdBy,
			buffered.textFiles,
		);
	}

	return newNarrator.id;
}

/**
 * Persist and broadcast a `spec_goal_added` display card so the /goal command
 * leaves a durable, self-explanatory record in the conversation (rather than
 * only a transient toast). `added` is false when an identical task already
 * existed. Uses the `disp` role so this UI-only notice never enters the model
 * history (unlike spec_continuation, which is an instruction to the model).
 * Shared by the idle route path and the busy buffer-consumption path.
 */
export async function persistGoalAddedNotice(
	narratorId: string,
	objective: string,
	added: boolean,
): Promise<void> {
	const text = added
		? `Dynamic Spec: protected task added — ${objective}`
		: `Dynamic Spec: protected task already exists — ${objective}`;
	// persistDisplayMessage broadcasts a `message` event itself.
	await narratorService.persistDisplayMessage(narratorId, text, [
		{ type: "spec_goal_added", task: objective, added, protected: true },
	]);
}

/**
 * Execute a buffered `/goal` command: persist it as the canonical user message
 * (so it stays visible in the conversation) and append the protected task to
 * spec://tasks.json. Runs when a queued /goal is consumed after the turn that
 * was busy at submit time; the caller then starts a Spec continuation turn.
 */
async function executeQueuedGoalCommand(
	narratorId: string,
	buffered: BufferedMessage,
	objective: string,
): Promise<void> {
	const rawCommand = buffered.commandText?.trim() || buffered.text;
	const userMsg = await narratorService.persistUserMessage(
		narratorId,
		rawCommand,
		[{ type: "text", text: rawCommand }],
		rawCommand,
		buffered.createdBy,
	);
	broadcastToNarrator(narratorId, { type: "user_message", narratorId, message: userMsg });
	const { added, written } = await specVfsService.appendProtectedSpecTask(narratorId, objective);
	if (added) {
		broadcastSpecChanged(
			narratorId,
			{ uri: written.uri, path: written.path, revisionId: written.revisionId },
			"ui",
			"user",
		);
	}
	// The task mutation is the command's durable effect. A display-only confirmation
	// card is best-effort so a transient message persistence failure cannot mark the
	// narrator errored or prevent later buffered messages from draining.
	await persistGoalAddedNotice(narratorId, objective, added).catch((err) => {
		logger.warn("Failed to persist queued /goal confirmation notice", {
			narratorId,
			error: String(err),
		});
	});
}

/**
 * Consume the next buffered message after an interrupted loop and dispatch it.
 * `/new` is terminal and drains the next queued item immediately. `/goal` first
 * persists its protected task, then starts a Spec continuation turn; messages
 * queued behind it remain ordered for that loop to consume later. A normal
 * message goes through feedMessage, whose own loop drains the rest at its next
 * safe boundary. Returns after scheduling the first message.
 */
function resumeNextBufferedMessage(active: ActiveNarrator, locale: Locale): void {
	const narratorId = active.narratorId;
	if ((bufferedMessages.get(narratorId)?.length ?? 0) === 0) return;
	const queue = bufferedMessages.get(narratorId);
	const first = queue?.shift();
	if (!queue || !first) return;
	if (queue.length === 0) bufferedMessages.delete(narratorId);
	dbConsumeBuffered(first.id);
	broadcastToNarrator(narratorId, {
		type: "buffer_consumed",
		narratorId,
		messageId: first.id,
		remaining: toBufferSummary(getBufferedMessages(narratorId)),
	});

	const settleAfterTerminalCommand = async () => {
		// More queued behind this terminal command → keep draining; else settle idle.
		if ((bufferedMessages.get(narratorId)?.length ?? 0) > 0) {
			resumeNextBufferedMessage(active, locale);
			return;
		}
		await narratorService
			.compareAndSetStatus(narratorId, ["working", "waiting"], "idle", { substatus: ["unread"] })
			.catch(() => {});
	};
	const handleTerminalCommandError = async (label: string, err: unknown) => {
		logger.error(`Queued ${label} execution after interrupt failed`, {
			narratorId,
			error: String(err),
		});
		await narratorService
			.updateStatus(narratorId, "idle", { substatus: ["error"], errorMessage: String(err) })
			.catch(() => {});
		broadcastToNarrator(narratorId, { type: "narrator_error", narratorId, error: String(err) });
	};

	const newCommand = parseQueuedNewCommand(first.text, first.commandText);
	const goalCommand = parseQueuedGoalCommand(first.text, first.commandText);
	if (newCommand) {
		executeQueuedNewCommand(active, first, newCommand.initialMessage)
			.then(async (newNarratorId) => {
				broadcastToNarrator(narratorId, {
					type: "queued_new_narrator_created",
					narratorId,
					messageId: first.id,
					newNarratorId,
				});
				await settleAfterTerminalCommand();
			})
			.catch((err) => handleTerminalCommandError("/new", err));
	} else if (goalCommand) {
		// Queued /goal: persist the protected task, then launch its first Spec turn.
		// If plan mode or another guard prevents starting, keep draining as before.
		executeQueuedGoalCommand(narratorId, first, goalCommand.objective)
			.then(async () => {
				const result = await startSpecContinuationIfPossible(
					narratorId,
					locale,
					active._replyInUserLanguage ?? false,
					first.createdBy,
				);
				if (!result.started) await settleAfterTerminalCommand();
			})
			.catch((err) => handleTerminalCommandError("/goal", err));
	} else {
		feedMessage(
			narratorId,
			first.text,
			first.images,
			locale,
			active._replyInUserLanguage ?? false,
			first.commandText,
			first.createdBy,
			first.textFiles,
			first.bashCommand,
		)
			.then(({ userMsg, userBroadcasted }) => {
				if (!userBroadcasted) {
					broadcastToNarrator(narratorId, { type: "user_message", narratorId, message: userMsg });
				}
			})
			.catch((err) => handleTerminalCommandError("auto-resume message", err));
	}
}

// Serialize externally-triggered continuation starts and edit/regenerate transactions.
// This prevents two idle checks from racing into concurrent loops and ensures uploads
// cannot both materialize files before the narrator's turn-admission flag is set.
const continuationStartLock = new AsyncMutex();

function isDynamicPruningWindowEnabled(thresholds: {
	pruneStart: number;
	compactStart: number;
}): boolean {
	return thresholds.compactStart > thresholds.pruneStart;
}

// === Narrator lifecycle ===

/**
 * Ensure an active narrator exists for this narrator ID.
 * If one is already alive, return it. Otherwise create a new one.
 */
export async function ensureNarrator(
	narratorId: string,
	locale: Locale,
	replyInUserLanguage = false,
): Promise<ActiveNarrator> {
	const existing = activeNarrators.get(narratorId);
	if (existing?.alive && !existing.abortController.signal.aborted) return existing;

	const pending = narratorCreationLocks.get(narratorId);
	if (pending) return pending;

	const creation = createNarrator(narratorId, locale, replyInUserLanguage);
	narratorCreationLocks.set(narratorId, creation);
	try {
		return await creation;
	} finally {
		narratorCreationLocks.delete(narratorId);
	}
}

/**
 * Build the effective system prompt dynamically.
 * Reads AGENTS.md (fallback AGENT.md, CLAUDE.md) from disk each time so changes are picked up mid-conversation.
 */
async function buildSystemPrompt(
	narrator: { systemPrompt: string | null; contextSummary: string | null },
	cwd: string,
	locale: Locale,
	replyInUserLanguage: boolean,
	planMode = false,
	planFileId?: string,
	defaultSystemPrompt?: string | null,
	deviceContext?: {
		devices?: import("./narrator-prompt").BuildPromptOptions["devices"];
		defaultDeviceId?: string | null;
		allowLocalExecution?: boolean;
	},
	planFilePath?: string,
): Promise<{ prompt: string | null; usedCompactSummary: boolean }> {
	return buildEffectiveSystemPrompt({
		basePrompt: narrator.systemPrompt,
		cwd,
		locale,
		contextSummary: narrator.contextSummary,
		planMode,
		planFileId,
		planFilePath,
		planAllowInlinePlan: settings.agent.planModeAllowInlinePlan,
		replyInUserLanguage,
		defaultSystemPrompt,
		devices: deviceContext?.devices,
		defaultDeviceId: deviceContext?.defaultDeviceId,
		allowLocalExecution: deviceContext?.allowLocalExecution,
	});
}

async function createNarrator(
	narratorId: string,
	locale: Locale,
	replyInUserLanguage = false,
): Promise<ActiveNarrator> {
	const existing = activeNarrators.get(narratorId);
	if (existing) {
		existing.abortController.abort();
		existing._preparedPlanModes?.clear();
		activeNarrators.delete(narratorId);
		planModeAskedOnce.delete(narratorId);
		clearStreamingSnapshot(narratorId);
	}

	const narrator = await narratorService.getById(narratorId);
	const initialOAuthRuntime = await assertOAuthNarratorRuntimeActive(narratorId);

	// Use narrator-level state directly
	const effectiveConversationId = narrator.apiConversationId;
	const effectiveContextSummary = narrator.contextSummary;

	// Resolve CWD and cache chapter info for git tracking
	let narratorCwd: string;
	let narratorChapterId: string | undefined;
	let narratorProjectId: string | undefined;
	let narratorChapterRole: string | undefined;
	let narratorWorktreePath: string | undefined;
	let narratorBaseBranch: string | undefined;
	let projectGitPath: string | null = null;
	if (narrator.chapterId) {
		const ch = await db.query.chapters.findFirst({
			where: eq(chapters.id, narrator.chapterId),
		});
		if (!ch) throw new NotFoundError("Chapter", narrator.chapterId);
		// Always try to resolve project gitPath for skill loading
		const project = await db.query.projects.findFirst({
			where: eq(projects.id, ch.projectId),
		});
		projectGitPath = project?.gitPath ?? null;
		narratorProjectId = ch.projectId;
		if (ch.worktreePath) {
			// A saved narrator cwd is an explicit user override (for example, after
			// recovering from a missing workdir). Keep the chapter worktree as the
			// default only when no override has been chosen.
			narratorCwd = resolveNarratorSessionCwd(
				narrator.cwd,
				ch.worktreePath,
				projectGitPath,
				getHome(),
			);
			narratorChapterId = ch.id;
			narratorChapterRole = ch.role;
			narratorWorktreePath = ch.worktreePath;
			narratorBaseBranch = ch.baseBranch;
		} else {
			// Chapter is dormant — fall back to project gitPath or narrator cwd
			narratorCwd = resolveNarratorSessionCwd(narrator.cwd, null, project?.gitPath, getHome());
			logger.info("Chapter dormant, using fallback CWD", {
				chapterId: narrator.chapterId,
				narratorCwd,
			});
		}
	} else if (narrator.contextProjectId) {
		const project = await db.query.projects.findFirst({
			where: eq(projects.id, narrator.contextProjectId),
		});
		if (!project) throw new NotFoundError("Project", narrator.contextProjectId);
		narratorProjectId = project.id;
		projectGitPath = project.gitPath;
		narratorCwd = resolveNarratorSessionCwd(narrator.cwd, null, project.gitPath, getHome());
	} else {
		narratorCwd = resolveNarratorSessionCwd(narrator.cwd, null, null, getHome());
	}

	// Restore or create the persistent plan file ID if the narrator is already in plan mode
	// (e.g. server restart recovery). Keeping this stable prevents file-based plans from
	// becoming orphaned when the active narrator is recreated.
	const isPlanMode = isPlanModeTrait(narrator.traits);
	const planFileId = isPlanMode
		? await ensureNarratorPlanFileId(narratorId, narrator.planFileId)
		: undefined;
	const planFilePath = await resolveExistingPlanFileRelPath(narratorCwd, planFileId);

	// Layered traits: user → project → narrator. Resolved here so the cached
	// `_disabledTools`/`_blockedSkills` reflect the upper layers. The acting user is
	// not known at creation time (it is per-turn state), so the user layer is
	// applied on each turn instead — see the refresh in runTurn below.
	const creationTraits = await resolveEffectiveTraits({
		narratorTraits: narrator.traits,
		projectId: narratorProjectId ?? null,
		actingUserId: null,
	});

	// OAuth narrators may only see devices frozen into their provision snapshot.
	const resolvedSessionDevices = (await resolveSessionDevices(narratorProjectId ?? null)) ?? [];
	const authorizedSessionDevices = initialOAuthRuntime
		? filterOAuthSessionDevices(resolvedSessionDevices, initialOAuthRuntime)
		: resolvedSessionDevices;
	// Injection is narrower than authorization: an authorized device is only
	// described to the model when the layered injection policy says so, which is
	// what keeps a communal build machine out of every session's context. The
	// filter can only remove entries, so it is never an escalation path.
	const sessionDevices = resolveInjectedDevices(
		authorizedSessionDevices,
		creationTraits.deviceInjection,
	);

	const { prompt: effectiveSystemPrompt, usedCompactSummary } = await buildSystemPrompt(
		{
			systemPrompt: initialOAuthRuntime
				? (initialOAuthRuntime.systemPrompt ?? null)
				: narrator.systemPrompt,
			contextSummary: effectiveContextSummary,
		},
		narratorCwd,
		locale,
		replyInUserLanguage,
		isPlanMode,
		planFileId,
		settings.agent.defaultSystemPrompt,
		{
			devices: sessionDevices,
			defaultDeviceId: initialOAuthRuntime?.defaultDeviceId ?? narrator.defaultDeviceId ?? null,
			allowLocalExecution: initialOAuthRuntime?.allowLocalExecution ?? true,
		},
		planFilePath,
	);

	// Resolve and warm skill summaries for the Skill tool. This is context-based:
	// global + project git path + current working directory/workspace.
	let skillRoot: string | null = projectGitPath;
	let skillScopeKey: string | null = null;
	try {
		const { resolveSkillRoot } = await import("./skill-service");
		skillRoot = await resolveSkillRoot(projectGitPath, narratorCwd);
		const { warmSkillCacheForContext } = await import("../lib/agent/tools/skill");
		skillScopeKey = await warmSkillCacheForContext({ projectGitPath, cwd: narratorCwd });
	} catch {
		// Skill root resolution failure is non-fatal
	}

	// For standalone narrators, only enable Bash git-status-based file tracking
	// if cwd is inside a git repo. This prevents running `git status` on non-repo dirs.
	let narratorIsInGitRepo = !!narratorChapterId;
	if (!narratorChapterId) {
		try {
			narratorIsInGitRepo = await gitService.isGitRepo(narratorCwd);
		} catch {
			// Non-fatal — Bash file tracking just won't be enabled
		}
	}

	const abortController = new AbortController();
	const events = new EventEmitter();
	events.setMaxListeners(20);

	const narratorModelRef = narrator.model ?? FOLLOW_DEFAULT_MODEL;
	const narratorModel = resolveEffectiveModel(narratorModelRef);
	const narratorProvider = resolveProvider(narratorModel);

	const active: ActiveNarrator = {
		abortController,
		narratorId,
		conversationId: effectiveConversationId ?? randomUUID(),
		_resetUpstreamSessionOnNextRequest: effectiveConversationId == null,
		_persistedConversationId: effectiveConversationId ?? null,
		cwd: narratorCwd,
		_modelRef: narratorModelRef,
		_settingsRevision: getSettingsRevision(),
		model: narratorModel,
		provider: narratorProvider,
		_reasoningEffortRef: narrator.reasoningEffort ?? null,
		reasoningEffort:
			narrator.reasoningEffort ??
			resolveDefaultReasoningEffort(narratorProvider, narratorModel) ??
			null,
		systemPrompt: effectiveSystemPrompt,
		events,
		alive: true,
		locale,
		_usedCompactSummary: usedCompactSummary,
		_replyInUserLanguage: replyInUserLanguage,
		_chapterId: narratorChapterId,
		_projectId: narratorProjectId,
		_chapterRole: narratorChapterRole,
		_worktreePath: narratorWorktreePath,
		_baseBranch: narratorBaseBranch,
		_isInGitRepo: narratorIsInGitRepo,
		_planFileId: planFileId,
		_planFilePath: planFilePath,
		_preparedPlanModes: new Map(),
		_projectGitPath: projectGitPath,
		_skillRoot: skillRoot,
		_skillScopeKey: skillScopeKey,
		_enabledOptionalTools: new Set(),
		_disabledTools: getDisabledToolSet(creationTraits.traits),
		_blockedSkills: getBlockedSkills(creationTraits.traits),
		_narratorKind: isKnowledgeStewardNarrator(narrator.traits) ? "knowledge" : undefined,
		_interruptCleanupDone: false,
		_substatus: new Set(),
		// Explicitly null so a rebuilt active never carries a stale/undefined user.
		// Set per-trigger by feedMessage / continue / retry / re-execute paths.
		_currentUserId: null,
		// Session default execution device (null → local). Restored from the
		// narrator record; mutated by the SwitchDevice tool.
		_defaultDeviceId: initialOAuthRuntime?.defaultDeviceId ?? narrator.defaultDeviceId ?? null,
	};

	if (initialOAuthRuntime) {
		if (initialOAuthRuntime.allowKnowledgeWrite) {
			active._enabledOptionalTools.add("KnowledgeCreate");
			active._enabledOptionalTools.add("KnowledgeEdit");
		}
	} else {
		// Auto-load optional tools whose routines are globally enabled.
		const disabledRoutines = new Set(settings.routines?.disabledRoutines ?? []);
		const enabledRoutines = new Set(settings.routines?.enabledRoutines ?? []);
		for (const routine of getBuiltinToolRoutines()) {
			if (!routine.tool) continue;
			const on = routine.defaultEnabled
				? !disabledRoutines.has(routine.id)
				: enabledRoutines.has(routine.id);
			if (on) {
				for (const toolName of getBuiltinToolNames(routine.tool)) {
					active._enabledOptionalTools.add(toolName);
				}
			}
		}
		// Merge tools explicitly enabled on this narrator (via /load).
		if (Array.isArray(narrator.enabledTools)) {
			for (const toolName of narrator.enabledTools) {
				if (OPTIONAL_TOOLS.has(toolName)) active._enabledOptionalTools.add(toolName);
			}
		}
	}

	activeNarrators.set(narratorId, active);

	// Start file watcher for the worktree (covers terminal/editor changes)
	if (narratorWorktreePath && narratorChapterId) {
		worktreeWatcher.watch(narratorWorktreePath, narratorChapterId, narratorId, locale);
	}

	return active;
}

/**
 * Broadcast a kept partial assistant message after an interrupt so the
 * frontend can replace its optimistic streaming text with the persisted
 * message in the same render. Without this, the frontend's `onStatusChange`
 * (interrupted) clears the streaming blocks but never receives the real
 * message, so the already-streamed text disappears until the next catch-up.
 *
 * Mirrors the `assistant_message` broadcast in narrator-event-handler so the
 * WS payload is shaped identically to the normal completion path.
 */
async function broadcastInterruptedPartialMessage(
	narratorId: string,
	partialId: string,
): Promise<void> {
	try {
		const fullMessage = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, partialId),
			with: { toolCalls: true },
		});
		if (!fullMessage) return;

		const ref = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, partialId),
			),
			columns: { seq: true },
		});

		const processed = enrichToolUseBlocks(truncateToolIO([{ ...fullMessage, seq: ref?.seq }]))[0];

		// Subagent dual-broadcast: also surface this message on the parent
		// narrator's page (as a child of the spawning tool_use) so the
		// SubagentCard's transcript stays consistent with the subagent page.
		// Mirror the eventContext resolution: prefer the takeover watcher, then
		// fall back to the narrator record's parentNarratorId.
		const parentToolUseId = fullMessage.parentToolUseId ?? undefined;
		if (parentToolUseId) {
			const watcher = getConclusionWatcher(narratorId);
			let parentNarratorId = watcher?.parentNarratorId;
			if (!parentNarratorId) {
				const self = await db.query.narrators.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { parentNarratorId: true },
				});
				parentNarratorId = self?.parentNarratorId ?? undefined;
			}
			if (parentNarratorId && parentNarratorId !== narratorId) {
				broadcastToNarrator(parentNarratorId, {
					type: "message",
					narratorId: parentNarratorId,
					message: processed,
				});
			}
		}

		// Primary broadcast to this narrator's own subscribers. Strip
		// parentToolUseId so the subagent page treats it as a top-level message.
		broadcastToNarrator(narratorId, {
			type: "message",
			narratorId,
			message: { ...processed, parentToolUseId: null },
		});
	} catch (err) {
		logger.warn("Failed to broadcast interrupted partial message", {
			narratorId,
			partialId,
			error: String(err),
		});
	}
}

async function finalizeInterruptedRun(
	active: ActiveNarrator,
	narratorId: string,
	partialId?: string,
): Promise<void> {
	if (active._interruptCleanupDone) {
		return;
	}
	active._interruptCleanupDone = true;

	logger.info("Agent loop aborted (interrupted)", { narratorId });
	active.events.emit("event", {
		type: "interrupted",
		data: { message: "Narrator interrupted" },
	});

	if (partialId) {
		try {
			// Preserve the partial assistant message before any deletion decision runs.
			// `finalizeOrCleanupPartialMessage` keeps messages that contain executed
			// tool calls, so first convert in-flight calls on this partial message into
			// explicit interrupted failures.  Running this sequentially avoids a race
			// where the finalizer sees only "initializing" tool calls and deletes the
			// whole message, making already-visible tool calls disappear from history.
			await markInterruptedToolCallsForMessage(narratorId, partialId, active.locale);
			const kept = await finalizeOrCleanupPartialMessage(partialId, narratorId);
			// Broadcast the kept message so the frontend swaps its optimistic
			// streaming text for the persisted message immediately, instead of
			// dropping it until the next catch-up reload.
			if (kept) {
				await broadcastInterruptedPartialMessage(narratorId, partialId);
			}
		} catch (err) {
			logger.warn("Failed to finalize interrupted partial message", {
				narratorId,
				partialId,
				error: String(err),
			});
		}
	}

	try {
		await cleanupOrphanedToolCalls(narratorId, active.locale);
	} catch (err) {
		logger.warn("Failed to clean up orphaned tool calls after interrupt", {
			narratorId,
			error: String(err),
		});
	}

	try {
		const current = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { status: true, substatus: true },
		});
		const currentSubstatus = parseSubstatus(current?.substatus);
		if (!(current?.status === "idle" && currentSubstatus.includes("error"))) {
			await narratorService.updateStatus(narratorId, "idle", { substatus: ["interrupted"] });
		}
	} catch (err) {
		logger.warn("Failed to update narrator status after interrupt", {
			narratorId,
			error: String(err),
		});
	}

	// Interrupt task guard: when the user stops the narrator mid-flight it usually
	// means the direction changed, yet any open Dynamic Spec task would still drive
	// the next auto-continuation. Suppress exactly one continuation and leave a
	// persisted system note so the model reconciles tasks against the user's next
	// message instead of resuming the stale one.
	await maybeDeliverInterruptTaskGuard(active, narratorId);
}

// === Interrupt task guard ===

/**
 * Dedupe key for the interrupt task guard: narratorId → tasks.json revisionId the
 * guard last fired for. `hotSafe` so a dev hot-reload does not re-arm every guard.
 * When the spec has not changed since the last injection there is nothing new to
 * tell the model, so repeated interrupts stay quiet instead of stacking cards.
 */
const interruptTaskGuardRevisions = hotSafe<Map<string, string | null>>(
	"narrafork.interruptTaskGuardRevisions",
	() => new Map(),
);

/**
 * Narrators whose NEXT spec continuation must be skipped once, after an interrupt.
 *
 * Deliberately NOT a field on `ActiveNarrator`: `createNarrator` throws the existing
 * active object away and builds a fresh one whenever a message arrives for a narrator
 * that already has a session. The user's message right after an interrupt is exactly
 * that case, so a flag living on the old object is gone before the turn it was meant
 * to suppress — the guard would appear to work while never actually firing.
 *
 * Keyed by narratorId in module state (`hotSafe`, so a dev reload does not silently
 * re-arm every narrator) and consumed exactly once by `maybeStartSpecContinuation`.
 */
const suppressSpecContinuationOnce = hotSafe<Set<string>>(
	"narrafork.suppressSpecContinuationOnce",
	() => new Set(),
);

/**
 * After an interrupt, if spec://tasks.json still has open tasks, suppress the next
 * auto-continuation once and persist a system note telling the model to reconcile
 * the open tasks against the user's next message before resuming anything.
 *
 * Best-effort: any failure is logged and swallowed so interrupt cleanup can never
 * be blocked by a reminder. No-op when there is nothing open to guard against.
 */
async function maybeDeliverInterruptTaskGuard(
	active: ActiveNarrator,
	narratorId: string,
): Promise<void> {
	try {
		const file = await specVfsService.readTasksFileForNarrator(narratorId);
		const compiled = compileSpecTasks(parseSpecTasksDocument(file.content));
		const openTasks = compiled.tasks.filter(
			(task) => task.status === "doing" || task.status === "todo" || task.status === "blocked",
		);
		if (openTasks.length === 0) return;

		// One-shot suppression: the user's next turn decides the direction; a stale
		// doing task must not start an auto-continuation right after it. Stored per
		// narratorId rather than on `active`, which does not survive the next message
		// (see suppressSpecContinuationOnce).
		suppressSpecContinuationOnce.add(narratorId);

		const revisionId = file.revisionId ?? null;
		if (interruptTaskGuardRevisions.get(narratorId) === revisionId) return;
		interruptTaskGuardRevisions.set(narratorId, revisionId);

		const isZh = active.locale === "zh-CN";
		const taskLines = openTasks
			.slice(0, 8)
			.map((task) => `- [${task.status}] ${task.text}${task.protected ? " [protected]" : ""}`)
			.join("\n");
		const content = isZh
			? `刚才的运行被用户中断，这通常意味着方向有变化。当前 spec://tasks.json 中仍有以下开放任务：\n\n${taskLines}\n\n这些任务可能已经过期或与用户最新意图不一致。回复用户的下一条消息时，以用户消息为准；如需调整计划，先更新/删除过期任务（protected 任务变更会触发 taskReflection），再继续执行。不要无视用户新指令而直接恢复旧任务。`
			: `The run was just interrupted by the user, which usually means the direction changed. spec://tasks.json still has these open tasks:\n\n${taskLines}\n\nThey may be stale or no longer match the user's latest intent. When the user's next message arrives, treat it as the source of truth; update or remove outdated tasks first if the plan changed (protected task changes trigger taskReflection), then continue. Do not resume an old task over the user's new instruction.`;

		// deliverInjection is statically imported at module top; the circularity with
		// narrator-injection is already handled by that module's lazy scheduler seam.
		await deliverInjection(narratorId, {
			content,
			source: "interrupt_task_guard",
			// Persisted as a plain row; the next user turn reads it from history.
			schedule: "none",
			locale: active.locale,
		});
	} catch (err) {
		logger.warn("Failed to deliver interrupt task guard", {
			narratorId,
			error: String(err),
		});
	}
}

// === Agent loop execution ===

/** Sum non-cached input + output tokens from a usage snapshot (for round token totals). */
function tokenUsageValue(usage?: TokenUsageSnapshot): number {
	if (!usage) return 0;
	const nonCachedInput = Math.max(0, (usage.inputTokens ?? 0) - (usage.cachedInputTokens ?? 0));
	if (usage.inputTokens != null || usage.completionTokens != null) {
		return nonCachedInput + Math.max(0, usage.completionTokens ?? 0);
	}
	return Math.max(0, usage.promptTokens ?? 0) + Math.max(0, usage.completionTokens ?? 0);
}

async function ensureSkillCacheFreshForActiveNarrator(active: ActiveNarrator): Promise<void> {
	try {
		const { warmSkillCacheForContext } = await import("../lib/agent/tools/skill");
		active._skillScopeKey = await warmSkillCacheForContext({
			projectGitPath: active._projectGitPath ?? null,
			cwd: active.cwd,
		});
	} catch (err) {
		logger.debug("Failed to refresh skill cache for active narrator", {
			narratorId: active.narratorId,
			error: String(err),
		});
	}
}

export async function updateActiveNarratorCwdAndSkillContext(
	narratorId: string,
	cwd: string,
): Promise<void> {
	const active = activeNarrators.get(narratorId);
	if (!active?.alive) return;
	active.cwd = cwd;
	try {
		const { resolveSkillRoot } = await import("./skill-service");
		active._skillRoot = await resolveSkillRoot(active._projectGitPath, cwd);
	} catch {
		active._skillRoot = active._projectGitPath ?? null;
	}
	if (!active._chapterId) {
		try {
			active._isInGitRepo = await gitService.isGitRepo(cwd);
		} catch {
			active._isInGitRepo = false;
		}
	}
	await ensureSkillCacheFreshForActiveNarrator(active);
}

/**
 * Compute the most recent pass's token delta (non-cached input + output) and
 * reset the per-pass baseline. Callers sum the returned value across passes to
 * obtain a round-level token total for the Stop hook.
 */
function accountTokenUsageForTurn(active: ActiveNarrator): number {
	const tokenDelta = Math.max(
		0,
		tokenUsageValue(active._lastTokenUsage) - tokenUsageValue(active._tokenUsageBaseline),
	);
	active._tokenUsageBaseline = active._lastTokenUsage;
	return tokenDelta;
}

async function loadCompiledSpecForContinuation(narratorId: string) {
	const file = await specVfsService.readTasksFileForNarrator(narratorId);
	let document = parseSpecTasksDocument(file.content);
	let compiled = compileSpecTasks(document);
	if (!compiled.currentTask && compiled.nextTask) {
		let promoted = false;
		document = {
			tasks: document.tasks.map((task) => {
				if (!promoted && task.status === "todo") {
					promoted = true;
					return { ...task, status: "doing" as const };
				}
				return task;
			}),
		};
		const content = `${JSON.stringify(document, null, "\t")}\n`;
		await specVfsService.writeSpecFile(narratorId, "spec://tasks.json", content, {
			createdBy: "system",
			allowProtectedTaskMutation: true,
		});
		compiled = compileSpecTasks(document);
	}
	return compiled;
}

async function maybeStartSpecContinuation(
	active: ActiveNarrator,
	freshNarrator: {
		permissionMode?: string | null;
		traits?: unknown;
		autoContinuationOverride?: string | null;
	},
	loopHadError: boolean,
	options?: { explicitStart?: boolean },
): Promise<string | null> {
	if (loopHadError || isPlanModeTrait(freshNarrator.traits) || active._continuationSuppressed) {
		return null;
	}
	// One-shot interrupt guard: the turn right after a user interrupt belongs to the
	// user's new message, not to whatever task was open before. Consume the flag so
	// later turns resume normal continuation semantics.
	if (suppressSpecContinuationOnce.delete(active.narratorId)) {
		return null;
	}
	// Resolve the effective auto-continuation mode (narrator override → global default)
	const globalMode = normalizeAutoContinuationMode(settings.agent.autoContinuationMode);
	const effectiveMode = resolveAutoContinuationMode(
		freshNarrator.autoContinuationOverride,
		globalMode,
	);
	// An explicit user `/goal` should always launch its first execution turn. The
	// auto-continuation setting still governs any later turns after that first pass.
	if (effectiveMode === "off" && !options?.explicitStart) return null;

	let compiled: ReturnType<typeof compileSpecTasks>;
	try {
		compiled = await loadCompiledSpecForContinuation(active.narratorId);
	} catch (err) {
		logger.debug("Spec continuation skipped", {
			narratorId: active.narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}

	// "protectedOnly": only continue if there are protected tasks still open
	if (effectiveMode === "protectedOnly" && compiled.protectedOpenCount === 0) {
		return null;
	}

	const current = compiled.currentTask;
	if (!current) {
		// Only blocked tasks remain
		if (effectiveMode === "blockStop") return null;
		const blocked = compiled.tasks.find((task) => task.status === "blocked");
		if (!blocked) return null;
		const actionInstruction = getBlockedTaskActionInstruction(active.locale);
		// `actionInstruction` already classifies the blocker and covers both branches, so
		// this copy only adds what it cannot: that the message is system-generated, the tool
		// name for asking, and that a stale entry may be rewritten. Restating its branches
		// here (an earlier revision did) just made the prompt longer and self-repeating.
		const prompt =
			active.locale === "zh-CN"
				? `Dynamic Spec blocked 任务续跑（系统消息，不是用户发言）。\n\n系统在 spec://tasks.json 有 blocked 条目时自动发出这条消息。\n\nblocked 任务（仅这一条，不是完整任务列表；其余任务仍在 spec://tasks.json 中）：${blocked.text}${blocked.protected ? " [protected]" : ""}\n\n${actionInstruction}\n\n需要用户介入时，用 AskUserQuestion 提问并结束回合；不要靠反复改写 tasks.json 或重跑同样的调查来绕开。如果该条目已不符合当前实际，可在保留用户原意图的前提下改写或删除它，并说明原因。改动 tasks.json 时先读取再就地修改，不要按本消息重写整个文件。`
				: `Dynamic Spec blocked-task continuation (system message, not the user speaking).\n\nThe system emits this whenever spec://tasks.json has a \`blocked\` entry.\n\nBlocked task (this one only — not the full task list; your other tasks are still in spec://tasks.json): ${blocked.text}${blocked.protected ? " [protected]" : ""}\n\n${actionInstruction}\n\nWhen the blocker needs the user, ask with AskUserQuestion and end the turn; do not work around it by rewriting tasks.json or re-running the same investigation. If the entry no longer matches reality, rewrite or remove it while preserving the user's original intent, and say why. When you change tasks.json, read it first and edit in place; do not rewrite the file from this message.`;
		const msg = await narratorService.persistSystemMessage(active.narratorId, prompt, [
			{
				type: "spec_blocked_continuation",
				task: blocked.text,
				protected: blocked.protected === true,
			},
		]);
		broadcastToNarrator(active.narratorId, {
			type: "message",
			narratorId: active.narratorId,
			message: {
				id: msg.id,
				narratorId: active.narratorId,
				role: msg.role,
				contentJson: msg.contentJson,
				contentText: msg.contentText,
				createdAt: msg.createdAt,
				seq: msg.seq,
				children: [],
			},
		});
		active._continuationTurn = "blocked";
		return prompt;
	}
	const protectedNote = current.protected
		? active.locale === "zh-CN"
			? "\n- protected：只有具备具体验收证据才能标记 done，该变更会触发 taskReflection。"
			: "\n- Protected: mark it done only with concrete completion evidence; that change runs taskReflection."
		: "";
	// ⚠️ Compiled from tasks.json, not written by the user, and emitted purely because a
	// `doing` entry is still open — so it has to say so.
	//
	// The wording it replaces restated the task and ordered the model to continue ("Do not
	// ask the user whether to continue"), which is indistinguishable from the user insisting
	// the work is unfinished. Three observed failure modes came from that:
	//
	//  1. Work done, tasks.json not yet updated → the model reads the restated task as "you
	//     are not done" and reworks code that was already correct.
	//  2. The task needs the user (one was titled "需用户跑") → being told to act rather than
	//     ask, the model edited tasks and got nudged again, 37 times in one session.
	//  3. The task no longer matches reality → with no licence to say so, it grinds a stale
	//     objective.
	//
	// Hence: state provenance, then enumerate the legitimate outcomes. The list must not be
	// framed as "ways to END the turn" — "keep working" is one of the branches.
	//
	// It also names ONE task while tasks.json may hold many, so it says so. A model that
	// reads this single line as the whole file concludes its other entries were lost and
	// "restores" them by rewriting tasks.json — destroying the entries that were fine.
	const prompt =
		active.locale === "zh-CN"
			? `Dynamic Spec 自动续跑（系统消息，不是用户发言）。\n\n系统在 spec://tasks.json 仍有 doing 条目时自动发出这条消息。它只说明该条目尚未标记完成 —— 不代表系统判断你没做完，条目内容也可能已经过时。\n\n当前任务（仅这一条，不是完整任务列表；其余任务仍在 spec://tasks.json 中）：${current.text}${current.protected ? " [protected]" : ""}\n\n请先判断该任务的真实状态，再按实际情况选择其一：\n- 已经完成：在 spec://tasks.json 标记 done。这就是本回合的有效结果，不要因为这条提醒去返工已经正确的改动。\n- 未完成且能自主推进：继续执行。\n- 需要用户提供信息、权限、决策，或需要用户亲自操作：先做完不受阻的部分，再用 AskUserQuestion 提出一个精确问题并结束回合。\n- 已不符合当前实际：在保留用户原意图的前提下改写或删除该条目，并说明原因。\n\n改动 spec://tasks.json 时先读取再就地修改，不要按本消息重写整个文件。${protectedNote}`
			: `Dynamic Spec auto-continuation (system message, not the user speaking).\n\nThe system emits this whenever spec://tasks.json still has a \`doing\` entry. It only means the entry is not marked finished — not that the system judged your work incomplete, and its content may be out of date.\n\nCurrent task (this one only — not the full task list; your other tasks are still in spec://tasks.json): ${current.text}${current.protected ? " [protected]" : ""}\n\nDecide what is actually true of this task, then take exactly one of these paths:\n- Already done: mark it done in spec://tasks.json. That is a valid result for this turn; do not rework a change that was already correct.\n- Unfinished and you can advance it: keep working.\n- Needs the user's information, permission, decision, or an action only they can perform: finish every unblocked part, then ask one precise question with AskUserQuestion and end the turn.\n- No longer matches reality: rewrite or remove the entry while preserving the user's original intent, and say why.\n\nWhen you change spec://tasks.json, read it first and edit in place; do not rewrite the file from this message.${protectedNote}`;
	const msg = await narratorService.persistSystemMessage(active.narratorId, prompt, [
		{ type: "spec_continuation", task: current.text, protected: current.protected === true },
	]);
	broadcastToNarrator(active.narratorId, {
		type: "message",
		narratorId: active.narratorId,
		message: {
			id: msg.id,
			narratorId: active.narratorId,
			role: msg.role,
			contentJson: msg.contentJson,
			contentText: msg.contentText,
			createdAt: msg.createdAt,
			seq: msg.seq,
			children: [],
		},
	});
	active._continuationTurn = "task";
	return prompt;
}

/**
 * Write the session's upstream conversation id back to the DB, but only while the
 * row still holds the id this session started from.
 *
 * The guard exists because `apiConversationId = null` is a compact's way of saying
 * "the history was replaced; the next request must open a fresh upstream session".
 * Background compacts are fire-and-forget and routinely settle around a turn
 * boundary, so a plain write at teardown — on a turn that ended with no error at
 * all — could reinstate the stale id and make the next activation resume a session
 * whose upstream state still contains the pre-compact conversation.
 *
 * Losing the CAS is the correct outcome, not a failure: it means someone
 * deliberately moved the row, so we leave their value alone.
 */
function persistConversationIdIfUnchanged(
	narratorId: string,
	active: ActiveNarrator,
	context?: string,
): void {
	const expected = active._persistedConversationId ?? null;
	const next = active.conversationId;
	// Nothing to write: the row already holds exactly this id.
	if (expected === next) return;
	narratorService
		.updateConversationId(narratorId, next, expected)
		.then((applied) => {
			if (applied) {
				active._persistedConversationId = next;
				return;
			}
			logger.debug("Skipped conversationId write: row moved since session start", {
				narratorId,
				...(context ? { context } : {}),
			});
		})
		.catch((err) => {
			logger.error("Failed to persist conversationId", {
				narratorId,
				...(context ? { context } : {}),
				error: String(err),
			});
		});
}

/**
 * Start an auto-continuation turn if the Dynamic Spec has an active/blocked
 * task that warrants continuing. Returns the injected prompt, or null when there
 * is nothing to continue.
 */
async function maybeStartContinuation(
	active: ActiveNarrator,
	loopHadError: boolean,
	options?: { explicitStart?: boolean },
): Promise<string | null> {
	// Settings can change while a provider turn is in flight. Re-read the narrator
	// immediately before deciding whether to continue so every strategy change takes
	// effect at the current turn boundary instead of using a stale mode for one extra turn.
	const latestNarrator = await narratorService.getById(active.narratorId);
	const prompt = await maybeStartSpecContinuation(active, latestNarrator, loopHadError, options);
	// A continuation turn is not the user's turn — never let it write the behavior fence,
	// even if the preceding user turn ran zero tools and left the grant open.
	if (prompt) clearBehaviorFenceEditGrant(active.narratorId);
	return prompt;
}

/** The ActiveNarrator fields holding a cadence's last-fired marker. */
type CadenceMarkerField = "_lastTasksReminderCompletedToolCount" | "_lastFenceCompletedToolCount";

/**
 * Build an {@link InjectionCadence} whose marker lives on the ActiveNarrator.
 *
 * The marker has to survive across loop passes: a session runs many passes and each
 * rebuilds its config, so a marker owned by the cadence object would restart the
 * schedule every time. The field stays the single source of truth and the cadence
 * object is disposable.
 *
 * Seeded from the persisted completed-tool count when unset, so a resumed session does
 * not read its whole history as one overdue interval and fire on its first tool result.
 */
function resolveCadence(
	active: ActiveNarrator,
	field: CadenceMarkerField,
	resolveInterval: () => number,
): InjectionCadence {
	if (active[field] === undefined) {
		active[field] = active._todoReminderCompletedToolCount ?? 0;
	}
	return new InjectionCadence(resolveInterval, {
		get: () => active[field] ?? 0,
		set: (count) => {
			active[field] = count;
		},
	});
}

/**
 * Deliver every queued injection for a narrator, in the order the events happened.
 *
 * ## The bug this replaces
 *
 * Background completions (agent + bash) and `Send({ id: "parent" })` reports used to sit
 * in three unrelated queues, drained one after another in a hard-coded sequence
 * (completions first, messages second). That sequence was not a policy — it is what you
 * are forced to write when no order exists between the queues. The visible consequence
 * was a causality inversion: a subagent that reports "ready" via Send and then finishes
 * had its completion shown BEFORE the message that preceded it.
 *
 * They now share one queue that is ordered at enqueue (`parent-injection-queue`), and
 * this function is the single consumer.
 *
 * ## Why ONE function serves both the busy and the idle path
 *
 * Each path previously drained only the queue it cared about. Against a shared queue
 * that would be a silent data-loss bug: `startBackgroundCompletionContinuationIfPossible`
 * would drain the whole bucket, deliver the completions and DROP any messages that had
 * been queued alongside them. Having one consumer makes that impossible, and it means an
 * idle parent woken by a completion also receives the message that arrived before it.
 *
 * The two modes differ only in what the caller needs afterwards:
 *
 *   `busy` — `schedule: "onNextTurn"`, so the running loop folds the text into the turn
 *            it is about to send (its in-memory history was built at pass start).
 *   `idle` — `schedule: "none"`, because the caller holds `continuationStartLock` and
 *            starts the loop itself; asking `deliverInjection` to wake would re-enter
 *            that lock and deadlock. Completions also carry their FULL result here, since
 *            a turn is being started specifically to deal with them.
 *
 * Returns the concatenated model-facing text, or null when nothing was queued — the idle
 * callers use that as their "is a turn worth starting" signal.
 */
async function deliverPendingInjectionsInOrder(
	narratorId: string,
	locale: Locale,
	mode: "busy" | "idle",
): Promise<string | null> {
	const pending = drainPendingInjections(narratorId);
	if (pending.length === 0) return null;
	const schedule = mode === "busy" ? "onNextTurn" : "none";
	const parts: string[] = [];

	// One injection row PER entry. The queue's global arrival order is the truth, so we
	// walk `pending` directly rather than grouping consecutive same-kind entries into a
	// shared row: a row that fans out into N bubbles has no per-bubble address, which is
	// what made delete/rollback impossible to aim at one of them. A single entry per row
	// gives every bubble its own blockIndex and its own context-menu target.
	//
	// Each entry is delivered inside its own try/catch, matching `flushLoopInjections`.
	// `drainPendingInjections` empties the bucket atomically, so an escaping throw here
	// would discard every entry AFTER the failing one — they are no longer in the queue
	// and nothing re-enqueues them. A single failed INSERT (SQLite busy, WAL full) would
	// silently swallow a teammate's message or a background result. The batch is best
	// effort by construction: the entries are independent, so one bad row must not decide
	// the fate of the rest.
	for (const entry of pending) {
		try {
			const text = await deliverPendingInjection(narratorId, locale, mode, schedule, entry);
			if (text) parts.push(text);
		} catch (err) {
			logger.warn("Failed to deliver a pending injection row", {
				narratorId,
				kind: entry.kind,
				mode,
				error: String(err),
			});
		}
	}

	const joined = parts.filter((part) => part.trim().length > 0).join("\n\n");
	return joined.length > 0 ? joined : null;
}

/**
 * Write ONE queued injection as its own row and return its model-facing text.
 *
 * Split out of {@link deliverPendingInjectionsInOrder} so each entry can fail in
 * isolation: as a separate function the per-kind branches return instead of
 * `continue`, which is what lets the caller wrap the whole body in one try/catch
 * without swallowing the loop's control flow.
 */
async function deliverPendingInjection(
	narratorId: string,
	locale: Locale,
	mode: "busy" | "idle",
	schedule: "onNextTurn" | "none",
	entry: PendingInjection,
): Promise<string | null> {
	{
		const kind = entry.kind;

		if (kind === "bg_agent") {
			const task = entry.task;
			const projected = sideCarBodyWithText(
				"bg_agent",
				{
					kind: "tasksDone",
					flavor: "agent",
					items: [
						{
							id: task.id,
							alias: task.alias ?? null,
							title: task.title,
							status: task.status,
							preview: task.resultPreview ?? "",
							...(task.resultTruncated ? { truncated: true } : {}),
							// Reader-only navigation target (the agent's own message that produced
							// this result). Omitted rather than stored as null when absent, so a
							// row written before this existed and a run with no assistant text are
							// the same shape to every consumer.
							...(task.resultMessageId ? { resultMessageId: task.resultMessageId } : {}),
						},
					],
				},
				locale,
			);
			// The idle path keeps its own longer wording (full result + how to Await it),
			// which is what that path has always sent and is asserted elsewhere; the
			// structured body rides along either way for the reader.
			const content =
				mode === "idle"
					? formatBackgroundCompletionNotifications([task], { includeResult: true })
					: projected.content;
			const { turnText } = await deliverInjection(narratorId, {
				content,
				body: projected.body,
				source: "bg_agent",
				schedule,
				locale,
				// Preserved so the reader keeps the richer card this producer already had.
				extraBlocks: [
					{
						type: "background_agents_completed",
						tasks: [
							{
								id: task.id,
								title: task.title,
								status: task.status,
								resultPreview: task.resultPreview,
								resultTruncated: task.resultTruncated ?? false,
							},
						],
					},
				],
			});
			return turnText ?? content;
		}

		if (kind === "bg_bash") {
			const bashTask = entry.task;
			const items = [
				{
					id: bashTask.id,
					alias: bashTask.alias ?? null,
					title: bashTask.title || bashTask.id,
					status: bashTask.status,
					preview: bashTask.outputPreview ?? "",
				},
			];
			// `sideCarBodyWithText` renders the model-facing text from the SAME body in one
			// call, which is what keeps the two projections from drifting apart.
			const { body, content } = sideCarBodyWithText(
				"bg_bash",
				{ kind: "tasksDone", flavor: "bash", items },
				locale,
			);
			const { turnText } = await deliverInjection(narratorId, {
				content,
				body,
				source: "bg_bash",
				schedule,
				locale,
			});
			return turnText ?? content;
		}

		// Progress reports a child subagent sent with Send({ id: "parent" }). The queue
		// caps itself at 20 messages per kind / 8000 chars per message, so no truncation
		// is needed here.
		const message = entry.message;
		const projected = sideCarBodyWithText(
			"subagent_message",
			{
				kind: "messages",
				items: [
					{
						fromId: message.fromId,
						fromTitle: message.fromTitle ?? null,
						fromLabel: message.fromLabel ?? null,
						fromType: message.fromType ?? null,
						// Reader-only navigation target, omitted when the sender had written
						// nothing yet (see the field's own doc).
						...(message.fromMessageId ? { fromMessageId: message.fromMessageId } : {}),
						text: message.text,
					},
				],
			},
			locale,
		);
		const content =
			mode === "idle" ? formatParentInboundMessages([message], locale) : projected.content;
		const { turnText } = await deliverInjection(narratorId, {
			content,
			body: projected.body,
			source: "subagent_message",
			schedule,
			locale,
			extraBlocks: [
				{
					type: "subagent_messages",
					messages: [
						{
							fromId: message.fromId,
							fromTitle: message.fromTitle,
							fromType: message.fromType,
							timestamp: message.timestamp,
						},
					],
				},
			],
		});
		return turnText ?? content;
	}
}

/**
 * Deliver everything queued to an IDLE narrator that is about to be woken.
 *
 * Both wake entry points (a finished background task, an inbound subagent message) route
 * here, because they now share ONE queue. Draining only your own kind against a shared
 * queue would silently discard the others: a completion-triggered wake would drop the
 * message that had been queued beside it. As a bonus, a narrator woken by either event
 * receives the whole batch in event order rather than just the trigger.
 *
 * `schedule: "none"` even though the point of this path IS to start a turn: the callers
 * run inside `continuationStartLock` and start the loop themselves once this returns, so
 * asking `deliverInjection` to wake would re-enter that same lock and deadlock.
 */
async function drainAndPersistPendingInjections(active: ActiveNarrator): Promise<string | null> {
	return deliverPendingInjectionsInOrder(active.narratorId, active.locale, "idle");
}

/**
 * Drain finished background work into the conversation, for a narrator that is BUSY.
 *
 * The counterpart to `drainAndPersistPendingInjections` (the idle path). Both
 * now write a real message row through `deliverInjection`; they differ only in what
 * happens next, which is the whole point of separating `role` from `schedule`:
 *
 *   idle → `wakeIfIdle`, because nothing is running to notice the row
 *   busy → `onNextTurn`, because the loop is mid-flight and its in-memory history was
 *          built at pass start, so the row alone would go unseen until the next pass
 *
 * The returned text is what the loop folds into the turn it is about to send. Nothing
 * is yielded for persistence: the row is already written.
 *
 * `includeResult: false` keeps the busy path's existing economy — a preview here, the
 * full output on demand via `Await`. The idle path passes `true` because it is
 * starting a turn specifically to deal with the result.
 */
async function drainInjectionsIntoHistory(active: ActiveNarrator, locale: Locale): Promise<string> {
	const narratorId = active.narratorId;
	const parts: string[] = [];

	// ── Cadence-driven reminders ────────────────────────────────────────────────
	//
	// These used to ride inside a tool result's string, which is why they carried a
	// `toolUseId`. Neither is about a specific tool call — both are session-level
	// ("here is your task list", "here are your standing constraints") — so they now
	// land at the turn boundary as their own rows.
	//
	// The tick they are measured against is the completed-tool count the loop maintains
	// (`active._todoReminderCompletedToolCount`), so the cadence is unchanged: still
	// "every N completed tool calls", just delivered once per turn instead of once per
	// tool result. A turn that ran several tools therefore produces at most one reminder
	// rather than one per tool, which is strictly less repetition.
	const count = active._todoReminderCompletedToolCount ?? 0;
	// Both cadences read their interval live (a narrator override can change
	// mid-session) and keep their marker on `active`, which is what makes them survive
	// across loop passes. `InjectionCadence.due` spends the tick when asked — so an
	// empty spec or a blank fence does not leave the cadence permanently due, re-reading
	// the file from SQLite every time.
	const atTasksCadence = resolveCadence(
		active,
		"_lastTasksReminderCompletedToolCount",
		() => active._tasksReminderInterval ?? 15,
	).due(count);
	const atFenceCadence = resolveCadence(
		active,
		"_lastFenceCompletedToolCount",
		() => active._fenceInterval ?? -1,
	).due(count);

	const tasksBody = atTasksCadence ? await buildSpecTaskDigestBody(narratorId) : null;
	if (tasksBody) {
		// Stamp the cadence that raised this digest so the reader-facing header can say
		// "每 N 次工具调用", distinguishing a routine digest from a turn-end
		// continuation (which lists the same tasks but for a different reason).
		if (tasksBody.kind === "tasks") {
			tasksBody.cadenceInterval = active._tasksReminderInterval ?? 15;
		}
		const { body, content } = sideCarBodyWithText("living_work_spec", tasksBody, locale);
		const { turnText } = await deliverInjection(narratorId, {
			content,
			body,
			source: "living_work_spec",
			schedule: "onNextTurn",
			locale,
		});
		if (turnText) parts.push(turnText);
	}

	// The fence goes out on its own cadence, or alongside a tasks reminder when the
	// narrator is configured to attach the two.
	if (atFenceCadence || (!!active._fenceAttach && !!tasksBody)) {
		const fenceBody = await buildBehaviorFenceBody(narratorId);
		if (fenceBody) {
			const { body, content } = sideCarBodyWithText("behavior_fence", fenceBody, locale);
			const { turnText } = await deliverInjection(narratorId, {
				content,
				body,
				source: "behavior_fence",
				schedule: "onNextTurn",
				locale,
			});
			if (turnText) parts.push(turnText);
		}
	}

	// Background completions + `Send({ id: "parent" })` reports, in the order they
	// actually happened. See `deliverPendingInjectionsInOrder`.
	const eventText = await deliverPendingInjectionsInOrder(narratorId, locale, "busy");
	if (eventText) parts.push(eventText);

	// Spec files the user edited through the UI.
	//
	// Only the IDLE fallback reaches here: while a loop runs, `spec-edit-interject`
	// delivers the edit as a real cut-in user turn instead, because `taskReflection`
	// reads the parent history and cannot recognize a task the user just asked for if it
	// arrives as a system aside. The queue caps itself at 10 files / 2000-char previews.
	const specUpdates = drainSpecUpdatesForNarrator(narratorId);
	if (specUpdates.length > 0) {
		const { body, content } = sideCarBodyWithText(
			"spec_update",
			{
				kind: "specUpdates",
				items: specUpdates.map((update) => ({
					uri: update.uri,
					timestamp: update.timestamp,
					updatedBy: update.updatedBy,
					taskSummary: update.taskSummary,
					preview: update.preview,
				})),
			},
			locale,
		);
		const { turnText } = await deliverInjection(narratorId, {
			content,
			body,
			source: "spec_update",
			schedule: "onNextTurn",
			locale,
		});
		if (turnText) parts.push(turnText);
	}

	return parts.join("\n\n");
}

interface ContinuableTopLevelMessage {
	id?: string;
	role: string;
	parentToolUseId?: string | null;
	contentJson?: unknown;
	contentText?: unknown;
	toolCalls?: Array<{ toolUseId?: string | null; toolName?: string | null }>;
}

/**
 * Find the last top-level message a continuation can build on, plus the trailing
 * reasoning-only assistant records that shadow it.
 *
 * A turn that died after streaming thinking but before answering (or calling a
 * tool) leaves a reasoning-only assistant record behind — see
 * {@link isDanglingReasoningOnlyAssistantMessage}. Treating it as the tail hides
 * whatever came before it, so a preceding assistant turn with pending tool
 * results gets misread as "nothing to replay" and the continuation degrades into
 * a plain "continue" user message that abandons those results.
 *
 * Walking past those records is safe: they carry no answer text and no tool call,
 * so nothing is lost by continuing from the turn underneath.
 */
export function resolveContinuationTail<T extends ContinuableTopLevelMessage>(
	messages: T[],
): { tail: T | undefined; danglingReasoningIds: string[] } {
	const danglingReasoningIds: string[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || msg.parentToolUseId) continue;
		if (msg.role !== "user" && msg.role !== "assistant") continue;
		if (isDanglingReasoningOnlyAssistantMessage(msg)) {
			if (msg.id) danglingReasoningIds.push(msg.id);
			continue;
		}
		return { tail: msg, danglingReasoningIds };
	}
	return { tail: undefined, danglingReasoningIds };
}

function shouldReplayToolResultPacket(msg: ContinuableTopLevelMessage | undefined): boolean {
	if (!msg || msg.role !== "assistant") return false;
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	if (blocks.some((block: { type?: string }) => block?.type === "tool_use")) return true;
	return (
		Array.isArray(msg.toolCalls) &&
		msg.toolCalls.some((tc) => Boolean(tc?.toolUseId) && Boolean(tc?.toolName))
	);
}

/**
 * Text of a trailing `role: "user"` row that a pass with no prompt of its own must resend.
 *
 * Every provider's history builder POPS the last top-level user row and expects the
 * caller to send it as the current turn (`buildAnthropicHistory` line ~2832 and the
 * same three lines in openai/gemini/cline). That contract holds for an ordinary user
 * message, because whoever wrote the row also passes its text into `runAgentLoop`.
 *
 * It does NOT hold for a row written by a producer that then starts a bare
 * `runAgentLoop(active, "")` — the review conclusion written by
 * `review-event-handler` is the first such producer. The row was popped as "the
 * current turn" and the current turn was empty, so the conclusion reached the model
 * in NEITHER place: `pushUserTurn` pushes nothing for empty content, and history no
 * longer contains the row. The reviewer's findings simply were not in the request.
 *
 * Nothing reports that. The turn runs, the model answers something generic about the
 * previous context, and the transcript still shows the conclusion sitting there — so
 * it reads as the model ignoring it rather than never receiving it.
 *
 * Recovered here rather than at the producer because the gap belongs to this seam:
 * any future producer that persists a user row and starts an empty pass inherits the
 * same bug, and a fix at one call site would not cover it. `sys` rows need none of
 * this — the builders lift those into `trailingUserText` themselves.
 */
export function resolvePoppedTrailingUserText(
	messages: ContinuableTopLevelMessage[],
): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || msg.parentToolUseId) continue;
		// Mirrors the builders' filter: they only consider user/assistant/sys, and only
		// a trailing `user` row is popped. A trailing `sys` run is lifted by the builder
		// itself, so reaching one means there is nothing for this helper to recover.
		if (msg.role === "sys") return null;
		if (msg.role !== "user") return null;
		const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
		const text = blocks
			.filter(
				(block: { type?: string; text?: unknown }) =>
					block?.type === "text" && typeof block.text === "string" && block.text.trim(),
			)
			.map((block: { text?: unknown }) => String(block.text))
			.join("\n");
		if (text.trim()) return text;
		// `contentText` is the flat fallback for rows written without an explicit text
		// block, matching how `dbMessageVisibleText` reads a row.
		const flat = typeof msg.contentText === "string" ? msg.contentText : "";
		return flat.trim() ? flat : null;
	}
	return null;
}

/**
 * Does model-visible history end on a server-authored injection?
 *
 * `resolveContinuationTail` walks PAST `sys` rows by design — it answers "what turn can
 * a continuation build on", and an injection is not a turn. But its absence from that
 * answer must not be read as "history ends on the row underneath": an injection sitting
 * last is the freshest thing the narrator was handed, and every provider's history
 * builder already sends a trailing `sys` run as the CURRENT turn
 * (`buildAnthropicHistory`'s `trailingUserText`).
 *
 * So a continuation whose tail is an injection has its content already in place and needs
 * nothing but a loop — the same `runAgentLoop(active, "")` that
 * `startInjectionContinuationIfPossible` uses. Appending a synthetic "please continue"
 * user row instead would be actively wrong, not merely redundant: it displaces the
 * injection from the trailing position, so the builder stops lifting it and the model
 * reads it as background while being asked to continue something unnamed.
 */
export function hasTrailingInjectionRow(messages: ContinuableTopLevelMessage[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || msg.parentToolUseId) continue;
		if (msg.role === "sys") return true;
		if (msg.role === "user" || msg.role === "assistant") return false;
	}
	return false;
}

async function getLatestSubagentParentToolUseId(narratorId: string): Promise<string | undefined> {
	const latestSubMsg = await db.query.narratorMessages.findFirst({
		where: and(
			eq(narratorMessages.narratorId, narratorId),
			eq(narratorMessages.role, "user"),
			isNotNull(narratorMessages.parentToolUseId),
		),
		columns: { parentToolUseId: true },
		orderBy: [desc(narratorMessages.createdAt)],
	});
	return latestSubMsg?.parentToolUseId ?? undefined;
}

// === Shared context management hooks ===

export interface ContextManagementOptions {
	narratorId: string;
	locale: Locale;
	/** Dynamic getter for the current model (supports mid-loop model switching) */
	getModel: () => string;
	/** Dynamic getter for the current provider (supports mid-loop model switching) */
	getProvider: () => string;
	/** Whether this narrator is a subagent (all messages have parentToolUseId) */
	isSubagent?: boolean;
	/** Mutable getter/setter for the cached prune boundary */
	getPruneBoundary: () => string | null;
	setPruneBoundary: (id: string | null) => void;
	/** Called after compact completes (e.g. reset conversationId, set restart flag) */
	onCompactDone?: () => void;
	/** Check whether a compact just finished and the next turn needs a full rebuild */
	isCompactDone?: () => boolean;
	/** Clear the compact-done flag after the rebuild has been applied */
	clearCompactDone?: () => void;
	/** Rebuild the system prompt with the latest contextSummary from DB */
	rebuildSystemPrompt?: () => Promise<string | null>;
}

/**
 * Build reusable context management hooks (prune + compact) for both
 * main narrators and subagents.
 *
 * Returns an `onContextUsage` EventHook and an `onBeforeTurn` AgentConfig callback.
 */
export function buildContextManagementHooks(opts: ContextManagementOptions): {
	onContextUsage: NonNullable<EventHooks["onContextUsage"]>;
	onBeforeTurn: NonNullable<import("../lib/agent").AgentConfig["onBeforeTurn"]>;
	onReasoningOnlyHighContext: NonNullable<
		import("../lib/agent").AgentConfig["onReasoningOnlyHighContext"]
	>;
} {
	const {
		narratorId,
		locale,
		getModel,
		getProvider,
		isSubagent: isSubagentNarrator,
		getPruneBoundary,
		setPruneBoundary,
		onCompactDone,
		isCompactDone,
		clearCompactDone,
		rebuildSystemPrompt,
	} = opts;

	const onContextUsage = (percentage: number) => {
		// If a history compact has completed but the active loop has not yet
		// rebuilt its in-memory history from the new summary, this percentage is
		// still measured against the stale (pre-compact) context. Acting on it
		// would trigger a second compact on context that is about to shrink,
		// dropping a large chunk of conversation. Skip until the rebuild lands.
		//
		// hasPendingHistoryCompact relies on activeNarrators, which subagents never
		// join — so for subagents it is always false and this guard would be dead.
		// isCompactDone (backed by the compactDoneFlag closure) is the equivalent
		// "compact finished, history not yet rebuilt" signal that DOES work for
		// subagents, so check both. For main narrators it is a harmless double guard.
		if (hasPendingHistoryCompact(narratorId) || (isCompactDone?.() ?? false)) {
			const active = activeNarrators.get(narratorId);
			if (active) active._contextUsagePct = undefined;
			logger.debug("Skipping context-usage compact trigger: prior compact not yet applied", {
				narratorId,
				contextPct: percentage,
			});
			return;
		}
		const thresholds = getContextThresholds(getModel(), getProvider());
		const pruningWindowEnabled = isDynamicPruningWindowEnabled(thresholds);

		// Dynamic pruning: pruneStart – (compactStart - 1)%. Once pruning reaches
		// the configured ratio, start background compact immediately instead of
		// waiting for compactStart. If compactStart <= pruneStart, the pruning window
		// is disabled and compactStart acts as the direct compact trigger.
		if (
			pruningWindowEnabled &&
			percentage >= thresholds.pruneStart &&
			percentage < thresholds.compactStart &&
			!pruneLocks.has(narratorId)
		) {
			const compactPruneThreshold = getAutoCompactPruneThreshold();
			pruneLocks.add(narratorId);
			narratorService
				.computeAndUpdatePruneBoundary(narratorId, percentage, thresholds)
				.then((result) => {
					broadcastToNarrator(narratorId, {
						type: "prune_boundary",
						narratorId,
						boundaryMessageId: result?.boundaryMessageId ?? null,
						prunedPercent: result?.prunedPercent ?? null,
					});

					const prunedPct = result?.prunedPercent ?? 0;
					if (prunedPct >= compactPruneThreshold) {
						logger.info("Pruned percent reached threshold, triggering background compact", {
							narratorId,
							contextPct: percentage,
							prunedPercent: prunedPct,
							threshold: compactPruneThreshold,
						});
						triggerMidTurnCompact(narratorId, locale, onCompactDone, "background", percentage);
					}
				})
				.catch((err) => {
					logger.error("Failed to update prune boundary", {
						narratorId,
						contextPct: percentage,
						error: String(err),
					});
				})
				.finally(() => {
					pruneLocks.delete(narratorId);
				});
		}

		// ≥ compactStart%: force compact only after pruning reaches the configured
		// ratio; otherwise keep advancing the prune boundary. Exceptions: when the
		// pruning window is disabled (compactStart <= pruneStart), or pruning is
		// disabled for this narrator, skip the prune gate and compact immediately.
		if (
			percentage >= thresholds.compactStart &&
			!pruneLocks.has(narratorId) &&
			!compactLocks.has(narratorId)
		) {
			if (!pruningWindowEnabled) {
				logger.info("Pruning window disabled, triggering background compact", {
					narratorId,
					contextPct: percentage,
					pruneStart: thresholds.pruneStart,
					compactStart: thresholds.compactStart,
				});
				triggerMidTurnCompact(narratorId, locale, onCompactDone, "background", percentage);
				return;
			}

			const compactPruneThreshold = getAutoCompactPruneThreshold();
			pruneLocks.add(narratorId);
			narratorService
				.computeAndUpdatePruneBoundary(narratorId, percentage, thresholds)
				.then(async (result) => {
					broadcastToNarrator(narratorId, {
						type: "prune_boundary",
						narratorId,
						boundaryMessageId: result?.boundaryMessageId ?? null,
						prunedPercent: result?.prunedPercent ?? null,
					});

					// If prune returned null (e.g. pruning disabled), check the DB flag
					// to decide whether to skip the prune gate entirely.
					if (result == null) {
						const row = await db.query.narrators.findFirst({
							where: eq(narrators.id, narratorId),
							columns: { pruneEnabled: true },
						});
						if (row && !row.pruneEnabled) {
							// Pruning disabled — go straight to compact
							triggerMidTurnCompact(narratorId, locale, onCompactDone, "background", percentage);
							return;
						}
					}

					const prunedPct = result?.prunedPercent ?? 0;
					if (prunedPct < compactPruneThreshold) {
						logger.info(
							"Context above compactStart but prunedPercent below threshold, continuing prune",
							{
								narratorId,
								contextPct: percentage,
								prunedPercent: prunedPct,
								threshold: compactPruneThreshold,
							},
						);
						return; // stay in prune mode — don't compact yet
					}
					logger.info("Pruned percent reached threshold, triggering background compact", {
						narratorId,
						contextPct: percentage,
						prunedPercent: prunedPct,
						threshold: compactPruneThreshold,
					});
					triggerMidTurnCompact(narratorId, locale, onCompactDone, "background", percentage);
				})
				.catch((err) => {
					logger.error("Failed to update prune boundary (pre-compact check)", {
						narratorId,
						contextPct: percentage,
						error: String(err),
					});
				})
				.finally(() => {
					pruneLocks.delete(narratorId);
				});
		}
	};

	const rebuildHistoryForCurrentContext = async (
		boundary: string | null,
		includeSystemPrompt: boolean,
	) => {
		setPruneBoundary(boundary);
		const rawMsgs = await narratorService.getModelHistorySinceLastCompact(narratorId);
		// The in-memory history is now rebuilt from the latest (post-compact)
		// messages, so any pending-compact guard can be released.
		clearActiveHistoryCompactPending(narratorId);
		// Subagent messages all have parentToolUseId set — clear it so
		// buildHistory treats them as top-level (same as loadSubagentHistory).
		const msgs = isSubagentNarrator
			? rawMsgs.map((m) => ({ ...m, parentToolUseId: null }))
			: rawMsgs;
		if (boundary) pruneToolCalls(msgs, boundary);
		const result = await buildHistory(msgs, getModel(), getProvider(), narratorId);
		const systemPrompt = includeSystemPrompt
			? ((await rebuildSystemPrompt?.()) ?? undefined)
			: undefined;
		return {
			history: result.history,
			pendingToolResults: result.trailingToolResults,
			...(systemPrompt !== undefined ? { systemPrompt } : {}),
		};
	};

	const onReasoningOnlyHighContext: NonNullable<
		import("../lib/agent").AgentConfig["onReasoningOnlyHighContext"]
	> = async (contextUsagePercentage, signal) => {
		const keepPairs = getAutoCompactKeepPairs();
		logger.warn("Reasoning-only response requires blocking context compact", {
			narratorId,
			contextUsagePercentage,
			keepPairs,
		});

		let compacted = (isCompactDone?.() ?? false) || hasPendingHistoryCompact(narratorId);
		if (!compacted) {
			const baselineCompactSeq = await narratorService.getLatestCompactSeq(narratorId);
			const boundaryMessageId = await narratorService.getCompactBoundaryMessage(
				narratorId,
				keepPairs,
			);

			// Re-check after the async boundary lookup: a background compact may have
			// completed while this recovery path was confirming what to retain.
			compacted = (isCompactDone?.() ?? false) || hasPendingHistoryCompact(narratorId);
			if (!compacted && boundaryMessageId) {
				compacted = await runCustomCompact(narratorId, locale, boundaryMessageId, {
					mode: "blocking",
					trigger: "reasoning_only",
					contextPercentBefore: contextUsagePercentage,
					signal,
				});
			} else if (!compacted && compactLocks.has(narratorId)) {
				// A no-boundary probe may already be in flight. Wait for it instead of
				// starting an unbounded compact that would ignore keepPairs.
				await awaitCompactCompletion(narratorId, signal);
				const latestCompactSeq = await narratorService.getLatestCompactSeq(narratorId);
				compacted =
					(isCompactDone?.() ?? false) ||
					hasPendingHistoryCompact(narratorId) ||
					(latestCompactSeq != null && latestCompactSeq > (baselineCompactSeq ?? -1));
			}

			if (!compacted && !boundaryMessageId) {
				logger.warn(
					"Reasoning-only compact skipped: not enough messages for configured retention",
					{
						narratorId,
						contextUsagePercentage,
						keepPairs,
					},
				);
			}
		}

		if (!compacted) return null;
		if (!(isCompactDone?.() ?? false)) {
			onCompactDone?.();
		}
		if (isCompactDone?.()) {
			clearCompactDone?.();
		}

		const replacement = await rebuildHistoryForCurrentContext(null, true);
		logger.info("Reasoning-only blocking compact applied to active history", {
			narratorId,
			contextUsagePercentage,
			keepPairs,
		});
		return replacement;
	};

	const onBeforeTurn: NonNullable<import("../lib/agent").AgentConfig["onBeforeTurn"]> = async (
		_turnIndex,
		reason,
	) => {
		// Check if a compact just finished — if so, force a full rebuild
		// (history + system prompt) so the next API call uses compacted data.
		// This takes priority over the prune-boundary check below because compact
		// already clears the prune boundary and returns a fresh message set.
		const compactJustDone = isCompactDone?.() ?? false;
		if (compactJustDone) {
			clearCompactDone?.();
			// After compact, pruneBoundary is cleared — sync local cache
			return rebuildHistoryForCurrentContext(null, true);
		}

		// Plan mode was toggled manually mid-pass. The rebuild carries TWO things the
		// running turn cannot otherwise get: the plan-mode reminder (which only exists in
		// the system prompt, fixed at pass start) and the row the toggle just persisted
		// (the in-memory history was built before it existed). Without it the model is
		// never told it entered plan mode while the permission gate already enforces it.
		if (consumePlanModePromptRebuild(narratorId)) {
			return rebuildHistoryForCurrentContext(getPruneBoundary(), true);
		}

		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { pruneBoundaryMessageId: true },
		});
		const thresholds = getContextThresholds(getModel(), getProvider());
		let newBoundary = row?.pruneBoundaryMessageId ?? null;
		if (!isDynamicPruningWindowEnabled(thresholds) && newBoundary) {
			await narratorService.clearPruneBoundary(narratorId);
			broadcastToNarrator(narratorId, {
				type: "prune_boundary",
				narratorId,
				boundaryMessageId: null,
				prunedPercent: null,
			});
			newBoundary = null;
		}
		if (!reason?.force && newBoundary === getPruneBoundary()) return null;
		return rebuildHistoryForCurrentContext(newBoundary, reason?.force === true);
	};

	return { onContextUsage, onBeforeTurn, onReasoningOnlyHighContext };
}

/**
 * Build AgentConfig, start the agent loop via executeAgentLoop(), and handle chained messages.
 * Runs in the background — kicked off by feedMessage().
 *
 * Returns `{ started: false }` when a loop is already running for this narrator.
 * This is the single authoritative gate against concurrent loops: in JS's
 * single-threaded model the test-and-set on `_loopRunning` is atomic, so it
 * blocks any second loop that slips past the route-level admission check (e.g.
 * when the DB `status` went stale to idle while the loop was still draining).
 */
export async function runAgentLoop(
	active: ActiveNarrator,
	text: string,
	images?: ImageRef[],
): Promise<{ started: boolean }> {
	const { narratorId, locale } = active;
	// Final guard against concurrent loops on the same ActiveNarrator. ensureNarrator
	// reuses the same `active` object while it is alive, so a second runAgentLoop call
	// here would otherwise drive a second `while (active.alive)` loop over shared state
	// (abortController, history, _substatus) and corrupt the session.
	if (active._loopRunning) {
		logger.warn("runAgentLoop blocked: loop already running", { narratorId });
		return { started: false };
	}
	active._loopRunning = true;
	let unregisterUpdateLoop: () => void = () => {};
	let shouldUpdateTitle = false;
	let currentText = text;
	// Knowledge entries already injected in the CURRENT COMPACT CYCLE (de-dup across runAgentLoop
	// calls, loop passes, and tool outputs). This is narratorId-scoped hotSafe state rather than
	// ActiveNarrator state because ActiveNarrator is recreated between idle user turns.
	let knowledgeCycleState = knowledgeInjectionCycleStates.get(narratorId);
	if (!knowledgeCycleState) {
		knowledgeCycleState = { seq: Number.NaN, ids: new Set<string>() };
		knowledgeInjectionCycleStates.set(narratorId, knowledgeCycleState);
	}
	const knowledgeInjectedIds = knowledgeCycleState.ids;
	let currentImages = images;
	let loopHadError = false;
	let pendingWorkingDirectoryRecovery:
		| { output: string; missingCwd: string; suggestedCwd: string }
		| undefined;
	/** Wall-clock start of this response turn, for the Stop hook `duration_ms` field. */
	const loopStartedAt = Date.now();
	/**
	 * Tokens consumed across every pass of this response turn (non-cached input +
	 * output), for the Stop hook `total_tokens` field. Accumulated per pass using
	 * the same delta the goal-usage accounting charges.
	 */
	let loopTotalTokens = 0;
	/** Whether the loop was interrupted by the user (abort signal). */
	let loopWasInterrupted = false;
	/** Final assistant text (or error message) from the most recent agent-loop pass, for Stop hooks. */
	let stopHookFinalText = "";
	/** Whether the most recent agent-loop pass ended by exceeding the max-turns limit (for Stop hooks). */
	let loopHitMaxTurns = false;
	/** Consecutive overflow recoveries since the last completed assistant turn. */
	let contextOverflowRetries = 0;

	/** How many consecutive transient-error retries in this runAgentLoop call. */
	let transientRetries = 0;

	/** How many consecutive completion-limit auto-continues in this runAgentLoop call. */
	let interruptionRetries = 0;
	const MAX_INTERRUPTION_RETRIES = 3;

	// --- Subagent dual-broadcast setup ---
	// When runAgentLoop runs for a taken-over subagent, we need to broadcast
	// events to the parent narrator so the SubagentCard updates in real time.
	// Resolve parentNarratorId + parentToolUseId once before the loop.
	let saParentNarratorId: string | undefined;
	let saParentToolUseId: string | undefined;
	try {
		unregisterUpdateLoop = registerNarratorLoop(narratorId, locale, {
			userId: active._currentUserId,
			replyInUserLanguage: active._replyInUserLanguage,
		});
		const initNarrator = await narratorService.getById(narratorId);
		if (isSubagentVariant(initNarrator.variant) && initNarrator.parentNarratorId) {
			const watcher = getConclusionWatcher(narratorId);
			const parentToolUseId =
				watcher?.toolUseId ?? (await getLatestSubagentParentToolUseId(narratorId));
			if (parentToolUseId) {
				saParentNarratorId = watcher?.parentNarratorId ?? initNarrator.parentNarratorId;
				saParentToolUseId = parentToolUseId;
			}
		}
	} catch (error) {
		active._loopRunning = false;
		active.alive = false;
		unregisterUpdateLoop();
		throw error;
	}

	try {
		while (active.alive) {
			const baselineCompactSeq = await narratorService.getLatestCompactSeq(narratorId);
			// Knowledge-injection de-dup is scoped to a compact cycle: when the latest compact
			// seq changes (a compact happened), the prior injections were summarized/dropped from
			// context, so clear the set to allow re-injecting relevant entries into the new cycle.
			const cycleSeq = baselineCompactSeq ?? -1;
			if (cycleSeq !== knowledgeCycleState.seq) {
				knowledgeCycleState.seq = cycleSeq;
				knowledgeInjectedIds.clear();
				for (const id of knowledgeService.listInjectedEntryIds(narratorId, cycleSeq)) {
					knowledgeInjectedIds.add(id);
				}
			}
			// Always use getModelHistorySinceLastCompact: if no compact marker exists it
			// returns all messages; after a compact it only returns post-compact messages
			// (old context is already in the summary injected via system prompt).
			const rawMessages = await narratorService.getModelHistorySinceLastCompact(narratorId);
			// History below is rebuilt from the latest post-compact messages, so any
			// pending-compact guard set by a background compact can be released here.
			clearActiveHistoryCompactPending(narratorId);

			// Rebuild system prompt each iteration so AGENTS.md/CLAUDE.md changes are picked up.
			const freshNarrator = await narratorService.getById(narratorId);
			const oauthRuntime = await assertOAuthNarratorRuntimeActive(
				narratorId,
				active._currentUserId,
			);
			if (oauthRuntime) {
				active._projectId = oauthRuntime.projectId ?? undefined;
				active._defaultDeviceId = oauthRuntime.defaultDeviceId;
			}
			const resolvedTurnSessionDevices =
				(await resolveSessionDevices(active._projectId ?? null)) ?? [];
			const turnSessionDevices = oauthRuntime
				? filterOAuthSessionDevices(resolvedTurnSessionDevices, oauthRuntime)
				: resolvedTurnSessionDevices;

			// Subagent messages all have parentToolUseId set — clear it so
			// buildHistory treats them as top-level (same as loadSubagentHistory).
			const isSubagentNarrator = isSubagentVariant(freshNarrator.variant);
			const dbMessages = isSubagentNarrator
				? rawMessages.map((m) => ({ ...m, parentToolUseId: null }))
				: rawMessages;

			active._modelRef = freshNarrator.model ?? FOLLOW_DEFAULT_MODEL;
			active._settingsRevision = getSettingsRevision();
			active.model = resolveEffectiveModel(active._modelRef, active.provider);
			active.provider = resolveProvider(active.model);
			active._reasoningEffortRef = freshNarrator.reasoningEffort ?? null;
			active.reasoningEffort = resolveRuntimeReasoningEffort(
				active.provider,
				active.model,
				active._reasoningEffortRef,
			);
			const resolved = resolveProviderAndModel(active.model, active.provider);
			active.provider = resolved.provider;
			recordNarratorRuntimeModel(
				narratorId,
				active._modelRef ?? FOLLOW_DEFAULT_MODEL,
				resolved.provider,
				resolved.model,
			);

			// Resolve behavior-fence injection settings for this turn (narrator override → global default).
			const fenceIntervalOverride = freshNarrator.behaviorFenceIntervalOverride;
			active._fenceInterval =
				fenceIntervalOverride == null
					? settings.agent.behaviorFenceInterval
					: fenceIntervalOverride;
			active._fenceAttach = resolveBooleanOverride(
				freshNarrator.behaviorFenceAttachOverride,
				settings.agent.behaviorFenceAttachTasks,
			);

			// Resolve tasks.json reminder injection settings for this turn (narrator override → global default).
			const tasksReminderIntervalOverride = freshNarrator.tasksReminderIntervalOverride;
			active._tasksReminderInterval =
				tasksReminderIntervalOverride == null
					? settings.agent.tasksReminderInterval
					: tasksReminderIntervalOverride;

			// Apply dynamic pruning — strip tool calls from messages at or before the
			// persisted boundary so the context stays within budget. When compactStart
			// is <= pruneStart, dynamic pruning is explicitly disabled; clear any stale
			// boundary left over from an earlier threshold configuration.
			// A manual plan-mode toggle only needs to override the CURRENT pass, whose
			// AgentConfig captured `freshNarrator` above. This pass just re-read the DB, so
			// any live override is now redundant — and keeping it would make one manual
			// toggle permanently shadow every other path that changes plan mode.
			active._planModeLive = undefined;
			active._relaxedPlanLive = undefined;
			// The prompt this pass is about to build already reflects the toggled state, so a
			// rebuild request raised before it is satisfied by construction.
			clearPlanModePromptRebuild(narratorId);

			const loopThresholds = getContextThresholds(resolved.model, resolved.provider);
			const pruningWindowEnabled = isDynamicPruningWindowEnabled(loopThresholds);
			active._pruneBoundaryMessageId = pruningWindowEnabled
				? (freshNarrator.pruneBoundaryMessageId ?? null)
				: null;
			if (!pruningWindowEnabled && freshNarrator.pruneBoundaryMessageId) {
				await narratorService.clearPruneBoundary(narratorId);
				broadcastToNarrator(narratorId, {
					type: "prune_boundary",
					narratorId,
					boundaryMessageId: null,
					prunedPercent: null,
				});
			} else if (active._pruneBoundaryMessageId) {
				pruneToolCalls(dbMessages, active._pruneBoundaryMessageId);
			}

			const { history, trailingToolResults, trailingUserText } = await buildHistory(
				dbMessages,
				resolved.model,
				resolved.provider,
				narratorId,
			);

			const { prompt: freshSystemPrompt, usedCompactSummary } = await buildSystemPrompt(
				{
					systemPrompt: oauthRuntime
						? (oauthRuntime.systemPrompt ?? null)
						: freshNarrator.systemPrompt,
					contextSummary: freshNarrator.contextSummary,
				},
				active.cwd,
				locale,
				active._replyInUserLanguage ?? false,
				oauthRuntime ? false : isPlanModeTrait(freshNarrator.traits),
				active._planFileId,
				settings.agent.defaultSystemPrompt,
				{
					devices: turnSessionDevices,
					defaultDeviceId: oauthRuntime?.defaultDeviceId ?? active._defaultDeviceId ?? null,
					allowLocalExecution: oauthRuntime?.allowLocalExecution ?? true,
				},
				// Same reason as in rebuildSystemPrompt: a legacy plan path cannot be rebuilt
				// from the identity, and the reminder must name the file the gate allows.
				active._planFilePath,
			);
			active.systemPrompt = freshSystemPrompt;
			active._usedCompactSummary = usedCompactSummary;

			const eventContext: EventHandlerContext = {
				narratorId,
				broadcastTargetId: saParentNarratorId ?? narratorId,
				sseEmitter: active.events,
				conversationId: active.conversationId,
				locale: active.locale,
				providerPrefix: resolved.provider,
				provider: resolved.provider,
				model: resolved.model,
				// Subagent dual-broadcast fields — when set, dualBroadcast sends
				// events to both the parent narrator and the subagent's own page.
				parentToolUseId: saParentToolUseId,
				subagentModel: saParentNarratorId ? resolved.model : undefined,
				getContextUsagePct: () => active._contextUsagePct,
				getMeterUsage: () => active._lastMeterUsage,
				getMeterUnit: () => active._lastMeterUnit,
				getPartialMessageId: () => active._partialMessageId,
				getTokenUsage: () => active._lastTokenUsage,
				getTurnStartedAt: () => active._turnStartedAt,
				getTtftMs: () => active._ttftMs,
				setPartialMessageId: (id) => {
					active._partialMessageId = id;
				},
				setContextUsagePct: (pct) => {
					active._contextUsagePct = pct;
				},
				setMeterData: (usage, unit) => {
					active._lastMeterUsage = usage;
					active._lastMeterUnit = unit;
				},
				setTokenUsage: (usage) => {
					active._lastTokenUsage = usage;
				},
				setTtftMs: (ttftMs) => {
					active._ttftMs = ttftMs;
				},
				getSubstatus: () => active._substatus,
				addSubstatus: async (tag) => {
					if (active._substatus.has(tag)) return;
					active._substatus.add(tag);
					await narratorService.updateSubstatus(narratorId, [...active._substatus]);
				},
				removeSubstatus: async (tag) => {
					if (!active._substatus.has(tag)) return;
					active._substatus.delete(tag);
					await narratorService.updateSubstatus(narratorId, [...active._substatus]);
				},
				toolCallIdsMap: new Map(),
			};

			// Build shared context management hooks (prune + compact)
			let compactDoneFlag = false;
			const ctxMgmt = buildContextManagementHooks({
				narratorId,
				locale,
				isSubagent: isSubagentNarrator,
				getModel: () => resolveProviderAndModel(active.model, active.provider).model,
				getProvider: () => resolveProviderAndModel(active.model, active.provider).provider,
				getPruneBoundary: () => active._pruneBoundaryMessageId ?? null,
				setPruneBoundary: (id) => {
					active._pruneBoundaryMessageId = id;
				},
				onCompactDone: () => {
					compactDoneFlag = true;
				},
				isCompactDone: () => compactDoneFlag,
				clearCompactDone: () => {
					compactDoneFlag = false;
				},
				rebuildSystemPrompt: async () => {
					const freshNarrator = await narratorService.getById(narratorId);
					const freshOAuthRuntime = await assertOAuthNarratorRuntimeActive(
						narratorId,
						active._currentUserId,
					);
					const { prompt } = await buildSystemPrompt(
						{
							systemPrompt: freshOAuthRuntime
								? (freshOAuthRuntime.systemPrompt ?? null)
								: freshNarrator.systemPrompt,
							contextSummary: freshNarrator.contextSummary,
						},
						active.cwd,
						locale,
						active._replyInUserLanguage ?? false,
						freshOAuthRuntime ? false : isPlanModeTrait(freshNarrator.traits),
						active._planFileId,
						settings.agent.defaultSystemPrompt,
						undefined,
						// The reminder, the Write/Edit gate and ExitPlanMode resolution must all
						// name the SAME file. A cycle resumed from the pre-`plans/` layout keeps a
						// legacy path in `_planFilePath` that `buildPlanFileRelPath` cannot
						// reconstruct from the identity alone, so passing it is what stops the
						// model being told to write somewhere the gate then rejects.
						active._planFilePath,
					);
					// NOTE: Do NOT set active.systemPrompt here — the returned value
					// flows through onBeforeTurn → loop.ts which updates config.systemPrompt.
					// Setting active.systemPrompt would create a second source of truth.
					return prompt;
				},
			});

			let missingWorkingDirectoryRecovery:
				| { output: string; missingCwd: string; suggestedCwd: string }
				| undefined;

			const hooks: EventHooks = {
				onTitleCheck: async (_savedId) => {
					const n = await db.query.narrators.findFirst({
						where: eq(narrators.id, narratorId),
						columns: { title: true },
					});
					// `messageCount` is the real message count, not a turn count, so it is
					// already > 1 mid-first-turn. Ask the actual question instead.
					const titleUpdate = !!(
						n &&
						(!n.title || (active._provisionalTitle && n.title === active._provisionalTitle)) &&
						(await isFirstUserTurn(narratorId))
					);
					return { titleUpdate };
				},
				onPrepareEnterPlanMode: async (toolCallId, toolUseId, input) => {
					const existingPrepared = active._preparedPlanModes?.get(toolCallId);
					if (existingPrepared?.toolUseId === toolUseId) return;
					active._preparedPlanModes ??= new Map();
					const pendingIdentity = active._planFileId
						? undefined
						: active._preparedPlanModes.values().next().value;
					const customPlanName =
						typeof input?.plan_name === "string" && input.plan_name.trim()
							? input.plan_name.trim()
							: undefined;
					const prepared = pendingIdentity
						? { ...pendingIdentity, toolCallId, toolUseId }
						: await prepareNarratorPlanMode(narratorId, toolCallId, toolUseId, customPlanName);
					active._preparedPlanModes.set(toolCallId, prepared);
					// All EnterPlanMode calls in one response share one ephemeral identity.
					if (!active._planFileId) active._planFilePath = prepared.planFilePath;
				},
				onEnterPlanMode: async (toolCallId, toolUseId, result) => {
					const prepared = active._preparedPlanModes?.get(toolCallId);
					if (!prepared || prepared.toolUseId !== toolUseId) {
						throw new Error(`Prepared EnterPlanMode state not found for ${toolCallId}`);
					}
					const planState = await commitPreparedEnterPlanModeResult(narratorId, prepared, result);
					active._planFileId = planState.planFileId;
					active._planFilePath = planState.planFilePath;
					active._previousPermissionMode = planState.previousPermissionMode;
					// A manual toggle earlier in THIS pass may have left a live override behind.
					// The DB now says plan mode is on, so the override has nothing left to
					// correct — and a stale `false` here would keep the tool-description
					// override released for a pass the model just put into plan mode.
					active._planModeLive = undefined;
					active._relaxedPlanLive = undefined;
					if (!planState.wasPlanMode) {
						broadcastToNarrator(narratorId, {
							type: "plan_mode_changed",
							narratorId,
							planMode: true,
							traits: redactDraftTraits(planState.traits),
						});
					}
					if (planState.relaxedPlanChanged) {
						broadcastToNarrator(narratorId, {
							type: "relaxed_plan_changed",
							narratorId,
							relaxedPlan: true,
						});
					}
					active._preparedPlanModes?.delete(toolCallId);
				},
				onEnterPlanModeFailed: async (toolCallId, toolUseId) => {
					const prepared = active._preparedPlanModes?.get(toolCallId);
					if (!prepared || prepared.toolUseId !== toolUseId) return;
					active._preparedPlanModes?.delete(toolCallId);
					if (!active._planFileId && (active._preparedPlanModes?.size ?? 0) === 0) {
						active._planFilePath = undefined;
					}
				},
				onExitPlanMode: async (toolUseId) => {
					active._preparedPlanModes?.clear();
					active._planFileId = undefined;
					active._planFilePath = undefined;
					active._previousPermissionMode = undefined;
					// Drop any live override from a manual toggle earlier in this pass. The DB is
					// authoritative again from here, and this must not wait for the pass-start
					// clear: the non-compact branch below aborts the loop, but the compact branch
					// only aborts when there is plan text, so a stale `true` could otherwise keep
					// plan mode applied to a pass the model just exited.
					active._planModeLive = undefined;
					active._relaxedPlanLive = undefined;
					planModeAskedOnce.delete(narratorId);
					// Plan mode is a trait overlay. Exiting it must not silently change the
					// user's current permission policy. Still continue approval handling even
					// if another path already cleared the trait, so successful ExitPlanMode is idempotent.
					const planState = await exitNarratorPlanMode(narratorId);
					if (planState.wasPlanMode) {
						broadcastToNarrator(narratorId, {
							type: "plan_mode_changed",
							narratorId,
							planMode: false,
							traits: redactDraftTraits(planState.traits),
						});
					}
					// Plan compact logic — retrieve plan text from the tool call's inputJson
					if (pendingPlanCompact.has(narratorId)) {
						pendingPlanCompact.delete(narratorId);
						const planText = await narratorService.getToolCallPlanText(toolUseId);
						if (planText) {
							await runPlanCompact(narratorId, planText);
							resetActiveUpstreamSession(narratorId);
							broadcastToNarrator(narratorId, { type: "compact_done", narratorId });
							active._planApprovedContinue = "compact";
							active.abortController.abort();
						}
					} else {
						// Non-compact: abort the current agent loop and persist a user
						// message so the next iteration starts with an explicit
						// "plan approved, begin execution" prompt — this prevents the
						// model from ignoring the tool result and asking the user again.
						active._planApprovedContinue = "continue";
						active.abortController.abort();
					}
				},
				onClearCompactSummary: async () => {
					if (!active._usedCompactSummary) return;
					await db
						.update(narrators)
						.set({ contextSummary: null, updatedAt: new Date().toISOString() })
						.where(eq(narrators.id, narratorId));
					active._usedCompactSummary = false;
				},
				onToolResult: (event) => {
					if (!event.isError || event.toolName !== SHELL_TOOL_NAME) return;
					const recovery = getMissingWorkingDirectoryRecovery(event.metadata);
					if (!recovery) return;
					missingWorkingDirectoryRecovery = {
						output: event.output,
						missingCwd: recovery.missingCwd,
						suggestedCwd: recovery.suggestedCwd,
					};
				},
				onGitTrack:
					active._worktreePath && active._chapterId
						? (toolName, toolUseId) => {
								if (!FILE_MUTATING_TOOLS.has(toolName)) return;
								const chapterId = active._chapterId as string;
								const worktreePath = active._worktreePath as string;
								const baseBranch = active._baseBranch as string | undefined;

								// Throttle: collapse rapid successive calls into one trailing query.
								// Store the latest toolUseId so the broadcast references the most
								// recent tool, and clear any pending timer.
								if (active._gitTrackTimer) clearTimeout(active._gitTrackTimer);
								active._gitTrackTimer = setTimeout(() => {
									active._gitTrackTimer = undefined;
									// File changes just happened → invalidate then read through
									// the shared cache so co-located narrators reuse one query.
									invalidateStatus(worktreePath);
									Promise.all([
										getStatusSummaryCached(worktreePath, { ttlMs: 0 }),
										baseBranch
											? gitService.getCommitsAhead(worktreePath, baseBranch)
											: Promise.resolve({ count: 0, baseBranch: "" }),
									]).then(
										([gitStatus, ahead]) => {
											// Strip files array from WS broadcast to avoid
											// sending huge payloads when many files are changed.
											// The Git panel fetches the full list via API.
											const { files: _files, ...statusWithoutFiles } = gitStatus;
											broadcastToNarrator(narratorId, {
												type: "git_status",
												narratorId,
												chapterId,
												toolUseId,
												status: statusWithoutFiles as typeof gitStatus,
												commitsAhead: ahead.count,
												baseBranch: ahead.baseBranch,
												linesAdded: gitStatus.linesAdded,
												linesRemoved: gitStatus.linesRemoved,
											});
										},
										(err) => {
											logger.debug("Git status tracking failed", {
												narratorId,
												error: String(err),
											});
										},
									);
								}, 800);
							}
						: undefined,
				// Capture the workspace state before a file-mutating tool runs. This is a
				// content-addressed git tree of the whole worktree, so it also covers
				// writes the tool inputs do not describe (Bash, build scripts, editors).
				onSnapshotBefore: active._isInGitRepo
					? async (toolUseId, toolName, input) => {
							if (!FILE_MUTATING_TOOLS.has(toolName)) return;
							// Write/Edit can name their target up front, which is what lets the
							// resulting tree delta be attributed in a shared worktree. Bash
							// cannot, so it declares nothing and its set is derived instead.
							const declared =
								toolName === SHELL_TOOL_NAME ? null : declaredWorktreePaths(active.cwd, input);
							await recordTreeSnapshotBefore(active, narratorId, toolUseId, declared);
						}
					: undefined,
				// Capture the resulting state, persist both boundaries, and attribute the
				// files Bash changed using the authoritative tree diff.
				onSnapshotAfter: active._isInGitRepo
					? async (toolUseId, toolName) => {
							if (!FILE_MUTATING_TOOLS.has(toolName)) return;
							const { changedFiles } = await recordTreeSnapshotAfter(active, narratorId, toolUseId);
							if (toolName !== SHELL_TOOL_NAME || changedFiles.length === 0) return;
							try {
								const { recordAttributions } = await import("./file-attribution-service");
								await recordAttributions(
									{
										deviceId: LOCAL_DEVICE_ID,
										workspacePath: active.cwd,
										narratorId,
										action: "bash",
										toolName: SHELL_TOOL_NAME,
										toolUseId,
									},
									changedFiles,
								);
							} catch (err) {
								logger.debug("Bash attribution failed", {
									narratorId,
									toolUseId,
									error: String(err),
								});
							}
						}
					: undefined,
				onContextUsage: ctxMgmt.onContextUsage,
				onErrorCleanup: async (message, diagnostics) => {
					// Every abort path in the agent loop ends by yielding error("Aborted"), so
					// this is the one place that sees a turn stop without its remaining tools
					// reporting results. Write/Edit/Bash never execute eagerly, which is
					// exactly the set whose pre-execution hook has already opened a write
					// claim by then — and an unclosed claim is read as extending to now, so it
					// would go on subtracting its declared paths from every other narrator's
					// shell call in this worktree, making their real writes unrevertable.
					// Sealed first: it must not be skipped by an early return below.
					if (active._isInGitRepo) abandonSessionTreeSnapshots(active, narratorId);
					// Prepared EnterPlanMode state is ephemeral and must never survive an error/abort.
					active._preparedPlanModes?.clear();
					if (!active._planFileId) active._planFilePath = undefined;
					// Clean up partial message
					const partialId = active._partialMessageId;
					active._partialMessageId = undefined;
					if (message === "Aborted") {
						if (
							active._planApprovedContinue === "compact" ||
							active._planApprovedContinue === "continue"
						) {
							logger.info("Agent loop aborted for plan approval", {
								narratorId,
								mode: active._planApprovedContinue,
							});
							// Mark any orphaned tool calls (e.g. ExitPlanMode) as success
							// since the abort was intentional after approval.
							completeOrphanedToolCalls(narratorId).catch((err) => {
								logger.warn("Failed to complete orphaned tool calls after plan approval", {
									narratorId,
									error: String(err),
								});
							});
							if (partialId) {
								cleanupPartialMessage(partialId, narratorId);
							}
							return;
						}
						await finalizeInterruptedRun(active, narratorId, partialId);
						return;
					}
					if (partialId) {
						await finalizeOrCleanupPartialMessage(partialId, narratorId);
					}
					logger.error("Agent loop error", { narratorId, error: message });
					await narratorService.updateStatus(narratorId, "idle", {
						substatus: ["error"],
						errorMessage: message,
						diagnostics,
					});

					const recovery = missingWorkingDirectoryRecovery;
					missingWorkingDirectoryRecovery = undefined;
					if (recovery?.output === message) {
						pendingWorkingDirectoryRecovery = recovery;
					}

					loopHadError = true;
					active.events.emit("event", { type: "error", data: { message, diagnostics } });
				},
			};

			const resolvedReasoningEffort =
				freshNarrator.reasoningEffort ||
				resolveDefaultReasoningEffort(resolved.provider, resolved.model);

			// Resolved per turn, not frozen at creation: an "inherit" override follows
			// the acting user's fastModeDefault preference, so flipping that default
			// takes effect on existing narrators from their next turn onward.
			const resolvedFastMode = await resolveFastModeForUser(
				freshNarrator.fastModeOverride,
				active._currentUserId,
			);

			// Layered traits are re-resolved per turn for the same reason as fast mode:
			// the acting user is only known now, and a project/user trait edit should
			// take effect from the next turn rather than requiring a session restart.
			try {
				const turnTraits = await resolveEffectiveTraits({
					narratorTraits: freshNarrator.traits,
					projectId: active._projectId ?? null,
					actingUserId: active._currentUserId,
				});
				active._disabledTools = getDisabledToolSet(turnTraits.traits);
				const turnBlocked = getBlockedSkills(turnTraits.traits);
				active._blockedSkills = { all: turnBlocked.all, names: turnBlocked.names };
			} catch (error) {
				// Never fail a turn over layer resolution; the narrator-level traits
				// already loaded at creation remain in effect.
				logger.debug("Failed to refresh layered traits for turn", {
					narratorId,
					error: String(error),
				});
			}
			const resolvedServiceTier =
				resolvedFastMode && usesCodexModel(resolved.provider, resolved.model)
					? "priority"
					: undefined;

			const resetUpstreamSessionForThisLoop = active._resetUpstreamSessionOnNextRequest === true;
			active._resetUpstreamSessionOnNextRequest = false;
			await ensureSkillCacheFreshForActiveNarrator(active);
			const availableDevices = turnSessionDevices;

			const config: import("../lib/agent").AgentConfig = {
				narratorId,
				conversationId: active.conversationId,
				model: resolved.model,
				provider: resolved.provider,
				cwd: active.cwd,
				systemPrompt: active.systemPrompt ?? undefined,
				locale,
				signal: active.abortController.signal,
				chapterId: active._chapterId,
				// Plan mode can be toggled MANUALLY while this pass is running, so both flags
				// are read live rather than frozen here. `_planModeLive`/`_relaxedPlanLive` are
				// undefined until a toggle happens, in which case the pass-start DB snapshot
				// applies; they are cleared at the top of every pass so the DB stays the truth.
				get planMode() {
					if (oauthRuntime) return false;
					return active._planModeLive ?? isPlanModeTrait(freshNarrator.traits);
				},
				permissionMode: oauthRuntime?.permissionMode ?? freshNarrator.permissionMode ?? "default",
				previousPermissionMode: oauthRuntime
					? undefined
					: (active._previousPermissionMode ?? freshNarrator.previousPermissionMode ?? undefined),
				get relaxedPlan() {
					if (oauthRuntime) return false;
					return (
						active._relaxedPlanLive ??
						resolveEffectiveRelaxedPlan(freshNarrator.permissionMode, freshNarrator.relaxedPlan)
					);
				},
				planAllowInlinePlan: settings.agent.planModeAllowInlinePlan,
				planReflectionAutoApproveOverride: normalizeBooleanOverride(
					freshNarrator.planReflectionAutoApproveOverride,
				),
				// EnterPlanMode updates the active narrator while the current loop is paused
				// on the assistant_message event. Use getters so the subsequent tool
				// execution sees the freshly allocated plan file instead of the config
				// snapshot created before the hook ran.
				get planFileId() {
					return active._planFileId;
				},
				get planFilePath() {
					return active._planFilePath;
				},
				getPlanFilePathForTool: (toolUseId) =>
					[...(active._preparedPlanModes?.values() ?? [])].find(
						(prepared) => prepared.toolUseId === toolUseId,
					)?.planFilePath,
				skillRoot: active._skillRoot ?? undefined,
				projectGitPath: active._projectGitPath ?? undefined,
				worktreePath: active._worktreePath ?? undefined,
				skillScopeKey: active._skillScopeKey ?? undefined,
				userId: active._currentUserId ?? null,
				projectId: oauthRuntime?.projectId ?? active._projectId ?? null,
				get defaultDeviceId() {
					return active._defaultDeviceId ?? null;
				},
				availableDevices,
				setDefaultDevice: oauthRuntime
					? async (deviceId) => {
							await setNarratorDefaultDevice(narratorId, deviceId);
							return true;
						}
					: (deviceId) => applySessionDefaultDevice(narratorId, active, deviceId),
				onExecutionTargetResolved: (toolUseId, target) =>
					narratorService.updateToolCallExecutionTarget(narratorId, toolUseId, target),
				onExecutionPlanResolved: (toolUseId, plan) =>
					narratorService.updateToolCallExecutionPlan(narratorId, toolUseId, plan),
				// Share the compact-cycle de-dup set so the loop's tool-output scan (point B)
				// de-dups against the user-message injections (point A) and vice versa.
				knowledgeInjectedEntryIds: knowledgeInjectedIds,
				knowledgeInjectionCompactSeq: cycleSeq,
				reasoningEffort: resolvedReasoningEffort,
				serviceTier: resolvedServiceTier,
				maxTransientRetries: getMaxTransientRetries(),
				silentToolCallThreshold: getSilentToolCallThreshold(),
				pipelineUnusedToolCallThreshold: getPipelineUnusedToolCallThreshold(),
				retryBackoffCeilMs: getRetryBackoffCeilMs(),
				firstTokenTimeoutMs: getFirstTokenTimeoutMs(),
				metadata: isAnthropicProvider(resolved.provider)
					? { user_id: `user_${narratorId}_account__session_${active.conversationId}` }
					: undefined,
				resetUpstreamSessionOnFirstRequest: resetUpstreamSessionForThisLoop,
				disabledTools: active._disabledTools,
				allowedTools: oauthRuntime ? new Set(oauthRuntime.allowedTools) : undefined,
				allowLocalExecution: oauthRuntime?.allowLocalExecution ?? true,
				runtimeAuthorizationGuard: oauthRuntime
					? async () => {
							await assertOAuthNarratorRuntimeActive(narratorId, active._currentUserId);
						}
					: undefined,
				blockedSkills: {
					all: active._blockedSkills.all,
					names: [...active._blockedSkills.names],
				},
				subagentModelRestrictionDescription: formatSubagentModelRestrictionDescription(
					freshNarrator.traits,
				),
				// Exclude optional tools that haven't been loaded for this session.
				toolFilter: (tool) => {
					if (oauthRuntime && !oauthRuntime.allowedTools.has(tool.name)) return false;
					if (active._disabledTools.has(tool.name)) return false;
					// When all skills are blocked, hide the Skill tool entirely.
					if (tool.name === "Skill" && active._blockedSkills.all) return false;
					if (OPTIONAL_TOOLS.has(tool.name)) {
						return active._enabledOptionalTools.has(tool.name);
					}
					// Review tools: only available for review chapter narrators
					if (REVIEW_TOOLS.has(tool.name)) {
						return active._chapterRole === "review";
					}
					// MCP tools: exclude tools with "deny" behavior
					if (tool.name.startsWith("mcp__")) {
						return isMcpToolAllowedForNarrator(tool);
					}
					// Knowledge Steward: drop a few unrelated core tools (e.g. web search/fetch).
					// Deny-list only — never touches planning/reflection/goal control tools.
					if (active._narratorKind === "knowledge" && KNOWLEDGE_KIND_DENY_CORE.has(tool.name)) {
						return false;
					}
					return true;
				},
				permissionHandler: (toolName, input, toolUseId, options) =>
					handlePermission(
						narratorId,
						active.abortController.signal,
						toolName,
						input,
						toolUseId,
						active.cwd,
						locale,
						saParentNarratorId,
						options,
						saParentToolUseId,
						oauthRuntime
							? {
									permissionMode: oauthRuntime.permissionMode,
									allowKnowledgeWrite: oauthRuntime.allowKnowledgeWrite,
									dangerReflectionPrompt: oauthRuntime.dangerReflectionPrompt,
									useRobotDiagnosticPreset: oauthRuntime.useRobotDiagnosticPreset,
									deviceAccess: oauthRuntime.policy.deviceAccess,
									oauthClientId: oauthRuntime.clientId,
									grantId: oauthRuntime.grantId,
								}
							: undefined,
					),
				onBeforeTurn: ctxMgmt.onBeforeTurn,
				getContextUsagePercentage: () => active._contextUsagePct,
				onReasoningOnlyHighContext: ctxMgmt.onReasoningOnlyHighContext,
				initialCompletedToolCount: active._todoReminderCompletedToolCount ?? 0,
				onCompletedToolCount: (count: number) => {
					active._todoReminderCompletedToolCount = count;
					// The behavior-fence edit window only covers the first tool call of a user
					// turn. Once any tool completes (counter advances past its initial value),
					// close the window so later tool calls in the same turn cannot write the fence.
					clearBehaviorFenceEditGrant(narratorId);
				},
				getAfterToolsInjections: () => drainInjectionsIntoHistory(active, locale),
				deliverInjectionRow: async (injection) => {
					const { messageId, turnText } = await deliverInjection(narratorId, {
						content: injection.content,
						body: injection.body,
						source: injection.source,
						schedule: "onNextTurn",
						locale,
					});
					// Knowledge injections are recorded only AFTER the row is durable. The
					// de-dup key is `(narratorId, compactSeq, entryId)` and the in-memory set is
					// reloaded from that table after a compact, so recording a hit whose content
					// never landed would permanently suppress re-injecting that entry.
					if (messageId && injection.knowledgeInjection) {
						const record = injection.knowledgeInjection;
						try {
							knowledgeService.recordInjectionEvents({
								narratorId: record.narratorId,
								compactSeq: record.compactSeq,
								source: "tool_output",
								triggerToolCallId: record.triggerToolCallId,
								hits: record.hits,
							});
						} catch (err) {
							logger.warn("Failed to record knowledge injection events", {
								narratorId,
								error: String(err),
							});
						}
					}
					// Same "only once it is durable" rule: clearing the pending flag for a
					// warning the model never received would lose the warning entirely.
					if (messageId && injection.pipelineExitConfirmationStateId) {
						try {
							await acknowledgePipelineExitConfirmation(
								narratorId,
								injection.pipelineExitConfirmationStateId,
							);
						} catch (err) {
							logger.error("Failed to acknowledge Pipeline exit confirmation", {
								narratorId,
								pipelineStateId: injection.pipelineExitConfirmationStateId,
								error: String(err),
							});
						}
					}
					return turnText ?? "";
				},
				getRuntimeSettingsOverride: () => {
					// active.model/reasoningEffort are updated in real time by narrator routes.
					// For raw refs that follow settings (__default__ / __agg__), also re-resolve
					// when global settings change so the next API request picks up default-model
					// or aggregation membership/routing updates, including retry attempts.
					const revision = getSettingsRevision();
					if (active._settingsRevision !== revision) {
						active._settingsRevision = revision;
						const modelRef = active._modelRef ?? FOLLOW_DEFAULT_MODEL;
						const resolvedModel = resolveEffectiveModel(modelRef, active.provider);
						active.model = resolvedModel;
						active.provider = resolveProvider(resolvedModel);
						active.reasoningEffort = resolveRuntimeReasoningEffort(
							active.provider,
							active.model,
							active._reasoningEffortRef,
						);
					}

					const next: import("../lib/agent").RuntimeSettingsOverride = {};
					if (active.model !== config.model) {
						next.model = active.model;
					}

					const runtimeReasoningEffort =
						active.reasoningEffort ??
						resolveDefaultReasoningEffort(active.provider, active.model) ??
						null;
					const currentReasoningEffort = config.reasoningEffort ?? null;
					if (runtimeReasoningEffort !== currentReasoningEffort) {
						next.reasoningEffort = runtimeReasoningEffort;
					}

					return Object.keys(next).length > 0 ? next : null;
				},
				getModelOverride: () => {
					if (active.model !== config.model) {
						return active.model;
					}
					return null;
				},
				hookHandler: async (event, payload) => {
					const { hookService } = await import("./hook-service");
					return hookService.runHooks(
						event as import("./hook-service").HookEvent,
						{
							hook_event_name: event as import("./hook-service").HookEvent,
							narrator_id: narratorId,
							chapter_id: active._chapterId,
							project_id: active._projectId,
							cwd: active.cwd,
							...payload,
						},
						active._projectId,
						typeof payload.tool_name === "string" ? payload.tool_name : undefined,
					);
				},
				shouldStop: () => {
					const decision = evaluateSoftStopRequest({
						feedbackSoftStop: active._feedbackSoftStop,
						bufferSoftStop: active._bufferSoftStop,
						hasPendingBufferedWork: hasPendingBufferedWork(narratorId),
					});
					active._feedbackSoftStop = decision.feedbackSoftStop;
					active._bufferSoftStop = decision.bufferSoftStop;
					if (decision.softStopTaken) active._bufferSoftStopTaken = true;
					return decision.stop;
				},
				// onEvent receives only side-channel events (tool_output, tool_progress)
				// from executeTool — NOT yielded events like tool_result or assistant_message.
				onEvent: (event) => {
					processEvent(event, eventContext, hooks).catch((err) => {
						logger.error("Side-channel event processing error", {
							narratorId,
							eventType: event.type,
							error: String(err),
						});
					});
				},
			};

			// Convert images to base64 for the agent loop (first iteration only)
			let loopImages: Array<{ format: string; base64: string }> | undefined;
			if (currentImages?.length) {
				const resolved: Array<{ format: string; base64: string }> = [];
				for (const img of currentImages) {
					const uploadNarratorId = img.uploadNarratorId ?? narratorId;
					const filePath = getImagePath(uploadNarratorId, img.imageId);
					if (filePath) {
						try {
							const result = await imageToBase64(filePath);
							const mimeToFormat: Record<string, string> = {
								"image/png": "png",
								"image/jpeg": "jpeg",
								"image/gif": "gif",
								"image/webp": "webp",
							};
							// Prefer detected real format over stored mediaType
							const effectiveMime = result.detectedMediaType ?? img.mediaType;
							resolved.push({
								format: mimeToFormat[effectiveMime] ?? "png",
								base64: result.base64,
							});
						} catch {
							// Image file may have been deleted — skip silently
						}
					}
				}
				if (resolved.length > 0) loopImages = resolved;
				currentImages = undefined; // only attach images on the first iteration
			}

			// Run one agent loop pass

			// When the provider history builder has fresh trailing user-like context
			// as the current turn instead of leaving the model with an empty/dot prompt.
			const currentTurnText = trailingUserText?.trim()
				? currentText.trim()
					? `${trailingUserText}\n\n${currentText}`
					: trailingUserText
				: currentText;

			// The builders popped the trailing user row expecting the caller to send it as
			// the current turn. A pass started with no prompt of its own (a review
			// conclusion's "handle" button, any future producer that writes a user row and
			// starts a bare loop) would otherwise drop that row entirely — see
			// `resolvePoppedTrailingUserText`. Only consulted when this pass has nothing
			// else to say, so an ordinary user turn (whose text is already in
			// `currentText`) can never be duplicated.
			const recoveredTrailingUserText =
				currentTurnText.trim() || trailingToolResults.length > 0
					? null
					: resolvePoppedTrailingUserText(dbMessages);
			if (recoveredTrailingUserText) {
				logger.debug("Resending a popped trailing user row as this pass's turn", {
					narratorId,
					chars: recoveredTrailingUserText.length,
				});
			}

			// When replaying a pure tool-result turn, preserve the original packet shape:
			// no synthetic user text.
			const isPureToolResultReplay = !currentTurnText.trim() && trailingToolResults.length > 0;
			let effectiveText = isPureToolResultReplay
				? ""
				: currentTurnText.trim()
					? currentTurnText
					: (recoveredTrailingUserText ?? currentTurnText);

			// Passive knowledge injection (point A): when this turn carries real user text,
			// surface relevant knowledge-base entries the triggering user may read.
			// ACL is resolved by the loop-triggering user (active._currentUserId), not the narrator.
			if (effectiveText.trim()) {
				try {
					const hits = await knowledgeInjection.resolveInjections(
						active._currentUserId,
						effectiveText,
						{ already: knowledgeInjectedIds, projectId: active._projectId ?? undefined },
					);
					if (hits.length > 0) {
						const block = knowledgeInjection.formatInjections(
							hits,
							"Relevant knowledge-base entries were found for this request:",
						);
						if (block) {
							await narratorService.persistSystemMessage(narratorId, block, [
								knowledgeInjection.createKnowledgeHintBlock(hits, "user_message", cycleSeq),
							]);
							knowledgeService.recordInjectionEvents({
								narratorId,
								compactSeq: cycleSeq,
								source: "user_message",
								hits,
							});
							for (const h of hits) knowledgeInjectedIds.add(h.entryId);
							effectiveText = `${effectiveText}\n\n${block}`;
						}
					}
				} catch (err) {
					logger.warn("Knowledge injection (user message) failed", {
						narratorId,
						error: String(err),
					});
				}
			}

			/**
			 * Suspend this turn until a NUG model becomes available again, then
			 * report whether the loop may continue.
			 *
			 * Shared by the two entry points that need identical behaviour: the
			 * pre-flight check below (the catalog already recorded an outage) and the
			 * post-request `modelUnavailable` branch (the gateway just refused). Both
			 * park on the shared availability poller, which only fetches the
			 * lightweight `/v1/models` list rather than replaying the conversation.
			 *
			 * @returns true when the model recovered and the caller should `continue`
			 * to rebuild history from the DB; false when the caller must `break`
			 * (interrupted, or the narrator went away while waiting).
			 */
			const suspendUntilNugModelAvailable = async (
				mu: Omit<NonNullable<ExecuteLoopResult["modelUnavailable"]>, "provider">,
			): Promise<boolean> => {
				// Finalize or clean up the partial message from the failed turn.
				// If tools already ran (side effects), keep it so the rebuilt history
				// includes them; otherwise it is deleted so the resume starts fresh.
				const partialId = active._partialMessageId;
				active._partialMessageId = undefined;
				let keptPartial = false;
				if (partialId) {
					keptPartial = await finalizeOrCleanupPartialMessage(partialId, narratorId);
				}

				await narratorService.updateStatus(narratorId, "waiting", {
					substatus: ["model_unavailable"],
					errorMessage: JSON.stringify({ type: "model_unavailable", ...mu }),
				});
				broadcastToNarrator(narratorId, {
					type: "model_unavailable_waiting",
					narratorId,
					message: mu.message,
					model: mu.model,
					providerId: mu.providerId,
					providerPrefix: mu.providerPrefix,
					nugModelId: mu.nugModelId,
					diagnostics: mu.diagnostics,
				});

				const outcome =
					mu.providerId && mu.nugModelId
						? await nugAvailabilityPoller.waitForModelAvailable({
								providerId: mu.providerId,
								nugModelId: mu.nugModelId,
								signal: active.abortController.signal,
							})
						: "aborted";

				if (active.abortController.signal.aborted || outcome === "aborted") {
					await finalizeInterruptedRun(active, narratorId, undefined);
					loopWasInterrupted = true;
					return false;
				}
				if (!active.alive) return false;

				// Model recovered — resume by replaying the same turn. Rebuilt history
				// from the DB happens at the top of the loop (as with transient retry),
				// so this is the only point where a full request is issued again.
				broadcastToNarrator(narratorId, {
					type: "model_unavailable_recovered",
					narratorId,
					model: mu.model,
					nugModelId: mu.nugModelId,
				});
				await narratorService.updateStatus(narratorId, "working");
				if (keptPartial) {
					currentText = "";
					currentImages = undefined;
				}
				// Stateful providers (codex) reuse an upstream session keyed by
				// narratorId; force a fresh conversation + session reset so the
				// rebuilt history is sent from a clean upstream state (mirrors the
				// transient-retry path).
				if (usesStatefulModel(resolved.provider, resolved.model)) {
					active.conversationId = randomUUID();
					active._resetUpstreamSessionOnNextRequest = true;
				}
				return true;
			};

			// --- Pre-flight: the model is already known to be unavailable ---
			// The catalog records an outage as soon as one request is refused, so a
			// later turn on the same model can know upfront. Waiting here instead of
			// sending the request saves a full history upload, and it does not depend
			// on the gateway's error text being recognized. A model whose state is
			// unknown is treated as usable, so this never blocks a working model.
			{
				const known = resolveKnownUnavailableNugModel(resolved.model, resolved.provider);
				if (known && active.alive) {
					const resumed = await suspendUntilNugModelAvailable({
						message: `Model ${known.model} is recorded as temporarily unavailable; waiting for it to recover before sending the request.`,
						model: known.model,
						providerId: known.providerId,
						providerPrefix: known.providerPrefix,
						nugModelId: known.nugModelId,
					});
					if (!resumed) break;
					// Re-resolve from the loop top: the user may have switched models
					// while this turn was suspended.
					transientRetries = 0;
					continue;
				}
			}

			active._tokenUsageBaseline = active._lastTokenUsage;
			active._interruptCleanupDone = false;
			const result = await executeAgentLoop({
				config,
				userText: effectiveText,
				history,
				trailingToolResults,
				images: loopImages,
				eventContext,
				hooks,
			});
			contextOverflowRetries = resetContextOverflowRetriesAfterProgress(
				contextOverflowRetries,
				result.completedAssistantTurn,
			);

			// Track the latest pass's final text for the Stop hook (set on every pass,
			// so the most recent assistant text / error message wins regardless of how
			// the loop ultimately terminates).
			if (result.finalText) {
				stopHookFinalText = result.finalText;
			}

			// Track whether the latest pass ended by hitting the max-turns limit.
			// Refreshed every pass (unconditionally) so that if the loop continues
			// afterwards — e.g. goal continuation or a buffered message — and ends
			// normally, this is cleared back to false before the Stop hook fires.
			loopHitMaxTurns = result.maxTurnsExceeded === true;

			loopTotalTokens += accountTokenUsageForTurn(active);

			// Suppress runaway auto-continuation when a continuation pass makes no effective
			// progress: either it called no tools, or it repeatedly hit the same protected-task
			// reflection denial. A different denial starts a fresh count; real tool progress resets it.
			const continuationKind = active._continuationTurn;
			if (continuationKind) {
				const stall = computeContinuationStallState(continuationKind, result, {
					count: active._continuationStallCount ?? 0,
					key: active._continuationStallKey,
				});
				active._continuationStallCount = stall.count;
				active._continuationStallKey = stall.key;
				active._continuationSuppressed = stall.suppressed;
				if (stall.suppressed && stall.key?.startsWith("task-reflection:")) {
					logger.warn("Suppressing repeated protected-task reflection continuation", {
						narratorId,
						continuationKind,
						stallCount: stall.count,
					});
				}
				active._continuationTurn = undefined;
			} else {
				active._continuationStallCount = 0;
				active._continuationStallKey = undefined;
				active._continuationSuppressed = false;
			}

			if (
				shouldFinalizeAbortBeforeRecovery(
					result.aborted,
					active.abortController.signal.aborted,
					active._planApprovedContinue,
				)
			) {
				const partialId = active._partialMessageId;
				active._partialMessageId = undefined;
				await finalizeInterruptedRun(active, narratorId, partialId);
				loopWasInterrupted = true;
				break;
			}

			if (result.paymentRequired && active.alive) {
				const partialId = active._partialMessageId;
				active._partialMessageId = undefined;
				if (partialId) {
					await finalizeOrCleanupPartialMessage(partialId, narratorId);
				}
				await narratorService.updateStatus(narratorId, "idle", {
					substatus: ["payment_required"],
					errorCode: "payment_required",
					errorMessage: JSON.stringify({ type: "payment_required", ...result.paymentRequired }),
				});
				active.events.emit("event", {
					type: "payment_required",
					data: result.paymentRequired,
				});
				loopHadError = true;
				break;
			}

			// --- Model temporarily unavailable: suspend and wait for recovery ---
			// The NUG model's whole credential pool is disabled (recoverable
			// exhaustion). Instead of retrying the full request (re-uploading the
			// entire history) over and over, suspend the narrator and register with
			// the shared instance-level availability poller, which only fetches the
			// lightweight `/v1/models` list. When the model recovers, resume by
			// rebuilding history from the DB and issuing one fresh request.
			if (result.modelUnavailable && active.alive) {
				const mu = result.modelUnavailable;
				// The gateway just refused this model, which is first-hand proof it
				// cannot serve right now. Record that in the model cache before
				// waiting: the poller decides recovery from the cache, and a
				// snapshot taken before the outage would otherwise report the model
				// as available and resume immediately, only to fail again.
				if (mu.providerId && mu.nugModelId) {
					markNugCachedModelUnavailable(mu.providerId, mu.nugModelId);
				}
				const resumed = await suspendUntilNugModelAvailable(mu);
				if (!resumed) break;
				transientRetries = 0;
				continue;
			}

			// --- Context length exceeded: aggressive prune (Codex) then compact/retry ---
			if (result.contextLengthExceeded && active.alive) {
				// Finalize or clean up the partial message from the failed turn.
				// If tools were already executed, the message is kept so the
				// retry's rebuilt history includes them.
				const partialId = active._partialMessageId;
				active._partialMessageId = undefined;
				if (partialId) {
					await finalizeOrCleanupPartialMessage(partialId, narratorId);
				}

				const overflow = await handleContextOverflow({
					narratorId,
					locale,
					provider: active.provider,
					model: active.model,
					contextPercentBefore: active._contextUsagePct,
					overflowRetries: contextOverflowRetries,
					maxRetries: MAX_CONTEXT_OVERFLOW_RETRIES,
					baselineCompactSeq,
					signal: active.abortController.signal,
					onBroadcast: (event) =>
						broadcastToNarrator(narratorId, event as Parameters<typeof broadcastToNarrator>[1]),
				});

				contextOverflowRetries = overflow.overflowRetries;

				if (overflow.action === "retry_pruned") {
					active._pruneBoundaryMessageId = overflow.boundaryMessageId;
					active._resetUpstreamSessionOnNextRequest = true;
					transientRetries = 0;
					continue;
				}
				if (overflow.action === "retry_compacted") {
					active.conversationId = overflow.newConversationId;
					active._resetUpstreamSessionOnNextRequest = true;
					// Whichever compact this rode on already nulled the persisted id, so
					// move the teardown CAS baseline with it — otherwise the baseline
					// still names the pre-compact session, the CAS loses, and this fresh
					// id is never persisted (costing the next activation a cold session).
					active._persistedConversationId = null;
					transientRetries = 0;
					continue;
				}

				// All attempts failed
				const failure = getContextOverflowFailureError(overflow.reason);
				logger.error("Context length exceeded after recovery failed", {
					narratorId,
					reason: overflow.reason,
				});
				await narratorService.updateStatus(narratorId, "idle", {
					substatus: ["error"],
					errorMessage: failure.message,
					errorCode: failure.errorCode,
				});
				active.events.emit("event", {
					type: "error",
					data: { message: failure.message, errorCode: failure.errorCode },
				});
				loopHadError = true;
				break;
			}

			// --- Transient API error: warn frontend and retry with backoff ---
			// For stateless providers, the agentLoop already retried internally with
			// identical history/content — reaching here means all in-loop retries
			// were exhausted.  Only stateful providers (responses/codex) benefit from
			// an outer retry that rebuilds history from DB.
			if (result.retryableError && active.alive) {
				if (!usesStatefulModel(resolved.provider, resolved.model)) {
					// Stateless provider: in-loop retries exhausted — give up.
					const partialId = active._partialMessageId;
					active._partialMessageId = undefined;
					if (partialId) {
						await finalizeOrCleanupPartialMessage(partialId, narratorId);
					}
					await narratorService.updateStatus(narratorId, "idle", {
						substatus: ["error"],
						errorMessage: result.retryableError,
						diagnostics: result.retryableDiagnostics,
					});
					active.events.emit("event", {
						type: "error",
						data: {
							message: result.retryableError,
							diagnostics: result.retryableDiagnostics,
						},
					});
					loopHadError = true;
					break;
				}
				// Stateful provider: outer retry with rebuilt history
				transientRetries++;
				const { shouldRetry } = await handleTransientError({
					narratorId,
					error: result.retryableError,
					retryCount: transientRetries,
					maxRetries: result.bypassRetryLimit ? -1 : getMaxTransientRetries(),
					signal: active.abortController.signal,
				});
				if (active.abortController.signal.aborted) {
					const partialId = active._partialMessageId;
					active._partialMessageId = undefined;
					await finalizeInterruptedRun(active, narratorId, partialId);
					loopWasInterrupted = true;
					break;
				}
				if (shouldRetry) {
					// Finalize or clean up the partial message from the failed turn.
					// If tools were already executed (side effects occurred), the message
					// is kept so buildHistory includes them and the model won't repeat them.
					// Otherwise the partial is deleted so the retry starts fresh.
					const partialId = active._partialMessageId;
					active._partialMessageId = undefined;
					let keptPartial = false;
					if (partialId) {
						keptPartial = await finalizeOrCleanupPartialMessage(partialId, narratorId);
					}
					if (keptPartial) {
						currentText = "";
						currentImages = undefined;
					}
					// Stateful providers (codex) reuse an upstream WS session keyed by
					// narratorId. This retry rebuilds history from the DB, so force a
					// fresh conversation + upstream session reset — mirroring the
					// compact/prune retry paths above and the subagent equivalent
					// (subagent-executor.ts). Codex clears its session on most errors
					// already, but this makes the retry independent of that cleanup so
					// the rebuilt history is always sent from a clean upstream state.
					active.conversationId = randomUUID();
					active._resetUpstreamSessionOnNextRequest = true;
					continue;
				}
				// If aborted during backoff sleep, don't mark as error — the
				// interrupt handler will set the correct status.
				if (!active.alive) {
					break;
				}
				await narratorService.updateStatus(narratorId, "idle", {
					substatus: ["error"],
					errorMessage: result.retryableError,
					diagnostics: result.retryableDiagnostics,
				});
				active.events.emit("event", {
					type: "error",
					data: {
						message: result.retryableError,
						diagnostics: result.retryableDiagnostics,
					},
				});
				loopHadError = true;
				break;
			}

			if (result.silentDisconnect && active.alive) {
				const message = "Codex WebSocket silent disconnect";
				transientRetries++;
				const { shouldRetry } = await handleTransientError({
					narratorId,
					error: message,
					retryCount: transientRetries,
					maxRetries: getMaxTransientRetries(),
					signal: active.abortController.signal,
				});

				if (active.abortController.signal.aborted) {
					const partialId = active._partialMessageId;
					active._partialMessageId = undefined;
					await finalizeInterruptedRun(active, narratorId, partialId);
					loopWasInterrupted = true;
					break;
				}

				const partialId = active._partialMessageId;
				active._partialMessageId = undefined;
				if (partialId) {
					await finalizeOrCleanupPartialMessage(partialId, narratorId);
				}

				if (shouldRetry) {
					continue;
				}
				if (!active.alive) {
					break;
				}
			}

			if (result.maxTurnsExceeded && active.alive && !loopHadError) {
				const continuationPrompt = await maybeStartContinuation(active, false);
				if (continuationPrompt) {
					await narratorService.updateStatus(narratorId, "working");
					currentText = "";
					currentImages = undefined;
					continue;
				}
			}

			if (result.hasError && active.alive && !loopHadError) {
				const partialId = active._partialMessageId;
				active._partialMessageId = undefined;
				if (partialId) {
					await finalizeOrCleanupPartialMessage(partialId, narratorId);
				}
				await narratorService.updateStatus(narratorId, "idle", {
					substatus: ["error"],
					errorMessage: result.finalText,
					errorCode: result.errorCode,
					diagnostics: result.errorDiagnostics,
				});
				active.events.emit("event", {
					type: "error",
					data: { message: result.finalText, diagnostics: result.errorDiagnostics },
				});
				loopHadError = true;
				break;
			}

			// Reset transient retry counter on success or after a non-retried silent disconnect.
			transientRetries = 0;

			if (result.interrupted && active.alive) {
				// "completion_limit" (provider hit its max output tokens) and
				// "resumable_error" (a transient failure occurred after partial output
				// was already produced, e.g. a NUG-reported stream disconnect) both
				// resume from partial output the same way — only the continuation
				// prompt shown to the model differs.
				const interruptedReason = result.interruptedReason ?? "completion_limit";
				const continuationLogLabel =
					interruptedReason === "resumable_error"
						? "Resumable-error continuation"
						: "Completion-limit continuation";
				interruptionRetries++;
				if (interruptionRetries > MAX_INTERRUPTION_RETRIES) {
					logger.warn(`${continuationLogLabel}: max retries reached, stopping`, {
						narratorId,
						retries: interruptionRetries,
					});
				} else if (result.shouldReplayInterruptedToolResultTurn) {
					logger.info(`${continuationLogLabel}: replaying interrupted tool-result turn`, {
						narratorId,
						retries: interruptionRetries,
					});
					currentText = "";
					currentImages = undefined;
					continue;
				} else {
					const continueText = getToolMessage(
						interruptedReason === "resumable_error"
							? "resumeAfterTransientError"
							: "interruptionContinue",
						locale,
					);
					// Resume prompt synthesized by the loop, not typed by anyone.
					const userMsg = await narratorService.persistUserMessage(
						narratorId,
						continueText,
						[{ type: "text", text: continueText }],
						undefined,
						undefined,
						{
							origin: "system",
							originLabel: formatOriginLabel("autoContinuation"),
						},
					);
					broadcastToNarrator(narratorId, {
						type: "user_message",
						narratorId,
						message: userMsg,
					});
					active.events.emit("event", { type: "user_message", data: userMsg });
					await narratorService.updateStatus(narratorId, "working");
					currentText = continueText;
					currentImages = undefined;
					continue;
				}
			} else {
				interruptionRetries = 0;
			}

			if (result.shouldUpdateTitle) {
				shouldUpdateTitle = true;
			}

			// Plan approved — abort was triggered by onExitPlanMode so we persist
			// a user message and restart the loop to drive plan execution.
			if (
				active._planApprovedContinue === "compact" ||
				active._planApprovedContinue === "continue"
			) {
				const isCompact = active._planApprovedContinue === "compact";
				active._planApprovedContinue = undefined;
				active.abortController = new AbortController();

				if (isCompact) {
					await narratorService.updateStats(narratorId, 0);
				}

				const continuePrompt = getToolMessage(
					isCompact ? "planCompactContinue" : "exitPlanModeApproved",
					locale,
				);

				// If the user edited the plan, append the diff to the prompt
				// (only for non-compact — compact already has the edited plan in system prompt)
				const planDiff = pendingPlanDiff.get(narratorId);
				if (planDiff) pendingPlanDiff.delete(narratorId);
				const basePrompt =
					!isCompact && planDiff
						? getToolMessageWithParams("exitPlanModeApprovedWithDiff", locale, {
								diff: planDiff,
							})
						: continuePrompt;

				// Check for chained feedback — merge with diff if both exist
				const fb = pendingFeedback.get(narratorId);
				if (fb) pendingFeedback.delete(narratorId);
				const promptText = fb
					? basePrompt !== continuePrompt
						? `${basePrompt}\n\n${fb.feedbackText}`
						: fb.feedbackText
					: basePrompt;

				// Retrieve the approver identity (userId + whether a human or the plan
				// reflection approved) so the injected turn is attributed correctly.
				const approverId = pendingPlanApprover.get(narratorId);
				if (approverId) pendingPlanApprover.delete(narratorId);
				const approverSource = pendingPlanApproverSource.get(narratorId);
				if (approverSource) pendingPlanApproverSource.delete(narratorId);

				// Attribution lives in its own pure module (precedence documented there):
				// chained feedback → the typist, else a recorded human approver, else the
				// plan reflection's "计划反思" identity, else the auto-continuation card.
				const { originOptions, createdBy } = resolvePlanApprovalAttribution({
					hasFeedback: !!fb,
					feedbackUserId: fb?.userId ?? null,
					approverId,
					approverSource,
				});
				const userMsg = await narratorService.persistUserMessage(
					narratorId,
					promptText,
					[{ type: "text", text: promptText }],
					undefined,
					createdBy,
					originOptions,
				);
				broadcastToNarrator(narratorId, {
					type: "user_message",
					narratorId,
					message: userMsg,
				});
				active.events.emit("event", { type: "user_message", data: userMsg });
				await narratorService.updateStatus(narratorId, "working");
				currentText = promptText;
				currentImages = undefined;
				continue;
			}

			// User interrupt: stop the outer loop here. Without this guard, a post-abort
			// tool_result can make executeAgentLoop return before narrator-session notices
			// the interrupted state, causing pending-permission aborts to incorrectly
			// continue into buffered-message / done handling.
			if (result.aborted || active.abortController.signal.aborted) {
				const partialId = active._partialMessageId;
				active._partialMessageId = undefined;
				await finalizeInterruptedRun(active, narratorId, partialId);
				loopWasInterrupted = true;
				break;
			}

			// Check for chained feedback BEFORE marking idle/unread — when the user
			// approves a permission with attached text, the loop is aborted right
			// after the tool completes so the feedback is injected immediately
			// instead of waiting for the entire turn to finish.
			const fb = pendingFeedback.get(narratorId);
			if (fb) {
				pendingFeedback.delete(narratorId);
				// Text the approver typed alongside their permission decision.
				const userMsg = await narratorService.persistUserMessage(
					narratorId,
					fb.feedbackText,
					[{ type: "text", text: fb.feedbackText }],
					undefined,
					fb.userId ?? undefined,
					{ origin: "user" },
				);
				broadcastToNarrator(narratorId, { type: "user_message", narratorId, message: userMsg });
				active.events.emit("event", { type: "user_message", data: userMsg });
				await narratorService.updateStatus(narratorId, "working");
				currentText = fb.feedbackText;
				// Approving a permission with attached text starts a new pass here, so a
				// cut-in message queued during the same tool call needs its boundary back.
				rearmCutInSoftStopBeforeContinuing(active);
				continue;
			}

			// Review git state check — if the review narrator modified files,
			// reset and re-inject a message to continue the loop.
			if (active._chapterRole === "review" && active._chapterId && active.alive) {
				const gitCheck = await reviewService.checkAndResetGitState(active._chapterId);
				if (!gitCheck.clean && gitCheck.message) {
					// Review guardrail notice generated by the review service.
					const userMsg = await narratorService.persistUserMessage(
						narratorId,
						gitCheck.message,
						[{ type: "text", text: gitCheck.message }],
						undefined,
						undefined,
						{ origin: "system", originLabel: formatOriginLabel("review") },
					);
					broadcastToNarrator(narratorId, {
						type: "user_message",
						narratorId,
						message: userMsg,
					});
					active.events.emit("event", { type: "user_message", data: userMsg });
					await narratorService.updateStatus(narratorId, "working");
					currentText = gitCheck.message;
					// The guardrail notice starts a new pass, so keep a cut-in message's
					// boundary alive instead of stranding it for the rest of the loop.
					rearmCutInSoftStopBeforeContinuing(active);
					continue;
				}
				// Git is clean and loop ended normally — conclude the review
				if (!result.hasError) {
					await reviewService.concludeReview(active._chapterId);
				}
			}

			// Agent loop done — update stats (always, even if we continue with buffered messages)
			await narratorService.updateStats(narratorId, 0);

			// Compact after a complete turn when either:
			// 1. context usage is above compactStart and the prune gate allows compact, or
			// 2. the pruned message ratio itself has reached the configured force-compact threshold.
			// This is a fallback — the mid-turn context_usage handler may have already started
			// a background compact.
			const { model: postModel, provider: postProvider } = resolveProviderAndModel(
				active.model,
				active.provider,
			);
			const postTurnThresholds = getContextThresholds(postModel, postProvider);
			if (active._contextUsagePct != null && hasPendingHistoryCompact(narratorId)) {
				logger.debug("Dropping stale post-turn context usage: prior compact not yet applied", {
					narratorId,
					contextPct: active._contextUsagePct,
				});
				active._contextUsagePct = undefined;
			}
			if (active._contextUsagePct != null && !compactLocks.has(narratorId)) {
				const postTurnContextPct = active._contextUsagePct;
				active._contextUsagePct = undefined;

				const compactPruneThreshold = getAutoCompactPruneThreshold();
				const contextReachedCompactStart = postTurnContextPct >= postTurnThresholds.compactStart;
				const pruningWindowEnabled = isDynamicPruningWindowEnabled(postTurnThresholds);
				let currentPrunedPct = 0;
				let shouldCompact = false;
				let compactReason: "context_threshold" | "prune_threshold" | "pruning_window_disabled" =
					"context_threshold";

				if (contextReachedCompactStart && !pruningWindowEnabled) {
					logger.info("Pruning window disabled, triggering background compact (post-turn)", {
						narratorId,
						contextPct: postTurnContextPct,
						pruneStart: postTurnThresholds.pruneStart,
						compactStart: postTurnThresholds.compactStart,
					});
					shouldCompact = true;
					compactReason = "pruning_window_disabled";
				} else {
					const narrator = await db.query.narrators.findFirst({
						where: eq(narrators.id, narratorId),
						columns: { prunedPercent: true, pruneEnabled: true },
					});
					currentPrunedPct = narrator?.prunedPercent ?? 0;
					const pruneDisabled = narrator != null && !narrator.pruneEnabled;
					const pruneReachedForceCompact =
						!pruneDisabled && currentPrunedPct >= compactPruneThreshold;

					if (contextReachedCompactStart && !pruneDisabled && !pruneReachedForceCompact) {
						logger.info(
							"Context above compactStart post-turn but prunedPercent below threshold, skipping compact",
							{
								narratorId,
								contextPct: postTurnContextPct,
								prunedPercent: currentPrunedPct,
								threshold: compactPruneThreshold,
							},
						);
					} else if (contextReachedCompactStart || pruneReachedForceCompact) {
						shouldCompact = true;
						compactReason = pruneReachedForceCompact ? "prune_threshold" : "context_threshold";
					}
				}

				if (shouldCompact) {
					const boundaryMessageId = await narratorService.getCompactBoundaryMessage(
						narratorId,
						getAutoCompactKeepPairs(),
					);

					if (boundaryMessageId) {
						logger.info("Triggering background compact (post-turn)", {
							narratorId,
							boundaryMessageId,
							contextPct: postTurnContextPct,
							prunedPercent: currentPrunedPct,
							threshold: compactPruneThreshold,
							reason: compactReason,
						});

						// Fire-and-forget: compact runs in the background.
						// On completion it resets the narrator's conversationId so the next
						// agent loop iteration starts a fresh API conversation.
						runCustomCompact(narratorId, locale, boundaryMessageId, { mode: "background" }).catch(
							(compactErr) => {
								logger.error("Auto-compact failed", {
									narratorId,
									error: String(compactErr),
								});
							},
						);
					} else {
						logger.info("Compact requested but not enough messages to compact", {
							narratorId,
							contextPct: postTurnContextPct,
							prunedPercent: currentPrunedPct,
						});
					}
				}
			}

			// Anything queued during this turn (completions AND inbound messages) keeps the
			// loop running instead of going idle. Previously only completions were checked
			// here, so a message that arrived at this exact moment waited for the next wake.
			const bgCompletionPrompt = await drainAndPersistPendingInjections(active);
			if (bgCompletionPrompt) {
				await narratorService.updateStatus(narratorId, "working");
				currentText = "";
				currentImages = undefined;
				// This drain starts a fresh pass before the buffer consumer below is
				// reached, which would strand a cut-in message for the rest of the loop.
				rearmCutInSoftStopBeforeContinuing(active);
				continue;
			}

			// Check for buffered messages BEFORE transitioning to idle/unread —
			// this prevents spurious notifications when there are queued messages.
			// When the loop had an error, skip consumption entirely so queued
			// messages are preserved for the user to retry or dismiss.
			if (!loopHadError) {
				const queue = bufferedMessages.get(narratorId);
				const buffered = queue?.[0];
				if (buffered) {
					// A queued message is being consumed, so the soft stop served its purpose.
					active._bufferSoftStopTaken = false;
					queue?.shift();
					if (queue?.length === 0) bufferedMessages.delete(narratorId);
					// Remove consumed message from DB + cleanup persisted text files
					dbConsumeBuffered(buffered.id);
					// Broadcast which message was consumed + remaining queue snapshot
					const remaining = toBufferSummary(getBufferedMessages(narratorId));
					broadcastToNarrator(narratorId, {
						type: "buffer_consumed",
						narratorId,
						messageId: buffered.id,
						remaining,
					});
					const newCommand = parseQueuedNewCommand(buffered.text, buffered.commandText);
					if (newCommand) {
						const newNarratorId = await executeQueuedNewCommand(
							active,
							buffered,
							newCommand.initialMessage,
						);
						broadcastToNarrator(narratorId, {
							type: "queued_new_narrator_created",
							narratorId,
							messageId: buffered.id,
							newNarratorId,
						});
						if ((bufferedMessages.get(narratorId)?.length ?? 0) > 0) {
							loopWasInterrupted = true;
						} else {
							await narratorService.compareAndSetStatus(
								narratorId,
								["working", "waiting"],
								"idle",
								{
									substatus: ["unread"],
								},
							);
						}
						break;
					}
					// A queued /goal appends its protected task, then continues this same
					// loop with an explicit Spec instruction. Later queued messages retain
					// their order and are consumed after this goal turn.
					const goalCommand = parseQueuedGoalCommand(buffered.text, buffered.commandText);
					if (goalCommand) {
						await executeQueuedGoalCommand(narratorId, buffered, goalCommand.objective);
						active._continuationSuppressed = false;
						active._continuationStallCount = 0;
						active._continuationStallKey = undefined;
						active._currentUserId = buffered.createdBy ?? active._currentUserId ?? null;
						const continuationPrompt = await maybeStartContinuation(active, false, {
							explicitStart: true,
						});
						if (continuationPrompt) {
							await narratorService.updateStatus(narratorId, "working");
							currentText = "";
							currentImages = undefined;
							continue;
						}
						if ((bufferedMessages.get(narratorId)?.length ?? 0) > 0) {
							loopWasInterrupted = true;
						} else {
							await narratorService.compareAndSetStatus(
								narratorId,
								["working", "waiting"],
								"idle",
								{ substatus: ["unread"] },
							);
						}
						break;
					}
					// Save buffered text files to worktree
					const savedBufferedTextFiles: TextFileRef[] = [];
					if (buffered.textFiles?.length) {
						for (const file of buffered.textFiles) {
							savedBufferedTextFiles.push(await saveTextFileToWorktree(active.cwd, file));
						}
					}
					const persistBlocks: Array<
						| { type: "text"; text: string }
						| PersistedUserImageBlock
						| {
								type: "text_file";
								filename: string;
								size: number;
								filePath: string;
						  }
					> = [];
					if (buffered.images?.length) {
						for (const img of buffered.images) {
							persistBlocks.push(imageRefToContentBlock(img));
						}
					}
					if (savedBufferedTextFiles.length > 0) {
						for (const tf of savedBufferedTextFiles) {
							persistBlocks.push({
								type: "text_file",
								filename: tf.filename,
								size: tf.size,
								filePath: tf.filePath,
							});
						}
					}
					const effectiveBufferedText =
						buffered.text + buildAttachedFilesHint(savedBufferedTextFiles);
					// contentJson blocks store raw user text; contentText stores effectiveBufferedText (see feedMessage)
					persistBlocks.push({ type: "text", text: buffered.text });
					const userMsg = await narratorService.persistUserMessage(
						narratorId,
						effectiveBufferedText,
						persistBlocks,
						buffered.commandText,
						buffered.createdBy,
					);
					broadcastToNarrator(narratorId, { type: "user_message", narratorId, message: userMsg });
					active.events.emit("event", { type: "user_message", data: userMsg });
					await narratorService.updateStatus(narratorId, "working");
					// runBashFirst flow: run the Bash command as an assistant tool card after the
					// user message, then replay it as the current turn (empty text) so the model
					// sees: user prompt → Bash tool call/result → reply.
					if (buffered.bashCommand) {
						await handleBashCommand(
							narratorId,
							buffered.bashCommand,
							`/bash ${buffered.bashCommand}`,
							buffered.createdBy ?? undefined,
							{ skipUserMessage: true, signal: active.abortController.signal },
						);
						currentText = "";
						currentImages = undefined;
						continue;
					}
					currentText = effectiveBufferedText;
					currentImages = buffered.images;
					continue;
				}
			}

			// The pass above ended early only to let a queued message cut in, but the
			// queue is now empty — the user cancelled it while the current tool call was
			// still running. The model's work is unfinished, so resume the turn instead
			// of settling idle (which would look like the narrator stopping on its own
			// right after that tool call).
			if (active._bufferSoftStopTaken) {
				active._bufferSoftStopTaken = false;
				if (!loopHadError && active.alive) {
					logger.info("Resuming turn after a cancelled cut-in queued message", { narratorId });
					await narratorService.updateStatus(narratorId, "working");
					currentText = "";
					currentImages = undefined;
					continue;
				}
			}

			const continuationPrompt = await maybeStartContinuation(active, loopHadError);
			if (continuationPrompt) {
				await narratorService.updateStatus(narratorId, "working");
				// The continuation prompt was persisted as a system message; the next
				// provider call only needs an empty turn to advance the conversation.
				currentText = "";
				currentImages = undefined;
				continue;
			}

			// No buffered messages — now transition to idle/unread (triggers notifications)
			if (!loopHadError) {
				// Drain any queued injection FIRST, before flipping the DB status to idle.
				// This closes the window where status is already idle (visible to clients /
				// route admission) while this loop is still running and about to pick up more
				// work. If anything is queued, keep the status working and continue this loop
				// instead of going idle at all.
				const bgCompletionAfterIdle = await drainAndPersistPendingInjections(active);
				if (bgCompletionAfterIdle) {
					await narratorService.updateStatus(narratorId, "working");
					currentText = "";
					currentImages = undefined;
					continue;
				}

				// Nothing left to do — atomically transition working/waiting → idle with
				// unread substatus. No awaited work runs between this and the break below,
				// so the "DB idle but loop still running" window is minimal. If status has
				// already moved (e.g. another loop took over after hot reload, or user
				// interrupted), the CAS is a no-op.
				await narratorService.compareAndSetStatus(narratorId, ["working", "waiting"], "idle", {
					substatus: ["unread"],
				});
			}

			active.events.emit("event", { type: "done", data: null });
			break;
		}
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		logger.error("Narrator loop error", { narratorId, error: errorMsg });
		try {
			await withDbRetry(
				() =>
					narratorService.updateStatus(narratorId, "idle", {
						substatus: ["error"],
						errorMessage: errorMsg,
					}),
				{ label: "runAgentLoop.updateErrorStatus", maxRetries: 5 },
			);
		} catch (statusErr) {
			logger.error("Failed to persist narrator error status", {
				narratorId,
				error: String(statusErr),
			});
		}
		loopHadError = true;
		active.events.emit("event", { type: "error", data: { message: errorMsg } });
	} finally {
		active._loopRunning = false;
		active.alive = false;
		unregisterUpdateLoop();

		// Backstop for the write-claim registry: `onErrorCleanup` covers the loop's own
		// abort/error events, but a throw out of executeAgentLoop itself never reaches
		// it. Any claim still in flight once the loop is over belongs to a tool that
		// will never report a result, and leaving it open makes its declared paths
		// shadow every later window in this worktree. Idempotent — sealing an already
		// closed claim does nothing.
		if (active._isInGitRepo) abandonSessionTreeSnapshots(active, narratorId);

		try {
			const cleared = await clearPipelineStateIfActive(narratorId);
			if (cleared) {
				logger.info("Cleared stale pipeline state after narrator loop", { narratorId });
			}
		} catch (err) {
			logger.warn("Failed to clear stale pipeline state after narrator loop", {
				narratorId,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// --- Stop hooks ---
		// Fire once per completed response turn for the MAIN narrator only (not
		// subagents). Covers every termination path: normal done, error, and
		// user interrupt. Non-blocking and fire-and-forget — hook failures never
		// affect narrator state.
		if (saParentNarratorId === undefined) {
			void (async () => {
				try {
					const narr = await db.query.narrators.findFirst({
						where: eq(narrators.id, narratorId),
						columns: { variant: true },
					});
					if (narr && isSubagentVariant(narr.variant)) return;

					const stopReason = loopHadError
						? "error"
						: loopWasInterrupted
							? "aborted"
							: loopHitMaxTurns
								? "max_turns"
								: "done";
					const { hookService } = await import("./hook-service");
					await hookService.runHooks(
						"Stop",
						{
							hook_event_name: "Stop",
							narrator_id: narratorId,
							chapter_id: active._chapterId,
							project_id: active._projectId,
							cwd: active.cwd,
							stop_reason: stopReason,
							stop_error: loopHadError,
							last_assistant_text: stopHookFinalText.slice(0, 2000),
							duration_ms: Date.now() - loopStartedAt,
							total_tokens: loopTotalTokens,
						},
						active._projectId,
					);
				} catch (err) {
					logger.warn("Stop hook execution failed", {
						narratorId,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			})();
		}

		// When a subagent narrator completes (from the subagent page), check if
		// there's a conclusion watcher registered for post-completion updates.
		try {
			const narr = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { variant: true, parentNarratorId: true },
			});
			if (narr && isSubagentVariant(narr.variant)) {
				// For explore/plan subagents with a conclusion file, prefer reading
				// the file content over extracting from the last assistant message.
				// The file itself is KEPT on disk (like plan files): some workflows depend
				// on the subagent leaving a durable markdown artifact behind.
				let lastFinalText: string | undefined;
				const concEntry = getConclusionEntry(narratorId);
				if (concEntry) {
					try {
						if (existsSync(concEntry.absPath)) {
							const content = readFileSync(concEntry.absPath, "utf-8").trim();
							if (content && !loopHadError) {
								lastFinalText = content;
							}
						}
					} catch (err) {
						logger.warn("Failed to read takeover conclusion file", {
							narratorId,
							path: concEntry.absPath,
							error: err instanceof Error ? err.message : String(err),
						});
					}
					deleteConclusionFileId(narratorId);
				}
				if (!lastFinalText) {
					lastFinalText = await getSubagentFinalText(narratorId);
				}

				// --- Takeover handoff ---
				// While the subagent is taken over, the parent stays blocked in
				// waitForManualOverride (foreground) or holds a background_task_id
				// (background). When an intermediate loop finishes but the user has
				// NOT stopped takeover, do nothing (keep the takeover active; the
				// subagent waits idle[taken_over] for the next user action).
				if (consumePendingBackgroundFinalize(narratorId)) {
					// Background takeover stopped while still working — finalize as a
					// background completion so the parent learns the result.
					const { finalizeTakenOverBackgroundSubagent } = await import("./subagent-runner");
					const watcher = getConclusionWatcher(narratorId);
					const parentId = saParentNarratorId ?? narr.parentNarratorId ?? "";
					const tuid = watcher?.toolUseId ?? saParentToolUseId ?? "";
					clearTakenOver(narratorId);
					if (parentId) {
						await finalizeTakenOverBackgroundSubagent(
							narratorId,
							parentId,
							tuid,
							loopHadError,
							lastFinalText,
							locale,
						);
					}
				} else if (consumePendingStopTakeover(narratorId)) {
					// Foreground takeover stopped while still working — resolve the
					// parent's blocked Promise exactly once so the parent's
					// runForegroundLoop finalizer returns the result (no double-write).
					clearTakenOver(narratorId);
					if (getManualOverrideMap().has(narratorId)) {
						resolveManualOverride(narratorId, lastFinalText, loopHadError);
					} else {
						// Session-engine takeover stopped while still working — the
						// parent was already unblocked when the user continued the
						// subagent, so hand the result back via the conclusion watcher
						// and clear the lingering taken_over tag.
						const watcher = getConclusionWatcher(narratorId);
						if (watcher) {
							removeConclusionWatcher(narratorId);
							const resultMsgId = await getSubagentResultMessageId(narratorId);
							await updateToolCallConclusion({
								subagentId: narratorId,
								parentNarratorId: watcher.parentNarratorId,
								toolUseId: watcher.toolUseId,
								finalText: lastFinalText,
								hasError: loopHadError,
								resultMessageId: resultMsgId,
								refreshTiming: true,
							});
						}
						await narratorService.removeSubstatus(narratorId, "taken_over").catch(() => {});
					}
				} else if (isTakenOver(narratorId)) {
					// Still taken over — keep blocked/held, no handoff.
				} else {
					const watcher = getConclusionWatcher(narratorId);
					if (watcher) {
						removeConclusionWatcher(narratorId);
						// Resolve the last assistant message ID for result binding
						const resultMsgId = await getSubagentResultMessageId(narratorId);
						await updateToolCallConclusion({
							subagentId: narratorId,
							parentNarratorId: watcher.parentNarratorId,
							toolUseId: watcher.toolUseId,
							finalText: lastFinalText,
							hasError: loopHadError,
							resultMessageId: resultMsgId,
							refreshTiming: true,
						});
					}
				}
			}
		} catch (err) {
			logger.error("Failed to resolve suspended subagent / conclusion watcher", {
				narratorId,
				error: String(err),
			});
		}

		// Restore model after temporary override (slash command with modelOverride.mode="temporary")
		// Read from DB so this survives server restarts.
		try {
			const fresh = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { pendingModelRestore: true },
			});
			if (fresh?.pendingModelRestore) {
				const restoreModel = fresh.pendingModelRestore;
				await db
					.update(narrators)
					.set({
						model: restoreModel,
						pendingModelRestore: null,
						updatedAt: new Date().toISOString(),
					})
					.where(eq(narrators.id, narratorId));
				broadcastToNarrator(narratorId, {
					type: "model_changed",
					narratorId,
					model: restoreModel,
				});
			}
		} catch (err) {
			logger.error("Failed to restore model after temporary override", {
				narratorId,
				error: String(err),
			});
		}

		if (active._gitTrackTimer) clearTimeout(active._gitTrackTimer);
		// Stop file watcher for this narrator
		if (active._worktreePath) {
			worktreeWatcher.unwatch(active._worktreePath, narratorId);
		}
		// Persist conversationId so the next activation can resume the API session
		// (avoids cache miss from generating a new random UUID every time).
		//
		// Compare-and-set against the id this session started from. A compact clears
		// the column to demand a fresh upstream session on the next request, and a
		// background compact can land after the turn that started it — including on a
		// turn that ended perfectly normally. An unconditional write would undo that
		// signal, and the next activation would resume a session still holding the
		// pre-compact history alongside the compacted one.
		persistConversationIdIfUnchanged(narratorId, active);
		active._preparedPlanModes?.clear();
		activeNarrators.delete(narratorId);
		planModeAskedOnce.delete(narratorId);
		clearStreamingSnapshot(narratorId);
		active.abortController.abort();
		active.events.emit("event", { type: "done", data: null });
		active.events.removeAllListeners();

		// --- Clean up per-narrator entries in global containers to prevent memory leaks ---
		// These containers are module-level (hotSafe) and persist across narrator sessions.
		// Without cleanup, entries accumulate on every interrupt/retry/error cycle.

		// 1. pendingPermissions: key = toolCallId, value.narratorId identifies the owner
		for (const [key, perm] of pendingPermissions) {
			if (perm.narratorId === narratorId) {
				try {
					perm.cleanup();
				} catch (e) {
					logger.debug("Failed to cleanup pending permission", {
						toolCallId: key,
						error: String(e),
					});
				}
				pendingPermissions.delete(key);
			}
		}

		// 2-5. Containers keyed directly by narratorId
		pendingFeedback.delete(narratorId);
		pendingPlanCompact.delete(narratorId);
		pendingPlanApprover.delete(narratorId);
		pendingPlanApproverSource.delete(narratorId);
		pendingPlanDiff.delete(narratorId);
		// Soft-stop bookkeeping never survives the loop that owns it.
		active._bufferSoftStop = false;
		active._bufferSoftStopTaken = false;
		// 6. Subagent team tracking — alias registry and file change records
		clearAliasRegistry(narratorId);
		clearTeamFileChanges(narratorId);
		// When the loop ended with an error or was interrupted while buffered
		// messages exist, preserve those messages so the user can retry / the
		// next activation consumes them automatically.  Notify the frontend so
		// it keeps showing the queued messages.
		// DB rows are kept in sync:
		// - error/interrupted-with-queue: rows stay (recovered on next startup or consumed on retry)
		// - normal: rows are deleted (queue fully consumed)
		const hasBuffered = (bufferedMessages.get(narratorId)?.length ?? 0) > 0;
		if (loopHadError || (loopWasInterrupted && hasBuffered)) {
			// Only broadcast buffer_preserved on error — when interrupted the
			// auto-resume below will immediately consume the first message, so
			// showing a "preserved" notification would be misleading.
			if (loopHadError) {
				const preserved = bufferedMessages.get(narratorId);
				if (preserved?.length) {
					broadcastToNarrator(narratorId, {
						type: "buffer_preserved",
						narratorId,
						messages: toBufferSummary(preserved),
					});
				}
			}
		} else {
			bufferedMessages.delete(narratorId);
			dbClearAllBuffered(narratorId);
		}

		// 6. Per-narrator git status Promise cache (Bash before-status snapshots)
		active._bashBeforeStatus?.clear();

		// Safety net: transient "reflecting"/"reasoning" tags are added mid-turn
		// (danger/task reflection gates, streaming reasoning) and cleared by
		// event-driven or status-transition code. Some escape paths — a
		// compareAndSetStatus no-op after status drift, a silent disconnect break,
		// or a DB lock swallowing the clear — can leave one stuck, which pins the
		// sidebar tab icon purple until the next server restart. The loop has now
		// fully ended, so neither tag should survive; strip any leftover here.
		for (const staleTag of ["reflecting", "reasoning"] as const) {
			if (active._substatus.has(staleTag)) active._substatus.delete(staleTag);
		}
		try {
			const leftover = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { substatus: true },
			});
			const tags = parseSubstatus(leftover?.substatus);
			if (tags.includes("reflecting") || tags.includes("reasoning")) {
				await narratorService.updateSubstatus(
					narratorId,
					tags.filter((t) => t !== "reflecting" && t !== "reasoning"),
				);
			}
		} catch (err) {
			logger.warn("Failed to clear stale transient substatus after narrator loop", {
				narratorId,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		if (shouldUpdateTitle) {
			generateAndSetTitle(narratorId, locale).catch(() => {});
		}
		active._provisionalTitle = undefined;

		// Auto-resume: when the loop was interrupted and buffered messages remain,
		// consume them. This makes priority messages run at the next safe boundary
		// without waiting for manual input. `/new` drains immediately; `/goal`
		// starts a Spec continuation and leaves later queued messages in order.
		if (loopWasInterrupted && !loopHadError) {
			resumeNextBufferedMessage(active, locale);
		}

		// Wait until every old-session cleanup step is complete before broadcasting
		// the recovery card. Otherwise a fast click could start a new session while
		// this finally block still owns and clears narrator-scoped state.
		if (pendingWorkingDirectoryRecovery) {
			try {
				await narratorService.persistDisplayMessage(narratorId, "", [
					{
						type: "cwd_recovery",
						missingCwd: pendingWorkingDirectoryRecovery.missingCwd,
						suggestedCwd: pendingWorkingDirectoryRecovery.suggestedCwd,
					},
				]);
			} catch (err) {
				logger.error("Failed to persist missing workdir recovery notice", {
					narratorId,
					error: String(err),
				});
			}
		}
	}

	return { started: true };
}

// === Message feeding ===

/**
 * Persist a user message and kick off the agent loop in the background.
 * Returns the active narrator and persisted message for SSE subscription.
 */
async function feedMessage(
	narratorId: string,
	prompt: string,
	images?: ImageRef[],
	locale: Locale = "en",
	replyInUserLanguage = false,
	commandText?: string | null,
	userId?: string | null,
	rawTextFiles?: File[],
	preBashCommand?: string | null,
	internalOptions?: { preserveTurnStart?: boolean; turnStartedAt?: string },
	origin?: MessageOriginOptions,
): Promise<{
	active: ActiveNarrator;
	userMsg: typeof narratorMessages.$inferSelect;
	userBroadcasted?: boolean;
}> {
	const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
	// Final guard against a concurrent loop slipping past the route-level admission
	// check (which should have buffered this message). ensureNarrator reuses the live
	// `active`, so starting a second runAgentLoop here would corrupt the shared session.
	// Throw BEFORE persisting the user message so we never leave a half-applied turn.
	if (active._loopRunning) {
		logger.warn("feedMessage blocked: loop already running", { narratorId });
		// Correct a stale idle status so the user regains the interrupt button.
		await reconcileRunningStatus(narratorId);
		throw new ValidationError("Narrator is already running");
	}
	active._continuationSuppressed = false;
	active._continuationStallCount = 0;
	active._continuationStallKey = undefined;
	// Record the user who triggered this turn → flows into ToolContext.userId for knowledge ACL.
	active._currentUserId = userId ?? null;
	// Open the one-shot behavior-fence edit window for this user turn. It is consumed by the
	// first behavior_fence write and cleared once the first tool call completes, so the agent
	// can only record a fence on its first tool call and only when the user asked for it.
	grantBehaviorFenceEdit(narratorId);

	// Save text files to worktree (now that we have active.cwd)
	const savedTextFiles: TextFileRef[] = [];
	if (rawTextFiles?.length) {
		for (const file of rawTextFiles) {
			savedTextFiles.push(await saveTextFileToWorktree(active.cwd, file));
		}
	}

	const persistBlocks: Array<
		| { type: "text"; text: string }
		| PersistedUserImageBlock
		| { type: "text_file"; filename: string; size: number; filePath: string }
	> = [];
	if (images?.length) {
		for (const img of images) {
			persistBlocks.push(imageRefToContentBlock(img));
		}
	}
	if (savedTextFiles.length > 0) {
		for (const tf of savedTextFiles) {
			persistBlocks.push({
				type: "text_file",
				filename: tf.filename,
				size: tf.size,
				filePath: tf.filePath,
			});
		}
	}
	// NOTE: persistBlocks stores the raw user text (without attached_files hint) so that
	// contentJson reflects what the user actually typed. The effectivePrompt (with hint)
	// is stored in contentText and sent to the AI. This intentional split means:
	//   - contentJson (blocks) → frontend display, shows original user input
	//   - contentText → FTS search index + AI prompt, includes file references
	persistBlocks.push({ type: "text", text: prompt });

	// When the user sends images without text, inject a placeholder so that
	// providers that gate on non-empty content still include the image blocks.
	const effectiveText = !prompt.trim() && images?.length ? "[user sent image(s)]" : prompt;

	// Build the effective prompt with attached file hints
	const effectivePrompt = effectiveText + buildAttachedFilesHint(savedTextFiles);

	const userMsg = await narratorService.persistUserMessage(
		narratorId,
		effectivePrompt,
		persistBlocks,
		commandText,
		userId,
		origin,
	);

	active._lastTokenUsage = undefined;
	active._ttftMs = undefined;
	active._turnStartedAt = internalOptions?.preserveTurnStart
		? (internalOptions.turnStartedAt ?? new Date().toISOString())
		: new Date().toISOString();

	// --- Resolve manual_override if active (legacy implicit path) ---
	// When the user sends a message directly on a subagent page while the parent
	// narrator is blocked in waitForManualOverride, we must resolve that Promise
	// first. Otherwise the parent stays blocked forever while the subagent runs
	// independently via narrator-session. We also register a ConclusionWatcher so
	// the parent's tool_call result is updated when this independent run finishes.
	//
	// EXCEPTION — explicit takeover: while taken over, the parent intentionally
	// stays blocked for the entire takeover. The user can send/interrupt/continue
	// freely; the result is only handed back when the user stops takeover. So we
	// do NOT resolve the override or register a watcher here. We still set up the
	// conclusion file for explore/plan subagents so Write/Edit redirect works.
	const narrator = await narratorService.getById(narratorId);
	if (isSubagentVariant(narrator.variant) && narrator.parentNarratorId) {
		const currentSubstatus = parseSubstatus(narrator.substatus);
		const takenOver = isTakenOver(narratorId);
		if (takenOver) {
			if (isReadOnlySubagentVariant(narrator.variant)) {
				setConclusionFileId(narratorId, generateWordSlug(), active.cwd);
			}
			// Parent stays blocked — do not resolve, do not register a watcher.
		} else if (currentSubstatus.includes("manual_override")) {
			const overrideEntry = getManualOverrideMap().get(narratorId);
			if (overrideEntry) {
				const currentFinalText = await getSubagentFinalText(narratorId);

				// Set up conclusion file for explore/plan subagents so that
				// Write/Edit are properly redirected during the takeover run.
				if (isReadOnlySubagentVariant(narrator.variant)) {
					setConclusionFileId(narratorId, generateWordSlug(), active.cwd);
				}

				registerConclusionWatcher(
					narratorId,
					overrideEntry.parentNarratorId,
					overrideEntry.toolUseId,
				);
				resolveManualOverride(narratorId, currentFinalText, false);
			}
		}
	}

	await narratorService.updateStatus(
		narratorId,
		"working",
		internalOptions?.preserveTurnStart
			? {
					turnStartedAt: active._turnStartedAt,
					resumeTurn: true,
				}
			: { setTurnStart: true },
	);
	// The user message above is already persisted, so "first turn" means exactly one
	// user message exists. `messageCount` cannot answer this any more — it now counts
	// every message, not finished turns.
	if (!narrator.title && (await isFirstUserTurn(narratorId))) {
		active._provisionalTitle =
			(await setProvisionalTitleFromUserMessage(narratorId, prompt)) ?? undefined;
		generateQuickTitle(narratorId, prompt, locale).catch(() => {});
	}

	// runBashFirst flow: after persisting the user message, run the Bash command as
	// an assistant tool card, then start the loop with empty text. buildHistory
	// reconstructs the Bash tool_result as the current user turn, so the model sees
	// the order: user prompt → Bash tool call/result → model reply.
	if (preBashCommand) {
		// Broadcast the persisted user message before Bash starts. In chunk mode the
		// frontend renders directly from WS events (not the query optimistic cache),
		// so delaying this until sendMessage() returns would show the Bash card first.
		broadcastToNarrator(narratorId, {
			type: "user_message",
			narratorId,
			message: userMsg,
		});
		await handleBashCommand(
			narratorId,
			preBashCommand,
			`/bash ${preBashCommand}`,
			userId ?? undefined,
			{
				skipUserMessage: true,
				signal: active.abortController.signal,
			},
		);
		runAgentLoop(active, "", undefined).catch(async (err) => {
			const diagnostics = diagnosticsFromError(err);
			logger.error("runAgentLoop unhandled error", { narratorId, error: String(err), diagnostics });
			await narratorService.updateStatus(narratorId, "idle", {
				substatus: ["error"],
				errorMessage: String(err),
				diagnostics,
			});
			broadcastToNarrator(narratorId, {
				type: "narrator_error",
				narratorId,
				error: String(err),
				diagnostics,
			});
		});
		return { active, userMsg, userBroadcasted: true };
	}

	// Start agent loop in background
	runAgentLoop(active, effectivePrompt, images).catch(async (err) => {
		const diagnostics = diagnosticsFromError(err);
		logger.error("runAgentLoop unhandled error", { narratorId, error: String(err), diagnostics });
		await narratorService.updateStatus(narratorId, "idle", {
			substatus: ["error"],
			errorMessage: String(err),
			diagnostics,
		});
		broadcastToNarrator(narratorId, {
			type: "narrator_error",
			narratorId,
			error: String(err),
			diagnostics,
		});
	});

	return { active, userMsg };
}

// === Subagent conclusion helpers ===

/**
 * Extract the final text from a subagent's last assistant message.
 * Used when resolving suspended subagents or updating conclusions.
 */
export async function getSubagentFinalText(narratorId: string): Promise<string> {
	// Look back across any compact boundary for the last assistant text. This must
	// NOT use getModelHistorySinceLastCompact: a compact that completes right before
	// the subagent stops leaves the compact marker at the tail with no post-compact
	// assistant message, so that query would return empty and yield "(no output)"
	// even though the agent produced a real answer just before the compact.
	const latest = await narratorService.getLatestAssistantTextAndId(narratorId);
	if (latest?.text.trim()) return latest.text;

	// No assistant text at all (e.g. the run ended immediately after an emergency
	// compact). Fall back to the most recent successful compact summary, which is
	// the best available description of what the subagent did.
	const compactSummary = await narratorService
		.getLatestSuccessfulCompactSummary(narratorId)
		.catch(() => null);
	if (compactSummary?.summary.trim()) return compactSummary.summary;

	return "(no output)";
}

/**
 * Get the ID of the subagent's last assistant message.
 * Used to bind tool call results to a specific subagent message.
 */
export async function getSubagentResultMessageId(narratorId: string): Promise<string | undefined> {
	// Cross the compact boundary for the same reason as getSubagentFinalText: a
	// compact finishing just before the subagent stops must not orphan the tool
	// result from the assistant message that produced it.
	const latest = await narratorService.getLatestAssistantTextAndId(narratorId);
	if (latest) return latest.id;

	// No assistant text — bind to the most recent compact marker instead so the
	// tool result still points at a real, navigable message.
	const compactSummary = await narratorService
		.getLatestSuccessfulCompactSummary(narratorId)
		.catch(() => null);
	return compactSummary?.id;
}

function parsePersistedToolTime(value: string | number | Date | null | undefined): number | null {
	if (value == null) return null;
	const time =
		value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
	return Number.isFinite(time) ? time : null;
}

interface ToolCallConclusionTimingSource {
	streamStartedAt?: string | number | Date | null;
	createdAt?: string | number | Date | null;
	permissionStartedAt?: string | number | Date | null;
	executionStartedAt?: string | number | Date | null;
}

/** Calculate final timing when an automatic conclusion handoff completes. */
export function resolveToolCallConclusionTiming(
	existingToolCall: ToolCallConclusionTimingSource | null | undefined,
	now = Date.now(),
): { completedAt: number; durationMs: number } {
	const startedAt =
		parsePersistedToolTime(existingToolCall?.streamStartedAt) ??
		parsePersistedToolTime(existingToolCall?.createdAt) ??
		parsePersistedToolTime(existingToolCall?.permissionStartedAt) ??
		parsePersistedToolTime(existingToolCall?.executionStartedAt);
	return {
		completedAt: now,
		durationMs: startedAt != null ? Math.max(0, now - startedAt) : 0,
	};
}

/**
 * Update the parent narrator's tool_call outputJson with a new conclusion.
 * Used for scenario 2 (conclusion watcher) and the update-conclusion API.
 */
export async function updateToolCallConclusion(opts: {
	subagentId: string;
	parentNarratorId: string;
	toolUseId: string;
	finalText: string;
	hasError: boolean;
	/** Pass after copy-on-write to scope the update to the private message copy. */
	messageId?: string;
	/** The subagent assistant message that produced this result. */
	resultMessageId?: string;
	/**
	 * Re-finalize execution timing at this conclusion handoff. Defaults to false so
	 * manual/third-party conclusion text updates preserve the original execution timing.
	 */
	refreshTiming?: boolean;
}): Promise<void> {
	const {
		subagentId,
		parentNarratorId,
		toolUseId,
		finalText,
		hasError,
		messageId,
		resultMessageId,
		refreshTiming = false,
	} = opts;
	const resultPrefix = agentResultTag(await resolveAgentLabel(parentNarratorId, subagentId));
	const output = await appendSubagentFileChanges(
		parentNarratorId,
		null,
		resultPrefix + (finalText || "(no output)"),
	);
	const timing = refreshTiming
		? resolveToolCallConclusionTiming(await narratorService.getToolCallByToolUseId(toolUseId))
		: undefined;

	await narratorService.updateToolCallResult(
		toolUseId,
		{
			output,
			status: hasError ? "fail" : "success",
			errorMessage: hasError ? finalText : undefined,
			resultMessageId,
			...(timing ?? { preserveTiming: true }),
		},
		messageId,
	);
	// Broadcast to parent narrator so the frontend can update the SubagentCard
	broadcastToNarrator(parentNarratorId, {
		type: "subagent_conclusion_updated",
		narratorId: parentNarratorId,
		subagentNarratorId: subagentId,
		toolUseId,
		output,
		hasError,
		...timing,
	});
}

// === Public API ===

/**
 * Send a message to a narrator (fire-and-forget).
 * Persists the user message, broadcasts it via WS, kicks off the agent loop
 * in the background, and returns the persisted user message.
 * All streaming events are delivered exclusively via WebSocket.
 *
 * Parameter order (long positional tail — count carefully; passing a userId into
 * the `commandText` slot is a mistake that has already shipped once):
 *   1 narratorId, 2 prompt, 3 images, 4 locale, 5 replyInUserLanguage,
 *   6 commandText, 7 userId, 8 textFiles, 9 preBashCommand, 10 origin
 *
 * `origin` attributes the message when the caller is not a human typing into
 * this session (auto-continuation, IM gateway, scheduled tasks, AI-initiated
 * sends). It defaults to `"user"`, so human paths need not pass it.
 */
export async function sendMessage(
	narratorId: string,
	prompt: string,
	images?: ImageRef[],
	locale: Locale = "en",
	replyInUserLanguage = false,
	commandText?: string | null,
	userId?: string | null,
	textFiles?: File[],
	preBashCommand?: string | null,
	origin?: MessageOriginOptions,
): Promise<typeof narratorMessages.$inferSelect> {
	const narrator = await narratorService.getById(narratorId);
	if (isSubagentVariant(narrator.variant)) {
		throw new ValidationError("Subagent messages must be sent through resumeSubagent");
	}
	const { userMsg, userBroadcasted } = await feedMessage(
		narratorId,
		prompt,
		images,
		locale,
		replyInUserLanguage,
		commandText,
		userId,
		textFiles,
		preBashCommand,
		undefined,
		origin,
	);
	if (!userBroadcasted) {
		broadcastToNarrator(narratorId, {
			type: "user_message",
			narratorId,
			message: userMsg,
		});
	}
	return userMsg;
}

/**
 * Start the first execution turn for an explicit `/goal` after its protected
 * task has been persisted to Dynamic Spec. This deliberately bypasses an `off`
 * auto-continuation setting for the first turn only; later turns still respect
 * the configured mode through maybeStartContinuation().
 */
export async function startSpecContinuationIfPossible(
	narratorId: string,
	locale: Locale = "en",
	replyInUserLanguage = false,
	userId?: string | null,
): Promise<{ started: boolean }> {
	return continuationStartLock.acquire(narratorId, async () => {
		const activeExisting = activeNarrators.get(narratorId);
		if (activeExisting?.alive && activeExisting._loopRunning) return { started: false };

		const narrator = await narratorService.getById(narratorId);
		if (narrator.status !== "idle" || isPlanModeTrait(narrator.traits)) {
			return { started: false };
		}

		const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
		if (active._loopRunning) return { started: false };
		active._continuationSuppressed = false;
		active._continuationStallCount = 0;
		active._continuationStallKey = undefined;
		active._currentUserId = userId ?? active._currentUserId ?? null;
		active._lastTokenUsage = undefined;
		active._ttftMs = undefined;
		active._turnStartedAt = new Date().toISOString();

		const prompt = await maybeStartContinuation(active, false, {
			explicitStart: true,
		});
		if (!prompt) return { started: false };

		await narratorService.updateStatus(narratorId, "working", { setTurnStart: true });
		runAgentLoop(active, "").catch(async (err) => {
			logger.error("runAgentLoop unhandled error (spec continuation)", {
				narratorId,
				error: String(err),
			});
			await narratorService.updateStatus(narratorId, "idle", {
				substatus: ["error"],
				errorMessage: String(err),
			});
			broadcastToNarrator(narratorId, {
				type: "narrator_error",
				narratorId,
				error: String(err),
			});
		});
		return { started: true };
	});
}

export async function startBackgroundCompletionContinuationIfPossible(
	narratorId: string,
	locale: Locale = "en",
	replyInUserLanguage = false,
): Promise<{ started: boolean }> {
	return continuationStartLock.acquire(narratorId, async () => {
		const activeExisting = activeNarrators.get(narratorId);
		if (activeExisting?.alive && activeExisting._loopRunning) return { started: false };

		const narrator = await narratorService.getById(narratorId);
		if (narrator.status !== "idle") return { started: false };
		// Plan-mode narrators are not auto-woken, matching goal and inbound continuation.
		// This check was missing here while the other three entries had it, so a finished
		// background task could pull a narrator out of planning and into execution.
		// Declining to wake loses nothing: the notification stays queued for the next
		// drain (the queue is only emptied by a path that delivers it).
		if (isPlanModeTrait(narrator.traits)) return { started: false };

		const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
		if (active._loopRunning) return { started: false };

		const prompt = await drainAndPersistPendingInjections(active);
		if (!prompt) return { started: false };

		active._continuationSuppressed = false;
		active._continuationStallCount = 0;
		active._continuationStallKey = undefined;
		active._lastTokenUsage = undefined;
		active._ttftMs = undefined;
		active._turnStartedAt = new Date().toISOString();

		await narratorService.updateStatus(narratorId, "working", { setTurnStart: true });
		runAgentLoop(active, "").catch(async (err) => {
			logger.error("runAgentLoop unhandled error (background completion)", {
				narratorId,
				error: String(err),
			});
			await narratorService.updateStatus(narratorId, "idle", {
				substatus: ["error"],
				errorMessage: String(err),
			});
			broadcastToNarrator(narratorId, {
				type: "narrator_error",
				narratorId,
				error: String(err),
			});
		});
		return { started: true };
	});
}

/**
 * Start a turn for content that has ALREADY been persisted as a message row.
 *
 * The wake half of `deliverInjection`'s `schedule: "wakeIfIdle"`. It exists so that
 * module never holds its own copy of the gating rules, which the three older
 * continuation entries above each spell out again:
 *
 *   - the continuation lock, so two producers cannot race a narrator into two loops
 *   - idle in BOTH senses: no live in-memory loop and a persisted `idle` status
 *   - not in plan mode
 *
 * That last check is the one `startBackgroundCompletionContinuationIfPossible` is
 * missing while the other two have it. Fixing it there is a behaviour change and
 * belongs with the background-completion migration, so this function simply starts out
 * with the stricter rule that the majority already follow.
 *
 * `runAgentLoop(active, "")` is the established spelling for "the turn's content is
 * already in the database, let buildHistory find it" — the same call the goal and
 * inbound continuations make.
 */
export async function startInjectionContinuationIfPossible(
	narratorId: string,
	locale: Locale = "en",
	replyInUserLanguage = false,
): Promise<{ started: boolean }> {
	return continuationStartLock.acquire(narratorId, async () => {
		const activeExisting = activeNarrators.get(narratorId);
		if (activeExisting?.alive && activeExisting._loopRunning) return { started: false };

		const narrator = await narratorService.getById(narratorId);
		if (narrator.status !== "idle") return { started: false };
		if (isPlanModeTrait(narrator.traits)) return { started: false };

		const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
		if (active._loopRunning) return { started: false };

		active._continuationSuppressed = false;
		active._continuationStallCount = 0;
		active._continuationStallKey = undefined;
		active._lastTokenUsage = undefined;
		active._ttftMs = undefined;
		active._turnStartedAt = new Date().toISOString();

		await narratorService.updateStatus(narratorId, "working", { setTurnStart: true });
		runAgentLoop(active, "").catch(async (err) => {
			logger.error("runAgentLoop unhandled error (injection)", {
				narratorId,
				error: String(err),
			});
			await narratorService.updateStatus(narratorId, "idle", {
				substatus: ["error"],
				errorMessage: String(err),
			});
			broadcastToNarrator(narratorId, {
				type: "narrator_error",
				narratorId,
				error: String(err),
			});
		});
		return { started: true };
	});
}

/**
 * Drain a narrator's queued messages once no runtime owner is left to consume them.
 *
 * Every ordinary path hands the queue to a loop: `runAgentLoop` consumes it at its
 * own boundaries, and the recovery stages that drive a loop-less narrator all finish
 * by calling `continueNarrator`, whose loop then drains it.
 *
 * One path does not. Planned-update recovery skips owner continuation when the epoch
 * holds background Agents only (`deliverRecoveredMessageOwner`), because a background
 * task keeps running on its own and the parent has nothing to resume. Messages queued
 * during that window would then sit untouched until the user acted again — and they
 * are queued now precisely because the recovery claim made the narrator look busy.
 *
 * Deliberately conservative: it never competes with a live owner, never wakes a
 * plan-mode narrator (mirroring goal/inbound continuation), and repairs a status row
 * that outlived recovery before starting anything.
 */
export async function resumeBufferedMessagesIfIdle(
	narratorId: string,
	locale: Locale = "en",
	replyInUserLanguage = false,
): Promise<{ resumed: boolean }> {
	if ((bufferedMessages.get(narratorId)?.length ?? 0) === 0) return { resumed: false };
	return continuationStartLock.acquire(narratorId, async () => {
		if ((bufferedMessages.get(narratorId)?.length ?? 0) === 0) return { resumed: false };
		// A live loop (or any other runtime owner) will consume the queue itself.
		if (isNarratorRuntimeBusy(narratorId)) return { resumed: false };

		// Recovery left the row at `working` with nobody behind it; drop it to idle so
		// the resumed turn transitions honestly instead of stacking onto a zombie.
		await reconcileRunningStatus(narratorId);

		const narrator = await narratorService.getById(narratorId);
		if (isSubagentVariant(narrator.variant)) return { resumed: false };
		if (narrator.status !== "idle") return { resumed: false };
		if (isPlanModeTrait(narrator.traits)) return { resumed: false };

		const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
		if (active._loopRunning) return { resumed: false };

		resumeNextBufferedMessage(active, locale);
		return { resumed: true };
	});
}

/**
 * Wake an idle parent narrator to consume progress reports sent by its child
 * subagents via Send({ id: "parent" }). A working/waiting parent drains the
 * queue at its next after_tools sidecar boundary, so this only acts on idle
 * narrators. Plan-mode narrators are not auto-woken (mirrors goal continuation)
 * — the message stays queued until their next activity.
 *
 * Reuses continuationStartLock so it cannot race the background-task
 * completion continuation into starting two concurrent loops.
 */
export async function startParentInboundContinuationIfPossible(
	narratorId: string,
	locale: Locale = "en",
	replyInUserLanguage = false,
): Promise<{ started: boolean }> {
	return continuationStartLock.acquire(narratorId, async () => {
		const activeExisting = activeNarrators.get(narratorId);
		if (activeExisting?.alive && activeExisting._loopRunning) return { started: false };

		const narrator = await narratorService.getById(narratorId);
		if (narrator.status !== "idle") return { started: false };
		// Plan-mode narrators are not auto-woken; leave the report queued.
		if (isPlanModeTrait(narrator.traits)) return { started: false };

		const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
		if (active._loopRunning) return { started: false };

		const delivered = await drainAndPersistPendingInjections(active);
		if (!delivered) return { started: false };

		active._continuationSuppressed = false;
		active._continuationStallCount = 0;
		active._continuationStallKey = undefined;
		active._lastTokenUsage = undefined;
		active._ttftMs = undefined;
		active._turnStartedAt = new Date().toISOString();

		await narratorService.updateStatus(narratorId, "working", { setTurnStart: true });
		runAgentLoop(active, "").catch(async (err) => {
			logger.error("runAgentLoop unhandled error (subagent message)", {
				narratorId,
				error: String(err),
			});
			await narratorService.updateStatus(narratorId, "idle", {
				substatus: ["error"],
				errorMessage: String(err),
			});
			broadcastToNarrator(narratorId, {
				type: "narrator_error",
				narratorId,
				error: String(err),
			});
		});
		return { started: true };
	});
}

/**
 * How many trailing top-level messages `retryLastMessage` inspects while looking
 * for its target. Bounded so the query stays a small indexed read: a real
 * assistant reply stops the scan at the first row, and only empty placeholders
 * extend it.
 */
const RETRY_TAIL_SCAN_LIMIT = 10;

/** Minimal message shape needed to pick the retry target. */
interface RetryCandidateMessage {
	id: string;
	role: string;
	contentJson?: unknown;
	toolCalls?: Array<unknown> | null;
}

/**
 * True when an assistant message carries no persisted output at all: no content
 * blocks and no tool calls.
 *
 * Such rows are placeholders created by `createPartialAssistantMessage` (see
 * narrator-event-handler `block_complete`) whose run died before any block was
 * committed — a crash, a lost stream, or a provider error that bypassed
 * `finalizeOrCleanupPartialMessage`. They are invisible in the UI, so a retry
 * must look through them instead of treating them as a real reply.
 */
function isEmptyAssistantPlaceholder(msg: RetryCandidateMessage): boolean {
	if (msg.role !== "assistant") return false;
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	if (blocks.length > 0) return false;
	return !msg.toolCalls || msg.toolCalls.length === 0;
}

/**
 * Resolve the retry target from the tail of a narrator's top-level history
 * (oldest → newest).
 *
 * Walks backwards past empty assistant placeholders (see
 * {@link isEmptyAssistantPlaceholder}) and returns the trailing user message
 * plus the placeholder ids that shadow it. An assistant message with real
 * content stops the walk: that turn produced output, so re-running the previous
 * user prompt would silently discard it — the user wants "continue" there.
 */
export function resolveRetryTarget<T extends RetryCandidateMessage>(
	messages: T[],
): { target: T; emptyAssistantIds: string[] } | { target: null; reason: "empty" | "not_user" } {
	if (messages.length === 0) return { target: null, reason: "empty" };

	const emptyAssistantIds: string[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "user") return { target: msg, emptyAssistantIds };
		if (!isEmptyAssistantPlaceholder(msg)) return { target: null, reason: "not_user" };
		emptyAssistantIds.push(msg.id);
	}
	// Every message in range was an empty assistant placeholder.
	return { target: null, reason: "empty" };
}

/**
 * Retry the last user message without creating a new message record.
 * Deletes any assistant/error response that followed the last user message,
 * then re-runs the agent loop with the existing user message text.
 */
export async function retryLastMessage(
	narratorId: string,
	locale: Locale = "en",
	replyInUserLanguage = false,
	userId?: string | null,
): Promise<{ ok: boolean }> {
	const narrator = await narratorService.getById(narratorId);
	// Guard before any destructive work (deleteMessagesAfter below): if a loop is
	// already running, refuse rather than mutate history under a live session.
	if (isLoopRunning(narratorId)) {
		logger.warn("retryLastMessage blocked: loop already running", { narratorId });
		// Correct a stale idle status so the user regains the interrupt button.
		await reconcileRunningStatus(narratorId);
		return { ok: false };
	}
	if (isSubagentVariant(narrator.variant)) {
		throw new ValidationError("Subagent retries must be sent through resumeSubagent");
	}

	// Read a short tail of top-level messages (newest first) so the retry target
	// can be resolved past empty assistant placeholders. A handful of rows is
	// enough: a real assistant reply stops the walk immediately, and consecutive
	// placeholders are rare.
	const tailRefs = await db
		.select({
			messageId: narratorMessageRefs.messageId,
			seq: narratorMessageRefs.seq,
		})
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				isNull(narratorMessageRefs.segmentCompactId),
				isNull(narratorMessages.parentToolUseId),
				inArray(narratorMessages.role, ["user", "assistant"]),
			),
		)
		.orderBy(sql`${narratorMessageRefs.seq} DESC`)
		.limit(RETRY_TAIL_SCAN_LIMIT);

	if (!tailRefs.length) {
		// A ValidationError, not a NotFoundError: the narrator exists and was found, it
		// just has nothing to retry. Passing this sentence as a NotFoundError `entity`
		// also fed it into the catalog's "{entity} not found: {id}" template, which in a
		// localized UI produced "未找到No messages to retry：<id>".
		throw new ValidationError("No messages to retry");
	}

	const tailMessages = await db.query.narratorMessages.findMany({
		where: inArray(
			narratorMessages.id,
			tailRefs.map((ref) => ref.messageId),
		),
		with: { toolCalls: { columns: { id: true } } },
	});
	const tailById = new Map(tailMessages.map((msg) => [msg.id, msg]));
	// resolveRetryTarget expects oldest → newest; tailRefs is newest first.
	const orderedTail = tailRefs
		.map((ref) => tailById.get(ref.messageId))
		.filter((msg): msg is NonNullable<typeof msg> => msg != null)
		.reverse();

	const resolved = resolveRetryTarget(orderedTail);
	if (!resolved.target) {
		throw new ValidationError(
			resolved.reason === "empty" ? "No messages to retry" : "Last message is not a user message",
		);
	}
	const lastMsg = resolved.target;

	const prompt = lastMsg.contentText ?? "";
	if (!prompt.trim()) {
		throw new ValidationError("Last user message has no text");
	}

	if (resolved.emptyAssistantIds.length > 0) {
		logger.info("retryLastMessage skipping empty assistant placeholders", {
			narratorId,
			targetMessageId: lastMsg.id,
			placeholderCount: resolved.emptyAssistantIds.length,
		});
	}

	// Delete any messages after the last user message (old assistant responses,
	// including the empty placeholders the walk above looked through).
	const { deletedMessageIds } = await narratorService.deleteMessagesAfter(narratorId, lastMsg.id);
	if (deletedMessageIds.length > 0) {
		broadcastToNarrator(narratorId, {
			type: "messages_deleted",
			narratorId,
			deletedMessageIds,
		});
	}

	const imageRefs = extractImageRefs(lastMsg.contentJson, lastMsg.narratorId);

	const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
	// Restore the triggering user so knowledge-base ACL works after a rebuild.
	active._currentUserId = userId ?? active._currentUserId ?? null;
	await narratorService.updateStatus(narratorId, "working", { setTurnStart: true });

	runAgentLoop(active, prompt, imageRefs.length > 0 ? imageRefs : undefined).catch(async (err) => {
		logger.error("runAgentLoop unhandled error (retry)", { narratorId, error: String(err) });
		await narratorService.updateStatus(narratorId, "idle", {
			substatus: ["error"],
			errorMessage: String(err),
		});
		broadcastToNarrator(narratorId, {
			type: "narrator_error",
			narratorId,
			error: String(err),
		});
	});

	return { ok: true };
}

/**
 * Continue the agent loop.
 *
 * If the last top-level message is a tool-call assistant turn, resumes by
 * reconstructing the tool-result upload packet (buildHistory produces
 * trailingToolResults).
 *
 * Otherwise (e.g. the assistant's text reply was truncated), sends a
 * locale-aware "please continue" user message via feedMessage so the
 * model receives a properly localised prompt.
 */
export async function continueNarrator(
	narratorId: string,
	locale: Locale = "en",
	replyInUserLanguage = false,
	userId?: string | null,
): Promise<{ ok: boolean }> {
	const narrator = await narratorService.getById(narratorId);
	if (isSubagentVariant(narrator.variant)) {
		throw new ValidationError("Subagent continuation must be sent through resumeSubagent");
	}
	// If the last top-level message is a tool-call assistant turn, replay the
	// tool-result request packet instead of appending a textual "continue".
	const rawMsgs = await narratorService.getModelHistorySinceLastCompact(narratorId);

	const continueTiming = resolveContinueTurnTiming({
		substatus: parseSubstatus(narrator.substatus),
		turnStartedAt: narrator.turnStartedAt,
		nowMs: Date.now(),
	});
	// Guard: refuse to continue while a loop is already running (authoritative
	// in-memory check, independent of a possibly-stale DB status).
	if (isLoopRunning(narratorId)) {
		logger.warn("continueNarrator blocked: loop already running", { narratorId });
		// Correct a stale idle status so the user regains the interrupt button.
		await reconcileRunningStatus(narratorId);
		return { ok: false };
	}
	// A turn that died after streaming thinking leaves a reasoning-only assistant
	// record as the tail. Look past those first: judging the tail without doing so
	// misreads a preceding tool-call turn as "nothing to replay" and degrades the
	// continuation into a plain "continue" message that abandons its tool results.
	const { tail: lastTopLevelMessage, danglingReasoningIds } = resolveContinuationTail(rawMsgs);
	const shouldReplayToolResults = shouldReplayToolResultPacket(lastTopLevelMessage);

	// Drop the dangling records before rebuilding the request. buildHistory reads
	// the DB again, so leaving them in place would put the reasoning-only turn back
	// at the end of the provider history — the exact shape that makes an upstream
	// reject a tool-result-only packet. Deleting is safe: they hold no answer text
	// and no tool call (see isDanglingReasoningOnlyAssistantMessage), and they carry
	// no file changes, so the workspace must NOT be rolled back with them.
	if (shouldReplayToolResults && danglingReasoningIds.length > 0) {
		const deletedMessageIds: string[] = [];
		for (const messageId of danglingReasoningIds) {
			try {
				const removed = await narratorService.deleteDanglingReasoningMessage(narratorId, messageId);
				if (removed) deletedMessageIds.push(messageId);
			} catch (err) {
				logger.warn("Failed to drop dangling reasoning message before continue", {
					narratorId,
					messageId,
					error: String(err),
				});
			}
		}
		if (deletedMessageIds.length > 0) {
			logger.info("Dropped dangling reasoning tail before continuing tool results", {
				narratorId,
				count: deletedMessageIds.length,
			});
			broadcastToNarrator(narratorId, {
				type: "messages_deleted",
				narratorId,
				deletedMessageIds,
			});
		}
	}

	// A trailing injection already IS the turn's content (see hasTrailingInjectionRow), so
	// it is continued by starting a loop with empty text — exactly like a tool-result
	// replay, and unlike the synthetic "continue" row below, which would push the
	// injection out of the trailing position the history builders depend on.
	const trailingInjection = !shouldReplayToolResults && hasTrailingInjectionRow(rawMsgs);

	if (!shouldReplayToolResults && !trailingInjection) {
		// No pending tool calls and no fresh injection — send a simple "continue" user message.
		const continueText = getToolMessage("userContinue", locale);
		const { userMsg } = await feedMessage(
			narratorId,
			continueText,
			undefined,
			locale,
			replyInUserLanguage,
			null,
			userId,
			undefined,
			undefined,
			continueTiming.preserveTurnStart
				? {
						preserveTurnStart: true,
						turnStartedAt: continueTiming.turnStartedAt,
					}
				: undefined,
		);
		broadcastToNarrator(narratorId, {
			type: "user_message",
			narratorId,
			message: userMsg,
		});
		return { ok: true };
	}

	const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
	// Restore the triggering user so knowledge-base ACL works after a rebuild
	// (interrupt may have destroyed the prior active, leaving _currentUserId unset).
	active._currentUserId = userId ?? active._currentUserId ?? null;
	active._lastTokenUsage = undefined;
	active._ttftMs = undefined;
	active._turnStartedAt = continueTiming.preserveTurnStart
		? continueTiming.turnStartedAt
		: new Date().toISOString();
	await narratorService.updateStatus(
		narratorId,
		"working",
		continueTiming.preserveTurnStart
			? { turnStartedAt: active._turnStartedAt, resumeTurn: true }
			: { setTurnStart: true },
	);

	// Pass empty text — buildHistory reconstructs the turn's content itself: the trailing
	// tool-result packet, or (for an injection tail) the trailing `sys` run lifted into
	// the current turn.
	runAgentLoop(active, "", undefined).catch(async (err) => {
		logger.error("runAgentLoop unhandled error (continue)", { narratorId, error: String(err) });
		await narratorService.updateStatus(narratorId, "idle", {
			substatus: ["error"],
			errorMessage: String(err),
		});
		broadcastToNarrator(narratorId, {
			type: "narrator_error",
			narratorId,
			error: String(err),
		});
	});

	return { ok: true };
}

/**
 * Tool calls that are not real executable tools (control / UI tools) and must
 * never be re-executed via the "allow and execute" path. ExitPlanMode and
 * AskUserQuestion are interactive control tools handled inside the loop; the
 * rest carry no file/side effects worth replaying.
 */
const NON_RERUNNABLE_TOOL_NAMES = new Set([
	"ExitPlanMode",
	"EnterPlanMode",
	"AskUserQuestion",
	"StartPipeline",
	"ExtractPipeline",
	// Legacy persisted calls remain non-rerunnable after EndPipeline removal.
	"EndPipeline",
]);

/** permissionDecidedBy values that mark a tool call as "stopped at the permission gate". */
const RERUNNABLE_DECIDED_BY = new Set(["user", "aborted"]);

export type ReExecuteDeniedReason =
	| "not_found"
	| "not_denied"
	| "not_latest_turn"
	| "not_rerunnable_tool"
	| "narrator_busy";

export type ReExecuteDeniedResult =
	| { ok: true; shouldContinue?: boolean }
	| { ok: false; reason: ReExecuteDeniedReason };

function disposeInactiveNarratorSession(narratorId: string, active: ActiveNarrator): void {
	if (active._gitTrackTimer) clearTimeout(active._gitTrackTimer);
	if (active._worktreePath) {
		worktreeWatcher.unwatch(active._worktreePath, narratorId);
	}
	persistConversationIdIfUnchanged(narratorId, active, "inactive narrator session");
	active._preparedPlanModes?.clear();
	activeNarrators.delete(narratorId);
	planModeAskedOnce.delete(narratorId);
	clearStreamingSnapshot(narratorId);
	active.abortController.abort();
	active.events.emit("event", { type: "done", data: null });
	active.events.removeAllListeners();
	for (const [key, permission] of pendingPermissions) {
		if (permission.narratorId !== narratorId) continue;
		try {
			permission.cleanup();
		} catch (err) {
			logger.debug("Failed to clean up inactive narrator permission", {
				narratorId,
				toolCallId: key,
				error: String(err),
			});
		}
		pendingPermissions.delete(key);
	}
	pendingFeedback.delete(narratorId);
	pendingPlanCompact.delete(narratorId);
	pendingPlanApprover.delete(narratorId);
	pendingPlanApproverSource.delete(narratorId);
	pendingPlanDiff.delete(narratorId);
	active._bashBeforeStatus?.clear();
}

/**
 * Column values that re-arm a tool-call row for another execution attempt.
 *
 * `status` returns to "initializing", not "pending": a re-run starts a brand-new
 * permission cycle, and "initializing" means exactly "the tool call exists but
 * permission handling has not begun". That keeps the persistence-layer frozen-target
 * guard in its `mayRefineBeforeApproval` branch, so the executor may legitimately
 * re-freeze the execution identity it is actually going to use. Resetting to "pending"
 * instead closes that window and turns any environment drift (for example a remote
 * device that reports a different defaultCwd after reconnecting) into
 * "already frozen ... after permission handling has begun".
 *
 * handlePermission moves the row to "pending" again before any user-facing request,
 * so the visible lifecycle is unchanged.
 */
export const TOOL_CALL_RERUN_RESET_FIELDS = {
	status: "initializing" as const,
	outputJson: null,
	errorMessage: null,
	permissionDenyMessage: null,
	permissionDecidedBy: null,
	permissionDecidedAt: null,
	permissionDecisionReason: null,
	permissionSuggestions: null,
	completedAt: null,
	durationMs: null,
	executionStartedAt: null,
};

/**
 * Pure precondition check for re-executing a denied tool call. Returns null when
 * the tool call may be re-run, or a failure reason otherwise. Kept separate from
 * the DB/execution side effects so the decision logic is unit-testable.
 */
export function evaluateRerunnableToolCall(
	toolCall: {
		toolName: string;
		status: string;
		permissionDecidedBy?: string | null;
		messageId: string;
	} | null,
	latestAssistantMessageId: string | null,
): ReExecuteDeniedReason | null {
	if (!toolCall) return "not_found";
	if (NON_RERUNNABLE_TOOL_NAMES.has(toolCall.toolName)) return "not_rerunnable_tool";
	// Only tool calls stopped at the permission gate (user deny or interrupt-
	// cancelled) are safe to re-run: they never executed, so there is no partial
	// side effect to worry about.
	if (
		toolCall.status !== "fail" ||
		!toolCall.permissionDecidedBy ||
		!RERUNNABLE_DECIDED_BY.has(toolCall.permissionDecidedBy)
	) {
		return "not_denied";
	}
	// The tool call must belong to the latest top-level assistant message so
	// re-running it does not reorder history relative to later turns.
	if (!latestAssistantMessageId || latestAssistantMessageId !== toolCall.messageId) {
		return "not_latest_turn";
	}
	return null;
}

/**
 * Re-execute a tool call that was denied by the user (or whose pending
 * permission was cancelled by an interrupt) in the latest assistant turn.
 *
 * The denied tool_use block is still present in the assistant message's
 * contentJson, and its tool_result is reconstructed from the narrator_tool_calls
 * row at history-build time. So "un-denying" a tool only requires:
 *   1. reset the tool call row (fail → pending, clear deny/output fields),
 *   2. execute the tool directly with a pre-granted permission (the in-memory
 *      pendingPermissions entry is gone after the interrupt, so resolvePermission
 *      cannot be used),
 *   3. write the fresh result back into the row,
 *   4. continue the loop so the model sees the new result and resumes.
 */
export async function reExecuteDeniedToolCall(
	narratorId: string,
	toolUseId: string,
	locale: Locale = "en",
	replyInUserLanguage = false,
	userId?: string | null,
	options?: {
		autoContinue?: boolean;
		persistedToolCallId?: string;
		permissionMode?: "normal" | "preGranted";
	},
): Promise<ReExecuteDeniedResult> {
	const narrator = await narratorService.getById(narratorId);
	const restoringPersistedCall = Boolean(options?.persistedToolCallId);
	if (!restoringPersistedCall && (narrator.status === "working" || narrator.status === "waiting")) {
		return { ok: false, reason: "narrator_busy" };
	}
	if (!restoringPersistedCall && isNarratorActive(narratorId)) {
		// A live agent loop is still running for this narrator — refuse to avoid
		// racing the loop's own tool execution / history rebuild.
		// Correct a stale idle status so the user regains the interrupt button.
		await reconcileRunningStatus(narratorId);
		return { ok: false, reason: "narrator_busy" };
	}

	const toolCall = await db.query.narratorToolCalls.findFirst({
		where: options?.persistedToolCallId
			? and(
					eq(narratorToolCalls.id, options.persistedToolCallId),
					eq(narratorToolCalls.narratorId, narratorId),
				)
			: and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
	});

	// The tool call must belong to the latest top-level assistant message so
	// re-running it does not reorder history relative to later turns.
	const isSubagent = isSubagentVariant(narrator.variant);
	const lastRef = await db
		.select({ messageId: narratorMessageRefs.messageId })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				isSubagent ? undefined : isNull(narratorMessages.parentToolUseId),
				inArray(narratorMessages.role, ["user", "assistant"]),
			),
		)
		.orderBy(sql`${narratorMessageRefs.seq} DESC`)
		.limit(1);
	const latestAssistantMessageId = lastRef.length ? lastRef[0].messageId : null;

	const rejectReason = restoringPersistedCall
		? toolCall
			? null
			: "not_found"
		: evaluateRerunnableToolCall(toolCall ?? null, latestAssistantMessageId);
	if (rejectReason) {
		return { ok: false, reason: rejectReason };
	}
	// evaluateRerunnableToolCall guarantees toolCall is non-null past this point.
	if (!toolCall) return { ok: false, reason: "not_found" };

	const toolInput =
		toolCall.inputJson &&
		typeof toolCall.inputJson === "object" &&
		!Array.isArray(toolCall.inputJson)
			? (toolCall.inputJson as Record<string, unknown>)
			: {};

	// Reset the row so buildHistory no longer treats it as a completed failure.
	await db
		.update(narratorToolCalls)
		.set(TOOL_CALL_RERUN_RESET_FIELDS)
		.where(eq(narratorToolCalls.id, toolCall.id));

	const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
	// Restore the triggering user so knowledge-base ACL works after a rebuild.
	// The active may have been freshly recreated (interrupt destroyed the old one),
	// in which case _currentUserId would otherwise be undefined → null.
	active._currentUserId = userId ?? active._currentUserId ?? null;
	await narratorService.updateStatus(narratorId, "working", { setTurnStart: true });

	broadcastToNarrator(narratorId, {
		type: "tool_started",
		narratorId,
		toolCallId: toolCall.id,
		toolUseId,
		toolName: toolCall.toolName,
		input: toolInput,
	});

	const { executeTool } = await import("../lib/agent/tool-executor");
	const toolName = toolCall.toolName;

	// Minimal AgentConfig sufficient for executeTool. Nested permission requests
	// (e.g. narrafork-admin) still flow through the normal handler; the top-level
	// call is pre-granted because the user just explicitly allowed it.
	const config: import("../lib/agent").AgentConfig = {
		narratorId,
		conversationId: active.conversationId,
		model: active.model,
		provider: active.provider,
		cwd: active.cwd,
		locale,
		signal: active.abortController.signal,
		chapterId: active._chapterId,
		get planFileId() {
			return active._planFileId;
		},
		get planFilePath() {
			return active._planFilePath;
		},
		skillRoot: active._skillRoot ?? undefined,
		projectGitPath: active._projectGitPath ?? undefined,
		skillScopeKey: active._skillScopeKey ?? undefined,
		userId: active._currentUserId ?? null,
		projectId: active._projectId ?? null,
		defaultDeviceId: toolCall.executionDeviceId ?? active._defaultDeviceId ?? null,
		availableDevices: await resolveSessionDevices(active._projectId ?? null),
		setDefaultDevice: (deviceId) => applySessionDefaultDevice(narratorId, active, deviceId),
		disabledTools: active._disabledTools,
		blockedSkills: {
			all: active._blockedSkills.all,
			names: [...active._blockedSkills.names],
		},
		onExecutionTargetResolved: (resolvedToolUseId, target) =>
			narratorService.updateToolCallExecutionTarget(narratorId, resolvedToolUseId, target),
		onExecutionPlanResolved: (resolvedToolUseId, plan) =>
			narratorService.updateToolCallExecutionPlan(narratorId, resolvedToolUseId, plan),
		permissionHandler: (tName, input, tUseId, options) =>
			handlePermission(
				narratorId,
				active.abortController.signal,
				tName,
				input,
				tUseId,
				active.cwd,
				locale,
				undefined,
				options,
			),
		onEvent: (event) => {
			if (event.type === "tool_output") {
				broadcastToNarrator(narratorId, {
					type: "tool_output",
					narratorId,
					toolUseId: event.toolUseId,
					output: event.output,
				});
			} else if (event.type === "tool_progress") {
				broadcastToNarrator(narratorId, {
					type: "tool_progress",
					narratorId,
					toolUseId: event.toolUseId,
					elapsed: event.elapsed,
				});
			} else if (event.type === "tool_structured_progress") {
				broadcastToNarrator(narratorId, {
					type: "tool_structured_progress",
					narratorId,
					toolUseId: event.toolUseId,
					progress: event.progress,
				});
			} else if (event.type === "tool_long_running") {
				broadcastToNarrator(narratorId, {
					type: "tool_long_running",
					narratorId,
					toolUseId: event.toolUseId,
					elapsed: event.elapsed,
				});
			}
		},
	};

	// A re-run mutates files just like the original pass, so it must record the same
	// content-addressed boundaries the loop's onSnapshotBefore/After hooks record.
	const isShellTool = toolName === SHELL_TOOL_NAME;
	const requestedDevice =
		typeof toolInput.device === "string"
			? toolInput.device
			: (active._defaultDeviceId ?? LOCAL_DEVICE_ID);
	const canSnapshotRerun =
		active._isInGitRepo && FILE_MUTATING_TOOLS.has(toolName) && requestedDevice === LOCAL_DEVICE_ID;
	if (canSnapshotRerun) {
		// A re-run starts from whatever is on disk now, so the cached hash from the
		// original pass must not be reused as this run's baseline.
		active._lastTreeHash = undefined;
		// Same declaration rule as the loop hook: only a re-run that can name its
		// target up front gets its delta attributed by declaration.
		await recordTreeSnapshotBefore(
			active,
			narratorId,
			toolUseId,
			isShellTool ? null : declaredWorktreePaths(active.cwd, toolInput),
		);
	} else if (isShellTool && requestedDevice !== LOCAL_DEVICE_ID) {
		logger.debug("Skipping Bash rerun snapshot for remote execution target", {
			narratorId,
			toolUseId,
			deviceId: requestedDevice,
		});
	}

	// Reproduce the exact execution identity frozen on the original pass. It pins the
	// audit-only selectionSource (a local tool frozen as "local_default" would otherwise be
	// recomputed as "session_default" once defaultDeviceId is seeded with the frozen device
	// id, which the persistence-layer frozen-target guard rejects once the row has left
	// "initializing") and, for a pre-granted re-run, acts as the baseline that executeTool
	// compares against to detect environment drift. Legacy rows without a frozen device
	// fall back to normal resolution.
	const preFrozenTarget = reconstructToolExecutionTarget(toolCall);

	try {
		const result = await executeTool({ name: toolName, input: toolInput, toolUseId }, config, {
			...(options?.permissionMode === "normal"
				? {}
				: { preGrantedPermission: { behavior: "allow" as const } }),
			...(preFrozenTarget ? { preFrozenTarget } : {}),
		});

		await narratorService.updateToolCallResult(
			toolUseId,
			{
				output: result.metadata
					? { _text: result.output, _metadata: result.metadata }
					: result.output,
				status: result.isError ? "fail" : "success",
				errorMessage: result.isError ? result.output : undefined,
				durationMs: result.durationMs,
				permissionStartedAt: result.permissionStartedAt,
				executionStartedAt: result.executionStartedAt,
				completedAt: result.completedAt,
			},
			toolCall.messageId,
			toolCall.id,
		);
		if (result.updatedInput) {
			await narratorService.overwriteToolCallInput(toolUseId, result.updatedInput);
		}

		broadcastToNarrator(narratorId, {
			type: "tool_completed",
			narratorId,
			toolCallId: toolCall.id,
			toolUseId,
			toolName,
			status: result.isError ? "fail" : "success",
			output: result.metadata
				? { _text: result.output, _metadata: result.metadata }
				: result.output,
			durationMs: result.durationMs,
			...(result.updatedInput ? { updatedInput: result.updatedInput } : {}),
			...(result.metadata ? { metadata: result.metadata } : {}),
		});

		// Record the re-run's own boundaries. Remote targets have no shadow repository
		// yet, so they are skipped rather than treated as if they were local.
		const executionTarget = result.metadata?.executionTarget as
			| { deviceId?: string; cwd?: string }
			| undefined;
		if (canSnapshotRerun && executionTarget?.deviceId !== LOCAL_DEVICE_ID) {
			// The before-hook already opened a write claim, and nothing here will close
			// it: a claim left in flight is read as extending to now, so its declared
			// paths would be subtracted from every other narrator's shell call in this
			// worktree from now on — turning their real writes into unrevertable ones.
			abandonTreeSnapshot(active, narratorId, toolUseId);
		}
		if (canSnapshotRerun && executionTarget?.deviceId === LOCAL_DEVICE_ID) {
			try {
				const { changedFiles } = await recordTreeSnapshotAfter(active, narratorId, toolUseId);
				if (isShellTool && changedFiles.length > 0) {
					const { recordAttributions } = await import("./file-attribution-service");
					await recordAttributions(
						{
							deviceId: LOCAL_DEVICE_ID,
							workspacePath: active.cwd,
							narratorId,
							action: "bash",
							toolName: SHELL_TOOL_NAME,
							toolUseId,
						},
						changedFiles,
					);
				}
			} catch (err) {
				// The after-hook closes the claim before it can fail, but a failure here
				// leaves that unproven, and a claim left in flight overlaps every later
				// window. Sealing is a no-op once it is already closed.
				abandonTreeSnapshot(active, narratorId, toolUseId);
				logger.debug("Bash rerun after-snapshot failed", {
					narratorId,
					toolUseId,
					error: String(err),
				});
			}
		}
	} catch (err) {
		// executeTool threw, so the after-hook above is skipped entirely. The claim the
		// before-hook opened has to be sealed here or it stays "in flight" forever.
		if (canSnapshotRerun) abandonTreeSnapshot(active, narratorId, toolUseId);
		const message = err instanceof Error ? err.message : String(err);
		logger.error("Failed to re-execute denied tool call", {
			narratorId,
			toolUseId,
			error: message,
		});
		await narratorService
			.updateToolCallResult(
				toolUseId,
				{
					output: `Re-execution failed: ${message}`,
					status: "fail",
					errorMessage: `Re-execution failed: ${message}`,
					completedAt: Date.now(),
				},
				toolCall.messageId,
				toolCall.id,
			)
			.catch(() => {});
		broadcastToNarrator(narratorId, {
			type: "tool_completed",
			narratorId,
			toolCallId: toolCall.id,
			toolUseId,
			toolName,
			status: "fail",
			output: `Re-execution failed: ${message}`,
		});
		await narratorService.updateStatus(narratorId, "idle", { substatus: ["error"] });
		disposeInactiveNarratorSession(narratorId, active);
		return { ok: true, shouldContinue: false };
	}

	if (options?.autoContinue === false) {
		await narratorService.updateStatus(narratorId, "idle", { substatus: [] });
		disposeInactiveNarratorSession(narratorId, active);
		return { ok: true, shouldContinue: true };
	}

	// Auto-continue: replay the freshly produced tool result so the model resumes
	// from where it was interrupted. Forward the triggering user so knowledge ACL
	// keeps working through the continued loop.
	await continueNarrator(narratorId, locale, replyInUserLanguage, userId);
	return { ok: true };
}

export async function executePersistedToolCall(input: {
	toolCallId: string;
	narratorId: string;
	locale?: Locale;
	replyInUserLanguage?: boolean;
	userId?: string | null;
	permissionMode?: "normal" | "preGranted";
}): Promise<ReExecuteDeniedResult> {
	const toolCall = await db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.id, input.toolCallId),
		columns: { toolUseId: true },
	});
	if (!toolCall) return { ok: false, reason: "not_found" };
	return reExecuteDeniedToolCall(
		input.narratorId,
		toolCall.toolUseId,
		input.locale ?? "en",
		input.replyInUserLanguage ?? false,
		input.userId,
		{
			autoContinue: false,
			persistedToolCallId: input.toolCallId,
			permissionMode: input.permissionMode ?? "normal",
		},
	);
}

export function normalizeRollbackBlockIndexForMessage(
	role: string | null | undefined,
	blockIndex: number,
	blockCount: number,
): number {
	// User messages must remain atomic. Multimodal user messages are persisted as
	// attachments first and text after them, so truncating at an image block would
	// leave an image-only turn that providers can reject. Rolling back "to" a user
	// message should preserve the complete user input and only remove later turns.
	if (role === "user") return blockCount - 1;
	return blockIndex;
}

/**
 * Rollback to a specific block within a message.
 * Deletes all blocks after the effective blockIndex in the target message,
 * plus all subsequent messages. User messages are preserved as whole turns.
 * Does NOT re-run the agent loop.
 * File changes are automatically reverted via snapshot system.
 */
export async function rollbackToBlock(
	narratorId: string,
	messageId: string,
	blockIndex: number,
	opts?: { skipRevert?: boolean; scope?: RevertScope },
): Promise<{ ok: boolean; warnings?: RevertWarning[] }> {
	const targetRef = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, narratorId),
			eq(narratorMessageRefs.messageId, messageId),
		),
	});
	if (!targetRef) throw new NotFoundError("Message", messageId);

	const targetMsg = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, messageId),
	});
	if (!targetMsg) throw new NotFoundError("Message", messageId);

	const blocks = Array.isArray(targetMsg.contentJson)
		? (targetMsg.contentJson as { type: string; id?: string }[])
		: [];

	if (blockIndex < 0 || blockIndex >= blocks.length) {
		throw new NotFoundError(
			`Block index ${blockIndex} out of range (0..${blocks.length - 1})`,
			messageId,
		);
	}

	const effectiveBlockIndex = normalizeRollbackBlockIndexForMessage(
		targetMsg.role,
		blockIndex,
		blocks.length,
	);

	// Step 1: Delete all messages after the target message (includes file revert
	// unless skipRevert requests a history-only rollback).
	const { deletedMessageIds, revertWarnings } = await narratorService.deleteMessagesAfter(
		narratorId,
		messageId,
		{
			preserveConversationId: true,
			skipRevert: opts?.skipRevert,
			...(opts?.scope ? { scope: opts.scope } : {}),
		},
	);
	if (deletedMessageIds.length > 0) {
		broadcastToNarrator(narratorId, {
			type: "messages_deleted",
			narratorId,
			deletedMessageIds,
		});
	}

	// Step 2: Delete blocks after the effective rollback boundary in the target message
	const blocksToDelete: Array<{ messageId: string; blockIndex: number }> = [];
	for (let i = blocks.length - 1; i > effectiveBlockIndex; i--) {
		blocksToDelete.push({ messageId, blockIndex: i });
	}

	if (blocksToDelete.length > 0) {
		// No scope here on purpose: block deletion removes single blocks while keeping
		// everything after them, so it deliberately uses per-file replay (see
		// `deleteMessageBlock`) rather than any tree-based scope. Forwarding `scope`
		// would look meaningful while being ignored.
		const blockDeleteResult = await narratorService.deleteMessageBlocks(
			narratorId,
			blocksToDelete,
			{
				preserveConversationId: true,
				skipRevert: opts?.skipRevert,
			},
		);

		const targetMessageDeleted = blockDeleteResult.results.some(
			(r) => r.messageId === messageId && r.messageDeleted,
		);
		if (targetMessageDeleted) {
			broadcastToNarrator(narratorId, {
				type: "messages_deleted",
				narratorId,
				deletedMessageIds: [messageId],
			});
		} else {
			// Broadcast the updated message
			const updatedMsg = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, messageId),
			});
			if (updatedMsg) {
				broadcastToNarrator(narratorId, {
					type: "message_updated",
					narratorId,
					message: updatedMsg,
				});
			}
		}
	}

	// Advisory only: the rollback already happened. Surfacing it lets the caller (and
	// the model, via the tool result) verify the workspace instead of assuming the
	// restored state contained only its own changes.
	return revertWarnings?.length ? { ok: true, warnings: revertWarnings } : { ok: true };
}

/** Extract image refs from a message's contentJson. */
function extractImageRefs(
	contentJson: unknown,
	fallbackUploadNarratorId?: string | null,
): ImageRef[] {
	const imageRefs: ImageRef[] = [];
	if (Array.isArray(contentJson)) {
		for (const block of contentJson as Array<Record<string, unknown>>) {
			if (
				block.type === "image" &&
				typeof block.imageId === "string" &&
				typeof block.filename === "string" &&
				typeof block.mediaType === "string"
			) {
				const uploadNarratorId =
					typeof block.uploadNarratorId === "string"
						? block.uploadNarratorId
						: fallbackUploadNarratorId;
				const dimensions =
					validImageDimension(block.width) && validImageDimension(block.height)
						? { width: block.width, height: block.height }
						: {};
				imageRefs.push({
					imageId: block.imageId as string,
					filename: block.filename as string,
					mediaType: block.mediaType as string,
					...dimensions,
					...(uploadNarratorId ? { uploadNarratorId } : {}),
				});
			}
		}
	}
	return imageRefs;
}

export function resolveRequestedAttachmentKeys(
	actualKeys: Iterable<string>,
	requestedKeys?: Iterable<string>,
): string[] {
	const actual = [...new Set(actualKeys)];
	if (requestedKeys === undefined) return actual;
	const requested = new Set(requestedKeys);
	return actual.filter((key) => requested.has(key));
}

type EditableUserContentBlock =
	| { type: "text"; text: string }
	| PersistedUserImageBlock
	// `fileId` is optional: legacy uploads stored files under
	// ~/.narrafork/uploads/<narratorId>/text/<fileId>.ext with a relative
	// filePath, while newer uploads live in the worktree and omit fileId.
	// Preserve it verbatim so legacy attachments survive an edit round-trip.
	| { type: "text_file"; filename: string; size: number; filePath: string; fileId?: string };

/**
 * Extract persisted text-file attachment blocks as TextFileRefs so the edited
 * prompt can re-inject the <attached_files> hint. The underlying files already
 * live in the worktree, so we only need their metadata.
 */
function extractTextFileRefs(contentJson: unknown): TextFileRef[] {
	const refs: TextFileRef[] = [];
	if (!Array.isArray(contentJson)) return refs;
	for (const block of contentJson as Array<Record<string, unknown>>) {
		if (
			block.type === "text_file" &&
			typeof block.filename === "string" &&
			typeof block.filePath === "string" &&
			typeof block.size === "number"
		) {
			refs.push({
				filename: block.filename,
				filePath: block.filePath,
				size: block.size,
			});
		}
	}
	return refs;
}

/**
 * Replace editable text while preserving the persisted attachment block order.
 * New user messages are stored as images/text_files first, then text; editing
 * must not move or drop those attachment blocks or history replay/front-end
 * fetches can target the wrong shape (and attachments would silently vanish).
 *
 * Image handling:
 *   - `opts.keepImageIds === undefined` → keep ALL existing images (legacy
 *     behaviour: callers that don't manage images never lose them).
 *   - `opts.keepImageIds` provided → keep only existing images whose imageId is
 *     in the set (images the user removed during editing are dropped).
 *   - `opts.newImages` → appended as fresh image blocks (uploaded during editing).
 *
 * Text-file handling mirrors images (keyed by filePath instead of imageId):
 *   - `opts.keepTextFilePaths === undefined` → keep ALL existing text files
 *     (backward compatible: callers that don't manage files never lose them).
 *   - `opts.keepTextFilePaths` provided → keep only existing text files whose
 *     filePath is in the set (files the user removed during editing are dropped).
 *   - `opts.newTextFiles` → appended as fresh text_file blocks (uploaded during editing).
 */
function buildEditedUserContentJson(
	contentJson: unknown,
	newContent: string,
	opts?: {
		fallbackUploadNarratorId?: string | null;
		keepImageIds?: string[];
		newImages?: ImageRef[];
		keepTextFilePaths?: string[];
		newTextFiles?: TextFileRef[];
	},
): EditableUserContentBlock[] {
	const blocks = Array.isArray(contentJson) ? (contentJson as Array<Record<string, unknown>>) : [];
	const fallbackUploadNarratorId = opts?.fallbackUploadNarratorId;
	// undefined => keep all (legacy); a Set => keep only listed ids/paths.
	const keepImageSet = opts?.keepImageIds ? new Set(opts.keepImageIds) : null;
	const keepTextFileSet = opts?.keepTextFilePaths ? new Set(opts.keepTextFilePaths) : null;
	const seenImageIds = new Set<string>();
	const seenTextFilePaths = new Set<string>();
	const imageBlocks: EditableUserContentBlock[] = [];
	const textFileBlocks: EditableUserContentBlock[] = [];

	for (const block of blocks) {
		if (
			block.type === "image" &&
			typeof block.imageId === "string" &&
			typeof block.filename === "string" &&
			typeof block.mediaType === "string"
		) {
			// Drop images the user removed during editing and collapse duplicate persisted blocks.
			if (keepImageSet && !keepImageSet.has(block.imageId)) continue;
			if (seenImageIds.has(block.imageId)) continue;
			seenImageIds.add(block.imageId);
			imageBlocks.push(
				imageRefToContentBlock(
					{
						imageId: block.imageId,
						filename: block.filename,
						mediaType: block.mediaType,
						...(validImageDimension(block.width) && validImageDimension(block.height)
							? { width: block.width, height: block.height }
							: {}),
						...(typeof block.uploadNarratorId === "string"
							? { uploadNarratorId: block.uploadNarratorId }
							: {}),
					},
					fallbackUploadNarratorId,
				),
			);
			continue;
		}

		if (
			block.type === "text_file" &&
			typeof block.filename === "string" &&
			typeof block.filePath === "string" &&
			typeof block.size === "number"
		) {
			// Drop removed text files and collapse duplicate persisted blocks.
			if (keepTextFileSet && !keepTextFileSet.has(block.filePath)) continue;
			if (seenTextFilePaths.has(block.filePath)) continue;
			seenTextFilePaths.add(block.filePath);
			textFileBlocks.push({
				type: "text_file",
				filename: block.filename,
				size: block.size,
				filePath: block.filePath,
				// Preserve legacy fileId so older uploads-based attachments keep
				// resolving after an edit round-trip.
				...(typeof block.fileId === "string" ? { fileId: block.fileId } : {}),
			});
		}
	}

	// Newly uploaded images during editing — keep them after existing ones.
	// Prefer the ref's own uploadNarratorId (the narrator the files were saved
	// under), falling back to the editing narrator.
	if (opts?.newImages?.length) {
		for (const img of opts.newImages) {
			imageBlocks.push(imageRefToContentBlock(img, fallbackUploadNarratorId));
		}
	}

	// Newly uploaded text files during editing — appended after existing ones.
	if (opts?.newTextFiles?.length) {
		for (const tf of opts.newTextFiles) {
			textFileBlocks.push({
				type: "text_file",
				filename: tf.filename,
				size: tf.size,
				filePath: tf.filePath,
			});
		}
	}

	// Canonical order matches freshly sent messages: images, text_files, text.
	return [...imageBlocks, ...textFileBlocks, { type: "text", text: newContent }];
}

/**
 * Edit a user message and regenerate the response.
 * Updates the message content, deletes everything after it, and re-runs the agent loop.
 *
 * `opts.revertFiles` (default true) decides whether the file changes the deleted
 * messages made are rolled back, and `opts.revertScope` how wide that rollback
 * reaches — the same two choices the rollback dialog offers. They are options, not
 * a fixed behaviour, because "edit this message again" and "undo what the assistant
 * wrote to my files" are separate intents that used to be welded together: the old
 * `rollback` flag was accepted and then ignored, so every edit reverted files.
 *
 * `opts.keepImageIds` / `opts.newImages` let the caller manage attached images during
 * editing (keep a subset of existing images, drop the rest, and/or append new uploads).
 * `opts.keepTextFilePaths` / `opts.newTextFiles` do the same for text-file attachments
 * (new files are saved into the worktree before the rebuilt blocks are persisted).
 * When `opts` is omitted, all existing images and text files are preserved (backward compatible).
 */
export async function editAndRegenerate(
	narratorId: string,
	messageId: string,
	newContent: string,
	locale: Locale = "en",
	replyInUserLanguage = false,
	opts?: EditAndRegenerateOptions,
): Promise<{ ok: boolean; warnings?: RevertWarning[] }> {
	return continuationStartLock.acquire(narratorId, () =>
		editAndRegenerateUnlocked(narratorId, messageId, newContent, locale, replyInUserLanguage, opts),
	);
}

export interface EditAndRegenerateOptions {
	keepImageIds?: string[];
	newImages?: File[];
	keepTextFilePaths?: string[];
	newTextFiles?: File[];
	userId?: string | null;
	deferContinuation?: boolean;
	/**
	 * Roll back the file changes the truncated messages made. Defaults to true,
	 * which is what every edit did before this was expressible.
	 */
	revertFiles?: boolean;
	/** How wide that rollback reaches; omitted means the server default (`narrator`). */
	revertScope?: RevertScope;
}

async function editAndRegenerateUnlocked(
	narratorId: string,
	messageId: string,
	newContent: string,
	locale: Locale,
	replyInUserLanguage: boolean,
	opts?: EditAndRegenerateOptions,
): Promise<{ ok: boolean; warnings?: RevertWarning[] }> {
	// Every admission and attachment check must finish before the first file write.
	if (isLoopRunning(narratorId)) {
		logger.warn("editAndRegenerate blocked: loop already running", { narratorId });
		await reconcileRunningStatus(narratorId);
		return { ok: false };
	}
	const targetRef = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, narratorId),
			eq(narratorMessageRefs.messageId, messageId),
		),
	});
	if (!targetRef) throw new NotFoundError("Message", messageId);

	const targetMsg = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, messageId),
	});
	if (!targetMsg) throw new NotFoundError("Message", messageId);
	if (targetMsg.role !== "user") {
		// The message was found; the request is what is wrong. As a NotFoundError this
		// sentence became the catalog's `{entity}` and rendered as "未找到Can only edit
		// user messages：<id>" once a translation existed.
		throw new ValidationError("Can only edit user messages");
	}

	const narrator = await narratorService.getById(narratorId);
	if (isSubagentVariant(narrator.variant) && !opts?.deferContinuation) {
		throw new ValidationError("Subagent regeneration must be sent through resumeSubagent");
	}
	if (narrator.status === "working" || narrator.status === "waiting" || isLoopRunning(narratorId)) {
		await reconcileRunningStatus(narratorId);
		return { ok: false };
	}

	const originalBlocks = Array.isArray(targetMsg.contentJson)
		? (targetMsg.contentJson as Array<Record<string, unknown>>)
		: [];
	const actualImageIds = originalBlocks
		.filter((block) => block.type === "image" && typeof block.imageId === "string")
		.map((block) => block.imageId as string);
	const actualTextFilePaths = originalBlocks
		.filter((block) => block.type === "text_file" && typeof block.filePath === "string")
		.map((block) => block.filePath as string);
	const keepImageIds = resolveRequestedAttachmentKeys(actualImageIds, opts?.keepImageIds);
	const keepTextFilePaths = resolveRequestedAttachmentKeys(
		actualTextFilePaths,
		opts?.keepTextFilePaths,
	);

	for (const file of opts?.newImages ?? []) validateUploadedImage(file);
	for (const file of opts?.newTextFiles ?? []) validateTextFile(file);
	const uploadBytes = [...(opts?.newImages ?? []), ...(opts?.newTextFiles ?? [])].reduce(
		(total, file) => total + file.size,
		0,
	);
	if (uploadBytes > MAX_NARRATOR_ATTACHMENT_BYTES) {
		throw new ValidationError("Combined attachments exceed the 128 MiB limit");
	}
	if (keepImageIds.length + (opts?.newImages?.length ?? 0) > MAX_EDIT_IMAGES_PER_MESSAGE) {
		throw new ValidationError(`Maximum ${MAX_EDIT_IMAGES_PER_MESSAGE} images per message`);
	}
	if (
		keepTextFilePaths.length + (opts?.newTextFiles?.length ?? 0) >
		MAX_EDIT_TEXT_FILES_PER_MESSAGE
	) {
		throw new ValidationError(`Maximum ${MAX_EDIT_TEXT_FILES_PER_MESSAGE} text files per message`);
	}
	if (
		!newContent.trim() &&
		keepImageIds.length === 0 &&
		keepTextFilePaths.length === 0 &&
		!(opts?.newImages?.length || opts?.newTextFiles?.length)
	) {
		throw new ValidationError("content is required");
	}

	// Resolve the live cwd only after DB/input validation. Deferred subagent regeneration
	// must not create a generic narrator session; resumeSubagent starts its dedicated runner.
	const active = opts?.deferContinuation
		? undefined
		: await ensureNarrator(narratorId, locale, replyInUserLanguage);
	const executionCwd = active?.cwd ?? narrator.cwd ?? ".";
	const keepImageSet = new Set(keepImageIds);
	const keepTextFileSet = new Set(keepTextFilePaths);
	const countedImageIds = new Set<string>();
	const countedTextFilePaths = new Set<string>();
	let retainedAttachmentBytes = 0;
	const textFilesToCopy = new Map<string, TextFileRef>();
	for (const block of originalBlocks) {
		if (
			block.type === "image" &&
			typeof block.imageId === "string" &&
			keepImageSet.has(block.imageId)
		) {
			const owner =
				typeof block.uploadNarratorId === "string" ? block.uploadNarratorId : targetMsg.narratorId;
			const imageInfo = getUploadedImageInfo(owner, block.imageId);
			if (!imageInfo) {
				throw new ValidationError(
					`Attached image not found: ${String(block.filename ?? block.imageId)}`,
				);
			}
			const imageKey = `${owner.length}:${owner}:${block.imageId}`;
			if (!countedImageIds.has(imageKey)) {
				countedImageIds.add(imageKey);
				retainedAttachmentBytes += imageInfo.size;
			}
		}
		if (
			block.type === "text_file" &&
			typeof block.filePath === "string" &&
			keepTextFileSet.has(block.filePath)
		) {
			const sourceFile = isAbsolute(block.filePath) ? Bun.file(block.filePath) : null;
			if (sourceFile && !(await sourceFile.exists())) {
				throw new ValidationError(
					`Attached file not found: ${String(block.filename ?? block.filePath)}`,
				);
			}
			const actualSize = sourceFile?.size ?? (typeof block.size === "number" ? block.size : null);
			if (actualSize == null || actualSize < 0) {
				throw new ValidationError(
					`Attached file size is unavailable: ${String(block.filename ?? block.filePath)}`,
				);
			}
			if (!countedTextFilePaths.has(block.filePath)) {
				countedTextFilePaths.add(block.filePath);
				retainedAttachmentBytes += actualSize;
			}
			if (
				typeof block.fileId !== "string" &&
				sourceFile &&
				!isFileWithinWorktree(executionCwd, block.filePath) &&
				!textFilesToCopy.has(block.filePath)
			) {
				textFilesToCopy.set(block.filePath, {
					filename: String(block.filename ?? "attachment"),
					filePath: block.filePath,
					size: actualSize,
				});
			}
		}
	}
	const finalAttachmentBytes = uploadBytes + retainedAttachmentBytes;
	if (finalAttachmentBytes > MAX_NARRATOR_ATTACHMENT_BYTES) {
		throw new ValidationError("Combined attachments exceed the 128 MiB limit");
	}
	const materializedBytes =
		uploadBytes + [...textFilesToCopy.values()].reduce((total, file) => total + file.size, 0);
	if (materializedBytes > MAX_NARRATOR_ATTACHMENT_BYTES) {
		throw new ValidationError("Combined materialized attachments exceed the 128 MiB limit");
	}
	if (isLoopRunning(narratorId)) {
		await reconcileRunningStatus(narratorId);
		return { ok: false };
	}

	// Truncate (and optionally roll the files back) BEFORE materialising this edit's
	// attachments. A workspace-scoped tree rollback deletes whatever the target tree
	// does not contain, and files just written into `.narrafork/attached/` are exactly
	// that — so writing them first meant the rollback silently ate the user's new
	// uploads. The boundary is the ORIGINAL message id: copy-on-write below may hand
	// the row a new id, but the ref keeps its `seq`, which is what selects the tail.
	//
	// The cost of this order is that a failure in the attachment/copy-on-write steps
	// leaves the history truncated while the edit is unsaved. That is recoverable —
	// the request fails, the client keeps the draft, and the user can resubmit —
	// whereas destroying an attachment the user just added is not.
	const { deletedMessageIds, revertWarnings } = await narratorService.deleteMessagesAfter(
		narratorId,
		messageId,
		{
			preserveConversationId: true,
			skipRevert: opts?.revertFiles === false,
			...(opts?.revertScope ? { scope: opts.revertScope } : {}),
		},
	);
	if (deletedMessageIds.length > 0) {
		broadcastToNarrator(narratorId, {
			type: "messages_deleted",
			narratorId,
			deletedMessageIds,
		});
	}

	const createdImageIds: string[] = [];
	const createdFilePaths: string[] = [];
	let copyOnWriteSucceeded = false;
	let privateMessageId: string;
	let newContentJson: EditableUserContentBlock[];
	let existingImages: ImageRef[];
	let existingTextFiles: TextFileRef[];
	let effectivePrompt: string;
	try {
		const savedNewImages: ImageRef[] = [];
		for (const file of opts?.newImages ?? []) {
			const ref = await saveUploadedImage(narratorId, file);
			createdImageIds.push(ref.imageId);
			savedNewImages.push({ ...ref, uploadNarratorId: narratorId });
		}

		const savedNewTextFiles: TextFileRef[] = [];
		for (const file of opts?.newTextFiles ?? []) {
			const ref = await saveTextFileToWorktree(executionCwd, file);
			createdFilePaths.push(ref.filePath);
			savedNewTextFiles.push(ref);
		}

		const copiedTextFiles = new Map<string, TextFileRef>();
		for (const [sourcePath, source] of textFilesToCopy) {
			const ref = await copyTextFileToWorktree(executionCwd, source);
			createdFilePaths.push(ref.filePath);
			copiedTextFiles.set(sourcePath, ref);
		}

		const relocatedBlocks = originalBlocks.map((block) => {
			if (block.type !== "text_file" || typeof block.filePath !== "string") return block;
			const copied = copiedTextFiles.get(block.filePath);
			return copied ? { ...block, filePath: copied.filePath, size: copied.size } : block;
		});
		const relocatedKeepTextFilePaths = keepTextFilePaths.map(
			(filePath) => copiedTextFiles.get(filePath)?.filePath ?? filePath,
		);
		newContentJson = buildEditedUserContentJson(relocatedBlocks, newContent, {
			fallbackUploadNarratorId: targetMsg.narratorId,
			keepImageIds,
			newImages: savedNewImages,
			keepTextFilePaths: relocatedKeepTextFilePaths,
			newTextFiles: savedNewTextFiles.length > 0 ? savedNewTextFiles : undefined,
		});
		existingImages = extractImageRefs(newContentJson, targetMsg.narratorId);
		existingTextFiles = extractTextFileRefs(newContentJson);
		const effectiveText =
			!newContent.trim() && existingImages.length > 0 ? "[user sent image(s)]" : newContent;
		effectivePrompt = effectiveText + buildAttachedFilesHint(existingTextFiles);

		// A loop may have started while the files were being materialized (the route
		// already cleared the way once, but that was several awaits ago). Stop it the
		// same way the route did rather than failing the edit the user asked for; only
		// a loop that will not stop aborts here, before copy-on-write, so the catch
		// block can remove every file created by this attempt.
		if (isLoopRunning(narratorId) && !(await interruptAndWaitForIdle(narratorId))) {
			throw new ValidationError(
				"This narrator did not stop after being interrupted; try again in a moment",
			);
		}
		privateMessageId = await narratorService.copyOnWriteMessage(narratorId, messageId, {
			contentText: effectivePrompt,
			contentJson: newContentJson,
		});
		copyOnWriteSucceeded = true;
	} catch (error) {
		if (!copyOnWriteSucceeded) {
			for (const imageId of createdImageIds) deleteUploadedImage(narratorId, imageId);
			deleteCreatedAttachmentFiles(createdFilePaths);
		}
		throw error;
	}

	// Broadcast the updated message.  If copy-on-write changed the message ID,
	// force a reload so the client replaces the old shared row with the private copy.
	const updatedMsg = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, privateMessageId),
	});
	if (updatedMsg) {
		broadcastToNarrator(narratorId, {
			type: "message_updated",
			narratorId,
			message: updatedMsg,
		});
		if (privateMessageId !== messageId) {
			broadcastToNarrator(narratorId, { type: "full_reload", narratorId });
		}
	}

	const imageRefs = existingImages;
	// Surfaced so the caller can pass the advice on: a rollback can reach past the
	// chosen scope (subagent writes, a workspace restore).
	const warnings = revertWarnings?.length ? { warnings: revertWarnings } : {};

	if (opts?.deferContinuation) {
		await narratorService.updateStatus(narratorId, "idle", { substatus: [] });
		return { ok: true, ...warnings };
	}
	if (!active) {
		throw new ValidationError("Narrator session was not initialized for regeneration");
	}

	// `active` was resolved above before saving new text files. Restore the
	// triggering user so knowledge-base ACL works after a rebuild.
	active._currentUserId = opts?.userId ?? active._currentUserId ?? null;
	active._lastTokenUsage = undefined;
	active._ttftMs = undefined;
	active._turnStartedAt = new Date().toISOString();
	await narratorService.updateStatus(narratorId, "working", { setTurnStart: true });

	runAgentLoop(active, effectivePrompt, imageRefs.length > 0 ? imageRefs : undefined).catch(
		async (err) => {
			logger.error("runAgentLoop unhandled error (editAndRegenerate)", {
				narratorId,
				error: String(err),
			});
			await narratorService.updateStatus(narratorId, "idle", {
				substatus: ["error"],
				errorMessage: String(err),
			});
			broadcastToNarrator(narratorId, {
				type: "narrator_error",
				narratorId,
				error: String(err),
			});
		},
	);

	return { ok: true, ...warnings };
}

/**
 * Replace the editable text of an assistant message while preserving all other
 * blocks (thinking / tool_use / etc.) in their original order. The new text is
 * written into the first text block; if none exists, a text block is appended.
 */
function buildEditedAssistantContentJson(
	contentJson: unknown,
	newContent: string,
): Array<Record<string, unknown>> {
	const blocks = Array.isArray(contentJson) ? (contentJson as Array<Record<string, unknown>>) : [];
	const newBlocks: Array<Record<string, unknown>> = [];
	let replacedText = false;

	for (const block of blocks) {
		if (block.type === "text") {
			if (!replacedText) {
				newBlocks.push({ ...block, text: newContent });
				replacedText = true;
			}
			// Drop any additional text blocks — the edited text is consolidated
			// into the first one (matches the single-textarea edit UI).
			continue;
		}
		newBlocks.push(block);
	}

	if (!replacedText) {
		newBlocks.push({ type: "text", text: newContent });
	}

	return newBlocks;
}

/**
 * Edit the text content of an assistant message without regenerating.
 *
 * Unlike editing a user message, this does NOT truncate following messages or
 * re-run the agent loop. The new text is persisted and used when assembling the
 * history for subsequent turns, but the "edited" metadata (editedAt / editedBy /
 * originalContentJson) lives on the message row — never inside contentJson — so
 * it is never sent to the AI provider.
 *
 * Copy-on-write protects fork sources: if the message is shared by multiple
 * narrators (ref count > 1), a private copy is created for this narrator only.
 */
export async function editAssistantMessage(
	narratorId: string,
	messageId: string,
	newContent: string,
	editedBy?: string | null,
): Promise<{ ok: boolean }> {
	const targetRef = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, narratorId),
			eq(narratorMessageRefs.messageId, messageId),
		),
	});
	if (!targetRef) throw new NotFoundError("Message", messageId);

	const targetMsg = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, messageId),
	});
	if (!targetMsg) throw new NotFoundError("Message", messageId);
	if (targetMsg.role !== "assistant") {
		throw new ValidationError("Can only edit assistant messages");
	}

	const newContentJson = buildEditedAssistantContentJson(targetMsg.contentJson, newContent);
	const now = new Date().toISOString();

	// Preserve the original content the first time a message is edited so the
	// front-end can always reveal the unedited version.
	const overrides: Partial<typeof narratorMessages.$inferInsert> = {
		contentJson: newContentJson,
		contentText: newContent,
		editedAt: now,
		editedBy: editedBy ?? null,
	};
	if (!targetMsg.editedAt) {
		overrides.originalContentJson = targetMsg.contentJson;
	}

	const privateMessageId = await narratorService.copyOnWriteMessage(
		narratorId,
		messageId,
		overrides,
	);

	// Broadcast the updated message. If copy-on-write changed the message ID,
	// force a reload so the client replaces the old shared row with the private copy.
	const updatedMsg = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, privateMessageId),
	});
	if (updatedMsg) {
		broadcastToNarrator(narratorId, {
			type: "message_updated",
			narratorId,
			message: updatedMsg,
		});
		if (privateMessageId !== messageId) {
			broadcastToNarrator(narratorId, { type: "full_reload", narratorId });
		}
	}

	return { ok: true };
}

/**
 * Restore an assistant message to its original (pre-edit) text.
 *
 * Reverts contentJson/contentText to the captured originalContentJson and clears
 * all edit metadata (editedAt / editedBy / originalContentJson) so the message
 * looks like it was never edited and the "edited" badge disappears.
 *
 * Copy-on-write protects fork sources, mirroring editAssistantMessage.
 */
export async function restoreAssistantMessage(
	narratorId: string,
	messageId: string,
): Promise<{ ok: boolean }> {
	const targetRef = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, narratorId),
			eq(narratorMessageRefs.messageId, messageId),
		),
	});
	if (!targetRef) throw new NotFoundError("Message", messageId);

	const targetMsg = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, messageId),
	});
	if (!targetMsg) throw new NotFoundError("Message", messageId);
	if (targetMsg.role !== "assistant") {
		throw new ValidationError("Can only restore assistant messages");
	}

	// Nothing to restore if the message was never edited.
	if (!targetMsg.editedAt) {
		return { ok: true };
	}

	const originalContentJson = Array.isArray(targetMsg.originalContentJson)
		? (targetMsg.originalContentJson as Array<Record<string, unknown>>)
		: [];
	const originalText = originalContentJson
		.filter((b) => b?.type === "text")
		.map((b) => (typeof b.text === "string" ? b.text : ""))
		.join("\n\n");

	const overrides: Partial<typeof narratorMessages.$inferInsert> = {
		contentJson: originalContentJson,
		contentText: originalText,
		editedAt: null,
		editedBy: null,
		originalContentJson: null,
	};

	const privateMessageId = await narratorService.copyOnWriteMessage(
		narratorId,
		messageId,
		overrides,
	);

	const updatedMsg = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, privateMessageId),
	});
	if (updatedMsg) {
		broadcastToNarrator(narratorId, {
			type: "message_updated",
			narratorId,
			message: updatedMsg,
		});
		if (privateMessageId !== messageId) {
			broadcastToNarrator(narratorId, { type: "full_reload", narratorId });
		}
	}

	return { ok: true };
}

/**
 * Start or feed a message into a narrator.
 * Yields NarratorEvent objects for consumption (used by chapter-merge).
 */
export async function* startSession(
	narratorId: string,
	prompt: string,
	images?: ImageRef[],
	locale: Locale = "en",
	replyInUserLanguage = false,
): AsyncGenerator<NarratorEvent> {
	let active: ActiveNarrator;
	let userMsg: typeof narratorMessages.$inferSelect;
	try {
		({ active, userMsg } = await feedMessage(
			narratorId,
			prompt,
			images,
			locale,
			replyInUserLanguage,
		));
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		yield { type: "error", data: { message: errorMsg } };
		yield { type: "done", data: null };
		return;
	}

	// Subscribe to narrator events and yield them
	const eventQueue: NarratorEvent[] = [];
	let resolve: (() => void) | null = null;
	let done = false;

	const onEvent = (event: NarratorEvent) => {
		eventQueue.push(event);
		if (resolve) {
			const r = resolve;
			resolve = null;
			r();
		}
	};

	active.events.on("event", onEvent);

	// Emit user_message AFTER subscribing so it's not lost
	// Broadcast to all WS subscribers so other clients see the user message in real-time
	broadcastToNarrator(narratorId, {
		type: "user_message",
		narratorId,
		message: userMsg,
	});
	yield { type: "user_message", data: userMsg };

	try {
		while (!done) {
			while (eventQueue.length > 0) {
				const event = eventQueue.shift();
				if (!event) break;
				if (event.type === "done") {
					yield event;
					done = true;
					break;
				}
				yield event;
			}
			if (!done) {
				await new Promise<void>((r) => {
					resolve = r;
				});
			}
		}
	} finally {
		active.events.off("event", onEvent);
	}
}

// === Narrator control ===

/**
 * Clean up a partial (incomplete) assistant message and its related records.
 * Deletes children first to satisfy FK constraints.
 */
export async function cleanupPartialMessage(partialId: string, narratorId: string): Promise<void> {
	try {
		db.transaction((tx) => {
			tx.delete(narratorToolCalls).where(eq(narratorToolCalls.messageId, partialId)).run();
			tx.delete(narratorMessageRefs).where(eq(narratorMessageRefs.messageId, partialId)).run();
			tx.delete(narratorMessages).where(eq(narratorMessages.id, partialId)).run();
			tx.update(narrators)
				.set({
					messageVersion: sql`${narrators.messageVersion} + 1`,
					messageStructureVersion: sql`${narrators.messageStructureVersion} + 1`,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(narrators.id, narratorId))
				.run();
		});
	} catch (err) {
		logger.warn("Failed to clean up partial message on error", {
			narratorId,
			partialId,
			error: String(err),
		});
	}
}

/**
 * Finalize or clean up a partial message before retry.
 *
 * Three-way decision:
 * 1. **No executed tools AND no meaningful content** — the entire partial
 *    message is deleted via {@link cleanupPartialMessage}.
 * 2. **No executed tools BUT has streamed text/reasoning** — the message is
 *    preserved; any unexecuted tool_call records and their tool_use blocks
 *    are stripped from contentJson.
 * 3. **Some tools executed** — the message is kept. Unexecuted tool_calls
 *    (initializing / pending) are removed, running ones are marked as fail
 *    (interrupted), and contentJson is trimmed to match.
 *
 * @returns `true` if the message was kept (finalized), `false` if deleted.
 */
export async function finalizeOrCleanupPartialMessage(
	partialId: string,
	narratorId: string,
): Promise<boolean> {
	try {
		const toolCalls = await db.query.narratorToolCalls.findMany({
			where: eq(narratorToolCalls.messageId, partialId),
			columns: { id: true, toolUseId: true, status: true },
		});

		// Statuses that indicate the tool was actually executed (side effects occurred)
		const executedStatuses = new Set(["success", "fail", "running"]);
		const executed = toolCalls.filter((tc) => executedStatuses.has(tc.status));

		if (executed.length === 0) {
			// No tool was actually executed — but check if the message has
			// meaningful text/reasoning content that should be preserved
			// (e.g. user interrupted while the model was streaming a long text block).
			const hasContent = db.transaction((tx) => {
				const msg = tx.query.narratorMessages
					.findFirst({
						where: eq(narratorMessages.id, partialId),
						columns: { contentJson: true },
					})
					.sync();
				const blocks = Array.isArray(msg?.contentJson)
					? (msg.contentJson as Array<Record<string, unknown>>)
					: [];
				const meaningful = blocks.some(
					(b) =>
						(b.type === "text" && typeof b.text === "string" && b.text.length > 0) ||
						(b.type === "reasoning" && typeof b.text === "string" && b.text.length > 0),
				);

				if (!meaningful) return false;

				// Has streamed content worth keeping — remove any unexecuted tool_call
				// records and their corresponding tool_use blocks from contentJson,
				// but preserve the message itself.
				// Note: since executed.length === 0, toolCalls here are all unexecuted.
				if (toolCalls.length > 0) {
					const toolUseIds = new Set(toolCalls.map((tc) => tc.toolUseId));
					tx.delete(narratorToolCalls)
						.where(
							inArray(
								narratorToolCalls.id,
								toolCalls.map((tc) => tc.id),
							),
						)
						.run();
					const filtered = blocks.filter(
						(block) => block.type !== "tool_use" || !toolUseIds.has(block.id as string),
					);
					tx.update(narratorMessages)
						.set({ contentJson: filtered })
						.where(eq(narratorMessages.id, partialId))
						.run();
				}

				logger.info("Preserved partial message with streamed content (no tool execution)", {
					narratorId,
					partialId,
					blockCount: blocks.length,
					removedToolCalls: toolCalls.length,
				});
				return true;
			});

			if (!hasContent) {
				// Truly empty — safe to delete
				await cleanupPartialMessage(partialId, narratorId);
				return false;
			}
			return true;
		}

		// Some tools were executed — keep the message, clean up the rest
		const unexecuted = toolCalls.filter((tc) => !executedStatuses.has(tc.status));
		const unexecutedToolUseIds = new Set(unexecuted.map((tc) => tc.toolUseId));

		db.transaction((tx) => {
			// Delete unexecuted tool_call records
			if (unexecuted.length > 0) {
				tx.delete(narratorToolCalls)
					.where(
						inArray(
							narratorToolCalls.id,
							unexecuted.map((tc) => tc.id),
						),
					)
					.run();
			}

			// Mark running tool_calls as fail (interrupted by retry)
			const running = executed.filter((tc) => tc.status === "running");
			if (running.length > 0) {
				tx.update(narratorToolCalls)
					.set({
						status: "fail",
						errorMessage: "Interrupted by API error during retry",
					})
					.where(
						inArray(
							narratorToolCalls.id,
							running.map((tc) => tc.id),
						),
					)
					.run();
			}

			// Remove unexecuted tool_use blocks from contentJson
			if (unexecutedToolUseIds.size > 0) {
				const msg = tx.query.narratorMessages
					.findFirst({
						where: eq(narratorMessages.id, partialId),
						columns: { contentJson: true },
					})
					.sync();
				if (msg && Array.isArray(msg.contentJson)) {
					const filtered = (msg.contentJson as Array<Record<string, unknown>>).filter(
						(block) => block.type !== "tool_use" || !unexecutedToolUseIds.has(block.id as string),
					);
					tx.update(narratorMessages)
						.set({ contentJson: filtered })
						.where(eq(narratorMessages.id, partialId))
						.run();
				}
			}
		});

		logger.info("Finalized partial message with executed tool calls", {
			narratorId,
			partialId,
			executedCount: executed.length,
			removedCount: unexecuted.length,
		});
		return true;
	} catch (err) {
		logger.warn("Failed to finalize partial message, falling back to cleanup", {
			narratorId,
			partialId,
			error: String(err),
		});
		await cleanupPartialMessage(partialId, narratorId);
		return false;
	}
}

const INTERRUPTABLE_TOOL_CALL_STATUSES = ["initializing", "pending", "running"] as const;

/**
 * Mark in-flight tool calls for one assistant message as interrupted.
 *
 * This is intentionally message-scoped so the interrupt finalizer can first
 * protect the current partial assistant message before deciding whether that
 * partial should be kept or deleted.
 */
export async function markInterruptedToolCallsForMessage(
	narratorId: string,
	messageId: string,
	locale: Locale = "en",
): Promise<void> {
	await db
		.update(narratorToolCalls)
		.set({
			status: "fail",
			errorMessage: "Narrator interrupted by user",
			outputJson: getToolMessage("interruptedByUser", locale),
			completedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.messageId, messageId),
				inArray(narratorToolCalls.status, [...INTERRUPTABLE_TOOL_CALL_STATUSES]),
			),
		);
}

/**
 * Mark any in-flight tool calls for this narrator as failed.
 * Without this, an interrupt leaves orphaned tool call records in
 * "initializing" / "pending" / "running" state, which breaks the
 */
async function cleanupOrphanedToolCalls(narratorId: string, locale: Locale = "en"): Promise<void> {
	await db
		.update(narratorToolCalls)
		.set({
			status: "fail",
			errorMessage: "Narrator interrupted by user",
			outputJson: getToolMessage("interruptedByUser", locale),
			completedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(narratorToolCalls.narratorId, narratorId),
				inArray(narratorToolCalls.status, [...INTERRUPTABLE_TOOL_CALL_STATUSES]),
			),
		);
}

/**
 * Mark orphaned tool calls as success — used when the agent loop is
 * intentionally aborted after plan approval (the tool did complete
 * successfully but the result event was never yielded).
 */
async function completeOrphanedToolCalls(narratorId: string): Promise<void> {
	const staleStatuses = ["initializing", "pending", "running"] as const;
	await db
		.update(narratorToolCalls)
		.set({ status: "success" })
		.where(
			and(
				eq(narratorToolCalls.narratorId, narratorId),
				inArray(narratorToolCalls.status, [...staleStatuses]),
			),
		);
}

export function abortActiveNarratorLoopForPlannedUpdateRecovery(
	narratorId: string,
	recoveryToken: string,
): boolean {
	const control = plannedUpdateRecoveryControls.get(narratorId);
	if (!control || control.token !== recoveryToken || !control.controller.signal.aborted) {
		return false;
	}
	const active = activeNarrators.get(narratorId);
	if (!active?.alive || !active._loopRunning) return false;
	active.abortController.abort(control.controller.signal.reason);
	return true;
}

export function interruptNarrator(narratorId: string): boolean {
	const active = activeNarrators.get(narratorId);
	const recovery = interruptPlannedUpdateRecovery(narratorId);
	if (!active && !recovery.interrupted) return false;
	active?.abortController.abort();
	// Stopping this narrator cancels the Agent tool calls of its current turn, and the
	// subagents those calls own must stop with them. The fan-out is what settles their
	// DB/UI state; membership is decided inside, per aborted tool call, so a subagent the
	// user is driving from its own panel (independent run signal, nobody's pending tool
	// call) is not swept up. A recovered Send await owns only the parent-side wait, so it
	// contributes no ids; a recovered foreground Agent names the subagent it re-drove,
	// because that continuation's signal is deliberately not this narrator's.
	if (active || recovery.foregroundSubagentIds.length > 0) {
		const explicitSubagentIds = recovery.foregroundSubagentIds;
		import("./narrator-subagent")
			.then(({ interruptForegroundSubagentsForParent }) =>
				interruptForegroundSubagentsForParent(narratorId, explicitSubagentIds),
			)
			.catch((err) => {
				logger.warn("Failed to interrupt foreground subagents", {
					narratorId,
					error: err instanceof Error ? err.message : String(err),
				});
			});
	}
	// Cleanup is handled by the agent loop's onErrorCleanup callback
	// when it detects the "Aborted" error — no need to duplicate here.
	logger.info("Narrator interrupted", { narratorId });
	return true;
}

/** Gracefully close a narrator. */
export function closeNarrator(narratorId: string): void {
	const active = activeNarrators.get(narratorId);
	if (!active) return;
	active.alive = false;
	if (active._gitTrackTimer) clearTimeout(active._gitTrackTimer);
	active.abortController.abort();
	clearStreamingSnapshot(narratorId);
	cleanupOrphanedToolCalls(narratorId, active.locale).catch((err) => {
		logger.error("Failed to clean up orphaned tool calls on close", {
			narratorId,
			error: String(err),
		});
	});
	// Clean up any browser sessions owned by this narrator
	import("../lib/browser/session")
		.then(({ cleanupNarrator }) => {
			cleanupNarrator(narratorId).catch((err) => {
				logger.warn("Failed to cleanup browser sessions", { narratorId, error: String(err) });
			});
		})
		.catch((err) => {
			logger.warn("Failed to load browser session module", { narratorId, error: String(err) });
		});
	logger.info("Narrator closed", { narratorId });
}

export function isNarratorActive(narratorId: string): boolean {
	return activeNarrators.has(narratorId);
}

/**
 * Whether an agent loop is actually executing for this narrator right now.
 *
 * This reads the authoritative in-memory `_loopRunning` flag rather than the DB
 * `status` snapshot, which can lag behind reality (e.g. a turn that was set idle
 * during post-turn drain, or an interrupt whose async abort has not yet finished
 * cleanup). Route-level admission checks use this so that a stale idle status
 * cannot let a second concurrent loop start.
 */
export function isLoopRunning(narratorId: string): boolean {
	const active = activeNarrators.get(narratorId);
	return active?.alive === true && active._loopRunning === true;
}

/**
 * Interrupt whatever this narrator is doing and wait until it has actually stopped.
 *
 * `interruptNarrator` only aborts the AbortController and returns immediately; the
 * loop notices the abort at its next await point and then runs its own cleanup
 * (status write, tool-call sealing, snapshot claim release) in a `finally`. So a
 * caller that wants to *replace* the narrator's history or its workspace cannot act
 * on the synchronous return value — it has to wait for the loop to leave.
 *
 * That waiting is why this exists rather than each caller polling: the authoritative
 * signal is the in-memory `_loopRunning`/`alive` pair, plus the runtime-claim
 * registry for parent-side work that runs with no loop at all
 * (`isNarratorRuntimeBusy`). A caller reading DB `status` instead would see idle
 * while the loop is still draining.
 *
 * Returns whether the narrator is idle now. `false` means it was still busy when
 * the budget ran out — the caller decides whether to refuse or proceed anyway; this
 * function deliberately does not throw, so a caller can treat a stubborn loop as a
 * warning rather than a hard failure.
 *
 * A pending permission is resolved as a denial first: that pause keeps the turn
 * alive with nobody driving it, so aborting alone would leave the loop parked on a
 * promise that no longer has a decider.
 */
export async function interruptAndWaitForIdle(
	narratorId: string,
	opts?: { timeoutMs?: number },
): Promise<boolean> {
	const busy = () => isLoopRunning(narratorId) || isNarratorRuntimeBusy(narratorId);
	if (!busy()) return true;

	// A suspended permission request is not something an abort can reach: the loop is
	// parked awaiting a decision, so denying the pending ones is what lets the turn
	// unwind. Keyed by requestId, and only the entries this narrator owns are touched
	// (an entry may merely be broadcast here on behalf of a subagent).
	for (const [requestId, pending] of [...pendingPermissions.entries()]) {
		if (pending.narratorId !== narratorId) continue;
		try {
			await resolvePermissionOrDangerReflection(requestId, "deny", {
				denyMessage: "Interrupted: the user is editing this session's history",
			});
		} catch (error) {
			logger.warn("Failed to deny pending permission while interrupting", {
				narratorId,
				requestId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	interruptNarrator(narratorId);

	const deadline = Date.now() + (opts?.timeoutMs ?? INTERRUPT_IDLE_TIMEOUT_MS);
	while (busy()) {
		if (Date.now() >= deadline) {
			logger.warn("Narrator did not go idle after an interrupt", { narratorId });
			return false;
		}
		await new Promise((resolve) => setTimeout(resolve, INTERRUPT_IDLE_POLL_MS));
	}
	// The loop's own `finally` writes its terminal status, but a runtime claim that
	// simply expired leaves the DB row behind; repair it so the UI is not stuck busy.
	await reconcileRunningStatus(narratorId);
	return true;
}

/**
 * Reconcile a narrator status that disagrees with the in-memory runtime, in
 * either direction. Returns true only when an actual correction was made.
 *
 * This is called from every path that buffers or rejects a user action because
 * the narrator looks busy. Without it a lying status leaves the user stuck.
 *
 * Forward (idle/archived → working): a loop IS running but the DB says it is
 * not. The frontend hides the interrupt button when status is idle, so the user
 * could neither continue (blocked) nor stop (no button). CAS only matches
 * ["idle", "archived"], so a legitimate waiting/reflecting state is never
 * overwritten. Clearing stale unread/error tags is intended here — the narrator
 * really is running, so those tags no longer apply.
 *
 * Reverse (working/waiting → idle): the DB claims running work but no runtime
 * owner exists — no loop, no permission or reflection pause, no registered
 * runtime claim. Such a row is a zombie: it outlived its writer, and every
 * admission check keyed on DB status ("Cannot continue…", "Cannot recover
 * subagents…") rejects the user forever while offering no way out.
 *
 * The reverse direction is what makes the status self-healing rather than
 * one-way, and it is deliberately conservative:
 * - `isNarratorRuntimeBusy` covers loop-less owners (recovery stages, the
 *   recovery Await batch) that legitimately hold a running status, so their work
 *   is never mistaken for a zombie;
 * - the substatus is carried over unchanged instead of being reset, because the
 *   reason the narrator stopped (`error`, `interrupted`) is exactly what the
 *   recovery UI keys on. Passing `[]` here would erase the error tag and hide
 *   the recovery card. Turn-timing tags are normalized by the status writer.
 */
export async function reconcileRunningStatus(narratorId: string): Promise<boolean> {
	if (isLoopRunning(narratorId)) {
		const changed = await narratorService.compareAndSetStatus(
			narratorId,
			["idle", "archived"],
			"working",
		);
		if (changed) {
			logger.warn("Reconciled stale narrator status → working (loop was actually running)", {
				narratorId,
			});
		}
		return changed;
	}

	if (isNarratorRuntimeBusy(narratorId)) return false;

	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { status: true, substatus: true },
	});
	if (narrator?.status !== "working" && narrator?.status !== "waiting") return false;

	const changed = await narratorService.compareAndSetStatus(
		narratorId,
		["working", "waiting"],
		"idle",
		{ substatus: parseSubstatus(narrator.substatus) },
	);
	if (changed) {
		logger.warn("Reconciled zombie narrator status → idle (no runtime owner)", {
			narratorId,
			previousStatus: narrator.status,
		});
	}
	return changed;
}

/**
 * Whether a soft-stop for queued input still has something to deliver.
 *
 * A soft stop is only worth taking at a tool boundary when the work that
 * requested it is still pending: the buffer queue holds priority "cut in after
 * the current tool call" messages. If the user cancels the queued message before
 * the boundary is reached, there is nothing left and the loop must keep running.
 */
function hasPendingBufferedWork(narratorId: string): boolean {
	return (bufferedMessages.get(narratorId)?.length ?? 0) > 0;
}

/**
 * Decide whether the agent loop should soft-stop at the current tool boundary.
 *
 * Both flags are consumed once, mirroring the one-shot request semantics:
 * - `feedbackSoftStop` (permission approval with attached text) always stops;
 *   its payload lives in `pendingFeedback` and is not cancellable.
 * - `bufferSoftStop` only stops when its queued input still exists. Cancelling
 *   the queued message before the boundary leaves nothing to resume, so the
 *   request is dropped and the turn continues.
 *
 * `softStopTaken` reports whether a buffered soft stop was actually consumed, so
 * the caller can resume the turn if the queue empties out before the pass ends.
 */
export function evaluateSoftStopRequest(flags: {
	feedbackSoftStop?: boolean;
	bufferSoftStop?: boolean;
	hasPendingBufferedWork: boolean;
}): {
	stop: boolean;
	feedbackSoftStop: boolean;
	bufferSoftStop: boolean;
	softStopTaken: boolean;
} {
	if (flags.feedbackSoftStop) {
		return {
			stop: true,
			feedbackSoftStop: false,
			bufferSoftStop: flags.bufferSoftStop ?? false,
			softStopTaken: false,
		};
	}
	if (flags.bufferSoftStop) {
		return {
			stop: flags.hasPendingBufferedWork,
			feedbackSoftStop: false,
			bufferSoftStop: false,
			softStopTaken: flags.hasPendingBufferedWork,
		};
	}
	return { stop: false, feedbackSoftStop: false, bufferSoftStop: false, softStopTaken: false };
}

export function requestBufferedMessageSoftStop(narratorId: string): boolean {
	const active = activeNarrators.get(narratorId);
	if (!active?.alive) return false;
	active._bufferSoftStop = true;
	return true;
}

/**
 * Re-arm a cut-in soft stop that another producer is about to step in front of.
 *
 * `evaluateSoftStopRequest` consumes `_bufferSoftStop` when it grants the stop, on
 * the assumption that the queued message is consumed right after the pass returns.
 * Several branches in `runAgentLoop` break that assumption: chained permission
 * feedback, the review git-state guard and the injection drain each start a FRESH
 * pass before the buffer consumer is reached. That new pass has no soft-stop
 * request left, so `shouldStop()` stays false for its entire duration and the
 * queued message waits through every remaining tool call until the whole loop
 * ends — the "it says it cut in, but it only arrived at the very end" report.
 *
 * Re-arming costs nothing when the queue is empty (the flag is only honoured while
 * `hasPendingBufferedWork` holds), and the stepping-in producer keeps its priority:
 * its own text still rides on the turn being started here.
 */
export function rearmCutInSoftStopBeforeContinuing(active: ActiveNarrator): void {
	if (!active._bufferSoftStopTaken) return;
	if (!hasPendingBufferedWork(active.narratorId)) return;
	active._bufferSoftStopTaken = false;
	active._bufferSoftStop = true;
}

/**
 * Drop a pending soft-stop request when its queued input is gone (cancelled or
 * fully consumed). Without this the flag survives until the next tool boundary
 * and ends the turn with nothing to resume, which looks like the narrator
 * stopping on its own right after the current tool call.
 */
export function clearBufferedMessageSoftStopIfIdle(narratorId: string): void {
	const active = activeNarrators.get(narratorId);
	if (!active?._bufferSoftStop) return;
	if (hasPendingBufferedWork(narratorId)) return;
	active._bufferSoftStop = false;
}

// === Dynamic narrator controls ===

function resolveRuntimeReasoningEffort(
	provider: string,
	model: string,
	reasoningEffort: ReasoningEffort | null | undefined,
): ReasoningEffort | null {
	return reasoningEffort ?? resolveDefaultReasoningEffort(provider, model) ?? null;
}

export function updateNarratorModel(narratorId: string, model: string): void {
	const active = activeNarrators.get(narratorId);
	if (active?.alive) {
		active._modelRef = model || FOLLOW_DEFAULT_MODEL;
		active._settingsRevision = getSettingsRevision();
		const effectiveModel = resolveEffectiveModel(active._modelRef, active.provider);
		active.model = effectiveModel;
		active.provider = resolveProvider(effectiveModel);
		active.reasoningEffort = resolveRuntimeReasoningEffort(
			active.provider,
			active.model,
			active._reasoningEffortRef,
		);
		broadcastToNarrator(narratorId, {
			type: "model_changed",
			narratorId,
			model,
		});
		broadcastToNarrator(narratorId, {
			type: "model_settings_changed",
			narratorId,
			model: effectiveModel,
			reasoningEffort: active.reasoningEffort ?? null,
			status: active._loopRunning ? "pending" : "updated",
			applyAt: active._loopRunning ? "next_model_request" : "next_request",
		});
	} else if (updateActiveSubagentModel(narratorId, resolveEffectiveModel(model))) {
		// Subagent: update lightweight settings map; loop picks it up via getRuntimeSettingsOverride
		const effectiveModel = resolveEffectiveModel(model);
		const sa = activeSubagentSettings.get(narratorId);
		broadcastToNarrator(narratorId, {
			type: "model_settings_changed",
			narratorId,
			model: effectiveModel,
			reasoningEffort: sa?.reasoningEffort ?? null,
			status: "pending",
			applyAt: "next_model_request",
		});
	}
}

export function updateNarratorReasoningEffort(
	narratorId: string,
	reasoningEffort: ReasoningEffort | null,
): void {
	const active = activeNarrators.get(narratorId);
	if (active?.alive) {
		active._reasoningEffortRef = reasoningEffort;
		active.reasoningEffort = resolveRuntimeReasoningEffort(
			active.provider,
			active.model,
			active._reasoningEffortRef,
		);
		broadcastToNarrator(narratorId, {
			type: "model_settings_changed",
			narratorId,
			model: active.model,
			reasoningEffort: active.reasoningEffort,
			status: active._loopRunning ? "pending" : "updated",
			applyAt: active._loopRunning ? "next_model_request" : "next_request",
		});
	} else if (updateActiveSubagentReasoningEffort(narratorId, reasoningEffort)) {
		// Subagent: update lightweight settings map; loop picks it up via getRuntimeSettingsOverride
		const sa = activeSubagentSettings.get(narratorId);
		broadcastToNarrator(narratorId, {
			type: "model_settings_changed",
			narratorId,
			model: sa?.model ?? "",
			reasoningEffort,
			status: "pending",
			applyAt: "next_model_request",
		});
	}
}

/**
 * Set a temporary model override for the current agent loop.
 * Persists the original model to DB so it survives server restarts.
 * After the loop finishes, the model will be restored automatically.
 */
export async function setTemporaryModelRestore(
	narratorId: string,
	originalModel: string,
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.update(narrators)
		.set({ pendingModelRestore: originalModel, updatedAt: now })
		.where(eq(narrators.id, narratorId));
}

/**
 * Restore models for all narrators that have a pending temporary model override.
 * Called once at server startup to recover from unclean shutdowns.
 */
export async function restorePendingModelOverrides(): Promise<void> {
	const pending = await db.query.narrators.findMany({
		where: isNotNull(narrators.pendingModelRestore),
		columns: { id: true, pendingModelRestore: true },
	});
	if (pending.length === 0) return;

	const now = new Date().toISOString();
	for (const n of pending) {
		await db
			.update(narrators)
			.set({
				model: n.pendingModelRestore,
				pendingModelRestore: null,
				updatedAt: now,
			})
			.where(eq(narrators.id, n.id));
		logger.info("Restored model from pending temporary override on startup", {
			narratorId: n.id,
			restoreModel: n.pendingModelRestore,
		});
	}
}

/** Update the cached chapter role for a live narrator (e.g. after promote). */
export function updateNarratorChapterRole(narratorId: string, role: string): void {
	const active = activeNarrators.get(narratorId);
	if (active) {
		active._chapterRole = role;
	}
}

export async function updateNarratorPermissionMode(
	_narratorId: string,
	_mode: string,
): Promise<void> {
	// Permission mode is read from DB in real-time by handlePermission.
	// Plan mode is now a narrator trait and is managed by Enter/ExitPlanMode handlers.
}

// === Startup recovery ===

/**
 * Guard against running recovery during Bun --hot reloads.
 * In --hot mode the process stays alive but modules are re-evaluated,
 * so activeNarrators is reset to an empty Map while agent loops are
 * still running in the background.  Running recovery in that state
 * would incorrectly mark in-flight tool calls as "server restart".
 *
 * We use a globalThis flag that survives module re-evaluation (the
 * process is the same) to detect hot reloads vs. cold starts.
 */
const HOT_RELOAD_GUARD = Symbol.for("narrafork.narrator.initialized");

const REFLECTION_SUGGESTION_TYPES = new Set([
	"danger_reflection",
	"plan_reflection",
	"task_reflection",
	"question_reflection",
]);
const ACTIVE_REFLECTION_SUGGESTION_STATUSES = new Set(["running", "awaiting_user"]);

function abortActiveReflectionSuggestions(
	suggestions: unknown,
	reason: string,
	resolvedAt: string,
): unknown[] | undefined {
	if (!Array.isArray(suggestions)) return undefined;
	let changed = false;
	const next = suggestions.map((suggestion) => {
		if (!suggestion || typeof suggestion !== "object" || Array.isArray(suggestion)) {
			return suggestion;
		}
		const record = suggestion as Record<string, unknown>;
		const type = typeof record.type === "string" ? record.type : "";
		if (!REFLECTION_SUGGESTION_TYPES.has(type)) return suggestion;

		const status = typeof record.status === "string" ? record.status : "running";
		if (!ACTIVE_REFLECTION_SUGGESTION_STATUSES.has(status)) return suggestion;

		changed = true;
		return {
			...record,
			status: "aborted",
			reason,
			resolvedAt,
		};
	});
	return changed ? next : undefined;
}

function logNarratorIntegrityDiagnostics(): void {
	try {
		const fullForkEmptyRefs = sqlite
			.prepare(
				`SELECT n.id, n.parent_narrator_id AS parentNarratorId,
					(SELECT count(*) FROM narrator_message_refs pr WHERE pr.narrator_id = n.parent_narrator_id) AS parentRefCount
				 FROM narrators n
				 WHERE n.inherit_mode = 'full'
				   AND n.parent_narrator_id IS NOT NULL
				   AND NOT EXISTS (SELECT 1 FROM narrator_message_refs r WHERE r.narrator_id = n.id)
				   AND EXISTS (SELECT 1 FROM narrator_message_refs pr WHERE pr.narrator_id = n.parent_narrator_id)
				 LIMIT 20`,
			)
			.all();
		if (fullForkEmptyRefs.length > 0) {
			logger.warn("Narrator integrity diagnostic: full forks with empty local refs", {
				count: fullForkEmptyRefs.length,
				samples: fullForkEmptyRefs,
			});
		}

		const missingForkRefs = sqlite
			.prepare(
				`SELECT n.id, n.parent_narrator_id AS parentNarratorId, n.fork_message_id AS forkMessageId, n.inherit_mode AS inheritMode
				 FROM narrators n
				 WHERE n.fork_message_id IS NOT NULL
				   AND n.parent_narrator_id IS NOT NULL
				   AND NOT EXISTS (
				     SELECT 1 FROM narrator_message_refs r
				     WHERE r.narrator_id = n.parent_narrator_id
				       AND r.message_id = n.fork_message_id
				   )
				 LIMIT 20`,
			)
			.all();
		if (missingForkRefs.length > 0) {
			logger.warn("Narrator integrity diagnostic: fork messages missing from parent refs", {
				count: missingForkRefs.length,
				samples: missingForkRefs,
			});
		}
	} catch (err) {
		logger.warn("Narrator integrity diagnostics failed", { error: String(err) });
	}
}

export interface NarratorStartupProtectionSets {
	toolCallIds?: ReadonlySet<string>;
	narratorIds?: ReadonlySet<string>;
	backgroundTaskIds?: ReadonlySet<string>;
}

/** Clean up stale in-progress states left by a previous server run. */
export async function recoverOnStartup(
	protection: NarratorStartupProtectionSets = {},
): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: globalThis symbol key
	if ((globalThis as any)[HOT_RELOAD_GUARD]) {
		logger.info("Skipping narrator recovery (hot reload detected)");
		return;
	}
	// biome-ignore lint/suspicious/noExplicitAny: globalThis symbol key
	(globalThis as any)[HOT_RELOAD_GUARD] = true;

	// Clean up any residual worktree watchers from a previous server run.
	// On restart (or hot reload), old fs.watch handles may leak if the previous
	// process didn't shut down cleanly, causing phantom CPU usage from inotify.
	worktreeWatcher.shutdown();

	const now = new Date().toISOString();
	// Legacy status migrations (from older DB versions).
	// Note: "thinking" is already migrated to "working" by db/index.ts at startup,
	// so it is not included here. These handle even older status values.
	const legacyMigrations = [
		["active", "idle", "[]"],
		["paused", "idle", "[]"],
		["completed", "archived", "[]"],
	] as const;
	const legacyStmt = sqlite.prepare(
		"UPDATE narrators SET status = ?, substatus = ?, updated_at = ? WHERE status = ?",
	);
	for (const [from, to, sub] of legacyMigrations) {
		const result = legacyStmt.run(to, sub, now, from);
		if (result.changes > 0) {
			logger.info(`Narrator status migrated: ${from} → ${to}`, { count: result.changes });
		}
	}

	// Legacy plan permission mode migration: plan is now a narrator trait.
	const legacyPlanRows = sqlite
		.prepare(
			"SELECT id, traits, previous_permission_mode FROM narrators WHERE permission_mode = 'plan'",
		)
		.all() as Array<{ id: string; traits: string | null; previous_permission_mode: string | null }>;
	for (const row of legacyPlanRows) {
		const traits = addTrait(parseTraits(row.traits), "plan");
		const permissionMode = normalizeLegacyPlanPreviousPermissionMode(row.previous_permission_mode);
		sqlite
			.prepare(
				"UPDATE narrators SET permission_mode = ?, traits = ?, plan_mode = 1, previous_permission_mode = ?, plan_file_id = ?, updated_at = ? WHERE id = ?",
			)
			.run(permissionMode, JSON.stringify(traits), permissionMode, generateWordSlug(), now, row.id);
	}
	if (legacyPlanRows.length > 0) {
		logger.info("Legacy plan permission mode migrated to narrator trait", {
			count: legacyPlanRows.length,
		});
	}

	// Active narrators interrupted by an ordinary restart are marked interrupted. Narrators
	// covered by the planned-update manifest stay active until their continuations reattach.
	for (const activeStatus of ["working", "waiting"] as const) {
		const activeRows = await db.query.narrators.findMany({
			where: eq(narrators.status, activeStatus),
			columns: { id: true },
		});
		const interruptedIds = activeRows
			.map((row) => row.id)
			.filter((id) => !protection.narratorIds?.has(id));
		if (interruptedIds.length > 0) {
			await db
				.update(narrators)
				.set({ status: "idle", substatus: '["interrupted"]', updatedAt: now })
				.where(inArray(narrators.id, interruptedIds));
			logger.info(`Narrator status migrated: ${activeStatus} → idle [interrupted]`, {
				count: interruptedIds.length,
			});
		}
	}
	await backgroundTaskService.recoverStaleTasksAfterRestart(protection.backgroundTaskIds);

	// Defensive cleanup: strip transient "reflecting"/"reasoning" tags left on any
	// resting narrator. These are mid-turn tags that must never survive a completed
	// loop; a swallowed clear (DB lock) or a status-drift CAS no-op could otherwise
	// pin the sidebar tab icon purple across restarts. The interrupt migration above
	// already reset working/waiting narrators, so only idle/archived rows remain.
	const staleTransientRows = sqlite
		.prepare(
			"SELECT id, substatus FROM narrators WHERE substatus LIKE '%reflecting%' OR substatus LIKE '%reasoning%'",
		)
		.all() as Array<{ id: string; substatus: string | null }>;
	let clearedTransient = 0;
	const clearTransientStmt = sqlite.prepare(
		"UPDATE narrators SET substatus = ?, updated_at = ? WHERE id = ?",
	);
	for (const row of staleTransientRows) {
		const tags = parseSubstatus(row.substatus);
		const kept = tags.filter((t) => t !== "reflecting" && t !== "reasoning");
		if (kept.length !== tags.length) {
			clearTransientStmt.run(JSON.stringify(kept), now, row.id);
			clearedTransient++;
		}
	}
	if (clearedTransient > 0) {
		logger.info("Cleared stale transient substatus tags on startup", {
			count: clearedTransient,
		});
	}

	logNarratorIntegrityDiagnostics();

	const stalePermissions = await db.query.narratorToolCalls.findMany({
		where: eq(narratorToolCalls.status, "pending"),
	});
	if (stalePermissions.length > 0) {
		let staleReflectionCount = 0;
		const restartMessage = "Interrupted by server restart";
		for (const toolCall of stalePermissions) {
			if (protection.toolCallIds?.has(toolCall.id)) continue;
			const abortedSuggestions = abortActiveReflectionSuggestions(
				toolCall.permissionSuggestions,
				restartMessage,
				now,
			);
			if (abortedSuggestions) staleReflectionCount++;
			await db
				.update(narratorToolCalls)
				.set({
					status: "fail",
					errorMessage: restartMessage,
					permissionDecidedBy: "server_restart",
					permissionDecidedAt: now,
					...(abortedSuggestions
						? {
								permissionDecisionReason: restartMessage,
								permissionSuggestions: abortedSuggestions,
							}
						: {}),
				})
				.where(eq(narratorToolCalls.id, toolCall.id));
		}
		logger.info("Stale pending tool calls auto-denied on startup", {
			count: stalePermissions.length,
			staleReflectionCount,
		});
	}

	const staleToolCalls = (
		await db.query.narratorToolCalls.findMany({
			where: eq(narratorToolCalls.status, "running"),
		})
	).filter((toolCall) => !protection.toolCallIds?.has(toolCall.id));
	if (staleToolCalls.length > 0) {
		await db
			.update(narratorToolCalls)
			.set({
				status: "fail",
				errorMessage: "Interrupted by server restart",
				outputJson: getToolMessage("interruptedByServerRestart"),
			})
			.where(
				inArray(
					narratorToolCalls.id,
					staleToolCalls.map((toolCall) => toolCall.id),
				),
			);
		logger.info("Stale running tool calls marked as failed on startup", {
			count: staleToolCalls.length,
		});
	}

	// Also recover tool calls stuck in "initializing" (permission check never started)
	const staleInitializing = (
		await db.query.narratorToolCalls.findMany({
			where: eq(narratorToolCalls.status, "initializing"),
		})
	).filter((toolCall) => !protection.toolCallIds?.has(toolCall.id));
	if (staleInitializing.length > 0) {
		await db
			.update(narratorToolCalls)
			.set({
				status: "fail",
				errorMessage: "Interrupted by server restart",
				outputJson: getToolMessage("interruptedByServerRestart"),
			})
			.where(
				inArray(
					narratorToolCalls.id,
					staleInitializing.map((toolCall) => toolCall.id),
				),
			);
		logger.info("Stale initializing tool calls marked as failed on startup", {
			count: staleInitializing.length,
		});
	}

	// Preserve modern compact lifecycle records across restarts. Running attempts
	// become failed audit entries; only legacy placeholders with no attempt/retry
	// history are removed.
	const staleCompactRecovery = await recoverStaleCompactingMessages();
	if (staleCompactRecovery.preserved > 0 || staleCompactRecovery.deleted > 0) {
		logger.info("Stale compacting messages recovered on startup", staleCompactRecovery);
	}

	const transientCompactRows = await db.query.narrators.findMany({
		columns: { id: true, substatus: true },
	});
	for (const row of transientCompactRows) {
		const current = parseSubstatus(row.substatus);
		const next = current.filter((tag) => tag !== "compacting" && tag !== "background_compacting");
		if (next.length !== current.length) {
			await narratorService.updateSubstatus(row.id, next).catch((err) => {
				logger.warn("Failed to clear stale compact substatus on startup", {
					narratorId: row.id,
					error: String(err),
				});
			});
		}
	}

	// Recover persisted buffered messages into the in-memory Map.
	// These survive server restarts so users don't lose queued messages.
	const bufferedRows = db
		.select()
		.from(narratorBufferedMessages)
		.orderBy(narratorBufferedMessages.narratorId, narratorBufferedMessages.seq)
		.all();
	if (bufferedRows.length > 0) {
		const grouped = new Map<string, BufferedMessage[]>();
		for (const row of bufferedRows) {
			const images: ImageRef[] | undefined = row.imagesJson
				? JSON.parse(row.imagesJson)
				: undefined;
			const creator: BufferCreator | null = row.creatorJson ? JSON.parse(row.creatorJson) : null;
			const savedFiles: SavedBufferedFile[] | undefined = row.textFilePathsJson
				? JSON.parse(row.textFilePathsJson)
				: undefined;
			const textFiles = savedFiles?.length ? loadBufferedTextFiles(savedFiles) : undefined;
			const entry: BufferedMessage = {
				id: row.id,
				text: row.text,
				images,
				textFiles: textFiles?.length ? textFiles : undefined,
				bufferedAt: row.bufferedAt,
				commandText: row.commandText,
				bashCommand: row.bashCommand,
				createdBy: row.createdBy,
				creator,
				priority: row.priority,
				_savedFiles: savedFiles,
			};
			const list = grouped.get(row.narratorId) ?? [];
			list.push(entry);
			grouped.set(row.narratorId, list);
		}
		for (const [nid, msgs] of grouped) {
			bufferedMessages.set(nid, msgs);
		}
		logger.info("Recovered buffered messages from DB on startup", {
			narrators: grouped.size,
			messages: bufferedRows.length,
		});
	}
}

// ---------------------------------------------------------------------------
// Optional tool management
// ---------------------------------------------------------------------------

/**
 * Whether an optional tool would be visible to the model on the next turn.
 *
 * Mirrors the resolution order used when building a session (`ensureActive`) and
 * the loop `toolFilter`, so the UI can tell "not loaded" from "loaded" without
 * starting a session:
 *   1. custom trait deny-list wins (tool hidden even if loaded)
 *   2. active session's in-memory set, when a session exists
 *   3. otherwise: globally enabled tool routine, or persisted `enabledTools`
 *
 * Returns `unknown_tool` for names outside OPTIONAL_TOOLS.
 */
export async function resolveOptionalToolState(
	narratorId: string,
	toolName: string,
	/** Acting user, so the user trait layer applies. Optional for legacy callers. */
	actingUserId?: string | null,
): Promise<{
	state: "loaded" | "not_loaded" | "disabled_by_trait" | "unknown_tool";
	/** True when a global tool routine already enables it for every session. */
	globallyEnabled: boolean;
}> {
	if (!OPTIONAL_TOOLS.has(toolName)) {
		return { state: "unknown_tool", globallyEnabled: false };
	}

	const disabledRoutines = new Set(settings.routines?.disabledRoutines ?? []);
	const enabledRoutines = new Set(settings.routines?.enabledRoutines ?? []);
	let globallyEnabled = false;
	for (const routine of getBuiltinToolRoutines()) {
		if (!routine.tool) continue;
		if (!getBuiltinToolNames(routine.tool).includes(toolName)) continue;
		globallyEnabled = routine.defaultEnabled
			? !disabledRoutines.has(routine.id)
			: enabledRoutines.has(routine.id);
		if (globallyEnabled) break;
	}

	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: {
			enabledTools: true,
			traits: true,
			chapterId: true,
			contextProjectId: true,
		},
	});
	if (!narrator) throw new NotFoundError("Narrator", narratorId);

	// Layered, so the UI reports a project/user-level deny as disabled_by_trait
	// instead of claiming the tool is merely not loaded.
	const { resolveEffectiveTraits, resolveNarratorProjectId } = await import(
		"./trait-layer-service"
	);
	const stateTraits = await resolveEffectiveTraits({
		narratorTraits: narrator.traits,
		projectId: await resolveNarratorProjectId(narrator),
		actingUserId: actingUserId ?? null,
	});
	if (getDisabledToolSet(stateTraits.traits).has(toolName)) {
		return { state: "disabled_by_trait", globallyEnabled };
	}

	const active = activeNarrators.get(narratorId);
	if (active) {
		return {
			state: active._enabledOptionalTools.has(toolName) ? "loaded" : "not_loaded",
			globallyEnabled,
		};
	}

	const persisted = Array.isArray(narrator.enabledTools) ? narrator.enabledTools : [];
	const loaded = globallyEnabled || persisted.includes(toolName);
	return { state: loaded ? "loaded" : "not_loaded", globallyEnabled };
}

/**
 * Enable an optional tool for a narrator.
 * Persists to DB and updates the in-memory session if active.
 */
export async function loadOptionalTool(
	narratorId: string,
	toolName: string,
): Promise<"loaded" | "already_loaded" | "unknown_tool"> {
	if (!OPTIONAL_TOOLS.has(toolName)) return "unknown_tool";

	// Read current enabled tools from DB
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { enabledTools: true },
	});
	const current: string[] = (narrator?.enabledTools as string[] | null) ?? [];
	if (current.includes(toolName)) return "already_loaded";

	// Persist
	await db
		.update(narrators)
		.set({ enabledTools: [...current, toolName] })
		.where(eq(narrators.id, narratorId));

	// Also update in-memory session if active
	const active = activeNarrators.get(narratorId);
	if (active) {
		active._enabledOptionalTools.add(toolName);
	}

	logger.info("Optional tool loaded", { narratorId, toolName });
	return "loaded";
}

/**
 * Disable an optional tool for a narrator.
 * Removes it from DB and updates the in-memory session if active.
 */
export async function unloadOptionalTool(
	narratorId: string,
	toolName: string,
): Promise<"unloaded" | "not_loaded" | "unknown_tool"> {
	if (!OPTIONAL_TOOLS.has(toolName)) return "unknown_tool";

	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { enabledTools: true },
	});
	const current: string[] = (narrator?.enabledTools as string[] | null) ?? [];
	const next = current.filter((name) => name !== toolName);
	const wasPersisted = next.length !== current.length;

	const active = activeNarrators.get(narratorId);
	const wasActive = active?._enabledOptionalTools.has(toolName) ?? false;

	if (!wasPersisted && !wasActive) return "not_loaded";

	if (wasPersisted) {
		await db.update(narrators).set({ enabledTools: next }).where(eq(narrators.id, narratorId));
	}

	if (active) {
		active._enabledOptionalTools.delete(toolName);
	}

	logger.info("Optional tool unloaded", { narratorId, toolName });
	return "unloaded";
}

/** Get the set of enabled optional tool names for a narrator session. */
export function getEnabledOptionalTools(narratorId: string): Set<string> {
	const active = activeNarrators.get(narratorId);
	return active?._enabledOptionalTools ?? new Set();
}

export function updateActiveDisabledTools(narratorId: string, tools: Iterable<string>): void {
	const active = activeNarrators.get(narratorId);
	if (!active) return;
	active._disabledTools = new Set(tools);
}

export function updateActiveBlockedSkills(
	narratorId: string,
	blocked: { all: boolean; names: Iterable<string> },
): void {
	const active = activeNarrators.get(narratorId);
	if (!active) return;
	active._blockedSkills = { all: blocked.all, names: new Set(blocked.names) };
}

// === Re-exports from extracted modules ===
// These maintain backward compatibility for external imports.

export {
	clearBufferedMessages,
	getBufferedMessages,
	pushBufferedMessage,
	removeBufferedMessage,
	reorderBufferedMessages,
	toBufferSummary,
	updateBufferedMessage,
} from "./narrator-buffer";
export {
	awaitCompactCompletion,
	cancelCompact,
	compactLocks,
	isCompactInProgress,
	markCompactAsBlocking,
	pruneLocks,
	pruneToolCalls,
	retryFailedCompact,
	runCustomCompact,
	runSegmentCompact,
	shouldFinalizeAbortBeforeRecovery,
} from "./narrator-compact";
export type {
	BlacklistDir,
	CommandBlacklistEntry,
	CommandWhitelistEntry,
	PermissionDecisionMeta,
	PermissionDecisionOpts,
	ResolvePermissionOpts,
	WhitelistDir,
} from "./narrator-permission";
export {
	cancelPendingExitPlanMode,
	classifyDanger,
	createDangerFingerprint,
	extractToolPaths,
	handlePermission,
	isInsideWorktree,
	normalizeDangerReflectionLevel,
	reprocessAllPendingPermissions,
	resolveDangerReflectionLevel,
	resolveDecisionNarratorId,
	resolvePermission,
	resolvePermissionDecision,
	resolvePermissionOrDangerReflection,
	shouldTriggerDangerReflection,
} from "./narrator-permission";

export type { BufferCreator, NarratorEvent } from "./narrator-session-state";
