import { afterEach, describe, expect, test } from "bun:test";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { TerminalRuntime } from "../../../server/terminal/runtime";
import { spawnBunTerminal } from "../../../server/terminal/runtime-bun";
import {
	PG_SCHEMA_ENV,
	PG_STAGE_ENV,
	resolvePgSchemaPath,
	resolvePgStageOut,
	runPostgresKit,
} from "../postgres-kit";

const repository = resolve(import.meta.dir, "../../..");
const helper = join(repository, "scripts/lib/postgres-kit.ts");
const roots: string[] = [];
const originalStage = process.env[PG_STAGE_ENV];
const originalSchema = process.env[PG_SCHEMA_ENV];

afterEach(() => {
	if (originalStage === undefined) delete process.env[PG_STAGE_ENV];
	else process.env[PG_STAGE_ENV] = originalStage;
	if (originalSchema === undefined) delete process.env[PG_SCHEMA_ENV];
	else process.env[PG_SCHEMA_ENV] = originalSchema;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(label = "fixture with spaces") {
	const outer = mkdtempSync(join(repository, ".narrafork/pg-kit-test-"));
	roots.push(outer);
	const root = join(outer, label);
	mkdirSync(join(root, ".narrafork"), { recursive: true });
	mkdirSync(join(root, "server/db"), { recursive: true });
	symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "junction");
	writeConfig(root);
	writeSchema(root, 0);
	const stage = (name: string) => {
		const out = `.narrafork/pg-${name}`;
		mkdirSync(join(root, out));
		return out;
	};
	return { root, stage };
}

function writeConfig(root: string, absoluteOut?: string) {
	writeFileSync(
		join(root, "drizzle.pg.config.ts"),
		`
import { defineConfig } from 'drizzle-kit';
import { resolvePgStageOut, resolvePgSchemaPath } from ${JSON.stringify(helper)};
export default defineConfig({
  dialect: 'postgresql',
  schema: resolvePgSchemaPath(process.cwd()),
  out: ${absoluteOut ? JSON.stringify(absoluteOut) : "resolvePgStageOut(process.cwd())"},
});
`,
	);
}

function writeSchema(root: string, version: number, table = "kit_example") {
	writeFileSync(
		join(root, "server/db/postgres-schema.ts"),
		`
import { pgTable, integer, text } from 'drizzle-orm/pg-core';
export const example = pgTable(${JSON.stringify(table)}, {
  id: integer('id').primaryKey(),
  ${Array.from({ length: version }, (_, idx) => `field${idx}: text('field_${idx}'),`).join("\n")}
});
`,
	);
}

function snapshotFiles(root: string, stage: string): string[] {
	return readdirSync(join(root, stage, "meta"))
		.filter((file) => /^\d+_snapshot\.json$/.test(file))
		.sort();
}
function latest(root: string, stage: string) {
	const files = snapshotFiles(root, stage);
	const file = files.at(-1);
	if (!file) throw new Error("Fixture has no snapshot");
	return JSON.parse(readFileSync(join(root, stage, "meta", file), "utf8"));
}
function journal(root: string, stage: string) {
	return JSON.parse(readFileSync(join(root, stage, "meta/_journal.json"), "utf8"));
}
function prune(root: string, stage: string) {
	for (const file of snapshotFiles(root, stage).slice(0, -1))
		rmSync(join(root, stage, "meta", file));
}
function bytes(root: string, stage: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const file of readdirSync(join(root, stage))) {
		if (file === "meta") {
			for (const meta of readdirSync(join(root, stage, "meta"))) {
				result[`meta/${meta}`] = readFileSync(join(root, stage, "meta", meta)).toString("base64");
			}
		} else result[file] = readFileSync(join(root, stage, file)).toString("base64");
	}
	return result;
}
async function generate(root: string, stageOut: string, name: string, custom = false) {
	const result = await runPostgresKit({
		root,
		stageOut,
		operation: "generate",
		args: ["--name", name, ...(custom ? ["--custom"] : [])],
	});
	expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
	expect(result.stdoutTruncated).toBe(false);
	return result;
}
function assertDead(pid: number) {
	expect(() => process.kill(pid, 0)).toThrow();
}

async function ptyHarness(
	root: string,
	source: string,
	onOutput?: (output: string, terminal: TerminalRuntime) => void,
): Promise<string> {
	const spawn =
		process.platform === "win32"
			? (await import("../../../server/terminal/runtime-pty")).spawnPortablePty
			: spawnBunTerminal;
	let output = "";
	const terminal = spawn({
		cmd: [process.execPath, "-e", source],
		cwd: root,
		env: { ...process.env },
		cols: 100,
		rows: 30,
		onData(data) {
			output += data;
			if (Buffer.byteLength(output) > 256 * 1024) terminal.kill();
			else onOutput?.(output, terminal);
		},
	});
	const timer = setTimeout(() => {
		terminal.kill();
		terminal.close();
	}, 20_000);
	try {
		expect(await terminal.exited, output).toBe(0);
		return output;
	} finally {
		clearTimeout(timer);
		terminal.close();
	}
}

describe("guarded PG paths", () => {
	test("stage is relative, existing, direct pg-* directory; explicit input wins", () => {
		const { root, stage } = fixture();
		const out = stage("valid space");
		process.env[PG_STAGE_ENV] = "drizzle-postgres";
		expect(resolvePgStageOut(root, out)).toBe(out);
		process.env[PG_STAGE_ENV] = out;
		expect(resolvePgStageOut(root)).toBe(out);
		for (const path of [
			join(root, out),
			"../escape",
			"drizzle-postgres",
			".narrafork/pg-missing",
			`${out}/child`,
			".narrafork/pg-../bad",
			"C:\\escape",
			"",
		]) {
			expect(() => resolvePgStageOut(root, path)).toThrow();
		}
		symlinkSync(join(root, out), join(root, ".narrafork/pg-link"), "junction");
		expect(() => resolvePgStageOut(root, ".narrafork/pg-link")).toThrow("symlink");
		writeFileSync(join(root, ".narrafork/pg-file"), "not a directory");
		expect(() => resolvePgStageOut(root, ".narrafork/pg-file")).toThrow("directory");
	});
	test("schema permits a root-contained ordinary TS file, no traversal or symlinks", () => {
		const { root } = fixture();
		const schema = join(root, "server/db/postgres-schema.ts");
		delete process.env[PG_SCHEMA_ENV];
		expect(resolvePgSchemaPath(root)).toBe(schema);
		process.env[PG_SCHEMA_ENV] = schema;
		expect(resolvePgSchemaPath(root)).toBe(schema);
		writeFileSync(join(root, "small.ts"), "export {};");
		expect(resolvePgSchemaPath(root, "small.ts")).toBe(join(root, "small.ts"));
		for (const path of [
			helper,
			"../escape.ts",
			"server/db/../db/postgres-schema.ts",
			"server/db",
			"missing.ts",
		]) {
			expect(() => resolvePgSchemaPath(root, path)).toThrow();
		}
		symlinkSync(schema, join(root, "link.ts"));
		expect(() => resolvePgSchemaPath(root, "link.ts")).toThrow("symlink");
		writeFileSync(join(root, "small.js"), "export {};");
		expect(() => resolvePgSchemaPath(root, "small.js")).toThrow("TS");
	});
});

describe("real installed Drizzle Kit 0.31.10 (no database)", () => {
	test("compatibility gate uses the audited installed version", () => {
		const manifest = JSON.parse(
			readFileSync(join(repository, "node_modules/drizzle-kit/package.json"), "utf8"),
		);
		expect(manifest.version).toBe("0.31.10");
	});
	test("full history and single latest: check, byte-identical no-op, three increments, custom", async () => {
		const { root, stage } = fixture();
		delete process.env[PG_SCHEMA_ENV];
		const full = stage("full history");
		const single = stage("only latest");
		await generate(root, full, "seed");
		writeSchema(root, 1);
		await generate(root, full, "first");
		cpSync(join(root, full), join(root, single), { recursive: true });
		prune(root, single);
		expect(snapshotFiles(root, full)).toHaveLength(2);
		expect(snapshotFiles(root, single)).toHaveLength(1);
		for (const out of [full, single]) {
			const check = await runPostgresKit({ root, stageOut: out, operation: "check" });
			expect(check.exitCode, check.stderr).toBe(0);
			const before = bytes(root, out);
			const unchanged = await generate(root, out, "noop");
			expect(unchanged.stdout).toContain("No schema changes");
			expect(bytes(root, out)).toEqual(before);
		}
		for (const version of [2, 3, 4]) {
			writeSchema(root, version);
			for (const out of [full, single]) {
				const previous = latest(root, out);
				await generate(root, out, `step_${version}`);
				expect(latest(root, out).prevId).toBe(previous.id);
				expect(latest(root, out).id).not.toBe(previous.id);
			}
			const entry = journal(root, full).entries.at(-1);
			expect(journal(root, single).entries.at(-1).idx).toBe(entry.idx);
			expect(journal(root, single).entries.at(-1).tag).toBe(entry.tag);
			expect(readFileSync(join(root, full, `${entry.tag}.sql`), "utf8")).toBe(
				readFileSync(join(root, single, `${entry.tag}.sql`), "utf8"),
			);
			expect(latest(root, single).tables).toEqual(latest(root, full).tables);
			prune(root, single);
			expect(snapshotFiles(root, single)).toHaveLength(1);
		}
		writeSchema(root, 5);
		for (const out of [full, single]) {
			const previous = latest(root, out);
			await generate(root, out, "custom_work", true);
			const current = latest(root, out);
			expect(current.tables).toEqual(previous.tables);
			expect(current.prevId).toBe(previous.id);
			expect(journal(root, out).entries.at(-1).idx).toBe(5);
			await generate(root, out, "pending_schema");
			expect(journal(root, out).entries.at(-1).idx).toBe(6);
			expect(latest(root, out).tables["public.kit_example"].columns.field_4).toBeDefined();
		}
	}, 60_000);

	test("relative out and cwd work with spaces; native absolute out fails closed despite exit 0", async () => {
		const { root, stage } = fixture();
		delete process.env[PG_SCHEMA_ENV];
		const out = stage("spaces out");
		expect(process.cwd()).not.toBe(root);
		await generate(root, out, "spaces");
		writeConfig(root, join(root, out));
		const result = await runPostgresKit({ root, stageOut: out, operation: "generate" });
		expect(result.exitCode).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toContain("ENOENT");
	}, 15_000);

	test("real Kit errors that exit 0 are not successes, and bypass arguments are rejected", async () => {
		const { root, stage } = fixture();
		delete process.env[PG_SCHEMA_ENV];
		const out = stage("errors");
		writeFileSync(
			join(root, "server/db/postgres-schema.ts"),
			"throw new Error('deliberate kit schema failure');",
		);
		const result = await runPostgresKit({ root, stageOut: out, operation: "generate" });
		expect(result.exitCode).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toContain("deliberate kit schema failure");
		expect(result.stderr).toContain("exited 0");
		for (const args of [
			["--out=drizzle-postgres"],
			["--config", "evil.ts"],
			["--ignore-conflicts"],
			["--name", "../escape"],
		]) {
			await expect(
				runPostgresKit({ root, stageOut: out, operation: "generate", args }),
			).rejects.toThrow("Unsupported");
		}
	}, 15_000);

	test("non-TTY rename prompt explicitly fails without choosing drop/create", async () => {
		const { root, stage } = fixture();
		delete process.env[PG_SCHEMA_ENV];
		const out = stage("rename ci");
		await generate(root, out, "seed");
		const before = bytes(root, out);
		writeSchema(root, 0, "renamed_example");
		const result = await runPostgresKit({
			root,
			stageOut: out,
			operation: "generate",
			timeoutMs: 5_000,
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("interactive TTY");
		expect(bytes(root, out)).toEqual(before);
	}, 15_000);

	test("timeout and abort kill only owned Kit process and restore listeners", async () => {
		const { root, stage } = fixture();
		delete process.env[PG_SCHEMA_ENV];
		const out = stage("cancel");
		const pidPath = join(root, "child-pid");
		const before = process.listenerCount("SIGINT");
		writeFileSync(
			join(root, "server/db/postgres-schema.ts"),
			`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); while (true) {}`,
		);
		for (const mode of ["timeout", "abort"] as const) {
			const controller = new AbortController();
			const timer = mode === "abort" ? setTimeout(() => controller.abort(), 1_500) : undefined;
			try {
				const result = await runPostgresKit({
					root,
					stageOut: out,
					operation: "generate",
					timeoutMs: mode === "timeout" ? 1_500 : 5_000,
					signal: controller.signal,
				});
				expect(result.exitCode).not.toBe(0);
				expect(result.stderr).toContain(mode === "timeout" ? "timed out" : "aborted");
				expect(existsSync(pidPath)).toBe(true);
				assertDead(Number(readFileSync(pidPath, "utf8")));
				rmSync(pidPath);
				expect(process.listenerCount("SIGINT")).toBe(before);
			} finally {
				if (timer) clearTimeout(timer);
			}
		}
		const already = new AbortController();
		already.abort();
		const cancelled = await runPostgresKit({
			root,
			stageOut: out,
			operation: "generate",
			signal: already.signal,
		});
		expect(cancelled.stderr).toContain("before spawn");
		expect(existsSync(pidPath)).toBe(false);
	}, 15_000);

	test("output is bounded while streaming and cap overflow kills the real Kit child", async () => {
		const { root, stage } = fixture();
		delete process.env[PG_SCHEMA_ENV];
		const out = stage("output cap");
		const pidPath = join(root, "child-pid");
		writeFileSync(
			join(root, "server/db/postgres-schema.ts"),
			`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000); process.stdout.write('x'.repeat(300000));`,
		);
		const result = await runPostgresKit({
			root,
			stageOut: out,
			operation: "generate",
			timeoutMs: 5_000,
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stdoutTruncated).toBe(true);
		expect(result.stderr).toContain("exceeded 256 KiB");
		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(256 * 1024);
		assertDead(Number(readFileSync(pidPath, "utf8")));
	}, 15_000);

	test("stderr and multibyte output share the combined 256 KiB cap", async () => {
		const { root, stage } = fixture();
		delete process.env[PG_SCHEMA_ENV];
		const out = stage("stderr cap");
		const pidPath = join(root, "child-pid");
		writeFileSync(
			join(root, "server/db/postgres-schema.ts"),
			`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000); process.stdout.write('中'.repeat(30000)); process.stderr.write('🙂'.repeat(100000));`,
		);
		const result = await runPostgresKit({
			root,
			stageOut: out,
			operation: "generate",
			timeoutMs: 5000,
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderrTruncated).toBe(true);
		expect(result.stderr).toContain("exceeded 256 KiB");
		expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
			256 * 1024,
		);
		expect(result.stdout + result.stderr).not.toContain("�");
		assertDead(Number(readFileSync(pidPath, "utf8")));
	}, 15_000);

	test("real PTY timeout, AbortSignal and Ctrl-C clean up child, raw mode and listeners", async () => {
		const { root, stage } = fixture();
		delete process.env[PG_SCHEMA_ENV];
		const out = stage("pty cancel");
		const pidPath = join(root, "child-pid");
		writeFileSync(
			join(root, "server/db/postgres-schema.ts"),
			`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); console.log('CHILD_READY'); while (true) {}`,
		);
		for (const mode of ["timeout", "abort", "ctrlc"] as const) {
			const harness = `import { runPostgresKit } from ${JSON.stringify(helper)};
const state = () => ({ raw: process.stdin.isRaw ?? false, sig: process.listenerCount('SIGINT'), data: process.stdin.listenerCount('data'), resize: process.stdout.listenerCount('resize') });
const before = state();
const controller = new AbortController();
const timer = ${JSON.stringify(mode)} === 'abort' ? setTimeout(() => controller.abort(), 1500) : undefined;
const result = await runPostgresKit({ root: ${JSON.stringify(root)}, stageOut: ${JSON.stringify(out)}, operation: 'generate', interactive: true, signal: controller.signal, timeoutMs: ${mode === "timeout" ? 1500 : 5000} });
if (timer) clearTimeout(timer);
console.log('CANCEL_RESULT=' + JSON.stringify({ result, before, after: state() }));`;
			let sent = false;
			const output = await ptyHarness(root, harness, (text, terminal) => {
				if (mode === "ctrlc" && !sent && text.includes("CHILD_READY")) {
					sent = true;
					terminal.write("\x03");
				}
			});
			const record = output.match(/CANCEL_RESULT=(\{[^\r\n]+\})/)?.[1];
			if (!record) throw new Error(`PTY cancellation failed: ${output}`);
			const parsed = JSON.parse(record);
			expect(parsed.result.exitCode).not.toBe(0);
			expect(parsed.result.stderr).toContain(
				mode === "timeout" ? "timed out" : mode === "abort" ? "aborted" : "SIGINT",
			);
			expect(parsed.after).toEqual(parsed.before);
			assertDead(Number(readFileSync(pidPath, "utf8")));
			rmSync(pidPath);
		}
	}, 30_000);

	test("real nested PTYs preserve TTY and select native rename (not mocked stdio)", async () => {
		const { root, stage } = fixture();
		delete process.env[PG_SCHEMA_ENV];
		const out = stage("real pty");
		await generate(root, out, "seed");
		const previous = latest(root, out);
		writeSchema(root, 0, "renamed_example");
		const harness = `import { runPostgresKit } from ${JSON.stringify(helper)};
const before = { raw: process.stdin.isRaw ?? false, sig: process.listenerCount('SIGINT'), data: process.stdin.listenerCount('data'), resize: process.stdout.listenerCount('resize') };
const result = await runPostgresKit({ root: ${JSON.stringify(root)}, stageOut: ${JSON.stringify(out)}, operation: 'generate', args: ['--name','renamed'], interactive: true, timeoutMs: 15000 });
console.log('HARNESS_RESULT=' + JSON.stringify({ result, before, after: { raw: process.stdin.isRaw ?? false, sig: process.listenerCount('SIGINT'), data: process.stdin.listenerCount('data'), resize: process.stdout.listenerCount('resize') } }));`;
		let selected = false;
		const output = await ptyHarness(root, harness, (text, terminal) => {
			if (!selected && text.includes("rename table")) {
				selected = true;
				terminal.write("\x1b[B\r");
			}
		});
		expect(selected).toBe(true);
		const record = output.match(/HARNESS_RESULT=(\{[^\r\n]+\})/)?.[1];
		expect(record, output).toBeDefined();
		if (!record) throw new Error("PTY harness did not report its result");
		const parsed = JSON.parse(record);
		expect(parsed.result.exitCode, parsed.result.stderr).toBe(0);
		expect(parsed.after).toEqual(parsed.before);
		const entry = journal(root, out).entries.at(-1);
		const sql = readFileSync(join(root, out, `${entry.tag}.sql`), "utf8");
		expect(sql).toContain('ALTER TABLE "kit_example" RENAME TO "renamed_example"');
		expect(sql).not.toContain("DROP TABLE");
		expect(latest(root, out).prevId).toBe(previous.id);
	}, 30_000);
});
