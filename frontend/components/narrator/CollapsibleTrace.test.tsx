import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import type React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const realLazyCollapseModule = { ...(await import("./LazyCollapse")) };
const realMessageSelectionModule = { ...(await import("./MessageSelectionCtx")) };
const realUsePlatformModule = { ...(await import("@frontend/hooks/usePlatform")) };
mock.module("./LazyCollapse", () => ({
	LazyCollapse: ({ in: opened, children }: { in: boolean; children: React.ReactNode }) =>
		opened ? children : null,
}));

// The row interaction wrapper pulls in usePlatform (react-query backed) and the
// swipe hook; stub both so this file needs no QueryClientProvider and the menu
// stays closed (these tests only exercise click semantics).
mock.module("@frontend/hooks/usePlatform", () => ({
	...realUsePlatformModule,
	usePlatform: () => "linux",
}));
mock.module("@frontend/hooks/useSwipeMenu", () => ({
	useSwipeMenu: () => ({
		swipeBoxRef: { current: null },
		swipeMenuRef: { current: null },
		swipeOffset: 0,
		swipeRevealed: false,
		swipeClosing: false,
		closeSwipe: () => {},
		ctxMenuOpened: false,
		setCtxMenuOpened: () => {},
		ctxMenuPos: { x: 0, y: 0, flipY: false },
		setCtxMenuPos: () => {},
		swipeStyle: {},
		swipeTransition: "",
		swipeMenuTransition: "",
		getSwipeMenuPosition: () => ({ left: 0, top: 0 }),
	}),
}));
mock.module("@mantine/hooks", () => ({
	useMediaQuery: () => false,
	useClipboard: () => ({ copy: () => {}, copied: false, reset: () => {} }),
	useDisclosure: (initial = false) => [
		initial,
		{ open: () => {}, close: () => {}, toggle: () => {} },
	],
}));

// Selection hooks used by the row interaction wrapper. Recorded so the
// modifier-click tests can assert what the row asked the selection system to do.
const toggleBlockMock = mock((_blockId: string) => {});
const rangeSelectToMock = mock((_blockId: string) => {});
mock.module("./MessageSelectionCtx", () => ({
	...realMessageSelectionModule,
	shouldIgnoreMessageBlockSelection: () => false,
	useMessageSelection: () => ({
		selectionMode: false,
		selectedBlockIds: new Set<string>(),
		anchorBlockId: null,
		exitSelection: () => {},
		deselectBlock: () => {},
		toggleBlock: toggleBlockMock,
		rangeSelectTo: rangeSelectToMock,
	}),
}));

const { CollapsibleTrace } = await import("./CollapsibleTrace");
type TraceRowIdentity = import("./trace-row-identity").TraceRowIdentity;

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const matchMedia = (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	});
	const requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0);
	const cancelAnimationFrame = (id: number) => clearTimeout(id);
	Object.defineProperties(window, {
		requestAnimationFrame: { configurable: true, writable: true, value: requestAnimationFrame },
		cancelAnimationFrame: { configurable: true, writable: true, value: cancelAnimationFrame },
		matchMedia: { configurable: true, writable: true, value: matchMedia },
	});
	// linkedom has no Selection API; the row interaction wrapper consults it to
	// avoid hijacking an active text selection. Report "nothing selected".
	const getSelection = () => ({ rangeCount: 0, isCollapsed: true, removeAllRanges() {} });
	Object.defineProperty(window, "getSelection", {
		configurable: true,
		writable: true,
		value: getSelection,
	});
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		ResizeObserver: TestResizeObserver,
		matchMedia,
		requestAnimationFrame,
		cancelAnimationFrame,
		getSelection,
		getComputedStyle: window.getComputedStyle?.bind(window) ?? (() => ({})),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
		if (descriptor && !descriptor.configurable) {
			if ("writable" in descriptor && descriptor.writable) Reflect.set(globalThis, key, value);
			continue;
		}
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
}

beforeEach(() => {
	installDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	toggleBlockMock.mockClear();
	rangeSelectToMock.mockClear();
});

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
});

afterAll(() => {
	mock.module("./LazyCollapse", () => realLazyCollapseModule);
	mock.module("./MessageSelectionCtx", () => realMessageSelectionModule);
	mock.restore();
});

describe("CollapsibleTrace row layout", () => {
	test("keeps icon slots and height constraints identical with or without icons", async () => {
		await act(async () => {
			root?.render(
				<MantineProvider>
					<CollapsibleTrace
						items={[
							{ key: "hidden", title: "Hidden" },
							{ key: "with-icon", title: "With icon", icon: <span>i</span> },
							{ key: "without-icon", title: "Without icon" },
						]}
						headerIcon={<span>h</span>}
						headerColor="grape"
						headerLabel="Trace"
						headerCount="3 rows"
						maxVisible={2}
						showEarlierLabel={(count) => `Show ${count} earlier`}
						hideEarlierLabel="Hide earlier"
					/>
				</MantineProvider>,
			);
		});

		const rows = Array.from(
			container?.querySelectorAll<HTMLElement>('[data-testid="collapsible-trace-row"]') ?? [],
		);
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.style.minHeight)).toEqual(["18px", "18px"]);
		expect(
			rows.map((row) => row.querySelector<HTMLElement>("[data-trace-title]")?.style.lineHeight),
		).toEqual(["16px", "16px"]);

		const iconSlots = rows.map((row) => row.querySelector<HTMLElement>("[data-trace-icon-slot]"));
		expect(iconSlots.every((slot) => slot?.style.width === "14px")).toBe(true);
		expect(iconSlots[0]?.childElementCount).toBe(1);
		expect(iconSlots[1]?.childElementCount).toBe(0);

		const earlierRow = container?.querySelector<HTMLElement>(
			'[data-testid="collapsible-trace-earlier-row"]',
		);
		expect(earlierRow?.style.minHeight).toBe("18px");
		expect(earlierRow?.querySelector<HTMLElement>("[data-trace-icon-slot]")?.style.width).toBe(
			"14px",
		);
		expect(earlierRow?.querySelector<HTMLElement>("[data-trace-title]")?.style.lineHeight).toBe(
			"16px",
		);
	});
});

/**
 * A folded row is BOTH a toggle (chevron expand) and a selectable block. A plain
 * click must expand; a Ctrl/Cmd or Shift click must select WITHOUT expanding, or
 * users would fight the card opening every time they multi-select.
 */
describe("CollapsibleTrace row selection vs expand", () => {
	const IDENTITY: TraceRowIdentity = {
		blockId: "msg-m1-0",
		messageId: "m1",
		blockIndex: 0,
		blockIndices: [0],
	};

	async function renderRow(opts: { withIdentity: boolean }) {
		await act(async () => {
			root?.render(
				<MantineProvider>
					<CollapsibleTrace
						items={[
							{
								key: "row",
								title: "Expandable row",
								body: <span data-testid="row-body">body</span>,
								...(opts.withIdentity ? { identity: IDENTITY, actions: { messageId: "m1" } } : {}),
							},
						]}
						headerIcon={<span>h</span>}
						headerColor="grape"
						headerLabel="Trace"
						headerCount="1 row"
						showEarlierLabel={(count) => `Show ${count} earlier`}
						hideEarlierLabel="Hide earlier"
					/>
				</MantineProvider>,
			);
		});
	}

	function rowEl(): HTMLElement {
		const row = container?.querySelector<HTMLElement>('[data-testid="collapsible-trace-row"]');
		if (!row) throw new Error("row not rendered");
		return row;
	}

	/**
	 * Dispatch a click carrying modifier keys. linkedom's Event does not accept a
	 * MouseEventInit, so the modifier flags are assigned onto the event object —
	 * React reads them straight off the native event.
	 */
	async function clickRow(modifiers: { ctrlKey?: boolean; shiftKey?: boolean } = {}) {
		await act(async () => {
			const event = new Event("click", { bubbles: true }) as Event & Record<string, unknown>;
			event.ctrlKey = modifiers.ctrlKey ?? false;
			event.metaKey = false;
			event.shiftKey = modifiers.shiftKey ?? false;
			rowEl().dispatchEvent(event);
		});
	}

	const bodyVisible = () => !!container?.querySelector('[data-testid="row-body"]');

	test("a plain click still expands the row", async () => {
		await renderRow({ withIdentity: true });
		expect(bodyVisible()).toBe(false);
		await clickRow();
		expect(bodyVisible()).toBe(true);
		expect(toggleBlockMock).not.toHaveBeenCalled();
	});

	test("Ctrl+Click selects the block instead of expanding", async () => {
		await renderRow({ withIdentity: true });
		await clickRow({ ctrlKey: true });
		expect(toggleBlockMock).toHaveBeenCalledWith("msg-m1-0");
		expect(bodyVisible()).toBe(false);
	});

	test("Shift+Click range-selects instead of expanding", async () => {
		await renderRow({ withIdentity: true });
		await clickRow({ shiftKey: true });
		expect(rangeSelectToMock).toHaveBeenCalledWith("msg-m1-0");
		expect(bodyVisible()).toBe(false);
	});

	test("a row without an identity keeps the old behaviour and expands on any click", async () => {
		await renderRow({ withIdentity: false });
		expect(container?.querySelector("[data-block-id]")).toBeNull();
		await clickRow({ ctrlKey: true });
		expect(toggleBlockMock).not.toHaveBeenCalled();
		expect(bodyVisible()).toBe(true);
	});
});
