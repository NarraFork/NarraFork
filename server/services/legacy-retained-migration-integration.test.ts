import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { applyPendingMigrationsByHash } from "../db/run-migrations";
import { getNarraforkPath } from "../lib/narrafork-home";
import { FileChangeBlobStore } from "./file-change-blob-store";
import { prepareLegacyRootAdoption } from "./legacy-main-checkout-adoption";
import { createLegacyProjectMigrationService } from "./legacy-project-migration-core";
import { treeSnapshotKey, treeSnapshotPhysicalDir } from "./tree-snapshot-paths";
import { createLifecycleGuard } from "./worktree-lifecycle-guard";

const actor = { userId: "owner", isAdmin: false };
const fixtures: Array<{ folder: string; shadow: string; database: Database }> = [];
let template: string;
function git(path: string, args: string[], input?: string) {
	const value = spawnSync("git", ["-C", path, ...args], {
		input,
		encoding: "utf8",
		timeout: 5000,
		maxBuffer: 128 * 1024,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "test",
			GIT_AUTHOR_EMAIL: "test@test",
			GIT_COMMITTER_NAME: "test",
			GIT_COMMITTER_EMAIL: "test@test",
		},
	});
	if (value.status !== 0 || value.error) throw new Error(value.stderr || String(value.error));
	return value.stdout.trim();
}
beforeAll(() => {
	template = mkdtempSync(join(tmpdir(), "nf-retained-migration-schema-"));
	const database = new Database(join(template, "template.db"));
	applyPendingMigrationsByHash(database, resolve("drizzle"));
	database.close();
});
afterAll(() => rmSync(template, { recursive: true, force: true }));
afterEach(() => {
	for (const f of fixtures.splice(0)) {
		f.database.close();
		rmSync(f.shadow, { recursive: true, force: true });
		rmSync(f.folder, { recursive: true, force: true });
	}
});
function fixture(retained = true) {
	const folder = mkdtempSync(join(tmpdir(), "nf-retained-migration-"));
	const checkout = join(folder, "repo");
	mkdirSync(checkout);
	git(checkout, ["init", "-b", "feature"]);
	writeFileSync(join(checkout, "file.txt"), "real original\n");
	git(checkout, ["add", "file.txt"]);
	git(checkout, ["commit", "-m", "user commit"]);
	const commit = git(checkout, ["rev-parse", "HEAD"]);
	const shadow = treeSnapshotPhysicalDir("local", checkout);
	mkdirSync(shadow, { recursive: true });
	git(shadow, ["init", "--bare"]);
	const blob = git(shadow, ["hash-object", "-w", "--stdin"], "historical shadow bytes\n");
	const tree = git(shadow, ["mktree"], `100644 blob ${blob}\tfile.txt\n`);
	const snapshot = git(shadow, ["commit-tree", tree], "snapshot\n");
	git(shadow, ["update-ref", "refs/heads/workspace", snapshot]);
	const databasePath = join(folder, "history.db");
	copyFileSync(join(template, "template.db"), databasePath);
	const database = new Database(databasePath);
	database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL");
	fixtures.push({ folder, database, shadow });
	database.exec(
		"INSERT INTO users(id,username,password_hash,created_at) VALUES('owner','owner','x','now')",
	);
	database
		.query(
			"INSERT INTO projects(id,name,owner_user_id,git_path,created_at,updated_at) VALUES('p','Project','owner',?,'now','now')",
		)
		.run(checkout);
	database
		.query(
			"INSERT INTO chapters(id,project_id,title,description,branch,base_branch,is_root,worktree_path,head_commit_sha,start_commit_sha,commit_count,snapshot_commit_sha,snapshot_shadow_key,created_at,updated_at) VALUES('c','p','Original chapter','Unmodified metadata','feature','feature',1,?,?,?,1,?,?,'now','now')",
		)
		.run(checkout, commit, commit, snapshot, treeSnapshotKey("local", checkout));
	database
		.query(
			"INSERT INTO narrators(id,chapter_id,context_project_id,cwd,owner_user_id,workspace_revision,created_at,updated_at) VALUES('n','c','p',?,'owner',7,'now','now')",
		)
		.run(checkout);
	database
		.query(
			"INSERT INTO narrator_messages(id,narrator_id,role,content_json,commit_sha,tree_hash_after,snapshot_commit_sha,created_at) VALUES('m','n','user',?,?,?,?, 'now')",
		)
		.run('[{"type":"text","text":"original text\\nexact bytes"}]', commit, tree, snapshot);
	database.exec(
		"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES('r','n','m',0)",
	);
	database
		.query(
			"INSERT INTO narrator_file_snapshots(id,narrator_id,device_id,file_path,original_content,created_at) VALUES('f','n','local',?,'original file bytes','now')",
		)
		.run(join(checkout, "file.txt"));
	database
		.query(
			"INSERT INTO narrator_tool_calls(id,narrator_id,message_id,tool_use_id,tool_name,status,execution_device_id,execution_cwd,tree_hash_before,tree_hash_after,input_json,output_json,created_at) VALUES('t','n','m','use','Edit','success','local',?,?,?,?,?,'now')",
		)
		.run(checkout, tree, tree, '{"exact":"input"}', '{"exact":"output"}');
	database
		.query(
			"INSERT INTO chapter_commits(id,chapter_id,sha,message,author_name,authored_at,created_at) VALUES('cc','c',?,'Original indexed commit','Author','now','now')",
		)
		.run(commit);
	database
		.query(
			"INSERT INTO worktree_tree_snapshots(id,device_id,worktree_path,tree_hash,snapshot_commit_sha,created_at) VALUES('index','local',?,?,?,'now')",
		)
		.run(checkout, tree, snapshot);
	let inspections = 0;
	let onInspect: (number: number) => void | Promise<void> = () => {};
	let onDrain = () => {};
	let reservations = 0;
	const service = createLegacyProjectMigrationService({
		sqlite: database,
		mainDatabasePath: databasePath,
		retainedHistoryConsumersReady: retained,
		runtimeBusy: () => false,
		withRuntimeAdmission: async (_ids, body) => {
			reservations++;
			return body();
		},
		prepareRootAdoption: async (input) => {
			const result = await prepareLegacyRootAdoption(input);
			await onInspect(++inspections);
			return result;
		},
		disableSync: async () => {
			onDrain();
			database.exec("UPDATE projects SET legacy_sync_disabled=1 WHERE id='p'");
			return { syncDisabled: true, drained: true };
		},
	});
	return {
		database,
		databasePath,
		checkout,
		shadow,
		commit,
		tree,
		snapshot,
		service,
		onInspect: (fn: typeof onInspect) => {
			onInspect = fn;
			inspections = 0;
		},
		onDrain: (fn: typeof onDrain) => {
			onDrain = fn;
		},
		reservations: () => reservations,
	};
}
async function journal(f: ReturnType<typeof fixture>, projectId = "p") {
	const blobs = new FileChangeBlobStore({
		root: join(dirname(f.databasePath), "immutable-blobs"),
		minimumFreeBytes: 0,
	});
	const beforeBytes = readFileSync(join(f.checkout, "file.txt"));
	const afterBytes = Buffer.from("actual journal after bytes\n");
	const before = await blobs.putBytes(beforeBytes, { expectedSize: beforeBytes.length });
	const after = await blobs.putBytes(afterBytes, { expectedSize: afterBytes.length });
	for (const [id, ref] of [
		["blob-before", before],
		["blob-after", after],
	] as const)
		f.database
			.query(
				"INSERT INTO file_change_blobs(id,digest,size_bytes,storage_key,status,created_at,updated_at) VALUES (?,?,?,?,'ready','now','now')",
			)
			.run(id, ref.digest, ref.sizeBytes, `sha256/${ref.digest.slice(0, 2)}/${ref.digest}`);
	const root = lstatSync(f.checkout, { bigint: true });
	f.database
		.query(
			"INSERT INTO file_change_scopes(id,source_instance_id,device_id,workspace_instance_id,canonical_root,display_root,path_flavor,status,root_identity_json,revision,created_at,updated_at) VALUES('journal-scope','instance','local','workspace',?,?,'posix','active',?,1,'now','now')",
		)
		.run(
			f.checkout,
			f.checkout,
			JSON.stringify({ object: `${root.dev}:${root.ino}:${root.birthtimeNs}` }),
		);
	const actorJson = JSON.stringify({
		kind: "primary",
		subjectKey: "primary:n",
		narratorId: "n",
		userId: "owner",
		label: "Original actor",
		deleted: false,
		parentSubjectKey: null,
	});
	const bindingJson = JSON.stringify({
		deviceId: "local",
		runtimeEpoch: "old-epoch",
		runtimeGeneration: 1,
		fencingToken: 0,
	});
	const digest = createHash("sha256").update(afterBytes).digest("hex");
	f.database
		.query(
			"INSERT INTO file_change_operations(id,journal_seq,evidence_version,source_instance_id,source_kind,source_id,attempt,request_digest,expected_effect_count,prepared_effect_count,settled_effect_count,unresolved_effect_count,tool_call_id,tool_use_id,narrator_id,project_id,owner_user_id,actor_subject_key,actor_json,execution_binding_json,execution_outcome,effect_outcome,settlement,attribution_grade,coverage,started_at,finished_at,updated_at) VALUES('journal-op',1,2,'instance','tool','t',1,?,1,1,1,0,'t','use','n',?,'owner','primary:n',?,?,'succeeded','changed','settled','measured','complete','now','now','now')",
		)
		.run(digest, projectId, actorJson, bindingJson);
	const identity = JSON.stringify({
		sourceInstanceId: "instance",
		deviceId: "local",
		workspaceInstanceId: "workspace",
		scopeId: "journal-scope",
		pathFlavor: "posix",
		objectRole: "entry",
		canonicalPath: join(f.checkout, "file.txt"),
		lexicalPath: join(f.checkout, "file.txt"),
		displayPath: join(f.checkout, "file.txt"),
	});
	const beforeState = JSON.stringify({ kind: "regular", blob: before, mode: 0o644 });
	const afterState = JSON.stringify({ kind: "regular", blob: after, mode: 0o644 });
	f.database
		.query(
			"INSERT INTO file_change_effects(id,operation_id,journal_seq,scope_id,file_key,identity_json,scope_revision,mutation_id,request_digest,phase,before_state_json,intended_after_state_json,observed_after_state_json,before_blob_digest,intended_after_blob_digest,observed_after_blob_digest,outcome,settlement,attribution_grade,execution_confirmed,created_at,updated_at) VALUES('journal-effect','journal-op',1,'journal-scope','file',?,1,'mutation',?,'apply',?,?,?,?,?,?,'changed','settled','measured',1,'now','now')",
		)
		.run(
			identity,
			digest,
			beforeState,
			afterState,
			afterState,
			before.digest,
			after.digest,
			after.digest,
		);
	f.database.exec(
		"UPDATE narrator_tool_calls SET file_change_operation_id='journal-op' WHERE id='t'",
	);
	writeFileSync(join(f.checkout, "file.txt"), afterBytes);
	return { blobs, before, after, beforeBytes, afterBytes, actorJson, bindingJson };
}
const bytes = (database: Database) =>
	createHash("sha256")
		.update(
			JSON.stringify([
				database.query("SELECT * FROM narrator_messages ORDER BY id").all(),
				database.query("SELECT * FROM narrator_message_refs ORDER BY id").all(),
				database.query("SELECT * FROM narrator_tool_calls ORDER BY id").all(),
				database.query("SELECT * FROM narrator_file_snapshots ORDER BY id").all(),
				database.query("SELECT * FROM worktree_tree_snapshots ORDER BY id").all(),
			]),
		)
		.digest("hex");
function noReceipt(database: Database) {
	expect(
		database.query("SELECT id,chapter_id,workspace_revision FROM narrators WHERE id='n'").get(),
	).toEqual({ id: "n", chapter_id: "c", workspace_revision: 7 });
	for (const table of [
		"legacy_project_migrations",
		"legacy_retained_chapter_metadata",
		"legacy_retained_history_manifests",
		"legacy_migration_artifact_claims",
		"legacy_narrator_workspace_adoptions",
	])
		expect(database.query(`SELECT 1 FROM ${table}`).get()).toBeNull();
	expect(database.query("SELECT 1 FROM chapter_commits WHERE id='cc'").get()).not.toBeNull();
}

test("retained root preserves real commit index archive, all historical bytes and real shadow namespace", async () => {
	const f = fixture();
	const before = bytes(f.database);
	const index = readFileSync(join(f.checkout, ".git", "index"));
	const head = readFileSync(join(f.checkout, ".git", "HEAD"));
	const file = readFileSync(join(f.checkout, "file.txt"));
	const preview = await f.service.preview("p", actor);
	expect(preview.blockers).toEqual([]);
	expect((await f.service.migrate("p", actor, preview.revision)).phase).toBe("completed");
	expect(f.reservations()).toBe(1);
	expect(bytes(f.database)).toBe(before);
	expect(readFileSync(join(f.checkout, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(f.checkout, ".git", "HEAD"))).toEqual(head);
	expect(readFileSync(join(f.checkout, "file.txt"))).toEqual(file);
	expect(git(f.shadow, ["show", `${f.snapshot}:file.txt`])).toBe("historical shadow bytes");
	const metadata = f.database
		.query<{ metadata_json: string }, []>(
			"SELECT metadata_json FROM legacy_retained_chapter_metadata WHERE source_chapter_id='c'",
		)
		.get();
	const archive = JSON.parse(metadata?.metadata_json ?? "{}");
	expect(archive.description).toBe("Unmodified metadata");
	expect(archive).not.toHaveProperty("manifest");
	const complete = f.database
		.query<{ manifest_json: string }, []>(
			"SELECT manifest_json FROM legacy_retained_history_manifests WHERE migration_project_id='p'",
		)
		.get();
	const manifest = JSON.parse(complete?.manifest_json ?? "{}");
	expect(manifest.references.chapter_commits[0].sha).toBe(f.commit);
	expect(manifest.assets[0].identity.entries.length).toBeGreaterThan(1);
	const locator = f.database
		.query<{ identity_json: string }, []>(
			"SELECT identity_json FROM legacy_migration_artifact_claims LIMIT 1",
		)
		.get();
	expect(Buffer.byteLength(locator?.identity_json ?? "")).toBeLessThan(8192);
	expect(JSON.parse(locator?.identity_json ?? "{}")).not.toHaveProperty("entries");
	expect(f.database.query("SELECT 1 FROM chapters").get()).toBeNull();
	expect(f.database.query("SELECT 1 FROM chapter_commits").get()).toBeNull();
	expect(
		f.database
			.query(
				"SELECT chapter_id,context_project_id,cwd,workspace_revision FROM narrators WHERE id='n'",
			)
			.get(),
	).toEqual({ chapter_id: null, context_project_id: null, cwd: f.checkout, workspace_revision: 8 });
	const proof = f.database
		.query<{ proof_mode: string; origin_json: string }, []>(
			"SELECT proof_mode,origin_json FROM legacy_narrator_workspace_adoptions WHERE narrator_id='n'",
		)
		.get();
	expect(proof?.proof_mode).toBe("retained");
	expect(JSON.parse(proof?.origin_json ?? "{}").shadowKey).toBe(
		treeSnapshotKey("local", f.checkout),
	);
	expect(
		f.database
			.query("SELECT narrator_id,kind,shadow_key,state FROM legacy_migration_artifact_claims")
			.all(),
	).toEqual([
		{
			narrator_id: "n",
			kind: "shadow",
			shadow_key: treeSnapshotKey("local", f.checkout),
			state: "claimed",
		},
	]);
});
test("complete source-owned project journal detaches only project FK and preserves actor, binding, scope, effects and real blob bytes", async () => {
	const f = fixture();
	const j = await journal(f);
	const originalOp = f.database
		.query<Record<string, string | number | null>, []>(
			"SELECT * FROM file_change_operations WHERE id='journal-op'",
		)
		.get();
	const original = bytes(f.database);
	const evidence = JSON.stringify([
		f.database.query("SELECT * FROM file_change_scopes").all(),
		f.database.query("SELECT * FROM file_change_effects").all(),
		f.database.query("SELECT * FROM file_change_blobs").all(),
	]);
	const preview = await f.service.preview("p", actor);
	expect(preview.blockers).toEqual([]);
	expect((await f.service.migrate("p", actor, preview.revision)).phase).toBe("completed");
	expect(
		f.database.query("SELECT * FROM file_change_operations WHERE id='journal-op'").get(),
	).toEqual({ ...originalOp, project_id: null });
	expect(bytes(f.database)).toBe(original);
	expect(
		JSON.stringify([
			f.database.query("SELECT * FROM file_change_scopes").all(),
			f.database.query("SELECT * FROM file_change_effects").all(),
			f.database.query("SELECT * FROM file_change_blobs").all(),
		]),
	).toBe(evidence);
	expect(await j.blobs.readBytes(j.before)).toEqual(new Uint8Array(j.beforeBytes));
	expect(await j.blobs.readBytes(j.after)).toEqual(new Uint8Array(j.afterBytes));
	expect(readFileSync(join(f.checkout, "file.txt"))).toEqual(j.afterBytes);
	const proof = f.database
		.query<{ origin_json: string }, []>(
			"SELECT origin_json FROM legacy_narrator_workspace_adoptions WHERE narrator_id='n'",
		)
		.get();
	expect(JSON.parse(proof?.origin_json ?? "{}").scopeIds).toEqual(["journal-scope"]);
	const saved = f.database
		.query<{ manifest_json: string }, []>(
			"SELECT manifest_json FROM legacy_retained_history_manifests WHERE migration_project_id='p'",
		)
		.get();
	expect(
		JSON.parse(saved?.manifest_json ?? "{}").references.file_change_operations[0].project_id,
	).toBe("p");
});
test("related journal with foreign project/narrator, unknown coverage or inflight execution remains blocked", async () => {
	for (const unsafe of ["foreign_project", "foreign_narrator", "unknown", "inflight"] as const) {
		const f = fixture();
		await journal(f);
		if (unsafe === "foreign_project") {
			f.database.exec(
				"INSERT INTO projects(id,name,owner_user_id,created_at,updated_at) VALUES('other','Other','owner','now','now'); UPDATE file_change_operations SET project_id='other' WHERE id='journal-op'",
			);
		}
		if (unsafe === "foreign_narrator") {
			f.database
				.query(
					"INSERT INTO narrators(id,cwd,owner_user_id,created_at,updated_at) VALUES('foreign-n',?,'owner','now','now')",
				)
				.run(f.checkout);
			f.database.exec(
				"UPDATE file_change_operations SET narrator_id='foreign-n' WHERE id='journal-op'",
			);
		}
		if (unsafe === "unknown")
			f.database.exec(
				"UPDATE file_change_operations SET coverage='legacy_unknown' WHERE id='journal-op'",
			);
		if (unsafe === "inflight")
			f.database.exec(
				"UPDATE file_change_operations SET execution_outcome='running',settlement='applying' WHERE id='journal-op'",
			);
		const preview = await f.service.preview("p", actor);
		expect(preview.canMigrate).toBe(false);
		noReceipt(f.database);
	}
});
test("missing journal project index blocks relevant rows without penalizing an unrelated project's bounded row", async () => {
	const relevant = fixture();
	await journal(relevant);
	relevant.database.exec("DROP INDEX idx_fc_operation_project");
	const blocked = await relevant.service.preview("p", actor);
	expect(
		blocked.blockers.some(
			(value) =>
				value.code === "DEPENDENCY_INDEX" &&
				value.message.includes("file_change_operations.project_id"),
		),
	).toBe(true);
	noReceipt(relevant.database);
	const unrelated = fixture();
	unrelated.database.exec(
		"INSERT INTO projects(id,name,owner_user_id,created_at,updated_at) VALUES('other','Other','owner','now','now'); INSERT INTO file_change_operations(id,source_instance_id,source_kind,source_id,attempt,narrator_id,project_id,owner_user_id,actor_subject_key,actor_json,started_at,updated_at) VALUES('foreign-op','foreign-instance','external','foreign-source',1,NULL,'other','owner','external:foreign','{\"kind\":\"external_unknown\"}','now','now'); DROP INDEX idx_fc_operation_project",
	);
	const preview = await unrelated.service.preview("p", actor);
	expect(preview.blockers).toEqual([]);
	expect((await unrelated.service.migrate("p", actor, preview.revision)).phase).toBe("completed");
	expect(
		unrelated.database
			.query("SELECT project_id FROM file_change_operations WHERE id='foreign-op'")
			.get(),
	).toEqual({ project_id: "other" });
});
test("original chapter layouts archive exact strings once without becoming narrator layouts", async () => {
	const f = fixture();
	const dock = '{"legacy":"opaque dock bytes", "geometry": [1,2,3]}';
	const detached = '[ {"legacyPanel":"unaltered"} ]';
	f.database
		.query("UPDATE chapters SET dock_layout_json=?,detached_panels_json=? WHERE id='c'")
		.run(dock, detached);
	const preview = await f.service.preview("p", actor);
	expect(preview.blockers).toEqual([]);
	expect((await f.service.migrate("p", actor, preview.revision)).phase).toBe("completed");
	const archived = f.database
		.query<{ manifest_json: string }, []>(
			"SELECT manifest_json FROM legacy_retained_history_manifests WHERE migration_project_id='p'",
		)
		.get();
	expect(JSON.parse(archived?.manifest_json ?? "{}").rawLayouts).toEqual([
		{ sourceChapterId: "c", dockLayoutJson: dock, detachedPanelsJson: detached },
	]);
	const metadata = f.database
		.query<{ metadata_json: string }, []>(
			"SELECT metadata_json FROM legacy_retained_chapter_metadata WHERE source_chapter_id='c'",
		)
		.get();
	expect(JSON.parse(metadata?.metadata_json ?? "{}")).not.toHaveProperty("dock_layout_json");
});
test("source admission holds root, workspace shadow and ignored archive through history prepare and commit", async () => {
	const f = fixture();
	const preview = await f.service.preview("p", actor);
	const guard = createLifecycleGuard({
		readClaims: async () => ({ complete: true, claims: [] }),
		canonicalPath: async (path) => path,
		pathIdentity: async () => "fixture-identity",
	});
	let checked = 0;
	f.onInspect(async (number) => {
		if (number !== 2) return;
		for (const path of [f.checkout, f.shadow, getNarraforkPath("dormant-ignored", "c")]) {
			let executed = false;
			await expect(
				guard.withProtectionReservation(
					[{ deviceId: "local", path }],
					"test concurrent sweeper",
					async () => {
						executed = true;
					},
				),
			).rejects.toThrow("Cannot completely verify resource protection");
			expect(executed).toBe(false);
			checked++;
		}
	});
	expect((await f.service.migrate("p", actor, preview.revision)).phase).toBe("completed");
	expect(checked).toBe(3);
});
test("strict default still rejects real history without a receipt", async () => {
	const f = fixture(false);
	const preview = await f.service.preview("p", actor);
	expect(preview.canMigrate).toBe(false);
	expect(preview.blockers.some((blocker) => blocker.code === "ADOPTION_HISTORY")).toBe(true);
	expect((await f.service.migrate("p", actor, preview.revision)).phase).toBe("blocked");
	noReceipt(f.database);
});
test("shared refs/lazy ancestors stay byte-identical and acquire per-member durable claims", async () => {
	const f = fixture();
	f.database
		.query(
			"INSERT INTO narrators(id,cwd,owner_user_id,created_at,updated_at) VALUES('ancestor',?,'owner','now','now')",
		)
		.run(f.checkout);
	f.database.exec(
		"UPDATE narrators SET refs_inherited_from='ancestor' WHERE id='n'; INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES('shared','ancestor','m',0)",
	);
	const before = bytes(f.database);
	const preview = await f.service.preview("p", actor);
	expect(preview.blockers).toEqual([]);
	expect((await f.service.migrate("p", actor, preview.revision)).phase).toBe("completed");
	expect(bytes(f.database)).toBe(before);
	expect(
		f.database.query("SELECT workspace_revision FROM narrators WHERE id='ancestor'").get(),
	).toEqual({ workspace_revision: 0 });
	expect(
		f.database
			.query("SELECT narrator_id FROM legacy_migration_artifact_claims ORDER BY narrator_id")
			.all(),
	).toEqual([{ narrator_id: "ancestor" }, { narrator_id: "n" }]);
});
test("unknown capture coverage stays rejected, never promoted by physical lineage", async () => {
	const f = fixture();
	const stat = lstatSync(f.checkout, { bigint: true });
	f.database
		.query(
			"INSERT INTO file_change_scopes(id,source_instance_id,device_id,workspace_instance_id,canonical_root,display_root,path_flavor,status,root_identity_json,created_at,updated_at) VALUES('scope','instance','local','workspace',?,?,'posix','active',?,'now','now')",
		)
		.run(
			f.checkout,
			f.checkout,
			JSON.stringify({ object: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` }),
		);
	f.database.exec(
		"INSERT INTO snapshot_captures(id,scope_id,coverage,policy_version,started_at) VALUES('capture','scope','legacy_unknown',1,'now')",
	);
	const preview = await f.service.preview("p", actor);
	expect(preview.canMigrate).toBe(false);
	expect(preview.blockers.some((blocker) => blocker.code === "ADOPTION_HISTORY")).toBe(true);
	noReceipt(f.database);
});
test("Git index descriptor identity changing after worker proof cannot receive a retained receipt", async () => {
	const f = fixture();
	const preview = await f.service.preview("p", actor);
	expect(preview.canMigrate).toBe(true);
	f.onInspect((number) => {
		if (number === 2) writeFileSync(join(f.checkout, ".git", "index"), "replaced index identity");
	});
	await expect(f.service.migrate("p", actor, preview.revision)).rejects.toThrow("changed");
	noReceipt(f.database);
});
test("cross-project merge sources remain blocked even when the owned commit archive is complete", async () => {
	const f = fixture();
	f.database.exec(
		"INSERT INTO projects(id,name,owner_user_id,created_at,updated_at) VALUES('other','Other','owner','now','now'); INSERT INTO chapters(id,project_id,title,branch,base_branch,created_at,updated_at) VALUES('other-c','other','Other','other','other','now','now')",
	);
	f.database.exec(
		"INSERT INTO merge_sessions(id,target_chapter_id,source_chapter_ids,status,created_at,updated_at) VALUES('external-merge','other-c','[\"c\"]','completed','now','now')",
	);
	const preview = await f.service.preview("p", actor);
	expect(preview.canMigrate).toBe(false);
	expect(preview.blockers.some((blocker) => blocker.code === "EXTERNAL_MERGE_SOURCE")).toBe(true);
	noReceipt(f.database);
});
for (const mutation of ["scope", "ref", "chapter", "counter", "alias", "layout"] as const) {
	test(`external unclocked ${mutation} change after worker proof rolls back receipt and retained metadata`, async () => {
		const f = fixture();
		const preview = await f.service.preview("p", actor);
		expect(preview.canMigrate).toBe(true);
		f.onInspect((number) => {
			if (number !== 2) return;
			const external = new Database(f.databasePath);
			try {
				if (mutation === "scope")
					external
						.query(
							"INSERT INTO file_change_scopes(id,source_instance_id,device_id,workspace_instance_id,canonical_root,display_root,path_flavor,status,created_at,updated_at) VALUES('late','instance','local','workspace',?,?,'posix','active','now','now')",
						)
						.run(f.checkout, f.checkout);
				if (mutation === "ref")
					external.exec("UPDATE narrator_message_refs SET seq=1 WHERE id='r'");
				if (mutation === "chapter")
					external.exec(
						"UPDATE chapters SET description='concurrent untouched scalar' WHERE id='c'",
					);
				if (mutation === "counter")
					external.exec("UPDATE narrators SET message_version=message_version+1 WHERE id='n'");
				if (mutation === "layout")
					external.exec(
						"UPDATE chapters SET dock_layout_json='concurrent raw layout' WHERE id='c'",
					);
				if (mutation === "alias")
					external
						.query(
							"INSERT INTO projects(id,name,git_path,owner_user_id,created_at,updated_at) VALUES('late-project','Late alias',?,'owner','now','now')",
						)
						.run(f.checkout);
			} finally {
				external.close();
			}
		});
		await expect(f.service.migrate("p", actor, preview.revision)).rejects.toThrow("changed");
		noReceipt(f.database);
	});
}
