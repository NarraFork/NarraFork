import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import enNarrator from "../../locales/en/narrator.json";
import en from "../../locales/en/scheduledTasks.json";
import zhNarrator from "../../locales/zh-CN/narrator.json";
import zh from "../../locales/zh-CN/scheduledTasks.json";
import {
	pickerToWall,
	scheduleProgress,
	scheduleSummary,
	wallToPicker,
} from "./schedule-presentation";
import { taskFixture } from "./scheduled-task.fixtures";
import {
	createTaskDraft,
	scheduleWasChanged,
	taskDraftInput,
	taskPreviewSchedule,
	updateTaskDraft,
} from "./task-form-state";

describe("scheduled task draft", () => {
	test("new tasks synchronize models; existing follow tasks retain their policy", () => {
		expect(createTaskDraft(undefined, false, "zh-CN")).toMatchObject({
			modelPolicy: "sync",
			locale: "zh-CN",
			enabled: true,
		});
		expect(createTaskDraft(taskFixture({ modelPolicy: "follow" })).modelPolicy).toBe("follow");
	});
	test("unrelated edits omit cadence, identity and unchanged execution fields", () => {
		const initial = createTaskDraft(taskFixture());
		expect(taskDraftInput({ ...initial, name: " Renamed " }, initial)).toEqual({ name: "Renamed" });
		expect(taskDraftInput({ ...initial, prompt: " Updated instructions " }, initial)).toEqual({
			prompt: "Updated instructions",
		});
		expect(taskDraftInput(initial, initial)).toEqual({});
		expect(scheduleWasChanged({ ...initial, prompt: "changed" }, initial)).toBe(false);
	});
	test("existing target mode removes hidden creation settings and defaults to keeping its model", () => {
		const initial = createTaskDraft(
			taskFixture({
				runContext: "project",
				projectId: "old_project",
				cwd: "/old",
				permissionMode: "bypassPermissions",
				cleanupPolicy: { mode: "keepLatestN", keepLatestN: 20 },
			}),
		);
		const existing = updateTaskDraft(initial, { narratorMode: "existing" });
		expect(existing).toMatchObject({
			targetNarratorId: null,
			modelPolicy: "follow",
			model: "",
			cwd: "",
			projectId: "",
			permissionMode: "default",
			systemPrompt: "",
			cleanupPolicy: { mode: "none" },
			contextPolicy: "keep",
		});
		const selected = updateTaskDraft(existing, {
			targetNarratorId: "target_1",
			contextPolicy: "clear",
			onBusy: "wait",
			busyWaitMinutes: 1440,
			requireReport: false,
		});
		const input = taskDraftInput(selected, initial);
		expect(input).toMatchObject({
			narratorMode: "existing",
			targetNarratorId: "target_1",
			contextPolicy: "clear",
			onBusy: "wait",
			busyWaitMinutes: 1440,
			requireReport: false,
			cleanupPolicy: { mode: "none" },
		});
		for (const key of ["schedule", "timezone", "firedCount"]) expect(input).not.toHaveProperty(key);
		expect(taskPreviewSchedule(selected, initial)).toHaveProperty("anchorAt");
		const fresh = updateTaskDraft(selected, { narratorMode: "new" });
		expect(fresh).toMatchObject({
			targetNarratorId: null,
			contextPolicy: "keep",
			modelPolicy: "sync",
		});
		expect(taskDraftInput(fresh, selected)).not.toHaveProperty("schedule");
	});
	test("existing targets round trip, copy and change without resetting their schedule", () => {
		const task = taskFixture({
			narratorMode: "existing",
			targetNarratorId: "target_1",
			contextPolicy: "clear",
			modelPolicy: "follow",
			requireReport: false,
			onBusy: "interrupt",
		});
		const initial = createTaskDraft(task);
		expect(taskDraftInput(initial, initial)).toEqual({});
		expect(
			taskDraftInput(updateTaskDraft(initial, { targetNarratorId: "target_2" }), initial),
		).toEqual({ targetNarratorId: "target_2" });
		expect(taskDraftInput(updateTaskDraft(initial, { requireReport: true }), initial)).toEqual({
			requireReport: true,
		});
		const copied = taskDraftInput(createTaskDraft(task, true));
		expect(copied).toMatchObject({
			enabled: false,
			targetNarratorId: "target_1",
			contextPolicy: "clear",
			requireReport: false,
			cleanupPolicy: { mode: "none" },
		});
		expect(copied.schedule).not.toHaveProperty("anchorAt");
	});
	test("reused sessions can clear context without changing the execution sequence", () => {
		const initial = createTaskDraft(taskFixture({ narratorMode: "reuse", contextPolicy: "keep" }));
		const cleared = updateTaskDraft(initial, { contextPolicy: "clear" });
		expect(cleared.contextPolicy).toBe("clear");
		expect(taskDraftInput(cleared, initial)).toEqual({ contextPolicy: "clear" });
		expect(taskPreviewSchedule(cleared, initial)).toHaveProperty("anchorAt");
		expect(
			createTaskDraft(taskFixture({ narratorMode: "reuse", contextPolicy: "clear" })).contextPolicy,
		).toBe("clear");
		expect(updateTaskDraft(cleared, { narratorMode: "new" }).contextPolicy).toBe("keep");
	});
	test("cadence changes and timezone changes are explicit", () => {
		const initial = createTaskDraft(taskFixture());
		const changed = { ...initial, schedule: { kind: "at" as const, times: ["2027-01-01T09:00"] } };
		expect(taskDraftInput(changed, initial)).toEqual({ schedule: changed.schedule });
		expect(scheduleWasChanged(changed, initial)).toBe(true);
		expect(taskDraftInput({ ...initial, timezone: "UTC" }, initial)).toEqual({ timezone: "UTC" });
		expect(scheduleWasChanged({ ...initial, timezone: "UTC" }, initial)).toBe(true);
	});
	test("preview keeps a persisted sequence only when cadence and timezone are untouched", () => {
		const initial = createTaskDraft(taskFixture());
		expect(taskPreviewSchedule({ ...initial, name: "Renamed" }, initial)).toHaveProperty(
			"anchorAt",
		);
		expect(taskPreviewSchedule({ ...initial, timezone: "UTC" }, initial)).not.toHaveProperty(
			"anchorAt",
		);
		expect(taskPreviewSchedule(initial)).not.toHaveProperty("anchorAt");
		expect(initial.schedule).toHaveProperty("anchorAt");
	});
	test("copy is paused, drops its anchor, and cannot carry identity or history", () => {
		const task = taskFixture();
		const draft = createTaskDraft(task, true);
		const body = taskDraftInput(draft);
		expect(body.enabled).toBe(false);
		expect(body.schedule).not.toHaveProperty("anchorAt");
		for (const key of [
			"id",
			"createdBy",
			"ownerUserId",
			"creator",
			"firedCount",
			"lastRunId",
			"completedAt",
		])
			expect(body).not.toHaveProperty(key);
		expect(task.schedule).toHaveProperty("anchorAt");
	});
	test("legacy cron and null timezone round trip without an implicit reset", () => {
		const initial = createTaskDraft(
			taskFixture({ schedule: null, timezone: null, cronExpr: "0 9 * * MON" }),
		);
		expect(initial.schedule).toMatchObject({ kind: "cron", expr: "0 9 * * MON" });
		expect(initial.timezone).toBe("");
		expect(taskDraftInput({ ...initial, name: "legacy" }, initial)).toEqual({ name: "legacy" });
	});
	test("standalone mode clears project and empty optional strings normalize to null", () => {
		const draft = createTaskDraft();
		expect(
			taskDraftInput({ ...draft, projectId: "ignored", cwd: "  ", systemPrompt: "  " }),
		).toMatchObject({ projectId: null, cwd: null, model: null, systemPrompt: null });
	});
});

describe("schedule presentation", () => {
	test("task and approval locales have matching keys and interpolation variables", () => {
		function flatten(value: unknown, prefix = ""): Record<string, string> {
			if (typeof value === "string") return { [prefix]: value };
			return Object.fromEntries(
				Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
					Object.entries(flatten(item, prefix ? `${prefix}.${key}` : key)),
				),
			);
		}
		for (const [english, chinese] of [
			[en, zh],
			[enNarrator.scheduledTaskApproval, zhNarrator.scheduledTaskApproval],
		]) {
			const left = flatten(english);
			const right = flatten(chinese);
			expect(Object.keys(left).sort()).toEqual(Object.keys(right).sort());
			for (const key of Object.keys(left)) {
				const variables = (text: string) =>
					[...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((match) => match[1]).sort();
				expect(variables(left[key]), key).toEqual(variables(right[key]));
			}
		}
	});
	test("picker conversion never shifts a wall value through browser timezone", () => {
		expect(pickerToWall("2027-03-14 02:30:00")).toBe("2027-03-14T02:30");
		expect(wallToPicker("2027-03-14T02:30")).toBe("2027-03-14 02:30:00");
		expect(pickerToWall(null)).toBe("");
		expect(wallToPicker(undefined)).toBeNull();
	});
	test("both locales describe repeated schedules and finite progress", async () => {
		const i18n = createInstance();
		await i18n.init({
			lng: "zh-CN",
			resources: { en: { translation: en }, "zh-CN": { translation: zh } },
		});
		const schedule = {
			kind: "repeat" as const,
			rule: { unit: "week" as const, interval: 2, weekdays: [1, 5], times: ["09:00", "17:00"] },
			end: { type: "count" as const, count: 3 },
		};
		expect(scheduleSummary(schedule, i18n.t)).toContain("每 2 周");
		expect(scheduleSummary(schedule, i18n.t)).toContain("周五");
		expect(scheduleProgress(taskFixture(), i18n.t)).toContain("剩余 1 次");
		await i18n.changeLanguage("en");
		expect(scheduleSummary(schedule, i18n.t)).toContain("Every 2 weeks");
		expect(scheduleProgress(taskFixture(), i18n.t)).toContain("1 remaining");
	});
});
