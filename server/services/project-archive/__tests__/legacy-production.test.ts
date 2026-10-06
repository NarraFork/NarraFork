import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTestDb } from "../../../../tests/setup";
import { openDatabase } from "../../../db/connection";
import { importLegacyProjectOnWorker } from "../legacy-import-job";
import { exportLegacyProjectOnWorker } from "../legacy-sync-job";
import { PROJECT_ARCHIVE_LIMITS } from "../limits";
import { ARCHIVE_COLUMNS, ARCHIVE_TABLE_ORDER } from "../manifest";

// SQLite production migrations/defaults/FKs, not a PostgreSQL mock or live PG claim.
const schema = getTestDb();
const schemaBytes = schema.sqlite.serialize();
const productionDefaults = new Map<string, Record<string, string | number | null>>();
for (const table of ARCHIVE_TABLE_ORDER) {
	const defaults: Record<string, string | number | null> = {};
	for (const field of schema.sqlite.prepare(`PRAGMA table_info(${table})`).all() as {
		name: string;
		dflt_value: string | null;
	}[]) {
		if (field.dflt_value != null)
			defaults[field.name] = (
				schema.sqlite.prepare(`SELECT ${field.dflt_value} AS value`).get() as {
					value: string | number | null;
				}
			).value;
	}
	productionDefaults.set(table, defaults);
}
schema.sqlite.close();
const dirs: string[] = [];
const handles: Database[] = [];
const now = new Date().toISOString();
const actor = { userId: "alice", isAdmin: false };
afterEach(async () => {
	for (const handle of handles.splice(0)) handle.close();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
function insert(db: Database, table: string, row: Record<string, string | number | null>) {
	const fields = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
		(field) => field.name,
	);
	const values = { ...row };
	for (const [field, value] of Object.entries(productionDefaults.get(table) ?? {}))
		if (fields.includes(field) && !Object.hasOwn(values, field)) values[field] = value;
	for (const field of ["created_at", "updated_at"])
		if (fields.includes(field) && !Object.hasOwn(values, field)) values[field] = now;
	const columns = Object.keys(values);
	db.prepare(
		`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
	).run(...columns.map((field) => values[field]));
}
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "nf-legacy-production-"));
	dirs.push(dir);
	const sourcePath = join(dir, "source.db"),
		targetPath = join(dir, "target.db"),
		archivePath = join(dir, "project.db");
	await writeFile(sourcePath, schemaBytes);
	await writeFile(targetPath, schemaBytes);
	const source = openDatabase(sourcePath),
		target = openDatabase(targetPath),
		archive = new Database(archivePath, { create: true });
	handles.push(source, target, archive);
	for (const db of [source, target])
		for (const id of ["alice", "bob"])
			insert(db, "users", { id, username: id, password_hash: "fixture", role: "user" });
	for (const table of ARCHIVE_TABLE_ORDER)
		archive.run(
			`CREATE TABLE ${table} (${ARCHIVE_COLUMNS[table].map((field) => `${field} ${field === "id" ? "TEXT PRIMARY KEY" : field === "seq" ? "INTEGER" : "TEXT"}`).join(",")})`,
		);
	insert(source, "projects", {
		id: "p",
		name: "Production legacy fixture",
		git_path: "/source",
		owner_user_id: "alice",
	});
	insert(source, "narrators", { id: "root", context_project_id: "p", owner_user_id: "alice" });
	const sync = () =>
		exportLegacyProjectOnWorker({
			backend: "sqlite",
			databasePath: sourcePath,
			archivePath,
			projectId: "p",
			actor,
			deadline: Date.now() + 10000,
		});
	const restore = () =>
		importLegacyProjectOnWorker({
			backend: "sqlite",
			databasePath: targetPath,
			archivePath,
			gitPath: "/restored",
			actor,
			deadline: Date.now() + 10000,
		});
	return { source, target, archive, sync, restore };
}
function message(db: Database, id: string, narratorId: string, seq = 0) {
	insert(db, "narrator_messages", {
		id,
		narrator_id: narratorId,
		role: "assistant",
		content_json: "[]",
	});
	insert(db, "narrator_message_refs", {
		id: `ref-${id}`,
		narrator_id: narratorId,
		message_id: id,
		seq,
	});
	insert(db, "narrator_tool_calls", {
		id: `tool-${id}`,
		narrator_id: narratorId,
		message_id: id,
		tool_use_id: id,
		tool_name: "Read",
		status: "success",
	});
}

test("production FK selection includes contextless subagent descendants, not primary siblings or ask-other roots", async () => {
	const { source, archive, target, sync, restore } = await fixture();
	insert(source, "narrators", {
		id: "child",
		type: "subagent",
		variant: "subagent:general",
		parent_narrator_id: "root",
		acl_root_narrator_id: "root",
		owner_user_id: "alice",
	});
	insert(source, "narrators", {
		id: "nested",
		type: "subagent",
		variant: "subagent:review",
		parent_narrator_id: "child",
		acl_root_narrator_id: "root",
		owner_user_id: "alice",
	});
	insert(source, "narrators", {
		id: "sibling",
		type: "primary",
		parent_narrator_id: "root",
		owner_user_id: "alice",
	});
	insert(source, "narrators", { id: "ask-other", type: "primary", owner_user_id: "bob" });
	for (const id of ["root", "child", "nested", "sibling", "ask-other"])
		message(source, `message-${id}`, id);
	const before = source.serialize();
	await sync();
	expect(archive.prepare("SELECT id FROM narrators ORDER BY id").all()).toEqual([
		{ id: "child" },
		{ id: "nested" },
		{ id: "root" },
	]);
	expect(archive.prepare("SELECT count(*) AS count FROM narrator_tool_calls").get()).toEqual({
		count: 3,
	});
	expect(source.serialize()).toEqual(before);
	await restore();
	expect(target.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("current variant subagent identity requires its actual ACL root, not a claimed owner", async () => {
	const { source, archive, sync } = await fixture();
	insert(source, "narrators", { id: "foreign-root", owner_user_id: "bob" });
	insert(source, "narrators", {
		id: "variant-child",
		type: "primary",
		variant: "subagent:general",
		parent_narrator_id: "root",
		acl_root_narrator_id: "foreign-root",
		owner_user_id: "alice",
	});
	message(source, "private-child-message", "variant-child");
	const before = archive.serialize();
	await expect(sync()).rejects.toMatchObject({
		statusCode: 403,
		code: "PROJECT_ARCHIVE_FORBIDDEN",
	});
	expect(archive.serialize()).toEqual(before);
});

test("lazy cycles and oversized production rows are bounded and leave the archive unpublished", async () => {
	const { source, archive, sync } = await fixture();
	source.run(
		"UPDATE narrators SET refs_inherited_from='root',refs_backfill_cursor=4 WHERE id='root'",
	);
	const before = archive.serialize();
	await expect(sync()).rejects.toThrow("validation or operation failed");
	expect(archive.serialize()).toEqual(before);
	source.run(
		"UPDATE narrators SET refs_inherited_from=NULL,refs_backfill_cursor=NULL WHERE id='root'",
	);
	message(source, "huge", "root");
	source
		.prepare("UPDATE narrator_messages SET content_json=? WHERE id='huge'")
		.run(JSON.stringify([{ type: "text", text: "x".repeat(PROJECT_ARCHIVE_LIMITS.rowBytes) }]));
	await expect(sync()).rejects.toThrow("validation or operation failed");
	expect(archive.serialize()).toEqual(before);
});

test("production lazy windows honor every ancestor cut without source backfill or sibling transcript", async () => {
	const { source, archive, target, sync, restore } = await fixture();
	insert(source, "narrators", { id: "grand", owner_user_id: "alice" });
	insert(source, "narrators", {
		id: "parent",
		owner_user_id: "alice",
		refs_inherited_from: "grand",
		refs_backfill_cursor: 3,
	});
	source.run(
		"UPDATE narrators SET refs_inherited_from='parent',refs_backfill_cursor=5 WHERE id='root'",
	);
	message(source, "early", "grand", 1);
	message(source, "excluded", "grand", 4);
	message(source, "parent-local", "parent", 3);
	const before = source.serialize();
	await sync();
	expect(
		archive
			.prepare(
				"SELECT message_id,seq FROM narrator_message_refs WHERE narrator_id='root' ORDER BY seq",
			)
			.all(),
	).toEqual([
		{ message_id: "early", seq: 1 },
		{ message_id: "parent-local", seq: 3 },
	]);
	expect(archive.prepare("SELECT id FROM narrator_messages WHERE id='excluded'").get()).toBeNull();
	expect(source.serialize()).toEqual(before);
	await restore();
	expect(target.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("unknown surviving ref preserves deleted chapter author metadata and tools, not deleted author's refs", async () => {
	const { archive, target, sync, restore } = await fixture();
	insert(archive, "projects", { id: "p", name: "old", git_path: "/old" });
	insert(archive, "chapters", {
		id: "old-chapter",
		project_id: "p",
		title: "old",
		branch: "old",
		base_branch: "main",
	});
	insert(archive, "narrators", {
		id: "deleted-author",
		chapter_id: "old-chapter",
		type: "primary",
	});
	insert(archive, "narrators", { id: "unknown", type: "primary" });
	message(archive, "shared", "deleted-author");
	insert(archive, "narrator_message_refs", {
		id: "unknown-ref",
		narrator_id: "unknown",
		message_id: "shared",
		seq: 1,
	});
	await sync();
	expect(archive.prepare("SELECT id FROM narrators WHERE id='deleted-author'").get()).toEqual({
		id: "deleted-author",
	});
	expect(
		archive
			.prepare("SELECT id FROM narrator_message_refs WHERE narrator_id='deleted-author'")
			.all(),
	).toEqual([]);
	expect(
		archive.prepare("SELECT id FROM narrator_tool_calls WHERE message_id='shared'").all(),
	).toEqual([{ id: "tool-shared" }]);
	await restore();
	expect(target.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
	expect(
		target.prepare("SELECT status,permission_mode FROM narrators WHERE id='deleted-author'").get(),
	).toEqual({ status: "archived", permission_mode: "readOnly" });
});

test("missing historical author blocks publication atomically rather than writing an incomplete archive", async () => {
	const { archive, sync } = await fixture();
	insert(archive, "narrators", { id: "unknown", type: "primary" });
	insert(archive, "narrator_messages", {
		id: "dangling",
		narrator_id: "absent-author",
		role: "assistant",
		content_json: "[]",
	});
	insert(archive, "narrator_message_refs", {
		id: "ref",
		narrator_id: "unknown",
		message_id: "dangling",
		seq: 0,
	});
	const before = archive.serialize();
	await expect(sync()).rejects.toThrow("validation or operation failed");
	expect(archive.serialize()).toEqual(before);
});

test("source-absent historical author never grants access to an existing foreign target owner", async () => {
	const { archive, target, sync, restore } = await fixture();
	insert(archive, "narrators", { id: "historical", type: "primary" });
	insert(archive, "narrators", { id: "unknown", type: "primary" });
	message(archive, "shared", "historical");
	insert(archive, "narrator_message_refs", {
		id: "unknown-ref",
		narrator_id: "unknown",
		message_id: "shared",
		seq: 1,
	});
	await sync();
	insert(target, "narrators", { id: "historical", owner_user_id: "bob" });
	await expect(restore()).rejects.toThrow("validation or operation failed");
	expect(target.prepare("SELECT id FROM projects").all()).toEqual([]);
});

test("external chapter_settings reserved IDs lose provenance without changing any deny or policy level", async () => {
	const { source, target, sync, restore } = await fixture();
	const levels = ["denyAll", "denyWrite", "ask", "allow"];
	const settings = {
		permissionRules: levels.map((policyLevel) => ({
			id: `review-boundary:${policyLevel}`,
			toolName: "Read",
			policyLevel,
			enabled: true,
		})),
		directoryPermissionRules: levels.map((denyLevel) => ({
			id: `review-boundary:${denyLevel}`,
			path: "/protected",
			denyLevel,
			enabled: true,
			targetKind: "host",
			deviceScope: "local",
		})),
		custom: { id: "ordinary-id", enabled: true },
	};
	source
		.prepare("UPDATE projects SET chapter_settings=? WHERE id='p'")
		.run(JSON.stringify(settings));
	await sync();
	await restore();
	const restored = JSON.parse(
		(
			target.prepare("SELECT chapter_settings FROM projects WHERE id='p'").get() as {
				chapter_settings: string;
			}
		).chapter_settings,
	);
	expect(restored).toEqual({
		...settings,
		permissionRules: settings.permissionRules.map(({ id: _id, ...rule }) => rule),
		directoryPermissionRules: settings.directoryPermissionRules.map(({ id: _id, ...rule }) => rule),
	});
	expect(target.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("old malicious archive omitting safe-state columns cannot inherit executable production defaults", async () => {
	const { source, archive, target, sync, restore } = await fixture();
	message(source, "pending-message", "root");
	source.run(
		"UPDATE narrators SET status='working',permission_mode='bypassPermissions',is_background=1,background_status='running',substatus='[\"reasoning\"]'; UPDATE narrator_tool_calls SET status='pending',permission_decided_by='alice',permission_decided_at='2026-01-01'",
	);
	await sync();
	for (const field of [
		"status",
		"permission_mode",
		"is_background",
		"background_status",
		"substatus",
		"turn_started_at",
	])
		archive.run(`ALTER TABLE narrators DROP COLUMN ${field}`);
	archive.run("ALTER TABLE narrator_tool_calls DROP COLUMN status");
	await restore();
	expect(
		target
			.prepare(
				"SELECT status,permission_mode,is_background,background_status,substatus,turn_started_at FROM narrators WHERE id='root'",
			)
			.get(),
	).toEqual({
		status: "archived",
		permission_mode: "readOnly",
		is_background: 0,
		background_status: "cancelled",
		substatus: "[]",
		turn_started_at: null,
	});
	expect(
		target
			.prepare(
				"SELECT status,is_background,execution_attempt,execution_identity_version,permission_decided_by,permission_decided_at FROM narrator_tool_calls",
			)
			.get(),
	).toEqual({
		status: "fail",
		is_background: 0,
		execution_attempt: 0,
		execution_identity_version: 0,
		permission_decided_by: null,
		permission_decided_at: null,
	});
	expect(target.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
