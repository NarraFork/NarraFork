import { createHash } from "node:crypto";
import { readQuery } from "@server/db/worker-read";
import { applyPatch, createPatch, structuredPatch } from "diff";
import { eq } from "drizzle-orm";
import { activeDatabaseBackend, db } from "../db";
import {
	knowledgeCollections,
	knowledgeEntries,
	knowledgeRevisions,
	knowledgeSubmissions,
} from "../db/schema";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { slugify } from "../lib/slug";
import { knowledgeReadStore, knowledgeWriteStore } from "./knowledge/store";
import {
	CLAIMABLE_SUBMISSION_STATUSES,
	CLOSED_ON_ENTRY_DELETE_STATUSES,
	OPEN_SUBMISSION_SCAN_LIMIT,
	WITHDRAWABLE_SUBMISSION_STATUSES,
} from "./knowledge/write-store";
import {
	type AclCollection,
	type AclEntry,
	canRead,
	canReadCollection,
	canReview,
	canWriteCollection,
	type Principal,
	type PrincipalCaps,
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
type PersonalEntryRow = NonNullable<
	Awaited<ReturnType<typeof knowledgeReadStore.getPersonalEntryById>>
>;
/** Statuses whose personal entries still shadow main / participate in search. */
const ACTIVE_DRAFT_STATUSES: PersonalEntryStatus[] = ["active"];

/**
 * Every multi-statement write below goes through `knowledgeWriteStore`
 * (`services/knowledge/store.ts`), which owns the atomic sections: the status sets
 * that drive auto-closure (`SUPERSEDABLE_SUBMISSION_STATUSES`,
 * `CLOSED_ON_ENTRY_DELETE_STATUSES`, `WITHDRAWABLE_SUBMISSION_STATUSES`) are port
 * vocabulary now — `pending`-only supersede because a `conflict` must never be
 * silently dropped, wider close-on-delete because the target is going away. The
 * sections themselves (guard re-checks, version claims, slug resolution) live in the
 * two store implementations; what stays here is authorization, merge logic, and the
 * POST-COMMIT event emissions (never inside a transaction, and after the store's
 * Promise resolves — the exactly-once boundary under whole-section replay).
 */

async function loadEntryAndCollection(entryId: string) {
	const entry = await readQuery(
		db.query.knowledgeEntries.findFirst({
			where: eq(knowledgeEntries.id, entryId),
		}),
	);
	if (!entry) throw new NotFoundError("Knowledge entry", entryId);
	const collection = await readQuery(
		db.query.knowledgeCollections.findFirst({
			where: eq(knowledgeCollections.id, entry.collectionId),
		}),
	);
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

/**
 * Draft branching and rebasing still perform legacy SQLite reads around the write store. Refuse
 * those mutations before touching the fail-closed SQLite handle while PostgreSQL is active.
 */
export function requireSqliteKnowledgeBranchMutation(
	operation: string,
	backend: string = activeDatabaseBackend,
): void {
	if (backend === "postgres") {
		throw new AppError(
			`${operation} is not yet supported on the PostgreSQL backend`,
			503,
			"POSTGRES_UNSUPPORTED",
		);
	}
}

/** Create (or return existing active) personal draft forked from the entry's current revision. */
async function createDraft(principal: Principal, entryId: string, input: { name?: string }) {
	requireSqliteKnowledgeBranchMutation("Knowledge draft branching");
	const { entry } = await assertCanRead(principal, entryId);

	const content = entry.currentContent ?? "";

	// Atomic "get-or-create": the store re-checks for an active draft INSIDE the
	// section (under the entry row's lock on PostgreSQL) so two concurrent createDraft
	// calls can't both insert a second active draft.
	return knowledgeWriteStore.getOrCreateActiveDraft({
		draftId: generateId(),
		entryId,
		authorUserId: principal.userId,
		name: input.name ?? null,
		baseRevisionId: entry.currentRevisionId ?? null,
		content,
		contentHash: hashContent(content),
		now: nowIso(),
	});
}

async function getMyDraft(principal: Principal, entryId: string) {
	await assertCanRead(principal, entryId);
	const draft = await readQuery(
		db.query.knowledgeDrafts.findFirst({
			where: (d, { and: a, eq: e, inArray }) =>
				a(
					e(d.entryId, entryId),
					e(d.authorUserId, principal.userId),
					inArray(d.status, ACTIVE_DRAFT_STATUSES),
				),
		}),
	);
	return draft ?? null;
}

async function loadOwnDraft(principal: Principal, draftId: string) {
	const draft = await knowledgeReadStore.getPersonalEntryById(draftId);
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
	const draft = await knowledgeWriteStore.createPersonalEntry({
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
	});
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
	return knowledgeReadStore.listPersonalEntries({
		userId: principal.userId,
		status: opts.status,
		limit,
	});
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
	const entries = await knowledgeReadStore.getEntryRevisionPointers(entryIds);
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

// ─── Personal-version page views (KNOWLEDGE_UI_REDESIGN §5.4 / §5.5) ──────

/**
 * The subset of `entryIds` the caller can currently READ (collection gate + entry gate), with
 * the columns the personal views display. One `inArray` per table, bounded by the input (the
 * caller's own list page). An entry the caller lost access to is simply absent, so its title
 * never reaches a personal-version view.
 */
async function loadReadableEntries(caps: PrincipalCaps, entryIds: readonly string[]) {
	const ids = [...new Set(entryIds)];
	if (ids.length === 0) return new Map<string, ReadableEntrySummary>();
	const entries = await readQuery(
		db.query.knowledgeEntries.findMany({
			where: (e, { inArray: ia }) => ia(e.id, ids),
			columns: {
				id: true,
				title: true,
				collectionId: true,
				ownerUserId: true,
				classificationLevel: true,
				controlledTagsJson: true,
				reviewTagsJson: true,
				currentRevisionId: true,
			},
		}),
	);
	const cols = await loadCollectionAclRows(entries.map((e) => e.collectionId));
	const out = new Map<string, ReadableEntrySummary>();
	for (const e of entries) {
		const col = cols.get(e.collectionId);
		if (!col) continue;
		if (await canRead(caps, toAclEntry(e), toAclCollection(col))) out.set(e.id, e);
	}
	return out;
}

interface ReadableEntrySummary {
	id: string;
	title: string;
	collectionId: string;
	currentRevisionId: string | null;
}

async function loadCollectionAclRows(collectionIds: readonly string[]) {
	const ids = [...new Set(collectionIds)];
	if (ids.length === 0) return new Map<string, CollectionAclRow>();
	const rows = await readQuery(
		db.query.knowledgeCollections.findMany({
			where: (c, { inArray: ia }) => ia(c.id, ids),
			columns: {
				id: true,
				name: true,
				defaultLevel: true,
				classificationLevel: true,
				controlledTagsJson: true,
				ownerUserId: true,
			},
		}),
	);
	return new Map(rows.map((c) => [c.id, c]));
}

type CollectionAclRow = Pick<
	CollectionRow,
	"id" | "name" | "defaultLevel" | "classificationLevel" | "controlledTagsJson" | "ownerUserId"
>;

/** Names of the collections (among `collectionIds`) the caller can read. */
async function readableCollectionNames(caps: PrincipalCaps, collectionIds: readonly string[]) {
	const cols = await loadCollectionAclRows(collectionIds);
	const out = new Map<string, string>();
	for (const c of cols.values()) {
		if (await canReadCollection(caps, toAclCollection(c))) out.set(c.id, c.name);
	}
	return out;
}

/**
 * `GET /personal-entries` for "My" (§5.4): {@link listMine} + `drifted` (as before) + the
 * display names the list shows — `entryTitle` (linked, only while the caller can READ that
 * entry) and `targetCollectionName` (standalone, only while the target collection is readable).
 * Bounded by the list cap; two `inArray` lookups per kind, no per-row queries.
 */
async function listMineForViewer(
	principal: Principal,
	opts: { status?: PersonalEntryStatus; limit?: number } = {},
) {
	const rows = await listMine(principal, opts);
	if (rows.length === 0) return [];
	const driftedIds = await findDriftedDraftIds(rows);
	const caps = await resolvePrincipalCaps(principal);
	const entries = await loadReadableEntries(
		caps,
		rows.map((r) => r.entryId).filter((id): id is string => !!id),
	);
	const colNames = await readableCollectionNames(
		caps,
		rows
			.filter((r) => !r.entryId)
			.map((r) => r.targetCollectionId)
			.filter((id): id is string => !!id),
	);
	return rows.map((r) => ({
		...r,
		drifted: driftedIds.has(r.id),
		entryTitle: r.entryId ? (entries.get(r.entryId)?.title ?? null) : null,
		targetCollectionName:
			!r.entryId && r.targetCollectionId ? (colNames.get(r.targetCollectionId) ?? null) : null,
	}));
}

/**
 * What the owner may do with one personal version. Each flag is the gate of the endpoint it
 * stands for (all of them first pass {@link loadOwnDraft}: author or admin):
 *  - `canEdit` — `PATCH /drafts/:id` ({@link updateDraft}): not archived;
 *  - `canEditMeta` — `PATCH /personal-entries/:id` ({@link updateStandaloneMeta}): not archived
 *    and standalone (linked entries inherit title/target from the global entry);
 *  - `canRebase` — `POST /drafts/:id/rebase` ({@link rebaseDraft}): not archived, linked, and
 *    the linked entry is readable;
 *  - `canDelete` — `DELETE /personal-entries/:id`: not archived (deleting an archived entry is
 *    an idempotent no-op, so there is nothing to offer);
 *  - `canSubmit` / `submitBlockers` — `POST /drafts/:id/submit` ({@link submitForReview}):
 *    {@link personalEntrySubmitBlockers}.
 */
export function personalEntryViewerCaps(
	draft: Pick<PersonalEntryRow, "status" | "entryId" | "targetCollectionId" | "title">,
	ctx: { entryReadable: boolean; unclosedStatuses: readonly string[] },
) {
	const active = draft.status !== "archived";
	const submitBlockers = personalEntrySubmitBlockers(draft, ctx.unclosedStatuses);
	return {
		canEdit: active,
		canEditMeta: active && !draft.entryId,
		canRebase: active && !!draft.entryId && ctx.entryReadable,
		canDelete: active,
		canSubmit: submitBlockers.length === 0,
		submitBlockers,
	};
}

/**
 * `GET /personal-entries/:id` for the personal-version page (§5.5): the entry (with body) plus
 * everything the page shows, same gate as {@link getMine}. On top of that gate:
 *  - linked: `entryTitle`, `currentMainContent` (the diff baseline) and `drift` only while the
 *    caller can READ the linked entry — losing access must not keep leaking main through the
 *    owner's copy;
 *  - standalone: `targetCollectionName` only while that collection is readable;
 *  - `openSubmissions`: the requests a delete would close ({@link CLOSED_ON_ENTRY_DELETE_STATUSES}
 *    — pending / conflict / changes requested), newest first, no bodies; the caller's own rows.
 */
async function getMineForViewer(principal: Principal, draftId: string) {
	const draft = await loadOwnDraft(principal, draftId);
	const caps = await resolvePrincipalCaps(principal);

	let entryTitle: string | null = null;
	let currentMainContent: string | null = null;
	let drift: { drifted: boolean; versionsBehind: number } | null = null;
	let entryReadable = false;
	if (draft.entryId) {
		const entry = await readQuery(
			db.query.knowledgeEntries.findFirst({
				where: eq(knowledgeEntries.id, draft.entryId),
			}),
		);
		const col = entry
			? (await loadCollectionAclRows([entry.collectionId])).get(entry.collectionId)
			: null;
		entryReadable =
			!!entry && !!col && (await canRead(caps, toAclEntry(entry), toAclCollection(col)));
		if (entry && entryReadable) {
			entryTitle = entry.title;
			currentMainContent = entry.currentContent ?? "";
			const drifted = !!draft.baseRevisionId && draft.baseRevisionId !== entry.currentRevisionId;
			drift = {
				drifted,
				versionsBehind: drifted
					? await countVersionsBehind(draft.baseRevisionId, entry.currentRevisionId ?? null)
					: 0,
			};
		}
	}

	let targetCollectionName: string | null = null;
	if (!draft.entryId && draft.targetCollectionId) {
		targetCollectionName =
			(await readableCollectionNames(caps, [draft.targetCollectionId])).get(
				draft.targetCollectionId,
			) ?? null;
	}

	const openSubmissions = await readQuery(
		db.query.knowledgeSubmissions.findMany({
			where: (s, { and: a, eq: e, inArray: ia }) =>
				a(e(s.draftId, draftId), ia(s.status, [...CLOSED_ON_ENTRY_DELETE_STATUSES])),
			columns: { id: true, status: true, round: true, createdAt: true },
			orderBy: (s, { desc: d }) => [d(s.createdAt)],
			limit: OPEN_SUBMISSION_SCAN_LIMIT,
		}),
	);

	return {
		...draft,
		entryTitle,
		currentMainContent,
		drift,
		targetCollectionName,
		openSubmissions,
		viewerCaps: personalEntryViewerCaps(draft, {
			entryReadable,
			unclosedStatuses: openSubmissions.map((s) => s.status),
		}),
	};
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
	const patch: Parameters<typeof knowledgeWriteStore.updatePersonalEntryMeta>[1] = {
		updatedAt: nowIso(),
	};
	if (input.title !== undefined) {
		const t = input.title.trim();
		if (!t) throw new ValidationError("Title cannot be empty");
		patch.title = t;
	}
	if (input.targetCollectionId !== undefined) patch.targetCollectionId = input.targetCollectionId;
	if (input.keywords !== undefined) {
		patch.keywordsJson = Array.isArray(input.keywords) ? input.keywords : null;
	}
	await knowledgeWriteStore.updatePersonalEntryMeta(draftId, patch);
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
	// The store closes the open submissions in the SAME section (statuses:
	// CLOSED_ON_ENTRY_DELETE_STATUSES — wider than updateDraft's pending-only supersede
	// because the entry itself is going away) and returns which rows it closed, so the
	// notify listener can tell the submitter — emitted after commit, never inside it.
	const invalidated = await knowledgeWriteStore.archivePersonalEntry({ draftId, now });
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
	// The store keeps submission state consistent in the same section: a PENDING
	// submission for this entry is now stale because the proposed content changed, so
	// it is closed as `superseded` (see SUPERSEDABLE_SUBMISSION_STATUSES for why
	// `conflict` is deliberately left open, and why the status is not `rejected`).
	// The closed rows come back for the post-commit notification.
	const invalidated = await knowledgeWriteStore.updateDraftContent({
		draftId,
		content: input.content,
		contentHash: hashContent(input.content),
		...(input.name !== undefined ? { name: input.name } : {}),
		now,
	});
	for (const sub of invalidated) {
		eventBus.emit({
			type: "knowledge:submission_invalidated",
			submissionId: sub.id,
			submitterUserId: sub.submitterUserId,
			reason: "draft_updated",
		});
	}
	return knowledgeReadStore.getPersonalEntryById(draftId);
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
		const rev = await readQuery(
			db.query.knowledgeRevisions.findFirst({
				where: eq(knowledgeRevisions.id, baseRevisionId),
			}),
		);
		if (rev) return rev.content;
	}
	// Fall back to empty (entry created without a revision, or a standalone entry).
	return "";
}

/** Current main content of a linked entry. Empty string when entry is missing/standalone. */
async function currentMainContentOf(entryId: string | null): Promise<string> {
	if (!entryId) return "";
	const entry = await readQuery(
		db.query.knowledgeEntries.findFirst({
			where: eq(knowledgeEntries.id, entryId),
			columns: { currentContent: true },
		}),
	);
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
		readQuery(
			db.query.knowledgeRevisions.findFirst({
				where: eq(knowledgeRevisions.id, baseRevisionId),
				columns: { version: true },
			}),
		),
		readQuery(
			db.query.knowledgeRevisions.findFirst({
				where: eq(knowledgeRevisions.id, currentRevisionId),
				columns: { version: true },
			}),
		),
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
	const draft = await readQuery(
		db.query.knowledgeDrafts.findFirst({
			where: (d, { and: a, eq: e, inArray }) =>
				a(
					e(d.entryId, entryId),
					e(d.authorUserId, principal.userId),
					inArray(d.status, ACTIVE_DRAFT_STATUSES),
				),
		}),
	);
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
	requireSqliteKnowledgeBranchMutation("Knowledge draft rebasing");
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
	// A PENDING submission is now stale (proposed content changed) — the store closes
	// it as `superseded` in the same section. Mirrors updateDraft exactly, including
	// leaving `conflict` submissions open and returning the closed rows for the
	// post-commit notification.
	const invalidated = await knowledgeWriteStore.rebaseDraftContent({
		draftId,
		content: merged,
		contentHash: hashContent(merged),
		baseRevisionId: currentRevisionId,
		now,
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

/**
 * Why a personal entry cannot be submitted, in the order {@link submitForReview} checks:
 *  - `archived` — retired entries are immutable;
 *  - `missing_target` / `missing_title` — a STANDALONE entry publishes by creating a new global
 *    entry on approve, so it needs both (linked entries inherit them from the global entry);
 *  - `open_request` — the store's create guard refuses a second request while one is
 *    claimable (pending / conflict); see `createSubmissionGuarded`.
 */
export type PersonalEntrySubmitBlocker =
	| "archived"
	| "missing_target"
	| "missing_title"
	| "open_request";

const SUBMIT_BLOCKER_MESSAGES: Record<
	Exclude<PersonalEntrySubmitBlocker, "open_request">,
	string
> = {
	archived: "Personal entry is archived and cannot be published",
	missing_target: "This personal entry has no target collection; set one before publishing",
	missing_title: "This personal entry has no title; set one before publishing",
};

/** The first content precondition {@link submitForReview} rejects, or null. Pure. */
export function personalEntrySubmitPreconditionBlocker(
	draft: Pick<PersonalEntryRow, "status" | "entryId" | "targetCollectionId" | "title">,
): Exclude<PersonalEntrySubmitBlocker, "open_request"> | null {
	if (draft.status === "archived") return "archived";
	if (!draft.entryId) {
		if (!draft.targetCollectionId) return "missing_target";
		if (!draft.title?.trim()) return "missing_title";
	}
	return null;
}

/**
 * Every reason a submit would be refused right now (for the page to list them all, not just
 * the first). `openStatuses` are the statuses of the entry's unclosed requests.
 */
export function personalEntrySubmitBlockers(
	draft: Pick<PersonalEntryRow, "status" | "entryId" | "targetCollectionId" | "title">,
	openStatuses: readonly string[],
): PersonalEntrySubmitBlocker[] {
	const out: PersonalEntrySubmitBlocker[] = [];
	if (draft.status === "archived") out.push("archived");
	if (!draft.entryId) {
		if (!draft.targetCollectionId) out.push("missing_target");
		if (!draft.title?.trim()) out.push("missing_title");
	}
	if (openStatuses.some((s) => (CLAIMABLE_SUBMISSION_STATUSES as readonly string[]).includes(s))) {
		out.push("open_request");
	}
	return out;
}

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
	// Content preconditions — the same pure check the personal-version page's `viewerCaps`
	// reports as blocked reasons, so the page and this endpoint cannot disagree.
	const blocker = personalEntrySubmitPreconditionBlocker(draft);
	if (blocker) throw new ValidationError(SUBMIT_BLOCKER_MESSAGES[blocker]);
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
		const entryRow = await readQuery(
			db.query.knowledgeEntries.findFirst({
				where: eq(knowledgeEntries.id, draft.entryId),
				// Only the pointer that defines drift — never currentContent (large field).
				columns: { currentRevisionId: true },
			}),
		);
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
	// The store guards against duplicate/concurrent submissions INSIDE the section
	// (under the draft row's lock on PostgreSQL): a draft with an open
	// (pending/conflict) request is refused with a ValidationError naming the way out.
	const submission = await knowledgeWriteStore.createSubmissionGuarded({
		submissionId: id,
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
		now,
	});
	// Post-commit: tell candidate reviewers there is something to review. Emitting inside
	// the transaction would let listener callbacks extend the write lock.
	eventBus.emit({
		type: "knowledge:submission_created",
		submissionId: submission.id,
		entryId: submission.entryId ?? null,
		collectionId: submission.collectionId ?? null,
		submitterUserId: submission.submitterUserId,
	});
	// `driftWarning` is additive on the existing submission shape: present only when the
	// proposal is based on a stale main, so callers can surface "rebase first" without a
	// second round-trip. Absent (null) is the normal, up-to-date case.
	return { ...submission, driftWarning };
}

async function loadSubmission(submissionId: string) {
	const sub = await readQuery(
		db.query.knowledgeSubmissions.findFirst({
			where: eq(knowledgeSubmissions.id, submissionId),
		}),
	);
	if (!sub) throw new NotFoundError("Knowledge submission", submissionId);
	return sub;
}

// ─── Shared submission decisions ──────────────────────────────────────────
//
// Each write endpoint below (`review`, `resolveConflict`, `withdrawSubmission`, `resubmit`)
// and the request-detail `viewerCaps` call THESE functions, so the UI's buttons and the
// endpoints cannot drift apart (docs/KNOWLEDGE_UI_REDESIGN.md §8.2).

type SubmissionRow = typeof knowledgeSubmissions.$inferSelect;
type ResolvedCaps = Awaited<ReturnType<typeof resolvePrincipalCaps>>;
type EntryRow = typeof knowledgeEntries.$inferSelect;
type CollectionRow = typeof knowledgeCollections.$inferSelect;

/**
 * Reviewer authority over a submission's TARGET, independent of status and of who submitted:
 *  - linked     → target entry's collection readable AND `canReview(entry)`;
 *  - standalone → target collection readable AND writable (approve creates an entry there).
 *
 * `hidden` marks a refusal that must not reveal the submission (unreadable / missing target);
 * the others are ordinary permission errors. `error` is exactly what the write paths throw.
 */
type SubmissionReviewAuthority =
	| { ok: true; entry: EntryRow | null; collection: CollectionRow }
	| { ok: false; hidden: boolean; error: AppError };

async function submissionReviewAuthority(
	caps: ResolvedCaps,
	sub: Pick<SubmissionRow, "id" | "entryId" | "collectionId">,
): Promise<SubmissionReviewAuthority> {
	if (sub.entryId) {
		const entry = await readQuery(
			db.query.knowledgeEntries.findFirst({
				where: eq(knowledgeEntries.id, sub.entryId),
			}),
		);
		if (!entry) {
			return { ok: false, hidden: true, error: new NotFoundError("Knowledge entry", sub.entryId) };
		}
		const collection = await readQuery(
			db.query.knowledgeCollections.findFirst({
				where: eq(knowledgeCollections.id, entry.collectionId),
			}),
		);
		if (!collection) {
			return {
				ok: false,
				hidden: true,
				error: new NotFoundError("Knowledge collection", entry.collectionId),
			};
		}
		if (!(await canReadCollection(caps, toAclCollection(collection)))) {
			return { ok: false, hidden: true, error: new NotFoundError("Knowledge submission", sub.id) };
		}
		if (!canReview(caps, toAclEntry(entry))) {
			return {
				ok: false,
				hidden: false,
				error: new ValidationError("You do not have permission to review this entry"),
			};
		}
		return { ok: true, entry, collection };
	}
	if (!sub.collectionId) {
		return {
			ok: false,
			hidden: false,
			error: new ValidationError("Standalone publish has no target collection"),
		};
	}
	const collection = await readQuery(
		db.query.knowledgeCollections.findFirst({
			where: eq(knowledgeCollections.id, sub.collectionId),
		}),
	);
	if (!collection) {
		return {
			ok: false,
			hidden: true,
			error: new NotFoundError("Knowledge collection", sub.collectionId),
		};
	}
	const aclCol = toAclCollection(collection);
	if (!(await canReadCollection(caps, aclCol))) {
		return { ok: false, hidden: true, error: new NotFoundError("Knowledge submission", sub.id) };
	}
	if (!canWriteCollection(caps, aclCol)) {
		return {
			ok: false,
			hidden: false,
			error: new ValidationError("You do not have permission to publish into this collection"),
		};
	}
	return { ok: true, entry: null, collection };
}

async function assertSubmissionReviewAuthority(
	caps: ResolvedCaps,
	sub: Pick<SubmissionRow, "id" | "entryId" | "collectionId">,
) {
	const authority = await submissionReviewAuthority(caps, sub);
	if (!authority.ok) throw authority.error;
	return authority;
}

/** Self-review is refused for everyone but an admin (§6.7.5). */
function isSelfReviewBlocked(principal: Principal, sub: Pick<SubmissionRow, "submitterUserId">) {
	return sub.submitterUserId === principal.userId && principal.role !== "admin";
}

/** Author-side actions (withdraw / resubmit) belong to the submitter, or an admin cleaning up. */
function canActAsSubmitter(principal: Principal, sub: Pick<SubmissionRow, "submitterUserId">) {
	return sub.submitterUserId === principal.userId || principal.role === "admin";
}

/** Statuses `review` accepts a verdict on (`approve` additionally needs `pending`). */
const REVIEWABLE_SUBMISSION_STATUSES = ["pending", "conflict"] as const;

function isReviewableStatus(status: string): boolean {
	return (REVIEWABLE_SUBMISSION_STATUSES as readonly string[]).includes(status);
}

function isWithdrawableStatus(status: string): boolean {
	return (WITHDRAWABLE_SUBMISSION_STATUSES as readonly string[]).includes(status);
}

/** What the requesting principal may do with one publish request (GET /submissions/:id). */
export interface KnowledgeSubmissionViewerCaps {
	/** The viewer submitted this request. */
	isSubmitter: boolean;
	/** `POST /submissions/:id/review` accepts a verdict (at least `comment_only`). */
	canReview: boolean;
	/** `POST /submissions/:id/review` accepts `approve` (pending only; conflict → resolve). */
	canApprove: boolean;
	/** `POST /submissions/:id/resolve`. */
	canResolveConflict: boolean;
	/** `POST /submissions/:id/withdraw`. */
	canWithdraw: boolean;
	/**
	 * `POST /submissions/:id/resubmit` passes its own gate (submitter-or-admin + status).
	 * submitForReview's content preconditions (archived draft, missing title/target) are
	 * reported by that call, not folded in here.
	 */
	canResubmit: boolean;
}

/** Pure given the resolved authority; mirrors each write path's checks in order. */
export function submissionViewerCaps(
	principal: Principal,
	sub: Pick<SubmissionRow, "status" | "entryId" | "submitterUserId">,
	authorityOk: boolean,
): KnowledgeSubmissionViewerCaps {
	const reviewer = authorityOk && !isSelfReviewBlocked(principal, sub);
	const author = canActAsSubmitter(principal, sub);
	return {
		isSubmitter: sub.submitterUserId === principal.userId,
		canReview: reviewer && isReviewableStatus(sub.status),
		canApprove: reviewer && sub.status === "pending",
		canResolveConflict: reviewer && sub.status === "conflict" && !!sub.entryId,
		canWithdraw: author && isWithdrawableStatus(sub.status),
		canResubmit: author && sub.status === "changes_requested",
	};
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
	// Authorization differs by publish kind (see submissionReviewAuthority):
	//  - linked (entryId set): collection-gate + canReview on the target entry.
	//  - standalone (entryId null): the publish creates a NEW entry in sub.collectionId, so
	//    the reviewer must be able to READ + WRITE that target collection.
	await assertSubmissionReviewAuthority(caps, sub);
	if (isSelfReviewBlocked(principal, sub)) {
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
	await knowledgeWriteStore.setSubmissionReviewVerdict({
		submissionId,
		status: newStatus,
		verdict: input.verdict,
		findingsJson: findings,
		reviewerUserId: principal.userId,
		now,
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
	const entry = await readQuery(
		db.query.knowledgeEntries.findFirst({
			where: eq(knowledgeEntries.id, sub.entryId),
		}),
	);
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
		// The store re-checks the status inside the section (under the submission row's
		// lock) so a concurrent reviewer who already merged isn't overwritten back to
		// "conflict".
		await knowledgeWriteStore.markSubmissionConflict({
			submissionId: sub.id,
			findingsJson: findings,
			reviewerUserId,
			now,
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

	// The store owns the whole section: the claimable-status guard (under the
	// submission row's lock), the in-section unique-slug resolution, the new global
	// entry + first revision, the submission close, and the personal entry's
	// link-and-archive — all atomic, so a second reviewer can't double-create.
	await knowledgeWriteStore.approveStandalonePublish({
		submissionId: sub.id,
		draftId: sub.draftId,
		entryId,
		revisionId,
		collectionId: sub.collectionId,
		title,
		baseSlug,
		proposedContent: sub.proposedContent,
		contentHash: hashContent(sub.proposedContent),
		keywords: stdKeywords,
		changeNote: sub.changeNote ?? null,
		baseRevisionId: sub.baseRevisionId,
		submitterUserId: sub.submitterUserId,
		reviewerUserId,
		findingsJson: findings,
		now,
	});
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
	const caps = await resolvePrincipalCaps(principal);
	await assertSubmissionReviewAuthority(caps, sub);
	if (isSelfReviewBlocked(principal, sub)) {
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

	// The store owns the whole section: the claimable-status guard (under the
	// submission row's lock — a concurrent reviewer who already merged flips the
	// status and this guard aborts, no duplicate revision), the version claim (under
	// the entry row's allocation authority — see knowledge/revision-version.ts), the
	// revision insert, the pointer switch, and the draft close. All atomic.
	await knowledgeWriteStore.commitMergedRevision({
		submissionId: sub.id,
		draftId: sub.draftId,
		entryId: targetEntryId,
		revisionId,
		content,
		contentHash: hashContent(content),
		changeNote: sub.changeNote ?? null,
		baseRevisionId: sub.baseRevisionId,
		submitterUserId: sub.submitterUserId,
		reviewerUserId,
		now,
	});
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
	const rows = await readQuery(
		db.query.knowledgeSubmissions.findMany({
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
		}),
	);
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
			? await readQuery(
					db.query.knowledgeEntries.findMany({
						where: (e, { inArray }) => inArray(e.id, entryIds),
						columns: {
							id: true,
							collectionId: true,
							ownerUserId: true,
							classificationLevel: true,
							controlledTagsJson: true,
							reviewTagsJson: true,
						},
					}),
				)
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
			? await readQuery(
					db.query.knowledgeCollections.findMany({
						where: (c, { inArray }) => inArray(c.id, colIds),
						columns: {
							id: true,
							defaultLevel: true,
							classificationLevel: true,
							controlledTagsJson: true,
							ownerUserId: true,
						},
					}),
				)
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
	const rows = await readQuery(
		db.query.knowledgeSubmissions.findMany({
			where: (s, { inArray }) => inArray(s.status, ["pending", "conflict"]),
			// Only the ACL routing scalars — never proposedContent.
			columns: { id: true, entryId: true, collectionId: true, submitterUserId: true },
			orderBy: (s, { desc: d }) => [d(s.createdAt)],
			limit: REVIEW_INBOX_COUNT_LIMIT + 1,
		}),
	);
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
			? await readQuery(
					db.query.knowledgeEntries.findMany({
						where: (e, { inArray }) => inArray(e.id, entryIds),
						columns: {
							id: true,
							collectionId: true,
							ownerUserId: true,
							classificationLevel: true,
							controlledTagsJson: true,
							reviewTagsJson: true,
						},
					}),
				)
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
			? await readQuery(
					db.query.knowledgeCollections.findMany({
						where: (c, { inArray }) => inArray(c.id, colIds),
						columns: {
							id: true,
							defaultLevel: true,
							classificationLevel: true,
							controlledTagsJson: true,
							ownerUserId: true,
						},
					}),
				)
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

/**
 * The read gate for ONE submission: the submitter may always view their own; anyone else needs
 * reviewer authority over its target (linked → collection read + canReview; standalone →
 * collection read + write). Every refusal is NotFound, so a request's existence (and its
 * title / body) never leaks to someone who could not review it.
 */
async function loadViewableSubmission(principal: Principal, submissionId: string) {
	const sub = await loadSubmission(submissionId);
	const caps = await resolvePrincipalCaps(principal);
	const authority = await submissionReviewAuthority(caps, sub);
	if (sub.submitterUserId !== principal.userId && !authority.ok) {
		throw new NotFoundError("Knowledge submission", submissionId);
	}
	return { sub, caps, authority };
}

async function getSubmission(principal: Principal, submissionId: string) {
	const { sub } = await loadViewableSubmission(principal, submissionId);
	const baseContent = await baseContentOf(sub.baseRevisionId);
	const unified = createPatch("entry", baseContent, sub.proposedContent, "base", "proposed");
	return { ...sub, diff: unified };
}

/** Bounded per-draft request history shown on the request page (rounds of one proposal). */
const SUBMISSION_HISTORY_LIMIT = 20;

/** Usernames for display; one `inArray` lookup bounded by the caller's row set. */
async function usernamesById(userIds: (string | null | undefined)[]) {
	const ids = [...new Set(userIds.filter((id): id is string => !!id))];
	if (ids.length === 0) return new Map<string, string>();
	const rows = await readQuery(
		db.query.users.findMany({
			where: (u, { inArray: ia }) => ia(u.id, ids),
			columns: { id: true, username: true },
		}),
	);
	return new Map(rows.map((u) => [u.id, u.username]));
}

/**
 * `GET /submissions/:id` for the request page: the submission (+ unified diff) plus everything
 * the page needs to render without assembling several requests (§6.2), and `viewerCaps`.
 *
 * Same gate as {@link getSubmission}. Display metadata is ACL-checked on top of it:
 *  - `entryTitle` / `currentMainContent` / drift need `canRead` on the target entry (a reviewer
 *    by review tag, or a submitter who lost access, does not automatically read main);
 *  - `collectionName` needs `canReadCollection`;
 *  - `baseContent` is the fork point the proposal was diffed against — already derivable from
 *    `proposedContent` + `diff`, so it reveals nothing new.
 */
async function getSubmissionForViewer(principal: Principal, submissionId: string) {
	const { sub, caps, authority } = await loadViewableSubmission(principal, submissionId);
	const baseContent = await baseContentOf(sub.baseRevisionId);
	const diff = createPatch("entry", baseContent, sub.proposedContent, "base", "proposed");

	// Target rows: reuse what the authority check loaded; a submitter without authority still
	// needs them for the (separately gated) display fields.
	let entry: EntryRow | null = authority.ok ? authority.entry : null;
	let collection: CollectionRow | null = authority.ok ? authority.collection : null;
	if (!authority.ok) {
		if (sub.entryId) {
			entry =
				(await readQuery(
					db.query.knowledgeEntries.findFirst({
						where: eq(knowledgeEntries.id, sub.entryId),
					}),
				)) ?? null;
		}
		const colId = entry?.collectionId ?? sub.collectionId;
		if (colId) {
			collection =
				(await readQuery(
					db.query.knowledgeCollections.findFirst({
						where: eq(knowledgeCollections.id, colId),
					}),
				)) ?? null;
		}
	}
	const aclCol = collection ? toAclCollection(collection) : null;
	const collectionReadable = !!aclCol && (await canReadCollection(caps, aclCol));
	const entryReadable = !!entry && !!aclCol && (await canRead(caps, toAclEntry(entry), aclCol));

	let drift: { drifted: boolean; versionsBehind: number } | null = null;
	if (entry && entryReadable) {
		const drifted = !!sub.baseRevisionId && sub.baseRevisionId !== entry.currentRevisionId;
		drift = {
			drifted,
			versionsBehind: drifted
				? await countVersionsBehind(sub.baseRevisionId, entry.currentRevisionId)
				: 0,
		};
	}

	// Rounds of the same proposal (resubmits share the draft). Restricted to the same target so
	// a standalone draft re-targeted elsewhere never surfaces another collection's request.
	const history = await readQuery(
		db.query.knowledgeSubmissions.findMany({
			where: (s, { eq: e }) => e(s.draftId, sub.draftId),
			columns: {
				id: true,
				entryId: true,
				collectionId: true,
				changeNote: true,
				round: true,
				status: true,
				verdict: true,
				findingsJson: true,
				reviewerUserId: true,
				reviewedAt: true,
				createdAt: true,
			},
			orderBy: (s, { desc: d }) => [d(s.createdAt)],
			limit: SUBMISSION_HISTORY_LIMIT,
		}),
	);
	const sameTarget = history.filter(
		(h) => h.entryId === sub.entryId && h.collectionId === sub.collectionId,
	);
	const names = await usernamesById([
		sub.submitterUserId,
		sub.reviewerUserId,
		...sameTarget.map((h) => h.reviewerUserId),
	]);

	return {
		...sub,
		diff,
		baseContent,
		currentMainContent: entry && entryReadable ? (entry.currentContent ?? "") : null,
		entryTitle: entry && entryReadable ? entry.title : null,
		targetCollectionId: collection?.id ?? sub.collectionId ?? null,
		collectionName: collection && collectionReadable ? collection.name : null,
		submitterUsername: names.get(sub.submitterUserId) ?? null,
		reviewerUsername: sub.reviewerUserId ? (names.get(sub.reviewerUserId) ?? null) : null,
		drift,
		history: sameTarget.map(({ entryId: _e, collectionId: _c, ...h }) => ({
			...h,
			reviewerUsername: h.reviewerUserId ? (names.get(h.reviewerUserId) ?? null) : null,
		})),
		viewerCaps: submissionViewerCaps(principal, sub, authority.ok),
	};
}

/**
 * The reviewer list ({@link listSubmissions}) plus per-row display metadata for the review
 * inbox: entry title (only when the caller can READ the entry), target collection id/name
 * (name only when readable), submitter username, and a drift flag for open linked requests.
 * Bounded by the list cap; three `inArray` lookups, no per-row queries.
 */
async function listSubmissionsForInbox(
	principal: Principal,
	opts: { entryId?: string; status?: string; limit?: number },
) {
	const rows = await listSubmissions(principal, opts);
	if (rows.length === 0) return [];
	const caps = await resolvePrincipalCaps(principal);
	const entryIds = [...new Set(rows.map((s) => s.entryId).filter((id): id is string => !!id))];
	const entries =
		entryIds.length > 0
			? await readQuery(
					db.query.knowledgeEntries.findMany({
						where: (e, { inArray: ia }) => ia(e.id, entryIds),
						columns: {
							id: true,
							title: true,
							collectionId: true,
							ownerUserId: true,
							classificationLevel: true,
							controlledTagsJson: true,
							reviewTagsJson: true,
							currentRevisionId: true,
						},
					}),
				)
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
			? await readQuery(
					db.query.knowledgeCollections.findMany({
						where: (c, { inArray: ia }) => ia(c.id, colIds),
						columns: {
							id: true,
							name: true,
							defaultLevel: true,
							classificationLevel: true,
							controlledTagsJson: true,
							ownerUserId: true,
						},
					}),
				)
			: [];
	const colById = new Map(cols.map((c) => [c.id, c]));
	const names = await usernamesById(rows.map((s) => s.submitterUserId));

	const out = [];
	for (const s of rows) {
		const entry = s.entryId ? entryById.get(s.entryId) : undefined;
		const colId = entry?.collectionId ?? s.collectionId ?? null;
		const col = colId ? colById.get(colId) : undefined;
		const aclCol = col ? toAclCollection(col) : null;
		const colReadable = !!aclCol && (await canReadCollection(caps, aclCol));
		const entryReadable = !!entry && !!aclCol && (await canRead(caps, toAclEntry(entry), aclCol));
		const open = s.status === "pending" || s.status === "conflict";
		out.push({
			...s,
			entryTitle: entry && entryReadable ? entry.title : null,
			targetCollectionId: colId,
			collectionName: col && colReadable ? col.name : null,
			submitterUsername: names.get(s.submitterUserId) ?? null,
			drifted:
				open && entry && entryReadable
					? !!s.baseRevisionId && s.baseRevisionId !== entry.currentRevisionId
					: null,
		});
	}
	return out;
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
/**
 * Author-facing verdicts from the last 30 days.
 *
 * The notification bell reads this instead of the `notifications` table. That table's
 * activity projection re-joins source rows and would have to store a title; knowledge
 * titles are classified, so review events stay id-only here (no title, change note, or
 * proposed content). Findings are included because they are the reviewer's notes to the
 * author of this submission — the same rows `listSubmissionsForDraft` already returns.
 *
 * Pending requests are omitted: the author just submitted those. `changes_requested`,
 * `approved`, and `rejected` are the verdicts they would otherwise miss.
 */
const SUBMISSION_OUTCOME_STATUSES = ["approved", "rejected", "changes_requested"] as const;
const SUBMISSION_OUTCOME_LIMIT = 30;
const SUBMISSION_OUTCOME_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

async function listMySubmissionOutcomes(principal: Principal, opts: { limit?: number } = {}) {
	if (!principal.userId) return [];
	const limit = Math.min(opts.limit ?? SUBMISSION_OUTCOME_LIMIT, SUBMISSION_OUTCOME_LIMIT);
	const cutoff = new Date(Date.now() - SUBMISSION_OUTCOME_MAX_AGE_MS).toISOString();
	return readQuery(
		db.query.knowledgeSubmissions.findMany({
			where: (s, { and: a, eq: e, inArray: ia, gte }) =>
				a(
					e(s.submitterUserId, principal.userId),
					ia(s.status, [...SUBMISSION_OUTCOME_STATUSES]),
					gte(s.reviewedAt, cutoff),
				),
			columns: {
				id: true,
				draftId: true,
				entryId: true,
				status: true,
				verdict: true,
				findingsJson: true,
				reviewedAt: true,
				createdAt: true,
			},
			orderBy: (s, { desc: d }) => [d(s.reviewedAt)],
			limit,
		}),
	);
}

async function listMyOpenSubmissions(principal: Principal, opts: { limit?: number } = {}) {
	if (!principal.userId) return [];
	const limit = Math.min(opts.limit ?? SUBMISSION_LIST_MAX, SUBMISSION_LIST_MAX);
	return readQuery(
		db.query.knowledgeSubmissions.findMany({
			where: (s, { and: a, eq: e, inArray: ia }) =>
				a(
					e(s.submitterUserId, principal.userId),
					ia(s.status, ["pending", "conflict", "changes_requested"]),
				),
			columns: { id: true, draftId: true, entryId: true, status: true, createdAt: true },
			orderBy: (s, { desc: d }) => [d(s.createdAt)],
			limit,
		}),
	);
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
	return readQuery(
		db.query.knowledgeSubmissions.findMany({
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
		}),
	);
}

// ─── Author-side state machine closure (withdraw / resubmit) ─────────────

/**
 * Statuses a submitter may withdraw (`WITHDRAWABLE_SUBMISSION_STATUSES` in the port):
 * nothing has been merged in any of them, so retracting is always safe:
 *
 * - `pending` / `conflict` — the request is still open and awaiting a reviewer.
 * - `changes_requested` — the reviewer bounced it back, so the ball is in the AUTHOR's court.
 *   Without this, an author who decides NOT to make the requested changes had no exit at all:
 *   `resubmit` was the only transition out, so abandoning the idea left the request parked in
 *   both the author's and the reviewer's lists forever. Withdrawing says "I'm dropping this",
 *   which is exactly the author-side decision that was missing.
 */

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
	if (!canActAsSubmitter(principal, sub)) {
		throw new NotFoundError("Knowledge submission", submissionId);
	}
	if (!isWithdrawableStatus(sub.status)) {
		throw new ValidationError(
			`Submission is ${sub.status} and can no longer be withdrawn ` +
				`(only pending, conflict, or changes_requested requests can)`,
		);
	}
	const now = nowIso();
	// The store re-checks the status INSIDE the section (under the submission row's
	// lock) so a reviewer who just approved isn't overwritten back to a non-terminal
	// state; false means someone else already closed it.
	const changed = await knowledgeWriteStore.withdrawSubmissionGuarded({
		submissionId,
		// Keep any reviewer note; only append the author's own reason when given.
		...(input.reason?.trim()
			? {
					changeNote: `${sub.changeNote ? `${sub.changeNote}\n` : ""}[withdrawn] ${input.reason.trim()}`,
				}
			: {}),
		now,
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
	if (!canActAsSubmitter(principal, sub)) {
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
			? await readQuery(
					db.query.knowledgeTags.findMany({
						where: (tg, { inArray: ia }) => ia(tg.id, idList),
						columns: { id: true, name: true },
						limit: REVIEW_SCOPE_LIMIT,
					}),
				)
			: [];
	const nameById = new Map(tagRows.map((tg) => [tg.id, tg.name]));
	// A granted tag whose row was deleted still confers authority in canReview (it compares
	// ids), so report the id rather than dropping it silently.
	const reviewTags = idList.map((id) => ({ id, name: nameById.get(id) ?? id }));

	// Collections the caller may write into (→ may approve standalone publishes there).
	// Read gate first (so an unreadable collection is never named), then the write gate.
	// LIMIT + 1 detects "more than the cap" without a COUNT(*).
	const cols = await readQuery(
		db.query.knowledgeCollections.findMany({
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
		}),
	);
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
		: await readQuery(
				db.query.knowledgeEntries.findMany({
					where: (e, { eq: eqOp }) => eqOp(e.ownerUserId, principal.userId),
					columns: { id: true },
					limit: REVIEW_SCOPE_LIMIT + 1,
				}),
			);
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
	listMineForViewer,
	findDriftedDraftIds,
	getMine,
	getMineForViewer,
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
	listMySubmissionOutcomes,
	countReviewInbox,
	getSubmission,
	getSubmissionForViewer,
	listSubmissionsForInbox,
	withdrawSubmission,
	resubmit,
	getMyReviewScope,
};
