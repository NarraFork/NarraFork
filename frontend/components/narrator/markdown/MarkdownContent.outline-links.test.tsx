/**
 * Outline links in session messages: inside a host that opens outline panels they open one
 * (Ctrl/Cmd: a new one) instead of navigating — and before the file-link reading, since
 * `/outline/…` is also an absolute path; outside a host a page link stays an ordinary link,
 * and a tool card's reference link (which only a host can open) is plain text.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	type OutlineOpener,
	OutlineOpenerProvider,
	type OutlineOpenOptions,
} from "../../../lib/outline-opener";
import type { OutlinePanelState } from "../../../lib/outline-panel";
import { FileReferenceScopeProvider } from "../composer/FileReferenceScope";
import { MarkdownContent } from "./MarkdownContent";

const { installCanvasStub } = await import("../vlist/measure/test-canvas-stub");

const globals = [
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"Element",
	"Node",
	"Text",
	"getComputedStyle",
	"matchMedia",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;
let previousGlobals: Map<string, PropertyDescriptor | undefined>;
let disposeCanvas: () => void;
let container: HTMLDivElement;
let root: Root;
let animationId = 0;

beforeEach(() => {
	previousGlobals = new Map(
		globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	disposeCanvas = installCanvasStub();
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		getComputedStyle: window.getComputedStyle,
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	animationId++;
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	disposeCanvas();
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

const TEXT = [
	"See [the design page](/outline/spaceA/pageB?view=all) and [a block](/outline/spaceA/blockC?asOf=4).",
	"",
	"Card link [Ab3dEf9Q](/outline/ref?a=Kx81mPqa%2FAb3dEf9Q) and [docs](https://example.com/x).",
].join("\n");

async function render(
	renderer: "flowing" | "prepared",
	opener: OutlineOpener | null,
	options: { fileScoped?: boolean } = {},
) {
	const { measureMarkdown } = await import("../vlist/measure/measure-markdown");
	const { RenderMarkdown } = await import("../vlist/render/RenderMarkdown");
	const content =
		renderer === "flowing" ? (
			<MarkdownContent text={TEXT} />
		) : (
			<RenderMarkdown
				measured={measureMarkdown(TEXT, 800)}
				animKeyBase={`outline-links-${animationId}`}
				animScope={`outline-links-${animationId}`}
			/>
		);
	const scoped = options.fileScoped ? (
		<FileReferenceScopeProvider
			value={{
				narratorId: "n1",
				context: { deviceId: "local", cwd: "/repo" },
				openFile: () => {
					throw new Error("an outline link must not open as a file");
				},
			}}
		>
			{content}
		</FileReferenceScopeProvider>
	) : (
		content
	);
	await act(async () => {
		root.render(
			<MantineProvider env="test">
				<OutlineOpenerProvider value={opener}>{scoped}</OutlineOpenerProvider>
			</MantineProvider>,
		);
	});
}

function anchorTo(prefix: string): HTMLAnchorElement | undefined {
	return Array.from(container.querySelectorAll<HTMLAnchorElement>("a[href]")).find((a) =>
		a.getAttribute("href")?.startsWith(prefix),
	);
}

async function click(anchor: Element, modifiers: { ctrlKey?: boolean } = {}) {
	const event = new window.Event("click", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "button", { value: 0 });
	Object.defineProperty(event, "ctrlKey", { value: modifiers.ctrlKey === true });
	await act(async () => {
		anchor.dispatchEvent(event);
		// Opening reads the block's page first (here it fails, and the panel opens anyway).
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return event;
}

function recordingOpener() {
	const opened: Array<{ state: OutlinePanelState; options?: OutlineOpenOptions }> = [];
	const opener: OutlineOpener = {
		open: (state, options) => {
			opened.push({ state, options });
			return true;
		},
	};
	return { opener, opened };
}

for (const renderer of ["flowing", "prepared"] as const) {
	describe(`${renderer} outline links`, () => {
		test("inside a session they open a panel in place of navigating, even where paths are files", async () => {
			const { opener, opened } = recordingOpener();
			await render(renderer, opener, { fileScoped: true });
			const page = anchorTo("/outline/spaceA/pageB");
			expect(page?.hasAttribute("data-outline-link")).toBe(true);
			expect(page?.getAttribute("target")).toBeNull();
			const event = await click(page as Element);
			expect(event.defaultPrevented).toBe(true);
			expect(opened[0]).toMatchObject({
				state: { spaceId: "spaceA", blockId: "pageB", view: "all" },
				options: { newPanel: false },
			});
			await click(anchorTo("/outline/spaceA/blockC") as Element, { ctrlKey: true });
			expect(opened[1]).toMatchObject({
				state: { spaceId: "spaceA", blockId: "blockC", asOf: 4 },
				options: { newPanel: true },
			});
			// Ordinary links are untouched.
			expect(anchorTo("https://example.com")?.hasAttribute("data-outline-link")).toBe(false);
		});

		test("outside a host a page link stays a link and a card reference is plain text", async () => {
			await render(renderer, null);
			const page = anchorTo("/outline/spaceA/pageB");
			expect(page).toBeDefined();
			expect(page?.hasAttribute("data-outline-link")).toBe(false);
			expect(anchorTo("/outline/ref")).toBeUndefined();
			expect(container.textContent).toContain("Ab3dEf9Q");
		});
	});
}
