/**
 * RenderChatMessageBody.anchor.test.tsx — the chat renderer must handle
 * document-internal `#heading` links the same way the other two markdown paths
 * do.
 *
 * This is the third renderer sharing the prepared layer, and it was the easiest
 * one to leave behind: it has its own copy of the fragment-painting loop, so the
 * fix had to be applied a third time by hand. A miss here is invisible — the link
 * still paints, still looks like a link, and quietly opens a blank tab.
 *
 * The scope assertion carries the most weight in this path. A chat room stacks
 * many messages into one scroller and different messages routinely repeat a
 * heading, so an unscoped lookup would jump the reader to somebody else's message.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MD_HEADING_SLUG_ATTR } from "@frontend/lib/markdown-anchor-scroll";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";

// Dynamic import: the canvas stub must exist before any pretext-backed module
// loads (same convention as measure-chat-message.test.ts).
const { installCanvasStub } = await import("../narrator/vlist/measure/test-canvas-stub");
installCanvasStub();

const { measureChatMessage } = await import("./measure-chat-message");
const { RenderChatMessageBody } = await import("./RenderChatMessageBody");

const WIDTH = 480;

/**
 * Globals the linkedom realm replaces, restored afterwards.
 *
 * Bun runs every test file in one process, so a realm left installed here becomes the
 * `Element`/`Event` of whatever file runs next: `app-shell-scroll.test.tsx` records a
 * case where exactly that made unrelated `instanceof` assertions fail, with a message
 * pointing at the innocent file. Saved as descriptors rather than values because some
 * of these do not exist under Bun at all, and writing `undefined` back is not the same
 * as removing them.
 */
const DOM_GLOBAL_NAMES = [
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"Element",
	"Node",
	"getComputedStyle",
	"matchMedia",
	"ResizeObserver",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;

const previousGlobals = new Map<string, PropertyDescriptor | undefined>();

function setGlobal(name: string, value: unknown): void {
	if (!previousGlobals.has(name)) {
		previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	}
	Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

beforeAll(() => {
	installCanvasStub();
	const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
	const g = globalThis as unknown as Record<string, unknown>;
	setGlobal("window", win);
	setGlobal("document", win.document);
	setGlobal("navigator", win.navigator);
	setGlobal("HTMLElement", win.HTMLElement);
	setGlobal("Element", win.Element);
	setGlobal("Node", win.Node);
	setGlobal("getComputedStyle", win.getComputedStyle);
	setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	if (typeof g.matchMedia !== "function") {
		setGlobal("matchMedia", () => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
		}));
	}
	if (typeof g.ResizeObserver !== "function") {
		setGlobal(
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		);
	}
});

afterAll(() => {
	for (const name of DOM_GLOBAL_NAMES) {
		if (!previousGlobals.has(name)) continue;
		const descriptor = previousGlobals.get(name);
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	previousGlobals.clear();
});

/** Render one chat message body and report what the anchors/headings look like. */
function renderBody(text: string) {
	const measured = measureChatMessage({ text }, WIDTH);
	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	act(() => {
		reactRoot.render(
			<MantineProvider>
				<RenderChatMessageBody measured={measured} deletedLabel="已删除" />
			</MantineProvider>,
		);
	});

	return {
		container,
		headingSlugs: Array.from(container.querySelectorAll(`[${MD_HEADING_SLUG_ATTR}]`), (el) =>
			el.getAttribute(MD_HEADING_SLUG_ATTR),
		),
		anchors: Array.from(container.querySelectorAll("a")).map((a) => ({
			href: a.getAttribute("href"),
			target: a.getAttribute("target"),
			rel: a.getAttribute("rel"),
			text: a.textContent ?? "",
		})),
		predictedBodyHeight: measured.bodyHeight,
		unmount: () => {
			act(() => reactRoot.unmount());
			container.remove();
		},
	};
}

describe("chat headings advertise anchor slugs", () => {
	it("tags a heading with its slug", () => {
		const r = renderBody("## 实现细节\n\n正文");
		expect(r.headingSlugs).toEqual(["实现细节"]);
		r.unmount();
	});

	it("does not tag paragraphs or list items", () => {
		const r = renderBody("正文段落\n\n- 列表项");
		expect(r.headingSlugs).toEqual([]);
		r.unmount();
	});

	it("does not tag a heading with nothing sluggable", () => {
		const r = renderBody("## ***");
		expect(r.headingSlugs).toEqual([]);
		r.unmount();
	});
});

describe("chat link targets", () => {
	it("gives a same-document anchor no target", () => {
		const r = renderBody("## 目标\n\n见 [下文](#目标)");
		const anchor = r.anchors.find((a) => a.text === "下文");
		expect(anchor?.href).toBe("#目标");
		// The defect being fixed: `_blank` on a fragment opened a blank tab.
		expect(anchor?.target).toBeNull();
		expect(anchor?.rel).toBeNull();
		r.unmount();
	});

	it("still opens real destinations in a new tab", () => {
		const r = renderBody("见 [外链](https://example.com) 与 [他文档](docs.md#section)");
		expect(r.anchors).toHaveLength(2);
		for (const anchor of r.anchors) {
			expect(anchor.target, `must stay external: ${anchor.href}`).toBe("_blank");
			expect(anchor.rel).toBe("noopener noreferrer");
		}
		r.unmount();
	});

	it("scopes each message so a click cannot reach another message's heading", () => {
		// Each body is its own `[data-md-body]`. Two messages in one room:
		// the link is in the first, the heading only in the second.
		const withLink = renderBody("见 [目标](#目标)");
		const withHeading = renderBody("## 目标\n\n乙");

		const scope = withLink.container.querySelector("a")?.closest("[data-md-body]");
		expect(scope).not.toBeNull();
		expect(scope?.querySelector(`[${MD_HEADING_SLUG_ATTR}="目标"]`)).toBeNull();
		// It does exist elsewhere in the document, so only the scope kept it out.
		expect(withHeading.container.querySelector(`[${MD_HEADING_SLUG_ATTR}="目标"]`)).not.toBeNull();

		withLink.unmount();
		withHeading.unmount();
	});

	it("finds a heading in its own message", () => {
		const r = renderBody("## 目标\n\n见 [上文](#目标)");
		const scope = r.container.querySelector("a")?.closest("[data-md-body]");
		expect(scope?.querySelector(`[${MD_HEADING_SLUG_ATTR}="目标"]`)).not.toBeNull();
		r.unmount();
	});
});

describe("chat anchors are height-neutral", () => {
	it("measures the same body height with an internal or external link", () => {
		// The slug is an attribute and the link change only drops `target`; neither
		// may move the reserved geometry this path pins its box to.
		const internal = measureChatMessage({ text: "## 目标\n\n见 [下文](#目标) 说明" }, WIDTH);
		const external = measureChatMessage(
			{ text: "## 目标\n\n见 [下文](https://exa.co) 说明" },
			WIDTH,
		);
		expect(internal.bodyHeight).toBe(external.bodyHeight);
	});
});
