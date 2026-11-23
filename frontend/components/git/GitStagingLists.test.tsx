import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import {
	GIT_STAGING_UNASSIGNED_LIST_ID,
	GIT_STAGING_UNASSIGNED_LIST_NAME,
	type GitStagingAction,
	type GitStagingActionResult,
	type GitStagingDiff,
	type GitStagingFilesPage,
	type GitStagingSummary,
} from "@shared/git-staging-lists";
import type { GitStagingObservationState } from "@shared/git-workspace-events";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { type ReactNode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { useGitWorkspaceSubscription } from "../../hooks/useGit";
import { __resetGitStagingFolderPrefsCache } from "../../hooks/useGitStagingFolderPrefs";
import { api } from "../../lib/api";
import { ApiError } from "../../lib/api/client";
import type { GitTarget } from "../../lib/api/git";
import type { MessageCallback } from "../../lib/narrator-ws-manager";
import commonLocale from "../../locales/en/common.json";
import gitLocale from "../../locales/en/git.json";
import zhCommonLocale from "../../locales/zh-CN/common.json";
import zhGitLocale from "../../locales/zh-CN/git.json";
import { ConfirmDialogProvider } from "../common/ConfirmDialogProvider";
import {
	createGitChangesTestQueryClient,
	flushGitChangesTestRender as flush,
	installGitChangesTestTransport,
} from "./git-changes-list-test-fixture";

const wsListeners = new Set<MessageCallback>();
const wsSent: Record<string, unknown>[] = [];
let stateSequence = 0;
let stateEpoch = 1;
let autoObservation = true;
let wsVersion = 0;
let credential = 0;
let credentialPrincipal: unknown;
function credentialIdentity() {
	const principal = client?.getQueryData<{ id: string }>(["auth", "me"])?.id;
	if (principal !== credentialPrincipal) {
		credentialPrincipal = principal;
		credential++;
	}
	return credential;
}
function observationState(
	overrides: Partial<GitStagingObservationState> = {},
): GitStagingObservationState {
	return {
		instanceId: "ui-observer",
		stateSequence: ++stateSequence,
		epoch: stateEpoch,
		completedEpoch: stateEpoch,
		round: stateEpoch,
		status: "settled",
		generation: summary.generation,
		observationId: summary.observationId,
		...overrides,
	};
}
function emitObservation(observation: GitStagingObservationState) {
	for (const callback of wsListeners)
		callback({
			type: "git_workspace_staging_observation",
			version: ++wsVersion,
			subscriptionId: wsSent.filter((message) => message.type === "git_workspace_subscribe").at(-1)
				?.subscriptionId,
			workspaceKey: "w",
			narratorId: "ui",
			observation,
		});
}
mock.module("../../lib/narrator-ws-manager", () => ({
	narratorWSManager: {
		connected: true,
		getCredentialIdentity: credentialIdentity,
		getConnectionCredentialIdentity: credentialIdentity,
		send: (message: Record<string, unknown>) => {
			wsSent.push(message);
			if (message.type === "git_workspace_subscribe")
				queueMicrotask(() => {
					for (const callback of wsListeners) {
						callback({ ...message, type: "git_workspace_subscribed", version: ++wsVersion });
						if (autoObservation)
							callback({
								...message,
								type: "git_workspace_staging_observation",
								version: ++wsVersion,
								observation: observationState(),
							});
					}
				});
			return true;
		},
		addListener: (_options: unknown, callback: MessageCallback) => {
			wsListeners.add(callback);
			return callback;
		},
		removeListener: (callback: MessageCallback) => wsListeners.delete(callback),
		onConnectionChange: () => () => {},
	},
}));
const i18n = i18next.createInstance();
mock.module("../../lib/i18n", () => ({
	supportedLanguages: ["en", "zh-CN"],
	namespaces: ["common", "git"],
	normalizeLanguage: (language: string) => language ?? "en",
	getNamespacesForPath: () => ["common"],
	getInitialNamespaces: () => ["common"],
	ensureI18nNamespaces: async () => {},
	changeAppLanguage: async () => i18n,
	initI18n: async () => i18n,
	default: i18n,
}));
mock.module("./GitPatchView", () => ({
	GitPatchView: ({ diff, unitActions }: import("./GitPatchView").GitPatchViewProps) => (
		<div data-patch-mount>
			<pre>{diff}</pre>
			{unitActions?.units.map((unit) => (
				<div key={unit.id}>{unitActions.render(unit, false)}</div>
			))}
		</div>
	),
}));
mock.module("./GitChangesTab.module.css", () => ({
	default: { refreshing: "git-staging-refreshing-icon" },
}));
const { GitChangesTab } = await import("./GitChangesTab");
const { GitStagingWorkspace } = await import("./GitStagingLists");
const target: GitTarget = {
	narratorId: "ui",
	workspaceKey: "w",
	rootPath: "/repo",
	canWrite: true,
};
const version = { expectedGeneration: 1, observationId: "o1" };
const stats = { M: { files: 2, added: 17, removed: 9, binaryFiles: 0, gitlinkFiles: 0 } };
const file = {
	fileId: "f1",
	path: "file.txt",
	status: "M",
	unitCount: 2,
	needsReviewCount: 0,
	stats: { kind: "text" as const, added: 17, removed: 9 },
};
const originalApi = { ...api };
const globals = new Map<string, PropertyDescriptor | undefined>();
let root: Root;
let client: ReturnType<typeof createGitChangesTestQueryClient>;
let restore: () => void;
let summary: GitStagingSummary;
let actions: GitStagingAction[];
let nativeWrites: string[];
let fileReads: string[];
let actionResult: GitStagingActionResult;
let actionError: Error | undefined;
function filesPage(cursor?: string, nextCursor: string | null = null): GitStagingFilesPage {
	return {
		workspaceKey: "w",
		listId: "A",
		files: [{ ...file, fileId: cursor ?? "first", path: `${cursor ?? "first"}.txt` }],
		stats: { complete: true, total: stats, directories: [] },
		nextCursor,
		complete: nextCursor === null,
		snapshotVersion: "v1",
		generation: 1,
		observationId: "o1",
	};
}
function globalLineStats() {
	return document.querySelector("[data-git-staging-total-stats]");
}
function button(text: string) {
	const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")].filter(
		(entry) => entry.textContent?.trim() === text,
	);
	const found = buttons.find((entry) => !entry.disabled) ?? buttons[0];
	if (!found) throw new Error(`Missing button ${text}: ${document.body.textContent}`);
	return found;
}
async function click(element: Element) {
	if (!element) throw new Error("Missing click target");
	element.dispatchEvent(new window.Event("click", { bubbles: true }));
	await flush();
}
function change(input: Element, value: string | boolean) {
	const key = Object.keys(input).find((name) => name.startsWith("__reactProps$"));
	if (!key) throw new Error("Missing input owner");
	const props = (
		input as unknown as Record<
			string,
			{ onChange: (event: { currentTarget: { value?: string; checked?: boolean } }) => void }
		>
	)[key];
	props.onChange({ currentTarget: typeof value === "boolean" ? { checked: value } : { value } });
}
async function inputValue(input: Element, value: string | boolean) {
	change(input, value);
	await flush();
}
function WorkspaceOwner({ target, children }: { target: GitTarget; children: ReactNode }) {
	const subscriptions = useGitWorkspaceSubscription(target);
	const qc = useQueryClient();
	const principal = qc.getQueryData<{ id: string }>(["auth", "me"])?.id;
	useEffect(() => {
		if (principal) subscriptions.confirmWorkspace(target);
	});
	return children;
}
async function render(content = <GitStagingWorkspace target={target} />) {
	root.render(
		<QueryClientProvider client={client}>
			<I18nextProvider i18n={i18n}>
				<MantineProvider env="test">
					<ConfirmDialogProvider>
						<WorkspaceOwner target={(content.props as { target?: GitTarget }).target ?? target}>
							<div style={{ height: 700 }}>{content}</div>
						</WorkspaceOwner>
					</ConfirmDialogProvider>
				</MantineProvider>
			</I18nextProvider>
		</QueryClientProvider>,
	);
	await flush();
}
async function menu(id: string, label: string) {
	await click(document.querySelector(`[data-git-staging-more='${id}']`) as Element);
	await click(button(label));
}
beforeEach(async () => {
	__resetGitStagingFolderPrefsCache();
	wsListeners.clear();
	wsSent.length = 0;
	stateSequence = 0;
	stateEpoch = 1;
	autoObservation = true;
	wsVersion = 0;
	const { window } = parseHTML("<html><head></head><body><div id='root'></div></body></html>");
	const store = new Map<string, string>();
	const storage = {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => store.set(key, value),
		removeItem: (key: string) => store.delete(key),
	};
	class ResizeObserver {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	const matchMedia = (media: string) => ({
		media,
		matches: false,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
	});
	Object.assign(window, {
		ResizeObserver,
		matchMedia,
		localStorage: storage,
		sessionStorage: storage,
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		cancelAnimationFrame: clearTimeout,
	});
	for (const [key, value] of Object.entries({
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
		ResizeObserver,
		matchMedia,
		localStorage: storage,
		sessionStorage: storage,
		requestAnimationFrame: window.requestAnimationFrame,
		cancelAnimationFrame: window.cancelAnimationFrame,
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		IS_REACT_ACT_ENVIRONMENT: false,
	})) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	if (!i18n.isInitialized)
		await i18n.use(initReactI18next).init({
			lng: "en",
			fallbackLng: "en",
			defaultNS: "common",
			ns: ["common", "git"],
			resources: {
				en: { common: commonLocale, git: gitLocale },
				"zh-CN": { common: zhCommonLocale, git: zhGitLocale },
			},
			interpolation: { escapeValue: false },
			react: { useSuspense: false },
		});
	await i18n.changeLanguage("en");
	restore = installGitChangesTestTransport({ mockWorkspace: false });
	client = createGitChangesTestQueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
	});
	summary = {
		capability: { supported: true },
		workspaceKey: "w",
		initialized: true,
		generation: 1,
		observationId: "o1",
		activeListId: "A",
		scannedAt: 1,
		state: "ready",
		stats,
		lists: ["A", "B"].map((id) => ({
			id,
			name: id === "A" ? "Alpha" : "Beta",
			active: id === "A",
			fileCount: 2,
			unitCount: 2,
			added: 17,
			removed: 9,
			needsReviewCount: 0,
			stats,
			snapshotVersion: "v1",
		})),
	};
	actions = [];
	nativeWrites = [];
	fileReads = [];
	actionError = undefined;
	actionResult = {
		outcome: "applied",
		listId: "A",
		generation: 1,
		observationId: "o1",
		affectedListIds: ["A", "B"],
	};
	client.setQueryData(["gitStatus", "w"], {
		branch: "main",
		staged: 1,
		unstaged: 1,
		untracked: 0,
		totalFiles: 1,
		totalFilesExact: true,
		hasChanges: true,
		files: [{ status: "MM", path: "file.txt" }],
	});
	api.getGitStagingLists = async () => summary;
	api.getGitStagingFiles = async (_target, listId) => {
		fileReads.push(listId);
		return {
			workspaceKey: "w",
			listId,
			files: [file],
			stats: { complete: true, total: stats, directories: [] },
			nextCursor: null,
			complete: true,
			snapshotVersion: "v1",
			generation: summary.generation,
			observationId: summary.observationId,
		};
	};
	api.getGitStagingDiff = async () => ({
		path: "file.txt",
		diff: "truncated ownership preview",
		truncated: true,
		snapshotVersion: "v1",
		generation: summary.generation,
		observationId: summary.observationId,
		units: ["unit-a", "unit-b"].map((id, index) => ({
			id,
			fileId: "f1",
			path: "file.txt",
			kind: "text",
			listId: "A",
			baseStart: index * 20,
			baseEnd: index * 20 + 1,
			workStart: index * 20,
			workEnd: index * 20 + 2,
			added: 2,
			removed: 1,
			needsReview: false,
		})),
	});
	api.getGitLineStats = async () => ({ files: [], linesAdded: 0, linesRemoved: 0, complete: true });
	api.gitStagingAction = async (_target, action) => {
		actions.push(action);
		if (actionError) throw actionError;
		return {
			...actionResult,
			observation: observationState({
				generation: actionResult.generation,
				observationId: actionResult.observationId,
			}),
		};
	};
	api.gitStage = async () => {
		nativeWrites.push("stage");
		return {};
	};
	api.gitUnstage = async () => {
		nativeWrites.push("unstage");
		return {};
	};
	api.gitCommit = async () => {
		nativeWrites.push("commit");
		return {};
	};
	root = createRoot(document.getElementById("root") as HTMLElement);
});
afterEach(async () => {
	root.unmount();
	client.clear();
	restore();
	Object.assign(api, originalApi);
	await flush();
	for (const [key, value] of globals) {
		if (value) Object.defineProperty(globalThis, key, value);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});

test("native view preserves ordinary stage, unstage and commit without group actions", async () => {
	api.gitAiCommitMessage = async () => ({ message: "native commit" });
	await render(<GitChangesTab target={target} />);
	expect(fileReads).toEqual([]);
	await click(button("Stage All"));
	await click(button("Unstage All"));
	await click(document.querySelector("button[aria-label='AI Generate']") as Element);
	await click(button("Commit (1)"));
	expect(nativeWrites).toEqual(["stage", "unstage", "commit"]);
	expect(actions).toEqual([]);
});
test("view switches do not write and group mode never duplicates native unstaged rows", async () => {
	await render(<GitChangesTab target={target} />);
	await click(button("ChangeLists"));
	expect(document.querySelector("[data-git-staging-toggle='A']")).not.toBeNull();
	expect(document.querySelector("[data-git-change-row='unstaged:section']")).toBeNull();
	expect(document.querySelector("input[placeholder='Commit message...']")).toBeNull();
	await click(button("Git staging area"));
	expect(button("Stage All").disabled).toBe(false);
	expect(actions).toEqual([]);
	expect(nativeWrites).toEqual([]);
});
function expansionFiles() {
	api.getGitStagingFiles = async (currentTarget, listId) => ({
		workspaceKey: currentTarget.workspaceKey,
		listId,
		files: [{ ...file, path: "src/file.ts" }],
		stats: { complete: true, total: stats, directories: [] },
		nextCursor: null,
		complete: true,
		snapshotVersion: "v1",
		generation: summary.generation,
		observationId: summary.observationId,
	});
}
function groupToggle(id = "A") {
	return document.querySelector(`[data-git-staging-toggle='${id}']`) as Element;
}
function directory(path = "src") {
	return document.querySelector(`[data-git-staging-directory='${path}']`);
}
function expandedFile() {
	return document.querySelector("[data-git-staging-file='src/file.ts']");
}
test("group and folder expansion survive native/groups view remounts", async () => {
	expansionFiles();
	await render(<GitChangesTab target={target} />);
	await click(button("ChangeLists"));
	await click(groupToggle());
	await click(directory() as Element);
	expect(expandedFile()).not.toBeNull();
	await click(button("Git staging area"));
	expect(expandedFile()).toBeNull();
	await click(button("ChangeLists"));
	expect(expandedFile()).not.toBeNull();
	expect(directory()?.getAttribute("aria-expanded")).toBe("true");
	expect(actions).toEqual([]);
	expect(nativeWrites).toEqual([]);
});
test.each([
	"workspace",
	"narrator",
])("returning to a %s restores that scope's expansion", async (kind) => {
	expansionFiles();
	api.getGitStagingLists = async (current) => ({ ...summary, workspaceKey: current.workspaceKey });
	await render();
	await click(groupToggle());
	await click(directory() as Element);
	const other = {
		...target,
		...(kind === "workspace" ? { workspaceKey: "other" } : { narratorId: "other" }),
	};
	await render(<GitStagingWorkspace target={other} />);
	expect(expandedFile()).toBeNull();
	expect(directory()).toBeNull();
	await click(groupToggle());
	expect(directory()?.getAttribute("aria-expanded")).toBe("false");
	await render();
	expect(expandedFile()).not.toBeNull();
	await render(<GitStagingWorkspace target={other} />);
	expect(expandedFile()).toBeNull();
	expect(directory()?.getAttribute("aria-expanded")).toBe("false");
	await render();
	expect(expandedFile()).not.toBeNull();
});

test("returning signed-in users restore only their own expansion", async () => {
	expansionFiles();
	const principal = client.getQueryData(["auth", "me"]);
	await render();
	await click(groupToggle());
	await click(directory() as Element);
	client.setQueryData(["auth", "me"], { id: "fixture-bob" });
	await flush();
	expect(expandedFile()).toBeNull();
	expect(directory()).toBeNull();
	await click(groupToggle());
	expect(directory()?.getAttribute("aria-expanded")).toBe("false");
	client.setQueryData(["auth", "me"], principal);
	await flush();
	expect(expandedFile()).not.toBeNull();
});

test("closing groups keeps list-local folders; explicitly closing folders survives remounts", async () => {
	expansionFiles();
	await render();
	await click(groupToggle());
	await click(directory() as Element);
	await click(groupToggle("B"));
	const folders = [...document.querySelectorAll("[data-git-staging-directory='src']")];
	expect(folders.map((entry) => entry.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
	await click(groupToggle());
	expect(expandedFile()).toBeNull();
	await click(groupToggle());
	expect(expandedFile()).not.toBeNull();
	await click(directory() as Element);
	await render(<div />);
	__resetGitStagingFolderPrefsCache();
	await render();
	expect(expandedFile()).toBeNull();
	expect(directory()?.getAttribute("aria-expanded")).toBe("false");
});

test("tree/list, filters and summary generations retain expanded folders", async () => {
	expansionFiles();
	await render();
	await click(groupToggle());
	await click(directory() as Element);
	await click(button("List"));
	expect(directory()).toBeNull();
	expect(expandedFile()).not.toBeNull();
	await click(button("Tree"));
	expect(expandedFile()).not.toBeNull();
	await click(button("M 2"));
	expect(expandedFile()).not.toBeNull();
	await click(button("Clear filter"));
	expect(expandedFile()).not.toBeNull();
	const lists = summary.lists;
	summary = { ...summary, lists: [], generation: 2, observationId: "o2" };
	stateEpoch = 2;
	emitObservation(observationState());
	await flush();
	expect(groupToggle()).toBeNull();
	summary = { ...summary, lists, generation: 3, observationId: "o3" };
	stateEpoch = 3;
	emitObservation(observationState());
	await flush();
	expect(expandedFile()).not.toBeNull();
	expect(directory()?.getAttribute("aria-expanded")).toBe("true");
});

test.each([
	"logout",
	"refusal",
])("remembered expansion cannot expose contents after %s", async (reason) => {
	expansionFiles();
	await render();
	await click(groupToggle());
	await click(directory() as Element);
	expect(expandedFile()).not.toBeNull();
	if (reason === "logout") client.setQueryData(["auth", "me"], { id: null });
	else {
		api.getGitStagingLists = async () => {
			throw new ApiError("Forbidden", 403);
		};
		await client.refetchQueries({ queryKey: ["gitStagingLists", "w"] });
	}
	await flush();
	expect(groupToggle()).toBeNull();
	expect(directory()).toBeNull();
	expect(expandedFile()).toBeNull();
	await render(<div />);
	await render();
	expect(groupToggle()).toBeNull();
	expect(expandedFile()).toBeNull();
});

test("toolbar totals cover every status before any group files are read", async () => {
	summary = {
		...summary,
		stats: {
			...stats,
			A: { files: 3, added: 6, removed: 0, binaryFiles: 0, gitlinkFiles: 0 },
			D: { files: 1, added: 0, removed: 4, binaryFiles: 0, gitlinkFiles: 0 },
		},
	};
	const readLines = mock(async () => ({
		files: [],
		linesAdded: 0,
		linesRemoved: 0,
		complete: true,
	}));
	api.getGitLineStats = readLines;
	await render();
	expect(globalLineStats()?.textContent).toBe("+23-13");
	expect(document.querySelector("[aria-label='6 changed files']")).not.toBeNull();
	expect(globalLineStats()?.parentElement?.querySelector("button")?.textContent).toBe("Tree");
	expect(fileReads).toEqual([]);
	expect(readLines).not.toHaveBeenCalled();
	expect(actions).toEqual([]);
});

test("a file shared by two expanded groups is counted once in toolbar totals", async () => {
	summary = {
		...summary,
		stats: { M: { ...stats.M, files: 1 } },
		lists: summary.lists.map((entry, index) => {
			const totals = { ...stats.M, files: 1, added: index ? 7 : 10, removed: index ? 5 : 4 };
			return {
				...entry,
				fileCount: 1,
				added: totals.added,
				removed: totals.removed,
				stats: { M: totals },
			};
		}),
	};
	api.getGitStagingFiles = async (_target, listId) => {
		fileReads.push(listId);
		const list = summary.lists.find((entry) => entry.id === listId);
		if (!list) throw new Error(`Missing fixture ChangeList ${listId}`);
		return {
			...filesPage(),
			listId,
			files: [{ ...file, stats: { kind: "text", added: list.added, removed: list.removed } }],
			stats: { complete: true, total: list.stats, directories: [] },
		};
	};
	await render();
	expect(globalLineStats()?.textContent).toBe("+17-9");
	await click(document.querySelector("[data-git-staging-toggle='A']") as Element);
	await click(document.querySelector("[data-git-staging-toggle='B']") as Element);
	expect(fileReads).toEqual(["A", "B"]);
	expect(document.querySelectorAll("[data-git-staging-file='file.txt']")).toHaveLength(2);
	expect(document.querySelector("[aria-label='1 changed files']")).not.toBeNull();
	expect(globalLineStats()?.textContent).toBe("+17-9");
});

test("status filters keep the toolbar totals for the entire workspace", async () => {
	summary = {
		...summary,
		stats: {
			...stats,
			A: { files: 3, added: 6, removed: 4, binaryFiles: 0, gitlinkFiles: 0 },
		},
	};
	await render();
	for (const label of ["A 3", "M 2", "Clear filter"]) {
		await click(button(label));
		expect(globalLineStats()?.textContent).toBe("+23-13");
	}
	expect(fileReads).toEqual([]);
	expect(actions).toEqual([]);
});

test("expansion progressively shows every page with a loading indicator and no continuation button", async () => {
	let resolve!: (page: GitStagingFilesPage) => void;
	const pending = new Promise<GitStagingFilesPage>((done) => {
		resolve = done;
	});
	const calls: Array<string | undefined> = [];
	api.getGitStagingFiles = async (_target, listId, query) => {
		fileReads.push(listId);
		calls.push(query?.cursor);
		if (query?.cursor === "second") return pending;
		return filesPage(query?.cursor, query?.cursor ? null : "second");
	};
	await render();
	expect(fileReads).toEqual([]);
	expect(globalLineStats()?.textContent).toBe("+17-9");
	await click(document.querySelector("[data-git-staging-toggle='A']") as Element);
	expect(calls).toEqual([undefined, "second"]);
	expect(globalLineStats()?.textContent).toBe("+17-9");
	expect(document.querySelector("[data-git-staging-file='first.txt']")).not.toBeNull();
	expect(document.querySelector("[data-git-staging-loading='A']")).not.toBeNull();
	expect(document.querySelector("[data-git-staging-load-more]")).toBeNull();
	expect(document.querySelector("[data-git-staging-retry]")).toBeNull();
	resolve(filesPage("second", "last"));
	await flush();
	await flush();
	expect(calls).toEqual([undefined, "second", "last"]);
	expect(fileReads).toEqual(["A", "A", "A"]);
	expect(globalLineStats()?.textContent).toBe("+17-9");
	expect(document.querySelector("[data-git-staging-file='last.txt']")).not.toBeNull();
	expect(document.querySelector("[data-git-staging-loading]")).toBeNull();
	expect(actions).toEqual([]);
});

test("failed paging keeps visible files and an explicit retry resumes through the last page", async () => {
	let fail = true;
	const calls: Array<string | undefined> = [];
	api.getGitStagingFiles = async (_target, _listId, query) => {
		calls.push(query?.cursor);
		if (query?.cursor === "second" && fail) throw new Error("page unavailable");
		return filesPage(
			query?.cursor,
			!query?.cursor ? "second" : query.cursor === "second" ? "last" : null,
		);
	};
	await render();
	await click(document.querySelector("[data-git-staging-toggle='A']") as Element);
	expect(document.querySelector("[data-git-staging-file='first.txt']")).not.toBeNull();
	expect(document.querySelector("[role='alert']")?.textContent).toContain(
		gitLocale["staging.filesReadFailed"],
	);
	expect(calls).toEqual([undefined, "second"]);
	fail = false;
	await click(document.querySelector("[data-git-staging-retry='A']") as Element);
	await flush();
	expect(calls).toEqual([undefined, "second", "second", "last"]);
	expect(document.querySelector("[data-git-staging-file='last.txt']")).not.toBeNull();
	expect(document.querySelector("[data-git-staging-retry]")).toBeNull();
	expect(document.querySelector("[role='alert']")).toBeNull();
});

test("a refetch cursor cycle preserves visible files and row retry rebuilds a valid chain", async () => {
	let phase: "initial" | "cycle" | "recovered" = "initial";
	const calls: Array<string | undefined> = [];
	api.getGitStagingFiles = async (_target, _listId, query) => {
		const cursor = query?.cursor;
		calls.push(cursor);
		if (phase === "initial") return filesPage(cursor, !cursor ? "a" : cursor === "a" ? "b" : null);
		return filesPage(cursor, !cursor ? "x" : cursor === "x" ? "y" : phase === "cycle" ? "x" : null);
	};
	await render();
	await click(document.querySelector("[data-git-staging-toggle='A']") as Element);
	expect(document.querySelector("[data-git-staging-file='b.txt']")).not.toBeNull();
	phase = "cycle";
	await client.refetchQueries({ queryKey: ["gitStagingFiles", "w", "A"] });
	await flush();
	expect(calls).toEqual([undefined, "a", "b", undefined, "x", "y"]);
	expect(document.querySelector("[data-git-staging-file='b.txt']")).not.toBeNull();
	expect(document.querySelector("[data-git-staging-file='x.txt']")).toBeNull();
	expect(document.querySelector("[data-git-staging-retry='A']")).not.toBeNull();
	phase = "recovered";
	await click(document.querySelector("[data-git-staging-retry='A']") as Element);
	await flush();
	expect(calls).toEqual([undefined, "a", "b", undefined, "x", "y", undefined, "x", "y"]);
	expect(document.querySelector("[data-git-staging-file='y.txt']")).not.toBeNull();
	expect(document.querySelector("[data-git-staging-file='b.txt']")).toBeNull();
	expect(document.querySelector("[data-git-staging-retry]")).toBeNull();
	expect(document.querySelector("[role='alert']")).toBeNull();
});

test("an incomplete terminal page keeps its valid prefix and exposes retry instead of EOF", async () => {
	const calls: Array<string | undefined> = [];
	let incomplete = true;
	api.getGitStagingFiles = async (_target, _listId, query) => {
		calls.push(query?.cursor);
		return {
			...filesPage(query?.cursor, query?.cursor ? null : "second"),
			complete: query?.cursor ? !incomplete : false,
		};
	};
	await render();
	await click(document.querySelector("[data-git-staging-toggle='A']") as Element);
	expect(calls).toEqual([undefined, "second"]);
	expect(document.querySelector("[data-git-staging-file='first.txt']")).not.toBeNull();
	expect(document.querySelector("[data-git-staging-file='second.txt']")).toBeNull();
	expect(document.querySelector("[data-git-staging-retry='A']")).not.toBeNull();
	incomplete = false;
	await click(document.querySelector("[data-git-staging-retry='A']") as Element);
	expect(calls).toEqual([undefined, "second", "second"]);
	expect(document.querySelector("[data-git-staging-file='second.txt']")).not.toBeNull();
	expect(document.querySelector("[data-git-staging-retry]")).toBeNull();
});

test.each([
	{
		name: "an empty observation",
		files: 0,
		binary: 0,
		gitlink: 0,
		added: 0,
		removed: 0,
		text: "+0-0",
	},
	{
		name: "a zero-line text change",
		files: 1,
		binary: 0,
		gitlink: 0,
		added: 0,
		removed: 0,
		text: "+0-0",
	},
	{
		name: "an addition-only text change",
		files: 1,
		binary: 0,
		gitlink: 0,
		added: 17,
		removed: 0,
		text: "+17-0",
	},
	{
		name: "a deletion-only text change",
		files: 1,
		binary: 0,
		gitlink: 0,
		added: 0,
		removed: 9,
		text: "+0-9",
	},
	{ name: "a binary change", files: 1, binary: 1, gitlink: 0, added: 0, removed: 0, text: "" },
	{ name: "a gitlink change", files: 1, binary: 0, gitlink: 1, added: 0, removed: 0, text: "" },
	{
		name: "only non-text changes",
		files: 2,
		binary: 1,
		gitlink: 1,
		added: 0,
		removed: 0,
		text: "",
	},
	{
		name: "text and non-text changes",
		files: 3,
		binary: 1,
		gitlink: 1,
		added: 17,
		removed: 9,
		text: "+17-9",
	},
])("toolbar totals preserve measured zero and non-text semantics for $name", async (entry) => {
	summary = {
		...summary,
		stats: entry.files
			? {
					M: {
						files: entry.files,
						added: entry.added,
						removed: entry.removed,
						binaryFiles: entry.binary,
						gitlinkFiles: entry.gitlink,
					},
				}
			: {},
	};
	await render();
	expect(globalLineStats()).not.toBeNull();
	expect(globalLineStats()?.textContent).toBe(entry.text);
	if (entry.binary || entry.gitlink) {
		const label = i18n.t("staging.nonTextStats", {
			ns: "git",
			binary: entry.binary,
			gitlink: entry.gitlink,
		});
		expect(globalLineStats()?.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe(
			label,
		);
	} else expect(globalLineStats()?.querySelector("[aria-label]")).toBeNull();
});

test("a missing summary keeps totals hidden until an observation is available", async () => {
	let resolve!: (value: GitStagingSummary) => void;
	api.getGitStagingLists = async () =>
		new Promise((done) => {
			resolve = done;
		});
	await render();
	expect(globalLineStats()).toBeNull();
	resolve(summary);
	await flush();
	expect(globalLineStats()?.textContent).toBe("+17-9");
});

test("an initialized store without a published observation does not synthesize zero totals", async () => {
	summary = {
		...summary,
		generation: 0,
		observationId: null,
		scannedAt: null,
		state: "uninitialized",
		stats: {},
	};
	await render();
	expect(globalLineStats()).toBeNull();
});

test("switching workspace scopes hides former totals while the new summary loads", async () => {
	await render();
	expect(globalLineStats()?.textContent).toBe("+17-9");
	let resolve!: (value: GitStagingSummary) => void;
	api.getGitStagingLists = async () =>
		new Promise((done) => {
			resolve = done;
		});
	await render(
		<GitStagingWorkspace target={{ ...target, workspaceKey: "other", rootPath: "/other" }} />,
	);
	expect(globalLineStats()).toBeNull();
	resolve({
		...summary,
		workspaceKey: "other",
		stats: { A: { ...stats.M, files: 1, added: 2, removed: 1 } },
	});
	await flush();
	expect(globalLineStats()?.textContent).toBe("+2-1");
});

test("switching signed-in users hides former totals until an authorized summary loads", async () => {
	await render();
	expect(globalLineStats()?.textContent).toBe("+17-9");
	let resolve!: (value: GitStagingSummary) => void;
	api.getGitStagingLists = async () =>
		new Promise((done) => {
			resolve = done;
		});
	client.setQueryData(["auth", "me"], { id: "fixture-bob" });
	await flush();
	expect(globalLineStats()).toBeNull();
	resolve({ ...summary, stats: {} });
	await flush();
	expect(globalLineStats()?.textContent).toBe("+0-0");
});

test("a refused summary read removes previously visible workspace totals", async () => {
	await render();
	expect(globalLineStats()?.textContent).toBe("+17-9");
	api.getGitStagingLists = async () => {
		throw new ApiError("Forbidden", 403);
	};
	await client.refetchQueries({ queryKey: ["gitStagingLists", "w"] });
	await flush();
	expect(globalLineStats()).toBeNull();
});

test("observation updates retain published totals as busy until new totals arrive", async () => {
	await render();
	expect(globalLineStats()?.getAttribute("aria-busy")).toBe("false");
	stateEpoch = 2;
	emitObservation(observationState({ status: "observing", completedEpoch: 1 }));
	await flush();
	expect(globalLineStats()?.textContent).toBe("+17-9");
	expect(globalLineStats()?.getAttribute("aria-busy")).toBe("true");
	summary = {
		...summary,
		generation: 2,
		observationId: "o2",
		stats: { M: { ...stats.M, added: 24, removed: 11 } },
	};
	emitObservation(observationState());
	await flush();
	expect(globalLineStats()?.textContent).toBe("+24-11");
	expect(globalLineStats()?.getAttribute("aria-busy")).toBe("false");
});

test("first use offers explicit initialization and performs no write until clicked", async () => {
	summary = {
		...summary,
		initialized: false,
		generation: 0,
		observationId: null,
		activeListId: null,
		state: "uninitialized",
		lists: [],
		stats: {},
	};
	await render();
	expect(actions).toEqual([]);
	expect(fileReads).toEqual([]);
	expect(globalLineStats()).toBeNull();
	await click(button("Initialize ChangeLists"));
	expect(actions).toEqual([{ action: "init" }]);
});
test("create and rename pin the observation without expanding a group", async () => {
	await render();
	await click(button("New ChangeList"));
	await inputValue(document.querySelector("[role='dialog'] input") as Element, "Docs");
	await click(button("Save"));
	expect(actions[0]).toEqual({ action: "create", name: "Docs", ...version });
	await menu("B", "Rename");
	await inputValue(document.querySelector("[role='dialog'] input") as Element, "Beta 2");
	await click(button("Save"));
	expect(actions[1]).toEqual({ action: "rename", listId: "B", name: "Beta 2", ...version });
	expect(fileReads).toEqual([]);
});
test("active group cannot be deleted; another group deletion confirms its destination", async () => {
	await render();
	await click(document.querySelector("[data-git-staging-more='A']") as Element);
	expect(button("Delete ChangeList").disabled).toBe(true);
	await click(document.querySelector("[data-git-staging-more='A']") as Element);
	await click(document.querySelector("[data-git-staging-more='B']") as Element);
	await click(button("Delete ChangeList"));
	expect(actions).toEqual([]);
	expect(document.querySelector("[role='dialog']")?.textContent).toContain(
		"active ChangeList Alpha",
	);
	await click(document.querySelector("[data-git-staging-confirm-delete]") as Element);
	expect(actions).toEqual([{ action: "delete", listId: "B", ...version }]);
	expect(fileReads).toEqual([]);
});
test("setting an active group sends the explicit backend action", async () => {
	await render();
	await menu("B", "Set active");
	expect(actions).toEqual([{ action: "activate", listId: "B", ...version }]);
	expect(fileReads).toEqual([]);
});
test.each([
	{
		id: GIT_STAGING_UNASSIGNED_LIST_ID,
		name: GIT_STAGING_UNASSIGNED_LIST_NAME,
		display: "未分组",
	},
	{ id: GIT_STAGING_UNASSIGNED_LIST_ID, name: "待整理", display: "待整理" },
	{
		id: "8a210c15-0f5d-4a2d-9b29-03c209b21621",
		name: GIT_STAGING_UNASSIGNED_LIST_NAME,
		display: "Unassigned",
	},
])("Chinese list surfaces preserve the identity and stored name of $id / $name", async (entry) => {
	await i18n.changeLanguage("zh-CN");
	summary = {
		...summary,
		lists: summary.lists.map((list) =>
			list.id === "B" ? { ...list, id: entry.id, name: entry.name } : list,
		),
	};
	await render();
	const row = document.querySelector(`[data-git-staging-toggle='${entry.id}']`) as Element;
	expect(row.getAttribute("aria-label")).toContain(entry.display);
	expect(row.querySelector(`[title='${entry.display}']`)?.textContent).toBe(entry.display);
	expect(row.querySelector("input")?.getAttribute("aria-label")).toContain(entry.display);
	expect(row.querySelector("button")?.getAttribute("aria-label")).toContain(entry.display);
	await menu(entry.id, `提交「${entry.display}」`);
	expect(document.querySelector("[role='dialog']")?.textContent).toContain(
		`提交「${entry.display}」`,
	);
	await click(button("取消"));
	await menu(entry.id, "重命名");
	const name = document.querySelector<HTMLInputElement>(
		"[role='dialog'] input",
	) as HTMLInputElement;
	expect(name.value).toBe(entry.name);
	const typedName = `${entry.name} 2`;
	await inputValue(name, typedName);
	await i18n.changeLanguage("en");
	await flush();
	expect(name.value).toBe(typedName);
	await i18n.changeLanguage("zh-CN");
	await flush();
	expect(name.value).toBe(typedName);
	await inputValue(name, entry.name);
	await click(button("保存"));
	expect(actions).toEqual([{ action: "rename", listId: entry.id, name: entry.name, ...version }]);
	expect(summary.lists.find((list) => list.id === entry.id)?.name).toBe(entry.name);
	await menu(entry.id, "删除分组");
	expect(document.querySelector("[role='dialog']")?.textContent).toContain(
		`删除「${entry.display}」？`,
	);
	await click(button("取消"));
	await menu("A", "移动到组");
	expect(
		document.querySelector(`[data-git-staging-picker] [data-git-staging-target='${entry.id}']`)
			?.textContent,
	).toBe(entry.display);
});

test.each([
	"tree",
	"flat",
])("%s file rows preserve complete renamed paths with single-line left truncation", async (mode) => {
	const path = `remote-executor/${"中文目录-with-hyphens/".repeat(55)}handlers/git_line_stats.go`;
	const oldPath = "legacy-executor/旧目录[1]/git_line_stats.go";
	api.getGitStagingFiles = async (_target, listId) => ({
		...filesPage(),
		listId,
		files: [{ ...file, path, oldPath, status: "R" }],
	});
	await render();
	if (mode === "flat") await click(button("List"));
	await click(groupToggle());
	if (mode === "tree") {
		const folder = directory(path.slice(0, path.lastIndexOf("/"))) as Element;
		expect(folder).not.toBeNull();
		expect(folder.querySelector("[data-line-clamp]")).not.toBeNull();
		await click(folder);
	}
	const row = document.querySelector(`[data-git-staging-file='${path}']`) as HTMLElement;
	expect(row).not.toBeNull();
	const text = row.querySelector<HTMLElement>("bdo[dir='ltr']")?.parentElement;
	expect(text?.textContent).toBe(mode === "tree" ? "git_line_stats.go" : path);
	expect(text?.getAttribute("title")).toBe(`${oldPath} → ${path}`);
	expect(text?.getAttribute("data-truncate")).toBe("end");
	expect(text?.hasAttribute("data-line-clamp")).toBe(false);
	expect(text?.style.direction).toBe("rtl");
	expect(text?.style.flex).toBe("1");
	expect(text?.style.minWidth).toBe("0");
	const lineStats = row.querySelector<HTMLElement>("[aria-busy]");
	expect(lineStats?.textContent).toBe("+17-9");
	expect(lineStats?.style.flexShrink).toBe("0");
	expect(row.querySelector("input")?.getAttribute("aria-label")).toBe(`Select ${path}`);
	await click(row.querySelector("button") as Element);
	await click(document.querySelector("[data-git-staging-target='B']") as Element);
	expect(actions).toEqual([
		{ action: "move", fromListId: "A", toListId: "B", paths: [path], ...version },
	]);
	expect(nativeWrites).toEqual([]);
});

test("file move sends only its source group and path, preserving other group units in that file", async () => {
	await render();
	await click(document.querySelector("[data-git-staging-toggle='A']") as Element);
	const row = document.querySelector("[data-git-staging-file='file.txt']") as Element;
	await click(row.querySelector("button") as Element);
	expect(actions).toEqual([]);
	await click(document.querySelector("[data-git-staging-target='B']") as Element);
	expect(actions).toEqual([
		{ action: "move", fromListId: "A", toListId: "B", paths: ["file.txt"], ...version },
	]);
	expect(nativeWrites).toEqual([]);
	expect(document.body.textContent).not.toContain("truncated ownership preview");
});
test("select-all operates on the complete filtered group while it remains collapsed", async () => {
	summary = {
		...summary,
		stats: { ...stats, A: { files: 8, added: 8, removed: 0, binaryFiles: 0, gitlinkFiles: 0 } },
		lists: summary.lists.map((entry) => ({
			...entry,
			fileCount: 10,
			stats: { ...stats, A: { files: 8, added: 8, removed: 0, binaryFiles: 0, gitlinkFiles: 0 } },
		})),
	};
	await render();
	await click(button("A 8"));
	await inputValue(
		document.querySelector("input[aria-label='Select all matching files in Alpha']") as Element,
		true,
	);
	await click(button("Move selected (8)"));
	await click(document.querySelector("[data-git-staging-target='B']") as Element);
	expect(actions).toEqual([
		{ action: "move", fromListId: "A", toListId: "B", scope: { filter: ["A"] }, ...version },
	]);
	expect(fileReads).toEqual([]);
});
test("diff unit selection uses backend identities even when the display diff is truncated", async () => {
	await render();
	await click(document.querySelector("[data-git-staging-toggle='A']") as Element);
	await click(document.querySelector("[data-git-staging-file='file.txt']") as Element);
	expect(document.body.textContent).toContain("truncated ownership preview");
	const inputs = [...document.querySelectorAll("[role='dialog'] input[type='checkbox']")];
	await inputValue(inputs[1], true);
	const unitMove = [...document.querySelectorAll("[role='dialog'] button")].find(
		(entry) => entry.textContent?.trim() === "Move selected (1)",
	) as Element;
	await click(unitMove);
	await click(document.querySelector("[data-git-staging-target='B']") as Element);
	expect(actions).toEqual([
		{ action: "move", fromListId: "A", toListId: "B", unitIds: ["unit-a"], ...version },
	]);
	expect(JSON.stringify(actions)).not.toContain("patch");
	expect(JSON.stringify(actions)).not.toContain("diff");
});
test("group moves offer only other destinations regardless of compatibility counts", async () => {
	summary = {
		...summary,
		lists: summary.lists.map((entry) =>
			entry.id === "A" ? { ...entry, needsReviewCount: 1 } : entry,
		),
	};
	await render();
	await click(document.querySelector("[data-git-staging-more='A']") as Element);
	expect(button("Commit Alpha").disabled).toBe(false);
	await click(button("Move to ChangeList"));
	const current = document.querySelector<HTMLButtonElement>("[data-git-staging-target='A']");
	expect(current?.disabled).toBe(true);
	await click(current as Element);
	expect(actions).toEqual([]);
	await click(document.querySelector("[data-git-staging-target='B']") as Element);
	expect(actions).toEqual([
		{ action: "move", fromListId: "A", toListId: "B", all: true, ...version },
	]);
});
test("a changed observation disables an already-open confirmation", async () => {
	await render();
	await menu("B", "Delete ChangeList");
	summary = { ...summary, generation: 2, observationId: "o2" };
	client.setQueryData(["gitStagingLists", "w", "ui", "fixture-alice"], summary);
	await flush();
	expect(
		(document.querySelector("[data-git-staging-confirm-delete]") as HTMLButtonElement).disabled,
	).toBe(true);
	expect(document.querySelector("[role='dialog']")?.textContent).toContain("select again");
	await click(document.querySelector("[data-git-staging-confirm-delete]") as Element);
	expect(actions).toEqual([]);
});
test.each([
	"ready",
	"recovering",
] as const)("commit errors preserve messages and recovery remains available in %s state", async (state) => {
	await render();
	await menu("B", "Commit Beta");
	await inputValue(document.querySelector("[role='dialog'] input") as Element, "beta commit");
	actionError = new Error("Native index contains staged changes");
	await click(button("Commit"));
	expect((document.querySelector("[role='dialog'] input") as HTMLInputElement).value).toBe(
		"beta commit",
	);
	actionError = undefined;
	actionResult = {
		...actionResult,
		outcome: "partial",
		commitOid: "commit-1",
		operationId: "op-1",
		reason: "Finalization failed",
	};
	await click(button("Commit"));
	expect(document.body.textContent).toContain("Committed commit-1");
	summary = { ...summary, state };
	client.setQueryData(["gitStagingLists", "w", "ui", "fixture-alice"], summary);
	await flush();
	expect(button("Recover operation").disabled).toBe(false);
	await click(button("Recover operation"));
	expect(actions.map((action) => action.action)).toEqual(["commit", "commit", "recover"]);
	expect(actions[2]).toEqual({ action: "recover", operationId: "op-1", ...version });
	expect(nativeWrites).toEqual([]);
});
test("a summary read failure can be retried without pretending initialization succeeded", async () => {
	let reads = 0;
	api.getGitStagingLists = async () => {
		if (++reads === 1) throw new Error("Summary unavailable");
		return summary;
	};
	await render();
	expect(document.body.textContent).toContain("Summary unavailable");
	const refresh = document.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]');
	expect(refresh?.disabled).toBe(false);
	await click(refresh as Element);
	expect(document.querySelector('[data-git-staging-toggle="A"]')).not.toBeNull();
	expect(reads).toBe(2);
	expect(actions).toEqual([]);
});

async function openPreview() {
	await render();
	await click(document.querySelector("[data-git-staging-toggle='A']") as Element);
	await click(document.querySelector("[data-git-staging-file='file.txt']") as Element);
}
function unitElement(id: string, selector: string) {
	const found = document.querySelector(`[data-git-staging-unit='${id}'] ${selector}`);
	if (!found) throw new Error(`Missing ${id} ${selector}`);
	return found;
}
async function previewData(): Promise<GitStagingDiff> {
	return api.getGitStagingDiff(target, "A", { path: "file.txt" });
}
function activateBeta() {
	summary = {
		...summary,
		activeListId: "B",
		lists: summary.lists.map((entry) => ({ ...entry, active: entry.id === "B" })),
	};
}

function unassignedOwnership() {
	summary = {
		...summary,
		activeListId: GIT_STAGING_UNASSIGNED_LIST_ID,
		lists: summary.lists.map((list) =>
			list.id === "A"
				? {
						...list,
						id: GIT_STAGING_UNASSIGNED_LIST_ID,
						name: GIT_STAGING_UNASSIGNED_LIST_NAME,
						needsReviewCount: 0,
					}
				: list,
		),
	};
	const read = api.getGitStagingDiff;
	api.getGitStagingDiff = async (...args) => {
		const data = await read(...args);
		return {
			...data,
			units: data.units.map((unit) => ({
				...unit,
				listId: GIT_STAGING_UNASSIGNED_LIST_ID,
			})),
		};
	};
}

test.each([
	"en",
	"zh-CN",
])("%s previews and move targets localize the reserved default name across language changes", async (language) => {
	unassignedOwnership();
	await i18n.changeLanguage(language);
	const display = language === "zh-CN" ? "未分组" : "Unassigned";
	await render();
	expect(groupToggle(GIT_STAGING_UNASSIGNED_LIST_ID)?.textContent).toContain(display);
	await menu("B", i18n.t("staging.delete", { ns: "git" }));
	expect(document.querySelector("[role='dialog']")?.textContent).toContain(
		i18n.t("staging.deleteWarning", { ns: "git", name: display }),
	);
	await click(button(i18n.t("cancel")));
	await menu("B", i18n.t("staging.moveToList", { ns: "git" }));
	expect(
		document.querySelector(
			`[data-git-staging-picker] [data-git-staging-target='${GIT_STAGING_UNASSIGNED_LIST_ID}']`,
		)?.textContent,
	).toBe(display);
	await click(document.querySelector("[role='dialog'] button[aria-label]") as Element);
	await click(groupToggle(GIT_STAGING_UNASSIGNED_LIST_ID) as Element);
	await click(document.querySelector("[data-git-staging-file='file.txt']") as Element);
	expect(document.querySelector("[role='dialog']")?.textContent).toContain(`${display} · file.txt`);
	expect(document.querySelector("[data-git-staging-unit-active='unit-a']")).toBeNull();
	await inputValue(unitElement("unit-a", "input"), true);
	await click(document.querySelector("[data-git-staging-batch-menu]") as Element);
	expect(
		document.querySelector(
			`[data-git-staging-unit-targets] [data-git-staging-target='${GIT_STAGING_UNASSIGNED_LIST_ID}']`,
		)?.textContent,
	).toBe(display);
	expect(
		document.querySelector<HTMLButtonElement>(
			`[data-git-staging-unit-targets] [data-git-staging-target='${GIT_STAGING_UNASSIGNED_LIST_ID}']`,
		)?.disabled,
	).toBe(true);
	await click(document.querySelector("[data-git-staging-batch-menu]") as Element);
	await click(unitElement("unit-a", "[data-git-staging-unit-menu]"));
	expect(
		document.querySelector(
			`[data-git-staging-unit-targets] [data-git-staging-target='${GIT_STAGING_UNASSIGNED_LIST_ID}']`,
		)?.textContent,
	).toBe(display);
	await i18n.changeLanguage(language === "en" ? "zh-CN" : "en");
	await flush();
	const switched = language === "en" ? "未分组" : "Unassigned";
	expect(document.querySelector("[role='dialog']")?.textContent).toContain(
		`${switched} · file.txt`,
	);
	const target = document.querySelector(
		`[data-git-staging-unit-targets] [data-git-staging-target='${GIT_STAGING_UNASSIGNED_LIST_ID}']`,
	) as Element;
	expect(target.textContent).toBe(switched);
	expect((target as HTMLButtonElement).disabled).toBe(true);
	await click(target);
	expect(actions).toEqual([]);
	await click(
		document.querySelector(
			"[data-git-staging-unit-targets] [data-git-staging-target='B']",
		) as Element,
	);
	expect(actions).toEqual([
		{
			action: "move",
			fromListId: GIT_STAGING_UNASSIGNED_LIST_ID,
			toListId: "B",
			unitIds: ["unit-a"],
			...version,
		},
	]);
}, 15_000);

test.each([
	{ id: GIT_STAGING_UNASSIGNED_LIST_ID, name: "Unassigned" },
	{ id: "B", name: "Beta" },
])("$name uses the ordinary commit requirements with compatibility metadata", async (list) => {
	unassignedOwnership();
	summary = {
		...summary,
		lists: summary.lists.map((entry) => ({ ...entry, needsReviewCount: 1 })),
	};
	await render();
	await menu(list.id, `Commit ${list.name}`);
	expect(button("Commit").disabled).toBe(true);
	await inputValue(document.querySelector("[role='dialog'] input") as Element, "group commit");
	expect(button("Commit").disabled).toBe(false);
	expect(document.querySelector("[role='dialog']")?.textContent).not.toContain("Needs review");
	await click(button("Commit"));
	expect(actions).toEqual([
		{ action: "commit", listId: list.id, message: "group commit", ...version },
	]);
	expect(nativeWrites).toEqual([]);
});

test("ownership controls use current identities independently of historical compatibility metadata", async () => {
	const data = await previewData();
	summary = {
		...summary,
		lists: summary.lists.map((entry) => ({ ...entry, needsReviewCount: 1 })),
	};
	const readFiles = api.getGitStagingFiles;
	api.getGitStagingFiles = async (...args) => {
		const page = await readFiles(...args);
		return { ...page, files: page.files.map((file) => ({ ...file, needsReviewCount: 1 })) };
	};
	api.getGitStagingDiff = async () => ({
		...data,
		units: data.units.map((unit, index) => ({
			...unit,
			needsReview: true,
			reviewReason: index === 0 ? "headChanged" : "ambiguousOwnership",
		})),
	});
	await openPreview();
	const unit = document.querySelector("[data-git-staging-unit='unit-a']") as Element;
	expect(document.querySelector("[data-review]")).toBeNull();
	expect(document.body.textContent).not.toContain("Needs review");
	expect(document.body.textContent).not.toContain("ambiguousOwnership");
	expect(unit.getAttribute("title")).toBeNull();
	expect(unit.querySelector("input")?.getAttribute("aria-label")).not.toContain("Needs review");
	expect(document.querySelector("[data-git-staging-unit-active='unit-a']")).toBeNull();
	await click(unitElement("unit-a", "[data-git-staging-unit-menu]"));
	expect(
		document.querySelector<HTMLButtonElement>(
			"[data-git-staging-unit-targets] [data-git-staging-target='A']",
		)?.disabled,
	).toBe(true);
});

test("single-unit action names the active destination and moves only that identity", async () => {
	activateBeta();
	await openPreview();
	const code = document.querySelector("[data-patch-mount]");
	const action = unitElement("unit-b", "[data-git-staging-unit-active]");
	expect(action.getAttribute("aria-label")).toBe("Move change to Beta");
	await click(action);
	expect(actions).toEqual([
		{ action: "move", fromListId: "A", toListId: "B", unitIds: ["unit-b"], ...version },
	]);
	expect(document.querySelector("[data-patch-mount]")).toBe(code);
});

test("current active group units offer only other move destinations", async () => {
	await openPreview();
	expect(document.querySelector("[data-git-staging-unit-active='unit-a']")).toBeNull();
	expect(document.querySelector("[data-git-staging-unit-active='unit-b']")).toBeNull();
	await click(unitElement("unit-a", "[data-git-staging-unit-menu]"));
	expect(
		document.querySelector<HTMLButtonElement>(
			"[data-git-staging-unit-targets] [data-git-staging-target='A']",
		)?.disabled,
	).toBe(true);
	await click(
		document.querySelector(
			"[data-git-staging-unit-targets] [data-git-staging-target='B']",
		) as Element,
	);
	expect(actions).toEqual([
		{ action: "move", fromListId: "A", toListId: "B", unitIds: ["unit-a"], ...version },
	]);
});

test("unit menus and failed moves keep the preview and selection for an explicit retry", async () => {
	await openPreview();
	await inputValue(unitElement("unit-b", "input"), true);
	const code = document.querySelector("[data-patch-mount]");
	await click(unitElement("unit-b", "[data-git-staging-unit-menu]"));
	expect(document.querySelector("[data-patch-mount]")).toBe(code);
	expect(
		(
			document.querySelector(
				"[data-git-staging-unit-targets] [data-git-staging-target='A']",
			) as HTMLButtonElement
		).disabled,
	).toBe(true);
	await click(unitElement("unit-b", "[data-git-staging-unit-menu]"));
	expect((unitElement("unit-b", "input") as HTMLInputElement).checked).toBe(true);
	expect(actions).toEqual([]);
	await click(unitElement("unit-b", "[data-git-staging-unit-menu]"));
	actionError = new Error("Move unavailable");
	await click(
		document.querySelector(
			"[data-git-staging-unit-targets] [data-git-staging-target='B']",
		) as Element,
	);
	expect(document.querySelector("[data-patch-mount]")).toBe(code);
	expect((unitElement("unit-b", "input") as HTMLInputElement).checked).toBe(true);
	expect(document.querySelector("[data-git-staging-preview]")?.textContent).toContain(
		"Move unavailable",
	);
	actionError = undefined;
	await click(
		document.querySelector(
			"[data-git-staging-unit-targets] [data-git-staging-target='B']",
		) as Element,
	);
	expect(actions).toHaveLength(2);
	expect(
		actions.every(
			(action) =>
				action.action === "move" && JSON.stringify(action.unitIds) === JSON.stringify(["unit-b"]),
		),
	).toBe(true);
});

test("batch menu sends complete selected IDs and successful refresh retains remaining identities", async () => {
	activateBeta();
	let data = await previewData();
	api.getGitStagingDiff = async () => data;
	api.getGitStagingFiles = async (_target, listId) => ({
		...filesPage(),
		listId,
		files: [file],
		snapshotVersion: summary.lists.find((entry) => entry.id === listId)?.snapshotVersion ?? "v1",
		generation: summary.generation,
		observationId: summary.observationId,
	});
	await openPreview();
	await inputValue(unitElement("unit-a", "input"), true);
	await inputValue(unitElement("unit-b", "input"), true);
	const code = document.querySelector("[data-patch-mount]");
	api.gitStagingAction = async (_target, action) => {
		actions.push(action);
		summary = {
			...summary,
			generation: 2,
			observationId: "o2",
			lists: summary.lists.map((entry) => ({ ...entry, snapshotVersion: "v2" })),
		};
		data = {
			...data,
			snapshotVersion: "v2",
			generation: 2,
			observationId: "o2",
			units: data.units.filter((unit) => unit.id === "unit-b"),
		};
		return { ...actionResult, generation: 2, observationId: "o2", observation: observationState() };
	};
	await click(document.querySelector("[data-git-staging-batch-menu]") as Element);
	await click(
		document.querySelector(
			"[data-git-staging-unit-targets] [data-git-staging-target='B']",
		) as Element,
	);
	await flush();
	expect(actions).toEqual([
		{ action: "move", fromListId: "A", toListId: "B", unitIds: ["unit-a", "unit-b"], ...version },
	]);
	expect(document.querySelector("[data-patch-mount]")).toBe(code);
	expect(document.querySelector("[data-git-staging-unit='unit-a']")).toBeNull();
	expect((unitElement("unit-b", "input") as HTMLInputElement).checked).toBe(true);
	await click(unitElement("unit-b", "[data-git-staging-unit-active]"));
	expect(actions[1]).toEqual({
		action: "move",
		fromListId: "A",
		toListId: "B",
		unitIds: ["unit-b"],
		expectedGeneration: 2,
		observationId: "o2",
	});
});

test("an external observation retires selected IDs and an already-open menu", async () => {
	await openPreview();
	await inputValue(unitElement("unit-a", "input"), true);
	await click(document.querySelector("[data-git-staging-batch-menu]") as Element);
	summary = { ...summary, generation: 2, observationId: "o2" };
	client.setQueryData(["gitStagingLists", "w", "ui", "fixture-alice"], summary);
	await flush();
	expect((unitElement("unit-a", "input") as HTMLInputElement).checked).toBe(false);
	expect(
		(document.querySelector("[data-git-staging-batch-menu]") as HTMLButtonElement).disabled,
	).toBe(true);
	expect(document.querySelector("[data-git-staging-unit-targets]")).toBeNull();
	expect(actions).toEqual([]);
});

test("stale writes require a fresh read and never retry the old unit range automatically", async () => {
	activateBeta();
	await openPreview();
	actionError = new ApiError("Observation changed", 409, { code: "GIT_STAGING_STALE_CURSOR" });
	await click(unitElement("unit-b", "[data-git-staging-unit-active]"));
	await flush();
	expect(actions).toHaveLength(1);
	expect((unitElement("unit-b", "input") as HTMLInputElement).checked).toBe(false);
	expect(
		(unitElement("unit-b", "[data-git-staging-unit-active]") as HTMLButtonElement).disabled,
	).toBe(true);
});

test("a pending unit write rejects duplicates and permission withdrawal clears selection", async () => {
	activateBeta();
	await openPreview();
	await inputValue(unitElement("unit-a", "input"), true);
	let resolve!: (value: GitStagingActionResult) => void;
	api.gitStagingAction = async (_target, action) => {
		actions.push(action);
		return new Promise((done) => {
			resolve = done;
		});
	};
	const action = unitElement("unit-b", "[data-git-staging-unit-active]");
	await click(action);
	await click(action);
	expect(actions).toHaveLength(1);
	await render(<GitStagingWorkspace target={{ ...target, canWrite: false }} />);
	expect((unitElement("unit-a", "input") as HTMLInputElement).checked).toBe(false);
	expect(
		(unitElement("unit-b", "[data-git-staging-unit-active]") as HTMLButtonElement).disabled,
	).toBe(true);
	resolve(actionResult);
	await flush();
	expect(actions).toHaveLength(1);
});

test("a changed workspace removes the former unit preview and its write targets", async () => {
	await openPreview();
	await click(unitElement("unit-b", "[data-git-staging-unit-menu]"));
	await render(
		<GitStagingWorkspace target={{ ...target, workspaceKey: "other", rootPath: "/other" }} />,
	);
	expect(document.querySelector("[data-git-staging-preview]")).toBeNull();
	expect(document.querySelector("[data-git-staging-unit-targets]")).toBeNull();
	expect(actions).toEqual([]);
});

test("moving the final source units closes the preview on the refreshed not-found response", async () => {
	activateBeta();
	await openPreview();
	api.gitStagingAction = async (_target, action) => {
		actions.push(action);
		api.getGitStagingDiff = async () => {
			throw new ApiError("Source file is empty", 404);
		};
		summary = {
			...summary,
			generation: 2,
			observationId: "o2",
			lists: summary.lists.map((entry) => ({ ...entry, snapshotVersion: "v2" })),
		};
		return { ...actionResult, generation: 2, observationId: "o2", observation: observationState() };
	};
	await click(unitElement("unit-b", "[data-git-staging-unit-active]"));
	await flush();
	expect(document.querySelector("[data-git-staging-preview]")).toBeNull();
	expect(actions).toHaveLength(1);
});

test("observation transitions retain the preview while retiring old unit and menu selections", async () => {
	await openPreview();
	const code = document.querySelector("[data-patch-mount]");
	await inputValue(unitElement("unit-a", "input"), true);
	await click(document.querySelector("[data-git-staging-batch-menu]") as Element);
	stateEpoch = 2;
	emitObservation(observationState({ status: "observing", completedEpoch: 1 }));
	await flush();
	expect(document.querySelector("[data-patch-mount]")).toBe(code);
	expect(document.querySelector("[data-git-staging-observation='observing']")).not.toBeNull();
	expect((unitElement("unit-a", "input") as HTMLInputElement).checked).toBe(false);
	expect((unitElement("unit-a", "input") as HTMLInputElement).disabled).toBe(true);
	expect(document.querySelector("[data-git-staging-unit-targets]")).toBeNull();
	emitObservation(observationState({ status: "failed", completedEpoch: 1 }));
	await flush();
	expect(document.querySelector("[data-patch-mount]")).toBe(code);
	expect((document.querySelector("[data-git-staging-refresh]") as HTMLButtonElement).disabled).toBe(
		false,
	);
	emitObservation(observationState());
	await flush();
	expect((unitElement("unit-a", "input") as HTMLInputElement).disabled).toBe(false);
	expect((unitElement("unit-a", "input") as HTMLInputElement).checked).toBe(false);
	expect(actions).toEqual([]);
});

test("refresh animation keeps its reduced-motion override", async () => {
	const css = await Bun.file(new URL("./GitChangesTab.module.css", import.meta.url)).text();
	expect(css).toMatch(/\.refreshing\s*\{\s*animation:\s*git-refresh-rotate\s/);
	expect(css).toMatch(
		/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.refreshing\s*\{\s*animation:\s*none;/,
	);
});

test("observation refresh animation belongs only to its icon", async () => {
	await render();
	const refresh = document.querySelector<HTMLButtonElement>("[data-git-staging-refresh]");
	const icon = refresh?.querySelector("svg.tabler-icon-refresh");
	expect(icon).not.toBeNull();
	expect(icon?.classList.contains("git-staging-refreshing-icon")).toBe(false);
	stateEpoch = 2;
	for (const status of ["pending", "observing", "failed", "settled"] as const) {
		emitObservation(
			observationState({ status, completedEpoch: status === "settled" ? stateEpoch : 1 }),
		);
		await flush();
		expect(refresh?.classList.contains("git-staging-refreshing-icon")).toBe(false);
		expect(icon?.classList.contains("git-staging-refreshing-icon")).toBe(
			status === "pending" || status === "observing",
		);
		expect(refresh?.disabled).toBe(false);
	}
	expect(actions).toEqual([]);
	expect(nativeWrites).toEqual([]);
});

test("a pending ChangeLists refresh disables duplicates until its request completes", async () => {
	const action = api.gitStagingAction;
	let complete!: () => void;
	const pending = new Promise<void>((resolve) => {
		complete = resolve;
	});
	api.gitStagingAction = async (...args) => {
		const result = await action(...args);
		await pending;
		return result;
	};
	await render();
	const refresh = document.querySelector<HTMLButtonElement>("[data-git-staging-refresh]");
	await click(refresh as Element);
	expect(refresh?.disabled).toBe(true);
	await click(refresh as Element);
	expect(actions).toEqual([{ action: "sync" }]);
	complete();
	await flush();
	expect(refresh?.disabled).toBe(false);
	expect(actions).toEqual([{ action: "sync" }]);
	expect(nativeWrites).toEqual([]);
});

test("a ChangeLists refresh performs one sync without invoking ordinary Git refresh", async () => {
	let ordinaryRefreshes = 0;
	await render(
		<GitStagingWorkspace
			target={target}
			onRefresh={() => {
				ordinaryRefreshes++;
			}}
		/>,
	);
	await click(document.querySelector("[data-git-staging-refresh]") as Element);
	expect(actions).toEqual([{ action: "sync" }]);
	expect(ordinaryRefreshes).toBe(0);
	expect(wsSent.filter((message) => message.type === "git_workspace_refresh")).toEqual([]);
});

test("an old confirmation cannot revive after an unchanged observing epoch", async () => {
	await render();
	await menu("B", "Delete ChangeList");
	stateEpoch = 2;
	emitObservation(observationState({ status: "pending", completedEpoch: 1 }));
	await flush();
	emitObservation(observationState());
	await flush();
	expect(
		(document.querySelector("[data-git-staging-confirm-delete]") as HTMLButtonElement).disabled,
	).toBe(true);
	await click(document.querySelector("[data-git-staging-confirm-delete]") as Element);
	expect(actions).toEqual([]);
});

test("read-only access keeps group contents readable but disables writes", async () => {
	await render(<GitStagingWorkspace target={{ ...target, canWrite: false }} />);
	expect(button("New ChangeList").disabled).toBe(true);
	await click(document.querySelector("[data-git-staging-toggle='A']") as Element);
	expect(document.querySelector("[data-git-staging-file='file.txt']")).not.toBeNull();
	expect(actions).toEqual([]);
});
