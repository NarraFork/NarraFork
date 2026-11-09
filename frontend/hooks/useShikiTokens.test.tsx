import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as tokenCache from "@frontend/lib/shiki-token-cache";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TokenFlowText } from "../components/narrator/content/TokenLines";
import { useShikiTokens } from "./useShikiTokens";

let root: Root;
let container: HTMLDivElement;
let restore: () => void;
let cache: tokenCache.ShikiTokenCache;
let latest: tokenCache.ShikiToken[][] | null;
let pending: Map<string, (tokens: tokenCache.ShikiToken[][] | null) => void>;

function Fixture({ code, lang }: { code: string; lang?: string }) {
	latest = useShikiTokens(code, lang);
	return (
		<pre>
			<TokenFlowText text={code} tokens={latest} />
		</pre>
	);
}

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const values = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const previous = new Map(
		Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	for (const [key, value] of Object.entries(values))
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	pending = new Map();
	cache = tokenCache.createShikiTokenCache(
		(code) => new Promise((resolve) => pending.set(code, resolve)),
	);
	const spies = [
		spyOn(tokenCache, "getShikiTokens").mockImplementation(cache.get),
		spyOn(tokenCache, "subscribeShikiTokens").mockImplementation(cache.subscribe),
		spyOn(tokenCache, "getShikiTokensVersion").mockImplementation(cache.getVersion),
	];
	restore = () => {
		for (const spy of spies) spy.mockRestore();
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	try {
		await act(async () => root.unmount());
		container.remove();
	} finally {
		restore();
	}
});

async function render(code: string, lang: string | null = "typescript", light = false) {
	await act(async () => {
		root.render(
			<MantineProvider forceColorScheme={light ? "light" : "dark"}>
				<Fixture code={code} lang={lang ?? undefined} />
			</MantineProvider>,
		);
	});
	expect(container.querySelector("pre")?.textContent).toBe(code);
}

async function highlight(code: string, color = "#ff7b72", tokens?: tokenCache.ShikiToken[][]) {
	const resolve = pending.get(code);
	expect(resolve).toBeDefined();
	pending.delete(code);
	await act(async () => {
		resolve?.(tokens ?? code.split("\n").map((content) => [{ content, color }]));
	});
}

function coloredText() {
	return [...container.querySelectorAll("pre span[style]")]
		.map((span) => span.textContent)
		.join("");
}

describe("streaming Shiki tokens", () => {
	test("keeps the confirmed prefix coloured while appends wait for asynchronous tokens", async () => {
		await render("const value");
		expect(latest).toBeNull();
		await highlight("const value");
		const prefix = container.querySelector("pre span");
		expect(coloredText()).toBe("const value");

		await render("const value =");
		expect(coloredText()).toBe("const value");
		expect(container.querySelector("pre span")).toBe(prefix);
		await render("const value = 1;");
		expect(coloredText()).toBe("const value");
		expect(container.querySelector("pre span")).toBe(prefix);

		// A late result for a superseded prefix must not erase the current colours.
		await highlight("const value =", "#abcdef");
		expect(coloredText()).toBe("const value");
		await highlight("const value = 1;", "#a5d6ff");
		expect(coloredText()).toBe("const value = 1;");
		expect(container.querySelector("pre span")?.getAttribute("style")).toContain("#a5d6ff");
	});

	test("preserves blank lines, trailing newlines, tabs and split UTF-16 units", async () => {
		const prefix = "const 中文 = 1;\n\n";
		await render(prefix);
		await highlight(prefix);
		const next = `${prefix}\tconst emoji = "\ud83d`;
		await render(next);
		expect(coloredText()).toBe("const 中文 = 1;");
		await render(`${next}\ude00";\n`);
		expect(coloredText()).toBe("const 中文 = 1;");
		await highlight(`${next}\ude00";\n`);
		expect(coloredText()).toBe('const 中文 = 1;\tconst emoji = "😀";');
	});

	test("invalidates old colours after replacement, even if a later value extends the old prefix", async () => {
		await render("const a");
		await highlight("const a");
		await render("let b");
		expect(latest).toBeNull();
		await render("const a = 2");
		expect(latest).toBeNull();
	});

	test("does not reuse colours across truncation or clearing", async () => {
		await render("const a");
		await highlight("const a");
		await render("const");
		expect(latest).toBeNull();
		await render("const a = 2");
		expect(latest).toBeNull();
		await highlight("const a = 2");
		await render("");
		expect(latest).toBeNull();
		await render("const a = 23");
		expect(latest).toBeNull();
	});

	test("drops retained colours when the language or theme changes", async () => {
		await render("const a");
		await highlight("const a");
		await render("const a = 1", "javascript");
		expect(latest).toBeNull();
		await highlight("const a = 1");
		await render("const a = 12", "javascript", true);
		expect(latest).toBeNull();
		await highlight("const a = 12", "#112233");
		expect(container.querySelector("pre span")?.getAttribute("style")).toContain("#112233");
	});

	test("plain or unspecified languages and oversized bodies do not retain tokens", async () => {
		await render("const a");
		await highlight("const a");
		await render("const a = 1", "text");
		expect(latest).toBeNull();
		await render("const a = 12", null);
		expect(latest).toBeNull();
		await render("const a = 123");
		await highlight("const a = 123");
		await render(`const a = 123${"x".repeat(tokenCache.MAX_HIGHLIGHT_CODE_CHARS)}`);
		expect(latest).toBeNull();
		expect(cache.stats().inFlight).toBe(0);
	});

	test("does not retain a normalized token stream that differs from the source", async () => {
		await render("a\r\nb");
		await highlight("a\r\nb", "#ff0000", [[{ content: "a" }], [{ content: "b" }]]);
		expect(coloredText()).toBe("");
		await render("a\r\nbc");
		expect(latest).toBeNull();
	});

	test("cached complete tokens win immediately without changing the cached arrays", async () => {
		await render("const a");
		await highlight("const a");
		const cached = latest;
		const snapshot = JSON.stringify(cached);
		await render("const a = 1\nreturn a");
		expect(coloredText()).toBe("const a");
		expect(JSON.stringify(cached)).toBe(snapshot);
		await highlight("const a = 1\nreturn a", "#abcdef");
		const complete = latest;
		await render("const a = 1\nreturn a");
		expect(latest).toBe(complete);
	});
});
