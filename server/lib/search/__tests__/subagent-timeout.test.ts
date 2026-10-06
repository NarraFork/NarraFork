import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { settings } from "../../settings";
import * as timeout from "../timeout";

let started = Promise.withResolvers<void>();
let cancelled = Promise.withResolvers<void>();
let cleanup = Promise.withResolvers<void>();
let cleaned = false;
let fallbackCalls = 0;
const originalFetch = globalThis.fetch;
const snapshot = structuredClone(settings);

mock.module("../../../services/subagent-runner", () => ({
	runSubagent: async (input: { signal: AbortSignal }) => {
		started.resolve();
		try {
			await new Promise<never>((_resolve, reject) => {
				const abort = () => {
					cancelled.resolve();
					reject(input.signal.reason);
				};
				if (input.signal.aborted) abort();
				else input.signal.addEventListener("abort", abort, { once: true });
			});
		} finally {
			await cleanup.promise;
			cleaned = true;
		}
		return "unused";
	},
}));
const { executeSearch } = await import("../router");

beforeEach(() => {
	started = Promise.withResolvers<void>();
	cancelled = Promise.withResolvers<void>();
	cleanup = Promise.withResolvers<void>();
	cleaned = false;
	fallbackCalls = 0;
	settings.codex = { ...settings.codex, useWebSearch: true };
	settings.search = {
		...settings.search,
		channels: [
			{
				id: "subagent",
				kind: "subagent",
				enabled: true,
				model: "codex:gpt-5.4",
				maxTurns: 1,
				timeoutMs: 20,
			},
			{ id: "custom:fallback", kind: "custom-api", enabled: true, providerId: "fallback" },
		],
		customProviders: [
			{
				id: "fallback",
				name: "Fallback",
				protocol: "zhipu-web-search-v1",
				apiKey: "test",
				baseUrl: "https://fallback.invalid",
			},
		],
	};
	globalThis.fetch = Object.assign(
		async () => {
			fallbackCalls++;
			return Response.json({
				search_result: [
					{ title: "Fallback result", link: "https://result.invalid", content: "result" },
				],
			});
		},
		{ preconnect: originalFetch.preconnect },
	);
});
afterEach(() => {
	cleanup.resolve();
	globalThis.fetch = originalFetch;
	Object.assign(settings, structuredClone(snapshot));
});
const request = {
	query: "current release",
	purpose: "verify",
	parentNarratorId: "parent",
	parentToolUseId: "tool",
	cwd: process.cwd(),
};

describe("search subagent timeout cleanup", () => {
	test("does not enter the next channel until the timed-out child has finalized", async () => {
		let settled = false;
		const search = executeSearch(request).finally(() => {
			settled = true;
		});
		try {
			await cancelled.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(cleaned).toBe(false);
			expect(fallbackCalls).toBe(0);
			expect(settled).toBe(false);
		} finally {
			cleanup.resolve();
		}
		const result = await search;
		expect(cleaned).toBe(true);
		expect(fallbackCalls).toBe(1);
		expect(result.channelId).toBe("custom:fallback");
		expect(result.attempts[0].error).toContain("timed out");
	});
	test("stops channel fallback when cancelled child cleanup exceeds its grace period", async () => {
		const originalTimeout = timeout.withSearchSubagentTimeout;
		const bounded = spyOn(timeout, "withSearchSubagentTimeout").mockImplementation(
			(signal, operation, deadline) => originalTimeout(signal, operation, deadline, 20),
		);
		try {
			await expect(executeSearch(request)).rejects.toThrow(
				"cleanup timed out; channel fallback stopped",
			);
			expect(cleaned).toBe(false);
			expect(fallbackCalls).toBe(0);
		} finally {
			cleanup.resolve();
			bounded.mockRestore();
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		expect(cleaned).toBe(true);
	});
	test("parent cancellation waits for child cleanup and never falls back", async () => {
		const selected = settings.search?.channels[0];
		if (!selected) throw new Error("Missing test search channel");
		selected.timeoutMs = 5000;
		const controller = new AbortController();
		let settled = false;
		const search = executeSearch({ ...request, signal: controller.signal }).finally(() => {
			settled = true;
		});
		void search.catch(() => {});
		try {
			await started.promise;
			controller.abort(new Error("parent cancelled"));
			await cancelled.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(cleaned).toBe(false);
			expect(settled).toBe(false);
			expect(fallbackCalls).toBe(0);
		} finally {
			cleanup.resolve();
		}
		await expect(search).rejects.toThrow("parent cancelled");
		expect(cleaned).toBe(true);
		expect(fallbackCalls).toBe(0);
	});
});
