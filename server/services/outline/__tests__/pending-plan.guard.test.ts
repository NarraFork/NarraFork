/**
 * Plan guard for the pending reads pageless A2 keys by space and by session instead of by page
 * (`store/sqlite-store.ts`): a space's open changes are counted from its partial open index
 * (`idx_outline_pending_space_open`), never by scanning its decided rows; a session's unreported
 * decisions are read from `idx_outline_pending_unreported` in its own order (no sort), the
 * continuation a seek. Checked on a migrated database, without statistics and after `ANALYZE`.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPendingMigrationsByHash } from "../../../db/run-migrations";

let root: string;
let database: Database;

/** The statements as the store sends them (the predicates are the indexes' own). */
const COUNT_OPEN_BY_SPACE = `SELECT count(*) AS n FROM (
	SELECT 1 FROM outline_pending WHERE space_id = ? AND "status" = 'open' LIMIT ?
)`;
const UNREPORTED = `SELECT id FROM outline_pending
	WHERE requester_session = ? AND "reported_at" IS NULL AND "status" <> 'open'
	ORDER BY created_at ASC, id ASC LIMIT ?`;
const UNREPORTED_AFTER = `SELECT id FROM outline_pending
	WHERE requester_session = ? AND "reported_at" IS NULL AND "status" <> 'open'
		AND (created_at, id) > (?, ?)
	ORDER BY created_at ASC, id ASC LIMIT ?`;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "nf-pending-plan-"));
	database = new Database(join(root, "plan.db"));
	applyPendingMigrationsByHash(database, join(import.meta.dir, "../../../../drizzle"));
});

afterAll(() => {
	database.close();
	rmSync(root, { recursive: true, force: true });
});

function planOf(text: string, params: Array<string | number>): string {
	const statement = database.prepare(`EXPLAIN QUERY PLAN ${text}`);
	try {
		return (statement.all(...params) as Array<{ detail: string }>).map((r) => r.detail).join("\n");
	} finally {
		statement.finalize();
	}
}

function check(): void {
	const count = planOf(COUNT_OPEN_BY_SPACE, ["s", 500]);
	expect(count).toContain("idx_outline_pending_space_open");
	for (const plan of [
		planOf(UNREPORTED, ["n", 100]),
		planOf(UNREPORTED_AFTER, ["n", "2026-01-01", "x", 100]),
	]) {
		expect(plan).toContain("idx_outline_pending_unreported");
		expect(plan).not.toContain("TEMP B-TREE");
	}
}

describe("pending reads by space and by session", () => {
	test("use their indexes, without statistics", () => {
		check();
	});

	test("and after ANALYZE", () => {
		database.exec("ANALYZE");
		check();
	});
});
