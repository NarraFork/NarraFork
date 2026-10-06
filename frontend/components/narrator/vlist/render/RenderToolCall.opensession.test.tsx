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
 * Placement: the button rides the meta header's BADGES ROW (the card's second
 * line, next to the type/target/timeout chips) — never the toggleable header
 * row, whose timing indicator keeps its right-edge position. These tests pin
 * both the placement and the keyboard behaviour.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { getCategory } from "../../tool-call/tool-display";
import type { ToolCallData } from "../measure/measure-tool-call";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { type AdapterToolItem, adaptSegments } from "../segment-adapter";
import { RenderToolCall } from "./RenderToolCall";

const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

let measureToolCall: typeof import("../measure/measure-tool-call").measureToolCall;

beforeAll(async () => {
	measureToolCall = (await import("../measure/measure-tool-call")).measureToolCall;
});

const WIDTH = 600;
const LOD = 5;

/** The real adapter chain, so the card's detail carries the actual Await badges row. */
function awaitCardData(status: "running" | "success" = "running"): ToolCallData {
	const item: AdapterToolItem = {
		blockIndex: 0,
		isSubagent: false,
		tc: {
			toolUseId: "await-call",
			toolName: "Await",
			status,
			inputJson: { type: "agent", id: "plan-story-retirement" },
			outputJson: "done",
		},
	};
	const specs = adaptSegments([{ kind: "tool-run", items: [item], sourceMessages: [] }], {
		lod: LOD,
		// Without the real categorizer the adapter files the call under "generic",
		// whose detail has no badges row — the very row this suite is about.
		resolveToolCategory: (name, input) => getCategory(name, input),
	});
	const spec = specs[0];
	if (!spec || spec.kind !== "tool-call") throw new Error("await tool-call spec not found");
	return spec.data as ToolCallData;
}

function measureAwaitCard(opened: boolean, status: "running" | "success" = "running") {
	return measureToolCall(awaitCardData(status), WIDTH, LOD, { opened });
}

function render(node: ReactNode): Element {
	const html = renderToStaticMarkup(
		<MantineProvider forceColorScheme="dark">{node}</MantineProvider>,
	);
	const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
	return document.getElementById("r") as unknown as Element;
}

function awaitCard(opts: {
	onOpenSession?: () => void;
	label?: string;
	opened?: boolean;
	status?: "running" | "success";
}): Element {
	return render(
		<RenderToolCall
			measured={measureAwaitCard(opts.opened ?? true, opts.status ?? "running")}
			{...(opts.onOpenSession ? { onOpenSession: opts.onOpenSession } : {})}
			{...(opts.label ? { labels: { openSession: opts.label } } : {})}
		/>,
	);
}

describe("RenderToolCall — Await card open-session button", () => {
	it("draws a real button on the badges row of an expanded card", () => {
		const root = awaitCard({ onOpenSession: () => {} });
		const button = root.querySelector('[data-testid="tool-open-session"]');
		if (!button) throw new Error("open-session button not found");
		expect(button.tagName.toLowerCase()).toBe("button");
		// The default label matches the subagent card's own affordance.
		expect(button.textContent).toBe("Open full session");
		// It sits beside the meta badges (AGENT / target / TIMEOUT chips)…
		const row = button.parentElement;
		expect(row?.querySelector(".mantine-Badge-root")).not.toBeNull();
		// …and never in the toggleable header row: the timing indicator keeps its
		// right-edge position whether or not the button exists.
		expect(button.closest("[data-nf-card-header]")).toBeNull();
		expect(
			root.querySelector("[data-nf-card-header] [data-testid='tool-open-session']"),
		).toBeNull();
	});

	it("honours the injected localized label", () => {
		const root = awaitCard({ onOpenSession: () => {}, label: "打开完整会话" });
		expect(root.querySelector('[data-testid="tool-open-session"]')?.textContent).toBe(
			"打开完整会话",
		);
	});

	it("draws nothing when no session can be opened", () => {
		const root = awaitCard({});
		expect(root.querySelector('[data-testid="tool-open-session"]')).toBeNull();
	});

	it("folds away with the detail on a collapsed card", () => {
		// A SETTLED call: a running one is lodExempt and stays expanded regardless.
		const root = awaitCard({ onOpenSession: () => {}, opened: false, status: "success" });
		// The button lives in the detail region, which a folded card does not paint.
		expect(root.querySelector('[data-testid="tool-open-session"]')).toBeNull();
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
				await act(async () => {
					root.render(
						<MantineProvider forceColorScheme="dark">
							<RenderToolCall
								measured={measureAwaitCard(true)}
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
});
