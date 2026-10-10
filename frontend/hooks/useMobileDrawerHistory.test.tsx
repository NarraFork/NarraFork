import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	act,
	createContext,
	memo,
	StrictMode,
	useContext,
	useState,
	useSyncExternalStore,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "../lib/responsive";

const routerModule = { ...(await import("@tanstack/react-router")) };
const historyModule = { ...(await import("../lib/history-state")) };
type RouterHistory = ReturnType<typeof routerModule.createBrowserHistory>;
type BlockerInput = {
	action: string;
	currentLocation?: { href: string; state: { __NF_sentinel_id?: string; __TSR_index: number } };
	nextLocation?: { href: string; state: { __NF_sentinel_id?: string; __TSR_index: number } };
};
const blockers: Array<{ check: (input: BlockerInput) => boolean; disposed: number }> = [];
const history = {
	block(options: { blockerFn: (input: BlockerInput) => boolean }) {
		const blocker = { check: options.blockerFn, disposed: 0 };
		blockers.push(blocker);
		return () => {
			blocker.disposed++;
		};
	},
};
let router: { history: typeof history | RouterHistory } | undefined = { history };
const sentinels: Array<{ close: () => void; disposed: number }> = [];
mock.module("@tanstack/react-router", () => ({ ...routerModule, useRouter: () => router }));
mock.module("../lib/history-state", () => ({
	...historyModule,
	pushHistorySentinel(
		receivedHistory: RouterHistory,
		kind: Parameters<typeof historyModule.pushHistorySentinel>[1],
		close: () => void,
	) {
		if (receivedHistory !== (history as unknown)) {
			return historyModule.pushHistorySentinel(receivedHistory, kind, close);
		}
		expect(receivedHistory).toBe(history as unknown as RouterHistory);
		const entry = { close, disposed: 0 };
		sentinels.push(entry);
		return {
			dispose: () => {
				entry.disposed++;
			},
		};
	},
}));
const { useMobileDrawerHistory } = await import("./useMobileDrawerHistory");
const { useMobileViewport } = await import("./useMobileViewport");

let root: Root;
let host: HTMLElement;
let mobile: boolean;
let queries: number;
let bodyRenders: number;
const listeners = new Set<() => void>();
const originals = new Map<string, PropertyDescriptor | undefined>();
let restoreMatchMedia: () => void;
let browserHistory: RouterHistory | undefined;
const Mode = createContext(false);
const closeNoop = () => {};
const Body = memo(() => {
	bodyRenders++;
	useMobileDrawerHistory(false, closeNoop);
	useMobileDrawerHistory(false, closeNoop);
	return <output>{String(useContext(Mode))}</output>;
});
function RouteProbe() {
	return (
		<Mode.Provider value={useMobileViewport()}>
			<Body />
		</Mode.Provider>
	);
}
function Drawer({
	opened,
	close,
	canNavigate,
}: {
	opened: boolean;
	close: (() => void) | (() => boolean);
	canNavigate?: () => boolean;
}) {
	useMobileDrawerHistory(opened, close, canNavigate);
	return null;
}

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	mobile = false;
	queries = 0;
	bodyRenders = 0;
	listeners.clear();
	sentinels.length = 0;
	blockers.length = 0;
	router = { history };
	const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");
	restoreMatchMedia = () => {
		if (matchMediaDescriptor) Object.defineProperty(window, "matchMedia", matchMediaDescriptor);
		else Reflect.deleteProperty(window, "matchMedia");
	};
	window.matchMedia = (query: string) => {
		queries++;
		expect(query).toBe(MOBILE_VIEWPORT_MEDIA_QUERY);
		return {
			get matches() {
				return mobile;
			},
			media: query,
			addEventListener(_type: string, callback: () => void) {
				listeners.add(callback);
			},
			removeEventListener(_type: string, callback: () => void) {
				listeners.delete(callback);
			},
		} as unknown as MediaQueryList;
	};
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	host = document.body.appendChild(document.createElement("div"));
	root = createRoot(host);
});
afterEach(async () => {
	try {
		await act(async () => {
			root.unmount();
			await flushHistoryWork();
		});
		expect(listeners.size).toBe(0);
	} finally {
		browserHistory?.destroy();
		browserHistory = undefined;
		router = { history };
		restoreMatchMedia();
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		originals.clear();
	}
});
afterAll(() => {
	mock.module("@tanstack/react-router", () => routerModule);
	mock.module("../lib/history-state", () => historyModule);
});
async function changeViewport(value: boolean) {
	mobile = value;
	// Separate native MQL callbacks are separate browser turns. Do not batch the
	// whole loop in act: that would hide the old independent-subscription problem.
	for (const callback of [...listeners]) await act(async () => callback());
}

test("two closed drawers share the route snapshot without extra Body notifications", async () => {
	await act(async () => root.render(<RouteProbe />));
	expect(bodyRenders).toBe(1);
	expect(queries).toBe(1);
	expect(listeners.size).toBe(1);
	await changeViewport(true);
	expect(bodyRenders).toBe(2);
	expect(host.textContent).toBe("true");
	await changeViewport(false);
	expect(bodyRenders).toBe(3);
	expect(host.textContent).toBe("false");
	expect(sentinels).toEqual([]);
});

test("an open drawer creates a mobile sentinel, uses the latest closer and releases on widening", async () => {
	mobile = true;
	const closed: string[] = [];
	await act(async () => root.render(<Drawer opened close={() => closed.push("old")} />));
	expect(sentinels).toHaveLength(1);
	await act(async () => root.render(<Drawer opened close={() => closed.push("latest")} />));
	expect(sentinels).toHaveLength(1);
	sentinels[0]?.close();
	expect(closed).toEqual(["latest"]);
	await changeViewport(false);
	expect(sentinels[0]?.disposed).toBe(1);
	await changeViewport(true);
	expect(sentinels).toHaveLength(2);
	await act(async () => root.render(<Drawer opened={false} close={closeNoop} />));
	expect(sentinels[1]?.disposed).toBe(1);
});

test("rejected Back repeatedly re-arms history until the draft can close", async () => {
	mobile = true;
	let blocked = true;
	const close = mock(() => !blocked);
	await act(async () => root.render(<Drawer opened close={close} />));
	for (let attempt = 0; attempt < 3; attempt++) {
		expect(sentinels).toHaveLength(attempt + 1);
		await act(async () => sentinels[attempt]?.close());
		expect(sentinels[attempt]?.disposed).toBe(1);
		expect(sentinels).toHaveLength(attempt + 2);
	}
	blocked = false;
	await act(async () => sentinels[3]?.close());
	expect(close).toHaveBeenCalledTimes(4);
	expect(sentinels).toHaveLength(4);
	await act(async () => root.render(<Drawer opened={false} close={close} />));
	expect(sentinels[3]?.disposed).toBe(1);
});

test("route replacement uses the latest draft guard and releases its blocker on close", async () => {
	mobile = true;
	await act(async () => root.render(<Drawer opened close={closeNoop} canNavigate={() => false} />));
	expect(blockers).toHaveLength(1);
	expect(blockers[0]?.check({ action: "PUSH" })).toBe(true);
	expect(blockers[0]?.check({ action: "REPLACE" })).toBe(true);
	expect(
		blockers[0]?.check({
			action: "BACK",
			currentLocation: { href: "/editor", state: { __NF_sentinel_id: "drawer", __TSR_index: 2 } },
			nextLocation: { href: "/editor", state: { __TSR_index: 1 } },
		}),
	).toBe(false);
	expect(
		blockers[0]?.check({
			action: "GO",
			currentLocation: { href: "/editor", state: { __NF_sentinel_id: "drawer", __TSR_index: 2 } },
			nextLocation: { href: "/previous", state: { __TSR_index: 0 } },
		}),
	).toBe(true);
	await act(async () => root.render(<Drawer opened close={closeNoop} canNavigate={() => true} />));
	expect(blockers).toHaveLength(1);
	expect(blockers[0]?.check({ action: "PUSH" })).toBe(false);
	await act(async () => root.render(<Drawer opened={false} close={closeNoop} />));
	expect(blockers[0]?.disposed).toBe(1);
});

test("missing router history remains safe even for an initially mobile open drawer", async () => {
	mobile = true;
	router = undefined;
	await act(async () => root.render(<Drawer opened close={closeNoop} />));
	expect(sentinels).toEqual([]);
});

/** Native traversal is asynchronous; TanStack's real adapter owns blockers and rollback. */
function installBrowserHistory() {
	const entries = [{ href: "/previous", state: null as unknown }];
	let entryIndex = 0;
	let backCalls = 0;
	const location = { pathname: "/previous", search: "", hash: "" };
	const nativeListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
	const applyHref = (href: string) => {
		const parsed = new URL(href, "https://narrafork.test");
		location.pathname = parsed.pathname;
		location.search = parsed.search;
		location.hash = parsed.hash;
	};
	const nativeHistory = {
		get state() {
			return entries[entryIndex]?.state;
		},
		get length() {
			return entries.length;
		},
		pushState(state: unknown, _title: string, url = location.pathname) {
			entries.splice(entryIndex + 1, Infinity, { href: url, state });
			entryIndex++;
			applyHref(url);
		},
		replaceState(state: unknown, _title: string, url = location.pathname) {
			entries[entryIndex] = { href: url, state };
			applyHref(url);
		},
		go(delta: number) {
			setTimeout(() => {
				const next = Math.min(Math.max(entryIndex + delta, 0), entries.length - 1);
				if (next === entryIndex) return;
				entryIndex = next;
				applyHref(entries[next].href);
				const event = new Event("popstate");
				for (const listener of [...(nativeListeners.get("popstate") ?? [])]) {
					if (typeof listener === "function") listener(event);
					else listener.handleEvent(event);
				}
			}, 0);
		},
		back() {
			backCalls++;
			nativeHistory.go(-1);
		},
		forward() {
			nativeHistory.go(1);
		},
	};
	const browserWindow = {
		history: nativeHistory,
		location,
		matchMedia: window.matchMedia,
		addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
			if (!nativeListeners.has(type)) nativeListeners.set(type, new Set());
			nativeListeners.get(type)?.add(listener);
		},
		removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
			nativeListeners.get(type)?.delete(listener);
		},
	};
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		writable: true,
		value: browserWindow,
	});
	const realHistory = routerModule.createBrowserHistory({ window: browserWindow });
	browserHistory = realHistory;
	router = { history: realHistory };
	let activeBlockers = 0;
	const originalBlock = realHistory.block.bind(realHistory);
	realHistory.block = (blocker) => {
		activeBlockers++;
		const unblock = originalBlock(blocker);
		return () => {
			activeBlockers--;
			unblock();
		};
	};
	realHistory.push("/editor");
	realHistory.flush();
	return {
		history: realHistory,
		nativeHistory,
		entries,
		index: () => entryIndex,
		backCalls: () => backCalls,
		activeBlockers: () => activeBlockers,
	};
}

async function flushHistoryWork() {
	for (let turn = 0; turn < 6; turn++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function EditorRoute({
	history: realHistory,
	close,
	canNavigate,
}: {
	history: RouterHistory;
	close: () => boolean;
	canNavigate?: () => boolean;
}) {
	const href = useSyncExternalStore(
		(listener) => realHistory.subscribe(listener),
		() => realHistory.location.href,
	);
	return href === "/editor" ? <DraftDrawer close={close} canNavigate={canNavigate} /> : null;
}

function DraftDrawer({
	close,
	canNavigate,
}: {
	close: () => boolean;
	canNavigate?: () => boolean;
}) {
	const [opened, setOpened] = useState(true);
	useMobileDrawerHistory(
		opened,
		() => {
			if (!close()) return false;
			setOpened(false);
			return true;
		},
		canNavigate,
	);
	return opened ? <textarea defaultValue="unsaved draft" /> : null;
}

for (const accept of [false, true]) {
	test(`dirty mobile drawer widened before native Back ${accept ? "accepts" : "rejects"} leaving`, async () => {
		mobile = true;
		const browser = installBrowserHistory();
		const canNavigate = mock(() => accept);
		const close = mock(() => false);
		await act(async () =>
			root.render(<EditorRoute {...browser} close={close} canNavigate={canNavigate} />),
		);
		expect(browser.index()).toBe(2);
		const draft = host.querySelector("textarea");
		if (!draft) throw new Error("Draft editor did not mount");
		draft.value = "edited unsaved text";
		await changeViewport(false);
		await act(flushHistoryWork);
		expect(browser.index()).toBe(1);
		expect(close).not.toHaveBeenCalled();
		await act(async () => {
			browser.nativeHistory.back();
			await flushHistoryWork();
		});
		expect(canNavigate).toHaveBeenCalledTimes(1);
		expect(browser.history.location.href).toBe(accept ? "/previous" : "/editor");
		expect(browser.index()).toBe(accept ? 0 : 1);
		expect(host.querySelector("textarea") !== null).toBe(!accept);
		if (!accept) {
			expect(host.querySelector("textarea")).toBe(draft);
			expect(draft.value).toBe("edited unsaved text");
		}
		expect(browser.activeBlockers()).toBe(accept ? 0 : 1);
	});
}

test("clean widened drawer leaves on Back without closing or creating desktop entries", async () => {
	mobile = true;
	const browser = installBrowserHistory();
	const close = mock(() => true);
	const canNavigate = mock(() => true);
	await act(async () =>
		root.render(<EditorRoute {...browser} close={close} canNavigate={canNavigate} />),
	);
	await changeViewport(false);
	await act(flushHistoryWork);
	expect(browser.index()).toBe(1);
	expect(browser.entries).toHaveLength(3);
	await act(async () => {
		browser.history.back();
		await flushHistoryWork();
	});
	expect(browser.history.location.href).toBe("/previous");
	expect(canNavigate).toHaveBeenCalledTimes(1);
	expect(close).not.toHaveBeenCalled();
	expect(browser.activeBlockers()).toBe(0);
});

test("mobile Back consumes only its sentinel and rejected closes re-arm without route prompts", async () => {
	mobile = true;
	const browser = installBrowserHistory();
	let accept = false;
	const close = mock(() => accept);
	const canNavigate = mock(() => false);
	await act(async () =>
		root.render(<EditorRoute {...browser} close={close} canNavigate={canNavigate} />),
	);
	for (let attempt = 0; attempt < 3; attempt++) {
		await act(async () => {
			browser.nativeHistory.back();
			await flushHistoryWork();
		});
		expect(close).toHaveBeenCalledTimes(attempt + 1);
		expect(browser.index()).toBe(2);
		expect(browser.entries).toHaveLength(3);
		expect(browser.history.location.href).toBe("/editor");
		expect(canNavigate).not.toHaveBeenCalled();
	}
	accept = true;
	await act(async () => {
		browser.nativeHistory.back();
		await flushHistoryWork();
	});
	expect(host.querySelector("textarea")).toBeNull();
	expect(browser.index()).toBe(1);
	expect(browser.activeBlockers()).toBe(0);
});

test("native sentinel POP uses the latest closer without replacing its entry", async () => {
	mobile = true;
	const browser = installBrowserHistory();
	const oldClose = mock(() => false);
	const latestClose = mock(() => true);
	await act(async () => root.render(<EditorRoute {...browser} close={oldClose} />));
	const sentinelId = browser.history.location.state.__NF_sentinel_id;
	await act(async () => root.render(<EditorRoute {...browser} close={latestClose} />));
	expect(browser.history.location.state.__NF_sentinel_id).toBe(sentinelId);
	await act(async () => {
		browser.nativeHistory.back();
		await flushHistoryWork();
	});
	expect(oldClose).not.toHaveBeenCalled();
	expect(latestClose).toHaveBeenCalledTimes(1);
	expect(host.querySelector("textarea")).toBeNull();
	expect(browser.index()).toBe(1);
	expect(browser.activeBlockers()).toBe(0);
});

test("two native Back attempts before re-arm cannot navigate away from a dirty drawer", async () => {
	mobile = true;
	const browser = installBrowserHistory();
	const close = mock(() => false);
	const canNavigate = mock(() => false);
	await act(async () =>
		root.render(<EditorRoute {...browser} close={close} canNavigate={canNavigate} />),
	);
	const draft = host.querySelector("textarea");
	if (!draft) throw new Error("Draft editor did not mount");
	draft.value = "edited unsaved text";
	await act(async () => {
		browser.nativeHistory.back();
		browser.nativeHistory.back();
		await flushHistoryWork();
	});
	await act(flushHistoryWork);
	expect(browser.history.location.href).toBe("/editor");
	expect(browser.index()).toBe(2);
	expect(browser.entries).toHaveLength(3);
	expect(close).toHaveBeenCalledTimes(1);
	expect(canNavigate).toHaveBeenCalledTimes(1);
	expect(host.querySelector("textarea")).toBe(draft);
	expect(draft.value).toBe("edited unsaved text");
});

test("desktop route PUSH and REPLACE use the latest guard without a sentinel", async () => {
	const browser = installBrowserHistory();
	const close = mock(() => true);
	const rejectedGuard = mock(() => false);
	await act(async () => root.render(<Drawer opened close={close} canNavigate={rejectedGuard} />));
	for (const action of ["push", "replace"] as const) {
		await act(async () => {
			browser.history[action]("/next");
			await flushHistoryWork();
		});
		expect(browser.history.location.href).toBe("/editor");
		expect(browser.index()).toBe(1);
		expect(browser.entries).toHaveLength(2);
	}
	expect(rejectedGuard).toHaveBeenCalledTimes(2);
	const acceptedGuard = mock(() => true);
	await act(async () => root.render(<Drawer opened close={close} canNavigate={acceptedGuard} />));
	await act(async () => {
		browser.history.replace("/next");
		await flushHistoryWork();
	});
	expect(acceptedGuard).toHaveBeenCalledTimes(1);
	expect(browser.history.location.href).toBe("/next");
	expect(browser.index()).toBe(1);
	expect(browser.backCalls()).toBe(0);
	expect(close).not.toHaveBeenCalled();
	await act(async () => root.render(<Drawer opened={false} close={close} />));
	expect(browser.activeBlockers()).toBe(0);
});

test("an unguarded desktop drawer preserves ordinary Back without closing or pushing history", async () => {
	const browser = installBrowserHistory();
	const close = mock(() => false);
	await act(async () => root.render(<EditorRoute {...browser} close={close} />));
	expect(browser.entries).toHaveLength(2);
	await act(async () => {
		browser.nativeHistory.back();
		await flushHistoryWork();
	});
	expect(browser.history.location.href).toBe("/previous");
	expect(host.querySelector("textarea")).toBeNull();
	expect(close).not.toHaveBeenCalled();
	expect(browser.entries).toHaveLength(2);
	expect(browser.activeBlockers()).toBe(0);
});

test("resize round trips and StrictMode quick reopen share at most one mobile sentinel", async () => {
	mobile = true;
	const browser = installBrowserHistory();
	const close = mock(() => false);
	const canNavigate = mock(() => false);
	const drawer = (
		<StrictMode>
			<Drawer opened close={close} canNavigate={canNavigate} />
		</StrictMode>
	);
	await act(async () => {
		root.render(drawer);
		await flushHistoryWork();
	});
	for (let attempt = 0; attempt < 3; attempt++) {
		await changeViewport(false);
		await changeViewport(true);
		await act(flushHistoryWork);
		expect(browser.index()).toBe(2);
		expect(browser.entries).toHaveLength(3);
		expect(browser.activeBlockers()).toBe(2);
	}
	await act(async () =>
		root.render(
			<StrictMode>
				<Drawer opened={false} close={close} />
			</StrictMode>,
		),
	);
	await act(async () => root.render(drawer));
	await act(flushHistoryWork);
	expect(browser.index()).toBe(2);
	expect(browser.entries).toHaveLength(3);
	await act(async () => root.render(null));
	await act(flushHistoryWork);
	expect(browser.index()).toBe(1);
	expect(browser.activeBlockers()).toBe(0);
	expect(browser.history.subscribers.size).toBe(0);
	expect(close).not.toHaveBeenCalled();
	expect(canNavigate).not.toHaveBeenCalled();
});
