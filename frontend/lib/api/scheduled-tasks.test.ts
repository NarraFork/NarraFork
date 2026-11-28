import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TaskSchedule } from "@shared/scheduled-task-schedule";

const calls: Array<{ path: string; options?: RequestInit }> = [];
mock.module("./client", () => ({
	request: async (path: string, options?: RequestInit) => {
		calls.push({ path, options });
		return {};
	},
}));
const { scheduledTasksApi: api } = await import("./scheduled-tasks");
beforeEach(() => {
	calls.length = 0;
});
afterAll(() => mock.restore());

describe("scheduled task API contract", () => {
	test("list sends URL filter values and cancellation without prompt projections", async () => {
		const controller = new AbortController();
		await api.listScheduledTasks(
			{
				lifecycle: "all",
				attention: true,
				q: "周报 & review",
				kind: "repeat",
				owner: "owner_1",
				sort: "name",
			},
			controller.signal,
		);
		const url = new URL(calls[0].path, "http://test");
		expect(url.pathname).toBe("/scheduled-tasks");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			lifecycle: "all",
			attention: "true",
			q: "周报 & review",
			kind: "repeat",
			owner: "owner_1",
			sort: "name",
		});
		expect(calls[0].options?.signal).toBe(controller.signal);
	});
	test("history sends opaque cursor unchanged and filters by combined verdict", async () => {
		await api.listScheduledTaskRuns("task/1", {
			limit: 30,
			cursor: "opaque=+/",
			result: "unconfirmed",
		});
		const url = new URL(calls[0].path, "http://test");
		expect(url.pathname).toBe("/scheduled-tasks/task%2F1/runs");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			limit: "30",
			cursor: "opaque=+/",
			result: "unconfirmed",
		});
	});
	test("target lookup and associations preserve search, cursors and cancellation", async () => {
		const controller = new AbortController();
		await api.listScheduledTaskTargets(
			{ q: "日报 & abc_1", limit: 30, cursor: "opaque=+/" },
			controller.signal,
		);
		await api.listScheduledTaskAssociations(
			"narrator/1",
			{ limit: 20, cursor: "next=+/" },
			controller.signal,
		);
		const target = new URL(calls[0].path, "http://test");
		expect(target.pathname).toBe("/scheduled-tasks/targets");
		expect(Object.fromEntries(target.searchParams)).toEqual({
			q: "日报 & abc_1",
			limit: "30",
			cursor: "opaque=+/",
		});
		const association = new URL(calls[1].path, "http://test");
		expect(association.pathname).toBe("/scheduled-tasks/for-narrator/narrator%2F1");
		expect(Object.fromEntries(association.searchParams)).toEqual({
			limit: "20",
			cursor: "next=+/",
		});
		for (const call of calls) expect(call.options?.signal).toBe(controller.signal);
	});
	test("existing target mutations carry report and busy policy without an implicit cadence", async () => {
		const input = {
			narratorMode: "existing" as const,
			targetNarratorId: "target_1",
			contextPolicy: "clear" as const,
			onBusy: "wait" as const,
			busyWaitMinutes: 45,
			requireReport: false,
		};
		await api.updateScheduledTask("task_1", input);
		expect(JSON.parse(String(calls[0].options?.body))).toEqual(input);
	});
	test("preview passes normalized schedule fields, fired count and abort signal", async () => {
		const schedule: TaskSchedule = { kind: "at", times: ["2027-01-01T09:00", "2027-01-02T09:00"] };
		const input = { schedule, timezone: "Asia/Shanghai", firedCount: 1, count: 5 };
		const controller = new AbortController();
		await api.previewScheduledTask(input, controller.signal);
		expect(calls[0].path).toBe("/scheduled-tasks/preview-schedule");
		expect(calls[0].options?.method).toBe("POST");
		expect(calls[0].options?.signal).toBe(controller.signal);
		expect(JSON.parse(String(calls[0].options?.body))).toEqual(input);
	});
	test("update, toggle and transfer match the scoped server mutations", async () => {
		await api.updateScheduledTask("task_1", { name: "Renamed" });
		await api.toggleScheduledTask("task_1", false);
		await api.transferScheduledTask("task_1", "owner_2");
		expect(
			calls.map(({ path, options }) => ({
				path,
				method: options?.method,
				body: JSON.parse(String(options?.body)),
			})),
		).toEqual([
			{ path: "/scheduled-tasks/task_1", method: "PUT", body: { name: "Renamed" } },
			{ path: "/scheduled-tasks/task_1/toggle", method: "POST", body: { enabled: false } },
			{
				path: "/scheduled-tasks/task_1/transfer",
				method: "POST",
				body: { ownerUserId: "owner_2" },
			},
		]);
	});
});
