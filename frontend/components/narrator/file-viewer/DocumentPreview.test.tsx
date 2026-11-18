/**
 * `DocumentPreview` — the read-only DOCX preview surface.
 *
 * Two behaviours are load-bearing beyond "it renders":
 *   1. a legacy `.doc` must show the "re-save as .docx" message, not an error or blank area, and
 *   2. a remote device must issue NO request at all — the parse endpoints are local `/api/fs/*`,
 *      so forwarding a remote path could silently show the server's own file of the same name.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const realReactI18nextModule = { ...(await import("react-i18next")) };
/** Stable identity, like the real translator: a new `t` per render would churn every effect. */
const translate = (key: string, options?: { defaultValue?: string }) =>
	options?.defaultValue ?? key;
mock.module("react-i18next", () => ({
	useTranslation: () => ({ t: translate }),
}));

/**
 * The real renderer is exercised by `markdown/MarkdownImage.test.tsx` and the other
 * `MarkdownContent.*` suites; here it is stubbed so this test asserts what THIS component
 * decides — which text reaches the renderer, and which branch is shown at all.
 */
mock.module("../markdown/MarkdownContent", () => ({
	MarkdownContent: ({ text }: { text: string }) => <pre data-testid="markdown-body">{text}</pre>,
}));

const { DocumentPreview } = await import("./DocumentPreview");

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let requested: string[];
let respond: () => Response;

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
	Object.assign(window, {
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		matchMedia,
		innerWidth: 1024,
		innerHeight: 768,
	});
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		ResizeObserver: TestResizeObserver,
		matchMedia,
		getComputedStyle: window.getComputedStyle?.bind(window) ?? (() => ({})),
		IS_REACT_ACT_ENVIRONMENT: true,
	});
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
	installDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	requested = [];
	respond = () =>
		Response.json({
			ok: true,
			result: { markdown: "", assets: [], truncated: false, omitted: [], meta: {} },
		});
	globalThis.fetch = (async (input: string | URL | Request) => {
		requested.push(String(input));
		return respond();
	}) as typeof fetch;
});

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
	globalThis.fetch = originalFetch;
});

afterAll(() => {
	mock.module("react-i18next", () => realReactI18nextModule);
	mock.restore();
});
async function render(element: React.ReactElement) {
	await act(async () => {
		root?.render(<MantineProvider>{element}</MantineProvider>);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

describe("document preview", () => {
	test("renders the server's Markdown with the shared markdown renderer", async () => {
		respond = () =>
			Response.json({
				ok: true,
				result: {
					markdown: "# 报告\n\n正文内容",
					assets: [{ id: "a1", mime: "image/png", byteLength: 10 }],
					truncated: false,
					omitted: [],
					meta: {},
				},
			});
		await render(<DocumentPreview filePath="/repo/spec.docx" />);
		expect(requested).toHaveLength(1);
		expect(requested[0]).toContain("/fs/document-preview");
		// The server's Markdown is handed to the shared renderer verbatim — that is what keeps a
		// document preview looking like a `.md` preview.
		expect(container?.querySelector('[data-testid="markdown-body"]')?.textContent).toBe(
			"# 报告\n\n正文内容",
		);
	});

	test("shows the re-save hint for a legacy .doc", async () => {
		respond = () =>
			Response.json({
				ok: false,
				failure: { kind: "legacy-office", reason: "legacy-office", detail: "OLE" },
			});
		await render(<DocumentPreview filePath="/repo/legacy.doc" />);
		expect(container?.textContent).toContain("legacy .doc");
	});

	test("notes truncation instead of silently stopping", async () => {
		respond = () =>
			Response.json({
				ok: true,
				result: { markdown: "# 报告", assets: [], truncated: true, omitted: [], meta: {} },
			});
		await render(<DocumentPreview filePath="/repo/long.docx" />);
		expect(container?.textContent).toContain("long");
	});

	/**
	 * The safety property: a remote device's path must never be read through the local
	 * `/api/fs/*` endpoints, where a same-named local file would be shown as if it were remote.
	 */
	test("a remote device issues no request at all", async () => {
		await render(<DocumentPreview filePath="/repo/spec.docx" deviceId="RemoteABC" />);
		expect(requested).toHaveLength(0);
		expect(container?.textContent).toContain("only available on the device");
	});
});
