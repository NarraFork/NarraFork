/**
 * RenderToolCall.opensession.test.tsx — the Await-agent card's in-card route to
 * the session it waits on.
 *
 * The subagent card has always drawn an "open full session" button; the Await
 * card — which points at the SAME child — only offered the right-click menu,
 * so the route was invisible on the card itself. The button is bound from the
 * row's `onViewSubagentSession` action (ExactRow wires it for both the
 * standalone card and a drilled-in trace row), so it appears exactly when a
 * session can actually be opened.
 *
 * These tests pin the paint half: a card with the callback draws a real button
 * inside its measured header row; a card without one draws nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolCallData } from "../measure/measure-tool-call";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { RenderToolCall } from "./RenderToolCall";

const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

let measureToolCall: typeof import("../measure/measure-tool-call").measureToolCall;

beforeAll(async () => {
	measureToolCall = (await import("../measure/measure-tool-call")).measureToolCall;
});

const WIDTH = 600;
const LOD = 5;

const AWAIT_CALL = {
	toolName: "Await",
	summary: "agent: worker",
	category: "await",
	status: "running",
} as const;

function render(node: ReactNode): Element {
	const html = renderToStaticMarkup(
		<MantineProvider forceColorScheme="dark">{node}</MantineProvider>,
	);
	const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
	return document.getElementById("r") as unknown as Element;
}

function awaitCard(opts: { onOpenSession?: () => void; label?: string }): Element {
	const measured = measureToolCall({ ...AWAIT_CALL } as ToolCallData, WIDTH, LOD);
	return render(
		<RenderToolCall
			measured={measured}
			{...(opts.onOpenSession ? { onOpenSession: opts.onOpenSession } : {})}
			{...(opts.label ? { labels: { openSession: opts.label } } : {})}
		/>,
	);
}

describe("RenderToolCall — Await card open-session button", () => {
	it("draws a real button in the header when a session can be opened", () => {
		const root = awaitCard({ onOpenSession: () => {} });
		const button = root.querySelector('[data-testid="tool-open-session"]');
		if (!button) throw new Error("open-session button not found");
		expect(button.tagName.toLowerCase()).toBe("button");
		// The default label matches the subagent card's own affordance.
		expect(button.textContent).toBe("Open full session");
		// It lives INSIDE the card header row, so it stays height-neutral.
		expect(button.closest("[data-nf-card-header]")).not.toBeNull();
	});

	it("honours the injected localized label", () => {
		const root = awaitCard({ onOpenSession: () => {}, label: "打开完整会话" });
		expect(root.querySelector('[data-testid="tool-open-session"]')?.textContent).toBe(
			"打开完整会话",
		);
	});

	for (const key of ["Enter", " "]) {
		it(`keeps native ${JSON.stringify(key)} activation without toggling the header`, async () => {
			const { window } = parseHTML("<!doctype html><html><body></body></html>");
			const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
			for (const [name, value] of Object.entries({
				window,
				document: window.document,
				navigator: window.navigator,
				HTMLElement: window.HTMLElement,
				Element: window.Element,
				Node: window.Node,
				getComputedStyle: () => ({ getPropertyValue: () => "", direction: "ltr" }),
				matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
				IS_REACT_ACT_ENVIRONMENT: true,
			})) {
				previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
				Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
			}
			const host = document.createElement("div");
			document.body.appendChild(host);
			const root = createRoot(host);
			let opened = 0;
			let toggled = 0;
			try {
				const measured = measureToolCall({ ...AWAIT_CALL } as ToolCallData, WIDTH, LOD);
				await act(async () => {
					root.render(
						<MantineProvider forceColorScheme="dark">
							<RenderToolCall
								measured={measured}
								onOpenSession={() => opened++}
								onToggle={() => toggled++}
							/>
						</MantineProvider>,
					);
				});
				const button = host.querySelector<HTMLElement>('[data-testid="tool-open-session"]');
				const header = host.querySelector<HTMLElement>("[data-nf-card-header]");
				if (!button || !header) throw new Error("Missing mounted card controls");
				const event = new window.Event("keydown", { bubbles: true, cancelable: true });
				Object.defineProperty(event, "key", { value: key });
				await act(async () => button.dispatchEvent(event));
				expect(event.defaultPrevented).toBe(false);
				expect(toggled).toBe(0);
				// linkedom has no native key-to-click default action. Simulate the click
				// the uncancelled key produces, and verify the session callback alone runs.
				await act(async () => button.click());
				expect(opened).toBe(1);
				expect(toggled).toBe(0);
				const headerEvent = new window.Event("keydown", { bubbles: true, cancelable: true });
				Object.defineProperty(headerEvent, "key", { value: key });
				await act(async () => header.dispatchEvent(headerEvent));
				expect(headerEvent.defaultPrevented).toBe(true);
				expect(toggled).toBe(1);
			} finally {
				await act(async () => root.unmount());
				host.remove();
				for (const [name, descriptor] of previousGlobals) {
					if (descriptor) Object.defineProperty(globalThis, name, descriptor);
					else Reflect.deleteProperty(globalThis, name);
				}
			}
		});
	}

	it("draws nothing when no session can be opened", () => {
		const root = awaitCard({});
		expect(root.querySelector('[data-testid="tool-open-session"]')).toBeNull();
	});
});
