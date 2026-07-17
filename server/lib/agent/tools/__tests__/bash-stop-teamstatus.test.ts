import { describe, expect, mock, test } from "bun:test";

import type { ToolContext } from "../../types";
import { bashTool } from "../bash";
import { teamStatusTool } from "../team-status";

// --- Background task service stub (drives list/cancel behaviour) ---

type FakeTask = {
	id: string;
	parentNarratorId: string;
	type: "bash" | "agent";
	status: string;
	effectiveStatus?: string;
	command: string | null;
	alias: string | null;
	title: string | null;
	canCancelActiveWork: boolean;
};

const tasks = new Map<string, FakeTask>();
const cancelled: string[] = [];

const fakeBackgroundTaskService = {
	async getById(id: string) {
		return tasks.get(id) ?? null;
	},
	async getByAlias(alias: string, parentNarratorId: string) {
		for (const task of tasks.values()) {
			if (task.alias === alias && task.parentNarratorId === parentNarratorId) return task;
		}
		return null;
	},
	async listSummariesByParent(parentNarratorId: string) {
		return [...tasks.values()].filter((t) => t.parentNarratorId === parentNarratorId);
	},
	async listSummariesByParents(parentNarratorIds: string[]) {
		const parentIds = new Set(parentNarratorIds);
		return [...tasks.values()].filter((t) => parentIds.has(t.parentNarratorId));
	},
	async cancel(id: string) {
		const task = tasks.get(id);
		if (!task || task.status !== "running") return false;
		task.status = "cancelled";
		cancelled.push(id);
		return true;
	},
};

mock.module("@server/services/background-task-service", () => ({
	backgroundTaskService: fakeBackgroundTaskService,
	getBackgroundTaskTerminalVersion: () => null,
	resolveBackgroundTaskEffectiveStatus: (input: { taskStatus: string }) => input.taskStatus,
}));

// --- narrator service stub (drives sibling subagent listing) ---

type FakeNarrator = {
	id: string;
	parentNarratorId: string | null;
	variant: string;
	status: string;
	title: string | null;
};

const narrators = new Map<string, FakeNarrator>();

const fakeNarratorService = {
	async listSubagentsByParent(parentNarratorId: string) {
		return [...narrators.values()].filter((n) => n.parentNarratorId === parentNarratorId);
	},
	async getById(id: string) {
		const n = narrators.get(id);
		if (!n) throw new Error("narrator not found");
		return n;
	},
};

mock.module("@server/services/narrator-service", () => ({
	narratorService: fakeNarratorService,
}));

function makeCtx(narratorId: string, parentNarratorId?: string): ToolContext {
	return {
		narratorId,
		cwd: ".",
		signal: new AbortController().signal,
		locale: "en",
		parentNarratorId,
		requestPermission: async () => ({ behavior: "allow" as const }),
	};
}

function seed() {
	tasks.clear();
	cancelled.length = 0;
	narrators.clear();
}

describe("Bash stop mode", () => {
	test("schema: command is optional and stop is exposed as mutually exclusive", () => {
		expect(bashTool.parameters.safeParse({ stop: "task-1" }).success).toBe(true);
		expect(bashTool.parameters.safeParse({ command: "echo hi" }).success).toBe(true);
		const raw = bashTool.rawJsonSchema as {
			properties?: Record<string, { description?: string } | undefined>;
			required?: string[];
		};
		expect(raw.required ?? []).toHaveLength(0);
		expect(raw.properties?.stop?.description).toContain("Mutually exclusive");
	});

	test("stop without command cancels a running background bash task", async () => {
		seed();
		tasks.set("bash_1", {
			id: "bash_1",
			parentNarratorId: "parent",
			type: "bash",
			status: "running",
			command: "sleep 999",
			alias: "my-task",
			title: "Long task",
			canCancelActiveWork: true,
		});
		const result = await bashTool.execute({ stop: "my-task" }, makeCtx("parent"));
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("cancelled");
		expect(cancelled).toEqual(["bash_1"]);
	});

	test("stop resolves by id and reports a non-running task", async () => {
		seed();
		tasks.set("bash_2", {
			id: "bash_2",
			parentNarratorId: "parent",
			type: "bash",
			status: "completed",
			command: "true",
			alias: null,
			title: null,
			canCancelActiveWork: false,
		});
		const result = await bashTool.execute({ stop: "bash_2" }, makeCtx("parent"));
		expect(result.isError).toBe(true);
		expect(result.output).toContain("not running");
	});

	test("stop rejects tasks owned by another narrator", async () => {
		seed();
		tasks.set("bash_3", {
			id: "bash_3",
			parentNarratorId: "other-parent",
			type: "bash",
			status: "running",
			command: "sleep 1",
			alias: null,
			title: null,
			canCancelActiveWork: true,
		});
		const result = await bashTool.execute({ stop: "bash_3" }, makeCtx("parent"));
		expect(result.isError).toBe(true);
		expect(result.output).toContain("does not belong");
	});

	test("stop rejects agent tasks and points to Agent stop", async () => {
		seed();
		tasks.set("agent_1", {
			id: "agent_1",
			parentNarratorId: "parent",
			type: "agent",
			status: "running",
			command: null,
			alias: null,
			title: null,
			canCancelActiveWork: true,
		});
		const result = await bashTool.execute({ stop: "agent_1" }, makeCtx("parent"));
		expect(result.isError).toBe(true);
		expect(result.output).toContain("agent task");
	});

	test("stop rejects unknown task ids", async () => {
		seed();
		const result = await bashTool.execute({ stop: "missing" }, makeCtx("parent"));
		expect(result.isError).toBe(true);
		expect(result.output).toContain("does not exist");
	});

	test("command and stop together are rejected", async () => {
		seed();
		const result = await bashTool.execute({ command: "echo hi", stop: "x" }, makeCtx("parent"));
		expect(result.isError).toBe(true);
		expect(result.output).toContain("not both");
	});

	test("neither command nor stop is an error", async () => {
		seed();
		const result = await bashTool.execute({}, makeCtx("parent"));
		expect(result.isError).toBe(true);
		expect(result.output).toContain("command");
	});
});

describe("TeamStatus list actions", () => {
	test("list combines sibling agents and background bash tasks", async () => {
		seed();
		narrators.set("sub-1", {
			id: "sub-1",
			parentNarratorId: "parent",
			variant: "subagent:general",
			status: "working",
			title: "Worker",
		});
		tasks.set("bash_9", {
			id: "bash_9",
			parentNarratorId: "parent",
			type: "bash",
			status: "running",
			effectiveStatus: "running",
			command: "bun test",
			alias: "tests",
			title: "Run tests",
			canCancelActiveWork: true,
		});
		const result = await teamStatusTool.execute({ action: "list" }, makeCtx("sub-1", "parent"));
		expect(result.output).toContain("kind=agent");
		expect(result.output).toContain("kind=bash");
		expect(result.output).toContain("(you)");
		expect(result.output).toContain("alias=tests");
		expect(result.output).toContain("canCancel=true");
	});

	test("list_bash includes a bash task started by the current subagent", async () => {
		seed();
		narrators.set("sub-1", {
			id: "sub-1",
			parentNarratorId: "parent",
			variant: "subagent:general",
			status: "working",
			title: "Worker",
		});
		tasks.set("bash_self", {
			id: "bash_self",
			parentNarratorId: "sub-1",
			type: "bash",
			status: "running",
			command: "sleep 999",
			alias: "self-task",
			title: "Self task",
			canCancelActiveWork: true,
		});
		const result = await teamStatusTool.execute(
			{ action: "list_bash" },
			makeCtx("sub-1", "parent"),
		);
		expect(result.output).toContain("kind=bash");
		expect(result.output).toContain("id=bash_self");
		expect(result.output).toContain("alias=self-task");
	});

	test("list_agents excludes bash tasks", async () => {
		seed();
		narrators.set("sub-1", {
			id: "sub-1",
			parentNarratorId: "parent",
			variant: "subagent:explore",
			status: "idle",
			title: "Explorer",
		});
		tasks.set("bash_9", {
			id: "bash_9",
			parentNarratorId: "parent",
			type: "bash",
			status: "running",
			command: "bun test",
			alias: null,
			title: null,
			canCancelActiveWork: true,
		});
		const result = await teamStatusTool.execute(
			{ action: "list_agents" },
			makeCtx("sub-1", "parent"),
		);
		expect(result.output).toContain("kind=agent");
		expect(result.output).not.toContain("kind=bash");
	});

	test("list_bash excludes agents and shows command fallback label", async () => {
		seed();
		narrators.set("sub-1", {
			id: "sub-1",
			parentNarratorId: "parent",
			variant: "subagent:general",
			status: "working",
			title: "Worker",
		});
		tasks.set("bash_9", {
			id: "bash_9",
			parentNarratorId: "parent",
			type: "bash",
			status: "completed",
			command: "git log --oneline -5",
			alias: null,
			title: null,
			canCancelActiveWork: false,
		});
		const result = await teamStatusTool.execute(
			{ action: "list_bash" },
			makeCtx("sub-1", "parent"),
		);
		expect(result.output).toContain("kind=bash");
		expect(result.output).toContain("git log --oneline -5");
		expect(result.output).not.toContain("kind=agent");
	});

	test("list actions also work for a primary narrator scoped to its own tasks", async () => {
		seed();
		tasks.set("bash_1", {
			id: "bash_1",
			parentNarratorId: "primary",
			type: "bash",
			status: "running",
			command: "bun build",
			alias: "build",
			title: null,
			canCancelActiveWork: true,
		});
		const result = await teamStatusTool.execute({ action: "list" }, makeCtx("primary"));
		expect(result.output).toContain("kind=bash");
		expect(result.output).toContain("alias=build");
	});

	test("primary narrator cannot use subagent-only actions", async () => {
		seed();
		const result = await teamStatusTool.execute(
			{ action: "broadcast", message: "hi" },
			makeCtx("primary"),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("list actions");
	});
});
