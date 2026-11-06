/**
 * The keyboard cursor over a rendered directory list.
 *
 * A probe list stands in for the two real browsers: what is asserted here is the
 * contract they rely on — arrows move the highlight, typing jumps it to a matching
 * directory, Enter hands that row to the caller, and an editable field keeps its keys.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDirectoryTypeahead } from "./useDirectoryTypeahead";

let root: Root;
let host: HTMLDivElement;
let view: Window & typeof globalThis;
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	view = window as unknown as Window & typeof globalThis;
	const globals = {
		window: view,
		document: view.document,
		navigator: view.navigator,
		HTMLElement: view.HTMLElement,
		Element: view.Element,
		Node: view.Node,
		Event: view.Event,
		getComputedStyle: () => ({ getPropertyValue: () => "", direction: "ltr" }),
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		},
		cancelAnimationFrame: () => {},
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	host = view.document.createElement("div") as unknown as HTMLDivElement;
	(view.document.body as unknown as { appendChild: (node: unknown) => void }).appendChild(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	previousGlobals.clear();
});

const names = ["Documents", "Downloads", "Music", "projects"];

function Probe({ onActivate }: { onActivate: (index: number) => void }) {
	const typeahead = useDirectoryTypeahead({ names, onActivate, resetKey: names.join("|") });
	return (
		<fieldset
			ref={typeahead.containerRef}
			onKeyDown={typeahead.onKeyDown}
			aria-label="directories"
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the list is the keyboard surface
			tabIndex={0}
			style={{ border: 0, margin: 0, padding: 0 }}
		>
			<input data-testid="path" />
			{names.map((name, index) => (
				<button
					key={name}
					type="button"
					data-dir-index={index}
					data-cursor={index === typeahead.cursorIndex ? "true" : undefined}
				>
					{name}
				</button>
			))}
		</fieldset>
	);
}

async function mount(onActivate: (index: number) => void = () => {}) {
	await act(async () => {
		root.render(<Probe onActivate={onActivate} />);
	});
}

/** React listens on the root container, so a bubbling event from a child reaches it. */
function press(target: Element, key: string) {
	// A plain Event with `key` defined: React dispatches by event name, and this keeps
	// the test independent of how much of KeyboardEvent the DOM shim implements.
	const event = new (view.Event as typeof Event)("keydown", {
		bubbles: true,
		cancelable: true,
	}) as Event & { key?: string };
	Object.defineProperty(event, "key", { value: key, configurable: true });
	act(() => {
		target.dispatchEvent(event);
	});
}

function list() {
	const container = host.firstElementChild;
	if (!container) throw new Error("probe did not render");
	return container;
}

function cursorRow(): string | null {
	const marked = [...host.querySelectorAll("[data-cursor]")].map((row) =>
		row.getAttribute("data-dir-index"),
	);
	return marked.length === 0 ? null : (marked[0] as string);
}

test("typing jumps the cursor to the first directory with that prefix", async () => {
	await mount();
	press(list(), "d");
	expect(cursorRow()).toBe("0");
	press(list(), "o");
	// "do" still matches Documents first, but the cursor is now a real row.
	expect(cursorRow()).toBe("0");
	press(list(), "w");
	expect(cursorRow()).toBe("1");
});

test("the same letter again cycles through the matches", async () => {
	await mount();
	press(list(), "p");
	expect(cursorRow()).toBe("3");
	press(list(), "p");
	expect(cursorRow()).toBe("3");
	press(list(), "d");
	press(list(), "d");
	expect(cursorRow()).toBe("1");
});

test("arrows move and wrap, Home and End jump", async () => {
	await mount();
	press(list(), "ArrowDown");
	expect(cursorRow()).toBe("0");
	press(list(), "ArrowUp");
	expect(cursorRow()).toBe("3");
	press(list(), "Home");
	expect(cursorRow()).toBe("0");
	press(list(), "End");
	expect(cursorRow()).toBe("3");
});

test("Enter hands the highlighted row to the caller", async () => {
	const activated: number[] = [];
	await mount((index) => activated.push(index));
	press(list(), "m");
	press(list(), "Enter");
	expect(activated).toEqual([2]);
});

test("Enter without a cursor does nothing", async () => {
	const activated: number[] = [];
	await mount((index) => activated.push(index));
	press(list(), "Enter");
	expect(activated).toEqual([]);
});

test("keys typed into the path field stay there", async () => {
	await mount();
	const input = host.querySelector("input");
	if (!input) throw new Error("input did not render");
	press(input, "d");
	expect(cursorRow()).toBeNull();
});

test("a letter that matches nothing leaves the cursor alone", async () => {
	await mount();
	press(list(), "m");
	press(list(), "z");
	expect(cursorRow()).toBe("2");
});
