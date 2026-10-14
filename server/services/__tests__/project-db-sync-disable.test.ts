import { afterEach, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, sqlite } from "../../db";
import { legacyProjectMigrations, legacyProjectSyncTombstones, projects } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { projectDbManager } from "../../lib/project-db";
import { projectDbRoutes } from "../../routes/project-db";
import { exportLegacyProjectOnWorker } from "../project-archive/legacy-sync-job";
import * as workerClient from "../project-archive/worker-client";
import { fullSync, syncProject } from "../project-db-sync";
import {
	disableLegacyProjectSync,
	__testing as gateTesting,
	legacySyncInFlight,
	onLegacySyncDisabled,
	trackedLegacyProjectSync,
} from "../project-db-sync-coordinator";

const ids: string[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const id of ids.splice(0)) {
		projectDbManager.close(id);
		await db.delete(projects).where(eq(projects.id, id));
		await db.delete(legacyProjectMigrations).where(eq(legacyProjectMigrations.projectId, id));
		await db
			.delete(legacyProjectSyncTombstones)
			.where(eq(legacyProjectSyncTombstones.projectId, id));
	}
	gateTesting.resetGateForRestart();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function fixture(path?: string, disabled = false) {
	const id = generateId();
	const gitPath = path ?? mkdtempSync(join(tmpdir(), "nf-sync-disable-"));
	if (!path) dirs.push(gitPath);
	ids.push(id);
	const now = new Date().toISOString();
	await db.insert(projects).values({
		id,
		name: "sync retirement",
		gitPath,
		legacySyncDisabled: disabled,
		createdAt: now,
		updatedAt: now,
	});
	return { id, gitPath };
}
async function receipt(projectId: string, archivePath: string | null) {
	const now = new Date().toISOString();
	await db.insert(legacyProjectMigrations).values({
		projectId,
		projectName: "retired",
		archivePath,
		actorUserId: "fixture-admin",
		phase: "completed",
		revision: "fixture",
		narratorIds: [],
		chapterTargets: {},
		createdAt: now,
		updatedAt: now,
	});
}

function deferred() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

test("disable is persistent, idempotent, and blocks cached/direct/manual/event sync", async () => {
	const { id, gitPath } = await fixture();
	const conn = await projectDbManager.getDb(id);
	expect(conn).not.toBeNull();
	expect(await disableLegacyProjectSync(id)).toEqual({ syncDisabled: true, drained: true });
	expect(await disableLegacyProjectSync(id)).toEqual({ syncDisabled: true, drained: true });
	expect(
		(await db.query.projects.findFirst({ where: eq(projects.id, id) }))?.legacySyncDisabled,
	).toBe(true);
	expect(await projectDbManager.getDb(id)).toBeNull();
	await expect(projectDbManager.openForGitPath(id, gitPath)).rejects.toThrow("disabled");
	await expect(fullSync(id)).rejects.toThrow("disabled");
	await syncProject(id);
	expect(() => conn?.query("SELECT 1").get()).toThrow();
});

test("retirement closes drained handles without issuing an explicit WAL checkpoint", async () => {
	const { id } = await fixture();
	const conn = await projectDbManager.getDb(id);
	if (!conn) throw new Error("missing connection");
	const run = spyOn(conn, "run");
	const ordinaryClose = spyOn(projectDbManager, "close");
	try {
		expect((await disableLegacyProjectSync(id)).drained).toBe(true);
		expect(ordinaryClose.mock.calls.length).toBe(0);
		expect(run.mock.calls.some(([sql]) => /wal_checkpoint/i.test(sql))).toBe(false);
		expect(() => conn.query("SELECT 1").get()).toThrow();
	} finally {
		run.mockRestore();
		ordinaryClose.mockRestore();
	}
});

test("persisted flag is checked without a prior local disable call (restart admission)", async () => {
	const { id, gitPath } = await fixture(undefined, true);
	expect(await projectDbManager.getDb(id)).toBeNull();
	await expect(projectDbManager.openForGitPath(id, gitPath)).rejects.toThrow("disabled");
});

test("drain timeout never closes a connection held across awaits, and retry can finish", async () => {
	const { id } = await fixture();
	const started = deferred();
	const held = deferred();
	let cancelled = false;
	const operation = trackedLegacyProjectSync(id, async (signal) => {
		const conn = await projectDbManager.getDb(id);
		if (!conn) throw new Error("missing connection");
		signal.addEventListener("abort", () => {
			cancelled = true;
		});
		started.release();
		await held.promise;
		expect(conn.query("SELECT 1 AS value").get()).toEqual({ value: 1 });
	});
	await started.promise;
	expect(await disableLegacyProjectSync(id, 5)).toEqual({ syncDisabled: true, drained: false });
	expect(cancelled).toBe(true);
	held.release();
	await operation;
	expect(await disableLegacyProjectSync(id)).toEqual({ syncDisabled: true, drained: true });
});

test("operation errors cannot reopen the disabled gate", async () => {
	const { id } = await fixture();
	const started = deferred();
	const held = deferred();
	const operation = trackedLegacyProjectSync(id, async () => {
		started.release();
		await held.promise;
		throw new Error("sync failed");
	});
	const rejected = operation.catch((error: unknown) => error);
	await started.promise;
	const disabling = disableLegacyProjectSync(id);
	held.release();
	expect(await rejected).toBeInstanceOf(Error);
	expect(((await rejected) as Error).message).toBe("sync failed");
	expect(await disabling).toEqual({ syncDisabled: true, drained: true });
	expect(await trackedLegacyProjectSync(id, async () => "unexpected")).toBeUndefined();
});

test("same physical path aliases cannot resume archive writes and are drained together", async () => {
	const a = await fixture();
	const parent = mkdtempSync(join(tmpdir(), "nf-sync-alias-"));
	dirs.push(parent);
	const alias = join(parent, "alias");
	symlinkSync(a.gitPath, alias, "dir");
	const b = await fixture(alias);
	const started = deferred();
	const held = deferred();
	const operation = trackedLegacyProjectSync(b.id, async () => {
		const conn = await projectDbManager.getDb(b.id);
		started.release();
		await held.promise;
		expect(conn?.query("SELECT 1 AS value").get()).toEqual({ value: 1 });
	});
	await started.promise;
	expect(legacySyncInFlight(a.id)).toBe(false);
	expect(legacySyncInFlight(a.id, null)).toBe(false);
	expect(legacySyncInFlight(a.id, a.gitPath)).toBe(true);
	expect(legacySyncInFlight(a.id, alias)).toBe(true);
	expect(legacySyncInFlight(b.id)).toBe(true);
	expect(legacySyncInFlight(a.id, parent)).toBe(false);
	expect(await disableLegacyProjectSync(a.id, 5)).toEqual({ syncDisabled: true, drained: false });
	expect(legacySyncInFlight(a.id, realpathSync(a.gitPath))).toBe(true);
	expect(await projectDbManager.getDb(b.id)).toBeNull();
	held.release();
	await operation;
	expect(legacySyncInFlight(a.id, a.gitPath)).toBe(false);
	expect(legacySyncInFlight(b.id)).toBe(false);
	expect((await disableLegacyProjectSync(a.id)).drained).toBe(true);
	const c = await fixture(a.gitPath);
	await expect(projectDbManager.openForGitPath(c.id, a.gitPath)).rejects.toThrow("disabled");
});

test("worker terminate finally must settle before drain succeeds", async () => {
	const { id, gitPath } = await fixture();
	const terminating = deferred();
	const terminated = deferred();
	const worker = new EventEmitter() as EventEmitter & {
		postMessage: () => void;
		terminate: () => Promise<number>;
	};
	worker.postMessage = () => {
		queueMicrotask(() => worker.emit("message", { value: { tables: {} } }));
	};
	worker.terminate = async () => {
		terminating.release();
		await terminated.promise;
		return 0;
	};
	const start = spyOn(workerClient, "startPrivateArchiveWorker").mockResolvedValue(
		worker as unknown as Worker,
	);
	try {
		const exporting = exportLegacyProjectOnWorker({
			projectId: id,
			databasePath: ":memory:",
			archivePath: join(gitPath, "unused.db"),
			backend: "sqlite",
			deadline: Date.now() + 30_000,
		});
		await terminating.promise;
		expect(await disableLegacyProjectSync(id, 5)).toEqual({ syncDisabled: true, drained: false });
		terminated.release();
		await exporting;
		expect((await disableLegacyProjectSync(id)).drained).toBe(true);
	} finally {
		terminated.release();
		start.mockRestore();
	}
});

test("failed worker termination keeps the operation tracked until actual exit", async () => {
	const { id, gitPath } = await fixture();
	const terminating = deferred();
	const worker = new EventEmitter() as EventEmitter & {
		postMessage: () => void;
		terminate: () => Promise<number>;
	};
	worker.postMessage = () => {
		queueMicrotask(() => worker.emit("message", { value: { tables: {} } }));
	};
	worker.terminate = async () => {
		terminating.release();
		throw new Error("terminate failed");
	};
	const start = spyOn(workerClient, "startPrivateArchiveWorker").mockResolvedValue(
		worker as unknown as Worker,
	);
	try {
		const exporting = exportLegacyProjectOnWorker({
			projectId: id,
			databasePath: ":memory:",
			archivePath: join(gitPath, "unused.db"),
			backend: "sqlite",
			deadline: Date.now() + 30_000,
		});
		const rejected = exporting.catch((error: unknown) => error);
		await terminating.promise;
		expect((await disableLegacyProjectSync(id, 5)).drained).toBe(false);
		worker.emit("exit", 1);
		expect(await rejected).toBeInstanceOf(Error);
		expect(((await rejected) as Error).message).toBe("terminate failed");
		expect((await disableLegacyProjectSync(id)).drained).toBe(true);
	} finally {
		worker.emit("exit", 1);
		start.mockRestore();
	}
});

test("root persistence failure rolls back the disabled flag and does not install a latch", async () => {
	const { id, gitPath } = await fixture();
	// tests/preload.ts owns this isolated DB; the temporary trigger touches no user data.
	sqlite.run(
		"CREATE TEMP TRIGGER test_legacy_sync_tombstone_failure BEFORE INSERT ON legacy_project_sync_tombstones BEGIN SELECT RAISE(ABORT, 'fixture root persistence failed'); END",
	);
	try {
		await expect(disableLegacyProjectSync(id)).rejects.toThrow();
		expect(
			(await db.query.projects.findFirst({ where: eq(projects.id, id) }))?.legacySyncDisabled,
		).toBe(false);
		expect(
			await db.query.legacyProjectSyncTombstones.findFirst({
				where: eq(legacyProjectSyncTombstones.canonicalRoot, realpathSync(gitPath)),
			}),
		).toBeUndefined();
		expect(await trackedLegacyProjectSync(id, async () => "still allowed")).toBe("still allowed");
	} finally {
		sqlite.run("DROP TRIGGER test_legacy_sync_tombstone_failure");
	}
});

test("standalone disable root survives path changes, project deletion and coordinator restart", async () => {
	const retired = await fixture();
	const oldRoot = realpathSync(retired.gitPath);
	expect((await disableLegacyProjectSync(retired.id)).drained).toBe(true);
	const firstTombstone = await db.query.legacyProjectSyncTombstones.findFirst({
		where: eq(legacyProjectSyncTombstones.canonicalRoot, oldRoot),
	});
	expect(firstTombstone?.projectId).toBe(retired.id);
	expect(
		await db.query.legacyProjectMigrations.findFirst({
			where: eq(legacyProjectMigrations.projectId, retired.id),
		}),
	).toBeUndefined();
	const moved = await fixture();
	await db.update(projects).set({ gitPath: moved.gitPath }).where(eq(projects.id, retired.id));
	// Repeated disable on the new root must never replace or remove the original tombstone.
	await disableLegacyProjectSync(retired.id);
	expect(
		await db.query.legacyProjectSyncTombstones.findFirst({
			where: eq(legacyProjectSyncTombstones.canonicalRoot, oldRoot),
		}),
	).toEqual(firstTombstone);
	await db.delete(projects).where(eq(projects.id, retired.id));
	gateTesting.resetGateForRestart();
	const recreated = await fixture(retired.gitPath);
	expect(await projectDbManager.getDb(recreated.id)).toBeNull();
	await expect(projectDbManager.openForGitPath(recreated.id, retired.gitPath)).rejects.toThrow(
		"disabled",
	);
	await expect(fullSync(recreated.id)).rejects.toThrow("disabled");
	expect(await trackedLegacyProjectSync(recreated.id, async () => "unexpected")).toBeUndefined();
});

test("a newly persisted standalone root tombstone blocks an already admitted project", async () => {
	const { id, gitPath } = await fixture();
	expect(await projectDbManager.getDb(id)).not.toBeNull();
	const retiredId = generateId();
	ids.push(retiredId);
	await db.insert(legacyProjectSyncTombstones).values({
		canonicalRoot: realpathSync(gitPath),
		projectId: retiredId,
		disabledAt: new Date().toISOString(),
	});
	expect(await projectDbManager.getDb(id)).toBeNull();
	await expect(fullSync(id)).rejects.toThrow("disabled");
});

test("receipt path tombstone survives project deletion and coordinator restart", async () => {
	const retired = await fixture();
	await receipt(retired.id, realpathSync(retired.gitPath));
	await db.delete(projects).where(eq(projects.id, retired.id));
	gateTesting.resetGateForRestart();
	const recreated = await fixture(retired.gitPath);
	expect(await projectDbManager.getDb(recreated.id)).toBeNull();
	await expect(projectDbManager.openForGitPath(recreated.id, retired.gitPath)).rejects.toThrow(
		"disabled",
	);
	await expect(fullSync(recreated.id)).rejects.toThrow("disabled");
});

test("receipt project ID tombstone blocks a recreated ID even with a different root", async () => {
	const { id, gitPath } = await fixture();
	await receipt(id, realpathSync(gitPath));
	await db.delete(projects).where(eq(projects.id, id));
	const replacement = await fixture();
	const now = new Date().toISOString();
	await db.insert(projects).values({
		id,
		name: "recreated ID",
		gitPath: replacement.gitPath,
		createdAt: now,
		updatedAt: now,
	});
	gateTesting.resetGateForRestart();
	expect(await projectDbManager.getDb(id)).toBeNull();
	await expect(projectDbManager.openForGitPath(id, replacement.gitPath)).rejects.toThrow(
		"disabled",
	);
	expect(await trackedLegacyProjectSync(id, async () => "unexpected")).toBeUndefined();
});

test("a new receipt blocks previously admitted cached connections without a TTL window", async () => {
	const { id, gitPath } = await fixture();
	const retiredId = generateId();
	ids.push(retiredId);
	expect(await projectDbManager.getDb(id)).not.toBeNull();
	await receipt(retiredId, realpathSync(gitPath));
	expect(await projectDbManager.getDb(id)).toBeNull();
	await expect(projectDbManager.openForGitPath(id, gitPath)).rejects.toThrow("disabled");
	expect(await trackedLegacyProjectSync(id, async () => "unexpected")).toBeUndefined();
});

test("disabled symlink aliases are restored once rather than scanned on every admission", async () => {
	const allowed = await fixture();
	const root = await fixture();
	const parent = mkdtempSync(join(tmpdir(), "nf-sync-startup-alias-"));
	dirs.push(parent);
	const alias = join(parent, "alias");
	symlinkSync(root.gitPath, alias, "dir");
	await fixture(alias, true);
	gateTesting.resetGateForRestart();
	const scans = spyOn(db, "select");
	try {
		expect(await projectDbManager.getDb(allowed.id)).not.toBeNull();
		const firstScanCount = scans.mock.calls.length;
		expect(firstScanCount).toBe(1);
		for (let index = 0; index < 4; index++)
			expect(await projectDbManager.getDb(allowed.id)).not.toBeNull();
		expect(scans.mock.calls.length).toBe(firstScanCount);
		expect(await projectDbManager.getDb(root.id)).toBeNull();
		expect(scans.mock.calls.length).toBe(firstScanCount);
		await disableLegacyProjectSync(allowed.id);
		expect(await projectDbManager.getDb(allowed.id)).toBeNull();
	} finally {
		scans.mockRestore();
	}
});

test("hot module re-evaluation retains old writers, manager handles, latches and startup promise", async () => {
	const { id, gitPath } = await fixture();
	const other = await fixture();
	const started = deferred();
	const held = deferred();
	const scans = spyOn(db, "select");
	const operation = trackedLegacyProjectSync(id, async () => {
		const conn = await projectDbManager.getDb(id);
		if (!conn) throw new Error("missing connection");
		started.release();
		await held.promise;
		expect(conn.query("SELECT 1 AS value").get()).toEqual({ value: 1 });
	});
	try {
		await started.promise;
		const initialScans = scans.mock.calls.length;
		expect(initialScans).toBe(1);
		const reloadPath = `../project-db-sync-coordinator.ts?hot-contract=${generateId()}`;
		const reloaded: typeof import("../project-db-sync-coordinator") = await import(reloadPath);
		const managerPath = `../../lib/project-db.ts?hot-contract=${generateId()}`;
		const reloadedManager: typeof import("../../lib/project-db") = await import(managerPath);
		expect(reloadedManager.projectDbManager).toBe(projectDbManager);
		expect(reloaded.legacySyncInFlight(id, gitPath)).toBe(true);
		expect(() => reloaded.__testing.resetGateForRestart()).toThrow("active");
		expect(await reloaded.isLegacyProjectSyncAllowed(other.id)).toBe(true);
		expect(scans.mock.calls.length).toBe(initialScans);
		expect(await reloaded.disableLegacyProjectSync(id, 5)).toEqual({
			syncDisabled: true,
			drained: false,
		});
		held.release();
		await operation;
		expect(reloaded.legacySyncInFlight(id, gitPath)).toBe(false);
		expect(await reloaded.disableLegacyProjectSync(id)).toEqual({
			syncDisabled: true,
			drained: true,
		});
		// Only the durable hot-safe latch, not the DB flag, can block this unsupported reset.
		await db.update(projects).set({ legacySyncDisabled: false }).where(eq(projects.id, id));
		expect(await reloaded.isLegacyProjectSyncAllowed(id)).toBe(false);
		expect(await trackedLegacyProjectSync(id, async () => "unexpected")).toBeUndefined();
		expect(await reloadedManager.projectDbManager.getDb(id)).toBeNull();
	} finally {
		held.release();
		await operation;
		scans.mockRestore();
	}
});

test("hot-safe keyed listener replacement disposes old scheduler registration without leaks", async () => {
	const { id } = await fixture();
	let oldCalls = 0;
	let newCalls = 0;
	let disposed = 0;
	const key = `test-listener-${generateId()}`;
	const unsubscribeOld = onLegacySyncDisabled(
		() => {
			oldCalls++;
		},
		key,
		() => {
			disposed++;
		},
	);
	const reloadPath = `../project-db-sync-coordinator.ts?hot-listener=${generateId()}`;
	const reloaded: typeof import("../project-db-sync-coordinator") = await import(reloadPath);
	const unsubscribeNew = reloaded.onLegacySyncDisabled(() => {
		newCalls++;
	}, key);
	try {
		expect(disposed).toBe(1);
		unsubscribeOld();
		await disableLegacyProjectSync(id);
		expect(oldCalls).toBe(0);
		expect(newCalls).toBe(1);
		unsubscribeNew();
		await disableLegacyProjectSync(id);
		expect(newCalls).toBe(1);
	} finally {
		unsubscribeOld();
		unsubscribeNew();
	}
});

test("disable route requires manage authority", async () => {
	const { id } = await fixture();
	const app = new Hono()
		.use("*", async (c, next) => {
			c.set("user", {
				sub: "fixture-admin",
				role: c.req.header("x-admin") ? "admin" : "user",
				iat: 0,
				exp: 9999999999,
			});
			await next();
		})
		.route("/projects", projectDbRoutes)
		.onError((error, c) => {
			if (error instanceof AppError)
				return c.json({ error: error.message }, error.statusCode as 403);
			throw error;
		});
	const denied = await app.request(`/projects/${id}/legacy-sync/disable`, { method: "POST" });
	expect(denied.status).not.toBe(200);
	expect(
		(await db.query.projects.findFirst({ where: eq(projects.id, id) }))?.legacySyncDisabled,
	).toBe(false);
	const allowed = await app.request(`/projects/${id}/legacy-sync/disable`, {
		method: "POST",
		headers: { "x-admin": "true" },
	});
	expect(allowed.status).toBe(200);
	expect(await allowed.json()).toEqual({ syncDisabled: true, drained: true });
});
