/**
 * Regression test for the production-database guard in `openDatabase`.
 *
 * History: several test suites (knowledge ACL/pack/personal-library, spec-vfs) seeded
 * fixture users, drafts, packs and narrators straight into the developer's real
 * ~/.narrafork/narrafork.db. `tests/preload.ts` now redirects NARRAFORK_HOME, but that
 * guard ships inside the repo — a worktree checked out before it, or a run with a
 * different bunfig, silently loses the isolation. So the refusal also lives at the
 * connection chokepoint, which is what these tests pin down.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { getDbPath, openDatabase } from "../connection";

const realDbPath = resolve(homedir(), ".narrafork", "narrafork.db");

describe("openDatabase production guard", () => {
	test("refuses the real ~/.narrafork database while NODE_ENV=test", () => {
		// `bun test` sets NODE_ENV=test itself, so this is the live condition.
		expect(process.env.NODE_ENV).toBe("test");
		expect(() => openDatabase(realDbPath)).toThrow(/Refusing to open the real NarraFork database/);
	});

	test("still refuses when NARRAFORK_HOME is pointed at the real directory", () => {
		const previous = process.env.NARRAFORK_HOME;
		process.env.NARRAFORK_HOME = resolve(homedir(), ".narrafork");
		try {
			expect(getDbPath()).toBe(realDbPath);
			expect(() => openDatabase()).toThrow(/Refusing to open the real NarraFork database/);
		} finally {
			if (previous === undefined) delete process.env.NARRAFORK_HOME;
			else process.env.NARRAFORK_HOME = previous;
		}
	});

	test("allows an isolated database path", () => {
		const dir = mkdtempSync(resolve(tmpdir(), "narrafork-db-guard-"));
		try {
			const conn = openDatabase(resolve(dir, "narrafork.db"));
			conn.run("CREATE TABLE t (a integer primary key)");
			conn.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the default isolated NARRAFORK_HOME used by the suite is accepted", () => {
		// The preload points NARRAFORK_HOME at a temp dir; opening it must not throw.
		expect(getDbPath()).not.toBe(realDbPath);
		const conn = openDatabase();
		conn.close();
	});
});
