/**
 * Paging, truncation and delta-versioning for the background-task list.
 *
 * The list used to be polled every few seconds and returned a parent's ENTIRE
 * task history, including the full result text of every long-finished legacy
 * subagent (one real narrator in this repo's database: 107 rows, ~600 KB). These
 * tests pin the three properties that replaced it — a bounded page, a bounded
 * row, and a delta stream a client can tell is contiguous.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BackgroundTaskListItem, BackgroundTaskListPage } from "@shared/background-task-list";
import { Hono } from "hono";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

/** Frames the service pushed, in order, so version continuity is observable. */
const broadcasts: Array<{ narratorId: string; message: Record<string, unknown> }> = [];
const realNarratorWs = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({
	...realNarratorWs,
	broadcastToNarrator: (narratorId: string, message: Record<string, unknown>) => {
		broadcasts.push({ narratorId, message });
	},
}));

/** Narrator ids the service should treat as having a live in-process agent loop. */
const liveLoops = new Set<string>();
const realNarratorSession = { ...(await import("../narrator-session")) };
mock.module("../narrator-session", () => ({
	...realNarratorSession,
	isNarratorActive: (id: string) => liveLoops.has(id),
	isLoopRunning: (id: string) => liveLoops.has(id),
}));

const {
	backgroundTaskService,
	BACKGROUND_TASK_LIST_EPOCH,
	decodeBackgroundTaskListCursor,
	encodeBackgroundTaskListCursor,
} = await import("../background-task-service");
const { BACKGROUND_TASK_LIST_OUTPUT_PREVIEW_CHARS, BACKGROUND_TASK_LIST_PAGE_SIZE } = await import(
	"@shared/background-task-list"
);
const { getRuntimePublicationService, runtimePublication } = await import(
	"../agent-runtime/publication"
);
const { wakeInboxIfEligible, runtimeInbox, claimInboxHead, inboxClaim } = await import(
	"../agent-runtime/inbox"
);
const { tryClaimExecution } = await import("../agent-runtime/ownership");
const { projectPendingInjection } = await import("../parent-injection-queue");
const publicationWakes = new Set<string>();
async function consumeTerminal(taskId: string, expectedPendingSource = false) {
	const result = await backgroundTaskService.waitForCompletion(taskId, 100);
	expect(result.terminalResultReceived).toBe(true);
	if (!result.publicationRun) throw new Error("Missing terminal publication run");
	await getRuntimePublicationService().consumeAwaitedTerminal(result.publicationRun);
	expect(
		sqlite
			.query(
				"SELECT task_id, logical_run_id, recipient_id FROM runtime_awaited_terminal_consumptions WHERE task_id = ? AND logical_run_id = ? AND recipient_id = ?",
			)
			.get(taskId, result.publicationRun.logicalRunId, result.publicationRun.recipientId),
	).toEqual({
		task_id: taskId,
		logical_run_id: result.publicationRun.logicalRunId,
		recipient_id: result.publicationRun.recipientId,
	});
	expect(await getRuntimePublicationService().hasPendingSource(result.publicationRun)).toBe(
		expectedPendingSource,
	);
	return result.publicationRun;
}
const { narratorRoutes } = await import("../../routes/narrators");
const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", { sub: "test-admin", role: "admin", iat: 0, exp: Number.MAX_SAFE_INTEGER });
	await next();
});
app.route("/api/narrators", narratorRoutes);

afterAll(() => {
	runtimePublication.stop();
	runtimePublication.setWake(async (narratorId) => {
		await wakeInboxIfEligible(narratorId);
	});
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWs);
	mock.module("../narrator-session", () => realNarratorSession);
	mock.restore();
});

beforeEach(() => {
	// List/delta tests have no configured model. Keep durable delivery real, but
	// observe the production wake seam instead of accidentally starting an AI loop.
	publicationWakes.clear();
	runtimePublication.setWake((recipientId) => {
		publicationWakes.add(recipientId);
	});
	broadcasts.length = 0;
	liveLoops.clear();
	backgroundTaskService.resetListVersionsForTests();
});

afterEach(() => {
	cleanDb(sqlite);
	// An emptied case cannot leave an outbox page cursor positioned in the next case.
	runtimePublication.flushPage();
});

const PARENT = "list-parent";

async function seedParent(): Promise<void> {
	const now = new Date().toISOString();
	await db
		.insert(narrators)
		.values({ id: PARENT, type: "primary", variant: "primary", createdAt: now, updatedAt: now });
}

/** A legacy background subagent: pre-unified-table history, keyed off narrators. */
async function seedLegacyTask(opts: {
	id: string;
	createdAt: string;
	result?: string;
	backgroundStatus?: "running" | "completed" | "failed" | "cancelled";
}): Promise<void> {
	await db.insert(narrators).values({
		id: opts.id,
		type: "subagent",
		variant: "subagent:general",
		parentNarratorId: PARENT,
		isBackground: true,
		backgroundStatus: opts.backgroundStatus ?? "completed",
		backgroundResult: opts.result ?? "legacy result",
		backgroundCompletedAt: opts.createdAt,
		status: "idle",
		title: `legacy ${opts.id}`,
		createdAt: opts.createdAt,
		updatedAt: opts.createdAt,
	});
}

/** A unified-table bash task at an exact createdAt (paging order is by createdAt). */
async function seedBashTaskAt(id: string, createdAt: string, output?: string): Promise<void> {
	await backgroundTaskService.createBashTask({
		id,
		parentNarratorId: PARENT,
		command: `cmd ${id}`,
	});
	if (output !== undefined) {
		await backgroundTaskService.markCompleted(id, output);
	}
	const { backgroundTasks } = await import("../../db/schema");
	const { eq } = await import("drizzle-orm");
	await db.update(backgroundTasks).set({ createdAt }).where(eq(backgroundTasks.id, id));
}

function listDeltas(): Array<Record<string, unknown>> {
	return broadcasts
		.filter((b) => b.message.type === "background_task_list_delta")
		.map((b) => b.message);
}

/** Let the fire-and-forget delta broadcasts settle. */
async function flushDeltas(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("background task list cursor paging", () => {
	test("merges unified and legacy rows into one createdAt-descending stream with no gaps or repeats", async () => {
		await seedParent();
		// Interleave the two sources so a per-source cursor bug shows up as a
		// misordering rather than being masked by grouped timestamps.
		await seedBashTaskAt("u1", "2026-01-01T00:00:01.000Z");
		await seedLegacyTask({ id: "l1", createdAt: "2026-01-01T00:00:02.000Z" });
		await seedBashTaskAt("u2", "2026-01-01T00:00:03.000Z");
		await seedLegacyTask({ id: "l2", createdAt: "2026-01-01T00:00:04.000Z" });
		await seedBashTaskAt("u3", "2026-01-01T00:00:05.000Z");

		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const page = await backgroundTaskService.listPageByParent(PARENT, {
				limit: 2,
				cursor: cursor ?? undefined,
			});
			expect(page.tasks.length).toBeLessThanOrEqual(2);
			seen.push(...page.tasks.map((t) => t.id));
			cursor = page.nextCursor;
			pages++;
			expect(pages).toBeLessThan(10);
		} while (cursor);

		expect(seen).toEqual(["u3", "l2", "u2", "l1", "u1"]);
		expect(new Set(seen).size).toBe(seen.length);
	});

	// ISO timestamps collide freely — several tasks created in the same
	// millisecond is routine. A createdAt-only cursor would skip every sibling
	// after the first whenever a page boundary landed inside such a group.
	test("does not drop rows that share a createdAt across a page boundary", async () => {
		await seedParent();
		const sameMs = "2026-02-02T00:00:00.000Z";
		for (const id of ["a1", "a2", "a3", "a4"]) await seedBashTaskAt(id, sameMs);

		const seen: string[] = [];
		let cursor: string | null = null;
		do {
			const page = await backgroundTaskService.listPageByParent(PARENT, {
				limit: 2,
				cursor: cursor ?? undefined,
			});
			seen.push(...page.tasks.map((t) => t.id));
			cursor = page.nextCursor;
		} while (cursor);

		expect(seen.sort()).toEqual(["a1", "a2", "a3", "a4"]);
	});

	test("only the first page carries the active set", async () => {
		await seedParent();
		await seedBashTaskAt("r1", "2026-01-01T00:00:02.000Z");
		await seedBashTaskAt("r2", "2026-01-01T00:00:01.000Z");

		const first = await backgroundTaskService.listPageByParent(PARENT, { limit: 1 });
		expect(first.activeTasks).toBeDefined();
		expect(first.activeTasks?.map((t) => t.id)).toEqual(["r1", "r2"]);
		expect(first.nextCursor).not.toBeNull();

		const second = await backgroundTaskService.listPageByParent(PARENT, {
			limit: 1,
			cursor: first.nextCursor as string,
		});
		expect(second.activeTasks).toBeUndefined();
		// The count is still reported, so a client paging deeper keeps a right badge.
		expect(second.activeCount).toBe(2);
	});

	test("rejects a malformed cursor instead of silently serving page one", async () => {
		await seedParent();
		expect(() => decodeBackgroundTaskListCursor("not-base64-json")).toThrow();
		expect(() =>
			decodeBackgroundTaskListCursor(encodeBackgroundTaskListCursor({} as never)),
		).toThrow();
		expect(decodeBackgroundTaskListCursor(undefined)).toBeUndefined();
	});
});

describe("subagents remain discoverable without a background projection", () => {
	test("lists a foreground/resumed child but not a forked primary narrator", async () => {
		await seedParent();
		const now = new Date().toISOString();
		await db.insert(narrators).values([
			{
				id: "foreground-child",
				parentNarratorId: PARENT,
				variant: "subagent:general",
				type: "subagent",
				status: "working",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "forked-primary",
				parentNarratorId: PARENT,
				variant: "primary",
				type: "primary",
				status: "working",
				createdAt: now,
				updatedAt: now,
			},
		]);
		const page = await backgroundTaskService.listPageByParent(PARENT);
		expect(page.tasks.map((task) => task.id)).toEqual(["foreground-child"]);
		expect(page.activeTasks?.map((task) => task.id)).toEqual(["foreground-child"]);
		backgroundTaskService.notifyDerivedStatusChanged(PARENT, "foreground-child");
		await flushDeltas();
		expect(listDeltas().at(-1)).toMatchObject({
			activeCount: 1,
			upsert: { id: "foreground-child", effectiveStatus: "running" },
		});
	});

	test("keeps a taken-over task through cleanup and in the active set", async () => {
		await seedParent();
		const id = "held-child";
		const old = "2020-01-01T00:00:00.000Z";
		await seedLegacyTask({ id, createdAt: old });
		await backgroundTaskService.createAgentTask({
			id,
			parentNarratorId: PARENT,
			subagentNarratorId: id,
			subagentType: "general",
		});
		await backgroundTaskService.markTakenOver(id);
		const { backgroundTasks } = await import("../../db/schema");
		const { eq } = await import("drizzle-orm");
		await db.update(backgroundTasks).set({ completedAt: old }).where(eq(backgroundTasks.id, id));
		await db
			.update(narrators)
			.set({
				isBackground: false,
				backgroundStatus: null,
				substatus: JSON.stringify(["taken_over"]),
			})
			.where(eq(narrators.id, id));
		expect(await backgroundTaskService.cleanupCompleted()).toBe(0);
		expect(await backgroundTaskService.getById(id)).not.toBeNull();
		const page = await backgroundTaskService.listPageByParent(PARENT);
		expect(page.activeTasks).toEqual([
			expect.objectContaining({ id, effectiveStatus: "taken_over", canCancelActiveWork: false }),
		]);
	});
});

describe("background task list HTTP compatibility", () => {
	type LegacyResponse = BackgroundTaskListPage & {
		legacySubagentTasks: Array<{ id: string; backgroundResult: string | null }>;
	};

	async function requestList(query = ""): Promise<LegacyResponse> {
		const response = await app.request(`/api/narrators/${PARENT}/background-tasks${query}`);
		expect(response.status).toBe(200);
		return response.json();
	}

	test("an already-open pre-paging client can decode the no-parameter response", async () => {
		await seedParent();
		await seedBashTaskAt("running", "2026-01-01T00:00:02.000Z");
		await seedLegacyTask({ id: "legacy", createdAt: "2026-01-01T00:00:01.000Z" });

		const data = await requestList();
		// The old queryFn maps BOTH arrays unconditionally after HTTP 200. Omitting
		// legacySubagentTasks turns a successful request into a failed query before
		// the panel can render any of its rows.
		const decoded = {
			tasks: data.tasks.map((task) => ({ ...task, output: task.output?.slice(0, 4_000) })),
			legacySubagentTasks: data.legacySubagentTasks.map((task) => ({
				...task,
				backgroundResult: task.backgroundResult?.slice(0, 4_000),
			})),
		};
		expect(decoded.tasks.map((task) => task.id)).toEqual(["running", "legacy"]);
		// Legacy DB rows are already normalized in tasks; do not send them twice.
		expect(decoded.legacySubagentTasks).toEqual([]);
	});

	test("includes active tasks outside the first page without restoring unbounded history", async () => {
		await seedParent();
		await seedBashTaskAt("old-running", "2025-01-01T00:00:00.000Z");
		await seedLegacyTask({
			id: "old-legacy-running",
			createdAt: "2025-01-02T00:00:00.000Z",
			backgroundStatus: "running",
		});
		for (let i = 0; i < BACKGROUND_TASK_LIST_PAGE_SIZE + 5; i++) {
			await seedLegacyTask({
				id: `history-${String(i).padStart(2, "0")}`,
				createdAt: "2026-01-01T00:00:00.000Z",
				result: "x".repeat(8_000),
			});
		}
		await seedBashTaskAt("new-running", "2026-02-01T00:00:00.000Z");

		const data = await requestList();
		const ids = data.tasks.map((task) => task.id);
		expect(ids).toContain("old-running");
		expect(ids).toContain("old-legacy-running");
		expect(ids[0]).toBe("new-running");
		expect(new Set(ids).size).toBe(ids.length);
		expect(data.tasks).toHaveLength(BACKGROUND_TASK_LIST_PAGE_SIZE + 2);
		expect(ids).not.toContain("history-00");
		expect(data.activeCount).toBe(3);
		expect(data.nextCursor).not.toBeNull();
		for (const task of data.tasks) {
			expect(task.output?.length ?? 0).toBeLessThanOrEqual(
				BACKGROUND_TASK_LIST_OUTPUT_PREVIEW_CHARS + 1,
			);
		}
	});

	test("keeps explicit cursor pages bounded and compatible with the current reducer", async () => {
		await seedParent();
		await seedBashTaskAt("older", "2026-01-01T00:00:01.000Z");
		await seedBashTaskAt("newer", "2026-01-01T00:00:02.000Z");

		const first = await requestList("?limit=1");
		expect(first.tasks.map((task) => task.id)).toEqual(["newer"]);
		expect(first.activeTasks?.map((task) => task.id)).toEqual(["newer", "older"]);
		const { flattenBackgroundTaskList, toBackgroundTaskListState } = await import(
			"../../../frontend/components/narrator/background/background-task-list-state"
		);
		const currentTasks: BackgroundTaskListItem[] = flattenBackgroundTaskList(
			toBackgroundTaskListState([first]),
		);
		expect(currentTasks.map((task) => task.id)).toEqual(["newer", "older"]);

		const second = await requestList(`?cursor=${encodeURIComponent(first.nextCursor as string)}`);
		expect(second.tasks.map((task) => task.id)).toEqual(["older"]);
		expect(second.activeTasks).toBeUndefined();
		expect(second.nextCursor).toBeNull();
	});

	test("returns both empty arrays for an old client with no tasks", async () => {
		await seedParent();
		expect(await requestList()).toMatchObject({
			tasks: [],
			legacySubagentTasks: [],
			activeCount: 0,
			nextCursor: null,
		});
	});
});

describe("background task list row size", () => {
	// The core performance constraint. Before paging, the legacy branch read
	// `narrators.background_result` in full: 1169 rows averaging 5.3 KB, worst
	// single parent ~600 KB, re-sent every 3–10 seconds.
	test("never returns a full stored output or legacy result in a list row", async () => {
		await seedParent();
		const huge = "x".repeat(40_000);
		await seedBashTaskAt("big-unified", "2026-03-01T00:00:02.000Z", huge);
		await seedLegacyTask({ id: "big-legacy", createdAt: "2026-03-01T00:00:01.000Z", result: huge });

		const page = await backgroundTaskService.listPageByParent(PARENT, { limit: 10 });
		expect(page.tasks).toHaveLength(2);
		for (const task of page.tasks) {
			expect(task.output).not.toBeNull();
			// +1 for the ellipsis the preview appends to mark the cut.
			expect((task.output as string).length).toBeLessThanOrEqual(
				BACKGROUND_TASK_LIST_OUTPUT_PREVIEW_CHARS + 1,
			);
			// The true size is still reported, so the UI can offer the full text.
			expect(task.outputBytes).toBeGreaterThanOrEqual(40_000);
			// Legacy full rows need list slicing; Bash already spilled at 5120 bytes.
			expect(task.outputPreviewTruncated).toBe(task.id === "big-legacy");
			if (task.id === "big-unified") {
				expect(task.output).not.toContain(huge);
				expect(task.output).toContain("file");
			}
		}
		// Storage projection is shortened for a spilled Bash result, independently
		// of list-preview slicing. Legacy 40KB output is only sliced at list time.
		expect(page.tasks.find((task) => task.id === "big-unified")?.outputTruncated).toBe(true);
		expect(page.tasks.find((task) => task.id === "big-legacy")?.outputTruncated).toBe(false);
	});

	// Every background subagent alive TODAY writes both records under one id:
	// `narrators.is_background = 1` (subagent-runner / subagent-detach) and then a
	// `background_tasks` row. Without excluding the overlap the list yields it
	// twice — activeCount doubles, the page budget halves, and the legacy
	// projection (no alias, no toolUseId, no cancel affordance) can win the
	// client-side dedupe depending on which row sorts first.
	test("a subagent with both a narrator marker and a task row appears exactly once", async () => {
		await seedParent();
		const subagentId = "dual-recorded";
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id: subagentId,
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId: PARENT,
			isBackground: true,
			backgroundStatus: "running",
			status: "working",
			title: "detached",
			createdAt: now,
			updatedAt: now,
		});
		await backgroundTaskService.createAgentTask({
			id: subagentId,
			parentNarratorId: PARENT,
			subagentNarratorId: subagentId,
			subagentType: "general",
			alias: "detached-worker",
		});

		const page = await backgroundTaskService.listPageByParent(PARENT, { limit: 30 });
		expect(page.tasks.filter((t) => t.id === subagentId)).toHaveLength(1);
		expect(page.tasks.every((t) => t.legacy === false)).toBe(true);
		// The surviving row is the unified one, so the panel keeps the alias and the
		// cancel affordance the legacy projection cannot express.
		expect(page.tasks[0]?.alias).toBe("detached-worker");
		expect(page.activeTasks?.filter((t) => t.id === subagentId)).toHaveLength(1);
		expect(page.activeCount).toBe(1);
		expect(await backgroundTaskService.countActiveByParent(PARENT)).toBe(1);
	});

	test("normalizes legacy rows into the same shape as unified rows", async () => {
		await seedParent();
		await seedLegacyTask({ id: "leg", createdAt: "2026-04-01T00:00:00.000Z" });
		const page = await backgroundTaskService.listPageByParent(PARENT, { limit: 10 });
		const row = page.tasks.find((t) => t.id === "leg");
		expect(row).toBeDefined();
		expect(row).toMatchObject({
			type: "agent",
			legacy: true,
			subagentNarratorId: "leg",
			effectiveStatus: "completed",
			canCancelActiveWork: false,
		});
	});
});

describe("background task active count", () => {
	// `continued` exists precisely because a task row can be terminal while its
	// subagent was resumed in the foreground. A `count(*) where status='running'`
	// would report 0 here — and the badge exists to say "something is still going".
	test("counts a terminal row whose subagent is still working as active", async () => {
		await seedParent();
		const subagentId = "sub-continued";
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id: subagentId,
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId: PARENT,
			status: "working",
			createdAt: now,
			updatedAt: now,
		});
		await backgroundTaskService.createAgentTask({
			id: subagentId,
			parentNarratorId: PARENT,
			subagentNarratorId: subagentId,
			subagentType: "general",
		});
		await backgroundTaskService.markCompleted(subagentId, "first pass done");

		const page = await backgroundTaskService.listPageByParent(PARENT, { limit: 10 });
		expect(page.tasks.find((t) => t.id === subagentId)?.effectiveStatus).toBe("continued");
		expect(page.activeCount).toBe(1);
		expect(await backgroundTaskService.countActiveByParent(PARENT)).toBe(1);
	});

	// In-process liveness (a running agent loop whose task row is already terminal)
	// is invisible to the DB. It has to be applied where the count is computed, not
	// only in the route: while it lived in the route, a row rendered as `continued`
	// while the badge beside it said 0, and delta upserts disagreed with the page.
	test("a live agent loop makes the row, the active set and the count all agree", async () => {
		await seedParent();
		const subagentId = "live-loop";
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id: subagentId,
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId: PARENT,
			// Persisted state says idle — only this process knows the loop is running.
			status: "idle",
			createdAt: now,
			updatedAt: now,
		});
		await backgroundTaskService.createAgentTask({
			id: subagentId,
			parentNarratorId: PARENT,
			subagentNarratorId: subagentId,
			subagentType: "general",
		});
		await backgroundTaskService.markCompleted(subagentId, "done");

		// Without the overlay this row is plainly `completed`.
		const before = await backgroundTaskService.listPageByParent(PARENT, { limit: 10 });
		expect(before.tasks[0]?.effectiveStatus).toBe("completed");
		expect(before.activeCount).toBe(0);

		liveLoops.add(subagentId);
		const after = await backgroundTaskService.listPageByParent(PARENT, { limit: 10 });
		expect(after.tasks[0]?.effectiveStatus).toBe("continued");
		expect(after.tasks[0]?.canCancelActiveWork).toBe(true);
		expect(after.activeTasks?.map((t) => t.id)).toEqual([subagentId]);
		expect(after.activeCount).toBe(1);
		expect(await backgroundTaskService.countActiveByParent(PARENT)).toBe(1);
	});

	test("counts a legacy row still marked running", async () => {
		await seedParent();
		await seedLegacyTask({
			id: "legacy-running",
			createdAt: "2026-05-01T00:00:00.000Z",
			backgroundStatus: "running",
		});
		expect(await backgroundTaskService.countActiveByParent(PARENT)).toBe(1);
	});
});

describe("background task batch active count", () => {
	// List surfaces (RecentTabs snapshot, GET /api/narrators) render one badge per
	// narrator from `countActiveByParentBatch`. It must agree with the single-parent
	// count on every state that count recognizes, or the sidebar and the panel
	// badge would tell different stories.
	test("matches the single-parent count for mixed running/finished/continued states", async () => {
		await seedParent();
		await seedBashTaskAt("batch-running", "2026-07-01T00:00:00.000Z");
		await seedBashTaskAt("batch-done", "2026-07-01T00:00:01.000Z", "finished");

		const subagentId = "batch-continued";
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id: subagentId,
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId: PARENT,
			status: "working",
			createdAt: now,
			updatedAt: now,
		});
		await backgroundTaskService.createAgentTask({
			id: subagentId,
			parentNarratorId: PARENT,
			subagentNarratorId: subagentId,
			subagentType: "general",
		});
		await backgroundTaskService.markCompleted(subagentId, "first pass done");

		const counts = await backgroundTaskService.countActiveByParentBatch([PARENT]);
		// running bash + continued agent; the completed bash does not count.
		expect(counts.get(PARENT)).toBe(2);
		expect(await backgroundTaskService.countActiveByParent(PARENT)).toBe(2);
	});

	test("counts independently per parent and omits parents with nothing active", async () => {
		await seedParent();
		const other = "batch-parent-2";
		const now = new Date().toISOString();
		await db
			.insert(narrators)
			.values({ id: other, type: "primary", variant: "primary", createdAt: now, updatedAt: now });
		await seedBashTaskAt("batch-p1", "2026-07-02T00:00:00.000Z");
		await backgroundTaskService.createBashTask({
			id: "batch-p2",
			parentNarratorId: other,
			command: "cmd batch-p2",
		});
		await backgroundTaskService.createBashTask({
			id: "batch-p2b",
			parentNarratorId: other,
			command: "cmd batch-p2b",
		});

		const counts = await backgroundTaskService.countActiveByParentBatch([
			PARENT,
			other,
			"parent-with-no-rows",
		]);
		expect(counts.get(PARENT)).toBe(1);
		expect(counts.get(other)).toBe(2);
		expect(counts.has("parent-with-no-rows")).toBe(false);
	});

	test("counts a legacy row still marked running", async () => {
		await seedParent();
		await seedLegacyTask({
			id: "batch-legacy-running",
			createdAt: "2026-07-03T00:00:00.000Z",
			backgroundStatus: "running",
		});
		const counts = await backgroundTaskService.countActiveByParentBatch([PARENT]);
		expect(counts.get(PARENT)).toBe(1);
	});

	// A paused transfer still occupies a slot (resume checkpoint retained), so
	// both count paths must treat it as active — a badge that dropped it would
	// read as "nothing running" while work is resumable.
	test("counts a paused transfer as active", async () => {
		await seedParent();
		const { backgroundTasks } = await import("../../db/schema");
		const now = new Date().toISOString();
		await db.insert(backgroundTasks).values({
			id: "batch-paused-transfer",
			parentNarratorId: PARENT,
			type: "transfer",
			status: "paused",
			startedAt: now,
			createdAt: now,
			updatedAt: now,
		});

		expect(await backgroundTaskService.countActiveByParent(PARENT)).toBe(1);
		const counts = await backgroundTaskService.countActiveByParentBatch([PARENT]);
		expect(counts.get(PARENT)).toBe(1);
	});

	test("a live agent loop counts as continued in batch too", async () => {
		await seedParent();
		const subagentId = "batch-live-loop";
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id: subagentId,
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId: PARENT,
			status: "idle",
			createdAt: now,
			updatedAt: now,
		});
		await backgroundTaskService.createAgentTask({
			id: subagentId,
			parentNarratorId: PARENT,
			subagentNarratorId: subagentId,
			subagentType: "general",
		});
		await backgroundTaskService.markCompleted(subagentId, "done");

		expect((await backgroundTaskService.countActiveByParentBatch([PARENT])).has(PARENT)).toBe(
			false,
		);
		liveLoops.add(subagentId);
		expect((await backgroundTaskService.countActiveByParentBatch([PARENT])).get(PARENT)).toBe(1);
	});
});

describe("derived status notification identity", () => {
	test("resolves a distinct narrator id to its projection through working and idle transitions", async () => {
		await seedParent();
		const narratorId = "derived-narrator";
		const taskId = "derived-projection";
		await seedLegacyTask({ id: narratorId, createdAt: new Date().toISOString() });
		await backgroundTaskService.createAgentTask({
			id: taskId,
			parentNarratorId: PARENT,
			subagentNarratorId: narratorId,
			subagentType: "general",
		});
		const { backgroundTasks } = await import("../../db/schema");
		const { eq } = await import("drizzle-orm");
		await db
			.update(backgroundTasks)
			.set({ status: "completed", output: "done", completedAt: new Date().toISOString() })
			.where(eq(backgroundTasks.id, taskId));
		await flushDeltas();
		const stored = await backgroundTaskService.getById(taskId);
		for (const status of ["working", "idle"] as const) {
			await db.update(narrators).set({ status }).where(eq(narrators.id, narratorId));
			broadcasts.length = 0;
			backgroundTaskService.notifyDerivedStatusChanged(PARENT, narratorId);
			await flushDeltas();
			expect(listDeltas()).toHaveLength(1);
			expect(listDeltas()[0]).toMatchObject({
				activeCount: status === "working" ? 1 : 0,
				upsert: {
					id: taskId,
					status: "completed",
					effectiveStatus: status === "working" ? "continued" : "completed",
				},
			});
			expect(listDeltas()[0]?.removeIds).toBeUndefined();
			expect(await backgroundTaskService.getById(taskId)).toEqual(stored);
		}
	});

	test("does not publish another parent's direct task or narrator projection", async () => {
		await seedParent();
		const now = new Date().toISOString();
		const otherParent = "other-derived-parent";
		await db.insert(narrators).values({
			id: otherParent,
			type: "primary",
			variant: "primary",
			createdAt: now,
			updatedAt: now,
		});
		await seedLegacyTask({ id: "scoped-narrator", createdAt: now });
		await backgroundTaskService.createAgentTask({
			id: "scoped-projection",
			parentNarratorId: PARENT,
			subagentNarratorId: "scoped-narrator",
			subagentType: "general",
		});
		await seedBashTaskAt("scoped-bash", now);
		await flushDeltas();
		for (const id of ["scoped-projection", "scoped-narrator", "scoped-bash"]) {
			broadcasts.length = 0;
			backgroundTaskService.notifyDerivedStatusChanged(otherParent, id);
			await flushDeltas();
			expect(listDeltas()).toEqual([
				expect.objectContaining({ narratorId: otherParent, removeIds: [id], activeCount: 0 }),
			]);
			expect(listDeltas()[0]?.upsert).toBeUndefined();
			expect(broadcasts.every((frame) => frame.narratorId === otherParent)).toBe(true);
		}
	});

	test("preserves direct task priority, legacy updates and missing row removal", async () => {
		await seedParent();
		const now = new Date().toISOString();
		await seedLegacyTask({ id: "direct-id", createdAt: now });
		await backgroundTaskService.createAgentTask({
			id: "indirect-id",
			parentNarratorId: PARENT,
			subagentNarratorId: "direct-id",
			subagentType: "general",
		});
		await seedBashTaskAt("direct-id", now);
		await seedLegacyTask({ id: "plain-legacy", createdAt: now });
		await flushDeltas();
		for (const [id, type] of [
			["direct-id", "bash"],
			["plain-legacy", "agent"],
		] as const) {
			broadcasts.length = 0;
			backgroundTaskService.notifyDerivedStatusChanged(PARENT, id);
			await flushDeltas();
			expect(listDeltas()).toHaveLength(1);
			expect(listDeltas()[0]?.upsert).toMatchObject({ id, type });
			expect(listDeltas()[0]?.removeIds).toBeUndefined();
		}
		broadcasts.length = 0;
		backgroundTaskService.notifyDerivedStatusChanged(PARENT, "missing-id");
		await flushDeltas();
		expect(listDeltas()).toHaveLength(1);
		expect(listDeltas()[0]?.removeIds).toEqual(["missing-id"]);
		expect(listDeltas()[0]?.upsert).toBeUndefined();
	});
});

describe("background task count frames", () => {
	test.each([
		["unified", true, false],
		["legacy", false, false],
		["two idle levels", true, true],
	] as const)("%s child work refreshes idle ancestors and clears on completion", async (_label, unified, deep) => {
		await seedParent();
		const now = new Date().toISOString();
		const childId = "nested-agent";
		await seedLegacyTask({ id: childId, createdAt: now });
		const { backgroundTasks } = await import("../../db/schema");
		const seedProjection = async (id: string, parentId: string, subagentId: string) => {
			await db.insert(backgroundTasks).values({
				id,
				parentNarratorId: parentId,
				type: "agent",
				status: "completed",
				subagentNarratorId: subagentId,
				subagentType: "general",
				startedAt: now,
				completedAt: now,
				createdAt: now,
				updatedAt: now,
			});
		};
		if (unified) await seedProjection("nested-projection", PARENT, childId);
		let bashParentId = childId;
		if (deep) {
			bashParentId = "nested-grandchild";
			await db.insert(narrators).values({
				id: bashParentId,
				type: "subagent",
				variant: "subagent:general",
				parentNarratorId: childId,
				status: "idle",
				isBackground: true,
				backgroundStatus: "completed",
				createdAt: now,
				updatedAt: now,
			});
			await seedProjection("nested-grandchild-projection", childId, bashParentId);
		}
		await flushDeltas();
		broadcasts.length = 0;
		await backgroundTaskService.createBashTask({
			id: "nested-bash",
			parentNarratorId: bashParentId,
			command: "long work",
		});
		await flushDeltas();
		const ancestorFrames = () =>
			broadcasts.filter(
				(frame) =>
					frame.narratorId === PARENT && frame.message.type === "background_task_count_changed",
			);
		expect(ancestorFrames().map((frame) => frame.message.activeBackgroundTaskCount)).toEqual([1]);
		const ancestorDelta = broadcasts.find(
			(frame) => frame.narratorId === PARENT && frame.message.type === "background_task_list_delta",
		);
		expect(ancestorDelta?.message.upsert).toMatchObject({
			id: unified ? "nested-projection" : childId,
			effectiveStatus: "child_running",
		});
		expect(await backgroundTaskService.countActiveByParent(PARENT)).toBe(1);
		expect((await backgroundTaskService.countActiveByParentBatch([PARENT])).get(PARENT)).toBe(1);
		const page = await backgroundTaskService.listPageByParent(PARENT);
		expect(page.activeCount).toBe(1);
		expect(page.tasks).toHaveLength(1);
		expect(page.tasks[0]?.effectiveStatus).toBe("child_running");
		await backgroundTaskService.markCompleted("nested-bash", "done");
		await flushDeltas();
		expect(ancestorFrames().map((frame) => frame.message.activeBackgroundTaskCount)).toEqual([
			1, 0,
		]);
		expect(await backgroundTaskService.countActiveByParent(PARENT)).toBe(0);
	});

	test("a paused descendant transfer keeps an idle legacy ancestor occupied", async () => {
		await seedParent();
		const now = new Date().toISOString();
		await seedLegacyTask({ id: "paused-child", createdAt: now });
		const { backgroundTasks } = await import("../../db/schema");
		await db.insert(backgroundTasks).values({
			id: "paused-descendant",
			parentNarratorId: "paused-child",
			type: "transfer",
			status: "paused",
			startedAt: now,
			createdAt: now,
			updatedAt: now,
		});
		backgroundTaskService.notifyDerivedStatusChanged("paused-child", "paused-descendant");
		await flushDeltas();
		expect(await backgroundTaskService.countActiveByParent(PARENT)).toBe(1);
		expect((await backgroundTaskService.countActiveByParentBatch([PARENT])).get(PARENT)).toBe(1);
		expect(
			broadcasts.find(
				(frame) =>
					frame.narratorId === PARENT && frame.message.type === "background_task_count_changed",
			)?.message.activeBackgroundTaskCount,
		).toBe(1);
	});

	test("thousands of terminal legacy leaves do not block a directly running task", async () => {
		await seedParent();
		const createdAt = "2020-01-01T00:00:00.000Z";
		for (let offset = 0; offset < 4096; offset += 512) {
			await db.insert(narrators).values(
				Array.from({ length: 512 }, (_, index) => ({
					id: `historical-leaf-${offset + index}`,
					type: "subagent" as const,
					variant: "subagent:general" as const,
					parentNarratorId: PARENT,
					status: "idle" as const,
					isBackground: true,
					backgroundStatus: "completed" as const,
					createdAt,
					updatedAt: createdAt,
				})),
			);
		}
		await backgroundTaskService.createBashTask({
			id: "history-live-bash",
			parentNarratorId: PARENT,
			command: "ongoing work",
		});
		await flushDeltas();
		expect(await backgroundTaskService.countActiveByParent(PARENT)).toBe(1);
		expect((await backgroundTaskService.countActiveByParentBatch([PARENT])).get(PARENT)).toBe(1);
		const page = await backgroundTaskService.listPageByParent(PARENT, { limit: 10 });
		expect(page.activeCount).toBe(1);
		expect(page.activeTasks?.map((task) => task.id)).toEqual(["history-live-bash"]);
		expect(page.tasks).toHaveLength(10);
		expect(
			broadcasts.find((frame) => frame.message.type === "background_task_count_changed")?.message
				.activeBackgroundTaskCount,
		).toBe(1);
	});

	test.each([
		21, 50,
	])("%i parents with terminal probe leaves fit the separate row/node budgets", async (parentCount) => {
		const now = new Date().toISOString();
		const parentIds = Array.from({ length: parentCount }, (_, index) => `probe-parent-${index}`);
		await db.insert(narrators).values(
			parentIds.map((id) => ({
				id,
				type: "primary" as const,
				variant: "primary" as const,
				createdAt: now,
				updatedAt: now,
			})),
		);
		for (const parentId of parentIds) {
			await db.insert(narrators).values(
				Array.from({ length: 201 }, (_, index) => ({
					id: `${parentId}-leaf-${index}`,
					parentNarratorId: parentId,
					type: "subagent" as const,
					variant: "subagent:general" as const,
					status: "idle" as const,
					backgroundStatus: "completed" as const,
					createdAt: now,
					updatedAt: now,
				})),
			);
		}
		const { backgroundTasks } = await import("../../db/schema");
		await db.insert(backgroundTasks).values(
			parentIds.map((parentNarratorId) => ({
				id: `${parentNarratorId}-bash`,
				parentNarratorId,
				type: "bash" as const,
				status: "running" as const,
				startedAt: now,
				createdAt: now,
				updatedAt: now,
			})),
		);
		const counts = await backgroundTaskService.countActiveByParentBatch(parentIds);
		expect(counts.size).toBe(parentCount);
		for (const id of parentIds) expect(counts.get(id)).toBe(1);
	});

	test("descendant depth exhaustion fails instead of reporting an empty ancestor", async () => {
		await seedParent();
		const now = new Date().toISOString();
		let parentId = PARENT;
		for (let depth = 0; depth < 34; depth++) {
			const id = `depth-child-${depth}`;
			await db.insert(narrators).values({
				id,
				type: "subagent",
				variant: "subagent:general",
				parentNarratorId: parentId,
				status: "idle",
				backgroundStatus: "completed",
				createdAt: now,
				updatedAt: now,
			});
			parentId = id;
		}
		await expect(backgroundTaskService.countActiveByParentBatch([PARENT])).rejects.toThrow(
			"depth limit",
		);
		expect(broadcasts).toHaveLength(0);
	});

	test("cyclic narrator ancestry is visited only once per task update", async () => {
		await seedParent();
		const childId = "cyclic-agent";
		await seedLegacyTask({ id: childId, createdAt: new Date().toISOString() });
		const { eq } = await import("drizzle-orm");
		await db
			.update(narrators)
			.set({
				type: "subagent",
				variant: "subagent:general",
				parentNarratorId: childId,
			})
			.where(eq(narrators.id, PARENT));
		await backgroundTaskService.createBashTask({
			id: "cyclic-bash",
			parentNarratorId: childId,
			command: "work",
		});
		await flushDeltas();
		const counts = broadcasts.filter(
			(frame) => frame.message.type === "background_task_count_changed",
		);
		expect(counts.map((frame) => frame.narratorId)).toEqual([childId, PARENT]);
	});

	test("count failures do not publish a fabricated zero or advance the list version", async () => {
		await seedParent();
		await seedBashTaskAt("count-error", "2026-08-01T00:00:00.000Z");
		await flushDeltas();
		broadcasts.length = 0;
		const version = backgroundTaskService.getListVersion(PARENT);
		const original = backgroundTaskService.countActiveByParent;
		backgroundTaskService.countActiveByParent = async () => {
			throw new Error("count unavailable");
		};
		try {
			backgroundTaskService.notifyDerivedStatusChanged(PARENT, "count-error");
			await flushDeltas();
			expect(broadcasts).toHaveLength(0);
			expect(backgroundTaskService.getListVersion(PARENT)).toBe(version);
		} finally {
			backgroundTaskService.countActiveByParent = original;
		}
	});

	// Count-only consumers (sidebar badges) must not parse full delta payloads, so
	// every delta is paired with a tiny `background_task_count_changed` frame
	// carrying the same activeCount.
	test("every list delta is paired with a count frame carrying the same activeCount", async () => {
		await seedParent();
		await seedBashTaskAt("cf-1", "2026-08-01T00:00:00.000Z");
		await flushDeltas();
		await backgroundTaskService.markCompleted("cf-1", "ok");
		await flushDeltas();

		const deltas = listDeltas();
		const countFrames = broadcasts
			.filter((b) => b.message.type === "background_task_count_changed")
			.map((b) => b.message);
		expect(countFrames).toHaveLength(deltas.length);
		expect(countFrames.map((f) => f.activeBackgroundTaskCount)).toEqual(
			deltas.map((d) => d.activeCount),
		);
		for (const frame of countFrames) {
			expect(frame.narratorId).toBe(PARENT);
		}
		expect(countFrames.map((f) => f.activeBackgroundTaskCount)).toEqual([1, 0]);
	});
});

describe("background task list deltas", () => {
	test("creation and completion each push exactly one delta with consecutive versions", async () => {
		await seedParent();
		await seedBashTaskAt("d1", "2026-06-01T00:00:00.000Z");
		await flushDeltas();
		await backgroundTaskService.markCompleted("d1", "ok");
		await flushDeltas();

		const deltas = listDeltas();
		// A version that advances by more than one reads as a lost frame on the
		// client and forces a refetch, defeating the whole mechanism.
		expect(deltas.map((d) => d.version)).toEqual([1, 2]);
		for (const d of deltas) {
			expect(d.listEpoch).toBe(BACKGROUND_TASK_LIST_EPOCH);
			expect(d.narratorId).toBe(PARENT);
			expect(d.upsert).toBeDefined();
		}
		expect((deltas[0]?.upsert as { effectiveStatus: string }).effectiveStatus).toBe("running");
		expect((deltas[1]?.upsert as { effectiveStatus: string }).effectiveStatus).toBe("completed");
		expect(deltas[1]?.activeCount).toBe(0);
	});

	// A delta carrying a bigger payload than a page row would reintroduce the
	// problem paging solved, one frame at a time.
	test("a delta row is bounded like a page row", async () => {
		await seedParent();
		await seedBashTaskAt("d-big", "2026-06-02T00:00:00.000Z");
		await flushDeltas();
		broadcasts.length = 0;
		await backgroundTaskService.markCompleted("d-big", "y".repeat(40_000));
		await flushDeltas();

		const upsert = listDeltas().at(-1)?.upsert as { output: string; outputBytes: number };
		expect(upsert.output.length).toBeLessThanOrEqual(BACKGROUND_TASK_LIST_OUTPUT_PREVIEW_CHARS + 1);
		expect(upsert.outputBytes).toBeGreaterThanOrEqual(40_000);
	});

	test("a reap tells clients which rows disappeared", async () => {
		await seedParent();
		await seedBashTaskAt("reap-1", "2026-07-01T00:00:00.000Z", "done");
		await flushDeltas();
		broadcasts.length = 0;

		// Unconsumed terminal publication must prevent premature deletion.
		expect(await backgroundTaskService.cleanupCompleted(-1)).toBe(0);
		await consumeTerminal("reap-1");
		// olderThanMs: -1 makes every completed row older than the cutoff.
		expect(await backgroundTaskService.cleanupCompleted(-1)).toBe(1);
		await flushDeltas();

		const delta = listDeltas().at(-1);
		expect(delta?.removeIds).toEqual(["reap-1"]);
		expect(delta?.invalidate).toBeUndefined();
	});

	test("a bulk reap degrades to invalidate rather than enumerating every id", async () => {
		await seedParent();
		for (let i = 0; i < 60; i++) {
			const id = `bulk-${String(i).padStart(2, "0")}`;
			await seedBashTaskAt(id, `2026-08-01T00:00:${String(i).padStart(2, "0")}.000Z`, "done");
		}
		// Explicitly transfer across bounded publication pages before Await consumption.
		// This pins the formerly timing-dependent delivery phase without starting a model.
		for (let page = 0; page < 3; page++)
			await getRuntimePublicationService().flushRecipient(PARENT);
		expect(
			sqlite
				.query(
					"SELECT state, count(*) AS count FROM narrator_buffered_messages WHERE narrator_id = ? AND kind = 'task_notice' GROUP BY state",
				)
				.all(PARENT),
		).toEqual([{ state: "queued", count: 60 }]);
		expect(publicationWakes.has(PARENT)).toBe(true);
		await flushDeltas();
		broadcasts.length = 0;

		expect(await backgroundTaskService.cleanupCompleted(-1)).toBe(0);
		for (let i = 0; i < 60; i++) await consumeTerminal(`bulk-${String(i).padStart(2, "0")}`);
		expect(
			sqlite.query("SELECT count(*) AS count FROM runtime_awaited_terminal_consumptions").get(),
		).toEqual({ count: 60 });
		expect(
			sqlite
				.query(
					"SELECT state, count(*) AS count FROM narrator_buffered_messages WHERE narrator_id = ? AND kind = 'task_notice' GROUP BY state ORDER BY state",
				)
				.all(PARENT),
		).toEqual([{ state: "cancelled", count: 60 }]);
		expect(
			sqlite
				.query(
					"SELECT count(*) AS count FROM narrator_buffered_messages WHERE narrator_id = ? AND state = 'materialized' AND adopted_at IS NULL",
				)
				.get(PARENT),
		).toEqual({ count: 0 });
		expect(await backgroundTaskService.cleanupCompleted(-1)).toBe(60);
		await flushDeltas();

		const delta = listDeltas().at(-1);
		expect(delta?.invalidate).toBe(true);
		expect(delta?.removeIds).toBeUndefined();
	});

	test("Await consumption cannot reap a materialized notice until its real adoption receipt", async () => {
		await seedParent();
		const taskId = "materialized-retention";
		await seedBashTaskAt(taskId, "2026-08-02T00:00:00.000Z", "done");
		await getRuntimePublicationService().flushRecipient(PARENT);
		const owner = tryClaimExecution(PARENT, "primary");
		if (!owner) throw new Error("Cannot claim isolated notice consumer");
		try {
			const row = await claimInboxHead(PARENT, (candidate) => candidate.kind === "task_notice");
			if (!row) throw new Error("No real task notice delivered");
			await realNarratorSession.deliverPendingInjection(PARENT, "en", "idle", "none", {
				...projectPendingInjection(row),
				mailboxClaim: inboxClaim(row),
				recipientMessageId: row.recipientMessageId ?? undefined,
			});
			const persisted = sqlite
				.query(
					"SELECT delivery_id, recipient_ref_id, content_revision, state, adopted_at FROM narrator_buffered_messages WHERE id = ?",
				)
				.get(row.id) as {
				delivery_id: string | null;
				recipient_ref_id: string | null;
				content_revision: number;
				state: string;
				adopted_at: string | null;
			};
			expect(persisted).toMatchObject({ state: "materialized", adopted_at: null });
			const run = await consumeTerminal(taskId, true);
			expect(await backgroundTaskService.cleanupCompleted(-1)).toBe(0);
			expect(await backgroundTaskService.getById(taskId)).not.toBeNull();
			if (!persisted.delivery_id || !persisted.recipient_ref_id)
				throw new Error("Missing durable materialization receipt");
			expect(
				await runtimeInbox.ackAdopted(
					persisted.delivery_id,
					PARENT,
					persisted.recipient_ref_id,
					persisted.content_revision,
				),
			).toBe(true);
			expect(await getRuntimePublicationService().hasPendingSource(run)).toBe(false);
			expect(await backgroundTaskService.cleanupCompleted(-1)).toBe(1);
			expect(
				sqlite
					.query("SELECT injection_consumed_at FROM narrator_message_refs WHERE id = ?")
					.get(persisted.recipient_ref_id),
			).toMatchObject({ injection_consumed_at: expect.any(Number) });
		} finally {
			owner.release();
		}
	});

	test("restart recovery invalidates rather than upserting each rewritten row", async () => {
		await seedParent();
		await seedBashTaskAt("stale", "2026-09-01T00:00:00.000Z");
		await flushDeltas();
		broadcasts.length = 0;

		expect(await backgroundTaskService.recoverStaleTasksAfterRestart()).toBe(1);
		await flushDeltas();

		expect(listDeltas().at(-1)?.invalidate).toBe(true);
	});

	// Takeover deliberately emits no cancellation frame, but the row DID leave
	// `running`. Without a list delta the panel keeps showing a running task the
	// user is now driving by hand.
	test("takeover still updates the list even though it emits no cancellation", async () => {
		await seedParent();
		await seedBashTaskAt("taken", "2026-10-01T00:00:00.000Z");
		await flushDeltas();
		broadcasts.length = 0;

		await backgroundTaskService.markTakenOver("taken");
		await flushDeltas();

		const deltas = listDeltas();
		expect(deltas).toHaveLength(1);
		expect((deltas[0]?.upsert as { status: string }).status).toBe("cancelled");
		expect(broadcasts.some((b) => b.message.type === "background_task_cancelled")).toBe(false);
	});

	// Resuming a taken-over task by hand changes NO stored column: the row must keep
	// its terminal status/completedAt for `finalizeResumedAgentTask`'s version guard.
	// So nothing on the write paths pushes a frame, and with polling gone the panel
	// kept rendering the stored status — a task the user was actively watching run
	// stayed labelled "cancelled" for the whole continuation.
	test("a manual continuation pushes a delta even though the row is unchanged", async () => {
		await seedParent();
		const subagentId = "resumed-sub";
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id: subagentId,
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId: PARENT,
			status: "idle",
			createdAt: now,
			updatedAt: now,
		});
		await backgroundTaskService.createAgentTask({
			id: subagentId,
			parentNarratorId: PARENT,
			subagentNarratorId: subagentId,
			subagentType: "general",
		});
		await backgroundTaskService.markTakenOver(subagentId);
		await flushDeltas();
		const stored = await backgroundTaskService.getById(subagentId);
		expect(stored).toMatchObject({ status: "cancelled" });
		broadcasts.length = 0;

		// What the resumed runner sees: the loop is live in this process while the row
		// is terminal, which is exactly the state `applyLiveness` calls `continued`.
		liveLoops.add(subagentId);
		backgroundTaskService.notifyDerivedStatusChanged(PARENT, subagentId);
		await flushDeltas();

		const deltas = listDeltas();
		expect(deltas).toHaveLength(1);
		const upsert = deltas[0]?.upsert as { status: string; effectiveStatus: string };
		// The stored status is untouched — only the derived one moved, which is the
		// whole reason this frame has to be pushed explicitly.
		expect(upsert.status).toBe("cancelled");
		expect(upsert.effectiveStatus).toBe("continued");
		expect(deltas[0]?.activeCount).toBe(1);
		await expect(backgroundTaskService.getById(subagentId)).resolves.toMatchObject({
			status: "cancelled",
			completedAt: stored?.completedAt ?? null,
		});
	});
});

describe("resolveSubagentNarratorId", () => {
	test("resolves by task id, alias and subagent id, and scopes to the parent", async () => {
		await seedParent();
		const subagentId = "resolve-sub";
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id: subagentId,
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId: PARENT,
			status: "idle",
			createdAt: now,
			updatedAt: now,
		});
		await backgroundTaskService.createAgentTask({
			id: subagentId,
			parentNarratorId: PARENT,
			subagentNarratorId: subagentId,
			subagentType: "general",
			alias: "map-the-providers",
		});

		for (const target of [subagentId, "map-the-providers"]) {
			expect(await backgroundTaskService.resolveSubagentNarratorId(PARENT, target)).toBe(
				subagentId,
			);
		}
		// Another parent's target must not resolve — this endpoint is reachable per
		// narrator, so cross-parent resolution would leak a foreign session id.
		expect(
			await backgroundTaskService.resolveSubagentNarratorId("someone-else", subagentId),
		).toBeNull();
		expect(await backgroundTaskService.resolveSubagentNarratorId(PARENT, "nope")).toBeNull();
	});

	test("resolves a legacy background subagent", async () => {
		await seedParent();
		await seedLegacyTask({ id: "legacy-resolve", createdAt: "2026-11-01T00:00:00.000Z" });
		expect(await backgroundTaskService.resolveSubagentNarratorId(PARENT, "legacy-resolve")).toBe(
			"legacy-resolve",
		);
	});
});
