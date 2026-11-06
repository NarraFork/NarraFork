/**
 * PostgreSQL implementation of `OutlineDigestPort` (`digest-port.ts`), spread into the store
 * `createPostgresOutlineStore` builds. The same statements as `sqlite-digest.ts`; ids in ORDER BY
 * are compared bytewise (`COLLATE "C"`) where they only break ties.
 */
import { withPgRetry } from "@server/db/pg-retry";
import {
	outlineBlocks,
	outlineBlockVersions,
	outlineCommits,
	outlineDigests,
	outlinePending,
	outlineSpaces,
} from "@server/db/postgres-schema";
import type { OutlineAskJson, OutlineTaskJson } from "@server/db/schema";
import type {
	OutlineDigestCounts,
	OutlineDigestKind,
	OutlineDigestRanges,
	OutlineDigestStored,
} from "@shared/outline-digest";
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
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type {
	OutlinePendingDeciderJson,
	OutlinePendingKind,
	OutlinePendingRequesterJson,
	OutlinePendingStatus,
	OutlineSpaceKind,
	OutlineTaskActorRef,
} from "../model";
import { keyLayers } from "./digest-keys";
import type {
	OutlineDigestHeadRow,
	OutlineDigestPort,
	OutlineDigestRow,
	OutlineSpaceActivity,
	OutlineVersionMeta,
} from "./digest-port";
import { chunked, type OutlinePendingHead } from "./port";

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
		kind: row.kind as OutlineDigestKind,
		periodKey: row.periodKey,
		timeZone: row.timeZone,
		periodStart: row.periodStart,
		periodEnd: row.periodEnd,
		counts: row.countsJson as OutlineDigestCounts,
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
		baseJson: row.baseJson as Record<string, number>,
		blockIdsJson: row.blockIdsJson as string[],
		addsJson: row.addsJson as OutlinePendingHead["addsJson"],
		requestedByJson: row.requestedByJson as OutlinePendingRequesterJson,
		deciderJson: row.deciderJson as OutlinePendingDeciderJson,
		decidedByJson: (row.decidedByJson as OutlineTaskActorRef | null | undefined) ?? null,
	};
}

function seqCase(keys: ReadonlyArray<{ blockId: string; seq: number }>) {
	return sql`CASE outline_blocks.id ${sql.join(
		keys.map((k) => sql`WHEN CAST(${k.blockId} AS text) THEN CAST(${k.seq} AS integer)`),
		sql` `,
	)} END`;
}

export function createPostgresOutlineDigests(db: BunSQLDatabase): OutlineDigestPort {
	const port: OutlineDigestPort = {
		async listSpacesCommittedSince(since, { after, limit }) {
			const s = outlineSpaces;
			const rows = await db
				.select()
				.from(s)
				.where(
					and(
						gte(s.lastCommitAt, since),
						after
							? sql`(${s.lastCommitAt}, ${s.id}) > (CAST(${after.lastCommitAt} AS text), CAST(${after.id} AS text))`
							: undefined,
					),
				)
				.orderBy(asc(s.lastCommitAt), asc(s.id))
				.limit(limit);
			return rows.map(toActivity);
		},

		async stampUnstampedSpaces(limit) {
			const ids = (
				await db
					.select({ id: outlineSpaces.id })
					.from(outlineSpaces)
					.where(sql`"last_commit_at" IS NULL AND "next_seq" > 1`)
					.orderBy(asc(outlineSpaces.id))
					.limit(limit)
			).map((r) => r.id);
			if (ids.length === 0) return 0;
			await withPgRetry(
				() =>
					db
						.update(outlineSpaces)
						.set({
							lastCommitAt: sql`COALESCE((SELECT c.created_at FROM outline_commits c
								WHERE c.space_id = outline_spaces.id AND c.seq = outline_spaces.next_seq - 1),
								outline_spaces.created_at)`,
						})
						.where(and(inArray(outlineSpaces.id, ids), isNull(outlineSpaces.lastCommitAt))),
				{ label: "outline.stampUnstampedSpaces" },
			);
			return ids.length;
		},

		async listCommitRangeChanges(spaceId, afterSeq, toSeq, limit) {
			if (toSeq <= afterSeq || limit <= 0) return [];
			const c = outlineCommits;
			const v = outlineBlockVersions;
			const rows = await db
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
					hasAsk: sql<boolean>`${v.askJson} IS NOT NULL`,
				})
				.from(c)
				.innerJoin(v, eq(v.commitId, c.id))
				.where(
					and(
						eq(c.spaceId, spaceId),
						sql`${c.seq} > CAST(${afterSeq} AS integer)`,
						lte(c.seq, toSeq),
					),
				)
				.orderBy(asc(c.seq), sql`${v.blockId} COLLATE "C"`)
				.limit(limit);
			return rows.map((row) => ({
				...row,
				taskJson: (row.taskJson as OutlineTaskJson | null | undefined) ?? null,
				hasAsk: row.hasAsk === true,
			}));
		},

		async listVersionMetasAt(keys) {
			const out: OutlineVersionMeta[] = [];
			const v = outlineBlockVersions;
			for (const layer of keyLayers(keys)) {
				for (const chunk of chunked(layer, KEYED_CHUNK)) {
					const seqOf = new Map(chunk.map((k) => [k.blockId, k.seq]));
					const at = seqCase(chunk);
					const found = (
						await db
							.select({
								blockId: outlineBlocks.id,
								fromSeq: sql<number | null>`(SELECT v.from_seq FROM outline_block_versions v
									WHERE v.block_id = outline_blocks.id AND v.from_seq <= ${at}
									ORDER BY v.from_seq DESC LIMIT 1)`,
							})
							.from(outlineBlocks)
							.where(inArray(outlineBlocks.id, [...seqOf.keys()]))
					).filter((r): r is { blockId: string; fromSeq: number } => r.fromSeq !== null);
					if (found.length === 0) continue;
					const pairs = sql.join(
						found.map(
							(k) => sql`(CAST(${k.blockId} AS text), CAST(${Number(k.fromSeq)} AS integer))`,
						),
						sql`, `,
					);
					const rows = await db
						.select({
							blockId: v.blockId,
							fromSeq: v.fromSeq,
							toSeq: v.toSeq,
							commitId: v.commitId,
							pageId: v.pageId,
							parentId: v.parentId,
							contentHash: v.contentHash,
							taskJson: v.taskJson,
							askJson: v.askJson,
							changeFlags: v.changeFlags,
							deleted: v.deleted,
						})
						.from(v)
						.where(sql`(${v.blockId}, ${v.fromSeq}) IN (VALUES ${pairs})`);
					for (const row of rows) {
						const seq = seqOf.get(row.blockId) as number;
						if (row.toSeq === null || row.toSeq > seq)
							out.push({
								...row,
								taskJson: (row.taskJson as OutlineTaskJson | null | undefined) ?? null,
								askJson: (row.askJson as OutlineAskJson | null | undefined) ?? null,
							});
					}
				}
			}
			return out;
		},

		async getPendingByDecisionCommits(commitIds) {
			const out: OutlinePendingHead[] = [];
			for (const chunk of chunked([...new Set(commitIds)])) {
				const rows = await db
					.select(pendingHeadColumns)
					.from(outlinePending)
					.where(inArray(outlinePending.decisionCommitId, chunk))
					.limit(chunk.length);
				for (const row of rows) out.push(toPendingHead(row));
			}
			return out;
		},

		async insertDigest(row) {
			const rows = await withPgRetry(
				() =>
					db
						.insert(outlineDigests)
						.values(toValues(row))
						.onConflictDoNothing({
							target: [outlineDigests.userId, outlineDigests.kind, outlineDigests.periodKey],
						})
						.returning({ id: outlineDigests.id }),
				{ label: "outline.insertDigest" },
			);
			return rows.length > 0;
		},

		async replaceDigest(row) {
			const values = toValues(row);
			const { userId: _user, kind: _kind, periodKey: _key, ...set } = values;
			await withPgRetry(
				() =>
					db
						.insert(outlineDigests)
						.values(values)
						.onConflictDoUpdate({
							target: [outlineDigests.userId, outlineDigests.kind, outlineDigests.periodKey],
							set,
						}),
				{ label: "outline.replaceDigest" },
			);
		},

		async getDigest(id) {
			const rows = await db.select().from(outlineDigests).where(eq(outlineDigests.id, id)).limit(1);
			const row = rows[0];
			if (!row) return null;
			return {
				...toHead(row),
				items: row.itemsJson as OutlineDigestStored,
				ranges: (row.rangesJson as OutlineDigestRanges | null) ?? {},
			};
		},

		async listDigestHeads(userId, { kind, before, limit }) {
			const d = outlineDigests;
			const rows = await db
				.select(digestHeadColumns)
				.from(d)
				.where(
					and(eq(d.userId, userId), eq(d.kind, kind), before ? lt(d.periodKey, before) : undefined),
				)
				.orderBy(desc(d.periodKey))
				.limit(limit);
			return rows.map(toHead);
		},

		async listUnseenDigestHeads(userId, limit) {
			const d = outlineDigests;
			const rows = await db
				.select(digestHeadColumns)
				.from(d)
				.where(and(eq(d.userId, userId), sql`"seen_at" IS NULL`))
				.orderBy(desc(d.periodKey), asc(d.kind))
				.limit(limit);
			return rows.map(toHead);
		},

		async markDigestsSeen(userId, ids, at) {
			let marked = 0;
			for (const chunk of chunked(ids)) {
				const rows = await withPgRetry(
					() =>
						db
							.update(outlineDigests)
							.set({ seenAt: at })
							.where(
								and(
									inArray(outlineDigests.id, chunk),
									eq(outlineDigests.userId, userId),
									isNull(outlineDigests.seenAt),
								),
							)
							.returning({ id: outlineDigests.id }),
					{ label: "outline.markDigestsSeen" },
				);
				marked += rows.length;
			}
			return marked;
		},

		async getLatestDigestCursor(userId, kind, options = {}) {
			const d = outlineDigests;
			const rows = await db
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
				.limit(1);
			const row = rows[0];
			return row ? { ...row, ranges: (row.ranges as OutlineDigestRanges | null) ?? {} } : null;
		},

		async deleteDigests(userId, kind, { atMostKey, exceptId }) {
			const d = outlineDigests;
			const rows = await withPgRetry(
				() =>
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
						.returning({ id: d.id }),
				{ label: "outline.deleteDigests" },
			);
			return rows.length;
		},

		async pruneDigests(userId, kind, keep) {
			const d = outlineDigests;
			const rows = await db
				.select({ periodKey: d.periodKey })
				.from(d)
				.where(and(eq(d.userId, userId), eq(d.kind, kind)))
				.orderBy(desc(d.periodKey))
				.limit(1)
				.offset(Math.max(0, keep));
			const newestDropped = rows[0];
			if (!newestDropped) return 0;
			return await port.deleteDigests(userId, kind, { atMostKey: newestDropped.periodKey });
		},
	};
	return port;
}
