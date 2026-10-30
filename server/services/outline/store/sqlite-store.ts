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
	gt,
	inArray,
	isNotNull,
	isNull,
	lte,
	ne,
	notInArray,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { db } from "../../../db";
import {
	narrators,
	outlineBlocks,
	outlineBlockVersions,
	outlineCommits,
	outlineLinks,
	outlineLiveUpdates,
	outlineSpaces,
	outlineTaskClaims,
	outlineViewState,
} from "../../../db/schema";
import { withDbRetry } from "../../../lib/db-resilience";
import { generateId } from "../../../lib/id";
import { newOutlineKey } from "../keys";
import type {
	OutlineActorKind,
	OutlineCommitKind,
	OutlineLinkKind,
	OutlineSpaceKind,
} from "../model";
import {
	chunked,
	claimsAsExpected,
	expectedClaimIds,
	OUTLINE_RENEW_LIMIT,
	type OutlineBlockMeta,
	type OutlineBlockRow,
	OutlineClaimsMovedError,
	type OutlineClaimWrite,
	type OutlineCommitPlan,
	type OutlineCommitRow,
	type OutlineLinkRow,
	type OutlineLiveUpdateRow,
	type OutlineSpaceRow,
	type OutlineSpaceScope,
	OutlineStaleWriteError,
	type OutlineStore,
	type OutlineTaskClaimRow,
	type OutlineVersionRow,
	type OutlineViewStateRow,
	writesAsExpected,
} from "./port";
import { sqliteOutlineReads } from "./sqlite-read";

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
	// `in_process_ready` is bookkeeping of the in-process rebuild, not part of a space's row.
	const { inProcessReady: _ready, ...space } = row;
	return { ...space, kind: row.kind as OutlineSpaceKind };
}

function toBlock(row: BlockSelect): OutlineBlockRow {
	return {
		...row,
		taskJson: row.taskJson ?? null,
		authorKind: row.authorKind as OutlineActorKind,
	};
}

function toVersion(row: VersionSelect): OutlineVersionRow {
	return { ...row, taskJson: row.taskJson ?? null };
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
	versionSeq: number;
	deleted: boolean;
	inProcess: boolean;
}): OutlineBlockMeta {
	return { ...row, taskJson: row.taskJson ?? null };
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
 * The whole commit. Returns false, having written nothing, when the space counter is no longer
 * at the plan's seq; returning (rather than throwing) keeps an expected outcome out of the retry
 * wrapper's error log.
 */
function applyCommitSection(tx: Tx, plan: OutlineCommitPlan): "applied" | "stale" | "claims" {
	const { seq } = plan;
	// The claims the plan read must still be as read (a lease renewed since may have made a
	// takeover wrong). Nothing writes inside this synchronous section but this section.
	const expected = expectedClaimIds(plan);
	if (expected.length > 0 && !claimsAsExpected(plan, readClaims(tx, expected))) return "claims";
	// The counter and the in-process epoch are claimed together; a commit that cannot keep its
	// in-process answers marks the space for the rebuild in the same statement.
	const claimed = tx
		.update(outlineSpaces)
		.set({
			nextSeq: sql`${outlineSpaces.nextSeq} + 1`,
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
					task_json, alias, content_hash, change_flags, deleted
				)
				SELECT id, ${seq}, NULL, ${plan.commit.id}, page_id, parent_id, order_key,
					CASE WHEN deleted = 1 THEN NULL ELSE content END,
					task_json, alias, content_hash, ${group.flags}, deleted
				FROM outline_blocks WHERE id IN (${idList(ids)})
			`);
		}
	}

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
							layout: row.layout,
							updatedAt: row.updatedAt,
						})
						.onConflictDoUpdate({
							target: [outlineViewState.userId, outlineViewState.pageBlockId],
							set: { collapsedJson: row.collapsed, layout: row.layout, updatedAt: row.updatedAt },
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

	async applyCommit(plan) {
		let outcome: "applied" | "stale" | "claims";
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

	async listOpenTasks(spaceId, limit) {
		// The predicate is the open-task index's own, word for word, so the index serves it.
		const rows = db
			.select(metaColumns)
			.from(outlineBlocks)
			.where(
				and(
					eq(outlineBlocks.spaceId, spaceId),
					sql`json_extract("task_json", '$.status') IN ('todo', 'doing') AND "deleted" = 0`,
				),
			)
			.limit(limit)
			.all();
		return rows.map(toMeta);
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
		const out = new Map<string, string>();
		for (const ids of chunked([...new Set(narratorIds)])) {
			for (const row of db
				.select({
					id: narrators.id,
					type: narrators.type,
					root: narrators.aclRootNarratorId,
				})
				.from(narrators)
				.where(inArray(narrators.id, ids))
				.all())
				out.set(row.id, row.type === "subagent" && row.root ? row.root : row.id);
		}
		return out;
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
