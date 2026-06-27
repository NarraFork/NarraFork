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

function toAclEntry(entry: typeof knowledgeEntries.$inferSelect): AclEntry {
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

	// request_changes or comment_only → bounce the draft back to changes_requested.
	const newStatus = input.verdict === "request_changes" ? "changes_requested" : "rejected";
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
		tx.update(knowledgeDrafts)
			.set({ status: "changes_requested", updatedAt: now })
			.where(eq(knowledgeDrafts.id, sub.draftId))
			.run();
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
		db.transaction((tx) => {
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
	const latest = await db.query.knowledgeRevisions.findFirst({
		where: eq(knowledgeRevisions.entryId, sub.entryId),
		orderBy: [desc(knowledgeRevisions.version)],
	});
	const nextVersion = (latest?.version ?? 0) + 1;
	const revisionId = generateId();

	db.transaction((tx) => {
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
	});
	return revisionId;
}

// ─── Listing (reviewer view) ─────────────────────────────────────────────

async function listSubmissions(principal: Principal, opts: { entryId?: string; status?: string }) {
	const statusFilter = opts.status as
		| "pending"
		| "approved"
		| "rejected"
		| "changes_requested"
		| "conflict"
		| undefined;
	const rows = await db.query.knowledgeSubmissions.findMany({
		where: (s, { and: a, eq: e }) => {
			const conds = [];
			if (opts.entryId) conds.push(e(s.entryId, opts.entryId));
			if (statusFilter) conds.push(e(s.status, statusFilter));
			return conds.length ? a(...conds) : undefined;
		},
		orderBy: (s, { desc: d }) => [d(s.createdAt)],
	});
	// Filter to entries the principal can review (or admin).
	const caps = await resolvePrincipalCaps(principal);
	if (caps.isAdmin) return rows;
	const out: typeof rows = [];
	for (const s of rows) {
		const entry = await db.query.knowledgeEntries.findFirst({
			where: eq(knowledgeEntries.id, s.entryId),
		});
		if (entry && canReview(caps, toAclEntry(entry))) out.push(s);
	}
	return out;
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
