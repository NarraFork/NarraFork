import { afterAll, describe, expect, mock, test } from "bun:test";

import { toolRegistry } from "../../tool-registry";
import { PLAN_MODE_ALLOWED_TOOLS, type ToolContext } from "../../types";
import "../index";
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
const taskOutput = new Map<string, string>();

const realBackgroundTaskServiceModule = {
	...(await import("@server/services/background-task-service")),
};
const realNarratorServiceModule = {
	...(await import("@server/services/narrator-service")),
};
const realNarratorSubagentModule = {
	...(await import("@server/services/narrator-subagent")),
};

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
	async createBashTask(input: {
		id: string;
		parentNarratorId: string;
		command: string;
		alias?: string;
		title?: string;
	}) {
		tasks.set(input.id, {
			id: input.id,
			parentNarratorId: input.parentNarratorId,
			type: "bash",
			status: "running",
			command: input.command,
			alias: input.alias ?? null,
			title: input.title ?? null,
			canCancelActiveWork: true,
		});
		return tasks.get(input.id);
	},
	registerAbortController() {},
	registerKillHandler() {},
	appendOutput(id: string, output: string) {
		taskOutput.set(id, (taskOutput.get(id) ?? "") + output);
	},
	getOutputBuffer(id: string) {
		return taskOutput.get(id) ?? "";
	},
	async markCompleted(id: string) {
		const task = tasks.get(id);
		if (task) task.status = "completed";
	},
	async markFailed(id: string) {
		const task = tasks.get(id);
		if (task) task.status = "failed";
	},
	async markTimedOut(id: string) {
		const task = tasks.get(id);
		if (task) task.status = "failed";
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

// --- Team collaboration stub (drives file-change and message assertions) ---

type DeliveredMessage = {
	targetId: string;
	parentNarratorId?: string;
	message: {
		fromId: string;
		fromTitle: string | null;
		fromType: string;
		text: string;
		isBroadcast: boolean;
	};
};

const teamFileChanges = new Map<string, Map<string, Set<string>>>();
const deliveredMessages: DeliveredMessage[] = [];

mock.module("@server/services/narrator-subagent", () => ({
	registerTaskAlias(_parentNarratorId: string, _taskId: string, title?: string) {
		return { alias: title || "background-bash", conflicted: false };
	},
	getTeamFileChanges(parentNarratorId: string) {
		return teamFileChanges.get(parentNarratorId) ?? new Map();
	},
	deliverTeamMessage(
		targetId: string,
		message: DeliveredMessage["message"],
		parentNarratorId?: string,
	) {
		deliveredMessages.push({ targetId, message, parentNarratorId });
	},
}));

// --- Selector resolution stub ---
// TeamStatus prints each member's ALIAS, so `target_id` is very likely an alias.
// `file_changes`/`send` index by real narrator id, so the tool resolves selectors
// through the same resolver Send/Await use. Mirror its selector grammar here
// (exact id, id prefix, title, title slug) so these tests exercise the real
// alias→id hop rather than a pass-through.
const realAgentCommunicationModule = {
	...(await import("@server/services/agent-communication")),
};

mock.module("@server/services/agent-communication", () => ({
	...realAgentCommunicationModule,
	async resolveSubagentTargets({ callerNarratorId, id }: { callerNarratorId: string; id: string }) {
		const caller = narrators.get(callerNarratorId);
		const teamParentId = caller?.parentNarratorId ?? callerNarratorId;
		const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
		const matches = [...narrators.values()].filter(
			(n) =>
				n.parentNarratorId === teamParentId &&
				(n.id === id ||
					n.id.startsWith(id) ||
					n.title === id ||
					(n.title ? slug(n.title) === id : false)),
		);
		if (matches.length !== 1) throw new Error(`No accessible subagent found for "${id}"`);
		return matches;
	},
}));

afterAll(() => {
	mock.module("@server/services/background-task-service", () => realBackgroundTaskServiceModule);
	mock.module("@server/services/narrator-service", () => realNarratorServiceModule);
	mock.module("@server/services/narrator-subagent", () => realNarratorSubagentModule);
	mock.module("@server/services/agent-communication", () => realAgentCommunicationModule);
	mock.restore();
});

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
	taskOutput.clear();
	cancelled.length = 0;
	narrators.clear();
	teamFileChanges.clear();
	deliveredMessages.length = 0;
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

	test("background execution transfers and asynchronously releases the update lease", async () => {
		seed();
		let transferCalls = 0;
		let releaseCalls = 0;
		const ctx = makeCtx("parent");
		ctx.currentToolUseId = "background-lease-tool";
		ctx.updateExecutionLease = {
			kind: "background_bash",
			setNarratorId() {},
			transfer() {
				transferCalls++;
				return true;
			},
			release() {
				releaseCalls++;
			},
		};

		const result = await bashTool.execute(
			{ command: "true", run_in_background: true, description: "Background lease test" },
			ctx,
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("Background bash task started");
		expect(transferCalls).toBe(1);

		const deadline = Date.now() + 2_000;
		while (releaseCalls === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		expect(releaseCalls).toBe(1);
	});
});

describe("TeamStatus actions", () => {
	test("is registered as a core tool for primary sessions", () => {
		expect(toolRegistry.get("TeamStatus")).toBe(teamStatusTool);
	});

	test("remains enabled in plan mode for coordination", () => {
		expect(PLAN_MODE_ALLOWED_TOOLS.has("TeamStatus")).toBe(true);
	});

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

	test("primary narrator can inspect its team's file changes", async () => {
		seed();
		teamFileChanges.set("primary", new Map([["sub-1", new Set(["src/worker.ts"])]]));

		const result = await teamStatusTool.execute({ action: "file_changes" }, makeCtx("primary"));

		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("sub-1");
		expect(result.output).toContain("src/worker.ts");
	});

	test("primary narrator can broadcast to direct subagents", async () => {
		seed();
		narrators.set("primary", {
			id: "primary",
			parentNarratorId: null,
			variant: "primary",
			status: "working",
			title: "Main",
		});
		narrators.set("sub-1", {
			id: "sub-1",
			parentNarratorId: "primary",
			variant: "subagent:general",
			status: "working",
			title: "Worker",
		});
		narrators.set("foreign", {
			id: "foreign",
			parentNarratorId: "other-primary",
			variant: "subagent:general",
			status: "working",
			title: "Foreign worker",
		});

		const result = await teamStatusTool.execute(
			{ action: "broadcast", message: "Please report your progress." },
			makeCtx("primary"),
		);

		expect(result.isError).toBeFalsy();
		// Targets are named by their readable label ("Worker" → `worker`), not by the
		// raw narrator id — that id is what the model would otherwise copy back.
		expect(result.output).toContain("worker");
		expect(result.output).not.toContain("sub-1");
		expect(result.output).not.toContain("foreign");
		expect(deliveredMessages).toHaveLength(1);
		expect(deliveredMessages[0]).toMatchObject({
			targetId: "sub-1",
			parentNarratorId: "primary",
			message: { fromId: "primary", fromType: "primary", isBroadcast: true },
		});
	});

	test("primary narrator can send only to a direct subagent", async () => {
		seed();
		narrators.set("primary", {
			id: "primary",
			parentNarratorId: null,
			variant: "primary",
			status: "working",
			title: "Main",
		});
		narrators.set("sub-1", {
			id: "sub-1",
			parentNarratorId: "primary",
			variant: "subagent:explore",
			status: "idle",
			title: "Explorer",
		});
		narrators.set("foreign", {
			id: "foreign",
			parentNarratorId: "other-primary",
			variant: "subagent:general",
			status: "working",
			title: "Foreign worker",
		});

		const sent = await teamStatusTool.execute(
			{ action: "send", target_id: "sub-1", message: "Continue with the narrow scope." },
			makeCtx("primary"),
		);
		expect(sent.isError).toBeFalsy();
		// Confirmation names the target readably ("Explorer" → `explorer`).
		expect(sent.output).toContain("explorer");
		expect(deliveredMessages[0]).toMatchObject({
			targetId: "sub-1",
			message: { fromType: "primary", isBroadcast: false },
		});

		const rejected = await teamStatusTool.execute(
			{ action: "send", target_id: "foreign", message: "No cross-team messages." },
			makeCtx("primary"),
		);
		expect(rejected.isError).toBe(true);
		expect(rejected.output).toContain("not a direct subagent");
	});
});

/**
 * `list`/`list_agents` name each member by ALIAS, so an alias is what a model
 * naturally passes to `file_changes`/`send`. Both index by real narrator id, so
 * without selector resolution the tool would reject the exact name it printed —
 * reporting "no file changes" or "not a direct subagent" for an agent that exists.
 */
describe("TeamStatus accepts the aliases it printed", () => {
	test("file_changes resolves an alias to the tracked narrator id", async () => {
		seed();
		narrators.set("primary", {
			id: "primary",
			parentNarratorId: null,
			variant: "primary",
			status: "working",
			title: "Main",
		});
		narrators.set("UscgG1vLFnxzyKyaUOIfR", {
			id: "UscgG1vLFnxzyKyaUOIfR",
			parentNarratorId: "primary",
			variant: "subagent:general",
			status: "working",
			title: "Map The Providers",
		});
		// The change map is keyed by the REAL narrator id.
		teamFileChanges.set(
			"primary",
			new Map([["UscgG1vLFnxzyKyaUOIfR", new Set(["src/worker.ts"])]]),
		);

		const result = await teamStatusTool.execute(
			{ action: "file_changes", target_id: "map-the-providers" },
			makeCtx("primary"),
		);

		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("src/worker.ts");
		expect(result.output).not.toContain("No file changes recorded");
	});

	test("send delivers to the real id when addressed by alias", async () => {
		seed();
		deliveredMessages.length = 0;
		narrators.set("primary", {
			id: "primary",
			parentNarratorId: null,
			variant: "primary",
			status: "working",
			title: "Main",
		});
		narrators.set("AbcdEfghIjklMnopQrstU", {
			id: "AbcdEfghIjklMnopQrstU",
			parentNarratorId: "primary",
			variant: "subagent:explore",
			status: "working",
			title: "Trace Providers",
		});

		const sent = await teamStatusTool.execute(
			{ action: "send", target_id: "trace-providers", message: "Narrow the scope." },
			makeCtx("primary"),
		);

		expect(sent.isError).toBeFalsy();
		// Delivery must use the real id — an inbox keyed by alias is drained by nobody.
		expect(deliveredMessages).toHaveLength(1);
		expect(deliveredMessages[0].targetId).toBe("AbcdEfghIjklMnopQrstU");
	});

	test("an untitled member is reachable by the short-id label it was listed under", async () => {
		seed();
		deliveredMessages.length = 0;
		narrators.set("primary", {
			id: "primary",
			parentNarratorId: null,
			variant: "primary",
			status: "working",
			title: "Main",
		});
		narrators.set("ZyxwVutsRqpoNmlkJihgF", {
			id: "ZyxwVutsRqpoNmlkJihgF",
			parentNarratorId: "primary",
			variant: "subagent:general",
			status: "working",
			title: null,
		});

		// `agentLabelFromNarrator` falls back to the first 8 chars for an untitled
		// member, which resolves only because prefix matching is supported.
		const sent = await teamStatusTool.execute(
			{ action: "send", target_id: "ZyxwVuts", message: "Continue." },
			makeCtx("primary"),
		);

		expect(sent.isError).toBeFalsy();
		expect(deliveredMessages[0]?.targetId).toBe("ZyxwVutsRqpoNmlkJihgF");
	});
});
