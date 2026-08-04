import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toolContinuationService } from "../tool-continuation-service";
import {
	beginQuiescingTools,
	consumePlannedUpdateRecoverySnapshot,
	getUpdateCoordinationStatus,
	markUpdateRestarting,
	resetUpdateCoordinationForTests,
	scheduleUpdate,
	tryAcquireFinalUpdateExecution,
	waitUntilUpdateGateOpens,
	writePlannedUpdateRecoverySnapshot,
} from "../update-coordinator";
import {
	__getVerifiedDigestComputationCount,
	__resetVerifiedDigestCacheForTests,
	__resolveSameOriginUrlForTests,
	cancelPreparedUpdate,
	checkpointPreparedUpdateFence,
	cleanupOldUpdates,
	failPreparedUpdateAttempt,
	getUpdateDirectory,
	getUpdateStatus,
	isTrustedUpdateServerUrl,
} from "../update-service";

const originalCancelEpoch = toolContinuationService.cancelEpoch;

function scheduleWithManifest(targetVersion: string): string {
	const scheduled = scheduleUpdate(targetVersion);
	if (!scheduled.updateEpoch) throw new Error("Expected scheduled update epoch");
	writePlannedUpdateRecoverySnapshot({
		version: 2,
		updateEpoch: scheduled.updateEpoch,
		targetVersion,
		capturedAt: new Date().toISOString(),
		narrators: [],
	});
	return scheduled.updateEpoch;
}

describe("planned update checkpoint fence", () => {
	test("covers a tool row inserted while the checkpoint query is in flight", async () => {
		const activeToolCallIds = ["tool-a"];
		const coveredToolCallIds = new Set<string>();
		let checkpointCalls = 0;
		let activeQueries = 0;
		const snapshot = {
			version: 2 as const,
			updateEpoch: "race-epoch",
			targetVersion: "2.0.0",
			capturedAt: new Date().toISOString(),
			narrators: [],
		};

		const result = await checkpointPreparedUpdateFence(snapshot.updateEpoch, {
			waitForFence: async () => {},
			checkpoint: async () => {
				checkpointCalls++;
				for (const toolCallId of activeToolCallIds) coveredToolCallIds.add(toolCallId);
				return snapshot;
			},
			listActiveToolCallIds: async () => {
				activeQueries++;
				if (activeQueries === 1) activeToolCallIds.push("tool-raced");
				return [...activeToolCallIds];
			},
			listCoveredToolCallIds: async () => [...coveredToolCallIds],
			verifySendAwaitContinuations: async () => ({ stable: true, unstableToolCallIds: [] }),
		});

		expect(result).toBe(snapshot);
		expect(checkpointCalls).toBe(3);
		expect(coveredToolCallIds).toEqual(new Set(["tool-a", "tool-raced"]));
	});

	for (const settlement of ["reply", "timeout", "abort"] as const) {
		test(`rechecks a Send await that settles by ${settlement} after the first checkpoint`, async () => {
			const snapshot = {
				version: 2 as const,
				updateEpoch: `send-${settlement}-epoch`,
				targetVersion: "2.0.0",
				capturedAt: new Date().toISOString(),
				narrators: [],
			};
			let checkpointCalls = 0;
			let verificationCalls = 0;
			let resultWritten = false;

			await checkpointPreparedUpdateFence(snapshot.updateEpoch, {
				waitForFence: async () => {},
				checkpoint: async () => {
					checkpointCalls++;
					return snapshot;
				},
				listActiveToolCallIds: async () => [],
				listCoveredToolCallIds: async () => ["send-tool"],
				verifySendAwaitContinuations: async () => {
					verificationCalls++;
					if (verificationCalls === 1) {
						// The old process settles immediately after its first durable snapshot. The
						// reverse scan must force another round before replacement spawn is allowed.
						resultWritten = true;
						return { stable: false, unstableToolCallIds: ["send-tool"] };
					}
					return { stable: resultWritten, unstableToolCallIds: [] };
				},
			});

			expect(resultWritten).toBe(true);
			expect(checkpointCalls).toBe(3);
			expect(verificationCalls).toBe(3);
		});
	}
});

describe("update service failure cleanup", () => {
	beforeEach(() => {
		resetUpdateCoordinationForTests();
		toolContinuationService.cancelEpoch = originalCancelEpoch;
	});

	afterEach(() => {
		toolContinuationService.cancelEpoch = originalCancelEpoch;
		resetUpdateCoordinationForTests();
	});

	test("cancels the attempt epoch before deleting recovery evidence and opening the gate", async () => {
		const updateEpoch = scheduleWithManifest("2.0.0");
		const events: string[] = [];
		toolContinuationService.cancelEpoch = async (epoch, error) => {
			events.push(`cancel:${epoch}:${error}`);
			expect(consumePlannedUpdateRecoverySnapshot()?.updateEpoch).toBe(updateEpoch);
			expect(getUpdateCoordinationStatus().scheduled).toBe(true);
			return 2;
		};

		await failPreparedUpdateAttempt({
			updateEpoch,
			targetVersion: "2.0.0",
			error: "spawn failed",
		});

		expect(events).toEqual([`cancel:${updateEpoch}:spawn failed`]);
		expect(consumePlannedUpdateRecoverySnapshot()).toBeNull();
		expect(getUpdateCoordinationStatus()).toMatchObject({
			phase: "idle",
			scheduled: false,
			error: "spawn failed",
		});
	});

	test("preserves the manifest but still reopens the gate when epoch cancellation fails", async () => {
		const scheduled = scheduleUpdate("3.0.0");
		if (!scheduled.updateEpoch) throw new Error("Expected scheduled update epoch");
		beginQuiescingTools();
		toolContinuationService.cancelEpoch = async () => {
			throw new Error("database unavailable");
		};

		// A tool rejected during quiescing is parked behind the gate. If cleanup left the phase
		// frozen, this wait would never settle and every later tool call would join it.
		let resumed = false;
		const paused = waitUntilUpdateGateOpens().then(() => {
			resumed = true;
		});
		await Promise.resolve();
		expect(resumed).toBe(false);

		await failPreparedUpdateAttempt({
			updateEpoch: scheduled.updateEpoch,
			targetVersion: "3.0.0",
			error: "handoff timed out",
		});

		await paused;
		expect(resumed).toBe(true);
		expect(getUpdateCoordinationStatus()).toMatchObject({
			phase: "idle",
			scheduled: false,
			pausedToolCount: 0,
		});
		expect(getUpdateCoordinationStatus().error).toContain("handoff timed out");
		expect(getUpdateCoordinationStatus().error).toContain("database unavailable");
		// New work is admissible again instead of blocking forever.
		const lease = tryAcquireFinalUpdateExecution("ordinary", "narrator-after-failure");
		expect(lease).not.toBeNull();
		lease?.release();
		// Recovery evidence lives in the manifest, not in a stuck coordinator phase.
		expect(consumePlannedUpdateRecoverySnapshot()).toMatchObject({
			version: 2,
			updateEpoch: scheduled.updateEpoch,
			targetVersion: "3.0.0",
		});
	});

	test("a cleanup failure does not strand later tool calls behind the gate", async () => {
		const scheduled = scheduleUpdate("3.1.0");
		if (!scheduled.updateEpoch) throw new Error("Expected scheduled update epoch");
		beginQuiescingTools();
		toolContinuationService.cancelEpoch = async () => {
			throw new Error("database unavailable");
		};

		await failPreparedUpdateAttempt({
			updateEpoch: scheduled.updateEpoch,
			targetVersion: "3.1.0",
			error: "handoff timed out",
		});

		// A tool that arrives after the failed cleanup must not block at all.
		await expect(waitUntilUpdateGateOpens()).resolves.toBeUndefined();
	});

	test("ignores a stale watchdog epoch without cancelling the active attempt", async () => {
		const scheduled = scheduleUpdate("4.0.0");
		let cancelCalls = 0;
		toolContinuationService.cancelEpoch = async () => {
			cancelCalls++;
			return 0;
		};

		await failPreparedUpdateAttempt({
			updateEpoch: "stale-update-epoch",
			targetVersion: "4.0.0",
			error: "old watchdog fired",
		});

		expect(cancelCalls).toBe(0);
		expect(getUpdateCoordinationStatus()).toMatchObject({
			scheduled: true,
			updateEpoch: scheduled.updateEpoch,
		});
	});
});

describe("cancelling a prepared update", () => {
	beforeEach(() => {
		resetUpdateCoordinationForTests();
	});

	afterEach(() => {
		resetUpdateCoordinationForTests();
	});

	test("does nothing when no update is scheduled", () => {
		const result = cancelPreparedUpdate("no update");
		expect(result.cancelled).toBe(false);
		expect(result.status).toMatchObject({ scheduled: false, phase: "idle" });
	});

	test("refuses to cancel once the replacement process has been spawned", () => {
		scheduleUpdate("5.0.0");
		beginQuiescingTools();
		markUpdateRestarting();

		const result = cancelPreparedUpdate("too late");
		// Cancelling here would leave the spawned replacement racing this process for the port and
		// the handoff; the watchdog resolves that case instead.
		expect(result.cancelled).toBe(false);
		expect(result.status).toMatchObject({ phase: "restarting", cancelRequested: false });
	});

	test("cancels while still waiting for narrator work", () => {
		scheduleUpdate("5.1.0");
		const result = cancelPreparedUpdate("operator asked to stop");
		expect(result.cancelled).toBe(true);
		expect(result.status.cancelRequested).toBe(true);
	});
});

describe("update server origin trust", () => {
	test("accepts https and rejects plaintext for a remote host", () => {
		expect(isTrustedUpdateServerUrl("https://narrafork-update.b.domexie.cn")).toBe(true);
		// TLS is the only trust anchor for the payload today, so plaintext would let a man in the
		// middle swap both the metadata and the binary and gain code execution.
		expect(isTrustedUpdateServerUrl("http://narrafork-update.b.domexie.cn")).toBe(false);
	});

	test("allows plaintext loopback for the documented local test server", () => {
		expect(isTrustedUpdateServerUrl("http://127.0.0.1:17780")).toBe(true);
		expect(isTrustedUpdateServerUrl("http://localhost:17780")).toBe(true);
		expect(isTrustedUpdateServerUrl("http://[::1]:17780")).toBe(true);
	});

	test("rejects non-HTTP schemes and unparseable values", () => {
		expect(isTrustedUpdateServerUrl("file:///tmp/evil")).toBe(false);
		expect(isTrustedUpdateServerUrl("ftp://updates.example.com")).toBe(false);
		expect(isTrustedUpdateServerUrl("")).toBe(false);
		expect(isTrustedUpdateServerUrl("not a url")).toBe(false);
	});
});

describe("update payload URL trust", () => {
	const base = "https://updates.example.com";

	test("resolves a relative path against the server origin", () => {
		expect(__resolveSameOriginUrlForTests(base, "/api/v2/patch/x")).toBe(
			"https://updates.example.com/api/v2/patch/x",
		);
	});

	test("neutralizes a userinfo trick instead of retargeting the host", () => {
		// String concatenation would produce https://updates.example.com@evil.com/x, whose real
		// host is evil.com with the update server demoted to userinfo. Resolving against the base
		// keeps it a harmless path on the update server itself.
		expect(__resolveSameOriginUrlForTests(base, "@evil.com/x")).toBe(
			"https://updates.example.com/@evil.com/x",
		);
	});

	test("rejects references that really do leave the server origin", () => {
		expect(__resolveSameOriginUrlForTests(base, "https://evil.com/x")).toBeNull();
		// Scheme downgrade to plaintext is a different origin and must not be followed.
		expect(__resolveSameOriginUrlForTests(base, "http://updates.example.com/x")).toBeNull();
		// Protocol-relative and backslash variants both resolve to another authority.
		expect(__resolveSameOriginUrlForTests(base, "//evil.com/x")).toBeNull();
		expect(__resolveSameOriginUrlForTests(base, "\\\\evil.com/x")).toBeNull();
		expect(__resolveSameOriginUrlForTests(base, "/\\\\evil.com/x")).toBeNull();
	});

	test("accepts an absolute URL on the same origin", () => {
		expect(__resolveSameOriginUrlForTests(base, "https://updates.example.com/a/b")).toBe(
			"https://updates.example.com/a/b",
		);
	});

	test("rejects an unparseable base or candidate", () => {
		expect(__resolveSameOriginUrlForTests("not a url", "/x")).toBeNull();
	});
});

describe("prepared update status hashing", () => {
	const updateDir = getUpdateDirectory();

	beforeEach(() => {
		resetUpdateCoordinationForTests();
		__resetVerifiedDigestCacheForTests();
		rmSync(updateDir, { recursive: true, force: true });
		mkdirSync(updateDir, { recursive: true });
	});

	afterEach(() => {
		resetUpdateCoordinationForTests();
		__resetVerifiedDigestCacheForTests();
		rmSync(updateDir, { recursive: true, force: true });
	});

	function writePlacedUpdate(version: string, bytes: Buffer): void {
		const fileName = `narrafork-${version}`;
		const filePath = join(updateDir, fileName);
		writeFileSync(filePath, bytes);
		const sha512 = new Bun.CryptoHasher("sha512").update(bytes).digest("base64");
		writeFileSync(
			join(updateDir, "placed-update.json"),
			JSON.stringify({
				version,
				// The running process is not a compiled binary under test, so APP_VERSION is the
				// fromVersion that readPlacedUpdateInfo accepts.
				fromVersion: require("../../lib/version").APP_VERSION,
				fileName,
				updatePath: filePath,
				placed: false,
				placedAt: new Date().toISOString(),
				sha512,
				sizeBytes: bytes.length,
			}),
		);
	}

	test("repeated status polls hash the prepared binary only once", async () => {
		writePlacedUpdate("7.0.0", Buffer.alloc(64 * 1024, 7));

		expect((await getUpdateStatus("7.0.0")).ready).toBe(true);
		const afterFirst = __getVerifiedDigestComputationCount();
		expect(afterFirst).toBe(1);

		// The status endpoint is polled about once a second during a drain. Re-hashing a ~100MB
		// binary on every poll would occupy the only JS thread for a large fraction of that second.
		for (let poll = 0; poll < 10; poll++) {
			expect((await getUpdateStatus("7.0.0")).ready).toBe(true);
		}
		expect(__getVerifiedDigestComputationCount()).toBe(afterFirst);
	});

	test("overlapping status polls share one hash of the same file", async () => {
		writePlacedUpdate("7.3.0", Buffer.alloc(64 * 1024, 9));

		// Hashing a ~100MB binary outlasts the one-second poll interval, so the second poll starts
		// while the first is still reading. Both must resolve from a single read.
		const statuses = await Promise.all([
			getUpdateStatus("7.3.0"),
			getUpdateStatus("7.3.0"),
			getUpdateStatus("7.3.0"),
		]);

		for (const status of statuses) expect(status.ready).toBe(true);
		expect(__getVerifiedDigestComputationCount()).toBe(1);
	});

	test("a changed binary invalidates the cached digest and fails verification", async () => {
		const filePath = join(updateDir, "narrafork-7.1.0");
		writePlacedUpdate("7.1.0", Buffer.alloc(32 * 1024, 1));
		expect((await getUpdateStatus("7.1.0")).ready).toBe(true);
		const baseline = __getVerifiedDigestComputationCount();

		// Same size, different content and a newer mtime: the fingerprint must not be reused.
		writeFileSync(filePath, Buffer.alloc(32 * 1024, 2));
		const future = new Date(Date.now() + 5000);
		utimesSync(filePath, future, future);

		expect((await getUpdateStatus("7.1.0")).ready).toBe(false);
		expect(__getVerifiedDigestComputationCount()).toBe(baseline + 1);
	});

	test("a digest mismatch keeps reporting not-ready on later polls", async () => {
		const filePath = join(updateDir, "narrafork-7.4.0");
		writePlacedUpdate("7.4.0", Buffer.alloc(16 * 1024, 4));
		writeFileSync(filePath, Buffer.alloc(16 * 1024, 5));
		const future = new Date(Date.now() + 5000);
		utimesSync(filePath, future, future);

		// A corrupt artifact must stay a failure rather than becoming ready once the digest is
		// cached — the cached value is the wrong hash, not a verification success.
		expect((await getUpdateStatus("7.4.0")).ready).toBe(false);
		expect((await getUpdateStatus("7.4.0")).ready).toBe(false);
	});

	test("an unreadable prepared binary reports not-ready instead of throwing", async () => {
		writePlacedUpdate("7.5.0", Buffer.alloc(4096, 6));
		// The recorded path is validated and stat-ed before hashing, so removing the file after the
		// metadata is written exercises the read-failure path rather than the existence check.
		const status = await getUpdateStatus("7.5.0");
		expect(status.ready).toBe(true);

		rmSync(join(updateDir, "narrafork-7.5.0"), { force: true });
		expect((await getUpdateStatus("7.5.0")).ready).toBe(false);
	});

	test("status reports run instructions for a verified prepared update", async () => {
		writePlacedUpdate("7.2.0", Buffer.alloc(1024, 3));
		const status = await getUpdateStatus("7.2.0");
		expect(status.ready).toBe(true);
		expect(status.instructions?.message).toBeString();
	});
});

describe("update directory cleanup", () => {
	const updateDir = getUpdateDirectory();

	beforeEach(() => {
		rmSync(updateDir, { recursive: true, force: true });
		mkdirSync(updateDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(updateDir, { recursive: true, force: true });
	});

	test("keeps live metadata while removing stale artifacts", () => {
		const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		for (const name of [
			"planned-update-recovery.json",
			"placed-update.json",
			"narrafork-old-binary",
			"narrafork.1234.tmp",
		]) {
			const filePath = join(updateDir, name);
			writeFileSync(filePath, "x");
			utimesSync(filePath, stale, stale);
		}

		cleanupOldUpdates();

		// Deleting the recovery manifest would lose the only record of which narrators to resume;
		// deleting placed-update.json would hide a perfectly good verified binary.
		expect(readdirSync(updateDir).sort()).toEqual([
			"placed-update.json",
			"planned-update-recovery.json",
		]);
	});
});
