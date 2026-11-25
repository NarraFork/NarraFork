import { afterEach, expect, spyOn, test } from "bun:test";
import type {
	PublicQuotaSnapshot,
	QuotaSnapshotEntry,
	QuotaSnapshotsResponse,
} from "@shared/quota-snapshot";
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
function nugWallet(
	remaining: number | null,
	fetchedAt: number,
	source: QuotaSnapshotEntry["source"] = "probe",
	overrides: Partial<PublicQuotaSnapshot> = {},
): QuotaSnapshotEntry & { snapshot: PublicQuotaSnapshot } {
	return {
		groupId: "nug",
		prefix: "nug",
		templateId: "nug",
		credentialId: "nug-key",
		source,
		primary: true,
		supported: true,
		snapshot: {
			scope: "wallet",
			fetchedAt,
			windows: [],
			balances: [{ unit: "", remaining }],
			...overrides,
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

test("probe snapshots remain authoritative; only a missing snapshot may use stream data", () => {
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

test("an unknown relay probe retains its deadline without reviving a positive stream balance", () => {
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
			expect(selected).toBe(probe);
			expect(selected?.snapshot).toMatchObject({
				expiresAt: 10,
				plan: "Pro",
				windows,
				balances: [],
			});
			const t = (key: string) => key;
			expect(quotaSnapshotText(selected?.snapshot, t, 9).balance).toBe("quotaSnapshot.unknown");
			expect(quotaSnapshotText(selected?.snapshot, t, 10).balance).toBe("quotaSnapshot.expired");
		}
	}
});

test.each([
	false,
	true,
])("NUG wallet observations choose stream 9 after probe 10, then paid probe 11 (reversed=%s)", (reversed) => {
	const probe = nugWallet(10, 100, "probe", {
		balances: [{ unit: "", remaining: 10, total: 20 }],
		windows: [{ kind: "weekly", label: "probe window", usedRatio: null, resetsAt: 2_000 }],
		plan: "Pro",
		expiresAt: 3_000,
	});
	const stream = nugWallet(9, 200, "quota_balance", {
		windows: [{ kind: "other", label: "different stream window", usedRatio: 0, resetsAt: null }],
		plan: "not authoritative",
		expiresAt: 9_000,
	});
	const values = reversed ? [stream, probe] : [probe, stream];
	const original = structuredClone(values);
	const selected = selectQuotaEntries(values)[0];
	expect(selected).toMatchObject({
		primary: true,
		supported: true,
		source: "quota_balance",
		snapshot: {
			...probe.snapshot,
			fetchedAt: 200,
			balances: [{ unit: "", remaining: 9, total: 20 }],
		},
	});
	expect(selected?.snapshot?.windows).toBe(probe.snapshot.windows);
	expect(quotaSnapshotText(selected?.snapshot, (key) => key, 2_999).balance).toBe("9");
	expect(quotaSnapshotText(selected?.snapshot, (key) => key, 3_000).balance).toBe(
		"quotaSnapshot.expired",
	);
	const paidProbe = {
		...probe,
		snapshot: {
			...probe.snapshot,
			fetchedAt: 300,
			balances: [{ unit: "", remaining: 11, total: 21 }],
		},
	};
	const paid = selectQuotaEntries(reversed ? [stream, paidProbe] : [paidProbe, stream])[0];
	expect(paid).toBe(paidProbe);
	expect(quotaSnapshotText(paid?.snapshot, (key) => key, 2_999).balance).toBe("11");
	expect(values).toEqual(original);
});

test("NUG same-millisecond observations prefer probe, while later zero and negative balances remain real", () => {
	const probe = nugWallet(10, 100);
	for (const fetchedAt of [50, 100]) {
		const stream = nugWallet(9, fetchedAt, "quota_balance");
		expect(selectQuotaEntries([probe, stream])[0]).toBe(probe);
		expect(selectQuotaEntries([stream, probe])[0]).toBe(probe);
	}
	for (const remaining of [0, -1]) {
		const stream = nugWallet(remaining, 200, "quota_balance");
		expect(selectQuotaEntries([probe, stream])[0]?.snapshot?.balances[0]?.remaining).toBe(
			remaining,
		);
	}
});

test("only a single comparable NUG wallet may use stream freshness, never mismatched units or scopes", () => {
	const probe = nugWallet(10, 100);
	for (const overrides of [
		{ balances: [{ unit: "USD", remaining: 9 }] },
		{ balances: [{ unit: "CNY", remaining: 9 }] },
		{ balances: [{ unit: "gift credits", remaining: 9 }] },
		{
			balances: [
				{ unit: "", remaining: 9 },
				{ unit: "", remaining: 8 },
			],
		},
		{ scope: "key" as const },
		{ balances: [{ unit: "", remaining: null, unlimited: true }] },
	]) {
		const stream = nugWallet(9, 200, "quota_balance", overrides);
		expect(selectQuotaEntries([probe, stream])[0]).toBe(probe);
		expect(selectQuotaEntries([stream, probe])[0]).toBe(probe);
	}
	const multi = {
		...probe,
		snapshot: {
			...probe.snapshot,
			balances: [
				{ unit: "", remaining: 10 },
				{ unit: "", remaining: 5 },
			],
		},
	};
	expect(selectQuotaEntries([multi, nugWallet(9, 200, "quota_balance")])[0]).toBe(multi);
});

test("stream data cannot revive observed unknown, unsupported, or terminal-error probes", () => {
	const unknowns: Partial<PublicQuotaSnapshot>[] = [
		{ balances: [] },
		{ balances: [{ unit: "", remaining: null }] },
		{ balances: [], windows: [{ kind: "weekly", usedRatio: null, resetsAt: null }] },
		{ balances: [], error: "quota_unavailable", hasError: true },
		{ error: "plugin_not_enabled", hasError: true },
	];
	for (const templateId of ["nug", "openai-compatible"]) {
		for (const overrides of unknowns) {
			const probe = { ...nugWallet(10, 100, "probe", overrides), templateId };
			const stream = { ...nugWallet(9, 200, "quota_balance"), templateId };
			expect(selectQuotaEntries([probe, stream])[0]).toBe(probe);
			expect(selectQuotaEntries([stream, probe])[0]).toBe(probe);
		}
	}
	for (const snapshot of [null, nugWallet(10, 100).snapshot]) {
		const unsupported = { ...nugWallet(10, 100), supported: false, snapshot };
		expect(selectQuotaEntries([unsupported, nugWallet(9, 200, "quota_balance")])[0]).toBe(
			unsupported,
		);
	}
	const failedStream = nugWallet(9, 200, "quota_balance", { hasError: true });
	const probe = nugWallet(10, 100);
	expect(selectQuotaEntries([probe, failedStream])[0]).toBe(probe);
});

test("freshness never merges different credentials, groups, templates, or relay wallet observations", () => {
	const probe = nugWallet(10, 100);
	const stream = nugWallet(9, 200, "quota_balance");
	for (const field of ["credentialId", "groupId"] as const) {
		const foreign = { ...stream, [field]: "another" };
		expect(selectQuotaEntries([probe, foreign])).toEqual([probe, foreign]);
	}
	expect(selectQuotaEntries([probe, { ...stream, templateId: "other" }])[0]).toBe(probe);
	const relay = { ...probe, templateId: "openai-compatible" };
	expect(selectQuotaEntries([relay, { ...stream, templateId: "openai-compatible" }])[0]).toBe(
		relay,
	);
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
