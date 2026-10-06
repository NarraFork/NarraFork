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
const { installCanvasStub } = await import("../narrator/vlist/measure/test-canvas-stub");
const disposeCanvas = installCanvasStub();
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
let restoreGeometry: () => void;

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const proto = window.HTMLElement.prototype;
	const saved = new Map(
		[
			"clientHeight",
			"clientWidth",
			"clientTop",
			"scrollTop",
			"scrollHeight",
			"getBoundingClientRect",
		].map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)]),
	);
	const positions = new WeakMap<object, number>();
	Object.defineProperties(proto, {
		clientHeight: { configurable: true, get: () => 500 },
		clientWidth: { configurable: true, get: () => 700 },
		clientTop: { configurable: true, get: () => 0 },
		scrollHeight: {
			configurable: true,
			get() {
				const canvas = (this as HTMLElement).querySelector<HTMLElement>("[data-diff-content]");
				return canvas
					? Array.from(canvas.children).reduce(
							(sum, child) => sum + (Number.parseFloat((child as HTMLElement).style.height) || 0),
							0,
						)
					: 0;
			},
		},
		scrollTop: {
			configurable: true,
			get() {
				return positions.get(this) ?? 0;
			},
			set(value: number) {
				positions.set(this, Math.max(0, Math.min(value, (this as HTMLElement).scrollHeight - 500)));
			},
		},
		getBoundingClientRect: {
			configurable: true,
			value() {
				const top = (this as HTMLElement).hasAttribute("data-diff-content")
					? -(
							(this as HTMLElement).closest<HTMLElement>("[data-content-scrollport]")?.scrollTop ??
							0
						)
					: 0;
				return {
					top,
					bottom: top + 500,
					left: 0,
					right: 700,
					width: 700,
					height: 500,
					x: 0,
					y: top,
					toJSON() {},
				};
			},
		},
	});
	restoreGeometry = () => {
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(proto, key, descriptor);
			else Reflect.deleteProperty(proto, key);
		}
	};
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
		restoreGeometry();
		root = undefined;
		container = undefined;
	});

	afterAll(() => {
		mock.module("../../hooks/useGit", () => realUseGit);
		mock.restore();
		disposeCanvas();
	});

	test("loads 500-row source segments while painting only the viewport window", async () => {
		const scroller = await waitForDiffScroller();
		const bodyText = () => document.body.textContent ?? "";
		const flush = async () => {
			for (let i = 0; i < 8; i++) await flushRender();
		};
		const move = async (top: number) => {
			const wheel = new Event("wheel", { bubbles: true });
			Object.defineProperty(wheel, "deltaY", { value: top < scroller.scrollTop ? -100 : 100 });
			scroller.dispatchEvent(wheel);
			scroller.scrollTop = top;
			scroller.dispatchEvent(new Event("scroll"));
			await flush();
		};
		await flush();
		expect(bodyText()).toContain("ROW_000000");
		expect(bodyText()).not.toContain("ROW_000499");
		expect(bodyText()).toContain("Showing 500 of 1250 lines");
		expect(scroller.querySelectorAll("[data-diff-row]").length).toBeLessThan(200);

		await move(scroller.scrollHeight - scroller.clientHeight - 40);
		expect(bodyText()).toContain("ROW_000499");
		expect(bodyText()).toContain("Showing 1000 of 1250 lines");
		expect(scroller.querySelectorAll("[data-diff-row]").length).toBeLessThan(200);

		// One fresh deliberate reach, not two scroll events collapsed into one frame.
		await move(1000);
		await move(scroller.scrollHeight - scroller.clientHeight - 40);
		expect(bodyText()).toContain("ROW_000999");
		expect(bodyText()).not.toContain("Showing 1000 of 1250 lines");
		await move(scroller.scrollHeight - scroller.clientHeight);
		expect(bodyText()).toContain("ROW_001249");
		expect(scroller.querySelectorAll("[data-diff-row]").length).toBeLessThan(200);
	});
});
