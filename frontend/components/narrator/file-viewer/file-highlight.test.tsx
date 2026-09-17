import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import * as shikiLoader from "../../../lib/shiki-loader";
import { HighlightedCode } from "../markdown/HighlightedCode";
import { clearHighlightCache, MAX_FILE_HIGHLIGHT_CODE_CHARS } from "../markdown/highlight-cache";

let core: Awaited<ReturnType<typeof createHighlighterCore>>;
let root: Root;
let container: HTMLDivElement;
let loaderSpy: ReturnType<typeof spyOn<typeof shikiLoader, "loadShiki">>;
const globalKeys = [
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"Element",
	"Node",
	"matchMedia",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();

beforeAll(async () => {
	core = await createHighlighterCore({
		engine: createOnigurumaEngine(import("shiki/wasm")),
		langs: [import("shiki/langs/typescript.mjs")],
		themes: [
			import("shiki/themes/github-dark-default.mjs"),
			import("shiki/themes/github-light-default.mjs"),
		],
	});
});

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const key of globalKeys)
		originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	const overrides = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(overrides)) {
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	clearHighlightCache();
	loaderSpy = spyOn(shikiLoader, "loadShiki").mockResolvedValue({
		bundledLanguages: { typescript: true },
		codeToHtml: async (code, options) => core.codeToHtml(code, options),
		codeToTokens: async (code, options) => core.codeToTokens(code, options),
	});
});

afterEach(async () => {
	try {
		await act(async () => root?.unmount());
		container?.remove();
	} finally {
		loaderSpy?.mockRestore();
		clearHighlightCache();
		for (const [key, descriptor] of originalGlobals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		originalGlobals.clear();
	}
});
afterAll(() => {
	core.dispose();
});

async function render(
	code: string,
	maxHighlightChars?: number,
	scheme: "dark" | "light" = "dark",
	lang = "typescript",
) {
	await act(async () => {
		root.render(
			<MantineProvider forceColorScheme={scheme}>
				<HighlightedCode code={code} lang={lang} maxHighlightChars={maxHighlightChars} />
			</MantineProvider>,
		);
	});
}

const SOURCE = 'const value = "中文"; // comment\n'.repeat(900);

describe("file-panel highlighting budget", () => {
	test("a 20k+ file is highlighted with its entire content, without changing chat defaults", async () => {
		expect(SOURCE.length).toBeGreaterThan(20_000);
		await render(SOURCE);
		expect(container.querySelector(".shiki")).toBeNull();
		expect(loaderSpy).not.toHaveBeenCalled();

		await render(SOURCE, MAX_FILE_HIGHLIGHT_CODE_CHARS);
		const code = container.querySelector(".shiki code");
		expect(code).not.toBeNull();
		expect(code?.textContent).toBe(SOURCE);
		expect(container.querySelectorAll(".shiki span[style]").length).toBeGreaterThan(100);
	});

	test("theme changes recolour file source without modifying its text", async () => {
		await render(SOURCE, MAX_FILE_HIGHLIGHT_CODE_CHARS);
		const dark = container.querySelector(".shiki span[style]")?.getAttribute("style");
		await render(SOURCE, MAX_FILE_HIGHLIGHT_CODE_CHARS, "light");
		expect(container.querySelector(".shiki span[style]")?.getAttribute("style")).not.toBe(dark);
		expect(container.querySelector(".shiki code")?.textContent).toBe(SOURCE);
	});

	test("oversized and unknown-language files remain readable in full", async () => {
		const large = "x".repeat(MAX_FILE_HIGHLIGHT_CODE_CHARS + 1);
		await render(large, Number.POSITIVE_INFINITY);
		expect(container.querySelector(".shiki")).toBeNull();
		expect(container.querySelector("pre")?.textContent).toBe(large);
		expect(loaderSpy).not.toHaveBeenCalled();

		await render(SOURCE, MAX_FILE_HIGHLIGHT_CODE_CHARS, "dark", "unknown-language");
		expect(container.querySelector(".shiki")).toBeNull();
		expect(container.querySelector("pre")?.textContent).toBe(SOURCE);
	});
});
