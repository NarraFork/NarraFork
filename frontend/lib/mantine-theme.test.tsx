import { afterEach, expect, test } from "bun:test";
import { Button, MantineProvider, Menu, Modal } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { mantineTheme } from "./mantine-theme";

/**
 * The theme stamps `nf-overlay-layer` onto Mantine's floating parts so WCO mode
 * can subtract them from the window drag region (styles/wco.css). Mantine v9
 * emits no stable component classes, so this injection is the only hook the CSS
 * has — a silent regression here (renamed class, dropped theme wiring) makes
 * overlays above the header unclickable in the installed PWA with no test
 * noticing otherwise.
 */

let root: Root | undefined;
let restoreDom: (() => void) | undefined;

afterEach(() => {
	restoreDom?.();
	restoreDom = undefined;
	root = undefined;
});

test("mantineTheme stamps nf-overlay-layer on Modal root and Menu dropdown", async () => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const globals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	Object.assign(window, {
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	});
	const previous = new Map(
		Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	Object.assign(globalThis, globals);
	restoreDom = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};

	const container = window.document.createElement("div");
	window.document.body.append(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<MantineProvider theme={mantineTheme} env="test">
				<Modal opened onClose={() => {}} title="t">
					body
				</Modal>
				<Menu opened>
					<Menu.Target>
						<Button>x</Button>
					</Menu.Target>
					<Menu.Dropdown>
						<Menu.Item>i</Menu.Item>
					</Menu.Dropdown>
				</Menu>
			</MantineProvider>,
		);
	});

	const hits = window.document.body.innerHTML.match(/nf-overlay-layer/g) ?? [];
	// One on the Modal root, one on the Menu dropdown.
	expect(hits.length).toBeGreaterThanOrEqual(2);
});
