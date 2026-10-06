/**
 * narrators.next_seq: column shape + the NEW write-path contract.
 *
 * Startup no longer scans every narrator to raise next_seq. After DDL the counter
 * may stay 0 while refs hold historical seqs; the first process-lifetime claim via
 * a choke point (raise floor inside the write tx, mark healed after commit) repairs
 * that narrator only. `applySqliteDataBackfills` must leave next_seq untouched.
 */
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

/** First-write repair: raise floor in-tx then pure counter claim (choke-point shape). */
function firstClaimRepairingFloor(database: Database, narratorId: string): number {
	// bun:sqlite Database.transaction returns a runner; invoke it to execute + get the result.
	return database.transaction(() => {
		const top =
			database
				.query<{ v: number | null }, [string]>(
					"SELECT MAX(seq) AS v FROM narrator_message_refs WHERE narrator_id = ?",
				)
				.get(narratorId)?.v ?? null;
		const floor = (top ?? -1) + 1;
		database.run("UPDATE narrators SET next_seq = max(next_seq, ?) WHERE id = ?", [
			floor,
			narratorId,
		]);
		const before = nextSeqOf(database, narratorId);
		database.run("UPDATE narrators SET next_seq = next_seq + 1 WHERE id = ?", [narratorId]);
		return before;
	})();
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

describe("narrators.next_seq is NOT repaired at startup", () => {
	test("applySqliteDataBackfills leaves next_seq at 0 even when refs have high seqs", async () => {
		const database = legacyDatabaseBeforeNextSeq();
		await runMigrations(database);
		expect(nextSeqOf(database, "narrator-refs")).toBe(0);
		await applySqliteDataBackfills(database);
		// Startup must not full-scan narrators to raise counters (boot cost).
		expect(nextSeqOf(database, "narrator-refs")).toBe(0);
		expect(nextSeqOf(database, "narrator-gapped")).toBe(0);
		expect(nextSeqOf(database, "narrator-zero")).toBe(0);
	});

	test("first write repairs that narrator only: MAX(refs)+1 then claim", async () => {
		const database = legacyDatabaseBeforeNextSeq();
		await upgrade(database);

		const seqRefs = firstClaimRepairingFloor(database, "narrator-refs");
		expect(seqRefs).toBe(5);
		expect(nextSeqOf(database, "narrator-refs")).toBe(6);

		// Untouched siblings stay at 0 — no global scan.
		expect(nextSeqOf(database, "narrator-gapped")).toBe(0);
		const seqGapped = firstClaimRepairingFloor(database, "narrator-gapped");
		expect(seqGapped).toBe(8);
		expect(nextSeqOf(database, "narrator-empty")).toBe(0);
		const seqEmpty = firstClaimRepairingFloor(database, "narrator-empty");
		expect(seqEmpty).toBe(0);
		const seqZero = firstClaimRepairingFloor(database, "narrator-zero");
		expect(seqZero).toBe(1);
	});

	test("already-raised counters are not lowered by a later first-write repair", async () => {
		const database = legacyDatabaseBeforeNextSeq();
		await upgrade(database);
		database.run("UPDATE narrators SET next_seq = 41 WHERE id = 'narrator-refs'");
		const seq = firstClaimRepairingFloor(database, "narrator-refs");
		expect(seq).toBe(41);
		expect(nextSeqOf(database, "narrator-refs")).toBe(42);
	});

	test("failed first-write transaction rolls back the floor raise (no false repair)", async () => {
		const database = legacyDatabaseBeforeNextSeq();
		await upgrade(database);
		expect(() =>
			database.transaction(() => {
				database.run(
					"UPDATE narrators SET next_seq = max(next_seq, COALESCE((SELECT MAX(seq)+1 FROM narrator_message_refs WHERE narrator_id = narrators.id), 0)) WHERE id = ?",
					["narrator-refs"],
				);
				expect(nextSeqOf(database, "narrator-refs")).toBe(5);
				throw new Error("simulated claim failure");
			})(),
		).toThrow("simulated claim failure");
		expect(nextSeqOf(database, "narrator-refs")).toBe(0);
		// A later successful first-write still repairs correctly.
		expect(firstClaimRepairingFloor(database, "narrator-refs")).toBe(5);
	});
});

describe("other startup data backfills still run", () => {
	test("legacy status values migrate without touching next_seq", async () => {
		const database = openDatabase();
		await runMigrations(database);
		insertNarrator(database, "n-status");
		database.run("UPDATE narrators SET status = 'done' WHERE id = 'n-status'");
		await applySqliteDataBackfills(database);
		const row = database
			.query<{ status: string; substatus: string }, [string]>(
				"SELECT status, substatus FROM narrators WHERE id = ?",
			)
			.get("n-status");
		expect(row?.status).toBe("idle");
		expect(JSON.parse(row?.substatus ?? "[]")).toContain("unread");
	});
});
