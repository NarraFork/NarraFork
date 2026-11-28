import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { cleanDb } from "../../../tests/setup";
import { backgroundTasks, narrators } from "../../db/schema";
import { logger } from "../../lib/logger";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
const { db, sqlite } = fixture;
await fixture.ready;
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const realWs = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({ ...realWs, broadcastToNarrator: () => {} }));
const realSession = { ...(await import("../narrator-session")) };
mock.module("../narrator-session", () => ({
	...realSession,
	isNarratorActive: () => false,
	isLoopRunning: () => false,
}));
const { backgroundTaskService: service, encodeBackgroundTaskListCursor } = await import(
	"../background-task-service"
);
const { backgroundOccupancyStore } = await import("../background-occupancy-store");
const parent = "private-parent";
const taskId = "private-task";
const command = "private-command";
const output = "private-output";
const date = "2026-01-01T00:00:00.000Z";
const cursor = encodeBackgroundTaskListCursor({ createdAt: date, id: taskId });
let now = 0;
let step = 0;
let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
const calls = () => warn.mock.calls.filter(([message]) => message === "Slow background task read");
const entries = [
	["page", () => service.listPageByParent(parent)],
	["legacy-snapshot", () => service.listLegacySnapshotByParent(parent)],
	[
		"team-bash",
		() =>
			service.listTeamBashTasks({ parentNarratorIds: [parent], limit: 2, recentTerminalLimit: 1 }),
	],
	["summaries", () => service.listSummariesByParent(parent)],
] as const;

beforeEach(async () => {
	service.resetListVersionsForTests();
	service.resetReadTimingForTests();
	await db.insert(narrators).values([
		{ id: parent, variant: "primary", createdAt: date, updatedAt: date },
		{
			id: "private-agent",
			parentNarratorId: parent,
			variant: "subagent:general",
			type: "subagent",
			createdAt: date,
			updatedAt: date,
		},
	]);
	await db.insert(backgroundTasks).values(
		["bash", "agent"].map((type) => ({
			id: type === "bash" ? taskId : "private-agent-task",
			parentNarratorId: parent,
			type: type as "bash" | "agent",
			status: "completed" as const,
			command,
			output,
			subagentNarratorId: type === "agent" ? "private-agent" : null,
			startedAt: date,
			createdAt: date,
			updatedAt: date,
		})),
	);
	await backgroundOccupancyStore.start();
	now = 0;
	step = 0;
	spyOn(performance, "now").mockImplementation(() => {
		now += step;
		return now;
	});
	warn = spyOn(logger, "warn").mockImplementation(() => {});
});
afterEach(async () => {
	mock.restore();
	await backgroundOccupancyStore.flush();
	service.resetListVersionsForTests();
	cleanDb(sqlite);
});
afterAll(async () => {
	mock.module("../../db", () => realDb);
	mock.module("../../websocket/narrator-ws", () => realWs);
	mock.module("../narrator-session", () => realSession);
	await fixture.close();
});

test("slow entry paths log once with bounded stages and counters, without private data", async () => {
	for (const [path, read] of entries) {
		step = 0;
		const expected = await read();
		step = 300;
		const actual = await read();
		expect(actual).toEqual(expected);
		const payload = calls().at(-1)?.[1] as Record<string, unknown>;
		expect(payload.path).toBe(path);
		expect(payload.elapsedMs).toBeGreaterThanOrEqual(250);
		expect(payload.parentCount).toBe(1);
		expect(payload.returnedRows).toBeGreaterThan(0);
		expect(payload.failed).toBe(false);
		expect(Object.keys(payload).some((key) => key.endsWith("AwaitMs"))).toBe(true);
		expect(Object.keys(payload).some((key) => key.endsWith("SyncMs"))).toBe(true);
		for (const value of Object.values(payload)) {
			if (typeof value === "number") {
				expect(Number.isInteger(value)).toBe(true);
				expect(value).toBeGreaterThanOrEqual(0);
				expect(value).toBeLessThanOrEqual(1_000_000_000);
			}
		}
	}
	expect(calls().map(([, payload]) => payload?.path)).toEqual(entries.map(([path]) => path));
	now += 60_000;
	await service.listPageByParent(parent, { cursor, limit: 1 });
	expect(calls().at(-1)?.[1]).toMatchObject({
		path: "page",
		isFirstPage: false,
		pageLimit: 1,
		countActiveKindsAwaitMs: expect.any(Number),
	});
	const serialized = JSON.stringify(calls());
	for (const secret of [
		parent,
		taskId,
		command,
		output,
		cursor,
		"private-agent",
		"select",
		"SELECT",
	]) {
		expect(serialized).not.toContain(secret);
	}
});

test("fast and empty reads do not log", async () => {
	for (const [, read] of entries) await read();
	expect(await service.listSummariesByParents([])).toEqual([]);
	expect(
		await service.listTeamBashTasks({ parentNarratorIds: [], limit: 2, recentTerminalLimit: 1 }),
	).toEqual({ tasks: [], omitted: 0, omittedCapped: false });
	expect(calls()).toHaveLength(0);
});

test("rate limits each path separately and reports suppressed calls after the interval", async () => {
	step = 300;
	await service.listPageByParent(parent);
	await service.listPageByParent(parent);
	expect(calls()).toHaveLength(1);
	await service.listLegacySnapshotByParent(parent);
	expect(calls()).toHaveLength(2);
	now += 60_000;
	await service.listPageByParent(parent);
	expect(calls()).toHaveLength(3);
	expect(calls()[2]?.[1]?.suppressed).toBe(1);
});

test("failed reads rethrow the same error and log only its safe name", async () => {
	step = 300;
	const error = new TypeError(command);
	spyOn(db, "select").mockImplementation(() => {
		throw error;
	});
	await expect(service.listSummariesByParent(parent)).rejects.toBe(error);
	expect(calls()).toHaveLength(1);
	expect(calls()[0]?.[1]).toMatchObject({
		path: "summaries",
		failed: true,
		errorName: "TypeError",
	});
	expect(JSON.stringify(calls())).not.toContain(command);
});

test("logger failures cannot replace a successful result or the original read error", async () => {
	const expected = await service.listPageByParent(parent);
	step = 300;
	warn.mockImplementation(() => {
		throw new Error("logger unavailable");
	});
	expect(await service.listPageByParent(parent)).toEqual(expected);
	const error = new Error(output);
	spyOn(db, "select").mockImplementation(() => {
		throw error;
	});
	await expect(service.listSummariesByParent(parent)).rejects.toBe(error);
});
