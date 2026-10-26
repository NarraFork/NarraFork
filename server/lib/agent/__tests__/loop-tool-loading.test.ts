/**
 * The loop sends the history's loading state as a fixed tool array.
 *
 * Managed optional tools pass `toolFilter` unconditionally; the loop keeps only the base
 * set in the array, adds the deferred placeholder for the Anthropic modes, re-derives the
 * array when a rebuilt history moves the epoch boundary, and the executor rejects a call
 * to a managed tool that is no longer loaded even though it is still declared.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import { settings } from "../../settings";
import type { ChatParams, ProviderAdapter } from "../provider";
import { DEFERRED_TOOL_PLACEHOLDER, type ToolLoadingState } from "../tool-loading";
import { toolRegistry } from "../tool-registry";
import type { AgentConfig } from "../types";

const CORE = "TlCoreTool";
const BASE = "TlBaseTool";
const LOADED = "TlLoadedTool";
const EXTRA = "TlExtraTool";
const OWN = new Set([CORE, BASE, LOADED]);

const requests: Array<{ tools: string[]; strategy: ChatParams["toolLoadingStrategy"] }> = [];
const toolPayloads: Array<Array<Record<string, unknown>>> = [];
const toolOutputs: string[] = [];
let script: Array<() => Record<string, unknown>> = [];

const testProvider: ProviderAdapter = {
	formatTools: (tools) => tools.map(({ name, description }) => ({ name, description })),
	toolLoadingTarget: () => ({ protocol: "anthropic-messages" }),
	buildHistory: async () => ({ history: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		const payload = params.tools as Array<Record<string, unknown>>;
		toolPayloads.push(payload);
		requests.push({
			tools: payload
				.map((tool) => String(tool.name))
				.filter(
					(name) => OWN.has(name) || name === EXTRA || name === DEFERRED_TOOL_PLACEHOLDER.name,
				),
			strategy: params.toolLoadingStrategy,
		});
		const next = script.shift();
		yield next ? next() : { text: "done" };
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};

const realProviderModule = { ...(await import("../provider")) };

mock.module("../provider", () => ({
	getProvider: () => testProvider,
	resolveProviderAndModel: () => ({
		requestedProvider: "test",
		requestedModel: "test:claude-opus-5-5",
		provider: "test",
		adapter: testProvider,
		model: "test:claude-opus-5-5",
	}),
}));

const { agentLoop } = await import("../loop");

for (const name of OWN)
	toolRegistry.register({
		name,
		description: `${name} description`,
		parameters: z.object({}),
		execute: async () => ({ output: `${name} ran` }),
	});

afterAll(() => {
	mock.module("../provider", () => realProviderModule);
	for (const name of OWN) toolRegistry.unregister(name);
	toolRegistry.unregister(EXTRA);
	mock.restore();
});

function state(base: string[], loaded: string[], current: string[]): ToolLoadingState {
	return {
		managed: new Set([BASE, LOADED]),
		base: new Set(base),
		loaded,
		current: new Set(current),
	};
}

function makeConfig(overrides: Partial<AgentConfig>): AgentConfig {
	return {
		narratorId: "n-tool-loading",
		conversationId: "conv-tool-loading",
		model: "test:claude-opus-5-5",
		provider: "test",
		cwd: "/tmp",
		signal: new AbortController().signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		...overrides,
	} as AgentConfig;
}

async function drain(config: AgentConfig): Promise<void> {
	for await (const event of agentLoop(config, "go", { rows: [] })) {
		if (event.type === "tool_result") toolOutputs.push(event.output);
	}
}

function reset(steps: Array<() => Record<string, unknown>>): void {
	requests.length = 0;
	toolPayloads.length = 0;
	toolOutputs.length = 0;
	script = steps;
}

const callTool = (name: string) => () => ({
	toolUses: [{ toolUseId: `tu_${name}`, name, input: {} }],
});

describe("loop tool loading", () => {
	test("MCP auto requires loading and disabled is checked live after declaration", async () => {
		const original = settings.mcpServers;
		const name = "mcp__loading_test__run";
		toolRegistry.register({
			name,
			description: "MCP test",
			parameters: z.object({}),
			metadata: { mcpServerId: "loading-test", mcpToolName: "run" },
			execute: async () => ({ output: "MCP ran" }),
		});
		try {
			settings.mcpServers = [
				{
					id: "loading-test",
					name: "test",
					mode: "auto",
					enabled: true,
					transport: "stdio",
					command: "unused",
				},
			];
			reset([callTool(name)]);
			await drain(
				makeConfig({ isToolLoaded: () => false, toolFilter: (tool) => tool.name === name }),
			);
			expect(toolOutputs.some((output) => output.includes("disabled or not loaded"))).toBe(true);
			reset([callTool(name)]);
			await drain(
				makeConfig({
					isToolLoaded: () => false,
					toolFilter: (tool) => tool.name === name,
					toolLoading: { managed: new Set(), base: new Set(), loaded: [], current: new Set() },
				}),
			);
			expect(toolOutputs).toContain("MCP ran");
			reset([
				() => {
					settings.mcpServers = (settings.mcpServers ?? []).map((server) => ({
						...server,
						mode: "disabled",
					}));
					return callTool(name)();
				},
			]);
			await drain(
				makeConfig({ isToolLoaded: () => true, toolFilter: (tool) => tool.name === name }),
			);
			expect(toolOutputs.some((output) => output.includes("disabled or not loaded"))).toBe(true);
		} finally {
			settings.mcpServers = original;
			toolRegistry.unregister(name);
		}
	});
	test("MCP mode changes in one loop do not reuse resident membership as an explicit grant", async () => {
		const original = settings.mcpServers;
		const name = "mcp__live_mode__run";
		const server = {
			id: "live-mode",
			name: "live",
			mode: "resident" as "resident" | "auto" | "disabled",
			enabled: true,
			transport: "stdio" as const,
			command: "unused",
		};
		let runs = 0;
		toolRegistry.register({
			name,
			description: "live mode test",
			parameters: z.object({}),
			metadata: { mcpServerId: server.id, mcpToolName: "run" },
			execute: async () => {
				runs++;
				return { output: "live MCP ran" };
			},
		});
		try {
			settings.mcpServers = [server];
			reset([
				callTool(name),
				() => {
					server.mode = "auto";
					return callTool(name)();
				},
				() => {
					server.mode = "resident";
					return callTool(name)();
				},
				() => {
					server.mode = "disabled";
					return callTool(name)();
				},
				() => {
					server.mode = "auto";
					return callTool(name)();
				},
			]);
			await drain(
				makeConfig({
					toolFilter: (tool) => tool.name === name,
					// Deliberately stale concrete resident membership, without a server marker.
					isToolLoaded: (toolName) => toolName === name,
					toolLoading: {
						managed: new Set([name]),
						base: new Set([name]),
						loaded: [],
						current: new Set([name]),
					},
				}),
			);
			expect(runs).toBe(2);
			expect(
				toolOutputs.filter((output) => output.includes("disabled or not loaded")),
			).toHaveLength(3);
			// A switch from auto to resident must also ignore stale unloaded membership.
			server.mode = "auto";
			reset([
				() => {
					server.mode = "resident";
					return callTool(name)();
				},
			]);
			await drain(
				makeConfig({
					toolFilter: (tool) => tool.name === name,
					isToolLoaded: () => false,
					toolLoading: {
						managed: new Set([name]),
						base: new Set([name]),
						loaded: [],
						current: new Set(),
					},
				}),
			);
			expect(runs).toBe(3);
		} finally {
			settings.mcpServers = original;
			toolRegistry.unregister(name);
		}
	});
	test("keeps loaded tools out of the array and re-derives it after a rebuild", async () => {
		reset([callTool(CORE)]);
		await drain(
			makeConfig({
				toolLoading: state([BASE], [LOADED], [BASE, LOADED]),
				isToolLoaded: () => true,
				// A compact folds the load into the new epoch's base set.
				onBeforeTurn: async () => ({
					history: [],
					rows: [],
					toolLoading: state([BASE, LOADED], [], [BASE, LOADED]),
					toolCandidates: toolRegistry.all(),
				}),
			}),
		);
		expect(requests).toEqual([
			{
				tools: [CORE, BASE, DEFERRED_TOOL_PLACEHOLDER.name],
				strategy: "anthropic_tool_addition",
			},
			{
				tools: [CORE, BASE, LOADED, DEFERRED_TOOL_PLACEHOLDER.name],
				strategy: "anthropic_tool_addition",
			},
		]);
	});

	test("plain rebuilds preserve tools and loading rebuilds apply same-layout candidate changes", async () => {
		reset([callTool(CORE), callTool(CORE)]);
		const initialCandidates = toolRegistry.all();
		const loading = state([BASE], [], [BASE]);
		const disabled = new Set<string>();
		let rebuild = 0;
		try {
			await drain(
				makeConfig({
					toolLoading: loading,
					toolCandidates: initialCandidates,
					isToolLoaded: () => true,
					toolFilter: (tool) => !disabled.has(tool.name),
					onBeforeTurn: async () => {
						rebuild++;
						if (rebuild === 1) {
							toolRegistry.register({
								name: EXTRA,
								description: "newly registered",
								parameters: z.object({}),
								execute: async () => ({ output: "extra" }),
							});
							// No toolLoading: an ordinary replacement cannot change the tool view.
							return { history: [], rows: [] };
						}
						disabled.add(CORE);
						const candidates = initialCandidates.map((tool) =>
							tool.name === BASE ? { ...tool, description: "changed schema description" } : tool,
						);
						candidates.push({
							name: EXTRA,
							description: "newly registered",
							parameters: z.object({}),
							execute: async () => ({ output: "extra" }),
						});
						// The loading layout is identical; candidates still changed on all three axes.
						return { history: [], rows: [], toolLoading: loading, toolCandidates: candidates };
					},
				}),
			);
			expect(requests.map((request) => request.tools)).toEqual([
				[CORE, BASE, DEFERRED_TOOL_PLACEHOLDER.name],
				[CORE, BASE, DEFERRED_TOOL_PLACEHOLDER.name],
				[BASE, EXTRA, DEFERRED_TOOL_PLACEHOLDER.name],
			]);
			const base = toolPayloads[2]?.find((tool) => tool.name === BASE);
			expect(base?.description).toBe("changed schema description");
		} finally {
			toolRegistry.unregister(EXTRA);
		}
	});

	test("a loading-aware rebuild without candidates fails instead of mixing views", async () => {
		reset([callTool(CORE)]);
		const loading = state([BASE], [], [BASE]);
		await expect(
			drain(
				makeConfig({
					toolLoading: loading,
					toolCandidates: toolRegistry.all(),
					onBeforeTurn: async () => ({ history: [], rows: [], toolLoading: loading }),
				}),
			),
		).rejects.toThrow("must include tool candidates");
		expect(requests).toHaveLength(1);
	});

	test("rejects a declared tool that is no longer loaded", async () => {
		reset([callTool(BASE)]);
		await drain(
			makeConfig({
				toolLoading: state([BASE], [], []),
				isToolLoaded: (name) => name !== BASE,
			}),
		);
		expect(requests[0]?.tools).toContain(BASE);
		expect(toolOutputs[0]).toContain(`Tool is not loaded in this session: ${BASE}`);
	});

	test("a session with no loadable tools keeps the plain request shape", async () => {
		reset([]);
		await drain(
			makeConfig({
				toolLoading: { managed: new Set(), base: new Set(), loaded: [], current: new Set() },
				isToolLoaded: () => true,
			}),
		);
		expect(requests[0]).toEqual({ tools: [CORE, BASE, LOADED], strategy: "replace_tools" });
	});

	test("without a loading state every filtered tool is sent as before", async () => {
		reset([]);
		await drain(makeConfig({}));
		expect(requests[0]).toEqual({ tools: [CORE, BASE, LOADED], strategy: "replace_tools" });
	});
});
