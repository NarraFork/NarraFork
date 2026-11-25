import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { seedCurrentUser } from "@frontend/hooks/useCurrentUser";
import { ApiError, api } from "@frontend/lib/api";
import { confirmAuthUser, setToken } from "@frontend/lib/api/client";
import type {
	NarratorPanelStateOptions,
	NarratorPanelStateResponse,
} from "@frontend/lib/api/narrators";
import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import type { PendingPermission } from "@frontend/types/narrator";
import { notifications } from "@mantine/notifications";
import type { ProviderBalanceSnapshot } from "@shared/provider-balance";
import {
	notifyManager,
	QueryClient,
	QueryClientProvider,
	QueryObserver,
	useQuery,
} from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { customApiBalanceDisplayFor } from "./model/custom-api-usage-source";
import { nugQuotaKey, useNugQuota } from "./model/use-nug-quota";
import { type UseNarratorPanelWSReturn, useNarratorPanelWS } from "./useNarratorPanelWS";
import { findPendingForKey } from "./vlist/vlist-permission-match";

type QuotaSettings = {
	customApiQuotas: NonNullable<Parameters<typeof customApiBalanceDisplayFor>[0]["pushedQuotas"]>;
};
let quotaProviderId: string | null = null;
let nugProvider: { id: string; generation?: number | string } | null = null;
let balanceSnapshot: ProviderBalanceSnapshot | undefined;
let quotaDisplay: ReturnType<typeof customApiBalanceDisplayFor>;
function subscriptionSnapshot(): ProviderBalanceSnapshot {
	return {
		generation: "g1",
		status: "supported",
		adapter: "sub2api",
		balance: {
			scope: "subscription",
			unlimited: false,
			amounts: [{ unit: "USD", window: "daily", total: 10, used: 2, remaining: 8 }],
		},
		fetchedAt: 1,
		attemptedAt: 1,
		error: null,
	};
}

let root: Root;
let host: HTMLElement;
let qc: QueryClient;
let current: UseNarratorPanelWSReturn;
let narratorId = "n1";
let narratorStatus = "waiting";
let connected = false;
let panelSpy: ReturnType<typeof spyOn<typeof api, "getNarratorPanelState">>;
let instance: typeof i18next;
const originals = new Map<string, PropertyDescriptor | undefined>();
const managerOriginals = new Map<string, PropertyDescriptor | undefined>();
const restores: Array<() => void> = [];
const connections = new Set<(connected: boolean, isReconnect: boolean) => void>();
const recoveries = new Set<() => void>();
let observeDetails = false;
let observedDetailId: string | undefined;
let detailReads = 0;
let childReads = 0;
const listeners = new Map<number, (frame: Record<string, unknown>) => void>();
let nextListenerId = 0;

const permissions = (count: number, from = 0): PendingPermission[] =>
	Array.from({ length: count }, (_, index) => ({
		id: `p${from + index}`,
		toolName: "Bash",
		inputJson: { command: "pwd" },
	}));
const page = (
	pending: PendingPermission[],
	overrides: Partial<NarratorPanelStateResponse> = {},
): NarratorPanelStateResponse => ({
	permissions: pending,
	buffer: [],
	draft: { hasDraft: false, revision: 0, updatedAt: null },
	hasMore: { permissions: false, buffer: false },
	...overrides,
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function cancelable<T>(promise: Promise<T>, signal?: AbortSignal) {
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		promise.then(
			(value) => {
				signal?.removeEventListener("abort", abort);
				resolve(value);
			},
			(error) => {
				signal?.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}
function Harness() {
	current = useNarratorPanelWS({ narratorId, narratorStatus, isAtBottomRef: { current: true } });
	return observeDetails ? <DetailObservers /> : null;
}
function DetailObservers() {
	const id = observedDetailId ?? narratorId;
	useQuery({
		queryKey: ["narrators", id],
		queryFn: async () => {
			detailReads++;
			return qc.getQueryData(["narrators", id]) ?? { id };
		},
	});
	useQuery({
		queryKey: ["narrators", id, "tasks", "current"],
		queryFn: async () => {
			childReads++;
			return [];
		},
	});
	return null;
}
function QuotaHarness() {
	const { data: settings } = useQuery<QuotaSettings>({
		queryKey: ["settings"],
		queryFn: async () => ({ customApiQuotas: {} }),
		enabled: false,
	});
	quotaDisplay = customApiBalanceDisplayFor({
		providerId: quotaProviderId,
		pushedQuotas: settings?.customApiQuotas,
		snapshot: balanceSnapshot,
	});
	current = useNarratorPanelWS({
		narratorId,
		narratorStatus,
		isAtBottomRef: { current: true },
		customApiProviderId: quotaProviderId ?? undefined,
		quotaProviderKey: quotaProviderId ?? undefined,
		initialQuotaBalance: quotaDisplay.pushedQuota?.quotaBalance ?? null,
		initialDetailedQuotaBalance: quotaDisplay.pushedQuota?.detailedQuotaBalance ?? null,
	});
	return null;
}
function NugQuotaHarness() {
	const quota = useNugQuota("nug:model", nugProvider ? [{ ...nugProvider, prefix: "nug" }] : []);
	current = useNarratorPanelWS({
		narratorId,
		narratorStatus,
		isAtBottomRef: { current: true },
		nugProviderId: nugProvider?.id,
		nugProviderGeneration: nugProvider?.generation,
		quotaProviderKey: nugProvider?.id,
		initialQuotaBalance: quota?.quotaBalance,
		initialDetailedQuotaBalance: quota?.detailedQuotaBalance,
	});
	return null;
}
const render = () =>
	act(async () =>
		root.render(
			<QueryClientProvider client={qc}>
				<I18nextProvider i18n={instance}>
					{nugProvider ? <NugQuotaHarness /> : quotaProviderId ? <QuotaHarness /> : <Harness />}
				</I18nextProvider>
			</QueryClientProvider>,
		),
	);
const event = (frame: Record<string, unknown>) =>
	act(async () => {
		for (const listener of listeners.values()) listener({ narratorId, ...frame });
	});
const connection = (value: boolean) =>
	act(async () => {
		connected = value;
		for (const update of connections) update(value, false);
	});
const retryTick = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 275));
	});

function bindUser(token: string, id = "u1") {
	const generation = setToken(token);
	confirmAuthUser(generation, id);
	seedCurrentUser(qc, generation, { id });
	return generation;
}

beforeEach(async () => {
	const { window } = parseHTML("<html><body></body></html>");
	const tokens = new Map<string, string>();
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		localStorage: {
			getItem: (key: string) => tokens.get(key) ?? null,
			setItem: (key: string, value: string) => {
				tokens.set(key, value);
			},
			removeItem: (key: string) => {
				tokens.delete(key);
			},
		},
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	for (const key of ["connected", "disconnected"])
		managerOriginals.set(key, Object.getOwnPropertyDescriptor(narratorWSManager, key));
	Object.defineProperty(narratorWSManager, "connected", {
		configurable: true,
		get: () => connected,
	});
	Object.defineProperty(narratorWSManager, "disconnected", {
		configurable: true,
		get: () => !connected,
	});
	for (const spy of [
		spyOn(narratorWSManager, "subscribe").mockImplementation((ids, options) => ({
			_id: ++nextListenerId,
			_narratorIds: [...ids],
			_kind: options?.kind ?? "messages",
		})),
		spyOn(narratorWSManager, "unsubscribe").mockImplementation(() => {}),
		spyOn(narratorWSManager, "joinPresence").mockImplementation(() => {}),
		spyOn(narratorWSManager, "leavePresence").mockImplementation(() => {}),
		spyOn(narratorWSManager, "addListener").mockImplementation((_options, callback) => {
			const id = ++nextListenerId;
			listeners.set(id, callback);
			return { _id: id };
		}),
		spyOn(narratorWSManager, "removeListener").mockImplementation((handle) => {
			listeners.delete(handle._id);
		}),
		spyOn(narratorWSManager, "onControlPlaneRecovery").mockImplementation((callback) => {
			recoveries.add(callback);
			return () => {
				recoveries.delete(callback);
			};
		}),
		spyOn(narratorWSManager, "onConnectionChange").mockImplementation((callback) => {
			connections.add(callback);
			return () => {
				connections.delete(callback);
			};
		}),
	])
		restores.push(() => spy.mockRestore());
	narratorId = "n1";
	narratorStatus = "waiting";
	quotaProviderId = null;
	nugProvider = null;
	balanceSnapshot = undefined;
	connected = false;
	listeners.clear();
	connections.clear();
	recoveries.clear();
	observeDetails = false;
	observedDetailId = undefined;
	detailReads = 0;
	childReads = 0;
	notifyManager.setScheduler(queueMicrotask);
	qc = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
	});
	bindUser("quota-token");
	const me = spyOn(api, "me").mockImplementation(
		async () => qc.getQueryData<{ id: string }>(["auth", "me"]) ?? { id: "u1" },
	);
	restores.push(() => me.mockRestore());
	instance = i18next.createInstance();
	await instance
		.use(initReactI18next)
		.init({ lng: "en", resources: { en: { narrator: {} } }, react: { useSuspense: false } });
	panelSpy = spyOn(api, "getNarratorPanelState").mockResolvedValue(page([]));
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	qc.clear();
	notifyManager.setScheduler((callback) => setTimeout(callback, 0));
	host.remove();
	panelSpy.mockRestore();
	for (const restore of restores.splice(0)) restore();
	for (const [key, descriptor] of managerOriginals) {
		if (descriptor) Object.defineProperty(narratorWSManager, key, descriptor);
		else Reflect.deleteProperty(narratorWSManager, key);
	}
	managerOriginals.clear();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

describe("upstream timed wait notifications with the real WS hook", () => {
	test.each([
		["capacity", "capacity"],
		["rate_limit", "rateLimit"],
		["quota", "quotaExhausted"],
	] as const)("%s keeps the wait reason through waiting and recovery", async (waitKind, prefix) => {
		const show = spyOn(notifications, "show").mockReturnValue("notice");
		const hide = spyOn(notifications, "hide").mockImplementation((id) => id);
		restores.push(
			() => show.mockRestore(),
			() => hide.mockRestore(),
		);
		await render();
		await event({
			type: "model_unavailable_waiting",
			waitKind,
			model: "ocg:test",
			quotaProvider: "opencode",
			resumeAt: 123456,
		});
		expect(show.mock.calls.at(-1)?.[0]).toMatchObject({
			title: `${prefix}WaitingTitle`,
			autoClose: false,
		});
		expect(current.quotaWaitInfo).toMatchObject({ waitKind, resumeAt: 123456 });
		await event({
			type: "model_unavailable_recovered",
			waitKind,
			model: "ocg:test",
			quotaProvider: "opencode",
		});
		expect(show.mock.calls.at(-1)?.[0]).toMatchObject({ title: `${prefix}RecoveredTitle` });
		expect(current.quotaWaitInfo).toBeNull();
		await event({
			type: "model_unavailable_waiting",
			waitKind,
			model: "ocg:test",
			resumeAt: 123456,
		});
		await event({ type: "status_change", status: "idle", substatus: ["error"] });
		expect(current.quotaWaitInfo).toBeNull();
		expect(hide).toHaveBeenCalledWith("model-unavailable-n1");
	});

	test("old quota/rateLimit events recover without claiming quota was restored", async () => {
		const show = spyOn(notifications, "show").mockReturnValue("notice");
		const hide = spyOn(notifications, "hide").mockImplementation((id) => id);
		restores.push(
			() => show.mockRestore(),
			() => hide.mockRestore(),
		);
		await render();
		await event({
			type: "model_unavailable_waiting",
			waitKind: "quota",
			quotaBucket: "rateLimit",
			message: "[prefill_cap_refused] the cell is at capacity",
			model: "ocg:test",
			resumeAt: 123456,
		});
		expect(current.quotaWaitInfo?.waitKind).toBe("capacity");
		expect(show.mock.calls.at(-1)?.[0].title).toBe("capacityWaitingTitle");
		await event({ type: "model_unavailable_recovered", waitKind: "quota", model: "ocg:test" });
		expect(show.mock.calls.at(-1)?.[0].title).toBe("capacityRecoveredTitle");
	});
});

describe("NUG quota identity refresh with the real panel and active query observers", () => {
	const quotaResult = (generation = 7) => ({
		generation,
		quota: { balance: 3, totalGranted: 10, detailedQuotaBalance: "cached quota", fetchedAt: 1 },
	});
	function activeOtherIdentity(
		providerId: string,
		generation: number | string | undefined,
		authGeneration: number,
	) {
		const key = nugQuotaKey(providerId, generation, authGeneration);
		const snapshot = quotaResult(Number(generation) || 7).quota;
		qc.setQueryData(key, snapshot);
		const result = { key, reads: 0, snapshot };
		const observer = new QueryObserver(qc, {
			queryKey: key,
			queryFn: async () => {
				result.reads++;
				return snapshot;
			},
			staleTime: Infinity,
		});
		const unsubscribe = observer.subscribe(() => {});
		restores.push(unsubscribe);
		return result;
	}
	function quotaDomainSpies() {
		const cached = spyOn(api, "nugGetCachedQuota").mockResolvedValue(quotaResult());
		const aggregate = spyOn(api, "nugGetQuotas").mockRejectedValue(
			new Error("aggregate quota read is forbidden"),
		);
		const rpc = spyOn(api, "nugGetQuota").mockRejectedValue(new Error("quota RPC is forbidden"));
		restores.push(
			() => cached.mockRestore(),
			() => aggregate.mockRestore(),
			() => rpc.mockRestore(),
		);
		return { cached, aggregate, rpc };
	}
	function emitQuotaBurst(count: number) {
		for (let index = 0; index < count; index++)
			for (const listener of listeners.values())
				listener({ narratorId, type: "quota_balance", quotaBalance: `pushed-${index}` });
	}

	test("a burst refreshes only the active provider and auth generation through its cached-only reader", async () => {
		const oldAuthGeneration = setToken("quota-token");
		setToken("other-token");
		const authGeneration = bindUser("quota-token");
		nugProvider = { id: "nug-current", generation: 7 };
		const domain = quotaDomainSpies();
		const others = [
			activeOtherIdentity("nug-other", 7, authGeneration),
			activeOtherIdentity("nug-current", 6, authGeneration),
			activeOtherIdentity("nug-current", 7, oldAuthGeneration),
			activeOtherIdentity("nug-current", undefined, authGeneration),
		];
		await render();
		expect(domain.cached).toHaveBeenCalledTimes(1);
		domain.cached.mockClear();
		const invalidate = spyOn(qc, "invalidateQueries");
		restores.push(() => invalidate.mockRestore());
		await act(async () => emitQuotaBurst(20));
		expect(domain.cached).toHaveBeenCalledTimes(1);
		expect(domain.cached.mock.calls[0]?.[0]).toBe("nug-current");
		expect(domain.cached.mock.calls[0]?.[1]).toMatchObject({ expectedGeneration: 7 });
		expect(invalidate.mock.calls.map((call) => call[0])).toEqual([
			{ queryKey: nugQuotaKey("nug-current", 7, authGeneration), exact: true },
		]);
		for (const other of others) {
			expect(other.reads).toBe(0);
			expect(qc.getQueryData(other.key)).toBe(other.snapshot);
			expect(qc.getQueryState(other.key)?.isInvalidated).toBe(false);
		}
		expect(domain.aggregate).not.toHaveBeenCalled();
		expect(domain.rpc).not.toHaveBeenCalled();
	});

	test("events during a cached refresh coalesce into one follow-up without cancelling transport", async () => {
		setToken("quota-token");
		nugProvider = { id: "nug-current", generation: 7 };
		const domain = quotaDomainSpies();
		await render();
		domain.cached.mockClear();
		const first = deferred<Awaited<ReturnType<typeof api.nugGetCachedQuota>>>();
		const followup = deferred<Awaited<ReturnType<typeof api.nugGetCachedQuota>>>();
		domain.cached.mockReturnValueOnce(first.promise).mockReturnValueOnce(followup.promise);
		await event({ type: "quota_balance", quotaBalance: "first" });
		expect(domain.cached).toHaveBeenCalledTimes(1);
		const signal = domain.cached.mock.calls[0]?.[1]?.signal;
		await act(async () => emitQuotaBurst(20));
		expect(domain.cached).toHaveBeenCalledTimes(1);
		expect(signal?.aborted).toBe(false);
		await act(async () => first.resolve(quotaResult()));
		expect(domain.cached).toHaveBeenCalledTimes(2);
		await act(async () => followup.resolve(quotaResult()));
		expect(domain.cached).toHaveBeenCalledTimes(2);
		expect(domain.aggregate).not.toHaveBeenCalled();
		expect(domain.rpc).not.toHaveBeenCalled();
	});

	test("an old connection credential cannot update local quota state or invalidate any observer", async () => {
		setToken("quota-token");
		nugProvider = { id: "nug-current", generation: 7 };
		const domain = quotaDomainSpies();
		let socketIdentity = 2;
		const socket = spyOn(narratorWSManager, "getConnectionCredentialIdentity").mockImplementation(
			() => socketIdentity,
		);
		const credential = spyOn(narratorWSManager, "getCredentialIdentity").mockReturnValue(2);
		restores.push(
			() => socket.mockRestore(),
			() => credential.mockRestore(),
		);
		await render();
		await event({
			type: "quota_balance",
			quotaBalance: "accepted",
			detailedQuotaBalance: "accepted detail",
		});
		const balance = current.quotaBalance;
		const detail = current.detailedQuotaBalance;
		domain.cached.mockClear();
		const invalidate = spyOn(qc, "invalidateQueries");
		restores.push(() => invalidate.mockRestore());
		socketIdentity = 1;
		await event({
			type: "quota_balance",
			quotaBalance: "stale credential",
			detailedQuotaBalance: "stale detail",
		});
		expect(current.quotaBalance).toBe(balance);
		expect(current.detailedQuotaBalance).toBe(detail);
		expect(invalidate).not.toHaveBeenCalled();
		expect(domain.cached).not.toHaveBeenCalled();
		expect(domain.aggregate).not.toHaveBeenCalled();
		expect(domain.rpc).not.toHaveBeenCalled();
	});

	test("a legacy caller without a provider generation does not add quota reads on a push", async () => {
		const authGeneration = setToken("quota-token");
		nugProvider = { id: "nug-current" };
		const domain = quotaDomainSpies();
		activeOtherIdentity("nug-current", 7, authGeneration);
		await render();
		const initialReads = domain.cached.mock.calls.length;
		await event({ type: "quota_balance", quotaBalance: "legacy push" });
		expect(current.quotaBalance).toBe("legacy push");
		expect(domain.cached).toHaveBeenCalledTimes(initialReads);
		expect(domain.aggregate).not.toHaveBeenCalled();
		expect(domain.rpc).not.toHaveBeenCalled();
	});
});

describe("pushed custom API quota precedence with the real WS hook", () => {
	test("a live push replaces the subscription and survives subsequent auto-balance polling", async () => {
		quotaProviderId = "p1";
		const snapshot = subscriptionSnapshot();
		balanceSnapshot = snapshot;
		qc.setQueryData(["settings"], { customApiQuotas: {} });
		await render();
		expect<ProviderBalanceSnapshot | null>(quotaDisplay.subscriptionSnapshot).toBe(snapshot);
		expect(current.quotaBalance).toBeNull();

		const pushed = {
			quotaBalance: "站点额度 75%",
			detailedQuotaBalance: "专用套餐\n日 USD 0.004\n周 USD 1",
		};
		await event({ type: "quota_balance", ...pushed });
		expect(quotaDisplay.subscriptionSnapshot).toBeNull();
		expect(current.quotaBalance).toBe(pushed.quotaBalance);
		expect(current.detailedQuotaBalance).toBe(pushed.detailedQuotaBalance);
		expect(qc.getQueryData<QuotaSettings>(["settings"])?.customApiQuotas.p1).toMatchObject(pushed);

		balanceSnapshot = { ...snapshot, fetchedAt: 2 };
		await render();
		expect(quotaDisplay.subscriptionSnapshot).toBeNull();
		expect(current.quotaBalance).toBe(pushed.quotaBalance);
		expect(current.detailedQuotaBalance).toBe(pushed.detailedQuotaBalance);

		await event({ type: "quota_balance", quotaBalance: "0", detailedQuotaBalance: "已耗尽" });
		expect(quotaDisplay.subscriptionSnapshot).toBeNull();
		expect(current.quotaBalance).toBe("0");
		expect(current.detailedQuotaBalance).toBe("已耗尽");

		await event({ type: "quota_balance", quotaBalance: null, detailedQuotaBalance: null });
		expect<ProviderBalanceSnapshot | null>(quotaDisplay.subscriptionSnapshot).toBe(balanceSnapshot);
		expect(current.quotaBalance).toBeNull();
		expect(current.detailedQuotaBalance).toBeNull();
	});

	test("cached pushes win on mount and never leak when switching providers", async () => {
		quotaProviderId = "p1";
		balanceSnapshot = subscriptionSnapshot();
		const pushed = {
			quotaBalance: "Cached site plan",
			detailedQuotaBalance: "Cached site details",
		};
		qc.setQueryData(["settings"], { customApiQuotas: { p1: pushed } });
		await render();
		expect(quotaDisplay.subscriptionSnapshot).toBeNull();
		expect(current.quotaBalance).toBe(pushed.quotaBalance);
		expect(current.detailedQuotaBalance).toBe(pushed.detailedQuotaBalance);

		quotaProviderId = "p2";
		await render();
		expect<ProviderBalanceSnapshot | null>(quotaDisplay.subscriptionSnapshot).toBe(balanceSnapshot);
		expect(current.quotaBalance).toBeNull();
		expect(current.detailedQuotaBalance).toBeNull();

		quotaProviderId = "p1";
		await render();
		expect(quotaDisplay.subscriptionSnapshot).toBeNull();
		expect(current.quotaBalance).toBe(pushed.quotaBalance);
		expect(current.detailedQuotaBalance).toBe(pushed.detailedQuotaBalance);
	});
});

describe("quota isolation between a main agent and its subagent side by side", () => {
	test("a subagent's quota frame never reaches this panel's balance or its provider cache", async () => {
		quotaProviderId = "p1";
		qc.setQueryData(["settings"], { customApiQuotas: {} });
		await render();
		expect(current.quotaBalance).toBeNull();

		await event({
			type: "quota_balance",
			quotaBalance: "subagent balance",
			detailedQuotaBalance: "subagent details",
			isSubagent: true,
		});

		expect(current.quotaBalance).toBeNull();
		expect(current.detailedQuotaBalance).toBeNull();
		expect(qc.getQueryData<QuotaSettings>(["settings"])?.customApiQuotas.p1).toBeUndefined();
	});

	test("a subagent's payment_required never arms this panel's recharge state", async () => {
		quotaProviderId = "p1";
		qc.setQueryData(["settings"], { customApiQuotas: {} });
		await render();

		await event({
			type: "payment_required",
			providerId: "p1",
			balance: 0,
			required: 5,
			resumeAction: "retry",
			isSubagent: true,
		});

		expect(current.paymentRequired).toBeNull();
	});
});

describe("event-driven panel control plane", () => {
	test("online waiting has no permission timer for sixty simulated seconds; offline/hidden recovery is bounded", async () => {
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
		const intervals = new Map<number, () => void>();
		let nextId = 0;
		const fakeInterval = ((callback: Parameters<typeof setInterval>[0], delay?: number) => {
			expect(delay).toBe(5000);
			intervals.set(++nextId, callback as () => void);
			return nextId as unknown as ReturnType<typeof setInterval>;
		}) as typeof setInterval;
		const interval = spyOn(globalThis, "setInterval").mockImplementation(fakeInterval);
		const clear = spyOn(globalThis, "clearInterval").mockImplementation((id) => {
			intervals.delete(id as unknown as number);
		});
		restores.push(
			() => interval.mockRestore(),
			() => clear.mockRestore(),
		);
		const tick = () =>
			act(async () => {
				for (const callback of intervals.values()) callback();
			});
		connected = true;
		await render();
		for (let seconds = 0; seconds < 60; seconds += 5) await tick();
		expect(intervals.size).toBe(0);
		expect(panelSpy).toHaveBeenCalledTimes(1);
		await connection(false);
		expect(intervals.size).toBe(1);
		expect(panelSpy).toHaveBeenCalledTimes(1);
		await tick();
		expect(panelSpy).toHaveBeenCalledTimes(2);
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
		await act(async () => document.dispatchEvent(new window.Event("visibilitychange")));
		expect(intervals.size).toBe(0);
		await tick();
		expect(panelSpy).toHaveBeenCalledTimes(2);
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
		await act(async () => document.dispatchEvent(new window.Event("visibilitychange")));
		expect(intervals.size).toBe(1);
		await connection(true);
		expect(intervals.size).toBe(0);
		expect(panelSpy).toHaveBeenCalledTimes(3);
	});

	test("foreground control-plane recovery starts one fresh reconciliation", async () => {
		connected = true;
		await render();
		panelSpy.mockResolvedValue(page(permissions(1)));
		await act(async () => {
			for (const recover of recoveries) recover();
		});
		expect(panelSpy).toHaveBeenCalledTimes(2);
		expect(panelSpy.mock.calls[1]?.[1]?.fresh).toBe(true);
		expect(current.pendingPermissions).toHaveLength(1);
	});

	test("complete status patches clear errors and preserve unrelated fields without refetching detail or children", async () => {
		connected = true;
		observeDetails = true;
		qc.setQueryData(["narrators", "n1"], {
			id: "n1",
			status: "waiting",
			model: "keep-model",
			errorMessage: "old error",
			errorRetryable: true,
			archivedWithNarratorId: "old",
			updatedAt: "old-time",
			messageCount: 1,
		});
		await render();
		const baseline = detailReads;
		const frame = {
			type: "status_change",
			status: "idle",
			substatus: [],
			turnStartedAt: null,
			updatedAt: "committed-time",
			messageCount: 17,
			errorMessage: null,
			errorRetryable: null,
			archivedWithNarratorId: null,
			backgroundWorkActive: false,
		};
		await event(frame);
		await event(frame);
		expect(qc.getQueryData(["narrators", "n1"])).toMatchObject({
			status: "idle",
			model: "keep-model",
			errorMessage: null,
			errorRetryable: null,
			archivedWithNarratorId: null,
			turnStartedAt: null,
			updatedAt: "committed-time",
			messageCount: 17,
			backgroundWorkActive: false,
		});
		// The work-active hint is optional even in an authoritative persisted snapshot.
		await event({
			type: "status_change",
			status: "archived",
			substatus: [],
			turnStartedAt: null,
			updatedAt: "archive-time",
			errorMessage: null,
			errorRetryable: null,
			archivedWithNarratorId: "parent",
		});
		expect(qc.getQueryData(["narrators", "n1"])).toMatchObject({
			status: "archived",
			updatedAt: "archive-time",
			archivedWithNarratorId: "parent",
			model: "keep-model",
		});
		expect(detailReads).toBe(baseline);
		expect(childReads).toBe(1);
	});

	test("sparse status noise does not read; a legacy lifecycle edge recovers detail exactly once", async () => {
		connected = true;
		observeDetails = true;
		qc.setQueryData(["narrators", "n1"], { id: "n1", status: "waiting", model: "keep" });
		await render();
		const baseline = detailReads;
		for (const status of ["working", "waiting", "waiting", "working"])
			await event({ type: "status_change", status });
		expect(detailReads).toBe(baseline);
		await event({ type: "status_change", status: "idle" });
		await event({ type: "status_change", status: "idle" });
		expect(detailReads).toBe(baseline + 1);
		expect(childReads).toBe(1);
	});

	test("sparse subagent statuses merge labels and recover only real lifecycle boundaries", async () => {
		connected = true;
		observeDetails = true;
		observedDetailId = "child";
		qc.setQueryData(["narrators", "child"], { id: "child", status: "working", model: "keep" });
		await render();
		const baseline = detailReads;
		for (const status of ["working", "waiting", "waiting", "working"])
			await event({
				type: "subagent_status_changed",
				subagentNarratorId: "child",
				status,
				substatus: ["reasoning"],
			});
		expect(detailReads).toBe(baseline);
		expect(qc.getQueryData(["narrators", "child"])).toMatchObject({
			model: "keep",
			substatus: ["reasoning"],
		});
		await event({
			type: "subagent_status_changed",
			subagentNarratorId: "child",
			status: "idle",
			substatus: [],
		});
		await event({ type: "subagent_status_changed", subagentNarratorId: "child", status: "idle" });
		expect(detailReads).toBe(baseline + 1);
		expect(childReads).toBe(1);
		await event({
			type: "subagent_status_changed",
			subagentNarratorId: "uncached",
			status: "idle",
		});
		expect(qc.getQueryData(["narrators", "uncached"])).toBeUndefined();
	});

	test("a sparse status never creates a fake complete narrator cache", async () => {
		connected = true;
		await render();
		await event({ type: "status_change", status: "working" });
		expect(qc.getQueryData(["narrators", "n1"])).toBeUndefined();
	});
});

describe("mounted panel and real WS hook reconciliation", () => {
	test("mounting on an already connected socket starts one initial mount-scoped read", async () => {
		connected = true;
		panelSpy.mockResolvedValue(page(permissions(1)));
		await render();
		expect(panelSpy).toHaveBeenCalledTimes(1);
		expect(panelSpy.mock.calls[0]?.[1]?.fresh).toBe(false);
		expect(current.pendingPermissions.map((item) => item.id)).toEqual(["p0"]);
	});

	test("online initial transport failure retries with a budget and stops after restoring permissions", async () => {
		connected = true;
		panelSpy
			.mockRejectedValueOnce(new ApiError("temporarily unavailable", 503))
			.mockResolvedValue(page(permissions(1)));
		const pending = spyOn(api, "getPendingPermissions").mockRejectedValue(new TypeError("offline"));
		const buffer = spyOn(api, "getBufferedMessages").mockRejectedValue(new TypeError("offline"));
		restores.push(
			() => pending.mockRestore(),
			() => buffer.mockRestore(),
		);
		await render();
		expect(panelSpy).toHaveBeenCalledTimes(1);
		await retryTick();
		expect(panelSpy).toHaveBeenCalledTimes(2);
		expect(current.pendingPermissions.map((permission) => permission.id)).toEqual(["p0"]);
		await retryTick();
		expect(panelSpy).toHaveBeenCalledTimes(2);
	});

	test("raw disconnect/reconnect batched in one act still starts a fresh read", async () => {
		connected = true;
		await render();
		const readScope = current.readScope;
		expect(panelSpy).toHaveBeenCalledTimes(1);
		await act(async () => {
			connected = false;
			for (const update of connections) update(false, false);
			connected = true;
			for (const update of connections) update(true, true);
		});
		expect(panelSpy).toHaveBeenCalledTimes(2);
		expect(panelSpy.mock.calls[1]?.[1]).toMatchObject({ fresh: true, readScope });
	});

	test("first connect removes permissions and buffer consumed during the disconnected REST-to-WS gap", async () => {
		narratorStatus = "running";
		panelSpy.mockResolvedValueOnce(
			page(permissions(1), {
				buffer: [{ id: "queued", text: "old", bufferedAt: "t", imageCount: 0 }],
			}),
		);
		await render();
		expect(current.pendingPermissions.map((item) => item.id)).toEqual(["p0"]);
		expect(current.queuedMessages.map((item) => item.id)).toEqual(["queued"]);
		// Another client resolves/consumes while there is no live event delivery.
		await connection(true);
		expect(panelSpy).toHaveBeenCalledTimes(2);
		expect(panelSpy.mock.calls[1]?.[1]?.fresh).toBe(true);
		expect(current.pendingPermissions).toEqual([]);
		expect(current.queuedMessages).toEqual([]);
	});

	test("approval during deferred second page automatically restarts and collects the unseen eight permissions", async () => {
		const second = deferred<NarratorPanelStateResponse>();
		let fresh = false;
		panelSpy.mockImplementation(async (_id, options) => {
			if (options?.fresh) fresh = true;
			if (fresh)
				return options?.permissionsCursor
					? page(permissions(8, 32))
					: page(permissions(31, 1), {
							hasMore: { permissions: true, buffer: false },
							nextCursor: { permissions: "fresh-next" },
						});
			return options?.permissionsCursor
				? cancelable(second.promise, options.signal)
				: page(permissions(32), {
						hasMore: { permissions: true, buffer: false },
						nextCursor: { permissions: "initial-next" },
					});
		});
		await render();
		expect(current.pendingPermissions).toHaveLength(32);
		await event({ type: "permission_resolved", requestId: "p0", decision: "allow" });
		expect(current.pendingPermissions).toHaveLength(31);
		await act(async () => second.resolve(page(permissions(8, 32))));
		await retryTick();
		expect(panelSpy.mock.calls.some((call) => call[1]?.fresh)).toBe(true);
		expect(current.pendingPermissions.map((item) => item.id)).toEqual(
			permissions(39, 1).map((item) => item.id),
		);
		expect(current.pendingPermissions.some((item) => item.id === "p0")).toBe(false);
	});

	test("event bursts coalesce to one fresh restart, and fresh reads still retain tombstones", async () => {
		const second = deferred<NarratorPanelStateResponse>();
		let fresh = false;
		panelSpy.mockImplementation(async (_id, options) => {
			if (options?.fresh) fresh = true;
			if (fresh) return page(permissions(40)); // Even a stale server row cannot resurrect an approved id.
			return options?.permissionsCursor
				? cancelable(second.promise, options.signal)
				: page(permissions(32), {
						hasMore: { permissions: true, buffer: false },
						nextCursor: { permissions: "next" },
					});
		});
		await render();
		for (const item of permissions(3))
			await event({ type: "permission_resolved", requestId: item.id });
		await retryTick();
		expect(panelSpy.mock.calls.filter((call) => call[1]?.fresh)).toHaveLength(1);
		expect(current.pendingPermissions.map((item) => item.id)).toEqual(
			permissions(37, 3).map((item) => item.id),
		);
		second.resolve(page(permissions(8, 32)));
	});

	for (const switchKind of ["account", "narrator"] as const) {
		test(`a queued restart cannot reconcile the old ${switchKind} lifecycle`, async () => {
			const second = deferred<NarratorPanelStateResponse>();
			panelSpy.mockImplementation(async (_id, options: NarratorPanelStateOptions = {}) =>
				options.permissionsCursor
					? cancelable(second.promise, options.signal)
					: page(permissions(32), {
							hasMore: { permissions: true, buffer: false },
							nextCursor: { permissions: "next" },
						}),
			);
			await render();
			await event({ type: "permission_resolved", requestId: "p0" });
			panelSpy.mockResolvedValue(page([]));
			if (switchKind === "account") await act(async () => bindUser("other-token", "u2"));
			else {
				narratorId = "n2";
				await render();
			}
			const callsAfterSwitch = panelSpy.mock.calls.length;
			await retryTick();
			expect(panelSpy.mock.calls.length).toBe(callsAfterSwitch);
			expect(current.pendingPermissions).toEqual([]);
			second.resolve(page(permissions(8, 32)));
		});
	}
});

describe("plan reflection handover with the real WS hook", () => {
	for (const child of [false, true]) {
		for (const stoppedFirst of [true, false]) {
			test(`${child ? "child" : "primary"}: ${stoppedFirst ? "handover then permission" : "late handover"} uses only the durable approval id`, async () => {
				connected = true;
				const unrelated = permissions(1);
				panelSpy.mockResolvedValue(page(unrelated));
				await render();
				const routing = {
					ownerNarratorId: child ? "child-narrator" : narratorId,
					...(child ? { subagentNarratorId: "child-narrator", parentToolUseId: "agent-call" } : {}),
				};
				const permission: PendingPermission = {
					id: "durable-plan-call",
					toolUseId: "plan-tool-use",
					toolName: "ExitPlanMode",
					inputJson: { mode: "outline" },
					...routing,
				};
				const stopped = {
					type: "plan_reflection_stopped",
					requestId: "exit_plan_synthetic",
					toolUseId: permission.toolUseId,
					toolName: permission.toolName,
					inputJson: permission.inputJson,
					...routing,
				};
				if (stoppedFirst) {
					await event(stopped);
					// A stopped reflection is not an approval request, even with outline input.
					expect(current.pendingPermissions).toEqual(unrelated);
					expect(findPendingForKey("tool-plan-tool-use", current.pendingPermissions)).toBeNull();
				}
				panelSpy.mockResolvedValue(page([...unrelated, permission]));
				await event({ type: "permission_request", request: permission });
				await event(stopped); // A late/repeated handover must not recreate a synthetic gate.
				expect(current.pendingPermissions).toEqual([...unrelated, permission]);
				expect(findPendingForKey("tool-plan-tool-use", current.pendingPermissions)).toEqual(
					permission,
				);
				await event({ type: "plan_reflection_resolved", requestId: stopped.requestId });
				expect(current.pendingPermissions).toEqual([...unrelated, permission]);
				await event({ type: "permission_resolved", requestId: permission.id, decision: "allow" });
				expect(current.pendingPermissions).toEqual(unrelated);
			});
		}
	}

	test("handover refreshes the panel snapshot when the permission event is missed", async () => {
		connected = true;
		await render();
		const permission: PendingPermission = {
			id: "durable-plan-call",
			toolUseId: "plan-tool-use",
			toolName: "ExitPlanMode",
			inputJson: { mode: "outline" },
		};
		panelSpy.mockResolvedValue(page([permission]));
		await event({
			type: "plan_reflection_stopped",
			requestId: "exit_plan_synthetic",
			toolUseId: permission.toolUseId,
			toolName: permission.toolName,
			inputJson: permission.inputJson,
		});
		expect(current.pendingPermissions).toEqual([]);
		await retryTick();
		expect(panelSpy).toHaveBeenCalledTimes(2);
		expect(panelSpy.mock.calls[1]?.[1]?.fresh).toBe(true);
		expect(current.pendingPermissions).toEqual([permission]);
	});

	test("reconnect restores the durable request when its permission event was missed", async () => {
		connected = true;
		await render();
		await event({
			type: "plan_reflection_stopped",
			requestId: "exit_plan_synthetic",
			toolUseId: "plan-tool-use",
			toolName: "ExitPlanMode",
			inputJson: { mode: "outline" },
		});
		expect(current.pendingPermissions).toEqual([]);
		const permission: PendingPermission = {
			id: "durable-plan-call",
			toolUseId: "plan-tool-use",
			toolName: "ExitPlanMode",
			inputJson: { mode: "outline" },
			suggestions: [
				{ type: "plan_reflection", status: "awaiting_user", requestId: "exit_plan_synthetic" },
			],
		};
		await connection(false);
		panelSpy.mockResolvedValue(page([permission]));
		await connection(true);
		expect(findPendingForKey("tool-plan-tool-use", current.pendingPermissions)?.id).toBe(
			permission.id,
		);
		expect(current.pendingPermissions).toEqual([permission]);
	});
});
