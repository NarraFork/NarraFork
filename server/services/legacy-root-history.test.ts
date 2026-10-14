import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Worker } from "node:worker_threads";
import { applyPendingMigrationsByHash } from "../db/run-migrations";
import { collectLegacyRootHistoryWorker, inspectLegacyRootHistory } from "./legacy-root-history";
import {
	LEGACY_ROOT_CHAPTER_POINTERS,
	LEGACY_ROOT_HISTORY_COLUMNS,
	LEGACY_ROOT_HISTORY_LIMITS,
	type LegacyRootHistoryInput,
} from "./legacy-root-history-contract";
import { inspectLegacyRootHistoryReadonly } from "./legacy-root-history-validator";
import { treeSnapshotKey } from "./tree-snapshot-paths";

let templateDirectory: string;
let directory: string;
let input: LegacyRootHistoryInput;
let database: Database;

beforeAll(() => {
	templateDirectory = mkdtempSync(join(tmpdir(), "nf-root-history-schema-"));
	const template = new Database(join(templateDirectory, "template.db"));
	applyPendingMigrationsByHash(template, resolve("drizzle"));
	template.close();
});
afterAll(() => rmSync(templateDirectory, { recursive: true, force: true }));
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "nf-root-history-fixture-"));
	const databasePath = join(directory, "history.db");
	copyFileSync(join(templateDirectory, "template.db"), databasePath);
	database = new Database(databasePath);
	database.exec("PRAGMA foreign_keys=OFF");
	database.run(
		"INSERT INTO chapters (id, project_id, title, branch, base_branch, created_at, updated_at) VALUES ('c', 'p', 'root', 'main', 'main', 'now', 'now')",
	);
	database.run(
		"INSERT INTO narrators (id, chapter_id, created_at, updated_at) VALUES ('n', 'c', 'now', 'now')",
	);
	input = {
		databasePath,
		projectId: "p",
		chapterIds: ["c"],
		narratorIds: ["n"],
		workspacePaths: [join(directory, "repo")],
		snapshotShadowKeys: [],
		shadowDirectories: [join(directory, "shadow")],
	};
});
afterEach(() => {
	try {
		database.close();
	} catch {}
	rmSync(directory, { recursive: true, force: true });
});
function inspect() {
	database.close();
	return inspectLegacyRootHistoryReadonly(input);
}
function message(id = "m", owner = "n") {
	database.run(
		"INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES (?, ?, 'user', '[]', 'now')",
		[id, owner],
	);
}
function ref(id = "m") {
	database.run(
		"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, 'n', ?, 0)",
		[`ref-${id}`, id],
	);
}

// Every fixture is a real on-disk SQLite database built from repository migrations.
test("empty conversation returns stable digest, guard counters and makes no database/shadow writes", async () => {
	message();
	ref();
	database.run(
		"UPDATE narrators SET message_version=3, message_structure_version=4, next_seq=5 WHERE id='n'",
	);
	database.close();
	const before = readFileSync(input.databasePath);
	const first = await inspectLegacyRootHistory(input);
	expect(first.status).toBe("empty");
	expect(first.guards).toEqual([
		{ id: "n", messageVersion: 3, messageStructureVersion: 4, nextSeq: 5 },
	]);
	const second = await inspectLegacyRootHistory(input);
	expect(second.digest).toBe(first.digest);
	expect(readFileSync(input.databasePath)).toEqual(before);
});

test("sync disable/tombstone writes and transient WAL files do not change scoped history proof", async () => {
	database.run(
		"INSERT INTO projects (id,name,created_at,updated_at) VALUES ('p','project','now','now')",
	);
	message();
	ref();
	const shadow = input.shadowDirectories[0];
	mkdirSync(join(shadow, "objects", "pack"), { recursive: true });
	mkdirSync(join(shadow, "refs", "heads"), { recursive: true });
	database.close();
	const before = await inspectLegacyRootHistory(input);
	expect(before.status).toBe("empty");
	database = new Database(input.databasePath);
	database.exec("PRAGMA journal_mode=WAL");
	database.run("UPDATE projects SET legacy_sync_disabled=1 WHERE id='p'");
	database.run(
		"INSERT INTO legacy_project_sync_tombstones (canonical_root,disabled_project_id,disabled_at) VALUES (?,'p','now')",
		[input.workspacePaths[0]],
	);
	const disabled = await inspectLegacyRootHistory(input);
	expect(disabled.status).toBe("empty");
	expect(disabled.digest).toBe(before.digest);
	expect(disabled.guards).toEqual(before.guards);
	database.run("UPDATE narrators SET message_version=message_version+1 WHERE id='n'");
	const changed = await inspectLegacyRootHistory(input);
	expect(changed.status).toBe("empty");
	expect(changed.digest).not.toBe(disabled.digest);
	expect(changed.guards?.[0].messageVersion).toBe(1);
	database.close();
	const checkpointed = await inspectLegacyRootHistory(input);
	expect(checkpointed.status).toBe("empty");
	expect(checkpointed.digest).toBe(changed.digest);
});

for (const pointer of LEGACY_ROOT_CHAPTER_POINTERS) {
	test(`chapter pointer ${pointer} cannot be empty`, () => {
		database.run(`UPDATE chapters SET ${pointer}='pointer' WHERE id='c'`);
		expect(inspect().status).toBe("history");
	});
}

for (const pointer of ["commit_sha", "tree_hash_after", "snapshot_commit_sha"]) {
	test(`shared ref ${pointer} is checked independently of original message owner`, () => {
		message("shared", "other-owner");
		ref("shared");
		database.run(`UPDATE narrator_messages SET ${pointer}='sha' WHERE id='shared'`);
		expect(inspect().status).toBe("history");
	});
}

test("shared message tool-call dependency is checked by message_id, not narrator owner", () => {
	message("shared", "other-owner");
	ref("shared");
	database.run(
		"INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, created_at, tree_hash_before) VALUES ('t','other-owner','shared','use','Bash','now','before')",
	);
	expect(inspect().status).toBe("history");
});

test("lazy inheritance ancestors are inspected and all guarded", () => {
	database.run(
		"INSERT INTO narrators (id, created_at, updated_at, message_version, next_seq) VALUES ('ancestor','now','now',7,9)",
	);
	database.run("UPDATE narrators SET refs_inherited_from='ancestor' WHERE id='n'");
	message("a", "ancestor");
	const result = inspect();
	expect(result.status).toBe("empty");
	expect(result.guards?.map((guard) => guard.id)).toEqual(["ancestor", "n"]);
	expect(result.guards?.[0].messageVersion).toBe(7);
});

test("history in lazy inheritance ancestors fails closed", () => {
	database.run(
		"INSERT INTO narrators (id, created_at, updated_at) VALUES ('ancestor','now','now')",
	);
	database.run("UPDATE narrators SET refs_inherited_from='ancestor' WHERE id='n'");
	message("a", "ancestor");
	database.run("UPDATE narrator_messages SET snapshot_commit_sha='sha' WHERE id='a'");
	expect(inspect().status).toBe("history");
});

for (const ancestor of ["n", "missing"]) {
	test(`cyclic or missing lazy ancestor ${ancestor} is unknown`, () => {
		database.run("UPDATE narrators SET refs_inherited_from=? WHERE id='n'", [ancestor]);
		expect(inspect().status).toBe("unknown");
	});
}

test("dangling shared refs are unknown", () => {
	ref("missing");
	expect(inspect().status).toBe("unknown");
});

test("per-file original content is history without selecting its contents", () => {
	database.run(
		"INSERT INTO narrator_file_snapshots (id,narrator_id,file_path,original_content,created_at) VALUES ('original','n','/file',?,'now')",
		["x".repeat(1024 * 1024)],
	);
	expect(inspect().status).toBe("history");
});

test("legacy patch on shared message is history", () => {
	message("shared", "other-owner");
	ref("shared");
	database.run(
		"INSERT INTO narrator_patches (id,narrator_id,message_id,tool_use_id,before_hash,after_hash,files_json,created_at) VALUES ('patch','other-owner','shared','use','before','after','[]','now')",
	);
	expect(inspect().status).toBe("history");
});

test("workspace tree index covers foreign device and canonical shadow key paths", () => {
	input.snapshotShadowKeys = ["remote\0/remote/repo"];
	database.run(
		"INSERT INTO worktree_tree_snapshots (id,device_id,worktree_path,tree_hash,created_at) VALUES ('snapshot','remote','/remote/repo','tree','now')",
	);
	expect(inspect().status).toBe("history");
});

test("matching file change scope with capture/effects cannot authorize empty", () => {
	database.run(
		"INSERT INTO file_change_scopes (id,source_instance_id,device_id,workspace_instance_id,canonical_root,display_root,path_flavor,created_at,updated_at) VALUES ('scope','instance','local','workspace',?,?,'posix','now','now')",
		[input.workspacePaths[0], input.workspacePaths[0]],
	);
	database.run(
		"INSERT INTO snapshot_captures (id,scope_id,tree_hash,policy_version,started_at) VALUES ('capture','scope','tree',1,'now')",
	);
	expect(inspect().status).toBe("history");
});

test("external attribution/effect evidence on workspace is history", () => {
	database.run(
		"INSERT INTO file_attributions (id,workspace_path,file_path,action,changed_at) VALUES ('attr',?,'file','external','now')",
		[input.workspacePaths[0]],
	);
	expect(inspect().status).toBe("history");
});

for (const [table, columns] of Object.entries(LEGACY_ROOT_HISTORY_COLUMNS)) {
	test(`missing required table ${table} is unknown`, () => {
		database.exec(`DROP TABLE ${table}`);
		expect(inspect().status).toBe("unknown");
	});
	test(`missing required column in ${table} is unknown`, () => {
		// Replace only this temporary fixture table to avoid unrelated FK/index constraints.
		database.exec(`DROP TABLE ${table}; CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
		expect(columns.length).toBeGreaterThan(1);
		expect(inspect().status).toBe("unknown");
	});
}

test("total rows budget applies across keyset pages, not merely to matching rows", () => {
	for (let n = 0; n < 180; n++) {
		database.run(
			"INSERT INTO worktree_tree_snapshots (id,worktree_path,tree_hash,created_at) VALUES (?, '/unrelated', ?, 'now')",
			[String(n).padStart(4, "0"), `tree-${n}`],
		);
	}
	database.close();
	expect(
		inspectLegacyRootHistoryReadonly(input, { ...LEGACY_ROOT_HISTORY_LIMITS, rows: 100 }).status,
	).toBe("unknown");
});

test("bytes and elapsed-time budgets fail closed", () => {
	database.close();
	expect(
		inspectLegacyRootHistoryReadonly(input, { ...LEGACY_ROOT_HISTORY_LIMITS, bytes: 1 }).status,
	).toBe("unknown");
	expect(
		inspectLegacyRootHistoryReadonly(input, { ...LEGACY_ROOT_HISTORY_LIMITS, milliseconds: -1 })
			.status,
	).toBe("unknown");
});

for (const layout of ["loose", "pack", "ref", "packed"]) {
	test(`physical shadow ${layout} history is never empty`, () => {
		const shadow = input.shadowDirectories[0];
		mkdirSync(shadow);
		if (layout === "loose") {
			mkdirSync(join(shadow, "objects", "ab"), { recursive: true });
			writeFileSync(join(shadow, "objects", "ab", "c".repeat(38)), "object");
		} else if (layout === "pack") {
			mkdirSync(join(shadow, "objects", "pack"), { recursive: true });
			writeFileSync(join(shadow, "objects", "pack", `pack-${"a".repeat(40)}.pack`), "PACK");
		} else if (layout === "ref") {
			mkdirSync(join(shadow, "refs", "heads"), { recursive: true });
			writeFileSync(join(shadow, "refs", "heads", "main"), `${"a".repeat(40)}\n`);
		} else writeFileSync(join(shadow, "packed-refs"), `${"a".repeat(40)} refs/heads/main\n`);
		expect(inspect().status).toBe("history");
	});
}

test("strictly empty objects/pack/refs and comment-only packed-refs are empty", () => {
	const shadow = input.shadowDirectories[0];
	mkdirSync(join(shadow, "objects", "pack"), { recursive: true });
	mkdirSync(join(shadow, "objects", "info"));
	mkdirSync(join(shadow, "refs", "heads"), { recursive: true });
	writeFileSync(join(shadow, "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(join(shadow, "packed-refs"), "# pack-refs with: peeled fully-peeled sorted\n");
	expect(inspect().status).toBe("empty");
});

test("shadow symlink and symlink ancestor are unknown", () => {
	mkdirSync(join(directory, "actual"));
	symlinkSync(join(directory, "actual"), input.shadowDirectories[0]);
	expect(inspect().status).toBe("unknown");
});

test("unreadable/unsupported physical identity is unknown, not missing", () => {
	mkdirSync(input.shadowDirectories[0]);
	mkdirSync(join(input.shadowDirectories[0], "packed-refs"));
	expect(inspect().status).toBe("unknown");
});

test("filesystem total-entry budget caps empty loose object fanout", () => {
	const shadow = input.shadowDirectories[0];
	mkdirSync(join(shadow, "objects"), { recursive: true });
	for (let n = 0; n < 100; n++) mkdirSync(join(shadow, "objects", n.toString(16).padStart(2, "0")));
	database.close();
	expect(
		inspectLegacyRootHistoryReadonly(input, {
			...LEGACY_ROOT_HISTORY_LIMITS,
			filesystemEntries: 16,
		}).status,
	).toBe("unknown");
});

test("exclusive SQLite lock fails closed without busy-waiting", async () => {
	database.exec("BEGIN EXCLUSIVE");
	const started = performance.now();
	const result = await inspectLegacyRootHistory(input);
	expect(result.status).toBe("unknown");
	expect(performance.now() - started).toBeLessThan(2_000);
	database.exec("ROLLBACK");
});

class Reader extends EventEmitter {
	terminateCalls = 0;
	terminate() {
		this.terminateCalls++;
		return new Promise<number>(() => {});
	}
}
function asWorker(reader: Reader) {
	return reader as unknown as Pick<Worker, "once" | "terminate">;
}
const empty = { status: "empty", digest: "a".repeat(64), guards: [] };

test("message alone is not evidence until worker exit is confirmed", async () => {
	const reader = new Reader();
	const result = collectLegacyRootHistoryWorker(asWorker(reader), input, 100, 10);
	reader.emit("message", empty);
	expect((await result).status).toBe("unknown");
	expect(reader.terminateCalls).toBe(1);
});

test("fake blocking worker times out fail closed", async () => {
	const reader = new Reader();
	expect((await collectLegacyRootHistoryWorker(asWorker(reader), input, 5, 5)).status).toBe(
		"unknown",
	);
});

test("two-worker limit also holds across module reloads", async () => {
	database.close();
	const a = inspectLegacyRootHistory(input);
	const b = inspectLegacyRootHistory(input);
	const reloadPath = `${import.meta.dir}/legacy-root-history.ts?history-reload-test`;
	const reload = await import(reloadPath);
	const third = await reload.inspectLegacyRootHistory(input);
	expect(third.status).toBe("unknown");
	expect(third.reason).toContain("capacity");
	expect((await a).status).toBe("empty");
	expect((await b).status).toBe("empty");
});

test("omitted chapter narrator and uninspected chapter shadow key are unknown", () => {
	input.narratorIds = [];
	expect(inspect().status).toBe("unknown");
});

test("real worker preserves complete treeSnapshotKey past embedded NUL", async () => {
	const key = treeSnapshotKey("local", input.workspacePaths[0]);
	expect(key).toContain("\0");
	input.snapshotShadowKeys = [key];
	database.run("UPDATE chapters SET snapshot_shadow_key=? WHERE id='c'", [key]);
	expect(
		database
			.query<{ key: string }, []>("SELECT snapshot_shadow_key AS key FROM chapters WHERE id='c'")
			.get()?.key,
	).toBe(key);
	database.close();
	const result = await inspectLegacyRootHistory(input);
	expect(result.status).toBe("empty");
	expect(result.guards?.map((guard) => guard.id)).toEqual(["n"]);
});

test("matching device prefix never authorizes a different NUL-delimited shadow path", async () => {
	const actual = treeSnapshotKey("local", input.workspacePaths[0]);
	input.snapshotShadowKeys = [treeSnapshotKey("local", join(directory, "different-repo"))];
	database.run("UPDATE chapters SET snapshot_shadow_key=? WHERE id='c'", [actual]);
	database.close();
	const result = await inspectLegacyRootHistory(input);
	expect(result.status).toBe("unknown");
	expect(result.reason).toContain("uninspected chapter shadow key");
});

test("oversized NUL-delimited shadow key is unknown rather than SQL NULL", () => {
	database.run("UPDATE chapters SET snapshot_shadow_key=? WHERE id='c'", [
		`local\0/${"x".repeat(9000)}`,
	]);
	const result = inspect();
	expect(result.status).toBe("unknown");
	expect(result.reason).toContain("oversized chapter shadow key");
});

test("uninspected persisted shadow key is unknown", () => {
	database.run(
		"UPDATE chapters SET snapshot_shadow_key='local' || char(0) || '/uninspected' WHERE id='c'",
	);
	expect(inspect().status).toBe("unknown");
});

test("orphan capture cannot be interpreted as absence of history", () => {
	database.run(
		"INSERT INTO snapshot_captures (id,scope_id,policy_version,started_at) VALUES ('orphan','missing',1,'now')",
	);
	expect(inspect().status).toBe("unknown");
});

test("orphan per-file effect cannot be interpreted as absence of history", () => {
	database.run(
		"INSERT INTO file_change_effects (id,operation_id,scope_id,file_key,identity_json,scope_revision,mutation_id,request_digest,phase,before_state_json,intended_after_state_json,observed_after_state_json,created_at,updated_at) VALUES ('effect','missing-operation','missing-scope','file','{}',1,'mutation','digest','apply','{}','{}','{}','now','now')",
	);
	expect(inspect().status).toBe("unknown");
});

test("empty history row identities cannot hide behind the first keyset cursor", () => {
	database.run(
		"INSERT INTO worktree_tree_snapshots (id,worktree_path,tree_hash,created_at) VALUES ('','/other','tree','now')",
	);
	expect(inspect().status).toBe("unknown");
});

test("worker error and malformed output fail closed", async () => {
	for (const event of ["error", "message"]) {
		const reader = new Reader();
		const result = collectLegacyRootHistoryWorker(asWorker(reader), input, 100, 5);
		reader.emit(event, event === "error" ? new Error("EACCES") : { status: "empty" });
		expect((await result).status).toBe("unknown");
	}
});
