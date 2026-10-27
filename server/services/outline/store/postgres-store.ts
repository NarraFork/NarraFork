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
	outlineBlocks,
	outlineBlockVersions,
	outlineCommits,
	outlineLinks,
	outlineLiveUpdates,
	outlineSpaces,
} from "@server/db/postgres-schema";
import type { OutlineTaskJson } from "@server/db/schema";
import { generateId } from "@server/lib/id";
import { and, asc, eq, gt, inArray, isNull, type SQL, sql } from "drizzle-orm";
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
	type OutlineBlockMeta,
	type OutlineBlockRow,
	type OutlineCommitPlan,
	type OutlineCommitRow,
	type OutlineLinkRow,
	type OutlineLiveUpdateRow,
	type OutlineSpaceRow,
	type OutlineSpaceScope,
	OutlineStaleWriteError,
	type OutlineStore,
	type OutlineVersionRow,
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
	return { ...row, kind: row.kind as OutlineSpaceKind };
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
async function applyCommitSection(tx: PgTransaction, plan: OutlineCommitPlan): Promise<boolean> {
	const { seq } = plan;
	const claimed = await tx
		.update(outlineSpaces)
		.set({ nextSeq: sql`${outlineSpaces.nextSeq} + 1` })
		.where(and(eq(outlineSpaces.id, plan.spaceId), eq(outlineSpaces.nextSeq, seq)))
		.returning({ nextSeq: outlineSpaces.nextSeq });
	if (claimed.length === 0) return false;

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
	return true;
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

		async applyCommit(plan) {
			let applied: boolean;
			try {
				applied = await withPgRetry(() => db.transaction((tx) => applyCommitSection(tx, plan)), {
					label: "outline.applyCommit",
				});
			} catch (error) {
				rethrowAsPortError(error);
			}
			if (!applied) throw new OutlineStaleWriteError(plan.spaceId, plan.seq);
		},
	};
}
