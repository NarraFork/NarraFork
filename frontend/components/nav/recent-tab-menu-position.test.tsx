/**
 * The row menu stays on screen when it grows while open. A swipe released near the bottom opens
 * the touch menu with the row's details on top; a project's details arrive after it opened
 * (`refreshProjectTabDetails`), the menu gets taller, and it must move up (or scroll) so its last
 * action stays reachable. The bug this pins: the position was measured only when the menu or the
 * pointer changed, and the height cap was the whole viewport, not the room below the menu.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import type { RecentTab } from "../../hooks/recent-tabs-utils";
import { api } from "../../lib/api";
import commonEn from "../../locales/en/common.json";
import { placeRecentTabMenu, TabContextMenu } from "./RecentTabMenu";

const VIEW_HEIGHT = 800;
const GAP = 8;
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { common: commonEn } } });

let root: Root;
let host: HTMLElement;
let client: QueryClient;
let restoreDom: () => void;
let observers: Array<{ callback: () => void; disconnected: boolean; observed: unknown[] }>;

/** A layout stand-in: each action is 28px, the details 20px, or 140px once they hold counts. */
function contentHeight(element: Element): number {
	const actions = element.querySelectorAll("button").length;
	const details = element.textContent?.includes("session(s) running") ? 140 : 20;
	return actions * 28 + details;
}

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	Object.assign(window, { innerWidth: 400, innerHeight: VIEW_HEIGHT });
	observers = [];
	class FakeResizeObserver {
		entry: { callback: () => void; disconnected: boolean; observed: unknown[] };
		constructor(callback: () => void) {
			this.entry = { callback, disconnected: false, observed: [] };
			observers.push(this.entry);
		}
		observe(target: unknown) {
			this.entry.observed.push(target);
		}
		disconnect() {
			this.entry.disconnected = true;
		}
	}
	Object.assign(window, { ResizeObserver: FakeResizeObserver });
	const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
	proto.getBoundingClientRect = function (this: Element) {
		const height = Math.min(contentHeight(this), VIEW_HEIGHT - 2 * GAP);
		return { width: 200, height, top: 0, left: 0, right: 200, bottom: height, x: 0, y: 0 };
	};
	Object.defineProperty(proto, "scrollHeight", {
		configurable: true,
		get(this: Element) {
			return contentHeight(this);
		},
	});
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		IS_REACT_ACT_ENVIRONMENT: true,
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
	notifyManager.setScheduler(queueMicrotask);
	// The details' own read stays pending; the test hands the details in through the tab.
	spyOn(api, "getRecentTabsRuntime").mockImplementation(() => new Promise(() => {}));
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(["user-preferences"], {});
	host = window.document.createElement("div");
	window.document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	notifyManager.setScheduler((callback) => setTimeout(callback, 0));
	mock.restore();
	restoreDom();
});

const noop = () => {};
const project: RecentTab = { type: "project", id: "p1", title: "Acme App", lastVisitedAt: 1 };

function renderMenu(detailsTab: RecentTab, y: number) {
	return root.render(
		<QueryClientProvider client={client}>
			<I18nextProvider i18n={i18n}>
				<MantineProvider>
					<TabContextMenu
						x={10}
						y={y}
						onClose={noop}
						onMoveToTop={noop}
						onPin={noop}
						isPinned={false}
						onRemove={noop}
						onReveal={noop}
						canReveal={false}
						onNewNarratorHere={noop}
						canNewNarratorHere
						onCopyCwd={noop}
						canCopyCwd={false}
						onOpenInWindow={noop}
						canOpenInWindow
						onRename={noop}
						canRename={false}
						onArchive={noop}
						canArchive={false}
						isFirst={false}
						pinScope="list"
						folder={null}
						onLeaveFolder={null}
						gitIdentityNarratorId={null}
						gitIdentityFolderId={null}
						detailsTab={detailsTab}
						t={(key) => key}
					/>
				</MantineProvider>
			</I18nextProvider>
		</QueryClientProvider>,
	);
}

function menu(): HTMLElement {
	const node = host.querySelector<HTMLElement>("[data-nav-keep-open]");
	if (!node) throw new Error("menu not rendered");
	return node;
}

/** Where the menu's last action ends, as laid out: its top plus its (capped) height. */
function bottomOfMenu() {
	const top = Number.parseFloat(menu().style.top);
	const maxHeight = Number.parseFloat(menu().style.maxHeight);
	return { top, maxHeight, bottom: top + Math.min(contentHeight(menu()), maxHeight) };
}

describe("a row menu near the bottom edge", () => {
	test("moves up when the project's details arrive while it is open", async () => {
		await act(async () => renderMenu(project, 760));
		const before = bottomOfMenu();
		expect(before.bottom).toBeLessThanOrEqual(VIEW_HEIGHT - GAP);
		expect(observers).toHaveLength(1);
		expect(observers[0]?.observed.length).toBeGreaterThanOrEqual(1);

		// The details land: the same menu, taller.
		await act(async () =>
			renderMenu(
				{
					...project,
					projectPath: "/repos/acme-app",
					activeSessionCount: 2,
					waitingSessionCount: 1,
					teamCount: 1,
				},
				760,
			),
		);
		expect(menu().textContent).toContain("2 session(s) running");
		// The size change is what re-places it.
		await act(async () => observers[0]?.callback());
		const after = bottomOfMenu();
		expect(after.top).toBeLessThan(before.top);
		expect(after.bottom).toBeLessThanOrEqual(VIEW_HEIGHT - GAP);
		// The cap is the room below its top, not the whole viewport.
		expect(after.maxHeight).toBe(VIEW_HEIGHT - GAP - after.top);
	});

	test("the observer is disconnected when the menu closes", async () => {
		await act(async () => renderMenu(project, 760));
		await act(async () => root.render(null));
		expect(observers.every((observer) => observer.disconnected)).toBe(true);
	});
});

describe("placeRecentTabMenu", () => {
	const view = { viewWidth: 400, viewHeight: VIEW_HEIGHT };

	test("opens at the pointer when it fits, flips up when it does not", () => {
		expect(placeRecentTabMenu({ x: 10, y: 100, width: 200, height: 300, ...view })).toEqual({
			left: 10,
			top: 100,
			maxHeight: VIEW_HEIGHT - GAP - 100,
		});
		expect(placeRecentTabMenu({ x: 10, y: 700, width: 200, height: 300, ...view }).top).toBe(400);
		// Flipped left near the right edge.
		expect(placeRecentTabMenu({ x: 390, y: 10, width: 200, height: 100, ...view }).left).toBe(190);
	});

	test("a menu taller than the room above and below is clamped and scrolls", () => {
		const placed = placeRecentTabMenu({ x: 10, y: 400, width: 200, height: 2000, ...view });
		expect(placed.top).toBe(GAP);
		expect(placed.maxHeight).toBe(VIEW_HEIGHT - 2 * GAP);
		// Never past the bottom edge, whatever the pointer.
		const low = placeRecentTabMenu({ x: 10, y: 790, width: 200, height: 500, ...view });
		expect(low.top + Math.min(500, low.maxHeight)).toBeLessThanOrEqual(VIEW_HEIGHT - GAP);
	});
});
