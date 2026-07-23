import { describe, expect, test } from "bun:test";
import {
	createBrowserHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Link,
	Outlet,
	RouterProvider,
	useRouter,
} from "@tanstack/react-router";
import { parseHTML } from "linkedom";
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppShellMainScrollStore } from "./app-shell-scroll";
import {
	APP_HISTORY_SENTINEL,
	createAppHistoryEntryKey,
	installAppHistoryIndexTracking,
	normalizeCurrentHistoryEntry,
	pushHistorySentinel,
	recoverOrphanHistorySentinels,
	replaceCurrentHistoryState,
	resolveAppShellHistoryEntryKey,
} from "./history-state";

interface NativeEntry {
	href: string;
	state: unknown;
	navigationKey: string;
}

class BrowserHistoryHarness {
	readonly location = { pathname: "/", search: "", hash: "" };
	readonly entries: NativeEntry[];
	backCalls = 0;
	private entryIndex = 0;
	private nextNavigationKey = 1;
	private readonly listeners = new Set<EventListener>();
	readonly history: History;
	readonly window: Window;

	constructor(
		initialHref = "/",
		initialState: unknown = null,
		options: { navigationApi?: boolean } = {},
	) {
		this.entries = [
			{ href: initialHref, state: initialState, navigationKey: this.createNavigationKey() },
		];
		this.applyHref(initialHref);
		const harness = this;
		this.history = {
			get length() {
				return harness.entries.length;
			},
			get state() {
				return harness.entries[harness.entryIndex]?.state ?? null;
			},
			pushState(state: unknown, _unused: string, url?: string | URL | null) {
				const href = harness.resolveHref(url);
				harness.entries.splice(harness.entryIndex + 1, Infinity, {
					href,
					state,
					navigationKey: harness.createNavigationKey(),
				});
				harness.entryIndex = harness.entries.length - 1;
				harness.applyHref(href);
			},
			replaceState(state: unknown, _unused: string, url?: string | URL | null) {
				const href = harness.resolveHref(url);
				const currentEntry = harness.entries[harness.entryIndex];
				harness.entries[harness.entryIndex] = {
					href,
					state,
					navigationKey: currentEntry.navigationKey,
				};
				harness.applyHref(href);
			},
			back() {
				harness.backCalls++;
				this.go(-1);
			},
			forward() {
				this.go(1);
			},
			go(delta = 0) {
				const nextIndex = Math.min(
					Math.max(harness.entryIndex + delta, 0),
					harness.entries.length - 1,
				);
				if (nextIndex === harness.entryIndex) return;
				harness.entryIndex = nextIndex;
				harness.applyHref(harness.entries[nextIndex].href);
				setTimeout(() => harness.dispatchPopState(), 0);
			},
			scrollRestoration: "auto",
		} as History;
		this.window = {
			history: this.history,
			location: this.location,
			...(options.navigationApi
				? {
						navigation: {
							get currentEntry() {
								return harness.navigationEntry(harness.entryIndex);
							},
							entries: () => harness.entries.map((_, index) => harness.navigationEntry(index)),
						},
					}
				: {}),
			addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
				if (typeof listener === "function") this.listeners.add(listener);
			},
			removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
				if (typeof listener === "function") this.listeners.delete(listener);
			},
		} as unknown as Window;
	}

	get listenerCount(): number {
		return this.listeners.size;
	}

	private createNavigationKey(): string {
		return `navigation-${this.nextNavigationKey++}`;
	}

	private navigationEntry(index: number): NavigationHistoryEntry {
		const entry = this.entries[index];
		return {
			index,
			key: entry.navigationKey,
			id: entry.navigationKey,
			sameDocument: true,
			url: `https://narrafork.test${entry.href}`,
			getState: () => entry.state,
		} as NavigationHistoryEntry;
	}

	private resolveHref(url?: string | URL | null): string {
		if (url == null || url === "") {
			return `${this.location.pathname}${this.location.search}${this.location.hash}`;
		}
		const parsed = new URL(String(url), "https://narrafork.test");
		return `${parsed.pathname}${parsed.search}${parsed.hash}`;
	}

	private applyHref(href: string): void {
		const parsed = new URL(href, "https://narrafork.test");
		this.location.pathname = parsed.pathname;
		this.location.search = parsed.search;
		this.location.hash = parsed.hash;
	}

	private dispatchPopState(): void {
		const event = new Event("popstate");
		for (const listener of [...this.listeners]) listener(event);
	}
}

function installGlobals(values: Record<string, unknown>): () => void {
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries(values)) {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
		previous.set(key, descriptor);
		if (descriptor && !descriptor.configurable) {
			if ("writable" in descriptor && descriptor.writable) Reflect.set(globalThis, key, value);
			continue;
		}
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	return () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
}

function installBlockerDocument(): () => void {
	return installGlobals({ document: {} });
}

function installReactDom() {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const cleanup = installGlobals({
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	return { window, document: window.document, cleanup };
}

function dispatchPrimaryClick(element: Element, EventConstructor: typeof Event): void {
	const event = new EventConstructor("click", { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		button: { configurable: true, value: 0 },
		metaKey: { configurable: true, value: false },
		ctrlKey: { configurable: true, value: false },
		shiftKey: { configurable: true, value: false },
		altKey: { configurable: true, value: false },
	});
	element.dispatchEvent(event);
}

function expectCompleteTanStackMetadata(state: unknown, index: number): void {
	const value = state as { key?: string; __TSR_key?: string; __TSR_index?: number };
	expect(value.__TSR_key).toBeString();
	expect(value.key).toBe(value.__TSR_key);
	expect(value.__TSR_index).toBe(index);
}

async function flushHistoryWork(): Promise<void> {
	for (let index = 0; index < 4; index++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function trackActiveBlockers(history: ReturnType<typeof createBrowserHistory>): {
	active: () => number;
} {
	const originalBlock = history.block.bind(history);
	let activeBlockers = 0;
	history.block = (blocker) => {
		activeBlockers++;
		const unblock = originalBlock(blocker);
		let unblocked = false;
		return () => {
			if (unblocked) return;
			unblocked = true;
			activeBlockers--;
			unblock();
		};
	};
	return { active: () => activeBlockers };
}

async function runReactLinkSentinelScenario(closeDuringLinkClick: boolean) {
	const dom = installReactDom();
	const browser = new BrowserHistoryHarness("/");
	const history = createBrowserHistory({ window: browser.window });
	let popCount = 0;

	function SentinelLinkLayout() {
		const router = useRouter();
		const [opened, setOpened] = useState(true);
		useEffect(() => {
			if (!opened) return;
			return pushHistorySentinel(
				router.history,
				APP_HISTORY_SENTINEL.mobileNav,
				() => {
					popCount++;
					setOpened(false);
				},
				browser.window,
			).dispose;
		}, [opened, router.history]);
		return (
			<>
				<span data-nav-opened={opened ? "true" : "false"} />
				<Link
					to="/licenses"
					data-testid="route-link"
					onClick={closeDuringLinkClick ? () => setOpened(false) : undefined}
				>
					Next
				</Link>
				<Outlet />
			</>
		);
	}

	const rootRoute = createRootRoute({ component: SentinelLinkLayout });
	const indexRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/",
		component: () => <div data-route="home" />,
	});
	const nextRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/licenses",
		component: () => <div data-route="next" />,
	});
	const router = createRouter({
		history,
		routeTree: rootRoute.addChildren([indexRoute, nextRoute]),
	});
	const container = dom.document.createElement("div") as HTMLDivElement;
	dom.document.body.appendChild(container);
	const reactRoot = createRoot(container);

	await router.load();
	await act(async () => {
		reactRoot.render(<RouterProvider router={router} />);
		await flushHistoryWork();
	});
	expect(browser.entries).toHaveLength(2);
	expect(container.querySelector("[data-nav-opened='true']")).not.toBeNull();

	const link = container.querySelector("[data-testid='route-link']");
	expect(link).not.toBeNull();
	await act(async () => {
		dispatchPrimaryClick(link as Element, dom.window.Event as unknown as typeof Event);
		await flushHistoryWork();
	});

	const result = {
		backCalls: browser.backCalls,
		entryCount: browser.entries.length,
		opened: container.querySelector("[data-nav-opened='true']") !== null,
		pathname: router.state.location.pathname,
		popCount,
	};
	await act(async () => reactRoot.unmount());
	history.destroy();
	container.remove();
	dom.cleanup();
	return result;
}

describe("TanStack-compatible app history state", () => {
	test("replace preserves router metadata, unrelated state, and the current index", () => {
		const browser = new BrowserHistoryHarness("/settings?oauth_success=1", {
			key: "route-key",
			__TSR_key: "route-key",
			__TSR_index: 7,
			mobileNav: true,
			unrelated: "kept",
		});

		replaceCurrentHistoryState({ mobileNav: null }, "/settings", browser.window);

		expect(browser.location).toEqual({ pathname: "/settings", search: "", hash: "" });
		expect(browser.history.state).toEqual({
			key: "route-key",
			__TSR_key: "route-key",
			__TSR_index: 7,
			unrelated: "kept",
		});
	});

	test("metadata-free same-href entries receive distinct persisted fallback keys", () => {
		const browser = new BrowserHistoryHarness("/legacy", { legacy: true });
		const firstFallback = createAppHistoryEntryKey();
		const first = resolveAppShellHistoryEntryKey(
			{ href: "/legacy", state: { __TSR_index: 0 } },
			firstFallback,
			browser.window,
		);
		expect(first).toEqual({ key: firstFallback, needsFallbackPersistence: true });
		replaceCurrentHistoryState({ __NF_history_key: first.key }, "/legacy", browser.window);

		browser.history.pushState({ legacy: true }, "", "/legacy");
		const secondFallback = createAppHistoryEntryKey();
		const second = resolveAppShellHistoryEntryKey(
			{ href: "/legacy", state: { __TSR_index: 0 } },
			secondFallback,
			browser.window,
		);

		expect(second).toEqual({ key: secondFallback, needsFallbackPersistence: true });
		expect(second.key).not.toBe(first.key);
	});

	test("Navigation API restores a native metadata-free push as index one and Back", async () => {
		const browser = new BrowserHistoryHarness("/a", null, { navigationApi: true });
		const history = createBrowserHistory({ window: browser.window });
		const stopTracking = installAppHistoryIndexTracking(history, browser.window);
		expectCompleteTanStackMetadata(history.location.state, 0);

		browser.history.pushState({ native: "B" }, "", "/b");
		expect(history.location.state.__TSR_index).toBeUndefined();
		const normalized = normalizeCurrentHistoryEntry(history, browser.window);
		expectCompleteTanStackMetadata(normalized, 1);
		expect(history.canGoBack()).toBe(true);

		const actions: string[] = [];
		const unsubscribe = history.subscribe(({ action }) => actions.push(action.type));
		history.back();
		await flushHistoryWork();

		expect(history.location.pathname).toBe("/a");
		expect(actions).toEqual(["BACK"]);
		unsubscribe();
		stopTracking();
	});

	test("multiple metadata-free same-href pushes keep increasing indexes and unique entry keys", async () => {
		const browser = new BrowserHistoryHarness("/same", null, { navigationApi: true });
		const history = createBrowserHistory({ window: browser.window });
		const stopTracking = installAppHistoryIndexTracking(history, browser.window);

		browser.history.pushState({ native: "B" }, "", "/same");
		const second = normalizeCurrentHistoryEntry(history, browser.window);
		expectCompleteTanStackMetadata(second, 1);
		browser.history.pushState({ native: "C" }, "", "/same");
		const third = normalizeCurrentHistoryEntry(history, browser.window);
		expectCompleteTanStackMetadata(third, 2);
		expect(third.__TSR_key).not.toBe(second.__TSR_key);

		const actions: string[] = [];
		const unsubscribe = history.subscribe(({ action }) => actions.push(action.type));
		history.back();
		await flushHistoryWork();
		expectCompleteTanStackMetadata(history.location.state, 1);
		expect(actions).toEqual(["BACK"]);
		unsubscribe();
		stopTracking();
	});

	test("session tracking infers native pushes without Navigation API and releases its subscriber", () => {
		const browser = new BrowserHistoryHarness("/a");
		const history = createBrowserHistory({ window: browser.window });
		const stopTracking = installAppHistoryIndexTracking(history, browser.window);
		expect(history.subscribers.size).toBe(1);

		browser.history.pushState({ native: "B" }, "", "/b");
		const normalized = normalizeCurrentHistoryEntry(history, browser.window);
		expectCompleteTanStackMetadata(normalized, 1);
		expect(history.canGoBack()).toBe(true);

		stopTracking();
		expect(history.subscribers.size).toBe(0);
	});

	test("an unobserved metadata-free entry does not reuse a stale tracked index", () => {
		const browser = new BrowserHistoryHarness("/a");
		const nativePushState = browser.history.pushState.bind(browser.history);
		const history = createBrowserHistory({ window: browser.window });
		const stopTracking = installAppHistoryIndexTracking(history, browser.window);
		history.push("/known", { routeState: true });
		history.flush();
		expectCompleteTanStackMetadata(history.location.state, 1);

		nativePushState({ legacy: true, __NF_scroll_key: "legacy-scroll" }, "", "/legacy");
		const normalized = normalizeCurrentHistoryEntry(history, browser.window);
		expectCompleteTanStackMetadata(normalized, 0);
		expect(normalized.__NF_scroll_key).toBe("legacy-scroll");

		stopTracking();
	});

	test("an unobservable legacy entry conservatively rebases without losing app-owned keys", () => {
		const browser = new BrowserHistoryHarness("/legacy", {
			key: "legacy-key",
			__TSR_key: "legacy-key",
			__NF_scroll_key: "scroll-key",
			__NF_sentinel_id: "old-sentinel",
			mobileNav: true,
		});
		const history = createBrowserHistory({ window: browser.window });
		const normalized = normalizeCurrentHistoryEntry(history, browser.window);

		expectCompleteTanStackMetadata(normalized, 0);
		expect(normalized).toMatchObject({
			__NF_scroll_key: "scroll-key",
			__NF_sentinel_id: "old-sentinel",
			mobileNav: true,
		});
		expect(history.canGoBack()).toBe(false);
	});

	test("startup recovery consumes a reload-orphaned sentinel before the next visible Back", async () => {
		const browser = new BrowserHistoryHarness("/previous", null, { navigationApi: true });
		const firstRuntime = createBrowserHistory({ window: browser.window });
		firstRuntime.push("/app", { routeState: "app" });
		firstRuntime.flush();
		const baseState = firstRuntime.location.state;
		const baseKey = baseState.__TSR_key as string;
		pushHistorySentinel(firstRuntime, APP_HISTORY_SENTINEL.mobileNav, () => {}, browser.window);
		const orphanState = firstRuntime.location.state;
		expect(orphanState.__NF_sentinel_base_href).toBe("/app");
		expect(orphanState.__NF_sentinel_base_key).toBe(baseKey);
		expect(orphanState.__NF_sentinel_base_scroll_key).toBe(baseKey);
		firstRuntime.destroy();

		const reloadedHistory = createBrowserHistory({ window: browser.window });
		const firstRecovery = recoverOrphanHistorySentinels(reloadedHistory, browser.window);
		const repeatedRecovery = recoverOrphanHistorySentinels(reloadedHistory, browser.window);
		expect(repeatedRecovery).toBe(firstRecovery);
		expect(await firstRecovery).toEqual({ status: "consumed", consumed: 1 });

		expect(browser.backCalls).toBe(1);
		expect(reloadedHistory.location.pathname).toBe("/app");
		expectCompleteTanStackMetadata(reloadedHistory.location.state, 1);
		expect(reloadedHistory.location.state.__TSR_key).toBe(baseKey);
		expect(reloadedHistory.location.state.__NF_sentinel_id).toBeUndefined();
		expect(
			resolveAppShellHistoryEntryKey(
				reloadedHistory.location,
				createAppHistoryEntryKey(),
				browser.window,
			).key,
		).toBe(baseKey);
		expect(await recoverOrphanHistorySentinels(reloadedHistory, browser.window)).toEqual({
			status: "consumed",
			consumed: 1,
		});
		expect(browser.backCalls).toBe(1);

		reloadedHistory.back();
		await flushHistoryWork();
		expect(reloadedHistory.location.pathname).toBe("/previous");
		expect(browser.backCalls).toBe(2);
		reloadedHistory.destroy();
	});

	test("startup recovery drains stacked reload-orphaned sentinels", async () => {
		const browser = new BrowserHistoryHarness("/previous", null, { navigationApi: true });
		const firstRuntime = createBrowserHistory({ window: browser.window });
		firstRuntime.push("/app", { routeState: "app" });
		firstRuntime.flush();
		pushHistorySentinel(firstRuntime, APP_HISTORY_SENTINEL.mobileNav, () => {}, browser.window);
		pushHistorySentinel(
			firstRuntime,
			APP_HISTORY_SENTINEL.contentViewerFullscreen,
			() => {},
			browser.window,
		);
		expect(browser.entries).toHaveLength(4);
		firstRuntime.destroy();

		const reloadedHistory = createBrowserHistory({ window: browser.window });
		expect(await recoverOrphanHistorySentinels(reloadedHistory, browser.window)).toEqual({
			status: "consumed",
			consumed: 2,
		});
		expect(browser.backCalls).toBe(2);
		expect(reloadedHistory.location.pathname).toBe("/app");

		reloadedHistory.back();
		await flushHistoryWork();
		expect(reloadedHistory.location.pathname).toBe("/previous");
		reloadedHistory.destroy();
	});

	test("unverifiable or wrong-href sentinel state is cleared without traversing Back", async () => {
		const wrongHrefBrowser = new BrowserHistoryHarness("/outside");
		const firstRuntime = createBrowserHistory({ window: wrongHrefBrowser.window });
		firstRuntime.push("/app", { routeState: "app" });
		firstRuntime.flush();
		pushHistorySentinel(
			firstRuntime,
			APP_HISTORY_SENTINEL.terminalDrawer,
			() => {},
			wrongHrefBrowser.window,
		);
		wrongHrefBrowser.history.replaceState(
			{
				...(wrongHrefBrowser.history.state as Record<string, unknown>),
				__NF_sentinel_base_href: "/different",
			},
			"",
			"/app",
		);
		firstRuntime.destroy();

		const wrongHrefReload = createBrowserHistory({ window: wrongHrefBrowser.window });
		expect(await recoverOrphanHistorySentinels(wrongHrefReload, wrongHrefBrowser.window)).toEqual({
			status: "cleared-unverified",
			consumed: 0,
		});
		expect(wrongHrefBrowser.backCalls).toBe(0);
		expect(wrongHrefReload.location.pathname).toBe("/app");
		expect(wrongHrefReload.location.state.__NF_sentinel_id).toBeUndefined();
		expectCompleteTanStackMetadata(wrongHrefReload.location.state, 2);
		wrongHrefReload.destroy();

		const legacyBrowser = new BrowserHistoryHarness("/outside");
		legacyBrowser.history.pushState(
			{
				key: "legacy-sentinel-key",
				__TSR_key: "legacy-sentinel-key",
				__TSR_index: 1,
				__NF_sentinel_id: "legacy-sentinel",
				__NF_scroll_key: "unverifiable-base",
				mobileNav: true,
			},
			"",
			"/app",
		);
		const legacyHistory = createBrowserHistory({ window: legacyBrowser.window });
		expect(await recoverOrphanHistorySentinels(legacyHistory, legacyBrowser.window)).toEqual({
			status: "cleared-unverified",
			consumed: 0,
		});
		expect(legacyBrowser.backCalls).toBe(0);
		expect(legacyHistory.location.pathname).toBe("/app");
		expect(legacyHistory.location.state.__NF_sentinel_id).toBeUndefined();
		expectCompleteTanStackMetadata(legacyHistory.location.state, 1);
		legacyHistory.destroy();
	});

	test("a sentinel created during startup recovery waits for the recovered base entry", async () => {
		const browser = new BrowserHistoryHarness("/previous", null, { navigationApi: true });
		const firstRuntime = createBrowserHistory({ window: browser.window });
		firstRuntime.push("/app", { routeState: "app" });
		firstRuntime.flush();
		pushHistorySentinel(firstRuntime, APP_HISTORY_SENTINEL.mobileNav, () => {}, browser.window);
		const orphanId = firstRuntime.location.state.__NF_sentinel_id;
		firstRuntime.destroy();

		const reloadedHistory = createBrowserHistory({ window: browser.window });
		const recovery = recoverOrphanHistorySentinels(reloadedHistory, browser.window);
		const newController = pushHistorySentinel(
			reloadedHistory,
			APP_HISTORY_SENTINEL.terminalDrawer,
			() => {},
			browser.window,
		);
		expect(browser.entries).toHaveLength(3);
		expect(reloadedHistory.location.state.__NF_sentinel_id).toBe(orphanId);

		expect(await recovery).toEqual({ status: "consumed", consumed: 1 });
		await flushHistoryWork();
		expect(browser.entries).toHaveLength(3);
		expect(reloadedHistory.location.pathname).toBe("/app");
		expect(reloadedHistory.location.state.terminalDrawer).toBe(true);
		expect(reloadedHistory.location.state.mobileNav).toBeUndefined();
		expect(reloadedHistory.location.state.__NF_sentinel_id).not.toBe(orphanId);
		expectCompleteTanStackMetadata(reloadedHistory.location.state, 2);

		newController.dispose();
		await flushHistoryWork();
		expect(browser.backCalls).toBe(2);
		expect(reloadedHistory.location.pathname).toBe("/app");
		expectCompleteTanStackMetadata(reloadedHistory.location.state, 1);
		reloadedHistory.destroy();
	});

	test("long Main scroll survives a mobile sentinel, route jump, and one Back", async () => {
		const cleanupDocument = installBlockerDocument();
		const browser = new BrowserHistoryHarness("/long");
		const history = createBrowserHistory({ window: browser.window });
		const store = new AppShellMainScrollStore();
		const main = { scrollTop: 0 };
		const initialState = history.location.state;
		expectCompleteTanStackMetadata(initialState, 0);
		const initialKey = initialState.__TSR_key as string;

		store.restore(initialKey, main);
		main.scrollTop = 760;
		store.capture(initialKey, main);

		let navClosed = 0;
		const sentinel = pushHistorySentinel(
			history,
			APP_HISTORY_SENTINEL.mobileNav,
			() => navClosed++,
			browser.window,
		);
		const sentinelState = history.location.state;
		expectCompleteTanStackMetadata(sentinelState, 1);
		expect(sentinelState.__TSR_key).not.toBe(initialKey);
		expect(sentinelState.mobileNav).toBe(true);
		expect(sentinelState.__NF_scroll_key).toBe(initialKey);

		const sentinelKey = resolveAppShellHistoryEntryKey(
			history.location,
			createAppHistoryEntryKey(),
			browser.window,
		).key;
		expect(sentinelKey).toBe(initialKey);
		store.restore(sentinelKey, main);
		expect(main.scrollTop).toBe(760);

		history.push("/next", { routeState: "next" });
		await flushHistoryWork();
		sentinel.dispose();

		expect(navClosed).toBe(1);
		expect(history.location.pathname).toBe("/next");
		expect(browser.entries).toHaveLength(2);
		expectCompleteTanStackMetadata(history.location.state, 1);
		expect(history.location.state.mobileNav).toBeUndefined();
		expect(history.location.state.__NF_scroll_key).toBeUndefined();

		const nextKey = history.location.state.__TSR_key as string;
		expect(nextKey).not.toBe(initialKey);
		store.restore(nextKey, main);
		expect(main.scrollTop).toBe(0);
		main.scrollTop = 120;
		store.capture(nextKey, main);

		history.back();
		await flushHistoryWork();
		expect(history.location.pathname).toBe("/long");
		expectCompleteTanStackMetadata(history.location.state, 0);
		store.restore(history.location.state.__TSR_key as string, main);
		expect(main.scrollTop).toBe(760);
		cleanupDocument();
	});

	test("repairs metadata-free entries before sentinel push/pop and keeps same-href keys unique", async () => {
		const cleanupDocument = installBlockerDocument();
		const browser = new BrowserHistoryHarness("/start");
		const history = createBrowserHistory({ window: browser.window });
		const initialKey = history.location.state.__TSR_key;

		browser.history.pushState(
			{
				legacy: true,
				__NF_history_key: "legacy-fallback-a",
				__TSR_index: Number.POSITIVE_INFINITY,
			},
			"",
			"/legacy",
		);
		expect(history.location.state.__TSR_key).toBeUndefined();

		let popCount = 0;
		pushHistorySentinel(history, APP_HISTORY_SENTINEL.mobileNav, () => popCount++, browser.window);
		const repairedLegacyState = browser.entries[1].state;
		expectCompleteTanStackMetadata(repairedLegacyState, 0);
		const repairedLegacyKey = (repairedLegacyState as { __TSR_key: string }).__TSR_key;
		expect(repairedLegacyKey).toBe("legacy-fallback-a");
		expect(repairedLegacyKey).not.toBe(initialKey);
		expectCompleteTanStackMetadata(history.location.state, 1);

		history.back();
		await flushHistoryWork();
		expect(popCount).toBe(1);
		expect(history.location.pathname).toBe("/legacy");
		expectCompleteTanStackMetadata(history.location.state, 0);

		history.push("/next", { routeState: "next" });
		await flushHistoryWork();
		expect(history.location.pathname).toBe("/next");
		expectCompleteTanStackMetadata(history.location.state, 1);
		history.back();
		await flushHistoryWork();
		expect(history.location.pathname).toBe("/legacy");
		expect(history.location.state.__TSR_key).toBe(repairedLegacyKey);

		browser.history.pushState(
			{ legacy: true, __NF_history_key: "legacy-fallback-b" },
			"",
			"/legacy",
		);
		const secondSameHrefState = normalizeCurrentHistoryEntry(history, browser.window);
		expectCompleteTanStackMetadata(secondSameHrefState, 0);
		expect(secondSameHrefState.__TSR_key).not.toBe(repairedLegacyKey);
		cleanupDocument();
	});

	test("pending navigation and repeated dispose consume one sentinel exactly once", async () => {
		const cleanupDocument = installBlockerDocument();
		const browser = new BrowserHistoryHarness("/base");
		const history = createBrowserHistory({ window: browser.window });
		let popCount = 0;
		const controller = pushHistorySentinel(
			history,
			APP_HISTORY_SENTINEL.mobileNav,
			() => popCount++,
			browser.window,
		);

		history.push("/next", { routeState: "next" });
		controller.dispose();
		controller.dispose();
		await flushHistoryWork();

		expect(browser.backCalls).toBe(1);
		expect(popCount).toBe(0);
		expect(history.location.pathname).toBe("/next");
		expect(browser.entries).toHaveLength(2);
		cleanupDocument();
	});

	test("a dispose/reopen race queues the new sentinel until the old Back finishes", async () => {
		const cleanupDocument = installBlockerDocument();
		const browser = new BrowserHistoryHarness("/base");
		const history = createBrowserHistory({ window: browser.window });
		const blockers = trackActiveBlockers(history);
		let firstPops = 0;
		let reopenedPops = 0;
		const first = pushHistorySentinel(
			history,
			APP_HISTORY_SENTINEL.mobileNav,
			() => firstPops++,
			browser.window,
		);

		first.dispose();
		const reopened = pushHistorySentinel(
			history,
			APP_HISTORY_SENTINEL.mobileNav,
			() => reopenedPops++,
			browser.window,
		);
		expect(history.location.state.mobileNav).toBe(true);
		expect(browser.backCalls).toBe(1);

		await flushHistoryWork();
		expect(firstPops).toBe(0);
		expect(reopenedPops).toBe(0);
		expect(history.location.state.mobileNav).toBe(true);
		expectCompleteTanStackMetadata(history.location.state, 1);

		reopened.dispose();
		await flushHistoryWork();
		expect(browser.backCalls).toBe(2);
		expect(history.location.pathname).toBe("/base");
		expect(history.subscribers.size).toBe(0);
		expect(blockers.active()).toBe(0);
		cleanupDocument();
	});

	test("an old overlay Back cannot close a queued sentinel for another overlay", async () => {
		const cleanupDocument = installBlockerDocument();
		const browser = new BrowserHistoryHarness("/base");
		const history = createBrowserHistory({ window: browser.window });
		const blockers = trackActiveBlockers(history);
		let fullscreenPops = 0;
		const nav = pushHistorySentinel(
			history,
			APP_HISTORY_SENTINEL.mobileNav,
			() => {},
			browser.window,
		);

		nav.dispose();
		pushHistorySentinel(
			history,
			APP_HISTORY_SENTINEL.contentViewerFullscreen,
			() => fullscreenPops++,
			browser.window,
		);
		await flushHistoryWork();

		expect(fullscreenPops).toBe(0);
		expect(history.location.state.mobileNav).toBeUndefined();
		expect(history.location.state.contentViewerFullscreen).toBe(true);
		history.back();
		await flushHistoryWork();
		expect(fullscreenPops).toBe(1);
		expect(history.location.pathname).toBe("/base");
		expect(history.subscribers.size).toBe(0);
		expect(blockers.active()).toBe(0);
		cleanupDocument();
	});

	test("disposing a queued sentinel prevents its activation and does not starve the next one", async () => {
		const cleanupDocument = installBlockerDocument();
		const browser = new BrowserHistoryHarness("/base");
		const history = createBrowserHistory({ window: browser.window });
		const blockers = trackActiveBlockers(history);
		const first = pushHistorySentinel(
			history,
			APP_HISTORY_SENTINEL.mobileNav,
			() => {},
			browser.window,
		);
		first.dispose();
		const skipped = pushHistorySentinel(
			history,
			APP_HISTORY_SENTINEL.terminalDrawer,
			() => {},
			browser.window,
		);
		skipped.dispose();
		const final = pushHistorySentinel(
			history,
			APP_HISTORY_SENTINEL.contentViewerFullscreen,
			() => {},
			browser.window,
		);

		await flushHistoryWork();
		expect(history.location.state.terminalDrawer).toBeUndefined();
		expect(history.location.state.contentViewerFullscreen).toBe(true);
		expect(browser.entries).toHaveLength(2);

		final.dispose();
		await flushHistoryWork();
		expect(history.subscribers.size).toBe(0);
		expect(blockers.active()).toBe(0);
		cleanupDocument();
	});

	test("route navigation closes queued sentinels without activating them before replay", async () => {
		const cleanupDocument = installBlockerDocument();
		const browser = new BrowserHistoryHarness("/base");
		const history = createBrowserHistory({ window: browser.window });
		const blockers = trackActiveBlockers(history);
		let queuedPops = 0;
		const first = pushHistorySentinel(
			history,
			APP_HISTORY_SENTINEL.mobileNav,
			() => {},
			browser.window,
		);
		first.dispose();
		pushHistorySentinel(
			history,
			APP_HISTORY_SENTINEL.terminalDrawer,
			() => queuedPops++,
			browser.window,
		);

		history.push("/next", { routeState: "next" });
		await flushHistoryWork();

		expect(queuedPops).toBe(1);
		expect(browser.backCalls).toBe(1);
		expect(browser.entries).toHaveLength(2);
		expect(history.location.pathname).toBe("/next");
		expect(history.location.state.mobileNav).toBeUndefined();
		expect(history.location.state.terminalDrawer).toBeUndefined();
		expect(history.subscribers.size).toBe(0);
		expect(blockers.active()).toBe(0);
		cleanupDocument();
	});

	test("navigation drains sentinels queued reentrantly by another queued onPop", async () => {
		const cleanupDocument = installBlockerDocument();
		const browser = new BrowserHistoryHarness("/base");
		const history = createBrowserHistory({ window: browser.window });
		const blockers = trackActiveBlockers(history);
		const closed: string[] = [];
		const first = pushHistorySentinel(
			history,
			APP_HISTORY_SENTINEL.mobileNav,
			() => {},
			browser.window,
		);
		first.dispose();
		pushHistorySentinel(
			history,
			APP_HISTORY_SENTINEL.terminalDrawer,
			() => {
				closed.push("B");
				pushHistorySentinel(
					history,
					APP_HISTORY_SENTINEL.contentViewerFullscreen,
					() => closed.push("C"),
					browser.window,
				);
			},
			browser.window,
		);

		history.push("/next", { routeState: "next" });
		await flushHistoryWork();

		expect(closed).toEqual(["B", "C"]);
		expect(browser.backCalls).toBe(1);
		expect(browser.entries).toHaveLength(2);
		expect(history.location.pathname).toBe("/next");
		expect(history.location.state.contentViewerFullscreen).toBeUndefined();
		expect(history.subscribers.size).toBe(0);
		expect(blockers.active()).toBe(0);
		cleanupDocument();
	});

	test("one route navigation drains stacked sentinels from top to bottom before replay", async () => {
		const cleanupDocument = installBlockerDocument();
		const browser = new BrowserHistoryHarness("/base");
		const history = createBrowserHistory({ window: browser.window });
		const closed: string[] = [];
		pushHistorySentinel(
			history,
			APP_HISTORY_SENTINEL.mobileNav,
			() => closed.push("A"),
			browser.window,
		);
		pushHistorySentinel(
			history,
			APP_HISTORY_SENTINEL.contentViewerFullscreen,
			() => closed.push("B"),
			browser.window,
		);

		history.push("/next", { routeState: "next" });
		await flushHistoryWork();

		expect(closed).toEqual(["B", "A"]);
		expect(browser.backCalls).toBe(2);
		expect(browser.entries).toHaveLength(2);
		expect(history.location.pathname).toBe("/next");
		expect(history.location.state.mobileNav).toBeUndefined();
		expect(history.location.state.contentViewerFullscreen).toBeUndefined();
		expect(history.location.state.__NF_scroll_key).toBeUndefined();
		cleanupDocument();
	});

	test("disposing a non-top sentinel never pops the current top entry", async () => {
		const cleanupDocument = installBlockerDocument();
		const browser = new BrowserHistoryHarness("/base");
		const history = createBrowserHistory({ window: browser.window });
		const first = pushHistorySentinel(
			history,
			APP_HISTORY_SENTINEL.mobileNav,
			() => {},
			browser.window,
		);
		const second = pushHistorySentinel(
			history,
			APP_HISTORY_SENTINEL.terminalDrawer,
			() => {},
			browser.window,
		);

		first.dispose();
		expect(browser.backCalls).toBe(0);
		expect(history.location.state.terminalDrawer).toBe(true);

		second.dispose();
		await flushHistoryWork();
		expect(browser.backCalls).toBe(2);
		expect(history.location.pathname).toBe("/base");
		expect(history.location.state.mobileNav).toBeUndefined();
		expect(history.location.state.terminalDrawer).toBeUndefined();
		cleanupDocument();
	});

	test("a real React Link click lets sentinel POP close UI before route replay", async () => {
		const result = await runReactLinkSentinelScenario(false);
		expect(result).toEqual({
			backCalls: 1,
			entryCount: 2,
			opened: false,
			pathname: "/licenses",
			popCount: 1,
		});

		const appRootSource = await Bun.file(
			new URL("../components/AppRootLayout.tsx", import.meta.url),
		).text();
		const setupWizardSource = await Bun.file(
			new URL("../components/settings/SetupWizard.tsx", import.meta.url),
		).text();
		expect(appRootSource).not.toContain("closeNavForLink");
		expect(appRootSource).not.toContain("onNavigate={closeNav");
		expect(setupWizardSource).not.toContain("onNavigateToContent");
	});

	test("a real React Link onClick cleanup race cannot consume the sentinel twice", async () => {
		const result = await runReactLinkSentinelScenario(true);
		expect(result.backCalls).toBe(1);
		expect(result.entryCount).toBe(2);
		expect(result.opened).toBe(false);
		expect(result.pathname).toBe("/licenses");
		expect(result.popCount).toBeLessThanOrEqual(1);
	});
});
