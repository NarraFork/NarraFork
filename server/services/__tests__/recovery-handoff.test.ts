import { beforeEach, describe, expect, test } from "bun:test";
import {
	beginRecoveryDiscovery,
	bindRecoveryHandoffEpoch,
	finishRecoveryDiscovery,
	getRecoveryHandoffSources,
	getRecoverySource,
	getReservedRecoverySourceEpochs,
	invalidateRecoveryTarget,
	isRecoveryTargetPending,
	normalizeRecoverySources,
	type RecoverySource,
	registerRecoverySource,
	releaseRecoveryHandoff,
	reserveRecoveryHandoff,
	resetRecoveryHandoffForTests,
	waitForRecoveryHandoffReady,
	withRecoveryAdvance,
} from "../recovery-handoff";

const source = (epoch = "old"): RecoverySource => ({
	updateEpoch: epoch,
	kind: "planned",
	capturedAt: "2026-01-01",
	narrators: [{ narratorId: "n", locale: "en" }],
	pendingNarratorIds: ["n"],
});
beforeEach(() => resetRecoveryHandoffForTests());
describe("recovery handoff short barrier", () => {
	test("pending target lookup follows current progress rather than retained manifest evidence", () => {
		const original: RecoverySource = {
			...source(),
			logicalRuns: [{ narratorId: "n", logicalRunId: null }],
		};
		expect(isRecoveryTargetPending("n")).toBe(false);
		const handle = registerRecoverySource(original);
		expect(isRecoveryTargetPending("n")).toBe(true);
		expect(isRecoveryTargetPending("unknown")).toBe(false);
		handle.update({ ...original, pendingNarratorIds: [] });
		expect(isRecoveryTargetPending("n")).toBe(false);
		expect(getRecoverySource("old")?.narrators).toEqual(original.narrators);
		handle.retire();
		expect(isRecoveryTargetPending("n")).toBe(false);
	});
	test("pending target lookup protects all sources and drops withdrawn targets", () => {
		const first = registerRecoverySource(source("first"));
		const second = registerRecoverySource({ ...source("second"), kind: "ordinary" });
		first.update({ ...source("first"), pendingNarratorIds: [] });
		expect(isRecoveryTargetPending("n")).toBe(true);
		second.retire();
		expect(isRecoveryTargetPending("n")).toBe(false);
		first.update(source("first"));
		expect(isRecoveryTargetPending("n")).toBe(true);
		invalidateRecoveryTarget("n");
		expect(isRecoveryTargetPending("n")).toBe(false);
		first.update(source("first"));
		expect(isRecoveryTargetPending("n")).toBe(false);
	});
	test("discovery rejects reservation without pausing work", () => {
		beginRecoveryDiscovery();
		expect(() => reserveRecoveryHandoff()).toThrow("discovery");
		finishRecoveryDiscovery();
		const ticket = reserveRecoveryHandoff();
		releaseRecoveryHandoff(ticket);
	});
	test("source manifest validation precedes reservation and rechecks before publication", async () => {
		let identity = "claimed";
		let expected = identity;
		const handle = registerRecoverySource(
			{ ...source(), kind: "ordinary" },
			{
				validateManifest() {
					if (identity !== expected) throw new Error("source manifest identity changed");
				},
			},
		);
		identity = "foreign";
		expect(() => reserveRecoveryHandoff()).toThrow("identity changed");
		let advanced = false;
		await handle.withAdvance(() => {
			advanced = true;
		});
		expect(advanced).toBe(true);
		identity = expected;
		// A legitimate source progress rewrite also updates its private expected identity.
		await handle.withAdvance(() => {
			identity = "reduced";
			expected = identity;
			handle.update({ ...source(), kind: "ordinary", pendingNarratorIds: [] });
		});
		const ticket = reserveRecoveryHandoff();
		expect(getRecoveryHandoffSources(ticket)[0]?.pendingNarratorIds).toEqual([]);
		identity = "foreign-again";
		expect(() => getRecoveryHandoffSources(ticket)).toThrow("identity changed");
		releaseRecoveryHandoff(ticket);
	});
	test("reservation waits short advances, pauses new advances and resumes on release", async () => {
		registerRecoverySource(source());
		let complete!: () => void;
		const active = withRecoveryAdvance(
			"old",
			() =>
				new Promise<void>((resolve) => {
					complete = resolve;
				}),
		);
		await Promise.resolve();
		const ticket = reserveRecoveryHandoff();
		let started = false;
		const queued = withRecoveryAdvance("old", () => {
			started = true;
		});
		let ready = false;
		const waiting = waitForRecoveryHandoffReady(ticket).then(() => {
			ready = true;
		});
		await Promise.resolve();
		expect(ready).toBe(false);
		expect(started).toBe(false);
		complete();
		await active;
		await waiting;
		expect(started).toBe(false);
		releaseRecoveryHandoff(ticket);
		await queued;
		expect(started).toBe(true);
	});
	test("forged tickets fail, interruption removes pending targets while pinned", () => {
		registerRecoverySource(source());
		const ticket = reserveRecoveryHandoff();
		expect(() => releaseRecoveryHandoff({} as typeof ticket)).toThrow();
		invalidateRecoveryTarget("n");
		expect(getRecoveryHandoffSources(ticket)[0]?.pendingNarratorIds).toEqual([]);
		releaseRecoveryHandoff(ticket);
	});
	test("duplicate sources must agree and cannot register during reservation", () => {
		registerRecoverySource(source());
		registerRecoverySource(source());
		expect(() => registerRecoverySource({ ...source(), capturedAt: "different" })).toThrow();
		const ticket = reserveRecoveryHandoff();
		expect(() => registerRecoverySource(source("foreign"))).toThrow();
		releaseRecoveryHandoff(ticket);
	});
	test("timeout releases only its reservation and new tickets reject stale release", async () => {
		registerRecoverySource(source());
		let complete!: () => void;
		const active = withRecoveryAdvance(
			"old",
			() =>
				new Promise<void>((resolve) => {
					complete = resolve;
				}),
		);
		const ticket = reserveRecoveryHandoff();
		await expect(waitForRecoveryHandoffReady(ticket, { timeoutMs: 1 })).rejects.toThrow(
			"timed out",
		);
		const next = reserveRecoveryHandoff();
		expect(() => releaseRecoveryHandoff(ticket)).toThrow();
		complete();
		await active;
		await waitForRecoveryHandoffReady(next);
		releaseRecoveryHandoff(next);
	});
	test("scope advances atomically protect all members and pending invalidation survives updates", async () => {
		const first = registerRecoverySource(source("first"));
		const second = registerRecoverySource(source("second"));
		let complete!: () => void;
		const active = withRecoveryAdvance(["first", "second"], async () => {
			await new Promise<void>((resolve) => {
				complete = resolve;
			});
			first.update(source("first"));
			second.update(source("second"));
		});
		const ticket = reserveRecoveryHandoff();
		bindRecoveryHandoffEpoch(ticket, "new");
		expect(getReservedRecoverySourceEpochs("foreign")).toEqual([]);
		expect(getReservedRecoverySourceEpochs("new")).toEqual(["first", "second"]);
		invalidateRecoveryTarget("n");
		complete();
		await active;
		await waitForRecoveryHandoffReady(ticket);
		expect(getRecoverySource("second")?.pendingNarratorIds).toEqual([]);
		expect(() => second.retire()).toThrow("reserved");
		releaseRecoveryHandoff(ticket);
	});
	test("lineage deduplicates identical identities but rejects conflicting and authorized sources", () => {
		expect(normalizeRecoverySources([source(), source()])).toHaveLength(1);
		expect(() =>
			normalizeRecoverySources([source(), { ...source(), pendingNarratorIds: [] }]),
		).toThrow("Conflicting");
		for (const field of ["sources", "handoffMarkerNonce", "evidenceOnly", "resumeOnNextStartup"]) {
			expect(() => normalizeRecoverySources([{ ...source(), [field]: true }])).toThrow();
		}
	});
	test("cancellation releases reservation without cancelling existing advance", async () => {
		registerRecoverySource(source());
		let complete!: () => void;
		const active = withRecoveryAdvance(
			"old",
			() =>
				new Promise<void>((resolve) => {
					complete = resolve;
				}),
		);
		await Promise.resolve();
		const ticket = reserveRecoveryHandoff();
		const abort = new AbortController();
		const waiting = waitForRecoveryHandoffReady(ticket, { signal: abort.signal });
		abort.abort();
		await expect(waiting).rejects.toThrow();
		complete();
		await active;
		const next = reserveRecoveryHandoff();
		releaseRecoveryHandoff(next);
	});
});
