import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
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
import type { Worker } from "node:worker_threads";
import { applyPendingMigrationsByHash } from "../db/run-migrations";
import { prepareLegacyLinkedWorktreeIdentity } from "./legacy-linked-worktree-identity";
import type {
	LegacyRetainedHistoryInput,
	LegacyRetainedWorkspaceBinding,
} from "./legacy-retained-history-contract";
import {
	collectLegacyRetainedHistoryWorker,
	prepareLegacyRetainedHistory,
} from "./legacy-retained-history-plan";
import { inspectLegacyRetainedHistoryReadonly } from "./legacy-retained-history-validator";
import { treeSnapshotKey, treeSnapshotPhysicalDir } from "./tree-snapshot-paths";

let template: string;
let directory: string;
let database: Database;
let input: LegacyRetainedHistoryInput;
let commit: string;
let snapshot: string;
let tree: string;
let fixtureShadowDirectories: string[] = [];
function git(path: string, args: string[], stdin?: string) {
	const result = spawnSync("git", ["-C", path, ...args], {
		input: stdin,
		encoding: "utf8",
		timeout: 2000,
		maxBuffer: 128 * 1024,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "fixture",
			GIT_AUTHOR_EMAIL: "fixture@test",
			GIT_COMMITTER_NAME: "fixture",
			GIT_COMMITTER_EMAIL: "fixture@test",
		},
	});
	if (result.status !== 0 || result.error) throw new Error(result.stderr || String(result.error));
	return result.stdout.trim();
}
beforeAll(() => {
	template = mkdtempSync(join(tmpdir(), "nf-retained-schema-"));
	const db = new Database(join(template, "template.db"));
	applyPendingMigrationsByHash(db, resolve("drizzle"));
	db.close();
});
afterAll(() => rmSync(template, { recursive: true, force: true }));
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "nf-retained-fixture-"));
	const root = join(directory, "repo");
	const shadow = join(directory, "shadow");
	mkdirSync(root);
	mkdirSync(shadow);
	git(root, ["init", "-b", "main"]);
	writeFileSync(join(root, "file.txt"), "real original bytes\n");
	git(root, ["add", "file.txt"]);
	git(root, ["commit", "-m", "fixture"]);
	commit = git(root, ["rev-parse", "HEAD"]);
	git(shadow, ["init", "--bare"]);
	const blob = git(shadow, ["hash-object", "-w", "--stdin"], "shadow exact original bytes\n");
	tree = git(shadow, ["mktree"], `100644 blob ${blob}\tfile.txt\n`);
	snapshot = git(shadow, ["commit-tree", tree], "fixture snapshot\n");
	git(shadow, ["update-ref", "refs/heads/workspace", snapshot]);
	const databasePath = join(directory, "history.db");
	copyFileSync(join(template, "template.db"), databasePath);
	database = new Database(databasePath);
	database.exec("PRAGMA foreign_keys=OFF");
	database.run(
		"INSERT INTO users(id,username,password_hash,created_at) VALUES ('u','fixture-user','fixture-unused-password-hash','now')",
	);
	database.run(
		"INSERT INTO projects(id,name,git_path,owner_user_id,visibility,created_at,updated_at) VALUES ('p','fixture',?,'u','private','now','now')",
		[root],
	);
	database.run(
		"INSERT INTO chapters(id,project_id,title,description,branch,base_branch,is_root,worktree_path,head_commit_sha,start_commit_sha,commit_count,snapshot_commit_sha,snapshot_shadow_key,created_at,updated_at) VALUES ('c','p','Original title','Original description','main','main',1,?,?,?,1,?,?,'now','now')",
		[root, commit, commit, snapshot, treeSnapshotKey("local", root)],
	);
	database.run(
		"INSERT INTO narrators(id,chapter_id,cwd,owner_user_id,visibility,write_audience,workspace_revision,created_at,updated_at) VALUES ('n','c',?,'u','private','owner',7,'now','now')",
		[root],
	);
	database.run(
		"INSERT INTO narrator_messages(id,narrator_id,role,content_json,commit_sha,tree_hash_after,snapshot_commit_sha,created_at) VALUES ('m','n','user',?,?,?,?, 'now')",
		['[{"type":"text","text":"real history bytes"}]', commit, tree, snapshot],
	);
	database.run(
		"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES ('r','n','m',0)",
	);
	database.run(
		"INSERT INTO narrator_file_snapshots(id,narrator_id,device_id,file_path,original_content,created_at) VALUES ('f','n','local',?,'unaltered original','now')",
		[join(root, "file.txt")],
	);
	database.run(
		"INSERT INTO narrator_tool_calls(id,narrator_id,message_id,tool_use_id,tool_name,status,execution_device_id,execution_cwd,tree_hash_before,tree_hash_after,input_json,output_json,created_at) VALUES ('t','n','m','use','Edit','success','local',?,?,?,?,?,'now')",
		[root, tree, tree, '{"opaque":true}', '{"bytes":true}'],
	);
	input = {
		databasePath,
		projectId: "p",
		chapterIds: ["c"],
		narratorIds: ["n"],
		workspacePaths: [root],
		snapshotShadowKeys: [treeSnapshotKey("local", root)],
		shadowDirectories: [shadow],
		mainCheckoutRoot: root,
	};
});
afterEach(() => {
	try {
		database.close();
	} catch {}
	rmSync(directory, { recursive: true, force: true });
	for (const path of fixtureShadowDirectories) rmSync(path, { recursive: true, force: true });
	fixtureShadowDirectories = [];
});
function inspect() {
	return inspectLegacyRetainedHistoryReadonly(input);
}

async function twoLinkedFixture() {
	const root = input.mainCheckoutRoot;
	const rootShadow = treeSnapshotPhysicalDir("local", root);
	fixtureShadowDirectories.push(rootShadow);
	mkdirSync(dirname(rootShadow), { recursive: true });
	git(root, ["clone", "--bare", input.shadowDirectories[0], rootShadow]);
	const bindings: LegacyRetainedWorkspaceBinding[] = [
		{
			sourceChapterId: "c",
			workspacePath: root,
			deviceId: "local",
			kind: "root",
			shadowKey: treeSnapshotKey("local", root),
			shadowDirectory: rootShadow,
		},
	];
	const members: Array<{
		id: string;
		narratorId: string;
		path: string;
		shadow: string;
		tree: string;
		snapshot: string;
		commit: string;
		branch: string;
	}> = [];
	for (let index = 1; index <= 2; index++) {
		const id = `linked-${index}`;
		const narratorId = `linked-n-${index}`;
		const path = join(directory, `linked-workspace-${index}`);
		const branch = `fixture-linked-${index}`;
		git(root, ["worktree", "add", "-b", branch, path, commit]);
		writeFileSync(join(path, "file.txt"), `linked ${index} live exact bytes\n`);
		git(path, ["add", "file.txt"]);
		git(path, ["commit", "-m", `linked fixture ${index}`]);
		const head = git(path, ["rev-parse", "HEAD"]);
		const shadow = treeSnapshotPhysicalDir("local", path);
		fixtureShadowDirectories.push(shadow);
		mkdirSync(shadow, { recursive: true });
		git(shadow, ["init", "--bare"]);
		const blob = git(
			shadow,
			["hash-object", "-w", "--stdin"],
			`linked ${index} historical exact bytes\n`,
		);
		const treeHash = git(shadow, ["mktree"], `100644 blob ${blob}\tfile.txt\n`);
		const snapshotSha = git(shadow, ["commit-tree", treeHash], `linked historical ${index}\n`);
		git(shadow, ["update-ref", "refs/heads/workspace", snapshotSha]);
		database.run(
			"INSERT INTO chapters(id,project_id,title,branch,base_branch,is_root,status,role,worktree_path,head_commit_sha,start_commit_sha,snapshot_commit_sha,snapshot_shadow_key,created_at,updated_at) VALUES (?,'p','Linked source',?,'main',0,'dormant','branch',?,?,?,?,?,'now','now')",
			[id, branch, path, head, commit, snapshotSha, treeSnapshotKey("local", path)],
		);
		database.run(
			"INSERT INTO narrators(id,chapter_id,cwd,owner_user_id,visibility,write_audience,workspace_revision,created_at,updated_at) VALUES (?, ?,?,'u','private','owner',?,'now','now')",
			[narratorId, id, index === 2 ? null : path, 10 + index],
		);
		database.run(
			"INSERT INTO narrator_messages(id,narrator_id,role,content_json,commit_sha,tree_hash_after,snapshot_commit_sha,created_at) VALUES (?,?,'assistant',?,?,?,?, 'now')",
			[
				`linked-message-${index}`,
				narratorId,
				JSON.stringify([{ type: "text", text: `original linked ${index} bytes` }]),
				head,
				treeHash,
				snapshotSha,
			],
		);
		database.run(
			"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES (?,?,?,0)",
			[`linked-ref-${index}`, narratorId, `linked-message-${index}`],
		);
		database.run(
			"INSERT INTO narrator_tool_calls(id,narrator_id,message_id,tool_use_id,tool_name,status,execution_device_id,execution_cwd,tree_hash_before,tree_hash_after,created_at) VALUES (?,?,?,?,'Edit','success','local',?,?,?,'now')",
			[
				`linked-tool-${index}`,
				narratorId,
				`linked-message-${index}`,
				`linked-use-${index}`,
				path,
				treeHash,
				treeHash,
			],
		);
		database.run(
			"INSERT INTO narrator_file_snapshots(id,narrator_id,device_id,file_path,original_content,created_at) VALUES (?,?,'local',?,?,'now')",
			[
				`linked-original-${index}`,
				narratorId,
				join(path, "file.txt"),
				`linked ${index} original replay bytes`,
			],
		);
		database.run(
			"INSERT INTO worktree_tree_snapshots(id,device_id,worktree_path,tree_hash,snapshot_commit_sha,created_at) VALUES (?,'local',?,?,?,'now')",
			[`linked-membership-${index}`, path, treeHash, snapshotSha],
		);
		members.push({
			id,
			narratorId,
			path,
			shadow,
			tree: treeHash,
			snapshot: snapshotSha,
			commit: head,
			branch,
		});
	}
	database.run(
		"INSERT INTO worktree_tree_snapshots(id,device_id,worktree_path,tree_hash,snapshot_commit_sha,created_at) VALUES ('root0-membership','local',?,?,?,'now')",
		[root, tree, snapshot],
	);
	for (const member of members) {
		const probeInput = {
			projectRoot: root,
			worktreePath: member.path,
			expectedBranch: member.branch,
		};
		const evidence = await prepareLegacyLinkedWorktreeIdentity(probeInput);
		bindings.push({
			sourceChapterId: member.id,
			workspacePath: member.path,
			deviceId: "local",
			kind: "linked",
			shadowKey: treeSnapshotKey("local", member.path),
			shadowDirectory: member.shadow,
			linked: { input: probeInput, evidence },
		});
	}
	input.chapterIds = ["c", ...members.map((member) => member.id)];
	input.narratorIds = ["n", ...members.map((member) => member.narratorId)];
	input.workspacePaths = bindings.map((binding) => binding.workspacePath);
	input.snapshotShadowKeys = bindings.map((binding) => binding.shadowKey);
	input.shadowDirectories = bindings.map((binding) => binding.shadowDirectory);
	input.workspaceBindings = bindings;
	return { root, members, bindings };
}

test("real root Git/shadow/message/file replay references retained without rewriting bytes", async () => {
	database.close();
	const before = readFileSync(input.databasePath);
	const index = readFileSync(join(input.mainCheckoutRoot, ".git", "index"));
	const head = readFileSync(join(input.mainCheckoutRoot, ".git", "HEAD"));
	const file = readFileSync(join(input.mainCheckoutRoot, "file.txt"));
	const value = await prepareLegacyRetainedHistory(input);
	expect(value.reason).toBeUndefined();
	expect(value.status).toBe("retained");
	expect(value.complete).toBe(true);
	expect(value.manifest.chapters[0].title).toBe("Original title");
	expect(value.manifest.chapters[0].snapshot_commit_sha).toBe(snapshot);
	expect(git(input.shadowDirectories[0], ["show", `${snapshot}:file.txt`])).toBe(
		"shadow exact original bytes",
	);
	expect(value.manifest.narratorOrigins[0].workspaceRevision).toBe(7);
	expect(value.manifest.assets[0].shadowKey).toBe(treeSnapshotKey("local", input.mainCheckoutRoot));
	expect(value.manifest.references.narrator_messages[0]).not.toHaveProperty("content_json");
	expect(value.manifest.references.narrator_file_snapshots[0]).not.toHaveProperty(
		"original_content",
	);
	expect(value.manifest.references.narrator_tool_calls[0]).not.toHaveProperty("output_json");
	expect(readFileSync(input.databasePath)).toEqual(before);
	expect(readFileSync(join(input.mainCheckoutRoot, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(input.mainCheckoutRoot, ".git", "HEAD"))).toEqual(head);
	expect(readFileSync(join(input.mainCheckoutRoot, "file.txt"))).toEqual(file);
	expect((await prepareLegacyRetainedHistory(input)).digest).toBe(value.digest);
});

test("shared refs and lazy ancestor retain all related guards without adopting external sessions", () => {
	database.run(
		"INSERT INTO narrators(id,cwd,owner_user_id,visibility,write_audience,message_version,message_structure_version,next_seq,created_at,updated_at) VALUES ('ancestor',?,'u','private','owner',2,3,4,'now','now')",
		[input.mainCheckoutRoot],
	);
	database.run("UPDATE narrators SET refs_inherited_from='ancestor' WHERE id='n'");
	database.run(
		"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES ('shared','ancestor','m',0)",
	);
	const value = inspect();
	expect(value.reason).toBeUndefined();
	expect(value.status).toBe("retained");
	expect(value.guards.map((guard) => guard.id)).toEqual(["ancestor", "n"]);
	expect(value.manifest.externalNarratorIds).toEqual(["ancestor"]);
	expect(value.manifest.references.narrator_message_refs).toHaveLength(2);
});

test("shared COW tools retain the original execution owner and immutable execution provenance", () => {
	database.run(
		"INSERT INTO narrators(id,cwd,owner_user_id,visibility,write_audience,created_at,updated_at) VALUES ('original-owner',?,'u','private','owner','now','now')",
		[input.mainCheckoutRoot],
	);
	database.run(
		"INSERT INTO narrator_tool_calls(id,narrator_id,message_id,tool_use_id,tool_name,status,execution_device_id,execution_cwd,tree_hash_before,tree_hash_after,execution_identity_version,execution_origin_tool_call_id,execution_attempt,output_json,created_at) VALUES ('original-tool','original-owner','m','original-use','Edit','success','local',?,?,?,1,'original-tool',2,?,'now')",
		[input.mainCheckoutRoot, tree, tree, '{"originalOutput":"byte-source"}'],
	);
	database.run(
		"UPDATE narrator_tool_calls SET execution_identity_version=1,execution_origin_tool_call_id='original-tool',execution_attempt=0 WHERE id='t'",
	);
	const value = inspect();
	expect(value.reason).toBeUndefined();
	expect(value.status).toBe("retained");
	expect(value.guards.map((guard) => guard.id)).toEqual(["n", "original-owner"]);
	expect(
		value.manifest.references.narrator_tool_calls.find((tool) => tool.id === "t")
			?.execution_origin_tool_call_id,
	).toBe("original-tool");
	expect(
		value.manifest.references.narrator_tool_calls.find((tool) => tool.id === "original-tool")
			?.execution_attempt,
	).toBe(2);
	expect(
		database.query("SELECT output_json FROM narrator_tool_calls WHERE id='original-tool'").get(),
	).toEqual({ output_json: '{"originalOutput":"byte-source"}' });
});

test("cyclic lazy ancestors and unverified old patch-shadow namespaces remain unknown", () => {
	database.run(
		"INSERT INTO narrators(id,cwd,owner_user_id,visibility,write_audience,refs_inherited_from,created_at,updated_at) VALUES ('ancestor',?,'u','private','owner','n','now','now')",
		[input.mainCheckoutRoot],
	);
	database.run("UPDATE narrators SET refs_inherited_from='ancestor' WHERE id='n'");
	expect(inspect().reason).toContain("cyclic lazy");
	database.run("UPDATE narrators SET refs_inherited_from=NULL");
	database.run(
		"INSERT INTO narrator_patches(id,narrator_id,message_id,tool_use_id,before_hash,after_hash,files_json,created_at) VALUES ('patch','n','m','old-use',?,?,'[\"file.txt\"]','now')",
		[tree, tree],
	);
	expect(inspect().reason).toContain("legacy patch shadow namespace");
});

test("empty history row ids cannot vanish behind the keyset cursor", () => {
	database.run(
		"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES ('','n','empty-key',3)",
	);
	expect(inspect().reason).toContain("empty row identity");
});

test("real SHA cannot be smuggled from shadow namespace", () => {
	database.run("UPDATE chapters SET head_commit_sha=? WHERE id='c'", [snapshot]);
	expect(inspect().status).toBe("unknown");
});
test("shadow SHA cannot be smuggled from real Git namespace", () => {
	database.run("UPDATE chapters SET snapshot_commit_sha=? WHERE id='c'", [commit]);
	expect(inspect().status).toBe("unknown");
});
test("oversized chapter metadata is blocked rather than truncated", () => {
	database.run("UPDATE chapters SET description=? WHERE id='c'", ["x".repeat(65537)]);
	const value = inspect();
	expect(value.status).toBe("unknown");
	expect(value.reason).toContain("oversized");
});
test("old raw layout strings are archived once byte-exact without parsing or narrator-layout reuse", async () => {
	const dock = ` \uFEFFnot-json:\u0000旧布局\n${"d".repeat(128 * 1024)}`;
	const detached = `  original detached panels \r\n${"界".repeat(30000)}  `;
	database.run("UPDATE chapters SET dock_layout_json=?,detached_panels_json=? WHERE id='c'", [
		dock,
		detached,
	]);
	database.close();
	const before = readFileSync(input.databasePath);
	const value = await prepareLegacyRetainedHistory(input);
	expect(value.reason).toBeUndefined();
	expect(value.status).toBe("retained");
	expect(value.manifest.rawLayouts).toHaveLength(1);
	expect(value.manifest.rawLayouts[0]).toEqual({
		sourceChapterId: "c",
		dockLayoutJson: dock,
		detachedPanelsJson: detached,
	});
	expect(Buffer.from(value.manifest.rawLayouts[0].dockLayoutJson ?? "")).toEqual(Buffer.from(dock));
	expect(value.manifest.chapters[0]).not.toHaveProperty("dock_layout_json");
	expect(value.manifest.chapters[0]).not.toHaveProperty("detached_panels_json");
	expect(value.manifest.narratorOrigins[0]).not.toHaveProperty("dockLayoutJson");
	expect(readFileSync(input.databasePath)).toEqual(before);
});

test("raw layout null and empty strings remain distinct", () => {
	database.run("UPDATE chapters SET dock_layout_json=NULL,detached_panels_json='' WHERE id='c'");
	const value = inspect();
	expect(value.reason).toBeUndefined();
	expect(value.manifest.rawLayouts).toEqual([
		{ sourceChapterId: "c", dockLayoutJson: null, detachedPanelsJson: "" },
	]);
});

test("each raw layout column has a UTF-8 byte limit and oversize is never truncated", () => {
	for (const field of ["dock_layout_json", "detached_panels_json"]) {
		const original = "界".repeat(Math.floor((512 * 1024) / 3) + 1);
		database.run(`UPDATE chapters SET ${field}=? WHERE id='c'`, [original]);
		const value = inspect();
		expect(value.status).toBe("unknown");
		expect(value.complete).toBe(false);
		expect(value.reason).toContain("raw layout byte budget");
		expect(value.manifest.rawLayouts).toHaveLength(0);
		expect(database.query(`SELECT ${field} AS original FROM chapters WHERE id='c'`).get()).toEqual({
			original,
		});
		database.run(`UPDATE chapters SET ${field}=NULL WHERE id='c'`);
	}
});

test("raw layouts share the entire two-MiB manifest budget rather than a per-chapter allowance", () => {
	const layout = "x".repeat(512 * 1024);
	database.run("UPDATE chapters SET dock_layout_json=?,detached_panels_json=? WHERE id='c'", [
		layout,
		layout,
	]);
	database.run(
		"INSERT INTO chapters(id,project_id,title,branch,base_branch,is_root,status,worktree_path,dock_layout_json,detached_panels_json,created_at,updated_at) VALUES ('c2','p','second root','other','main',1,'abandoned',?,?,?,'now','now')",
		[input.mainCheckoutRoot, layout, layout],
	);
	input.chapterIds.push("c2");
	const value = inspect();
	expect(value.status).toBe("unknown");
	expect(value.complete).toBe(false);
	expect(value.reason).toContain("raw layout byte budget");
	expect(value.manifest.rawLayouts).toHaveLength(1);
});

test("unfinished merge, review, sleeprestore and parked reapply conservatively reject", () => {
	for (const field of [
		"review_status",
		"dormant_snapshot_commit_sha",
		"parked_snapshot_commit_sha",
	]) {
		database.run(`UPDATE chapters SET ${field}='pending' WHERE id='c'`);
		expect(inspect().status).toBe("unknown");
		database.run(`UPDATE chapters SET ${field}=NULL WHERE id='c'`);
	}
	writeFileSync(join(input.mainCheckoutRoot, ".git", "MERGE_HEAD"), commit);
	expect(inspect().status).toBe("unknown");
});
test("legacy_unknown capture never becomes complete and never reads its blob body", () => {
	const rootStat = lstatSync(input.mainCheckoutRoot, { bigint: true });
	database.run(
		"INSERT INTO file_change_scopes(id,source_instance_id,device_id,workspace_instance_id,canonical_root,display_root,path_flavor,status,root_identity_json,created_at,updated_at) VALUES ('scope','instance','local','workspace',?,?,'posix','active',?,'now','now')",
		[
			input.mainCheckoutRoot,
			input.mainCheckoutRoot,
			JSON.stringify({ object: `${rootStat.dev}:${rootStat.ino}:${rootStat.birthtimeNs}` }),
		],
	);
	database.run(
		"INSERT INTO snapshot_captures(id,scope_id,coverage,policy_version,started_at) VALUES ('capture','scope','legacy_unknown',1,'now')",
	);
	const value = inspect();
	expect(value.status).toBe("unknown");
	expect(value.complete).toBe(false);
	expect(value.manifest.legacyUnknownEvidence[0].coverage).toBe("legacy_unknown");
});
test("row/byte/time budgets fail closed", () => {
	for (const overrides of [{ rows: 0 }, { bytes: 1 }, { milliseconds: 0 }]) {
		const value = inspectLegacyRetainedHistoryReadonly(input, {
			rows: 10000,
			bytes: 2097152,
			filesystemEntries: 1024,
			milliseconds: 3000,
			...overrides,
		});
		expect(value.status).toBe("unknown");
		expect(value.complete).toBe(false);
	}
});
test("unknown owner, broader ACL and other physical cwd reject", () => {
	for (const [field, value] of [
		["owner_user_id", null],
		["visibility", "public"],
		["cwd", directory],
	]) {
		database.run(`UPDATE narrators SET ${field}=? WHERE id='n'`, [value]);
		expect(inspect().status).toBe("unknown");
		database.run("UPDATE narrators SET owner_user_id='u',visibility='private',cwd=? WHERE id='n'", [
			input.mainCheckoutRoot,
		]);
	}
});
test("ignored archive retains original directory identity, not a restore authorization", () => {
	const archive = join(directory, "ignored");
	mkdirSync(archive);
	writeFileSync(join(archive, "secret"), "original ignored bytes");
	input.ignoredArchiveDirectories = [{ sourceChapterId: "c", artifactPath: archive }];
	const value = inspect();
	expect(value.reason).toBeUndefined();
	expect(value.status).toBe("retained");
	expect(
		value.manifest.assets.find((asset) => asset.kind === "ignored_archive")?.artifactPath,
	).toBe(archive);
	expect(readFileSync(join(archive, "secret"), "utf8")).toBe("original ignored bytes");
});

test("bounded keyset pages retain history beyond one page without copying large bodies", () => {
	const body = JSON.stringify([{ type: "text", text: "UNREAD_PRIVATE_BODY".repeat(8192) }]);
	database.run("UPDATE narrator_messages SET content_json=? WHERE id='m'", [body]);
	database.run("UPDATE narrator_tool_calls SET input_json=?,output_json=? WHERE id='t'", [
		body,
		body,
	]);
	database.run("UPDATE narrator_file_snapshots SET original_content=? WHERE id='f'", [body]);
	for (let i = 0; i < 130; i++) {
		const id = `paged-${String(i).padStart(4, "0")}`;
		database.run(
			"INSERT INTO narrator_messages(id,narrator_id,role,content_json,created_at) VALUES (?,'n','user',?,'now')",
			[id, body],
		);
		database.run(
			"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES (?,'n',?,?)",
			[`ref-${id}`, id, i + 1],
		);
	}
	const value = inspect();
	expect(value.reason).toBeUndefined();
	expect(value.status).toBe("retained");
	expect(value.manifest.references.narrator_messages).toHaveLength(131);
	expect(value.manifest.references.narrator_message_refs).toHaveLength(131);
	expect(JSON.stringify(value.manifest)).not.toContain("UNREAD_PRIVATE_BODY");
});

test("commit index, fork/head/start/anchor/count and finished graph metadata are archived", () => {
	database.run(
		"UPDATE chapters SET anchor_commit_sha=?,fork_point=?,graph_x=12,graph_y=34 WHERE id='c'",
		[commit, JSON.stringify({ commitSha: commit, worktreeSource: "workspace" })],
	);
	database.run(
		"INSERT INTO chapter_commits(id,chapter_id,sha,message,author_name,authored_at,created_at) VALUES ('ci','c',?,'Original commit description','Original author','now','now')",
		[commit],
	);
	database.run(
		"INSERT INTO chapter_edges(id,project_id,source_id,target_id,type,metadata,created_at) VALUES ('edge','p','c','finished','merge','{}','now')",
	);
	database.run(
		"INSERT INTO merge_sessions(id,target_chapter_id,source_chapter_ids,status,pre_merge_target_sha,pre_merge_target_snapshot,merge_source_snapshot,pre_merge_tree,created_at,updated_at) VALUES ('merge','c','[\"finished\"]','completed',?,?,?,?,'now','now')",
		[commit, snapshot, snapshot, tree],
	);
	const value = inspect();
	expect(value.reason).toBeUndefined();
	expect(value.status).toBe("retained");
	expect(value.manifest.chapters[0].commit_count).toBe(1);
	expect(value.manifest.chapters[0].graph_x).toBe(12);
	expect(value.manifest.references.chapter_commits[0].message).toBe("Original commit description");
	expect(value.manifest.references.chapter_edges[0].metadata).toBe("{}");
	expect(value.manifest.references.merge_sessions[0].pre_merge_target_snapshot).toBe(snapshot);
});

test("unknown external attribution and public share remain blockers", () => {
	database.run(
		"INSERT INTO narrator_public_shares(id,narrator_id,token_hash,guest_name,created_at) VALUES ('share','n','opaque','Guest','now')",
	);
	expect(inspect().reason).toContain("public share");
	database.run("DELETE FROM narrator_public_shares WHERE id='share'");
	database.run(
		"INSERT INTO file_attributions(id,device_id,workspace_path,file_path,action,changed_at) VALUES ('external','local',?,'file.txt','external','now')",
		[input.mainCheckoutRoot],
	);
	expect(inspect().reason).toContain("external file attribution");
});

test("digest changes when guarded narrator counters advance after prepare", () => {
	const before = inspect();
	expect(before.status).toBe("retained");
	database.run(
		"UPDATE narrators SET next_seq=next_seq+1,message_version=message_version+1 WHERE id='n'",
	);
	const after = inspect();
	expect(after.status).toBe("retained");
	expect(after.digest).not.toBe(before.digest);
	expect(after.guards[0].nextSeq).toBe(before.guards[0].nextSeq + 1);
});

test("implicit root cwd is retained as original null without falsifying old context", () => {
	database.run("UPDATE narrators SET cwd=NULL,workspace_context=NULL WHERE id='n'");
	const value = inspect();
	expect(value.reason).toBeUndefined();
	expect(value.status).toBe("retained");
	expect(value.manifest.narratorOrigins[0].workspacePath).toBe(input.mainCheckoutRoot);
	expect(value.manifest.narratorOrigins[0].persistedCwd).toBeNull();
	expect(value.manifest.narratorOrigins[0].workspaceContext).toBeNull();
	expect(value.manifest.references.narrators[0].cwd).toBeNull();
});

test("omitted chapter members cannot become a complete manifest", () => {
	database.run(
		"INSERT INTO narrators(id,chapter_id,cwd,owner_user_id,visibility,write_audience,created_at,updated_at) VALUES ('omitted','c',?,'u','private','owner','now','now')",
		[input.mainCheckoutRoot],
	);
	const value = inspect();
	expect(value.complete).toBe(false);
	expect(value.reason).toContain("incomplete source chapter");
});

test("external Git object stores and borrowed shadow repository discovery remain unknown", () => {
	writeFileSync(
		join(input.mainCheckoutRoot, ".git", "objects", "info", "alternates"),
		join(input.shadowDirectories[0], "objects"),
	);
	expect(inspect().reason).toContain("external Git object");
});

test("active background runtime is blocked even when narrator itself is idle", () => {
	database.run(
		"INSERT INTO background_tasks(id,parent_narrator_id,type,status,started_at,created_at,updated_at) VALUES ('background','n','bash','running','now','now','now')",
	);
	expect(inspect().reason).toContain("active background runtime");
});

test("archived root narrator retains real history without changing its original status", async () => {
	database.run("UPDATE narrators SET status='archived' WHERE id='n'");
	const value = await prepareLegacyRetainedHistory(input);
	expect(value.reason).toBeUndefined();
	expect(value.status).toBe("retained");
	expect(value.manifest.references.narrators[0].status).toBe("archived");
	expect(database.query("SELECT status FROM narrators WHERE id='n'").get()).toEqual({
		status: "archived",
	});
});

test("archived status cannot override unfinished tools or active background resources", () => {
	database.run("UPDATE narrators SET status='archived' WHERE id='n'");
	database.run("UPDATE narrator_tool_calls SET status='running' WHERE id='t'");
	expect(inspect().reason).toContain("tool owner/physical execution");
	database.run("UPDATE narrator_tool_calls SET status='success' WHERE id='t'");
	database.run(
		"INSERT INTO background_tasks(id,parent_narrator_id,type,status,started_at,created_at,updated_at) VALUES ('archived-background','n','bash','running','now','now','now')",
	);
	expect(inspect().reason).toContain("active background runtime");
});

test("working, waiting and unsupported legacy status strings remain unknown", () => {
	for (const status of ["working", "waiting", "error"]) {
		database.run("UPDATE narrators SET status=? WHERE id='n'", [status]);
		const value = inspect();
		expect(value.status).toBe("unknown");
		expect(value.complete).toBe(false);
	}
});

test("root plus two real linked workspaces retain their original Git/shadow/replay namespaces without writes", async () => {
	const fixture = await twoLinkedFixture();
	const paths = [fixture.root, ...fixture.members.map((member) => member.path)];
	const preserved = paths.map((path) => {
		const admin = git(path, ["rev-parse", "--absolute-git-dir"]);
		return {
			path,
			admin,
			head: readFileSync(join(admin, "HEAD")),
			index: readFileSync(join(admin, "index")),
			file: readFileSync(join(path, "file.txt")),
		};
	});
	database.close();
	const originalDatabase = readFileSync(input.databasePath);
	let admissions = 0;
	const value = await prepareLegacyRetainedHistory(input, {
		assertLinkedAdmissionReady: () => {
			admissions++;
		},
	});
	expect(value.reason).toBeUndefined();
	expect(value.status).toBe("retained");
	expect(admissions).toBe(2);
	expect(value.manifest.workspaces.map((workspace) => workspace.workspacePath)).toEqual(paths);
	expect(value.manifest.assets.filter((asset) => asset.kind === "shadow")).toHaveLength(3);
	for (const member of fixture.members) {
		const workspace = value.manifest.workspaces.find((item) => item.workspacePath === member.path);
		expect(workspace?.commonDirectoryPath).toBe(join(fixture.root, ".git"));
		expect(workspace?.linkedEvidence?.head).toBe(member.commit);
		expect(
			value.manifest.narratorOrigins.find((origin) => origin.narratorId === member.narratorId)
				?.workspacePath,
		).toBe(member.path);
		expect(
			value.manifest.historyOrigins.find(
				(origin) =>
					origin.table === "narrator_messages" &&
					origin.id === `linked-message-${member.path.endsWith("1") ? 1 : 2}`,
			)?.workspacePath,
		).toBe(member.path);
		expect(
			value.manifest.assets.find((asset) => asset.sourceChapterId === member.id)?.artifactPath,
		).toBe(member.shadow);
		expect(git(member.shadow, ["show", `${member.snapshot}:file.txt`])).toBe(
			`linked ${member.path.endsWith("1") ? 1 : 2} historical exact bytes`,
		);
	}
	expect(
		value.manifest.narratorOrigins.find((origin) => origin.narratorId === "linked-n-2")
			?.persistedCwd,
	).toBeNull();
	expect(
		value.manifest.historyOrigins.find(
			(origin) => origin.table === "narrator_messages" && origin.id === "m",
		)?.workspacePath,
	).toBe(fixture.root);
	expect(readFileSync(input.databasePath)).toEqual(originalDatabase);
	for (const item of preserved) {
		expect(readFileSync(join(item.admin, "HEAD"))).toEqual(item.head);
		expect(readFileSync(join(item.admin, "index"))).toEqual(item.index);
		expect(readFileSync(join(item.path, "file.txt"))).toEqual(item.file);
	}
});

test("linked original scopes/effects/actor/blob references stay in their actual groups and bytes are never copied", async () => {
	const fixture = await twoLinkedFixture();
	const blobs: Array<{ path: string; bytes: Buffer }> = [];
	const blobRoot = join(directory, "fixture-original-blobs");
	mkdirSync(blobRoot);
	for (const [index, member] of fixture.members.entries()) {
		const scopeId = `linked-scope-${index}`;
		const operationId = `linked-operation-${index}`;
		const effectId = `linked-effect-${index}`;
		const blob = Buffer.from(`untouched original blob bytes ${index}\0legacy编码`);
		const digest = createHash("sha256").update(blob).digest("hex");
		const blobPath = join(blobRoot, digest);
		writeFileSync(blobPath, blob);
		blobs.push({ path: blobPath, bytes: blob });
		database.run(
			"INSERT INTO file_change_blobs(id,digest,size_bytes,storage_key,status,created_at,updated_at) VALUES (?,?,?,?,'ready','now','now')",
			[`blob-${index}`, digest, blob.length, blobPath],
		);
		const stat = lstatSync(member.path, { bigint: true });
		const sourceInstanceId = "linked-fixture-instance";
		const workspaceInstanceId = `instance-${index}`;
		database.run(
			"INSERT INTO file_change_scopes(id,source_instance_id,device_id,workspace_instance_id,canonical_root,display_root,path_flavor,status,root_identity_json,created_at,updated_at) VALUES (?,?,'local',?,?,?,'posix','active',?,'now','now')",
			[
				scopeId,
				sourceInstanceId,
				workspaceInstanceId,
				member.path,
				member.path,
				JSON.stringify({ object: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` }),
			],
		);
		const actor = JSON.stringify({
			kind: "primary",
			subjectKey: `narrator:${member.narratorId}`,
			narratorId: member.narratorId,
			userId: "u",
			label: `Original actor ${index}`,
			deleted: false,
			parentSubjectKey: null,
		});
		database.run(
			"INSERT INTO file_change_operations(id,source_instance_id,source_kind,source_id,attempt,tool_call_id,narrator_id,project_id,owner_user_id,actor_subject_key,actor_json,execution_outcome,effect_outcome,settlement,coverage,started_at,finished_at,updated_at) VALUES (?,?,'tool',?,1,?,?,'p','u',?,?,'succeeded','changed','settled','complete','now','now','now')",
			[
				operationId,
				sourceInstanceId,
				`linked-tool-${index + 1}`,
				`linked-tool-${index + 1}`,
				member.narratorId,
				`narrator:${member.narratorId}`,
				actor,
			],
		);
		const canonicalPath = join(member.path, "file.txt");
		const identity = JSON.stringify({
			sourceInstanceId,
			deviceId: "local",
			workspaceInstanceId,
			scopeId,
			pathFlavor: "posix",
			objectRole: "referent",
			canonicalPath,
			lexicalPath: canonicalPath,
			displayPath: canonicalPath,
		});
		const state = JSON.stringify({
			kind: "regular",
			blob: { algorithm: "sha256", digest, sizeBytes: blob.length },
			mode: 420,
		});
		database.run(
			"INSERT INTO file_change_effects(id,operation_id,scope_id,file_key,identity_json,scope_revision,mutation_id,request_digest,phase,before_state_json,intended_after_state_json,observed_after_state_json,before_blob_digest,intended_after_blob_digest,observed_after_blob_digest,outcome,settlement,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?,'apply',?,?,?,?,?,?,'changed','settled','now','now')",
			[
				effectId,
				operationId,
				scopeId,
				canonicalPath,
				identity,
				`mutation-${index}`,
				digest,
				state,
				state,
				state,
				digest,
				digest,
				digest,
			],
		);
		database.run("UPDATE narrator_tool_calls SET file_change_operation_id=? WHERE id=?", [
			operationId,
			`linked-tool-${index + 1}`,
		]);
		database.run(
			"INSERT INTO snapshot_captures(id,scope_id,operation_id,tree_hash,snapshot_commit_sha,coverage,temporal_consistency,policy_version,manifest_blob_digest,started_at,finished_at) VALUES (?,?,?,?,?,'complete','platform_quiescent',1,?,'now','now')",
			[`capture-${index}`, scopeId, operationId, member.tree, member.snapshot, digest],
		);
		database.run(
			"INSERT INTO file_attributions(id,device_id,workspace_path,file_path,narrator_id,action,operation_id,effect_id,scope_id,changed_at) VALUES (?,'local',?,'file.txt',?,'edit',?,?,?,'now')",
			[`attribution-${index}`, member.path, member.narratorId, operationId, effectId, scopeId],
		);
	}
	const value = await prepareLegacyRetainedHistory(input, { assertLinkedAdmissionReady: () => {} });
	expect(value.reason).toBeUndefined();
	expect(value.status).toBe("retained");
	expect(value.manifest.references.file_change_blobs).toHaveLength(2);
	for (const [index, member] of fixture.members.entries())
		for (const [table, id] of [
			["file_change_scopes", `linked-scope-${index}`],
			["file_change_operations", `linked-operation-${index}`],
			["file_change_effects", `linked-effect-${index}`],
			["snapshot_captures", `capture-${index}`],
		])
			expect(
				value.manifest.historyOrigins.find((origin) => origin.table === table && origin.id === id)
					?.workspacePath,
			).toBe(member.path);
	for (const blob of blobs) expect(readFileSync(blob.path).equals(blob.bytes)).toBe(true);
	// Swap only the scope pointer while keeping operation/tool source immutable.
	database.run(
		"UPDATE file_change_effects SET scope_id='linked-scope-1' WHERE id='linked-effect-0'",
	);
	expect(
		(await prepareLegacyRetainedHistory(input, { assertLinkedAdmissionReady: () => {} })).reason,
	).toContain("shared scope/effect");
});

test("linked root0 snapshot membership is used when a message has no tool origin, not its narrator current cwd", async () => {
	await twoLinkedFixture();
	database.run("DELETE FROM narrator_tool_calls WHERE id='linked-tool-1'");
	database.run(
		"UPDATE narrator_messages SET tree_hash_after=?,snapshot_commit_sha=? WHERE id='linked-message-1'",
		[tree, snapshot],
	);
	const value = await prepareLegacyRetainedHistory(input, { assertLinkedAdmissionReady: () => {} });
	expect(value.reason).toBeUndefined();
	const origin = value.manifest.historyOrigins.find(
		(entry) => entry.table === "narrator_messages" && entry.id === "linked-message-1",
	);
	expect(origin?.workspacePath).toBe(input.mainCheckoutRoot);
	expect(origin?.evidence).toBe("snapshot_membership");
});

test("linked unverified subdirectories, stale Git registration proof and noneligible source states remain unknown", async () => {
	const fixture = await twoLinkedFixture();
	database.run("UPDATE chapters SET status='merged' WHERE id=?", [fixture.members[0].id]);
	expect(
		(await prepareLegacyRetainedHistory(input, { assertLinkedAdmissionReady: () => {} })).status,
	).toBe("unknown");
	database.run("UPDATE chapters SET status='dormant' WHERE id=?", [fixture.members[0].id]);
	const sub = join(fixture.members[0].path, "subdir");
	mkdirSync(sub);
	database.run("UPDATE narrators SET cwd=? WHERE id=?", [sub, fixture.members[0].narratorId]);
	expect(
		(await prepareLegacyRetainedHistory(input, { assertLinkedAdmissionReady: () => {} })).status,
	).toBe("unknown");
	database.run("UPDATE narrators SET cwd=? WHERE id=?", [
		fixture.members[0].path,
		fixture.members[0].narratorId,
	]);
	// A fresh extra registration changes the common inventory: old serialized proof is not an admission.
	git(fixture.root, [
		"worktree",
		"add",
		"-b",
		"unselected-branch",
		join(directory, "unselected-worktree"),
		commit,
	]);
	expect(
		(await prepareLegacyRetainedHistory(input, { assertLinkedAdmissionReady: () => {} })).status,
	).toBe("unknown");
});

test("healthy same-family scope incarnations are retained without truncating source-scope membership", async () => {
	const fixture = await twoLinkedFixture();
	const member = fixture.members[0];
	const stat = lstatSync(member.path, { bigint: true });
	const ids: string[] = [];
	for (let index = 0; index < 150; index++) {
		const id = `scope-${index}-${"a".repeat(512)}`;
		ids.push(id);
		database.run(
			"INSERT INTO file_change_scopes(id,source_instance_id,device_id,workspace_instance_id,canonical_root,display_root,path_flavor,status,root_identity_json,created_at,updated_at) VALUES (?,'instance','local',?,?,?,'posix','active',?,'now','now')",
			[
				id,
				`workspace-${index}`,
				member.path,
				member.path,
				JSON.stringify({ object: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` }),
			],
		);
	}
	const value = await prepareLegacyRetainedHistory(input, { assertLinkedAdmissionReady: () => {} });
	expect(value.reason).toBeUndefined();
	expect(value.status).toBe("retained");
	expect(value.manifest.references.file_change_scopes).toHaveLength(150);
	const actual = value.manifest.historyOrigins
		.filter(
			(origin) => origin.table === "file_change_scopes" && origin.workspacePath === member.path,
		)
		.map((origin) => origin.id)
		.sort();
	expect(actual).toEqual(ids.sort());
	expect(Buffer.byteLength(JSON.stringify(actual))).toBeGreaterThan(64 * 1024);
});

test("scope identity bounds are explicit rather than hiding oversized ids in an archival membership array", async () => {
	const fixture = await twoLinkedFixture();
	const member = fixture.members[0];
	const stat = lstatSync(member.path, { bigint: true });
	database.run(
		"INSERT INTO file_change_scopes(id,source_instance_id,device_id,workspace_instance_id,canonical_root,display_root,path_flavor,status,root_identity_json,created_at,updated_at) VALUES (?,'instance','local','workspace',?,?,'posix','active',?,'now','now')",
		[
			"s".repeat(1025),
			member.path,
			member.path,
			JSON.stringify({ object: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` }),
		],
	);
	const value = await prepareLegacyRetainedHistory(input, { assertLinkedAdmissionReady: () => {} });
	expect(value.status).toBe("unknown");
	expect(value.reason).toContain("oversized scope identity");
});

test("linked results need a trusted admission callback, not a DTO-ready flag or cloned native proof", async () => {
	await twoLinkedFixture();
	expect((await prepareLegacyRetainedHistory(input)).reason).toContain("trusted admission");
	expect(inspectLegacyRetainedHistoryReadonly(input).reason).toContain("fresh native worker probe");
	const value = await prepareLegacyRetainedHistory(input, {
		assertLinkedAdmissionReady: () => {
			throw new Error("consumers not ready");
		},
	});
	expect(value.status).toBe("unknown");
});

test("linked admission capability cannot disappear between worker start and publication", async () => {
	await twoLinkedFixture();
	const options: { assertLinkedAdmissionReady?: () => void } = {};
	options.assertLinkedAdmissionReady = () => {
		options.assertLinkedAdmissionReady = undefined;
	};
	const value = await prepareLegacyRetainedHistory(input, options);
	expect(value.status).toBe("unknown");
	expect(value.reason).toContain("guard changed during prepare");
});

test("wrong chapter/workspace and real/shadow bindings fail closed rather than borrowing sibling history", async () => {
	const fixture = await twoLinkedFixture();
	const first = fixture.bindings.find((binding) => binding.kind === "linked");
	if (!first) throw new Error("fixture missing linked binding");
	const old = first.sourceChapterId;
	first.sourceChapterId = "c";
	expect(
		(await prepareLegacyRetainedHistory(input, { assertLinkedAdmissionReady: () => {} })).status,
	).toBe("unknown");
	first.sourceChapterId = old;
	database.run("UPDATE chapters SET snapshot_commit_sha=? WHERE id=?", [
		fixture.members[1].snapshot,
		fixture.members[0].id,
	]);
	const value = await prepareLegacyRetainedHistory(input, { assertLinkedAdmissionReady: () => {} });
	expect(value.status).toBe("unknown");
	expect(value.reason).toContain("correct repository namespace");
});

test("linked message origin uses immutable original tool target even when its narrator is currently elsewhere", async () => {
	await twoLinkedFixture();
	database.run(
		"UPDATE narrator_tool_calls SET execution_origin_tool_call_id='t',execution_identity_version=1,execution_cwd=? WHERE id='linked-tool-1'",
		[input.mainCheckoutRoot],
	);
	database.run(
		"UPDATE narrator_messages SET tree_hash_after=?,snapshot_commit_sha=? WHERE id='linked-message-1'",
		[tree, snapshot],
	);
	database.run(
		"UPDATE narrator_tool_calls SET tree_hash_before=?,tree_hash_after=? WHERE id='linked-tool-1'",
		[tree, tree],
	);
	const value = await prepareLegacyRetainedHistory(input, { assertLinkedAdmissionReady: () => {} });
	expect(value.reason).toBeUndefined();
	expect(
		value.manifest.narratorOrigins.find((origin) => origin.narratorId === "linked-n-1")
			?.workspacePath,
	).not.toBe(input.mainCheckoutRoot);
	expect(
		value.manifest.historyOrigins.find(
			(origin) => origin.table === "narrator_messages" && origin.id === "linked-message-1",
		)?.workspacePath,
	).toBe(input.mainCheckoutRoot);
});

test("linked external refs and ambiguous same-root scopes stay unknown", async () => {
	const fixture = await twoLinkedFixture();
	database.run(
		"INSERT INTO narrators(id,cwd,owner_user_id,visibility,write_audience,created_at,updated_at) VALUES ('external-history',?,'u','private','owner','now','now')",
		[input.mainCheckoutRoot],
	);
	database.run(
		"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES ('external-ref','external-history','linked-message-1',0)",
	);
	expect(
		(await prepareLegacyRetainedHistory(input, { assertLinkedAdmissionReady: () => {} })).reason,
	).toContain("external shared narrator");
	database.run("DELETE FROM narrator_message_refs WHERE id='external-ref'");
	const member = fixture.members[0];
	const stat = lstatSync(member.path, { bigint: true });
	for (const id of ["scope-one", "scope-two"])
		database.run(
			"INSERT INTO file_change_scopes(id,source_instance_id,device_id,workspace_instance_id,canonical_root,display_root,path_flavor,status,root_identity_json,created_at,updated_at) VALUES (?,?,'local',?,?,?,'posix','active',?,'now','now')",
			[
				id,
				id === "scope-one" ? "fixture" : "foreign-source-instance",
				id,
				member.path,
				member.path,
				JSON.stringify({ object: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` }),
			],
		);
	expect(
		(await prepareLegacyRetainedHistory(input, { assertLinkedAdmissionReady: () => {} })).reason,
	).toContain("shared/ambiguous physical scope");
});

test("malformed worker evidence and unconfirmed exit fail closed", async () => {
	const worker = new EventEmitter() as EventEmitter & { terminate: () => Promise<number> };
	worker.terminate = () => new Promise(() => {});
	const result = collectLegacyRetainedHistoryWorker(worker as unknown as Worker, input, 100, 1);
	worker.emit("message", {
		status: "retained",
		digest: "a".repeat(64),
		complete: true,
		guards: [null],
	});
	expect((await result).reason).toContain("exit unconfirmed");
});

test("worker waits for confirmed exit even after valid retained evidence", async () => {
	const evidence = inspect();
	expect(evidence.status).toBe("retained");
	const worker = new EventEmitter() as EventEmitter & { terminate: () => Promise<number> };
	worker.terminate = async () => {
		throw new Error("unexpected terminate");
	};
	let resolved = false;
	const result = collectLegacyRetainedHistoryWorker(worker as unknown as Worker, input, 100).then(
		(value) => {
			resolved = true;
			return value;
		},
	);
	worker.emit("message", evidence);
	await Promise.resolve();
	expect(resolved).toBe(false);
	worker.emit("exit", 0);
	expect((await result).status).toBe("retained");
});

test("worker evidence does not authorize prepare until successful exit; exit race fails closed", async () => {
	const evidence = inspect();
	expect(evidence.status).toBe("retained");
	const worker = new EventEmitter() as EventEmitter & { terminate: () => Promise<number> };
	worker.terminate = async () => {
		worker.emit("exit", 1);
		return 1;
	};
	const result = collectLegacyRetainedHistoryWorker(worker as unknown as Worker, input, 100);
	worker.emit("message", evidence);
	worker.emit("exit", 1);
	expect((await result).status).toBe("unknown");
});
