/**
 * GitCommitGraph — Stage 3 UI harness.
 *
 * Guards the collapsible graph strip under Git changes: default expansion,
 * collapse persistence, and topology degradation when `parents` is missing
 * (old remotes).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { GitStatusSummary } from "../../hooks/useGit";
import {
	__resetGitGraphCollapsedCache,
	GIT_GRAPH_COLLAPSED_KEY,
} from "../../hooks/useGitGraphCollapsed";
import {
	__resetGitGraphHeightCache,
	GIT_GRAPH_HEIGHT_DEFAULT,
	GIT_GRAPH_HEIGHT_KEY,
	GIT_GRAPH_HEIGHT_MAX,
	GIT_GRAPH_HEIGHT_MIN,
} from "../../hooks/useGitGraphHeight";
import { api } from "../../lib/api";
import type { GitLogEntry, GitTarget } from "../../lib/api/git";
import commonLocale from "../../locales/en/common.json";
import gitLocale from "../../locales/en/git.json";
import { GRAPH_PAGE_SIZE } from "./git-graph-layout";

const i18n = i18next.createInstance();
mock.module("../../lib/i18n", () => ({
	supportedLanguages: ["en", "zh-CN"],
	namespaces: ["common", "git"],
	normalizeLanguage: (language: string | null | undefined) => language ?? "en",
	getNamespacesForPath: () => ["common"],
	getInitialNamespaces: () => ["common"],
	ensureI18nNamespaces: async () => {},
	changeAppLanguage: async () => i18n,
	initI18n: async () => i18n,
	default: i18n,
}));
// The graph suite verifies entry wiring; the real preview has its own integration suite.
mock.module("./GitCommitDetailModal", () => ({
	GitCommitDetailModal: ({ sha, onClose }: { sha: string | null; onClose: () => void }) =>
		sha ? (
			<button type="button" data-preview-sha={sha} onClick={onClose}>
				Close preview
			</button>
		) : null,
}));
const { GitCommitGraph } = await import("./GitCommitGraph");

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let root: Root | undefined;
let restoreGitApi: (() => void) | undefined;
let localStorageRef: Map<string, string> | undefined;

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const localStorage = new Map<string, string>();
	const sessionStorage = new Map<string, string>();
	localStorageRef = localStorage;
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
		localStorage: {
			getItem: (key: string) => localStorage.get(key) ?? null,
			setItem: (key: string, value: string) => localStorage.set(key, value),
			removeItem: (key: string) => localStorage.delete(key),
			clear: () => localStorage.clear(),
		},
		sessionStorage: {
			getItem: (key: string) => sessionStorage.get(key) ?? null,
			setItem: (key: string, value: string) => sessionStorage.set(key, value),
			removeItem: (key: string) => sessionStorage.delete(key),
			clear: () => sessionStorage.clear(),
		},
	});

	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
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
	if (!i18n.isInitialized) {
		await i18n.use(initReactI18next).init({
			lng: "en",
			fallbackLng: "en",
			defaultNS: "common",
			ns: ["common", "git"],
			resources: { en: { common: commonLocale, git: gitLocale } },
			interpolation: { escapeValue: false },
			react: { useSuspense: false },
		});
	}
}

const HEAD_SHA = "1".repeat(40);
const PARENT_SHA = "2".repeat(40);
const ROOT_SHA = "3".repeat(40);

function makeStatus(): GitStatusSummary {
	return {
		hasChanges: false,
		staged: 0,
		unstaged: 0,
		untracked: 0,
		files: [],
		totalFiles: 0,
		headSha: HEAD_SHA,
		branch: "feature/graph",
		linesAdded: 0,
		linesRemoved: 0,
	};
}

function makeCommits(options: { withParents?: boolean } = {}): GitLogEntry[] {
	const withParents = options.withParents !== false;
	const base = [
		{
			sha: HEAD_SHA,
			shortSha: "sha-head",
			message: "feat: stage commit graph",
			author: "alice",
			date: "2026-01-02T00:00:00.000Z",
		},
		{
			sha: PARENT_SHA,
			shortSha: "sha-pare",
			message: "chore: prepare workspace",
			author: "bob",
			date: "2026-01-01T12:00:00.000Z",
		},
		{
			sha: ROOT_SHA,
			shortSha: "sha-root",
			message: "init repository",
			author: "alice",
			date: "2026-01-01T00:00:00.000Z",
		},
	];
	if (!withParents) {
		return base.map((commit) => ({ ...commit }));
	}
	return [
		{ ...base[0], parents: [PARENT_SHA] },
		{ ...base[1], parents: [ROOT_SHA] },
		{ ...base[2], parents: [] },
	];
}

type LogCall = { limit: number; skip: number };

function stubGitApi(options: { commits?: GitLogEntry[]; logCalls?: LogCall[] } = {}) {
	const commits = options.commits ?? makeCommits();
	const logCalls = options.logCalls ?? [];
	const original = {
		getGitStatus: api.getGitStatus,
		getGitLog: api.getGitLog,
	};
	api.getGitStatus = async () => makeStatus();
	api.getGitLog = async (_target, limit = 50, skip = 0) => {
		logCalls.push({ limit, skip });
		return commits.slice(skip, skip + limit);
	};
	restoreGitApi = () => Object.assign(api, original);
	return logCalls;
}

function flushRender() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Effects + async api mocks need more than one macrotask: React commits,
 * the fetch promise resolves, then state updates re-render. Poll rather than
 * stacking fixed timeouts so the suite stays fast when data is already there.
 */
async function waitFor(
	predicate: () => boolean,
	{ timeoutMs = 2000, stepMs = 20 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (predicate()) return;
		if (Date.now() >= deadline) {
			throw new Error(`waitFor timed out after ${timeoutMs}ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
}

function textOf(container: HTMLElement): string {
	return container.textContent ?? "";
}

function renderGraph(target: GitTarget, queryClient?: QueryClient) {
	const qc =
		queryClient ??
		new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
				mutations: { retry: false },
			},
		});
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const rerender = (nextTarget: GitTarget) =>
		root?.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider>
					<QueryClientProvider client={qc}>
						<GitCommitGraph target={nextTarget} />
					</QueryClientProvider>
				</MantineProvider>
			</I18nextProvider>,
		);
	rerender(target);
	return { container, queryClient: qc, rerender };
}

function makeQueryClient(chapterId: string) {
	const qc = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
			mutations: { retry: false },
		},
	});
	qc.setQueryData(["gitStatus", chapterId], makeStatus());
	return qc;
}

/** N synthetic commits, newest first, each pointing at the next as its parent. */
function makeLongHistory(count: number): GitLogEntry[] {
	return Array.from({ length: count }, (_, i) => ({
		sha: (i + 1).toString(16).padStart(40, "0"),
		shortSha: `sha-${i}`,
		message: `commit ${i}`,
		author: "alice",
		date: new Date(Date.UTC(2026, 0, 1, 0, 0, count - i)).toISOString(),
		parents: i + 1 < count ? [(i + 2).toString(16).padStart(40, "0")] : [],
	}));
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
	const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
		candidate.textContent?.includes(text),
	);
	if (!button) throw new Error(`Button not found: ${text}`);
	return button as HTMLButtonElement;
}

function hasButton(container: HTMLElement, text: string): boolean {
	return Array.from(container.querySelectorAll("button")).some((candidate) =>
		candidate.textContent?.includes(text),
	);
}

function headerByLabel(container: HTMLElement, label: string): HTMLElement {
	const header = container.querySelector(`[role="button"][aria-label="${label}"]`);
	if (!(header instanceof HTMLElement)) {
		throw new Error(`Graph header not found: ${label}`);
	}
	return header;
}

function readCollapsedPrefs(): Record<string, boolean> {
	const raw = localStorageRef?.get(GIT_GRAPH_COLLAPSED_KEY);
	if (!raw) return {};
	return JSON.parse(raw) as Record<string, boolean>;
}

describe("GitCommitGraph", () => {
	beforeEach(async () => {
		installDom();
		__resetGitGraphCollapsedCache();
		__resetGitGraphHeightCache();
		await initTestI18n();
	});

	afterEach(() => {
		restoreGitApi?.();
		restoreGitApi = undefined;
		if (!root) return;
		root.unmount();
		root = undefined;
	});

	test("commit rows open and close preview, preserve native links, and clear on target change", async () => {
		stubGitApi();
		const { container, rerender } = renderGraph("chapter-preview");
		await waitFor(() => !!container.querySelector("[data-commit-row]"));
		const link = container.querySelector(`[data-commit-row="${HEAD_SHA}"]`) as HTMLAnchorElement;
		expect(link.getAttribute("href")).toContain(
			`/git/chapters/chapter-preview/commits/${HEAD_SHA}`,
		);
		for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) {
			const event = new Event("click", { bubbles: true, cancelable: true });
			Object.assign(event, { button: 0, [modifier]: true });
			link.dispatchEvent(event);
			await flushRender();
			expect(event.defaultPrevented).toBe(false);
			expect(container.querySelector("[data-preview-sha]")).toBeNull();
		}
		const click = () => {
			const event = new Event("click", { bubbles: true, cancelable: true });
			Object.assign(event, { button: 0 });
			link.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(true);
		};
		click();
		await waitFor(() => !!container.querySelector(`[data-preview-sha="${HEAD_SHA}"]`));
		buttonByText(container, "Close preview").click();
		await waitFor(() => !container.querySelector("[data-preview-sha]"));
		click();
		await waitFor(() => !!container.querySelector("[data-preview-sha]"));
		rerender("chapter-other");
		await waitFor(() => !container.querySelector("[data-preview-sha]"));
	});

	test("1. default expanded shows commit messages", async () => {
		const chapterId = "chapter-graph-expand";
		const logCalls = stubGitApi();
		const qc = new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
				mutations: { retry: false },
			},
		});
		qc.setQueryData(["gitStatus", chapterId], makeStatus());
		const { container, queryClient } = renderGraph(chapterId, qc);
		await flushRender();
		await waitFor(() => textOf(container).includes("feat: stage commit graph"));

		expect(textOf(container)).toContain("Graph");
		expect(textOf(container)).toContain("feat: stage commit graph");
		expect(textOf(container)).toContain("chore: prepare workspace");
		expect(textOf(container)).toContain("init repository");
		expect(logCalls.length).toBeGreaterThan(0);
		expect(logCalls[0]?.skip).toBe(0);

		queryClient.clear();
	});

	test("2. clicking header collapses and hides messages", async () => {
		const chapterId = "chapter-graph-collapse";
		stubGitApi();
		const qc = new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
				mutations: { retry: false },
			},
		});
		qc.setQueryData(["gitStatus", chapterId], makeStatus());
		const { container, queryClient } = renderGraph(chapterId, qc);
		await waitFor(() => textOf(container).includes("feat: stage commit graph"));

		headerByLabel(container, "Collapse graph").dispatchEvent(new Event("click", { bubbles: true }));
		await flushRender();
		await waitFor(() => !textOf(container).includes("feat: stage commit graph"));

		expect(textOf(container)).toContain("Graph");
		expect(textOf(container)).not.toContain("feat: stage commit graph");
		expect(headerByLabel(container, "Expand graph")).toBeTruthy();

		queryClient.clear();
	});

	test("4. missing parents degrades without throwing", async () => {
		const chapterId = "chapter-graph-topology";
		stubGitApi({ commits: makeCommits({ withParents: false }) });
		const qc = new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
				mutations: { retry: false },
			},
		});
		qc.setQueryData(["gitStatus", chapterId], makeStatus());
		const { container, queryClient } = renderGraph(chapterId, qc);
		await waitFor(() => textOf(container).includes("feat: stage commit graph"));

		expect(textOf(container)).toContain("feat: stage commit graph");
		expect(textOf(container)).toContain("Parent links unavailable for this workspace");

		queryClient.clear();
	});

	test("5. collapse writes localStorage under the workspace key", async () => {
		const chapterId = "chapter-graph-persist";
		stubGitApi();
		const qc = new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
				mutations: { retry: false },
			},
		});
		qc.setQueryData(["gitStatus", chapterId], makeStatus());
		const { container, queryClient } = renderGraph(chapterId, qc);
		await waitFor(
			() => container.querySelector('[role="button"][aria-label="Collapse graph"]') != null,
		);

		expect(readCollapsedPrefs()[chapterId]).toBeUndefined();

		headerByLabel(container, "Collapse graph").dispatchEvent(new Event("click", { bubbles: true }));
		await flushRender();
		await waitFor(() => readCollapsedPrefs()[chapterId] === true);

		expect(readCollapsedPrefs()[chapterId]).toBe(true);

		queryClient.clear();
	});

	test("6. expanded graph exposes a resize separator with default height", async () => {
		const chapterId = "chapter-graph-resize";
		stubGitApi();
		const qc = new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
				mutations: { retry: false },
			},
		});
		qc.setQueryData(["gitStatus", chapterId], makeStatus());
		const { container, queryClient } = renderGraph(chapterId, qc);
		await waitFor(() => textOf(container).includes("feat: stage commit graph"));

		const separator = container.querySelector(
			'[role="separator"][aria-label="Resize graph height"]',
		);
		expect(separator).not.toBeNull();
		expect(separator?.getAttribute("aria-valuenow")).toBe(String(GIT_GRAPH_HEIGHT_DEFAULT));
		expect(separator?.getAttribute("aria-valuemin")).toBe(String(GIT_GRAPH_HEIGHT_MIN));
		expect(separator?.getAttribute("aria-valuemax")).toBe(String(GIT_GRAPH_HEIGHT_MAX));

		// Keyboard grow: ArrowUp adds 24px and persists under the workspace key.
		separator?.dispatchEvent(new Event("keydown", { bubbles: true, cancelable: true }));
		// linkedom KeyboardEvent may be limited; call the handler path via setHeight through storage after key event simulation.
		const keyEvent = new Event("keydown", { bubbles: true, cancelable: true }) as Event & {
			key?: string;
		};
		keyEvent.key = "ArrowUp";
		separator?.dispatchEvent(keyEvent);
		await flushRender();

		const raw = localStorageRef?.get(GIT_GRAPH_HEIGHT_KEY);
		expect(raw).toBeTruthy();
		const prefs = JSON.parse(raw ?? "{}") as Record<string, number>;
		expect(prefs[chapterId]).toBe(GIT_GRAPH_HEIGHT_DEFAULT + 24);

		queryClient.clear();
	});

	test("7. collapsed graph hides the resize separator", async () => {
		const chapterId = "chapter-graph-resize-collapsed";
		stubGitApi();
		const qc = new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
				mutations: { retry: false },
			},
		});
		qc.setQueryData(["gitStatus", chapterId], makeStatus());
		const { container, queryClient } = renderGraph(chapterId, qc);
		await waitFor(() => textOf(container).includes("feat: stage commit graph"));

		headerByLabel(container, "Collapse graph").dispatchEvent(new Event("click", { bubbles: true }));
		await flushRender();
		await waitFor(() => !textOf(container).includes("feat: stage commit graph"));

		expect(
			container.querySelector('[role="separator"][aria-label="Resize graph height"]'),
		).toBeNull();

		queryClient.clear();
	});
});

/**
 * Pagination, host-bounded height and refresh feedback.
 *
 * The bug these pin: "load more" used to be gated on
 * `commits.length === skip + PAGE_SIZE`, where `skip` was the last request's
 * OFFSET rather than the loaded count. That equality only held by coincidence of a
 * fixed page size — one short page (history capped upstream, or a repo with fewer
 * commits than a page) and the button disappeared while `atCap` was nowhere near.
 */
describe("GitCommitGraph pagination", () => {
	beforeEach(async () => {
		installDom();
		__resetGitGraphCollapsedCache();
		__resetGitGraphHeightCache();
		await initTestI18n();
	});

	afterEach(() => {
		restoreGitApi?.();
		restoreGitApi = undefined;
		if (!root) return;
		root.unmount();
		root = undefined;
	});

	test("offers load-more after a FULL first page", async () => {
		const chapterId = "chapter-graph-page-full";
		stubGitApi({ commits: makeLongHistory(GRAPH_PAGE_SIZE + 10) });
		const { container, queryClient } = renderGraph(chapterId, makeQueryClient(chapterId));
		await waitFor(() => textOf(container).includes("commit 0"));

		expect(hasButton(container, "Load More")).toBe(true);

		queryClient.clear();
	});

	test("hides load-more after a SHORT first page", async () => {
		const chapterId = "chapter-graph-page-short";
		// Fewer commits than one page: the end of history was reached on the first call.
		stubGitApi({ commits: makeLongHistory(GRAPH_PAGE_SIZE - 3) });
		const { container, queryClient } = renderGraph(chapterId, makeQueryClient(chapterId));
		await waitFor(() => textOf(container).includes("commit 0"));

		expect(hasButton(container, "Load More")).toBe(false);

		queryClient.clear();
	});

	test("keeps load-more across a SECOND full page, then hides it on the short tail", async () => {
		const chapterId = "chapter-graph-page-chain";
		// Two full pages plus a short third: the old arithmetic gate could not express this.
		const total = GRAPH_PAGE_SIZE * 2 + 5;
		const logCalls = stubGitApi({ commits: makeLongHistory(total) });
		const { container, queryClient } = renderGraph(chapterId, makeQueryClient(chapterId));
		await waitFor(() => textOf(container).includes("commit 0"));

		buttonByText(container, "Load More").dispatchEvent(new Event("click", { bubbles: true }));
		await waitFor(() => textOf(container).includes(`commit ${GRAPH_PAGE_SIZE}`));
		// Second page was requested at the loaded count, not at a stale offset.
		expect(logCalls[1]?.skip).toBe(GRAPH_PAGE_SIZE);
		expect(hasButton(container, "Load More")).toBe(true);

		buttonByText(container, "Load More").dispatchEvent(new Event("click", { bubbles: true }));
		await waitFor(() => textOf(container).includes(`commit ${total - 1}`));
		expect(logCalls[2]?.skip).toBe(GRAPH_PAGE_SIZE * 2);
		// The third page came back short → history exhausted.
		expect(hasButton(container, "Load More")).toBe(false);

		queryClient.clear();
	});
});

describe("GitCommitGraph height is bounded by its host", () => {
	beforeEach(async () => {
		installDom();
		__resetGitGraphCollapsedCache();
		__resetGitGraphHeightCache();
		await initTestI18n();
	});

	afterEach(() => {
		restoreGitApi?.();
		restoreGitApi = undefined;
		if (!root) return;
		root.unmount();
		root = undefined;
	});

	/**
	 * linkedom has no layout engine, so `clientHeight` is 0 unless defined. Render
	 * into a container with a real height so the host-measurement path is actually
	 * exercised rather than short-circuiting to "unmeasurable".
	 */
	function renderInHost(chapterId: string, hostHeight: number | undefined) {
		const qc = makeQueryClient(chapterId);
		const container = document.createElement("div");
		if (hostHeight !== undefined) {
			Object.defineProperty(container, "clientHeight", {
				configurable: true,
				get: () => hostHeight,
			});
		}
		document.body.appendChild(container);
		root = createRoot(container);
		root.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider>
					<QueryClientProvider client={qc}>
						<GitCommitGraph target={chapterId} />
					</QueryClientProvider>
				</MantineProvider>
			</I18nextProvider>,
		);
		return { container, queryClient: qc };
	}

	function separatorOf(container: HTMLElement) {
		const separator = container.querySelector(
			'[role="separator"][aria-label="Resize graph height"]',
		);
		if (!separator) throw new Error("Resize separator not found");
		return {
			value: Number(separator.getAttribute("aria-valuenow")),
			max: Number(separator.getAttribute("aria-valuemax")),
			min: Number(separator.getAttribute("aria-valuemin")),
		};
	}

	test("clamps a stored height that would crush the changes list above it", async () => {
		const chapterId = "chapter-graph-host-clamp";
		// A preference carried over from a taller window: 560px inside a 400px panel
		// leaves the sibling list with nothing.
		localStorageRef?.set(GIT_GRAPH_HEIGHT_KEY, JSON.stringify({ [chapterId]: 560 }));
		__resetGitGraphHeightCache();
		stubGitApi();
		const { container, queryClient } = renderInHost(chapterId, 400);
		await waitFor(() => textOf(container).includes("feat: stage commit graph"));
		await waitFor(() => separatorOf(container).value < 560);

		const { value, max, min } = separatorOf(container);
		expect(value).toBeLessThan(560);
		// Header + the floor reserved for the changes list come off the host height.
		expect(value).toBeLessThanOrEqual(400 - GIT_GRAPH_HEIGHT_MIN);
		// The announced ceiling matches what is reachable here, not the global maximum:
		// telling a screen reader it can grow to 560 when the panel stops earlier is a lie.
		expect(max).toBe(value);
		expect(max).toBeLessThan(GIT_GRAPH_HEIGHT_MAX);
		expect(min).toBe(GIT_GRAPH_HEIGHT_MIN);
		// The PREFERENCE itself is untouched: moving the panel to a taller host restores it.
		const stored = JSON.parse(localStorageRef?.get(GIT_GRAPH_HEIGHT_KEY) ?? "{}") as Record<
			string,
			number
		>;
		expect(stored[chapterId]).toBe(560);

		queryClient.clear();
	});

	test("never goes below the floor, even in a host too short for both panes", async () => {
		const chapterId = "chapter-graph-host-tiny";
		stubGitApi();
		// 180px cannot hold the graph AND the reserved list space; the strip must stay
		// usable rather than collapsing to zero.
		const { container, queryClient } = renderInHost(chapterId, 180);
		await waitFor(() => textOf(container).includes("feat: stage commit graph"));

		const { value, max } = separatorOf(container);
		expect(value).toBe(GIT_GRAPH_HEIGHT_MIN);
		expect(max).toBe(GIT_GRAPH_HEIGHT_MIN);

		queryClient.clear();
	});

	test("honours the stored preference when the host is tall enough", async () => {
		const chapterId = "chapter-graph-host-roomy";
		localStorageRef?.set(GIT_GRAPH_HEIGHT_KEY, JSON.stringify({ [chapterId]: 300 }));
		__resetGitGraphHeightCache();
		stubGitApi();
		const { container, queryClient } = renderInHost(chapterId, 900);
		await waitFor(() => textOf(container).includes("feat: stage commit graph"));

		expect(separatorOf(container).value).toBe(300);

		queryClient.clear();
	});

	test("does not clamp when the host height cannot be measured", async () => {
		const chapterId = "chapter-graph-host-unknown";
		localStorageRef?.set(GIT_GRAPH_HEIGHT_KEY, JSON.stringify({ [chapterId]: 520 }));
		__resetGitGraphHeightCache();
		stubGitApi();
		// No clientHeight defined → 0 → unmeasurable. Shrinking the strip on a reading
		// this coarse would be worse than leaving the user's choice alone.
		const { container, queryClient } = renderInHost(chapterId, undefined);
		await waitFor(() => textOf(container).includes("feat: stage commit graph"));

		expect(separatorOf(container).value).toBe(520);

		queryClient.clear();
	});
});

describe("GitCommitGraph refresh gives feedback", () => {
	beforeEach(async () => {
		installDom();
		__resetGitGraphCollapsedCache();
		__resetGitGraphHeightCache();
		await initTestI18n();
	});

	afterEach(() => {
		restoreGitApi?.();
		restoreGitApi = undefined;
		if (!root) return;
		root.unmount();
		root = undefined;
	});

	test("refetches from offset 0 and keeps the previous page visible", async () => {
		const chapterId = "chapter-graph-refresh";
		const logCalls = stubGitApi();
		const { container, queryClient } = renderGraph(chapterId, makeQueryClient(chapterId));
		await waitFor(() => textOf(container).includes("feat: stage commit graph"));
		const before = logCalls.length;

		const refreshButton = container.querySelector('[aria-label="Refresh graph"]');
		if (!refreshButton) throw new Error("Refresh control not found");
		refreshButton.dispatchEvent(new Event("click", { bubbles: true }));
		await waitFor(() => logCalls.length > before);

		expect(logCalls[logCalls.length - 1]?.skip).toBe(0);
		// Blanking the body would make the strip jump; the previous page stays put and the
		// control itself carries the in-flight state.
		expect(textOf(container)).toContain("feat: stage commit graph");

		queryClient.clear();
	});
});

describe("GitCommitGraph workspace switch", () => {
	beforeEach(async () => {
		installDom();
		__resetGitGraphCollapsedCache();
		__resetGitGraphHeightCache();
		await initTestI18n();
	});

	afterEach(() => {
		restoreGitApi?.();
		restoreGitApi = undefined;
		if (!root) return;
		root.unmount();
		root = undefined;
	});

	test("does not show the previous repo's commits after switching target", async () => {
		const first = "chapter-graph-repo-a";
		const second = "chapter-graph-repo-b";
		const original = { getGitStatus: api.getGitStatus, getGitLog: api.getGitLog };
		api.getGitStatus = async () => makeStatus();
		// Per-workspace histories with no message in common.
		api.getGitLog = async (target) => {
			const key = typeof target === "string" ? target : target.workspaceKey;
			return [
				{
					sha: key === first ? HEAD_SHA : PARENT_SHA,
					shortSha: "aaaaaaa",
					message: key === first ? "only in repo A" : "only in repo B",
					author: "alice",
					date: "2026-01-01T00:00:00.000Z",
					parents: [],
				},
			];
		};
		restoreGitApi = () => Object.assign(api, original);

		const qc = makeQueryClient(first);
		qc.setQueryData(["gitStatus", second], makeStatus());
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		const render = (target: string) => {
			root?.render(
				<I18nextProvider i18n={i18n}>
					<MantineProvider>
						<QueryClientProvider client={qc}>
							<GitCommitGraph target={target} />
						</QueryClientProvider>
					</MantineProvider>
				</I18nextProvider>,
			);
		};
		render(first);
		await waitFor(() => textOf(container).includes("only in repo A"));

		render(second);
		await waitFor(() => textOf(container).includes("only in repo B"));
		expect(textOf(container)).not.toContain("only in repo A");

		qc.clear();
	});
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("GitCommitGraph query lifecycle", () => {
	beforeEach(async () => {
		installDom();
		__resetGitGraphCollapsedCache();
		__resetGitGraphHeightCache();
		await initTestI18n();
	});

	afterEach(() => {
		root?.unmount();
		root = undefined;
		restoreGitApi?.();
		restoreGitApi = undefined;
	});

	test("equivalent target objects do not refetch on parent renders", async () => {
		const target = { narratorId: "n", workspaceKey: "workspace", canWrite: true };
		const calls = stubGitApi();
		const { container, queryClient, rerender } = renderGraph(target);
		await waitFor(() => textOf(container).includes("feat: stage commit graph"));
		for (let i = 0; i < 5; i++) {
			rerender({ ...target });
			await flushRender();
		}
		expect(calls).toHaveLength(1);
		queryClient.clear();
	});

	test("background invalidation leaves refresh idle; manual refresh spins and disables", async () => {
		stubGitApi();
		const { container, queryClient } = renderGraph("refresh-states");
		await waitFor(() => textOf(container).includes("feat: stage commit graph"));
		const background = deferred<GitLogEntry[]>();
		api.getGitLog = async () => background.promise;
		const invalidation = queryClient.invalidateQueries({ queryKey: ["gitLog"] });
		await waitFor(() => queryClient.isFetching({ queryKey: ["gitLog"] }) === 1);
		await flushRender();
		const button = () => container.querySelector('[aria-label="Refresh graph"]');
		expect(button()?.hasAttribute("disabled")).toBe(false);
		expect(button()?.hasAttribute("data-loading")).toBe(false);
		expect(textOf(container)).toContain("feat: stage commit graph");
		background.resolve(makeCommits());
		await invalidation;
		await flushRender();

		const manual = deferred<GitLogEntry[]>();
		api.getGitLog = async () => manual.promise;
		button()?.dispatchEvent(new Event("click", { bubbles: true }));
		await waitFor(() => button()?.hasAttribute("data-loading") === true);
		expect(button()?.hasAttribute("disabled")).toBe(true);
		manual.resolve(makeCommits());
		await waitFor(() => !button()?.hasAttribute("data-loading"));
		queryClient.clear();
	});

	test("initially collapsed graph never starts a log request", async () => {
		localStorageRef?.set(GIT_GRAPH_COLLAPSED_KEY, JSON.stringify({ "starts-collapsed": true }));
		__resetGitGraphCollapsedCache();
		const calls = stubGitApi();
		const { container, queryClient } = renderGraph("starts-collapsed");
		await waitFor(() => !!container.querySelector('[aria-label="Expand graph"]'));
		await queryClient.invalidateQueries({ queryKey: ["gitLog"] });
		await flushRender();
		expect(calls).toHaveLength(0);
		queryClient.clear();
	});

	test("collapsed graph defers invalidation until expanded", async () => {
		const calls = stubGitApi();
		const { container, queryClient } = renderGraph("collapsed-invalidations");
		await waitFor(() => textOf(container).includes("feat: stage commit graph"));
		headerByLabel(container, "Collapse graph").click();
		await waitFor(() => !!container.querySelector('[aria-label="Expand graph"]'));
		await queryClient.invalidateQueries({ queryKey: ["gitLog"] });
		await flushRender();
		expect(calls).toHaveLength(1);
		headerByLabel(container, "Expand graph").click();
		await waitFor(() => calls.length === 2);
		queryClient.clear();
	});

	for (const outcome of ["resolve", "reject"] as const) {
		test(`ignores old pagination ${outcome} after workspace switch`, async () => {
			stubGitApi({ commits: makeLongHistory(GRAPH_PAGE_SIZE + 1) });
			const pending = deferred<GitLogEntry[]>();
			const originalLog = api.getGitLog;
			let signal: AbortSignal | undefined;
			api.getGitLog = async (target, limit, skip, requestSignal) => {
				if (skip) {
					signal = requestSignal;
					return pending.promise;
				}
				return target === "old-workspace" ? originalLog(target, limit, skip) : makeCommits();
			};
			const { container, queryClient, rerender } = renderGraph("old-workspace");
			await waitFor(() => hasButton(container, "Load More"));
			buttonByText(container, "Load More").click();
			await waitFor(() => !!signal);
			await flushRender();
			const refresh = container.querySelector('[aria-label="Refresh graph"]');
			expect(refresh?.hasAttribute("data-loading")).toBe(false);
			expect(refresh?.hasAttribute("disabled")).toBe(false);
			rerender("new-workspace");
			await waitFor(() => textOf(container).includes("feat: stage commit graph"));
			expect(signal?.aborted).toBe(true);
			if (outcome === "resolve") pending.resolve(makeLongHistory(GRAPH_PAGE_SIZE + 1).slice(-1));
			else pending.reject(new Error("old pagination failed"));
			await flushRender();
			await flushRender();
			expect(textOf(container)).not.toContain(`commit ${GRAPH_PAGE_SIZE}`);
			expect(textOf(container)).not.toContain("old pagination failed");
			expect(textOf(container)).toContain("feat: stage commit graph");
			queryClient.clear();
		});
	}

	test("first-page invalidation discards pending and loaded older pages", async () => {
		stubGitApi({ commits: makeLongHistory(GRAPH_PAGE_SIZE * 3) });
		const { container, queryClient } = renderGraph("pagination-refresh");
		await waitFor(() => hasButton(container, "Load More"));
		buttonByText(container, "Load More").click();
		await waitFor(() => textOf(container).includes(`commit ${GRAPH_PAGE_SIZE}`));
		const pending = deferred<GitLogEntry[]>();
		api.getGitLog = async (_target, _limit, skip) => (skip ? pending.promise : makeCommits());
		buttonByText(container, "Load More").click();
		await flushRender();
		await queryClient.invalidateQueries({ queryKey: ["gitLog"] });
		await waitFor(() => textOf(container).includes("feat: stage commit graph"));
		pending.resolve(makeLongHistory(GRAPH_PAGE_SIZE * 3).slice(GRAPH_PAGE_SIZE * 2));
		await flushRender();
		await flushRender();
		expect(textOf(container)).not.toContain(`commit ${GRAPH_PAGE_SIZE}`);
		expect(textOf(container)).not.toContain(`commit ${GRAPH_PAGE_SIZE * 2}`);
		expect(hasButton(container, "Load More")).toBe(false);
		queryClient.clear();
	});
});
