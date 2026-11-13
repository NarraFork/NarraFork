import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { testEnvironment } from "../../tests/preload";
import { safeSpawn } from "../lib/spawn";

const root = resolve(import.meta.dir, "../..");

test("compiled SQLite/PG migrations ignore a damaged checkout and fail closed without embedded data", async () => {
	const temp = await mkdtemp(join(testEnvironment.isolatedHome, "frozen-migrations-"));
	try {
		for (const driver of ["drizzle", "drizzle-postgres"]) {
			await mkdir(join(temp, driver, "meta"), { recursive: true });
			await writeFile(join(temp, driver, "meta", "_journal.json"), "damaged checkout");
		}
		const entry = join(temp, "probe.ts");
		await writeFile(
			entry,
			`import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveMigrationsForDriver, applyPendingMigrationsByHash } from ${JSON.stringify(join(root, "server/db/run-migrations.ts"))};
import { isCompiledRuntime } from ${JSON.stringify(join(root, "server/lib/runtime-target.ts"))};
if (!isCompiledRuntime()) throw new Error("probe must be compiled");
const results = [];
for (const driver of ["sqlite", "postgresql"]) {
  try {
    const selected = await resolveMigrationsForDriver(driver);
    try {
      if (selected.source !== "embedded") throw new Error("mutable migration source");
      if (driver === "sqlite") {
        const db = new Database(":memory:");
        try {
          applyPendingMigrationsByHash(db, selected.folder);
          if (!db.query("SELECT name FROM sqlite_master WHERE name='frozen_schema'").get()) throw new Error("wrong migration");
        } finally { db.close(); }
      } else if (!readFileSync(join(selected.folder,"0000_frozen.sql"),"utf8").includes("frozen_schema")) throw new Error("wrong PG migration");
      results.push(driver + ":embedded");
    } finally { selected.cleanup?.(); }
  } catch (error) {
    if (!String(error).includes("migrations blocked")) throw error;
    results.push(driver + ":blocked");
  }
}
console.log(JSON.stringify(results));`,
		);
		for (const present of [true, false]) {
			const binary = join(temp, `probe-${present}${process.platform === "win32" ? ".exe" : ""}`);
			const built = await Bun.build({
				entrypoints: [entry],
				target: "bun",
				compile: { outfile: binary },
				plugins: [
					{
						name: "embedded-migration-fixtures",
						setup(build) {
							build.onResolve({ filter: /embedded-(?:postgres-)?migrations-data$/ }, (args) => ({
								path: args.path,
								namespace: "migration-fixture",
							}));
							build.onLoad({ filter: /.*/, namespace: "migration-fixture" }, (args) => {
								const pg = args.path.includes("postgres");
								const prefix = pg ? "embeddedPostgresMigration" : "embeddedMigration";
								const journal = JSON.stringify({
									version: "7",
									dialect: pg ? "postgresql" : "sqlite",
									entries: [
										{ idx: 0, version: "6", when: 1, tag: "0000_frozen", breakpoints: true },
									],
								});
								return {
									loader: "ts",
									contents: present
										? `export const ${prefix}JournalJson = ${JSON.stringify(journal)}; export const ${prefix}SqlFiles = [{ name: "0000_frozen.sql", content: "CREATE TABLE frozen_schema (id TEXT);" }];`
										: `export const ${prefix}JournalJson = undefined; export const ${prefix}SqlFiles = undefined;`,
								};
							});
						},
					},
				],
			});
			expect(built.success, built.logs.map(String).join("\n")).toBe(true);
			const run = await safeSpawn({
				cmd: [binary],
				cwd: temp,
				env: { ...process.env, NARRAFORK_HOME: join(temp, "home") },
				timeout: 10_000,
				maxOutputBytes: 32 * 1024,
			});
			expect(run.exitCode, run.stderr).toBe(0);
			expect(run.stdout).toContain(
				JSON.stringify(
					present
						? ["sqlite:embedded", "postgresql:embedded"]
						: ["sqlite:blocked", "postgresql:blocked"],
				),
			);
		}
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}, 60_000);
