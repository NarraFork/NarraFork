import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { getTestDb } from "../../../tests/setup";
import { openDatabase } from "../../db/connection";
import { requireApplicationDataDirectory } from "../../lib/data-directory-security";
import { importLegacyProjectOnWorker } from "../project-archive/legacy-import-job";
import { exportLegacyProjectOnWorker } from "../project-archive/legacy-sync-job";
import { ARCHIVE_COLUMNS, ARCHIVE_TABLE_ORDER } from "../project-archive/manifest";
import { readArtifactObject, readNarratorBackupArtifact } from "./artifact";
import { BACKUP_ORPHAN_RETENTION_MS, executeBackupWorker, NarratorBackupJobs } from "./jobs";
import { boundedBackupGit, gitOid } from "./objects";
import { createRuntimeNarratorBackupJobs, runtimeNarratorBackupConfig } from "./runtime";
import type { BackupWorkerConfig } from "./worker";

const originalHome = process.env.NARRAFORK_HOME;
const dirs: string[] = [];
const handles = new Set<Database>();
const actor = { userId: "alice", isAdmin: false };
const schema = getTestDb();
const schemaBytes = schema.sqlite.serialize();
schema.sqlite.close();
const now = new Date().toISOString();
afterEach(async () => {
	process.env.NARRAFORK_HOME = originalHome;
	for (const db of handles) db.close();
	handles.clear();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
function insert(db: Database, table: string, row: Record<string, string | number | null>) {
	const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
		(field) => field.name,
	);
	const values = { ...row };
	for (const field of ["created_at", "updated_at"])
		if (columns.includes(field) && !Object.hasOwn(values, field)) values[field] = now;
	const fields = Object.keys(values);
	db.prepare(
		`INSERT INTO ${table} (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
	).run(...fields.map((field) => values[field]));
}
function narrator(db: Database, id: string, extra: Record<string, string | number | null> = {}) {
	insert(db, "narrators", {
		id,
		title: id,
		type: "primary",
		owner_user_id: "alice",
		visibility: "private",
		write_audience: "owner",
		...extra,
	});
}
function message(db: Database, id: string, owner: string, text = id) {
	insert(db, "narrator_messages", {
		id,
		narrator_id: owner,
		role: "assistant",
		content_json: JSON.stringify([{ type: "text", text }]),
	});
}
function ref(db: Database, id: string, owner: string, msg: string, seq = 0) {
	insert(db, "narrator_message_refs", {
		id,
		narrator_id: owner,
		message_id: msg,
		seq,
		is_compact: 0,
	});
}
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "nf-backup-production-review-"));
	dirs.push(root);
	const sourcePath = join(root, "narrafork.db"),
		targetPath = join(root, "target.db"),
		archivePath = join(root, "legacy.db");
	await writeFile(sourcePath, schemaBytes);
	await writeFile(targetPath, schemaBytes);
	const source = openDatabase(sourcePath),
		target = openDatabase(targetPath);
	handles.add(source);
	handles.add(target);
	for (const db of [source, target])
		for (const id of ["alice", "bob"])
			insert(db, "users", { id, username: id, password_hash: "fixture", role: "user" });
	const archive = new Database(archivePath, { create: true });
	handles.add(archive);
	for (const table of ARCHIVE_TABLE_ORDER)
		archive.run(
			`CREATE TABLE ${table} (${ARCHIVE_COLUMNS[table].map((field) => `${field} ${field === "id" ? "TEXT PRIMARY KEY" : field === "seq" ? "INTEGER" : "TEXT"}`).join(",")})`,
		);
	const config: BackupWorkerConfig = {
		backend: "sqlite",
		databasePath: sourcePath,
		sourceInstanceId: "fixture",
		objectSource: {
			shadowRoot: join(root, "tree-snapshots"),
			uploadsRoot: join(root, "uploads"),
			blobRoot: join(root, "file-change-blobs"),
			journalRoot: join(root, "worktree-requests"),
		},
	};
	const restore = () =>
		importLegacyProjectOnWorker({
			archivePath,
			databasePath: targetPath,
			backend: "sqlite",
			gitPath: root,
			actor,
			deadline: Date.now() + 10000,
		});
	const sync = () =>
		exportLegacyProjectOnWorker({
			archivePath,
			databasePath: sourcePath,
			backend: "sqlite",
			projectId: "p",
			actor,
			deadline: Date.now() + 10000,
		});
	return {
		root,
		source,
		target,
		archive,
		sourcePath,
		targetPath,
		archivePath,
		config,
		restore,
		sync,
	};
}
async function completed(jobs: NarratorBackupJobs, jobId: string) {
	const deadline = Date.now() + 10000;
	for (;;) {
		const job = jobs.getJob(actor, jobId);
		if (!["queued", "running"].includes(job.status)) {
			expect(job.status, job.error).toBe("completed");
			if (!job.artifactId) throw new Error("Missing completed artifact");
			return job.artifactId;
		}
		if (Date.now() > deadline) throw new Error("fixture timeout");
		await Bun.sleep(5);
	}
}

test("R-A1 production FKs cannot lend Bob's target message to an incomplete or forged Alice archive", async () => {
	const { target, archive, restore } = await fixture();
	narrator(target, "alice-n");
	narrator(target, "bob-n", { owner_user_id: "bob" });
	message(target, "secret", "bob-n", "Bob private body");
	message(target, "allowed", "alice-n", "Alice original body");
	expect(
		(target.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys,
	).toBe(1);
	expect(
		(
			target.prepare("PRAGMA foreign_key_list(narrator_message_refs)").all() as { table: string }[]
		).some((fk) => fk.table === "narrator_messages"),
	).toBe(true);
	// Exactly the exploit: FKs alone accept an Alice ref to Bob's existing PK.
	target.run("BEGIN");
	ref(target, "probe", "alice-n", "secret");
	target.run("ROLLBACK");
	insert(archive, "projects", { id: "p", name: "untrusted", git_path: "/source" });
	insert(archive, "narrators", { id: "alice-n", type: "primary" });
	ref(archive, "transfer", "alice-n", "secret");
	await expect(restore()).rejects.toThrow("validation or operation failed");
	expect(target.prepare("SELECT id FROM projects WHERE id='p'").all()).toEqual([]);
	expect(
		target.prepare("SELECT id FROM narrator_message_refs WHERE narrator_id='alice-n'").all(),
	).toEqual([]);
	// Supplying a forged message owner also fails: actual target ownership wins.
	message(archive, "secret", "alice-n", "forged public body");
	await expect(restore()).rejects.toThrow("validation or operation failed");
	expect(target.prepare("SELECT id FROM projects WHERE id='p'").all()).toEqual([]);
	archive.run("DELETE FROM narrator_messages; DELETE FROM narrator_message_refs");
	insert(target, "projects", {
		id: "bob-project",
		name: "Bob private project",
		git_path: "/bob",
		owner_user_id: "bob",
	});
	insert(target, "chapters", {
		id: "borrowed-chapter",
		project_id: "bob-project",
		title: "Bob chapter",
		branch: "chapter/bob",
		base_branch: "main",
	});
	insert(archive, "chapters", {
		id: "borrowed-chapter",
		project_id: "p",
		title: "forged project owner",
		branch: "chapter/forged",
		base_branch: "main",
	});
	insert(archive, "narrators", { id: "injected", type: "primary", chapter_id: "borrowed-chapter" });
	await expect(restore()).rejects.toThrow("validation or operation failed");
	expect(target.prepare("SELECT id FROM projects WHERE id='p'").all()).toEqual([]);
	expect(target.prepare("SELECT id FROM narrators WHERE id='injected'").all()).toEqual([]);
	archive.run("DELETE FROM narrators WHERE id='injected'; DELETE FROM chapters");
	message(archive, "allowed", "alice-n", "must not overwrite existing body");
	ref(archive, "transfer", "alice-n", "allowed");
	expect((await restore()).skipped).toBe(false);
	expect(
		target
			.prepare("SELECT message_id FROM narrator_message_refs WHERE narrator_id='alice-n'")
			.all(),
	).toEqual([{ message_id: "allowed" }]);
	expect(
		(
			target.prepare("SELECT content_json FROM narrator_messages WHERE id='allowed'").get() as {
				content_json: string;
			}
		).content_json,
	).toContain("Alice original body");
	expect(target.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("R-A4 real worker exports only authorized minimum shared dependencies and restores with production FKs after source removal", async () => {
	const { root, source, target, archive, sourcePath, sync, restore } = await fixture();
	insert(source, "projects", { id: "p", name: "project", git_path: root, owner_user_id: "alice" });
	narrator(source, "root", { context_project_id: "p" });
	narrator(source, "ancestor");
	message(source, "origin", "ancestor");
	narrator(source, "outside", { parent_narrator_id: "ancestor", fork_message_id: "origin" });
	message(source, "shared", "outside");
	message(source, "future", "outside", "outside future must not export");
	ref(source, "outside-future", "outside", "future", 3);
	ref(source, "selected-ref", "root", "shared");
	await sync();
	expect(archive.prepare("SELECT id FROM narrators ORDER BY id").all()).toEqual([
		{ id: "ancestor" },
		{ id: "outside" },
		{ id: "root" },
	]);
	expect(archive.prepare("SELECT id FROM narrator_messages ORDER BY id").all()).toEqual([
		{ id: "origin" },
		{ id: "shared" },
	]);
	source.close();
	handles.delete(source);
	await rm(sourcePath);
	expect((await restore()).skipped).toBe(false);
	expect(target.prepare("SELECT id FROM narrators ORDER BY id").all()).toEqual([
		{ id: "ancestor" },
		{ id: "outside" },
		{ id: "root" },
	]);
	expect(target.prepare("SELECT message_id FROM narrator_message_refs").all()).toEqual([
		{ message_id: "shared" },
	]);
	expect(target.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("R-A4 unauthorized owner or required cross-project dependency blocks export before archive publication", async () => {
	const { root, source, archive, sync } = await fixture();
	insert(source, "projects", { id: "p", name: "p", git_path: root, owner_user_id: "alice" });
	narrator(source, "root", { context_project_id: "p" });
	narrator(source, "outside", { owner_user_id: "bob" });
	message(source, "shared", "outside");
	ref(source, "ref", "root", "shared");
	await expect(sync()).rejects.toThrow("validation or operation failed");
	expect(archive.prepare("SELECT id FROM projects").all()).toEqual([]);
	source.run("UPDATE narrators SET owner_user_id='alice' WHERE id='outside'");
	insert(source, "projects", {
		id: "q",
		name: "q",
		git_path: join(root, "q"),
		owner_user_id: "alice",
	});
	source.run("UPDATE narrators SET context_project_id='q' WHERE id='outside'");
	await expect(sync()).rejects.toThrow("validation or operation failed");
	expect(archive.prepare("SELECT id FROM projects").all()).toEqual([]);
});

test("R-A3 branch export includes its subagent and exact lazy prefix, not private siblings or future ancestor history", async () => {
	const { root, source, config } = await fixture();
	narrator(source, "parent", { context_summary: "future parent summary" });
	message(source, "prefix", "parent");
	ref(source, "prefix-ref", "parent", "prefix", 0);
	message(source, "future", "parent", "future parent body");
	ref(source, "future-ref", "parent", "future", 4);
	narrator(source, "a", {
		parent_narrator_id: "parent",
		fork_message_id: "prefix",
		refs_inherited_from: "parent",
		refs_backfill_cursor: 1,
	});
	message(source, "a-body", "a");
	ref(source, "a-ref", "a", "a-body", 1);
	narrator(source, "b", { parent_narrator_id: "parent", owner_user_id: "bob" });
	message(source, "b-body", "b", "Bob private sibling");
	ref(source, "b-ref", "b", "b-body");
	narrator(source, "sub", {
		type: "subagent",
		owner_user_id: null,
		parent_narrator_id: "a",
		acl_root_narrator_id: "a",
	});
	message(source, "sub-body", "sub");
	ref(source, "sub-ref", "sub", "sub-body");
	insert(source, "spec_namespaces", { id: "parent-ns", narrator_id: "parent" });
	insert(source, "spec_namespaces", {
		id: "a-ns",
		narrator_id: "a",
		forked_from_namespace_id: "parent-ns",
	});
	insert(source, "spec_file_revisions", {
		id: "old-spec",
		namespace_id: "parent-ns",
		path: "notes.md",
		content: "inherited spec",
		content_hash: "old",
		source_message_id: "prefix",
	});
	insert(source, "spec_file_revisions", {
		id: "future-spec",
		namespace_id: "parent-ns",
		path: "notes.md",
		content: "future parent spec",
		content_hash: "future",
	});
	insert(source, "spec_namespace_files", {
		id: "parent-head",
		namespace_id: "parent-ns",
		path: "notes.md",
		revision_id: "future-spec",
	});
	insert(source, "spec_namespace_files", {
		id: "a-file",
		namespace_id: "a-ns",
		path: "notes.md",
		revision_id: "old-spec",
	});
	const before = JSON.stringify(
		source.prepare("SELECT * FROM narrator_message_refs ORDER BY id").all(),
	);
	const artifactPath = join(root, "branch.sqlite");
	await executeBackupWorker(
		{
			action: "export",
			actor,
			config,
			narratorIds: ["a"],
			profile: "conversation-state-v1",
			artifactPath,
			stagingPath: join(root, "branch.staging"),
		},
		new AbortController().signal,
	);
	const { state } = readNarratorBackupArtifact(artifactPath, () => {});
	expect(state.rows.narrators?.map((row) => row.id).sort()).toEqual(["a", "parent", "sub"]);
	expect(state.rows.narrator_messages?.map((row) => row.id).sort()).toEqual([
		"a-body",
		"prefix",
		"sub-body",
	]);
	expect(state.rows.narrators?.find((row) => row.id === "parent")?.context_summary).toBeNull();
	expect(JSON.stringify(state)).not.toContain("Bob private sibling");
	expect(JSON.stringify(state)).not.toContain("future parent body");
	expect(state.rows.spec_file_revisions?.map((row) => row.id)).toEqual(["old-spec"]);
	expect(state.rows.spec_namespace_files?.map((row) => row.id)).toEqual(["a-file"]);
	expect(JSON.stringify(state)).not.toContain("future parent spec");
	expect(
		JSON.stringify(source.prepare("SELECT * FROM narrator_message_refs ORDER BY id").all()),
	).toBe(before);
});

async function gitObject(repo: string, kind: string, bytes: Buffer) {
	const oid = gitOid(kind, bytes);
	await mkdir(join(repo, "objects", oid.slice(0, 2)), { recursive: true });
	await writeFile(
		join(repo, "objects", oid.slice(0, 2), oid.slice(2)),
		deflateSync(Buffer.concat([Buffer.from(`${kind} ${bytes.length}\0`), bytes])),
	);
	return oid;
}
test("R-A2 production runtime factory reads private trees/uploads and instance identity from the real absolute home", async () => {
	const { root, source } = await fixture();
	process.env.NARRAFORK_HOME = root;
	const cwd = await mkdtemp(join(tmpdir(), "nf-backup-runtime-workspace-"));
	dirs.push(cwd);
	await writeFile(join(root, "settings.json"), JSON.stringify({ agent: {} }));
	narrator(source, "solo", { cwd, default_device_id: "local" });
	message(source, "message", "solo");
	ref(source, "ref", "solo", "message");
	const identity = await requireApplicationDataDirectory(root);
	const config = await runtimeNarratorBackupConfig();
	expect(config.objectSource).toEqual({
		shadowRoot: join(root, "tree-snapshots"),
		uploadsRoot: join(root, "uploads"),
		blobRoot: join(root, "file-change-blobs"),
		journalRoot: join(root, "worktree-requests"),
	});
	expect(config.databasePath).toBe(join(root, "narrafork.db"));
	expect(JSON.parse(await readFile(join(root, "file-change-source.json"), "utf8")).id).toBe(
		config.sourceInstanceId,
	);
	expect(await stat(join(process.cwd(), identity)).catch(() => null)).toBeNull();
	const repo = join(
		config.objectSource.shadowRoot,
		createHash("sha256").update(`local\0${cwd}`).digest("hex").slice(0, 32),
	);
	await mkdir(repo, { recursive: true });
	await boundedBackupGit(["init", "--bare", repo], new AbortController().signal);
	const bytes = Buffer.from([0, 255, 128, 1]);
	const blob = await gitObject(repo, "blob", bytes);
	const tree = await gitObject(
		repo,
		"tree",
		Buffer.concat([Buffer.from("100644 binary\0"), Buffer.from(blob, "hex")]),
	);
	await mkdir(join(root, "uploads", "solo"), { recursive: true });
	await writeFile(join(root, "uploads", "solo", "image.png"), bytes);
	source
		.prepare("UPDATE narrator_messages SET tree_hash_after=?,content_json=? WHERE id='message'")
		.run(tree, JSON.stringify([{ type: "image", imageId: "image", uploadNarratorId: "solo" }]));
	const jobs = createRuntimeNarratorBackupJobs();
	const job = await jobs.exportNarratorBackup(actor, {
		narratorIds: ["solo"],
		profile: "conversation-tree-v1",
	});
	const artifactId = await completed(jobs, job.jobId);
	const path = join(root, "narrator-backups", `${artifactId}.sqlite`);
	expect(readArtifactObject(path, `git:${blob}`)).toEqual(bytes);
	expect(readArtifactObject(path, "upload:solo:image")).toEqual(bytes);
	expect(await stat(join(process.cwd(), identity)).catch(() => null)).toBeNull();
});

test("R-A5 restart cleans bounded expired orphans without reviving attestation or deleting recent/active files", async () => {
	const { root, source, config } = await fixture();
	narrator(source, "solo");
	message(source, "message", "solo");
	ref(source, "ref", "solo", "message");
	const backupRoot = join(root, "backups");
	const first = new NarratorBackupJobs({ root: backupRoot, config: async () => config });
	const job = await first.exportNarratorBackup(actor, {
		narratorIds: ["solo"],
		profile: "conversation-state-v1",
	});
	const artifactId = await completed(first, job.jobId);
	const recentPath = join(backupRoot, `${artifactId}.sqlite`);
	const restart = new NarratorBackupJobs({ root: backupRoot, config: async () => config });
	await expect(restart.restoreNarratorState(actor, { artifactId })).rejects.toThrow("not found");
	const oldPaths = [];
	for (let i = 0; i < 64; i++) {
		const path = join(backupRoot, `${randomUUID()}.sqlite`);
		await writeFile(path, "expired untrusted orphan");
		const age = new Date(Date.now() - BACKUP_ORPHAN_RETENTION_MS - 1000);
		await utimes(path, age, age);
		oldPaths.push(path);
	}
	const newJob = await restart.exportNarratorBackup(actor, {
		narratorIds: ["solo"],
		profile: "conversation-state-v1",
	});
	await completed(restart, newJob.jobId);
	for (const path of oldPaths) expect(await stat(path).catch(() => null)).toBeNull();
	expect(await stat(recentPath)).toBeTruthy();
	// Controlled scheduling seam only: exercise expiry against an actual in-flight staging file.
	let started!: () => void;
	let finish!: () => void;
	const startedPromise = new Promise<void>((resolve) => {
		started = resolve;
	});
	let activePath = "";
	const active = new NarratorBackupJobs({
		root: backupRoot,
		config: async () => config,
		run: async (input, signal) => {
			if (input.action !== "export") return { digest: "fixture", narratorIds: ["solo"] };
			if (!input.stagingPath) throw new Error("Missing staging path");
			activePath = input.stagingPath;
			await writeFile(activePath, "active staging");
			const old = new Date(Date.now() - BACKUP_ORPHAN_RETENTION_MS - 1000);
			await utimes(activePath, old, old);
			started();
			await new Promise<void>((resolve, reject) => {
				finish = resolve;
				signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
			});
			return { digest: "fixture", narratorIds: ["solo"] };
		},
	});
	const activeJob = await active.exportNarratorBackup(actor, {
		narratorIds: ["solo"],
		profile: "conversation-state-v1",
	});
	await startedPromise;
	const bytes = await readFile(recentPath);
	await active.uploadArtifact(actor, new Blob([bytes]).stream(), new AbortController().signal);
	expect(await stat(activePath)).toBeTruthy();
	active.cancelJob(actor, activeJob.jobId);
	finish();
	await Bun.sleep(10);
});

test("R-HTTP explicit deprecated fork fields reject before creation; omission still forks", async () => {
	const { db, sqlite } = await import("../../db");
	const { users, narrators, narratorMessages, narratorMessageRefs } = await import(
		"../../db/schema"
	);
	const { Hono } = await import("hono");
	const { narratorRoutes } = await import("../../routes/narrators");
	const { AppError } = await import("../../lib/errors");
	const { eq } = await import("drizzle-orm");
	const workspace = await mkdtemp(join(tmpdir(), "nf-ordinary-http-workspace-"));
	dirs.push(workspace);
	const userId = randomUUID(),
		sourceId = randomUUID(),
		messageId = randomUUID();
	await db
		.insert(users)
		.values({ id: userId, username: userId, passwordHash: "fixture", createdAt: now });
	await db.insert(narrators).values({
		id: sourceId,
		title: "ordinary source",
		cwd: workspace,
		defaultDeviceId: "local",
		ownerUserId: userId,
		permissionMode: "readOnly",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId: sourceId,
		role: "assistant",
		contentJson: [{ type: "text", text: "fork boundary" }],
		createdAt: now,
	});
	await db
		.insert(narratorMessageRefs)
		.values({ id: randomUUID(), narratorId: sourceId, messageId, seq: 0 });
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: 2147483647 });
		await next();
	});
	app.onError(
		(error) =>
			new Response(
				JSON.stringify({
					error: error.message,
					code: error instanceof AppError ? error.code : "INTERNAL_ERROR",
				}),
				{ status: error instanceof AppError ? error.statusCode : 500 },
			),
	);
	app.route("/narrators", narratorRoutes);
	const before = (sqlite.prepare("SELECT count(*) AS n FROM narrators").get() as { n: number }).n;
	const chaptersBefore = (
		sqlite.prepare("SELECT count(*) AS n FROM chapters").get() as { n: number }
	).n;
	const validFork = { forkMessageId: messageId, inheritMode: "fresh", title: "ordinary child" };
	try {
		for (const body of [
			{ worktreeSource: "fresh" },
			{ commitSha: "a".repeat(40) },
			{ worktreeSource: null },
			{ commitSha: null },
		]) {
			const response = await app.request(`/narrators/${sourceId}/fork`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...validFork, ...body }),
			});
			expect(response.status).toBe(400);
			expect((await response.json()).code).toBe("NARRATOR_WORKTREE_FORK_UNSUPPORTED");
			expect((sqlite.prepare("SELECT count(*) AS n FROM chapters").get() as { n: number }).n).toBe(
				chaptersBefore,
			);
			expect((sqlite.prepare("SELECT count(*) AS n FROM narrators").get() as { n: number }).n).toBe(
				before,
			);
		}
		const response = await app.request(`/narrators/${sourceId}/fork`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validFork),
		});
		const child = await response.json();
		expect(response.status, JSON.stringify(child)).toBe(201);
		expect((sqlite.prepare("SELECT count(*) AS n FROM chapters").get() as { n: number }).n).toBe(
			chaptersBefore,
		);
		expect((sqlite.prepare("SELECT count(*) AS n FROM narrators").get() as { n: number }).n).toBe(
			before + 1,
		);
		const namespaceDeadline = Date.now() + 1000;
		while (
			!sqlite.prepare("SELECT id FROM spec_namespaces WHERE narrator_id=? LIMIT 1").get(child.id) &&
			Date.now() < namespaceDeadline
		)
			await Bun.sleep(5);
		await new Promise<void>((resolve) => setImmediate(resolve));
		await db.delete(narrators).where(eq(narrators.id, child.id));
	} finally {
		await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, sourceId));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, sourceId));
		await db.delete(narrators).where(eq(narrators.id, sourceId));
		await db.delete(users).where(eq(users.id, userId));
	}
});
