/**
 * The port modules must stay free of the SQLite driver AND of the database bootstrap.
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION
 * -------------------------------------
 * The ports are what a SECOND backend imports. If a contract module drags in `bun:sqlite`, Drizzle's
 * SQLite dialect, or the startup bootstrap, then every backend inherits them no matter how careful
 * its own adapter is — and the boundary becomes decorative while still looking like a boundary.
 *
 * The bootstrap half is the sharper hazard, and it has already bitten this repository once: importing
 * `server/db/index.ts` from a worker thread re-evaluates the whole startup inside that thread, opens a
 * second read-write connection, re-runs migrations, registers a second checkpoint timer, and calls
 * `consumeCleanShutdownState` — which CLEARS the clean-shutdown marker, so the next startup believes
 * the process crashed. `acquireInstanceLock` does not catch it because the pid matches. Nothing throws;
 * the damage shows up later as unexplained integrity scans. See
 * `server/lib/db-worker/__tests__/module-boundary.test.ts`, which guards the same property from the
 * worker side.
 *
 * Bundling is the only honest way to check this: an import three modules deep is invisible to a
 * text search of the file itself.
 *
 * Note what is deliberately NOT asserted: that the ADAPTERS are driver-free. They are the SQLite
 * implementation; `bun:sqlite` belongs there. The line is between contract and implementation.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");

/** Contract modules: importable by any backend, including a non-SQLite one. */
const PORT_MODULES = [
	"server/db/backend/index.ts",
	"server/db/backend/capability.ts",
	"server/db/backend/lifecycle-port.ts",
	"server/db/backend/maintenance-port.ts",
	"server/db/backend/backend-ids.ts",
] as const;

/** Symbols that exist only in the startup bootstrap. Same list the worker-boundary guard uses. */
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

describe("database backend ports are dialect-free", () => {
	for (const module of PORT_MODULES) {
		test(`${module} carries no driver, ORM dialect or bootstrap`, async () => {
			const bundled = await bundle(module);

			expect(bundled, `${module} must not reach bun:sqlite`).not.toContain("bun:sqlite");
			expect(bundled, `${module} must not reach a Drizzle dialect`).not.toContain("drizzle-orm");
			for (const symbol of BOOTSTRAP_SYMBOLS) {
				expect(bundled, `${module} must not reach ${symbol}`).not.toContain(symbol);
			}
		}, 60_000);
	}

	test("the check is not vacuous: the barrel really contains the capability vocabulary", async () => {
		// Without this, a build that silently produced an (almost) empty bundle would pass every
		// assertion above while checking nothing at all.
		const bundled = await bundle("server/db/backend/index.ts");
		expect(bundled).toContain("notApplicable");
		expect(bundled).toContain("UnsupportedCapabilityError");
		expect(bundled).toContain("requireCapability");
	}, 60_000);

	test("the SQLite adapters DO carry the driver, which is why they are not ports", async () => {
		// The complement of the assertions above, and the reason the split exists: if an adapter had
		// no engine in it, either the boundary is in the wrong place or the adapter is a stub.
		const lifecycle = await bundle("server/db/backend/sqlite-lifecycle.ts");
		expect(lifecycle).toContain("bun:sqlite");
		expect(lifecycle).toContain("runMigrations");

		const maintenance = await bundle("server/db/backend/sqlite-maintenance.ts");
		expect(maintenance).toContain("VACUUM");
	}, 60_000);
});
