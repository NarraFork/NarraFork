/**
 * SQLite implementation of `OutlineHistoryPort` (reads by placement and by change mark, and the
 * placement conversion's writes), spread into `sqliteOutlineStore`.
 *
 * Every read is plain SQL on a cached statement of the connection: one indexed statement with a
 * limit, or one per id of a bounded list (a statement per id costs an index seek here, and
 * needs no sort across ids). All of them run inline: each is bounded by its limit and by the
 * placements of the parents it names, not by the size of a subtree or the number of text
 * versions under it.
 *
 * JOIN ORDER IS PINNED. A level as of a seq is "the placements valid then, each joined to the
 * block's version valid then". Left to itself the planner has turned that round
 * (scan the versions, probe the placements), which is 10 to 20 times slower; so the placements
 * are an inner SELECT with the limit, and the joins after it are `CROSS JOIN`s, which SQLite
 * never reorders. `__tests__/history-plan.guard.test.ts` reads the plans.
 *
 * The statements are exported (text only) for that guard, and the port is built by
 * {@link createSqliteOutlineHistory} from a database handle so the upgrade test can run the
 * conversion against a database file of its own.
 */
import type { Database } from "bun:sqlite";
import { sqlite } from "../../../db";
import type { OutlineAskJson, OutlineSpaceKind, OutlineTaskJson } from "../model";
import {
	assertHistoryReadable,
	type OutlineChangedChildRow,
	type OutlineEdgeRow,
	type OutlineHistoryPort,
	type OutlineHistoryState,
	type OutlineLevelCursor,
	type OutlineLevelRow,
	type OutlineSubtreeChange,
	pageChangedChildren,
	readSubtreeByLevels,
} from "./history-port";
import { chunked, type OutlineSpaceRow } from "./port";

type Param = string | number | null;

/** Positionally: id, sid, parent, order key, alias, task, version seq, ask, has children. */
type LevelValues = [
	string,
	string,
	string | null,
	string,
	string | null,
	string | null,
	number,
	string | null,
	number,
];

function toLevel(row: LevelValues): OutlineLevelRow {
	return {
		id: row[0],
		sid: row[1],
		parentId: row[2],
		orderKey: row[3],
		alias: row[4],
		taskJson: row[5] ? (JSON.parse(row[5]) as OutlineTaskJson) : null,
		versionSeq: Number(row[6]),
		askJson: row[7] ? (JSON.parse(row[7]) as OutlineAskJson) : null,
		hasChildren: Number(row[8]) !== 0,
	};
}

const NOW_COLUMNS = `b.id, b.sid, b.parent_id, b.order_key, b.alias, b.task_json, b.version_seq,
		b.ask_json,
		EXISTS (SELECT 1 FROM outline_blocks c
			WHERE c.space_id = b.space_id AND c.parent_id = b.id AND c.deleted = 0)`;

const levelNow = (parent: string) => `SELECT ${NOW_COLUMNS}
	FROM outline_blocks b
	WHERE b.space_id = ?1 AND ${parent} AND b.deleted = 0 AND (b.order_key, b.id) > (?3, ?4)
	ORDER BY b.order_key, b.id LIMIT ?5`;

/** The live children of a block now; `?2` is the parent. */
export const SQLITE_LEVEL_NOW = levelNow("b.parent_id = ?2");
/** The live top-level blocks of a space now (`?2` is unused, bound to null). */
export const SQLITE_LEVEL_NOW_TOP = levelNow("b.parent_id IS NULL AND ?2 IS NULL");

/**
 * What follows a bounded SELECT of placements named `s (id, parent_key, order_key)`: the
 * block (for its sid, and to keep the read inside the space `?1`) and its version valid at
 * `?3`, in that order, by primary key. `?1` is the space, `?3` the seq.
 */
const AS_OF_JOINS = `CROSS JOIN outline_blocks b ON b.id = s.id AND b.space_id = ?1
	CROSS JOIN outline_block_versions v ON v.block_id = s.id
		AND v.from_seq = (SELECT max(x.from_seq) FROM outline_block_versions x
			WHERE x.block_id = s.id AND x.from_seq <= ?3)`;

/**
 * The placements under the parent key `parent` valid at the seq `at`, as two reads that never
 * look at a child that left at or before `at`: the children still there (in sibling order, so
 * a limit stops the read), and those that left after `at`. `INDEXED BY` pins each to its index:
 * the statement fails to prepare rather than fall back to scanning everything the parent held.
 */
const OPEN = (parent: string, at: string) =>
	`outline_block_edges e INDEXED BY idx_outline_edges_open
		WHERE e.parent_key = ${parent} AND e.to_seq IS NULL AND e.from_seq <= ${at}`;
const CLOSED = (parent: string, at: string, from: string) =>
	`outline_block_edges e INDEXED BY idx_outline_edges_closed
		WHERE e.parent_key = ${parent} AND e.to_seq > ${at} AND e.from_seq <= ${from}`;

const HAD_CHILDREN = `(EXISTS (SELECT 1 FROM ${OPEN("s.id", "?3")})
			OR EXISTS (SELECT 1 FROM ${CLOSED("s.id", "?3", "?3")}))`;

const AS_OF_COLUMNS = `s.id, b.sid, CASE WHEN s.parent_key = ?1 THEN NULL ELSE s.parent_key END,
		s.order_key, v.alias, v.task_json, v.from_seq, v.ask_json, ${HAD_CHILDREN}`;

const LEVEL_PART = (source: string) =>
	`SELECT * FROM (SELECT e.block_id AS id, e.parent_key, e.order_key FROM ${source}
			AND (e.order_key, e.block_id) > (?4, ?5)
		ORDER BY e.order_key, e.block_id LIMIT ?6)`;

/**
 * The children of the parent key `?2` (a block's id, or the space's) as of `?3`, after the
 * cursor `(?4, ?5)`, at most `?6`: the first `?6` of each of the two reads, merged.
 */
export const SQLITE_LEVEL_AS_OF = `SELECT ${AS_OF_COLUMNS}
	FROM (SELECT id, parent_key, order_key FROM (
			${LEVEL_PART(OPEN("?2", "?3"))}
			UNION ALL
			${LEVEL_PART(CLOSED("?2", "?3", "?3"))})
		ORDER BY order_key, id LIMIT ?6) s
	${AS_OF_JOINS}
	ORDER BY s.order_key, s.id`;

const IN_SPACE = (block: string, space: string) =>
	`EXISTS (SELECT 1 FROM outline_blocks p WHERE p.id = ${block} AND p.space_id = ${space})`;

/** Where the block `?1` of the space `?3` sat as of `?2`. */
export const SQLITE_PLACEMENT_AS_OF = `SELECT parent_key, block_id, from_seq, to_seq, order_key
	FROM outline_block_edges
	WHERE block_id = ?1 AND from_seq <= ?2 AND (to_seq IS NULL OR to_seq > ?2)
		AND ${IN_SPACE("?1", "?3")}
	ORDER BY from_seq DESC LIMIT 1`;
/** Where the block `?1` of the space `?2` sits now. */
export const SQLITE_PLACEMENT_NOW = `SELECT parent_key, block_id, from_seq, to_seq, order_key
	FROM outline_block_edges
	WHERE block_id = ?1 AND to_seq IS NULL AND ${IN_SPACE("?1", "?2")} LIMIT 1`;

const SELF_CHANGED = (id: string, after: string, upTo: string) =>
	`EXISTS (SELECT 1 FROM outline_block_versions v
		WHERE v.block_id = ${id} AND v.from_seq > ${after} AND v.from_seq <= ${upTo})`;
const BELOW_CHANGED = (id: string, after: string, upTo: string) =>
	`EXISTS (SELECT 1 FROM outline_subtree_changes t
		WHERE t.ancestor_id = ${id} AND t.seq > ${after} AND t.seq <= ${upTo})`;

/**
 * Whether the block `?1` of the space `?4`, or anything that was under it, changed in
 * `(?2, ?3]`; no row for a block of another space.
 */
export const SQLITE_SUBTREE_CHANGE = `SELECT ${SELF_CHANGED("?1", "?2", "?3")},
	${BELOW_CHANGED("?1", "?2", "?3")} WHERE ${IN_SPACE("?1", "?4")}`;

const CHANGED_COLUMNS = `e.block_id, e.from_seq, e.to_seq, e.order_key,
		${SELF_CHANGED("e.block_id", "?3", "?4")}, ${BELOW_CHANGED("e.block_id", "?3", "?4")}`;
const CHANGED = `${SELF_CHANGED("e.block_id", "?3", "?4")}
			OR ${BELOW_CHANGED("e.block_id", "?3", "?4")}`;
/** A parent that is not the space `?1` itself must be a block of it. */
const PARENT_IN_SPACE = `(?2 = ?1 OR ${IN_SPACE("?2", "?1")})`;

/**
 * The children still under the parent key `?2` that differ between the ends of `(?3, ?4]`
 * (they arrived in it, changed, or something under them did), in sibling order after the
 * cursor `(?5, ?6)`, at most `?7`. One statement, no subquery: it reads the open placements in
 * their index's order and stops at the limit.
 */
export const SQLITE_CHANGED_CHILDREN_OPEN = `SELECT ${CHANGED_COLUMNS}
	FROM ${OPEN("?2", "?4")}
		AND (e.order_key, e.block_id) > (?5, ?6) AND ${PARENT_IN_SPACE}
		AND (e.from_seq > ?3 OR ${CHANGED})
	ORDER BY e.order_key, e.block_id LIMIT ?7`;

/**
 * The children that left the parent key `?2` after `?3` and were there by `?4`, in the order
 * they left, after the cursor `(?5, ?6, ?8, ?9)` (to seq, from seq, order key, block id), at
 * most `?7`. The cursor of a first read is `(?3, the largest integer, '', '')`.
 */
export const SQLITE_CHANGED_CHILDREN_CLOSED = `SELECT ${CHANGED_COLUMNS}
	FROM outline_block_edges e INDEXED BY idx_outline_edges_closed
	WHERE e.parent_key = ?2 AND e.to_seq IS NOT NULL
		AND (e.to_seq, e.from_seq, e.order_key, e.block_id) > (?5, ?6, ?8, ?9)
		AND e.from_seq <= ?4 AND ${PARENT_IN_SPACE}
		AND (e.from_seq > ?3 OR e.to_seq <= ?4 OR ${CHANGED})
	ORDER BY e.to_seq, e.from_seq, e.order_key, e.block_id LIMIT ?7`;

/**
 * Seqs of the commits that changed anything under the block `?1` of the space `?5`, in
 * `?3 < seq < ?2`.
 */
export const SQLITE_SUBTREE_CHANGE_SEQS = `SELECT seq FROM outline_subtree_changes
	WHERE ancestor_id = ?1 AND seq < ?2 AND seq > ?3 AND ${IN_SPACE("?1", "?5")}
	ORDER BY seq DESC LIMIT ?4`;

/** The next sids of a space after `?2`, in sid order (the space-and-sid unique index). */
export const SQLITE_BACKFILL_SCAN = `SELECT sid FROM outline_blocks
	WHERE space_id = ?1 AND sid > ?2 ORDER BY sid LIMIT ?3`;
/** An open placement for every live block of the space `?1` with a sid in `(?2, ?3]` that has none. */
export const SQLITE_BACKFILL_INSERT = `INSERT INTO outline_block_edges
		(parent_key, block_id, from_seq, to_seq, order_key)
	SELECT COALESCE(b.parent_id, b.space_id), b.id, 0, NULL, b.order_key
	FROM outline_blocks b
	WHERE b.space_id = ?1 AND b.sid > ?2 AND b.sid <= ?3 AND b.deleted = 0
		AND NOT EXISTS (SELECT 1 FROM outline_block_edges e
			WHERE e.block_id = b.id AND e.to_seq IS NULL)`;

/**
 * The commit's change marks (`sqlite-store.ts` runs it inside the commit's section): every
 * ancestor of the blocks whose ids stand at {@link SQLITE_IDS_SLOT}, as the tree is when it
 * runs, marked at `seq`; ancestors marked at `seq` already are left out before the limit. The
 * walk goes up the blocks' parent column by primary key, and the `CROSS JOIN` keeps it that
 * way round (the other way would scan the blocks for every step).
 */
export function sqliteMarkAncestorsSql(seq: number, limit: number): string {
	if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(limit))
		throw new Error("change marks need an integer seq and limit");
	return `WITH RECURSIVE up(id) AS (
			SELECT parent_id FROM outline_blocks
			WHERE id IN (${SQLITE_IDS_SLOT}) AND parent_id IS NOT NULL
			UNION
			SELECT b.parent_id FROM up CROSS JOIN outline_blocks b
				ON b.id = up.id WHERE b.parent_id IS NOT NULL
		)
		INSERT INTO outline_subtree_changes (ancestor_id, seq)
		SELECT up.id, ${seq} FROM up
		WHERE NOT EXISTS (SELECT 1 FROM outline_subtree_changes m
			WHERE m.ancestor_id = up.id AND m.seq = ${seq})
		LIMIT ${limit}
		RETURNING 1`;
}
/** Where the bound ids go in {@link sqliteMarkAncestorsSql}. */
export const SQLITE_IDS_SLOT = "/*ids*/";

const FIRST: OutlineLevelCursor = { orderKey: "", id: "" };

type SpaceValues = [
	string,
	string,
	string,
	string | null,
	string | null,
	string | null,
	number,
	string,
	number,
];

/** The port over one SQLite connection (`handle` is asked on every call). */
export function createSqliteOutlineHistory(handle: () => Database): OutlineHistoryPort {
	const values = (text: string, params: Param[]): unknown[][] =>
		handle()
			.query(text)
			.values(...params) as unknown[][];

	const level = (
		spaceId: string,
		parentId: string | null,
		asOf: number | null,
		after: OutlineLevelCursor,
		limit: number,
	): OutlineLevelRow[] => {
		const rows =
			asOf === null
				? values(parentId === null ? SQLITE_LEVEL_NOW_TOP : SQLITE_LEVEL_NOW, [
						spaceId,
						parentId,
						after.orderKey,
						after.id,
						limit,
					])
				: values(SQLITE_LEVEL_AS_OF, [
						spaceId,
						parentId ?? spaceId,
						asOf,
						after.orderKey,
						after.id,
						limit,
					]);
		return (rows as LevelValues[]).map(toLevel);
	};

	/**
	 * Whether the space can answer a read that looks back to `seq` (null: only needs its
	 * placements); throws when it cannot, false when there is no such space.
	 */
	const readable = (spaceId: string, seq: number | null): boolean => {
		const row = values("SELECT history_floor_seq, edges_ready FROM outline_spaces WHERE id = ?1", [
			spaceId,
		])[0] as [number, number] | undefined;
		if (!row) return false;
		assertHistoryReadable(
			spaceId,
			{ floorSeq: Number(row[0]), edgesReady: Number(row[1]) !== 0 },
			seq,
		);
		return true;
	};

	/** The children of several parents, one seek per parent, at most `limit` rows in all. */
	const levels = (
		spaceId: string,
		parentIds: readonly (string | null)[],
		asOf: number | null,
		limit: number,
	): OutlineLevelRow[] => {
		const rows: OutlineLevelRow[] = [];
		for (const parentId of new Set(parentIds)) {
			if (rows.length >= limit) break;
			for (const row of level(spaceId, parentId, asOf, FIRST, limit - rows.length)) rows.push(row);
		}
		return rows;
	};

	return {
		async listLevel(spaceId, parentId, { asOf, after, limit }) {
			const max = Math.max(0, Math.floor(limit));
			if (asOf !== null && !readable(spaceId, asOf)) return { rows: [], next: null };
			const rows = level(spaceId, parentId, asOf, after ?? FIRST, max + 1);
			if (rows.length <= max) return { rows, next: null };
			const kept = rows.slice(0, max);
			const last = kept.at(-1);
			return { rows: kept, next: last ? { orderKey: last.orderKey, id: last.id } : null };
		},

		async listLevels(spaceId, parentIds, { asOf, limit }) {
			const max = Math.max(0, Math.floor(limit));
			if (asOf !== null && !readable(spaceId, asOf)) return { rows: [], truncated: false };
			const rows = levels(spaceId, parentIds, asOf, max + 1);
			return { rows: rows.slice(0, max), truncated: rows.length > max };
		},

		async listSubtreeAt(spaceId, rootId, { asOf, limit }) {
			if (asOf !== null && !readable(spaceId, asOf)) return { rows: [], truncated: false };
			return readSubtreeByLevels(
				async (parentIds, room) => levels(spaceId, parentIds, asOf, room),
				rootId,
				limit,
			);
		},

		async getPlacementsAt(spaceId, blockIds, asOf) {
			const out: OutlineEdgeRow[] = [];
			if (!readable(spaceId, asOf)) return out;
			for (const id of new Set(blockIds)) {
				const row = (
					asOf === null
						? values(SQLITE_PLACEMENT_NOW, [id, spaceId])
						: values(SQLITE_PLACEMENT_AS_OF, [id, asOf, spaceId])
				)[0] as [string, string, number, number | null, string] | undefined;
				if (!row) continue;
				out.push({
					parentKey: row[0],
					blockId: row[1],
					fromSeq: Number(row[2]),
					toSeq: row[3] === null ? null : Number(row[3]),
					orderKey: row[4],
				});
			}
			return out;
		},

		async findSubtreeChanges(spaceId, blockIds, { after, upTo }) {
			const out: OutlineSubtreeChange[] = [];
			if (!readable(spaceId, after) || upTo <= after) return out;
			for (const blockId of new Set(blockIds)) {
				const row = values(SQLITE_SUBTREE_CHANGE, [blockId, after, upTo, spaceId])[0] as
					| [number, number]
					| undefined;
				if (!row) continue;
				const self = Number(row[0]) !== 0;
				const below = Number(row[1]) !== 0;
				if (self || below) out.push({ blockId, self, below });
			}
			return out;
		},

		async listChangedChildren(spaceId, parentId, { after, upTo, cursor, limit }) {
			if (!readable(spaceId, after) || upTo <= after) return { rows: [], next: null };
			const parentKey = parentId ?? spaceId;
			const toRows = (found: unknown[][]): OutlineChangedChildRow[] =>
				(found as Array<[string, number, number | null, string, number, number]>).map((row) => ({
					blockId: row[0],
					fromSeq: Number(row[1]),
					toSeq: row[2] === null ? null : Number(row[2]),
					orderKey: row[3],
					self: Number(row[4]) !== 0,
					below: Number(row[5]) !== 0,
				}));
			return pageChangedChildren(
				async (from, room) =>
					toRows(
						values(SQLITE_CHANGED_CHILDREN_OPEN, [
							spaceId,
							parentKey,
							after,
							upTo,
							from?.orderKey ?? "",
							from?.blockId ?? "",
							room,
						]),
					),
				async (from, room) =>
					toRows(
						values(SQLITE_CHANGED_CHILDREN_CLOSED, [
							spaceId,
							parentKey,
							after,
							upTo,
							from.toSeq,
							from.fromSeq,
							room,
							from.orderKey,
							from.blockId,
						]),
					),
				{ after, cursor, limit },
			);
		},

		async listSubtreeChangeSeqs(spaceId, blockId, { before, after, limit }) {
			if (!readable(spaceId, null)) return [];
			const rows = values(SQLITE_SUBTREE_CHANGE_SEQS, [
				blockId,
				before ?? Number.MAX_SAFE_INTEGER,
				after ?? -1,
				Math.max(0, Math.floor(limit)),
				spaceId,
			]) as Array<[number]>;
			return rows.map((row) => Number(row[0]));
		},

		async getHistoryStates(spaceIds) {
			const out = new Map<string, OutlineHistoryState>();
			for (const ids of chunked([...new Set(spaceIds)])) {
				const rows = values(
					`SELECT id, history_floor_seq, edges_ready FROM outline_spaces
					 WHERE id IN (${ids.map(() => "?").join(", ")})`,
					ids,
				) as Array<[string, number, number]>;
				for (const [id, floorSeq, ready] of rows)
					out.set(id, { floorSeq: Number(floorSeq), edgesReady: Number(ready) !== 0 });
			}
			return out;
		},

		async listSpacesPendingEdges({ after, limit }) {
			const rows = values(
				`SELECT id, key, kind, project_id, narrator_id, owner_user_id, next_seq, created_at,
					in_process_epoch
				 FROM outline_spaces WHERE edges_ready = 0 AND id > ?1 ORDER BY id LIMIT ?2`,
				[after ?? "", Math.max(0, Math.floor(limit))],
			) as SpaceValues[];
			return rows.map(
				(row): OutlineSpaceRow => ({
					id: row[0],
					key: row[1],
					kind: row[2] as OutlineSpaceKind,
					projectId: row[3],
					narratorId: row[4],
					ownerUserId: row[5],
					nextSeq: Number(row[6]),
					createdAt: row[7],
					inProcessEpoch: Number(row[8]),
				}),
			);
		},

		async backfillEdges(spaceId, { afterSid, limit }) {
			const max = Math.max(1, Math.floor(limit));
			const database = handle();
			// One synchronous transaction: no commit of the space can land inside it.
			return database.transaction(() => {
				const sids = database.query(SQLITE_BACKFILL_SCAN).values(spaceId, afterSid ?? "", max) as [
					string,
				][];
				const last = sids.at(-1)?.[0];
				if (last === undefined) return { scanned: 0, inserted: 0, nextSid: null };
				const { changes } = database
					.query(SQLITE_BACKFILL_INSERT)
					.run(spaceId, afterSid ?? "", last);
				return {
					scanned: sids.length,
					inserted: Number(changes),
					nextSid: sids.length < max ? null : last,
				};
			})();
		},

		async finishEdgeBackfill(spaceId) {
			const row = values(
				`UPDATE outline_spaces SET edges_ready = 1, history_floor_seq = next_seq - 1
				 WHERE id = ?1 AND edges_ready = 0 RETURNING history_floor_seq`,
				[spaceId],
			)[0] as [number] | undefined;
			return row ? Number(row[0]) : null;
		},
	};
}

/** The port over the application's connection. */
export const sqliteOutlineHistory: OutlineHistoryPort = createSqliteOutlineHistory(() => sqlite);
