import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { settings } from "../../../settings";
import type { AgentConfig, ToolContext, ToolUpdateExecutionLease } from "../../types";

const runCalls: Array<Record<string, unknown>> = [];
let agentTool: typeof import("../task").agentTool;
let realNarratorSubagent: typeof import("@server/services/narrator-subagent");

beforeAll(async () => {
	realNarratorSubagent = await import("@server/services/narrator-subagent");
	mock.module("@server/services/narrator-subagent", () => ({
		...realNarratorSubagent,
		runSubagent: mock(async (input: Record<string, unknown>) => {
			runCalls.push(input);
			// The runner already writes the alias into the tag and registers it.
			return "<subagent_id>inspect-lease</subagent_id>\n\ndone";
		}),
	}));
	({ agentTool } = await import("../task"));
});

afterAll(() => {
	mock.module("@server/services/narrator-subagent", () => realNarratorSubagent);
	mock.restore();
});

describe("Agent task tool", () => {
	test("schema advertises fixed global tiers but never invents one for unconfigured models", () => {
		// Pool entries must also be *visible* models, or filterSubagentModels drops them
		// from the schema description (which is the behaviour under test, not a bug).
		settings.agent.customModels = [
			{ value: "p:legacy", label: "p:legacy" },
			{ value: "p:review", label: "p:review" },
			{ value: "p:search", label: "p:search" },
			{ value: "p:global", label: "p:global" },
			{ value: "p:not-in-pool", label: "p:not-in-pool" },
		];
		settings.agent.subagentAllowedModels = {
			explore: ["p:legacy"],
			plan: [],
			general: [],
			review: ["p:review"],
			search: ["p:search"],
		};
		settings.agent.subagentModelReasoningEfforts = {
			review: { "p:review": "high" },
			search: { "p:search": "none" },
			explore: { "p:not-in-pool": "max" },
		};
		const schema = agentTool.rawJsonSchema as {
			properties: Record<string, { description: string }>;
		};
		expect(schema.properties.model.description).toContain("p:review [fixed reasoning_effort=high]");
		expect(schema.properties.model.description).toContain("p:search [fixed reasoning_effort=none]");
		expect(schema.properties.model.description).not.toContain("p:legacy [fixed");
		// A fixed effort for a model outside its type pool must not be advertised as a
		// pool tier. The id may still appear in the unrestricted-types dump below.
		expect(schema.properties.model.description).not.toContain("p:not-in-pool [fixed");
		expect(schema.properties.reasoning_effort.description).toContain("overrides this parameter");
		expect(agentTool.parameters.safeParse({ reasoning_effort: "none" }).success).toBe(true);
		expect(agentTool.parameters.safeParse({ reasoning_effort: "invalid" }).success).toBe(false);
	});

	test("custom effective pool description takes precedence over global metadata", () => {
		settings.agent.customModels = [
			{ value: "p:global", label: "p:global" },
			{ value: "p:custom", label: "p:custom" },
		];
		settings.agent.subagentAllowedModels = { explore: ["p:global"], plan: [], general: [] };
		settings.agent.subagentModelReasoningEfforts = { explore: { "p:global": "high" } };
		const custom = "explore: p:custom [fixed reasoning_effort=medium]";
		const schema = agentTool.getRawJsonSchema?.({
			subagentModelRestrictionDescription: custom,
		} as AgentConfig) as { properties: Record<string, { description: string }> };
		expect(schema.properties.model.description).toContain(custom);
		expect(schema.properties.model.description).not.toContain("p:global");
	});

	test("passes the executeTool lease into the subagent runner for transfer", async () => {
		const updateExecutionLease: ToolUpdateExecutionLease = {
			kind: "resumable",
			setNarratorId: mock(() => {}),
			transfer: mock(() => true),
			release: mock(() => {}),
		};
		const ctx: ToolContext = {
			narratorId: "parent-narrator",
			cwd: "/worktree",
			signal: new AbortController().signal,
			locale: "en",
			currentToolUseId: "agent-tool-use",
			toolCallBinding: { toolCallId: "agent-row-1", attempt: 1 },
			updateExecutionLease,
			requestPermission: async () => ({ behavior: "allow" }),
		};

		const result = await agentTool.execute(
			{
				prompt: "inspect the lease path",
				description: "inspect lease",
				subagent_type: "general",
			},
			ctx,
		);

		expect(result.isError).toBeFalsy();
		expect(runCalls).toHaveLength(1);
		expect(runCalls[0]).toMatchObject({
			parentNarratorId: "parent-narrator",
			toolUseId: "agent-tool-use",
			toolCallBinding: ctx.toolCallBinding,
			updateExecutionLease,
		});
		expect(updateExecutionLease.transfer).not.toHaveBeenCalled();
	});

	// The subagent acts for whoever triggered this parent turn. Dropping the id
	// made the child anonymous, so "inherit" preferences (fast mode) fell back to
	// the disabled default no matter what the user had configured.
	test("forwards the triggering user so inherited preferences resolve", async () => {
		runCalls.length = 0;
		const ctx: ToolContext = {
			narratorId: "parent-narrator",
			cwd: "/worktree",
			signal: new AbortController().signal,
			locale: "en",
			currentToolUseId: "agent-tool-use-2",
			toolCallBinding: { toolCallId: "agent-row-2", attempt: 1 },
			userId: "user-42",
			updateExecutionLease: {
				kind: "resumable",
				setNarratorId: mock(() => {}),
				transfer: mock(() => true),
				release: mock(() => {}),
			},
			requestPermission: async () => ({ behavior: "allow" }),
		};

		await agentTool.execute({ prompt: "check preference plumbing", subagent_type: "general" }, ctx);

		expect(runCalls[0]).toMatchObject({ userId: "user-42" });
	});

	// The tool used to re-write the runner's `<subagent_id>` tag to swap in an
	// alias. The runner now emits the alias itself, so a second rewrite here would
	// only be able to corrupt it — the output must pass through verbatim.
	test("passes the runner's aliased result tag through unchanged", async () => {
		const ctx: ToolContext = {
			narratorId: "parent-narrator",
			cwd: "/worktree",
			signal: new AbortController().signal,
			locale: "en",
			currentToolUseId: "agent-tool-use-3",
			toolCallBinding: { toolCallId: "agent-row-3", attempt: 1 },
			updateExecutionLease: {
				kind: "resumable",
				setNarratorId: mock(() => {}),
				transfer: mock(() => true),
				release: mock(() => {}),
			},
			requestPermission: async () => ({ behavior: "allow" }),
		};

		const result = await agentTool.execute(
			{ prompt: "check the tag", description: "inspect lease", subagent_type: "general" },
			ctx,
		);

		expect(result.output).toBe("<subagent_id>inspect-lease</subagent_id>\n\ndone");
	});
});

describe("Agent archive / unarchive commands", () => {
	type FakeNarrator = {
		id: string;
		parentNarratorId: string | null;
		variant: string;
		status: string;
		title: string | null;
		traits?: unknown;
	};

	const narrators = new Map<string, FakeNarrator>();
	const statusUpdates: Array<{ id: string; status: string }> = [];
	const cancelled: string[] = [];
	const hardInterrupts: string[] = [];
	const closed: string[] = [];

	const realModules: Record<string, unknown> = {};

	beforeAll(async () => {
		realModules.narratorService = await import("@server/services/narrator-service");
		realModules.narratorSession = await import("@server/services/narrator-session");
		realModules.subagentRunner = await import("@server/services/subagent-runner");
		realModules.backgroundTaskService = await import("@server/services/background-task-service");
		realModules.agentCommunication = await import("@server/services/agent-communication");
		realModules.narratorSubagent = await import("@server/services/narrator-subagent");
		realModules.subagentLifecycle = await import("@server/services/subagent-lifecycle");

		mock.module("@server/services/narrator-service", () => ({
			narratorService: {
				async getById(id: string) {
					const n = narrators.get(id);
					if (!n) throw new Error("narrator not found");
					return n;
				},
				async updateStatus(id: string, status: string) {
					statusUpdates.push({ id, status });
					const n = narrators.get(id);
					if (n) n.status = status;
				},
			},
		}));
		mock.module("@server/services/narrator-session", () => ({
			closeNarrator: (id: string) => {
				closed.push(id);
			},
			isNarratorActive: (id: string) =>
				closed.includes(id) || narrators.get(id)?.status === "working",
		}));
		mock.module("@server/services/subagent-runner", () => ({
			cancelBackgroundTask: async (id: string) => {
				cancelled.push(id);
				return true;
			},
		}));
		mock.module("@server/services/narrator-subagent", () => ({
			resolveTaskAlias(_parent: string, aliasOrId: string) {
				for (const n of narrators.values()) {
					if (n.title && n.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") === aliasOrId) {
						return n.id;
					}
				}
				return aliasOrId;
			},
			interruptForegroundSubagent(id: string, options?: { hard?: boolean }) {
				if (options?.hard) hardInterrupts.push(id);
				return true;
			},
		}));
		mock.module("@server/services/background-task-service", () => ({
			backgroundTaskService: {
				async getByAlias() {
					return null;
				},
			},
		}));
		mock.module("@server/services/agent-communication", () => ({
			resolveSubagentTargets: async ({ id }: { callerNarratorId: string; id: string }) => {
				const matches = [...narrators.values()].filter(
					(n) =>
						n.id === id ||
						n.id.startsWith(id) ||
						(n.title
							? n.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") === id.toLowerCase()
							: false),
				);
				if (matches.length !== 1) throw new Error(`No accessible subagent found for "${id}"`);
				return matches;
			},
		}));
		// Shared retire path used by Agent archive and history-delete card removal.
		mock.module("@server/services/subagent-lifecycle", () => ({
			interruptAndArchiveSubagent: async (id: string) => {
				const n = narrators.get(id);
				if (!n) return { ok: false, error: "not_found", id };
				cancelled.push(id);
				hardInterrupts.push(id);
				closed.push(id);
				statusUpdates.push({ id, status: "archived" });
				n.status = "archived";
				return { ok: true, alreadyArchived: false, archived: true, interrupted: true, id };
			},
			archiveRetiredSubagents: async (ids: readonly string[]) =>
				ids.map((id) => ({ ok: true, id, alreadyArchived: false, archived: true })),
		}));

		({ agentTool } = await import("../task"));
	});

	afterAll(() => {
		mock.module("@server/services/narrator-service", () => realModules.narratorService as never);
		mock.module("@server/services/narrator-session", () => realModules.narratorSession as never);
		mock.module("@server/services/subagent-runner", () => realModules.subagentRunner as never);
		mock.module(
			"@server/services/background-task-service",
			() => realModules.backgroundTaskService as never,
		);
		mock.module(
			"@server/services/agent-communication",
			() => realModules.agentCommunication as never,
		);
		mock.module("@server/services/narrator-subagent", () => realModules.narratorSubagent as never);
		mock.module(
			"@server/services/subagent-lifecycle",
			() => realModules.subagentLifecycle as never,
		);
		mock.restore();
	});

	function seed() {
		narrators.clear();
		statusUpdates.length = 0;
		cancelled.length = 0;
		hardInterrupts.length = 0;
		closed.length = 0;
		narrators.set("parent", {
			id: "parent",
			parentNarratorId: null,
			variant: "primary",
			status: "working",
			title: "Main",
		});
		narrators.set("child-1", {
			id: "child-1",
			parentNarratorId: "parent",
			variant: "subagent:general",
			status: "working",
			title: "Run Tests",
		});
		narrators.set("foreign", {
			id: "foreign",
			parentNarratorId: "other-parent",
			variant: "subagent:general",
			status: "idle",
			title: "Foreign",
		});
	}

	function makeCtx(narratorId = "parent"): ToolContext {
		return {
			narratorId,
			cwd: "/worktree",
			signal: new AbortController().signal,
			locale: "en",
			requestPermission: async () => ({ behavior: "allow" as const }),
		};
	}

	function markChildArchived() {
		const child = narrators.get("child-1");
		if (child) child.status = "archived";
	}

	test("schema exposes archive and unarchive parameters", () => {
		const raw = agentTool.rawJsonSchema as {
			properties: Record<string, { description?: string }>;
		};
		expect(raw.properties.archive?.description).toContain("broadcast");
		expect(raw.properties.unarchive?.description).toContain("Restore");
		expect(agentTool.parameters.safeParse({ archive: "child-1" }).success).toBe(true);
		expect(agentTool.parameters.safeParse({ unarchive: "child-1" }).success).toBe(true);
	});

	test("archive stops running work and marks the subagent archived", async () => {
		seed();
		const result = await agentTool.execute({ archive: "run-tests" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("archived");
		expect(result.output).toContain("child-1");
		expect(cancelled).toEqual(["child-1"]);
		expect(hardInterrupts).toEqual(["child-1"]);
		expect(statusUpdates).toEqual([{ id: "child-1", status: "archived" }]);
		expect(narrators.get("child-1")?.status).toBe("archived");
		// Archive must not launch a new agent.
		expect(runCalls.filter((c) => c.parentNarratorId === "parent")).toHaveLength(0);
	});

	test("archive rejects non-subagents and foreign subagents", async () => {
		seed();
		const notSub = await agentTool.execute({ archive: "parent" }, makeCtx());
		expect(notSub.isError).toBe(true);
		expect(notSub.output).toContain("not a subagent");

		const foreign = await agentTool.execute({ archive: "foreign" }, makeCtx("parent"));
		expect(foreign.isError).toBe(true);
		expect(foreign.output).toContain("not a direct child");
		expect(narrators.get("foreign")?.status).toBe("idle");
	});

	test("already-archived agents report idempotently without another status write", async () => {
		seed();
		markChildArchived();
		const result = await agentTool.execute({ archive: "child-1" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("already archived");
		expect(statusUpdates).toEqual([]);
	});

	test("unarchive restores an archived subagent to idle", async () => {
		seed();
		markChildArchived();
		const result = await agentTool.execute({ unarchive: "child-1" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("unarchived");
		expect(statusUpdates).toEqual([{ id: "child-1", status: "idle" }]);
		expect(narrators.get("child-1")?.status).toBe("idle");
	});

	test("stop, archive, and unarchive are mutually exclusive", async () => {
		seed();
		const result = await agentTool.execute({ stop: "a", archive: "b" }, makeCtx());
		expect(result.isError).toBe(true);
		expect(result.output).toContain("mutually exclusive");
	});
});
