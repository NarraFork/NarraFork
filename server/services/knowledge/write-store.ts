/**
 * The knowledge base's write capability, stated without a dialect.
 *
 * WHY THIS EXISTS
 * ---------------
 * The knowledge write paths used to open `db.transaction((tx) => …)` directly in five
 * service modules (knowledge-service, knowledge-branch-service, knowledge-acl,
 * knowledge-pack-activation, spec-vfs-service). That shape hard-codes bun:sqlite: the
 * transaction is synchronous, the conflict vocabulary is a message-text regex, and the
 * revision-version allocation is an unconstrained `MAX(version) + 1` that only SQLite's
 * single-writer transaction happened to make safe. A second backend cannot reproduce any
 * of those shapes — it can only satisfy the same business facts differently.
 *
 * So the facts are written here instead, in domain terms only: what goes in, what comes
 * out, and which failures are guaranteed to leave nothing behind. This file imports
 * nothing dialect-specific — no driver, no `server/db`, no schema. The one allowed
 * dependency is `lib/errors`: `ValidationError` is the domain vocabulary the guarded
 * operations already reject with, and both implementations must produce the same
 * instances so existing callers cannot tell which backend answered.
 *
 * THE CONTRACT EVERY OPERATION INHERITS (from `server/db/backend/write-port.ts`)
 * ------------------------------------------------------------------------------
 * 1. Methods return PROMISES. The SQLite implementation runs its atomic section
 *    STRICTLY SYNCHRONOUSLY inside the call (bun:sqlite commits when the transaction
 *    callback returns — an `await` inside is silent data loss, see
 *    `server/db/transaction-atomicity-contract.test.ts`); the Promise is a wrapper
 *    around an already-committed result. The PostgreSQL implementation runs a genuinely
 *    async section with `withPgRetry` around the WHOLE section as the retry unit.
 * 2. ATOMICITY IS PART OF THE CONTRACT. Each operation is all-or-nothing: it either
 *    returns with every write committed, or rejects having written nothing.
 * 3. CONFLICTS CROSS AS VOCABULARY. A uniqueness conflict arrives at the caller as
 *    `WriteConflictError` (with the constraint name when the backend reported one),
 *    never as a driver error and never as a message-text shape the caller must sniff.
 *    The idempotency-aware caller — the service — decides whether "already exists" is
 *    a validation error (slug race) or a no-op.
 * 4. POST-COMMIT SIDE EFFECTS STAY OUT. Event-bus emissions, notifications and audit
 *    records belong to the services AFTER the returned Promise resolves — the
 *    exactly-once boundary, because the PostgreSQL implementation may replay the whole
 *    section before resolving once.
 *
 * REVISION VERSION ALLOCATION
 * ---------------------------
 * `appendRevision` and `commitMergedRevision` allocate `knowledge_revisions.version`.
 * The allocation authority is the entry row itself: the SQLite implementation claims
 * `MAX(version) + 1` inside the same single-writer transaction that inserts (value-
 * for-value the counter claim — see `revision-version.ts`), and the PostgreSQL
 * implementation takes the entry row lock (`SELECT … FOR UPDATE`) before reading the
 * maximum, so concurrent allocators serialize on the row instead of racing to the same
 * number. No backend performs an unguarded check-then-insert.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a DAO over the knowledge tables. Reads live in the sibling read port
 * (`read-store.ts`); the search surface has its own port in `services/search/`.
 * Only the atomic sections and the conflict-sensitive inserts live here.
 */

/** A uniqueness conflict surfaced by a write port — re-exported so the services name
 *  one vocabulary type whether the backend was SQLite or PostgreSQL. */
export { WriteConflictError } from "@server/db/backend/write-port";

// ─────────────────────────────────────────────────────────────────────────────
// Row shapes (plain data, field-identical across backends)
// ─────────────────────────────────────────────────────────────────────────────

export interface KnowledgeCollectionRow {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	projectId: string | null;
	inheritProjectGate: boolean;
	defaultLevel: string;
	classificationLevel: string | null;
	controlledTagsJson: unknown;
	ownerUserId: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface KnowledgeDraftRow {
	id: string;
	entryId: string | null;
	authorUserId: string;
	name: string | null;
	title: string | null;
	targetCollectionId: string | null;
	baseRevisionId: string | null;
	keywordsJson: unknown;
	content: string;
	contentHash: string;
	format: string;
	status: string;
	createdAt: string;
	updatedAt: string;
}

export interface KnowledgeSubmissionRow {
	id: string;
	draftId: string;
	entryId: string | null;
	collectionId: string | null;
	title: string | null;
	submitterUserId: string;
	baseRevisionId: string | null;
	proposedContent: string;
	keywordsJson: unknown;
	changeNote: string | null;
	previousSubmissionId: string | null;
	round: number;
	status: string;
	reviewerUserId: string | null;
	verdict: string | null;
	findingsJson: unknown;
	reviewedAt: string | null;
	mergedRevisionId: string | null;
	createdAt: string;
}

export interface SpecNamespaceRow {
	id: string;
	narratorId: string;
	forkedFromNamespaceId: string | null;
	createdAt: string;
	updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared domain vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Submission statuses an author's own edit may auto-close as `superseded`.
 *
 * Deliberately `pending` ONLY. A `conflict` submission is NOT auto-closed: a conflict
 * means main and the proposal diverged and a human has to decide the merged text, so
 * silently dropping it when the author edits their draft would hide an unresolved
 * divergence. The author must withdraw it (or a reviewer must resolve it) explicitly.
 */
export const SUPERSEDABLE_SUBMISSION_STATUSES = ["pending"] as const;

/**
 * Statuses closed when the author RETIRES the personal entry itself.
 *
 * Broader than {@link SUPERSEDABLE_SUBMISSION_STATUSES} because the target is going
 * away, not just changing: a `conflict` has nothing left to resolve against, and a
 * `changes_requested` can no longer be acted on (its only transition, resubmit, has
 * become impossible), so leaving either open would strand it forever.
 */
export const CLOSED_ON_ENTRY_DELETE_STATUSES = [
	"pending",
	"conflict",
	"changes_requested",
] as const;

/** Statuses in which a submission can still be claimed by a reviewer. */
export const CLAIMABLE_SUBMISSION_STATUSES = ["pending", "conflict"] as const;

/** Statuses a submitter may withdraw. Nothing has been merged in any of them. */
export const WITHDRAWABLE_SUBMISSION_STATUSES = [
	"pending",
	"conflict",
	"changes_requested",
] as const;

/** Bounded scan for a draft's open submissions before auto-closing them. In practice
 *  the create guard keeps this at 1; the cap only bounds historical data. */
export const OPEN_SUBMISSION_SCAN_LIMIT = 20;

/** A submission auto-closed by a draft write, returned for POST-COMMIT notification
 *  (the service emits; the store never does). */
export interface InvalidatedSubmissionRef {
	id: string;
	submitterUserId: string;
}

/** One `acl_grants` row to insert. The knowledge layer thinks in credentials
 *  (clearance / tag / review) plus a canWrite flag; the service has already folded
 *  that vocabulary into unified-table rows before calling. */
export interface AclGrantRowWrite {
	id: string;
	scopeType: string;
	scopeId: string | null;
	principalType: string;
	principalId: string;
	capability: string;
	domainKind: string | null;
	domainValue: string | null;
	grantedBy: string | null;
	createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// spec:// VFS vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/** The protected-task lock rows the write section reads, projected to plain data. */
export interface SpecProtectedLockRow {
	id: string;
	textHash: string;
	text: string;
	status: string;
	completedAt: string | null;
	createdBy?: string;
}

/** One protected-task mutation detected inside the write section. The service owns
 *  the detection logic (injected per call) and the error wording; the store only
 *  carries the verdict across the boundary. */
export interface SpecProtectedMutation {
	kind: string;
	text: string;
	details: string;
}

/** Everything a tasks.json write needs the section to enforce, supplied by the
 *  caller as plain data + one pure detection closure (kept dialect-free so the
 *  port never imports the spec-task service, which is bound to the SQLite handle). */
export interface SpecTasksWriteHooks {
	/** Parsed tasks with precomputed text hashes (only `protected` ones create locks). */
	tasks: { text: string; status: string; protected: boolean; textHash: string }[];
	/** Pure detection over the lock rows the section just read. */
	detectProtectedMutations(locks: SpecProtectedLockRow[]): SpecProtectedMutation[];
	/** One-shot grant allowing the detected mutations to be applied anyway. */
	allowProtectedTaskMutation: boolean;
}

export type SpecFileWriteResult =
	| { ok: true }
	| { ok: false; protectedMutations: SpecProtectedMutation[] };

// ─────────────────────────────────────────────────────────────────────────────
// Operation inputs
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateCollectionWrite {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	projectId: string | null;
	ownerUserId: string | null;
	now: string;
}

export interface CreateEntryWrite {
	entryId: string;
	revisionId: string;
	collectionId: string;
	title: string;
	slug: string;
	content: string;
	format: string;
	contentHash: string;
	currentKeywords: string | null;
	tagsJson: unknown;
	keywordsJson: unknown;
	metadataJson: unknown;
	ownerUserId: string | null;
	changeNote: string | null;
	authorUserId: string | null;
	now: string;
}

/** Fields of the entry-metadata UPDATE. Only the fields being changed are set;
 *  the service has already normalized keywords/tags into storage shape. */
export interface UpdateEntryMetaWrite {
	entryId: string;
	title?: string;
	tagsJson?: unknown;
	keywordsJson?: unknown;
	currentKeywords?: string | null;
	metadataJson?: unknown;
	status?: string;
	now: string;
}

export interface AppendRevisionWrite {
	entryId: string;
	revisionId: string;
	content: string;
	format: string;
	contentHash: string;
	changeNote: string | null;
	authorUserId: string | null;
	now: string;
}

export interface RecordInjectionEventsWrite {
	narratorId: string;
	compactSeq: number;
	source: string;
	triggerMessageId: string | null;
	triggerToolCallId: string | null;
	now: string;
	/** Ids are pre-generated by the caller so a whole-section replay writes the
	 *  same rows instead of minting new identities. */
	hits: {
		id: string;
		entryId: string;
		entryRevisionId: string | null;
		summary: string | null;
	}[];
}

export interface GetOrCreateActiveDraftWrite {
	draftId: string;
	entryId: string;
	authorUserId: string;
	name: string | null;
	baseRevisionId: string | null;
	content: string;
	contentHash: string;
	now: string;
}

export interface UpdateDraftContentWrite {
	draftId: string;
	content: string;
	contentHash: string;
	name?: string;
	now: string;
}

export interface RebaseDraftContentWrite {
	draftId: string;
	content: string;
	contentHash: string;
	baseRevisionId: string | null;
	now: string;
}

export interface CreateSubmissionWrite {
	submissionId: string;
	draftId: string;
	entryId: string | null;
	collectionId: string | null;
	title: string | null;
	submitterUserId: string;
	baseRevisionId: string | null;
	proposedContent: string;
	keywordsJson: unknown;
	changeNote: string | null;
	previousSubmissionId: string | null;
	round: number;
	now: string;
}

export interface SetSubmissionVerdictWrite {
	submissionId: string;
	status: string;
	verdict: string;
	findingsJson: unknown;
	reviewerUserId: string;
	now: string;
}

export interface MarkSubmissionConflictWrite {
	submissionId: string;
	findingsJson: unknown;
	reviewerUserId: string;
	now: string;
}

export interface ApproveStandalonePublishWrite {
	submissionId: string;
	draftId: string;
	entryId: string;
	revisionId: string;
	collectionId: string;
	title: string;
	baseSlug: string;
	proposedContent: string;
	contentHash: string;
	keywords: string[];
	changeNote: string | null;
	baseRevisionId: string | null;
	submitterUserId: string;
	reviewerUserId: string;
	findingsJson: unknown;
	now: string;
}

export interface CommitMergedRevisionWrite {
	submissionId: string;
	draftId: string;
	entryId: string;
	revisionId: string;
	content: string;
	contentHash: string;
	changeNote: string | null;
	baseRevisionId: string | null;
	submitterUserId: string;
	reviewerUserId: string;
	now: string;
}

export interface RenameKnowledgeLevelWrite {
	levelId: string;
	updates: { name?: string; rank?: number; label?: string | null };
	/** When the level is being renamed: every BY-NAME reference is rewritten in the
	 *  same section (entries, collections both axes, clearance credential rows),
	 *  or a partial write would fail `rankOf` closed and lock the content to admins. */
	rename: { from: string; to: string } | null;
}

export interface RecordPackActivationWrite {
	activationId: string;
	whitelistDirId: string;
	packId: string;
	narratorId: string;
	extractDir: string;
	archiveHash: string;
	now: string;
}

export interface EnsureSpecNamespaceWrite {
	namespaceId: string;
	narratorId: string;
	now: string;
}

export interface WriteSpecFileRevisionWrite {
	namespaceId: string;
	path: string;
	content: string;
	contentHash: string;
	revisionId: string;
	/** Pre-generated id for the namespace-file row, used when none exists yet. */
	fileIdForCreate: string;
	sourceToolUseId: string | null;
	sourceMessageId: string | null;
	createdBy: string;
	now: string;
	/** Present exactly when `path` is tasks.json: parsed tasks + the detection hook. */
	specTasks?: SpecTasksWriteHooks;
}

export interface ForkSpecNamespaceWrite {
	parentNamespaceId: string;
	childNamespaceId: string;
	childNarratorId: string;
	now: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// P6: the remaining single-section writes (collection/entry lifecycle, entry
// links, ACL admin CRUD, audit). Each is at most a small fixed number of
// statements; multi-statement ones are one atomic section on both backends.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Field-level collection update: rename/description (the service's collection edit),
 * owner transfer, and the ACL-attribute edit (level / controlled tags) share ONE
 * method because they are the same UPDATE. A field ABSENT from the input is
 * untouched; a field present with `null` is set to NULL — the distinction between
 * "don't touch" and "clear" is the `undefined`/`null` gap, exactly as the services
 * built their conditional spreads.
 */
export interface UpdateCollectionFieldsWrite {
	collectionId: string;
	name?: string;
	/** Present-but-null clears the description. */
	description?: string | null;
	classificationLevel?: string | null;
	controlledTagsJson?: unknown;
	ownerUserId?: string | null;
	now: string;
}

/** Field-level entry ACL update: level, controlled tags, review tags, owner. */
export interface UpdateEntryAclFieldsWrite {
	entryId: string;
	classificationLevel?: string | null;
	controlledTagsJson?: unknown;
	reviewTagsJson?: unknown;
	ownerUserId?: string | null;
	now: string;
}

export interface CreateEntryLinkWrite {
	id: string;
	fromEntryId: string;
	toEntryId: string;
	linkType: string;
	label: string | null;
	toRevisionId: string | null;
	createdByUserId: string | null;
	now: string;
}

/** The link row as inserted (what `.returning()` produced on both backends). */
export interface KnowledgeEntryLinkRow {
	id: string;
	fromEntryId: string;
	toEntryId: string;
	linkType: string;
	label: string | null;
	toRevisionId: string | null;
	createdByUserId: string | null;
	createdAt: string;
}

export interface KnowledgeLevelRowWrite {
	id: string;
	name: string;
	rank: number;
	label: string | null;
	createdAt: string;
}

export interface KnowledgeTagRowWrite {
	id: string;
	collectionId: string | null;
	typeId: string | null;
	name: string;
	controlled: boolean;
	createdAt: string;
}

export interface KnowledgeTagTypeRowWrite {
	id: string;
	name: string;
	builtin: boolean;
	sortOrder: number;
	createdAt: string;
}

/**
 * One `acl_events` row, fully built by the caller (id + timestamp pre-generated so a
 * whole-section replay writes the same row). The audit path is fire-and-forget at
 * the SERVICE boundary; the store method itself is an ordinary one-row insert.
 */
export interface AclAuditEventWrite {
	id: string;
	actorUserId: string | null;
	actorRole: string | null;
	eventType: string;
	subjectType: string | null;
	subjectId: string | null;
	scopeType: string;
	scopeId: string | null;
	outcome: string;
	detailJson: unknown;
	createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The port
// ─────────────────────────────────────────────────────────────────────────────

export interface KnowledgeWriteStore {
	// ── collections ──
	/**
	 * Insert a collection. The slug pre-check lives in the caller; this insert is the
	 * last line of defence against the race, and a lost race rejects with
	 * `WriteConflictError` (never a raw driver error).
	 */
	createCollection(input: CreateCollectionWrite): Promise<KnowledgeCollectionRow>;

	// ── entries + revisions ──
	/**
	 * Insert an entry and its first revision (version 1) atomically. Entry first:
	 * `revisions.entryId` has the FK, `entries.currentRevisionId` deliberately does not.
	 * A lost slug race rejects with `WriteConflictError` and writes nothing.
	 */
	createEntryWithFirstRevision(input: CreateEntryWrite): Promise<void>;
	/** Single-statement entry metadata update (rename, tags, keywords, status). */
	updateEntryMeta(input: UpdateEntryMetaWrite): Promise<void>;
	/**
	 * Append a revision to main and switch the entry's current pointer, atomically with
	 * the version claim (see the header: entry-row authority, never an unguarded
	 * MAX+1). Returns the claimed version.
	 */
	appendRevision(input: AppendRevisionWrite): Promise<{ version: number }>;

	// ── injection events ──
	/**
	 * Record passive-injection hits, deduplicated on `(narratorId, compactSeq, entryId)`
	 * via `ON CONFLICT DO NOTHING` — the portable spelling both backends share (the
	 * SQLite spelling `INSERT OR IGNORE` is deliberately not used anywhere new).
	 * Empty `hits` is a no-op.
	 */
	recordInjectionEvents(input: RecordInjectionEventsWrite): Promise<void>;

	// ── drafts (personal entries) ──
	/**
	 * Atomic get-or-create of the caller's ACTIVE draft on an entry: the existence
	 * re-check happens inside the section, so two concurrent calls cannot both insert
	 * a second active draft. Returns the existing or the created row.
	 */
	getOrCreateActiveDraft(input: GetOrCreateActiveDraftWrite): Promise<KnowledgeDraftRow>;
	/**
	 * Archive a personal entry and close its unmerged publish requests as `withdrawn`
	 * (statuses: {@link CLOSED_ON_ENTRY_DELETE_STATUSES}) in the same section. Returns
	 * the closed rows for post-commit notification.
	 */
	archivePersonalEntry(input: {
		draftId: string;
		now: string;
	}): Promise<InvalidatedSubmissionRef[]>;
	/**
	 * Replace a draft's content and supersede its PENDING publish requests in the same
	 * section. Returns the superseded rows for post-commit notification.
	 */
	updateDraftContent(input: UpdateDraftContentWrite): Promise<InvalidatedSubmissionRef[]>;
	/**
	 * Persist a rebased draft (merged content + advanced fork point) and supersede its
	 * PENDING publish requests, mirroring {@link updateDraftContent}.
	 */
	rebaseDraftContent(input: RebaseDraftContentWrite): Promise<InvalidatedSubmissionRef[]>;

	// ── submissions (publish requests) ──
	/**
	 * Insert a publish request after re-checking INSIDE the section that the draft has
	 * no open (pending/conflict) request. Rejects with `ValidationError` naming the way
	 * out when one exists — the same error identity the SQLite path always produced.
	 */
	createSubmissionGuarded(input: CreateSubmissionWrite): Promise<KnowledgeSubmissionRow>;
	/** Record a non-merge verdict (request_changes / reject / comment_only). */
	setSubmissionReviewVerdict(input: SetSubmissionVerdictWrite): Promise<void>;
	/**
	 * Mark a submission `conflict` after re-checking inside the section that it is still
	 * claimable; rejects with `ValidationError` when another reviewer already closed it.
	 */
	markSubmissionConflict(input: MarkSubmissionConflictWrite): Promise<void>;
	/**
	 * Approve a STANDALONE publish: create the global entry + first revision (resolving
	 * a unique slug inside the section), link + archive the personal entry, and mark the
	 * submission approved — all atomically, guarded against a second reviewer.
	 */
	approveStandalonePublish(input: ApproveStandalonePublishWrite): Promise<void>;
	/**
	 * Append the merged content as a new main revision (version claimed under the entry
	 * row's authority), switch the entry pointer, archive the draft and mark the
	 * submission approved — all atomically, guarded against a second reviewer.
	 * Returns the claimed version.
	 */
	commitMergedRevision(input: CommitMergedRevisionWrite): Promise<{ version: number }>;
	/**
	 * Withdraw an open publish request after re-checking its status inside the section.
	 * Returns false when another reviewer already closed it (the caller turns that into
	 * the same `ValidationError` the SQLite path produced).
	 */
	withdrawSubmissionGuarded(input: {
		submissionId: string;
		changeNote?: string;
		now: string;
	}): Promise<boolean>;

	// ── ACL ──
	/** Update a level row plus, on rename, every BY-NAME reference — one section. */
	renameKnowledgeLevel(input: RenameKnowledgeLevelWrite): Promise<void>;
	/**
	 * Insert pre-folded `acl_grants` rows as one section (either every row lands or
	 * none does). A duplicate credential rejects with `WriteConflictError`.
	 */
	insertAclGrantRows(rows: AclGrantRowWrite[]): Promise<void>;
	/**
	 * Replace one principal's knowledge-scoped grants: delete every knowledge-scope row
	 * for the principal (project/narrator memberships are other scopes and untouched),
	 * then insert the replacement set — one section.
	 */
	replaceUserKnowledgeGrants(input: {
		principalType: string;
		principalId: string;
		rows: AclGrantRowWrite[];
	}): Promise<void>;

	// ── pack activation ──
	/**
	 * Record a pack activation: replace any prior whitelist row for (narrator, dir),
	 * insert the readWrite whitelist row and the activation row — one section, so the
	 * agent never holds a whitelist entry whose activation record is missing.
	 */
	recordPackActivation(input: RecordPackActivationWrite): Promise<void>;
	/** Release an activation: drop the whitelist row and mark the row released. */
	releasePackActivation(input: {
		activationId: string;
		whitelistDirId: string | null;
		now: string;
	}): Promise<void>;

	// ── spec:// VFS ──
	/**
	 * Get-or-create the narrator's spec namespace. A lost create race returns the
	 * winner's row (re-read after the conflict), never an error.
	 */
	ensureSpecNamespace(input: EnsureSpecNamespaceWrite): Promise<SpecNamespaceRow>;
	/**
	 * Append a file revision and switch the namespace file's current pointer (creating
	 * the file row on first write), touch the namespace, and — for tasks.json — enforce
	 * the protected-task locks: detect mutations first (rejecting with
	 * `{ ok: false, protectedMutations }` when not explicitly allowed, having written
	 * nothing), then sync the locks to the new document.
	 */
	writeSpecFileRevision(input: WriteSpecFileRevisionWrite): Promise<SpecFileWriteResult>;
	/** Mark a namespace file deleted (single statement). */
	markSpecFileDeleted(input: { fileId: string; now: string }): Promise<void>;
	/**
	 * Fork a namespace: create the child (unless it already exists — `{ created: false }`)
	 * and copy the parent's live file pointers and protected-task locks, one section.
	 */
	forkSpecNamespace(input: ForkSpecNamespaceWrite): Promise<{ created: boolean }>;
	/** Reset a namespace: drop all file rows and release every open protected-task lock. */
	resetSpecNamespace(input: { namespaceId: string; now: string }): Promise<void>;

	// ── collections / entries: the remaining lifecycle writes ──
	/**
	 * Single-statement collection field update (rename, description, owner transfer,
	 * ACL attributes — see {@link UpdateCollectionFieldsWrite} for the null/undefined
	 * rule). The audit/event side effects stay with the service, post-commit.
	 */
	updateCollectionFields(input: UpdateCollectionFieldsWrite): Promise<void>;
	/**
	 * Delete a collection row. The entries/revisions/links inside it are removed by
	 * the FK cascade on BOTH backends (the schemas declare the same `onDelete`
	 * actions); the PostgreSQL FTS shadow rows go with the trigger-owned
	 * delete path, so a deleted collection never leaves searchable ghosts.
	 */
	deleteCollection(input: { collectionId: string }): Promise<void>;
	/** Single-statement entry ACL-field update (level / tags / owner transfer). */
	updateEntryAclFields(input: UpdateEntryAclFieldsWrite): Promise<void>;
	/**
	 * Delete an entry row; revisions, links and drafts cascade via FK. The FTS shadow
	 * row is removed by the delete trigger on the same statement's commit, so a
	 * deleted entry immediately stops matching search.
	 */
	deleteEntry(input: { entryId: string }): Promise<void>;

	// ── entry links ──
	/**
	 * Insert an entry link. The (from, to, linkType) unique index makes a lost
	 * dedup race reject with `WriteConflictError`; the service maps that to the same
	 * validation error its pre-check raises.
	 */
	createEntryLink(input: CreateEntryLinkWrite): Promise<KnowledgeEntryLinkRow>;
	/** Remove a link by id (single statement). */
	deleteEntryLink(input: { linkId: string }): Promise<void>;

	// ── ACL admin CRUD ──
	/** Insert a level row. A name/rank conflict crosses as `WriteConflictError`. */
	insertKnowledgeLevel(input: {
		id: string;
		name: string;
		rank: number;
		label: string | null;
		now: string;
	}): Promise<KnowledgeLevelRowWrite>;
	/** Delete a level row (the reference pre-check is the service's read-side job). */
	deleteKnowledgeLevel(input: { levelId: string }): Promise<void>;
	insertKnowledgeTag(input: {
		id: string;
		name: string;
		collectionId: string | null;
		typeId: string | null;
		controlled: boolean;
		now: string;
	}): Promise<KnowledgeTagRowWrite>;
	updateKnowledgeTag(input: {
		tagId: string;
		name?: string;
		controlled?: boolean;
		typeId?: string | null;
	}): Promise<void>;
	deleteKnowledgeTag(input: { tagId: string }): Promise<void>;
	insertKnowledgeTagType(input: {
		id: string;
		name: string;
		sortOrder: number;
		now: string;
	}): Promise<KnowledgeTagTypeRowWrite>;
	updateKnowledgeTagType(input: {
		tagTypeId: string;
		name?: string;
		sortOrder?: number;
	}): Promise<void>;
	deleteKnowledgeTagType(input: { tagTypeId: string }): Promise<void>;
	/**
	 * Delete one grant row by id, and — in the same atomic section, when the caller
	 * determined the row is a credential carrying a write sibling — the sibling
	 * (scope, principal, capability=write, no domain) row. On SQLite this was
	 * historically two sequential deletes; making them one section is the same
	 * visible outcome with strictly fewer partial-failure shapes.
	 */
	deleteAclGrantWithWriteSibling(input: {
		grantId: string;
		writeSibling: {
			scopeType: string;
			scopeId: string | null;
			principalType: string;
			principalId: string;
		} | null;
	}): Promise<void>;
	/**
	 * Remove ALL knowledge-scoped grants of one principal (user deletion purge).
	 * Project/narrator memberships are other scopes and survive.
	 */
	deleteUserKnowledgeGrants(input: { principalType: string; principalId: string }): Promise<void>;

	// ── audit ──
	/** Append one audit row. The service owns the fire-and-forget policy. */
	insertAclAuditEvent(row: AclAuditEventWrite): Promise<void>;
}
