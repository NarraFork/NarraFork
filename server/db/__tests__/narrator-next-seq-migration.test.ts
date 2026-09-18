/** Real migration replay plus the awaited production startup data-upgrade entrypoint. */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySqliteDataBackfills } from "../data-backfills";
import { applyPendingMigrationsByHash, runMigrations } from "../run-migrations";

type JournalEntry = { tag: string; when: number };
const MIGRATIONS_SOURCE = new URL("../../../drizzle/", import.meta.url);
const databases: Database[] = [];
const tempFolders: string[] = [];

function openDatabase(path = ":memory:"): Database {
	const database = new Database(path);
	databases.push(database);
	return database;
}

afterEach(() => {
	for (const database of databases.splice(0)) database.close();
	for (const folder of tempFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function nextSeqOf(database: Database, narratorId: string): number {
	const row = database
		.query<{ v: number }, [string]>("SELECT next_seq AS v FROM narrators WHERE id = ?")
		.get(narratorId);
	if (!row) throw new Error(`Missing narrator ${narratorId}`);
	return row.v;
}

function insertNarrator(database: Database, id: string): void {
	database.run("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)", [
		id,
		"now",
		"now",
	]);
}

function insertRef(database: Database, narratorId: string, seq: number): void {
	const id = `${narratorId}-${seq}`;
	database.run(
		"INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES (?, ?, 'user', '[]', 'now')",
		[id, narratorId],
	);
	database.run(
		"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, ?, ?, ?)",
		[id, narratorId, id, seq],
	);
}

/** Replay the actual prefix, excluding only the narrator counter migration and later entries. */
function legacyDatabaseBeforeNextSeq(path?: string): Database {
	const database = openDatabase(path);
	const journal = JSON.parse(
		readFileSync(new URL("meta/_journal.json", MIGRATIONS_SOURCE), "utf8"),
	) as { version: string; dialect: string; entries: JournalEntry[] };
	// chat_rooms has its own earlier next_seq column: a bare includes("next_seq") is wrong.
	const targetIndex = journal.entries.findIndex((entry) =>
		/ALTER TABLE `narrators` ADD `next_seq`/.test(
			readFileSync(new URL(`${entry.tag}.sql`, MIGRATIONS_SOURCE), "utf8"),
		),
	);
	expect(targetIndex).toBeGreaterThan(0);
	const prefix = journal.entries.slice(0, targetIndex);
	const folder = mkdtempSync(join(tmpdir(), "narrafork-pre-next-seq-"));
	tempFolders.push(folder);
	mkdirSync(join(folder, "meta"));
	writeFileSync(
		join(folder, "meta", "_journal.json"),
		JSON.stringify({ ...journal, entries: prefix }),
	);
	for (const entry of prefix) {
		writeFileSync(
			join(folder, `${entry.tag}.sql`),
			readFileSync(new URL(`${entry.tag}.sql`, MIGRATIONS_SOURCE)),
		);
	}
	applyPendingMigrationsByHash(database, folder);
	database.run("PRAGMA foreign_keys = ON");
	for (const id of ["narrator-refs", "narrator-empty", "narrator-gapped", "narrator-zero"]) {
		insertNarrator(database, id);
	}
	for (let seq = 0; seq < 5; seq++) insertRef(database, "narrator-refs", seq);
	insertRef(database, "narrator-gapped", 7);
	insertRef(database, "narrator-zero", 0);
	return database;
}

async function upgrade(database: Database): Promise<void> {
	await runMigrations(database);
	await applySqliteDataBackfills(database);
}

describe("narrators.next_seq column (fresh migration replay)", () => {
	test("exists as INTEGER NOT NULL DEFAULT 0 after a full replay", async () => {
		const database = openDatabase();
		await upgrade(database);
		const columns = database
			.query<{ name: string; type: string; notnull: number; dflt_value: string }, []>(
				"PRAGMA table_info(narrators)",
			)
			.all();
		expect(columns.find((row) => row.name === "next_seq")).toMatchObject({
			type: "INTEGER",
			notnull: 1,
			dflt_value: "0",
		});
	});

	test("a narrator created after migration defaults to 0 without naming the column", async () => {
		const database = openDatabase();
		await upgrade(database);
		insertNarrator(database, "narrator-new");
		expect(nextSeqOf(database, "narrator-new")).toBe(0);
	});
});

describe("narrators.next_seq startup backfill (upgrade replay)", () => {
	test("startup upgrade repairs counters even when DDL was previously stamped", async () => {
		const database = legacyDatabaseBeforeNextSeq();
		await runMigrations(database);
		expect(nextSeqOf(database, "narrator-refs")).toBe(0);
		// Simulate exiting after DDL but before startup repair. The real upgrade entrypoint
		// must repair on retry despite the column and migration hash already being present.
		await upgrade(database);
		expect(nextSeqOf(database, "narrator-refs")).toBe(5);
	});

	test("backfills MAX(refs.seq) + 1, including seq 0, sparse refs and empty narrators", async () => {
		const database = legacyDatabaseBeforeNextSeq();
		await upgrade(database);
		expect(nextSeqOf(database, "narrator-refs")).toBe(5);
		expect(nextSeqOf(database, "narrator-empty")).toBe(0);
		expect(nextSeqOf(database, "narrator-gapped")).toBe(8);
		expect(nextSeqOf(database, "narrator-zero")).toBe(1);
	});

	test("repeated startup never lowers already claimed counters, even with no refs", async () => {
		const database = legacyDatabaseBeforeNextSeq();
		await upgrade(database);
		insertNarrator(database, "narrator-after");
		expect(nextSeqOf(database, "narrator-after")).toBe(0);
		database.run(
			"UPDATE narrators SET next_seq = 41 WHERE id IN ('narrator-refs', 'narrator-empty')",
		);
		await upgrade(database);
		await upgrade(database);
		expect(nextSeqOf(database, "narrator-refs")).toBe(41);
		expect(nextSeqOf(database, "narrator-empty")).toBe(41);
		expect(nextSeqOf(database, "narrator-gapped")).toBe(8);
	});

	test("yields outside transactions and resumes a cancelled partial upgrade after reopening", async () => {
		const folder = mkdtempSync(join(tmpdir(), "narrafork-next-seq-restart-"));
		tempFolders.push(folder);
		const path = join(folder, "test.db");
		const database = legacyDatabaseBeforeNextSeq(path);
		await runMigrations(database);
		for (let n = 0; n < 180; n++) {
			const id = `batch-${String(n).padStart(3, "0")}`;
			insertNarrator(database, id);
			insertRef(database, id, n * 2);
		}
		const controller = new AbortController();
		let observedYield = false;
		const interruption = new Error("simulated startup interruption");
		const interrupt = setImmediate(() => {
			observedYield = true;
			expect(database.inTransaction).toBe(false);
			controller.abort(interruption);
		});
		try {
			await expect(
				applySqliteDataBackfills(database, { signal: controller.signal }),
			).rejects.toThrow("simulated startup interruption");
		} finally {
			clearImmediate(interrupt);
		}
		expect(observedYield).toBe(true);
		expect(nextSeqOf(database, "batch-000")).toBe(1);
		expect(nextSeqOf(database, "batch-179")).toBe(0);
		database.run("UPDATE narrators SET next_seq = 901 WHERE id = 'batch-000'");
		databases.splice(databases.indexOf(database), 1);
		database.close();

		const reopened = openDatabase(path);
		await upgrade(reopened);
		for (let n = 1; n < 180; n++) {
			expect(nextSeqOf(reopened, `batch-${String(n).padStart(3, "0")}`)).toBe(n * 2 + 1);
		}
		expect(nextSeqOf(reopened, "batch-000")).toBe(901);
		expect(nextSeqOf(reopened, "narrator-refs")).toBe(5);
	});

	for (const fail of [false, true]) {
		test(`lifecycle awaits required data upgrade before readiness (fail=${fail})`, async () => {
			const home = mkdtempSync(join(tmpdir(), "narrafork-next-seq-lifecycle-"));
			tempFolders.push(home);
			const seeded = legacyDatabaseBeforeNextSeq(join(home, "narrafork.db"));
			databases.splice(databases.indexOf(seeded), 1);
			seeded.close();
			const savedHome = process.env.NARRAFORK_HOME;
			const savedMultiple = process.env.NARRAFORK_ALLOW_MULTIPLE;
			const stateKey = Symbol.for("narrafork.dbLifecycle");
			const savedState = Reflect.get(globalThis, stateKey);
			Reflect.deleteProperty(globalThis, stateKey);
			process.env.NARRAFORK_HOME = home;
			process.env.NARRAFORK_ALLOW_MULTIPLE = "1";
			const { createSqliteLifecycle } = await import("../backend/sqlite-lifecycle");
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let ready = false;
			const lifecycle = createSqliteLifecycle({
				applyDataBackfills: async (connection) => {
					entered.resolve();
					await release.promise;
					if (fail) throw new Error("required upgrade rejected");
					await applySqliteDataBackfills(connection);
					expect(nextSeqOf(connection, "narrator-gapped")).toBe(8);
					// Startup must not initialize search or report ready before repair finishes.
					expect(
						connection
							.query("SELECT 1 FROM sqlite_master WHERE name = 'narrator_messages_fts'")
							.get(),
					).toBeNull();
				},
			});
			try {
				const startup = lifecycle.start().then(() => {
					ready = true;
				});
				await entered.promise;
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(ready).toBe(false);
				release.resolve();
				if (fail) await expect(startup).rejects.toThrow("required upgrade rejected");
				else await startup;
				expect(ready).toBe(!fail);
				if (!fail) expect(nextSeqOf(lifecycle.connection, "narrator-refs")).toBe(5);
			} finally {
				release.resolve();
				lifecycle.abandonWithoutCleanMarker();
				lifecycle.connection.close();
				Reflect.set(globalThis, stateKey, savedState);
				if (savedHome === undefined) delete process.env.NARRAFORK_HOME;
				else process.env.NARRAFORK_HOME = savedHome;
				if (savedMultiple === undefined) delete process.env.NARRAFORK_ALLOW_MULTIPLE;
				else process.env.NARRAFORK_ALLOW_MULTIPLE = savedMultiple;
			}
		});
	}

	test("an SQL failure rolls back the page and a later startup retries it", async () => {
		const database = legacyDatabaseBeforeNextSeq();
		await runMigrations(database);
		database.run(`CREATE TRIGGER fail_counter BEFORE UPDATE OF next_seq ON narrators
			WHEN NEW.id = 'narrator-zero' BEGIN SELECT RAISE(ABORT, 'counter write failed'); END`);
		await expect(applySqliteDataBackfills(database)).rejects.toThrow("counter write failed");
		expect(nextSeqOf(database, "narrator-zero")).toBe(0);
		expect(database.inTransaction).toBe(false);
		database.run("DROP TRIGGER fail_counter");
		await upgrade(database);
		expect(nextSeqOf(database, "narrator-zero")).toBe(1);
		expect(nextSeqOf(database, "narrator-refs")).toBe(5);
	});
});
