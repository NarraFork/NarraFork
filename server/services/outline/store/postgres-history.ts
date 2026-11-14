/**
 * PostgreSQL implementation of `OutlineHistoryPort`, spread into the PostgreSQL outline store.
 * The same reads as `sqlite-history.ts`, with the engine's differences:
 *
 *   - order keys and ids are compared bytewise (`COLLATE "C"`) wherever their order is part of
 *     the answer (sibling order, cursors the caller sees). The backfill's own cursor (a sid) is
 *     compared in the column's collation instead, so the space-and-sid index serves it; it
 *     never leaves this backend;
 *   - a read as of a seq joins each placement to the block's version valid then with `LATERAL`,
 *     after an inner SELECT that holds the limit, which fixes the join order (the plan guard is
 *     `tests/server/services/outline/pg-outline-store.test.ts`);
 *   - a list of ids is one statement per chunk rather than one per id: every statement is a
 *     network round trip here;
 *   - the backfill holds the space's row (`FOR UPDATE`) while it writes, as a commit does, so
 *     it never places a block a concurrent commit is moving.
 */
import { withPgRetry } from "@server/db/pg-retry";
import { type SQL, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { OutlineAskJson, OutlineSpaceKind, OutlineTaskJson } from "../model";
import type {
	OutlineChangedChildRow,
	OutlineEdgeRow,
	OutlineHistoryPort,
	OutlineHistoryState,
	OutlineLevelCursor,
	OutlineLevelRow,
	OutlineSubtreeChange,
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

const NOW_COLUMNS = sql`b.id, b.sid, b.parent_id, b.order_key, b.alias, b.task_json,
	b.version_seq, b.ask_json,
	EXISTS (SELECT 1 FROM outline_blocks c
		WHERE c.space_id = b.space_id AND c.parent_id = b.id AND NOT c.deleted) AS has_children`;

/** Placements of `alias` valid at `seq`. */
const validAt = (alias: SQL, seq: number): SQL =>
	sql`${alias}.from_seq <= ${int(seq)} AND (${alias}.to_seq IS NULL OR ${alias}.to_seq > ${int(seq)})`;

/**
 * The rows of a bounded SELECT of placements `s (id, parent_key, order_key)`, each with its
 * block (inside `spaceId`) and its version valid at `seq`.
 */
function asOfRows(placements: SQL, spaceId: string, seq: number, order: SQL): SQL {
	return sql`
		SELECT s.id, b.sid,
			CASE WHEN s.parent_key = ${text(spaceId)} THEN NULL ELSE s.parent_key END AS parent_id,
			s.order_key, v.alias, v.task_json, v.from_seq AS version_seq, v.ask_json,
			EXISTS (SELECT 1 FROM outline_block_edges c
				WHERE c.parent_key = s.id AND ${validAt(sql`c`, seq)}) AS has_children
		FROM (${placements}) s
		JOIN outline_blocks b ON b.id = s.id AND b.space_id = ${text(spaceId)}
		JOIN LATERAL (
			SELECT x.alias, x.task_json, x.ask_json, x.from_seq FROM outline_block_versions x
			WHERE x.block_id = s.id AND x.from_seq <= ${int(seq)}
			ORDER BY x.from_seq DESC LIMIT 1
		) v ON true
		${order}`;
}

/** The level statement: the children of `parentKeys` as of `seq` (`null`: one parent, paged). */
export function pgLevelAsOf(
	spaceId: string,
	parentKeys: readonly string[],
	seq: number,
	after: OutlineLevelCursor | null,
	limit: number,
): SQL {
	const order = sql`ORDER BY s.parent_key COLLATE "C", s.order_key COLLATE "C", s.id COLLATE "C"`;
	return asOfRows(
		sql`SELECT e.block_id AS id, e.parent_key, e.order_key FROM outline_block_edges e
			WHERE e.parent_key IN (${idList(parentKeys)}) AND ${validAt(sql`e`, seq)}
				${
					after
						? sql`AND (e.order_key COLLATE "C", e.block_id COLLATE "C") > (${text(after.orderKey)}, ${text(after.id)})`
						: sql``
				}
			ORDER BY e.parent_key COLLATE "C", e.order_key COLLATE "C", e.block_id COLLATE "C"
			LIMIT ${int(limit)}`,
		spaceId,
		seq,
		order,
	);
}

/** The subtree statement: the blocks under `rootKey` as of `seq`, breadth first, at most `limit`. */
export function pgSubtreeAsOf(spaceId: string, rootKey: string, seq: number, limit: number): SQL {
	return sql`
		WITH RECURSIVE sub(id, parent_key, order_key, depth) AS (
			SELECT e.block_id, e.parent_key, e.order_key, 0 FROM outline_block_edges e
			WHERE e.parent_key = ${text(rootKey)} AND ${validAt(sql`e`, seq)}
			UNION ALL
			SELECT e.block_id, e.parent_key, e.order_key, sub.depth + 1
			FROM sub JOIN outline_block_edges e ON e.parent_key = sub.id AND ${validAt(sql`e`, seq)}
		)
		${asOfRows(
			sql`SELECT id, parent_key, order_key, depth FROM sub LIMIT ${int(limit)}`,
			spaceId,
			seq,
			sql`ORDER BY s.depth`,
		)}`;
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

	const levelNow = (
		spaceId: string,
		parentIds: readonly (string | null)[],
		after: OutlineLevelCursor | null,
		limit: number,
	): Promise<LevelRecord[]> => {
		const ids = parentIds.filter((id): id is string => id !== null);
		const top = ids.length < parentIds.length;
		const parents =
			ids.length === 0
				? sql`b.parent_id IS NULL`
				: top
					? sql`(b.parent_id IS NULL OR b.parent_id IN (${idList(ids)}))`
					: sql`b.parent_id IN (${idList(ids)})`;
		return rowsOf<LevelRecord>(sql`
			SELECT ${NOW_COLUMNS} FROM outline_blocks b
			WHERE b.space_id = ${text(spaceId)} AND ${parents} AND NOT b.deleted
				${
					after
						? sql`AND (b.order_key COLLATE "C", b.id COLLATE "C") > (${text(after.orderKey)}, ${text(after.id)})`
						: sql``
				}
			ORDER BY b.parent_id COLLATE "C" NULLS FIRST, b.order_key COLLATE "C", b.id COLLATE "C"
			LIMIT ${int(limit)}
		`);
	};

	const level = (
		spaceId: string,
		parentIds: readonly (string | null)[],
		asOf: number | null,
		after: OutlineLevelCursor | null,
		limit: number,
	): Promise<LevelRecord[]> =>
		asOf === null
			? levelNow(spaceId, parentIds, after, limit)
			: rowsOf<LevelRecord>(
					pgLevelAsOf(
						spaceId,
						parentIds.map((id) => id ?? spaceId),
						asOf,
						after,
						limit,
					),
				);

	return {
		async listLevel(spaceId, parentId, { asOf, after, limit }) {
			const max = Math.max(0, Math.floor(limit));
			const rows = (await level(spaceId, [parentId], asOf, after ?? null, max + 1)).map(toLevel);
			if (rows.length <= max) return { rows, next: null };
			const kept = rows.slice(0, max);
			const last = kept.at(-1);
			return { rows: kept, next: last ? { orderKey: last.orderKey, id: last.id } : null };
		},

		async listLevels(spaceId, parentIds, { asOf, limit }) {
			const max = Math.max(0, Math.floor(limit));
			const rows: OutlineLevelRow[] = [];
			for (const chunk of chunked([...new Set(parentIds)])) {
				const found = await level(spaceId, chunk, asOf, null, max - rows.length + 1);
				for (const row of found) rows.push(toLevel(row));
				if (rows.length > max) return { rows: rows.slice(0, max), truncated: true };
			}
			return { rows, truncated: false };
		},

		async listSubtreeAt(spaceId, rootId, { asOf, limit }) {
			const max = Math.max(0, Math.floor(limit));
			const root = rootId === null ? sql`b.parent_id IS NULL` : sql`b.parent_id = ${text(rootId)}`;
			const found =
				asOf === null
					? await rowsOf<LevelRecord>(sql`
						WITH RECURSIVE sub(id, sid, parent_id, order_key, alias, task_json, version_seq,
							ask_json, depth) AS (
							SELECT b.id, b.sid, b.parent_id, b.order_key, b.alias, b.task_json,
								b.version_seq, b.ask_json, 0
							FROM outline_blocks b
							WHERE b.space_id = ${text(spaceId)} AND ${root} AND NOT b.deleted
							UNION ALL
							SELECT b.id, b.sid, b.parent_id, b.order_key, b.alias, b.task_json,
								b.version_seq, b.ask_json, sub.depth + 1
							FROM sub JOIN outline_blocks b
								ON b.space_id = ${text(spaceId)} AND b.parent_id = sub.id AND NOT b.deleted
						)
						SELECT s.*, EXISTS (SELECT 1 FROM outline_blocks c
							WHERE c.space_id = ${text(spaceId)} AND c.parent_id = s.id AND NOT c.deleted)
							AS has_children
						FROM (SELECT * FROM sub LIMIT ${int(max + 1)}) s
						ORDER BY s.depth
					`)
					: await rowsOf<LevelRecord>(pgSubtreeAsOf(spaceId, rootId ?? spaceId, asOf, max + 1));
			return { rows: found.slice(0, max).map(toLevel), truncated: found.length > max };
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
