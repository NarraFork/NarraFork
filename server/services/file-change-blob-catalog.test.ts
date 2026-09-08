import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fileChangeBlobs as blobs,
	fileChangeStorageBudgets as budgets,
	fileChangeBlobReservations as reservations,
} from "@server/db/schema";
import { FILE_CHANGE_LIMITS, type FileChangeBlobRef } from "@shared/file-change-protocol";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	FILE_CHANGE_BLOB_BUDGET_ID,
	FileChangeBlobCatalog,
	type FileChangeBlobCatalogErrorCode,
	type FileChangeBlobCatalogLease,
} from "./file-change-blob-catalog";
import { type FileChangeBlobRelease, FileChangeBlobStore } from "./file-change-blob-store";

// Deliberately independent SQLite fixtures, never importing the application DB.
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
CREATE INDEX idx_fc_reservation_blob ON file_change_blob_reservations(blob_digest);
`;
const namespaceKey = "test-physical-namespace";
const verification = {
	namespaceIdentityVerified: true,
	writersQuiescent: true,
	physicalInventoryComplete: true,
	catalogMatchesInventory: true,
} as const;
const terminalVerification = {
	ownerStopped: true,
	temporaryBytesRemoved: true,
	outcomeVerified: true,
} as const;
const emptyRelease: FileChangeBlobRelease = { ref: null, published: false };
let sandbox: string;
let sqlite: Database;
let db: ReturnType<typeof drizzle>;
let catalog: FileChangeBlobCatalog;
let generation: number;
let queries: string[];
const extraConnections: Database[] = [];

beforeEach(async () => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	expect(process.env.NARRAFORK_HOME).toBeDefined();
	sandbox = await mkdtemp(join(await realpath(tmpdir()), "blob-catalog-test-"));
	sqlite = connection();
	sqlite.exec(DDL);
	queries = [];
	db = drizzle(sqlite, { logger: { logQuery: (query) => queries.push(query) } });
	catalog = new FileChangeBlobCatalog({ db, namespaceKey });
	generation = 0;
});

afterEach(async () => {
	for (const conn of extraConnections.splice(0)) conn.close();
	sqlite.close();
	await rm(sandbox, { recursive: true, force: true });
});

function connection(path = ":memory:"): Database {
	const conn = new Database(path);
	conn.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;");
	return conn;
}

function ready(quotaBytes = 100): void {
	catalog.initializeNamespace({ expectedGeneration: null, quotaBytes });
	generation = catalog.beginReconciliation({ expectedGeneration: 0 }).generation;
	catalog.completeReconciliation({
		expectedGeneration: generation,
		verifiedUsedBytes: 0,
		verification,
	});
}

function reserve(expectedSize = 3, ownerEpoch = "writer-epoch"): FileChangeBlobCatalogLease {
	return catalog.reserve({
		expectedGeneration: generation,
		ownerEpoch,
		expectedSize,
		signal: new AbortController().signal,
	});
}

function refFor(text = "abc"): FileChangeBlobRef {
	return {
		algorithm: "sha256",
		digest: createHash("sha256").update(text).digest("hex"),
		sizeBytes: Buffer.byteLength(text),
	};
}

function reservation(lease: FileChangeBlobCatalogLease) {
	return db.select().from(reservations).where(eq(reservations.id, lease.reservationId)).get();
}

function expectCode(run: () => unknown, code: FileChangeBlobCatalogErrorCode): void {
	expect(run).toThrow(expect.objectContaining({ name: "FileChangeBlobCatalogError", code }));
}

function stopSettlement(): void {
	sqlite.exec(`CREATE TRIGGER fail_settlement BEFORE UPDATE OF status ON file_change_blob_reservations
		WHEN NEW.status = 'settled' BEGIN SELECT RAISE(ABORT, 'settlement-fault'); END;`);
}

function restartReconciliation(): void {
	generation = catalog.beginReconciliation({ expectedGeneration: generation }).generation;
}

describe("blob catalog namespace and admission", () => {
	test("new and reinitialized namespaces are unverified; no implicit worker exists", () => {
		expect(catalog.getBudget()).toBeNull();
		expectCode(() => reserve(), "namespace_unverified");
		const initial = catalog.initializeNamespace({ expectedGeneration: null });
		expect(initial).toMatchObject({
			status: "unverified",
			usedBytes: 0,
			reservedBytes: 0,
			generation: 0,
			quotaBytes: FILE_CHANGE_LIMITS.blobSoftQuotaBytes,
		});
		expectCode(() => reserve(), "namespace_unverified");
		generation = catalog.beginReconciliation({ expectedGeneration: 0 }).generation;
		expectCode(() => reserve(), "namespace_unverified");
		catalog.completeReconciliation({
			expectedGeneration: generation,
			verifiedUsedBytes: 0,
			verification,
		});
		const lease = reserve();
		lease.release({ ref: refFor(), published: true });
		const restarted = catalog.initializeNamespace({ expectedGeneration: generation });
		expect(restarted).toMatchObject({
			status: "unverified",
			usedBytes: 3,
			reservedBytes: 0,
			generation: generation + 1,
		});
		expectCode(
			() => catalog.getMetadata({ expectedGeneration: restarted.generation, ref: refFor() }),
			"namespace_unverified",
		);
		expectCode(() => reserve(), "generation_mismatch");
		expect("readBytes" in catalog).toBe(false);
		expect("delete" in catalog).toBe(false);
	});

	test("another namespace cannot get a second budget in the same database", () => {
		ready();
		const other = new FileChangeBlobCatalog({ db, namespaceKey: "another-store" });
		expectCode(() => other.getBudget(), "namespace_mismatch");
		expectCode(
			() => other.initializeNamespace({ expectedGeneration: generation }),
			"namespace_mismatch",
		);
		expect(db.select().from(budgets).all()).toHaveLength(1);
	});

	test("preexisting extra budgets are rejected rather than treated as tenant quotas", () => {
		db.insert(budgets)
			.values({
				id: "other",
				namespaceKey: "other",
				quotaBytes: 100,
				updatedAt: new Date().toISOString(),
			})
			.run();
		expectCode(
			() => catalog.initializeNamespace({ expectedGeneration: null }),
			"namespace_mismatch",
		);
	});

	test("reserve is atomic across competing handles and never aggregates the catalog", async () => {
		ready(10);
		const other = new FileChangeBlobCatalog({ db, namespaceKey });
		queries.length = 0;
		const admissions = [catalog, other].map((service, index) =>
			service.admission({ expectedGeneration: generation, ownerEpoch: `owner-${index}` }),
		);
		const transactions = spyOn(db, "transaction");
		const attempts = await Promise.allSettled(
			admissions.map((admission) =>
				Promise.resolve().then(() =>
					admission.reserve({ expectedSize: 6, signal: new AbortController().signal }),
				),
			),
		);
		try {
			expect(transactions).toHaveBeenCalledWith(expect.any(Function), { behavior: "immediate" });
		} finally {
			transactions.mockRestore();
		}
		expect(attempts.filter((value) => value.status === "fulfilled")).toHaveLength(1);
		expect(attempts.filter((value) => value.status === "rejected")).toHaveLength(1);
		expect(catalog.getBudget()).toMatchObject({ usedBytes: 0, reservedBytes: 6 });
		expect(queries.some((query) => /\b(SUM|COUNT|GROUP BY)\b/i.test(query))).toBe(false);
		const admitted = attempts[0];
		if (admitted?.status !== "fulfilled") throw new Error("Expected first reservation");
		await admitted.value.release(emptyRelease);
		expect(catalog.getBudget()?.reservedBytes).toBe(0);
	});

	test("reservation insertion and counter increment roll back together", () => {
		ready(10);
		sqlite.exec(
			`CREATE TRIGGER fail_counter BEFORE UPDATE OF reserved_bytes ON file_change_storage_budgets BEGIN SELECT RAISE(ABORT, 'counter-fault'); END;`,
		);
		expect(() => reserve(6)).toThrow();
		expect(catalog.getBudget()?.reservedBytes).toBe(0);
		expect(db.select().from(reservations).all()).toHaveLength(0);
	});

	test("independent SQLite connections fail fast on locks and share atomic quota counters", () => {
		const path = join(sandbox, "competing-catalog.db");
		const first = connection(path);
		extraConnections.push(first);
		first.exec(DDL);
		const a = new FileChangeBlobCatalog({ db: drizzle(first), namespaceKey });
		a.initializeNamespace({ expectedGeneration: null, quotaBytes: 10 });
		a.beginReconciliation({ expectedGeneration: 0 });
		a.completeReconciliation({ expectedGeneration: 1, verifiedUsedBytes: 0, verification });
		const second = connection(path);
		extraConnections.push(second);
		const b = new FileChangeBlobCatalog({ db: drizzle(second), namespaceKey });
		const request = {
			expectedGeneration: 1,
			ownerEpoch: "other-connection",
			expectedSize: 6,
			signal: new AbortController().signal,
		};
		first.exec("BEGIN IMMEDIATE");
		try {
			expect(() => b.reserve(request)).toThrow();
		} finally {
			first.exec("ROLLBACK");
		}
		expect(b.getBudget()?.reservedBytes).toBe(0);
		const lease = b.reserve(request);
		expect(a.getBudget()?.reservedBytes).toBe(6);
		expectCode(() => a.reserve(request), "quota_exceeded");
		lease.release(emptyRelease);
		expect(a.getBudget()?.reservedBytes).toBe(0);
	});

	test("abort/invalid bounds reserve no bytes and release ignores the aborted signal", () => {
		ready();
		const controller = new AbortController();
		const admission = catalog.admission({
			expectedGeneration: generation,
			ownerEpoch: "abort-owner",
		});
		const lease = admission.reserve({ expectedSize: 3, signal: controller.signal });
		if (lease instanceof Promise) throw new Error("Catalog admission is synchronous");
		controller.abort();
		lease.release(emptyRelease);
		expectCode(() => admission.reserve({ expectedSize: 3, signal: controller.signal }), "aborted");
		for (const size of [-1, 0.1, Number.NaN, FILE_CHANGE_LIMITS.blobBytes + 1])
			expectCode(() => reserve(size), "invalid_input");
		expect(catalog.getBudget()?.reservedBytes).toBe(0);
	});

	test("an over-quota verified namespace keeps existing evidence and refuses writes", () => {
		catalog.initializeNamespace({ expectedGeneration: null, quotaBytes: 2 });
		generation = catalog.beginReconciliation({ expectedGeneration: 0 }).generation;
		catalog.reconcileBlob({
			expectedGeneration: generation,
			ref: refFor(),
			physicalState: "verified",
		});
		catalog.completeReconciliation({
			expectedGeneration: generation,
			verifiedUsedBytes: 3,
			verification,
		});
		expectCode(() => reserve(0), "quota_exceeded");
		expect(catalog.getMetadata({ expectedGeneration: generation, ref: refFor() })?.status).toBe(
			"ready",
		);
	});

	test("unsafe SQLite busy waits and missing foreign keys are refused without changing settings", () => {
		sqlite.exec("PRAGMA busy_timeout = 5000;");
		expectCode(() => new FileChangeBlobCatalog({ db, namespaceKey }), "invalid_input");
		expect(sqlite.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
		sqlite.exec("PRAGMA busy_timeout = 0; PRAGMA foreign_keys = OFF;");
		expectCode(() => new FileChangeBlobCatalog({ db, namespaceKey }), "invalid_input");
	});
});

describe("durable exactly-once publication accounting", () => {
	test("duplicate hashes charge once even if the deduplicating publisher releases first", () => {
		ready();
		const first = reserve();
		const second = reserve();
		const ref = refFor();
		second.release({ ref, published: false });
		first.release({ ref, published: true });
		first.release({ ref, published: true });
		second.release({ ref, published: false });
		expect(catalog.getBudget()).toMatchObject({ usedBytes: 3, reservedBytes: 0 });
		expect(db.select().from(blobs).all()).toHaveLength(1);
		expect(reservation(first)).toMatchObject({
			status: "settled",
			blobDigest: ref.digest,
			published: true,
			generation,
		});
		expect(reservation(second)).toMatchObject({ status: "settled", published: false });
		expect(catalog.getMetadata({ expectedGeneration: generation, ref })).toMatchObject({
			status: "ready",
			sizeBytes: 3,
			storageKey: `sha256/${ref.digest.slice(0, 2)}/${ref.digest}`,
		});
		expectCode(() => first.release(emptyRelease), "release_conflict");
		expectCode(
			() => catalog.retryRelease(first, { ref: refFor("xyz"), published: true }),
			"release_conflict",
		);
	});

	test("failed publication refunds once and cannot later claim publication", () => {
		ready();
		const lease = reserve();
		lease.release(emptyRelease);
		lease.release(emptyRelease);
		catalog.retryRelease(lease, emptyRelease);
		expect(catalog.getBudget()).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
		expect(reservation(lease)).toMatchObject({
			status: "settled",
			blobDigest: null,
			published: false,
		});
		expectCode(() => lease.release({ ref: refFor(), published: true }), "release_conflict");
		expect(db.select().from(blobs).all()).toHaveLength(0);
	});

	test("SQL failure after publication preserves staging and a durable result for retry", () => {
		ready();
		const lease = reserve();
		const result = { ref: refFor(), published: true };
		stopSettlement();
		expect(() => lease.release(result)).toThrow();
		expect(reservation(lease)).toMatchObject({
			status: "reconcile_required",
			blobDigest: result.ref.digest,
			published: true,
			settledAt: null,
		});
		expect(catalog.getBudget()).toMatchObject({ usedBytes: 0, reservedBytes: 3 });
		expect(catalog.getMetadata({ expectedGeneration: generation, ref: result.ref })?.status).toBe(
			"staging",
		);
		sqlite.exec("DROP TRIGGER fail_settlement;");
		lease.release(result);
		lease.release(result);
		expect(catalog.getBudget()).toMatchObject({ usedBytes: 3, reservedBytes: 0 });
		expect(catalog.getMetadata({ expectedGeneration: generation, ref: result.ref })?.status).toBe(
			"ready",
		);
	});

	test("SQL failure before catalog insert keeps reservation; retry cannot double-spend", () => {
		ready();
		const lease = reserve();
		sqlite.exec(
			`CREATE TRIGGER fail_blob BEFORE INSERT ON file_change_blobs BEGIN SELECT RAISE(ABORT, 'blob-fault'); END;`,
		);
		expect(() => lease.release({ ref: refFor(), published: true })).toThrow();
		expect(reservation(lease)).toMatchObject({
			status: "reconcile_required",
			blobDigest: null,
			published: null,
		});
		expect(db.select().from(blobs).all()).toHaveLength(0);
		expect(catalog.getBudget()?.reservedBytes).toBe(3);
		sqlite.exec("DROP TRIGGER fail_blob;");
		lease.release({ ref: refFor(), published: true });
		expect(catalog.getBudget()).toMatchObject({ usedBytes: 3, reservedBytes: 0 });
	});

	test("a failed recovery marker does not fake a refund or delete any reservation", () => {
		ready();
		const lease = reserve();
		sqlite.exec(
			`CREATE TRIGGER fail_release BEFORE UPDATE ON file_change_blob_reservations BEGIN SELECT RAISE(ABORT, 'reservation-fault'); END;`,
		);
		expect(() => lease.release({ ref: refFor(), published: true })).toThrow(AggregateError);
		expect(reservation(lease)).toMatchObject({ status: "reserved", published: null });
		expect(catalog.getBudget()).toMatchObject({ usedBytes: 0, reservedBytes: 3 });
	});

	test("a lost post-commit response is safe to replay", () => {
		ready();
		const lease = reserve();
		const original = db.transaction.bind(db);
		let transactions = 0;
		const spy = spyOn(db, "transaction").mockImplementation((callback, config) => {
			const result = original(callback, config);
			if (++transactions === 2) throw new Error("response-lost-after-commit");
			return result;
		});
		try {
			expect(() => lease.release({ ref: refFor(), published: true })).toThrow(
				"response-lost-after-commit",
			);
		} finally {
			spy.mockRestore();
		}
		expect(reservation(lease)?.status).toBe("settled");
		lease.release({ ref: refFor(), published: true });
		expect(catalog.getBudget()).toMatchObject({ usedBytes: 3, reservedBytes: 0 });
	});

	test("another publisher can complete a pending same-hash intent without double billing", () => {
		ready();
		const a = reserve();
		const b = reserve();
		stopSettlement();
		expect(() => a.release({ ref: refFor(), published: true })).toThrow();
		sqlite.exec("DROP TRIGGER fail_settlement;");
		b.release({ ref: refFor(), published: false });
		expect(catalog.getBudget()).toMatchObject({ usedBytes: 3, reservedBytes: 3 });
		a.release({ ref: refFor(), published: true });
		expect(catalog.getBudget()).toMatchObject({ usedBytes: 3, reservedBytes: 0 });
	});

	test("mismatched reference size, hash, and relative key retain the reservation", () => {
		ready();
		const lease = reserve(4);
		expectCode(() => lease.release({ ref: refFor(), published: true }), "size_mismatch");
		expect(reservation(lease)?.status).toBe("reconcile_required");
		expect(catalog.getBudget()?.reservedBytes).toBe(4);
		const good = reserve();
		good.release({ ref: refFor(), published: true });
		const hashMismatch = reserve(4);
		expectCode(
			() => hashMismatch.release({ ref: { ...refFor(), sizeBytes: 4 }, published: false }),
			"catalog_mismatch",
		);
		db.update(blobs)
			.set({ storageKey: "../outside" })
			.where(eq(blobs.digest, refFor().digest))
			.run();
		const keyMismatch = reserve();
		expectCode(() => keyMismatch.release({ ref: refFor(), published: false }), "catalog_mismatch");
		expectCode(
			() => catalog.getMetadata({ expectedGeneration: generation, ref: refFor() }),
			"catalog_mismatch",
		);
	});

	test("strict refs reject invalid hashes, extra payloads, prototypes and accessors", () => {
		ready();
		const invalid = [
			{ ...refFor(), digest: "A".repeat(64) },
			{ ...refFor(), digest: `${"a".repeat(64)}\n` },
			{ ...refFor(), algorithm: "sha1" },
			{ ...refFor(), sizeBytes: -1 },
			{ ...refFor(), sizeBytes: FILE_CHANGE_LIMITS.blobBytes + 1 },
			{ ...refFor(), bytes: "body-must-not-enter-db" },
			Object.assign(Object.create({ hidden: true }), refFor()),
			Object.defineProperty({ ...refFor() }, "digest", {
				get: () => {
					throw new Error("accessor ran");
				},
			}),
		];
		for (const ref of invalid) {
			const lease = reserve();
			expectCode(
				() => lease.release({ ref: ref as FileChangeBlobRef, published: true }),
				"invalid_ref",
			);
			expect(reservation(lease)?.status).toBe("reconcile_required");
		}
		expect(db.select().from(blobs).all()).toHaveLength(0);
	});
});

describe("explicit maintenance and generation fencing", () => {
	test("initialization and worker commits must use the exact current generation", () => {
		ready();
		expectCode(() => catalog.initializeNamespace({ expectedGeneration: 0 }), "generation_mismatch");
		expectCode(() => catalog.beginReconciliation({ expectedGeneration: 0 }), "generation_mismatch");
		restartReconciliation();
		expectCode(
			() =>
				catalog.completeReconciliation({
					expectedGeneration: generation - 1,
					verifiedUsedBytes: 0,
					verification,
				}),
			"generation_mismatch",
		);
		expectCode(
			() =>
				catalog.reconcileBlob({
					expectedGeneration: generation - 1,
					ref: refFor(),
					physicalState: "verified",
				}),
			"generation_mismatch",
		);
		expect(catalog.getBudget()?.status).toBe("reconciling");
	});

	test("fencing preserves in-flight bytes and only terminal proof can resolve an old owner", () => {
		ready();
		const lease = reserve();
		restartReconciliation();
		expectCode(() => lease.release(emptyRelease), "generation_mismatch");
		expect(reservation(lease)?.status).toBe("reserved");
		expectCode(
			() =>
				catalog.completeReconciliation({
					expectedGeneration: generation,
					verifiedUsedBytes: 0,
					verification,
				}),
			"reconciliation_required",
		);
		expectCode(
			() =>
				catalog.reconcileReservation({
					...lease,
					expectedGeneration: generation,
					result: emptyRelease,
					verification: {
						...terminalVerification,
						ownerStopped: false,
					} as unknown as typeof terminalVerification,
				}),
			"invalid_input",
		);
		catalog.reconcileReservation({
			...lease,
			expectedGeneration: generation,
			result: emptyRelease,
			verification: terminalVerification,
		});
		catalog.reconcileReservation({
			...lease,
			expectedGeneration: generation,
			result: emptyRelease,
			verification: terminalVerification,
		});
		catalog.completeReconciliation({
			expectedGeneration: generation,
			verifiedUsedBytes: 0,
			verification,
		});
		expect(catalog.getBudget()).toMatchObject({ usedBytes: 0, reservedBytes: 0, status: "ready" });
		expectCode(
			() => catalog.retryRelease({ ...lease, generation }, emptyRelease),
			"generation_mismatch",
		);
	});

	test("zero-byte crash reservations also block completion and cannot be guessed away", () => {
		ready();
		const lease = reserve(0);
		restartReconciliation();
		expect(catalog.getBudget()?.reservedBytes).toBe(0);
		expectCode(
			() =>
				catalog.completeReconciliation({
					expectedGeneration: generation,
					verifiedUsedBytes: 0,
					verification,
				}),
			"reconciliation_required",
		);
		expect(reservation(lease)?.status).toBe("reserved");
	});

	test("published unresolved reservations cannot be reconciled as unpublished failures", () => {
		ready();
		const lease = reserve();
		stopSettlement();
		expect(() => lease.release({ ref: refFor(), published: true })).toThrow();
		sqlite.exec("DROP TRIGGER fail_settlement;");
		restartReconciliation();
		expectCode(
			() =>
				catalog.reconcileReservation({
					...lease,
					expectedGeneration: generation,
					result: emptyRelease,
					verification: terminalVerification,
				}),
			"release_conflict",
		);
		catalog.reconcileReservation({
			...lease,
			expectedGeneration: generation,
			result: { ref: refFor(), published: true },
			verification: terminalVerification,
		});
		catalog.completeReconciliation({
			expectedGeneration: generation,
			verifiedUsedBytes: 3,
			verification,
		});
		expect(catalog.getBudget()).toMatchObject({ usedBytes: 3, reservedBytes: 0, status: "ready" });
	});

	test("old ready/missing/expired metadata cannot bypass namespace verification or resurrect evidence", () => {
		ready();
		reserve().release({ ref: refFor(), published: true });
		restartReconciliation();
		expectCode(
			() => catalog.getMetadata({ expectedGeneration: generation, ref: refFor() }),
			"namespace_unverified",
		);
		catalog.reconcileBlob({
			expectedGeneration: generation,
			ref: refFor(),
			physicalState: "missing",
		});
		catalog.completeReconciliation({
			expectedGeneration: generation,
			verifiedUsedBytes: 0,
			verification,
		});
		const lease = reserve();
		expectCode(() => lease.release({ ref: refFor(), published: true }), "reconciliation_required");
		expect(catalog.getMetadata({ expectedGeneration: generation, ref: refFor() })?.status).toBe(
			"missing",
		);
		expect(catalog.getBudget()?.reservedBytes).toBe(3);
		db.update(blobs).set({ status: "expired" }).where(eq(blobs.digest, refFor().digest)).run();
		restartReconciliation();
		expect(
			catalog.reconcileBlob({
				expectedGeneration: generation,
				ref: refFor(),
				physicalState: "verified",
			}).status,
		).toBe("expired");
	});

	test("a counter mismatch is retained for investigation, never overwritten with zero", () => {
		ready();
		db.update(budgets)
			.set({ reservedBytes: 7 })
			.where(eq(budgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
			.run();
		restartReconciliation();
		expectCode(
			() =>
				catalog.completeReconciliation({
					expectedGeneration: generation,
					verifiedUsedBytes: 0,
					verification,
				}),
			"reconciliation_required",
		);
		expect(catalog.getBudget()?.reservedBytes).toBe(7);
	});

	test("bounded keyset pages preserve all old owners without TTL release", () => {
		ready(1000);
		const leases = Array.from({ length: 205 }, () => reserve(1, "dead-owner"));
		db.update(reservations).set({ createdAt: "2000-01-01T00:00:00.000Z" }).run();
		const seen = new Set<string>();
		let cursor: { createdAt: string; id: string } | undefined;
		for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
			const page = catalog.listReservations({
				expectedGeneration: generation,
				status: "reserved",
				after: cursor,
			});
			expect(page.items.length).toBeLessThanOrEqual(FILE_CHANGE_LIMITS.historyPageItems);
			for (const row of page.items) seen.add(row.id);
			cursor = page.nextCursor ?? undefined;
		}
		expect(cursor).toBeUndefined();
		expect(seen.size).toBe(leases.length);
		expect(catalog.getBudget()?.reservedBytes).toBe(205);
		expectCode(
			() =>
				catalog.listReservations({
					expectedGeneration: generation,
					status: "reserved",
					limit: 101,
				}),
			"invalid_input",
		);
		const query = queries.filter((value) => value.includes("order by")).at(-1);
		expect(query).toContain(
			'("file_change_blob_reservations"."created_at", "file_change_blob_reservations"."id") >',
		);
		const plan = sqlite
			.query<{ detail: string }, [string, string, string, string]>(
				`EXPLAIN QUERY PLAN SELECT * FROM file_change_blob_reservations WHERE budget_id=? AND status=? AND (created_at,id) > (?,?) ORDER BY created_at,id LIMIT 101`,
			)
			.all(FILE_CHANGE_BLOB_BUDGET_ID, "reserved", "2000-01-01T00:00:00.000Z", "a");
		expect(plan.some((row) => row.detail.includes("idx_fc_reservation_budget"))).toBe(true);
		expect(
			plan.some((row) => row.detail.includes("TEMP B-TREE") || row.detail.startsWith("SCAN")),
		).toBe(false);
	});

	test("post-publication SQL failure survives a process-style reopen for explicit worker settlement", () => {
		const path = join(sandbox, "crashed-publication.db");
		const first = connection(path);
		first.exec(DDL);
		const a = new FileChangeBlobCatalog({ db: drizzle(first), namespaceKey });
		a.initializeNamespace({ expectedGeneration: null, quotaBytes: 10 });
		a.beginReconciliation({ expectedGeneration: 0 });
		a.completeReconciliation({ expectedGeneration: 1, verifiedUsedBytes: 0, verification });
		const lease = a.reserve({
			expectedGeneration: 1,
			ownerEpoch: "crashed",
			expectedSize: 3,
			signal: new AbortController().signal,
		});
		first.exec(
			`CREATE TRIGGER crash_finalize BEFORE UPDATE OF status ON file_change_blob_reservations WHEN NEW.status = 'settled' BEGIN SELECT RAISE(ABORT, 'crash-finalize'); END;`,
		);
		expect(() => lease.release({ ref: refFor(), published: true })).toThrow();
		first.close();
		const reopened = connection(path);
		extraConnections.push(reopened);
		const b = new FileChangeBlobCatalog({ db: drizzle(reopened), namespaceKey });
		const initialized = b.initializeNamespace({ expectedGeneration: 1 });
		expect(initialized).toMatchObject({ usedBytes: 0, reservedBytes: 3, status: "unverified" });
		const pending = b.listReservations({
			expectedGeneration: initialized.generation,
			status: "reconcile_required",
		});
		expect(pending.items[0]).toMatchObject({
			id: lease.reservationId,
			blobDigest: refFor().digest,
			published: true,
			generation: 1,
		});
		const reconciling = b.beginReconciliation({ expectedGeneration: initialized.generation });
		reopened.exec("DROP TRIGGER crash_finalize;");
		b.reconcileReservation({
			...lease,
			expectedGeneration: reconciling.generation,
			result: { ref: refFor(), published: true },
			verification: terminalVerification,
		});
		b.completeReconciliation({
			expectedGeneration: reconciling.generation,
			verifiedUsedBytes: 3,
			verification,
		});
		expect(b.getBudget()).toMatchObject({ usedBytes: 3, reservedBytes: 0, status: "ready" });
		expectCode(
			() => b.retryRelease(lease, { ref: refFor(), published: true }),
			"generation_mismatch",
		);
	});

	test("unfinished reservations survive close/reopen and startup does not clear them", () => {
		const path = join(sandbox, "isolated-catalog.db");
		const first = connection(path);
		first.exec(DDL);
		const a = new FileChangeBlobCatalog({ db: drizzle(first), namespaceKey });
		a.initializeNamespace({ expectedGeneration: null, quotaBytes: 10 });
		a.beginReconciliation({ expectedGeneration: 0 });
		a.completeReconciliation({ expectedGeneration: 1, verifiedUsedBytes: 0, verification });
		a.reserve({
			expectedGeneration: 1,
			ownerEpoch: "crashed-epoch",
			expectedSize: 6,
			signal: new AbortController().signal,
		});
		first.close();
		const reopened = connection(path);
		extraConnections.push(reopened);
		const b = new FileChangeBlobCatalog({ db: drizzle(reopened), namespaceKey });
		const initialized = b.initializeNamespace({ expectedGeneration: 1 });
		expect(initialized).toMatchObject({ reservedBytes: 6, usedBytes: 0, status: "unverified" });
		const rows = b.listReservations({
			expectedGeneration: initialized.generation,
			status: "reserved",
		});
		expect(rows.items).toHaveLength(1);
		expect(rows.items[0]).toMatchObject({
			ownerEpoch: "crashed-epoch",
			expectedSize: 6,
			status: "reserved",
		});
	});
});

describe("real low-level store integration in an isolated directory", () => {
	function store(
		admission = catalog.admission({ expectedGeneration: generation, ownerEpoch: "store-writer" }),
	) {
		return new FileChangeBlobStore({
			root: join(sandbox, "blobs"),
			minimumFreeBytes: 0,
			admission,
		});
	}

	test("concurrent puts enforce quota before writing, then verified dedup charges once", async () => {
		ready(10);
		const physical = store();
		const attempts = await Promise.allSettled(
			["aaaaaa", "bbbbbb"].map((text) => physical.putBytes(Buffer.from(text), { expectedSize: 6 })),
		);
		expect(attempts.filter((value) => value.status === "fulfilled")).toHaveLength(1);
		expect(attempts.filter((value) => value.status === "rejected")).toHaveLength(1);
		expect(catalog.getBudget()).toMatchObject({ usedBytes: 6, reservedBytes: 0 });
		const small = Buffer.from("abc");
		const ref = await physical.putBytes(small, { expectedSize: small.length });
		expect(catalog.getBudget()?.usedBytes).toBe(9);
		// Admission also budgets dedup's temporary bytes; it cannot assume a hash is present.
		await expect(physical.putBytes(small, { expectedSize: small.length })).rejects.toMatchObject({
			code: "quota_exceeded",
		});
		expect(await physical.readBytes(ref)).toEqual(new Uint8Array(small));
	});

	test("successful store callbacks and hash mismatch failures settle correctly", async () => {
		ready();
		const physical = store();
		const bytes = Buffer.from("binary\0\r\n");
		const first = await physical.putBytes(bytes, { expectedSize: bytes.length });
		const duplicate = await physical.putBytes(bytes, { expectedSize: bytes.length });
		expect(duplicate).toEqual(first);
		expect(catalog.getBudget()).toMatchObject({ usedBytes: bytes.length, reservedBytes: 0 });
		await expect(
			physical.putBytes(bytes, { expectedSize: bytes.length, expectedDigest: "f".repeat(64) }),
		).rejects.toMatchObject({ code: "hash_mismatch" });
		expect(catalog.getBudget()).toMatchObject({ usedBytes: bytes.length, reservedBytes: 0 });
	});

	test("post-publication SQL failure leaves physical bytes plus a retryable reservation", async () => {
		ready();
		let captured: { lease: FileChangeBlobCatalogLease; result: FileChangeBlobRelease } | undefined;
		const physical = store({
			reserve: ({ expectedSize, signal }) => {
				const lease = catalog.reserve({
					expectedGeneration: generation,
					ownerEpoch: "captured",
					expectedSize,
					signal,
				});
				return {
					release: (result) => {
						captured = { lease, result };
						return lease.release(result);
					},
				};
			},
		});
		stopSettlement();
		const bytes = Buffer.from("abc");
		await expect(physical.putBytes(bytes, { expectedSize: bytes.length })).rejects.toBeInstanceOf(
			AggregateError,
		);
		if (!captured?.result.ref) throw new Error("Missing published release receipt");
		expect(captured.result.published).toBe(true);
		const ref = captured.result.ref;
		expect(
			await readFile(join(sandbox, "blobs", "sha256", ref.digest.slice(0, 2), ref.digest)),
		).toEqual(bytes);
		expect(reservation(captured.lease)?.status).toBe("reconcile_required");
		expect(catalog.getBudget()).toMatchObject({ usedBytes: 0, reservedBytes: bytes.length });
		sqlite.exec("DROP TRIGGER fail_settlement;");
		captured.lease.release(captured.result);
		expect(catalog.getBudget()).toMatchObject({ usedBytes: bytes.length, reservedBytes: 0 });
		expect(await physical.readBytes(ref)).toEqual(new Uint8Array(bytes));
	});
});
