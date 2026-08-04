import { afterAll, afterEach, beforeEach, mock as bunMock, describe, expect, test } from "bun:test";
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

class TestApiError extends Error {
	data?: Record<string, unknown>;
}

/**
 * Real namespaces of every module this file replaces, snapshotted BEFORE any mock is
 * installed so `afterAll` can re-point each specifier back at the genuine module.
 *
 * Bun's `mock.module` is process-wide and `mock.restore()` does NOT undo it, so a stub
 * left standing here bleeds into every frontend suite loaded later in the same
 * `bun test` process. A stub that merely behaves differently is survivable; a stub
 * that omits an export is not — the victim file dies during module evaluation with
 * `SyntaxError: Export named 'x' not found in module ...`, which reads as a bug in the
 * innocent file. That is how the two-export `usePlatform` stub killed every suite that
 * reached `useUploadCapability` (via vlist-image), and how the partial `api` barrel
 * took out lib/api/*.test, GitPanel and ChapterBatchMergeModal before it.
 *
 * Restoring ALL of them, rather than only the ones provably missing exports, is
 * deliberate: "is this factory export-complete, and does anything downstream need the
 * real behaviour?" is a judgement call that must be re-made on every edit and fails
 * silently when wrong. Blanket restoration deletes the judgement call.
 *
 * These keys are the single source of truth for what this file is allowed to mock.
 */
const realRulerFlowModules = {
	"../../hooks/useRuler": { ...(await import("../../hooks/useRuler")) },
	"../../hooks/useRulerChapterActivity": {
		...(await import("../../hooks/useRulerChapterActivity")),
	},
	"../../hooks/useUserPreferences": { ...(await import("../../hooks/useUserPreferences")) },
	"../../hooks/usePlatform": { ...(await import("../../hooks/usePlatform")) },
	"../../hooks/useRecentTabs": { ...(await import("../../hooks/useRecentTabs")) },
	"../../lib/api": { ...(await import("../../lib/api")) },
	"../narrator/NarratorPanel": { ...(await import("../narrator/NarratorPanel")) },
	"./pixi/RulerPixiLayer": { ...(await import("./pixi/RulerPixiLayer")) },
	"./SegmentCanvas": { ...(await import("./SegmentCanvas")) },
};

type MockedSpecifier = keyof typeof realRulerFlowModules;

const mockedSpecifiers = Object.keys(realRulerFlowModules) as MockedSpecifier[];

/**
 * `bun:test`'s `mock`, shadowed so its `module()` only accepts specifiers that
 * `realRulerFlowModules` has a real namespace for.
 *
 * This is the anti-regression device, and shadowing the familiar name is the point:
 * the natural way to add a mock is to write `mock.module("../../hooks/useFoo", …)`
 * copied from any other suite, and in this file that resolves to the narrowed
 * signature and fails to compile (TS2345) until the specifier is snapshotted above.
 * A separate opt-in helper would have been trivial to walk around by importing `mock`
 * the usual way; there is no ergonomic path around this one.
 */
const mock = {
	module: (specifier: MockedSpecifier, factory: () => unknown) =>
		bunMock.module(specifier, factory),
	restore: () => bunMock.restore(),
};

/**
 * Registered before the stubs and before `import("./RulerFlow")` on purpose.
 *
 * If a stub omits an export RulerFlow actually imports, that dynamic import throws
 * while this module is still evaluating, and no `afterAll` registered after it ever
 * runs — so every mock stays installed for the rest of the process. The import-time
 * crash and the cross-file contamination were one and the same bug; hoisting the
 * restore hook makes the leak survivable even when this file fails to load.
 */
afterAll(() => {
	for (const specifier of mockedSpecifiers) {
		const namespace = realRulerFlowModules[specifier];
		mock.module(specifier, () => namespace);
	}
	// Clears spies/implementations set by `mock()`; it does NOT undo `mock.module`,
	// which is why the loop above has to exist at all.
	mock.restore();
});

/**
 * The stub factories, keyed by the same specifiers as the snapshot table.
 *
 * `satisfies Record<MockedSpecifier, () => unknown>` locks the two tables together in
 * both directions: a stub for a module absent from `realRulerFlowModules` is an
 * excess-property error (TS2353), and snapshotting a module without stubbing it is a
 * missing-property error (TS2739). Combined with the narrowed `mock` above, there is
 * no way to install a stub that the `afterAll` restore loop will not undo.
 */
const rulerFlowModuleMocks = {
	"../../hooks/useRuler": () => ({
		useRulerData: () => ({ data: rulerData, isLoading: false, error: null }),
	}),
	"../../hooks/useRulerChapterActivity": () => ({
		useRulerChapterActivity: () => new Map(),
	}),
	"../../hooks/useUserPreferences": () => ({
		useUserPreferences: () => ({ data: { graphViewports: {} } }),
	}),
	"../../hooks/usePlatform": () => ({
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
	}),
	"../../hooks/useRecentTabs": () => ({
		addRecentTab: () => {},
	}),
	"../../lib/api": () => ({
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
	}),
	"../narrator/NarratorPanel": () => ({
		NarratorPanel: ({ narratorId }: { narratorId: string }) => (
			<div data-testid="mock-narrator-panel">{narratorId}</div>
		),
	}),
	"./pixi/RulerPixiLayer": () => ({
		RulerPixiLayer: ({ pixiRef }: { pixiRef: { current: unknown } }) => {
			pixiRef.current = {
				getCardHitRects: () => [],
				updateCamera: () => {},
				updateChapters: () => {},
				render: () => {},
			};
			return <div data-testid="mock-ruler-pixi-layer" />;
		},
		// RulerFlow imports the real card geometry from this module to build its
		// world-space card registry, so the stub has to carry it too: a factory that
		// omits a used export makes the whole file fail at import time (before any
		// test body runs), which is the failure mode the hoisted afterAll guards.
		RULER_CARD_GEOMETRY: { nodeWidth: 220, nodeHeight: 72, cardTopOffset: 2 },
	}),
	"./SegmentCanvas": () => ({
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
	}),
} satisfies Record<MockedSpecifier, () => unknown>;

// Driven by the snapshot table's keys, not the stub table's: iterating the mocks with
// `Object.entries` would widen the specifier back to `string` and silently re-open the
// hole this narrowing exists to close.
for (const specifier of mockedSpecifiers) {
	mock.module(specifier, rulerFlowModuleMocks[specifier]);
}

const { RulerFlow } = await import("./RulerFlow");

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

	test("renders the ruler lifecycle surface without crashing", async () => {
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

/**
 * Runtime backstop for the one thing the type system cannot express: that the restore
 * table is complete relative to what actually got mocked. The types guarantee the two
 * tables share a key set, this guarantees neither is empty and both still line up at
 * execution time — cheap insurance against a future refactor that keeps them
 * compiling while decoupling them (e.g. widening a type to `Record<string, …>`).
 */
describe("RulerFlow mock hygiene", () => {
	test("every mocked module has a real namespace queued for restore", () => {
		expect(mockedSpecifiers.length).toBeGreaterThan(0);
		expect(Object.keys(rulerFlowModuleMocks).sort()).toEqual([...mockedSpecifiers].sort());

		// A snapshot captured after its own mock was installed would "restore" the stub
		// and defeat the whole mechanism, so verify each namespace looks real.
		for (const specifier of mockedSpecifiers) {
			expect(Object.keys(realRulerFlowModules[specifier]).length).toBeGreaterThan(0);
		}
	});
});
