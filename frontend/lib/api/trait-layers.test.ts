import { describe, expect, test } from "bun:test";
import { narratorsApi } from "./narrators";
import { traitLayersApi } from "./trait-layers";

/**
 * The shared `api` barrel spreads both objects into one namespace, so any name
 * they share would silently shadow the other. That already happened once: the
 * layer methods were originally called `updateDisabledTools` etc., which clobbered
 * the narrator-level methods of the same name (they take a narrator id, not a
 * layer + owner pair) and broke every narrator trait mutation.
 */
describe("api barrel name collisions", () => {
	test("no method name is shared between the narrator and layer trait APIs", () => {
		const narratorKeys = new Set(Object.keys(narratorsApi));
		const overlapping = Object.keys(traitLayersApi).filter((key) => narratorKeys.has(key));
		expect(overlapping).toEqual([]);
	});

	test("every layer trait method is namespaced so the intent is unambiguous", () => {
		for (const key of Object.keys(traitLayersApi)) {
			expect(key).toMatch(/Layer/);
		}
	});
});

describe("request paths", () => {
	// The client reads the auth token from localStorage, which does not exist in
	// this environment; without it every call throws before reaching fetch.
	function installLocalStorage(): void {
		const store = new Map<string, string>();
		Object.defineProperty(globalThis, "localStorage", {
			value: {
				getItem: (key: string) => store.get(key) ?? null,
				setItem: (key: string, value: string) => void store.set(key, value),
				removeItem: (key: string) => void store.delete(key),
			},
			configurable: true,
		});
	}

	// The methods build URLs from user-controlled ids, so the encoding matters.
	function capture(): { calls: string[]; restore: () => void } {
		const calls: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			calls.push(url);
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		return {
			calls,
			restore: () => {
				globalThis.fetch = originalFetch;
			},
		};
	}

	test("layer and owner id are placed in the path and the owner id is encoded", async () => {
		installLocalStorage();
		const { calls, restore } = capture();
		await Promise.allSettled([traitLayersApi.getLayerTraits("project", "proj id/with slash")]);
		restore();
		expect(calls.length).toBe(1);
		expect(calls[0]).toContain("/trait-layers/project/");
		// A raw slash would silently change which route is hit.
		expect(calls[0]).not.toContain("proj id/with slash");
		expect(calls[0]).toContain(encodeURIComponent("proj id/with slash"));
	});

	test("model pools retain effort, purpose, hidden types and explicit empties across API payloads", async () => {
		installLocalStorage();
		const originalFetch = globalThis.fetch;
		const pools = {
			explore: [{ model: "default", purpose: "keep", reasoningEffort: "high" as const }],
			plan: [],
			search: [{ model: "summary", reasoningEffort: "none" as const }],
			review: [{ model: "p:r", purpose: "review" }],
			custom: [{ model: "aggregation:custom", reasoningEffort: "max" as const }],
		};
		const bodies: unknown[] = [];
		globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
			if (init?.body) bodies.push(JSON.parse(String(init.body)));
			return Response.json({
				ok: true,
				customTraits: { subagentModelRestriction: { version: 1, pools } },
			});
		}) as typeof fetch;
		try {
			for (const layer of ["user", "project"] as const) {
				const result = await traitLayersApi.updateLayerSubagentModelRestriction(layer, "owner", {
					pools,
					enforced: true,
				});
				expect(result.customTraits.subagentModelRestriction?.pools).toEqual(pools);
			}
			const result = await narratorsApi.updateSubagentModelRestriction("narrator", pools);
			expect(result.customTraits.subagentModelRestriction?.pools).toEqual(pools);
			expect(bodies).toEqual([{ pools, enforced: true }, { pools, enforced: true }, { pools }]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("each trait uses its own sub-path", async () => {
		installLocalStorage();
		const { calls, restore } = capture();
		// Settled independently: one rejection must not skip the remaining calls.
		await Promise.allSettled([
			traitLayersApi.updateLayerDisabledTools("user", "u1", { tools: [], enforced: false }),
			traitLayersApi.updateLayerBlockedSkills("user", "u1", {
				all: false,
				names: [],
				enforced: false,
			}),
			traitLayersApi.updateLayerDeviceInjection("user", "u1", {
				defaultMode: "all",
				devices: {},
			}),
		]);
		restore();
		expect(calls.some((url) => url.endsWith("/disabled-tools"))).toBe(true);
		expect(calls.some((url) => url.endsWith("/blocked-skills"))).toBe(true);
		expect(calls.some((url) => url.endsWith("/device-injection"))).toBe(true);
	});
});
