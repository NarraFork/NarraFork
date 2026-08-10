/**
 * useLodIndicatorTrigger.test.tsx — "Alt held over THIS panel" detection.
 *
 * Three failure modes this guards:
 *   1. Alt held while the pointer is over a DIFFERENT panel must not arm this
 *      one — the dock layout mounts several narrator panels at once and every
 *      indicator would otherwise pop open together.
 *   2. A swallowed keyup (window switch, an OS menu grabbing Alt) must not leave
 *      the indicator pinned open forever; blur/visibilitychange reset it.
 *   3. Alt+letter shortcuts must not flash the indicator.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useLodIndicatorTrigger } from "./useLodIndicatorTrigger";

let root: Root;
let container: HTMLDivElement;
/** The live value the probe component last rendered. */
let active = false;

function installDom() {
	const { window } = parseHTML(
		"<!doctype html><html><body><div id='inside'></div><div id='outside'></div></body></html>",
	);
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		// MouseEvent/KeyboardEvent are deliberately NOT published here. linkedom
		// has neither, so aliasing them to Event would replace the constructors any
		// LATER test file in this process relies on (a `new KeyboardEvent(...)` would
		// silently lose its `key`). This file builds its events by hand instead.
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
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
	// linkedom has no layout, so elementFromPoint never resolves; the hook falls
	// back to it only when an event carries no usable target, which the tests
	// exercise through real event targets instead.
	if (!window.document.elementFromPoint) {
		Object.defineProperty(window.document, "elementFromPoint", {
			configurable: true,
			writable: true,
			value: () => null,
		});
	}
}

/** Renders the hook against its own child div so containment is real DOM. */
function Probe({ enabled = true }: { enabled?: boolean }) {
	const ref = useRef<HTMLDivElement>(null);
	active = useLodIndicatorTrigger(ref, enabled);
	return (
		<div ref={ref} data-testid="area">
			<span data-testid="child">messages</span>
		</div>
	);
}

async function mount(enabled = true) {
	await act(async () => {
		root.render(<Probe enabled={enabled} />);
	});
}

function child(): HTMLElement {
	const el = container.querySelector<HTMLElement>('[data-testid="child"]');
	if (!el) throw new Error("probe child missing");
	return el;
}

/**
 * linkedom has no MouseEvent/KeyboardEvent constructors and its Event ignores
 * unknown init fields, so the modifier flags are attached by hand — otherwise
 * every dispatched event would read as altKey:false and the tests would pass for
 * the wrong reason.
 */
function makeEvent(type: string, props: Record<string, unknown>): Event {
	const event = new Event(type, { bubbles: true });
	for (const [key, value] of Object.entries(props)) {
		Object.defineProperty(event, key, { configurable: true, value });
	}
	return event;
}

async function mouseMove(target: HTMLElement, altKey: boolean) {
	await act(async () => {
		target.dispatchEvent(makeEvent("mousemove", { altKey, clientX: 10, clientY: 10 }));
	});
}

async function keyDown(key: string, altKey = true) {
	await act(async () => {
		window.dispatchEvent(makeEvent("keydown", { key, altKey }));
	});
}

async function keyUp(key: string, altKey = false) {
	await act(async () => {
		window.dispatchEvent(makeEvent("keyup", { key, altKey }));
	});
}

beforeEach(() => {
	installDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	active = false;
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

describe("useLodIndicatorTrigger", () => {
	test("arms while Alt is held with the pointer inside, and disarms on keyup", async () => {
		await mount();
		expect(active).toBe(false);

		await mouseMove(child(), true);
		expect(active).toBe(true);

		await keyUp("Alt");
		expect(active).toBe(false);
	});

	test("stays disarmed when the alt-modified pointer is outside the container", async () => {
		await mount();
		const outside = document.getElementById("outside") as HTMLElement;
		await mouseMove(outside, true);
		expect(active).toBe(false);
	});

	test("disarms when the pointer leaves the container while Alt stays held", async () => {
		await mount();
		await mouseMove(child(), true);
		expect(active).toBe(true);

		const outside = document.getElementById("outside") as HTMLElement;
		await mouseMove(outside, true);
		expect(active).toBe(false);
	});

	test("Alt+letter shortcuts do not pin the indicator", async () => {
		await mount();
		await mouseMove(child(), true);
		expect(active).toBe(true);
		// Pressing a letter while Alt is down turns the chord into a shortcut.
		await keyDown("s", true);
		expect(active).toBe(false);
	});

	test("window blur clears a stuck Alt", async () => {
		await mount();
		await mouseMove(child(), true);
		expect(active).toBe(true);

		await act(async () => {
			window.dispatchEvent(makeEvent("blur", {}));
		});
		expect(active).toBe(false);
	});

	test("regaining focus clears a stuck Alt", async () => {
		// Coming back from another window (alt+tab) with a swallowed keyup: the page
		// cannot know whether Alt is still physically down, and assuming it is leaves
		// the indicator pinned open. A later Alt press re-arms it.
		await mount();
		await mouseMove(child(), true);
		expect(active).toBe(true);

		await act(async () => {
			window.dispatchEvent(makeEvent("focus", {}));
		});
		expect(active).toBe(false);
	});

	test("does nothing when disabled", async () => {
		await mount(false);
		await mouseMove(child(), true);
		expect(active).toBe(false);
	});
});
