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
import { useMobileDrawerHistory } from "../hooks/useMobileDrawerHistory";
import { AppShellMainScrollStore } from "./app-shell-scroll";
import {
	createAppHistoryEntryKey,
	replaceCurrentHistoryState,
	resolveAppShellHistoryEntryKey,
} from "./history-entry";
import {
	APP_HISTORY_SENTINEL,
	normalizeCurrentHistoryEntry,
	pushHistorySentinel,
} from "./history-state";

interface NativeEntry {
	href: string;
	state: unknown;
}

class BrowserHistoryHarness {
	readonly location = { pathname: "/", search: "", hash: "" };
	readonly entries: NativeEntry[];
	backCalls = 0;
	private entryIndex = 0;
	private readonly listeners = new Set<EventListener>();
	readonly history: History;
	readonly window: Window;

	constructor(initialHref = "/", initialState: unknown = null) {
		this.entries = [{ href: initialHref, state: initialState }];
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
				harness.entries.splice(harness.entryIndex + 1, Infinity, { href, state });
				harness.entryIndex = harness.entries.length - 1;
				harness.applyHref(href);
			},
			replaceState(state: unknown, _unused: string, url?: string | URL | null) {
				const href = harness.resolveHref(url);
				harness.entries[harness.entryIndex] = { href, state };
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
			addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
				if (typeof listener === "function") this.listeners.add(listener);
			},
			removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
				if (typeof listener === "function") this.listeners.delete(listener);
			},
		} as unknown as Window;
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

/** TanStack only consults blockers when a `document` global exists. */
function installBlockerDocument(): () => void {
	return installGlobals({ document: {} });
}

/**
 * A native-history harness plus a TanStack history bound to it, with the `document`
 * global the blocker path requires. Every sentinel test needs exactly this trio and
 * differs only in the starting URL.
 */
function sentinelHarness(initialHref: string) {
	const cleanupDocument = installBlockerDocument();
	const browser = new BrowserHistoryHarness(initialHref);
	return { browser, history: createBrowserHistory({ window: browser.window }), cleanupDocument };
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

async function runMobileDrawerHookScenario() {
	const dom = installReactDom();
	const browser = new BrowserHistoryHarness("/");
	const cleanupWindow = installGlobals({ window: browser.window });
	browser.window.matchMedia = (() => ({
		matches: true,
		media: "(max-width: 767px)",
		addEventListener() {},
		removeEventListener() {},
	})) as unknown as typeof browser.window.matchMedia;
	const history = createBrowserHistory({ window: browser.window });
	let closeCount = 0;

	function DrawerLayout() {
		const [opened, setOpened] = useState(true);
		useMobileDrawerHistory(opened, () => {
			closeCount++;
			setOpened(false);
		});
		return <span data-drawer-opened={opened ? "true" : "false"} />;
	}

	const rootRoute = createRootRoute({ component: DrawerLayout });
	const indexRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/",
		component: () => <div data-route="home" />,
	});
	const router = createRouter({
		history,
		routeTree: rootRoute.addChildren([indexRoute]),
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
	expect(container.querySelector("[data-drawer-opened='true']")).not.toBeNull();

	await act(async () => {
		history.back();
		await flushHistoryWork();
	});
	expect(closeCount).toBe(1);
	expect(container.querySelector("[data-drawer-opened='true']")).toBeNull();
	expect(router.state.location.pathname).toBe("/");
	await act(async () => reactRoot.unmount());
	history.destroy();
	container.remove();
	cleanupWindow();
	dom.cleanup();
}

describe("app-owned history entry state", () => {
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
});

describe("mobile Back sentinel entries", () => {
	test("repairs a non-finite index before pushing, so Back/Forward deltas stay finite", async () => {
		const { browser, history, cleanupDocument } = sentinelHarness("/start");
		const initialKey = history.location.state.__TSR_key;

		// A native pushState from outside the router: TanStack reports it as a PUSH but the entry
		// carries no key and a non-finite index, so `push` would derive `Infinity + 1` for the next.
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

		// A NaN index would make this PUSH/BACK pair undetectable as a ±1 delta.
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

	test("long Main scroll survives a mobile sentinel, route jump, and one Back", async () => {
		const { browser, history, cleanupDocument } = sentinelHarness("/long");
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

		// The ephemeral entry must resolve to the scroll identity of the entry it was pushed from.
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

	test("pending navigation and repeated dispose consume one sentinel exactly once", async () => {
		const { browser, history, cleanupDocument } = sentinelHarness("/base");
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
		const { browser, history, cleanupDocument } = sentinelHarness("/base");
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
		expect(browser.backCalls).toBe(1);

		await flushHistoryWork();
		// The Back that retired the first entry must not be read as "the reopened overlay closed".
		expect(firstPops).toBe(0);
		expect(reopenedPops).toBe(0);
		expect(history.location.state.mobileNav).toBe(true);
		expect(browser.entries).toHaveLength(2);
		expectCompleteTanStackMetadata(history.location.state, 1);

		reopened.dispose();
		await flushHistoryWork();
		expect(browser.backCalls).toBe(2);
		expect(history.location.pathname).toBe("/base");
		expect(history.subscribers.size).toBe(0);
		expect(blockers.active()).toBe(0);
		cleanupDocument();
	});

	test("route navigation closes overlays queued behind an in-flight Back before replaying", async () => {
		const { browser, history, cleanupDocument } = sentinelHarness("/base");
		const blockers = trackActiveBlockers(history);
		const closed: string[] = [];
		const first = pushHistorySentinel(
			history,
			APP_HISTORY_SENTINEL.mobileNav,
			() => {},
			browser.window,
		);
		first.dispose();
		// Queued behind the dispose Back, and its own onPop opens one more overlay reentrantly.
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
		expect(history.location.state.mobileNav).toBeUndefined();
		expect(history.location.state.terminalDrawer).toBeUndefined();
		expect(history.location.state.contentViewerFullscreen).toBeUndefined();
		expect(history.location.state.__NF_scroll_key).toBeUndefined();
		expect(history.subscribers.size).toBe(0);
		expect(blockers.active()).toBe(0);
		cleanupDocument();
	});

	test("concurrent overlays share one entry: Back closes both, one dispose keeps it alive", async () => {
		// Documented tradeoff of the single-entry design. Not reachable from the app's three
		// mobile-only, screen-covering overlays, but it must degrade predictably rather than
		// stranding an entry that makes Back look broken.
		const { browser, history, cleanupDocument } = sentinelHarness("/base");
		const blockers = trackActiveBlockers(history);
		const closed: string[] = [];
		const nav = pushHistorySentinel(
			history,
			APP_HISTORY_SENTINEL.mobileNav,
			() => closed.push("nav"),
			browser.window,
		);
		const fullscreen = pushHistorySentinel(
			history,
			APP_HISTORY_SENTINEL.contentViewerFullscreen,
			() => closed.push("fullscreen"),
			browser.window,
		);
		expect(browser.entries).toHaveLength(2);

		nav.dispose();
		await flushHistoryWork();
		expect(browser.backCalls).toBe(0);
		expect(closed).toEqual([]);
		expect(history.location.state.mobileNav).toBe(true);

		history.back();
		await flushHistoryWork();
		expect(closed).toEqual(["fullscreen"]);
		expect(history.location.pathname).toBe("/base");
		expect(browser.entries).toHaveLength(2);
		expect(history.location.state.mobileNav).toBeUndefined();

		fullscreen.dispose();
		await flushHistoryWork();
		expect(browser.backCalls).toBe(1);
		expect(history.subscribers.size).toBe(0);
		expect(blockers.active()).toBe(0);
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
	});

	test("the mobile drawer hook closes the drawer before route navigation", async () => {
		await runMobileDrawerHookScenario();
	});

	test("a real React Link onClick cleanup race cannot consume the sentinel twice", async () => {
		const result = await runReactLinkSentinelScenario(true);
		expect(result.backCalls).toBe(1);
		expect(result.entryCount).toBe(2);
		expect(result.opened).toBe(false);
		expect(result.pathname).toBe("/licenses");
		expect(result.popCount).toBeLessThanOrEqual(1);
	});

	test("every sentinel call site is gated on a mobile viewport", async () => {
		// Back-button interception is a mobile affordance: there, Back is the system gesture
		// for dismissing an overlay. On desktop, Back means "navigate", and an open overlay is
		// dismissed with Escape or its close button — so a sentinel there consumes a real
		// browser control for nothing. Two of these three flags are also sticky across a
		// resize (`opened`, `drawerOpened` survive widening the window), which is how the
		// interception reached desktop even though the overlays themselves are mobile-only.
		const sources = await Promise.all(
			[
				"../components/AppRootLayout.tsx",
				"../routes/narrators/$narratorId.tsx",
				"../components/narrator/content/ContentViewer.tsx",
				"../hooks/useMobileDrawerHistory.ts",
			].map((path) => Bun.file(new URL(path, import.meta.url)).text()),
		);

		// All known call sites must be found, so a renamed/removed guard cannot make
		// the loop below pass by iterating over nothing.
		let guardedCallSites = 0;
		for (const source of sources) {
			for (const match of source.matchAll(/pushHistorySentinel\(/g)) {
				const guardWindow = source.slice(Math.max(0, match.index - 400), match.index);
				expect(guardWindow).toContain("isMobile");
				guardedCallSites++;
			}
		}
		expect(guardedCallSites).toBe(4);
	});
});
