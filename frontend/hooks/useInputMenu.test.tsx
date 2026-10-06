import { afterEach, beforeEach, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useInputMenu } from "./useInputMenu";

let root: Root;
let container: HTMLDivElement;
let menu: ReturnType<typeof useInputMenu>;
let active: Element | null;
const saved = new Map<string, PropertyDescriptor | undefined>();

function Probe() {
	menu = useInputMenu();
	return (
		<button type="button" {...menu.targetProps}>
			Menu
		</button>
	);
}

beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	active = null;
	Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => root.render(<Probe />));
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	for (const [key, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	saved.clear();
});

async function dispatch(type: string) {
	const event = new window.Event(type, { bubbles: true, cancelable: true });
	await act(async () => container.querySelector("button")?.dispatchEvent(event));
	return event;
}

for (const tag of ["textarea", "input", "div"] as const) {
	test(`pointer opening keeps the focused ${tag} editor and disables menu autofocus`, async () => {
		active = document.createElement(tag);
		if (tag === "div") active.setAttribute("contenteditable", "true");
		const event = await dispatch("pointerdown");
		expect(event.defaultPrevented).toBe(true);
		expect(menu.menuProps.trapFocus).toBe(false);
		expect(menu.menuProps.returnFocus).toBe(false);
		const click = await dispatch("click");
		expect(click.defaultPrevented).toBe(false);
	});
}

test("mouse opening also keeps editor focus; keyboard opening restores focus management", async () => {
	active = document.createElement("textarea");
	expect((await dispatch("mousedown")).defaultPrevented).toBe(true);
	expect(menu.menuProps.trapFocus).toBe(false);
	await dispatch("keydown");
	expect(menu.menuProps.trapFocus).toBe(true);
	expect(menu.menuProps.returnFocus).toBe(true);
});

test("ordinary pointer opening retains accessible menu focus", async () => {
	active = document.createElement("button");
	expect((await dispatch("pointerdown")).defaultPrevented).toBe(false);
	expect(menu.menuProps.trapFocus).toBe(true);
});

test("placement remains adaptive and constrains menu size to the visible viewport", () => {
	expect(menu.menuProps.preventPositionChangeWhenVisible).toBe(false);
	expect(menu.menuProps.middlewares).toEqual({
		flip: true,
		shift: { crossAxis: true },
		size: true,
	});
});
