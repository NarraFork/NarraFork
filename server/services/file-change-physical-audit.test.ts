import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, renameSync, symlinkSync, utimesSync } from "node:fs";
import {
	chmod,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { FileChangeBlobRef } from "@shared/file-change-protocol";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getTestDb } from "../../tests/setup";
import { FileChangeBlobCatalog } from "./file-change-blob-catalog";
import { FileChangeBlobStore } from "./file-change-blob-store";
import {
	auditFileChangePhysical,
	type FileChangeAuditIdentity,
	type FileChangePhysicalAuditOptions,
	type FileChangePhysicalAuditSummary,
	FILE_CHANGE_PHYSICAL_AUDIT_LIMITS as LIMITS,
} from "./file-change-physical-audit";

// Migration-built bytes are copied to a NEW private file for every test. No application
// DB singleton, production paths, migration generator, HTTP or runtime wiring is imported.
let template: Uint8Array;
let sandbox: string;
let databasePath: string;
let blobRoot: string;
let sqlite: Database;
let catalog: FileChangeBlobCatalog;
let store: FileChangeBlobStore;
const namespaceKey = "isolated-audit-namespace";
const generation = 1;
const timers = new Set<ReturnType<typeof setInterval>>();
const verification = {
	namespaceIdentityVerified: true,
	writersQuiescent: true,
	physicalInventoryComplete: true,
	catalogMatchesInventory: true,
} as const;

beforeAll(() => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	const migrated = getTestDb();
	template = migrated.sqlite.serialize();
	migrated.sqlite.close();
});
beforeEach(async () => {
	// The worker pins every absolute ancestor. Parallel suites legitimately mutate
	// shared /tmp, so valid-state fixtures need a parent owned by this checkout.
	// This preserves the production object_changed guard instead of retrying it.
	sandbox = await mkdtemp(join(await realpath(process.cwd()), ".physical-audit-test-"));
	databasePath = join(sandbox, "source.sqlite");
	blobRoot = join(sandbox, "blobs");
	await writeFile(databasePath, template, { mode: 0o600 });
	await mkdir(blobRoot, { mode: 0o700 });
	sqlite = new Database(databasePath);
	sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;");
	catalog = new FileChangeBlobCatalog({ db: drizzle(sqlite), namespaceKey });
	catalog.initializeNamespace({ expectedGeneration: null });
	catalog.beginReconciliation({ expectedGeneration: 0 });
	// Empty, privately owned test namespace: fixture setup only, never an audit outcome.
	catalog.completeReconciliation({
		expectedGeneration: generation,
		verifiedUsedBytes: 0,
		verification,
	});
	store = new FileChangeBlobStore({
		root: blobRoot,
		minimumFreeBytes: 0,
		admission: catalog.admission({ expectedGeneration: generation, ownerEpoch: "test-writer" }),
	});
});
afterEach(async () => {
	for (const timer of timers) clearInterval(timer);
	timers.clear();
	sqlite.close();
	await rm(sandbox, { recursive: true, force: true });
});
afterAll(() => {
	template = new Uint8Array();
});

async function identity(path: string): Promise<FileChangeAuditIdentity> {
	const info = await lstat(path, { bigint: true });
	return {
		dev: String(info.dev),
		ino: String(info.ino),
		birthtimeNs: String(info.birthtimeNs),
		ctimeNs: String(info.ctimeNs),
		mtimeNs: String(info.mtimeNs),
		sizeBytes: String(info.size),
		nlink: String(info.nlink),
		mode: Number(info.mode),
		uid: Number(info.uid),
	};
}
async function options(
	overrides: Partial<FileChangePhysicalAuditOptions> = {},
): Promise<FileChangePhysicalAuditOptions> {
	return {
		maintenanceCaller: { kind: "maintenance", subjectKey: "test-audit" },
		databasePath,
		blobRoot,
		namespaceKey,
		expectedGeneration: generation,
		expectedNamespaceStatus: "ready",
		sourceIdentity: await identity(databasePath),
		rootIdentity: await identity(blobRoot),
		...overrides,
	};
}
async function put(bytes: Uint8Array | string): Promise<FileChangeBlobRef> {
	const value = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
	return store.putBytes(value, { expectedSize: value.byteLength });
}
function pathFor(ref: FileChangeBlobRef): string {
	return join(blobRoot, "sha256", ref.digest.slice(0, 2), ref.digest);
}
function codes(summary: FileChangePhysicalAuditSummary): string[] {
	return [...summary.issues, ...summary.samples.map((sample) => sample.code)];
}
function insertMissing(count: number): void {
	const statement = sqlite.query(`INSERT INTO file_change_blobs
	 (id,digest,size_bytes,storage_key,status,gc_generation,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)`);
	sqlite.transaction(() => {
		for (let n = 0; n < count; n++) {
			const digest = n.toString(16).padStart(64, "0");
			statement.run(
				`fixture-${n}`,
				digest,
				1,
				`sha256/${digest.slice(0, 2)}/${digest}`,
				["ready", "staging", "missing", "expired"][n % 4],
				"2026-09-07T00:00:00.000Z",
				"2026-09-07T00:00:00.000Z",
			);
		}
	})();
}
function assertAuthority(summary: FileChangePhysicalAuditSummary): void {
	expect(summary).toMatchObject({
		readOnly: true,
		noDeletionAuthority: true,
		referenceCompleteness: "not_checked",
		observation: "concurrent_or_unknown",
		writersQuiescent: false,
		candidate: false,
		retention: "unknown",
		countsLowerBound: true,
	});
	const json = JSON.stringify(summary);
	expect(Buffer.byteLength(json)).toBeLessThanOrEqual(LIMITS.summaryBytes);
	expect(json).not.toContain(sandbox);
	expect(json).not.toContain("test-writer");
	expect(summary.metrics.responseBytes).toBe(Buffer.byteLength(json));
}

describe("physical audit: actual migrated file DB and BlobStore/Catalog", () => {
	test("UTF-8, GBK, CRLF and binary bytes are hashed in a worker; no DB/body mutations", async () => {
		const contents = [
			Buffer.from("UTF8 中文\r\nkeep\r\n"),
			Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0d, 0x0a]),
			Buffer.from([0, 255, 128, 13, 10, 3]),
			Buffer.alloc(0),
		];
		const refs = [];
		for (const bytes of contents) refs.push(await put(bytes));
		const originalDb = await readFile(databasePath);
		const request = await options();
		const summary = await auditFileChangePhysical(request);
		expect(summary).toMatchObject({
			status: "observed",
			full: true,
			catalogComplete: true,
			physicalComplete: true,
			reservationsComplete: true,
			issues: [],
			samples: [],
			metrics: {
				catalogRows: 4,
				physicalObjects: 4,
				verifiedObjects: 4,
				mismatches: 0,
				readBytes: contents.reduce((sum, bytes) => sum + bytes.byteLength, 0),
			},
		});
		expect(summary.start).toEqual(summary.end);
		expect(await readFile(databasePath)).toEqual(originalDb);
		for (let n = 0; n < refs.length; n++)
			expect(await readFile(pathFor(refs[n]))).toEqual(contents[n]);
		assertAuthority(summary);
	});

	test("catalog-only, same-size corruption, physical-only and staging/temp bytes stay preserved", async () => {
		const missing = await put("missing-body");
		const corrupt = await put("correct-body");
		const staging = await put("staging-body");
		await unlink(pathFor(missing));
		await writeFile(pathFor(corrupt), "corrupt-body"); // identical byte count
		sqlite
			.query("UPDATE file_change_blobs SET status = 'staging' WHERE digest = ?")
			.run(staging.digest);
		const orphanStore = new FileChangeBlobStore({ root: blobRoot, minimumFreeBytes: 0 });
		const orphan = await orphanStore.putBytes(Buffer.from("physical-only"), { expectedSize: 13 });
		const temp = join(blobRoot, ".tmp", `${randomUUID()}.tmp`);
		await writeFile(temp, Buffer.from("do-not-hash-temp-contents"), { mode: 0o600 });
		const beforeDb = await readFile(databasePath);
		const summary = await auditFileChangePhysical(await options());
		expect(codes(summary)).toEqual(
			expect.arrayContaining(["catalog_only_missing", "hash_mismatch", "physical_only"]),
		);
		expect(summary.metrics).toMatchObject({
			catalogOnly: 1,
			physicalOnly: 1,
			temporaryObjects: 1,
			temporaryBytes: 25,
			stagingBytes: staging.sizeBytes,
			readBytes: corrupt.sizeBytes + staging.sizeBytes + orphan.sizeBytes,
		});
		expect(await readFile(pathFor(orphan))).toEqual(Buffer.from("physical-only"));
		expect(await readFile(temp)).toEqual(Buffer.from("do-not-hash-temp-contents"));
		expect(await readFile(databasePath)).toEqual(beforeDb);
		expect(JSON.stringify(summary)).not.toContain("do-not-hash-temp-contents");
		assertAuthority(summary);
	});

	test("pending zero-byte and nonzero reservations are observed, never refunded or settled", async () => {
		for (const size of [0, 7])
			catalog.reserve({
				expectedGeneration: generation,
				ownerEpoch: "test-writer",
				expectedSize: size,
				signal: new AbortController().signal,
			});
		const original = await readFile(databasePath);
		const summary = await auditFileChangePhysical(await options());
		expect(summary.start?.pendingReservations).toBe("present");
		expect(summary.metrics).toMatchObject({ pendingReservations: 2, pendingReservationBytes: 7 });
		expect(await readFile(databasePath)).toEqual(original);
		expect(catalog.getBudget()?.reservedBytes).toBe(7);
		assertAuthority(summary);
	});

	test(">=10k rows use <=100 digest-keyset pages; output and main event loop remain bounded", async () => {
		insertMissing(10_050);
		await put("only-small-real-object");
		let ticks = 0;
		const timer = setInterval(() => ticks++, 1);
		timers.add(timer);
		const summary = await auditFileChangePhysical(
			await options({ budget: { summaryBytes: 8192 } }),
		);
		expect(summary.metrics.catalogRows).toBe(10_051);
		expect(summary.metrics.catalogPages).toBe(101);
		expect(summary.metrics.maxCatalogPage).toBeLessThanOrEqual(100);
		expect(summary.metrics.catalogOnly).toBe(10_050);
		expect(summary).toMatchObject({
			catalogComplete: true,
			physicalComplete: true,
			full: false,
			status: "partial",
			samplesTruncated: true,
		});
		expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(8192);
		expect(summary.metrics.queries).toBeLessThan(160);
		expect(ticks).toBeGreaterThan(3);
		const plan = sqlite
			.query<{ detail: string }, [string, number]>(
				`EXPLAIN QUERY PLAN SELECT digest FROM file_change_blobs INDEXED BY idx_fc_blob_digest WHERE digest > ? ORDER BY digest LIMIT ?`,
			)
			.all("0".repeat(64), 100);
		expect(plan.map((row) => row.detail).join(" ")).toContain("SEARCH");
		expect(plan.map((row) => row.detail).join(" ")).not.toContain("TEMP B-TREE");
		assertAuthority(summary);
	});
});

describe("physical audit: fail-closed paths and metadata", () => {
	test.each([
		"../escape",
		"/private/body",
		"sha256/../wrong",
		"sha256\\aa\\wrong",
	])("rejects catalog storageKey injection %s", async (injection) => {
		const ref = await put("never-follow-injection");
		sqlite
			.query("UPDATE file_change_blobs SET storage_key = ? WHERE digest = ?")
			.run(injection, ref.digest);
		const summary = await auditFileChangePhysical(await options());
		expect(summary.full).toBe(false);
		expect(codes(summary)).toContain("invalid_catalog_metadata");
		expect(summary.metrics.readBytes).toBe(0);
		expect(JSON.stringify(summary)).not.toContain(injection);
	});
	test.each([
		"../escape",
		`${"a".repeat(64)}\n`,
		"z".repeat(64),
		"",
	])("rejects invalid digest without treating it as a path (%s)", async (digest) => {
		insertMissing(1);
		sqlite.query("UPDATE file_change_blobs SET digest = ?").run(digest);
		const summary = await auditFileChangePhysical(await options());
		expect(summary.full).toBe(false);
		expect(codes(summary)).toContain("invalid_catalog_digest");
		expect(summary.metrics.readBytes).toBe(0);
	});

	test.each([
		"root",
		"ancestor",
		"shard",
		"object",
		"temporary",
		"source",
	])("never follows a symlink at %s", async (where) => {
		const ref = await put("protected-source-body");
		const secret = join(sandbox, "outside-secret");
		await writeFile(secret, "outside-raw-secret", { mode: 0o600 });
		const target =
			where === "root"
				? blobRoot
				: where === "ancestor"
					? sandbox
					: where === "shard"
						? join(blobRoot, "sha256", ref.digest.slice(0, 2))
						: where === "object"
							? pathFor(ref)
							: where === "source"
								? databasePath
								: join(blobRoot, ".tmp");
		let request = await options();
		if (where === "ancestor") {
			const alias = join(sandbox, "alias");
			await symlink(blobRoot, alias);
			request = { ...request, blobRoot: join(alias, "nested") };
		} else {
			const moved = `${target}.original`;
			renameSync(target, moved);
			await symlink(where === "object" ? secret : moved, target);
		}
		const summary = await auditFileChangePhysical(request);
		expect(summary.full).toBe(false);
		expect(summary.metrics.readBytes).toBe(0);
		expect(codes(summary).some((code) => /unsafe|identity/.test(code))).toBe(true);
		expect(JSON.stringify(summary)).not.toContain("outside-raw-secret");
		expect(await readFile(secret)).toEqual(Buffer.from("outside-raw-secret"));
	});

	test("FIFO object never blocks or reads; hard links and non-private modes are unknown", async () => {
		const ref = await put("fifo-target");
		await unlink(pathFor(ref));
		const proc = Bun.spawn(["mkfifo", "-m", "600", pathFor(ref)], {
			stdout: "ignore",
			stderr: "pipe",
		});
		expect(await proc.exited).toBe(0);
		const started = performance.now();
		const fifo = await auditFileChangePhysical(await options());
		expect(performance.now() - started).toBeLessThan(2000);
		expect(codes(fifo)).toContain("unsafe_object_type");
		expect(fifo.metrics.readBytes).toBe(0);
		await unlink(pathFor(ref));
		await writeFile(pathFor(ref), "fifo-target", { mode: 0o600 });
		await link(pathFor(ref), join(sandbox, "second-link"));
		const hardlink = await auditFileChangePhysical(await options());
		expect(codes(hardlink)).toContain("link_count_unsafe");
		expect(hardlink.metrics.readBytes).toBe(0);
		await unlink(join(sandbox, "second-link"));
		await chmod(pathFor(ref), 0o644);
		const mode = await auditFileChangePhysical(await options());
		expect(codes(mode)).toContain("non_private_mode");
		expect(mode.metrics.readBytes).toBe(0);
	});

	test("unknown root/shard/object/temp directories are not recursively read", async () => {
		const ref = await put("safe");
		await mkdir(join(blobRoot, "alien-namespace"), { mode: 0o700 });
		await writeFile(join(blobRoot, "alien-namespace", "secret"), "not-a-blob");
		await mkdir(join(blobRoot, "sha256", "unknown"), { mode: 0o700 });
		await mkdir(join(blobRoot, "sha256", ref.digest.slice(0, 2), "nested"), { mode: 0o700 });
		await mkdir(join(blobRoot, ".tmp", "unknown-dir"), { mode: 0o700 });
		await writeFile(join(blobRoot, ".tmp", "unknown-file"), "tmp-raw-secret", { mode: 0o600 });
		const summary = await auditFileChangePhysical(await options());
		expect(summary.full).toBe(false);
		expect(codes(summary)).toEqual(
			expect.arrayContaining([
				"unknown_root_entry",
				"unknown_shard_name",
				"unknown_object_name",
				"unknown_temporary_name",
				"unsafe_object_type",
			]),
		);
		expect(summary.metrics.readBytes).toBe(4);
		expect(summary.metrics.temporaryBytes).toBe(14);
		expect(JSON.stringify(summary)).not.toContain("secret");
	});

	test("missing DB/root/namespace never initialize anything; explicit identity/owner/status required", async () => {
		const request = await options();
		const missingDb = join(sandbox, "absent.sqlite");
		const missingRoot = join(sandbox, "missing-root");
		const database = await auditFileChangePhysical({ ...request, databasePath: missingDb });
		expect(codes(database)).toContain("database_missing");
		const root = await auditFileChangePhysical({ ...request, blobRoot: missingRoot });
		expect(codes(root)).toContain("directory_missing");
		expect((await readdir(sandbox)).sort()).toEqual(["blobs", "source.sqlite"]);
		const wrongOwner = await auditFileChangePhysical({
			...request,
			rootIdentity: { ...request.rootIdentity, uid: request.rootIdentity.uid + 1 },
		});
		expect(codes(wrongOwner)).toContain("owner_mismatch");
		const wrongSource = await auditFileChangePhysical({
			...request,
			sourceIdentity: { ...request.sourceIdentity, ino: "0" },
		});
		expect(codes(wrongSource)).toContain("source_identity_mismatch");
		const wrongGeneration = await auditFileChangePhysical({ ...request, expectedGeneration: 2 });
		expect(codes(wrongGeneration)).toContain("generation_changed");
		const wrongStatus = await auditFileChangePhysical({
			...request,
			expectedNamespaceStatus: "reconciling",
		});
		expect(codes(wrongStatus)).toContain("namespace_status_changed");
		const wrongNamespace = await auditFileChangePhysical({ ...request, namespaceKey: "other" });
		expect(codes(wrongNamespace)).toContain("namespace_mismatch");
		sqlite.query("DELETE FROM file_change_storage_budgets").run();
		const noNamespace = await auditFileChangePhysical(await options());
		expect(codes(noNamespace)).toContain("namespace_missing");
		expect(sqlite.query("SELECT id FROM file_change_storage_budgets LIMIT 1").get()).toBeNull();
	});
});

describe("physical audit: budgets, concurrency and cancellation", () => {
	test.each([
		{ readBytes: 3 },
		{ blobBytes: 3 },
		{ items: 0 },
		{ directoryItems: 1 },
		{ directoryDepth: 1 },
	])("lowered budget %j returns partial/unknown, never a truncated full result", async (budget) => {
		await put("budget-A");
		await put("budget-B");
		const before = await readFile(databasePath);
		const summary = await auditFileChangePhysical(await options({ budget }));
		expect(summary.full).toBe(false);
		expect(summary.status).not.toBe("observed");
		expect(summary.countsLowerBound).toBe(true);
		expect(codes(summary).some((code) => code.endsWith("limit"))).toBe(true);
		expect(await readFile(databasePath)).toEqual(before);
		assertAuthority(summary);
	});

	test("all options are lower-only, bounded and strictly copied without accessors", async () => {
		const request = await options();
		for (const budget of [
			{ readBytes: LIMITS.readBytes + 1 },
			{ chunkBytes: LIMITS.chunkBytes + 1 },
			{ blobBytes: LIMITS.blobBytes + 1 },
			{ items: LIMITS.items + 1 },
			{ pageItems: 101 },
			{ summaryBytes: LIMITS.summaryBytes + 1 },
			{ durationMs: LIMITS.maximumDurationMs + 1 },
		]) {
			expect(() => auditFileChangePhysical({ ...request, budget })).toThrow("invalid_input");
		}
		expect(() => auditFileChangePhysical({ ...request, blobRoot: "/" })).toThrow("invalid_input");
		expect(() =>
			auditFileChangePhysical({
				...request,
				sourceIdentity: Object.assign({}, request.sourceIdentity, { ino: "1\n" }),
			}),
		).toThrow("invalid_input");
		expect(() =>
			auditFileChangePhysical(
				Object.defineProperty({ ...request }, "blobRoot", {
					get() {
						throw new Error("accessor-called");
					},
				}),
			),
		).toThrow("invalid_input");
	});

	test("pre-cancel and hard deadline finish only their worker and do not change source", async () => {
		await put("untouched");
		const before = await readFile(databasePath);
		const controller = new AbortController();
		controller.abort("secret-cancel-reason");
		const cancelled = await auditFileChangePhysical(await options({ signal: controller.signal }));
		expect(codes(cancelled)).toContain("cancelled");
		const deadline = await auditFileChangePhysical(await options({ budget: { durationMs: 1 } }));
		expect(codes(deadline)).toContain("deadline");
		expect(deadline.full).toBe(false);
		expect(JSON.stringify(cancelled)).not.toContain("secret-cancel-reason");
		expect(await readFile(databasePath)).toEqual(before);
	});

	test("cancel during streamed hash closes worker handles before the same-scope queued job starts", async () => {
		await put(Buffer.alloc(2 * 1024 * 1024, 37));
		const controller = new AbortController();
		const events: { phase: string; at: number }[] = [];
		const request = await options({ budget: { chunkBytes: 256 } });
		let startedResolve: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			startedResolve = resolve;
		});
		const running = auditFileChangePhysical({
			...request,
			signal: controller.signal,
			onProgress(progress) {
				events.push({ phase: progress.phase, at: performance.now() });
				if (progress.phase === "physical") {
					startedResolve();
					controller.abort();
				}
			},
		});
		await started;
		let nextStarted = false;
		const queued = auditFileChangePhysical({
			...request,
			budget: { readBytes: 0 },
			onProgress() {
				nextStarted = true;
			},
		});
		const summary = await running;
		expect(codes(summary)).toContain("cancelled");
		expect(summary.full).toBe(false);
		expect(nextStarted).toBe(false);
		const next = await queued;
		expect(codes(next)).toContain("read_byte_limit");
		for (let n = 1; n < events.length; n++)
			expect(events[n].at - events[n - 1].at).toBeGreaterThanOrEqual(249);
		assertAuthority(summary);
	}, 10_000);

	test("same-generation concurrent DB writes and zero-byte reservations are not quiescence", async () => {
		await put(Buffer.alloc(1024 * 1024, 19));
		let changed = false;
		const summary = await auditFileChangePhysical(
			await options({
				budget: { chunkBytes: 1024 },
				onProgress() {
					if (changed) return;
					changed = true;
					catalog.reserve({
						expectedGeneration: generation,
						ownerEpoch: "late-writer",
						expectedSize: 0,
						signal: new AbortController().signal,
					});
				},
			}),
		);
		expect(changed).toBe(true);
		expect(summary.full).toBe(false);
		expect(summary.end?.generation).toBe(generation);
		expect(summary.end?.pendingReservations).toBe("present");
		expect(summary.start?.dataVersion).not.toBe(summary.end?.dataVersion);
		expect(codes(summary)).toContain("scan_changed");
		assertAuthority(summary);
	}, 10_000);

	test("generation changes during a scan are fenced without updating the catalog", async () => {
		// A bounded streamed hash spans progress publication; the generation change
		// is triggered by observed physical work, never by a guessed timer.
		await put(Buffer.alloc(2 * 1024 * 1024, 7));
		let changed = false;
		let mutationObservedAt: number | undefined;
		let generationBeforeMutation: number | undefined;
		const summary = await auditFileChangePhysical(
			await options({
				budget: { chunkBytes: 128 },
				onProgress(progress) {
					if (changed || progress.phase !== "physical" || progress.readBytes === 0) return;
					changed = true;
					mutationObservedAt = progress.readBytes;
					const currentBudget = catalog.getBudget();
					if (!currentBudget) throw new Error("Observed hash progress has no catalog budget");
					generationBeforeMutation = currentBudget.generation;
					catalog.beginReconciliation({ expectedGeneration: generation });
				},
			}),
		);
		expect(changed).toBe(true);
		expect(mutationObservedAt).toBeGreaterThan(0);
		expect(generationBeforeMutation).toBe(1);
		expect(summary.start?.generation).toBe(1);
		expect(summary.full).toBe(false);
		expect(codes(summary)).toContain("generation_changed");
		expect(summary.end?.generation).toBe(2);
		expect(catalog.getBudget()).toMatchObject({ status: "reconciling", generation: 2 });
		assertAuthority(summary);
	});

	test("object ctime/mtime drift during hashing never counts it as a verified object", async () => {
		const ref = await put(Buffer.alloc(2 * 1024 * 1024, 31));
		let changed = false;
		const summary = await auditFileChangePhysical(
			await options({
				budget: { chunkBytes: 128 },
				onProgress(progress) {
					if (changed || progress.phase !== "physical") return;
					changed = true;
					utimesSync(pathFor(ref), new Date(), new Date(Date.now() + 5000));
				},
			}),
		);
		expect(changed).toBe(true);
		expect(summary.full).toBe(false);
		expect(summary.metrics.verifiedObjects).toBe(0);
		expect(codes(summary)).toContain("object_changed");
	}, 10_000);

	test("root replacement during scan keeps reads inside the pinned original and reports concurrent", async () => {
		await put(Buffer.alloc(1024 * 1024, 47));
		const outside = join(sandbox, "outside");
		await mkdir(outside, { mode: 0o700 });
		await writeFile(join(outside, "secret"), "do-not-read-outside", { mode: 0o600 });
		let changed = false;
		const summary = await auditFileChangePhysical(
			await options({
				budget: { chunkBytes: 1024 },
				onProgress() {
					if (changed) return;
					changed = true;
					renameSync(blobRoot, `${blobRoot}.old`);
					symlinkSync(outside, blobRoot);
				},
			}),
		);
		expect(summary.full).toBe(false);
		expect(codes(summary)).toContain("path_replaced");
		expect(JSON.stringify(summary)).not.toContain("do-not-read-outside");
	});

	test("global pool admits two scopes, bounds queue at 64 and releases all FDs after abort", async () => {
		await put(Buffer.alloc(1024 * 1024, 59));
		const request = await options({ budget: { chunkBytes: 128 } });
		const secondPath = join(sandbox, "second-source.sqlite");
		await writeFile(secondPath, await readFile(databasePath), { mode: 0o600 });
		const second = {
			...request,
			databasePath: secondPath,
			sourceIdentity: await identity(secondPath),
		};
		const openSandboxFds = async () => {
			let found = 0;
			for (const name of await readdir("/proc/self/fd")) {
				try {
					if ((await readlink(`/proc/self/fd/${name}`)).startsWith(sandbox)) found++;
				} catch (error) {
					if ((error as { code?: string }).code !== "ENOENT") throw error;
				}
			}
			return found;
		};
		const before = await openSandboxFds();
		const controllers = Array.from({ length: 66 }, () => new AbortController());
		const observed = new Set<number>();
		let ready: () => void = () => {};
		const bothStarted = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const jobs = controllers.map((controller, n) =>
			auditFileChangePhysical({
				...(n === 1 ? second : request),
				signal: controller.signal,
				onProgress() {
					observed.add(n);
					if (observed.size === 2) ready();
				},
			}),
		);
		const overflow = await auditFileChangePhysical(request);
		expect(codes(overflow)).toContain("queue_limit");
		await bothStarted;
		expect([...observed].sort()).toEqual([0, 1]);
		for (const controller of controllers) controller.abort();
		const results = await Promise.all(jobs);
		expect(results.every((result) => !result.full && codes(result).includes("cancelled"))).toBe(
			true,
		);
		expect(await openSandboxFds()).toBe(before);
	}, 10_000);

	test("new real publication while scanning cannot produce full even in the same generation", async () => {
		await put(Buffer.alloc(2 * 1024 * 1024, 71));
		let publication: Promise<FileChangeBlobRef> | undefined;
		const summary = await auditFileChangePhysical(
			await options({
				budget: { chunkBytes: 512 },
				onProgress() {
					publication ??= put("published-during-scan");
				},
			}),
		);
		const ref = await publication;
		expect(ref).toBeDefined();
		expect(summary.full).toBe(false);
		expect(summary.start?.generation).toBe(summary.end?.generation);
		expect(
			codes(summary).some((code) =>
				["scan_changed", "shard_changed", "concurrent_publication"].includes(code),
			),
		).toBe(true);
		expect(await readFile(pathFor(ref as FileChangeBlobRef))).toEqual(
			Buffer.from("published-during-scan"),
		);
		assertAuthority(summary);
	}, 10_000);

	test("mode changes after opening cannot be certified by a successful content hash", async () => {
		const ref = await put(Buffer.alloc(2 * 1024 * 1024, 73));
		let changed = false;
		const summary = await auditFileChangePhysical(
			await options({
				budget: { chunkBytes: 128 },
				onProgress(progress) {
					if (changed || progress.phase !== "physical") return;
					changed = true;
					chmodSync(pathFor(ref), 0o644);
				},
			}),
		);
		expect(changed).toBe(true);
		expect(summary.full).toBe(false);
		expect(summary.metrics.verifiedObjects).toBe(0);
		expect(codes(summary)).toContain("path_replaced");
		expect((await lstat(pathFor(ref))).mode & 0o777).toBe(0o644);
	}, 10_000);

	test("non-ENOENT filesystem failure is explicit, never mistaken for missing", async () => {
		if (process.getuid?.() === 0) return; // root bypasses DAC; owner-mismatch remains covered above.
		await put("permission-test");
		await chmod(join(blobRoot, ".tmp"), 0);
		try {
			const summary = await auditFileChangePhysical(await options());
			expect(codes(summary)).toContain("permission_denied");
			expect(summary.full).toBe(false);
			expect(summary.metrics.catalogOnly).toBe(0);
		} finally {
			await chmod(join(blobRoot, ".tmp"), 0o700);
		}
	});

	test("separate worker cannot release the caller's live SQLite exclusive lock", async () => {
		const request = await options();
		const probe = () => {
			// Independent SQLite implementation/PID proves the actual OS file lock, not
			// Bun's connection cache. Python is a test-only verifier, never a worker dependency.
			const child = Bun.spawnSync(
				[
					"python3",
					"-c",
					`
import sqlite3, sys
connection = sqlite3.connect("file:" + sys.argv[1] + "?mode=rw", uri=True, timeout=0)
try:
    connection.execute("BEGIN EXCLUSIVE")
    connection.execute("ROLLBACK")
except sqlite3.OperationalError:
    sys.exit(17)
finally:
    connection.close()
`,
					databasePath,
				],
				{ stdout: "ignore", stderr: "ignore", timeout: 1000 },
			);
			return child.exitCode;
		};
		expect(sqlite.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
		sqlite.exec("BEGIN EXCLUSIVE");
		expect(sqlite.inTransaction).toBe(true);
		try {
			expect(await probe()).toBe(17);
			const summary = await auditFileChangePhysical(request);
			expect(summary.full).toBe(false);
			expect(codes(summary)).toContain("sqlite_busy");
			expect(await probe()).toBe(17);
		} finally {
			sqlite.exec("ROLLBACK");
		}
		expect(await probe()).toBe(0);
	});

	test("live WAL is read-only with existing sidecars; missing sidecars are not initialized", async () => {
		sqlite.exec("PRAGMA journal_mode = WAL");
		await put("wal-object");
		for (const suffix of ["-wal", "-shm"]) await chmod(databasePath + suffix, 0o600);
		const budgetBefore = catalog.getBudget();
		const summary = await auditFileChangePhysical(await options());
		expect(summary.full).toBe(true);
		expect(summary.metrics.verifiedObjects).toBe(1);
		expect(catalog.getBudget()).toEqual(budgetBefore);
		sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		// Copy the checkpointed main file only. The copied WAL-mode header has NO sidecars.
		const absentSidecars = join(sandbox, "wal-copy.sqlite");
		await writeFile(absentSidecars, await readFile(databasePath), { mode: 0o600 });
		const entries = await readdir(sandbox);
		const missing = await auditFileChangePhysical(
			await options({
				databasePath: absentSidecars,
				sourceIdentity: await identity(absentSidecars),
			}),
		);
		expect(missing.full).toBe(false);
		expect(codes(missing)).toContain("wal_sidecars_required");
		expect(await readdir(sandbox)).toEqual(entries);
	});
});
