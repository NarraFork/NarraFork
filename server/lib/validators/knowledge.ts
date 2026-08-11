import { z } from "zod";

const tagsSchema = z.array(z.string().min(1).max(64)).max(50).optional();
// Author-declared keywords that drive passive auto-injection. Shape-only validation: a
// lenient minimum-length floor is applied at the service layer (normalizeKeywords), not here
// — keyword quality is steered by tool prompts, so nothing is hard-rejected on length.
const keywordsSchema = z.array(z.string().min(1).max(64)).max(50).optional();
const metadataSchema = z.record(z.string(), z.unknown()).optional();
const formatSchema = z.enum(["markdown", "text", "json"]).optional();

// === collections ===
export const createKnowledgeCollectionSchema = z.object({
	name: z.string().min(1).max(200),
	slug: z
		.string()
		.min(1)
		.max(200)
		.regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with hyphens")
		.optional(),
	description: z.string().max(2_000).optional(),
	projectId: z.string().optional(),
});

export const updateKnowledgeCollectionSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	description: z.string().max(2_000).nullable().optional(),
});

// === entries ===
export const createKnowledgeEntrySchema = z.object({
	collectionId: z.string().min(1),
	title: z.string().min(1).max(500),
	slug: z
		.string()
		.min(1)
		.max(200)
		.regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with hyphens")
		.optional(),
	content: z.string().max(1_000_000).optional().default(""),
	format: formatSchema,
	tags: tagsSchema,
	keywords: keywordsSchema,
	metadata: metadataSchema,
	changeNote: z.string().max(1_000).optional(),
});

export const updateKnowledgeEntrySchema = z.object({
	title: z.string().min(1).max(500).optional(),
	tags: tagsSchema,
	keywords: keywordsSchema,
	metadata: metadataSchema,
	status: z.enum(["active", "archived"]).optional(),
});

// === revisions ===
export const addKnowledgeRevisionSchema = z.object({
	content: z.string().max(1_000_000),
	format: formatSchema,
	changeNote: z.string().max(1_000).optional(),
});

// === search ===
export const knowledgeSearchQuerySchema = z.object({
	q: z.string().max(500).optional(),
	collectionId: z.string().optional(),
	tag: z.string().max(64).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional().default(30),
});

// === drafts (personal working copies) ===
export const createKnowledgeDraftSchema = z.object({
	name: z.string().max(200).optional(),
});

export const updateKnowledgeDraftSchema = z.object({
	content: z.string().max(1_000_000),
	name: z.string().max(200).optional(),
});

export const submitKnowledgeDraftSchema = z.object({
	changeNote: z.string().max(2_000).optional(),
});

// === personal library (standalone personal entries) ===
export const createPersonalEntrySchema = z.object({
	title: z.string().min(1).max(200),
	content: z.string().max(1_000_000).optional(),
	targetCollectionId: z.string().optional(),
	name: z.string().max(200).optional(),
	keywords: keywordsSchema,
});

export const updatePersonalEntryMetaSchema = z.object({
	title: z.string().min(1).max(200).optional(),
	targetCollectionId: z.string().nullable().optional(),
	keywords: keywordsSchema,
});

export const listPersonalEntriesQuerySchema = z.object({
	status: z.enum(["active", "archived"]).optional(),
	limit: z.coerce.number().int().positive().max(200).optional(),
});

// Author-scoped publish history for ONE personal entry (WP2). Bounded; the service gates
// on draft ownership (author or admin) instead of the reviewer filter.
export const listDraftSubmissionsQuerySchema = z.object({
	limit: z.coerce.number().int().positive().max(200).optional(),
});

// === review ===
const findingSchema = z.object({
	severity: z.enum(["critical", "major", "minor", "suggestion"]),
	message: z.string().min(1).max(2_000),
	location: z.string().max(500).optional(),
});

export const reviewKnowledgeSubmissionSchema = z.object({
	// `reject` is the terminal refusal (status → `rejected`, no resubmit); `request_changes`
	// bounces back to the author for another round.
	verdict: z.enum(["approve", "request_changes", "reject", "comment_only"]),
	findings: z.array(findingSchema).max(100).optional(),
});

export const resolveKnowledgeConflictSchema = z.object({
	resolvedContent: z.string().max(1_000_000),
	changeNote: z.string().max(2_000).optional(),
});

// === ACL: levels / tags / grants ===
export const createKnowledgeLevelSchema = z.object({
	name: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z0-9_-]+$/, "level name must be lowercase alphanumeric"),
	rank: z.number().int().min(0).max(1000),
	label: z.string().max(100).optional(),
});

export const updateKnowledgeLevelSchema = z.object({
	name: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z0-9_-]+$/, "level name must be lowercase alphanumeric")
		.optional(),
	rank: z.number().int().min(0).max(1000).optional(),
	label: z.string().max(100).nullable().optional(),
});

export const createKnowledgeTagSchema = z.object({
	name: z.string().min(1).max(64),
	collectionId: z.string().optional(),
	controlled: z.boolean().optional().default(false),
	typeId: z.string().optional(),
});

export const updateKnowledgeTagSchema = z.object({
	name: z.string().min(1).max(64).optional(),
	controlled: z.boolean().optional(),
	typeId: z.string().nullable().optional(),
});

export const createKnowledgeTagTypeSchema = z.object({
	name: z.string().min(1).max(64),
	sortOrder: z.number().int().min(0).max(10_000).optional(),
});

export const updateKnowledgeTagTypeSchema = z.object({
	name: z.string().min(1).max(64).optional(),
	sortOrder: z.number().int().min(0).max(10_000).optional(),
});

export const setUserAclSchema = z.object({
	clearanceLevel: z.string().max(64).nullable().optional(),
	tagIds: z.array(z.string()).max(200).optional(),
	reviewTagIds: z.array(z.string()).max(200).optional(),
	canWrite: z.boolean().optional(),
});

export const createKnowledgeGrantSchema = z
	.object({
		collectionId: z.string().optional(),
		principalType: z.enum(["user", "role"]),
		principalId: z.string().min(1),
		grantType: z.enum(["clearance", "tag", "review"]),
		clearanceLevel: z.string().max(64).optional(),
		tagId: z.string().optional(),
		canWrite: z.boolean().optional().default(false),
	})
	.refine((v) => (v.grantType === "clearance" ? !!v.clearanceLevel : !!v.tagId), {
		message: "clearance grant needs clearanceLevel; tag/review grant needs tagId",
	});

/**
 * Bulk grant: give the SAME credential (one clearance level, or one tag / review tag) to many
 * users in a single admin action. Deliberately one-credential-many-users rather than an
 * arbitrary matrix — it keeps the write bounded and the audit trail readable.
 *
 * `userIds` is hard-capped at 200 so a single request can never turn into an unbounded write
 * on the main thread. Duplicates in the array are collapsed by the service.
 */
export const bulkKnowledgeGrantSchema = z
	.object({
		collectionId: z.string().optional(),
		userIds: z.array(z.string().min(1).max(64)).min(1).max(200),
		grantType: z.enum(["clearance", "tag", "review"]),
		clearanceLevel: z.string().max(64).optional(),
		tagId: z.string().optional(),
		canWrite: z.boolean().optional().default(false),
	})
	.refine((v) => (v.grantType === "clearance" ? !!v.clearanceLevel : !!v.tagId), {
		message: "clearance grant needs clearanceLevel; tag/review grant needs tagId",
	});

// === entry ACL metadata update (admin/owner) ===
export const updateKnowledgeEntryAclSchema = z.object({
	classificationLevel: z.string().max(64).nullable().optional(),
	controlledTags: z.array(z.string()).max(50).optional(),
	reviewTags: z.array(z.string()).max(50).optional(),
	ownerUserId: z.string().nullable().optional(),
});

// === collection ACL metadata update (admin/owner) ===
export const updateKnowledgeCollectionAclSchema = z.object({
	classificationLevel: z.string().max(64).nullable().optional(),
	controlledTags: z.array(z.string()).max(50).optional(),
	ownerUserId: z.string().nullable().optional(),
});

// === ownership transfer (entry + collection share this shape) ===
// null = abandon ownership (unowned); only an admin may pass null (enforced in the service).
export const transferKnowledgeOwnerSchema = z.object({
	ownerUserId: z.string().min(1).max(64).nullable(),
});

// === entry links (entry-scope only; inline references not implemented) ===
const linkTypeSchema = z.enum([
	"related",
	"expands",
	"supersedes",
	"depends_on",
	"parent",
	"mention",
	"custom",
]);

// fromEntryId is optional in the body (the route fills it from the :id param so the
// self-link refine can run). toEntryId + linkType are required.
export const createKnowledgeLinkSchema = z
	.object({
		fromEntryId: z.string().min(1).optional(),
		toEntryId: z.string().min(1),
		linkType: linkTypeSchema,
		label: z.string().max(200).optional(),
		toRevisionId: z.string().min(1).optional(),
	})
	.refine((v) => !v.fromEntryId || v.fromEntryId !== v.toEntryId, {
		message: "cannot link an entry to itself",
	});

// Graph traversal query: bounded depth (coerced from the query string).
export const knowledgeGraphQuerySchema = z.object({
	depth: z.coerce.number().int().min(1).max(5).optional().default(2),
});

export const listKnowledgeLinksQuerySchema = z.object({
	direction: z.enum(["out", "in", "both"]).optional().default("both"),
});

// === review state machine closure (WP5) ===

/**
 * Withdraw an own open publish request. The optional reason is appended to the change note
 * so the audit trail records WHY it was pulled back, not just that it happened.
 */
export const withdrawKnowledgeSubmissionSchema = z.object({
	reason: z.string().max(1_000).optional(),
});

/**
 * Re-submit after `changes_requested`. Content is always taken from the live draft (the
 * server never re-uses the bounced proposal), so only the note is accepted here; the round
 * number is derived server-side.
 */
export const resubmitKnowledgeSubmissionSchema = z.object({
	changeNote: z.string().max(2_000).optional(),
});

/**
 * Rebase strategy. `merge` (default) keeps the existing three-way merge behaviour;
 * `theirs` replaces the draft with current main, DISCARDING the author's local edits.
 */
export const rebaseKnowledgeDraftQuerySchema = z.object({
	strategy: z.enum(["merge", "theirs"]).optional().default("merge"),
});

/**
 * Query the knowledge ACL audit trail (admin only).
 *
 * Keyset pagination: `cursorCreatedAt` + `cursorId` come from the previous page's `nextCursor`.
 * `limit` is coerced (query strings are text) and hard-capped in the service as well, so a client
 * cannot ask for an unbounded page.
 */
export const listKnowledgeAclEventsQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).optional(),
	cursorCreatedAt: z.string().max(64).optional(),
	cursorId: z.string().max(64).optional(),
	eventType: z.string().max(64).optional(),
	subjectId: z.string().max(64).optional(),
	targetId: z.string().max(64).optional(),
	actorUserId: z.string().max(64).optional(),
});
