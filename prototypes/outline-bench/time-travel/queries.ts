/**
 * Point-in-time read queries for every table/index design under test.
 *
 * Time model (docs/OUTLINE_KNOWLEDGE-DESIGN.md §2.5/§7.1): a version row is live at seq T iff
 *   from_seq <= T AND (to_seq IS NULL OR to_seq > T).
 * `to_max` is the same bound stored as NOT NULL with a sentinel for "open" (Number.MAX_SAFE_INTEGER),
 * which lets a composite index evaluate the whole interval test without an OR.
 */
import type { Db, Dialect, Row } from "./db";

export type VariantId = "A1" | "A2" | "B1" | "B2" | "B3" | "B4" | "B5" | "C";

export interface VariantDef {
	id: VariantId;
	title: string;
	approach: "parent" | "page" | "members";
	/** Index used by the filter; undefined = PK / none. */
	index?: string;
	useMax: boolean;
	ddl: { sqlite?: string[]; pg?: string[] };
	drop: string[];
}

const V = "outline_block_versions";
const M = "outline_page_members";
const OPEN = Number.MAX_SAFE_INTEGER;

export const VARIANTS: Record<VariantId, VariantDef> = {
	A1: {
		id: "A1",
		title: "A1 parent_id recursion, idx(parent_id, from_seq), NULL-or filter",
		approach: "parent",
		index: "ix_a1",
		useMax: false,
		ddl: {
			sqlite: [`CREATE INDEX ix_a1 ON ${V} (parent_id, from_seq)`],
			pg: [`CREATE INDEX ix_a1 ON ${V} (parent_id, from_seq)`],
		},
		drop: ["ix_a1"],
	},
	A2: {
		id: "A2",
		title: "A2 parent_id recursion, idx(parent_id, from_seq, to_max)",
		approach: "parent",
		index: "ix_a2",
		useMax: true,
		ddl: {
			sqlite: [`CREATE INDEX ix_a2 ON ${V} (parent_id, from_seq, to_max)`],
			pg: [`CREATE INDEX ix_a2 ON ${V} (parent_id, from_seq, to_max)`],
		},
		drop: ["ix_a2"],
	},
	B1: {
		id: "B1",
		title: "B1 page_id on versions, idx(page_id, from_seq), NULL-or filter",
		approach: "page",
		index: "ix_b1",
		useMax: false,
		ddl: {
			sqlite: [`CREATE INDEX ix_b1 ON ${V} (page_id, from_seq)`],
			pg: [`CREATE INDEX ix_b1 ON ${V} (page_id, from_seq)`],
		},
		drop: ["ix_b1"],
	},
	B2: {
		id: "B2",
		title: "B2 page_id, idx(page_id, from_seq, to_seq), NULL-or filter",
		approach: "page",
		index: "ix_b2",
		useMax: false,
		ddl: {
			sqlite: [`CREATE INDEX ix_b2 ON ${V} (page_id, from_seq, to_seq)`],
			pg: [`CREATE INDEX ix_b2 ON ${V} (page_id, from_seq, to_seq)`],
		},
		drop: ["ix_b2"],
	},
	B3: {
		id: "B3",
		title: "B3 page_id, idx(page_id, from_seq, to_max) sentinel",
		approach: "page",
		index: "ix_b3",
		useMax: true,
		ddl: {
			sqlite: [`CREATE INDEX ix_b3 ON ${V} (page_id, from_seq, to_max)`],
			pg: [`CREATE INDEX ix_b3 ON ${V} (page_id, from_seq, to_max)`],
		},
		drop: ["ix_b3"],
	},
	B4: {
		id: "B4",
		title: "B4 page_id, GiST(page_id, int8range(from_seq, to_seq))",
		approach: "page",
		index: "ix_b4",
		useMax: false,
		ddl: {
			pg: [
				`CREATE INDEX ix_b4 ON ${V} USING gist (page_id, int8range(from_seq, COALESCE(to_seq, ${OPEN}), '[)'))`,
				`CREATE INDEX ix_b4p ON ${V} (page_id, from_seq)`,
			],
		},
		drop: ["ix_b4", "ix_b4p"],
	},
	B5: {
		id: "B5",
		title:
			"B5 page_id + covering structure index (page_id, from_seq, to_max | deleted, block_id, parent_id, order_key)",
		approach: "page",
		index: "ix_b5",
		useMax: true,
		ddl: {
			sqlite: [
				`CREATE INDEX ix_b5 ON ${V} (page_id, from_seq, to_max, deleted, block_id, parent_id, order_key)`,
			],
			pg: [
				`CREATE INDEX ix_b5 ON ${V} (page_id, from_seq, to_max) INCLUDE (deleted, block_id, parent_id, order_key)`,
			],
		},
		drop: ["ix_b5"],
	},
	C: {
		id: "C",
		title: "C page membership intervals table (no page_id on versions)",
		approach: "members",
		index: "ix_c",
		useMax: true,
		ddl: {
			sqlite: [`CREATE INDEX ix_c ON ${M} (page_id, from_seq, to_max)`],
			pg: [`CREATE INDEX ix_c ON ${M} (page_id, from_seq, to_max)`],
		},
		drop: ["ix_c"],
	},
};

function ph(d: Dialect) {
	return d === "sqlite"
		? { p: "?1", t: "?2", t2: "?3", extra: "?4" }
		: { p: "$1", t: "$2::bigint", t2: "$3::bigint", extra: "$4" };
}

function live(alias: string, useMax: boolean, t: string) {
	return useMax ? `${alias}.to_max > ${t}` : `(${alias}.to_seq IS NULL OR ${alias}.to_seq > ${t})`;
}

const COLS = "v.block_id, v.from_seq, v.parent_id, v.order_key, v.content, v.task_json, v.deleted";
const COLS_NOCONTENT = "v.block_id, v.from_seq, v.parent_id, v.order_key, v.task_json, v.deleted";

// ---------------------------------------------------------------------------------------------
// Q2: a whole page at T (all live blocks)

function recursionSql(
	d: Dialect,
	def: VariantDef,
	mode: "all" | "dfs500" | "bfs500" | "path-sort500",
): string {
	const { p, t } = ph(d);
	const by = d === "sqlite" ? ` INDEXED BY ${def.index}` : "";
	const rootLive = live("x", def.useMax, t);
	const childLive = live("c", def.useMax, t);
	const needPath = mode === "dfs500" || mode === "path-sort500";
	const rootSel = needPath
		? "SELECT x.block_id, x.from_seq, 0 AS depth, ''::text AS path"
		: "SELECT x.block_id, x.from_seq, 0 AS depth";
	const root =
		d === "sqlite"
			? `SELECT x.block_id, x.from_seq, 0 AS depth${needPath ? ", '' AS path" : ""} FROM ${V} x WHERE x.block_id = ${p} AND x.from_seq <= ${t} AND ${rootLive} AND x.deleted = 0`
			: `${rootSel} FROM ${V} x WHERE x.block_id = ${p} AND x.from_seq <= ${t} AND ${rootLive} AND x.deleted = 0`;
	const childSel = `SELECT c.block_id, c.from_seq, tr.depth + 1${needPath ? ", tr.path || '/' || c.order_key" : ""}`;
	let rec = `${childSel} FROM tree tr JOIN ${V} c${by} ON c.parent_id = tr.block_id AND c.from_seq <= ${t} AND ${childLive} AND c.deleted = 0 WHERE tr.depth < 64`;
	if (d === "sqlite" && mode === "dfs500") rec += " ORDER BY 4 LIMIT 500";
	if (d === "sqlite" && mode === "bfs500") rec += " LIMIT 500";
	const cols = needPath ? "block_id, from_seq, depth, path" : "block_id, from_seq, depth";
	const head = `WITH RECURSIVE tree(${cols}) AS (${root} UNION ALL ${rec})`;
	let tail = `SELECT ${COLS} FROM tree tr JOIN ${V} v ON v.block_id = tr.block_id AND v.from_seq = tr.from_seq`;
	if (mode === "dfs500" && d === "sqlite") tail += " ORDER BY tr.path";
	if (mode === "bfs500" && d === "pg") tail += " LIMIT 500";
	if (mode === "path-sort500") tail += " ORDER BY tr.path LIMIT 500";
	return `${head} ${tail}`;
}

function pageSql(d: Dialect, def: VariantDef, noContent = false): string {
	const { p, t } = ph(d);
	const cols = noContent ? COLS_NOCONTENT : COLS;
	if (def.id === "B4") {
		return `SELECT ${cols} FROM ${V} v WHERE v.page_id = ${p} AND int8range(v.from_seq, COALESCE(v.to_seq, ${OPEN}), '[)') @> ${t} AND v.deleted = 0`;
	}
	const by = d === "sqlite" ? ` INDEXED BY ${def.index}` : "";
	return `SELECT ${cols} FROM ${V} v${by} WHERE v.page_id = ${p} AND v.from_seq <= ${t} AND ${live("v", def.useMax, t)} AND v.deleted = 0`;
}

function membersSql(d: Dialect, def: VariantDef): string {
	const { p, t } = ph(d);
	const by = d === "sqlite" ? ` INDEXED BY ${def.index}` : "";
	if (d === "sqlite") {
		return `SELECT ${COLS} FROM ${M} m${by} JOIN ${V} v ON v.block_id = m.block_id AND v.from_seq = (SELECT MAX(x.from_seq) FROM ${V} x WHERE x.block_id = m.block_id AND x.from_seq <= ${t}) WHERE m.page_id = ${p} AND m.from_seq <= ${t} AND m.to_max > ${t}`;
	}
	return `SELECT ${COLS} FROM ${M} m CROSS JOIN LATERAL (SELECT * FROM ${V} x WHERE x.block_id = m.block_id AND x.from_seq <= ${t} ORDER BY x.from_seq DESC LIMIT 1) v WHERE m.page_id = ${p} AND m.from_seq <= ${t} AND m.to_max > ${t}`;
}

export function pageAtSql(d: Dialect, def: VariantDef, opts: { noContent?: boolean } = {}): string {
	if (def.approach === "parent") return recursionSql(d, def, "all");
	if (def.approach === "members") return membersSql(d, def);
	return pageSql(d, def, opts.noContent);
}

export async function pageAt(
	db: Db,
	def: VariantDef,
	page: string,
	t: number,
	opts: { noContent?: boolean } = {},
): Promise<Row[]> {
	return db.all(pageAtSql(db.dialect, def, opts), [page, t]);
}

// ---------------------------------------------------------------------------------------------
// Q1: viewport = first 500 blocks in tree (pre-order) order

export function treeOrder(rows: Row[], limit: number): Row[] {
	const ids = new Set<string>();
	for (const r of rows) ids.add(r.block_id);
	const kids = new Map<string, Row[]>();
	const roots: Row[] = [];
	for (const r of rows) {
		const par = r.parent_id as string | null;
		if (par === null || !ids.has(par)) roots.push(r);
		else {
			const a = kids.get(par) ?? [];
			kids.set(par, a);
			a.push(r);
		}
	}
	const cmp = (a: Row, b: Row) =>
		a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : 0;
	roots.sort(cmp);
	const out: Row[] = [];
	const stack: Row[] = [];
	for (let i = roots.length - 1; i >= 0; i--) stack.push(roots[i] as Row);
	while (stack.length && out.length < limit) {
		const r = stack.pop() as Row;
		out.push(r);
		const ch = kids.get(r.block_id);
		if (ch) {
			ch.sort(cmp);
			for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i] as Row);
		}
	}
	return out;
}

export type ViewportMode = "native" | "fullsort";

/** native: the recursion stops after 500 rows (sqlite: DFS order, pg: BFS order). fullsort: read the page, order in JS. */
export async function viewport(
	db: Db,
	def: VariantDef,
	page: string,
	t: number,
	mode: ViewportMode,
): Promise<Row[]> {
	if (def.approach === "parent" && mode === "native") {
		const sql = recursionSql(db.dialect, def, db.dialect === "sqlite" ? "dfs500" : "bfs500");
		return db.all(sql, [page, t]);
	}
	if (def.approach === "parent" && mode === "fullsort" && db.dialect === "pg") {
		return db.all(recursionSql("pg", def, "path-sort500"), [page, t]);
	}
	const rows = await pageAt(db, def, page, t);
	return treeOrder(rows, 500);
}

// ---------------------------------------------------------------------------------------------
// Q3: changes between two time points (timeline box select). t1 < t2.

const CHG_COLS =
	"v.block_id, v.from_seq, v.parent_id, v.order_key, v.content, v.deleted, v.change_flags, v.commit_id";

export type ChangeMode = "flags" | "join";

export async function changesBetween(
	db: Db,
	def: VariantDef,
	page: string,
	t1: number,
	t2: number,
	mode: ChangeMode,
): Promise<{ rows: Row[]; extra?: Row[] }> {
	const { p, t, t2: u } = ph(db.dialect);
	if (def.approach === "parent") {
		// Reconstruct the page at both time points and diff.
		const [a, b] = await Promise.all([pageAt(db, def, page, t1), pageAt(db, def, page, t2)]);
		const prev = new Map<string, string>();
		for (const r of a) prev.set(r.block_id, String(r.from_seq));
		const out: Row[] = [];
		const seen = new Set<string>();
		for (const r of b) {
			seen.add(r.block_id);
			const pv = prev.get(r.block_id);
			if (pv === undefined) out.push({ ...r, kind: "added" });
			else if (pv !== String(r.from_seq)) out.push({ ...r, kind: "changed" });
		}
		for (const [id] of prev) if (!seen.has(id)) out.push({ block_id: id, kind: "removed" });
		return { rows: out };
	}
	if (def.approach === "members") {
		const by = db.dialect === "sqlite" ? ` INDEXED BY ${def.index}` : "";
		const sql = `SELECT ${CHG_COLS} FROM ${M} m${by} JOIN ${V} v ON v.block_id = m.block_id AND v.from_seq > ${t} AND v.from_seq <= ${u} WHERE m.page_id = ${p} AND m.from_seq <= ${u} AND m.to_max > ${t}`;
		return { rows: await db.all(sql, [page, t1, t2]) };
	}
	const by =
		db.dialect === "sqlite" && def.index && def.id !== "B4" ? ` INDEXED BY ${def.index}` : "";
	const idxHint = def.id === "B4" ? "" : by;
	if (mode === "flags") {
		const sql = `SELECT ${CHG_COLS} FROM ${V} v${idxHint} WHERE v.page_id = ${p} AND v.from_seq > ${t} AND v.from_seq <= ${u}`;
		return { rows: await db.all(sql, [page, t1, t2]) };
	}
	// classify from the previous version instead of stored flags
	const prevSel =
		db.dialect === "sqlite"
			? `LEFT JOIN ${V} pv ON pv.block_id = v.block_id AND pv.from_seq = (SELECT MAX(z.from_seq) FROM ${V} z WHERE z.block_id = v.block_id AND z.from_seq < v.from_seq)`
			: `LEFT JOIN LATERAL (SELECT z.content_hash, z.parent_id, z.order_key, z.deleted FROM ${V} z WHERE z.block_id = v.block_id AND z.from_seq < v.from_seq ORDER BY z.from_seq DESC LIMIT 1) pv ON true`;
	const sql = `SELECT v.block_id, v.from_seq, v.parent_id, v.order_key, v.content, v.deleted, v.commit_id, v.content_hash, pv.content_hash AS p_hash, pv.parent_id AS p_parent, pv.order_key AS p_key, pv.deleted AS p_deleted FROM ${V} v${idxHint} ${prevSel} WHERE v.page_id = ${p} AND v.from_seq > ${t} AND v.from_seq <= ${u}`;
	return { rows: await db.all(sql, [page, t1, t2]) };
}

// ---------------------------------------------------------------------------------------------
// Q4: timeline commit list, cursor paged (200 per page, LIMIT n+1)

export async function commitList(
	db: Db,
	kind: "all" | "agent" | "narrator" | "page",
	args: { space: string; cursor: number; narrator?: string; page?: string },
): Promise<Row[]> {
	const d = db.dialect;
	const q = (i: number) => (d === "sqlite" ? `?${i}` : `$${i}${i === 2 ? "::bigint" : ""}`);
	if (kind === "all")
		return db.all(
			`SELECT * FROM outline_commits WHERE space_id = ${q(1)} AND seq < ${q(2)} ORDER BY seq DESC LIMIT 201`,
			[args.space, args.cursor],
		);
	if (kind === "agent")
		return db.all(
			`SELECT * FROM outline_commits WHERE space_id = ${q(1)} AND seq < ${q(2)} AND actor_kind = 'agent' ORDER BY seq DESC LIMIT 201`,
			[args.space, args.cursor],
		);
	if (kind === "narrator")
		return db.all(
			`SELECT * FROM outline_commits WHERE space_id = ${q(1)} AND seq < ${q(2)} AND narrator_id = ${q(3)} ORDER BY seq DESC LIMIT 201`,
			[args.space, args.cursor, args.narrator],
		);
	return db.all(
		`SELECT c.* FROM (SELECT from_seq, MIN(commit_id) AS commit_id FROM ${V} WHERE page_id = ${q(1)} AND from_seq < ${q(2)} GROUP BY from_seq ORDER BY from_seq DESC LIMIT 201) x JOIN outline_commits c ON c.id = x.commit_id ORDER BY x.from_seq DESC`,
		[args.page, args.cursor],
	);
}

// ---------------------------------------------------------------------------------------------
// B5: structure first (covering index, no table access), content only for the blocks actually shown

export async function structureAt(
	db: Db,
	def: VariantDef,
	page: string,
	t: number,
): Promise<Row[]> {
	const { p, t: tt } = ph(db.dialect);
	const by = db.dialect === "sqlite" ? ` INDEXED BY ${def.index}` : "";
	const sql = `SELECT v.block_id, v.from_seq, v.parent_id, v.order_key FROM ${V} v${by} WHERE v.page_id = ${p} AND v.from_seq <= ${tt} AND v.to_max > ${tt} AND v.deleted = 0`;
	return db.all(sql, [page, t]);
}

/** ids are nanoid text (A-Za-z0-9_-) and seqs are numbers produced by this benchmark, so inlining is safe here. */
export async function contentFor(db: Db, rows: Row[]): Promise<Row[]> {
	if (rows.length === 0) return [];
	const values = rows.map((r) => `('${r.block_id}', ${Number(r.from_seq)})`).join(",");
	const sql = `SELECT v.block_id, v.from_seq, v.content, v.task_json FROM ${V} v WHERE (v.block_id, v.from_seq) IN (VALUES ${values})`;
	return db.all(sql);
}

export async function viewportTwoStep(
	db: Db,
	def: VariantDef,
	page: string,
	t: number,
): Promise<Row[]> {
	const structure = await structureAt(db, def, page, t);
	const first = treeOrder(structure, 500);
	const content = await contentFor(db, first);
	const byKey = new Map<string, Row>();
	for (const r of content) byKey.set(`${r.block_id}`, r);
	return first.map((r) => ({
		...r,
		content: byKey.get(r.block_id)?.content,
		task_json: byKey.get(r.block_id)?.task_json,
	}));
}
