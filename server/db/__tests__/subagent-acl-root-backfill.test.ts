/**
 * The one-time backfill that points existing subagents at their root narrator.
 *
 * Subagents created before delegation carry no `acl_root_narrator_id`, and access now
 * depends entirely on it — an unfilled row is denied to everyone but its owner and
 * admins. So the backfill decides whether upgrading silently hides a team's subtask
 * history.
 *
 * The properties worth pinning, all of them things a plain `UPDATE ... SET
 * acl_root_narrator_id = parent_narrator_id` would get wrong:
 *
 *  1. A direct subagent points at its parent.
 *  2. A NESTED subagent points at the ROOT, not at its immediate parent — decisions
 *     read this column once and never walk the chain, so a pointer to another subagent
 *     would resolve to a row with deny-everything audiences.
 *  3. A FORK is left alone. It also has a `parent_narrator_id` but is an independent
 *     session; filling this in would put it permanently under its origin's control.
 *  4. A broken chain and a cycle both end up NULL, which the ACL layer treats as
 *     "undeterminable" and denies. Fail-closed is the deliberate direction: a session
 *     that became too narrow gets reported, one that became too broad does not.
 *
 * Exercises the exact statement the upgrade runs (imported, not copied) against a
 * minimal table, so the lineage logic is asserted without needing a full schema.
 *
 * Run: NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$(mktemp -d) \
 *      bun test server/db/__tests__/subagent-acl-root-backfill.test.ts
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBAGENT_ACL_ROOT_BACKFILL_SQL } from "../run-migrations";

interface Row {
	id: string;
	type: string;
	parent: string | null;
}

/** A minimal narrators table in the pre-migration shape, plus the new column. */
function seed(rows: Row[]): Database {
	const db = new Database(join(mkdtempSync(join(tmpdir(), "acl-root-")), "t.db"));
	db.run(`CREATE TABLE narrators (
		id TEXT PRIMARY KEY,
		type TEXT NOT NULL DEFAULT 'primary',
		parent_narrator_id TEXT,
		acl_root_narrator_id TEXT
	)`);
	const insert = db.prepare(
		"INSERT INTO narrators (id, type, parent_narrator_id, acl_root_narrator_id) VALUES (?, ?, ?, NULL)",
	);
	for (const row of rows) insert.run(row.id, row.type, row.parent);
	db.run(SUBAGENT_ACL_ROOT_BACKFILL_SQL);
	return db;
}

function rootOf(db: Database, id: string): string | null {
	const row = db.prepare("SELECT acl_root_narrator_id AS r FROM narrators WHERE id = ?").get(id) as
		| { r: string | null }
		| undefined;
	return row?.r ?? null;
}

describe("subagent acl root backfill", () => {
	test("a direct subagent points at its parent", () => {
		const db = seed([
			{ id: "root", type: "primary", parent: null },
			{ id: "sub", type: "subagent", parent: "root" },
		]);
		expect(rootOf(db, "sub")).toBe("root");
	});

	test("a nested subagent points at the ROOT, not its immediate parent", () => {
		// Decisions read this column once; a pointer at "sub" would resolve to a subagent
		// row whose own audiences deny everyone.
		const db = seed([
			{ id: "root", type: "primary", parent: null },
			{ id: "sub", type: "subagent", parent: "root" },
			{ id: "deep", type: "subagent", parent: "sub" },
			{ id: "deeper", type: "subagent", parent: "deep" },
		]);
		expect(rootOf(db, "deep")).toBe("root");
		expect(rootOf(db, "deeper")).toBe("root");
	});

	test("a fork is left untouched despite having a parent", () => {
		const db = seed([
			{ id: "root", type: "primary", parent: null },
			{ id: "fork", type: "primary", parent: "root" },
		]);
		expect(rootOf(db, "fork")).toBe(null);
	});

	test("primary narrators are never given a pointer", () => {
		const db = seed([{ id: "root", type: "primary", parent: null }]);
		expect(rootOf(db, "root")).toBe(null);
	});

	test("a broken chain fails closed rather than guessing", () => {
		const db = seed([{ id: "orphan", type: "subagent", parent: "deleted-long-ago" }]);
		expect(rootOf(db, "orphan")).toBe(null);
	});

	test("a subagent with no parent at all fails closed", () => {
		const db = seed([{ id: "loose", type: "subagent", parent: null }]);
		expect(rootOf(db, "loose")).toBe(null);
	});

	test("a cycle terminates and fails closed", () => {
		// Cannot arise from the write paths, but the recursive CTE must not spin: the
		// depth guard is what stops it, and this asserts the guard is doing its job.
		const db = seed([
			{ id: "a", type: "subagent", parent: "b" },
			{ id: "b", type: "subagent", parent: "a" },
		]);
		expect(rootOf(db, "a")).toBe(null);
		expect(rootOf(db, "b")).toBe(null);
	});

	test("independent trees do not bleed into each other", () => {
		const db = seed([
			{ id: "root1", type: "primary", parent: null },
			{ id: "root2", type: "primary", parent: null },
			{ id: "s1", type: "subagent", parent: "root1" },
			{ id: "s2", type: "subagent", parent: "root2" },
			{ id: "s2deep", type: "subagent", parent: "s2" },
		]);
		expect(rootOf(db, "s1")).toBe("root1");
		expect(rootOf(db, "s2")).toBe("root2");
		expect(rootOf(db, "s2deep")).toBe("root2");
	});
});
