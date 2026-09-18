/**
 * The SQLite maintenance adapter and the capability vocabulary it answers with.
 *
 * WHY THE ASSERTIONS BELOW ARE THE ONES THAT MATTER
 * ------------------------------------------------
 * Every operation here is engine-shaped, and the dangerous failure mode is not a crash — it is a
 * FABRICATED NUMBER. `freelistBytes: 0` reads as "nothing to reclaim"; `checkpointRan: true` for a
 * checkpoint that threw reads as "the WAL was flushed". Both are shown to an operator deciding
 * whether to take a maintenance window. So the tests pin three distinctions the code must keep:
 *
 *   1. absent capability (`supported: false`) vs. failed attempt (`supported: true, ok: false`).
 *      Collapsing them is how a backend that cannot checkpoint ends up reported as one that
 *      checkpointed successfully.
 *   2. best-effort vs. must-succeed. `checkpoint` / `refreshPlannerStatistics` report failure;
 *      `reclaimSpace` THROWS, because a maintenance window that silently did nothing is worse than
 *      an error — the operator sat through the outage and would be told it worked.
 *   3. conflict vs. generic error. `classifyFailure` is what removes
 *      `/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i` from service code; a conflict is retryable
 *      (HTTP 409) and anything else is not.
 *
 * VACUUM here runs against a small temp database this test created, inside its own maintenance
 * scope. That is not "running production maintenance": no server is involved, the file is a few
 * hundred KB, and it is deleted in `afterEach`. What is deliberately NOT done is invoking the real
 * `databaseCleanupService.vacuumDatabase()`, which terminates the read-worker pool of the live
 * process and pauses HTTP/WS traffic — a service-wide maintenance window is not something a test
 * may trigger.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	capabilityDisabled,
	describeUnsupported,
	isSupported,
	notApplicable,
	notImplemented,
	requireCapability,
	supported,
	UnsupportedCapabilityError,
} from "../capability";
import { createSqliteMaintenance } from "../sqlite-maintenance";

let dir = "";
let connection: Database | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "nf-sqlite-maintenance-"));
});

afterEach(() => {
	try {
		connection?.close();
	} catch {
		// already closed
	}
	connection = undefined;
	rmSync(dir, { recursive: true, force: true });
});

/** A WAL database with enough churn that a freelist and a shrinkable file actually exist. */
function seedDatabase(): { path: string; db: Database } {
	const path = join(dir, "maintenance.db");
	const db = new Database(path, { create: true });
	db.run("PRAGMA journal_mode = WAL");
	db.run("CREATE TABLE rows (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
	const insert = db.prepare("INSERT INTO rows (payload) VALUES (?)");
	const fill = db.transaction(() => {
		for (let i = 0; i < 4000; i++) insert.run("x".repeat(200));
	});
	fill();
	// Delete most of it so pages land on the freelist: that is what reclaimable space IS.
	db.run("DELETE FROM rows WHERE id > 200");
	connection = db;
	return { path, db };
}

function fileSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

describe("capability vocabulary", () => {
	test("distinguishes the three reasons a capability can be missing", () => {
		const missing = notApplicable("a server-managed engine has no WAL to checkpoint");
		const todo = notImplemented("planned, not built");
		const off = capabilityDisabled("turned off for this deployment");

		expect(missing.code).toBe("notApplicable");
		expect(todo.code).toBe("notImplemented");
		expect(off.code).toBe("disabled");
		// The distinction is the whole point: "impossible", "not yet" and "switched off" lead an
		// operator to three different actions, and a bare `false` leads them to none.
		expect(new Set([missing.code, todo.code, off.code]).size).toBe(3);
		expect(describeUnsupported(missing)).toBe(
			"notApplicable: a server-managed engine has no WAL to checkpoint",
		);
	});

	test("refuses to construct a refusal with no reason", () => {
		// An empty reason reaches the operator as a blank log field at the exact moment they need to
		// know why maintenance did not run, so it is rejected where it is built.
		expect(() => notApplicable("")).toThrow(/non-empty reason/);
		expect(() => notApplicable("   ")).toThrow(/non-empty reason/);
		expect(() => notImplemented("\n\t")).toThrow(/non-empty reason/);
	});

	test("requireCapability unwraps a value and throws a typed error otherwise", () => {
		expect(requireCapability(supported(42), "answer")).toBe(42);
		expect(isSupported(supported(0))).toBe(true);

		const refusal = notApplicable("no local file to rewrite");
		let caught: unknown;
		try {
			requireCapability(refusal, "space reclamation");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(UnsupportedCapabilityError);
		const error = caught as UnsupportedCapabilityError;
		// The code travels separately so a caller can map it onto a status: `disabled` is something an
		// operator can undo, `notApplicable` never will be.
		expect(error.code).toBe("notApplicable");
		expect(error.capability).toBe("space reclamation");
		expect(error.reason).toBe("no local file to rewrite");
		expect(error.message).toContain("notApplicable");
	});
});

describe("SQLite maintenance operations", () => {
	test("checkpoints in both modes and reports success", () => {
		const { db } = seedDatabase();
		const maintenance = createSqliteMaintenance(() => db);

		const passive = maintenance.checkpoint({ truncate: false });
		expect(passive.supported).toBe(true);
		if (!passive.supported) return;
		expect(passive.value.ok).toBe(true);

		const truncating = maintenance.checkpoint({ truncate: true });
		expect(truncating.supported).toBe(true);
		if (!truncating.supported) return;
		expect(truncating.value.ok).toBe(true);
		// TRUNCATE is the mode that actually returns WAL bytes to the filesystem; PASSIVE cannot.
		expect(fileSize(join(dir, "maintenance.db-wal"))).toBe(0);
	});

	test("refreshes planner statistics", () => {
		const { db } = seedDatabase();
		const maintenance = createSqliteMaintenance(() => db);
		const result = maintenance.refreshPlannerStatistics();
		expect(result.supported).toBe(true);
		if (!result.supported) return;
		expect(result.value.ok).toBe(true);
	});

	test("measures reusable space with real page arithmetic", () => {
		const { path, db } = seedDatabase();
		const maintenance = createSqliteMaintenance(() => db);
		maintenance.checkpoint({ truncate: true });

		const measured = maintenance.measureReusableSpace(fileSize(path));
		expect(measured.supported).toBe(true);
		if (!measured.supported) return;

		// Not a fabricated zero: the deletes above put pages on the freelist.
		expect(measured.value.pageSize).toBeGreaterThan(0);
		expect(measured.value.pageCount).toBeGreaterThan(0);
		expect(measured.value.freelistBytes).toBeGreaterThan(0);
		// Clamped against the real file: a header that disagreed with the length must not report more
		// free space than the file physically has.
		expect(measured.value.freelistBytes).toBeLessThanOrEqual(
			Math.max(fileSize(path), measured.value.pageSize * measured.value.pageCount),
		);
	});

	test("the measurement agrees with the pragmas it claims to read", () => {
		// Cross-checked against an INDEPENDENT computation rather than against the same helper the
		// adapter calls. Today it delegates to the shared storage-scan primitive so the settings page
		// and the maintenance window cannot disagree; if someone later inlines the arithmetic (or
		// changes which pragmas it reads), this catches the drift instead of silently reporting a
		// different number to the operator than the storage report shows.
		const { path, db } = seedDatabase();
		const maintenance = createSqliteMaintenance(() => db);
		maintenance.checkpoint({ truncate: true });

		const pragma = (name: string): number => {
			const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
			return Number(row?.[name] ?? 0);
		};
		const pageSize = pragma("page_size");
		const pageCount = pragma("page_count");
		const freelistCount = pragma("freelist_count");
		const mainBytes = fileSize(path);

		const measured = maintenance.measureReusableSpace(mainBytes);
		expect(measured.supported).toBe(true);
		if (!measured.supported) return;

		expect(measured.value.pageSize).toBe(pageSize);
		expect(measured.value.pageCount).toBe(pageCount);
		expect(measured.value.freelistBytes).toBe(
			Math.min(pageSize * freelistCount, Math.max(mainBytes, pageSize * pageCount)),
		);
	});

	test("reclaims space and shrinks the file", () => {
		const { path, db } = seedDatabase();
		const maintenance = createSqliteMaintenance(() => db);
		maintenance.checkpoint({ truncate: true });

		const before = fileSize(path);
		const beforeFree = maintenance.measureReusableSpace(before);
		expect(beforeFree.supported).toBe(true);
		if (!beforeFree.supported) return;
		expect(beforeFree.value.freelistBytes).toBeGreaterThan(0);

		expect(maintenance.reclaimSpace().supported).toBe(true);
		maintenance.checkpoint({ truncate: true });

		const after = fileSize(path);
		// The point of the operation: bytes actually returned to the filesystem.
		expect(after).toBeLessThan(before);
		const afterFree = maintenance.measureReusableSpace(after);
		expect(afterFree.supported).toBe(true);
		if (!afterFree.supported) return;
		expect(afterFree.value.freelistBytes).toBeLessThan(beforeFree.value.freelistBytes);
	});
});

describe("failure reporting", () => {
	test("best-effort operations report failure instead of throwing", () => {
		const { db } = seedDatabase();
		const maintenance = createSqliteMaintenance(() => db);
		db.close();

		// A closed handle is the cheapest reproduction of "the engine refused". These two must NOT
		// throw: every caller uses them as a hardening step around another operation whose result must
		// survive a checkpoint hiccup.
		const checkpoint = maintenance.checkpoint({ truncate: true });
		expect(checkpoint.supported).toBe(true);
		if (!checkpoint.supported) return;
		// `supported: true, ok: false` — attempted and failed, NOT "this engine cannot checkpoint".
		expect(checkpoint.value.ok).toBe(false);

		const optimize = maintenance.refreshPlannerStatistics();
		expect(optimize.supported).toBe(true);
		if (!optimize.supported) return;
		expect(optimize.value.ok).toBe(false);
	});

	test("reclaimSpace throws so a silent no-op maintenance window is impossible", () => {
		const { db } = seedDatabase();
		const maintenance = createSqliteMaintenance(() => db);
		db.close();
		expect(() => maintenance.reclaimSpace()).toThrow();
	});

	test("a missing connection is an absent capability, not an exception", () => {
		const maintenance = createSqliteMaintenance(() => {
			throw new Error("lifecycle has not been started");
		});

		for (const result of [
			maintenance.checkpoint({ truncate: false }),
			maintenance.refreshPlannerStatistics(),
			maintenance.measureReusableSpace(1024),
			maintenance.reclaimSpace(),
		]) {
			expect(result.supported).toBe(false);
			if (result.supported) continue;
			expect(result.code).toBe("notApplicable");
			expect(result.reason).toContain("no open SQLite connection");
		}
	});

	test("classifies lock contention apart from every other failure", () => {
		const maintenance = createSqliteMaintenance(() => {
			throw new Error("unused");
		});

		// All four spellings occur in practice: bun:sqlite surfaces contention as a code on some
		// paths and as bare message text on others, and matching only one of them classified real
		// conflicts as generic failures.
		for (const message of [
			"SQLiteError: SQLITE_BUSY: database is locked",
			"SQLITE_LOCKED: database table is locked",
			"database is locked",
			"Error: database table is locked: rows",
		]) {
			expect(maintenance.classifyFailure(new Error(message)).kind).toBe("conflict");
		}

		for (const message of [
			"SQLITE_CORRUPT: database disk image is malformed",
			"disk I/O error",
			"attempt to write a readonly database",
		]) {
			expect(maintenance.classifyFailure(new Error(message)).kind).toBe("error");
		}

		// The message survives classification, so the log and the HTTP body stay actionable.
		const failure = maintenance.classifyFailure(new Error("disk I/O error"));
		expect(failure.message).toContain("disk I/O error");
		// Non-Error values must not crash the classifier: a thrown string is still a failure.
		expect(maintenance.classifyFailure("database is locked").kind).toBe("conflict");
		expect(maintenance.classifyFailure(undefined).kind).toBe("error");
	});

	test("reads the connection on every call, so a reopened handle is picked up", () => {
		// Startup repair closes the connection and reopens it after `sqlite3 .recover` swaps the file.
		// An adapter that captured the handle at construction time would keep talking to a closed
		// connection to a replaced database, and the symptom would appear much later.
		const first = seedDatabase();
		let current = first.db;
		const maintenance = createSqliteMaintenance(() => current);
		expect(maintenance.refreshPlannerStatistics().supported).toBe(true);

		first.db.close();
		const replacement = new Database(first.path);
		replacement.run("PRAGMA journal_mode = WAL");
		current = replacement;
		connection = replacement;

		const result = maintenance.refreshPlannerStatistics();
		expect(result.supported).toBe(true);
		if (!result.supported) return;
		expect(result.value.ok).toBe(true);
	});
});
