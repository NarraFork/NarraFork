import { afterAll, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { getTestDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { readQuery } = await import("../../db/worker-read");
const state = await import("../narrator-session-state");
const inbox = await import("../agent-runtime/inbox");
const session = await import("../narrator-session");
const coordinator = await import("../update-coordinator");
const { awaitRunHold } = await import("../agent-runtime/run");
const { tryClaimExecution, setRunControl, setRunHold } = await import("../agent-runtime/ownership");
type RunControl = import("../agent-runtime/ownership").RunControl;
type RunResult = import("../agent-runtime/ownership").RunResult;
afterAll(() => {
	coordinator.resetUpdateCoordinationForTests();
	mock.restore();
});

test("shutdown freezes starts while admitted finalization and terminal ownership drain", async () => {
	const id = "shutdown-admission-fixture";
	const now = new Date().toISOString();
	db.insert(narrators)
		.values({
			id,
			type: "primary",
			variant: "primary",
			status: "idle",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const terminal = Promise.withResolvers<void>();
	let persisted = false;
	const running = state.withNarratorWorkAdmission(id, async () => {
		entered.resolve();
		await finish.promise;
		await expect(
			Promise.resolve().then(() => state.withNarratorStartAdmission(id, async () => {})),
		).rejects.toMatchObject({ code: "NARRATOR_SHUTTING_DOWN" });
		await state.withNarratorWorkAdmission(id, async () => {
			const row = await readQuery(
				db.select({ id: narrators.id }).from(narrators).where(eq(narrators.id, id)),
			);
			expect(row[0]?.id).toBe(id);
			persisted = true;
		});
		return terminal.promise;
	});
	await entered.promise;
	const controller = new AbortController();
	state.activeNarrators.set(id, {
		narratorId: id,
		alive: true,
		abortController: controller,
		events: new EventEmitter(),
	} as import("../narrator-session-state").ActiveNarrator);
	const foreground = new AbortController();
	const background = new AbortController();
	const owner = tryClaimExecution(id, "run");
	const backgroundOwner = tryClaimExecution(`${id}-background`, "run");
	if (!owner || !backgroundOwner) throw new Error("Missing fixture run owners");
	const foregroundRun: RunControl = {
		startedAt: Date.now(),
		cancel: foreground,
		timedOut: false,
		terminal: Promise.withResolvers<RunResult>().promise,
	};
	const backgroundRun: RunControl = {
		startedAt: Date.now(),
		cancel: background,
		timedOut: false,
		terminal: Promise.withResolvers<RunResult>().promise,
	};
	setRunControl(owner, foregroundRun);
	setRunControl(backgroundOwner, backgroundRun);
	setRunHold(id, { released: false });
	coordinator.scheduleUpdate("9.9.9");
	coordinator.beginQuiescingTools();
	const gateEntered = Promise.withResolvers<void>();
	const gate = state.withNarratorWorkAdmission(id, async () => {
		gateEntered.resolve();
		await coordinator.beginNarratorResponseActivity(id, controller.signal);
	});
	void gate.catch(() => {});
	await gateEntered.promise;
	// A scheduled wake is owned even when the freeze wins before its first microtask.
	const pendingWake = inbox.wakeInboxIfEligible(id);
	state.freezeNarratorAdmissionForShutdown();
	const lateController = new AbortController();
	state.abortLateNarratorControllerForShutdown(lateController);
	expect(lateController.signal.aborted).toBe(false);
	session.abortNarratorExecutionsForShutdown();
	state.abortLateNarratorControllerForShutdown(lateController);
	expect(lateController.signal.reason).toBe(state.getNarratorShutdownAbortReason());
	expect(foreground.signal.reason).toBe(state.getNarratorShutdownAbortReason());
	expect(background.signal.reason).toBe(state.getNarratorShutdownAbortReason());
	await expect(gate).rejects.toBe(state.getNarratorShutdownAbortReason());
	await expect(coordinator.waitUntilUpdateGateOpens(lateController.signal)).rejects.toBe(
		state.getNarratorShutdownAbortReason(),
	);
	expect(await pendingWake).toBe(false);
	expect(
		db
			.select({ reason: narrators.lastStopReason })
			.from(narrators)
			.where(eq(narrators.id, id))
			.get()?.reason,
	).not.toBe("user_interrupt");
	const active = state.activeNarrators.get(id);
	if (!active) throw new Error("Missing fixture active narrator");
	active.abortController = new AbortController();
	state.abortLateNarratorControllerForShutdown(active.abortController);
	expect(active.abortController.signal.reason).toBe(state.getNarratorShutdownAbortReason());
	try {
		expect(await awaitRunHold(owner, foregroundRun, async () => false)).toBe("cancel");
	} finally {
		owner.release();
		backgroundOwner.release();
		setRunHold(id, undefined);
	}
	state.activeNarrators.delete(id);
	let drained = false;
	const drain = state.drainNarratorAdmissionWork(new AbortController().signal).then(() => {
		drained = true;
	});
	await expect(
		Promise.resolve().then(() => state.withNarratorStartAdmission(id, async () => {})),
	).rejects.toMatchObject({ code: "NARRATOR_SHUTTING_DOWN" });
	expect(await inbox.wakeInboxIfEligible(id)).toBe(false);
	finish.resolve();
	await Promise.resolve();
	expect(drained).toBe(false);
	const abort = new AbortController();
	const cancelledDrain = state.drainNarratorAdmissionWork(abort.signal);
	abort.abort(new Error("fixture deadline"));
	await expect(cancelledDrain).rejects.toThrow("fixture deadline");
	terminal.resolve();
	await running;
	await drain;
	expect(persisted).toBe(true);
	expect(state.getNarratorShutdownPendingCount()).toBe(0);
	await inbox.drainPendingInboxWakes(new AbortController().signal);
	state.recordNarratorShutdownFailure(new Error("final persistence failed"));
	await expect(state.drainNarratorAdmissionWork(new AbortController().signal)).rejects.toThrow(
		"final persistence failed",
	);
});
