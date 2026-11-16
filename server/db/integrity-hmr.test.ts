import { expect, test } from "bun:test";
import { safeSpawn } from "../lib/spawn";

test("legacy HMR kill-only probe is retained and cannot claim a confirmed clean exit", async () => {
	let kills = 0;
	const legacy = {
		kill() {
			kills++;
		},
	};
	const state = { scheduled: true, timer: undefined, running: new Set([legacy]), cancelled: false };
	Object.defineProperty(globalThis, Symbol.for("narrafork.dbIntegrityProbe"), {
		value: state,
		configurable: true,
		writable: true,
	});
	const { cancelBackgroundIntegrityCheck, scheduleBackgroundIntegrityCheck } = await import(
		"./integrity-check"
	);
	await expect(cancelBackgroundIntegrityCheck({ permanent: true })).rejects.toThrow(
		"cold restart required",
	);
	expect(kills).toBe(1);
	expect(state.running.has(legacy)).toBe(true);
	expect(scheduleBackgroundIntegrityCheck({ wasClean: false, isHotReload: false })).toBe(
		"already_scheduled",
	);
});

test.each([
	false,
	true,
])("empty legacy owner still requires restart, even with a backfilled queue (%s)", async (backfilled) => {
	// Bun aliases query-string imports to the cached module. A fresh real process guarantees
	// evaluation against this legacy global rather than the preceding test's captured owner.
	const script = `
import assert from "node:assert/strict";
const { TaskQueue } = await import(${JSON.stringify(new URL("../lib/worker-runtime/queue.ts", import.meta.url).href)});
const state = { scheduled: false, timer: undefined, running: new Set(), cancelled: true,
 ...(${backfilled} ? { queue: new TaskQueue({ concurrency: 1, maxQueued: 8, maxQueuedBytes: 0 }) } : {}) };
globalThis[Symbol.for("narrafork.dbIntegrityProbe")] = state;
const spawn = Bun.spawn;
let creates = 0;
Bun.spawn = () => { creates++; throw new Error("must not start"); };
try {
 const owner = await import(${JSON.stringify(new URL("./integrity-check.ts", import.meta.url).href)});
 assert.equal(owner.scheduleBackgroundIntegrityCheck({ wasClean: false, isHotReload: false }), "restart_required");
 const report = await owner.runIntegrityProbe("quick");
 assert.equal(report.status, "unavailable");
 assert.equal(report.details, "integrity probe owner requires a cold restart");
 const failure = await owner.cancelBackgroundIntegrityCheck().then(() => null, error => error);
 assert.match(failure?.message ?? "", /cold restart required/);
 assert.equal(state.running.size, 0);
 assert.equal(creates, 0);
 assert.equal(state.ownerVersion, undefined);
 assert.equal(state.restartRequired, true);
 assert.equal((await owner.runIntegrityProbe("full")).status, "unavailable");
 process.stdout.write("legacy-owner-refused");
} finally { Bun.spawn = spawn; }
`;
	const result = await safeSpawn({
		cmd: [process.execPath, "-e", script],
		timeout: 10_000,
		maxOutputBytes: 8 * 1024,
	});
	expect(result.exitCode, result.stderr).toBe(0);
	expect(result.stdout).toBe("legacy-owner-refused");
});
