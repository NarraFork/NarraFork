import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NarratorBackupJob } from "@shared/narrator-backup";
import { Hono } from "hono";
import { narratorBackupsApi } from "../../../frontend/lib/api/narrator-backups";
import * as fileDownload from "../../../frontend/lib/file-download";
import { AppError } from "../../lib/errors";
import { NarratorBackupJobs } from "../narrator-backup/jobs";
import { productionBackupSchema } from "../narrator-backup/production-fixture.test-helper";

let jobs: NarratorBackupJobs;
const realRuntime = { ...(await import("../narrator-backup/runtime")) };
const bridge = new Proxy({} as NarratorBackupJobs, {
	get(_target, key) {
		const value = Reflect.get(jobs, key);
		return typeof value === "function" ? value.bind(jobs) : value;
	},
});
mock.module("../narrator-backup/runtime", () => ({ ...realRuntime, narratorBackupJobs: bridge }));
const { narratorBackupRoutes } = await import("../../routes/narrator-backups");
let root: string;
let db: Database;
let actor = "alice";
let sourceInstanceId = "fixture-instance";
const originals = new Map<string, PropertyDescriptor | undefined>();
let saved: ReturnType<typeof spyOn<typeof fileDownload, "saveBlobAsFile">>;
const urls: string[] = [];
function install(name: string, value: unknown) {
	originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
beforeEach(async () => {
	actor = "alice";
	sourceInstanceId = "fixture-instance";
	urls.length = 0;
	root = await mkdtemp(join(tmpdir(), "nf-backup-entry-fixture-"));
	const databasePath = join(root, "source.sqlite");
	await writeFile(databasePath, productionBackupSchema);
	db = new Database(databasePath);
	db.run("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=250;");
	const now = new Date().toISOString();
	for (const id of ["alice", "reader"])
		db.prepare(
			"INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,'user',?)",
		).run(id, id, "fixture-only-password", now);
	const workspace = join(root, "workspace");
	const dataDirectory = join(root, "private-data");
	await mkdir(workspace);
	await mkdir(dataDirectory, { mode: 0o700 });
	await writeFile(join(workspace, "sentinel.txt"), "fixture workspace must stay untouched");
	await writeFile(join(dataDirectory, "settings.json"), JSON.stringify({ agent: {} }), {
		mode: 0o600,
	});
	db.prepare(
		"INSERT INTO narrators(id,type,title,owner_user_id,visibility,write_audience,status,traits,variant,cwd,workspace_revision,created_at,updated_at,next_seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		"solo",
		"primary",
		"private standalone",
		"alice",
		"public",
		"owner",
		"working",
		"[]",
		"primary",
		join(root, "workspace"),
		0,
		now,
		now,
		2,
	);
	db.prepare(
		"INSERT INTO narrator_messages(id,narrator_id,role,content_json,created_at) VALUES(?,?,?,?,?)",
	).run(
		"message",
		"solo",
		"assistant",
		JSON.stringify([{ type: "text", text: "private transcript" }]),
		now,
	);
	db.run(
		"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq,is_compact) VALUES('ref','solo','message',1,0)",
	);
	jobs = new NarratorBackupJobs({
		root: join(root, "backups"),
		config: async () => ({
			backend: "sqlite",
			databasePath,
			sourceInstanceId,
			proofDirectory: join(dataDirectory, "narrator-backup-proof"),
			settingsPath: join(dataDirectory, "settings.json"),
			dataDirectory,
			objectSource: {
				shadowRoot: join(dataDirectory, "tree-snapshots"),
				uploadsRoot: join(dataDirectory, "uploads"),
				blobRoot: join(dataDirectory, "file-change-blobs"),
				journalRoot: join(dataDirectory, "worktree-requests"),
			},
		}),
	});
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: actor, role: "user", iat: 0, exp: 2_147_483_647 });
		await next();
	});
	app.onError(
		(error) =>
			new Response(JSON.stringify({ error: error.message }), {
				status: error instanceof AppError ? error.statusCode : 500,
				headers: { "Content-Type": "application/json" },
			}),
	);
	app.route("/api/narrator-backups", narratorBackupRoutes);
	install("localStorage", { getItem: () => "fixture-session-token" });
	install("showSaveFilePicker", undefined);
	install("fetch", (url: string, init?: RequestInit) => {
		urls.push(url);
		return app.request(url, init);
	});
	saved = spyOn(fileDownload, "saveBlobAsFile").mockImplementation(() => {});
});
afterEach(async () => {
	saved?.mockRestore();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
	db.close();
	await rm(root, { recursive: true, force: true });
});
afterAll(() => {
	mock.module("../narrator-backup/runtime", () => realRuntime);
});
async function settled(job: NarratorBackupJob) {
	let current = job;
	const deadline = Date.now() + 10_000;
	while (["queued", "running"].includes(current.status) && Date.now() < deadline) {
		await Bun.sleep(10);
		current = await narratorBackupsApi.job(current.jobId);
	}
	return current;
}
async function completed(job: NarratorBackupJob) {
	const current = await settled(job);
	expect(current.status, current.error).toBe("completed");
	return current.artifactId as string;
}

describe("backup entry real API / route / worker integration (fixture only)", () => {
	test("standalone export download → owned preview → deleted-ID state restore needs no project and starts nothing", async () => {
		const request = { narratorIds: ["solo"], profile: "conversation-state-v1" as const };
		expect(await narratorBackupsApi.plan(request)).toMatchObject({
			productionDiskRestoreAllowed: false,
			narratorIds: ["solo"],
		});
		const artifactId = await completed(await narratorBackupsApi.export(request));
		await narratorBackupsApi.download(artifactId);
		expect(saved.mock.calls[0]?.[0].size).toBeGreaterThan(0);
		expect(saved.mock.calls[0]?.[0].size).toBeLessThan(1024 * 1024);
		const conflict = await narratorBackupsApi.preview({ artifactId });
		expect(conflict.sameInstanceStateRestoreAllowed).toBe(false);
		expect(conflict.blockers.length).toBeGreaterThan(0);
		db.run(
			"DELETE FROM narrator_message_refs; DELETE FROM narrator_messages; DELETE FROM narrators;",
		);
		const preview = await narratorBackupsApi.preview({ artifactId });
		expect(preview).toMatchObject({
			verifiedSameInstance: true,
			sameInstanceStateRestoreAllowed: true,
			crossInstanceApplySupported: false,
			productionDiskRestoreAllowed: false,
			manualActivationRequired: true,
			blockers: [],
		});
		expect(await narratorBackupsApi.restore({ artifactId })).toMatchObject({
			narratorIds: ["solo"],
			status: "archived",
			manualActivationRequired: true,
			productionDiskRestoreAllowed: false,
		});
		expect(db.query("SELECT status FROM narrators WHERE id='solo'").get()).toEqual({
			status: "archived",
		});
		expect(db.query("SELECT content_json FROM narrator_messages WHERE id='message'").get()).toEqual(
			{ content_json: JSON.stringify([{ type: "text", text: "private transcript" }]) },
		);
		expect(existsSync(join(root, "workspace"))).toBe(true);
		expect(await readFile(join(root, "workspace", "sentinel.txt"), "utf8")).toBe(
			"fixture workspace must stay untouched",
		);
		expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
		expect(db.query("SELECT count(*) AS n FROM projects").get()).toEqual({ n: 0 });
		expect(db.query("SELECT count(*) AS n FROM chapters").get()).toEqual({ n: 0 });
		expect(
			urls.every((url) => url.startsWith("/api/narrator-backups/") && !url.includes("token=")),
		).toBe(true);
	});
	test("public readers cannot export or download another actor's private artifact", async () => {
		const artifactId = await completed(
			await narratorBackupsApi.export({ narratorIds: ["solo"], profile: "conversation-state-v1" }),
		);
		actor = "reader";
		await expect(
			narratorBackupsApi.plan({ narratorIds: ["solo"], profile: "conversation-state-v1" }),
		).rejects.toThrow();
		const denied = await settled(
			await narratorBackupsApi.export({ narratorIds: ["solo"], profile: "conversation-state-v1" }),
		);
		expect(denied.status).toBe("failed");
		expect(denied.artifactId).toBeUndefined();
		await expect(narratorBackupsApi.download(artifactId)).rejects.toThrow();
		expect(saved).not.toHaveBeenCalled();
	});
	test("foreign-instance uploaded bytes remain preview-only; mappings cannot enable cross-instance apply", async () => {
		const artifactId = await completed(
			await narratorBackupsApi.export({ narratorIds: ["solo"], profile: "conversation-state-v1" }),
		);
		await narratorBackupsApi.download(artifactId);
		const blob = saved.mock.calls[0]?.[0];
		if (!blob) throw new Error("Missing fixture download");
		// Persistent same-instance signatures legitimately survive a reupload. Switch
		// the receiving fixture's actual instance identity to exercise the foreign gate.
		sourceInstanceId = "foreign-receiving-fixture";
		const uploaded = await narratorBackupsApi.upload(new File([blob], "fixture.sqlite"));
		expect(uploaded.verifiedSameInstance).toBe(false);
		const preview = await narratorBackupsApi.preview({
			artifactId: uploaded.artifactId,
			mapping: { users: { alice: "alice" } },
		});
		expect(preview.verifiedSameInstance).toBe(false);
		expect(preview.crossInstanceApplySupported).toBe(false);
		expect(preview.sameInstanceStateRestoreAllowed).toBe(false);
		await expect(narratorBackupsApi.restore({ artifactId: uploaded.artifactId })).rejects.toThrow();
	});
	test("unowned artifact IDs never give guessed-path or cross-account access", async () => {
		await expect(narratorBackupsApi.preview({ artifactId: randomUUID() })).rejects.toThrow();
	});
});
