/**
 * Done-transition background-work flag on `narrator:attention` / `status_change`.
 *
 * When a turn finishes (idle + unread) while wake-capable background work is
 * still running (background bash tasks, background subagents), the attention
 * event and the WS status_change broadcast carry `backgroundWorkActive: true`
 * so notification channels (IM webhooks, recent-tab IM pings, sound, PWA) can
 * suppress the ping while hooks still observe the event. A pure service must
 * NOT suppress, and neither must a transfer: its terminal commit skips
 * publication, so nothing would re-raise a swallowed done.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { backgroundTasks, narratorMessages, narrators, users } from "../../db/schema";
import type { NarraForkEvent } from "../../lib/event-bus";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
const { db, sqlite } = fixture;
await fixture.ready;
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const wsBroadcasts: Array<{ narratorId: string; message: Record<string, unknown> }> = [];
const realNarratorWs = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({
	...realNarratorWs,
	broadcastToNarrator: (narratorId: string, message: Record<string, unknown>) => {
		wsBroadcasts.push({ narratorId, message });
	},
}));

// narrator-service must be imported before narrator-persistence: the two form a
// module-init cycle and narrator-service binds persistence methods at evaluation.
await import("../narrator-service");
const { narratorPersistence } = await import("../narrator-persistence");
const { eventBus } = await import("../../lib/event-bus");
const { backgroundOccupancyStore } = await import("../background-occupancy-store");

type AttentionEvent = Extract<NarraForkEvent, { type: "narrator:attention" }>;

const NOW = "2026-10-05T00:00:00.000Z";
let NARRATOR_ID = "bg-attention-narrator";
let narratorSerial = 0;
const CHILD_ID = "bg-attention-child";

const attentionEvents: AttentionEvent[] = [];
const attentionHandler = (event: AttentionEvent) => {
	attentionEvents.push(event);
};
eventBus.on("narrator:attention", attentionHandler);

function seedNarrator(): void {
	db.insert(narrators)
		.values({
			id: NARRATOR_ID,
			status: "working",
			substatus: "[]",
			visibility: "public",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedBashTask(id: string, backgroundKind: "task" | "service"): void {
	db.insert(backgroundTasks)
		.values({
			id,
			parentNarratorId: NARRATOR_ID,
			type: "bash",
			backgroundKind,
			status: "running",
			startedAt: NOW,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	backgroundOccupancyStore.refreshTask(id);
}

function seedTransferTask(id: string): void {
	db.insert(backgroundTasks)
		.values({
			id,
			parentNarratorId: NARRATOR_ID,
			type: "transfer",
			status: "running",
			startedAt: NOW,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	backgroundOccupancyStore.refreshTask(id);
}

function seedAgentTask(id: string): void {
	db.insert(narrators)
		.values({
			id: CHILD_ID,
			parentNarratorId: NARRATOR_ID,
			type: "subagent",
			status: "working",
			substatus: "[]",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	db.insert(backgroundTasks)
		.values({
			id,
			parentNarratorId: NARRATOR_ID,
			type: "agent",
			subagentNarratorId: CHILD_ID,
			status: "running",
			startedAt: NOW,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	backgroundOccupancyStore.refreshTask(id);
}

/** Finish the narrator's turn the way the agent loop does. */
async function finishTurn(): Promise<void> {
	const transitioned = await narratorPersistence.compareAndSetStatus(
		NARRATOR_ID,
		"working",
		"idle",
		{
			substatus: ["unread"],
		},
	);
	expect(transitioned).toBe(true);
}

/** The other done path: updateStatus (used by the unified runtime's settleStatus). */
async function finishTurnViaUpdateStatus(): Promise<void> {
	await narratorPersistence.updateStatus(NARRATOR_ID, "idle", { substatus: ["unread"] });
}

function lastStatusChange(): Record<string, unknown> | undefined {
	return wsBroadcasts.findLast((entry) => entry.message.type === "status_change")?.message;
}

beforeEach(async () => {
	cleanDb(sqlite);
	backgroundOccupancyStore.resetForTests();
	await backgroundOccupancyStore.start();
	attentionEvents.length = 0;
	wsBroadcasts.length = 0;
	// Counts cache by immutable narrator id/version; a reset is a different narrator, not a rewind.
	NARRATOR_ID = `bg-attention-narrator-${++narratorSerial}`;
	seedNarrator();
});

afterEach(async () => {
	await backgroundOccupancyStore.flush();
	cleanDb(sqlite);
});

afterAll(async () => {
	eventBus.off("narrator:attention", attentionHandler);
	backgroundOccupancyStore.resetForTests();
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWs);
	mock.restore();
	cleanDb(sqlite);
	await fixture.close();
});

describe("committed status patches", () => {
	for (const writer of ["updateStatus", "compareAndSetStatus"] as const) {
		test(`${writer} publishes committed timestamp, exact count instead of stored upper bound, and nullable clears`, async () => {
			const future = "2099-01-01T00:00:00.000Z";
			db.update(narrators)
				.set({
					updatedAt: future,
					messageCount: 17,
					errorMessage: "stale error",
					errorRetryable: true,
					archivedWithNarratorId: NARRATOR_ID,
					turnStartedAt: null,
					model: "keep-model",
				})
				.where(eq(narrators.id, NARRATOR_ID))
				.run();
			if (writer === "updateStatus")
				await narratorPersistence.updateStatus(NARRATOR_ID, "idle", { substatus: [] });
			else
				expect(
					await narratorPersistence.compareAndSetStatus(NARRATOR_ID, "working", "idle", {
						substatus: [],
					}),
				).toBe(true);
			expect(lastStatusChange()).toEqual({
				type: "status_change",
				narratorId: NARRATOR_ID,
				status: "idle",
				substatus: [],
				turnStartedAt: null,
				updatedAt: future,
				messageCount: 0,
				statusEpoch: expect.any(String),
				statusRevision: expect.any(Number),
				errorMessage: null,
				errorRetryable: null,
				archivedWithNarratorId: null,
			});
		});

		test(`${writer} includes error state and existing turn when substatus is omitted`, async () => {
			const turnStartedAt = "2026-10-04T00:00:00.000Z";
			db.update(narrators)
				.set({ turnStartedAt, substatus: '["interrupted"]' })
				.where(eq(narrators.id, NARRATOR_ID))
				.run();
			const options = {
				substatus: ["error"],
				errorMessage: "private upstream failure",
				diagnostics: { schema: "narrafork.error-diagnostics.v1" as const, retryable: false },
				skipErrorMessage: true,
			};
			if (writer === "updateStatus")
				await narratorPersistence.updateStatus(NARRATOR_ID, "idle", options);
			else await narratorPersistence.compareAndSetStatus(NARRATOR_ID, "working", "idle", options);
			expect(lastStatusChange()).toMatchObject({
				errorMessage: "private upstream failure",
				errorRetryable: false,
				turnStartedAt,
			});
			// A write that leaves substatus untouched must still publish the committed value.
			if (writer === "updateStatus") await narratorPersistence.updateStatus(NARRATOR_ID, "idle");
			else await narratorPersistence.compareAndSetStatus(NARRATOR_ID, "idle", "idle");
			expect(lastStatusChange()).toMatchObject({
				substatus: JSON.parse(
					db.select().from(narrators).where(eq(narrators.id, NARRATOR_ID)).get()?.substatus ?? "[]",
				),
				turnStartedAt,
				errorMessage: null,
				errorRetryable: null,
			});
		});
	}

	test("error-card insertion publishes its newer committed messageCount without promoting old status", async () => {
		await narratorPersistence.updateStatus(NARRATOR_ID, "idle", {
			substatus: ["error"],
			errorMessage: "persist this error card",
		});
		const frames = wsBroadcasts
			.map(({ message }) => message)
			.filter((message) => message.type === "status_change");
		expect(frames).toHaveLength(2);
		const [afterCard, originalStatus] = frames;
		expect(afterCard.statusRevision as number).toBeGreaterThan(
			originalStatus.statusRevision as number,
		);
		expect(afterCard.messageCount).toBe(1);
		// The final old patch observes a newer messageVersion: omit instead of mixing versions.
		expect(originalStatus).not.toHaveProperty("messageCount");
		expect(afterCard).toMatchObject({ status: "idle", errorMessage: "persist this error card" });
	});

	test("rejected or missing-row writes publish no fabricated patch", async () => {
		expect(await narratorPersistence.compareAndSetStatus(NARRATOR_ID, "idle", "working")).toBe(
			false,
		);
		expect(await narratorPersistence.updateStatus("missing", "working")).toBe(false);
		db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, NARRATOR_ID)).run();
		expect(
			await narratorPersistence.updateStatus(NARRATOR_ID, "idle", { unlessArchived: true }),
		).toBe(false);
		expect(lastStatusChange()).toBeUndefined();
	});
});

describe("committed status ordering", () => {
	for (const writer of ["updateStatus", "compareAndSetStatus"] as const) {
		test(`${writer}: deferred idle occupancy keeps an older revision than newer working/substatus`, async () => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const flush = spyOn(backgroundOccupancyStore, "flush").mockImplementationOnce(() => {
				entered.resolve();
				return release.promise;
			});
			try {
				const terminal =
					writer === "updateStatus"
						? narratorPersistence.updateStatus(NARRATOR_ID, "idle", { substatus: ["unread"] })
						: narratorPersistence.compareAndSetStatus(NARRATOR_ID, "working", "idle", {
								substatus: ["unread"],
							});
				await entered.promise;
				await narratorPersistence.updateStatus(NARRATOR_ID, "working");
				await narratorPersistence.addSubstatus(NARRATOR_ID, "reflecting");
				release.resolve();
				await terminal;
				const frames = wsBroadcasts
					.map(({ message }) => message)
					.filter((message) =>
						["status_change", "substatus_change"].includes(message.type as string),
					);
				expect(frames).toHaveLength(3);
				const [working, substatus, idle] = frames;
				expect(working).toMatchObject({ status: "working", type: "status_change" });
				expect(substatus).toMatchObject({
					type: "substatus_change",
					status: "working",
					substatus: ["reflecting"],
					errorMessage: null,
					errorRetryable: null,
					archivedWithNarratorId: null,
					turnStartedAt: null,
					updatedAt: expect.any(String),
				});
				expect(idle).toMatchObject({ status: "idle", substatus: ["unread"] });
				expect(idle.statusEpoch).toBe(working.statusEpoch);
				expect(substatus.statusEpoch).toBe(working.statusEpoch);
				expect(idle.statusRevision as number).toBeLessThan(working.statusRevision as number);
				expect(working.statusRevision as number).toBeLessThan(substatus.statusRevision as number);
			} finally {
				release.resolve();
				flush.mockRestore();
			}
		});
	}

	test("update/add/remove substatus each publish a complete, increasing committed patch", async () => {
		await narratorPersistence.updateSubstatus(NARRATOR_ID, ["reasoning"]);
		await narratorPersistence.addSubstatus(NARRATOR_ID, "reflecting");
		await narratorPersistence.removeSubstatus(NARRATOR_ID, "reasoning");
		const frames = wsBroadcasts.map(({ message }) => message);
		expect(frames).toHaveLength(3);
		for (let index = 1; index < frames.length; index++)
			expect(frames[index].statusRevision as number).toBeGreaterThan(
				frames[index - 1].statusRevision as number,
			);
		for (const frame of frames) {
			expect(frame).toMatchObject({
				type: "substatus_change",
				status: "working",
				turnStartedAt: null,
				errorMessage: null,
				errorRetryable: null,
				archivedWithNarratorId: null,
				updatedAt: expect.any(String),
				statusEpoch: expect.any(String),
				statusRevision: expect.any(Number),
			});
		}
		expect(frames[2].substatus).toEqual(["reflecting"]);
	});
});

describe("exact status counts", () => {
	async function statusFixture() {
		const status = await import("../narrator-status-version");
		const row = db
			.select(status.narratorStatusPatchColumns)
			.from(narrators)
			.where(eq(narrators.id, NARRATOR_ID))
			.get();
		const committed = status.versionNarratorStatusCommit(row);
		if (!committed) throw new Error("Missing status fixture");
		return { status, committed };
	}

	test("concurrent same-version patches share one Worker read and retire settled in-flight work", async () => {
		const { status, committed } = await statusFixture();
		const counts = await import("../narrator-message-count");
		const gate = Promise.withResolvers<{ version: number; count: number }>();
		const reader = spyOn(counts, "readNarratorMessageRefCountSnapshot").mockImplementation(
			() => gate.promise,
		);
		try {
			const first = status.committedNarratorStatusPatch(NARRATOR_ID, committed);
			const second = status.committedNarratorStatusPatch(NARRATOR_ID, committed);
			expect(reader).toHaveBeenCalledTimes(1);
			gate.resolve({ version: committed.messageVersion, count: 5 });
			const patches = await Promise.all([first, second]);
			for (const patch of patches) {
				expect(patch.messageCount).toBe(5);
				expect(patch).not.toHaveProperty("messageVersion");
			}
			await status.committedNarratorStatusPatch(NARRATOR_ID, committed);
			expect(reader).toHaveBeenCalledTimes(2);
		} finally {
			gate.resolve({ version: committed.messageVersion, count: 5 });
			reader.mockRestore();
		}
	});

	test("different message versions never share their in-flight count read", async () => {
		const { status, committed } = await statusFixture();
		const counts = await import("../narrator-message-count");
		const firstGate = Promise.withResolvers<{ version: number; count: number }>();
		const secondGate = Promise.withResolvers<{ version: number; count: number }>();
		const reader = spyOn(counts, "readNarratorMessageRefCountSnapshot").mockImplementation(
			async (_id, version) =>
				version === committed.messageVersion ? firstGate.promise : secondGate.promise,
		);
		try {
			const first = status.committedNarratorStatusPatch(NARRATOR_ID, committed);
			const second = status.committedNarratorStatusPatch(NARRATOR_ID, {
				...committed,
				messageVersion: committed.messageVersion + 1,
			});
			expect(reader).toHaveBeenCalledTimes(2);
			firstGate.resolve({ version: committed.messageVersion, count: 3 });
			secondGate.resolve({ version: committed.messageVersion + 1, count: 4 });
			expect((await first).messageCount).toBe(3);
			expect((await second).messageCount).toBe(4);
		} finally {
			firstGate.resolve({ version: committed.messageVersion, count: 3 });
			secondGate.resolve({ version: committed.messageVersion + 1, count: 4 });
			reader.mockRestore();
		}
	});

	test("mismatched versions omit count and reader failures neither reuse the upper bound nor poison retries", async () => {
		const { status, committed } = await statusFixture();
		const counts = await import("../narrator-message-count");
		const reader = spyOn(counts, "readNarratorMessageRefCountSnapshot");
		const owningThread = spyOn(sqlite, "query");
		try {
			reader.mockResolvedValueOnce({ version: committed.messageVersion + 1, count: 99 });
			expect(await status.committedNarratorStatusPatch(NARRATOR_ID, committed)).not.toHaveProperty(
				"messageCount",
			);
			reader.mockRejectedValueOnce(new Error("required count Worker unavailable"));
			expect(await status.committedNarratorStatusPatch(NARRATOR_ID, committed)).not.toHaveProperty(
				"messageCount",
			);
			reader.mockResolvedValueOnce({ version: committed.messageVersion, count: 7 });
			expect((await status.committedNarratorStatusPatch(NARRATOR_ID, committed)).messageCount).toBe(
				7,
			);
			expect(reader).toHaveBeenCalledTimes(3);
			expect(owningThread).not.toHaveBeenCalled();
		} finally {
			reader.mockRestore();
			owningThread.mockRestore();
		}
	});
});

describe("other committed status producers", () => {
	for (const existing of [false, true]) {
		test(`dismiss ${existing ? "persisted" : "missing"} error publishes complete versioned clears`, async () => {
			const { narratorMessageQueries } = await import("../narrator-messages");
			db.update(narrators)
				.set({ errorMessage: "private error", errorRetryable: true })
				.where(eq(narrators.id, NARRATOR_ID))
				.run();
			if (existing)
				db.insert(narratorMessages)
					.values({
						id: "dismiss-error-card",
						narratorId: NARRATOR_ID,
						role: "system",
						contentJson: [{ type: "error", message: "private error" }],
						createdAt: NOW,
					})
					.run();
			await narratorMessageQueries.dismissErrorMessage(NARRATOR_ID, "dismiss-error-card");
			expect(lastStatusChange()).toMatchObject({
				status: "working",
				substatus: [],
				errorMessage: null,
				errorRetryable: null,
				archivedWithNarratorId: null,
				turnStartedAt: null,
				updatedAt: NOW,
				statusEpoch: expect.any(String),
				statusRevision: expect.any(Number),
			});
		});
	}

	test("unarchive publishes committed clears and monotonic time with a version", async () => {
		const { transitionNarratorArchiveGroup } = await import("../narrator-archive");
		db.insert(users)
			.values({ id: "status-admin", username: "status-admin", passwordHash: "x", createdAt: NOW })
			.run();
		const future = "2099-01-01T00:00:00.000Z";
		db.update(narrators)
			.set({
				status: "archived",
				errorMessage: "private error",
				errorRetryable: true,
				updatedAt: future,
			})
			.where(eq(narrators.id, NARRATOR_ID))
			.run();
		await transitionNarratorArchiveGroup(
			{ userId: "status-admin", isAdmin: true },
			NARRATOR_ID,
			"idle",
		);
		expect(lastStatusChange()).toEqual({
			type: "status_change",
			narratorId: NARRATOR_ID,
			status: "idle",
			substatus: [],
			errorMessage: null,
			errorRetryable: null,
			archivedWithNarratorId: null,
			turnStartedAt: null,
			updatedAt: future,
			messageCount: 0,
			statusEpoch: expect.any(String),
			statusRevision: expect.any(Number),
		});
	});
});

describe("done-transition backgroundWorkActive flag", () => {
	test("set when a background bash task is still running", async () => {
		seedBashTask("task-work", "task");

		await finishTurn();

		expect(attentionEvents).toEqual([
			{
				type: "narrator:attention",
				narratorId: NARRATOR_ID,
				reason: "done",
				backgroundWorkActive: true,
			},
		]);
		expect(lastStatusChange()).toMatchObject({
			type: "status_change",
			narratorId: NARRATOR_ID,
			status: "idle",
			backgroundWorkActive: true,
		});
	});

	test("set when a background subagent is still running", async () => {
		seedAgentTask("task-agent");

		await finishTurn();

		expect(attentionEvents).toHaveLength(1);
		expect(attentionEvents[0]?.backgroundWorkActive).toBe(true);
		expect(lastStatusChange()).toMatchObject({ backgroundWorkActive: true });
	});

	test("absent when only a service is running", async () => {
		seedBashTask("task-service", "service");

		await finishTurn();

		expect(attentionEvents).toEqual([
			{ type: "narrator:attention", narratorId: NARRATOR_ID, reason: "done" },
		]);
		expect(lastStatusChange()).toMatchObject({ type: "status_change", status: "idle" });
		expect(lastStatusChange()).not.toHaveProperty("backgroundWorkActive");
	});

	test("absent with no background tasks at all", async () => {
		await finishTurn();

		expect(attentionEvents).toEqual([
			{ type: "narrator:attention", narratorId: NARRATOR_ID, reason: "done" },
		]);
		expect(lastStatusChange()).not.toHaveProperty("backgroundWorkActive");
	});

	test("absent once the background task has completed before the turn ends", async () => {
		seedBashTask("task-finished", "task");
		db.update(backgroundTasks)
			.set({ status: "completed", completedAt: NOW, updatedAt: NOW })
			.where(eq(backgroundTasks.id, "task-finished"))
			.run();
		backgroundOccupancyStore.refreshTask("task-finished");

		await finishTurn();

		expect(attentionEvents).toEqual([
			{ type: "narrator:attention", narratorId: NARRATOR_ID, reason: "done" },
		]);
	});

	test("absent for a running transfer — its completion never wakes the parent", async () => {
		// A transfer's terminal commit skips publication, so no wake-up turn would
		// ever re-raise a suppressed done. Suppression keys on wake-work only.
		seedTransferTask("task-transfer");

		await finishTurn();

		expect(attentionEvents).toEqual([
			{ type: "narrator:attention", narratorId: NARRATOR_ID, reason: "done" },
		]);
		expect(lastStatusChange()).not.toHaveProperty("backgroundWorkActive");
	});

	test("set via the updateStatus done path as well (unified runtime settleStatus)", async () => {
		seedBashTask("task-work-update-status", "task");

		await finishTurnViaUpdateStatus();

		expect(attentionEvents).toEqual([
			{
				type: "narrator:attention",
				narratorId: NARRATOR_ID,
				reason: "done",
				backgroundWorkActive: true,
			},
		]);
		expect(lastStatusChange()).toMatchObject({
			type: "status_change",
			narratorId: NARRATOR_ID,
			status: "idle",
			backgroundWorkActive: true,
		});
	});
});
