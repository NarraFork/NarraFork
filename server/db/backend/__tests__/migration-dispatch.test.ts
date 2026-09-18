import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
	collectPostgresMigrationData,
	materializePostgresMigrations,
	renderPostgresMigrationData,
	resolveMigrationsForDriver,
	runMigrationsForDriver,
} from "../../run-migrations";

const root = resolve(import.meta.dir, "../../../..");
const temporary: string[] = [];
function temp() {
	const folder = mkdtempSync(join(tmpdir(), "nf-migration-dispatch-test-"));
	temporary.push(folder);
	return folder;
}
afterEach(() => {
	for (const folder of temporary.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const pgData = () => collectPostgresMigrationData(join(root, "drizzle-postgres"));

describe("isolated PostgreSQL migration bundle", () => {
	test("build scans only journal entries and preserves generated SQL bytes", async () => {
		const data = pgData();
		const folder = temp();
		mkdirSync(join(folder, "meta"));
		writeFileSync(join(folder, "meta", "_journal.json"), data.embeddedPostgresMigrationJournalJson);
		for (const file of data.embeddedPostgresMigrationSqlFiles) {
			writeFileSync(join(folder, file.name), file.content);
			expect(file.content).toBe(readFileSync(join(root, "drizzle-postgres", file.name), "utf8"));
		}
		writeFileSync(join(folder, "orphan-sqlite.sql"), "THIS MUST NOT BE EMBEDDED");
		expect(collectPostgresMigrationData(folder)).toEqual(data);
		const modulePath = join(folder, "bundle.ts");
		writeFileSync(modulePath, renderPostgresMigrationData(data));
		const bundle = await import(modulePath);
		expect(bundle.embeddedPostgresMigrationJournalJson).toBe(
			data.embeddedPostgresMigrationJournalJson,
		);
		expect(bundle.embeddedPostgresMigrationSqlFiles).toEqual(
			data.embeddedPostgresMigrationSqlFiles,
		);
		expect(bundle.embeddedMigrationJournalJson).toBeUndefined();
		const materialized = materializePostgresMigrations(data);
		try {
			expect(readMigrationFiles({ migrationsFolder: materialized.folder })).toEqual(
				readMigrationFiles({ migrationsFolder: join(root, "drizzle-postgres") }),
			);
		} finally {
			materialized.cleanup?.();
		}
		expect(existsSync(materialized.folder)).toBe(false);
	});

	test("SQLite data cannot enter PostgreSQL materialization", () => {
		expect(() => collectPostgresMigrationData(join(root, "drizzle"))).toThrow(/PostgreSQL/);
		const data = pgData();
		expect(() =>
			materializePostgresMigrations({
				...data,
				embeddedPostgresMigrationJournalJson: readFileSync(
					join(root, "drizzle/meta/_journal.json"),
					"utf8",
				),
			}),
		).toThrow(/PostgreSQL/);
		expect(() =>
			materializePostgresMigrations({ ...data, embeddedPostgresMigrationSqlFiles: [] }),
		).toThrow(/match journal/);
		expect(() =>
			materializePostgresMigrations({
				...data,
				embeddedPostgresMigrationSqlFiles: data.embeddedPostgresMigrationSqlFiles.map((file) => ({
					...file,
					name: "../escape.sql",
				})),
			}),
		).toThrow(/match journal/);
	});

	test("missing journal or SQL is an error, not an empty bundle", () => {
		const folder = temp();
		expect(() => collectPostgresMigrationData(folder)).toThrow();
		mkdirSync(join(folder, "meta"));
		writeFileSync(
			join(folder, "meta", "_journal.json"),
			pgData().embeddedPostgresMigrationJournalJson,
		);
		expect(() => collectPostgresMigrationData(folder)).toThrow();
	});

	test("default remains SQLite; explicit PG source is independent", async () => {
		expect(await resolveMigrationsForDriver()).toEqual({
			folder: "./drizzle",
			source: "filesystem",
		});
		const pg = await resolveMigrationsForDriver("postgresql");
		expect(pg).toEqual({ folder: "./drizzle-postgres", source: "filesystem" });
	});

	test("PG missing data and missing runner fail closed", async () => {
		const folder = join(temp(), "absent");
		await expect(
			resolveMigrationsForDriver("postgresql", {
				folder,
				loadEmbedded: async () => {
					throw new Error("missing bundle");
				},
			}),
		).rejects.toThrow(/blocked/);
		await expect(runMigrationsForDriver({ driver: "postgresql" })).rejects.toThrow(/runner/);
		let called = false;
		await expect(
			runMigrationsForDriver({
				driver: "postgresql",
				source: {
					folder,
					loadEmbedded: async () => {
						throw new Error("missing");
					},
				},
				run: async () => {
					called = true;
				},
			}),
		).rejects.toThrow(/blocked/);
		expect(called).toBe(false);
	});

	test("PG-only runner receives its bundle and cleans up even on failure", async () => {
		for (const fail of [false, true]) {
			let materialized = "";
			const result = runMigrationsForDriver({
				driver: "postgresql",
				source: { folder: join(temp(), "absent"), loadEmbedded: async () => pgData() },
				run: async (folder) => {
					materialized = folder;
					expect(JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")).dialect).toBe(
						"postgresql",
					);
					if (fail) throw new Error("PG runner failed");
				},
			});
			if (fail) await expect(result).rejects.toThrow("PG runner failed");
			else await result;
			expect(materialized).not.toBe("");
			expect(existsSync(materialized)).toBe(false);
		}
	});
});
