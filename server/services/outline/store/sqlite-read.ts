/**
 * SQLite implementation of `OutlineReadPort`, spread into `sqliteOutlineStore`.
 *
 * Where each read runs:
 *   - small indexed reads (by id, by commit, by link target, the versions or links of a bounded
 *     list of blocks) run inline, like the store's other reads;
 *   - a page's structure is read inline while the page has at most
 *     {@link MAIN_THREAD_PAGE_ROWS} live blocks; a larger page is read again on the read-worker
 *     pool (the first, bounded attempt is what tells the two apart);
 *   - the seqs of a page's history and full-text search can scan many rows and always run on
 *     the read-worker pool (`readQuery`, and the search executor for raw FTS5 SQL).
 *
 * The two reads on the path of every page read (a page's structure, the content of the blocks
 * shown) are plain SQL on cached statements of the connection rather than query builders:
 * building the statement and mapping its rows cost several times the query itself there. The
 * structure SQL goes to the workers verbatim when a page is too large to read inline.
 */
import { readQuery } from "@server/db/worker-read";
import {
	and,
	asc,
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
import { db, sqlite } from "../../../db";
import {
	outlineBlocks,
	outlineBlockVersions,
	outlineCommits,
	outlineLinks,
} from "../../../db/schema";
import { runReadTask, WorkersUnavailableError } from "../../../lib/db-worker/pool";
import {
	SELECT_ROWS_MAX_ROWS,
	type SelectRowsParams,
	type SelectRowsResult,
} from "../../../lib/db-worker/protocol";
import { escapedContains, prefixExpr } from "../../search/sqlite-expressions";
import { executeSqliteSearchQuery } from "../../search/sqlite-worker-runner";
import type {
	OutlineActorKind,
	OutlineCommitKind,
	OutlineLinkKind,
	OutlineTaskJson,
} from "../model";
import {
	chunked,
	type OutlineBlockRow,
	type OutlineCommitRow,
	type OutlineLinkRow,
	type OutlineVersionRow,
} from "./port";
import {
	OUTLINE_LAST_WRITES_SCAN,
	OUTLINE_PAGE_HEAD_CHARS,
	type OutlineReadPort,
	type OutlineSearchRow,
	type OutlineStructureRow,
} from "./read-port";

/** Live blocks of a page read on the main thread; a larger page is read on the worker pool. */
export const MAIN_THREAD_PAGE_ROWS = 2000;
/**
 * Version keys per content statement, padded up to the next size so the connection caches a
 * handful of statements rather than one per list length.
 */
const VERSION_KEY_SIZES = [8, 32, 128, 250] as const;
const WORKER_TIMEOUT_MS = 30_000;
/** Keys per statement of the reads keyed by block and seq (each key binds a few parameters). */
const KEYED_CHUNK = 200;
/** Keys per last-writes statement: each binds its seq in four subqueries. */
const LAST_WRITES_CHUNK = 50;
/** Spaces per search statement: the worker accepts at most 256 bound parameters. */
const SEARCH_SPACE_CHUNK = 200;

type BlockSelect = typeof outlineBlocks.$inferSelect;
type VersionSelect = typeof outlineBlockVersions.$inferSelect;
type LinkSelect = typeof outlineLinks.$inferSelect;
type CommitSelect = typeof outlineCommits.$inferSelect;

function toBlock(row: BlockSelect): OutlineBlockRow {
	return { ...row, taskJson: row.taskJson ?? null, authorKind: row.authorKind as OutlineActorKind };
}

/**
 * `CASE outline_blocks.id WHEN … THEN … END` (the table named in full: in a select list drizzle
 * writes a column of the selected table unqualified, which a subquery would read as its own):
 * a per-block number (keys never repeat a block).
 */
function caseOf(pairs: ReadonlyArray<readonly [string, number]>): SQL {
	return sql`CASE outline_blocks.id ${sql.join(
		pairs.map(([id, n]) => sql`WHEN ${id} THEN ${n}`),
		sql` `,
	)} END`;
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

/** Columns of a structure row, positionally: id, sid, parent, order key, alias, task, seq. */
type StructureValues = [
	string,
	string,
	string | null,
	string,
	string | null,
	string | null,
	number,
];

function toStructure(row: StructureValues): OutlineStructureRow {
	return {
		id: row[0],
		sid: row[1],
		parentId: row[2],
		orderKey: row[3],
		alias: row[4],
		taskJson: row[5] ? (JSON.parse(row[5]) as OutlineTaskJson) : null,
		versionSeq: Number(row[6]),
	};
}

const STRUCTURE_CURRENT = `SELECT id, sid, parent_id, order_key, alias, task_json, version_seq
	FROM outline_blocks WHERE page_id = ? AND deleted = 0 LIMIT ? OFFSET ?`;
const STRUCTURE_AS_OF = `SELECT v.block_id, b.sid, v.parent_id, v.order_key, v.alias, v.task_json,
		v.from_seq
	FROM outline_block_versions v JOIN outline_blocks b ON b.id = v.block_id
	WHERE v.page_id = ? AND v.from_seq <= ? AND (v.to_seq IS NULL OR v.to_seq > ?) AND v.deleted = 0
	LIMIT ? OFFSET ?`;

function inlineValues(text: string, params: Array<string | number>): unknown[][] {
	return sqlite.query(text).values(...params) as unknown[][];
}

/** A read on the worker pool; inline when there is no file to open there or no worker. */
async function workerValues(
	text: string,
	params: Array<string | number>,
	maxRows: number,
): Promise<unknown[][]> {
	const file = sqlite.filename;
	if (!file || file === ":memory:" || sqlite.inTransaction) return inlineValues(text, params);
	const task: SelectRowsParams = { kind: "selectRows", sql: text, params, maxRows };
	try {
		const result = await runReadTask<SelectRowsResult>(file, task, {
			timeoutMs: WORKER_TIMEOUT_MS,
		});
		return result.rows;
	} catch (error) {
		if (error instanceof WorkersUnavailableError) return inlineValues(text, params);
		throw error;
	}
}

/**
 * At most `limit` structure rows, inline when the page is small, on the worker pool otherwise.
 * `truncated` is exact: a full worker read is followed by a one-row probe past it.
 */
async function boundedStructure(
	text: string,
	params: Array<string | number>,
	limit: number,
): Promise<{ rows: OutlineStructureRow[]; truncated: boolean }> {
	const inline = Math.min(limit, MAIN_THREAD_PAGE_ROWS);
	const first = inlineValues(text, [...params, inline + 1, 0]) as StructureValues[];
	if (first.length <= inline) return { rows: first.map(toStructure), truncated: false };
	if (limit <= inline) return { rows: first.slice(0, limit).map(toStructure), truncated: true };
	const cap = Math.min(limit, SELECT_ROWS_MAX_ROWS);
	const rows = (await workerValues(text, [...params, cap, 0], cap)) as StructureValues[];
	let truncated = false;
	if (rows.length >= cap) truncated = (await workerValues(text, [...params, 1, cap], 1)).length > 0;
	return { rows: rows.map(toStructure), truncated };
}

function validAt(
	columns: {
		fromSeq: typeof outlineBlockVersions.fromSeq;
		toSeq: typeof outlineBlockVersions.toSeq;
	},
	seq: number | null,
): SQL | undefined {
	return seq === null
		? isNull(columns.toSeq)
		: and(lte(columns.fromSeq, seq), or(isNull(columns.toSeq), gt(columns.toSeq, seq)));
}

function linkValidAt(seq: number | null): SQL | undefined {
	return seq === null
		? isNull(outlineLinks.toSeq)
		: and(
				lte(outlineLinks.fromSeq, seq),
				or(isNull(outlineLinks.toSeq), gt(outlineLinks.toSeq, seq)),
			);
}

interface RawSearchRow {
	id: string;
	space_id: string;
	sid: string;
	parent_id: string | null;
	page_id: string;
	content: string;
	alias: string | null;
	task_json: string | null;
	rank: number;
}

function toSearchRow(row: RawSearchRow): OutlineSearchRow {
	return {
		id: row.id,
		spaceId: row.space_id,
		sid: row.sid,
		parentId: row.parent_id,
		pageId: row.page_id,
		content: row.content,
		alias: row.alias,
		taskJson: row.task_json ? (JSON.parse(row.task_json) as OutlineTaskJson) : null,
		rank: Number(row.rank),
	};
}

const SEARCH_COLUMNS = `b.id AS id, b.space_id AS space_id, b.sid AS sid, b.parent_id AS parent_id,
	b.page_id AS page_id, b.content AS content, b.alias AS alias, b.task_json AS task_json`;

export const sqliteOutlineReads: OutlineReadPort = {
	async listPageStructure(pageId, { asOf, limit }) {
		return asOf === null
			? boundedStructure(STRUCTURE_CURRENT, [pageId], limit)
			: boundedStructure(STRUCTURE_AS_OF, [pageId, asOf, asOf], limit);
	},

	async listVersionsAt(blockIds, seq) {
		const out: OutlineVersionRow[] = [];
		for (const ids of chunked(blockIds)) {
			const rows = db
				.select()
				.from(outlineBlockVersions)
				.where(and(inArray(outlineBlockVersions.blockId, ids), validAt(outlineBlockVersions, seq)))
				.all();
			for (const row of rows) out.push(toVersion(row));
		}
		return out;
	},

	async listVersionContents(keys) {
		const out: Array<{ blockId: string; fromSeq: number; content: string | null }> = [];
		const largest = VERSION_KEY_SIZES[VERSION_KEY_SIZES.length - 1] as number;
		for (const chunk of chunked(keys, largest)) {
			const size = VERSION_KEY_SIZES.find((n) => n >= chunk.length) ?? largest;
			const params: Array<string | number> = [];
			for (let i = 0; i < size; i++) {
				// Padding repeats the last key; the IN list does not mind.
				const key = chunk[Math.min(i, chunk.length - 1)] as { blockId: string; fromSeq: number };
				params.push(key.blockId, key.fromSeq);
			}
			const rows = inlineValues(
				`SELECT block_id, from_seq, content FROM outline_block_versions
				 WHERE (block_id, from_seq) IN (VALUES ${Array(size).fill("(?, ?)").join(", ")})`,
				params,
			) as Array<[string, number, string | null]>;
			for (const [blockId, fromSeq, content] of rows) {
				out.push({ blockId, fromSeq: Number(fromSeq), content });
			}
		}
		return out;
	},

	async listVersionsAtSeqs(keys) {
		const out: OutlineVersionRow[] = [];
		const v = outlineBlockVersions;
		for (const chunk of chunked(keys, KEYED_CHUNK)) {
			const seqOf = new Map(chunk.map((k) => [k.blockId, k.seq]));
			const at = caseOf(chunk.map((k) => [k.blockId, k.seq]));
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
			const rows = db
				.select()
				.from(v)
				.where(sql`(${v.blockId}, ${v.fromSeq}) IN (VALUES ${pairs})`)
				.all();
			for (const row of rows) {
				const seq = seqOf.get(row.blockId) as number;
				if (row.toSeq === null || row.toSeq > seq) out.push(toVersion(row));
			}
		}
		return out;
	},

	async findLastWrites(keys, except) {
		const out: Array<{ blockId: string; fromSeq: number | null; changeFlags: number | null }> = [];
		const own = ~except.flags & 0x7fffffff;
		const anyone = ~(except.anyoneFlags ?? 0) & 0x7fffffff;
		for (const chunk of chunked(keys, LAST_WRITES_CHUNK)) {
			const after = caseOf(chunk.map((k) => [k.blockId, k.afterSeq]));
			const newer = sql`v.block_id = outline_blocks.id AND v.from_seq > ${after}`;
			// The oldest of the newest versions looked at: one lower bound for the index range
			// (with two, the engine may scan down to `afterSeq`); and whether there are more.
			const floor = sql`COALESCE((SELECT v.from_seq FROM outline_block_versions v WHERE ${newer}
				ORDER BY v.from_seq DESC LIMIT 1 OFFSET ${sql.raw(String(OUTLINE_LAST_WRITES_SCAN - 1))}), ${after} + 1)`;
			const counted = sql`FROM outline_block_versions v JOIN outline_commits c ON c.id = v.commit_id
				WHERE v.block_id = outline_blocks.id AND v.from_seq >= ${floor}
					AND NOT ((c.actor_kind = ${except.actorKind} AND c.actor_id = ${except.actorId}
						AND (v.change_flags & ${own}) = 0) OR (v.change_flags & ${anyone}) = 0)
				ORDER BY v.from_seq DESC LIMIT 1`;
			const rows = db
				.select({
					blockId: outlineBlocks.id,
					fromSeq: sql<number | null>`(SELECT v.from_seq ${counted})`,
					changeFlags: sql<number | null>`(SELECT v.change_flags ${counted})`,
					more: sql<unknown>`EXISTS (SELECT 1 FROM outline_block_versions v WHERE ${newer}
						ORDER BY v.from_seq DESC LIMIT 1 OFFSET ${sql.raw(String(OUTLINE_LAST_WRITES_SCAN))})`,
				})
				.from(outlineBlocks)
				.where(
					inArray(
						outlineBlocks.id,
						chunk.map((k) => k.blockId),
					),
				)
				.all();
			for (const row of rows) {
				if (row.fromSeq !== null)
					out.push({
						blockId: row.blockId,
						fromSeq: Number(row.fromSeq),
						changeFlags: Number(row.changeFlags),
					});
				else if (row.more === true || Number(row.more) === 1)
					out.push({ blockId: row.blockId, fromSeq: null, changeFlags: null });
			}
		}
		return out;
	},

	async listLinksAt(blockIds, seq, kinds, limit) {
		const out: OutlineLinkRow[] = [];
		if (kinds.length === 0) return out;
		for (const ids of chunked(blockIds)) {
			if (out.length >= limit) break;
			const rows = db
				.select()
				.from(outlineLinks)
				.where(
					and(
						inArray(outlineLinks.fromBlockId, ids),
						inArray(outlineLinks.kind, [...kinds]),
						linkValidAt(seq),
					),
				)
				.limit(limit - out.length)
				.all();
			for (const row of rows) out.push(toLink(row));
		}
		return out;
	},

	async listPageSeqs(pageId, { edge, before, after, limit }) {
		const v = outlineBlockVersions;
		const capped = Math.min(limit, SELECT_ROWS_MAX_ROWS);
		const query =
			edge === "from"
				? db
						.selectDistinct({ seq: v.fromSeq })
						.from(v)
						.where(and(eq(v.pageId, pageId), lt(v.fromSeq, before), gt(v.fromSeq, after)))
						.orderBy(desc(v.fromSeq))
						.limit(capped)
				: db
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
						.limit(capped);
		const rows = await readQuery<{ seq: number | null }>(query, { maxRows: capped });
		return rows.map((r) => r.seq).filter((s): s is number => s !== null);
	},

	async getCommit(id) {
		const row = db.select().from(outlineCommits).where(eq(outlineCommits.id, id)).limit(1).get();
		return row ? toCommit(row) : null;
	},

	async getCommitsBySeqs(spaceId, seqs) {
		const out: OutlineCommitRow[] = [];
		for (const chunk of chunked(seqs)) {
			const rows = db
				.select()
				.from(outlineCommits)
				.where(and(eq(outlineCommits.spaceId, spaceId), inArray(outlineCommits.seq, chunk)))
				.all();
			for (const row of rows) out.push(toCommit(row));
		}
		return out;
	},

	async listCommitVersions(commitId, limit) {
		return db
			.select()
			.from(outlineBlockVersions)
			.where(eq(outlineBlockVersions.commitId, commitId))
			.orderBy(asc(outlineBlockVersions.blockId))
			.limit(limit)
			.all()
			.map(toVersion);
	},

	async findBlocksChangedAfter(blockIds, seq, ignoreFlags) {
		const v = outlineBlockVersions;
		const out: string[] = [];
		for (const ids of chunked(blockIds)) {
			const later = db
				.select({ one: sql`1` })
				.from(v)
				.where(
					and(eq(v.blockId, outlineBlocks.id), gt(v.fromSeq, seq), ne(v.changeFlags, ignoreFlags)),
				);
			const rows = db
				.select({ id: outlineBlocks.id })
				.from(outlineBlocks)
				.where(and(inArray(outlineBlocks.id, ids), exists(later)))
				.all();
			for (const row of rows) out.push(row.id);
		}
		return out;
	},

	async getBlocks(ids) {
		const out: OutlineBlockRow[] = [];
		for (const chunk of chunked(ids)) {
			const rows = db.select().from(outlineBlocks).where(inArray(outlineBlocks.id, chunk)).all();
			for (const row of rows) out.push(toBlock(row));
		}
		return out;
	},

	async findLiveBlocks(spaceIds, by, limit) {
		const out: OutlineBlockRow[] = [];
		for (const spaces of chunked(spaceIds)) {
			if (out.length >= limit) break;
			const rows = db
				.select()
				.from(outlineBlocks)
				.where(
					and(
						inArray(outlineBlocks.spaceId, spaces),
						"sid" in by ? eq(outlineBlocks.sid, by.sid) : eq(outlineBlocks.alias, by.alias),
						// The literal lets the planner use the partial unique alias index.
						sql`${outlineBlocks.deleted} = 0`,
					),
				)
				.orderBy(asc(outlineBlocks.id))
				.limit(limit - out.length)
				.all();
			for (const row of rows) out.push(toBlock(row));
		}
		return out;
	},

	async listAliasRange(spaceId, range, limit) {
		// Text compares bytewise here; the `deleted = 0` literal lets the planner range-scan the
		// partial unique alias index.
		const rows = db
			.select({ alias: outlineBlocks.alias })
			.from(outlineBlocks)
			.where(
				and(
					eq(outlineBlocks.spaceId, spaceId),
					sql`${outlineBlocks.alias} >= ${range.from}`,
					sql`${outlineBlocks.alias} < ${range.to}`,
					sql`${outlineBlocks.deleted} = 0`,
				),
			)
			.orderBy(asc(outlineBlocks.alias))
			.limit(limit)
			.all();
		return rows.map((row) => row.alias as string);
	},

	async searchBlocks(query) {
		const out: OutlineSearchRow[] = [];
		const likes = query.short.map(() => `AND b.content LIKE ? ESCAPE '\\'`).join(" ");
		const likeParams = query.short.map((term) => escapedContains(term));
		for (const spaces of chunked(query.spaceIds, SEARCH_SPACE_CHUNK)) {
			const placeholders = spaces.map(() => "?").join(", ");
			let text: string;
			let params: Array<string | number>;
			if (query.indexed.length > 0) {
				text = `SELECT ${SEARCH_COLUMNS}, bm25(outline_blocks_fts) AS rank
					FROM outline_blocks_fts
					JOIN outline_blocks b ON b.rowid = outline_blocks_fts.rowid
					WHERE outline_blocks_fts MATCH ? AND b.deleted = 0
						AND b.space_id IN (${placeholders}) ${likes}
					ORDER BY rank, b.id LIMIT ?`;
				params = [prefixExpr(query.indexed.join(" ")), ...spaces, ...likeParams, query.limit];
			} else {
				// No term the trigram index can match: a substring scan of the spaces' blocks,
				// shortest content first.
				text = `SELECT ${SEARCH_COLUMNS}, length(b.content) AS rank
					FROM outline_blocks b
					WHERE b.deleted = 0 AND b.space_id IN (${placeholders}) ${likes}
					ORDER BY rank, b.id LIMIT ?`;
				params = [...spaces, ...likeParams, query.limit];
			}
			const rows = (await executeSqliteSearchQuery(text, params, {
				operation: "outline.search",
			})) as unknown as RawSearchRow[];
			for (const row of rows) out.push(toSearchRow(row));
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
			const rows = db
				.select()
				.from(outlineLinks)
				.where(and(target, isNull(outlineLinks.toSeq), inArray(outlineLinks.spaceId, spaces)))
				.orderBy(asc(outlineLinks.id))
				.limit(limit - out.length)
				.all();
			for (const row of rows) out.push(toLink(row));
		}
		return out;
	},

	async listSpacePages(spaceId, { after, limit }) {
		const b = outlineBlocks;
		const rows = db
			.select({
				id: b.id,
				sid: b.sid,
				orderKey: b.orderKey,
				alias: b.alias,
				contentHead: sql<string>`substr(${b.content}, 1, ${OUTLINE_PAGE_HEAD_CHARS})`,
				hasTask: sql<number>`${b.taskJson} IS NOT NULL`,
			})
			.from(b)
			.where(
				and(
					eq(b.spaceId, spaceId),
					isNull(b.parentId),
					eq(b.deleted, false),
					after
						? or(
								gt(b.orderKey, after.orderKey),
								and(eq(b.orderKey, after.orderKey), gt(b.id, after.id)),
							)
						: undefined,
				),
			)
			// SQLite compares text bytewise (BINARY), which is the order-key order.
			.orderBy(asc(b.orderKey), asc(b.id))
			.limit(limit)
			.all();
		return rows.map(({ hasTask, ...row }) => ({ ...row, isTask: Boolean(hasTask) }));
	},

	async listBlockHistory(blockId, { before, limit }) {
		const v = outlineBlockVersions;
		return db
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
			.limit(limit)
			.all();
	},
};
