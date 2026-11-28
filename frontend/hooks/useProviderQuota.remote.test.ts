import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { ProviderQuotaSnapshot } from "@shared/provider-quota";
import { MutationObserver, QueryClient, QueryObserver } from "@tanstack/react-query";

mock.module("@frontend/lib/build-target", () => ({ REMOTE_BUILD: true }));
const { api } = await import("../lib/api");
const { narratorWSManager } = await import("../lib/narrator-ws-manager");
const {
	dispatchProviderQuotaChanged,
	invalidateProviderQuotaQueries,
	subscribeProviderQuotaEvents,
} = await import("../lib/provider-quota-events");
const {
	isProviderQuotaCapabilityEnabled,
	providerQuotaKey,
	providerQuotaListKey,
	providerQuotaOptions,
	providerQuotaRefreshOptions,
	providerQuotasOptions,
} = await import("./useProviderQuota");

const snapshot: ProviderQuotaSnapshot = {
	providerId: "p",
	targetId: "custom-api/p",
	generation: "A",
	keyId: "key-A",
	pushCompatible: false,
	sourceId: "io.narrafork.provider-quota:site",
	status: "supported",
	data: { amounts: [{ id: "wallet", unit: "USD", remaining: 42 }], windows: [] },
	fetchedAt: 1,
	attemptedAt: 1,
	stale: false,
	error: null,
	version: 1,
};
afterEach(() => mock.restore());

test("remote quota queries stay disabled, hide local caches and never fetch even on manual refetch", async () => {
	const client = new QueryClient();
	client.setQueryData(providerQuotaKey("p", "A"), snapshot);
	client.setQueryData(providerQuotaListKey({ p: "A" }), { p: snapshot });
	const get = spyOn(api, "providerGetQuotas").mockResolvedValue({
		snapshots: [snapshot],
		nextCursor: null,
	});
	const singleOptions = providerQuotaOptions(client, "p", "A");
	const listOptions = providerQuotasOptions(client, { p: "A" });
	const single = new QueryObserver(client, singleOptions);
	const list = new QueryObserver(client, listOptions);
	try {
		expect(singleOptions.enabled).toBe(false);
		expect(listOptions.enabled).toBe(false);
		expect(single.getCurrentResult().data).toBeUndefined();
		expect(list.getCurrentResult().data).toEqual({});
		if (
			typeof singleOptions.refetchInterval !== "function" ||
			typeof listOptions.refetchInterval !== "function"
		)
			throw new Error("quota poll callbacks missing");
		expect(singleOptions.refetchInterval(single.getCurrentQuery())).toBe(false);
		expect(listOptions.refetchInterval(list.getCurrentQuery())).toBe(false);
		await single.refetch();
		await list.refetch();
		expect(single.getCurrentResult().data).toBeUndefined();
		expect(list.getCurrentResult().data).toEqual({});
		expect(get).not.toHaveBeenCalled();
	} finally {
		single.destroy();
		list.destroy();
		client.clear();
	}
});

test("remote probe/refresh cannot issue a request or write a supplied success into the cache", async () => {
	const client = new QueryClient();
	const refresh = spyOn(api, "providerRefreshQuota").mockResolvedValue(snapshot);
	const options = providerQuotaRefreshOptions(client, "p", "A", true);
	const mutation = new MutationObserver(client, options);
	try {
		expect(await mutation.mutate("probe")).toBeNull();
		expect(await mutation.mutate("refresh")).toBeNull();
		await options.onSuccess(snapshot);
		expect(refresh).not.toHaveBeenCalled();
		expect(client.getQueryData(providerQuotaKey("p", "A"))).toBeUndefined();
	} finally {
		client.clear();
	}
});

test("remote quota capability is off even for enabled or older settings projections", () => {
	for (const settings of [
		undefined,
		{},
		{ providerBalanceCapability: { enabled: true } },
		{ providerBalanceCapability: { enabled: false } },
	])
		expect(isProviderQuotaCapabilityEnabled(settings)).toBe(false);
});

test("remote quota lifecycle handling opens no local socket and cannot invalidate local data", () => {
	const client = new QueryClient();
	client.setQueryData(providerQuotaKey("p", "A"), snapshot);
	const add = spyOn(narratorWSManager, "addListener").mockImplementation(() => ({ _id: 1 }));
	const connect = spyOn(narratorWSManager, "onConnectionChange").mockImplementation(() => () => {});
	const dispose = subscribeProviderQuotaEvents(client);
	try {
		invalidateProviderQuotaQueries(client, ["p"]);
		expect(
			dispatchProviderQuotaChanged({
				type: "provider_quota_changed",
				providerIds: ["p"],
				version: 2,
			}),
		).toBe(true);
		expect(client.getQueryState(providerQuotaKey("p", "A"))?.isInvalidated).toBe(false);
		expect(add).not.toHaveBeenCalled();
		expect(connect).not.toHaveBeenCalled();
	} finally {
		dispose();
		client.clear();
	}
});
