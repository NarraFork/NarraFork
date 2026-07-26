import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { ReactFlowProvider } from "@xyflow/react";
import i18n from "i18next";
import { parseHTML } from "linkedom";
import type { ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initReactI18next } from "react-i18next";
import chaptersLocale from "../../locales/en/chapters.json";
import commonLocale from "../../locales/en/common.json";

const mockedI18n = {
	language: "en",
	resolvedLanguage: "en",
	t: (key: string) => key,
	changeLanguage: async () => mockedI18n,
};
const i18nModule = () => ({
	supportedLanguages: ["en", "zh-CN"],
	namespaces: ["common", "narrator"],
	normalizeLanguage: (language: string | null | undefined) => language ?? "en",
	getNamespacesForPath: () => ["common"],
	getInitialNamespaces: () => ["common"],
	ensureI18nNamespaces: async () => {},
	changeAppLanguage: async () => mockedI18n,
	initI18n: async () => mockedI18n,
	default: mockedI18n,
});

// NarratorPanel's dependency tree includes Vite-only modules (i18n's
// import.meta.glob), so provide the same test adapters used by its lightweight
// export test while loading the real namespace. Bun's module mocks are
// process-wide and mock.restore() does not undo them, so keep the namespace for
// explicit cleanup below.
mock.module("../../lib/i18n", i18nModule);
mock.module("@frontend/lib/i18n", i18nModule);
const realNarratorPanelModule = {
	...(await import("../narrator/NarratorPanel" + "?real")),
};

mock.module("../narrator/NarratorPanel", () => ({
	...realNarratorPanelModule,
	NarratorPanel: ({ narratorId }: { narratorId: string }) => (
		<div data-testid="mock-review-narrator-panel">review narrator {narratorId}</div>
	),
}));

const { ReviewNode } = await import("./ReviewNode");

afterAll(() => {
	mock.module("../narrator/NarratorPanel", () => realNarratorPanelModule);
	mock.restore();
});

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

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
		matchMedia,
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
		matchMedia,
		requestAnimationFrame: window.requestAnimationFrame,
		cancelAnimationFrame: window.cancelAnimationFrame,
		getComputedStyle:
			window.getComputedStyle?.bind(window) ??
			(() => ({
				getPropertyValue: () => "",
			})),
		IS_REACT_ACT_ENVIRONMENT: false,
	});
}

async function initTestI18n() {
	if (!i18n.isInitialized) {
		await i18n.use(initReactI18next).init({
			lng: "en",
			fallbackLng: "en",
			defaultNS: "chapters",
			ns: ["chapters", "common"],
			resources: {
				en: {
					chapters: chaptersLocale,
					common: commonLocale,
				},
			},
			interpolation: { escapeValue: false },
			react: { useSuspense: false },
		});
		return;
	}

	i18n.addResourceBundle("en", "chapters", chaptersLocale, true, true);
	i18n.addResourceBundle("en", "common", commonLocale, true, true);
	await i18n.changeLanguage("en");
}

async function tick() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function renderReviewNode(data: Record<string, unknown>) {
	if (!container || !root) throw new Error("test root not initialized");
	const nodeProps = {
		id: "review-1",
		type: "review",
		data,
		selected: false,
		dragging: false,
		zIndex: 1,
		isConnectable: true,
		positionAbsoluteX: 0,
		positionAbsoluteY: 0,
	} as ComponentProps<typeof ReviewNode>;
	root.render(
		<MantineProvider>
			<ReactFlowProvider>
				<ReviewNode {...nodeProps} />
			</ReactFlowProvider>
		</MantineProvider>,
	);
}

describe("ReviewNode", () => {
	beforeEach(async () => {
		installDom();
		await initTestI18n();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		root?.unmount();
		container?.remove();
		root = undefined;
		container = undefined;
	});

	test("renders concluded review graph node without optional narrator fields", async () => {
		renderReviewNode({
			title: "Review: focused parity",
			status: "active",
			branch: "review/focused-parity",
			narratorCount: 0,
			reviewStatus: "concluded",
		});
		await tick();

		expect(container?.textContent).toContain("Review: focused parity");
		expect(container?.textContent).toContain("Concluded");
	});

	test("renders expanded review node panel without crashing", async () => {
		renderReviewNode({
			title: "Review: panel smoke",
			status: "active",
			branch: "review/panel-smoke",
			narratorCount: 1,
			narratorId: "nar-review-1",
			narratorStatus: "working",
			narratorSubstatus: ["calling_model"],
			reviewSourceChapterId: "source-1",
			reviewStatus: "reviewing",
			expanded: true,
		});
		await tick();

		expect(container?.textContent).toContain("Review: panel smoke");
		expect(container?.textContent).toContain("Reviewing");
		expect(container?.textContent).toContain("review narrator nar-review-1");
	});
});
