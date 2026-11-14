import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import * as connector from "../lib/compiled-worker";
import { WorkerCleanupError } from "../lib/worker-runtime/lifecycle";
import {
	closePrefixSnapshotStore,
	createPrefixSnapshotStore,
	getPrefixJson,
	type PrefixSnapshotStore,
	putPrefixText,
	resetPrefixSnapshotStoreForTests,
} from "./narrator-prefix-snapshots";
import type { PrefixSnapshotRequest } from "./narrator-prefix-snapshots-worker";

const connect = connector.connectCompiledWorker;
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function until(check: () => boolean): Promise<void> {
	const end = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= end) throw new Error("Prefix lifecycle condition was not reached");
		await Bun.sleep(1);
	}
}
async function fixture(options: Parameters<typeof createPrefixSnapshotStore>[1] = {}) {
	const root = await mkdtemp(join(tmpdir(), "prefix-lifecycle-"));
	const path = join(root, "snapshots.db");
	const db = new Database(path);
	db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE narrator_text_snapshots (sha256 TEXT PRIMARY KEY, text TEXT NOT NULL, byte_size INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE narrator_block_assets (block_id TEXT NOT NULL, asset_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(block_id, asset_id));
CREATE INDEX prefix_assets ON narrator_block_assets(asset_id);
CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, content_json TEXT NOT NULL);
CREATE TABLE narrator_blocks (id TEXT PRIMARY KEY, payload TEXT NOT NULL);`);
	const store = createPrefixSnapshotStore({ backend: "sqlite", path }, options);
	cleanups.push(async () => {
		await store.close();
		db.close();
		await rm(root, { recursive: true, force: true });
	});
	return { root, path, store, db };
}
function spyConnection(implementation: typeof connect) {
	const spy = spyOn(connector, "connectCompiledWorker").mockImplementation(implementation);
	cleanups.push(() => spy.mockRestore());
	return spy;
}

test("the actor bounds queued items and cancellation removes only its waiter", async () => {
	const { store } = await fixture();
	let dispatches = 0;
	const connection = spyConnection(async (...args) => {
		const connected = await connect(...args);
		spyOn(connected.worker, "postMessage").mockImplementation(() => {
			dispatches++;
		});
		return connected;
	});
	const first = store.putPrefixText("active").catch((error: unknown) => error);
	await until(() => dispatches === 1);
	const cancelled = new AbortController();
	const waiting = store
		.putPrefixText("cancel waiter", cancelled.signal)
		.catch((error: unknown) => error);
	const queued = Array.from({ length: 31 }, (_, index) =>
		store.putPrefixText(`queued-${index}`).catch((error: unknown) => error),
	);
	await expect(store.putPrefixText("overflow")).rejects.toHaveProperty("code", "TASK_QUEUE_FULL");
	const reason = new Error("only this waiter");
	cancelled.abort(reason);
	expect(await waiting).toBe(reason);
	const replacement = store.putPrefixText("fits cancelled slot").catch((error: unknown) => error);
	await store.close();
	expect(
		(await Promise.all([first, ...queued, replacement])).every((error) => error instanceof Error),
	).toBe(true);
	expect(dispatches).toBe(1);
	expect(connection).toHaveBeenCalledTimes(1);
});

test("unknown JSON reserves the byte budget without serialization or body traversal", async () => {
	const { store } = await fixture();
	let dispatches = 0;
	spyConnection(async (...args) => {
		const connected = await connect(...args);
		spyOn(connected.worker, "postMessage").mockImplementation(() => {
			dispatches++;
		});
		return connected;
	});
	const active = store.putPrefixText("active").catch((error: unknown) => error);
	await until(() => dispatches === 1);
	let visited = 0;
	const value = {
		get body() {
			visited++;
			throw new Error("must not inspect queued JSON");
		},
	};
	const queued = store.putPrefixJson(value).catch((error: unknown) => error);
	await expect(store.putPrefixJson({ another: true })).rejects.toHaveProperty(
		"code",
		"TASK_QUEUE_FULL",
	);
	expect(visited).toBe(0);
	await store.close();
	expect(await active).toBeInstanceOf(Error);
	expect(await queued).toBeInstanceOf(Error);
	expect(visited).toBe(0);
	expect(dispatches).toBe(1);
});

for (const failure of ["rpc", "gc cancellation"] as const) {
	test(`${failure} holds the serial lane and its result until actual native exit`, async () => {
		const { store } = await fixture();
		const gate = Promise.withResolvers<void>();
		const stopping = Promise.withResolvers<void>();
		let firstWorker: Worker | undefined;
		let request: PrefixSnapshotRequest | undefined;
		let exited = false;
		let creates = 0;
		spyConnection(async (...args) => {
			const connected = await connect(...args);
			if (++creates === 1) {
				firstWorker = connected.worker;
				connected.worker.once("exit", () => {
					exited = true;
				});
				const close = connected.handle.close.bind(connected.handle);
				spyOn(connected.handle, "close").mockImplementation(async () => {
					stopping.resolve();
					await gate.promise;
					await close();
				});
				spyOn(connected.worker, "postMessage").mockImplementation((message) => {
					request = message;
				});
			}
			return connected;
		});
		const controller = new AbortController();
		let settled = false;
		const one = (
			failure === "rpc"
				? store.putPrefixText("one")
				: store.cleanupPrefixSnapshots({}, controller.signal)
		).catch((error: unknown) => {
			settled = true;
			return error;
		});
		try {
			await until(() => !!request);
			const next = store.putPrefixText("after retirement");
			if (failure === "rpc")
				firstWorker?.emit("message", {
					requestId: request?.requestId,
					error: "Prefix snapshot injected failure",
				});
			else controller.abort(new Error("cancel collector"));
			await stopping.promise;
			expect(settled).toBe(false);
			expect(exited).toBe(false);
			expect(creates).toBe(1);
			gate.resolve();
			expect(await one).toBeInstanceOf(Error);
			expect(exited).toBe(true);
			expect(await next).toBe(hashOf("after retirement"));
			expect(creates).toBe(2);
		} finally {
			gate.resolve();
		}
	});
}

test("GC slices share a native connection and a replacement restarts marking, never old sweep", async () => {
	const { store, db } = await fixture();
	const threads = new Set<Worker>();
	let creates = 0;
	spyConnection(async (...args) => {
		const connected = await connect(...args);
		creates++;
		const post = connected.worker.postMessage.bind(connected.worker);
		spyOn(connected.worker, "postMessage").mockImplementation((request: PrefixSnapshotRequest) => {
			if (request.operation === "collect") threads.add(connected.worker);
			post(request);
		});
		return connected;
	});
	const root = await store.putPrefixText("protected");
	const orphan = await store.putPrefixText("orphan");
	db.query("INSERT INTO narrator_block_assets VALUES (?, ?, 'epoch_snapshot')").run("root", root);
	db.query("UPDATE narrator_text_snapshots SET created_at = '2000-01-01T00:00:00.000Z'").run();
	let phase = "assets";
	for (let step = 0; phase !== "sweep" && step < 30; step++) {
		phase = (await store.cleanupPrefixSnapshots({ batchSize: 1 })).phase;
	}
	expect(phase).toBe("sweep");
	expect(threads.size).toBe(1);
	const failure = await store.getPrefixText("invalid").catch((error: unknown) => error);
	expect((failure as Error).message).toContain("hash is invalid");
	const restarted = await store.cleanupPrefixSnapshots({ batchSize: 1 });
	expect(restarted).toEqual({ phase: "assets", visited: 1, deleted: 0 });
	expect(creates).toBe(2);
	expect(threads.size).toBe(2);
	expect(
		db.query("SELECT sha256 FROM narrator_text_snapshots WHERE sha256 = ?").get(orphan),
	).not.toBeNull();
	for (let step = 0; step < 30; step++) {
		if ((await store.cleanupPrefixSnapshots({ batchSize: 1 })).phase === "done") break;
	}
	expect(await store.getPrefixText(root)).toBe("protected");
	expect(
		db.query("SELECT sha256 FROM narrator_text_snapshots WHERE sha256 = ?").get(orphan),
	).toBeNull();
});

test("idle retirement starts a fresh collector rather than restoring an old cursor", async () => {
	const { store, db } = await fixture({ idleMs: 10 });
	let creates = 0;
	let exits = 0;
	spyConnection(async (...args) => {
		const connected = await connect(...args);
		creates++;
		connected.worker.once("exit", () => {
			exits++;
		});
		return connected;
	});
	for (let index = 0; index < 2; index++)
		db.query("INSERT INTO narrator_block_assets VALUES (?, ?, 'epoch_snapshot')").run(
			String(index),
			"a".repeat(64),
		);
	expect(await store.cleanupPrefixSnapshots({ batchSize: 1 })).toEqual({
		phase: "assets",
		visited: 1,
		deleted: 0,
	});
	await until(() => exits === 1);
	expect(await store.cleanupPrefixSnapshots({ batchSize: 1 })).toEqual({
		phase: "assets",
		visited: 1,
		deleted: 0,
	});
	expect(creates).toBe(2);
});

test("publication protection survives lease RPC completion until publish finally", async () => {
	const { store, db } = await fixture();
	const root = await store.putPrefixText("publishing");
	const published = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const publication = store.withPrefixSnapshotPublication([root], async () => {
		published.resolve();
		await release.promise;
	});
	await published.promise;
	try {
		// Defeat the durable grace timestamp: the parent scope's active lease must still mark it.
		db.query("UPDATE narrator_text_snapshots SET created_at = '2000-01-01T00:00:00.000Z'").run();
		for (let step = 0; step < 20; step++)
			if ((await store.cleanupPrefixSnapshots()).phase === "done") break;
		expect(
			db.query("SELECT sha256 FROM narrator_text_snapshots WHERE sha256 = ?").get(root),
		).not.toBeNull();
	} finally {
		release.resolve();
		await publication;
	}
	for (let step = 0; step < 20; step++)
		if ((await store.cleanupPrefixSnapshots()).phase === "done") break;
	expect(
		db.query("SELECT sha256 FROM narrator_text_snapshots WHERE sha256 = ?").get(root),
	).toBeNull();
});

for (const outcome of ["success", "publish failure", "native close failure"] as const) {
	test(`close drains the completed-lease publication through its ${outcome} finally`, async () => {
		await resetPrefixSnapshotStoreForTests();
		const { store } = await fixture();
		const previous = Promise.resolve(store);
		owner().store = previous;
		let exited = false;
		const failure = new Error(
			outcome === "native close failure" ? "native close failed" : "business publish failed",
		);
		const connection = spyConnection(async (...args) => {
			const connected = await connect(...args);
			connected.worker.once("exit", () => {
				exited = true;
			});
			if (outcome === "native close failure") {
				const close = connected.handle.close.bind(connected.handle);
				spyOn(connected.handle, "close").mockImplementation(async () => {
					await close();
					throw failure;
				});
			}
			return connected;
		});
		const hash = await store.putPrefixJson({ cached: true });
		await store.getPrefixJson(hash);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let publishedFinally = false;
		const publication = store
			.withPrefixSnapshotPublication([hash], async () => {
				entered.resolve(); // The real lease RPC already completed before this callback.
				try {
					await release.promise;
					if (outcome === "publish failure") throw failure;
					return "published";
				} finally {
					publishedFinally = true;
				}
			})
			.catch((error: unknown) => error);
		await entered.promise;
		let closed = false;
		const closing = closePrefixSnapshotStore().then(
			() => {
				closed = true;
			},
			(error: unknown) => {
				closed = true;
				return error;
			},
		);
		try {
			await until(() => exited);
			expect(closed).toBe(false);
			expect(publishedFinally).toBe(false);
			expect(owner().store).toBe(previous);
			let newPublication = false;
			await expect(
				store.withPrefixSnapshotPublication([hash], async () => {
					newPublication = true;
				}),
			).rejects.toThrow("closed");
			await expect(store.getPrefixJson(hash)).rejects.toThrow("closed");
			await expect(getPrefixJson(hash)).rejects.toThrow("closed");
			expect(newPublication).toBe(false);
			expect(connection).toHaveBeenCalledTimes(1);
			release.resolve();
			expect(await publication).toBe(outcome === "publish failure" ? failure : "published");
			expect(await closing).toBe(outcome === "native close failure" ? failure : undefined);
			expect(closed).toBe(true);
			expect(publishedFinally).toBe(true);
			if (outcome === "native close failure") {
				expect(owner().store).toBe(previous);
				await expect(putPrefixText("failed close cannot reopen")).rejects.toThrow("closed");
			} else expect(owner().store).toBeUndefined();
		} finally {
			release.resolve();
			await publication;
			await closing;
			if (outcome === "native close failure") {
				// Repair only this injected test fault, after the real thread was confirmed gone.
				expect(exited).toBe(true);
				const close = store.close.bind(store);
				store.close = async () => {
					try {
						await close();
					} catch (error) {
						if (error !== failure) throw error;
					}
				};
				owner().store = undefined;
				owner().closing = undefined;
			}
			await resetPrefixSnapshotStoreForTests();
		}
	});
}

test("old IDs and duplicate ready cannot complete an RPC; malformed matching results retire it", async () => {
	const { store } = await fixture();
	const posts: Array<{ worker: Worker; request: PrefixSnapshotRequest }> = [];
	spyConnection(async (...args) => {
		const connected = await connect(...args);
		spyOn(connected.worker, "postMessage").mockImplementation((request) => {
			posts.push({ worker: connected.worker, request });
		});
		return connected;
	});
	let settled = false;
	const first = store.putPrefixText("first").then((value) => {
		settled = true;
		return value;
	});
	await until(() => posts.length === 1);
	const one = posts[0];
	one.worker.emit("message", { ready: true });
	one.worker.emit("message", { requestId: "old-rpc", value: hashOf("old") });
	await Bun.sleep(0);
	expect(settled).toBe(false);
	one.worker.emit("message", { requestId: one.request.requestId, value: hashOf("first") });
	expect(await first).toBe(hashOf("first"));
	const second = store.putPrefixText("second").catch((error: unknown) => error);
	await until(() => posts.length === 2);
	expect(posts[1].worker).toBe(one.worker);
	one.worker.emit("message", { requestId: one.request.requestId, value: hashOf("first") });
	one.worker.emit("message", { requestId: posts[1].request.requestId, value: undefined });
	expect(await second).toBeInstanceOf(Error);
	const third = store.putPrefixText("third");
	await until(() => posts.length === 3);
	expect(posts[2].worker).not.toBe(one.worker);
	posts[2].worker.emit("message", {
		requestId: posts[2].request.requestId,
		value: hashOf("third"),
	});
	expect(await third).toBe(hashOf("third"));
});

test("create, unready, runtime failure, timeout and closed paths never calculate JSON inline", async () => {
	const { store, root, db } = await fixture({ timeoutMs: 500 });
	const value = { secret: "only the worker may serialize this" };
	const stringify = JSON.stringify;
	let inline = 0;
	const json = spyOn(JSON, "stringify").mockImplementation(((
		input: unknown,
		...rest: unknown[]
	) => {
		if (input === value) inline++;
		return Reflect.apply(stringify, JSON, [input, ...rest]);
	}) as typeof JSON.stringify);
	cleanups.push(() => json.mockRestore());
	let mode: "create" | "unready" | "runtime" | "timeout" = "create";
	const unready = join(root, "unready.ts");
	await writeFile(
		unready,
		'import { parentPort } from "node:worker_threads"; parentPort?.on("message", () => {});',
	);
	const connection = spyConnection(async (...args) => {
		if (mode === "create") throw new Error("injected create failure");
		if (mode === "unready")
			return connect([unready], { ...args[1], timeoutMs: 30, deadlineAt: Date.now() + 30 });
		const connected = await connect(...args);
		spyOn(connected.worker, "postMessage").mockImplementation(() => {
			if (mode === "runtime") void connected.worker.terminate();
		});
		return connected;
	});
	for (const failure of ["create", "unready", "runtime", "timeout"] as const) {
		mode = failure;
		const result = await store.putPrefixJson(value).catch((error: unknown) => error);
		expect(result).toBeInstanceOf(Error);
	}
	await store.close();
	await expect(store.putPrefixJson(value)).rejects.toThrow("closed");
	expect(connection).toHaveBeenCalledTimes(4);
	expect(inline).toBe(0);
	expect(db.query("SELECT count(*) AS n FROM narrator_text_snapshots").get()).toEqual({ n: 0 });
});

test("startup time consumes the first operation budget and close during startup cannot open a replacement", async () => {
	const { store } = await fixture({ timeoutMs: 150 });
	const connectedGate = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let firstDeadline = 0;
	let dispatched = false;
	let exited = false;
	const connection = spyConnection(async (...args) => {
		firstDeadline = args[1]?.deadlineAt ?? 0;
		const connected = await connect(...args);
		connected.worker.once("exit", () => {
			exited = true;
		});
		spyOn(connected.worker, "postMessage").mockImplementation(() => {
			dispatched = true;
		});
		connectedGate.resolve();
		await release.promise;
		return connected;
	});
	const operation = store.putPrefixText("startup").catch((error: unknown) => error);
	try {
		await connectedGate.promise;
		expect(Number.isFinite(firstDeadline)).toBe(true);
		const closing = store.close();
		await expect(store.putPrefixText("cannot reopen")).rejects.toThrow("closed");
		release.resolve();
		await closing;
		expect(await operation).toBeInstanceOf(Error);
		expect(dispatched).toBe(false);
		expect(exited).toBe(true);
		expect(connection).toHaveBeenCalledTimes(1);
	} finally {
		release.resolve();
	}
});

test("ready time consumes only the first finite operation budget; reused RPCs get fresh budgets", async () => {
	const { store } = await fixture({ timeoutMs: 220 });
	let now = 1000;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const posts: Array<{ worker: Worker; request: PrefixSnapshotRequest }> = [];
	let readyDeadline = 0;
	spyConnection(async (...args) => {
		readyDeadline = args[1]?.deadlineAt ?? 0;
		const connected = await connect(...args);
		// Deterministically charge startup without a wall-clock sleep or shortening its limit.
		now += 100;
		spyOn(connected.worker, "postMessage").mockImplementation((request) => {
			posts.push({ worker: connected.worker, request });
		});
		return connected;
	});
	try {
		const first = store.putPrefixText("first budget");
		await until(() => posts.length === 1);
		expect(readyDeadline).toBe(1220);
		expect(posts[0].request.deadline).toBe(1220);
		posts[0].worker.emit("message", {
			requestId: posts[0].request.requestId,
			value: hashOf("first budget"),
		});
		await first;
		now = 1120;
		const next = store.putPrefixText("fresh reused budget");
		await until(() => posts.length === 2);
		expect(posts[1].worker).toBe(posts[0].worker);
		expect(posts[1].request.deadline).toBe(1340);
		posts[1].worker.emit("message", {
			requestId: posts[1].request.requestId,
			value: hashOf("fresh reused budget"),
		});
		await next;
		await store.close();
	} finally {
		clock.mockRestore();
	}
});

test("failed startup cleanup keeps its native resource accounted until externally confirmed exit", async () => {
	const { store } = await fixture();
	let creates = 0;
	let worker: Worker | undefined;
	let terminate: (() => Promise<number>) | undefined;
	spyConnection(async (...args) => {
		const connected = await connect(...args);
		if (++creates === 1) {
			worker = connected.worker;
			terminate = connected.worker.terminate.bind(connected.worker);
			spyOn(connected.worker, "terminate").mockRejectedValue(new Error("injected stop failure"));
			await connected.handle.close().catch(() => {});
			throw new WorkerCleanupError(connected.handle, new Error("unconfirmed startup cleanup"));
		}
		return connected;
	});
	await expect(store.putPrefixText("failed startup")).rejects.toBeInstanceOf(WorkerCleanupError);
	let done = false;
	const next = store.putPrefixText("after confirmed exit").then((value) => {
		done = true;
		return value;
	});
	try {
		await Bun.sleep(5);
		expect(creates).toBe(1);
		expect(done).toBe(false);
		expect(worker).toBeDefined();
		await terminate?.();
		expect(await next).toBe(hashOf("after confirmed exit"));
		expect(creates).toBe(2);
	} finally {
		await terminate?.();
	}
});

type Owner = {
	ownerVersion: number;
	store: Promise<PrefixSnapshotStore> | undefined;
	closing: Promise<void> | undefined;
	permanent: boolean;
};
const owner = () => Reflect.get(globalThis, Symbol.for("narrator.prefixSnapshots.v2")) as Owner;

test("default owner remains closed during drain/HMR and permanent shutdown includes cached reads", async () => {
	await resetPrefixSnapshotStoreForTests();
	const { store } = await fixture();
	owner().store = Promise.resolve(store);
	const gate = Promise.withResolvers<void>();
	const stopping = Promise.withResolvers<void>();
	let exited = false;
	const connection = spyConnection(async (...args) => {
		const connected = await connect(...args);
		connected.worker.once("exit", () => {
			exited = true;
		});
		const close = connected.handle.close.bind(connected.handle);
		spyOn(connected.handle, "close").mockImplementation(async () => {
			stopping.resolve();
			await gate.promise;
			await close();
		});
		return connected;
	});
	const hash = await store.putPrefixJson({ cached: true });
	await getPrefixJson(hash);
	const closing = closePrefixSnapshotStore();
	try {
		await stopping.promise;
		await expect(getPrefixJson(hash)).rejects.toThrow("closed");
		await expect(putPrefixText("while closing")).rejects.toThrow("closed");
		const reloaded = (await import(
			`${new URL("./narrator-prefix-snapshots.ts", import.meta.url).href}?hmr=${crypto.randomUUID()}`
		)) as typeof import("./narrator-prefix-snapshots");
		await expect(reloaded.putPrefixText("HMR cannot replace owner")).rejects.toThrow("closed");
		expect(exited).toBe(false);
		expect(connection).toHaveBeenCalledTimes(1);
		gate.resolve();
		await closing;
		expect(exited).toBe(true);
		expect(owner().store).toBeUndefined();
		await closePrefixSnapshotStore({ permanent: true });
		await expect(getPrefixJson(hash)).rejects.toThrow("closed");
	} finally {
		gate.resolve();
		await closing;
		await resetPrefixSnapshotStoreForTests();
	}
});

test("a failed default close retains its owner and cannot reopen or reset around an unconfirmed worker", async () => {
	await resetPrefixSnapshotStoreForTests();
	const { store } = await fixture();
	const connection = spyConnection(connect);
	const hash = await store.putPrefixJson({ cached: true });
	await store.getPrefixJson(hash);
	const previous = Promise.resolve({
		...store,
		close: async () => {
			throw new Error("unconfirmed native close");
		},
	});
	owner().store = previous;
	try {
		await expect(closePrefixSnapshotStore()).rejects.toThrow("unconfirmed native close");
		expect(owner().store).toBe(previous);
		await expect(getPrefixJson(hash)).rejects.toThrow("closed");
		await expect(putPrefixText("must not replace failed owner")).rejects.toThrow("closed");
		await expect(resetPrefixSnapshotStoreForTests()).rejects.toThrow("unconfirmed native close");
		expect(connection).toHaveBeenCalledTimes(1);
	} finally {
		// Only test isolation may clear this fault, and only after the real native owner exits.
		await store.close();
		owner().store = undefined;
		owner().closing = undefined;
		await resetPrefixSnapshotStoreForTests();
	}
});

test("legacy hot owner fails closed even with no queued jobs and cannot be reset into new workers", async () => {
	await resetPrefixSnapshotStoreForTests();
	const state = owner();
	const connection = spyConnection(connect);
	Reflect.deleteProperty(state, "ownerVersion");
	try {
		await expect(putPrefixText("legacy owner")).rejects.toThrow("requires a server restart");
		await expect(resetPrefixSnapshotStoreForTests()).rejects.toThrow("requires a server restart");
		expect(connection).not.toHaveBeenCalled();
	} finally {
		state.ownerVersion = 3;
		state.closing = undefined;
		await resetPrefixSnapshotStoreForTests();
	}
});

test("a throwing payload-free timing sink cannot change result or teardown", async () => {
	const { store } = await fixture();
	let now = 0;
	const clock = spyOn(performance, "now").mockImplementation(() => (now += 2000));
	const warn = spyOn(console, "warn").mockImplementation(() => {
		throw new Error("sink failure");
	});
	try {
		expect(await store.putPrefixText("PRIVATE_PAYLOAD")).toBe(hashOf("PRIVATE_PAYLOAD"));
		await store.close();
		expect(warn).toHaveBeenCalledTimes(1);
		const fields = warn.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(
			Object.values(fields).every((value) =>
				["string", "number", "boolean"].includes(typeof value),
			),
		).toBe(true);
		expect(Object.keys(fields).sort()).toEqual(
			[
				"backend",
				"closeMs",
				"execMs",
				"kind",
				"outcome",
				"queueMs",
				"readyMs",
				"requestId",
				"reused",
				"totalMs",
			].sort(),
		);
		expect(Object.values(fields)).not.toContain("PRIVATE_PAYLOAD");
	} finally {
		warn.mockRestore();
		clock.mockRestore();
	}
});
