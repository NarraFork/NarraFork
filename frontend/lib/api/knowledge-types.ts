// Knowledge base API types — mirror server/db/schema.ts knowledge_* tables
// and the service return shapes.

export type KnowledgeFormat = "markdown" | "text" | "json";
export type KnowledgeEntryStatus = "active" | "archived";
export type KnowledgeDraftStatus =
	| "draft"
	| "pending_review"
	| "changes_requested"
	| "merged"
	| "abandoned";
export type KnowledgeSubmissionStatus =
	| "pending"
	| "approved"
	| "rejected"
	| "changes_requested"
	| "conflict"
	// The submitter pulled the request back before any verdict.
	| "withdrawn"
	// Auto-closed because the author edited/rebased the draft, so the proposed content
	// no longer matches. NOT a reviewer verdict (that's `rejected`).
	| "superseded";
export type KnowledgeVerdict = "approve" | "request_changes" | "comment_only";
export type FindingSeverity = "critical" | "major" | "minor" | "suggestion";

export interface KnowledgeCollection {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	projectId: string | null;
	defaultLevel: string;
	/** Classification level gating access to the collection itself (null = public). */
	classificationLevel: string | null;
	/** Controlled tag ids required to read the collection. */
	controlledTagsJson: string[] | null;
	ownerUserId: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface KnowledgeEntry {
	id: string;
	collectionId: string;
	title: string;
	slug: string;
	currentRevisionId: string | null;
	/** Present only on detail (getEntry withContent). */
	currentContent?: string | null;
	tagsJson: string[] | null;
	/** Author-declared keywords driving passive auto-injection. */
	keywordsJson: string[] | null;
	metadataJson: Record<string, unknown> | null;
	classificationLevel: string | null;
	controlledTagsJson: string[] | null;
	reviewTagsJson: string[] | null;
	ownerUserId: string | null;
	status: KnowledgeEntryStatus;
	createdAt: string;
	updatedAt: string;
}

/** Search / list result row (lighter shape with snippet). */
export interface KnowledgeSearchResult {
	id: string;
	collectionId: string;
	title: string;
	slug: string;
	tags: string[];
	status: string;
	createdAt: string;
	updatedAt: string;
	snippet: string;
}

export interface KnowledgeRevision {
	id: string;
	entryId: string;
	version: number;
	format: KnowledgeFormat;
	content: string;
	contentHash: string;
	changeNote: string | null;
	authorUserId: string | null;
	baseRevisionId: string | null;
	createdAt: string;
}

export interface KnowledgeDraft {
	id: string;
	entryId: string;
	authorUserId: string;
	name: string | null;
	baseRevisionId: string | null;
	content: string;
	contentHash: string;
	format: KnowledgeFormat;
	status: KnowledgeDraftStatus;
	createdAt: string;
	updatedAt: string;
}

/**
 * A personal-library entry (the knowledge_drafts row under the personal-library model).
 * `entryId` null = standalone (no global counterpart yet); set = linked to a global entry.
 */
export interface KnowledgePersonalEntry {
	id: string;
	entryId: string | null;
	authorUserId: string;
	name: string | null;
	title: string | null;
	targetCollectionId: string | null;
	baseRevisionId: string | null;
	content: string;
	contentHash: string;
	format: KnowledgeFormat;
	/** Author-declared keywords (standalone personal entries) for passive auto-injection. */
	keywordsJson: string[] | null;
	status: "active" | "archived";
	createdAt: string;
	updatedAt: string;
}

/**
 * Result of soft-deleting (archiving) a personal entry. `alreadyArchived` marks the
 * idempotent no-op case; `invalidatedSubmissionIds` lists the open publish requests
 * that were rejected alongside the delete.
 */
export interface KnowledgeDeletePersonalEntryResult {
	ok: boolean;
	id: string;
	alreadyArchived: boolean;
	invalidatedSubmissionIds?: string[];
}

export interface KnowledgeFinding {
	severity: FindingSeverity;
	message: string;
	location?: string;
}

export interface KnowledgeSubmission {
	id: string;
	draftId: string;
	/**
	 * Target global entry for a LINKED submission. NULL for a STANDALONE submission
	 * (publishing a brand-new global entry) — those carry collectionId + title instead.
	 */
	entryId: string | null;
	/** Standalone publish target collection (set only when entryId is null). */
	collectionId: string | null;
	/** Proposed title for the new global entry (standalone only). */
	title: string | null;
	submitterUserId: string;
	baseRevisionId: string | null;
	proposedContent: string;
	changeNote: string | null;
	/** The `changes_requested` submission this one re-submits; null for a first round. */
	previousSubmissionId?: string | null;
	/** 1-based attempt number in the resubmit chain (1 = first submission). */
	round?: number;
	status: KnowledgeSubmissionStatus;
	reviewerUserId: string | null;
	verdict: KnowledgeVerdict | null;
	findingsJson: KnowledgeFinding[] | null;
	reviewedAt: string | null;
	mergedRevisionId: string | null;
	createdAt: string;
}

/** getSubmission adds a unified diff string. */
export interface KnowledgeSubmissionDetail extends KnowledgeSubmission {
	diff: string;
}

/**
 * A slim "my in-flight publish request" row, keyed by draftId, used to badge the
 * personal-library list. Only pending / conflict / changes_requested are returned.
 */
export interface KnowledgeOpenSubmission {
	id: string;
	draftId: string;
	entryId: string | null;
	status: Extract<KnowledgeSubmissionStatus, "pending" | "conflict" | "changes_requested">;
	createdAt: string;
}

export interface KnowledgeDraftDiff {
	draftId: string;
	against: "base" | "current";
	baseRevisionId: string | null;
	hunks: unknown[];
	unified: string;
}

/** Whether the caller's active draft has drifted behind the entry's current main revision. */
export type KnowledgeDraftDrift =
	| { hasDraft: false }
	| {
			hasDraft: true;
			drifted: boolean;
			draftId: string;
			status: KnowledgeDraftStatus;
			baseRevisionId: string | null;
			currentRevisionId: string | null;
			versionsBehind: number;
			base: string;
			current: string;
			draft: string;
	  };

/** `merge` = three-way merge (default); `theirs` = take main, discarding local edits. */
export type KnowledgeRebaseStrategy = "merge" | "theirs";

export interface KnowledgeRebaseResult {
	ok: boolean;
	rebased?: boolean;
	baseRevisionId?: string | null;
	/** Echoes the strategy the server applied. */
	strategy?: KnowledgeRebaseStrategy;
	conflict?: { base: string; yours: string; theirs: string };
}

export interface KnowledgeReviewResult {
	submissionId: string;
	status: KnowledgeSubmissionStatus;
	verdict?: KnowledgeVerdict;
	mergedRevisionId?: string;
	conflict?: { base: string; yours: string; theirs: string };
}

export interface KnowledgeLevel {
	id: string;
	name: string;
	rank: number;
	label: string | null;
	createdAt: string;
}

export interface KnowledgeTag {
	id: string;
	collectionId: string | null;
	typeId: string | null;
	name: string;
	controlled: boolean;
	createdAt: string;
}

export interface KnowledgeTagType {
	id: string;
	name: string;
	builtin: boolean;
	sortOrder: number;
	createdAt: string;
}

export interface KnowledgeUserAcl {
	clearanceLevel: string | null;
	tagIds: string[];
	reviewTagIds: string[];
	canWrite: boolean;
}

export type KnowledgeGrantType = "clearance" | "tag" | "review";

export interface KnowledgeGrant {
	id: string;
	collectionId: string | null;
	principalType: "user" | "role";
	principalId: string;
	grantType: KnowledgeGrantType;
	clearanceLevel: string | null;
	tagId: string | null;
	canWrite: boolean;
	createdAt: string;
}

// ─── Entry links (entry-scope knowledge graph) ───
export type KnowledgeLinkType =
	| "related"
	| "expands"
	| "supersedes"
	| "depends_on"
	| "parent"
	| "mention"
	| "custom";

export type KnowledgeLinkDirection = "out" | "in" | "both";

/** Lightweight endpoint shape carried alongside a link (no body). */
export interface KnowledgeLinkEndpoint {
	id: string;
	title: string;
	slug: string;
	collectionId: string;
}

/** A link augmented with its endpoints + direction relative to the queried entry. */
export interface KnowledgeEntryLink {
	id: string;
	fromEntryId: string;
	toEntryId: string;
	linkType: KnowledgeLinkType;
	label: string | null;
	toRevisionId: string | null;
	createdByUserId: string | null;
	createdAt: string;
	/** Relative to the anchor entry: out = anchor is source, in = anchor is target. */
	direction: "out" | "in";
	fromEntry: KnowledgeLinkEndpoint;
	toEntry: KnowledgeLinkEndpoint;
}

export interface KnowledgeGraphNode extends KnowledgeLinkEndpoint {
	depth: number;
}

export interface KnowledgeGraphEdge {
	id: string;
	fromEntryId: string;
	toEntryId: string;
	linkType: KnowledgeLinkType;
	label: string | null;
}

export interface KnowledgeGraph {
	rootId: string;
	nodes: KnowledgeGraphNode[];
	edges: KnowledgeGraphEdge[];
}

// ─── Collection ACL + bulk grants (admin) ───

/** Collection ACL echo-back for the admin UI (GET /collections/:id/acl). */
export interface KnowledgeCollectionAcl {
	collectionId: string;
	name: string;
	slug: string;
	defaultLevel: string;
	/** Level gating access to the collection itself; null = public. */
	classificationLevel: string | null;
	/** Controlled tag ids required to read the collection (compartment axis). */
	controlledTags: string[];
	ownerUserId: string | null;
	/** Resolved owner display name, so the UI needn't fetch the user list for one id. */
	ownerUsername: string | null;
}

/** Per-user outcome of a bulk grant. `skipped` = the identical grant already existed. */
export interface KnowledgeBulkGrantResult {
	userId: string;
	status: "granted" | "skipped" | "failed";
	grantId?: string;
	reason?: string;
}

export interface KnowledgeBulkGrantResponse {
	ok: boolean;
	granted: number;
	skipped: number;
	failed: number;
	results: KnowledgeBulkGrantResult[];
}

/** Result of an ownership transfer (entry or collection). */
export interface KnowledgeTransferOwnerResult {
	ok: boolean;
	entryId?: string;
	collectionId?: string;
	ownerUserId: string | null;
}

// ─── Review inbox badge ───

/**
 * Bounded count of open submissions the caller may review.
 *
 * The server inspects at most `limit + 1` open rows instead of running an unbounded
 * COUNT(*), so `capped: true` means "at least `count`, possibly more" — render it as
 * `${count}+`.
 */
export interface KnowledgeReviewInboxCount {
	count: number;
	capped: boolean;
	limit: number;
}

// ─── Review state machine closure (withdraw / resubmit / scope) ───

/** Result of withdrawing an own open publish request. */
export interface KnowledgeWithdrawResult {
	submissionId: string;
	status: "withdrawn";
	draftId: string;
}

/**
 * The caller's own review authority, for the review-tab explainer.
 *
 * `isAdmin` short-circuits both axes (an admin reviews everything, so the lists are not
 * enumerated for them). `truncated` means the server hit its cap and the lists are partial.
 */
export interface KnowledgeReviewScope {
	isAdmin: boolean;
	/** Review grants held: a linked entry needs ALL of its review tags covered. */
	reviewTags: { id: string; name: string }[];
	/** Readable collections the caller may write into (→ may approve standalone publishes). */
	collections: { id: string; name: string; slug: string }[];
	truncated: boolean;
}
