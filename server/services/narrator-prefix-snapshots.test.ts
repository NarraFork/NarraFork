import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { blockAssets } from "../../shared/narrator-blocks/plan";
import type { BlockDraft } from "../../shared/narrator-blocks/storage";
import { withPostgres } from "../../tests/db/pg-test-harness";
import { createPrefixSnapshotStore, type PrefixSnapshotStore } from "./narrator-prefix-snapshots";
import { PrefixSnapshotCache } from "./narrator-prefix-snapshots-worker";

const schema = `CREATE TABLE narrator_text_snapshots (
 sha256 TEXT PRIMARY KEY, text TEXT NOT NULL, byte_size INTEGER NOT NULL, created_at TEXT NOT NULL
)`;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(options: Parameters<typeof createPrefixSnapshotStore>[1] = {}) {
	const root = await mkdtemp(join(tmpdir(), "prefix-snapshots-"));
	const path = join(root, "snapshots.db");
	const db = new Database(path);
	db.run("PRAGMA journal_mode = WAL");
	db.run(schema);
	const store = createPrefixSnapshotStore({ backend: "sqlite", path }, options);
	cleanups.push(async () => {
		await store.close();
		db.close();
		await rm(root, { recursive: true, force: true });
	});
	return { db, store, path };
}
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

async function roundtrip(store: PrefixSnapshotStore) {
	const text = "前缀\nwith Unicode 🐈";
	const hash = await store.putPrefixText(text);
	expect(hash).toBe(hashOf(text));
	expect(await store.putPrefixText(text)).toBe(hash);
	expect(await store.getPrefixText(hash)).toBe(text);
	const value = { tools: [{ name: "Read", description: "读取", schema: { type: "object" } }] };
	const jsonHash = await store.putPrefixJson(value);
	expect(jsonHash).toBe(hashOf(JSON.stringify(value)));
	expect(await store.getPrefixJson(jsonHash)).toEqual(value);
	return { hash, jsonHash };
}

test("content-addressed Unicode text/JSON roundtrip and conflict reuse", async () => {
	const { store, db } = await fixture();
	const { jsonHash } = await roundtrip(store);
	expect(db.query("SELECT count(*) AS n FROM narrator_text_snapshots").get()).toEqual({ n: 2 });
	const decoded = await store.getPrefixJson<{ tools: unknown[] }>(jsonHash);
	expect(() => {
		decoded.tools.length = 0;
	}).toThrow();
	expect(await store.getPrefixJson(jsonHash)).toBe(decoded);
	expect(Object.isFrozen(decoded.tools[0])).toBe(true);
	expect((await store.getPrefixJson<{ tools: unknown[] }>(jsonHash)).tools).toHaveLength(1);
	expect(await store.putPrefixText("")).toBe(hashOf(""));
	expect(await store.getPrefixText(hashOf(""))).toBe("");
});

test("coalesces concurrent same-object puts, but snapshots later mutations", async () => {
	const { store, db } = await fixture();
	const value = { tools: ["Read"] };
	const one = store.putPrefixJson(value);
	const two = store.putPrefixJson(value);
	expect(one).toBe(two);
	const hashes = await Promise.all(Array.from({ length: 40 }, () => store.putPrefixJson(value)));
	expect(new Set(hashes).size).toBe(1);
	const before = await one;
	value.tools.push("Write");
	const after = await store.putPrefixJson(value);
	expect(before).not.toBe(after);
	expect(await store.getPrefixJson(before)).toEqual({ tools: ["Read"] });
	expect(db.query("SELECT count(*) AS n FROM narrator_text_snapshots").get()).toEqual({ n: 2 });
});

test("cache budget evicts old values; an oversized item is still persisted and readable", async () => {
	const cache = new PrefixSnapshotCache(600);
	cache.set("a", "a".repeat(100), 100);
	cache.set("b", "b".repeat(100), 100);
	expect(cache.size).toBe(1);
	expect(cache.get("a")).toBeUndefined();
	cache.set("large", "x".repeat(10000), 10000);
	expect(cache.get("large")).toBeUndefined();
	expect(cache.get("b")).toBe("b".repeat(100));
	expect(cache.retainedBytes).toBeLessThanOrEqual(600);
	const { store } = await fixture({ cacheBytes: 1 });
	const text = "大".repeat(128 * 1024);
	const hash = await store.putPrefixText(text);
	expect(await store.getPrefixText(hash)).toBe(text);
});

test("caller-held frozen objects survive strong-cache eviction through weak reuse", async () => {
	const { store } = await fixture({ cacheBytes: 1600 });
	const firstHash = await store.putPrefixJson({ text: "a".repeat(300) });
	const secondHash = await store.putPrefixJson({ text: "b".repeat(300) });
	const first = await store.getPrefixJson(firstHash);
	expect(await store.getPrefixJson(firstHash)).toBe(first);
	await store.getPrefixJson(secondHash);
	const reloaded = await store.getPrefixJson(firstHash);
	expect(reloaded).toEqual(first);
	expect(reloaded).toBe(first);
	const giantHash = await store.putPrefixJson({ text: "g".repeat(5000) });
	const giant = await store.getPrefixJson(giantHash);
	expect(Object.isFrozen(giant)).toBe(true);
	expect(await store.getPrefixJson(giantHash)).toEqual(giant);
	expect(await store.getPrefixJson(giantHash)).toBe(giant);
});

test("idle workers reopen the same snapshots and pre-aborted reads do not use the cache", async () => {
	const { store } = await fixture({ idleMs: 5 });
	const hash = await store.putPrefixText("durable");
	await Bun.sleep(20);
	expect(await store.getPrefixText(hash)).toBe("durable");
	const jsonHash = await store.putPrefixJson({ text: "cached" });
	await store.getPrefixJson(jsonHash);
	const controller = new AbortController();
	controller.abort(new Error("already aborted"));
	await expect(store.getPrefixJson(jsonHash, controller.signal)).rejects.toThrow("already aborted");
});

test("fails closed for missing, malformed, corrupt snapshots and recovers after errors", async () => {
	const { store, db } = await fixture({ cacheBytes: 0 });
	await expect(store.getPrefixText("not-a-hash")).rejects.toThrow("hash is invalid");
	await expect(store.getPrefixText("0".repeat(64))).rejects.toThrow("not found");
	const hash = await store.putPrefixText("original");
	db.query("UPDATE narrator_text_snapshots SET text = ? WHERE sha256 = ?").run("changed", hash);
	const corruptError = await store.getPrefixText(hash).catch((error: Error) => error);
	expect(corruptError).toBeInstanceOf(Error);
	expect((corruptError as Error).message).toContain("integrity mismatch");
	await expect(store.putPrefixJson(undefined)).rejects.toThrow();
	await expect(store.putPrefixJson({ fn: () => {} })).rejects.toThrow("cannot be cloned");
	expect(await store.getPrefixText(await store.putPrefixText("recovered"))).toBe("recovered");
});

test("queued cancellation is prompt and cannot cancel another caller's write", async () => {
	const { store, db } = await fixture();
	await store.putPrefixText("warmup");
	db.run("BEGIN IMMEDIATE");
	const first = store.putPrefixText("blocked-write");
	const abort = new AbortController();
	const second = store.putPrefixText("cancelled-write", abort.signal);
	abort.abort(new Error("cancel queued"));
	await expect(second).rejects.toThrow("cancel queued");
	db.run("ROLLBACK");
	expect(await first).toBe(hashOf("blocked-write"));
	// Await normally: Bun's synchronous rejects matcher can starve an already-running worker.
	const missing = await store
		.getPrefixText(hashOf("cancelled-write"))
		.catch((error: Error) => error);
	expect((missing as Error).message).toContain("not found");
});

test("active cancellation and timeout retire the worker; following requests recover", async () => {
	const { store, db } = await fixture({ timeoutMs: 500 });
	await store.putPrefixText("warmup");
	db.run("BEGIN IMMEDIATE");
	const abort = new AbortController();
	const blocked = store.putPrefixText("blocked", abort.signal);
	setTimeout(() => abort.abort(new Error("cancel active")), 50);
	await expect(blocked).rejects.toThrow("cancel active");
	await expect(store.putPrefixText("timed-out")).rejects.toThrow("timed out");
	db.run("ROLLBACK");
	expect(await store.putPrefixText("recovered")).toBe(hashOf("recovered"));
});

test("close rejects active and queued work without leaving hanging promises", async () => {
	const { store } = await fixture();
	const one = store.putPrefixText("one").catch((error: Error) => error);
	const two = store.putPrefixText("two").catch((error: Error) => error);
	await store.close();
	expect(((await one) as Error).message).toContain("closed");
	expect(((await two) as Error).message).toContain("closed");
	await expect(store.putPrefixText("three")).rejects.toThrow("closed");
});

test("epoch prefix assets include contract, all parts and tools, deduplicated", () => {
	const draft: BlockDraft = {
		key: "epoch",
		kind: "context",
		subtype: "epoch_start",
		phase: "done",
		wireId: null,
		modelText: null,
		state: null,
		canonical: null,
		payload: {
			raw: [
				{
					type: "compact",
					epoch: {
						prefix: {
							contract: "contract-hash",
							tools: "tools-hash",
							parts: [
								{ key: "core", hash: "core-hash" },
								{ key: "same", hash: "tools-hash" },
							],
						},
					},
				},
			],
		},
	};
	expect(blockAssets(draft, undefined)).toEqual([
		["contract-hash", "epoch_snapshot"],
		["tools-hash", "epoch_snapshot"],
		["core-hash", "epoch_snapshot"],
	]);
	draft.payload.raw = [
		{ type: "compact" },
		{ type: "image", imageId: "image" },
		{ type: "tool_loaded", definitionSnapshotRef: "definition-hash" },
	];
	expect(blockAssets(draft, undefined)).toEqual([
		["image", "input_image"],
		["definition-hash", "epoch_snapshot"],
	]);
});

test.skipIf(process.env.NF_PREFIX_SNAPSHOT_PERF !== "1")(
	"10000 tools / tens of MiB and an 80 MiB single item preserve heartbeat and content",
	async () => {
		const { store, db } = await fixture();
		const tools = Array.from({ length: 10000 }, (_, index) => ({
			name: `Tool_${index}`,
			description: `${index}:${"d".repeat(4096)}`,
			inputSchema: { type: "object", properties: { input: { type: "string" } } },
		}));
		let beats = 0;
		let maxGapMs = 0;
		let last = performance.now();
		const heartbeat = setInterval(() => {
			const now = performance.now();
			maxGapMs = Math.max(maxGapMs, now - last);
			last = now;
			beats++;
		}, 5);
		try {
			const started = performance.now();
			const hashes = await Promise.all(Array.from({ length: 8 }, () => store.putPrefixJson(tools)));
			const jsonPutMs = performance.now() - started;
			expect(new Set(hashes).size).toBe(1);
			const readStarted = performance.now();
			const restored = await store.getPrefixJson<typeof tools>(hashes[0]);
			const jsonGetMs = performance.now() - readStarted;
			const hotStarted = performance.now();
			expect(await store.getPrefixJson(hashes[0])).toBe(restored);
			const jsonHotMs = performance.now() - hotStarted;
			expect(restored.length).toBe(10000);
			for (let i = 0; i < tools.length; i++) {
				expect(restored[i].name).toBe(tools[i].name);
				expect(restored[i].description).toBe(tools[i].description);
			}
			const huge = "z".repeat(80 * 1024 * 1024);
			const hugeStarted = performance.now();
			const hugeHash = await store.putPrefixText(huge);
			expect(await store.getPrefixText(hugeHash)).toBe(huge);
			const hugeRoundtripMs = performance.now() - hugeStarted;
			await Bun.sleep(10);
			const rows = db
				.query("SELECT byte_size FROM narrator_text_snapshots ORDER BY byte_size")
				.all();
			expect(rows).toHaveLength(2);
			expect(beats).toBeGreaterThan(10);
			// Catch an accidental multi-second synchronous DB/JSON path, without flaky tight timing.
			expect(maxGapMs).toBeLessThan(1500);
			console.info("PREFIX_SNAPSHOT_PERF", {
				jsonPutMs,
				jsonGetMs,
				jsonHotMs,
				hugeRoundtripMs,
				beats,
				maxGapMs,
				rows,
			});
		} finally {
			clearInterval(heartbeat);
		}
	},
	120000,
);

test.skipIf(process.env.NF_PREFIX_SNAPSHOT_COMPILED !== "1")(
	"compiled snapshot worker loads outside the source tree",
	async () => {
		const { path } = await fixture();
		const project = resolve(import.meta.dir, "../..");
		const directory = await mkdtemp(join(tmpdir(), "prefix-snapshot-compiled-"));
		const probe = join(project, `.prefix-snapshot-probe-${crypto.randomUUID()}.ts`);
		const binary = join(directory, process.platform === "win32" ? "probe.exe" : "probe");
		const exec = promisify(execFile);
		try {
			await writeFile(
				probe,
				`import { createPrefixSnapshotStore } from "./server/services/narrator-prefix-snapshots";
const store = createPrefixSnapshotStore({ backend: "sqlite", path: process.argv[2] });
try {
 const hash = await store.putPrefixJson({ tools: [{ name: "Read" }] });
 const result = await store.getPrefixJson(hash);
 console.log(JSON.stringify(result));
} finally { await store.close(); }
`,
			);
			await exec(
				process.execPath,
				[
					"build",
					probe,
					join(project, "server/services/narrator-prefix-snapshots-worker.ts"),
					"--compile",
					"--minify",
					"--asset-naming=[dir]/[name].[ext]",
					"--outfile",
					binary,
				],
				{ cwd: project, timeout: 60000, maxBuffer: 1024 * 1024 },
			);
			await rm(probe, { force: true });
			const result = await exec(binary, [path], {
				cwd: directory,
				env: { ...process.env, NARRAFORK_HOME: directory },
				timeout: 30000,
				maxBuffer: 1024 * 1024,
			});
			expect(JSON.parse(result.stdout.trim())).toEqual({ tools: [{ name: "Read" }] });
		} finally {
			await rm(probe, { force: true });
			await rm(directory, { recursive: true, force: true });
		}
	},
	120000,
);

test.skipIf(process.env.PG_INTEGRATION !== "1")(
	"PostgreSQL isolated worker roundtrip",
	async () => {
		const outcome = await withPostgres(async ({ exec, port, credentials }) => {
			const result = await exec(schema);
			if (result.code !== 0) throw new Error("Prefix snapshot test schema setup failed");
			const store = createPrefixSnapshotStore({
				backend: "postgres",
				url: `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${port}/nf_harness`,
			});
			try {
				await roundtrip(store);
				return { verified: true };
			} finally {
				await store.close();
			}
		});
		if ("status" in outcome) throw new Error(`PostgreSQL harness unavailable: ${outcome.status}`);
		expect(outcome.verified).toBe(true);
	},
	120000,
);
