import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { api } from "@frontend/lib/api";
import type {
	NarratorPanelStateOptions,
	NarratorPanelStateResponse,
} from "@frontend/lib/api/narrators";
import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import type { PendingPermission } from "@frontend/types/narrator";
import { notifications } from "@mantine/notifications";
import type { QuotaSnapshotsResponse } from "@shared/quota-snapshot";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { quotaSnapshotsKey } from "../../hooks/useQuotaSnapshots";
import { type UseNarratorPanelWSReturn, useNarratorPanelWS } from "./useNarratorPanelWS";
import { findPendingForKey } from "./vlist/vlist-permission-match";

let quotaProviderId: string | null = null;
const quotaData: QuotaSnapshotsResponse = {
	entries: [
		{
			groupId: "p1",
			prefix: "provider",
			templateId: "custom",
			credentialId: "key1",
			source: "probe",
			snapshot: {
				fetchedAt: 1,
				scope: "subscription",
				windows: [{ kind: "weekly", usedRatio: 0.2, resetsAt: null }],
				balances: [],
			},
		},
	],
};

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
	return null;
}
function QuotaHarness() {
	current = useNarratorPanelWS({
		narratorId,
		narratorStatus,
		isAtBottomRef: { current: true },
		quotaProviderKey: quotaProviderId,
	});
	return null;
}
const render = () =>
	act(async () =>
		root.render(
			<QueryClientProvider client={qc}>
				<I18nextProvider i18n={instance}>
					{quotaProviderId ? <QuotaHarness /> : <Harness />}
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

beforeEach(async () => {
	const { window } = parseHTML("<html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		localStorage: { getItem: () => null },
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
	connected = false;
	listeners.clear();
	connections.clear();
	notifyManager.setScheduler(queueMicrotask);
	qc = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
	});
	qc.setQueryData(["auth", "me"], { id: "u1" });
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

describe("shared quota snapshots with the real WS hook", () => {
	test("quota pushes invalidate snapshots without injecting unscoped text or writing legacy caches", async () => {
		quotaProviderId = "p1";
		const settings = { customApiQuotas: {} };
		const nug = { p1: { balance: 3 } };
		qc.setQueryData(["settings"], settings);
		qc.setQueryData(["admin", "settings"], settings);
		qc.setQueryData(["nug", "quotas"], nug);
		qc.setQueryData(quotaSnapshotsKey, quotaData);
		const invalidate = spyOn(qc, "invalidateQueries");
		await render();
		await event({
			type: "quota_balance",
			quotaBalance: "75%",
			detailedQuotaBalance: "private upstream text",
		});
		expect(invalidate).toHaveBeenCalledWith({ queryKey: quotaSnapshotsKey });
		expect(qc.getQueryState(quotaSnapshotsKey)?.isInvalidated).toBe(true);
		expect(qc.getQueryData(quotaSnapshotsKey)).toEqual(quotaData);
		expect(qc.getQueryData(["settings"])).toEqual(settings);
		expect(qc.getQueryData(["admin", "settings"])).toEqual(settings);
		expect(qc.getQueryData(["nug", "quotas"])).toEqual(nug);
		invalidate.mockRestore();
	});

	test("null pushes still re-read snapshots, never erase the credential probe", async () => {
		qc.setQueryData(quotaSnapshotsKey, quotaData);
		await render();
		await event({ type: "quota_balance", quotaBalance: null, detailedQuotaBalance: null });
		expect(qc.getQueryState(quotaSnapshotsKey)?.isInvalidated).toBe(true);
		expect(qc.getQueryData(quotaSnapshotsKey)).toEqual(quotaData);
	});

	test("a subagent's quota frame never invalidates this panel's snapshot", async () => {
		qc.setQueryData(quotaSnapshotsKey, quotaData);
		await render();
		await event({
			type: "quota_balance",
			quotaBalance: "subagent balance",
			detailedQuotaBalance: "subagent details",
			isSubagent: true,
		});
		expect(qc.getQueryState(quotaSnapshotsKey)?.isInvalidated).toBe(false);
		expect(qc.getQueryData(quotaSnapshotsKey)).toEqual(quotaData);
	});

	test("a subagent's payment_required never arms this panel's recharge state", async () => {
		quotaProviderId = "p1";
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

	test("payment-required still arms recharge and resets when the provider changes", async () => {
		quotaProviderId = "p1";
		await render();
		await event({
			type: "payment_required",
			providerId: "p1",
			balance: 0,
			required: 5,
			resumeAction: "continue",
		});
		expect(current.paymentRequired).toMatchObject({
			providerId: "p1",
			balance: 0,
			required: 5,
			resumeAction: "continue",
		});
		quotaProviderId = "p2";
		await render();
		expect(current.paymentRequired).toBeNull();
	});
});

describe("mounted panel and real WS hook reconciliation", () => {
	test("mounting on an already connected socket still starts a fresh post-subscription read", async () => {
		connected = true;
		panelSpy.mockResolvedValue(page(permissions(1)));
		await render();
		expect(panelSpy).toHaveBeenCalledTimes(1);
		expect(panelSpy.mock.calls[0]?.[1]?.fresh).toBe(true);
		expect(current.pendingPermissions.map((item) => item.id)).toEqual(["p0"]);
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
			if (switchKind === "account")
				await act(async () => qc.setQueryData(["auth", "me"], { id: "u2" }));
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
