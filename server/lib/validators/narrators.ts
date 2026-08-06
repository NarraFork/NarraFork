import {
	handleLength,
	isValidHandle,
	MAX_HANDLE_LENGTH,
	MIN_HANDLE_LENGTH,
} from "@shared/narrator-handle";
import { MAX_NARRATOR_DRAFT_CHARS } from "@shared/narrator-limits";
import { z } from "zod";
import { permissionModeSchema } from "../permission-modes";
import { legacyRuleDeviceScopeSchema, pathFlavorSchema, ruleTargetSelectorSchema } from "./common";

const reasoningEffortSchema = z.enum(["none", "low", "medium", "high", "xhigh", "max"]);
const booleanOverrideSchema = z.enum(["inherit", "on", "off"]);
const dangerReflectionOverrideSchema = z.enum([
	"inherit",
	"on",
	"off",
	"light",
	"standard",
	"strict",
]);
const autoContinuationOverrideSchema = z.enum([
	"inherit",
	"always",
	"blockStop",
	"protectedOnly",
	"off",
]);

/**
 * Handle for "named narrators": globally-unique, human-friendly mention target.
 * Preserves the original case the user typed. Allowed chars: Unicode letters
 * (incl. CJK), Unicode digits, `_`, `-` — must start with a letter/digit.
 * Length 2-32 code points. Matching + uniqueness are case-insensitive (handled
 * by the service layer via `foldHandle`), so the stored value keeps its case.
 */
export const narratorHandleSchema = z
	.string()
	.trim()
	.refine((s) => handleLength(s) >= MIN_HANDLE_LENGTH && handleLength(s) <= MAX_HANDLE_LENGTH, {
		message: `handle must be ${MIN_HANDLE_LENGTH}-${MAX_HANDLE_LENGTH} characters`,
	})
	.refine((s) => isValidHandle(s), {
		message: "handle must start with a letter or digit and contain only letters, digits, _ or -",
	});

export const createNarratorSchema = z.object({
	chapterId: z.string().min(1).nullish(),
	type: z.enum(["primary"]).optional(),
	model: z.string().optional(),
	systemPrompt: z.string().max(10000).optional(),
	permissionMode: permissionModeSchema.optional(),
	startInPlanMode: z.boolean().optional(),
	cwd: z.string().min(1).max(4096).optional(),
	reasoningEffort: reasoningEffortSchema.nullable().optional(),
	/** @deprecated Use fastModeOverride. Kept so older clients keep working. */
	fastMode: z.boolean().optional(),
	fastModeOverride: booleanOverrideSchema.optional(),
	relaxedPlan: z.boolean().optional(),
	planReflectionAutoApproveOverride: booleanOverrideSchema.optional(),
	dangerReflectionOverride: dangerReflectionOverrideSchema.optional(),
	autoContinuationOverride: autoContinuationOverrideSchema.optional(),
	behaviorFenceIntervalOverride: z
		.number()
		.int()
		.min(-1)
		.max(1000)
		.refine((v) => v === -1 || v >= 5, {
			message: "Interval must be -1 or at least 5",
		})
		.nullable()
		.optional(),
	tasksReminderIntervalOverride: z
		.number()
		.int()
		.min(-1)
		.max(1000)
		.refine((v) => v === -1 || v >= 5, {
			message: "Interval must be -1 or at least 5",
		})
		.nullable()
		.optional(),
	behaviorFenceAttachOverride: booleanOverrideSchema.optional(),
	// Named narrator: when makeNamed is true, handle is required and the narrator
	// gets the "named" trait. Named narrators are standalone, long-lived, and
	// mentionable via @handle in any session.
	makeNamed: z.boolean().optional(),
	handle: narratorHandleSchema.optional(),
	// Specialized standalone narrator kind. "knowledge" → Knowledge Steward (knowledge-base mgmt):
	// preinstalls the knowledge toolset and a steward system prompt. Must be standalone.
	kind: z.enum(["knowledge"]).optional(),
});

/** Update a narrator's handle (rename / claim / clear a named narrator handle). */
export const updateNarratorHandleSchema = z.object({
	handle: narratorHandleSchema.nullable(),
});

export const codexUseWebSocketSchema = z.object({
	useWebSocket: z.boolean().optional(),
});

export const codexUseWebSearchSchema = z.object({
	useWebSearch: z.boolean().optional(),
});

export const codexUseImageGenerationSchema = z.object({
	useImageGeneration: z.boolean().optional(),
});

export const codexTierOrderSchema = z.object({
	tierOrder: z.array(z.enum(["free", "plus", "team", "k12", "prolite", "pro", "other"])).max(7),
});

/** Codex client fingerprint config (User-Agent mode + extra headers + emulation). */
export const codexFingerprintSchema = z.object({
	userAgentMode: z.enum(["narrafork", "claude-code", "codex", "custom"]).optional(),
	customUserAgent: z.string().max(500).optional(),
	extraHeaders: z.record(z.string(), z.string().max(2048)).optional(),
});

export const sendMessageSchema = z.object({
	message: z.string().min(1),
	priority: z.boolean().optional(),
});

export const updateNarratorDraftSchema = z.object({
	text: z.string().max(MAX_NARRATOR_DRAFT_CHARS),
	baseRevision: z.number().int().min(0),
	sourceId: z.string().min(1).max(120).optional(),
});

/**
 * How wide a file rollback reaches.
 *
 * Omitted means the server default (`narrator`), which undoes only the requesting
 * narrator's own changes — a shared worktree makes discarding another actor's work
 * the more dangerous default.
 */
export const revertScopeSchema = z.enum(["narrator", "workspace"]).optional();

export const revertFilesSchema = z.object({
	messageId: z.string().min(1),
	scope: revertScopeSchema,
});

export const rollbackToBlockSchema = z.object({
	blockIndex: z.number().int().min(0),
	skipRevert: z.boolean().optional(),
	scope: revertScopeSchema,
});

export const permissionDecisionSchema = z.object({
	decision: z.enum(["allow", "deny"]),
	message: z.string().optional(),
	answers: z.record(z.string(), z.string()).optional(),
	feedbackText: z.string().optional(),
	compactAfter: z.boolean().optional(),
	updatedPlan: z.string().optional(),
});

const ruleTargetFields = {
	selector: ruleTargetSelectorSchema.optional(),
	deviceScope: legacyRuleDeviceScopeSchema,
};

export const createWhitelistDirSchema = z.object({
	path: z.string().trim().min(1).max(4096),
	pathFlavor: pathFlavorSchema.optional(),
	pathKey: z.string().trim().min(1).max(4096).optional(),
	accessLevel: z.enum(["readOnly", "readWrite", "full"]).default("readOnly"),
	enabled: z.boolean().default(true),
	...ruleTargetFields,
});

export const updateWhitelistDirSchema = z.object({
	path: z.string().trim().min(1).max(4096).optional(),
	pathFlavor: pathFlavorSchema.optional(),
	pathKey: z.string().trim().min(1).max(4096).optional(),
	accessLevel: z.enum(["readOnly", "readWrite", "full"]).optional(),
	enabled: z.boolean().optional(),
	...ruleTargetFields,
});

export const createBlacklistDirSchema = z.object({
	path: z.string().trim().min(1).max(4096),
	pathFlavor: pathFlavorSchema.optional(),
	pathKey: z.string().trim().min(1).max(4096).optional(),
	denyLevel: z.enum(["denyWrite", "denyAll"]).default("denyAll"),
	enabled: z.boolean().default(true),
	...ruleTargetFields,
});

export const updateBlacklistDirSchema = z.object({
	path: z.string().trim().min(1).max(4096).optional(),
	pathFlavor: pathFlavorSchema.optional(),
	pathKey: z.string().trim().min(1).max(4096).optional(),
	denyLevel: z.enum(["denyWrite", "denyAll"]).optional(),
	enabled: z.boolean().optional(),
	...ruleTargetFields,
});

// === Narrator command whitelist/blacklist ===

export const createWhitelistCmdSchema = z.object({
	pattern: z.string().trim().min(1).max(200),
	enabled: z.boolean().default(true),
	...ruleTargetFields,
});

export const updateWhitelistCmdSchema = z.object({
	pattern: z.string().trim().min(1).max(200).optional(),
	enabled: z.boolean().optional(),
	...ruleTargetFields,
});

export const createBlacklistCmdSchema = z.object({
	pattern: z.string().trim().min(1).max(200),
	denyPrompt: z.string().max(2000).optional(),
	enabled: z.boolean().default(true),
	...ruleTargetFields,
});

export const updateBlacklistCmdSchema = z.object({
	pattern: z.string().trim().min(1).max(200).optional(),
	denyPrompt: z.string().max(2000).nullable().optional(),
	enabled: z.boolean().optional(),
	...ruleTargetFields,
});

// === Buffered messages ===

export const updateBufferedMessageSchema = z.object({
	text: z.string().min(1).max(100_000),
});

export const reorderBufferSchema = z.object({
	orderedIds: z.array(z.string().min(1)).min(1),
});

// === Segment compact ===

export const segmentCompactSchema = z.object({
	messageIds: z.array(z.string().min(1)).min(1).max(500),
});

export const updateSegmentCompactSummarySchema = z.object({
	summary: z.string().min(1).max(100_000),
});

export const retryFailedCompactSchema = z.object({
	model: z.string().trim().min(1).max(200).optional(),
});

// === Narrator title ===

export const updateNarratorTitleSchema = z.object({
	title: z.string().min(1).max(200),
});

export const updateNarratorCwdSchema = z.object({
	cwd: z.string().trim().min(1).max(4096),
});

// === Narrator Fork (standalone narrators only) ===

export const forkNarratorSchema = z
	.object({
		/** Fork point by SDK message uuid (assistant messages only). */
		forkMessageUuid: z.string().min(1).optional(),
		/** Fork point by local narrator message id (any role) — preferred for UI forks. */
		forkMessageId: z.string().min(1).optional(),
		title: z.string().min(1).max(200).optional(),
		inheritMode: z.enum(["full", "compressed", "fresh"]).optional(),
	})
	.refine((data) => !!(data.forkMessageUuid || data.forkMessageId), {
		message: "forkMessageId or forkMessageUuid is required",
	});

export const askInPassingSchema = z.object({
	question: z.string().min(1).max(10000),
	pendingMessageId: z.string().min(1),
});

/** Resume error subagents listed on the post-error recovery card. */
export const subagentRecoverySchema = z.object({
	messageId: z.string().min(1),
	subagentIds: z.array(z.string().min(1)).min(1).max(50),
	mode: z.enum(["notify", "await"]),
});

export const askInPassingStartSchema = z.object({
	sourceMessageId: z.string().min(1),
	sourceMessageUuid: z.string().min(1).optional(),
});

export const updateNarratorModelSchema = z.object({
	model: z.union([z.literal("__default__"), z.string().min(1).max(200)]),
});

// === Narrator transcript export ===

/**
 * Query for `GET /api/narrators/:id/export`.
 *
 * Every field defaults. `scope` defaults to `visible` — the transcript as the
 * user currently sees it — and `full` opts into pre-compact history. The export
 * itself states when `visible` left earlier messages out, so the narrower default
 * cannot masquerade as a complete archive.
 *
 * Booleans arrive as query strings, so they are parsed from the explicit
 * "true"/"false" spellings rather than JS truthiness (where "false" is true).
 */
const exportBooleanSchema = z
	.enum(["true", "false", "1", "0"])
	.transform((value) => value === "true" || value === "1");

export const narratorExportQuerySchema = z.object({
	format: z.enum(["markdown", "json"]).default("markdown"),
	scope: z.enum(["full", "visible"]).default("visible"),
	includeToolIO: exportBooleanSchema.default(true),
	lang: z.enum(["en", "zh-CN"]).default("en"),
});

/**
 * Bulk-migrate narrators off a model whose provider can no longer serve them.
 * The id list is explicit (never "all matching") so the confirmed set is exactly
 * what the user reviewed in the dialog.
 */
export const migrateBrokenModelNarratorsSchema = z.object({
	targetModel: z.string().min(1).max(200),
	narratorIds: z.array(z.string().min(1)).min(1).max(5000),
	includeArchived: z.boolean().optional(),
});

// === Browser session interaction ===

const browserCoordinateSchema = z.object({
	x: z.number().finite(),
	y: z.number().finite(),
});

const browserKeyEntrySchema = z
	.object({
		text: z.string().optional(),
		key: z.string().optional(),
	})
	.refine((v) => v.text !== undefined || v.key !== undefined, {
		message: "each keys entry must include text or key",
	});

export const browserInteractSchema = z
	.object({
		action: z.enum(["click", "scroll", "drag", "type"]),
		coordinate: browserCoordinateSchema.optional(),
		endCoordinate: browserCoordinateSchema.optional(),
		direction: z.enum(["up", "down"]).optional(),
		amount: z.number().finite().positive().max(100000).optional(),
		text: z.string().optional(),
		key: z.string().optional(),
		keys: z.array(browserKeyEntrySchema).min(1).max(200).optional(),
	})
	.superRefine((v, ctx) => {
		if (v.action !== "type" && !v.coordinate) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "coordinate is required for this action",
			});
		}
		if (v.action === "drag" && !v.endCoordinate) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "coordinate and endCoordinate are required for drag action",
			});
		}
		if (v.action === "type" && v.text === undefined && v.key === undefined && !v.keys) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "text, key, or keys is required for type action",
			});
		}
	});

// === Narrator suggest answers ===

export const suggestAnswersSchema = z.object({
	questions: z
		.array(
			z.object({
				question: z.string().min(1),
				header: z.string().min(1),
				options: z.array(
					z.object({
						label: z.string(),
						description: z.string(),
					}),
				),
				multiSelect: z.boolean().optional(),
			}),
		)
		.min(1),
});

export const batchDeleteBlocksSchema = z.object({
	blocks: z
		.array(
			z.object({
				messageId: z.string().min(1),
				blockIndex: z.number().int().min(0),
			}),
		)
		.min(1)
		.max(200),
	// When true, delete the blocks from history only, leaving files/spec untouched.
	skipRevert: z.boolean().optional(),
	// The narrator scope is the default and refuses on conflict, so the caller needs
	// a way to ask for the wider one its error suggests.
	scope: revertScopeSchema,
});

export const forkFromMessagesSchema = z.object({
	messageIds: z.array(z.string().min(1)).min(1).max(500),
	title: z.string().max(200).optional(),
});

// Edit assistant message text without deleting later messages or regenerating.
export const editAssistantMessageSchema = z.object({
	content: z.string().min(1).max(100000),
});

/**
 * JSON body for edit-and-regenerate (the multipart variant is parsed by hand
 * because it also carries files).
 *
 * `content` may be empty: an edit that keeps only attachments is valid, and the
 * service rejects the genuinely empty case where no text and no attachment remains.
 *
 * `rollback` is the superseded field. It is still accepted so an older client keeps
 * working, and its ORIGINAL meaning — "revert the files" — is what the route honours,
 * since that is what its UI offered.
 */
export const editAndRegenerateJsonSchema = z.object({
	content: z.string().max(100000).optional(),
	keepImageIds: z.array(z.string()).max(100).optional(),
	keepTextFilePaths: z.array(z.string()).max(100).optional(),
	/** True => delete the messages but leave the workspace alone. */
	skipRevert: z.boolean().optional(),
	scope: revertScopeSchema,
	rollback: z.boolean().optional(),
});
