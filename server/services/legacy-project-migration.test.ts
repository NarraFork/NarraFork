import { Database } from "bun:sqlite";
import { afterEach, expect, mock, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyPendingMigrationsByHash } from "../db/run-migrations";
import { createLegacyProjectMigrationService } from "./legacy-project-migration-core";

const root = resolve(import.meta.dir, "../..");
const fixtures: { sqlite: Database; path: string }[] = [];
const actor = { userId: "owner", isAdmin: false };
function backupFixture(path: string) {
	const backup = new Database(path);
	backup.exec(
		"CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES('p'); CREATE TABLE chapters(id TEXT PRIMARY KEY); CREATE TABLE narrators(id TEXT PRIMARY KEY); CREATE TABLE narrator_messages(id TEXT PRIMARY KEY); CREATE TABLE narrator_message_refs(id TEXT PRIMARY KEY); CREATE TABLE narrator_tool_calls(id TEXT PRIMARY KEY)",
	);
	backup.close();
}
function fixture() {
	const sqlite = new Database(":memory:");
	applyPendingMigrationsByHash(sqlite, join(root, "drizzle"));
	sqlite.exec("PRAGMA foreign_keys=ON");
	const path = mkdtempSync(join(tmpdir(), "nf-legacy-migration-test-"));
	fixtures.push({ sqlite, path });
	sqlite.exec(`INSERT INTO users(id,username,password_hash,created_at) VALUES ('owner','owner','x','now');
 INSERT INTO projects(id,name,owner_user_id,created_at,updated_at) VALUES ('p','Project','owner','now','now');
 INSERT INTO chapters(id,project_id,title,branch,base_branch,is_root,created_at,updated_at) VALUES ('c','p','Root','main','main',1,'now','now');`);
	sqlite
		.query(
			"INSERT INTO narrators(id,chapter_id,owner_user_id,cwd,created_at,updated_at) VALUES ('n','c','owner',?,'now','now')",
		)
		.run(path);
	let busy = false;
	let drained = true;
	let onDisable = () => {};
	const service = createLegacyProjectMigrationService({
		sqlite,
		runtimeBusy: () => busy,
		disableSync: async () => {
			onDisable();
			sqlite.exec("UPDATE projects SET legacy_sync_disabled=1 WHERE id='p'");
			return { syncDisabled: true, drained };
		},
	});
	return {
		sqlite,
		path,
		service,
		busy: (value: boolean) => {
			busy = value;
		},
		drained: (value: boolean) => {
			drained = value;
		},
		onDisable: (fn: () => void) => {
			onDisable = fn;
		},
	};
}
afterEach(() => {
	for (const { sqlite, path } of fixtures.splice(0)) {
		sqlite.close();
		rmSync(path, { recursive: true, force: true });
	}
});
test("production schema: root ordinary session converts in place and receipt survives; repeat authorization", async () => {
	const { sqlite, service } = fixture();
	const preview = await service.preview("p", actor);
	expect(preview.blockers).toEqual([]);
	const result = await service.migrate("p", actor, preview.revision);
	expect(result.phase).toBe("completed");
	expect(result.narratorIds).toEqual(["n"]);
	expect(service.chapterTargetCandidate("c")).toEqual({
		projectId: "p",
		chapterId: "c",
		narratorIds: ["n"],
		actorUserId: "owner",
		phase: "completed",
	});
	expect(sqlite.query("SELECT chapter_id,context_project_id,id FROM narrators").get()).toEqual({
		id: "n",
		chapter_id: null,
		context_project_id: null,
	});
	expect(sqlite.query("SELECT id FROM projects").get()).toBeNull();
	expect((await service.migrate("p", actor, preview.revision)).phase).toBe("completed");
	await expect(service.preview("p", { userId: "intruder", isAdmin: false })).rejects.toThrow();
});
test("busy cached runtime or queued state blocks without drain or conversion", async () => {
	const f = fixture();
	f.busy(true);
	const preview = await f.service.preview("p", actor);
	expect(preview.blockers.some((b) => b.code === "NARRATOR_BUSY")).toBe(true);
	expect((await f.service.migrate("p", actor, preview.revision)).phase).toBe("blocked");
	expect(f.sqlite.query("SELECT legacy_sync_disabled FROM projects").get()).toEqual({
		legacy_sync_disabled: 0,
	});
});
test("drain timeout preserves project and session, permanently disables backup", async () => {
	const f = fixture();
	f.drained(false);
	const p = await f.service.preview("p", actor);
	expect((await f.service.migrate("p", actor, p.revision)).phase).toBe("blocked");
	expect(f.sqlite.query("SELECT chapter_id FROM narrators").get()).toEqual({ chapter_id: "c" });
	expect(f.sqlite.query("SELECT legacy_sync_disabled FROM projects").get()).toEqual({
		legacy_sync_disabled: 1,
	});
});
test("CAS rejects mutation during drain rather than silently accepting new session metadata", async () => {
	const f = fixture();
	const p = await f.service.preview("p", actor);
	f.onDisable(() => f.sqlite.exec("UPDATE narrators SET workspace_revision=workspace_revision+1"));
	await expect(f.service.migrate("p", actor, p.revision)).rejects.toThrow("changed while draining");
	expect(f.sqlite.query("SELECT chapter_id FROM narrators").get()).toEqual({ chapter_id: "c" });
});
test("resources, public ACL and project settings are explicit blockers", async () => {
	const f = fixture();
	f.sqlite.exec(
		`UPDATE projects SET traits='["readOnly"]'; UPDATE chapters SET snapshot_shadow_key='retained-history'; UPDATE narrators SET visibility='project';`,
	);
	const p = await f.service.preview("p", actor);
	expect(p.blockers.map((b) => b.code)).toContain("PROJECT_CONFIGURATION");
	expect(p.blockers.map((b) => b.code)).toContain("CHAPTER_RESOURCE");
	expect(p.blockers.map((b) => b.code)).toContain("NARRATOR_ACL");
});
test("generic FK detects knowledge content; project delete never cascades", async () => {
	const f = fixture();
	f.sqlite.exec(
		"CREATE TABLE future_dependency(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id) ON DELETE CASCADE); CREATE INDEX future_dependency_project ON future_dependency(project_id); INSERT INTO future_dependency VALUES('content','p')",
	);
	const p = await f.service.preview("p", actor);
	expect(p.blockers.some((b) => b.message.includes("future_dependency"))).toBe(true);
	expect((await f.service.migrate("p", actor, p.revision)).phase).toBe("blocked");
	expect(f.sqlite.query("SELECT id FROM future_dependency").get()).toEqual({ id: "content" });
});
test("private ACL grants are not revived after unbinding", async () => {
	const f = fixture();
	f.sqlite.exec(
		"INSERT INTO acl_grants(id,scope_type,scope_id,principal_type,principal_id,capability,created_at) VALUES ('grant','narrator','n','user','owner','read','now')",
	);
	const p = await f.service.preview("p", actor);
	expect(p.blockers.some((b) => b.message.includes("acl_grants"))).toBe(true);
});
test("backup cleanup removes only validated db files and preserves repository", async () => {
	const f = fixture();
	mkdirSync(join(f.path, ".narrafork"));
	backupFixture(join(f.path, ".narrafork/project.db"));
	writeFileSync(join(f.path, "keep"), "user content");
	f.sqlite.query("UPDATE projects SET git_path=?").run(f.path);
	const p = await f.service.preview("p", actor);
	expect(p.blockers).toEqual([]);
	expect((await f.service.migrate("p", actor, p.revision)).phase).toBe("completed");
	expect(existsSync(join(f.path, "keep"))).toBe(true);
	expect(existsSync(join(f.path, ".narrafork"))).toBe(true);
	expect(existsSync(join(f.path, ".narrafork/project.db"))).toBe(false);
	expect(f.sqlite.query("SELECT archive_path FROM legacy_project_migrations").get()).toEqual({
		archive_path: f.path,
	});
});
test("primary, variant, child, lazy fork and context-only IDs/history remain intact", async () => {
	const f = fixture();
	for (const [id, type, chapter] of [
		["variant", "primary", "c"],
		["child", "subagent", "c"],
		["context", "primary", null],
	] as const) {
		f.sqlite
			.query(
				"INSERT INTO narrators(id,chapter_id,context_project_id,type,parent_narrator_id,acl_root_narrator_id,refs_inherited_from,owner_user_id,cwd,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'now','now')",
			)
			.run(
				id,
				chapter,
				chapter ? null : "p",
				type,
				"n",
				type === "subagent" ? "n" : null,
				"n",
				"owner",
				f.path,
			);
	}
	f.sqlite.exec(
		`INSERT INTO narrator_messages(id,narrator_id,role,content_json,created_at) VALUES ('m','n','assistant','[{"type":"text","text":"history"}]','now'); INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq,is_compact) VALUES('ref','n','m',42,1);`,
	);
	const before = f.sqlite.query("SELECT * FROM narrator_messages").all();
	const refs = f.sqlite.query("SELECT * FROM narrator_message_refs").all();
	const p = await f.service.preview("p", actor);
	expect(p.blockers).toEqual([]);
	expect((await f.service.migrate("p", actor, p.revision)).narratorIds.sort()).toEqual([
		"child",
		"context",
		"n",
		"variant",
	]);
	expect(f.sqlite.query("SELECT * FROM narrator_messages").all()).toEqual(before);
	expect(f.sqlite.query("SELECT * FROM narrator_message_refs").all()).toEqual(refs);
	expect(
		f.sqlite
			.query(
				"SELECT parent_narrator_id,acl_root_narrator_id,refs_inherited_from FROM narrators WHERE id='child'",
			)
			.get(),
	).toEqual({ parent_narrator_id: "n", acl_root_narrator_id: "n", refs_inherited_from: "n" });
});
test("cleanup receipt rejects replaced backup inode, persists shell and retries after restoration", async () => {
	const f = fixture();
	const backup = join(f.path, ".narrafork/project.db");
	mkdirSync(join(f.path, ".narrafork"));
	backupFixture(backup);
	f.sqlite.query("UPDATE projects SET git_path=?").run(f.path);
	let disables = 0;
	f.onDisable(() => {
		if (++disables === 2) {
			renameSync(backup, join(f.path, "saved-backup"));
			writeFileSync(backup, "replacement must survive");
		}
	});
	const p = await f.service.preview("p", actor);
	const result = await f.service.migrate("p", actor, p.revision);
	expect(result.phase).toBe("cleanup_pending");
	expect(readFileSync(backup, "utf8")).toBe("replacement must survive");
	expect(f.sqlite.query("SELECT id FROM projects").get()).toEqual({ id: "p" });
	expect(f.sqlite.query("SELECT chapter_id FROM narrators").get()).toEqual({ chapter_id: null });
	renameSync(backup, join(f.path, "user-replacement"));
	renameSync(join(f.path, "saved-backup"), backup);
	expect((await f.service.migrate("p", actor, p.revision)).phase).toBe("completed");
	expect(readFileSync(join(f.path, "user-replacement"), "utf8")).toBe("replacement must survive");
});
test("symlinked backup is blocked before conversion", async () => {
	const f = fixture();
	mkdirSync(join(f.path, ".narrafork"));
	writeFileSync(join(f.path, "user-db"), "user database");
	symlinkSync(join(f.path, "user-db"), join(f.path, ".narrafork/project.db"));
	f.sqlite.query("UPDATE projects SET git_path=?").run(f.path);
	const p = await f.service.preview("p", actor);
	expect(p.blockers.some((b) => b.code === "FILESYSTEM_RESOURCE")).toBe(true);
	expect((await f.service.migrate("p", actor, p.revision)).phase).toBe("blocked");
	expect(readFileSync(join(f.path, "user-db"), "utf8")).toBe("user database");
});
test("review inherited policy and unbound busy descendants block", async () => {
	const f = fixture();
	f.sqlite.exec("UPDATE chapters SET role='review'");
	expect(
		(await f.service.preview("p", actor)).blockers.some((b) => b.code === "REVIEW_POLICY"),
	).toBe(true);
	f.sqlite.exec("UPDATE chapters SET role='branch'");
	f.sqlite
		.query(
			"INSERT INTO narrators(id,type,parent_narrator_id,acl_root_narrator_id,owner_user_id,cwd,status,created_at,updated_at) VALUES ('unbound-child','subagent','n','n','owner',?,'working','now','now')",
		)
		.run(f.path);
	const p = await f.service.preview("p", actor);
	expect(p.narratorCount).toBe(2);
	expect(
		p.blockers.some((b) => b.code === "NARRATOR_BUSY" && b.message.includes("unbound-child")),
	).toBe(true);
});
test("another project using same canonical root prevents backup cleanup", async () => {
	const f = fixture();
	f.sqlite.query("UPDATE projects SET git_path=?").run(f.path);
	f.sqlite
		.query(
			"INSERT INTO projects(id,name,git_path,owner_user_id,created_at,updated_at) VALUES ('alias','Other',?,'owner','now','now')",
		)
		.run(f.path);
	const p = await f.service.preview("p", actor);
	expect(
		p.blockers.some((b) => b.code === "FILESYSTEM_RESOURCE" && b.message.includes("shares")),
	).toBe(true);
	expect((await f.service.migrate("p", actor, p.revision)).phase).toBe("blocked");
});
test("metadata cardinality budget blocks instead of silently truncating migration", async () => {
	const f = fixture();
	const insert = f.sqlite.query(
		"INSERT INTO narrators(id,chapter_id,owner_user_id,cwd,created_at,updated_at) VALUES (?,'c','owner',?,'now','now')",
	);
	f.sqlite.transaction(() => {
		for (let i = 0; i < 200; i++) insert.run(`session-${i}`, f.path);
	})();
	const p = await f.service.preview("p", actor);
	expect(p.canMigrate).toBe(false);
	expect(p.blockers.some((b) => b.code === "LIMIT_EXCEEDED")).toBe(true);
	expect((await f.service.migrate("p", actor, p.revision)).phase).toBe("blocked");
	expect(f.sqlite.query("SELECT chapter_id FROM narrators WHERE id='n'").get()).toEqual({
		chapter_id: "c",
	});
});
test("plaintext project.db is not granted deletion authority by its filename", async () => {
	const f = fixture();
	mkdirSync(join(f.path, ".narrafork"));
	const backup = join(f.path, ".narrafork/project.db");
	writeFileSync(backup, "user-owned unrelated data");
	f.sqlite.query("UPDATE projects SET git_path=?").run(f.path);
	const p = await f.service.preview("p", actor);
	expect(p.blockers.some((b) => b.message.includes("recognizable backup"))).toBe(true);
	expect((await f.service.migrate("p", actor, p.revision)).phase).toBe("blocked");
	expect(readFileSync(backup, "utf8")).toBe("user-owned unrelated data");
});
test("concurrent confirmed requests share one conversion and one cleanup writer", async () => {
	const f = fixture();
	mkdirSync(join(f.path, ".narrafork"));
	backupFixture(join(f.path, ".narrafork/project.db"));
	f.sqlite.query("UPDATE projects SET git_path=?").run(f.path);
	let drains = 0;
	f.onDisable(() => {
		drains++;
	});
	const p = await f.service.preview("p", actor);
	const a = f.service.migrate("p", actor, p.revision);
	const b = f.service.migrate("p", actor, p.revision);
	expect(a).toBe(b);
	const results = await Promise.all([a, b]);
	expect(results.map((r) => r.phase)).toEqual(["completed", "completed"]);
	expect(drains).toBe(2);
	expect(f.sqlite.query("SELECT project_id FROM legacy_project_migrations").all()).toEqual([
		{ project_id: "p" },
	]);
});
test("replacement between receipt validation and final stat never gains unlink authority", async () => {
	const f = fixture();
	mkdirSync(join(f.path, ".narrafork"));
	const backup = join(f.path, ".narrafork/project.db");
	backupFixture(backup);
	f.sqlite.query("UPDATE projects SET git_path=?").run(f.path);
	const p = await f.service.preview("p", actor);
	const originalPromises = { ...fsPromises };
	const originalLstat = fsPromises.lstat;
	let cleanupActive = false;
	let drains = 0;
	let backupStats = 0;
	let injected = false;
	f.onDisable(() => {
		if (++drains === 2) cleanupActive = true;
	});
	mock.module("node:fs/promises", () => ({
		...originalPromises,
		lstat: async (...args: Parameters<typeof originalLstat>) => {
			if (cleanupActive && String(args[0]) === backup && ++backupStats === 2) {
				renameSync(backup, join(f.path, "receipt-authorized-backup"));
				backupFixture(backup);
				injected = true;
			}
			return originalLstat(...args);
		},
	}));
	try {
		const result = await f.service.migrate("p", actor, p.revision);
		expect(injected).toBe(true);
		expect(result.phase).toBe("cleanup_pending");
		expect(existsSync(backup)).toBe(true);
		const replacement = new Database(backup, { readonly: true, create: false });
		try {
			expect(replacement.query("SELECT id FROM projects").get()).toEqual({ id: "p" });
		} finally {
			replacement.close();
		}
		expect(existsSync(join(f.path, "receipt-authorized-backup"))).toBe(true);
		expect(f.sqlite.query("SELECT id FROM projects").get()).toEqual({ id: "p" });
		expect(f.sqlite.query("SELECT phase FROM legacy_project_migrations").get()).toEqual({
			phase: "cleanup_pending",
		});
	} finally {
		mock.module("node:fs/promises", () => originalPromises);
	}
});
