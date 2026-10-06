import { afterEach, expect, test } from "bun:test";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { runPostgresKit } from "../../scripts/lib/postgres-kit";
import { digest, readPgMetadata } from "../../scripts/lib/postgres-migration-metadata";
import { executePostgresMigrations } from "../../scripts/lib/postgres-migration-transaction";
import type { TerminalRuntime } from "../../server/terminal/runtime";
import { spawnBunTerminal } from "../../server/terminal/runtime-bun";

const repository = resolve(import.meta.dir, "../..");
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function schema(root: string, fields: number, table = "failed_jobs") {
	writeFileSync(
		join(root, "server/db/postgres-schema.ts"),
		`
import { pgTable, integer, text } from 'drizzle-orm/pg-core';
export const example = pgTable(${JSON.stringify(table)}, {
 id: integer('id').primaryKey(),
 ${Array.from({ length: fields }, (_, idx) => `field${idx}: text('field_${idx}'),`).join("\n")}
});
`,
	);
}

async function fixture() {
	const root = mkdtempSync(join(repository, ".narrafork/pg-wrapper-test-"));
	roots.push(root);
	mkdirSync(join(root, "server/db"), { recursive: true });
	mkdirSync(join(root, ".narrafork/pg-initial"), { recursive: true });
	symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "junction");
	writeFileSync(
		join(root, "drizzle.pg.config.ts"),
		`
import { defineConfig } from 'drizzle-kit';
import { resolvePgStageOut, resolvePgSchemaPath } from ${JSON.stringify(join(repository, "scripts/lib/postgres-kit.ts"))};
export default defineConfig({ dialect: 'postgresql', schema: resolvePgSchemaPath(process.cwd()), out: resolvePgStageOut(process.cwd()) });
`,
	);
	schema(root, 0);
	const initial = await runPostgresKit({
		root,
		stageOut: ".narrafork/pg-initial",
		operation: "generate",
		args: ["--name", "initial"],
	});
	expect(initial.exitCode, `${initial.stdout}\n${initial.stderr}`).toBe(0);
	cpSync(join(root, ".narrafork/pg-initial"), join(root, "drizzle-postgres"), { recursive: true });
	rmSync(join(root, ".narrafork/pg-initial"), { recursive: true });
	return root;
}

async function rename(root: string) {
	const spawn =
		process.platform === "win32"
			? (await import("../../server/terminal/runtime-pty")).spawnPortablePty
			: spawnBunTerminal;
	let output = "";
	let selected = false;
	let terminal: TerminalRuntime;
	terminal = spawn({
		cmd: [
			process.execPath,
			"-e",
			`
import { executePostgresMigrations } from ${JSON.stringify(join(repository, "scripts/lib/postgres-migration-transaction.ts"))};
const result = await executePostgresMigrations('generate', ['--name','renamed'], { root: ${JSON.stringify(root)} });
console.log('WRAPPER_RESULT=' + JSON.stringify(result));
`,
		],
		cwd: root,
		env: { ...process.env },
		cols: 100,
		rows: 30,
		onData(data) {
			output += data;
			if (Buffer.byteLength(output) > 256 * 1024) terminal.kill();
			if (!selected && output.includes("rename table")) {
				selected = true;
				terminal.write("\x1b[B\r");
			}
		},
	});
	const timer = setTimeout(() => {
		terminal.kill();
		terminal.close();
	}, 20_000);
	try {
		expect(await terminal.exited, output).toBe(0);
		expect(selected).toBe(true);
		expect(output).toContain("WRAPPER_RESULT=");
	} finally {
		clearTimeout(timer);
		terminal.close();
	}
}

test("real wrapper keeps one baseline through increments, rename, custom and writable unpublished SQL", async () => {
	const root = await fixture();
	const folder = join(root, "drizzle-postgres");
	const original = readPgMetadata(folder, { allowLegacy: true });
	expect((await executePostgresMigrations("baseline", [], { root })).changed).toBe(true);
	let metadata = readPgMetadata(folder);
	expect(metadata.journalText).toBe(original.journalText);
	expect(metadata.snapshotText).toBe(original.snapshotText);
	const before = { ...metadata.files };
	expect((await executePostgresMigrations("check", [], { root })).changed).toBe(false);
	expect((await executePostgresMigrations("generate", [], { root })).changed).toBe(false);
	expect(readPgMetadata(folder).files).toEqual(before);
	for (let version = 1; version <= 3; version++) {
		schema(root, version);
		const name = version === 1 ? "conflict_resolution" : `field_${version}`;
		expect((await executePostgresMigrations("generate", ["--name", name], { root })).changed).toBe(
			true,
		);
		metadata = readPgMetadata(folder);
		const entry = metadata.journal.entries.at(-1);
		if (!entry) throw new Error("Missing increment");
		expect(entry.idx).toBe(version);
		const sql = readFileSync(join(folder, `${entry.tag}.sql`), "utf8");
		expect(sql).toContain("ADD COLUMN");
		expect(sql).not.toContain("CREATE TABLE");
		expect(readdirSync(join(folder, "meta")).sort()).toEqual([
			"_journal.json",
			"_snapshot_history.json",
			"current_snapshot.json",
		]);
	}
	schema(root, 3, "renamed_jobs");
	await rename(root);
	metadata = readPgMetadata(folder);
	const renameEntry = metadata.journal.entries.at(-1);
	if (!renameEntry) throw new Error("Missing rename");
	expect(readFileSync(join(folder, `${renameEntry.tag}.sql`), "utf8")).toContain(
		'ALTER TABLE "failed_jobs" RENAME TO "renamed_jobs"',
	);
	// Native custom retains the prior schema even with unapplied source changes and rename annotations.
	schema(root, 4, "renamed_jobs");
	expect(
		(await executePostgresMigrations("generate", ["--custom", "--name", "seed"], { root })).changed,
	).toBe(true);
	metadata = readPgMetadata(folder);
	const custom = metadata.journal.entries.at(-1);
	if (!custom) throw new Error("Missing custom");
	const customPath = join(folder, `${custom.tag}.sql`);
	writeFileSync(
		customPath,
		"-- Unpublished custom SQL may be filled before its first release.\nSELECT 1;",
	);
	const customDigest = digest(readFileSync(customPath));
	await executePostgresMigrations("check", [], { root });
	await executePostgresMigrations("generate", ["--name", "field_4"], { root });
	metadata = readPgMetadata(folder);
	expect(metadata.journal.entries).toHaveLength(7);
	expect(digest(readFileSync(customPath))).toBe(customDigest);
	expect(metadata.history.entries).toHaveLength(7);
	expect(readdirSync(join(folder, "meta")).sort()).toEqual([
		"_journal.json",
		"_snapshot_history.json",
		"current_snapshot.json",
	]);
}, 60_000);
