/**
 * Plan guard and measurements for the reads by placement (`store/sqlite-history.ts`) on a
 * synthetic space of 100,000 blocks.
 *
 * THE GUARD. A level as of a seq is "the placements valid then, each joined to the block's
 * version valid then" (a subtree is read level by level with the same statement). The history study saw SQLite turn that join round once (scan the
 * versions, probe the placements): 10 to 20 times slower. The statements pin the order
 * (placements in an inner SELECT with the limit, then `CROSS JOIN`s), and this file reads their
 * plans, without statistics and after `ANALYZE` on skewed data (a few blocks rewritten hundreds
 * of times, one parent with thousands of children): the placements are searched by parent
 * first, then the block and its version by primary key; no base table is ever scanned.
 *
 * THE SIZE. drizzle-orm cannot declare `WITHOUT ROWID`, so the two tables are plain rowid
 * tables whose primary key is a second B-tree. The same rows are written, in the same order,
 * into `WITHOUT ROWID` twins and both are measured with `dbstat`.
 *
 * THE TIMINGS are printed, not asserted (they depend on the machine), except for generous
 * ceilings that only catch a read that stopped being bounded.
 *
 * ISOLATION: its own database file in a temp directory, with every committed migration
 * applied; the application's database is not used.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPendingMigrationsByHash } from "../../../db/run-migrations";
import {
	createSqliteOutlineHistory,
	SQLITE_BACKFILL_INSERT,
	SQLITE_BACKFILL_SCAN,
	SQLITE_CHANGED_CHILDREN_CLOSED,
	SQLITE_CHANGED_CHILDREN_OPEN,
	SQLITE_LEVEL_AS_OF,
	SQLITE_LEVEL_NOW,
	SQLITE_LEVEL_NOW_TOP,
	SQLITE_PLACEMENT_AS_OF,
	SQLITE_PLACEMENT_NOW,
	SQLITE_SUBTREE_CHANGE,
	SQLITE_SUBTREE_CHANGE_SEQS,
	sqliteMarkAncestorsSql,
} from "../store/sqlite-history";

const BLOCKS = 100_000;
const SPACE = "bench-space";
const root = mkdtempSync(join(tmpdir(), "nf-outline-history-plan-"));
let database: Database;
/** A block with 5,000 children, a block with a 20,000-block subtree, and a much rewritten parent. */
let wide = "";
let big = "";
let hot = "";
/** A block with 2,000 children now, to which the churn test adds children that came and went. */
let churn = "";
let lastSeq = 0;
let edgeRows = 0;
let markRows = 0;

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/**
 * 100,000 blocks: mostly a shallow, wide forest, plus one parent with 5,000 children and one
 * subtree of 20,000 blocks. Every block has its creation version; a tenth were moved once (a
 * closed placement), a quarter rewritten a few times, and the 50 children of one parent 300
 * times each. Every commit marks the ancestors of what it changed. Ids are 21 random
 * characters, as the product's, so they land all over the indexes.
 */
function seed(): void {
	const rnd = mulberry32(20261114);
	const id = () => {
		let out = "";
		for (let i = 0; i < 21; i++) out += ALPHABET[Math.floor(rnd() * 64)];
		return out;
	};
	const parentOf = new Map<string, string | null>();
	const ids: string[] = [];
	const insertBlock = database.prepare(
		`INSERT INTO outline_blocks (id, space_id, sid, parent_id, page_id, order_key, content,
			content_hash, author_kind, author_id, version_seq, deleted, in_process)
		 VALUES (?, '${SPACE}', ?, ?, ?, ?, ?, 'h', 'human', 'u', ?, 0, 0)`,
	);
	const insertVersion = database.prepare(
		`INSERT INTO outline_block_versions (block_id, from_seq, to_seq, commit_id, page_id,
			parent_id, order_key, content, content_hash, change_flags, deleted)
		 VALUES (?, ?, ?, 'c', ?, ?, ?, ?, 'h', ?, 0)`,
	);
	const closeVersion = database.prepare(
		"UPDATE outline_block_versions SET to_seq = ? WHERE block_id = ? AND to_seq IS NULL",
	);
	const tables = ["outline_block_edges", "edges_without_rowid"];
	const insertEdge = tables.map((t) =>
		database.prepare(
			`INSERT INTO ${t} (parent_key, block_id, from_seq, to_seq, order_key) VALUES (?, ?, ?, NULL, ?)`,
		),
	);
	const closeEdge = tables.map((t) =>
		database.prepare(`UPDATE ${t} SET to_seq = ? WHERE block_id = ? AND to_seq IS NULL`),
	);
	const insertMark = ["outline_subtree_changes", "changes_without_rowid"].map((t) =>
		database.prepare(`INSERT OR IGNORE INTO ${t} (ancestor_id, seq) VALUES (?, ?)`),
	);
	const body = "Some text of a block, about as long as a short paragraph of notes would be. ";
	let seq = 0;
	const mark = (blockId: string, at: number) => {
		let current = parentOf.get(blockId) ?? null;
		while (current !== null) {
			for (const statement of insertMark) statement.run(current, at);
			markRows++;
			current = parentOf.get(current) ?? null;
		}
	};
	const place = (blockId: string, parent: string | null, at: number, key: string) => {
		for (const statement of insertEdge) statement.run(parent ?? SPACE, blockId, at, key);
		edgeRows++;
	};
	const create = (parent: string | null): string => {
		const blockId = id();
		seq++;
		const key = `a${String(Math.floor(rnd() * 1e8)).padStart(8, "0")}`;
		parentOf.set(blockId, parent);
		ids.push(blockId);
		insertBlock.run(blockId, id().slice(0, 8), parent, blockId, key, body, seq);
		insertVersion.run(blockId, seq, null, blockId, parent, key, body, 1);
		place(blockId, parent, seq, key);
		mark(blockId, seq);
		return blockId;
	};
	const rewrite = (blockId: string) => {
		seq++;
		closeVersion.run(seq, blockId);
		insertVersion.run(blockId, seq, null, blockId, parentOf.get(blockId) ?? null, "a", body, 2);
		mark(blockId, seq);
	};
	database.transaction(() => {
		database.run(
			`INSERT INTO outline_spaces (id, key, kind, next_seq, created_at, edges_ready)
			 VALUES ('${SPACE}', 'bnch', 'personal', 1, '2026-11-14T00:00:00.000Z', 1)`,
		);
		const tops: string[] = [];
		for (let i = 0; i < 400; i++) tops.push(create(null));
		wide = tops[0] as string;
		big = tops[1] as string;
		hot = tops[2] as string;
		churn = tops[3] as string;
		for (let i = 0; i < 2000; i++) create(churn);
		for (let i = 0; i < 5000; i++) create(wide);
		// A subtree of 20,000: fan-out 20, three levels and a bit.
		const level = [big];
		for (let made = 0, at = 0; made < 20_000; at++) {
			const parent = level[at] as string;
			for (let k = 0; k < 20 && made < 20_000; k++, made++) level.push(create(parent));
		}
		const hotKids: string[] = [];
		for (let i = 0; i < 50; i++) hotKids.push(create(hot));
		// The rest: under a random earlier block of the ordinary part, mostly near the top.
		const ordinary = tops.slice(4);
		while (ids.length < BLOCKS) {
			const parent = ordinary[Math.floor(rnd() ** 2 * ordinary.length)] as string;
			const made = create(parent);
			if (rnd() < 0.35) ordinary.push(made);
		}
		// History: rewrites, the hot children, and moves (a closed placement each).
		for (const blockId of ids) {
			if (rnd() < 0.25) for (let n = 1 + Math.floor(rnd() * 4); n > 0; n--) rewrite(blockId);
		}
		for (let round = 0; round < 300; round++) for (const kid of hotKids) rewrite(kid);
		for (const blockId of ids) {
			if (rnd() >= 0.1 || blockId === wide || blockId === big || blockId === hot) continue;
			if (parentOf.get(blockId) === churn) continue;
			const parent = parentOf.get(blockId);
			if (parent === null || parent === undefined) continue;
			seq++;
			mark(blockId, seq);
			const key = `b${String(Math.floor(rnd() * 1e8)).padStart(8, "0")}`;
			for (const statement of closeEdge) statement.run(seq, blockId);
			closeVersion.run(seq, blockId);
			insertVersion.run(blockId, seq, null, blockId, parent, key, body, 4);
			database.run("UPDATE outline_blocks SET order_key = ?, version_seq = ? WHERE id = ?", [
				key,
				seq,
				blockId,
			]);
			place(blockId, parent, seq, key);
		}
		database.run(`UPDATE outline_spaces SET next_seq = ? WHERE id = '${SPACE}'`, [seq + 1]);
	})();
	lastSeq = seq;
}

beforeAll(() => {
	database = new Database(join(root, "bench.db"));
	database.run("PRAGMA journal_mode = WAL");
	database.run("PRAGMA synchronous = NORMAL");
	database.run("PRAGMA cache_size = -16000");
	applyPendingMigrationsByHash(database, join(import.meta.dir, "../../../../drizzle"));
	// The twins the generators cannot make: the same columns and keys, `WITHOUT ROWID`.
	database.run(`CREATE TABLE edges_without_rowid (
		parent_key TEXT NOT NULL, block_id TEXT NOT NULL, from_seq INTEGER NOT NULL, to_seq INTEGER,
		order_key TEXT NOT NULL, PRIMARY KEY (parent_key, block_id, from_seq)) WITHOUT ROWID`);
	database.run("CREATE INDEX idx_edges_wr_block ON edges_without_rowid (block_id, from_seq)");
	database.run(`CREATE TABLE changes_without_rowid (
		ancestor_id TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (ancestor_id, seq)) WITHOUT ROWID`);
	const started = performance.now();
	seed();
	// A fresh connection for the tests: setup leaves a statement of its own unfinished on this
	// one, which would keep a later write (ANALYZE) from committing.
	database.close();
	database = new Database(join(root, "bench.db"));
	database.run("PRAGMA cache_size = -16000");
	console.log(
		`[outline history bench] seeded ${BLOCKS} blocks, ${edgeRows} placements, ${markRows} mark writes, ${lastSeq} commits in ${Math.round(performance.now() - started)} ms`,
	);
}, 600_000);

afterAll(() => {
	database?.close();
	rmSync(root, { recursive: true, force: true });
});

const BASE_TABLES = [
	"outline_blocks",
	"outline_block_versions",
	"outline_block_edges",
	"outline_subtree_changes",
];

function planOf(text: string, params: Array<string | number | null>): string[] {
	// Prepared and finalized here: an EXPLAIN of an INSERT is left unfinished by a cached
	// statement, and a later write on the connection then never commits.
	const statement = database.prepare(`EXPLAIN QUERY PLAN ${text}`);
	try {
		return (statement.all(...params) as Array<{ detail: string }>).map((row) => row.detail);
	} finally {
		statement.finalize();
	}
}

/** No base table is scanned: every access to one is a SEARCH on an index or a primary key. */
function expectNoScan(plan: readonly string[]): void {
	for (const line of plan) {
		// `SCAN e`, `SCAN outline_blocks`, `SCAN b USING INDEX …` are scans; `SCAN sub`/`SCAN s`
		// read the rows a recursion or an inner SELECT made.
		const scanned = /^SCAN (\S+)/.exec(line)?.[1];
		if (scanned === undefined) continue;
		expect({
			line,
			scansBaseTable: BASE_TABLES.includes(scanned) || /^[bevxtcmp]$/.test(scanned),
		}).toEqual({ line, scansBaseTable: false });
	}
}

function lineOf(plan: readonly string[], pattern: RegExp): number {
	const at = plan.findIndex((line) => pattern.test(line));
	if (at < 0) throw new Error(`no plan line matches ${pattern}:\n${plan.join("\n")}`);
	return at;
}

function checkPlans(parent: string = wide): void {
	const asOf = Math.floor(lastSeq / 2);
	// A level as of a seq: placements by parent, then the block, then its version, by key.
	const level = planOf(SQLITE_LEVEL_AS_OF, [SPACE, parent, asOf, "", "", 51]);
	expectNoScan(level);
	// The children still there, in sibling order from the cursor on; those that left, by when.
	const edges = lineOf(
		level,
		/SEARCH e USING INDEX idx_outline_edges_open \(parent_key=\? AND \(order_key,block_id\)>\(\?,\?\)\)/,
	);
	lineOf(
		level,
		/SEARCH e USING COVERING INDEX idx_outline_edges_closed \(parent_key=\? AND to_seq>\?\)/,
	);
	// Nothing reads the placements through their primary key: that is the scan of everything
	// a parent ever held.
	expect(level.filter((line) => line.includes("sqlite_autoindex_outline_block_edges_1"))).toEqual(
		[],
	);
	const block = lineOf(level, /SEARCH b USING INDEX sqlite_autoindex_outline_blocks_1 \(id=\?\)/);
	const version = lineOf(
		level,
		/SEARCH v USING INDEX sqlite_autoindex_outline_block_versions_1 \(block_id=\? AND from_seq=\?\)/,
	);
	expect(edges).toBeLessThan(block);
	expect(block).toBeLessThan(version);
	lineOf(
		level,
		/SEARCH x USING COVERING INDEX sqlite_autoindex_outline_block_versions_1 \(block_id=\? AND from_seq<\?\)/,
	);

	// Now: the children index, by parent.
	for (const [text, params] of [
		[SQLITE_LEVEL_NOW, [SPACE, wide, "", "", 51]],
		[SQLITE_LEVEL_NOW_TOP, [SPACE, null, "", "", 51]],
	] as const) {
		const plan = planOf(text, [...params]);
		expectNoScan(plan);
		lineOf(plan, /SEARCH b USING INDEX idx_outline_blocks_children \(space_id=\? AND parent_id=\?/);
	}

	// Placements of a block, change marks, changed children: one index each.
	for (const [text, params, pattern] of [
		[
			SQLITE_PLACEMENT_AS_OF,
			[big, asOf, SPACE],
			/USING INDEX idx_outline_edges_block \(block_id=\? AND from_seq<\?\)/,
		],
		[SQLITE_PLACEMENT_NOW, [big, SPACE], /USING INDEX idx_outline_edges_block \(block_id=\?\)/],
		[
			SQLITE_SUBTREE_CHANGE,
			[big, asOf, lastSeq, SPACE],
			/SEARCH t USING COVERING INDEX sqlite_autoindex_outline_subtree_changes_1 \(ancestor_id=\? AND seq>\? AND seq<\?\)/,
		],
		[
			SQLITE_SUBTREE_CHANGE_SEQS,
			[big, lastSeq + 1, 0, 51, SPACE],
			/USING COVERING INDEX sqlite_autoindex_outline_subtree_changes_1 \(ancestor_id=\? AND seq>\? AND seq<\?\)/,
		],
		[
			SQLITE_CHANGED_CHILDREN_OPEN,
			[SPACE, parent, asOf, lastSeq, "", "", 51],
			/SEARCH e USING INDEX idx_outline_edges_open \(parent_key=\? AND \(order_key,block_id\)>\(\?,\?\)\)/,
		],
		[
			SQLITE_CHANGED_CHILDREN_CLOSED,
			[SPACE, parent, asOf, lastSeq, asOf, Number.MAX_SAFE_INTEGER, 51, "", ""],
			/SEARCH e USING COVERING INDEX idx_outline_edges_closed \(parent_key=\? AND \(to_seq,from_seq,order_key,block_id\)>\(\?,\?,\?,\?\)\)/,
		],
		[
			SQLITE_BACKFILL_SCAN,
			[SPACE, "", 2000],
			/USING COVERING INDEX uq_outline_blocks_space_sid \(space_id=\? AND sid>\?\)/,
		],
		[
			SQLITE_BACKFILL_INSERT,
			[SPACE, "", "zzzz"],
			/SEARCH b USING INDEX uq_outline_blocks_space_sid \(space_id=\? AND sid>\? AND sid<\?\)/,
		],
	] as const) {
		const plan = planOf(text, [...params]);
		expectNoScan(plan);
		lineOf(plan, pattern);
	}
}

/**
 * The commit's own recursion (every ancestor of the changed blocks): up the parent column by
 * primary key, one step a level, never a scan of the blocks.
 */
function checkMarkPlan(): void {
	const text = sqliteMarkAncestorsSql(lastSeq + 1, 4001).replace("/*ids*/", "?, ?, ?");
	const plan = planOf(text, [wide, big, hot]);
	expectNoScan(plan);
	const recursion = lineOf(plan, /RECURSIVE STEP/);
	const step = plan.findIndex(
		(line, i) =>
			i > recursion &&
			/SEARCH b USING INDEX sqlite_autoindex_outline_blocks_1 \(id=\?\)/.test(line),
	);
	expect(step).toBeGreaterThan(recursion);
	lineOf(
		plan,
		/SEARCH m USING COVERING INDEX sqlite_autoindex_outline_subtree_changes_1 \(ancestor_id=\? AND seq=\?\)/,
	);
}

function percentile(samples: number[], p: number): number {
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
}

async function timed(runs: number, fn: (i: number) => Promise<unknown>): Promise<[number, number]> {
	for (let i = 0; i < 3; i++) await fn(i);
	const samples: number[] = [];
	for (let i = 0; i < runs; i++) {
		const started = performance.now();
		await fn(i);
		samples.push(performance.now() - started);
	}
	return [percentile(samples, 50), percentile(samples, 95)];
}

const ms = ([p50, p95]: [number, number]) => `${p50.toFixed(2)} / ${p95.toFixed(2)} ms`;

describe("outline history: plans, size and timings on 100,000 blocks", () => {
	test("the reads search placements first and never scan a table, without statistics", () => {
		checkPlans();
		checkMarkPlan();
	});

	test("and after ANALYZE on the skewed data", () => {
		database.run("ANALYZE");
		checkPlans();
		checkMarkPlan();
	});

	test("plain tables against WITHOUT ROWID: bytes per row", () => {
		const size = (name: string) =>
			(
				database.query("SELECT sum(pgsize) AS bytes FROM dbstat WHERE name = ?").get(name) as {
					bytes: number;
				}
			).bytes;
		const count = (table: string) =>
			(database.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
		const edges = count("outline_block_edges");
		const marks = count("outline_subtree_changes");
		expect(count("edges_without_rowid")).toBe(edges);
		expect(count("changes_without_rowid")).toBe(marks);
		expect(edges).toBe(edgeRows);
		const plainEdges =
			size("outline_block_edges") +
			size("sqlite_autoindex_outline_block_edges_1") +
			size("idx_outline_edges_block");
		const wrEdges = size("edges_without_rowid") + size("idx_edges_wr_block");
		const plainMarks =
			size("outline_subtree_changes") + size("sqlite_autoindex_outline_subtree_changes_1");
		const wrMarks = size("changes_without_rowid");
		const versions =
			size("outline_block_versions") +
			size("sqlite_autoindex_outline_block_versions_1") +
			size("idx_outline_versions_page_range") +
			size("idx_outline_versions_commit");
		const row = (bytes: number, rows: number) => (bytes / rows).toFixed(1);
		const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
		console.log(
			[
				`[outline history size] ${BLOCKS} blocks, ${edges} placements, ${marks} marks, ${count("outline_block_versions")} versions`,
				`  placements: plain ${mib(plainEdges)} MiB (${row(plainEdges, edges)} B/row: table ${row(size("outline_block_edges"), edges)}, primary key ${row(size("sqlite_autoindex_outline_block_edges_1"), edges)}, block index ${row(size("idx_outline_edges_block"), edges)}); WITHOUT ROWID ${mib(wrEdges)} MiB (${row(wrEdges, edges)} B/row); plain is ${(plainEdges / wrEdges).toFixed(2)}x`,
				`  marks: plain ${mib(plainMarks)} MiB (${row(plainMarks, marks)} B/row: table ${row(size("outline_subtree_changes"), marks)}, primary key ${row(size("sqlite_autoindex_outline_subtree_changes_1"), marks)}); WITHOUT ROWID ${mib(wrMarks)} MiB (${row(wrMarks, marks)} B/row); plain is ${(plainMarks / wrMarks).toFixed(2)}x`,
				`  both, plain: ${mib(plainEdges + plainMarks)} MiB = ${(((plainEdges + plainMarks) / versions) * 100).toFixed(1)}% of the versions table with its indexes (${mib(versions)} MiB); WITHOUT ROWID would be ${mib(wrEdges + wrMarks)} MiB = ${(((wrEdges + wrMarks) / versions) * 100).toFixed(1)}%`,
			].join("\n"),
		);
		const byParent = size("idx_outline_edges_open") + size("idx_outline_edges_closed");
		console.log(
			`  the two by-parent indexes of the placements: ${mib(byParent)} MiB (${row(byParent, edges)} B/row: open ${mib(size("idx_outline_edges_open"))} MiB, closed ${mib(size("idx_outline_edges_closed"))} MiB), on top of the above`,
		);
		// A plain table keeps the key twice (the row and its index): more than the twin, and not
		// absurdly more.
		expect(plainEdges).toBeGreaterThan(wrEdges);
		expect(plainMarks).toBeGreaterThan(wrMarks);
		expect(plainEdges / wrEdges).toBeLessThan(3);
		expect(plainMarks / wrMarks).toBeLessThan(3);
	});

	test("churn: children that came and went do not slow a level down (0 / 100,000 / 500,000 departed)", async () => {
		const store = createSqliteOutlineHistory(() => database);
		const rnd = mulberry32(99);
		// A connection of its own for the writes, as another process would have.
		const writer = new Database(join(root, "bench.db"));
		const insert = writer.prepare(
			`INSERT INTO outline_block_edges (parent_key, block_id, from_seq, to_seq, order_key)
				 VALUES (?, ?, ?, ?, ?)`,
		);
		let departed = 0;
		/** Children of the churn parent that were there for one commit, spread over the history. */
		const depart = writer.transaction((upTo: number) => {
			for (; departed < upTo; departed++) {
				const from = 1 + Math.floor(rnd() * (lastSeq - 2));
				insert.run(
					churn,
					`gone-${String(departed).padStart(16, "0")}`,
					from,
					from + 1,
					`a${String(Math.floor(rnd() * 1e8)).padStart(8, "0")}`,
				);
			}
		});
		const lines: string[] = [];
		const recent: Array<Record<string, number>> = [];
		for (const n of [0, 100_000, 500_000]) {
			depart(n);
			if (n > 0) writer.run("ANALYZE outline_block_edges");
			checkPlans(churn);
			const measured: Record<string, number> = {};
			const run = async (name: string, runs: number, fn: () => Promise<unknown>) => {
				const t = await timed(runs, fn);
				measured[name] = t[1];
				lines.push(`  ${String(n).padStart(7)} departed, ${name}: ${ms(t)}`);
			};
			await run("level as of the latest seq, 50 of 2,000", 60, () =>
				store.listLevel(SPACE, churn, { asOf: lastSeq, limit: 50 }),
			);
			await run("subtree as of the latest seq, 800 of 2,000", 40, () =>
				store.listSubtreeAt(SPACE, churn, { asOf: lastSeq, limit: 800 }),
			);
			await run("changed children, last 1,000 commits, 200 rows", 40, () =>
				store.listChangedChildren(SPACE, churn, {
					after: lastSeq - 1000,
					upTo: lastSeq,
					limit: 200,
				}),
			);
			recent.push({ ...measured });
			// What is not bounded, stated: a read as of a seq long ago looks at every child
			// that left since (here half of the departed).
			await run("level as of the middle of the history, 50 rows", 20, () =>
				store.listLevel(SPACE, churn, { asOf: Math.floor(lastSeq / 2), limit: 50 }),
			);
		}
		writer.close();
		console.log(["[outline history churn] p50 / p95", ...lines].join("\n"));
		// The same rows whatever left before.
		const level = await store.listLevel(SPACE, churn, { asOf: lastSeq, limit: 5000 });
		expect(level.rows).toHaveLength(2000);
		expect(level.rows.every((r) => !r.id.startsWith("gone-"))).toBe(true);
		// Reads of the recent past cost the same with half a million departed children as with
		// none (within noise): a generous ceiling that the scan of everything a parent ever
		// held (65 to 100 ms here) cannot meet.
		const [none, , most] = recent as [
			Record<string, number>,
			Record<string, number>,
			Record<string, number>,
		];
		for (const name of Object.keys(none)) {
			expect({ name, p95: most[name] as number }).toEqual({
				name,
				p95: expect.any(Number),
			});
			expect(most[name] as number).toBeLessThan(Math.max(10, (none[name] as number) * 4));
		}
	}, 300_000);

	test("timings of the reads (printed), bounded whatever the subtree's size", async () => {
		const store = createSqliteOutlineHistory(() => database);
		const rnd = mulberry32(7);
		const seqAt = () => Math.floor(lastSeq * (0.5 + rnd() * 0.5));
		const results: Array<[string, [number, number]]> = [];
		const run = async (name: string, runs: number, fn: (i: number) => Promise<unknown>) => {
			results.push([name, await timed(runs, fn)]);
		};
		await run("level as of a seq, 50 of 5,000 children", 100, () =>
			store.listLevel(SPACE, wide, { asOf: seqAt(), limit: 50 }),
		);
		await run("level as of a seq, 50 children rewritten 300 times each", 100, () =>
			store.listLevel(SPACE, hot, { asOf: seqAt(), limit: 50 }),
		);
		await run("level now, 50 of 5,000 children", 100, () =>
			store.listLevel(SPACE, wide, { asOf: null, limit: 50 }),
		);
		await run("subtree as of a seq, 800 of 20,000", 60, () =>
			store.listSubtreeAt(SPACE, big, { asOf: seqAt(), limit: 800 }),
		);
		await run("subtree as of a seq, 800 of the whole space", 60, () =>
			store.listSubtreeAt(SPACE, null, { asOf: seqAt(), limit: 800 }),
		);
		await run("subtree now, 800 of 20,000", 60, () =>
			store.listSubtreeAt(SPACE, big, { asOf: null, limit: 800 }),
		);
		await run("subtree as of a seq, 2,000 of 20,000", 30, () =>
			store.listSubtreeAt(SPACE, big, { asOf: seqAt(), limit: 2000 }),
		);
		const tops = (await store.listLevel(SPACE, null, { asOf: null, limit: 100 })).rows.map(
			(r) => r.id,
		);
		await run("levels as of a seq, 100 parents, 800 rows", 60, () =>
			store.listLevels(SPACE, tops, { asOf: seqAt(), limit: 800 }),
		);
		const kids = (await store.listLevel(SPACE, big, { asOf: null, limit: 20 })).rows.map(
			(r) => r.id,
		);
		await run("changed or not, 20 blocks, a range of half the history", 100, () =>
			store.findSubtreeChanges(SPACE, kids, { after: Math.floor(lastSeq / 2), upTo: lastSeq }),
		);
		await run("changed children of a parent of 5,000, last 1,000 commits, 200 rows", 60, () =>
			store.listChangedChildren(SPACE, wide, { after: lastSeq - 1000, upTo: lastSeq, limit: 200 }),
		);
		await run("timeline of a block, 50 newest change seqs", 100, () =>
			store.listSubtreeChangeSeqs(SPACE, big, { limit: 50 }),
		);
		await run("placement of a block as of a seq (one step up)", 200, (i) =>
			store.getPlacementsAt(SPACE, [kids[i % kids.length] as string], seqAt()),
		);
		console.log(
			[
				"[outline history timings] p50 / p95",
				...results.map(([name, t]) => `  ${name}: ${ms(t)}`),
			].join("\n"),
		);
		const p95 = new Map(results.map(([name, t]) => [name, t[1]]));
		// The plan's abandon condition for reading by placement: a screen of 800 blocks of a
		// 100,000-block space, as of a seq, within 50 ms at p95.
		expect(p95.get("subtree as of a seq, 800 of 20,000") as number).toBeLessThan(50);
		expect(p95.get("subtree as of a seq, 800 of the whole space") as number).toBeLessThan(50);
		// And a level read does not grow with the text versions under it.
		expect(
			p95.get("level as of a seq, 50 children rewritten 300 times each") as number,
		).toBeLessThan(50);
	}, 120_000);
});
