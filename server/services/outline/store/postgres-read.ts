/**
 * PostgreSQL implementation of `OutlineReadPort`, spread into the store
 * `createPostgresOutlineStore` builds.
 *
 * The same reads as `sqlite-read.ts`, as single statements with explicit limits. Full-text
 * search filters on the pg_trgm shadow table `search_outline_blocks` (`server/db/pg-fts.ts`):
 * every term is an `ILIKE '%term%'` there, the same substring semantics as the SQLite trigram
 * `MATCH` (short terms included, which the GIN index simply cannot accelerate), and relevance is
 * `1 - similarity(content, query)`. Ids in ORDER BY are compared bytewise (`COLLATE "C"`), so
 * ties break the same way on both backends.
 */
import {
	outlineBlocks,
	outlineBlockVersions,
	outlineCommits,
	outlineLinks,
} from "@server/db/postgres-schema";
import type { OutlineTaskJson } from "@server/db/schema";
import {
	and,
	desc,
	eq,
	exists,
	gt,
	inArray,
	isNull,
	lt,
	lte,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type {
	OutlineActorKind,
	OutlineCommitKind,
	OutlineLinkKind,
	OutlineLinkTargetKind,
} from "../model";
import {
	chunked,
	type OutlineBlockRow,
	type OutlineCommitRow,
	type OutlineLinkRow,
	type OutlineVersionRow,
} from "./port";
import { OUTLINE_PAGE_HEAD_CHARS, type OutlineReadPort, type OutlineSearchRow } from "./read-port";

/** Version keys per statement (two bound parameters each). */
const VERSION_KEY_CHUNK = 250;

type BlockSelect = typeof outlineBlocks.$inferSelect;
type VersionSelect = typeof outlineBlockVersions.$inferSelect;
type LinkSelect = typeof outlineLinks.$inferSelect;
type CommitSelect = typeof outlineCommits.$inferSelect;

/** JSON columns are text with a codec here; the schema only knows them as `unknown`. */
function taskOf(value: unknown): OutlineTaskJson | null {
	return (value as OutlineTaskJson | null | undefined) ?? null;
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

function toLink(row: LinkSelect): OutlineLinkRow {
	return {
		...row,
		kind: row.kind as OutlineLinkKind,
		targetKind: row.targetKind as OutlineLinkTargetKind,
	};
}

function toCommit(row: CommitSelect): OutlineCommitRow {
	return {
		...row,
		kind: row.kind as OutlineCommitKind,
		actorKind: row.actorKind as OutlineActorKind,
	};
}

const byIdBytewise = (column: unknown) => sql`${column} COLLATE "C"`;

/** `%text%` for `ILIKE … ESCAPE '\\'`, with the pattern characters in `text` matched literally. */
function escapedContains(text: string): string {
	return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function validAt(seq: number | null): SQL | undefined {
	const v = outlineBlockVersions;
	return seq === null
		? isNull(v.toSeq)
		: and(lte(v.fromSeq, seq), or(isNull(v.toSeq), gt(v.toSeq, seq)));
}

function linkValidAt(seq: number | null): SQL | undefined {
	const l = outlineLinks;
	return seq === null
		? isNull(l.toSeq)
		: and(lte(l.fromSeq, seq), or(isNull(l.toSeq), gt(l.toSeq, seq)));
}

export function createPostgresOutlineReads(db: BunSQLDatabase): OutlineReadPort {
	return {
		async listPageStructure(pageId, { asOf, limit }) {
			let rows: Array<{
				id: string;
				sid: string;
				parentId: string | null;
				orderKey: string;
				alias: string | null;
				taskJson: unknown;
				versionSeq: number;
			}>;
			if (asOf === null) {
				rows = await db
					.select({
						id: outlineBlocks.id,
						sid: outlineBlocks.sid,
						parentId: outlineBlocks.parentId,
						orderKey: outlineBlocks.orderKey,
						alias: outlineBlocks.alias,
						taskJson: outlineBlocks.taskJson,
						versionSeq: outlineBlocks.versionSeq,
					})
					.from(outlineBlocks)
					.where(and(eq(outlineBlocks.pageId, pageId), eq(outlineBlocks.deleted, false)))
					.limit(limit + 1);
			} else {
				const v = outlineBlockVersions;
				rows = await db
					.select({
						id: v.blockId,
						sid: outlineBlocks.sid,
						parentId: v.parentId,
						orderKey: v.orderKey,
						alias: v.alias,
						taskJson: v.taskJson,
						versionSeq: v.fromSeq,
					})
					.from(v)
					.innerJoin(outlineBlocks, eq(outlineBlocks.id, v.blockId))
					.where(and(eq(v.pageId, pageId), validAt(asOf), eq(v.deleted, false)))
					.limit(limit + 1);
			}
			return {
				rows: rows.slice(0, limit).map((r) => ({ ...r, taskJson: taskOf(r.taskJson) })),
				truncated: rows.length > limit,
			};
		},

		async listVersionsAt(blockIds, seq) {
			const out: OutlineVersionRow[] = [];
			for (const ids of chunked(blockIds)) {
				const rows = await db
					.select()
					.from(outlineBlockVersions)
					.where(and(inArray(outlineBlockVersions.blockId, ids), validAt(seq)));
				for (const row of rows) out.push(toVersion(row));
			}
			return out;
		},

		async listVersionContents(keys) {
			const out: Array<{ blockId: string; fromSeq: number; content: string | null }> = [];
			for (const chunk of chunked(keys, VERSION_KEY_CHUNK)) {
				const pairs = sql.join(
					chunk.map((k) => sql`(CAST(${k.blockId} AS text), CAST(${k.fromSeq} AS integer))`),
					sql`, `,
				);
				const v = outlineBlockVersions;
				const rows = await db
					.select({ blockId: v.blockId, fromSeq: v.fromSeq, content: v.content })
					.from(v)
					.where(sql`(${v.blockId}, ${v.fromSeq}) IN (VALUES ${pairs})`);
				out.push(...rows);
			}
			return out;
		},

		async listLinksAt(blockIds, seq, kinds, limit) {
			const out: OutlineLinkRow[] = [];
			if (kinds.length === 0) return out;
			for (const ids of chunked(blockIds)) {
				if (out.length >= limit) break;
				const rows = await db
					.select()
					.from(outlineLinks)
					.where(
						and(
							inArray(outlineLinks.fromBlockId, ids),
							inArray(outlineLinks.kind, [...kinds]),
							linkValidAt(seq),
						),
					)
					.limit(limit - out.length);
				for (const row of rows) out.push(toLink(row));
			}
			return out;
		},

		async listPageSeqs(pageId, { edge, before, after, limit }) {
			const v = outlineBlockVersions;
			const rows =
				edge === "from"
					? await db
							.selectDistinct({ seq: v.fromSeq })
							.from(v)
							.where(and(eq(v.pageId, pageId), lt(v.fromSeq, before), gt(v.fromSeq, after)))
							.orderBy(desc(v.fromSeq))
							.limit(limit)
					: await db
							.selectDistinct({ seq: v.toSeq })
							.from(v)
							.where(
								and(
									eq(v.pageId, pageId),
									lt(v.fromSeq, before),
									gt(v.toSeq, after),
									lt(v.toSeq, before),
								),
							)
							.orderBy(desc(v.toSeq))
							.limit(limit);
			return rows.map((r) => r.seq).filter((s): s is number => s !== null);
		},

		async getCommit(id) {
			const rows = await db.select().from(outlineCommits).where(eq(outlineCommits.id, id)).limit(1);
			return rows[0] ? toCommit(rows[0]) : null;
		},

		async getCommitsBySeqs(spaceId, seqs) {
			const out: OutlineCommitRow[] = [];
			for (const chunk of chunked(seqs)) {
				const rows = await db
					.select()
					.from(outlineCommits)
					.where(and(eq(outlineCommits.spaceId, spaceId), inArray(outlineCommits.seq, chunk)));
				for (const row of rows) out.push(toCommit(row));
			}
			return out;
		},

		async listCommitVersions(commitId, limit) {
			const rows = await db
				.select()
				.from(outlineBlockVersions)
				.where(eq(outlineBlockVersions.commitId, commitId))
				.orderBy(byIdBytewise(outlineBlockVersions.blockId))
				.limit(limit);
			return rows.map(toVersion);
		},

		async findBlocksChangedAfter(blockIds, seq, ignoreFlags) {
			const v = outlineBlockVersions;
			const out: string[] = [];
			for (const ids of chunked(blockIds)) {
				const later = db
					.select({ one: sql`1` })
					.from(v)
					.where(
						and(
							eq(v.blockId, outlineBlocks.id),
							gt(v.fromSeq, seq),
							ne(v.changeFlags, ignoreFlags),
						),
					);
				const rows = await db
					.select({ id: outlineBlocks.id })
					.from(outlineBlocks)
					.where(and(inArray(outlineBlocks.id, ids), exists(later)));
				for (const row of rows) out.push(row.id);
			}
			return out;
		},

		async getBlocks(ids) {
			const out: OutlineBlockRow[] = [];
			for (const chunk of chunked(ids)) {
				const rows = await db.select().from(outlineBlocks).where(inArray(outlineBlocks.id, chunk));
				for (const row of rows) out.push(toBlock(row));
			}
			return out;
		},

		async findLiveBlocks(spaceIds, by, limit) {
			const out: OutlineBlockRow[] = [];
			for (const spaces of chunked(spaceIds)) {
				if (out.length >= limit) break;
				const rows = await db
					.select()
					.from(outlineBlocks)
					.where(
						and(
							inArray(outlineBlocks.spaceId, spaces),
							"sid" in by ? eq(outlineBlocks.sid, by.sid) : eq(outlineBlocks.alias, by.alias),
							// The literal lets the planner use the partial unique alias index.
							sql`${outlineBlocks.deleted} = false`,
						),
					)
					.orderBy(byIdBytewise(outlineBlocks.id))
					.limit(limit - out.length);
				for (const row of rows) out.push(toBlock(row));
			}
			return out;
		},

		async listAliasRange(spaceId, range, limit) {
			const rows = await db
				.select({ alias: outlineBlocks.alias })
				.from(outlineBlocks)
				.where(
					and(
						eq(outlineBlocks.spaceId, spaceId),
						sql`${outlineBlocks.alias} COLLATE "C" >= ${range.from}`,
						sql`${outlineBlocks.alias} COLLATE "C" < ${range.to}`,
						sql`${outlineBlocks.deleted} = false`,
					),
				)
				.orderBy(byIdBytewise(outlineBlocks.alias))
				.limit(limit);
			return rows.map((row) => row.alias as string);
		},

		async searchBlocks(query) {
			const out: OutlineSearchRow[] = [];
			const terms = [...query.indexed, ...query.short];
			if (terms.length === 0) return out;
			const matches = sql.join(
				terms.map((term) => sql`f.content ILIKE ${escapedContains(term)} ESCAPE '\\'`),
				sql` AND `,
			);
			const rank =
				query.indexed.length > 0
					? sql<number>`(1 - similarity(lower(${outlineBlocks.content}), lower(${terms.join(" ")})))`
					: sql<number>`length(${outlineBlocks.content})`;
			for (const spaces of chunked(query.spaceIds)) {
				const rows = await db
					.select({
						id: outlineBlocks.id,
						spaceId: outlineBlocks.spaceId,
						sid: outlineBlocks.sid,
						parentId: outlineBlocks.parentId,
						pageId: outlineBlocks.pageId,
						content: outlineBlocks.content,
						alias: outlineBlocks.alias,
						taskJson: outlineBlocks.taskJson,
						rank,
					})
					.from(outlineBlocks)
					.where(
						and(
							sql`${outlineBlocks.id} IN (SELECT f.id FROM search_outline_blocks f WHERE ${matches})`,
							inArray(outlineBlocks.spaceId, spaces),
							eq(outlineBlocks.deleted, false),
						),
					)
					.orderBy(rank, byIdBytewise(outlineBlocks.id))
					.limit(query.limit);
				for (const row of rows) {
					out.push({ ...row, taskJson: taskOf(row.taskJson), rank: Number(row.rank) });
				}
			}
			out.sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
			return out.slice(0, query.limit);
		},

		async listLinksTo(targets, spaceIds, limit) {
			const out: OutlineLinkRow[] = [];
			if (targets.length === 0) return out;
			const target = or(
				...targets.map((t) =>
					and(
						eq(outlineLinks.targetKind, t.targetKind),
						eq(outlineLinks.targetRef, t.targetRef),
						t.spaceId === undefined ? undefined : eq(outlineLinks.spaceId, t.spaceId),
					),
				),
			);
			for (const spaces of chunked(spaceIds)) {
				if (out.length >= limit) break;
				const rows = await db
					.select()
					.from(outlineLinks)
					.where(and(target, isNull(outlineLinks.toSeq), inArray(outlineLinks.spaceId, spaces)))
					.orderBy(byIdBytewise(outlineLinks.id))
					.limit(limit - out.length);
				for (const row of rows) out.push(toLink(row));
			}
			return out;
		},

		async listSpacePages(spaceId, { after, limit }) {
			const b = outlineBlocks;
			const orderKey = sql`${b.orderKey} COLLATE "C"`;
			const id = byIdBytewise(b.id);
			const rows = await db
				.select({
					id: b.id,
					sid: b.sid,
					orderKey: b.orderKey,
					alias: b.alias,
					contentHead: sql<string>`substring(${b.content} from 1 for ${sql.raw(String(OUTLINE_PAGE_HEAD_CHARS))})`,
					hasTask: sql<boolean>`${b.taskJson} IS NOT NULL`,
				})
				.from(b)
				.where(
					and(
						eq(b.spaceId, spaceId),
						isNull(b.parentId),
						eq(b.deleted, false),
						after
							? sql`(${orderKey} > ${after.orderKey}
								OR (${b.orderKey} = ${after.orderKey} AND ${id} > ${after.id}))`
							: undefined,
					),
				)
				.orderBy(orderKey, id)
				.limit(limit);
			return rows.map(({ hasTask, ...row }) => ({ ...row, isTask: Boolean(hasTask) }));
		},

		async listBlockHistory(blockId, { before, limit }) {
			const v = outlineBlockVersions;
			return await db
				.select({
					fromSeq: v.fromSeq,
					toSeq: v.toSeq,
					commitId: v.commitId,
					pageId: v.pageId,
					changeFlags: v.changeFlags,
					deleted: v.deleted,
				})
				.from(v)
				.where(
					and(
						eq(v.blockId, blockId),
						before === undefined || before === null ? undefined : lt(v.fromSeq, before),
					),
				)
				.orderBy(desc(v.fromSeq))
				.limit(limit);
		},
	};
}
