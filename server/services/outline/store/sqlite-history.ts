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
 * JOIN ORDER IS PINNED. A level or subtree as of a seq is "the placements valid then, each
 * joined to the block's version valid then". Left to itself the planner has turned that round
 * (scan the versions, probe the placements), which is 10 to 20 times slower; so the placements
 * are an inner SELECT with the limit, and the joins after it are `CROSS JOIN`s, which SQLite
 * never reorders. `store/__tests__/history-plan.guard.test.ts` reads the plans.
 *
 * The statements are exported (text only) for that guard, and the port is built by
 * {@link createSqliteOutlineHistory} from a database handle so the upgrade test can run the
 * conversion against a database file of its own.
 */
import type { Database } from "bun:sqlite";
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

const AS_OF_COLUMNS = `s.id, b.sid, CASE WHEN s.parent_key = ?1 THEN NULL ELSE s.parent_key END,
		s.order_key, v.alias, v.task_json, v.from_seq, v.ask_json,
		EXISTS (SELECT 1 FROM outline_block_edges c
			WHERE c.parent_key = s.id AND c.from_seq <= ?3 AND (c.to_seq IS NULL OR c.to_seq > ?3))`;

/** Placements valid at `?3`. */
const VALID = (alias: string) =>
	`${alias}.from_seq <= ?3 AND (${alias}.to_seq IS NULL OR ${alias}.to_seq > ?3)`;

/**
 * The children of the parent key `?2` (a block's id, or the space's) as of `?3`, after the
 * cursor `(?4, ?5)`, at most `?6`.
 */
export const SQLITE_LEVEL_AS_OF = `SELECT ${AS_OF_COLUMNS}
	FROM (SELECT e.block_id AS id, e.parent_key, e.order_key FROM outline_block_edges e
		WHERE e.parent_key = ?2 AND ${VALID("e")} AND (e.order_key, e.block_id) > (?4, ?5)
		ORDER BY e.order_key, e.block_id LIMIT ?6) s
	${AS_OF_JOINS}
	ORDER BY s.order_key, s.id`;

/**
 * The blocks under the parent key `?2` as of `?3`, breadth first, at most `?4`. The recursion
 * walks placements only and stops at the limit; the versions are joined to what it returned.
 */
export const SQLITE_SUBTREE_AS_OF = `WITH RECURSIVE sub(id, parent_key, order_key, depth) AS (
		SELECT e.block_id, e.parent_key, e.order_key, 0 FROM outline_block_edges e
		WHERE e.parent_key = ?2 AND ${VALID("e")}
		UNION ALL
		SELECT e.block_id, e.parent_key, e.order_key, sub.depth + 1
		FROM sub CROSS JOIN outline_block_edges e ON e.parent_key = sub.id AND ${VALID("e")})
	SELECT ${AS_OF_COLUMNS}
	FROM (SELECT id, parent_key, order_key, depth FROM sub LIMIT ?4) s
	${AS_OF_JOINS}
	ORDER BY s.depth`;

const subtreeNow = (root: string) => `WITH RECURSIVE
	sub(id, sid, parent_id, order_key, alias, task_json, version_seq, ask_json, depth) AS (
		SELECT b.id, b.sid, b.parent_id, b.order_key, b.alias, b.task_json, b.version_seq, b.ask_json,
			0
		FROM outline_blocks b WHERE b.space_id = ?1 AND ${root} AND b.deleted = 0
		UNION ALL
		SELECT b.id, b.sid, b.parent_id, b.order_key, b.alias, b.task_json, b.version_seq, b.ask_json,
			sub.depth + 1
		FROM sub CROSS JOIN outline_blocks b
			ON b.space_id = ?1 AND b.parent_id = sub.id AND b.deleted = 0)
	SELECT s.id, s.sid, s.parent_id, s.order_key, s.alias, s.task_json, s.version_seq, s.ask_json,
		EXISTS (SELECT 1 FROM outline_blocks c
			WHERE c.space_id = ?1 AND c.parent_id = s.id AND c.deleted = 0)
	FROM (SELECT * FROM sub LIMIT ?3) s
	ORDER BY s.depth`;

/** The live blocks under the block `?2` now, breadth first, at most `?3`. */
export const SQLITE_SUBTREE_NOW = subtreeNow("b.parent_id = ?2");
/** The live blocks of the space `?1` now, breadth first, at most `?3` (`?2` bound to null). */
export const SQLITE_SUBTREE_NOW_TOP = subtreeNow("b.parent_id IS NULL AND ?2 IS NULL");

/** Where the block `?1` sat as of `?2`. */
export const SQLITE_PLACEMENT_AS_OF = `SELECT parent_key, block_id, from_seq, to_seq, order_key
	FROM outline_block_edges
	WHERE block_id = ?1 AND from_seq <= ?2 AND (to_seq IS NULL OR to_seq > ?2)
	ORDER BY from_seq DESC LIMIT 1`;
/** Where the block `?1` sits now. */
export const SQLITE_PLACEMENT_NOW = `SELECT parent_key, block_id, from_seq, to_seq, order_key
	FROM outline_block_edges WHERE block_id = ?1 AND to_seq IS NULL LIMIT 1`;

const SELF_CHANGED = (id: string, after: string, upTo: string) =>
	`EXISTS (SELECT 1 FROM outline_block_versions v
		WHERE v.block_id = ${id} AND v.from_seq > ${after} AND v.from_seq <= ${upTo})`;
const BELOW_CHANGED = (id: string, after: string, upTo: string) =>
	`EXISTS (SELECT 1 FROM outline_subtree_changes t
		WHERE t.ancestor_id = ${id} AND t.seq > ${after} AND t.seq <= ${upTo})`;

/** Whether the block `?1`, or anything that was under it, changed in `(?2, ?3]`. */
export const SQLITE_SUBTREE_CHANGE = `SELECT ${SELF_CHANGED("?1", "?2", "?3")},
	${BELOW_CHANGED("?1", "?2", "?3")}`;

/**
 * The children the parent key `?2` had in `(?3, ?4]` that differ between its ends, after the
 * cursor `(?5, ?6)` by (block id, from seq), at most `?7`. A parent that is not the space `?1`
 * itself must be a block of it.
 */
export const SQLITE_CHANGED_CHILDREN = `SELECT block_id, from_seq, to_seq, order_key, self, below
	FROM (SELECT e.block_id, e.from_seq, e.to_seq, e.order_key,
			${SELF_CHANGED("e.block_id", "?3", "?4")} AS self,
			${BELOW_CHANGED("e.block_id", "?3", "?4")} AS below
		FROM outline_block_edges e
		WHERE e.parent_key = ?2 AND e.from_seq <= ?4 AND (e.to_seq IS NULL OR e.to_seq > ?3)
			AND (e.block_id, e.from_seq) > (?5, ?6)
			AND (?2 = ?1 OR EXISTS (SELECT 1 FROM outline_blocks p
				WHERE p.id = ?2 AND p.space_id = ?1))
		ORDER BY e.block_id, e.from_seq)
	WHERE self OR below OR from_seq > ?3 OR (to_seq IS NOT NULL AND to_seq <= ?4)
	ORDER BY block_id, from_seq LIMIT ?7`;

/** Seqs of the commits that changed anything under the block `?1`, in `?3 < seq < ?2`. */
export const SQLITE_SUBTREE_CHANGE_SEQS = `SELECT seq FROM outline_subtree_changes
	WHERE ancestor_id = ?1 AND seq < ?2 AND seq > ?3 ORDER BY seq DESC LIMIT ?4`;

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

	return {
		async listLevel(spaceId, parentId, { asOf, after, limit }) {
			const max = Math.max(0, Math.floor(limit));
			const rows = level(spaceId, parentId, asOf, after ?? FIRST, max + 1);
			if (rows.length <= max) return { rows, next: null };
			const kept = rows.slice(0, max);
			const last = kept.at(-1);
			return { rows: kept, next: last ? { orderKey: last.orderKey, id: last.id } : null };
		},

		async listLevels(spaceId, parentIds, { asOf, limit }) {
			const max = Math.max(0, Math.floor(limit));
			const rows: OutlineLevelRow[] = [];
			for (const parentId of new Set(parentIds)) {
				// One seek per parent, stopping one row past what is left of the limit.
				for (const row of level(spaceId, parentId, asOf, FIRST, max - rows.length + 1))
					rows.push(row);
				if (rows.length > max) return { rows: rows.slice(0, max), truncated: true };
			}
			return { rows, truncated: false };
		},

		async listSubtreeAt(spaceId, rootId, { asOf, limit }) {
			const max = Math.max(0, Math.floor(limit));
			const rows = (
				asOf === null
					? values(rootId === null ? SQLITE_SUBTREE_NOW_TOP : SQLITE_SUBTREE_NOW, [
							spaceId,
							rootId,
							max + 1,
						])
					: values(SQLITE_SUBTREE_AS_OF, [spaceId, rootId ?? spaceId, asOf, max + 1])
			) as LevelValues[];
			return { rows: rows.slice(0, max).map(toLevel), truncated: rows.length > max };
		},

		async getPlacementsAt(blockIds, asOf) {
			const out: OutlineEdgeRow[] = [];
			for (const id of new Set(blockIds)) {
				const row = (
					asOf === null
						? values(SQLITE_PLACEMENT_NOW, [id])
						: values(SQLITE_PLACEMENT_AS_OF, [id, asOf])
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

		async findSubtreeChanges(blockIds, { after, upTo }) {
			const out: OutlineSubtreeChange[] = [];
			if (upTo <= after) return out;
			for (const blockId of new Set(blockIds)) {
				const row = values(SQLITE_SUBTREE_CHANGE, [blockId, after, upTo])[0] as [number, number];
				const self = Number(row[0]) !== 0;
				const below = Number(row[1]) !== 0;
				if (self || below) out.push({ blockId, self, below });
			}
			return out;
		},

		async listChangedChildren(spaceId, parentId, { after, upTo, cursor, limit }) {
			const max = Math.max(0, Math.floor(limit));
			if (upTo <= after) return { rows: [], next: null };
			const found = values(SQLITE_CHANGED_CHILDREN, [
				spaceId,
				parentId ?? spaceId,
				after,
				upTo,
				cursor?.blockId ?? "",
				cursor?.fromSeq ?? -1,
				max + 1,
			]) as Array<[string, number, number | null, string, number, number]>;
			const rows: OutlineChangedChildRow[] = found.slice(0, max).map((row) => ({
				blockId: row[0],
				fromSeq: Number(row[1]),
				toSeq: row[2] === null ? null : Number(row[2]),
				orderKey: row[3],
				self: Number(row[4]) !== 0,
				below: Number(row[5]) !== 0,
			}));
			const last = rows.at(-1);
			return {
				rows,
				next: found.length > max && last ? { blockId: last.blockId, fromSeq: last.fromSeq } : null,
			};
		},

		async listSubtreeChangeSeqs(blockId, { before, after, limit }) {
			const rows = values(SQLITE_SUBTREE_CHANGE_SEQS, [
				blockId,
				before ?? Number.MAX_SAFE_INTEGER,
				after ?? -1,
				Math.max(0, Math.floor(limit)),
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
