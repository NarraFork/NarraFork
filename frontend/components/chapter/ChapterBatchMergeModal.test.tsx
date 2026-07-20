import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import chaptersLocale from "../../locales/en/chapters.json";
import commonLocale from "../../locales/en/common.json";

// Isolated i18next instance + <I18nextProvider> so shared-singleton mutations
// from other frontend suites can't leave this suite rendering raw i18n keys.
const i18n = i18next.createInstance();

let batchMergeCapability = {
	supported: true,
	startRouteSupported: true,
	sessionRouteSupported: true,
	mergeSessionIdResponse: true,
	targetChapterIdResponse: true,
	createdTargetResponse: true,
	statusResponse: true,
	decisionWs: true,
	staleSessionCleanup: true,
	createdTargetRollback: true,
	frontendCompletionMode: "progress-event-or-session-poll",
	events: ["merge:started", "merge:conflict", "merge:completed"],
	reason: undefined as string | undefined,
};

mock.module("../../hooks/usePlatform", () => ({
	useChapterBatchMergeCapability: () => batchMergeCapability,
	useNarratorReviewToolsCapability: () => ({
		supported: true,
		convertToSubagent: true,
		promote: true,
		dismiss: true,
	}),
}));

const { ChapterBatchMergeModal } = await import("./ChapterBatchMergeModal");

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
		Document: window.Document,
		ShadowRoot: window.ShadowRoot,
		HTMLElement: window.HTMLElement,
		HTMLButtonElement: window.HTMLButtonElement,
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
	// Isolated instance: safe to init once and own entirely.
	if (!i18n.isInitialized) {
		await i18n.use(initReactI18next).init({
			lng: "en",
			fallbackLng: "en",
			defaultNS: "chapters",
			ns: ["chapters", "common"],
			resources: { en: { chapters: chaptersLocale, common: commonLocale } },
			interpolation: { escapeValue: false },
			react: { useSuspense: false },
		});
	}
}

function tick() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function renderModal() {
	if (!container || !root) throw new Error("test root not initialized");
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY, refetchOnMount: false },
			mutations: { retry: false },
		},
	});
	root.render(
		<I18nextProvider i18n={i18n}>
			<MantineProvider env="test">
				<QueryClientProvider client={queryClient}>
					<ChapterBatchMergeModal
						opened
						onClose={() => {}}
						chapters={[
							{ id: "target", title: "Main target", status: "active" },
							{ id: "source", title: "Feature source", status: "active" },
							{ id: "dormant", title: "Dormant branch", status: "dormant" },
						]}
					/>
				</QueryClientProvider>
			</MantineProvider>
		</I18nextProvider>,
	);
	return queryClient;
}

function mergeButton(): HTMLButtonElement {
	const button = Array.from(document.body.querySelectorAll("button")).find((candidate) =>
		candidate.textContent?.includes("Merge 0 chapter(s)"),
	);
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error("merge button not found");
	}
	return button;
}

describe("ChapterBatchMergeModal", () => {
	beforeEach(async () => {
		batchMergeCapability = {
			supported: true,
			startRouteSupported: true,
			sessionRouteSupported: true,
			mergeSessionIdResponse: true,
			targetChapterIdResponse: true,
			createdTargetResponse: true,
			statusResponse: true,
			decisionWs: true,
			staleSessionCleanup: true,
			createdTargetRollback: true,
			frontendCompletionMode: "progress-event-or-session-poll",
			events: ["merge:started", "merge:conflict", "merge:completed"],
			reason: undefined,
		};
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

	test("renders async batch-merge modal without crashing", async () => {
		const queryClient = renderModal();
		await tick();

		expect(document.body.textContent).toContain("Batch Merge");
		expect(document.body.textContent).toContain("Start an async merge session");
		expect(document.body.textContent).toContain("Main target");
		expect(document.body.textContent).toContain("Feature source");
		expect(document.body.textContent).not.toContain("Dormant branch");
		expect(mergeButton().disabled).toBe(true);

		queryClient.clear();
	});

	test("renders unsupported batch-merge capability without crashing", async () => {
		batchMergeCapability = {
			...batchMergeCapability,
			supported: false,
			startRouteSupported: false,
			reason: "batch merge unavailable",
		};
		const queryClient = renderModal();
		await tick();

		const button = mergeButton();
		expect(document.body.textContent).toContain("Batch Merge");
		expect(button.disabled).toBe(true);
		expect(button.getAttribute("title")).toBe("batch merge unavailable");

		queryClient.clear();
	});
});
