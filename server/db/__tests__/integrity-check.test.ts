import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeCleanShutdownState, ensureFts, markCleanShutdown } from "../fts";
import {
	DB_INTEGRITY_REPORT_PREFIX,
	decodeIntegrityReport,
	encodeIntegrityReport,
	type IntegrityProbeReport,
} from "../integrity-protocol";

/**
 * These tests cover the pieces of the background-integrity design that must hold for startup to
 * stay non-blocking AND for a corruption finding to never be lost or retried forever:
 *   - the probe report survives the subprocess stdout round-trip (including noisy output),
 *   - the probe actually runs out-of-process against a real database file, is bounded by its
 *     timeout, and never turns truncated output into a healthy verdict,
 *   - the scheduling decision matrix (clean shutdown / hot reload / marker state / env mode),
 *   - the repair-attempt budget: after it is spent the marker flips to `manual`, automatic repair
 *     stops, and the background probe keeps running so a hand-repaired DB gets un-flagged,
 *   - a marker write failure still logs the corruption,
 *   - cancellation actually tears down the pending timer and the running subprocess,
 *   - ensureFts trusts the caller-supplied clean flag instead of the already-cleared pragma.
 */

const MARKER_FILE = "db-integrity-state.json";

function report(overrides: Partial<IntegrityProbeReport> = {}): IntegrityProbeReport {
	return { status: "ok", mode: "quick", details: "ok", durationMs: 1, ...overrides };
}

describe("integrity report protocol", () => {
	test("round-trips a report through stdout", () => {
		const encoded = encodeIntegrityReport({
			status: "corrupt",
			mode: "quick",
			details: "row 3 missing from index idx_a",
			durationMs: 1234,
		});
		expect(decodeIntegrityReport(`${encoded}\n`)).toEqual({
			status: "corrupt",
			mode: "quick",
			details: "row 3 missing from index idx_a",
			durationMs: 1234,
		});
	});

	test("finds the report even when SQLite or Bun wrote other lines to stdout", () => {
		const stdout = [
			"some unrelated warning",
			encodeIntegrityReport({ status: "ok", mode: "full", details: "ok", durationMs: 7 }),
			"trailing noise",
		].join("\n");
		expect(decodeIntegrityReport(stdout)).toEqual({
			status: "ok",
			mode: "full",
			details: "ok",
			durationMs: 7,
		});
	});

	test("returns null when there is no report or the payload is unusable", () => {
		expect(decodeIntegrityReport("")).toBeNull();
		expect(decodeIntegrityReport("probe crashed before reporting")).toBeNull();
		expect(decodeIntegrityReport(`${DB_INTEGRITY_REPORT_PREFIX}{not json}`)).toBeNull();
		// An unknown status must not be silently coerced into a corruption verdict.
		expect(
			decodeIntegrityReport(`${DB_INTEGRITY_REPORT_PREFIX}{"status":"weird","mode":"quick"}`),
		).toBeNull();
	});
});

describe("integrity probe subprocess", () => {
	let home = "";

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "narrafork-integrity-probe-"));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	async function probeIn(
		narraforkHome: string,
		options: { timeoutMs?: number; command?: string[] } = {},
	) {
		const { runIntegrityProbe } = await import("../integrity-check");
		const previous = process.env.NARRAFORK_HOME;
		process.env.NARRAFORK_HOME = narraforkHome;
		try {
			return await runIntegrityProbe("quick", { timeoutMs: 60_000, ...options });
		} finally {
			if (previous === undefined) delete process.env.NARRAFORK_HOME;
			else process.env.NARRAFORK_HOME = previous;
		}
	}

	function createHealthyDb(): void {
		const db = new Database(join(home, "narrafork.db"));
		db.run("PRAGMA journal_mode = WAL");
		db.run("CREATE TABLE t (a integer primary key, b text)");
		db.run("INSERT INTO t (b) VALUES ('x'), ('y')");
		db.close();
	}

	test("reports ok for a healthy database without blocking this thread", async () => {
		createHealthyDb();
		const report = await probeIn(home);
		expect(report.status).toBe("ok");
		expect(report.mode).toBe("quick");
	}, 90_000);

	test("reports corrupt for a database whose file is not a database", async () => {
		writeFileSync(join(home, "narrafork.db"), "this is definitely not sqlite");
		const report = await probeIn(home);
		// Either the read-only open or the pragma rejects it; both are corruption signals, and
		// neither may be reported as a healthy database.
		expect(report.status === "corrupt" || report.status === "unavailable").toBe(true);
		expect(report.status).not.toBe("ok");
	}, 90_000);

	test("reports unavailable (never ok) when the database file is missing", async () => {
		const report = await probeIn(home);
		expect(report.status).toBe("unavailable");
	}, 30_000);

	test("still finds its entry point when the process cwd is not the repo root", async () => {
		createHealthyDb();
		// The dev probe command used to be a cwd-relative "server/index.ts", so a server started by
		// a service manager (or from a subdirectory) spawned nothing and verification died silently.
		const originalCwd = process.cwd();
		process.chdir(home);
		try {
			const report = await probeIn(home);
			expect(report.status).toBe("ok");
		} finally {
			process.chdir(originalCwd);
		}
	}, 90_000);

	test("kills and reports unavailable when the probe outlives its timeout", async () => {
		createHealthyDb();
		// A probe that never reports: stands in for a multi-GB scan that exceeds PROBE_TIMEOUT_MS.
		const report = await probeIn(home, {
			timeoutMs: 400,
			command: [process.execPath, "-e", "await Bun.sleep(60_000)"],
		});
		expect(report.status).toBe("unavailable");
		expect(report.details).toContain("timed out");
	}, 30_000);

	test("does not report ok when output exceeds the capture cap and the report is cut off", async () => {
		createHealthyDb();
		const { MAX_PROBE_OUTPUT_BYTES } = await import("../integrity-check");
		// Flood stdout past the cap, then emit an `ok` report. Reading stops at the cap, so the
		// report never arrives — the verdict must degrade to inconclusive, never to healthy.
		const script = [
			`const pad = "x".repeat(64 * 1024) + "\\n";`,
			`for (let i = 0; i < ${Math.ceil((MAX_PROBE_OUTPUT_BYTES * 8) / (64 * 1024))}; i++) {`,
			`  process.stdout.write(pad);`,
			`}`,
			`await Bun.sleep(300);`,
			`console.log(${JSON.stringify(encodeIntegrityReport(report({ durationMs: 5 })))});`,
		].join("\n");
		const result = await probeIn(home, {
			timeoutMs: 30_000,
			command: [process.execPath, "-e", script],
		});
		expect(result.status).toBe("unavailable");
		expect(result.status).not.toBe("ok");
	}, 60_000);
});

describe("pending repair marker", () => {
	let home = "";
	let previousHome: string | undefined;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "narrafork-integrity-state-"));
		previousHome = process.env.NARRAFORK_HOME;
		process.env.NARRAFORK_HOME = home;
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
		else process.env.NARRAFORK_HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	});

	test("is absent by default, persists a finding, and clears after repair", async () => {
		const { clearPendingDatabaseRepair, readPendingDatabaseRepair, writePendingDatabaseRepair } =
			await import("../integrity-state");

		expect(readPendingDatabaseRepair()).toBeNull();

		expect(
			writePendingDatabaseRepair({
				mode: "quick",
				details: "malformed database disk image",
				detectedAt: "2026-07-27T00:00:00.000Z",
			}).ok,
		).toBe(true);
		expect(readPendingDatabaseRepair()).toEqual({
			mode: "quick",
			details: "malformed database disk image",
			detectedAt: "2026-07-27T00:00:00.000Z",
			state: "pending",
			attempts: 0,
			lastAttemptAt: null,
		});

		clearPendingDatabaseRepair();
		expect(readPendingDatabaseRepair()).toBeNull();
		// Clearing an already-absent marker must not throw.
		expect(() => clearPendingDatabaseRepair()).not.toThrow();
	});

	test("reads a legacy marker (no state/attempts) as a fresh pending finding", async () => {
		const { readPendingDatabaseRepair, shouldAttemptAutomaticRepair } = await import(
			"../integrity-state"
		);
		writeFileSync(
			join(home, MARKER_FILE),
			JSON.stringify({
				mode: "full",
				details: "database disk image is malformed",
				detectedAt: "2026-01-01T00:00:00.000Z",
			}),
		);
		const marker = readPendingDatabaseRepair();
		expect(marker).not.toBeNull();
		if (!marker) return;
		expect(marker.state).toBe("pending");
		expect(marker.attempts).toBe(0);
		expect(marker.lastAttemptAt).toBeNull();
		expect(marker.mode).toBe("full");
		// Legacy markers must keep their original meaning: repair on the next startup.
		expect(shouldAttemptAutomaticRepair(marker)).toBe(true);
	});

	test("treats an unreadable marker as unknown: still flagged, but never auto-repaired", async () => {
		const { readPendingDatabaseRepair, shouldAttemptAutomaticRepair, shouldSkipBackgroundProbe } =
			await import("../integrity-state");
		writeFileSync(join(home, MARKER_FILE), "{ truncated");
		const marker = readPendingDatabaseRepair();
		expect(marker).not.toBeNull();
		if (!marker) return;
		expect(marker.state).toBe("unknown");
		// A corrupt marker file is not evidence of a corrupt database: do not spend minutes of
		// blocking recovery on it, but do let the probe establish the real state.
		expect(shouldAttemptAutomaticRepair(marker)).toBe(false);
		expect(shouldSkipBackgroundProbe(marker)).toBe(false);
	});

	test("spends the attempt budget, then abandons automatic repair", async () => {
		const {
			MAX_AUTOMATIC_REPAIR_ATTEMPTS,
			abandonAutomaticRepair,
			readPendingDatabaseRepair,
			recordAutomaticRepairAttempt,
			shouldAttemptAutomaticRepair,
			shouldSkipBackgroundProbe,
			writePendingDatabaseRepair,
		} = await import("../integrity-state");

		writePendingDatabaseRepair({
			mode: "quick",
			details: "malformed database disk image",
			detectedAt: "2026-07-27T00:00:00.000Z",
		});

		let marker = readPendingDatabaseRepair();
		expect(marker).not.toBeNull();
		if (!marker) return;

		for (let i = 1; i <= MAX_AUTOMATIC_REPAIR_ATTEMPTS; i++) {
			expect(shouldAttemptAutomaticRepair(marker)).toBe(true);
			const recorded = recordAutomaticRepairAttempt(marker);
			expect(recorded.write.ok).toBe(true);
			// The counter is durable, so a recovery that crashes or times out still burns budget.
			const reread = readPendingDatabaseRepair();
			expect(reread?.attempts).toBe(i);
			expect(reread?.lastAttemptAt).toBeTruthy();
			marker = recorded.repair;
		}

		expect(shouldAttemptAutomaticRepair(marker)).toBe(false);
		expect(abandonAutomaticRepair(marker).write.ok).toBe(true);

		const abandoned = readPendingDatabaseRepair();
		expect(abandoned).not.toBeNull();
		if (!abandoned) return;
		expect(abandoned.state).toBe("manual");
		expect(abandoned.attempts).toBe(MAX_AUTOMATIC_REPAIR_ATTEMPTS);
		// Abandoned means "a human owns this now": no more blocking startup repair, but the
		// background probe must keep verifying so a manual fix can un-flag the database.
		expect(shouldAttemptAutomaticRepair(abandoned)).toBe(false);
		expect(shouldSkipBackgroundProbe(abandoned)).toBe(false);
	});

	test("re-detecting corruption never resets the budget or revives abandoned repair", async () => {
		const { abandonAutomaticRepair, readPendingDatabaseRepair, recordCorruptionFinding } =
			await import("../integrity-state");

		const first = recordCorruptionFinding({
			mode: "quick",
			details: "malformed database disk image",
			detectedAt: "2026-07-27T00:00:00.000Z",
		});
		expect(first.action).toBe("recorded");

		// Still pending: the queued repair already covers this finding.
		expect(
			recordCorruptionFinding({
				mode: "quick",
				details: "malformed database disk image",
				detectedAt: "2026-07-28T00:00:00.000Z",
			}).action,
		).toBe("kept");

		const pending = readPendingDatabaseRepair();
		expect(pending).not.toBeNull();
		if (!pending) return;
		abandonAutomaticRepair({ ...pending, attempts: 2 });

		const again = recordCorruptionFinding({
			mode: "quick",
			details: "malformed database disk image",
			detectedAt: "2026-07-29T00:00:00.000Z",
		});
		expect(again.action).toBe("kept");
		expect(again.state).toBe("manual");
		const after = readPendingDatabaseRepair();
		expect(after?.state).toBe("manual");
		expect(after?.attempts).toBe(2);
	});

	test("a marker write failure is reported instead of thrown", async () => {
		const { writePendingDatabaseRepair } = await import("../integrity-state");
		// A regular file where the home directory should be: mkdir/write cannot succeed.
		const blocked = join(home, "blocked");
		writeFileSync(blocked, "not a directory");
		process.env.NARRAFORK_HOME = join(blocked, "home");
		const result = writePendingDatabaseRepair({
			mode: "quick",
			details: "malformed database disk image",
			detectedAt: "2026-07-27T00:00:00.000Z",
		});
		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
		process.env.NARRAFORK_HOME = home;
	});
});

describe("scheduleBackgroundIntegrityCheck decisions", () => {
	let home = "";
	let previousHome: string | undefined;
	let previousMode: string | undefined;
	let previousFull: string | undefined;

	beforeEach(async () => {
		const { cancelBackgroundIntegrityCheck } = await import("../integrity-check");
		cancelBackgroundIntegrityCheck();
		home = mkdtempSync(join(tmpdir(), "narrafork-integrity-decide-"));
		previousHome = process.env.NARRAFORK_HOME;
		previousMode = process.env.NARRAFORK_DB_INTEGRITY_CHECK;
		previousFull = process.env.NARRAFORK_DB_FULL_INTEGRITY_CHECK;
		process.env.NARRAFORK_HOME = home;
		delete process.env.NARRAFORK_DB_INTEGRITY_CHECK;
		delete process.env.NARRAFORK_DB_FULL_INTEGRITY_CHECK;
	});

	afterEach(async () => {
		const { cancelBackgroundIntegrityCheck } = await import("../integrity-check");
		cancelBackgroundIntegrityCheck();
		for (const [key, value] of [
			["NARRAFORK_HOME", previousHome],
			["NARRAFORK_DB_INTEGRITY_CHECK", previousMode],
			["NARRAFORK_DB_FULL_INTEGRITY_CHECK", previousFull],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(home, { recursive: true, force: true });
	});

	/** Schedule with a probe that never runs (long delay) and report only the decision. */
	async function decide(options: { wasClean: boolean; isHotReload?: boolean }) {
		const { cancelBackgroundIntegrityCheck, scheduleBackgroundIntegrityCheck } = await import(
			"../integrity-check"
		);
		const decision = scheduleBackgroundIntegrityCheck({
			wasClean: options.wasClean,
			isHotReload: options.isHotReload ?? false,
			delayMs: 600_000,
			probe: async () => report(),
		});
		cancelBackgroundIntegrityCheck();
		return decision;
	}

	function writeMarker(state: "pending" | "manual", attempts = 0): void {
		mkdirSync(home, { recursive: true });
		writeFileSync(
			join(home, MARKER_FILE),
			JSON.stringify({
				mode: "quick",
				details: "malformed database disk image",
				detectedAt: "2026-07-27T00:00:00.000Z",
				state,
				attempts,
				lastAttemptAt: null,
			}),
		);
	}

	test("unclean shutdown schedules a probe, clean shutdown does not", async () => {
		expect(await decide({ wasClean: false })).toBe("scheduled");
		expect(await decide({ wasClean: true })).toBe("clean_shutdown");
	});

	test("hot reload never schedules, whatever the shutdown state was", async () => {
		expect(await decide({ wasClean: false, isHotReload: true })).toBe("hot_reload");
		expect(await decide({ wasClean: true, isHotReload: true })).toBe("hot_reload");
	});

	test("`off` disables verification even after an unclean shutdown", async () => {
		process.env.NARRAFORK_DB_INTEGRITY_CHECK = "off";
		expect(await decide({ wasClean: false })).toBe("disabled_by_env");
		expect(await decide({ wasClean: true })).toBe("disabled_by_env");
	});

	test("`full` and `always` force verification after a clean shutdown", async () => {
		process.env.NARRAFORK_DB_INTEGRITY_CHECK = "full";
		expect(await decide({ wasClean: true })).toBe("scheduled");
		process.env.NARRAFORK_DB_INTEGRITY_CHECK = "always";
		expect(await decide({ wasClean: true })).toBe("scheduled");
		delete process.env.NARRAFORK_DB_INTEGRITY_CHECK;
		process.env.NARRAFORK_DB_FULL_INTEGRITY_CHECK = "1";
		expect(await decide({ wasClean: true })).toBe("scheduled");
	});

	test("`off` still wins over a forced full check", async () => {
		process.env.NARRAFORK_DB_INTEGRITY_CHECK = "off";
		process.env.NARRAFORK_DB_FULL_INTEGRITY_CHECK = "1";
		expect(await decide({ wasClean: false })).toBe("disabled_by_env");
	});

	test("a queued repair suppresses the probe; an abandoned one does not", async () => {
		writeMarker("pending");
		expect(await decide({ wasClean: false })).toBe("repair_pending");
		// This is the regression that made verification permanently dead: the marker survived a
		// failed repair, so the probe was skipped forever.
		writeMarker("manual", 2);
		expect(await decide({ wasClean: false })).toBe("scheduled");
		// Even after a clean shutdown, `always` must still get through an abandoned marker.
		process.env.NARRAFORK_DB_INTEGRITY_CHECK = "always";
		expect(await decide({ wasClean: true })).toBe("scheduled");
	});

	test("an unreadable marker does not suppress the probe", async () => {
		mkdirSync(home, { recursive: true });
		writeFileSync(join(home, MARKER_FILE), "{ truncated");
		expect(await decide({ wasClean: false })).toBe("scheduled");
	});

	test("a second call while a probe is already scheduled is a no-op", async () => {
		const { scheduleBackgroundIntegrityCheck } = await import("../integrity-check");
		expect(
			scheduleBackgroundIntegrityCheck({
				wasClean: false,
				isHotReload: false,
				delayMs: 600_000,
				probe: async () => report(),
			}),
		).toBe("scheduled");
		expect(
			scheduleBackgroundIntegrityCheck({
				wasClean: false,
				isHotReload: false,
				delayMs: 600_000,
				probe: async () => report(),
			}),
		).toBe("already_scheduled");
	});
});

describe("background probe bookkeeping", () => {
	let home = "";
	let previousHome: string | undefined;

	beforeEach(async () => {
		const { cancelBackgroundIntegrityCheck } = await import("../integrity-check");
		cancelBackgroundIntegrityCheck();
		home = mkdtempSync(join(tmpdir(), "narrafork-integrity-book-"));
		previousHome = process.env.NARRAFORK_HOME;
		process.env.NARRAFORK_HOME = home;
	});

	afterEach(async () => {
		const { cancelBackgroundIntegrityCheck } = await import("../integrity-check");
		cancelBackgroundIntegrityCheck();
		if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
		else process.env.NARRAFORK_HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	});

	/** Schedule with an injected verdict and resolve once the result has been fully handled. */
	async function runWithVerdict(
		verdict: IntegrityProbeReport,
		options: { wasClean?: boolean } = {},
	): Promise<void> {
		const { scheduleBackgroundIntegrityCheck } = await import("../integrity-check");
		await new Promise<void>((resolve, reject) => {
			const decision = scheduleBackgroundIntegrityCheck({
				wasClean: options.wasClean ?? false,
				isHotReload: false,
				delayMs: 1,
				probe: async () => verdict,
				onSettled: () => resolve(),
			});
			if (decision !== "scheduled") reject(new Error(`probe not scheduled: ${decision}`));
		});
	}

	test("a corruption verdict flags the database for the next startup", async () => {
		const { readPendingDatabaseRepair } = await import("../integrity-state");
		await runWithVerdict(report({ status: "corrupt", details: "page 42 is never used" }));
		const marker = readPendingDatabaseRepair();
		expect(marker?.state).toBe("pending");
		expect(marker?.details).toBe("page 42 is never used");
		expect(marker?.attempts).toBe(0);
	});

	test("an inconclusive verdict never flags the database", async () => {
		const { readPendingDatabaseRepair } = await import("../integrity-state");
		await runWithVerdict(report({ status: "unavailable", details: "probe timed out" }));
		expect(readPendingDatabaseRepair()).toBeNull();
	});

	test("a passing verdict clears a marker left behind by abandoned automatic repair", async () => {
		const { readPendingDatabaseRepair, writePendingDatabaseRepair } = await import(
			"../integrity-state"
		);
		writePendingDatabaseRepair({
			mode: "quick",
			details: "malformed database disk image",
			detectedAt: "2026-07-27T00:00:00.000Z",
			state: "manual",
			attempts: 2,
		});
		await runWithVerdict(report({ status: "ok" }));
		// The whole point of probing an abandoned marker: a database fixed by hand stops being
		// flagged without anyone editing files under ~/.narrafork.
		expect(readPendingDatabaseRepair()).toBeNull();
	});

	test("corruption is logged even when the marker cannot be persisted", async () => {
		// A regular file where the home directory should be: every marker write fails.
		const blocked = join(home, "blocked");
		writeFileSync(blocked, "not a directory");
		process.env.NARRAFORK_HOME = join(blocked, "home");

		const errors: string[] = [];
		const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		});
		try {
			await runWithVerdict(report({ status: "corrupt", details: "malformed disk image" }));
		} finally {
			spy.mockRestore();
			process.env.NARRAFORK_HOME = home;
		}

		// The finding itself must survive a failed write — this used to be swallowed by an
		// unhandled rejection that also skipped the log line.
		expect(errors.some((line) => line.includes("Database corruption detected"))).toBe(true);
		expect(errors.some((line) => line.includes("Failed to persist the database repair flag"))).toBe(
			true,
		);
	});
});

describe("cancelBackgroundIntegrityCheck", () => {
	let home = "";
	let previousHome: string | undefined;

	beforeEach(async () => {
		const { cancelBackgroundIntegrityCheck } = await import("../integrity-check");
		cancelBackgroundIntegrityCheck();
		home = mkdtempSync(join(tmpdir(), "narrafork-integrity-cancel-"));
		previousHome = process.env.NARRAFORK_HOME;
		process.env.NARRAFORK_HOME = home;
	});

	afterEach(async () => {
		const { cancelBackgroundIntegrityCheck } = await import("../integrity-check");
		cancelBackgroundIntegrityCheck();
		if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
		else process.env.NARRAFORK_HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	});

	test("clears a pending schedule so the probe never starts", async () => {
		const { cancelBackgroundIntegrityCheck, scheduleBackgroundIntegrityCheck } = await import(
			"../integrity-check"
		);
		let probeStarted = false;
		expect(
			scheduleBackgroundIntegrityCheck({
				wasClean: false,
				isHotReload: false,
				delayMs: 20,
				probe: async () => {
					probeStarted = true;
					return report();
				},
			}),
		).toBe("scheduled");

		expect(cancelBackgroundIntegrityCheck()).toEqual({ timerCleared: true, killed: 0 });
		await Bun.sleep(120);
		expect(probeStarted).toBe(false);
	});

	test("kills a probe subprocess that is still scanning", async () => {
		const { cancelBackgroundIntegrityCheck, runIntegrityProbe } = await import(
			"../integrity-check"
		);
		// The probe needs a real database file to get past the existence check.
		const db = new Database(join(home, "narrafork.db"));
		db.run("CREATE TABLE t (a integer primary key)");
		db.close();

		const pending = runIntegrityProbe("quick", {
			timeoutMs: 60_000,
			command: [process.execPath, "-e", "await Bun.sleep(60_000)"],
		});
		// Give Bun.spawn time to register the handle before cancelling.
		await Bun.sleep(300);
		const cancelled = cancelBackgroundIntegrityCheck();
		expect(cancelled.killed).toBe(1);

		// An orphaned probe would have held a read-only handle for up to PROBE_TIMEOUT_MS; killing it
		// means this resolves now, inconclusively, rather than in ten minutes.
		const result = await pending;
		expect(result.status).toBe("unavailable");
	}, 30_000);

	test("is safe to call when nothing is scheduled", async () => {
		const { cancelBackgroundIntegrityCheck } = await import("../integrity-check");
		expect(cancelBackgroundIntegrityCheck()).toEqual({ timerCleared: false, killed: 0 });
	});
});

describe("ensureFts clean-shutdown detection", () => {
	function createBaseTables(): Database {
		const db = new Database(":memory:");
		db.run("CREATE TABLE chapters (rowid integer primary key, title text, description text)");
		db.run("CREATE TABLE narrators (rowid integer primary key, title text)");
		db.run("CREATE TABLE narrator_messages (rowid integer primary key, content_text text)");
		// A clean restart already has its FTS tables and sync triggers installed.
		ensureFts(db, { wasClean: true });
		return db;
	}

	test("trusts the caller's wasClean flag after the marker was already consumed", () => {
		const db = createBaseTables();
		try {
			markCleanShutdown(db);
			// Startup consumes (and zeroes) the marker before ensureFts runs, so re-reading the
			// pragma inside ensureFts would misreport a clean shutdown as unclean.
			const { wasClean } = consumeCleanShutdownState(db);
			expect(wasClean).toBe(true);

			expect(ensureFts(db, { wasClean }).rebuilt).toBe(false);
		} finally {
			db.close();
		}
	});

	test("still treats a consumed unclean marker as needing verification", () => {
		const db = createBaseTables();
		try {
			const { wasClean } = consumeCleanShutdownState(db);
			expect(wasClean).toBe(false);
			expect(ensureFts(db, { wasClean }).rebuilt).toBe(true);
		} finally {
			db.close();
		}
	});
});
