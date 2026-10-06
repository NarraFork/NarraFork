/**
 * Folding `knowledge_grants` + `narrator_grants` into `acl_grants`.
 *
 * This is the only step of the ACL unification that rewrites live authorization
 * data, so the properties pinned here are the ones whose violation would be either
 * an escalation or a silent lockout:
 *
 *  1. **A knowledge credential must not become a read capability.** Someone holding
 *     only a low clearance must NOT come out of the migration able to read
 *     everything. This is the single most dangerous way to get the mapping wrong.
 *  2. **`canWrite` does become a real write capability**, since it always was one.
 *  3. **Narrator grants map straight across**, read and write preserved.
 *  4. **Idempotent**: running the migration pass again changes nothing, and
 *     duplicates collapse rather than erroring.
 *  5. **Legacy tables survive**, so a bad migration is a code rollback.
 *  6. Projects come out `public` with no invented owner.
 *
 * Runs the real migration pass against a database rewound to just before the
 * unification migration, same technique as `run-migrations.test.ts`.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../run-migrations";

/** folderMillis of 0127_thick_satana, which introduces acl_grants. */
const UNIFIED_ACL_WHEN = 1786800022207;

let sqlite: Database | undefined;

afterEach(() => {
	sqlite?.close();
	sqlite = undefined;
});

interface AclRow {
	scope_type: string;
	scope_id: string | null;
	principal_type: string;
	principal_id: string;
	capability: string;
	domain_kind: string | null;
	domain_value: string | null;
}

function aclRows(db: Database, principalId: string): AclRow[] {
	return db
		.prepare(
			`SELECT scope_type, scope_id, principal_type, principal_id, capability,
			        domain_kind, domain_value
			   FROM acl_grants WHERE principal_id = ? ORDER BY capability, domain_value`,
		)
		.all(principalId) as AclRow[];
}

/**
 * A database migrated to just before 0127: the unified tables and the new columns
 * absent, and legacy grant rows present exactly as a live instance would hold them.
 */
async function databaseBeforeUnification(): Promise<Database> {
	const db = new Database(":memory:");
	await runMigrations(db);

	// Rewind the schema to the pre-0127 state.
	db.run("DROP TABLE IF EXISTS acl_grants");
	db.run("DROP TABLE IF EXISTS acl_events");
	db.run("DROP INDEX IF EXISTS idx_projects_owner");
	db.run("ALTER TABLE projects DROP COLUMN visibility");
	db.run("ALTER TABLE projects DROP COLUMN owner_user_id");
	db.run("ALTER TABLE knowledge_collections DROP COLUMN inherit_project_gate");
	db.run("DELETE FROM __drizzle_migrations WHERE created_at = ?", [UNIFIED_ACL_WHEN]);

	const now = "2026-07-19T00:00:00.000Z";
	db.run("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?,?,?,?,?)", [
		"u-analyst",
		"analyst",
		"x",
		"user",
		now,
	]);
	db.run("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?,?,?,?,?)", [
		"u-editor",
		"editor",
		"x",
		"user",
		now,
	]);
	db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?,?,?,?)", [
		"p-1",
		"legacy project",
		now,
		now,
	]);
	db.run("INSERT INTO narrators (id, created_at, updated_at) VALUES (?,?,?)", ["n-1", now, now]);
	db.run(
		`INSERT INTO knowledge_collections (id, name, slug, default_level, created_at, updated_at)
		 VALUES (?,?,?,?,?,?)`,
		["c-1", "collection", "collection", "public", now, now],
	);

	// A clearance-only holder: the escalation case. No canWrite, no tags.
	db.run(
		`INSERT INTO knowledge_grants
		   (id, collection_id, principal_type, principal_id, grant_type, clearance_level, can_write, created_at)
		 VALUES (?,?,?,?,?,?,?,?)`,
		["kg-clearance", null, "user", "u-analyst", "clearance", "internal", 0, now],
	);
	// A tag grant that ALSO carries canWrite — one row, two meanings.
	db.run(
		`INSERT INTO knowledge_grants
		   (id, collection_id, principal_type, principal_id, grant_type, tag_id, can_write, created_at)
		 VALUES (?,?,?,?,?,?,?,?)`,
		["kg-tag-write", "c-1", "user", "u-editor", "tag", "tag-alpha", 1, now],
	);
	// A second canWrite row for the same principal and scope: must collapse.
	db.run(
		`INSERT INTO knowledge_grants
		   (id, collection_id, principal_type, principal_id, grant_type, tag_id, can_write, created_at)
		 VALUES (?,?,?,?,?,?,?,?)`,
		["kg-tag-write-2", "c-1", "user", "u-editor", "tag", "tag-beta", 1, now],
	);
	// Narrator grants: already plain capabilities.
	db.run(
		`INSERT INTO narrator_grants
		   (id, narrator_id, principal_type, principal_id, access, created_at)
		 VALUES (?,?,?,?,?,?)`,
		["ng-read", "n-1", "user", "u-analyst", "read", now],
	);
	db.run(
		`INSERT INTO narrator_grants
		   (id, narrator_id, principal_type, principal_id, access, created_at)
		 VALUES (?,?,?,?,?,?)`,
		["ng-write", "n-1", "user", "u-editor", "write", now],
	);
	return db;
}

describe("knowledge grants → acl_grants", () => {
	test("a clearance holder does NOT gain a read capability", async () => {
		sqlite = await databaseBeforeUnification();

		await runMigrations(sqlite);

		const rows = aclRows(sqlite, "u-analyst");
		const knowledgeRows = rows.filter((r) => r.scope_type !== "narrator");
		// Exactly one row, and it is a credential — not an authorization.
		expect(knowledgeRows).toHaveLength(1);
		expect(knowledgeRows[0].domain_kind).toBe("clearance");
		expect(knowledgeRows[0].domain_value).toBe("internal");
		// No plain capability row (domain_kind IS NULL) was emitted for knowledge.
		expect(knowledgeRows.some((r) => r.domain_kind === null)).toBe(false);
	});

	test("a collection-less grant becomes a global-scoped credential", async () => {
		sqlite = await databaseBeforeUnification();

		await runMigrations(sqlite);

		const row = aclRows(sqlite, "u-analyst").find((r) => r.domain_kind === "clearance");
		expect(row?.scope_type).toBe("global");
		expect(row?.scope_id).toBeNull();
	});

	test("tag credentials keep their collection scope", async () => {
		sqlite = await databaseBeforeUnification();

		await runMigrations(sqlite);

		const tags = aclRows(sqlite, "u-editor").filter((r) => r.domain_kind === "tag");
		expect(tags.map((r) => r.domain_value).sort()).toEqual(["tag-alpha", "tag-beta"]);
		for (const tag of tags) {
			expect(tag.scope_type).toBe("knowledge_collection");
			expect(tag.scope_id).toBe("c-1");
		}
	});

	test("canWrite becomes one write capability, deduplicated across source rows", async () => {
		sqlite = await databaseBeforeUnification();

		await runMigrations(sqlite);

		const writes = aclRows(sqlite, "u-editor").filter(
			(r) => r.capability === "write" && r.domain_kind === null && r.scope_id === "c-1",
		);
		// Two source rows carried can_write=1 for the same principal+scope → one row.
		expect(writes).toHaveLength(1);
	});
});

describe("narrator grants → acl_grants", () => {
	test("read and write map straight across", async () => {
		sqlite = await databaseBeforeUnification();

		await runMigrations(sqlite);

		const analystNarrator = aclRows(sqlite, "u-analyst").filter((r) => r.scope_type === "narrator");
		expect(analystNarrator).toHaveLength(1);
		expect(analystNarrator[0]).toMatchObject({
			scope_id: "n-1",
			capability: "read",
			domain_kind: null,
		});

		const editorNarrator = aclRows(sqlite, "u-editor").filter((r) => r.scope_type === "narrator");
		expect(editorNarrator).toHaveLength(1);
		expect(editorNarrator[0].capability).toBe("write");
	});
});

describe("migration safety", () => {
	test("running the pass again changes nothing", async () => {
		sqlite = await databaseBeforeUnification();
		await runMigrations(sqlite);
		const before = sqlite.prepare("SELECT count(*) AS c FROM acl_grants").get() as { c: number };

		await runMigrations(sqlite);

		const after = sqlite.prepare("SELECT count(*) AS c FROM acl_grants").get() as { c: number };
		expect(after.c).toBe(before.c);
	});

	test("a grant revoked after migration is not resurrected on restart", async () => {
		// The gate is "acl_grants did not exist before this pass", so a later restart
		// must not re-import from the legacy tables — otherwise revoking access would
		// be undone by the next reboot.
		sqlite = await databaseBeforeUnification();
		await runMigrations(sqlite);
		sqlite.run("DELETE FROM acl_grants WHERE scope_type = 'narrator' AND principal_id = ?", [
			"u-analyst",
		]);

		await runMigrations(sqlite);

		const rows = aclRows(sqlite, "u-analyst").filter((r) => r.scope_type === "narrator");
		expect(rows).toHaveLength(0);
	});

	test("the legacy tables are left intact for rollback", async () => {
		sqlite = await databaseBeforeUnification();

		await runMigrations(sqlite);

		const knowledge = sqlite.prepare("SELECT count(*) AS c FROM knowledge_grants").get() as {
			c: number;
		};
		const narrator = sqlite.prepare("SELECT count(*) AS c FROM narrator_grants").get() as {
			c: number;
		};
		expect(knowledge.c).toBe(3);
		expect(narrator.c).toBe(2);
	});
});

describe("project visibility backfill", () => {
	test("existing projects become public with no invented owner", async () => {
		sqlite = await databaseBeforeUnification();

		await runMigrations(sqlite);

		const row = sqlite
			.prepare("SELECT visibility, owner_user_id FROM projects WHERE id = ?")
			.get("p-1") as { visibility: string; owner_user_id: string | null };
		expect(row.visibility).toBe("public");
		expect(row.owner_user_id).toBeNull();
	});

	test("a project made private afterwards stays private across restarts", async () => {
		sqlite = await databaseBeforeUnification();
		await runMigrations(sqlite);
		sqlite.run("UPDATE projects SET visibility = 'private' WHERE id = ?", ["p-1"]);

		await runMigrations(sqlite);

		const row = sqlite.prepare("SELECT visibility FROM projects WHERE id = ?").get("p-1") as {
			visibility: string;
		};
		expect(row.visibility).toBe("private");
	});

	test("collections created before project ACLs do not inherit the project gate", async () => {
		// The column defaults to true for new rows, but existing collections must come
		// out false or a migration would silently hide readable content.
		sqlite = await databaseBeforeUnification();

		await runMigrations(sqlite);

		const row = sqlite
			.prepare("SELECT inherit_project_gate AS g FROM knowledge_collections WHERE id = ?")
			.get("c-1") as { g: number };
		expect(row.g).toBe(0);
	});
});
