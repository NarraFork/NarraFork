/**
 * The Git branch bar and its picker.
 *
 * Real Mantine and the real query hooks; only the API boundary is stubbed, so the
 * assertions read the same DOM a user clicks — aria-labels, disabled state, and the
 * rows the picker actually renders.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { GitBranchEntry, GitBranches } from "@shared/git-branches";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { GitStatusSummary } from "../../hooks/useGit";
import { api } from "../../lib/api";
import type { GitTarget } from "../../lib/api/git";
import commonLocale from "../../locales/en/common.json";
import gitLocale from "../../locales/en/git.json";
import { ConfirmDialogProvider } from "../common/ConfirmDialogProvider";

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
const { GitBranchBar } = await import("./GitBranchBar");

const TARGET: GitTarget = {
	narratorId: "branch-narrator",
	workspaceKey: "device-a:/repo",
	repositoryKey: "device-a:/repo/.git",
	canWrite: true,
};

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

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

/**
 * The status hint deliberately differs from the listing, so "the branch name is on
 * screen" proves the slower branch query resolved instead of the fallback rendering.
 */
function status(overrides: Partial<GitStatusSummary> = {}): GitStatusSummary {
	return {
		hasChanges: false,
		staged: 0,
		unstaged: 0,
		untracked: 0,
		files: [],
		totalFiles: 0,
		totalFilesExact: true,
		headSha: "def5678",
		branch: "status-hint",
		linesAdded: 0,
		linesRemoved: 0,
		...overrides,
	};
}

function branch(name: string, overrides: Partial<GitBranchEntry> = {}): GitBranchEntry {
	return {
		name,
		sha: "abc1234",
		committedAt: "2026-08-01T10:00:00+08:00",
		subject: `${name} subject`,
		upstream: `origin/${name}`,
		ahead: 0,
		behind: 0,
		upstreamGone: false,
		worktreePath: null,
		...overrides,
	};
}

function listing(local: GitBranchEntry[], extra: Partial<GitBranches> = {}): GitBranches {
	return {
		headSha: "abc1234",
		branch: local[0]?.name ?? null,
		detached: false,
		local,
		remote: [],
		remotes: ["origin"],
		defaultRemote: "origin",
		truncated: false,
		...extra,
	};
}

let root: Root | undefined;
let client: QueryClient | undefined;
let pushed: Array<{ remote?: string; setUpstream?: boolean }>;
let fetched: Array<{ remote?: string; prune?: boolean }>;
let checkedOut: Array<{ branch: string; create?: boolean; startPoint?: string }>;
const originals = {
	getGitStatus: api.getGitStatus,
	getGitBranches: api.getGitBranches,
	gitPushBranch: api.gitPushBranch,
	gitFetchRemote: api.gitFetchRemote,
	gitCheckoutBranch: api.gitCheckoutBranch,
};

function stubApi() {
	api.getGitStatus = async () => status();
	api.getGitBranches = async () => listing([branch("main")]);
	// The API signatures make the body optional (it has a default). Giving these
	// stubs the same default narrows `body` back to the recorded type inside them.
	api.gitPushBranch = async (_target, body = {}) => {
		pushed.push(body);
		return {};
	};
	api.gitFetchRemote = async (_target, body = {}) => {
		fetched.push(body);
		return {};
	};
	api.gitCheckoutBranch = async (_target, body) => {
		checkedOut.push(body);
		return {};
	};
}

function renderBar(options: { readOnly?: boolean; target?: GitTarget } = {}) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY, refetchOnMount: false },
			mutations: { retry: false },
		},
	});
	client = queryClient;
	root = createRoot(container);
	root.render(
		<I18nextProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={queryClient}>
					<ConfirmDialogProvider>
						<GitBranchBar target={options.target ?? TARGET} readOnly={options.readOnly} />
					</ConfirmDialogProvider>
				</QueryClientProvider>
			</MantineProvider>
		</I18nextProvider>,
	);
	return container;
}

function teardown() {
	root?.unmount();
	root = undefined;
	client?.clear();
	client = undefined;
	document.body.replaceChildren();
}

function flushRender() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, what: string, attempts = 60) {
	for (let attempt = 0; attempt < attempts; attempt++) {
		// A predicate that looks elements up throws while React has not committed yet;
		// that is "not yet", not a failure, so keep polling.
		try {
			if (predicate()) return;
		} catch {
			/* keep polling */
		}
		await flushRender();
	}
	throw new Error(`timed out waiting for ${what}`);
}

function click(element: Element | null | undefined) {
	if (!element) throw new Error("cannot click a missing element");
	element.dispatchEvent(new Event("click", { bubbles: true }));
	return flushRender();
}

function buttonByLabel(scope: ParentNode, label: string): HTMLButtonElement {
	const button = scope.querySelector(`button[aria-label="${label}"]`);
	if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
	return button;
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement {
	const button = Array.from(scope.querySelectorAll("button")).find((candidate) =>
		candidate.textContent?.includes(text),
	);
	if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${text}`);
	return button;
}

/**
 * Type into a controlled input.
 *
 * React decides how to route a native `input` event from `isTextInputElement`,
 * which reads the DOM property `input.type` — and linkedom reports `null` there
 * instead of the reflected default `"text"`. React therefore drops the event and a
 * dispatched `input` never reaches `onChange`, no matter how it is dispatched.
 * Calling the element's own React `onChange` exercises the same handler the browser
 * would, without pretending the DOM layer works.
 */
function typeInto(input: HTMLInputElement, value: string) {
	const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps"));
	const props = propsKey
		? (input as unknown as Record<string, { onChange?: (event: unknown) => void }>)[propsKey]
		: undefined;
	if (!props?.onChange) throw new Error("input is not a controlled React input");
	props.onChange({ currentTarget: { value }, target: { value } });
	return flushRender();
}

function branchRows(): HTMLElement[] {
	return Array.from(document.body.querySelectorAll<HTMLElement>("[data-branch-name]"));
}

describe("GitBranchBar", () => {
	beforeEach(async () => {
		installDom();
		pushed = [];
		fetched = [];
		checkedOut = [];
		stubApi();
		await initTestI18n();
	});

	afterEach(() => {
		teardown();
		Object.assign(api, originals);
	});

	test("shows the current branch and keeps the name in the remaining space", async () => {
		const name = "fix/dashboard-unrestricted-branch-name";
		api.getGitBranches = async () =>
			listing([branch(name, { upstream: `origin/${name}` })], { branch: name });
		const container = renderBar();
		await waitFor(() => container.querySelector(`[title="${name}"]`) !== null, "branch name");

		// linkedom has no layout engine; verify the rendered flex sizing contract.
		const text = container.querySelector<HTMLElement>(`[title="${name}"]`);
		expect(text?.textContent).toBe(name);
		const group = text?.parentElement;
		expect(group?.style.flex).toBe("1");
		expect(group?.style.minWidth).toBe("0");
		expect(group?.style.maxWidth || "").toBe("");
		expect(text?.style.flexShrink).toBe("1");
		// The compact bar keeps the branch identity but not the HEAD hash.
		expect(container.textContent).not.toContain("abc1234");
	});

	test("shows ahead and behind counts, and names a gone upstream", async () => {
		api.getGitBranches = async () =>
			listing([branch("main", { ahead: 2, behind: 1 })], { branch: "main" });
		let container = renderBar();
		await waitFor(() => container.textContent?.includes("↑2") === true, "ahead badge");
		expect(container.textContent).toContain("↓1");
		teardown();

		api.getGitBranches = async () =>
			listing([branch("main", { upstreamGone: true })], { branch: "main" });
		container = renderBar();
		await waitFor(
			() => container.textContent?.includes(gitLocale["branches.upstreamGone"]) === true,
			"gone badge",
		);
	});

	test("push is disabled with nothing to send and sends without a dialog once ahead", async () => {
		// The default stub is up to date: nothing to push.
		let container = renderBar();
		await waitFor(() => container.textContent?.includes("main") === true, "branch chip");
		await waitFor(() => buttonByLabel(container, "Push") !== null, "push button");
		expect(buttonByLabel(container, "Push").disabled).toBe(true);
		teardown();

		api.getGitBranches = async () => listing([branch("main", { ahead: 2 })], { branch: "main" });
		container = renderBar();
		await waitFor(() => !buttonByLabel(container, "Push").disabled, "push enabled");
		await click(buttonByLabel(container, "Push"));
		await waitFor(() => pushed.length === 1, "push call");
		expect(pushed[0]).toEqual({ remote: "origin", setUpstream: false });
	});

	test("a branch without an upstream asks before creating it on the remote", async () => {
		api.getGitBranches = async () =>
			listing([branch("main", { ahead: 1, upstream: null })], { branch: "main" });
		const container = renderBar();
		await waitFor(() => !buttonByLabel(container, "Push").disabled, "push enabled");
		await click(buttonByLabel(container, "Push"));
		await waitFor(() => document.body.textContent?.includes("main") === true, "dialog text");
		await waitFor(() => buttonByText(document.body, "Confirm") !== null, "confirm dialog");
		expect(pushed).toEqual([]);
		await click(buttonByText(document.body, "Confirm"));
		await waitFor(() => pushed.length === 1, "confirmed push");
		expect(pushed[0]).toEqual({ remote: "origin", setUpstream: true });
	});

	test("fetch targets the default remote", async () => {
		api.getGitBranches = async () => listing([branch("main")], { branch: "main" });
		const container = renderBar();
		await waitFor(() => container.textContent?.includes("main") === true, "branch chip");
		await waitFor(
			() => !buttonByLabel(container, "Fetch remote branches").disabled,
			"fetch enabled",
		);
		await click(buttonByLabel(container, "Fetch remote branches"));
		await waitFor(() => fetched.length === 1, "fetch call");
		expect(fetched[0]).toEqual({ remote: "origin" });
	});

	test("a read-only workspace disables push and fetch but keeps the branch copyable", async () => {
		const container = renderBar({ readOnly: true });
		await waitFor(() => buttonByLabel(container, "Push") !== null, "push button");
		expect(buttonByLabel(container, "Push").disabled).toBe(true);
		expect(buttonByLabel(container, "Fetch remote branches").disabled).toBe(true);
		expect(buttonByLabel(container, "Copy branch name").disabled).toBe(false);
	});

	test("an executor that cannot list branches still names HEAD and refuses to push", async () => {
		api.getGitBranches = async () => {
			throw Object.assign(
				new Error("The device executor is too old to list branches; upgrade it"),
				{
					status: 409,
					data: { code: "GIT_BRANCHES_UNSUPPORTED" },
				},
			);
		};
		const container = renderBar();
		await waitFor(
			() => container.textContent?.includes("upgrade it") === true,
			"degraded error line",
		);
		// The status hint still names the branch, so the chip is not empty.
		expect(container.querySelector('[title="status-hint"]')).not.toBeNull();
		expect(buttonByLabel(container, "Push").disabled).toBe(true);
	});

	test("the picker searches, switches and creates branches", async () => {
		api.getGitBranches = async () => listing([branch("main"), branch("side")], { branch: "main" });
		const container = renderBar();
		await waitFor(() => container.textContent?.includes("main") === true, "branch chip");
		await click(container.querySelector('[aria-label="Open branch panel"]'));
		await waitFor(() => branchRows().length === 2, "branch rows");

		const search = document.body.querySelector<HTMLInputElement>(
			`input[placeholder="${gitLocale["branches.search"]}"]`,
		);
		if (!search) throw new Error("search input missing");
		await typeInto(search, "side");
		await waitFor(() => branchRows().length === 1, "filtered rows");
		await click(branchRows()[0] ?? null);
		await waitFor(() => checkedOut.length === 1, "switch call");
		expect(checkedOut[0]).toEqual({ branch: "side" });

		// Creating a branch sends `create` and no start point (HEAD).
		await click(container.querySelector('[aria-label="Open branch panel"]'));
		const nameInput = document.body.querySelector<HTMLInputElement>(
			`input[aria-label="${gitLocale["branches.create"]}"]`,
		);
		if (!nameInput) throw new Error("new branch input missing");
		await typeInto(nameInput, "feature/new");
		await waitFor(
			() => !buttonByText(document.body, "Create and switch").disabled,
			"create enabled",
		);
		await click(buttonByText(document.body, "Create and switch"));
		await waitFor(() => checkedOut.length === 2, "create call");
		expect(checkedOut[1]).toEqual({ branch: "feature/new", create: true });
	});

	test("a remote row creates its local branch from the remote ref", async () => {
		api.getGitBranches = async () =>
			listing([branch("main")], {
				branch: "main",
				remote: [branch("origin/feature/x", { upstream: null })],
			});
		const container = renderBar();
		await waitFor(() => container.textContent?.includes("main") === true, "branch chip");
		await click(container.querySelector('[aria-label="Open branch panel"]'));
		await waitFor(() => branchRows().length === 2, "remote row");
		const remoteRow = branchRows().find(
			(row) => row.getAttribute("data-branch-name") === "origin/feature/x",
		);
		await click(remoteRow ?? null);
		await waitFor(() => checkedOut.length === 1, "remote switch");
		expect(checkedOut[0]).toEqual({
			branch: "feature/x",
			create: true,
			startPoint: "origin/feature/x",
		});
	});

	test("a dirty worktree asks before a switch and cancelling changes nothing", async () => {
		api.getGitStatus = async () => status({ hasChanges: true });
		api.getGitBranches = async () => listing([branch("main"), branch("side")], { branch: "main" });
		const container = renderBar();
		await waitFor(() => container.textContent?.includes("main") === true, "branch chip");
		await click(container.querySelector('[aria-label="Open branch panel"]'));
		await waitFor(() => branchRows().length === 2, "branch rows");
		await click(
			branchRows().find((row) => row.getAttribute("data-branch-name") === "side") ?? null,
		);
		await waitFor(() => buttonByText(document.body, "Cancel") !== null, "dirty confirm");
		await click(buttonByText(document.body, "Cancel"));
		await flushRender();
		expect(checkedOut).toEqual([]);
	});

	test("the picker's fetch prunes deleted remote branches when asked", async () => {
		api.getGitBranches = async () =>
			listing([branch("main")], {
				branch: "main",
				remote: [branch("origin/main")],
			});
		const container = renderBar();
		await waitFor(() => container.textContent?.includes("main") === true, "branch chip");
		await click(container.querySelector('[aria-label="Open branch panel"]'));
		await waitFor(() => branchRows().length === 2, "remote row");

		const checkbox = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]');
		if (!checkbox) throw new Error("prune checkbox missing");
		// linkedom has no HTMLElement.click(); React's checkbox onChange reads the
		// click event, so set the state the platform would have set and dispatch it.
		checkbox.checked = true;
		checkbox.dispatchEvent(new Event("click", { bubbles: true }));
		await flushRender();
		const fetchButton = Array.from(document.body.querySelectorAll("button")).find((candidate) =>
			candidate.textContent?.includes(gitLocale["branches.fetch"]),
		);
		await click(fetchButton ?? null);
		await waitFor(() => fetched.length === 1, "fetch call");
		expect(fetched[0]).toEqual({ remote: "origin", prune: true });
	});
});
