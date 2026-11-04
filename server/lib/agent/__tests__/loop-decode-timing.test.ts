/**
 * loop-decode-timing.test.ts — the output-speed denominator.
 *
 * `api_request_end.decodeMs` spans the attempt's first persistable content to its
 * end. A gateway queue notice counts as "meaningful" for TTFT/liveness, but it is
 * not output, so the decode window must not start there: a long queue wait would
 * otherwise read as a slow model.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ProviderAdapter } from "../provider";
import type { AgentConfig, AgentEvent } from "../types";

const QUEUE_WAIT_MS = 120;
const DECODE_MS = 40;
let scenario: "queue_then_text" | "usage_only" = "queue_then_text";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const testProvider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		params.onRequestStart?.();
		if (scenario === "usage_only") {
			yield { text: "" };
			yield { usage: { promptTokens: 10, completionTokens: 0 } };
			return;
		}
		yield { queueStatus: { position: 1, queueDepth: 1 } };
		await sleep(QUEUE_WAIT_MS);
		yield { text: "hello" };
		await sleep(DECODE_MS);
		yield { text: " world" };
		yield { usage: { promptTokens: 10, completionTokens: 8 } };
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};

const realProviderModule = { ...(await import("../provider")) };

mock.module("../provider", () => ({
	...realProviderModule,
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

afterAll(() => {
	mock.module("../provider", () => realProviderModule);
	mock.restore();
});

function makeConfig(signal: AbortSignal): AgentConfig {
	return {
		narratorId: "n-decode-timing",
		conversationId: "conv-decode-timing",
		model: "test:model",
		provider: "test",
		cwd: "/tmp",
		signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		retryBackoffCeilMs: 1,
		maxTransientRetries: 0,
	};
}

async function requestEnds(): Promise<Array<Extract<AgentEvent, { type: "api_request_end" }>>> {
	const ac = new AbortController();
	const ends: Array<Extract<AgentEvent, { type: "api_request_end" }>> = [];
	for await (const event of agentLoop(makeConfig(ac.signal), "hi", { rows: [] })) {
		if (event.type === "api_request_end") ends.push(event);
	}
	return ends;
}

describe("agentLoop decode timing", () => {
	beforeEach(() => {
		scenario = "queue_then_text";
	});

	test("decode window starts at first content, not at the queue notice", async () => {
		const [end] = await requestEnds();
		expect(end?.usage?.completionTokens).toBe(8);
		expect(end?.decodeMs).toBeGreaterThanOrEqual(DECODE_MS - 5);
		// The queue wait is in the request duration but not in the decode window.
		expect(end?.decodeMs ?? 0).toBeLessThan(QUEUE_WAIT_MS);
		expect(end?.durationMs ?? 0).toBeGreaterThanOrEqual(QUEUE_WAIT_MS + DECODE_MS - 5);
	});

	test("a request that produced no content reports no decode window", async () => {
		scenario = "usage_only";
		const ends = await requestEnds();
		expect(ends.length).toBeGreaterThan(0);
		for (const end of ends) expect(end.decodeMs).toBeUndefined();
	});
});
