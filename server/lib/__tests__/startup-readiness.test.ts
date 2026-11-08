import { describe, expect, test } from "bun:test";
import { buildHealthPayload, createStartupReadinessGate } from "../startup-readiness";

describe("startup readiness health payload", () => {
	test("passes the app status through once recovery is ready", () => {
		expect(buildHealthPayload({ status: "ok", version: "1.2.3" }, { status: "ready" })).toEqual({
			status: "ok",
			version: "1.2.3",
			readiness: "ready",
		});
	});

	test("reports recovering without inventing a recovery error", () => {
		const payload = buildHealthPayload({ status: "ok" }, { status: "recovering" });
		expect(payload).toEqual({ status: "recovering", readiness: "recovering" });
		expect("recoveryError" in payload).toBe(false);
	});

	// The reason must reach the client because the update flow reloads into this build anyway and
	// reports the failure afterwards. It is diagnostic payload, not a signal to withhold the build.
	test("surfaces the recovery error so the client can report it", () => {
		expect(buildHealthPayload({ status: "ok" }, { status: "failed", error: "boom" })).toEqual({
			status: "failed",
			readiness: "failed",
			recoveryError: "boom",
		});
	});

	// The failure is diagnostic payload only. /api/health keeps the app's own status code
	// (200), so storage and other health-gated UI features are not disabled by one narrator.
	test("surfaces the recovery error so the client can report it", () => {
		expect(buildHealthPayload({ status: "ok" }, { status: "failed", error: "boom" })).toEqual({
			status: "failed",
			readiness: "failed",
			recoveryError: "boom",
		});
	});
});

describe("startup readiness gate lifecycle", () => {
	test("starts in the recovering state", () => {
		expect(createStartupReadinessGate().state).toEqual({ status: "recovering" });
	});

	test("settles the barrier with the recovery outcome", async () => {
		const gate = createStartupReadinessGate();
		gate.markReady();
		gate.settle({ ok: true });
		expect(await gate.barrier).toEqual({ ok: true });
		expect(gate.state).toEqual({ status: "ready" });
	});

	test("settles a failure without rejecting the barrier", async () => {
		const gate = createStartupReadinessGate();
		gate.markFailed("provider missing");
		gate.settle({ ok: false, error: "provider missing" });
		expect(await gate.barrier).toEqual({ ok: false, error: "provider missing" });
		expect(gate.state).toEqual({ status: "failed", error: "provider missing" });
	});

	test("ignores repeated settle calls so the first outcome wins", async () => {
		const gate = createStartupReadinessGate();
		gate.settle({ ok: true });
		gate.settle({ ok: false, error: "late failure" });
		expect(await gate.barrier).toEqual({ ok: true });
	});

	test("lets a background pass move ready → failed after the barrier settled", async () => {
		const gate = createStartupReadinessGate();
		gate.markRecovering();
		gate.settle({ ok: true });
		await gate.barrier;
		gate.markFailed("background continuation failed");
		expect(gate.state).toEqual({ status: "failed", error: "background continuation failed" });
	});
});
