import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { db as appDb, sqlite as template } from "../db";
import * as relations from "../db/relations";
import * as schema from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { generateId } from "../lib/id";
import { getNarraforkPath } from "../lib/narrafork-home";
import * as spawn from "../lib/spawn";
import * as localIo from "./file-change-local-io";
import { LocalFileChangeRuntime } from "./file-change-runtime";
import {
	recordTreeSnapshotAfter,
	recordTreeSnapshotBefore,
	type TreeSnapshotSession,
} from "./narrator-tree-snapshot-hooks";
import {
	SnapshotCaptureReceiptService,
	withSnapshotCaptureReceipts,
} from "./snapshot-capture-receipts";
import { createWorkspaceWriteCoordinatorState } from "./workspace-write-coordinator";
import { treeSnapshotKey, worktreeTreeSnapshot } from "./worktree-tree-snapshot";

let root: string;
let workspace: string;
let privateRoot: string;
let sqlite: Database;
let db: ReturnType<typeof database>;
let runtime: LocalFileChangeRuntime;
let receipts: SnapshotCaptureReceiptService;
let narratorId: string;
let userId: string;
const cleanupSpies: { mockRestore(): void }[] = [];
const crashChild = process.env.NARRAFORK_CAPTURE_CRASH_CHILD === "1";

function database(client: Database) {
	return drizzle({ client, schema: { ...schema, ...relations } });
}

beforeEach(async () => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	if (crashChild) return;
	root = await mkdtemp(join(await realpath(tmpdir()), "nf-capture-receipt-"));
	workspace = join(root, "workspace");
	privateRoot = join(root, "private");
	await mkdir(workspace);
	const initialized = await spawn.safeSpawn({
		cmd: ["git", "init"],
		cwd: workspace,
		timeout: 5000,
	});
	expect(initialized.exitCode).toBe(0);
	sqlite = new Database(join(root, "evidence.db"));
	sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;");
	// Copy schema only from bunfig/preload's isolated template, never migrate a live DB.
	const definitions = template
		.query<{ sql: string }, []>(
			"SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '*_fts*' ORDER BY type DESC LIMIT 2048",
		)
		.all();
	expect(definitions.length).toBeLessThan(2048);
	sqlite.transaction(() => {
		for (const definition of definitions) sqlite.exec(definition.sql);
	})();
	db = database(sqlite);
	narratorId = generateId();
	userId = generateId();
	const now = new Date().toISOString();
	db.insert(schema.narrators).values({ id: narratorId, createdAt: now, updatedAt: now }).run();
	db.insert(schema.users)
		.values({ id: userId, username: userId, passwordHash: "test", createdAt: now })
		.run();
	runtime = new LocalFileChangeRuntime({
		db,
		privateRoot,
		coordinatorState: createWorkspaceWriteCoordinatorState(),
		blobStoreOptions: { minimumFreeBytes: 0 },
	});
	receipts = new SnapshotCaptureReceiptService({ db, privateRoot });
	// Real runtime IO establishes the source and exact local root incarnation.
	// No hand-built scope/hash/receipt fixtures stand in for the scan lifecycle.
	await editorWrite("seed\n");
});

afterEach(async () => {
	if (crashChild) return;
	for (const spy of cleanupSpies.splice(0)) spy.mockRestore();
	await worktreeTreeSnapshot.destroy(workspace);
	appDb
		.delete(schema.narratorToolCalls)
		.where(eq(schema.narratorToolCalls.narratorId, narratorId))
		.run();
	appDb
		.delete(schema.narratorMessages)
		.where(eq(schema.narratorMessages.narratorId, narratorId))
		.run();
	appDb.delete(schema.narrators).where(eq(schema.narrators.id, narratorId)).run();
	sqlite.close();
	await rm(root, { recursive: true, force: true });
});

function editorWrite(text: string) {
	const path = join(workspace, "a.txt");
	return runtime.executeEditor({
		requestId: generateId(),
		userId,
		narratorId,
		cwd: workspace,
		lexicalPath: path,
		canonicalPath: path,
		signal: new AbortController().signal,
		input: { text },
		authorize: async () => {},
		construct: () => ({ nextBytes: Buffer.from(text), result: true, lineStats: null }),
	});
}

function capture(opts?: { signal?: AbortSignal; gitTimeoutMs?: number }) {
	return withSnapshotCaptureReceipts(receipts, () =>
		worktreeTreeSnapshot.capture(workspace, LOCAL_DEVICE_ID, opts),
	);
}

function rows() {
	return db
		.select()
		.from(schema.snapshotCaptures)
		.orderBy(schema.snapshotCaptures.startedAt, schema.snapshotCaptures.id)
		.limit(20)
		.all();
}

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Gate just the actual Git invocation. The scan, identity and SQLite remain real. */
function gateAdd() {
	const entered = gate();
	const release = gate();
	const real = spawn.safeSpawn;
	let gated = false;
	cleanupSpies.push(
		spyOn(spawn, "safeSpawn").mockImplementation(async (options) => {
			if (
				!gated &&
				options.cmd[0] === "git" &&
				options.cmd.includes("add") &&
				options.cmd.includes("-A")
			) {
				gated = true;
				entered.resolve();
				await release.promise;
			}
			return real(options);
		}),
	);
	return { entered, release };
}

function finishNotification() {
	const finished = gate();
	const original = receipts.finish.bind(receipts);
	cleanupSpies.push(
		spyOn(receipts, "finish").mockImplementation(async (...args) => {
			await original(...args);
			finished.resolve();
		}),
	);
	return finished.promise;
}

// Run in a separate bun test process so the normal test preload owns all HOME/DB
// isolation. Exit after real git add, before write-tree/finally: no synthetic row.
if (crashChild) {
	test("__capture_receipt_crash_child", async () => {
		const childDb = new Database(process.env.NARRAFORK_CAPTURE_CRASH_DB as string);
		childDb.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;");
		const service = new SnapshotCaptureReceiptService({
			db: database(childDb),
			privateRoot: process.env.NARRAFORK_CAPTURE_CRASH_PRIVATE_ROOT as string,
		});
		const real = spawn.safeSpawn;
		spyOn(spawn, "safeSpawn").mockImplementation((options) => {
			if (options.cmd.includes("write-tree")) process.exit(86);
			return real(options);
		});
		await withSnapshotCaptureReceipts(service, () =>
			worktreeTreeSnapshot.capture(process.env.NARRAFORK_CAPTURE_CRASH_WORKSPACE as string),
		);
		throw new Error("Crash injection never reached actual scan");
	});
}

describe("actual tree-scan observation receipts", () => {
	test("identical trees get distinct receipts without inventing coverage/policy/ownership", async () => {
		const first = await capture();
		expect(await capture()).toBe(first);
		const captured = rows();
		expect(captured).toHaveLength(2);
		expect(captured[0].id).not.toBe(captured[1].id);
		for (const row of captured) {
			expect(row.treeHash).toBe(first);
			expect(row.finishedAt).not.toBeNull();
			expect(row.coverage).toBe("partial");
			expect(row.temporalConsistency).toBe("unknown");
			expect(row.reason).toBe("capture_incomplete");
			expect(row.policyVersion).toBe(0);
			expect(row.ignorePolicyDigest).toBeNull();
			expect(row.manifestBlobDigest).toBeNull();
			expect(row.omittedCount).toBeNull();
			expect(row.operationId).toBeNull();
			expect(row.snapshotCommitSha).toBeNull();
		}
		const legacy = appDb
			.select()
			.from(schema.worktreeTreeSnapshots)
			.where(eq(schema.worktreeTreeSnapshots.worktreePath, workspace))
			.limit(5)
			.all();
		expect(legacy).toHaveLength(1);
	});

	test("failed real Git scan is unavailable; matching later success cannot upgrade it", async () => {
		const first = await capture();
		const shadow = getNarraforkPath(
			"tree-snapshots",
			createHash("sha256")
				.update(treeSnapshotKey(LOCAL_DEVICE_ID, workspace))
				.digest("hex")
				.slice(0, 32),
		);
		await writeFile(join(shadow, "index.lock"), "live lock");
		await expect(capture()).rejects.toThrow("snapshot add failed");
		const failed = rows().find((row) => row.coverage === "unavailable");
		expect(failed?.treeHash).toBeNull();
		expect(failed?.reason).toBe("capture_failed");
		expect(failed?.finishedAt).not.toBeNull();
		await rm(join(shadow, "index.lock"));
		expect(await capture()).toBe(first);
		expect(rows().find((row) => row.id === failed?.id)).toEqual(failed);
	});

	test("ignore rules changing during a scan remain unmeasured policy, never complete coverage", async () => {
		const delayed = gateAdd();
		const pending = capture();
		await delayed.entered.promise;
		await writeFile(join(workspace, ".gitignore"), "unmeasured.txt\n");
		await writeFile(join(workspace, "unmeasured.txt"), "outside declared Git policy\n");
		delayed.release.resolve();
		await pending;
		expect(rows()[0]).toMatchObject({
			coverage: "partial",
			temporalConsistency: "unknown",
			policyVersion: 0,
			ignorePolicyDigest: null,
			manifestBlobDigest: null,
			omittedCount: null,
			reason: "capture_incomplete",
		});
	});

	test("cancelled in-flight scan records cancelled, never a complete boundary", async () => {
		const delayed = gateAdd();
		const controller = new AbortController();
		const pending = capture({ signal: controller.signal }).catch((error) => error);
		await delayed.entered.promise;
		expect(rows()[0]).toMatchObject({
			coverage: "unavailable",
			finishedAt: null,
			reason: "result_unknown",
		});
		controller.abort();
		delayed.release.resolve();
		expect(await pending).toBeInstanceOf(Error);
		expect(rows()[0]).toMatchObject({
			coverage: "unavailable",
			treeHash: null,
			reason: "cancelled",
		});
		expect(rows()[0].finishedAt).not.toBeNull();
	});

	test("real subprocess timeout keeps its unavailable receipt", async () => {
		await capture();
		const real = spawn.safeSpawn;
		let replaced = false;
		cleanupSpies.push(
			spyOn(spawn, "safeSpawn").mockImplementation((options) => {
				if (!replaced && options.cmd.includes("add") && options.cmd.includes("-A")) {
					replaced = true;
					// Exercise safeSpawn's real timeout/termination path, not a fabricated exit result.
					return real({
						...options,
						cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
						timeout: 20,
					});
				}
				return real(options);
			}),
		);
		await expect(capture({ gitTimeoutMs: 20 })).rejects.toThrow();
		const failed = rows().find((row) => row.coverage === "unavailable");
		expect(failed?.reason).toBe("budget_exceeded");
		expect(failed?.treeHash).toBeNull();
	});

	test("late warm completion persists only its own observation, not a tool before boundary", async () => {
		const delayed = gateAdd();
		const finished = finishNotification();
		const realHot = worktreeTreeSnapshot.tryCaptureHot.bind(worktreeTreeSnapshot);
		cleanupSpies.push(
			spyOn(worktreeTreeSnapshot, "tryCaptureHot").mockImplementation((path, device, options) =>
				realHot(path, device, { ...options, budgetMs: 20 }),
			),
		);
		const session: TreeSnapshotSession = { cwd: workspace };
		const toolUseId = generateId();
		const messageId = generateId();
		const toolId = generateId();
		const now = new Date().toISOString();
		appDb.insert(schema.narrators).values({ id: narratorId, createdAt: now, updatedAt: now }).run();
		appDb
			.insert(schema.narratorMessages)
			.values({
				id: messageId,
				narratorId,
				role: "assistant",
				contentJson: [],
				createdAt: now,
			})
			.run();
		appDb
			.insert(schema.narratorToolCalls)
			.values({
				id: toolId,
				narratorId,
				messageId,
				toolUseId,
				toolName: "Write",
				inputJson: {},
				status: "success",
				createdAt: now,
			})
			.run();
		const before = withSnapshotCaptureReceipts(receipts, () =>
			recordTreeSnapshotBefore(session, narratorId, toolUseId),
		);
		await delayed.entered.promise;
		await before;
		expect(session._treeHashBefore?.get(toolUseId)).toBeUndefined();
		expect(session._lastTreeHash).toBeUndefined();
		await editorWrite("tool wrote after missing before\n");
		const after = await withSnapshotCaptureReceipts(receipts, () =>
			recordTreeSnapshotAfter(session, narratorId, toolUseId),
		);
		expect(after).toMatchObject({ before: null, after: null });
		const toolBoundary = appDb
			.select()
			.from(schema.narratorToolCalls)
			.where(eq(schema.narratorToolCalls.id, toolId))
			.get();
		const messageBoundary = appDb
			.select()
			.from(schema.narratorMessages)
			.where(eq(schema.narratorMessages.id, messageId))
			.get();
		expect(toolBoundary?.treeHashBefore).toBeNull();
		expect(toolBoundary?.treeHashAfter).toBeNull();
		expect(messageBoundary?.treeHashAfter).toBeNull();
		delayed.release.resolve();
		await finished;
		expect(rows()).toHaveLength(1);
		expect(rows()[0].coverage).toBe("partial");
		expect(
			appDb
				.select()
				.from(schema.narratorToolCalls)
				.where(eq(schema.narratorToolCalls.id, toolId))
				.get(),
		).toEqual(toolBoundary);
		expect(
			appDb
				.select()
				.from(schema.narratorMessages)
				.where(eq(schema.narratorMessages.id, messageId))
				.get(),
		).toEqual(messageBoundary);
		expect(session._treeHashBefore?.get(toolUseId)).toBeUndefined();
		expect(session._lastTreeHash).toBeUndefined();
	});

	test("warm failure retains its receipt and cooldown does not manufacture another scan", async () => {
		await capture();
		const delayed = gateAdd();
		const finished = finishNotification();
		const hot = withSnapshotCaptureReceipts(receipts, () =>
			worktreeTreeSnapshot.tryCaptureHot(workspace, LOCAL_DEVICE_ID, {
				budgetMs: 20,
				cooldownMs: 60_000,
			}),
		);
		await delayed.entered.promise;
		expect(await hot).toBeNull();
		const shadow = getNarraforkPath(
			"tree-snapshots",
			createHash("sha256")
				.update(treeSnapshotKey(LOCAL_DEVICE_ID, workspace))
				.digest("hex")
				.slice(0, 32),
		);
		await writeFile(join(shadow, "index.lock"), "live lock");
		delayed.release.resolve();
		await finished;
		// Allow the existing capture promise to settle its cooldown before the next call.
		await new Promise<void>((done) => setImmediate(done));
		expect(
			await withSnapshotCaptureReceipts(receipts, () =>
				worktreeTreeSnapshot.tryCaptureHot(workspace),
			),
		).toBeNull();
		expect(rows()).toHaveLength(2);
		expect(rows().filter((row) => row.coverage === "unavailable")).toHaveLength(1);
	});

	test("recreated workspace cannot inherit the old scope; real runtime rebinds a new incarnation", async () => {
		await capture();
		const oldScope = rows()[0].scopeId;
		await rename(workspace, join(root, "previous"));
		await mkdir(workspace);
		await spawn.safeSpawn({ cmd: ["git", "init"], cwd: workspace, timeout: 5000 });
		await writeFile(join(workspace, "a.txt"), "new incarnation\n");
		await capture();
		expect(rows()).toHaveLength(1);
		await editorWrite("new verified incarnation\n");
		await capture();
		expect(rows()).toHaveLength(2);
		expect(rows()[1].scopeId).not.toBe(oldScope);
	});

	test("root replaced mid-scan invalidates only that receipt", async () => {
		const delayed = gateAdd();
		const pending = capture();
		await delayed.entered.promise;
		await rename(workspace, join(root, "previous"));
		await mkdir(workspace);
		await spawn.safeSpawn({ cmd: ["git", "init"], cwd: workspace, timeout: 5000 });
		await writeFile(join(workspace, "a.txt"), "replacement\n");
		delayed.release.resolve();
		await pending;
		expect(rows()[0]).toMatchObject({
			coverage: "unavailable",
			reason: "target_unverified",
			treeHash: null,
		});
	});

	test("remote and foreign-source paths cannot attach a local observation", async () => {
		const scope = db.select().from(schema.fileChangeScopes).limit(1).get();
		expect(scope).toBeDefined();
		if (!scope) throw new Error("Missing real scope");
		db.update(schema.fileChangeScopes)
			.set({ deviceId: "remote-device" })
			.where(eq(schema.fileChangeScopes.id, scope.id))
			.run();
		await capture();
		expect(rows()).toHaveLength(0);
		expect(await worktreeTreeSnapshot.tryCapture(workspace, "remote-device")).toBeNull();
		db.update(schema.fileChangeScopes)
			.set({ deviceId: LOCAL_DEVICE_ID, sourceInstanceId: "imported-source" })
			.where(eq(schema.fileChangeScopes.id, scope.id))
			.run();
		await capture();
		expect(rows()).toHaveLength(0);
	});

	test("missing source never gets created by capture; old tree records are not upgraded", async () => {
		const source = join(privateRoot, "file-change-source.json");
		await rename(source, `${source}.saved`);
		const hash = await capture();
		expect(rows()).toHaveLength(0);
		await expect(readFile(source)).rejects.toThrow();
		const legacy = appDb
			.select()
			.from(schema.worktreeTreeSnapshots)
			.where(eq(schema.worktreeTreeSnapshots.worktreePath, workspace))
			.limit(1)
			.get();
		await rename(`${source}.saved`, source);
		expect(await capture()).toBe(hash);
		expect(rows()).toHaveLength(1);
		expect(
			appDb
				.select()
				.from(schema.worktreeTreeSnapshots)
				.where(eq(schema.worktreeTreeSnapshots.id, legacy?.id ?? "missing"))
				.get(),
		).toEqual(legacy);
	});

	test("unsafe SQLite busy timeout is rejected before a contended receipt write", async () => {
		const blocker = new Database(join(root, "evidence.db"));
		blocker.exec("BEGIN IMMEDIATE;");
		sqlite.exec("PRAGMA busy_timeout = 5000;");
		try {
			const started = performance.now();
			expect(await capture()).toMatch(/^[a-f0-9]{40}$/);
			expect(performance.now() - started).toBeLessThan(1500);
			expect(rows()).toHaveLength(0);
		} finally {
			blocker.exec("ROLLBACK;");
			blocker.close();
			sqlite.exec("PRAGMA busy_timeout = 0;");
		}
		await capture();
		expect(rows()).toHaveLength(1);
	});

	test("connection drift during a real scan leaves its receipt unavailable", async () => {
		const delayed = gateAdd();
		const pending = capture();
		await delayed.entered.promise;
		sqlite.exec("PRAGMA busy_timeout = 5000;");
		delayed.release.resolve();
		try {
			expect(await pending).toMatch(/^[a-f0-9]{40}$/);
			expect(rows()[0]).toMatchObject({
				finishedAt: null,
				treeHash: null,
				coverage: "unavailable",
			});
		} finally {
			sqlite.exec("PRAGMA busy_timeout = 0;");
		}
	});

	test("disabled foreign keys and ambient transactions cannot publish capture receipts", async () => {
		sqlite.exec("PRAGMA foreign_keys = OFF;");
		try {
			expect(await receipts.begin(workspace, LOCAL_DEVICE_ID)).toBeNull();
		} finally {
			sqlite.exec("PRAGMA foreign_keys = ON;");
		}
		sqlite.exec("BEGIN;");
		try {
			expect(await receipts.begin(workspace, LOCAL_DEVICE_ID)).toBeNull();
		} finally {
			sqlite.exec("ROLLBACK;");
		}
		expect(rows()).toHaveLength(0);
		await capture();
		expect(rows()).toHaveLength(1);
	});

	test("receipt INSERT/UPDATE faults never block writes or upgrade unfinished rows by hash", async () => {
		sqlite.exec(
			"CREATE TRIGGER deny_receipt_insert BEFORE INSERT ON snapshot_captures BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END;",
		);
		await capture();
		await editorWrite("write still works\n");
		expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("write still works\n");
		expect(rows()).toHaveLength(0);
		sqlite.exec(
			"DROP TRIGGER deny_receipt_insert; CREATE TRIGGER deny_receipt_update BEFORE UPDATE ON snapshot_captures BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END;",
		);
		const hash = await capture();
		const pending = rows()[0];
		expect(pending).toMatchObject({
			finishedAt: null,
			treeHash: null,
			coverage: "unavailable",
			temporalConsistency: "unknown",
			reason: "result_unknown",
		});
		sqlite.exec("DROP TRIGGER deny_receipt_update;");
		// A new service has no in-memory attempt. Restart-like recovery must not
		// relabel old pending evidence merely because the next scan has the same hash.
		receipts = new SnapshotCaptureReceiptService({ db, privateRoot });
		expect(await capture()).toBe(hash);
		expect(rows().find((row) => row.id === pending.id)).toEqual(pending);
		expect(rows()).toHaveLength(2);
	});

	test("abrupt process exit during a real scan leaves durable unavailable/unknown evidence", async () => {
		const child = await spawn.safeSpawn({
			cmd: [
				process.execPath,
				"test",
				import.meta.path,
				"--test-name-pattern",
				"^__capture_receipt_crash_child$",
			],
			cwd: process.cwd(),
			timeout: 10_000,
			maxOutputBytes: 64 * 1024,
			env: {
				...process.env,
				NARRAFORK_ALLOW_MULTIPLE: "1",
				NARRAFORK_HOME: join(root, "child-data"),
				TMPDIR: root,
				NARRAFORK_CAPTURE_CRASH_CHILD: "1",
				NARRAFORK_CAPTURE_CRASH_DB: join(root, "evidence.db"),
				NARRAFORK_CAPTURE_CRASH_PRIVATE_ROOT: privateRoot,
				NARRAFORK_CAPTURE_CRASH_WORKSPACE: workspace,
			},
		});
		if (child.exitCode !== 86) throw new Error(`Crash child did not reach scan: ${child.stderr}`);
		expect(child.exitCode).toBe(86);
		const pending = rows()[0];
		expect(rows()).toHaveLength(1);
		expect(pending).toMatchObject({
			finishedAt: null,
			treeHash: null,
			coverage: "unavailable",
			temporalConsistency: "unknown",
			reason: "result_unknown",
		});
		receipts = new SnapshotCaptureReceiptService({ db, privateRoot });
		const hash = await capture();
		expect(rows()).toHaveLength(2);
		expect(rows().find((row) => row.id === pending.id)).toEqual(pending);
		expect(rows().find((row) => row.id !== pending.id)?.treeHash).toBe(hash);
	}, 15_000);

	test("bounded begin metadata cannot insert a late receipt after the scan has returned", async () => {
		const delayed = gate();
		const original = localIo.localDirectoryIdentity;
		const identitySpy = spyOn(localIo, "localDirectoryIdentity").mockImplementation(
			async (path) => {
				await delayed.promise;
				return original(path);
			},
		);
		cleanupSpies.push(identitySpy);
		receipts = new SnapshotCaptureReceiptService({ db, privateRoot, metadataBudgetMs: 15 });
		const started = performance.now();
		expect(await capture()).toMatch(/^[a-f0-9]{40}$/);
		expect(performance.now() - started).toBeLessThan(1500);
		expect(rows()).toHaveLength(0);
		identitySpy.mockRestore();
		delayed.resolve();
		await new Promise<void>((done) => setImmediate(done));
		expect(rows()).toHaveLength(0);
		await capture();
		expect(rows()).toHaveLength(1);
	});

	test("bounded finish metadata stays pending after timeout, even once the delayed read completes", async () => {
		const delayed = gate();
		const original = localIo.localDirectoryIdentity;
		let calls = 0;
		const identitySpy = spyOn(localIo, "localDirectoryIdentity").mockImplementation(
			async (path) => {
				if (++calls === 2) await delayed.promise;
				return original(path);
			},
		);
		cleanupSpies.push(identitySpy);
		receipts = new SnapshotCaptureReceiptService({ db, privateRoot, metadataBudgetMs: 15 });
		const hash = await capture();
		const pending = rows()[0];
		expect(pending).toMatchObject({
			finishedAt: null,
			treeHash: null,
			coverage: "unavailable",
			reason: "result_unknown",
		});
		identitySpy.mockRestore();
		delayed.resolve();
		await new Promise<void>((done) => setImmediate(done));
		expect(await capture()).toBe(hash);
		expect(rows().find((row) => row.id === pending.id)).toEqual(pending);
	});

	test("actual SQLite writer contention has a short bounded wait and no fake receipt", async () => {
		await capture(); // Warm Git before measuring only metadata lock contention.
		sqlite.exec("PRAGMA busy_timeout = 250;");
		const competing = new Database(join(root, "evidence.db"));
		try {
			competing.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
			const started = performance.now();
			await capture();
			expect(performance.now() - started).toBeLessThan(1500);
			expect(rows()).toHaveLength(1);
		} finally {
			competing.exec("ROLLBACK;");
			competing.close();
		}
		await editorWrite("writer still usable after receipt lock contention\n");
		expect(await readFile(join(workspace, "a.txt"), "utf8")).toContain("writer still usable");
	});

	test("structural preemption terminates its warm receipt and starts an independent scan", async () => {
		const delayed = gateAdd();
		const hot = withSnapshotCaptureReceipts(receipts, () =>
			worktreeTreeSnapshot.tryCaptureHot(workspace, LOCAL_DEVICE_ID, {
				budgetMs: 20,
				cooldownMs: 60_000,
			}),
		);
		await delayed.entered.promise;
		expect(await hot).toBeNull();
		const structural = capture();
		delayed.release.resolve();
		await structural;
		expect(rows()).toHaveLength(2);
		expect(rows().filter((row) => row.reason === "cancelled")).toHaveLength(1);
		expect(rows().filter((row) => row.coverage === "partial")).toHaveLength(1);
		expect(
			await withSnapshotCaptureReceipts(receipts, () =>
				worktreeTreeSnapshot.tryCaptureHot(workspace),
			),
		).not.toBeNull();
		expect(rows()).toHaveLength(3);
	});

	test("scope lookup uses the exact incarnation index with a fixed row/metadata projection", () => {
		const plan = sqlite
			.query<{ detail: string }, [string, string, string]>(
				"EXPLAIN QUERY PLAN SELECT substr(id,1,257),substr(canonical_root,1,8193),substr(root_identity_json,1,1025),status,path_flavor FROM file_change_scopes WHERE source_instance_id=? AND device_id=? AND workspace_instance_id=? LIMIT 1",
			)
			.all("source", "local", "instance");
		expect(plan.some((row) => row.detail.includes("idx_fc_scope_instance"))).toBe(true);
		expect(plan.some((row) => row.detail.includes("SCAN"))).toBe(false);
	});

	test.skipIf(process.platform === "win32")(
		"symlink cwd resolves the actual root, while a symlink source is rejected",
		async () => {
			const alias = join(root, "alias");
			await symlink(workspace, alias);
			const hash = await withSnapshotCaptureReceipts(receipts, () =>
				worktreeTreeSnapshot.capture(alias),
			);
			expect(rows()[0].treeHash).toBe(hash);
			await worktreeTreeSnapshot.destroy(alias);
			const source = join(privateRoot, "file-change-source.json");
			await rename(source, `${source}.saved`);
			await symlink(`${source}.saved`, source);
			await capture();
			expect(rows()).toHaveLength(1);
		},
	);
});
