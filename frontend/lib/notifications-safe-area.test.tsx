import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppNotifications } from "@frontend/components/AppNotifications";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TOP_NOTIFICATION_SAFE_AREA_CLASSNAME } from "./safe-area";

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

function installIsolatedDom() {
	const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
	for (const key of GLOBAL_KEYS) {
		descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	}

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

beforeEach(() => {
	installIsolatedDom();
	notifications.clean();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => notifications.clean());
	await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
	restoreGlobals?.();
	restoreGlobals = undefined;
});

describe("Notifications top safe-area contract", () => {
	test("the rendered top containers match the safe-area selector while bottom containers do not", async () => {
		const css = await Bun.file(new URL("../styles/safe-area.css", import.meta.url)).text();
		const style = document.createElement("style");
		style.textContent = css;
		document.head.appendChild(style);

		await act(async () => {
			root?.render(
				<MantineProvider env="test">
					<AppNotifications />
				</MantineProvider>,
			);
		});
		await act(async () => {
			notifications.show({ id: "top", message: "Top", position: "top-right", autoClose: false });
			notifications.show({
				id: "bottom",
				message: "Bottom",
				position: "bottom-right",
				autoClose: false,
			});
		});

		const selector = `.${TOP_NOTIFICATION_SAFE_AREA_CLASSNAME}[data-position^="top-"]`;
		const roots = [
			...document.querySelectorAll<HTMLElement>(`.${TOP_NOTIFICATION_SAFE_AREA_CLASSNAME}`),
		];
		const topRight = roots.find((element) => element.dataset.position === "top-right");
		const bottomRight = roots.find((element) => element.dataset.position === "bottom-right");

		expect(roots).toHaveLength(6);
		expect(topRight?.matches(selector)).toBe(true);
		expect(bottomRight?.matches(selector)).toBe(false);
		expect(topRight?.textContent).toContain("Top");
		expect(bottomRight?.textContent).toContain("Bottom");

		const rule = [...(style.sheet?.cssRules ?? [])].find(
			(candidate) => (candidate as CSSStyleRule).selectorText === selector,
		) as CSSStyleRule | undefined;
		expect(rule?.style.top).toBe("calc(var(--mantine-spacing-md) + env(safe-area-inset-top, 0px))");
	});
});
