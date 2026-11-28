/**
 * SQLite auth reads run on the short-read Worker pool, against a real file-backed database.
 *
 * With Workers available every read returns the same facts the main connection would; with
 * Workers disabled the reads fail instead of quietly running on the main thread.
 */
import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getTestDb } from "../../../../tests/setup";
import * as schema from "../../../db/schema";
import { userMfaBackupCodes, users, userTotp } from "../../../db/schema";
import {
	resetDbWorkerPoolForTest,
	runShortReadTask,
	setDbWorkerSpecifiersForTest,
	shutdownDbWorkerPool,
} from "../../../lib/db-worker/pool";
import { logger } from "../../../lib/logger";
import { WorkerHandle } from "../../../lib/worker-runtime/lifecycle";

const home = mkdtempSync(join(tmpdir(), "narrafork-auth-worker-read-"));
const dbFile = join(home, "auth.db");
{
	const { sqlite: template } = getTestDb();
	writeFileSync(dbFile, template.serialize());
	template.close();
}
const sqlite = new Database(dbFile);
sqlite.run("PRAGMA journal_mode = WAL");
const db = drizzle({ client: sqlite, schema });

const realDbModule = { ...(await import("../../../db")) };
mock.module("../../../db", () => ({ db, sqlite }));
const { sqliteAuthSessionStore: sessions } = await import("../sqlite-session-store");
const { sqliteAuthMfaStore: mfa } = await import("../sqlite-mfa-store");

const now = Date.now();
const userId = "u-worker";

beforeAll(async () => {
	await resetDbWorkerPoolForTest();
	db.insert(users)
		.values({
			id: userId,
			username: "worker-user",
			passwordHash: "hash-1",
			role: "admin",
			mfaEnabled: true,
			createdAt: new Date(now).toISOString(),
		})
		.run();
	await sessions.createSession({
		id: "s-1",
		userId,
		tokenHash: "token-hash-1",
		tokenVersion: 0,
		sessionStart: now,
		createdAt: now,
		expiresAt: now + 60_000,
	});
	db.insert(userTotp)
		.values({
			id: "t-1",
			userId,
			secret: "SECRET",
			status: "active",
			createdAt: new Date(now).toISOString(),
		} as typeof userTotp.$inferInsert)
		.run();
	db.insert(userMfaBackupCodes)
		.values([
			{ id: "b-1", userId, codeHash: "c1", createdAt: "x" },
			{ id: "b-2", userId, codeHash: "c2", createdAt: "x", usedAt: "y" },
			{ id: "b-3", userId, codeHash: "c3", createdAt: "x" },
		])
		.run();
});

afterEach(() => {
	delete process.env.NARRAFORK_DB_WORKER;
});

afterAll(async () => {
	await shutdownDbWorkerPool();
	mock.module("../../../db", () => realDbModule);
	mock.restore();
	sqlite.close();
	rmSync(home, { recursive: true, force: true });
});

describe("SQLite auth reads on the short-read Worker pool", () => {
	test("session reads label short-pool queue rejection diagnostics", async () => {
		await resetDbWorkerPoolForTest();
		const fixture = join(home, "hanging-worker.ts");
		writeFileSync(
			fixture,
			'import { parentPort } from "node:worker_threads"; parentPort.on("message", () => {}); parentPort.postMessage({type: "ready"});',
		);
		setDbWorkerSpecifiersForTest([fixture]);
		const posted = Promise.withResolvers<void>();
		const create = WorkerHandle.thread;
		const sends: Array<() => void> = [];
		const spawn = spyOn(WorkerHandle, "thread").mockImplementation((entry, options) => {
			const handle = create(entry, options);
			const send = handle.resource.postMessage.bind(handle.resource);
			const post = spyOn(handle.resource, "postMessage").mockImplementation((message) => {
				send(message);
				if (message.type === "task") posted.resolve();
			});
			sends.push(() => post.mockRestore());
			return handle;
		});
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		const controller = new AbortController();
		const blockers: Promise<unknown>[] = [];
		const block = () =>
			runShortReadTask(
				dbFile,
				{ kind: "selectRows", sql: "SELECT 1", params: [], maxRows: 1 },
				{ signal: controller.signal },
			).catch((error: unknown) => error);
		try {
			blockers.push(block());
			await posted.promise;
			for (let i = 0; i < 8; i++) blockers.push(block());
			const error = await sessions
				.findSessionByTokenHash("token-hash-1")
				.catch((error: unknown) => error);
			expect(error).toMatchObject({ code: "DB_READ_TASK_OVERLOADED" });
			expect(warn.mock.calls).toContainEqual([
				"Database read queue admission rejected",
				expect.objectContaining({
					source: "auth.session",
					kind: "selectRows",
					code: "TASK_QUEUE_FULL",
				}),
			]);
		} finally {
			controller.abort();
			await Promise.all(blockers);
			await resetDbWorkerPoolForTest();
			for (const restore of sends) restore();
			spawn.mockRestore();
			warn.mockRestore();
		}
	});

	test("session store reads return the live facts", async () => {
		expect(await sessions.findLoginCredential("worker-user")).toEqual({
			id: userId,
			passwordHash: "hash-1",
			mfaEnabled: true,
		});
		expect(await sessions.findLoginCredential("nobody")).toBeNull();
		expect(await sessions.findSessionState(userId)).toEqual({
			id: userId,
			role: "admin",
			tokenVersion: 0,
		});
		expect((await sessions.findSessionProfile(userId))?.username).toBe("worker-user");
		expect(await sessions.findPasswordHash(userId)).toBe("hash-1");
		const byHash = await sessions.findSessionByTokenHash("token-hash-1");
		expect(byHash?.id).toBe("s-1");
		expect(byHash?.userId).toBe(userId);
		expect((await sessions.findSessionById("s-1"))?.id).toBe("s-1");
		expect(await sessions.findSessionByTokenHash("missing")).toBeNull();
	});

	test("MFA store reads return the live facts", async () => {
		expect(await mfa.findTotp(userId, "active")).toEqual({ status: "active", secret: "SECRET" });
		expect(await mfa.findTotp(userId, "pending")).toBeNull();
		expect(await mfa.findMfaEnabled(userId)).toBe(true);
		expect(await mfa.hasAnyPasskey(userId)).toBe(false);
		expect(await mfa.countUnusedBackupCodes(userId)).toBe(2);
		expect((await mfa.findUnusedBackupCodes(userId)).map((row) => row.id).sort()).toEqual([
			"b-1",
			"b-3",
		]);
	});

	test("disabled Workers fail the read instead of running it on the main connection", async () => {
		process.env.NARRAFORK_DB_WORKER = "off";
		await resetDbWorkerPoolForTest();
		for (const read of [
			() => sessions.findSessionByTokenHash("token-hash-1"),
			() => sessions.findLoginCredential("worker-user"),
			() => mfa.countUnusedBackupCodes(userId),
		]) {
			const error = await read().then(
				() => null,
				(e: unknown) => e,
			);
			expect((error as Error)?.name).toBe("WorkersUnavailableError");
		}
	});

	test("an already-aborted request never reaches the pool", async () => {
		const controller = new AbortController();
		controller.abort();
		const error = await sessions
			.findSessionByTokenHash("token-hash-1", { signal: controller.signal })
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect((error as Error)?.name).toBe("AbortError");
	});
});
