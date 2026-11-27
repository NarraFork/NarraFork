import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { QuotaSnapshotEntry, QuotaSnapshotsResponse } from "@shared/quota-snapshot";
import type { QueryClient } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { api } from "../lib/api";
import { getAuthSnapshot, setToken } from "../lib/api/client";
import { quotaSnapshotsApi } from "../lib/api/quota-snapshots";

const originals = new Map<string, PropertyDescriptor | undefined>();
const tokens = new Map<string, string>();
const { window } = parseHTML("<!doctype html><html><body></body></html>");
for (const [key, value] of Object.entries({
	window,
	document: window.document,
	navigator: window.navigator,
	HTMLElement: window.HTMLElement,
	Node: window.Node,
	Event: window.Event,
	localStorage: {
		getItem: (key: string) => tokens.get(key) ?? null,
		setItem: (key: string, value: string) => tokens.set(key, value),
		removeItem: (key: string) => tokens.delete(key),
	},
	IS_REACT_ACT_ENVIRONMENT: true,
})) {
	originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { QueryClient: Client, QueryClientProvider } = await import("@tanstack/react-query");
const {
	commandCodeCliQuotaKey,
	invalidateQuotaSnapshots,
	quotaSnapshotsKey,
	quotaSnapshotsOptions,
	quotaSnapshotsReadKey,
	useCommandCodeCliQuota,
	useQuotaSnapshots,
	useRefreshQuotaSnapshots,
} = await import("./useQuotaSnapshots");
const { createRoot } = await import("react-dom/client");
let root: Root;
let container: HTMLElement;
let qc: QueryClient;
let mutation: ReturnType<typeof useRefreshQuotaSnapshots>;
let visible: QuotaSnapshotsResponse | undefined;
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
	visible = useQuotaSnapshots(false).data;
	return null;
}
async function waitFor(condition: () => boolean) {
	for (let attempt = 0; attempt < 100; attempt++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		if (condition()) return;
	}
	throw new Error("Quota state did not settle");
}
async function mount(enabled: boolean, readers = 1, identity = "A") {
	await act(() =>
		root.render(
			<QueryClientProvider client={qc}>
				<StrictMode>
					<Harness enabled={enabled} identity={identity} />
					{readers > 1 && <Harness enabled={enabled} identity={identity} />}
				</StrictMode>
			</QueryClientProvider>,
		),
	);
}
function deferredRefresh() {
	const requests: { signal?: AbortSignal; complete: (value: QuotaSnapshotsResponse) => void }[] =
		[];
	refresh.mockImplementation(
		(_target, options) =>
			new Promise((complete) => {
				requests.push({ signal: options?.signal, complete });
			}),
	);
	return requests;
}
const displayed = () => visible?.entries.find((entry) => entry.groupId === "CommandCode");
beforeEach(() => {
	tokens.clear();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	qc = new Client({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	qc.setQueryData(quotaSnapshotsReadKey(), { entries: [cli()] });
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

test("active surfaces share an ephemeral result without writing it into GET", async () => {
	await mount(false, 2);
	expect(refresh).not.toHaveBeenCalled();
	await mount(true, 2);
	await waitFor(() => displayed()?.snapshot?.balances[0]?.remaining === 3);
	expect(qc.getQueryData<QuotaSnapshotsResponse>(quotaSnapshotsReadKey())?.entries).toEqual([
		cli(),
	]);
	await mount(true, 1);
	expect(displayed()?.snapshot).toEqual(known);
});

test("anonymous non-CLI accounts never initiate a CLI probe", async () => {
	qc.setQueryData(quotaSnapshotsReadKey(), {
		entries: [{ ...cli(), refreshOnRead: undefined, generation: undefined }],
	});
	await mount(true);
	expect(refresh).not.toHaveBeenCalled();
});

test("failed CLI reads do not retry on ordinary polling; reactivation may recover", async () => {
	refresh.mockRejectedValue(new Error("offline"));
	await mount(true);
	await waitFor(() => qc.getQueryState(commandCodeCliQuotaKey(cli()))?.status === "error");
	refresh.mockResolvedValue({ entries: [cli("A", known)] });
	await act(async () => {
		await qc.invalidateQueries({ queryKey: quotaSnapshotsKey });
	});
	expect(displayed()?.snapshot).toBeNull();
	expect(qc.getQueryState(commandCodeCliQuotaKey(cli()))?.status).toBe("error");
	await mount(false);
	await mount(true);
	await waitFor(() => displayed()?.snapshot?.balances[0]?.remaining === 3);
});

test("server polls retain same-generation display and remove changed identities", async () => {
	qc.setQueryData(commandCodeCliQuotaKey(cli()), cli("A", known));
	await mount(false);
	await act(async () => {
		await qc.fetchQuery({ ...quotaSnapshotsOptions(true, qc), staleTime: 0 });
	});
	await waitFor(
		() => displayed()?.snapshot === known || displayed()?.snapshot?.balances[0]?.remaining === 3,
	);
	read.mockResolvedValue({ entries: [cli("B")] });
	await act(async () => {
		await qc.fetchQuery({ ...quotaSnapshotsOptions(true, qc), staleTime: 0 });
	});
	await waitFor(() => displayed()?.generation === "B");
	expect(displayed()?.snapshot).toBeNull();
});

test("generation changes cancel old probes and late responses cannot cross accounts", async () => {
	const requests = deferredRefresh();
	await mount(true);
	await waitFor(() => requests.some((request) => !request.signal?.aborted));
	const old = requests.find((request) => !request.signal?.aborted);
	await act(() => {
		qc.setQueryData(quotaSnapshotsReadKey(), { entries: [cli("B")] });
	});
	await waitFor(
		() => old?.signal?.aborted === true && requests.some((request) => !request.signal?.aborted),
	);
	const current = requests.find((request) => !request.signal?.aborted);
	await act(() => {
		old?.complete({ entries: [cli("A", known)] });
	});
	expect(displayed()?.generation).toBe("B");
	expect(displayed()?.snapshot).toBeNull();
	await act(() => {
		current?.complete({ entries: [cli("B", known)] });
	});
	await waitFor(() => displayed()?.snapshot?.balances[0]?.remaining === 3);
});

test("Query freshness reuses sixty-second data and refreshes stale data on activation", async () => {
	let clock = Date.now();
	const now = spyOn(Date, "now").mockImplementation(() => clock);
	try {
		await mount(true);
		await waitFor(() => displayed()?.snapshot?.balances[0]?.remaining === 3);
		await mount(false);
		refresh.mockResolvedValue({
			entries: [cli("A", { ...known, balances: [{ unit: "credits", remaining: 7 }] })],
		});
		await mount(true);
		expect(displayed()?.snapshot?.balances[0]?.remaining).toBe(3);
		await mount(false);
		clock += 61_000;
		await mount(true);
		await waitFor(() => displayed()?.snapshot?.balances[0]?.remaining === 7);
	} finally {
		now.mockRestore();
	}
});

test("active Query polling stops on failure and manual recovery restarts it", async () => {
	let clock = Date.now();
	const now = spyOn(Date, "now").mockImplementation(() => clock);
	const intervals = new Map<ReturnType<typeof setInterval>, () => void>();
	const nativeInterval = globalThis.setInterval;
	const nativeClear = globalThis.clearInterval;
	const timer = spyOn(globalThis, "setInterval").mockImplementation(((
		callback: () => void,
		ms: number,
	) => {
		const id = nativeInterval(callback, ms);
		if (ms === 60_000) intervals.set(id, callback);
		return id;
	}) as typeof setInterval);
	const clear = spyOn(globalThis, "clearInterval").mockImplementation((id) => {
		intervals.delete(id as ReturnType<typeof setInterval>);
		nativeClear(id as ReturnType<typeof setInterval>);
	});
	const tick = async () => {
		clock += 61_000;
		await act(() => {
			for (const callback of [...intervals.values()]) callback();
		});
	};
	try {
		await mount(true);
		await waitFor(() => displayed()?.snapshot?.balances[0]?.remaining === 3);
		refresh.mockResolvedValue({
			entries: [cli("A", { ...known, balances: [{ unit: "credits", remaining: 7 }] })],
		});
		await tick();
		await waitFor(() => displayed()?.snapshot?.balances[0]?.remaining === 7);
		refresh.mockRejectedValue(new Error("offline"));
		await tick();
		await waitFor(() => qc.getQueryState(commandCodeCliQuotaKey(cli()))?.status === "error");
		expect(intervals.size).toBe(0);
		await act(async () => {
			await qc.invalidateQueries({ queryKey: quotaSnapshotsKey });
		});
		expect(qc.getQueryState(commandCodeCliQuotaKey(cli()))?.status).toBe("error");
		refresh.mockResolvedValue({ entries: [cli("A", known)] });
		await act(async () => {
			await mutation.mutateAsync({ groupId: "CommandCode" });
		});
		await waitFor(() => displayed()?.snapshot?.balances[0]?.remaining === 3);
		expect(intervals.size).toBeGreaterThan(0);
	} finally {
		for (const id of intervals.keys()) nativeClear(id);
		timer.mockRestore();
		clear.mockRestore();
		now.mockRestore();
	}
});

test("the last active reader cancels even while passive quota displays remain mounted", async () => {
	const requests = deferredRefresh();
	await mount(true, 2);
	await waitFor(() => requests.some((request) => !request.signal?.aborted));
	const pending = requests.find((request) => !request.signal?.aborted);
	await mount(true, 1);
	expect(pending?.signal?.aborted).toBe(false);
	await mount(false);
	expect(pending?.signal?.aborted).toBe(true);
	await act(() => {
		pending?.complete({ entries: [cli("A", known)] });
	});
	expect(displayed()?.snapshot).toBeNull();
});

test("another group's refresh removes deleted entries but retains only matching CLI data", async () => {
	qc.setQueryData(commandCodeCliQuotaKey(cli()), cli("A", known));
	qc.setQueryData(quotaSnapshotsReadKey(), {
		entries: [cli(), { ...cli(), groupId: "deleted", refreshOnRead: false }],
	});
	refresh.mockResolvedValue({ entries: [cli()] });
	await mount(false);
	await act(async () => {
		await mutation.mutateAsync({ groupId: "tokendance" });
	});
	await waitFor(() => visible?.entries.length === 1);
	expect(displayed()?.snapshot).toEqual(known);
	refresh.mockResolvedValue({ entries: [cli("B")] });
	await act(async () => {
		await mutation.mutateAsync({ groupId: "tokendance" });
	});
	await waitFor(() => displayed()?.generation === "B");
	expect(displayed()?.snapshot).toBeNull();
});

test("a normal GET updating another source does not discard the pending manual refresh", async () => {
	const source: QuotaSnapshotEntry = {
		...cli(),
		groupId: "tokendance",
		templateId: "tokendance",
		credentialId: "td-key",
		refreshOnRead: false,
		generation: undefined,
		snapshot: known,
	};
	qc.setQueryData(quotaSnapshotsReadKey(), { entries: [cli(), source] });
	const requests = deferredRefresh();
	await mount(false);
	const pending = mutation.mutateAsync({ groupId: "tokendance" });
	await waitFor(() => requests.length > 0);
	read.mockResolvedValue({ entries: [cli(), { ...source, refreshing: true }] });
	await act(async () => {
		await qc.fetchQuery({ ...quotaSnapshotsOptions(true, qc), staleTime: 0 });
	});
	await waitFor(
		() =>
			visible?.entries.some((entry) => entry.groupId === "tokendance" && entry.refreshing) === true,
	);
	expect(requests[0]?.signal?.aborted).toBe(false);
	const refreshed = {
		...source,
		snapshot: { ...known, balances: [{ unit: "credits", remaining: 9 }] },
	};
	await act(async () => {
		requests[0]?.complete({ entries: [cli(), refreshed] });
		await pending;
	});
	await waitFor(
		() =>
			visible?.entries.find((entry) => entry.groupId === "tokendance")?.snapshot?.balances[0]
				?.remaining === 9,
	);
});

test.each([
	"generation",
	"credentials",
	"component",
])("%s changes cancel delayed manual refreshes", async (change) => {
	const requests = deferredRefresh();
	await mount(false);
	const pending = mutation.mutateAsync({ groupId: "CommandCode" }).catch((error: unknown) => error);
	await waitFor(() => requests.length > 0);
	if (change === "generation") {
		read.mockResolvedValue({ entries: [cli("B")] });
		await act(async () => {
			await qc.fetchQuery({ ...quotaSnapshotsOptions(true, qc), staleTime: 0 });
		});
	} else if (change === "credentials") {
		await act(async () => {
			await invalidateQuotaSnapshots(qc);
		});
	} else await mount(false, 1, "B");
	expect(requests[0]?.signal?.aborted).toBe(true);
	await act(async () => {
		requests[0]?.complete({ entries: [cli("A", known)] });
		await pending;
	});
	expect(displayed()?.snapshot ?? null).toBeNull();
});

test.each([
	"replacement",
	"A→B→A",
])("a pending manual refresh cannot overwrite the %s session's Root projection", async (change) => {
	setToken("quota-session-old");
	const entry: QuotaSnapshotEntry = {
		...cli(),
		groupId: "plain",
		credentialId: "shared-key",
		refreshOnRead: false,
		generation: undefined,
		snapshot: known,
	};
	qc.setQueryData(quotaSnapshotsReadKey(), { entries: [entry] });
	const requests = deferredRefresh();
	await mount(false);
	const pending = mutation.mutateAsync({ groupId: "plain" }).catch((error: unknown) => error);
	await waitFor(() => requests.length > 0);
	const freshRoot: QuotaSnapshotsResponse = {
		entries: [
			{
				...entry,
				snapshot: { ...known, balances: [{ unit: "credits", remaining: 9 }] },
			},
		],
	};
	await act(async () => {
		setToken("quota-session-new");
		if (change === "A→B→A") setToken("quota-session-old");
		qc.setQueryData(quotaSnapshotsReadKey(), freshRoot);
	});
	await waitFor(() => visible?.entries[0]?.snapshot?.balances[0]?.remaining === 9);
	// No edit invalidation or cancellation masks the session barrier being exercised.
	expect(requests[0]?.signal?.aborted).toBe(false);
	await act(async () => {
		requests[0]?.complete({ entries: [entry] });
		await pending;
	});
	expect(qc.getQueryData(quotaSnapshotsReadKey())).toEqual(freshRoot);
	expect(visible).toEqual(freshRoot);
});

test.each([
	"A→B",
	"A→B→A",
])("completed administrator Root snapshots cannot be reused after %s while the new HTTP read is pending", async (change) => {
	setToken("quota-admin-A");
	const oldKey = quotaSnapshotsReadKey();
	const administrator: QuotaSnapshotsResponse = {
		entries: [
			{
				...cli(),
				groupId: "admin-only",
				templateId: "custom-api",
				credentialId: "admin-key",
				refreshOnRead: false,
				generation: undefined,
				snapshot: known,
			},
		],
	};
	const ordinary: QuotaSnapshotsResponse = {
		entries: administrator.entries.map((entry) => ({
			...entry,
			groupId: "current-user",
			credentialId: "current-key",
		})),
	};
	const nextHttp = Promise.withResolvers<Response>();
	let requests = 0;
	const http = spyOn(globalThis, "fetch").mockImplementation((async (url: unknown) => {
		expect(String(url)).toEndWith("/api/quota-snapshots");
		return ++requests === 1 ? Response.json(administrator) : nextHttp.promise;
	}) as typeof fetch);
	read.mockImplementation(quotaSnapshotsApi.quotaSnapshots);
	try {
		// Complete a real public HTTP read before mounting; its 30s freshness remains intact.
		await qc.fetchQuery(quotaSnapshotsOptions(true, qc));
		await mount(true);
		await waitFor(() => visible?.entries[0]?.groupId === "admin-only");
		expect(requests).toBe(1);
		expect(qc.getQueryState(oldKey)?.status).toBe("success");
		await act(async () => {
			setToken("quota-user-B");
			if (change === "A→B→A") setToken("quota-admin-A");
		});
		await waitFor(() => requests === 2);
		const currentKey = quotaSnapshotsReadKey();
		expect(currentKey).not.toEqual(oldKey);
		expect(visible).toBeUndefined();
		expect(qc.getQueryData(currentKey)).toBeUndefined();
		// Retaining the old successful query proves this is isolation, not cache clearing.
		expect(qc.getQueryData(oldKey)).toEqual(administrator);
		await act(async () => nextHttp.resolve(Response.json(ordinary)));
		await waitFor(() => visible?.entries[0]?.groupId === "current-user");
		expect(qc.getQueryData(currentKey)).toEqual(ordinary);
		expect(qc.getQueryData(oldKey)).toEqual(administrator);
		expect(refresh).not.toHaveBeenCalled();
	} finally {
		http.mockRestore();
	}
});

test("a late Root GET cannot write through an A→B→A session barrier without cancellation", async () => {
	setToken("quota-root-old");
	const pendingRead = Promise.withResolvers<QuotaSnapshotsResponse>();
	read.mockReturnValue(pendingRead.promise);
	const pending = qc
		.fetchQuery({ ...quotaSnapshotsOptions(true, qc), staleTime: 0 })
		.catch((error: unknown) => error);
	await waitFor(() => read.mock.calls.length > 0);
	setToken("quota-root-new");
	setToken("quota-root-old");
	const fresh: QuotaSnapshotsResponse = { entries: [cli("B")] };
	qc.setQueryData(quotaSnapshotsReadKey(), fresh);
	expect(read.mock.calls[0]?.[0]?.signal?.aborted).toBe(false);
	pendingRead.resolve({ entries: [cli("A", known)] });
	await pending;
	expect(qc.getQueryData(quotaSnapshotsReadKey())).toEqual(fresh);
});

test("same CLI credential generation cannot reuse a previous auth lifetime's ephemeral quota after A→B→A", async () => {
	setToken("quota-cli-old");
	const oldAuthGeneration = getAuthSnapshot().generation;
	const requests = deferredRefresh();
	await mount(true);
	await waitFor(() => requests.some((request) => !request.signal?.aborted));
	const old = requests.find((request) => !request.signal?.aborted);
	await act(async () => {
		setToken("quota-cli-new");
		setToken("quota-cli-old");
	});
	await waitFor(
		() => old?.signal?.aborted === true && requests.some((request) => !request.signal?.aborted),
	);
	const current = requests.find((request) => !request.signal?.aborted);
	expect(commandCodeCliQuotaKey(cli())).not.toEqual(
		commandCodeCliQuotaKey(cli(), oldAuthGeneration),
	);
	await act(async () => old?.complete({ entries: [cli("A", known)] }));
	expect(displayed()?.snapshot).toBeNull();
	await act(async () => current?.complete({ entries: [cli("A", { ...known, fetchedAt: 2 })] }));
	await waitFor(() => displayed()?.snapshot?.fetchedAt === 2);
});

test("closing an unrelated refresh surface does not cancel the request owner", async () => {
	const requests = deferredRefresh();
	await mount(false);
	const pending = mutation.mutateAsync({ groupId: "CommandCode" });
	await waitFor(() => requests.length > 0);
	await mount(false, 2);
	await mount(false, 1);
	expect(requests[0]?.signal?.aborted).toBe(false);
	await act(async () => {
		requests[0]?.complete({ entries: [cli("A", known)] });
		await pending;
	});
	await waitFor(() => displayed()?.snapshot?.balances[0]?.remaining === 3);
});

test("a newer manual refresh supersedes a delayed older request", async () => {
	const requests = deferredRefresh();
	await mount(false);
	const older = mutation.mutateAsync({ groupId: "CommandCode" }).catch((error: unknown) => error);
	await waitFor(() => requests.length > 0);
	const newer = mutation.mutateAsync({ groupId: "CommandCode" });
	await waitFor(() => requests.length > 1);
	expect(requests[0]?.signal?.aborted).toBe(true);
	await act(async () => {
		requests[1]?.complete({ entries: [cli("B", known)] });
		await newer;
	});
	await waitFor(() => displayed()?.generation === "B" && !!displayed()?.snapshot);
	await act(async () => {
		requests[0]?.complete({ entries: [cli("A", known)] });
		await older;
	});
	expect(displayed()?.generation).toBe("B");
	expect(displayed()?.snapshot).toEqual(known);
});

test("credential invalidation does not detach a still-active same-generation CLI observer", async () => {
	await mount(true);
	await waitFor(() => displayed()?.snapshot?.balances[0]?.remaining === 3);
	refresh.mockResolvedValue({
		entries: [cli("A", { ...known, balances: [{ unit: "credits", remaining: 9 }] })],
	});
	await act(async () => {
		await invalidateQuotaSnapshots(qc);
	});
	await waitFor(() => displayed()?.snapshot?.balances[0]?.remaining === 9);
});

test("credential invalidation also fences manual results without a CLI generation", async () => {
	const entry = {
		...cli(),
		groupId: "plain",
		credentialId: "old-key",
		refreshOnRead: false,
		generation: undefined,
	};
	qc.setQueryData(quotaSnapshotsReadKey(), { entries: [entry] });
	const requests = deferredRefresh();
	await mount(false);
	const pending = mutation.mutateAsync({ groupId: "plain" }).catch((error: unknown) => error);
	await waitFor(() => requests.length > 0);
	await act(async () => {
		await invalidateQuotaSnapshots(qc);
	});
	await act(async () => {
		requests[0]?.complete({ entries: [{ ...entry, snapshot: known }] });
		await pending;
	});
	expect(requests[0]?.signal?.aborted).toBe(true);
	expect(qc.getQueryData(quotaSnapshotsReadKey())).toEqual({ entries: [] });
});

test("manual refresh recovers a failed active CLI Query and restores its freshness", async () => {
	refresh.mockRejectedValueOnce(new Error("offline"));
	await mount(true);
	await waitFor(() => qc.getQueryState(commandCodeCliQuotaKey(cli()))?.status === "error");
	await act(async () => {
		await mutation.mutateAsync({ groupId: "CommandCode" });
	});
	await waitFor(() => displayed()?.snapshot?.balances[0]?.remaining === 3);
	expect(qc.getQueryState(commandCodeCliQuotaKey(cli()))?.status).toBe("success");
	expect(qc.getQueryData<QuotaSnapshotsResponse>(quotaSnapshotsReadKey())?.entries).toEqual([
		cli(),
	]);
});
