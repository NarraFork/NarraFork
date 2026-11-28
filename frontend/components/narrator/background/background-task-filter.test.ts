import { describe, expect, test } from "bun:test";
import type { BackgroundTaskListItem } from "@shared/background-task-list";
import {
	backgroundTaskFilterKind,
	DEFAULT_BACKGROUND_TASK_KINDS,
	isWatchTask,
	matchesBackgroundTaskQuery,
	splitBackgroundTasks,
} from "./background-task-filter";

type Row = Pick<
	BackgroundTaskListItem,
	"id" | "type" | "command" | "status" | "effectiveStatus" | "title" | "alias" | "subagentType"
>;

function row(id: string, overrides: Partial<Row> = {}): Row {
	return {
		id,
		type: "bash",
		command: `cmd-${id}`,
		status: "running",
		effectiveStatus: "running",
		title: null,
		alias: null,
		subagentType: null,
		...overrides,
	};
}

const done = (id: string, overrides: Partial<Row> = {}) =>
	row(id, { status: "completed", effectiveStatus: "completed", ...overrides });

const ids = (rows: Row[]) => rows.map((r) => r.id);

describe("background task filter", () => {
	const tasks = [
		row("running-bash"),
		row("running-agent", {
			type: "agent",
			command: null,
			title: "Fix login refresh",
			status: "completed",
			effectiveStatus: "child_running",
		}),
		row("paused-transfer", {
			type: "transfer",
			command: null,
			status: "paused",
			effectiveStatus: "paused",
		}),
		done("old-bash"),
		done("old-agent", { type: "agent", command: null, alias: "reviewer", subagentType: "review" }),
		row("running-watch", { command: '[watch] agent "a" run "b"' }),
		done("old-watch", { command: "[terminal watch] t1" }),
	];

	test("default splits agent/bash/transfer rows into running and finished, without watches", () => {
		const { running, finished } = splitBackgroundTasks(tasks, {
			kinds: DEFAULT_BACKGROUND_TASK_KINDS,
			query: "",
		});
		expect(ids(running)).toEqual(["running-bash", "running-agent", "paused-transfer"]);
		expect(ids(finished)).toEqual(["old-bash", "old-agent"]);
	});

	test("kind toggles hide their rows; transfers are never hidden by kind", () => {
		const { running, finished } = splitBackgroundTasks(tasks, {
			kinds: { agent: false, bash: false, watch: true },
			query: "",
		});
		expect(ids(running)).toEqual(["paused-transfer", "running-watch"]);
		expect(ids(finished)).toEqual(["old-watch"]);
	});

	test("search matches every term against title, alias, command and subagent type", () => {
		const all = { kinds: { agent: true, bash: true, watch: true }, query: "" };
		const search = (query: string) => {
			const { running, finished } = splitBackgroundTasks(tasks, { ...all, query });
			return [...ids(running), ...ids(finished)];
		};
		expect(search("LOGIN")).toEqual(["running-agent"]);
		expect(search("review reviewer")).toEqual(["old-agent"]);
		expect(search("cmd old")).toEqual(["old-bash"]);
		expect(search("  ")).toHaveLength(tasks.length);
		expect(matchesBackgroundTaskQuery(row("x"), "missing")).toBe(false);
	});

	test("rows map to their kind toggle", () => {
		expect(backgroundTaskFilterKind({ type: "bash", command: "[watch] bash b1" })).toBe("watch");
		expect(backgroundTaskFilterKind({ type: "agent", command: null })).toBe("agent");
		expect(backgroundTaskFilterKind({ type: "bash", command: "ls" })).toBe("bash");
		expect(backgroundTaskFilterKind({ type: "transfer", command: null })).toBeNull();
	});

	test("watch rows are recognised by both command prefixes only", () => {
		expect(isWatchTask({ command: "[watch] bash x" })).toBe(true);
		expect(isWatchTask({ command: "[terminal watch] t" })).toBe(true);
		expect(isWatchTask({ command: "echo [watch]" })).toBe(false);
		expect(isWatchTask({ command: null })).toBe(false);
	});
});
