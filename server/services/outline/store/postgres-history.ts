/**
 * PostgreSQL implementation of `OutlineHistoryPort`, spread into the PostgreSQL outline store.
 * The same reads as `sqlite-history.ts`, with the engine's differences:
 *
 *   - order keys and ids are compared bytewise (`COLLATE "C"`) wherever their order is part of
 *     the answer (sibling order, cursors the caller sees). The backfill's own cursor (a sid) is
 *     compared in the column's collation instead, so the space-and-sid index serves it; it
 *     never leaves this backend;
 *   - JOIN ORDER IS PINNED WITH `LATERAL`. A level takes its parents from a `VALUES` list and,
 *     for each, the children in a `LATERAL` subquery with its own `LIMIT`; then each row's
 *     block, version and "has children" in further `LATERAL`s. A `LATERAL` can only be the
 *     inner side of a nested loop, so the rows come parent by parent, in sibling order, and the
 *     outer `LIMIT` stops the statement at the first parent that fills it. The one recursive
 *     statement (up the parents, for a commit's change marks) reaches the next row through a
 *     `LATERAL` with `OFFSET 0`, which the planner does not flatten: left to itself it has
 *     planned a recursive step as a hash join over a sequential scan of the whole table, once
 *     per level (seen on 20,000 analyzed blocks). The plan guard is
 *     `tests/server/services/outline/pg-outline-store.test.ts`;
 *   - a list of ids is one statement per chunk rather than one per id: every statement is a
 *     network round trip here;
 *   - the backfill holds the space's row (`FOR UPDATE`) while it writes, as a commit does, so
 *     it never places a block a concurrent commit is moving.
 */
import { withPgRetry } from "@server/db/pg-retry";
import { type SQL, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { OutlineAskJson, OutlineSpaceKind, OutlineTaskJson } from "../model";
import {
	type OutlineChangedChildRow,
	type OutlineEdgeRow,
	type OutlineHistoryPort,
	type OutlineHistoryState,
	type OutlineLevelCursor,
	type OutlineLevelRow,
	type OutlineSubtreeChange,
	readSubtreeByLevels,
} from "./history-port";
import { chunked, type OutlineSpaceRow } from "./port";

type PgTransaction = Parameters<Parameters<BunSQLDatabase["transaction"]>[0]>[0];

interface LevelRecord {
	id: string;
	sid: string;
	parent_id: string | null;
	order_key: string;
	alias: string | null;
	task_json: string | null;
	version_seq: number | string;
	ask_json: string | null;
	has_children: boolean;
}

function toLevel(row: LevelRecord): OutlineLevelRow {
	return {
		id: row.id,
		sid: row.sid,
		parentId: row.parent_id,
		orderKey: row.order_key,
		alias: row.alias,
		taskJson: row.task_json ? (JSON.parse(row.task_json) as OutlineTaskJson) : null,
		versionSeq: Number(row.version_seq),
		askJson: row.ask_json ? (JSON.parse(row.ask_json) as OutlineAskJson) : null,
		hasChildren: row.has_children === true,
	};
}

function idList(ids: readonly string[]): SQL {
	return sql.join(
		ids.map((id) => sql`${id}`),
		sql`, `,
	);
}

const int = (value: number): SQL => sql`CAST(${value} AS integer)`;
const text = (value: string): SQL => sql`CAST(${value} AS text)`;

/** Placements of `alias` valid at `seq`. */
const validAt = (alias: SQL, seq: number): SQL =>
	sql`${alias}.from_seq <= ${int(seq)} AND (${alias}.to_seq IS NULL OR ${alias}.to_seq > ${int(seq)})`;

/** `(VALUES (key, 1), (key, 2), …)`: the parents of a level read, in the order asked. */
function parentList(keys: readonly string[]): SQL {
	return sql`(VALUES ${sql.join(
		keys.map((key, i) => sql`(${text(key)}, ${int(i)})`),
		sql`, `,
	)})`;
}

const afterCursor = (orderKey: SQL, id: SQL, after: OutlineLevelCursor | null): SQL =>
	after
		? sql`AND (${orderKey} COLLATE "C", ${id} COLLATE "C") > (${text(after.orderKey)}, ${text(after.id)})`
		: sql``;

/**
 * The level statement as of a seq: the children of `parentKeys` (a block's id, or the space's
 * for the top level), parent by parent in the order given, each parent's in sibling order
 * (after `after`: one parent, paged), at most `limit` rows in all. Each row comes with its
 * block (inside `spaceId`), its version valid at `seq` and whether it had children then.
 */
export function pgLevelAsOf(
	spaceId: string,
	parentKeys: readonly string[],
	seq: number,
	after: OutlineLevelCursor | null,
	limit: number,
): SQL {
	return sql`
		SELECT s.id, b.sid,
			CASE WHEN s.parent_key = ${text(spaceId)} THEN NULL ELSE s.parent_key END AS parent_id,
			s.order_key, v.alias, v.task_json, v.from_seq AS version_seq, v.ask_json,
			k.yes IS NOT NULL AS has_children
		FROM (
			SELECT e.id, e.parent_key, e.order_key
			FROM ${parentList(parentKeys)} p(key, ord)
			CROSS JOIN LATERAL (
				SELECT c.block_id AS id, c.parent_key, c.order_key FROM outline_block_edges c
				WHERE c.parent_key = p.key AND ${validAt(sql`c`, seq)}
					${afterCursor(sql`c.order_key`, sql`c.block_id`, after)}
				ORDER BY c.order_key COLLATE "C", c.block_id COLLATE "C" LIMIT ${int(limit)}
			) e
			LIMIT ${int(limit)}
		) s
		JOIN LATERAL (
			SELECT y.sid FROM outline_blocks y
			WHERE y.id = s.id AND y.space_id = ${text(spaceId)} OFFSET 0
		) b ON true
		JOIN LATERAL (
			SELECT x.alias, x.task_json, x.ask_json, x.from_seq FROM outline_block_versions x
			WHERE x.block_id = s.id AND x.from_seq <= ${int(seq)}
			ORDER BY x.from_seq DESC LIMIT 1
		) v ON true
		LEFT JOIN LATERAL (
			SELECT 1 AS yes FROM outline_block_edges c
			WHERE c.parent_key = s.id AND ${validAt(sql`c`, seq)} LIMIT 1
		) k ON true`;
}

/**
 * The level statement for now: the live children of `parentIds` (`null`: the space's top
 * level, alone), read from the blocks' children index, in the same shape as
 * {@link pgLevelAsOf}. The child probe runs for the rows of the page only.
 */
export function pgLevelNow(
	spaceId: string,
	parentIds: readonly string[] | null,
	after: OutlineLevelCursor | null,
	limit: number,
): SQL {
	const columns = sql`c.id, c.sid, c.parent_id, c.order_key, c.alias, c.task_json, c.version_seq,
		c.ask_json`;
	const page = (parent: SQL): SQL => sql`
		SELECT ${columns} FROM outline_blocks c
		WHERE c.space_id = ${text(spaceId)} AND ${parent} AND NOT c.deleted
			${afterCursor(sql`c.order_key`, sql`c.id`, after)}
		ORDER BY c.order_key COLLATE "C", c.id COLLATE "C" LIMIT ${int(limit)}`;
	const rows =
		parentIds === null
			? page(sql`c.parent_id IS NULL`)
			: sql`SELECT e.* FROM ${parentList(parentIds)} p(key, ord)
				CROSS JOIN LATERAL (${page(sql`c.parent_id = p.key`)}) e
				LIMIT ${int(limit)}`;
	return sql`
		SELECT b.id, b.sid, b.parent_id, b.order_key, b.alias, b.task_json, b.version_seq,
			b.ask_json, k.yes IS NOT NULL AS has_children
		FROM (${rows}) b
		LEFT JOIN LATERAL (
			SELECT 1 AS yes FROM outline_blocks c
			WHERE c.space_id = ${text(spaceId)} AND c.parent_id = b.id AND NOT c.deleted LIMIT 1
		) k ON true`;
}

/**
 * The commit's change marks (`postgres-store.ts` runs it inside the commit's section): every
 * ancestor of `ids`, as the tree is when it runs, marked at `seq`; ancestors marked at `seq`
 * already are left out before the limit. The same statement as SQLite's
 * (`sqliteMarkAncestorsSql`), the step up fenced as the header says.
 */
export function pgMarkAncestorsSql(ids: readonly string[], seq: number, limit: number): SQL {
	return sql`
		WITH RECURSIVE up(id) AS (
			SELECT parent_id FROM outline_blocks
			WHERE id IN (${idList(ids)}) AND parent_id IS NOT NULL
			UNION
			SELECT b.parent_id FROM up CROSS JOIN LATERAL (
				SELECT y.parent_id FROM outline_blocks y WHERE y.id = up.id OFFSET 0
			) b
			WHERE b.parent_id IS NOT NULL
		)
		INSERT INTO outline_subtree_changes (ancestor_id, seq)
		SELECT up.id, ${int(seq)} FROM up
		WHERE NOT EXISTS (SELECT 1 FROM outline_subtree_changes m
			WHERE m.ancestor_id = up.id AND m.seq = ${int(seq)})
		LIMIT ${int(limit)}
		RETURNING 1`;
}

interface SpaceRecord {
	id: string;
	key: string;
	kind: string;
	project_id: string | null;
	narrator_id: string | null;
	owner_user_id: string | null;
	next_seq: number | string;
	created_at: string;
	in_process_epoch: number | string;
}

async function backfillSection(
	tx: PgTransaction,
	spaceId: string,
	afterSid: string | null,
	max: number,
): Promise<{ scanned: number; inserted: number; nextSid: string | null }> {
	// The space's row, as a commit holds it: no commit of the space lands inside this section.
	await tx.execute(sql`SELECT id FROM outline_spaces WHERE id = ${text(spaceId)} FOR UPDATE`);
	const from = afterSid ?? "";
	const sids = (await tx.execute(sql`
		SELECT sid FROM outline_blocks
		WHERE space_id = ${text(spaceId)} AND sid > ${text(from)}
		ORDER BY sid LIMIT ${int(max)}
	`)) as unknown as Array<{ sid: string }>;
	const last = sids.at(-1)?.sid;
	if (last === undefined) return { scanned: 0, inserted: 0, nextSid: null };
	const inserted = (await tx.execute(sql`
		INSERT INTO outline_block_edges (parent_key, block_id, from_seq, to_seq, order_key)
		SELECT COALESCE(b.parent_id, b.space_id), b.id, 0, NULL, b.order_key
		FROM outline_blocks b
		WHERE b.space_id = ${text(spaceId)} AND b.sid > ${text(from)} AND b.sid <= ${text(last)}
			AND NOT b.deleted
			AND NOT EXISTS (SELECT 1 FROM outline_block_edges e
				WHERE e.block_id = b.id AND e.to_seq IS NULL)
		RETURNING 1
	`)) as unknown as unknown[];
	return {
		scanned: sids.length,
		inserted: inserted.length,
		nextSid: sids.length < max ? null : last,
	};
}

export function createPostgresOutlineHistory(db: BunSQLDatabase): OutlineHistoryPort {
	const rowsOf = async <T>(query: SQL): Promise<T[]> => [
		...((await db.execute(query)) as unknown as T[]),
	];

	/**
	 * The children of several parents (`null`: the top level), parent by parent, at most
	 * `limit` rows in all: one statement per 500 parents, each stopping at what is left.
	 */
	const levels = async (
		spaceId: string,
		parentIds: readonly (string | null)[],
		asOf: number | null,
		after: OutlineLevelCursor | null,
		limit: number,
	): Promise<OutlineLevelRow[]> => {
		const rows: OutlineLevelRow[] = [];
		const read = async (statement: SQL) => {
			for (const row of await rowsOf<LevelRecord>(statement)) rows.push(toLevel(row));
		};
		const distinct = [...new Set(parentIds)];
		if (asOf !== null) {
			for (const chunk of chunked(distinct.map((id) => id ?? spaceId))) {
				if (rows.length >= limit) break;
				await read(pgLevelAsOf(spaceId, chunk, asOf, after, limit - rows.length));
			}
			return rows;
		}
		if (distinct.includes(null)) await read(pgLevelNow(spaceId, null, after, limit));
		for (const chunk of chunked(distinct.filter((id): id is string => id !== null))) {
			if (rows.length >= limit) break;
			await read(pgLevelNow(spaceId, chunk, after, limit - rows.length));
		}
		return rows;
	};

	return {
		async listLevel(spaceId, parentId, { asOf, after, limit }) {
			const max = Math.max(0, Math.floor(limit));
			const rows = await levels(spaceId, [parentId], asOf, after ?? null, max + 1);
			if (rows.length <= max) return { rows, next: null };
			const kept = rows.slice(0, max);
			const last = kept.at(-1);
			return { rows: kept, next: last ? { orderKey: last.orderKey, id: last.id } : null };
		},

		async listLevels(spaceId, parentIds, { asOf, limit }) {
			const max = Math.max(0, Math.floor(limit));
			const rows = await levels(spaceId, parentIds, asOf, null, max + 1);
			return { rows: rows.slice(0, max), truncated: rows.length > max };
		},

		async listSubtreeAt(spaceId, rootId, { asOf, limit }) {
			return readSubtreeByLevels(
				(parentIds, room) => levels(spaceId, parentIds, asOf, null, room),
				rootId,
				limit,
			);
		},

		async getPlacementsAt(blockIds, asOf) {
			const out: OutlineEdgeRow[] = [];
			for (const ids of chunked([...new Set(blockIds)])) {
				const rows = await rowsOf<{
					parent_key: string;
					block_id: string;
					from_seq: number | string;
					to_seq: number | string | null;
					order_key: string;
				}>(sql`
					SELECT e.parent_key, e.block_id, e.from_seq, e.to_seq, e.order_key
					FROM outline_block_edges e
					WHERE e.block_id IN (${idList(ids)})
						AND ${asOf === null ? sql`e.to_seq IS NULL` : validAt(sql`e`, asOf)}
				`);
				for (const row of rows) {
					out.push({
						parentKey: row.parent_key,
						blockId: row.block_id,
						fromSeq: Number(row.from_seq),
						toSeq: row.to_seq === null ? null : Number(row.to_seq),
						orderKey: row.order_key,
					});
				}
			}
			return out;
		},

		async findSubtreeChanges(blockIds, { after, upTo }) {
			const out: OutlineSubtreeChange[] = [];
			if (upTo <= after) return out;
			for (const ids of chunked([...new Set(blockIds)])) {
				const rows = await rowsOf<{ id: string; self: boolean; below: boolean }>(sql`
					SELECT b.id,
						EXISTS (SELECT 1 FROM outline_block_versions v WHERE v.block_id = b.id
							AND v.from_seq > ${int(after)} AND v.from_seq <= ${int(upTo)}) AS self,
						EXISTS (SELECT 1 FROM outline_subtree_changes t WHERE t.ancestor_id = b.id
							AND t.seq > ${int(after)} AND t.seq <= ${int(upTo)}) AS below
					FROM outline_blocks b WHERE b.id IN (${idList(ids)})
				`);
				for (const row of rows) {
					if (row.self || row.below)
						out.push({ blockId: row.id, self: row.self === true, below: row.below === true });
				}
			}
			return out;
		},

		async listChangedChildren(spaceId, parentId, { after, upTo, cursor, limit }) {
			const max = Math.max(0, Math.floor(limit));
			if (upTo <= after) return { rows: [], next: null };
			const parentKey = parentId ?? spaceId;
			const found = await rowsOf<{
				block_id: string;
				from_seq: number | string;
				to_seq: number | string | null;
				order_key: string;
				self: boolean;
				below: boolean;
			}>(sql`
				SELECT block_id, from_seq, to_seq, order_key, self, below FROM (
					SELECT e.block_id, e.from_seq, e.to_seq, e.order_key,
						EXISTS (SELECT 1 FROM outline_block_versions v WHERE v.block_id = e.block_id
							AND v.from_seq > ${int(after)} AND v.from_seq <= ${int(upTo)}) AS self,
						EXISTS (SELECT 1 FROM outline_subtree_changes t
							WHERE t.ancestor_id = e.block_id
							AND t.seq > ${int(after)} AND t.seq <= ${int(upTo)}) AS below
					FROM outline_block_edges e
					WHERE e.parent_key = ${text(parentKey)} AND e.from_seq <= ${int(upTo)}
						AND (e.to_seq IS NULL OR e.to_seq > ${int(after)})
						${
							cursor
								? sql`AND (e.block_id COLLATE "C", e.from_seq) > (${text(cursor.blockId)}, ${int(cursor.fromSeq)})`
								: sql``
						}
						AND (${text(parentKey)} = ${text(spaceId)} OR EXISTS (SELECT 1 FROM outline_blocks p
							WHERE p.id = ${text(parentKey)} AND p.space_id = ${text(spaceId)}))
				) changed
				WHERE self OR below OR from_seq > ${int(after)}
					OR (to_seq IS NOT NULL AND to_seq <= ${int(upTo)})
				ORDER BY block_id COLLATE "C", from_seq LIMIT ${int(max + 1)}
			`);
			const rows: OutlineChangedChildRow[] = found.slice(0, max).map((row) => ({
				blockId: row.block_id,
				fromSeq: Number(row.from_seq),
				toSeq: row.to_seq === null ? null : Number(row.to_seq),
				orderKey: row.order_key,
				self: row.self === true,
				below: row.below === true,
			}));
			const last = rows.at(-1);
			return {
				rows,
				next: found.length > max && last ? { blockId: last.blockId, fromSeq: last.fromSeq } : null,
			};
		},

		async listSubtreeChangeSeqs(blockId, { before, after, limit }) {
			const rows = await rowsOf<{ seq: number | string }>(sql`
				SELECT seq FROM outline_subtree_changes
				WHERE ancestor_id = ${text(blockId)}
					${before === null || before === undefined ? sql`` : sql`AND seq < ${int(before)}`}
					AND seq > ${int(after ?? -1)}
				ORDER BY seq DESC LIMIT ${int(Math.max(0, Math.floor(limit)))}
			`);
			return rows.map((row) => Number(row.seq));
		},

		async getHistoryStates(spaceIds) {
			const out = new Map<string, OutlineHistoryState>();
			for (const ids of chunked([...new Set(spaceIds)])) {
				const rows = await rowsOf<{
					id: string;
					history_floor_seq: number | string;
					edges_ready: boolean;
				}>(sql`
					SELECT id, history_floor_seq, edges_ready FROM outline_spaces
					WHERE id IN (${idList(ids)})
				`);
				for (const row of rows) {
					out.set(row.id, {
						floorSeq: Number(row.history_floor_seq),
						edgesReady: row.edges_ready === true,
					});
				}
			}
			return out;
		},

		async listSpacesPendingEdges({ after, limit }) {
			const rows = await rowsOf<SpaceRecord>(sql`
				SELECT id, key, kind, project_id, narrator_id, owner_user_id, next_seq, created_at,
					in_process_epoch
				FROM outline_spaces
				WHERE edges_ready = FALSE
					${after ? sql`AND id COLLATE "C" > ${text(after)}` : sql``}
				ORDER BY id COLLATE "C" LIMIT ${int(Math.max(0, Math.floor(limit)))}
			`);
			return rows.map(
				(row): OutlineSpaceRow => ({
					id: row.id,
					key: row.key,
					kind: row.kind as OutlineSpaceKind,
					projectId: row.project_id,
					narratorId: row.narrator_id,
					ownerUserId: row.owner_user_id,
					nextSeq: Number(row.next_seq),
					createdAt: row.created_at,
					inProcessEpoch: Number(row.in_process_epoch),
				}),
			);
		},

		async backfillEdges(spaceId, { afterSid, limit }) {
			const max = Math.max(1, Math.floor(limit));
			return await withPgRetry(
				() => db.transaction((tx) => backfillSection(tx, spaceId, afterSid, max)),
				{ label: "outline.backfillEdges" },
			);
		},

		async finishEdgeBackfill(spaceId) {
			const rows = await rowsOf<{ history_floor_seq: number | string }>(sql`
				UPDATE outline_spaces SET edges_ready = TRUE, history_floor_seq = next_seq - 1
				WHERE id = ${text(spaceId)} AND edges_ready = FALSE
				RETURNING history_floor_seq
			`);
			const first = rows[0];
			return first ? Number(first.history_floor_seq) : null;
		},
	};
}
