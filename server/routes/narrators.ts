import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { formatOriginLabel } from "@shared/message-origin";
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
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { db } from "../db";
import {
	apiRequests,
	chapters,
	containerInstances,
	narratorBlacklistCmds,
	narratorBlacklistDirs,
	narratorFileSnapshots,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	narratorWhitelistCmds,
	narratorWhitelistDirs,
	projects,
	terminals,
	users,
} from "../db/schema";
import { takeOverExitPlanReflection } from "../lib/agent/tools/exit-plan-reflection";
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
import { isInsidePath } from "../lib/platform-path";
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
import { FOLLOW_DEFAULT_MODEL, getQueueDuringCompaction, settings } from "../lib/settings";
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
	browserInteractSchema,
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
	migrateBrokenModelNarratorsSchema,
	narratorExportQuerySchema,
	narratorGrantCreateSchema,
	narratorGrantUpdateSchema,
	narratorTransferOwnerSchema,
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
	updateBufferedMessageSchema,
	updateNarratorCwdSchema,
	updateNarratorDraftSchema,
	updateNarratorHandleSchema,
	updateNarratorModelSchema,
	updateNarratorTitleSchema,
	updateSegmentCompactSummarySchema,
	updateWhitelistCmdSchema,
	updateWhitelistDirSchema,
} from "../lib/validators";
import { requireAdmin } from "../middleware/auth";
import { generateAskUserQuestionAnswers } from "../services/ask-user-question-reflection";
import {
	hasBrokenModelMigrationUndo,
	migrateBrokenModelNarrators,
	scanBrokenModelNarrators,
	undoLastBrokenModelMigration,
} from "../services/broken-model-migration-service";
import { chapterFork } from "../services/chapter-fork";
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
import { dependencyService } from "../services/dependency-service";
import {
	browseRemoteDirectory,
	resolveRemoteBrowseTarget,
} from "../services/device-transfer-service";
import { normalizePathKey, type PathFlavor, pathKeyContains } from "../services/execution-policy";
import {
	applyToolCall,
	buildCanonicalIdentityAliases,
	canonicalizeDeviceFileIdentity,
	canonicalizeDeviceFileIdentityWith,
	type DeviceFileIdentity,
	type DeviceFileState,
	deviceFileKey,
	FileHistoryError,
	getAffectedDeviceFilesStrict,
	getToolCallFileIdentityStrict,
	groupByDeviceFileStrict,
	queryOrderedToolCalls,
	rebuildDeviceFileState,
	rebuildDeviceFileStatesExcluding,
	rebuildDeviceFileStatesUpToSeq,
} from "../services/file-state-rebuild";
import { gitService } from "../services/git-service";
import { getStatusSummaryCached } from "../services/git-status-cache";
import { filterReadableNarrators, narratorReadableWhere } from "../services/narrator-acl";
import {
	deleteBufferedTextFile,
	loadBufferedTextFiles,
	persistAdditionalBufferedTextFiles,
} from "../services/narrator-buffer";
import {
	getNarratorDraft,
	getNarratorIdsWithDraft,
	narratorHasDraft,
	updateNarratorDraft,
} from "../services/narrator-draft-service";
import { buildExportFileName, streamNarratorExport } from "../services/narrator-export";
import {
	countNarratorMessageRefs,
	countNarratorMessageRefsBatch,
} from "../services/narrator-message-count";
import {
	disarmQuestionReflection,
	getQuestionReflectionDeadline,
	reflectPendingAskUserQuestion,
	resolveDecisionNarratorId,
	stopDangerReflectionLoop,
	takeOverQuestionReflection,
} from "../services/narrator-permission";
import { enterNarratorPlanMode, exitNarratorPlanMode } from "../services/narrator-plan-mode";
import { resolveLazyLineage } from "../services/narrator-refs-backfill";
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
	awaitCompactCompletion,
	type BufferCreator,
	cancelCompact,
	cancelPendingExitPlanMode,
	clearBufferedMessageSoftStopIfIdle,
	clearBufferedMessages,
	closeNarrator,
	continueNarrator,
	editAndRegenerate,
	editAssistantMessage,
	getBufferedMessages,
	getNarratorExecutionDeviceState,
	interruptAndWaitForIdle,
	interruptNarrator,
	isCompactInProgress,
	isLoopRunning,
	isNarratorActive,
	normalizeRollbackBlockIndexForMessage,
	persistGoalAddedNotice,
	pushBufferedMessage,
	reconcileRunningStatus,
	reExecuteDeniedToolCall,
	removeBufferedMessage,
	reorderBufferedMessages,
	reprocessAllPendingPermissions,
	requestBufferedMessageSoftStop,
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
	updateActiveNarratorCwdAndSkillContext,
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
} from "../services/narrator-session-state";
import {
	getNarratorAccess,
	grantNarratorAccess,
	revokeNarratorGrant,
	setNarratorVisibility,
	setNarratorWriteAudience,
	transferNarratorOwner,
	updateNarratorGrant,
} from "../services/narrator-sharing";
import type { SubagentBufferedMessage } from "../services/narrator-subagent";
import {
	buildRecoveryNotifyPrompt,
	markRecoveryCardResolved,
	resumeIncompleteAgentWorkForContinue,
	resumeRecoverySubagents,
	startRecoveryAwaitBatch,
} from "../services/narrator-subagent-recovery";
import { generateTitle, persistTitle } from "../services/narrator-title";
import { permissionRuleService } from "../services/permission-rule-service";
import { searchService } from "../services/search-service";
import { skillService } from "../services/skill-service";
import {
	applyDeviceFileStates,
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
	revertPatchForToolUses,
} from "../services/snapshot-revert";
import { broadcastSpecChanged } from "../services/spec-broadcast";
import { appendProtectedSpecTask } from "../services/spec-vfs-service";
import { resolveStandaloneNarratorCwd } from "../services/standalone-narrator-cwd";
import { resumeSubagent, withSubagentResumeLock } from "../services/subagent-resume";
import { broadcastSubagentTakeoverChanged } from "../services/subagent-takeover-broadcast";
import { usageHistoryService } from "../services/usage-history-service";
import { syncNarratorDraftToRecentTabs } from "../services/user-preferences-service";
import {
	broadcastToNarrator,
	broadcastToUser,
	getNarratorIdsWithPresence,
	getNarratorPresenceBatch,
} from "../websocket/narrator-ws";

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
): Promise<{ message: string; images: ImageRef[]; textFiles: File[]; priority?: boolean }> {
	const contentType = c.req.header("content-type") ?? "";
	if (contentType.includes("multipart/form-data")) {
		const formData = await c.req.formData();
		const rawMessage = formData.get("message");
		const message = typeof rawMessage === "string" ? rawMessage : "";
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
		if (!message.trim() && imageFiles.length === 0 && textFileEntries.length === 0) {
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
		return { message, images, textFiles: textFileEntries, priority: priority || undefined };
	}
	const body = await c.req.json();
	const parsed = sendMessageSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return {
		message: parsed.data.message,
		images: [],
		textFiles: [],
		priority: parsed.data.priority,
	};
}

export const narratorRoutes = new Hono();

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
const READ_ONLY_WRITE_SUBPATHS = new Set(["leave"]);

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
	return next();
});

// The bare `/:id` routes are not covered by the `/:id/*` pattern above.
narratorRoutes.use("/:id", async (c, next) => {
	const id = c.req.param("id");
	if (!id || NARRATOR_ID_GATE_EXEMPT_SEGMENTS.has(id)) return next();
	await requireNarratorAccess(c, id, c.req.method === "GET" ? "read" : "write");
	return next();
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

	if (standalone === "true" || standalone === "all") {
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
				.where(sql`${containerInstances.chapterId} IN ${chapterIds}`)
				.groupBy(containerInstances.chapterId);
			for (const row of containerRows) {
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
	const hasDraft = await narratorHasDraft(c.get("user").sub, id);
	const runtimeModel = getNarratorRuntimeModel(id, narrator.model?.trim() || FOLLOW_DEFAULT_MODEL);
	// The stored counter is only refreshed when a turn ends, so a narrator that has
	// not run since the turn-count → message-count change would still report the old
	// value here. One narrator's refs are cheap to count exactly (an indexed count(*)),
	// unlike the list endpoint where it would mean one subquery per row.
	const messageCount = await countNarratorMessageRefs(id);
	return c.json({
		...publicNarratorResponse(narrator, hasDraft),
		messageCount,
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

narratorRoutes.post("/:id/transfer-owner", async (c) => {
	const parsed = narratorTransferOwnerSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(
		await transferNarratorOwner(c.req.param("id"), parsed.data.userId, narratorPrincipalOf(c)),
	);
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

	const { message, images, textFiles, priority } = await parseMessageRequest(c, id);
	const userId = c.get("user").sub;
	const queuedNewCommand = parseNewCommand(message);

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
		const result = await handleBlockAllSkillsCommand(id, cmdResult as BlockAllSkillsResult, locale);
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

	// Extract model override from resolved command (if any)
	const modelOverride =
		cmdResult.resolved && "command" in cmdResult ? cmdResult.command.modelOverride : undefined;

	// Busy = DB status says running OR a loop is actually running in memory. The
	// in-memory check is authoritative: it catches the case where the DB status
	// went stale to idle while the loop was still draining, which would otherwise
	// let this message start a second concurrent loop instead of being buffered.
	let narratorBusy =
		narrator.status === "working" || narrator.status === "waiting" || isLoopRunning(id);

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
			narrator.status === "working" || narrator.status === "waiting" || isLoopRunning(id);
	}

	if (queuedNewCommand && !narratorBusy) {
		const currentCwd = narrator.cwd ?? undefined;
		const newNarrator = await narratorService.create({
			chapterId: null,
			model: narrator.model ?? undefined,
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

			const { bufferSubagentUserMessage, getSubagentBufferedMessages, isTakenOver } = await import(
				"../services/narrator-subagent"
			);
			const takenOver = isTakenOver(id);
			const result = bufferSubagentUserMessage(id, finalMessage, {
				images: images.length > 0 ? images : undefined,
				textFiles: textFiles.length > 0 ? textFiles : undefined,
				commandText,
				createdBy: userId,
				prePromptBashCommand,
				priority,
				requestSoftStop: !takenOver,
			});
			if (!result.ok) {
				if (result.full) throw new ValidationError("Message queue is full");
				throw new ValidationError("Subagent is not running in foreground");
			}
			const messages = toBufferSummary(getSubagentBufferedMessages(id));
			broadcastToNarrator(id, {
				type: "buffer_set",
				narratorId: id,
				messages,
			});
			return c.json({ buffered: true, bufferedAt: result.bufferedAt, id: result.id }, 202);
		}

		// Primary narrator: push onto buffer queue (or unshift if priority).
		// If the DB status was stale-idle while a loop is actually running, correct
		// it so the user regains the interrupt button instead of being stuck.
		await reconcileRunningStatus(id);
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
		const result = await pushBufferedMessage(
			id,
			finalMessage,
			images.length > 0 ? images : undefined,
			commandText,
			userId,
			creator,
			textFiles.length > 0 ? textFiles : undefined,
			priority ? "front" : undefined,
			prePromptBashCommand,
		);
		if (result.ok) {
			const messages = toBufferSummary(getBufferedMessages(id));
			broadcastToNarrator(id, {
				type: "buffer_set",
				narratorId: id,
				messages,
			});
			// Priority messages should cut in at the next safe model-request boundary without
			// aborting running tools. The loop soft-stops after current tools complete, then
			// consumes the front of the buffer as the next request.
			if (priority) {
				requestBufferedMessageSoftStop(id);
			}
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
		if (result.full) {
			throw new ValidationError("Message queue is full");
		}
		// The queue refused this message. Falling through to a normal send is only
		// correct when the narrator turned out NOT to be busy after all — the
		// legitimate case is a zombie `working`/`waiting` row whose writer is gone,
		// which `reconcileRunningStatus` above has just repaired to idle.
		//
		// If a runtime owner still exists, falling through would start a second agent
		// loop next to the live one. `feedMessage`'s own guard cannot catch that: it
		// tests `active._loopRunning`, and a loop-less owner (planned-update recovery,
		// a subagent recovery stage, the recovery Await batch) has no `activeNarrators`
		// entry at all, so `ensureNarrator` hands back a fresh session whose flag is
		// false. That is exactly how a post-update restart ended up talking over its
		// own still-running subagent.
		if (isNarratorRuntimeBusy(id)) {
			logger.warn("Refused to send while a loop-less runtime owner holds the narrator", {
				narratorId: id,
			});
			throw new ValidationError("Narrator is busy; the message could not be queued");
		}
		// No runtime owner: the busy status was stale. Fall through to a normal send.
	}

	const locale = await getUserLanguage(userId);
	const replyInUserLanguage = await getUserReplyInLanguage(userId);

	// Apply model override from slash command before sending
	if (modelOverride?.model) {
		if (modelOverride.mode === "temporary") {
			// Persist the original model so it can be restored after the turn
			// (survives server restarts). Must be written before sendMessage to
			// avoid a race with the agent loop's finally block.
			await setTemporaryModelRestore(id, narrator.model ?? "__default__");
		}
		// Switch model in DB (sendMessage → ensureNarrator reads from DB)
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
			images: images.length > 0 ? images : undefined,
			textFiles: textFiles.length > 0 ? textFiles : undefined,
			commandText,
			createdBy: userId,
			locale,
		});
		if (modelOverride?.model) {
			updateNarratorModel(id, modelOverride.model);
		}
		return c.json(resumed.userMessage ?? { ok: true }, 201);
	}

	// prePromptBashCommand (runBashFirst) is passed to sendMessage so the order is:
	// user prompt message → Bash tool card → model reply (handled inside feedMessage).
	const userMsg = await sendMessage(
		id,
		finalMessage,
		images,
		locale,
		replyInUserLanguage,
		commandText,
		userId,
		textFiles,
		prePromptBashCommand,
	);

	// Broadcast model change to frontend (ensureNarrator already picked up the new model from DB)
	if (modelOverride?.model) {
		updateNarratorModel(id, modelOverride.model);
	}

	return c.json(userMsg, 201);
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

// Edit a user message and regenerate the response.
// Supports JSON (text-only / keep-image-subset) and multipart/form-data (when the
// user adds new images during editing).
narratorRoutes.post("/:id/edit-and-regenerate/:messageId", async (c) => {
	const id = c.req.param("id");
	const messageId = c.req.param("messageId");

	let content: string;
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

	// Editing a message truncates everything after it and regenerates, so the running
	// turn is exactly what the user is replacing. Interrupt it for them rather than
	// refusing and asking them to press Stop first.
	await prepareHistoryRewrite(id);

	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const userId = c.get("user").sub;
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
		keepImageIds,
		newImages: newImages.length > 0 ? newImages : undefined,
		keepTextFilePaths,
		newTextFiles: newTextFiles.length > 0 ? newTextFiles : undefined,
		userId,
		revertFiles,
		...(scope ? { revertScope: scope } : {}),
	});
	return c.json(result);
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
	return c.json(result);
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
	return c.json(result);
});

/**
 * Resolve the authoritative buffer queue for a narrator.
 *
 * Primary narrators and subagents keep their queues in two separate in-memory
 * maps, so every buffer read must check both. Only one of them can be non-empty
 * for a given narrator.
 */
async function resolveBufferQueue(narratorId: string) {
	const messages = toBufferSummary(getBufferedMessages(narratorId));
	if (messages.length > 0) return messages;
	const { getSubagentBufferedMessages } = await import("../services/narrator-subagent");
	return toBufferSummary(getSubagentBufferedMessages(narratorId));
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

/** One queued message plus which of the two queues it lives in. */
interface LocatedBufferedMessage {
	message: BufferedMessage | SubagentBufferedMessage;
	/** True when it came from the taken-over-subagent map (in-memory, no DB). */
	fromSubagentQueue: boolean;
}

/** Find a queued message by id, checking the primary queue then the subagent queue. */
async function locateBufferedMessage(
	narratorId: string,
	messageId: string,
): Promise<LocatedBufferedMessage | null> {
	const primary = getBufferedMessages(narratorId).find((m) => m.id === messageId);
	if (primary) return { message: primary, fromSubagentQueue: false };
	const { getSubagentBufferedMessages } = await import("../services/narrator-subagent");
	const subagent = getSubagentBufferedMessages(narratorId).find((m) => m.id === messageId);
	if (subagent) return { message: subagent, fromSubagentQueue: true };
	return null;
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
	if (!located.fromSubagentQueue) {
		const saved = (located.message as BufferedMessage)._savedFiles;
		if (saved?.length) return saved.map((file) => file.filename);
	}
	return (located.message.textFiles ?? []).map((file) => file.name);
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
	const finalImageCount = keptImages.length + newImageFiles.length;
	const finalTextFileCount = keptTextFileIndexes.length + newTextFiles.length;
	if (!text && finalImageCount === 0 && finalTextFileCount === 0) {
		throw new ValidationError("Message cannot be empty");
	}

	// The kept halves, resolved before anything is written so the compensating
	// deletes below know exactly which old files this edit orphans.
	const currentSavedFiles = located.fromSubagentQueue
		? []
		: ((located.message as BufferedMessage)._savedFiles ?? []);
	const currentTextFiles = located.message.textFiles ?? [];
	const keptSavedFiles = currentSavedFiles.filter((_, index) =>
		keptTextFileIndexes.includes(index),
	);
	const keptTextFileObjects = located.fromSubagentQueue
		? currentTextFiles.filter((_, index) => keptTextFileIndexes.includes(index))
		: loadBufferedTextFiles(keptSavedFiles);
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

		let ok: boolean;
		if (located.fromSubagentQueue) {
			const { updateSubagentBufferedMessage } = await import("../services/narrator-subagent");
			ok = updateSubagentBufferedMessage(id, mid, text, {
				images: [...keptImages, ...newImages],
				textFiles: [...keptTextFileObjects, ...newTextFiles],
			});
		} else {
			// New files join the message's existing directory; reserving the kept
			// names stops an upload from overwriting an attachment being kept.
			createdSavedFiles = newTextFiles.length
				? await persistAdditionalBufferedTextFiles(
						mid,
						newTextFiles,
						keptSavedFiles.map((file) => file.filename),
					)
				: [];
			const savedFiles = [...keptSavedFiles, ...createdSavedFiles];
			ok = updateBufferedMessage(id, mid, text, {
				images: [...keptImages, ...newImages],
				textFiles: loadBufferedTextFiles(savedFiles),
				savedFiles,
			});
		}
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

// Remove a single queued buffered message
narratorRoutes.delete("/:id/buffer/:mid", async (c) => {
	const id = c.req.param("id");
	const mid = c.req.param("mid");
	let ok = removeBufferedMessage(id, mid);
	if (ok) {
		// Cancelling the message that requested a post-tool cut-in must also drop the
		// pending soft stop, otherwise the running turn would end at the next tool
		// boundary with nothing left to resume.
		clearBufferedMessageSoftStopIfIdle(id);
	} else {
		// Fallback: subagent queue. removeSubagentBufferedMessage drops the
		// subagent soft stop itself once the queue empties.
		const { removeSubagentBufferedMessage } = await import("../services/narrator-subagent");
		ok = removeSubagentBufferedMessage(id, mid);
	}
	if (!ok) throw new NotFoundError("Buffered message", mid);
	await broadcastBufferQueue(id);
	return c.json({ ok: true });
});

// Reorder queued buffered messages
narratorRoutes.put("/:id/buffer/reorder", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json();
	const parsed = reorderBufferSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	let ok = reorderBufferedMessages(id, parsed.data.orderedIds);
	if (!ok) {
		const { reorderSubagentBufferedMessages } = await import("../services/narrator-subagent");
		ok = reorderSubagentBufferedMessages(id, parsed.data.orderedIds);
	}
	if (!ok) throw new ValidationError("Invalid reorder: ids do not match the current queue");
	await broadcastBufferQueue(id);
	return c.json({ ok: true });
});

// Clear entire buffer queue
narratorRoutes.delete("/:id/buffer", async (c) => {
	const id = c.req.param("id");
	clearBufferedMessages(id);
	clearBufferedMessageSoftStopIfIdle(id);
	// Also clear the subagent queue (mirrors the cancel_buffer WS path); a
	// taken-over subagent's queue lives in a separate map.
	const { clearSubagentBufferedMessages } = await import("../services/narrator-subagent");
	clearSubagentBufferedMessages(id);
	broadcastToNarrator(id, { type: "buffer_set", narratorId: id, messages: [] });
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
	// Read the prune metadata AFTER the page, never concurrently.
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
		columns: { pruneBoundaryMessageId: true, prunedPercent: true, messageVersion: true },
	});
	if (!narratorMeta) throw new NotFoundError("Narrator", id);
	if (narratorMeta.messageVersion !== result.messageVersion)
		throw new AppError(
			"Narrator prune metadata changed while the exact-layout page was being built",
			409,
			"PRETEXT_DOCUMENT_CHANGED",
		);
	return c.json({
		...result,
		pruneBoundaryMessageId: narratorMeta.pruneBoundaryMessageId ?? null,
		prunedPercent: narratorMeta.prunedPercent ?? null,
	});
});

// Resolve a message id to the document coordinate the exact-layout list jumps to.
narratorRoutes.get("/:id/message-location/:messageId", async (c) => {
	const id = c.req.param("id");
	const messageId = c.req.param("messageId");
	const location = await narratorService.getMessageLocation(id, messageId);
	return c.json(location);
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
	const results = searchService.searchNarratorMessages(
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

// Get full tool call detail (untruncated inputJson/outputJson)
narratorRoutes.get("/:id/tool-calls/:toolUseId", async (c) => {
	const id = c.req.param("id");
	const toolUseId = c.req.param("toolUseId");
	const tc = await narratorService.getToolCallDetail(id, toolUseId);
	return c.json(tc);
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
	const result = await retryFailedCompact(narratorId, locale, messageId, body.model);
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
	runCustomCompact(narratorId, locale, beforeMessageId).catch((err) => {
		logger.error("Manual compact failed", { narratorId, err: String(err) });
	});
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

	runSegmentCompact(narratorId, locale, messageIds).catch((err) => {
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
	if (interruptNarrator(id)) interrupted = true;
	if (!interrupted) {
		// Fallback: the UI Stop button should hard-stop foreground/background subagents.
		// The soft foreground interrupt is still used by Send({ doInterrupt: true }).
		const { cancelBackgroundTask, interruptForegroundSubagent, isTakenOver } = await import(
			"../services/narrator-subagent"
		);
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
	if (!interrupted) {
		const narrator = await narratorService.getById(id);
		if (narrator.status === "working" || narrator.status === "waiting") {
			await narratorService.updateStatus(id, "idle", { substatus: ["interrupted"] });
			interrupted = true;
		}
	}
	return c.json({ interrupted });
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

// Take over a running subagent. The user assumes direct control of the subagent
// (send/interrupt/queue/continue like an independent narrator) while the parent
// tool call stays blocked ("user is operating"). For foreground subagents the
// current turn is hard-interrupted into the takeover-flavored suspension; for
// background subagents the loop is interrupted and the task leaves background
// mode without being marked completed/failed.
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

		const {
			getForegroundAbortControllers,
			getBackgroundAbortControllers,
			interruptForegroundSubagent,
			markPendingTakeover,
			markTakenOver,
		} = await import("../services/narrator-subagent");

		// Foreground subagent: soft-interrupt the current turn. A soft interrupt
		// stops the turn at a safe boundary and lets runForegroundLoop fall through
		// to the suspension branch, where it consumes the pending-takeover marker
		// and enters the taken_over state while keeping the parent tool call blocked.
		// (A hard interrupt would instead end the subagent immediately.)
		if (getForegroundAbortControllers().has(id)) {
			// Mark taken over immediately so isTakenOver() is visible to the frontend
			// and stop-takeover even before the loop reaches the suspension branch.
			// pendingTakeover tells runForegroundLoop to use the taken_over substatus.
			markPendingTakeover(id);
			markTakenOver(id);
			const interrupted = interruptForegroundSubagent(id);
			if (!interrupted) {
				// Could not interrupt (race) — clear state to avoid a stale takeover.
				const { clearPendingTakeover, clearTakenOver } = await import(
					"../services/narrator-subagent"
				);
				clearPendingTakeover(id);
				clearTakenOver(id);
				return c.json({ error: "Failed to take over subagent" }, 400);
			}
			// Reflect the taken_over substatus immediately (the loop will also set it).
			await narratorService.addSubstatus(id, "taken_over").catch(() => {});
			broadcastToNarrator(narrator.parentNarratorId, {
				type: "subagent_status_changed",
				narratorId: narrator.parentNarratorId,
				subagentNarratorId: id,
				status: narrator.status,
				substatus: [...parseSubstatus(narrator.substatus), "taken_over"],
			});
			// The blocked parent CARD is a separate consumer from the panel's status
			// chip — without this the tool call keeps rendering as plain "running".
			await broadcastSubagentTakeoverChanged({
				parentNarratorId: narrator.parentNarratorId,
				subagentNarratorId: id,
				takenOver: true,
			});
			return c.json({ takenOver: true });
		}

		// Background subagent: interrupt the loop and let executeBackgroundTask
		// transition it to the idle takeover state (without marking it completed).
		if (narrator.isBackground && narrator.backgroundStatus === "running") {
			markTakenOver(id, { background: true });
			const ctrl = getBackgroundAbortControllers().get(id);
			if (!ctrl) {
				const { clearTakenOver } = await import("../services/narrator-subagent");
				clearTakenOver(id);
				return c.json({ error: "Background task is not running" }, 400);
			}
			ctrl.abort("Taken over by user");
			// The background transition itself also broadcasts (see
			// finalizeBackgroundSubagentTakeover); this covers the window before the
			// aborted loop reaches that point, so the card flips immediately.
			await broadcastSubagentTakeoverChanged({
				parentNarratorId: narrator.parentNarratorId,
				subagentNarratorId: id,
				takenOver: true,
			});
			return c.json({ takenOver: true });
		}

		// Session-engine driven subagent (e.g. continued from its page after a
		// manual_override): its loop runs via narrator-session (activeNarrators),
		// not the subagent foreground/background runner. Take over by interrupting
		// the active loop. markTakenOver is set FIRST so the loop's post-turn
		// takeover handoff sees isTakenOver and keeps the subagent held (rather than
		// firing the conclusion watcher and returning the result to the parent).
		if (isNarratorActive(id) || isLoopRunning(id)) {
			markTakenOver(id);
			const interrupted = interruptNarrator(id);
			if (!interrupted) {
				const { clearTakenOver } = await import("../services/narrator-subagent");
				clearTakenOver(id);
				return c.json({ error: "Failed to take over subagent" }, 400);
			}
			// finalizeInterruptedRun writes idle[interrupted]; preserveTakenOverSubstatus
			// re-injects taken_over because markTakenOver already ran. Add the tag now so
			// the frontend reflects the takeover immediately without waiting for the loop.
			await narratorService.addSubstatus(id, "taken_over").catch(() => {});
			broadcastToNarrator(narrator.parentNarratorId, {
				type: "subagent_status_changed",
				narratorId: narrator.parentNarratorId,
				subagentNarratorId: id,
				status: narrator.status,
				substatus: [...parseSubstatus(narrator.substatus), "taken_over"],
			});
			await broadcastSubagentTakeoverChanged({
				parentNarratorId: narrator.parentNarratorId,
				subagentNarratorId: id,
				takenOver: true,
			});
			return c.json({ takenOver: true });
		}

		// Genuine transient window: a foreground subagent caught between turns (its
		// abort controller is momentarily absent while the loop decides what to do
		// next). Ask the caller to retry shortly rather than failing hard.
		return c.json({ error: "Subagent is between turns; retry shortly" }, 409);
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
		const { getSubagentFinalText, isNarratorActive } = await import("../services/narrator-session");
		const isRunning = isNarratorActive(id);

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

		// Clear the card's takeover badge here rather than at each exit below: every
		// remaining branch stops the takeover (the only failure path is the guard
		// above), so one call covers all six of them and cannot be forgotten when a
		// branch is added. Deferred branches included — the user has released control
		// even when the result handoff waits for the loop to end.
		await broadcastSubagentTakeoverChanged({
			parentNarratorId: narrator.parentNarratorId,
			subagentNarratorId: id,
			takenOver: false,
			...(parentToolUseId ? { toolUseId: parentToolUseId } : {}),
		});

		if (wasBackground) {
			// Background takeover: the parent was never blocked (it holds the
			// background_task_id). Restore background completion semantics so the
			// result reaches the parent via Await / completion sidecar.
			if (isRunning) {
				// Still working — defer: when the loop ends, finalize as a background
				// completion. Keep the takeover state until then so intermediate state
				// stays consistent; only drop the visible tag.
				markPendingBackgroundFinalize(id);
				await narratorService.removeSubstatus(id, "taken_over").catch(() => {});
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
			);
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
			return c.json({ stopped: true, deferred: true });
		}

		// Idle — resolve the parent's blocked Promise immediately with the current result.
		const finalText = await getSubagentFinalText(id);
		const hasError = parseSubstatus(narrator.substatus).includes("error");

		// Foreground-loop takeover: the parent is blocked in waitForManualOverride.
		// Resolve it directly; the parent's runForegroundLoop finalizer returns the
		// result and cleans up status.
		if (isManualOverride(id)) {
			clearTakenOver(id);
			await narratorService.removeSubstatus(id, "taken_over").catch(() => {});
			resolveManualOverride(id, finalText, hasError);
			return c.json({ stopped: true, deferred: false });
		}

		// Session-engine takeover (e.g. continued from a manual_override): the parent
		// was already unblocked when the user continued the subagent, and a conclusion
		// watcher was registered to hand the result back. Trigger that handoff now.
		const { getConclusionWatcher, removeConclusionWatcher } = await import(
			"../services/narrator-subagent"
		);
		const watcher = getConclusionWatcher(id);
		if (watcher) {
			const { getSubagentResultMessageId, updateToolCallConclusion } = await import(
				"../services/narrator-session"
			);
			removeConclusionWatcher(id);
			const resultMsgId = await getSubagentResultMessageId(id);
			// Clear takeover state BEFORE the status write so preserveTakenOverSubstatus
			// does not re-inject the taken_over tag.
			clearTakenOver(id);
			await narratorService
				.updateStatus(id, "idle", {
					substatus: hasError ? ["error"] : ["unread"],
					skipErrorMessage: true,
				})
				.catch(() => {});
			await updateToolCallConclusion({
				subagentId: id,
				parentNarratorId: narrator.parentNarratorId,
				toolUseId: watcher.toolUseId,
				finalText,
				hasError,
				resultMessageId: resultMsgId,
				refreshTiming: true,
			});
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

		// Not in manual_override — update the tool_call outputJson directly
		// (existing behavior for already-completed subagents).
		// Find the tool_call record
		const tc = await narratorService.getToolCallByToolUseId(toolUseId);
		if (!tc?.messageId) {
			return c.json({ error: "Tool call not found" }, 400);
		}

		// Fork detection: check if the parent's assistant message is shared.
		// After copy-on-write, track the new messageId so updateToolCallResult
		// only updates the private copy (not the original shared record).
		const isShared = await narratorService.isMessageSharedByMultipleNarrators(tc.messageId);
		let privateMessageId: string | undefined;
		if (isShared) {
			privateMessageId = await narratorService.copyOnWriteToolCallMessage(
				narrator.parentNarratorId,
				tc.messageId,
				toolUseId,
			);
		}

		const { updateToolCallConclusion } = await import("../services/narrator-session");
		await updateToolCallConclusion({
			subagentId: id,
			parentNarratorId: narrator.parentNarratorId,
			toolUseId,
			finalText,
			hasError,
			messageId: privateMessageId,
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
	return c.json(await setNarratorDefaultDevice(c.req.param("id"), value ?? null));
});

// Update model
narratorRoutes.patch("/:id/model", async (c) => {
	const id = c.req.param("id");
	const parsed = updateNarratorModelSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	await narratorService.getById(id); // ensure exists
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
	await narratorService.updateToolCallResult(toolUseId, {
		output: getToolMessageWithParams("enterPlanModeOutputWithPath", locale as Locale, {
			planFilePath: planState.planFilePath ?? buildPlanFileRelPath("<id>"),
		}),
		status: "success",
		// The following message broadcast already accounts for this persisted tool state.
		bumpMessageVersion: false,
	});
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

// Update prune enabled
narratorRoutes.patch("/:id/prune-enabled", async (c) => {
	const id = c.req.param("id");
	const { pruneEnabled } = await c.req.json();
	if (typeof pruneEnabled !== "boolean") {
		throw new ValidationError("pruneEnabled must be a boolean");
	}
	await narratorService.getById(id);
	await narratorService.updatePruneEnabled(id, pruneEnabled);
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

// Update narrator working directory
narratorRoutes.patch("/:id/cwd", async (c) => {
	const id = c.req.param("id");
	const parsed = updateNarratorCwdSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	let cwd = parsed.data.cwd.trim();
	if (!isAbsolute(cwd)) {
		throw new ValidationError("cwd must be an absolute path");
	}

	const narrator = await narratorService.getById(id);
	const chapter = narrator.chapterId
		? await db.query.chapters.findFirst({
				where: eq(chapters.id, narrator.chapterId),
				columns: { worktreePath: true },
			})
		: null;
	if (narrator.chapterId && !chapter?.worktreePath) {
		throw new ValidationError("The current chapter has no active worktree");
	}

	// Validate path exists/access and resolve symlinks before enforcing the
	// chapter worktree boundary.
	let canonicalCwd: string;
	try {
		const { access, constants, realpath } = await import("node:fs/promises");
		await access(cwd, constants.R_OK | constants.X_OK);
		canonicalCwd = await realpath(cwd);
		if (chapter?.worktreePath) {
			const canonicalWorktree = await realpath(chapter.worktreePath);
			if (!isInsidePath(canonicalWorktree, canonicalCwd)) {
				throw new ValidationError("cwd must be inside the current chapter worktree");
			}
		}
	} catch (error) {
		if (error instanceof ValidationError) throw error;
		const message =
			error instanceof Error
				? error.message
				: "Working directory does not exist or is not accessible";
		throw new ValidationError(message);
	}
	cwd = canonicalCwd;

	const previousCwd = narrator.cwd?.trim() || null;
	if (previousCwd === cwd) {
		return c.json({ ok: true, cwd, changed: false });
	}

	await narratorService.updateCwd(id, cwd);
	await updateActiveNarratorCwdAndSkillContext(id, cwd);

	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const reminder =
		locale === "zh-CN"
			? previousCwd
				? `工作目录已更新：${previousCwd} → ${cwd}`
				: `工作目录已设置为：${cwd}`
			: previousCwd
				? `Working directory updated: ${previousCwd} → ${cwd}`
				: `Working directory set to: ${cwd}`;
	await narratorService.persistDisplayMessage(id, reminder);

	return c.json({ ok: true, cwd, changed: true });
});

// Regenerate narrator title via AI
narratorRoutes.post("/:id/generate-title", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const title = await generateTitle(id, locale);
	await persistTitle(id, title);
	return c.json({ title });
});

// Archive narrator
narratorRoutes.patch("/:id/archive", async (c) => {
	const id = c.req.param("id");
	if (isNarratorActive(id)) closeNarrator(id);
	await narratorService.getById(id);
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

// Fork standalone narrator (chapter-bound narrators must fork via chapter fork)
narratorRoutes.post("/:id/fork", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json();
	const parsed = forkNarratorSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const newNarrator = await narratorService.forkNarrator(id, parsed.data.forkMessageUuid ?? null, {
		title: parsed.data.title,
		inheritMode: parsed.data.inheritMode ?? "full",
		forkMessageId: parsed.data.forkMessageId,
	});
	return c.json(publicNarratorResponse(newNarrator), 201);
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
	const msg = db.transaction((tx) => {
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
				createdBy: userId,
				createdAt: now,
			})
			.returning()
			.get();

		const insertSeq = ref.seq + 1;
		tx.update(narratorMessageRefs)
			.set({ seq: sql`${narratorMessageRefs.seq} + 1` })
			.where(and(eq(narratorMessageRefs.narratorId, id), gte(narratorMessageRefs.seq, insertSeq)))
			.run();

		tx.insert(narratorMessageRefs)
			.values({
				id: generateId(),
				narratorId: id,
				messageId: msgId,
				seq: insertSeq,
			})
			.run();

		tx.update(narrators)
			.set({ messageVersion: sql`${narrators.messageVersion} + 1` })
			.where(eq(narrators.id, id))
			.run();

		return { ...insertedMsg, seq: insertSeq };
	});

	// Broadcast so the UI updates in real-time
	broadcastToNarrator(id, {
		type: "message",
		narratorId: id,
		message: msg,
	});

	return c.json({ messageId: msgId }, 201);
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
			.set({ contentJson: resolvedContentJson, contentText: resolvedContentText })
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

	return c.json(publicNarratorResponse(newNarrator), 201);
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
					permissionMode: "default",
					updatedAt: new Date().toISOString(),
				})
				.where(eq(narrators.id, id));
		});

		await updateNarratorPermissionMode(id, "default");

		const updated = await narratorService.getById(id);
		broadcastToNarrator(id, {
			type: "permission_mode_changed",
			narratorId: id,
			permissionMode: "default",
		});

		return c.json({ type: "unlocked", narrator: publicNarratorResponse(updated) });
	}

	// Chapter-bound narrator: fork a new chapter
	const chapter = await chapterFork.fork(narrator.chapterId, {
		inheritMode: "full",
		worktreeSource: "workspace",
	});

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

	return c.json({ type: "forked", chapter });
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
	const { questions } = parsed.data;
	const answers = await generateAskUserQuestionAnswers(id, questions, {
		locale,
		model: narrator.model,
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
 * Describe both rollback scopes for a window, or null when neither tree-based
 * scope applies (pre-snapshot history, which the caller previews via replay).
 *
 * Each scope's file list is produced by the same comparison its rollback performs,
 * so the dialog can never advertise a narrower change set than what gets applied.
 * `withContents` attaches current/reverted text for the diff view — to BOTH scopes,
 * because either can be the selected one and a diff view with no contents would
 * render every file as an empty change.
 */
async function buildRevertScopePreviews(narratorId: string, minSeq: number, withContents = false) {
	const [narratorScope, treePreview] = await Promise.all([
		previewNarratorScopedFromSeq(narratorId, minSeq, { withContents }),
		previewSeqTreeRevert(narratorId, minSeq),
	]);
	if (!treePreview && !narratorScope.available) return null;

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

	const scope: RevertScope =
		narratorScope.available && narratorScope.conflicts.length === 0 ? "narrator" : "workspace";

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
			available: !!treePreview,
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

/** List file snapshots for a narrator */
narratorRoutes.get("/:id/patches", async (c) => {
	const narratorId = c.req.param("id");

	// Project out originalContent (full file body) — the list only needs metadata.
	// Full content is available via /patches/:id/diff.
	const snapshots = await db.query.narratorFileSnapshots.findMany({
		where: eq(narratorFileSnapshots.narratorId, narratorId),
		orderBy: asc(narratorFileSnapshots.createdAt),
		columns: { id: true, narratorId: true, deviceId: true, filePath: true, createdAt: true },
		extras: {
			originalExists:
				sql<number>`CASE WHEN ${narratorFileSnapshots.originalContent} IS NOT NULL THEN 1 ELSE 0 END`.as(
					"original_exists",
				),
		},
	});

	return c.json(
		snapshots.map((s) => ({
			id: s.id,
			narratorId: s.narratorId,
			deviceId: s.deviceId,
			filePath: s.filePath,
			createdAt: s.createdAt,
			originalExists: Number(s.originalExists) === 1,
		})),
	);
});

/** Get the diff for a specific file snapshot (original vs current rebuilt state) */
narratorRoutes.get("/:id/patches/:patchId/diff", async (c) => {
	const narratorId = c.req.param("id");
	const patchId = c.req.param("patchId");
	const upToMessageId = c.req.query("upToMessageId");
	const fromMessageId = c.req.query("fromMessageId");

	const snap = await db.query.narratorFileSnapshots.findFirst({
		where: and(
			eq(narratorFileSnapshots.id, patchId),
			eq(narratorFileSnapshots.narratorId, narratorId),
		),
	});
	if (!snap) return c.json({ error: "Snapshot not found" }, 404);

	const identity = { deviceId: snap.deviceId, filePath: snap.filePath };
	// Resolve "from" boundary: file state at fromMessageId (used as the diff base)
	let originalContent: string | null;
	let currentContent: string | null;
	try {
		if (fromMessageId) {
			const fromRef = await db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, fromMessageId),
				),
				columns: { seq: true },
			});
			if (!fromRef) return c.json({ error: "fromMessageId not found in this narrator" }, 404);
			originalContent =
				(await rebuildDeviceFileState(narratorId, identity, fromRef.seq)) ?? snap.originalContent;
		} else {
			originalContent = snap.originalContent;
		}

		// Resolve "to" boundary: file state at upToMessageId (or current)
		if (upToMessageId) {
			const ref = await db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, upToMessageId),
				),
				columns: { seq: true },
			});
			if (!ref) return c.json({ error: "Message not found in this narrator" }, 404);
			currentContent =
				(await rebuildDeviceFileState(narratorId, identity, ref.seq)) ?? snap.originalContent;
		} else {
			currentContent = await rebuildDeviceFileState(narratorId, identity);
		}
	} catch (error) {
		// Replay divergence means this file cannot be reconstructed; surface it
		// rather than rendering a diff against a wrong baseline.
		return c.json(fileHistoryConflictBody(error), 409);
	}

	return c.json({
		deviceId: snap.deviceId,
		filePath: snap.filePath,
		original: originalContent,
		current: currentContent,
	});
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

	const toolCallsToRevert = await db
		.select({ toolUseId: narratorToolCalls.toolUseId })
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
				gte(narratorMessageRefs.seq, targetSeq),
			),
		);
	if (isNarratorActive(narratorId)) {
		return c.json({ error: "Narrator became active during revert" }, 409);
	}
	// Narrowest applicable strategy first: the narrator scope reverses only this
	// narrator's own changes, so other actors' work in the same window survives.
	// It returns null when it cannot express the window, falling through to the
	// workspace tree and then to per-file replay for pre-snapshot history.
	const scope = body.scope ?? DEFAULT_REVERT_SCOPE;
	const result =
		(scope === "narrator" ? await revertNarratorScopedFromSeq(narratorId, targetSeq) : null) ??
		(await revertFromSeqTree(narratorId, targetSeq)) ??
		(await revertPatchForToolUses(
			narratorId,
			toolCallsToRevert.map((toolCall) => toolCall.toolUseId),
		));
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

/** Unrevert — rebuild current (full) file state and write to disk */
narratorRoutes.post("/:id/unrevert", async (c) => {
	const narratorId = c.req.param("id");

	if (isNarratorActive(narratorId)) {
		return c.json({ error: "Cannot unrevert while narrator is running" }, 409);
	}

	try {
		if (isNarratorActive(narratorId)) {
			return c.json({ error: "Narrator became active during unrevert" }, 409);
		}
		const fileStates = await rebuildDeviceFileStatesUpToSeq(narratorId, Number.MAX_SAFE_INTEGER);
		const result = await applyDeviceFileStates(narratorId, [...fileStates.values()]);
		if (result.failures.length > 0) return c.json(revertConflictBody(result), 409);
		finalizeSnapshotRevert(result);
		return c.json({ success: true, fileCount: result.fileCount, files: result.files });
	} catch (err) {
		return c.json(fileHistoryConflictBody(err), 409);
	}
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
 * Newest top-level messages exposed as range boundaries by `/file-modifications`.
 *
 * The timeline only populates two dropdowns, so it does not need the narrator's whole
 * history: an unbounded one measured 30278 rows / ~2.8 MB of JSON on a long narrator,
 * and `JSON.stringify` on that is synchronous main-thread work on every refresh.
 */
const FILE_MODIFICATION_TIMELINE_LIMIT = 500;

/** Get aggregated file modification summary for a narrator */
narratorRoutes.get("/:id/file-modifications", async (c) => {
	const narratorId = c.req.param("id");
	const upToMessageId = c.req.query("upToMessageId");
	const fromMessageId = c.req.query("fromMessageId");

	// Project out originalContent (full file body); only its presence is needed here.
	const snapshots = await db.query.narratorFileSnapshots.findMany({
		where: eq(narratorFileSnapshots.narratorId, narratorId),
		orderBy: asc(narratorFileSnapshots.createdAt),
		columns: { id: true, deviceId: true, filePath: true, createdAt: true },
		extras: {
			originalExists:
				sql<number>`CASE WHEN ${narratorFileSnapshots.originalContent} IS NOT NULL THEN 1 ELSE 0 END`.as(
					"original_exists",
				),
		},
	});
	if (snapshots.length === 0) return c.json({ files: [], timeline: [] });

	// Always query all tool calls first to build the timeline.
	// Only file_path is needed here (grouping + timeline), so skip loading the
	// full inputJson (Write contains entire file bodies).
	const allToolCalls = await queryOrderedToolCalls(narratorId, undefined, { filePathOnly: true });

	// Timeline feeds the range-boundary dropdowns, so it is capped: a long narrator has
	// tens of thousands of top-level messages (measured: 30278 rows / ~2.8 MB of JSON),
	// and serializing that on every refresh is synchronous main-thread work for a picker
	// nobody scrolls that far back in. The newest window is the useful one, so take the
	// tail and re-sort ascending for the UI.
	const newestRefs = await db
		.select({
			messageId: narratorMessageRefs.messageId,
			seq: narratorMessageRefs.seq,
			role: narratorMessages.role,
			createdAt: narratorMessages.createdAt,
		})
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(
			and(eq(narratorMessageRefs.narratorId, narratorId), isNull(narratorMessages.parentToolUseId)),
		)
		.orderBy(desc(narratorMessageRefs.seq))
		.limit(FILE_MODIFICATION_TIMELINE_LIMIT + 1);

	const timelineTruncated = newestRefs.length > FILE_MODIFICATION_TIMELINE_LIMIT;
	const windowRefs = timelineTruncated
		? newestRefs.slice(0, FILE_MODIFICATION_TIMELINE_LIMIT)
		: newestRefs;
	windowRefs.reverse();

	// Pre-compute which messageIds have file edits
	const editMessageIds = new Set(allToolCalls.map((tc) => tc.messageId));
	const timeline = windowRefs.map((ref) => ({
		messageId: ref.messageId,
		createdAt: ref.createdAt,
		seq: ref.seq,
		role: ref.role,
		hasEdits: editMessageIds.has(ref.messageId),
	}));

	// Boundaries are resolved against the database, not the capped timeline: a client
	// may still hold a messageId from outside the window (a stale tab, a deep link),
	// and silently dropping the filter there would return the full unfiltered range
	// instead of the narrower one the caller asked for.
	const resolveSeq = async (messageId: string): Promise<number | undefined> => {
		const inWindow = timeline.find((entry) => entry.messageId === messageId);
		if (inWindow) return inWindow.seq;
		const [row] = await db
			.select({ seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, messageId),
				),
			)
			.limit(1);
		return row?.seq;
	};

	// Resolve seq boundaries for range filtering
	const fromSeq = fromMessageId ? await resolveSeq(fromMessageId) : undefined;
	const toSeq = upToMessageId ? await resolveSeq(upToMessageId) : undefined;

	// Filter tool calls to the [fromSeq, toSeq] range
	const isRangeFiltered = fromSeq !== undefined || toSeq !== undefined;
	const filteredToolCalls = allToolCalls.filter((tc) => {
		if (fromSeq !== undefined && tc.seq <= fromSeq) return false;
		if (toSeq !== undefined && tc.seq > toSeq) return false;
		return true;
	});

	const legacyLocalCwd = await resolveNarratorCwd(narratorId);
	let grouped: ReturnType<typeof groupByDeviceFileStrict>;
	try {
		grouped = groupByDeviceFileStrict(filteredToolCalls, legacyLocalCwd);
	} catch (error) {
		return c.json(fileHistoryConflictBody(error), 409);
	}

	// Built once for the whole snapshot set: canonicalizing per snapshot would rebuild
	// this map on every iteration, which is O(snapshots × toolCalls) of synchronous work
	// and froze the event loop for ~4.3s on a 1436 × 7213 narrator.
	const canonicalAliases = buildCanonicalIdentityAliases(allToolCalls, legacyLocalCwd);

	const files = snapshots
		.map((snap) => {
			const identity = canonicalizeDeviceFileIdentityWith(
				{ deviceId: snap.deviceId, filePath: snap.filePath },
				canonicalAliases,
			);
			const ops = grouped.get(deviceFileKey(identity))?.calls ?? [];
			if (isRangeFiltered && ops.length === 0) return null; // hide files with no ops in filtered mode
			return {
				deviceId: identity.deviceId,
				filePath: identity.filePath,
				pathFlavor: identity.pathFlavor,
				identityKey: identity.identityKey,
				snapshotId: snap.id,
				originalExists: Number(snap.originalExists) === 1,
				editCount: ops.length,
				lastModifiedAt: ops.length > 0 ? ops[ops.length - 1].createdAt : snap.createdAt,
				operations: ops.map((op) => ({
					toolUseId: op.toolUseId,
					toolName: op.toolName,
					messageId: op.messageId,
					createdAt: op.createdAt,
				})),
			};
		})
		.filter(Boolean);

	return c.json({ files, timeline, timelineTruncated });
});

/** Revert a single file to its original state (before narrator touched it) */
narratorRoutes.post("/:id/revert-file", async (c) => {
	const narratorId = c.req.param("id");
	const body = await c.req.json<{ deviceId?: string; filePath: string }>();
	if (!body.filePath) return c.json({ error: "filePath is required" }, 400);
	const deviceId = body.deviceId ?? "local";

	if (isNarratorActive(narratorId)) {
		return c.json({ error: "Cannot revert while narrator is running" }, 409);
	}

	const snap = await db.query.narratorFileSnapshots.findFirst({
		where: and(
			eq(narratorFileSnapshots.narratorId, narratorId),
			eq(narratorFileSnapshots.deviceId, deviceId),
			eq(narratorFileSnapshots.filePath, body.filePath),
		),
		columns: {
			deviceId: true,
			filePath: true,
			originalContent: true,
			originalEncoding: true,
			isBinary: true,
		},
	});
	if (!snap) return c.json({ error: "No snapshot found for this file" }, 404);
	// Binary snapshots are stored as decoded text, which does not round-trip.
	// Writing them back would corrupt the file, so refuse instead.
	if (snap.isBinary) {
		return c.json(
			{
				error: `${snap.filePath} was recorded as binary and cannot be restored from a text snapshot.`,
				code: "REPLAY_DIVERGED",
			},
			409,
		);
	}
	if (isNarratorActive(narratorId)) {
		return c.json({ error: "Narrator became active during revert" }, 409);
	}
	const identity = canonicalizeDeviceFileIdentity(
		{ deviceId: snap.deviceId, filePath: snap.filePath },
		await queryOrderedToolCalls(narratorId, undefined, { filePathOnly: true }),
		await resolveNarratorCwd(narratorId),
	);
	const result = await applyDeviceFileStates(narratorId, [
		{ ...identity, content: snap.originalContent, encoding: snap.originalEncoding },
	]);
	if (result.failures.length > 0) return c.json(revertConflictBody(result), 409);
	finalizeSnapshotRevert(result);
	return c.json({ success: true, originalExists: snap.originalContent !== null });
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
 * Separate from `/delete-preview`, which describes "this message and everything
 * after it". A block deletion reverses exactly one recorded call, so its preview
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

/** Preview file changes that would be reverted if a message is deleted */
narratorRoutes.get("/:id/delete-preview", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.query("messageId");
	if (!messageId) return c.json({ error: "messageId query param is required" }, 400);

	const targetRef = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, narratorId),
			eq(narratorMessageRefs.messageId, messageId),
		),
		columns: { seq: true },
	});
	if (!targetRef) return c.json({ error: "Message not found" }, 404);

	// The tree-snapshot path below only reports a count, so resolve that with an
	// aggregate first. Loading the rows to call `.length` would pull every
	// `input_json` — Write calls carry whole file bodies — for nothing.
	const revertScopeFilter = and(
		eq(narratorToolCalls.narratorId, narratorId),
		eq(narratorToolCalls.status, "success"),
		gte(narratorMessageRefs.seq, targetRef.seq),
	);
	const revertScopeJoin = and(
		eq(narratorMessageRefs.narratorId, narratorId),
		eq(narratorMessageRefs.messageId, narratorToolCalls.messageId),
	);

	// Deletion reverts files too, so the preview describes both scopes — with file
	// contents attached, because this response also backs the diff view.
	const scopes = await buildRevertScopePreviews(narratorId, targetRef.seq, true);
	if (scopes) {
		const [counted] = await db
			.select({ value: countFn() })
			.from(narratorToolCalls)
			.innerJoin(narratorMessageRefs, revertScopeJoin)
			.where(revertScopeFilter);
		return c.json({ ...scopes, toolCallCount: counted?.value ?? 0 });
	}

	// Find all tool calls at or after the target message. Only the replay path needs
	// the recorded inputs, so this query stays behind the tree-snapshot branch.
	const toolCallsToRevert = await db
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
		.innerJoin(narratorMessageRefs, revertScopeJoin)
		.where(revertScopeFilter);

	let affectedFiles: DeviceFileIdentity[];
	try {
		affectedFiles = getAffectedDeviceFilesStrict(
			toolCallsToRevert,
			await resolveNarratorCwd(narratorId),
		);
	} catch (error) {
		return c.json(fileHistoryConflictBody(error), 409);
	}
	if (affectedFiles.length === 0) return c.json({ affectedFiles: [], toolCallCount: 0 });

	const excludeIds = new Set(toolCallsToRevert.map((tc) => tc.toolUseId));
	let currentStates: Map<string, DeviceFileState>;
	let revertedStates: Map<string, DeviceFileState>;
	try {
		currentStates = await rebuildDeviceFileStatesExcluding(narratorId, affectedFiles, new Set());
		revertedStates = await rebuildDeviceFileStatesExcluding(narratorId, affectedFiles, excludeIds);
	} catch (error) {
		return c.json(fileHistoryConflictBody(error), 409);
	}

	const affectedFilePreviews = affectedFiles.map((identity) => ({
		...identity,
		currentContent: currentStates.get(deviceFileKey(identity))?.content ?? null,
		revertedContent: revertedStates.get(deviceFileKey(identity))?.content ?? null,
		willBeDeleted: revertedStates.get(deviceFileKey(identity))?.content === null,
	}));

	return c.json({ affectedFiles: affectedFilePreviews, toolCallCount: toolCallsToRevert.length });
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
		},
	});
	if (!toolCall) return c.json({ error: "Tool call not found" }, 404);

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
 * List all background tasks spawned by this narrator.
 */
narratorRoutes.get("/:id/background-tasks", async (c) => {
	const parentNarratorId = c.req.param("id");
	const limitRaw = c.req.query("limit");
	const limit = limitRaw != null ? Number.parseInt(limitRaw, 10) : undefined;
	const { backgroundTaskService } = await import("../services/background-task-service");
	// In-process liveness (a subagent whose loop is running while its task row is
	// already terminal) is applied inside the service, not here: `activeCount`, the
	// `activeTasks` set, the paged rows and the delta upserts all have to agree, and
	// a route-only overlay left the badge disagreeing with the rows beside it.
	return c.json(
		await backgroundTaskService.listPageByParent(parentNarratorId, {
			cursor: c.req.query("cursor"),
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
