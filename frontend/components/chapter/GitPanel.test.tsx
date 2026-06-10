import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "i18next";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { initReactI18next } from "react-i18next";
import type { GitStatusSummary } from "../../hooks/useGit";
import { api } from "../../lib/api";
import commonLocale from "../../locales/en/common.json";
import gitLocale from "../../locales/en/git.json";
import { ConfirmDialogProvider } from "../common/ConfirmDialogProvider";
import { GitPanel } from "./GitPanel";

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
	if (!i18n.isInitialized) {
		await i18n.use(initReactI18next).init({
			lng: "en",
			fallbackLng: "en",
			defaultNS: "common",
			ns: ["common", "git"],
			resources: {
				en: {
					common: commonLocale,
					git: gitLocale,
				},
			},
			interpolation: { escapeValue: false },
			react: { useSuspense: false },
		});
		return;
	}

	i18n.addResourceBundle("en", "common", commonLocale, true, true);
	i18n.addResourceBundle("en", "git", gitLocale, true, true);
	await i18n.changeLanguage("en");
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
			<MantineProvider>
				<QueryClientProvider client={queryClient}>
					<ConfirmDialogProvider>
						<GitPanel chapterId={chapterId} />
					</ConfirmDialogProvider>
				</QueryClientProvider>
			</MantineProvider>,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(container.textContent).toContain("Changes");
		expect(container.textContent).toContain("Staged");
		expect(container.textContent).toContain("src/staged.ts");
		expect(container.textContent).toContain("src/unstaged.ts");
		expect(container.textContent).toContain("Commit");

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
			<MantineProvider>
				<QueryClientProvider client={queryClient}>
					<ConfirmDialogProvider>
						<GitPanel chapterId={chapterId} />
					</ConfirmDialogProvider>
				</QueryClientProvider>
			</MantineProvider>,
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
