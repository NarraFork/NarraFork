import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { ProviderQuotaSnapshot } from "@shared/provider-quota";
import { miscApi } from "./misc";

let previousStorage: PropertyDescriptor | undefined;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
const fetchPreconnect = globalThis.fetch.preconnect;
const responseFetch = (response: () => Response) =>
	Object.assign(async () => response(), { preconnect: fetchPreconnect });
beforeEach(() => {
	previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: () => null },
	});
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		responseFetch(() => Response.json({ snapshots: [], nextCursor: null })),
	);
});
afterEach(() => {
	fetchSpy.mockRestore();
	if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

test("quota list forwards stable provider IDs, cursor, bounded page size and cancellation", async () => {
	const controller = new AbortController();
	await miscApi.providerGetQuotas({
		providerId: "p /1",
		cursor: "next+page",
		limit: 50,
		signal: controller.signal,
	});
	const call = fetchSpy.mock.calls[0];
	if (!call) throw new Error("quota list request missing");
	const [url, options] = call;
	const parsed = new URL(String(url), "http://localhost");
	expect(parsed.pathname).toBe("/api/provider-quotas");
	expect(Object.fromEntries(parsed.searchParams)).toEqual({
		providerId: "p /1",
		cursor: "next+page",
		limit: "50",
	});
	expect(options?.signal).toBe(controller.signal);
});

test("administrator actions use one refresh endpoint with explicit probe/refresh mode", async () => {
	for (const mode of ["probe", "refresh"] as const)
		await miscApi.providerRefreshQuota("p /1", mode);
	for (const [index, mode] of ["probe", "refresh"].entries()) {
		const call = fetchSpy.mock.calls[index];
		if (!call) throw new Error("quota action request missing");
		const [url, options] = call;
		expect(String(url)).toBe("/api/provider-quotas/p%20%2F1/refresh");
		expect(options?.method).toBe("POST");
		expect(options?.body).toBe(JSON.stringify({ mode }));
	}
});

test("quota DTOs preserve public aliases, actual Key identity, push compatibility and auth failures", async () => {
	const snapshot: ProviderQuotaSnapshot = {
		providerId: "p",
		targetId: "custom-api/p",
		generation: "key-generation",
		keyId: "current-key",
		pushCompatible: false,
		sourceId: "io.narrafork.provider-quota:site",
		status: "error",
		error: "auth_failed",
		data: null,
		fetchedAt: 0,
		attemptedAt: 1,
		stale: false,
		version: 1,
	};
	fetchSpy.mockImplementation(
		responseFetch(() => Response.json({ snapshots: [snapshot], nextCursor: null })),
	);
	expect((await miscApi.providerGetQuotas()).snapshots[0]).toEqual(snapshot);
	fetchSpy.mockImplementation(responseFetch(() => Response.json(snapshot)));
	expect(await miscApi.providerRefreshQuota("p", "refresh")).toEqual(snapshot);
});

test("quota responses enforce the host page/snapshot byte budgets", async () => {
	fetchSpy.mockImplementation(
		responseFetch(
			() =>
				new Response("x".repeat(256 * 1024 + 1), {
					headers: { "content-type": "application/json" },
				}),
		),
	);
	await expect(miscApi.providerGetQuotas()).rejects.toThrow();
	fetchSpy.mockImplementation(
		responseFetch(
			() =>
				new Response("x".repeat(16 * 1024 + 1), {
					headers: { "content-type": "application/json" },
				}),
		),
	);
	await expect(miscApi.providerRefreshQuota("p", "refresh")).rejects.toThrow();
});
