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
 * 3. **Filtering covers the complete snapshot**, so matches beyond the first page
 *    remain available without loading unrelated files.
 * 4. **Selection survives a remount** (sessionStorage), and is keyed per workspace.
 *
 * The existing GitPanel suite cannot cover any of this: it never touches the
 * filter, so every assertion there runs on the unfiltered path.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { GitStatusSummary } from "../../hooks/useGit";
import { __resetGitFolderPrefsCache } from "../../hooks/useGitFolderPrefs";
import { __resetGitStatusFilterCache } from "../../hooks/useGitStatusFilter";
import { api } from "../../lib/api";
import { ApiError } from "../../lib/api/client";
import type { GitTarget } from "../../lib/api/git";
import commonLocale from "../../locales/en/common.json";
import gitLocale from "../../locales/en/git.json";
import { ConfirmDialogProvider } from "../common/ConfirmDialogProvider";
import { __setGitChangesWorkerFactory, type GitChangesWorkerPort } from "./git-changes-list-client";
import { GIT_CHANGES_ROW_HEIGHT, type GitChangesListWindow } from "./git-changes-list-model";
import {
	createGitChangesTestQueryClient,
	flushGitChangesTestRender,
	gitChangesFixtureCache,
	gitChangesFixturePage,
	installGitChangesTestTransport,
	TestGitChangesWorker,
} from "./git-changes-list-test-fixture";
import type {
	GitChangesWorkerRequest,
	GitChangesWorkerResponse,
} from "./git-changes-list-worker-protocol";

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
mock.module("./GitChangesTab.module.css", () => ({
	default: { refreshing: "git-changes-refreshing-icon" },
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
let restoreChangesTransport: (() => void) | undefined;
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
	const client = createGitChangesTestQueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
			mutations: { retry: false },
		},
	});
	client.setQueryData(["auth", "me"], { id: "fixture-alice" });
	return client;
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

function renderTarget(target: GitTarget | null, client: QueryClient, onRefresh?: () => void) {
	root?.render(
		<I18nextProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={client}>
					<ConfirmDialogProvider>
						{target && <GitChangesTab target={target} onRefresh={onRefresh} />}
					</ConfirmDialogProvider>
				</QueryClientProvider>
			</MantineProvider>
		</I18nextProvider>,
	);
}
function renderTab(workspaceKey: string, client: QueryClient, onRefresh?: () => void) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	renderTarget(workspaceTarget(workspaceKey), client, onRefresh);
	return container;
}

function flushRender() {
	return flushGitChangesTestRender();
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

function changesTitle(container: HTMLElement): string | null | undefined {
	return container.querySelector("[data-git-file-count]")?.textContent;
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
	// Each configuration acknowledgement can replace the virtual window. Resolve
	// the next row from the current DOM rather than clicking a detached old frame.
	for (let turn = 0; turn < 30; turn++) {
		const row = container.querySelector('[role="button"][aria-label^="Expand folder "]');
		if (!row) return;
		await click(row);
	}
	throw new Error("Folder expansion did not settle");
}

function fileRowPaths(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll('[role="button"][aria-label^="View diff of "]')).map(
		(row) => (row.getAttribute("aria-label") ?? "").replace("View diff of ", ""),
	);
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
	const buttons = Array.from(container.querySelectorAll("button"));
	const button =
		buttons.find((candidate) => candidate.textContent?.trim() === text) ??
		buttons.find((candidate) => candidate.textContent?.includes(text));
	if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${text}`);
	return button;
}

function buttonByLabel(container: HTMLElement, label: string): HTMLButtonElement {
	const button = container.querySelector(`button[aria-label="${label}"]`);
	if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
	return button;
}

function refreshButton(container: HTMLElement): HTMLButtonElement {
	const button = container.querySelector('[data-testid="git-changes-refresh"]');
	if (!(button instanceof HTMLButtonElement)) throw new Error("Refresh button missing");
	return button;
}

function assertRefreshState(container: HTMLElement, refreshing: boolean) {
	const button = refreshButton(container);
	expect(button.getAttribute("aria-label")).toBe("Refresh");
	expect(button.getAttribute("data-refreshing")).toBe(String(refreshing));
	expect(button.disabled).toBe(false);
	const icon = button.querySelector("svg");
	expect(icon).not.toBeNull();
	expect(icon?.classList.contains("git-changes-refreshing-icon")).toBe(refreshing);
	expect(container.querySelector("[data-git-changes-list]")?.getAttribute("aria-busy")).toBe(
		String(refreshing),
	);
	const status = container.querySelector('[role="status"].mantine-VisuallyHidden-root');
	if (refreshing) expect(status?.textContent).toBe(gitLocale["pages.refreshing"]);
	else expect(status).toBeNull();
}

function assertRangeFooter(container: HTMLElement, buttonText: string) {
	const footer = container.querySelector<HTMLElement>('[data-testid="git-changes-range-controls"]');
	const viewport = container.querySelector<HTMLElement>("[data-git-changes-list]");
	if (!footer || !viewport) throw new Error("Range footer or Git scroll viewport missing");
	expect(viewport.contains(footer)).toBe(false);
	const scrollArea = viewport.closest(".mantine-ScrollArea-root");
	if (!scrollArea) throw new Error("Git ScrollArea missing");
	expect(scrollArea.contains(footer)).toBe(false);
	expect(scrollArea.nextElementSibling).toBe(footer);
	expect(footer.style.getPropertyValue("--group-justify")).toBe("center");
	expect(footer.style.flexShrink).toBe("0");
	return buttonByText(footer, buttonText);
}

function holdNextStatusPage(filter = "") {
	const readPage = api.getGitStatusPage;
	let pending = false;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	api.getGitStatusPage = async (target, query, signal) => {
		if (query?.cursor && (query.filter ?? []).join("") === filter && !pending) {
			pending = true;
			await gate;
			signal?.throwIfAborted();
		}
		return readPage(target, query, signal);
	};
	return { release, pending: () => pending };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}
class ControlledGitChangesWorker extends TestGitChangesWorker {
	private pending: GitChangesWorkerRequest[] = [];
	private paused = false;
	appendPending = false;
	holdAppend = true;
	holdConfigure = false;
	configurePending = false;
	holdScopes = false;
	scopePending = false;
	postMessage(request: GitChangesWorkerRequest) {
		if (request.type === "scope" && this.holdScopes) this.scopePending = true;
		if (request.type === "append" && this.holdAppend) {
			this.paused = true;
			this.appendPending = true;
		}
		if (request.type === "configure" && this.holdConfigure) {
			this.paused = true;
			this.configurePending = true;
		}
		if (this.paused || (request.type === "scope" && this.holdScopes)) {
			this.pending.push(request);
			return;
		}
		super.postMessage(request);
	}
	release() {
		this.paused = false;
		this.holdAppend = false;
		this.holdConfigure = false;
		this.configurePending = false;
		this.holdScopes = false;
		for (const request of this.pending.splice(0)) super.postMessage(request);
	}
}

describe("GitChangesTab status filter", () => {
	beforeEach(async () => {
		installDom();
		restoreChangesTransport = installGitChangesTestTransport();
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
		restoreChangesTransport?.();
		restoreChangesTransport = undefined;
		restoreGitApi?.();
		restoreGitApi = undefined;
		api.getGitLineStats = originalGitLineStats;
		if (!root) return;
		root.unmount();
		root = undefined;
	});

	test.each([
		"complete",
		"paging",
		"partial",
		"expired",
	] as const)("%s directory count stays truthful through held expansion and collapse without authorizing actions", async (kind) => {
		const workspaceKey = `git-count-configure-${kind}`;
		const status = makeMixedStatus();
		if (kind === "paging") {
			Object.assign(status, {
				staged: 0,
				unstaged: 161,
				untracked: 0,
				totalFiles: 161,
				files: Array.from({ length: 161 }, (_, index) => file(" M", `src/file-${index}.ts`)),
			});
		}
		if (kind === "partial") status.truncated = true;
		const actions: Array<{ name: string; body?: unknown }> = [];
		stubGitApi(actions, status);
		const worker = new ControlledGitChangesWorker();
		worker.holdAppend = false;
		__setGitChangesWorkerFactory(() => worker);
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], status);
		const pageApi = api.getGitStatusPage;
		let pageCalls = 0;
		api.getGitStatusPage = async (...args) => {
			pageCalls++;
			const page = await pageApi(...args);
			return kind === "expired" ? { ...page, expiresAt: Date.now() - 1 } : page;
		};
		const heldPage = kind === "paging" ? holdNextStatusPage() : undefined;
		const container = renderTab(workspaceKey, client);
		const directory = () =>
			Array.from(container.querySelectorAll('[data-git-row-type="directory"]')).find((row) =>
				row.querySelector('button[aria-label="Stage"]'),
			);
		const badge = () => directory()?.querySelector(".mantine-Badge-root");
		const action = () =>
			directory()?.querySelector<HTMLButtonElement>('button[aria-label="Stage"]');
		const expected = kind === "paging" ? "100+" : kind === "complete" ? "3" : "3+";
		await waitFor(() => badge()?.textContent === expected, "settled directory count");
		await flushRender();
		const sections = () =>
			Array.from(container.querySelectorAll("[data-git-section-count]")).map(
				(node) => node.textContent,
			);
		const initialSections = sections();
		const initialPages = pageCalls;
		for (const expanded of [true, false]) {
			worker.holdConfigure = true;
			const toggle = directory()?.querySelector("[aria-expanded]");
			if (!toggle) throw new Error("Directory toggle missing");
			await click(toggle);
			expect(worker.configurePending).toBe(true);
			expect(badge()?.textContent).toBe(expected);
			expect(badge()?.getAttribute("title")).toBe(
				kind === "complete" ? null : gitLocale["pages.refreshing"],
			);
			expect(action()?.disabled).toBe(true);
			expect(actions).toEqual([]);
			expect(sections()).toEqual(initialSections);
			expect(pageCalls).toBe(initialPages);
			worker.release();
			await waitFor(
				() =>
					directory()?.querySelector("[aria-expanded]")?.getAttribute("aria-expanded") ===
					String(expanded),
				"configuration acknowledged",
			);
			expect(badge()?.textContent).toBe(expected);
			expect(action()?.disabled).toBe(kind !== "complete");
		}
		heldPage?.release();
		await flushRender();
		client.clear();
	});

	test("a complete refresh candidate cannot make retained directory counts exact before display handoff", async () => {
		const workspaceKey = "git-count-candidate-display";
		const status = makeMixedStatus();
		const actions: Array<{ name: string; body?: unknown }> = [];
		stubGitApi(actions, status);
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], status);
		const container = renderTab(workspaceKey, client);
		const counts = () =>
			Array.from(
				container.querySelectorAll('[data-git-row-type="directory"] .mantine-Badge-root'),
			).map((node) => node.textContent);
		await waitFor(() => counts().join(",") === "2,3", "initial exact displayed counts");
		const statsGate = deferred<void>();
		const nextStatus = {
			...status,
			headSha: "next-head",
			staged: 0,
			unstaged: 7,
			untracked: 0,
			totalFiles: 7,
			files: Array.from({ length: 7 }, (_, index) => file(" M", `src/next-${index}.ts`)),
		};
		api.getGitStatusPage = async (_target, query) => gitChangesFixturePage(nextStatus, query);
		api.getGitStatusPageStats = async (_target, query) => {
			await statsGate.promise;
			return {
				status: "ready",
				cache: gitChangesFixtureCache(),
				snapshotId: query.snapshotId,
				rows: query.rows.map((row) => ({ ...row, complete: false })),
			};
		};
		await click(buttonByLabel(container, "Refresh"));
		await waitFor(
			() => counts().join(",") === "2+,3+",
			"retained display while complete candidate waits for statistics",
		);
		expect(buttonByText(container, "Stage All").disabled).toBe(true);
		expect(actions).toEqual([]);
		statsGate.resolve();
		await waitFor(() => counts().join(",") === "7", "new display count handoff");
		expect(buttonByText(container, "Stage All").disabled).toBe(false);
		client.clear();
	});

	test.each([
		"filter",
		"mode",
		"workspace",
		"read-refusal",
		"write-permission",
	] as const)("pending exact directory presentation respects %s changes and keeps writes disabled", async (change) => {
		const workspaceKey = `git-count-owner-${change}`;
		const status = makeMixedStatus();
		const actions: Array<{ name: string; body?: unknown }> = [];
		stubGitApi(actions, status);
		const worker = new ControlledGitChangesWorker();
		worker.holdAppend = false;
		__setGitChangesWorkerFactory(() => worker);
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], status);
		const container = renderTab(workspaceKey, client);
		const counts = () =>
			Array.from(
				container.querySelectorAll('[data-git-row-type="directory"] .mantine-Badge-root'),
			).map((node) => node.textContent);
		await waitFor(() => counts().join(",") === "2,3", "exact directory counts");
		worker.holdConfigure = true;
		await click(container.querySelector('[aria-label="Expand folder src"]') as Element);
		expect(worker.configurePending).toBe(true);
		expect(counts()).toEqual(["2", "3"]);
		const pageGate = deferred<void>();
		const pageApi = api.getGitStatusPage;
		if (change === "filter" || change === "workspace") {
			api.getGitStatusPage = async (...args) => {
				await pageGate.promise;
				return pageApi(...args);
			};
		}
		if (change === "filter") await click(chipByLetter(container, "M"));
		else if (change === "mode") await click(buttonByText(container, "List"));
		else if (change === "workspace") {
			renderTarget(workspaceTarget("other-workspace"), client);
			await flushRender();
		} else if (change === "read-refusal") {
			api.getGitStatusPageStats = async () => {
				throw new ApiError("Git read refused", 403);
			};
			void client.invalidateQueries({ queryKey: ["gitStatusPageStats", workspaceKey] });
			await waitFor(() => counts().length === 0, "refused directory facts removed");
		} else {
			renderTarget({ ...workspaceTarget(workspaceKey), canWrite: false }, client);
			await flushRender();
		}
		expect(counts()).toEqual(change === "write-permission" ? ["2", "3"] : []);
		expect(
			Array.from(
				container.querySelectorAll<HTMLButtonElement>(
					'[data-git-row-type="directory"] button[aria-label="Stage"], [data-git-row-type="directory"] button[aria-label="Unstage"]',
				),
			).every((button) => button.disabled),
		).toBe(true);
		worker.release();
		await flushRender();
		if (change === "read-refusal" || change === "workspace" || change === "filter")
			expect(counts()).toEqual([]);
		expect(actions).toEqual([]);
		pageGate.resolve();
		await flushRender();
		client.clear();
	});

	test.each([
		"tree",
		"flat",
		"filtered",
	] as const)("%s refresh keeps rows, counts and statistics until the new Worker and measurements agree", async (mode) => {
		const workspaceKey = `git-continuity-${mode}`;
		const status = makeMixedStatus();
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], status);
		const actions: Array<{ name: string; body?: unknown }> = [];
		stubGitApi(actions, status);
		let refreshCallbacks = 0;
		const container = renderTab(workspaceKey, client, () => refreshCallbacks++);
		await flushRender();
		if (mode !== "tree") await click(buttonByText(container, "List"));
		if (mode === "filtered") await click(chipByLetter(container, "M"));
		if (mode === "tree") await expandAllFolders(container);
		await waitFor(
			() =>
				container.querySelector('[data-git-row-type="file"]')?.textContent?.includes("+1") === true,
			"initial measured files",
		);
		const paths = fileRowPaths(container);
		const chipsBefore = chipText(container);
		const titleBefore = mode === "filtered" ? "Changes (2/5)" : "Changes (5)";
		expect(changesTitle(container)).toBe(titleBefore);
		expect(container.textContent).toContain(`+${status.linesAdded}`);
		const fileStats = () =>
			Array.from(container.querySelectorAll('[data-git-row-type="file"]')).map(
				(row) => row.textContent,
			);
		const measuredBefore = fileStats();
		const pageGate = deferred<void>();
		const statsGate = deferred<void>();
		const nextStatus: GitStatusSummary = {
			...status,
			headSha: "new-head",
			staged: 0,
			unstaged: 1,
			untracked: 0,
			totalFiles: 1,
			files: [file(" M", "src/fresh.ts")],
		};
		api.getGitStatusPage = async (_target, query) => {
			await pageGate.promise;
			return gitChangesFixturePage(nextStatus, query);
		};
		const measuredPaths: string[][] = [];
		api.getGitStatusPageStats = async (_target, query) => {
			measuredPaths.push(query.rows.map((row) => row.path));
			await statsGate.promise;
			return {
				status: "ready",
				cache: gitChangesFixtureCache(),
				snapshotId: query.snapshotId,
				rows: query.rows.map((row) => ({ ...row, added: 77, removed: 3, complete: true })),
			};
		};
		let candidateWorker: ControlledGitChangesWorker | undefined;
		__setGitChangesWorkerFactory(() => {
			candidateWorker = new ControlledGitChangesWorker();
			return candidateWorker;
		});
		assertRefreshState(container, false);
		await click(refreshButton(container));
		expect(refreshCallbacks).toBe(1);
		const assertRetained = () => {
			expect(fileRowPaths(container)).toEqual(paths);
			expect(fileStats()).toEqual(measuredBefore);
			expect(chipText(container)).toEqual(chipsBefore);
			expect(changesTitle(container)).toBe(titleBefore);
			assertRefreshState(container, true);
			expect(container.querySelector("[data-git-changes-list]")?.getAttribute("aria-busy")).toBe(
				"true",
			);
			const writes = Array.from(
				container.querySelectorAll<HTMLButtonElement>(
					'[data-git-change-row] button[aria-label="Stage"], [data-git-change-row] button[aria-label="Unstage"], [data-git-change-row] button[aria-label="Discard"]',
				),
			);
			expect(writes.length).toBeGreaterThan(0);
			for (const button of writes) expect(button.disabled).toBe(true);
			const stageAll = buttonByText(
				container,
				mode === "filtered" ? "Stage Filtered" : "Stage All",
			);
			const discardAll = buttonByText(
				container,
				mode === "filtered" ? "Discard Filtered" : "Discard All",
			);
			expect(stageAll.disabled).toBe(true);
			expect(discardAll.disabled).toBe(true);
			expect(actions).toEqual([]);
		};
		assertRetained();
		pageGate.resolve();
		await waitFor(() => candidateWorker?.appendPending === true, "new page queued at Worker");
		assertRetained();
		expect(measuredPaths).toEqual([]);
		candidateWorker?.release();
		await waitFor(() => measuredPaths.length > 0, "candidate-only measurements");
		assertRetained();
		expect(measuredPaths.flat()).toContain("src/fresh.ts");
		expect(measuredPaths.flat()).not.toContain("src/staged-mod.ts");
		statsGate.resolve();
		await waitFor(
			() =>
				fileRowPaths(container).includes("src/fresh.ts") &&
				refreshButton(container).getAttribute("data-refreshing") === "false",
			"measured handoff",
		);
		assertRefreshState(container, false);
		expect(fileRowPaths(container)).toEqual(["src/fresh.ts"]);
		expect(changesTitle(container)).toBe(mode === "filtered" ? "Changes (1/1)" : "Changes (1)");
		expect(container.textContent).toContain(`+${status.linesAdded}`);
		expect(container.querySelector('[data-git-row-type="file"]')?.textContent).toContain("+77");
		expect(
			buttonByText(container, mode === "filtered" ? "Stage Filtered" : "Stage All").disabled,
		).toBe(false);
		expect(actions).toEqual([]);
		client.clear();
	});

	test("a failed candidate query settles only its requested rows when append overtakes React delivery", async () => {
		const workspaceKey = "git-failed-statistics-window-race";
		const status = makeMixedStatus();
		const actions: Array<{ name: string; body?: unknown }> = [];
		stubGitApi(actions, status);
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], status);
		const container = renderTab(workspaceKey, client);
		await flushRender();
		await click(buttonByText(container, "List"));
		const oldPaths = fileRowPaths(container);
		expect(oldPaths).toHaveLength(5);
		const nextStatus: GitStatusSummary = {
			...status,
			headSha: "candidate-race",
			staged: 0,
			unstaged: 2,
			untracked: 0,
			totalFiles: 2,
			files: [file(" M", "new-a.ts"), file(" M", "new-b.ts")],
		};
		const nextPage = gitChangesFixturePage(nextStatus);
		const appendGate = deferred<void>();
		api.getGitStatusPage = async (_target, query) => {
			if (query?.cursor) {
				await appendGate.promise;
				return {
					...nextPage,
					cache: gitChangesFixtureCache(),
					files: nextPage.files.slice(1),
					hasMore: false,
					nextCursor: null,
				};
			}
			return {
				...nextPage,
				cache: gitChangesFixtureCache(),
				files: nextPage.files.slice(0, 1),
				hasMore: true,
				nextCursor: "next",
			};
		};
		const firstStats = deferred<never>();
		const secondStatsGate = deferred<void>();
		const requestedRows: string[][] = [];
		api.getGitStatusPageStats = async (_target, query) => {
			requestedRows.push(query.rows.map((row) => row.path));
			if (requestedRows.length === 1) return firstStats.promise;
			await secondStatsGate.promise;
			return {
				status: "ready",
				cache: gitChangesFixtureCache(),
				snapshotId: query.snapshotId,
				rows: query.rows.map((row) => ({ ...row, added: 23, removed: 2, complete: true })),
			};
		};
		let delayedWindows = 0;
		let failedAcknowledgement: GitChangesListWindow | undefined;
		let failedSettlementRows: string[] | undefined;
		__setGitChangesWorkerFactory(() => {
			const modelWorker = new TestGitChangesWorker();
			const requests = new Map<number, GitChangesWorkerRequest>();
			const held: MessageEvent<GitChangesWorkerResponse>[] = [];
			let holding = true;
			const port: GitChangesWorkerPort = {
				onmessage: null,
				onerror: null,
				postMessage(request) {
					requests.set(request.id, request);
					modelWorker.postMessage(request);
				},
				terminate() {
					modelWorker.terminate();
				},
			};
			modelWorker.onmessage = (event) => {
				const response = event.data;
				const request = requests.get(response.id);
				if (response.type === "window" && response.window.loadedFiles === 2) {
					if (request?.type === "page-stats" && request.options?.failed) {
						failedAcknowledgement = response.window;
						failedSettlementRows = request.options.rows?.map((row) => row.path);
						holding = false;
						port.onmessage?.(event);
						// Older notifications remain obsolete even if delivered after the ACK.
						for (const previous of held.splice(0)) port.onmessage?.(previous);
						return;
					}
					if (holding) {
						delayedWindows++;
						held.push(event);
						return;
					}
				}
				port.onmessage?.(event);
			};
			return port;
		});
		await click(buttonByLabel(container, "Refresh"));
		await waitFor(() => requestedRows.length === 1, "candidate A statistics request");
		expect(requestedRows[0]).toEqual(["new-a.ts"]);
		appendGate.resolve();
		await waitFor(() => delayedWindows > 0, "model accepted candidate B before React notification");
		expect(fileRowPaths(container)).toEqual(oldPaths);
		firstStats.reject(new Error("candidate A measurement unavailable"));
		await waitFor(() => requestedRows.length === 2, "candidate B measurement remains necessary");
		expect(failedSettlementRows).toEqual(["new-a.ts"]);
		expect(failedAcknowledgement?.statsReady).toBe(false);
		expect(requestedRows[1]).toEqual(["new-b.ts"]);
		expect(fileRowPaths(container)).toEqual(oldPaths);
		expect(buttonByText(container, "Stage All").disabled).toBe(true);
		expect(actions).toEqual([]);
		secondStatsGate.resolve();
		await waitFor(
			() => fileRowPaths(container).includes("new-b.ts"),
			"candidate B measured handoff",
		);
		expect(fileRowPaths(container)).toEqual(["new-a.ts", "new-b.ts"]);
		const rowA = container.querySelector('[data-git-row-path="new-a.ts"]');
		const rowB = container.querySelector('[data-git-row-path="new-b.ts"]');
		expect(rowA?.textContent).not.toContain("+1");
		expect(rowB?.textContent).toContain("+23");
		expect(buttonByText(container, "Stage All").disabled).toBe(false);
		client.clear();
	});

	test("the spinning refresh button remains clickable and forwards every refresh callback", async () => {
		const workspaceKey = "git-refresh-clickable";
		const status = makeMixedStatus();
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], status);
		stubGitApi([], status);
		let callbacks = 0;
		const container = renderTab(workspaceKey, client, () => callbacks++);
		await flushRender();
		await click(buttonByText(container, "List"));
		const paths = fileRowPaths(container);
		assertRefreshState(container, false);
		const gate = deferred<void>();
		let pageCalls = 0;
		api.getGitStatusPage = async (_target, query, signal) => {
			pageCalls++;
			await gate.promise;
			signal?.throwIfAborted();
			return gitChangesFixturePage(status, query);
		};
		await click(refreshButton(container));
		assertRefreshState(container, true);
		expect(callbacks).toBe(1);
		expect(pageCalls).toBe(1);
		await click(refreshButton(container));
		assertRefreshState(container, true);
		expect(callbacks).toBe(2);
		expect(pageCalls).toBe(1);
		expect(fileRowPaths(container)).toEqual(paths);
		gate.resolve();
		await waitFor(
			() => refreshButton(container).getAttribute("data-refreshing") === "false",
			"repeated refresh completion",
		);
		assertRefreshState(container, false);
		expect(fileRowPaths(container)).toEqual(paths);
		client.clear();
	});

	test("same-snapshot statistics refresh preserves old values as busy until an explicit unknown arrives", async () => {
		const workspaceKey = "git-stat-continuity";
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], makeMixedStatus());
		const status = makeMixedStatus();
		stubGitApi([], status);
		const container = renderTab(workspaceKey, client);
		await flushRender();
		await click(buttonByText(container, "List"));
		await waitFor(
			() =>
				container.querySelector('[data-git-row-type="file"]')?.textContent?.includes("+1") === true,
			"initial statistics",
		);
		const paths = fileRowPaths(container);
		const gate = deferred<void>();
		api.getGitStatusPageStats = async (_target, query) => {
			await gate.promise;
			return {
				status: "ready",
				cache: gitChangesFixtureCache(),
				snapshotId: query.snapshotId,
				rows: query.rows.map((row) => ({ ...row, complete: false })),
			};
		};
		void client.invalidateQueries({ queryKey: ["gitStatusPageStats", workspaceKey] });
		await waitFor(
			() => refreshButton(container).getAttribute("data-refreshing") === "true",
			"statistics busy marker",
		);
		assertRefreshState(container, true);
		expect(fileRowPaths(container)).toEqual(paths);
		expect(container.querySelector('[data-git-row-type="file"]')?.textContent).toContain("+1");
		expect(buttonByText(container, "Stage All").disabled).toBe(false);
		gate.resolve();
		await waitFor(
			() => refreshButton(container).getAttribute("data-refreshing") === "false",
			"unknown statistics settle",
		);
		assertRefreshState(container, false);
		expect(fileRowPaths(container)).toEqual(paths);
		for (const row of container.querySelectorAll('[data-git-row-type="file"]'))
			expect(row.textContent).not.toContain("+1");
		client.clear();
	});

	test.each([
		"page",
		"statistics",
	] as const)("a background %s failure has a visible retry path and statistics failures hand off as unknown", async (failureKind) => {
		const workspaceKey = `git-refresh-failure-${failureKind}`;
		const status = makeMixedStatus();
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], status);
		stubGitApi([], status);
		const container = renderTab(workspaceKey, client);
		await flushRender();
		await click(buttonByText(container, "List"));
		const paths = fileRowPaths(container);
		const next = {
			...status,
			headSha: "retry-head",
			staged: 0,
			unstaged: 1,
			untracked: 0,
			totalFiles: 1,
			files: [file(" M", "fresh.ts")],
		};
		let fail = true;
		api.getGitStatusPage = async (_target, query) => {
			if (failureKind === "page" && fail) throw new Error("page refresh unavailable");
			return gitChangesFixturePage(next, query);
		};
		api.getGitStatusPageStats = async (_target, query) => {
			if (failureKind === "statistics" && fail) throw new Error("statistics refresh unavailable");
			return {
				status: "ready",
				cache: gitChangesFixtureCache(),
				snapshotId: query.snapshotId,
				rows: query.rows.map((row) => ({ ...row, added: 8, removed: 2, complete: true })),
			};
		};
		await click(buttonByLabel(container, "Refresh"));
		await waitFor(
			() =>
				container.textContent?.includes(
					`${failureKind === "page" ? "page" : "statistics"} refresh unavailable`,
				) === true,
			"refresh failure",
		);
		if (failureKind === "page") {
			expect(changesTitle(container)).toBe("Changes (5)");
			expect(fileRowPaths(container)).toEqual(paths);
			expect(buttonByText(container, "Stage All").disabled).toBe(true);
			assertRefreshState(container, true);
		} else {
			await waitFor(
				() => fileRowPaths(container).includes("fresh.ts"),
				"failed measurement handoff",
			);
			expect(changesTitle(container)).toBe("Changes (1)");
			expect(buttonByText(container, "Stage All").disabled).toBe(false);
			expect(container.querySelector('[data-git-row-type="file"]')?.textContent).not.toContain(
				"+1",
			);
		}
		fail = false;
		await click(buttonByLabel(container, "Refresh"));
		await waitFor(
			() =>
				fileRowPaths(container).includes("fresh.ts") &&
				container.querySelector('[data-git-row-type="file"]')?.textContent?.includes("+8") === true,
			"explicit refresh recovery",
		);
		expect(buttonByText(container, "Stage All").disabled).toBe(false);
		expect(container.textContent).not.toContain("refresh unavailable");
		client.clear();
	});

	test("a successful empty snapshot hands off without requesting file statistics", async () => {
		const workspaceKey = "git-refresh-empty";
		const status = makeMixedStatus();
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], status);
		stubGitApi([], status);
		const container = renderTab(workspaceKey, client);
		await flushRender();
		await click(buttonByText(container, "List"));
		const gate = deferred<void>();
		api.getGitStatusPage = async (_target, query) => {
			await gate.promise;
			return gitChangesFixturePage(
				{
					...status,
					headSha: "empty",
					files: [],
					staged: 0,
					unstaged: 0,
					untracked: 0,
					totalFiles: 0,
				},
				query,
			);
		};
		let statsCalls = 0;
		api.getGitStatusPageStats = async (_target, query) => {
			statsCalls++;
			return {
				status: "ready",
				cache: gitChangesFixtureCache(),
				snapshotId: query.snapshotId,
				rows: [],
			};
		};
		await click(buttonByLabel(container, "Refresh"));
		expect(fileRowPaths(container)).toHaveLength(5);
		gate.resolve();
		await waitFor(
			() => container.textContent?.includes(gitLocale.noChanges) === true,
			"empty snapshot",
		);
		expect(fileRowPaths(container)).toEqual([]);
		expect(chipText(container)).toEqual([]);
		expect(changesTitle(container)).toBe("Changes (0)");
		assertRefreshState(container, false);
		expect(statsCalls).toBe(0);
		client.clear();
	});

	for (const endpoint of ["page", "statistics"] as const) {
		test.each([
			401, 403, 404,
		])(`HTTP %s from ${endpoint} removes facts without parent unmount and refresh restores access`, async (statusCode) => {
			const workspaceKey = `git-display-refusal-${endpoint}-${statusCode}`;
			const status = { ...makeMixedStatus(), branch: "private/refused-branch" };
			const client = makeClient();
			client.setQueryData(["gitStatus", workspaceKey], status);
			stubGitApi([], status);
			const container = renderTab(workspaceKey, client);
			await flushRender();
			await click(buttonByText(container, "List"));
			expect(fileRowPaths(container)).toHaveLength(5);
			expect(container.textContent).toContain(`+${status.linesAdded}`);
			const failure = new ApiError("Git read refused", statusCode);
			const readPage = api.getGitStatusPage;
			const readStats = api.getGitStatusPageStats;
			if (endpoint === "page") {
				api.getGitStatusPage = async () => {
					throw failure;
				};
				await click(buttonByLabel(container, "Refresh"));
			} else {
				api.getGitStatusPageStats = async () => {
					throw failure;
				};
				void client.invalidateQueries({ queryKey: ["gitStatusPageStats", workspaceKey] });
			}
			await waitFor(() => fileRowPaths(container).length === 0, "refused file facts cleared");
			await flushRender();
			expect(
				container.querySelectorAll(
					'[data-git-row-type="directory"], [data-git-row-type="section"]',
				),
			).toHaveLength(0);
			expect(chipText(container)).toEqual([]);
			expect(changesTitle(container)).toBe("Changes");
			expect(container.textContent).not.toContain(`+${status.linesAdded}`);
			expect(container.textContent).not.toContain("src/mod.ts");
			expect(container.textContent).not.toContain(status.branch);
			expect(container.querySelector('[aria-label="Copy branch name"]') === null).toBe(true);
			expect(container.textContent).toContain("Git read refused");
			api.getGitStatusPage = readPage;
			api.getGitStatusPageStats = readStats;
			await click(buttonByLabel(container, "Refresh"));
			await waitFor(
				() =>
					fileRowPaths(container).length === 5 && !buttonByText(container, "Stage All").disabled,
				"read access retry",
			);
			expect(container.textContent).toContain(`+${status.linesAdded}`);
			client.clear();
		});
	}

	test.each([
		"workspace",
		"narrator",
		"repository",
		"root",
	] as const)("switching %s clears paths and counts while its new first page is delayed", async (field) => {
		const workspaceKey = `git-display-owner-${field}`;
		const status = { ...makeMixedStatus(), branch: "private/owner-branch" };
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], status);
		stubGitApi([], status);
		const container = renderTab(workspaceKey, client);
		await flushRender();
		await click(buttonByText(container, "List"));
		const gate = deferred<void>();
		const readPage = api.getGitStatusPage;
		api.getGitStatusPage = async (...args) => {
			await gate.promise;
			return readPage(...args);
		};
		expect(container.textContent).toContain(`+${status.linesAdded}`);
		const target = workspaceTarget(workspaceKey);
		const nextTarget =
			field === "workspace"
				? { ...target, workspaceKey: "new-workspace" }
				: field === "narrator"
					? { ...target, narratorId: "new-narrator" }
					: field === "repository"
						? { ...target, repositoryKey: "new-repository" }
						: { ...target, rootPath: "/new-root" };
		renderTarget(nextTarget, client);
		await flushRender();
		expect(fileRowPaths(container)).toEqual([]);
		expect(chipText(container)).toEqual([]);
		expect(changesTitle(container)).toBe("Changes");
		expect(container.textContent).not.toContain(`+${status.linesAdded}`);
		expect(container.textContent).not.toContain("src/mod.ts");
		expect(container.textContent).not.toContain(status.branch);
		expect(container.querySelector('[aria-label="Copy branch name"]') === null).toBe(true);
		gate.resolve();
		await flushRender();
		client.clear();
	});

	for (const change of ["generation", "write-permission"] as const) {
		test.each([
			"file",
			"all",
			"filtered",
		] as const)(`a pending %s confirmation cannot mutate after ${change} changes and recovers`, async (kind) => {
			const workspaceKey = `git-old-confirmation-${change}-${kind}`;
			const status = makeMixedStatus();
			const actions: Array<{ name: string; body?: unknown }> = [];
			stubGitApi(actions, status);
			const client = makeClient();
			client.setQueryData(["gitStatus", workspaceKey], status);
			const container = renderTab(workspaceKey, client);
			await flushRender();
			await click(buttonByText(container, "List"));
			if (kind === "filtered") await click(chipByLetter(container, "M"));
			if (kind === "file") await click(buttonByLabel(container, "Discard"));
			else
				await click(
					buttonByText(container, kind === "filtered" ? "Discard Filtered" : "Discard All"),
				);
			const pendingConfirm = await confirmDialogButton("Confirm");
			if (change === "generation") await click(buttonByLabel(container, "Refresh"));
			else {
				renderTarget({ ...workspaceTarget(workspaceKey), canWrite: false }, client);
				await flushRender();
				expect(fileRowPaths(container).length).toBeGreaterThan(0);
				expect(
					buttonByText(container, kind === "filtered" ? "Stage Filtered" : "Stage All").disabled,
				).toBe(true);
				renderTarget(workspaceTarget(workspaceKey), client);
				await flushRender();
			}
			await click(pendingConfirm);
			expect(actions).toEqual([]);
			expect(
				buttonByText(container, kind === "filtered" ? "Stage Filtered" : "Stage All").disabled,
			).toBe(false);
			client.clear();
		});

		test(`a pending directory scope cannot mutate after ${change} changes`, async () => {
			const workspaceKey = `git-old-scope-${change}`;
			const status = makeMixedStatus();
			const actions: Array<{ name: string; body?: unknown }> = [];
			stubGitApi(actions, status);
			const worker = new ControlledGitChangesWorker();
			worker.holdAppend = false;
			__setGitChangesWorkerFactory(() => worker);
			const client = makeClient();
			client.setQueryData(["gitStatus", workspaceKey], status);
			const container = renderTab(workspaceKey, client);
			await flushRender();
			worker.holdScopes = true;
			const directory = container.querySelector('[data-git-row-type="directory"]');
			const stage = directory?.querySelector<HTMLButtonElement>('button[aria-label="Unstage"]');
			if (!stage) throw new Error("Directory action missing");
			expect(stage.disabled).toBe(false);
			await click(stage);
			expect(worker.scopePending).toBe(true);
			if (change === "generation") {
				__setGitChangesWorkerFactory(() => new TestGitChangesWorker());
				await click(buttonByLabel(container, "Refresh"));
			} else {
				renderTarget({ ...workspaceTarget(workspaceKey), canWrite: false }, client);
				await flushRender();
				renderTarget(workspaceTarget(workspaceKey), client);
				await flushRender();
			}
			worker.release();
			await flushRender();
			expect(actions).toEqual([]);
			client.clear();
		});
	}

	test.each([
		"scope",
		"read-refusal",
	] as const)("an old confirmation hides its path and root immediately on %s changes", async (change) => {
		const workspaceKey = `git-confirmation-facts-${change}`;
		const status = makeMixedStatus();
		const actions: Array<{ name: string; body?: unknown }> = [];
		stubGitApi(actions, status);
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], status);
		const container = renderTab(workspaceKey, client);
		await flushRender();
		const target = { ...workspaceTarget(workspaceKey), rootPath: "/private/root" };
		renderTarget(target, client);
		await flushRender();
		await click(buttonByText(container, "List"));
		await click(buttonByLabel(container, "Discard"));
		const pendingConfirm = await confirmDialogButton("Confirm");
		expect(document.body.textContent).toContain("/private/root");
		expect(document.body.textContent).toContain("src/del.ts");
		if (change === "scope") {
			api.getGitStatusPage = () => new Promise(() => {});
			renderTarget({ ...target, rootPath: "/other/root" }, client);
		} else {
			api.getGitStatusPageStats = async () => {
				throw new ApiError("read refused", 403);
			};
			void client.invalidateQueries({ queryKey: ["gitStatusPageStats", workspaceKey] });
		}
		await waitFor(() => fileRowPaths(container).length === 0, "read owner retired");
		await flushRender();
		expect(document.body.textContent).not.toContain("/private/root");
		expect(document.body.textContent).not.toContain("src/del.ts");
		expect(document.body.textContent).toContain(gitLocale["pages.scopeExpired"]);
		await click(pendingConfirm);
		expect(actions).toEqual([]);
		client.clear();
	});

	test("a confirmation cannot mutate after the tab unmounts while its provider survives", async () => {
		const workspaceKey = "git-confirmation-unmounted-tab";
		const status = makeMixedStatus();
		const actions: Array<{ name: string; body?: unknown }> = [];
		stubGitApi(actions, status);
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], status);
		const container = renderTab(workspaceKey, client);
		await flushRender();
		await click(buttonByText(container, "List"));
		await click(buttonByLabel(container, "Discard"));
		const pendingConfirm = await confirmDialogButton("Confirm");
		expect(document.body.textContent).toContain("src/del.ts");
		renderTarget(null, client);
		await flushRender();
		expect(document.body.textContent).not.toContain("src/del.ts");
		expect(document.body.textContent).toContain(gitLocale["pages.scopeExpired"]);
		await click(pendingConfirm);
		expect(actions).toEqual([]);
		client.clear();
	});

	test("slow and failed line stats never delay status rows or disable actions", async () => {
		const client = makeClient();
		const workspaceKey = "git-slow-stats";
		client.setQueryData(["gitStatus", workspaceKey], makeMixedStatus());
		let rejectStats!: (error: Error) => void;
		const pendingStats = new Promise<Awaited<ReturnType<typeof api.getGitLineStats>>>(
			(_resolve, reject) => {
				rejectStats = reject;
			},
		);
		api.getGitLineStats = () => pendingStats;
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

	test("an expired statistics snapshot refreshes the loaded page chain and fills directory counts", async () => {
		const workspaceKey = "git-statistics-expiry";
		const status: GitStatusSummary = {
			...makeMixedStatus(),
			staged: 0,
			unstaged: 1,
			untracked: 0,
			totalFiles: 1,
			files: [file(" M", "src/recovered.ts")],
			linesAdded: 1,
		};
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], status);
		stubGitApi([], status);
		const readPage = api.getGitStatusPage;
		const readStats = api.getGitStatusPageStats;
		let pageCalls = 0;
		let statsCalls = 0;
		api.getGitStatusPage = (...args) => {
			pageCalls++;
			return readPage(...args);
		};
		api.getGitStatusPageStats = (...args) => {
			if (++statsCalls === 1)
				return Promise.reject(
					Object.assign(new Error("expired"), { data: { code: "GIT_STATUS_PAGE_EXPIRED" } }),
				);
			return readStats(...args);
		};
		const container = renderTab(workspaceKey, client);
		await waitFor(
			() =>
				container.querySelector('[data-git-row-type="directory"]')?.textContent?.includes("+1") ===
				true,
			"directory statistics after snapshot recovery",
		);
		expect(pageCalls).toBe(2);
		expect(statsCalls).toBe(2);
		expect(
			container
				.querySelector('[data-git-row-type="directory"] button[aria-label="Stage"]')
				?.hasAttribute("disabled"),
		).toBe(false);
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
		// React may yield under parallel CI load; a single timer tick does not
		// guarantee the concurrent root has committed the measured file rows.
		await waitFor(
			() =>
				container
					.querySelector('[aria-label="View diff of binary.png"]')
					?.textContent?.includes("+0-0") === true &&
				container.querySelector('[aria-label="View diff of unknown.png"]') !== null,
			"binary and unmeasured file rows",
		);
		expect(
			container.querySelector('[aria-label="View diff of binary.png"]')?.textContent,
		).toContain("+0-0");
		expect(
			container.querySelector('[aria-label="View diff of unknown.png"]')?.textContent,
		).not.toMatch(/[+-]0/);
		client.clear();
	});

	test("initial and failed snapshots keep selected counts unknown until a successful page arrives", async () => {
		const workspaceKey = "git-filter-unknown-counts";
		const status = makeMixedStatus();
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], status);
		window.sessionStorage.setItem(
			"narrafork_git_status_filter",
			JSON.stringify({ [workspaceKey]: ["M", "D"] }),
		);
		__resetGitStatusFilterCache();
		const gate = deferred<void>();
		const readPage = api.getGitStatusPage;
		api.getGitStatusPage = async () => {
			await gate.promise;
			throw new Error("initial snapshot failed");
		};
		const container = renderTab(workspaceKey, client);
		await flushRender();
		const assertUnknown = () => {
			expect(changesTitle(container)).toBe("Changes");
			expect(chipText(container)).toEqual(["M", "D"]);
			expect(chipByLetter(container, "M").getAttribute("aria-label")).toBe("Modified");
			expect(chipByLetter(container, "D").getAttribute("aria-label")).toBe("Deleted");
			expect(fileRowPaths(container)).toEqual([]);
		};
		assertUnknown();
		gate.resolve();
		await waitFor(
			() => container.textContent?.includes("initial snapshot failed") === true,
			"initial snapshot failure",
		);
		assertUnknown();
		api.getGitStatusPage = readPage;
		await click(refreshButton(container));
		await waitFor(() => changesTitle(container) === "Changes (4/5)", "known snapshot counts");
		expect(chipText(container)).toEqual(["A 1", "M 2", "D 2"]);
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
		expect(changesTitle(container)).toBe("Changes (5)");
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
		expect(changesTitle(container)).toBe("Changes (2/5)");
		expect(fileRowPaths(container).sort()).toEqual(["src/del.ts", "src/staged-del.ts"]);
		// Section headers report matched/total so the hidden rows are accounted for
		// rather than silently missing.
		expect(container.textContent).toContain("Staged (1/2)");
		expect(container.textContent).toContain("Unstaged (1/3)");

		// A second letter is a union, not a replacement.
		await click(chipByLetter(container, "A"));
		await expandAllFolders(container);
		expect(changesTitle(container)).toBe("Changes (3/5)");
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
		expect(changesTitle(container)).toBe("Changes (1)");
		await expandAllFolders(container);
		expect(fileRowPaths(container)).toEqual(["src/fresh.ts", "src/fresh.ts"]);

		await click(chipByLetter(container, "A"));
		await expandAllFolders(container);
		// Only the staged half survives — that is the row whose badge says `A`.
		expect(fileRowPaths(container)).toEqual(["src/fresh.ts"]);
		expect(container.textContent).toContain("Staged (1/1)");
		expect(container.textContent).not.toContain("Unstaged (1/1)");
		expect(changesTitle(container)).toBe("Changes (1/1)");

		await click(chipByLetter(container, "M"));
		await expandAllFolders(container);
		expect(fileRowPaths(container)).toEqual(["src/fresh.ts", "src/fresh.ts"]);
		expect(changesTitle(container)).toBe("Changes (1/1)");
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
		// MM appears in both sections but is one changed file overall.
		expect(changesTitle(container)).toBe("Changes (2)");
		expect(container.textContent).toContain("Staged (2)");
		expect(container.textContent).toContain("Unstaged (1)");

		await click(chipByLetter(container, "M"));
		await expandAllFolders(container);
		expect(fileRowPaths(container)).toEqual(["src/shared.ts", "src/shared.ts"]);
		expect(changesTitle(container)).toBe("Changes (1/2)");
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
		expect(changesTitle(container)).toBe("Changes (2+)");
		expect(container.querySelector("[data-git-file-count]")?.getAttribute("title")).toBe(
			"Changes count is a lower bound",
		);
		expect(container.textContent).toContain("Staged (3+)");
		expect(container.textContent).toContain("Unstaged (3+)");
		expect(
			container.querySelector('[data-git-section-count="staged"]')?.getAttribute("title"),
		).toContain("Staged count is a lower bound");
		expect(
			container.querySelector('[data-git-section-count="unstaged"]')?.getAttribute("title"),
		).toContain("Unstaged count is a lower bound");
		expect(
			container.querySelector('[data-git-section-count="unstaged"]')?.getAttribute("title"),
		).toContain("file scan limit reached");
		expect(container.textContent).not.toContain("lower bound");
		expect(container.textContent).not.toContain("Incomplete Git snapshot");
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
		expect(changesTitle(container)).toBe("Changes (2+)");
		expect(container.textContent).toContain("Staged (3+)");
		expect(container.textContent).toContain("Unstaged (3+)");
		expect(
			container.querySelector('[data-git-section-count="unstaged"]')?.getAttribute("title"),
		).toContain("Unstaged count is a lower bound");

		client.clear();
	});

	test("filtered partial snapshots mark both unique file counts as lower bounds", async () => {
		const workspaceKey = "git-filter-partial-counts";
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], { ...makeMixedStatus(), truncated: true });
		const container = renderTab(workspaceKey, client);
		await flushRender();
		expect(changesTitle(container)).toBe("Changes (5+)");
		expect(chipText(container)).toEqual(["A", "M", "D"]);
		expect(chipByLetter(container, "D").getAttribute("aria-label")).toBe("Deleted");
		await click(chipByLetter(container, "D"));
		expect(changesTitle(container)).toBe("Changes (2+/5+)");
		expect(chipText(container)).toEqual(["A", "M", "D"]);
		expect(chipByLetter(container, "D").getAttribute("aria-label")).toBe("Deleted");
		expect(container.querySelector("[data-git-file-count]")?.getAttribute("title")).toBe(
			"Changes count is a lower bound",
		);
		client.clear();
	});

	test("a partial scan with no discovered matches keeps selected chip counts unknown", async () => {
		const workspaceKey = "git-filter-partial-undiscovered";
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], {
			...makeMixedStatus(),
			truncated: true,
			staged: 0,
			unstaged: 1,
			untracked: 0,
			totalFiles: 1,
			files: [file(" M", "src/discovered.ts")],
		});
		window.sessionStorage.setItem(
			"narrafork_git_status_filter",
			JSON.stringify({ [workspaceKey]: ["D"] }),
		);
		__resetGitStatusFilterCache();
		const container = renderTab(workspaceKey, client);
		await flushRender();
		expect(changesTitle(container)).toBe("Changes (0+/1+)");
		expect(chipText(container)).toEqual(["M", "D"]);
		expect(chipByLetter(container, "D").getAttribute("aria-label")).toBe("Deleted");
		expect(chipByLetter(container, "M").getAttribute("aria-label")).toBe("Modified");
		await click(chipByLetter(container, "M"));
		expect(changesTitle(container)).toBe("Changes (1+/1+)");
		expect(chipText(container)).toEqual(["M", "D"]);
		expect(chipByLetter(container, "M").getAttribute("aria-label")).toBe("Modified");
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
		expect(changesTitle(container)).toBe("Changes (6)");
		expect(container.textContent).toContain("Staged (3)");
		expect(container.textContent).toContain("Unstaged (3)");
		expect(container.textContent).not.toContain("lower bound");
		expect(container.textContent).not.toContain("some files are not shown");
		expect(
			container
				.querySelector('[data-git-row-type="directory"] button')
				?.parentElement?.getAttribute("title"),
		).toBe(gitLocale["pages.rangeIncomplete"]);
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
		expect(changesTitle(container2)).toBe("Changes (0/1)");
		expect(chipByLetter(container2, "D").getAttribute("aria-label")).toBe("Deleted (0)");

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

		expect(calls).toEqual([
			{
				name: "discard",
				body: {
					files: ["src/del.ts"],
					snapshotScope: { snapshotId: "fixture:abc1234:D", filter: ["D"], section: "unstaged" },
				},
			},
		]);

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
			{
				name: "stage",
				body: {
					files: ["src/mod.ts"],
					snapshotScope: { snapshotId: "fixture:abc1234:M", filter: ["M"], section: "unstaged" },
				},
			},
			{
				name: "unstage",
				body: {
					files: ["src/staged-mod.ts"],
					snapshotScope: { snapshotId: "fixture:abc1234:M", filter: ["M"], section: "staged" },
				},
			},
		]);

		client.clear();
	});

	test("without a filter the bulk actions still act on everything", async () => {
		// The narrowing must not leak into the unfiltered case: "Stage All" has to
		// keep sending `all: true`, which also covers files beyond the loaded pages.
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

	test("status filtering exposes matching files beyond the initial page", async () => {
		const workspaceKey = "git-filter-later-page";
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

		// The deletion sits at index 120, beyond the initial 100-file page.
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

	test("612 files in a collapsed tree automatically complete seven pages without input", async () => {
		const workspaceKey = "git-collapsed-612";
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], {
			...makeMixedStatus(),
			staged: 0,
			unstaged: 483,
			untracked: 129,
			totalFiles: 612,
			files: Array.from({ length: 612 }, (_, index) =>
				file(index < 483 ? " M" : "??", `src/file-${String(index).padStart(4, "0")}.ts`),
			),
		} satisfies GitStatusSummary);
		const readPage = api.getGitStatusPage;
		const cursors: string[] = [];
		api.getGitStatusPage = (...args) => {
			cursors.push(args[1]?.cursor ?? "first");
			return readPage(...args);
		};
		const container = renderTab(workspaceKey, client);
		await waitFor(
			() =>
				container.querySelector('[data-git-row-type="directory"]')?.textContent?.includes("612") ===
				true,
			"all seven pages in collapsed tree",
		);
		await flushRender();
		expect(cursors).toEqual(["first", "100", "200", "300", "400", "500", "600"]);
		expect(fileRowPaths(container)).toEqual([]);
		expect(container.querySelector('[aria-label="Expand folder src"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="git-changes-load-more"]')).toBeNull();
		expect(container.textContent).not.toContain("Load complete range");
		expect(container.querySelector('[data-testid="git-changes-range-controls"]')).toBeNull();
		expect(container.querySelectorAll("[data-git-change-row]")).toHaveLength(2);
		client.clear();
	});

	test.each([
		"button",
		"scroll",
	] as const)("10,000 files stop at ten automatic pages and %s continues to page eleven", async (continuation) => {
		const workspaceKey = `git-budget-${continuation}`;
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], {
			...makeMixedStatus(),
			staged: 0,
			unstaged: 10_000,
			untracked: 0,
			totalFiles: 10_000,
			files: Array.from({ length: 10_000 }, (_, index) =>
				file(" M", `src/file-${String(index).padStart(5, "0")}.ts`),
			),
		} satisfies GitStatusSummary);
		const readPage = api.getGitStatusPage;
		const cursors: string[] = [];
		api.getGitStatusPage = (...args) => {
			cursors.push(args[1]?.cursor ?? "first");
			return readPage(...args);
		};
		const container = renderTab(workspaceKey, client);
		const directoryCount = () =>
			container.querySelector('[data-git-row-type="directory"]')?.textContent;
		await waitFor(() => directoryCount()?.includes("1000") === true, "ten automatic pages");
		await flushRender();
		expect(changesTitle(container)).toBe("Changes (10000)");
		expect(cursors).toEqual([
			"first",
			"100",
			"200",
			"300",
			"400",
			"500",
			"600",
			"700",
			"800",
			"900",
		]);
		expect(fileRowPaths(container)).toEqual([]);
		await click(buttonByText(container, "List"));
		await click(buttonByText(container, "Tree"));
		await flushRender();
		expect(cursors).toHaveLength(10);
		if (continuation === "button") {
			await click(buttonByText(container, "Load more"));
			await waitFor(() => directoryCount()?.includes("1100") === true, "manual page eleven");
		} else {
			await click(buttonByText(container, "List"));
			const viewport = container.querySelector<HTMLElement>("[data-git-changes-list]");
			if (!viewport) throw new Error("Git scroll viewport missing");
			Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 480 });
			viewport.scrollTop = 1002 * GIT_CHANGES_ROW_HEIGHT - 480;
			viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
			await waitFor(
				() =>
					container.querySelector("[data-git-total-rows]")?.getAttribute("data-git-total-rows") ===
					"1102",
				"scroll page eleven",
			);
		}
		await flushRender();
		expect(cursors).toHaveLength(11);
		expect(changesTitle(container)).toBe("Changes (10000)");
		expect(cursors.at(-1)).toBe("1000");
		expect(container.querySelectorAll("[data-git-change-row]").length).toBeLessThanOrEqual(30);
		client.clear();
	});

	test("ordinary flat pagination exposes loading and retry actions", async () => {
		const workspaceKey = "git-flat-page-controls";
		const status: GitStatusSummary = {
			...makeMixedStatus(),
			staged: 0,
			unstaged: 251,
			untracked: 0,
			totalFiles: 251,
			files: Array.from({ length: 251 }, (_, index) => file(" M", `src/file-${index}.ts`)),
		};
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], status);
		const pageApi = api.getGitStatusPage;
		let continuationAttempts = 0;
		const pageCursors: string[] = [];
		api.getGitStatusPage = async (target, query, signal) => {
			pageCursors.push(query?.cursor ?? "first");
			if (query?.cursor && ++continuationAttempts === 1) throw new Error("page retry fixture");
			return pageApi(target, query, signal);
		};
		const container = renderTab(workspaceKey, client);
		await flushRender();
		await click(buttonByText(container, "List"));
		const rowCount = () =>
			Number(container.querySelector("[data-git-total-rows]")?.getAttribute("data-git-total-rows"));
		await waitFor(() => rowCount() === 102, "first flat page");
		const viewport = container.querySelector<HTMLElement>("[data-git-changes-list]");
		if (!viewport) throw new Error("Git scroll viewport missing");
		Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 480 });
		// A model row count does not guarantee its section header is in the current
		// virtual window. Request the top window before checking that action.
		viewport.scrollTop = 1;
		viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
		await waitFor(
			() =>
				Array.from(container.querySelectorAll("button")).some(
					(button) => button.textContent === "Stage All",
				),
			"flat section header window",
		);
		expect(container.textContent).not.toContain(gitLocale["pages.rangeIncomplete"]);
		expect(container.textContent).not.toContain("Incomplete Git snapshot");
		expect(
			Array.from(container.querySelectorAll("button")).some(
				(button) => button.textContent === "Load complete range",
			),
		).toBe(false);
		expect(buttonByText(container, "Stage All").disabled).toBe(false);
		expect(container.querySelector('[data-testid="git-changes-range-controls"]')).toBeNull();
		viewport.scrollTop = rowCount() * GIT_CHANGES_ROW_HEIGHT - 480;
		viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
		await waitFor(
			() =>
				continuationAttempts === 1 &&
				container.textContent?.includes("Retry loading files") === true,
			"page retry control",
		);
		expect(container.textContent).toContain("page retry fixture");
		buttonByText(container, "Retry loading files").dispatchEvent(
			new Event("click", { bubbles: true }),
		);
		// Observe retry recovery away from the tail; another tail scroll below owns
		// the next continuation instead of racing the current near-tail prefetch.
		viewport.scrollTop = 1;
		viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
		await waitFor(() => rowCount() === 202, "retried second page");
		expect(continuationAttempts).toBe(2);
		expect(pageCursors).toEqual(["first", "100", "100"]);
		expect(container.textContent).not.toContain("page retry fixture");
		viewport.scrollTop = rowCount() * GIT_CHANGES_ROW_HEIGHT - 480;
		viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
		await waitFor(() => rowCount() === 252, "final flat page");
		expect(continuationAttempts).toBe(3);
		expect(pageCursors).toEqual(["first", "100", "100", "200"]);
		const loadedPages = client.getQueriesData<{ pages: Array<{ files: Array<{ path: string }> }> }>(
			{ queryKey: ["gitStatusPages", workspaceKey] },
		)[0]?.[1]?.pages;
		expect(loadedPages?.map((page) => page.files.length)).toEqual([100, 100, 51]);
		expect(new Set(loadedPages?.flatMap((page) => page.files.map((file) => file.path))).size).toBe(
			251,
		);
		expect(container.textContent).not.toContain(gitLocale["pages.rangeIncomplete"]);
		expect(container.textContent).not.toContain("Load complete range");
		client.clear();
	});

	test("expired filtered ranges explain disabled actions in their titles", async () => {
		const workspaceKey = "git-expired-title";
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], makeMixedStatus());
		const pageApi = api.getGitStatusPage;
		let expired = true;
		let pageCalls = 0;
		api.getGitStatusPage = async (...args) => {
			pageCalls++;
			const page = await pageApi(...args);
			return { ...page, ...(expired ? { expiresAt: Date.now() - 1 } : {}) };
		};
		const container = renderTab(workspaceKey, client);
		await flushRender();
		await click(chipByLetter(container, "M"));
		const stage = buttonByText(container, "Stage Filtered");
		expect(stage.disabled).toBe(true);
		expect(stage.getAttribute("title")).toBe(gitLocale["pages.rangeExpired"]);
		expect(container.textContent).not.toContain(gitLocale["pages.rangeExpired"]);
		expect(container.textContent).not.toContain(gitLocale["pages.rangeIncomplete"]);
		const beforeRetry = pageCalls;
		expired = false;
		await click(assertRangeFooter(container, "Refresh"));
		await waitFor(
			() => pageCalls > beforeRetry && !buttonByText(container, "Stage Filtered").disabled,
			"footer refresh recovers the expired range",
		);
		expect(container.querySelector('[data-testid="git-changes-range-controls"]')).toBeNull();
		client.clear();
	});

	test("paged directories stay bounded and act on the complete range across every page", async () => {
		const workspaceKey = "git-directory-paged";
		const status: GitStatusSummary = {
			...makeMixedStatus(),
			staged: 0,
			unstaged: 561,
			untracked: 0,
			totalFiles: 561,
			files: Array.from({ length: 561 }, (_, index) =>
				file(" M", `src/file-${String(index).padStart(4, "0")}.ts`),
			),
		};
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], status);
		const actions: Array<{ name: string; body?: unknown }> = [];
		stubGitApi(actions, status);
		const pageApi = api.getGitStatusPage;
		let pageCalls = 0;
		api.getGitStatusPage = (...args) => {
			pageCalls++;
			return pageApi(...args);
		};
		const held = holdNextStatusPage();
		const container = renderTab(workspaceKey, client);
		await waitFor(
			() => held.pending() && !!container.querySelector('[aria-label="Expand folder src"]'),
			"first paged directory while background continuation is held",
		);
		const directory = () => container.querySelector('[data-git-row-type="directory"]');
		const action = () =>
			directory()?.querySelector<HTMLButtonElement>('button[aria-label="Stage"]');
		await waitFor(
			() => directory()?.textContent?.includes("+561") === true,
			"full directory statistics on first 100 files",
		);
		expect(directory()?.textContent).toContain("100");
		expect(action()?.disabled).toBe(true);
		expect(action()?.parentElement?.getAttribute("title")).toBe(gitLocale["pages.rangeIncomplete"]);
		expect(container.textContent).not.toContain(gitLocale["pages.rangeIncomplete"]);
		expect(pageCalls).toBe(1);
		await flushRender();
		expect(directory()?.textContent).toContain("100");
		expect(action()?.disabled).toBe(true);
		held.release();
		await waitFor(() => action()?.disabled === false, "automatically completed directory scope");
		expect(pageCalls).toBe(6);
		expect(container.querySelector('[data-testid="git-changes-load-more"]')).toBeNull();
		expect(directory()?.textContent).toContain("561");
		await click(container.querySelector('[aria-label="Expand folder src"]') as Element);
		await waitFor(() => fileRowPaths(container).length > 0, "virtual file rows");
		expect(container.querySelectorAll("[data-git-change-row]").length).toBeLessThanOrEqual(30);
		expect(fileRowPaths(container).length).toBeLessThan(561);
		await click(action() as Element);
		await waitFor(() => actions.length === 1, "directory action");
		const body = actions[0]?.body as { files: string[]; all?: boolean };
		expect(body.all).toBeUndefined();
		expect(body.files).toHaveLength(561);
		expect(body.files).toContain("src/file-0560.ts");
		client.clear();
	});

	test("filtered bulk actions require all pages and preserve the full matched scope", async () => {
		const workspaceKey = "git-filter-paged-bulk";
		const status: GitStatusSummary = {
			...makeMixedStatus(),
			staged: 0,
			unstaged: 252,
			untracked: 0,
			totalFiles: 252,
			files: [
				...Array.from({ length: 251 }, (_, index) => file(" M", `src/mod-${index}.ts`)),
				file(" D", "src/deleted.ts"),
			],
		};
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], status);
		const actions: Array<{ name: string; body?: unknown }> = [];
		stubGitApi(actions, status);
		const held = holdNextStatusPage("M");
		const container = renderTab(workspaceKey, client);
		await waitFor(() => chipText(container).includes("M 251"), "global badge count");
		await click(chipByLetter(container, "M"));
		await waitFor(
			() =>
				!!Array.from(container.querySelectorAll("button")).find(
					(button) => button.textContent === "Stage Filtered",
				),
			"filtered header",
		);
		expect(changesTitle(container)).toBe("Changes (251/252)");
		expect(buttonByText(container, "Stage Filtered").disabled).toBe(true);
		expect(buttonByText(container, "Stage Filtered").getAttribute("title")).toBe(
			gitLocale["pages.rangeIncomplete"],
		);
		expect(buttonByText(container, "Discard Filtered").disabled).toBe(true);
		expect(buttonByText(container, "Discard Filtered").getAttribute("title")).toBe(
			gitLocale["pages.rangeIncomplete"],
		);
		expect(container.textContent).not.toContain(gitLocale["pages.rangeIncomplete"]);
		await waitFor(() => held.pending(), "filtered background continuation");
		await click(assertRangeFooter(container, "Load complete range"));
		assertRangeFooter(container, "Cancel loading");
		held.release();
		await waitFor(() => !buttonByText(container, "Stage Filtered").disabled, "full filtered range");
		expect(changesTitle(container)).toBe("Changes (251/252)");
		expect(container.querySelector('[data-testid="git-changes-range-controls"]')).toBeNull();
		await click(buttonByText(container, "Stage Filtered"));
		await waitFor(() => actions.length === 1, "filtered stage");
		const body = actions[0]?.body as { files: string[]; all?: boolean };
		expect(body.files).toHaveLength(251);
		expect(body.files).not.toContain("src/deleted.ts");
		expect(body.all).toBeUndefined();
		client.clear();
	});

	test("loading the complete range can be cancelled without authorizing a partial directory", async () => {
		const workspaceKey = "git-pages-cancel";
		const status: GitStatusSummary = {
			...makeMixedStatus(),
			staged: 0,
			unstaged: 501,
			untracked: 0,
			totalFiles: 501,
			files: Array.from({ length: 501 }, (_, index) => file(" M", `src/file-${index}.ts`)),
		};
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], status);
		const pageApi = api.getGitStatusPage;
		let cancelled = false;
		let pending = false;
		api.getGitStatusPage = (target, query, signal) => {
			if (!query?.cursor) return pageApi(target, query, signal);
			pending = true;
			return new Promise((_, reject) => {
				signal?.addEventListener(
					"abort",
					() => {
						cancelled = true;
						reject(new DOMException("Cancelled", "AbortError"));
					},
					{ once: true },
				);
			});
		};
		const container = renderTab(workspaceKey, client);
		await waitFor(
			() => !!container.querySelector('[aria-label="Expand folder src"]'),
			"first page",
		);
		await click(assertRangeFooter(container, "Load complete range"));
		await waitFor(
			() => pending && container.textContent?.includes("Cancel loading") === true,
			"cancel control",
		);
		await click(assertRangeFooter(container, "Cancel loading"));
		await waitFor(() => cancelled, "continuation abort");
		assertRangeFooter(container, "Load complete range");
		const directory = container.querySelector('[data-git-row-type="directory"]');
		expect(
			directory?.querySelector<HTMLButtonElement>('button[aria-label="Stage"]')?.disabled,
		).toBe(true);
		expect(directory?.textContent).toContain("100");
		client.clear();
	});

	test("explicit file ranges respect the existing write limit without splitting the action", async () => {
		const workspaceKey = "git-range-write-limit";
		const status: GitStatusSummary = {
			...makeMixedStatus(),
			staged: 0,
			unstaged: 1002,
			untracked: 0,
			totalFiles: 1002,
			files: [
				...Array.from({ length: 1001 }, (_, index) => file(" M", `src/mod-${index}.ts`)),
				file(" D", "src/deleted.ts"),
			],
		};
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], status);
		const actions: Array<{ name: string; body?: unknown }> = [];
		stubGitApi(actions, status);
		const container = renderTab(workspaceKey, client);
		await flushRender();
		await click(chipByLetter(container, "M"));
		expect(container.textContent).not.toContain("at most 1000");
		expect(buttonByText(container, "Stage Filtered").getAttribute("title")).toContain(
			"at most 1000",
		);
		expect(buttonByText(container, "Stage Filtered").disabled).toBe(true);
		await click(buttonByText(container, "Load complete range"));
		await waitFor(
			() =>
				container
					.querySelector('[data-git-row-type="directory"]')
					?.textContent?.includes("1001") === true,
			"full oversized directory",
		);
		expect(buttonByText(container, "Stage Filtered").disabled).toBe(true);
		const folderAction = container.querySelector<HTMLButtonElement>(
			'[data-git-row-type="directory"] button[aria-label="Stage"]',
		);
		expect(folderAction?.disabled).toBe(true);
		expect(folderAction?.parentElement?.getAttribute("title")).toContain("at most 1000");
		expect(actions).toEqual([]);
		client.clear();
	});

	test("a rejected snapshot scope is explained and its write is never retried", async () => {
		const workspaceKey = "git-scope-expired";
		const status = makeMixedStatus();
		const client = makeClient();
		client.setQueryData(["gitStatus", workspaceKey], status);
		stubGitApi([], status);
		let attempts = 0;
		api.gitStage = async (_target, body) => {
			attempts++;
			expect(body.snapshotScope).toEqual({
				snapshotId: "fixture:abc1234:M",
				filter: ["M"],
				section: "unstaged",
			});
			throw new ApiError("Git status snapshot expired", 409, { code: "GIT_STATUS_PAGE_EXPIRED" });
		};
		const container = renderTab(workspaceKey, client);
		await flushRender();
		await click(chipByLetter(container, "M"));
		await click(buttonByText(container, "Stage Filtered"));
		await waitFor(
			() => container.textContent?.includes("no changes were applied") === true,
			"expired range explanation",
		);
		await flushRender();
		expect(attempts).toBe(1);
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
