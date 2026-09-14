/**
 * Layout contract for the compact-summary dialog.
 *
 * A compacted summary is arbitrarily long markdown. When the whole modal body
 * scrolled, the action bar (revoke compaction / edit / retry) was pushed below
 * the fold and the user had to scroll a very long summary to reach it. The
 * dialog now keeps three fixed regions:
 *
 *   header (Mantine, sticky) | scroll column (only this scrolls) | action bar
 *
 * These tests assert the structural invariants that keep the action bar docked:
 * the actions must be a SIBLING of the scroll column (never inside it), the
 * scroll column must own the vertical overflow, and the body must be a
 * non-scrolling flex column so nothing else can steal the scroll.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { CompactMessageDetail } from "@shared/compact-message";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { api } from "../../../lib/api";
import narratorLocale from "../../../locales/en/narrator.json";

const testI18n = i18next.createInstance();
await testI18n.use(initReactI18next).init({
	lng: "en",
	fallbackLng: "en",
	defaultNS: "narrator",
	ns: ["narrator"],
	resources: { en: { narrator: narratorLocale } },
	interpolation: { escapeValue: false },
	react: { useSuspense: false },
});
const i18nModule = () => ({
	supportedLanguages: ["en", "zh-CN"],
	namespaces: ["narrator"],
	normalizeLanguage: (language: string | null | undefined) => language ?? "en",
	getNamespacesForPath: () => ["narrator"],
	getInitialNamespaces: () => ["narrator"],
	ensureI18nNamespaces: async () => {},
	changeAppLanguage: async () => testI18n,
	initI18n: async () => testI18n,
	default: testI18n,
});
mock.module("../../../lib/i18n", i18nModule);
mock.module("@frontend/lib/i18n", i18nModule);

const realUseModels = { ...(await import("../../../hooks/useModels")) };
mock.module("../../../hooks/useModels", () => ({
	...realUseModels,
	useAllModels: () => ({
		visibleModels: [{ value: "provider:model", label: "Model", provider: "provider" }],
		summaryModelValue: "provider:model",
	}),
}));

const { CompactSummaryModal, compactSummaryQueryKey } = await import("../compact/compact-summary-modal");

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let queryClient: QueryClient | undefined;

const originalApi = { getCompactSummary: api.getCompactSummary };

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const localStorage = new Map<string, string>();
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
		innerWidth: 1280,
		innerHeight: 720,
		matchMedia,
		getSelection: () => ({ rangeCount: 0, isCollapsed: true, removeAllRanges() {} }),
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		localStorage: {
			getItem: (key: string) => localStorage.get(key) ?? null,
			setItem: (key: string, value: string) => localStorage.set(key, value),
			removeItem: (key: string) => localStorage.delete(key),
			clear: () => localStorage.clear(),
		},
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
		HTMLInputElement: window.HTMLInputElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		ResizeObserver: TestResizeObserver,
		matchMedia,
		requestAnimationFrame: window.requestAnimationFrame,
		cancelAnimationFrame: window.cancelAnimationFrame,
		getComputedStyle:
			window.getComputedStyle?.bind(window) ?? (() => ({ getPropertyValue: () => "" })),
		IS_REACT_ACT_ENVIRONMENT: true,
	});
}

async function settle() {
	for (let turn = 0; turn < 4; turn++) {
		await act(async () => {
			for (let microtask = 0; microtask < 4; microtask++) await Promise.resolve();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
}

function completedDetail(summary: string): CompactMessageDetail {
	return { status: "compacted", summary, attempts: [], canRetry: false };
}

function failedDetail(): CompactMessageDetail {
	return {
		status: "failed",
		summary: "",
		error: "compact failed",
		attempts: [
			{
				attempt: 1,
				model: "provider:model",
				status: "failed",
				startedAt: "2026-07-18T00:00:00.000Z",
				finishedAt: "2026-07-18T00:00:01.000Z",
				error: "compact failed",
			},
		],
		canRetry: true,
	};
}

async function renderModal(detail: CompactMessageDetail) {
	if (!root || !queryClient) throw new Error("test harness is not initialized");
	const currentRoot = root;
	const currentQueryClient = queryClient;
	currentQueryClient.setQueryData(compactSummaryQueryKey("narrator-1", "compact-1"), detail);
	api.getCompactSummary = async () => detail;
	await act(async () => {
		currentRoot.render(
			<I18nextProvider i18n={testI18n}>
				<MantineProvider env="test">
					<QueryClientProvider client={currentQueryClient}>
						<CompactSummaryModal
							target={{ kind: "context", narratorId: "narrator-1", messageId: "compact-1" }}
							onClose={() => {}}
						/>
					</QueryClientProvider>
				</MantineProvider>
			</I18nextProvider>,
		);
	});
	await settle();
}

function scrollColumn(): HTMLElement {
	const node = document.body.querySelector("[data-compact-summary-scroll]");
	if (!(node instanceof HTMLElement)) throw new Error("scroll column not found");
	return node;
}

function actionBar(): HTMLElement {
	const node = document.body.querySelector("[data-compact-summary-actions]");
	if (!(node instanceof HTMLElement)) throw new Error("action bar not found");
	return node;
}

beforeEach(() => {
	installDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY, refetchOnMount: false },
			mutations: { retry: false },
		},
	});
});

afterEach(async () => {
	Object.assign(api, originalApi);
	await act(async () => root?.unmount());
	queryClient?.clear();
	container?.remove();
	root = undefined;
	queryClient = undefined;
	container = undefined;
});

afterAll(() => {
	mock.module("../../../lib/i18n", i18nModule);
	mock.module("@frontend/lib/i18n", i18nModule);
	mock.module("../../../hooks/useModels", () => realUseModels);
	mock.restore();
});

describe("CompactSummaryModal docked action bar", () => {
	test("keeps the action bar outside the scrolling column", async () => {
		// A summary long enough that body-level scrolling used to bury the buttons.
		await renderModal(completedDetail(`${"long summary paragraph. ".repeat(400)}`));

		const scroll = scrollColumn();
		const actions = actionBar();
		// The regression was the actions living inside the scrolled subtree.
		expect(scroll.contains(actions)).toBe(false);
		expect(actions.parentElement).toBe(scroll.parentElement);
		// Actions render after the scroll column so they sit at the bottom edge.
		expect(
			Array.from(scroll.parentElement?.children ?? []).indexOf(scroll) <
				Array.from(actions.parentElement?.children ?? []).indexOf(actions),
		).toBe(true);
	});

	test("gives the scroll column the vertical overflow and a shrinkable flex box", async () => {
		await renderModal(completedDetail("short summary"));

		const scroll = scrollColumn();
		expect(scroll.style.overflowY).toBe("auto");
		// Without `min-height: 0` a flex child refuses to shrink below its content,
		// which would push the footer out of the modal again. (linkedom keeps the
		// authored value verbatim, browsers normalise it to `0px`.)
		expect(["0", "0px"]).toContain(scroll.style.minHeight);
		expect(scroll.style.flex.startsWith("1")).toBe(true);
	});

	test("makes the modal body a non-scrolling flex column", async () => {
		await renderModal(completedDetail("short summary"));

		const body = scrollColumn().parentElement;
		if (!body) throw new Error("modal body not found");
		expect(body.style.display).toBe("flex");
		expect(body.style.flexDirection).toBe("column");
		// Any scroll here would move the footer along with the content.
		expect(body.style.overflow).toBe("hidden");
	});

	test("docks the action bar for a failed compact too", async () => {
		await renderModal(failedDetail());

		const scroll = scrollColumn();
		const actions = actionBar();
		expect(scroll.contains(actions)).toBe(false);
		// Retry lives in the docked bar, the failure detail + attempt log scroll.
		expect(actions.textContent).toContain("Retry compaction");
		expect(scroll.textContent).toContain("compact failed");
	});
});
