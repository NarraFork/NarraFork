/**
 * The write-path BASE modules must carry no engine at all.
 *
 * Companion to `port-purity.test.ts`, which pins the same property for the lifecycle and
 * maintenance ports. The write-side base — selector, port vocabulary, error classification — is
 * what BOTH backends import, so a driver or bootstrap import there would be inherited by every
 * adapter and the boundary would be decorative while still looking like one.
 *
 * Two consequences are asserted rather than assumed:
 *
 *   1. No dialect. Nothing in the base reaches `bun:sqlite`, a Drizzle dialect, or the
 *      PostgreSQL client. The selector deciding "SQLite" must not so much as contain the code
 *      that would open a PostgreSQL connection — a default SQLite deployment never triggers PG.
 *   2. No bootstrap. Same list `port-purity.test.ts` uses: importing the base in a worker must
 *      not re-run startup.
 *
 * Bundling is the only honest check: an import three modules deep is invisible to a text search
 * of the file itself.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");

/** Write-side base modules: importable by any backend, including a non-SQLite one. */
const BASE_MODULES = [
	"server/db/backend/write-selector.ts",
	"server/db/backend/write-port.ts",
	"server/db/pg-errors.ts",
] as const;

/** Symbols that exist only in the startup bootstrap. Same list the port-purity guard uses. */
const BOOTSTRAP_SYMBOLS = [
	"consumeCleanShutdownState",
	"acquireInstanceLock",
	"markDatabaseCleanShutdown",
	"releaseDatabaseInstanceLockOnly",
	"createWalUpkeepTick",
	"ensureFts",
	"runMigrations",
	"ensureColumns",
] as const;

async function bundle(relativePath: string): Promise<string> {
	const build = await Bun.build({ entrypoints: [join(ROOT, relativePath)], target: "bun" });
	expect(build.success, `${relativePath} must bundle`).toBe(true);
	expect(build.outputs.length).toBeGreaterThan(0);
	return await build.outputs[0].text();
}

describe("write-path base modules carry no engine", () => {
	for (const module of BASE_MODULES) {
		test(`${module} carries no driver, ORM dialect, PG client or bootstrap`, async () => {
			const bundled = await bundle(module);

			expect(bundled, `${module} must not reach bun:sqlite`).not.toContain("bun:sqlite");
			expect(bundled, `${module} must not reach a Drizzle dialect`).not.toContain("drizzle-orm");
			// Selecting a backend must never drag in the code that would CONNECT: the PostgreSQL
			// client constructor is the line between "chose a label" and "opened a database".
			expect(bundled, `${module} must not reach the PostgreSQL client`).not.toContain(
				"createPostgresClient",
			);
			for (const symbol of BOOTSTRAP_SYMBOLS) {
				expect(bundled, `${module} must not reach ${symbol}`).not.toContain(symbol);
			}
		}, 60_000);
	}

	test("the check is not vacuous: the selector and classifier really are in the bundle", async () => {
		const selector = await bundle("server/db/backend/write-selector.ts");
		expect(selector).toContain("selectWriteBackend");
		expect(selector).toContain("assertWriteBackendMatchesRead");

		const errors = await bundle("server/db/pg-errors.ts");
		expect(errors).toContain("classifyPgError");
		expect(errors).toContain("40001");
		expect(errors).toContain("23505");
	}, 60_000);
});
