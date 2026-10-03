import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NARRATOR_BACKUP_LIMITS as LIMITS, type NarratorBackupJob } from "@shared/narrator-backup";
import { readNarratorBackupArtifact } from "./artifact";
import { BACKUP_TABLES, type BackupTable, backupColumns } from "./contract";
import { NarratorBackupJobs } from "./jobs";
import { boundedBackupGit, gitOid, sha256 } from "./objects";
import { createOfflineBackupFixture } from "./offline-fixture";
import { installProductionBackupAccessTables } from "./production-fixture.test-helper";
import { createSqliteNarratorBackupMainStore } from "./sqlite-main-store";
import { collectBackupState } from "./state";
import { type BackupWorkerConfig, type BackupWorkerRequest, runBackupWorker } from "./worker";

const dirs: string[] = [];
const handles: Database[] = [];
afterEach(async () => {
	for (const db of handles.splice(0)) db.close();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const actor = { userId: "alice", isAdmin: false };
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "nf-backup-fixture-"));
	dirs.push(root);
	const databasePath = join(root, "source.sqlite");
	const db = new Database(databasePath, { create: true });
	handles.push(db);
	db.run("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
	db.run(
		"CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT); INSERT INTO users VALUES('alice','user'),('bob','user');",
	);
	installProductionBackupAccessTables(db);
	for (const table of Object.keys(BACKUP_TABLES) as BackupTable[]) {
		const constraints =
			table === "narrator_message_refs"
				? ",FOREIGN KEY(narrator_id) REFERENCES narrators(id),FOREIGN KEY(message_id) REFERENCES narrator_messages(id),UNIQUE(narrator_id,message_id)"
				: table === "narrator_messages"
					? ",FOREIGN KEY(narrator_id) REFERENCES narrators(id)"
					: table === "narrator_worktree_resources"
						? ",UNIQUE(device_id,worktree_path)"
						: "";
		const number = new Set([
			"seq",
			"is_compact",
			"next_seq",
			"refs_backfill_cursor",
			"workspace_revision",
			"enabled",
			"is_background",
			"execution_attempt",
			"execution_identity_version",
			"is_binary",
			"deleted",
		]);
		db.run(
			`CREATE TABLE ${table} (${backupColumns(table)
				.map(
					(column) =>
						`${column} ${column === "id" ? "TEXT PRIMARY KEY" : number.has(column) ? "INTEGER" : "TEXT"}`,
				)
				.join(",")}${constraints})`,
		);
	}
	db.run(
		"CREATE TABLE file_change_effects(id TEXT,operation_id TEXT,before_blob_digest TEXT,intended_after_blob_digest TEXT,observed_after_blob_digest TEXT)",
	);
	const now = "2026-10-03T00:00:00Z";
	db.prepare(
		"INSERT INTO narrators(id,type,title,owner_user_id,visibility,write_audience,status,traits,variant,cwd,workspace_context,workspace_revision,created_at,updated_at,next_seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		"solo",
		"primary",
		"private conversation",
		"alice",
		"private",
		"owner",
		"working",
		"[]",
		"primary",
		join(root, "workspace"),
		JSON.stringify({
			revision: 7,
			deviceId: "local",
			cwd: join(root, "workspace"),
			contextKey: "ctx",
		}),
		7,
		now,
		now,
		9,
	);
	db.prepare(
		"INSERT INTO narrator_messages(id,narrator_id,role,content_json,created_at) VALUES(?,?,?,?,?)",
	).run(
		"message",
		"solo",
		"assistant",
		JSON.stringify([{ type: "text", text: "sensitive transcript" }]),
		now,
	);
	db.run(
		"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq,is_compact) VALUES('ref','solo','message',8,1)",
	);
	db.prepare(
		"INSERT INTO narrator_tool_calls(id,narrator_id,message_id,tool_use_id,tool_name,status,input_json,execution_identity_version,execution_attempt,execution_device_id,execution_cwd,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		"tool",
		"solo",
		"message",
		"use",
		"Bash",
		"pending",
		'{"command":"never-run-this"}',
		2,
		1,
		"local",
		join(root, "workspace"),
		now,
	);
	const config: BackupWorkerConfig = {
		backend: "sqlite",
		databasePath,
		sourceInstanceId: randomUUID(),
		objectSource: {
			shadowRoot: join(root, "tree-snapshots"),
			uploadsRoot: join(root, "uploads"),
			blobRoot: join(root, "file-change-blobs"),
			journalRoot: join(root, "worktree-requests"),
		},
	};
	const request = (overrides: Partial<BackupWorkerRequest> = {}): BackupWorkerRequest => ({
		action: "export",
		config,
		actor,
		narratorIds: ["solo"],
		profile: "conversation-state-v1",
		stagingPath: join(root, "archive.staging"),
		artifactPath: join(root, "archive.sqlite"),
		artifactId: "artifact",
		cancellation: new SharedArrayBuffer(4),
		deadline: Date.now() + LIMITS.jobMs,
		...overrides,
	});
	return { root, db, config, request };
}
function deleteConversation(db: Database) {
	db.run(
		"DELETE FROM narrator_tool_calls; DELETE FROM narrator_message_refs; DELETE FROM narrator_messages; DELETE FROM narrators",
	);
}

test("pure standalone archive roundtrip preserves IDs/content/seq/ACL and restores only archived history", async () => {
	const { db, config, request } = await fixture();
	const before = JSON.stringify(db.prepare("SELECT * FROM narrators").all());
	const result = (await runBackupWorker(request())) as { digest: string };
	expect(JSON.stringify(db.prepare("SELECT * FROM narrators").all())).toBe(before);
	const artifact = readNarratorBackupArtifact(request().artifactPath ?? "", () => {});
	expect(artifact.manifest.narratorIds).toEqual(["solo"]);
	expect(artifact.state.rows.narrators?.[0]?.chapter_id).toBeNull();
	expect(artifact.state.rows.narrators?.[0]?.context_project_id).toBeNull();
	deleteConversation(db);
	const preview = (await runBackupWorker(
		request({ action: "preview", expectedDigest: result.digest }),
	)) as { sameInstanceStateRestoreAllowed: boolean };
	expect(preview.sameInstanceStateRestoreAllowed).toBe(true);
	await runBackupWorker(request({ action: "restore", expectedDigest: result.digest }));
	const restored = db.prepare("SELECT * FROM narrators WHERE id='solo'").get() as Record<
		string,
		unknown
	>;
	expect(restored.status).toBe("archived");
	expect(restored.owner_user_id).toBe("alice");
	expect(restored.visibility).toBe("private");
	expect(restored.workspace_revision).toBe(7);
	expect(restored.permission_mode).toBe("readOnly");
	expect(db.prepare("SELECT seq,is_compact FROM narrator_message_refs").get()).toEqual({
		seq: 8,
		is_compact: 1,
	});
	expect(
		db
			.prepare(
				"SELECT execution_origin_tool_call_id,execution_attempt,status FROM narrator_tool_calls",
			)
			.get(),
	).toEqual({ execution_origin_tool_call_id: "tool", execution_attempt: 0, status: "fail" });
	expect(config.databasePath).not.toContain("/.narrafork/narrafork.db");
});

test("existing active/archived IDs reject, no skip-success and no partial import", async () => {
	const { db, request } = await fixture();
	const { digest } = (await runBackupWorker(request())) as { digest: string };
	const preview = (await runBackupWorker(
		request({ action: "preview", expectedDigest: digest }),
	)) as { blockers: string[] };
	expect(preview.blockers.join()).toContain("Existing object ID conflicts");
	await expect(
		runBackupWorker(request({ action: "restore", expectedDigest: digest })),
	).rejects.toThrow("blocked");
	deleteConversation(db);
	db.run(
		"CREATE TRIGGER reject_tool BEFORE INSERT ON narrator_tool_calls BEGIN SELECT RAISE(ABORT,'fixture import failure'); END",
	);
	await expect(
		runBackupWorker(request({ action: "restore", expectedDigest: digest })),
	).rejects.toThrow("fixture import failure");
	expect(db.prepare("SELECT id FROM narrators").all()).toEqual([]);
});

test("foreign source-ID spoof, wrong actor and tamper never acquire apply authority", async () => {
	const { db, config, request } = await fixture();
	const { digest } = (await runBackupWorker(request())) as { digest: string };
	deleteConversation(db);
	const foreign = (await runBackupWorker(request({ action: "preview" }))) as {
		verifiedSameInstance: boolean;
		blockers: string[];
		crossInstanceApplySupported: boolean;
	};
	expect(foreign.verifiedSameInstance).toBe(false);
	expect(foreign.crossInstanceApplySupported).toBe(false);
	expect(foreign.blockers.join()).toContain("mapping-required:users:alice");
	const mapped = (await runBackupWorker(
		request({
			action: "preview",
			mapping: {
				users: { alice: "bob" },
				paths: { [join((await fixture()).root, "workspace")]: "/unused" },
			},
		}),
	)) as { sameInstanceStateRestoreAllowed: boolean };
	expect(mapped.sameInstanceStateRestoreAllowed).toBe(false);
	await expect(
		runBackupWorker(
			request({
				action: "restore",
				actor: { userId: "bob", isAdmin: false },
				expectedDigest: digest,
			}),
		),
	).rejects.toThrow("blocked");
	const file = new Database(request().artifactPath ?? "");
	file.run(
		"UPDATE state_rows SET json=replace(json,'sensitive transcript','tampered transcript') WHERE table_name='narrator_messages'",
	);
	file.close();
	const tamper = (await runBackupWorker(
		request({ action: "preview", expectedDigest: digest }),
	)) as { verifiedSameInstance: boolean };
	expect(tamper.verifiedSameInstance).toBe(false);
	expect(config.sourceInstanceId).toBeTruthy();
});

test("multi-generation lazy inheritance/subagent/compact/spec are read-only and closure is individually authorized", async () => {
	const { db } = await fixture();
	db.run(
		"INSERT INTO narrators(id,type,owner_user_id,visibility,write_audience,status,parent_narrator_id,refs_inherited_from,refs_backfill_cursor,acl_root_narrator_id) VALUES('middle','primary','alice','private','owner','idle','solo','solo',8,NULL),('grand','primary','alice','private','owner','idle','middle','middle',5,NULL),('child','subagent',NULL,'private','owner','idle','grand',NULL,NULL,'grand')",
	);
	db.run(
		"INSERT INTO spec_namespaces(id,narrator_id) VALUES('ns','grand'); INSERT INTO spec_file_revisions(id,namespace_id,path,content,content_hash) VALUES('rev','ns','tasks.json','{\"tasks\":[{\"text\":\"do not continue\",\"status\":\"doing\",\"protected\":true}]}','hash'); INSERT INTO spec_namespace_files(id,namespace_id,path,revision_id,deleted) VALUES('sf','ns','tasks.json','rev',0); INSERT INTO spec_protected_tasks(id,namespace_id,text_hash,text,status) VALUES('pt','ns','hash','do not continue','doing')",
	);
	const source = JSON.stringify(db.prepare("SELECT * FROM narrators ORDER BY id").all());
	const store = createSqliteNarratorBackupMainStore(db);
	const state = await store.snapshot(() => collectBackupState(store, ["grand"], actor, () => {}));
	expect(state.rows.narrators?.map((r) => r.id).sort()).toEqual([
		"child",
		"grand",
		"middle",
		"solo",
	]);
	expect(state.rows.spec_file_revisions?.[0]?.id).toBe("rev");
	expect(JSON.stringify(db.prepare("SELECT * FROM narrators ORDER BY id").all())).toBe(source);
	db.run("UPDATE narrators SET owner_user_id='bob' WHERE id='solo'");
	await expect(
		store.snapshot(() => collectBackupState(store, ["grand"], actor, () => {})),
	).rejects.toThrow("owner/admin");
});

test("cancellation, timeout and required-column/row budgets fail before publication", async () => {
	const { db, request, root } = await fixture();
	const cancellation = new SharedArrayBuffer(4);
	Atomics.store(new Int32Array(cancellation), 0, 1);
	await expect(runBackupWorker(request({ cancellation }))).rejects.toThrow("cancelled");
	await expect(runBackupWorker(request({ deadline: Date.now() - 1 }))).rejects.toThrow("deadline");
	db.prepare("UPDATE narrator_messages SET content_json=? WHERE id='message'").run(
		JSON.stringify([{ type: "text", text: "x".repeat(LIMITS.rowBytes) }]),
	);
	await expect(runBackupWorker(request())).rejects.toThrow("budget");
	expect(await stat(join(root, "archive.sqlite")).catch(() => null)).toBeNull();
	db.run("ALTER TABLE narrators DROP COLUMN workspace_context");
	await expect(runBackupWorker(request())).rejects.toThrow("Required backup column");
});

async function writeGitObject(repo: string, kind: string, bytes: Buffer) {
	// Write immutable raw objects to the isolated bare fixture, never run git commit.
	const oid = gitOid(kind, bytes);
	const { deflateSync } = await import("node:zlib");
	await mkdir(join(repo, "objects", oid.slice(0, 2)), { recursive: true });
	await writeFile(
		join(repo, "objects", oid.slice(0, 2), oid.slice(2)),
		deflateSync(Buffer.concat([Buffer.from(`${kind} ${bytes.length}\0`), bytes])),
	);
	return oid;
}
function entry(mode: string, name: string, oid: string) {
	return Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, "hex")]);
}

test("tree-v1 restores actual offline recursive binaries, modes, deletions, DAG, uploads and file blobs without source repo", async () => {
	const { root, db, config, request } = await fixture();
	const cwd = join(root, "workspace");
	const key = createHash("sha256").update(`local\0${cwd}`).digest("hex").slice(0, 32);
	const repo = join(config.objectSource.shadowRoot, key);
	await mkdir(repo, { recursive: true });
	await boundedBackupGit(["init", "--bare", repo], new AbortController().signal);
	const binary = Buffer.from([0, 255, 1, 0, 128]);
	const blob = await writeGitObject(repo, "blob", binary);
	const executable = await writeGitObject(repo, "blob", Buffer.from("fixture executable\n"));
	const nested = await writeGitObject(repo, "tree", entry("100644", "binary.bin", blob));
	const first = await writeGitObject(
		repo,
		"tree",
		Buffer.concat([entry("40000", "nested", nested), entry("100755", "run.sh", executable)]),
	);
	const second = await writeGitObject(repo, "tree", entry("40000", "nested", nested));
	const baseCommit = await writeGitObject(
		repo,
		"commit",
		Buffer.from(
			`tree ${first}\nauthor Fixture <fixture@test> 0 +0000\ncommitter Fixture <fixture@test> 0 +0000\n\nbase\n`,
		),
	);
	const commit = await writeGitObject(
		repo,
		"commit",
		Buffer.from(
			`tree ${second}\nparent ${baseCommit}\nauthor Fixture <fixture@test> 1 +0000\ncommitter Fixture <fixture@test> 1 +0000\n\nsecond\n`,
		),
	);
	await mkdir(join(config.objectSource.uploadsRoot, "solo"), { recursive: true });
	await writeFile(join(config.objectSource.uploadsRoot, "solo", "image.png"), binary);
	await mkdir(join(config.objectSource.blobRoot, "sha256", sha256(binary).slice(0, 2)), {
		recursive: true,
	});
	await writeFile(
		join(config.objectSource.blobRoot, "sha256", sha256(binary).slice(0, 2), sha256(binary)),
		binary,
	);
	db.prepare(
		"UPDATE narrator_messages SET content_json=?,tree_hash_after=?,snapshot_commit_sha=?",
	).run(
		JSON.stringify([{ type: "image", imageId: "image", uploadNarratorId: "solo" }]),
		second,
		commit,
	);
	db.prepare(
		"UPDATE narrator_tool_calls SET tree_hash_before=?,tree_hash_after=?,file_change_operation_id='operation'",
	).run(first, second);
	db.prepare("INSERT INTO file_change_effects VALUES('effect','operation',?,NULL,?)").run(
		sha256(binary),
		sha256(binary),
	);
	await runBackupWorker(request({ profile: "conversation-tree-v1" }));
	await rm(config.objectSource.shadowRoot, { recursive: true, force: true });
	await rm(config.objectSource.uploadsRoot, { recursive: true, force: true });
	await rm(config.objectSource.blobRoot, { recursive: true, force: true });
	const offline = await createOfflineBackupFixture(request().artifactPath ?? "");
	try {
		await offline.apply(first);
		expect(await readFile(join(offline.workspace, "nested", "binary.bin"))).toEqual(binary);
		expect((await stat(join(offline.workspace, "run.sh"))).mode & 0o111).toBe(0o111);
		await offline.apply(second);
		expect(await stat(join(offline.workspace, "run.sh")).catch(() => null)).toBeNull();
		expect(offline.objectBytes("upload:solo:image")).toEqual(binary);
		expect(offline.objectBytes(`file-blob:${sha256(binary)}`)).toEqual(binary);
	} finally {
		await offline.dispose();
	}
	for (const [name, missing] of [
		["root", `git:${first}`],
		["blob", `git:${blob}`],
		["image", "upload:solo:image"],
		["file-blob", `file-blob:${sha256(binary)}`],
	] as const) {
		const damagedPath = join(root, `missing-${name}.sqlite`);
		await copyFile(request().artifactPath ?? "", damagedPath);
		const damaged = new Database(damagedPath);
		damaged.prepare("DELETE FROM objects WHERE key=?").run(missing);
		damaged.close();
		await expect(
			runBackupWorker(request({ action: "preview", artifactPath: damagedPath })),
		).rejects.toThrow("dependency");
		await expect(
			runBackupWorker(request({ action: "restore", artifactPath: damagedPath })),
		).rejects.toThrow("dependency");
	}
	const archive = new Database(request().artifactPath ?? "");
	archive.prepare("DELETE FROM objects WHERE key=?").run(`git:${baseCommit}`);
	archive.close();
	expect(() => readNarratorBackupArtifact(request().artifactPath ?? "", () => {})).toThrow(
		"dependency",
	);
});

test("real Worker job/status/private download/upload loop and opaque actor ownership", async () => {
	const { root, config } = await fixture();
	const jobs = new NarratorBackupJobs({ root: join(root, "backups"), config: async () => config });
	const plan = await jobs.planNarratorBackup(actor, {
		narratorIds: ["solo"],
		profile: "conversation-state-v1",
	});
	expect(plan.narratorIds).toEqual(["solo"]);
	const queued = await jobs.exportNarratorBackup(actor, {
		narratorIds: ["solo"],
		profile: "conversation-state-v1",
	});
	let completed: NarratorBackupJob = queued;
	const deadline = Date.now() + 10_000;
	while (["queued", "running"].includes(completed.status) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		completed = jobs.getJob(actor, queued.jobId);
	}
	expect(completed.status).toBe("completed");
	const artifactId = completed.artifactId ?? "";
	expect(() => jobs.getJob({ userId: "bob", isAdmin: true }, queued.jobId)).toThrow("not found");
	await expect(
		jobs.previewNarratorRestore({ userId: "bob", isAdmin: true }, { artifactId }),
	).rejects.toThrow("not found");
	const downloaded = await new Response(
		await jobs.download(actor, artifactId, new AbortController().signal),
	).arrayBuffer();
	expect(downloaded.byteLength).toBeGreaterThan(0);
	const uploaded = await jobs.uploadArtifact(
		actor,
		new Blob([downloaded]).stream(),
		new AbortController().signal,
	);
	expect(uploaded.verifiedSameInstance).toBe(false);
	await expect(
		jobs.restoreNarratorState(actor, { artifactId: uploaded.artifactId }),
	).rejects.toThrow("preview only");
	expect(
		(await jobs.previewNarratorRestore(actor, { artifactId: uploaded.artifactId }))
			.crossInstanceApplySupported,
	).toBe(false);
	const streams = [];
	for (let i = 0; i < 4; i++)
		streams.push(await jobs.download(actor, artifactId, new AbortController().signal));
	await expect(jobs.download(actor, artifactId, new AbortController().signal)).rejects.toThrow(
		"slots",
	);
	for (const stream of streams) await stream.cancel();
	const aborted = new AbortController();
	const stream = await jobs.download(actor, artifactId, aborted.signal);
	aborted.abort();
	await expect(stream.getReader().read()).rejects.toThrow("cancelled");
	await jobs.deleteArtifact(actor, artifactId);
});

test("real Worker export cancellation publishes no artifact and reaches cancelled status", async () => {
	const { root, config } = await fixture();
	const jobs = new NarratorBackupJobs({ root: join(root, "backups"), config: async () => config });
	const queued = await jobs.exportNarratorBackup(actor, {
		narratorIds: ["solo"],
		profile: "conversation-state-v1",
	});
	jobs.cancelJob(actor, queued.jobId);
	const deadline = Date.now() + 5000;
	let current = jobs.getJob(actor, queued.jobId);
	while (["queued", "running"].includes(current.status) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		current = jobs.getJob(actor, queued.jobId);
	}
	expect(current.status).toBe("cancelled");
	expect(current.artifactId).toBeUndefined();
});

// Scheduling uses an injected runner only; the seven roundtrip cases above use real SQLite
// and the job/download/upload case uses real Worker execution.
test("operation slots are bounded and cancellation releases them", async () => {
	const { root, config } = await fixture();
	const jobs = new NarratorBackupJobs({
		root: join(root, "backups"),
		config: async () => config,
		run: async (_input, signal) =>
			new Promise((_resolve, reject) => {
				const abort = () => reject(new Error("fixture cancelled"));
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort();
			}),
	});
	const controllers = Array.from({ length: 4 }, () => new AbortController());
	const pending = controllers.map((controller) =>
		jobs.planNarratorBackup(
			actor,
			{ narratorIds: ["solo"], profile: "conversation-state-v1" },
			controller.signal,
		),
	);
	await expect(
		jobs.planNarratorBackup(actor, { narratorIds: ["solo"], profile: "conversation-state-v1" }),
	).rejects.toThrow("queue");
	for (const controller of controllers) controller.abort();
	await Promise.allSettled(pending);
	const cancelled = new AbortController();
	cancelled.abort();
	await expect(
		jobs.planNarratorBackup(
			actor,
			{ narratorIds: ["solo"], profile: "conversation-state-v1" },
			cancelled.signal,
		),
	).rejects.toThrow("fixture cancelled");
});

test("failed job history is bounded but cannot permanently consume current job slots", async () => {
	const { root, config } = await fixture();
	const jobs = new NarratorBackupJobs({
		root: join(root, "backups"),
		config: async () => config,
		run: async () => {
			throw new Error("fixture failure");
		},
	});
	let oldest = "";
	for (let i = 0; i < LIMITS.jobs + 1; i++) {
		const queued = await jobs.exportNarratorBackup(actor, {
			narratorIds: ["solo"],
			profile: "conversation-state-v1",
		});
		if (!i) oldest = queued.jobId;
		const deadline = Date.now() + 1000;
		while (
			["queued", "running"].includes(jobs.getJob(actor, queued.jobId).status) &&
			Date.now() < deadline
		)
			await new Promise((resolve) => setTimeout(resolve, 1));
		expect(jobs.getJob(actor, queued.jobId).status).toBe("failed");
	}
	expect(() => jobs.getJob(actor, oldest)).toThrow("not found");
});

test("uploaded bytes/chunks and already cancelled readers reject before publication", async () => {
	const { root, config } = await fixture();
	const jobs = new NarratorBackupJobs({ root: join(root, "backups"), config: async () => config });
	await expect(
		jobs.uploadArtifact(
			actor,
			new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array(1024 * 1024 + 1));
					controller.close();
				},
			}),
			new AbortController().signal,
		),
	).rejects.toThrow("byte limit");
	let cancelled = false;
	const controller = new AbortController();
	const stalled = new ReadableStream<Uint8Array>(
		{
			pull() {
				controller.abort();
			},
			cancel() {
				cancelled = true;
			},
		},
		{ highWaterMark: 0 },
	);
	await expect(jobs.uploadArtifact(actor, stalled, controller.signal)).rejects.toThrow("cancelled");
	expect(cancelled).toBe(true);
});

test("untrusted views, virtual/generated columns, invalid columns and duplicate IDs reject", async () => {
	const { root, request } = await fixture();
	await runBackupWorker(request());
	const artifact = request().artifactPath ?? "";
	for (const [name, sql, message] of [
		[
			"view",
			"ALTER TABLE objects RENAME TO payload; CREATE VIEW objects AS SELECT key,bytes FROM payload",
			"plain artifact tables",
		],
		[
			"virtual",
			"DROP TABLE objects; CREATE VIRTUAL TABLE objects USING rtree(key,minX,maxX)",
			"plain artifact tables",
		],
		[
			"generated",
			"DROP TABLE objects; CREATE TABLE objects(key TEXT PRIMARY KEY,bytes BLOB GENERATED ALWAYS AS (zeroblob(10)) VIRTUAL)",
			"Generated",
		],
		[
			"duplicate",
			"ALTER TABLE state_rows RENAME TO old_rows; CREATE TABLE state_rows(table_name TEXT,id TEXT,json TEXT); INSERT INTO state_rows SELECT * FROM old_rows; INSERT INTO state_rows SELECT * FROM old_rows WHERE table_name='narrator_messages'",
			"duplicate backup row ID",
		],
	] as const) {
		const path = join(root, `${name}.sqlite`);
		await copyFile(artifact, path);
		const malicious = new Database(path);
		malicious.run(sql);
		malicious.close();
		expect(() => readNarratorBackupArtifact(path, () => {})).toThrow(message);
	}
	const path = join(root, "invalid-columns.sqlite");
	await copyFile(artifact, path);
	const malicious = new Database(path);
	const value = malicious.prepare("SELECT json FROM manifest WHERE id=1").get() as { json: string };
	const manifest = JSON.parse(value.json);
	manifest.columns.narrators.push("sqlite_schema");
	malicious.prepare("UPDATE manifest SET json=?").run(JSON.stringify(manifest));
	malicious.close();
	expect(() => readNarratorBackupArtifact(path, () => {})).toThrow("format");
});

test("public/read-granted access never confers full-export authority and stale admin fails closed", async () => {
	const { db, request } = await fixture();
	db.run(
		"UPDATE narrators SET visibility='public'; INSERT INTO narrator_grants(id,narrator_id,principal_type,principal_id,access,granted_by) VALUES('read','solo','user','bob','read','alice')",
	);
	await expect(
		runBackupWorker(request({ actor: { userId: "bob", isAdmin: false } })),
	).rejects.toThrow("owner/admin");
	await expect(
		runBackupWorker(request({ actor: { userId: "bob", isAdmin: true } })),
	).rejects.toThrow("owner/admin");
	db.run("UPDATE users SET role='admin' WHERE id='bob'");
	const plan = (await runBackupWorker(
		request({ action: "plan", actor: { userId: "bob", isAdmin: true } }),
	)) as { narratorIds: string[] };
	expect(plan.narratorIds).toEqual(["solo"]);
});
