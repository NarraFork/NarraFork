import { describe, expect, test } from "bun:test";
import type { BackgroundTaskListItem } from "@shared/background-task-list";
import {
	type BackgroundTaskFilterContext,
	DEFAULT_BACKGROUND_TASK_FILTER,
	filterBackgroundTasks,
	isWatchTask,
} from "./background-task-filter";

type Row = Pick<
	BackgroundTaskListItem,
	"id" | "command" | "status" | "effectiveStatus" | "completedAt"
>;

const OPENED_AT = Date.parse("2026-01-01T12:00:00Z");

function row(id: string, overrides: Partial<Row> = {}): Row {
	return {
		id,
		command: `cmd-${id}`,
		status: "running",
		effectiveStatus: "running",
		completedAt: null,
		...overrides,
	};
}

function done(id: string, completedAt: string, overrides: Partial<Row> = {}): Row {
	return row(id, { status: "completed", effectiveStatus: "completed", completedAt, ...overrides });
}

const context = (seen: string[] = []): BackgroundTaskFilterContext => ({
	openedAt: OPENED_AT,
	seenActiveIds: new Set(seen),
});

const ids = (rows: Row[]) => rows.map((r) => r.id);

describe("background task filter", () => {
	const tasks = [
		row("running-bash"),
		row("running-agent", { command: null, status: "completed", effectiveStatus: "child_running" }),
		row("paused-transfer", { command: null, status: "paused", effectiveStatus: "paused" }),
		done("old-bash", "2026-01-01T11:00:00Z"),
		done("old-failed", "2026-01-01T11:30:00Z", { status: "failed", effectiveStatus: "failed" }),
		done("finished-after-open", "2026-01-01T12:00:05Z"),
		done("seen-running", "2026-01-01T11:59:00Z"),
		row("running-watch", { command: '[watch] agent "a" run "b"' }),
		done("old-watch", "2026-01-01T11:00:00Z", { command: "[terminal watch] t1" }),
		done("new-watch", "2026-01-01T12:01:00Z", { command: "[watch] bash b1" }),
	];

	test("default shows running work and work finished after opening, never watches", () => {
		expect(
			ids(filterBackgroundTasks(tasks, DEFAULT_BACKGROUND_TASK_FILTER, context(["seen-running"]))),
		).toEqual([
			"running-bash",
			"running-agent",
			"paused-transfer",
			"finished-after-open",
			"seen-running",
		]);
	});

	test("a row seen running stays visible after finishing despite a skewed completion time", () => {
		const skewed = [done("skewed", "2025-12-31T00:00:00Z")];
		expect(ids(filterBackgroundTasks(skewed, DEFAULT_BACKGROUND_TASK_FILTER, context()))).toEqual(
			[],
		);
		expect(
			ids(filterBackgroundTasks(skewed, DEFAULT_BACKGROUND_TASK_FILTER, context(["skewed"]))),
		).toEqual(["skewed"]);
	});

	test("completed shows every non-watch row", () => {
		expect(
			ids(filterBackgroundTasks(tasks, { showCompleted: true, showWatch: false }, context())),
		).toEqual([
			"running-bash",
			"running-agent",
			"paused-transfer",
			"old-bash",
			"old-failed",
			"finished-after-open",
			"seen-running",
		]);
	});

	test("watch alone adds running watches and watches finished after opening", () => {
		expect(
			ids(filterBackgroundTasks(tasks, { showCompleted: false, showWatch: true }, context())),
		).toEqual([
			"running-bash",
			"running-agent",
			"paused-transfer",
			"finished-after-open",
			"running-watch",
			"new-watch",
		]);
	});

	test("both show everything", () => {
		expect(
			filterBackgroundTasks(tasks, { showCompleted: true, showWatch: true }, context()),
		).toHaveLength(tasks.length);
	});

	test("watch rows are recognised by both command prefixes only", () => {
		expect(isWatchTask({ command: "[watch] bash x" })).toBe(true);
		expect(isWatchTask({ command: "[terminal watch] t" })).toBe(true);
		expect(isWatchTask({ command: "echo [watch]" })).toBe(false);
		expect(isWatchTask({ command: null })).toBe(false);
	});
});
