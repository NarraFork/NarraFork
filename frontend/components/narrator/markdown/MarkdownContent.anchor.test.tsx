/**
 * MarkdownContent.anchor.test.tsx — the react-markdown path must render
 * document-internal `#heading` links in-place, and tag headings so they can be
 * found.
 *
 * This is the renderer behind the knowledge base, the changelog, the spec panel
 * and markdown file previews — all of which live inside a panel's own scroller
 * (Mantine `ScrollArea`, a dockview panel, a modal). There, a native fragment
 * navigation is doubly wrong: it scrolls the document rather than the panel, and
 * TanStack Router reads the pushed `#…` as a route change, which is the visible
 * "page jumped" symptom.
 *
 * Both failure modes are silent — a link that looks correct and does the wrong
 * thing — so the assertions read the painted DOM.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MD_HEADING_SLUG_ATTR } from "@frontend/lib/markdown-anchor-scroll";
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MarkdownContent } from "./MarkdownContent";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

type DomGlobalName =
	| "window"
	| "document"
	| "navigator"
	| "HTMLElement"
	| "Element"
	| "Node"
	| "Text"
	| "IS_REACT_ACT_ENVIRONMENT";

const DOM_GLOBAL_NAMES: readonly DomGlobalName[] = [
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"Element",
	"Node",
	"Text",
	"IS_REACT_ACT_ENVIRONMENT",
];

let previousGlobals: Partial<Record<DomGlobalName, PropertyDescriptor | undefined>>;

function installDom() {
	previousGlobals = Object.fromEntries(
		DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
	) as Partial<Record<DomGlobalName, PropertyDescriptor | undefined>>;

	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
}

function restoreGlobals() {
	for (const name of DOM_GLOBAL_NAMES) {
		const descriptor = previousGlobals[name];
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
}

async function render(element: ReactElement) {
	const currentRoot = root;
	if (!currentRoot) throw new Error("test root is not initialized");
	await act(async () => {
		currentRoot.render(element);
	});
}

beforeEach(() => {
	installDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	const currentRoot = root;
	if (currentRoot) act(() => currentRoot.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
	restoreGlobals();
});

/** Every painted anchor, with the attributes that decide its behaviour. */
function anchors() {
	if (!container) throw new Error("no container");
	return Array.from(container.querySelectorAll("a")).map((a) => ({
		href: a.getAttribute("href"),
		target: a.getAttribute("target"),
		rel: a.getAttribute("rel"),
		text: a.textContent ?? "",
	}));
}

/** Heading slugs in document order. */
function headingSlugs() {
	if (!container) throw new Error("no container");
	return Array.from(container.querySelectorAll(`[${MD_HEADING_SLUG_ATTR}]`), (el) =>
		el.getAttribute(MD_HEADING_SLUG_ATTR),
	);
}

describe("MarkdownContent heading anchors", () => {
	test("tags every heading level with its slug", async () => {
		await render(
			<MarkdownContent
				text={["# One", "## Two", "### Three", "#### Four", "##### Five", "###### Six"].join(
					"\n\n",
				)}
			/>,
		);
		expect(headingSlugs()).toEqual(["one", "two", "three", "four", "five", "six"]);
	});

	test("keeps CJK heading text in the slug", async () => {
		await render(<MarkdownContent text={"## 实现细节\n\n正文"} />);
		expect(headingSlugs()).toEqual(["实现细节"]);
	});

	test("slugs the heading's visible text, not a link inside it", async () => {
		await render(<MarkdownContent text={"## 见 [文档](https://example.com/docs)"} />);
		expect(headingSlugs()).toEqual(["见-文档"]);
	});

	test("emits no attribute for a heading with nothing sluggable", async () => {
		// `id=""` / `data-md-heading=""` would match an empty lookup and turn every
		// unresolvable anchor into a jump to this heading.
		await render(<MarkdownContent text={"## ***"} />);
		expect(headingSlugs()).toEqual([]);
	});

	test("uses a data attribute rather than duplicate ids across bodies", async () => {
		// Two bodies in one document with the same heading: as `id` these would be
		// duplicates (invalid HTML, and getElementById returns only the first).
		await render(
			<>
				<MarkdownContent text={"## 结论\n\n甲"} />
				<MarkdownContent text={"## 结论\n\n乙"} />
			</>,
		);
		expect(headingSlugs()).toEqual(["结论", "结论"]);
		const headings = container?.querySelectorAll(`[${MD_HEADING_SLUG_ATTR}="结论"]`);
		expect(headings?.length).toBe(2);
		for (const heading of headings ?? []) expect(heading.getAttribute("id")).toBeNull();
	});
});

describe("MarkdownContent link targets", () => {
	test("gives a same-document anchor no target", async () => {
		await render(<MarkdownContent text={"## 实现细节\n\n见 [下文](#实现细节)"} />);
		const anchor = anchors().find((a) => a.text === "下文");
		// react-markdown's `defaultUrlTransform` percent-encodes the destination, so a
		// CJK fragment reaches the DOM escaped. This is what makes the decode step in
		// `parseSameDocumentAnchor` load-bearing rather than a convenience: comparing
		// the raw fragment against the heading's slug would never match on this path,
		// and the failure would be a dead click with no error.
		expect(anchor?.href).toBe("#%E5%AE%9E%E7%8E%B0%E7%BB%86%E8%8A%82");
		// The defect: `_blank` opened a new tab at a fragment that resolved nowhere.
		expect(anchor?.target).toBeNull();
		expect(anchor?.rel).toBeNull();
	});

	test("resolves an ASCII fragment untouched by url encoding", async () => {
		await render(
			<MarkdownContent text={"## Implementation Details\n\n见 [下文](#implementation-details)"} />,
		);
		const anchor = anchors().find((a) => a.text === "下文");
		expect(anchor?.href).toBe("#implementation-details");
		expect(anchor?.target).toBeNull();
	});

	test("still opens real destinations in a new tab", async () => {
		await render(
			<MarkdownContent
				text={"见 [外链](https://example.com)、[路由](/knowledge/e1) 与 [他文档](docs.md#section)"}
			/>,
		);
		const painted = anchors();
		expect(painted).toHaveLength(3);
		for (const anchor of painted) {
			expect(anchor.target, `must stay external: ${anchor.href}`).toBe("_blank");
			expect(anchor.rel).toBe("noopener noreferrer");
		}
	});

	test("scopes each body so a click cannot reach the other body's heading", async () => {
		// Anchor resolution walks to `[data-md-body]`. Each MarkdownContent must be its
		// own scope, or a link in the first body would jump into the second.
		await render(
			<>
				<MarkdownContent text={"见 [结论](#结论)"} />
				<MarkdownContent text={"## 结论\n\n乙"} />
			</>,
		);
		const anchor = container?.querySelector("a");
		const scope = anchor?.closest("[data-md-body]");
		expect(scope).not.toBeNull();
		// The heading lives in the OTHER body, so this scope must not find it — the
		// click resolves to nothing rather than jumping across bodies.
		expect(scope?.querySelector(`[${MD_HEADING_SLUG_ATTR}="结论"]`)).toBeNull();
		// It does exist in the document, proving only the scope kept it out.
		expect(container?.querySelector(`[${MD_HEADING_SLUG_ATTR}="结论"]`)).not.toBeNull();
	});

	test("finds a heading in its own body", async () => {
		await render(<MarkdownContent text={"## 结论\n\n见 [上文](#结论)"} />);
		const scope = container?.querySelector("a")?.closest("[data-md-body]");
		expect(scope?.querySelector(`[${MD_HEADING_SLUG_ATTR}="结论"]`)).not.toBeNull();
	});
});
