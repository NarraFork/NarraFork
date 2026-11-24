import { Database } from "bun:sqlite";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const previousHome = process.env.NARRAFORK_HOME;
const fixture = mkdtempSync(join(tmpdir(), "narrafork-staging-portability-"));
const home = join(fixture, "app");
const project = join(fixture, "project");
const staging = join(project, ".narrafork", "git-staging");
process.env.NARRAFORK_HOME = home;
const { sqlite } = await import("../../db");
const { SNAPSHOT_TABLES } = await import("../../db/snapshot-protocol");
const { applyImport, clearData, exportData, previewImport } = await import("../data-portability");
const selection = { sessions: true, requests: false, providers: false };
const sessionTables = [
	"narrators",
	"narrator_messages",
	"narrator_message_refs",
	"narrator_tool_calls",
	"narrator_blocks",
	"narrator_text_snapshots",
	"recent_tab_archive_marks",
	"folder_git_identity_bindings",
];
// Portability treats project files as opaque; it must not parse or recover these fixtures.
const projectFiles = {
	"lists.json": Buffer.from('{"revision":7,"pendingOperationId":"pending"}\n'),
	[`indexes/${"1".repeat(40)}.index`]: Buffer.from([68, 73, 82, 67, 0, 1, 2, 3]),
	"execution/pending.json": Buffer.from('{"operationId":"pending","state":"prepared"}\n'),
};

beforeEach(async () => {
	sqlite.run("DELETE FROM narrators");
	sqlite.run(
		"INSERT INTO narrators (id,type,cwd,created_at,updated_at) VALUES ('portable-session','primary',?,'now','now')",
		[project],
	);
	for (const [relative, bytes] of Object.entries(projectFiles)) {
		const path = join(staging, relative);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, bytes);
	}
});
afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	try {
		rmSync(fixture, { recursive: true, force: true });
	} catch {
		/* open Windows fixture handles are cleaned by the runner */
	}
});

async function expectProjectFiles(expected: Record<string, Buffer> = projectFiles) {
	for (const [relative, bytes] of Object.entries(expected)) {
		expect((await readFile(join(staging, relative))).toString("hex")).toBe(bytes.toString("hex"));
	}
	expect((await readdir(staging)).sort()).toEqual(["execution", "indexes", "lists.json"]);
}

async function exported() {
	const bytes = await readFile((await exportData(selection)).zipPath);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

test("session snapshots retain the application database table contract", () => {
	expect({
		requests: Array.from<string>(SNAPSHOT_TABLES.requests),
		sessions: Array.from<string>(SNAPSHOT_TABLES.sessions),
	}).toEqual({ requests: ["api_requests"], sessions: sessionTables });
	expect(
		sqlite
			.query("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'git_staging_*'")
			.all(),
	).toEqual([]);
});

test("session export and import preserve the current project stage files", async () => {
	const bytes = await exported();
	await expectProjectFiles();
	const preview = await previewImport(bytes, "sessions.zip");
	const snapshot = new Database(preview.snapshotPath, { readonly: true });
	try {
		expect(
			(
				snapshot
					.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
					.all() as Array<{ name: string }>
			).map((row) => row.name),
		).toEqual(["api_requests", ...sessionTables].sort());
	} finally {
		snapshot.close();
	}

	const latest = { ...projectFiles, "lists.json": Buffer.from('{"revision":8}\n') };
	await writeFile(join(staging, "lists.json"), latest["lists.json"]);
	await clearData("sessions");
	expect(sqlite.query("SELECT id FROM narrators").get()).toBeNull();
	const result = await applyImport(preview.token, { conflictDefault: "skip", include: selection });
	expect(result.sessionsInserted).toBe(1);
	expect(sqlite.query("SELECT cwd FROM narrators WHERE id='portable-session'").get()).toEqual({
		cwd: project,
	});
	await expectProjectFiles(latest);
});

for (const target of ["sessions", "all"] as const) {
	test(`clear ${target} preserves project stage metadata, indexes and pending receipts`, async () => {
		expect((await clearData(target)).deleted.sessions).toBe(1);
		expect(sqlite.query("SELECT id FROM narrators").get()).toBeNull();
		await expectProjectFiles();
	});
}

test("session clearing leaves malformed project metadata available for reconciliation", async () => {
	const malformed = { ...projectFiles, "lists.json": Buffer.from("{unfinished") };
	await writeFile(join(staging, "lists.json"), malformed["lists.json"]);
	expect((await clearData("sessions")).deleted.sessions).toBe(1);
	await expectProjectFiles(malformed);
});
