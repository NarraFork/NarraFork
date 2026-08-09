import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { GitStatusSummary } from "../../hooks/useGit";
import { api } from "../../lib/api";
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
		gitStage: api.gitStage,
		gitAiCommitMessage: api.gitAiCommitMessage,
	};
	api.getGitStatus = async () => makeStatus();
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

		expect(container.textContent).toContain("Changes");
		expect(container.textContent).toContain("Staged");
		expect(container.textContent).toContain("Commit");

		// Files are grouped under their folder instead of printing full paths.
		expect(rowLabels(container)).toEqual([
			"Collapse folder src",
			"View diff of src/staged.ts",
			"Collapse folder src",
			"View diff of src/new-file.ts",
			"View diff of src/unstaged.ts",
		]);
		expect(container.textContent).toContain("staged.ts");
		expect(container.textContent).toContain("unstaged.ts");
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

		// Folder-level stage covers both unstaged files under src/. The folder row reuses
		// the file wording, so scope the lookup to the row itself.
		const stageFolderRow = Array.from(
			container.querySelectorAll('[role="button"][aria-label="Collapse folder src"]'),
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

		// Collapsing hides that folder's children but leaves the staged section alone.
		stageFolderRow.dispatchEvent(new Event("click", { bubbles: true }));
		await flushRender();

		expect(rowLabels(container)).toEqual([
			"Collapse folder src",
			"View diff of src/staged.ts",
			"Expand folder src",
		]);

		rowByLabel(container, "Expand folder src").dispatchEvent(new Event("click", { bubbles: true }));
		await flushRender();
		expect(rowLabels(container)).toHaveLength(5);

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

		const folderRow = rowByLabel(container, "Collapse folder src");
		// Expanded folder → open-folder glyph, next to the chevron that shows state.
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

		// Collapsing swaps to the closed glyph, so the state reads without the chevron.
		folderRow.dispatchEvent(new Event("click", { bubbles: true }));
		await flushRender();
		const collapsed = rowByLabel(container, "Expand folder src");
		expect(collapsed.querySelector(".tabler-icon-folder")).not.toBeNull();
		expect(collapsed.querySelector(".tabler-icon-folder-open")).toBeNull();

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
		// deepest indent stays at a single level instead of four.
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
});
