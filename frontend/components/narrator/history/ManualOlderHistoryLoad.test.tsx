import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ManualOlderHistoryLoad } from "./ManualOlderHistoryLoad";

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
		// linkedom provides no rAF. Mantine's Transition calls cancelAnimationFrame
		// on unmount, so without these a Transition left mounted by an EARLIER test
		// file throws during this file's teardown and fails an unrelated assertion.
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

describe("ManualOlderHistoryLoad", () => {
	test("shows and loads older history when automatic loading is disabled", async () => {
		const onLoad = mock(() => {});
		await act(async () => {
			root.render(
				<MantineProvider>
					<ManualOlderHistoryLoad
						autoLoadEnabled={false}
						hasOlder
						loading={false}
						label="Load older messages"
						onLoad={onLoad}
					/>
				</MantineProvider>,
			);
		});

		const button = container.querySelector("button");
		expect(button?.textContent).toContain("Load older messages");
		await act(async () => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(onLoad).toHaveBeenCalledTimes(1);
	});

	test("stays hidden while automatic loading is enabled", async () => {
		await act(async () => {
			root.render(
				<MantineProvider>
					<ManualOlderHistoryLoad
						autoLoadEnabled
						hasOlder
						loading={false}
						label="Load older messages"
						onLoad={() => {}}
					/>
				</MantineProvider>,
			);
		});

		expect(container.querySelector("button")).toBeNull();
	});
});
