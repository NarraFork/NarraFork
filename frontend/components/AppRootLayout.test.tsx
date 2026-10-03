import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "../lib/responsive";

const routerModule = await import("@tanstack/react-router");
const historyModule = await import("../lib/history-state");
const history = {};
const sentinels: Array<{ history: unknown; kind: string; close: () => void; disposed: number }> =
	[];
mock.module("@tanstack/react-router", () => ({ ...routerModule, useRouter: () => ({ history }) }));
mock.module("../lib/history-state", () => ({
	...historyModule,
	pushHistorySentinel(history: unknown, kind: string, close: () => void) {
		const sentinel = { history, kind, close, disposed: 0 };
		sentinels.push(sentinel);
		return {
			dispose: () => {
				sentinel.disposed++;
			},
		};
	},
}));
const { MobileNavbarEffects } = await import("./AppRootLayout");

let root: Root;
let mobile: boolean;
let parentRenders: number;
let navbarRenders: number;
let openCalls: number;
let closeCalls: number;
const listeners = new Set<(event: MediaQueryListEvent) => void>();
const originals = new Map<string, PropertyDescriptor | undefined>();

function NavbarProbe() {
	navbarRenders++;
	return <div data-navbar />;
}

function Shell({
	wizardOpen = false,
	initiallyOpened = false,
}: {
	wizardOpen?: boolean;
	initiallyOpened?: boolean;
}) {
	parentRenders++;
	const [opened, setOpened] = useState(initiallyOpened);
	const openNav = useCallback(() => {
		openCalls++;
		setOpened(true);
	}, []);
	const closeNav = useCallback(() => {
		closeCalls++;
		setOpened(false);
	}, []);
	return (
		<>
			<MobileNavbarEffects
				wizardOpen={wizardOpen}
				opened={opened}
				openNav={openNav}
				closeNav={closeNav}
			/>
			<NavbarProbe />
			<output>{String(opened)}</output>
		</>
	);
}

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const query = {
		get matches() {
			return mobile;
		},
		media: MOBILE_VIEWPORT_MEDIA_QUERY,
		addEventListener(_name: string, listener: (event: MediaQueryListEvent) => void) {
			listeners.add(listener);
		},
		removeEventListener(_name: string, listener: (event: MediaQueryListEvent) => void) {
			listeners.delete(listener);
		},
	};
	window.matchMedia = (requested) => {
		expect(requested).toBe(MOBILE_VIEWPORT_MEDIA_QUERY);
		return query as unknown as MediaQueryList;
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
	mobile = false;
	parentRenders = 0;
	navbarRenders = 0;
	openCalls = 0;
	closeCalls = 0;
	sentinels.length = 0;
	listeners.clear();
	root = createRoot(document.body.appendChild(document.createElement("div")));
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

async function render(props: Parameters<typeof Shell>[0] = {}) {
	await act(async () => root.render(<Shell {...props} />));
}

async function resize(next: boolean) {
	await act(async () => {
		mobile = next;
		for (const listener of [...listeners]) listener({ matches: next } as MediaQueryListEvent);
	});
}

test("closed-nav breakpoint changes never rerender the shell or navbar", async () => {
	await render();
	for (const next of [true, false, true, false]) await resize(next);
	expect(parentRenders).toBe(1);
	expect(navbarRenders).toBe(1);
	expect(sentinels).toHaveLength(0);
	expect(openCalls).toBe(0);
	expect(closeCalls).toBe(0);
});

test("an initially-open desktop navbar does not create a mobile history sentinel", async () => {
	await render({ initiallyOpened: true });
	expect(sentinels).toHaveLength(0);
	expect(parentRenders).toBe(1);
});

test("initial mobile state registers exactly one sentinel with the router history", async () => {
	mobile = true;
	await render({ initiallyOpened: true });
	expect(sentinels).toHaveLength(1);
	expect(sentinels[0].history).toBe(history);
	expect(sentinels[0].kind).toBe(historyModule.APP_HISTORY_SENTINEL.mobileNav);
	expect(sentinels[0].disposed).toBe(0);
});

test("widening disposes the sentinel without clearing sticky opened state; narrowing registers again", async () => {
	mobile = true;
	await render({ initiallyOpened: true });
	await resize(false);
	expect(sentinels[0].disposed).toBe(1);
	expect(closeCalls).toBe(0);
	expect(document.querySelector("output")?.textContent).toBe("true");
	await resize(true);
	expect(sentinels).toHaveLength(2);
	expect(sentinels[1].disposed).toBe(0);
	expect(parentRenders).toBe(1);
	expect(navbarRenders).toBe(1);
});

test("wizard opens the navbar only on mobile and subsequent widening cleans up history", async () => {
	await render({ wizardOpen: true });
	expect(openCalls).toBe(0);
	await resize(true);
	expect(openCalls).toBe(1);
	expect(document.querySelector("output")?.textContent).toBe("true");
	expect(sentinels).toHaveLength(1);
	await resize(false);
	expect(openCalls).toBe(1);
	expect(sentinels[0].disposed).toBe(1);
});

test("the mobile Back callback closes nav and disposes its registration", async () => {
	mobile = true;
	await render({ initiallyOpened: true });
	await act(async () => sentinels[0].close());
	expect(closeCalls).toBe(1);
	expect(document.querySelector("output")?.textContent).toBe("false");
	expect(sentinels[0].disposed).toBe(1);
	await resize(false);
	await resize(true);
	expect(sentinels).toHaveLength(1);
});
