// Knowledge base API types — mirror server/db/schema.ts knowledge_* tables
// and the service return shapes.

export type KnowledgeFormat = "markdown" | "text" | "json";
export type KnowledgeEntryStatus = "active" | "archived";
// Personal-entry lifecycle. The publish-request lifecycle lives on
// knowledge_submissions, so a personal entry itself is only in use or retired.
// Mirrors knowledge_drafts.status in server/db/schema.ts.
export type KnowledgeDraftStatus = "active" | "archived";
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
/**
 * Reviewer verdicts. `reject` is the terminal refusal (status → `rejected`, no resubmit);
 * `request_changes` bounces the request back for another round.
 */
export type KnowledgeVerdict = "approve" | "request_changes" | "reject" | "comment_only";
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

/**
 * What the requesting user may do with one collection, as decided by the server
 * (GET /knowledge/collections). Each flag mirrors the gate of the endpoint named beside it;
 * the UI shows actions from these bits instead of re-deriving the ACL.
 */
export interface KnowledgeCollectionViewerCaps {
	/** PATCH /collections/:id (rename / description). */
	canEdit: boolean;
	/** PATCH /collections/:id/acl (level / controlled tags). */
	canManageAcl: boolean;
	/** POST /collections/:id/transfer-owner. */
	canTransferOwner: boolean;
	/** DELETE /collections/:id. */
	canDelete: boolean;
	/** POST /entries into this collection. */
	canCreateEntry: boolean;
}

/** A row of GET /knowledge/collections: the collection plus the caller's capability bits. */
export interface KnowledgeCollectionListItem extends KnowledgeCollection {
	viewerCaps: KnowledgeCollectionViewerCaps;
}

/**
 * What the requesting user may do with one entry, as decided by the server
 * (GET /knowledge/entries/:id). Each flag mirrors the gate of the endpoint named beside it.
 */
export interface KnowledgeEntryViewerCaps {
	/** POST /entries/:id/revisions — direct edit of main. */
	canWriteMain: boolean;
	/** PATCH /entries/:id — title / tags / keywords / status. */
	canEditMeta: boolean;
	/** PATCH /entries/:id/acl — level / controlled tags / review tags. */
	canManageAcl: boolean;
	/** POST /entries/:id/transfer-owner. */
	canTransferOwner: boolean;
	/** DELETE /entries/:id. */
	canDelete: boolean;
	/** May review linked publish requests on this entry (own requests excepted). */
	canReview: boolean;
	/** POST /entries/:id/links (this entry as source); incoming links carry `canRemove`. */
	canManageLinks: boolean;
	/** The caller's active personal version of this entry, if any. */
	myPersonalEntryId: string | null;
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

/** GET /knowledge/entries/:id: the full entry plus the caller's capability bits. */
export interface KnowledgeEntryDetail extends KnowledgeEntry {
	/** Display name of `ownerUserId` (null when unowned or the user is gone). */
	ownerUsername: string | null;
	/** Version number of the newest revision (null before the first one). */
	currentVersion: number | null;
	viewerCaps: KnowledgeEntryViewerCaps;
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

/**
 * One page of GET /knowledge/entries in paged mode (`limit` and/or `cursor` sent).
 * List rows carry `tagsJson`; FTS search rows (when `q` is set) carry `tags` + `snippet`.
 * `nextCursor` is null once exhausted; a non-null cursor may accompany a short or even
 * empty page (ACL filtering within the server's per-request scan budget).
 */
export interface KnowledgeEntryPage {
	items: KnowledgeEntryListItem[];
	nextCursor: string | null;
}

/** Per-row annotations of the paged list (owner name, the caller's personal version). */
export interface KnowledgeEntryListAnnotations {
	ownerUsername: string | null;
	myPersonalEntryId: string | null;
	/** The personal version forked from an older main revision (list rows only; search rows
	 *  carry no revision id, so this stays false there). */
	myPersonalEntryBehindMain: boolean;
}

/** A row of the paged entry list: a list row, or (with `q`) a search row with owner + level. */
export type KnowledgeEntryListItem = KnowledgeEntryListAnnotations &
	(
		| KnowledgeEntry
		| (KnowledgeSearchResult & { ownerUserId: string | null; classificationLevel: string | null })
	);

/** `sort` of the browse list: `relevance` applies only with a search query. */
export type KnowledgeEntrySort = "updated" | "title" | "relevance";

/**
 * A revision's METADATA, as returned by the history list.
 *
 * The body is deliberately absent: a list of N versions of a large document would otherwise ship
 * N full bodies. Use `getKnowledgeRevision(id)` for the content of the specific versions you need
 * (e.g. the two sides of a diff).
 */
export interface KnowledgeRevisionSummary {
	id: string;
	entryId: string;
	version: number;
	format: KnowledgeFormat;
	contentHash: string;
	changeNote: string | null;
	authorUserId: string | null;
	authorNarratorId?: string | null;
	baseRevisionId: string | null;
	createdAt: string;
	/** Body size in characters — computed in SQL; the body itself is not included. */
	contentLength: number;
}

/** A single revision WITH its body (single-revision fetch). */
export interface KnowledgeRevision extends Omit<KnowledgeRevisionSummary, "contentLength"> {
	content: string;
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
 * A personal-library entry (the knowledge_drafts row under the personal-library model)
 * WITHOUT its body. `entryId` null = standalone (no global counterpart yet); set = linked
 * to a global entry.
 *
 * The list endpoint (`GET /personal-entries`) returns this shape: it projects the `content`
 * blob away in SQL and reports `contentLength` instead, so a library listing never carries
 * N full document bodies. Use {@link KnowledgePersonalEntry} for single-entry reads.
 */
export interface KnowledgePersonalEntrySummary {
	id: string;
	entryId: string | null;
	authorUserId: string;
	name: string | null;
	title: string | null;
	targetCollectionId: string | null;
	baseRevisionId: string | null;
	/** Body size in characters — computed in SQL; the body itself is not returned. */
	contentLength: number;
	contentHash: string;
	format: KnowledgeFormat;
	/** Author-declared keywords (standalone personal entries) for passive auto-injection. */
	keywordsJson: string[] | null;
	status: "active" | "archived";
	createdAt: string;
	updatedAt: string;
	/**
	 * True when this is a LINKED personal entry whose fork point is no longer main's current
	 * revision — i.e. it needs a rebase. Resolved for the whole page in one query by the list
	 * endpoint, so the badge costs nothing extra. Always false for standalone entries (no main).
	 */
	drifted?: boolean;
	/** Linked: the global entry's title — null when the caller can no longer read it. */
	entryTitle?: string | null;
	/** Standalone: the publish target's name — null when unset or not readable. */
	targetCollectionName?: string | null;
}

/**
 * A single personal-library entry WITH its body, as returned by the detail / create /
 * update endpoints. The editor needs the body; list views deliberately do not (see
 * {@link KnowledgePersonalEntrySummary}).
 */
export interface KnowledgePersonalEntry
	extends Omit<KnowledgePersonalEntrySummary, "contentLength"> {
	content: string;
}

/** Why a personal entry cannot be submitted right now (server `personalEntrySubmitBlockers`). */
export type KnowledgePersonalSubmitBlocker =
	| "archived"
	| "missing_target"
	| "missing_title"
	| "open_request";

/**
 * What the owner may do with one personal version — each flag is the gate of the endpoint it
 * stands for (edit body, edit standalone metadata, rebase, delete, submit).
 */
export interface KnowledgePersonalEntryViewerCaps {
	canEdit: boolean;
	canEditMeta: boolean;
	canRebase: boolean;
	canDelete: boolean;
	canSubmit: boolean;
	submitBlockers: KnowledgePersonalSubmitBlocker[];
}

/** `GET /personal-entries/:id`: the personal-version page payload. */
export interface KnowledgePersonalEntryDetail extends KnowledgePersonalEntry {
	/** Linked and readable only. */
	entryTitle: string | null;
	/** Linked and readable only: the diff baseline. */
	currentMainContent: string | null;
	/** Linked and readable only. */
	drift: { drifted: boolean; versionsBehind: number } | null;
	targetCollectionName: string | null;
	/** Requests a delete would close (pending / conflict / changes requested), newest first. */
	openSubmissions: {
		id: string;
		status: KnowledgeSubmissionStatus;
		round: number;
		createdAt: string;
	}[];
	viewerCaps: KnowledgePersonalEntryViewerCaps;
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

/**
 * A reviewer-list row (`GET /submissions`) with ACL-checked display metadata for the review
 * inbox. `entryTitle` / `collectionName` are null when the caller cannot read them.
 */
export interface KnowledgeSubmissionListItem extends KnowledgeSubmission {
	entryTitle: string | null;
	/** Linked → the entry's collection; standalone → the publish target. */
	targetCollectionId: string | null;
	collectionName: string | null;
	submitterUsername: string | null;
	/** Open linked request based on a stale main; null when unknown / not applicable. */
	drifted: boolean | null;
}

/**
 * What the caller may do with one publish request. Computed server-side by the same functions
 * the action endpoints use — the request page never infers these from role or identity.
 */
export interface KnowledgeSubmissionViewerCaps {
	isSubmitter: boolean;
	/** A verdict is accepted (at least comment-only). */
	canReview: boolean;
	/** `approve` is accepted (pending only; a conflict is resolved instead). */
	canApprove: boolean;
	canResolveConflict: boolean;
	canWithdraw: boolean;
	canResubmit: boolean;
}

/** One round of the same proposal (same personal version and target). */
export interface KnowledgeSubmissionHistoryItem {
	id: string;
	changeNote: string | null;
	round?: number;
	status: KnowledgeSubmissionStatus;
	verdict: KnowledgeVerdict | null;
	findingsJson: KnowledgeFinding[] | null;
	reviewerUserId: string | null;
	reviewerUsername: string | null;
	reviewedAt: string | null;
	createdAt: string;
}

/** `GET /submissions/:id`: the request page's whole payload. */
export interface KnowledgeSubmissionDetail extends KnowledgeSubmission {
	/** Unified diff base → proposed. */
	diff: string;
	/** The fork point the proposal was made against ("" for standalone). */
	baseContent: string;
	/** Current main; null for standalone or when the caller cannot read the entry. */
	currentMainContent: string | null;
	entryTitle: string | null;
	targetCollectionId: string | null;
	collectionName: string | null;
	submitterUsername: string | null;
	reviewerUsername: string | null;
	/** Linked and readable only. */
	drift: { drifted: boolean; versionsBehind: number } | null;
	/** Rounds of this proposal, newest first (includes this request). */
	history: KnowledgeSubmissionHistoryItem[];
	viewerCaps: KnowledgeSubmissionViewerCaps;
}

/**
 * Submitting reports back whether the proposal was built on a STALE main revision.
 *
 * Not an error: approve three-way-merges a drifted base and usually succeeds. But the author
 * is the only one who knows what their edit meant, so they get told while they can still
 * rebase cheaply — rather than the reviewer discovering the conflict at approve time.
 * Absent (null) = the proposal is based on current main.
 */
export interface KnowledgeSubmitDriftWarning {
	versionsBehind: number;
	baseRevisionId: string;
	currentRevisionId: string;
}

export interface KnowledgeSubmitResult extends KnowledgeSubmission {
	driftWarning: KnowledgeSubmitDriftWarning | null;
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

/**
 * A verdict on the caller's own submission, for the notification bell.
 *
 * Deliberately has no title, change note, or proposed content. Those can carry
 * classified text; the bell links to the entry, which re-checks read access.
 */
export interface KnowledgeSubmissionOutcome {
	id: string;
	draftId: string;
	entryId: string | null;
	status: Extract<KnowledgeSubmissionStatus, "approved" | "rejected" | "changes_requested">;
	verdict: KnowledgeVerdict | null;
	findingsJson: KnowledgeFinding[] | null;
	reviewedAt: string | null;
	/** When the author opened this verdict. Null = still unread (counted by the bell). */
	authorReadAt: string | null;
	createdAt: string;
}

/** Unread verdicts on the caller's own submissions, for the bell badge. */
export interface KnowledgeSubmissionOutcomeUnreadCount {
	count: number;
	capped: boolean;
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
	/** DELETE /links/:id would be accepted (the gate on the link's source entry). */
	canRemove: boolean;
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
	/**
	 * Entries the caller OWNS. Ownership is a third review path (canReview short-circuits on it),
	 * so someone with no grants at all may still review proposals on their own entries.
	 */
	ownedEntryCount: number;
	truncated: boolean;
}
