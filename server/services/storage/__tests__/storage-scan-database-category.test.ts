/**
 * How the storage scan reports the database category, including when it cannot be measured.
 *
 * The scan is the only consumer of {@link DatabaseStoragePort}, and the interesting behaviour is
 * at the failure boundary:
 *
 *   - a backend that cannot measure produces an `unavailable` category and is EXCLUDED from the
 *     total. Contributing its placeholder zero would be arithmetically harmless and semantically
 *     wrong — the sum would read as complete while a whole category was missing from it, which is
 *     precisely the "5.3 GB database weighs nothing" report the port's error type exists to
 *     prevent;
 *   - a partially-readable database still yields its file size (that number is exact) but marks
 *     the scan as truncated, so a total is presented as a lower bound;
 *   - a cancellation surfaces as `StorageScanAbortedError`, which is what `storage-scan-job`
 *     already distinguishes from a failure;
 *   - a genuine failure still propagates. Degrading everything into "unavailable" would hide real
 *     breakage behind a tidy UI state.
 *
 * The port is replaced through `mock.module` so these paths are reachable without a broken
 * database: today's SQLite adapter can never take them, which is exactly why they need pinning.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
	DatabaseStoragePort,
	DatabaseStorageReport,
	DatabaseStorageScanOptions,
} from "../database-storage-port";
import {
	DatabaseStorageScanCancelledError,
	DatabaseStorageUnsupportedError,
} from "../database-storage-port";

/** Behaviour the stub port should exhibit for the next scan. */
let scanBehaviour: (options: DatabaseStorageScanOptions) => Promise<DatabaseStorageReport> =
	async () => ({
		sizeBytes: 4_096,
		details: { scanMode: "approximate" },
		incomplete: false,
	});

let capabilityBreakdown = true;

/** How many times the scan actually asked the backend to measure. */
let scanCalls = 0;
/** How many times the scan read the backend's capabilities. */
let capabilityReads = 0;

const stubPort: DatabaseStoragePort = {
	get capabilities() {
		capabilityReads += 1;
		return {
			backend: "stub",
			breakdown: capabilityBreakdown,
			freeSpaceAccounting: false,
			cleanupCandidates: false,
			offRequestThreadScan: false,
		};
	},
	scanBreakdown: (options = {}) => {
		scanCalls += 1;
		return scanBehaviour(options);
	},
};

const realStore = { ...(await import("../store")) };
// Keyed by this file's own specifier: `mock.module` resolves to an absolute path, so the storage
// service's `./storage/store` import is the same module and is intercepted too.
mock.module("../store", () => ({ databaseStoragePort: stubPort }));

const { scanStorage, StorageScanAbortedError, invalidateStorageCache } = await import(
	"../../storage-service"
);

afterAll(() => {
	mock.module("../store", () => realStore);
	mock.restore();
});

/** Drive the generator to completion and return the scan result. */
async function runScan(signal?: AbortSignal) {
	const scan = scanStorage(signal ? { signal } : {});
	let next = await scan.next();
	while (!next.done) next = await scan.next();
	return next.value;
}

function databaseCategory(result: Awaited<ReturnType<typeof runScan>>) {
	return result.categories.find((category) => category.key === "database");
}

beforeEach(() => {
	capabilityBreakdown = true;
	scanCalls = 0;
	capabilityReads = 0;
	scanBehaviour = async () => ({
		sizeBytes: 4_096,
		details: { scanMode: "approximate" },
		incomplete: false,
	});
	invalidateStorageCache();
});

describe("the database category in a storage scan", () => {
	test("carries the port's total and detail when the backend can measure", async () => {
		scanBehaviour = async () => ({
			sizeBytes: 12_345,
			details: { scanMode: "approximate", pageSize: 4_096 },
			incomplete: false,
		});

		const category = databaseCategory(await runScan());

		expect(category?.sizeBytes).toBe(12_345);
		expect(category?.details).toEqual({ scanMode: "approximate", pageSize: 4_096 });
		expect(category?.unavailable).toBeUndefined();
		expect(category?.truncated).toBeUndefined();
	}, 120_000);

	test("marks an incomplete measurement as truncated so the total reads as a lower bound", async () => {
		scanBehaviour = async () => ({
			sizeBytes: 12_345,
			// Zeroes in an incomplete report are UNKNOWNS. The category must say so, or the storage
			// page presents a partial measurement as a clean result.
			details: { readFailures: { tableCount: 3, tableNames: ["a", "b", "c"] } },
			incomplete: true,
		});

		const result = await runScan();

		expect(databaseCategory(result)?.truncated).toBe(true);
		expect(result.truncated).toBe(true);
	}, 120_000);

	test("an unsupported backend becomes an explicit unavailable category, not a zero", async () => {
		capabilityBreakdown = false;
		scanBehaviour = async () => {
			throw new DatabaseStorageUnsupportedError("stub", "breakdown");
		};

		const category = databaseCategory(await runScan());

		// The distinction that matters: `sizeBytes` is 0 here, but `unavailable` is what tells a
		// caller the number is meaningless rather than a measurement of an empty database.
		expect(category).toBeDefined();
		expect(category?.unavailable).toEqual({ backend: "stub", reason: "breakdown" });
	}, 120_000);

	test("reads the capability and skips the call when the backend cannot measure", async () => {
		// What makes `capabilities` load-bearing rather than decorative: the scan must not ask a
		// backend that has declared it cannot answer. The port only promises such a call rejects, so
		// making it would spend a scan step on the request path to obtain a rejection already known.
		capabilityBreakdown = false;
		scanBehaviour = async () => {
			throw new Error("scanBreakdown must not be called when breakdown is false");
		};

		const category = databaseCategory(await runScan());

		expect(capabilityReads).toBeGreaterThan(0);
		expect(scanCalls).toBe(0);
		expect(category?.unavailable).toEqual({ backend: "stub", reason: "breakdown" });
	}, 120_000);

	test("still handles a rejection from a backend whose capability was true when checked", async () => {
		// Capabilities are read at ACCESS time, so a flag that was true at the check can be false by
		// the time the call runs (the SQLite adapter loses `offRequestThreadScan` exactly that way
		// when the worker pool is torn down mid-scan). The check is therefore an optimisation, never
		// a reason to stop handling the rejection.
		capabilityBreakdown = true;
		scanBehaviour = async () => {
			throw new DatabaseStorageUnsupportedError("stub", "breakdown");
		};

		const category = databaseCategory(await runScan());

		expect(scanCalls).toBe(1);
		expect(category?.unavailable).toEqual({ backend: "stub", reason: "breakdown" });
	}, 120_000);

	test("an unavailable category is excluded from the total and makes it a lower bound", async () => {
		capabilityBreakdown = false;
		scanBehaviour = async () => {
			throw new DatabaseStorageUnsupportedError("stub", "breakdown");
		};

		const result = await runScan();
		const measured = result.categories
			.filter((category) => !category.unavailable)
			.reduce((sum, category) => sum + category.sizeBytes, 0);

		expect(result.totalBytes).toBe(measured);
		// A sum missing a whole category must not present itself as complete.
		expect(result.truncated).toBe(true);
	}, 120_000);

	test("a cancellation surfaces as the scan's own abort error", async () => {
		const controller = new AbortController();
		scanBehaviour = async () => {
			controller.abort();
			throw new DatabaseStorageScanCancelledError();
		};

		// `storage-scan-job` keys its `cancelled` vs `error` states on this type, so a cancellation
		// arriving as anything else would be published to the UI as a failed scan.
		await expect(runScan(controller.signal)).rejects.toBeInstanceOf(StorageScanAbortedError);
	}, 120_000);

	test("a genuine backend failure still propagates", async () => {
		scanBehaviour = async () => {
			throw new Error("disk I/O error while reading page 42");
		};

		// Degrading every failure into "unavailable" would hide real breakage behind a tidy UI
		// state; an unreadable database is a problem to report, not to paper over.
		await expect(runScan()).rejects.toThrow(/disk I\/O error/);
	}, 120_000);
});
