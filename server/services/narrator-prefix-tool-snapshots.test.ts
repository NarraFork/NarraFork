import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { SQL } from "bun";
import { withPostgres } from "../../tests/db/pg-test-harness";
import type { ToolDefinitionSnapshot } from "../lib/agent/tool-loading";
import * as compiledWorker from "../lib/compiled-worker";
import {
	PREFIX_TOOLS_FORMAT,
	type PrefixToolsManifest,
	prefixValueBytes,
} from "./narrator-prefix-snapshot-values";
import {
	createPrefixSnapshotMaintenance,
	createPrefixSnapshotStore,
	type PrefixSnapshotStore,
} from "./narrator-prefix-snapshots";
import type { PrefixSnapshotRequest } from "./narrator-prefix-snapshots-worker";
import { createPrefixToolSnapshots } from "./narrator-prefix-tool-snapshots";

const schema = `
CREATE TABLE narrator_text_snapshots (sha256 TEXT PRIMARY KEY, text TEXT NOT NULL, byte_size INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE narrator_block_assets (block_id TEXT NOT NULL, asset_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (block_id, asset_id));
CREATE INDEX prefix_test_assets ON narrator_block_assets (asset_id);
CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, content_json TEXT NOT NULL);
CREATE TABLE narrator_blocks (id TEXT PRIMARY KEY, payload TEXT NOT NULL);`;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(options: Parameters<typeof createPrefixSnapshotStore>[1] = {}) {
	const root = await mkdtemp(join(tmpdir(), "prefix-tool-snapshots-"));
	const path = join(root, "fixture.db");
	const db = new Database(path);
	db.run("PRAGMA journal_mode = WAL");
	db.exec(schema);
	const store = createPrefixSnapshotStore({ backend: "sqlite", path }, options);
	cleanups.push(async () => {
		await store.close();
		db.close();
		await rm(root, { recursive: true, force: true });
	});
	return { db, store };
}
const definition = (name: string, description = name): ToolDefinitionSnapshot => ({
	name,
	description,
	parameters: { type: "object", properties: { text: { type: "string" } } },
});

test("different arrays and real signals deduplicate CAS content, immutable values and legacy arrays", async () => {
	const { db, store } = await fixture({ cacheBytes: 1 });
	const one = definition("one");
	const two = definition("two");
	const controllers = Array.from({ length: 8 }, () => new AbortController());
	const hashes = await Promise.all(
		controllers.map((controller) =>
			store.putPrefixToolDefinitions([{ ...one }, { ...two }], controller.signal),
		),
	);
	expect(new Set(hashes).size).toBe(1);
	expect(db.query("SELECT count(*) AS n FROM narrator_text_snapshots").get()).toEqual({ n: 3 });
	const manifest = await store.getPrefixJson<PrefixToolsManifest>(hashes[0]);
	expect(manifest.format).toBe(PREFIX_TOOLS_FORMAT);
	expect(manifest.definitions).toHaveLength(2);
	const restored = await store.getPrefixToolDefinitions(hashes[0], controllers[0].signal);
	expect(restored).toEqual([one, two]);
	expect(Object.isFrozen(restored[0].parameters)).toBe(true);
	expect(await store.getPrefixToolDefinitions(hashes[0], controllers[1].signal)).toBe(restored);
	const changedHash = await store.putPrefixToolDefinitions(
		[one, { ...two, description: "changed" }],
		controllers[2].signal,
	);
	const changed = await store.getPrefixToolDefinitions(changedHash, controllers[3].signal);
	expect(changed[0]).toBe(restored[0]);
	expect(changed[1].description).toBe("changed");
	expect(db.query("SELECT count(*) AS n FROM narrator_text_snapshots").get()).toEqual({ n: 5 });
	const legacy = await store.putPrefixJson([one]);
	expect(await store.getPrefixToolDefinitions(legacy)).toEqual([one]);
});

test("decoded tools consume the same LRU budget as text while raw JSON remains the manifest", async () => {
	const { store } = await fixture({ cacheBytes: 700 });
	const hash = await store.putPrefixToolDefinitions([]);
	const manifest = await store.getPrefixJson<PrefixToolsManifest>(hash);
	const text = "a".repeat(100);
	const textHash = await store.putPrefixText(text);
	await store.getPrefixText(textHash);
	const post = spyOn(Worker.prototype, "postMessage");
	try {
		// The caller-held manifest is weakly reused, so only the decoded tools enter the LRU.
		expect(await store.getPrefixToolDefinitions(hash)).toEqual([]);
		expect(await store.getPrefixText(textHash)).toBe(text);
		expect(post.mock.calls.filter(([request]) => request.operation === "getText")).toHaveLength(1);
		expect(await store.getPrefixJson(hash)).toBe(manifest);
		expect(manifest.format).toBe(PREFIX_TOOLS_FORMAT);
	} finally {
		post.mockRestore();
	}
});

test("one cancelled caller does not abort independent writes or other callers' shared reads", async () => {
	const { store } = await fixture();
	const values = Array.from({ length: 200 }, (_, index) => definition(`tool${index}`));
	const a = new AbortController();
	const b = new AbortController();
	const abandoned = store.putPrefixToolDefinitions([...values], a.signal).catch((error) => error);
	const kept = store.putPrefixToolDefinitions([...values], b.signal);
	a.abort(new Error("leave shared put"));
	expect((await abandoned).message).toBe("leave shared put");
	const hash = await kept;
	const c = new AbortController();
	const cancelledRead = store.getPrefixToolDefinitions(hash, c.signal).catch((error) => error);
	const liveRead = store.getPrefixToolDefinitions(hash, b.signal);
	c.abort(new Error("leave shared read"));
	expect((await cancelledRead).message).toBe("leave shared read");
	expect(await liveRead).toEqual(values);
});

test("cancelled writes discard undispatched batches and the next independent write succeeds", async () => {
	const { store, db } = await fixture();
	await store.putPrefixText("warmup");
	db.run("BEGIN IMMEDIATE");
	const definitions = Array.from({ length: 2000 }, (_, index) => definition(`cancel${index}`));
	const controller = new AbortController();
	const pending = store
		.putPrefixToolDefinitions(
			definitions.map((value) => ({ ...value })),
			controller.signal,
		)
		.catch((error) => error);
	await Bun.sleep(10);
	controller.abort(new Error("cancel all"));
	expect((await pending).message).toBe("cancel all");
	db.run("ROLLBACK");
	await store.putPrefixText("barrier");
	const count = db.query("SELECT count(*) AS n FROM narrator_text_snapshots").get() as {
		n: number;
	};
	expect(count.n).toBeLessThan(2000);
	const hash = await store.putPrefixToolDefinitions([...definitions], new AbortController().signal);
	expect(await store.getPrefixToolDefinitions(hash)).toEqual(definitions);
});

test("all cancelled read subscribers stop before dispatching the next body batch", async () => {
	let announce!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => {
		announce = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const hashes = Array.from({ length: 200 }, (_, index) => index.toString(16).padStart(64, "0"));
	let batches = 0;
	const tools = createPrefixToolSnapshots({
		putBatch: async () => [],
		putJson: async () => "unused",
		readJson: async <T>() => ({ format: PREFIX_TOOLS_FORMAT, definitions: hashes }) as T,
		peek: () => undefined,
		remember: async () => {},
		protect: () => () => {},
		check: () => {},
		getBatch: async (items) => {
			if (++batches === 1) {
				announce();
				await gate;
			}
			return items.map((hash) => ({ json: definition(hash), byteSize: 100 }));
		},
	});
	const controller = new AbortController();
	const pending = tools.getPrefixToolDefinitions("root", controller.signal).catch((error) => error);
	await entered;
	controller.abort(new Error("cancel all reads"));
	expect((await pending).message).toBe("cancel all reads");
	release();
	await Bun.sleep(5);
	expect(batches).toBe(1);
	expect((await tools.getPrefixToolDefinitions("root")).length).toBe(200);
});

test("real tools API transfers bounded batches, deduplicates directories and keeps the heartbeat", async () => {
	const { store, db } = await fixture({ cacheBytes: 1024 * 1024 });
	const values = Array.from({ length: 1200 }, (_, index) =>
		definition(`batch${index}`, `${index}:${"x".repeat(2048)}`),
	);
	values.splice(600, 0, definition("oversized", "z".repeat(300 * 1024)));
	const post = spyOn(Worker.prototype, "postMessage");
	const initialRss = process.memoryUsage().rss;
	let peakRss = initialRss;
	let beats = 0;
	let maxGapMs = 0;
	let last = performance.now();
	const heartbeat = setInterval(() => {
		const now = performance.now();
		maxGapMs = Math.max(maxGapMs, now - last);
		last = now;
		peakRss = Math.max(peakRss, process.memoryUsage().rss);
		beats++;
	}, 5);
	try {
		const started = performance.now();
		const hash = await store.putPrefixToolDefinitions(values);
		const writes = post.mock.calls
			.map(([request]) => request as PrefixSnapshotRequest)
			.filter((request) => request.operation === "putJsonBatch");
		expect(writes.length).toBeGreaterThan(1);
		expect(writes.flatMap((request) => request.value)).toEqual(values);
		for (const request of writes) {
			const batch = request.value as ToolDefinitionSnapshot[];
			expect(batch.length).toBeLessThanOrEqual(64);
			if (batch.length > 1)
				expect(batch.reduce((sum, value) => sum + prefixValueBytes(value), 0)).toBeLessThanOrEqual(
					512 * 1024,
				);
		}
		expect(
			writes.some(
				(request) =>
					(request.value as ToolDefinitionSnapshot[])[0].name === "oversized" &&
					(request.value as unknown[]).length === 1,
			),
		).toBe(true);
		const restored = await store.getPrefixToolDefinitions(hash);
		expect(restored).toEqual(values);
		const reads = post.mock.calls
			.map(([request]) => request as PrefixSnapshotRequest)
			.filter((request) => request.operation === "getJsonBatch");
		expect(reads.length).toBeGreaterThan(1);
		for (const request of reads) expect((request.value as string[]).length).toBeLessThanOrEqual(64);
		expect(await store.getPrefixToolDefinitions(hash)).toBe(restored);
		const raw = await store.getPrefixJson<PrefixToolsManifest>(hash);
		expect(raw.format).toBe(PREFIX_TOOLS_FORMAT);
		expect(raw.definitions).toHaveLength(values.length);
		expect(await store.putPrefixToolDefinitions(values)).toBe(hash);
		await store.putPrefixToolDefinitions(values.slice(0, 100));
		expect(db.query("SELECT count(*) AS n FROM narrator_text_snapshots").get()).toEqual({
			n: values.length + 2,
		});
		expect(beats).toBeGreaterThan(2);
		console.info("PREFIX_TOOLS_BATCHES", {
			tools: values.length,
			writeBatches: writes.length,
			readBatches: reads.length,
			casRows: values.length + 2,
			elapsedMs: performance.now() - started,
			beats,
			maxGapMs,
			peakRssDelta: peakRss - initialRss,
		});
	} finally {
		clearInterval(heartbeat);
		post.mockRestore();
	}
}, 20000);

for (const damage of ["missing", "corrupt"] as const) {
	test(`a ${damage} manifest child fails explicitly without registry recovery`, async () => {
		const { store, db } = await fixture();
		const root = await store.putPrefixToolDefinitions([definition("damaged")]);
		const manifest = await store.getPrefixJson<PrefixToolsManifest>(root);
		if (damage === "missing")
			db.query("DELETE FROM narrator_text_snapshots WHERE sha256 = ?").run(manifest.definitions[0]);
		else
			db.query("UPDATE narrator_text_snapshots SET text = '{}' WHERE sha256 = ?").run(
				manifest.definitions[0],
			);
		const error = await store.getPrefixToolDefinitions(root).catch((error: Error) => error);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(
			damage === "missing" ? "not found" : "integrity mismatch",
		);
	});
}

// Test the real store scheduler independently of worker startup/SQLite wall time.
// The other fixtures in this file retain real workers and file-backed SQLite.
function controlledQueue() {
	const timeoutMs = 220;
	let now = 1000;
	const timers: Array<{ callback: () => void; started: number; cleared: boolean }> = [];
	const timerHandles = new Map<ReturnType<typeof setTimeout>, (typeof timers)[number]>();
	const setTimer = globalThis.setTimeout;
	const clearTimer = globalThis.clearTimeout;
	const clockSpy = spyOn(Date, "now").mockImplementation(() => now);
	const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: TimerHandler,
		delay?: number,
		...args: unknown[]
	) => {
		if (delay !== timeoutMs || typeof callback !== "function")
			return setTimer(callback, delay, ...args);
		const timer = { callback: () => callback(...args), started: now, cleared: false };
		timers.push(timer);
		const handle = setTimer(() => {}, delay);
		clearTimer(handle);
		timerHandles.set(handle, timer);
		return handle;
	}) as typeof setTimeout);
	const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((
		handle?: ReturnType<typeof setTimeout>,
	) => {
		const timer = handle === undefined ? undefined : timerHandles.get(handle);
		if (timer) timer.cleared = true;
		clearTimer(handle);
	}) as typeof clearTimeout);
	type Dispatch = { worker: ControlledWorker; request: PrefixSnapshotRequest };
	const dispatched: Dispatch[] = [];
	const waiters: Array<(value: Dispatch) => void> = [];
	class ControlledWorker extends EventEmitter {
		terminated = false;
		ref() {
			return this;
		}
		unref() {
			return this;
		}
		async terminate() {
			this.terminated = true;
			return 0;
		}
		postMessage(request: PrefixSnapshotRequest) {
			const dispatch = { worker: this, request };
			const waiter = waiters.shift();
			if (waiter) waiter(dispatch);
			else dispatched.push(dispatch);
		}
	}
	const connectSpy = spyOn(compiledWorker, "connectCompiledWorker").mockImplementation(
		async () => ({
			worker: new ControlledWorker() as unknown as Worker,
			specifier: "controlled-prefix-worker",
		}),
	);
	const store = createPrefixSnapshotStore(
		{ backend: "sqlite", path: "unused-controlled-worker.db" },
		{ timeoutMs },
	);
	cleanups.push(async () => {
		try {
			await store.close();
		} finally {
			connectSpy.mockRestore();
			clearSpy.mockRestore();
			timerSpy.mockRestore();
			clockSpy.mockRestore();
		}
	});
	return {
		store,
		timeoutMs,
		timers,
		advance: (elapsed: number) => (now += elapsed),
		nextDispatch: () =>
			new Promise<Dispatch>((resolve) => {
				const dispatch = dispatched.shift();
				if (dispatch) resolve(dispatch);
				else waiters.push(resolve);
			}),
	};
}

test("cancelling a queued text read never dispatches it", async () => {
	const { store, nextDispatch } = controlledQueue();
	const blocking = store.putPrefixText("hold queue");
	const first = await nextDispatch();
	const controller = new AbortController();
	const pending = store.getPrefixText("a".repeat(64), controller.signal).catch((error) => error);
	const reason = new Error("cancel queued text read");
	controller.abort(reason);
	expect(await pending).toBe(reason);
	first.worker.emit("message", { value: "b".repeat(64) });
	await blocking;
	const barrier = store.putPrefixText("after cancelled read").catch((error) => error);
	const next = await nextDispatch();
	expect(next.request.operation).toBe("putText");
	expect(next.request.value).toBe("after cancelled read");
	next.worker.emit("message", { value: "c".repeat(64) });
	expect(await barrier).toBe("c".repeat(64));
});

test("cancelling an active text read releases its worker and the queue", async () => {
	const { store, nextDispatch } = controlledQueue();
	const controller = new AbortController();
	const pending = store.getPrefixText("a".repeat(64), controller.signal).catch((error) => error);
	const first = await nextDispatch();
	expect(first.request.operation).toBe("getText");
	const reason = new Error("cancel active text read");
	controller.abort(reason);
	expect(await pending).toBe(reason);
	expect(first.worker.terminated).toBe(true);
	const barrier = store.putPrefixText("after cancelled read").catch((error) => error);
	const next = await nextDispatch();
	expect(next.request.operation).toBe("putText");
	next.worker.emit("message", { value: "b".repeat(64) });
	expect(await barrier).toBe("b".repeat(64));
});

test("cancelling an active tools batch dispatches no later batch or manifest", async () => {
	const { store, nextDispatch } = controlledQueue();
	const controller = new AbortController();
	const values = Array.from({ length: 200 }, (_, index) => definition(`cancel${index}`));
	const pending = store
		.putPrefixToolDefinitions(values, controller.signal)
		.catch((error: Error) => error);
	const first = await nextDispatch();
	expect(first.request.operation).toBe("putJsonBatch");
	expect((first.request.value as unknown[]).length).toBe(64);
	controller.abort(new Error("cancel tools batch"));
	expect(((await pending) as Error).message).toBe("cancel tools batch");
	const barrier = store.putPrefixText("after cancelled tools");
	const next = await nextDispatch();
	expect(next.request.operation).toBe("putText");
	expect(first.worker.terminated).toBe(true);
	next.worker.emit("message", { value: "a".repeat(64) });
	await barrier;
});

test("queue execution timeout starts when work starts, not while waiting behind another task", async () => {
	const { store, timeoutMs, timers, advance, nextDispatch } = controlledQueue();
	const controller = new AbortController();
	const first = store
		.putPrefixText("cancelled blocked task", controller.signal)
		.catch((error: Error) => error);
	const firstDispatch = await nextDispatch();
	expect(firstDispatch.request.value).toBe("cancelled blocked task");
	expect(timers).toHaveLength(1);
	const queuedAt = timers[0].started;
	const second = store.putPrefixText("waits longer than its execution budget");
	expect(timers).toHaveLength(1);
	const started = advance(timeoutMs + 1);
	// Advancing the clock does not dispatch an expired timer: as with a delayed
	// event loop, cancellation can release the first task before that callback runs.
	controller.abort(new Error("release queue"));
	expect(((await first) as Error).message).toBe("release queue");
	const secondDispatch = await nextDispatch();
	expect(firstDispatch.worker.terminated).toBe(true);
	expect(timers[0].cleared).toBe(true);
	expect(timers).toHaveLength(2);
	expect(timers[1].started).toBe(started);
	expect(secondDispatch.request.value).toBe("waits longer than its execution budget");
	expect(secondDispatch.request.deadline).toBe(started + timeoutMs);
	expect(started - queuedAt).toBeGreaterThan(timeoutMs);
	advance(timeoutMs - 1);
	const hash = "a".repeat(64);
	secondDispatch.worker.emit("message", { value: hash });
	expect(await second).toBe(hash);
	expect(timers[1].cleared).toBe(true);
});

for (const completion of ["timer", "late response"] as const) {
	test(`active execution still times out via ${completion} and the queue recovers`, async () => {
		const { store, timeoutMs, timers, advance, nextDispatch } = controlledQueue();
		const pending = store.putPrefixText("too slow").catch((error: Error) => error);
		const dispatch = await nextDispatch();
		expect(timers).toHaveLength(1);
		expect(dispatch.request.deadline).toBe(timers[0].started + timeoutMs);
		advance(timeoutMs);
		if (completion === "timer") timers[0].callback();
		else dispatch.worker.emit("message", { value: "b".repeat(64) });
		const result = await pending;
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toBe("Prefix snapshot operation timed out");
		expect(dispatch.worker.terminated).toBe(true);
		expect(timers[0].cleared).toBe(true);
		const recovered = store.putPrefixText("recovered");
		const recovery = await nextDispatch();
		expect(recovery.worker).not.toBe(dispatch.worker);
		expect(timers).toHaveLength(2);
		expect(recovery.request.deadline).toBe(timers[1].started + timeoutMs);
		const hash = "c".repeat(64);
		recovery.worker.emit("message", { value: hash });
		expect(await recovered).toBe(hash);
	});
}

type Query = <T>(sql: string, params?: Array<string | number>) => Promise<T[]>;
async function cycle(store: PrefixSnapshotStore): Promise<number> {
	let deleted = 0;
	for (let step = 0; step < 1000; step++) {
		const result = await store.cleanupPrefixSnapshots({ batchSize: 3 });
		deleted += result.deleted;
		if (result.phase === "done") return deleted;
	}
	throw new Error("GC did not finish its bounded slices");
}
async function exerciseGc(store: PrefixSnapshotStore, query: Query) {
	const root = await store.putPrefixToolDefinitions([definition("published-child")]);
	const orphanRoot = await store.putPrefixToolDefinitions([definition("orphan-child")]);
	const orphanManifest = await store.getPrefixJson<PrefixToolsManifest>(orphanRoot);
	const orphan = await store.putPrefixText("unpublished abandoned prompt");
	const legacy = await store.putPrefixText("legacy referenced prompt");
	const block = await store.putPrefixText("block raw referenced prompt");
	const lease = await store.putPrefixText("prepared publication");
	const legacyUpdate = await store.putPrefixJson([{ key: "cwd", value: "legacy update body" }]);
	const blockUpdate = await store.putPrefixJson([{ key: "cwd", value: "rows-only update body" }]);
	await query("INSERT INTO narrator_messages (id, content_json) VALUES (?, ?)", [
		"legacy-update",
		JSON.stringify([
			{ type: "context_update", epochId: "epoch", changes: [], snapshotRef: legacyUpdate },
		]),
	]);
	await query("INSERT INTO narrator_messages (id, content_json) VALUES (?, ?)", [
		"rows-only-update",
		"[]",
	]);
	await query("INSERT INTO narrator_blocks (id, payload) VALUES (?, ?)", [
		"update-block",
		JSON.stringify({
			raw: [{ type: "context_update", epochId: "epoch", changes: [], snapshotRef: blockUpdate }],
		}),
	]);
	await query("INSERT INTO narrator_block_assets (block_id, asset_id, role) VALUES (?, ?, ?)", [
		"published",
		root,
		"epoch_snapshot",
	]);
	await query("INSERT INTO narrator_messages (id, content_json) VALUES (?, ?)", [
		"legacy",
		JSON.stringify([{ type: "compact", epoch: { prefix: { contract: legacy } } }]),
	]);
	await query("INSERT INTO narrator_blocks (id, payload) VALUES (?, ?)", [
		"raw",
		JSON.stringify({ raw: [{ type: "compact", epoch: { prefix: { contract: block } } }] }),
	]);
	await query("UPDATE narrator_text_snapshots SET created_at = ?", ["2000-01-01T00:00:00.000Z"]);
	await store.withPrefixSnapshotPublication([lease], async () => {
		// Simulate a publication that outlives the grace period: the live lease still protects it.
		await query("UPDATE narrator_text_snapshots SET created_at = ? WHERE sha256 = ?", [
			"2000-01-01T00:00:00.000Z",
			lease,
		]);
		expect(await cycle(store)).toBe(2); // orphan root + standalone orphan, not its child yet
		expect(
			(await query("SELECT sha256 FROM narrator_text_snapshots WHERE sha256 = ?", [lease])).length,
		).toBe(1);
	});
	expect(
		(await query("SELECT sha256 FROM narrator_text_snapshots WHERE sha256 = ?", [orphan])).length,
	).toBe(0);
	expect(
		(await query("SELECT sha256 FROM narrator_text_snapshots WHERE sha256 = ?", [orphanRoot]))
			.length,
	).toBe(0);
	expect(
		(
			await query("SELECT sha256 FROM narrator_text_snapshots WHERE sha256 = ?", [
				orphanManifest.definitions[0],
			])
		).length,
	).toBe(1);
	expect(await cycle(store)).toBe(2); // now unleased text and the former orphan's child
	for (const hash of [root, legacy, block, legacyUpdate, blockUpdate])
		expect(
			(await query("SELECT sha256 FROM narrator_text_snapshots WHERE sha256 = ?", [hash])).length,
		).toBe(1);
	expect(await store.getPrefixToolDefinitions(root)).toEqual([definition("published-child")]);
}

test("GC deletes abandoned rows while protecting assets, legacy/rows-only context updates, leases and manifest children", async () => {
	const { store, db } = await fixture();
	await exerciseGc(
		store,
		async <T>(sql: string, params: Array<string | number> = []) =>
			db.query(sql).all(...params) as T[],
	);
});

test("publication refresh after mark protects a newly published legacy reference at sweep", async () => {
	const { store, db } = await fixture();
	const hash = await store.putPrefixText("late publication");
	db.run("UPDATE narrator_text_snapshots SET created_at = '2000-01-01T00:00:00.000Z'");
	for (;;) {
		const result = await store.cleanupPrefixSnapshots();
		if (result.phase === "sweep") break;
	}
	await store.withPrefixSnapshotPublication([hash], async () => {
		db.query("INSERT INTO narrator_messages VALUES (?, ?)").run(
			"late",
			JSON.stringify([{ epoch: { prefix: { contract: hash } } }]),
		);
	});
	expect((await store.cleanupPrefixSnapshots()).deleted).toBe(0);
	expect(db.query("SELECT count(*) AS n FROM narrator_text_snapshots").get()).toEqual({ n: 1 });
});

test("manifest reachability tolerates field order and whitespace, not just a serialization prefix", async () => {
	const { store, db } = await fixture();
	const child = await store.putPrefixJson(definition("ordered"));
	const root = await store.putPrefixText(
		` \n${JSON.stringify({ definitions: [child], format: PREFIX_TOOLS_FORMAT })}`,
	);
	await store.putPrefixText("{ordinary prompt, not JSON");
	db.query("INSERT INTO narrator_block_assets VALUES (?, ?, ?)").run(
		"root",
		root,
		"epoch_snapshot",
	);
	db.run("UPDATE narrator_text_snapshots SET created_at = '2000-01-01T00:00:00.000Z'");
	await store.withPrefixSnapshotPublication([root], async () => {});
	expect(
		db.query("SELECT created_at FROM narrator_text_snapshots WHERE sha256 = ?").get(child),
	).not.toEqual({ created_at: "2000-01-01T00:00:00.000Z" });
	db.run("UPDATE narrator_text_snapshots SET created_at = '2000-01-01T00:00:00.000Z'");
	expect(await cycle(store)).toBe(1);
	expect(await store.getPrefixToolDefinitions(root)).toEqual([definition("ordered")]);
});

test("an unreadable legacy source prevents sweeping rather than treating its references as empty", async () => {
	const { store, db } = await fixture();
	await store.putPrefixText("possibly referenced");
	db.run("UPDATE narrator_text_snapshots SET created_at = '2000-01-01T00:00:00.000Z'");
	db.query("INSERT INTO narrator_messages VALUES (?, ?)").run("broken", "{");
	const failure = await cycle(store).catch((error) => error);
	expect(failure).toBeInstanceOf(Error);
	expect(db.query("SELECT count(*) AS n FROM narrator_text_snapshots").get()).toEqual({ n: 1 });
	db.run("DELETE FROM narrator_messages");
	expect(await cycle(store)).toBe(1);
});

test("after GC deletes an orphan manifest and children, the same immutable input writes them anew", async () => {
	const { store, db } = await fixture();
	const definitions = [definition("recreate")];
	const hash = await store.putPrefixToolDefinitions(definitions);
	await store.getPrefixToolDefinitions(hash);
	db.run("UPDATE narrator_text_snapshots SET created_at = '2000-01-01T00:00:00.000Z'");
	await cycle(store);
	await cycle(store);
	expect(db.query("SELECT count(*) AS n FROM narrator_text_snapshots").get()).toEqual({ n: 0 });
	expect(await store.putPrefixToolDefinitions([...definitions], new AbortController().signal)).toBe(
		hash,
	);
	expect(await store.getPrefixToolDefinitions(hash)).toEqual(definitions);
	expect(db.query("SELECT count(*) AS n FROM narrator_text_snapshots").get()).toEqual({ n: 2 });
});

test("maintenance stop awaits in-flight cancellation and does not cancel somebody else's queued write", async () => {
	let entered!: () => void;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let finished = false;
	const stop = createPrefixSnapshotMaintenance(
		async (signal) => {
			entered();
			await new Promise<void>((resolve) =>
				signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			await Bun.sleep(20);
			finished = true;
			return { phase: "done", deleted: 0, visited: 0 };
		},
		{ intervalMs: 1, startDelayMs: 0 },
	);
	await ready;
	await stop();
	expect(finished).toBe(true);
	const { store, db } = await fixture();
	await store.putPrefixText("warmup");
	db.run("BEGIN IMMEDIATE");
	const other = store.putPrefixText("unrelated write");
	const stopQueued = createPrefixSnapshotMaintenance(
		(signal) => store.cleanupPrefixSnapshots({}, signal),
		{ intervalMs: 1, startDelayMs: 0 },
	);
	await Bun.sleep(20);
	await stopQueued();
	db.run("ROLLBACK");
	expect(await other).toMatch(/^[a-f0-9]{64}$/);
});

test("aborting active GC waits for its worker and leaves the database writable", async () => {
	const { store, db } = await fixture();
	await store.putPrefixText("old orphan");
	db.run("UPDATE narrator_text_snapshots SET created_at = '2000-01-01T00:00:00.000Z'");
	for (;;) {
		if ((await store.cleanupPrefixSnapshots()).phase === "sweep") break;
	}
	db.run("BEGIN IMMEDIATE");
	const controller = new AbortController();
	const pending = store.cleanupPrefixSnapshots({}, controller.signal).catch((error) => error);
	await Bun.sleep(10);
	controller.abort(new Error("stop active GC"));
	expect((await pending).message).toBe("stop active GC");
	db.run("ROLLBACK");
	expect(await store.putPrefixText("after GC stopped")).toMatch(/^[a-f0-9]{64}$/);
});

async function pressure(store: PrefixSnapshotStore, label: string) {
	const definitions = Array.from({ length: 10000 }, (_, index) =>
		definition(`tool${index}`, `${index}:${"d".repeat(4096)}`),
	);
	let beats = 0;
	let gap = 0;
	let last = performance.now();
	const heartbeat = setInterval(() => {
		const now = performance.now();
		gap = Math.max(gap, now - last);
		last = now;
		beats++;
	}, 5);
	try {
		const started = performance.now();
		const controllers = Array.from({ length: 8 }, () => new AbortController());
		const hashes = await Promise.all(
			controllers.map((controller) =>
				store.putPrefixToolDefinitions(
					definitions.map((value) => ({ ...value })),
					controller.signal,
				),
			),
		);
		const putMs = performance.now() - started;
		expect(new Set(hashes).size).toBe(1);
		const readStarted = performance.now();
		const restored = await Promise.all(
			controllers.map((controller) => store.getPrefixToolDefinitions(hashes[0], controller.signal)),
		);
		const readMs = performance.now() - readStarted;
		expect(restored.every((value) => value === restored[0])).toBe(true);
		expect(restored[0]).toEqual(definitions);
		const hotStarted = performance.now();
		expect(await store.putPrefixToolDefinitions([...definitions], controllers[0].signal)).toBe(
			hashes[0],
		);
		expect(await store.getPrefixToolDefinitions(hashes[0], controllers[1].signal)).toBe(
			restored[0],
		);
		const hotMs = performance.now() - hotStarted;
		const giant = definition("giant", "z".repeat(80 * 1024 * 1024));
		const giantStarted = performance.now();
		const giantHash = await store.putPrefixToolDefinitions([giant], controllers[2].signal);
		const giantRestored = await store.getPrefixToolDefinitions(giantHash, controllers[3].signal);
		expect(giantRestored[0].description).toBe(giant.description);
		expect(await store.getPrefixToolDefinitions(giantHash, controllers[4].signal)).toBe(
			giantRestored,
		);
		const giantMs = performance.now() - giantStarted;
		await Bun.sleep(10);
		expect(beats).toBeGreaterThan(20);
		expect(gap).toBeLessThan(1500);
		console.info("PREFIX_TOOL_UNITS_PERF", {
			label,
			putMs,
			readMs,
			hotMs,
			giantMs,
			beats,
			maxGapMs: gap,
		});
	} finally {
		clearInterval(heartbeat);
	}
}

test.skipIf(process.env.NF_PREFIX_SNAPSHOT_PERF !== "1")(
	"real signals, eight callers, different 10000-tool arrays and one 80MiB tool",
	async () => {
		const { store } = await fixture({ cacheBytes: 1024 * 1024 }); // catalog far exceeds strong cache
		await pressure(store, "sqlite");
	},
	120000,
);

test.skipIf(process.env.PG_INTEGRATION !== "1")(
	"PostgreSQL unit manifests, conservative GC and optional real-signal pressure",
	async () => {
		const outcome = await withPostgres(async ({ exec, port, credentials }) => {
			const result = await exec(schema);
			if (result.code !== 0) throw new Error("test schema failed");
			const url = `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${port}/nf_harness`;
			const store = createPrefixSnapshotStore(
				{ backend: "postgres", url },
				{ cacheBytes: 1024 * 1024 },
			);
			const sql = new SQL(url, { max: 1 });
			try {
				await exerciseGc(
					store,
					async <T>(statement: string, parameters: Array<string | number> = []) => {
						let index = 0;
						return (await sql.unsafe(
							statement.replace(/\?/g, () => `$${++index}`),
							parameters,
						)) as T[];
					},
				);
				if (process.env.NF_PREFIX_SNAPSHOT_PERF === "1") await pressure(store, "postgres");
				return { verified: true };
			} finally {
				await store.close();
				await sql.close();
			}
		});
		if ("status" in outcome) throw new Error(`PostgreSQL harness ${outcome.status}`);
		expect(outcome.verified).toBe(true);
	},
	120000,
);
