/**
 * Tests for the offline spec table-loss scan.
 *
 * Every database here is a small fixture built in a temp directory; the real ~/.narrafork is never
 * touched (the test preload also isolates HOME). The fixture schema is the subset of columns the
 * scan reads, and a guard below checks those columns against the Drizzle schema so a rename cannot
 * leave the script querying columns that no longer exist.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
	formatSpecTableLossReport,
	hasGfmTableDelimiterRow,
	isGfmTableDelimiterRow,
	openDatabaseReadOnly,
	parseArgs,
	scanSpecTableLoss,
} from "../../scripts/find-spec-table-loss";
import { narrators, specFileRevisions, specNamespaces } from "../../server/db/schema";

const SCRIPT = resolve(import.meta.dir, "../../scripts/find-spec-table-loss.ts");

const TABLE = "# 方案\n\n| 方案 | 风险 |\n| --- | :---: |\n| A | 低 |\n";
const NO_TABLE = "# 方案\n\n方案 风险 A 低\n";

let dir = "";
let dbPath = "";

interface Revision {
	id: string;
	ns: string;
	path: string;
	content: string;
	parent: string | null;
	by: "system" | "user" | "assistant";
	at: string;
}

function buildFixture(path: string, revisions: Revision[]) {
	const db = new Database(path, { create: true });
	try {
		db.exec(`
			CREATE TABLE narrators (id TEXT PRIMARY KEY, title TEXT);
			CREATE TABLE spec_namespaces (
				id TEXT PRIMARY KEY, narrator_id TEXT NOT NULL, forked_from_namespace_id TEXT,
				created_at TEXT NOT NULL, updated_at TEXT NOT NULL
			);
			CREATE TABLE spec_file_revisions (
				id TEXT PRIMARY KEY, namespace_id TEXT NOT NULL, path TEXT NOT NULL,
				content TEXT NOT NULL, content_hash TEXT NOT NULL, parent_revision_id TEXT,
				source_tool_use_id TEXT, source_message_id TEXT,
				created_by TEXT NOT NULL DEFAULT 'assistant', created_at TEXT NOT NULL
			);
			INSERT INTO narrators VALUES ('n1', '存储迁移'), ('n2', NULL);
			INSERT INTO spec_namespaces VALUES
				('ns1', 'n1', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
				('ns2', 'n2', 'ns1', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');
		`);
		const insert = db.prepare(
			"INSERT INTO spec_file_revisions (id, namespace_id, path, content, content_hash, parent_revision_id, created_by, created_at) VALUES (?, ?, ?, ?, 'h', ?, ?, ?)",
		);
		for (const r of revisions) insert.run(r.id, r.ns, r.path, r.content, r.parent, r.by, r.at);
	} finally {
		db.close();
	}
}

function rev(
	id: string,
	path: string,
	content: string,
	parent: string | null,
	by: Revision["by"],
	ns = "ns1",
): Revision {
	return {
		id,
		ns,
		path,
		content,
		parent,
		by,
		at: `2026-02-01T00:00:${id.slice(1).padStart(2, "0")}Z`,
	};
}

const REVISIONS: Revision[] = [
	// design.md: the agent wrote a table, a panel save dropped it, then the user re-added one.
	rev("r1", "design.md", TABLE, null, "assistant"),
	rev("r2", "design.md", NO_TABLE, "r1", "user"),
	rev("r3", "design.md", TABLE, "r2", "user"),
	// notes.md: the agent itself removed the table, not a panel save.
	rev("r4", "notes.md", TABLE, null, "assistant"),
	rev("r5", "notes.md", NO_TABLE, "r4", "assistant"),
	// plan.md: a panel save that kept the table.
	rev("r6", "plan.md", TABLE, null, "assistant"),
	rev("r7", "plan.md", `${TABLE}\n补充\n`, "r6", "user"),
	// tasks.json is saved by the task board, never by the markdown editor.
	rev("r8", "tasks.json", '{"tasks":[{"text":"| --- |"}]}', null, "assistant"),
	rev("r9", "tasks.json", '{"tasks":[]}', "r8", "user"),
	// code.md: pipes, but no delimiter row.
	rev("r10", "code.md", "`a | b` 与 x || y\n", null, "assistant"),
	rev("r11", "code.md", "改了\n", "r10", "user"),
	// A forked namespace whose first save points at the parent namespace's revision.
	rev("r12", "design.md", NO_TABLE, "r1", "user", "ns2"),
	// A table in a list item, then a save without it.
	rev("r13", "list.md", "- 项\n\n  | x | y |\n  | - | - |\n  | 1 | 2 |\n", null, "system"),
	rev("r14", "list.md", "- 项\n", "r13", "user"),
];

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "spec-table-loss-"));
	dbPath = join(dir, "narrafork.db");
	buildFixture(dbPath, REVISIONS);
});

afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("isGfmTableDelimiterRow", () => {
	test.each([
		"| --- | --- |",
		"|---|:---:|---:|",
		"--|--",
		"| - |",
		"  | :-- | --: |",
		"> | --- | --- |",
		"| --- | --- |   ",
	])("accepts %p", (line) => {
		expect(isGfmTableDelimiterRow(line)).toBe(true);
	});

	test.each([
		"---",
		"***",
		"- [ ] task",
		"| a | b |",
		"|",
		"--- | text",
		"a | b",
		"",
		"| : |",
	])("rejects %p", (line) => {
		expect(isGfmTableDelimiterRow(line)).toBe(false);
	});

	test("finds a delimiter row anywhere in a document, with CRLF too", () => {
		expect(hasGfmTableDelimiterRow(TABLE)).toBe(true);
		expect(hasGfmTableDelimiterRow(TABLE.replaceAll("\n", "\r\n"))).toBe(true);
		expect(hasGfmTableDelimiterRow(NO_TABLE)).toBe(false);
	});
});

describe("scanSpecTableLoss", () => {
	test("reports user saves that dropped every table their parent had", () => {
		const db = openDatabaseReadOnly(dbPath);
		try {
			const report = scanSpecTableLoss(db);
			expect(report.findings).toEqual([
				{
					path: "design.md",
					namespaceId: "ns1",
					narratorId: "n1",
					narratorTitle: "存储迁移",
					before: { revisionId: "r1", createdAt: "2026-02-01T00:00:01Z", createdBy: "assistant" },
					after: { revisionId: "r2", createdAt: "2026-02-01T00:00:02Z" },
				},
				{
					path: "design.md",
					namespaceId: "ns2",
					narratorId: "n2",
					narratorTitle: null,
					before: { revisionId: "r1", createdAt: "2026-02-01T00:00:01Z", createdBy: "assistant" },
					after: { revisionId: "r12", createdAt: "2026-02-01T00:00:12Z" },
				},
				{
					path: "list.md",
					namespaceId: "ns1",
					narratorId: "n1",
					narratorTitle: "存储迁移",
					before: { revisionId: "r13", createdAt: "2026-02-01T00:00:13Z", createdBy: "system" },
					after: { revisionId: "r14", createdAt: "2026-02-01T00:00:14Z" },
				},
			]);
			// User saves on non-tasks files whose parent contains a pipe: r2, r7, r11, r12, r14.
			expect(report.checked).toBe(5);
		} finally {
			db.close();
		}
	});

	test("returns the same result whatever the page size", () => {
		const db = openDatabaseReadOnly(dbPath);
		try {
			const full = scanSpecTableLoss(db, { pageSize: 1000 });
			for (const pageSize of [1, 2, 3, 5]) {
				expect(scanSpecTableLoss(db, { pageSize })).toEqual(full);
			}
		} finally {
			db.close();
		}
	});

	test("refuses a database without spec revisions", () => {
		const emptyPath = join(dir, "empty.db");
		new Database(emptyPath, { create: true }).close();
		const db = openDatabaseReadOnly(emptyPath);
		try {
			expect(() => scanSpecTableLoss(db)).toThrow("spec_file_revisions");
		} finally {
			db.close();
		}
	});

	test("formats findings for a person to act on", () => {
		const db = openDatabaseReadOnly(dbPath);
		try {
			const text = formatSpecTableLossReport(scanSpecTableLoss(db), dbPath);
			expect(text).toContain("3 save(s) dropped every GFM table");
			expect(text).toContain('- spec://design.md  narrator n1 "存储迁移", namespace ns1');
			expect(text).toContain("  before: r1  2026-02-01T00:00:01Z  (assistant)");
			expect(text).toContain("  after:  r2  2026-02-01T00:00:02Z  (user)");
		} finally {
			db.close();
		}
	});
});

describe("read-only access", () => {
	test("the connection cannot write", () => {
		const db = openDatabaseReadOnly(dbPath);
		try {
			expect(() => db.run("DELETE FROM spec_file_revisions")).toThrow();
			expect(() => db.run("CREATE TABLE t (a)")).toThrow();
		} finally {
			db.close();
		}
		const check = new Database(dbPath, { readonly: true });
		try {
			expect(check.query("SELECT count(*) AS n FROM spec_file_revisions").get()).toEqual({
				n: REVISIONS.length,
			});
		} finally {
			check.close();
		}
	});

	test("a missing database is reported, not created", () => {
		const missing = join(dir, "missing", "narrafork.db");
		expect(() => openDatabaseReadOnly(missing)).toThrow("Database not found");
		expect(existsSync(missing)).toBe(false);
	});

	test("the CLI prints the report and leaves the database file byte-identical", () => {
		const before = readFileSync(dbPath);
		const result = Bun.spawnSync([process.execPath, SCRIPT, dbPath, "--page-size", "2"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		const stdout = result.stdout.toString();
		expect(stdout).toContain("Checked 5 Spec-panel saves");
		expect(stdout).toContain("spec://list.md");
		expect(readFileSync(dbPath).equals(before)).toBe(true);
		expect(existsSync(`${dbPath}-journal`)).toBe(false);
		expect(existsSync(`${dbPath}-wal`)).toBe(false);
	});

	test("the CLI emits JSON and fails cleanly on a missing file", () => {
		const json = Bun.spawnSync([process.execPath, SCRIPT, dbPath, "--json"], { stdout: "pipe" });
		expect(json.exitCode).toBe(0);
		expect(JSON.parse(json.stdout.toString()).findings.length).toBe(3);
		const missing = Bun.spawnSync([process.execPath, SCRIPT, join(dir, "nope.db")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(missing.exitCode).toBe(1);
		expect(missing.stderr.toString()).toContain("Database not found");
		expect(existsSync(join(dir, "nope.db"))).toBe(false);
	});
});

describe("parseArgs", () => {
	test("defaults to ~/.narrafork/narrafork.db", () => {
		const args = parseArgs([]);
		expect(args.databasePath.endsWith(join(".narrafork", "narrafork.db"))).toBe(true);
		expect(args).toMatchObject({ pageSize: 50, json: false });
	});

	test("takes a path, a page size and --json", () => {
		expect(parseArgs(["./x.db", "--page-size", "7", "--json"])).toEqual({
			databasePath: resolve("./x.db"),
			pageSize: 7,
			json: true,
		});
		expect(() => parseArgs(["--page-size", "0"])).toThrow();
		expect(() => parseArgs(["--write"])).toThrow("Unknown option");
	});
});

test("the columns the scan reads exist in the Drizzle schema", () => {
	const columns = (table: Parameters<typeof getTableConfig>[0]) =>
		getTableConfig(table).columns.map((column) => column.name);
	expect(getTableConfig(specFileRevisions).name).toBe("spec_file_revisions");
	expect(columns(specFileRevisions)).toEqual(
		expect.arrayContaining([
			"id",
			"namespace_id",
			"path",
			"content",
			"parent_revision_id",
			"created_by",
			"created_at",
		]),
	);
	expect(getTableConfig(specNamespaces).name).toBe("spec_namespaces");
	expect(columns(specNamespaces)).toEqual(expect.arrayContaining(["id", "narrator_id"]));
	expect(getTableConfig(narrators).name).toBe("narrators");
	expect(columns(narrators)).toEqual(expect.arrayContaining(["id", "title"]));
	// The provenance value the UI save route writes.
	const createdBy = getTableConfig(specFileRevisions).columns.find((c) => c.name === "created_by");
	expect(createdBy?.enumValues).toContain("user");
});
