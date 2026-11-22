import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	DbReadTaskOverloadedError,
	resetDbWorkerPoolForTest,
	runShortReadTask,
	shutdownDbWorkerPool,
	WorkersUnavailableError,
} from "../db-worker/pool";
import { WorkerHandle } from "../worker-runtime/lifecycle";

const home = mkdtempSync(join(tmpdir(), "narrafork-message-language-"));
const filename = join(home, "prefs.db");
const sqlite = new Database(filename);
sqlite.run("PRAGMA journal_mode = WAL");
sqlite.run(
	"CREATE TABLE user_preferences (user_id TEXT UNIQUE, language TEXT, reply_in_user_language INTEGER)",
);
sqlite.run("INSERT INTO user_preferences VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)", [
	"caller",
	"zh_TW",
	0,
	"other",
	"en",
	1,
	"invalid",
	"?".repeat(4096),
	0,
]);
const db = drizzle({ client: sqlite });
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { readMessageLanguagePreferences } = await import("../message-language-read");

const previous = process.env.NARRAFORK_DB_WORKER;
beforeEach(async () => {
	delete process.env.NARRAFORK_DB_WORKER;
	await resetDbWorkerPoolForTest();
});
afterEach(() => {
	if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER;
	else process.env.NARRAFORK_DB_WORKER = previous;
});
afterAll(async () => {
	await shutdownDbWorkerPool();
	mock.module("../../db", () => realDb);
	sqlite.close();
	rmSync(home, { recursive: true, force: true });
});

const read = (userId = "caller", signal = new AbortController().signal) =>
	readMessageLanguagePreferences(userId, signal);

test("reads only the caller's committed preferences, preserving defaults and boolean decoding", async () => {
	expect(await read()).toEqual({ locale: "zh-CN", replyInUserLanguage: false });
	expect(await read("other")).toEqual({ locale: "en", replyInUserLanguage: true });
	expect(await read("missing")).toEqual({ locale: "en", replyInUserLanguage: true });
	expect(await read("invalid")).toEqual({ locale: "en", replyInUserLanguage: false });
	sqlite.run("UPDATE user_preferences SET language = 'en' WHERE user_id = 'caller'");
	try {
		expect(await read()).toEqual({ locale: "en", replyInUserLanguage: false });
	} finally {
		sqlite.run("UPDATE user_preferences SET language = 'zh_TW' WHERE user_id = 'caller'");
	}
});

test("disabling the Worker fails instead of returning inline results or a default locale", async () => {
	process.env.NARRAFORK_DB_WORKER = "off";
	await expect(read()).rejects.toBeInstanceOf(WorkersUnavailableError);
});

test("a composer burst does not occupy the shared queue; cancelled waiters are not dispatched", async () => {
	const firstDispatched = Promise.withResolvers<void>();
	const unblock = Promise.withResolvers<void>();
	const order: string[] = [];
	const create = WorkerHandle.thread;
	const spawn = spyOn(WorkerHandle, "thread").mockImplementation((entry, options) => {
		const handle = create(entry, options);
		const send = handle.resource.postMessage.bind(handle.resource);
		spyOn(handle.resource, "postMessage").mockImplementation((message) => {
			if (message.type === "task") {
				order.push(message.params.sql.includes('"user_preferences"') ? "composer" : "auth");
				if (order.length === 1) {
					firstDispatched.resolve();
					void unblock.promise.then(() => send(message));
					return;
				}
			}
			send(message);
		});
		return handle;
	});
	const jobs: Promise<unknown>[] = [];
	const track = <T>(job: Promise<T>): Promise<T> => {
		jobs.push(job.catch(() => {}));
		return job;
	};
	try {
		const first = track(read());
		await Promise.race([firstDispatched.promise, first]);
		const abort = new AbortController();
		const cancelled = track(read("caller", abort.signal));
		const waiting = Array.from({ length: 3 }, () => track(read()));
		const auth = track(
			runShortReadTask(
				filename,
				{ kind: "selectRows", sql: "SELECT 1", params: [], maxRows: 1 },
				{
					diagnosticSource: "auth.session",
				},
			),
		);
		await expect(read()).rejects.toBeInstanceOf(DbReadTaskOverloadedError);
		abort.abort();
		await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
		unblock.resolve();
		expect((await auth).rows).toEqual([[1]]);
		await Promise.all([first, ...waiting]);
		expect(order).toEqual(["composer", "auth", "composer", "composer", "composer"]);
	} finally {
		unblock.resolve();
		await Promise.all(jobs);
		await resetDbWorkerPoolForTest();
		spawn.mockRestore();
	}
}, 12_000);
