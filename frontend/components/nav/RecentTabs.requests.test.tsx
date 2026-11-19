import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
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
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import { RecentTabsWSProvider } from "./RecentTabs";

const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { nav: {} } } });

type RuntimeResult = Awaited<ReturnType<typeof api.getRecentTabsRuntime>>;
type RuntimeRequest = {
	keys: string[];
	signal?: AbortSignal;
	resolve: (result: RuntimeResult) => void;
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
	const globals = {
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
	Object.assign(globalThis, globals);
	restoreDom = () => {
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
			new Promise<RuntimeResult>((resolve) => {
				// Deliberately allow a response after cancellation.
				runtimeRequests.push({ keys, signal, resolve });
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
