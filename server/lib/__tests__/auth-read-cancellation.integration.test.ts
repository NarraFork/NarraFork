import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { testEnvironment } from "../../../tests/preload";
import { AuthReadAdmission, authReadAdmission } from "../auth-read-admission";
import {
	drainDbWorkerPool,
	getDbWorkerPoolStats,
	resetDbWorkerPoolForTest,
	setDbWorkerSpecifiersForTest,
} from "../db-worker/pool";
import { generateSessionToken } from "../session-token-hash";
import { WorkerHandle } from "../worker-runtime/lifecycle";

expect(testEnvironment.narraforkHome).toBe(join(testEnvironment.isolatedHome, ".narrafork"));
const { sqlite } = await import("../../db");
expect(sqlite.filename).toBe(join(testEnvironment.narraforkHome, "narrafork.db"));
const { sqliteAuthSessionStore } = await import("../../services/auth/sqlite-session-store");
const { resolveLiveSession, verifyToken } = await import("../auth");

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function flushUntil(condition: () => boolean): Promise<void> {
	for (let index = 0; index < 100 && !condition(); index++) await Promise.resolve();
	expect(condition()).toBe(true);
}
const originalThread = WorkerHandle.thread;
const previousWorker = process.env.NARRAFORK_DB_WORKER;
const previousConcurrency = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
let directory: string;
let started = gate();
let exited = gate();
let spawn: ReturnType<typeof spyOn<typeof WorkerHandle, "thread">>;

beforeEach(async () => {
	await resetDbWorkerPoolForTest();
	process.env.NARRAFORK_DB_WORKER = "on";
	process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
	directory = mkdtempSync(join(process.cwd(), ".narrafork/auth-read-cancel-"));
	const file = join(directory, "hanging-reader.ts");
	// A real native Worker and protocol handshake; only the SQL task completion is controlled.
	writeFileSync(
		file,
		`import { parentPort } from "node:worker_threads";
parentPort.on("message", (message) => {
 if (message.type === "task") parentPort.postMessage({ type: "progress", requestId: message.requestId, tableName: "auth-started", done: 0, total: 1 });
});
parentPort.postMessage({ type: "ready" });\n`,
	);
	setDbWorkerSpecifiersForTest([pathToFileURL(file).href]);
	started = gate();
	exited = gate();
	spawn = spyOn(WorkerHandle, "thread").mockImplementation((entry, options) => {
		const handle = originalThread(entry, options);
		handle.resource.on("message", (message) => {
			if (message.type === "progress" && message.tableName === "auth-started") started.resolve();
		});
		void handle.exited.then(() => exited.resolve());
		return handle;
	});
});

afterEach(async () => {
	await drainDbWorkerPool({ timeoutMs: 20_000 });
	setDbWorkerSpecifiersForTest(null);
	spawn.mockRestore();
	rmSync(directory, { recursive: true, force: true });
	if (previousWorker === undefined) delete process.env.NARRAFORK_DB_WORKER;
	else process.env.NARRAFORK_DB_WORKER = previousWorker;
	if (previousConcurrency === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = previousConcurrency;
});

test("verifyToken caller abort reaches the native SQLite worker and is not an invalid-session error", async () => {
	const controller = new AbortController();
	const read = verifyToken(generateSessionToken(), { signal: controller.signal }).catch(
		(error: unknown) => error,
	);
	await started.promise;
	expect(getDbWorkerPoolStats()).toMatchObject({
		busy: 1,
		concurrency: 2,
		activeByClass: { normal: 0, short: 1 },
	});
	controller.abort();
	expect(await read).toMatchObject({ code: "DB_READ_ABORTED" });
	await exited.promise;
	await flushUntil(() => getDbWorkerPoolStats().busy === 0 && authReadAdmission.stats.active === 0);
	expect(getDbWorkerPoolStats()).toMatchObject({ busy: 0, queued: 0 });
	expect(authReadAdmission.stats).toEqual({ active: 0, queued: 0 });
}, 10_000);

test("admission's own deadline cancels a dispatched SQLite read instead of retaining a hidden task", async () => {
	const admission = new AuthReadAdmission({ concurrency: 1, timeoutMs: 2_000 });
	const run = spyOn(authReadAdmission, "run").mockImplementation((read, options) =>
		admission.run(read, options),
	);
	try {
		const result = verifyToken(generateSessionToken()).catch((error: unknown) => error);
		await started.promise;
		expect(await result).toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
		await exited.promise;
		await flushUntil(() => getDbWorkerPoolStats().busy === 0 && admission.stats.active === 0);
		expect(getDbWorkerPoolStats()).toMatchObject({ busy: 0, queued: 0 });
		expect(admission.stats).toEqual({ active: 0, queued: 0 });
		expect(run).toHaveBeenCalledTimes(1);
	} finally {
		run.mockRestore();
	}
}, 10_000);

test("live-session options bypass HTTP admission and an expired lookup never dispatches", async () => {
	const run = spyOn(authReadAdmission, "run");
	const find = spyOn(sqliteAuthSessionStore, "findSessionById");
	const deadlineAt = Date.now() - 1;
	try {
		const error = await resolveLiveSession("missing", { deadlineAt }).catch(
			(error: unknown) => error,
		);
		expect(error).toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
		expect(find).toHaveBeenCalledWith("missing", { deadlineAt });
		expect(run).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
		// Its source is the preload-isolated file, never the user's database.
		expect(sqlite.filename).not.toBe(":memory:");
	} finally {
		run.mockRestore();
		find.mockRestore();
	}
});
