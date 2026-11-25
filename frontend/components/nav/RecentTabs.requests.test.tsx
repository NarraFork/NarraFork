import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import type { RecentTab } from "../../hooks/recent-tabs-utils";
import {
	RECENT_TABS_QUERY_KEY,
	type RecentTabsInfiniteData,
	recentTabsSectionQueryKey,
} from "../../hooks/useRecentTabs";
import { api } from "../../lib/api";
import { appearanceStore } from "../../lib/appearance-preference-store";
import * as favicon from "../../lib/favicon";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import { clearNotifiedAttention } from "../../lib/notification";
import * as sound from "../../lib/notification-sound";
import commonEn from "../../locales/en/common.json";
import { RecentTabDetails } from "./RecentTabDetailCard";
import { RecentTabsWSProvider } from "./RecentTabs";

const fixtureUser = "recent-tabs-fixture-user";
const fixtureToken = "recent-tabs-fixture-token";
const preferencesKey = ["user-preferences", "ui", fixtureUser, fixtureToken] as const;
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { nav: {} } } });

type RuntimeResult = Awaited<ReturnType<typeof api.getRecentTabsRuntime>>;
type RuntimeRequest = {
	keys: string[];
	signal?: AbortSignal;
	resolve: (result: RuntimeResult) => void;
	reject: (error: Error) => void;
};
const tab = (id: string): RecentTab => ({
	type: "narrator",
	id,
	title: id,
	status: "idle",
	lastVisitedAt: 1,
});
const page = (items: RecentTab[]) => ({
	items,
	revision: 0,
	hasMore: false,
	nextCursor: undefined,
});
const workKey = recentTabsSectionQueryKey("work");
let root: Root;
let client: QueryClient;
let restoreDom: () => void;
let frame: FrameRequestCallback | undefined;
let onListEvent: (event: Record<string, unknown>) => void;
let onConnection: (connected: boolean, isReconnect: boolean) => void;
let runtimeRequests: RuntimeRequest[];
let workTabs: RecentTab[];
let browserNotifications = 0;

function setTabs(tabs: RecentTab[]) {
	workTabs = tabs;
	client.setQueryData<RecentTabsInfiniteData>(workKey, {
		pages: [page(tabs)],
		pageParams: [undefined],
	});
}

async function mount(tabs = [tab("a"), tab("b")]) {
	setTabs(tabs);
	const router = createRouter({
		routeTree: createRootRoute(),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<I18nextProvider i18n={i18n}>
					<RouterContextProvider router={router}>
						<RecentTabsWSProvider />
					</RouterContextProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		);
	});
}

function cachedTab(id: string) {
	return client
		.getQueryData<RecentTabsInfiniteData>(workKey)
		?.pages[0]?.items.find((item) => item.id === id);
}

async function resolveRuntime(index: number, patches: RuntimeResult["patches"] = []) {
	await act(async () => runtimeRequests[index]?.resolve({ revision: 0, patches }));
}

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><head></head><body><div></div></body></html>");
	Object.defineProperty(window.document, "visibilityState", { value: "visible" });
	Object.defineProperty(window.document, "hasFocus", { value: () => false });
	browserNotifications = 0;
	clearNotifiedAttention();
	class NotificationStub {
		static permission = "granted";
		constructor() {
			browserNotifications++;
		}
	}
	const storage = new Map([["narrafork_token", fixtureToken]]);
	const globals = {
		localStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		},
		Notification: NotificationStub,
		window,
		document: window.document,
		navigator: window.navigator,
		IS_REACT_ACT_ENVIRONMENT: true,
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			frame = callback;
			return 1;
		},
		cancelAnimationFrame: () => {
			frame = undefined;
		},
	};
	const originals = Object.keys(globals).map(
		(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
	);
	for (const [key, value] of Object.entries(globals))
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	appearanceStore.activate(null, true);
	restoreDom = () => {
		appearanceStore.activate(null, true);
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	frame = undefined;
	runtimeRequests = [];
	notifyManager.setScheduler(queueMicrotask);
	spyOn(api, "getRecentTabsRuntime").mockImplementation(
		(keys, signal) =>
			new Promise<RuntimeResult>((resolve, reject) => {
				// Deliberately allow a response after cancellation.
				runtimeRequests.push({ keys, signal, resolve, reject });
			}),
	);
	spyOn(api, "getRecentTabsPage").mockImplementation(async (section) =>
		page(section === "work" ? workTabs : []),
	);
	spyOn(narratorWSManager, "addListener").mockImplementation((options, callback) => {
		if (options.narratorIds === "*") onListEvent = callback;
		return { _id: 1 };
	});
	spyOn(narratorWSManager, "removeListener").mockImplementation(() => {});
	spyOn(narratorWSManager, "subscribe").mockImplementation((ids) => ({
		_id: 1,
		_narratorIds: ids,
		_kind: "list",
	}));
	spyOn(narratorWSManager, "updateSubscription").mockImplementation(() => {});
	spyOn(narratorWSManager, "unsubscribe").mockImplementation(() => {});
	spyOn(narratorWSManager, "onConnectionChange").mockImplementation((callback) => {
		onConnection = callback;
		return () => {};
	});
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	client.setQueryData(["auth", "me"], { id: fixtureUser });
	client.setQueryData(preferencesKey, {});
	client.setQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("projects"), {
		pages: [page([])],
		pageParams: [undefined],
	});
	root = createRoot(document.createElement("div"));
});

afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	notifyManager.setScheduler((callback) => setTimeout(callback, 0));
	mock.restore();
	restoreDom();
});

const statusFrame = (revision: number, extra: Record<string, unknown> = {}) => ({
	type: "status_change",
	narratorId: "a",
	status: "idle",
	substatus: ["unread"],
	turnStartedAt: "turn-1",
	statusEpoch: "server-a",
	statusRevision: revision,
	...extra,
});
function notificationObservers() {
	client.setQueryData(preferencesKey, {
		notifyOnDone: true,
		notifyOnWaiting: true,
		notifyPwaEnabled: true,
		notifySoundEnabled: true,
	});
	const plays = spyOn(sound, "playNotificationSound").mockImplementation(() => {});
	const alerts = spyOn(favicon, "setFaviconAlert").mockImplementation(() => {});
	spyOn(favicon, "clearFaviconAlert").mockImplementation(() => {});
	return { plays, alerts };
}

test.each([
	"status_change",
	"status_notification",
])("state-only rev2 then late %s rev1 notifies once without rolling cache or favicon back", async (type) => {
	const { plays, alerts } = notificationObservers();
	await mount([tab("a")]);
	await act(async () => {
		onListEvent(statusFrame(2, { type: "substatus_change", substatus: ["unread", "rev2"] }));
		frame?.(0);
	});
	expect(cachedTab("a")).toMatchObject({ status: "idle", substatus: ["unread", "rev2"] });
	expect(plays).not.toHaveBeenCalled();
	expect(browserNotifications).toBe(0);
	expect(alerts).toHaveBeenCalledTimes(1);
	const before = client.getQueryData(workKey);
	await act(async () => {
		onListEvent(statusFrame(1, { type, substatus: ["unread", "rev1"] }));
		onListEvent(statusFrame(1, { type, substatus: ["unread", "rev1"] }));
	});
	expect(plays).toHaveBeenCalledTimes(1);
	expect(browserNotifications).toBe(1);
	expect(alerts).toHaveBeenCalledTimes(1);
	expect(client.getQueryData(workKey)).toBe(before);
	expect(cachedTab("a")).toMatchObject({ substatus: ["unread", "rev2"] });
});

test("late notification uses the original done's background-work flag, not newer state-only hints", async () => {
	const { plays } = notificationObservers();
	await mount([tab("a")]);
	await act(async () => {
		onListEvent(statusFrame(2, { type: "substatus_change", backgroundWorkActive: true }));
		onListEvent(statusFrame(1, { type: "status_notification", backgroundWorkActive: true }));
	});
	expect(plays).not.toHaveBeenCalled();
	expect(browserNotifications).toBe(0);
	await act(async () =>
		onListEvent(statusFrame(1, { type: "status_notification", backgroundWorkActive: false })),
	);
	expect(plays).toHaveBeenCalledTimes(1);
	expect(browserNotifications).toBe(1);
});

test.each([
	{ status: "working", substatus: [] },
	{ status: "idle", substatus: ["unread"], turnStartedAt: "turn-2" },
	{ status: "idle", substatus: [] },
])("new accepted state %j rejects a prior done intent", async (latest) => {
	const { plays } = notificationObservers();
	spyOn(api, "moveRecentTab").mockResolvedValue({
		changed: false,
		baseRevision: 0,
		revision: 0,
		operations: [],
	});
	await mount([tab("a")]);
	await act(async () => {
		onListEvent(statusFrame(2, { type: "substatus_change" }));
		onListEvent(statusFrame(3, { type: "substatus_change", ...latest }));
		frame?.(0);
	});
	const before = client.getQueryData(workKey);
	await act(async () => onListEvent(statusFrame(1, { type: "status_notification" })));
	expect(plays).not.toHaveBeenCalled();
	expect(browserNotifications).toBe(0);
	expect(client.getQueryData(workKey)).toBe(before);
});

test("display reorder keeps the in-flight runtime read and the new WS subscription order", async () => {
	await mount();
	await act(async () => setTabs([tab("b"), tab("a")]));
	expect(runtimeRequests.map(({ keys }) => keys)).toEqual([["narrator:a", "narrator:b"]]);
	expect(runtimeRequests[0]?.signal?.aborted).toBe(false);
	expect(client.getQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY)?.map(({ id }) => id)).toEqual([
		"b",
		"a",
	]);
	expect(narratorWSManager.updateSubscription).toHaveBeenLastCalledWith(expect.anything(), [
		"b",
		"a",
	]);
	await resolveRuntime(0, [{ key: "narrator:a", patch: { title: "runtime" } }]);
	expect(cachedTab("a")?.title).toBe("runtime");
	expect(runtimeRequests).toHaveLength(1);
});

test("a runtime snapshot keeps newer WS fields and applies untouched fields", async () => {
	await mount([tab("a")]);
	await act(async () => {
		onListEvent({ type: "title_updated", narratorId: "a", title: "live" });
		onListEvent({ type: "draft_changed", narratorId: "a", hasDraft: true });
		frame?.(0);
	});
	expect(cachedTab("a")).toMatchObject({ title: "live", hasDraft: true });
	await resolveRuntime(0, [
		{ key: "narrator:a", patch: { title: "stale", hasDraft: false, activeTerminalCount: 2 } },
	]);
	expect(cachedTab("a")).toMatchObject({ title: "live", hasDraft: true, activeTerminalCount: 2 });
});

test("membership changes abort and replace the read before a late response can overwrite it", async () => {
	await mount();
	await act(async () => setTabs([tab("b"), tab("c")]));
	expect(runtimeRequests.map(({ keys }) => keys)).toEqual([
		["narrator:a", "narrator:b"],
		["narrator:b", "narrator:c"],
	]);
	expect(runtimeRequests[0]?.signal?.aborted).toBe(true);
	expect(runtimeRequests[1]?.signal?.aborted).toBe(false);
	await resolveRuntime(1, [{ key: "narrator:b", patch: { title: "current" } }]);
	expect(cachedTab("b")?.title).toBe("current");
	await resolveRuntime(0, [{ key: "narrator:b", patch: { title: "obsolete" } }]);
	expect(cachedTab("b")?.title).toBe("current");
	expect(runtimeRequests).toHaveLength(2);
});

test("replayed working events do not repeat a tab promotion", async () => {
	const move = spyOn(api, "moveRecentTab").mockResolvedValue({
		changed: false,
		baseRevision: 0,
		revision: 0,
		operations: [],
	});
	await mount([tab("a")]);
	const status = (value: "idle" | "working") =>
		onListEvent({ type: "status_change", narratorId: "a", status: value });

	await act(async () => {
		status("working");
		status("working"); // The first patch is still waiting for the frame.
		frame?.(0);
		status("working"); // The cache updated, but React has not committed yet.
	});
	expect(move.mock.calls).toEqual([["narrator:a", { position: "above_idle" }]]);

	await act(async () => {
		status("idle");
		status("working");
	});
	expect(move).toHaveBeenCalledTimes(2);
});

test("repeated reconnects with unchanged membership queue exactly one runtime read", async () => {
	let now = 100_000;
	spyOn(Date, "now").mockImplementation(() => now);
	await mount([tab("a")]);
	for (let i = 0; i < 3; i++) {
		now += 6000; // Pass the reconnect throttle while the original request is still pending.
		await act(async () => onConnection(true, true));
	}
	expect(runtimeRequests).toHaveLength(1);
	await resolveRuntime(0);
	expect(runtimeRequests.map(({ keys }) => keys)).toEqual([["narrator:a"], ["narrator:a"]]);
	await resolveRuntime(1, [{ key: "narrator:a", patch: { title: "reconnected" } }]);
	expect(cachedTab("a")?.title).toBe("reconnected");
	expect(runtimeRequests).toHaveLength(2);
});

test("reordering targets during queued reconnects preserves one shared runtime read", async () => {
	let now = 100_000;
	spyOn(Date, "now").mockImplementation(() => now);
	await mount();
	for (const tabs of [
		[tab("b"), tab("a")],
		[tab("a"), tab("b")],
	]) {
		await act(async () => setTabs(tabs));
		now += 6000;
		await act(async () => onConnection(true, true));
	}
	expect(runtimeRequests).toHaveLength(1);
	expect(runtimeRequests[0]?.signal?.aborted).toBe(false);
	await resolveRuntime(0, [{ key: "narrator:a", patch: { title: "obsolete" } }]);
	expect(cachedTab("a")?.title).toBe("a");
	expect(runtimeRequests.map(({ keys }) => keys)).toEqual([
		["narrator:a", "narrator:b"],
		["narrator:a", "narrator:b"],
	]);
	await resolveRuntime(1, [{ key: "narrator:a", patch: { title: "fresh" } }]);
	expect(cachedTab("a")?.title).toBe("fresh");
	expect(runtimeRequests).toHaveLength(2);
});

test("empty membership cancels a queued refresh without starting another runtime read", async () => {
	let now = 100_000;
	spyOn(Date, "now").mockImplementation(() => now);
	await mount([]);
	await act(async () => onConnection(true, true));
	expect(runtimeRequests).toHaveLength(0);
	await act(async () => setTabs([tab("a")]));
	now += 6000;
	await act(async () => onConnection(true, true));
	await act(async () => setTabs([]));
	expect(runtimeRequests[0]?.signal?.aborted).toBe(true);
	await resolveRuntime(0);
	expect(runtimeRequests).toHaveLength(1);
	await act(async () => setTabs([tab("b")]));
	expect(runtimeRequests.map(({ keys }) => keys)).toEqual([["narrator:a"], ["narrator:b"]]);
});

test("a failed runtime read releases the shared slot without retrying until a new trigger", async () => {
	await mount([tab("a")]);
	await act(async () => runtimeRequests[0]?.reject(new Error("busy")));
	expect(runtimeRequests).toHaveLength(1);
	await act(async () => onConnection(true, true));
	expect(runtimeRequests.map(({ keys }) => keys)).toEqual([["narrator:a"], ["narrator:a"]]);
	await resolveRuntime(1, [{ key: "narrator:a", patch: { title: "recovered" } }]);
	expect(cachedTab("a")?.title).toBe("recovered");
	expect(runtimeRequests).toHaveLength(2);
});

test("a team tab follows its coordinator: title and status only, no promotion", async () => {
	const move = spyOn(api, "moveRecentTab").mockResolvedValue({
		changed: false,
		baseRevision: 0,
		revision: 0,
		operations: [],
	});
	const team: RecentTab = {
		type: "team",
		id: "coord",
		projectId: "p1",
		title: "Crew",
		pinned: true,
		lastVisitedAt: 1,
	};
	await mount([team, tab("a")]);
	// The coordinator is subscribed and its runtime is read under the team's own key.
	expect(narratorWSManager.subscribe).toHaveBeenLastCalledWith(["coord", "a"], { kind: "list" });
	expect(runtimeRequests[0]?.keys).toEqual(["narrator:a", "team:coord"]);
	await resolveRuntime(0, [
		{ key: "team:coord", patch: { status: "waiting", pendingApprovalCount: 2 } },
	]);
	expect(cachedTab("coord")).toMatchObject({ status: "waiting", pendingApprovalCount: 2 });

	await act(async () => {
		onListEvent({ type: "title_updated", narratorId: "coord", title: "Renamed crew" });
		onListEvent({ type: "draft_changed", narratorId: "coord", hasDraft: true });
		onListEvent({ type: "status_change", narratorId: "coord", status: "working" });
		frame?.(0);
	});
	const live = cachedTab("coord") as RecentTab | undefined;
	expect(live).toMatchObject({ title: "Renamed crew", status: "working" });
	expect(live?.hasDraft).toBeUndefined();
	// A session tab of the coordinator would be promoted; a pinned team is not a session.
	expect(move).not.toHaveBeenCalled();
});

test("a persisted project row gets its card details: runtime key, then a read when the card opens", async () => {
	const project: RecentTab = {
		type: "project",
		id: "p1",
		title: "Acme App",
		pinned: true,
		lastVisitedAt: 1,
	};
	await mount([project, tab("a")]);
	// No socket for a project, but its key is in the runtime request.
	expect(narratorWSManager.subscribe).toHaveBeenLastCalledWith(["a"], { kind: "list" });
	expect(runtimeRequests[0]?.keys).toEqual(["narrator:a", "project:p1"]);
	await resolveRuntime(0, [
		{
			key: "project:p1",
			patch: {
				projectPath: "/repos/acme-app",
				activeSessionCount: 3,
				waitingSessionCount: 1,
				teamCount: 2,
				projectCountsCapped: false,
			},
		},
	]);
	expect(cachedTab("p1")).toMatchObject({ projectPath: "/repos/acme-app", activeSessionCount: 3 });

	// Open the card on the cached row: it renders the details and reads that one key again.
	const cardI18n = i18next.createInstance();
	await cardI18n.init({ lng: "en", resources: { en: { common: commonEn } } });
	const host = document.createElement("div");
	const cardRoot = createRoot(host);
	const Card = () => {
		const row = cachedTab("p1") as RecentTab;
		return <RecentTabDetails tab={row} />;
	};
	const render = () =>
		cardRoot.render(
			<QueryClientProvider client={client}>
				<I18nextProvider i18n={cardI18n}>
					<MantineProvider>
						<Card />
					</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		);
	await act(async () => render());
	expect(host.textContent).toContain("/repos/acme-app");
	expect(host.textContent).toContain("3 session(s) running");
	expect(host.textContent).toContain("1 waiting for input or approval");
	expect(host.textContent).toContain("2 team(s)");
	const opened = runtimeRequests.at(-1);
	expect(opened?.keys).toEqual(["project:p1"]);
	await act(async () =>
		opened?.resolve({
			revision: 0,
			patches: [{ key: "project:p1", patch: { activeSessionCount: 4, teamCount: 2 } }],
		}),
	);
	await act(async () => render());
	expect((cachedTab("p1") as RecentTab | undefined)?.activeSessionCount).toBe(4);
	expect(host.textContent).toContain("4 session(s) running");
	await act(async () => cardRoot.unmount());
});
