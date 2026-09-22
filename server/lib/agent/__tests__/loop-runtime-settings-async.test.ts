import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { agentLoop } from "../loop";
import {
	type ChatParams,
	type ParsedStreamEvent,
	type ProviderAdapter,
	registerExternalProviderResolver,
} from "../provider";
import { toolRegistry } from "../tool-registry";
import type { AgentConfig, AgentEvent, RuntimeSettingsOverride } from "../types";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

const TOOL = "InheritedRuntimeBoundaryTool";
const A = "asyncfixture:a";
const B = "asyncfixture:b";
const requests: ChatParams[] = [];
let chat: (params: ChatParams) => AsyncGenerator<ParsedStreamEvent> = async function* () {
	yield { text: "done" };
};
const adapter: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		requests.push(params);
		yield* chat(params);
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
const unregister = registerExternalProviderResolver((name) =>
	name === "asyncfixture" ? adapter : null,
);
toolRegistry.register({
	name: TOOL,
	description: "Drive one safe test-only turn boundary",
	parameters: z.object({}),
	execute: async () => ({ output: "done" }),
});
beforeEach(() => {
	requests.length = 0;
	chat = async function* () {
		yield { text: "done" };
	};
});
afterAll(() => {
	unregister();
	toolRegistry.unregister(TOOL);
});

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		narratorId: "async-model-boundary",
		conversationId: "async-model-boundary-conversation",
		model: A,
		provider: "asyncfixture",
		cwd: process.env.HOME as string,
		signal: new AbortController().signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		toolFilter: (tool) => tool.name === TOOL,
		maxTransientRetries: 1,
		retryBackoffCeilMs: 0,
		...overrides,
	};
}
async function drain(input: AgentConfig): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of agentLoop(input, "fixture input", [])) events.push(event);
	return events;
}

describe("asynchronous runtime settings at real provider request boundaries", () => {
	test("first request waits for the asynchronous model/policy resolution", async () => {
		const entered = deferred<void>();
		const policy = deferred<RuntimeSettingsOverride | null>();
		const running = drain(
			config({
				getRuntimeSettingsOverride: () => {
					entered.resolve();
					return policy.promise;
				},
			}),
		);
		await entered.promise;
		expect(requests).toHaveLength(0);
		policy.resolve({ model: B, reasoningEffort: "low" });
		const events = await running;
		expect(requests).toHaveLength(1);
		expect(requests[0].model).toBe(B);
		expect(requests[0].reasoningEffort).toBe("low");
		expect(events.at(-1)?.type).toBe("done");
	});

	test("an in-flight request finishes normally; the following request waits for refreshed policy", async () => {
		const firstStarted = deferred<void>();
		const finishFirst = deferred<void>();
		const boundaryEntered = deferred<void>();
		const policy = deferred<RuntimeSettingsOverride | null>();
		let pending = false;
		chat = async function* () {
			if (requests.length === 1) {
				firstStarted.resolve();
				await finishFirst.promise;
				yield { toolUses: [{ toolUseId: "inherit-boundary", name: TOOL, input: {} }] };
				return;
			}
			yield { text: "new model completed" };
		};
		const controller = new AbortController();
		const running = drain(
			config({
				signal: controller.signal,
				getRuntimeSettingsOverride: () => {
					if (!pending) return null;
					boundaryEntered.resolve();
					return policy.promise;
				},
			}),
		);
		await firstStarted.promise;
		pending = true;
		expect(requests).toHaveLength(1);
		expect(requests[0].signal?.aborted).toBe(false);
		finishFirst.resolve();
		await boundaryEntered.promise;
		expect(requests).toHaveLength(1);
		policy.resolve({ model: B });
		const events = await running;
		expect(requests.map((request) => request.model)).toEqual([A, B]);
		expect(controller.signal.aborted).toBe(false);
		expect(events.at(-1)?.type).toBe("done");
	});

	test("retry attempts also await the refreshed model policy", async () => {
		const entered = deferred<void>();
		const policy = deferred<RuntimeSettingsOverride | null>();
		let pending = false;
		chat = async function* () {
			if (requests.length === 1) {
				pending = true;
				yield { invalidState: { reason: "overloaded_error", message: "upstream overloaded" } };
				return;
			}
			yield { text: "retry recovered" };
		};
		const running = drain(
			config({
				getRuntimeSettingsOverride: () => {
					if (!pending) return null;
					entered.resolve();
					return policy.promise;
				},
			}),
		);
		await entered.promise;
		expect(requests).toHaveLength(1);
		policy.resolve({ model: B });
		await running;
		expect(requests.map((request) => request.model)).toEqual([A, B]);
	});

	test("rejected policy resolution fails closed before any provider request", async () => {
		await expect(
			drain(
				config({
					getRuntimeSettingsOverride: async () => {
						throw new Error("pool denied");
					},
				}),
			),
		).rejects.toThrow("pool denied");
		expect(requests).toHaveLength(0);
	});

	test("existing synchronous overrides remain supported", async () => {
		await drain(config({ getRuntimeSettingsOverride: () => ({ model: B }) }));
		expect(requests.map((request) => request.model)).toEqual([B]);
	});

	test("a failing retry probe is treated as no pending switch instead of aborting the turn", async () => {
		let calls = 0;
		chat = async function* () {
			yield { invalidState: { reason: "overloaded_error", message: "upstream overloaded" } };
		};
		const events = await drain(
			config({
				maxTransientRetries: 0,
				getRuntimeSettingsOverride: async () => {
					calls += 1;
					// First call is the per-attempt authorization boundary (must succeed).
					// The retry probe after the failure is the one that cannot resolve.
					if (calls === 1) return null;
					throw new Error("probe failed");
				},
			}),
		);
		expect(requests).toHaveLength(1);
		expect(events.at(-1)?.type).toBe("retryable_error");
	});
});
