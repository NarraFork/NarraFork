import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, createContext, memo, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "../lib/responsive";

const routerModule = await import("@tanstack/react-router");
const historyModule = await import("../lib/history-state");
const history = {};
let router: { history: typeof history } | undefined = { history };
const sentinels: Array<{ close: () => void; disposed: number }> = [];
mock.module("@tanstack/react-router", () => ({ ...routerModule, useRouter: () => router }));
mock.module("../lib/history-state", () => ({
	...historyModule,
	pushHistorySentinel(receivedHistory: unknown, _kind: string, close: () => void) {
		expect(receivedHistory).toBe(history);
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
function Drawer({ opened, close }: { opened: boolean; close: () => void }) {
	useMobileDrawerHistory(opened, close);
	return null;
}

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	mobile = false;
	queries = 0;
	bodyRenders = 0;
	listeners.clear();
	sentinels.length = 0;
	router = { history };
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
	await act(async () => root.unmount());
	expect(listeners.size).toBe(0);
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
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

test("missing router history remains safe even for an initially mobile open drawer", async () => {
	mobile = true;
	router = undefined;
	await act(async () => root.render(<Drawer opened close={closeNoop} />));
	expect(sentinels).toEqual([]);
});
