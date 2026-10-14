import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { testEnvironment } from "../../tests/preload";
import {
	createLegacySnapshotMembershipReader,
	readLegacySnapshotMembership,
} from "./legacy-retained-snapshot-membership";
import {
	LEGACY_SNAPSHOT_MEMBERSHIP_LIMITS,
	type LegacySnapshotMembershipInput,
	legacyManifestProvesModernOperations,
	legacySnapshotManifestContains,
} from "./legacy-retained-snapshot-membership-contract";

const input: LegacySnapshotMembershipInput = {
	databasePath: "unused",
	artifactId: "claim",
	manifestDigest: "digest",
	narratorId: "reader",
	sourceChapterId: "chapter",
	workspacePath: "/original",
	artifactPath: "/shadow",
	shadowKey: "key",
	sha: "a".repeat(40),
};
const manifest = () => ({
	version: 1,
	chapters: [],
	assets: [
		{
			kind: "shadow",
			sourceChapterId: "chapter",
			deviceId: "local",
			workspacePath: "/original",
			artifactPath: "/shadow",
			shadowKey: "key",
		},
	],
	references: {
		narrator_messages: [
			{ id: "message", narrator_id: "original-owner", snapshot_commit_sha: input.sha },
		],
		narrator_message_refs: [{ narrator_id: "reader", message_id: "message" }],
	},
});

test("linear shared-ref membership binds exact historical SHA and matching shadow", () => {
	const raw = JSON.stringify(manifest());
	expect(legacySnapshotManifestContains(raw, input)).toBe(true);
	for (const change of [
		{ sha: "b".repeat(40) },
		{ narratorId: "foreign" },
		{ shadowKey: "other" },
		{ sourceChapterId: "other" },
		{ workspacePath: "/current" },
		{ artifactPath: "/foreign" },
	])
		expect(legacySnapshotManifestContains(raw, { ...input, ...change })).toBe(false);
});
test("overbudget, malformed and excessive row manifests cannot authorize objects", () => {
	for (const raw of [
		"{",
		"null",
		"{}",
		JSON.stringify({ ...manifest(), references: [] }),
		JSON.stringify({ ...manifest(), padding: "x".repeat(LEGACY_SNAPSHOT_MEMBERSHIP_LIMITS.bytes) }),
		JSON.stringify({
			...manifest(),
			chapters: Array.from({ length: LEGACY_SNAPSHOT_MEMBERSHIP_LIMITS.rows + 1 }, () => ({})),
		}),
	])
		expect(legacySnapshotManifestContains(raw, input)).toBe(false);
});
test("reused scope classification separates new source PKs from retained or mixed sources without upgrading unknown", () => {
	const modern = {
		...input,
		operationSelection: { scopeId: "scope", fileKey: "file", operationIds: ["new-op"] },
	};
	const raw = JSON.stringify({
		...manifest(),
		chapters: [{ id: "chapter" }],
		references: {
			file_change_operations: [{ id: "old-op" }],
			file_change_scopes: [{ id: "scope", canonical_root: "/original" }],
		},
	});
	expect(legacyManifestProvesModernOperations(raw, modern)).toBe(true);
	for (const operationIds of [
		["old-op"],
		["new-op", "old-op"],
		[],
		Array.from({ length: 257 }, () => "new-op"),
	])
		expect(
			legacyManifestProvesModernOperations(raw, {
				...modern,
				operationSelection: { ...modern.operationSelection, operationIds },
			}),
		).toBe(false);
	for (const unknown of [
		"{",
		JSON.stringify(manifest()),
		JSON.stringify({ ...manifest(), references: {} }),
		JSON.stringify({
			...manifest(),
			chapters: [{ id: "wrong" }],
			references: { file_change_operations: [], file_change_scopes: [] },
		}),
	])
		expect(legacyManifestProvesModernOperations(unknown, modern)).toBe(false);
});

class FakeWorker extends EventEmitter {
	terminations = 0;
	terminate() {
		this.terminations++;
		return Promise.resolve(0);
	}
}
const port = (worker: FakeWorker) => worker as unknown as Pick<Worker, "once" | "terminate">;
function fixture(timeoutMs = 100) {
	const workers: FakeWorker[] = [];
	const pool = new Set<Pick<Worker, "once" | "terminate">>();
	const read = createLegacySnapshotMembershipReader({
		pool,
		timeoutMs,
		create: () => {
			const worker = new FakeWorker();
			workers.push(worker);
			return port(worker);
		},
	});
	return { read, workers, pool };
}
test("a true response is unusable until successful exit; nonzero or missing/invalid responses refuse", async () => {
	for (const [response, code] of [
		[true, 0],
		[true, 1],
		[false, 0],
		[undefined, 0],
		[{ body: "invalid" }, 0],
	] as const) {
		const f = fixture();
		let settled = false;
		const result = f.read(input).then((value) => {
			settled = true;
			return value;
		});
		if (response !== undefined) f.workers[0].emit("message", response);
		await Promise.resolve();
		if (typeof response === "boolean") expect(settled).toBe(false);
		f.workers[0].emit("exit", code);
		expect(await result).toBe(response === true && code === 0);
		expect(f.pool.size).toBe(0);
	}
});
test("cancellation terminates but a resolved terminate promise cannot release occupied capacity", async () => {
	const f = fixture();
	const controller = new AbortController();
	const result = f.read(input, controller.signal);
	controller.abort();
	expect(await result).toBe(false);
	expect(f.workers[0].terminations).toBe(1);
	expect(f.pool.size).toBe(1);
	f.workers[0].emit("message", true);
	f.workers[0].emit("exit", 0);
	expect(f.pool.size).toBe(0);
	const aborted = new AbortController();
	aborted.abort();
	expect(await f.read(input, aborted.signal)).toBe(false);
	expect(f.workers.length).toBe(1);
});
test("two timeout/non-exiting workers hold both slots until actual exit; third request never starts", async () => {
	const f = fixture(10);
	const first = f.read(input),
		second = f.read(input);
	expect(await f.read(input)).toBe(false);
	expect(f.workers.length).toBe(2);
	expect(await first).toBe(false);
	expect(await second).toBe(false);
	expect(f.pool.size).toBe(2);
	expect(await f.read(input)).toBe(false);
	f.workers[0].emit("exit", 1);
	expect(f.pool.size).toBe(1);
	const next = f.read(input);
	f.workers[2].emit("message", true);
	f.workers[2].emit("exit", 0);
	expect(await next).toBe(true);
	f.workers[1].emit("exit", 1);
	expect(f.pool.size).toBe(0);
});
test("worker errors and constructor failure are fail closed", async () => {
	const f = fixture();
	const result = f.read(input);
	f.workers[0].emit("error", new Error("reader crash"));
	expect(await result).toBe(false);
	expect(f.pool.size).toBe(1);
	f.workers[0].emit("exit", 1);
	expect(f.pool.size).toBe(0);
	const unavailable = createLegacySnapshotMembershipReader({
		create: () => {
			throw new Error("worker unavailable");
		},
	});
	expect(await unavailable(input)).toBe(false);
});

const directories: string[] = [];
afterEach(() => {
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
test("actual readonly source classifier refuses retained, unknown, missing and wrong-file operations", async () => {
	const directory = mkdtempSync(join(testEnvironment.isolatedHome, "operation-membership-"));
	directories.push(directory);
	const databasePath = join(directory, "history.db"),
		database = new Database(databasePath);
	const raw = JSON.stringify({
		...manifest(),
		chapters: [{ id: "chapter" }],
		references: {
			file_change_operations: [{ id: "old-op" }],
			file_change_scopes: [{ id: "scope", canonical_root: "/original" }],
		},
	});
	const modern = {
		...input,
		databasePath,
		operationSelection: { scopeId: "scope", fileKey: "file", operationIds: ["new-op"] },
	};
	try {
		database.exec(`CREATE TABLE legacy_narrator_workspace_adoptions(narrator_id TEXT PRIMARY KEY, migration_project_id TEXT, proof_mode TEXT, history_digest TEXT);
		CREATE TABLE legacy_retained_history_manifests(migration_project_id TEXT PRIMARY KEY, manifest_digest TEXT, manifest_json TEXT);
		CREATE TABLE file_change_operations(id TEXT PRIMARY KEY,coverage TEXT,settlement TEXT);
		CREATE TABLE file_change_effects(id TEXT PRIMARY KEY,operation_id TEXT,scope_id TEXT,file_key TEXT,phase TEXT,settlement TEXT,outcome TEXT);
		CREATE INDEX effects_operation ON file_change_effects(operation_id);
		INSERT INTO legacy_narrator_workspace_adoptions VALUES('reader','project','retained','digest');
		INSERT INTO file_change_operations VALUES('new-op','complete','settled'),('old-op','complete','settled');
		INSERT INTO file_change_effects VALUES('new','new-op','scope','file','apply','settled','changed'),('old','old-op','scope','file','apply','settled','changed');`);
		database
			.query("INSERT INTO legacy_retained_history_manifests VALUES('project','digest',?)")
			.run(raw);
		const before = readFileSync(databasePath);
		expect(await readLegacySnapshotMembership(modern)).toBe(true);
		expect(readFileSync(databasePath)).toEqual(before);
		for (const operationIds of [["old-op"], ["new-op", "old-op"], ["missing"]])
			expect(
				await readLegacySnapshotMembership({
					...modern,
					operationSelection: { ...modern.operationSelection, operationIds },
				}),
			).toBe(false);
		expect(
			await readLegacySnapshotMembership({
				...modern,
				operationSelection: { ...modern.operationSelection, fileKey: "foreign" },
			}),
		).toBe(false);
		database.exec("UPDATE file_change_operations SET coverage='legacy_unknown' WHERE id='new-op'");
		expect(await readLegacySnapshotMembership(modern)).toBe(false);
		database.exec(
			"UPDATE file_change_operations SET coverage='complete',settlement='applying' WHERE id='new-op'",
		);
		expect(await readLegacySnapshotMembership(modern)).toBe(false);
	} finally {
		database.close();
	}
});

test("actual readonly worker admits only one matching bounded receipt and never changes SQLite data", async () => {
	const directory = mkdtempSync(join(testEnvironment.isolatedHome, "snapshot-membership-"));
	directories.push(directory);
	const databasePath = join(directory, "history.db");
	const database = new Database(databasePath);
	try {
		database.exec(`CREATE TABLE legacy_migration_artifact_claims(id TEXT PRIMARY KEY, migration_project_id TEXT, state TEXT, kind TEXT, device_id TEXT, manifest_digest TEXT, narrator_id TEXT, source_chapter_id TEXT, workspace_path TEXT, artifact_path TEXT, shadow_key TEXT);
		CREATE TABLE legacy_retained_history_manifests(migration_project_id TEXT PRIMARY KEY, manifest_digest TEXT, manifest_json TEXT);
		INSERT INTO legacy_migration_artifact_claims VALUES('claim','project','claimed','shadow','local','digest','reader','chapter','/original','/shadow','key');`);
		database
			.query("INSERT INTO legacy_retained_history_manifests VALUES('project','digest',?)")
			.run(JSON.stringify(manifest()));
		const initialBytes = readFileSync(databasePath);
		expect(await readLegacySnapshotMembership({ ...input, databasePath })).toBe(true);
		expect(
			await readLegacySnapshotMembership({ ...input, databasePath, sha: "b".repeat(40) }),
		).toBe(false);
		expect(readFileSync(databasePath)).toEqual(initialBytes);
		database.exec("BEGIN EXCLUSIVE");
		try {
			expect(await readLegacySnapshotMembership({ ...input, databasePath })).toBe(false);
		} finally {
			database.exec("ROLLBACK");
		}
		database.query("UPDATE legacy_retained_history_manifests SET manifest_json=?").run("{");
		expect(await readLegacySnapshotMembership({ ...input, databasePath })).toBe(false);
		database
			.query("UPDATE legacy_retained_history_manifests SET manifest_json=?")
			.run("x".repeat(LEGACY_SNAPSHOT_MEMBERSHIP_LIMITS.bytes + 1));
		expect(await readLegacySnapshotMembership({ ...input, databasePath })).toBe(false);
		expect(
			await readLegacySnapshotMembership({ ...input, databasePath: join(directory, "absent.db") }),
		).toBe(false);
	} finally {
		database.close();
	}
});
