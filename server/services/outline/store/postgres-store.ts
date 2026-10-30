/**
 * PostgreSQL implementation of `OutlineStore`.
 *
 * Same port and the same section content as `sqlite-store.ts` (the same statements in the same
 * order), different engine:
 *
 *   - `applyCommit` runs one genuinely async transaction, the named section invoked through a
 *     non-async arrow (the shape the transaction-atomicity gate requires), with `withPgRetry`
 *     around the whole section as the retry unit.
 *   - The space counter claim (`UPDATE … SET next_seq = next_seq + 1 WHERE next_seq = $seq
 *     RETURNING`) is the serialization point: it takes the space row lock, so two commits to one
 *     space queue on it, and the second one finds the counter moved and rejects as stale instead
 *     of writing over a plan made from old reads.
 *   - Order keys are compared bytewise. The column has the database's default collation, so
 *     every ORDER BY on it pins `COLLATE "C"`; nothing else compares order keys in SQL.
 *   - SQLSTATE 23505 crosses the port as `WriteConflictError` with the constraint name.
 */
import { WriteConflictError } from "@server/db/backend/write-port";
import { isPgUniqueViolation } from "@server/db/pg-errors";
import { withPgRetry } from "@server/db/pg-retry";
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
} from "@server/db/postgres-schema";
import type { OutlineTaskJson } from "@server/db/schema";
import { generateId } from "@server/lib/id";
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
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
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
import { createPostgresOutlineReads } from "./postgres-read";

/** Transaction handle as produced by `db.transaction(async (tx) => …)`. */
type PgTransaction = Parameters<Parameters<BunSQLDatabase["transaction"]>[0]>[0];
type PgReader = BunSQLDatabase | PgTransaction;

const MAX_CAUSE_DEPTH = 8;
const INSERT_CHUNK = 100;
const SPACE_KEY_ATTEMPTS = 4;

function extractConstraintName(error: unknown): string | null {
	let current: unknown = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (!current || typeof current !== "object") return null;
		const constraint = (current as Record<string, unknown>).constraint;
		if (typeof constraint === "string" && constraint.length > 0) return constraint;
		current = (current as Record<string, unknown>).cause;
	}
	return null;
}

function rethrowAsPortError(error: unknown): never {
	if (error instanceof WriteConflictError) throw error;
	if (isPgUniqueViolation(error)) {
		throw new WriteConflictError("outline write conflicts with an existing row", {
			constraint: extractConstraintName(error),
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

/** JSON columns are text with a codec here; the schema only knows them as `unknown`. */
function taskOf(value: unknown): OutlineTaskJson | null {
	return (value as OutlineTaskJson | null | undefined) ?? null;
}

function toSpace(row: SpaceSelect): OutlineSpaceRow {
	// `in_process_ready` is bookkeeping of the in-process rebuild, not part of a space's row.
	const { inProcessReady: _ready, ...space } = row;
	return { ...space, kind: row.kind as OutlineSpaceKind };
}

function toBlock(row: BlockSelect): OutlineBlockRow {
	return {
		...row,
		taskJson: taskOf(row.taskJson),
		authorKind: row.authorKind as OutlineActorKind,
	};
}

function toVersion(row: VersionSelect): OutlineVersionRow {
	return { ...row, taskJson: taskOf(row.taskJson) };
}

type LiveUpdateSelect = typeof outlineLiveUpdates.$inferSelect;

function toLiveUpdate(row: LiveUpdateSelect): OutlineLiveUpdateRow {
	return { ...row, actorKind: row.actorKind as OutlineActorKind };
}

/** Rows per multi-row INSERT of the live log (7 columns each). */
const LIVE_INSERT_CHUNK = 50;

type ViewStateSelect = typeof outlineViewState.$inferSelect;

function toViewState(row: ViewStateSelect): OutlineViewStateRow {
	const collapsed = row.collapsedJson;
	return {
		userId: row.userId,
		pageBlockId: row.pageBlockId,
		collapsed: Array.isArray(collapsed)
			? collapsed.filter((id): id is string => typeof id === "string")
			: [],
		layout: row.layout === "down" ? "down" : "right",
		updatedAt: row.updatedAt,
	};
}

/** Write a person's view state of a page and drop their oldest pages beyond the cap. */
async function putViewStateSection(
	tx: PgTransaction,
	row: OutlineViewStateRow,
	keepPerUser: number,
): Promise<void> {
	await tx
		.insert(outlineViewState)
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
		});
	// The person's oldest pages beyond the cap (found by the primary key's prefix, at most
	// `keepPerUser + 2` rows).
	await tx.delete(outlineViewState).where(
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
					.orderBy(
						desc(outlineViewState.updatedAt),
						sql`${outlineViewState.pageBlockId} COLLATE "C" DESC`,
					)
					.limit(keepPerUser),
			),
		),
	);
}

/** Append live log rows; one transaction so a chunked append lands whole. */
async function appendLiveSection(
	tx: PgTransaction,
	rows: readonly OutlineLiveUpdateRow[],
): Promise<void> {
	for (const chunk of chunked(rows, LIVE_INSERT_CHUNK)) {
		await tx.insert(outlineLiveUpdates).values([...chunk]);
	}
}

/** Replace an epoch's rows (a compaction). */
async function replaceLiveSection(
	tx: PgTransaction,
	pageBlockId: string,
	epoch: number,
	rows: readonly OutlineLiveUpdateRow[],
): Promise<void> {
	await tx
		.delete(outlineLiveUpdates)
		.where(
			and(eq(outlineLiveUpdates.pageBlockId, pageBlockId), eq(outlineLiveUpdates.epoch, epoch)),
		);
	await appendLiveSection(tx, rows);
}

function toLink(row: LinkSelect): OutlineLinkRow {
	return {
		...row,
		kind: row.kind as OutlineLinkKind,
		targetKind: row.targetKind as OutlineLinkRow["targetKind"],
	};
}

function toCommit(row: CommitSelect): OutlineCommitRow {
	return {
		...row,
		kind: row.kind as OutlineCommitKind,
		actorKind: row.actorKind as OutlineActorKind,
	};
}

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

function toMeta(row: Omit<OutlineBlockMeta, "taskJson"> & { taskJson: unknown }): OutlineBlockMeta {
	return { ...row, taskJson: taskOf(row.taskJson) };
}

/** Bytewise order of order keys, whatever the database's default collation is. */
const orderKeyBytewise = sql`${outlineBlocks.orderKey} COLLATE "C"`;

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

async function findSpaceIn(reader: PgReader, scope: OutlineSpaceScope) {
	const rows = await reader.select().from(outlineSpaces).where(scopeCondition(scope)).limit(1);
	return rows[0] ? toSpace(rows[0]) : null;
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
 * The whole commit, in the SQLite section's order. Resolves false, having written nothing, when
 * the space counter is no longer at the plan's seq.
 */
async function applyCommitSection(
	tx: PgTransaction,
	plan: OutlineCommitPlan,
): Promise<"applied" | "stale" | "claims"> {
	const { seq } = plan;
	// The claims the plan read must still be as read (a lease renewed since may have made a
	// takeover wrong). Their rows are locked first, in id order, so a renewal waits for this
	// commit and every commit takes claim rows before the space row.
	const expected = expectedClaimIds(plan);
	if (expected.length > 0 && !claimsAsExpected(plan, await lockClaims(tx, expected))) {
		return "claims";
	}
	// The counter and the in-process epoch are claimed together; a commit that cannot keep its
	// in-process answers marks the space for the rebuild in the same statement.
	const claimed = await tx
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
		.returning({ nextSeq: outlineSpaces.nextSeq });
	if (claimed.length === 0) return "stale";

	await tx.insert(outlineCommits).values(plan.commit);

	let closed = 0;
	for (const ids of chunked(plan.closeVersionIds)) {
		const rows = await tx
			.update(outlineBlockVersions)
			.set({ toSeq: seq })
			.where(and(inArray(outlineBlockVersions.blockId, ids), isNull(outlineBlockVersions.toSeq)))
			.returning({ blockId: outlineBlockVersions.blockId });
		closed += rows.length;
	}
	if (closed !== plan.closeVersionIds.length) {
		throw new Error(
			`outline history out of step: closed ${closed} of ${plan.closeVersionIds.length} open versions`,
		);
	}

	const realiased = plan.patchBlocks.filter((group) => group.patch.alias !== undefined);
	for (const group of realiased) {
		for (const ids of chunked(group.ids)) {
			await tx.update(outlineBlocks).set({ alias: null }).where(inArray(outlineBlocks.id, ids));
		}
	}
	const patches = [...plan.patchBlocks].sort(
		(a, b) => Number(b.patch.deleted === true) - Number(a.patch.deleted === true),
	);
	for (const group of patches) {
		for (const ids of chunked(group.ids)) {
			await tx
				.update(outlineBlocks)
				.set({ ...group.patch, versionSeq: seq })
				.where(inArray(outlineBlocks.id, ids));
		}
	}

	for (const rows of chunked(plan.insertBlocks, INSERT_CHUNK)) {
		await tx.insert(outlineBlocks).values(rows);
	}

	for (const group of plan.versions) {
		for (const ids of chunked(group.ids)) {
			await tx.execute(sql`
				INSERT INTO outline_block_versions (
					block_id, from_seq, to_seq, commit_id, page_id, parent_id, order_key, content,
					task_json, alias, content_hash, change_flags, deleted
				)
				SELECT id, CAST(${seq} AS integer), NULL, CAST(${plan.commit.id} AS text), page_id,
					parent_id, order_key, CASE WHEN deleted THEN NULL ELSE content END,
					task_json, alias, content_hash, CAST(${group.flags} AS integer), deleted
				FROM outline_blocks WHERE id IN (${idList(ids)})
			`);
		}
	}

	for (const ids of chunked(plan.closeLinkIds)) {
		await tx
			.update(outlineLinks)
			.set({ toSeq: seq })
			.where(and(inArray(outlineLinks.id, ids), isNull(outlineLinks.toSeq)));
	}
	for (const rows of chunked(plan.insertLinks, INSERT_CHUNK)) {
		await tx.insert(outlineLinks).values(rows);
	}

	for (const group of plan.inProcess) {
		for (const ids of chunked(group.ids)) {
			await tx
				.update(outlineBlocks)
				.set({ inProcess: group.value })
				.where(inArray(outlineBlocks.id, ids));
		}
	}

	const released = [...plan.claims.release, ...plan.claims.expire.map((e) => e.expect.taskBlockId)];
	for (const ids of chunked(released)) {
		// The holder moves into `last_holder_*` (the right-hand sides read the row as it was).
		await tx
			.update(outlineTaskClaims)
			.set({
				lastHolderNarratorId: sql`"holder_narrator_id"`,
				lastHolderUserId: sql`"holder_user_id"`,
				holderNarratorId: null,
				holderUserId: null,
				expiresAt: null,
			})
			.where(
				and(
					inArray(outlineTaskClaims.taskBlockId, ids),
					or(
						isNotNull(outlineTaskClaims.holderNarratorId),
						isNotNull(outlineTaskClaims.holderUserId),
					),
				),
			);
	}
	for (const { row } of plan.claims.put) await putClaim(tx, row);
	return "applied";
}

async function putClaim(tx: PgTransaction, row: OutlineTaskClaimRow): Promise<void> {
	const { taskBlockId: _, ...columns } = row;
	await tx
		.insert(outlineTaskClaims)
		.values(row)
		.onConflictDoUpdate({ target: outlineTaskClaims.taskBlockId, set: columns });
}

/** Claim rows of the given tasks, locked in task id order (the order every writer locks them). */
async function lockClaims(
	tx: PgTransaction,
	taskIds: readonly string[],
): Promise<Map<string, OutlineTaskClaimRow>> {
	const found = new Map<string, OutlineTaskClaimRow>();
	for (const ids of chunked([...new Set(taskIds)].sort())) {
		const rows = await tx
			.select()
			.from(outlineTaskClaims)
			.where(inArray(outlineTaskClaims.taskBlockId, ids))
			.orderBy(sql`${outlineTaskClaims.taskBlockId} COLLATE "C"`)
			.for("update");
		for (const row of rows) found.set(row.taskBlockId, row);
	}
	return found;
}

/** Claim rows written outside a commit, only while each is still the row expected. */
async function updateClaimsSection(
	tx: PgTransaction,
	writes: readonly OutlineClaimWrite[],
): Promise<boolean> {
	const found = await lockClaims(
		tx,
		writes.map((w) => w.row.taskBlockId),
	);
	if (!writesAsExpected(writes, found)) return false;
	for (const { row } of writes) await putClaim(tx, row);
	return true;
}

/** Set `in_process` of a space's blocks while the space is still at `expectNextSeq`. */
async function setInProcessSection(
	tx: PgTransaction,
	spaceId: string,
	expectNextSeq: number,
	values: { inProcess: readonly string[]; notInProcess: readonly string[]; ready?: boolean },
): Promise<boolean> {
	// FOR SHARE waits for a commit holding the space row, then sees whether it moved the counter.
	const rows = await tx
		.select({ nextSeq: outlineSpaces.nextSeq })
		.from(outlineSpaces)
		.where(eq(outlineSpaces.id, spaceId))
		.for("share");
	if (rows[0]?.nextSeq !== expectNextSeq) return false;
	let changed = 0;
	for (const [value, list] of [
		[true, values.inProcess],
		[false, values.notInProcess],
	] as const) {
		for (const ids of chunked(list)) {
			const updated = await tx
				.update(outlineBlocks)
				.set({ inProcess: value })
				.where(
					and(
						eq(outlineBlocks.spaceId, spaceId),
						inArray(outlineBlocks.id, ids),
						ne(outlineBlocks.inProcess, value),
					),
				)
				.returning({ id: outlineBlocks.id });
			changed += updated.length;
		}
	}
	if (changed > 0 || values.ready) {
		await tx
			.update(outlineSpaces)
			.set({
				inProcessEpoch: sql`${outlineSpaces.inProcessEpoch} + 1`,
				...(values.ready ? { inProcessReady: true } : {}),
			})
			.where(eq(outlineSpaces.id, spaceId));
	}
	return true;
}

/**
 * Renew a session's claims (or, with `toNarratorId`, hand them to another session): their rows
 * are locked in task id order first, the order a commit locks the claim rows it checks, so the
 * two never wait on each other in a cycle.
 */
async function renewSection(
	tx: PgTransaction,
	narratorId: string,
	expiresAt: string,
	toNarratorId: string = narratorId,
): Promise<number> {
	const rows = await tx
		.select({ id: outlineTaskClaims.taskBlockId })
		.from(outlineTaskClaims)
		.where(
			and(
				eq(outlineTaskClaims.holderNarratorId, narratorId),
				isNotNull(outlineTaskClaims.holderNarratorId),
			),
		)
		.orderBy(sql`${outlineTaskClaims.taskBlockId} COLLATE "C"`)
		.limit(OUTLINE_RENEW_LIMIT)
		.for("update");
	if (rows.length === 0) return 0;
	const updated = await tx
		.update(outlineTaskClaims)
		.set({ holderNarratorId: toNarratorId, expiresAt })
		.where(
			and(
				inArray(
					outlineTaskClaims.taskBlockId,
					rows.map((r) => r.id),
				),
				eq(outlineTaskClaims.holderNarratorId, narratorId),
			),
		)
		.returning({ id: outlineTaskClaims.taskBlockId });
	return updated.length;
}

/** Get-or-create, as one section: the insert does nothing when another writer won the race. */
async function ensureSpaceSection(
	tx: PgTransaction,
	scope: OutlineSpaceScope,
	now: string,
): Promise<OutlineSpaceRow | null> {
	const existing = await findSpaceIn(tx, scope);
	if (existing) return existing;
	await tx
		.insert(outlineSpaces)
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
		.onConflictDoNothing();
	return findSpaceIn(tx, scope);
}

// ─────────────────────────────────────────────────────────────────────────────
// The store
// ─────────────────────────────────────────────────────────────────────────────

export function createPostgresOutlineStore(db: BunSQLDatabase): OutlineStore {
	return {
		backendId: "postgres",
		...createPostgresOutlineReads(db),

		async ensureSpace(scope, now) {
			for (let attempt = 0; attempt < SPACE_KEY_ATTEMPTS; attempt++) {
				let row: OutlineSpaceRow | null;
				try {
					row = await withPgRetry(
						() => db.transaction((tx) => ensureSpaceSection(tx, scope, now)),
						{ label: "outline.ensureSpace" },
					);
				} catch (error) {
					rethrowAsPortError(error);
				}
				// A concurrent creator committed between our read and insert: read it now.
				if (!row) row = await findSpaceIn(db, scope);
				if (row) return row;
			}
			throw new Error(`could not allocate an outline space key for ${scope.kind}`);
		},

		async getSpace(id) {
			const rows = await db.select().from(outlineSpaces).where(eq(outlineSpaces.id, id)).limit(1);
			return rows[0] ? toSpace(rows[0]) : null;
		},

		async getSpaceByKey(key) {
			const rows = await db.select().from(outlineSpaces).where(eq(outlineSpaces.key, key)).limit(1);
			return rows[0] ? toSpace(rows[0]) : null;
		},

		async findSpace(scope) {
			return findSpaceIn(db, scope);
		},

		async getBlockMetas(spaceId, by) {
			const out: OutlineBlockMeta[] = [];
			for (const ids of chunked(by.ids ?? [])) {
				const rows = await db
					.select(metaColumns)
					.from(outlineBlocks)
					.where(and(eq(outlineBlocks.spaceId, spaceId), inArray(outlineBlocks.id, ids)));
				for (const row of rows) out.push(toMeta(row));
			}
			for (const sids of chunked(by.sids ?? [])) {
				const rows = await db
					.select(metaColumns)
					.from(outlineBlocks)
					.where(and(eq(outlineBlocks.spaceId, spaceId), inArray(outlineBlocks.sid, sids)));
				for (const row of rows) out.push(toMeta(row));
			}
			return out;
		},

		async findExistingBlockIds(ids) {
			const out: string[] = [];
			for (const chunk of chunked(ids)) {
				const rows = await db
					.select({ id: outlineBlocks.id })
					.from(outlineBlocks)
					.where(inArray(outlineBlocks.id, chunk));
				for (const row of rows) out.push(row.id);
			}
			return out;
		},

		async listChildMetas(spaceId, parentIds, limit) {
			const out: OutlineBlockMeta[] = [];
			const ids = parentIds.filter((id): id is string => id !== null);
			const groups: Array<SQL | undefined> = chunked(ids).map((chunk) =>
				inArray(outlineBlocks.parentId, chunk),
			);
			if (parentIds.includes(null)) groups.push(isNull(outlineBlocks.parentId));
			for (const parents of groups) {
				if (out.length >= limit) break;
				const rows = await db
					.select(metaColumns)
					.from(outlineBlocks)
					.where(and(eq(outlineBlocks.spaceId, spaceId), parents, eq(outlineBlocks.deleted, false)))
					.limit(limit - out.length);
				for (const row of rows) out.push(toMeta(row));
			}
			return out;
		},

		async findAliasOwners(spaceId, aliases) {
			const out: Array<{ alias: string; id: string }> = [];
			for (const chunk of chunked(aliases)) {
				// The literal `deleted = false` lets the planner use the partial unique alias index.
				const rows = await db
					.select({ alias: outlineBlocks.alias, id: outlineBlocks.id })
					.from(outlineBlocks)
					.where(
						and(
							eq(outlineBlocks.spaceId, spaceId),
							inArray(outlineBlocks.alias, chunk),
							sql`${outlineBlocks.deleted} = false`,
						),
					);
				for (const row of rows) if (row.alias !== null) out.push({ alias: row.alias, id: row.id });
			}
			return out;
		},

		async listOpenLinks(blockIds, limit) {
			const out: OutlineLinkRow[] = [];
			for (const ids of chunked(blockIds)) {
				if (out.length >= limit) break;
				const rows = await db
					.select()
					.from(outlineLinks)
					.where(and(inArray(outlineLinks.fromBlockId, ids), isNull(outlineLinks.toSeq)))
					.limit(limit - out.length);
				for (const row of rows) out.push(toLink(row));
			}
			return out;
		},

		async getBlock(id) {
			const rows = await db.select().from(outlineBlocks).where(eq(outlineBlocks.id, id)).limit(1);
			return rows[0] ? toBlock(rows[0]) : null;
		},

		async getBlockBySid(spaceId, sid) {
			const rows = await db
				.select()
				.from(outlineBlocks)
				.where(and(eq(outlineBlocks.spaceId, spaceId), eq(outlineBlocks.sid, sid)))
				.limit(1);
			return rows[0] ? toBlock(rows[0]) : null;
		},

		async listChildren(spaceId, parentId, limit) {
			const rows = await db
				.select()
				.from(outlineBlocks)
				.where(
					and(
						eq(outlineBlocks.spaceId, spaceId),
						parentId === null
							? isNull(outlineBlocks.parentId)
							: eq(outlineBlocks.parentId, parentId),
						eq(outlineBlocks.deleted, false),
					),
				)
				.orderBy(orderKeyBytewise, sql`${outlineBlocks.id} COLLATE "C"`)
				.limit(limit);
			return rows.map(toBlock);
		},

		async listPageBlocks(pageId, limit) {
			const rows = await db
				.select()
				.from(outlineBlocks)
				.where(and(eq(outlineBlocks.pageId, pageId), eq(outlineBlocks.deleted, false)))
				.limit(limit + 1);
			return { blocks: rows.slice(0, limit).map(toBlock), truncated: rows.length > limit };
		},

		async listBlockVersions(blockId, limit) {
			const rows = await db
				.select()
				.from(outlineBlockVersions)
				.where(eq(outlineBlockVersions.blockId, blockId))
				.orderBy(asc(outlineBlockVersions.fromSeq))
				.limit(limit);
			return rows.map(toVersion);
		},

		async listPageVersions(pageId, options) {
			const rows = await db
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
				.orderBy(
					asc(outlineBlockVersions.fromSeq),
					sql`${outlineBlockVersions.blockId} COLLATE "C"`,
				)
				.limit(options.limit);
			return rows.map(toVersion);
		},

		async listCommits(spaceId, options) {
			const rows = await db
				.select()
				.from(outlineCommits)
				.where(
					and(
						eq(outlineCommits.spaceId, spaceId),
						options.afterSeq === undefined ? undefined : gt(outlineCommits.seq, options.afterSeq),
					),
				)
				.orderBy(asc(outlineCommits.seq))
				.limit(options.limit);
			return rows.map(toCommit);
		},

		async appendLiveUpdates(rows) {
			if (rows.length === 0) return;
			await withPgRetry(() => db.transaction((tx) => appendLiveSection(tx, rows)), {
				label: "outline.appendLiveUpdates",
			});
		},

		async replaceLiveUpdates(pageBlockId, epoch, rows) {
			await withPgRetry(
				() => db.transaction((tx) => replaceLiveSection(tx, pageBlockId, epoch, rows)),
				{ label: "outline.replaceLiveUpdates" },
			);
		},

		async listLiveUpdates(pageBlockId, epoch, options) {
			const rows = await db
				.select()
				.from(outlineLiveUpdates)
				.where(
					and(
						eq(outlineLiveUpdates.pageBlockId, pageBlockId),
						eq(outlineLiveUpdates.epoch, epoch),
						options.afterSeq === undefined
							? undefined
							: gt(outlineLiveUpdates.seq, options.afterSeq),
					),
				)
				.orderBy(asc(outlineLiveUpdates.seq))
				.limit(options.limit);
			return rows.map(toLiveUpdate);
		},

		async deleteLiveUpdates(pageBlockId, epoch) {
			const rows = await db
				.delete(outlineLiveUpdates)
				.where(
					and(eq(outlineLiveUpdates.pageBlockId, pageBlockId), eq(outlineLiveUpdates.epoch, epoch)),
				)
				.returning({ seq: outlineLiveUpdates.seq });
			return rows.length;
		},

		async listLiveEpochs(options) {
			const after = options.after;
			// Page ids are compared bytewise, as in the SQLite store.
			return await db
				.select({
					pageBlockId: outlineLiveUpdates.pageBlockId,
					epoch: outlineLiveUpdates.epoch,
				})
				.from(outlineLiveUpdates)
				.where(
					after
						? sql`(${outlineLiveUpdates.pageBlockId} COLLATE "C", ${outlineLiveUpdates.epoch}) > (${after.pageBlockId} COLLATE "C", ${after.epoch})`
						: undefined,
				)
				.groupBy(outlineLiveUpdates.pageBlockId, outlineLiveUpdates.epoch)
				.orderBy(sql`${outlineLiveUpdates.pageBlockId} COLLATE "C"`, asc(outlineLiveUpdates.epoch))
				.limit(options.limit);
		},

		async getViewState(userId, pageBlockId) {
			const rows = await db
				.select()
				.from(outlineViewState)
				.where(
					and(eq(outlineViewState.userId, userId), eq(outlineViewState.pageBlockId, pageBlockId)),
				)
				.limit(1);
			const row = rows[0];
			return row ? toViewState(row) : null;
		},

		async putViewState(row, keepPerUser) {
			await withPgRetry(() => db.transaction((tx) => putViewStateSection(tx, row, keepPerUser)), {
				label: "outline.putViewState",
			});
		},

		async applyCommit(plan) {
			let outcome: "applied" | "stale" | "claims";
			try {
				outcome = await withPgRetry(() => db.transaction((tx) => applyCommitSection(tx, plan)), {
					label: "outline.applyCommit",
				});
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
					...(await db
						.select()
						.from(outlineTaskClaims)
						.where(inArray(outlineTaskClaims.taskBlockId, ids))),
				);
			}
			return out;
		},

		async listClaimedTasks(narratorId, limit) {
			const rows = await db
				.select({ claim: outlineTaskClaims, block: metaColumns })
				.from(outlineTaskClaims)
				.innerJoin(outlineBlocks, eq(outlineBlocks.id, outlineTaskClaims.taskBlockId))
				.where(
					and(
						eq(outlineTaskClaims.holderNarratorId, narratorId),
						isNotNull(outlineTaskClaims.holderNarratorId),
					),
				)
				.orderBy(
					asc(outlineTaskClaims.claimedAt),
					sql`${outlineTaskClaims.taskBlockId} COLLATE "C"`,
				)
				.limit(limit);
			return rows.map((r) => ({ claim: r.claim, block: toMeta(r.block) }));
		},

		async listOpenTasks(spaceId, limit) {
			// The predicate is the open-task index's own, so the planner can use the index.
			const rows = await db
				.select(metaColumns)
				.from(outlineBlocks)
				.where(
					and(
						eq(outlineBlocks.spaceId, spaceId),
						sql`("task_json"::jsonb #>> '{status}') IN ('todo', 'doing') AND "deleted" = FALSE`,
					),
				)
				.limit(limit);
			return rows.map(toMeta);
		},

		async listExpiredTaskClaims(now, limit) {
			return await db
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
				.orderBy(
					asc(outlineTaskClaims.expiresAt),
					sql`${outlineTaskClaims.taskBlockId} COLLATE "C"`,
				)
				.limit(limit);
		},

		async renewTaskClaims(narratorId, expiresAt) {
			return await withPgRetry(
				() => db.transaction((tx) => renewSection(tx, narratorId, expiresAt)),
				{ label: "outline.renewTaskClaims" },
			);
		},

		async updateTaskClaims(writes) {
			if (writes.length === 0) return true;
			return await withPgRetry(() => db.transaction((tx) => updateClaimsSection(tx, writes)), {
				label: "outline.updateTaskClaims",
			});
		},

		async handOverTaskClaims(fromNarratorId, toNarratorId, expiresAt) {
			return await withPgRetry(
				() => db.transaction((tx) => renewSection(tx, fromNarratorId, expiresAt, toNarratorId)),
				{ label: "outline.handOverTaskClaims" },
			);
		},

		async listUnclaimedDoingTasks({ after, scan }) {
			// The literal predicate is the in-progress index's own; ids compare in the index's
			// collation, so the cursor and the order agree.
			const doing = await db
				.select({ id: outlineBlocks.id, spaceId: outlineBlocks.spaceId })
				.from(outlineBlocks)
				.where(
					and(
						sql`("task_json"::jsonb #>> '{status}') = 'doing' AND "deleted" = FALSE`,
						after ? gt(outlineBlocks.id, after) : undefined,
					),
				)
				.orderBy(asc(outlineBlocks.id))
				.limit(scan);
			const claims = new Map<string, OutlineTaskClaimRow>();
			for (const ids of chunked(doing.map((b) => b.id))) {
				for (const row of await db
					.select()
					.from(outlineTaskClaims)
					.where(inArray(outlineTaskClaims.taskBlockId, ids)))
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
				const rows = await db
					.select({
						id: narrators.id,
						type: narrators.type,
						root: narrators.aclRootNarratorId,
					})
					.from(narrators)
					.where(inArray(narrators.id, ids));
				for (const row of rows)
					out.set(row.id, row.type === "subagent" && row.root ? row.root : row.id);
			}
			return out;
		},

		async getInProcessState(spaceIds) {
			const out = new Map<string, { ready: boolean; epoch: number }>();
			for (const ids of chunked(spaceIds)) {
				const rows = await db
					.select({
						id: outlineSpaces.id,
						ready: outlineSpaces.inProcessReady,
						epoch: outlineSpaces.inProcessEpoch,
					})
					.from(outlineSpaces)
					.where(inArray(outlineSpaces.id, ids));
				for (const row of rows) out.set(row.id, { ready: row.ready, epoch: row.epoch });
			}
			return out;
		},

		async hasChangesSince(spaceId, afterSeq, flags, maxCommits) {
			const beyond = await db
				.select({ seq: outlineCommits.seq })
				.from(outlineCommits)
				.where(
					and(eq(outlineCommits.spaceId, spaceId), gt(outlineCommits.seq, afterSeq + maxCommits)),
				)
				.limit(1);
			if (beyond.length > 0) return true;
			const rows = await db.execute(sql`
				SELECT 1 AS hit FROM outline_commits c
				JOIN outline_block_versions v ON v.commit_id = c.id
				WHERE c.space_id = ${spaceId} AND c.seq > CAST(${afterSeq} AS integer)
					AND c.seq <= CAST(${afterSeq + maxCommits} AS integer)
					AND (v.change_flags & CAST(${flags} AS integer)) <> 0
				LIMIT 1
			`);
			return (rows as unknown as unknown[]).length > 0;
		},

		async listSpacesPendingInProcess({ after, limit }) {
			const rows = await db
				.select()
				.from(outlineSpaces)
				.where(
					and(
						sql`"in_process_ready" = FALSE`,
						after ? sql`${outlineSpaces.id} COLLATE "C" > ${after} COLLATE "C"` : undefined,
					),
				)
				.orderBy(sql`${outlineSpaces.id} COLLATE "C"`)
				.limit(limit);
			return rows.map(toSpace);
		},

		async setInProcess(spaceId, expectNextSeq, values) {
			return await withPgRetry(
				() => db.transaction((tx) => setInProcessSection(tx, spaceId, expectNextSeq, values)),
				{ label: "outline.setInProcess" },
			);
		},
	};
}
