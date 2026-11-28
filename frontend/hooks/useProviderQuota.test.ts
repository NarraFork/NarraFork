import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ProviderQuotaPage, ProviderQuotaSnapshot } from "@shared/provider-quota";
import { MutationObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import { api } from "../lib/api";
import {
	isProviderQuotaCapabilityEnabled,
	matchesProviderQuotaIdentity,
	providerQuotaKey,
	providerQuotaListKey,
	providerQuotaOptions,
	providerQuotaPollInterval,
	providerQuotaRefreshOptions,
	providerQuotasOptions,
	reconcileProviderQuotaSnapshot,
} from "./useProviderQuota";

const snapshot = (
	generation = "A",
	overrides: Partial<ProviderQuotaSnapshot> = {},
): ProviderQuotaSnapshot => ({
	providerId: "p",
	targetId: "custom-api/p",
	generation,
	sourceId: "third.party:credits",
	status: "supported",
	data: { amounts: [{ id: "wallet", unit: "USD", remaining: 8 }], windows: [] },
	fetchedAt: 1,
	attemptedAt: 1,
	stale: false,
	error: null,
	version: 1,
	...overrides,
});
const page = (...snapshots: ProviderQuotaSnapshot[]): ProviderQuotaPage => ({
	snapshots,
	nextCursor: null,
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
afterEach(() => mock.restore());

test("saved site quota and balance share capability, including older settings compatibility", () => {
	expect(isProviderQuotaCapabilityEnabled(undefined)).toBe(true);
	expect(isProviderQuotaCapabilityEnabled({})).toBe(true);
	expect(isProviderQuotaCapabilityEnabled({ providerBalanceCapability: { enabled: true } })).toBe(
		true,
	);
	expect(isProviderQuotaCapabilityEnabled({ providerBalanceCapability: { enabled: false } })).toBe(
		false,
	);
});

describe("normalized quota cache identity", () => {
	test("query keys use stable id/generation; list identities are order-independent", () => {
		expect(providerQuotaKey("p", "A")).toEqual(["provider-quotas", "provider", "p", "A"]);
		expect(providerQuotaListKey({ b: "B", a: "A" })).toEqual(
			providerQuotaListKey({ a: "A", b: "B" }),
		);
		expect(matchesProviderQuotaIdentity(snapshot(), "p", "A")).toBe(true);
		expect(
			matchesProviderQuotaIdentity(
				snapshot("A", { keyId: "key-A", pushCompatible: false }),
				"p",
				"A",
			),
		).toBe(true);
		expect(
			matchesProviderQuotaIdentity(
				snapshot("A", { targetId: "custom-api/p/keys/key-A", keyId: "key-A" }),
				"p",
				"A",
			),
		).toBe(false);
		expect(matchesProviderQuotaIdentity(snapshot(), "other", "A")).toBe(false);
		expect(matchesProviderQuotaIdentity(snapshot("A", { targetId: "nug/p" }), "p", "A")).toBe(
			false,
		);
	});

	test("a late old-account GET cannot appear after switching generation", async () => {
		const client = new QueryClient();
		const old = deferred<ProviderQuotaPage>();
		const fetch = spyOn(api, "providerGetQuotas")
			.mockReturnValueOnce(old.promise)
			.mockResolvedValue(page(snapshot("B")));
		const observer = new QueryObserver(client, providerQuotaOptions(client, "p", "A"));
		const unsubscribe = observer.subscribe(() => {});
		try {
			observer.setOptions(providerQuotaOptions(client, "p", "B"));
			expect(observer.getCurrentResult().data).toBeUndefined();
			await observer.refetch();
			old.resolve(page(snapshot("A")));
			await old.promise;
			await Promise.resolve();
			expect(observer.getCurrentResult().data?.generation).toBe("B");
			expect(fetch.mock.calls[0]?.[0]?.signal?.aborted).toBe(true);
		} finally {
			unsubscribe();
			client.clear();
		}
	});

	test("server identity mismatch reloads settings and hides cached values", async () => {
		const client = new QueryClient();
		client.setQueryData(["settings"], {});
		client.setQueryData(["admin", "settings"], {});
		spyOn(api, "providerGetQuotas").mockResolvedValue(page(snapshot("B")));
		const observer = new QueryObserver(client, providerQuotaOptions(client, "p", "A"));
		try {
			await observer.refetch();
			expect(observer.getCurrentResult().data).toBeUndefined();
			expect(client.getQueryState(["settings"])?.isInvalidated).toBe(true);
			expect(client.getQueryState(["admin", "settings"])?.isInvalidated).toBe(true);
		} finally {
			observer.destroy();
			client.clear();
		}
	});

	test("host-retained stale values remain visible; authoritative empty errors never revive old data", () => {
		const good = snapshot("A", { version: 2 });
		const failed = snapshot("A", {
			version: 3,
			status: "error",
			error: "timeout",
			data: null,
			attemptedAt: 2,
		});
		const retained = { ...failed, data: good.data, stale: true };
		expect(reconcileProviderQuotaSnapshot(good, retained)).toMatchObject({
			data: good.data,
			fetchedAt: 1,
			attemptedAt: 2,
			stale: true,
			version: 3,
		});
		for (const error of [
			"timeout",
			"auth_failed",
			"invalid_configuration",
			"invalid_response",
			"unavailable",
		] as const) {
			const empty = { ...failed, error };
			expect(reconcileProviderQuotaSnapshot(good, empty)).toBe(empty);
			expect(reconcileProviderQuotaSnapshot(good, empty)?.data).toBeNull();
		}
		expect(reconcileProviderQuotaSnapshot(good, { ...failed, generation: "B" })?.data).toBeNull();
		expect(reconcileProviderQuotaSnapshot(good, snapshot())).toBe(good);
		expect(
			reconcileProviderQuotaSnapshot(
				{ ...good, keyId: "old-key", version: 10 },
				{ ...failed, keyId: "new-key" },
			)?.data,
		).toBeNull();
	});

	test("HTTP errors preserve the cached good snapshot and retry observation conservatively", async () => {
		const client = new QueryClient();
		const fetch = spyOn(api, "providerGetQuotas").mockResolvedValue(page(snapshot()));
		const options = providerQuotaOptions(client, "p", "A");
		const observer = new QueryObserver(client, options);
		try {
			await observer.refetch();
			fetch.mockRejectedValueOnce(new Error("offline"));
			await observer.refetch();
			expect(observer.getCurrentResult().isError).toBe(true);
			expect(observer.getCurrentResult().data?.data?.amounts[0]?.remaining).toBe(8);
			if (typeof options.refetchInterval !== "function")
				throw new Error("interval callback missing");
			expect(options.refetchInterval(observer.getCurrentQuery())).toBe(60_000);
		} finally {
			observer.destroy();
			client.clear();
		}
	});

	test("removing identity hides cached values and inactive views do not fetch", () => {
		const client = new QueryClient();
		client.setQueryData(providerQuotaKey("p", "A"), snapshot());
		const observer = new QueryObserver(client, providerQuotaOptions(client, "p", "A", false));
		expect(observer.getCurrentResult().data?.generation).toBe("A");
		observer.setOptions(providerQuotaOptions(client, "p", undefined, false));
		expect(observer.getCurrentResult().data).toBeUndefined();
		expect(providerQuotaOptions(client, "p", "A", false).enabled).toBe(false);
		expect(providerQuotaOptions(client, null, "A").enabled).toBe(false);
		observer.destroy();
		client.clear();
	});
});

describe("bounded quota pages", () => {
	test("reads later pages and drops unknown targets and mismatched generations", async () => {
		const client = new QueryClient();
		const second = snapshot("B", { providerId: "q", targetId: "custom-api/q" });
		const fetch = spyOn(api, "providerGetQuotas")
			.mockResolvedValueOnce({
				snapshots: [
					snapshot(),
					snapshot("x", { providerId: "hidden", targetId: "custom-api/hidden" }),
				],
				nextCursor: "next",
			})
			.mockResolvedValueOnce(page(second));
		try {
			const result = await client.fetchQuery(providerQuotasOptions(client, { p: "A", q: "B" }));
			expect(Object.keys(result)).toEqual(["p", "q"]);
			expect(fetch.mock.calls[1]?.[0]?.cursor).toBe("next");
			expect(fetch.mock.calls.every((call) => call[0]?.limit === 100)).toBe(true);
		} finally {
			client.clear();
		}
	});
	test("repeated cursors fail rather than looping or silently losing later providers", async () => {
		const client = new QueryClient();
		const fetch = spyOn(api, "providerGetQuotas").mockResolvedValue({
			snapshots: [],
			nextCursor: "same",
		});
		try {
			await expect(client.fetchQuery(providerQuotasOptions(client, { p: "A" }))).rejects.toThrow(
				"Repeated quota page cursor",
			);
			expect(fetch).toHaveBeenCalledTimes(2);
		} finally {
			client.clear();
		}
	});
});

describe("quota refresh permissions and ordering", () => {
	test("ordinary users cannot send probe or refresh requests", async () => {
		const client = new QueryClient();
		const refresh = spyOn(api, "providerRefreshQuota").mockResolvedValue(snapshot());
		const mutation = new MutationObserver(
			client,
			providerQuotaRefreshOptions(client, "p", "A", false),
		);
		try {
			expect(await mutation.mutate("probe")).toBeNull();
			expect(await mutation.mutate("refresh")).toBeNull();
			expect(refresh).not.toHaveBeenCalled();
		} finally {
			client.clear();
		}
	});
	test("admin refresh is single-flight, cancels stale GETs, and never patches pushed-text settings", async () => {
		const client = new QueryClient();
		const pushed = { customApiQuotas: { p: { quotaBalance: "Live push" } } };
		client.setQueryData(["settings"], pushed);
		client.setQueryData(
			providerQuotaKey("p", "A"),
			snapshot("A", { status: "unsupported", data: null }),
		);
		const old = deferred<ProviderQuotaPage>();
		let signal: AbortSignal | undefined;
		spyOn(api, "providerGetQuotas").mockImplementation((options) => {
			signal = options?.signal;
			return old.promise;
		});
		const observer = new QueryObserver(client, providerQuotaOptions(client, "p", "A", false));
		const oldGet = observer.refetch();
		const refresh = spyOn(api, "providerRefreshQuota").mockResolvedValue(
			snapshot("A", { status: "probing", version: 2 }),
		);
		const mutation = new MutationObserver(
			client,
			providerQuotaRefreshOptions(client, "p", "A", true),
		);
		try {
			await Promise.all([mutation.mutate("probe"), mutation.mutate("probe")]);
			expect(refresh).toHaveBeenCalledTimes(1);
			expect(refresh.mock.calls[0]?.slice(0, 2)).toEqual(["p", "probe"]);
			expect(signal?.aborted).toBe(true);
			old.resolve(page(snapshot()));
			await oldGet;
			expect(client.getQueryData<ProviderQuotaSnapshot>(providerQuotaKey("p", "A"))?.status).toBe(
				"probing",
			);
			expect(client.getQueryData(["settings"])).toEqual(pushed);
		} finally {
			observer.destroy();
			client.clear();
		}
	});
	test("a refresh for an old identity never writes into the new identity cache", async () => {
		const client = new QueryClient();
		client.setQueryData(providerQuotaKey("p", "B"), snapshot("B"));
		spyOn(api, "providerRefreshQuota").mockResolvedValue(snapshot("B", { version: 2 }));
		const mutation = new MutationObserver(
			client,
			providerQuotaRefreshOptions(client, "p", "A", true),
		);
		try {
			await mutation.mutate("refresh");
			expect(client.getQueryData(providerQuotaKey("p", "A"))).toBeUndefined();
			expect(client.getQueryData<ProviderQuotaSnapshot>(providerQuotaKey("p", "B"))?.version).toBe(
				1,
			);
		} finally {
			client.clear();
		}
	});
});

test("only pending/probing poll quickly; plugin unavailability never becomes a zero snapshot", () => {
	expect(providerQuotaPollInterval(snapshot("A", { status: "pending" }))).toBe(2_000);
	expect(providerQuotaPollInterval(snapshot("A", { status: "probing" }))).toBe(2_000);
	expect(providerQuotaPollInterval(snapshot())).toBe(60_000);
	expect(providerQuotaPollInterval(snapshot("A", { status: "error" }))).toBe(60_000);
	expect(providerQuotaPollInterval(snapshot("A", { status: "unavailable", data: null }))).toBe(
		false,
	);
	expect(providerQuotaPollInterval(snapshot("A", { status: "unsupported", data: null }))).toBe(
		false,
	);
});
