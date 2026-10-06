/**
 * SQLite implementation of `KnowledgeWriteStore`.
 *
 * Every atomic section below is a STRICTLY SYNCHRONOUS `db.transaction` callback, and
 * that is not a style choice: `bun:sqlite` commits when the callback RETURNS, so an
 * `async` callback commits at its first `await` and every statement after it runs in
 * autocommit (see `server/db/transaction-atomicity-contract.test.ts`). The store
 * methods are `async` on the OUTSIDE — the caller only ever sees a Promise — while
 * the section between BEGIN and COMMIT contains no `await` at all. This is also why
 * callers that fire-and-forget (the injection-events recorder) keep their historical
 * synchronous-write behavior: the section has already committed by the time the
 * Promise exists.
 *
 * Two backend-specific concerns live here and nowhere else:
 *
 *   - RETRY: the sections that allocate a revision version or resolve a publish slug
 *     are wrapped in `withDbRetry` (SQLITE_BUSY-style transient contention), keeping
 *     the exact labels/retry counts the services used before the port existed.
 *   - CONFLICT TRANSLATION: a uniqueness violation is recognized STRUCTURALLY — the
 *     driver reports the extended result code on `errno` (1555 primary-key, 2067
 *     unique) — and translated to `WriteConflictError` before it can cross the port
 *     boundary. No message-text sniffing decides anything; the message is only read
 *     afterwards, for the column detail the error carries.
 *
 * The PostgreSQL implementation of the same port lives in `postgres-write-store.ts`
 * and is genuinely async. What the two share is this file's SECTION CONTENT — the
 * reads, guards and writes in the same order — never its driver shapes.
 */

import { WriteConflictError } from "@server/db/backend/write-port";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "../../db";
import {
	aclEvents,
	aclGrants,
	knowledgeCollections,
	knowledgeDrafts,
	knowledgeEntries,
	knowledgeEntryLinks,
	knowledgeInjectionEvents,
	knowledgeLevels,
	knowledgePackActivations,
	knowledgeRevisions,
	knowledgeSubmissions,
	knowledgeTags,
	knowledgeTagTypes,
	narratorWhitelistDirs,
	specFileRevisions,
	specNamespaceFiles,
	specNamespaces,
	specProtectedTasks,
} from "../../db/schema";
import { withDbRetry } from "../../lib/db-resilience";
import { ValidationError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { claimNextRevisionVersion, type KnowledgeWriteTx } from "./revision-version";
import type {
	AclAuditEventWrite,
	AclGrantRowWrite,
	AppendRevisionWrite,
	ApproveStandalonePublishWrite,
	CommitMergedRevisionWrite,
	CreateCollectionWrite,
	CreateEntryLinkWrite,
	CreateEntryWrite,
	CreateSubmissionWrite,
	EnsureSpecNamespaceWrite,
	ForkSpecNamespaceWrite,
	GetOrCreateActiveDraftWrite,
	InvalidatedSubmissionRef,
	KnowledgeCollectionRow,
	KnowledgeDraftRow,
	KnowledgeEntryLinkRow,
	KnowledgeLevelRowWrite,
	KnowledgeSubmissionRow,
	KnowledgeTagRowWrite,
	KnowledgeTagTypeRowWrite,
	KnowledgeWriteStore,
	MarkSubmissionConflictWrite,
	RebaseDraftContentWrite,
	RecordInjectionEventsWrite,
	RecordPackActivationWrite,
	RenameKnowledgeLevelWrite,
	SetSubmissionVerdictWrite,
	SpecFileWriteResult,
	SpecNamespaceRow,
	SpecProtectedLockRow,
	UpdateCollectionFieldsWrite,
	UpdateDraftContentWrite,
	UpdateEntryAclFieldsWrite,
	UpdateEntryMetaWrite,
	WriteSpecFileRevisionWrite,
} from "./write-store";
import {
	CLAIMABLE_SUBMISSION_STATUSES,
	CLOSED_ON_ENTRY_DELETE_STATUSES,
	OPEN_SUBMISSION_SCAN_LIMIT,
	SUPERSEDABLE_SUBMISSION_STATUSES,
	WITHDRAWABLE_SUBMISSION_STATUSES,
} from "./write-store";

/** Transaction handle as produced by `db.transaction((tx) => …`. SQLite-side only. */
type Tx = KnowledgeWriteTx;

/**
 * Extended result codes the driver puts on `errno` for a uniqueness conflict (the
 * engine's own names for 1555 / 2067 are its CONSTRAINT_PRIMARYKEY and
 * CONSTRAINT_UNIQUE codes; the constants stay engine-neutral in spelling so the
 * dialect ledger keeps pointing at the single raw-handle user).
 */
const CONSTRAINT_PRIMARYKEY_ERRNO = 1555;
const CONSTRAINT_UNIQUE_ERRNO = 2067;
/** How deep `cause` chains are followed when looking for the driver error. */
const MAX_CAUSE_DEPTH = 8;

/**
 * True only for a uniqueness conflict, read off the driver's structured `errno` —
 * never off message text. The two codes above are the entire uniqueness family;
 * other constraint failures (foreign keys, checks) are NOT port conflicts and pass
 * through untouched.
 */
function isSqliteUniqueViolation(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (!current || typeof current !== "object") return false;
		const errno = (current as Record<string, unknown>).errno;
		if (errno === CONSTRAINT_PRIMARYKEY_ERRNO || errno === CONSTRAINT_UNIQUE_ERRNO) {
			return true;
		}
		current = (current as Record<string, unknown>).cause;
	}
	return false;
}

/**
 * The column detail of a uniqueness violation, for the error's `constraint` field.
 * SQLite has no constraint NAME to report (that vocabulary is PostgreSQL's), so the
 * "table.column" list from the message is the closest honest detail; null when the
 * message has another shape.
 */
function extractConstraintDetail(error: unknown): string | null {
	const message = error instanceof Error ? error.message : String(error);
	const match = /UNIQUE constraint failed: (.+)/i.exec(message);
	return match?.[1]?.trim() || null;
}

/**
 * Translate a uniqueness violation into port vocabulary; everything else passes
 * through. The original error rides as `cause`, so no diagnostic information is lost.
 */
function rethrowAsPortError(error: unknown): never {
	if (isSqliteUniqueViolation(error)) {
		throw new WriteConflictError("write conflicts with an existing row", {
			constraint: extractConstraintDetail(error),
			cause: error,
		});
	}
	throw error;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared section helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Close the draft's open PENDING submissions as `superseded` and return the affected
 * rows. `superseded` (not `rejected`) is the whole point: it distinguishes "the author
 * replaced the proposed content" from "a reviewer refused it". Bounded by
 * OPEN_SUBMISSION_SCAN_LIMIT; the returned rows are for POST-COMMIT event emission.
 */
function supersedeOpenSubmissions(
	tx: Tx,
	draftId: string,
	now: string,
): InvalidatedSubmissionRef[] {
	const stale = tx
		.select({
			id: knowledgeSubmissions.id,
			submitterUserId: knowledgeSubmissions.submitterUserId,
		})
		.from(knowledgeSubmissions)
		.where(
			and(
				eq(knowledgeSubmissions.draftId, draftId),
				inArray(knowledgeSubmissions.status, [...SUPERSEDABLE_SUBMISSION_STATUSES]),
			),
		)
		.limit(OPEN_SUBMISSION_SCAN_LIMIT)
		.all();
	if (stale.length === 0) return stale;
	tx.update(knowledgeSubmissions)
		.set({ status: "superseded", reviewedAt: now })
		.where(
			and(
				eq(knowledgeSubmissions.draftId, draftId),
				inArray(knowledgeSubmissions.status, [...SUPERSEDABLE_SUBMISSION_STATUSES]),
			),
		)
		.run();
	return stale;
}

/** The whole createEntry section, extracted so it is one readable synchronous unit. */
function createEntrySection(tx: Tx, input: CreateEntryWrite): void {
	// Insert the entry first: revisions.entryId has an FK to entries, and
	// entries.currentRevisionId has no FK (avoids a circular dependency), so this order
	// satisfies both constraints.
	tx.insert(knowledgeEntries)
		.values({
			id: input.entryId,
			collectionId: input.collectionId,
			title: input.title,
			slug: input.slug,
			currentRevisionId: input.revisionId,
			currentContent: input.content,
			currentKeywords: input.currentKeywords,
			tagsJson: input.tagsJson,
			keywordsJson: input.keywordsJson,
			metadataJson: input.metadataJson,
			ownerUserId: input.ownerUserId,
			status: "active",
			createdAt: input.now,
			updatedAt: input.now,
		})
		.run();
	tx.insert(knowledgeRevisions)
		.values({
			id: input.revisionId,
			entryId: input.entryId,
			version: 1,
			format: input.format as "markdown",
			content: input.content,
			contentHash: input.contentHash,
			changeNote: input.changeNote,
			authorUserId: input.authorUserId,
			createdAt: input.now,
		})
		.run();
}

/** The appendRevision section: version claim + revision insert + pointer switch. */
function appendRevisionSection(tx: Tx, input: AppendRevisionWrite): number {
	// The version is claimed INSIDE the transaction so the MAX(version) read and the
	// insert are atomic — two concurrent writers can't both pick the same version (see
	// revision-version.ts for the claim's authority and its frozen counter design).
	const nextVersion = claimNextRevisionVersion(tx, input.entryId);
	tx.insert(knowledgeRevisions)
		.values({
			id: input.revisionId,
			entryId: input.entryId,
			version: nextVersion,
			format: input.format as "markdown",
			content: input.content,
			contentHash: input.contentHash,
			changeNote: input.changeNote,
			authorUserId: input.authorUserId,
			baseRevisionId: null,
			createdAt: input.now,
		})
		.run();
	tx.update(knowledgeEntries)
		.set({
			currentRevisionId: input.revisionId,
			currentContent: input.content,
			updatedAt: input.now,
		})
		.where(eq(knowledgeEntries.id, input.entryId))
		.run();
	return nextVersion;
}

/** The approveStandalone section: guard → slug resolution → entry+revision → close. */
function approveStandaloneSection(tx: Tx, input: ApproveStandalonePublishWrite): void {
	const fresh = tx
		.select({ status: knowledgeSubmissions.status })
		.from(knowledgeSubmissions)
		.where(eq(knowledgeSubmissions.id, input.submissionId))
		.get();
	if (!fresh || !(CLAIMABLE_SUBMISSION_STATUSES as readonly string[]).includes(fresh.status)) {
		throw new ValidationError("Submission was already reviewed by someone else");
	}

	// Resolve a unique slug within the collection (append -2, -3, … on collision).
	let slug = input.baseSlug;
	let n = 1;
	while (
		tx
			.select({ id: knowledgeEntries.id })
			.from(knowledgeEntries)
			.where(
				and(eq(knowledgeEntries.collectionId, input.collectionId), eq(knowledgeEntries.slug, slug)),
			)
			.get()
	) {
		n += 1;
		slug = `${input.baseSlug}-${n}`;
	}

	tx.insert(knowledgeEntries)
		.values({
			id: input.entryId,
			collectionId: input.collectionId,
			title: input.title,
			slug,
			currentRevisionId: input.revisionId,
			currentContent: input.proposedContent,
			tagsJson: [],
			keywordsJson: input.keywords,
			currentKeywords: input.keywords.length > 0 ? input.keywords.join(" ") : null,
			ownerUserId: input.submitterUserId,
			status: "active",
			createdAt: input.now,
			updatedAt: input.now,
		})
		.run();
	tx.insert(knowledgeRevisions)
		.values({
			id: input.revisionId,
			entryId: input.entryId,
			version: 1,
			format: "markdown",
			content: input.proposedContent,
			contentHash: input.contentHash,
			changeNote: input.changeNote,
			authorUserId: input.submitterUserId,
			createdAt: input.now,
		})
		.run();
	tx.update(knowledgeSubmissions)
		.set({
			status: "approved",
			entryId: input.entryId,
			reviewerUserId: input.reviewerUserId,
			reviewedAt: input.now,
			findingsJson: input.findingsJson,
			mergedRevisionId: input.revisionId,
		})
		.where(eq(knowledgeSubmissions.id, input.submissionId))
		.run();
	// Link the personal entry to the new global entry and archive it (published).
	tx.update(knowledgeDrafts)
		.set({ entryId: input.entryId, status: "archived", updatedAt: input.now })
		.where(eq(knowledgeDrafts.id, input.draftId))
		.run();
}

/** The commitMergedRevision section: guard → version claim → revision → close. */
function commitMergedRevisionSection(tx: Tx, input: CommitMergedRevisionWrite): number {
	// Re-read the submission status INSIDE the transaction and refuse to proceed unless
	// it is still claimable: a concurrent reviewer who already merged flips the status
	// to "approved", and this guard then aborts (no duplicate revision).
	const fresh = tx
		.select({ status: knowledgeSubmissions.status })
		.from(knowledgeSubmissions)
		.where(eq(knowledgeSubmissions.id, input.submissionId))
		.get();
	if (!fresh || !(CLAIMABLE_SUBMISSION_STATUSES as readonly string[]).includes(fresh.status)) {
		throw new ValidationError("Submission was already reviewed by someone else");
	}

	const nextVersion = claimNextRevisionVersion(tx, input.entryId);
	tx.insert(knowledgeRevisions)
		.values({
			id: input.revisionId,
			entryId: input.entryId,
			version: nextVersion,
			format: "markdown",
			content: input.content,
			contentHash: input.contentHash,
			changeNote: input.changeNote,
			authorUserId: input.submitterUserId,
			baseRevisionId: input.baseRevisionId,
			createdAt: input.now,
		})
		.run();
	tx.update(knowledgeEntries)
		.set({
			currentRevisionId: input.revisionId,
			currentContent: input.content,
			updatedAt: input.now,
		})
		.where(eq(knowledgeEntries.id, input.entryId))
		.run();
	tx.update(knowledgeSubmissions)
		.set({
			status: "approved",
			reviewerUserId: input.reviewerUserId,
			reviewedAt: input.now,
			mergedRevisionId: input.revisionId,
		})
		.where(eq(knowledgeSubmissions.id, input.submissionId))
		.run();
	tx.update(knowledgeDrafts)
		.set({ status: "archived", updatedAt: input.now })
		.where(eq(knowledgeDrafts.id, input.draftId))
		.run();
	return nextVersion;
}

/**
 * Sync the protected-task locks to a new tasks.json document, inside the write
 * section. `locks` is the full lock set the section already read for mutation
 * detection (same transaction, nothing written to this table since), so the upserts
 * decide from it instead of re-reading per task.
 */
function syncProtectedLocksSection(
	tx: Tx,
	namespaceId: string,
	specTasks: NonNullable<WriteSpecFileRevisionWrite["specTasks"]>,
	locks: SpecProtectedLockRow[],
	revisionId: string,
	now: string,
): void {
	const existingByHash = new Map(locks.map((lock) => [lock.textHash, lock]));
	const protectedTasksInDoc = specTasks.tasks.filter((task) => task.protected);
	for (const task of protectedTasksInDoc) {
		const existing = existingByHash.get(task.textHash);
		if (!existing) {
			tx.insert(specProtectedTasks)
				.values({
					id: generateId(),
					namespaceId,
					textHash: task.textHash,
					text: task.text,
					status: task.status as "todo",
					firstRevisionId: revisionId,
					lastRevisionId: revisionId,
					createdAt: now,
					updatedAt: now,
					completedAt: task.status === "done" ? now : null,
				})
				.run();
			continue;
		}
		tx.update(specProtectedTasks)
			.set({
				status: task.status as "todo",
				lastRevisionId: revisionId,
				updatedAt: now,
				...(task.status === "done" && !existing.completedAt ? { completedAt: now } : {}),
			})
			.where(eq(specProtectedTasks.id, existing.id))
			.run();
	}

	const hashesInDoc = protectedTasksInDoc.map((task) => task.textHash);
	for (const lock of locks) {
		if (lock.status !== "todo" && lock.status !== "doing" && lock.status !== "blocked") continue;
		if (hashesInDoc.includes(lock.textHash)) continue;
		tx.update(specProtectedTasks)
			.set({
				status: "deleted",
				deletedAt: now,
				updatedAt: now,
				lastRevisionId: revisionId,
			})
			.where(eq(specProtectedTasks.id, lock.id))
			.run();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The store
// ─────────────────────────────────────────────────────────────────────────────

export const sqliteKnowledgeWriteStore: KnowledgeWriteStore = {
	async createCollection(input: CreateCollectionWrite): Promise<KnowledgeCollectionRow> {
		try {
			const [created] = await db
				.insert(knowledgeCollections)
				.values({
					id: input.id,
					name: input.name,
					slug: input.slug,
					description: input.description,
					projectId: input.projectId,
					ownerUserId: input.ownerUserId,
					createdAt: input.now,
					updatedAt: input.now,
				})
				.returning();
			return created;
		} catch (error) {
			rethrowAsPortError(error);
		}
	},

	async createEntryWithFirstRevision(input: CreateEntryWrite): Promise<void> {
		try {
			db.transaction((tx) => createEntrySection(tx, input));
		} catch (error) {
			rethrowAsPortError(error);
		}
	},

	async updateEntryMeta(input: UpdateEntryMetaWrite): Promise<void> {
		await db
			.update(knowledgeEntries)
			.set({
				...(input.title !== undefined ? { title: input.title } : {}),
				...(input.tagsJson !== undefined ? { tagsJson: input.tagsJson } : {}),
				...(input.keywordsJson !== undefined ? { keywordsJson: input.keywordsJson } : {}),
				...(input.currentKeywords !== undefined ? { currentKeywords: input.currentKeywords } : {}),
				...(input.metadataJson !== undefined ? { metadataJson: input.metadataJson } : {}),
				...(input.status !== undefined ? { status: input.status as "active" | "archived" } : {}),
				updatedAt: input.now,
			})
			.where(eq(knowledgeEntries.id, input.entryId));
	},

	async appendRevision(input: AppendRevisionWrite): Promise<{ version: number }> {
		const version = await withDbRetry(
			async () => db.transaction((tx) => appendRevisionSection(tx, input)),
			{ label: "knowledge.addRevision", maxRetries: 5 },
		);
		return { version };
	},

	async recordInjectionEvents(input: RecordInjectionEventsWrite): Promise<void> {
		if (input.hits.length === 0) return;
		// ON CONFLICT DO NOTHING is the portable spelling of the dedupe on
		// (narrator_id, compact_seq, entry_id); both backends share it, so no dialect
		// OR-clause appears anywhere in this store.
		db.transaction((tx) => {
			for (const hit of input.hits) {
				tx.insert(knowledgeInjectionEvents)
					.values({
						id: hit.id,
						narratorId: input.narratorId,
						compactSeq: input.compactSeq,
						entryId: hit.entryId,
						entryRevisionId: hit.entryRevisionId,
						source: input.source as "tool_output",
						triggerMessageId: input.triggerMessageId,
						triggerToolCallId: input.triggerToolCallId,
						summary: hit.summary,
						createdAt: input.now,
					})
					.onConflictDoNothing()
					.run();
			}
		});
	},

	async getOrCreateActiveDraft(input: GetOrCreateActiveDraftWrite): Promise<KnowledgeDraftRow> {
		return db.transaction((tx) => {
			const existingActive = tx
				.select()
				.from(knowledgeDrafts)
				.where(
					and(
						eq(knowledgeDrafts.entryId, input.entryId),
						eq(knowledgeDrafts.authorUserId, input.authorUserId),
						inArray(knowledgeDrafts.status, ["active"]),
					),
				)
				.limit(1)
				.get();
			if (existingActive) return existingActive;

			return tx
				.insert(knowledgeDrafts)
				.values({
					id: input.draftId,
					entryId: input.entryId,
					authorUserId: input.authorUserId,
					name: input.name,
					baseRevisionId: input.baseRevisionId,
					content: input.content,
					contentHash: input.contentHash,
					format: "markdown",
					status: "active",
					createdAt: input.now,
					updatedAt: input.now,
				})
				.returning()
				.get();
		});
	},

	async archivePersonalEntry(input: {
		draftId: string;
		now: string;
	}): Promise<InvalidatedSubmissionRef[]> {
		return db.transaction((tx) => {
			const stale = tx
				.select({
					id: knowledgeSubmissions.id,
					submitterUserId: knowledgeSubmissions.submitterUserId,
				})
				.from(knowledgeSubmissions)
				.where(
					and(
						eq(knowledgeSubmissions.draftId, input.draftId),
						inArray(knowledgeSubmissions.status, [...CLOSED_ON_ENTRY_DELETE_STATUSES]),
					),
				)
				.limit(OPEN_SUBMISSION_SCAN_LIMIT)
				.all();
			tx.update(knowledgeDrafts)
				.set({ status: "archived", updatedAt: input.now })
				.where(eq(knowledgeDrafts.id, input.draftId))
				.run();
			tx.update(knowledgeSubmissions)
				.set({ status: "withdrawn", reviewedAt: input.now })
				.where(
					and(
						eq(knowledgeSubmissions.draftId, input.draftId),
						inArray(knowledgeSubmissions.status, [...CLOSED_ON_ENTRY_DELETE_STATUSES]),
					),
				)
				.run();
			return stale;
		});
	},

	async updateDraftContent(input: UpdateDraftContentWrite): Promise<InvalidatedSubmissionRef[]> {
		return db.transaction((tx) => {
			tx.update(knowledgeDrafts)
				.set({
					content: input.content,
					contentHash: input.contentHash,
					...(input.name !== undefined ? { name: input.name } : {}),
					updatedAt: input.now,
				})
				.where(eq(knowledgeDrafts.id, input.draftId))
				.run();
			return supersedeOpenSubmissions(tx, input.draftId, input.now);
		});
	},

	async rebaseDraftContent(input: RebaseDraftContentWrite): Promise<InvalidatedSubmissionRef[]> {
		return db.transaction((tx) => {
			tx.update(knowledgeDrafts)
				.set({
					content: input.content,
					contentHash: input.contentHash,
					baseRevisionId: input.baseRevisionId,
					updatedAt: input.now,
				})
				.where(eq(knowledgeDrafts.id, input.draftId))
				.run();
			return supersedeOpenSubmissions(tx, input.draftId, input.now);
		});
	},

	async createSubmissionGuarded(input: CreateSubmissionWrite): Promise<KnowledgeSubmissionRow> {
		return db.transaction((tx) => {
			// Guard against duplicate/concurrent submissions: refuse if this draft already
			// has an open (pending/conflict) request awaiting review. Checked inside the
			// section so two concurrent submits can't both pass.
			const open = tx
				.select({ id: knowledgeSubmissions.id, status: knowledgeSubmissions.status })
				.from(knowledgeSubmissions)
				.where(
					and(
						eq(knowledgeSubmissions.draftId, input.draftId),
						inArray(knowledgeSubmissions.status, [...CLAIMABLE_SUBMISSION_STATUSES]),
					),
				)
				.limit(1)
				.get();
			if (open) {
				// Name the way out, or the author is stuck. A `conflict` request in particular
				// is NOT auto-closed by editing (unlike `pending`), so without this hint the
				// author sees "awaiting review" with no visible next step.
				throw new ValidationError(
					open.status === "conflict"
						? `This personal entry has a publish request in conflict (${open.id}). ` +
								"Withdraw it and publish again, or ask a reviewer to resolve the conflict."
						: `This personal entry already has a publish request awaiting review (${open.id}). ` +
								"Withdraw it first if you want to replace it.",
				);
			}
			const [submission] = tx
				.insert(knowledgeSubmissions)
				.values({
					id: input.submissionId,
					draftId: input.draftId,
					entryId: input.entryId,
					collectionId: input.collectionId,
					title: input.title,
					submitterUserId: input.submitterUserId,
					baseRevisionId: input.baseRevisionId,
					proposedContent: input.proposedContent,
					keywordsJson: input.keywordsJson,
					changeNote: input.changeNote,
					previousSubmissionId: input.previousSubmissionId,
					round: input.round > 0 ? input.round : 1,
					status: "pending",
					createdAt: input.now,
				})
				.returning()
				.all();
			return submission;
		});
	},

	async setSubmissionReviewVerdict(input: SetSubmissionVerdictWrite): Promise<void> {
		db.transaction((tx) => {
			tx.update(knowledgeSubmissions)
				.set({
					status: input.status as "changes_requested",
					verdict: input.verdict as "request_changes",
					findingsJson: input.findingsJson,
					reviewerUserId: input.reviewerUserId,
					reviewedAt: input.now,
				})
				.where(eq(knowledgeSubmissions.id, input.submissionId))
				.run();
		});
	},

	async markSubmissionConflict(input: MarkSubmissionConflictWrite): Promise<void> {
		db.transaction((tx) => {
			const fresh = tx
				.select({ status: knowledgeSubmissions.status })
				.from(knowledgeSubmissions)
				.where(eq(knowledgeSubmissions.id, input.submissionId))
				.get();
			if (!fresh || !(CLAIMABLE_SUBMISSION_STATUSES as readonly string[]).includes(fresh.status)) {
				throw new ValidationError("Submission was already reviewed by someone else");
			}
			tx.update(knowledgeSubmissions)
				.set({
					status: "conflict",
					verdict: "approve",
					findingsJson: input.findingsJson,
					reviewerUserId: input.reviewerUserId,
					reviewedAt: input.now,
				})
				.where(eq(knowledgeSubmissions.id, input.submissionId))
				.run();
		});
	},

	async approveStandalonePublish(input: ApproveStandalonePublishWrite): Promise<void> {
		await withDbRetry(async () => db.transaction((tx) => approveStandaloneSection(tx, input)), {
			label: "knowledge.approveStandalone",
			maxRetries: 5,
		});
	},

	async commitMergedRevision(input: CommitMergedRevisionWrite): Promise<{ version: number }> {
		const version = await withDbRetry(
			async () => db.transaction((tx) => commitMergedRevisionSection(tx, input)),
			{ label: "knowledge.commitMergedRevision", maxRetries: 5 },
		);
		return { version };
	},

	async withdrawSubmissionGuarded(input: {
		submissionId: string;
		changeNote?: string;
		now: string;
	}): Promise<boolean> {
		return db.transaction((tx) => {
			// Re-check the status INSIDE the transaction so a reviewer who just approved
			// isn't overwritten back to a non-terminal state.
			const fresh = tx
				.select({ status: knowledgeSubmissions.status })
				.from(knowledgeSubmissions)
				.where(eq(knowledgeSubmissions.id, input.submissionId))
				.get();
			if (
				!fresh ||
				!(WITHDRAWABLE_SUBMISSION_STATUSES as readonly string[]).includes(fresh.status)
			) {
				return false;
			}
			tx.update(knowledgeSubmissions)
				.set({
					status: "withdrawn",
					reviewedAt: input.now,
					...(input.changeNote !== undefined ? { changeNote: input.changeNote } : {}),
				})
				.where(eq(knowledgeSubmissions.id, input.submissionId))
				.run();
			return true;
		});
	},

	async renameKnowledgeLevel(input: RenameKnowledgeLevelWrite): Promise<void> {
		db.transaction((tx) => {
			if (input.rename) {
				const { from, to } = input.rename;
				tx.update(knowledgeEntries)
					.set({ classificationLevel: to })
					.where(eq(knowledgeEntries.classificationLevel, from))
					.run();
				tx.update(knowledgeCollections)
					.set({ defaultLevel: to })
					.where(eq(knowledgeCollections.defaultLevel, from))
					.run();
				tx.update(knowledgeCollections)
					.set({ classificationLevel: to })
					.where(eq(knowledgeCollections.classificationLevel, from))
					.run();
				// Clearance levels are referenced by NAME, so a rename has to rewrite every
				// credential row in the same transaction. Missing one would make `rankOf`
				// fail closed on it and lock the content to admins.
				tx.update(aclGrants)
					.set({ domainValue: to })
					.where(and(eq(aclGrants.domainKind, "clearance"), eq(aclGrants.domainValue, from)))
					.run();
			}
			tx.update(knowledgeLevels)
				.set(input.updates)
				.where(eq(knowledgeLevels.id, input.levelId))
				.run();
		});
	},

	async insertAclGrantRows(rows: AclGrantRowWrite[]): Promise<void> {
		if (rows.length === 0) return;
		try {
			db.transaction((tx) => {
				for (const row of rows) {
					tx.insert(aclGrants)
						.values({
							id: row.id,
							scopeType: row.scopeType as "global",
							scopeId: row.scopeId,
							principalType: row.principalType as "user",
							principalId: row.principalId,
							capability: row.capability as "read",
							domainKind: row.domainKind as "clearance" | null,
							domainValue: row.domainValue,
							grantedBy: row.grantedBy,
							createdAt: row.createdAt,
						})
						.run();
				}
			});
		} catch (error) {
			rethrowAsPortError(error);
		}
	},

	async replaceUserKnowledgeGrants(input: {
		principalType: string;
		principalId: string;
		rows: AclGrantRowWrite[];
	}): Promise<void> {
		db.transaction((tx) => {
			// Scoped to knowledge grants: the unified table also holds this principal's
			// project and narrator memberships, and replacing the knowledge ACL must not
			// silently evict them.
			tx.delete(aclGrants)
				.where(
					and(
						or(eq(aclGrants.scopeType, "global"), eq(aclGrants.scopeType, "knowledge_collection")),
						eq(aclGrants.principalType, input.principalType as "user"),
						eq(aclGrants.principalId, input.principalId),
					),
				)
				.run();
			for (const row of input.rows) {
				tx.insert(aclGrants)
					.values({
						id: row.id,
						scopeType: row.scopeType as "global",
						scopeId: row.scopeId,
						principalType: row.principalType as "user",
						principalId: row.principalId,
						capability: row.capability as "read",
						domainKind: row.domainKind as "clearance" | null,
						domainValue: row.domainValue,
						grantedBy: row.grantedBy,
						createdAt: row.createdAt,
					})
					.run();
			}
		});
	},

	async recordPackActivation(input: RecordPackActivationWrite): Promise<void> {
		db.transaction((tx) => {
			// Upsert-style: a unique (narratorId, path) index exists, so delete any prior
			// row for this exact path first (e.g. left over from an unclean release).
			tx.delete(narratorWhitelistDirs)
				.where(
					and(
						eq(narratorWhitelistDirs.narratorId, input.narratorId),
						eq(narratorWhitelistDirs.path, input.extractDir),
					),
				)
				.run();
			tx.insert(narratorWhitelistDirs)
				.values({
					id: input.whitelistDirId,
					narratorId: input.narratorId,
					path: input.extractDir,
					accessLevel: "readWrite",
					enabled: true,
					createdAt: input.now,
				})
				.run();
			tx.insert(knowledgePackActivations)
				.values({
					id: input.activationId,
					packId: input.packId,
					narratorId: input.narratorId,
					extractDir: input.extractDir,
					whitelistDirId: input.whitelistDirId,
					archiveHash: input.archiveHash,
					status: "active",
					createdAt: input.now,
				})
				.run();
		});
	},

	async releasePackActivation(input: {
		activationId: string;
		whitelistDirId: string | null;
		now: string;
	}): Promise<void> {
		db.transaction((tx) => {
			if (input.whitelistDirId) {
				tx.delete(narratorWhitelistDirs)
					.where(eq(narratorWhitelistDirs.id, input.whitelistDirId))
					.run();
			}
			tx.update(knowledgePackActivations)
				.set({ status: "released", releasedAt: input.now })
				.where(eq(knowledgePackActivations.id, input.activationId))
				.run();
		});
	},

	async ensureSpecNamespace(input: EnsureSpecNamespaceWrite): Promise<SpecNamespaceRow> {
		const existing = await db.query.specNamespaces.findFirst({
			where: eq(specNamespaces.narratorId, input.narratorId),
		});
		if (existing) return existing;
		try {
			const [created] = await db
				.insert(specNamespaces)
				.values({
					id: input.namespaceId,
					narratorId: input.narratorId,
					createdAt: input.now,
					updatedAt: input.now,
				})
				.returning();
			return created;
		} catch (error) {
			// Lost the create race: the winner's row is the answer, whatever the conflict
			// was. Only a still-missing row means the failure was something else.
			const raced = await db.query.specNamespaces.findFirst({
				where: eq(specNamespaces.narratorId, input.narratorId),
			});
			if (raced) return raced;
			throw error;
		}
	},

	async writeSpecFileRevision(input: WriteSpecFileRevisionWrite): Promise<SpecFileWriteResult> {
		return db.transaction((tx) => {
			const current = tx
				.select()
				.from(specNamespaceFiles)
				.where(
					and(
						eq(specNamespaceFiles.namespaceId, input.namespaceId),
						eq(specNamespaceFiles.path, input.path),
					),
				)
				.get();

			let locks: SpecProtectedLockRow[] = [];
			if (input.specTasks) {
				locks = tx
					.select({
						id: specProtectedTasks.id,
						textHash: specProtectedTasks.textHash,
						text: specProtectedTasks.text,
						status: specProtectedTasks.status,
						completedAt: specProtectedTasks.completedAt,
					})
					.from(specProtectedTasks)
					.where(eq(specProtectedTasks.namespaceId, input.namespaceId))
					.all();
				const protectedMutations = input.specTasks.detectProtectedMutations(locks);
				if (protectedMutations.length > 0 && !input.specTasks.allowProtectedTaskMutation) {
					// Nothing has been written yet; returning the verdict is a clean no-op.
					return { ok: false as const, protectedMutations };
				}
			}

			tx.insert(specFileRevisions)
				.values({
					id: input.revisionId,
					namespaceId: input.namespaceId,
					path: input.path,
					content: input.content,
					contentHash: input.contentHash,
					parentRevisionId: current?.revisionId ?? null,
					sourceToolUseId: input.sourceToolUseId,
					sourceMessageId: input.sourceMessageId,
					createdBy: input.createdBy as "assistant",
					createdAt: input.now,
				})
				.run();

			if (current) {
				tx.update(specNamespaceFiles)
					.set({ revisionId: input.revisionId, deleted: false, updatedAt: input.now })
					.where(eq(specNamespaceFiles.id, current.id))
					.run();
			} else {
				tx.insert(specNamespaceFiles)
					.values({
						id: input.fileIdForCreate,
						namespaceId: input.namespaceId,
						path: input.path,
						revisionId: input.revisionId,
						deleted: false,
						updatedAt: input.now,
					})
					.run();
			}

			tx.update(specNamespaces)
				.set({ updatedAt: input.now })
				.where(eq(specNamespaces.id, input.namespaceId))
				.run();

			if (input.specTasks) {
				syncProtectedLocksSection(
					tx,
					input.namespaceId,
					input.specTasks,
					locks,
					input.revisionId,
					input.now,
				);
			}
			return { ok: true as const };
		});
	},

	async markSpecFileDeleted(input: { fileId: string; now: string }): Promise<void> {
		await db
			.update(specNamespaceFiles)
			.set({ deleted: true, updatedAt: input.now })
			.where(eq(specNamespaceFiles.id, input.fileId));
	},

	async forkSpecNamespace(input: ForkSpecNamespaceWrite): Promise<{ created: boolean }> {
		return db.transaction((tx) => {
			const existingChild = tx
				.select({ id: specNamespaces.id })
				.from(specNamespaces)
				.where(eq(specNamespaces.narratorId, input.childNarratorId))
				.get();
			if (existingChild) return { created: false as const };
			tx.insert(specNamespaces)
				.values({
					id: input.childNamespaceId,
					narratorId: input.childNarratorId,
					forkedFromNamespaceId: input.parentNamespaceId,
					createdAt: input.now,
					updatedAt: input.now,
				})
				.run();
			const parentFiles = tx
				.select()
				.from(specNamespaceFiles)
				.where(
					and(
						eq(specNamespaceFiles.namespaceId, input.parentNamespaceId),
						eq(specNamespaceFiles.deleted, false),
					),
				)
				.all();
			for (const file of parentFiles) {
				tx.insert(specNamespaceFiles)
					.values({
						id: generateId(),
						namespaceId: input.childNamespaceId,
						path: file.path,
						revisionId: file.revisionId,
						deleted: false,
						updatedAt: input.now,
					})
					.run();
			}
			const parentProtectedTasks = tx
				.select()
				.from(specProtectedTasks)
				.where(eq(specProtectedTasks.namespaceId, input.parentNamespaceId))
				.all();
			for (const task of parentProtectedTasks) {
				tx.insert(specProtectedTasks)
					.values({
						id: generateId(),
						namespaceId: input.childNamespaceId,
						textHash: task.textHash,
						text: task.text,
						status: task.status,
						firstRevisionId: task.firstRevisionId,
						lastRevisionId: task.lastRevisionId,
						createdAt: input.now,
						updatedAt: input.now,
						completedAt: task.completedAt,
						deletedAt: task.deletedAt,
					})
					.run();
			}
			return { created: true as const };
		});
	},

	async resetSpecNamespace(input: { namespaceId: string; now: string }): Promise<void> {
		db.transaction((tx) => {
			// Drop all tracked files. Built-in paths revert to their defaults because
			// readSpecFile falls back when there is no namespace-file row.
			tx.delete(specNamespaceFiles)
				.where(eq(specNamespaceFiles.namespaceId, input.namespaceId))
				.run();
			// Release every open protected-task lock so a future tasks.json write is not
			// blocked by a stale commitment from before the reset.
			tx.update(specProtectedTasks)
				.set({ status: "deleted", deletedAt: input.now, updatedAt: input.now })
				.where(
					and(
						eq(specProtectedTasks.namespaceId, input.namespaceId),
						inArray(specProtectedTasks.status, ["todo", "doing", "blocked"]),
					),
				)
				.run();
			tx.update(specNamespaces)
				.set({ updatedAt: input.now })
				.where(eq(specNamespaces.id, input.namespaceId))
				.run();
		});
	},

	// ── collections / entries: the remaining lifecycle writes ──

	async updateCollectionFields(input: UpdateCollectionFieldsWrite): Promise<void> {
		await db
			.update(knowledgeCollections)
			.set({
				...(input.name !== undefined ? { name: input.name } : {}),
				...(input.description !== undefined ? { description: input.description } : {}),
				...(input.classificationLevel !== undefined
					? { classificationLevel: input.classificationLevel }
					: {}),
				...(input.controlledTagsJson !== undefined
					? { controlledTagsJson: input.controlledTagsJson }
					: {}),
				...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
				updatedAt: input.now,
			})
			.where(eq(knowledgeCollections.id, input.collectionId));
	},

	async deleteCollection(input: { collectionId: string }): Promise<void> {
		// Single statement: the entries/revisions/links inside go with the FK cascade.
		await db.delete(knowledgeCollections).where(eq(knowledgeCollections.id, input.collectionId));
	},

	async updateEntryAclFields(input: UpdateEntryAclFieldsWrite): Promise<void> {
		await db
			.update(knowledgeEntries)
			.set({
				...(input.classificationLevel !== undefined
					? { classificationLevel: input.classificationLevel }
					: {}),
				...(input.controlledTagsJson !== undefined
					? { controlledTagsJson: input.controlledTagsJson }
					: {}),
				...(input.reviewTagsJson !== undefined ? { reviewTagsJson: input.reviewTagsJson } : {}),
				...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
				updatedAt: input.now,
			})
			.where(eq(knowledgeEntries.id, input.entryId));
	},

	async deleteEntry(input: { entryId: string }): Promise<void> {
		// Single statement: revisions, links and drafts cascade via FK; the FTS shadow
		// row is removed by the table's delete trigger.
		await db.delete(knowledgeEntries).where(eq(knowledgeEntries.id, input.entryId));
	},

	// ── entry links ──

	async createEntryLink(input: CreateEntryLinkWrite): Promise<KnowledgeEntryLinkRow> {
		try {
			const [created] = await db
				.insert(knowledgeEntryLinks)
				.values({
					id: input.id,
					fromEntryId: input.fromEntryId,
					toEntryId: input.toEntryId,
					linkType: input.linkType as "related",
					label: input.label,
					toRevisionId: input.toRevisionId,
					createdByUserId: input.createdByUserId,
					createdAt: input.now,
				})
				.returning();
			if (!created) throw new Error("entry link insert returned no row");
			return created;
		} catch (error) {
			rethrowAsPortError(error);
		}
	},

	async deleteEntryLink(input: { linkId: string }): Promise<void> {
		await db.delete(knowledgeEntryLinks).where(eq(knowledgeEntryLinks.id, input.linkId));
	},

	// ── ACL admin CRUD ──

	async insertKnowledgeLevel(input: {
		id: string;
		name: string;
		rank: number;
		label: string | null;
		now: string;
	}): Promise<KnowledgeLevelRowWrite> {
		try {
			const [row] = await db
				.insert(knowledgeLevels)
				.values({
					id: input.id,
					name: input.name,
					rank: input.rank,
					label: input.label,
					createdAt: input.now,
				})
				.returning();
			if (!row) throw new Error("level insert returned no row");
			return row;
		} catch (error) {
			rethrowAsPortError(error);
		}
	},

	async deleteKnowledgeLevel(input: { levelId: string }): Promise<void> {
		await db.delete(knowledgeLevels).where(eq(knowledgeLevels.id, input.levelId));
	},

	async insertKnowledgeTag(input: {
		id: string;
		name: string;
		collectionId: string | null;
		typeId: string | null;
		controlled: boolean;
		now: string;
	}): Promise<KnowledgeTagRowWrite> {
		try {
			const [row] = await db
				.insert(knowledgeTags)
				.values({
					id: input.id,
					name: input.name,
					collectionId: input.collectionId,
					typeId: input.typeId,
					controlled: input.controlled,
					createdAt: input.now,
				})
				.returning();
			if (!row) throw new Error("tag insert returned no row");
			return row;
		} catch (error) {
			rethrowAsPortError(error);
		}
	},

	async updateKnowledgeTag(input: {
		tagId: string;
		name?: string;
		controlled?: boolean;
		typeId?: string | null;
	}): Promise<void> {
		await db
			.update(knowledgeTags)
			.set({
				...(input.name !== undefined ? { name: input.name } : {}),
				...(input.controlled !== undefined ? { controlled: input.controlled } : {}),
				...(input.typeId !== undefined ? { typeId: input.typeId } : {}),
			})
			.where(eq(knowledgeTags.id, input.tagId));
	},

	async deleteKnowledgeTag(input: { tagId: string }): Promise<void> {
		await db.delete(knowledgeTags).where(eq(knowledgeTags.id, input.tagId));
	},

	async insertKnowledgeTagType(input: {
		id: string;
		name: string;
		sortOrder: number;
		now: string;
	}): Promise<KnowledgeTagTypeRowWrite> {
		try {
			const [row] = await db
				.insert(knowledgeTagTypes)
				.values({
					id: input.id,
					name: input.name,
					builtin: false,
					sortOrder: input.sortOrder,
					createdAt: input.now,
				})
				.returning();
			if (!row) throw new Error("tag type insert returned no row");
			return row;
		} catch (error) {
			rethrowAsPortError(error);
		}
	},

	async updateKnowledgeTagType(input: {
		tagTypeId: string;
		name?: string;
		sortOrder?: number;
	}): Promise<void> {
		await db
			.update(knowledgeTagTypes)
			.set({
				...(input.name !== undefined ? { name: input.name } : {}),
				...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
			})
			.where(eq(knowledgeTagTypes.id, input.tagTypeId));
	},

	async deleteKnowledgeTagType(input: { tagTypeId: string }): Promise<void> {
		// Tags referencing this type get typeId set to null via FK onDelete: "set null".
		await db.delete(knowledgeTagTypes).where(eq(knowledgeTagTypes.id, input.tagTypeId));
	},

	async deleteAclGrantWithWriteSibling(input: {
		grantId: string;
		writeSibling: {
			scopeType: string;
			scopeId: string | null;
			principalType: string;
			principalId: string;
		} | null;
	}): Promise<void> {
		db.transaction((tx) => {
			tx.delete(aclGrants).where(eq(aclGrants.id, input.grantId)).run();
			const sibling = input.writeSibling;
			if (sibling) {
				// The credential row and its write-capability sibling represented ONE grant
				// in the knowledge vocabulary; leaving the sibling behind would keep the
				// authority the caller just revoked.
				tx.delete(aclGrants)
					.where(
						and(
							eq(aclGrants.scopeType, sibling.scopeType as "global"),
							sibling.scopeId === null
								? isNull(aclGrants.scopeId)
								: eq(aclGrants.scopeId, sibling.scopeId),
							eq(aclGrants.principalType, sibling.principalType as "user"),
							eq(aclGrants.principalId, sibling.principalId),
							eq(aclGrants.capability, "write"),
							isNull(aclGrants.domainKind),
						),
					)
					.run();
			}
		});
	},

	async deleteUserKnowledgeGrants(input: {
		principalType: string;
		principalId: string;
	}): Promise<void> {
		// Knowledge scope only: the unified table also holds this principal's project
		// and narrator memberships, which a knowledge purge must not evict.
		await db
			.delete(aclGrants)
			.where(
				and(
					or(eq(aclGrants.scopeType, "global"), eq(aclGrants.scopeType, "knowledge_collection")),
					eq(aclGrants.principalType, input.principalType as "user"),
					eq(aclGrants.principalId, input.principalId),
				),
			);
	},

	// ── audit ──

	async insertAclAuditEvent(row: AclAuditEventWrite): Promise<void> {
		await db.insert(aclEvents).values({
			id: row.id,
			actorUserId: row.actorUserId,
			actorRole: row.actorRole,
			eventType: row.eventType,
			subjectType: row.subjectType as "user" | null,
			subjectId: row.subjectId,
			scopeType: row.scopeType,
			scopeId: row.scopeId,
			outcome: row.outcome as "updated",
			detailJson: row.detailJson as Record<string, unknown> | null,
			createdAt: row.createdAt,
		});
	},
};
