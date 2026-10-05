import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as relations from "../db/relations";
import { applyPendingMigrationsByHash } from "../db/run-migrations";
import * as schema from "../db/schema";
import {
	createWorktreeResourceRegistry,
	unknownWorktreeScope,
	worktreeResourceId,
} from "./narrator-worktree-resource-store";

const root = resolve(import.meta.dir, "../..");
const journal = JSON.parse(readFileSync(join(root, "drizzle/meta/_journal.json"), "utf8")) as {
	entries: { idx: number; tag: string }[];
};
const target = journal.entries.find((entry) => entry.idx === 189);
if (!target) throw new Error("Missing generated resource migration");
const migration = readFileSync(join(root, `drizzle/${target.tag}.sql`), "utf8");
const fixtures: Database[] = [];
const registration = {
	ownerNarratorId: "n",
	deviceId: "local",
	repositoryKey: "repo",
	worktreePath: "/fixture/new",
	createRequestId: "request",
};
function fixture(upgraded = true) {
	const sqlite = new Database(":memory:");
	fixtures.push(sqlite);
	const folder = mkdtempSync(join(tmpdir(), "nf-resource-schema-fixture-"));
	try {
		mkdirSync(join(folder, "meta"));
		const entries = journal.entries.filter((entry) => entry.idx < 189);
		writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
		for (const entry of entries)
			writeFileSync(
				join(folder, `${entry.tag}.sql`),
				readFileSync(join(root, `drizzle/${entry.tag}.sql`)),
			);
		applyPendingMigrationsByHash(sqlite, folder);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
	sqlite.exec("PRAGMA foreign_keys=ON");
	sqlite.exec(`INSERT INTO users(id,username,password_hash,created_at) VALUES ('owner','fixture-owner','x','now'),('viewer','fixture-viewer','x','now');
		INSERT INTO projects(id,name,owner_user_id,created_at,updated_at) VALUES ('p','fixture','owner','now','now');
		INSERT INTO chapters(id,project_id,title,branch,base_branch,created_at,updated_at) VALUES ('c','p','fixture','fixture','main','now','now');
		INSERT INTO narrators(id,owner_user_id,created_at,updated_at) VALUES ('n','owner','now','now');`);
	if (upgraded) upgrade(sqlite);
	return { sqlite, database: drizzle({ client: sqlite, schema: { ...schema, ...relations } }) };
}
function upgrade(sqlite: Database) {
	for (const statement of migration.split("--> statement-breakpoint"))
		if (statement.trim()) sqlite.exec(statement);
	sqlite.exec("PRAGMA foreign_keys=ON");
}
afterEach(() => {
	for (const sqlite of fixtures.splice(0)) sqlite.close();
});

describe("resource schema real old-chain upgrade", () => {
	test("0188 populated legacy data is preserved byte-for-byte; old inventory stays unknown", () => {
		const { sqlite } = fixture(false);
		sqlite.exec(`INSERT INTO narrator_worktree_resources(id,owner_narrator_id,device_id,repository_key,worktree_path,state,create_request_id) VALUES ('historic','n','local','repo','/fixture/old','ready','old');
			INSERT INTO container_instances(id,chapter_id,service_name,volume_name,created_at,updated_at) VALUES ('legacy-container','c','web','persistent-volume','now','now');
			INSERT INTO terminals(id,chapter_id,name,created_at) VALUES ('legacy-terminal','c','fixture','now');
			INSERT INTO port_allocations(port,chapter_id,service_name,allocated_at) VALUES (11000,'c','web','now');
			INSERT INTO terminal_view_state(id,user_id,chapter_id,layout,panel_assignments,updated_at) VALUES ('layout','viewer','c','quad','{"slots":["legacy-terminal"],"raw":"保留"}','now');
			INSERT INTO volume_snapshots(id,project_id,name,source_chapter_id,service_name,container_path,created_at,updated_at) VALUES ('snapshot','p','fixture','c','web','/data','now','now');
			INSERT INTO volume_snapshot_applications(id,snapshot_id,chapter_id,applied_at,applied_by) VALUES ('application','snapshot','c','now','viewer');`);
		const tables = [
			"narrator_worktree_resources",
			"container_instances",
			"terminals",
			"port_allocations",
			"terminal_view_state",
			"volume_snapshots",
			"volume_snapshot_applications",
		];
		const before = tables.map((table) => ({
			table,
			row: sqlite.prepare(`SELECT * FROM ${table}`).get() as Record<string, unknown>,
		}));
		upgrade(sqlite);
		for (const { table, row } of before)
			expect(sqlite.prepare(`SELECT * FROM ${table}`).get()).toMatchObject(row);
		expect(
			sqlite
				.query(
					"SELECT scope_kind, scope_project_id, scope_owner_user_id, ownership_revision FROM narrator_worktree_resources",
				)
				.get(),
		).toEqual({
			scope_kind: "unknown",
			scope_project_id: null,
			scope_owner_user_id: null,
			ownership_revision: 0,
		});
		expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
		expect(sqlite.query("SELECT worktree_resource_id FROM container_instances").get()).toEqual({
			worktree_resource_id: null,
		});
	});
	test("new resource records survive narrator/chapter deletion; legacy chapter rows cascade", async () => {
		const { sqlite, database } = fixture();
		const registry = createWorktreeResourceRegistry(database, (_resource, body) => body());
		await registry.register({
			...registration,
			scope: { scopeKind: "project", scopeProjectId: "p", scopeOwnerUserId: "owner" },
		});
		const id = worktreeResourceId("local", registration.worktreePath);
		sqlite.exec(`INSERT INTO terminals(id,worktree_resource_id,name,created_at) VALUES ('resource-terminal','${id}','resource','now');
			INSERT INTO terminal_view_state(id,user_id,worktree_resource_id,updated_at) VALUES ('resource-layout','viewer','${id}','now');
			INSERT INTO container_instances(id,worktree_resource_id,service_name,volume_name,created_at,updated_at) VALUES ('resource-container','${id}','web','retained-volume','now','now');
			INSERT INTO port_allocations(port,worktree_resource_id,allocated_at) VALUES (11001,'${id}','now');
			INSERT INTO volume_snapshots(id,project_id,name,source_worktree_resource_id,service_name,container_path,created_at,updated_at) VALUES ('snapshot','p','fixture','${id}','web','/data','now','now');
			INSERT INTO volume_snapshot_applications(id,snapshot_id,target_worktree_resource_id,applied_at) VALUES ('resource-app','snapshot','${id}','now');
			INSERT INTO terminals(id,chapter_id,name,created_at) VALUES ('legacy-terminal','c','legacy','now');
			INSERT INTO container_instances(id,chapter_id,service_name,created_at,updated_at) VALUES ('legacy-container','c','web','now','now');
			INSERT INTO port_allocations(port,chapter_id,allocated_at) VALUES (11000,'c','now');
			INSERT INTO terminal_view_state(id,user_id,chapter_id,updated_at) VALUES ('legacy-layout','viewer','c','now');
			INSERT INTO volume_snapshot_applications(id,snapshot_id,chapter_id,applied_at) VALUES ('legacy-app','snapshot','c','now');
			DELETE FROM narrators WHERE id='n'; DELETE FROM chapters WHERE id='c';`);
		for (const table of [
			"terminals",
			"container_instances",
			"port_allocations",
			"terminal_view_state",
			"volume_snapshot_applications",
		])
			expect(sqlite.query(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 1 });
		expect(
			sqlite
				.query("SELECT owner_narrator_id, scope_owner_user_id FROM narrator_worktree_resources")
				.get(),
		).toEqual({ owner_narrator_id: null, scope_owner_user_id: "owner" });
		expect(() => sqlite.exec(`DELETE FROM narrator_worktree_resources WHERE id='${id}'`)).toThrow(
			"FOREIGN KEY",
		);
		expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
		// Known exception: project still owns snapshots and cascades their applications.
		sqlite.exec("DELETE FROM projects WHERE id='p'");
		expect(
			sqlite.query("SELECT scope_kind, scope_project_id FROM narrator_worktree_resources").get(),
		).toEqual({ scope_kind: "project", scope_project_id: null });
		expect(sqlite.query("SELECT id FROM volume_snapshots").all()).toEqual([]);
		await expect(registry.compareAndSetScope(id, 0, unknownWorktreeScope)).rejects.toThrow(
			"cannot downgrade",
		);
		sqlite.exec("DELETE FROM users WHERE id='owner'");
		expect(
			sqlite.query("SELECT scope_owner_user_id FROM narrator_worktree_resources").get(),
		).toEqual({ scope_owner_user_id: null });
	});
	test("mixed owners fail, old ownerless terminals/ports remain legal and global port uniqueness persists", async () => {
		const { sqlite, database } = fixture();
		await createWorktreeResourceRegistry(database, (_resource, body) => body()).register(
			registration,
		);
		const id = worktreeResourceId("local", registration.worktreePath);
		for (const statement of [
			`INSERT INTO terminals(id,chapter_id,worktree_resource_id,name,created_at) VALUES ('bad','c','${id}','x','now')`,
			`INSERT INTO terminal_view_state(id,user_id,narrator_id,worktree_resource_id,updated_at) VALUES ('bad','viewer','n','${id}','now')`,
			`INSERT INTO container_instances(id,chapter_id,worktree_resource_id,service_name,created_at,updated_at) VALUES ('bad','c','${id}','web','now','now')`,
			`INSERT INTO container_instances(id,service_name,created_at,updated_at) VALUES ('bad','web','now','now')`,
			`INSERT INTO port_allocations(port,chapter_id,worktree_resource_id,allocated_at) VALUES (11000,'c','${id}','now')`,
		])
			expect(() => sqlite.exec(statement)).toThrow("CHECK");
		sqlite.exec(
			"INSERT INTO terminals(id,name,created_at) VALUES ('ownerless','fixture','now'); INSERT INTO port_allocations(port,allocated_at) VALUES (11000,'now')",
		);
		expect(() =>
			sqlite.exec(
				`INSERT INTO port_allocations(port,worktree_resource_id,allocated_at) VALUES (11000,'${id}','now')`,
			),
		).toThrow("UNIQUE");
		expect(() =>
			sqlite.exec(
				`UPDATE narrator_worktree_resources SET container_config='${"界".repeat(6000)}' WHERE id='${id}'`,
			),
		).toThrow("CHECK");
	});
});

test("all six resource FKs retain RESTRICT and have leading covering indexes", () => {
	const { sqlite } = fixture();
	for (const [table, column] of [
		["terminals", "worktree_resource_id"],
		["terminal_view_state", "worktree_resource_id"],
		["container_instances", "worktree_resource_id"],
		["port_allocations", "worktree_resource_id"],
		["volume_snapshots", "source_worktree_resource_id"],
		["volume_snapshot_applications", "target_worktree_resource_id"],
	]) {
		const fks = sqlite
			.query<{ from: string; on_delete: string }, []>(`PRAGMA foreign_key_list(${table})`)
			.all();
		expect(fks.find((fk) => fk.from === column)?.on_delete).toBe("RESTRICT");
		const indexes = sqlite.query<{ name: string }, []>(`PRAGMA index_list(${table})`).all();
		expect(
			indexes.some(
				(index) =>
					sqlite.query<{ name: string }, []>(`PRAGMA index_info(${index.name})`).all()[0]?.name ===
					column,
			),
		).toBe(true);
	}
});

test("registration pins verified project scope and scope CAS pins both old and new project domains", async () => {
	const { sqlite, database } = fixture();
	sqlite.exec(
		"INSERT INTO projects(id,name,created_at,updated_at) VALUES ('next-project','fixture','now','now')",
	);
	const admitted: Array<string | null | undefined> = [];
	let blocked: string | undefined;
	const registry = createWorktreeResourceRegistry(database, async (identity, body) => {
		admitted.push(identity.scopeProjectId);
		if (identity.scopeProjectId === blocked && blocked) throw new Error("project reserved");
		return body();
	});
	await registry.register({
		...registration,
		scope: { scopeKind: "project", scopeProjectId: "p", scopeOwnerUserId: "owner" },
	});
	expect(admitted).toEqual(["p"]);
	admitted.length = 0;
	blocked = "next-project";
	const id = worktreeResourceId("local", registration.worktreePath);
	await expect(
		registry.compareAndSetScope(id, 0, {
			scopeKind: "project",
			scopeProjectId: "next-project",
			scopeOwnerUserId: "owner",
		}),
	).rejects.toThrow("reserved");
	expect(admitted).toEqual(["p", "next-project"]);
	expect(
		sqlite
			.query("SELECT scope_project_id, ownership_revision FROM narrator_worktree_resources")
			.get(),
	).toEqual({ scope_project_id: "p", ownership_revision: 0 });
	blocked = undefined;
	expect(
		await registry.compareAndSetScope(id, 0, {
			scopeKind: "project",
			scopeProjectId: "next-project",
			scopeOwnerUserId: "owner",
		}),
	).toBe(true);
});

describe("registry stable verified scope", () => {
	test("registration and scope CAS participate in admission; retries cannot adopt old unknown scope", async () => {
		const { sqlite, database } = fixture();
		let admissions = 0;
		let blocked = false;
		const registry = createWorktreeResourceRegistry(database, async (_resource, body) => {
			admissions++;
			if (blocked) throw new Error("reserved");
			return body();
		});
		await registry.register(registration);
		await registry.register({
			...registration,
			scope: { scopeKind: "standalone", scopeProjectId: null, scopeOwnerUserId: "owner" },
		});
		const id = worktreeResourceId("local", registration.worktreePath);
		expect(
			sqlite.query("SELECT scope_kind, scope_owner_user_id FROM narrator_worktree_resources").get(),
		).toEqual({ scope_kind: "unknown", scope_owner_user_id: null });
		blocked = true;
		await expect(
			registry.compareAndSetScope(id, 0, {
				scopeKind: "standalone",
				scopeProjectId: null,
				scopeOwnerUserId: "owner",
			}),
		).rejects.toThrow("reserved");
		blocked = false;
		expect(
			await registry.compareAndSetScope(id, 0, {
				scopeKind: "standalone",
				scopeProjectId: null,
				scopeOwnerUserId: "owner",
			}),
		).toBe(true);
		expect(await registry.compareAndSetScope(id, 0, unknownWorktreeScope)).toBe(false);
		expect(
			sqlite.query("SELECT ownership_revision FROM narrator_worktree_resources").get(),
		).toEqual({ ownership_revision: 1 });
		expect(await registry.compareAndSetScope("missing", 0, unknownWorktreeScope)).toBe(false);
		expect(admissions).toBe(5);
	});
	test("null/missing verified owner and missing project/root evidence are rejected, never filled from actor", async () => {
		const { database } = fixture();
		const registry = createWorktreeResourceRegistry(database, (_resource, body) => body());
		await expect(
			registry.register({
				...registration,
				scope: { scopeKind: "standalone", scopeProjectId: null, scopeOwnerUserId: null },
			}),
		).rejects.toThrow("incomplete");
		await expect(
			registry.register({
				...registration,
				scope: { scopeKind: "project", scopeProjectId: null, scopeOwnerUserId: "owner" },
			}),
		).rejects.toThrow("incomplete");
		await expect(
			registry.register({
				...registration,
				scope: { scopeKind: "standalone", scopeProjectId: null, scopeOwnerUserId: "missing" },
			}),
		).rejects.toThrow("FOREIGN KEY");
		await registry.register(registration);
		await expect(
			registry.register({ ...registration, ownerNarratorId: "other" }),
		).rejects.toThrow();
		await expect(
			registry.compareAndSetScope(
				worktreeResourceId("local", registration.worktreePath),
				-1,
				unknownWorktreeScope,
			),
		).rejects.toThrow("revision");
	});
});
