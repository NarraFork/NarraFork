/**
 * A plan-mode toggle landing between turns must re-format the tool array.
 *
 * `allTools` is built once per pass and `tools` (the provider-formatted array actually
 * sent) was only re-formatted on a provider/model switch. So when plan mode was toggled
 * manually mid-pass, the forbidden tools kept their normal descriptions for the rest of
 * the turn — the model saw nothing telling it to stop calling them, while the permission
 * gate (which re-reads the DB per call) was already denying them.
 *
 * Two things are pinned here, and the second is the one that breaks silently:
 *
 *   1. the descriptions do flip when `config.planMode` flips between turns;
 *   2. the tool NAME SET never changes. NUG requires history consistency, so dropping
 *      or renaming a tool mid-conversation corrupts the replayed history rather than
 *      producing a clean error.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import type { ProviderAdapter } from "../provider";
import { toolRegistry } from "../tool-registry";
import type { AgentConfig, AgentEvent } from "../types";

/** Not in PLAN_MODE_ALLOWED_TOOLS, so plan mode must blank its description. */
const FORBIDDEN_TOOL = "PlanToggleForbiddenTool";
/** In PLAN_MODE_ALLOWED_TOOLS, so its description must survive plan mode untouched. */
const ALLOWED_TOOL = "Read";

const FORBIDDEN_DESCRIPTION = "Mutates the workspace; must be blanked in plan mode";
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
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat() {
		// Turn 0 calls a tool (so the loop reaches a turn boundary), turn 1 just answers.
		if (turnsServed++ === 0) {
			yield { toolUses: [{ toolUseId: "tu_plan_toggle", name: ALLOWED_TOOL, input: {} }] };
			return;
		}
		yield { text: "done" };
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushAssistantTurn: () => {},
	pushUserTurn: () => {},
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
	for await (const event of agentLoop(config, "go", [])) events.push(event);
	return events;
}

function resetRun(): void {
	formatToolsCalls.length = 0;
	formattedToolCharacters.length = 0;
	turnsServed = 0;
}

describe("plan mode tool descriptions", () => {
	test("reports actual serialized tools once initially and again after a refresh", async () => {
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
		expect(counts).toHaveLength(2);
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

	test("blanks forbidden tool descriptions when plan mode is on at pass start", async () => {
		resetRun();
		livePlanMode = true;

		await drain(makeLivePlanModeConfig());

		const first = formatToolsCalls[0];
		expect(first).toBeDefined();
		expect(describedTool(first ?? [], FORBIDDEN_TOOL)).not.toBe(FORBIDDEN_DESCRIPTION);
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

	test("re-formats tools when plan mode is toggled on between turns", async () => {
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

		expect(formatToolsCalls.length).toBeGreaterThanOrEqual(2);
		const before = formatToolsCalls[0] ?? [];
		const after = formatToolsCalls[formatToolsCalls.length - 1] ?? [];

		expect(describedTool(before, FORBIDDEN_TOOL)).toBe(FORBIDDEN_DESCRIPTION);
		expect(describedTool(after, FORBIDDEN_TOOL)).not.toBe(FORBIDDEN_DESCRIPTION);
		// ⚠️ Load-bearing: names must be identical across the re-format. A changed name set
		// corrupts the replayed history on NUG instead of failing loudly.
		expect(after.map((tool) => tool.name).sort()).toEqual(before.map((tool) => tool.name).sort());
	});

	test("re-formats tools when plan mode is toggled off between turns", async () => {
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

		expect(formatToolsCalls.length).toBeGreaterThanOrEqual(2);
		const before = formatToolsCalls[0] ?? [];
		const after = formatToolsCalls[formatToolsCalls.length - 1] ?? [];

		expect(describedTool(before, FORBIDDEN_TOOL)).not.toBe(FORBIDDEN_DESCRIPTION);
		// The exit direction: leaving the description blanked would keep the model refusing
		// work the DB has already released.
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
