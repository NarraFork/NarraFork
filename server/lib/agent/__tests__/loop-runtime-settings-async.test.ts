import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import { startApiRequest } from "../../api-request-tracker";
import { RequestRecorderClient } from "../../request-recorder";
import { agentLoop, toolFormatSignature } from "../loop";
import {
	type ChatParams,
	type ParsedStreamEvent,
	type ProviderAdapter,
	registerExternalProviderResolver,
} from "../provider";
import { resolveToolJsonSchema, toolRegistry } from "../tool-registry";
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
	// Match the public provider boundary: wire tools contain JSON schemas, not Zod instances.
	formatTools: (tools) =>
		tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: resolveToolJsonSchema(tool),
		})),
	buildHistory: async () => ({ history: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		requests.push(params);
		yield* chat(params);
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
const unregister = registerExternalProviderResolver({
	resolve: (name) => (name === "asyncfixture" ? adapter : null),
	listReadiness: () => [],
});
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
	for await (const event of agentLoop(input, "fixture input", { rows: [] })) events.push(event);
	return events;
}

async function drainWithApiAssociations(input: AgentConfig) {
	const events: AgentEvent[] = [];
	const ids = new Map<string, string>();
	const pending = new Map<string, string>();
	const configure = spyOn(RequestRecorderClient.prototype, "configure").mockImplementation(
		() => {},
	);
	const capture = spyOn(RequestRecorderClient.prototype, "capture").mockImplementation(() => true);
	try {
		for await (const event of agentLoop(input, "fixture input", { rows: [] })) {
			events.push(event);
			if (event.type === "api_request_start") {
				const handle = startApiRequest({
					recordingRequestId: event.requestId,
					narratorId: input.narratorId,
					provider: event.provider,
					model: event.model,
					kind: "narrator",
				});
				ids.set(event.requestId, handle.id);
				pending.set(event.requestId, handle.id);
			} else if (event.type === "api_request_end") {
				// Match the consumer boundary: only the first end can bind the API row.
				const id = pending.get(event.requestId);
				if (id && event.diagnostics) {
					expect(event.diagnostics.apiRequestId).toBeUndefined();
					expect(event.diagnostics.recordingRequestId).toBe(event.requestId);
					event.diagnostics.apiRequestId = id;
				}
				pending.delete(event.requestId);
			}
		}
		return { events, ids, pending };
	} finally {
		capture.mockRestore();
		configure.mockRestore();
	}
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

	test("existing synchronous overrides remain supported and count the refreshed tools", async () => {
		const characters: number[] = [];
		await drain(
			config({
				getRuntimeSettingsOverride: () => ({ model: B }),
				onToolsCharacters: (chars) => {
					characters.push(chars);
				},
			}),
		);
		expect(requests.map((request) => request.model)).toEqual([B]);
		expect(characters).toHaveLength(2);
		expect(characters.at(-1)).toBe(
			requests[0].tools.reduce<number>((sum, tool) => sum + JSON.stringify(tool).length, 0),
		);
	});

	test.each([
		["provider", "no-op"],
		["provider", "failed"],
		["timeout", "no-op"],
		["timeout", "failed"],
	] as const)("%s pending %s switch finishes once and retains the consumer API association", async (failure, switching) => {
		let probes = 0;
		chat = async function* (params) {
			params.onRequestStart?.();
			if (failure === "timeout") {
				await new Promise<void>((resolve) => {
					if (params.signal?.aborted) resolve();
					else params.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				throw new Error("timeout fixture aborted");
			}
			yield {
				invalidState: {
					reason: "overloaded_error",
					message: "upstream overloaded",
					diagnostics: {
						schema: "narrafork.error-diagnostics.v1",
						recordingRequestId: "spoof-attempt",
						apiRequestId: "spoof-row",
					},
				},
			};
		};
		const { events, ids, pending } = await drainWithApiAssociations(
			config({
				maxTransientRetries: 0,
				firstTokenTimeoutMs: failure === "timeout" ? 10 : 0,
				getRuntimeSettingsOverride: () => {
					if (requests.length === 0) return null;
					probes++;
					if (probes === 1) return { model: B };
					// An unsupported provider throws inside applyPendingRuntimeSettings,
					// whose failed switch returns null just like a withdrawn override.
					return switching === "failed" ? { model: "missing-switch-fixture:model" } : null;
				},
			}),
		);
		expect(probes).toBe(2);
		expect(requests).toHaveLength(1);
		const starts = events.filter((event) => event.type === "api_request_start");
		const ends = events.filter((event) => event.type === "api_request_end");
		expect(starts).toHaveLength(1);
		expect(ends).toHaveLength(1);
		expect(ends[0].requestId).toBe(starts[0].requestId);
		expect(pending.size).toBe(0);
		const terminal = events.at(-1);
		if (terminal?.type !== "retryable_error") throw new Error("missing retryable error");
		expect(terminal.diagnostics).toBe(ends[0].diagnostics);
		expect(terminal.diagnostics?.recordingRequestId).toBe(starts[0].requestId);
		expect(terminal.diagnostics?.apiRequestId).toBe(ids.get(starts[0].requestId));
		expect(terminal.diagnostics?.apiRequestId).not.toBe("spoof-row");
	});

	test("normal provider retries reset teardown and retain separate start/end associations", async () => {
		chat = async function* (params) {
			params.onRequestStart?.();
			yield { invalidState: { reason: "overloaded_error", message: "upstream overloaded" } };
		};
		const { events, ids, pending } = await drainWithApiAssociations(config());
		const starts = events.filter((event) => event.type === "api_request_start");
		const ends = events.filter((event) => event.type === "api_request_end");
		expect(requests).toHaveLength(2);
		expect(starts).toHaveLength(2);
		expect(ends).toHaveLength(2);
		expect(new Set(starts.map((event) => event.requestId)).size).toBe(2);
		expect(ends.map((event) => event.requestId)).toEqual(starts.map((event) => event.requestId));
		for (const end of ends) expect(end.diagnostics?.apiRequestId).toBe(ids.get(end.requestId));
		expect(pending.size).toBe(0);
		const terminal = events.at(-1);
		if (terminal?.type !== "retryable_error") throw new Error("missing retryable error");
		expect(terminal.diagnostics).toBe(ends[1].diagnostics);
		expect(terminal.diagnostics?.apiRequestId).not.toBe(ends[0].diagnostics?.apiRequestId);
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

describe("工具格式签名", () => {
	test("同前缀换协议得到不同签名，缺失或抛错的适配器回落到空签名", () => {
		const anthropic = { toolLoadingTarget: () => ({ protocol: "anthropic-messages" }) };
		const completions = { toolLoadingTarget: () => ({ protocol: "completions-compatible" }) };
		expect(toolFormatSignature(anthropic, A)).not.toBe(toolFormatSignature(completions, A));
		// 没有协议声明的适配器不参与比较，避免把「不知道」误判成「变了」。
		expect(toolFormatSignature({}, A)).toBe("null");
		expect(
			toolFormatSignature(
				{
					toolLoadingTarget: () => {
						throw new Error("unavailable");
					},
				},
				A,
			),
		).toBe("");
	});
});
