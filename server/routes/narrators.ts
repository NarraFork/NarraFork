import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBufferQueueMode } from "@shared/buffer-queue-mode";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import {
	type FileReference,
	type FileReferenceSnapshot,
	fileReferenceMessageForDisplay,
} from "@shared/file-reference";
import { formatOriginLabel } from "@shared/message-origin";
import { FOLLOW_PARENT_MODEL } from "@shared/model-inheritance";
import {
	MAX_EDIT_IMAGES_PER_MESSAGE,
	MAX_EDIT_TEXT_FILES_PER_MESSAGE,
	MAX_NARRATOR_ATTACHMENT_BYTES,
} from "@shared/text-file-types";
import {
	and,
	asc,
	type Column,
	count as countFn,
	desc,
	eq,
	exists,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	ne,
	or,
	sql,
} from "drizzle-orm";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { activeDatabaseBackend, db } from "../db";
import {
	apiRequests,
	chapters,
	containerInstances,
	narratorBlacklistCmds,
	narratorBlacklistDirs,
	narratorMessageRefs,
	narratorMessages,
	narratorQuestions,
	narrators,
	narratorToolCalls,
	narratorWhitelistCmds,
	narratorWhitelistDirs,
	projects,
	terminals,
	users,
} from "../db/schema";
import { summaryGenerate } from "../lib/agent";
import { getFileReferenceSnapshots } from "../lib/agent/file-reference-projection";
import { generateWithFirstTokenTimeout } from "../lib/agent/generate-first-token-timeout";
import { takeOverExitPlanReflection } from "../lib/agent/tools/exit-plan-reflection";
import { previewStructSedChange } from "../lib/agent/tools/struct-sed";
import { takeOverTaskReflection } from "../lib/agent/tools/task-reflection";
import { redactSpillPointerPaths } from "../lib/api-request-dump-store";
import { narratorTraitsLock } from "../lib/async-mutex";
import {
	AUTO_CONTINUATION_OVERRIDE_VALUES,
	type AutoContinuationOverride,
	BOOLEAN_OVERRIDE_VALUES,
	type BooleanOverride,
	DANGER_REFLECTION_OVERRIDE_VALUES,
	type DangerReflectionOverride,
	normalizeAutoContinuationOverride,
	normalizeBooleanOverride,
	normalizeDangerReflectionOverride,
} from "../lib/boolean-override";
import {
	click as browserClick,
	screenshot as browserScreenshot,
	scroll as browserScroll,
	type as browserType,
} from "../lib/browser/actions";
import { DEFAULT_VIEWPORT } from "../lib/browser/pool";
import type { BrowserSession as BrowserSessionType } from "../lib/browser/session";
import {
	closeSession as closeBrowserSession,
	getSession as getBrowserSession,
	listSessions as listBrowserSessions,
	MAX_SESSION_TTL_MS,
	MIN_SESSION_TTL_MS,
	setSessionTtl as setBrowserSessionTtl,
	stopTracing as stopBrowserTracing,
	touchSessionVisual,
} from "../lib/browser/session";
import { getBuiltinToolNames, getBuiltinToolRoutines } from "../lib/builtin-routines";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { resolveFastModeForUser } from "../lib/fast-mode";
import {
	parseFileReferenceInput,
	replaceFileReferenceSnapshots,
} from "../lib/file-reference-input";
import { generateId, generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import {
	narratorPrincipalOf,
	requireAccessToNarratorRow,
	requireNarratorAccess,
	requireOwningNarratorAccess,
} from "../lib/narrator-access";
import {
	BLOCKED_SKILLS_TRAIT_PREFIX,
	buildCustomTraitsResponse,
	DISABLED_TOOLS_TRAIT_PREFIX,
	getBlockedSkills,
	getDisabledToolSet,
	normalizeBlockedSkills,
	normalizeDisabledTools,
	normalizeSubagentModelRestriction,
	removeEncodedTrait,
	SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX,
	upsertEncodedTrait,
} from "../lib/narrator-custom-traits";
import {
	addTrait,
	hasTrait,
	isSubagentVariant,
	parseSubstatus,
	parseTraits,
	redactInternalTraits,
	removeTrait,
} from "../lib/narrator-utils";
import { isPermissionMode, PERMISSION_MODES } from "../lib/permission-modes";
import { buildPlanFileRelPath } from "../lib/plan-file-path";
import { getHome } from "../lib/platform";
import { requireProjectAccess } from "../lib/project-access";
import {
	buildSetupAssistantSystemPrompt,
	formatDependencyBriefing,
	getSetupAssistantStartMessage,
	getSetupAssistantTitle,
	getToolMessage,
	getToolMessageWithParams,
	getUserLanguage,
	getUserReplyInLanguage,
	type Locale,
	resolveSetupAuthorization,
	selectActionableDependencies,
} from "../lib/prompt-i18n";
import {
	getPromptOptimizeInstruction,
	type PromptOptimizeStyle,
} from "../lib/prompts/prompt-optimize";
import {
	FOLLOW_DEFAULT_MODEL,
	getQueueDuringCompaction,
	resolveEffectiveModel,
	settings,
} from "../lib/settings";
import {
	deleteAvatarImage,
	deleteUploadedImage,
	type ImageRef,
	saveAvatarImage,
	saveUploadedImage,
	validateTextFile,
	validateUploadedImage,
} from "../lib/uploads";
import {
	askInPassingSchema,
	askInPassingStartSchema,
	asyncQuestionAnswerSchema,
	asyncQuestionDetailQuerySchema,
	asyncQuestionListQuerySchema,
	asyncQuestionSupplementSchema,
	browserInteractSchema,
	bufferQueueModeSchema,
	createBlacklistCmdSchema,
	createBlacklistDirSchema,
	createNarratorSchema,
	createSetupAssistantSchema,
	createWhitelistCmdSchema,
	createWhitelistDirSchema,
	deviceBrowseQuerySchema,
	editAndRegenerateJsonSchema,
	editAssistantMessageSchema,
	forkNarratorSchema,
	humanAttentionListQuerySchema,
	migrateBrokenModelNarratorsSchema,
	narratorExportQuerySchema,
	narratorGrantCreateSchema,
	narratorGrantUpdateSchema,
	narratorVisibilitySchema,
	narratorWriteAudienceSchema,
	permissionDecisionSchema,
	reorderBufferSchema,
	retryFailedCompactSchema,
	revertFilesSchema,
	revertScopeSchema,
	rollbackToBlockSchema,
	segmentCompactSchema,
	sendMessageSchema,
	subagentRecoverySchema,
	suggestAnswersSchema,
	updateBlacklistCmdSchema,
	updateBlacklistDirSchema,
	updateBufferedMessageModeSchema,
	updateBufferedMessageSchema,
	updateNarratorDraftSchema,
	updateNarratorHandleSchema,
	updateNarratorModelSchema,
	updateNarratorTitleSchema,
	updateSegmentCompactSummarySchema,
	updateWhitelistCmdSchema,
	updateWhitelistDirSchema,
} from "../lib/validators";
import {
	applyRevertPlanSchema,
	createRevertActionPreviewSchema,
	createRevertPlanSchema,
	optimizePromptSchema,
	revertPlanFilesQuerySchema,
	revertPlanIdSchema,
} from "../lib/validators/narrators";
import { validateSubagentModelRestrictionInput } from "../lib/validators/subagent-models";
import { requireAdmin } from "../middleware/auth";
import { isExecutionSuspended } from "../services/agent-runtime/ownership";
import { coerceAskQuestions } from "../services/ask-user-question-coerce";
import { generateAskUserQuestionAnswers } from "../services/ask-user-question-reflection";
import {
	hasBrokenModelMigrationUndo,
	migrateBrokenModelNarrators,
	scanBrokenModelNarrators,
	undoLastBrokenModelMigration,
} from "../services/broken-model-migration-service";
import type {
	BashCommandResult,
	BlockAllSkillsResult,
	BlockSkillResult,
	LoadSkillResult,
	LoadToolNotFound,
	LoadToolResult,
	SpecGoalCommandResult,
	UnblockAllSkillsResult,
	UnblockSkillResult,
	UnloadToolNotFound,
	UnloadToolResult,
} from "../services/command-service";
import { getSlashMenuItems, resolveCommand } from "../services/command-service";
import {
	type LiveCompactStreamEvent,
	liveCompactProgress,
	subscribeLiveCompactProgress,
} from "../services/compact-live-state";
import { dependencyService } from "../services/dependency-service";
import {
	browseRemoteDirectory,
	resolveRemoteBrowseTarget,
} from "../services/device-transfer-service";
import { normalizePathKey, type PathFlavor, pathKeyContains } from "../services/execution-policy";
import { captureFileReferences } from "../services/file-reference-service";
import {
	applyToolCall,
	type DeviceFileIdentity,
	type DeviceFileState,
	deviceFileKey,
	FileHistoryError,
	getAffectedDeviceFilesStrict,
	getToolCallFileIdentityStrict,
	rebuildDeviceFileState,
	rebuildDeviceFileStatesExcluding,
} from "../services/file-state-rebuild";
import { gitService } from "../services/git-service";
import { getStatusSummaryCached } from "../services/git-status-cache";
import {
	getHumanAttentionForPrincipal,
	listHumanAttentionForPrincipal,
} from "../services/human-attention-service";
import {
	canWriteNarrator,
	filterReadableNarrators,
	NARRATOR_ACL_COLUMNS,
	narratorReadableWhere,
} from "../services/narrator-acl";
import {
	deleteBufferedTextFile,
	persistAdditionalBufferedTextFiles,
	retryBufferedMessage,
	updateBufferedMessageMode,
} from "../services/narrator-buffer";
import { getNarratorContextComposition } from "../services/narrator-context-composition";
import {
	getNarratorDraft,
	getNarratorIdsWithDraft,
	narratorHasDraft,
	updateNarratorDraft,
} from "../services/narrator-draft-service";
import { buildExportFileName, streamNarratorExport } from "../services/narrator-export";
import { getNarratorGitSummary } from "../services/narrator-git-summary";
import {
	countNarratorMessageRefs,
	countNarratorMessageRefsBatch,
} from "../services/narrator-message-count";
import {
	deferPendingQuestion,
	disarmQuestionReflection,
	getQuestionReflectionDeadline,
	reflectPendingAskUserQuestion,
	resolveDecisionNarratorId,
	stopDangerReflectionLoop,
	takeOverQuestionReflection,
} from "../services/narrator-permission";
import { reconstructToolExecutionTarget } from "../services/narrator-persistence";
import { enterNarratorPlanMode, exitNarratorPlanMode } from "../services/narrator-plan-mode";
import {
	answerAsyncQuestion,
	countOpenAsyncQuestions,
	dismissAsyncQuestion,
	getBoundedQuestionDetail,
	ignoreAsyncQuestion,
	listAllOpenAsyncQuestionsForPrincipal,
	listAsyncQuestions,
	listQuestionSummaries,
	supplementAsyncQuestion,
} from "../services/narrator-question-service";
import { dbTransactionWithSeqFloor } from "../services/narrator-refs/seq-floor-tx";
import { claimShiftInsertSlot } from "../services/narrator-refs/seq-store";
import {
	requireSqliteLazyRefsBackfill,
	resolveLazyLineage,
} from "../services/narrator-refs-backfill";
import {
	previewNarratorScopedForToolUses,
	previewNarratorScopedFromSeq,
	revertNarratorScopedFromSeq,
} from "../services/narrator-scoped-revert";
import {
	handleBashCommand,
	handleBlockAllSkillsCommand,
	handleBlockSkillCommand,
	handleLoadSkillCommand,
	handleLoadToolCommand,
	handleUnblockAllSkillsCommand,
	handleUnblockSkillCommand,
	handleUnloadToolCommand,
	interruptManualBash,
	narratorService,
} from "../services/narrator-service";
import {
	acceptUserMessage,
	awaitCompactCompletion,
	type BufferCreator,
	cancelCompact,
	cancelPendingExitPlanMode,
	clearBufferedMessageSoftStopIfIdle,
	closeNarrator,
	continueNarrator,
	editAndRegenerate,
	editAssistantMessage,
	getBufferedMessagesAsync,
	getNarratorExecutionDeviceState,
	interruptAndWaitForIdle,
	interruptNarrator,
	isCompactInProgress,
	isLoopRunning,
	isNarratorActive,
	normalizeRollbackBlockIndexForMessage,
	persistGoalAddedNotice,
	reconcileRunningStatus,
	reExecuteDeniedToolCall,
	reorderBufferedMessages,
	reprocessAllPendingPermissions,
	resolveOptionalToolState,
	resolvePermissionOrDangerReflection,
	restoreAssistantMessage,
	retryFailedCompact,
	retryLastMessage,
	rollbackToBlock,
	runCustomCompact,
	runSegmentCompact,
	sendMessage,
	setNarratorDefaultDevice,
	setTemporaryModelRestore,
	startInjectionContinuationIfPossible,
	startSpecContinuationIfPossible,
	toBufferSummary,
	updateActiveBlockedSkills,
	updateActiveDisabledTools,
	updateBufferedMessage,
	updateNarratorModel,
	updateNarratorPermissionMode,
	updateNarratorReasoningEffort,
} from "../services/narrator-session";
import {
	activeNarrators,
	type BufferedMessage,
	getNarratorRuntimeModel,
	isNarratorRuntimeBusy,
	planModeAskedOnce,
	requestPlanModePromptRebuild,
	resetActiveUpstreamSession,
	type SavedBufferedFile,
	withNarratorWorkAdmission,
} from "../services/narrator-session-state";
import {
	getNarratorAccess,
	grantNarratorAccess,
	revokeNarratorGrant,
	setNarratorVisibility,
	setNarratorWriteAudience,
	updateNarratorGrant,
} from "../services/narrator-sharing";
import {
	buildRecoveryNotifyPrompt,
	markRecoveryCardResolved,
	resumeIncompleteAgentWorkForContinue,
	resumeRecoverySubagents,
	startRecoveryAwaitBatch,
} from "../services/narrator-subagent-recovery";
import { generateTitle, persistTitle } from "../services/narrator-title";
import { permissionRuleService } from "../services/permission-rule-service";
import {
	applyLocalRevertPlan,
	getLocalRevertPlan,
	listLocalRevertPlanFiles,
	prepareLocalRevertAction,
	prepareLocalRevertPlan,
} from "../services/revert-planner-local-access";
import { searchService } from "../services/search-service";
import { skillService } from "../services/skill-service";
import {
	buildImpreciseRevertWarnings,
	DEFAULT_REVERT_SCOPE,
	finalizeSnapshotRevert,
	loadTreePreviewContents,
	previewSeqTreeRevert,
	type RevertResult,
	type RevertScope,
	type RevertWarning,
	resolveNarratorCwd,
	revertFromSeqTree,
	unavailableSnapshotRevert,
} from "../services/snapshot-revert";
import { broadcastSpecChanged } from "../services/spec-broadcast";
import { appendProtectedSpecTask } from "../services/spec-vfs-service";
import { resolveStandaloneNarratorCwd } from "../services/standalone-narrator-cwd";
import {
	resolveSubagentModelForRun,
	resolveSubagentModelInheritance,
} from "../services/subagent-model";
import { resumeSubagent, withSubagentResumeLock } from "../services/subagent-resume";
import { TAKEN_OVER_SUBSTATUS } from "../services/subagent-takeover";
import { broadcastSubagentTakeoverChanged } from "../services/subagent-takeover-broadcast";
import { getToolEditPreview } from "../services/tool-edit-preview";
import {
	parseHistoricalWriteDocumentReference,
	parseTextDocumentRangeQuery,
	toolInputStreamSource,
} from "../services/tool-input-stream-source";
import { usageHistoryService } from "../services/usage-history-service";
import { syncNarratorDraftToRecentTabs } from "../services/user-preferences-service";
import { assertWorkspaceHistoryRevertSupported } from "../services/workspace-context-service";
import {
	broadcastToNarrator,
	broadcastToUser,
	getNarratorIdsWithPresence,
	getNarratorPresenceBatch,
} from "../websocket/narrator-ws";
import { fileReferenceRoutes } from "./narrator-file-references";
import { narratorWorkspaceContextRoutes } from "./narrator-workspace-context";

function parseNewCommand(message: string): { rawCommand: string; initialMessage: string } | null {
	const match = message.trim().match(/^\/new(?:\s+([\s\S]*))?$/);
	if (!match) return null;
	return { rawCommand: message.trim(), initialMessage: match[1]?.trim() ?? "" };
}

/** Parse message request supporting both JSON and multipart/form-data (with images and text files) */
export async function parseMessageRequest(
	c: {
		req: {
			header: (name: string) => string | undefined;
			formData: () => Promise<FormData>;
			json: () => Promise<unknown>;
		};
	},
	narratorId: string,
): Promise<{
	message: string;
	images: ImageRef[];
	textFiles: File[];
	priority?: boolean;
	interrupt?: boolean;
	queueMode?: import("@shared/buffer-queue-mode").BufferQueueMode;
	fileReferences?: FileReference[];
}> {
	const contentType = c.req.header("content-type") ?? "";
	if (contentType.includes("multipart/form-data")) {
		const formData = await c.req.formData();
		const rawMode = formData.get("queueMode");
		const modeResult = bufferQueueModeSchema.optional().safeParse(rawMode ?? undefined);
		if (!modeResult.success) throw new ValidationError(modeResult.error.message);
		const rawMessage = formData.get("message");
		const message = typeof rawMessage === "string" ? rawMessage : "";
		const fileReferences = parseFileReferenceInput(formData.get("fileReferences"));
		const imageFiles = formData.getAll("images") as File[];
		if (imageFiles.length > MAX_EDIT_IMAGES_PER_MESSAGE) {
			throw new ValidationError(`Maximum ${MAX_EDIT_IMAGES_PER_MESSAGE} images per message`);
		}
		const textFileEntries = formData.getAll("textFiles") as File[];
		if (textFileEntries.length > MAX_EDIT_TEXT_FILES_PER_MESSAGE) {
			throw new ValidationError(
				`Maximum ${MAX_EDIT_TEXT_FILES_PER_MESSAGE} text files per message`,
			);
		}
		// An attachment carries the turn on its own: images (and text files, whose
		// paths are injected as an <attached_files> hint) are meaningful content even
		// when the user typed nothing. Only a fully empty request is rejected.
		if (
			!message.trim() &&
			imageFiles.length === 0 &&
			textFileEntries.length === 0 &&
			!fileReferences?.length
		) {
			throw new ValidationError("message or an attachment is required");
		}
		// Validate everything before any disk write so a rejected attachment cannot
		// leave already-saved images orphaned on disk.
		for (const file of textFileEntries) {
			validateTextFile(file);
		}
		for (const file of imageFiles) {
			validateUploadedImage(file);
		}
		const images: ImageRef[] = [];
		try {
			for (const file of imageFiles) {
				images.push(await saveUploadedImage(narratorId, file));
			}
		} catch (error) {
			// Validation above catches the common rejections, but a write can still fail
			// mid-batch (permissions, ENOSPC, a decode error). The request is aborted, so
			// the images already on disk have no message referencing them.
			for (const image of images) {
				try {
					deleteUploadedImage(narratorId, image.imageId);
				} catch {
					// Best-effort: the original failure is what the caller needs to see.
				}
			}
			throw error;
		}
		const priority = formData.get("priority") === "true";
		return {
			message,
			images,
			textFiles: textFileEntries,
			priority: priority || undefined,
			interrupt: formData.get("interrupt") === "true" || undefined,
			queueMode: modeResult.data,
			fileReferences,
		};
	}
	const body = await c.req.json();
	const parsed = sendMessageSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return {
		message: parsed.data.message,
		images: [],
		textFiles: [],
		priority: parsed.data.priority,
		interrupt: parsed.data.interrupt,
		queueMode: parsed.data.queueMode,
		fileReferences: parsed.data.fileReferences,
	};
}

export const narratorRoutes = new Hono();

/**
 * The narrator HTTP surface still depends on the SQLite-shaped narrator domain, session, ACL, and
 * event-handler services. Reject PostgreSQL requests before body parsing, access checks, uploads,
 * or session admission until a complete narrator read/session port exists.
 */
export function requireSqliteNarratorSurface(backend: string = activeDatabaseBackend): void {
	if (backend === "postgres") {
		throw new AppError(
			"Narrator HTTP API is not yet supported on the PostgreSQL backend",
			503,
			"POSTGRES_UNSUPPORTED",
		);
	}
}

narratorRoutes.use("*", async (_c, next) => {
	requireSqliteNarratorSurface();
	return next();
});

// This smaller guard MUST run before the general attachment-body middleware below.
// Preview inputs contain only bounded selectors, never tool bodies or raw evidence.
const boundedRevertRequest = bodyLimit({
	maxSize: FILE_CHANGE_LIMITS.summaryBytes,
	onError: (c) =>
		c.json(
			{
				error: "Preview request exceeds the selector byte limit",
				code: "REVERT_PREVIEW_REQUEST_TOO_LARGE",
			},
			413,
		),
});
narratorRoutes.use("/:id/revert-plans", boundedRevertRequest);
narratorRoutes.use("/:id/revert-action-preview", boundedRevertRequest);
narratorRoutes.use("/:id/revert-plans/:planId/apply", boundedRevertRequest);

const boundedQuestionRequest = bodyLimit({
	maxSize: 128 * 1024,
	onError: (c) =>
		c.json(
			{ error: "Question request exceeds the byte limit", code: "QUESTION_REQUEST_TOO_LARGE" },
			413,
		),
});
narratorRoutes.use("/:id/questions/:questionId/answer", boundedQuestionRequest);
narratorRoutes.use("/:id/questions/:questionId/supplement", boundedQuestionRequest);

narratorRoutes.use(
	"*",
	bodyLimit({
		maxSize: MAX_NARRATOR_ATTACHMENT_BYTES,
		onError: (c) =>
			c.json(
				{
					error: "Narrator request exceeds the 128 MiB limit",
					code: "NARRATOR_REQUEST_TOO_LARGE",
				},
				413,
			),
	}),
);

/**
 * Access gate for every `/:id/...` route in this router.
 *
 * Deliberately a middleware rather than a call inside each handler. This file has
 * ~150 endpoints and 69 separate `getById` sites; auditing them one by one would
 * make "the author forgot" the default failure mode, and each new endpoint would
 * silently start out unprotected. One gate means a route is protected by virtue of
 * existing here.
 *
 * A GET is treated as read and every mutating method as write. That is the right
 * default for this surface: the mutating routes send messages, decide permission
 * requests, roll back history and change models — all of which really are "driving
 * the session". A handful of routes need a different rule and are listed below.
 *
 * Literal path segments that could be mistaken for an id (`/named`,
 * `/permissions/...`, `/whitelist-dirs/...`) are matched by more specific routes
 * registered separately, so they never reach a `/:id/...` pattern; the guard
 * below skips them explicitly for the ones that share the shape.
 */
const NARRATOR_ID_GATE_EXEMPT_SEGMENTS = new Set([
	// Collection-level routes whose first segment is not a narrator id.
	"named",
	"by-handle",
	"broken-models",
	"setup-assistant",
	"permissions",
	// The GLOBAL question inbox (`/questions/all`). Exempt because it spans narrators,
	// so there is no single id to authorize against; the service filters each row by
	// its own narrator's ACL instead. Note the per-narrator inbox lives at
	// `/:id/questions` and is still gated normally — only this literal first segment
	// is skipped.
	"questions",
	// Every inbox row/detail is authorized against its actual owner by the service.
	"human-attention",
	"whitelist-dirs",
	"blacklist-dirs",
	"cmd-whitelist",
	"cmd-blacklist",
]);

/**
 * Sub-paths that mutate but must stay reachable with read access only.
 *
 * `leave` just clears the "interrupted" badge when someone closes the tab, and a
 * read-only viewer legitimately triggers it. Denying it would leave the badge
 * stuck for everyone else.
 *
 * Matched against the WHOLE sub-path after the narrator id, not its last segment.
 * A last-segment test grants the exemption to anything that happens to end in the
 * same word — a future `/:id/rooms/:roomId/leave` would silently inherit a
 * downgrade nobody chose, and the resulting hole looks exactly like correct code.
 */
// Resolving a target reads metadata only; it still requires this narrator's read ACL.
const READ_ONLY_WRITE_SUBPATHS = new Set(["leave", "file-references/resolve"]);

// Search traverses lazy inherited refs. Keep the refusal ahead of the general ACL/work admission
// middleware so PG never reaches the legacy SQLite lineage query first. The pretext tail page is
// a normal read; its service only calls the backfill helper for an older-window request.
for (const subPath of ["search"]) {
	narratorRoutes.use(`/:id/${subPath}`, async (_c, next) => {
		requireSqliteLazyRefsBackfill(`Narrator ${subPath} fallback`);
		return next();
	});
}
narratorRoutes.use("/:id/pretext-document", async (c, next) => {
	if (c.req.query("beforeSeq") !== undefined)
		requireSqliteLazyRefsBackfill("Narrator pretext older-window fallback");
	return next();
});

/** The path after `/api/narrators/:id/`, or "" when there is none. */
function narratorSubPath(requestPath: string, id: string): string {
	const marker = `/${encodeURIComponent(id)}/`;
	const at = requestPath.indexOf(marker);
	if (at === -1) {
		// The id may arrive unencoded; nanoid ids never need escaping, so this is the
		// ordinary case rather than a fallback.
		const plain = requestPath.indexOf(`/${id}/`);
		if (plain === -1) return "";
		return requestPath.slice(plain + id.length + 2);
	}
	return requestPath.slice(at + marker.length);
}

narratorRoutes.use("/:id/*", async (c, next) => {
	const id = c.req.param("id");
	if (!id || NARRATOR_ID_GATE_EXEMPT_SEGMENTS.has(id)) return next();
	const subPath = narratorSubPath(c.req.path, id);
	const need =
		c.req.method === "GET" || READ_ONLY_WRITE_SUBPATHS.has(subPath)
			? ("read" as const)
			: ("write" as const);
	await requireNarratorAccess(c, id, need);
	// Legacy rollback cannot reinterpret historical trees under a new cwd. Scoped plans
	// instead bind recorded file identities and recheck the current write boundary on
	// preview and apply, so a prior workspace switch alone must not disable them.
	// Mixed history/file handlers below check only after parsing skipRevert; their
	// history-only branch (and retry) must never depend on file restoration support.
	const scopedRevert =
		subPath === "revert-action-preview" ||
		subPath === "revert-plans" ||
		/^revert-plans\/[^/]+\/apply$/.test(subPath);
	if (
		need === "write" &&
		!scopedRevert &&
		/^(?:revert(?:$|[-/])|unrevert$|resume(?:$|\/))/.test(subPath)
	)
		await assertWorkspaceHistoryRevertSupported(id);
	// Apply owns its exclusive admission through whenSettled; wrapping it in shared
	// work would deadlock it. Preview remains a shared read/selection operation and
	// must not interrupt an active narrator before confirmation.
	if (need === "write" && !/^revert-plans\/[^/]+\/apply$/.test(subPath))
		return withNarratorWorkAdmission(id, next);
	return next();
});

// The bare `/:id` routes are not covered by the `/:id/*` pattern above.
narratorRoutes.use("/:id", async (c, next) => {
	const id = c.req.param("id");
	if (!id || NARRATOR_ID_GATE_EXEMPT_SEGMENTS.has(id)) return next();
	await requireNarratorAccess(c, id, c.req.method === "GET" ? "read" : "write");
	return c.req.method === "GET" ? next() : withNarratorWorkAdmission(id, next);
});

narratorRoutes.route("/:id/file-references", fileReferenceRoutes);

// The /:id/* middleware above enforces requireNarratorAccess(..., "read").
narratorRoutes.get("/:id/context-composition", async (c) => {
	return c.json(
		await getNarratorContextComposition(c.req.param("id"), c.req.raw.signal, c.req.query("cursor")),
	);
});

/**
 * Gate for the routes keyed by a permission request id.
 *
 * Approving a tool call is the single most consequential action on this surface —
 * it is what lets an agent write files or run commands — and the path carries no
 * narrator id, so the gates above cannot see these routes at all. The owning
 * narrator is resolved through `resolveDecisionNarratorId`, which knows every
 * decision registry (permission, danger/plan/task/question reflection) plus the
 * tool-call-row fallback, and write access is required.
 */
narratorRoutes.use("/permissions/:requestId/*", async (c, next) => {
	const requestId = c.req.param("requestId");
	if (!requestId) return next();
	await requireOwningNarratorAccess(c, () => resolveDecisionNarratorId(requestId), "write");
	return next();
});

/**
 * Gate for the per-entry allow/deny-list routes (`/whitelist-dirs/:dirId` and
 * friends). Editing what a narrator may touch without confirmation is a change to
 * its authority, so it needs write access on the owning narrator.
 */
for (const segment of [
	"whitelist-dirs",
	"blacklist-dirs",
	"cmd-whitelist",
	"cmd-blacklist",
] as const) {
	narratorRoutes.use(`/${segment}/:entryId`, async (c, next) => {
		const entryId = c.req.param("entryId");
		if (!entryId) return next();
		await requireOwningNarratorAccess(c, () => resolveRuleNarratorId(segment, entryId), "write");
		return next();
	});
}

/** The narrator owning one allow/deny-list entry. */
async function resolveRuleNarratorId(
	segment: "whitelist-dirs" | "blacklist-dirs" | "cmd-whitelist" | "cmd-blacklist",
	entryId: string,
): Promise<string | null> {
	switch (segment) {
		case "whitelist-dirs": {
			const row = await db.query.narratorWhitelistDirs.findFirst({
				where: eq(narratorWhitelistDirs.id, entryId),
				columns: { narratorId: true },
			});
			return row?.narratorId ?? null;
		}
		case "blacklist-dirs": {
			const row = await db.query.narratorBlacklistDirs.findFirst({
				where: eq(narratorBlacklistDirs.id, entryId),
				columns: { narratorId: true },
			});
			return row?.narratorId ?? null;
		}
		case "cmd-whitelist": {
			const row = await db.query.narratorWhitelistCmds.findFirst({
				where: eq(narratorWhitelistCmds.id, entryId),
				columns: { narratorId: true },
			});
			return row?.narratorId ?? null;
		}
		case "cmd-blacklist": {
			const row = await db.query.narratorBlacklistCmds.findFirst({
				where: eq(narratorBlacklistCmds.id, entryId),
				columns: { narratorId: true },
			});
			return row?.narratorId ?? null;
		}
	}
}

function parseBooleanOverride(value: unknown, field: string): BooleanOverride {
	if (typeof value === "string" && BOOLEAN_OVERRIDE_VALUES.includes(value as BooleanOverride)) {
		return value as BooleanOverride;
	}
	throw new ValidationError(`${field} must be one of: ${BOOLEAN_OVERRIDE_VALUES.join(", ")}`);
}

function parseDangerReflectionOverride(value: unknown, field: string): DangerReflectionOverride {
	if (
		typeof value === "string" &&
		DANGER_REFLECTION_OVERRIDE_VALUES.includes(value as DangerReflectionOverride)
	) {
		return value as DangerReflectionOverride;
	}
	throw new ValidationError(
		`${field} must be one of: ${DANGER_REFLECTION_OVERRIDE_VALUES.join(", ")}`,
	);
}

function parseAutoContinuationOverride(value: unknown, field: string): AutoContinuationOverride {
	if (
		typeof value === "string" &&
		AUTO_CONTINUATION_OVERRIDE_VALUES.includes(value as AutoContinuationOverride)
	) {
		return value as AutoContinuationOverride;
	}
	throw new ValidationError(
		`${field} must be one of: ${AUTO_CONTINUATION_OVERRIDE_VALUES.join(", ")}`,
	);
}

function publicNarratorResponse<T extends { traits: unknown; substatus?: unknown }>(
	narrator: T,
	hasDraft = false,
) {
	return {
		...narrator,
		traits: redactInternalTraits(narrator.traits),
		hasDraft,
		substatus: parseSubstatus(narrator.substatus),
	};
}

/**
 * The trait array clients are allowed to see: semantic tags and encoded user settings,
 * with server-internal bookkeeping (draft bodies, recovery watermarks) stripped. See
 * NARRATOR_INTERNAL_TRAIT_PREFIXES for why those must not leak.
 */
function publicTraitsResponse(traits: unknown): string[] {
	return redactInternalTraits(traits);
}

// List narrators — by chapterId, or standalone (chapterId IS NULL)
narratorRoutes.get("/", async (c) => {
	const userId = c.get("user").sub;
	const chapterId = c.req.query("chapterId");
	const standalone = c.req.query("standalone");
	const projectId = c.req.query("projectId")?.trim();
	if (projectId !== undefined) {
		if (!projectId || projectId.length > 128) throw new ValidationError("Invalid projectId");
		await requireProjectAccess(c, projectId, "read");
	}

	if (standalone === "true" || standalone === "all" || projectId) {
		// Paginated session list
		// standalone=true: only standalone (chapterId IS NULL)
		// standalone=all: all sessions (standalone + chapter-bound)
		const status = c.req.query("status");
		const filter = c.req.query("filter"); // "standalone" | "chapter" | undefined (all)
		const rawSortBy = c.req.query("sortBy") ?? "updatedAt";
		const sortOrder = c.req.query("sortOrder") ?? "desc";
		const rawLimit = Number.parseInt(c.req.query("limit") ?? "20", 10);
		const limit = Math.min(Number.isNaN(rawLimit) ? 20 : rawLimit, 100);
		const cursorParam = c.req.query("cursor");

		// Presence-based filters
		const hasTerminals = c.req.query("hasTerminals") === "true";
		const hasContainers = c.req.query("hasContainers") === "true";
		const hasRunningContainers = c.req.query("hasRunningContainers") === "true";
		const hasViewers = c.req.query("hasViewers") === "true";

		// Build base where conditions.
		//
		// The visibility predicate is pushed into SQL rather than applied to the fetched
		// page: filtering afterwards would break `LIMIT limit + 1` as the "hasMore"
		// signal and make `totalCount` count narrators the caller cannot see. Returns
		// undefined for admins, which `and(...)` treats as no extra restriction.
		const conditions = [
			eq(narrators.variant, "primary"),
			narratorReadableWhere(narratorPrincipalOf(c)),
		];

		if (status === "archived") {
			conditions.push(eq(narrators.status, "archived"));
		} else if (status === "idle" || status === "working" || status === "waiting") {
			// Exact per-status filter (e.g. dashboard working/waiting counts and lists)
			conditions.push(eq(narrators.status, status));
		} else {
			conditions.push(ne(narrators.status, "archived"));
		}

		// Filter by standalone vs chapter-bound
		if (standalone === "true" || filter === "standalone") {
			conditions.push(isNull(narrators.chapterId));
		} else if (filter === "chapter") {
			conditions.push(isNotNull(narrators.chapterId));
		}
		// standalone=all with no filter: show all
		if (projectId) {
			conditions.push(
				or(
					and(isNull(narrators.chapterId), eq(narrators.contextProjectId, projectId)),
					exists(
						db
							.select({ id: chapters.id })
							.from(chapters)
							.where(and(eq(chapters.id, narrators.chapterId), eq(chapters.projectId, projectId))),
					),
				),
			);
		}

		// Filter: has active terminals
		if (hasTerminals) {
			conditions.push(
				sql`EXISTS (SELECT 1 FROM terminals WHERE terminals.narrator_id = ${narrators.id} AND terminals.status = 'running')`,
			);
		}

		// Filter: has containers (via chapter)
		if (hasContainers) {
			conditions.push(
				sql`EXISTS (SELECT 1 FROM container_instances WHERE container_instances.chapter_id = ${narrators.chapterId})`,
			);
		}

		// Filter: has running containers (via chapter)
		if (hasRunningContainers) {
			conditions.push(
				sql`EXISTS (SELECT 1 FROM container_instances WHERE container_instances.chapter_id = ${narrators.chapterId} AND container_instances.status = 'running')`,
			);
		}

		// Filter: has viewers (in-memory presence)
		if (hasViewers) {
			const viewedIds = getNarratorIdsWithPresence();
			if (viewedIds.size === 0) {
				// No narrators have viewers — return empty result
				return c.json({ items: [], hasMore: false, nextCursor: null, totalCount: 0 });
			}
			conditions.push(sql`${narrators.id} IN ${[...viewedIds]}`);
		}

		const baseWhere = and(...conditions);

		// messageCount sorts on the stored column, which is an insert-only upper bound
		// (see narrator-message-count.ts). Ordering is the one job that genuinely needs
		// a stored value: it must be applied before LIMIT, so it cannot use the exact
		// per-page counts computed after pagination. An approximate ordering with exact
		// displayed numbers is the right trade here — the alternative is a correlated
		// count(*) per candidate row, measured at 40ms per list request.
		const sortColumnMap: Record<string, Column> = {
			updatedAt: narrators.updatedAt,
			createdAt: narrators.createdAt,
			title: narrators.title,
			messageCount: narrators.messageCount,
		};
		const sortBy = rawSortBy in sortColumnMap ? rawSortBy : "updatedAt";
		const column = sortColumnMap[sortBy];
		const orderFn = sortOrder === "asc" ? asc : desc;
		const cmpFn = sortOrder === "asc" ? gt : lt;

		// Decode cursor: { v: sortValue, id: narratorId }
		let cursorWhere: ReturnType<typeof and> | undefined;
		if (cursorParam) {
			try {
				const decoded = JSON.parse(Buffer.from(cursorParam, "base64url").toString());
				const cursorVal = decoded.v;
				const cursorId = decoded.id;
				cursorWhere = or(
					cmpFn(column, cursorVal),
					and(eq(column, cursorVal), cmpFn(narrators.id, cursorId)),
				);
			} catch {
				// Invalid cursor — ignore, start from beginning
			}
		}

		const whereClause = cursorWhere ? and(baseWhere, cursorWhere) : baseWhere;

		const [list, countResult] = await Promise.all([
			db.query.narrators.findMany({
				where: whereClause,
				orderBy: [orderFn(column), orderFn(narrators.id)],
				limit: limit + 1,
			}),
			db.select({ count: sql<number>`count(*)` }).from(narrators).where(baseWhere),
		]);
		const totalCount = countResult[0]?.count ?? 0;

		const hasMore = list.length > limit;
		const rawItems = hasMore ? list.slice(0, limit) : list;
		const lastItem = rawItems[rawItems.length - 1];
		const nextCursor =
			hasMore && lastItem
				? Buffer.from(
						JSON.stringify({
							v: (lastItem as Record<string, unknown>)[sortBy] ?? lastItem.updatedAt,
							id: lastItem.id,
						}),
					).toString("base64url")
				: null;

		// Enrich items with chapter info, terminal counts, and viewers
		const narratorIds = rawItems.map((n) => n.id);
		const chapterIds = rawItems.map((n) => n.chapterId).filter(Boolean) as string[];

		// Batch fetch chapter info
		const chapterMap = new Map<
			string,
			{
				id: string;
				title: string;
				projectId: string;
				projectName: string | null;
				status: string;
				role: string;
			}
		>();
		if (chapterIds.length > 0) {
			const chapterRows = await db
				.select({
					id: chapters.id,
					title: chapters.title,
					projectId: chapters.projectId,
					projectName: projects.name,
					status: chapters.status,
					role: chapters.role,
				})
				.from(chapters)
				.leftJoin(projects, eq(chapters.projectId, projects.id))
				.where(sql`${chapters.id} IN ${chapterIds}`);
			for (const row of chapterRows) {
				chapterMap.set(row.id, row);
			}
		}

		// Batch fetch active terminal counts
		const terminalCounts = new Map<string, number>();
		if (narratorIds.length > 0) {
			const termRows = await db
				.select({
					narratorId: terminals.narratorId,
					count: countFn(),
				})
				.from(terminals)
				.where(and(sql`${terminals.narratorId} IN ${narratorIds}`, eq(terminals.status, "running")))
				.groupBy(terminals.narratorId);
			for (const row of termRows) {
				if (row.narratorId) terminalCounts.set(row.narratorId, row.count);
			}
		}

		// Batch fetch container counts per chapter (total + running)
		const containerCounts = new Map<string, { total: number; running: number }>();
		if (chapterIds.length > 0) {
			const containerRows = await db
				.select({
					chapterId: containerInstances.chapterId,
					total: countFn(),
					running: sql<number>`SUM(CASE WHEN ${containerInstances.status} = 'running' THEN 1 ELSE 0 END)`,
				})
				.from(containerInstances)
				.where(
					and(
						sql`${containerInstances.chapterId} IN ${chapterIds}`,
						isNull(containerInstances.worktreeResourceId),
					),
				)
				.groupBy(containerInstances.chapterId);
			for (const row of containerRows) {
				if (row.chapterId === null) continue;
				containerCounts.set(row.chapterId, {
					total: row.total,
					running: row.running ?? 0,
				});
			}
		}

		// Exact message counts for this page. The stored `message_count` column is
		// incremented per ref insert but never decremented (refs are removed from many
		// scattered call sites), so it is an upper bound — a rolled-back or compacted
		// conversation would keep reporting its high-water mark. Counting the page's
		// ids is one grouped, indexed query: 0.8ms for a typical page, 11ms for a
		// synthetic page of the 20 largest narrators in the database.
		const messageCounts = await countNarratorMessageRefsBatch(narratorIds);

		// Batch fetch presence and the current user's private draft markers
		const presenceMap = getNarratorPresenceBatch(narratorIds);
		const draftNarratorIds = await getNarratorIdsWithDraft(userId, narratorIds);

		const items = rawItems.map((n) => ({
			...publicNarratorResponse(n, draftNarratorIds.has(n.id)),
			messageCount: messageCounts.get(n.id) ?? 0,
			chapter: n.chapterId ? (chapterMap.get(n.chapterId) ?? null) : null,
			activeTerminalCount: terminalCounts.get(n.id) ?? 0,
			containerCount: n.chapterId ? (containerCounts.get(n.chapterId)?.total ?? 0) : 0,
			runningContainerCount: n.chapterId ? (containerCounts.get(n.chapterId)?.running ?? 0) : 0,
			viewers: presenceMap.get(n.id) ?? [],
		}));

		return c.json({ items, hasMore, nextCursor, totalCount });
	}

	if (!chapterId) throw new ValidationError("chapterId or standalone=true is required");
	// This branch does not paginate (a chapter holds a handful of narrators), so an
	// in-memory filter is safe here — unlike the paged branch above, where it would
	// corrupt hasMore/totalCount.
	const list = await filterReadableNarrators(
		await narratorService.listByChapter(chapterId),
		narratorPrincipalOf(c),
	);
	const narratorIds = list.map((narrator) => narrator.id);
	const draftNarratorIds = await getNarratorIdsWithDraft(userId, narratorIds);
	// Same reason as the paged branch: the stored column only ever grows.
	const messageCounts = await countNarratorMessageRefsBatch(narratorIds);
	return c.json(
		list.map((narrator) => ({
			...publicNarratorResponse(narrator, draftNarratorIds.has(narrator.id)),
			messageCount: messageCounts.get(narrator.id) ?? 0,
		})),
	);
});

/**
 * Bind the standalone-cwd decision to this process's real filesystem and settings.
 *
 * The decision itself lives in `standalone-narrator-cwd` so its branches (a `~` to
 * expand, a configured directory that cannot be created) are unit-testable without a
 * disk.
 */
function standaloneNarratorCwd(input: {
	cwd?: string;
	chapterId?: string | null;
}): string | undefined {
	return resolveStandaloneNarratorCwd(input, {
		home: getHome(),
		configuredDir: settings.paths.defaultProjectDir,
		ensureDir: (path) => {
			mkdirSync(path, { recursive: true });
		},
		toAbsolute: (path) => resolve(path),
		onEnsureFailed: (path, error) => {
			logger.warn("Failed to ensure default project dir exists for narrator cwd", {
				path,
				error: String(error),
			});
		},
	});
}

// Create narrator
narratorRoutes.post("/", async (c) => {
	const body = await c.req.json();
	const parsed = createNarratorSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	// fastMode is intentionally NOT resolved here: the narrator stores the
	// tri-state override and "inherit" is resolved against the user's
	// fastModeDefault on every turn, so changing that default also affects
	// narrators created before the change.
	const input = parsed.data;

	// For specialized kinds (e.g. knowledge steward), the service preinstalls tools and a
	// system prompt. Pass the creator's admin status (server-trusted, never from the body)
	// so admin-only tools like KnowledgeAdmin are only preinstalled for admins, plus the
	// locale for the default kind-specific prompt.
	// Ownership always comes from the authenticated session, never from the body:
	// a client must not be able to create a narrator on someone else's behalf.
	const ownerUserId = c.get("user").sub;
	const resolvedCwd = standaloneNarratorCwd(input);

	if (input.kind) {
		const user = c.get("user");
		const locale = await getUserLanguage(user.sub);
		const narrator = await narratorService.create({
			...input,
			cwd: resolvedCwd,
			ownerUserId,
			creatorIsAdmin: user.role === "admin",
			locale,
		});
		return c.json(publicNarratorResponse(narrator), 201);
	}

	const narrator = await narratorService.create({
		...input,
		cwd: resolvedCwd,
		ownerUserId,
	});
	return c.json(publicNarratorResponse(narrator), 201);
});

// Create a Setup Assistant narrator that installs the missing system dependencies.
//
// Rationale: a hard-coded install-command matrix cannot cover every distro,
// package manager and permission model, but an agent with Bash can probe the
// machine and adapt. Installing system software is an instance-wide operation,
// so this mirrors POST /api/dependencies/:name/install and stays admin-only.
//
// How much authority the narrator gets is the USER's call, never a default we
// pick for them: "default" keeps per-command approval cards, "full" grants
// bypassPermissions and pins strict danger reflection (a same-model review turn
// for classifier-flagged calls — not human review, and not a sandbox). A user who
// wants neither simply never calls this endpoint and installs the deps themselves.
//
// Registered before "/:id" so the literal path is not captured as an id.
narratorRoutes.post("/setup-assistant", requireAdmin, async (c) => {
	// Body is optional: an empty POST means "use the standard authorization".
	const rawBody = await c.req.json().catch(() => ({}));
	const parsed = createSetupAssistantSchema.safeParse(rawBody ?? {});
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { authorization } = parsed.data;

	const check = dependencyService.checkAll();
	const missing = selectActionableDependencies(check.dependencies);
	if (missing.length === 0) {
		// Nothing installable is missing (everything present, or only
		// platform-unsupported optionals remain) — don't spawn a narrator with no job.
		return c.json({ created: false, dependencies: check });
	}

	const user = c.get("user");
	const locale = await getUserLanguage(user.sub);
	const replyInUserLanguage = await getUserReplyInLanguage(user.sub);
	const briefing = formatDependencyBriefing(check);
	const { permissionMode, dangerReflectionOverride } = resolveSetupAuthorization(authorization);

	const narrator = await narratorService.create({
		kind: "setup",
		locale,
		creatorIsAdmin: user.role === "admin",
		ownerUserId: user.sub,
		// Installing system dependencies is an instance-wide action and this route is
		// admin-only, so the session stays readable to the whole team: whoever picks up
		// the machine next needs to see what was installed and why.
		visibility: "public",
		systemPrompt: buildSetupAssistantSystemPrompt(locale, briefing, authorization),
		permissionMode,
		dangerReflectionOverride,
		// Dependency installation is machine-scoped, not project-scoped, so the
		// home directory is the only sensible cwd for a standalone narrator here.
		cwd: getHome(),
		title: getSetupAssistantTitle(
			locale,
			missing.map((dep) => dep.name),
		),
	});

	await sendMessage(
		narrator.id,
		getSetupAssistantStartMessage(
			locale,
			missing.map((dep) => dep.name),
		),
		[],
		locale,
		replyInUserLanguage,
		null,
		user.sub,
	);

	return c.json(
		{
			created: true,
			authorization,
			narrator: publicNarratorResponse(narrator),
			dependencies: check,
		},
		201,
	);
});

// Resolve a named narrator by its handle (case-insensitive). Used by @mention.
// Must be registered before "/:id" so "by-handle" is not captured as an id.
// Resolve a named narrator by @handle.
//
// Handles live in one global namespace, so a private named narrator still occupies
// its name and other people can type the mention — they just cannot open it. That
// is reported as "no such handle" rather than "not yours", so the handle namespace
// does not become a directory of other people's private sessions.
narratorRoutes.get("/by-handle/:handle", async (c) => {
	const handle = c.req.param("handle");
	const narrator = await narratorService.getByHandle(handle);
	if (!narrator) throw new NotFoundError("Named narrator", handle);
	await requireAccessToNarratorRow(c, narrator, "read").catch(() => {
		throw new NotFoundError("Named narrator", handle);
	});
	const hasDraft = await narratorHasDraft(c.get("user").sub, narrator.id);
	return c.json(publicNarratorResponse(narrator, hasDraft));
});

// List all named narrators (handle-based @mention targets).
narratorRoutes.get("/named", async (c) => {
	// Bounded set (named narrators are deliberately few), so filtering in memory is
	// fine here; the paginated list endpoint pushes the same predicate into SQL.
	const named = await filterReadableNarrators(
		await narratorService.listNamed(),
		narratorPrincipalOf(c),
	);
	const draftNarratorIds = await getNarratorIdsWithDraft(
		c.get("user").sub,
		named.map((narrator) => narrator.id),
	);
	return c.json(
		named.map((narrator) => publicNarratorResponse(narrator, draftNarratorIds.has(narrator.id))),
	);
});

// --- Broken model migration ---
// Registered before "/:id" so these literal paths are not swallowed by the param route.
// Admin-only: rewriting other users' narrator models is an instance-wide operation,
// matching the rule that only admins may change the instance summary model.

/**
 * The GLOBAL async-question inbox: every open question the caller may see.
 *
 * Collection-level rather than per-narrator, because the problem it solves is
 * cross-session: a user with several running narrators cannot be expected to open each
 * one to discover it is waiting on them. Per-row ACL filtering happens in the service —
 * a question is readable exactly when its narrator is.
 */
narratorRoutes.get("/questions/all", async (c) => {
	const items = await listAllOpenAsyncQuestionsForPrincipal(narratorPrincipalOf(c));
	return c.json({
		items,
		openCount: items.length,
		awaitedCount: items.filter((q) => q.awaited).length,
	});
});

narratorRoutes.get("/questions", async (c) => {
	const parsed = asyncQuestionListQuerySchema.safeParse(c.req.query());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	c.header("Cache-Control", "no-store");
	return c.json(
		await listQuestionSummaries({
			principal: narratorPrincipalOf(c),
			filter: parsed.data.filter ?? "pending",
			cursor: parsed.data.cursor,
			limit: parsed.data.limit,
		}),
	);
});

/** The unified inbox is a projection; all decisions keep their existing guarded endpoints. */
narratorRoutes.get("/human-attention", async (c) => {
	const parsed = humanAttentionListQuerySchema.safeParse(c.req.query());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	c.header("Cache-Control", "no-store");
	return c.json(
		await listHumanAttentionForPrincipal(narratorPrincipalOf(c), {
			...parsed.data,
			signal: c.req.raw.signal,
		}),
	);
});

narratorRoutes.get("/human-attention/:attentionId", async (c) => {
	c.header("Cache-Control", "no-store");
	return c.json(
		await getHumanAttentionForPrincipal(narratorPrincipalOf(c), c.req.param("attentionId"), {
			signal: c.req.raw.signal,
		}),
	);
});

narratorRoutes.get("/broken-models", requireAdmin, async (c) => {
	const includeArchived = c.req.query("includeArchived") === "true";
	const scan = await scanBrokenModelNarrators({ includeArchived });
	return c.json({ ...scan, undoAvailable: hasBrokenModelMigrationUndo() });
});

narratorRoutes.post("/broken-models/migrate", requireAdmin, async (c) => {
	const parsed = migrateBrokenModelNarratorsSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await migrateBrokenModelNarrators(parsed.data));
});

narratorRoutes.post("/broken-models/undo", requireAdmin, async (c) => {
	return c.json(await undoLastBrokenModelMigration());
});

// Get narrator
narratorRoutes.get("/:id", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);
	const [hasDraft, gitSummary] = await Promise.all([
		narratorHasDraft(c.get("user").sub, id),
		getNarratorGitSummary(id, narrator.workspaceRevision, narratorPrincipalOf(c), c.req.raw.signal),
	]);
	const runtimeModel = getNarratorRuntimeModel(id, narrator.model?.trim() || FOLLOW_DEFAULT_MODEL);
	// The stored counter is only refreshed when a turn ends, so a narrator that has
	// not run since the turn-count → message-count change would still report the old
	// value here. One narrator's refs are cheap to count exactly (an indexed count(*)),
	// unlike the list endpoint where it would mean one subquery per row.
	const messageCount = await countNarratorMessageRefs(id);
	// Policy decision only (no routing, so balanced aggregations do not advance).
	// A resolution failure just leaves the plain "follow parent" label.
	const modelInheritance =
		narrator.model === FOLLOW_PARENT_MODEL
			? await resolveSubagentModelInheritance(narrator, c.get("user").sub)
					.then((result) => result.inheritance)
					.catch(() => undefined)
			: undefined;
	return c.json({
		...publicNarratorResponse(narrator, hasDraft),
		gitSummary,
		messageCount,
		...(modelInheritance && { modelInheritance }),
		...(runtimeModel && {
			runtimeModel: {
				provider: runtimeModel.provider,
				model: runtimeModel.model,
				resolvedAt: runtimeModel.resolvedAt,
			},
		}),
	});
});

// Download the raw SSE request/response dump for a leaked-tool-call diagnostic.
// Narrator-scoped so non-admin users participating in debugging can fetch the data,
// with an ownership check preventing access to other narrators' requests.
narratorRoutes.get("/:id/leaked-tool-dump/:requestId", async (c) => {
	const id = c.req.param("id");
	const requestId = c.req.param("requestId");
	await narratorService.getById(id); // 404 if narrator missing

	const [row] = await db
		.select({
			id: apiRequests.id,
			narratorId: apiRequests.narratorId,
			provider: apiRequests.provider,
			model: apiRequests.model,
			createdAt: apiRequests.createdAt,
			errorMessage: apiRequests.errorMessage,
			rawDumpJson: apiRequests.rawDumpJson,
		})
		.from(apiRequests)
		.where(eq(apiRequests.id, requestId));

	if (!row || row.narratorId !== id) {
		// Treat a mismatched owner the same as missing to avoid leaking existence.
		return c.json({ error: "Request dump not found for this narrator" }, 404);
	}
	if (!row.rawDumpJson) {
		return c.json(
			{
				error:
					"No raw dump stored for this request. Raw SSE data is only retained when a leak is detected or request dumping is enabled.",
			},
			404,
		);
	}

	let rawDump: unknown;
	try {
		// Same redaction as the usage-history detail path: the stored dump carries absolute
		// server paths (spill pointer / malformed capture) that name the host OS account, and a
		// dump is something users export and forward to whoever is helping them. This route
		// used to return the row verbatim, so it leaked what the other path was careful about.
		rawDump = redactSpillPointerPaths(JSON.parse(row.rawDumpJson));
	} catch {
		rawDump = { invalidJson: true, rawText: row.rawDumpJson };
	}

	return c.json({
		id: row.id,
		narratorId: row.narratorId,
		provider: row.provider,
		model: row.model,
		createdAt: row.createdAt,
		errorMessage: row.errorMessage,
		rawDump,
	});
});

narratorRoutes.get("/:id/draft", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	return c.json(await getNarratorDraft(c.get("user").sub, id));
});

narratorRoutes.put("/:id/draft", async (c) => {
	const id = c.req.param("id");
	const userId = c.get("user").sub;
	const body = await c.req.json().catch(() => ({}));
	const parsed = updateNarratorDraftSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const narrator = await narratorService.getById(id);
	const update = await updateNarratorDraft(
		userId,
		id,
		parsed.data.text,
		parsed.data.sourceId,
		parsed.data.baseRevision,
		parsed.data.fileReferences,
	);
	if ("conflict" in update) {
		return c.json(
			{
				error: "Draft changed on another client",
				code: "DRAFT_REVISION_CONFLICT",
				current: update.current,
			},
			409,
		);
	}

	broadcastToUser(userId, {
		type: "draft_changed",
		narratorId: id,
		hasDraft: update.hasDraft,
		text: update.text,
		fileReferences: update.fileReferences,
		revision: update.revision,
		updatedAt: update.updatedAt,
		updatedBy: update.updatedBy,
		sourceId: update.sourceId,
	});
	await syncNarratorDraftToRecentTabs(userId, id, {
		promote: !update.previousHasDraft && update.hasDraft,
	});
	return c.json({
		ok: true,
		traits: publicTraitsResponse(narrator.traits),
		hasDraft: update.hasDraft,
		text: update.text,
		fileReferences: update.fileReferences,
		revision: update.revision,
		updatedAt: update.updatedAt,
		updatedBy: update.updatedBy,
		sourceId: update.sourceId,
	});
});

// ─── Access control (sharing) ────────────────────────────────────────────────
//
// The `/:id/*` gate above already requires read for GET and write for mutations.
// The service layer additionally requires owner-or-admin, because a write grant
// means "you may work here", not "you may hand this to more people".

narratorRoutes.get("/:id/access", async (c) => {
	return c.json(await getNarratorAccess(c.req.param("id"), narratorPrincipalOf(c)));
});

narratorRoutes.patch("/:id/visibility", async (c) => {
	const parsed = narratorVisibilitySchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(
		await setNarratorVisibility(c.req.param("id"), parsed.data.visibility, narratorPrincipalOf(c)),
	);
});

narratorRoutes.patch("/:id/write-audience", async (c) => {
	const parsed = narratorWriteAudienceSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(
		await setNarratorWriteAudience(
			c.req.param("id"),
			parsed.data.writeAudience,
			narratorPrincipalOf(c),
		),
	);
});

narratorRoutes.post("/:id/grants", async (c) => {
	const parsed = narratorGrantCreateSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const id = c.req.param("id");
	const principal = narratorPrincipalOf(c);
	const outcome = await grantNarratorAccess(id, parsed.data.userIds, parsed.data.access, principal);
	// Returns the resulting state alongside the per-user outcome so the panel does not
	// need a second round trip, and so a partially successful batch is visible.
	return c.json({ ...outcome, access: await getNarratorAccess(id, principal) });
});

narratorRoutes.patch("/:id/grants/:grantId", async (c) => {
	const parsed = narratorGrantUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json({
		grants: await updateNarratorGrant(
			c.req.param("id"),
			c.req.param("grantId"),
			parsed.data.access,
			narratorPrincipalOf(c),
		),
	});
});

narratorRoutes.delete("/:id/grants/:grantId", async (c) => {
	await revokeNarratorGrant(c.req.param("id"), c.req.param("grantId"), narratorPrincipalOf(c));
	return c.json({ ok: true });
});

/**
 * POST /:id/optimize-prompt — Optimize user's prompt text using configured model
 */
narratorRoutes.post("/:id/optimize-prompt", async (c) => {
	const narratorId = c.req.param("id");
	const userId = c.get("user").sub;

	// ACL: narrator must exist and user must have access
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
	});
	if (!narrator) throw new NotFoundError("Narrator", narratorId);
	await requireAccessToNarratorRow(c, narrator, "read");

	// Parse and validate input
	const body = await c.req.json();
	const { text, style, withContext, messageId } = optimizePromptSchema.parse(body);

	// Get system instruction for the chosen style
	const locale = await getUserLanguage(userId);
	const systemInstruction = getPromptOptimizeInstruction(style as PromptOptimizeStyle, locale);

	// Load context if requested
	let contextText = "";
	if (withContext) {
		const { loadRecentMessages, formatMessagesAsContext, getMaxContextMessages } = await import(
			"../lib/prompts/prompt-optimize-context"
		);
		const maxMessages = getMaxContextMessages();
		const contextMessages = await loadRecentMessages(narratorId, messageId, maxMessages);
		contextText = formatMessagesAsContext(contextMessages);
	}

	// Tag the user's text to prevent prompt injection
	const taggedContent = contextText
		? `${contextText}\n\n---\n\n<prompt>\n${text}\n</prompt>`
		: `<prompt>\n${text}\n</prompt>`;

	// Resolve the model (default follows summaryModel via __summary__)
	const model = resolveEffectiveModel(settings.agent.promptOptimizeModel);

	// Follow the configured first-token budget; output clears the timer. Request
	// cancellation remains connected to the provider throughout generation.
	const generated = await generateWithFirstTokenTimeout(
		(options) =>
			summaryGenerate(
				taggedContent,
				systemInstruction,
				{ narratorId, kind: "optimize" },
				options.signal,
				options.onTextDelta,
				model,
				undefined,
				false,
				options.onReasoningDelta,
			),
		settings.agent.firstTokenTimeoutMs,
		c.req.raw.signal,
	).catch((err: unknown) => {
		if (err instanceof Error && err.name === "TimeoutError") {
			throw new ValidationError(err.message);
		}
		throw err;
	});
	let result = generated.text;

	// Post-process: trim, remove wrapping quotes/code fences
	result = result.trim();
	// Remove wrapping quotes
	if (
		(result.startsWith('"') && result.endsWith('"')) ||
		(result.startsWith("'") && result.endsWith("'"))
	) {
		result = result.slice(1, -1).trim();
	}
	// Remove code fences
	if (result.startsWith("```") && result.endsWith("```")) {
		const lines = result.split("\n");
		if (lines.length > 2) {
			result = lines.slice(1, -1).join("\n").trim();
		}
	}

	// Fallback to original if result is empty
	if (!result) {
		result = text;
	}

	return c.json({ text: result, model });
});

// Get usage stats for this narrator, optionally including direct subagents.
narratorRoutes.get("/:id/usage-stats", async (c) => {
	const narratorId = c.req.param("id");
	await narratorService.getById(narratorId);
	const includeSubagents = c.req.query("includeSubagents") !== "false";
	const stats = await usageHistoryService.getUsageStats({ narratorId, includeSubagents });
	return c.json(stats);
});

// Get available commands + skills for the slash menu
narratorRoutes.get("/:id/commands", async (c) => {
	const id = c.req.param("id");
	const userId = c.get("user").sub;
	const result = await getSlashMenuItems(id, userId);
	return c.json(result);
});

// Get skills available to this narrator's current project/cwd context.
narratorRoutes.get("/:id/skills", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const refresh = c.req.query("refresh") === "true";
	const context = await skillService.resolveSkillContextForNarrator(id);
	const result = await skillService.loadSkillSummariesForContext(context, {
		forceRefresh: refresh,
	});
	return c.json({
		skills: result.skills.filter((skill) => !skill.disabled),
		roots: result.roots,
		scopeKey: result.scopeKey,
	});
});

function customTraitsResponse(traits: unknown) {
	return buildCustomTraitsResponse(traits);
}

async function updateNarratorTraits(id: string, update: (traits: string[]) => string[]) {
	const traits = await narratorTraitsLock.acquire(id, async () => {
		const narrator = await narratorService.getById(id);
		const nextTraits = update(parseTraits(narrator.traits));
		await db
			.update(narrators)
			.set({ traits: nextTraits, updatedAt: new Date().toISOString() })
			.where(eq(narrators.id, id));
		return nextTraits;
	});
	// The in-memory session state must reflect the *resolved* traits, otherwise an
	// edit here would appear to relax a restriction that the project/user layer
	// enforces. The narrator's own row keeps only what was written above.
	const narratorRow = await narratorService.getById(id);
	const { resolveEffectiveTraits, resolveNarratorProjectId } = await import(
		"../services/trait-layer-service"
	);
	const effective = await resolveEffectiveTraits({
		narratorTraits: traits,
		projectId: await resolveNarratorProjectId(narratorRow),
		actingUserId: null,
	});
	updateActiveDisabledTools(id, getDisabledToolSet(effective.traits));
	const blocked = getBlockedSkills(effective.traits);
	updateActiveBlockedSkills(id, { all: blocked.all, names: blocked.names });
	broadcastToNarrator(id, {
		type: "custom_traits_changed",
		narratorId: id,
		traits: publicTraitsResponse(traits),
		customTraits: customTraitsResponse(traits),
	});
	return traits;
}

narratorRoutes.get("/:id/custom-traits", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);
	return c.json(customTraitsResponse(narrator.traits));
});

narratorRoutes.put("/:id/custom-traits/subagent-model-restriction", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json().catch(() => ({}));
	validateSubagentModelRestrictionInput(body);
	const restriction = normalizeSubagentModelRestriction(body);
	const traits = await updateNarratorTraits(id, (currentTraits) =>
		Object.keys(restriction.pools).length === 0
			? removeEncodedTrait(currentTraits, SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX)
			: upsertEncodedTrait(currentTraits, SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX, restriction),
	);
	return c.json({
		ok: true,
		traits: publicTraitsResponse(traits),
		customTraits: customTraitsResponse(traits),
	});
});

// === Narrator avatar ===
//
// A custom bitmap overrides the procedural identicon (which is derived from the
// narrator id and needs no storage). Reuses the user-avatar pipeline: the narrator
// id is the directory key, one file per narrator, replaced on each upload.

narratorRoutes.patch("/:id/avatar", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);
	if (!narrator) throw new NotFoundError("Narrator", id);

	const formData = await c.req.formData();
	const file = formData.get("file");
	if (!file || !(file instanceof File)) {
		throw new ValidationError("No file provided");
	}

	const { imageId } = await saveAvatarImage(id, file);
	await db
		.update(narrators)
		.set({ avatarImageId: imageId, updatedAt: new Date().toISOString() })
		.where(eq(narrators.id, id));

	return c.json({ ok: true, avatarImageId: imageId });
});

narratorRoutes.delete("/:id/avatar", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);
	if (!narrator) throw new NotFoundError("Narrator", id);

	deleteAvatarImage(id);
	await db
		.update(narrators)
		.set({ avatarImageId: null, updatedAt: new Date().toISOString() })
		.where(eq(narrators.id, id));
	return c.json({ ok: true });
});

narratorRoutes.delete("/:id/custom-traits/subagent-model-restriction", async (c) => {
	const id = c.req.param("id");
	const traits = await updateNarratorTraits(id, (currentTraits) =>
		removeEncodedTrait(currentTraits, SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX),
	);
	return c.json({
		ok: true,
		traits: publicTraitsResponse(traits),
		customTraits: customTraitsResponse(traits),
	});
});

narratorRoutes.put("/:id/custom-traits/disabled-tools", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json().catch(() => ({}));
	const disabledTools = normalizeDisabledTools(body);
	const traits = await updateNarratorTraits(id, (currentTraits) =>
		upsertEncodedTrait(currentTraits, DISABLED_TOOLS_TRAIT_PREFIX, disabledTools),
	);
	return c.json({
		ok: true,
		traits: publicTraitsResponse(traits),
		customTraits: customTraitsResponse(traits),
	});
});

narratorRoutes.delete("/:id/custom-traits/disabled-tools", async (c) => {
	const id = c.req.param("id");
	const traits = await updateNarratorTraits(id, (currentTraits) =>
		removeEncodedTrait(currentTraits, DISABLED_TOOLS_TRAIT_PREFIX),
	);
	return c.json({
		ok: true,
		traits: publicTraitsResponse(traits),
		customTraits: customTraitsResponse(traits),
	});
});

narratorRoutes.put("/:id/custom-traits/blocked-skills", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json().catch(() => ({}));
	const blockedSkills = normalizeBlockedSkills(body);
	const traits = await updateNarratorTraits(id, (currentTraits) =>
		!blockedSkills.all && blockedSkills.names.length === 0
			? removeEncodedTrait(currentTraits, BLOCKED_SKILLS_TRAIT_PREFIX)
			: upsertEncodedTrait(currentTraits, BLOCKED_SKILLS_TRAIT_PREFIX, blockedSkills),
	);
	return c.json({
		ok: true,
		traits: publicTraitsResponse(traits),
		customTraits: customTraitsResponse(traits),
	});
});

narratorRoutes.delete("/:id/custom-traits/blocked-skills", async (c) => {
	const id = c.req.param("id");
	const traits = await updateNarratorTraits(id, (currentTraits) =>
		removeEncodedTrait(currentTraits, BLOCKED_SKILLS_TRAIT_PREFIX),
	);
	return c.json({
		ok: true,
		traits: publicTraitsResponse(traits),
		customTraits: customTraitsResponse(traits),
	});
});

// Send message — fire-and-forget; all streaming events delivered via WebSocket
narratorRoutes.post("/:id/messages", async (c) => {
	const id = c.req.param("id");
	let narrator = await narratorService.getById(id); // throws NotFoundError if missing

	// Auto-unarchive on interaction
	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const {
		message,
		images,
		textFiles,
		priority: requestedPriority,
		interrupt: requestedInterrupt,
		queueMode,
		fileReferences,
	} = await parseMessageRequest(c, id);
	// Explicit mode wins over legacy booleans; omission retains existing callers.
	const interrupt = queueMode ? queueMode === "interrupt" : requestedInterrupt;
	const priority = queueMode
		? queueMode !== "turn"
		: isSubagentVariant(narrator.variant)
			? requestedPriority
			: requestedPriority || interrupt;
	const userId = c.get("user").sub;
	// Only a successfully persisted message/queue owns these uploads. In particular,
	// a rejected reference must not strand images saved by multipart parsing.
	let uploadsAccepted = false;
	try {
		const queuedNewCommand = parseNewCommand(message);
		if (queuedNewCommand && fileReferences?.length) {
			throw new ValidationError(
				"File references are not supported by /new; send them in the new session",
			);
		}

		// Whether an idle-but-compacting narrator should QUEUE this message instead of
		// starting a turn right now. Evaluated up-front because two independent paths need
		// the same answer: the `/goal` fast path (which would otherwise mutate tasks.json
		// and start a Spec turn against the history being replaced) and the ordinary send
		// path. `priority` is the user's explicit cut-in and opts out.
		//
		// Subagents are excluded, and not for lack of care: their queue lives in a separate
		// map that only accepts input while a foreground runner is attached, and
		// `resumeBufferedMessagesIfIdle` declines for subagents by design. Queuing an idle
		// compacting subagent would therefore strand the message with no consumer, so that
		// window keeps the blocking wait below.
		const compactionQueueEligible = !priority && getQueueDuringCompaction();
		const queueBehindCompaction =
			compactionQueueEligible && !isSubagentVariant(narrator.variant) && isCompactInProgress(id);

		// Resolve slash commands
		let finalMessage = message;
		let commandText: string | null = queuedNewCommand?.rawCommand ?? null;
		// Set when a busy `/goal` falls through to the buffer path, so the buffered
		// response can prompt the UI to show a "queued protected task" toast.
		let specGoalQueued = false;
		let specGoalObjective = "";
		const cmdResult = queuedNewCommand
			? ({ resolved: false } as Awaited<ReturnType<typeof resolveCommand>>)
			: await resolveCommand(message, id, userId);
		if (
			fileReferences?.length &&
			cmdResult.resolved &&
			!("expandedPrompt" in cmdResult) &&
			!("loadSkill" in cmdResult)
		) {
			throw new ValidationError("File references require a model message, not a control command");
		}
		// Interrupting controls use the same durable admission as ordinary input: never
		// abort an owner until the replacement is safely queued. Non-interrupt controls
		// deliberately retain their existing live-session behavior.
		if (
			interrupt &&
			!isSubagentVariant(narrator.variant) &&
			cmdResult.resolved &&
			!("expandedPrompt" in cmdResult) &&
			!("loadSkill" in cmdResult) &&
			!("specGoal" in cmdResult)
		) {
			const result = await acceptUserMessage(id, message, {
				userId,
				commandText: message,
				locale: await getUserLanguage(userId),
				interrupt: true,
				queueMode,
				executionIntent: { controlCommand: true },
			});
			// Controls do not consume attachments; retain the direct path's cleanup.
			return c.json(result, result.buffered ? 202 : 201);
		}
		if (cmdResult.resolved && ("loadTool" in cmdResult || "loadToolNotFound" in cmdResult)) {
			const locale = await getUserLanguage(userId);
			const result = await handleLoadToolCommand(
				id,
				cmdResult as LoadToolResult | LoadToolNotFound,
				locale,
				userId,
			);
			return c.json(result, 200);
		}
		if (cmdResult.resolved && ("unloadTool" in cmdResult || "unloadToolNotFound" in cmdResult)) {
			const locale = await getUserLanguage(userId);
			const result = await handleUnloadToolCommand(
				id,
				cmdResult as UnloadToolResult | UnloadToolNotFound,
				locale,
			);
			return c.json(result, 200);
		}
		if (cmdResult.resolved && "blockSkill" in cmdResult) {
			const locale = await getUserLanguage(userId);
			const result = await handleBlockSkillCommand(id, cmdResult as BlockSkillResult, locale);
			return c.json(result, 200);
		}
		if (cmdResult.resolved && "blockAllSkills" in cmdResult) {
			const locale = await getUserLanguage(userId);
			const result = await handleBlockAllSkillsCommand(
				id,
				cmdResult as BlockAllSkillsResult,
				locale,
			);
			return c.json(result, 200);
		}
		if (cmdResult.resolved && "unblockSkill" in cmdResult) {
			const locale = await getUserLanguage(userId);
			const result = await handleUnblockSkillCommand(id, cmdResult as UnblockSkillResult, locale);
			return c.json(result, 200);
		}
		if (cmdResult.resolved && "unblockAllSkills" in cmdResult) {
			const locale = await getUserLanguage(userId);
			const result = await handleUnblockAllSkillsCommand(
				id,
				cmdResult as UnblockAllSkillsResult,
				locale,
			);
			return c.json(result, 200);
		}
		if (cmdResult.resolved && "loadSkill" in cmdResult) {
			const skillResult = await handleLoadSkillCommand(id, cmdResult as LoadSkillResult);
			if (!skillResult.found) {
				if (fileReferences?.length) {
					throw new ValidationError("Skill was not found; file references were not sent");
				}
				return c.json({ skillName: skillResult.skillName, loaded: false }, 200);
			}
			// Inject skill content into the message, preserving user input after the skill name
			const userInput = (cmdResult as LoadSkillResult).skillInput;
			finalMessage = `<command-name>${skillResult.skillName}</command-name>\n${skillResult.content}${userInput ? `\n\n${userInput}` : ""}`;
			commandText = cmdResult.rawCommand;
		}
		// Only the built-in /bash command should short-circuit here. Custom slash commands
		// with runBashFirst also carry bashCommand, but they must continue below so the
		// expanded prompt is sent after the pre-prompt Bash command completes.
		if (cmdResult.resolved && "bashCommand" in cmdResult && !("expandedPrompt" in cmdResult)) {
			const bashResult = await handleBashCommand(
				id,
				(cmdResult as BashCommandResult).bashCommand,
				cmdResult.rawCommand,
				userId,
			);
			return c.json(bashResult, 201);
		}
		// Handle /goal <objective> — add a protected task to spec://tasks.json and
		// immediately start its first Spec execution turn. When the narrator is busy,
		// queue the command and append/start it once the buffer consumer reaches it;
		// this avoids mutating tasks.json in the middle of the current turn.
		if (cmdResult.resolved && "specGoal" in cmdResult) {
			const { objective, rawCommand } = cmdResult as SpecGoalCommandResult;
			// A compacting narrator counts as busy here for the same reason a running one
			// does: appending the protected task now and starting its Spec turn would run
			// that turn against the history the compact is replacing.
			const goalNarratorBusy =
				narrator.status === "working" ||
				narrator.status === "waiting" ||
				isLoopRunning(id) ||
				queueBehindCompaction;
			if (!goalNarratorBusy) {
				// Idle: persist the typed /goal command as the canonical user message and
				// append the protected task immediately.
				const userMsg = await narratorService.persistUserMessage(
					id,
					rawCommand,
					[{ type: "text", text: rawCommand }],
					rawCommand,
					userId,
				);
				broadcastToNarrator(id, {
					type: "user_message",
					narratorId: id,
					message: {
						id: userMsg.id,
						narratorId: id,
						role: "user",
						contentJson: userMsg.contentJson,
						contentText: userMsg.contentText,
						commandText: rawCommand,
						createdAt: userMsg.createdAt,
						seq: userMsg.seq,
						children: [],
						creator: userMsg.creator ?? null,
					},
				});
				const { added, written } = await appendProtectedSpecTask(id, objective);
				if (added) {
					broadcastSpecChanged(
						id,
						{ uri: written.uri, path: written.path, revisionId: written.revisionId },
						"ui",
						"user",
					);
				}
				// Leave a durable, self-explanatory card in the conversation so the
				// effect of /goal is visible on scrollback, not only via a toast. This
				// display-only side effect must not turn an already-applied goal into a
				// failed command if message persistence is temporarily unavailable.
				await persistGoalAddedNotice(id, objective, added).catch((err) => {
					logger.warn("Failed to persist /goal confirmation notice", {
						narratorId: id,
						error: String(err),
					});
				});
				const locale = await getUserLanguage(userId);
				const replyInUserLanguage = await getUserReplyInLanguage(userId);
				const { started } = await startSpecContinuationIfPossible(
					id,
					locale,
					replyInUserLanguage,
					userId,
				);
				return c.json({ specGoal: true, added, objective, started }, 200);
			}
			// Busy: fall through to the shared buffer path. Carry the raw command so the
			// buffer consumer recognizes it as a /goal, appends the task, and starts its
			// Spec turn then. The flag lets the UI show a "queued" toast.
			finalMessage = rawCommand;
			commandText = rawCommand;
			specGoalQueued = true;
			specGoalObjective = objective;
		}
		let prePromptBashCommand: string | undefined;
		if (cmdResult.resolved && "expandedPrompt" in cmdResult) {
			finalMessage = cmdResult.expandedPrompt;
			commandText = cmdResult.rawCommand;
			prePromptBashCommand = cmdResult.bashCommand;
		}

		// Freeze once before deciding between direct delivery and either queue. The
		// service owns the read/time budget and reauthorizes the actual HTTP user.
		const snapshots = fileReferences?.length
			? await captureFileReferences(id, userId, fileReferences, c.req.raw.signal)
			: undefined;

		// Extract model override from resolved command (if any)
		const modelOverride =
			cmdResult.resolved && "command" in cmdResult ? cmdResult.command.modelOverride : undefined;

		// Busy = DB status says running OR a loop is actually running in memory. The
		// in-memory check is authoritative: it catches the case where the DB status
		// went stale to idle while the loop was still draining, which would otherwise
		// let this message start a second concurrent loop instead of being buffered.
		let narratorBusy =
			!isExecutionSuspended(id) &&
			(narrator.status === "working" || narrator.status === "waiting" || isLoopRunning(id));

		// An idle narrator whose context is being compacted takes the same queue path as a
		// busy one, so the turn runs against the summary that is about to replace its
		// history rather than racing it (a compact resets the upstream session). This is a
		// QUEUE, not a wait: the request returns 202 immediately and the message becomes a
		// cancellable, editable queued card. `drainQueuedMessagesAfterCompact` consumes it
		// when the compact settles — including on failure or cancel, so nothing is stranded.
		//
		// `priority` (already folded into `queueBehindCompaction`) is the user's explicit
		// "don't wait for the compact" cut-in: it keeps the pre-existing concurrent
		// behaviour where the compact runs on in the background and the new turn uses the
		// current history.
		if (queueBehindCompaction) narratorBusy = true;

		// A compacting SUBAGENT cannot use that queue (see `compactionQueueEligible`), so it
		// keeps the original blocking wait: still better than racing the summary, just
		// without the cancellable card.
		if (!narratorBusy && compactionQueueEligible && isCompactInProgress(id)) {
			await awaitCompactCompletion(id);
			narrator = await narratorService.getById(id);
			narratorBusy =
				!isExecutionSuspended(id) &&
				(narrator.status === "working" || narrator.status === "waiting" || isLoopRunning(id));
		}

		if (queuedNewCommand && !narratorBusy) {
			const currentCwd = narrator.cwd ?? undefined;
			const newModel =
				narrator.model === FOLLOW_PARENT_MODEL
					? (await resolveSubagentModelForRun(narrator, userId)).model
					: (narrator.model ?? undefined);
			const newNarrator = await narratorService.create({
				chapterId: null,
				model: newModel,
				systemPrompt: narrator.systemPrompt ?? undefined,
				permissionMode: narrator.permissionMode ?? undefined,
				reasoningEffort: narrator.reasoningEffort ?? undefined,
				fastModeOverride: normalizeBooleanOverride(narrator.fastModeOverride),
				relaxedPlan: narrator.relaxedPlan ?? undefined,
				planReflectionAutoApproveOverride: normalizeBooleanOverride(
					narrator.planReflectionAutoApproveOverride,
				),
				dangerReflectionOverride: normalizeDangerReflectionOverride(
					narrator.dangerReflectionOverride,
				),
				autoContinuationOverride: normalizeAutoContinuationOverride(
					narrator.autoContinuationOverride,
				),
				cwd: currentCwd,
				// `/new` spawns a session for the person who typed it, not for the source
				// narrator's owner — they may differ when working in a shared session.
				ownerUserId: userId,
			});
			const locale = await getUserLanguage(userId);
			const replyInUserLanguage = await getUserReplyInLanguage(userId);
			if (queuedNewCommand.initialMessage) {
				await sendMessage(
					newNarrator.id,
					queuedNewCommand.initialMessage,
					images,
					locale,
					replyInUserLanguage,
					undefined,
					userId,
					textFiles,
				);
				uploadsAccepted = true;
			}
			return c.json({ newNarrator: publicNarratorResponse(newNarrator) }, 201);
		}

		// Running narrator: buffer the message for the next configured safe boundary.
		if (narratorBusy) {
			if (isSubagentVariant(narrator.variant)) {
				if (queuedNewCommand) {
					throw new ValidationError("/new cannot be queued from a running subagent");
				}
				if (prePromptBashCommand) {
					throw new ValidationError(
						"runBashFirst commands are not yet supported while resuming a subagent",
					);
				}

				const { bufferSubagentUserMessage, isTakenOver } = await import(
					"../services/narrator-subagent"
				);
				const { getSubagentBufferedMessagesAsync } = await import("../services/subagent-executor");
				const takenOver = isTakenOver(id);
				const result = await bufferSubagentUserMessage(id, finalMessage, {
					images: images.length > 0 ? images : undefined,
					textFiles: textFiles.length > 0 ? textFiles : undefined,
					commandText,
					createdBy: userId,
					prePromptBashCommand,
					priority,
					queueMode,
					requestSoftStop: !takenOver,
					fileReferences: snapshots,
				});
				if (!result.ok) {
					if (result.full) throw new ValidationError("Message queue is full");
					throw new ValidationError("Subagent is not running in foreground");
				}
				uploadsAccepted = true;
				const messages = toBufferSummary(await getSubagentBufferedMessagesAsync(id));
				broadcastToNarrator(id, {
					type: "buffer_set",
					narratorId: id,
					messages,
				});
				return c.json({ buffered: true, bufferedAt: result.bufferedAt, id: result.id }, 202);
			}
		}

		const locale = await getUserLanguage(userId);
		const replyInUserLanguage = await getUserReplyInLanguage(userId);

		// Primary overrides belong to the accepted input, not the currently running turn.
		// Subagent resume keeps its existing idle-only contract.
		const applyModelOverride =
			!!modelOverride?.model && !narratorBusy && isSubagentVariant(narrator.variant);
		if (applyModelOverride && modelOverride?.model) {
			if (modelOverride.mode === "temporary") {
				// Persist the original model so it can be restored after the turn
				// (survives server restarts). Must be written before admission to
				// avoid a race with the agent loop's finally block.
				await setTemporaryModelRestore(id, narrator.model ?? "__default__");
			}
			// Switch model in DB before admission starts an idle turn.
			await narratorService.updateModel(id, modelOverride.model);
		}

		if (isSubagentVariant(narrator.variant)) {
			if (prePromptBashCommand) {
				throw new ValidationError(
					"runBashFirst commands are not yet supported while resuming a subagent",
				);
			}
			const resumed = await resumeSubagent({
				subagentId: id,
				intent: "follow_up",
				actor: "user",
				prompt: finalMessage,
				fileReferences: snapshots,
				images: images.length > 0 ? images : undefined,
				textFiles: textFiles.length > 0 ? textFiles : undefined,
				commandText,
				createdBy: userId,
				locale,
			});
			uploadsAccepted = true;
			if (modelOverride?.model) {
				updateNarratorModel(id, modelOverride.model);
			}
			return c.json(
				resumed.userMessage ? fileReferenceMessageForDisplay(resumed.userMessage) : { ok: true },
				201,
			);
		}

		const user = await db.query.users.findFirst({
			where: eq(users.id, userId),
			columns: { id: true, username: true, avatarColor: true, avatarImageId: true },
		});
		const creator: BufferCreator | null = user
			? {
					id: user.id,
					username: user.username,
					avatarColor: user.avatarColor,
					avatarImageId: user.avatarImageId,
				}
			: null;
		// The service atomically enqueues and claims this message, or leaves it queued
		// behind an existing owner/backlog. HTTP status observations never decide admission.
		const result = await acceptUserMessage(id, finalMessage, {
			images,
			locale,
			replyInUserLanguage,
			commandText,
			userId,
			creator,
			textFiles,
			preBashCommand: prePromptBashCommand,
			fileReferences: snapshots,
			priority,
			interrupt,
			queueMode,
			queueOnly: queueBehindCompaction,
			executionIntent: modelOverride?.model ? { modelOverride } : undefined,
		});
		uploadsAccepted = true;

		if (result.buffered) {
			return c.json(
				{
					buffered: true,
					bufferedAt: result.bufferedAt,
					id: result.id,
					...(specGoalQueued ? { specGoalQueued: true, objective: specGoalObjective } : {}),
				},
				202,
			);
		}
		return c.json(fileReferenceMessageForDisplay(result.userMsg), 201);
	} finally {
		if (!uploadsAccepted) {
			for (const image of images) {
				try {
					deleteUploadedImage(id, image.imageId);
				} catch (error) {
					logger.warn("Failed to clean rejected message upload", {
						narratorId: id,
						imageId: image.imageId,
						error: String(error),
					});
				}
			}
		}
	}
});

// Retry last user message — re-run agent loop without creating a new message
narratorRoutes.post("/:id/retry", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);

	if (
		isSubagentVariant(narrator.variant) &&
		(narrator.status === "working" || narrator.status === "waiting" || isLoopRunning(id))
	) {
		throw new ValidationError("Cannot retry on a running subagent");
	}

	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	if (isSubagentVariant(narrator.variant)) {
		await resumeSubagent({
			subagentId: id,
			intent: "retry_last_input",
			actor: "user",
			createdBy: userId,
			locale,
		});
		return c.json({ ok: true });
	}
	const replyInUserLanguage = await getUserReplyInLanguage(userId);

	const result = await retryLastMessage(id, locale, replyInUserLanguage, userId);
	return c.json(result);
});

// Continue the agent loop — resume from trailing tool_use without a new user message
narratorRoutes.post("/:id/continue", async (c) => {
	const id = c.req.param("id");
	const recoveryMessageId = c.req.query("recoveryMessageId");
	const narrator = await narratorService.getById(id);

	// Reconcile FIRST, then judge. This repairs a status that disagrees with the
	// runtime in either direction: a stale idle status is promoted back to working (so
	// the user regains the interrupt button), and a working/waiting status with no
	// runtime owner is dropped to idle (so this request is admitted instead of being
	// rejected forever by a row that outlived its writer).
	if (await reconcileRunningStatus(id)) {
		narrator.status = (await narratorService.getById(id)).status;
	}
	// Busy = DB status running OR a loop actually running in memory (authoritative,
	// catches a stale-idle DB status that would otherwise start a second loop).
	if (narrator.status === "working" || narrator.status === "waiting" || isLoopRunning(id)) {
		throw new ValidationError("Cannot continue while narrator is already running");
	}

	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const dismissRecoveryMessage = async () => {
		if (!recoveryMessageId) return;
		await narratorService.dismissCwdRecoveryMessage(id, recoveryMessageId);
		broadcastToNarrator(id, {
			type: "messages_deleted",
			narratorId: id,
			deletedMessageIds: [recoveryMessageId],
		});
	};
	if (isSubagentVariant(narrator.variant)) {
		await resumeSubagent({
			subagentId: id,
			intent: "continue_tool_results",
			actor: "user",
			createdBy: userId,
			locale,
		});
		await dismissRecoveryMessage();
		return c.json({ ok: true, deletedMessageIds: recoveryMessageId ? [recoveryMessageId] : [] });
	}
	const replyInUserLanguage = await getUserReplyInLanguage(userId);

	// Seamless subagent recovery: when the latest assistant turn still holds
	// unfinished Agent / Await work, re-drive it first. The recovery flow owns the
	// continuation from there (it calls continueNarrator itself once every tool
	// result is written back), so we must not continue twice.
	const recovery = await resumeIncompleteAgentWorkForContinue({
		narratorId: id,
		locale,
		replyInUserLanguage,
		userId,
	});
	if (recovery.recovering) {
		await dismissRecoveryMessage();
		return c.json({
			ok: true,
			recovering: recovery.items.length,
			deletedMessageIds: recoveryMessageId ? [recoveryMessageId] : [],
		});
	}

	const result = await continueNarrator(id, locale, replyInUserLanguage, userId);
	await dismissRecoveryMessage();
	return c.json({
		...result,
		deletedMessageIds: recoveryMessageId ? [recoveryMessageId] : [],
	});
});

// Resume error subagents listed on the recovery card inserted after a narrator error.
// mode "notify": restart them and inject a prompt so the model awaits them itself.
// mode "await":  restart them, then synthesize one assistant turn with N Await
//                tool calls, run them server-side, and continue ONCE.
narratorRoutes.post("/:id/subagent-recovery", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);
	if (isSubagentVariant(narrator.variant)) {
		throw new ValidationError("Subagent recovery is only available on a primary narrator");
	}
	// Reconcile FIRST, then judge. The recovery card is shown precisely when a turn
	// died, and a subagent's permission gate used to mirror `working` onto this
	// narrator afterwards — leaving a status with no runtime owner that rejected this
	// request forever. Reconciling before the check repairs such a zombie status and
	// admits the click, while a genuinely running narrator is still refused.
	if (await reconcileRunningStatus(id)) {
		narrator.status = (await narratorService.getById(id)).status;
	}
	if (narrator.status === "working" || narrator.status === "waiting" || isLoopRunning(id)) {
		throw new ValidationError("Cannot recover subagents while the narrator is already running");
	}

	const body = subagentRecoverySchema.parse(await c.req.json());
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const replyInUserLanguage = await getUserReplyInLanguage(userId);

	const { resumed, skipped } = await resumeRecoverySubagents({
		narratorId: id,
		subagentIds: body.subagentIds,
		locale,
		userId,
	});

	await markRecoveryCardResolved({
		narratorId: id,
		messageId: body.messageId,
		mode: body.mode,
		resumedAliases: resumed,
		retrySubagentIds: skipped.map((entry) => entry.id),
	});

	if (resumed.length === 0) {
		return c.json({ ok: true, mode: body.mode, resumed: 0, skipped });
	}

	if (body.mode === "await") {
		await startRecoveryAwaitBatch({
			narratorId: id,
			aliases: resumed,
			locale,
			replyInUserLanguage,
			userId,
		});
		return c.json({ ok: true, mode: "await", resumed: resumed.length, skipped });
	}

	// notify: a `sys` message would be skipped by getLastContinuableTopLevelMessage
	// (it only accepts user/assistant), so the prompt must enter history as a real
	// user turn. sendMessage starts the loop itself — no continueNarrator after it.
	// `origin: "system"` keeps the attribution honest despite the user role.
	const prompt = buildRecoveryNotifyPrompt(resumed.map((alias) => ({ alias })));
	await sendMessage(
		id,
		prompt,
		undefined,
		locale,
		replyInUserLanguage,
		null,
		userId,
		undefined,
		null,
		{ origin: "system", originLabel: formatOriginLabel("recovery") },
	);
	return c.json({ ok: true, mode: "notify", resumed: resumed.length, skipped });
});

// Allow and re-execute a denied tool call from the latest assistant turn.
// After an interrupt the in-memory pending-permission entry is gone, so this
// path resets the tool call row, executes it with a pre-granted permission,
// writes the fresh result back, and auto-continues the loop.
narratorRoutes.post("/:id/tool-calls/:toolUseId/allow-retry", async (c) => {
	const id = c.req.param("id");
	const toolUseId = c.req.param("toolUseId");
	const narrator = await narratorService.getById(id);

	// Reconcile FIRST, then judge: repair a stale idle status (so the user regains the
	// interrupt button) or a running status with no runtime owner (so a denied tool can
	// still be retried after the turn that owned it died).
	if (await reconcileRunningStatus(id)) {
		narrator.status = (await narratorService.getById(id)).status;
	}
	if (narrator.status === "working" || narrator.status === "waiting" || isLoopRunning(id)) {
		throw new ValidationError("Cannot re-execute a tool call while narrator is already running");
	}

	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const replyInUserLanguage = await getUserReplyInLanguage(userId);

	if (isSubagentVariant(narrator.variant)) {
		const resumed = await resumeSubagent({
			subagentId: id,
			intent: "retry_denied_tool",
			actor: "user",
			retryToolUseId: toolUseId,
			createdBy: userId,
			locale,
			replyInUserLanguage,
		});
		if (!resumed.started && resumed.retryDeniedReason) {
			const statusCode = resumed.retryDeniedReason === "not_found" ? 404 : 400;
			return c.json(
				{ error: "Cannot re-execute tool call", reason: resumed.retryDeniedReason },
				statusCode,
			);
		}
		return c.json({ ok: true });
	}

	const result = await reExecuteDeniedToolCall(id, toolUseId, locale, replyInUserLanguage, userId);
	if (!result.ok) {
		const statusCode = result.reason === "not_found" ? 404 : 400;
		return c.json({ error: "Cannot re-execute tool call", reason: result.reason }, statusCode);
	}
	return c.json({ ok: true });
});

// Rollback to a specific block — delete everything after it (no re-run)
narratorRoutes.post("/:id/rollback/:messageId", async (c) => {
	const id = c.req.param("id");
	const messageId = c.req.param("messageId");
	const { blockIndex, skipRevert, scope } = rollbackToBlockSchema.parse(await c.req.json());
	if (skipRevert !== true) await assertWorkspaceHistoryRevertSupported(id);

	const narrator = await narratorService.getById(id);

	// A rollback discards the turn it lands in, so a user asking for one has already
	// decided the running turn is unwanted: stop it for them instead of refusing and
	// making them press Stop first. A subagent is included — it used to be the one
	// case that refused outright, but "the work I am undoing is still running" is not
	// a reason to keep running it.
	await prepareHistoryRewrite(id);

	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const result = await rollbackToBlock(id, messageId, blockIndex, {
		skipRevert: skipRevert === true,
		...(scope ? { scope } : {}),
	});
	return c.json(result);
});

/** Read snapshots only from the message being edited, never from a different session. */
async function resolveEditedFileReferences(
	narratorId: string,
	messageId: string,
	requested: FileReference[] | undefined,
	userId: string,
	signal: AbortSignal,
): Promise<FileReferenceSnapshot[] | undefined> {
	if (requested === undefined) return undefined;
	const ref = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, narratorId),
			eq(narratorMessageRefs.messageId, messageId),
		),
		columns: { messageId: true },
	});
	if (!ref) throw new NotFoundError("Message", messageId);
	const message = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, ref.messageId),
		columns: { role: true, contentJson: true },
	});
	if (!message) throw new NotFoundError("Message", messageId);
	if (message.role !== "user") throw new ValidationError("Can only edit user messages");
	return replaceFileReferenceSnapshots(
		getFileReferenceSnapshots(message.contentJson),
		requested,
		(references) => captureFileReferences(narratorId, userId, references, signal),
	);
}

// Edit a user message and regenerate the response.
// Supports JSON (text-only / keep-image-subset) and multipart/form-data (when the
// user adds new images during editing).
narratorRoutes.post("/:id/edit-and-regenerate/:messageId", async (c) => {
	const id = c.req.param("id");
	const messageId = c.req.param("messageId");

	let content: string;
	let fileReferences: FileReference[] | undefined;
	// Whether the truncated messages' file changes are rolled back, and how wide.
	// Undefined => the legacy `rollback` field decides (see below), then default true.
	let skipRevert: boolean | undefined;
	let legacyRollback: boolean | undefined;
	let scope: RevertScope | undefined;
	// undefined => keep all existing images (legacy); array => keep only these ids.
	let keepImageIds: string[] | undefined;
	// undefined => keep all existing text files (legacy); array => keep only these paths.
	let keepTextFilePaths: string[] | undefined;
	// Editing uploads are only parsed/validated here. The service owns every file write.
	const newImages: File[] = [];
	const newTextFiles: File[] = [];

	const parseJsonStringArray = (raw: FormDataEntryValue | null, field: string): string[] => {
		if (typeof raw !== "string") return [];
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				return parsed.filter((v): v is string => typeof v === "string");
			}
		} catch {
			throw new ValidationError(`${field} must be a JSON array of strings`);
		}
		return [];
	};

	const contentType = c.req.header("content-type") ?? "";
	if (contentType.includes("multipart/form-data")) {
		const formData = await c.req.formData();
		content = (formData.get("content") as string) ?? "";
		fileReferences = parseFileReferenceInput(formData.get("fileReferences"));
		const rawSkipRevert = formData.get("skipRevert");
		if (typeof rawSkipRevert === "string") skipRevert = rawSkipRevert === "true";
		const rawRollback = formData.get("rollback");
		if (typeof rawRollback === "string") legacyRollback = rawRollback === "true";
		const rawScope = formData.get("scope");
		scope = revertScopeSchema.parse(typeof rawScope === "string" ? rawScope : undefined);
		if (typeof formData.get("keepImageIds") === "string") {
			keepImageIds = parseJsonStringArray(formData.get("keepImageIds"), "keepImageIds");
		}
		if (typeof formData.get("keepTextFilePaths") === "string") {
			keepTextFilePaths = parseJsonStringArray(
				formData.get("keepTextFilePaths"),
				"keepTextFilePaths",
			);
		}
		const imageFiles = formData.getAll("images") as File[];
		if (imageFiles.length > MAX_EDIT_IMAGES_PER_MESSAGE) {
			throw new ValidationError(`Maximum ${MAX_EDIT_IMAGES_PER_MESSAGE} images per message`);
		}
		for (const file of imageFiles) {
			validateUploadedImage(file);
			newImages.push(file);
		}
		const textFileEntries = formData.getAll("textFiles") as File[];
		if (textFileEntries.length > MAX_EDIT_TEXT_FILES_PER_MESSAGE) {
			throw new ValidationError(
				`Maximum ${MAX_EDIT_TEXT_FILES_PER_MESSAGE} text files per message`,
			);
		}
		for (const file of textFileEntries) {
			validateTextFile(file);
			newTextFiles.push(file);
		}
		const attachmentBytes = [...imageFiles, ...textFileEntries].reduce(
			(total, file) => total + file.size,
			0,
		);
		if (attachmentBytes > MAX_NARRATOR_ATTACHMENT_BYTES) {
			throw new ValidationError("Combined attachments exceed the 128 MiB limit");
		}
	} else {
		const body = editAndRegenerateJsonSchema.parse(await c.req.json());
		content = body.content ?? "";
		fileReferences = body.fileReferences;
		skipRevert = body.skipRevert;
		legacyRollback = body.rollback;
		scope = body.scope;
		keepImageIds = body.keepImageIds;
		keepTextFilePaths = body.keepTextFilePaths;
	}

	// `skipRevert` is authoritative. A client that only sends the legacy `rollback`
	// field gets that field's ORIGINAL meaning honoured — "revert files" — which is
	// what the old UI offered and the server then ignored. Neither present => revert,
	// preserving the behaviour every edit actually had.
	const revertFiles = skipRevert !== undefined ? !skipRevert : (legacyRollback ?? true);

	const narrator = await narratorService.getById(id);
	const userId = c.get("user").sub;
	// Invalid/new references must fail before interrupting or rewriting history.
	const snapshots = await resolveEditedFileReferences(
		id,
		messageId,
		fileReferences,
		userId,
		c.req.raw.signal,
	);

	// Editing a message truncates everything after it and regenerates, so the running
	// turn is exactly what the user is replacing. Interrupt it for them rather than
	// refusing and asking them to press Stop first.
	await prepareHistoryRewrite(id);

	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const locale = await getUserLanguage(userId);
	const replyInUserLanguage = await getUserReplyInLanguage(userId);

	if (isSubagentVariant(narrator.variant)) {
		// The revert choice has to be forwarded explicitly here. Editing a subagent
		// message runs through resumeSubagent rather than calling editAndRegenerate
		// directly, so a field left off this object is simply dropped — which is how
		// the old `rollback` flag came to be ignored in the first place.
		const resumed = await resumeSubagent({
			subagentId: id,
			intent: "regenerate_edited_message",
			actor: "user",
			editMessageId: messageId,
			editContent: content,
			editRevertFiles: revertFiles,
			...(scope ? { editRevertScope: scope } : {}),
			editKeepImageIds: keepImageIds,
			editNewImages: newImages.length > 0 ? newImages : undefined,
			editKeepTextFilePaths: keepTextFilePaths,
			editNewTextFiles: newTextFiles.length > 0 ? newTextFiles : undefined,
			editFileReferences: snapshots,
			createdBy: userId,
			locale,
			replyInUserLanguage,
		});
		return c.json({
			ok: resumed.started,
			...(resumed.revertWarnings?.length ? { warnings: resumed.revertWarnings } : {}),
		});
	}

	const result = await editAndRegenerate(id, messageId, content, locale, replyInUserLanguage, {
		fileReferences: snapshots,
		keepImageIds,
		newImages: newImages.length > 0 ? newImages : undefined,
		keepTextFilePaths,
		newTextFiles: newTextFiles.length > 0 ? newTextFiles : undefined,
		userId,
		revertFiles,
		...(scope ? { revertScope: scope } : {}),
	});
	// Editing acknowledges the rewrite; refreshed message bubbles arrive separately.
	// Do not expose internal message/snapshot fields if the service result grows.
	return c.json({
		ok: result.ok,
		...(result.warnings?.length ? { warnings: result.warnings } : {}),
	});
});

// Edit an assistant message's text without deleting later messages or regenerating.
// The edited text is persisted for display and subsequent history assembly, while
// edit metadata (editedAt/editedBy/originalContentJson) stays outside contentJson
// and is never sent to the AI provider.
narratorRoutes.post("/:id/edit-message/:messageId", async (c) => {
	const id = c.req.param("id");
	const messageId = c.req.param("messageId");
	const body = await c.req.json();
	const { content } = editAssistantMessageSchema.parse(body);

	const narrator = await narratorService.getById(id);

	if (
		isSubagentVariant(narrator.variant) &&
		(narrator.status === "working" || narrator.status === "waiting" || isLoopRunning(id))
	) {
		throw new ValidationError("Cannot edit on a running subagent");
	}

	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const userId = c.get("user").sub;
	const result = await editAssistantMessage(id, messageId, content, userId);
	return c.json({ ok: result.ok });
});

// Restore an edited assistant message back to its original text, clearing the
// edit metadata so the message looks like it was never edited.
narratorRoutes.post("/:id/restore-message/:messageId", async (c) => {
	const id = c.req.param("id");
	const messageId = c.req.param("messageId");

	const narrator = await narratorService.getById(id);

	if (
		isSubagentVariant(narrator.variant) &&
		(narrator.status === "working" || narrator.status === "waiting" || isLoopRunning(id))
	) {
		throw new ValidationError("Cannot restore on a running subagent");
	}

	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const result = await restoreAssistantMessage(id, messageId);
	return c.json({ ok: result.ok });
});

/** Primary and subagent user queues are projections of the same durable mailbox. */
async function resolveBufferQueue(narratorId: string) {
	return toBufferSummary(await getBufferedMessagesAsync(narratorId));
}

/** Broadcast the post-mutation buffer queue to every client on this narrator. */
async function broadcastBufferQueue(narratorId: string): Promise<void> {
	broadcastToNarrator(narratorId, {
		type: "buffer_set",
		narratorId,
		messages: await resolveBufferQueue(narratorId),
	});
}

// Get buffered message queue (for multi-device hydration on page load)
narratorRoutes.get("/:id/buffer", async (c) => {
	const id = c.req.param("id");
	return c.json(await resolveBufferQueue(id));
});

/** Actor policy is separate from the shared mailbox storage. */
interface LocatedBufferedMessage {
	message: BufferedMessage;
	fromSubagentQueue: boolean;
}

async function locateBufferedMessage(
	narratorId: string,
	messageId: string,
): Promise<LocatedBufferedMessage | null> {
	const message = (await getBufferedMessagesAsync(narratorId)).find((m) => m.id === messageId);
	if (!message) return null;
	const narrator = await narratorService.getById(narratorId);
	return { message, fromSubagentQueue: isSubagentVariant(narrator.variant) };
}

/**
 * The attachments a queue edit intends to keep, resolved against what the message
 * currently holds.
 *
 * `undefined` keep lists mean "keep everything" so a text-only client (including
 * the WS `update_buffer` path) never silently drops attachments.
 *
 * Text files are matched positionally with the filename as a consistency check.
 * A mismatch means the client is looking at a stale queue — the message may have
 * been edited from another device — so the edit is refused rather than guessing
 * which file the user meant to drop.
 */
function resolveKeptBufferAttachments(
	located: LocatedBufferedMessage,
	keepImageIds: string[] | undefined,
	keepTextFiles: Array<{ index: number; filename: string }> | undefined,
): { keptImages: ImageRef[]; keptTextFileIndexes: number[] } {
	const currentImages = located.message.images ?? [];
	const keptImages =
		keepImageIds === undefined
			? [...currentImages]
			: currentImages.filter((image) => keepImageIds.includes(image.imageId));

	const currentNames = bufferedTextFileNames(located);
	let keptTextFileIndexes: number[];
	if (keepTextFiles === undefined) {
		keptTextFileIndexes = currentNames.map((_, index) => index);
	} else {
		keptTextFileIndexes = [];
		for (const entry of keepTextFiles) {
			if (currentNames[entry.index] !== entry.filename) {
				throw new ValidationError(
					"Queued attachments changed since this edit started; reload and try again",
				);
			}
			keptTextFileIndexes.push(entry.index);
		}
	}
	return { keptImages, keptTextFileIndexes };
}

/**
 * Filenames of a queued message's text files, in the order the summary reports.
 *
 * Mirrors `toBufferSummary`: persisted metadata first (it is what the primary
 * queue's DB row carries), then the in-memory File objects a subagent queue holds.
 */
function bufferedTextFileNames(located: LocatedBufferedMessage): string[] {
	return (located.message._savedFiles ?? []).map((file) => file.filename);
}

/** Parse a form field that carries a JSON array of strings/objects. */
function parseJsonArrayField(raw: FormDataEntryValue | null, field: string): unknown[] | undefined {
	if (typeof raw !== "string") return undefined;
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) throw new Error("not an array");
		return parsed;
	} catch {
		throw new ValidationError(`${field} must be a JSON array`);
	}
}

/**
 * Edit a queued buffered message.
 *
 * JSON handles text-only edits and keep-subset edits; multipart is used when the
 * edit uploads new attachments. Files are only validated and written here — the
 * buffer service owns the queue mutation, and every file this request created is
 * removed again if that mutation does not land.
 */
narratorRoutes.patch("/:id/buffer/:mid", async (c) => {
	const id = c.req.param("id");
	const mid = c.req.param("mid");

	let rawText: string | undefined;
	let fileReferences: FileReference[] | undefined;
	let keepImageIds: string[] | undefined;
	let keepTextFiles: Array<{ index: number; filename: string }> | undefined;
	const newImageFiles: File[] = [];
	const newTextFiles: File[] = [];

	const contentType = c.req.header("content-type") ?? "";
	if (contentType.includes("multipart/form-data")) {
		const formData = await c.req.formData();
		const rawTextField = formData.get("text");
		if (typeof rawTextField === "string") rawText = rawTextField;
		const parsed = updateBufferedMessageSchema.safeParse({
			...(rawText !== undefined ? { text: rawText } : {}),
			fileReferences: parseFileReferenceInput(formData.get("fileReferences")),
			...(formData.has("keepImageIds")
				? { keepImageIds: parseJsonArrayField(formData.get("keepImageIds"), "keepImageIds") }
				: {}),
			...(formData.has("keepTextFiles")
				? { keepTextFiles: parseJsonArrayField(formData.get("keepTextFiles"), "keepTextFiles") }
				: {}),
		});
		if (!parsed.success) throw new ValidationError(parsed.error.message);
		keepImageIds = parsed.data.keepImageIds;
		keepTextFiles = parsed.data.keepTextFiles;
		fileReferences = parsed.data.fileReferences;

		for (const file of formData.getAll("images") as File[]) {
			validateUploadedImage(file);
			newImageFiles.push(file);
		}
		for (const file of formData.getAll("textFiles") as File[]) {
			validateTextFile(file);
			newTextFiles.push(file);
		}
		const uploadBytes = [...newImageFiles, ...newTextFiles].reduce(
			(total, file) => total + file.size,
			0,
		);
		if (uploadBytes > MAX_NARRATOR_ATTACHMENT_BYTES) {
			throw new ValidationError("Combined attachments exceed the 128 MiB limit");
		}
	} else {
		const parsed = updateBufferedMessageSchema.safeParse(await c.req.json());
		if (!parsed.success) throw new ValidationError(parsed.error.message);
		rawText = parsed.data.text;
		keepImageIds = parsed.data.keepImageIds;
		keepTextFiles = parsed.data.keepTextFiles;
		fileReferences = parsed.data.fileReferences;
	}

	const located = await locateBufferedMessage(id, mid);
	if (!located) throw new NotFoundError("Buffered message", mid);

	// Omitted text keeps the current wording, so a client that only manages
	// attachments does not have to echo the message body back.
	const text = (rawText ?? located.message.text).trim();
	const { keptImages, keptTextFileIndexes } = resolveKeptBufferAttachments(
		located,
		keepImageIds,
		keepTextFiles,
	);

	if (keptImages.length + newImageFiles.length > MAX_EDIT_IMAGES_PER_MESSAGE) {
		throw new ValidationError(`Maximum ${MAX_EDIT_IMAGES_PER_MESSAGE} images per message`);
	}
	if (keptTextFileIndexes.length + newTextFiles.length > MAX_EDIT_TEXT_FILES_PER_MESSAGE) {
		throw new ValidationError(`Maximum ${MAX_EDIT_TEXT_FILES_PER_MESSAGE} text files per message`);
	}
	// The primary buffer consumer interprets /new and /goal rather than sending
	// them as ordinary model turns. Editing must not bypass send-time rejection.
	if (
		!located.fromSubagentQueue &&
		(fileReferences ?? located.message.fileReferences ?? []).length > 0 &&
		[text, located.message.commandText ?? ""].some((value) =>
			/^\/(?:new|goal)(?:\s|$)/.test(value.trim()),
		)
	) {
		throw new ValidationError("File references are not supported by queued /new or /goal commands");
	}
	const snapshots = await replaceFileReferenceSnapshots(
		located.message.fileReferences ?? [],
		fileReferences,
		(references) => captureFileReferences(id, c.get("user").sub, references, c.req.raw.signal),
	);
	const finalReferenceCount = (snapshots ?? located.message.fileReferences ?? []).length;
	const finalImageCount = keptImages.length + newImageFiles.length;
	const finalTextFileCount = keptTextFileIndexes.length + newTextFiles.length;
	if (!text && finalImageCount === 0 && finalTextFileCount === 0 && finalReferenceCount === 0) {
		throw new ValidationError("Message cannot be empty");
	}

	// The kept halves, resolved before anything is written so the compensating
	// deletes below know exactly which old files this edit orphans.
	const currentSavedFiles = located.message._savedFiles ?? [];
	const keptSavedFiles = currentSavedFiles.filter((_, index) =>
		keptTextFileIndexes.includes(index),
	);
	const droppedSavedFiles = currentSavedFiles.filter(
		(_, index) => !keptTextFileIndexes.includes(index),
	);
	const droppedImages = (located.message.images ?? []).filter(
		(image) => !keptImages.some((kept) => kept.imageId === image.imageId),
	);

	// Everything this request writes to disk, so a failure leaves nothing behind.
	const createdImageIds: string[] = [];
	let createdSavedFiles: SavedBufferedFile[] = [];
	let committed = false;
	try {
		const newImages: ImageRef[] = [];
		for (const file of newImageFiles) {
			const saved = await saveUploadedImage(id, file);
			createdImageIds.push(saved.imageId);
			newImages.push(saved);
		}

		// Both actor types retain the same saved paths; never re-upload kept Files.
		createdSavedFiles = newTextFiles.length
			? await persistAdditionalBufferedTextFiles(
					mid,
					newTextFiles,
					keptSavedFiles.map((file) => file.filename),
				)
			: [];
		const savedFiles = [...keptSavedFiles, ...createdSavedFiles];
		const ok = await updateBufferedMessage(id, mid, text, {
			images: [...keptImages, ...newImages],
			savedFiles,
			fileReferences: snapshots,
		});
		if (!ok) throw new NotFoundError("Buffered message", mid);
		committed = true;
	} finally {
		if (!committed) {
			for (const imageId of createdImageIds) deleteUploadedImage(id, imageId);
			for (const file of createdSavedFiles) deleteBufferedTextFile(file);
		}
	}

	// Only now that the queue holds the new set: these files are referenced by
	// nothing else, since an unconsumed queued message owns its uploads outright.
	for (const image of droppedImages) {
		deleteUploadedImage(image.uploadNarratorId ?? id, image.imageId);
	}
	for (const file of droppedSavedFiles) deleteBufferedTextFile(file);

	await broadcastBufferQueue(id);
	return c.json({ ok: true });
});

/** Called under start admission; only signal owners, never await their finalizers. */
async function applyPendingBufferModeControl(
	id: string,
	mid: string,
	mode: import("@shared/buffer-queue-mode").BufferQueueMode,
	child: boolean,
): Promise<boolean> {
	const applyControl = child
		? (await import("../services/subagent-executor")).applySubagentBufferedQueueModeControl
		: (await import("../services/narrator-session")).applyBufferedQueueModeControl;
	// Always consult async authority: PostgreSQL must not fall into SQLite probes.
	// Resolve imports first so there is no async gap between authority and signaling.
	const remaining = await getBufferedMessagesAsync(id);
	const target = remaining.find((message) => message.id === mid);
	const targetQueued = target !== undefined && target.state !== "failed";
	const effectiveMode = target ? resolveBufferQueueMode(target.queueMode, target.priority) : mode;
	const hasPendingGuidance = remaining.some(
		(message) =>
			message.state !== "failed" &&
			resolveBufferQueueMode(message.queueMode, message.priority) !== "turn",
	);
	applyControl(id, effectiveMode, hasPendingGuidance, targetQueued);
	return targetQueued && effectiveMode !== "turn";
}

// Changing a queued mode never mutates or retries its durable payload.
narratorRoutes.patch("/:id/buffer/:mid/mode", async (c) => {
	const id = c.req.param("id");
	const mid = c.req.param("mid");
	const parsed = updateBufferedMessageModeSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { withNarratorStartAdmission } = await import("../services/narrator-session-state");
	const narrator = await narratorService.getById(id);
	let shouldWake = false;
	let awaitDelivery = false;
	await withNarratorStartAdmission(id, async () => {
		if (!(await updateBufferedMessageMode(id, mid, parsed.data.mode))) {
			if (parsed.data.mode === "interrupt") {
				const { readBufferedMessageDeliveryReceipt } = await import("../services/narrator-buffer");
				const receipt = await readBufferedMessageDeliveryReceipt(id, mid);
				if (receipt?.state === "claimed" || receipt?.state === "materialized") {
					// Retry/a concurrent request already owns this delivery. Never abort its new owner.
					awaitDelivery = true;
					return;
				}
			}
			throw new AppError("Buffered message was claimed or is no longer pending", 409, "CONFLICT");
		}
		shouldWake = await applyPendingBufferModeControl(
			id,
			mid,
			parsed.data.mode,
			isSubagentVariant(narrator.variant),
		);
		awaitDelivery = shouldWake && parsed.data.mode === "interrupt";
	});
	try {
		if (awaitDelivery) {
			const { waitForBufferedMessageDelivery } = await import("../services/narrator-buffer");
			const delivered = await waitForBufferedMessageDelivery(id, mid, { signal: c.req.raw.signal });
			return c.json({ ok: true, ...delivered });
		}
		if (shouldWake) {
			// Admission must be released before waking; existing owners retain delivery responsibility.
			const { wakeInboxIfEligible } = await import("../services/agent-runtime/inbox");
			await wakeInboxIfEligible(id);
		}
		return c.json({ ok: true });
	} finally {
		// Timeout/error is not rollback: publish the retained durable mode and payload too.
		await broadcastBufferQueue(id);
	}
});

// Explicit retry retains the stable mailbox/recipient identity and resets failed attempts.
narratorRoutes.post("/:id/buffer/:mid/retry", async (c) => {
	const id = c.req.param("id");
	const mid = c.req.param("mid");
	const { withNarratorStartAdmission } = await import("../services/narrator-session-state");
	const narrator = await narratorService.getById(id);
	let urgentRetry = false;
	await withNarratorStartAdmission(id, async () => {
		// Retain mode before the transition: the recovered row may be claimed immediately.
		const previous = (await getBufferedMessagesAsync(id)).find((message) => message.id === mid);
		let retried: boolean;
		try {
			retried = await retryBufferedMessage(id, mid);
		} catch (error) {
			throw new ValidationError(
				error instanceof Error ? error.message : "Buffered payload unavailable",
			);
		}
		if (!retried) throw new ValidationError("Only a failed user message can be retried");
		urgentRetry = resolveBufferQueueMode(previous?.queueMode, previous?.priority) === "interrupt";
		if (urgentRetry && !(await updateBufferedMessageMode(id, mid, "interrupt"))) {
			const { readBufferedMessageDeliveryReceipt } = await import("../services/narrator-buffer");
			const receipt = await readBufferedMessageDeliveryReceipt(id, mid);
			if (receipt?.state === "claimed" || receipt?.state === "materialized") {
				// Another consumer already owns the restored input; confirm it outside
				// admission without aborting that consumer's fresh execution owner.
				return;
			}
			throw new AppError("Retried urgent input is no longer pending", 409, "CONFLICT");
		}
		// Promotion and cancellation share admission: no later urgent row can be
		// dispatched ahead of the selected retry before its control signal lands.
		// A control failure must not roll back or repeat this committed durable transition.
		await applyPendingBufferModeControl(
			id,
			mid,
			resolveBufferQueueMode(previous?.queueMode, previous?.priority),
			isSubagentVariant(narrator.variant),
		);
	});
	try {
		if (urgentRetry) {
			const { waitForBufferedMessageDelivery } = await import("../services/narrator-buffer");
			const delivered = await waitForBufferedMessageDelivery(id, mid, { signal: c.req.raw.signal });
			return c.json({ ok: true, resumed: true, ...delivered });
		}
		const { wakeInboxIfEligible } = await import("../services/agent-runtime/inbox");
		const resumed = await wakeInboxIfEligible(id);
		return c.json({ ok: true, resumed });
	} finally {
		await broadcastBufferQueue(id);
	}
});

// Remove a single queued buffered message
narratorRoutes.delete("/:id/buffer/:mid", async (c) => {
	const id = c.req.param("id");
	const mid = c.req.param("mid");
	// The wrapper cancels from the shared mailbox and clears subagent soft-stop
	// state; the primary counterpart is cleared below for the same queue identity.
	const { removeSubagentBufferedMessage } = await import("../services/narrator-subagent");
	const ok = await removeSubagentBufferedMessage(id, mid);
	if (!ok) throw new NotFoundError("Buffered message", mid);
	const remaining = await getBufferedMessagesAsync(id);
	clearBufferedMessageSoftStopIfIdle(
		id,
		remaining.some(
			(message) =>
				message.state !== "failed" &&
				resolveBufferQueueMode(message.queueMode, message.priority) !== "turn",
		),
	);
	await broadcastBufferQueue(id);
	return c.json({ ok: true });
});

// Reorder queued buffered messages
narratorRoutes.put("/:id/buffer/reorder", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json();
	const parsed = reorderBufferSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const ok = await reorderBufferedMessages(id, parsed.data.orderedIds);
	if (!ok) throw new ValidationError("Invalid reorder: ids do not match the current queue");
	await broadcastBufferQueue(id);
	return c.json({ ok: true });
});

// Clear entire buffer queue
narratorRoutes.delete("/:id/buffer", async (c) => {
	const id = c.req.param("id");
	// One persistent cancellation, plus each actor adapter's ephemeral soft stop.
	const { clearSubagentBufferedMessages } = await import("../services/narrator-subagent");
	await clearSubagentBufferedMessages(id);
	const remaining = await getBufferedMessagesAsync(id);
	clearBufferedMessageSoftStopIfIdle(
		id,
		remaining.some(
			(message) =>
				message.state !== "failed" &&
				resolveBufferQueueMode(message.queueMode, message.priority) !== "turn",
		),
	);
	await broadcastBufferQueue(id);
	return c.json({ ok: true });
});

// Exact-layout input page for the pretext document model. Pages are transport
// batches only; they are never scrollbar units and carry no height estimates.
narratorRoutes.get("/:id/pretext-document", async (c) => {
	const id = c.req.param("id");
	const afterSeqRaw = c.req.query("afterSeq");
	const beforeSeqRaw = c.req.query("beforeSeq");
	const limitRaw = c.req.query("limit");
	const messageVersionRaw = c.req.query("messageVersion");
	const afterSeq = afterSeqRaw != null ? Number.parseInt(afterSeqRaw, 10) : undefined;
	const beforeSeq = beforeSeqRaw != null ? Number.parseInt(beforeSeqRaw, 10) : undefined;
	const requestedLimit = limitRaw != null ? Number.parseInt(limitRaw, 10) : undefined;
	const expectedMessageVersion =
		messageVersionRaw != null ? Number.parseInt(messageVersionRaw, 10) : undefined;
	const limit =
		requestedLimit != null && !Number.isNaN(requestedLimit)
			? Math.min(Math.max(requestedLimit, 1), 100)
			: 100;
	const result = await narratorService.getPretextDocumentPage(id, {
		afterSeq: afterSeq != null && !Number.isNaN(afterSeq) ? afterSeq : undefined,
		beforeSeq: beforeSeq != null && !Number.isNaN(beforeSeq) ? beforeSeq : undefined,
		limit,
		messageVersion:
			expectedMessageVersion != null && !Number.isNaN(expectedMessageVersion)
				? expectedMessageVersion
				: undefined,
	});
	// Read the message version AFTER the page, never concurrently.
	//
	// The page builder materializes a lazy fork's missing refs on demand
	// (`ensureRefsCoverSeq`), and that backfill bumps `messageVersion`. Run in
	// parallel, this query resolves BEFORE the backfill commits while the page
	// carries the post-backfill version — so the equality check below failed
	// deterministically on the first upward scroll past a fork boundary, the one
	// place the backfill actually copies anything. Sequenced, both sides observe
	// the same post-backfill version, and the check goes back to meaning what it
	// says: another writer changed the narrator underneath us.
	const narratorMeta = await db.query.narrators.findFirst({
		where: eq(narrators.id, id),
		columns: { messageVersion: true },
	});
	if (!narratorMeta) throw new NotFoundError("Narrator", id);
	if (narratorMeta.messageVersion !== result.messageVersion)
		throw new AppError(
			"Narrator message version changed while the exact-layout page was being built",
			409,
			"PRETEXT_DOCUMENT_CHANGED",
		);
	return c.json(result);
});

// Resolve a message id to the document coordinate the exact-layout list jumps to.
narratorRoutes.get("/:id/message-location/:messageId", async (c) => {
	const id = c.req.param("id");
	const messageId = c.req.param("messageId");
	const location = await narratorService.getMessageLocation(id, messageId);
	return c.json(location);
});

/**
 * Bounded recovery scan for sessions whose timeline cannot paginate because one
 * message exceeded the history-aggregation budget. Lists oversized messages with
 * metadata only so the client can offer "delete this message and after" without
 * ever loading the broken aggregate.
 */
narratorRoutes.get("/:id/history-recovery", async (c) => {
	const id = c.req.param("id");
	const recovery = await narratorService.getHistoryRecovery(id);
	return c.json(recovery);
});

// Full-text search within this narrator's own conversation history.
narratorRoutes.get("/:id/search", async (c) => {
	const id = c.req.param("id");
	const q = c.req.query("q");
	if (!q?.trim()) return c.json({ results: [] });
	const rawLimit = Number.parseInt(c.req.query("limit") ?? "60", 10);
	const limit = Number.isNaN(rawLimit) ? 60 : rawLimit;
	// A lazy fork leaves pre-compact history in its ancestors, so search has to look
	// there too — otherwise a fork would appear to have lost its earlier transcript.
	// Each step carries the seq bound that keeps the ancestor's post-fork messages out.
	const lineage = await resolveLazyLineage(id);
	const results = await searchService.searchNarratorMessages(
		id,
		q.trim(),
		limit,
		lineage.map((step) => ({
			narratorId: step.parentNarratorId,
			upperBoundSeq: step.upperBoundSeq,
		})),
	);
	return c.json({ results });
});

/**
 * Download this narrator's transcript as Markdown or JSON.
 *
 * Streamed rather than buffered: a long history is tens of MB, and serializing it
 * whole would hold it all in memory and block the loop while doing so. The
 * generator pages with the event loop yielded in between, so the response starts
 * flowing immediately and other requests keep being served.
 */
narratorRoutes.get("/:id/export", async (c) => {
	const id = c.req.param("id");
	const parsed = narratorExportQuerySchema.safeParse(c.req.query());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const options = parsed.data;

	// Resolve the narrator up front so a bad id is a clean 404 rather than an
	// attachment whose body happens to contain an error.
	const narrator = await narratorService.getById(id);

	const fileName = buildExportFileName(narrator.title, options.format);
	// One controller shared by start() and cancel(): a client that closes the tab
	// mid-download must stop the paging loop, not leave it querying into a void.
	const abort = new AbortController();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const encoder = new TextEncoder();
			try {
				for await (const chunk of streamNarratorExport(id, options, abort.signal)) {
					if (abort.signal.aborted) break;
					controller.enqueue(encoder.encode(chunk));
				}
			} catch (error) {
				// streamNarratorExport already converts mid-stream failures into an
				// explicit "incomplete" tail; reaching here means the consumer went
				// away, so there is nothing left to report to.
				logger.warn("Narrator export stream ended early", {
					narratorId: id,
					error: error instanceof Error ? error.message : String(error),
				});
			} finally {
				try {
					controller.close();
				} catch {
					// Already closed by cancel().
				}
			}
		},
		cancel() {
			abort.abort();
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type":
				options.format === "json"
					? "application/json; charset=utf-8"
					: "text/markdown; charset=utf-8",
			// Both spellings: the ASCII name is the safe fallback, `filename*` carries
			// the real (possibly CJK) title per RFC 5987.
			"Content-Disposition": `attachment; filename="${fileName.ascii}"; filename*=UTF-8''${encodeURIComponent(
				fileName.utf8,
			)}`,
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
});

// Exact historical file bodies, authorized by the same ref/COW/child selector as detail.
narratorRoutes.get("/:id/tool-calls/:toolUseId/file-edit-preview", async (c) => {
	const row = await narratorService.getToolCallPreviewMetadata(
		c.req.param("id"),
		c.req.param("toolUseId"),
		{ toolCallId: c.req.query("toolCallId"), messageId: c.req.query("messageId") },
	);
	const preview = await getToolEditPreview(row, c.req.raw.signal);
	// Blob/git IO yields: a revoked narrator ACL or message ref must not leak a
	// response that was authorized before that asynchronous read began.
	await requireNarratorAccess(c, c.req.param("id"), "read");
	await narratorService.getToolCallPreviewMetadata(c.req.param("id"), row.toolUseId, {
		toolCallId: row.id,
		messageId: row.messageId,
	});
	c.header("Cache-Control", "no-store");
	return c.json(preview);
});

// Get full tool call detail (untruncated inputJson/outputJson). Provider IDs can
// repeat, so callers may pin the actual tool row or containing message.
narratorRoutes.get("/:id/tool-calls/:toolUseId/input-document", async (c) => {
	const narratorId = c.req.param("id");
	await requireNarratorAccess(c, narratorId, "read");
	const reference = parseHistoricalWriteDocumentReference(c.req.query());
	const ref = await toolInputStreamSource.ensureWriteDocumentSource(
		narratorId,
		c.req.param("toolUseId"),
		reference,
		c.req.raw.signal,
	);
	await requireNarratorAccess(c, narratorId, "read");
	c.header("Cache-Control", "no-store");
	return c.json(ref);
});

narratorRoutes.get("/:id/text-documents/:refId", async (c) => {
	const narratorId = c.req.param("id");
	const { offset, limit } = parseTextDocumentRangeQuery(c.req.query());
	const range = await toolInputStreamSource.getTextDocumentRange(
		narratorId,
		c.req.param("refId"),
		offset,
		limit,
		c.req.raw.signal,
	);
	// The existing /:id/* gate applies first; re-check ACL after async disk reads.
	await requireNarratorAccess(c, narratorId, "read");
	c.header("Cache-Control", "no-store");
	return c.json(range);
});

narratorRoutes.get("/:id/tool-calls/:toolUseId", async (c) => {
	const id = c.req.param("id");
	const toolUseId = c.req.param("toolUseId");
	const tc = await narratorService.getToolCallDetail(id, toolUseId, {
		toolCallId: c.req.query("toolCallId"),
		messageId: c.req.query("messageId"),
	});
	return c.json(tc);
});

// Stream live compact text only after the detail modal has explicitly opened.
narratorRoutes.get("/:id/compact/:messageId/live", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const parseOffset = (name: string): number => {
		const raw = c.req.query(name);
		if (raw === undefined || raw === "") return 0;
		const value = Number(raw);
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new ValidationError(`${name} must be a non-negative integer`);
		}
		return value;
	};
	const outputOffset = parseOffset("outputOffset");
	const thinkingOffset = parseOffset("thinkingOffset");
	const detail = await narratorService.getCompactSummary(narratorId, messageId);
	if (detail.status !== "compacting") {
		return c.json({ error: "Compact is no longer running", code: "COMPACT_NOT_RUNNING" }, 409);
	}

	return streamSSE(c, async (stream) => {
		const queue: LiveCompactStreamEvent[] = [];
		let wake: (() => void) | undefined;
		let finished = false;
		let stopped = false;
		const enqueue = (event: LiveCompactStreamEvent) => {
			if (event.kind === "delta") {
				const previous = queue.at(-1);
				if (
					previous?.kind === "delta" &&
					previous.channel === event.channel &&
					previous.delta.length + event.delta.length <= 32_000
				) {
					previous.delta += event.delta;
					previous.outputChars = event.outputChars;
					previous.thinkingChars = event.thinkingChars;
					wake?.();
					return;
				}
			}
			queue.push(event);
			if (event.kind === "finished") finished = true;
			wake?.();
			wake = undefined;
		};
		const unsubscribe = subscribeLiveCompactProgress(
			messageId,
			{ output: outputOffset, thinking: thinkingOffset },
			enqueue,
		);
		if (!unsubscribe) {
			await stream.writeSSE({
				event: "error",
				data: JSON.stringify({ code: "COMPACT_LIVE_UNAVAILABLE" }),
			});
			return;
		}
		const keepAlive = setInterval(() => {
			const current = liveCompactProgress.get(messageId);
			if (!current) return;
			enqueue({
				kind: "heartbeat",
				outputChars: current.outputChars,
				thinkingChars: current.thinkingChars,
			});
		}, 15_000);
		const abort = () => {
			stopped = true;
			wake?.();
			wake = undefined;
		};
		c.req.raw.signal.addEventListener("abort", abort, { once: true });
		try {
			while (!stopped) {
				if (queue.length === 0) {
					if (finished) break;
					await new Promise<void>((resolve) => {
						wake = resolve;
						if (stopped || queue.length > 0) {
							wake = undefined;
							resolve();
						}
					});
					continue;
				}
				const event = queue.shift();
				if (!event) continue;
				await stream.writeSSE({ event: event.kind, data: JSON.stringify(event) });
				if (event.kind === "finished") break;
			}
		} finally {
			clearInterval(keepAlive);
			c.req.raw.signal.removeEventListener("abort", abort);
			unsubscribe();
		}
	});
});

// Get lifecycle detail for a specific compact message, including failed markers.
narratorRoutes.get("/:id/compact/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const detail = await narratorService.getCompactSummary(narratorId, messageId);
	return c.json(detail);
});

export function buildRetryFailedCompactResponse(
	requestedMessageId: string,
	result: {
		messageId?: unknown;
		oldMessageId?: unknown;
		replacedMessageId?: unknown;
	},
) {
	const messageId =
		typeof result.messageId === "string" && result.messageId.length > 0
			? result.messageId
			: requestedMessageId;
	const oldMessageId =
		typeof result.oldMessageId === "string" && result.oldMessageId.length > 0
			? result.oldMessageId
			: undefined;
	const replacedMessageId =
		typeof result.replacedMessageId === "string" && result.replacedMessageId.length > 0
			? result.replacedMessageId
			: undefined;
	return {
		ok: true as const,
		messageId,
		...(oldMessageId ? { oldMessageId } : {}),
		...(replacedMessageId ? { replacedMessageId } : {}),
	};
}

narratorRoutes.post("/:id/compact/:messageId/retry", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	await narratorService.getById(narratorId);
	if (isCompactInProgress(narratorId)) {
		return c.json({ ok: false, reason: "compact_in_progress" }, 409);
	}
	const detail = await narratorService.getCompactSummary(narratorId, messageId);
	if (!detail.canRetry) {
		return c.json({ ok: false, reason: "compact_not_retryable" }, 409);
	}
	const body = retryFailedCompactSchema.parse(await c.req.json().catch(() => ({})));
	const locale = await getUserLanguage(c.get("user").sub);
	const result = await retryFailedCompact(
		narratorId,
		locale,
		messageId,
		body.model,
		c.get("user").sub,
	);
	result.promise.catch((err) => {
		logger.error("Failed compact retry failed", {
			narratorId,
			messageId: result.messageId ?? messageId,
			requestedMessageId: messageId,
			model: body.model,
			error: String(err),
		});
	});
	return c.json(buildRetryFailedCompactResponse(messageId, result));
});

// Delete a compact message (undo compact)
narratorRoutes.delete("/:id/compact/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const result = await narratorService.deleteCompactMessage(narratorId, messageId);
	broadcastToNarrator(narratorId, {
		type: "messages_deleted",
		narratorId,
		deletedMessageIds: [messageId],
	});
	broadcastToNarrator(narratorId, { type: "compact_done", narratorId });
	return c.json({ ok: true, ...result });
});

/**
 * Clear the way for an operation that rewrites this narrator's history.
 *
 * Editing history while the narrator's own loop is running is a genuine conflict:
 * the loop is still appending the very message and tool-call rows being removed. But
 * refusing was the wrong answer — the user asking to delete or roll back has already
 * decided this turn is not what they want, so making them press Stop first is a
 * detour through a state they do not care about. So the loop is interrupted on their
 * behalf and we wait for it to actually leave (an abort only takes effect at the next
 * await point; acting on the synchronous return would race its cleanup).
 *
 * A loop that will not stop within the budget is reported rather than silently
 * worked around: proceeding would interleave our deletion with its writes.
 *
 * Deliberately NOT checked here: whether something else is writing to the same
 * worktree. That check matched by path, so a different narrator or a background
 * subagent sharing the worktree made every deletion fail — including "delete
 * messages only", which touches no file at all. It was also redundant for the file
 * rollback: `reverseAndRestore` re-captures the worktree under its own lock and
 * 3-way merges, reporting a conflict only on the paths actually being restored. That
 * is a precise answer where this was a guess, so the guess is gone.
 */
async function prepareHistoryRewrite(narratorId: string): Promise<void> {
	if (!(await interruptAndWaitForIdle(narratorId))) {
		throw new ValidationError(
			"This narrator did not stop after being interrupted; try again in a moment",
		);
	}
}

// Batch-delete multiple content blocks across messages
narratorRoutes.delete("/:id/messages/batch-blocks", async (c) => {
	const narratorId = c.req.param("id");
	const body = await c.req.json();
	const { batchDeleteBlocksSchema } = await import("../lib/validators");
	const { blocks, skipRevert, scope } = batchDeleteBlocksSchema.parse(body);
	if (skipRevert !== true) await assertWorkspaceHistoryRevertSupported(narratorId);
	await prepareHistoryRewrite(narratorId);
	const result = await narratorService.deleteMessageBlocks(narratorId, blocks, {
		skipRevert,
		...(scope ? { scope } : {}),
	});
	return c.json({ ok: true, ...result });
});

// Delete a single content block from a message
narratorRoutes.delete("/:id/messages/:messageId/blocks/:blockIndex", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const blockIndex = Number.parseInt(c.req.param("blockIndex"), 10);
	if (Number.isNaN(blockIndex) || blockIndex < 0) {
		throw new ValidationError("Invalid block index");
	}
	const skipRevert = c.req.query("skipRevert") === "1";
	// The narrator scope is the default and refuses on conflict, so the caller needs
	// a way to ask for the wider one its error suggests.
	const scope = revertScopeSchema.parse(c.req.query("scope"));
	if (!skipRevert) await assertWorkspaceHistoryRevertSupported(narratorId);
	await prepareHistoryRewrite(narratorId);
	const result = await narratorService.deleteMessageBlock(narratorId, messageId, blockIndex, {
		skipRevert,
		...(scope ? { scope } : {}),
	});
	return c.json({ ok: true, ...result });
});

// Delete a message and all subsequent messages
narratorRoutes.delete("/:id/messages/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const skipRevert = c.req.query("skipRevert") === "1";
	// The narrator scope is the default and can refuse on conflict; the caller needs a
	// way to act on that refusal, so the widening choice must be expressible here too.
	const scope = revertScopeSchema.parse(c.req.query("scope"));
	if (!skipRevert) await assertWorkspaceHistoryRevertSupported(narratorId);
	await prepareHistoryRewrite(narratorId);
	const result = await narratorService.deleteMessage(narratorId, messageId, {
		skipRevert,
		...(scope ? { scope } : {}),
	});
	return c.json({ ok: true, ...result });
});

// Dismiss a Dynamic Spec carryover display message after its action completes.
narratorRoutes.delete("/:id/spec-carryover-messages/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	await narratorService.dismissSpecCarryoverMessage(narratorId, messageId);
	broadcastToNarrator(narratorId, {
		type: "messages_deleted",
		narratorId,
		deletedMessageIds: [messageId],
	});
	return c.json({ ok: true, deletedMessageIds: [messageId] });
});

/**
 * Start a turn for a review conclusion the narrator already has.
 *
 * The card's "handle" button. It deliberately writes NO message: the conclusion row is
 * itself the `role: "user"` message and has been in the history since the review
 * concluded, so there is nothing to hand over — only a loop to start over what is
 * already there. Writing a copy here is what would put the same findings on screen
 * twice.
 *
 * Which is also why a concluded review does not wake an idle narrator on its own: being
 * informed needs no turn, and spending a model request is the reader's decision.
 *
 * `started: false` splits into two OUTCOMES that must not be conflated, because the
 * latch is what disables the button forever:
 *
 *   - `busy` — a loop is already running, and it rebuilds history from the database on
 *     its next pass, so the conclusion is taken up without this route doing anything.
 *     The latch stays: the reader's intent is satisfied.
 *   - `not_started` — nothing is running AND nothing was started (plan mode, a status
 *     row that is not idle, a throw). Nobody is going to read the row, so the latch is
 *     RELEASED — otherwise the button reads "Handled" for a turn that never happened
 *     and the reader has no way to ask again.
 */
narratorRoutes.post("/:id/review-feedback/:messageId/apply", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);

	const claim = await narratorService.markReviewFeedbackApplied(narratorId, messageId);
	if (claim.alreadyApplied) return c.json({ ok: true, started: false, reason: "already_applied" });
	if (claim.message) {
		broadcastToNarrator(narratorId, {
			type: "message_updated",
			narratorId,
			message: claim.message,
		});
	}

	// Read BEFORE trying to start: afterwards a loop this call started is itself busy,
	// so the two outcomes would be indistinguishable.
	const alreadyRunning = isNarratorRuntimeBusy(narratorId);

	// `startInjectionContinuationIfPossible` owns the gating (continuation lock, idle in
	// both senses, not in plan mode) and runs the loop with an empty prompt — the
	// established spelling for "the turn's content is already in the database".
	const replyInUserLanguage = await getUserReplyInLanguage(userId);
	let started = false;
	try {
		({ started } = await startInjectionContinuationIfPossible(
			narratorId,
			locale,
			replyInUserLanguage,
		));
	} finally {
		// A latch nobody will act on is worse than no latch: the card would be
		// permanently disabled for findings the model never saw.
		if (!started && !alreadyRunning) {
			const released = await narratorService
				.releaseReviewFeedbackClaim(narratorId, messageId)
				.catch(() => undefined);
			if (released) {
				broadcastToNarrator(narratorId, {
					type: "message_updated",
					narratorId,
					message: released,
				});
			}
		}
	}
	return c.json({
		ok: true,
		started,
		reason: started ? "started" : alreadyRunning ? "busy" : "not_started",
	});
});

// Dismiss a working-directory recovery display message after continuation succeeds.
narratorRoutes.delete("/:id/cwd-recovery-messages/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	await narratorService.dismissCwdRecoveryMessage(narratorId, messageId);
	broadcastToNarrator(narratorId, {
		type: "messages_deleted",
		narratorId,
		deletedMessageIds: [messageId],
	});
	return c.json({ ok: true, deletedMessageIds: [messageId] });
});

// Dismiss the interrupt task-guard reminder message
narratorRoutes.delete("/:id/interrupt-task-guard-messages/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	await narratorService.dismissInterruptTaskGuardMessage(narratorId, messageId);
	broadcastToNarrator(narratorId, {
		type: "messages_deleted",
		narratorId,
		deletedMessageIds: [messageId],
	});
	return c.json({ ok: true, deletedMessageIds: [messageId] });
});

// Dismiss a single error system message
narratorRoutes.delete("/:id/error-messages/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	await narratorService.dismissErrorMessage(narratorId, messageId);
	broadcastToNarrator(narratorId, {
		type: "messages_deleted",
		narratorId,
		deletedMessageIds: [messageId],
	});
	return c.json({ ok: true, deletedMessageIds: [messageId] });
});

// Update a compact message summary
narratorRoutes.patch("/:id/compact/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const { summary } = await c.req.json();
	if (!summary || typeof summary !== "string") throw new ValidationError("summary is required");
	await narratorService.updateCompactSummary(narratorId, messageId, summary);
	return c.json({ ok: true });
});

// Trigger manual compact
narratorRoutes.post("/:id/compact", async (c) => {
	const narratorId = c.req.param("id");
	await narratorService.getById(narratorId);
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const body = await c.req.json().catch(() => ({}));
	const beforeMessageId = body.beforeMessageId ?? undefined;

	if (isCompactInProgress(narratorId)) {
		return c.json({ ok: false, reason: "compact_in_progress" }, 409);
	}

	// Fire-and-forget — compact may take a while (AI summary generation).
	// compact_done / compact_failed are broadcast from doRunCustomCompact itself.
	runCustomCompact(narratorId, locale, beforeMessageId, { userId: c.get("user").sub }).catch(
		(err) => {
			logger.error("Manual compact failed", { narratorId, err: String(err) });
		},
	);
	return c.json({ ok: true });
});

// Cancel an in-progress compact — aborts the summary-model request and rolls
// back the placeholder marker. Rollback + WS broadcasts happen inside
// doRunCustomCompact's abort branch once the aborted request rejects.
narratorRoutes.post("/:id/compact/cancel", async (c) => {
	const narratorId = c.req.param("id");
	await narratorService.getById(narratorId);
	const cancelled = cancelCompact(narratorId);
	if (!cancelled) {
		return c.json({ ok: false, reason: "no_compact_in_progress" }, 409);
	}
	return c.json({ ok: true });
});

// Clear context — insert an empty compact marker so subsequent queries start fresh.
// When `beforeMessageId` is provided, the marker is positioned before that message
// (discarding earlier context up to that point); otherwise it is appended at the end.
narratorRoutes.post("/:id/clear-context", async (c) => {
	const narratorId = c.req.param("id");
	await narratorService.getById(narratorId);
	const body = await c.req.json().catch(() => ({}));
	const beforeMessageId = body.beforeMessageId ?? undefined;
	const msg = beforeMessageId
		? await narratorService.clearContextBefore(narratorId, beforeMessageId)
		: await narratorService.clearContext(narratorId);
	resetActiveUpstreamSession(narratorId);
	broadcastToNarrator(narratorId, { type: "message", narratorId, message: msg });
	broadcastToNarrator(narratorId, { type: "compact_done", narratorId });
	// On a full context clear (no anchor), the Dynamic Spec tasks.json is left
	// intact. If tasks remain, surface a UI-only card so the user can clear the
	// tasks or reset the spec — mirroring the fork carryover card. Skipped for
	// "clear to here", where mid-conversation tasks are likely still in use.
	if (!beforeMessageId) {
		await narratorService.insertSpecClearedCarryoverCard(narratorId);
	}
	return c.json({ ok: true, messageId: msg.id });
});

// Create a plan compact message
narratorRoutes.post("/:id/plan", async (c) => {
	const narratorId = c.req.param("id");
	await narratorService.getById(narratorId);
	const { content } = await c.req.json();
	if (!content || typeof content !== "string") throw new ValidationError("content is required");
	const msg = await narratorService.persistPlanMessage(narratorId, content);
	return c.json(msg);
});

// === Segment compact routes ===

// Trigger segment compact for selected messages
narratorRoutes.post("/:id/segment-compact", async (c) => {
	const narratorId = c.req.param("id");
	await narratorService.getById(narratorId);
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const body = await c.req.json();
	const parsed = segmentCompactSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { messageIds } = parsed.data;

	if (isCompactInProgress(narratorId)) {
		return c.json({ ok: false, reason: "compact_in_progress" }, 409);
	}

	runSegmentCompact(narratorId, locale, messageIds, c.get("user").sub).catch((err) => {
		logger.error("Segment compact failed", { narratorId, err: String(err) });
	});
	return c.json({ ok: true });
});

// Get segment compact summary
narratorRoutes.get("/:id/segment-compact/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const summary = await narratorService.getSegmentCompactSummary(narratorId, messageId);
	return c.json({ summary });
});

// Get messages hidden by a segment compact
narratorRoutes.get("/:id/segment-compact/:messageId/messages", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const messages = await narratorService.getSegmentCompactHiddenMessages(narratorId, messageId);
	return c.json({ messages });
});

// Delete segment compact (undo)
narratorRoutes.delete("/:id/segment-compact/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	await narratorService.deleteSegmentCompact(narratorId, messageId);
	broadcastToNarrator(narratorId, {
		type: "messages_deleted",
		narratorId,
		deletedMessageIds: [messageId],
	});
	broadcastToNarrator(narratorId, { type: "compact_done", narratorId });
	return c.json({ ok: true });
});

// Update segment compact summary
narratorRoutes.patch("/:id/segment-compact/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const body = await c.req.json();
	const parsed = updateSegmentCompactSummarySchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	await narratorService.updateSegmentCompactSummary(narratorId, messageId, parsed.data.summary);
	return c.json({ ok: true });
});

// Interrupt active session
narratorRoutes.post("/:id/interrupt", async (c) => {
	const id = c.req.param("id");
	// Always try to abort any in-flight manual /bash command. These run outside
	// the agent loop (both the standalone /bash command with no active loop, and
	// the runBashFirst pre-prompt flow), so the loop-level abort below cannot
	// reach the underlying process on its own.
	let interrupted = interruptManualBash(id);
	// A TAKEN-OVER subagent owned by the foreground runner is stopped through its turn
	// controller, never through `interruptNarrator`. A running subagent is always
	// registered in `activeNarrators`, so `interruptNarrator` would succeed and abort
	// the SESSION controller — bypassing `turnAbort`, so the runtime took the generic
	// abort exit, cleared the takeover and settled the parent's blocked Agent call.
	// Aborting `turnAbort` softly routes the stop into the control transition that
	// drains the queue or re-suspends in `taken_over`. While SUSPENDED there is no turn
	// controller and nothing is touched (see the EXCEPTION note below).
	//
	// Ownership is judged by the detach registry, which the foreground runner holds for
	// its whole run (suspension included). A takeover continued on the session engine
	// has no entry there and keeps the ordinary `interruptNarrator` stop.
	const {
		getDetachableMap,
		getForegroundAbortControllers,
		interruptForegroundSubagent,
		interruptForegroundSubagentsForParent,
		isTakenOver,
	} = await import("../services/narrator-subagent");
	const foregroundTakeover = isTakenOver(id) && getDetachableMap().has(id);
	if (foregroundTakeover) {
		if (getForegroundAbortControllers().has(id)) {
			interrupted = interruptForegroundSubagent(id, { hard: false }) || interrupted;
			// `interruptNarrator` would also have stopped this subagent's own child
			// subagents; keep that fan-out. It only touches children whose owning Agent
			// call was cancelled by the abort above.
			void interruptForegroundSubagentsForParent(id).catch(() => {});
		}
	} else if (interruptNarrator(id)) interrupted = true;
	if (!interrupted && !foregroundTakeover) {
		// Fallback: the UI Stop button should hard-stop foreground/background subagents.
		// The soft foreground interrupt is still used by Send({ doInterrupt: true }).
		const { cancelBackgroundTask } = await import("../services/narrator-subagent");
		// EXCEPTION — a taken-over subagent must never be HARD interrupted from here.
		// A hard interrupt makes runForegroundLoop break out of its loop before the
		// queue-drain and the takeover suspension, so `finalizeSubagent` discards
		// every queued message and the parent's blocked tool call is resolved — the
		// takeover silently ends and the user's message is lost. During a takeover the
		// user drives this subagent like an independent narrator, so Stop means "stop
		// the current turn", exactly as the soft interrupt does: the loop then drains
		// the queue (or re-suspends in `taken_over`) and the parent stays blocked.
		//
		// CONSEQUENCE, deliberate: while a taken-over subagent is SUSPENDED (parked in
		// idle[taken_over] awaiting the user's next command, no foreground controller),
		// this reports false and changes nothing — including the zombie fallback below,
		// which only fires for working/waiting. That is the honest answer: no turn is in
		// flight to stop. The alternative is worse — the soft path's only other lever is
		// `interruptManualOverride`, which SETTLES the subagent and hands a result to the
		// parent, i.e. it would END the takeover rather than interrupt anything. Ending
		// one is `POST /:id/stop-takeover`'s job. The UI matches: it shows "Stop takeover"
		// rather than Stop while suspended, so the inert button is unreachable there; a
		// direct API caller gets `{interrupted: false}`.
		interrupted = interruptForegroundSubagent(id, { hard: !isTakenOver(id) });
		if (!interrupted) {
			interrupted = await cancelBackgroundTask(id);
		}
	}
	// Fallback: if no active loop found but DB status is still working/waiting,
	// the narrator is a zombie (loop ended without updating status, e.g. after
	// hot reload or unhandled error). Force-reset to interrupted.
	// A foreground takeover still owned by its runner is never a zombie: overwriting
	// its status would erase `taken_over` while the parent is still blocked on it.
	if (!interrupted && !foregroundTakeover) {
		const narrator = await narratorService.getById(id);
		if (narrator.status === "working" || narrator.status === "waiting") {
			await narratorService.updateStatus(id, "idle", { substatus: ["interrupted"] });
			interrupted = true;
		}
	}

	// The ordinary Stop route remains fire-and-forget for compatibility. The
	// interrupt-and-insert composer path opts into waiting so the loop's complete
	// finalizer (including interrupt_task_guard persistence) finishes before the
	// replacement user message is accepted.
	if (c.req.query("waitForIdle") === "1") {
		const narrator = await narratorService.getById(id);
		if (!isSubagentVariant(narrator.variant)) {
			// The narrator may have become idle between the UI's active-state check
			// and this request. That is already a safe boundary for replacement input.
			if (!interrupted) return c.json({ interrupted: false, settled: true });
			const settled = await interruptAndWaitForIdle(id);
			if (!settled) return c.json({ interrupted: true, settled: false }, 409);
			return c.json({ interrupted: true, settled: true });
		}
	}
	return c.json({ interrupted });
});

// Adopt a running Bash execution without interrupting or respawning it.
// The narrator write-access gate above also covers this tool-specific route.
narratorRoutes.post("/:id/tools/:toolUseId/detach", async (c) => {
	const { detachBashProcess } = await import("../lib/agent/tools/bash");
	const detached = await detachBashProcess(c.req.param("toolUseId"), c.req.param("id"));
	if (!detached) {
		return c.json({ error: "Bash is not running in foreground mode" }, 409);
	}
	return c.json({ detached: true, ...detached });
});

// Detach a foreground subagent to background mode (zero-interrupt)
narratorRoutes.post("/:id/detach", async (c) => {
	const id = c.req.param("id");
	return withSubagentResumeLock(id, async () => {
		const { detachSubagent, getManualOverrideRuntime } = await import(
			"../services/narrator-subagent"
		);
		const detached = await detachSubagent(id);
		if (!detached) {
			const runtime = getManualOverrideRuntime(id);
			if (runtime?.phase === "claimed") {
				return c.json(
					{
						error: "Manual override transition is already in progress",
						code: "MANUAL_OVERRIDE_CLAIMED",
						retryable: true,
					},
					409,
				);
			}
			return c.json({ error: "Subagent is not running in foreground mode" }, 400);
		}
		return c.json({ detached: true });
	});
});

/**
 * Take over a running subagent WITHOUT stopping what it is doing.
 *
 * Taking over is a claim on the RESULT, not on the current turn: the user says
 * "this conclusion goes through me before it reaches the parent". The turn in
 * flight is left alone and runs to its natural end; only then does the subagent
 * park in `idle[taken_over]` awaiting the user instead of handing its result
 * back. Every engine reaches that hold on its own (see the takeover branches in
 * `subagent-runner`'s foreground loop, `executeBackgroundTask`, and
 * narrator-session's post-turn handoff), so this route only has to record the
 * claim and tell the UI.
 *
 * It used to abort the turn — the hold was only reachable from the runner's
 * "subagent was interrupted" branch — which meant a user who wanted to inspect
 * the work before it was handed over first had to destroy the turn producing it.
 * Wanting to stop the turn is a separate wish with its own button: Stop is soft
 * during a takeover and keeps the hold (`POST /:id/interrupt`).
 *
 * Consequences of not interrupting, all intended:
 * - a background subagent stays in background mode until its turn ends, so the
 *   task row is still `running` and the parent's Await still waits — correct,
 *   nothing has been concluded yet.
 * - the badge appears while the subagent is visibly still working. That IS the
 *   state: taken over and mid-turn.
 */
narratorRoutes.post("/:id/takeover", async (c) => {
	const id = c.req.param("id");
	return withSubagentResumeLock(id, async () => {
		const narrator = await narratorService.getById(id);

		if (!isSubagentVariant(narrator.variant)) {
			return c.json({ error: "Not a subagent" }, 400);
		}
		if (!narrator.parentNarratorId) {
			return c.json({ error: "No parent narrator" }, 400);
		}
		if (narrator.status !== "working" && narrator.status !== "waiting") {
			return c.json({ error: "Subagent is not running" }, 400);
		}

		const { getForegroundAbortControllers, getBackgroundAbortControllers, markTakenOver } =
			await import("../services/narrator-subagent");

		// Which engine is driving it decides only ONE thing here: whether the hold
		// must be remembered as a background takeover (the parent holds a
		// background_task_id rather than a blocked tool call, so stop-takeover has to
		// finalize it as a background completion).
		const background = narrator.isBackground && narrator.backgroundStatus === "running";
		const running =
			getForegroundAbortControllers().has(id) ||
			(background && getBackgroundAbortControllers().has(id)) ||
			isNarratorActive(id) ||
			isLoopRunning(id);
		if (!running) {
			// The DB says working/waiting but no engine owns it: either a foreground
			// subagent caught between turns, or a zombie row. Retry rather than
			// recording a takeover nothing will ever honour.
			return c.json({ error: "Subagent is between turns; retry shortly" }, 409);
		}

		markTakenOver(id, background ? { background: true } : undefined);

		// The tag is written now, while the turn is still running, so the page and
		// the parent's card both show "taken over" immediately. The status itself is
		// left untouched: the subagent really is still working.
		await narratorService.addSubstatus(id, TAKEN_OVER_SUBSTATUS).catch(() => {});
		broadcastToNarrator(narrator.parentNarratorId, {
			type: "subagent_status_changed",
			narratorId: narrator.parentNarratorId,
			subagentNarratorId: id,
			status: narrator.status,
			substatus: [...parseSubstatus(narrator.substatus), TAKEN_OVER_SUBSTATUS],
		});
		// The parent's Agent/Task CARD is a separate consumer from the panel status
		// chip above — without this frame the call keeps rendering as plain "running".
		await broadcastSubagentTakeoverChanged({
			parentNarratorId: narrator.parentNarratorId,
			subagentNarratorId: id,
			takenOver: true,
		});
		return c.json({ takenOver: true });
	});
});

// Stop taking over a subagent. Returns the result to the parent narrator: if the
// subagent is idle (has a conclusion), the parent's blocked tool call resolves
// immediately; if it is still working, the result is returned when its loop ends.
narratorRoutes.post("/:id/stop-takeover", async (c) => {
	const id = c.req.param("id");
	return withSubagentResumeLock(id, async () => {
		const narrator = await narratorService.getById(id);

		if (!isSubagentVariant(narrator.variant)) {
			return c.json({ error: "Not a subagent" }, 400);
		}
		if (!narrator.parentNarratorId) {
			return c.json({ error: "No parent narrator" }, 400);
		}

		const {
			isTakenOver,
			isBackgroundTakenOver,
			clearTakenOver,
			markPendingStopTakeover,
			markPendingBackgroundFinalize,
			finalizeTakenOverBackgroundSubagent,
			isManualOverride,
			resolveManualOverride,
		} = await import("../services/narrator-subagent");

		if (!isTakenOver(id)) {
			return c.json({ error: "Subagent is not taken over" }, 400);
		}

		const wasBackground = isBackgroundTakenOver(id);
		// Use the live in-memory loop presence (single-threaded JS = authoritative)
		// rather than the DB status snapshot, which can go stale between read and the
		// branch decision and strand the pending marker (loop ends seeing no marker).
		//
		// All THREE engines must be consulted, not just the session one. Taking over no
		// longer stops the turn, so releasing during a turn the user never stopped is
		// now an ordinary sequence rather than a narrow race — and a turn owned by the
		// subagent foreground/background runner is invisible to `isNarratorActive`.
		// Missing it takes the "idle" branch: a partial result is handed to the parent
		// while the loop is still producing one, and the loop then concludes a second
		// time.
		const { getSubagentFinalText, isNarratorActive } = await import("../services/narrator-session");
		const { getForegroundAbortControllers, getBackgroundAbortControllers } = await import(
			"../services/narrator-subagent"
		);
		// Resolve the parent tool_use that originally spawned this subagent.
		const firstMsg = await db.query.narratorMessages.findFirst({
			where: and(
				eq(narratorMessages.narratorId, id),
				eq(narratorMessages.role, "user"),
				isNotNull(narratorMessages.parentToolUseId),
			),
			columns: { parentToolUseId: true },
			orderBy: narratorMessages.createdAt,
		});
		const parentToolUseId = firstMsg?.parentToolUseId ?? "";

		// Publish release only once its handoff/deferral succeeded. In particular,
		// a conclusion validation/write failure must keep the takeover retryable.
		const parentNarratorId = narrator.parentNarratorId;
		const broadcastReleased = () =>
			broadcastSubagentTakeoverChanged({
				parentNarratorId,
				subagentNarratorId: id,
				takenOver: false,
				...(parentToolUseId ? { toolUseId: parentToolUseId } : {}),
			});

		// A suspended foreground runner retains its loop flag and abort controller.
		// Settle its control wait before treating those as an executing turn; a pending
		// stop alone cannot wake the runner to consume that marker.
		if (isManualOverride(id)) {
			const finalText = await getSubagentFinalText(id);
			const hasError = parseSubstatus(narrator.substatus).includes("error");
			if (resolveManualOverride(id, finalText, hasError)) {
				clearTakenOver(id);
				await narratorService.removeSubstatus(id, "taken_over").catch(() => {});
				await broadcastReleased();
				return c.json({ stopped: true, deferred: false });
			}
			// Resume may have claimed the wait during the lookup. Re-probe the live
			// runner below and defer handoff to that turn instead of releasing twice.
		}

		// Probe after the awaited lookups, immediately before marking the
		// handoff. A loop can finish while those awaits yield. Its CURRENT owner,
		// not the mode it originally started in, decides who must settle the result.
		const foregroundRunning = getForegroundAbortControllers().has(id);
		const isRunning =
			isNarratorActive(id) ||
			isLoopRunning(id) ||
			foregroundRunning ||
			getBackgroundAbortControllers().has(id);
		if (wasBackground && !foregroundRunning && !isManualOverride(id)) {
			// Background takeover: the parent was never blocked (it holds the
			// background_task_id). Restore background completion semantics so the
			// result reaches the parent via Await / completion sidecar.
			if (isRunning) {
				// Still working — defer: when the loop ends, finalize as a background
				// completion. Keep the takeover state until then so intermediate state
				// stays consistent; only drop the visible tag.
				markPendingBackgroundFinalize(id);
				await narratorService.removeSubstatus(id, "taken_over").catch(() => {});
				await broadcastReleased();
				return c.json({ stopped: true, deferred: true });
			}
			// Idle — finalize as a background completion now.
			const finalText = await getSubagentFinalText(id);
			const hasError = parseSubstatus(narrator.substatus).includes("error");
			const userId = c.get("user").sub;
			const locale = await getUserLanguage(userId);
			clearTakenOver(id);
			await narratorService.removeSubstatus(id, "taken_over").catch(() => {});
			await finalizeTakenOverBackgroundSubagent(
				id,
				narrator.parentNarratorId,
				parentToolUseId,
				hasError,
				finalText,
				locale,
				userId,
			);
			await broadcastReleased();
			return c.json({ stopped: true, deferred: false });
		}

		// Foreground takeover: the parent is blocked in waitForManualOverride.
		if (isRunning) {
			// Still working — defer result handoff until the loop ends. Mark the stop
			// so the loop's takeover-handoff resolves the parent's Promise exactly once
			// (single write via the parent's finalizer). Do NOT clearTakenOver here:
			// that would also wipe the pendingStopTakeover marker (clearTakenOver clears
			// all takeover sets). The handoff clears takeover state after consuming it.
			markPendingStopTakeover(id);
			await narratorService.removeSubstatus(id, "taken_over").catch(() => {});
			await broadcastReleased();
			return c.json({ stopped: true, deferred: true });
		}

		// Idle — resolve the parent's blocked Promise immediately with the current result.
		const finalText = await getSubagentFinalText(id);
		const hasError = parseSubstatus(narrator.substatus).includes("error");

		// Session-engine takeover (e.g. continued from a manual_override): the parent
		// was already unblocked when the user continued the subagent, and a conclusion
		// watcher was registered to hand the result back. Trigger that handoff now.
		const { getConclusionWatcher, removeConclusionWatcher } = await import(
			"../services/narrator-subagent"
		);
		const watcher = getConclusionWatcher(id);
		if (watcher) {
			const {
				getSubagentResultMessageId,
				prepareSubagentConclusionReference,
				updateToolCallConclusion,
			} = await import("../services/narrator-session");
			const resultMsgId = await getSubagentResultMessageId(id);
			const reference = await prepareSubagentConclusionReference(
				id,
				narrator.parentNarratorId,
				watcher.toolUseId,
				watcher.originToolCallId,
			);
			await updateToolCallConclusion({
				toolCallId: reference.toolCallId,
				messageId: reference.messageId,
				subagentId: id,
				parentNarratorId: narrator.parentNarratorId,
				toolUseId: watcher.toolUseId,
				finalText,
				hasError,
				resultMessageId: resultMsgId,
				refreshTiming: true,
			});
			// A failed write must leave both the watcher and takeover retryable.
			if (getConclusionWatcher(id) === watcher) removeConclusionWatcher(id);
			clearTakenOver(id);
			await narratorService
				.updateStatus(id, "idle", {
					substatus: hasError ? ["error"] : ["unread"],
					skipErrorMessage: true,
				})
				.catch(() => {});
			await broadcastReleased();
			return c.json({ stopped: true, deferred: false });
		}

		// Neither a blocked foreground loop nor a conclusion watcher: a foreground
		// subagent whose takeover interrupt has fired but whose loop has not yet
		// reached the suspension branch (the "settling" window). Instead of failing
		// with a retry-me error, record a pending stop-takeover marker: when the loop
		// reaches its suspension branch it consumes the marker, skips the manual
		// override wait, and hands the current result straight back to the blocked
		// parent. Drop only the visible tag now; clearTakenOver runs in the loop after
		// the marker is consumed (clearing it here would wipe the marker too).
		markPendingStopTakeover(id);
		await narratorService.removeSubstatus(id, "taken_over").catch(() => {});
		await broadcastReleased();
		return c.json({ stopped: true, deferred: true });
	});
});

// Update the conclusion of an already-completed subagent.
// The user continued operating the subagent from its page and wants to
// push the new result back to the parent narrator's tool_call outputJson.
// If the subagent is in manual_override state (parent blocked waiting),
// this resolves the blocked Promise so the parent narrator resumes.
narratorRoutes.post("/:id/update-conclusion", async (c) => {
	const id = c.req.param("id");
	return withSubagentResumeLock(id, async () => {
		const narrator = await narratorService.getById(id);

		if (!isSubagentVariant(narrator.variant)) {
			return c.json({ error: "Not a subagent" }, 400);
		}
		if (!narrator.parentNarratorId) {
			return c.json({ error: "No parent narrator" }, 400);
		}

		// Find the tool_use that spawned this subagent by looking at the subagent's
		// first user message's parentToolUseId
		const firstMsg = await db.query.narratorMessages.findFirst({
			where: and(
				eq(narratorMessages.narratorId, id),
				eq(narratorMessages.role, "user"),
				isNotNull(narratorMessages.parentToolUseId),
			),
			columns: { parentToolUseId: true },
			orderBy: narratorMessages.createdAt,
		});
		if (!firstMsg?.parentToolUseId) {
			return c.json({ error: "Cannot find parent tool_use" }, 400);
		}
		const toolUseId = firstMsg.parentToolUseId;

		const { getSubagentFinalText } = await import("../services/narrator-session");
		const finalText = await getSubagentFinalText(id);
		const hasError = narrator.substatus?.includes("error") ?? false;

		// Check if the parent is blocked in manual_override — if so, resolve
		// the Promise directly. The original foreground subagent runner will
		// handle finalizeSubagent and tool_call updates when it resumes.
		const { isManualOverride, resolveManualOverride } = await import(
			"../services/narrator-subagent"
		);
		if (isManualOverride(id)) {
			if (!resolveManualOverride(id, finalText, hasError)) {
				return c.json(
					{
						error: "Manual override transition is already in progress",
						code: "MANUAL_OVERRIDE_CLAIMED",
						retryable: true,
					},
					409,
				);
			}
			return c.json({ ok: true, toolUseId, outcome: "released_blocked_parent" });
		}

		const { prepareSubagentConclusionReference, updateToolCallConclusion } = await import(
			"../services/narrator-session"
		);
		const reference = await prepareSubagentConclusionReference(
			id,
			narrator.parentNarratorId,
			toolUseId,
		);
		await updateToolCallConclusion({
			subagentId: id,
			parentNarratorId: narrator.parentNarratorId,
			toolUseId,
			finalText,
			hasError,
			messageId: reference.messageId,
			toolCallId: reference.toolCallId,
		});

		return c.json({ ok: true, toolUseId, outcome: "updated_existing_conclusion" });
	});
});

// User left the narrator page — reset interrupted status to idle
narratorRoutes.post("/:id/leave", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);
	if (narrator?.substatus?.includes("interrupted")) {
		await narratorService.updateStatus(id, "idle", { substatus: [] });
	}
	return c.json({ ok: true });
});

// List execution devices visible to this narrator and its current session default.
narratorRoutes.get("/:id/execution-devices", async (c) => {
	return c.json(await getNarratorExecutionDeviceState(c.req.param("id")));
});

/**
 * Browse one level of a device's filesystem, for the permission-rule path picker.
 *
 * /api/devices is admin-only because remote executors grant file and command
 * execution on other machines, and `allowRoots` defaults to empty (unrestricted),
 * so a raw `fs.list` can walk a device's whole filesystem. Device visibility to a
 * narrator is NOT a substitute for that gate: any logged-in user can name any
 * narratorId here, and narrator visibility is per-project, not per-caller. So the
 * previous "the narrator could already execute there anyway" argument does not
 * transfer to the *caller* of this endpoint.
 *
 * The authorization actually enforced below:
 *  - admins get the same reach as /api/devices/:id/browse (no extra restriction);
 *  - every other session is confined to directories that are already reachable
 *    without this endpoint — the device's own declared workspace root (defaultCwd,
 *    which the picker opens at and which the narrator's tools use as their cwd) and
 *    any directory covered by an enabled directory rule scoped to this device. Rule
 *    paths are readable through /:id/whitelist-dirs and /:id/blacklist-dirs, and the
 *    workspace root is readable through /:id/execution-devices, so listing inside
 *    them reveals no path a non-admin caller could not already reach.
 * Anything outside that set is refused with one normalized message, so a non-admin
 * cannot use hit/miss responses to probe for directories.
 */
export const DEVICE_BROWSE_FORBIDDEN_MESSAGE =
	"Path is outside this narrator's device rules; only administrators may browse arbitrary device paths";

/**
 * Whether a non-admin caller may list `requestedPath` on `deviceId`.
 *
 * Containment (not equality) is intentional: the picker drills down from a root,
 * and every descendant of an allowed root is already within the narrator's own
 * declared scope. Blacklist rules count as anchors too — they are user-authored
 * paths on this device that the caller can already read back, and denying browse
 * inside them would make blacklists impossible to edit through the picker.
 */
export function isDeviceBrowsePathWithinNarratorScope(input: {
	requestedPath: string;
	pathFlavor: PathFlavor;
	defaultCwd: string | null;
	rules: readonly { path: string; pathFlavor: PathFlavor; enabled: boolean }[];
}): boolean {
	// normalizePathKey (not identityKey) because pathKeyContains compares
	// "/"-separated keys, which is exactly the form rule.pathKey is stored in.
	const toKey = (path: string) => normalizePathKey(path, input.pathFlavor);
	const requestedKey = toKey(input.requestedPath);
	const anchors: string[] = [];
	if (input.defaultCwd?.trim()) anchors.push(input.defaultCwd.trim());
	for (const rule of input.rules) {
		if (!rule.enabled || rule.pathFlavor !== input.pathFlavor) continue;
		anchors.push(rule.path);
	}
	return anchors.some((anchor) => {
		try {
			return pathKeyContains(toKey(anchor), requestedKey, input.pathFlavor);
		} catch {
			// A malformed stored rule must never widen or crash the check.
			return false;
		}
	});
}

narratorRoutes.get("/:id/device-browse", async (c) => {
	const narratorId = c.req.param("id");
	const deviceId = c.req.query("deviceId");
	if (!deviceId) throw new ValidationError("deviceId is required");
	const parsed = deviceBrowseQuerySchema.safeParse({
		path: c.req.query("path") || undefined,
		showHidden: c.req.query("showHidden") === "1",
	});
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const state = await getNarratorExecutionDeviceState(narratorId);
	if (!state.devices.some((device) => device.id === deviceId)) {
		throw new ValidationError(`Device ${deviceId} is not available to this narrator`);
	}

	// Admins already hold the unrestricted /api/devices browse capability, so
	// re-deriving a narrower scope for them would only break the admin picker.
	const isAdmin = c.get("user").role === "admin";
	if (!isAdmin) {
		// Resolve the target the way the listing itself will, then decide. Doing this
		// before the fs.list RPC means a refused path never reaches the device.
		let target: ReturnType<typeof resolveRemoteBrowseTarget>;
		try {
			target = resolveRemoteBrowseTarget(deviceId, parsed.data.path);
		} catch (err) {
			throw new ValidationError(err instanceof Error ? err.message : String(err));
		}
		const rules = await permissionRuleService.listNarratorRules(narratorId);
		const deviceRules = [...rules.directoryWhitelist, ...rules.directoryBlacklist].filter(
			(rule) => rule.selector.kind === "device" && rule.selector.deviceId === deviceId,
		);
		const allowed = isDeviceBrowsePathWithinNarratorScope({
			requestedPath: target.path,
			pathFlavor: target.pathFlavor,
			defaultCwd: target.defaultCwd,
			rules: deviceRules,
		});
		if (!allowed) throw new AppError(DEVICE_BROWSE_FORBIDDEN_MESSAGE, 403, "FORBIDDEN");
	}

	try {
		return c.json(
			await browseRemoteDirectory(deviceId, parsed.data.path, {
				showHidden: parsed.data.showHidden,
			}),
		);
	} catch (err) {
		// Offline devices, missing dirs and remote permission errors are all
		// user-correctable input problems, not server faults. The message names the
		// remote absolute path and device id, which is why it is only safe to return
		// after the authorization check above.
		throw new ValidationError(err instanceof Error ? err.message : String(err));
	}
});

// Change the session default execution target. null/"local" selects the server.
narratorRoutes.patch("/:id/default-device", async (c) => {
	const body = (await c.req.json()) as unknown;
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new ValidationError("Request body must be an object");
	}
	const value = (body as Record<string, unknown>).deviceId;
	if (value !== null && value !== undefined && typeof value !== "string") {
		throw new ValidationError("deviceId must be a string or null");
	}
	return c.json(
		await setNarratorDefaultDevice(c.req.param("id"), value ?? null, {
			origin: "http",
			userId: c.get("user").sub,
		}),
	);
});

// Update model
narratorRoutes.patch("/:id/model", async (c) => {
	const id = c.req.param("id");
	const parsed = updateNarratorModelSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const narrator = await narratorService.getById(id);
	if (parsed.data.model === FOLLOW_PARENT_MODEL) {
		if (!isSubagentVariant(narrator.variant)) {
			throw new ValidationError("Only subagents can follow a parent model");
		}
		await resolveSubagentModelForRun(
			{ ...narrator, model: FOLLOW_PARENT_MODEL },
			c.get("user").sub,
		);
	}
	await narratorService.updateModel(id, parsed.data.model);
	await updateNarratorModel(id, parsed.data.model);
	return c.json({ ok: true });
});

// Update permission mode
narratorRoutes.patch("/:id/permission-mode", async (c) => {
	const id = c.req.param("id");
	const { permissionMode } = await c.req.json();
	if (!isPermissionMode(permissionMode)) {
		throw new ValidationError(`permissionMode must be one of: ${PERMISSION_MODES.join(", ")}`);
	}
	const narrator = await narratorService.getById(id);

	// Ask-in-passing narrators are locked to readOnly until promoted
	if (hasTrait(parseTraits(narrator.traits), "ask-in-passing")) {
		throw new ValidationError(
			"Cannot change permission mode of an ask-in-passing narrator. Use promote to unlock.",
		);
	}

	await narratorService.updatePermissionMode(id, permissionMode);
	await updateNarratorPermissionMode(id, permissionMode);

	// When switching to bypassPermissions, re-run pending permission requests for
	// this narrator and its subagents. Do not blindly approve: the normal pipeline
	// must still detect fatal/blacklisted/dangerous operations and trigger danger reflection.
	if (permissionMode === "bypassPermissions") {
		// 强制宽松规划，忽略用户默认宽松设置，防止后续计划模式阻塞。
		if (!narrator.relaxedPlan) {
			broadcastToNarrator(id, {
				type: "relaxed_plan_changed",
				narratorId: id,
				relaxedPlan: true,
			});
		}
		reprocessAllPendingPermissions(id);
	}

	return c.json({ ok: true });
});

// Enter plan mode as a narrator trait (not a permission mode)
narratorRoutes.post("/:id/plan-mode/enter", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const planState = await enterNarratorPlanMode(id);
	const active = activeNarrators.get(id);
	if (active) {
		active._planFileId = planState.planFileId;
		active._planFilePath = planState.planFilePath;
		active._previousPermissionMode = planState.previousPermissionMode;
	}
	if (planState.relaxedPlanChanged) {
		broadcastToNarrator(id, {
			type: "relaxed_plan_changed",
			narratorId: id,
			relaxedPlan: true,
		});
	}
	if (planState.wasPlanMode) {
		// Already in plan mode, so nothing changed and there is nothing to announce. The
		// live override is deliberately NOT written here: whichever path turned plan mode
		// on (this route earlier, or the model's own EnterPlanMode) already set it, and
		// writing it on a no-op would pair a live override with no rebuild request.
		return c.json({ ok: true, planMode: true, traits: publicTraitsResponse(planState.traits) });
	}

	if (active) {
		// A running pass froze `planMode`/`relaxedPlan` into its AgentConfig before this
		// toggle. These live values are what its getters read, so the tool-description
		// override and the relaxed-plan checks switch over without waiting for the next
		// pass. Set only past the no-op return above, so every live override written here
		// is paired with the rebuild request below.
		active._planModeLive = true;
		active._relaxedPlanLive = planState.relaxedPlan;
	}

	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const toolUseId = `toolu_manual_${generateShortId()}`;
	const msg = await narratorService.persistAssistantMessage(id, {
		uuid: randomUUID(),
		session_id: randomUUID(),
		parent_tool_use_id: null,
		message: {
			content: [
				{
					type: "tool_use",
					id: toolUseId,
					name: "EnterPlanMode",
					input: {},
				},
			],
		},
	});
	const manualToolCall = await db.query.narratorToolCalls.findFirst({
		where: and(
			eq(narratorToolCalls.messageId, msg.id),
			eq(narratorToolCalls.narratorId, id),
			eq(narratorToolCalls.toolUseId, toolUseId),
		),
		columns: { id: true },
	});
	if (!manualToolCall) throw new Error("Manual plan-mode message has no persisted tool row");
	await narratorService.updateToolCallResult(
		toolUseId,
		{
			output: getToolMessageWithParams("enterPlanModeOutputWithPath", locale as Locale, {
				planFilePath: planState.planFilePath ?? buildPlanFileRelPath("<id>"),
			}),
			status: "success",
			// The following message broadcast already accounts for this persisted tool state.
			bumpMessageVersion: false,
		},
		msg.id,
		manualToolCall.id,
	);
	const fullMsg = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, msg.id),
		with: { toolCalls: true },
	});
	if (fullMsg) {
		broadcastToNarrator(id, {
			type: "message",
			narratorId: id,
			message: { ...fullMsg, seq: msg.seq },
		});
	}

	// Make the running loop pick all of this up at its next turn boundary.
	//
	// Two things are stale in a pass that started before this toggle, and one rebuild fixes
	// both: the system prompt (which is where the plan-mode reminder lives, fixed at pass
	// start) and the in-memory history (built before the rows above existed). Because the
	// rebuild re-reads history from the DB, the EnterPlanMode tool call and its result —
	// which already state the designated plan file and the next steps — reach the model as
	// its own turn. No separate notification is needed, and inventing a user message to
	// carry one would put words in the user's mouth.
	requestPlanModePromptRebuild(id);

	broadcastToNarrator(id, {
		type: "plan_mode_changed",
		narratorId: id,
		planMode: true,
		traits: publicTraitsResponse(planState.traits),
	});
	return c.json({ ok: true, planMode: true, traits: publicTraitsResponse(planState.traits) });
});

// Cancel plan mode trait without changing the narrator's permission policy.
narratorRoutes.post("/:id/plan-mode/exit", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const userId = c.get("user").sub;
	const locale = (await getUserLanguage(userId)) as Locale;
	const message = getToolMessage("planModeCancelled", locale);
	const cancelledPermissions = await cancelPendingExitPlanMode(id, message);
	const planState = await exitNarratorPlanMode(id);
	const active = activeNarrators.get(id);
	if (active) {
		active._planFileId = undefined;
		active._planFilePath = undefined;
		active._previousPermissionMode = undefined;
	}
	planModeAskedOnce.delete(id);

	if (!planState.wasPlanMode && cancelledPermissions === 0) {
		// Nothing was in plan mode and no permission was cancelled, so this changed
		// nothing. Same reason as the enter route for not writing the live override on a
		// no-op: `false` would shadow a model-driven EnterPlanMode later in the same pass.
		return c.json({ ok: true, planMode: false, traits: publicTraitsResponse(planState.traits) });
	}

	if (active) {
		// Symmetric to the enter route: a running pass froze `planMode: true`, so its getter
		// needs the live value to release the tool-description override.
		active._planModeLive = false;
		// Left undefined rather than false: exiting plan mode must not change the user's
		// permission policy, so relaxed-plan falls back to the narrator's own DB value.
		active._relaxedPlanLive = undefined;
	}

	const msg = await narratorService.persistSystemMessage(id, message, undefined, userId);
	broadcastToNarrator(id, {
		type: "message",
		narratorId: id,
		message: msg,
	});

	// Same reason as the enter route: the row above is invisible to a pass whose history was
	// built before it, and the stale prompt still carries the plan-mode constraint. The
	// rebuild delivers the constraint-free prompt and brings that row in with it.
	requestPlanModePromptRebuild(id);

	broadcastToNarrator(id, {
		type: "plan_mode_changed",
		narratorId: id,
		planMode: false,
		traits: publicTraitsResponse(planState.traits),
	});
	return c.json({
		ok: true,
		planMode: false,
		traits: publicTraitsResponse(planState.traits),
		cancelledPermissions,
	});
});

// Update reasoning effort
narratorRoutes.patch("/:id/reasoning-effort", async (c) => {
	const id = c.req.param("id");
	const { reasoningEffort } = await c.req.json();
	const validEfforts = ["none", "low", "medium", "high", "xhigh", "max"];
	if (
		reasoningEffort !== null &&
		reasoningEffort !== undefined &&
		!validEfforts.includes(reasoningEffort)
	) {
		throw new ValidationError(`reasoningEffort must be one of: ${validEfforts.join(", ")} or null`);
	}
	await narratorService.getById(id); // ensure exists
	await narratorService.updateReasoningEffort(id, reasoningEffort);
	updateNarratorReasoningEffort(id, reasoningEffort ?? null);
	return c.json({ ok: true });
});

// Update fast mode (tri-state override; a legacy boolean is still accepted)
narratorRoutes.patch("/:id/fast-mode", async (c) => {
	const id = c.req.param("id");
	const body = (await c.req.json()) as unknown;
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new ValidationError("Request body must be an object");
	}
	const input = body as { fastModeOverride?: unknown; fastMode?: unknown };
	let override: BooleanOverride;
	if (Object.hasOwn(input, "fastModeOverride")) {
		override = parseBooleanOverride(input.fastModeOverride, "fastModeOverride");
	} else if (typeof input.fastMode === "boolean") {
		override = input.fastMode ? "on" : "off";
	} else {
		throw new ValidationError("fastModeOverride must be one of: inherit, on, off");
	}
	await narratorService.getById(id); // ensure exists
	await narratorService.updateFastModeOverride(id, override);
	const userId = c.get("user").sub;
	const effectiveFastMode = await resolveFastModeForUser(override, userId);
	return c.json({ ok: true, fastModeOverride: override, fastMode: effectiveFastMode });
});

// Update relaxed plan toggle
narratorRoutes.patch("/:id/relaxed-plan", async (c) => {
	const id = c.req.param("id");
	const { relaxedPlan } = await c.req.json();
	if (typeof relaxedPlan !== "boolean") {
		throw new ValidationError("relaxedPlan must be a boolean");
	}
	await narratorService.getById(id); // ensure exists
	const effectiveRelaxedPlan = await narratorService.updateRelaxedPlan(id, relaxedPlan);
	broadcastToNarrator(id, {
		type: "relaxed_plan_changed",
		narratorId: id,
		relaxedPlan: effectiveRelaxedPlan,
	});
	return c.json({ ok: true, relaxedPlan: effectiveRelaxedPlan });
});

// Update per-session reflection overrides
narratorRoutes.patch("/:id/reflection-overrides", async (c) => {
	const id = c.req.param("id");
	const body = (await c.req.json()) as unknown;
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new ValidationError("Request body must be an object");
	}
	const input = body as Record<string, unknown>;
	const updates: {
		planReflectionAutoApproveOverride?: BooleanOverride;
		dangerReflectionOverride?: DangerReflectionOverride;
		autoContinuationOverride?: AutoContinuationOverride;
		tasksReminderIntervalOverride?: number | null;
	} = {};
	if (Object.hasOwn(input, "planReflectionAutoApproveOverride")) {
		updates.planReflectionAutoApproveOverride = parseBooleanOverride(
			input.planReflectionAutoApproveOverride,
			"planReflectionAutoApproveOverride",
		);
	}
	if (Object.hasOwn(input, "dangerReflectionOverride")) {
		updates.dangerReflectionOverride = parseDangerReflectionOverride(
			input.dangerReflectionOverride,
			"dangerReflectionOverride",
		);
	}
	if (Object.hasOwn(input, "autoContinuationOverride")) {
		updates.autoContinuationOverride = parseAutoContinuationOverride(
			input.autoContinuationOverride,
			"autoContinuationOverride",
		);
	}
	if (Object.hasOwn(input, "tasksReminderIntervalOverride")) {
		const raw = input.tasksReminderIntervalOverride;
		if (raw === null) {
			updates.tasksReminderIntervalOverride = null;
		} else if (
			typeof raw === "number" &&
			Number.isInteger(raw) &&
			raw >= -1 &&
			raw <= 1000 &&
			!(raw >= 0 && raw <= 4)
		) {
			updates.tasksReminderIntervalOverride = raw;
		} else {
			throw new ValidationError(
				"tasksReminderIntervalOverride must be null, -1, or an integer between 5 and 1000",
			);
		}
	}
	if (
		!updates.planReflectionAutoApproveOverride &&
		!updates.dangerReflectionOverride &&
		!updates.autoContinuationOverride &&
		!Object.hasOwn(updates, "tasksReminderIntervalOverride")
	) {
		throw new ValidationError("At least one override must be provided");
	}
	await narratorService.getById(id);
	await narratorService.updateReflectionOverrides(id, updates);
	broadcastToNarrator(id, { type: "reflection_overrides_changed", narratorId: id, ...updates });
	return c.json({ ok: true });
});

// Update per-narrator behavior-fence injection settings (interval + tasks-attach override)
narratorRoutes.patch("/:id/behavior-fence", async (c) => {
	const id = c.req.param("id");
	const body = (await c.req.json()) as unknown;
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new ValidationError("Request body must be an object");
	}
	const input = body as Record<string, unknown>;
	const updates: {
		behaviorFenceIntervalOverride?: number | null;
		behaviorFenceAttachOverride?: BooleanOverride;
	} = {};
	if (Object.hasOwn(input, "behaviorFenceIntervalOverride")) {
		const raw = input.behaviorFenceIntervalOverride;
		if (raw === null) {
			updates.behaviorFenceIntervalOverride = null;
		} else if (
			typeof raw === "number" &&
			Number.isInteger(raw) &&
			raw >= -1 &&
			raw <= 1000 &&
			!(raw >= 0 && raw <= 4)
		) {
			updates.behaviorFenceIntervalOverride = raw;
		} else {
			throw new ValidationError(
				"behaviorFenceIntervalOverride must be null, -1, or an integer between 5 and 1000",
			);
		}
	}
	if (Object.hasOwn(input, "behaviorFenceAttachOverride")) {
		updates.behaviorFenceAttachOverride = parseBooleanOverride(
			input.behaviorFenceAttachOverride,
			"behaviorFenceAttachOverride",
		);
	}
	if (
		!Object.hasOwn(updates, "behaviorFenceIntervalOverride") &&
		!updates.behaviorFenceAttachOverride
	) {
		throw new ValidationError("At least one behavior-fence setting must be provided");
	}
	await narratorService.getById(id);
	await narratorService.updateBehaviorFenceSettings(id, updates);
	broadcastToNarrator(id, { type: "behavior_fence_settings_changed", narratorId: id, ...updates });
	return c.json({ ok: true });
});

// Update narrator title
narratorRoutes.patch("/:id/title", async (c) => {
	const id = c.req.param("id");
	const parsed = updateNarratorTitleSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	await narratorService.getById(id);
	await persistTitle(id, parsed.data.title);
	return c.json({ ok: true, title: parsed.data.title });
});

// Assign, change, or clear a narrator's @handle (named narrator). null clears it.
narratorRoutes.patch("/:id/handle", async (c) => {
	const id = c.req.param("id");
	const parsed = updateNarratorHandleSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const updated = await narratorService.setHandle(id, parsed.data.handle);
	return c.json(publicNarratorResponse(updated));
});

narratorRoutes.route("/", narratorWorkspaceContextRoutes);
narratorRoutes.get("/:id/permission-rule-requests", async (c) => {
	const { listPermissionRuleRequests } = await import(
		"../services/permission-rule-request-service"
	);
	return c.json(await listPermissionRuleRequests(c.req.param("id"), c.req.query()));
});

// Regenerate narrator title via AI
narratorRoutes.post("/:id/generate-title", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const title = await generateTitle(id, locale, userId);
	await persistTitle(id, title);
	return c.json({ title });
});

// Archive narrator
narratorRoutes.patch("/:id/archive", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);
	if (narrator.type === "subagent" || narrator.variant?.startsWith("subagent:")) {
		// Same retire path as Agent archive / history-delete card removal.
		const { interruptAndArchiveSubagent } = await import("../services/subagent-lifecycle");
		const result = await interruptAndArchiveSubagent(id);
		if (!result.ok && result.error === "not_found") {
			// Row vanished between getById and the lifecycle re-read (race delete).
			throw new NotFoundError("Narrator", id);
		}
		if (!result.ok && result.error) {
			// Fall through to the legacy path for non-subagent-shaped failures.
			if (isNarratorActive(id)) closeNarrator(id);
			await narratorService.updateStatus(id, "archived");
		}
		return c.json({ ok: true });
	}
	if (isNarratorActive(id)) closeNarrator(id);
	await narratorService.updateStatus(id, "archived");
	return c.json({ ok: true });
});

// Unarchive narrator
narratorRoutes.patch("/:id/unarchive", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	await narratorService.updateStatus(id, "idle");
	return c.json({ ok: true });
});

// Delete narrator (must be archived)
narratorRoutes.delete("/:id", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);
	if (narrator.status !== "archived") {
		throw new ValidationError("Only archived narrators can be deleted");
	}
	if (isNarratorActive(id)) closeNarrator(id);
	await narratorService.remove(id);
	return c.json({ ok: true });
});

// Mark narrator as read (clear unread substatus)
// Error sessions are preserved because only unread substatus can transition.
// Subagents are skipped — their done/error status must be preserved for follow-up Send.
narratorRoutes.patch("/:id/mark-read", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);
	if (isSubagentVariant(narrator.variant)) return c.json({ ok: true });
	const currentSubstatus = parseSubstatus(narrator.substatus);
	if (narrator.status === "idle" && currentSubstatus.includes("unread") && !narrator.errorMessage) {
		// Only remove the unread tag. Other tags (e.g. compacting/suspended/manual_override)
		// can coexist with unread and must not be clobbered by a read acknowledgement.
		await narratorService.removeSubstatus(id, "unread");
	}
	return c.json({ ok: true });
});

// Fork: create a new standalone narrator containing only the specified messages
narratorRoutes.post("/:id/fork-messages", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json();
	const { forkFromMessagesSchema } = await import("../lib/validators");
	const parsed = forkFromMessagesSchema.parse(body);
	const newNarrator = await narratorService.forkFromMessages(id, parsed.messageIds, {
		title: parsed.title,
	});
	return c.json(publicNarratorResponse(newNarrator), 201);
});

// Ordinary fork always creates an independent narrator, including chapter-bound sources.
narratorRoutes.post("/:id/fork", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json();
	if (
		body &&
		typeof body === "object" &&
		["worktreeSource", "commitSha"].some((key) => Object.hasOwn(body, key))
	)
		throw new ValidationError(
			"worktreeSource and commitSha are unsupported by ordinary narrator forks",
			"NARRATOR_WORKTREE_FORK_UNSUPPORTED",
		);
	const parsed = forkNarratorSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const newNarrator = await narratorService.forkNarrator(id, parsed.data.forkMessageUuid ?? null, {
		title: parsed.data.title,
		userId: c.get("user").sub,
		inheritMode: parsed.data.inheritMode ?? "full",
		forkMessageId: parsed.data.forkMessageId,
		standalone: true,
	});
	return c.json(publicNarratorResponse(newNarrator), 201);
});

// Extract a subagent into an independent primary narrator (not fork — control-plane promotion)
narratorRoutes.post("/:id/extract-primary", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json().catch(() => ({}));
	const { extractPrimarySchema } = await import("../lib/validators");
	const parsed = extractPrimarySchema.parse(body ?? {});
	const newNarrator = await narratorService.extractSubagentToPrimary(id, {
		title: parsed.title,
		inheritMode: parsed.inheritMode ?? "full",
		locale: parsed.locale ?? "en",
	});
	return c.json({ type: "extracted", narrator: publicNarratorResponse(newNarrator) }, 201);
});

// === Ask in passing ===

type AskInPassingPendingBlock = {
	type: "ask_in_passing";
	status: "pending";
	sourceMessageId?: string;
	sourceMessageUuid?: string | null;
};

const ASK_IN_PASSING_CONTENT_PREFIX = "[Ask in passing]";

function buildAskInPassingContentText(question?: string): string {
	const trimmedQuestion = question?.trim();
	return trimmedQuestion
		? `${ASK_IN_PASSING_CONTENT_PREFIX} ${trimmedQuestion}`
		: ASK_IN_PASSING_CONTENT_PREFIX;
}

function getAskInPassingPendingBlock(
	message: { role: string; contentJson: unknown } | null | undefined,
): AskInPassingPendingBlock | null {
	if (!message || message.role !== "system" || !Array.isArray(message.contentJson)) {
		return null;
	}

	for (const block of message.contentJson) {
		if (!block || typeof block !== "object") continue;
		const candidate = block as Record<string, unknown>;
		if (candidate.type === "ask_in_passing" && candidate.status === "pending") {
			return candidate as AskInPassingPendingBlock;
		}
	}

	return null;
}

// Start: create a persistent pending message in the source narrator's chat
narratorRoutes.post("/:id/ask-in-passing/start", async (c) => {
	const id = c.req.param("id");
	const userId = c.get("user").sub;
	const body = await c.req.json();
	const parsed = askInPassingStartSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const { sourceMessageId, sourceMessageUuid } = parsed.data;

	// Verify the source message belongs to this narrator and capture its position.
	const ref = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, id),
			eq(narratorMessageRefs.messageId, sourceMessageId),
		),
		columns: { seq: true },
	});
	if (!ref) throw new ValidationError("Source message not found in this narrator");

	const now = new Date().toISOString();
	const msgId = generateId();
	const msg = dbTransactionWithSeqFloor(id, (tx) => {
		const insertedMsg = tx
			.insert(narratorMessages)
			.values({
				id: msgId,
				narratorId: id,
				role: "system",
				contentJson: [
					{
						type: "ask_in_passing",
						status: "pending",
						sourceMessageId,
						sourceMessageUuid: sourceMessageUuid ?? null,
					},
				],
				contentText: buildAskInPassingContentText(),
				contextCharsJson: { segments: [] },
				createdBy: userId,
				createdAt: now,
			})
			.returning()
			.get();

		// Single seq authority (narrator-refs/seq-store.ts): the shift consumes one
		// top-of-history slot; the primitive owns both the shift and, once
		// `narrators.next_seq` exists, the counter claim that serializes it against
		// concurrent appends on the narrators row.
		// The async membership check above can predate another insertion. Resolve
		// the source again inside the same transaction as the shift/version claim.
		const currentRef = tx.query.narratorMessageRefs
			.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, id),
					eq(narratorMessageRefs.messageId, sourceMessageId),
				),
				columns: { seq: true },
			})
			.sync();
		if (!currentRef) throw new ValidationError("Source message not found in this narrator");
		const insertSeq = currentRef.seq + 1;
		claimShiftInsertSlot(tx, id, insertSeq);

		tx.insert(narratorMessageRefs)
			.values({
				id: generateId(),
				narratorId: id,
				messageId: msgId,
				seq: insertSeq,
			})
			.run();

		const version = tx
			.update(narrators)
			.set({ messageVersion: sql`${narrators.messageVersion} + 1` })
			.where(eq(narrators.id, id))
			.returning({ value: narrators.messageVersion })
			.get();

		return { ...insertedMsg, seq: insertSeq, askInsertVersion: version?.value };
	});

	// Broadcast so the UI updates in real-time
	broadcastToNarrator(id, {
		type: "message",
		narratorId: id,
		message: msg,
	});

	return c.json({ messageId: msgId, message: msg }, 201);
});

// Resolve: fork + send question + update pending message to resolved
narratorRoutes.post("/:id/ask-in-passing", async (c) => {
	const id = c.req.param("id");
	const userId = c.get("user").sub;
	const body = await c.req.json();
	const parsed = askInPassingSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const { question, pendingMessageId } = parsed.data;

	// Verify the pending message exists, belongs to this narrator, and is still pending
	const pendingMsg = await db.query.narratorMessages.findFirst({
		where: and(eq(narratorMessages.id, pendingMessageId), eq(narratorMessages.narratorId, id)),
	});
	const pendingBlock = getAskInPassingPendingBlock(pendingMsg);
	if (!pendingMsg || !pendingBlock) {
		throw new ValidationError("Pending ask-in-passing message not found");
	}

	const sourceMessageId = pendingBlock.sourceMessageId;
	const sourceMessageUuid = pendingBlock.sourceMessageUuid ?? null;
	if (!sourceMessageId && !sourceMessageUuid) {
		throw new ValidationError("Pending ask-in-passing message is missing source reference");
	}

	// Auto-generate title from the question (truncate to 80 chars, take first line)
	const title = question.replace(/\n.*/s, "").slice(0, 80);

	// Fork narrator from the source recorded in the pending card (single source of truth)
	const newNarrator = await narratorService.forkNarrator(id, sourceMessageUuid, {
		inheritMode: "full",
		forkMessageId: sourceMessageId,
		title,
		standalone: true,
		// Ask-in-passing is a lightweight, read-only side conversation; inherited
		// task management is just noise there, so clear it instead of surfacing
		// the reset card.
		specCarryover: "clear",
	});

	// Lock to readOnly + mark as ask-in-passing (user can "promote" later to unlock)
	const aipTraits = addTrait(parseTraits(newNarrator.traits), "ask-in-passing");
	await db
		.update(narrators)
		.set({ permissionMode: "readOnly", isAskInPassing: true, traits: aipTraits })
		.where(eq(narrators.id, newNarrator.id));

	// Send the user's question to the new narrator.
	// NOTE: `userId` belongs in slot 7, not slot 6 (`commandText`). Passing it as
	// the 6th argument previously stored the user id as the message's command text
	// and left createdBy empty, so the question rendered without its author.
	const locale = await getUserLanguage(userId);
	const replyInUserLanguage = await getUserReplyInLanguage(userId);
	await sendMessage(newNarrator.id, question, [], locale, replyInUserLanguage, null, userId);

	// Update the pending message to resolved
	const resolvedContentJson = [
		{
			type: "ask_in_passing",
			status: "resolved",
			sourceMessageId: sourceMessageId ?? null,
			question,
			targetNarratorId: newNarrator.id,
			createdAt: new Date().toISOString(),
		},
	];
	const resolvedContentText = buildAskInPassingContentText(question);
	const updatedMsg = db.transaction((tx) => {
		tx.update(narratorMessages)
			.set({
				contentJson: resolvedContentJson,
				contentText: resolvedContentText,
				contextCharsJson: { segments: [] },
			})
			.where(eq(narratorMessages.id, pendingMessageId))
			.run();

		tx.update(narrators)
			.set({ messageVersion: sql`${narrators.messageVersion} + 1` })
			.where(eq(narrators.id, id))
			.run();

		return {
			...pendingMsg,
			contentJson: resolvedContentJson,
			contentText: resolvedContentText,
		};
	});

	// Broadcast the update
	broadcastToNarrator(id, {
		type: "message_updated",
		narratorId: id,
		message: updatedMsg,
	});

	return c.json({ ...publicNarratorResponse(newNarrator), message: updatedMsg }, 201);
});

// Cancel: delete a pending message
narratorRoutes.delete("/:id/ask-in-passing/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");

	// Verify the message exists and is a pending ask-in-passing
	const msg = await db.query.narratorMessages.findFirst({
		where: and(eq(narratorMessages.id, messageId), eq(narratorMessages.narratorId, narratorId)),
	});
	if (!msg || !getAskInPassingPendingBlock(msg)) {
		throw new ValidationError("Pending ask-in-passing message not found");
	}

	db.transaction((tx) => {
		tx.delete(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, messageId),
				),
			)
			.run();

		const otherRef = tx.query.narratorMessageRefs
			.findFirst({
				where: eq(narratorMessageRefs.messageId, messageId),
			})
			.sync();
		if (!otherRef) {
			tx.delete(narratorMessages).where(eq(narratorMessages.id, messageId)).run();
		}

		tx.update(narrators)
			.set({ messageVersion: sql`${narrators.messageVersion} + 1` })
			.where(eq(narrators.id, narratorId))
			.run();
	});

	// Broadcast deletion
	broadcastToNarrator(narratorId, {
		type: "messages_deleted",
		narratorId,
		deletedMessageIds: [messageId],
	});

	return c.json({ ok: true });
});

// === Promote ask-in-passing narrator ===
// Standalone: unlock permission mode (readOnly → default)
// Chapter-bound: fork a new chapter from the parent chapter
narratorRoutes.post("/:id/promote", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);

	const narratorTraits = parseTraits(narrator.traits);

	if (!hasTrait(narratorTraits, "ask-in-passing")) {
		throw new ValidationError("Only ask-in-passing narrators can be promoted");
	}

	if (!narrator.chapterId) {
		// Standalone narrator: just unlock
		await narratorTraitsLock.acquire(id, async () => {
			const current = await narratorService.getById(id);
			const unlockedTraits = removeTrait(parseTraits(current.traits), "ask-in-passing");
			await db
				.update(narrators)
				.set({
					isAskInPassing: false,
					traits: unlockedTraits,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(narrators.id, id));
		});

		// Promotion removes the ask label, never broadens the existing execution policy.
		await updateNarratorPermissionMode(id, narrator.permissionMode ?? "readOnly");

		const updated = await narratorService.getById(id);
		broadcastToNarrator(id, {
			type: "permission_mode_changed",
			narratorId: id,
			permissionMode: updated.permissionMode ?? "readOnly",
		});

		return c.json({
			type: "unlocked",
			narratorId: updated.id,
			narrator: publicNarratorResponse(updated),
		});
	}

	// Promotion no longer creates a chapter/worktree; the source remains an audit record.
	const forkedNarrator = await narratorService.forkStandaloneFromTool(id, "fork", {
		inheritMode: "full",
		userId: c.get("user").sub,
	});

	// The fork inherits traits; clear only the ask label on the new ordinary narrator,
	// preserving its existing readOnly/OAuth/review permission restrictions.
	await narratorTraitsLock.acquire(forkedNarrator.id, async () => {
		const current = await narratorService.getById(forkedNarrator.id);
		await db
			.update(narrators)
			.set({
				isAskInPassing: false,
				traits: removeTrait(parseTraits(current.traits), "ask-in-passing"),
				updatedAt: new Date().toISOString(),
			})
			.where(eq(narrators.id, forkedNarrator.id));
	});
	const promotedNarrator = await narratorService.getById(forkedNarrator.id);

	// Mark the original ask-in-passing narrator as promoted so the UI
	// no longer shows it as locked.  We keep permissionMode as readOnly
	// since the original narrator stays as a read-only question record.
	await narratorTraitsLock.acquire(id, async () => {
		const current = await narratorService.getById(id);
		const promotedTraits = removeTrait(parseTraits(current.traits), "ask-in-passing");
		await db
			.update(narrators)
			.set({
				isAskInPassing: false,
				traits: promotedTraits,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(narrators.id, id));
	});

	return c.json({
		type: "forked",
		narratorId: promotedNarrator.id,
		narrator: publicNarratorResponse(promotedNarrator),
	});
});

// Get pending permissions
narratorRoutes.get("/:id/permissions", async (c) => {
	const id = c.req.param("id");
	const permissions = await narratorService.getPendingPermissions(id);
	// Attach the live AskUserQuestion reflection deadline (in-memory only) so the
	// frontend can restore its countdown after a reconnect / refetch.
	return c.json(
		permissions.map((p) => {
			const reflectionDeadline = getQuestionReflectionDeadline(p.id);
			return reflectionDeadline !== null ? { ...p, reflectionDeadline } : p;
		}),
	);
});

/**
 * Asynchronous AskUserQuestion inbox.
 *
 * Separate from `/permissions` on purpose. A pending permission is a SUSPENDED loop:
 * the row lives in memory, answering it resumes a promise, and the narrator sits in
 * `waiting`. An async question is none of those things — it is a durable row, the loop
 * moved on long ago, and answering it injects a message. Sharing the permission
 * endpoints would mean every consumer of "pending permissions" (the composer send
 * gate, the Enter-key binding, the attention notifications) inheriting behaviour that
 * is wrong for a question nobody is blocked on.
 */
narratorRoutes.get("/:id/questions", async (c) => {
	const id = c.req.param("id");
	const parsed = asyncQuestionListQuerySchema.safeParse(c.req.query());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	c.header("Cache-Control", "no-store");
	if (parsed.data.filter || !parsed.data.status) {
		return c.json(
			await listQuestionSummaries({
				narratorId: id,
				filter: parsed.data.filter ?? "all",
				cursor: parsed.data.cursor,
				limit: parsed.data.limit,
			}),
		);
	}
	const { items, nextCursor } = await listAsyncQuestions({
		narratorId: id,
		status: parsed.data.status,
		cursor: parsed.data.cursor,
		limit: parsed.data.limit,
	});
	const openCount = await countOpenAsyncQuestions(id);
	return c.json({ items, nextCursor, openCount });
});

narratorRoutes.get("/:id/questions/:questionId", async (c) => {
	const narratorId = c.req.param("id");
	const parsed = asyncQuestionDetailQuerySchema.safeParse(c.req.query());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	c.header("Cache-Control", "no-store");
	const detail = await getBoundedQuestionDetail(c.req.param("questionId"), {
		narratorId,
		cursor: parsed.data.cursor,
		limit: parsed.data.limit,
	});
	if (detail.tooLarge) {
		return c.json({ error: "Question detail exceeds the byte limit", tooLarge: true }, 413);
	}
	if (!detail.record) return c.json({ error: "Question not found" }, 404);
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: NARRATOR_ACL_COLUMNS,
	});
	const canAct = !!narrator && (await canWriteNarrator(narrator, narratorPrincipalOf(c)));
	return c.json({
		question: detail.record,
		supplements: detail.events,
		nextCursor: detail.nextCursor,
		canAct,
	});
});

narratorRoutes.post("/:id/questions/:questionId/supplement", async (c) => {
	const narratorId = c.req.param("id");
	const questionId = c.req.param("questionId");
	const parsed = asyncQuestionSupplementSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const [existing] = await db
		.select({ narratorId: narratorQuestions.narratorId })
		.from(narratorQuestions)
		.where(eq(narratorQuestions.id, questionId))
		.limit(1);
	if (!existing || existing.narratorId !== narratorId) {
		return c.json({ error: "Question not found" }, 404);
	}
	const userId = c.get("user").sub;
	const result = await supplementAsyncQuestion(questionId, {
		text: parsed.data.text,
		expectedAnswerMessageId: parsed.data.answerMessageId,
		userId,
		locale: (await getUserLanguage(userId)) as Locale,
	});
	if (!result.ok) {
		return c.json(
			{ error: result.reason === "not_found" ? "Question not found" : "Question answer changed" },
			result.reason === "not_found" ? 404 : 409,
		);
	}
	return c.json({ ok: true, question: result.record });
});

narratorRoutes.post("/:id/questions/:questionId/answer", async (c) => {
	const narratorId = c.req.param("id");
	const questionId = c.req.param("questionId");
	const userId = c.get("user").sub;
	const body = await c.req.json().catch(() => ({}));
	const parsed = asyncQuestionAnswerSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	// Ownership is checked against the question's own narrator rather than trusting the
	// path: the `/:id/*` gate authorized `narratorId`, so a question belonging to a
	// DIFFERENT narrator must not be reachable by naming an id the caller can access.
	const existing = db
		.select({ narratorId: narratorQuestions.narratorId })
		.from(narratorQuestions)
		.where(eq(narratorQuestions.id, questionId))
		.limit(1)
		.get();
	if (!existing || existing.narratorId !== narratorId) {
		return c.json({ error: "Question not found" }, 404);
	}

	const locale = (await getUserLanguage(userId)) as Locale;
	const result = await answerAsyncQuestion(questionId, {
		answers: parsed.data.answers,
		annotations: parsed.data.annotations ?? null,
		userId,
		locale,
	});
	if (!result.ok) {
		return c.json(
			{ error: result.reason === "stale" ? "Question already decided" : "Question not found" },
			result.reason === "stale" ? 409 : 404,
		);
	}
	return c.json({ ok: true, question: result.record });
});

narratorRoutes.post("/:id/questions/:questionId/dismiss", async (c) => {
	const narratorId = c.req.param("id");
	const questionId = c.req.param("questionId");
	const userId = c.get("user").sub;

	const existing = db
		.select({ narratorId: narratorQuestions.narratorId })
		.from(narratorQuestions)
		.where(eq(narratorQuestions.id, questionId))
		.limit(1)
		.get();
	if (!existing || existing.narratorId !== narratorId) {
		return c.json({ error: "Question not found" }, 404);
	}

	const locale = (await getUserLanguage(userId)) as Locale;
	const result = await dismissAsyncQuestion(questionId, { userId, locale });
	if (!result.ok) {
		return c.json(
			{ error: result.reason === "stale" ? "Question already decided" : "Question not found" },
			result.reason === "stale" ? 409 : 404,
		);
	}
	return c.json({ ok: true, question: result.record });
});

// Close the question WITHOUT notifying the narrator — see ignoreAsyncQuestion for why
// this is a separate action from dismiss rather than a flag on it.
narratorRoutes.post("/:id/questions/:questionId/ignore", async (c) => {
	const narratorId = c.req.param("id");
	const questionId = c.req.param("questionId");
	const userId = c.get("user").sub;

	const existing = db
		.select({ narratorId: narratorQuestions.narratorId })
		.from(narratorQuestions)
		.where(eq(narratorQuestions.id, questionId))
		.limit(1)
		.get();
	if (!existing || existing.narratorId !== narratorId) {
		return c.json({ error: "Question not found" }, 404);
	}

	const locale = (await getUserLanguage(userId)) as Locale;
	const result = await ignoreAsyncQuestion(questionId, { userId, locale });
	if (!result.ok) {
		return c.json(
			{ error: result.reason === "stale" ? "Question already decided" : "Question not found" },
			result.reason === "stale" ? 409 : 404,
		);
	}
	return c.json({ ok: true, question: result.record });
});

// Approve permission
narratorRoutes.post("/permissions/:requestId/approve", async (c) => {
	const requestId = c.req.param("requestId");
	const userId = c.get("user").sub;
	const body = await c.req.json().catch(() => ({}));
	const parsed = permissionDecisionSchema.safeParse({ decision: "allow", ...body });
	const resolved = await resolvePermissionOrDangerReflection(requestId, "allow", {
		answers: parsed.success ? parsed.data.answers : undefined,
		feedbackText: parsed.success ? parsed.data.feedbackText : undefined,
		compactAfter: parsed.success ? parsed.data.compactAfter : undefined,
		updatedPlan: parsed.success ? parsed.data.updatedPlan : undefined,
		userId,
		decidedBy: "user",
	});
	if (!resolved) return c.json({ error: "Permission request not found" }, 404);
	return c.json({ ok: true });
});

// Deny permission
narratorRoutes.post("/permissions/:requestId/deny", async (c) => {
	const requestId = c.req.param("requestId");
	const body = await c.req.json().catch(() => ({}));
	const parsed = permissionDecisionSchema.safeParse({ decision: "deny", ...body });
	const resolved = await resolvePermissionOrDangerReflection(requestId, "deny", {
		denyMessage: parsed.success ? parsed.data.message : undefined,
		answers: parsed.success ? parsed.data.answers : undefined,
		feedbackText: parsed.success ? parsed.data.feedbackText : undefined,
		updatedPlan: parsed.success ? parsed.data.updatedPlan : undefined,
		decidedBy: "user",
	});
	if (!resolved) return c.json({ error: "Permission request not found" }, 404);
	return c.json({ ok: true });
});

/**
 * "Answer later": release a blocking AskUserQuestion without deciding it.
 *
 * Resolved as ALLOW rather than deny. The distinction is not cosmetic: a denial tells
 * the agent its call was refused, when in fact the question was accepted and merely
 * moved to the inbox. The gate flips the tool input to `async`, so the tool files the
 * question itself and returns the "carry on with a default" instruction — one code path
 * for both ways a question becomes asynchronous.
 */
narratorRoutes.post("/permissions/:requestId/defer", async (c) => {
	const requestId = c.req.param("requestId");
	const userId = c.get("user").sub;
	const result = await deferPendingQuestion(requestId, { userId });
	if (!result.ok) {
		return c.json(
			{
				error:
					result.reason === "not_a_question"
						? "Only an AskUserQuestion request can be deferred"
						: "Permission request not found",
			},
			result.reason === "not_a_question" ? 400 : 404,
		);
	}
	return c.json({ ok: true });
});

// Run AskUserQuestion reflection immediately and submit the generated answers
narratorRoutes.post("/permissions/:requestId/reflect-question", async (c) => {
	const requestId = c.req.param("requestId");
	const result = await reflectPendingAskUserQuestion(requestId);
	if (!result.ok) {
		return c.json({ error: result.reason ?? "Question reflection request not found" }, 404);
	}
	return c.json({ ok: true, answers: result.answers ?? {} });
});

// Silently cancel the automatic AskUserQuestion reflection countdown (e.g. the
// user started answering). Idempotent — always succeeds even if nothing was armed.
narratorRoutes.post("/permissions/:requestId/disarm-question-reflection", async (c) => {
	const requestId = c.req.param("requestId");
	const disarmed = disarmQuestionReflection(requestId);
	return c.json({ ok: true, disarmed });
});

// Stop an AskUserQuestion reflection (timer or in-flight generation) and hand the
// question back to the user to answer.
narratorRoutes.post("/permissions/:requestId/stop-question-reflection", async (c) => {
	const requestId = c.req.param("requestId");
	const body = await c.req.json().catch(() => ({}));
	const reason = typeof body.reason === "string" ? body.reason : undefined;
	const stopped = await takeOverQuestionReflection(requestId, reason);
	if (!stopped) return c.json({ error: "Question reflection request not found" }, 404);
	return c.json({ ok: true });
});

// Stop automatic danger reflection but leave the tool permission pending for user decision
narratorRoutes.post("/permissions/:requestId/stop-reflection", async (c) => {
	const requestId = c.req.param("requestId");
	const body = await c.req.json().catch(() => ({}));
	const reason = typeof body.reason === "string" ? body.reason : undefined;
	const stopped = await stopDangerReflectionLoop(requestId, reason);
	if (!stopped) return c.json({ error: "Danger reflection request not found" }, 404);
	return c.json({ ok: true });
});

// Stop automatic plan reflection and fall back to the normal ExitPlanMode approval request
narratorRoutes.post("/permissions/:requestId/stop-plan-reflection", async (c) => {
	const requestId = c.req.param("requestId");
	const body = await c.req.json().catch(() => ({}));
	const reason = typeof body.reason === "string" ? body.reason : undefined;
	const stopped = await takeOverExitPlanReflection(requestId, reason);
	if (!stopped) return c.json({ error: "Plan reflection request not found" }, 404);
	return c.json({ ok: true });
});

// Stop automatic task reflection and leave the protected-task change pending for user decision
narratorRoutes.post("/permissions/:requestId/stop-task-reflection", async (c) => {
	const requestId = c.req.param("requestId");
	const body = await c.req.json().catch(() => ({}));
	const reason = typeof body.reason === "string" ? body.reason : undefined;
	const stopped = await takeOverTaskReflection(requestId, reason);
	if (!stopped) return c.json({ error: "Task reflection request not found" }, 404);
	return c.json({ ok: true });
});

// Suggest best-practice answers for AskUserQuestion
narratorRoutes.post("/:id/suggest-answers", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);
	const userId = c.get("user").sub;
	const locale = (await getUserLanguage(userId)) as Locale;

	const body = await c.req.json();
	const parsed = suggestAnswersSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	// Normalize legacy/advertised shapes before reflection; answers are keyed by header.
	const questions = coerceAskQuestions(parsed.data.questions);
	const answers = await generateAskUserQuestionAnswers(id, questions, {
		locale,
		model: narrator.model,
		actingUserId: userId,
		mode: "suggest",
	});

	return c.json({ answers });
});

// === Snapshot / Patch routes ===

function revertConflictBody(result: RevertResult) {
	return {
		error: "File operation could not be completed safely",
		code: "SNAPSHOT_REVERT_FAILED",
		failures: result.failures,
	};
}

function fileHistoryConflictBody(error: unknown) {
	const historyError = error instanceof FileHistoryError ? error : null;
	return {
		error: error instanceof Error ? error.message : String(error),
		code: historyError?.code ?? "FILE_HISTORY_PREPARE_FAILED",
	};
}

/**
 * Expose both scopes' availability without choosing a wider fallback. Legacy tree
 * differences are read-only inspection material, not permission to execute them.
 */
async function buildRevertScopePreviews(narratorId: string, minSeq: number, withContents = false) {
	const [narratorScope, treePreview] = await Promise.all([
		previewNarratorScopedFromSeq(narratorId, minSeq, { withContents }),
		previewSeqTreeRevert(narratorId, minSeq),
	]);
	// Always return the unavailable reasons. Dropping them here used to make the
	// route advertise a legacy replay as though there were no protection gap.

	const workspaceFiles = treePreview
		? withContents
			? (await loadTreePreviewContents(treePreview)).map(({ relPath: _relPath, ...file }) => file)
			: treePreview.files.map(({ relPath: _relPath, ...file }) => file)
		: [];
	const narratorFiles = narratorScope.files.map(({ relPath: _relPath, ...file }) => file);

	// A workspace rollback restores everything in the window, so anything another
	// actor wrote there goes with it. This advice already existed but was only
	// computed while performing the rollback — too late to inform the choice.
	let workspaceWarnings: RevertWarning[] = [];
	if (treePreview) {
		const boundaryStartedAt = await resolveSeqBoundaryStartedAt(narratorId, minSeq);
		if (boundaryStartedAt) {
			workspaceWarnings = await buildImpreciseRevertWarnings(
				treePreview.worktreePath,
				narratorId,
				boundaryStartedAt,
			);
		}
	}

	const scope: RevertScope = DEFAULT_REVERT_SCOPE;

	return {
		scope,
		// Kept for older clients: the default scope's files.
		affectedFiles: scope === "narrator" ? narratorFiles : workspaceFiles,
		narratorScope: {
			available: narratorScope.available,
			...(narratorScope.reason ? { reason: narratorScope.reason } : {}),
			files: narratorFiles,
			conflicts: narratorScope.conflicts,
			...(narratorScope.subagentWarning ? { subagentWarning: narratorScope.subagentWarning } : {}),
		},
		workspaceScope: {
			available: false,
			reason: treePreview ? "legacy_unverified" : "no_boundaries",
			files: workspaceFiles,
			warnings: workspaceWarnings,
		},
	};
}

/** When the earliest reversible change in a window started, for warning lookups. */
async function resolveSeqBoundaryStartedAt(
	narratorId: string,
	minSeq: number,
): Promise<string | null> {
	const [earliest] = await db
		.select({ createdAt: narratorToolCalls.createdAt })
		.from(narratorToolCalls)
		.innerJoin(
			narratorMessageRefs,
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, narratorToolCalls.messageId),
			),
		)
		.where(
			and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.status, "success"),
				gte(narratorMessageRefs.seq, minSeq),
			),
		)
		.orderBy(asc(narratorMessageRefs.seq), asc(narratorToolCalls.createdAt))
		.limit(1);
	return earliest?.createdAt ?? null;
}

/** Durable preview only: these endpoints do not apply files or mutate history. */
function revertPreviewJson(c: Context, value: unknown) {
	const body = JSON.stringify(value);
	if (Buffer.byteLength(body) >= FILE_CHANGE_LIMITS.summaryBytes)
		throw new AppError(
			"Preview response exceeds its metadata byte budget",
			409,
			"REVERT_PREVIEW_RESPONSE_TOO_LARGE",
		);
	return c.body(body, 200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
}

function validRevertPreview<T>(result: { success: true; data: T } | { success: false }): T {
	if (!result.success)
		throw new ValidationError("Invalid narrator-only preview request, selector or pagination");
	return result.data;
}

narratorRoutes.post("/:id/revert-action-preview", async (c) => {
	const raw = await c.req.json().catch((error: unknown) => {
		if (!(error instanceof SyntaxError)) throw error;
		throw new ValidationError("Invalid preview JSON body");
	});
	const body = validRevertPreview(createRevertActionPreviewSchema.safeParse(raw));
	const result = await prepareLocalRevertAction(
		narratorPrincipalOf(c),
		c.req.param("id"),
		body,
		AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(60_000)]),
	);
	return revertPreviewJson(c, result);
});

narratorRoutes.post("/:id/revert-plans/:planId/apply", async (c) => {
	const raw = await c.req.json().catch((error: unknown) => {
		if (!(error instanceof SyntaxError)) throw error;
		throw new ValidationError("Invalid apply JSON body");
	});
	const body = validRevertPreview(applyRevertPlanSchema.safeParse(raw));
	const result = await applyLocalRevertPlan(
		narratorPrincipalOf(c),
		c.req.param("id"),
		validRevertPreview(revertPlanIdSchema.safeParse(c.req.param("planId"))),
		body,
		AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(60_000)]),
	);
	c.header("Cache-Control", "no-store");
	if (result.status !== "committed" || result.settling)
		return c.json(
			{
				...result,
				code: "REVERT_APPLY_NOT_COMMITTED",
				error: result.reason ?? "Rollback did not commit",
			},
			409,
		);
	return c.json(result);
});

narratorRoutes.post("/:id/revert-plans", async (c) => {
	const raw = await c.req.json().catch((error: unknown) => {
		// Preserve bodyLimit's own 413 handling and request cancellation.
		if (!(error instanceof SyntaxError)) throw error;
		throw new ValidationError("Invalid preview JSON body");
	});
	const body = validRevertPreview(createRevertPlanSchema.safeParse(raw));
	const result = await prepareLocalRevertPlan({
		...body,
		principal: narratorPrincipalOf(c),
		narratorId: c.req.param("id"),
		signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(60_000)]),
	});
	return revertPreviewJson(c, result);
});
narratorRoutes.get("/:id/revert-plans/:planId", async (c) => {
	const result = await getLocalRevertPlan(
		narratorPrincipalOf(c),
		c.req.param("id"),
		validRevertPreview(revertPlanIdSchema.safeParse(c.req.param("planId"))),
		AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]),
	);
	return revertPreviewJson(c, result);
});
narratorRoutes.get("/:id/revert-plans/:planId/files", async (c) => {
	const query = validRevertPreview(revertPlanFilesQuerySchema.safeParse(c.req.query()));
	const result = await listLocalRevertPlanFiles(
		narratorPrincipalOf(c),
		c.req.param("id"),
		validRevertPreview(revertPlanIdSchema.safeParse(c.req.param("planId"))),
		{
			limit: query.limit,
			cursor: query.cursor ? { fileKey: query.cursor } : undefined,
			signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]),
		},
	);
	return revertPreviewJson(c, result);
});

/** Revert file changes from a specific message onwards */
narratorRoutes.post("/:id/revert", async (c) => {
	const narratorId = c.req.param("id");
	const body = revertFilesSchema.parse(await c.req.json());

	// Prevent revert while narrator is actively running
	if (isNarratorActive(narratorId)) {
		return c.json({ error: "Cannot revert while narrator is running" }, 409);
	}

	let targetSeq = 0;
	if (body.messageId !== "__all__") {
		const targetRef = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, body.messageId),
			),
			columns: { seq: true },
		});
		if (!targetRef) return c.json({ error: "Message not found" }, 404);
		targetSeq = targetRef.seq;
	}

	if (isNarratorActive(narratorId)) {
		return c.json({ error: "Narrator became active during revert" }, 409);
	}
	// Scope is a user decision, not a strategy fallback. In particular, missing
	// narrator evidence cannot authorize a workspace restore or whole-file replay.
	const scope = body.scope ?? DEFAULT_REVERT_SCOPE;
	const result =
		scope === "narrator"
			? await revertNarratorScopedFromSeq(narratorId, targetSeq)
			: ((await revertFromSeqTree(narratorId, targetSeq)) ??
				unavailableSnapshotRevert("no_boundaries: no verified workspace snapshot is available."));
	if (result.failures.length > 0) return c.json(revertConflictBody(result), 409);
	// No history mutation follows: the reverted files are the intended end state.
	finalizeSnapshotRevert(result);
	return c.json({
		fileCount: result.fileCount,
		files: result.files,
		// Advisory: a workspace rollback also discards other actors' changes in the
		// same window, so the caller is told to verify rather than assume.
		...(result.warnings?.length ? { warnings: result.warnings } : {}),
	});
});

/** Unrevert requires the real pre-revert states in a durable revert journal. */
narratorRoutes.post("/:id/unrevert", async (c) => {
	const narratorId = c.req.param("id");
	if (isNarratorActive(narratorId)) {
		return c.json({ error: "Cannot unrevert while narrator is running" }, 409);
	}
	// M0 has no persistent revert operation to address. Replaying all historical
	// Write/Edit inputs would overwrite later edits and failed first-touch baselines.
	return c.json(
		revertConflictBody(
			unavailableSnapshotRevert(
				"legacy_unverified: unrevert requires a committed durable revert journal; files were not changed.",
			),
		),
		409,
	);
});

/**
 * Current uncommitted line counts for the narrator file tree.
 *
 * The tree may be rooted at a standalone narrator's cwd or at a subdirectory inside a
 * chapter worktree, so this route is narrator-scoped rather than chapter-scoped. Git's
 * status query is likewise scoped to that cwd; paths therefore match the tree's relative
 * keys without the client guessing how the cwd relates to the repository root.
 */
narratorRoutes.get("/:id/file-tree-status", async (c) => {
	const narratorId = c.req.param("id");
	const cwd = await resolveNarratorCwd(narratorId);
	if (!cwd || !(await gitService.getRepositoryRoot(cwd))) {
		return c.json({ isGitRepo: false, files: [], totalFiles: 0, truncated: false });
	}

	// Share the same short-lived cache used by the Git panel. The watcher invalidates it
	// before broadcasting file activity, and concurrent file-tree surfaces then reuse the
	// one fresh Git query instead of each spawning their own set of processes.
	const status = await getStatusSummaryCached(cwd);
	return c.json({
		isGitRepo: true,
		files: status.files.map((file) => ({
			path: file.path,
			linesAdded: file.linesAdded,
			linesRemoved: file.linesRemoved,
		})),
		totalFiles: status.totalFiles,
		truncated: status.totalFiles > status.files.length,
	});
});

/**
 * Preview file changes that would be reverted by a rollback-to-block operation.
 *
 * `blockIndex` is optional. Omitting it means "everything after this message",
 * which is the window edit-and-regenerate truncates: it keeps the whole user turn
 * and removes the later ones. That is the same boundary the endpoint already
 * computes for a user message, since `normalizeRollbackBlockIndexForMessage` pins
 * a user message's index to its last block — so the edit dialog can share this
 * preview instead of inventing a block index that only looks meaningful.
 */
narratorRoutes.get("/:id/rollback-preview", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.query("messageId");
	const blockIndexStr = c.req.query("blockIndex");
	if (!messageId) return c.json({ error: "messageId query param is required" }, 400);
	const requestedBlockIndex =
		blockIndexStr === undefined ? null : Number.parseInt(blockIndexStr, 10);
	if (
		requestedBlockIndex !== null &&
		(Number.isNaN(requestedBlockIndex) || requestedBlockIndex < 0)
	) {
		return c.json({ error: "blockIndex must be a non-negative integer" }, 400);
	}

	// Verify narrator exists
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { id: true },
	});
	if (!narrator) return c.json({ error: "Narrator not found" }, 404);

	const targetRef = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, narratorId),
			eq(narratorMessageRefs.messageId, messageId),
		),
		columns: { seq: true },
	});
	if (!targetRef) return c.json({ error: "Message not found for this narrator" }, 404);

	const targetMsg = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, messageId),
		columns: { role: true, contentJson: true },
	});
	if (!targetMsg) return c.json({ error: "Message not found" }, 404);

	const blocks = Array.isArray(targetMsg.contentJson)
		? (targetMsg.contentJson as { type: string; id?: string }[])
		: [];
	if (requestedBlockIndex !== null && requestedBlockIndex >= blocks.length) {
		return c.json({ error: `Block index ${requestedBlockIndex} out of range` }, 400);
	}

	// No index requested => keep the whole message, drop what follows.
	const effectiveBlockIndex =
		requestedBlockIndex === null
			? blocks.length - 1
			: normalizeRollbackBlockIndexForMessage(targetMsg.role, requestedBlockIndex, blocks.length);

	// Collect tool_use IDs from blocks after the effective boundary in the target message
	const truncatedToolUseIds: string[] = [];
	for (let i = effectiveBlockIndex + 1; i < blocks.length; i++) {
		const b = blocks[i];
		if (b.type === "tool_use" && b.id) {
			truncatedToolUseIds.push(b.id);
		}
	}

	const deletedBlockCount = blocks.length - effectiveBlockIndex - 1;

	// Count subsequent messages
	const subsequentMsgCount = await db
		.select({ cnt: sql<number>`count(*)` })
		.from(narratorMessageRefs)
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				gt(narratorMessageRefs.seq, targetRef.seq),
			),
		);
	const deletedMessageCount = subsequentMsgCount[0]?.cnt ?? 0;

	const subsequentFilter = and(
		eq(narratorToolCalls.narratorId, narratorId),
		eq(narratorToolCalls.status, "success"),
		gt(narratorMessageRefs.seq, targetRef.seq),
	);
	const subsequentJoin = and(
		eq(narratorMessageRefs.narratorId, narratorId),
		eq(narratorMessageRefs.messageId, narratorToolCalls.messageId),
	);
	const truncatedFilter = and(
		eq(narratorToolCalls.narratorId, narratorId),
		eq(narratorToolCalls.status, "success"),
		inArray(narratorToolCalls.toolUseId, truncatedToolUseIds),
	);

	// Both scopes are described so the dialog can show what each one would do.
	// Every file list comes from the same comparison its rollback performs — deriving
	// one from recorded Write/Edit inputs would omit files touched by Bash or
	// external tools, and promise a scope the rollback does not honour.
	const scopes = await buildRevertScopePreviews(narratorId, targetRef.seq);
	if (scopes) {
		// Count-only: loading the rows to call `.length` would pull every `input_json`,
		// and Write calls carry whole file bodies.
		const [subsequentCount] = await db
			.select({ value: countFn() })
			.from(narratorToolCalls)
			.innerJoin(narratorMessageRefs, subsequentJoin)
			.where(subsequentFilter);
		let truncatedCount = 0;
		if (truncatedToolUseIds.length > 0) {
			const [counted] = await db
				.select({ value: countFn() })
				.from(narratorToolCalls)
				.where(truncatedFilter);
			truncatedCount = counted?.value ?? 0;
		}
		return c.json({
			...scopes,
			toolCallCount: (subsequentCount?.value ?? 0) + truncatedCount,
			deletedBlockCount,
			deletedMessageCount,
		});
	}

	// Find tool calls from subsequent messages (seq > targetRef.seq). Only the replay
	// path needs the recorded inputs, so these stay behind the tree-snapshot branch.
	const subsequentToolCalls = await db
		.select({
			toolUseId: narratorToolCalls.toolUseId,
			toolName: narratorToolCalls.toolName,
			inputJson: narratorToolCalls.inputJson,
			executionDeviceId: narratorToolCalls.executionDeviceId,
			executionCwd: narratorToolCalls.executionCwd,
			executionPathFlavor: narratorToolCalls.executionPathFlavor,
			resolvedFilePath: narratorToolCalls.resolvedFilePath,
			canonicalFilePath: narratorToolCalls.canonicalFilePath,
			runtimeGeneration: narratorToolCalls.runtimeGeneration,
			executionTargetsJson: narratorToolCalls.executionTargetsJson,
		})
		.from(narratorToolCalls)
		.innerJoin(narratorMessageRefs, subsequentJoin)
		.where(subsequentFilter);

	// Find tool calls from truncated blocks in the target message
	const truncatedToolCalls =
		truncatedToolUseIds.length > 0
			? await db.query.narratorToolCalls.findMany({
					where: truncatedFilter,
					columns: {
						toolUseId: true,
						toolName: true,
						inputJson: true,
						executionDeviceId: true,
						executionCwd: true,
						executionPathFlavor: true,
						resolvedFilePath: true,
						canonicalFilePath: true,
						runtimeGeneration: true,
						executionTargetsJson: true,
					},
				})
			: [];

	const allToolCalls = [...truncatedToolCalls, ...subsequentToolCalls];

	let affectedFiles: DeviceFileIdentity[];
	try {
		affectedFiles = getAffectedDeviceFilesStrict(
			allToolCalls,
			await resolveNarratorCwd(narratorId),
		);
	} catch (error) {
		return c.json(fileHistoryConflictBody(error), 409);
	}

	if (affectedFiles.length === 0) {
		return c.json({
			affectedFiles: [],
			toolCallCount: 0,
			deletedBlockCount,
			deletedMessageCount,
		});
	}

	// Only compute willBeDeleted (skip expensive content rebuild for the modal)
	let revertedStates: Map<string, DeviceFileState>;
	try {
		revertedStates = await rebuildDeviceFileStatesExcluding(
			narratorId,
			affectedFiles,
			new Set(allToolCalls.map((tc) => tc.toolUseId)),
		);
	} catch (error) {
		return c.json(fileHistoryConflictBody(error), 409);
	}

	const affectedFilePreviews = affectedFiles.map((identity) => ({
		...identity,
		willBeDeleted: revertedStates.get(deviceFileKey(identity))?.content === null,
	}));

	return c.json({
		affectedFiles: affectedFilePreviews,
		toolCallCount: allToolCalls.length,
		deletedBlockCount,
		deletedMessageCount,
	});
});

/**
 * Preview the files that deleting a single tool_use block would roll back.
 *
 * A block deletion reverses exactly one recorded call, so its preview
 * has to come from the tool-use scope or it would overstate what is removed.
 *
 * Contents are attached because this response also backs the diff view; without
 * them every file renders as an empty change.
 */
narratorRoutes.get("/:id/block-delete-preview", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.query("messageId");
	const blockIndexStr = c.req.query("blockIndex");
	if (!messageId) return c.json({ error: "messageId query param is required" }, 400);
	if (!blockIndexStr) return c.json({ error: "blockIndex query param is required" }, 400);
	const blockIndex = Number.parseInt(blockIndexStr, 10);
	if (Number.isNaN(blockIndex) || blockIndex < 0) {
		return c.json({ error: "blockIndex must be a non-negative integer" }, 400);
	}

	const targetRef = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, narratorId),
			eq(narratorMessageRefs.messageId, messageId),
		),
		columns: { seq: true },
	});
	if (!targetRef) return c.json({ error: "Message not found for this narrator" }, 404);

	const message = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, messageId),
		columns: { contentJson: true },
	});
	if (!message) return c.json({ error: "Message not found" }, 404);

	const blocks = Array.isArray(message.contentJson)
		? (message.contentJson as Array<{ type: string; id?: string }>)
		: [];
	const block = blocks[blockIndex];
	if (!block) return c.json({ error: `Block index ${blockIndex} out of range` }, 400);

	// A non-tool block changes no files, so there is nothing to roll back.
	if (block.type !== "tool_use" || !block.id) {
		return c.json({ available: false, reason: "not_a_tool_use", files: [], conflicts: [] });
	}

	const preview = await previewNarratorScopedForToolUses(
		narratorId,
		[{ messageId, toolUseId: block.id }],
		{ withContents: true },
	);
	return c.json({
		available: preview.available,
		...(preview.reason ? { reason: preview.reason } : {}),
		files: preview.files.map(({ relPath: _relPath, ...file }) => file),
		conflicts: preview.conflicts,
		...(preview.subagentWarning ? { subagentWarning: preview.subagentWarning } : {}),
	});
});

/** Preview file state for a pending Write/Edit permission request */
narratorRoutes.get("/:id/permission-file-preview", async (c) => {
	const narratorId = c.req.param("id");
	const toolUseId = c.req.query("toolUseId");
	if (!toolUseId) return c.json({ error: "toolUseId query param is required" }, 400);

	const toolCall = await db.query.narratorToolCalls.findFirst({
		where: and(
			eq(narratorToolCalls.narratorId, narratorId),
			eq(narratorToolCalls.toolUseId, toolUseId),
		),
		columns: {
			toolUseId: true,
			toolName: true,
			inputJson: true,
			executionDeviceId: true,
			executionCwd: true,
			executionPathFlavor: true,
			resolvedFilePath: true,
			canonicalFilePath: true,
			runtimeGeneration: true,
			executionTargetsJson: true,
			deviceSelectionSource: true,
		},
	});
	if (!toolCall) return c.json({ error: "Tool call not found" }, 404);

	// StructSed records no replayable file identity until it has written, and its pending
	// input is a selector (symbol / address) rather than text. Preview it by re-running the
	// tool's own pipeline as a dry run against the frozen target: that reads the file and
	// resolves the address exactly as the approved call will, and writes nothing.
	if (toolCall.toolName === "StructSed") {
		const input =
			toolCall.inputJson &&
			typeof toolCall.inputJson === "object" &&
			!Array.isArray(toolCall.inputJson)
				? (toolCall.inputJson as Record<string, unknown>)
				: null;
		if (!input) return c.json({ error: "Tool call has no input" }, 400);
		const target = reconstructToolExecutionTarget(toolCall);
		const cwd = target?.cwd ?? (await resolveNarratorCwd(narratorId));
		if (!cwd) return c.json({ error: "Tool call has no working directory" }, 409);
		const outcome = await previewStructSedChange(input, {
			narratorId,
			cwd,
			signal: c.req.raw.signal,
			locale: (await getUserLanguage(c.get("user").sub)) as Locale,
			requestPermission: async () => ({ behavior: "deny", message: "preview only" }),
			...(target ? { executionTarget: target } : {}),
		});
		if ("error" in outcome) {
			return c.json({ error: outcome.error, code: "STRUCT_SED_PREVIEW_FAILED" }, 409);
		}
		return c.json({
			deviceId: target?.deviceId ?? "local",
			filePath: outcome.preview.filePath,
			currentContent: outcome.preview.before,
			previewContent: outcome.preview.after,
			diffHunks: outcome.diff?.hunks ?? [],
			...(outcome.diff?.omittedHunks ? { diffOmittedHunks: outcome.diff.omittedHunks } : {}),
			toolName: toolCall.toolName,
			inputJson: toolCall.inputJson,
		});
	}

	let identity: DeviceFileIdentity | null;
	try {
		identity = getToolCallFileIdentityStrict(toolCall, await resolveNarratorCwd(narratorId));
	} catch (error) {
		return c.json(fileHistoryConflictBody(error), 409);
	}
	if (!identity) return c.json({ error: "Tool call is not a file modification" }, 400);

	let currentContent: string | null;
	try {
		currentContent = await rebuildDeviceFileState(narratorId, identity);
	} catch (error) {
		return c.json(fileHistoryConflictBody(error), 409);
	}

	// Simulate applying this tool call to get preview
	const fakeOrdered = {
		toolUseId,
		toolName: toolCall.toolName,
		inputJson: toolCall.inputJson,
		status: "success",
		messageId: "",
		seq: 0,
		createdAt: "",
	};
	// A diverged replay means this call can no longer be reproduced against the
	// rebuilt baseline. Report it instead of presenting a misleading preview.
	let previewContent: string | null;
	try {
		previewContent = applyToolCall(currentContent, fakeOrdered);
	} catch (error) {
		return c.json(fileHistoryConflictBody(error), 409);
	}
	const executionPlan =
		toolCall.executionTargetsJson &&
		typeof toolCall.executionTargetsJson === "object" &&
		!Array.isArray(toolCall.executionTargetsJson) &&
		Array.isArray((toolCall.executionTargetsJson as { endpoints?: unknown }).endpoints)
			? toolCall.executionTargetsJson
			: null;
	const executionTargets = Array.isArray(toolCall.executionTargetsJson)
		? toolCall.executionTargetsJson
		: executionPlan
			? (executionPlan as { endpoints: Array<{ target?: unknown }> }).endpoints.map(
					(endpoint) => endpoint.target,
				)
			: [];

	return c.json({
		deviceId: identity.deviceId,
		filePath: identity.filePath,
		pathFlavor: identity.pathFlavor,
		identityKey: identity.identityKey,
		executionPathFlavor: toolCall.executionPathFlavor,
		lexicalPath: toolCall.resolvedFilePath,
		canonicalPath: toolCall.canonicalFilePath,
		runtimeGeneration: toolCall.runtimeGeneration,
		executionPlan,
		executionTargets,
		currentContent,
		previewContent,
		toolName: toolCall.toolName,
		inputJson: toolCall.inputJson,
	});
});

// === Background task routes ===

/**
 * GET /api/narrators/:id/background-tasks
 * Cursor page, or a bounded compatibility snapshot for pre-paging clients.
 */
narratorRoutes.get("/:id/background-tasks", async (c) => {
	const parentNarratorId = c.req.param("id");
	const limitRaw = c.req.query("limit");
	const cursor = c.req.query("cursor");
	const limit = limitRaw != null ? Number.parseInt(limitRaw, 10) : undefined;
	const { backgroundTaskService } = await import("../services/background-task-service");
	// Old tabs do not send pagination parameters. Keep their required array shape
	// and active rows without restoring an unbounded full-history query.
	if (limitRaw === undefined && cursor === undefined) {
		return c.json(await backgroundTaskService.listLegacySnapshotByParent(parentNarratorId));
	}
	// In-process liveness (a subagent whose loop is running while its task row is
	// already terminal) is applied inside the service, not here: `activeCount`, the
	// `activeTasks` set, the paged rows and the delta upserts all have to agree, and
	// a route-only overlay left the badge disagreeing with the rows beside it.
	return c.json(
		await backgroundTaskService.listPageByParent(parentNarratorId, {
			cursor,
			limit: limit != null && !Number.isNaN(limit) ? limit : undefined,
		}),
	);
});

/**
 * GET /api/narrators/:id/background-tasks/resolve?target=…
 * Resolve an Await/Send target (task id, alias, or subagent narrator id) to the
 * subagent narrator id. A one-shot lookup so a tool card never has to fetch the
 * whole task list for a single id.
 */
narratorRoutes.get("/:id/background-tasks/resolve", async (c) => {
	const parentNarratorId = c.req.param("id");
	const target = c.req.query("target") ?? "";
	if (!target) throw new ValidationError("target is required");
	const { backgroundTaskService } = await import("../services/background-task-service");
	const subagentNarratorId = await backgroundTaskService.resolveSubagentNarratorId(
		parentNarratorId,
		target,
	);
	return c.json({ subagentNarratorId });
});

/**
 * POST /api/narrators/:id/background-tasks/:taskId/cancel
 * Stop active work represented by a background task card.
 */
narratorRoutes.post("/:id/background-tasks/:taskId/cancel", async (c) => {
	const parentNarratorId = c.req.param("id");
	const taskId = c.req.param("taskId");
	const { backgroundTaskService } = await import("../services/background-task-service");
	const task = await backgroundTaskService.getById(taskId);
	if (task && task.parentNarratorId !== parentNarratorId) {
		return c.json({ error: "Task does not belong to this narrator" }, 403);
	}

	// A transfer's projection row cannot be cancelled on its own: the work lives in
	// the owning `device_transfer_tasks` row, which holds the resume checkpoint. Only
	// cancelling that discards the checkpoint and aborts the in-flight run — marking
	// the projection alone would show "cancelled" while bytes kept moving.
	if (task?.type === "transfer") {
		if (!task.transferTaskId) {
			return c.json({ error: "Transfer task has no owning transfer record" }, 409);
		}
		const { cancelDeviceTransferTaskById } = await import("../services/device-transfer-service");
		const cancelled = await cancelDeviceTransferTaskById(task.transferTaskId);
		if (!cancelled) {
			return c.json({ error: "Transfer is not cancellable" }, 409);
		}
		// The projection follows from the runner's own terminal report, so it is not
		// written here — one owner, one writer.
		return c.json({
			success: true,
			cancelledTask: true,
			interruptedContinuation: false,
			cancelledChildren: 0,
		});
	}

	const subagentId = task?.type === "agent" ? (task.subagentNarratorId ?? task.id) : taskId;
	const subagent = await narratorService.getById(subagentId).catch(() => null);
	if (!task && subagent?.parentNarratorId !== parentNarratorId) {
		return c.json({ error: "Task is not running or does not exist" }, 404);
	}

	let cancelledTask = false;
	if (task?.status === "running") {
		cancelledTask = await backgroundTaskService.cancel(task.id);
	}

	let interruptedContinuation = false;
	const hasActiveContinuation =
		!!subagent &&
		(subagent.status === "working" ||
			subagent.status === "waiting" ||
			isNarratorActive(subagent.id) ||
			isLoopRunning(subagent.id));
	if (subagent && hasActiveContinuation) {
		const { interruptForegroundSubagent } = await import("../services/narrator-subagent");
		interruptedContinuation = interruptForegroundSubagent(subagent.id, { hard: true });
		if (!interruptedContinuation && (isNarratorActive(subagent.id) || isLoopRunning(subagent.id))) {
			interruptedContinuation = interruptNarrator(subagent.id);
		}
	}

	const cancelledChildren = subagent
		? await backgroundTaskService.cancelRunningByParent(subagent.id)
		: 0;

	if (!task && subagent?.isBackground && subagent.backgroundStatus === "running") {
		const { cancelBackgroundTask } = await import("../services/narrator-subagent");
		cancelledTask = await cancelBackgroundTask(subagent.id);
	}

	if (cancelledTask || interruptedContinuation || cancelledChildren > 0) {
		return c.json({
			success: true,
			cancelledTask,
			interruptedContinuation,
			cancelledChildren,
		});
	}

	return c.json({ error: "Task has no active work to stop" }, 404);
});

/**
 * GET /api/narrators/:id/background-tasks/:taskId/output
 * Get full output of a background bash task.
 */
narratorRoutes.get("/:id/background-tasks/:taskId/output", async (c) => {
	const narratorId = c.req.param("id");
	const taskId = c.req.param("taskId");
	const { backgroundTaskService } = await import("../services/background-task-service");
	const task = await backgroundTaskService.getById(taskId);
	if (!task) {
		return c.json({ error: "Task not found" }, 404);
	}
	if (task.parentNarratorId !== narratorId) {
		return c.json({ error: "Task does not belong to this narrator" }, 403);
	}
	return c.json({ output: task.output, status: task.status });
});

/**
 * GET /api/narrators/:id/background-tasks/:taskId/output/tail
 * Bounded tail of a background task's output. While a bash task is still
 * running this serves the live in-memory buffer, so the task panel can poll it
 * for a real-time view without ever materializing the whole output.
 */
narratorRoutes.get("/:id/background-tasks/:taskId/output/tail", async (c) => {
	const narratorId = c.req.param("id");
	const taskId = c.req.param("taskId");
	const requestedChars = Number.parseInt(c.req.query("chars") ?? "", 10);
	const { backgroundTaskService, OUTPUT_TAIL_MAX_CHARS } = await import(
		"../services/background-task-service"
	);
	const task = await backgroundTaskService.getById(taskId);
	if (!task) {
		return c.json({ error: "Task not found" }, 404);
	}
	if (task.parentNarratorId !== narratorId) {
		return c.json({ error: "Task does not belong to this narrator" }, 403);
	}
	const tail = await backgroundTaskService.readOutputTail(
		taskId,
		Number.isFinite(requestedChars) && requestedChars > 0 ? requestedChars : OUTPUT_TAIL_MAX_CHARS,
	);
	if (!tail) {
		return c.json({ error: "Task not found" }, 404);
	}
	return c.json(tail);
});

// ── Whitelist directories ──────────────────────────────────

narratorRoutes.get("/:id/whitelist-dirs", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id); // ensure exists
	const rules = await permissionRuleService.listNarratorRules(id);
	return c.json(rules.directoryWhitelist);
});

narratorRoutes.post("/:id/whitelist-dirs", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const body = await c.req.json();
	const parsed = createWhitelistDirSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const rule = await permissionRuleService.createNarratorRule(id, {
		ruleType: "directoryWhitelist",
		value: parsed.data,
	});
	return c.json(rule, 201);
});

narratorRoutes.patch("/whitelist-dirs/:dirId", async (c) => {
	const dirId = c.req.param("dirId");
	const body = await c.req.json();
	const parsed = updateWhitelistDirSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const existing = await db.query.narratorWhitelistDirs.findFirst({
		where: eq(narratorWhitelistDirs.id, dirId),
	});
	if (!existing) throw new NotFoundError("Whitelist directory", dirId);
	const rule = await permissionRuleService.updateNarratorRule(existing.narratorId, {
		ruleType: "directoryWhitelist",
		value: { ...existing, ...parsed.data, id: dirId },
	});
	return c.json(rule);
});

narratorRoutes.delete("/whitelist-dirs/:dirId", async (c) => {
	const dirId = c.req.param("dirId");
	const existing = await db.query.narratorWhitelistDirs.findFirst({
		where: eq(narratorWhitelistDirs.id, dirId),
		columns: { narratorId: true },
	});
	if (!existing) throw new NotFoundError("Whitelist directory", dirId);
	await permissionRuleService.deleteNarratorRule(existing.narratorId, "directoryWhitelist", dirId);
	return c.json({ ok: true });
});

// ── Blacklist directories ──────────────────────────────────

narratorRoutes.get("/:id/blacklist-dirs", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id); // ensure exists
	const rules = await permissionRuleService.listNarratorRules(id);
	return c.json(rules.directoryBlacklist);
});

narratorRoutes.post("/:id/blacklist-dirs", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const body = await c.req.json();
	const parsed = createBlacklistDirSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const rule = await permissionRuleService.createNarratorRule(id, {
		ruleType: "directoryBlacklist",
		value: parsed.data,
	});
	return c.json(rule, 201);
});

narratorRoutes.patch("/blacklist-dirs/:dirId", async (c) => {
	const dirId = c.req.param("dirId");
	const body = await c.req.json();
	const parsed = updateBlacklistDirSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const existing = await db.query.narratorBlacklistDirs.findFirst({
		where: eq(narratorBlacklistDirs.id, dirId),
	});
	if (!existing) throw new NotFoundError("Blacklist directory", dirId);
	const rule = await permissionRuleService.updateNarratorRule(existing.narratorId, {
		ruleType: "directoryBlacklist",
		value: { ...existing, ...parsed.data, id: dirId },
	});
	return c.json(rule);
});

narratorRoutes.delete("/blacklist-dirs/:dirId", async (c) => {
	const dirId = c.req.param("dirId");
	const existing = await db.query.narratorBlacklistDirs.findFirst({
		where: eq(narratorBlacklistDirs.id, dirId),
		columns: { narratorId: true },
	});
	if (!existing) throw new NotFoundError("Blacklist directory", dirId);
	await permissionRuleService.deleteNarratorRule(existing.narratorId, "directoryBlacklist", dirId);
	return c.json({ ok: true });
});

// ── Command whitelist ──────────────────────────────────────

narratorRoutes.get("/:id/cmd-whitelist", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const rules = await permissionRuleService.listNarratorRules(id);
	return c.json(rules.commandWhitelist);
});

narratorRoutes.post("/:id/cmd-whitelist", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const body = await c.req.json();
	const parsed = createWhitelistCmdSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const rule = await permissionRuleService.createNarratorRule(id, {
		ruleType: "commandWhitelist",
		value: parsed.data,
	});
	return c.json(rule, 201);
});

narratorRoutes.patch("/cmd-whitelist/:entryId", async (c) => {
	const entryId = c.req.param("entryId");
	const body = await c.req.json();
	const parsed = updateWhitelistCmdSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const existing = await db.query.narratorWhitelistCmds.findFirst({
		where: eq(narratorWhitelistCmds.id, entryId),
	});
	if (!existing) throw new NotFoundError("Whitelist command", entryId);
	const rule = await permissionRuleService.updateNarratorRule(existing.narratorId, {
		ruleType: "commandWhitelist",
		value: { ...existing, ...parsed.data, id: entryId },
	});
	return c.json(rule);
});

narratorRoutes.delete("/cmd-whitelist/:entryId", async (c) => {
	const entryId = c.req.param("entryId");
	const existing = await db.query.narratorWhitelistCmds.findFirst({
		where: eq(narratorWhitelistCmds.id, entryId),
		columns: { narratorId: true },
	});
	if (!existing) throw new NotFoundError("Whitelist command", entryId);
	await permissionRuleService.deleteNarratorRule(existing.narratorId, "commandWhitelist", entryId);
	return c.json({ ok: true });
});

// ── Command blacklist ──────────────────────────────────────

narratorRoutes.get("/:id/cmd-blacklist", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const rules = await permissionRuleService.listNarratorRules(id);
	return c.json(rules.commandBlacklist);
});

narratorRoutes.post("/:id/cmd-blacklist", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const body = await c.req.json();
	const parsed = createBlacklistCmdSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const rule = await permissionRuleService.createNarratorRule(id, {
		ruleType: "commandBlacklist",
		value: parsed.data,
	});
	return c.json(rule, 201);
});

narratorRoutes.patch("/cmd-blacklist/:entryId", async (c) => {
	const entryId = c.req.param("entryId");
	const body = await c.req.json();
	const parsed = updateBlacklistCmdSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const existing = await db.query.narratorBlacklistCmds.findFirst({
		where: eq(narratorBlacklistCmds.id, entryId),
	});
	if (!existing) throw new NotFoundError("Blacklist command", entryId);
	const rule = await permissionRuleService.updateNarratorRule(existing.narratorId, {
		ruleType: "commandBlacklist",
		value: { ...existing, ...parsed.data, id: entryId },
	});
	return c.json(rule);
});

narratorRoutes.delete("/cmd-blacklist/:entryId", async (c) => {
	const entryId = c.req.param("entryId");
	const existing = await db.query.narratorBlacklistCmds.findFirst({
		where: eq(narratorBlacklistCmds.id, entryId),
		columns: { narratorId: true },
	});
	if (!existing) throw new NotFoundError("Blacklist command", entryId);
	await permissionRuleService.deleteNarratorRule(existing.narratorId, "commandBlacklist", entryId);
	return c.json({ ok: true });
});

// ── Optional tools ───────────────────────────────────────────────────────────

/**
 * Whether one optional tool is currently visible to the model for this narrator.
 * Used by tool panels (e.g. the Browser dock) to offer a one-click load button
 * when the session has no such tool yet.
 */
narratorRoutes.get("/:id/optional-tools/:toolId", async (c) => {
	const id = c.req.param("id");
	const toolId = c.req.param("toolId");
	await narratorService.getById(id); // 404 if missing

	const routine = getBuiltinToolRoutines().find((r) => r.id === toolId && r.tool);
	if (!routine?.tool) throw new NotFoundError("OptionalTool", toolId);

	// A routine can control several registry tools; the tool is only fully
	// available once every one of them resolves as loaded.
	const toolNames = getBuiltinToolNames(routine.tool);
	const states = await Promise.all(
		toolNames.map((toolName) => resolveOptionalToolState(id, toolName, c.get("user").sub)),
	);
	const disabledByTrait = states.some((s) => s.state === "disabled_by_trait");
	const loaded = !disabledByTrait && states.every((s) => s.state === "loaded");

	return c.json({
		toolId,
		toolNames,
		loaded,
		disabledByTrait,
		globallyEnabled: states.every((s) => s.globallyEnabled),
	});
});

/** Load an optional tool into the session — same effect as `/load <toolId>`. */
narratorRoutes.post("/:id/optional-tools/:toolId/load", async (c) => {
	const id = c.req.param("id");
	const toolId = c.req.param("toolId");
	const userId = c.get("user").sub;
	await narratorService.getById(id); // 404 if missing

	const routine = getBuiltinToolRoutines().find((r) => r.id === toolId && r.tool);
	if (!routine?.tool) throw new NotFoundError("OptionalTool", toolId);

	const toolNames = getBuiltinToolNames(routine.tool);
	const locale = await getUserLanguage(userId);
	// Reuse the slash-command handler so admin gating, trait deny-lists, the
	// display message and the model-visible notice all behave identically.
	const result = await handleLoadToolCommand(
		id,
		{
			resolved: true,
			loadTool: routine.tool.toolName,
			...(toolNames.length > 1 ? { loadTools: toolNames, loadToolId: routine.id } : {}),
			rawCommand: `/load ${toolId}`,
		},
		locale,
		userId,
	);
	return c.json(result);
});

// ── Browser sessions ─────────────────────────────────────────────────────────

narratorRoutes.get("/:id/browser-sessions", (c) => {
	const narratorId = c.req.param("id");
	const sessions = listBrowserSessions(narratorId);
	return c.json(sessions.map((s) => ({ ...s, viewport: DEFAULT_VIEWPORT })));
});

narratorRoutes.patch("/:id/browser-sessions/:sessionId/ttl", async (c) => {
	const narratorId = c.req.param("id");
	const sessionId = c.req.param("sessionId");
	const body = await c.req.json().catch(() => ({}));
	const ttlMs = Number((body as { ttlMs?: unknown }).ttlMs);
	if (!Number.isFinite(ttlMs) || !Number.isInteger(ttlMs)) {
		throw new ValidationError("ttlMs must be an integer number of milliseconds");
	}
	if (ttlMs < MIN_SESSION_TTL_MS || ttlMs > MAX_SESSION_TTL_MS) {
		throw new ValidationError(
			`ttlMs must be between ${MIN_SESSION_TTL_MS} and ${MAX_SESSION_TTL_MS}`,
		);
	}
	const session = setBrowserSessionTtl(narratorId, sessionId, ttlMs);
	if (!session) throw new NotFoundError("BrowserSession", sessionId);
	return c.json({
		ok: true,
		session: {
			id: session.id,
			url: session.page.url(),
			lastActivity: session.lastActivity,
			ttlMs: session.ttlMs,
			expiresAt: session.lastActivity + session.ttlMs,
			headless: session.headless,
			tracing: session.tracing
				? { active: session.tracing.active, startedAt: session.tracing.startedAt }
				: null,
			networkRequestCount: session.networkRequests.length,
			networkCaptureEnabled: session.networkCaptureEnabled,
		},
	});
});

narratorRoutes.delete("/:id/browser-sessions/:sessionId", async (c) => {
	const narratorId = c.req.param("id");
	const sessionId = c.req.param("sessionId");

	// Check if tracing was active before closing — we need to notify the model
	const session = getBrowserSession(narratorId, sessionId);
	const hadTracing = session?.tracing?.active ?? false;

	const closed = await closeBrowserSession(narratorId, sessionId);
	if (!closed) throw new NotFoundError("BrowserSession", sessionId);

	if (hadTracing) {
		const text =
			`[System] Browser session ${sessionId} was closed by the user while performance tracing was active. ` +
			`The trace data was discarded. If you need a trace, start a new session and recording.`;
		const msg = await narratorService.persistSystemMessage(narratorId, text);
		broadcastToNarrator(narratorId, {
			type: "message",
			narratorId,
			message: {
				id: msg.id,
				narratorId,
				role: "sys",
				contentJson: msg.contentJson,
				contentText: msg.contentText,
				createdAt: msg.createdAt,
				children: [],
			},
		});
	}

	return c.json({ ok: true });
});

/**
 * Capture a screenshot as a PNG response.
 *
 * Chrome can refuse to produce a frame (occluded headed window, lost GPU surface, wedged target).
 * That is an upstream browser condition, not a server bug, so it is reported as 502 with a readable
 * message instead of bubbling up as an anonymous 500 plus a stack trace in the logs.
 */
async function browserScreenshotResponse(session: BrowserSessionType): Promise<Response> {
	let result: Awaited<ReturnType<typeof browserScreenshot>>;
	try {
		result = await browserScreenshot(session);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn("Browser screenshot capture failed", {
			narratorId: session.narratorId,
			sessionId: session.id,
			error: message.slice(0, 300),
		});
		return Response.json(
			{ error: `Browser screenshot failed: ${message}`, code: "BROWSER_SCREENSHOT_FAILED" },
			{ status: 502 },
		);
	}
	const buffer = Buffer.from(result.base64, "base64");
	return new Response(buffer, {
		headers: {
			"Content-Type": "image/png",
			"Cache-Control": "no-store",
		},
	});
}

narratorRoutes.get("/:id/browser-sessions/:sessionId/screenshot", async (c) => {
	const narratorId = c.req.param("id");
	const sessionId = c.req.param("sessionId");
	const session = getBrowserSession(narratorId, sessionId);
	if (!session) throw new NotFoundError("BrowserSession", sessionId);
	return browserScreenshotResponse(session);
});

narratorRoutes.post("/:id/browser-sessions/:sessionId/interact", async (c) => {
	const narratorId = c.req.param("id");
	const sessionId = c.req.param("sessionId");
	const session = getBrowserSession(narratorId, sessionId);
	if (!session) throw new NotFoundError("BrowserSession", sessionId);

	const rawBody = await c.req.json().catch(() => ({}));
	const parsed = browserInteractSchema.safeParse(rawBody);
	if (!parsed.success) {
		return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid interact request" }, 400);
	}
	const { action, coordinate, endCoordinate, direction, amount, text, key, keys } = parsed.data;

	const { page } = session;

	switch (action) {
		case "click":
			await browserClick(session, "", { coordinate });
			break;
		case "scroll": {
			const scrollDirection = direction ?? "down";
			const scrollAmount = amount ?? 300;
			await browserScroll(session, {
				direction: scrollDirection,
				amount: scrollAmount,
				coordinate,
			});
			break;
		}
		case "drag": {
			// Presence of coordinate/endCoordinate is guaranteed by the schema.
			if (!coordinate || !endCoordinate) break;
			touchSessionVisual(session);
			await page.mouse.move(coordinate.x, coordinate.y);
			await page.mouse.down();
			await page.mouse.move(endCoordinate.x, endCoordinate.y, { steps: 10 });
			await page.mouse.up();
			break;
		}
		case "type": {
			if (keys) {
				// Batch: execute a sequence of key/text inputs in order
				for (const item of keys) {
					if (item.key) {
						await browserType(session, { key: item.key });
					} else if (item.text) {
						await browserType(session, { value: item.text });
					}
				}
			} else {
				await browserType(session, { value: text, key });
			}
			break;
		}
	}

	// Return fresh screenshot after the interaction
	return browserScreenshotResponse(session);
});

narratorRoutes.post("/:id/browser-sessions/:sessionId/stop-tracing", async (c) => {
	const narratorId = c.req.param("id");
	const sessionId = c.req.param("sessionId");
	const stopped = await stopBrowserTracing(narratorId, sessionId);
	if (!stopped) throw new NotFoundError("BrowserSession", sessionId);

	// Inject a system message so the model knows tracing was stopped externally
	const text =
		`[System] Performance tracing on browser session ${sessionId} was stopped by the user from the management panel. ` +
		`The trace data was discarded. If you need a trace, start a new recording with perf_start.`;
	const msg = await narratorService.persistSystemMessage(narratorId, text);
	broadcastToNarrator(narratorId, {
		type: "message",
		narratorId,
		message: {
			id: msg.id,
			narratorId,
			role: "sys",
			contentJson: msg.contentJson,
			contentText: msg.contentText,
			createdAt: msg.createdAt,
			children: [],
		},
	});

	return c.json({ ok: true });
});
