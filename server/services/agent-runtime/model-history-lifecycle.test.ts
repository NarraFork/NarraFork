import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as failures from "../../lib/db-worker/failure";
import { logger } from "../../lib/logger";
import { settings } from "../../lib/settings";
import { modelHistoryFixtureSql } from "./model-history-fixture";
import { renderModelHistoryRevisionSql } from "./model-history-revision-sql";
import {
	clearModelHistorySourceCacheForTest,
	loadModelHistorySource,
	MODEL_HISTORY_MAX_QUEUE,
	modelHistorySourceStats,
} from "./model-history-source";

const workerGlobal = globalThis as unknown as {
	Worker: (...args: ConstructorParameters<typeof Worker>) => Worker;
};
const restores: Array<() => void> = [];
const urls: string[] = [];
let root = "";
let db: Database;
const load = (signal?: AbortSignal) =>
	loadModelHistorySource({ backend: "sqlite", sqlite: db }, "owner", { signal });
function insert(index: number) {
	const id = `m${index}`;
	db.query(
		"INSERT INTO narrator_messages(id,narrator_id,role,content_json) VALUES (?,'owner','user',?)",
	).run(id, JSON.stringify([{ type: "text", text: id }]));
	db.query(
		"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES (?,'owner',?,?)",
	).run(id, id, index);
}
function standIn(source: string) {
	const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
	urls.push(url);
	return url;
}
function intercept(
	create: (RealWorker: typeof Worker, args: ConstructorParameters<typeof Worker>) => Worker,
) {
	const RealWorker = globalThis.Worker;
	const spy = spyOn(workerGlobal, "Worker").mockImplementation((...args) =>
		create(RealWorker, args),
	);
	restores.push(() => spy.mockRestore());
	return spy;
}
function noSlots() {
	expect(modelHistorySourceStats()).toMatchObject({ workers: 0, queued: 0, cacheEntries: 0 });
}
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "nf-history-lifecycle-"));
	db = new Database(join(root, "fixture.db"));
	db.run("PRAGMA journal_mode=WAL");
	db.run("PRAGMA busy_timeout=50");
	db.run(modelHistoryFixtureSql);
	db.run(renderModelHistoryRevisionSql("sqlite"));
	db.run("INSERT INTO narrators(id,title) VALUES ('owner','Owner')");
	insert(0);
	for (const method of ["warn", "error"] as const) {
		const log = spyOn(logger, method).mockImplementation(() => {});
		restores.push(() => log.mockRestore());
	}
});
afterEach(() => {
	clearModelHistorySourceCacheForTest();
	for (const restore of restores.splice(0).reverse()) restore();
	for (const url of urls.splice(0)) URL.revokeObjectURL(url);
	delete process.env.NARRAFORK_DB_WORKER;
	delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	db.close();
	rmSync(root, { recursive: true, force: true });
});

test("synchronous creation failures keep bounded redacted root diagnostics", async () => {
	const worker = intercept(() => {
		throw new TypeError(
			"Cannot resolve fixture module postgres://alice:private@host/db token=secret",
		);
	});
	await expect(load()).rejects.toThrow("failed to start");
	expect(worker).toHaveBeenCalledTimes(1);
	const logs = JSON.stringify((logger.error as ReturnType<typeof spyOn>).mock.calls);
	expect(logs).toContain("Cannot resolve fixture module");
	expect(logs).toContain('"phase":"create"');
	expect(logs).not.toContain("alice:private");
	expect(logs).not.toContain("token=secret");
	noSlots();
});

test.each([
	"timeout",
	"abort",
])("a worker with no ready frame handles %s without receiving database identity", async (mode) => {
	const url = standIn("self.onmessage = () => {}; setInterval(() => {}, 1000);");
	let sends = 0;
	let terminations = 0;
	const started = Promise.withResolvers<void>();
	intercept((RealWorker) => {
		const worker = new RealWorker(url);
		spyOn(worker, "postMessage").mockImplementation(() => {
			sends++;
		});
		const terminate = worker.terminate.bind(worker);
		spyOn(worker, "terminate").mockImplementation(() => {
			terminations++;
			return terminate();
		});
		started.resolve();
		return worker;
	});
	const realTimeout = globalThis.setTimeout;
	const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
		fn: TimerHandler,
		delay?: number,
		...args: unknown[]
	) =>
		realTimeout(
			fn,
			delay === 10_000 && typeof fn === "function" && fn.name !== "warnIfSlow" ? 15 : delay,
			...args,
		)) as typeof setTimeout);
	restores.push(() => timers.mockRestore());
	const controller = new AbortController();
	const pending = load(controller.signal);
	await started.promise;
	if (mode === "abort") controller.abort();
	await expect(pending).rejects.toThrow(mode === "timeout" ? "readiness timed out" : "cancelled");
	expect(timers.mock.calls.some(([, ms]) => ms === 10_000)).toBe(true);
	expect(sends).toBe(0);
	expect(terminations).toBe(1);
	noSlots();
});

test.each([
	undefined,
	null,
	"stale-build",
])("frozen validation rejects ready build %s before dispatch", async (buildId) => {
	const build = await Bun.build({
		entrypoints: [join(import.meta.dir, "../../lib/db-worker/failure.ts")],
		target: "bun",
		define: { __NARRAFORK_RUNTIME_BUILD_ID__: JSON.stringify("frozen-build") },
	});
	expect(build.success).toBe(true);
	const modulePath = join(root, "frozen-failure.mjs");
	await Bun.write(modulePath, build.outputs[0]);
	const frozen = await import(modulePath);
	expect(() => frozen.assertWorkerBuildId("frozen-build")).not.toThrow();
	const check = spyOn(failures, "assertWorkerBuildId").mockImplementation(
		frozen.assertWorkerBuildId,
	);
	restores.push(() => check.mockRestore());
	const url = standIn(
		`self.onmessage = () => {}; postMessage(${JSON.stringify({ type: "ready", buildId })});`,
	);
	let sends = 0;
	intercept((RealWorker) => {
		const worker = new RealWorker(url);
		spyOn(worker, "postMessage").mockImplementation(() => {
			sends++;
		});
		return worker;
	});
	await expect(load()).rejects.toThrow("readiness validation failed");
	expect(check).toHaveBeenCalledWith(buildId);
	expect(sends).toBe(0);
	noSlots();
});

test.each([
	"SQLITE_BUSY",
	"SQLITE_LOCKED_SHAREDCACHE",
])("%s retries a whole source only after releasing its worker and discards streamed pages", async (code) => {
	const url = standIn(
		`let page=false; self.onmessage=({data})=>{ if(!page) {page=true; postMessage({type:'page',rows:[{id:'partial',toolCalls:[]}]});} else postMessage({type:'error',message:'Model history read-only worker failed',code:${JSON.stringify(code)}}); }; postMessage({type:'ready',buildId:null});`,
	);
	let attempts = 0;
	const worker = intercept((RealWorker, args) => new RealWorker(++attempts === 1 ? url : args[0]));
	const warn = spyOn(logger, "warn").mockImplementation(() => noSlots());
	restores.push(() => warn.mockRestore());
	const result = await load();
	expect(worker).toHaveBeenCalledTimes(2);
	expect(result.messages.map((row) => row.id)).toEqual(["m0"]);
	expect(modelHistorySourceStats()).toMatchObject({ workers: 0, queued: 0, cacheEntries: 1 });
});

test.each([
	undefined,
	"SQLITE_ERROR",
	"DB_WORKER_BUILD_MISMATCH",
])("runtime error %s is not retried by its locked-looking text", async (code) => {
	const url = standIn(
		`self.onmessage=()=>postMessage(${JSON.stringify({ type: "error", message: "database is locked", code })});postMessage({type:'ready'});`,
	);
	const worker = intercept((RealWorker) => new RealWorker(url));
	await expect(load()).rejects.toThrow("database is locked");
	expect(worker).toHaveBeenCalledTimes(1);
	noSlots();
});

test.each([
	"SQLITE_BUSY",
	"SQLITE_ERROR",
])("request metadata SELECT preserves %s without broadening retries", async (code) => {
	const oldRead = settings.narratorBlocks.read;
	settings.narratorBlocks.read = false;
	restores.push(() => {
		settings.narratorBlocks.read = oldRead;
	});
	const original = db.query.bind(db);
	let metadataReads = 0;
	const query = spyOn(db, "query").mockImplementation(((sql: string) => {
		if (
			sql === "SELECT 1 FROM narrator_messages WHERE body_rows_only = 1 LIMIT 1" &&
			++metadataReads === 1
		)
			throw Object.assign(new Error("database is locked"), { code });
		return original(sql);
	}) as typeof db.query);
	restores.push(() => query.mockRestore());
	let sends = 0;
	const worker = intercept((RealWorker, args) => {
		const instance = new RealWorker(...args);
		const send = instance.postMessage.bind(instance);
		spyOn(instance, "postMessage").mockImplementation((message) => {
			if ("narratorId" in message) sends++;
			send(message);
		});
		return instance;
	});
	if (code === "SQLITE_BUSY") {
		expect((await load()).messages).toHaveLength(1);
		expect(worker).toHaveBeenCalledTimes(2);
		expect(metadataReads).toBe(2);
		expect(sends).toBe(1);
	} else {
		await expect(load()).rejects.toMatchObject({ code: "SQLITE_ERROR" });
		expect(worker).toHaveBeenCalledTimes(1);
		expect(sends).toBe(0);
		noSlots();
	}
});

test.each([
	"error",
	"close",
])("runtime %s after ready is not mistaken for startup or retried", async (mode) => {
	const url = standIn(
		`self.onmessage=()=>{ ${mode === "close" ? "process.exit(7)" : "throw new TypeError('PRIVATE_DRIVER_SECRET')"}; };postMessage({type:'ready'});`,
	);
	const worker = intercept((RealWorker) => new RealWorker(url));
	await expect(load()).rejects.toThrow(
		mode === "close" ? "closed before completion" : "read-only worker failed",
	);
	expect(worker).toHaveBeenCalledTimes(1);
	const logs = JSON.stringify((logger.error as ReturnType<typeof spyOn>).mock.calls);
	expect(logs).toContain(`"phase":"${mode === "close" ? "close" : "run"}"`);
	expect(logs).not.toContain("PRIVATE_DRIVER_SECRET");
	noSlots();
});

test("history retry count is bounded and cancellation during backoff does not spawn again", async () => {
	const url = standIn(
		"self.onmessage=()=>postMessage({type:'error',message:'Model history read-only worker failed',code:'SQLITE_BUSY'});postMessage({type:'ready'});",
	);
	const worker = intercept((RealWorker) => new RealWorker(url));
	await expect(load()).rejects.toMatchObject({ code: "SQLITE_BUSY" });
	expect(worker).toHaveBeenCalledTimes(3);
	noSlots();
	const controller = new AbortController();
	const retrying = Promise.withResolvers<void>();
	const warn = spyOn(logger, "warn").mockImplementation(() => {
		noSlots();
		retrying.resolve();
	});
	restores.push(() => warn.mockRestore());
	const pending = load(controller.signal);
	await retrying.promise;
	controller.abort(new Error("cancel retry"));
	await expect(pending).rejects.toThrow("cancel retry");
	expect(worker).toHaveBeenCalledTimes(4);
	noSlots();
});

test.each([
	"off",
	"zero",
])("disabled worker %s may serve a verified cache hit but never computes a miss inline", async (mode) => {
	const cached = await load();
	if (mode === "off") process.env.NARRAFORK_DB_WORKER = "off";
	else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "0";
	const worker = intercept(() => {
		throw new Error("must not construct");
	});
	expect(await load()).toBe(cached);
	insert(1);
	await expect(load()).rejects.toMatchObject({ code: "MODEL_HISTORY_WORKER_DISABLED" });
	expect(worker).not.toHaveBeenCalled();
	expect(modelHistorySourceStats()).toMatchObject({ workers: 0, queued: 0 });
});

test("history admission rejects overload and queued cancellation releases all slots", async () => {
	const url = standIn("self.onmessage=()=>{};postMessage({type:'ready'});");
	intercept((RealWorker) => new RealWorker(url));
	const controller = new AbortController();
	const pending = Array.from({ length: MODEL_HISTORY_MAX_QUEUE + 2 }, () =>
		load(controller.signal).catch((error) => error),
	);
	await Promise.resolve();
	await Promise.resolve();
	expect(modelHistorySourceStats()).toMatchObject({ workers: 2, queued: MODEL_HISTORY_MAX_QUEUE });
	await expect(load()).rejects.toMatchObject({ code: "MODEL_HISTORY_WORKER_OVERLOADED" });
	controller.abort();
	await Promise.all(pending);
	noSlots();
});

test("WAL snapshot survives concurrent writes between ACK pages and is released on completion", async () => {
	for (let index = 1; index < 205; index++) insert(index);
	let mutated = false;
	intercept((RealWorker, args) => {
		const worker = new RealWorker(...args);
		worker.addEventListener("message", (event) => {
			if (event.data.type !== "page" || mutated) return;
			mutated = true;
			db.run(
				'UPDATE narrator_messages SET content_json=\'[{"type":"text","text":"new"}]\' WHERE id=\'m204\'',
			);
		});
		return worker;
	});
	const source = await load();
	expect(mutated).toBe(true);
	expect(source.messages.find((row) => row.id === "m204")?.contentJson).toEqual([
		{ type: "text", text: "m204" },
	]);
	expect((await load()).messages.find((row) => row.id === "m204")?.contentJson).toEqual([
		{ type: "text", text: "new" },
	]);
	expect(db.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({ busy: 0 });
});

test("cancelling after a real page releases the SQLite snapshot before the next read", async () => {
	for (let index = 1; index < 205; index++) insert(index);
	const controller = new AbortController();
	intercept((RealWorker, args) => {
		const worker = new RealWorker(...args);
		worker.addEventListener("message", (event) => {
			if (event.data.type === "page") {
				db.run("UPDATE narrators SET title='changed' WHERE id='owner'");
				controller.abort();
			}
		});
		return worker;
	});
	await expect(load(controller.signal)).rejects.toThrow("cancelled");
	noSlots();
	expect(db.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({ busy: 0 });
});
