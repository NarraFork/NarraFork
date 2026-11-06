/**
 * SQLite implementation of `OutlineDigestPort` (`digest-port.ts`), spread into
 * `sqliteOutlineStore`. Small indexed statements run inline; the versions of a range of commits
 * (up to thousands of rows) are read on the read-worker pool (`readQuery`).
 */
import { readQuery } from "@server/db/worker-read";
import {
	and,
	asc,
	desc,
	eq,
	getTableColumns,
	gte,
	inArray,
	isNull,
	lt,
	lte,
	ne,
	sql,
} from "drizzle-orm";
import { db } from "../../../db";
import {
	outlineBlocks,
	outlineBlockVersions,
	outlineCommits,
	outlineDigests,
	outlinePending,
	outlineSpaces,
} from "../../../db/schema";
import { withDbRetry } from "../../../lib/db-resilience";
import type { OutlinePendingKind, OutlinePendingStatus, OutlineSpaceKind } from "../model";
import { keyLayers } from "./digest-keys";
import type {
	OutlineDigestCursorRow,
	OutlineDigestHeadRow,
	OutlineDigestPort,
	OutlineDigestRow,
	OutlineSpaceActivity,
	OutlineVersionMeta,
} from "./digest-port";
import { chunked, type OutlinePendingHead } from "./port";

/** Keys per as-of statement (each binds a few parameters). */
const KEYED_CHUNK = 200;

type SpaceSelect = typeof outlineSpaces.$inferSelect;
type DigestSelect = typeof outlineDigests.$inferSelect;
type PendingSelect = typeof outlinePending.$inferSelect;

function toActivity(row: SpaceSelect): OutlineSpaceActivity {
	const { inProcessReady: _ready, lastCommitAt, ...space } = row;
	return { ...space, kind: row.kind as OutlineSpaceKind, lastCommitAt: lastCommitAt ?? "" };
}

const digestHeadColumns = (() => {
	const { itemsJson: _items, rangesJson: _ranges, ...columns } = getTableColumns(outlineDigests);
	return columns;
})();

function toHead(row: Omit<DigestSelect, "itemsJson" | "rangesJson">): OutlineDigestHeadRow {
	return {
		id: row.id,
		userId: row.userId,
		kind: row.kind,
		periodKey: row.periodKey,
		timeZone: row.timeZone,
		periodStart: row.periodStart,
		periodEnd: row.periodEnd,
		counts: row.countsJson,
		itemCount: row.itemCount,
		truncated: row.truncated,
		createdAt: row.createdAt,
		seenAt: row.seenAt,
	};
}

function toValues(row: OutlineDigestRow): typeof outlineDigests.$inferInsert {
	return {
		id: row.id,
		userId: row.userId,
		kind: row.kind,
		periodKey: row.periodKey,
		timeZone: row.timeZone,
		periodStart: row.periodStart,
		periodEnd: row.periodEnd,
		countsJson: row.counts,
		itemCount: row.itemCount,
		itemsJson: row.items,
		rangesJson: row.ranges,
		truncated: row.truncated,
		createdAt: row.createdAt,
		seenAt: row.seenAt,
	};
}

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

/** `CASE outline_blocks.id WHEN … THEN … END`: a per-block seq (a layer never repeats a block). */
function seqCase(keys: ReadonlyArray<{ blockId: string; seq: number }>) {
	return sql`CASE outline_blocks.id ${sql.join(
		keys.map((k) => sql`WHEN ${k.blockId} THEN ${k.seq}`),
		sql` `,
	)} END`;
}

export const sqliteOutlineDigests: OutlineDigestPort = {
	async listSpacesCommittedSince(since, { after, limit }) {
		const s = outlineSpaces;
		return db
			.select()
			.from(s)
			.where(
				and(
					gte(s.lastCommitAt, since),
					after
						? sql`(${s.lastCommitAt}, ${s.id}) > (${after.lastCommitAt}, ${after.id})`
						: undefined,
				),
			)
			.orderBy(asc(s.lastCommitAt), asc(s.id))
			.limit(limit)
			.all()
			.map(toActivity);
	},

	async listUnstampedSpaces(limit) {
		// The predicate is the partial index's own, word for word.
		return db
			.select({ id: outlineSpaces.id })
			.from(outlineSpaces)
			.where(sql`"last_commit_at" IS NULL AND "next_seq" > 1`)
			.orderBy(asc(outlineSpaces.id))
			.limit(limit)
			.all()
			.map((r) => r.id);
	},

	async stampSpaces(spaceIds) {
		if (spaceIds.length === 0) return 0;
		return await withDbRetry(
			async () => {
				let stamped = 0;
				for (const ids of chunked([...new Set(spaceIds)])) {
					stamped += db
						.update(outlineSpaces)
						.set({
							// The space's latest commit; its creation should that ever be missing, so a
							// space is never left to be visited again.
							lastCommitAt: sql`COALESCE((SELECT c.created_at FROM outline_commits c
								WHERE c.space_id = outline_spaces.id AND c.seq = outline_spaces.next_seq - 1),
								outline_spaces.created_at)`,
						})
						.where(and(inArray(outlineSpaces.id, ids), isNull(outlineSpaces.lastCommitAt)))
						.returning({ id: outlineSpaces.id })
						.all().length;
				}
				return stamped;
			},
			{ label: "outline.stampSpaces", maxRetries: 3 },
		);
	},

	async listCommitRangeChanges(spaceId, afterSeq, toSeq, limit) {
		if (toSeq <= afterSeq || limit <= 0) return [];
		const c = outlineCommits;
		const v = outlineBlockVersions;
		const query = db
			.select({
				seq: c.seq,
				commitId: c.id,
				blockId: v.blockId,
				pageId: v.pageId,
				parentId: v.parentId,
				changeFlags: v.changeFlags,
				deleted: v.deleted,
				contentHash: v.contentHash,
				taskJson: v.taskJson,
				hasAsk: sql<number>`${v.askJson} IS NOT NULL`,
			})
			.from(c)
			.innerJoin(v, eq(v.commitId, c.id))
			.where(and(eq(c.spaceId, spaceId), sql`${c.seq} > ${afterSeq}`, lte(c.seq, toSeq)))
			.orderBy(asc(c.seq), asc(v.blockId))
			.limit(limit);
		const rows = await readQuery(query, { maxRows: limit });
		return rows.map((row) => ({
			...row,
			taskJson: row.taskJson ?? null,
			hasAsk: Number(row.hasAsk) === 1,
		}));
	},

	async listVersionMetasAt(keys, options = {}) {
		const out: OutlineVersionMeta[] = [];
		const v = outlineBlockVersions;
		const columns = {
			blockId: v.blockId,
			fromSeq: v.fromSeq,
			toSeq: v.toSeq,
			commitId: v.commitId,
			pageId: v.pageId,
			parentId: v.parentId,
			contentHash: v.contentHash,
			taskJson: v.taskJson,
			changeFlags: v.changeFlags,
			deleted: v.deleted,
		};
		for (const layer of keyLayers(keys)) {
			for (const chunk of chunked(layer, KEYED_CHUNK)) {
				const seqOf = new Map(chunk.map((k) => [k.blockId, k.seq]));
				const at = seqCase(chunk);
				// The latest version that opened by each seq, then those rows by exact key.
				const found = db
					.select({
						blockId: outlineBlocks.id,
						fromSeq: sql<number | null>`(SELECT v.from_seq FROM outline_block_versions v
							WHERE v.block_id = outline_blocks.id AND v.from_seq <= ${at}
							ORDER BY v.from_seq DESC LIMIT 1)`,
					})
					.from(outlineBlocks)
					.where(inArray(outlineBlocks.id, [...seqOf.keys()]))
					.all()
					.filter((r): r is { blockId: string; fromSeq: number } => r.fromSeq !== null);
				if (found.length === 0) continue;
				const pairs = sql.join(
					found.map((k) => sql`(${k.blockId}, ${k.fromSeq})`),
					sql`, `,
				);
				// `ask_json` (up to kilobytes) only for the reads that use it.
				const where = sql`(${v.blockId}, ${v.fromSeq}) IN (VALUES ${pairs})`;
				const rows = options.withAsk
					? db
							.select({ ...columns, askJson: v.askJson })
							.from(v)
							.where(where)
							.all()
					: db
							.select(columns)
							.from(v)
							.where(where)
							.all()
							.map((row) => ({ ...row, askJson: null }));
				for (const row of rows) {
					const seq = seqOf.get(row.blockId) as number;
					if (row.toSeq === null || row.toSeq > seq)
						out.push({ ...row, taskJson: row.taskJson ?? null, askJson: row.askJson ?? null });
				}
			}
		}
		return out;
	},

	async getPendingByDecisionCommits(commitIds) {
		const out: OutlinePendingHead[] = [];
		for (const chunk of chunked([...new Set(commitIds)])) {
			const rows = db
				.select(pendingHeadColumns)
				.from(outlinePending)
				.where(inArray(outlinePending.decisionCommitId, chunk))
				.limit(chunk.length)
				.all();
			for (const row of rows) out.push(toPendingHead(row));
		}
		return out;
	},

	async insertDigest(row) {
		return await withDbRetry(
			async () =>
				db
					.insert(outlineDigests)
					.values(toValues(row))
					.onConflictDoNothing({
						target: [outlineDigests.userId, outlineDigests.kind, outlineDigests.periodKey],
					})
					.returning({ id: outlineDigests.id })
					.all().length > 0,
			{ label: "outline.insertDigest", maxRetries: 3 },
		);
	},

	async replaceDigest(row) {
		const values = toValues(row);
		// The row keeps its id: a client that was handed it still finds the replacement.
		const { id: _id, userId: _user, kind: _kind, periodKey: _key, ...set } = values;
		return await withDbRetry(
			async () => {
				const stored = db
					.insert(outlineDigests)
					.values(values)
					.onConflictDoUpdate({
						target: [outlineDigests.userId, outlineDigests.kind, outlineDigests.periodKey],
						set,
					})
					.returning({ id: outlineDigests.id })
					.get();
				return stored?.id ?? row.id;
			},
			{ label: "outline.replaceDigest", maxRetries: 3 },
		);
	},

	async getDigest(id) {
		const row = db.select().from(outlineDigests).where(eq(outlineDigests.id, id)).limit(1).get();
		if (!row) return null;
		return { ...toHead(row), items: row.itemsJson, ranges: row.rangesJson };
	},

	async listDigestHeads(userId, { kind, before, limit }) {
		const d = outlineDigests;
		return db
			.select(digestHeadColumns)
			.from(d)
			.where(
				and(eq(d.userId, userId), eq(d.kind, kind), before ? lt(d.periodKey, before) : undefined),
			)
			.orderBy(desc(d.periodKey))
			.limit(limit)
			.all()
			.map(toHead);
	},

	async listUnseenDigestHeads(userId, limit) {
		const d = outlineDigests;
		return (
			db
				.select(digestHeadColumns)
				.from(d)
				// The predicate is the unread index's own.
				.where(and(eq(d.userId, userId), sql`"seen_at" IS NULL`))
				.orderBy(desc(d.periodKey), asc(d.kind))
				.limit(limit)
				.all()
				.map(toHead)
		);
	},

	async markDigestsSeen(userId, ids, at) {
		if (ids.length === 0) return 0;
		return await withDbRetry(
			async () => {
				let marked = 0;
				for (const chunk of chunked(ids)) {
					marked += db
						.update(outlineDigests)
						.set({ seenAt: at })
						.where(
							and(
								inArray(outlineDigests.id, chunk),
								eq(outlineDigests.userId, userId),
								isNull(outlineDigests.seenAt),
							),
						)
						.returning({ id: outlineDigests.id })
						.all().length;
				}
				return marked;
			},
			{ label: "outline.markDigestsSeen", maxRetries: 3 },
		);
	},

	async getLatestDigestCursor(userId, kind, options = {}) {
		const d = outlineDigests;
		const row = db
			.select({ id: d.id, periodKey: d.periodKey, periodEnd: d.periodEnd, ranges: d.rangesJson })
			.from(d)
			.where(
				and(
					eq(d.userId, userId),
					eq(d.kind, kind),
					options.beforeKey ? lt(d.periodKey, options.beforeKey) : undefined,
				),
			)
			.orderBy(desc(d.periodKey))
			.limit(1)
			.get();
		return row ? ({ ...row, ranges: row.ranges ?? {} } satisfies OutlineDigestCursorRow) : null;
	},

	async deleteDigests(userId, kind, { atMostKey, exceptId }) {
		const d = outlineDigests;
		return await withDbRetry(
			async () =>
				db
					.delete(d)
					.where(
						and(
							eq(d.userId, userId),
							eq(d.kind, kind),
							atMostKey ? lte(d.periodKey, atMostKey) : undefined,
							exceptId ? ne(d.id, exceptId) : undefined,
						),
					)
					.returning({ id: d.id })
					.all().length,
			{ label: "outline.deleteDigests", maxRetries: 3 },
		);
	},

	async pruneDigests(userId, kind, keep) {
		const d = outlineDigests;
		const newestDropped = db
			.select({ periodKey: d.periodKey })
			.from(d)
			.where(and(eq(d.userId, userId), eq(d.kind, kind)))
			.orderBy(desc(d.periodKey))
			.limit(1)
			.offset(Math.max(0, keep))
			.get();
		if (!newestDropped) return 0;
		return await sqliteOutlineDigests.deleteDigests(userId, kind, {
			atMostKey: newestDropped.periodKey,
		});
	},
};
