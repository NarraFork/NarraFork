import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import gitLocale from "../../locales/en/git.json";

const PATCH_ROWS = 1_250;
const patch = [
	`@@ -1,${PATCH_ROWS} +1,${PATCH_ROWS} @@`,
	...Array.from({ length: PATCH_ROWS }, (_, index) => ` ROW_${String(index).padStart(6, "0")}`),
].join("\n");

const realUseGit = { ...(await import("../../hooks/useGit")) };
mock.module("../../hooks/useGit", () => ({
	...realUseGit,
	useGitDiff: () => ({
		data: { diff: patch, truncated: false },
		dataUpdatedAt: 123,
		isLoading: false,
	}),
}));
const { GitFileDiff } = await import("./GitFileDiff");

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

class TestShadowRoot {}

const i18n = i18next.createInstance();
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
	Object.assign(window, {
		ResizeObserver: TestResizeObserver,
		ShadowRoot: TestShadowRoot,
		matchMedia,
		getSelection: () => ({ anchorNode: null }),
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
	});
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		ResizeObserver: TestResizeObserver,
		ShadowRoot: TestShadowRoot,
		matchMedia,
		requestAnimationFrame: window.requestAnimationFrame,
		cancelAnimationFrame: window.cancelAnimationFrame,
		getComputedStyle: window.getComputedStyle?.bind(window) ?? (() => ({})),
		IS_REACT_ACT_ENVIRONMENT: false,
	});
}

async function flushRender() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForDiffScroller(): Promise<HTMLElement> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const scroller = document.body.querySelector<HTMLElement>(
			'[data-diff-scroll-container="true"]',
		);
		if (scroller) return scroller;
		await flushRender();
	}
	throw new Error("GitFileDiff modal never mounted its diff scroller");
}

describe("GitFileDiff incremental rows", () => {
	beforeEach(async () => {
		installDom();
		if (!i18n.isInitialized) {
			await i18n.use(initReactI18next).init({
				lng: "en",
				fallbackLng: "en",
				defaultNS: "git",
				ns: ["git"],
				resources: { en: { git: gitLocale } },
				interpolation: { escapeValue: false },
				react: { useSuspense: false },
			});
		}
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		root.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider>
					<GitFileDiff chapterId="chapter" file="large.txt" onClose={() => {}} />
				</MantineProvider>
			</I18nextProvider>,
		);
		await flushRender();
		await flushRender();
	});

	afterEach(() => {
		root?.unmount();
		container?.remove();
		root = undefined;
		container = undefined;
	});

	afterAll(() => {
		mock.module("../../hooks/useGit", () => realUseGit);
		mock.restore();
	});

	test("starts at 500 rows and appends 500 per deliberate bottom reach", async () => {
		const scroller = await waitForDiffScroller();
		const bodyText = () => document.body.textContent ?? "";
		expect(bodyText()).toContain("ROW_000499");
		expect(bodyText()).not.toContain("ROW_000500");
		expect(bodyText()).toContain("Showing 500 of 1250 lines");
		Object.defineProperties(scroller, {
			clientHeight: { configurable: true, value: 500 },
			scrollHeight: { configurable: true, value: 2_000 },
			scrollTop: { configurable: true, value: 1_390, writable: true },
		});

		scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
		await flushRender();
		expect(bodyText()).toContain("ROW_000999");
		expect(bodyText()).not.toContain("ROW_001000");
		expect(bodyText()).toContain("Showing 1000 of 1250 lines");

		// Reset DiffView's near-bottom latch, then enter the zone again.
		scroller.scrollTop = 1_000;
		scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
		scroller.scrollTop = 1_400;
		scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
		await flushRender();
		expect(bodyText()).toContain("ROW_001249");
		expect(bodyText()).not.toContain("Showing 1250 of 1250 lines");
	});
});
