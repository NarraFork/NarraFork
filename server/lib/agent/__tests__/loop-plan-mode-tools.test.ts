/**
 * Plan-mode changes affect dynamic context and execution gates, never the immutable
 * tool declarations. Names, schemas and descriptions must survive both directions.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import type { ProviderAdapter } from "../provider";
import { toolRegistry } from "../tool-registry";
import type { AgentConfig, AgentEvent } from "../types";

/** Not in PLAN_MODE_ALLOWED_TOOLS, so plan mode must enforce its execution gate without changing the description. */
const FORBIDDEN_TOOL = "PlanToggleForbiddenTool";
/** In PLAN_MODE_ALLOWED_TOOLS, so its description must survive plan mode untouched. */
const ALLOWED_TOOL = "Read";

const FORBIDDEN_DESCRIPTION = "Mutates the workspace; execution is restricted in plan mode";
const ALLOWED_DESCRIPTION = "Reads a file; allowed in plan mode";

/** Snapshot of each `formatTools` call: what the provider would have been sent. */
const formatToolsCalls: Array<Array<{ name: string; description: string }>> = [];
const formattedToolCharacters: number[] = [];

/** Flipped by the test between turns, standing in for a manual toggle. */
let livePlanMode = false;

const testProvider: ProviderAdapter = {
	formatTools: (tools) => {
		formatToolsCalls.push(
			tools.map((tool) => ({
				name: tool.name,
				description: typeof tool.description === "string" ? tool.description : "",
			})),
		);
		const formatted = tools.map(({ name, description, parameters }) => ({
			name,
			description,
			parameters: z.toJSONSchema(parameters),
		}));
		// Logical tool inputs count each declaration, not the transport array punctuation.
		formattedToolCharacters.push(
			formatted.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0),
		);
		return formatted;
	},
	buildHistory: async () => ({ history: [] }),
	injectSystemPrompt: () => {},
	async *chat() {
		// Turn 0 calls a tool (so the loop reaches a turn boundary), turn 1 just answers.
		if (turnsServed++ === 0) {
			yield { toolUses: [{ toolUseId: "tu_plan_toggle", name: ALLOWED_TOOL, input: {} }] };
			return;
		}
		yield { text: "done" };
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};

let turnsServed = 0;

const realProviderModule = { ...(await import("../provider")) };

mock.module("../provider", () => ({
	getProvider: () => testProvider,
	resolveProviderAndModel: () => ({
		requestedProvider: "test",
		requestedModel: "test:model",
		provider: "test",
		adapter: testProvider,
		model: "test:model",
	}),
}));

const { agentLoop } = await import("../loop");

toolRegistry.register({
	name: FORBIDDEN_TOOL,
	description: FORBIDDEN_DESCRIPTION,
	parameters: z.object({}),
	execute: async () => ({ output: "forbidden ran" }),
});

toolRegistry.register({
	name: ALLOWED_TOOL,
	description: ALLOWED_DESCRIPTION,
	parameters: z.object({}),
	execute: async () => ({ output: "allowed ran" }),
});

afterAll(() => {
	mock.module("../provider", () => realProviderModule);
	toolRegistry.unregister(FORBIDDEN_TOOL);
	toolRegistry.unregister(ALLOWED_TOOL);
	mock.restore();
});

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		narratorId: "n-plan-mode-tools",
		conversationId: "conv-plan-mode-tools",
		model: "test:model",
		provider: "test",
		cwd: "/tmp",
		signal: new AbortController().signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		...overrides,
	} as AgentConfig;
}

/** A config whose `planMode` is read live, exactly as the session layer builds it. */
function makeLivePlanModeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	const config = makeConfig(overrides);
	Object.defineProperty(config, "planMode", {
		get: () => livePlanMode,
		configurable: true,
	});
	return config;
}

function describedTool(
	call: Array<{ name: string; description: string }>,
	name: string,
): string | undefined {
	return call.find((tool) => tool.name === name)?.description;
}

async function drain(config: AgentConfig): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of agentLoop(config, "go", { rows: [] })) events.push(event);
	return events;
}

function resetRun(): void {
	formatToolsCalls.length = 0;
	formattedToolCharacters.length = 0;
	turnsServed = 0;
}

describe("plan mode tool descriptions", () => {
	test("counts declarations once even when plan mode changes", async () => {
		resetRun();
		livePlanMode = false;
		const counts: number[] = [];
		await drain(
			makeLivePlanModeConfig({
				onToolsCharacters: (chars) => {
					counts.push(chars);
				},
				onBeforeTurn: async () => {
					livePlanMode = true;
					return null;
				},
			}),
		);
		expect(counts).toEqual(formattedToolCharacters);
		expect(counts).toHaveLength(1);
	});

	test("does not count unchanged tools again on a later turn", async () => {
		resetRun();
		livePlanMode = false;
		const counts: number[] = [];
		await drain(
			makeLivePlanModeConfig({
				onToolsCharacters: (chars) => {
					counts.push(chars);
				},
				onBeforeTurn: async () => null,
			}),
		);
		expect(counts).toEqual(formattedToolCharacters);
		expect(counts).toHaveLength(1);
	});

	test("a failed statistics callback does not interrupt the AI request", async () => {
		resetRun();
		livePlanMode = false;
		const events = await drain(
			makeLivePlanModeConfig({
				onToolsCharacters: async () => {
					throw new Error("statistics unavailable");
				},
			}),
		);
		expect(turnsServed).toBe(2);
		expect(events.some((event) => event.type === "error")).toBe(false);
	});

	test("retains forbidden tool descriptions when plan mode is on at pass start", async () => {
		resetRun();
		livePlanMode = true;

		await drain(makeLivePlanModeConfig());

		const first = formatToolsCalls[0];
		expect(first).toBeDefined();
		expect(describedTool(first ?? [], FORBIDDEN_TOOL)).toBe(FORBIDDEN_DESCRIPTION);
		// An allowed tool keeps its real description, or the model loses the ability to plan.
		expect(describedTool(first ?? [], ALLOWED_TOOL)).toBe(ALLOWED_DESCRIPTION);
	});

	test("keeps real descriptions when relaxedPlan is on", async () => {
		resetRun();
		livePlanMode = true;

		await drain(makeLivePlanModeConfig({ relaxedPlan: true }));

		const first = formatToolsCalls[0];
		expect(describedTool(first ?? [], FORBIDDEN_TOOL)).toBe(FORBIDDEN_DESCRIPTION);
	});

	test("keeps declarations fixed when plan mode is toggled on between turns", async () => {
		resetRun();
		livePlanMode = false;

		// Flip at the turn boundary, which is when a manual toggle becomes visible to the loop.
		await drain(
			makeLivePlanModeConfig({
				onBeforeTurn: async () => {
					livePlanMode = true;
					return null;
				},
			}),
		);

		expect(formatToolsCalls).toHaveLength(1);
		const before = formatToolsCalls[0] ?? [];
		const after = formatToolsCalls[formatToolsCalls.length - 1] ?? [];

		expect(describedTool(before, FORBIDDEN_TOOL)).toBe(FORBIDDEN_DESCRIPTION);
		expect(describedTool(after, FORBIDDEN_TOOL)).toBe(FORBIDDEN_DESCRIPTION);
		// Both names and definitions remain the original cache prefix.
		expect(after.map((tool) => tool.name).sort()).toEqual(before.map((tool) => tool.name).sort());
	});

	test("keeps declarations fixed when plan mode is toggled off between turns", async () => {
		resetRun();
		livePlanMode = true;

		await drain(
			makeLivePlanModeConfig({
				onBeforeTurn: async () => {
					livePlanMode = false;
					return null;
				},
			}),
		);

		expect(formatToolsCalls).toHaveLength(1);
		const before = formatToolsCalls[0] ?? [];
		const after = formatToolsCalls[formatToolsCalls.length - 1] ?? [];

		expect(describedTool(before, FORBIDDEN_TOOL)).toBe(FORBIDDEN_DESCRIPTION);
		// Leaving plan mode changes context, not the declaration.
		expect(describedTool(after, FORBIDDEN_TOOL)).toBe(FORBIDDEN_DESCRIPTION);
		expect(after.map((tool) => tool.name).sort()).toEqual(before.map((tool) => tool.name).sort());
	});

	test("does not re-format when plan mode is unchanged across the boundary", async () => {
		resetRun();
		livePlanMode = false;

		// `formatTools` converts schemas for every registered tool, so an unconditional
		// per-turn re-format would be pure waste on the common path.
		await drain(makeLivePlanModeConfig({ onBeforeTurn: async () => null }));

		expect(formatToolsCalls).toHaveLength(1);
	});
});

describe("outline tools in strict plan mode", () => {
	test("keep their descriptions: planning reads and writes the outline", async () => {
		const { PLAN_MODE_ALLOWED_TOOLS } = await import("../types");
		for (const name of ["OutlineRead", "OutlineSearch", "OutlineEdit"]) {
			expect(PLAN_MODE_ALLOWED_TOOLS.has(name)).toBe(true);
		}
	});
});
