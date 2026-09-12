/**
 * LodSwitchToast.test.tsx — the LOD indicator must be OPERABLE, not just painted.
 *
 * The bug this locks down: the only way to change the detail level was alt+wheel
 * (and pinch). On a notched wheel a single detent reports a large delta, so the
 * middle levels were hard to land on, and on devices with no wheel the feature
 * was unreachable. The indicator now always carries click targets: each notch is
 * its own target, with −/+ steppers on either side.
 *
 * Covered: the controls are the SAME whether the indicator was summoned by a
 * gesture or by holding Alt (it previously swapped between two shapes, which read
 * as two widgets), clicking a notch reports that exact level, the steppers move by
 * one and clamp at the ends, and "set as default" stays reachable.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LodSwitchToast } from "./LodSwitchToast";
import type { RenderLod } from "./RenderLodCtx";

let root: Root;
let container: HTMLDivElement;

function installDom() {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
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
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		writable: true,
		value: matchMedia,
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
		Text: window.Text,
		matchMedia,
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		requestAnimationFrame: (cb: (time: number) => void) =>
			setTimeout(() => cb(Date.now()), 0) as unknown as number,
		cancelAnimationFrame: (handle: number) => clearTimeout(handle),
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
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

/**
 * Queried by test id, not by label: whether the real locale bundle is loaded
 * depends on which other test files ran first in the same process, so label text
 * is not a stable handle here.
 */
function notchButtons(): HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>('[data-testid="lod-notch"]'));
}

function byTestId(id: string): HTMLElement | null {
	return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

async function click(el: HTMLElement | null) {
	expect(el).not.toBeNull();
	await act(async () => {
		el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

/**
 * Drive React's onMouseEnter / onMouseLeave.
 *
 * React does not listen for native mouseenter/mouseleave (they do not bubble, so
 * they cannot be delegated); it synthesizes them from mouseover/mouseout observed
 * at the root container. Dispatching the native enter/leave names here would
 * silently do nothing and the hover assertions would pass for the wrong reason.
 * `relatedTarget` is the element the pointer came from / went to — outside the
 * indicator in both cases, which is what makes React emit enter/leave.
 */
async function mouse(el: HTMLElement | null, direction: "enter" | "leave") {
	expect(el).not.toBeNull();
	await act(async () => {
		const event = new Event(direction === "enter" ? "mouseover" : "mouseout", { bubbles: true });
		Object.defineProperty(event, "relatedTarget", {
			configurable: true,
			value: document.body,
		});
		el?.dispatchEvent(event);
	});
}

/** Comfortably past the component's 750ms hold + 200ms fade. */
const HIDE_AFTER_MS = 1100;

/** Real time: the component's hide schedule is the thing under test. */
async function waitPastHide() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, HIDE_AFTER_MS));
	});
}

/**
 * Watch the indicator across the whole hide window and report the worst state it
 * reached. Sampling only the end state is not enough: a spurious fade can start,
 * make the widget invisible and inert under the pointer, and then be undone by a
 * later state update — which is exactly what "it closed itself" looked like.
 */
async function observeWhileWaiting(): Promise<{ everFaded: boolean; everInert: boolean }> {
	const result = { everFaded: false, everInert: false };
	const deadline = Date.now() + HIDE_AFTER_MS;
	while (Date.now() < deadline) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 25));
		});
		const el = byTestId("lod-indicator");
		if (!el) continue;
		if (el.style.opacity !== "1") result.everFaded = true;
		if (el.style.pointerEvents !== "auto") result.everInert = true;
	}
	return result;
}

async function render(props: {
	lod: RenderLod;
	pinned?: boolean;
	isDefault?: boolean;
	onSelectLod?: (next: RenderLod) => void;
	onSetAsDefault?: () => void;
}) {
	await act(async () => {
		root.render(
			<MantineProvider>
				<LodSwitchToast {...props} />
			</MantineProvider>,
		);
	});
}

describe("LodSwitchToast", () => {
	test("renders nothing until something happens", async () => {
		await render({ lod: 5 });
		// Mount alone is silent: no level change, no Alt held. (Mantine's provider
		// injects its own <style> into the container, so probe for the indicator
		// itself rather than for empty text.)
		expect(byTestId("lod-indicator")).toBeNull();
	});

	test("pinned mode shows one clickable target per level", async () => {
		const onSelectLod = mock((_next: RenderLod) => {});
		await render({ lod: 5, pinned: true, onSelectLod });

		const notches = notchButtons();
		expect(notches).toHaveLength(5);
		// The gauge must report the current level so the user can see where they are.
		expect(notches[4]?.getAttribute("aria-current")).toBe("true");
		expect(notches[0]?.getAttribute("aria-current")).toBeNull();

		// Clicking a distant notch jumps straight there — the whole point of the
		// picker (alt+wheel would need several detents and could overshoot).
		await click(notches[1] ?? null);
		expect(onSelectLod).toHaveBeenCalledTimes(1);
		expect(onSelectLod.mock.calls[0]?.[0]).toBe(2);
	});

	test("steppers move exactly one level in each direction", async () => {
		const onSelectLod = mock((_next: RenderLod) => {});
		await render({ lod: 3, pinned: true, onSelectLod });

		await click(byTestId("lod-step-up"));
		expect(onSelectLod.mock.calls[0]?.[0]).toBe(4);
		await click(byTestId("lod-step-down"));
		expect(onSelectLod.mock.calls[1]?.[0]).toBe(2);
	});

	test("steppers are disabled at the ends of the scale", async () => {
		await render({ lod: 5, pinned: true, onSelectLod: () => {} });
		expect(byTestId("lod-step-up")?.hasAttribute("disabled")).toBe(true);
		expect(byTestId("lod-step-down")?.hasAttribute("disabled")).toBe(false);

		await render({ lod: 1, pinned: true, onSelectLod: () => {} });
		expect(byTestId("lod-step-down")?.hasAttribute("disabled")).toBe(true);
		expect(byTestId("lod-step-up")?.hasAttribute("disabled")).toBe(false);
	});

	test("a gesture-driven appearance offers the same controls as the pinned one", async () => {
		// The indicator must not change shape depending on how it was summoned: a
		// widget that swaps between a read-only gauge and a picker reads as two
		// different widgets. Only its longevity differs.
		const onSelectLod = mock((_next: RenderLod) => {});
		await render({ lod: 5, onSelectLod });
		await render({ lod: 4, onSelectLod });

		expect(byTestId("lod-indicator")?.getAttribute("data-lod-pinned")).toBe("false");
		expect(notchButtons()).toHaveLength(5);
		expect(byTestId("lod-step-up")).not.toBeNull();
		expect(byTestId("lod-step-down")).not.toBeNull();

		await click(notchButtons()[0] ?? null);
		expect(onSelectLod.mock.calls.at(-1)?.[0]).toBe(1);
	});

	test("pinning is reported on the indicator so it can be told apart in the DOM", async () => {
		await render({ lod: 4, pinned: true, onSelectLod: () => {} });
		expect(byTestId("lod-indicator")?.getAttribute("data-lod-pinned")).toBe("true");
	});

	test("picking a level while pinned does not start a hide countdown", async () => {
		// The reported bug: clicking a notch with Alt held made the indicator vanish
		// ~750ms later, so a second adjustment was impossible. The level change used to
		// arm the fade timers regardless of the widget being held open.
		//
		// Asserted on opacity/pointer-events rather than on the node existing: while
		// pinned the node stays mounted either way, and the actual symptom was it
		// fading to invisible and going inert underneath the pointer.
		const onSelectLod = mock((_next: RenderLod) => {});
		await render({ lod: 5, pinned: true, onSelectLod });
		await render({ lod: 3, pinned: true, onSelectLod });

		const seen = await observeWhileWaiting();
		expect(seen.everFaded).toBe(false);
		expect(seen.everInert).toBe(false);
		const indicator = byTestId("lod-indicator");
		expect(indicator).not.toBeNull();
		expect(indicator?.getAttribute("data-lod-holding")).toBe("true");

		// And it still answers clicks, so a second adjustment goes through.
		await click(notchButtons()[0] ?? null);
		expect(onSelectLod.mock.calls.at(-1)?.[0]).toBe(1);
	});

	test("hovering the indicator keeps it open after Alt is released", async () => {
		// The pointer sits ON the control right after a click, so releasing Alt there
		// must not dismiss it — that is the "I want to keep adjusting" case.
		await render({ lod: 5, pinned: true, onSelectLod: () => {} });
		await render({ lod: 4, pinned: true, onSelectLod: () => {} });
		await mouse(byTestId("lod-indicator"), "enter");

		await render({ lod: 4, pinned: false, onSelectLod: () => {} });
		await waitPastHide();
		expect(byTestId("lod-indicator")).not.toBeNull();
		expect(byTestId("lod-indicator")?.getAttribute("data-lod-holding")).toBe("true");
	});

	test("leaving the indicator lets it fade away again", async () => {
		await render({ lod: 5, pinned: true, onSelectLod: () => {} });
		await render({ lod: 4, pinned: true, onSelectLod: () => {} });
		await mouse(byTestId("lod-indicator"), "enter");
		await render({ lod: 4, pinned: false, onSelectLod: () => {} });
		expect(byTestId("lod-indicator")).not.toBeNull();

		await mouse(byTestId("lod-indicator"), "leave");
		await waitPastHide();
		expect(byTestId("lod-indicator")).toBeNull();
	});

	test("a hover stranded by a window switch does not hold it open forever", async () => {
		// alt+tab: the window loses focus with the pointer parked ON the indicator, so
		// no mouseleave ever fires. The hold-open hover would then survive the switch
		// and keep the widget on screen indefinitely (the reported bug).
		await render({ lod: 5, pinned: true, onSelectLod: () => {} });
		await render({ lod: 4, pinned: true, onSelectLod: () => {} });
		await mouse(byTestId("lod-indicator"), "enter");

		// Losing focus also drops `pinned` (the trigger hook resets on blur), so the
		// only thing that could keep it alive here is the stale hover.
		await act(async () => {
			window.dispatchEvent(new Event("blur"));
		});
		await render({ lod: 4, pinned: false, onSelectLod: () => {} });

		await waitPastHide();
		expect(byTestId("lod-indicator")).toBeNull();
	});

	test("a gesture-driven indicator still hides on its own", async () => {
		// The hold-open rules must not turn every level change into a permanent
		// overlay parked over the middle of the message list.
		await render({ lod: 5, onSelectLod: () => {} });
		await render({ lod: 4, onSelectLod: () => {} });
		expect(byTestId("lod-indicator")?.getAttribute("data-lod-holding")).toBe("false");

		await waitPastHide();
		expect(byTestId("lod-indicator")).toBeNull();
	});

	test("set-as-default is reachable while pinned and hidden once it is the default", async () => {
		const onSetAsDefault = mock(() => {});
		await render({
			lod: 4,
			pinned: true,
			isDefault: false,
			onSelectLod: () => {},
			onSetAsDefault,
		});
		await click(byTestId("lod-set-default"));
		expect(onSetAsDefault).toHaveBeenCalledTimes(1);

		await render({ lod: 4, pinned: true, isDefault: true, onSelectLod: () => {}, onSetAsDefault });
		expect(byTestId("lod-set-default")).toBeNull();
	});

	test("pinned mode tracks the live level rather than the level it opened at", async () => {
		await render({ lod: 2, pinned: true, onSelectLod: () => {} });
		expect(notchButtons()[1]?.getAttribute("aria-current")).toBe("true");
		await render({ lod: 5, pinned: true, onSelectLod: () => {} });
		const notches = notchButtons();
		expect(notches[4]?.getAttribute("aria-current")).toBe("true");
		expect(notches[1]?.getAttribute("aria-current")).toBeNull();
	});
});
