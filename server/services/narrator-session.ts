import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";
import type { MessageOriginOptions } from "@shared/message-origin";
import { FOLLOW_PARENT_MODEL } from "@shared/model-inheritance";
import { isDanglingReasoningOnlyAssistantMessage } from "@shared/reasoning-content";
import {
	isPreloadedMode,
	type RoutineModeConfig,
	resolveEffectiveToolRoutineMode,
	type ToolRoutineMode,
} from "@shared/routine-modes";
import {
	MAX_EDIT_IMAGES_PER_MESSAGE,
	MAX_EDIT_TEXT_FILES_PER_MESSAGE,
	MAX_NARRATOR_ATTACHMENT_BYTES,
} from "@shared/text-file-types";
import { and, desc, eq, exists, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, sqlite } from "../db";
import {
	chapters,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
} from "../db/schema";
import type { ReasoningEffort } from "../lib/agent";
import { diagnosticsFromError } from "../lib/agent/error-diagnostics";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import {
	clearBehaviorFenceEditGrant,
	grantBehaviorFenceEdit,
} from "../lib/agent/tools/behavior-fence-grant";
import { OPTIONAL_TOOLS } from "../lib/agent/tools/index";
import { buildAttachedFilesHint } from "../lib/attached-files";
import {
	type BooleanOverride,
	type DangerReflectionOverride,
	normalizeAutoContinuationMode,
	normalizeBooleanOverride,
	normalizeDangerReflectionOverride,
	resolveAutoContinuationMode,
} from "../lib/boolean-override";
import { getBuiltinToolNames, getBuiltinToolRoutines } from "../lib/builtin-routines";
import { resolveInjectedDevices } from "../lib/device-injection-trait";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { InjectionCadence } from "../lib/injection-cadence";
import { logger } from "../lib/logger";
import { getBlockedSkills, getDisabledToolSet } from "../lib/narrator-custom-traits";
import {
	addTrait,
	isKnowledgeStewardNarrator,
	isPlanModeTrait,
	isSubagentVariant,
	parseSubstatus,
	parseTraits,
} from "../lib/narrator-utils";
import { normalizeLegacyPlanPreviousPermissionMode } from "../lib/permission-modes";
import { resolveExistingPlanFileRelPath } from "../lib/plan-file-path";
import { getHome } from "../lib/platform";
import { getBlockedTaskActionInstruction, getToolMessage, type Locale } from "../lib/prompt-i18n";
import {
	FOLLOW_DEFAULT_MODEL,
	getAutoCompactKeepPairs,
	getContextThresholds,
	getSettingsRevision,
	resolveDefaultReasoningEffort,
	resolveEffectiveModel,
	resolveProvider,
	settings,
} from "../lib/settings";
import { sideCarBodyWithText } from "../lib/sidecar-templates";
import type { ImageRef, PersistedUserImageBlock, TextFileRef } from "../lib/uploads";
import {
	copyTextFileToWorktree,
	deleteCreatedAttachmentFiles,
	deleteUploadedImage,
	getUploadedImageInfo,
	imageRefToContentBlock,
	isFileWithinWorktree,
	saveTextFileToWorktree,
	saveUploadedImage,
	validateTextFile,
	validateUploadedImage,
	validImageDimension,
} from "../lib/uploads";
import { generateWordSlug } from "../lib/words";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import {
	type AgentMessageDelivery,
	agentMessageDeliveryBody,
	consumeAgentMessageDelivery,
	consumeMailboxDelivery,
	type MailboxDeliveryConsumption,
} from "./agent-message-delivery";
import { buildRuntimeHistory } from "./agent-runtime/history";
import {
	claimInboxHead,
	deliverInboxInjection,
	flushInboxPublicationBarrier,
	hasInboxKind,
	type InboxAgentMetadata,
	inboxClaim,
	inboxConsumption,
	inboxMetadata,
	materializeClaimedInboxUserMessage,
	peekInbox,
	persistClaimedUserInput,
	releaseInboxClaim,
	runtimeInbox,
	wakeInboxIfEligible,
	withInboxOwner,
} from "./agent-runtime/inbox";
import { createInheritedModelRuntime } from "./agent-runtime/inherited-model";
import { MAILBOX_LIMITS } from "./agent-runtime/limits";
import { runAgentLoopUnlocked } from "./agent-runtime/orchestrator";
import {
	createRuntimeMapView,
	type ExecutionOwner,
	getExecutionOwner,
	isExecutionSuspended,
	tryClaimExecution,
} from "./agent-runtime/ownership";
import {
	type RuntimeMailboxRow,
	resolveRuntimeQueueBackend,
} from "./agent-runtime/runtime-queue-port";
import { backgroundTaskService } from "./background-task-service";
import {
	backgroundAgentNoticePreview,
	formatBackgroundCompletionNotifications,
} from "./bg-completion-queue";
import { gitService } from "./git-service";
import { resolveNarratorSessionCwd } from "./narrator-cwd";
import {
	clearStreamingSnapshot,
	type EventHooks,
	persistDetachedToolResult,
	type TokenUsageSnapshot,
} from "./narrator-event-handler";
import { deliverInjection } from "./narrator-injection";
import { isFirstUserTurn } from "./narrator-message-count";
import { resolveNarratorProjectId as resolveSharedNarratorProjectId } from "./narrator-project";
import { buildEffectiveSystemPrompt } from "./narrator-prompt";
import type { QuestionExecutionPrincipal } from "./narrator-question-service";
import { getNarratorMessageRefsPort } from "./narrator-refs/store";
import {
	enrichToolUseBlocks,
	handleBashCommand,
	narratorService,
	truncateToolIO,
} from "./narrator-service";
import { generateQuickTitle, setProvisionalTitleFromUserMessage } from "./narrator-title";
import { resolveContinueTurnTiming } from "./narrator-turn-timing";
import {
	assertOAuthNarratorRuntimeActive,
	type OAuthNarratorRuntimePolicy,
} from "./oauth-narrator-runtime-policy";
import { formatParentInboundMessages } from "./parent-inbound-queue";
import {
	migrateLegacyParentInjections,
	type PendingInjection,
	projectPendingInjection,
} from "./parent-injection-queue";
import { broadcastSpecChanged } from "./spec-broadcast";
import { buildBehaviorFenceBody, buildSpecTaskDigestBody } from "./spec-reminder";
import { compileSpecTasks, parseSpecTasksDocument } from "./spec-task-service";
import { drainSpecUpdatesForNarrator } from "./spec-update-queue";
import { specVfsService } from "./spec-vfs-service";
import { appendSubagentFileChanges } from "./subagent-file-changes";
import { agentResultTag, resolveAgentLabel } from "./subagent-label";
import {
	getConclusionWatcher,
	getManualOverrideMap,
	registerConclusionWatcher,
	resolveManualOverride,
} from "./subagent-manual-override";
import { resolveSubagentModelForRun, subagentRunReasoningEffort } from "./subagent-model";
import { isTakenOver } from "./subagent-takeover";
import { buildFinalToolStartAuthorization } from "./tool-final-start-authorization";
import { resolveEffectiveTraits } from "./trait-layer-service";
import { worktreeWatcher } from "./worktree-watcher";

// === In-memory state (imported from narrator-session-state) ===

import type { ActiveNarrator, BufferedMessage, NarratorEvent } from "./narrator-session-state";
import {
	activeNarrators,
	activeSubagentSettings,
	claimNarratorRuntime,
	clearActiveHistoryCompactPending,
	compactLocks,
	consumePlanModePromptRebuild,
	hasNarratorAdmissionWork,
	hasPendingHistoryCompact,
	isNarratorRevertAdmissionBlocked,
	isNarratorRuntimeBusy,
	listNarratorAdmissionOwners,
	narratorCreationLocks,
	narratorLoopAdmissions,
	pendingFeedback,
	pendingPermissions,
	pendingPlanApprover,
	pendingPlanApproverSource,
	pendingPlanCompact,
	pendingPlanDiff,
	planModeAskedOnce,
	reserveNarratorRevertAdmission,
	resolveNarratorAdmissionRoot,
	updateActiveSubagentModel,
	updateActiveSubagentReasoningEffort,
	waitForNarratorAdmissionWork,
	withNarratorMutationAdmission,
	withNarratorStartAdmission,
	withNarratorWorkAdmission,
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
	const releaseRuntimeClaim = claimNarratorRuntime(narratorId, token);
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
	type FileReferenceSnapshot,
	fileReferenceContentForDisplay,
	fileReferenceMessageForDisplay,
} from "@shared/file-reference";
import {
	freezeFileReferenceSnapshots,
	getFileReferenceSnapshots,
	projectFileReferenceText,
} from "../lib/agent/file-reference-projection";
import {
	cleanupBufferedTextFilesAsync,
	enqueueBufferedMessage,
	getBufferedMessages,
	getBufferedMessagesAsync,
	projectMailboxUserMessage,
	restoreBufferedMessage,
	toBufferSummary,
} from "./narrator-buffer";
import {
	awaitCompactCompletion,
	runCustomCompact,
	triggerMidTurnCompact,
} from "./narrator-compact";
import { handlePermission, resolvePermissionOrDangerReflection } from "./narrator-permission";
import {
	narratorPersistence,
	reconstructToolExecutionTarget,
	recoverStaleCompactingMessages,
} from "./narrator-persistence";
import { ensureNarratorPlanFileId } from "./narrator-plan-mode";
import type { RevertScope, RevertWarning } from "./snapshot-revert";
// Tools that may modify files on disk — git status is tracked after these complete.
// Defined next to the snapshot hooks so both loops agree on the set.
import { buildTreeSnapshotExecutionHooks } from "./tree-snapshot-loop-hooks";
import {
	type ContinuationStallState,
	computeContinuationStallState,
} from "./turn-continuation-decisions";

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

export type { ContinuationStallState };
/**
 * Re-exported, not defined here.
 *
 * The rule moved to `turn-continuation-decisions.ts` when the subagent loop started
 * sharing it: the bound must be ONE rule for both audiences, and a subagent importing
 * it from this module would drag the whole session layer along. The re-export keeps
 * this module's public surface unchanged for its existing importers (notably
 * `narrator-session-goal-continuation.test.ts`), and the primary loop's call sites
 * below are untouched.
 */
export { computeContinuationStallState };

export function parseQueuedNewCommand(message: string, commandText?: string | null) {
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
export async function resolveSessionDevices(
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
export async function applySessionDefaultDevice(
	narratorId: string,
	active: ActiveNarrator,
	deviceId: string | null,
): Promise<boolean> {
	await setNarratorDefaultDevice(narratorId, deviceId, {
		origin: "agent",
		active,
		userId: active._currentUserId,
	});
	return true;
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
	options: import("./workspace-context-service").WorkspaceSwitchOptions = { origin: "http" },
): Promise<{
	defaultDeviceId: string | null;
	current: import("@shared/workspace-context").WorkspaceContext;
}> {
	const runtime = await assertOAuthNarratorRuntimeActive(narratorId);
	const projectId = await resolveNarratorProjectId(narratorId);
	const projectDevices = (await resolveSessionDevices(projectId, options.userId)) ?? [];
	const devices = runtime ? filterOAuthSessionDevices(projectDevices, runtime) : projectDevices;
	const resolvedDeviceId = resolveNarratorDefaultDeviceRequest(requestedDeviceId, devices, {
		allowLocal: !runtime,
		...(runtime ? { authorizedDeviceIds: new Set(runtime.deviceIds) } : {}),
	});

	const { workspaceContextService } = await import("./workspace-context-service");
	const { current } = await workspaceContextService.switchDevice(narratorId, resolvedDeviceId, {
		...options,
		validateDevice: async () => {
			const latestRuntime = await assertOAuthNarratorRuntimeActive(narratorId);
			const latestProjectId = await resolveNarratorProjectId(narratorId);
			const latestDevices = (await resolveSessionDevices(latestProjectId, options.userId)) ?? [];
			resolveNarratorDefaultDeviceRequest(resolvedDeviceId, latestDevices, {
				allowLocal: !latestRuntime,
				...(latestRuntime ? { authorizedDeviceIds: new Set(latestRuntime.deviceIds) } : {}),
			});
		},
	});
	return { defaultDeviceId: resolvedDeviceId, current };
}

export async function executeQueuedNewCommand(
	active: ActiveNarrator,
	buffered: BufferedMessage,
	initialMessage: string,
): Promise<string> {
	const sourceNarrator = await narratorService.getById(active.narratorId);
	// `/new` spawns an independent primary session, so it must never inherit the
	// `__parent__` sentinel (prepareNarratorCreation rejects it: only subagents may
	// follow). Materialize the currently effective model, matching the idle route path.
	const newModel =
		sourceNarrator.model === FOLLOW_PARENT_MODEL
			? (
					await resolveSubagentModelForRun(
						sourceNarrator,
						buffered.createdBy ?? sourceNarrator.ownerUserId,
					)
				).model
			: (sourceNarrator.model ?? undefined);
	const newNarrator = await narratorService.create({
		chapterId: null,
		model: newModel,
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

	if (initialMessage || buffered.fileReferences?.length) {
		await sendMessage(
			newNarrator.id,
			initialMessage,
			buffered.images,
			active.locale,
			active._replyInUserLanguage ?? false,
			undefined,
			buffered.createdBy,
			buffered.textFiles,
			undefined,
			undefined,
			buffered.fileReferences,
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
	...args: Parameters<typeof persistGoalAddedNoticeUnlocked>
): ReturnType<typeof persistGoalAddedNoticeUnlocked> {
	return withNarratorWorkAdmission(args[0], () => persistGoalAddedNoticeUnlocked(...args));
}

async function persistGoalAddedNoticeUnlocked(
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
export async function executeQueuedGoalCommand(
	narratorId: string,
	buffered: BufferedMessage,
	objective: string,
): Promise<void> {
	const rawCommand = buffered.commandText?.trim() || buffered.text;
	const userMsg = await withInboxOwner(narratorId, async () => {
		const row = buffered._mailboxClaim
			? undefined
			: await claimInboxHead(
					narratorId,
					(candidate) => candidate.id === buffered.id && candidate.kind === "user_input",
				);
		const claim = buffered._mailboxClaim ?? (row ? inboxClaim(row) : undefined);
		if (!claim) throw new ValidationError("Buffered goal is no longer at the mailbox head");
		try {
			// PostgreSQL: the queue's materialize section commits message + ref + mailbox flip
			// atomically; SQLite keeps the synchronous placement transaction.
			if (getNarratorMessageRefsPort())
				return await materializeClaimedInboxUserMessage({
					claim,
					reservedMessageId: row?.recipientMessageId,
					narratorId,
					text: rawCommand,
					contentBlocks: [...(buffered.fileReferences ?? []), { type: "text", text: rawCommand }],
					commandText: rawCommand,
					createdBy: buffered.createdBy,
				});
			return await narratorService.persistUserMessage(
				narratorId,
				rawCommand,
				[...(buffered.fileReferences ?? []), { type: "text", text: rawCommand }],
				rawCommand,
				buffered.createdBy,
				undefined,
				{ mailboxClaim: claim },
			);
		} catch (error) {
			if (row) await releaseInboxClaim(row, error);
			throw error;
		}
	});
	broadcastToNarrator(narratorId, {
		type: "user_message",
		narratorId,
		message: fileReferenceMessageForDisplay(userMsg),
	});
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
export async function resumeNextBufferedMessage(
	active: ActiveNarrator,
	locale: Locale,
): Promise<void> {
	const dispatch = await withNarratorStartAdmission(active.narratorId, () =>
		resumeNextBufferedMessageUnlocked(active, locale),
	);
	await dispatch?.();
}

async function resumeNextBufferedMessageUnlocked(
	active: ActiveNarrator,
	locale: Locale,
): Promise<void | (() => Promise<void>)> {
	const narratorId = active.narratorId;
	if (isLoopRunning(narratorId)) return;
	const inputOwner = tryClaimExecution(narratorId, "tool-replay");
	if (!inputOwner) return;
	let claimedRow: RuntimeMailboxRow | undefined;
	let ownerTransferred = false;
	try {
		await flushInboxPublicationBarrier(narratorId);
		// Explicit user work authorizes delivery of its preceding notices even in
		// plan mode. Drain bounded batches without skipping a mailbox barrier. Cap
		// passes by the maximum possible non-user backlog and stop on no progress;
		// yield between batches instead of accumulating their potentially large text.
		for (let pass = 0; pass < MAILBOX_LIMITS.agentPending + MAILBOX_LIMITS.noticePending; pass++) {
			const before = await peekInbox(narratorId);
			if (!before || before.kind === "user_input") break;
			await drainAndPersistPendingInjections(active);
			const after = await peekInbox(narratorId);
			if (!after || after.id === before.id) break;
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		claimedRow = await claimInboxHead(narratorId, (candidate) => candidate.kind === "user_input");
		if (!claimedRow) return;
		const first = projectMailboxUserMessage(claimedRow);
		// Parsed before consuming, because the two kinds of item are consumed
		// differently: a terminal command owns its attachments from here on, while a
		// plain message keeps its files on disk until delivery has actually succeeded —
		// they are what a restore needs when it has not.
		const newCommand = parseQueuedNewCommand(first.text, first.commandText);
		const goalCommand = parseQueuedGoalCommand(first.text, first.commandText);
		const controlCommand = first.executionIntent?.controlCommand;
		if (newCommand || controlCommand) {
			const commandMessage = await withInboxOwner(narratorId, async () => {
				const row = claimedRow;
				if (!row) throw new ValidationError("Buffered command claim missing");
				try {
					// PostgreSQL: one queue materialize section; SQLite: the placement transaction.
					if (getNarratorMessageRefsPort()) {
						return await materializeClaimedInboxUserMessage({
							claim: inboxClaim(row),
							reservedMessageId: row.recipientMessageId,
							narratorId,
							text: first.text,
							contentBlocks: [{ type: "text", text: first.text }],
							commandText: first.commandText,
							createdBy: first.createdBy,
						});
					}
					return await narratorService.persistUserMessage(
						narratorId,
						first.text,
						[{ type: "text", text: first.text }],
						first.commandText,
						first.createdBy,
						undefined,
						{ mailboxClaim: inboxClaim(row) },
					);
				} catch (error) {
					await releaseInboxClaim(row, error);
					throw error;
				}
			});
			if (controlCommand) {
				broadcastToNarrator(narratorId, {
					type: "user_message",
					narratorId,
					message: fileReferenceMessageForDisplay(commandMessage),
				});
			}
		}
		broadcastToNarrator(narratorId, {
			type: "buffer_consumed",
			narratorId,
			messageId: first.id,
			remaining: toBufferSummary(await getBufferedMessagesAsync(narratorId)),
		});

		const settleAfterTerminalCommand = async () => {
			// More queued behind this terminal command → keep draining; else settle idle.
			if ((await getBufferedMessagesAsync(narratorId)).length > 0) {
				// Let this terminal command release its outer admission and wake promise
				// before scheduling a later command that may run for minutes.
				setImmediate(() => {
					void wakeInboxIfEligible(narratorId, locale).catch((error) => {
						logger.warn("Terminal command inbox wake failed", {
							narratorId,
							error: String(error),
						});
					});
				});
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

		if (controlCommand) {
			// Transfer the epoch, not the start mutex. Publish the controller before
			// releasing admission so an interrupt during async command setup is retained.
			const controller = new AbortController();
			active.abortController = controller;
			ownerTransferred = true;
			return async () => {
				let commandError: unknown;
				try {
					await executeQueuedControlCommand(narratorId, first, locale, controller.signal);
					await cleanupBufferedTextFilesAsync(first.id);
				} catch (error) {
					commandError = error;
				}
				let nextDispatch: void | (() => Promise<void>);
				try {
					nextDispatch = await withNarratorStartAdmission(narratorId, async () => {
						// A late command must neither settle nor release a newer epoch.
						if (!inputOwner.isCurrent()) return;
						if (commandError !== undefined)
							await handleTerminalCommandError("control command", commandError);
						inputOwner.release();
						// Release, next-input claim and idle write share the same admission.
						// No concurrent accept may start a new owner between these steps.
						if ((await getBufferedMessagesAsync(narratorId)).length > 0)
							return resumeNextBufferedMessageUnlocked(active, locale);
						await narratorService
							.compareAndSetStatus(narratorId, ["working", "waiting"], "idle", {
								substatus: ["unread"],
							})
							.catch(() => {});
					});
				} finally {
					// Admission can reject during a revert; compare-and-release is still safe.
					inputOwner.release();
				}
				await nextDispatch?.();
			};
		} else if (newCommand) {
			inputOwner.release();
			await executeQueuedNewCommand(active, first, newCommand.initialMessage)
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
			await executeQueuedGoalCommand(narratorId, first, goalCommand.objective)
				.then(async () => {
					inputOwner.release();
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
			await feedMessage(
				narratorId,
				first.text,
				first.images,
				locale,
				active._replyInUserLanguage ?? false,
				first.commandText,
				first.createdBy,
				first.textFiles,
				first.bashCommand,
				{
					bufferedDelivery: true,
					bufferedId: first.id,
					bufferedRow: claimedRow,
					bufferedOwner: inputOwner,
				},
				undefined,
				first.fileReferences,
			)
				.then(async ({ userMsg, userBroadcasted }) => {
					// Delivered: the attachments have been re-materialized into the turn, so the
					// queued copies are finally safe to drop. Cleanup is deliberately awaited only
					// after durable persistence; a cleanup failure must not restore an already-delivered
					// mailbox row.
					try {
						await cleanupBufferedTextFilesAsync(first.id);
					} catch (error) {
						logger.warn("Failed to clean buffered text files after delivery", {
							narratorId,
							messageId: first.id,
							error: String(error),
						});
					}
					if (!userBroadcasted) {
						broadcastToNarrator(narratorId, {
							type: "user_message",
							narratorId,
							message: fileReferenceMessageForDisplay(userMsg),
						});
					}
				})
				.catch(async (err) => {
					// Not delivered, so the message is still the user's. Put it back at the head
					// of the queue with its attachments intact and tell the client, then report
					// the failure as before.
					await restoreBufferedMessage(narratorId, first);
					broadcastToNarrator(narratorId, {
						type: "buffer_set",
						narratorId,
						messages: toBufferSummary(await getBufferedMessagesAsync(narratorId)),
					});
					return handleTerminalCommandError("auto-resume message", err);
				});
		}
	} finally {
		if (!ownerTransferred) {
			try {
				if (claimedRow) await releaseInboxClaim(claimedRow, "Buffered resume did not commit");
			} finally {
				inputOwner.release();
			}
		}
	}
}

// Serialize externally-triggered continuation starts and edit/regenerate transactions.
// This prevents two idle checks from racing into concurrent loops and ensures uploads
// cannot both materialize files before the narrator's turn-admission flag is set.
const continuationStartLock = { acquire: withNarratorStartAdmission };

// === Narrator lifecycle ===

/**
 * Ensure an active narrator exists for this narrator ID.
 * If one is already alive, return it. Otherwise create a new one.
 */
export async function ensureNarrator(
	...args: Parameters<typeof ensureNarratorUnlocked>
): ReturnType<typeof ensureNarratorUnlocked> {
	return withNarratorStartAdmission(args[0], () => ensureNarratorUnlocked(...args));
}

async function ensureNarratorUnlocked(
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
export async function buildSystemPrompt(
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
	// Project-level optional tool modes. Read from the project row that is fetched
	// anyway, so the preload decision below can honour a project override — without
	// it, setting a tool to "resident" for one project changed nothing.
	let projectRoutineConfig: RoutineModeConfig | undefined;
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
		projectRoutineConfig = parseProjectRoutineConfig(project?.chapterSettings);
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
		projectRoutineConfig = parseProjectRoutineConfig(project.chapterSettings);
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

	const inheritedModel =
		narrator.model === FOLLOW_PARENT_MODEL ? await resolveSubagentModelForRun(narrator) : null;
	const narratorModelRef = inheritedModel?.modelRef ?? narrator.model ?? FOLLOW_DEFAULT_MODEL;
	const narratorModel = inheritedModel?.model ?? resolveEffectiveModel(narratorModelRef);
	const narratorProvider = resolveProvider(narratorModel);

	const active: ActiveNarrator = {
		abortController,
		narratorId,
		conversationId: effectiveConversationId ?? randomUUID(),
		_resetUpstreamSessionOnNextRequest: effectiveConversationId == null,
		_persistedConversationId: effectiveConversationId ?? null,
		cwd: narratorCwd,
		_modelRef: narratorModelRef,
		_modelSelectionRef: narrator.model ?? FOLLOW_DEFAULT_MODEL,
		_followParentNarratorId:
			narrator.model === FOLLOW_PARENT_MODEL ? narrator.parentNarratorId : undefined,
		_inheritedReasoningEffort: inheritedModel?.reasoningEffort,
		_parentReasoningEffort: inheritedModel?.parentReasoningEffort,
		_settingsRevision: getSettingsRevision(),
		model: narratorModel,
		provider: narratorProvider,
		_reasoningEffortRef: narrator.reasoningEffort ?? null,
		reasoningEffort:
			(inheritedModel
				? subagentRunReasoningEffort(inheritedModel, narrator.reasoningEffort)
				: narrator.reasoningEffort) ??
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
		// Preload optional tools whose routine mode is `resident` (project override
		// first, then global). `manual` and `auto` are not preloaded — `auto` is the
		// toolsearch placeholder and behaves like `manual` until that lands.
		for (const routine of getBuiltinToolRoutines()) {
			if (!routine.tool) continue;
			const { mode } = resolveEffectiveToolRoutineMode(
				routine,
				settings.routines,
				projectRoutineConfig,
			);
			if (isPreloadedMode(mode)) {
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
					message: fileReferenceMessageForDisplay(processed),
				});
			}
		}

		// Primary broadcast to this narrator's own subscribers. Strip
		// parentToolUseId so the subagent page treats it as a top-level message.
		broadcastToNarrator(narratorId, {
			type: "message",
			narratorId,
			message: fileReferenceMessageForDisplay({ ...processed, parentToolUseId: null }),
		});
	} catch (err) {
		logger.warn("Failed to broadcast interrupted partial message", {
			narratorId,
			partialId,
			error: String(err),
		});
	}
}

export async function finalizeInterruptedRun(
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
		const body = {
			kind: "tasks" as const,
			variant: "current" as const,
			tasks: openTasks.slice(0, 8).map((task) => ({
				role:
					task.status === "doing"
						? ("doing" as const)
						: task.status === "blocked"
							? ("blocked" as const)
							: ("todo" as const),
				text: task.text,
				...(task.protected ? { protected: true as const } : {}),
			})),
		};

		// deliverInjection is statically imported at module top; the circularity with
		// narrator-injection is already handled by that module's lazy scheduler seam.
		await deliverInjection(narratorId, {
			content,
			body,
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

export async function ensureSkillCacheFreshForActiveNarrator(
	active: ActiveNarrator,
): Promise<void> {
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
export function accountTokenUsageForTurn(active: ActiveNarrator): number {
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
				modelText: prompt,
			},
		]);
		broadcastToNarrator(active.narratorId, {
			type: "message",
			narratorId: active.narratorId,
			message: {
				id: msg.id,
				narratorId: active.narratorId,
				role: msg.role,
				contentJson: fileReferenceContentForDisplay(msg.contentJson),
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
		{
			type: "spec_continuation",
			task: current.text,
			protected: current.protected === true,
			modelText: prompt,
		},
	]);
	broadcastToNarrator(active.narratorId, {
		type: "message",
		narratorId: active.narratorId,
		message: {
			id: msg.id,
			narratorId: active.narratorId,
			role: msg.role,
			contentJson: fileReferenceContentForDisplay(msg.contentJson),
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
export function persistConversationIdIfUnchanged(
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
export async function maybeStartContinuation(
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
	adoptedDeliveries?: AgentMessageDelivery[],
	adoptedMailbox?: MailboxDeliveryConsumption[],
	subagent?: { parentNarratorId: string; parentToolUseId: string },
	active?: ActiveNarrator,
): Promise<string | null> {
	return withInboxOwner(narratorId, async () => {
		await migrateLegacyParentInjections(narratorId);
		const schedule = mode === "busy" ? "onNextTurn" : "none";
		const parts: string[] = [];
		const { pendingInjectionUserId } = await import("./parent-injection-queue");
		let principalSet = false;

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
		let projectedBytes = 0;
		for (let count = 0; count < 16; count++) {
			const row = await claimInboxHead(
				narratorId,
				(candidate) =>
					candidate.kind !== "user_input" &&
					(!subagent ||
						candidate.kind !== "agent_message" ||
						inboxMetadata<InboxAgentMetadata>(candidate).channel !== "buffer") &&
					(projectedBytes === 0 ||
						projectedBytes +
							(candidate.kind === "task_notice" ? 52 * 1024 : candidate.projectedByteSize) <=
							256 * 1024),
			);
			if (!row) break;
			try {
				const entry = {
					...projectPendingInjection(row),
					mailboxClaim: inboxClaim(row),
					recipientMessageId: row.recipientMessageId ?? undefined,
				};
				if (active && !principalSet) {
					const entryUser = pendingInjectionUserId(entry);
					if (entryUser !== null && entryUser !== undefined) {
						active._currentUserId = entryUser;
						principalSet = true;
					}
				}
				const text = await deliverPendingInjection(
					narratorId,
					locale,
					mode,
					schedule,
					entry,
					subagent,
				);
				if (text) {
					projectedBytes += Buffer.byteLength(text);
					parts.push(text);
					if (row.kind !== "agent_message") adoptedMailbox?.push(inboxConsumption(row));
					if (entry.kind === "subagent_message" && entry.message.delivery) {
						adoptedDeliveries?.push(entry.message.delivery);
					}
				}
			} catch (err) {
				await releaseInboxClaim(row, err);
				logger.warn("Failed to deliver a pending injection row", {
					narratorId,
					kind: row.kind,
					mode,
					error: String(err),
				});
				break;
			}
		}

		const joined = parts.filter((part) => part.trim().length > 0).join("\n\n");
		return joined.length > 0 ? joined : null;
	});
}

/**
 * Write ONE queued injection as its own row and return its model-facing text.
 *
 * Split out of {@link deliverPendingInjectionsInOrder} so each entry can fail in
 * isolation: as a separate function the per-kind branches return instead of
 * `continue`, which is what lets the caller wrap the whole body in one try/catch
 * without swallowing the loop's control flow.
 */
export async function deliverPendingInjection(
	narratorId: string,
	locale: Locale,
	mode: "busy" | "idle",
	schedule: "onNextTurn" | "none",
	entry: PendingInjection,
	subagent?: { parentNarratorId: string; parentToolUseId: string },
): Promise<string | null> {
	const deliverInjection = (
		id: string,
		options: import("./narrator-injection").DeliverInjectionOptions,
	) => deliverInboxInjection(id, options, entry.mailboxClaim);
	const claim = entry.mailboxClaim;
	// The refs port decides the dialect. PostgreSQL: `deliverInboxInjection` drives the
	// queue's own materialize section (message + ref + mailbox flip in one transaction),
	// so the synchronous SQLite placement hook must NOT be set. SQLite: the hook keeps
	// the exact `persistPlacement` semantics.
	const pgClaim = claim && getNarratorMessageRefsPort() ? claim : undefined;
	const placement = {
		messageId: entry.recipientMessageId,
		subagent,
		onPersist:
			claim && !pgClaim
				? (
						tx: import("./agent-runtime/mailbox-types").RuntimeTx,
						messageId: string,
						refId: string,
					) => {
						runtimeInbox.materializeInTransaction(tx, claim, { messageId, refId });
						return undefined;
					}
				: undefined,
	};
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
							preview: backgroundAgentNoticePreview(task, locale),
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
			// Completion is useful at either boundary only when it includes the result.
			// Keep the bounded snapshot in the injected history, not just the UI sidecar.
			const content = formatBackgroundCompletionNotifications([task], { includeResult: true });
			const { turnText } = await deliverInjection(narratorId, {
				...placement,
				content,
				body: projected.body,
				source: "bg_agent",
				schedule,
				locale,
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
				...placement,
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
						// Preserve the exact Send target, with message ids for legacy deliveries.
						...(message.fromMessageId ? { fromMessageId: message.fromMessageId } : {}),
						...(message.fromToolUseId ? { fromToolUseId: message.fromToolUseId } : {}),
						text: message.text,
					},
				],
			},
			locale,
		);
		const content =
			mode === "idle" ? formatParentInboundMessages([message], locale) : projected.content;
		const { turnText } = await deliverInjection(narratorId, {
			...placement,
			content,
			body: message.delivery ? agentMessageDeliveryBody(message.delivery) : projected.body,
			messageId: entry.recipientMessageId ?? message.delivery?.recipientMessageId,
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
export async function drainAndPersistPendingInjections(
	active: ActiveNarrator,
	subagent?: { parentNarratorId: string; parentToolUseId: string },
): Promise<string | null> {
	return deliverPendingInjectionsInOrder(
		active.narratorId,
		active.locale,
		"idle",
		undefined,
		undefined,
		subagent,
		active,
	);
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
export async function drainInjectionsIntoHistory(
	active: ActiveNarrator,
	locale: Locale,
	subagent?: { parentNarratorId: string; parentToolUseId: string },
): Promise<{ text: string; onConsumed: () => void }> {
	const narratorId = active.narratorId;
	const parts: string[] = [];
	const adoptedDeliveries: AgentMessageDelivery[] = [];
	const adoptedMailbox: MailboxDeliveryConsumption[] = [];

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
			subagent,
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
				subagent,
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
	const eventText = await deliverPendingInjectionsInOrder(
		narratorId,
		locale,
		"busy",
		adoptedDeliveries,
		adoptedMailbox,
		subagent,
		active,
	);
	if (eventText) parts.push(eventText);
	if (subagent) {
		const { consumeBufferedSubagentMessageInPass } = await import("./subagent-executor");
		const consumed = await consumeBufferedSubagentMessageInPass({
			narratorId,
			parentNarratorId: subagent.parentNarratorId,
			toolUseId: subagent.parentToolUseId,
			cwd: active.cwd,
			currentUserId: active._currentUserId,
		});
		if (consumed) {
			parts.push(consumed.text);
			if (consumed.buffered.delivery) adoptedDeliveries.push(consumed.buffered.delivery);
			if (consumed.buffered._mailboxConsumption)
				adoptedMailbox.push(consumed.buffered._mailboxConsumption);
		}
	}

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
			subagent,
			content,
			body,
			source: "spec_update",
			schedule: "onNextTurn",
			locale,
		});
		if (turnText) parts.push(turnText);
	}

	return {
		text: parts.join("\n\n"),
		onConsumed: () => {
			for (const delivery of adoptedDeliveries) consumeAgentMessageDelivery(delivery);
			for (const delivery of adoptedMailbox) consumeMailboxDelivery(delivery);
		},
	};
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
 * same three lines in openai/gemini). That contract holds for an ordinary user
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
		// Snapshot-only inputs are real turns too. Prefer contentText for the old
		// uploaded-file hint when references are present, just as history projection does.
		const flat = typeof msg.contentText === "string" ? msg.contentText : "";
		const snapshots = getFileReferenceSnapshots(blocks);
		const projected = projectFileReferenceText(
			snapshots.length ? flat || text : text || flat,
			snapshots,
		);
		return projected.trim() ? projected : null;
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

export async function getLatestSubagentParentToolUseId(
	narratorId: string,
): Promise<string | undefined> {
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
 * Build reusable context management hooks (compact) for both
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
		if (percentage >= thresholds.compactStart && !compactLocks.has(narratorId)) {
			triggerMidTurnCompact(narratorId, locale, onCompactDone, "background", percentage);
		}
	};

	const rebuildHistoryForCurrentContext = async (includeSystemPrompt: boolean) => {
		const rawMsgs = await narratorService.getModelHistorySinceLastCompact(narratorId);
		// The in-memory history is now rebuilt from the latest (post-compact)
		// messages, so any pending-compact guard can be released.
		clearActiveHistoryCompactPending(narratorId);
		const result = await buildRuntimeHistory({
			narratorId,
			model: getModel(),
			provider: getProvider(),
			profile: isSubagentNarrator ? "subagent" : "primary",
			sourceMessages: rawMsgs,
		});
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

		const replacement = await rebuildHistoryForCurrentContext(true);
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
		const compactJustDone = isCompactDone?.() ?? false;
		if (compactJustDone) {
			clearCompactDone?.();
			return rebuildHistoryForCurrentContext(true);
		}

		// Plan mode was toggled manually mid-pass. The rebuild carries TWO things the
		// running turn cannot otherwise get: the plan-mode reminder (which only exists in
		// the system prompt, fixed at pass start) and the row the toggle just persisted
		// (the in-memory history was built before it existed). Without it the model is
		// never told it entered plan mode while the permission gate already enforces it.
		if (consumePlanModePromptRebuild(narratorId)) {
			return rebuildHistoryForCurrentContext(true);
		}

		if (!reason?.force) return null;
		return rebuildHistoryForCurrentContext(true);
	};

	return { onContextUsage, onBeforeTurn, onReasoningOnlyHighContext };
}

/**
 * Build AgentConfig, start the agent loop via executeAgentLoop(), and handle chained messages.
 * Runs in the background — kicked off by feedMessage().
 *
 * Returns `{ started: false }` when a loop is already running for this narrator.
 * The shared execution epoch is claimed in short start admission, before async
 * preparation. Both main and child entry adapters use this gate, including when
 * DB status went stale to idle while an earlier execution was still draining.
 */
export async function runAgentLoop(
	active: ActiveNarrator,
	text: string,
	images?: ImageRef[],
): Promise<{ started: boolean }> {
	const narratorId = active.narratorId;
	if (narratorLoopAdmissions.has(narratorId) || narratorToolExecutionAdmissions.has(narratorId)) {
		return { started: false };
	}
	try {
		const launch = await withNarratorStartAdmission(narratorId, async () => {
			if (
				narratorLoopAdmissions.has(narratorId) ||
				narratorToolExecutionAdmissions.has(narratorId)
			) {
				return null;
			}
			const owner = tryClaimExecution(narratorId, "primary");
			if (!owner) return null;
			// Release and the final mailbox check form one synchronous owner transition.
			let allowInboxWake = false;
			const completion = withNarratorWorkAdmission(narratorId, () =>
				runAgentLoopUnlocked(active, owner, text, images),
			)
				.then((result) => {
					allowInboxWake = result.allowInboxWake ?? false;
					return { started: result.started };
				})
				.finally(() => {
					if (owner.release() && allowInboxWake)
						void (async () => {
							if (await hasInboxKind(narratorId, ["user_input", "agent_message", "task_notice"]))
								await wakeInboxIfEligible(narratorId, active.locale);
						})().catch((error) => {
							logger.warn("Inbox wake check deferred after loop release", {
								narratorId,
								error: String(error),
							});
						});
				});
			return { completion };
		});
		return launch ? await launch.completion : { started: false };
	} catch (error) {
		if (!narratorLoopAdmissions.has(narratorId)) {
			active._loopRunning = false;
			active.alive = false;
		}
		throw error;
	} finally {
		if (active._resumeBufferedAfterLoop) {
			active._resumeBufferedAfterLoop = false;
			void wakeInboxIfEligible(narratorId, active.locale).catch((error) => {
				if (!isNarratorRevertAdmissionBlocked(narratorId)) {
					logger.warn("Could not resume queued messages after finalization", {
						narratorId,
						error: String(error),
					});
				}
			});
		}
	}
}

// === Message feeding ===

/**
 * Persist a user message and kick off the agent loop in the background.
 * Returns the active narrator and persisted message for SSE subscription.
 */
async function feedMessage(
	...args: Parameters<typeof feedMessageUnlocked>
): ReturnType<typeof feedMessageUnlocked> {
	return withNarratorStartAdmission(args[0], () => feedMessageUnlocked(...args));
}

async function feedMessageUnlocked(
	narratorId: string,
	prompt: string,
	images?: ImageRef[],
	locale: Locale = "en",
	replyInUserLanguage = false,
	commandText?: string | null,
	userId?: string | null,
	rawTextFiles?: File[],
	preBashCommand?: string | null,
	internalOptions?: {
		preserveTurnStart?: boolean;
		turnStartedAt?: string;
		/** A buffered message may be restored only before its user row is committed. */
		bufferedDelivery?: boolean;
		bufferedId?: string;
		bufferedRow?: RuntimeMailboxRow;
		bufferedOwner?: ExecutionOwner;
	},
	origin?: MessageOriginOptions,
	fileReferences?: FileReferenceSnapshot[],
): Promise<{
	active: ActiveNarrator;
	userMsg: typeof narratorMessages.$inferSelect;
	userBroadcasted?: boolean;
	/** The message is durable, but a later dispatch step failed and was reported. */
	postCommitError?: unknown;
}> {
	let acceptedReferences = freezeFileReferenceSnapshots(fileReferences);
	const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
	// Final guard against a concurrent loop slipping past the route-level admission
	// check (which should have buffered this message). ensureNarrator reuses the live
	// `active`, so starting a second runAgentLoop here would corrupt the shared session.
	// Throw BEFORE persisting the user message so we never leave a half-applied turn.
	const ownedBufferedInput = internalOptions?.bufferedOwner?.isCurrent() === true;
	if (
		(ownedBufferedInput ? active._loopRunning === true : isLoopRunning(narratorId)) ||
		(!ownedBufferedInput && isNarratorRuntimeBusy(narratorId))
	) {
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

	const inputOwner = internalOptions?.bufferedOwner ?? tryClaimExecution(narratorId, "tool-replay");
	if (!inputOwner?.isCurrent())
		throw new ValidationError("Narrator input is already being adopted");
	let claimedInput: RuntimeMailboxRow | undefined;
	let stagingId: string | undefined;
	let userMsg: typeof narratorMessages.$inferSelect;
	let effectivePrompt: string;
	try {
		// Materialize publication outbox entries before claiming the mailbox head. A pending
		// publication is an ordering barrier; without flushing it here, an idle user send can
		// be rejected even though the blocking task notice is still invisible in history.
		// The shared barrier honors the facade's sync API and a wired service's Promise
		// shape alike.
		await flushInboxPublicationBarrier(narratorId);
		// An idle narrator may still have earlier agent/task mailbox work that deliberately
		// does not auto-wake it (notably cancellation notices). Consume that non-user work
		// before appending this new user input, otherwise the exact claim below reports that
		// the user's row is queued behind earlier mailbox work forever. The idle drain reuses
		// the current tool-replay owner and uses schedule:none, so it persists history only;
		// it cannot start a second loop or skip an earlier user_input row.
		if (!internalOptions?.bufferedId && !internalOptions?.bufferedRow)
			await drainAndPersistPendingInjections(active);
		const acceptedId =
			internalOptions?.bufferedId ??
			(
				await enqueueBufferedMessage(
					narratorId,
					prompt,
					images,
					commandText,
					userId,
					null,
					rawTextFiles,
					"back",
					preBashCommand,
					acceptedReferences,
				)
			).id;
		claimedInput =
			internalOptions?.bufferedRow ??
			(await claimInboxHead(
				narratorId,
				(candidate) => candidate.id === acceptedId && candidate.kind === "user_input",
			));
		if (
			claimedInput &&
			(claimedInput.narratorId !== narratorId ||
				claimedInput.id !== acceptedId ||
				claimedInput.claimEpoch !== inputOwner.epoch)
		)
			throw new ValidationError("Buffered input claim does not match its owner");
		if (!claimedInput) throw new ValidationError("Input is queued behind earlier mailbox work");
		const accepted = projectMailboxUserMessage(claimedInput);
		prompt = accepted.text;
		images = accepted.images;
		commandText = accepted.commandText;
		userId = accepted.createdBy;
		rawTextFiles = accepted.textFiles;
		preBashCommand = accepted.bashCommand;
		acceptedReferences = accepted.fileReferences ?? [];
		stagingId = accepted._stagingId;
		active._currentUserId = userId ?? null;
		// Save text files to worktree only after the durable claim freezes accepted bytes.
		const savedTextFiles: TextFileRef[] = [];
		if (rawTextFiles?.length) {
			for (const file of rawTextFiles) {
				savedTextFiles.push(await saveTextFileToWorktree(active.cwd, file));
			}
		}

		const persistBlocks: Array<
			| { type: "text"; text: string }
			| PersistedUserImageBlock
			| FileReferenceSnapshot
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
		persistBlocks.push(...acceptedReferences, { type: "text", text: prompt });

		// When the user sends images without text, inject a placeholder so that
		// providers that gate on non-empty content still include the image blocks.
		const effectiveText = !prompt.trim() && images?.length ? "[user sent image(s)]" : prompt;

		// Build the effective prompt with attached file hints
		effectivePrompt = effectiveText + buildAttachedFilesHint(savedTextFiles);

		userMsg = (await persistClaimedUserInput({
			claim: inboxClaim(claimedInput),
			reservedMessageId: claimedInput.recipientMessageId,
			narratorId,
			text: effectivePrompt,
			contentBlocks: persistBlocks,
			commandText,
			createdBy: userId,
			origin,
		})) as unknown as typeof narratorMessages.$inferSelect;
		if (accepted.executionIntent?.modelOverride) {
			await applyAcceptedModelOverride(narratorId, accepted.executionIntent.modelOverride);
		}
	} catch (error) {
		if (claimedInput) await releaseInboxClaim(claimedInput, error);
		throw error;
	} finally {
		inputOwner.release();
	}
	if (stagingId) {
		// The mailbox row is durable at this point. Await backend-neutral cleanup, but do not
		// turn a cleanup failure into a delivery failure that could make callers restore it.
		try {
			await cleanupBufferedTextFilesAsync(stagingId);
		} catch (error) {
			logger.warn("Failed to clean buffered text files after persistence", {
				narratorId,
				messageId: stagingId,
				error: String(error),
			});
		}
	}

	try {
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
		// do NOT resolve the override or register a watcher here.
		const narrator = await narratorService.getById(narratorId);
		if (isSubagentVariant(narrator.variant) && narrator.parentNarratorId) {
			const currentSubstatus = parseSubstatus(narrator.substatus);
			const takenOver = isTakenOver(narratorId);
			if (takenOver) {
				// Parent stays blocked — do not resolve, do not register a watcher.
			} else if (currentSubstatus.includes("manual_override")) {
				const overrideEntry = getManualOverrideMap().get(narratorId);
				if (overrideEntry) {
					const currentFinalText = await getSubagentFinalText(narratorId);

					const origin = await narratorPersistence.resolveSubagentConclusionReference(
						narratorId,
						overrideEntry.parentNarratorId,
						overrideEntry.toolUseId,
					);
					registerConclusionWatcher(
						narratorId,
						overrideEntry.parentNarratorId,
						overrideEntry.toolUseId,
						origin.originToolCallId,
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
				message: fileReferenceMessageForDisplay(userMsg),
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
				logger.error("runAgentLoop unhandled error", {
					narratorId,
					error: String(err),
					diagnostics,
				});
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
		runAgentLoop(
			active,
			projectFileReferenceText(effectivePrompt, acceptedReferences),
			images,
		).catch(async (err) => {
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
	} catch (error) {
		if (!internalOptions?.bufferedDelivery) throw error;
		logger.error("Buffered message committed but could not start", {
			narratorId,
			error: String(error),
		});
		await narratorService
			.updateStatus(narratorId, "idle", { substatus: ["error"], errorMessage: String(error) })
			.catch(() => {});
		broadcastToNarrator(narratorId, { type: "narrator_error", narratorId, error: String(error) });
		return { active, userMsg, postCommitError: error };
	}
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

/** Resolve the live parent slot and isolate shared history before a conclusion write. */
export async function prepareSubagentConclusionReference(
	...args: Parameters<typeof prepareSubagentConclusionReferenceUnlocked>
): ReturnType<typeof prepareSubagentConclusionReferenceUnlocked> {
	return withNarratorWorkAdmission(args[0], () =>
		prepareSubagentConclusionReferenceUnlocked(...args),
	);
}

async function prepareSubagentConclusionReferenceUnlocked(
	subagentId: string,
	parentNarratorId: string,
	toolUseId: string,
	expectedOriginToolCallId?: string,
) {
	const reference = await narratorPersistence.resolveSubagentConclusionReference(
		subagentId,
		parentNarratorId,
		toolUseId,
		expectedOriginToolCallId,
	);
	if (await narratorService.isMessageSharedByMultipleNarrators(reference.messageId)) {
		await narratorService.copyOnWriteToolCallMessage(
			parentNarratorId,
			reference.messageId,
			toolUseId,
		);
	}
	// Re-resolve even on subsequent writes: the origin stays immutable but COW
	// replaces both the visible message and tool-call primary keys.
	return narratorPersistence.resolveSubagentConclusionReference(
		subagentId,
		parentNarratorId,
		toolUseId,
		reference.originToolCallId,
	);
}

/**
 * Update the parent narrator's tool_call outputJson with a new conclusion.
 * Used for scenario 2 (conclusion watcher) and the update-conclusion API.
 */
export async function updateToolCallConclusion(
	opts: Parameters<typeof updateToolCallConclusionUnlocked>[0],
): ReturnType<typeof updateToolCallConclusionUnlocked> {
	return withNarratorWorkAdmission(opts.subagentId, () => updateToolCallConclusionUnlocked(opts));
}

async function updateToolCallConclusionUnlocked(opts: {
	subagentId: string;
	parentNarratorId: string;
	toolUseId: string;
	finalText: string;
	hasError: boolean;
	/** Exact parent call when retained by the execution driver. */
	toolCallId?: string;
	/** Pass after copy-on-write to scope the update to the private message copy. */
	messageId?: string;
	/** The subagent assistant message that produced this result. */
	resultMessageId?: string;
	/**
	 * Re-finalize execution timing at this conclusion handoff. Defaults to false so
	 * manual/third-party conclusion text updates preserve the original execution timing.
	 */
	refreshTiming?: boolean;
	onPersist?: (tx: import("./agent-runtime/mailbox-types").RuntimeTx) => void;
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
	// Scope metadata only: do not load the child's transcript or file-tool payloads.
	const attributionTurn = await db.query.narrators
		.findFirst({
			where: eq(narrators.id, subagentId),
			columns: { turnStartedAt: true },
		})
		.catch(() => undefined);
	const output = await appendSubagentFileChanges(
		{
			parentNarratorId,
			childNarratorId: subagentId,
			scope: {
				sourceToolUseId: toolUseId,
				startedAt: attributionTurn?.turnStartedAt ?? null,
				completedAt: new Date().toISOString(),
			},
		},
		resultPrefix + (finalText || "(no output)"),
	);
	const resultRows = await db.query.narratorToolCalls.findMany({
		where: and(
			eq(narratorToolCalls.narratorId, parentNarratorId),
			eq(narratorToolCalls.toolUseId, toolUseId),
			messageId ? eq(narratorToolCalls.messageId, messageId) : undefined,
			opts.toolCallId ? eq(narratorToolCalls.id, opts.toolCallId) : undefined,
		),
		columns: {
			id: true,
			createdAt: true,
			streamStartedAt: true,
			permissionStartedAt: true,
			executionStartedAt: true,
		},
		limit: 2,
	});
	if (resultRows.length !== 1)
		throw new ValidationError("Subagent conclusion requires an exact parent tool-call row");
	const resultRow = resultRows[0];
	const timing = refreshTiming ? resolveToolCallConclusionTiming(resultRow) : undefined;

	await narratorService.updateToolCallResult(
		toolUseId,
		{
			output,
			status: hasError ? "fail" : "success",
			errorMessage: hasError ? finalText : undefined,
			resultMessageId,
			onPersist: opts.onPersist,
			...(timing ?? { preserveTiming: true }),
		},
		messageId,
		resultRow.id,
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

export interface UserMessageAdmissionOptions {
	images?: ImageRef[];
	locale?: Locale;
	replyInUserLanguage?: boolean;
	commandText?: string | null;
	userId?: string | null;
	creator?: Parameters<typeof enqueueBufferedMessage>[5];
	textFiles?: File[];
	preBashCommand?: string | null;
	fileReferences?: FileReferenceSnapshot[];
	priority?: boolean;
	interrupt?: boolean;
	executionIntent?: BufferedMessage["executionIntent"];
	/** Compaction policy may require durable acceptance without starting a loop. */
	queueOnly?: boolean;
}

export type UserMessageAdmissionResult =
	| { buffered: true; id: string; bufferedAt: string }
	| { buffered: false; userMsg: typeof narratorMessages.$inferSelect };

/** Execute a materialized control under its own execution epoch, never the old loop's. */
async function executeQueuedControlCommand(
	narratorId: string,
	message: BufferedMessage,
	locale: Locale,
	signal: AbortSignal,
): Promise<void> {
	const { resolveCommand } = await import("./command-service");
	const handlers = await import("./narrator-service");
	const userId = message.createdBy ?? undefined;
	if (!userId) throw new ValidationError("Queued control command has no user principal");
	const result = await resolveCommand(message.text, narratorId, userId);
	if (signal.aborted) return;
	if (!result.resolved) throw new ValidationError("Queued control command is no longer available");
	if ("bashCommand" in result && !("expandedPrompt" in result)) {
		await handlers.handleBashCommand(narratorId, result.bashCommand, result.rawCommand, userId, {
			skipUserMessage: true,
			signal,
		});
	} else if ("loadTool" in result || "loadToolNotFound" in result) {
		await handlers.handleLoadToolCommand(narratorId, result, locale, userId);
	} else if ("unloadTool" in result || "unloadToolNotFound" in result) {
		await handlers.handleUnloadToolCommand(narratorId, result, locale);
	} else if ("blockSkill" in result) {
		await handlers.handleBlockSkillCommand(narratorId, result, locale);
	} else if ("blockAllSkills" in result) {
		await handlers.handleBlockAllSkillsCommand(narratorId, result, locale);
	} else if ("unblockSkill" in result) {
		await handlers.handleUnblockSkillCommand(narratorId, result, locale);
	} else if ("unblockAllSkills" in result) {
		await handlers.handleUnblockAllSkillsCommand(narratorId, result, locale);
	} else {
		throw new ValidationError("Unsupported queued control command");
	}
}

/**
 * HTTP user-input admission. Acceptance is durable, not a promise to own the next
 * turn: an earlier mailbox row or publication barrier must produce 202, not an
 * error that restores an already-accepted draft and deletes its uploaded images.
 *
 * The start admission also serializes the live loop's user-input claim. An
 * interrupting input is queued before aborting the captured old owner; no finalizer
 * is awaited under this lock, and no new owner can be accidentally interrupted.
 */
export async function acceptUserMessage(
	narratorId: string,
	prompt: string,
	options: UserMessageAdmissionOptions = {},
): Promise<UserMessageAdmissionResult> {
	const locale = options.locale ?? "en";
	const result = await withNarratorStartAdmission(
		narratorId,
		async (): Promise<UserMessageAdmissionResult> => {
			const narrator = await narratorService.getById(narratorId);
			if (isSubagentVariant(narrator.variant))
				throw new ValidationError("Subagent messages must be sent through resumeSubagent");
			const oldOwner = getExecutionOwner(narratorId);
			const oldController = activeNarrators.get(narratorId)?.abortController;
			const oldRecovery = plannedUpdateRecoveryControls.get(narratorId);
			const busy = isNarratorRuntimeBusy(narratorId) || isLoopRunning(narratorId);
			const inputOwner =
				!busy && !options.queueOnly ? tryClaimExecution(narratorId, "tool-replay") : undefined;
			try {
				const accepted = await enqueueBufferedMessage(
					narratorId,
					prompt,
					options.images,
					options.commandText,
					options.userId,
					options.creator,
					options.textFiles,
					options.priority || options.interrupt ? "front" : "back",
					options.preBashCommand,
					options.fileReferences,
					"stack",
					options.executionIntent,
				);
				if (!accepted.ok) throw new ValidationError("Message queue is full");
				const queued = {
					buffered: true as const,
					id: accepted.id,
					bufferedAt: accepted.bufferedAt,
				};
				// From here onward the mailbox owns the payload. Dispatch/notification failure
				// must not make HTTP callers retry the same input or discard its attachments.
				let claimed: RuntimeMailboxRow | undefined;
				try {
					if (options.interrupt && busy) {
						const ownerUnchanged = getExecutionOwner(narratorId) === oldOwner;
						const controllerUnchanged =
							activeNarrators.get(narratorId)?.abortController === oldController;
						const recoveryUnchanged = plannedUpdateRecoveryControls.get(narratorId) === oldRecovery;
						if (ownerUnchanged && controllerUnchanged && recoveryUnchanged)
							interruptNarrator(narratorId);
					} else if (options.priority && busy) {
						requestBufferedMessageSoftStop(narratorId);
					}
					if (busy) await reconcileRunningStatus(narratorId);
					if (inputOwner?.isCurrent()) {
						const active = await ensureNarrator(narratorId, locale, options.replyInUserLanguage);
						await flushInboxPublicationBarrier(narratorId);
						await drainAndPersistPendingInjections(active);
						// A command queued while busy may reach admission after the old loop
						// exits. Leave it to the command-aware buffered consumer, not feedMessage.
						const queuedCommand =
							options.executionIntent?.controlCommand ||
							parseQueuedNewCommand(prompt, options.commandText) ||
							parseQueuedGoalCommand(prompt, options.commandText);
						claimed = queuedCommand
							? undefined
							: await claimInboxHead(
									narratorId,
									(row) => row.id === accepted.id && row.kind === "user_input",
								);
						if (claimed) {
							const { userMsg, userBroadcasted } = await feedMessage(
								narratorId,
								prompt,
								options.images,
								locale,
								options.replyInUserLanguage,
								options.commandText,
								options.userId,
								options.textFiles,
								options.preBashCommand,
								{
									bufferedDelivery: true,
									bufferedId: accepted.id,
									bufferedRow: claimed,
									bufferedOwner: inputOwner,
								},
								undefined,
								options.fileReferences,
							);
							if (!userBroadcasted)
								broadcastToNarrator(narratorId, {
									type: "user_message",
									narratorId,
									message: fileReferenceMessageForDisplay(userMsg),
								});
							return { buffered: false, userMsg };
						}
					}
					broadcastToNarrator(narratorId, {
						type: "buffer_set",
						narratorId,
						messages: toBufferSummary(await getBufferedMessagesAsync(narratorId)),
					});
				} catch (error) {
					// feedMessage can fail before entering its own claim cleanup (for
					// example while resolving the session). Never strand this owner's claim.
					if (claimed)
						await releaseInboxClaim(claimed, error).catch((releaseError) => {
							logger.warn("Accepted user input claim release deferred", {
								narratorId,
								messageId: accepted.id,
								error: String(releaseError),
							});
						});
					logger.warn("Accepted user input dispatch deferred", {
						narratorId,
						messageId: accepted.id,
						error: String(error),
					});
				}
				return queued;
			} finally {
				inputOwner?.release();
			}
		},
	);
	if (result.buffered) {
		// Outside start admission: waking takes the same lock, so awaiting it inside
		// would deadlock. The wake rechecks compactLocks too: compaction may have
		// finished while an attachment was staging, before there was anything to drain.
		// A busy old loop will wake the inbox again after finalization.
		void wakeInboxIfEligible(narratorId, locale).catch((error) => {
			logger.warn("Accepted user input wake deferred", { narratorId, error: String(error) });
		});
	}
	return result;
}

/**
 * Send a message to a narrator (fire-and-forget).
 * Persists the user message, broadcasts it via WS, kicks off the agent loop
 * in the background, and returns the persisted user message.
 * All streaming events are delivered exclusively via WebSocket.
 *
 * Parameter order (long positional tail — count carefully; passing a userId into
 * the `commandText` slot is a mistake that has already shipped once):
 *   1 narratorId, 2 prompt, 3 images, 4 locale, 5 replyInUserLanguage,
 *   6 commandText, 7 userId, 8 textFiles, 9 preBashCommand, 10 origin, 11 fileReferences
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
	fileReferences?: FileReferenceSnapshot[],
): Promise<typeof narratorMessages.$inferSelect> {
	const acceptedReferences = freezeFileReferenceSnapshots(fileReferences);
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
		acceptedReferences,
	);
	if (!userBroadcasted) {
		broadcastToNarrator(narratorId, {
			type: "user_message",
			narratorId,
			message: fileReferenceMessageForDisplay(userMsg),
		});
	}
	return userMsg;
}

export interface SendSubagentMessageInput {
	fileReferences?: FileReferenceSnapshot[];
	subagentId: string;
	message: string;
	priority?: boolean;
	locale?: Locale;
	createdBy?: string | null;
	signal?: AbortSignal;
}

export interface SendSubagentMessageResult {
	delivered: "buffered" | "started";
	messageId?: string;
	bufferedAt?: string;
	started?: boolean;
	resumedSuspendedRunner?: boolean;
}

/**
 * Deliver a message to a subagent narrator and get it to act on it.
 *
 * Subagents have no independent message channel: a running subagent consumes
 * buffered messages at its next safe boundary (soft stop), while an idle
 * subagent is resumed in-place with a follow-up turn. This is the counterpart
 * of {@link sendMessage} for primary narrators — the REST layer already routes
 * subagent messages through `resumeSubagent`; this function centralizes the
 * same decision (running → buffer, idle → resume) behind one callable.
 */
export async function sendSubagentMessage(
	input: SendSubagentMessageInput,
): Promise<SendSubagentMessageResult> {
	input = { ...input, fileReferences: freezeFileReferenceSnapshots(input.fileReferences) };
	const narrator = await narratorService.getById(input.subagentId);
	if (!isSubagentVariant(narrator.variant)) {
		throw new ValidationError("Target narrator is not a subagent");
	}
	if (narrator.status === "archived") {
		throw new ValidationError("Archived subagents cannot receive messages");
	}
	const { resumeSubagent, resolveSubagentOriginToolUseId } = await import("./subagent-resume");
	// Never-started subagents (e.g. a team temp worker recruited directly through
	// the plugin API) carry a stale "working" status but have no real runner —
	// buffering would strand the message forever. Route them to resume instead,
	// which synthesizes a standalone origin tool-use id and starts them in place.
	const neverStarted = !(await resolveSubagentOriginToolUseId(input.subagentId).catch(() => null));
	const running = narrator.status === "working" || narrator.status === "waiting";
	if (running && !neverStarted) {
		const { bufferSubagentUserMessage } = await import("./subagent-executor");
		const { isTakenOver } = await import("./subagent-takeover");
		const result = await bufferSubagentUserMessage(input.subagentId, input.message, {
			createdBy: input.createdBy ?? null,
			fileReferences: input.fileReferences,
			priority: input.priority ?? false,
			requestSoftStop: !isTakenOver(input.subagentId),
		});
		if (!result.ok) {
			if (result.full) throw new ValidationError("Subagent message queue is full");
			throw new ValidationError("Subagent is not running; it cannot be buffered right now");
		}
		return {
			delivered: "buffered",
			messageId: result.id,
			bufferedAt: result.bufferedAt,
		};
	}
	// Idle (or never-started) subagent: resume in-place with a follow-up turn.
	// Tool-created subagents resolve their originating Agent call internally. Plugin
	// workers carry explicit durable standalone provenance and can start without one;
	// their synthesized tool-use id groups messages only.
	const resumed = await resumeSubagent({
		subagentId: input.subagentId,
		intent: "follow_up",
		actor: "parent_agent",
		prompt: input.message,
		fileReferences: input.fileReferences,
		locale: input.locale ?? "en",
		createdBy: input.createdBy ?? null,
		signal: input.signal,
	});
	return {
		delivered: "started",
		started: resumed.started,
		resumedSuspendedRunner: resumed.resumedSuspendedRunner,
		messageId: resumed.userMessage?.id ?? undefined,
	};
}

export interface CreateNarratorForPluginInput {
	title?: string;
	model?: string;
	cwd?: string;
	chapterId?: string | null;
	permissionMode?: string;
	planReflectionAutoApproveOverride?: BooleanOverride;
	/** "subagent" creates a team temp worker owned by `parentNarratorId`. */
	type?: "primary" | "subagent";
	subagentType?: string;
	parentNarratorId?: string;
}

export interface CreateNarratorForPluginResult {
	narratorId: string;
	title: string | null;
	variant: string;
	type: "primary" | "subagent";
	model: string | null;
	cwd: string | null;
	status: string;
}

/**
 * Create a narrator for a plugin (team recruit flow): a primary narrator for
 * team members, or a subagent temp worker owned by the recruiting narrator.
 */
export async function createNarratorForPlugin(
	input: CreateNarratorForPluginInput,
): Promise<CreateNarratorForPluginResult> {
	if (input.type === "subagent") {
		if (!input.parentNarratorId) {
			throw new ValidationError("Subagent temp workers require a recruiting parent narrator");
		}
		const parent = await narratorService.getById(input.parentNarratorId);
		const narrator = await narratorService.createSubagent({
			subagentOriginKind: "standalone",
			parentNarratorId: input.parentNarratorId,
			subagentType: input.subagentType ?? "general",
			title: input.title,
			model: input.model,
			cwd: input.cwd ?? parent.cwd ?? ".",
			permissionMode: input.permissionMode as
				| "default"
				| "acceptEdits"
				| "bypassPermissions"
				| "readOnly"
				| "dontAsk"
				| undefined,
			planReflectionAutoApproveOverride: input.planReflectionAutoApproveOverride,
		});
		return {
			narratorId: narrator.id,
			title: narrator.title ?? null,
			variant: narrator.variant,
			type: "subagent",
			model: narrator.model ?? null,
			cwd: narrator.cwd ?? null,
			status: narrator.status,
		};
	}
	const narrator = await narratorService.create({
		chapterId: input.chapterId ?? null,
		title: input.title,
		model: input.model,
		cwd: input.cwd,
		permissionMode: input.permissionMode,
		planReflectionAutoApproveOverride: input.planReflectionAutoApproveOverride,
	});
	return {
		narratorId: narrator.id,
		title: narrator.title ?? null,
		variant: narrator.variant,
		type: "primary",
		model: narrator.model ?? null,
		cwd: narrator.cwd ?? null,
		status: narrator.status,
	};
}

/** Delete a narrator entirely (team fire flow: removes the worker narrator). */
export async function deleteNarratorForPlugin(narratorId: string): Promise<void> {
	await withNarratorWorkAdmission(narratorId, () => narratorService.remove(narratorId));
}

/**
 * Read a narrator's Dynamic Spec tasks.json (compiled). Used by the team plugin
 * to track the shared task queue it maintains for each member.
 */
export async function readSpecTasksForPlugin(narratorId: string) {
	const { readTasksFileForNarrator } = await import("./spec-vfs-service");
	const { parseSpecTasksDocument, compileSpecTasks } = await import("./spec-task-service");
	const file = await readTasksFileForNarrator(narratorId);
	const document = parseSpecTasksDocument(file.content);
	const compiled = compileSpecTasks(document);
	return {
		content: file.content,
		revisionId: file.revisionId ?? null,
		document,
		compiled,
	};
}

/**
 * Append a task to a narrator's spec://tasks.json on a plugin's behalf: dispatching a
 * task enqueues it in the member's own queue and the member's loop picks it up.
 * Idempotent: identical text is not appended twice (safe for redispatch).
 *
 * The task is ORDINARY unless the plugin explicitly asks for a protected one. It used to
 * be protected unconditionally, and written as `actor: "user"` — so every dispatched
 * task became a user commitment that auto-continues the narrator and that the narrator
 * cannot retract. That let a plugin keep a narrator working for it indefinitely without
 * anyone having asked for that guarantee. Plugins write as `"agent"`, which is what they
 * are on the spec VFS policy axis.
 */
export async function addSpecTaskForPlugin(
	narratorId: string,
	text: string,
	options: { protected?: boolean } = {},
): Promise<{ added: boolean; taskText: string; protected: boolean; revisionId: string | null }> {
	const { appendSpecTaskForExternalActor } = await import("./spec-vfs-service");
	const objective = text.trim();
	if (!objective) throw new ValidationError("task text is required");
	const result = await appendSpecTaskForExternalActor(narratorId, objective, {
		protected: options.protected === true,
		actor: "agent",
	});
	return {
		added: result.added,
		taskText: objective,
		protected: result.protected,
		revisionId: result.written.revisionId ?? null,
	};
}

/** Marker that scopes plugin-written team-SOP sections inside spec://behavior_fence. */
const TEAM_SOP_MARKER = "team-sop:com.whisent.narrator-team";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Upsert or clear a plugin-managed team-SOP section inside a narrator's
 * `spec://behavior_fence`.
 *
 * The host merges the SOP section into the existing fence so the user's own
 * behavior constraints are preserved; `clear` removes only the plugin's marked
 * section. The fence is periodically injected by the host (`buildBehaviorFence
 * Reminder` at the fence cadence), which is what keeps the SOP visible to a
 * worker even after long runs / context compacts — the "remember to report
 * back" problem this solves.
 */
export async function setSpecBehaviorFenceForPlugin(
	narratorId: string,
	text: string,
	mode: "upsert" | "clear",
): Promise<{ updated: boolean; revisionId: string | null }> {
	const { readSpecFile, writeSpecFile } = await import("./spec-vfs-service");
	let current = "";
	try {
		const file = await readSpecFile(narratorId, "spec://behavior_fence");
		current = file.content ?? "";
	} catch {
		// Fence may not exist yet; treat as empty.
	}
	const openTag = `<!-- ${TEAM_SOP_MARKER} -->`;
	const closeTag = `<!-- /${TEAM_SOP_MARKER} -->`;
	const sopPattern = new RegExp(
		`\\s*${escapeRegExp(openTag)}[\\s\\S]*?${escapeRegExp(closeTag)}\\s*`,
	);
	const withoutSop = current.replace(sopPattern, "").trim();
	const body = text.trim();
	let next: string;
	if (mode === "clear" || !body) {
		next = withoutSop;
	} else {
		const section = `${openTag}\n${body}\n${closeTag}`;
		next = withoutSop ? `${withoutSop}\n\n${section}` : section;
	}
	const written = await writeSpecFile(narratorId, "spec://behavior_fence", next, {
		actor: "agent",
		allowFenceMutation: true,
		createdBy: "assistant",
	});
	return { updated: true, revisionId: written.revisionId ?? null };
}

/**
 * Update a narrator's title / model / reasoning effort from a plugin (team
 * leader managing its members). Persists each provided field and applies the
 * runtime sync so an already-running narrator picks the change up at its next
 * model request. At least one field must be provided.
 *
 * @returns {Promise<{ updated: string[] }>} — the field names that were changed
 */
export async function updateNarratorProfileForPlugin(
	narratorId: string,
	input: {
		title?: string;
		model?: string;
		reasoningEffort?: ReasoningEffort | null;
		planReflectionAutoApproveOverride?: BooleanOverride;
	},
): Promise<{ updated: string[] }> {
	const { persistTitle } = await import("./narrator-title");
	const updated: string[] = [];
	if (input.title !== undefined) {
		const title = input.title.trim();
		if (!title) throw new ValidationError("title must not be empty");
		if (title.length > 200) throw new ValidationError("title must be at most 200 characters");
		await persistTitle(narratorId, title);
		updated.push("title");
	}
	if (input.model !== undefined) {
		const model = input.model;
		await narratorService.updateModel(narratorId, model);
		updateNarratorModel(narratorId, model);
		updated.push("model");
	}
	if (input.reasoningEffort !== undefined) {
		await narratorService.updateReasoningEffort(narratorId, input.reasoningEffort);
		updateNarratorReasoningEffort(narratorId, input.reasoningEffort);
		updated.push("reasoningEffort");
	}
	if (input.planReflectionAutoApproveOverride !== undefined) {
		await narratorService.updateReflectionOverrides(narratorId, {
			planReflectionAutoApproveOverride: input.planReflectionAutoApproveOverride,
		});
		updated.push("planReflectionAutoApproveOverride");
	}
	return { updated };
}

/**
 * Write (or replace) a whitelisted Dynamic Spec file for a narrator on behalf
 * of a plugin (team leader managing its members). Only non-readonly spec files
 * (currently `tasks.json` and `index.md`) are allowed; `behavior_fence` stays
 * exclusive to the user / the dedicated team-SOP fence command.
 */
export async function writeSpecForPlugin(
	narratorId: string,
	uri: string,
	content: string,
): Promise<{ path: string; uri: string; revisionId: string | null }> {
	const { writeSpecFile } = await import("./spec-vfs-service");
	const written = await writeSpecFile(narratorId, uri, content, {
		actor: "agent",
		createdBy: "assistant",
	});
	return {
		path: written.path,
		uri: written.uri,
		revisionId: written.revisionId ?? null,
	};
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
		if (isLoopRunning(narratorId)) return { started: false };

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
		if (isLoopRunning(narratorId)) return { started: false };

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
 *
 * ## A subagent is routed to `resumeSubagent`, not run here
 *
 * `runAgentLoop` on a subagent is not merely a different code path, it bypasses the
 * things that make a subagent run legitimate: the resume lock (so two resumes cannot
 * race), the origin `tool_use` id resolution, and the conclusion publication that
 * writes the run's result back into the parent's still-open Agent tool call. That is
 * why `sendMessage`, `continueNarrator` and `retryLastMessage` all refuse a subagent
 * outright and demand `resumeSubagent`.
 *
 * This function did NOT have that guard, so every `wakeIfIdle` producer was one
 * subagent recipient away from starting an unsupervised loop — `async_question`
 * already reaches this with `wakeIfIdle` whenever the target is idle. Rather than
 * refusing (which would leave the row sitting with nobody to read it) the wake is
 * DELEGATED: `intent: "continue_tool_results"` is the resume that means "the content
 * is already in history", the exact semantics of `runAgentLoop(active, "")`.
 *
 * The dispatch is here rather than in `narrator-injection` on purpose: that module
 * imports this one lazily to avoid a cycle, and duplicating the "is this a subagent"
 * decision there would leave `routes/narrators.ts` — the other caller — still able to
 * run a subagent through the primary path.
 */
export async function startInjectionContinuationIfPossible(
	narratorId: string,
	locale: Locale = "en",
	replyInUserLanguage = false,
	executionPrincipal?: QuestionExecutionPrincipal,
): Promise<{ started: boolean }> {
	// Read BEFORE taking `continuationStartLock`: the subagent path takes its own
	// resume lock, and nesting the two in an order nobody else uses invites a deadlock
	// with a concurrent primary-narrator continuation.
	const recipient = await narratorService.getById(narratorId);
	if (isSubagentVariant(recipient.variant)) {
		return startSubagentInjectionContinuation(
			recipient,
			locale,
			replyInUserLanguage,
			executionPrincipal,
		);
	}
	return continuationStartLock.acquire(narratorId, async () => {
		if (isLoopRunning(narratorId)) return { started: false };

		const narrator = await narratorService.getById(narratorId);
		if (narrator.status !== "idle") return { started: false };
		if (isPlanModeTrait(narrator.traits)) return { started: false };

		const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
		if (active._loopRunning) return { started: false };

		if (executionPrincipal) active._currentUserId = executionPrincipal.userId;
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
 * The subagent half of {@link startInjectionContinuationIfPossible}.
 *
 * `intent: "continue_tool_results"` is the resume that carries no new prompt: it
 * rebuilds history from the rows (through `loadSubagentHistory`, which clears
 * `parentToolUseId` so the subagent's own rows become its history) and replays any
 * trailing tool results. That is precisely what `runAgentLoop(active, "")` means on the
 * primary path, so the injected row is read as the freshest content either way — with
 * the resume lock, origin tool_use resolution and conclusion publication that only
 * `resumeSubagent` provides.
 *
 * Refuses rather than throws in the cases a resume cannot legitimately happen. The row
 * is already durable at this point, so "not started" costs immediacy, not content:
 *
 *   - a RUNNING subagent rebuilds history at its next pass and reads the row itself,
 *     exactly like a busy primary narrator (`wakeIfIdle` degrading to `none`).
 *   - an active resume run is already going to consume it.
 *   - plan mode mirrors the primary rule above.
 *   - a subagent with no parent is not resumable at all.
 *
 * `started` therefore keeps its documented meaning for the caller: a turn is now
 * running because of this row.
 */
async function startSubagentInjectionContinuation(
	recipient: Awaited<ReturnType<typeof narratorService.getById>>,
	locale: Locale,
	replyInUserLanguage: boolean,
	executionPrincipal?: QuestionExecutionPrincipal,
): Promise<{ started: boolean }> {
	const narratorId = recipient.id;
	if (!recipient.parentNarratorId) return { started: false };
	if (isPlanModeTrait(recipient.traits)) return { started: false };
	// A live runtime owner will pick the row up on its next pass; starting a second
	// run would be the race `resumeSubagent` refuses anyway, just reported worse.
	if (isNarratorRuntimeBusy(narratorId)) return { started: false };
	const { hasActiveSubagentResumeRun, resumeSubagent } = await import("./subagent-resume");
	if (hasActiveSubagentResumeRun(narratorId)) return { started: false };

	try {
		const resumed = await resumeSubagent({
			subagentId: narratorId,
			intent: "continue_tool_results",
			// `parent_agent`, not `user`: nobody typed this. The actor decides whether the
			// resumed run may report back to the parent, which is right for a row the
			// server authored on the parent's behalf.
			actor: "parent_agent",
			locale,
			replyInUserLanguage,
			executionPrincipal,
		});
		return { started: resumed.started };
	} catch (err) {
		// Every refusal `resumeSubagent` makes is a ValidationError (archived, already
		// running, not resumable). Logged rather than propagated for the same reason the
		// injection module swallows wake failures: the row is persisted, so the content
		// waits for the next request instead of being lost — and a producer notifying a
		// subagent must not fail because the subagent could not be woken.
		logger.warn("Injection delivered but resuming the subagent failed", {
			narratorId,
			error: String(err),
		});
		return { started: false };
	}
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
 * Deliberately conservative: it never competes with a live owner, and repairs a
 * status row that outlived recovery before starting anything. Queued user input is
 * explicit work, including in plan mode; only autonomous goal/inbound continuation
 * must refuse to wake a plan-mode narrator.
 */
export async function resumeBufferedMessagesIfIdle(
	narratorId: string,
	locale: Locale = "en",
	replyInUserLanguage = false,
): Promise<{ resumed: boolean }> {
	if ((await getBufferedMessagesAsync(narratorId)).length === 0) return { resumed: false };
	const result = await continuationStartLock.acquire(narratorId, async () => {
		if ((await getBufferedMessagesAsync(narratorId)).length === 0) return { resumed: false };
		// A live loop (or any other runtime owner) will consume the queue itself.
		if (isNarratorRuntimeBusy(narratorId)) return { resumed: false };

		// Recovery left the row at `working` with nobody behind it; drop it to idle so
		// the resumed turn transitions honestly instead of stacking onto a zombie.
		await reconcileRunningStatus(narratorId);

		const narrator = await narratorService.getById(narratorId);
		if (isSubagentVariant(narrator.variant)) return { resumed: false };
		if (narrator.status !== "idle") return { resumed: false };

		const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
		if (active._loopRunning) return { resumed: false };

		const dispatch = await resumeNextBufferedMessageUnlocked(active, locale);
		return { resumed: true, dispatch };
	});
	if ("dispatch" in result) await result.dispatch?.();
	return { resumed: result.resumed };
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
		if (isLoopRunning(narratorId)) return { started: false };

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

/**
 * `narrator_message_refs` stores only the reference; "is this a real top-level turn?"
 * lives on the message row (its `parent_tool_use_id` and `role`). Expressed as a
 * correlated EXISTS rather than a join, deliberately.
 *
 * Joining the message row put `parent_tool_use_id IS NULL` in the WHERE clause, which
 * the planner satisfied by driving FROM `narrator_messages` through
 * `idx_messages_parent_tool_use_lookup` — a predicate matching ~90% of every message in
 * the database — then looking up each ref and sorting the narrator's whole ref set in a
 * temp B-tree just to read a handful of rows (281-293ms on a 131k-message library).
 * As EXISTS the planner walks `idx_narrator_refs_seq` in `seq DESC` order and stops after
 * the LIMIT, answering each probe from the message primary key: 0.00-0.01ms, with
 * row-for-row identical results on the three largest narrators.
 */
function messageRefExists(opts: {
	roles?: readonly ("user" | "assistant")[];
	requireTopLevel?: boolean;
}) {
	const conditions = [eq(narratorMessages.id, narratorMessageRefs.messageId)];
	if (opts.requireTopLevel) conditions.push(isNull(narratorMessages.parentToolUseId));
	if (opts.roles) conditions.push(inArray(narratorMessages.role, [...opts.roles]));
	return exists(
		db
			.select({ one: sql`1` })
			.from(narratorMessages)
			.where(and(...conditions)),
	);
}

/** Minimal message shape needed to pick the retry target. */
interface RetryCandidateMessage {
	id: string;
	role: string;
	contentText?: string | null;
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
	if (msg.role !== "assistant" || msg.contentText?.trim()) return false;
	if (!Array.isArray(msg.contentJson) || msg.contentJson.length > 0) return false;
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
	...args: Parameters<typeof retryLastMessageUnlocked>
): ReturnType<typeof retryLastMessageUnlocked> {
	return withNarratorStartAdmission(args[0], () => retryLastMessageUnlocked(...args));
}

async function retryLastMessageUnlocked(
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
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				isNull(narratorMessageRefs.segmentCompactId),
				messageRefExists({ roles: ["user", "assistant"], requireTopLevel: true }),
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

	const prompt = projectFileReferenceText(
		lastMsg.contentText ?? "",
		getFileReferenceSnapshots(lastMsg.contentJson),
	);
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

	// Retry is not consent to roll back files. In particular, history-only rollback
	// leaves hidden file checkpoints after this user message; they must stay intact.
	// Publish each empty-placeholder removal immediately: later history cleanup can fail.
	for (const messageId of resolved.emptyAssistantIds) {
		if (await narratorService.deleteEmptyRetryPlaceholder(narratorId, messageId)) {
			broadcastToNarrator(narratorId, {
				type: "messages_deleted",
				narratorId,
				deletedMessageIds: [messageId],
			});
		}
	}
	const { deletedMessageIds } = await narratorService.deleteMessagesAfter(narratorId, lastMsg.id, {
		skipRevert: true,
	});
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
	...args: Parameters<typeof continueNarratorUnlocked>
): ReturnType<typeof continueNarratorUnlocked> {
	return withNarratorStartAdmission(args[0], () => continueNarratorUnlocked(...args));
}

async function continueNarratorUnlocked(
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
			message: fileReferenceMessageForDisplay(userMsg),
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
 *
 * ⚠️ Not used by production code: re-runs insert a NEW row with a higher
 * `executionAttempt` (`prepareToolCallExecutionAttempt`). Applying these fields to an
 * existing row IN PLACE moves it `pending → initializing` on the SAME attempt, which
 * the client's `LIVE_TOOL_PHASE_RANK` (shared/tool-row-status.ts) treats as a stale
 * snapshot and refuses. Any new caller must also bump `executionAttempt`.
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

// Loop-less tool execution owns the foreground slot until its cleanup settles.
const narratorToolExecutionAdmissions = createRuntimeMapView("toolReplayCompletion");

type ToolCallReexecutionLaunch =
	| ReExecuteDeniedResult
	| { completion: Promise<ReExecuteDeniedResult> }
	| { retryAfter: Promise<void> };

async function completeToolCallReexecution(
	narratorId: string,
	prepare: () => Promise<ToolCallReexecutionLaunch>,
): Promise<ReExecuteDeniedResult> {
	for (;;) {
		const launch = await withNarratorStartAdmission(narratorId, prepare);
		if ("retryAfter" in launch) {
			// Recovery batches may submit multiple tools for the same owner. Preserve
			// their serial execution, but wait outside the start mutex and recheck.
			await launch.retryAfter;
			continue;
		}
		return "completion" in launch ? launch.completion : launch;
	}
}

/**
 * Re-execute a tool call that was denied by the user (or whose pending
 * permission was cancelled by an interrupt) in the latest assistant turn.
 *
 * The denied tool_use block is still present in the assistant message's
 * contentJson, and its tool_result is reconstructed from the narrator_tool_calls
 * rows at history-build time. A real retry first isolates shared messages with COW,
 * appends a fresh attempt without inherited approval/evidence/accounting, and binds
 * executeTool to that exact row. Recovery may reuse only a trusted unstarted attempt.
 * The model/display projection selects the newest attempt while retaining prior facts.
 */
export async function reExecuteDeniedToolCall(
	...args: Parameters<typeof reExecuteDeniedToolCallUnlocked>
): Promise<ReExecuteDeniedResult> {
	return completeToolCallReexecution(args[0], () => reExecuteDeniedToolCallUnlocked(...args));
}

async function reExecuteDeniedToolCallUnlocked(
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
): Promise<ToolCallReexecutionLaunch> {
	const narrator = await narratorService.getById(narratorId);
	const restoringPersistedCall = Boolean(options?.persistedToolCallId);
	const currentExecution = narratorToolExecutionAdmissions.get(narratorId);
	if (restoringPersistedCall && currentExecution) return { retryAfter: currentExecution };
	// Recovery owns an outer runtime claim, but must not overlap an actual loop
	// or another tool reexecution. Ordinary retries also respect loop-less owners.
	if (isLoopRunning(narratorId) || (!restoringPersistedCall && isNarratorRuntimeBusy(narratorId))) {
		return { ok: false, reason: "narrator_busy" };
	}
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

	// The tool call must belong to the latest top-level assistant message so
	// re-running it does not reorder history relative to later turns.
	const isSubagent = isSubagentVariant(narrator.variant);
	const lastRef = await db
		.select({ messageId: narratorMessageRefs.messageId })
		.from(narratorMessageRefs)
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				messageRefExists({ roles: ["user", "assistant"], requireTopLevel: !isSubagent }),
			),
		)
		.orderBy(sql`${narratorMessageRefs.seq} DESC`)
		.limit(1);
	const latestAssistantMessageId = lastRef.length ? lastRef[0].messageId : null;
	let toolCall = await db.query.narratorToolCalls.findFirst({
		where: options?.persistedToolCallId
			? and(
					eq(narratorToolCalls.id, options.persistedToolCallId),
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				)
			: and(
					eq(narratorToolCalls.messageId, latestAssistantMessageId ?? ""),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
		orderBy: [desc(narratorToolCalls.executionAttempt), desc(narratorToolCalls.createdAt)],
	});

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

	const sourceToolCall = toolCall;
	const preparedAttempt = await narratorPersistence.prepareToolCallAttempt(
		narratorId,
		toolCall.id,
		restoringPersistedCall,
	);
	toolCall = preparedAttempt.toolCall;
	const toolCallBinding = await narratorPersistence.getToolCallBinding(
		narratorId,
		toolCall.messageId,
		toolUseId,
		toolCall.id,
	);

	// Atomically hand off the checked/prepared attempt to a long-lived work lease.
	// Await may depend on an independently running child whose Send(parent) needs
	// this same start mutex; only the completion handle may leave the transaction.
	const releaseRuntime = claimNarratorRuntime(narratorId, randomUUID());
	const executionOwner = tryClaimExecution(narratorId, "tool-replay");
	if (!executionOwner) {
		releaseRuntime();
		return { ok: false, reason: "narrator_busy" };
	}
	const settled = Promise.withResolvers<void>();
	narratorToolExecutionAdmissions.set(narratorId, settled.promise);
	let executionReleased = false;
	const releaseExecution = () => {
		if (executionReleased) return;
		executionReleased = true;
		if (executionOwner.isCurrent()) narratorToolExecutionAdmissions.delete(narratorId);
		executionOwner.release();
		releaseRuntime();
		settled.resolve();
	};
	const completion = withNarratorWorkAdmission(
		narratorId,
		async (): Promise<ReExecuteDeniedResult> => {
			try {
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

				// Reuse the same runtime/device ACL ceiling as the ordinary loop, including recovery.
				const oauthRuntime = await assertOAuthNarratorRuntimeActive(
					narratorId,
					active._currentUserId,
				);
				const sessionDevices = (await resolveSessionDevices(active._projectId ?? null)) ?? [];
				const rerunMessage = await db.query.narratorMessages.findFirst({
					where: eq(narratorMessages.id, toolCall.messageId),
					columns: { parentToolUseId: true },
				});
				const parentNarratorId = isSubagent ? (narrator.parentNarratorId ?? undefined) : undefined;
				const parentToolUseId = isSubagent
					? (rerunMessage?.parentToolUseId ?? undefined)
					: undefined;
				const config: import("../lib/agent").AgentConfig = {
					narratorId,
					conversationId: active.conversationId,
					model: active.model,
					provider: active.provider,
					cwd: active.cwd,
					locale,
					signal: active.abortController.signal,
					chapterId: active._chapterId,
					parentNarratorId,
					parentToolUseId,
					reviewReadOnlyBash: isSubagent && narrator.subagentType === "review",
					allowedTools: oauthRuntime ? new Set(oauthRuntime.allowedTools) : undefined,
					allowLocalExecution: oauthRuntime?.allowLocalExecution ?? true,
					onToolExecutionFinalAuthorization: buildFinalToolStartAuthorization({
						narratorId,
						cwd: active.cwd,
						signal: active.abortController.signal,
						userId: active._currentUserId,
						reviewReadOnlyBash: isSubagent && narrator.subagentType === "review",
					}),
					runtimeAuthorizationGuard: oauthRuntime
						? async () => {
								await assertOAuthNarratorRuntimeActive(narratorId, active._currentUserId);
							}
						: undefined,
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
					defaultDeviceId: sourceToolCall.executionDeviceId ?? active._defaultDeviceId ?? null,
					availableDevices: oauthRuntime
						? filterOAuthSessionDevices(sessionDevices, oauthRuntime)
						: sessionDevices,
					setDefaultDevice: (deviceId) => applySessionDefaultDevice(narratorId, active, deviceId),
					disabledTools: active._disabledTools,
					blockedSkills: {
						all: active._blockedSkills.all,
						names: [...active._blockedSkills.names],
					},
					...buildTreeSnapshotExecutionHooks({
						session: active,
						narratorId,
						isInGitRepo: active._isInGitRepo === true,
					}),
					requireToolCallBinding: true,
					onInternalReadAuthorization: async (toolUseId, binding) => {
						await narratorPersistence.validateToolCallBinding(narratorId, toolUseId, binding);
					},
					onInternalReadCreated: (toolUseId, binding, input, sequence) =>
						narratorPersistence.createInternalRead(narratorId, toolUseId, binding, input, sequence),
					onInternalReadCompleted: (toolUseId, binding, result) =>
						narratorPersistence.completeInternalRead(narratorId, toolUseId, binding, result),
					onToolExecutionStarting: (resolvedToolUseId, binding, startedAt) =>
						narratorPersistence.claimToolCallExecution(
							narratorId,
							resolvedToolUseId,
							binding,
							startedAt,
						),
					onExecutionTargetResolved: (resolvedToolUseId, target, binding) =>
						narratorService.updateToolCallExecutionTarget(
							narratorId,
							resolvedToolUseId,
							target,
							binding,
						),
					onExecutionPlanResolved: (resolvedToolUseId, plan, binding) =>
						narratorService.updateToolCallExecutionPlan(
							narratorId,
							resolvedToolUseId,
							plan,
							binding,
						),
					permissionHandler: (tName, input, tUseId, options) =>
						handlePermission(
							narratorId,
							active.abortController.signal,
							tName,
							input,
							tUseId,
							active.cwd,
							locale,
							parentNarratorId,
							options,
							parentToolUseId,
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
							config.reviewReadOnlyBash,
						),
					onDetachedToolResult: (event) => persistDetachedToolResult(narratorId, event),
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

				// Reproduce the exact execution identity frozen on the original pass. It pins the
				// audit-only selectionSource (a local tool frozen as "local_default" would otherwise be
				// recomputed as "session_default" once defaultDeviceId is seeded with the frozen device
				// id, which the persistence-layer frozen-target guard rejects once the row has left
				// "initializing") and, for a pre-granted re-run, acts as the baseline that executeTool
				// compares against to detect environment drift. Legacy rows without a frozen device
				// fall back to normal resolution.
				const preFrozenTarget = reconstructToolExecutionTarget(sourceToolCall);

				try {
					const result = await executeTool(
						{ name: toolName, input: toolInput, toolUseId },
						config,
						{
							toolCallBinding,
							...(options?.permissionMode === "normal" ||
							preparedAttempt.requiresFreshPermission ||
							!!oauthRuntime ||
							config.reviewReadOnlyBash
								? {}
								: { preGrantedPermission: { behavior: "allow" as const } }),
							...(preFrozenTarget ? { preFrozenTarget } : {}),
						},
					);

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
						await narratorService.overwriteToolCallInput(
							toolUseId,
							result.updatedInput,
							toolCall.id,
						);
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
				} catch (err) {
					// executeTool has already awaited the paired snapshot cleanup, even on failure.
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
				return await withNarratorMutationAdmission(narratorId, async () => {
					// Release the execution slot and mount the continuation in one short
					// transaction. A waiting revert may drain cleanup, but never start a turn.
					releaseExecution();
					if (isNarratorRevertAdmissionBlocked(narratorId)) {
						await narratorService.updateStatus(narratorId, "idle", { substatus: [] });
						disposeInactiveNarratorSession(narratorId, active);
						return { ok: true, shouldContinue: true };
					}
					await continueNarrator(narratorId, locale, replyInUserLanguage, userId);
					return { ok: true };
				});
			} finally {
				releaseExecution();
			}
		},
	);
	return { completion };
}

export async function executePersistedToolCall(
	input: Parameters<typeof executePersistedToolCallUnlocked>[0],
): Promise<ReExecuteDeniedResult> {
	return completeToolCallReexecution(input.narratorId, () =>
		executePersistedToolCallUnlocked(input),
	);
}

async function executePersistedToolCallUnlocked(input: {
	toolCallId: string;
	narratorId: string;
	locale?: Locale;
	replyInUserLanguage?: boolean;
	userId?: string | null;
	permissionMode?: "normal" | "preGranted";
}): Promise<ToolCallReexecutionLaunch> {
	const toolCall = await db.query.narratorToolCalls.findFirst({
		where: and(
			eq(narratorToolCalls.id, input.toolCallId),
			eq(narratorToolCalls.narratorId, input.narratorId),
		),
		columns: { toolUseId: true },
	});
	if (!toolCall) return { ok: false, reason: "not_found" };
	// Preserve the short-lock handoff: calling the public wrapper here would
	// await its completion while this outer recovery transaction still held the lock.
	return reExecuteDeniedToolCallUnlocked(
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
	...args: Parameters<typeof rollbackToBlockUnlocked>
): ReturnType<typeof rollbackToBlockUnlocked> {
	return withNarratorStartAdmission(args[0], () => rollbackToBlockUnlocked(...args));
}

async function rollbackToBlockUnlocked(
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
				// History-only: file state was already settled in step 0. Also avoids the
				// per-block rebuild loop inside deleteMessageBlocks.
				skipRevert: true,
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
					message: fileReferenceMessageForDisplay(updatedMsg),
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
	| FileReferenceSnapshot
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
		fileReferences?: FileReferenceSnapshot[];
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

	// Omission preserves accepted bytes; an explicit [] removes all references.
	const references = freezeFileReferenceSnapshots(
		opts?.fileReferences ?? getFileReferenceSnapshots(contentJson),
	);
	return [...imageBlocks, ...textFileBlocks, ...references, { type: "text", text: newContent }];
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
	/** Server-selected accepted snapshots; omitted keeps the target message's snapshots. */
	fileReferences?: FileReferenceSnapshot[];
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
	const selectedReferences = freezeFileReferenceSnapshots(
		opts?.fileReferences ?? getFileReferenceSnapshots(originalBlocks),
	);
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
		selectedReferences.length === 0 &&
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
			fileReferences: selectedReferences,
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
			message: fileReferenceMessageForDisplay(updatedMsg),
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

	runAgentLoop(
		active,
		projectFileReferenceText(effectivePrompt, selectedReferences),
		imageRefs.length > 0 ? imageRefs : undefined,
	).catch(async (err) => {
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
	});

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
	...args: Parameters<typeof editAssistantMessageUnlocked>
): ReturnType<typeof editAssistantMessageUnlocked> {
	return withNarratorWorkAdmission(args[0], () => editAssistantMessageUnlocked(...args));
}

async function editAssistantMessageUnlocked(
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
			message: fileReferenceMessageForDisplay(updatedMsg),
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
	...args: Parameters<typeof restoreAssistantMessageUnlocked>
): ReturnType<typeof restoreAssistantMessageUnlocked> {
	return withNarratorWorkAdmission(args[0], () => restoreAssistantMessageUnlocked(...args));
}

async function restoreAssistantMessageUnlocked(
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
			message: fileReferenceMessageForDisplay(updatedMsg),
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
	fileReferences?: FileReferenceSnapshot[],
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
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			fileReferences,
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
		message: fileReferenceMessageForDisplay(userMsg),
	});
	yield { type: "user_message", data: fileReferenceMessageForDisplay(userMsg) };

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
	return withNarratorWorkAdmission(narratorId, () =>
		cleanupPartialMessageUnlocked(partialId, narratorId),
	);
}

async function cleanupPartialMessageUnlocked(partialId: string, narratorId: string): Promise<void> {
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
	return withNarratorWorkAdmission(narratorId, () =>
		finalizeOrCleanupPartialMessageUnlocked(partialId, narratorId),
	);
}

async function finalizeOrCleanupPartialMessageUnlocked(
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
	...args: Parameters<typeof markInterruptedToolCallsForMessageUnlocked>
): ReturnType<typeof markInterruptedToolCallsForMessageUnlocked> {
	return withNarratorWorkAdmission(args[0], () =>
		markInterruptedToolCallsForMessageUnlocked(...args),
	);
}

async function markInterruptedToolCallsForMessageUnlocked(
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
 * protocol requirement that every tool_use has a matching tool_result.
 */
async function cleanupOrphanedToolCalls(narratorId: string, locale: Locale = "en"): Promise<void> {
	return withNarratorWorkAdmission(narratorId, () =>
		cleanupOrphanedToolCallsUnlocked(narratorId, locale),
	);
}

async function cleanupOrphanedToolCallsUnlocked(narratorId: string, locale: Locale): Promise<void> {
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
export async function completeOrphanedToolCalls(narratorId: string): Promise<void> {
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
	if (isExecutionSuspended(narratorId)) return false;
	// Tool reexecution occupies the same exclusive foreground slot as a loop.
	if (narratorLoopAdmissions.has(narratorId) || narratorToolExecutionAdmissions.has(narratorId)) {
		return true;
	}
	const active = activeNarrators.get(narratorId);
	return active?.alive === true && active._loopRunning === true;
}

/**
 * Exclusive history/file-revert admission. HTTP cancellation only governs acquisition;
 * after this resolves, the transaction owner MUST release after its true settlement.
 */
export async function acquireNarratorRevertAdmission(
	narratorId: string,
	options: { signal: AbortSignal; interrupt: boolean },
): Promise<() => void> {
	const { signal, interrupt } = options;
	signal.throwIfAborted();
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { id: true, variant: true, parentNarratorId: true },
	});
	if (!narrator) throw new NotFoundError("Narrator", narratorId);
	signal.throwIfAborted();
	// Users drive subagents directly, so a subagent is a valid revert root. It
	// reserves (and interrupts) only itself: its parent and siblings keep running.
	// The persisted root still orders it against a revert of the whole team.
	const isSubagent = isSubagentVariant(narrator.variant);
	const rootId = isSubagent ? await resolveNarratorAdmissionRoot(narratorId) : narratorId;
	signal.throwIfAborted();
	const busy = () => isNarratorRuntimeBusy(narratorId) || compactLocks.has(narratorId);
	if (!interrupt && (busy() || hasNarratorAdmissionWork(narratorId))) {
		throw new AppError("Narrator execution has not settled", 409, "NARRATOR_REVERT_BUSY");
	}
	const reservation = reserveNarratorRevertAdmission(narratorId, rootId);
	let released = false;
	const releaseAndResume = () => {
		if (released) return;
		released = true;
		reservation.release();
		// A loop's one-shot finalizer may already have tried (and been refused by
		// the waiting gate). Cancellation can also leave admitted cleanup running:
		// wait for its real settlement, rather than losing the wakeup to busy once.
		void (async () => {
			await waitForNarratorAdmissionWork(narratorId, new AbortController().signal);
			await resumeBufferedMessagesIfIdle(narratorId, "en");
		})().catch((error) => {
			if (!isNarratorRevertAdmissionBlocked(narratorId)) {
				logger.warn("Could not resume messages after file revert", {
					narratorId,
					error: String(error),
				});
			}
		});
	};
	try {
		if (interrupt) {
			const {
				getBackgroundAbortControllers,
				getForegroundAbortControllers,
				interruptForegroundSubagent,
			} = await import("./subagent-detach");
			const interrupted = new Set<AbortController>();
			interruptPlannedUpdateRecovery(narratorId);
			// No start mutex is held here. Starting work may not have mounted its abort
			// controller yet, so rescan until ALL admitted work (including delivery) exits.
			while (busy() || hasNarratorAdmissionWork(narratorId)) {
				signal.throwIfAborted();
				for (const owner of new Set([narratorId, ...listNarratorAdmissionOwners(narratorId)])) {
					// A soft foreground abort suspends for manual input; a revert needs
					// the real terminal boundary, including an already-suspended runner.
					if (owner !== narratorId || isSubagent)
						interruptForegroundSubagent(owner, { hard: true });
					const controllers = [
						activeNarrators.get(owner)?.abortController,
						getBackgroundAbortControllers().get(owner),
						getForegroundAbortControllers().get(owner),
						compactLocks.get(owner)?.abortController,
					];
					for (const controller of controllers) {
						if (!controller || interrupted.has(controller)) continue;
						interrupted.add(controller);
						controller.abort(new Error("Narrator interrupted for file revert"));
					}
				}
				await new Promise<void>((resolve, reject) => {
					const onAbort = () => {
						clearTimeout(timer);
						signal.removeEventListener("abort", onAbort);
						reject(signal.reason);
					};
					const timer = setTimeout(() => {
						signal.removeEventListener("abort", onAbort);
						resolve();
					}, INTERRUPT_IDLE_POLL_MS);
					signal.addEventListener("abort", onAbort, { once: true });
				});
			}
		}
		await reservation.acquire(signal, busy);
		return releaseAndResume;
	} catch (error) {
		releaseAndResume();
		throw error;
	}
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
	// A manual-override suspension retains the runner but executes no turn. Local
	// abort cannot wake that wait; the next resumed turn rebuilds history from DB.
	const busy = () =>
		!isExecutionSuspended(narratorId) &&
		(isLoopRunning(narratorId) || isNarratorRuntimeBusy(narratorId));
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
export function hasPendingBufferedWork(narratorId: string): boolean {
	if (resolveRuntimeQueueBackend() === "postgres")
		throw new Error(
			"hasPendingBufferedWork is synchronous and cannot inspect the PostgreSQL mailbox; use getBufferedMessagesAsync",
		);
	return getBufferedMessages(narratorId).length > 0;
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

export function resolveRuntimeReasoningEffort(
	provider: string,
	model: string,
	reasoningEffort: ReasoningEffort | null | undefined,
): ReasoningEffort | null {
	return reasoningEffort ?? resolveDefaultReasoningEffort(provider, model) ?? null;
}

export const inheritedModelRuntime = createInheritedModelRuntime({
	getActive: (id) => activeNarrators.get(id),
	activeValues: () => activeNarrators.values(),
	readNarrator: (id) =>
		db.query.narrators.findFirst({
			where: eq(narrators.id, id),
			columns: { model: true, parentNarratorId: true, subagentType: true, reasoningEffort: true },
		}),
	resolve: async (narrator, actingUserId, stickyProvider) => {
		const settingsRevision = getSettingsRevision();
		return {
			...(await resolveSubagentModelForRun(narrator, actingUserId, stickyProvider)),
			settingsRevision,
		};
	},
	apply: (active, resolved) => {
		active._modelRef = resolved.modelRef;
		active.model = resolved.model;
		active.provider = resolveProvider(resolved.model);
		active._settingsRevision = resolved.settingsRevision;
		active._inheritedReasoningEffort = resolved.reasoningEffort;
		active._parentReasoningEffort = resolved.parentReasoningEffort;
		active.reasoningEffort = resolveRuntimeReasoningEffort(
			active.provider,
			active.model,
			subagentRunReasoningEffort(resolved, active._reasoningEffortRef),
		);
		broadcastToNarrator(active.narratorId, {
			type: "model_changed",
			narratorId: active.narratorId,
			model: FOLLOW_PARENT_MODEL,
		});
		broadcastToNarrator(active.narratorId, {
			type: "model_settings_changed",
			narratorId: active.narratorId,
			model: active.model,
			reasoningEffort: active.reasoningEffort ?? null,
			...(resolved.inheritance && { modelInheritance: resolved.inheritance }),
			status: active._loopRunning ? "pending" : "updated",
			applyAt: active._loopRunning ? "next_model_request" : "next_request",
		});
	},
	reportError: (active, error) => {
		logger.warn("Failed to refresh inherited runtime model", {
			narratorId: active.narratorId,
			error: String(error),
		});
	},
});

/** Await only at request boundaries, never cancel an already-running provider request. */
export async function settleNarratorRuntimeModel(active: ActiveNarrator): Promise<void> {
	await inheritedModelRuntime.settle(active);
	while (
		active.alive &&
		active._modelSelectionRef === FOLLOW_PARENT_MODEL &&
		active._settingsRevision !== getSettingsRevision()
	) {
		// A default/aggregation change must go through pool policy again, not the
		// ordinary resolveEffectiveModel shortcut (which knows nothing about ACL).
		inheritedModelRuntime.refresh(active);
		await inheritedModelRuntime.settle(active);
	}
}

export function updateNarratorModel(narratorId: string, model: string): void {
	const active = activeNarrators.get(narratorId);
	if (active?.alive) {
		inheritedModelRuntime.select(active, model || FOLLOW_DEFAULT_MODEL);
		if (model === FOLLOW_PARENT_MODEL) {
			inheritedModelRuntime.refresh(active);
			inheritedModelRuntime.parentChanged(narratorId);
			return;
		}
		active._modelRef = model || FOLLOW_DEFAULT_MODEL;
		active._settingsRevision = getSettingsRevision();
		const effectiveModel = resolveEffectiveModel(active._modelRef, active.provider);
		active.model = effectiveModel;
		active.provider = resolveProvider(effectiveModel);
		active._modelUnavailableWaitCancel?.();
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
	} else if (
		model !== FOLLOW_PARENT_MODEL &&
		updateActiveSubagentModel(narratorId, resolveEffectiveModel(model))
	) {
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
	inheritedModelRuntime.parentChanged(narratorId);
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
			subagentRunReasoningEffort(
				{
					reasoningEffort: active._inheritedReasoningEffort,
					parentReasoningEffort: active._parentReasoningEffort,
				},
				reasoningEffort,
			),
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
	// Children with no override of their own follow this narrator's tier.
	inheritedModelRuntime.parentChanged(narratorId);
}

/** Apply only after the input owns execution and its predecessor has finalized. */
async function applyAcceptedModelOverride(
	narratorId: string,
	override: NonNullable<BufferedMessage["executionIntent"]>["modelOverride"],
): Promise<void> {
	if (!override?.model) return;
	const narrator = await narratorService.getById(narratorId);
	// Both fields change together. A retried temporary override must preserve the
	// original baseline, and a permanent override must clear any stale restore marker.
	await db
		.update(narrators)
		.set({
			model: override.model,
			pendingModelRestore:
				override.mode === "temporary"
					? (narrator.pendingModelRestore ?? narrator.model ?? "__default__")
					: null,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(narrators.id, narratorId));
	updateNarratorModel(narratorId, override.model);
}

/** Persist the original model so the loop finalizer (or startup recovery) can restore it. */
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
/** Bounded audit maintenance, also used by isolated restart fixtures. */
export async function recoverPermissionRuleRequestAuditsOnStartup(): Promise<void> {
	const { recoverPermissionRuleRequests } = await import("./permission-rule-request-service");
	let after: string | undefined;
	do {
		const page = recoverPermissionRuleRequests({
			after,
			limit: 100,
			reason: "Interrupted by server restart",
		});
		after = page.nextCursor;
		if (after) await new Promise<void>((resolve) => setTimeout(resolve, 0));
	} while (after);
}

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

	// A restart invalidates attempt-bound approval authority, including approved
	// rows whose tool had not reached consume. Never apply yesterday's receipt.
	await recoverPermissionRuleRequestAuditsOnStartup();

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

	// Mailbox rows are authoritative and loaded per narrator on demand. Startup must not
	// hydrate all bodies/attachments or reconstruct a second queue authority.
}

// ---------------------------------------------------------------------------
// Optional tool management
// ---------------------------------------------------------------------------

/**
 * Read `chapterSettings.routines` out of a project row.
 *
 * Tolerant by design: a malformed `chapterSettings` must degrade to "no project
 * opinion" rather than break session startup.
 */
function parseProjectRoutineConfig(raw: unknown): RoutineModeConfig | undefined {
	if (!raw) return undefined;
	try {
		const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
		const routines = (parsed as { routines?: RoutineModeConfig } | null)?.routines;
		return routines && typeof routines === "object" ? routines : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether an optional tool would be visible to the model on the next turn.
 *
 * Mirrors the resolution order used when building a session (`ensureActive`) and
 * the loop `toolFilter`, so the UI can tell "not loaded" from "loaded" without
 * starting a session:
 *   1. custom trait deny-list wins (tool hidden even if loaded)
 *   2. active session's in-memory set, when a session exists
 *   3. otherwise: a `resident` routine mode (project override before global), or
 *      persisted `enabledTools`
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
	/**
	 * True when the tool is preloaded into every session by its routine mode.
	 *
	 * Kept under the original name for existing clients, but it now reflects the
	 * EFFECTIVE mode (project override included), not just the global setting —
	 * a caller asking "does this narrator get it for free?" wants that answer.
	 */
	globallyEnabled: boolean;
	/** The effective routine mode, when the tool belongs to a tool routine. */
	mode?: ToolRoutineMode;
}> {
	if (!OPTIONAL_TOOLS.has(toolName)) {
		return { state: "unknown_tool", globallyEnabled: false };
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
	const narratorProjectId = await resolveNarratorProjectId(narrator);

	// Same project layer the session build uses, so this never reports a state the
	// next turn would contradict.
	let projectRoutineConfig: RoutineModeConfig | undefined;
	if (narratorProjectId) {
		const project = await db.query.projects.findFirst({
			where: eq(projects.id, narratorProjectId),
			columns: { chapterSettings: true },
		});
		projectRoutineConfig = parseProjectRoutineConfig(project?.chapterSettings);
	}

	let mode: ToolRoutineMode | undefined;
	for (const routine of getBuiltinToolRoutines()) {
		if (!routine.tool) continue;
		if (!getBuiltinToolNames(routine.tool).includes(toolName)) continue;
		mode = resolveEffectiveToolRoutineMode(routine, settings.routines, projectRoutineConfig).mode;
		if (isPreloadedMode(mode)) break;
	}
	const globallyEnabled = mode ? isPreloadedMode(mode) : false;

	const stateTraits = await resolveEffectiveTraits({
		narratorTraits: narrator.traits,
		projectId: narratorProjectId,
		actingUserId: actingUserId ?? null,
	});
	if (getDisabledToolSet(stateTraits.traits).has(toolName)) {
		return { state: "disabled_by_trait", globallyEnabled, ...(mode ? { mode } : {}) };
	}

	const active = activeNarrators.get(narratorId);
	if (active) {
		return {
			state: active._enabledOptionalTools.has(toolName) ? "loaded" : "not_loaded",
			globallyEnabled,
			...(mode ? { mode } : {}),
		};
	}

	const persisted = Array.isArray(narrator.enabledTools) ? narrator.enabledTools : [];
	const loaded = globallyEnabled || persisted.includes(toolName);
	return { state: loaded ? "loaded" : "not_loaded", globallyEnabled, ...(mode ? { mode } : {}) };
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
	getBufferedMessagesAsync,
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
