/**
 * SQLite implementation of `OutlineStore`.
 *
 * `applyCommit` is one STRICTLY SYNCHRONOUS `db.transaction` callback: `bun:sqlite` commits when
 * the callback returns, so an `await` inside would commit early and leave the rest in autocommit
 * (see `server/db/transaction-atomicity-contract.test.ts`). The plan arrives fully decided, so
 * the section only claims the seq and writes rows, in the order `OutlineCommitPlan` documents.
 * It runs under `withDbRetry` for transient lock contention, like the other SQLite write stores.
 *
 * Reads are single indexed statements with explicit limits; the methods are `async` only so the
 * caller cannot tell this store from the PostgreSQL one.
 *
 * Uniqueness violations are recognized structurally (the driver's extended result code on
 * `errno`) and cross the port as `WriteConflictError`.
 */
import { WriteConflictError } from "@server/db/backend/write-port";
import {
	and,
	asc,
	desc,
	eq,
	getTableColumns,
	gt,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	ne,
	notInArray,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { db, sqlite } from "../../../db";
import {
	narrators,
	outlineBlocks,
	outlineBlockVersions,
	outlineCommits,
	outlineLinks,
	outlineLiveUpdates,
	outlinePending,
	outlineQuestions,
	outlineSpaces,
	outlineTaskClaims,
	outlineTaskSeen,
	outlineViewState,
} from "../../../db/schema";
import { withDbRetry } from "../../../lib/db-resilience";
import { generateId } from "../../../lib/id";
import { newOutlineKey } from "../keys";
import type {
	OutlineActorKind,
	OutlineCommitKind,
	OutlineLinkKind,
	OutlinePendingKind,
	OutlinePendingStatus,
	OutlineSpaceKind,
} from "../model";
import {
	chunked,
	claimsAsExpected,
	expectedClaimIds,
	expectedPendingRevs,
	inIdOrder,
	type NarratorStateRow,
	narratorSessions,
	OUTLINE_BATCH_SPACES,
	OUTLINE_HISTORY_LIMITS,
	OUTLINE_RENEW_LIMIT,
	type OutlineBlockMeta,
	type OutlineBlockRow,
	OutlineChangeMarksLimitError,
	OutlineClaimsMovedError,
	type OutlineClaimWrite,
	type OutlineCommitPlan,
	type OutlineCommitRow,
	type OutlineLinkRow,
	type OutlineLiveUpdateRow,
	type OutlinePendingDecision,
	type OutlinePendingHead,
	OutlinePendingMovedError,
	type OutlinePendingPlan,
	type OutlinePendingRow,
	type OutlineQuestionRow,
	type OutlineQuestionWrite,
	type OutlineSpaceRow,
	type OutlineSpaceScope,
	OutlineStaleWriteError,
	type OutlineStore,
	type OutlineTaskClaimRow,
	type OutlineTaskSeenRow,
	type OutlineVersionRow,
	type OutlineViewStateRow,
	oldestClaimsFirst,
	pendingAsExpected,
	placedBlockIds,
	writesAsExpected,
} from "./port";
import { sqliteOutlineDigests } from "./sqlite-digest";
import { createSqliteOutlineHistory } from "./sqlite-history";
import { sqliteOutlineReads } from "./sqlite-read";

/**
 * How SQLite reads a block's task status, its lock and whether it is live, for a block aliased
 * `alias`: the text of the partial indexes' own predicates (`schema.ts`), so a statement built
 * from it is served by them. For reads written once for both backends that must name these
 * (`access-reads.ts`: the connected outline's row facts); the PostgreSQL side spells the same
 * with `#>>` there, as `postgres-store.ts` does.
 */
export function sqliteTaskPredicateText(alias: string): {
	status: string;
	lock: string;
	live: string;
} {
	return {
		status: `json_extract(${alias}."task_json", '$.status')`,
		lock: `json_extract(${alias}."task_json", '$.lock')`,
		live: `${alias}."deleted" = 0`,
	};
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Extended result codes for a uniqueness conflict (primary key, unique index). */
const CONSTRAINT_PRIMARYKEY_ERRNO = 1555;
const CONSTRAINT_UNIQUE_ERRNO = 2067;
const MAX_CAUSE_DEPTH = 8;
/** Rows per multi-row INSERT: 14 columns each stays far below the bound-parameter limit. */
const INSERT_CHUNK = 100;
/** Attempts to find an unused space key before giving up (keys are random; one is enough). */
const SPACE_KEY_ATTEMPTS = 4;

function isUniqueViolation(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (!current || typeof current !== "object") return false;
		const errno = (current as Record<string, unknown>).errno;
		if (errno === CONSTRAINT_PRIMARYKEY_ERRNO || errno === CONSTRAINT_UNIQUE_ERRNO) return true;
		current = (current as Record<string, unknown>).cause;
	}
	return false;
}

function rethrowAsPortError(error: unknown): never {
	if (isUniqueViolation(error)) {
		const message = error instanceof Error ? error.message : String(error);
		throw new WriteConflictError("outline write conflicts with an existing row", {
			constraint: /UNIQUE constraint failed: (.+)/i.exec(message)?.[1]?.trim() ?? null,
			cause: error,
		});
	}
	throw error;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row mapping
// ─────────────────────────────────────────────────────────────────────────────

type SpaceSelect = typeof outlineSpaces.$inferSelect;
type BlockSelect = typeof outlineBlocks.$inferSelect;
type VersionSelect = typeof outlineBlockVersions.$inferSelect;
type LinkSelect = typeof outlineLinks.$inferSelect;
type CommitSelect = typeof outlineCommits.$inferSelect;
type LiveUpdateSelect = typeof outlineLiveUpdates.$inferSelect;

function toSpace(row: SpaceSelect): OutlineSpaceRow {
	// `in_process_ready` is bookkeeping of the in-process rebuild, `last_commit_at` the reports'
	// (read through `listSpacesCommittedSince`), the history floor and `edges_ready` the
	// placement reads' (`getHistoryStates`): none is part of a space's row.
	const {
		inProcessReady: _ready,
		lastCommitAt: _last,
		historyFloorSeq: _floor,
		edgesReady: _edges,
		...space
	} = row;
	return { ...space, kind: row.kind as OutlineSpaceKind };
}

function toBlock(row: BlockSelect): OutlineBlockRow {
	return {
		...row,
		taskJson: row.taskJson ?? null,
		askJson: row.askJson ?? null,
		authorKind: row.authorKind as OutlineActorKind,
	};
}

function toVersion(row: VersionSelect): OutlineVersionRow {
	return { ...row, taskJson: row.taskJson ?? null, askJson: row.askJson ?? null };
}

function toLink(row: LinkSelect): OutlineLinkRow {
	return { ...row, kind: row.kind as OutlineLinkKind };
}

function toCommit(row: CommitSelect): OutlineCommitRow {
	return {
		...row,
		kind: row.kind as OutlineCommitKind,
		actorKind: row.actorKind as OutlineActorKind,
	};
}

function toLiveUpdate(row: LiveUpdateSelect): OutlineLiveUpdateRow {
	return { ...row, actorKind: row.actorKind as OutlineActorKind };
}

/** Rows per multi-row INSERT of the live log (7 columns each). */
type ViewStateSelect = typeof outlineViewState.$inferSelect;

function toViewState(row: ViewStateSelect): OutlineViewStateRow {
	return {
		userId: row.userId,
		pageBlockId: row.pageBlockId,
		collapsed: Array.isArray(row.collapsedJson) ? row.collapsedJson : [],
		expanded: Array.isArray(row.expandedJson) ? row.expandedJson : [],
		layout: row.layout === "down" ? "down" : "right",
		updatedAt: row.updatedAt,
	};
}

const LIVE_INSERT_CHUNK = 50;

const metaColumns = {
	id: outlineBlocks.id,
	spaceId: outlineBlocks.spaceId,
	sid: outlineBlocks.sid,
	parentId: outlineBlocks.parentId,
	pageId: outlineBlocks.pageId,
	orderKey: outlineBlocks.orderKey,
	contentHash: outlineBlocks.contentHash,
	alias: outlineBlocks.alias,
	taskJson: outlineBlocks.taskJson,
	askJson: outlineBlocks.askJson,
	versionSeq: outlineBlocks.versionSeq,
	deleted: outlineBlocks.deleted,
	inProcess: outlineBlocks.inProcess,
};

function toMeta(row: {
	id: string;
	spaceId: string;
	sid: string;
	parentId: string | null;
	pageId: string;
	orderKey: string;
	contentHash: string;
	alias: string | null;
	taskJson: BlockSelect["taskJson"];
	askJson: BlockSelect["askJson"];
	versionSeq: number;
	deleted: boolean;
	inProcess: boolean;
}): OutlineBlockMeta {
	return { ...row, taskJson: row.taskJson ?? null, askJson: row.askJson ?? null };
}

type QuestionSelect = typeof outlineQuestions.$inferSelect;

function toQuestion(row: QuestionSelect): OutlineQuestionRow {
	return { ...row, state: row.state as OutlineQuestionRow["state"] };
}

/** Insert a question row, or update an existing one but for its asker and creation. */
function putQuestion(tx: Tx, write: OutlineQuestionWrite): void {
	const { row } = write;
	tx.insert(outlineQuestions)
		.values(row)
		.onConflictDoUpdate({
			target: outlineQuestions.blockId,
			set: {
				state: row.state,
				proceed: row.proceed,
				toUserId: row.toUserId,
				answeredAt: row.answeredAt,
				answerCommitId: row.answerCommitId,
				...(write.setDelivered ? { deliveredAt: row.deliveredAt } : {}),
			},
		})
		.run();
}

function scopeCondition(scope: OutlineSpaceScope): SQL | undefined {
	switch (scope.kind) {
		case "project":
			return and(eq(outlineSpaces.kind, "project"), eq(outlineSpaces.projectId, scope.projectId));
		case "personal":
			return and(
				eq(outlineSpaces.kind, "personal"),
				eq(outlineSpaces.ownerUserId, scope.ownerUserId),
			);
		case "session":
			return and(eq(outlineSpaces.kind, "session"), eq(outlineSpaces.narratorId, scope.narratorId));
	}
}

function findSpaceIn(tx: Tx, scope: OutlineSpaceScope): OutlineSpaceRow | null {
	const row = tx.select().from(outlineSpaces).where(scopeCondition(scope)).limit(1).get();
	return row ? toSpace(row) : null;
}

function idList(ids: readonly string[]): SQL {
	return sql.join(
		ids.map((id) => sql`${id}`),
		sql`, `,
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The atomic section
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mark every ancestor of `ids` as the tree is at this point of the section (called before the
 * commit's block changes and again after them), each `(ancestor, seq)` once. The walk goes up
 * the blocks' parent column by primary key (the join order pinned), whether or not a block on
 * the way is deleted. Ancestors marked already are left out before the limit, which is one past
 * what is left of the commit's allowance; returns how many rows it added.
 */
function markAncestors(tx: Tx, ids: readonly string[], seq: number, room: number): number {
	let added = 0;
	for (const chunk of chunked(ids)) {
		added += tx.all(sql`
			WITH RECURSIVE up(id) AS (
				SELECT parent_id FROM outline_blocks
				WHERE id IN (${idList(chunk)}) AND parent_id IS NOT NULL
				UNION
				SELECT b.parent_id FROM up CROSS JOIN outline_blocks b
					ON b.id = up.id WHERE b.parent_id IS NOT NULL
			)
			INSERT INTO outline_subtree_changes (ancestor_id, seq)
			SELECT up.id, ${seq} FROM up
			WHERE NOT EXISTS (SELECT 1 FROM outline_subtree_changes m
				WHERE m.ancestor_id = up.id AND m.seq = ${seq})
			LIMIT ${room - added + 1}
			RETURNING 1
		`).length;
		if (added > room) break;
	}
	return added;
}

/**
 * Close the open placement of the blocks whose placement this commit changes, and open one for
 * those that are live, from their new rows (see `OutlineCommitPlan`).
 */
function writePlacements(tx: Tx, ids: readonly string[], seq: number): void {
	for (const chunk of chunked(ids)) {
		tx.run(sql`
			UPDATE outline_block_edges SET to_seq = ${seq}
			WHERE block_id IN (${idList(chunk)}) AND to_seq IS NULL
		`);
		tx.run(sql`
			INSERT INTO outline_block_edges (parent_key, block_id, from_seq, to_seq, order_key)
			SELECT COALESCE(parent_id, space_id), id, ${seq}, NULL, order_key
			FROM outline_blocks WHERE id IN (${idList(chunk)}) AND deleted = 0
		`);
	}
}

/**
 * The whole commit. Returns false, having written nothing, when the space counter is no longer
 * at the plan's seq; returning (rather than throwing) keeps an expected outcome out of the retry
 * wrapper's error log.
 */
function applyCommitSection(
	tx: Tx,
	plan: OutlineCommitPlan,
): "applied" | "stale" | "claims" | "pending" {
	const { seq } = plan;
	// The claims the plan read must still be as read (a lease renewed since may have made a
	// takeover wrong). Nothing writes inside this synchronous section but this section.
	const expected = expectedClaimIds(plan);
	if (expected.length > 0 && !claimsAsExpected(plan, readClaims(tx, expected))) return "claims";
	// So must the pending rows it merges into or decides.
	if (!pendingAsExpected(plan.pending, readPendingRevs(tx, plan.pending))) return "pending";
	// The counter and the in-process epoch are claimed together; a commit that cannot keep its
	// in-process answers marks the space for the rebuild in the same statement.
	const claimed = tx
		.update(outlineSpaces)
		.set({
			nextSeq: sql`${outlineSpaces.nextSeq} + 1`,
			// Which spaces had commits when (the reports, P2 PR 11): no extra statement.
			lastCommitAt: plan.commit.createdAt,
			...(plan.inProcessStale
				? { inProcessReady: false, inProcessEpoch: sql`${outlineSpaces.inProcessEpoch} + 1` }
				: {}),
		})
		.where(
			and(
				eq(outlineSpaces.id, plan.spaceId),
				eq(outlineSpaces.nextSeq, seq),
				plan.inProcessEpoch === null
					? undefined
					: eq(outlineSpaces.inProcessEpoch, plan.inProcessEpoch),
			),
		)
		.returning({ nextSeq: outlineSpaces.nextSeq })
		.get();
	if (!claimed) return "stale";

	tx.insert(outlineCommits).values(plan.commit).run();

	// Change marks, first half: the ancestors of the changed blocks as the tree was.
	const maxMarks = OUTLINE_HISTORY_LIMITS.maxChangeMarks;
	let marks = markAncestors(tx, plan.closeVersionIds, seq, maxMarks);
	if (marks > maxMarks) throw new OutlineChangeMarksLimitError(plan.spaceId);

	let closed = 0;
	for (const ids of chunked(plan.closeVersionIds)) {
		closed += tx
			.update(outlineBlockVersions)
			.set({ toSeq: seq })
			.where(and(inArray(outlineBlockVersions.blockId, ids), isNull(outlineBlockVersions.toSeq)))
			.returning({ blockId: outlineBlockVersions.blockId })
			.all().length;
	}
	if (closed !== plan.closeVersionIds.length) {
		throw new Error(
			`outline history out of step: closed ${closed} of ${plan.closeVersionIds.length} open versions`,
		);
	}

	const realiased = plan.patchBlocks.filter((group) => group.patch.alias !== undefined);
	for (const group of realiased) {
		for (const ids of chunked(group.ids)) {
			tx.update(outlineBlocks).set({ alias: null }).where(inArray(outlineBlocks.id, ids)).run();
		}
	}
	const patches = [...plan.patchBlocks].sort(
		(a, b) => Number(b.patch.deleted === true) - Number(a.patch.deleted === true),
	);
	for (const group of patches) {
		for (const ids of chunked(group.ids)) {
			tx.update(outlineBlocks)
				.set({ ...group.patch, versionSeq: seq })
				.where(inArray(outlineBlocks.id, ids))
				.run();
		}
	}

	for (const rows of chunked(plan.insertBlocks, INSERT_CHUNK)) {
		tx.insert(outlineBlocks).values(rows).run();
	}

	for (const group of plan.versions) {
		for (const ids of chunked(group.ids)) {
			tx.run(sql`
				INSERT INTO outline_block_versions (
					block_id, from_seq, to_seq, commit_id, page_id, parent_id, order_key, content,
					task_json, ask_json, alias, content_hash, change_flags, deleted
				)
				SELECT id, ${seq}, NULL, ${plan.commit.id}, page_id, parent_id, order_key,
					CASE WHEN deleted = 1 THEN NULL ELSE content END,
					task_json, ask_json, alias, content_hash, ${group.flags}, deleted
				FROM outline_blocks WHERE id IN (${idList(ids)})
			`);
		}
	}

	// Change marks, second half: the ancestors of every changed block as the tree is now.
	marks += markAncestors(
		tx,
		plan.versions.flatMap((group) => group.ids),
		seq,
		maxMarks - marks,
	);
	if (marks > maxMarks) throw new OutlineChangeMarksLimitError(plan.spaceId);
	writePlacements(tx, placedBlockIds(plan), seq);

	for (const ids of chunked(plan.closeLinkIds)) {
		tx.update(outlineLinks)
			.set({ toSeq: seq })
			.where(and(inArray(outlineLinks.id, ids), isNull(outlineLinks.toSeq)))
			.run();
	}
	for (const rows of chunked(plan.insertLinks, INSERT_CHUNK)) {
		tx.insert(outlineLinks).values(rows).run();
	}

	for (const group of plan.inProcess) {
		for (const ids of chunked(group.ids)) {
			tx.update(outlineBlocks)
				.set({ inProcess: group.value })
				.where(inArray(outlineBlocks.id, ids))
				.run();
		}
	}

	const released = [...plan.claims.release, ...plan.claims.expire.map((e) => e.expect.taskBlockId)];
	for (const ids of chunked(released)) {
		// The holder moves into `last_holder_*` (the right-hand sides read the row as it was).
		tx.update(outlineTaskClaims)
			.set(RELEASE_CLAIM)
			.where(
				and(
					inArray(outlineTaskClaims.taskBlockId, ids),
					or(
						isNotNull(outlineTaskClaims.holderNarratorId),
						isNotNull(outlineTaskClaims.holderUserId),
					),
				),
			)
			.run();
	}
	for (const { row } of plan.claims.put) putClaim(tx, row);
	if (plan.pending) writePending(tx, plan.pending);
	for (const write of plan.questions ?? []) putQuestion(tx, write);
	return "applied";
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending changes
// ─────────────────────────────────────────────────────────────────────────────

type PendingSelect = typeof outlinePending.$inferSelect;

function toPending(row: PendingSelect): OutlinePendingRow {
	return {
		...row,
		kind: row.kind as OutlinePendingKind,
		status: row.status as OutlinePendingStatus,
		decidedByJson: row.decidedByJson ?? null,
	};
}

/** Every column but the operations and the deleted subtrees: what lists and summaries read. */
const pendingHeadColumns = (() => {
	const { opsJson: _ops, subtreeJson: _subtree, ...columns } = getTableColumns(outlinePending);
	return columns;
})();

function toPendingHead(row: Omit<PendingSelect, "opsJson" | "subtreeJson">): OutlinePendingHead {
	return {
		...row,
		kind: row.kind as OutlinePendingKind,
		status: row.status as OutlinePendingStatus,
		decidedByJson: row.decidedByJson ?? null,
	};
}

/** Status and revision of the rows a pending plan expects, by id. */
function readPendingRevs(
	tx: Tx,
	pending: OutlinePendingPlan | undefined,
): Map<string, { status: string; rev: number }> {
	const ids = [...expectedPendingRevs(pending).keys()];
	const found = new Map<string, { status: string; rev: number }>();
	if (ids.length === 0) return found;
	for (const row of tx
		.select({ id: outlinePending.id, status: outlinePending.status, rev: outlinePending.rev })
		.from(outlinePending)
		.where(inArray(outlinePending.id, ids))
		.all())
		found.set(row.id, row);
	return found;
}

/** A decision's columns. */
function decisionSet(decision: OutlinePendingDecision) {
	return {
		status: decision.status,
		decidedAt: decision.decidedAt,
		decidedByJson: decision.decidedBy,
		decisionCommitId: decision.decisionCommitId,
		reason: decision.reason,
		reportedAt: decision.reportedAt,
		updatedAt: decision.decidedAt,
	};
}

/** Withdraw, repage, decide, put, in that order (the plan's expectations were checked already). */
function writePending(tx: Tx, pending: OutlinePendingPlan): void {
	const withdraw = pending.withdraw;
	if (withdraw) {
		for (const ids of chunked(withdraw.rootBlockIds)) {
			tx.update(outlinePending)
				.set({
					status: "withdrawn",
					decidedAt: withdraw.decidedAt,
					decidedByJson: withdraw.decidedBy,
					reason: withdraw.reason,
					updatedAt: withdraw.decidedAt,
				})
				.where(and(inArray(outlinePending.rootBlockId, ids), sql`"status" = 'open'`))
				.run();
		}
	}
	for (const move of pending.repage ?? []) {
		tx.update(outlinePending)
			.set({ pageId: move.pageId })
			.where(and(eq(outlinePending.rootBlockId, move.rootBlockId), sql`"status" = 'open'`))
			.run();
	}
	if (pending.decide) {
		tx.update(outlinePending)
			.set(decisionSet(pending.decide))
			.where(eq(outlinePending.id, pending.decide.id))
			.run();
	}
	const put = pending.put;
	if (put) {
		if (put.expectRev === null) tx.insert(outlinePending).values(put.row).run();
		else {
			const { id, ...columns } = put.row;
			tx.update(outlinePending).set(columns).where(eq(outlinePending.id, id)).run();
		}
	}
}

/** A plan's pending changes alone, while the space's counter is still `seq`. */
function applyPendingSection(
	tx: Tx,
	plan: { spaceId: string; seq: number; pending: OutlinePendingPlan },
): "applied" | "stale" | "pending" {
	if (!pendingAsExpected(plan.pending, readPendingRevs(tx, plan.pending))) return "pending";
	const space = tx
		.select({ nextSeq: outlineSpaces.nextSeq })
		.from(outlineSpaces)
		.where(eq(outlineSpaces.id, plan.spaceId))
		.get();
	if (!space || space.nextSeq !== plan.seq) return "stale";
	writePending(tx, plan.pending);
	return "applied";
}

/** What releasing a claim sets. */
const RELEASE_CLAIM = {
	lastHolderNarratorId: sql`"holder_narrator_id"`,
	lastHolderUserId: sql`"holder_user_id"`,
	holderNarratorId: null,
	holderUserId: null,
	expiresAt: null,
};

function putClaim(tx: Tx, row: OutlineTaskClaimRow): void {
	const { taskBlockId: _, ...columns } = row;
	tx.insert(outlineTaskClaims)
		.values(row)
		.onConflictDoUpdate({ target: outlineTaskClaims.taskBlockId, set: columns })
		.run();
}

function readClaims(tx: Tx, taskIds: readonly string[]): Map<string, OutlineTaskClaimRow> {
	const found = new Map<string, OutlineTaskClaimRow>();
	for (const ids of chunked(taskIds)) {
		for (const row of tx
			.select()
			.from(outlineTaskClaims)
			.where(inArray(outlineTaskClaims.taskBlockId, ids))
			.all())
			found.set(row.taskBlockId, row);
	}
	return found;
}

/** Claim rows written outside a commit, only while each is still the row expected. */
function updateClaimsSection(tx: Tx, writes: readonly OutlineClaimWrite[]): boolean {
	const found = readClaims(
		tx,
		writes.map((w) => w.row.taskBlockId),
	);
	if (!writesAsExpected(writes, found)) return false;
	for (const { row } of writes) putClaim(tx, row);
	return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// The store
// ─────────────────────────────────────────────────────────────────────────────

export const sqliteOutlineStore: OutlineStore = {
	backendId: "sqlite",
	...sqliteOutlineReads,
	...sqliteOutlineDigests,
	...createSqliteOutlineHistory(() => sqlite),

	async ensureSpace(scope, now) {
		for (let attempt = 0; attempt < SPACE_KEY_ATTEMPTS; attempt++) {
			const row = db.transaction((tx) => {
				const existing = findSpaceIn(tx, scope);
				if (existing) return existing;
				tx.insert(outlineSpaces)
					.values({
						id: generateId(),
						key: newOutlineKey(),
						kind: scope.kind,
						projectId: scope.kind === "project" ? scope.projectId : null,
						narratorId: scope.kind === "session" ? scope.narratorId : null,
						ownerUserId: scope.kind === "personal" ? scope.ownerUserId : null,
						nextSeq: 1,
						createdAt: now,
						// Every block of a new space is written by a path that derives it.
						inProcessReady: true,
						// And placed by the commit that writes it: nothing for the conversion to do.
						edgesReady: true,
					})
					.onConflictDoNothing()
					.run();
				// Nothing inserted means the random key was taken; try another.
				return findSpaceIn(tx, scope);
			});
			if (row) return row;
		}
		throw new Error(`could not allocate an outline space key for ${scope.kind}`);
	},

	async getSpace(id) {
		const row = db.select().from(outlineSpaces).where(eq(outlineSpaces.id, id)).limit(1).get();
		return row ? toSpace(row) : null;
	},

	async getSpaceByKey(key) {
		const row = db.select().from(outlineSpaces).where(eq(outlineSpaces.key, key)).limit(1).get();
		return row ? toSpace(row) : null;
	},

	async findSpace(scope) {
		const row = db.select().from(outlineSpaces).where(scopeCondition(scope)).limit(1).get();
		return row ? toSpace(row) : null;
	},

	async getBlockMetas(spaceId, by) {
		const out: OutlineBlockMeta[] = [];
		for (const ids of chunked(by.ids ?? [])) {
			const rows = db
				.select(metaColumns)
				.from(outlineBlocks)
				.where(and(eq(outlineBlocks.spaceId, spaceId), inArray(outlineBlocks.id, ids)))
				.all();
			for (const row of rows) out.push(toMeta(row));
		}
		for (const sids of chunked(by.sids ?? [])) {
			const rows = db
				.select(metaColumns)
				.from(outlineBlocks)
				.where(and(eq(outlineBlocks.spaceId, spaceId), inArray(outlineBlocks.sid, sids)))
				.all();
			for (const row of rows) out.push(toMeta(row));
		}
		return out;
	},

	async findExistingBlockIds(ids) {
		const out: string[] = [];
		for (const chunk of chunked(ids)) {
			const rows = db
				.select({ id: outlineBlocks.id })
				.from(outlineBlocks)
				.where(inArray(outlineBlocks.id, chunk))
				.all();
			for (const row of rows) out.push(row.id);
		}
		return out;
	},

	async listChildMetas(spaceId, parentIds, limit) {
		const out: OutlineBlockMeta[] = [];
		const ids = parentIds.filter((id): id is string => id !== null);
		const pages = parentIds.includes(null);
		const groups: Array<SQL | undefined> = chunked(ids).map((chunk) =>
			inArray(outlineBlocks.parentId, chunk),
		);
		if (pages) groups.push(isNull(outlineBlocks.parentId));
		for (const parents of groups) {
			if (out.length >= limit) break;
			const rows = db
				.select(metaColumns)
				.from(outlineBlocks)
				.where(and(eq(outlineBlocks.spaceId, spaceId), parents, eq(outlineBlocks.deleted, false)))
				.limit(limit - out.length)
				.all();
			for (const row of rows) out.push(toMeta(row));
		}
		return out;
	},

	async listLastChildMetas(spaceId, parentId, limit) {
		// SQLite compares text bytewise (BINARY), which is the order-key order.
		return db
			.select(metaColumns)
			.from(outlineBlocks)
			.where(
				and(
					eq(outlineBlocks.spaceId, spaceId),
					eq(outlineBlocks.parentId, parentId),
					eq(outlineBlocks.deleted, false),
				),
			)
			.orderBy(desc(outlineBlocks.orderKey), desc(outlineBlocks.id))
			.limit(limit)
			.all()
			.map(toMeta);
	},

	async findAliasOwners(spaceId, aliases) {
		const out: Array<{ alias: string; id: string }> = [];
		for (const chunk of chunked(aliases)) {
			// The literal `deleted = 0` lets the planner use the partial unique alias index.
			const rows = db
				.select({ alias: outlineBlocks.alias, id: outlineBlocks.id })
				.from(outlineBlocks)
				.where(
					and(
						eq(outlineBlocks.spaceId, spaceId),
						inArray(outlineBlocks.alias, chunk),
						sql`${outlineBlocks.deleted} = 0`,
					),
				)
				.all();
			for (const row of rows) if (row.alias !== null) out.push({ alias: row.alias, id: row.id });
		}
		return out;
	},

	async listOpenLinks(blockIds, limit) {
		const out: OutlineLinkRow[] = [];
		for (const ids of chunked(blockIds)) {
			if (out.length >= limit) break;
			const rows = db
				.select()
				.from(outlineLinks)
				.where(and(inArray(outlineLinks.fromBlockId, ids), isNull(outlineLinks.toSeq)))
				.limit(limit - out.length)
				.all();
			for (const row of rows) out.push(toLink(row));
		}
		return out;
	},

	async getBlock(id) {
		const row = db.select().from(outlineBlocks).where(eq(outlineBlocks.id, id)).limit(1).get();
		return row ? toBlock(row) : null;
	},

	async getBlockBySid(spaceId, sid) {
		const row = db
			.select()
			.from(outlineBlocks)
			.where(and(eq(outlineBlocks.spaceId, spaceId), eq(outlineBlocks.sid, sid)))
			.limit(1)
			.get();
		return row ? toBlock(row) : null;
	},

	async listChildren(spaceId, parentId, limit) {
		const rows = db
			.select()
			.from(outlineBlocks)
			.where(
				and(
					eq(outlineBlocks.spaceId, spaceId),
					parentId === null ? isNull(outlineBlocks.parentId) : eq(outlineBlocks.parentId, parentId),
					eq(outlineBlocks.deleted, false),
				),
			)
			// SQLite compares text bytewise (BINARY), which is the order-key order.
			.orderBy(asc(outlineBlocks.orderKey), asc(outlineBlocks.id))
			.limit(limit)
			.all();
		return rows.map(toBlock);
	},

	async listPageBlocks(pageId, limit) {
		const rows = db
			.select()
			.from(outlineBlocks)
			.where(and(eq(outlineBlocks.pageId, pageId), eq(outlineBlocks.deleted, false)))
			.limit(limit + 1)
			.all();
		return { blocks: rows.slice(0, limit).map(toBlock), truncated: rows.length > limit };
	},

	async listBlockVersions(blockId, limit) {
		const rows = db
			.select()
			.from(outlineBlockVersions)
			.where(eq(outlineBlockVersions.blockId, blockId))
			.orderBy(asc(outlineBlockVersions.fromSeq))
			.limit(limit)
			.all();
		return rows.map(toVersion);
	},

	async listPageVersions(pageId, options) {
		const rows = db
			.select()
			.from(outlineBlockVersions)
			.where(
				and(
					eq(outlineBlockVersions.pageId, pageId),
					options.afterSeq === undefined
						? undefined
						: gt(outlineBlockVersions.fromSeq, options.afterSeq),
				),
			)
			.orderBy(asc(outlineBlockVersions.fromSeq), asc(outlineBlockVersions.blockId))
			.limit(options.limit)
			.all();
		return rows.map(toVersion);
	},

	async listCommits(spaceId, options) {
		const rows = db
			.select()
			.from(outlineCommits)
			.where(
				and(
					eq(outlineCommits.spaceId, spaceId),
					options.afterSeq === undefined ? undefined : gt(outlineCommits.seq, options.afterSeq),
				),
			)
			.orderBy(asc(outlineCommits.seq))
			.limit(options.limit)
			.all();
		return rows.map(toCommit);
	},

	async appendLiveUpdates(rows) {
		if (rows.length === 0) return;
		await withDbRetry(
			async () =>
				db.transaction((tx) => {
					for (const chunk of chunked(rows, LIVE_INSERT_CHUNK)) {
						tx.insert(outlineLiveUpdates).values(chunk).run();
					}
				}),
			{ label: "outline.appendLiveUpdates", maxRetries: 3 },
		);
	},

	async replaceLiveUpdates(pageBlockId, epoch, rows) {
		await withDbRetry(
			async () =>
				db.transaction((tx) => {
					tx.delete(outlineLiveUpdates)
						.where(
							and(
								eq(outlineLiveUpdates.pageBlockId, pageBlockId),
								eq(outlineLiveUpdates.epoch, epoch),
							),
						)
						.run();
					for (const chunk of chunked(rows, LIVE_INSERT_CHUNK)) {
						tx.insert(outlineLiveUpdates).values(chunk).run();
					}
				}),
			{ label: "outline.replaceLiveUpdates", maxRetries: 3 },
		);
	},

	async listLiveUpdates(pageBlockId, epoch, options) {
		const rows = db
			.select()
			.from(outlineLiveUpdates)
			.where(
				and(
					eq(outlineLiveUpdates.pageBlockId, pageBlockId),
					eq(outlineLiveUpdates.epoch, epoch),
					options.afterSeq === undefined ? undefined : gt(outlineLiveUpdates.seq, options.afterSeq),
				),
			)
			.orderBy(asc(outlineLiveUpdates.seq))
			.limit(options.limit)
			.all();
		return rows.map(toLiveUpdate);
	},

	async deleteLiveUpdates(pageBlockId, epoch) {
		return db
			.delete(outlineLiveUpdates)
			.where(
				and(eq(outlineLiveUpdates.pageBlockId, pageBlockId), eq(outlineLiveUpdates.epoch, epoch)),
			)
			.returning({ seq: outlineLiveUpdates.seq })
			.all().length;
	},

	async listLiveEpochs(options) {
		const after = options.after;
		// GROUP BY the primary key's prefix walks the key in order without a sort.
		const rows = db
			.select({ pageBlockId: outlineLiveUpdates.pageBlockId, epoch: outlineLiveUpdates.epoch })
			.from(outlineLiveUpdates)
			.where(
				after
					? sql`(${outlineLiveUpdates.pageBlockId}, ${outlineLiveUpdates.epoch}) > (${after.pageBlockId}, ${after.epoch})`
					: undefined,
			)
			.groupBy(outlineLiveUpdates.pageBlockId, outlineLiveUpdates.epoch)
			.orderBy(asc(outlineLiveUpdates.pageBlockId), asc(outlineLiveUpdates.epoch))
			.limit(options.limit)
			.all();
		return rows;
	},

	async getViewState(userId, pageBlockId) {
		const row = db
			.select()
			.from(outlineViewState)
			.where(
				and(eq(outlineViewState.userId, userId), eq(outlineViewState.pageBlockId, pageBlockId)),
			)
			.limit(1)
			.get();
		return row ? toViewState(row) : null;
	},

	async putViewState(row, keepPerUser) {
		await withDbRetry(
			async () =>
				db.transaction((tx) => {
					tx.insert(outlineViewState)
						.values({
							userId: row.userId,
							pageBlockId: row.pageBlockId,
							collapsedJson: row.collapsed,
							expandedJson: row.expanded,
							layout: row.layout,
							updatedAt: row.updatedAt,
						})
						.onConflictDoUpdate({
							target: [outlineViewState.userId, outlineViewState.pageBlockId],
							set: {
								collapsedJson: row.collapsed,
								expandedJson: row.expanded,
								layout: row.layout,
								updatedAt: row.updatedAt,
							},
						})
						.run();
					// The person's oldest pages beyond the cap: their rows are found by the primary
					// key's prefix, at most `keepPerUser + 2` of them.
					tx.delete(outlineViewState)
						.where(
							and(
								eq(outlineViewState.userId, row.userId),
								// Never the page just written (a clock stepping back could make it the oldest).
								ne(outlineViewState.pageBlockId, row.pageBlockId),
								notInArray(
									outlineViewState.pageBlockId,
									tx
										.select({ id: outlineViewState.pageBlockId })
										.from(outlineViewState)
										.where(eq(outlineViewState.userId, row.userId))
										.orderBy(desc(outlineViewState.updatedAt), desc(outlineViewState.pageBlockId))
										.limit(keepPerUser),
								),
							),
						)
						.run();
				}),
			{ label: "outline.putViewState", maxRetries: 3 },
		);
	},

	async getTaskSeen(userId, taskBlockIds) {
		const out: OutlineTaskSeenRow[] = [];
		for (const chunk of chunked([...new Set(taskBlockIds)])) {
			out.push(
				...db
					.select({ taskBlockId: outlineTaskSeen.taskBlockId, seenSeq: outlineTaskSeen.seenSeq })
					.from(outlineTaskSeen)
					.where(
						and(eq(outlineTaskSeen.userId, userId), inArray(outlineTaskSeen.taskBlockId, chunk)),
					)
					.all(),
			);
		}
		return out;
	},

	async putTaskSeen(userId, rows, at, pruneBefore) {
		await withDbRetry(
			async () =>
				db.transaction((tx) => {
					for (const chunk of chunked(rows)) {
						tx.insert(outlineTaskSeen)
							.values(chunk.map((row) => ({ userId, ...row, seenAt: at })))
							.onConflictDoUpdate({
								target: [outlineTaskSeen.userId, outlineTaskSeen.taskBlockId],
								set: {
									seenSeq: sql`max(excluded.seen_seq, ${outlineTaskSeen.seenSeq})`,
									seenAt: at,
								},
							})
							.run();
					}
					tx.delete(outlineTaskSeen)
						.where(and(eq(outlineTaskSeen.userId, userId), lt(outlineTaskSeen.seenAt, pruneBefore)))
						.run();
				}),
			{ label: "outline.putTaskSeen", maxRetries: 3 },
		);
	},

	async applyCommit(plan) {
		let outcome: "applied" | "stale" | "claims" | "pending";
		try {
			outcome = await withDbRetry(
				async () => db.transaction((tx) => applyCommitSection(tx, plan)),
				{ label: "outline.applyCommit", maxRetries: 3 },
			);
		} catch (error) {
			rethrowAsPortError(error);
		}
		if (outcome === "stale") throw new OutlineStaleWriteError(plan.spaceId, plan.seq);
		if (outcome === "claims") throw new OutlineClaimsMovedError(plan.spaceId, plan.seq);
		if (outcome === "pending") throw new OutlinePendingMovedError(plan.spaceId, plan.seq);
	},

	async getPending(ids) {
		const out: OutlinePendingRow[] = [];
		for (const chunk of chunked(ids)) {
			for (const row of db
				.select()
				.from(outlinePending)
				.where(inArray(outlinePending.id, chunk))
				.all())
				out.push(toPending(row));
		}
		return out;
	},

	async listOpenPendingByPage(pageId, limit) {
		// `"status" = 'open'` is the partial index's own predicate, word for word.
		return db
			.select(pendingHeadColumns)
			.from(outlinePending)
			.where(and(eq(outlinePending.pageId, pageId), sql`"status" = 'open'`))
			.orderBy(asc(outlinePending.createdAt), asc(outlinePending.id))
			.limit(limit)
			.all()
			.map(toPendingHead);
	},

	async countOpenPendingByPage(pageId, limit) {
		// A raw `get` returns the row's values in order.
		const row = db.get<[number]>(sql`
			SELECT count(*) AS n FROM (
				SELECT 1 FROM outline_pending WHERE page_id = ${pageId} AND "status" = 'open' LIMIT ${limit}
			)
		`);
		return Number(row?.[0] ?? 0);
	},

	async listOpenPendingBySpace(spaceId, limit) {
		return db
			.select(pendingHeadColumns)
			.from(outlinePending)
			.where(and(eq(outlinePending.spaceId, spaceId), sql`"status" = 'open'`))
			.orderBy(asc(outlinePending.createdAt), asc(outlinePending.id))
			.limit(limit)
			.all()
			.map(toPendingHead);
	},

	async listOpenPendingForDecider(userId, limit) {
		return db
			.select(pendingHeadColumns)
			.from(outlinePending)
			.where(and(eq(outlinePending.deciderUserId, userId), sql`"status" = 'open'`))
			.orderBy(asc(outlinePending.createdAt), asc(outlinePending.id))
			.limit(limit)
			.all()
			.map(toPendingHead);
	},

	async listOpenPendingByRoots(rootIds, limit) {
		const out: OutlinePendingHead[] = [];
		for (const chunk of chunked(rootIds)) {
			if (out.length >= limit) break;
			out.push(
				...db
					.select(pendingHeadColumns)
					.from(outlinePending)
					.where(and(inArray(outlinePending.rootBlockId, chunk), sql`"status" = 'open'`))
					.limit(limit - out.length)
					.all()
					.map(toPendingHead),
			);
		}
		return out;
	},

	async findOpenPending(requesterSession, rootBlockId) {
		const row = db
			.select()
			.from(outlinePending)
			.where(
				and(
					eq(outlinePending.requesterSession, requesterSession),
					eq(outlinePending.rootBlockId, rootBlockId),
					sql`"status" = 'open'`,
				),
			)
			.limit(1)
			.get();
		return row ? toPending(row) : null;
	},

	async listUnreportedPending(requesterSession, pageId, limit) {
		// The predicate is the unreported index's own, word for word.
		return db
			.select(pendingHeadColumns)
			.from(outlinePending)
			.where(
				and(
					eq(outlinePending.requesterSession, requesterSession),
					eq(outlinePending.pageId, pageId),
					sql`"reported_at" IS NULL AND "status" <> 'open'`,
				),
			)
			.orderBy(asc(outlinePending.createdAt), asc(outlinePending.id))
			.limit(limit)
			.all()
			.map(toPendingHead);
	},

	async markPendingReported(ids, at) {
		if (ids.length === 0) return;
		await withDbRetry(
			async () => {
				for (const chunk of chunked(ids)) {
					db.update(outlinePending)
						.set({ reportedAt: at })
						.where(
							and(
								inArray(outlinePending.id, chunk),
								ne(outlinePending.status, "open"),
								isNull(outlinePending.reportedAt),
							),
						)
						.run();
				}
			},
			{ label: "outline.markPendingReported", maxRetries: 3 },
		);
	},

	async applyPending(plan) {
		let outcome: "applied" | "stale" | "pending";
		try {
			outcome = await withDbRetry(
				async () => db.transaction((tx) => applyPendingSection(tx, plan)),
				{ label: "outline.applyPending", maxRetries: 3 },
			);
		} catch (error) {
			rethrowAsPortError(error);
		}
		if (outcome === "stale") throw new OutlineStaleWriteError(plan.spaceId, plan.seq);
		if (outcome === "pending") throw new OutlinePendingMovedError(plan.spaceId, plan.seq);
	},

	async decidePending(decision) {
		return await withDbRetry(
			async () =>
				db
					.update(outlinePending)
					.set(decisionSet(decision))
					.where(
						and(
							eq(outlinePending.id, decision.id),
							sql`"status" = 'open'`,
							eq(outlinePending.rev, decision.expectRev),
						),
					)
					.returning({ id: outlinePending.id })
					.all().length > 0,
			{ label: "outline.decidePending", maxRetries: 3 },
		);
	},

	async getFirstVersions(blockIds) {
		const out: Array<{ blockId: string; fromSeq: number; commitId: string }> = [];
		for (const chunk of chunked(blockIds)) {
			// One primary-key probe per block: its lowest `from_seq`.
			const rows = db
				.select({
					blockId: outlineBlocks.id,
					fromSeq: sql<number | null>`(SELECT v.from_seq FROM outline_block_versions v
						WHERE v.block_id = outline_blocks.id ORDER BY v.from_seq ASC LIMIT 1)`,
					commitId: sql<string | null>`(SELECT v.commit_id FROM outline_block_versions v
						WHERE v.block_id = outline_blocks.id ORDER BY v.from_seq ASC LIMIT 1)`,
				})
				.from(outlineBlocks)
				.where(inArray(outlineBlocks.id, chunk))
				.all();
			for (const row of rows) {
				if (row.fromSeq !== null && row.commitId !== null)
					out.push({ blockId: row.blockId, fromSeq: row.fromSeq, commitId: row.commitId });
			}
		}
		return out;
	},

	async listUnseenDelegateConfirmations(userId, limit) {
		// The predicate is the digest index's own, word for word.
		return db
			.select(pendingHeadColumns)
			.from(outlinePending)
			.where(
				and(
					eq(outlinePending.deciderUserId, userId),
					sql`"status" = 'confirmed' AND "digest_seen_at" IS NULL AND json_extract("decided_by_json", '$.kind') = 'agent'`,
				),
			)
			.orderBy(asc(outlinePending.decidedAt), asc(outlinePending.id))
			.limit(limit)
			.all()
			.map(toPendingHead);
	},

	async markDelegateConfirmationsSeen(userId, ids, at) {
		if (ids.length === 0) return 0;
		return await withDbRetry(
			async () => {
				let marked = 0;
				for (const chunk of chunked(ids)) {
					marked += db
						.update(outlinePending)
						.set({ digestSeenAt: at })
						.where(
							and(
								inArray(outlinePending.id, chunk),
								eq(outlinePending.deciderUserId, userId),
								eq(outlinePending.status, "confirmed"),
								isNull(outlinePending.digestSeenAt),
							),
						)
						.returning({ id: outlinePending.id })
						.all().length;
				}
				return marked;
			},
			{ label: "outline.markDelegateConfirmationsSeen", maxRetries: 3 },
		);
	},

	async getQuestions(blockIds) {
		const out: OutlineQuestionRow[] = [];
		for (const ids of chunked(blockIds)) {
			out.push(
				...db
					.select()
					.from(outlineQuestions)
					.where(inArray(outlineQuestions.blockId, ids))
					.all()
					.map(toQuestion),
			);
		}
		return out;
	},

	async getContentHeads(blockIds, chars) {
		const out = new Map<string, string>();
		for (const ids of chunked(blockIds)) {
			const rows = db
				.select({
					id: outlineBlocks.id,
					head: sql<string>`substr(${outlineBlocks.content}, 1, ${Math.max(0, Math.floor(chars))})`,
				})
				.from(outlineBlocks)
				.where(inArray(outlineBlocks.id, ids))
				.all();
			for (const row of rows) out.set(row.id, row.head);
		}
		return out;
	},

	async listOpenQuestionsBySpaces(spaceIds, limitPerSpace) {
		const out: OutlineQuestionRow[] = [];
		for (const chunk of chunked([...new Set(spaceIds)])) {
			// Ranked within each space over the open-questions index, whole rows (no join back);
			// the oldest `limitPerSpace`. The ranking sorts all the open questions of the spaces:
			// few (a session has at most 50 open), and no index orders them (a known limit).
			const ranked = db
				.select({
					...getTableColumns(outlineQuestions),
					rank: sql<number>`row_number() over (partition by ${outlineQuestions.spaceId} order by ${outlineQuestions.createdAt}, ${outlineQuestions.blockId})`.as(
						"rank",
					),
				})
				.from(outlineQuestions)
				.where(and(inArray(outlineQuestions.spaceId, chunk), sql`"state" = 'open'`))
				.as("ranked");
			const rows = db
				.select()
				.from(ranked)
				.where(lte(ranked.rank, limitPerSpace))
				.orderBy(asc(ranked.spaceId), asc(ranked.createdAt), asc(ranked.blockId))
				.all();
			out.push(...rows.map(({ rank: _rank, ...row }) => toQuestion(row)));
		}
		return out;
	},

	async listOpenQuestionBlocksOnPage(spaceId, pageId, limit) {
		return db
			.select({ id: outlineQuestions.blockId })
			.from(outlineQuestions)
			.innerJoin(outlineBlocks, eq(outlineBlocks.id, outlineQuestions.blockId))
			.where(
				and(
					eq(outlineQuestions.spaceId, spaceId),
					sql`${outlineQuestions.state} = 'open'`,
					eq(outlineBlocks.pageId, pageId),
					eq(outlineBlocks.deleted, false),
				),
			)
			.orderBy(desc(outlineQuestions.createdAt), asc(outlineQuestions.blockId))
			.limit(limit)
			.all()
			.map((row) => row.id);
	},

	async listOpenQuestionsForUser(userId, limit) {
		return db
			.select()
			.from(outlineQuestions)
			.where(and(eq(outlineQuestions.toUserId, userId), sql`"state" = 'open'`))
			.orderBy(asc(outlineQuestions.createdAt), asc(outlineQuestions.blockId))
			.limit(limit)
			.all()
			.map(toQuestion);
	},

	async listOpenQuestionsByAsker(narratorId, limit) {
		return db
			.select()
			.from(outlineQuestions)
			.where(and(eq(outlineQuestions.askerNarratorId, narratorId), sql`"state" = 'open'`))
			.orderBy(asc(outlineQuestions.createdAt), asc(outlineQuestions.blockId))
			.limit(limit)
			.all()
			.map(toQuestion);
	},

	async listUndeliveredAnswers(limit) {
		return db
			.select()
			.from(outlineQuestions)
			.where(sql`"state" = 'answered' AND "delivered_at" IS NULL`)
			.orderBy(asc(outlineQuestions.answeredAt), asc(outlineQuestions.blockId))
			.limit(limit)
			.all()
			.map(toQuestion);
	},

	async markQuestionsDelivered(blockIds, at) {
		if (blockIds.length === 0) return 0;
		return await withDbRetry(
			async () => {
				let marked = 0;
				for (const chunk of chunked(blockIds)) {
					marked += db
						.update(outlineQuestions)
						.set({ deliveredAt: at })
						.where(
							and(
								inArray(outlineQuestions.blockId, chunk),
								eq(outlineQuestions.state, "answered"),
								isNull(outlineQuestions.deliveredAt),
							),
						)
						.returning({ blockId: outlineQuestions.blockId })
						.all().length;
				}
				return marked;
			},
			{ label: "outline.markQuestionsDelivered", maxRetries: 3 },
		);
	},

	async listLockedBlocks(pageId, limit) {
		// The predicate is the lock index's own, word for word, so the index serves it.
		return db
			.select(metaColumns)
			.from(outlineBlocks)
			.where(
				and(
					eq(outlineBlocks.pageId, pageId),
					sql`json_extract("task_json", '$.lock') IS NOT NULL AND "deleted" = 0`,
				),
			)
			.limit(limit)
			.all()
			.map(toMeta);
	},

	async getTaskClaims(blockIds) {
		const out: OutlineTaskClaimRow[] = [];
		for (const ids of chunked(blockIds)) {
			out.push(
				...db
					.select()
					.from(outlineTaskClaims)
					.where(inArray(outlineTaskClaims.taskBlockId, ids))
					.all(),
			);
		}
		return out;
	},

	async listClaimedTasks(narratorId, limit) {
		const rows = db
			.select({ claim: outlineTaskClaims, block: metaColumns })
			.from(outlineTaskClaims)
			.innerJoin(outlineBlocks, eq(outlineBlocks.id, outlineTaskClaims.taskBlockId))
			// The literal `IS NOT NULL` lets the planner use the partial holder index.
			.where(
				and(
					eq(outlineTaskClaims.holderNarratorId, narratorId),
					isNotNull(outlineTaskClaims.holderNarratorId),
				),
			)
			.orderBy(asc(outlineTaskClaims.claimedAt), asc(outlineTaskClaims.taskBlockId))
			.limit(limit)
			.all();
		return rows.map((r) => ({ claim: r.claim, block: toMeta(r.block) }));
	},

	async listOpenTasks(spaceId, limit, options) {
		// The predicate is the open-task index's own, word for word, so the index serves it; the
		// excluded pages are filtered while it is walked, before the limit.
		const exclude = options?.excludePageIds ?? [];
		const rows = db
			.select(metaColumns)
			.from(outlineBlocks)
			.where(
				and(
					eq(outlineBlocks.spaceId, spaceId),
					sql`json_extract("task_json", '$.status') IN ('todo', 'doing') AND "deleted" = 0`,
					exclude.length > 0 ? notInArray(outlineBlocks.pageId, [...exclude]) : undefined,
				),
			)
			.limit(limit)
			.all();
		return rows.map(toMeta);
	},

	async listFinishedTasks(spaceId, { before, limit }) {
		// The predicate is the finished-task index's own, word for word, and the cursor a row-value
		// comparison, so the index seeks straight to the page, in its order.
		const b = outlineBlocks;
		return db
			.select(metaColumns)
			.from(b)
			.where(
				and(
					eq(b.spaceId, spaceId),
					sql`json_extract("task_json", '$.status') IN ('done', 'cancelled') AND "deleted" = 0`,
					before ? sql`("version_seq", "id") < (${before.versionSeq}, ${before.id})` : undefined,
				),
			)
			.orderBy(desc(b.versionSeq), desc(b.id))
			.limit(limit)
			.all()
			.map(toMeta);
	},

	async listOpenTasksOfSpaces(parts, limit) {
		// One compound statement per chunk: two members per space, each an index's own predicate
		// on one space with its own limit (a bounded seek): the active-task index (in progress, or
		// locked to-dos) and the open-task index. Ids first, then the rows by key.
		const ids = new Set<string>();
		for (const chunk of chunked(parts, OUTLINE_BATCH_SPACES)) {
			const members = chunk.flatMap((part) => {
				const exclude = part.excludePageIds ?? [];
				const pages =
					exclude.length > 0
						? sql` and "page_id" not in (${sql.join(
								exclude.map((id) => sql`${id}`),
								sql`, `,
							)})`
						: sql``;
				return [
					sql`select * from (select "id" from "outline_blocks" where "space_id" = ${part.spaceId} and "deleted" = 0 AND (json_extract("task_json", '$.status') = 'doing' OR (json_extract("task_json", '$.status') = 'todo' AND json_extract("task_json", '$.lock') IS NOT NULL))${pages} limit ${limit})`,
					sql`select * from (select "id" from "outline_blocks" where "space_id" = ${part.spaceId} and json_extract("task_json", '$.status') IN ('todo', 'doing') AND "deleted" = 0${pages} limit ${limit})`,
				];
			});
			for (const row of db.all<{ id: string }>(sql.join(members, sql` union all `)))
				ids.add(row.id);
		}
		return await sqliteOutlineStore.getBlockMetasByIds([...ids]);
	},

	async listFinishedTasksOfSpaces(spaceIds, limit) {
		const ids: string[] = [];
		for (const chunk of chunked(spaceIds, OUTLINE_BATCH_SPACES)) {
			const members = chunk.map(
				(spaceId) =>
					sql`select * from (select "id" from "outline_blocks" where "space_id" = ${spaceId} and json_extract("task_json", '$.status') IN ('done', 'cancelled') AND "deleted" = 0 order by "version_seq" desc, "id" desc limit ${limit})`,
			);
			for (const row of db.all<{ id: string }>(sql.join(members, sql` union all `)))
				ids.push(row.id);
		}
		return inIdOrder(ids, await sqliteOutlineStore.getBlockMetasByIds(ids));
	},

	async getBlockMetasByIds(ids) {
		const out: OutlineBlockMeta[] = [];
		for (const chunk of chunked(ids)) {
			out.push(
				...db
					.select(metaColumns)
					.from(outlineBlocks)
					.where(inArray(outlineBlocks.id, chunk))
					.all()
					.map(toMeta),
			);
		}
		return out;
	},

	async findAliasOwnersInSpaces(spaceIds, alias) {
		const out: Array<{ spaceId: string; id: string }> = [];
		for (const chunk of chunked(spaceIds)) {
			out.push(
				...db
					.select({ spaceId: outlineBlocks.spaceId, id: outlineBlocks.id })
					.from(outlineBlocks)
					.where(
						and(
							inArray(outlineBlocks.spaceId, chunk),
							eq(outlineBlocks.alias, alias),
							// The literal lets the planner use the partial unique alias index.
							sql`${outlineBlocks.deleted} = 0`,
						),
					)
					.all(),
			);
		}
		return out;
	},

	async listExpiredTaskClaims(now, limit) {
		const rows = db
			.select({ claim: outlineTaskClaims, spaceId: outlineBlocks.spaceId })
			.from(outlineTaskClaims)
			.innerJoin(outlineBlocks, eq(outlineBlocks.id, outlineTaskClaims.taskBlockId))
			.where(
				and(
					isNotNull(outlineTaskClaims.expiresAt),
					lte(outlineTaskClaims.expiresAt, now),
					isNotNull(outlineTaskClaims.holderNarratorId),
				),
			)
			.orderBy(asc(outlineTaskClaims.expiresAt), asc(outlineTaskClaims.taskBlockId))
			.limit(limit)
			.all();
		return rows;
	},

	async listSessionTaskClaims(narratorId, limit, options) {
		const held = (holder: SQL) =>
			db
				.select({ claim: outlineTaskClaims, spaceId: outlineBlocks.spaceId })
				.from(outlineTaskClaims)
				.innerJoin(outlineBlocks, eq(outlineBlocks.id, outlineTaskClaims.taskBlockId))
				// The literal `IS NOT NULL` lets the planner use the partial holder index.
				.where(and(holder, isNotNull(outlineTaskClaims.holderNarratorId)))
				.orderBy(asc(outlineTaskClaims.claimedAt), asc(outlineTaskClaims.taskBlockId))
				.limit(limit)
				.all();
		const own = options?.subagentsOnly
			? []
			: held(eq(outlineTaskClaims.holderNarratorId, narratorId));
		const subagents = held(
			inArray(
				outlineTaskClaims.holderNarratorId,
				db
					.select({ id: narrators.id })
					.from(narrators)
					.where(and(eq(narrators.aclRootNarratorId, narratorId), eq(narrators.type, "subagent"))),
			),
		);
		return oldestClaimsFirst([...own, ...subagents], limit);
	},

	async renewTaskClaims(narratorId, expiresAt) {
		return await withDbRetry(
			async () =>
				db
					.update(outlineTaskClaims)
					.set({ expiresAt })
					.where(
						inArray(
							outlineTaskClaims.taskBlockId,
							db
								.select({ id: outlineTaskClaims.taskBlockId })
								.from(outlineTaskClaims)
								.where(
									and(
										eq(outlineTaskClaims.holderNarratorId, narratorId),
										isNotNull(outlineTaskClaims.holderNarratorId),
									),
								)
								.limit(OUTLINE_RENEW_LIMIT),
						),
					)
					.returning({ id: outlineTaskClaims.taskBlockId })
					.all().length,
			{ label: "outline.renewTaskClaims", maxRetries: 3 },
		);
	},

	async updateTaskClaims(writes) {
		if (writes.length === 0) return true;
		return await withDbRetry(async () => db.transaction((tx) => updateClaimsSection(tx, writes)), {
			label: "outline.updateTaskClaims",
			maxRetries: 3,
		});
	},

	async handOverTaskClaims(fromNarratorId, toNarratorId, expiresAt) {
		return await withDbRetry(
			async () =>
				db
					.update(outlineTaskClaims)
					.set({ holderNarratorId: toNarratorId, expiresAt })
					.where(
						inArray(
							outlineTaskClaims.taskBlockId,
							db
								.select({ id: outlineTaskClaims.taskBlockId })
								.from(outlineTaskClaims)
								.where(
									and(
										eq(outlineTaskClaims.holderNarratorId, fromNarratorId),
										isNotNull(outlineTaskClaims.holderNarratorId),
									),
								)
								.limit(OUTLINE_RENEW_LIMIT),
						),
					)
					.returning({ id: outlineTaskClaims.taskBlockId })
					.all().length,
			{ label: "outline.handOverTaskClaims", maxRetries: 3 },
		);
	},

	async listUnclaimedDoingTasks({ after, scan }) {
		// The literal predicate is the in-progress index's own.
		const doing = db
			.select({ id: outlineBlocks.id, spaceId: outlineBlocks.spaceId })
			.from(outlineBlocks)
			.where(
				and(
					sql`json_extract("task_json", '$.status') = 'doing' AND "deleted" = 0`,
					after ? gt(outlineBlocks.id, after) : undefined,
				),
			)
			.orderBy(asc(outlineBlocks.id))
			.limit(scan)
			.all();
		const claims = new Map<string, OutlineTaskClaimRow>();
		for (const ids of chunked(doing.map((b) => b.id))) {
			for (const row of db
				.select()
				.from(outlineTaskClaims)
				.where(inArray(outlineTaskClaims.taskBlockId, ids))
				.all())
				claims.set(row.taskBlockId, row);
		}
		const tasks = doing.flatMap((b) => {
			const claim = claims.get(b.id) ?? null;
			if (claim && (claim.holderNarratorId !== null || claim.holderUserId !== null)) return [];
			return [{ blockId: b.id, spaceId: b.spaceId, claim }];
		});
		return { tasks, next: doing.length < scan ? null : (doing.at(-1)?.id ?? null) };
	},

	async getNarratorRoots(narratorIds) {
		const read = (ids: readonly string[]): NarratorStateRow[] => {
			const rows: NarratorStateRow[] = [];
			for (const chunk of chunked([...new Set(ids)])) {
				rows.push(
					...db
						.select({
							id: narrators.id,
							type: narrators.type,
							root: narrators.aclRootNarratorId,
							status: narrators.status,
						})
						.from(narrators)
						.where(inArray(narrators.id, chunk))
						.all(),
				);
			}
			return rows;
		};
		return await narratorSessions(read(narratorIds), read);
	},

	async listTaskClaimHolders({ after, limit }) {
		// The literal `IS NOT NULL` lets the planner use the partial holder index, in its order.
		const rows = db
			.selectDistinct({ holder: outlineTaskClaims.holderNarratorId })
			.from(outlineTaskClaims)
			.where(
				and(
					isNotNull(outlineTaskClaims.holderNarratorId),
					after ? gt(outlineTaskClaims.holderNarratorId, after) : undefined,
				),
			)
			.orderBy(asc(outlineTaskClaims.holderNarratorId))
			.limit(limit)
			.all();
		const holders = rows.map((r) => r.holder as string);
		return { holders, next: holders.length < limit ? null : (holders.at(-1) ?? null) };
	},

	async getInProcessState(spaceIds) {
		const out = new Map<string, { ready: boolean; epoch: number }>();
		for (const ids of chunked(spaceIds)) {
			for (const row of db
				.select({
					id: outlineSpaces.id,
					ready: outlineSpaces.inProcessReady,
					epoch: outlineSpaces.inProcessEpoch,
				})
				.from(outlineSpaces)
				.where(inArray(outlineSpaces.id, ids))
				.all())
				out.set(row.id, { ready: row.ready, epoch: row.epoch });
		}
		return out;
	},

	async hasChangesSince(spaceId, afterSeq, flags, maxCommits) {
		const beyond = db
			.select({ seq: outlineCommits.seq })
			.from(outlineCommits)
			.where(
				and(eq(outlineCommits.spaceId, spaceId), gt(outlineCommits.seq, afterSeq + maxCommits)),
			)
			.limit(1)
			.get();
		if (beyond) return true;
		const row = db.get<{ hit: number }>(sql`
			SELECT 1 AS hit FROM outline_commits c
			JOIN outline_block_versions v ON v.commit_id = c.id
			WHERE c.space_id = ${spaceId} AND c.seq > ${afterSeq} AND c.seq <= ${afterSeq + maxCommits}
				AND (v.change_flags & ${flags}) != 0
			LIMIT 1
		`);
		return row !== undefined && row !== null;
	},

	async listSpacesPendingInProcess({ after, limit }) {
		// The literal predicate is the pending index's own.
		const rows = db
			.select()
			.from(outlineSpaces)
			.where(and(sql`"in_process_ready" = 0`, after ? gt(outlineSpaces.id, after) : undefined))
			.orderBy(asc(outlineSpaces.id))
			.limit(limit)
			.all();
		return rows.map(toSpace);
	},

	async setInProcess(spaceId, expectNextSeq, values) {
		return await withDbRetry(
			async () =>
				db.transaction((tx) => {
					const space = tx
						.select({ nextSeq: outlineSpaces.nextSeq })
						.from(outlineSpaces)
						.where(eq(outlineSpaces.id, spaceId))
						.get();
					if (!space || space.nextSeq !== expectNextSeq) return false;
					let changed = 0;
					for (const [value, list] of [
						[true, values.inProcess],
						[false, values.notInProcess],
					] as const) {
						for (const ids of chunked(list)) {
							changed += tx
								.update(outlineBlocks)
								.set({ inProcess: value })
								.where(
									and(
										eq(outlineBlocks.spaceId, spaceId),
										inArray(outlineBlocks.id, ids),
										ne(outlineBlocks.inProcess, value),
									),
								)
								.returning({ id: outlineBlocks.id })
								.all().length;
						}
					}
					if (changed > 0 || values.ready) {
						tx.update(outlineSpaces)
							.set({
								inProcessEpoch: sql`${outlineSpaces.inProcessEpoch} + 1`,
								...(values.ready ? { inProcessReady: true } : {}),
							})
							.where(eq(outlineSpaces.id, spaceId))
							.run();
					}
					return true;
				}),
			{ label: "outline.setInProcess", maxRetries: 3 },
		);
	},
};
