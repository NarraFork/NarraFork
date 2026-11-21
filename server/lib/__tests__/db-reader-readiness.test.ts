import { describe, expect, test } from "bun:test";
import {
	createDatabaseReaderReadiness,
	databaseReadersAvailable,
	databaseReaderUnavailableResponse,
	isDatabaseReadUnavailable,
	requiresDatabaseReaders,
} from "../db-reader-readiness";
import {
	DbReadTaskOverloadedError,
	DbReadTaskTimeoutError,
	WorkersUnavailableError,
} from "../db-worker/pool";

describe("database reader readiness", () => {
	test("PostgreSQL never needs the readers and never probes", async () => {
		let probes = 0;
		const readiness = createDatabaseReaderReadiness({
			backend: "postgres",
			probe: async () => {
				probes++;
			},
		});
		expect(await readiness.wait()).toEqual({ status: "not-required" });
		expect(probes).toBe(0);
	});

	test("SQLite probes once at creation and reports ready", async () => {
		let probes = 0;
		const readiness = createDatabaseReaderReadiness({
			backend: "sqlite",
			probe: async () => {
				probes++;
			},
		});
		expect(readiness.state).toEqual({ status: "waiting" });
		expect(await readiness.wait()).toEqual({ status: "ready" });
		await readiness.wait();
		expect(probes).toBe(1);
	});

	test("a failed probe is unavailable and re-probed only after the retry interval", async () => {
		let clock = 0;
		let fail = true;
		let probes = 0;
		const readiness = createDatabaseReaderReadiness({
			backend: "sqlite",
			probe: async () => {
				probes++;
				if (fail) throw new Error("spawn failed");
			},
			retryIntervalMs: 1_000,
			now: () => clock,
		});
		const failed = await readiness.wait();
		expect(failed).toMatchObject({ status: "failed", code: "DB_READERS_UNAVAILABLE" });
		expect(databaseReadersAvailable(failed)).toBe(false);
		await readiness.wait();
		expect(probes).toBe(1);
		fail = false;
		clock = 1_000;
		expect(await readiness.wait()).toEqual({ status: "ready" });
		expect(probes).toBe(2);
	});

	test("a hung probe times out and is aborted", async () => {
		let signal: AbortSignal | undefined;
		const readiness = createDatabaseReaderReadiness({
			backend: "sqlite",
			probe: (options) => {
				signal = options.signal;
				return new Promise(() => {});
			},
			timeoutMs: 20,
		});
		expect(await readiness.wait()).toMatchObject({ status: "failed", code: "DB_READERS_TIMEOUT" });
		expect(signal?.aborted).toBe(true);
	});

	test("a pool disabled after startup turns ready into unavailable", async () => {
		let available = true;
		const readiness = createDatabaseReaderReadiness({
			backend: "sqlite",
			probe: async () => {
				if (!available) throw new Error("disabled");
			},
			availability: () => ({ available, reason: available ? null : "pool_shutdown" }),
		});
		expect(await readiness.wait()).toEqual({ status: "ready" });
		available = false;
		expect(await readiness.wait()).toMatchObject({ status: "failed" });
	});

	test("gates API and WebSocket paths but not liveness or static assets", () => {
		expect(requiresDatabaseReaders("/api/health")).toBe(false);
		expect(requiresDatabaseReaders("/api/auth/me")).toBe(true);
		expect(requiresDatabaseReaders("/ws/external/v1/narrators")).toBe(true);
		expect(requiresDatabaseReaders("/assets/index.js")).toBe(false);
		expect(requiresDatabaseReaders("/")).toBe(false);
	});

	test("unavailable responses are a localizable 503 with Retry-After", async () => {
		const response = databaseReaderUnavailableResponse({
			status: "failed",
			code: "DB_READERS_TIMEOUT",
			reason: "probe exceeded 10000ms",
		});
		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("5");
		expect(await response.json()).toMatchObject({
			code: "DATABASE_READ_UNAVAILABLE",
			messageCode: "DATABASE_READ_UNAVAILABLE",
			details: { databaseReaders: { status: "failed", code: "DB_READERS_TIMEOUT" } },
		});
	});

	test("recognizes short-read pool exhaustion, timeout and unavailability", () => {
		expect(isDatabaseReadUnavailable(new DbReadTaskOverloadedError())).toBe(true);
		expect(isDatabaseReadUnavailable(new DbReadTaskTimeoutError("t"))).toBe(true);
		expect(isDatabaseReadUnavailable(new WorkersUnavailableError("off"))).toBe(true);
		expect(isDatabaseReadUnavailable(new Error("boom"))).toBe(false);
	});
});
