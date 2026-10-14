import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyPendingMigrationsByHash } from "../db/run-migrations";
import { prepareLegacyRootAdoption } from "./legacy-main-checkout-adoption";
import { createLegacyProjectMigrationService } from "./legacy-project-migration-core";

const actor = { userId: "owner", isAdmin: false };
const fixtures: Array<{ folder: string; database: Database }> = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0)) {
		fixture.database.close();
		rmSync(fixture.folder, { recursive: true, force: true });
	}
});
function git(root: string, ...args: string[]) {
	const result = spawnSync("git", ["--no-optional-locks", "-C", root, ...args], {
		encoding: "utf8",
		timeout: 5000,
		maxBuffer: 65536,
		env: {
			...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
			GIT_AUTHOR_NAME: "fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.test",
			GIT_COMMITTER_NAME: "fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.test",
		},
	});
	if (result.status !== 0 || result.error) throw new Error(result.stderr || String(result.error));
	return result.stdout.trim();
}
function fixture(
	linkedReady = false,
	omitAdmission = false,
	linkedStatus: "active" | "dormant" = "dormant",
) {
	const folder = mkdtempSync(join(tmpdir(), "nf-linked-migration-"));
	const root = join(folder, "main");
	const linked = join(folder, "linked");
	mkdirSync(root);
	git(root, "init", "-b", "main-fixture");
	writeFileSync(join(root, "tracked"), "original\n");
	writeFileSync(join(root, ".gitignore"), "ignored\n");
	git(root, "add", "tracked", ".gitignore");
	git(root, "commit", "-m", "fixture");
	// Setup only: the migration itself may not execute any worktree mutation.
	git(root, "worktree", "add", "-b", "exact-linked-branch", linked);
	writeFileSync(join(linked, "tracked"), "staged\n");
	git(linked, "add", "tracked");
	writeFileSync(join(linked, "tracked"), "dirty\n");
	writeFileSync(join(linked, "untracked"), "untracked\n");
	writeFileSync(join(linked, "ignored"), Buffer.from([0, 255, 1, 127]));
	const databasePath = join(folder, "isolated.sqlite");
	const database = new Database(databasePath);
	fixtures.push({ folder, database });
	applyPendingMigrationsByHash(database, resolve("drizzle"));
	database.exec("PRAGMA foreign_keys=ON");
	database.exec(
		"INSERT INTO users(id,username,password_hash,created_at) VALUES('owner','owner','x','now')",
	);
	database
		.query(
			"INSERT INTO projects(id,name,owner_user_id,git_path,created_at,updated_at) VALUES('p','Project','owner',?,'now','now')",
		)
		.run(root);
	for (const [id, path, branch, isRoot] of [
		["root-chapter", root, "main-fixture", 1],
		["linked-chapter", linked, "exact-linked-branch", 0],
	] as const) {
		database
			.query(
				"INSERT INTO chapters(id,project_id,title,branch,base_branch,is_root,status,worktree_path,created_at,updated_at) VALUES(?,'p',?,?,'main-fixture',?,?,?,'now','now')",
			)
			.run(id, id, branch, isRoot, isRoot ? "active" : linkedStatus, path);
		database
			.query(
				"INSERT INTO narrators(id,chapter_id,context_project_id,owner_user_id,cwd,created_at,updated_at) VALUES(?,?,'p','owner',?,'now','now')",
			)
			.run(`${id}-narrator`, id, path);
	}
	let drains = 0;
	let inspections = 0;
	let afterInspection: (count: number) => void = () => {};
	const service = createLegacyProjectMigrationService({
		sqlite: database,
		mainDatabasePath: databasePath,
		retainedHistoryConsumersReady: true,
		linkedWorktreeConsumersReady: linkedReady,
		runtimeBusy: () => false,
		prepareRootAdoption: async (input) => {
			const adoption = await prepareLegacyRootAdoption(
				omitAdmission ? { ...input, assertLinkedAdmissionReady: undefined } : input,
			);
			afterInspection(++inspections);
			return adoption;
		},
		withRuntimeAdmission: async (_ids, body) => body(),
		disableSync: async () => {
			drains++;
			database.exec("UPDATE projects SET legacy_sync_disabled=1 WHERE id='p'");
			return { syncDisabled: true, drained: true };
		},
	});
	const admin = git(linked, "rev-parse", "--absolute-git-dir");
	const snapshot = () => ({
		branch: git(linked, "symbolic-ref", "HEAD"),
		head: git(linked, "rev-parse", "HEAD"),
		gitfile: readFileSync(join(linked, ".git")),
		index: readFileSync(join(admin, "index")),
		adminHead: readFileSync(join(admin, "HEAD")),
		commondir: readFileSync(join(admin, "commondir")),
		backpointer: readFileSync(join(admin, "gitdir")),
		tracked: readFileSync(join(linked, "tracked")),
		untracked: readFileSync(join(linked, "untracked")),
		ignored: readFileSync(join(linked, "ignored")),
	});
	return {
		database,
		databasePath,
		root,
		linked,
		service,
		snapshot,
		drains: () => drains,
		afterInspection: (callback: (count: number) => void) => {
			afterInspection = callback;
			inspections = 0;
		},
	};
}

test("verified linked workspace adopts same-transaction resource, exact origin and every member claim without Git writes", async () => {
	const f = fixture(true);
	f.database
		.query(
			"INSERT INTO narrators(id,chapter_id,context_project_id,owner_user_id,cwd,workspace_revision,created_at,updated_at) VALUES('linked-peer','linked-chapter','p','owner',?,9,'now','now')",
		)
		.run(f.linked);
	const before = f.snapshot();
	const preview = await f.service.preview("p", actor);
	expect(preview.blockers).toEqual([]);
	expect(preview.canMigrate).toBe(true);
	const result = await f.service.migrate("p", actor, preview.revision);
	expect(result.phase).toBe("completed");
	expect(f.snapshot()).toEqual(before);
	expect(f.database.query("SELECT count(*) AS n FROM chapters").get()).toEqual({ n: 0 });
	const resources = f.database
		.query<
			{
				id: string;
				owner_narrator_id: string | null;
				scope_kind: string;
				scope_owner_user_id: string | null;
				worktree_path: string;
				state: string;
			},
			[]
		>(
			"SELECT id,owner_narrator_id,scope_kind,scope_owner_user_id,worktree_path,state FROM narrator_worktree_resources",
		)
		.all();
	expect(resources).toHaveLength(1);
	expect(resources[0]).toMatchObject({
		owner_narrator_id: null,
		scope_kind: "standalone",
		scope_owner_user_id: "owner",
		worktree_path: f.linked,
		state: "ready",
	});
	expect(
		f.database
			.query(
				"SELECT resource_id,source_chapter_id,narrator_id,owner_user_id,state,ownership_revision FROM narrator_worktree_resource_claims ORDER BY narrator_id",
			)
			.all(),
	).toEqual([
		{
			resource_id: resources[0].id,
			source_chapter_id: "linked-chapter",
			narrator_id: "linked-chapter-narrator",
			owner_user_id: "owner",
			state: "claimed",
			ownership_revision: 0,
		},
		{
			resource_id: resources[0].id,
			source_chapter_id: "linked-chapter",
			narrator_id: "linked-peer",
			owner_user_id: "owner",
			state: "claimed",
			ownership_revision: 0,
		},
	]);
	expect(
		f.database.query("SELECT workspace_revision FROM narrators WHERE id='linked-peer'").get(),
	).toEqual({ workspace_revision: 10 });
	const origin = f.database.query("SELECT * FROM narrator_worktree_resource_origins").get() as {
		resource_id: string;
		evidence_json: string;
		evidence_digest: string;
		common_directory_path: string;
		git_admin_directory_path: string;
	};
	expect(origin.resource_id).toBe(resources[0].id);
	expect(origin.common_directory_path).toBe(join(f.root, ".git"));
	expect(JSON.parse(origin.evidence_json).digest).toBe(origin.evidence_digest);
	expect(Buffer.byteLength(origin.evidence_json)).toBeLessThanOrEqual(16384);
	const adoption = f.database
		.query(
			"SELECT origin_json FROM legacy_narrator_workspace_adoptions WHERE narrator_id='linked-chapter-narrator'",
		)
		.get() as { origin_json: string };
	expect(JSON.parse(adoption.origin_json).linkedWorktree).toEqual({
		resourceId: resources[0].id,
		ownershipRevision: 0,
		evidenceDigest: origin.evidence_digest,
		commonDirectoryPath: origin.common_directory_path,
		gitAdminDirectoryPath: origin.git_admin_directory_path,
	});
	const repeat = await f.service.migrate("p", actor, preview.revision);
	expect(repeat.phase).toBe("completed");
	expect(
		f.database.query("SELECT count(*) AS n FROM narrator_worktree_resource_claims").get(),
	).toEqual({ n: 2 });
	f.database.exec("DELETE FROM narrators; DELETE FROM users WHERE id='owner'");
	expect(
		f.database.query("SELECT count(*) AS n FROM narrator_worktree_resource_origins").get(),
	).toEqual({ n: 1 });
	expect(f.database.query("SELECT count(*) AS n FROM narrator_worktree_resources").get()).toEqual({
		n: 1,
	});
	expect(f.snapshot()).toEqual(before);
});

test("an active allocated linked source with archived private idle actor migrates only under its independent gate", async () => {
	const f = fixture(true, false, "active");
	f.database.exec("UPDATE narrators SET status='archived' WHERE chapter_id='linked-chapter'");
	const before = f.snapshot();
	const preview = await f.service.preview("p", actor);
	expect(preview.blockers).toEqual([]);
	expect((await f.service.migrate("p", actor, preview.revision)).phase).toBe("completed");
	expect(f.snapshot()).toEqual(before);
});

for (const target of ["gitfile", "admin", "common", "HEAD", "branch"] as const) {
	test(`fresh proof then in-SQLite-tx ${target} mutation rolls back resources, claims, receipt and context`, async () => {
		const f = fixture(true);
		const before = f.snapshot();
		const preview = await f.service.preview("p", actor);
		expect(preview.blockers).toEqual([]);
		const admin = git(f.linked, "rev-parse", "--absolute-git-dir");
		let restore = () => {};
		let injected = false;
		const originalQuery = f.database.query.bind(f.database);
		f.database.query = ((sql: string) => {
			const statement = originalQuery(sql);
			if (sql.startsWith("UPDATE narrators SET chapter_id=NULL,context_project_id=NULL,cwd=")) {
				const run = statement.run.bind(statement);
				statement.run = (...bindings) => {
					const result = run(...bindings);
					if (!injected) {
						injected = true;
						if (target === "HEAD" || target === "branch") {
							const path =
								target === "HEAD"
									? join(admin, "HEAD")
									: join(f.root, ".git", "refs", "heads", "exact-linked-branch");
							const bytes = readFileSync(path);
							restore = () => writeFileSync(path, bytes);
							writeFileSync(
								path,
								target === "HEAD"
									? "ref: refs/heads/not-the-declared-branch\n"
									: `${"b".repeat(40)}\n`,
							);
						} else {
							const path =
								target === "gitfile"
									? join(f.linked, ".git")
									: target === "admin"
										? admin
										: join(f.root, ".git");
							const saved = `${path}.fault-original`;
							renameSync(path, saved);
							restore = () => {
								rmSync(path, { recursive: true, force: true });
								renameSync(saved, path);
							};
							cpSync(saved, path, { recursive: true });
						}
					}
					return result;
				};
			}
			return statement;
		}) as typeof f.database.query;
		try {
			await expect(f.service.migrate("p", actor, preview.revision)).rejects.toThrow("changed");
			expect(injected).toBe(true);
		} finally {
			f.database.query = originalQuery;
			restore();
		}
		for (const table of [
			"narrator_worktree_resources",
			"narrator_worktree_resource_claims",
			"narrator_worktree_resource_origins",
			"legacy_project_migrations",
			"legacy_retained_history_manifests",
			"legacy_narrator_workspace_adoptions",
		])
			expect(f.database.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
		expect(f.database.query("SELECT count(*) AS n FROM chapters").get()).toEqual({ n: 2 });
		expect(
			f.database
				.query(
					"SELECT count(*) AS n FROM narrators WHERE chapter_id IS NOT NULL AND context_project_id='p' AND workspace_revision=0",
				)
				.get(),
		).toEqual({ n: 2 });
		expect(f.snapshot()).toEqual(before);
	});
}

for (const table of ["file_change_scopes", "worktree_tree_snapshots"] as const) {
	test(`another connection inserting a linked ${table} PK after final worker proof is stale, never omitted`, async () => {
		const f = fixture(true);
		const before = f.snapshot();
		const head = git(f.linked, "rev-parse", "HEAD");
		const tree = git(f.linked, "rev-parse", "HEAD^{tree}");
		const identity = lstatSync(f.linked, { bigint: true });
		const preview = await f.service.preview("p", actor);
		expect(preview.blockers).toEqual([]);
		let inserted = false;
		f.afterInspection((count) => {
			if (count !== 2) return;
			const beforeChanges = f.database.query("SELECT total_changes() AS n").get();
			const external = new Database(f.databasePath, { create: false, readwrite: true });
			try {
				if (table === "file_change_scopes") {
					external
						.query(
							"INSERT INTO file_change_scopes(id,source_instance_id,device_id,workspace_instance_id,canonical_root,display_root,path_flavor,status,root_identity_json,revision,created_at,updated_at) VALUES('late-linked-scope','external-instance','local','external-workspace',?,?,'posix','active',?,1,'now','now')",
						)
						.run(
							f.linked,
							f.linked,
							JSON.stringify({ object: `${identity.dev}:${identity.ino}:${identity.birthtimeNs}` }),
						);
				} else {
					external
						.query(
							"INSERT INTO worktree_tree_snapshots(id,device_id,worktree_path,tree_hash,snapshot_commit_sha,created_at) VALUES('late-linked-snapshot','local',?,?,?,'now')",
						)
						.run(f.linked, tree, head);
				}
				inserted = true;
			} finally {
				external.close();
			}
			// This deliberately bypasses the application's main-connection mutation counter.
			expect(f.database.query("SELECT total_changes() AS n").get()).toEqual(beforeChanges);
		});
		await expect(f.service.migrate("p", actor, preview.revision)).rejects.toThrow("changed");
		expect(inserted).toBe(true);
		expect(f.database.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 1 });
		for (const rollbackTable of [
			"narrator_worktree_resources",
			"narrator_worktree_resource_claims",
			"narrator_worktree_resource_origins",
			"legacy_project_migrations",
			"legacy_retained_history_manifests",
			"legacy_narrator_workspace_adoptions",
		])
			expect(f.database.query(`SELECT count(*) AS n FROM ${rollbackTable}`).get()).toEqual({
				n: 0,
			});
		expect(f.database.query("SELECT count(*) AS n FROM chapters").get()).toEqual({ n: 2 });
		expect(
			f.database
				.query(
					"SELECT count(*) AS n FROM narrators WHERE chapter_id IS NOT NULL AND context_project_id='p' AND workspace_revision=0",
				)
				.get(),
		).toEqual({ n: 2 });
		expect(f.snapshot()).toEqual(before);
	});
}

function addScopes(f: ReturnType<typeof fixture>, count: number, idLength: number) {
	const identity = lstatSync(f.linked, { bigint: true });
	const rootIdentity = JSON.stringify({
		object: `${identity.dev}:${identity.ino}:${identity.birthtimeNs}`,
	});
	f.database.transaction(() => {
		for (let index = 0; index < count; index++) {
			f.database
				.query(
					"INSERT INTO file_change_scopes(id,source_instance_id,device_id,workspace_instance_id,canonical_root,display_root,path_flavor,status,root_identity_json,revision,created_at,updated_at) VALUES (?,'instance','local',?, ?,?,'posix','active',?,1,'now','now')",
				)
				.run(
					`scope-${String(index).padStart(4, "0")}-${"x".repeat(idLength - 11)}`,
					`workspace-${index}`,
					f.linked,
					f.linked,
					rootIdentity,
				);
		}
	})();
}

test("origin metadata over 64KiB is blocked before conversion without truncating scopes or source context", async () => {
	const f = fixture(true);
	addScopes(f, 150, 512);
	const before = f.snapshot();
	const preview = await f.service.preview("p", actor);
	expect(preview.canMigrate).toBe(false);
	expect(preview.blockers.some((blocker) => blocker.code === "ADOPTION_BUDGET")).toBe(true);
	expect((await f.service.migrate("p", actor, preview.revision)).phase).toBe("blocked");
	expect(f.drains()).toBe(0);
	expect(f.database.query("SELECT count(*) AS n FROM file_change_scopes").get()).toEqual({
		n: 150,
	});
	expect(f.database.query("SELECT count(*) AS n FROM chapters").get()).toEqual({ n: 2 });
	expect(f.database.query("SELECT count(*) AS n FROM narrator_worktree_resources").get()).toEqual({
		n: 0,
	});
	expect(f.snapshot()).toEqual(before);
});

for (const count of [128, 129, 150]) {
	test(`healthy retained ${count}-scope inventory is preserved under shared row and byte budgets`, async () => {
		const f = fixture(true);
		addScopes(f, count, 24);
		const before = f.snapshot();
		const preview = await f.service.preview("p", actor);
		expect(preview.blockers).toEqual([]);
		expect((await f.service.migrate("p", actor, preview.revision)).phase).toBe("completed");
		const row = f.database
			.query(
				"SELECT origin_json FROM legacy_narrator_workspace_adoptions WHERE narrator_id='linked-chapter-narrator'",
			)
			.get() as { origin_json: string };
		expect(JSON.parse(row.origin_json).scopeIds).toHaveLength(count);
		expect(Buffer.byteLength(row.origin_json)).toBeLessThanOrEqual(65536);
		expect(f.database.query("SELECT count(*) AS n FROM file_change_scopes").get()).toEqual({
			n: count,
		});
		expect(f.snapshot()).toEqual(before);
	});
}

test("an unknown registry owner cannot be silently adopted or overwritten", async () => {
	const f = fixture(true);
	const before = f.snapshot();
	f.database
		.query(
			"INSERT INTO narrator_worktree_resources (id,owner_narrator_id,device_id,repository_key,worktree_path,state,create_request_id) VALUES ('foreign-resource',NULL,'local','unknown',?,'unknown','foreign-request')",
		)
		.run(f.linked);
	const preview = await f.service.preview("p", actor);
	expect(preview.canMigrate).toBe(false);
	expect(preview.blockers.some((blocker) => blocker.code === "MIGRATION_RESOURCE_CONFLICT")).toBe(
		true,
	);
	expect((await f.service.migrate("p", actor, preview.revision)).phase).toBe("blocked");
	expect(
		f.database.query("SELECT id,state,repository_key FROM narrator_worktree_resources").all(),
	).toEqual([{ id: "foreign-resource", state: "unknown", repository_key: "unknown" }]);
	expect(f.snapshot()).toEqual(before);
});

test("linked source overrides, sharing, remote execution and inherited ACLs remain explicitly blocked", async () => {
	const f = fixture(true);
	const before = f.snapshot();
	for (const sql of [
		"UPDATE narrators SET cwd=(SELECT git_path FROM projects WHERE id='p') WHERE chapter_id='linked-chapter'",
		"UPDATE narrators SET visibility='public' WHERE chapter_id='linked-chapter'",
		"UPDATE narrators SET default_device_id='remote-device' WHERE chapter_id='linked-chapter'",
		"UPDATE narrators SET parent_narrator_id='root-chapter-narrator' WHERE chapter_id='linked-chapter'",
		"UPDATE narrators SET chapter_id=NULL WHERE id='linked-chapter-narrator'",
		"UPDATE narrators SET status='running' WHERE chapter_id='linked-chapter'",
	]) {
		f.database.exec("SAVEPOINT rejected_configuration");
		try {
			f.database.exec(sql);
			const preview = await f.service.preview("p", actor);
			expect(preview.canMigrate).toBe(false);
			expect(
				preview.blockers.some(
					(blocker) => blocker.code === "ADOPTION_IDENTITY" || blocker.code === "NARRATOR_BUSY",
				),
			).toBe(true);
			expect(f.snapshot()).toEqual(before);
		} finally {
			f.database.exec("ROLLBACK TO rejected_configuration; RELEASE rejected_configuration");
		}
	}
	expect(f.drains()).toBe(0);
});

test("linked enabled without trusted live history admission still blocks without mutations", async () => {
	const f = fixture(true, true);
	const before = f.snapshot();
	const preview = await f.service.preview("p", actor);
	expect(preview.canMigrate).toBe(false);
	expect(preview.blockers.some((blocker) => blocker.code === "ADOPTION_HISTORY")).toBe(true);
	const result = await f.service.migrate("p", actor, preview.revision);
	expect(result.phase).toBe("blocked");
	expect(f.drains()).toBe(0);
	expect(f.database.query("SELECT count(*) AS n FROM chapters").get()).toEqual({ n: 2 });
	expect(f.snapshot()).toEqual(before);
});

test("linked adoption has an independent default-off gate and never changes Git or user bytes", async () => {
	const f = fixture();
	const before = f.snapshot();
	const preview = await f.service.preview("p", actor);
	expect(preview.canMigrate).toBe(false);
	expect(preview.blockers.some((blocker) => blocker.code === "LINKED_WORKTREE_NOT_READY")).toBe(
		true,
	);
	const result = await f.service.migrate("p", actor, preview.revision);
	expect(result.phase).toBe("blocked");
	expect(f.drains()).toBe(0);
	expect(f.database.query("SELECT count(*) AS n FROM chapters").get()).toEqual({ n: 2 });
	expect(
		f.database.query("SELECT count(*) AS n FROM narrator_worktree_resource_origins").get(),
	).toEqual({ n: 0 });
	expect(f.snapshot()).toEqual(before);
});
