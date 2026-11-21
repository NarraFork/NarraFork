import { afterEach, describe, expect, test } from "bun:test";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import {
	backgroundTasks,
	narratorBufferedMessages,
	narrators,
	scheduledTasks,
} from "../../db/schema";
import {
	type ActiveNarrator,
	activeNarrators,
	claimNarratorRuntime,
} from "../narrator-session-state";
import { isBlocked, probeUnattendedIdle } from "../unattended-probe";

const NOW = "2026-01-01T00:00:00.000Z";

function narrator(id: string, overrides: Record<string, unknown> = {}) {
	return db
		.insert(narrators)
		.values({ id, createdAt: NOW, updatedAt: NOW, ...overrides })
		.run();
}

afterEach(() => {
	activeNarrators.delete("busy-narrator");
	activeNarrators.delete("waiting-narrator");
	cleanDb(sqlite);
});

describe("unattended idle probe", () => {
	test("the active background task probe uses an index in the no-match case", () => {
		const plan = sqlite
			.query<{ detail: string }, []>(
				`EXPLAIN QUERY PLAN SELECT 1 AS hit FROM background_tasks
				  WHERE status IN ('running','paused') LIMIT 1`,
			)
			.all();
		expect(plan.map(({ detail }) => detail).join("\n")).toContain("idx_bg_tasks_active");
	});

	test("an empty instance is idle", async () => {
		const report = await probeUnattendedIdle({ dueWithinMs: 120_000 });
		expect(report.unknown).toBe(false);
		expect(isBlocked(report)).toBe(false);
		expect(report.narrators.count).toBe(0);
	});

	test("a running narrator blocks, and is named for diagnostics", async () => {
		activeNarrators.set("busy-narrator", {
			alive: true,
			_loopRunning: true,
			cwd: process.cwd(),
		} as ActiveNarrator);
		const report = await probeUnattendedIdle({ dueWithinMs: 120_000 });
		expect(report.narrators.count).toBe(1);
		expect(report.narrators.ids).toEqual(["busy-narrator"]);
		expect(isBlocked(report)).toBe(true);
	});

	test("a loop-less runtime claim blocks even with no live session", async () => {
		const release = claimNarratorRuntime("claimed-narrator", "unattended-probe-test");
		try {
			const report = await probeUnattendedIdle({ dueWithinMs: 120_000 });
			expect(report.narrators.count).toBe(1);
			expect(report.narrators.ids).toEqual(["claimed-narrator"]);
			expect(isBlocked(report)).toBe(true);
		} finally {
			release();
		}
		expect((await probeUnattendedIdle({ dueWithinMs: 120_000 })).narrators.count).toBe(0);
	});

	test("a stale DB 'working' row is reported but does not block on its own", async () => {
		narrator("orphaned", { status: "working" });
		const report = await probeUnattendedIdle({ dueWithinMs: 120_000 });
		expect(report.dbWorkingNarrators).toBe(1);
		expect(report.narrators.count).toBe(0);
		expect(isBlocked(report)).toBe(false);
	});

	test("a queued mailbox delivery blocks", async () => {
		await narrator("n1");
		db.insert(narratorBufferedMessages)
			.values({
				id: "m1",
				narratorId: "n1",
				text: "do the thing",
				seq: 1,
				bufferedAt: NOW,
				state: "queued",
			})
			.run();
		const report = await probeUnattendedIdle({ dueWithinMs: 120_000 });
		expect(report.queuedDeliveries).toBe(true);
		expect(isBlocked(report)).toBe(true);
	});

	test("a queued task notice never blocks: only a running loop consumes it", async () => {
		await narrator("n1");
		db.insert(narratorBufferedMessages)
			.values({
				id: "notice-1",
				narratorId: "n1",
				text: "background task finished",
				seq: 1,
				bufferedAt: NOW,
				state: "queued",
				kind: "task_notice",
				noticeKind: "bash",
			})
			.run();
		const report = await probeUnattendedIdle({ dueWithinMs: 120_000 });
		expect(report.queuedDeliveries).toBe(false);
		expect(isBlocked(report)).toBe(false);
	});

	test("an archived session's queued input is inert, a live session's is not", async () => {
		await narrator("archived-1", { status: "archived" });
		db.insert(narratorBufferedMessages)
			.values({
				id: "archived-msg",
				narratorId: "archived-1",
				text: "queued long ago",
				seq: 1,
				bufferedAt: NOW,
				state: "queued",
			})
			.run();
		expect((await probeUnattendedIdle({ dueWithinMs: 120_000 })).queuedDeliveries).toBe(false);

		await narrator("live-1");
		db.insert(narratorBufferedMessages)
			.values({
				id: "live-msg",
				narratorId: "live-1",
				text: "waiting for the loop",
				seq: 1,
				bufferedAt: NOW,
				state: "queued",
			})
			.run();
		expect((await probeUnattendedIdle({ dueWithinMs: 120_000 })).queuedDeliveries).toBe(true);
	});

	test("a terminally failed delivery does not hold the machine on", async () => {
		await narrator("n1");
		db.insert(narratorBufferedMessages)
			.values({
				id: "m-failed",
				narratorId: "n1",
				text: "gave up",
				seq: 1,
				bufferedAt: NOW,
				state: "failed",
				lastError: "claim attempts exhausted",
			})
			.run();
		const report = await probeUnattendedIdle({ dueWithinMs: 120_000 });
		expect(report.queuedDeliveries).toBe(false);
		expect(isBlocked(report)).toBe(false);
	});

	test("a running background task blocks, a finished one does not", async () => {
		await narrator("n1");
		db.insert(backgroundTasks)
			.values({
				id: "bg1",
				parentNarratorId: "n1",
				type: "bash",
				status: "running",
				startedAt: NOW,
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		expect((await probeUnattendedIdle({ dueWithinMs: 120_000 })).backgroundTasks).toBe(true);
		db.update(backgroundTasks).set({ status: "completed" }).run();
		expect((await probeUnattendedIdle({ dueWithinMs: 120_000 })).backgroundTasks).toBe(false);
	});

	test("a scheduled run inside the quiet window blocks, a later one does not", async () => {
		db.insert(scheduledTasks)
			.values({
				id: "s1",
				name: "nightly",
				cronExpr: "0 3 * * *",
				prompt: "tick",
				nextRunAt: new Date(Date.now() + 30_000).toISOString(),
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		expect((await probeUnattendedIdle({ dueWithinMs: 120_000 })).dueScheduledTasks).toBe(true);
		db.update(scheduledTasks)
			.set({ nextRunAt: new Date(Date.now() + 3_600_000).toISOString() })
			.run();
		expect((await probeUnattendedIdle({ dueWithinMs: 120_000 })).dueScheduledTasks).toBe(false);
		db.update(scheduledTasks).set({ enabled: false }).run();
		db.update(scheduledTasks)
			.set({ nextRunAt: new Date(Date.now() + 1_000).toISOString() })
			.run();
		expect((await probeUnattendedIdle({ dueWithinMs: 120_000 })).dueScheduledTasks).toBe(false);
	});
});
