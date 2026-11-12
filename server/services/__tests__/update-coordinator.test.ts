import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eventBus } from "../../lib/event-bus";
import { getNarraforkPath } from "../../lib/narrafork-home";
import {
	MAX_RECOVERY_MANIFEST_BYTES,
	registerRecoverySource,
	withRecoveryAdvance,
} from "../recovery-handoff";

const manifestPath = join(getNarraforkPath("updates"), "planned-update-recovery.json");

import {
	assertUpdateNotCancelled,
	beginNarratorResponseActivity,
	beginQuiescingTools,
	beginToolStartAdmission,
	beginUpdatePreAdmissionActivity,
	cancelScheduledUpdate,
	capturePlannedUpdateRecoverySnapshot,
	classifyRecoveryManifestOwnership,
	consumePlannedUpdateRecoverySnapshot,
	convertToolStartGrantToExecution,
	failScheduledUpdate,
	getScheduledRecoverySources,
	getUpdateCoordinationStatus,
	markUpdateRestarting,
	parsePlannedUpdateRecoverySnapshot,
	registerNarratorLoop,
	releasePreparedUpdateRecoveryHandoff,
	removePlannedUpdateRecoverySnapshot,
	resetUpdateCoordinationForTests,
	rollbackPreparedUpdateRecoverySnapshot,
	scheduleUpdate,
	tryAcquireFinalUpdateExecution,
	tryAcquireUpdateExecution,
	UpdateCancelledError,
	waitForBackgroundBashDrain,
	waitForOrdinaryToolDrain,
	waitForScheduledRecoveryHandoff,
	waitForUpdateCheckpointFence,
	waitUntilUpdateGateOpens,
	writePlannedUpdateRecoverySnapshot,
	writePreparedUpdateRecoverySnapshot,
} from "../update-coordinator";

describe("lifecycle status invalidation", () => {
	beforeEach(resetUpdateCoordinationForTests);
	afterEach(resetUpdateCoordinationForTests);

	async function observe(run: (events: unknown[]) => Promise<void>) {
		const events: unknown[] = [];
		const changed = (event: { type: "system:lifecycle_changed" }) => events.push(event);
		eventBus.on("system:lifecycle_changed", changed);
		try {
			await run(events);
		} finally {
			eventBus.off("system:lifecycle_changed", changed);
		}
	}
	const flush = () => Bun.sleep(75);

	test("ordinary idle activity and status reads never broadcast", async () => {
		await observe(async (events) => {
			const execution = tryAcquireFinalUpdateExecution("ordinary", "n");
			execution?.setNarratorId("other");
			const response = await beginNarratorResponseActivity("n");
			const admission = beginToolStartAdmission("ordinary", "n", "tool");
			if (admission.status === "granted") admission.grant.release();
			const unregister = registerNarratorLoop("n", "en");
			getUpdateCoordinationStatus();
			execution?.release();
			response.release();
			unregister();
			await flush();
			expect(events).toEqual([]);
		});
	});

	test("coalesces maintenance bursts and delivers final idle even before the timer fires", async () => {
		await observe(async (events) => {
			const execution = tryAcquireFinalUpdateExecution("ordinary", "n");
			scheduleUpdate("next");
			beginQuiescingTools();
			execution?.release();
			cancelScheduledUpdate();
			failScheduledUpdate("cancelled", { cancelled: true });
			await flush();
			expect(getUpdateCoordinationStatus().phase).toBe("idle");
			expect(events).toEqual([{ type: "system:lifecycle_changed" }]);
			tryAcquireFinalUpdateExecution("ordinary")?.release();
			await flush();
			expect(events).toHaveLength(1);
		});
	});

	test("notifies stage, cancellation, blocker identity, counts and paused gate changes", async () => {
		await observe(async (events) => {
			const execution = tryAcquireFinalUpdateExecution("ordinary", "n");
			const response = await beginNarratorResponseActivity("n");
			const admission = beginToolStartAdmission("ordinary", "n", "tool");
			scheduleUpdate("next");
			await flush();
			expect(events).toHaveLength(1);
			execution?.setNarratorId("changed");
			await flush();
			expect(events).toHaveLength(2);
			execution?.setNarratorId("changed");
			getUpdateCoordinationStatus();
			await flush();
			expect(events).toHaveLength(2);
			beginQuiescingTools();
			await flush();
			expect(events).toHaveLength(3);
			const abort = new AbortController();
			const waiting = waitUntilUpdateGateOpens(abort.signal).catch(() => {});
			const epoch = getUpdateCoordinationStatus().updateEpoch;
			if (!epoch) throw new Error("Missing update epoch");
			const activity = beginUpdatePreAdmissionActivity(epoch, "n", "paused");
			await flush();
			expect(events).toHaveLength(4);
			abort.abort();
			await waiting;
			activity?.release();
			response.release();
			if (admission.status === "granted") admission.grant.release();
			execution?.release();
			await flush();
			expect(events).toHaveLength(5);
			cancelScheduledUpdate();
			await flush();
			expect(events).toHaveLength(6);
			cancelScheduledUpdate();
			await flush();
			expect(events).toHaveLength(6);
			markUpdateRestarting();
			await flush();
			expect(events).toHaveLength(7);
			failScheduledUpdate("cancelled", { cancelled: true });
			await flush();
			expect(events).toHaveLength(8);
		});
	});
});

describe("update coordinator handoff", () => {
	beforeEach(() => resetUpdateCoordinationForTests());
	afterEach(() => resetUpdateCoordinationForTests());
	const old = () => ({
		version: 2 as const,
		updateEpoch: "old",
		capturedAt: "2026-01-01",
		resumeOnNextStartup: true,
		narrators: [{ narratorId: "n", locale: "en" }],
	});
	test("rejects unclaimed root before phase and response changes", () => {
		writePlannedUpdateRecoverySnapshot(old());
		expect(() => scheduleUpdate(undefined, "system_shutdown")).toThrow();
		expect(getUpdateCoordinationStatus().phase).toBe("idle");
	});
	test("claimed root transfers atomically, old completion cannot delete new root, rollback restores exact authorization", async () => {
		const original = writePlannedUpdateRecoverySnapshot(old());
		registerRecoverySource(
			{
				updateEpoch: original.updateEpoch,
				kind: "planned",
				capturedAt: original.capturedAt,
				narrators: original.narrators,
				pendingNarratorIds: ["n"],
			},
			{ manifestIdentity: JSON.stringify(original) },
		);
		const scheduled = scheduleUpdate(undefined, "system_shutdown");
		if (!scheduled.updateEpoch) throw new Error("Missing epoch");
		await waitForScheduledRecoveryHandoff();
		expect(getScheduledRecoverySources()).toHaveLength(1);
		const captured = capturePlannedUpdateRecoverySnapshot();
		expect(captured.version).toBe(3);
		expect(() => writePlannedUpdateRecoverySnapshot(captured)).toThrow();
		writePreparedUpdateRecoverySnapshot({ ...captured, resumeOnNextStartup: true });
		removePlannedUpdateRecoverySnapshot({ expectedEpoch: "old" });
		expect(consumePlannedUpdateRecoverySnapshot()?.updateEpoch).toBe(scheduled.updateEpoch);
		rollbackPreparedUpdateRecoverySnapshot(scheduled.updateEpoch);
		expect(consumePlannedUpdateRecoverySnapshot()).toEqual(original);
		releasePreparedUpdateRecoveryHandoff(scheduled.updateEpoch);
	});
	test("same-epoch authorization replacement is rejected despite matching target metadata", () => {
		const original = writePlannedUpdateRecoverySnapshot(old());
		registerRecoverySource(
			{
				updateEpoch: original.updateEpoch,
				kind: "planned",
				capturedAt: original.capturedAt,
				narrators: original.narrators,
				pendingNarratorIds: ["n"],
			},
			{ manifestIdentity: JSON.stringify(original) },
		);
		writePlannedUpdateRecoverySnapshot({ ...original, handoffMarkerNonce: "foreign" });
		expect(() => scheduleUpdate(undefined, "system_shutdown")).toThrow("not claimed");
		expect(getUpdateCoordinationStatus().phase).toBe("idle");
	});
	test("prepared writer accepts only bounded receipt augmentation, never arbitrary source metadata", async () => {
		registerRecoverySource({
			updateEpoch: "ordinary",
			kind: "ordinary",
			capturedAt: "today",
			narrators: [{ narratorId: "n", locale: "en" }],
			pendingNarratorIds: ["n"],
		});
		scheduleUpdate(undefined, "system_shutdown");
		await waitForScheduledRecoveryHandoff();
		const captured = capturePlannedUpdateRecoverySnapshot();
		const source = captured.sources?.[0];
		if (!source) throw new Error("Missing source");
		expect(() =>
			writePreparedUpdateRecoverySnapshot({
				...captured,
				sources: [{ ...source, pendingNarratorIds: [] }],
			}),
		).toThrow();
		const published = writePreparedUpdateRecoverySnapshot({
			...captured,
			sources: [{ ...source, unstartedTools: [{ toolCallId: "t", executionAttempt: 2 }] }],
		});
		expect(published.sources?.[0]?.unstartedTools).toEqual([
			{ toolCallId: "t", executionAttempt: 2 },
		]);
		expect(() =>
			writePlannedUpdateRecoverySnapshot({ ...published, version: 2, sources: undefined }),
		).toThrow("inherited sources");
	});
	test("ordinary same-epoch publication is tracked for rollback and failed evidence remains inert", () => {
		const epoch = scheduleUpdate("new").updateEpoch;
		if (!epoch) throw new Error("Missing epoch");
		writePlannedUpdateRecoverySnapshot({
			...capturePlannedUpdateRecoverySnapshot(),
			resumeOnNextStartup: true,
		});
		rollbackPreparedUpdateRecoverySnapshot(epoch);
		expect(consumePlannedUpdateRecoverySnapshot()).toBeNull();
		writePlannedUpdateRecoverySnapshot({
			...capturePlannedUpdateRecoverySnapshot(),
			evidenceOnly: true,
		});
		failScheduledUpdate("failed cleanup");
		expect(getUpdateCoordinationStatus().phase).toBe("idle");
		expect(consumePlannedUpdateRecoverySnapshot()?.evidenceOnly).toBe(true);
	});
	test("ordinary manifest validator rejects before assigning epoch or changing the gate", () => {
		let valid = false;
		registerRecoverySource(
			{
				updateEpoch: "restart-old",
				kind: "ordinary",
				capturedAt: "today",
				narrators: [],
				pendingNarratorIds: [],
			},
			{
				validateManifest() {
					if (!valid) throw new Error("ordinary manifest changed");
				},
			},
		);
		expect(() => scheduleUpdate(undefined, "system_shutdown")).toThrow("ordinary manifest changed");
		expect(getUpdateCoordinationStatus()).toMatchObject({
			phase: "idle",
			scheduled: false,
		});
		expect(getUpdateCoordinationStatus().updateEpoch).toBeUndefined();
		valid = true;
		expect(scheduleUpdate(undefined, "system_shutdown").scheduled).toBe(true);
	});
	test("scheduling logs reuse preflight source identities instead of validating after mutation", () => {
		let validations = 0;
		registerRecoverySource(
			{
				updateEpoch: "restart-log-check",
				kind: "ordinary",
				capturedAt: "today",
				narrators: [],
				pendingNarratorIds: [],
			},
			{
				validateManifest() {
					validations++;
					if (validations > 2) throw new Error("late source read failed");
				},
			},
		);
		const scheduled = scheduleUpdate(undefined, "system_shutdown");
		expect(scheduled.scheduled).toBe(true);
		expect(validations).toBe(2);
		expect(scheduled.updateEpoch).toBeDefined();
	});
	test("target binary capability must explicitly support inherited sources", () => {
		registerRecoverySource({
			updateEpoch: "restart-old",
			kind: "ordinary",
			capturedAt: "today",
			narrators: [],
			pendingNarratorIds: [],
		});
		expect(() => scheduleUpdate("new")).toThrow();
		expect(getUpdateCoordinationStatus().phase).toBe("idle");
		expect(
			scheduleUpdate("new", "update", { supportedRecoveryManifestVersions: [1, 2, 3] }).scheduled,
		).toBe(true);
	});
	test("enforces exact source, aggregate target and UTF-8 byte limits", () => {
		const source = (i: number) => ({
			updateEpoch: `source-${i}`,
			kind: "planned" as const,
			capturedAt: "today",
			narrators: [],
			pendingNarratorIds: [],
		});
		const root = {
			...old(),
			version: 3 as const,
			sources: Array.from({ length: 64 }, (_, i) => source(i)),
		};
		expect(parsePlannedUpdateRecoverySnapshot(root)?.sources).toHaveLength(64);
		expect(
			parsePlannedUpdateRecoverySnapshot({ ...root, sources: [...root.sources, source(65)] }),
		).toBeNull();
		const narrators = Array.from({ length: 10_000 }, (_, i) => ({
			narratorId: `n-${i}`,
			locale: "en",
		}));
		expect(parsePlannedUpdateRecoverySnapshot({ ...old(), narrators })?.narrators).toHaveLength(
			10_000,
		);
		expect(
			parsePlannedUpdateRecoverySnapshot({
				...old(),
				narrators: [...narrators, { narratorId: "extra", locale: "en" }],
			}),
		).toBeNull();
		expect(
			parsePlannedUpdateRecoverySnapshot({
				...root,
				narrators,
				sources: [{ ...source(1), narrators: old().narrators }],
			}),
		).toBeNull();
		const base = { ...old(), padding: "" };
		const padding = "x".repeat(
			MAX_RECOVERY_MANIFEST_BYTES - Buffer.byteLength(JSON.stringify(base)),
		);
		expect(parsePlannedUpdateRecoverySnapshot({ ...base, padding })).not.toBeNull();
		expect(parsePlannedUpdateRecoverySnapshot({ ...base, padding: `${padding}x` })).toBeNull();
		expect(() =>
			writePlannedUpdateRecoverySnapshot({
				...old(),
				narrators: [{ narratorId: "huge", locale: "中".repeat(MAX_RECOVERY_MANIFEST_BYTES / 3) }],
			}),
		).toThrow();
	});
	test("preserves oversized, corrupt and unknown disk evidence without interrupting responses", async () => {
		mkdirSync(getNarraforkPath("updates"), { recursive: true });
		for (const text of [
			"{broken",
			JSON.stringify({ ...old(), version: 99 }),
			" ".repeat(MAX_RECOVERY_MANIFEST_BYTES + 1),
		]) {
			writeFileSync(manifestPath, text);
			const response = await beginNarratorResponseActivity("active");
			expect(consumePlannedUpdateRecoverySnapshot()).toBeNull();
			expect(() => scheduleUpdate(undefined, "system_shutdown")).toThrow();
			expect(getUpdateCoordinationStatus().phase).toBe("idle");
			expect(readFileSync(manifestPath, "utf8")).toBe(text);
			response.release();
		}
	});
	test("rollback CAS failure keeps the reservation and gate until exact root is restored", async () => {
		const original = writePlannedUpdateRecoverySnapshot(old());
		registerRecoverySource(
			{
				updateEpoch: "old",
				kind: "planned",
				capturedAt: original.capturedAt,
				narrators: original.narrators,
				pendingNarratorIds: ["n"],
			},
			{ manifestIdentity: JSON.stringify(original) },
		);
		const epoch = scheduleUpdate(undefined, "system_shutdown").updateEpoch;
		if (!epoch) throw new Error("Missing epoch");
		await waitForScheduledRecoveryHandoff();
		writePreparedUpdateRecoverySnapshot({
			...capturePlannedUpdateRecoverySnapshot(),
			resumeOnNextStartup: true,
		});
		const published = readFileSync(manifestPath, "utf8");
		writeFileSync(manifestPath, "foreign evidence");
		expect(() => rollbackPreparedUpdateRecoverySnapshot(epoch)).toThrow();
		expect(() => releasePreparedUpdateRecoveryHandoff(epoch)).toThrow();
		expect(() => failScheduledUpdate("rollback failed")).toThrow();
		expect(getUpdateCoordinationStatus().scheduled).toBe(true);
		let progressed = false;
		const queued = withRecoveryAdvance("old", () => {
			progressed = true;
		});
		await Promise.resolve();
		expect(progressed).toBe(false);
		writeFileSync(manifestPath, published);
		rollbackPreparedUpdateRecoverySnapshot(epoch);
		releasePreparedUpdateRecoveryHandoff(epoch);
		failScheduledUpdate("cancelled", { cancelled: true });
		await queued;
		expect(progressed).toBe(true);
		expect(consumePlannedUpdateRecoverySnapshot()).toEqual(original);
	});
	test("failed atomic publication or rollback keeps the authoritative root and reservation", async () => {
		const original = writePlannedUpdateRecoverySnapshot(old());
		registerRecoverySource(
			{
				updateEpoch: original.updateEpoch,
				kind: "planned",
				capturedAt: original.capturedAt,
				narrators: original.narrators,
				pendingNarratorIds: ["n"],
			},
			{ manifestIdentity: JSON.stringify(original) },
		);
		const epoch = scheduleUpdate(undefined, "system_shutdown").updateEpoch;
		if (!epoch) throw new Error("Missing epoch");
		await waitForScheduledRecoveryHandoff();
		const snapshot = capturePlannedUpdateRecoverySnapshot();
		const failedWrite = spyOn(fs, "renameSync").mockImplementationOnce(() => {
			throw new Error("injected EIO");
		});
		try {
			expect(() => writePreparedUpdateRecoverySnapshot(snapshot)).toThrow("injected EIO");
		} finally {
			failedWrite.mockRestore();
		}
		expect(consumePlannedUpdateRecoverySnapshot()).toEqual(original);
		writePreparedUpdateRecoverySnapshot(snapshot);
		const failedRollback = spyOn(fs, "renameSync").mockImplementationOnce(() => {
			throw new Error("injected EIO");
		});
		try {
			expect(() => rollbackPreparedUpdateRecoverySnapshot(epoch)).toThrow("injected EIO");
		} finally {
			failedRollback.mockRestore();
		}
		expect(consumePlannedUpdateRecoverySnapshot()?.updateEpoch).toBe(epoch);
		expect(() => releasePreparedUpdateRecoveryHandoff(epoch)).toThrow();
		rollbackPreparedUpdateRecoverySnapshot(epoch);
		releasePreparedUpdateRecoveryHandoff(epoch);
		expect(consumePlannedUpdateRecoverySnapshot()).toEqual(original);
	});
	test("two successive boots flatten planned and ordinary ancestry without inheriting source authorization", async () => {
		const original = writePlannedUpdateRecoverySnapshot(old());
		registerRecoverySource(
			{
				updateEpoch: "old",
				kind: "planned",
				capturedAt: original.capturedAt,
				narrators: original.narrators,
				pendingNarratorIds: ["n"],
			},
			{ manifestIdentity: JSON.stringify(original) },
		);
		registerRecoverySource({
			updateEpoch: "restart-a",
			kind: "ordinary",
			capturedAt: "today",
			narrators: [{ narratorId: "o", locale: "en" }],
			pendingNarratorIds: ["o"],
			logicalRuns: [{ narratorId: "o", logicalRunId: "run" }],
		});
		scheduleUpdate(undefined, "system_shutdown");
		await waitForScheduledRecoveryHandoff();
		const first = writePreparedUpdateRecoverySnapshot({
			...capturePlannedUpdateRecoverySnapshot(),
			resumeOnNextStartup: true,
		});
		expect(first.sources?.map((source) => source.updateEpoch)).toEqual(["old", "restart-a"]);
		resetUpdateCoordinationForTests();
		writePlannedUpdateRecoverySnapshot(first);
		registerRecoverySource(
			{
				updateEpoch: first.updateEpoch,
				kind: "planned",
				capturedAt: first.capturedAt,
				narrators: first.narrators,
				pendingNarratorIds: [],
			},
			{ manifestIdentity: JSON.stringify(first) },
		);
		for (const source of first.sources ?? []) registerRecoverySource(source);
		scheduleUpdate(undefined, "system_shutdown");
		await waitForScheduledRecoveryHandoff();
		const second = writePreparedUpdateRecoverySnapshot(capturePlannedUpdateRecoverySnapshot());
		expect(second.sources?.map((source) => source.updateEpoch)).toEqual([
			first.updateEpoch,
			"old",
			"restart-a",
		]);
		expect(second.resumeOnNextStartup).toBeUndefined();
		expect(
			second.sources?.every(
				(source) => !("sources" in source) && !("resumeOnNextStartup" in source),
			),
		).toBe(true);
	});
	test("operator cancellation immediately aborts a pending short barrier", async () => {
		registerRecoverySource({
			updateEpoch: "restart-a",
			kind: "ordinary",
			capturedAt: "today",
			narrators: [],
			pendingNarratorIds: [],
		});
		let complete!: () => void;
		const advance = withRecoveryAdvance(
			"restart-a",
			() =>
				new Promise<void>((resolve) => {
					complete = resolve;
				}),
		);
		const epoch = scheduleUpdate(undefined, "system_shutdown").updateEpoch;
		if (!epoch) throw new Error("Missing epoch");
		const waiting = waitForScheduledRecoveryHandoff();
		cancelScheduledUpdate();
		await expect(waiting).rejects.toBeInstanceOf(UpdateCancelledError);
		rollbackPreparedUpdateRecoverySnapshot(epoch);
		releasePreparedUpdateRecoveryHandoff(epoch);
		failScheduledUpdate("cancel", { cancelled: true });
		complete();
		await advance;
	});
	test("already-entered finalizer can finish before publication without resurrecting its root", async () => {
		const original = writePlannedUpdateRecoverySnapshot(old());
		const handle = registerRecoverySource(
			{
				updateEpoch: "old",
				kind: "planned",
				capturedAt: original.capturedAt,
				narrators: original.narrators,
				pendingNarratorIds: ["n"],
			},
			{ manifestIdentity: JSON.stringify(original) },
		);
		let complete!: () => void;
		const finalizer = handle.withAdvance(async () => {
			await new Promise<void>((resolve) => {
				complete = resolve;
			});
			removePlannedUpdateRecoverySnapshot({ expectedEpoch: "old" });
			handle.retire();
		});
		scheduleUpdate(undefined, "system_shutdown");
		const ready = waitForScheduledRecoveryHandoff();
		complete();
		await finalizer;
		await ready;
		expect(getScheduledRecoverySources()).toEqual([]);
		expect(
			writePreparedUpdateRecoverySnapshot(capturePlannedUpdateRecoverySnapshot()).version,
		).toBe(2);
	});
	test("unknown versions and malformed targets fail closed", () => {
		expect(parsePlannedUpdateRecoverySnapshot({ ...old(), version: 4 })).toBeNull();
		expect(parsePlannedUpdateRecoverySnapshot({ ...old(), narrators: [null] })).toBeNull();
		expect(
			parsePlannedUpdateRecoverySnapshot({
				...old(),
				version: 3,
				sources: [{ ...old(), kind: "planned", pendingNarratorIds: ["n"] }],
			}),
		).toBeNull();
	});
});

describe("update coordinator", () => {
	beforeEach(() => {
		resetUpdateCoordinationForTests();
	});

	afterEach(() => {
		resetUpdateCoordinationForTests();
	});

	test("phase one blocks background Bash while admitting ordinary and resumable work", () => {
		const existingBackground = tryAcquireFinalUpdateExecution("background_bash", "narrator-1");
		expect(existingBackground).not.toBeNull();

		const scheduled = scheduleUpdate("9.9.9");
		expect(scheduled).toMatchObject({
			phase: "draining_background_bash",
			scheduled: true,
			targetVersion: "9.9.9",
			pendingBackgroundBashCount: 1,
			pendingOrdinaryExecutionCount: 0,
			resumableExecutionCount: 0,
			pendingExecutionCount: 1,
		});
		expect(scheduled.updateEpoch).toBeString();

		expect(tryAcquireFinalUpdateExecution("background_bash", "narrator-2")).toBeNull();
		const ordinary = tryAcquireFinalUpdateExecution("ordinary", "narrator-2");
		const resumable = tryAcquireFinalUpdateExecution("resumable", "narrator-3");
		expect(ordinary).not.toBeNull();
		expect(resumable).not.toBeNull();
		expect(getUpdateCoordinationStatus()).toMatchObject({
			pendingBackgroundBashCount: 1,
			pendingOrdinaryExecutionCount: 1,
			resumableExecutionCount: 1,
			pendingExecutionCount: 3,
		});

		existingBackground?.release();
		ordinary?.release();
		resumable?.release();
	});

	test("phase two rejects every execution kind", () => {
		scheduleUpdate("9.9.9");
		const status = beginQuiescingTools();
		expect(status.phase).toBe("quiescing_tools");

		expect(tryAcquireFinalUpdateExecution("background_bash")).toBeNull();
		expect(tryAcquireFinalUpdateExecution("ordinary")).toBeNull();
		expect(tryAcquireFinalUpdateExecution("resumable")).toBeNull();

		markUpdateRestarting();
		expect(tryAcquireFinalUpdateExecution("background_bash")).toBeNull();
		expect(tryAcquireFinalUpdateExecution("ordinary")).toBeNull();
		expect(tryAcquireFinalUpdateExecution("resumable")).toBeNull();
	});

	test("tool start grant atomically survives a phase switch and fences checkpointing", async () => {
		const admission = beginToolStartAdmission("ordinary", "narrator-grant", "tool-grant");
		expect(admission.status).toBe("granted");
		if (admission.status !== "granted") throw new Error("Expected a tool start grant");
		expect(getUpdateCoordinationStatus().pendingToolStartGrantCount).toBe(1);

		scheduleUpdate("9.9.9");
		beginQuiescingTools();
		let stable = false;
		const fence = waitForUpdateCheckpointFence().then(() => {
			stable = true;
		});
		await Promise.resolve();
		expect(stable).toBe(false);

		admission.grant.release();
		await fence;
		expect(stable).toBe(true);
		expect(getUpdateCoordinationStatus().pendingToolStartGrantCount).toBe(0);
	});

	test("phase-two conversion preserves the irrevocable grant and hands off to ordinary drain", async () => {
		const admission = beginToolStartAdmission("ordinary", "narrator-grant", "tool-grant");
		if (admission.status !== "granted") throw new Error("Expected a tool start grant");
		scheduleUpdate("9.9.9");
		beginQuiescingTools();

		let checkpointStable = false;
		const checkpointFence = waitForUpdateCheckpointFence().then(() => {
			checkpointStable = true;
		});
		await Promise.resolve();
		expect(checkpointStable).toBe(false);

		const transition = convertToolStartGrantToExecution(
			admission.grant,
			"narrator-grant",
			"tool-grant",
		);
		expect(transition.status).toBe("execution");
		expect(getUpdateCoordinationStatus()).toMatchObject({
			pendingToolStartGrantCount: 0,
			pendingPreAdmissionCount: 0,
			pendingOrdinaryExecutionCount: 1,
		});
		await checkpointFence;
		expect(checkpointStable).toBe(true);

		let ordinaryDrained = false;
		const ordinaryDrain = waitForOrdinaryToolDrain().then(() => {
			ordinaryDrained = true;
		});
		await Promise.resolve();
		expect(ordinaryDrained).toBe(false);
		transition.lease.release();
		await ordinaryDrain;
		expect(ordinaryDrained).toBe(true);
	});

	test("drains background Bash first, ordinary tools second, and never waits for resumable work", async () => {
		const background = tryAcquireFinalUpdateExecution("background_bash");
		const ordinary = tryAcquireFinalUpdateExecution("ordinary");
		const resumable = tryAcquireFinalUpdateExecution("resumable");
		scheduleUpdate("9.9.9");

		let backgroundDrained = false;
		const backgroundDrain = waitForBackgroundBashDrain().then(() => {
			backgroundDrained = true;
		});
		await Promise.resolve();
		expect(backgroundDrained).toBe(false);

		background?.release();
		await backgroundDrain;
		expect(backgroundDrained).toBe(true);
		expect(getUpdateCoordinationStatus().pendingOrdinaryExecutionCount).toBe(1);

		beginQuiescingTools();
		let ordinaryDrained = false;
		const ordinaryDrain = waitForOrdinaryToolDrain().then(() => {
			ordinaryDrained = true;
		});
		await Promise.resolve();
		expect(ordinaryDrained).toBe(false);

		ordinary?.release();
		await ordinaryDrain;
		expect(ordinaryDrained).toBe(true);
		expect(getUpdateCoordinationStatus()).toMatchObject({
			resumableExecutionCount: 1,
			pendingExecutionCount: 1,
		});
		resumable?.release();
	});

	test("checkpoint fence waits for active responses and durable pre-admission work", async () => {
		const response = await beginNarratorResponseActivity("narrator-response");
		const scheduled = scheduleUpdate("9.9.9");
		beginQuiescingTools();
		if (!scheduled.updateEpoch) throw new Error("Expected update epoch");
		const admission = beginUpdatePreAdmissionActivity(
			scheduled.updateEpoch,
			"narrator-tool",
			"tool-use-1",
		);
		expect(admission).not.toBeNull();

		let stable = false;
		const waiting = waitForUpdateCheckpointFence().then(() => {
			stable = true;
		});
		await Promise.resolve();
		expect(stable).toBe(false);
		expect(getUpdateCoordinationStatus()).toMatchObject({
			activeResponseCount: 1,
			pendingPreAdmissionCount: 1,
		});

		response.release();
		await Promise.resolve();
		expect(stable).toBe(false);
		admission?.release();
		await waiting;
		expect(stable).toBe(true);
	});

	test("checkpoint fence has no deadline and only ends on readiness or cancellation", async () => {
		const response = await beginNarratorResponseActivity("slow-response");
		scheduleUpdate("9.9.9");
		beginQuiescingTools();

		let settled = false;
		const waiting = waitForUpdateCheckpointFence().then(
			() => {
				settled = true;
			},
			(error: unknown) => {
				settled = true;
				throw error;
			},
		);
		// A response legitimately outlives any short deadline (first-token timeout plus retries),
		// so the fence must still be open well past the former 30s budget.
		await Bun.sleep(60);
		expect(settled).toBe(false);
		expect(getUpdateCoordinationStatus()).toMatchObject({
			activeResponseCount: 1,
			cancelRequested: false,
		});

		expect(cancelScheduledUpdate("operator asked to stop")).toBe(true);
		await expect(waiting).rejects.toBeInstanceOf(UpdateCancelledError);
		expect(getUpdateCoordinationStatus().cancelRequested).toBe(true);
		response.release();
	});

	test("cancellation unblocks the drain waits and clears once the update is abandoned", async () => {
		const backgroundBash = tryAcquireFinalUpdateExecution("background_bash", "narrator-bg");
		expect(backgroundBash).not.toBeNull();
		scheduleUpdate("9.9.9");

		const draining = waitForBackgroundBashDrain();
		await Promise.resolve();
		expect(cancelScheduledUpdate()).toBe(true);
		await expect(draining).rejects.toBeInstanceOf(UpdateCancelledError);

		// A wait started after cancellation fails immediately instead of hanging.
		await expect(waitForOrdinaryToolDrain()).rejects.toBeInstanceOf(UpdateCancelledError);
		expect(() => assertUpdateNotCancelled()).toThrow(UpdateCancelledError);

		failScheduledUpdate("cancelled by operator", { cancelled: true });
		expect(getUpdateCoordinationStatus()).toMatchObject({
			phase: "idle",
			cancelRequested: false,
			errorKind: "cancelled",
		});
		backgroundBash?.release();

		// The next attempt must not inherit the previous epoch's cancellation.
		scheduleUpdate("9.9.10");
		const rescheduled = getUpdateCoordinationStatus();
		expect(rescheduled.cancelRequested).toBe(false);
		expect(rescheduled.errorKind).toBeUndefined();
		expect(rescheduled.error).toBeUndefined();
		expect(() => assertUpdateNotCancelled()).not.toThrow();
	});

	test("cancelling without a scheduled update is a no-op", () => {
		expect(cancelScheduledUpdate()).toBe(false);
		expect(getUpdateCoordinationStatus().cancelRequested).toBe(false);
	});

	test("status reports the blockers holding a scheduled update open", async () => {
		const response = await beginNarratorResponseActivity("blocking-narrator");
		// A grant issued during phase one is exactly the case a fence wait must observe: the tool
		// has already started, so it can still add rows after the phase switch.
		const admission = beginToolStartAdmission("ordinary", "grant-narrator", "grant-tool-use");
		expect(admission.status).toBe("granted");
		scheduleUpdate("9.9.9");
		beginQuiescingTools();

		const blockers = getUpdateCoordinationStatus().blockers;
		expect(blockers.map((blocker) => blocker.kind).sort()).toEqual([
			"response",
			"tool_start_grant",
		]);
		expect(blockers.find((blocker) => blocker.kind === "tool_start_grant")).toMatchObject({
			narratorId: "grant-narrator",
			toolUseId: "grant-tool-use",
		});

		if (admission.status === "granted") admission.grant.release();
		response.release();
	});

	test("phase two prevents a new narrator response from entering the checkpoint fence", async () => {
		scheduleUpdate("9.9.9");
		beginQuiescingTools();
		let entered = false;
		const responsePromise = beginNarratorResponseActivity("late-response").then((lease) => {
			entered = true;
			return lease;
		});
		await Promise.resolve();
		expect(entered).toBe(false);
		await waitForUpdateCheckpointFence();

		failScheduledUpdate("test failure");
		const response = await responsePromise;
		expect(entered).toBe(true);
		response.release();
	});

	test("failed update returns to idle and wakes paused tools without a tool failure result", async () => {
		scheduleUpdate("1.0.0");
		beginQuiescingTools();

		let resumed = false;
		const waiting = waitUntilUpdateGateOpens().then(() => {
			resumed = true;
		});
		await Promise.resolve();
		expect(resumed).toBe(false);
		expect(getUpdateCoordinationStatus().pausedToolCount).toBe(1);

		const failed = failScheduledUpdate("spawn failed");
		await waiting;
		expect(resumed).toBe(true);
		expect(failed).toMatchObject({
			phase: "idle",
			scheduled: false,
			pausedToolCount: 0,
			error: "spawn failed",
		});
		expect(tryAcquireFinalUpdateExecution("ordinary")).not.toBeNull();
	});

	test("captures and persists a version 2 manifest with the scheduled update epoch", () => {
		const unregisterLoop = registerNarratorLoop("narrator-1", "zh-CN", {
			userId: "user-1",
			replyInUserLanguage: true,
		});
		const ordinary = tryAcquireFinalUpdateExecution("ordinary", "subagent-1");
		const scheduled = scheduleUpdate("2.0.0");
		const updateEpoch = scheduled.updateEpoch;
		expect(updateEpoch).toBeString();
		if (!updateEpoch) throw new Error("Scheduled update must have an epoch");

		const snapshot = capturePlannedUpdateRecoverySnapshot();
		expect(snapshot).toEqual({
			version: 2,
			updateEpoch,
			targetVersion: "2.0.0",
			capturedAt: expect.any(String),
			narrators: [
				{
					narratorId: "narrator-1",
					locale: "zh-CN",
					userId: "user-1",
					replyInUserLanguage: true,
				},
				{ narratorId: "subagent-1", locale: "en" },
			],
		});

		const written = writePlannedUpdateRecoverySnapshot(snapshot);
		expect(written.version).toBe(2);
		expect(consumePlannedUpdateRecoverySnapshot()).toEqual(written);
		expect(consumePlannedUpdateRecoverySnapshot()).toEqual(written);

		const rewritten = writePlannedUpdateRecoverySnapshot({
			version: 2,
			targetVersion: written.targetVersion,
			capturedAt: new Date().toISOString(),
			narrators: written.narrators,
		});
		expect(rewritten.updateEpoch).toBe(updateEpoch);

		unregisterLoop();
		ordinary?.release();
	});

	test("parses a version 1 manifest into the version 2 shape", () => {
		const parsed = parsePlannedUpdateRecoverySnapshot({
			version: 1,
			targetVersion: "1.5.0",
			capturedAt: "2026-07-20T00:00:00.000Z",
			narrators: [{ narratorId: "narrator-1", locale: "en" }],
		});

		expect(parsed).toEqual({
			version: 2,
			updateEpoch: "legacy_2026_07_20T00_00_00_000Z",
			targetVersion: "1.5.0",
			capturedAt: "2026-07-20T00:00:00.000Z",
			narrators: [{ narratorId: "narrator-1", locale: "en" }],
		});
	});

	test("aborting a gate wait rejects and removes its abort listener", async () => {
		scheduleUpdate("9.9.9");
		beginQuiescingTools();

		const controller = new AbortController();
		const waiting = waitUntilUpdateGateOpens(controller.signal);
		await Promise.resolve();
		expect(getUpdateCoordinationStatus().pausedToolCount).toBe(1);

		controller.abort();
		await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
		// The waiter must be gone, not merely rejected: a leaked entry would keep the coordinator
		// reporting a paused tool that no longer exists.
		expect(getUpdateCoordinationStatus().pausedToolCount).toBe(0);

		// Opening the gate afterwards must not double-settle the already-rejected waiter.
		expect(() => failScheduledUpdate("cleanup")).not.toThrow();
	});

	test("an already-aborted signal fails the gate wait without registering a waiter", async () => {
		scheduleUpdate("9.9.9");
		beginQuiescingTools();
		const controller = new AbortController();
		controller.abort();

		await expect(waitUntilUpdateGateOpens(controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(getUpdateCoordinationStatus().pausedToolCount).toBe(0);
	});

	test("an aborted gate waiter is not resolved when the gate later opens", async () => {
		scheduleUpdate("9.9.9");
		beginQuiescingTools();
		const controller = new AbortController();
		const aborted = waitUntilUpdateGateOpens(controller.signal);
		const surviving = waitUntilUpdateGateOpens();
		await Promise.resolve();
		expect(getUpdateCoordinationStatus().pausedToolCount).toBe(2);

		controller.abort();
		await expect(aborted).rejects.toMatchObject({ name: "AbortError" });

		let resumed = false;
		const survivingTracked = surviving.then(() => {
			resumed = true;
		});
		failScheduledUpdate("spawn failed");
		await survivingTracked;
		expect(resumed).toBe(true);
	});

	test("gate waiting is a no-op once the coordinator is idle", async () => {
		await expect(waitUntilUpdateGateOpens()).resolves.toBeUndefined();
		const controller = new AbortController();
		controller.abort();
		// Idle short-circuits before the abort check, so an aborted signal is irrelevant here.
		await expect(waitUntilUpdateGateOpens(controller.signal)).resolves.toBeUndefined();
	});

	test("a rejected tool start becomes a durable pause that fences checkpointing", async () => {
		const scheduled = scheduleUpdate("9.9.9");
		beginQuiescingTools();

		const admission = beginToolStartAdmission("ordinary", "narrator-late", "tool-late");
		expect(admission.status).toBe("paused");
		if (admission.status !== "paused") throw new Error("Expected a paused admission");
		expect(admission.updateEpoch).toBe(scheduled.updateEpoch as string);
		expect(getUpdateCoordinationStatus()).toMatchObject({
			pendingPreAdmissionCount: 1,
			pendingToolStartGrantCount: 0,
		});

		let stable = false;
		const fence = waitForUpdateCheckpointFence().then(() => {
			stable = true;
		});
		await Promise.resolve();
		expect(stable).toBe(false);

		admission.activity.release();
		await fence;
		expect(stable).toBe(true);
		expect(getUpdateCoordinationStatus().pendingPreAdmissionCount).toBe(0);
	});

	test("background Bash is rejected during phase one while ordinary work is still admitted", () => {
		scheduleUpdate("9.9.9");
		const rejected = beginToolStartAdmission("background_bash", "narrator-bg", "tool-bg");
		expect(rejected.status).toBe("paused");
		const granted = beginToolStartAdmission("ordinary", "narrator-ord", "tool-ord");
		expect(granted.status).toBe("granted");
		if (rejected.status === "paused") rejected.activity.release();
		if (granted.status === "granted") granted.grant.release();
	});

	test("pre-admission activity is refused for a stale epoch and while idle", () => {
		// Idle: nothing to fence, so no activity may be registered.
		expect(beginUpdatePreAdmissionActivity("any-epoch", "narrator-1", "tool-1")).toBeNull();

		const scheduled = scheduleUpdate("9.9.9");
		if (!scheduled.updateEpoch) throw new Error("Expected update epoch");
		// A tool paused by a previous attempt must not fence the current one.
		expect(beginUpdatePreAdmissionActivity("stale-epoch", "narrator-1", "tool-1")).toBeNull();
		expect(getUpdateCoordinationStatus().pendingPreAdmissionCount).toBe(0);

		const activity = beginUpdatePreAdmissionActivity(scheduled.updateEpoch, "narrator-1", "tool-1");
		expect(activity).not.toBeNull();
		activity?.release();
	});

	test("blockers are sorted oldest first and capped for the status payload", async () => {
		const leases = [];
		// 12 blockers exceeds the 10-entry status limit.
		for (let index = 0; index < 12; index++) {
			const lease = tryAcquireFinalUpdateExecution("ordinary", `narrator-${index}`);
			expect(lease).not.toBeNull();
			leases.push(lease);
			// Stagger start times so the sort order is observable without relying on insertion order.
			await Bun.sleep(2);
		}
		// Resumable work never blocks a restart, so it must not appear among the blockers.
		const resumable = tryAcquireFinalUpdateExecution("resumable", "narrator-resumable");
		scheduleUpdate("9.9.9");

		const blockers = getUpdateCoordinationStatus().blockers;
		expect(blockers).toHaveLength(10);
		expect(blockers.every((blocker) => blocker.kind === "ordinary")).toBe(true);
		// Longest wait first.
		const waits = blockers.map((blocker) => blocker.waitingMs);
		expect([...waits].sort((a, b) => b - a)).toEqual(waits);
		// The two most recent leases are the ones dropped by the cap.
		expect(blockers.map((blocker) => blocker.narratorId)).not.toContain("narrator-11");
		expect(blockers.map((blocker) => blocker.narratorId)).toContain("narrator-0");

		resumable?.release();
		for (const lease of leases) lease?.release();
	});

	test("an idle coordinator reports no blockers even while work is running", () => {
		const lease = tryAcquireFinalUpdateExecution("ordinary", "narrator-idle");
		expect(getUpdateCoordinationStatus().blockers).toEqual([]);
		lease?.release();
	});

	test("repeated scheduling keeps the original epoch and legacy callers still compile", () => {
		const first = scheduleUpdate("1.0.0");
		const second = scheduleUpdate("2.0.0");
		expect(second.targetVersion).toBe("1.0.0");
		expect(second.phase).toBe("draining_background_bash");
		expect(second.updateEpoch).toBe(first.updateEpoch);

		// Legacy subagent maps to ordinary work and remains admissible during phase one.
		const legacyLease = tryAcquireUpdateExecution("subagent", "narrator-1");
		expect(legacyLease?.kind).toBe("ordinary");
		legacyLease?.release();
	});
});

describe("recovery manifest epoch guard", () => {
	beforeEach(() => {
		resetUpdateCoordinationForTests();
	});

	afterEach(() => {
		resetUpdateCoordinationForTests();
	});

	function manifest(updateEpoch: string, targetVersion: string) {
		return {
			version: 2 as const,
			updateEpoch,
			targetVersion,
			capturedAt: new Date().toISOString(),
			narrators: [],
		};
	}

	test("write with a matching guard replaces a stale manifest owned by the same epoch", () => {
		writePlannedUpdateRecoverySnapshot(manifest("epoch-a", "1.0.0"));
		const written = writePlannedUpdateRecoverySnapshot(manifest("epoch-a", "1.1.0"), {
			expectedEpoch: "epoch-a",
		});
		expect(written.targetVersion).toBe("1.1.0");
		expect(consumePlannedUpdateRecoverySnapshot()).toMatchObject({
			updateEpoch: "epoch-a",
			targetVersion: "1.1.0",
		});
	});

	test("guarded write rejects a manifest owned by a different epoch", () => {
		writePlannedUpdateRecoverySnapshot(manifest("epoch-new", "2.0.0"));
		// A stale attempt tries to persist evidence for its own (older) epoch.
		expect(() =>
			writePlannedUpdateRecoverySnapshot(manifest("epoch-stale", "1.0.0"), {
				expectedEpoch: "epoch-stale",
			}),
		).toThrow(/refusing to replace/);
		expect(consumePlannedUpdateRecoverySnapshot()).toMatchObject({
			updateEpoch: "epoch-new",
			targetVersion: "2.0.0",
		});
	});

	test("normal checkpoint write cannot take over a manifest from another epoch", () => {
		writePlannedUpdateRecoverySnapshot(manifest("epoch-a", "1.0.0"));
		expect(() => writePlannedUpdateRecoverySnapshot(manifest("epoch-b", "2.0.0"))).toThrow(
			/refusing to replace/,
		);
		expect(consumePlannedUpdateRecoverySnapshot()).toMatchObject({
			updateEpoch: "epoch-a",
			targetVersion: "1.0.0",
		});
	});

	test("guarded write onto an absent manifest still writes (nothing to protect)", () => {
		const written = writePlannedUpdateRecoverySnapshot(manifest("epoch-a", "1.0.0"), {
			expectedEpoch: "epoch-a",
		});
		expect(written.updateEpoch).toBe("epoch-a");
		expect(consumePlannedUpdateRecoverySnapshot()).toMatchObject({ updateEpoch: "epoch-a" });
	});

	test("guarded write throws when the snapshot epoch disagrees with the declared epoch", () => {
		expect(() =>
			writePlannedUpdateRecoverySnapshot(manifest("epoch-a", "1.0.0"), {
				expectedEpoch: "epoch-b",
			}),
		).toThrow(/epoch guard mismatch/);
	});

	test("guarded remove deletes only a manifest owned by the expected epoch", () => {
		writePlannedUpdateRecoverySnapshot(manifest("epoch-a", "1.0.0"));
		removePlannedUpdateRecoverySnapshot({ expectedEpoch: "epoch-a" });
		expect(consumePlannedUpdateRecoverySnapshot()).toBeNull();
	});

	test("guarded remove preserves a manifest owned by a different epoch", () => {
		writePlannedUpdateRecoverySnapshot(manifest("epoch-new", "2.0.0"));
		// A stale cleanup for an older epoch must not delete the newer epoch's manifest.
		removePlannedUpdateRecoverySnapshot({ expectedEpoch: "epoch-stale" });
		expect(consumePlannedUpdateRecoverySnapshot()).toMatchObject({
			updateEpoch: "epoch-new",
			targetVersion: "2.0.0",
		});
	});

	test("legacy writes derive their own epoch instead of borrowing the current owner", () => {
		writePlannedUpdateRecoverySnapshot(manifest("epoch-current", "3.0.0"));
		expect(() =>
			writePlannedUpdateRecoverySnapshot({
				version: 1,
				targetVersion: "2.0.0",
				capturedAt: "2026-07-20T00:00:00.000Z",
				narrators: [],
			}),
		).toThrow(/refusing to replace/);
		expect(consumePlannedUpdateRecoverySnapshot()).toMatchObject({
			updateEpoch: "epoch-current",
		});
	});

	test("a guarded rewrite binds the manifest to the spawned replacement's nonce", () => {
		writePlannedUpdateRecoverySnapshot(manifest("epoch-a", "1.0.0"));
		expect(consumePlannedUpdateRecoverySnapshot()?.handoffMarkerNonce).toBeUndefined();

		// The manifest is written before the handoff session exists, then bound once the nonce is known.
		writePlannedUpdateRecoverySnapshot(manifest("epoch-a", "1.0.0"), {
			expectedEpoch: "epoch-a",
			handoffMarkerNonce: "nonce-a",
		});

		expect(consumePlannedUpdateRecoverySnapshot()?.handoffMarkerNonce).toBe("nonce-a");
	});
});

describe("recovery manifest ownership", () => {
	test("only the replacement process carrying the bound nonce owns the manifest", () => {
		expect(
			classifyRecoveryManifestOwnership(
				{ handoffMarkerNonce: "nonce-a" },
				{ markerNonce: "nonce-a" },
			),
		).toEqual({ owned: true });
	});

	test("an ordinary restart never owns a leftover manifest", () => {
		// The abandoned-narrator regression: without a handoff there is no update to resume for.
		expect(classifyRecoveryManifestOwnership({ handoffMarkerNonce: "nonce-a" }, null)).toEqual({
			owned: false,
			reason: "not_a_replacement_process",
		});
		expect(classifyRecoveryManifestOwnership({}, null)).toEqual({
			owned: false,
			reason: "not_a_replacement_process",
		});
	});

	test("a manifest from a different update attempt is not owned", () => {
		expect(
			classifyRecoveryManifestOwnership(
				{ handoffMarkerNonce: "nonce-a" },
				{ markerNonce: "nonce-b" },
			),
		).toEqual({ owned: false, reason: "handoff_nonce_mismatch" });
	});

	test("an evidence-only manifest is never owned, even by a real replacement", () => {
		expect(
			classifyRecoveryManifestOwnership({ evidenceOnly: true }, { markerNonce: "nonce-a" }),
		).toEqual({ owned: false, reason: "evidence_only" });
	});

	test("a nonce-less manifest stays claimable by a handoff-spawned process", () => {
		// Written either before the replacement was spawned, or by a pre-nonce binary. Rejecting it
		// would silently drop the one legitimate resume during the upgrade that introduces binding.
		expect(classifyRecoveryManifestOwnership({}, { markerNonce: "nonce-a" })).toEqual({
			owned: true,
		});
		expect(classifyRecoveryManifestOwnership({}, {})).toEqual({ owned: true });
	});
});
