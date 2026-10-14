import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyPendingMigrationsByHash } from "../db/run-migrations";
import {
	legacyLocalWorkspaceContext,
	prepareLegacyRootAdoption,
} from "./legacy-main-checkout-adoption";
import { createLegacyProjectMigrationService } from "./legacy-project-migration-core";
import { treeSnapshotKey } from "./tree-snapshot-paths";

const fixtures: { database: Database; folder: string }[] = [];
const actor = { userId: "owner", isAdmin: false };
afterEach(() => {
	for (const f of fixtures.splice(0)) {
		f.database.close();
		rmSync(f.folder, { recursive: true, force: true });
	}
});
function fixture(retainedReady = false) {
	const folder = mkdtempSync(join(tmpdir(), "nf-root-adoption-integration-"));
	const checkout = join(folder, "repo");
	mkdirSync(checkout);
	execFileSync("git", ["init", "--quiet", "--initial-branch=feature", checkout], {
		timeout: 10000,
		maxBuffer: 32768,
	});
	const dbPath = join(folder, "source.sqlite");
	const database = new Database(dbPath);
	applyPendingMigrationsByHash(database, resolve(import.meta.dir, "../../drizzle"));
	database.exec("PRAGMA foreign_keys=ON");
	fixtures.push({ database, folder });
	database.exec(
		"INSERT INTO users(id,username,password_hash,created_at) VALUES('owner','owner','x','now'); INSERT INTO projects(id,name,owner_user_id,created_at,updated_at) VALUES('p','Project','owner','now','now')",
	);
	database.query("UPDATE projects SET git_path=? WHERE id='p'").run(checkout);
	database
		.query(
			"INSERT INTO chapters(id,project_id,title,branch,base_branch,is_root,role,worktree_path,snapshot_shadow_key,created_at,updated_at) VALUES('c','p','Root','feature','feature',1,'trunk',?,?,'now','now')",
		)
		.run(checkout, treeSnapshotKey("local", checkout));
	database.exec(
		"INSERT INTO narrators(id,chapter_id,owner_user_id,cwd,created_at,updated_at) VALUES('n','c','owner',NULL,'now','now')",
	);
	let reservation = false;
	let reservedCalls = 0;
	let onDisable = () => {};
	let afterInspection = () => {};
	const emitted: unknown[] = [];
	const service = createLegacyProjectMigrationService({
		sqlite: database,
		mainDatabasePath: dbPath,
		retainedHistoryConsumersReady: retainedReady,
		runtimeBusy: () => false,
		withRuntimeAdmission: async (_ids, body) => {
			reservation = true;
			reservedCalls++;
			try {
				return await body();
			} finally {
				reservation = false;
			}
		},
		prepareRootAdoption: async (input) => {
			const result = await prepareLegacyRootAdoption(input);
			afterInspection();
			return result;
		},
		onConverted: (updates) => emitted.push(updates),
		disableSync: async () => {
			expect(reservation).toBe(true);
			onDisable();
			database.exec("UPDATE projects SET legacy_sync_disabled=1 WHERE id='p'");
			return { syncDisabled: true, drained: true };
		},
	});
	return {
		database,
		checkout,
		dbPath,
		service,
		emitted,
		reservedCalls: () => reservedCalls,
		onDisable: (fn: () => void) => {
			onDisable = fn;
		},
		afterInspection: (fn: () => void) => {
			afterInspection = fn;
		},
	};
}

test("retained consumer readiness preserves strict-empty unborn main checkout migration", async () => {
	const f = fixture(true);
	const head = readFileSync(join(f.checkout, ".git", "HEAD"));
	writeFileSync(join(f.checkout, "untracked.bin"), Buffer.from([0, 255, 127]));
	const preview = await f.service.preview("p", actor);
	expect(preview.canMigrate).toBe(true);
	expect(preview.blockers).toEqual([]);
	expect((await f.service.migrate("p", actor, preview.revision)).phase).toBe("completed");
	expect(readFileSync(join(f.checkout, ".git", "HEAD"))).toEqual(head);
	expect(readFileSync(join(f.checkout, "untracked.bin"))).toEqual(Buffer.from([0, 255, 127]));
	expect(
		f.database
			.query("SELECT proof_mode FROM legacy_narrator_workspace_adoptions WHERE narrator_id='n'")
			.get(),
	).toEqual({ proof_mode: "empty" });
	expect(
		f.database.query("SELECT count(*) AS n FROM legacy_retained_history_manifests").get(),
	).toEqual({ n: 0 });
});

test("real Git/worker root migration materializes null cwd/context and preserves user files", async () => {
	const f = fixture();
	mkdirSync(join(f.checkout, ".narrafork", "skills"), { recursive: true });
	writeFileSync(join(f.checkout, ".narrafork", "skills", "keep.txt"), "skill source");
	writeFileSync(join(f.checkout, "dirty.txt"), "user content");
	const preview = await f.service.preview("p", actor);
	expect(preview.blockers).toEqual([]);
	const result = await f.service.migrate("p", actor, preview.revision);
	expect(result.phase).toBe("completed");
	expect(f.reservedCalls()).toBe(1);
	const row = f.database
		.query<
			{
				cwd: string;
				workspace_revision: number;
				workspace_context: string;
				chapter_id: string | null;
			},
			[]
		>("SELECT cwd,workspace_revision,workspace_context,chapter_id FROM narrators WHERE id='n'")
		.get();
	expect(row?.cwd).toBe(f.checkout);
	expect(row?.workspace_revision).toBe(1);
	expect(row?.chapter_id).toBeNull();
	expect(JSON.parse(row?.workspace_context ?? "{}")).toEqual({
		...legacyLocalWorkspaceContext(f.checkout, 0, "p", f.checkout),
		contextProjectId: undefined,
		revision: 1,
	});
	expect(
		f.database
			.query(
				"SELECT adopted_revision,device_id,cwd FROM legacy_narrator_workspace_adoptions WHERE narrator_id='n'",
			)
			.get(),
	).toEqual({ adopted_revision: 1, device_id: "local", cwd: f.checkout });
	expect(readFileSync(join(f.checkout, "dirty.txt"), "utf8")).toBe("user content");
	expect(readFileSync(join(f.checkout, ".narrafork", "skills", "keep.txt"), "utf8")).toBe(
		"skill source",
	);
	expect(existsSync(join(f.checkout, ".git"))).toBe(true);
	expect(f.emitted.length).toBe(1);
});
test("committed local workspace identity keeps its namespace and advances revision in the same transaction", async () => {
	const f = fixture();
	const previous = legacyLocalWorkspaceContext(f.checkout, 2, "p", f.checkout);
	f.database
		.query(
			"UPDATE narrators SET workspace_revision=2,workspace_context=?,default_device_id='local' WHERE id='n'",
		)
		.run(JSON.stringify(previous));
	const preview = await f.service.preview("p", actor);
	expect(preview.canMigrate).toBe(true);
	expect((await f.service.migrate("p", actor, preview.revision)).phase).toBe("completed");
	const row = f.database
		.query<{ workspace_context: string }, []>(
			"SELECT workspace_context FROM narrators WHERE id='n'",
		)
		.get();
	const current = JSON.parse(row?.workspace_context ?? "{}");
	expect(current.contextKey).toBe(previous.contextKey);
	expect(current.git).toEqual(previous.git);
	expect(current.revision).toBe(3);
	expect(current.contextProjectId).toBeUndefined();
});
test("history revisions changing after the final worker result roll back every adoption write", async () => {
	const f = fixture();
	const preview = await f.service.preview("p", actor);
	let inspections = 0;
	f.afterInspection(() => {
		if (++inspections === 2)
			f.database.exec("UPDATE narrators SET message_version=message_version+1 WHERE id='n'");
	});
	await expect(f.service.migrate("p", actor, preview.revision)).rejects.toThrow("changed");
	expect(f.database.query("SELECT chapter_id,cwd FROM narrators WHERE id='n'").get()).toEqual({
		chapter_id: "c",
		cwd: null,
	});
	expect(f.database.query("SELECT 1 FROM legacy_narrator_workspace_adoptions").get()).toBeNull();
	expect(f.database.query("SELECT 1 FROM legacy_project_migrations").get()).toBeNull();
});
test("root metadata changes while draining cannot be silently accepted", async () => {
	const f = fixture();
	const preview = await f.service.preview("p", actor);
	f.onDisable(() => f.database.exec("UPDATE narrators SET workspace_revision=1 WHERE id='n'"));
	await expect(f.service.migrate("p", actor, preview.revision)).rejects.toThrow(
		"changed while draining",
	);
	expect(f.database.query("SELECT chapter_id FROM narrators WHERE id='n'").get()).toEqual({
		chapter_id: "c",
	});
});

test("external connection adding a physical history scope cannot bypass narrator counters", async () => {
	const f = fixture();
	const preview = await f.service.preview("p", actor);
	let inspections = 0;
	f.afterInspection(() => {
		if (++inspections !== 2) return;
		const other = new Database(f.dbPath);
		try {
			other
				.query(
					"INSERT INTO file_change_scopes(id,source_instance_id,device_id,workspace_instance_id,canonical_root,display_root,path_flavor,status,created_at,updated_at) VALUES('late-scope','instance','local','workspace',?,?,'posix','active','now','now')",
				)
				.run(f.checkout, f.checkout);
		} finally {
			other.close();
		}
	});
	await expect(f.service.migrate("p", actor, preview.revision)).rejects.toThrow("history appeared");
	expect(f.database.query("SELECT chapter_id FROM narrators WHERE id='n'").get()).toEqual({
		chapter_id: "c",
	});
	expect(f.database.query("SELECT 1 FROM legacy_narrator_workspace_adoptions").get()).toBeNull();
});
test("unclocked chapter history scalar changed by an external writer is included in metadata CAS", async () => {
	const f = fixture();
	const preview = await f.service.preview("p", actor);
	let inspections = 0;
	f.afterInspection(() => {
		if (++inspections !== 2) return;
		const other = new Database(f.dbPath);
		try {
			other.exec("UPDATE chapters SET commit_count=1 WHERE id='c'");
		} finally {
			other.close();
		}
	});
	await expect(f.service.migrate("p", actor, preview.revision)).rejects.toThrow("changed");
	expect(f.database.query("SELECT chapter_id FROM narrators WHERE id='n'").get()).toEqual({
		chapter_id: "c",
	});
});
