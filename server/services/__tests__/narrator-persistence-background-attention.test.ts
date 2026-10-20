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

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { backgroundTasks, narrators } from "../../db/schema";
import type { NarraForkEvent } from "../../lib/event-bus";

const { db, sqlite } = getTestDb();
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
const NARRATOR_ID = "bg-attention-narrator";
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
	seedNarrator();
});

afterEach(() => {
	cleanDb(sqlite);
});

afterAll(() => {
	eventBus.off("narrator:attention", attentionHandler);
	backgroundOccupancyStore.resetForTests();
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWs);
	mock.restore();
	cleanDb(sqlite);
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
