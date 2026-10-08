import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type MutationFunction, QueryClient, type QueryFunction } from "@tanstack/react-query";
import { pickRequestOptions } from "./client";
import { miscApi } from "./misc";
import { settingsApi } from "./settings";

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const calls: Array<{ url: string; init?: RequestInit }> = [];
let responseBody = '{"ok":true}';
let responseHeaders: Record<string, string> = {};
let responseStatus = 200;
let jsonReads = 0;
const removedStorageKeys: string[] = [];

beforeEach(() => {
	calls.length = 0;
	responseBody = '{"ok":true}';
	responseHeaders = {};
	responseStatus = 200;
	jsonReads = 0;
	removedStorageKeys.length = 0;
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: () => "session-token",
			removeItem: (key: string) => removedStorageKeys.push(key),
		},
	});
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), init });
		if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const response = new Response(responseBody, {
			status: responseStatus,
			headers: { "content-type": "application/json", ...responseHeaders },
		});
		const readJson = response.json.bind(response);
		response.json = () => {
			jsonReads++;
			return readJson();
		};
		return response;
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

const settingsData = { providers: [{ id: "provider-id", name: "Example" }] };
const wrappers: Array<{
	name: string;
	path: string;
	method?: string;
	body?: string;
	call: (options?: object) => Promise<unknown>;
}> = [
	{
		name: "getSettings",
		path: "/api/settings",
		call: (options) => settingsApi.getSettings(options),
	},
	{
		name: "updateSettings",
		path: "/api/settings",
		method: "PATCH",
		body: JSON.stringify(settingsData),
		call: (options) => settingsApi.updateSettings(settingsData, options),
	},
	...(["openai", "anthropic", "gemini", "nug"] as const).map((provider) => ({
		name: `${provider}RefreshProviderModels`,
		path: `/api/${provider}/providers/provider-id/models/refresh`,
		method: "POST",
		call: (options?: object) => miscApi[`${provider}RefreshProviderModels`]("provider-id", options),
	})),
];

describe("provider creation API transport", () => {
	for (const wrapper of wrappers) {
		test(`${wrapper.name} preserves its legacy request and authentication`, async () => {
			await expect(wrapper.call()).resolves.toEqual({ ok: true });
			expect(calls).toHaveLength(1);
			expect(calls[0].url).toBe(wrapper.path);
			expect(calls[0].init?.method).toBe(wrapper.method);
			expect(calls[0].init?.body).toBe(wrapper.body);
			expect(calls[0].init?.signal).toBeUndefined();
			expect(calls[0].init?.headers).toEqual({
				Authorization: "Bearer session-token",
				...(wrapper.body ? { "Content-Type": "application/json" } : {}),
			});
		});

		test(`${wrapper.name} forwards signal but no unrelated context or fetch options`, async () => {
			const controller = new AbortController();
			await wrapper.call({
				signal: controller.signal,
				maxResponseBytes: 1024,
				queryClient: {},
				meta: { source: "query" },
				headers: { Authorization: "injected" },
				method: "DELETE",
				body: "injected",
			});
			expect(calls[0].init?.signal).toBe(controller.signal);
			expect(calls[0].init?.method).toBe(wrapper.method);
			expect(calls[0].init?.body).toBe(wrapper.body);
			expect(calls[0].init?.headers).toEqual({
				Authorization: "Bearer session-token",
				...(wrapper.body ? { "Content-Type": "application/json" } : {}),
			});
			for (const key of ["queryClient", "meta", "maxResponseBytes"]) {
				expect(calls[0].init).not.toHaveProperty(key);
			}
		});

		test(`${wrapper.name} applies the byte budget to streamed responses`, async () => {
			responseBody = '{"text":"超出字节预算"}';
			await expect(wrapper.call({ maxResponseBytes: 10 })).rejects.toMatchObject({
				status: 413,
				data: { code: "RESPONSE_TOO_LARGE" },
			});
		});

		test(`${wrapper.name} applies the byte budget to content-length responses`, async () => {
			responseHeaders = { "content-length": "500" };
			await expect(wrapper.call({ maxResponseBytes: 100 })).rejects.toThrow(
				"Response exceeds byte budget",
			);
		});

		for (const status of [401, 500]) {
			for (const declaredLength of [false, true]) {
				test(`${wrapper.name} limits ${status} JSON errors (${declaredLength ? "content-length" : "stream"}) before parsing or clearing a session`, async () => {
					responseStatus = status;
					responseBody = JSON.stringify({ code: "UNAUTHORIZED", error: "错误".repeat(40) });
					if (declaredLength) responseHeaders = { "content-length": "1000" };
					await expect(wrapper.call({ maxResponseBytes: 64 })).rejects.toMatchObject({
						status: 413,
						data: { code: "RESPONSE_TOO_LARGE" },
					});
					expect(jsonReads).toBe(0);
					expect(removedStorageKeys).toEqual([]);
				});
			}
		}

		test(`${wrapper.name} honors cancellation`, async () => {
			const controller = new AbortController();
			controller.abort();
			await expect(wrapper.call({ signal: controller.signal })).rejects.toMatchObject({
				name: "AbortError",
			});
		});

		test(`${wrapper.name} ignores mutation context and invalid signal values`, async () => {
			const context = { client: {}, mutationKey: ["save"], meta: {}, signal: {} };
			await wrapper.call(context);
			expect(calls[0].init?.signal).toBeUndefined();
			for (const key of ["client", "mutationKey", "meta"]) {
				expect(calls[0].init).not.toHaveProperty(key);
			}
		});
	}

	test("model refresh rejects a real over-8MiB JSON 500 body without fully parsing it", async () => {
		responseStatus = 500;
		responseBody = JSON.stringify({ error: "x".repeat(8 * 1024 * 1024) });
		await expect(
			miscApi.openaiRefreshProviderModels("provider-id", { maxResponseBytes: 8 * 1024 * 1024 }),
		).rejects.toMatchObject({ status: 413, data: { code: "RESPONSE_TOO_LARGE" } });
		expect(jsonReads).toBe(0);
	});

	test("a streaming error cancels as soon as the budget is exceeded without reading trailing chunks", async () => {
		let reads = 0;
		let cancelled = false;
		const chunks = [
			new TextEncoder().encode('{"error":"'),
			new Uint8Array(100).fill(120),
			new TextEncoder().encode('do-not-read"}'),
		];
		const response = new Response(
			new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						const chunk = chunks[reads++];
						if (chunk) controller.enqueue(chunk);
						else controller.close();
					},
					cancel() {
						cancelled = true;
					},
				},
				{ highWaterMark: 0 },
			),
			{ status: 500, headers: { "content-type": "application/json" } },
		);
		response.json = async () => {
			throw new Error("Must not parse an oversized error");
		};
		globalThis.fetch = Object.assign(async () => response, {
			preconnect: originalFetch.preconnect,
		});
		await expect(settingsApi.getSettings({ maxResponseBytes: 32 })).rejects.toMatchObject({
			status: 413,
			data: { code: "RESPONSE_TOO_LARGE" },
		});
		expect(reads).toBe(2);
		expect(cancelled).toBe(true);
	});

	test("bounded structured errors keep their status, diagnostic data and session verdict", async () => {
		responseStatus = 500;
		responseBody = JSON.stringify({ code: "UPSTREAM_FAILED", reason: "model service unavailable" });
		await expect(settingsApi.getSettings({ maxResponseBytes: 1024 })).rejects.toMatchObject({
			status: 500,
			message: "model service unavailable",
			data: { code: "UPSTREAM_FAILED" },
		});
		responseStatus = 401;
		responseBody = JSON.stringify({ code: "OAUTH_REQUIRED", error: "OAuth access token required" });
		await expect(settingsApi.getSettings({ maxResponseBytes: 1024 })).rejects.toMatchObject({
			status: 401,
			data: { code: "OAUTH_REQUIRED" },
		});
		expect(removedStorageKeys).toEqual([]);
		responseBody = JSON.stringify({ code: "UNAUTHORIZED", error: "Session expired" });
		await expect(settingsApi.getSettings({ maxResponseBytes: 1024 })).rejects.toMatchObject({
			status: 401,
		});
		expect(removedStorageKeys).toEqual(["narrafork_token"]);
		expect(jsonReads).toBe(0);
	});

	test("plain-text errors also obey the response byte budget", async () => {
		responseStatus = 500;
		responseHeaders = { "content-type": "text/plain" };
		responseBody = "failure".repeat(100);
		await expect(settingsApi.getSettings({ maxResponseBytes: 16 })).rejects.toMatchObject({
			status: 413,
			data: { code: "RESPONSE_TOO_LARGE" },
		});
		responseBody = "upstream failed";
		await expect(settingsApi.getSettings({ maxResponseBytes: 64 })).rejects.toMatchObject({
			status: 500,
			message: "upstream failed",
		});
	});

	test("remains assignable as React Query queryFn and mutationFn", async () => {
		const client = new QueryClient();
		const controller = new AbortController();
		const queryFn: QueryFunction<Awaited<ReturnType<typeof settingsApi.getSettings>>> =
			settingsApi.getSettings;
		await queryFn({ client, queryKey: ["settings"], signal: controller.signal, meta: {} });
		expect(calls[0].init?.signal).toBe(controller.signal);
		expect(calls[0].init).not.toHaveProperty("client");

		const save: MutationFunction<
			Awaited<ReturnType<typeof settingsApi.updateSettings>>,
			Record<string, unknown>
		> = settingsApi.updateSettings;
		await save(settingsData, { client, mutationKey: ["save"], meta: {} });
		expect(calls[1].init?.signal).toBeUndefined();
		expect(calls[1].init).not.toHaveProperty("client");

		for (const provider of ["openai", "anthropic", "gemini", "nug"] as const) {
			const refresh: MutationFunction<unknown, string> =
				miscApi[`${provider}RefreshProviderModels`];
			await refresh("provider-id", { client, mutationKey: ["refresh"], meta: {} });
			expect(calls.at(-1)?.init?.signal).toBeUndefined();
			expect(calls.at(-1)?.init).not.toHaveProperty("client");
		}
	});

	test("pickRequestOptions exports only validated transport fields", () => {
		const signal = new AbortController().signal;
		expect(pickRequestOptions()).toEqual({});
		expect(pickRequestOptions({ signal, maxResponseBytes: 8 * 1024 * 1024, headers: {} })).toEqual({
			signal,
			maxResponseBytes: 8 * 1024 * 1024,
		});
		expect(pickRequestOptions({ signal: {}, maxResponseBytes: Number.NaN })).toEqual({});
	});
});
