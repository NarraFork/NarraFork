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
	test("snapshot, explicit patches and opaque actual identities use the mounted API root", async () => {
		await modelCatalogApi.snapshot();
		const mutation = {
			action: "patch" as const,
			target: "binding" as const,
			targetId: "binding:exact",
			baseRevision: 4,
			patch: {
				set: {
					"referencePricing.input": "0",
					"nativeSearch.supported": false,
					"modalities.output": [],
				},
				reset: ["limits.contextWindow"],
			},
		};
		await modelCatalogApi.mutate(mutation);
		await modelCatalogApi.resolveModel("my-provider:channel:model:opaque");
		expect(calls.map((call) => [call.url, call.method])).toEqual([
			["/api/model-catalog", "GET"],
			["/api/model-catalog/mutate", "POST"],
			["/api/model-catalog/resolve", "POST"],
		]);
		expect(calls[1].body).toEqual(mutation);
		expect(calls[2].body).toEqual({ model: "my-provider:channel:model:opaque" });
	});
	test("check/apply/rollback and pin/auto-apply preserve method and false/null", async () => {
		await modelCatalogApi.update("check");
		await modelCatalogApi.update("apply", "v2");
		await modelCatalogApi.update("rollback", "v1");
		await modelCatalogApi.settings({ autoApply: false, pinnedVersion: null });
		expect(calls.map((call) => [call.url, call.method, call.body])).toEqual([
			["/api/model-catalog/updates/check", "POST", {}],
			["/api/model-catalog/updates/apply", "POST", { version: "v2" }],
			["/api/model-catalog/updates/rollback", "POST", { version: "v1" }],
			["/api/model-catalog/updates/settings", "PATCH", { autoApply: false, pinnedVersion: null }],
		]);
	});
	test("409 remains typed for the editor rather than retrying a write", async () => {
		let writes = 0;
		globalThis.fetch = (async () => {
			writes += 1;
			return Response.json({ error: "Conflict" }, { status: 409 });
		}) as unknown as typeof fetch;
		try {
			await modelCatalogApi.mutate({
				action: "hide",
				target: "model",
				targetId: "base",
				baseRevision: 0,
			});
			throw new Error("Expected conflict");
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			expect((error as ApiError).status).toBe(409);
		}
		expect(writes).toBe(1);
	});
});
