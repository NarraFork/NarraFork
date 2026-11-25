import { afterEach, expect, spyOn, test } from "bun:test";
import type { QuotaSnapshotEntry, QuotaSnapshotsResponse } from "@shared/quota-snapshot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { quotaSnapshotText } from "../components/narrator/model/quota-snapshot-view";
import { api } from "../lib/api";
import {
	quotaSnapshotsKey,
	quotaSnapshotsOptions,
	quotaSnapshotsReadKey,
	selectQuotaEntries,
	useQuotaSnapshot,
	useRefreshQuotaSnapshots,
} from "./useQuotaSnapshots";

function entry(
	groupId = "group",
	credentialId = "key",
	source: QuotaSnapshotEntry["source"] = "probe",
): QuotaSnapshotEntry {
	return {
		groupId,
		credentialId,
		source,
		prefix: groupId,
		templateId: "custom-api",
		snapshot: {
			fetchedAt: 1,
			scope: "key",
			windows: [],
			balances: [{ unit: "USD", remaining: 4 }],
		},
	};
}
const clients: QueryClient[] = [];
const client = () => {
	const value = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	});
	clients.push(value);
	return value;
};
afterEach(() => {
	for (const value of clients.splice(0)) value.clear();
});

test("all consumers share one query key and one simultaneous read", async () => {
	const qc = client();
	const read = spyOn(api, "quotaSnapshots").mockResolvedValue({ entries: [entry()] });
	try {
		const [first, second] = await Promise.all([
			qc.fetchQuery(quotaSnapshotsOptions()),
			qc.fetchQuery(quotaSnapshotsOptions()),
		]);
		expect(first).toEqual(second);
		expect(read).toHaveBeenCalledTimes(1);
		expect(read.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);
		expect([...quotaSnapshotsOptions().queryKey]).toEqual([...quotaSnapshotsReadKey()]);
		expect(quotaSnapshotsOptions().queryKey).not.toEqual(quotaSnapshotsKey);
	} finally {
		read.mockRestore();
	}
});

test("a selected credential never borrows another group's or key's quota", () => {
	const qc = client();
	qc.setQueryData(quotaSnapshotsReadKey(), {
		entries: [entry("other"), entry("group", "second"), entry()],
	});
	let selected: unknown;
	function Selection({ credentialId }: { credentialId: string }) {
		selected = useQuotaSnapshot("group", credentialId, false).data;
		return null;
	}
	const render = (id: string) =>
		renderToStaticMarkup(
			<QueryClientProvider client={qc}>
				<Selection credentialId={id} />
			</QueryClientProvider>,
		);
	render("key");
	expect(selected).toEqual(entry().snapshot);
	render("missing");
	expect(selected).toBeNull();
});

test("probe wins only with data, including when source is omitted", () => {
	const stream = entry("group", "key", "quota_balance");
	const probe = entry();
	const empty = { ...probe, snapshot: null };
	expect(selectQuotaEntries([stream, probe])).toEqual([probe]);
	expect(selectQuotaEntries([probe, stream])).toEqual([probe]);
	expect(selectQuotaEntries([empty, stream])).toEqual([stream]);
	expect(selectQuotaEntries([stream, empty])).toEqual([stream]);
	const legacy = { ...probe, source: undefined };
	expect(selectQuotaEntries([legacy, stream])).toEqual([legacy]);
});

test("known period amounts are probe data even when the ratio is unknown", () => {
	const stream = entry("group", "key", "quota_balance");
	const probe: QuotaSnapshotEntry = {
		...entry(),
		snapshot: {
			fetchedAt: 1,
			scope: "subscription",
			balances: [],
			windows: [
				{
					kind: "other",
					label: "daily",
					usedRatio: null,
					resetsAt: null,
					remaining: 0,
					total: 0,
					used: 0,
					unit: "USD",
				},
			],
		},
	};
	expect(selectQuotaEntries([probe, stream])).toEqual([probe]);
	expect(selectQuotaEntries([stream, probe])).toEqual([probe]);
});

test("same-credential stream amounts retain the probe deadline on both sides of expiry", () => {
	const stream = entry("group", "key", "quota_balance");
	for (const windows of [[], [{ kind: "weekly" as const, usedRatio: null, resetsAt: null }]]) {
		const probe: QuotaSnapshotEntry = {
			...entry(),
			snapshot: {
				fetchedAt: 1,
				scope: "subscription",
				windows,
				balances: [],
				expiresAt: 10,
				plan: "Pro",
			},
		};
		for (const entries of [
			[probe, stream],
			[stream, probe],
		]) {
			const selected = selectQuotaEntries(entries)[0];
			expect(selected?.source).toBe("quota_balance");
			expect(selected?.snapshot).toMatchObject({
				expiresAt: 10,
				plan: "Pro",
				windows,
				balances: [{ unit: "USD", remaining: 4 }],
			});
			const t = (key: string) => key;
			expect(quotaSnapshotText(selected?.snapshot, t, 9).balance).toBe("4 USD");
			expect(quotaSnapshotText(selected?.snapshot, t, 10).balance).toBe("quotaSnapshot.expired");
		}
	}
});

test("disabled observers never poll cached refreshing snapshots", () => {
	const poll = quotaSnapshotsOptions(false).refetchInterval;
	if (typeof poll !== "function") throw new Error("Expected interval function");
	expect(poll({ state: { data: { entries: [{ ...entry(), refreshing: true }] } } } as never)).toBe(
		false,
	);
});

test("refreshing polls quickly and settled data retains the thirty-second interval", () => {
	const poll = quotaSnapshotsOptions().refetchInterval;
	if (typeof poll !== "function") throw new Error("Expected interval function");
	expect(poll({ state: { data: { entries: [{ ...entry(), refreshing: true }] } } } as never)).toBe(
		3000,
	);
	expect(poll({ state: { data: { entries: [entry()] } } } as never)).toBe(30000);
});

test("refresh mutation is bounded and replaces the cache with the authoritative response", async () => {
	const qc = client();
	qc.setQueryData(quotaSnapshotsReadKey(), { entries: [entry("other")] });
	const refresh = spyOn(api, "refreshQuotaSnapshots").mockResolvedValue({ entries: [entry()] });
	let mutate: ReturnType<typeof useRefreshQuotaSnapshots>["mutateAsync"] | undefined;
	function Harness() {
		mutate = useRefreshQuotaSnapshots().mutateAsync;
		return null;
	}
	renderToStaticMarkup(
		<QueryClientProvider client={qc}>
			<Harness />
		</QueryClientProvider>,
	);
	try {
		if (!mutate) throw new Error("Missing mounted mutation");
		await mutate({ groupId: "group", credentialId: "key" });
		expect(refresh.mock.calls[0]?.[0]).toEqual({ groupId: "group", credentialId: "key" });
		expect(refresh.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
		expect(qc.getQueryData<QuotaSnapshotsResponse>(quotaSnapshotsReadKey())?.entries).toEqual([
			entry(),
		]);
	} finally {
		refresh.mockRestore();
	}
});
