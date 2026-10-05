import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	NARRATOR_BACKUP_LIMITS as LIMITS,
	type NarratorBackupProfile,
} from "@shared/narrator-backup";
import { BACKUP_TABLES, type BackupManifest, type BackupTable, backupColumns } from "./contract";
import { executeBackupWorker, NarratorBackupJobs } from "./jobs";
import { sha256 } from "./objects";
import { installProductionBackupAccessTables } from "./production-fixture.test-helper";
import type { BackupWorkerConfig } from "./worker";

const actor = { userId: "alice", isAdmin: false };
const signal = () => new AbortController().signal;
const directories: string[] = [];
const databases: Database[] = [];
afterEach(async () => {
	for (const database of databases.splice(0)) database.close();
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "nf-backup-attestation-"));
	directories.push(root);
	const databasePath = join(root, "fixture.sqlite");
	const db = new Database(databasePath, { create: true });
	databases.push(db);
	db.run("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=250");
	db.run(
		"CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,password_hash TEXT); INSERT INTO users VALUES('alice','user','never-export-credentials'),('bob','user','never-export-credentials'),('admin','admin','never-export-credentials');",
	);
	installProductionBackupAccessTables(db);
	for (const table of Object.keys(BACKUP_TABLES) as BackupTable[])
		db.run(
			`CREATE TABLE ${table} (${backupColumns(table)
				.map(
					(column) =>
						`${column} ${column === "id" ? "TEXT PRIMARY KEY" : ["seq", "next_seq", "workspace_revision", "refs_backfill_cursor", "is_compact", "execution_attempt", "execution_identity_version", "deleted", "enabled"].includes(column) ? "INTEGER" : "TEXT"}`,
				)
				.join(",")})`,
		);
	db.run(
		"INSERT INTO narrators(id,type,title,owner_user_id,visibility,write_audience,status,workspace_revision,next_seq) VALUES('solo','primary','offline conversation','alice','private','owner','working',7,3); INSERT INTO narrator_messages(id,narrator_id,role,content_json) VALUES('message','solo','assistant','[{\"type\":\"text\",\"text\":\"sensitive transcript\"}]'); INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq,is_compact) VALUES('ref','solo','message',2,1); INSERT INTO narrator_tool_calls(id,narrator_id,message_id,tool_use_id,tool_name,status,input_json,execution_identity_version,execution_attempt) VALUES('tool','solo','message','use','Bash','pending','{}',2,1); INSERT INTO spec_namespaces(id,narrator_id) VALUES('namespace','solo'); INSERT INTO spec_file_revisions(id,namespace_id,path,content) VALUES('revision','namespace','tasks.json','{\"tasks\":[{\"text\":\"must not run\",\"status\":\"doing\"}]}'); INSERT INTO spec_namespace_files(id,namespace_id,path,revision_id,deleted) VALUES('file','namespace','tasks.json','revision',0); INSERT INTO spec_protected_tasks(id,namespace_id,text_hash,text,status,first_revision_id,last_revision_id) VALUES('task','namespace','hash','must not run','doing','revision','revision')",
	);
	const config: BackupWorkerConfig = {
		backend: "sqlite",
		databasePath,
		sourceInstanceId: "persistent-fixture-instance",
		proofDirectory: join(root, "private-proof"),
		objectSource: {
			shadowRoot: join(root, "tree-snapshots"),
			uploadsRoot: join(root, "uploads"),
			blobRoot: join(root, "file-blobs"),
			journalRoot: join(root, "journals"),
		},
	};
	const jobs = (override: Partial<BackupWorkerConfig> = {}, name = "backups") =>
		new NarratorBackupJobs({
			root: join(root, name),
			config: async () => ({ ...config, ...override }),
		});
	const erase = () => {
		for (const table of Object.keys(BACKUP_TABLES)) db.run(`DELETE FROM ${table}`);
	};
	async function exported(profile: NarratorBackupProfile = "conversation-state-v1") {
		const service = jobs();
		const queued = await service.exportNarratorBackup(actor, { narratorIds: ["solo"], profile });
		const deadline = Date.now() + 10_000;
		for (;;) {
			const job = service.getJob(actor, queued.jobId);
			if (!["queued", "running"].includes(job.status)) {
				expect(job.status, job.error).toBe("completed");
				const artifactId = job.artifactId ?? "";
				const bytes = await new Response(
					await service.download(actor, artifactId, signal()),
				).arrayBuffer();
				return { service, artifactId, bytes, path: join(root, "backups", `${artifactId}.sqlite`) };
			}
			if (Date.now() >= deadline) throw new Error("Fixture export timed out");
			await Bun.sleep(5);
		}
	}
	const upload = (service: NarratorBackupJobs, bytes: ArrayBuffer, uploadingActor = actor) =>
		service.uploadArtifact(uploadingActor, new Blob([bytes]).stream(), signal());
	async function treeUpload() {
		await mkdir(join(config.objectSource.uploadsRoot, "solo"), { recursive: true });
		const bytes = Buffer.from([0, 255, 17, 89]);
		await writeFile(join(config.objectSource.uploadsRoot, "solo", "image.png"), bytes);
		db.prepare("UPDATE narrator_messages SET content_json=? WHERE id='message'").run(
			JSON.stringify([{ type: "image", imageId: "image", uploadNarratorId: "solo" }]),
		);
		return bytes;
	}
	return { root, db, config, jobs, erase, exported, upload, treeUpload };
}

function editManifest(db: Database, edit: (manifest: BackupManifest) => void) {
	const manifest = JSON.parse(
		(db.prepare("SELECT json FROM manifest").get() as { json: string }).json,
	) as BackupManifest;
	edit(manifest);
	db.prepare("UPDATE manifest SET json=?").run(JSON.stringify(manifest));
}

for (const profile of ["conversation-state-v1", "conversation-tree-v1"] as const) {
	test(`real Worker offline ${profile} remains recoverable after service reconstruction and original artifact removal`, async () => {
		const f = await fixture();
		if (profile === "conversation-tree-v1") await f.treeUpload();
		const before = JSON.stringify(f.db.prepare("SELECT * FROM narrator_message_refs").all());
		const backup = await f.exported(profile);
		expect(JSON.stringify(f.db.prepare("SELECT * FROM narrator_message_refs").all())).toBe(before);
		const key = await readFile(join(f.config.proofDirectory ?? "", "attestation-v1.key"));
		expect(key.length).toBe(32);
		expect(Buffer.from(backup.bytes).includes(key)).toBe(false);
		expect(Buffer.from(backup.bytes).includes(Buffer.from("never-export-credentials"))).toBe(false);
		await backup.service.deleteArtifact(actor, backup.artifactId);
		await rm(join(f.root, "backups"), { recursive: true, force: true });
		await rm(f.config.objectSource.uploadsRoot, { recursive: true, force: true });
		// No artifacts/jobs/actor proof survive in the NEW service's Maps.
		const restarted = f.jobs();
		expect(() => restarted.getJob(actor, "old-job")).toThrow("not found");
		const uploaded = await f.upload(restarted, backup.bytes);
		expect(uploaded.verifiedSameInstance).toBe(true);
		const conflicting = await restarted.previewNarratorRestore(actor, uploaded);
		expect(conflicting.verifiedSameInstance).toBe(true);
		expect(conflicting.sameInstanceStateRestoreAllowed).toBe(false);
		expect(conflicting.blockers.join()).toContain("ID conflicts");
		f.erase();
		const preview = await restarted.previewNarratorRestore(actor, uploaded);
		expect(preview.sameInstanceStateRestoreAllowed).toBe(true);
		expect(preview.crossInstanceApplySupported).toBe(false);
		expect(preview.productionDiskRestoreAllowed).toBe(false);
		const restored = await restarted.restoreNarratorState(actor, uploaded);
		expect(restored.status).toBe("archived");
		expect(restored.manualActivationRequired).toBe(true);
		expect(
			f.db
				.prepare("SELECT status,permission_mode,owner_user_id,workspace_revision FROM narrators")
				.get(),
		).toEqual({
			status: "archived",
			permission_mode: "readOnly",
			owner_user_id: "alice",
			workspace_revision: 7,
		});
		expect(f.db.prepare("SELECT seq,is_compact FROM narrator_message_refs").get()).toEqual({
			seq: 2,
			is_compact: 1,
		});
		expect(f.db.prepare("SELECT status,execution_attempt FROM narrator_tool_calls").get()).toEqual({
			status: "fail",
			execution_attempt: 0,
		});
		expect(f.db.prepare("SELECT deleted,revision_id FROM spec_namespace_files").get()).toEqual({
			deleted: 1,
			revision_id: null,
		});
		expect(f.db.prepare("SELECT status FROM spec_protected_tasks").get()).toEqual({
			status: "deleted",
		});
		expect(
			f.db
				.prepare(
					"SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('worktree_leases','write_claims','execution_receipts')",
				)
				.all(),
		).toEqual([]);
		if (process.platform !== "win32")
			expect(
				(await stat(join(f.config.proofDirectory ?? "", "attestation-v1.key"))).mode & 0o077,
			).toBe(0);
	});
}

for (const uploadingActor of [
	{ userId: "bob", isAdmin: false },
	{ userId: "admin", isAdmin: true },
]) {
	test(`signed actor provenance is not transferable to ${uploadingActor.userId}`, async () => {
		const f = await fixture();
		const backup = await f.exported();
		f.erase();
		const service = f.jobs();
		const uploaded = await f.upload(service, backup.bytes, uploadingActor);
		expect(uploaded.verifiedSameInstance).toBe(false);
		expect(
			(await service.previewNarratorRestore(uploadingActor, uploaded)).crossInstanceApplySupported,
		).toBe(false);
		await expect(service.restoreNarratorState(uploadingActor, uploaded)).rejects.toThrow(
			"preview only",
		);
		expect(f.db.prepare("SELECT id FROM narrators").all()).toEqual([]);
	});
}

for (const changed of ["instance", "foreign-key", "missing-key"] as const) {
	test(`persistent provenance fails closed with ${changed}`, async () => {
		const f = await fixture();
		const backup = await f.exported();
		f.erase();
		const overrides: Partial<BackupWorkerConfig> = {};
		if (changed === "instance") overrides.sourceInstanceId = "different-instance";
		if (changed === "foreign-key") {
			const foreign = await fixture();
			await foreign.exported();
			overrides.proofDirectory = foreign.config.proofDirectory;
		}
		if (changed === "missing-key") await rm(f.config.proofDirectory ?? "", { recursive: true });
		const service = f.jobs(overrides);
		const uploaded = await f.upload(service, backup.bytes);
		expect(uploaded.verifiedSameInstance).toBe(false);
		const preview = await service.previewNarratorRestore(actor, uploaded);
		expect(preview.verifiedSameInstance).toBe(false);
		expect(preview.sameInstanceStateRestoreAllowed).toBe(false);
		await expect(service.restoreNarratorState(actor, uploaded)).rejects.toThrow("preview only");
		if (changed === "missing-key")
			await expect(stat(f.config.proofDirectory ?? "")).rejects.toThrow();
	});
}

for (const change of [
	"state",
	"profile",
	"owner",
	"manifest",
	"missing-proof",
	"invalid-proof",
	"object-limit",
	"object-digest",
	"object-bytes",
	"extra-object",
] as const) {
	test(`real upload refuses altered signed ${change} payload`, async () => {
		const f = await fixture();
		await f.treeUpload();
		const backup = await f.exported("conversation-tree-v1");
		const artifact = new Database(backup.path);
		try {
			if (change === "state")
				artifact.run(
					"UPDATE state_rows SET json=replace(json,'offline conversation','altered conversation') WHERE table_name='narrators'",
				);
			else if (change === "object-bytes") artifact.run("UPDATE objects SET bytes=x'01020304'");
			else if (change === "extra-object")
				artifact.run("INSERT INTO objects VALUES('extra',x'0102')");
			else
				editManifest(artifact, (manifest) => {
					if (change === "profile") manifest.profile = "conversation-state-v1";
					if (change === "owner") manifest.actorUserId = "bob";
					if (change === "manifest") manifest.createdAt = "1900-01-01T00:00:00Z";
					if (change === "missing-proof") delete manifest.attestation;
					if (change === "invalid-proof" && manifest.attestation)
						manifest.attestation.signature = "0".repeat(64);
					if (change === "object-limit") manifest.objects[0].size = LIMITS.objectBytes + 1;
					if (change === "object-digest") {
						artifact.run("UPDATE objects SET bytes=x'01020304'");
						manifest.objects[0].digest = sha256(Buffer.from([1, 2, 3, 4]));
					}
				});
		} finally {
			artifact.close();
		}
		const bytes = await new Blob([await readFile(backup.path)]).arrayBuffer();
		f.erase();
		const service = f.jobs();
		if (change === "object-bytes" || change === "extra-object" || change === "object-limit")
			await expect(f.upload(service, bytes)).rejects.toThrow();
		else {
			const uploaded = await f.upload(service, bytes);
			expect(uploaded.verifiedSameInstance).toBe(false);
			await expect(service.restoreNarratorState(actor, uploaded)).rejects.toThrow("preview only");
		}
		expect(f.db.prepare("SELECT id FROM narrators").all()).toEqual([]);
	});
}

test("actual apply re-verifies persistent key and uploaded exact bytes, never a cached preview verdict", async () => {
	const f = await fixture();
	const backup = await f.exported();
	f.erase();
	const service = f.jobs();
	const uploaded = await f.upload(service, backup.bytes);
	expect(
		(await service.previewNarratorRestore(actor, uploaded)).sameInstanceStateRestoreAllowed,
	).toBe(true);
	await writeFile(join(f.config.proofDirectory ?? "", "attestation-v1.key"), randomBytes(32), {
		mode: 0o600,
	});
	await expect(service.restoreNarratorState(actor, uploaded)).rejects.toThrow();
	await expect(service.download(actor, uploaded.artifactId, signal())).rejects.toThrow();
	expect(f.db.prepare("SELECT id FROM narrators").all()).toEqual([]);
});

test("fresh actor/source ACL, target project/device ACL and ID conflicts still constrain signed authority", async () => {
	const f = await fixture();
	f.db.run(
		`INSERT INTO projects(id,name,git_path,owner_user_id,visibility,created_at,updated_at) VALUES('project','p','${f.root}','alice','private','now','now'); INSERT INTO remote_devices(id,name,slug,token_hash,token_prefix,created_by,owner_scope,created_at,updated_at) VALUES('device','d','d','hash','prefix','alice','private','now','now'); UPDATE narrators SET context_project_id='project',default_device_id='device'`,
	);
	const backup = await f.exported();
	f.db.run("UPDATE narrators SET owner_user_id='bob'");
	await expect(backup.service.download(actor, backup.artifactId, signal())).rejects.toThrow();
	f.erase();
	const service = f.jobs();
	const uploaded = await f.upload(service, backup.bytes);
	f.db.run("UPDATE projects SET owner_user_id='bob'");
	expect(
		(await service.previewNarratorRestore(actor, uploaded)).sameInstanceStateRestoreAllowed,
	).toBe(false);
	await expect(service.restoreNarratorState(actor, uploaded)).rejects.toThrow();
	f.db.run("UPDATE projects SET owner_user_id='alice'; UPDATE remote_devices SET created_by='bob'");
	await expect(service.restoreNarratorState(actor, uploaded)).rejects.toThrow();
	f.db.run("UPDATE remote_devices SET created_by='alice'; DELETE FROM users WHERE id='alice'");
	await expect(service.restoreNarratorState(actor, uploaded)).rejects.toThrow();
	expect(f.db.prepare("SELECT id FROM narrators").all()).toEqual([]);
});

test("concurrent real exports share one atomic durable private key", async () => {
	const f = await fixture();
	const services = [f.jobs({}, "first"), f.jobs({}, "second")];
	const results = await Promise.all(
		services.map(async (service, index) => {
			const target = join(f.root, `${index}.sqlite`);
			await executeBackupWorker(
				{
					action: "export",
					actor,
					config: f.config,
					profile: "conversation-state-v1",
					narratorIds: ["solo"],
					artifactPath: target,
					stagingPath: `${target}.staging`,
				},
				signal(),
			);
			return f.upload(service, await new Blob([await readFile(target)]).arrayBuffer());
		}),
	);
	expect(results.map((result) => result.verifiedSameInstance)).toEqual([true, true]);
});

test("private proof path and file permissions are checked, not uploaded path/identity claims", async () => {
	const f = await fixture();
	const backup = await f.exported();
	const actual = f.config.proofDirectory ?? "";
	if (process.platform !== "win32") {
		await chmod(join(actual, "attestation-v1.key"), 0o644);
		await expect(f.upload(f.jobs(), backup.bytes)).rejects.toThrow();
		await chmod(join(actual, "attestation-v1.key"), 0o600);
		const alias = join(f.root, "proof-alias");
		await symlink(actual, alias);
		await expect(f.upload(f.jobs({ proofDirectory: alias }), backup.bytes)).rejects.toThrow();
	}
	await expect(
		f.upload(f.jobs({ proofDirectory: "relative-proof" }), backup.bytes),
	).rejects.toThrow();
});

test("signed worker jobs still enforce cancellation and oversized state rows", async () => {
	const f = await fixture();
	const controller = new AbortController();
	controller.abort();
	await expect(
		executeBackupWorker(
			{
				action: "plan",
				actor,
				config: f.config,
				narratorIds: ["solo"],
				profile: "conversation-state-v1",
			},
			controller.signal,
		),
	).rejects.toThrow();
	f.db
		.prepare("UPDATE narrator_messages SET content_json=?")
		.run(JSON.stringify([{ type: "text", text: "x".repeat(LIMITS.rowBytes) }]));
	await expect(
		executeBackupWorker(
			{
				action: "export",
				actor,
				config: f.config,
				narratorIds: ["solo"],
				profile: "conversation-state-v1",
				artifactPath: join(f.root, "oversized.sqlite"),
				stagingPath: join(f.root, "oversized.staging"),
			},
			signal(),
		),
	).rejects.toThrow();
	await expect(stat(join(f.root, "oversized.sqlite"))).rejects.toThrow();
});

test("real signed export rejects state row-count overflow without materializing or publishing", async () => {
	const f = await fixture();
	f.db
		.prepare(
			"WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<?) INSERT INTO narrator_whitelist_cmds(id,narrator_id,pattern,enabled) SELECT 'rule-'||value,'solo','echo',1 FROM n",
		)
		.run(LIMITS.stateRows + 1);
	const before = JSON.stringify(f.db.prepare("SELECT * FROM narrator_message_refs").all());
	await expect(
		executeBackupWorker(
			{
				action: "export",
				actor,
				config: f.config,
				narratorIds: ["solo"],
				profile: "conversation-state-v1",
				artifactPath: join(f.root, "row-overflow.sqlite"),
				stagingPath: join(f.root, "row-overflow.staging"),
			},
			signal(),
		),
	).rejects.toThrow();
	expect(JSON.stringify(f.db.prepare("SELECT * FROM narrator_message_refs").all())).toBe(before);
	await expect(stat(join(f.root, "row-overflow.sqlite"))).rejects.toThrow();
}, 30_000);

test("signed uploaded payload changes after successful preview still fail actual apply and owned download", async () => {
	const f = await fixture();
	const backup = await f.exported();
	f.erase();
	const service = f.jobs();
	const uploaded = await f.upload(service, backup.bytes);
	expect(
		(await service.previewNarratorRestore(actor, uploaded)).sameInstanceStateRestoreAllowed,
	).toBe(true);
	const artifact = new Database(join(f.root, "backups", `${uploaded.artifactId}.sqlite`));
	try {
		artifact.run(
			"UPDATE state_rows SET json=replace(json,'offline conversation','changed after preview') WHERE table_name='narrators'",
		);
	} finally {
		artifact.close();
	}
	await expect(service.restoreNarratorState(actor, uploaded)).rejects.toThrow();
	await expect(service.download(actor, uploaded.artifactId, signal())).rejects.toThrow();
	expect(f.db.prepare("SELECT id FROM narrators").all()).toEqual([]);
});

test("demoted authenticated exporting administrator retains source provenance, never global restore permission", async () => {
	const f = await fixture();
	const admin = { userId: "admin", isAdmin: true };
	const path = join(f.root, "admin.sqlite");
	await executeBackupWorker(
		{
			action: "export",
			actor: admin,
			config: f.config,
			narratorIds: ["solo"],
			profile: "conversation-state-v1",
			artifactPath: path,
			stagingPath: `${path}.staging`,
		},
		signal(),
	);
	f.erase();
	f.db.run("UPDATE users SET role='user' WHERE id='admin'");
	const service = f.jobs();
	const uploaded = await f.upload(
		service,
		await new Blob([await readFile(path)]).arrayBuffer(),
		admin,
	);
	expect(uploaded.verifiedSameInstance).toBe(true);
	const preview = await service.previewNarratorRestore(admin, uploaded);
	expect(preview.sameInstanceStateRestoreAllowed).toBe(false);
	await expect(service.restoreNarratorState(admin, uploaded)).rejects.toThrow();
	await expect(service.download(admin, uploaded.artifactId, signal())).rejects.toThrow();
	expect(f.db.prepare("SELECT id FROM narrators").all()).toEqual([]);
});
