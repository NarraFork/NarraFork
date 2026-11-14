/**
 * The golden upgrade test (pageless plan §二.4): a database in the shape the main branch has
 * today, holding an outline with history, is migrated and converted, and the new tables must
 * describe exactly its live tree.
 *
 * The fixture is always built from the MAIN BRANCH'S SCHEMA: the committed migrations up to
 * {@link MAIN_HEAD_MIGRATION}, applied to a database file of the test's own, then filled with
 * rows written as that schema writes them. Everything after that is what an upgrade runs: the
 * rest of the committed migrations, the copy of the outline's tables (the real snapshot
 * process), and the conversion through the SQLite history port over that file.
 *
 * ISOLATION: its own database file in a temp directory; the application's database is not used.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPendingMigrationsByHash } from "../../../db/run-migrations";
import { closeSnapshotBuilds } from "../../../db/snapshot-build";
import {
	backupOutlineTables,
	backupOutlineTablesFresh,
	OUTLINE_BACKUP_MIN_FREE_BYTES,
	OutlineBackupSpaceError,
	readOutlineBackup,
} from "../history-backup";
import { convertOutlineHistory } from "../history-convert";
import type { OutlineLevelCursor } from "../store/history-port";
import { createSqliteOutlineHistory } from "../store/sqlite-history";

/** The last migration of the main branch: the shape the fixture is written in. */
const MAIN_HEAD_MIGRATION = "0256_outline_spec_loss";
const MIGRATIONS = join(import.meta.dir, "../../../../drizzle");

const root = mkdtempSync(join(tmpdir(), "nf-outline-upgrade-"));
afterAll(async () => {
	await closeSnapshotBuilds().catch(() => {});
	rmSync(root, { recursive: true, force: true });
});

/** The committed migrations up to and including `tag`, as a folder of their own. */
function migrationsUpTo(tag: string): string {
	const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8")) as {
		entries: Array<{ tag: string }>;
	};
	const at = journal.entries.findIndex((entry) => entry.tag === tag);
	expect(at).toBeGreaterThan(0);
	// The fixture's shape is not the newest one: this branch adds migrations after it.
	expect(at).toBeLessThan(journal.entries.length - 1);
	const folder = join(root, "main-migrations");
	mkdirSync(join(folder, "meta"), { recursive: true });
	const entries = journal.entries.slice(0, at + 1);
	writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
	for (const entry of entries) {
		writeFileSync(
			join(folder, `${entry.tag}.sql`),
			readFileSync(join(MIGRATIONS, `${entry.tag}.sql`)),
		);
	}
	return folder;
}

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

interface FixtureBlock {
	id: string;
	parentId: string | null;
	pageId: string;
	orderKey: string;
	deleted: boolean;
}

/**
 * One space with `count` blocks in a random forest, a history behind them (every block was
 * created by a commit of its own; some were rewritten, some stood under another parent first,
 * some are deleted now), written with the main branch's columns only.
 */
function seedSpace(
	database: Database,
	space: { id: string; key: string },
	count: number,
	seed: number,
): FixtureBlock[] {
	const rnd = mulberry32(seed);
	const blocks: FixtureBlock[] = [];
	const insertBlock = database.prepare(
		`INSERT INTO outline_blocks (id, space_id, sid, parent_id, page_id, order_key, content,
			content_hash, alias, task_json, ask_json, author_kind, author_id, version_seq, deleted,
			in_process)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'human', 'u1', ?, ?, 0)`,
	);
	const insertVersion = database.prepare(
		`INSERT INTO outline_block_versions (block_id, from_seq, to_seq, commit_id, page_id,
			parent_id, order_key, content, task_json, ask_json, alias, content_hash, change_flags,
			deleted)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
	);
	const insertCommit = database.prepare(
		`INSERT INTO outline_commits (id, space_id, seq, kind, actor_kind, actor_id,
			responsible_user_id, narrator_id, message_id, tool_call_id, created_at, summary)
		 VALUES (?, ?, ?, 'edit', 'human', 'u1', NULL, NULL, NULL, NULL, '2026-11-01T00:00:00.000Z', ?)`,
	);
	let seq = 0;
	const commit = (summary: string): { seq: number; id: string } => {
		seq++;
		const id = `${space.id}-c${seq}`;
		insertCommit.run(id, space.id, seq, summary);
		return { seq, id };
	};
	database.transaction(() => {
		// sids in an order unrelated to creation, so batches by sid cut across the tree.
		const sidOf = (i: number) => `s${Math.floor(rnd() * 1e9).toString(36)}x${i}`;
		for (let i = 0; i < count; i++) {
			const id = `${space.id}-b${i}`;
			const live = blocks.filter((b) => !b.deleted);
			const parent =
				live.length === 0 || rnd() < 0.08
					? null
					: (live[Math.floor(rnd() * live.length)] as FixtureBlock);
			const block: FixtureBlock = {
				id,
				parentId: parent?.id ?? null,
				pageId: parent?.pageId ?? id,
				orderKey: `k${String(Math.floor(rnd() * 1e6)).padStart(6, "0")}${i}`,
				deleted: false,
			};
			blocks.push(block);
			const task = rnd() < 0.1 ? '{"status":"todo","assignee":null}' : null;
			const alias = rnd() < 0.05 ? `A${i}` : null;
			const created = commit(`create ${i}`);
			const history: Array<{
				from: number;
				commitId: string;
				parentId: string | null;
				pageId: string;
				orderKey: string;
				content: string | null;
				flags: number;
				deleted: boolean;
			}> = [];
			// Some blocks stood somewhere else first: a closed version under another parent.
			const elsewhere = rnd() < 0.3 && live.length > 1;
			const first = elsewhere ? (live[Math.floor(rnd() * live.length)] as FixtureBlock) : parent;
			history.push({
				from: created.seq,
				commitId: created.id,
				parentId: elsewhere ? (first?.id ?? null) : block.parentId,
				pageId: elsewhere ? (first?.pageId ?? id) : block.pageId,
				orderKey: elsewhere ? "k000000old" : block.orderKey,
				content: `first text ${i}`,
				flags: 1,
				deleted: false,
			});
			const rewrites = Math.floor(rnd() * 3) + (elsewhere ? 1 : 0);
			for (let r = 0; r < rewrites; r++) {
				const c = commit(`rewrite ${i}.${r}`);
				history.push({
					from: c.seq,
					commitId: c.id,
					parentId: block.parentId,
					pageId: block.pageId,
					orderKey: block.orderKey,
					content: `text ${i} rev ${r}`,
					flags: r === 0 && elsewhere ? 2 | 4 : 2,
					deleted: false,
				});
			}
			history.forEach((v, n) => {
				const next = history[n + 1];
				insertVersion.run(
					id,
					v.from,
					next ? next.from : null,
					v.commitId,
					v.pageId,
					v.parentId,
					v.orderKey,
					v.content,
					task,
					alias,
					`hash-${v.content}`,
					v.flags,
					0,
				);
			});
			const last = history.at(-1);
			insertBlock.run(
				id,
				space.id,
				sidOf(i),
				block.parentId,
				block.pageId,
				block.orderKey,
				last?.content ?? "",
				`hash-${last?.content}`,
				alias,
				task,
				last?.from ?? 0,
				0,
			);
		}
		// Delete some leaves and a few subtrees: a tombstone version for each block that goes.
		const kids = (id: string) => blocks.filter((b) => b.parentId === id && !b.deleted);
		for (const victim of blocks.filter(() => rnd() < 0.06)) {
			if (victim.deleted) continue;
			const c = commit(`delete ${victim.id}`);
			const going = [victim];
			for (let at = 0; at < going.length; at++) going.push(...kids((going[at] as FixtureBlock).id));
			for (const block of going) {
				block.deleted = true;
				database.run(
					"UPDATE outline_block_versions SET to_seq = ? WHERE block_id = ? AND to_seq IS NULL",
					[c.seq, block.id],
				);
				insertVersion.run(
					block.id,
					c.seq,
					null,
					c.id,
					block.pageId,
					block.parentId,
					block.orderKey,
					null,
					null,
					null,
					"hash-gone",
					8,
					1,
				);
				database.run(
					"UPDATE outline_blocks SET deleted = 1, alias = NULL, version_seq = ? WHERE id = ?",
					[c.seq, block.id],
				);
			}
		}
		database.run(
			`INSERT INTO outline_spaces (id, key, kind, project_id, narrator_id, owner_user_id,
				next_seq, created_at, in_process_ready, in_process_epoch, last_commit_at)
			 VALUES (?, ?, 'personal', NULL, NULL, NULL, ?, '2026-11-01T00:00:00.000Z', 1, 0, NULL)`,
			[space.id, space.key, seq + 1],
		);
	})();
	return blocks;
}

function tableDump(database: Database, table: string, order: string): string {
	return JSON.stringify(database.query(`SELECT * FROM ${table} ORDER BY ${order}`).values());
}

describe("outline pageless upgrade (golden)", () => {
	test("a main-branch database is migrated and converted: the placements are exactly the live tree", async () => {
		const dbPath = join(root, "narrafork.db");
		const database = new Database(dbPath);
		database.run("PRAGMA journal_mode = WAL");
		try {
			// ── today's shape ────────────────────────────────────────────────────────
			applyPendingMigrationsByHash(database, migrationsUpTo(MAIN_HEAD_MIGRATION));
			const has = (table: string) =>
				database.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(table) !== null;
			expect(has("outline_blocks")).toBe(true);
			expect(has("outline_block_edges")).toBe(false);
			const spaces = [
				{ id: "space-a", key: "aaaa", count: 700, seed: 11 },
				{ id: "space-b", key: "bbbb", count: 45, seed: 12 },
			];
			const fixture = new Map<string, FixtureBlock[]>();
			for (const space of spaces)
				fixture.set(space.id, seedSpace(database, space, space.count, space.seed));
			// A space nobody wrote to yet, and rows of page-keyed tables that must stay.
			database.run(
				`INSERT INTO outline_spaces (id, key, kind, next_seq, created_at)
					 VALUES ('space-empty', 'eeee', 'personal', 1, '2026-11-01T00:00:00.000Z')`,
			);
			database.run(
				`INSERT INTO outline_view_state (user_id, page_block_id, collapsed_json, layout, updated_at)
					 VALUES ('u1', 'space-a-b0', '["space-a-b1"]', 'right', '2026-11-01T00:00:00.000Z')`,
			);
			const kept = ["outline_blocks", "outline_block_versions", "outline_commits"] as const;
			const order = {
				outline_blocks: "id",
				outline_block_versions: "block_id, from_seq",
				outline_commits: "id",
			};
			const before = new Map(kept.map((t) => [t, tableDump(database, t, order[t])]));
			const viewStateBefore = tableDump(database, "outline_view_state", "user_id");
			const inode = statSync(dbPath).ino;
			const nextSeqBefore = new Map(
				database.query("SELECT id, next_seq FROM outline_spaces").values() as [string, number][],
			);

			// ── the upgrade: the rest of the migrations ──────────────────────────────
			applyPendingMigrationsByHash(database, MIGRATIONS);
			expect(has("outline_block_edges")).toBe(true);
			expect(has("outline_subtree_changes")).toBe(true);
			expect(
				database
					.query("SELECT id, history_floor_seq, edges_ready FROM outline_spaces ORDER BY id")
					.values(),
			).toEqual([
				["space-a", 0, 0],
				["space-b", 0, 0],
				["space-empty", 0, 0],
			]);

			// ── the copy, then the conversion, a few blocks a transaction ────────────
			const store = createSqliteOutlineHistory(() => database);
			const backups = join(root, "backups");
			const backup = async () =>
				(await backupOutlineTables({ sourcePath: dbPath, directory: backups })).path;
			// Stopped after its second transaction, then run again: it picks up where the tables are.
			const stop = new AbortController();
			let seen = 0;
			const interrupted = await convertOutlineHistory({
				store,
				backup,
				rows: 60,
				signal: stop.signal,
				onBatch: () => {
					if (++seen === 2) stop.abort();
				},
			});
			expect(interrupted.spaces).toBe(0);
			expect(interrupted.left).toBeGreaterThan(0);
			expect(interrupted.backup).toMatch(/outline-before-pageless-\d{4}-\d{2}-\d{2}\.db$/);
			const placedByFirstRun = (
				database.query("SELECT count(*) AS n FROM outline_block_edges").get() as { n: number }
			).n;
			expect(placedByFirstRun).toBeGreaterThan(0);
			const result = await convertOutlineHistory({ store, backup, rows: 60 });
			expect(result).toMatchObject({ spaces: 3, left: 0, backup: interrupted.backup });
			const allBlocks = [...fixture.values()].flat();
			const live = allBlocks.filter((b) => !b.deleted);
			expect(live.length).toBeGreaterThan(500);
			expect(allBlocks.length - live.length).toBeGreaterThan(20);
			expect(result.blocks).toBe(allBlocks.length);
			expect(result.placed).toBe(live.length - placedByFirstRun);
			console.log(
				`[outline upgrade] ${allBlocks.length} blocks (${live.length} live) in 3 spaces converted in ${result.ms} ms; first, interrupted run ${interrupted.ms} ms including the copy`,
			);

			// ── the copy is the outline as it was ────────────────────────────────────
			expect((await readdir(backups)).filter((name) => !name.endsWith(".db"))).toEqual([]);
			const copy = new Database(interrupted.backup as string, { readonly: true });
			try {
				for (const t of kept) expect(tableDump(copy, t, order[t])).toBe(before.get(t) as string);
				expect(tableDump(copy, "outline_view_state", "user_id")).toBe(viewStateBefore);
				const copied = (
					copy
						.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
						.values() as [string][]
				).map(([name]) => name);
				const source = (
					database
						.query(
							"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'outline!_%' ESCAPE '!' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name",
						)
						.values() as [string][]
				).map(([name]) => name);
				// Every outline table, and the stamp the copy wrote last.
				expect(copied.filter((name) => !name.startsWith("backup_"))).toEqual(source);
				expect(copied).toContain("outline_spec_imports");
				expect(readOutlineBackup(interrupted.backup as string)).toMatchObject({
					format: 1,
					sourcePath: dbPath,
					tables: source.length,
					spaces: 3,
				});
				expect(
					copy
						.query("SELECT space_id, next_seq, blocks FROM backup_spaces ORDER BY space_id")
						.values(),
				).toEqual([
					["space-a", nextSeqBefore.get("space-a") as number, 700],
					["space-b", nextSeqBefore.get("space-b") as number, 45],
					["space-empty", 1, 0],
				]);
			} finally {
				copy.close();
			}

			// ── the new tables describe exactly the live tree ────────────────────────
			const spaceOf = (id: string) => id.slice(0, id.lastIndexOf("-b"));
			expect(
				database
					.query(
						"SELECT parent_key, block_id, from_seq, to_seq, order_key FROM outline_block_edges ORDER BY block_id",
					)
					.values() as unknown[][],
			).toEqual(
				live
					.map((b): unknown[] => [b.parentId ?? spaceOf(b.id), b.id, 0, null, b.orderKey])
					.sort((x, y) => ((x[1] as string) < (y[1] as string) ? -1 : 1)),
			);
			expect(database.query("SELECT count(*) AS n FROM outline_subtree_changes").get()).toEqual({
				n: 0,
			});
			const nextSeq = (id: string) =>
				(
					database.query("SELECT next_seq AS n FROM outline_spaces WHERE id = ?").get(id) as {
						n: number;
					}
				).n;
			expect(
				[...(await store.getHistoryStates(["space-a", "space-b", "space-empty"]))].sort(),
			).toEqual([
				["space-a", { floorSeq: nextSeq("space-a") - 1, edgesReady: true }],
				["space-b", { floorSeq: nextSeq("space-b") - 1, edgesReady: true }],
				["space-empty", { floorSeq: 0, edgesReady: true }],
			]);
			expect(await store.listSpacesPendingEdges({ limit: 10 })).toEqual([]);

			// Read back through the port, level by level, as of the floor and now.
			for (const space of spaces) {
				const mine = (fixture.get(space.id) as FixtureBlock[]).filter((b) => !b.deleted);
				const want = new Map<string | null, string[]>();
				for (const b of [...mine].sort((x, y) =>
					x.orderKey !== y.orderKey ? (x.orderKey < y.orderKey ? -1 : 1) : x.id < y.id ? -1 : 1,
				)) {
					const list = want.get(b.parentId);
					if (list) list.push(b.id);
					else want.set(b.parentId, [b.id]);
				}
				for (const asOf of [nextSeq(space.id) - 1, null]) {
					const got = new Map<string | null, string[]>();
					const queue: Array<string | null> = [null];
					for (let at = 0; at < queue.length; at++) {
						const parent = queue[at] as string | null;
						let after: OutlineLevelCursor | null = null;
						for (;;) {
							const page = await store.listLevel(space.id, parent, { asOf, after, limit: 7 });
							for (const row of page.rows) {
								const list = got.get(parent);
								if (list) list.push(row.id);
								else got.set(parent, [row.id]);
								expect(row.hasChildren).toBe(want.has(row.id));
								if (row.hasChildren) queue.push(row.id);
							}
							if (!page.next) break;
							after = page.next;
						}
					}
					expect([...got].sort()).toEqual([...want].sort());
					const all = await store.listSubtreeAt(space.id, null, { asOf, limit: 5000 });
					expect(all.rows.map((r) => r.id).sort()).toEqual(mine.map((b) => b.id).sort());
				}
			}

			// ── nothing else changed, and running again changes nothing ──────────────
			for (const t of kept) {
				const now = database
					.query(`SELECT * FROM ${t} ORDER BY ${order[t]}`)
					.values() as unknown[][];
				expect(JSON.stringify(now)).toBe(before.get(t) as string);
			}
			expect(tableDump(database, "outline_view_state", "user_id")).toBe(viewStateBefore);
			expect(statSync(dbPath).ino).toBe(inode);
			const edges = tableDump(database, "outline_block_edges", "block_id, from_seq");
			const spacesAfter = tableDump(database, "outline_spaces", "id");
			const again = await convertOutlineHistory({
				store,
				backup: async () => {
					throw new Error("the copy is not made again when no space is waiting");
				},
			});
			expect(again).toMatchObject({ spaces: 0, blocks: 0, placed: 0, left: 0, backup: null });
			expect(tableDump(database, "outline_block_edges", "block_id, from_seq")).toBe(edges);
			expect(tableDump(database, "outline_spaces", "id")).toBe(spacesAfter);
			// The copy is kept, and asked for again it is found, not rewritten.
			const copyStat = statSync(interrupted.backup as string);
			const found = await backupOutlineTables({ sourcePath: dbPath, directory: backups });
			expect(found).toMatchObject({ path: interrupted.backup as string, created: false });
			expect(statSync(found.path).mtimeMs).toBe(copyStat.mtimeMs);
		} finally {
			database.close();
		}
	}, 120_000);

	test("a copy that cannot be made leaves no file behind and converts nothing", async () => {
		const directory = join(root, "no-copy");
		await expect(
			backupOutlineTables({ sourcePath: join(root, "missing.db"), directory }),
		).rejects.toThrow(/snapshot builder failed/);
		expect(await readdir(directory)).toEqual([]);
	});

	test("only a validated copy of this database, current for the spaces asked, counts as a copy", async () => {
		const dbPath = join(root, "narrafork.db");
		const directory = join(root, "backups-judged");
		mkdirSync(directory);
		const today = new Date("2026-11-14T10:00:00.000Z");
		// Files with a copy's name that are not copies: empty, a database without a stamp, and a
		// partial file of an earlier day.
		const empty = join(directory, "outline-before-pageless-2026-11-14.db");
		writeFileSync(empty, "");
		const bare = join(directory, "outline-before-pageless-2026-11-13.db");
		const unstamped = new Database(bare);
		unstamped.run("CREATE TABLE outline_blocks (id TEXT)");
		unstamped.close();
		const stalePartial = join(directory, "outline-before-pageless-2026-11-01.db.partial");
		writeFileSync(stalePartial, "half a copy");
		const mine = join(directory, "notes.partial");
		writeFileSync(mine, "not this module's file");
		expect(readOutlineBackup(empty)).toBeNull();
		expect(readOutlineBackup(bare)).toBeNull();
		expect(readOutlineBackup(join(directory, "missing.db"))).toBeNull();

		const first = await backupOutlineTables({ sourcePath: dbPath, directory, now: today });
		// A new copy under a name of its own; the impostors are left exactly as they were.
		expect(first.created).toBe(true);
		expect(first.path).toBe(join(directory, "outline-before-pageless-2026-11-14-2.db"));
		expect(first.stamp).toMatchObject({ format: 1, sourcePath: dbPath, spaces: 3 });
		expect(statSync(empty).size).toBe(0);
		expect(readOutlineBackup(bare)).toBeNull();
		expect((await readdir(directory)).sort()).toEqual([
			"notes.partial",
			"outline-before-pageless-2026-11-13.db",
			"outline-before-pageless-2026-11-14-2.db",
			"outline-before-pageless-2026-11-14.db",
		]);

		const source = new Database(dbPath, { readonly: true });
		const seqs = new Map(
			source.query("SELECT id, next_seq FROM outline_spaces").values() as [string, number][],
		);
		source.close();
		// Current for the spaces asked: found, not made again.
		const again = await backupOutlineTables({
			sourcePath: dbPath,
			directory,
			expect: seqs,
			now: today,
		});
		expect(again).toMatchObject({ path: first.path, created: false });
		// The spaces have moved on since (a conversion resumed after more commits, four times):
		// the copy is of this database's past, which is enough; no second copy is written.
		const listing = (await readdir(directory)).sort();
		const moved = new Map(seqs);
		for (let resume = 1; resume <= 4; resume++) {
			moved.set("space-a", (seqs.get("space-a") as number) + resume);
			moved.set("space-b", (seqs.get("space-b") as number) + 2 * resume);
			const resumed = await backupOutlineTables({
				sourcePath: dbPath,
				directory,
				expect: moved,
				now: today,
			});
			expect(resumed).toMatchObject({ path: first.path, created: false });
		}
		expect((await readdir(directory)).sort()).toEqual(listing);
		// A copy that is ahead of the database, or lacks a space asked for, is not its past.
		const behind = new Map(seqs).set("space-a", (seqs.get("space-a") as number) - 1);
		const newer = await backupOutlineTables({
			sourcePath: dbPath,
			directory,
			expect: behind,
			now: today,
		});
		expect(newer.created).toBe(true);
		expect(newer.path).toBe(join(directory, "outline-before-pageless-2026-11-14-3.db"));
		const unknown = await backupOutlineTables({
			sourcePath: dbPath,
			directory,
			expect: new Map(seqs).set("space-new", 1),
			now: today,
		});
		expect(unknown.created).toBe(true);
		// A copy of another database file is not a copy of this one.
		const elsewhere = join(root, "elsewhere.db");
		writeFileSync(elsewhere, readFileSync(dbPath));
		const other = await backupOutlineTables({ sourcePath: elsewhere, directory, now: today });
		expect(other.created).toBe(true);
		expect(other.stamp.sourcePath).toBe(elsewhere);
		// Fresh: always a new one, whatever is there; the others stay.
		const before = (await readdir(directory)).sort();
		const fresh = await backupOutlineTablesFresh({ sourcePath: dbPath, directory, now: today });
		expect(fresh.created).toBe(true);
		expect(before).not.toContain(fresh.path.slice(directory.length + 1));
		expect((await readdir(directory)).sort()).toEqual(
			[...before, fresh.path.slice(directory.length + 1)].sort(),
		);
		expect(readOutlineBackup(fresh.path)).toEqual(fresh.stamp);
		// Of several usable copies the one stamped latest is used, whatever its name sorts as.
		const chosen = await backupOutlineTables({ sourcePath: dbPath, directory, expect: seqs });
		expect(chosen).toMatchObject({ path: fresh.path, created: false });

		// Too little room to start: refused before anything is written, and the reason says so.
		const cramped = join(root, "backups-cramped");
		let refused: unknown;
		try {
			await backupOutlineTables({
				sourcePath: dbPath,
				directory: cramped,
				freeBytes: async () => OUTLINE_BACKUP_MIN_FREE_BYTES - 1,
			});
		} catch (error) {
			refused = error;
		}
		expect(refused).toBeInstanceOf(OutlineBackupSpaceError);
		expect((refused as OutlineBackupSpaceError).freeBytes).toBe(OUTLINE_BACKUP_MIN_FREE_BYTES - 1);
		expect(await readdir(cramped)).toEqual([]);
		// The floor is fixed: a database far larger than the free space is not a reason to
		// refuse (its outline may be small), and an unknown free space is not one either.
		for (const free of [OUTLINE_BACKUP_MIN_FREE_BYTES, null]) {
			const made = await backupOutlineTablesFresh({
				sourcePath: dbPath,
				directory: cramped,
				freeBytes: async () => free,
			});
			expect(made.created).toBe(true);
		}

		// Stopped while it is being made: no file with a final name, no partial left.
		const stopped = join(root, "backups-stopped");
		const stop = new AbortController();
		stop.abort();
		await expect(
			backupOutlineTables({ sourcePath: dbPath, directory: stopped, signal: stop.signal }),
		).rejects.toThrow();
		expect(await readdir(stopped)).toEqual([]);
	}, 120_000);
});
