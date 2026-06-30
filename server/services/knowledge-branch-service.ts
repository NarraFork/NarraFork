import { createHash } from "node:crypto";
import { applyPatch, createPatch, structuredPatch } from "diff";
import { and, desc, eq, inArray } from "drizzle-orm";
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
import { slugify } from "../lib/slug";
import {
	type AclCollection,
	type AclEntry,
	canRead,
	canReadCollection,
	canReview,
	canWriteCollection,
	type Principal,
	resolvePrincipalCaps,
} from "./knowledge-acl";

function nowIso(): string {
	return new Date().toISOString();
}
function hashContent(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Personal-entry status. The old per-draft lifecycle (draft/pending_review/…/merged)
 * is retired: an entry is `active` (in use, shadows/participates in search) or `archived`
 * (retired, e.g. after a successful publish). The publish-request lifecycle lives on
 * knowledge_submissions instead.
 */
type PersonalEntryStatus = "active" | "archived";
/** Statuses whose personal entries still shadow main / participate in search. */
const ACTIVE_DRAFT_STATUSES: PersonalEntryStatus[] = ["active"];

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

/** Map a collection row to AclCollection with ALL gate fields (never drop to public). */
function toAclCollection(
	c: Pick<
		typeof knowledgeCollections.$inferSelect,
		"id" | "defaultLevel" | "classificationLevel" | "controlledTagsJson" | "ownerUserId"
	>,
): AclCollection {
	return {
		id: c.id,
		defaultLevel: c.defaultLevel,
		classificationLevel: c.classificationLevel,
		controlledTagsJson: c.controlledTagsJson,
		ownerUserId: c.ownerUserId,
	};
}

async function assertCanRead(principal: Principal, entryId: string) {
	const { entry, collection } = await loadEntryAndCollection(entryId);
	const caps = await resolvePrincipalCaps(principal);
	if (!(await canRead(caps, toAclEntry(entry), toAclCollection(collection)))) {
		// Do not leak existence — treat as not found.
		throw new NotFoundError("Knowledge entry", entryId);
	}
	return { entry, collection, caps };
}

// ─── Drafts ───────────────────────────────────────────────────────────

/** Create (or return existing active) personal draft forked from the entry's current revision. */
async function createDraft(principal: Principal, entryId: string, input: { name?: string }) {
	const { entry } = await assertCanRead(principal, entryId);

	const id = generateId();
	const now = nowIso();
	const content = entry.currentContent ?? "";

	// Atomic "get-or-create": re-check for an active draft INSIDE the transaction
	// so two concurrent createDraft calls can't both insert a second active draft.
	// bun:sqlite runs the transaction body synchronously under a write lock.
	return db.transaction((tx) => {
		const existingActive = tx
			.select()
			.from(knowledgeDrafts)
			.where(
				and(
					eq(knowledgeDrafts.entryId, entryId),
					eq(knowledgeDrafts.authorUserId, principal.userId),
					inArray(knowledgeDrafts.status, ACTIVE_DRAFT_STATUSES),
				),
			)
			.limit(1)
			.get();
		if (existingActive) return existingActive;

		const draft = tx
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
				status: "active",
				createdAt: now,
				updatedAt: now,
			})
			.returning()
			.get();
		return draft;
	});
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

// ─── Standalone personal entries (no global counterpart yet) ──────────────

/**
 * Create a STANDALONE personal entry: the author's own knowledge with no global entry yet.
 * Requires only an authenticated user (the personal library is self-owned). `targetCollectionId`
 * is optional at creation and required before publishing (enforced in submitForReview).
 */
async function createStandalone(
	principal: Principal,
	input: { title: string; content?: string; targetCollectionId?: string; name?: string },
) {
	if (!principal.userId) throw new ValidationError("An authenticated user is required");
	const title = input.title.trim();
	if (!title) throw new ValidationError("A title is required for a standalone personal entry");
	const id = generateId();
	const now = nowIso();
	const content = input.content ?? "";
	const draft = db
		.insert(knowledgeDrafts)
		.values({
			id,
			entryId: null,
			authorUserId: principal.userId,
			name: input.name ?? null,
			title,
			targetCollectionId: input.targetCollectionId ?? null,
			baseRevisionId: null,
			content,
			contentHash: hashContent(content),
			format: "markdown",
			status: "active",
			createdAt: now,
			updatedAt: now,
		})
		.returning()
		.get();
	return draft;
}

/** List the caller's own personal entries (both linked and standalone). Bounded. */
async function listMine(
	principal: Principal,
	opts: { status?: PersonalEntryStatus; limit?: number } = {},
) {
	if (!principal.userId) return [];
	const limit = Math.min(opts.limit ?? 100, 200);
	return db.query.knowledgeDrafts.findMany({
		where: (d, { and: a, eq: e }) => {
			const conds = [e(d.authorUserId, principal.userId)];
			if (opts.status) conds.push(e(d.status, opts.status));
			return a(...conds);
		},
		orderBy: (d, { desc: dd }) => [dd(d.updatedAt)],
		limit,
	});
}

/** Read one of the caller's own personal entries by id. */
async function getMine(principal: Principal, draftId: string) {
	return loadOwnDraft(principal, draftId);
}

/**
 * Update a standalone personal entry's metadata (title / target collection). Content edits
 * go through updateDraft (shared with linked entries). Archived entries are immutable.
 */
async function updateStandaloneMeta(
	principal: Principal,
	draftId: string,
	input: { title?: string; targetCollectionId?: string | null },
) {
	const draft = await loadOwnDraft(principal, draftId);
	if (draft.status === "archived") {
		throw new ValidationError("Personal entry is archived and can no longer be edited");
	}
	if (draft.entryId) {
		throw new ValidationError("Linked personal entries inherit title/target from the global entry");
	}
	const patch: Record<string, unknown> = { updatedAt: nowIso() };
	if (input.title !== undefined) {
		const t = input.title.trim();
		if (!t) throw new ValidationError("Title cannot be empty");
		patch.title = t;
	}
	if (input.targetCollectionId !== undefined) patch.targetCollectionId = input.targetCollectionId;
	await db.update(knowledgeDrafts).set(patch).where(eq(knowledgeDrafts.id, draftId));
	return loadOwnDraft(principal, draftId);
}

async function updateDraft(
	principal: Principal,
	draftId: string,
	input: { content: string; name?: string },
) {
	const draft = await loadOwnDraft(principal, draftId);
	if (draft.status === "archived") {
		throw new ValidationError("Personal entry is archived and can no longer be edited");
	}
	const now = nowIso();
	db.transaction((tx) => {
		tx.update(knowledgeDrafts)
			.set({
				content: input.content,
				contentHash: hashContent(input.content),
				...(input.name !== undefined ? { name: input.name } : {}),
				// The entry stays `active`; the publish-request lifecycle lives on submissions.
				updatedAt: now,
			})
			.where(eq(knowledgeDrafts.id, draftId))
			.run();
		// Keep submission state consistent: any open (pending/conflict) submission for
		// this entry is now stale because the proposed content changed. Mark it rejected
		// so reviewers don't act on a superseded proposal (the author must re-submit).
		tx.update(knowledgeSubmissions)
			.set({ status: "rejected", verdict: "request_changes", reviewedAt: now })
			.where(
				and(
					eq(knowledgeSubmissions.draftId, draftId),
					inArray(knowledgeSubmissions.status, ["pending", "conflict"]),
				),
			)
			.run();
	});
	return db.query.knowledgeDrafts.findFirst({ where: eq(knowledgeDrafts.id, draftId) });
}

/**
 * Unified diff for a draft.
 *
 * `against` selects the OLD side of the diff:
 *  - "current" (default): the entry's CURRENT main content. This is the meaningful
 *    "what would change on main if this draft were applied now" view, and it stays
 *    correct even after the draft's fork point has drifted behind main.
 *  - "base": the draft's fork-point revision (legacy behaviour) — the literal changes
 *    the author made relative to where they branched.
 *
 * For a standalone personal entry (no linked global entry) there is no main side, so
 * the diff is always against empty regardless of `against`.
 */
async function getDraftDiff(
	principal: Principal,
	draftId: string,
	opts: { against?: "base" | "current" } = {},
) {
	const draft = await loadOwnDraft(principal, draftId);
	const against = opts.against ?? "current";
	let oldContent: string;
	let oldLabel: string;
	if (against === "current") {
		oldContent = await currentMainContentOf(draft.entryId);
		oldLabel = "current";
	} else {
		oldContent = await baseContentOf(draft.baseRevisionId);
		oldLabel = "base";
	}
	const patch = structuredPatch("entry", "entry", oldContent, draft.content, oldLabel, "draft");
	return {
		draftId,
		against,
		baseRevisionId: draft.baseRevisionId,
		hunks: patch.hunks,
		unified: createPatch("entry", oldContent, draft.content, oldLabel, "draft"),
	};
}

async function baseContentOf(baseRevisionId: string | null): Promise<string> {
	if (baseRevisionId) {
		const rev = await db.query.knowledgeRevisions.findFirst({
			where: eq(knowledgeRevisions.id, baseRevisionId),
		});
		if (rev) return rev.content;
	}
	// Fall back to empty (entry created without a revision, or a standalone entry).
	return "";
}

/** Current main content of a linked entry. Empty string when entry is missing/standalone. */
async function currentMainContentOf(entryId: string | null): Promise<string> {
	if (!entryId) return "";
	const entry = await db.query.knowledgeEntries.findFirst({
		where: eq(knowledgeEntries.id, entryId),
		columns: { currentContent: true },
	});
	return entry?.currentContent ?? "";
}

// ─── Drift + rebase ───────────────────────────────────────────────────────

/**
 * How many main revisions the draft's fork point is behind the entry's current
 * revision. 0 = up to date (or unknowable). Bounded by a single indexed query on
 * (entry_id, version) — never scans the whole revision history.
 */
async function countVersionsBehind(
	baseRevisionId: string | null,
	currentRevisionId: string | null,
): Promise<number> {
	if (!baseRevisionId || !currentRevisionId || baseRevisionId === currentRevisionId) return 0;
	const [baseRev, currentRev] = await Promise.all([
		db.query.knowledgeRevisions.findFirst({
			where: eq(knowledgeRevisions.id, baseRevisionId),
			columns: { version: true },
		}),
		db.query.knowledgeRevisions.findFirst({
			where: eq(knowledgeRevisions.id, currentRevisionId),
			columns: { version: true },
		}),
	]);
	if (!baseRev || !currentRev) return 0;
	const behind = currentRev.version - baseRev.version;
	return behind > 0 ? behind : 0;
}

/**
 * Describe whether the caller's active draft on a LINKED entry has drifted behind main.
 *
 * "Drifted" ⟺ the draft's fork point (baseRevisionId) is no longer the entry's current
 * revision — i.e. main advanced since the draft was created. The read path uses this to
 * decide whether to keep shadowing the draft (no drift) or show main + a rebase hint
 * (drift). Returns the three content sides so callers can render a diff without re-loading.
 *
 * No active draft → { hasDraft: false }. Standalone personal entries (no entryId) are not
 * considered here — they have no main to drift against.
 */
async function getDraftDrift(principal: Principal, entryId: string) {
	// assertCanRead both enforces ACL and confirms the entry exists.
	const { entry } = await assertCanRead(principal, entryId);
	const draft = await db.query.knowledgeDrafts.findFirst({
		where: (d, { and: a, eq: e, inArray }) =>
			a(
				e(d.entryId, entryId),
				e(d.authorUserId, principal.userId),
				inArray(d.status, ACTIVE_DRAFT_STATUSES),
			),
	});
	if (!draft) {
		return { hasDraft: false as const };
	}
	const currentRevisionId = entry.currentRevisionId ?? null;
	const drifted = !!draft.baseRevisionId && draft.baseRevisionId !== currentRevisionId;
	const versionsBehind = drifted
		? await countVersionsBehind(draft.baseRevisionId, currentRevisionId)
		: 0;
	return {
		hasDraft: true as const,
		drifted,
		draftId: draft.id,
		status: draft.status,
		baseRevisionId: draft.baseRevisionId,
		currentRevisionId,
		versionsBehind,
		// Content sides for diff rendering / shadow decisions.
		base: await baseContentOf(draft.baseRevisionId),
		current: entry.currentContent ?? "",
		draft: draft.content,
	};
}

/**
 * Rebase a drifted draft onto the entry's current main revision via three-way merge
 * (base = draft fork point, theirs = current main, yours = draft content). Mirrors the
 * merge logic in approveAndMerge, but applied to the working copy instead of committing.
 *
 *  - clean   → persist merged content, advance baseRevisionId to current, reset status to
 *              "draft", and reject any open submission (mirror of updateDraft: the proposed
 *              content changed, so a pending review is stale). Returns { ok: true, rebased }.
 *  - conflict→ DOES NOT write. Returns { ok: false, conflict: { base, yours, theirs } } so
 *              the caller can resolve manually (re-edit + re-submit).
 *
 * Authorization: draft author or admin (loadOwnDraft). Standalone drafts have nothing to
 * rebase onto and are rejected.
 */
async function rebaseDraft(principal: Principal, draftId: string) {
	const draft = await loadOwnDraft(principal, draftId);
	if (draft.status === "archived") {
		throw new ValidationError("Personal entry is archived and can no longer be rebased");
	}
	if (!draft.entryId) {
		throw new ValidationError("Standalone personal entry has no main version to rebase onto");
	}
	const { entry } = await assertCanRead(principal, draft.entryId);
	const currentRevisionId = entry.currentRevisionId ?? null;

	// Already on the latest main → nothing to do.
	if (!draft.baseRevisionId || draft.baseRevisionId === currentRevisionId) {
		return { ok: true as const, rebased: false, baseRevisionId: currentRevisionId };
	}

	const baseContent = await baseContentOf(draft.baseRevisionId);
	const currentMain = entry.currentContent ?? "";
	const proposed = draft.content;

	// Three-way merge: re-apply the author's delta (base→proposed) onto current main.
	let merged: string | false;
	if (baseContent === currentMain) {
		merged = proposed;
	} else {
		const patch = createPatch("entry", baseContent, proposed, "base", "proposed");
		merged = applyPatch(currentMain, patch);
	}

	if (merged === false) {
		// Conflict: do not touch the draft; surface three-way content for manual redo.
		return {
			ok: false as const,
			conflict: { base: baseContent, yours: proposed, theirs: currentMain },
		};
	}

	const now = nowIso();
	db.transaction((tx) => {
		tx.update(knowledgeDrafts)
			.set({
				content: merged as string,
				contentHash: hashContent(merged as string),
				baseRevisionId: currentRevisionId,
				// Entry stays `active`; rebasing only updates content + fork point.
				updatedAt: now,
			})
			.where(eq(knowledgeDrafts.id, draftId))
			.run();
		// Any open submission is now stale (proposed content changed) — mark it rejected so
		// reviewers don't act on a superseded proposal. Mirrors updateDraft's behaviour.
		tx.update(knowledgeSubmissions)
			.set({ status: "rejected", verdict: "request_changes", reviewedAt: now })
			.where(
				and(
					eq(knowledgeSubmissions.draftId, draftId),
					inArray(knowledgeSubmissions.status, ["pending", "conflict"]),
				),
			)
			.run();
	});
	return { ok: true as const, rebased: true, baseRevisionId: currentRevisionId };
}

// ─── Submission + review ────────────────────────────────────────────────

async function submitForReview(
	principal: Principal,
	draftId: string,
	input: { changeNote?: string },
) {
	const draft = await loadOwnDraft(principal, draftId);
	if (draft.status === "archived") {
		throw new ValidationError("Personal entry is archived and cannot be published");
	}
	// Standalone personal entries (no linked global entry) publish by CREATING a new global
	// entry on approve. They need a target collection + title; for linked entries these are
	// derived from the existing entry and ignored here.
	if (!draft.entryId) {
		if (!draft.targetCollectionId) {
			throw new ValidationError(
				"This personal entry has no target collection; set one before publishing",
			);
		}
		if (!draft.title?.trim()) {
			throw new ValidationError("This personal entry has no title; set one before publishing");
		}
	}
	const id = generateId();
	const now = nowIso();
	let submission: typeof knowledgeSubmissions.$inferSelect | undefined;
	db.transaction((tx) => {
		// Guard against duplicate/concurrent submissions: refuse if this entry already
		// has an open (pending/conflict) submission awaiting review. Checked inside the
		// transaction so two concurrent submits can't both pass.
		const open = tx
			.select({ id: knowledgeSubmissions.id })
			.from(knowledgeSubmissions)
			.where(
				and(
					eq(knowledgeSubmissions.draftId, draftId),
					inArray(knowledgeSubmissions.status, ["pending", "conflict"]),
				),
			)
			.limit(1)
			.get();
		if (open) {
			throw new ValidationError(
				"This personal entry already has a publish request awaiting review",
			);
		}
		[submission] = tx
			.insert(knowledgeSubmissions)
			.values({
				id,
				draftId,
				entryId: draft.entryId,
				// Standalone publish target (NULL for linked entries).
				collectionId: draft.entryId ? null : draft.targetCollectionId,
				title: draft.entryId ? null : draft.title,
				submitterUserId: principal.userId,
				baseRevisionId: draft.baseRevisionId,
				proposedContent: draft.content,
				changeNote: input.changeNote ?? null,
				status: "pending",
				createdAt: now,
			})
			.returning()
			.all();
		// The personal entry stays `active`; the publish-request lifecycle lives on the submission.
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
	const caps = await resolvePrincipalCaps(principal);
	// Authorization differs by publish kind:
	//  - linked (entryId set): collection-gate + canReview on the target entry.
	//  - standalone (entryId null): the publish creates a NEW entry in sub.collectionId, so
	//    the reviewer must be able to READ + WRITE that target collection.
	if (sub.entryId) {
		const { entry, collection } = await loadEntryAndCollection(sub.entryId);
		if (!(await canReadCollection(caps, toAclCollection(collection)))) {
			throw new NotFoundError("Knowledge submission", submissionId);
		}
		if (!canReview(caps, toAclEntry(entry))) {
			throw new ValidationError("You do not have permission to review this entry");
		}
	} else {
		await assertCanReviewStandalone(caps, sub);
	}
	if (sub.submitterUserId === principal.userId && principal.role !== "admin") {
		throw new ValidationError("You cannot review your own submission");
	}

	const now = nowIso();
	const findings = input.findings ?? [];

	if (input.verdict === "approve") {
		return sub.entryId
			? approveAndMerge(sub, principal.userId, findings, now)
			: approveStandalone(sub, principal.userId, findings, now);
	}

	// request_changes / comment_only update only the submission. The personal entry stays
	// `active` (its lifecycle is independent of the publish request).
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
	});
	return { submissionId, status: newStatus, verdict: input.verdict };
}

/**
 * Authorize a reviewer for a STANDALONE publish (creating a new global entry in the
 * submission's target collection): the collection must be readable AND writable by them.
 * Throws NotFound when the collection is unreadable (don't leak), ValidationError otherwise.
 */
async function assertCanReviewStandalone(
	caps: Awaited<ReturnType<typeof resolvePrincipalCaps>>,
	sub: typeof knowledgeSubmissions.$inferSelect,
) {
	if (!sub.collectionId) {
		throw new ValidationError("Standalone publish has no target collection");
	}
	const collection = await db.query.knowledgeCollections.findFirst({
		where: eq(knowledgeCollections.id, sub.collectionId),
	});
	if (!collection) throw new NotFoundError("Knowledge collection", sub.collectionId);
	const aclCol = toAclCollection(collection);
	if (!(await canReadCollection(caps, aclCol))) {
		throw new NotFoundError("Knowledge submission", sub.id);
	}
	if (!canWriteCollection(caps, aclCol)) {
		throw new ValidationError("You do not have permission to publish into this collection");
	}
}

/** Three-way merge proposed content into main via patch apply; conflict → return three-way content. */
async function approveAndMerge(
	sub: typeof knowledgeSubmissions.$inferSelect,
	reviewerUserId: string,
	findings: Finding[],
	now: string,
) {
	// Only called for LINKED submissions (the review dispatch routes standalone to
	// approveStandalone), so entryId is set.
	if (!sub.entryId) throw new ValidationError("Submission has no target entry to merge into");
	const entry = await db.query.knowledgeEntries.findFirst({
		where: eq(knowledgeEntries.id, sub.entryId),
	});
	if (!entry) throw new NotFoundError("Knowledge entry", sub.entryId);

	const baseContent = await baseContentOf(sub.baseRevisionId);
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

/**
 * Approve a STANDALONE publish: create a brand-new global entry (+ first revision) in the
 * submission's target collection from the proposed content, link the personal entry to it,
 * archive the personal entry, and mark the submission approved. All atomic with the same
 * concurrency guard as commitMergedRevision (a second reviewer can't double-create).
 *
 * The new entry's owner is the submitter, so they retain read/write/review over their own
 * published entry without a separate grant (mirrors knowledgeService.createEntry).
 */
async function approveStandalone(
	sub: typeof knowledgeSubmissions.$inferSelect,
	reviewerUserId: string,
	findings: Finding[],
	now: string,
) {
	if (!sub.collectionId) throw new ValidationError("Standalone publish has no target collection");
	const title = (sub.title ?? "").trim();
	if (!title) throw new ValidationError("Standalone publish has no title");

	const entryId = generateId();
	const revisionId = generateId();
	const baseSlug = slugify(title);

	await withDbRetry(
		async () =>
			db.transaction((tx) => {
				const fresh = tx
					.select({ status: knowledgeSubmissions.status })
					.from(knowledgeSubmissions)
					.where(eq(knowledgeSubmissions.id, sub.id))
					.get();
				if (!fresh || (fresh.status !== "pending" && fresh.status !== "conflict")) {
					throw new ValidationError("Submission was already reviewed by someone else");
				}

				// Resolve a unique slug within the collection (append -2, -3, … on collision).
				let slug = baseSlug;
				let n = 1;
				while (
					tx
						.select({ id: knowledgeEntries.id })
						.from(knowledgeEntries)
						.where(
							and(
								eq(knowledgeEntries.collectionId, sub.collectionId as string),
								eq(knowledgeEntries.slug, slug),
							),
						)
						.get()
				) {
					n += 1;
					slug = `${baseSlug}-${n}`;
				}

				tx.insert(knowledgeEntries)
					.values({
						id: entryId,
						collectionId: sub.collectionId as string,
						title,
						slug,
						currentRevisionId: revisionId,
						currentContent: sub.proposedContent,
						tagsJson: [],
						ownerUserId: sub.submitterUserId,
						status: "active",
						createdAt: now,
						updatedAt: now,
					})
					.run();
				tx.insert(knowledgeRevisions)
					.values({
						id: revisionId,
						entryId,
						version: 1,
						format: "markdown",
						content: sub.proposedContent,
						contentHash: hashContent(sub.proposedContent),
						changeNote: sub.changeNote ?? null,
						authorUserId: sub.submitterUserId,
						createdAt: now,
					})
					.run();
				tx.update(knowledgeSubmissions)
					.set({
						status: "approved",
						entryId,
						reviewerUserId,
						reviewedAt: now,
						findingsJson: findings,
						mergedRevisionId: revisionId,
					})
					.where(eq(knowledgeSubmissions.id, sub.id))
					.run();
				// Link the personal entry to the new global entry and archive it (published).
				tx.update(knowledgeDrafts)
					.set({ entryId, status: "archived", updatedAt: now })
					.where(eq(knowledgeDrafts.id, sub.draftId))
					.run();
			}),
		{ label: "knowledge.approveStandalone", maxRetries: 5 },
	);
	return {
		submissionId: sub.id,
		status: "approved" as const,
		mergedRevisionId: revisionId,
		entryId,
	};
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
	// Conflicts only arise from linked-entry three-way merges; standalone publishes create a
	// fresh entry and never conflict. A null entryId here would be a data inconsistency.
	if (!sub.entryId) {
		throw new ValidationError("Submission has no target entry to resolve against");
	}
	const { entry, collection } = await loadEntryAndCollection(sub.entryId);
	const caps = await resolvePrincipalCaps(principal);
	if (!(await canReadCollection(caps, toAclCollection(collection)))) {
		throw new NotFoundError("Knowledge submission", submissionId);
	}
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
	// Only called for LINKED submissions (approveAndMerge / resolveConflict), so entryId is set.
	const targetEntryId = sub.entryId;
	if (!targetEntryId) throw new ValidationError("Submission has no target entry");
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
					.where(eq(knowledgeRevisions.entryId, targetEntryId))
					.orderBy(desc(knowledgeRevisions.version))
					.limit(1)
					.get();
				const nextVersion = (row?.v ?? 0) + 1;

				tx.insert(knowledgeRevisions)
					.values({
						id: revisionId,
						entryId: targetEntryId,
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
					.where(eq(knowledgeEntries.id, targetEntryId))
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
					.set({ status: "archived", updatedAt: now })
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
			collectionId: true,
			title: true,
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
	// the previous per-row N+1 lookup, then decide reviewability in memory. Standalone
	// submissions (entryId null) are gated on their TARGET collection instead.
	const entryIds = [...new Set(rows.map((s) => s.entryId).filter((id): id is string => !!id))];
	const entries =
		entryIds.length > 0
			? await db.query.knowledgeEntries.findMany({
					where: (e, { inArray }) => inArray(e.id, entryIds),
					columns: {
						id: true,
						collectionId: true,
						ownerUserId: true,
						classificationLevel: true,
						controlledTagsJson: true,
						reviewTagsJson: true,
					},
				})
			: [];
	const entryById = new Map(entries.map((e) => [e.id, e]));
	// Batch-load collections referenced by BOTH linked entries and standalone submissions so
	// the collection gate can run (entries in a collection the principal cannot read are hidden).
	const colIds = [
		...new Set([
			...entries.map((e) => e.collectionId),
			...rows.map((s) => s.collectionId).filter((id): id is string => !!id),
		]),
	];
	const cols =
		colIds.length > 0
			? await db.query.knowledgeCollections.findMany({
					where: (c, { inArray }) => inArray(c.id, colIds),
					columns: {
						id: true,
						defaultLevel: true,
						classificationLevel: true,
						controlledTagsJson: true,
						ownerUserId: true,
					},
				})
			: [];
	const colById = new Map(cols.map((c) => [c.id, c]));
	const out: typeof rows = [];
	for (const s of rows) {
		if (s.entryId) {
			// Linked: collection-gate + canReview on the target entry.
			const entry = entryById.get(s.entryId);
			if (!entry) continue;
			const col = colById.get(entry.collectionId);
			if (!col) continue;
			if (!(await canReadCollection(caps, toAclCollection(col)))) continue;
			if (canReview(caps, toAclEntry(entry))) out.push(s);
		} else if (s.collectionId) {
			// Standalone: gate on the target collection (read + write to publish there).
			const col = colById.get(s.collectionId);
			if (!col) continue;
			const aclCol = toAclCollection(col);
			if (!(await canReadCollection(caps, aclCol))) continue;
			if (canWriteCollection(caps, aclCol)) out.push(s);
		}
	}
	return out;
}

async function getSubmission(principal: Principal, submissionId: string) {
	const sub = await loadSubmission(submissionId);
	// Submitter can view their own submission; otherwise collection-read + reviewer
	// permission are required (linked → target entry; standalone → target collection).
	if (sub.submitterUserId !== principal.userId) {
		const caps = await resolvePrincipalCaps(principal);
		if (sub.entryId) {
			const { entry, collection } = await loadEntryAndCollection(sub.entryId);
			if (!(await canReadCollection(caps, toAclCollection(collection)))) {
				throw new NotFoundError("Knowledge submission", submissionId);
			}
			if (!canReview(caps, toAclEntry(entry))) {
				throw new NotFoundError("Knowledge submission", submissionId);
			}
		} else {
			await assertCanReviewStandalone(caps, sub);
		}
	}
	const baseContent = await baseContentOf(sub.baseRevisionId);
	const unified = createPatch("entry", baseContent, sub.proposedContent, "base", "proposed");
	return { ...sub, diff: unified };
}

export const knowledgeBranchService = {
	createDraft,
	createStandalone,
	listMine,
	getMine,
	updateStandaloneMeta,
	getMyDraft,
	updateDraft,
	getDraftDiff,
	getDraftDrift,
	rebaseDraft,
	submitForReview,
	review,
	resolveConflict,
	listSubmissions,
	getSubmission,
};
