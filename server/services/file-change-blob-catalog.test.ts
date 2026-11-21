import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fileChangeBlobs as blobs,
	fileChangeStorageBudgets as budgets,
	fileChangeBlobReservations as reservations,
} from "@server/db/schema";
import type { FileChangeBlobRef } from "@shared/file-change-protocol";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	blobCatalogInternals,
	FILE_CHANGE_BLOB_BUDGET_ID,
	FileChangeBlobCatalog,
	FileChangeBlobCatalogError,
	type FileChangeBlobCatalogErrorCode,
} from "./file-change-blob-catalog";
import { type FileChangeBlobRelease, FileChangeBlobStore } from "./file-change-blob-store";
import { fileHistoryCatalogDiagnostic } from "./file-change-history-diagnostics";

const DDL = `
CREATE TABLE file_change_blobs (
 id TEXT PRIMARY KEY NOT NULL, digest TEXT NOT NULL UNIQUE, size_bytes INTEGER NOT NULL,
 storage_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'staging', lease_until TEXT,
 gc_generation INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE file_change_storage_budgets (
 id TEXT PRIMARY KEY NOT NULL, namespace_key TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'unverified', used_bytes INTEGER NOT NULL DEFAULT 0,
 reserved_bytes INTEGER NOT NULL DEFAULT 0, quota_bytes INTEGER NOT NULL,
 generation INTEGER NOT NULL DEFAULT 0, reconciled_at TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE file_change_blob_reservations (
 id TEXT PRIMARY KEY NOT NULL, budget_id TEXT NOT NULL REFERENCES file_change_storage_budgets(id),
 owner_epoch TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, expected_size INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'reserved', blob_digest TEXT REFERENCES file_change_blobs(digest),
 published INTEGER, created_at TEXT NOT NULL, settled_at TEXT
);
CREATE INDEX idx_fc_reservation_budget ON file_change_blob_reservations(budget_id,status,created_at,id);
`;
const empty: FileChangeBlobRelease = { ref: null, published: false };
let root: string;
let sqlite: Database;
let db: ReturnType<typeof drizzle>;
let catalog: FileChangeBlobCatalog;
let queries: string[];
beforeEach(async () => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	root = await mkdtemp(join(await realpath(tmpdir()), "blob-catalog-v3-"));
	sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;");
	sqlite.exec(DDL);
	queries = [];
	db = drizzle(sqlite, { logger: { logQuery: (query) => queries.push(query) } });
	catalog = new FileChangeBlobCatalog({ db, namespaceKey: root });
});
afterEach(async () => {
	sqlite.close(true);
	await rm(root, { recursive: true, force: true });
});
function refFor(text = "abc"): FileChangeBlobRef {
	return {
		algorithm: "sha256",
		digest: createHash("sha256").update(text).digest("hex"),
		sizeBytes: Buffer.byteLength(text),
	};
}
function reserve(size = 3, source = catalog) {
	return source.reserve({
		expectedGeneration: 0,
		ownerEpoch: "writer",
		expectedSize: size,
		signal: new AbortController().signal,
	});
}
async function expectCode(run: () => unknown, code: FileChangeBlobCatalogErrorCode) {
	let error: unknown;
	try {
		await run();
	} catch (caught) {
		error = caught;
	}
	expect(error).toMatchObject({ name: "FileChangeBlobCatalogError", code });
	return error;
}
function store() {
	return new FileChangeBlobStore({
		root: join(root, "objects"),
		minimumFreeBytes: 0,
		admission: catalog.admission({ ownerEpoch: "writer" }),
	});
}
function blobPath(ref: FileChangeBlobRef) {
	return join(root, "objects", "sha256", ref.digest.slice(0, 2), ref.digest);
}

describe("independent retryable blob history", () => {
	test("initialization is idempotent and needs no ready-state transition", async () => {
		expect(await catalog.getBudget()).toBeNull();
		const initialized = catalog.initializeNamespace({ quotaBytes: 100 });
		expect(catalog.initializeNamespace({ expectedGeneration: 999 })).toEqual(initialized);
		const lease = await reserve();
		lease.release({ ref: refFor(), published: true });
		expect((await catalog.getMetadata({ ref: refFor() }))?.status).toBe("ready");
		expect((await catalog.getBudget())?.usedBytes).toBe(3);
		expect(db.select().from(reservations).all()).toEqual([]);
	});
	test.each([
		"unverified",
		"reconciling",
		"ready",
	] as const)("old %s status and abandoned reservations remain archival", async (status) => {
		catalog.initializeNamespace({ quotaBytes: 100 });
		db.update(budgets)
			.set({ status, reservedBytes: Number.MAX_SAFE_INTEGER, generation: 91 })
			.where(eq(budgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
			.run();
		db.insert(reservations)
			.values({
				id: "abandoned",
				budgetId: FILE_CHANGE_BLOB_BUDGET_ID,
				ownerEpoch: "dead-owner",
				generation: 3,
				expectedSize: 100,
				status: "reconcile_required",
				createdAt: "2026-01-01T00:00:00.000Z",
			})
			.run();
		const before = db.select().from(reservations).all();
		const budget = await catalog.getBudget();
		if (!budget) throw new Error("Missing budget fixture");
		expect(catalog.initializeNamespace()).toEqual(budget);
		(await reserve()).release({ ref: refFor(), published: true });
		expect(await catalog.getBudget()).toMatchObject({
			status,
			generation: 91,
			reservedBytes: Number.MAX_SAFE_INTEGER,
			usedBytes: 3,
		});
		expect(db.select().from(reservations).all()).toEqual(before);
	});
	test("live byte quota is shared across handles without serializing file IO", async () => {
		catalog.initializeNamespace({ quotaBytes: 5 });
		const other = new FileChangeBlobCatalog({ db, namespaceKey: root });
		const first = await reserve(3);
		const second = await reserve(2, other);
		await expectCode(() => reserve(1, other), "quota_exceeded");
		first.release(empty);
		const third = await reserve(3, other);
		second.release(empty);
		third.release(empty);
		(await reserve(5)).release(empty);
		expect(await catalog.getBudget()).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
		expect(queries.some((query) => /SUM\s*\(|COUNT\s*\(/i.test(query))).toBe(false);
	});
	test("verified publication is atomic, deduplicated, and enforces stored byte quota", async () => {
		catalog.initializeNamespace({ quotaBytes: 6 });
		const first = await reserve();
		const result = { ref: refFor(), published: true };
		first.release(result);
		first.release(result);
		(await reserve()).release({ ref: refFor(), published: false });
		expect((await catalog.getBudget())?.usedBytes).toBe(3);
		(await reserve()).release({ ref: refFor("def"), published: true });
		expect((await catalog.getBudget())?.usedBytes).toBe(6);
		await expectCode(() => reserve(1), "quota_exceeded");
		await expectCode(() => first.release(empty), "release_conflict");
	});
	test("accounting failure releases in-memory quota and never damages published bytes", async () => {
		catalog.initializeNamespace({ quotaBytes: 8 });
		const objects = store();
		sqlite.exec(
			"CREATE TRIGGER fail_accounting BEFORE UPDATE OF used_bytes ON file_change_storage_budgets BEGIN SELECT RAISE(ABORT, 'accounting-fault'); END;",
		);
		await expect(objects.putBytes(Buffer.from("abc"), { expectedSize: 3 })).rejects.toThrow(
			"admission release failed",
		);
		expect(await readFile(blobPath(refFor()), "utf8")).toBe("abc");
		expect(await catalog.getMetadata({ ref: refFor() })).toBeNull();
		sqlite.exec("DROP TRIGGER fail_accounting;");
		const second = await objects.putBytes(Buffer.from("def"), { expectedSize: 3 });
		expect(await objects.readBytes(second)).toEqual(Buffer.from("def"));
		const retry = await objects.putBytes(Buffer.from("abc"), { expectedSize: 3 });
		expect(await objects.readBytes(retry)).toEqual(Buffer.from("abc"));
		expect((await catalog.getBudget())?.usedBytes).toBe(6);
		expect(await readFile(blobPath(refFor()), "utf8")).toBe("abc");
	});
	test("original publication callback is retryable after a transient DB failure", async () => {
		catalog.initializeNamespace({ quotaBytes: 3 });
		const lease = await reserve();
		const result = { ref: refFor(), published: true };
		sqlite.exec(
			"CREATE TRIGGER fail_blob BEFORE INSERT ON file_change_blobs BEGIN SELECT RAISE(ABORT, 'blob-fault'); END;",
		);
		expect(() => lease.release(result)).toThrow("blob-fault");
		(await reserve()).release(empty);
		sqlite.exec("DROP TRIGGER fail_blob;");
		lease.release(result);
		lease.release(result);
		expect((await catalog.getBudget())?.usedBytes).toBe(3);
	});
	test("a corrupt object only fails that digest and remains intact", async () => {
		catalog.initializeNamespace({ quotaBytes: 100 });
		const objects = store();
		const original = await objects.putBytes(Buffer.from("abc"), { expectedSize: 3 });
		await writeFile(blobPath(original), "bad");
		await expect(objects.readBytes(original)).rejects.toThrow();
		await expect(objects.putBytes(Buffer.from("abc"), { expectedSize: 3 })).rejects.toThrow();
		const second = await objects.putBytes(Buffer.from("xyz"), { expectedSize: 3 });
		expect(await objects.readBytes(second)).toEqual(Buffer.from("xyz"));
		expect(await readFile(blobPath(original), "utf8")).toBe("bad");
		expect((await catalog.getMetadata({ ref: original }))?.digest).toBe(original.digest);
	});
	test("stream failure returns only active quota and preserves older history", async () => {
		catalog.initializeNamespace({ quotaBytes: 6 });
		const objects = store();
		const prior = await objects.putBytes(Buffer.from("abc"), { expectedSize: 3 });
		async function* failed() {
			yield Buffer.from("d");
			throw new Error("producer-fault");
		}
		await expect(objects.putStream(failed(), { expectedSize: 3 })).rejects.toThrow(
			"producer-fault",
		);
		const later = await objects.putBytes(Buffer.from("def"), { expectedSize: 3 });
		expect(await objects.readBytes(prior)).toEqual(Buffer.from("abc"));
		expect(await objects.readBytes(later)).toEqual(Buffer.from("def"));
	});
	test("cancellation and invalid publication metadata release only their own quota", async () => {
		catalog.initializeNamespace({ quotaBytes: 3 });
		const signal = AbortSignal.abort();
		await expectCode(
			() => catalog.reserve({ ownerEpoch: "writer", expectedSize: 3, signal }),
			"aborted",
		);
		const lease = await reserve();
		await expectCode(
			() => lease.release({ ref: refFor("wrong-size"), published: true }),
			"size_mismatch",
		);
		(await reserve()).release(empty);
		expect((await catalog.getBudget())?.usedBytes).toBe(0);
	});
	test("a reservation snapshots its declared size before the caller can mutate it", async () => {
		catalog.initializeNamespace({ quotaBytes: 10 });
		const request = { ownerEpoch: "writer", expectedSize: 3, signal: new AbortController().signal };
		const pending = catalog.reserve(request);
		request.expectedSize = 6;
		const lease = await pending;
		await expectCode(
			() => lease.release({ ref: refFor("abcdef"), published: true }),
			"size_mismatch",
		);
		expect((await catalog.getBudget())?.usedBytes).toBe(0);
		(await reserve(10)).release(empty);
	});

	test("namespace identity, catalog metadata and unsafe SQLite settings stay enforced", async () => {
		catalog.initializeNamespace({ quotaBytes: 100 });
		const other = new FileChangeBlobCatalog({ db, namespaceKey: "different" });
		await expectCode(() => other.initializeNamespace(), "namespace_mismatch");
		await expectCode(() => other.getMetadata({ ref: refFor() }), "namespace_mismatch");
		(await reserve()).release({ ref: refFor(), published: true });
		db.update(blobs).set({ sizeBytes: 99 }).where(eq(blobs.digest, refFor().digest)).run();
		await expectCode(
			async () => (await reserve()).release({ ref: refFor(), published: false }),
			"catalog_mismatch",
		);
		sqlite.exec("PRAGMA busy_timeout = 5000;");
		await expectCode(() => new FileChangeBlobCatalog({ db, namespaceKey: root }), "invalid_input");
	});
	test("shared two-argument budget validation preserves its original behavior", async () => {
		const error = await expectCode(
			() =>
				blobCatalogInternals.checkBudget(
					{ namespaceKey: "other", usedBytes: 0, quotaBytes: 100 },
					root,
				),
			"namespace_mismatch",
		);
		expect((error as Error).message).toBe(
			"Database is bound to a different physical blob namespace",
		);
		expect(fileHistoryCatalogDiagnostic(error)).toBeUndefined();
	});

	test("namespace mismatch retains precise initialization metadata with no extra SQL", async () => {
		const currentKey = "b".repeat(64);
		const storedKey = "a".repeat(64);
		catalog = new FileChangeBlobCatalog({ db, namespaceKey: currentKey });
		catalog.initializeNamespace();
		db.update(budgets)
			.set({
				namespaceKey: storedKey,
				status: "ready",
				generation: 2,
				updatedAt: "2026-10-31 03:54:39",
			})
			.run();
		queries.length = 0;
		const error = await expectCode(() => catalog.initializeNamespace(), "namespace_mismatch");
		expect(error).toBeInstanceOf(FileChangeBlobCatalogError);
		expect((error as Error).message).toBe(
			"Database is bound to a different physical blob namespace",
		);
		expect(fileHistoryCatalogDiagnostic(error)).toEqual({
			errorCode: "namespace_mismatch",
			errorName: "FileChangeBlobCatalogError",
			catalogStage: "initialize",
			reason: "key_mismatch",
			keysEqual: false,
			storedKeyFingerprint: createHash("sha256").update(storedKey).digest("hex"),
			currentKeyFingerprint: createHash("sha256").update(currentKey).digest("hex"),
			status: "ready",
			generation: 2,
			updatedAt: "2026-10-31 03:54:39",
		});
		// Bun's native transaction wrapper is not part of Drizzle's query logger.
		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain("limit ?");
	});

	test("multiple budget rows preserve the guard without evaluating a throwing row ID getter", async () => {
		let idReads = 0;
		const rows = [
			{
				get id() {
					idReads++;
					throw new Error("unexpected diagnostic ID read");
				},
				namespaceKey: root,
			},
			{},
		];
		const transaction = spyOn(db, "transaction").mockImplementation((work) => {
			const tx = { select: () => ({ from: () => ({ limit: () => ({ all: () => rows }) }) }) };
			return work(tx as unknown as Parameters<typeof work>[0]);
		});
		try {
			const error = await expectCode(() => catalog.initializeNamespace(), "namespace_mismatch");
			expect(error).toBeInstanceOf(FileChangeBlobCatalogError);
			expect((error as Error).message).toBe(
				"A database must bind exactly one physical blob namespace",
			);
			expect(idReads).toBe(0);
			expect(fileHistoryCatalogDiagnostic(error)).toMatchObject({
				errorCode: "namespace_mismatch",
				catalogStage: "initialize",
				reason: "cardinality",
				observedRows: 2,
			});
			expect(fileHistoryCatalogDiagnostic(error)?.rowIdMatches).toBeUndefined();
		} finally {
			transaction.mockRestore();
		}
	});

	test.each([
		"cardinality",
		"budget_id",
	] as const)("initialization distinguishes %s without disclosing row IDs or changing its guard", async (reason) => {
		catalog.initializeNamespace();
		if (reason === "cardinality")
			db.insert(budgets)
				.values({
					id: "private-second-budget",
					namespaceKey: "a".repeat(64),
					quotaBytes: 100,
					updatedAt: "2026-10-31T00:00:00.000Z",
				})
				.run();
		else db.update(budgets).set({ id: "private-invalid-budget" }).run();
		queries.length = 0;
		const error = await expectCode(() => catalog.initializeNamespace(), "namespace_mismatch");
		expect((error as Error).message).toBe(
			"A database must bind exactly one physical blob namespace",
		);
		expect(fileHistoryCatalogDiagnostic(error)).toMatchObject({
			catalogStage: "initialize",
			reason,
			observedRows: reason === "cardinality" ? 2 : 1,
		});
		expect(fileHistoryCatalogDiagnostic(error)?.rowIdMatches).toBe(
			reason === "cardinality" ? undefined : false,
		);
		expect(JSON.stringify(fileHistoryCatalogDiagnostic(error))).not.toContain("private-");
		expect(queries).toHaveLength(1);
	});

	test.each([
		"budget",
		"metadata",
		"reservations",
	] as const)("%s mismatch uses only the existing bounded budget read and reports budget_read", async (kind) => {
		catalog.initializeNamespace();
		db.update(budgets)
			.set({ namespaceKey: "a".repeat(64) })
			.run();
		{
			queries.length = 0;
			const error = await expectCode(
				() =>
					kind === "budget"
						? catalog.getBudget()
						: kind === "metadata"
							? catalog.getMetadata({ ref: refFor() })
							: catalog.listReservations({ status: "reserved" }),
				"namespace_mismatch",
			);
			expect(fileHistoryCatalogDiagnostic(error)).toMatchObject({
				catalogStage: "budget_read",
				reason: "key_mismatch",
			});
			expect(queries).toHaveLength(1);
			expect(queries[0]).toContain('where "file_change_storage_budgets"."id" = ?');
			expect(queries[0]).toContain("limit ?");
		}
	});

	test("publication accounting reports its own stage with only the existing budget read", async () => {
		catalog.initializeNamespace();
		const lease = await reserve();
		db.update(budgets)
			.set({ namespaceKey: "a".repeat(64) })
			.run();
		queries.length = 0;
		const error = await expectCode(
			() => lease.release({ ref: refFor(), published: true }),
			"namespace_mismatch",
		);
		expect(fileHistoryCatalogDiagnostic(error)).toMatchObject({
			catalogStage: "publication_accounting",
			reason: "key_mismatch",
		});
		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain('where "file_change_storage_budgets"."id" = ?');
	});

	test("legacy reservation inventory remains bounded and read-only", async () => {
		catalog.initializeNamespace();
		for (let index = 0; index < 5; index++)
			db.insert(reservations)
				.values({
					id: `old-${index}`,
					budgetId: FILE_CHANGE_BLOB_BUDGET_ID,
					ownerEpoch: "old",
					expectedSize: 1,
					createdAt: "2026-01-01T00:00:00.000Z",
				})
				.run();
		const first = await catalog.listReservations({ status: "reserved", limit: 2 });
		const second = await catalog.listReservations({
			status: "reserved",
			limit: 2,
			after: first.nextCursor ?? undefined,
		});
		const last = await catalog.listReservations({
			status: "reserved",
			limit: 2,
			after: second.nextCursor ?? undefined,
		});
		expect([...first.items, ...second.items, ...last.items].map((row) => row.id)).toEqual([
			"old-0",
			"old-1",
			"old-2",
			"old-3",
			"old-4",
		]);
		expect(last.nextCursor).toBeNull();
	});
});
