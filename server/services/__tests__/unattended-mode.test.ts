import { describe, expect, test } from "bun:test";
import { createUnattendedMode, UNATTENDED_SHUTDOWN_REASON } from "../unattended-mode";
import { emptyUnattendedBlockers, type UnattendedBlockers } from "../unattended-probe";

const START = Date.parse("2026-01-01T00:00:00.000Z");

function busyReport(): UnattendedBlockers {
	return {
		...emptyUnattendedBlockers(),
		narrators: { count: 1, ids: ["narrator-1"] },
	};
}

function harness() {
	let now = START;
	let report: UnattendedBlockers = emptyUnattendedBlockers();
	let shutdownAccepted = true;
	const probes: Array<{ dueWithinMs: number }> = [];
	const shutdowns: string[] = [];
	const powerOffs: Array<string | null> = [];
	let hook: ((context: { reason: string }) => Promise<void>) | null = null;
	const mode = createUnattendedMode({
		now: () => now,
		probe: async (input) => {
			probes.push(input);
			return report;
		},
		requestShutdown: (reason) => {
			shutdowns.push(reason);
			return shutdownAccepted;
		},
		powerOff: async (command) => {
			powerOffs.push(command);
			return { ok: true };
		},
		registerHook: (next) => {
			hook = next;
		},
		schedule: () => () => {},
		log: { info: () => {}, warn: () => {} },
	});
	return {
		mode,
		probes,
		shutdowns,
		powerOffs,
		advance(ms: number) {
			now += ms;
		},
		setReport(next: UnattendedBlockers) {
			report = next;
		},
		rejectShutdown() {
			shutdownAccepted = false;
		},
		hook: () => hook,
	};
}

/** `enable()` starts its first evaluation fire-and-forget; let it settle. */
async function flush() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("unattended mode state machine", () => {
	test("stays inert until it is armed", async () => {
		const h = harness();
		await h.mode.tick();
		expect(h.mode.status().enabled).toBe(false);
		expect(h.mode.status().phase).toBe("off");
		expect(h.probes).toHaveLength(0);
		expect(h.shutdowns).toHaveLength(0);
	});

	test("a busy instance waits and never counts down", async () => {
		const h = harness();
		h.setReport(busyReport());
		h.mode.enable({ quietSeconds: 10, armDelaySeconds: 0 });
		await flush();
		const status = h.mode.status();
		expect(status.phase).toBe("waiting");
		expect(status.blocked).toBe(true);
		expect(status.blockers.narrators).toBe(1);
		expect(status.shutdownAt).toBeNull();
		expect(h.shutdowns).toHaveLength(0);
	});

	test("shuts down at the later of the quiet window and the arming delay", async () => {
		const h = harness();
		h.mode.enable({ quietSeconds: 10, armDelaySeconds: 30 });
		await flush();
		h.advance(29_999);
		await h.mode.tick();
		expect(h.shutdowns).toHaveLength(0);
		expect(h.mode.status().phase).toBe("quiet");
		h.advance(1);
		await h.mode.tick();
		expect(h.shutdowns).toEqual([UNATTENDED_SHUTDOWN_REASON]);
		expect(h.mode.status().phase).toBe("shutting_down");
		// A second evaluation must not ask again.
		await h.mode.tick();
		expect(h.shutdowns).toHaveLength(1);
	});

	test("the quiet window restarts whenever work appears again", async () => {
		const h = harness();
		h.mode.enable({ quietSeconds: 10, armDelaySeconds: 0 });
		await flush();
		h.advance(9_000);
		await h.mode.tick();
		expect(h.shutdowns).toHaveLength(0);
		h.setReport(busyReport());
		await h.mode.tick();
		expect(h.mode.status().phase).toBe("waiting");
		expect(h.mode.status().quietSince).toBeNull();
		h.setReport(emptyUnattendedBlockers());
		await h.mode.tick();
		h.advance(9_000);
		await h.mode.tick();
		expect(h.shutdowns).toHaveLength(0);
		h.advance(1_000);
		await h.mode.tick();
		expect(h.shutdowns).toHaveLength(1);
	});

	test("an unverifiable instance counts as blocked", async () => {
		const h = harness();
		h.setReport({ ...emptyUnattendedBlockers(), unknown: true, error: "database: boom" });
		h.mode.enable({ quietSeconds: 10, armDelaySeconds: 0 });
		await flush();
		expect(h.mode.status().phase).toBe("waiting");
		expect(h.mode.status().blockers.unknown).toBe(true);
		expect(h.shutdowns).toHaveLength(0);
	});

	test("a probe that throws keeps the machine on and reports the reason", async () => {
		let now = START;
		const shutdowns: string[] = [];
		const mode = createUnattendedMode({
			now: () => now,
			probe: async () => {
				throw new Error("probe exploded");
			},
			requestShutdown: (reason) => {
				shutdowns.push(reason);
				return true;
			},
			powerOff: async () => ({ ok: true }),
			registerHook: () => {},
			schedule: () => () => {},
			log: { info: () => {}, warn: () => {} },
		});
		mode.enable({ quietSeconds: 10, armDelaySeconds: 0 });
		await flush();
		now += 60_000;
		await mode.tick();
		const status = mode.status();
		expect(status.phase).toBe("waiting");
		expect(status.blocked).toBe(true);
		expect(status.blockers.unknown).toBe(true);
		expect(status.lastError).toBe("probe_failed");
		expect(shutdowns).toHaveLength(0);
	});

	test("a refused shutdown request stays armed instead of powering off", async () => {
		const h = harness();
		h.rejectShutdown();
		h.mode.enable({ quietSeconds: 10, armDelaySeconds: 0 });
		await flush();
		h.advance(10_000);
		await h.mode.tick();
		const status = h.mode.status();
		expect(status.phase).toBe("waiting");
		expect(status.lastError).toBe("shutdown_unavailable");
		expect(h.powerOffs).toHaveLength(0);
		expect(await h.hook()?.({ reason: UNATTENDED_SHUTDOWN_REASON })).toBeUndefined();
		expect(h.powerOffs).toHaveLength(0);
	});

	test("disarming stops the countdown and fails once the shutdown began", async () => {
		const h = harness();
		h.mode.enable({ quietSeconds: 10, armDelaySeconds: 0 });
		await flush();
		const disabled = h.mode.disable();
		expect(disabled.success).toBe(true);
		expect(disabled.status.phase).toBe("off");
		expect(h.hook()).toBeNull();
		h.advance(120_000);
		await h.mode.tick();
		expect(h.shutdowns).toHaveLength(0);

		const armed = harness();
		armed.mode.enable({ quietSeconds: 10, armDelaySeconds: 0 });
		await flush();
		armed.advance(10_000);
		await armed.mode.tick();
		expect(armed.mode.status().phase).toBe("shutting_down");
		const refused = armed.mode.disable();
		expect(refused.success).toBe(false);
		expect(refused.error).toBe("already_shutting_down");
	});

	test("the post-shutdown hook powers off only for its own reason", async () => {
		const h = harness();
		h.mode.enable({ quietSeconds: 10, armDelaySeconds: 0, powerOff: true });
		await flush();
		h.advance(10_000);
		await h.mode.tick();
		await h.hook()?.({ reason: "operator_shutdown" });
		expect(h.powerOffs).toHaveLength(0);
		await h.hook()?.({ reason: UNATTENDED_SHUTDOWN_REASON });
		expect(h.powerOffs).toEqual([null]);
	});

	test("powerOff:false stops the server without touching the machine", async () => {
		const h = harness();
		h.mode.enable({ quietSeconds: 10, armDelaySeconds: 0, powerOff: false });
		await flush();
		h.advance(10_000);
		await h.mode.tick();
		expect(h.mode.status().phase).toBe("shutting_down");
		await h.hook()?.({ reason: UNATTENDED_SHUTDOWN_REASON });
		expect(h.powerOffs).toHaveLength(0);
	});

	test("a custom command is forwarded verbatim", async () => {
		const h = harness();
		h.mode.enable({
			quietSeconds: 10,
			armDelaySeconds: 0,
			powerOffCommand: "  sudo poweroff  ",
		});
		await flush();
		h.advance(10_000);
		await h.mode.tick();
		await h.hook()?.({ reason: UNATTENDED_SHUTDOWN_REASON });
		expect(h.powerOffs).toEqual(["sudo poweroff"]);
	});

	test("options are clamped into the documented ranges", () => {
		const h = harness();
		const status = h.mode.enable({ quietSeconds: 1, armDelaySeconds: 99_999 });
		expect(status.options.quietSeconds).toBe(10);
		expect(status.options.armDelaySeconds).toBe(3_600);
		expect(h.mode.status().pollIntervalMs).toBe(5_000);
	});

	test("the probe is asked about exactly the quiet window", async () => {
		const h = harness();
		h.mode.enable({ quietSeconds: 45, armDelaySeconds: 0 });
		await flush();
		expect(h.probes[0]?.dueWithinMs).toBe(45_000);
	});
});
