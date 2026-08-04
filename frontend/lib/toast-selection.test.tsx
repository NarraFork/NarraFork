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
	// linkedom's `window` is a proxy that forwards defineProperty onto globalThis, so
	// the per-test `matchMedia` installed on `window` below lands here as well and has
	// to be restored like any other global this file writes.
	"matchMedia",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;

/**
 * globalThis descriptors as they were before this file touched anything.
 *
 * Snapshotted once at module load instead of per install: the three describe blocks
 * each install their own DOM, so re-snapshotting would capture the previous round's
 * linkedom objects as the "original" state and the restore chain would never return
 * globalThis to its real baseline.
 */
const pristineDescriptors: ReadonlyMap<string, PropertyDescriptor | undefined> = new Map(
	GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);

/**
 * Put globalThis back the way this file found it.
 *
 * Data properties are rebuilt as writable+configurable rather than written back
 * verbatim: a snapshot can itself hold a readonly descriptor (linkedom's window proxy
 * plants those, and an earlier-loaded suite may leave one behind), and replaying it
 * would keep the hazard alive for whoever loads next. Every later suite that does
 * `Object.assign(globalThis, ...)` needs these to stay assignable. Accessors are
 * restored as-is because forcing them into data properties would be the real damage.
 */
function restoreGlobals() {
	for (const [key, descriptor] of pristineDescriptors) {
		if (!descriptor) {
			Reflect.deleteProperty(globalThis, key);
			continue;
		}
		if (descriptor.get || descriptor.set) {
			Object.defineProperty(globalThis, key, descriptor);
			continue;
		}
		Object.defineProperty(globalThis, key, {
			configurable: true,
			writable: true,
			enumerable: descriptor.enumerable,
			value: descriptor.value,
		});
	}
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

/** Install a fresh DOM whose `matchMedia` reports the requested pointer type. */
function installIsolatedDom(finePointer: boolean) {
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
	// `writable: true` matters: linkedom forwards this onto globalThis, and omitting it
	// left a readonly global `matchMedia` behind that made `Object.assign(globalThis, …)`
	// throw in every suite loaded after this file.
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
		getComputedStyle: window.getComputedStyle?.bind(window) ?? (() => ({})),
		matchMedia,
		IS_REACT_ACT_ENVIRONMENT: true,
	} satisfies Record<(typeof GLOBAL_KEYS)[number], unknown>;
	for (const [key, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
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

/**
 * Press on the toast and drag sideways far enough to pass useDrag's threshold.
 *
 * Both pointer events are dispatched inside ONE `act()` on purpose. `useDrag`
 * keeps its gesture state in a ref that is reset by the ref-callback cleanup, so
 * if React is allowed to flush a re-render between pointerdown and pointermove
 * (which an `act()` boundary forces), the notification can remount and the move
 * arrives on a gesture whose `isActive` was just cleared: the handler runs but
 * returns early, `activateDrag()` never fires and `body.userSelect` stays empty.
 * Whether that re-render lands depends on unrelated timer/microtask pressure in
 * the process, which is why the split version passed alone and failed ~half the
 * time in a full run. Keeping the gesture atomic removes the race window instead
 * of weakening what the test asserts.
 */
async function dragAcross(toast: HTMLElement) {
	// Let every pending render/effect settle FIRST, so the gesture starts against a
	// notification whose refs have stopped churning. Mantine's NotificationContainer
	// binds useDrag through `useMergedRef(ref, notificationRef, dragRef)`, and
	// useMergedRef's useCallback depends on the raw `refs` array: any re-render that
	// hands it a new `ref` identity detaches and re-attaches useDrag's ref callback,
	// whose cleanup resets the gesture ref. If that lands between pointerdown and
	// pointermove, the move handler runs but sees `isActive === false` and returns
	// before activateDrag(), leaving body.userSelect empty. In a full-suite run there
	// is enough timer/microtask pressure for that re-render to arrive mid-gesture,
	// which is exactly why this test passed alone and failed in the whole suite.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
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
	restoreGlobals();
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
