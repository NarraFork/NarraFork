import { createHash } from "node:crypto";
import { applyPatch, createPatch, structuredPatch } from "diff";
import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
	knowledgeCollections,
	knowledgeDrafts,
	knowledgeEntries,
	knowledgeRevisions,
	knowledgeSubmissions,
} from "../db/schema";
import { withDbRetry } from "../lib/db-resilience";
import { NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import {
	type AclEntry,
	canRead,
	canReview,
	type Principal,
	resolvePrincipalCaps,
} from "./knowledge-acl";

function nowIso(): string {
	return new Date().toISOString();
}
function hashContent(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

type DraftStatus = "draft" | "pending_review" | "changes_requested" | "merged" | "abandoned";
const ACTIVE_DRAFT_STATUSES: DraftStatus[] = ["draft", "pending_review", "changes_requested"];

async function loadEntryAndCollection(entryId: string) {
	const entry = await db.query.knowledgeEntries.findFirst({
		where: eq(knowledgeEntries.id, entryId),
	});
	if (!entry) throw new NotFoundError("Knowledge entry", entryId);
	const collection = await db.query.knowledgeCollections.findFirst({
		where: eq(knowledgeCollections.id, entry.collectionId),
	});
	if (!collection) throw new NotFoundError("Knowledge collection", entry.collectionId);
	return { entry, collection };
}

function toAclEntry(
	entry: Pick<
		typeof knowledgeEntries.$inferSelect,
		| "id"
		| "collectionId"
		| "ownerUserId"
		| "classificationLevel"
		| "controlledTagsJson"
		| "reviewTagsJson"
	>,
): AclEntry {
	return {
		id: entry.id,
		collectionId: entry.collectionId,
		ownerUserId: entry.ownerUserId,
		classificationLevel: entry.classificationLevel,
		controlledTagsJson: entry.controlledTagsJson,
		reviewTagsJson: entry.reviewTagsJson,
	};
}

async function assertCanRead(principal: Principal, entryId: string) {
	const { entry, collection } = await loadEntryAndCollection(entryId);
	const caps = await resolvePrincipalCaps(principal);
	if (
		!(await canRead(caps, toAclEntry(entry), {
			id: collection.id,
			defaultLevel: collection.defaultLevel,
		}))
	) {
		// Do not leak existence — treat as not found.
		throw new NotFoundError("Knowledge entry", entryId);
	}
	return { entry, collection, caps };
}

// ─── Drafts ───────────────────────────────────────────────────────────

/** Create (or return existing active) personal draft forked from the entry's current revision. */
async function createDraft(principal: Principal, entryId: string, input: { name?: string }) {
	const { entry } = await assertCanRead(principal, entryId);

	const existingActive = await db.query.knowledgeDrafts.findFirst({
		where: (d, { and: a, eq: e, inArray }) =>
			a(
				e(d.entryId, entryId),
				e(d.authorUserId, principal.userId),
				inArray(d.status, ACTIVE_DRAFT_STATUSES),
			),
	});
	if (existingActive) return existingActive;

	const id = generateId();
	const now = nowIso();
	const content = entry.currentContent ?? "";
	const [draft] = await db
		.insert(knowledgeDrafts)
		.values({
			id,
			entryId,
			authorUserId: principal.userId,
			name: input.name ?? null,
			baseRevisionId: entry.currentRevisionId ?? null,
			content,
			contentHash: hashContent(content),
			format: "markdown",
			status: "draft",
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return draft;
}

async function getMyDraft(principal: Principal, entryId: string) {
	await assertCanRead(principal, entryId);
	const draft = await db.query.knowledgeDrafts.findFirst({
		where: (d, { and: a, eq: e, inArray }) =>
			a(
				e(d.entryId, entryId),
				e(d.authorUserId, principal.userId),
				inArray(d.status, ACTIVE_DRAFT_STATUSES),
			),
	});
	return draft ?? null;
}

async function loadOwnDraft(principal: Principal, draftId: string) {
	const draft = await db.query.knowledgeDrafts.findFirst({
		where: eq(knowledgeDrafts.id, draftId),
	});
	if (!draft) throw new NotFoundError("Knowledge draft", draftId);
	if (draft.authorUserId !== principal.userId && principal.role !== "admin") {
		throw new NotFoundError("Knowledge draft", draftId);
	}
	return draft;
}

async function updateDraft(
	principal: Principal,
	draftId: string,
	input: { content: string; name?: string },
) {
	const draft = await loadOwnDraft(principal, draftId);
	if (draft.status === "merged" || draft.status === "abandoned") {
		throw new ValidationError(`Draft is ${draft.status} and can no longer be edited`);
	}
	await db
		.update(knowledgeDrafts)
		.set({
			content: input.content,
			contentHash: hashContent(input.content),
			...(input.name !== undefined ? { name: input.name } : {}),
			// Editing a previously-submitted/changes-requested draft returns it to draft.
			status: "draft",
			updatedAt: nowIso(),
		})
		.where(eq(knowledgeDrafts.id, draftId));
	return db.query.knowledgeDrafts.findFirst({ where: eq(knowledgeDrafts.id, draftId) });
}

/** Unified diff between the draft's base revision content and the draft content. */
async function getDraftDiff(principal: Principal, draftId: string) {
	const draft = await loadOwnDraft(principal, draftId);
	const baseContent = await baseContentOf(draft.baseRevisionId, draft.entryId);
	const patch = structuredPatch("entry", "entry", baseContent, draft.content, "base", "draft");
	return {
		draftId,
		baseRevisionId: draft.baseRevisionId,
		hunks: patch.hunks,
		unified: createPatch("entry", baseContent, draft.content, "base", "draft"),
	};
}

async function baseContentOf(baseRevisionId: string | null, entryId: string): Promise<string> {
	if (baseRevisionId) {
		const rev = await db.query.knowledgeRevisions.findFirst({
			where: eq(knowledgeRevisions.id, baseRevisionId),
		});
		if (rev) return rev.content;
	}
	// Fall back to empty (entry created without a revision, shouldn't happen normally).
	void entryId;
	return "";
}

// ─── Submission + review ────────────────────────────────────────────────

async function submitForReview(
	principal: Principal,
	draftId: string,
	input: { changeNote?: string },
) {
	const draft = await loadOwnDraft(principal, draftId);
	if (draft.status === "merged" || draft.status === "abandoned") {
		throw new ValidationError(`Draft is ${draft.status}`);
	}
	const id = generateId();
	const now = nowIso();
	let submission: typeof knowledgeSubmissions.$inferSelect | undefined;
	db.transaction((tx) => {
		[submission] = tx
			.insert(knowledgeSubmissions)
			.values({
				id,
				draftId,
				entryId: draft.entryId,
				submitterUserId: principal.userId,
				baseRevisionId: draft.baseRevisionId,
				proposedContent: draft.content,
				changeNote: input.changeNote ?? null,
				status: "pending",
				createdAt: now,
			})
			.returning()
			.all();
		tx.update(knowledgeDrafts)
			.set({ status: "pending_review", updatedAt: now })
			.where(eq(knowledgeDrafts.id, draftId))
			.run();
	});
	return submission;
}

async function loadSubmission(submissionId: string) {
	const sub = await db.query.knowledgeSubmissions.findFirst({
		where: eq(knowledgeSubmissions.id, submissionId),
	});
	if (!sub) throw new NotFoundError("Knowledge submission", submissionId);
	return sub;
}

interface Finding {
	severity: "critical" | "major" | "minor" | "suggestion";
	message: string;
	location?: string;
}

/** Review a submission. approve → merge; request_changes/reject → bounce draft. */
async function review(
	principal: Principal,
	submissionId: string,
	input: { verdict: "approve" | "request_changes" | "comment_only"; findings?: Finding[] },
) {
	const sub = await loadSubmission(submissionId);
	if (sub.status !== "pending" && sub.status !== "conflict") {
		throw new ValidationError(`Submission already ${sub.status}`);
	}
	// A conflicted submission cannot be re-approved through the normal path — the
	// reviewer must supply resolved content via resolveConflict. Allowing approve
	// here would re-run a three-way merge that already failed.
	if (sub.status === "conflict" && input.verdict === "approve") {
		throw new ValidationError(
			"This submission is in conflict; use resolve (with merged content) instead of approve",
		);
	}
	const { entry, collection } = await loadEntryAndCollection(sub.entryId);
	const caps = await resolvePrincipalCaps(principal);
	if (!canReview(caps, toAclEntry(entry))) {
		throw new ValidationError("You do not have permission to review this entry");
	}
	if (sub.submitterUserId === principal.userId && principal.role !== "admin") {
		throw new ValidationError("You cannot review your own submission");
	}
	void collection;

	const now = nowIso();
	const findings = input.findings ?? [];

	if (input.verdict === "approve") {
		return approveAndMerge(sub, principal.userId, findings, now);
	}

	// request_changes → bounce the draft back so the author can revise.
	// comment_only → record feedback WITHOUT changing the verdict/terminal state;
	//   the submission stays pending (a pure comment is not a rejection).
	const isRequestChanges = input.verdict === "request_changes";
	const newStatus = isRequestChanges ? "changes_requested" : sub.status;
	db.transaction((tx) => {
		tx.update(knowledgeSubmissions)
			.set({
				status: newStatus,
				verdict: input.verdict,
				findingsJson: findings,
				reviewerUserId: principal.userId,
				reviewedAt: now,
			})
			.where(eq(knowledgeSubmissions.id, submissionId))
			.run();
		// Only bounce the draft when changes are actually requested. A comment_only
		// review leaves the draft untouched so the author can keep working.
		if (isRequestChanges) {
			tx.update(knowledgeDrafts)
				.set({ status: "changes_requested", updatedAt: now })
				.where(eq(knowledgeDrafts.id, sub.draftId))
				.run();
		}
	});
	return { submissionId, status: newStatus, verdict: input.verdict };
}

/** Three-way merge proposed content into main via patch apply; conflict → return three-way content. */
async function approveAndMerge(
	sub: typeof knowledgeSubmissions.$inferSelect,
	reviewerUserId: string,
	findings: Finding[],
	now: string,
) {
	const entry = await db.query.knowledgeEntries.findFirst({
		where: eq(knowledgeEntries.id, sub.entryId),
	});
	if (!entry) throw new NotFoundError("Knowledge entry", sub.entryId);

	const baseContent = await baseContentOf(sub.baseRevisionId, sub.entryId);
	const currentMain = entry.currentContent ?? "";
	const proposed = sub.proposedContent;

	// Fast path: main hasn't moved since the draft's base → proposed becomes new main directly.
	let merged: string | false;
	if (baseContent === currentMain) {
		merged = proposed;
	} else {
		const patch = createPatch("entry", baseContent, proposed, "base", "proposed");
		merged = applyPatch(currentMain, patch);
	}

	if (merged === false) {
		// Conflict: cannot auto-merge. Mark and surface three-way content for manual resolve.
		// Re-check status inside the transaction so a concurrent reviewer who already
		// merged isn't overwritten back to "conflict".
		db.transaction((tx) => {
			const fresh = tx
				.select({ status: knowledgeSubmissions.status })
				.from(knowledgeSubmissions)
				.where(eq(knowledgeSubmissions.id, sub.id))
				.get();
			if (!fresh || (fresh.status !== "pending" && fresh.status !== "conflict")) {
				throw new ValidationError("Submission was already reviewed by someone else");
			}
			tx.update(knowledgeSubmissions)
				.set({
					status: "conflict",
					verdict: "approve",
					findingsJson: findings,
					reviewerUserId,
					reviewedAt: now,
				})
				.where(eq(knowledgeSubmissions.id, sub.id))
				.run();
		});
		return {
			submissionId: sub.id,
			status: "conflict" as const,
			conflict: { base: baseContent, yours: proposed, theirs: currentMain },
		};
	}

	const revisionId = await commitMergedRevision(sub, merged, reviewerUserId, now);
	return { submissionId: sub.id, status: "approved" as const, mergedRevisionId: revisionId };
}

/** Manually resolve a conflicted submission with reviewer-provided final content. */
async function resolveConflict(
	principal: Principal,
	submissionId: string,
	input: { resolvedContent: string; changeNote?: string },
) {
	const sub = await loadSubmission(submissionId);
	if (sub.status !== "conflict") {
		throw new ValidationError(`Submission is ${sub.status}, not in conflict`);
	}
	const { entry } = await loadEntryAndCollection(sub.entryId);
	const caps = await resolvePrincipalCaps(principal);
	if (!canReview(caps, toAclEntry(entry))) {
		throw new ValidationError("You do not have permission to review this entry");
	}
	const now = nowIso();
	const revisionId = await commitMergedRevision(sub, input.resolvedContent, principal.userId, now);
	return { submissionId, status: "approved" as const, mergedRevisionId: revisionId };
}

/** Append the merged content as a new main revision + switch currentRevision/content + close draft. */
async function commitMergedRevision(
	sub: typeof knowledgeSubmissions.$inferSelect,
	content: string,
	reviewerUserId: string,
	now: string,
): Promise<string> {
	const revisionId = generateId();

	await withDbRetry(
		async () =>
			db.transaction((tx) => {
				// Re-read the submission status INSIDE the transaction and refuse to proceed
				// unless it is still claimable. bun:sqlite runs the transaction body
				// synchronously under a write lock, so this select-check-update sequence is
				// atomic w.r.t. other transactions — a concurrent reviewer who already merged
				// flips the status to "approved", and this guard then aborts (no dup revision).
				const fresh = tx
					.select({ status: knowledgeSubmissions.status })
					.from(knowledgeSubmissions)
					.where(eq(knowledgeSubmissions.id, sub.id))
					.get();
				if (!fresh || (fresh.status !== "pending" && fresh.status !== "conflict")) {
					throw new ValidationError("Submission was already reviewed by someone else");
				}

				// Version is computed inside the transaction so concurrent merges on the
				// same entry can't pick the same version number.
				const row = tx
					.select({ v: knowledgeRevisions.version })
					.from(knowledgeRevisions)
					.where(eq(knowledgeRevisions.entryId, sub.entryId))
					.orderBy(desc(knowledgeRevisions.version))
					.limit(1)
					.get();
				const nextVersion = (row?.v ?? 0) + 1;

				tx.insert(knowledgeRevisions)
					.values({
						id: revisionId,
						entryId: sub.entryId,
						version: nextVersion,
						format: "markdown",
						content,
						contentHash: hashContent(content),
						changeNote: sub.changeNote ?? null,
						authorUserId: sub.submitterUserId,
						baseRevisionId: sub.baseRevisionId,
						createdAt: now,
					})
					.run();
				tx.update(knowledgeEntries)
					.set({ currentRevisionId: revisionId, currentContent: content, updatedAt: now })
					.where(eq(knowledgeEntries.id, sub.entryId))
					.run();
				tx.update(knowledgeSubmissions)
					.set({
						status: "approved",
						reviewerUserId,
						reviewedAt: now,
						mergedRevisionId: revisionId,
					})
					.where(eq(knowledgeSubmissions.id, sub.id))
					.run();
				tx.update(knowledgeDrafts)
					.set({ status: "merged", updatedAt: now })
					.where(eq(knowledgeDrafts.id, sub.draftId))
					.run();
			}),
		{ label: "knowledge.commitMergedRevision", maxRetries: 5 },
	);
	return revisionId;
}

// ─── Listing (reviewer view) ─────────────────────────────────────────────

/** Hard cap on submission rows returned by the reviewer list. */
const SUBMISSION_LIST_MAX = 200;

async function listSubmissions(
	principal: Principal,
	opts: { entryId?: string; status?: string; limit?: number },
) {
	const statusFilter = opts.status as
		| "pending"
		| "approved"
		| "rejected"
		| "changes_requested"
		| "conflict"
		| undefined;
	const limit = Math.min(opts.limit ?? SUBMISSION_LIST_MAX, SUBMISSION_LIST_MAX);
	const rows = await db.query.knowledgeSubmissions.findMany({
		where: (s, { and: a, eq: e }) => {
			const conds = [];
			if (opts.entryId) conds.push(e(s.entryId, opts.entryId));
			if (statusFilter) conds.push(e(s.status, statusFilter));
			return conds.length ? a(...conds) : undefined;
		},
		// Exclude the large proposedContent blob from the list view — the diff is
		// only needed in the single-submission detail (getSubmission).
		columns: {
			id: true,
			draftId: true,
			entryId: true,
			submitterUserId: true,
			baseRevisionId: true,
			changeNote: true,
			status: true,
			verdict: true,
			findingsJson: true,
			reviewerUserId: true,
			reviewedAt: true,
			mergedRevisionId: true,
			createdAt: true,
		},
		orderBy: (s, { desc: d }) => [d(s.createdAt)],
		limit,
	});
	// Filter to entries the principal can review (or admin).
	const caps = await resolvePrincipalCaps(principal);
	if (caps.isAdmin) return rows;
	if (rows.length === 0) return rows;

	// Batch-load the referenced entries (ACL fields only) in ONE query to avoid
	// the previous per-row N+1 lookup, then decide reviewability in memory.
	const entryIds = [...new Set(rows.map((s) => s.entryId))];
	const entries = await db.query.knowledgeEntries.findMany({
		where: (e, { inArray }) => inArray(e.id, entryIds),
		columns: {
			id: true,
			collectionId: true,
			ownerUserId: true,
			classificationLevel: true,
			controlledTagsJson: true,
			reviewTagsJson: true,
		},
	});
	const entryById = new Map(entries.map((e) => [e.id, e]));
	return rows.filter((s) => {
		const entry = entryById.get(s.entryId);
		return entry ? canReview(caps, toAclEntry(entry)) : false;
	});
}

async function getSubmission(principal: Principal, submissionId: string) {
	const sub = await loadSubmission(submissionId);
	// Submitter can view their own submission; otherwise reviewer permission is required.
	if (sub.submitterUserId !== principal.userId) {
		const { entry } = await loadEntryAndCollection(sub.entryId);
		const caps = await resolvePrincipalCaps(principal);
		if (!canReview(caps, toAclEntry(entry))) {
			throw new NotFoundError("Knowledge submission", submissionId);
		}
	}
	const baseContent = await baseContentOf(sub.baseRevisionId, sub.entryId);
	const unified = createPatch("entry", baseContent, sub.proposedContent, "base", "proposed");
	return { ...sub, diff: unified };
}

export const knowledgeBranchService = {
	createDraft,
	getMyDraft,
	updateDraft,
	getDraftDiff,
	submitForReview,
	review,
	resolveConflict,
	listSubmissions,
	getSubmission,
};
