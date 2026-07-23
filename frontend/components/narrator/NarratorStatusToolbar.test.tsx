import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Indicator, MantineProvider, Menu, Modal } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SAFE_AREA_INSET_LEFT, SAFE_AREA_INSET_RIGHT } from "../../lib/safe-area";
import {
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

describe("resolveNarratorStatusToolbarOverflow", () => {
	test("keeps the existing inline layout when every action fits", () => {
		expect(
			resolveNarratorStatusToolbarOverflow({
				availableWidth: 285,
				leadingWidth: 112,
				actions: measuredActions,
			}),
		).toEqual([]);
	});

	test("reserves the more button and collapses actions in priority order", () => {
		expect(
			resolveNarratorStatusToolbarOverflow({
				availableWidth: 275,
				leadingWidth: 112,
				actions: measuredActions,
			}),
		).toEqual(["path"]);
		expect(
			resolveNarratorStatusToolbarOverflow({
				availableWidth: 250,
				leadingWidth: 112,
				actions: measuredActions,
			}),
		).toEqual(["path", "relaxed"]);
		expect(
			resolveNarratorStatusToolbarOverflow({
				availableWidth: 220,
				leadingWidth: 112,
				actions: measuredActions,
			}),
		).toEqual(["path", "relaxed", "promote"]);
	});

	test("recomputing at a wider width restores every action", () => {
		const narrow = resolveNarratorStatusToolbarOverflow({
			availableWidth: 250,
			leadingWidth: 112,
			actions: measuredActions,
		});
		const restored = resolveNarratorStatusToolbarOverflow({
			availableWidth: 285,
			leadingWidth: 112,
			actions: measuredActions,
		});

		expect(narrow).toEqual(["path", "relaxed"]);
		expect(restored).toEqual([]);
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
			if (this.getAttribute("data-testid") === "narrator-status-toolbar") {
				return rect(Number(this.parentElement?.getAttribute("data-container-width") ?? 0));
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

async function renderToolbar(width: number, actions: NarratorStatusToolbarAction[]) {
	await act(async () => {
		root?.render(
			<MantineProvider env="test">
				<div data-container-width={width}>
					<NarratorStatusToolbar
						leading={<div data-measure-width="112">Leading controls</div>}
						actions={actions}
						moreLabel="More actions"
						measurementKey="en"
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

async function triggerResize() {
	await act(async () => {
		for (const observer of [...TestResizeObserver.instances]) observer.trigger();
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

describe("NarratorStatusToolbar", () => {
	test("shows no more button at full width and restores after a resize", async () => {
		const onTerminal = mock(() => {});
		const actions = makeActions(onTerminal);
		await renderToolbar(285, actions);
		expect(document.querySelector('[data-testid="narrator-status-more"]')).toBeNull();

		await renderToolbar(250, actions);
		await triggerResize();
		expect(document.querySelector('[data-testid="narrator-status-more"]')).not.toBeNull();
		expect(document.querySelector('[data-toolbar-action="path"]')).toBeNull();
		expect(document.querySelector('[data-toolbar-action="relaxed"]')).toBeNull();

		await renderToolbar(285, actions);
		await triggerResize();
		expect(document.querySelector('[data-testid="narrator-status-more"]')).toBeNull();
		expect(document.querySelector('[data-toolbar-action="path"]')).not.toBeNull();
		expect(document.querySelector('[data-toolbar-action="relaxed"]')).not.toBeNull();
	});

	test("reserves measured gutters for negative-offset badges without clipping the toolbar", async () => {
		const actions: NarratorStatusToolbarAction[] = [
			{
				key: "path",
				collapsePriority: 10,
				visualOverflow: { blockStart: 2, inlineEnd: 4 },
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
				visualOverflow: { blockStart: 5, inlineEnd: 5 },
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
		expect(path?.style.paddingBlockStart).toBe("2px");
		expect(path?.style.paddingInlineEnd).toBe("4px");
		expect(path?.getBoundingClientRect().width).toBe(32);
		expect(terminal?.style.paddingBlockStart).toBe("5px");
		expect(terminal?.style.paddingInlineEnd).toBe("5px");
		expect(terminal?.getBoundingClientRect().width).toBe(33);
		expect(document.querySelector('[data-testid="negative-path-badge"]')).not.toBeNull();
		expect(terminal?.querySelector(".mantine-Indicator-indicator")).not.toBeNull();
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
