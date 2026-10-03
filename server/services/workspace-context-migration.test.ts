import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { materializeWorkspaceMigrationBaseline } from "../../tests/materialize-workspace-migration-baseline";
import { applyPendingMigrationsByHash } from "../db/run-migrations";

/** Derive only from this worktree's frozen assets, never the mutable main checkout. */
const baseline = materializeWorkspaceMigrationBaseline();
const currentJournal = JSON.parse(readFileSync(resolve("drizzle/meta/_journal.json"), "utf8")) as {
	entries: Array<{ idx: number; tag: string }>;
};
test("frozen old migration chain upgrades workspace receipts and resource registry without losing state", () => {
	const sqlite = new Database(":memory:");
	try {
		applyPendingMigrationsByHash(sqlite, baseline);
		const columns = sqlite.query<{ name: string }, []>("PRAGMA table_info(narrators)").all();
		expect(columns.some((column) => column.name === "workspace_revision")).toBe(false);
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
		expect(countBefore).toBe(186);
		expect(currentJournal.entries[186]?.tag).toBe("0186_polite_preak");
		expect(currentJournal.entries[187]?.tag).toBe("0187_woozy_giant_girl");
		// Preserve the fixed old prefix, but accept every legal append-only successor.
		expect(countAfter).toBe((countBefore ?? 0) + currentJournal.entries.length - 186);
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
			.query<{ name: string }, []>("PRAGMA table_info(narrator_worktree_resources)")
			.all();
		expect(resources.map((column) => column.name)).toEqual([
			"id",
			"owner_narrator_id",
			"device_id",
			"repository_key",
			"worktree_path",
			"state",
			"create_request_id",
			"created_at",
			"updated_at",
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
			.query<{ from: string; table: string; on_delete: string }, []>(
				"PRAGMA foreign_key_list(narrator_worktree_resources)",
			)
			.all();
		expect(foreignKeys).toMatchObject([
			{ from: "owner_narrator_id", table: "narrators", on_delete: "SET NULL" },
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
	} finally {
		sqlite.close();
	}
});
