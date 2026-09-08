import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Indicator, MantineProvider, Menu, Modal } from "@mantine/core";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { SAFE_AREA_INSET_LEFT, SAFE_AREA_INSET_RIGHT } from "../../lib/safe-area";
import enNarrator from "../../locales/en/narrator.json";
import zhNarrator from "../../locales/zh-CN/narrator.json";
import {
	BackgroundTasksStatusButton,
	NARRATOR_STATUS_RESERVED_TEXT_WIDTH_PX,
	NARRATOR_STATUS_ROW_MIN_HEIGHT_PX,
	NarratorStatusBar,
	NarratorStatusToolbar,
	type NarratorStatusToolbarAction,
	resolveNarratorStatusToolbarOverflow,
} from "./NarratorStatusToolbar";

const measuredActions = [
	{ key: "path", width: 48, collapsePriority: 10 },
	{ key: "relaxed", width: 28, collapsePriority: 20 },
	{ key: "promote", width: 48, collapsePriority: 30 },
	{ key: "terminal", width: 33, collapsePriority: 40 },
] as const;

// leading 112 + 48 + 28 + 48 + 33 + 4 gaps * 4 = 285
const ALL_INLINE_WIDTH = 285;

describe("resolveNarratorStatusToolbarOverflow", () => {
	test("keeps the existing inline layout when every action fits", () => {
		expect(
			resolveNarratorStatusToolbarOverflow({
				budgetWidth: ALL_INLINE_WIDTH,
				leadingWidth: 112,
				actions: measuredActions,
			}),
		).toEqual([]);
	});

	test("reserves the more button and collapses actions in priority order", () => {
		expect(
			resolveNarratorStatusToolbarOverflow({
				budgetWidth: 275,
				leadingWidth: 112,
				actions: measuredActions,
			}),
		).toEqual(["path"]);
		expect(
			resolveNarratorStatusToolbarOverflow({
				budgetWidth: 240,
				leadingWidth: 112,
				actions: measuredActions,
			}),
		).toEqual(["path", "relaxed"]);
		expect(
			resolveNarratorStatusToolbarOverflow({
				budgetWidth: 200,
				leadingWidth: 112,
				actions: measuredActions,
			}),
		).toEqual(["path", "relaxed", "promote"]);
		expect(
			resolveNarratorStatusToolbarOverflow({
				budgetWidth: 140,
				leadingWidth: 112,
				actions: measuredActions,
			}),
		).toEqual(["path", "relaxed", "promote", "terminal"]);
	});

	test("recomputing at a wider width restores every action", () => {
		const narrow = resolveNarratorStatusToolbarOverflow({
			budgetWidth: 240,
			leadingWidth: 112,
			actions: measuredActions,
		});
		const restored = resolveNarratorStatusToolbarOverflow({
			// Restoring must clear the inline requirement by the hysteresis margin.
			budgetWidth: ALL_INLINE_WIDTH + 8,
			leadingWidth: 112,
			actions: measuredActions,
			previousHiddenKeys: narrow,
		});

		expect(narrow).toEqual(["path", "relaxed"]);
		expect(restored).toEqual([]);
	});

	test("is a fixed point: feeding a decision back at the same budget does not collapse further", () => {
		// Regression for the cascade bug: the budget must be independent of the
		// current layout, and re-resolving must reproduce the same answer.
		for (const budgetWidth of [ALL_INLINE_WIDTH, 275, 240, 200, 140]) {
			let hidden = resolveNarratorStatusToolbarOverflow({
				budgetWidth,
				leadingWidth: 112,
				actions: measuredActions,
			});
			for (let pass = 0; pass < 5; pass++) {
				const next = resolveNarratorStatusToolbarOverflow({
					budgetWidth,
					leadingWidth: 112,
					actions: measuredActions,
					previousHiddenKeys: hidden,
				});
				expect(next).toEqual(hidden);
				hidden = next;
			}
		}
	});

	test("applies hysteresis so a marginal budget never oscillates", () => {
		// 275 collapses "path"; restoring it needs 285 plus the restore margin.
		const collapsed = resolveNarratorStatusToolbarOverflow({
			budgetWidth: 275,
			leadingWidth: 112,
			actions: measuredActions,
		});
		expect(collapsed).toEqual(["path"]);

		// Just clearing the raw requirement is not enough to restore.
		expect(
			resolveNarratorStatusToolbarOverflow({
				budgetWidth: ALL_INLINE_WIDTH + 4,
				leadingWidth: 112,
				actions: measuredActions,
				previousHiddenKeys: collapsed,
			}),
		).toEqual(["path"]);

		// Clearing it by the full margin does restore.
		expect(
			resolveNarratorStatusToolbarOverflow({
				budgetWidth: ALL_INLINE_WIDTH + 8,
				leadingWidth: 112,
				actions: measuredActions,
				previousHiddenKeys: collapsed,
			}),
		).toEqual([]);
	});

	test("collapsing is never blocked by hysteresis", () => {
		expect(
			resolveNarratorStatusToolbarOverflow({
				budgetWidth: 240,
				leadingWidth: 112,
				actions: measuredActions,
				previousHiddenKeys: [],
			}),
		).toEqual(["path", "relaxed"]);
	});

	test("hides every action when even one plus the more button cannot fit", () => {
		expect(
			resolveNarratorStatusToolbarOverflow({
				budgetWidth: 120,
				leadingWidth: 112,
				actions: measuredActions,
			}),
		).toEqual(["path", "relaxed", "promote", "terminal"]);
	});

	test("returns no hidden keys for an empty action set", () => {
		expect(
			resolveNarratorStatusToolbarOverflow({
				budgetWidth: 10,
				leadingWidth: 112,
				actions: [],
			}),
		).toEqual([]);
	});
});

class TestResizeObserver {
	static instances = new Set<TestResizeObserver>();
	private readonly callback: ResizeObserverCallback;
	private readonly targets = new Set<Element>();

	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		TestResizeObserver.instances.add(this);
	}

	observe(target: Element) {
		this.targets.add(target);
	}

	unobserve(target: Element) {
		this.targets.delete(target);
	}

	disconnect() {
		this.targets.clear();
		TestResizeObserver.instances.delete(this);
	}

	trigger() {
		const entries = [...this.targets].map(
			(target) => ({ target, contentRect: target.getBoundingClientRect() }) as ResizeObserverEntry,
		);
		this.callback(entries, this as unknown as ResizeObserver);
	}
}

const GLOBAL_KEYS = [
	"window",
	"document",
	"navigator",
	"Event",
	"MouseEvent",
	"PointerEvent",
	"HTMLElement",
	"HTMLAnchorElement",
	"HTMLButtonElement",
	"HTMLInputElement",
	"HTMLSelectElement",
	"HTMLTextAreaElement",
	"SVGElement",
	"Element",
	"Node",
	"ResizeObserver",
	"matchMedia",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"getComputedStyle",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let restoreGlobals: (() => void) | undefined;

function rect(width: number): DOMRect {
	return {
		x: 0,
		y: 0,
		width,
		height: 28,
		top: 0,
		right: width,
		bottom: 28,
		left: 0,
		toJSON: () => ({}),
	} as DOMRect;
}

function installIsolatedDom() {
	const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
	for (const key of GLOBAL_KEYS)
		descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));

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
	const requestAnimationFrame = (callback: FrameRequestCallback) => {
		const timer = setTimeout(() => callback(0), 0);
		return Number(timer);
	};
	const cancelAnimationFrame = (id: number) => clearTimeout(id);

	Object.defineProperties(window, {
		matchMedia: { configurable: true, value: matchMedia },
		requestAnimationFrame: { configurable: true, value: requestAnimationFrame },
		cancelAnimationFrame: { configurable: true, value: cancelAnimationFrame },
	});
	Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", {
		configurable: true,
		value(this: HTMLElement) {
			const explicitWidth = Number(this.getAttribute("data-measure-width"));
			if (explicitWidth > 0) return rect(explicitWidth);
			if (this.hasAttribute("data-toolbar-leading")) {
				const childWidths = [...this.querySelectorAll<HTMLElement>("[data-measure-width]")];
				return rect(
					childWidths.reduce((total, child) => total + Number(child.dataset.measureWidth), 0),
				);
			}
			if (this.hasAttribute("data-toolbar-action")) {
				const child = this.querySelector<HTMLElement>("[data-measure-width]");
				const inlinePadding =
					Number.parseFloat(this.style.paddingInlineStart || "0") +
					Number.parseFloat(this.style.paddingInlineEnd || "0");
				return rect(Number(child?.dataset.measureWidth ?? 0) + inlinePadding);
			}
			// Emulate a real flex row: the toolbar element reports only what its
			// current inline content needs. The implementation must NOT use this as
			// its budget, otherwise collapsing an action shrinks the budget and
			// cascades until a single button is left.
			if (this.getAttribute("data-testid") === "narrator-status-toolbar") {
				const leading = this.querySelector<HTMLElement>("[data-toolbar-leading]");
				const leadingWidth = [
					...(leading?.querySelectorAll<HTMLElement>("[data-measure-width]") ?? []),
				].reduce((total, child) => total + Number(child.dataset.measureWidth), 0);
				const inlineActions = [...this.querySelectorAll<HTMLElement>("[data-toolbar-action]")];
				const actionsWidth = inlineActions.reduce(
					(total, action) => total + action.getBoundingClientRect().width,
					0,
				);
				const hasMore = !!this.querySelector('[data-testid="narrator-status-more"]');
				const itemCount = 1 + inlineActions.length + (hasMore ? 1 : 0);
				return rect(
					leadingWidth + actionsWidth + (hasMore ? 22 : 0) + Math.max(0, itemCount - 1) * 4,
				);
			}
			// Only the status row (or the wrapper standing in for it) reports the
			// full row width; it is the single source of the toolbar's budget.
			const ownRowWidth = Number(this.getAttribute("data-row-width"));
			if (ownRowWidth > 0) return rect(ownRowWidth);
			if (this.getAttribute("data-testid") === "narrator-status-bar-content") {
				return rect(
					Number(this.parentElement?.closest("[data-row-width]")?.getAttribute("data-row-width")),
				);
			}
			return rect(0);
		},
	});

	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		PointerEvent: window.PointerEvent ?? window.MouseEvent ?? window.Event,
		HTMLElement: window.HTMLElement,
		HTMLAnchorElement: window.HTMLAnchorElement,
		HTMLButtonElement: window.HTMLButtonElement,
		HTMLInputElement: window.HTMLInputElement,
		HTMLSelectElement: window.HTMLSelectElement,
		HTMLTextAreaElement: window.HTMLTextAreaElement,
		SVGElement: window.SVGElement,
		Element: window.Element,
		Node: window.Node,
		ResizeObserver: TestResizeObserver,
		matchMedia,
		requestAnimationFrame,
		cancelAnimationFrame,
		getComputedStyle: window.getComputedStyle?.bind(window) ?? (() => ({})),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}

	restoreGlobals = () => {
		for (const [key, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
}

function StatefulOverflowAction() {
	const [opened, setOpened] = useState(false);
	return (
		<>
			<Menu.Item onClick={() => setOpened(true)}>Open path rules</Menu.Item>
			<Modal opened={opened} onClose={() => setOpened(false)} title="Path rules" trapFocus={false}>
				<button type="button">Edit rule</button>
			</Modal>
		</>
	);
}

function makeActions(
	onTerminal: () => void,
	includeTerminal = true,
): NarratorStatusToolbarAction[] {
	const actions: NarratorStatusToolbarAction[] = [
		{
			key: "path",
			collapsePriority: 10,
			visualOverflow: { blockStart: 2, inlineEnd: 4 },
			render: (mode) =>
				mode === "inline" ? (
					<button type="button" data-measure-width="44">
						Path inline
					</button>
				) : (
					<Menu.Item>Path menu</Menu.Item>
				),
		},
		{
			key: "relaxed",
			collapsePriority: 20,
			render: (mode) =>
				mode === "inline" ? (
					<button type="button" data-measure-width="28">
						Relaxed inline
					</button>
				) : (
					<Menu.Item>Relaxed menu</Menu.Item>
				),
		},
		{
			key: "promote",
			collapsePriority: 30,
			render: (mode) =>
				mode === "inline" ? (
					<button type="button" data-measure-width="48">
						Promote inline
					</button>
				) : (
					<Menu.Item>Promote menu</Menu.Item>
				),
		},
	];
	if (includeTerminal) {
		actions.push({
			key: "terminal",
			collapsePriority: 40,
			visualOverflow: { blockStart: 5, inlineEnd: 5 },
			render: (mode) =>
				mode === "inline" ? (
					<button type="button" data-measure-width="28" onClick={onTerminal}>
						Terminal inline
					</button>
				) : (
					<Menu.Item onClick={onTerminal}>Terminal menu · 3</Menu.Item>
				),
		});
	}
	return actions;
}

/**
 * `width` is the toolbar's width budget. The harness exposes it on the wrapper
 * element (standing in for the status row) so the toolbar cannot derive its
 * budget from its own content.
 */
async function renderToolbar(
	width: number,
	actions: NarratorStatusToolbarAction[],
	{ measurementKey = "en" }: { measurementKey?: string } = {},
) {
	await act(async () => {
		root?.render(
			<MantineProvider env="test">
				<div data-row-width={width}>
					<NarratorStatusToolbar
						leading={<div data-measure-width="112">Leading controls</div>}
						actions={actions}
						moreLabel="More actions"
						measurementKey={measurementKey}
						reservedTextWidth={0}
					/>
				</div>
			</MantineProvider>,
		);
	});
}

async function renderStatusBar(ownsHorizontalSafeArea: boolean) {
	await act(async () => {
		root?.render(
			<MantineProvider env="test">
				<NarratorStatusBar ownsHorizontalSafeArea={ownsHorizontalSafeArea}>
					<span data-testid="status-leading">Status</span>
					<NarratorStatusToolbar
						leading={
							<button type="button" data-testid="toolbar-first" data-measure-width="28">
								First
							</button>
						}
						actions={[
							{
								key: "last",
								collapsePriority: 10,
								render: () => (
									<button type="button" data-testid="toolbar-last" data-measure-width="28">
										Last
									</button>
								),
							},
						]}
						moreLabel="More actions"
						measurementKey="spacing"
					/>
				</NarratorStatusBar>
			</MantineProvider>,
		);
	});
}

/**
 * Renders inside a real NarratorStatusBar so the row supplies the budget. The
 * status text sibling grows to fill, mirroring NarratorPanel's layout, so the
 * toolbar must reserve space for it by policy instead of measuring it.
 */
async function renderInStatusBar(
	rowWidth: number,
	actions: NarratorStatusToolbarAction[],
	siblings?: ReactNode,
) {
	await act(async () => {
		root?.render(
			<MantineProvider env="test">
				<div data-row-width={rowWidth}>
					<NarratorStatusBar>
						<div
							data-testid="status-leading"
							data-measure-width="240"
							style={{ flex: 1, minWidth: 0 }}
						>
							Status
						</div>
						{siblings}
						<NarratorStatusToolbar
							leading={<div data-measure-width="112">Leading controls</div>}
							actions={actions}
							moreLabel="More actions"
							measurementKey="en"
						/>
					</NarratorStatusBar>
				</div>
			</MantineProvider>,
		);
	});
}

async function triggerResize() {
	await act(async () => {
		for (const observer of [...TestResizeObserver.instances]) observer.trigger();
		// Measurement is coalesced into a rAF, which the harness backs with a timer.
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

beforeEach(() => {
	installIsolatedDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
	TestResizeObserver.instances.clear();
	restoreGlobals?.();
	restoreGlobals = undefined;
});

describe("NarratorStatusBar", () => {
	test("keeps the original Mantine md gutter in ordinary nested panels", async () => {
		await renderStatusBar(false);

		const bar = document.querySelector<HTMLElement>('[data-testid="narrator-status-bar"]');
		const content = document.querySelector<HTMLElement>(
			'[data-testid="narrator-status-bar-content"]',
		);
		const toolbar = document.querySelector<HTMLElement>('[data-testid="narrator-status-toolbar"]');
		expect(bar?.style.paddingInline).toBe("var(--mantine-spacing-md)");
		expect(bar?.style.paddingInlineStart).toBeUndefined();
		expect(bar?.style.paddingInlineEnd).toBeUndefined();
		expect(content?.style.paddingInlineStart).toBeUndefined();
		expect(content?.style.paddingInlineEnd).toBeUndefined();
		expect(toolbar?.style.width).toBe("100%");
		expect(document.querySelector('[data-testid="status-leading"]')?.parentElement).toBe(content);
		expect(toolbar?.closest('[data-testid="narrator-status-bar-content"]')).toBe(content);
		expect(
			document
				.querySelector('[data-testid="toolbar-last"]')
				?.closest('[data-testid="narrator-status-toolbar"]'),
		).toBe(toolbar);
	});

	test("adds physical safe-area inside the md gutter without shorthand overrides", async () => {
		await renderStatusBar(true);

		const bar = document.querySelector<HTMLElement>('[data-testid="narrator-status-bar"]');
		const content = document.querySelector<HTMLElement>(
			'[data-testid="narrator-status-bar-content"]',
		);
		const first = document.querySelector<HTMLElement>('[data-testid="status-leading"]');
		const last = document.querySelector<HTMLElement>('[data-testid="toolbar-last"]');
		expect(bar?.style.paddingInline).toBe("var(--mantine-spacing-md)");
		expect(bar?.style.paddingInlineStart).toBeUndefined();
		expect(bar?.style.paddingInlineEnd).toBeUndefined();
		expect(content?.style.paddingInline).toBeUndefined();
		expect(content?.style.paddingInlineStart).toBe(SAFE_AREA_INSET_LEFT);
		expect(content?.style.paddingInlineEnd).toBe(SAFE_AREA_INSET_RIGHT);
		expect(content?.style.boxSizing).toBe("border-box");
		expect(content?.style.width).toBe("100%");
		expect(first?.closest('[data-testid="narrator-status-bar-content"]')).toBe(content);
		expect(last?.closest('[data-testid="narrator-status-bar-content"]')).toBe(content);
	});
});

async function renderBackgroundTasksStatus(
	runningCount: number,
	onOpen: () => void = () => {},
	language = "zh-CN",
) {
	const i18n = createInstance();
	await i18n.init({
		lng: language,
		fallbackLng: "en",
		resources: { en: { narrator: enNarrator }, "zh-CN": { narrator: zhNarrator } },
	});
	await act(async () => {
		root?.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider env="test">
					<BackgroundTasksStatusButton runningCount={runningCount} onOpen={onOpen} />
				</MantineProvider>
			</I18nextProvider>,
		);
	});
	return container?.querySelector<HTMLButtonElement>("button");
}

describe("BackgroundTasksStatusButton", () => {
	test("shows the live count and disappears when the last task finishes", async () => {
		expect(await renderBackgroundTasksStatus(0)).toBeNull();

		const button = await renderBackgroundTasksStatus(2);
		expect(button?.textContent).toBe("· 后台任务 2");
		// Preserve the count when the neighboring elapsed label needs to shrink.
		expect(button?.style.flexShrink).toBe("0");
		expect(button?.style.whiteSpace).toBe("nowrap");

		expect((await renderBackgroundTasksStatus(1))?.textContent).toBe("· 后台任务 1");
		expect(await renderBackgroundTasksStatus(0)).toBeNull();
	});

	test("uses an accessible button and delegates each click to the panel opener", async () => {
		const onOpen = mock(() => {});
		const button = await renderBackgroundTasksStatus(3, onOpen);
		expect(button?.getAttribute("type")).toBe("button");
		expect(button?.getAttribute("aria-label")).toBe("后台任务 3");
		for (let click = 0; click < 2; click++) {
			await act(async () => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		}
		expect(onOpen).toHaveBeenCalledTimes(2);
	});

	test.each([
		["en", "· Background tasks: 4"],
		["zh-CN", "· 后台任务 4"],
	])("localizes the count in %s", async (language, expected) => {
		const button = await renderBackgroundTasksStatus(4, undefined, language);
		expect(button?.textContent).toBe(expected);
	});
});

describe("NarratorStatusToolbar", () => {
	test("shows no more button at full width and restores after a resize", async () => {
		const onTerminal = mock(() => {});
		const actions = makeActions(onTerminal);
		await renderToolbar(ALL_INLINE_WIDTH, actions);
		expect(document.querySelector('[data-testid="narrator-status-more"]')).toBeNull();

		await renderToolbar(240, actions);
		await triggerResize();
		expect(document.querySelector('[data-testid="narrator-status-more"]')).not.toBeNull();
		expect(document.querySelector('[data-toolbar-action="path"]')).toBeNull();
		expect(document.querySelector('[data-toolbar-action="relaxed"]')).toBeNull();

		// Restoring needs the hysteresis margin on top of the inline requirement.
		await renderToolbar(ALL_INLINE_WIDTH + 8, actions);
		await triggerResize();
		expect(document.querySelector('[data-testid="narrator-status-more"]')).toBeNull();
		expect(document.querySelector('[data-toolbar-action="path"]')).not.toBeNull();
		expect(document.querySelector('[data-toolbar-action="relaxed"]')).not.toBeNull();
	});

	test("does not cascade: a budget that fits all but one keeps the rest inline", async () => {
		// Regression for the self-referential budget. The toolbar's own width
		// shrinks as actions collapse; if that fed back into the budget the
		// result would cascade down to leading + the more button.
		await renderToolbar(
			240,
			makeActions(() => {}),
		);
		await triggerResize();

		expect(document.querySelector('[data-testid="narrator-status-more"]')).not.toBeNull();
		expect(document.querySelector('[data-toolbar-action="promote"]')).not.toBeNull();
		expect(document.querySelector('[data-toolbar-action="terminal"]')).not.toBeNull();
	});

	test("holds its decision across repeated resize notifications", async () => {
		await renderToolbar(
			240,
			makeActions(() => {}),
		);
		await triggerResize();
		const initial = [...document.querySelectorAll("[data-toolbar-action]")].map((element) =>
			element.getAttribute("data-toolbar-action"),
		);

		for (let pass = 0; pass < 4; pass++) await triggerResize();

		expect(
			[...document.querySelectorAll("[data-toolbar-action]")].map((element) =>
				element.getAttribute("data-toolbar-action"),
			),
		).toEqual(initial);
		expect(document.querySelector('[data-testid="narrator-status-more"]')).not.toBeNull();
	});

	test("keeps the overflow button the same height as the inline controls", async () => {
		await renderToolbar(
			240,
			makeActions(() => {}),
		);
		await triggerResize();

		const moreButton = document.querySelector<HTMLElement>('[data-testid="narrator-status-more"]');
		const toolbar = document.querySelector<HTMLElement>('[data-testid="narrator-status-toolbar"]');
		// size="sm" resolves through Mantine's CSS var, not an inline 28px box.
		expect(moreButton?.style.getPropertyValue("--ai-size")).toBe("var(--ai-size-sm)");
		expect(toolbar?.style.minHeight).toBe(`${NARRATOR_STATUS_ROW_MIN_HEIGHT_PX}px`);
	});

	test("pins the status row height so the overflow button cannot resize it", async () => {
		await renderStatusBar(false);

		const content = document.querySelector<HTMLElement>(
			'[data-testid="narrator-status-bar-content"]',
		);
		expect(content?.style.minHeight).toBe(`${NARRATOR_STATUS_ROW_MIN_HEIGHT_PX}px`);
	});

	test("takes its budget from the status row, minus the reserved status text", async () => {
		const actions = makeActions(() => {});
		// Row width minus the reserve leaves exactly the all-inline requirement.
		// The status text sibling grows to fill, so it must not be measured — only
		// the fixed reserve is deducted for it.
		await renderInStatusBar(ALL_INLINE_WIDTH + NARRATOR_STATUS_RESERVED_TEXT_WIDTH_PX, actions);
		await triggerResize();
		expect(document.querySelector('[data-testid="narrator-status-more"]')).toBeNull();

		// Shrinking the row by the reserve alone is enough to start collapsing.
		await renderInStatusBar(ALL_INLINE_WIDTH, actions);
		await triggerResize();
		expect(document.querySelector('[data-testid="narrator-status-more"]')).not.toBeNull();
	});

	test("subtracts fixed-width row siblings such as the context ring", async () => {
		const actions = makeActions(() => {});
		const rowWidth = ALL_INLINE_WIDTH + NARRATOR_STATUS_RESERVED_TEXT_WIDTH_PX;
		await renderInStatusBar(rowWidth, actions);
		await triggerResize();
		expect(document.querySelector('[data-testid="narrator-status-more"]')).toBeNull();

		// Same row width, but a 40px indicator now shares the row.
		await renderInStatusBar(
			rowWidth,
			actions,
			<div data-measure-width="40" style={{ flexShrink: 0 }}>
				Ring
			</div>,
		);
		await triggerResize();
		expect(document.querySelector('[data-testid="narrator-status-more"]')).not.toBeNull();
	});

	test("a display-none row cannot collapse, because zero widths are rejected", async () => {
		// This is what keeps the desktop breakpoint intact. The mobile row is `hiddenFrom="sm"`
		// there, and a `display: none` subtree reports 0 for every rect, so its measurements
		// describe a hidden box rather than the visible desktop row beside it. The resolver
		// refuses to run on a non-positive container or an unmeasured action rather than
		// folding every action away, which is why no opt-out flag is needed.
		const actions = makeActions(() => {});
		await renderToolbar(0, actions);
		await triggerResize();
		expect(document.querySelector('[data-testid="narrator-status-more"]')).toBeNull();
		for (const key of ["path", "relaxed", "promote", "terminal"]) {
			expect(document.querySelector(`[data-toolbar-action="${key}"]`)).not.toBeNull();
		}
	});

	test("reserves measured gutters for negative-offset badges without clipping the toolbar", async () => {
		const actions: NarratorStatusToolbarAction[] = [
			{
				key: "path",
				collapsePriority: 10,
				visualOverflow: { inlineEnd: 4 },
				render: () => (
					<button type="button" data-measure-width="28" style={{ position: "relative" }}>
						Path
						<span
							data-testid="negative-path-badge"
							style={{ position: "absolute", top: -2, right: -4 }}
						>
							3
						</span>
					</button>
				),
			},
			{
				key: "terminal",
				collapsePriority: 20,
				visualOverflow: { inlineEnd: 5 },
				render: () => (
					<Indicator label={3} size={14} offset={2}>
						<button type="button" data-measure-width="28">
							Terminal
						</button>
					</Indicator>
				),
			},
		];
		await renderToolbar(200, actions);

		const toolbar = document.querySelector<HTMLElement>('[data-testid="narrator-status-toolbar"]');
		const path = document.querySelector<HTMLElement>('[data-toolbar-action="path"]');
		const terminal = document.querySelector<HTMLElement>('[data-toolbar-action="terminal"]');
		expect(toolbar?.style.overflow).toBe("visible");
		expect(toolbar?.style.maxWidth).toBe("100%");
		expect(path?.style.paddingInlineEnd).toBe("4px");
		expect(path?.getBoundingClientRect().width).toBe(32);
		expect(terminal?.style.paddingInlineEnd).toBe("5px");
		expect(terminal?.getBoundingClientRect().width).toBe(33);
		expect(document.querySelector('[data-testid="negative-path-badge"]')).not.toBeNull();
		expect(terminal?.querySelector(".mantine-Indicator-indicator")).not.toBeNull();
	});

	/*
	 * Every inline control shares one centre line. Measured in a real browser, a
	 * one-sided `blockStart` reserve moved the affected wrapper's centre 1px (path)
	 * and 2.5px (terminal) below its siblings, which is the whole "three different
	 * heights" report. It also bought nothing: the badge it was meant to protect is
	 * painted inside an ActionIcon, which clips its own overflow.
	 */
	test("does not apply vertical padding that would push an action off the row centre", async () => {
		const actions: NarratorStatusToolbarAction[] = [
			{
				key: "path",
				collapsePriority: 10,
				visualOverflow: { inlineEnd: 4 },
				render: () => (
					<button type="button" data-measure-width="28">
						Path
					</button>
				),
			},
			{
				key: "terminal",
				collapsePriority: 20,
				visualOverflow: { inlineEnd: 5 },
				render: () => (
					<button type="button" data-measure-width="28">
						Terminal
					</button>
				),
			},
		];
		await renderToolbar(200, actions);

		for (const key of ["path", "terminal"]) {
			const wrapper = document.querySelector<HTMLElement>(`[data-toolbar-action="${key}"]`);
			expect(wrapper?.style.paddingBlockStart).toBeFalsy();
			expect(wrapper?.style.paddingBlockEnd).toBeFalsy();
		}
	});

	/*
	 * A symmetric reserve keeps the centre line but grows the wrapper, which pushes
	 * the row past NARRATOR_STATUS_ROW_MIN_HEIGHT_PX. Keep the escape hatch honest:
	 * whatever a caller passes is what gets applied, on both sides independently.
	 */
	test("applies block padding on exactly the sides the caller asked for", async () => {
		await renderToolbar(200, [
			{
				key: "path",
				collapsePriority: 10,
				visualOverflow: { blockStart: 2, blockEnd: 3, inlineStart: 1, inlineEnd: 4 },
				render: () => (
					<button type="button" data-measure-width="28">
						Path
					</button>
				),
			},
		]);

		const wrapper = document.querySelector<HTMLElement>('[data-toolbar-action="path"]');
		expect(wrapper?.style.paddingBlockStart).toBe("2px");
		expect(wrapper?.style.paddingBlockEnd).toBe("3px");
		expect(wrapper?.style.paddingInlineStart).toBe("1px");
		expect(wrapper?.style.paddingInlineEnd).toBe("4px");
	});

	test("keeps the terminal accessible in the menu and invokes the original callback once", async () => {
		const onTerminal = mock(() => {});
		await renderToolbar(150, makeActions(onTerminal));
		const moreButton = document.querySelector<HTMLElement>('[data-testid="narrator-status-more"]');
		expect(moreButton).not.toBeNull();

		await act(async () => moreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		const terminalItem = [...document.querySelectorAll<HTMLElement>("button")].find((button) =>
			button.textContent?.includes("Terminal menu · 3"),
		);
		expect(terminalItem).not.toBeUndefined();
		await act(async () => terminalItem?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(onTerminal).toHaveBeenCalledTimes(1);
	});

	test("keeps a modal overflow action accessible after the parent menu closes", async () => {
		const actions: NarratorStatusToolbarAction[] = [
			{
				key: "nested",
				collapsePriority: 10,
				render: (mode) =>
					mode === "inline" ? (
						<button type="button" data-measure-width="44">
							Nested inline
						</button>
					) : (
						<StatefulOverflowAction />
					),
			},
		];
		await renderToolbar(150, actions);
		const moreButton = document.querySelector<HTMLElement>('[data-testid="narrator-status-more"]');
		await act(async () => moreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		const pathRulesItem = [...document.querySelectorAll<HTMLElement>("button")].find((button) =>
			button.textContent?.includes("Open path rules"),
		);
		await act(async () => {
			pathRulesItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
		expect(dialog).not.toBeNull();
		expect(dialog?.textContent).toContain("Path rules");
		const editRuleButton = [...(dialog?.querySelectorAll("button") ?? [])].find(
			(button) => button.textContent === "Edit rule",
		);
		expect(editRuleButton).not.toBeUndefined();
		expect(dialog?.closest('[aria-hidden="true"]')).toBeNull();
	});

	test("does not expose a terminal item when the capability is unavailable", async () => {
		await renderToolbar(
			150,
			makeActions(() => {}, false),
		);
		const moreButton = document.querySelector<HTMLElement>('[data-testid="narrator-status-more"]');
		expect(moreButton).not.toBeNull();
		await act(async () => moreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(document.body.textContent).not.toContain("Terminal menu");
		await act(async () => {
			moreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	});
});
