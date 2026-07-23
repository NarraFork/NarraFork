import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import type React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const realLazyCollapseModule = { ...(await import("./LazyCollapse")) };
mock.module("./LazyCollapse", () => ({
	LazyCollapse: ({ in: opened, children }: { in: boolean; children: React.ReactNode }) =>
		opened ? children : null,
}));

const { CollapsibleTrace } = await import("./CollapsibleTrace");

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function installDom() {
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
	const requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0);
	const cancelAnimationFrame = (id: number) => clearTimeout(id);
	Object.defineProperties(window, {
		requestAnimationFrame: { configurable: true, writable: true, value: requestAnimationFrame },
		cancelAnimationFrame: { configurable: true, writable: true, value: cancelAnimationFrame },
		matchMedia: { configurable: true, writable: true, value: matchMedia },
	});
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
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
	if (root) await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
});

afterAll(() => {
	mock.module("./LazyCollapse", () => realLazyCollapseModule);
	mock.restore();
});

describe("CollapsibleTrace row layout", () => {
	test("keeps icon slots and height constraints identical with or without icons", async () => {
		await act(async () => {
			root?.render(
				<MantineProvider>
					<CollapsibleTrace
						items={[
							{ key: "hidden", title: "Hidden" },
							{ key: "with-icon", title: "With icon", icon: <span>i</span> },
							{ key: "without-icon", title: "Without icon" },
						]}
						headerIcon={<span>h</span>}
						headerColor="grape"
						headerLabel="Trace"
						headerCount="3 rows"
						maxVisible={2}
						showEarlierLabel={(count) => `Show ${count} earlier`}
						hideEarlierLabel="Hide earlier"
					/>
				</MantineProvider>,
			);
		});

		const rows = Array.from(
			container?.querySelectorAll<HTMLElement>('[data-testid="collapsible-trace-row"]') ?? [],
		);
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.style.minHeight)).toEqual(["18px", "18px"]);
		expect(
			rows.map((row) => row.querySelector<HTMLElement>("[data-trace-title]")?.style.lineHeight),
		).toEqual(["16px", "16px"]);

		const iconSlots = rows.map((row) => row.querySelector<HTMLElement>("[data-trace-icon-slot]"));
		expect(iconSlots.every((slot) => slot?.style.width === "14px")).toBe(true);
		expect(iconSlots[0]?.childElementCount).toBe(1);
		expect(iconSlots[1]?.childElementCount).toBe(0);

		const earlierRow = container?.querySelector<HTMLElement>(
			'[data-testid="collapsible-trace-earlier-row"]',
		);
		expect(earlierRow?.style.minHeight).toBe("18px");
		expect(earlierRow?.querySelector<HTMLElement>("[data-trace-icon-slot]")?.style.width).toBe(
			"14px",
		);
		expect(earlierRow?.querySelector<HTMLElement>("[data-trace-title]")?.style.lineHeight).toBe(
			"16px",
		);
	});
});
