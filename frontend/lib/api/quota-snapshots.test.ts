import { afterEach, expect, spyOn, test } from "bun:test";
import { api } from "./index";
import { providerKeysApi } from "./provider-keys";

const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
	configurable: true,
	value: { getItem: () => null },
});
const fetch = spyOn(globalThis, "fetch");
afterEach(() => {
	fetch.mockClear();
});

import { afterAll } from "bun:test";

afterAll(() => {
	fetch.mockRestore();
	if (storage) Object.defineProperty(globalThis, "localStorage", storage);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

test("quota reads and targeted refreshes use the single public contract and cancellation", async () => {
	fetch.mockResolvedValue(Response.json({ entries: [] }));
	const controller = new AbortController();
	await api.quotaSnapshots({ signal: controller.signal });
	const first = fetch.mock.calls[0];
	expect(String(first?.[0])).toEndWith("/api/quota-snapshots");
	expect(first?.[1]?.signal).toBe(controller.signal);
	fetch.mockResolvedValue(Response.json({ entries: [] }));
	await api.refreshQuotaSnapshots(
		{ groupId: "g", credentialId: "k" },
		{ signal: controller.signal },
	);
	expect(String(fetch.mock.calls[1]?.[0])).toEndWith("/api/quota-snapshots/refresh");
	expect(fetch.mock.calls[1]?.[1]).toMatchObject({
		method: "POST",
		body: '{"groupId":"g","credentialId":"k"}',
		signal: controller.signal,
	});
});

test("Command Code usage is summary-only and the separate probe diagnostic remains available", async () => {
	fetch.mockResolvedValue(Response.json({ loggedIn: true, summary: { totalCount: 2 } }));
	await api.commandCodeUsageSummary();
	expect(String(fetch.mock.calls[0]?.[0])).toEndWith("/api/commandcode/usage-summary");
	fetch.mockResolvedValue(Response.json({ status: "pending" }));
	await api.providerProbeBalance("g/key");
	expect(String(fetch.mock.calls[1]?.[0])).toEndWith("/api/provider-balances/g%2Fkey/probe");
	expect(fetch.mock.calls[1]?.[1]?.method).toBe("POST");
});

test("retired quota reads and refreshes are not exported, while payment and usage operations remain", () => {
	for (const name of [
		"providerGetBalances",
		"providerRefreshBalance",
		"deepseekGetBalances",
		"deepseekRefreshBalances",
		"kimiGetUsages",
		"kimiRefreshUsages",
		"opencodeGetUsages",
		"opencodeRefreshUsages",
		"tokenDanceBalance",
		"tokenDanceRefreshBalance",
		"commandCodeUsage",
	])
		expect(name in api).toBe(false);
	expect("refreshUsage" in providerKeysApi).toBe(false);
	for (const name of [
		"nugGetQuota",
		"nugGetBillingConfig",
		"nugGetUsage",
		"nugGetUsageSummary",
		"tokenDanceCreatePayment",
		"tokenDancePaymentSession",
	])
		expect(name in api).toBe(true);
});
