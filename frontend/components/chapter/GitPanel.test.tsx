import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { WorkspaceContext } from "@shared/workspace-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { type GitStatusSummary, invalidateWorkspaceQueries } from "../../hooks/useGit";
import { __resetGitFolderPrefsCache } from "../../hooks/useGitFolderPrefs";
import { __resetGitGraphCollapsedCache } from "../../hooks/useGitGraphCollapsed";
import { __resetGitViewModeCache } from "../../hooks/useGitViewMode";
import { api } from "../../lib/api";
import { type GitTarget, type GitWorkspace, gitTargetKey } from "../../lib/api/git";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import commonLocale from "../../locales/en/common.json";
import gitLocale from "../../locales/en/git.json";
import { ConfirmDialogProvider } from "../common/ConfirmDialogProvider";

// Use an ISOLATED i18next instance (not the process-global default) so shared
// singleton mutations from other frontend suites (changeLanguage, differing
// namespace init) cannot leave this suite rendering raw i18n keys. The lib/i18n
// mock points the component's own `i18n` import at the same isolated instance,
// and renders are wrapped in <I18nextProvider> below.
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
const { GitPanel } = await import("./GitPanel");

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let root: Root | undefined;
let restoreGitApi: (() => void) | undefined;

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const localStorage = new Map<string, string>();
	// Folder expansion lives in sessionStorage (per-tab, cleared with the tab), so
	// the harness has to provide it separately from localStorage.
	const sessionStorage = new Map<string, string>();
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
		// The plain-http clipboard fallback builds an <input> and reads it back, so
		// the constructor has to be reachable as a global (see installLegacyClipboard).
		HTMLInputElement: window.HTMLInputElement,
		HTMLTextAreaElement: window.HTMLTextAreaElement,
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
			defaultNS: "common",
			ns: ["common", "git"],
			resources: { en: { common: commonLocale, git: gitLocale } },
			interpolation: { escapeValue: false },
			react: { useSuspense: false },
		});
	}
}

function makeStatus(): GitStatusSummary {
	return {
		hasChanges: true,
		staged: 1,
		unstaged: 1,
		untracked: 1,
		files: [
			{
				status: "M ",
				path: "src/staged.ts",
				linesAdded: 2,
				linesRemoved: 0,
				stagedLinesAdded: 2,
				stagedLinesRemoved: 0,
				unstagedLinesAdded: 0,
				unstagedLinesRemoved: 0,
			},
			{
				status: " M",
				path: "src/unstaged.ts",
				linesAdded: 1,
				linesRemoved: 1,
				stagedLinesAdded: 0,
				stagedLinesRemoved: 0,
				unstagedLinesAdded: 1,
				unstagedLinesRemoved: 1,
			},
			{
				status: "??",
				path: "src/new-file.ts",
				linesAdded: 3,
				linesRemoved: 0,
				stagedLinesAdded: 0,
				stagedLinesRemoved: 0,
				unstagedLinesAdded: 3,
				unstagedLinesRemoved: 0,
			},
		],
		totalFiles: 3,
		headSha: "abc1234",
		branch: "main",
		linesAdded: 6,
		linesRemoved: 1,
	};
}

/** Deeply nested single-child chains, the case that would eat a narrow panel's width. */
function makeDeepStatus(): GitStatusSummary {
	return {
		hasChanges: true,
		staged: 0,
		unstaged: 1,
		untracked: 0,
		files: [
			{
				status: " M",
				path: "frontend/components/chapter/deep/nested/leaf.ts",
				linesAdded: 1,
				linesRemoved: 0,
				stagedLinesAdded: 0,
				stagedLinesRemoved: 0,
				unstagedLinesAdded: 1,
				unstagedLinesRemoved: 0,
			},
		],
		totalFiles: 1,
		headSha: "abc1234",
		branch: "main",
		linesAdded: 1,
		linesRemoved: 0,
	};
}

function stubInteractiveGitApi(calls: Array<{ name: string; body?: unknown }>) {
	const original = {
		getGitStatus: api.getGitStatus,
		getGitLog: api.getGitLog,
		gitStage: api.gitStage,
		gitAiCommitMessage: api.gitAiCommitMessage,
	};
	api.getGitStatus = async () => makeStatus();
	// GitCommitGraph fetches log via api.getGitLog (not React Query); without a
	// non-empty stub the expanded graph hangs on the real HTTP timeout.
	api.getGitLog = async () => [
		{
			sha: "abc1234".padEnd(40, "0"),
			shortSha: "abc1234",
			message: "feat: seed commit for graph strip",
			author: "tester",
			date: "2026-01-01T00:00:00.000Z",
			parents: [],
		},
	];
	api.gitStage = async (_chapterId, body) => {
		calls.push({ name: "stage", body });
		return makeStatus();
	};
	api.gitAiCommitMessage = async () => {
		calls.push({ name: "ai" });
		return { message: "fix: update file" };
	};
	restoreGitApi = () => Object.assign(api, original);
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
	const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
		candidate.textContent?.includes(text),
	);
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error(`Button not found: ${text}`);
	}
	return button;
}

function buttonByLabel(container: HTMLElement, label: string): HTMLButtonElement {
	const button = container.querySelector(`button[aria-label="${label}"]`);
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error(`Button not found: ${label}`);
	}
	return button;
}

/**
 * Present the DOM as a NON-secure context with no Clipboard API, which is what
 * `copyTextToClipboard` sees on a plain-http deployment — the shape this project
 * explicitly supports (small-team private hosting, frequently http on a LAN).
 *
 * Worth its own harness because the two branches copy by completely different
 * means: the Clipboard API takes the string directly, while this one has to build
 * a form control, select it and run `execCommand`. A test that only ever installs
 * `navigator.clipboard` verifies the branch that plain-http users never reach.
 *
 * Returns the values `execCommand("copy")` would have placed on the clipboard,
 * read off the temporary element the way the platform would.
 */
function installLegacyClipboard(): string[] {
	const copied: string[] = [];
	// linkedom implements neither, and the fallback calls both on the element it
	// creates; without them the copy throws instead of exercising the path.
	//
	// `defineProperty`, not `Object.assign`: linkedom shares ONE
	// `HTMLInputElement.prototype` across every window it hands out, and sibling
	// suites (useClipboard, clipboard, CopyButton) install these same stubs with
	// `defineProperty` — which leaves them `writable: false`. Assigning over that
	// throws, so this harness worked alone and failed whenever one of those suites
	// ran first in the same process.
	for (const proto of [
		globalThis.HTMLInputElement.prototype,
		globalThis.HTMLTextAreaElement.prototype,
	]) {
		Object.defineProperties(proto, {
			select: { value: () => {}, configurable: true },
			setSelectionRange: { value: () => {}, configurable: true },
		});
	}
	Object.defineProperty(globalThis.navigator, "clipboard", {
		value: undefined,
		configurable: true,
	});
	Object.defineProperty(globalThis.window, "isSecureContext", {
		value: false,
		configurable: true,
	});
	Object.defineProperty(globalThis.document, "execCommand", {
		configurable: true,
		value: (command: string) => {
			if (command !== "copy") return false;
			// Read the throwaway control the fallback appended. Located by its
			// `aria-hidden` marker rather than `document.activeElement`, because
			// linkedom's `focus()` does not move the active element — trusting it here
			// would make this test pass on an empty clipboard.
			const source = globalThis.document.querySelector('input[aria-hidden="true"]');
			if (source instanceof globalThis.HTMLInputElement) copied.push(source.value);
			return true;
		},
	});
	return copied;
}

/** Tree rows are role="button" divs so their own action icons can stay nested. */
function rowByLabel(container: HTMLElement, label: string): HTMLElement {
	const row = container.querySelector(`[role="button"][aria-label="${label}"]`);
	if (!(row instanceof HTMLElement)) {
		throw new Error(`Row not found: ${label}`);
	}
	return row;
}

function rowLabels(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll('[role="button"][aria-label]'))
		.map((row) => row.getAttribute("aria-label") ?? "")
		.filter((label) => /^(Expand|Collapse) folder |^View diff of /.test(label));
}

function flushRender() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("GitPanel", () => {
	beforeEach(async () => {
		installDom();
		// Preference snapshots are memoized at module scope; installDom() hands out
		// fresh storage maps each test, so every cache must be reset between cases.
		__resetGitFolderPrefsCache();
		__resetGitViewModeCache();
		__resetGitGraphCollapsedCache();
		// Default stubs so GitCommitGraph never hits the real log endpoint.
		const original = {
			getGitStatus: api.getGitStatus,
			getGitLog: api.getGitLog,
		};
		api.getGitStatus = async () => makeStatus();
		api.getGitLog = async () => [
			{
				sha: "abc1234".padEnd(40, "0"),
				shortSha: "abc1234",
				message: "feat: seed commit for graph strip",
				author: "tester",
				date: "2026-01-01T00:00:00.000Z",
				parents: [],
			},
		];
		restoreGitApi = () => Object.assign(api, original);
		await initTestI18n();
	});

	afterEach(() => {
		restoreGitApi?.();
		restoreGitApi = undefined;
		if (!root) return;
		root.unmount();
		root = undefined;
	});

	test("renders git changes panel without crashing on TS-compatible status data", async () => {
		const chapterId = "chapter-git-smoke";
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
				mutations: { retry: false },
			},
		});
		queryClient.setQueryData(["gitStatus", chapterId], makeStatus());

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		root.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider>
					<QueryClientProvider client={queryClient}>
						<ConfirmDialogProvider>
							<GitPanel chapterId={chapterId} />
						</ConfirmDialogProvider>
					</QueryClientProvider>
				</MantineProvider>
			</I18nextProvider>,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		// GitCommitGraph fetches via api.getGitLog after mount; poll for the strip.
		const deadline = Date.now() + 2000;
		while (!container.textContent?.includes("feat: seed commit for graph strip")) {
			if (Date.now() >= deadline) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		expect(container.textContent).toContain("Changes");
		expect(container.textContent).toContain("Staged");
		expect(container.textContent).toContain("Commit");
		// Stage 3: collapsible commit graph sits under the changes list.
		expect(container.textContent).toContain("Graph");
		expect(container.textContent).toContain("feat: seed commit for graph strip");

		// Nothing is expanded on a first visit: a repo with changes across many
		// folders would otherwise open as one long undifferentiated file list, and
		// the folder rows already carry the per-folder counts and +/- totals.
		expect(rowLabels(container)).toEqual(["Expand folder src", "Expand folder src"]);

		// Opening one section's folder reveals only that section's files — each
		// section keeps its own expanded set even though both are named `src`.
		rowByLabel(container, "Expand folder src").dispatchEvent(new Event("click", { bubbles: true }));
		await flushRender();
		expect(rowLabels(container)).toEqual([
			"Collapse folder src",
			"View diff of src/staged.ts",
			"Expand folder src",
		]);

		// Files are grouped under their folder instead of printing full paths.
		expect(container.textContent).toContain("staged.ts");
		expect(container.textContent).not.toContain("src/staged.ts");

		queryClient.clear();
	});

	test("collapses a folder and stages every file beneath it", async () => {
		const chapterId = "chapter-git-tree";
		const calls: Array<{ name: string; body?: unknown }> = [];
		stubInteractiveGitApi(calls);
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
				mutations: { retry: false },
			},
		});
		queryClient.setQueryData(["gitStatus", chapterId], makeStatus());

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		root.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider>
					<QueryClientProvider client={queryClient}>
						<ConfirmDialogProvider>
							<GitPanel chapterId={chapterId} />
						</ConfirmDialogProvider>
					</QueryClientProvider>
				</MantineProvider>
			</I18nextProvider>,
		);
		await flushRender();

		// Folder-level stage covers every file beneath, and works WITHOUT expanding:
		// the whole point of defaulting to collapsed is that a folder can be staged
		// as a unit. The folder row reuses the file wording, so scope the lookup to
		// the row itself. Last match = the unstaged section.
		const stageFolderRow = Array.from(
			container.querySelectorAll('[role="button"][aria-label="Expand folder src"]'),
		).at(-1);
		if (!(stageFolderRow instanceof HTMLElement)) throw new Error("Folder row not found");
		const stageFolderButton = stageFolderRow.querySelector('button[aria-label="Stage"]');
		if (!(stageFolderButton instanceof HTMLButtonElement)) {
			throw new Error("Folder stage button not found");
		}
		stageFolderButton.dispatchEvent(new Event("click", { bubbles: true }));
		await flushRender();
		expect(calls).toEqual([
			{ name: "stage", body: { files: ["src/new-file.ts", "src/unstaged.ts"] } },
		]);

		// Expanding reveals that folder's children and leaves the other section alone.
		stageFolderRow.dispatchEvent(new Event("click", { bubbles: true }));
		await flushRender();

		expect(rowLabels(container)).toEqual([
			"Expand folder src",
			"Collapse folder src",
			"View diff of src/new-file.ts",
			"View diff of src/unstaged.ts",
		]);

		// And collapsing again hides them, without disturbing the staged section.
		rowByLabel(container, "Collapse folder src").dispatchEvent(
			new Event("click", { bubbles: true }),
		);
		await flushRender();
		expect(rowLabels(container)).toEqual(["Expand folder src", "Expand folder src"]);

		queryClient.clear();
	});

	test("gives folder rows a folder glyph aligned with the file status badge", async () => {
		// A bare chevron made folder rows read as unanchored next to the files'
		// status badge, and left the two name columns ragged. The glyph carries the
		// "directory" signal; the equal leading width is what lines the names up.
		const chapterId = "chapter-git-folder-glyph";
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
				mutations: { retry: false },
			},
		});
		queryClient.setQueryData(["gitStatus", chapterId], makeStatus());

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		root.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider>
					<QueryClientProvider client={queryClient}>
						<ConfirmDialogProvider>
							<GitPanel chapterId={chapterId} />
						</ConfirmDialogProvider>
					</QueryClientProvider>
				</MantineProvider>
			</I18nextProvider>,
		);
		await flushRender();

		// Collapsed (the default) → closed-folder glyph beside a right chevron.
		const collapsedRow = rowByLabel(container, "Expand folder src");
		expect(collapsedRow.querySelector(".tabler-icon-folder")).not.toBeNull();
		expect(collapsedRow.querySelector(".tabler-icon-folder-open")).toBeNull();
		expect(collapsedRow.querySelector(".tabler-icon-chevron-right")).not.toBeNull();

		collapsedRow.dispatchEvent(new Event("click", { bubbles: true }));
		await flushRender();

		// Expanded → open-folder glyph, so the state reads without the chevron.
		const folderRow = rowByLabel(container, "Collapse folder src");
		expect(folderRow.querySelector(".tabler-icon-folder-open")).not.toBeNull();
		expect(folderRow.querySelector(".tabler-icon-chevron-down")).not.toBeNull();

		// Both leading slots reserve the same width, so the names after them align.
		const leadingWidth = (row: HTMLElement): string | undefined => {
			const slot = row.firstElementChild;
			return slot instanceof HTMLElement ? slot.style.width : undefined;
		};
		const fileRow = rowByLabel(container, "View diff of src/staged.ts");
		expect(leadingWidth(folderRow)).toBe(leadingWidth(fileRow));
		expect(leadingWidth(folderRow)).toBe("calc(1.75rem * var(--mantine-scale))");

		queryClient.clear();
	});

	test("remembers which folders were opened within the browser session", async () => {
		// The state has to outlive the component: a refresh used to reset every
		// folder, which is the whole reason it now lives in sessionStorage.
		const chapterId = "chapter-git-persist";
		const makeClient = () =>
			new QueryClient({
				defaultOptions: {
					queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
					mutations: { retry: false },
				},
			});
		const unmountPanel = () => {
			root?.unmount();
			root = undefined;
		};
		const renderPanel = (client: QueryClient) => {
			const container = document.createElement("div");
			document.body.appendChild(container);
			const panelRoot = createRoot(container);
			root = panelRoot;
			panelRoot.render(
				<I18nextProvider i18n={i18n}>
					<MantineProvider>
						<QueryClientProvider client={client}>
							<ConfirmDialogProvider>
								<GitPanel chapterId={chapterId} />
							</ConfirmDialogProvider>
						</QueryClientProvider>
					</MantineProvider>
				</I18nextProvider>,
			);
			return container;
		};

		const first = makeClient();
		first.setQueryData(["gitStatus", chapterId], makeStatus());
		const firstContainer = renderPanel(first);
		await flushRender();

		rowByLabel(firstContainer, "Expand folder src").dispatchEvent(
			new Event("click", { bubbles: true }),
		);
		await flushRender();
		expect(rowLabels(firstContainer)).toContain("View diff of src/staged.ts");

		// Unmount and mount fresh — same sessionStorage, new component tree.
		root?.unmount();
		root = undefined;
		first.clear();

		const second = makeClient();
		second.setQueryData(["gitStatus", chapterId], makeStatus());
		const secondContainer = renderPanel(second);
		await flushRender();

		// The staged section is open again; the unstaged one was never opened.
		expect(rowLabels(secondContainer)).toEqual([
			"Collapse folder src",
			"View diff of src/staged.ts",
			"Expand folder src",
		]);

		// A DIFFERENT chapter does not inherit it — state is keyed per chapter.
		unmountPanel();
		const other = makeClient();
		other.setQueryData(["gitStatus", "chapter-git-persist-other"], makeStatus());
		const otherContainer = document.createElement("div");
		document.body.appendChild(otherContainer);
		const otherRoot = createRoot(otherContainer);
		root = otherRoot;
		otherRoot.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider>
					<QueryClientProvider client={other}>
						<ConfirmDialogProvider>
							<GitPanel chapterId="chapter-git-persist-other" />
						</ConfirmDialogProvider>
					</QueryClientProvider>
				</MantineProvider>
			</I18nextProvider>,
		);
		await flushRender();
		expect(rowLabels(otherContainer)).toEqual(["Expand folder src", "Expand folder src"]);

		second.clear();
		other.clear();
	});

	test("labels a brand-new file as an addition in both sections", async () => {
		// `??` (never staged) and `AM` (staged, then edited again) are the two
		// shapes a new file takes. Both used to render something other than `A`:
		// `??` printed the raw question marks, and `AM` fell through to the gray
		// fallback because the badge concatenated BOTH porcelain halves.
		const chapterId = "chapter-git-added-badge";
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
				mutations: { retry: false },
			},
		});
		queryClient.setQueryData(["gitStatus", chapterId], {
			hasChanges: true,
			staged: 1,
			unstaged: 1,
			untracked: 1,
			files: [
				{
					status: "AM",
					path: "src/fresh.ts",
					linesAdded: 5,
					linesRemoved: 0,
					stagedLinesAdded: 4,
					stagedLinesRemoved: 0,
					unstagedLinesAdded: 1,
					unstagedLinesRemoved: 0,
				},
				{
					status: "??",
					path: "src/brand-new.ts",
					linesAdded: 3,
					linesRemoved: 0,
					stagedLinesAdded: 0,
					stagedLinesRemoved: 0,
					unstagedLinesAdded: 3,
					unstagedLinesRemoved: 0,
				},
			],
			totalFiles: 2,
			headSha: "abc1234",
			branch: "main",
			linesAdded: 8,
			linesRemoved: 0,
		} satisfies GitStatusSummary);

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		root.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider>
					<QueryClientProvider client={queryClient}>
						<ConfirmDialogProvider>
							<GitPanel chapterId={chapterId} />
						</ConfirmDialogProvider>
					</QueryClientProvider>
				</MantineProvider>
			</I18nextProvider>,
		);
		await flushRender();

		// Open both folders so the file rows (and their badges) are rendered.
		for (const row of Array.from(
			container.querySelectorAll('[role="button"][aria-label="Expand folder src"]'),
		)) {
			row.dispatchEvent(new Event("click", { bubbles: true }));
			await flushRender();
		}

		const badgeOf = (label: string): string | undefined => {
			const row = rowByLabel(container, label);
			// The badge is the row's leading element, same slot as a folder glyph.
			return row.firstElementChild?.textContent ?? undefined;
		};

		// Staged half of `AM` is the addition; the unstaged half is the later edit.
		expect(badgeOf("View diff of src/fresh.ts")).toBe("A");
		// The untracked file lives only in the unstaged section, and reads as new.
		expect(badgeOf("View diff of src/brand-new.ts")).toBe("A");
		// No badge anywhere still prints a raw two-character porcelain pair.
		expect(container.textContent).not.toContain("AM");
		expect(container.textContent).not.toContain("??");

		queryClient.clear();
	});

	test("keeps deep paths to two rows so a narrow panel does not indent off-screen", async () => {
		const chapterId = "chapter-git-deep";
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
				mutations: { retry: false },
			},
		});
		queryClient.setQueryData(["gitStatus", chapterId], makeDeepStatus());

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		root.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider>
					<QueryClientProvider client={queryClient}>
						<ConfirmDialogProvider>
							<GitPanel chapterId={chapterId} />
						</ConfirmDialogProvider>
					</QueryClientProvider>
				</MantineProvider>
			</I18nextProvider>,
		);
		await flushRender();

		// A 5-segment path collapses to one merged folder row plus the file, so the
		// deepest indent stays at a single level instead of four. Expand first —
		// folders start closed, and the indent being measured is the file's.
		rowByLabel(container, "Expand folder frontend/components/chapter/deep/nested").dispatchEvent(
			new Event("click", { bubbles: true }),
		);
		await flushRender();

		expect(rowLabels(container)).toEqual([
			"Collapse folder frontend/components/chapter/deep/nested",
			"View diff of frontend/components/chapter/deep/nested/leaf.ts",
		]);

		const indents = Array.from(container.querySelectorAll('[role="button"][aria-label]'))
			.filter((row) =>
				/^(Collapse folder|View diff of) /.test(row.getAttribute("aria-label") ?? ""),
			)
			.map((row) => (row as HTMLElement).style.paddingLeft);
		// Mantine rewrites numeric padding to scaled rem, so compare the rem values.
		expect(indents).toEqual([
			"calc(0.25rem * var(--mantine-scale))",
			"calc(1rem * var(--mantine-scale))",
		]);

		queryClient.clear();
	});

	test("handles write and AI actions without crashing", async () => {
		const chapterId = "chapter-git-interactive-smoke";
		const calls: Array<{ name: string; body?: unknown }> = [];
		stubInteractiveGitApi(calls);
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
				mutations: { retry: false },
			},
		});
		queryClient.setQueryData(["gitStatus", chapterId], makeStatus());

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		root.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider>
					<QueryClientProvider client={queryClient}>
						<ConfirmDialogProvider>
							<GitPanel chapterId={chapterId} />
						</ConfirmDialogProvider>
					</QueryClientProvider>
				</MantineProvider>
			</I18nextProvider>,
		);
		await flushRender();

		buttonByText(container, "Stage All").dispatchEvent(new Event("click", { bubbles: true }));
		await flushRender();
		buttonByLabel(container, "AI Generate").dispatchEvent(new Event("click", { bubbles: true }));
		await flushRender();

		expect(calls).toEqual([{ name: "stage", body: { all: true } }, { name: "ai" }]);
		expect(container.querySelector("input")?.value).toBe("fix: update file");

		queryClient.clear();
	});

	function readyWorkspace(overrides: Partial<GitWorkspace> = {}): GitWorkspace {
		return {
			workspaceKey: "local:/repo",
			repositoryKey: "local:/repo/.git",
			deviceId: "local",
			cwd: "/repo/sub",
			rootPath: "/repo",
			state: "ready",
			capabilities: { read: true, write: true },
			...overrides,
		};
	}

	async function workspaceAct(work: () => void | Promise<void>) {
		const previous = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
		Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
			configurable: true,
			writable: true,
			value: true,
		});
		try {
			await act(work);
		} finally {
			if (previous) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
			else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
		}
	}

	async function waitForWorkspace(predicate: () => boolean) {
		const deadline = performance.now() + 1500;
		while (!predicate()) {
			if (performance.now() > deadline) throw new Error("Workspace UI did not settle");
			await workspaceAct(async () => {
				await flushRender();
			});
		}
	}

	async function renderNarratorWorkspace(initial: GitWorkspace) {
		let workspace = initial;
		let revision = 1;
		const context = (): WorkspaceContext => ({
			contextKey: `context-${revision}`,
			revision,
			deviceId: workspace.deviceId,
			cwd: workspace.cwd,
			pathFlavor: "posix",
			capabilities: { switchDirectory: true },
			...(workspace.workspaceKey && workspace.repositoryKey && workspace.rootPath
				? {
						git: {
							workspaceKey: workspace.workspaceKey,
							repositoryKey: workspace.repositoryKey,
							rootPath: workspace.rootPath,
						},
					}
				: {}),
		});
		const calls: Array<{ name: string; target?: GitTarget }> = [];
		const original = {
			getGitWorkspace: api.getGitWorkspace,
			getWorkspaceContext: api.getWorkspaceContext,
			getGitStatus: api.getGitStatus,
			getGitModifications: api.getGitModifications,
			getGitDiff: api.getGitDiff,
			gitStage: api.gitStage,
			gitDiscard: api.gitDiscard,
			gitAiCommitMessage: api.gitAiCommitMessage,
			getGitLog: api.getGitLog,
			getGitStashList: api.getGitStashList,
		};
		api.getGitWorkspace = async () => workspace;
		api.getWorkspaceContext = async () => context();
		api.getGitStatus = async () => makeStatus();
		api.getGitModifications = async () => ({ byFile: [], actors: [], hasMore: false });
		api.getGitDiff = async () => ({ diff: "", truncated: false });
		api.gitStage = async (target) => {
			calls.push({ name: "stage", target });
			return makeStatus();
		};
		api.gitDiscard = async (target) => {
			calls.push({ name: "discard", target });
			return makeStatus();
		};
		api.gitAiCommitMessage = async (target) => {
			calls.push({ name: "ai", target });
			return { message: "old workspace draft" };
		};
		api.getGitLog = async () => [];
		api.getGitStashList = async () => [];
		restoreGitApi = () => Object.assign(api, original);
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
				mutations: { retry: false },
			},
		});
		const narratorId = "standalone-workspace";
		queryClient.setQueryData(["narrators", narratorId], {
			id: narratorId,
			cwd: "/repo/sub",
			chapterId: null,
			contextProjectId: "project-context",
			workspaceRevision: revision,
		});
		queryClient.setQueryData(["workspaceContext", narratorId], context());
		const workspaceQueryKey = ["gitWorkspace", narratorId, revision];
		queryClient.setQueryData(workspaceQueryKey, workspace);
		if (workspace.workspaceKey)
			queryClient.setQueryData(["gitStatus", workspace.workspaceKey], makeStatus());
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await workspaceAct(async () =>
			root?.render(
				<I18nextProvider i18n={i18n}>
					<MantineProvider env="test">
						<QueryClientProvider client={queryClient}>
							<ConfirmDialogProvider>
								<GitPanel narratorId={narratorId} />
							</ConfirmDialogProvider>
						</QueryClientProvider>
					</MantineProvider>
				</I18nextProvider>,
			),
		);
		await waitForWorkspace(() =>
			initial.state === "ready"
				? container.textContent?.includes("Changes") === true
				: container.textContent?.includes(i18n.t(`git:workspace.${initial.state}`)) === true,
		);
		return {
			container,
			queryClient,
			calls,
			async update(next: GitWorkspace) {
				await workspaceAct(async () => {
					workspace = next;
					revision++;
					if (next.workspaceKey)
						queryClient.setQueryData(["gitStatus", next.workspaceKey], makeStatus());
					queryClient.setQueryData(["gitWorkspace", narratorId, revision], next);
					queryClient.setQueryData(["workspaceContext", narratorId], context());
					queryClient.setQueryData(
						["narrators", narratorId],
						(old: Record<string, unknown> | undefined) => ({ ...old, workspaceRevision: revision }),
					);
				});
			},
		};
	}

	test("mounted Git queries do not schedule interval polling", async () => {
		const { queryClient } = await renderNarratorWorkspace(readyWorkspace());
		const queries = queryClient
			.getQueryCache()
			.getAll()
			.filter((query) => String(query.queryKey[0]).startsWith("git"));
		expect(queries.length).toBeGreaterThan(0);
		for (const query of queries) {
			for (const observer of query.observers) {
				const interval = observer.options.refetchInterval;
				if (typeof interval === "function") expect(interval(query)).toBe(false);
				else expect(interval).toBeUndefined();
			}
		}
		queryClient.clear();
	});

	test("standalone narrator with context project exposes the full workspace panel", async () => {
		const { container, queryClient, calls } = await renderNarratorWorkspace(readyWorkspace());
		// The compact SCM layout no longer spends permanent vertical space on device,
		// cwd and repository-path diagnostics; those remain available from workspace
		// errors and the existing backend scope used by destructive confirmations.
		expect(container.textContent).not.toContain("Git root: /repo");
		expect(container.textContent).not.toContain("Working directory: /repo/sub");
		expect(container.textContent).toContain("Changes");
		expect(container.textContent).toContain("Tree");
		expect(container.textContent).toContain("List");
		await workspaceAct(async () => buttonByText(container, "Stage All").click());
		await waitForWorkspace(() => calls.some((call) => call.name === "stage"));
		expect(calls[0]?.target).toMatchObject({
			narratorId: "standalone-workspace",
			workspaceKey: "local:/repo",
		});
		expect(container.textContent).not.toContain("Git root:");
		queryClient.clear();
	});

	for (const state of [
		"not_git",
		"missing_directory",
		"git_unavailable",
		"access_denied",
		"device_offline",
		"unsupported",
	] as const) {
		test(`unavailable ${state} explains failure rather than showing a clean tree`, async () => {
			const { container, queryClient } = await renderNarratorWorkspace(
				readyWorkspace({
					state,
					workspaceKey: null,
					rootPath: null,
					capabilities: { read: false, write: false },
				}),
			);
			expect(container.textContent).toContain(i18n.t(`git:workspace.${state}`));
			expect(container.textContent).not.toContain("Working tree clean");
			expect(buttonByText(container, "Refresh")).toBeTruthy();
			queryClient.clear();
		});
	}

	test("read-only workspace keeps status and diff but disables write actions", async () => {
		const { container, queryClient, calls } = await renderNarratorWorkspace(
			readyWorkspace({ capabilities: { read: true, write: false } }),
		);
		expect(container.textContent).toContain("Read-only workspace");
		for (const label of ["Stage All", "Unstage All", "Discard All"])
			expect(buttonByText(container, label).hasAttribute("disabled")).toBe(true);
		expect(
			Array.from(container.querySelectorAll("button"))
				.find((button) => button.textContent?.startsWith("Commit"))
				?.hasAttribute("disabled"),
		).toBe(true);
		expect(buttonByLabel(container, "AI Generate").hasAttribute("disabled")).toBe(true);
		expect(calls).toEqual([]);
		queryClient.clear();
	});

	test("workspace switch closes old confirmations and clears unfinished input", async () => {
		const { container, queryClient, calls, update } = await renderNarratorWorkspace(
			readyWorkspace(),
		);
		await workspaceAct(async () => buttonByLabel(container, "AI Generate").click());
		await waitForWorkspace(() => container.querySelector("input")?.value === "old workspace draft");
		expect(container.querySelector("input")?.value).toBe("old workspace draft");
		await workspaceAct(async () => buttonByText(container, "Discard All").click());
		await waitForWorkspace(
			() => document.body.textContent?.includes("permanently discard") === true,
		);
		expect(document.body.textContent).toContain("permanently discard");
		await update(
			readyWorkspace({ workspaceKey: "remote:/repo", deviceId: "remote", rootPath: "/repo" }),
		);
		await waitForWorkspace(
			() =>
				container.querySelector("input")?.value === "" &&
				!document.body.textContent?.includes("permanently discard"),
		);
		expect(container.querySelector("input")?.value).toBe("");
		expect(document.body.textContent).not.toContain("permanently discard");
		expect(calls.filter((call) => call.name === "discard")).toHaveLength(0);
		queryClient.clear();
	});

	test("permission revocation drops private facts and unmount releases its listener", async () => {
		const add = spyOn(narratorWSManager, "addListener");
		const remove = spyOn(narratorWSManager, "removeListener");
		try {
			const { container, queryClient } = await renderNarratorWorkspace(readyWorkspace());
			const subscription = add.mock.calls.find(([options]) =>
				options.types?.includes("narrator_access_changed"),
			);
			expect(subscription).toBeDefined();
			api.getGitWorkspace = async () =>
				readyWorkspace({ state: "access_denied", capabilities: { read: false, write: false } });
			await workspaceAct(async () => {
				subscription?.[1]({ type: "narrator_access_changed", narratorId: "standalone-workspace" });
			});
			await waitForWorkspace(() => container.textContent?.includes("do not have access") === true);
			expect(container.textContent).toContain("do not have access");
			expect(queryClient.getQueryData(["gitStatus", "local:/repo"])).toBeUndefined();
			root?.unmount();
			root = undefined;
			expect(remove).toHaveBeenCalled();
			queryClient.clear();
		} finally {
			add.mockRestore();
			remove.mockRestore();
		}
	});

	test("migrates chapter view preferences only when the server confirms the same worktree", async () => {
		sessionStorage.setItem(
			"narrafork_git_expanded_folders",
			JSON.stringify({ legacy: { staged: ["src"], unstaged: ["src"] } }),
		);
		sessionStorage.setItem("narrafork_git_status_filter", JSON.stringify({ legacy: ["M"] }));
		const { container, queryClient, update } = await renderNarratorWorkspace(
			readyWorkspace({ chapterId: "legacy" }),
		);
		await flushRender();
		expect(
			JSON.parse(sessionStorage.getItem("narrafork_git_expanded_folders") ?? "{}")["local:/repo"]
				.staged,
		).toEqual(["src"]);
		expect(JSON.parse(sessionStorage.getItem("narrafork_git_status_filter") ?? "{}")).toEqual({
			"local:/repo": ["M"],
		});
		buttonByLabel(container, "Clear filter").click();
		await flushRender();
		await update(
			readyWorkspace({ chapterId: "legacy", capabilities: { read: true, write: false } }),
		);
		await flushRender();
		await flushRender();
		expect(JSON.parse(sessionStorage.getItem("narrafork_git_status_filter") ?? "{}")).toEqual({});
		queryClient.clear();
	});

	test("an explicit cwd in another repository does not import the old chapter preferences", async () => {
		sessionStorage.setItem("narrafork_git_status_filter", JSON.stringify({ legacy: ["D"] }));
		const { container, queryClient } = await renderNarratorWorkspace(readyWorkspace());
		expect(container.textContent).not.toContain("No files match");
		expect(JSON.parse(sessionStorage.getItem("narrafork_git_status_filter") ?? "{}")).toEqual({
			legacy: ["D"],
		});
		queryClient.clear();
	});

	test("workspace cache shares roots, isolates devices, and refreshes repository peers", () => {
		const qc = new QueryClient();
		const target = {
			narratorId: "n1",
			workspaceKey: "local:/repo",
			repositoryKey: "common",
			canWrite: true,
		};
		expect(gitTargetKey({ ...target, narratorId: "n2" })).toBe(gitTargetKey(target));
		expect(gitTargetKey({ ...target, workspaceKey: "remote:/repo" })).not.toBe(
			gitTargetKey(target),
		);
		qc.setQueryData(
			["gitWorkspace", "n2"],
			readyWorkspace({ workspaceKey: "local:/worktree", repositoryKey: "common" }),
		);
		for (const key of ["local:/repo", "local:/worktree", "remote:/repo"]) {
			for (const prefix of ["gitStatus", "gitModifications", "gitDiff", "gitLog", "gitStashList"])
				qc.setQueryData([prefix, key], { data: true });
		}
		invalidateWorkspaceQueries(qc, target);
		for (const prefix of ["gitStatus", "gitModifications", "gitDiff", "gitLog", "gitStashList"]) {
			expect(qc.getQueryState([prefix, "local:/repo"])?.isInvalidated).toBe(true);
			expect(qc.getQueryState([prefix, "local:/worktree"])?.isInvalidated).toBe(true);
			expect(qc.getQueryState([prefix, "remote:/repo"])?.isInvalidated).toBe(false);
		}
		qc.clear();
	});

	const LONG_BRANCH = "chapter/very-long-branch-name-Bo_bRv";

	/** Mount the panel with `gitStatus` pre-seeded for a branch. */
	async function renderWithBranch(chapterId: string, branch: string) {
		const status = makeStatus();
		status.branch = branch;
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
				mutations: { retry: false },
			},
		});
		queryClient.setQueryData(["gitStatus", chapterId], status);

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		root.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider>
					<QueryClientProvider client={queryClient}>
						<ConfirmDialogProvider>
							<GitPanel chapterId={chapterId} />
						</ConfirmDialogProvider>
					</QueryClientProvider>
				</MantineProvider>
			</I18nextProvider>,
		);
		await flushRender();
		return { container, queryClient };
	}

	/**
	 * The header answers "which branch am I staging into". It reads the SAME
	 * `gitStatus` query the Changes tab already fetches, so seeding that key is all
	 * the setup it needs — if it ever grows its own request, this test keeps
	 * passing while a second round-trip appears, so the assertion below on the copy
	 * payload is the part that matters: it must be the full branch name, not the
	 * truncated text the row displays.
	 *
	 * This covers the Clipboard API branch (secure context). The plain-http fallback
	 * is a separate path and gets its own test below.
	 */
	test("shows the branch in the changes toolbar and copies the full name on click", async () => {
		const copied: string[] = [];
		// A SECURE context has to be stated, not assumed: sibling clipboard suites
		// pin `isSecureContext: false` onto linkedom's shared prototypes, and
		// `canUseClipboardApi` bails on that — leaving this test silently exercising
		// the fallback instead of the branch it names.
		Object.defineProperty(globalThis.window, "isSecureContext", {
			value: true,
			configurable: true,
		});
		Object.defineProperty(globalThis.navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (text: string) => {
					copied.push(text);
				},
			},
		});

		const { container, queryClient } = await renderWithBranch(
			"chapter-git-branch-header",
			LONG_BRANCH,
		);

		expect(container.textContent).toContain(LONG_BRANCH);
		// The compact header keeps the branch identity but removes the permanent HEAD
		// hash from the narrow panel.
		expect(container.textContent).not.toContain("abc1234");

		buttonByLabel(container, "Copy branch name").dispatchEvent(
			new Event("click", { bubbles: true }),
		);
		await flushRender();

		expect(copied).toEqual([LONG_BRANCH]);

		queryClient.clear();
	});

	/**
	 * The same button on a plain-http deployment, where `navigator.clipboard` is
	 * absent and `copyTextToClipboard` falls back to a selected form control plus
	 * `execCommand`. NarraFork is built for small-team private hosting, so LAN http
	 * is a first-class deployment and this is the branch those users actually run —
	 * yet a test that installs `navigator.clipboard` never reaches it, and a failure
	 * here is silent: the icon still flips to the check mark (the promise resolves as
	 * long as nothing throws) while the clipboard holds nothing.
	 */
	test("copies the branch through the plain-http fallback too", async () => {
		const copied = installLegacyClipboard();

		const { container, queryClient } = await renderWithBranch(
			"chapter-git-branch-header-legacy",
			LONG_BRANCH,
		);

		buttonByLabel(container, "Copy branch name").dispatchEvent(
			new Event("click", { bubbles: true }),
		);
		await flushRender();

		expect(copied).toEqual([LONG_BRANCH]);
		// The throwaway control must not survive the copy, or it would accumulate in
		// the document on every click.
		expect(document.querySelectorAll('input[aria-hidden="true"]').length).toBe(0);

		queryClient.clear();
	});

	test("switches between the compact tree and flat file list", async () => {
		const chapterId = "chapter-git-view-mode";
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
				mutations: { retry: false },
			},
		});
		queryClient.setQueryData(["gitStatus", chapterId], makeStatus());

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		root.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider>
					<QueryClientProvider client={queryClient}>
						<ConfirmDialogProvider>
							<GitPanel chapterId={chapterId} />
						</ConfirmDialogProvider>
					</QueryClientProvider>
				</MantineProvider>
			</I18nextProvider>,
		);
		await flushRender();

		expect(rowLabels(container)).toEqual(["Expand folder src", "Expand folder src"]);
		buttonByText(container, "List").click();
		await flushRender();
		expect(rowLabels(container)).toEqual([
			"View diff of src/staged.ts",
			"View diff of src/unstaged.ts",
			"View diff of src/new-file.ts",
		]);
		expect(JSON.parse(localStorage.getItem("narrafork_git_view_mode") ?? "{}")[chapterId]).toBe(
			"flat",
		);

		root?.unmount();
		root = undefined;
		const remountedContainer = document.createElement("div");
		document.body.appendChild(remountedContainer);
		root = createRoot(remountedContainer);
		root.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider>
					<QueryClientProvider client={queryClient}>
						<ConfirmDialogProvider>
							<GitPanel chapterId={chapterId} />
						</ConfirmDialogProvider>
					</QueryClientProvider>
				</MantineProvider>
			</I18nextProvider>,
		);
		await flushRender();
		expect(rowLabels(remountedContainer)).toEqual([
			"View diff of src/staged.ts",
			"View diff of src/unstaged.ts",
			"View diff of src/new-file.ts",
		]);

		buttonByText(remountedContainer, "Tree").click();
		await flushRender();
		expect(rowLabels(remountedContainer)).toEqual(["Expand folder src", "Expand folder src"]);
		queryClient.clear();
	});
});
