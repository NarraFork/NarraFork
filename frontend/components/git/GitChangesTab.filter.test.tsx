/**
 * GitChangesTab.filter.test.tsx — filtering the changes list by git file status.
 *
 * What these guard, in order of consequence:
 *
 * 1. **Discard must not exceed the visible scope.** With a filter on, "Discard"
 *    sends the matched paths instead of `all: true`. `all` runs
 *    `checkout HEAD -- .` plus `clean -fd` server-side, which destroys
 *    uncommitted work the filter had hidden — an irreversible loss the user had
 *    no way to see coming. The confirmation text has to name the narrowed scope
 *    too, because "all uncommitted changes" is false once a filter is on.
 * 2. **A filter that matches nothing must say so.** Both sections simply stop
 *    rendering, and without an explicit message the panel reads as a clean
 *    working tree while changes are only hidden.
 * 3. **Filtering happens before the row cap**, so a filter over a large change
 *    set cannot spend the row budget on rows it then removes.
 * 4. **Selection survives a remount** (sessionStorage), and is keyed per workspace.
 *
 * The existing GitPanel suite cannot cover any of this: it never touches the
 * filter, so every assertion there runs on the unfiltered path.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { GitStatusSummary } from "../../hooks/useGit";
import { __resetGitFolderPrefsCache } from "../../hooks/useGitFolderPrefs";
import { __resetGitStatusFilterCache } from "../../hooks/useGitStatusFilter";
import { api } from "../../lib/api";
import commonLocale from "../../locales/en/common.json";
import gitLocale from "../../locales/en/git.json";
import type { GitTarget } from "../../lib/api/git";
import { ConfirmDialogProvider } from "../common/ConfirmDialogProvider";

// Isolated i18next instance, same reason as the sibling git suites: they mutate
// the process-global default and would leave this one rendering raw keys.
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
const { GitChangesTab } = await import("./GitChangesTab");

/** A narrator Git target whose query key is `key`. */
function workspaceTarget(key: string): GitTarget {
	return { narratorId: key, workspaceKey: key, canWrite: true };
}

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let root: Root | undefined;
let restoreGitApi: (() => void) | undefined;
const originalGitLineStats = api.getGitLineStats;

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const localStorage = new Map<string, string>();
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

function file(status: string, path: string) {
	return {
		status,
		path,
		linesAdded: 1,
		linesRemoved: 0,
		stagedLinesAdded: status[0] === " " || status[0] === "?" ? 0 : 1,
		stagedLinesRemoved: 0,
		unstagedLinesAdded: status[1] === " " ? 0 : 1,
		unstagedLinesRemoved: 0,
	};
}

/** One file of each kind, spread across both sections. */
function makeMixedStatus(): GitStatusSummary {
	return {
		hasChanges: true,
		staged: 2,
		unstaged: 2,
		untracked: 1,
		files: [
			file("M ", "src/staged-mod.ts"),
			file("D ", "src/staged-del.ts"),
			file(" M", "src/mod.ts"),
			file(" D", "src/del.ts"),
			file("??", "src/new.ts"),
		],
		totalFiles: 5,
		headSha: "abc1234",
		branch: "main",
		linesAdded: 5,
		linesRemoved: 0,
	};
}

function stubGitApi(calls: Array<{ name: string; body?: unknown }>, status: GitStatusSummary) {
	const original = {
		getGitStatus: api.getGitStatus,
		getGitLineStats: api.getGitLineStats,
		gitStage: api.gitStage,
		gitUnstage: api.gitUnstage,
		gitDiscard: api.gitDiscard,
	};
	api.getGitStatus = async () => status;
	api.getGitLineStats = async () => ({
		files: status.files.map((f) => ({ ...f, complete: true })),
		linesAdded: status.linesAdded ?? 0,
		linesRemoved: status.linesRemoved ?? 0,
		complete: true,
	});
	api.gitStage = async (_target, body) => {
		calls.push({ name: "stage", body });
		return status;
	};
	api.gitUnstage = async (_target, body) => {
		calls.push({ name: "unstage", body });
		return status;
	};
	api.gitDiscard = async (_target, body) => {
		calls.push({ name: "discard", body });
		return status;
	};
	restoreGitApi = () => Object.assign(api, original);
}

function makeClient() {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
			mutations: { retry: false },
		},
	});
}

/**
 * Tear down the current tree.
 *
 * A function rather than inline `root?.unmount()`: `renderTab` reassigns `root`
 * from inside a call, which TS's control flow does not track, so an inline
 * sequence narrows `root` to `undefined` after the first teardown.
 */
function unmountTab() {
	root?.unmount();
	root = undefined;
}

function renderTab(workspaceKey: string, client: QueryClient) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const tabRoot = createRoot(container);
	root = tabRoot;
	tabRoot.render(
		<I18nextProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={client}>
					<ConfirmDialogProvider>
						<GitChangesTab target={workspaceTarget(workspaceKey)} />
					</ConfirmDialogProvider>
				</QueryClientProvider>
			</MantineProvider>
		</I18nextProvider>,
	);
	return container;
}

function flushRender() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function click(element: Element) {
	element.dispatchEvent(new Event("click", { bubbles: true }));
	return flushRender();
}

/**
 * Wait for `predicate`, polling instead of flushing a fixed number of times.
 *
 * Mantine's Modal opens through a `Transition`, so the confirm dialog's text is
 * not in the DOM on the tick after the click. A fixed flush count would encode
 * whatever the transition currently costs and break on a Mantine upgrade.
 */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/** The confirm dialog's own button, once the modal has actually opened. */
async function confirmDialogButton(text: string): Promise<HTMLButtonElement> {
	await waitFor(
		() =>
			Array.from(document.body.querySelectorAll("button")).some(
				(candidate) => candidate.textContent?.trim() === text,
			),
		`confirm dialog button "${text}"`,
	);
	const button = Array.from(document.body.querySelectorAll("button")).find(
		(candidate) => candidate.textContent?.trim() === text,
	);
	if (!(button instanceof HTMLButtonElement)) throw new Error(`Confirm button missing: ${text}`);
	return button;
}

/** The filter chips, as `letter → pressed?`. */
function chips(container: HTMLElement): Record<string, boolean> {
	const result: Record<string, boolean> = {};
	for (const chip of Array.from(container.querySelectorAll("[data-git-status-filter]"))) {
		// The chip's own text is `letter count`, e.g. "M 2".
		const letter = (chip.textContent ?? "").trim().split(/\s+/)[0] ?? "";
		result[letter] = chip.getAttribute("aria-pressed") === "true";
	}
	return result;
}

function chipText(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll("[data-git-status-filter]")).map((chip) =>
		(chip.textContent ?? "").replace(/\s+/g, " ").trim(),
	);
}

function chipByLetter(container: HTMLElement, letter: string): Element {
	const chip = Array.from(container.querySelectorAll("[data-git-status-filter]")).find(
		(candidate) => (candidate.textContent ?? "").trim().split(/\s+/)[0] === letter,
	);
	if (!chip) throw new Error(`Filter chip not found: ${letter}`);
	return chip;
}

/** Every folder row currently rendered, so file rows can be revealed. */
async function expandAllFolders(container: HTMLElement) {
	for (const row of Array.from(
		container.querySelectorAll('[role="button"][aria-label^="Expand folder "]'),
	)) {
		await click(row);
	}
}

function fileRowPaths(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll('[role="button"][aria-label^="View diff of "]')).map(
		(row) => (row.getAttribute("aria-label") ?? "").replace("View diff of ", ""),
	);
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
	const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
		candidate.textContent?.includes(text),
	);
	if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${text}`);
	return button;
}

function buttonByLabel(container: HTMLElement, label: string): HTMLButtonElement {
	const button = container.querySelector(`button[aria-label="${label}"]`);
	if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
	return button;
}

describe("GitChangesTab status filter", () => {
	beforeEach(async () => {
		installDom();
		api.getGitLineStats = async () => ({
			files: [],
			linesAdded: 0,
			linesRemoved: 0,
			complete: false,
		});
		// Both preference caches are memoized at module scope, and installDom() hands
		// out a FRESH Map-backed sessionStorage per test: a stale parse would leak one
		// test's filter into the next.
		__resetGitFolderPrefsCache();
		__resetGitStatusFilterCache();
		await initTestI18n();
	});

	afterEach(() => {
		restoreGitApi?.();
		restoreGitApi = undefined;
		api.getGitLineStats = originalGitLineStats;
		if (!root) return;
		root.unmount();
		root = undefined;
	});

	test("slow and failed line stats never delay status rows or disable actions", async () => {
		const client = makeClient();
		const workspaceKey = "git-slow-stats";
		client.setQueryData(["gitStatus", workspaceKey], makeMixedStatus());
		let rejectStats!: (error: Error) => void;
		api.getGitLineStats = () =>
			new Promise((_resolve, reject) => {
				rejectStats = reject;
			});
		const container = renderTab(workspaceKey, client);
		await flushRender();
		await expandAllFolders(container);
		expect(fileRowPaths(container)).toHaveLength(5);
		expect(container.querySelector('[aria-label="Counting lines…"]')).not.toBeNull();
		expect(buttonByText(container, "Stage All").disabled).toBe(false);
		rejectStats(new Error("stats failed"));
		await waitFor(
			() => container.textContent?.includes("Line counts failed") === true,
			"stats failure",
		);
		expect(fileRowPaths(container)).toHaveLength(5);
		expect(buttonByText(container, "Stage All").disabled).toBe(false);
		client.clear();
	});

	test("complete binary measurements may display zero, but missing measurements do not", async () => {
		const client = makeClient();
		const workspaceKey = "git-binary-stats";
		const status = {
			...makeMixedStatus(),
			staged: 0,
			unstaged: 2,
			untracked: 0,
			files: [
				{ status: " M", path: "binary.png" },
				{ status: " M", path: "unknown.png" },
			],
			totalFiles: 2,
		};
		client.setQueryData(["gitStatus", workspaceKey], status);
		client.setQueryData(["gitLineStats", workspaceKey], {
			files: [
				{ path: "binary.png", unstagedLinesAdded: 0, unstagedLinesRemoved: 0, complete: true },
				{ path: "unknown.png", complete: false },
			],
			linesAdded: 0,
			linesRemoved: 0,
			complete: false,
		});
		const container = renderTab(workspaceKey, client);
		await flushRender();
		expect(
			container.querySelector('[aria-label="View diff of binary.png"]')?.textContent,
		).toContain("+0-0");
		expect(
			container.querySelector('[aria-label="View diff of unknown.png"]')?.textContent,
		).not.toMatch(/[+-]0/);
		client.clear();
	});

	test("branch name uses the remaining header space instead of a percentage cap", async () => {
		const workspaceKey = "git-branch-width";
		const client = makeClient();
		const branch = "fix/dashboard-unrestricted-branch-name";
		client.setQueryData(["gitStatus", workspaceKey], { ...makeMixedStatus(), branch });
		const container = renderTab(workspaceKey, client);
		await flushRender();

		// linkedom has no layout engine; verify the rendered flex sizing contract.
		const name = container.querySelector<HTMLElement>(`[title="${branch}"]`);
		expect(name?.textContent).toBe(branch);
		const group = name?.parentElement;
		expect(group?.style.flex).toBe("1");
		expect(group?.style.minWidth).toBe("0");
		expect(group?.style.maxWidth || "").toBe("");
		expect(name?.style.flexShrink).toBe("1");
		client.clear();
	});

	test("offers one chip per kind of change, counting rows and nothing selected", async () => {
		const workspaceKey = "git-filter-chips";
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], makeMixedStatus());
		const container = renderTab(workspaceKey, client);
		await flushRender();

		// Counts are ROWS, not files: `D ` produces a staged D row, ` D` an unstaged
		// one, so D is 2. The untracked file shows as an addition, so A is 1.
		expect(chipText(container)).toEqual(["A 1", "M 2", "D 2"]);
		// Nothing is pre-selected — the panel opens unfiltered.
		expect(chips(container)).toEqual({ A: false, M: false, D: false });

		client.clear();
	});

	test("selecting a letter keeps only its rows, in both sections", async () => {
		const workspaceKey = "git-filter-rows";
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], makeMixedStatus());
		const container = renderTab(workspaceKey, client);
		await flushRender();
		await expandAllFolders(container);

		expect(fileRowPaths(container).sort()).toEqual([
			"src/del.ts",
			"src/mod.ts",
			"src/new.ts",
			"src/staged-del.ts",
			"src/staged-mod.ts",
		]);

		await click(chipByLetter(container, "D"));
		await expandAllFolders(container);

		expect(chips(container)).toEqual({ A: false, M: false, D: true });
		expect(fileRowPaths(container).sort()).toEqual(["src/del.ts", "src/staged-del.ts"]);
		// Section headers report matched/total so the hidden rows are accounted for
		// rather than silently missing.
		expect(container.textContent).toContain("Staged (1/2)");
		expect(container.textContent).toContain("Unstaged (1/3)");

		// A second letter is a union, not a replacement.
		await click(chipByLetter(container, "A"));
		await expandAllFolders(container);
		expect(fileRowPaths(container).sort()).toEqual([
			"src/del.ts",
			"src/new.ts",
			"src/staged-del.ts",
		]);

		client.clear();
	});

	test("a file staged then edited again answers to A in one section and M in the other", async () => {
		// `AM` is the shape a raw-porcelain filter gets wrong: it belongs to both
		// sections with a DIFFERENT letter in each, and filtering on the pair would
		// hide it from both.
		const workspaceKey = "git-filter-am";
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], {
			hasChanges: true,
			staged: 1,
			unstaged: 1,
			untracked: 0,
			files: [file("AM", "src/fresh.ts")],
			totalFiles: 1,
			headSha: "abc1234",
			branch: "main",
			linesAdded: 2,
			linesRemoved: 0,
		} satisfies GitStatusSummary);
		const container = renderTab(workspaceKey, client);
		await flushRender();

		expect(chipText(container)).toEqual(["A 1", "M 1"]);

		await click(chipByLetter(container, "A"));
		await expandAllFolders(container);
		// Only the staged half survives — that is the row whose badge says `A`.
		expect(fileRowPaths(container)).toEqual(["src/fresh.ts"]);
		expect(container.textContent).toContain("Staged (1/1)");
		expect(container.textContent).not.toContain("Unstaged (1/1)");

		client.clear();
	});

	test("MM contributes one row to each section and keeps the shared badge count", async () => {
		const workspaceKey = "git-filter-mm";
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], {
			hasChanges: true,
			staged: 2,
			unstaged: 1,
			untracked: 0,
			files: [file("MM", "src/shared.ts"), file("A ", "src/added.ts")],
			totalFiles: 2,
			headSha: "abc1234",
			branch: "main",
			linesAdded: 2,
			linesRemoved: 0,
		} satisfies GitStatusSummary);
		const container = renderTab(workspaceKey, client);
		await flushRender();

		expect(chipText(container)).toEqual(["A 1", "M 2"]);
		// Section headers own the counts; the toolbar title no longer repeats them.
		// MM appears in both sections but is one changed file overall.
		expect(container.textContent).toContain("Changes");
		expect(container.textContent).toContain("Staged (2)");
		expect(container.textContent).toContain("Unstaged (1)");

		client.clear();
	});

	test("truncated status shows lower-bound counts for both sections", async () => {
		const workspaceKey = "git-filter-truncated";
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], {
			hasChanges: true,
			truncated: true,
			staged: 3,
			unstaged: 2,
			untracked: 1,
			files: [file("M ", "src/staged.ts"), file(" M", "src/worktree.ts")],
			totalFiles: 2,
			headSha: "abc1234",
			branch: "main",
			linesAdded: 2,
			linesRemoved: 0,
		} satisfies GitStatusSummary);
		const container = renderTab(workspaceKey, client);
		await flushRender();

		// Unstaged row count includes untracked files (2 + 1 → 3+).
		expect(container.textContent).toContain("Staged (3+)");
		expect(container.textContent).toContain("Unstaged (3+)");
		expect(container.textContent).toContain("Staged count is a lower bound");
		expect(container.textContent).toContain("Unstaged count is a lower bound");
		client.setQueryData<GitStatusSummary>(
			["gitStatus", workspaceKey],
			(old) =>
				old && {
					...old,
					truncated: false,
					totalFilesExact: false,
				},
		);
		await flushRender();
		expect(container.textContent).toContain("Staged (3+)");
		expect(container.textContent).toContain("Unstaged (3+)");
		expect(container.textContent).toContain("Unstaged count is a lower bound");

		client.clear();
	});

	test("independent partial stats show known rows, never invent zero or sum incomplete folders", async () => {
		const workspaceKey = "git-lightweight";
		const client = makeClient();
		const status: GitStatusSummary = {
			hasChanges: true,
			staged: 0,
			unstaged: 2,
			untracked: 0,
			files: [file(" M", "src/known.ts"), { status: " M", path: "src/unknown.ts" }],
			totalFiles: 2,
			headSha: "abc",
			branch: "main",
		};
		client.setQueryData(["gitStatus", workspaceKey], status);
		client.setQueryData(["gitLineStats", workspaceKey], {
			files: [
				{ path: "src/known.ts", unstagedLinesAdded: 1, unstagedLinesRemoved: 0, complete: true },
			],
			linesAdded: 1,
			linesRemoved: 0,
			complete: false,
		});
		const container = renderTab(workspaceKey, client);
		await flushRender();
		const folder = container.querySelector('[aria-label="Expand folder src"]');
		expect(folder?.textContent).not.toContain("+1");
		expect(container.querySelector('[aria-label="Incomplete line counts"]')).not.toBeNull();
		await expandAllFolders(container);
		const row = (path: string) => container.querySelector(`[aria-label="View diff of ${path}"]`);
		expect(row("src/known.ts")?.textContent).toContain("+1");
		expect(row("src/unknown.ts")?.textContent).not.toMatch(/[+-]0|NaN/);
		// A lightweight status refresh does not erase independently measured rows.
		client.setQueryData(["gitStatus", workspaceKey], {
			...status,
			files: status.files.map(({ status, path }) => ({ status, path })),
		});
		await flushRender();
		expect(row("src/known.ts")?.textContent).toContain("+1");
		client.setQueryData(["gitLineStats", workspaceKey], {
			files: [],
			linesAdded: 0,
			linesRemoved: 0,
			complete: false,
		});
		await flushRender();
		expect(row("src/known.ts")?.textContent).not.toMatch(/[+-]1|[+-]0|NaN/);
		expect(fileRowPaths(container)).toHaveLength(2);
		client.clear();
	});

	test("a list cap with an exact scan does not claim lower-bound section counts", async () => {
		const workspaceKey = "git-exact-capped";
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], {
			hasChanges: true,
			truncated: true,
			totalFilesExact: true,
			staged: 3,
			unstaged: 2,
			untracked: 1,
			files: [
				{ status: "M ", path: "src/staged.ts" },
				{ status: " M", path: "src/worktree.ts" },
			],
			totalFiles: 6,
			headSha: "abc",
			branch: "main",
		} satisfies GitStatusSummary);
		const container = renderTab(workspaceKey, client);
		await flushRender();
		expect(container.textContent).toContain("Staged (3)");
		expect(container.textContent).toContain("Unstaged (3)");
		expect(container.textContent).not.toContain("lower bound");
		expect(container.textContent).toContain("some files are not shown");
		client.clear();
	});

	test("a filter matching nothing says so instead of looking like a clean tree", async () => {
		const workspaceKey = "git-filter-empty";
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], {
			hasChanges: true,
			staged: 0,
			unstaged: 1,
			untracked: 0,
			files: [file(" M", "src/mod.ts")],
			totalFiles: 1,
			headSha: "abc1234",
			branch: "main",
			linesAdded: 1,
			linesRemoved: 0,
		} satisfies GitStatusSummary);
		const container = renderTab(workspaceKey, client);
		await flushRender();

		// Only one kind of change exists, so the bar stays hidden: a filter that can
		// only show everything or nothing is noise.
		expect(chipText(container)).toEqual([]);

		// Reach the same state the storage would: a stale selection for a letter no
		// row has anymore.
		window.sessionStorage.setItem(
			"narrafork_git_status_filter",
			JSON.stringify({ [workspaceKey]: ["D"] }),
		);
		__resetGitStatusFilterCache();
		unmountTab();
		const second = makeClient();
		second.setQueryData(["gitStatus", workspaceKey], {
			hasChanges: true,
			staged: 0,
			unstaged: 1,
			untracked: 0,
			files: [file(" M", "src/mod.ts")],
			totalFiles: 1,
			headSha: "abc1234",
			branch: "main",
			linesAdded: 1,
			linesRemoved: 0,
		} satisfies GitStatusSummary);
		const container2 = renderTab(workspaceKey, second);
		await flushRender();

		// The list is empty, so the panel has to explain why — and the selected letter
		// keeps its chip even with zero rows, or nothing on screen could undo it.
		expect(container2.textContent).toContain("No files match the selected statuses");
		expect(fileRowPaths(container2)).toEqual([]);
		expect(chips(container2)).toEqual({ M: false, D: true });

		// Clearing restores the full list.
		await click(buttonByText(container2, "Clear filter"));
		await expandAllFolders(container2);
		expect(container2.textContent).not.toContain("No files match the selected statuses");
		expect(fileRowPaths(container2)).toEqual(["src/mod.ts"]);

		client.clear();
		second.clear();
	});

	test("discard is scoped to the filtered files, not to the whole worktree", async () => {
		// The consequential one. `all: true` runs `checkout HEAD -- .` + `clean -fd`
		// server-side, so sending it while rows are hidden destroys work the user
		// could not see. Nothing about the result would reveal the mistake.
		const workspaceKey = "git-filter-discard";
		const calls: Array<{ name: string; body?: unknown }> = [];
		const status = makeMixedStatus();
		stubGitApi(calls, status);
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], status);
		const container = renderTab(workspaceKey, client);
		await flushRender();

		await click(chipByLetter(container, "D"));

		// The label states the narrowed scope, so the button cannot read as "all".
		const discardButton = buttonByText(container, "Discard Filtered");
		await click(discardButton);

		// The confirmation names the count instead of claiming "all uncommitted
		// changes", which is false while a filter is on.
		const confirmButton = await confirmDialogButton("Confirm");
		expect(document.body.textContent).toContain(
			"This will permanently discard changes in the 1 filtered file(s)",
		);
		await click(confirmButton);

		expect(calls).toEqual([{ name: "discard", body: { files: ["src/del.ts"] } }]);

		client.clear();
	});

	test("stage and unstage are scoped to the filtered files too", async () => {
		const workspaceKey = "git-filter-stage";
		const calls: Array<{ name: string; body?: unknown }> = [];
		const status = makeMixedStatus();
		stubGitApi(calls, status);
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], status);
		const container = renderTab(workspaceKey, client);
		await flushRender();

		await click(chipByLetter(container, "M"));

		await click(buttonByText(container, "Stage Filtered"));
		await click(buttonByText(container, "Unstage Filtered"));

		expect(calls).toEqual([
			{ name: "stage", body: { files: ["src/mod.ts"] } },
			{ name: "unstage", body: { files: ["src/staged-mod.ts"] } },
		]);

		client.clear();
	});

	test("without a filter the bulk actions still act on everything", async () => {
		// The narrowing must not leak into the unfiltered case: "Stage All" has to
		// keep sending `all: true`, which also covers files beyond the row cap.
		const workspaceKey = "git-filter-none";
		const calls: Array<{ name: string; body?: unknown }> = [];
		const status = makeMixedStatus();
		stubGitApi(calls, status);
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], status);
		const container = renderTab(workspaceKey, client);
		await flushRender();

		await click(buttonByText(container, "Stage All"));
		await click(buttonByText(container, "Unstage All"));
		expect(calls).toEqual([
			{ name: "stage", body: { all: true } },
			{ name: "unstage", body: { all: true } },
		]);

		// And "Discard All" keeps its own confirmation wording.
		await click(buttonByText(container, "Discard All"));
		const confirmButton = await confirmDialogButton("Confirm");
		expect(document.body.textContent).toContain(
			"This will permanently discard all uncommitted changes",
		);
		await click(confirmButton);
		expect(calls.at(-1)).toEqual({ name: "discard", body: { all: true } });

		client.clear();
	});

	test("filters before the row cap so a filter over many files still shows rows", async () => {
		// Capping first would spend the 80-row budget on rows the filter then drops,
		// leaving an empty list next to a "+N more" that claims otherwise.
		const workspaceKey = "git-filter-cap";
		const files = [
			...Array.from({ length: 120 }, (_, i) => file(" M", `src/mod-${i}.ts`)),
			file(" D", "src/deleted.ts"),
		];
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], {
			hasChanges: true,
			staged: 0,
			unstaged: 121,
			untracked: 0,
			files,
			totalFiles: 121,
			headSha: "abc1234",
			branch: "main",
			linesAdded: 121,
			linesRemoved: 0,
		} satisfies GitStatusSummary);
		const container = renderTab(workspaceKey, client);
		await flushRender();

		await click(chipByLetter(container, "D"));
		await expandAllFolders(container);

		// The deletion sits at index 120, well past the 80-row cap.
		expect(fileRowPaths(container)).toEqual(["src/deleted.ts"]);
		expect(container.textContent).not.toContain("more");

		client.clear();
	});

	test("remembers the selection across a remount, per workspace", async () => {
		const workspaceKey = "git-filter-persist";
		const first = makeClient();
		first.setQueryData(["gitStatus", workspaceKey], makeMixedStatus());
		const container = renderTab(workspaceKey, first);
		await flushRender();

		await click(chipByLetter(container, "D"));
		expect(chips(container).D).toBe(true);

		unmountTab();
		first.clear();

		const second = makeClient();
		second.setQueryData(["gitStatus", workspaceKey], makeMixedStatus());
		const remounted = renderTab(workspaceKey, second);
		await flushRender();
		expect(chips(remounted).D).toBe(true);

		// A different workspace is unfiltered — the selection is keyed per workspace, so
		// one workspace's filter cannot silently hide another's changes.
		unmountTab();
		const other = makeClient();
		other.setQueryData(["gitStatus", "git-filter-persist-other"], makeMixedStatus());
		const otherContainer = renderTab("git-filter-persist-other", other);
		await flushRender();
		expect(chips(otherContainer)).toEqual({ A: false, M: false, D: false });

		second.clear();
		other.clear();
	});

	test("toggling a chip off restores the full list", async () => {
		const workspaceKey = "git-filter-toggle-off";
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], makeMixedStatus());
		const container = renderTab(workspaceKey, client);
		await flushRender();

		await click(chipByLetter(container, "M"));
		await expandAllFolders(container);
		expect(fileRowPaths(container).sort()).toEqual(["src/mod.ts", "src/staged-mod.ts"]);

		await click(chipByLetter(container, "M"));
		await expandAllFolders(container);
		expect(fileRowPaths(container).length).toBe(5);
		// Back to the plain counts, and the clear button is gone with the filter.
		expect(container.textContent).toContain("Staged (2)");
		expect(container.querySelector('button[aria-label="Clear filter"]')).toBeNull();

		client.clear();
	});

	test("the leading filter icon doubles as the clear control", async () => {
		// A SEPARATE clear button used to appear next to the chips while filtering.
		// It was taller than the chips, so the whole bar changed height on every
		// toggle — the regression this guards. The contract now: the bar holds the
		// chips plus exactly ONE icon button, and only that button's state changes.
		const workspaceKey = "git-filter-clear-icon";
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], makeMixedStatus());
		const container = renderTab(workspaceKey, client);
		await flushRender();

		const bar = () => {
			const group = container.querySelector('[role="group"][aria-label="Filter by file status"]');
			if (!group) throw new Error("Filter bar missing");
			return group;
		};
		const barButtonCount = () => bar().querySelectorAll("button").length;

		// Inactive: one disabled indicator icon, no clear button anywhere.
		expect(barButtonCount()).toBe(4); // 3 chips + 1 icon slot
		expect(container.querySelector('button[aria-label="Clear filter"]')).toBeNull();
		expect(buttonByLabel(container, "Filter by file status").disabled).toBe(true);

		await click(chipByLetter(container, "A"));
		// Same button count — nothing was appended — and the icon slot became the
		// clear control.
		expect(barButtonCount()).toBe(4);
		expect(buttonByLabel(container, "Clear filter").disabled).toBe(false);

		await click(buttonByLabel(container, "Clear filter"));
		expect(chips(container)).toEqual({ A: false, M: false, D: false });
		expect(barButtonCount()).toBe(4);

		client.clear();
	});
});
