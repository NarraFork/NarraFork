import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import graphLocale from "../../locales/en/graph.json";

// Isolated i18next instance + <I18nextProvider> so shared-singleton mutations
// from other frontend suites can't leave this suite rendering raw i18n keys.
const i18n = i18next.createInstance();

const rulerData = {
	commits: [
		{
			sha: "commit-one",
			shortSha: "commit-o",
			message: "Initial commit",
			author: "Alice",
			date: "2026-01-01T00:00:00.000Z",
		},
		{
			sha: "commit-two",
			shortSha: "commit-t",
			message: "Feature commit",
			author: "Bob",
			date: "2026-01-02T00:00:00.000Z",
		},
	],
	segments: [
		{
			fromSha: "commit-one",
			toSha: "commit-two",
			fromIndex: 0,
			toIndex: 1,
			activeChapterCount: 1,
			totalChapterCount: 1,
			activeChapterIds: ["chapter-one"],
			isExpandable: true,
		},
	],
	activeChapters: [
		{
			id: "chapter-one",
			title: "Chapter One",
			branch: "chapter/one",
			role: "branch",
			parentChapterId: null,
			startCommitSha: "commit-one",
			mergeCommitSha: null,
			narratorId: "narrator-one",
			narratorStatus: "idle",
			axisOffset: 0,
			crossOffset: 0,
		},
	],
	mergedChapters: [],
	capabilities: {
		mutations: {
			fork: { supported: true },
			merge: { supported: true },
			rebase: { supported: false, fallback: true, code: "FEATURE_DISABLED" },
		},
	},
};

// Snapshot the shared api barrel before mocking so afterAll can re-point it back
// to the real implementation. Bun's mock.module is process-wide and mock.restore()
// does NOT undo it, so without this the partial `api` stub below leaks into every
// later-loaded frontend suite (lib/api/*.test, GitPanel, ChapterBatchMergeModal),
// where methods like api.search / api.createProjectStream go missing.
//
// Only the api barrel is re-pointed: the hook / heavy-component mocks
// (NarratorPanel, pixi, SegmentCanvas) are RulerFlow-local and importing the REAL
// versions here would eagerly evaluate `import.meta.glob`-based modules that Bun
// cannot load in this test context. Those niche mocks don't break other suites.
const realApiModule = { ...(await import("../../lib/api")) };
const realRulerFlowModules: Record<string, () => unknown> = {
	"../../lib/api": () => realApiModule,
};

mock.module("../../hooks/useRuler", () => ({
	useRulerData: () => ({ data: rulerData, isLoading: false, error: null }),
}));

mock.module("../../hooks/useRulerChapterActivity", () => ({
	useRulerChapterActivity: () => new Map(),
}));

mock.module("../../hooks/useUserPreferences", () => ({
	useUserPreferences: () => ({ data: { graphViewports: {} } }),
}));

mock.module("../../hooks/usePlatform", () => ({
	useChapterBatchMergeCapability: () => ({
		supported: true,
		mode: "async-merge-session",
		frontendCompletionMode: "progress-event-or-session-poll",
		routes: { start: true, session: true },
	}),
	useNarratorReviewToolsCapability: () => ({
		supported: true,
		convertToSubagent: true,
		promote: true,
		dismiss: true,
	}),
}));

mock.module("../../hooks/useRecentTabs", () => ({
	addRecentTab: () => {},
}));

class TestApiError extends Error {
	data?: Record<string, unknown>;
}

mock.module("../../lib/api", () => ({
	ApiError: TestApiError,
	api: {
		saveGraphViewport: () => Promise.resolve(),
		getRulerSegment: () => Promise.resolve({ chapters: [] }),
		rulerFork: () => Promise.resolve({}),
		forkChapter: () => Promise.resolve({ id: "forked", title: "Forked" }),
		listNarrators: () => Promise.resolve([]),
		rulerMerge: () => Promise.resolve({}),
		rulerRebase: () => Promise.resolve({}),
		createReview: () => Promise.resolve({}),
		rulerAbandon: () => Promise.resolve({}),
		convertReviewToSubagent: () => Promise.resolve({}),
		promoteReview: () => Promise.resolve({}),
		dismissReview: () => Promise.resolve({}),
		updateRulerPositions: () => Promise.resolve({}),
	},
}));

mock.module("../narrator/NarratorPanel", () => ({
	NarratorPanel: ({ narratorId }: { narratorId: string }) => (
		<div data-testid="mock-narrator-panel">{narratorId}</div>
	),
}));

mock.module("./pixi/RulerPixiLayer", () => ({
	RulerPixiLayer: ({ pixiRef }: { pixiRef: { current: unknown } }) => {
		pixiRef.current = {
			getCardHitRects: () => [],
			updateCamera: () => {},
			updateChapters: () => {},
			render: () => {},
		};
		return <div data-testid="mock-ruler-pixi-layer" />;
	},
}));

mock.module("./SegmentCanvas", () => ({
	SegmentCanvas: ({
		fromSha,
		onChaptersLoaded,
	}: {
		fromSha: string;
		onChaptersLoaded: (
			fromSha: string,
			chapters: Array<{
				id: string;
				status: string;
				title: string;
				branch: string;
				role: string;
				parentChapterId?: string | null;
				narratorId: string | null;
				narratorStatus: string | null;
				startCommitSha: string | null;
				mergeCommitSha?: string | null;
				layoutX: number;
				layoutY: number;
			}>,
		) => void;
	}) => {
		useEffect(() => {
			onChaptersLoaded(fromSha, [
				{
					id: "chapter-one",
					status: "active",
					title: "Chapter One",
					branch: "chapter/one",
					role: "branch",
					parentChapterId: null,
					narratorId: "narrator-one",
					narratorStatus: "idle",
					startCommitSha: "commit-one",
					mergeCommitSha: null,
					layoutX: 0,
					layoutY: 0,
				},
			]);
		}, [fromSha, onChaptersLoaded]);
		return <div data-testid="mock-segment-canvas" />;
	},
}));

const { RulerFlow } = await import("./RulerFlow");

// Re-point all mocked modules back to real once the file finishes, so the api
// barrel + hook stubs don't leak into later-loaded frontend suites.
afterAll(() => {
	for (const [specifier, factory] of Object.entries(realRulerFlowModules)) {
		mock.module(specifier, factory);
	}
	mock.restore();
});

class TestResizeObserver {
	private callback: ResizeObserverCallback;

	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
	}

	observe(target: Element) {
		this.callback(
			[{ target, contentRect: { width: 1200, height: 800 } } as ResizeObserverEntry],
			this,
		);
	}

	unobserve() {}
	disconnect() {}
}

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const localStorage = new Map<string, string>();
	const matchMedia = (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false,
	});

	Object.assign(window, {
		ResizeObserver: TestResizeObserver,
		matchMedia,
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		localStorage: {
			getItem: (key: string) => localStorage.get(key) ?? null,
			setItem: (key: string, value: string) => localStorage.set(key, value),
			removeItem: (key: string) => localStorage.delete(key),
		},
		navigator: { vibrate: () => false },
	});

	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		ResizeObserver: TestResizeObserver,
		matchMedia,
		requestAnimationFrame: window.requestAnimationFrame,
		cancelAnimationFrame: window.cancelAnimationFrame,
		localStorage: window.localStorage,
	});
}

async function initI18n() {
	// Isolated instance: safe to init once and own entirely.
	if (!i18n.isInitialized) {
		await i18n.use(initReactI18next).init({
			lng: "en",
			fallbackLng: "en",
			resources: { en: { graph: graphLocale } },
			interpolation: { escapeValue: false },
		});
	}
}

async function flushRender() {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("RulerFlow", () => {
	let container: HTMLDivElement;
	let root: Root;
	let queryClient: QueryClient;

	beforeEach(async () => {
		installDom();
		await initI18n();
		queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
		});
		container = document.createElement("div");
		Object.defineProperties(container, {
			clientWidth: { value: 1200, configurable: true },
			clientHeight: { value: 800, configurable: true },
		});
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		root.unmount();
		queryClient.clear();
		container.remove();
	});

	test("renders the Go ruler lifecycle surface without crashing", async () => {
		root.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider env="test">
					<QueryClientProvider client={queryClient}>
						<RulerFlow projectId="project-one" />
					</QueryClientProvider>
				</MantineProvider>
			</I18nextProvider>,
		);

		await flushRender();

		expect(document.body.textContent).toContain("2 commits");
		expect(document.querySelector('[data-testid="mock-ruler-pixi-layer"]')).not.toBeNull();
		expect(document.querySelector('[data-testid="mock-segment-canvas"]')).not.toBeNull();
	});
});
