import { afterAll, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import { db } from "../../../db";
import { narrators } from "../../../db/schema";
import { generateId } from "../../id";
import type { ChatParams, ProviderAdapter } from "../provider";
import { toolRegistry } from "../tool-registry";
import { type AgentConfig, ApiError } from "../types";

const OLD = { model: "claude-opus-5-5", provider: "prefix-old" };
const NEXT = { model: "gpt-5.4", provider: "prefix-new" };
const TOOL = "PrefixModelRaceTool";
const NEXT_ONLY = "PrefixModelRaceNewTool";
const projections: string[] = [];
const requests: Array<{
	provider: string;
	model: string;
	strategy: ChatParams["toolLoadingStrategy"];
	tools: string[];
}> = [];
let oldAttempts = 0;

function adapter(identity: typeof OLD): ProviderAdapter {
	return {
		formatTools: (tools) => tools.map(({ name, description }) => ({ name, description })),
		toolLoadingTarget: () => ({
			protocol: identity.provider === OLD.provider ? "anthropic-messages" : "openai-responses",
		}),
		buildHistory: async (rows) => {
			projections.push(identity.provider);
			return {
				history: rows.map((row) => ({
					adapter: identity.provider,
					role: row.role,
					content: row.contentText,
				})),
			};
		},
		injectSystemPrompt: (history, prompt) => {
			history.unshift({ adapter: identity.provider, role: "system", content: prompt });
		},
		async *chat(params) {
			for (const row of params.history as Array<{ adapter?: string }>) {
				expect(row.adapter).toBe(identity.provider);
			}
			requests.push({
				provider: identity.provider,
				model: params.model,
				strategy: params.toolLoadingStrategy,
				tools: (params.tools as Array<{ name: string }>).map((tool) => tool.name),
			});
			params.onRequestStart?.();
			if (identity.provider === OLD.provider && ++oldAttempts === 1)
				throw new ApiError(502, "retry the old provider");
			if (identity.provider === OLD.provider) {
				yield { toolUses: [{ toolUseId: "model_race_call", name: TOOL, input: {} }] };
				return;
			}
			yield { text: "new provider completed" };
		},
		generate: async () => "",
		generateWithMeta: async () => ({ text: "" }),
		generateWithHistory: async () => "",
	};
}
const oldAdapter = adapter(OLD);
const nextAdapter = adapter(NEXT);
const realProvider = { ...(await import("../provider")) };
mock.module("../provider", () => ({
	...realProvider,
	getProvider: (provider: string) => (provider === NEXT.provider ? nextAdapter : oldAdapter),
	resolveProviderAndModel: (model: string, provider?: string) => {
		const identity = model.includes(NEXT.model) || provider === NEXT.provider ? NEXT : OLD;
		return {
			...identity,
			requestedModel: model,
			requestedProvider: provider ?? identity.provider,
			adapter: identity.provider === NEXT.provider ? nextAdapter : oldAdapter,
		};
	},
}));
const { agentLoop } = await import("../loop");
const { preparePrefixRequest } = await import(
	"../../../services/agent-runtime/prepare-prefix-request"
);
const { buildRuntimeHistory } = await import("../../../services/agent-runtime/history");
const { buildContextManagementHooks } = await import("../../../services/narrator-session");

afterAll(() => {
	mock.module("../provider", () => realProvider);
	toolRegistry.unregister(TOOL);
	toolRegistry.unregister(NEXT_ONLY);
	mock.restore();
});

test("a UI model change during async retry preparation cannot mix epoch, prompt, tools and provider history", async () => {
	const narratorId = generateId();
	const now = new Date().toISOString();
	await db
		.insert(narrators)
		.values({ id: narratorId, cwd: "/tmp", createdAt: now, updatedAt: now });
	const core = {
		name: TOOL,
		description: "model race tool",
		parameters: z.object({}),
		rawJsonSchema: { type: "object", properties: {} },
		execute: async () => ({ output: "done" }),
	};
	const nextOnly = { ...core, name: NEXT_ONLY };
	toolRegistry.register(core);
	toolRegistry.register(nextOnly);
	const signal = new AbortController().signal;
	let selected = OLD;
	let pendingModel: string | undefined;
	let refreshes = 0;
	let release!: () => void;
	let entered!: () => void;
	const waiting = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const promptModels: string[] = [];
	const toolModels: string[] = [];
	const common = {
		narratorId,
		locale: "en" as const,
		// Deliberately expose live UI selection: the preparer must capture it before awaits.
		getModel: () => selected.model,
		getProvider: () => selected.provider,
		getToolLoading: (identity: typeof OLD) => {
			toolModels.push(identity.provider);
			return {
				managed: new Set<string>(),
				current: new Set<string>(),
				candidates: identity.provider === OLD.provider ? [core] : [core, nextOnly],
			};
		},
		refreshToolLoading: async () => {
			if (++refreshes === 2) {
				entered();
				await held;
			}
		},
		buildPrefixPrompt: async (identity: typeof OLD) => {
			promptModels.push(identity.provider);
			return {
				contract: "fixed",
				parts: [{ key: "request.model", text: `${identity.provider}:${identity.model}` }],
				compactMessageId: null,
			};
		},
	};
	const initial = await preparePrefixRequest({ ...common, signal });
	const firstHistory = await buildRuntimeHistory({
		narratorId,
		model: initial.model,
		provider: initial.provider,
		sourceMessages: initial.sourceMessages,
		toolLoading: initial.toolLoading,
		attachmentSignal: signal,
	});
	const initialEpoch = firstHistory.toolLoading?.epochMarkerId;
	const context = buildContextManagementHooks({ ...common, attachmentSignal: signal });
	const replacements: Array<{ epoch?: string; prompt?: string }> = [];
	const config: AgentConfig = {
		narratorId,
		conversationId: "stable-model-race",
		cwd: "/tmp",
		...OLD,
		signal,
		systemPrompt: initial.reconciled?.systemPrompt,
		toolLoading: firstHistory.toolLoading,
		toolCandidates: firstHistory.toolCandidates,
		permissionHandler: async () => ({ behavior: "allow" }),
		maxTransientRetries: 3,
		retryBackoffCeilMs: 1,
		maxTurns: 3,
		getRuntimeSettingsOverride: () => {
			if (!pendingModel) return null;
			const model = pendingModel;
			pendingModel = undefined;
			return { model };
		},
		onBeforeTurn: async (turn, reason) => {
			const result = await context.onBeforeTurn(turn, reason);
			if (result)
				replacements.push({
					epoch: result.toolLoading?.epochMarkerId,
					prompt: result.systemPrompt,
				});
			return result;
		},
		rebuildRequestHistory: async () => {
			const result = await context.rebuildRequestHistory();
			replacements.push({ epoch: result.toolLoading?.epochMarkerId, prompt: result.systemPrompt });
			return result;
		},
	};
	const running = (async () => {
		for await (const _ of agentLoop(config, "go", { rows: firstHistory.modelMessages })) {
			/* drain real loop */
		}
	})();
	await waiting;
	selected = NEXT;
	pendingModel = `${NEXT.provider}:${NEXT.model}`;
	release();
	await running;

	expect(requests.map(({ provider }) => provider)).toEqual([
		OLD.provider,
		OLD.provider,
		NEXT.provider,
	]);
	expect(requests.map(({ strategy }) => strategy)).toEqual([
		"anthropic_tool_addition",
		"anthropic_tool_addition",
		"openai_additional_tools",
	]);
	expect(requests[1]?.tools).not.toContain(NEXT_ONLY);
	expect(requests[2]?.tools).toContain(NEXT_ONLY);
	expect(replacements[0]?.epoch).toBe(initialEpoch);
	expect(replacements[0]?.prompt).toBe(initial.reconciled?.systemPrompt);
	expect(replacements[1]?.epoch).not.toBe(initialEpoch);
	expect(replacements[1]?.prompt).toContain(`${NEXT.provider}:${NEXT.model}`);
	expect(promptModels).toEqual([OLD.provider, OLD.provider, NEXT.provider]);
	expect(toolModels.slice(0, 4)).toEqual([OLD.provider, OLD.provider, OLD.provider, OLD.provider]);
	expect(projections).toContain(OLD.provider);
	expect(projections.at(-1)).toBe(NEXT.provider);
});
