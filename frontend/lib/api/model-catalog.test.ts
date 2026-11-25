import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiError } from "./client";
import { modelCatalogApi } from "./model-catalog";

const originalFetch = globalThis.fetch;
const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let calls: Array<{ url: string; method: string; body?: unknown }>;
beforeEach(() => {
	calls = [];
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: () => null },
	});
	globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
		calls.push({
			url: String(url),
			method: init?.method ?? "GET",
			...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
		});
		return Response.json({ ok: true });
	}) as unknown as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("model catalog wire contract", () => {
	test("reads use the mounted API root and keep opaque model values intact", async () => {
		await modelCatalogApi.status();
		await modelCatalogApi.card("my-provider:channel:model:opaque");
		await modelCatalogApi.describe(["relay:gpt-5.5"]);
		expect(calls.map((call) => [call.url, call.method])).toEqual([
			["/api/model-catalog/status", "GET"],
			["/api/model-catalog/card?model=my-provider%3Achannel%3Amodel%3Aopaque", "GET"],
			["/api/model-catalog/models", "POST"],
		]);
		expect(calls[2].body).toEqual({ models: ["relay:gpt-5.5"] });
	});
	test("runtime binds narrator authorization and options preserve opaque search/cursor", async () => {
		await modelCatalogApi.runtime({ model: "auto:模型:1", narratorId: "session/id" });
		await modelCatalogApi.options({
			q: "模型",
			cursor: "opaque+/=",
			scope: "concrete",
			sourceModelId: "model:1",
			limit: 40,
		});
		const runtime = new URL(calls[0].url, "http://test");
		expect(runtime.pathname).toBe("/api/model-catalog/runtime");
		expect(runtime.searchParams.get("narratorId")).toBe("session/id");
		expect(runtime.searchParams.get("model")).toBe("auto:模型:1");
		const options = new URL(calls[1].url, "http://test");
		expect(options.searchParams.get("cursor")).toBe("opaque+/=");
		expect(options.searchParams.get("q")).toBe("模型");
		expect(options.searchParams.get("sourceModelId")).toBe("model:1");
		expect(options.searchParams.get("scope")).toBe("concrete");
	});
	test("runtime and option responses enforce their independent byte budgets", async () => {
		globalThis.fetch = (async () =>
			Response.json({ payload: "x".repeat(5000) })) as unknown as typeof fetch;
		await expect(modelCatalogApi.runtime({ model: "relay:x" })).rejects.toThrow();
		globalThis.fetch = (async () =>
			Response.json({ payload: "x".repeat(66_000) })) as unknown as typeof fetch;
		await expect(modelCatalogApi.options()).rejects.toThrow();
	});
	test("overrides and update actions preserve method, null and false", async () => {
		await modelCatalogApi.setOverride({
			scope: "connection",
			key: "relay:gpt-5.5",
			fields: null,
			model: "relay:gpt-5.5",
		});
		await modelCatalogApi.update("check");
		await modelCatalogApi.update("restore-builtin");
		await modelCatalogApi.setAutoUpdate(false);
		expect(calls.map((call) => [call.url, call.method, call.body])).toEqual([
			[
				"/api/model-catalog/overrides",
				"PUT",
				{ scope: "connection", key: "relay:gpt-5.5", fields: null, model: "relay:gpt-5.5" },
			],
			["/api/model-catalog/updates/check", "POST", {}],
			["/api/model-catalog/updates/restore-builtin", "POST", {}],
			["/api/model-catalog/updates/settings", "PATCH", { autoUpdate: false }],
		]);
	});
	test("a field-level rejection stays typed for the editor", async () => {
		globalThis.fetch = (async () =>
			Response.json(
				{ error: "bad", code: "INVALID_OVERRIDE", field: "prices.input" },
				{ status: 400 },
			)) as unknown as typeof fetch;
		try {
			await modelCatalogApi.setOverride({
				scope: "connection",
				key: "relay:x",
				fields: { contextWindow: 1 },
				model: "relay:x",
			});
			throw new Error("Expected rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			expect((error as ApiError).data?.field).toBe("prices.input");
		}
	});
});
