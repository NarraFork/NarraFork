import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUP_TABLES } from "../../narrator-backup/contract";
import { importLegacyProjectOnWorker } from "../legacy-import-job";
import { exportLegacyProjectOnWorker } from "../legacy-sync-job";
import { ARCHIVE_COLUMNS, ARCHIVE_TABLE_ORDER, type ArchiveTable } from "../manifest";

const dirs: string[] = [];
const handles: Database[] = [];
afterEach(async () => {
	for (const db of handles.splice(0)) db.close();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
function database(path: string) {
	const db = new Database(path, { create: true });
	handles.push(db);
	db.run(
		"CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT); INSERT INTO users VALUES('alice','user'),('bob','user')",
	);
	for (const table of new Set([...Object.keys(BACKUP_TABLES), ...ARCHIVE_TABLE_ORDER])) {
		const columns = new Set([
			...(BACKUP_TABLES[table as keyof typeof BACKUP_TABLES]?.split(" ") ?? []),
			...(ARCHIVE_COLUMNS[table as ArchiveTable] ?? []),
		]);
		db.run(
			`CREATE TABLE ${table} (${[...columns].map((name) => `${name} ${name === "id" ? "TEXT PRIMARY KEY" : ["seq", "refs_backfill_cursor"].includes(name) ? "INTEGER" : "TEXT"}`).join(",")})`,
		);
	}
	return db;
}
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "nf-legacy-worker-"));
	dirs.push(root);
	const sourcePath = join(root, "source.sqlite");
	const archivePath = join(root, "archive.sqlite");
	const targetPath = join(root, "target.sqlite");
	const source = database(sourcePath);
	const archive = database(archivePath);
	const target = database(targetPath);
	source.run(
		"INSERT INTO projects(id,name,git_path) VALUES('p','legacy worker','/source'); INSERT INTO chapters(id,project_id) VALUES('chapter','p'); INSERT INTO narrators(id,type,owner_user_id,chapter_id,title) VALUES('bound','primary','alice','chapter','bound'); INSERT INTO narrators(id,type,owner_user_id,context_project_id,title) VALUES('context','primary','alice','p','explicit'); INSERT INTO narrators(id,type,owner_user_id,cwd,title) VALUES('standalone','primary','alice','/source/.worktrees/matching-cwd','must not select'); INSERT INTO narrator_messages(id,narrator_id,role,content_json) VALUES('message','bound','assistant','[]'); INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES('ref','context','message',7),('standalone-ref','standalone','message',2)",
	);
	const actor = { userId: "alice", isAdmin: false };
	const sync = (signal?: AbortSignal, deadline = Date.now() + 10000) =>
		exportLegacyProjectOnWorker(
			{ databasePath: sourcePath, archivePath, backend: "sqlite", projectId: "p", actor, deadline },
			signal,
		);
	const restore = (signal?: AbortSignal, deadline = Date.now() + 10000) =>
		importLegacyProjectOnWorker(
			{
				databasePath: targetPath,
				archivePath,
				backend: "sqlite",
				gitPath: "/target",
				actor,
				deadline,
			},
			signal,
		);
	return { source, archive, target, sourcePath, archivePath, targetPath, sync, restore, actor };
}

test("real legacy worker selects chapter OR explicit context, preserves unknown/shared refs and removes stale explicit scope", async () => {
	const { source, archive, sync } = await fixture();
	archive.run(
		"INSERT INTO chapters(id,project_id) VALUES('old-chapter','p'); INSERT INTO narrators(id,chapter_id) VALUES('stale','old-chapter'); INSERT INTO narrators(id,title) VALUES('unknown','legacy unknown'); INSERT INTO narrator_messages(id,narrator_id,role,content_json) VALUES('shared','unknown','assistant','[]'); INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES('old-ref','stale','shared',1),('keep-ref','unknown','shared',2)",
	);
	const before = JSON.stringify(
		source.prepare("SELECT * FROM narrator_message_refs ORDER BY id").all(),
	);
	const result = await sync();
	expect(result.tables.narrators).toBe(2);
	expect(archive.prepare("SELECT id FROM narrators ORDER BY id").all()).toEqual([
		{ id: "bound" },
		{ id: "context" },
		{ id: "unknown" },
	]);
	expect(archive.prepare("SELECT id FROM narrator_message_refs ORDER BY id").all()).toEqual([
		{ id: "keep-ref" },
		{ id: "ref" },
	]);
	expect(archive.prepare("SELECT id FROM narrator_messages ORDER BY id").all()).toEqual([
		{ id: "message" },
		{ id: "shared" },
	]);
	expect(
		JSON.stringify(source.prepare("SELECT * FROM narrator_message_refs ORDER BY id").all()),
	).toBe(before);
});

test("legacy Worker import archives restored state, raises seq floor and rolls back target atomically", async () => {
	const { archive, target, sync, restore } = await fixture();
	await sync();
	target.run(
		"CREATE TRIGGER fail_refs BEFORE INSERT ON narrator_message_refs BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
	);
	await expect(restore()).rejects.toThrow("validation or operation failed");
	expect(target.prepare("SELECT id FROM projects").all()).toEqual([]);
	expect(target.prepare("SELECT id FROM narrators").all()).toEqual([]);
	target.run("DROP TRIGGER fail_refs");
	const before = JSON.stringify(archive.prepare("SELECT * FROM narrator_message_refs").all());
	const result = await restore();
	expect(result.skipped).toBe(false);
	expect(
		target.prepare("SELECT id,status,permission_mode,next_seq FROM narrators ORDER BY id").all(),
	).toEqual([
		{ id: "bound", status: "archived", permission_mode: "readOnly", next_seq: "0" },
		{ id: "context", status: "archived", permission_mode: "readOnly", next_seq: "8" },
	]);
	expect(JSON.stringify(archive.prepare("SELECT * FROM narrator_message_refs").all())).toBe(before);
	// Legacy project-level skip is retained; narrator-backup v1 instead rejects every ID collision.
	expect((await restore()).skipped).toBe(true);
});

test("legacy untrusted SQLite views/virtual tables reject before target writes", async () => {
	const { archive, target, sync, restore } = await fixture();
	await sync();
	archive.run(
		"ALTER TABLE narrator_messages RENAME TO payload; CREATE VIEW narrator_messages AS SELECT * FROM payload",
	);
	await expect(restore()).rejects.toThrow("validation or operation failed");
	expect(target.prepare("SELECT id FROM projects").all()).toEqual([]);
	archive.run(
		"DROP VIEW narrator_messages; CREATE VIRTUAL TABLE narrator_messages USING fts5(id,narrator_id,content_json)",
	);
	await expect(restore()).rejects.toThrow("validation or operation failed");
	expect(target.prepare("SELECT id FROM projects").all()).toEqual([]);
});

test("real legacy clients propagate cancelled signals and expired deadlines without writes", async () => {
	const { archive, target, sync, restore } = await fixture();
	const controller = new AbortController();
	controller.abort();
	await expect(sync(controller.signal)).rejects.toThrow();
	await expect(restore(controller.signal)).rejects.toThrow();
	await expect(sync(undefined, Date.now() - 1)).rejects.toThrow("timed out");
	await expect(restore(undefined, Date.now() - 1)).rejects.toThrow("timed out");
	expect(archive.prepare("SELECT id FROM projects").all()).toEqual([]);
	expect(target.prepare("SELECT id FROM projects").all()).toEqual([]);
});
