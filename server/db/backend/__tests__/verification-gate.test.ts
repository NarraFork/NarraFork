/**
 * The backend capability gate in front of the background verification probe.
 *
 * WHY THIS GATE NEEDS ITS OWN TEST
 * -------------------------------
 * The wrong way to give a second backend a verification story is a stub probe that answers "ok".
 * That is not a gap, it is a LIE: the corruption-detection path retires itself while every log line
 * says the database is healthy, and nobody discovers it until data is already wrong. So the honest
 * shape is a capability that can say "this engine has no out-of-band verification", and the
 * scheduler must return a distinct decision for it rather than silently behaving as if the check had
 * passed.
 *
 * The second property is subtler and just as load-bearing: a verification pass that CAN WRITE must
 * be refused. On SQLite the probe runs in a read-only subprocess for a reason — a writable scan
 * contends with live sessions for the write lock and can mutate the very state it is judging. A
 * future backend that offered a writable "verify" call must not be scheduled by default.
 *
 * Both branches are unreachable today (SQLite supports a read-only probe), which is exactly why they
 * are tested through an injected port: an untested branch is a branch nobody can trust the first
 * time it actually fires.
 *
 * ISOLATION: no probe is ever spawned. Each case schedules with a 10-minute delay and cancels
 * immediately, so only the DECISION is exercised — no subprocess, no scan, no database write. The
 * marker directory is a temp `NARRAFORK_HOME`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrityProbeReport } from "../../integrity-protocol";
import { capabilityDisabled, notApplicable, supported } from "../capability";
import type { DatabaseVerificationPort } from "../lifecycle-port";
import { sqliteVerificationPort } from "../sqlite-verification";

const ENV_KEYS = [
	"NARRAFORK_HOME",
	"NARRAFORK_DB_INTEGRITY_CHECK",
	"NARRAFORK_DB_FULL_INTEGRITY_CHECK",
] as const;

let home = "";
let saved: Record<string, string | undefined> = {};

beforeEach(async () => {
	const { cancelBackgroundIntegrityCheck } = await import("../../integrity-check");
	cancelBackgroundIntegrityCheck();
	saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	home = mkdtempSync(join(tmpdir(), "nf-verification-gate-"));
	process.env.NARRAFORK_HOME = home;
	delete process.env.NARRAFORK_DB_INTEGRITY_CHECK;
	delete process.env.NARRAFORK_DB_FULL_INTEGRITY_CHECK;
});

afterEach(async () => {
	const { cancelBackgroundIntegrityCheck } = await import("../../integrity-check");
	cancelBackgroundIntegrityCheck();
	for (const key of ENV_KEYS) {
		const value = saved[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(home, { recursive: true, force: true });
});

/** A verification port that reports whatever a test needs, without any engine behind it. */
function portReporting(
	outOfBandProbe: DatabaseVerificationPort["outOfBandProbe"],
	backendId = "test-backend",
): DatabaseVerificationPort {
	return { backendId, outOfBandProbe };
}

/**
 * Schedule and immediately cancel, returning only the decision.
 *
 * `delayMs` is deliberately long: nothing may actually run. `probe` is supplied so that even a
 * scheduled-but-cancelled run could not reach the real subprocess.
 */
async function decide(options: {
	wasClean?: boolean;
	isHotReload?: boolean;
	verification?: DatabaseVerificationPort;
}) {
	const { cancelBackgroundIntegrityCheck, scheduleBackgroundIntegrityCheck } = await import(
		"../../integrity-check"
	);
	const probed: string[] = [];
	const decision = scheduleBackgroundIntegrityCheck({
		wasClean: options.wasClean ?? false,
		isHotReload: options.isHotReload ?? false,
		delayMs: 600_000,
		verification: options.verification,
		probe: async (mode): Promise<IntegrityProbeReport> => {
			probed.push(mode);
			return { status: "ok", mode, details: "ok", durationMs: 1 };
		},
	});
	cancelBackgroundIntegrityCheck();
	return { decision, probed };
}

describe("SQLite verification capability", () => {
	test("reports a read-only out-of-band probe", () => {
		const capability = sqliteVerificationPort.outOfBandProbe();
		expect(capability.supported).toBe(true);
		if (!capability.supported) return;
		// Read-only is not a detail: the probe holds no write lock and cannot mutate what it judges.
		expect(capability.value.readOnly).toBe(true);
		expect(capability.value.description.length).toBeGreaterThan(0);
		expect(sqliteVerificationPort.backendId).toBe("sqlite");
	});
});

describe("scheduling gate", () => {
	test("the default backend still schedules after an unclean shutdown", async () => {
		// Guard against a vacuous suite: if the gate rejected everything, every test below would pass
		// while verification had been switched off entirely.
		const { decision } = await decide({ wasClean: false });
		expect(decision).toBe("scheduled");
	});

	test("a backend without out-of-band verification is not scheduled, and says so", async () => {
		const { decision, probed } = await decide({
			wasClean: false,
			verification: portReporting(() =>
				notApplicable("a server-managed engine verifies itself on its own schedule"),
			),
		});
		// A distinct decision, NOT `clean_shutdown` and NOT a fabricated pass.
		expect(decision).toBe("unsupported_by_backend");
		// And nothing ran: no probe, therefore no verdict that could clear or set a repair marker.
		expect(probed).toEqual([]);
	});

	test("a deliberately disabled capability is also not scheduled", async () => {
		const { decision } = await decide({
			wasClean: false,
			verification: portReporting(() => capabilityDisabled("operator turned verification off")),
		});
		expect(decision).toBe("unsupported_by_backend");
	});

	test("a probe that is not read-only is refused", async () => {
		const { decision, probed } = await decide({
			wasClean: false,
			verification: portReporting(() =>
				supported({ description: "in-process writable verify", readOnly: false }),
			),
		});
		// Refused rather than scheduled: a writable pass would contend for the write lock with live
		// sessions and could alter the state it is supposed to be judging.
		expect(decision).toBe("unsupported_by_backend");
		expect(probed).toEqual([]);
	});

	test("the capability gate is consulted before the env overrides", async () => {
		// `always` forces verification even after a clean shutdown. It must not be able to force a
		// probe onto a backend that has none — an env knob cannot conjure a capability.
		process.env.NARRAFORK_DB_INTEGRITY_CHECK = "always";
		const { decision } = await decide({
			wasClean: true,
			verification: portReporting(() => notApplicable("nothing to probe")),
		});
		expect(decision).toBe("unsupported_by_backend");

		// The same env value against a supporting backend does schedule, which proves the assertion
		// above is about the capability rather than about `always` being ignored.
		const supporting = await decide({
			wasClean: true,
			verification: portReporting(() =>
				supported({ description: "read-only probe", readOnly: true }),
			),
		});
		expect(supporting.decision).toBe("scheduled");
	});

	test("an unsupported backend does not consume the already-scheduled slot", async () => {
		// The gate returns before `probeState.scheduled` is set, so a later call with a supporting
		// backend must still be able to schedule. Getting this wrong would mean one unsupported
		// backend check permanently suppressed verification for the rest of the process.
		const first = await decide({
			wasClean: false,
			verification: portReporting(() => notApplicable("nothing to probe")),
		});
		expect(first.decision).toBe("unsupported_by_backend");

		const second = await decide({ wasClean: false });
		expect(second.decision).toBe("scheduled");
	});
});
