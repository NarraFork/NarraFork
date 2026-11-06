/**
 * The transcript's task notices for outline P2 PR 9b, as data: the current-tasks view's
 * "delegated" section (rows with their chip, counted in the folded line), and the notice a session
 * gets when tasks it created were finished elsewhere (`outlineTasks`, variant `finished`), read
 * back bounded.
 */
import { describe, expect, test } from "bun:test";
import { coerceOutlineTasksViewDisplay } from "../outline-task-notice";
import { taskNoticeFromBody, taskNoticeFromContextUpdate } from "../pretext-layout/task-notice";
import { coerceSideCarBody } from "../sidecar-body";

const view = (display: unknown) => [
	{ type: "text", text: "Context updated: outline.tasks" },
	{ type: "context_update", display: { "outline.tasks": display } },
];

describe("the current-tasks view's delegated section", () => {
	test("rows after the work in progress, each with the delegated chip; counted in the folded line", () => {
		const notice = taskNoticeFromContextUpdate(
			view({
				doing: [{ address: "K/a", title: "Own work" }],
				delegated: [
					{ address: "K/b", title: "Fix the race" },
					{ address: "K/c", title: "Write the test" },
				],
				waiting: [],
				next: [{ address: "K/d", title: "Next" }],
				counts: { doing: 1, waiting: 0, todo: 1, delegated: 2 },
			}),
			null,
			undefined,
		);
		expect(notice?.rows.map((row) => [row.title, row.status?.label])).toEqual([
			["Own work", "In progress"],
			["Fix the race", "Delegated"],
			["Write the test", "Delegated"],
			["Next", "To do"],
		]);
		expect(notice?.summary.row?.title).toBe("Own work");
		expect(notice?.summary.tail).toBe("2 delegated · 1 to do");
	});

	test("only delegated: the folded line names the first", () => {
		const notice = taskNoticeFromContextUpdate(
			view({
				doing: [],
				delegated: [{ address: "K/b", title: "Fix the race" }],
				waiting: [],
				next: [],
				counts: { doing: 0, waiting: 0, todo: 0, delegated: 1 },
			}),
			null,
			undefined,
		);
		expect(notice?.summary.row?.title).toBe("Fix the race");
		expect(notice?.summary.row?.status?.label).toBe("Delegated");
		expect(notice?.summary.tail).toBeUndefined();
	});

	test("read back: kept when present, absent on a row written before it", () => {
		expect(
			coerceOutlineTasksViewDisplay({
				doing: [],
				waiting: [],
				next: [],
				delegated: [{ address: "K/b", title: "Fix the race" }],
				counts: { doing: 0, waiting: 0, todo: 0, delegated: 3 },
			}),
		).toEqual({
			doing: [],
			waiting: [],
			next: [],
			delegated: [{ address: "K/b", title: "Fix the race" }],
			counts: { doing: 0, waiting: 0, todo: 0, delegated: 3 },
		});
		expect(
			coerceOutlineTasksViewDisplay({ doing: [], waiting: [], next: [], counts: { doing: 1 } }),
		).toEqual({ doing: [], waiting: [], next: [], counts: { doing: 1, waiting: 0, todo: 0 } });
	});
});

describe("tasks the session created, finished elsewhere", () => {
	const body = {
		kind: "outlineTasks" as const,
		variant: "finished" as const,
		items: [
			{
				address: "K/a",
				title: "Ship it",
				// Who finished them, as a name: a person's, or a session's title.
				by: "Worker",
				changes: [{ kind: "status" as const, from: "doing" as const, to: "done" }],
			},
		],
		more: 2,
	};

	test("titled by who finished them, each row its status change; the rest counted", () => {
		const notice = taskNoticeFromBody("outline_task_finished", body, "Your tasks", undefined);
		expect(notice?.title).toBe("Worker finished 3 task(s) this session created");
		expect(notice?.rows[0]).toMatchObject({
			title: "Ship it",
			statusFrom: { label: "In progress" },
			status: { label: "Done" },
		});
		expect(notice?.rows.at(-1)).toMatchObject({ title: "2 more not listed", dim: true });
	});

	test("read back with its variant", () => {
		expect(coerceSideCarBody(body)).toMatchObject({ kind: "outlineTasks", variant: "finished" });
		expect(coerceSideCarBody({ ...body, variant: "bogus" })).toMatchObject({
			variant: "turnEnd",
		});
	});
});
