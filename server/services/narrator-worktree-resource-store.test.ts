import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as relations from "../db/relations";
import { applyPendingMigrationsByHash } from "../db/run-migrations";
import * as schema from "../db/schema";
import { LocalBackend } from "../lib/agent/execution/local-backend";
import { safeSpawn } from "../lib/spawn";
import { closeFileWorkerDatabase, openFileWorkerDatabase } from "./__tests__/file-worker-database";
// Rejections settle natively before matching: Bun's `.rejects` stalls on a reused read Worker.
import { captureWorkerRejectionThrower } from "./__tests__/narrator-worker-fixture";
import { FileWorktreeJournal, worktreeReceiptHasResourceEffect } from "./narrator-worktree-journal";
import {
	createWorktreeResourceRegistry,
	unknownWorktreeScope,
	worktreeResourceId,
} from "./narrator-worktree-resource-store";
import {
	NarratorWorktreeService,
	type WorktreeServicePorts,
	type WorktreeTarget,
} from "./narrator-worktree-service";

const root = resolve(import.meta.dir, "../..");
const journal = JSON.parse(readFileSync(join(root, "drizzle/meta/_journal.json"), "utf8")) as {
	entries: { idx: number; tag: string }[];
};
const target = journal.entries.find((entry) => entry.tag === "0191_worktree_resource_ownership");
if (!target) throw new Error("Missing generated resource migration");
const targetIndex = target.idx;
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
	const sqlite = openFileWorkerDatabase();
	fixtures.push(sqlite);
	const folder = mkdtempSync(join(tmpdir(), "nf-resource-schema-fixture-"));
	try {
		mkdirSync(join(folder, "meta"));
		const entries = journal.entries.filter((entry) => entry.idx < targetIndex);
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
afterEach(async () => {
	for (const sqlite of fixtures.splice(0)) await closeFileWorkerDatabase(sqlite);
});

describe("resource schema real old-chain upgrade", () => {
	test("0190 populated legacy data is preserved byte-for-byte; old inventory stays unknown", () => {
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
		expect(
			await captureWorkerRejectionThrower(registry.compareAndSetScope(id, 0, unknownWorktreeScope)),
		).toThrow("cannot downgrade");
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
	expect(
		await captureWorkerRejectionThrower(
			registry.compareAndSetScope(id, 0, {
				scopeKind: "project",
				scopeProjectId: "next-project",
				scopeOwnerUserId: "owner",
			}),
		),
	).toThrow("reserved");
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

describe("undispatched registration release", () => {
	test("matching fresh preparing metadata is removed without deleting any disk content", async () => {
		const { sqlite, database } = fixture();
		const registry = createWorktreeResourceRegistry(database, (_resource, body) => body());
		const directory = mkdtempSync(join(tmpdir(), "nf-undispatched-resource-"));
		const marker = join(directory, "keep.txt");
		writeFileSync(marker, "not created by Git; preserve me");
		try {
			const resource = { ...registration, worktreePath: directory };
			expect(await registry.register(resource)).toEqual({ inserted: true });
			expect(sqlite.query("SELECT state FROM narrator_worktree_resources").get()).toEqual({
				state: "preparing",
			});
			await registry.releaseUndispatched(resource);
			expect(sqlite.query("SELECT id FROM narrator_worktree_resources").all()).toEqual([]);
			expect(readFileSync(marker, "utf8")).toBe("not created by Git; preserve me");
			await registry.releaseUndispatched(resource);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("register reports inserted only for this INSERT, never for compatible existing resources", async () => {
		const { sqlite, database } = fixture();
		const registry = createWorktreeResourceRegistry(database, (_resource, body) => body());
		for (const state of ["preparing", "ready", "unknown"] as const) {
			const resource = { ...registration, worktreePath: `/fixture/${state}` };
			expect(await registry.register(resource)).toEqual({ inserted: true });
			if (state !== "preparing") await registry.setState(resource, state);
			const before = sqlite.query("SELECT * FROM narrator_worktree_resources ORDER BY id").all();
			expect(await registry.register(resource)).toEqual({ inserted: false });
			expect(sqlite.query("SELECT * FROM narrator_worktree_resources ORDER BY id").all()).toEqual(
				before,
			);
		}
	});

	for (const historicalState of ["preparing", "unknown"] as const) {
		for (const failure of ["cancelled", "dispatch-save"] as const) {
			test(`real create after receipt loss retains historical ${historicalState} registration on ${failure}`, async () => {
				const { sqlite, database } = fixture();
				const registry = createWorktreeResourceRegistry(database, (_resource, body) => body());
				const directory = mkdtempSync(join(tmpdir(), "nf-reused-resource-"));
				try {
					const source = join(directory, "repo");
					mkdirSync(source);
					async function git(args: string[]) {
						const result = await safeSpawn({
							cmd: ["git", "-C", source, ...args],
							timeout: 5000,
							maxOutputBytes: 128 * 1024,
						});
						if (result.exitCode !== 0) throw new Error(result.stderr);
						return result;
					}
					await git(["init", "-b", "main"]);
					writeFileSync(join(source, "tracked.txt"), "original content\n");
					await git(["add", "tracked.txt"]);
					await git([
						"-c",
						"user.name=Fixture",
						"-c",
						"user.email=fixture@example.test",
						"commit",
						"-m",
						"initial",
					]);
					mkdirSync(join(source, ".worktrees"));
					const request = {
						requestId: registration.createRequestId,
						expectedRevision: 0,
						workspaceKey: "workspace",
						destinationPath: join(source, ".worktrees", "destination"),
						branch: { kind: "new" as const, name: "feature" },
					};
					const target: WorktreeTarget = {
						workspace: {
							deviceId: "local",
							cwd: source,
							rootPath: source,
							workspaceKey: "workspace",
							repositoryKey: registration.repositoryKey,
							state: "ready",
							capabilities: { read: true, write: true },
						},
						backend: new LocalBackend(),
						repositoryPath: join(source, ".git"),
					};
					const receiptDirectory = join(directory, "receipts");
					const journal = new FileWorktreeJournal(receiptDirectory);
					const controller = new AbortController();
					const marker = join(request.destinationPath, "keep.bin");
					const content = Buffer.from([0, 255, 42, 13, 10]);
					let recovering = false;
					let priorDispatched = false;
					let writes = 0;
					let releases = 0;
					const ports: WorktreeServicePorts<string> = {
						authorize: async () => target,
						withRevision: async (_id, _revision, body) => body(),
						withRepositoryLock: async (_key, body) => body(),
						journal,
						resources: {
							register: async (resource) => {
								const result = await registry.register(resource);
								if (recovering) {
									expect(result).toEqual({ inserted: false });
									// Independent files appearing after the final destination check must survive.
									mkdirSync(request.destinationPath);
									writeFileSync(marker, content);
									if (failure === "cancelled") controller.abort();
								}
								return result;
							},
							setState: async (resource, state) => {
								if (!recovering && historicalState === "preparing")
									throw new Error("Prior dispatch lost its final registry update");
								return registry.setState(resource, state);
							},
							releaseUndispatched: async (resource) => {
								releases++;
								return registry.releaseUndispatched(resource);
							},
						},
						runGit: async (_target, args, signal, writing) => {
							if (writing) {
								writes++;
								priorDispatched = true;
								throw new Error("Prior Git dispatch outcome lost");
							}
							if (!recovering && priorDispatched) throw new Error("Prior outcome unverifiable");
							return safeSpawn({
								cmd: ["git", "--no-optional-locks", "-C", source, ...args],
								timeout: 5000,
								maxOutputBytes: 128 * 1024,
								signal,
							});
						},
					};
					const service = new NarratorWorktreeService(ports);
					expect((await service.create("actor", "n", request, controller.signal)).outcome).toBe(
						"unknown",
					);
					expect(writes).toBe(1);
					const before = sqlite.query("SELECT * FROM narrator_worktree_resources").get();
					expect(before).toMatchObject({ state: historicalState, ownership_revision: 0 });
					expect(worktreeReceiptHasResourceEffect(await journal.read("n", request.requestId))).toBe(
						true,
					);
					rmSync(receiptDirectory, { recursive: true, force: true });
					expect(await journal.read("n", request.requestId)).toBeNull();
					recovering = true;
					writes = 0;
					const save = journal.save.bind(journal);
					journal.save = async (...args) => {
						if (failure === "dispatch-save" && args[2].dispatchState === "started")
							throw new Error("New dispatch marker write failed");
						return save(...args);
					};
					const failed = await service.create("actor", "n", request, controller.signal);
					expect(failed.outcome).toBe("failed");
					expect(writes).toBe(0);
					expect(releases).toBe(0);
					expect(sqlite.query("SELECT * FROM narrator_worktree_resources").get()).toEqual(before);
					expect(readFileSync(marker)).toEqual(content);
					const receipt = await journal.read("n", request.requestId);
					expect(receipt?.dispatchState).toBe("not_started");
					expect(worktreeReceiptHasResourceEffect(receipt)).toBe(false);
					expect(await service.create("actor", "n", request, new AbortController().signal)).toEqual(
						failed,
					);
					expect(writes).toBe(0);
					expect(releases).toBe(0);
				} finally {
					rmSync(directory, { recursive: true, force: true });
				}
			});
		}
	}

	test("another owner/request/repository/device/path cannot release preparing metadata", async () => {
		const { sqlite, database } = fixture();
		const registry = createWorktreeResourceRegistry(database, (_resource, body) => body());
		await registry.register(registration);
		const before = sqlite.query("SELECT * FROM narrator_worktree_resources").get();
		for (const resource of [
			{ ...registration, ownerNarratorId: "another-owner" },
			{ ...registration, createRequestId: "another-request" },
			{ ...registration, repositoryKey: "another-repository" },
			{ ...registration, deviceId: "another-device" },
			{ ...registration, worktreePath: "/fixture/another-path" },
		]) {
			await registry.releaseUndispatched(resource);
			expect(sqlite.query("SELECT * FROM narrator_worktree_resources").get()).toEqual(before);
		}
	});

	test("ready/unknown results and transferred ownership revisions cannot be released", async () => {
		const { sqlite, database } = fixture();
		const registry = createWorktreeResourceRegistry(database, (_resource, body) => body());
		for (const state of ["ready", "unknown"] as const) {
			const resource = { ...registration, worktreePath: `/fixture/${state}` };
			await registry.register(resource);
			await registry.setState(resource, state);
			await registry.releaseUndispatched(resource);
		}
		await registry.register(registration);
		expect(
			await registry.compareAndSetScope(
				worktreeResourceId(registration.deviceId, registration.worktreePath),
				0,
				{ scopeKind: "project", scopeProjectId: "p", scopeOwnerUserId: "owner" },
			),
		).toBe(true);
		await registry.releaseUndispatched(registration);
		expect(
			sqlite
				.query("SELECT state, ownership_revision FROM narrator_worktree_resources ORDER BY state")
				.all(),
		).toEqual([
			{ state: "preparing", ownership_revision: 1 },
			{ state: "ready", ownership_revision: 0 },
			{ state: "unknown", ownership_revision: 0 },
		]);
	});
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
		expect(
			await captureWorkerRejectionThrower(
				registry.compareAndSetScope(id, 0, {
					scopeKind: "standalone",
					scopeProjectId: null,
					scopeOwnerUserId: "owner",
				}),
			),
		).toThrow("reserved");
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
		expect(
			await captureWorkerRejectionThrower(
				registry.register({
					...registration,
					scope: { scopeKind: "standalone", scopeProjectId: null, scopeOwnerUserId: null },
				}),
			),
		).toThrow("incomplete");
		expect(
			await captureWorkerRejectionThrower(
				registry.register({
					...registration,
					scope: { scopeKind: "project", scopeProjectId: null, scopeOwnerUserId: "owner" },
				}),
			),
		).toThrow("incomplete");
		expect(
			await captureWorkerRejectionThrower(
				registry.register({
					...registration,
					scope: { scopeKind: "standalone", scopeProjectId: null, scopeOwnerUserId: "missing" },
				}),
			),
		).toThrow("FOREIGN KEY");
		await registry.register(registration);
		expect(
			await captureWorkerRejectionThrower(
				registry.register({ ...registration, ownerNarratorId: "other" }),
			),
		).toThrow();
		expect(
			await captureWorkerRejectionThrower(
				registry.compareAndSetScope(
					worktreeResourceId("local", registration.worktreePath),
					-1,
					unknownWorktreeScope,
				),
			),
		).toThrow("revision");
	});
});
