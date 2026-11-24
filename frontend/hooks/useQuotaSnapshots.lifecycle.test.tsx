import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { QuotaSnapshotEntry, QuotaSnapshotsResponse } from "@shared/quota-snapshot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { api } from "../lib/api";
import {
	invalidateQuotaSnapshots,
	quotaSnapshotsKey,
	quotaSnapshotsOptions,
	useCommandCodeCliQuota,
	useRefreshQuotaSnapshots,
} from "./useQuotaSnapshots";

const originals = new Map<string, PropertyDescriptor | undefined>();
const { window } = parseHTML("<!doctype html><html><body></body></html>");
for (const [key, value] of Object.entries({
	window,
	document: window.document,
	navigator: window.navigator,
	HTMLElement: window.HTMLElement,
	Node: window.Node,
	Event: window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
})) {
	originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client");
let root: Root;
let container: HTMLElement;
let qc: QueryClient;
let mutation: ReturnType<typeof useRefreshQuotaSnapshots>;
let read: ReturnType<typeof spyOn<typeof api, "quotaSnapshots">>;
let refresh: ReturnType<typeof spyOn<typeof api, "refreshQuotaSnapshots">>;
function cli(
	generation = "A",
	snapshot: QuotaSnapshotEntry["snapshot"] = null,
): QuotaSnapshotEntry {
	return {
		groupId: "CommandCode",
		prefix: "CommandCode",
		templateId: "command-code",
		credentialId: null,
		generation,
		refreshOnRead: true,
		source: "probe",
		snapshot,
	};
}
const known = {
	fetchedAt: 1,
	scope: "account" as const,
	windows: [],
	balances: [{ unit: "credits", remaining: 3 }],
};
function Harness({ enabled, identity = "A" }: { enabled: boolean; identity?: string }) {
	mutation = useRefreshQuotaSnapshots(identity);
	useCommandCodeCliQuota(enabled);
	return null;
}
async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 5));
	});
}
async function mount(enabled: boolean, readers = 1) {
	await act(() =>
		root.render(
			<QueryClientProvider client={qc}>
				<StrictMode>
					<Harness enabled={enabled} />
					{readers > 1 && <Harness enabled={enabled} />}
				</StrictMode>
			</QueryClientProvider>,
		),
	);
	await settle();
}
beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	qc.setQueryData(quotaSnapshotsKey, { entries: [cli()] });
	read = spyOn(api, "quotaSnapshots").mockResolvedValue({ entries: [cli()] });
	refresh = spyOn(api, "refreshQuotaSnapshots").mockResolvedValue({ entries: [cli("A", known)] });
});
afterEach(async () => {
	await act(() => root.unmount());
	qc.clear();
	container.remove();
	read.mockRestore();
	refresh.mockRestore();
});
afterAll(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

test("only an explicitly active CLI surface refreshes, sharing one request across readers and StrictMode", async () => {
	await mount(false, 2);
	expect(refresh).not.toHaveBeenCalled();
	await mount(true, 2);
	expect(refresh).toHaveBeenCalledTimes(1);
	expect(refresh.mock.calls[0]?.[0]).toEqual({ groupId: "CommandCode" });
	expect(qc.getQueryData<QuotaSnapshotsResponse>(quotaSnapshotsKey)?.entries[0]?.snapshot).toEqual(
		known,
	);
});

test("an ordinary anonymous account is not mistaken for a CLI identity", async () => {
	qc.setQueryData(quotaSnapshotsKey, {
		entries: [{ ...cli(), refreshOnRead: undefined, generation: undefined }],
	});
	await mount(true);
	expect(refresh).not.toHaveBeenCalled();
});

test("CLI failure does not retry on a poll, but a new activation can retry once", async () => {
	refresh.mockRejectedValue(new Error("offline"));
	await mount(true);
	expect(refresh).toHaveBeenCalledTimes(1);
	await act(async () => {
		await qc.invalidateQueries({ queryKey: quotaSnapshotsKey });
	});
	await settle();
	expect(refresh).toHaveBeenCalledTimes(1);
	await mount(false);
	await mount(true);
	expect(refresh).toHaveBeenCalledTimes(2);
});

test("same-generation CLI snapshots survive GET while changed identities drop their old balance", async () => {
	qc.setQueryData(quotaSnapshotsKey, { entries: [cli("A", known)] });
	let result = await qc.fetchQuery({ ...quotaSnapshotsOptions(true, qc), staleTime: 0 });
	expect(result.entries[0]?.snapshot).toEqual(known);
	read.mockResolvedValue({ entries: [cli("B")] });
	result = await qc.fetchQuery({ ...quotaSnapshotsOptions(true, qc), staleTime: 0 });
	expect(result.entries[0]?.snapshot).toBeNull();
});

test("CLI generation changes cancel the old probe and ignore a late response", async () => {
	const completions: ((value: QuotaSnapshotsResponse) => void)[] = [];
	refresh.mockImplementation(() => new Promise((resolve) => completions.push(resolve)));
	await mount(true);
	const oldSignal = refresh.mock.calls[0]?.[1]?.signal;
	await act(() => {
		qc.setQueryData(quotaSnapshotsKey, { entries: [cli("B")] });
	});
	await settle();
	expect(refresh).toHaveBeenCalledTimes(2);
	expect(oldSignal?.aborted).toBe(true);
	await act(() => {
		completions[0]?.({ entries: [cli("A", known)] });
	});
	await settle();
	expect(qc.getQueryData<QuotaSnapshotsResponse>(quotaSnapshotsKey)?.entries[0]?.generation).toBe(
		"B",
	);
	await act(() => {
		completions[1]?.({ entries: [cli("B", known)] });
	});
	await settle();
	expect(qc.getQueryData<QuotaSnapshotsResponse>(quotaSnapshotsKey)?.entries[0]?.snapshot).toEqual(
		known,
	);
});

test("active CLI quota refreshes after sixty seconds even when GET data is structurally unchanged", async () => {
	let clock = Date.now();
	const now = spyOn(Date, "now").mockImplementation(() => clock);
	try {
		refresh.mockResolvedValueOnce({ entries: [cli("A", { ...known, fetchedAt: clock })] });
		await mount(true);
		expect(refresh).toHaveBeenCalledTimes(1);
		clock += 61_000;
		refresh.mockResolvedValueOnce({
			entries: [
				cli("A", { ...known, fetchedAt: clock, balances: [{ unit: "credits", remaining: 7 }] }),
			],
		});
		await act(async () => {
			await qc.invalidateQueries({ queryKey: quotaSnapshotsKey });
		});
		await settle();
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(
			qc.getQueryData<QuotaSnapshotsResponse>(quotaSnapshotsKey)?.entries[0]?.snapshot?.balances[0]
				?.remaining,
		).toBe(7);
		clock += 61_000;
		refresh.mockRejectedValue(new Error("offline"));
		await act(async () => {
			await qc.invalidateQueries({ queryKey: quotaSnapshotsKey });
		});
		await settle();
		expect(refresh).toHaveBeenCalledTimes(3);
		clock += 61_000;
		await act(async () => {
			await qc.invalidateQueries({ queryKey: quotaSnapshotsKey });
		});
		await settle();
		expect(refresh).toHaveBeenCalledTimes(3);
	} finally {
		now.mockRestore();
	}
});

test("closing the final CLI surface aborts pending work and ignores a late result", async () => {
	let complete: ((value: QuotaSnapshotsResponse) => void) | undefined;
	refresh.mockImplementation(
		() =>
			new Promise((resolve) => {
				complete = resolve;
			}),
	);
	await mount(true);
	const signal = refresh.mock.calls[0]?.[1]?.signal;
	await mount(false);
	expect(signal?.aborted).toBe(true);
	await act(() => {
		complete?.({ entries: [cli("A", known)] });
	});
	await settle();
	expect(
		qc.getQueryData<QuotaSnapshotsResponse>(quotaSnapshotsKey)?.entries[0]?.snapshot,
	).toBeNull();
});

test("refreshing another group preserves only the same-generation CLI result and removes deleted keys", async () => {
	qc.setQueryData(quotaSnapshotsKey, {
		entries: [cli("A", known), { ...cli("deleted"), groupId: "deleted", refreshOnRead: false }],
	});
	refresh.mockResolvedValue({ entries: [cli("A")] });
	await mount(false);
	await act(async () => {
		await mutation.mutateAsync({ groupId: "tokendance" });
	});
	expect(qc.getQueryData<QuotaSnapshotsResponse>(quotaSnapshotsKey)?.entries).toEqual([
		cli("A", known),
	]);
	refresh.mockResolvedValue({ entries: [cli("B")] });
	await act(async () => {
		await mutation.mutateAsync({ groupId: "tokendance" });
	});
	expect(qc.getQueryData<QuotaSnapshotsResponse>(quotaSnapshotsKey)?.entries).toEqual([cli("B")]);
});

test("a GET observing a changed CLI generation cancels a delayed manual refresh from the old identity", async () => {
	let complete: ((value: QuotaSnapshotsResponse) => void) | undefined;
	refresh.mockImplementation(
		() =>
			new Promise((resolve) => {
				complete = resolve;
			}),
	);
	await mount(false);
	const pending = mutation.mutateAsync({ groupId: "CommandCode" }).catch((error: unknown) => error);
	await settle();
	const signal = refresh.mock.calls[0]?.[1]?.signal;
	read.mockResolvedValue({ entries: [cli("B")] });
	await act(async () => {
		await qc.fetchQuery({ ...quotaSnapshotsOptions(true, qc), staleTime: 0 });
	});
	expect(signal?.aborted).toBe(true);
	await act(() => {
		complete?.({ entries: [cli("A", known)] });
	});
	await pending;
	await settle();
	expect(qc.getQueryData<QuotaSnapshotsResponse>(quotaSnapshotsKey)?.entries).toEqual([cli("B")]);
});

test.each([
	true,
	false,
])("a newer-identity manual POST fences a delayed older POST (prior cache=%s)", async (priorCache) => {
	if (!priorCache) qc.setQueryData(quotaSnapshotsKey, { entries: [] });
	const completions: ((value: QuotaSnapshotsResponse) => void)[] = [];
	refresh.mockImplementation(() => new Promise((resolve) => completions.push(resolve)));
	await mount(false);
	const older = mutation.mutateAsync({ groupId: "CommandCode" }).catch((error: unknown) => error);
	await settle();
	const newer = mutation.mutateAsync({ groupId: "CommandCode" });
	await settle();
	expect(refresh).toHaveBeenCalledTimes(2);
	await act(() => {
		completions[1]?.({ entries: [cli("B", known)] });
	});
	await newer;
	expect(qc.getQueryData<QuotaSnapshotsResponse>(quotaSnapshotsKey)?.entries).toEqual([
		cli("B", known),
	]);
	await act(() => {
		completions[0]?.({ entries: [cli("A", known)] });
	});
	await older;
	await settle();
	expect(qc.getQueryData<QuotaSnapshotsResponse>(quotaSnapshotsKey)?.entries).toEqual([
		cli("B", known),
	]);
});

test("a successful manual CLI refresh recovers the automatic reader after an earlier failure", async () => {
	let clock = Date.now();
	const now = spyOn(Date, "now").mockImplementation(() => clock);
	try {
		refresh.mockRejectedValueOnce(new Error("offline"));
		await mount(true);
		expect(refresh).toHaveBeenCalledTimes(1);
		await act(async () => {
			await mutation.mutateAsync({ groupId: "CommandCode" });
		});
		expect(refresh).toHaveBeenCalledTimes(2);
		clock += 61_000;
		await act(async () => {
			await qc.invalidateQueries({ queryKey: quotaSnapshotsKey });
		});
		await settle();
		expect(refresh).toHaveBeenCalledTimes(3);
	} finally {
		now.mockRestore();
	}
});

test("credential invalidation cancels every old refresh and cannot resurrect deleted entries", async () => {
	let complete: ((value: QuotaSnapshotsResponse) => void) | undefined;
	refresh.mockImplementation(
		() =>
			new Promise((resolve) => {
				complete = resolve;
			}),
	);
	await mount(false);
	const pending = mutation.mutateAsync({ groupId: "CommandCode" }).catch((error: unknown) => error);
	await settle();
	const signal = refresh.mock.calls[0]?.[1]?.signal;
	await act(async () => {
		await invalidateQuotaSnapshots(qc);
	});
	expect(signal?.aborted).toBe(true);
	await act(() => {
		complete?.({ entries: [cli("old-identity", known)] });
	});
	await pending;
	await settle();
	expect(qc.getQueryData(quotaSnapshotsKey)).toEqual({ entries: [] });
});
