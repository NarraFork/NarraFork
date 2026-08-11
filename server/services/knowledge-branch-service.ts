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
import { eventBus } from "../lib/event-bus";
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
import { emitEntryDrifted } from "./knowledge-notify";

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

/**
 * Upper bound when listing a draft's open submissions before auto-invalidating them.
 * `submitForReview` refuses a second open submission per draft, so in practice this is
 * 1; the cap only guarantees the read stays bounded if historical data has more.
 */
const OPEN_SUBMISSION_SCAN_LIMIT = 20;

/**
 * Statuses that an author's own edit may auto-close.
 *
 * Deliberately `pending` ONLY. A `conflict` submission is NOT auto-closed: a conflict means
 * main and the proposal diverged and a human has to decide the merged text, so silently
 * dropping it when the author edits their draft would hide an unresolved divergence. The
 * author must withdraw it (or a reviewer must resolve it) explicitly.
 */
const SUPERSEDABLE_STATUSES = ["pending"] as const;

/**
 * Statuses closed when the author RETIRES the personal entry itself ({@link deletePersonalEntry}).
 *
 * Broader than SUPERSEDABLE_STATUSES because the target is going away, not just changing:
 * - `conflict` — there is nothing left to resolve the conflict against.
 * - `changes_requested` — the author can no longer make the requested changes (the entry it
 *   would have changed is retired), so leaving it open would strand a request whose only
 *   transition (`resubmit`) has become impossible. Without this it became an orphan row
 *   pointing at an archived draft, still listed as awaiting the author.
 */
const CLOSED_ON_DELETE_STATUSES = ["pending", "conflict", "changes_requested"] as const;

/** Transaction handle type of `db.transaction((tx) => …)`, for shared transaction helpers. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Close the draft's open PENDING submissions as `superseded` and return the affected rows.
 *
 * `superseded` (not `rejected`) is the whole point: it distinguishes "the author replaced the
 * proposed content, so this proposal no longer describes anything" from "a reviewer refused
 * the change". No `verdict` is written either — nobody reviewed it.
 *
 * Bounded by OPEN_SUBMISSION_SCAN_LIMIT. Runs inside the caller's transaction; the returned
 * rows are for post-commit event emission (never emit inside a transaction).
 */
function supersedeOpenSubmissions(
	tx: Tx,
	draftId: string,
	now: string,
): { id: string; submitterUserId: string }[] {
	const stale = tx
		.select({
			id: knowledgeSubmissions.id,
			submitterUserId: knowledgeSubmissions.submitterUserId,
		})
		.from(knowledgeSubmissions)
		.where(
			and(
				eq(knowledgeSubmissions.draftId, draftId),
				inArray(knowledgeSubmissions.status, [...SUPERSEDABLE_STATUSES]),
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
				inArray(knowledgeSubmissions.status, [...SUPERSEDABLE_STATUSES]),
			),
		)
		.run();
	return stale;
}

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
	input: {
		title: string;
		content?: string;
		targetCollectionId?: string;
		name?: string;
		keywords?: string[];
	},
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
			keywordsJson: Array.isArray(input.keywords) ? input.keywords : null,
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

/**
 * List the caller's own personal entries (both linked and standalone). Bounded.
 *
 * Deliberately does NOT select the `content` blob: this is a list view, and none of its
 * consumers render bodies (the personal-library tab shows title/link/target/status, and the
 * KnowledgeLibrary `list_mine` tool drops content by design). Selecting it would read up to
 * `limit` full document bodies off disk on the main thread per request. `contentLength` is
 * derived instead, which is all a summary needs. Bodies come from `getMine`/`getDraft`.
 */
async function listMine(
	principal: Principal,
	opts: { status?: PersonalEntryStatus; limit?: number } = {},
) {
	if (!principal.userId) return [];
	const limit = Math.min(opts.limit ?? 100, 200);
	const rows = await db.query.knowledgeDrafts.findMany({
		where: (d, { and: a, eq: e }) => {
			const conds = [e(d.authorUserId, principal.userId)];
			if (opts.status) conds.push(e(d.status, opts.status));
			return a(...conds);
		},
		// SQL-layer projection: everything a summary needs, minus the body.
		columns: {
			id: true,
			entryId: true,
			authorUserId: true,
			name: true,
			title: true,
			targetCollectionId: true,
			baseRevisionId: true,
			contentHash: true,
			format: true,
			keywordsJson: true,
			status: true,
			createdAt: true,
			updatedAt: true,
		},
		extras: (d, { sql }) => ({
			contentLength: sql<number>`length(${d.content})`.as("content_length"),
		}),
		orderBy: (d, { desc: dd }) => [dd(d.updatedAt)],
		limit,
	});
	return rows;
}

/**
 * Batch drift check for a set of LINKED personal entries: which of them are based on a main
 * revision that is no longer current.
 *
 * Exists because the per-entry `getDraftDrift` is far too heavy to call in a loop — it runs
 * an ACL check plus a draft lookup plus a version count, and returns THREE full document
 * bodies (base / current / draft) for the diff view. Calling it once per row to derive a
 * single boolean read `3 × N` bodies off the main thread. Drift itself is just
 * `draft.baseRevisionId !== entry.currentRevisionId`, so one bounded id→revision lookup
 * answers it for the whole page.
 *
 * Returns the subset of `drafts` that are drifted, as a Set of draft ids. Rows with no
 * `entryId` (standalone) or no `baseRevisionId` can never be drifted and are skipped.
 *
 * No ACL check: callers pass their OWN drafts (authorship is already established by
 * `listMine`), and the result exposes nothing beyond "your copy is behind".
 */
async function findDriftedDraftIds(
	drafts: ReadonlyArray<{ id: string; entryId: string | null; baseRevisionId: string | null }>,
): Promise<Set<string>> {
	const linked = drafts.filter((d) => d.entryId && d.baseRevisionId);
	if (linked.length === 0) return new Set();
	const entryIds = [...new Set(linked.map((d) => d.entryId as string))];
	const entries = await db.query.knowledgeEntries.findMany({
		where: (e, { inArray }) => inArray(e.id, entryIds),
		// Only the pointer that defines drift — never currentContent.
		columns: { id: true, currentRevisionId: true },
	});
	const currentByEntry = new Map(entries.map((e) => [e.id, e.currentRevisionId ?? null]));
	const drifted = new Set<string>();
	for (const d of linked) {
		// A missing entry (deleted underneath us) is not reported as drift; the row will fail
		// its own read path instead of being mislabelled here.
		if (!currentByEntry.has(d.entryId as string)) continue;
		if (d.baseRevisionId !== currentByEntry.get(d.entryId as string)) drifted.add(d.id);
	}
	return drifted;
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
	input: { title?: string; targetCollectionId?: string | null; keywords?: string[] },
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
	if (input.keywords !== undefined) {
		patch.keywordsJson = Array.isArray(input.keywords) ? input.keywords : null;
	}
	await db.update(knowledgeDrafts).set(patch).where(eq(knowledgeDrafts.id, draftId));
	return loadOwnDraft(principal, draftId);
}

/**
 * Soft-delete (archive) one of the caller's own personal entries — linked or standalone.
 * Authorization is the author-or-admin check in loadOwnDraft (an unauthorized caller gets
 * NotFound so entry existence isn't leaked).
 *
 * Every unmerged publish request for this entry is closed in the SAME transaction (see
 * {@link CLOSED_ON_DELETE_STATUSES}): the author is retiring the entry, so a queued proposal
 * must not stay reviewable and a bounced one must not stay waiting on the author. Wider than
 * `updateDraft`, which only supersedes `pending` — here the entry itself is going away.
 *
 * The closing status is `withdrawn`, NOT `rejected`: no reviewer passed judgement here,
 * the author retired their own entry. Writing `rejected` (+ a `request_changes` verdict)
 * would render as "a reviewer rejected you" in the author's own submission history.
 * No `verdict` is written for the same reason.
 *
 * Already-archived entries are a no-op (idempotent delete).
 */
async function deletePersonalEntry(principal: Principal, draftId: string) {
	const draft = await loadOwnDraft(principal, draftId);
	if (draft.status === "archived") {
		return { ok: true as const, id: draftId, alreadyArchived: true as const };
	}
	const now = nowIso();
	// Capture WHICH open submissions this delete closed (bounded read, mirroring
	// updateDraft) so the notify listener can tell the submitter — emitted after the
	// transaction commits, never inside it.
	const invalidated = db.transaction((tx) => {
		const stale = tx
			.select({
				id: knowledgeSubmissions.id,
				submitterUserId: knowledgeSubmissions.submitterUserId,
			})
			.from(knowledgeSubmissions)
			.where(
				and(
					eq(knowledgeSubmissions.draftId, draftId),
					inArray(knowledgeSubmissions.status, [...CLOSED_ON_DELETE_STATUSES]),
				),
			)
			.limit(OPEN_SUBMISSION_SCAN_LIMIT)
			.all();
		tx.update(knowledgeDrafts)
			.set({ status: "archived", updatedAt: now })
			.where(eq(knowledgeDrafts.id, draftId))
			.run();
		tx.update(knowledgeSubmissions)
			.set({ status: "withdrawn", reviewedAt: now })
			.where(
				and(
					eq(knowledgeSubmissions.draftId, draftId),
					inArray(knowledgeSubmissions.status, [...CLOSED_ON_DELETE_STATUSES]),
				),
			)
			.run();
		return stale;
	});
	for (const sub of invalidated) {
		eventBus.emit({
			type: "knowledge:submission_invalidated",
			submissionId: sub.id,
			submitterUserId: sub.submitterUserId,
			reason: "entry_deleted",
		});
	}
	return {
		ok: true as const,
		id: draftId,
		alreadyArchived: false as const,
		invalidatedSubmissionIds: invalidated.map((s) => s.id),
	};
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
	const invalidated = db.transaction((tx) => {
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
		// Keep submission state consistent: a PENDING submission for this entry is now stale
		// because the proposed content changed, so it is closed as `superseded` (see
		// SUPERSEDABLE_STATUSES for why `conflict` is deliberately left open, and why the
		// status is not `rejected`).
		//
		// Capture WHICH rows were invalidated (bounded by the open-submission guard in
		// submitForReview, so at most a handful) so the notify listener can tell the
		// submitter — emitted after the transaction commits, never inside it.
		const stale = supersedeOpenSubmissions(tx, draftId, now);
		return stale;
	});
	for (const sub of invalidated) {
		eventBus.emit({
			type: "knowledge:submission_invalidated",
			submissionId: sub.id,
			submitterUserId: sub.submitterUserId,
			reason: "draft_updated",
		});
	}
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

/** Rebase strategies. `merge` = three-way merge (default); `theirs` = discard local edits. */
export type RebaseStrategy = "merge" | "theirs";

/**
 * Rebase a drifted draft onto the entry's current main revision.
 *
 * Strategies:
 *  - "merge" (default) — three-way merge (base = draft fork point, theirs = current main,
 *    yours = draft content), mirroring approveAndMerge's merge logic but applied to the
 *    working copy instead of committing:
 *      · clean    → persist merged content, advance baseRevisionId to current, and supersede
 *                   any PENDING submission (the proposed content changed, so a queued review
 *                   is stale). Returns { ok: true, rebased: true }.
 *      · conflict → DOES NOT write. Returns { ok: false, conflict: { base, yours, theirs } }
 *                   so the caller can resolve manually (re-edit, or re-run with "theirs").
 *  - "theirs" — TAKE MAIN: replace the draft content with current main verbatim and advance
 *    baseRevisionId. This is the deliberate "abandon my local changes" exit from a conflict
 *    that previously forced the author to copy main back by hand. It never conflicts, and it
 *    DISCARDS the author's edits, so callers must confirm with the user first.
 *
 * Authorization: draft author or admin (loadOwnDraft). Standalone drafts have nothing to
 * rebase onto and are rejected.
 */
async function rebaseDraft(
	principal: Principal,
	draftId: string,
	opts: { strategy?: RebaseStrategy } = {},
) {
	const strategy: RebaseStrategy = opts.strategy ?? "merge";
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
		return { ok: true as const, rebased: false, baseRevisionId: currentRevisionId, strategy };
	}

	const baseContent = await baseContentOf(draft.baseRevisionId);
	const currentMain = entry.currentContent ?? "";
	const proposed = draft.content;

	let merged: string | false;
	if (strategy === "theirs") {
		// Take main verbatim: the author's delta is intentionally dropped, so there is
		// nothing to merge and no conflict is possible.
		merged = currentMain;
	} else if (baseContent === currentMain) {
		merged = proposed;
	} else {
		// Three-way merge: re-apply the author's delta (base→proposed) onto current main.
		const patch = createPatch("entry", baseContent, proposed, "base", "proposed");
		merged = applyPatch(currentMain, patch);
	}

	if (merged === false) {
		// Conflict: do not touch the draft; surface three-way content for manual redo.
		return {
			ok: false as const,
			strategy,
			conflict: { base: baseContent, yours: proposed, theirs: currentMain },
		};
	}

	const now = nowIso();
	const invalidated = db.transaction((tx) => {
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
		// A PENDING submission is now stale (proposed content changed) — close it as
		// `superseded`. Mirrors updateDraft exactly, including leaving `conflict` submissions
		// open and capturing the affected rows for the post-commit notification.
		const stale = supersedeOpenSubmissions(tx, draftId, now);
		return stale;
	});
	for (const sub of invalidated) {
		eventBus.emit({
			type: "knowledge:submission_invalidated",
			submissionId: sub.id,
			submitterUserId: sub.submitterUserId,
			reason: "draft_updated",
		});
	}
	return { ok: true as const, rebased: true, baseRevisionId: currentRevisionId, strategy };
}

// ─── Submission + review ────────────────────────────────────────────────

async function submitForReview(
	principal: Principal,
	draftId: string,
	input: {
		changeNote?: string;
		/** Set by {@link resubmit}: the `changes_requested` submission this one supersedes. */
		previousSubmissionId?: string;
		/** Set by {@link resubmit}: 1-based attempt number in the resubmit chain. */
		round?: number;
	},
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
	// Drift check BEFORE submitting (linked entries only; a standalone entry has no main).
	//
	// Submitting from a stale fork point is allowed — approve does a three-way merge and
	// usually succeeds — but silently allowing it pushed the whole cost of a stale base onto
	// the REVIEWER: the conflict only surfaced when they clicked approve, at which point the
	// author (the only person who knows what their edit meant) is no longer in the loop.
	// Reporting it here lets the author rebase first, while it is still cheap.
	//
	// Deliberately a warning, not a rejection: a drifted base is frequently mergeable, and
	// hard-failing would strand an author whose rebase conflicts.
	let driftWarning: {
		versionsBehind: number;
		baseRevisionId: string;
		currentRevisionId: string;
	} | null = null;
	if (draft.entryId && draft.baseRevisionId) {
		const entryRow = await db.query.knowledgeEntries.findFirst({
			where: eq(knowledgeEntries.id, draft.entryId),
			// Only the pointer that defines drift — never currentContent (large field).
			columns: { currentRevisionId: true },
		});
		const currentRevisionId = entryRow?.currentRevisionId ?? null;
		if (currentRevisionId && currentRevisionId !== draft.baseRevisionId) {
			driftWarning = {
				versionsBehind: await countVersionsBehind(draft.baseRevisionId, currentRevisionId),
				baseRevisionId: draft.baseRevisionId,
				currentRevisionId,
			};
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
			.select({ id: knowledgeSubmissions.id, status: knowledgeSubmissions.status })
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
			// Name the way out, or the author is stuck. A `conflict` request in particular is
			// NOT auto-closed by editing (unlike `pending`), so without this hint the author
			// sees "awaiting review" with no visible next step.
			throw new ValidationError(
				open.status === "conflict"
					? `This personal entry has a publish request in conflict (${open.id}). ` +
							"Withdraw it and publish again, or ask a reviewer to resolve the conflict."
					: `This personal entry already has a publish request awaiting review (${open.id}). ` +
							"Withdraw it first if you want to replace it.",
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
				// Standalone publish carries the draft's keywords to the new global entry on
				// approve; linked entries keep their existing global keywords (NULL here).
				keywordsJson: draft.entryId ? null : (draft.keywordsJson ?? null),
				changeNote: input.changeNote ?? null,
				// Resubmit chain metadata (both NULL/1 for a first-round submission), so a
				// reviewer sees "attempt N, previous attempt X" instead of an unrelated proposal.
				previousSubmissionId: input.previousSubmissionId ?? null,
				round: input.round && input.round > 0 ? input.round : 1,
				status: "pending",
				createdAt: now,
			})
			.returning()
			.all();
		// The personal entry stays `active`; the publish-request lifecycle lives on the submission.
	});
	// Post-commit: tell candidate reviewers there is something to review. Emitting inside
	// the transaction would let listener callbacks extend the write lock.
	if (submission) {
		eventBus.emit({
			type: "knowledge:submission_created",
			submissionId: submission.id,
			entryId: submission.entryId ?? null,
			collectionId: submission.collectionId ?? null,
			submitterUserId: submission.submitterUserId,
		});
	}
	// `driftWarning` is additive on the existing submission shape: present only when the
	// proposal is based on a stale main, so callers can surface "rebase first" without a
	// second round-trip. Absent (null) is the normal, up-to-date case.
	return submission ? { ...submission, driftWarning } : submission;
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
/**
 * Record a reviewer's verdict on a publish request.
 *
 * Verdicts and where they leave the request:
 *  - `approve`         → merged/published (`approved`), or `conflict` if the merge failed.
 *  - `request_changes` → back to the author (`changes_requested`), who may resubmit or withdraw.
 *  - `reject`          → refused for good (`rejected`). TERMINAL: deliberately not resubmittable,
 *                        which is what distinguishes it from `request_changes`. The author's
 *                        personal entry is untouched, so they can still start a fresh proposal —
 *                        rejection closes this REQUEST, it does not confiscate their work.
 *  - `comment_only`    → status unchanged; findings recorded for the author to read.
 */
async function review(
	principal: Principal,
	submissionId: string,
	input: {
		verdict: "approve" | "request_changes" | "reject" | "comment_only";
		findings?: Finding[];
	},
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

	// request_changes / reject / comment_only update only the submission. The personal entry
	// stays `active` in every case (its lifecycle is independent of the publish request) — even
	// a rejection leaves the author's own copy intact to build on.
	const newStatus =
		input.verdict === "request_changes"
			? "changes_requested"
			: input.verdict === "reject"
				? "rejected"
				: sub.status;
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
	// Post-commit: the submitter learns the verdict without polling /submissions.
	eventBus.emit({
		type: "knowledge:submission_reviewed",
		submissionId,
		status: newStatus,
		submitterUserId: sub.submitterUserId,
		reviewerUserId: principal.userId,
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
		// Post-commit: a conflict needs the submitter's attention (rebase or manual resolve).
		eventBus.emit({
			type: "knowledge:submission_reviewed",
			submissionId: sub.id,
			status: "conflict",
			submitterUserId: sub.submitterUserId,
			reviewerUserId,
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

	// Keywords proposed at submit time (already shaped on the draft). Defensive filter to a
	// clean string[] for the new global entry's keywordsJson + currentKeywords mirror.
	const stdKeywords = Array.isArray(sub.keywordsJson)
		? sub.keywordsJson.filter((k): k is string => typeof k === "string" && k.trim().length > 0)
		: [];

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
						// Carry the standalone draft's keywords onto the new global entry so it
						// participates in passive injection (currentKeywords mirrors keywordsJson
						// for the FTS keyword column).
						keywordsJson: stdKeywords,
						currentKeywords: stdKeywords.length > 0 ? stdKeywords.join(" ") : null,
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
	// Post-commit: the standalone publish became a brand-new global entry.
	eventBus.emit({
		type: "knowledge:submission_reviewed",
		submissionId: sub.id,
		status: "approved",
		submitterUserId: sub.submitterUserId,
		reviewerUserId,
	});
	eventBus.emit({
		type: "knowledge:entry_published",
		entryId,
		submissionId: sub.id,
		submitterUserId: sub.submitterUserId,
	});
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
	if (sub.submitterUserId === principal.userId && principal.role !== "admin") {
		throw new ValidationError("You cannot resolve your own submission");
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
	// Post-commit: the proposal is now main. Covers both approveAndMerge (clean
	// three-way merge) and resolveConflict (reviewer-supplied merged content).
	eventBus.emit({
		type: "knowledge:submission_reviewed",
		submissionId: sub.id,
		status: "approved",
		submitterUserId: sub.submitterUserId,
		reviewerUserId,
	});
	eventBus.emit({
		type: "knowledge:entry_published",
		entryId: targetEntryId,
		submissionId: sub.id,
		submitterUserId: sub.submitterUserId,
	});
	// A publish moves main just like a direct revision does, so OTHER holders of a personal
	// version are now drifted. The submitter is excluded: their own draft was just archived.
	emitEntryDrifted(targetEntryId, sub.submitterUserId);
	return revisionId;
}

// ─── Listing (reviewer view) ─────────────────────────────────────────────

/** Hard cap on submission rows returned by the reviewer list. */
const SUBMISSION_LIST_MAX = 200;

/**
 * Reviewer-facing list. Returns only submissions the principal can actually act on, which
 * means the caller's OWN submissions are excluded: self-review is refused downstream (see
 * `review`), so listing them would surface rows whose every review action fails, and would
 * disagree with the `countReviewInbox` badge (which already excludes them). Authors read
 * their own publish history through `listSubmissionsForDraft` instead.
 */
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
		| "withdrawn"
		| "superseded"
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
			// Resubmit chain scalars: the reviewer list badges "round N" from these.
			previousSubmissionId: true,
			round: true,
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
	// Drop the caller's own submissions: `review` refuses self-review for non-admins, so
	// listing them would fill the worklist with rows whose every action fails, and would
	// disagree with the `countReviewInbox` badge. Admins keep theirs — the self-review guard
	// exempts them (see `review`), so for an admin those rows are genuinely actionable.
	const own = principal.userId;
	const reviewable = own && !caps.isAdmin ? rows.filter((s) => s.submitterUserId !== own) : rows;

	if (caps.isAdmin) return reviewable;
	if (reviewable.length === 0) return reviewable;

	// Batch-load the referenced entries (ACL fields only) in ONE query to avoid
	// the previous per-row N+1 lookup, then decide reviewability in memory. Standalone
	// submissions (entryId null) are gated on their TARGET collection instead.
	const entryIds = [
		...new Set(reviewable.map((s) => s.entryId).filter((id): id is string => !!id)),
	];
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
			...reviewable.map((s) => s.collectionId).filter((id): id is string => !!id),
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
	const out: typeof reviewable = [];
	for (const s of reviewable) {
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

/**
 * Bounded count of submissions awaiting THIS principal's review (pending + conflict).
 *
 * Deliberately not a `COUNT(*)`: the reviewability decision is per-row ACL (collection
 * gate + canReview / canWriteCollection) and cannot be pushed into SQL, so an unbounded
 * count would scan the whole submissions table on the main thread. Instead we read at
 * most `REVIEW_INBOX_COUNT_LIMIT + 1` open rows via the (status, created_at) index and
 * report `capped: true` when there may be more — the UI renders "100+".
 *
 * Rows the principal cannot review (or whose collection they cannot read) are skipped,
 * so the count never reveals the existence of a submission they can't see.
 */
const REVIEW_INBOX_COUNT_LIMIT = 100;

async function countReviewInbox(
	principal: Principal,
): Promise<{ count: number; capped: boolean; limit: number }> {
	const rows = await db.query.knowledgeSubmissions.findMany({
		where: (s, { inArray }) => inArray(s.status, ["pending", "conflict"]),
		// Only the ACL routing scalars — never proposedContent.
		columns: { id: true, entryId: true, collectionId: true, submitterUserId: true },
		orderBy: (s, { desc: d }) => [d(s.createdAt)],
		limit: REVIEW_INBOX_COUNT_LIMIT + 1,
	});
	if (rows.length === 0) {
		return { count: 0, capped: false, limit: REVIEW_INBOX_COUNT_LIMIT };
	}

	const caps = await resolvePrincipalCaps(principal);
	// An admin reviews everything; skip the per-row ACL work entirely.
	if (caps.isAdmin) {
		const capped = rows.length > REVIEW_INBOX_COUNT_LIMIT;
		return {
			count: capped ? REVIEW_INBOX_COUNT_LIMIT : rows.length,
			capped,
			limit: REVIEW_INBOX_COUNT_LIMIT,
		};
	}

	// Batch-load the referenced entries + collections (bounded by the row cap above)
	// so reviewability is decided in memory instead of per-row queries.
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

	let count = 0;
	let scanned = 0;
	let capped = false;
	for (const s of rows) {
		if (scanned >= REVIEW_INBOX_COUNT_LIMIT) {
			// There is at least one more open row beyond the window we inspected.
			capped = true;
			break;
		}
		scanned += 1;
		// Self-review is refused by `review`, so an own submission is not in the inbox.
		if (s.submitterUserId === principal.userId) continue;
		if (s.entryId) {
			const entry = entryById.get(s.entryId);
			if (!entry) continue;
			const col = colById.get(entry.collectionId);
			if (!col) continue;
			if (!(await canReadCollection(caps, toAclCollection(col)))) continue;
			if (canReview(caps, toAclEntry(entry))) count += 1;
		} else if (s.collectionId) {
			const col = colById.get(s.collectionId);
			if (!col) continue;
			const aclCol = toAclCollection(col);
			if (!(await canReadCollection(caps, aclCol))) continue;
			if (canWriteCollection(caps, aclCol)) count += 1;
		}
	}
	return { count, capped, limit: REVIEW_INBOX_COUNT_LIMIT };
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

/**
 * The caller's own publish requests that are still "in flight" — pending, in conflict, or
 * bounced back with changes requested. Used by the personal-library list to badge each
 * card with its publish state without an extra request per card.
 *
 * One indexed query (idx_ks_submitter) on the caller's own submissions, bounded by LIMIT
 * and excluding the large proposedContent blob. No ACL gate is needed: these are the
 * caller's own submissions.
 */
async function listMyOpenSubmissions(principal: Principal, opts: { limit?: number } = {}) {
	if (!principal.userId) return [];
	const limit = Math.min(opts.limit ?? SUBMISSION_LIST_MAX, SUBMISSION_LIST_MAX);
	return db.query.knowledgeSubmissions.findMany({
		where: (s, { and: a, eq: e, inArray: ia }) =>
			a(
				e(s.submitterUserId, principal.userId),
				ia(s.status, ["pending", "conflict", "changes_requested"]),
			),
		columns: { id: true, draftId: true, entryId: true, status: true, createdAt: true },
		orderBy: (s, { desc: d }) => [d(s.createdAt)],
		limit,
	});
}

/**
 * Publish-request history for ONE personal entry, from the AUTHOR's point of view.
 *
 * listSubmissions is the reviewer view: it filters to submissions the principal may
 * REVIEW, and an author may never review their own submission — so an author cannot see
 * their own publish history through it. This path gates on draft ownership instead
 * (loadOwnDraft → author or admin), mirroring getSubmission's "submitter can always view
 * their own submission" rule.
 *
 * Bounded (LIMIT) and excludes the large proposedContent blob.
 */
async function listSubmissionsForDraft(
	principal: Principal,
	draftId: string,
	opts: { limit?: number } = {},
) {
	// Authorization + existence: author or admin, else NotFound (no existence leak).
	await loadOwnDraft(principal, draftId);
	const limit = Math.min(opts.limit ?? 50, SUBMISSION_LIST_MAX);
	return db.query.knowledgeSubmissions.findMany({
		where: (s, { eq: e }) => e(s.draftId, draftId),
		columns: {
			id: true,
			draftId: true,
			entryId: true,
			collectionId: true,
			title: true,
			submitterUserId: true,
			baseRevisionId: true,
			changeNote: true,
			// Resubmit chain scalars: the author's history shows which round each attempt was.
			previousSubmissionId: true,
			round: true,
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
}

// ─── Author-side state machine closure (withdraw / resubmit) ─────────────

/**
 * Statuses a submitter may withdraw. Nothing has been merged in any of them, so retracting is
 * always safe:
 *
 * - `pending` / `conflict` — the request is still open and awaiting a reviewer.
 * - `changes_requested` — the reviewer bounced it back, so the ball is in the AUTHOR's court.
 *   Without this, an author who decides NOT to make the requested changes had no exit at all:
 *   `resubmit` was the only transition out, so abandoning the idea left the request parked in
 *   both the author's and the reviewer's lists forever. Withdrawing says "I'm dropping this",
 *   which is exactly the author-side decision that was missing.
 */
const WITHDRAWABLE_STATUSES = ["pending", "conflict", "changes_requested"] as const;

/**
 * Withdraw one of the caller's OWN unmerged publish requests → `withdrawn`.
 *
 * Why this exists: without it, the only way to retract a queued proposal was to edit the draft
 * and let the auto-invalidation close it — using a side effect as a feature, and impossible at
 * all for a `conflict` submission (which is deliberately NOT auto-closed) or a
 * `changes_requested` one (which nothing auto-closes). Withdrawing is the explicit exit.
 *
 * Authorization: the SUBMITTER (or an admin). Deliberately not the reviewer — a reviewer who
 * wants it gone uses `review` with `request_changes`/`reject`, which records a verdict.
 * A non-submitter non-admin gets NotFound so submission existence isn't leaked.
 *
 * Emits `knowledge:submission_invalidated` with reason `withdrawn`: like `draft_updated`, this
 * closes an open request WITHOUT a review verdict, so the reviewer badges must drop it too.
 */
async function withdrawSubmission(
	principal: Principal,
	submissionId: string,
	input: { reason?: string } = {},
) {
	const sub = await loadSubmission(submissionId);
	// Existence is only revealed to the submitter or an admin (mirrors loadOwnDraft).
	if (sub.submitterUserId !== principal.userId && principal.role !== "admin") {
		throw new NotFoundError("Knowledge submission", submissionId);
	}
	if (!(WITHDRAWABLE_STATUSES as readonly string[]).includes(sub.status)) {
		throw new ValidationError(
			`Submission is ${sub.status} and can no longer be withdrawn ` +
				`(only pending, conflict, or changes_requested requests can)`,
		);
	}
	const now = nowIso();
	const changed = db.transaction((tx) => {
		// Re-check the status INSIDE the transaction so a reviewer who just approved isn't
		// overwritten back to a non-terminal state (bun:sqlite runs the body synchronously
		// under a write lock, so select-check-update is atomic w.r.t. other transactions).
		const fresh = tx
			.select({ status: knowledgeSubmissions.status })
			.from(knowledgeSubmissions)
			.where(eq(knowledgeSubmissions.id, submissionId))
			.get();
		if (!fresh || !(WITHDRAWABLE_STATUSES as readonly string[]).includes(fresh.status)) {
			return false;
		}
		tx.update(knowledgeSubmissions)
			.set({
				status: "withdrawn",
				reviewedAt: now,
				// Keep any reviewer note; only append the author's own reason when given.
				...(input.reason?.trim()
					? {
							changeNote: `${sub.changeNote ? `${sub.changeNote}\n` : ""}[withdrawn] ${input.reason.trim()}`,
						}
					: {}),
			})
			.where(eq(knowledgeSubmissions.id, submissionId))
			.run();
		return true;
	});
	if (!changed) {
		throw new ValidationError("Submission was already reviewed by someone else");
	}
	// Post-commit: an open request disappeared without a verdict — same shape as the
	// draft-updated invalidation, so reviewer badges and the author's view both refresh.
	eventBus.emit({
		type: "knowledge:submission_invalidated",
		submissionId,
		submitterUserId: sub.submitterUserId,
		reason: "withdrawn",
	});
	return { submissionId, status: "withdrawn" as const, draftId: sub.draftId };
}

/**
 * Re-submit after a `changes_requested` verdict: create a NEW publish request from the draft's
 * CURRENT content, linked to the bounced submission via `previousSubmissionId` + `round`.
 *
 * This closes the loop that `changes_requested` previously left open (the author had to hand-
 * create an unrelated-looking submission). The new row carries the round number so a reviewer
 * can tell attempt 2 from a fresh proposal, and `changeNote` records the round when the author
 * supplies no note of their own.
 *
 * Authorization: draft ownership via submitForReview → loadOwnDraft (author or admin). The
 * bounced submission must belong to the caller as well, otherwise NotFound (no existence leak).
 * Content always comes from the live draft — never from the old submission — so the author's
 * fixes are what gets reviewed.
 */
async function resubmit(
	principal: Principal,
	submissionId: string,
	input: { changeNote?: string } = {},
) {
	const sub = await loadSubmission(submissionId);
	if (sub.submitterUserId !== principal.userId && principal.role !== "admin") {
		throw new NotFoundError("Knowledge submission", submissionId);
	}
	if (sub.status !== "changes_requested") {
		throw new ValidationError(
			`Only a submission with changes requested can be re-submitted (this one is ${sub.status})`,
		);
	}
	const round = (sub.round ?? 1) + 1;
	// submitForReview re-validates draft ownership, archived state, standalone target/title,
	// and refuses a second OPEN request — no duplicated guard here.
	return submitForReview(principal, sub.draftId, {
		changeNote: input.changeNote?.trim() || `Re-submitted after requested changes (round ${round})`,
		previousSubmissionId: sub.id,
		round,
	});
}

// ─── Review scope (who am I a reviewer for?) ─────────────────────────────

/** Hard cap on rows returned by {@link getMyReviewScope}. Both axes stay small by design. */
const REVIEW_SCOPE_LIMIT = 100;

/**
 * Describe the caller's OWN review authority, so the review tab can say "you are a reviewer
 * for tag X / collection Y" instead of leaving the user to infer it from which submissions
 * happen to appear.
 *
 * Three axes, mirroring the authorization in `review` / `canReview`:
 *  - `reviewTags`      — review grants held (linked entries: `canReview` requires the caller to
 *                        hold a review grant for EVERY review tag of the entry).
 *  - `collections`     — readable collections the caller may WRITE into (standalone publishes are
 *                        gated on write access to the target collection).
 *  - `ownedEntryCount` — entries the caller owns, which `canReview` short-circuits on. Without
 *                        this, a user with no grants but several owned entries was told they had
 *                        no review authority at all.
 *
 * Bounded: grants come from the caller's own (indexed) grant rows via `resolvePrincipalCaps`,
 * tag names from ONE `inArray` lookup over those ids, and collections from the already
 * ACL-filtered `listCollections`, sliced to REVIEW_SCOPE_LIMIT. No user-table or
 * submission-table scan. Admins are reported via `isAdmin` rather than by enumerating
 * everything they could review.
 */
async function getMyReviewScope(principal: Principal): Promise<{
	isAdmin: boolean;
	reviewTags: { id: string; name: string }[];
	collections: { id: string; name: string; slug: string }[];
	/** Entries the caller OWNS — reviewable via the owner short-circuit, with no grant needed. */
	ownedEntryCount: number;
	truncated: boolean;
}> {
	const caps = await resolvePrincipalCaps(principal);

	// Review tag ids: global grants ∪ every collection-scoped grant.
	const tagIds = new Set<string>(caps.reviewTagIds);
	for (const scoped of caps.collectionScopes?.values() ?? []) {
		for (const id of scoped.reviewTagIds) tagIds.add(id);
	}
	const idList = [...tagIds].slice(0, REVIEW_SCOPE_LIMIT);
	const tagRows =
		idList.length > 0
			? await db.query.knowledgeTags.findMany({
					where: (tg, { inArray: ia }) => ia(tg.id, idList),
					columns: { id: true, name: true },
					limit: REVIEW_SCOPE_LIMIT,
				})
			: [];
	const nameById = new Map(tagRows.map((tg) => [tg.id, tg.name]));
	// A granted tag whose row was deleted still confers authority in canReview (it compares
	// ids), so report the id rather than dropping it silently.
	const reviewTags = idList.map((id) => ({ id, name: nameById.get(id) ?? id }));

	// Collections the caller may write into (→ may approve standalone publishes there).
	// Read gate first (so an unreadable collection is never named), then the write gate.
	// LIMIT + 1 detects "more than the cap" without a COUNT(*).
	const cols = await db.query.knowledgeCollections.findMany({
		columns: {
			id: true,
			name: true,
			slug: true,
			defaultLevel: true,
			classificationLevel: true,
			controlledTagsJson: true,
			ownerUserId: true,
		},
		orderBy: (c, { asc }) => [asc(c.name)],
		limit: REVIEW_SCOPE_LIMIT + 1,
	});
	const writable: { id: string; name: string; slug: string }[] = [];
	for (const c of cols.slice(0, REVIEW_SCOPE_LIMIT)) {
		const aclCol = toAclCollection(c);
		if (!(await canReadCollection(caps, aclCol))) continue;
		if (canWriteCollection(caps, aclCol)) {
			writable.push({ id: c.id, name: c.name, slug: c.slug });
		}
	}

	// Entry ownership is the THIRD review path (canReview short-circuits on owner), and it is
	// invisible in the two axes above: a user with no grants at all still reviews proposals on
	// entries they own. Reported as a bounded count so the review tab can say "plus N entries you
	// own" instead of implying "you have no review rights" to someone who does.
	const ownedEntryRows = caps.isAdmin
		? []
		: await db.query.knowledgeEntries.findMany({
				where: (e, { eq: eqOp }) => eqOp(e.ownerUserId, principal.userId),
				columns: { id: true },
				limit: REVIEW_SCOPE_LIMIT + 1,
			});
	const ownedEntryCount = Math.min(ownedEntryRows.length, REVIEW_SCOPE_LIMIT);

	return {
		isAdmin: caps.isAdmin,
		reviewTags,
		collections: writable,
		ownedEntryCount,
		truncated:
			tagIds.size > idList.length ||
			cols.length > REVIEW_SCOPE_LIMIT ||
			ownedEntryRows.length > REVIEW_SCOPE_LIMIT,
	};
}

export const knowledgeBranchService = {
	createDraft,
	createStandalone,
	listMine,
	findDriftedDraftIds,
	getMine,
	updateStandaloneMeta,
	deletePersonalEntry,
	getMyDraft,
	updateDraft,
	getDraftDiff,
	getDraftDrift,
	rebaseDraft,
	submitForReview,
	review,
	resolveConflict,
	listSubmissions,
	listSubmissionsForDraft,
	listMyOpenSubmissions,
	countReviewInbox,
	getSubmission,
	withdrawSubmission,
	resubmit,
	getMyReviewScope,
};
