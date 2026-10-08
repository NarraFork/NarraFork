import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkSqliteMigrationAssets } from "../../scripts/check-sqlite-migration-assets";

const fixtures: string[] = [];

afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(count = 1): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "sqlite-assets-test-"));
	fixtures.push(root);
	await mkdir(join(root, "meta"));
	const entries = Array.from({ length: count }, (_, idx) => ({
		idx,
		version: "6",
		when: 1000 + idx,
		tag: `${String(idx).padStart(4, "0")}_fixture`,
		breakpoints: true,
	}));
	await writeFile(
		join(root, "meta/_journal.json"),
		JSON.stringify({ version: "7", dialect: "sqlite", entries }),
	);
	for (const entry of entries) {
		await writeFile(join(root, `${entry.tag}.sql`), "CREATE TABLE fixture (id TEXT);\n");
		await writeFile(
			join(root, `meta/${String(entry.idx).padStart(4, "0")}_snapshot.json`),
			JSON.stringify({ version: "6", dialect: "sqlite", tables: {} }),
		);
	}
	return root;
}

describe("SQLite migration assets", () => {
	test("accepts the committed historical assets without rewriting them", async () => {
		const result = await checkSqliteMigrationAssets(resolve(import.meta.dir, "../../drizzle"));
		expect(result.migrations).toBeGreaterThan(0);
		expect(result.snapshots).toBeGreaterThan(0);
		expect(result.bytes).toBeGreaterThan(0);
	});

	test("accepts a complete fixture and reports bounded asset totals", async () => {
		const result = await checkSqliteMigrationAssets(await fixture());
		expect(result).toMatchObject({ migrations: 1, snapshots: 1 });
		expect(result.bytes).toBeGreaterThan(0);
	});

	test("custom historical migrations need not invent an intermediate snapshot", async () => {
		const root = await fixture(3);
		await rm(join(root, "meta/0001_snapshot.json"));
		expect(await checkSqliteMigrationAssets(root)).toMatchObject({ migrations: 3, snapshots: 2 });
	});

	test("fails for a missing journal", async () => {
		const root = await fixture();
		await rm(join(root, "meta/_journal.json"));
		await expect(checkSqliteMigrationAssets(root)).rejects.toThrow();
	});

	test("fails for missing migration SQL", async () => {
		const root = await fixture();
		await rm(join(root, "0000_fixture.sql"));
		await expect(checkSqliteMigrationAssets(root)).rejects.toThrow("Missing migration SQL");
	});

	test("fails for an unjournaled SQL file", async () => {
		const root = await fixture();
		await writeFile(join(root, "0001_extra.sql"), "SELECT 1;");
		await expect(checkSqliteMigrationAssets(root)).rejects.toThrow("SQL is not in the journal");
	});

	test("fails for an empty SQL file", async () => {
		const root = await fixture();
		await writeFile(join(root, "0000_fixture.sql"), " \n");
		await expect(checkSqliteMigrationAssets(root)).rejects.toThrow("empty migration SQL");
	});

	test("fails for a missing latest snapshot", async () => {
		const root = await fixture();
		await rm(join(root, "meta/0000_snapshot.json"));
		await expect(checkSqliteMigrationAssets(root)).rejects.toThrow("Missing latest snapshot");
	});

	test("fails for malformed snapshot JSON", async () => {
		const root = await fixture();
		await writeFile(join(root, "meta/0000_snapshot.json"), "{");
		await expect(checkSqliteMigrationAssets(root)).rejects.toThrow("invalid JSON");
	});

	test("fails for a non-SQLite snapshot", async () => {
		const root = await fixture();
		await writeFile(join(root, "meta/0000_snapshot.json"), '{"dialect":"postgresql"}');
		await expect(checkSqliteMigrationAssets(root)).rejects.toThrow("invalid SQLite snapshot");
	});

	test("rejects an invalid journal rather than silently accepting no migrations", async () => {
		const root = await fixture();
		await writeFile(join(root, "meta/_journal.json"), '{"dialect":"sqlite","entries":[]}');
		await expect(checkSqliteMigrationAssets(root)).rejects.toThrow("invalid SQLite journal");
	});

	test.each([
		"../outside",
		"0001_wrong_index",
		"0000_fixture/elsewhere",
		`0000_${"x".repeat(124)}`,
	])("rejects journal tag %s", async (tag) => {
		const root = await fixture();
		await writeFile(
			join(root, "meta/_journal.json"),
			JSON.stringify({
				version: "7",
				dialect: "sqlite",
				entries: [{ idx: 0, tag, when: 1000, breakpoints: true }],
			}),
		);
		await expect(checkSqliteMigrationAssets(root)).rejects.toThrow("invalid migration entry");
	});

	test.each(["kiro", "KIRO", "KiRo"])("rejects %s in SQL", async (legacy) => {
		const root = await fixture();
		await writeFile(join(root, "0000_fixture.sql"), `-- ${legacy}\nSELECT 1;`);
		await expect(checkSqliteMigrationAssets(root)).rejects.toThrow("forbidden legacy content");
	});

	test("rejects legacy content in asset filenames", async () => {
		const root = await fixture();
		await writeFile(join(root, "meta/0001_KiRo_snapshot.json"), "{}");
		await expect(checkSqliteMigrationAssets(root)).rejects.toThrow("forbidden legacy content");
	});

	test.each([
		'{"dialect":"sqlite","provider":"\\u006b\\u0069\\u0072\\u006f"}',
		'{"dialect":"sqlite","\\u006b\\u0069\\u0072\\u006f":{}}',
	])("rejects legacy content after decoding JSON escapes", async (source) => {
		const root = await fixture();
		await writeFile(join(root, "meta/0000_snapshot.json"), source);
		await expect(checkSqliteMigrationAssets(root)).rejects.toThrow("forbidden legacy content");
	});

	test("does not follow a migration SQL symlink", async () => {
		const root = await fixture();
		await rm(join(root, "0000_fixture.sql"));
		await writeFile(join(root, "outside.txt"), "SELECT 1;");
		await symlink(join(root, "outside.txt"), join(root, "0000_fixture.sql"));
		await expect(checkSqliteMigrationAssets(root)).rejects.toThrow("regular file");
	});

	test("enforces SQL input size bounds", async () => {
		const root = await fixture();
		await writeFile(join(root, "0000_fixture.sql"), "x".repeat(1024 * 1024 + 1));
		await expect(checkSqliteMigrationAssets(root)).rejects.toThrow("asset exceeds size limit");
	});
});
