/**
 * Worktree removal closes every unowned terminal inside the checkout, however many unowned
 * terminals exist elsewhere. The scan pages through all of them instead of stopping at the
 * first page, and fails the removal if it cannot finish.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb } from "../../../tests/setup";
import { closeRuntimeTestDb, getRuntimeTestDb } from "./agent-runtime-test-database";

const { db, sqlite, ready } = getRuntimeTestDb();
await ready;
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const { terminalService } = await import("../terminal-service");

const NOW = "2026-01-01T00:00:00.000Z";
const CHECKOUT = "/repo/.worktrees/feature";

function seedTerminals(count: number, cwd: (index: number) => string, prefix = "t") {
	const insert = sqlite.prepare(
		"INSERT INTO terminals (id, name, cwd, status, created_at) VALUES (?, 'sh', ?, 'exited', ?)",
	);
	sqlite.transaction(() => {
		for (let i = 0; i < count; i++)
			insert.run(`${prefix}-${String(i).padStart(6, "0")}`, cwd(i), NOW);
	})();
}

function remaining(ids: string[]) {
	return ids.filter((id) => sqlite.query("SELECT 1 FROM terminals WHERE id = ?").get(id));
}

beforeEach(() => cleanDb(sqlite));
afterEach(() => mock.restore());
afterAll(async () => {
	await closeRuntimeTestDb(sqlite);
	mock.module("../../db", () => realDbModule);
});

describe("cleanupForWorktree", () => {
	test("closes a terminal inside the checkout that sorts after the first page", async () => {
		seedTerminals(600, () => "/elsewhere", "a");
		seedTerminals(1, () => `${CHECKOUT}/src`, "z");
		const result = await terminalService.cleanupForWorktree({ worktreePath: CHECKOUT });
		expect(result.closedTerminals).toBe(1);
		expect(remaining(["z-000000"])).toEqual([]);
		expect(sqlite.query("SELECT count(*) AS n FROM terminals").get()).toEqual({ n: 600 });
	});

	test("refuses the removal when the scan cannot finish", async () => {
		seedTerminals(500 * 40 + 1, () => "/elsewhere", "a");
		seedTerminals(1, () => CHECKOUT, "b");
		const outcome = await terminalService.cleanupForWorktree({ worktreePath: CHECKOUT }).then(
			() => null,
			(error: unknown) => error,
		);
		expect(outcome).toMatchObject({ code: "WORKTREE_REMOVAL_TERMINAL_SCAN_INCOMPLETE" });
		expect(remaining(["b-000000"])).toEqual(["b-000000"]);
	});
});
