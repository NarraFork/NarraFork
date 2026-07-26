import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppNotifications } from "@frontend/components/AppNotifications";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TOAST_SELECTABLE_CLASSNAME } from "./toast";

/**
 * Regression coverage for "toast text cannot be copied".
 *
 * Bug it guards: Mantine v9 turns on swipe-to-dismiss for notifications by
 * default. Its `useDrag` claims the pointer after 5px of movement and sets
 * `document.body.style.userSelect = "none"`, so dragging across toast text with
 * a mouse flung the whole toast away instead of selecting the message. The fix
 * disables drag-dismiss for fine pointers (mouse) and marks the notification
 * selectable, while keeping the swipe gesture on touch/pen.
 */

const GLOBAL_KEYS = [
	"window",
	"document",
	"navigator",
	"Event",
	"MouseEvent",
	"HTMLElement",
	"Element",
	"Node",
	"getComputedStyle",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let restoreGlobals: (() => void) | undefined;

/** Install a fresh DOM whose `matchMedia` reports the requested pointer type. */
function installIsolatedDom(finePointer: boolean) {
	const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
	for (const key of GLOBAL_KEYS) {
		descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	}

	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const matchMedia = (query: string) => ({
		matches: query.includes("pointer: fine") ? finePointer : false,
		media: query,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	});
	Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia });

	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
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

function mount() {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
}

async function renderToast() {
	await act(async () => {
		root?.render(
			<MantineProvider env="test">
				<AppNotifications />
			</MantineProvider>,
		);
	});
	await act(async () => {
		notifications.show({ id: "t", message: "copy me", position: "top-right", autoClose: false });
	});
	const toast = document.querySelector<HTMLElement>('[role="alert"]');
	if (!toast) throw new Error("notification did not render");
	return toast;
}

/** Fire a left-button pointer event with the coordinates `useDrag` reads. */
function pointerEvent(type: string, clientX: number, timeStamp: number) {
	const event = new Event(type, { bubbles: true }) as Event & Record<string, unknown>;
	Object.assign(event, { clientX, clientY: 0, button: 0, pointerId: 1 });
	Object.defineProperty(event, "timeStamp", { value: timeStamp, configurable: true });
	return event;
}

/** `useDrag` writes "none" here while a drag is active; unset reads as "". */
function bodyUserSelect() {
	return document.body.style.userSelect ?? "";
}

/** Press on the toast and drag sideways far enough to pass useDrag's threshold. */
async function dragAcross(toast: HTMLElement) {
	await act(async () => {
		toast.dispatchEvent(pointerEvent("pointerdown", 0, 0));
	});
	await act(async () => {
		document.dispatchEvent(pointerEvent("pointermove", 120, 20));
	});
}

afterEach(async () => {
	await act(async () => notifications.clean());
	await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
	restoreGlobals?.();
	restoreGlobals = undefined;
});

describe("toast text selection with a mouse", () => {
	beforeEach(() => {
		installIsolatedDom(true);
		notifications.clean();
		mount();
	});

	test("a sideways drag does not suppress text selection", async () => {
		const toast = await renderToast();
		await dragAcross(toast);

		// useDrag sets this to "none" the moment it takes over a drag; staying
		// empty proves the gesture never engaged, so the caret can select text.
		expect(bodyUserSelect()).toBe("");
		expect(document.querySelector('[role="alert"]')).not.toBeNull();
		expect(toast.textContent).toContain("copy me");
	});

	test("the notification is marked selectable", async () => {
		const toast = await renderToast();
		expect(toast.classList.contains(TOAST_SELECTABLE_CLASSNAME)).toBe(true);
	});
});

describe("toast swipe-to-dismiss on touch devices", () => {
	beforeEach(() => {
		installIsolatedDom(false);
		notifications.clean();
		mount();
	});

	test("a sideways drag still engages the swipe gesture", async () => {
		const toast = await renderToast();
		await dragAcross(toast);

		expect(bodyUserSelect()).toBe("none");
		expect(toast.classList.contains(TOAST_SELECTABLE_CLASSNAME)).toBe(false);
	});
});

describe("toast selection stylesheet contract", () => {
	beforeEach(() => {
		installIsolatedDom(true);
	});

	test("the selectable class overrides Mantine's inline cursor and allows selection", async () => {
		const css = await Bun.file(new URL("../styles/toast.css", import.meta.url)).text();
		const style = document.createElement("style");
		style.textContent = css;
		document.head.appendChild(style);

		const rule = [...(style.sheet?.cssRules ?? [])].find(
			(candidate) => (candidate as CSSStyleRule).selectorText === `.${TOAST_SELECTABLE_CLASSNAME}`,
		) as CSSStyleRule | undefined;

		// Mantine sets `cursor: default` inline on the notification root, so only
		// an !important declaration can restore the text caret.
		expect(rule?.style.getPropertyValue("cursor")).toBe("auto");
		expect(rule?.style.getPropertyPriority("cursor")).toBe("important");
		expect(rule?.style.getPropertyValue("user-select")).toBe("text");
	});
});
