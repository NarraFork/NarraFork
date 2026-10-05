import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { materializeWorkspaceMigrationBaseline } from "../../tests/materialize-workspace-migration-baseline";
import { applyPendingMigrationsByHash } from "../db/run-migrations";

/** Derive only from this worktree's frozen assets, never the mutable main checkout. */
const baseline = materializeWorkspaceMigrationBaseline();
interface MigrationJournal {
	entries: Array<{ idx: number; tag: string }>;
}
const currentJournal = JSON.parse(
	readFileSync(resolve("drizzle/meta/_journal.json"), "utf8"),
) as MigrationJournal;
const baselineJournal = JSON.parse(
	readFileSync(join(baseline, "meta/_journal.json"), "utf8"),
) as MigrationJournal;
const sqlHash = (folder: string, tag: string) =>
	createHash("sha256")
		.update(readFileSync(join(folder, `${tag}.sql`)))
		.digest("hex");
test("frozen old migration chain upgrades workspace receipts and resource registry without losing state", () => {
	const sqlite = new Database(":memory:");
	try {
		expect(baselineJournal.entries).toEqual(
			currentJournal.entries.slice(0, baselineJournal.entries.length),
		);
		expect(materializeWorkspaceMigrationBaseline()).toBe(baseline);
		for (const entry of baselineJournal.entries)
			expect(sqlHash(baseline, entry.tag)).toBe(sqlHash(resolve("drizzle"), entry.tag));
		applyPendingMigrationsByHash(sqlite, baseline);
		const columns = sqlite.query<{ name: string }, []>("PRAGMA table_info(narrators)").all();
		expect(columns.some((column) => column.name === "workspace_revision")).toBe(false);
		expect(columns.some((column) => column.name === "workspace_context")).toBe(false);
		expect(
			sqlite
				.query(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('permission_rule_requests', 'narrator_worktree_resources')",
				)
				.all(),
		).toEqual([]);
		sqlite
			.query("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
			.run("old-user", "migration-user", "fixture-hash", new Date().toISOString());
		sqlite
			.query(
				"INSERT INTO narrators (id, title, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run(
				"old-narrator",
				"old title",
				"/before",
				new Date().toISOString(),
				new Date().toISOString(),
			);
		const countBefore = sqlite
			.query<{ count: number }, []>("SELECT count(*) AS count FROM __drizzle_migrations")
			.get()?.count;
		applyPendingMigrationsByHash(sqlite, resolve("drizzle"));
		const countAfter = sqlite
			.query<{ count: number }, []>("SELECT count(*) AS count FROM __drizzle_migrations")
			.get()?.count;
		expect(countBefore).toBe(baselineJournal.entries.length);
		expect(countAfter).toBe(currentJournal.entries.length);
		expect((countAfter ?? 0) - (countBefore ?? 0)).toBe(
			currentJournal.entries.length - baselineJournal.entries.length,
		);
		expect(
			sqlite
				.query<{ hash: string }, []>("SELECT hash FROM __drizzle_migrations ORDER BY rowid")
				.all()
				.map((row) => row.hash),
		).toEqual(currentJournal.entries.map((entry) => sqlHash(resolve("drizzle"), entry.tag)));
		expect(
			sqlite.query("SELECT username, password_hash FROM users WHERE id = 'old-user'").get(),
		).toEqual({ username: "migration-user", password_hash: "fixture-hash" });
		expect(
			sqlite
				.query(
					"SELECT title, cwd, workspace_revision, workspace_context FROM narrators WHERE id = 'old-narrator'",
				)
				.get(),
		).toEqual({
			title: "old title",
			cwd: "/before",
			workspace_revision: 0,
			workspace_context: null,
		});
		const workspaceContext = JSON.stringify({ kind: "directory", cwd: "/after" });
		sqlite
			.query("UPDATE narrators SET workspace_revision = ?, workspace_context = ? WHERE id = ?")
			.run(1, workspaceContext, "old-narrator");
		expect(
			sqlite
				.query(
					"SELECT title, cwd, workspace_revision, workspace_context FROM narrators WHERE id = 'old-narrator'",
				)
				.get(),
		).toEqual({
			title: "old title",
			cwd: "/before",
			workspace_revision: 1,
			workspace_context: workspaceContext,
		});
		const requests = sqlite
			.query<{ name: string }, []>("PRAGMA table_info(permission_rule_requests)")
			.all();
		expect(requests.map((column) => column.name)).toContain("attempt");
		expect(requests.map((column) => column.name)).toContain("proposal_hash");
		expect(
			sqlite
				.query<{ name: string }, []>("PRAGMA index_list(permission_rule_requests)")
				.all()
				.some((index) => index.name === "uq_permission_rule_request_attempt"),
		).toBe(true);
		const resources = sqlite
			.query<{ name: string; notnull: number; dflt_value: string | null }, []>(
				"PRAGMA table_info(narrator_worktree_resources)",
			)
			.all();
		// Preserve the legacy nine columns' relative order while requiring all five new fields.
		expect(resources.map((column) => column.name)).toEqual([
			"id",
			"owner_narrator_id",
			"scope_kind",
			"scope_project_id",
			"scope_owner_user_id",
			"ownership_revision",
			"container_config",
			"device_id",
			"repository_key",
			"worktree_path",
			"state",
			"create_request_id",
			"created_at",
			"updated_at",
		]);
		expect(
			resources.slice(2, 7).map(({ name, notnull, dflt_value }) => ({ name, notnull, dflt_value })),
		).toEqual([
			{ name: "scope_kind", notnull: 1, dflt_value: "'unknown'" },
			{ name: "scope_project_id", notnull: 0, dflt_value: null },
			{ name: "scope_owner_user_id", notnull: 0, dflt_value: null },
			{ name: "ownership_revision", notnull: 1, dflt_value: "0" },
			{ name: "container_config", notnull: 0, dflt_value: null },
		]);
		const indexes = sqlite
			.query<{ name: string; unique: number }, []>("PRAGMA index_list(narrator_worktree_resources)")
			.all();
		expect(indexes).toContainEqual(
			expect.objectContaining({ name: "uq_narrator_worktree_resource_path", unique: 1 }),
		);
		expect(indexes).toContainEqual(
			expect.objectContaining({ name: "idx_narrator_worktree_resource_owner" }),
		);
		const foreignKeys = sqlite
			.query<{ from: string; table: string; to: string; on_delete: string; on_update: string }, []>(
				"PRAGMA foreign_key_list(narrator_worktree_resources)",
			)
			.all();
		expect(
			foreignKeys
				.map(({ from, table, to, on_delete, on_update }) => ({
					from,
					table,
					to,
					on_delete,
					on_update,
				}))
				.sort((left, right) => left.from.localeCompare(right.from)),
		).toEqual([
			{
				from: "owner_narrator_id",
				table: "narrators",
				to: "id",
				on_delete: "SET NULL",
				on_update: "NO ACTION",
			},
			{
				from: "scope_owner_user_id",
				table: "users",
				to: "id",
				on_delete: "SET NULL",
				on_update: "NO ACTION",
			},
			{
				from: "scope_project_id",
				table: "projects",
				to: "id",
				on_delete: "SET NULL",
				on_update: "NO ACTION",
			},
		]);
		sqlite.run("PRAGMA foreign_keys = ON");
		sqlite
			.query(
				"INSERT INTO narrator_worktree_resources (id, owner_narrator_id, device_id, repository_key, worktree_path, state, create_request_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				"retained-resource",
				"old-narrator",
				"local",
				"repository-key",
				"/retained/worktree",
				"ready",
				"create-request",
			);
		expect(
			sqlite
				.query(
					"SELECT scope_kind, scope_project_id, scope_owner_user_id, ownership_revision, container_config FROM narrator_worktree_resources WHERE id = ?",
				)
				.get("retained-resource"),
		).toEqual({
			scope_kind: "unknown",
			scope_project_id: null,
			scope_owner_user_id: null,
			ownership_revision: 0,
			container_config: null,
		});
		// These parents and metadata mutations exist only in this isolated memory fixture.
		sqlite.run("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)", [
			"scope-user",
			"scope-user",
			"fixture-hash",
			"fixture-now",
		]);
		sqlite.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", [
			"scope-project",
			"scope fixture",
			"fixture-now",
			"fixture-now",
		]);
		sqlite.run(
			"UPDATE narrator_worktree_resources SET scope_kind = 'project', scope_project_id = ?, scope_owner_user_id = ? WHERE id = ?",
			["scope-project", "scope-user", "retained-resource"],
		);
		const readResource = () =>
			sqlite
				.query<Record<string, unknown>, [string]>(
					"SELECT * FROM narrator_worktree_resources WHERE id = ?",
				)
				.get("retained-resource");
		const beforeParentDeletes = readResource();
		if (!beforeParentDeletes) throw new Error("Isolated resource fixture is missing");
		sqlite.query("DELETE FROM narrators WHERE id = ?").run("old-narrator");
		expect(
			sqlite
				.query(
					"SELECT id, owner_narrator_id, device_id, repository_key, worktree_path, state, create_request_id FROM narrator_worktree_resources WHERE id = ?",
				)
				.get("retained-resource"),
		).toEqual({
			id: "retained-resource",
			owner_narrator_id: null,
			device_id: "local",
			repository_key: "repository-key",
			worktree_path: "/retained/worktree",
			state: "ready",
			create_request_id: "create-request",
		});
		expect(readResource()).toEqual({ ...beforeParentDeletes, owner_narrator_id: null });
		sqlite.run("DELETE FROM projects WHERE id = ?", ["scope-project"]);
		// Missing project evidence must retain project kind, never silently become standalone.
		expect(readResource()).toEqual({
			...beforeParentDeletes,
			owner_narrator_id: null,
			scope_project_id: null,
		});
		sqlite.run("DELETE FROM users WHERE id = ?", ["scope-user"]);
		expect(readResource()).toEqual({
			...beforeParentDeletes,
			owner_narrator_id: null,
			scope_project_id: null,
			scope_owner_user_id: null,
		});
		expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
	} finally {
		sqlite.close();
	}
});

test("frozen baseline refuses changed SQL bytes without overwriting the fixture", () => {
	const root = mkdtempSync(resolve(".narrafork/workspace-baseline-check-"));
	try {
		const target = join(root, "baseline");
		cpSync(baseline, target, { recursive: true });
		const tag = baselineJournal.entries[0].tag;
		appendFileSync(join(target, `${tag}.sql`), "\n-- changed frozen fixture\n");
		const changedHash = sqlHash(target, tag);
		expect(() => materializeWorkspaceMigrationBaseline(resolve("drizzle"), target)).toThrow(
			`Frozen migration bytes differ: ${tag}.sql`,
		);
		expect(sqlHash(target, tag)).toBe(changedHash);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("frozen descriptor rejects a changed old source prefix instead of silently re-freezing", () => {
	const root = mkdtempSync(resolve(".narrafork/workspace-baseline-check-"));
	try {
		const source = join(root, "source");
		const target = join(root, "baseline");
		// Copy real generated assets only; never synthesize replacement migration DDL.
		cpSync(baseline, source, { recursive: true });
		copyFileSync(resolve("drizzle/meta/_journal.json"), join(source, "meta/_journal.json"));
		for (const entry of currentJournal.entries.slice(baselineJournal.entries.length))
			copyFileSync(resolve(`drizzle/${entry.tag}.sql`), join(source, `${entry.tag}.sql`));
		cpSync(baseline, target, { recursive: true });
		const tag = baselineJournal.entries[0].tag;
		const frozenHash = sqlHash(target, tag);
		appendFileSync(join(source, `${tag}.sql`), "\n-- changed old source\n");
		expect(() => materializeWorkspaceMigrationBaseline(source, target)).toThrow(
			"Existing frozen baseline SQL hashes differ; refuse to overwrite it",
		);
		expect(sqlHash(target, tag)).toBe(frozenHash);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
