import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { getTableColumns } from "drizzle-orm";
import { ordinaryDetachFixture } from "../../../tests/fixtures/local-session-detach";
import { applyPendingMigrationsByHash } from "../../db/run-migrations";
import { chapters, narrators } from "../../db/schema";
import type { Cell, FixturePorts, FullRow, NormalizedSnapshot } from "./contract";
import { applyFixtureDetach } from "./executor";
import { IsolatedFixtureDetachStore } from "./store";

const fixtures: Array<{ sql: Database; store: IsolatedFixtureDetachStore }> = [];
afterEach(() => {
	for (const { sql, store } of fixtures.splice(0)) {
		store.close();
		sql.close();
	}
});
/** Current generated DDL on an empty :memory: database, never a user database/migration adapter. */
function currentSchemaFixture() {
	const sql = new Database(":memory:");
	try {
		applyPendingMigrationsByHash(sql, resolve(import.meta.dir, "../../../drizzle"));
		sql.exec("PRAGMA foreign_keys=ON");
		sql.exec(`INSERT INTO users(id,username,password_hash,created_at) VALUES ('fixture:user','fixture-detach-owner','x','now');
			INSERT INTO projects(id,name,owner_user_id,created_at,updated_at) VALUES ('fixture:project','fixture','fixture:user','now','now');
			INSERT INTO chapters(id,project_id,title,branch,base_branch,snapshot_shadow_key,created_at,updated_at)
			VALUES ('fixture:chapter','fixture:project','fixture','fixture','main','fixture:shadow','now','now');`);
		const seed = ordinaryDetachFixture();
		sql
			.query(`INSERT INTO narrators(id,chapter_id,owner_user_id,cwd,workspace_revision,workspace_context,
			message_version,message_structure_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
			.run(
				seed.narrator.id,
				seed.chapter.id,
				seed.acl.ownerUserId,
				seed.identity.path,
				seed.narrator.workspaceRevision,
				seed.narrator.workspaceContext,
				seed.narrator.messageVersion,
				seed.narrator.messageStructureVersion,
				"now",
				"now",
			);
		const rawNarrator = sql
			.query("SELECT * FROM narrators WHERE id=? LIMIT 1")
			.get(seed.narrator.id) as FullRow;
		const rawChapter = sql
			.query("SELECT * FROM chapters WHERE id=? LIMIT 1")
			.get(seed.chapter.id) as FullRow;
		const mapRow = (raw: FullRow, columns: ReturnType<typeof getTableColumns>): FullRow =>
			Object.fromEntries(
				Object.entries(columns).map(([key, column]) => [
					key,
					column.dataType === "boolean" ? Boolean(raw[column.name]) : (raw[column.name] as Cell),
				]),
			);
		seed.narrator = mapRow(
			rawNarrator,
			getTableColumns(narrators),
		) as NormalizedSnapshot["narrator"];
		seed.chapter = {
			...mapRow(rawChapter, getTableColumns(chapters)),
			state: String(rawChapter.status),
		} as NormalizedSnapshot["chapter"];
		seed.schema = "current-generated-sqlite-DDL";
		seed.beforeRows.push(
			{ table: "fixture:narrators", id: seed.narrator.id, row: rawNarrator },
			{ table: "fixture:chapters", id: seed.chapter.id, row: rawChapter },
		);
		const store = new IsolatedFixtureDetachStore(seed);
		fixtures.push({ sql, store });
		return { sql, store, seed, rawNarrator, rawChapter };
	} catch (error) {
		sql.close();
		throw error;
	}
}
function fixturePorts(store: IsolatedFixtureDetachStore, failInstall = false): FixturePorts {
	let owned = false;
	let admission = false;
	return {
		fixtureAuthority: store.fixtureAuthority,
		async reserve() {
			owned = true;
			return {
				fixtureAuthority: store.fixtureAuthority,
				id: "fixture:reservation",
				owned: () => owned,
				release() {
					owned = false;
				},
				retainProtection() {},
			};
		},
		async withAdmission(_scope, body) {
			admission = true;
			try {
				return await body();
			} finally {
				admission = false;
			}
		},
		assertAdmission() {
			if (!admission || !owned) throw new Error("NO_FIXTURE_ADMISSION");
		},
		async installRuntime() {
			if (failInstall) throw new Error("INSTALL_FAULT");
		},
		async verifyRuntime() {},
		async publish() {},
		pause() {},
	};
}

test("current schema full narrator/chapter rows enter isolated executor without losing unknown columns", async () => {
	const { sql, store, seed, rawNarrator, rawChapter } = currentSchemaFixture();
	const token = store.prepare(seed.authority.actorId);
	const result = await applyFixtureDetach({
		store,
		ports: fixturePorts(store),
		token,
		actorId: seed.authority.actorId,
	});
	expect(result.status).toBe("committed");
	const after = store.read();
	const n = after.narrator;
	for (const key of Object.keys(seed.narrator)) {
		if (
			!["chapterId", "contextProjectId", "cwd", "workspaceRevision", "workspaceContext"].includes(
				key,
			)
		) {
			expect(n[key]).toEqual(seed.narrator[key]);
		}
	}
	expect(after.beforeRows).toEqual(seed.beforeRows);
	expect(after.chapter).toEqual(seed.chapter);
	// This is a schema compatibility projection, NOT a production apply or a second transaction adapter.
	sql.transaction(() => {
		sql
			.query(
				"UPDATE narrators SET chapter_id=NULL, context_project_id=?, cwd=?, workspace_revision=?, workspace_context=? WHERE id=?",
			)
			.run(n.contextProjectId, n.cwd, n.workspaceRevision, n.workspaceContext, n.id);
		sql
			.query(`INSERT INTO narrator_worktree_resources(id,owner_narrator_id,device_id,repository_key,worktree_path,
			state,create_request_id,scope_kind,scope_project_id,scope_owner_user_id,ownership_revision,container_config)
			VALUES (?,?,?,?,?,'ready','fixture:request','project',?,?,0,NULL)`)
			.run(
				after.resource.id,
				n.id,
				after.identity.deviceId,
				after.identity.repositoryKey,
				after.identity.path,
				after.chapter.projectId,
				after.acl.ownerUserId,
			);
	})();
	const projected = sql.query("SELECT * FROM narrators WHERE id=? LIMIT 1").get(n.id) as FullRow;
	expect(projected).toEqual({
		...rawNarrator,
		chapter_id: null,
		context_project_id: seed.chapter.projectId,
		cwd: n.cwd,
		workspace_revision: n.workspaceRevision,
		workspace_context: n.workspaceContext,
	});
	expect(sql.query("SELECT * FROM chapters WHERE id=? LIMIT 1").get(seed.chapter.id)).toEqual(
		rawChapter,
	);
	expect(sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("current schema full beforeimage survives compensation, with only monotonic revision/context changing", async () => {
	const { store, seed } = currentSchemaFixture();
	const token = store.prepare(seed.authority.actorId);
	const result = await applyFixtureDetach({
		store,
		ports: fixturePorts(store, true),
		token,
		actorId: seed.authority.actorId,
	});
	expect(result.status).toBe("compensated");
	const restored = store.read();
	expect(restored.narrator.workspaceRevision).toBe(seed.narrator.workspaceRevision + 2);
	expect(restored.narrator.chapterId).toBe(seed.narrator.chapterId);
	expect(restored.narrator.contextProjectId).toBe(seed.narrator.contextProjectId);
	expect(restored.beforeRows).toEqual(seed.beforeRows);
	expect(restored.resource.row).toBeNull();
	for (const key of Object.keys(seed.narrator)) {
		if (!["workspaceRevision", "workspaceContext"].includes(key))
			expect(restored.narrator[key]).toEqual(seed.narrator[key]);
	}
});
