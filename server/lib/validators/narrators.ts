import { z } from "zod";
import { permissionModeSchema } from "../permission-modes";

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
 * Stored lowercase. Allowed chars: a-z 0-9 _ - (must start with a letter/digit).
 * Length 2-32. Case-insensitive (normalized to lowercase here).
 */
export const narratorHandleSchema = z
	.string()
	.trim()
	.min(2)
	.max(32)
	.transform((s) => s.toLowerCase())
	.refine((s) => /^[a-z0-9][a-z0-9_-]*$/.test(s), {
		message: "handle must start with a letter or digit and contain only a-z, 0-9, _ or -",
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
	fastMode: z.boolean().optional(),
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

export const codexDefaultReasoningEffortSchema = z.object({
	// gpt-5.6 family supports a real "max" tier; older codex models degrade it
	// safely via normalizeCodexReasoningEffort.
	reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).nullable().optional(),
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

export const sendMessageSchema = z.object({
	message: z.string().min(1),
	priority: z.boolean().optional(),
});

export const updateNarratorDraftSchema = z.object({
	text: z.string().max(100_000),
	sourceId: z.string().min(1).max(120).optional(),
});

export const permissionDecisionSchema = z.object({
	decision: z.enum(["allow", "deny"]),
	message: z.string().optional(),
	answers: z.record(z.string(), z.string()).optional(),
	feedbackText: z.string().optional(),
	compactAfter: z.boolean().optional(),
	updatedPlan: z.string().optional(),
});

export const createWhitelistDirSchema = z.object({
	path: z.string().trim().min(1).max(4096),
	accessLevel: z.enum(["readOnly", "readWrite", "full"]).default("readOnly"),
	enabled: z.boolean().default(true),
});

export const updateWhitelistDirSchema = z.object({
	accessLevel: z.enum(["readOnly", "readWrite", "full"]).optional(),
	enabled: z.boolean().optional(),
});

export const createBlacklistDirSchema = z.object({
	path: z.string().trim().min(1).max(4096),
	denyLevel: z.enum(["denyWrite", "denyAll"]).default("denyAll"),
	enabled: z.boolean().default(true),
});

export const updateBlacklistDirSchema = z.object({
	denyLevel: z.enum(["denyWrite", "denyAll"]).optional(),
	enabled: z.boolean().optional(),
});

// === Narrator command whitelist/blacklist ===

export const createWhitelistCmdSchema = z.object({
	pattern: z.string().trim().min(1).max(200),
	enabled: z.boolean().default(true),
});

export const updateWhitelistCmdSchema = z.object({
	pattern: z.string().trim().min(1).max(200).optional(),
	enabled: z.boolean().optional(),
});

export const createBlacklistCmdSchema = z.object({
	pattern: z.string().trim().min(1).max(200),
	denyPrompt: z.string().max(2000).optional(),
	enabled: z.boolean().default(true),
});

export const updateBlacklistCmdSchema = z.object({
	pattern: z.string().trim().min(1).max(200).optional(),
	denyPrompt: z.string().max(2000).nullable().optional(),
	enabled: z.boolean().optional(),
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

// === Narrator title ===

export const updateNarratorTitleSchema = z.object({
	title: z.string().min(1).max(200),
});

export const updateNarratorCwdSchema = z.object({
	cwd: z.string().trim().min(1).max(4096),
});

// === Narrator Fork (standalone narrators only) ===

export const forkNarratorSchema = z.object({
	forkMessageUuid: z.string().min(1),
	title: z.string().min(1).max(200).optional(),
	inheritMode: z.enum(["full", "compressed", "fresh"]).optional(),
});

export const askInPassingSchema = z.object({
	question: z.string().min(1).max(10000),
	pendingMessageId: z.string().min(1),
});

export const askInPassingStartSchema = z.object({
	sourceMessageId: z.string().min(1),
	sourceMessageUuid: z.string().min(1).optional(),
});

export const updateNarratorModelSchema = z.object({
	model: z.union([z.literal("__default__"), z.string().min(1).max(200)]),
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
});

export const forkFromMessagesSchema = z.object({
	messageIds: z.array(z.string().min(1)).min(1).max(500),
	title: z.string().max(200).optional(),
});

// Edit assistant message text without deleting later messages or regenerating.
export const editAssistantMessageSchema = z.object({
	content: z.string().min(1).max(100000),
});
