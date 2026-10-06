/**
 * How `databaseCleanupService` behaves when engine-level maintenance is unavailable, fails, or
 * conflicts — i.e. the boundary between the product's retention policy and the storage engine.
 *
 * WHY THIS IS TESTED THROUGH A STUB PORT
 * -------------------------------------
 * The real `vacuumDatabase()` terminates the read-worker pool and rewrites the whole database file
 * while holding an exclusive lock. That is an admin-confirmed, service-wide maintenance window; a
 * test may not trigger one. What IS worth pinning is everything around it, and all of it is
 * observable with an injected maintenance port:
 *
 *   - an ABSENT capability and a FAILED attempt must not collapse into the same answer. A backend
 *     that cannot reclaim space gets 501 (valid request, no such capability — retrying is pointless);
 *     a rewrite that lost a lock race gets 409 (retryable); anything else gets 500.
 *   - `checkpointRan` / `optimized` must mean "it actually ran". The port reports a failed
 *     best-effort step as `supported: true, ok: false`, so reading only `supported` would tell the
 *     operator the WAL was flushed when it was not.
 *   - the freelist numbers in the report must come from the measurement, not from a default. A
 *     silent `0` reads as "nothing to reclaim", which is a confident answer that happens to be made
 *     up.
 *   - the ROW-cleanup path must never reach space reclamation. It runs inside an HTTP request, where
 *     a full-file rewrite would freeze the main thread; `vacuumRan: false` is the contract.
 *
 * `mock.module` is process-wide and `mock.restore()` does not undo it, so the real module is
 * snapshotted and re-pointed in `afterAll`, exactly as the sibling retention suite does. The
 * database here is the shared in-memory schema; no real file is touched by the maintenance stub.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
	CheckpointRequest,
	DatabaseMaintenancePort,
	MaintenanceFailure,
	ReusableSpaceReport,
} from "@server/db/backend";
import { notApplicable, supported, supportedVoid } from "@server/db/backend";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();

interface StubBehaviour {
	checkpointOk: boolean;
	optimizeOk: boolean;
	space: ReusableSpaceReport | "unsupported";
	reclaim: "ok" | "unsupported" | { throws: Error };
}

const behaviour: StubBehaviour = {
	checkpointOk: true,
	optimizeOk: true,
	space: { pageSize: 4096, pageCount: 100, freelistBytes: 40_960 },
	reclaim: "ok",
};

const calls: string[] = [];
/** `mainBytes` values the service passed to the measurement, in order. */
const measuredWith: number[] = [];

/** Records what the service asked for, and answers exactly what the current test needs. */
const stubMaintenance: DatabaseMaintenancePort = {
	backendId: "stub",
	checkpoint(request: CheckpointRequest) {
		calls.push(`checkpoint:${request.truncate ? "truncate" : "passive"}`);
		return supported({ ok: behaviour.checkpointOk });
	},
	refreshPlannerStatistics() {
		calls.push("optimize");
		return supported({ ok: behaviour.optimizeOk });
	},
	measureReusableSpace(mainBytes: number) {
		// The byte count is recorded separately, not in the call label: it is the isolated home's real
		// file size, so baking it into the expected sequence would make the ORDER assertion depend on
		// an unrelated number and fail whenever the test home's database changes size.
		measuredWith.push(mainBytes);
		calls.push("measure");
		if (behaviour.space === "unsupported") {
			return notApplicable("a server-managed engine exposes no page freelist");
		}
		return supported(behaviour.space);
	},
	reclaimSpace() {
		calls.push("reclaim");
		if (behaviour.reclaim === "unsupported") {
			return notApplicable("a server-managed engine reclaims space online");
		}
		if (typeof behaviour.reclaim === "object") throw behaviour.reclaim.throws;
		return supportedVoid();
	},
	classifyFailure(error: unknown): MaintenanceFailure {
		const message = String(error);
		return { kind: /locked|BUSY/i.test(message) ? "conflict" : "error", message };
	},
};

const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({
	...realDbModule,
	db,
	sqlite,
	databaseMaintenance: stubMaintenance,
}));

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

const { databaseCleanupService } = await import("../database-cleanup-service");

function resetBehaviour(): void {
	behaviour.checkpointOk = true;
	behaviour.optimizeOk = true;
	behaviour.space = { pageSize: 4096, pageCount: 100, freelistBytes: 40_960 };
	behaviour.reclaim = "ok";
	calls.length = 0;
	measuredWith.length = 0;
}

beforeEach(() => {
	cleanDb(sqlite);
	resetBehaviour();
});

/** Await a rejection and return it, so the status/code can be asserted. */
async function rejection(promise: Promise<unknown>): Promise<{ statusCode: number; code: string }> {
	try {
		await promise;
	} catch (error) {
		const failure = error as { statusCode?: number; code?: string };
		return { statusCode: failure.statusCode ?? 0, code: failure.code ?? "" };
	}
	throw new Error("expected the operation to reject");
}

describe("space reclamation dispatch", () => {
	test("reports the measured freelist on both sides of the window", async () => {
		behaviour.space = { pageSize: 8192, pageCount: 64, freelistBytes: 123_456 };
		const result = await databaseCleanupService.vacuumDatabase();

		expect(result.ok).toBe(true);
		expect(result.vacuumRan).toBe(true);
		// Straight from the measurement — not a default that happens to look plausible.
		expect(result.freelistBeforeBytes).toBe(123_456);
		expect(result.freelistAfterBytes).toBe(123_456);
		expect(result.checkpointRan).toBe(true);
		expect(result.optimized).toBe(true);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);

		// The order that makes the numbers meaningful: truncate before, rewrite, optimize, truncate
		// after. A missing trailing checkpoint would leave the rewrite in the WAL, so the "after" file
		// size would understate what was actually reclaimed.
		expect(calls).toEqual([
			"measure",
			"checkpoint:truncate",
			"reclaim",
			"optimize",
			"checkpoint:truncate",
			"measure",
		]);
		// Both measurements were handed a real file size rather than a placeholder: the port clamps
		// its page arithmetic against it, so passing 0 would silently disable that clamp.
		expect(measuredWith).toHaveLength(2);
		for (const bytes of measuredWith) expect(bytes).toBeGreaterThan(0);
	});

	test("an unavailable capability is 501, not a fabricated success", async () => {
		behaviour.reclaim = "unsupported";
		const failure = await rejection(databaseCleanupService.vacuumDatabase());
		// 501: the request was valid and there is nothing to retry. Reporting `ok: true, freedBytes: 0`
		// would tell the operator the window ran and found nothing.
		expect(failure.statusCode).toBe(501);
		expect(failure.code).toBe("DATABASE_VACUUM_UNSUPPORTED");
	});

	test("a lock conflict is 409 and a genuine error is 500", async () => {
		behaviour.reclaim = { throws: new Error("SQLITE_BUSY: database is locked") };
		const conflict = await rejection(databaseCleanupService.vacuumDatabase());
		expect(conflict.statusCode).toBe(409);
		expect(conflict.code).toBe("DATABASE_VACUUM_FAILED");

		resetBehaviour();
		behaviour.reclaim = { throws: new Error("disk I/O error") };
		const broken = await rejection(databaseCleanupService.vacuumDatabase());
		expect(broken.statusCode).toBe(500);
		expect(broken.code).toBe("DATABASE_VACUUM_FAILED");
	});

	test("an unmeasurable freelist refuses rather than reporting zero", async () => {
		behaviour.space = "unsupported";
		const failure = await rejection(databaseCleanupService.vacuumDatabase());
		expect(failure.statusCode).toBe(501);
		expect(failure.code).toBe("DATABASE_SPACE_REPORT_UNSUPPORTED");
		// Refused BEFORE the rewrite: a window whose result cannot be reported is not worth the outage.
		expect(calls).toEqual(["measure"]);
	});

	test("a failed best-effort step is reported as not having run", async () => {
		behaviour.checkpointOk = false;
		behaviour.optimizeOk = false;
		const result = await databaseCleanupService.vacuumDatabase();

		expect(result.vacuumRan).toBe(true);
		// The distinction this pins: the port answered `supported: true, ok: false`. Reading only
		// `supported` would report a checkpoint that threw as one that flushed the WAL.
		expect(result.checkpointRan).toBe(false);
		expect(result.optimized).toBe(false);
	});

	test("one successful checkpoint keeps the flag true even if the other fails", async () => {
		// `checkpointRan` means "a checkpoint ran", matching the pre-refactor field. A later failure
		// must not retract a flush that really happened.
		let call = 0;
		const flaky: DatabaseMaintenancePort = {
			...stubMaintenance,
			checkpoint(request: CheckpointRequest) {
				call++;
				calls.push(`checkpoint:${request.truncate ? "truncate" : "passive"}`);
				return supported({ ok: call === 1 });
			},
		};
		mock.module("../../db", () => ({
			...realDbModule,
			db,
			sqlite,
			databaseMaintenance: flaky,
		}));
		const { databaseCleanupService: service } = await import("../database-cleanup-service");
		try {
			const result = await service.vacuumDatabase();
			expect(result.checkpointRan).toBe(true);
		} finally {
			mock.module("../../db", () => ({
				...realDbModule,
				db,
				sqlite,
				databaseMaintenance: stubMaintenance,
			}));
		}
	});
});

describe("row cleanup never opens a maintenance window", () => {
	test("executeCleanup checkpoints and optimizes but never reclaims space", async () => {
		sqlite
			.prepare(
				`INSERT INTO api_requests (id, created_at, raw_dump_json)
				 VALUES ('req-old', ?, '{"body":"x"}')`,
			)
			.run(new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString());

		const result = await databaseCleanupService.executeCleanup("apiRequestDumps", {
			olderThanDays: 30,
		});

		expect(result.ok).toBe(true);
		expect(result.changed).toBe(true);
		// The contract: this path runs inside an HTTP request, where a full-file rewrite would freeze
		// the main thread. Reclamation is a separate, explicitly confirmed operation.
		expect(result.vacuumRan).toBe(false);
		expect(calls).toContain("checkpoint:passive");
		expect(calls).toContain("optimize");
		expect(calls).not.toContain("reclaim");
	});

	test("a cleanup that changed nothing skips maintenance entirely", async () => {
		const result = await databaseCleanupService.executeCleanup("apiRequestDumps", {
			olderThanDays: 30,
		});
		expect(result.changed).toBe(false);
		expect(result.vacuumRan).toBe(false);
		// No rows changed means nothing to checkpoint or re-analyse; doing it anyway would add a
		// pointless synchronous step to every no-op cleanup.
		expect(calls).toEqual([]);
	});

	test("unavailable best-effort maintenance does not fail the cleanup", async () => {
		// A backend with no WAL still has to be able to delete rows. Degrading quietly is correct
		// here; throwing would take a working feature down over an absent hardening step.
		const noMaintenance: DatabaseMaintenancePort = {
			...stubMaintenance,
			checkpoint() {
				calls.push("checkpoint:unsupported");
				return notApplicable("no WAL to flush");
			},
			refreshPlannerStatistics() {
				calls.push("optimize:unsupported");
				return notApplicable("statistics are maintained by the server");
			},
		};
		mock.module("../../db", () => ({
			...realDbModule,
			db,
			sqlite,
			databaseMaintenance: noMaintenance,
		}));
		const { databaseCleanupService: service } = await import("../database-cleanup-service");
		try {
			sqlite
				.prepare(
					`INSERT INTO api_requests (id, created_at, raw_dump_json)
					 VALUES ('req-old-2', ?, '{"body":"y"}')`,
				)
				.run(new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString());

			const result = await service.executeCleanup("apiRequestDumps", { olderThanDays: 30 });
			expect(result.ok).toBe(true);
			expect(result.changed).toBe(true);
			expect(result.vacuumRan).toBe(false);
			expect(calls).toContain("checkpoint:unsupported");
			expect(calls).toContain("optimize:unsupported");
		} finally {
			mock.module("../../db", () => ({
				...realDbModule,
				db,
				sqlite,
				databaseMaintenance: stubMaintenance,
			}));
		}
	});
});
