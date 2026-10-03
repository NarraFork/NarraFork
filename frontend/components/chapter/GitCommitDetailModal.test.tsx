import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import {
	GIT_COMMIT_PREVIEW_UNSUPPORTED,
	type GitCommitDetail,
	type GitCommitPatch,
} from "@shared/git-commit-preview";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { gitWorkspaceTarget, useGitWorkspace } from "../../hooks/useGit";
import { ApiError, api } from "../../lib/api";
import { type GitTarget, type GitWorkspace, gitTargetKey } from "../../lib/api/git";
import { resetAppBaseForTest } from "../../lib/base-path";
import commonLocale from "../../locales/en/common.json";
import gitLocale from "../../locales/en/git.json";
import { ConfirmDialogProvider } from "../common/ConfirmDialogProvider";
import { installCanvasStub } from "../narrator/vlist/measure/test-canvas-stub";

// Keep the actual query hooks and patch renderer. Only API boundaries are mocked.
const disposeCanvas = installCanvasStub();
const { GitCommitDetailModal } = await import("./GitCommitDetailModal");
const { GitCommitPreview } = await import("./GitCommitPreview");
const { GitCommitsTab } = await import("./GitCommitsTab");
const { GitPatchView } = await import("./GitPatchView");

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const PARENT = "c".repeat(40);
const TARGET = {
	narratorId: "preview-narrator",
	workspaceKey: "device-a:/repo",
	repositoryKey: "device-a:/repo/.git",
	canWrite: false,
};
const OTHER_WORKSPACE = { ...TARGET, workspaceKey: "device-b:/repo" };
const OTHER_NARRATOR = { ...TARGET, narratorId: "another-narrator" };
const FILE = "src/one.ts";
const RENAMED_FILE = "docs/new name.md";
const OLD_PATH = "docs/old name.md";
const RENAME_PATCH = [
	`diff --git a/${OLD_PATH} b/${RENAMED_FILE}`,
	"similarity index 100%",
	`rename from ${OLD_PATH}`,
	`rename to ${RENAMED_FILE}`,
].join("\n");
const MODE_PATCH = "diff --git a/script.sh b/script.sh\nold mode 100644\nnew mode 100755\n";
const BINARY_PATCH =
	"diff --git a/image.bin b/image.bin\nBinary files a/image.bin and b/image.bin differ\n";

function detail(sha = SHA_A, overrides: Partial<GitCommitDetail> = {}): GitCommitDetail {
	return {
		sha,
		shortSha: sha.slice(0, 7),
		parents: [PARENT],
		authorName: "Preview Author",
		authorEmail: "author@example.test",
		authoredAt: "2026-06-09T10:00:00Z",
		committerName: "Preview Author",
		committerEmail: "author@example.test",
		committedAt: "2026-06-10T11:30:00Z",
		message: `Commit ${sha.slice(0, 7)} subject\n\nDetailed commit body`,
		messageTruncated: false,
		comparedTo: PARENT,
		files: [
			{ path: FILE, status: "modified", linesAdded: 1, linesRemoved: 1, binary: false },
			{
				path: RENAMED_FILE,
				oldPath: OLD_PATH,
				status: "renamed",
				linesAdded: 0,
				linesRemoved: 0,
				binary: false,
			},
		],
		filesTruncated: false,
		...overrides,
	};
}

function textPatch(text: string): GitCommitPatch {
	return {
		diff: `diff --git a/${FILE} b/${FILE}\n--- a/${FILE}\n+++ b/${FILE}\n@@ -1 +1 @@\n-old line\n+${text}\n`,
		truncated: false,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}
class TestShadowRoot {}

const i18n = i18next.createInstance();
let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
let restoreDom: () => void;

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const restore: Array<() => void> = [];
	const patch = (object: object, descriptors: PropertyDescriptorMap) => {
		const saved = Object.keys(descriptors).map(
			(key) => [key, Object.getOwnPropertyDescriptor(object, key)] as const,
		);
		Object.defineProperties(object, descriptors);
		restore.push(() => {
			for (const [key, descriptor] of saved) {
				if (descriptor) Object.defineProperty(object, key, descriptor);
				else Reflect.deleteProperty(object, key);
			}
		});
	};
	const positions = new WeakMap<object, number>();
	patch(window.HTMLElement.prototype, {
		clientHeight: { configurable: true, get: () => 500 },
		clientWidth: { configurable: true, get: () => 700 },
		clientTop: { configurable: true, get: () => 0 },
		scrollHeight: { configurable: true, get: () => 500 },
		scrollTop: {
			configurable: true,
			get() {
				return positions.get(this) ?? 0;
			},
			set(value: number) {
				positions.set(this, value);
			},
		},
		getBoundingClientRect: {
			configurable: true,
			value: () => ({
				top: 0,
				bottom: 500,
				left: 0,
				right: 700,
				width: 700,
				height: 500,
				x: 0,
				y: 0,
				toJSON() {},
			}),
		},
	});
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
	const storage = new Map<string, string>();
	const values = {
		window,
		document: window.document,
		navigator: window.navigator,
		location: { origin: "https://preview.example" },
		Event: window.Event,
		HTMLElement: window.HTMLElement,
		HTMLButtonElement: window.HTMLButtonElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		ResizeObserver: TestResizeObserver,
		ShadowRoot: TestShadowRoot,
		matchMedia,
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		getSelection: () => ({ anchorNode: null }),
		localStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		},
		IS_REACT_ACT_ENVIRONMENT: false,
	};
	patch(
		globalThis,
		Object.fromEntries(
			Object.entries(values).map(([key, value]) => [
				key,
				{ configurable: true, writable: true, value },
			]),
		),
	);
	restoreDom = () => {
		for (const undo of restore.reverse()) undo();
	};
}

async function flushRender() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, description: string) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await flushRender();
	}
	throw new Error(`Timed out waiting for ${description}`);
}

function bodyText() {
	return document.body.textContent ?? "";
}

function element(selector: string): HTMLElement {
	const found = document.body.querySelector<HTMLElement>(selector);
	if (!found) throw new Error(`Element not found: ${selector}`);
	return found;
}

function click(selector: string) {
	element(selector).dispatchEvent(new Event("click", { bubbles: true }));
}

function renderUi(content: ReactNode) {
	root.render(
		<I18nextProvider i18n={i18n}>
			<MantineProvider env="test">
				<QueryClientProvider client={queryClient}>
					<ConfirmDialogProvider>{content}</ConfirmDialogProvider>
				</QueryClientProvider>
			</MantineProvider>
		</I18nextProvider>,
	);
}

function renderModal(sha: string | null = SHA_A, target: GitTarget = TARGET) {
	renderUi(
		<GitCommitDetailModal target={target} sha={sha} onClose={() => renderModal(null, target)} />,
	);
}

async function waitForFiles() {
	await waitFor(() => !!document.body.querySelector("[data-commit-file]"), "commit files");
}

function workspace(overrides: Partial<GitWorkspace> = {}): GitWorkspace {
	return {
		workspaceKey: TARGET.workspaceKey,
		repositoryKey: TARGET.repositoryKey,
		deviceId: "device-a",
		cwd: "/repo",
		rootPath: "/repo",
		state: "ready",
		capabilities: { read: true, write: false },
		...overrides,
	};
}

// Exercise the real workspace hook's reset/unmount interaction, not a hook mock.
function WorkspacePreview() {
	const result = useGitWorkspace(TARGET.narratorId, "preview-test");
	const target = result.isError ? null : gitWorkspaceTarget(TARGET.narratorId, result.data);
	return target ? (
		<GitCommitDetailModal target={target} sha={SHA_A} onClose={() => {}} />
	) : (
		<span data-workspace-pending />
	);
}

function renderWorkspacePreview() {
	queryClient.setQueryData(["narrators", TARGET.narratorId], {
		id: TARGET.narratorId,
		cwd: "/repo",
	});
	renderUi(<WorkspacePreview />);
}

beforeEach(async () => {
	resetAppBaseForTest();
	installDom();
	if (!i18n.isInitialized) {
		await i18n.use(initReactI18next).init({
			lng: "en",
			fallbackLng: "en",
			defaultNS: "git",
			ns: ["git", "common"],
			resources: { en: { git: gitLocale, common: commonLocale } },
			interpolation: { escapeValue: false },
			react: { useSuspense: false },
		});
	}
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	// Uncontrolled previews now load the first file as soon as detail arrives.
	spyOn(api, "getGitCommitDiff").mockResolvedValue(textPatch("DEFAULT_PATCH"));
	// No unmocked network request should silently reach a live NarraFork instance.
	spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async () => {
				throw new Error("Unexpected network request");
			},
			{ preconnect: () => {} },
		),
	);
});

afterEach(async () => {
	root.unmount();
	queryClient.clear();
	await flushRender();
	container.remove();
	mock.restore();
	restoreDom();
	resetAppBaseForTest();
});
afterAll(disposeCanvas);

describe("Git commit preview with real query observers", () => {
	test("a read-only history row lazily opens metadata, then fetches only the selected patch", async () => {
		const commit = detail(SHA_A, {
			parents: [PARENT, SHA_B],
			messageTruncated: true,
			filesTruncated: true,
		});
		spyOn(api, "getGitLog").mockResolvedValue([
			{
				sha: SHA_A,
				shortSha: "aaaaaaa",
				message: "History subject",
				author: "Preview Author",
				date: commit.authoredAt,
			},
		]);
		const details = spyOn(api, "getGitCommitDetail").mockResolvedValue(commit);
		const patches = spyOn(api, "getGitCommitDiff").mockResolvedValue(textPatch("SELECTED_PATCH"));
		const reset = spyOn(api, "gitReset");
		renderUi(<GitCommitsTab target={TARGET} />);
		await waitFor(() => !!document.body.querySelector("[data-commit-row]"), "history row");
		expect(details).not.toHaveBeenCalled();
		expect(patches).not.toHaveBeenCalled();
		expect(element("[data-commit-row]").tagName).toBe("A");
		expect(element("[data-commit-row]").getAttribute("href")).toContain(SHA_A);
		for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey", "middle"] as const) {
			const event = new Event("click", { bubbles: true, cancelable: true });
			Object.defineProperties(event, {
				button: { value: modifier === "middle" ? 1 : 0 },
				[modifier]: { value: true },
			});
			element("[data-commit-row]").dispatchEvent(event);
			expect(event.defaultPrevented).toBe(false);
		}
		await flushRender();
		expect(details).not.toHaveBeenCalled();
		expect(document.body.querySelector("[role='dialog']")).toBeNull();
		click("[data-commit-row]");
		await waitForFiles();
		expect(details).toHaveBeenCalledTimes(1);
		await waitFor(() => bodyText().includes("SELECTED_PATCH"), "default first file patch");
		expect(patches).toHaveBeenCalledTimes(1);
		expect(element("[data-commit-sha]").textContent).toContain(SHA_A);
		expect(element("[data-commit-message]").textContent).toContain("Commit aaaaaaa subject");
		expect(bodyText()).not.toContain("Detailed commit body");
		click("[data-commit-body-toggle]");
		await waitFor(() => !!document.body.querySelector("[data-commit-body]"), "expanded body");
		expect(element("[data-commit-body]").textContent).toBe("Detailed commit body");
		expect(bodyText()).toContain("Author: Preview Author <author@example.test>");
		expect(bodyText()).toContain("Committer: Preview Author <author@example.test>");
		expect(bodyText()).toContain(commit.authoredAt);
		expect(bodyText()).toContain(commit.committedAt);
		expect(document.body.querySelectorAll("time")).toHaveLength(2);
		expect(document.body.querySelector(`[title="${PARENT} ${SHA_B}"]`)).not.toBeNull();
		expect(bodyText()).toContain("first parent ccccccc");
		expect(bodyText()).toContain(gitLocale["commitPreview.messageTruncated"]);
		expect(bodyText()).toContain("Only the first 2 files are listed");
		expect(
			document.body.querySelector("[role='listbox'], [role='option'], button button"),
		).toBeNull();
		const file = element(`[data-commit-file="${FILE}"]`);
		expect(file.tagName).toBe("BUTTON");
		expect(file.getAttribute("type")).toBe("button");
		expect(file.getAttribute("aria-pressed")).toBe("true");
		click(`[data-commit-file="${FILE}"]`);
		await flushRender();
		expect(patches).toHaveBeenCalledTimes(1);
		expect(file.getAttribute("aria-pressed")).toBe("true");
		expect(patches.mock.calls[0]?.slice(0, 4)).toEqual([TARGET, SHA_A, FILE, undefined]);
		expect(patches.mock.calls[0]?.[4]).toBeInstanceOf(AbortSignal);
		expect(reset).not.toHaveBeenCalled();
		expect(document.body.querySelector("button button")).toBeNull();
	});

	test("closing aborts a pending detail read, and reopening the same SHA does not reuse its late response", async () => {
		const first = deferred<GitCommitDetail>();
		const details = spyOn(api, "getGitCommitDetail")
			.mockReturnValueOnce(first.promise)
			.mockResolvedValue(detail(SHA_A, { message: "REOPENED_DETAIL" }));
		renderModal(null);
		await flushRender();
		expect(details).not.toHaveBeenCalled();
		renderModal();
		await waitFor(() => details.mock.calls.length === 1, "pending detail request");
		const signal = details.mock.calls[0]?.[2];
		click('[aria-label="Close commit preview"]');
		await waitFor(() => signal?.aborted === true, "detail abort on close");
		first.resolve(detail(SHA_A, { message: "LATE_CLOSED_DETAIL" }));
		await flushRender();
		expect(document.body.querySelector("[data-commit-message]")).toBeNull();
		renderModal();
		await waitForFiles();
		expect(details).toHaveBeenCalledTimes(2);
		expect(bodyText()).toContain("REOPENED_DETAIL");
		expect(bodyText()).not.toContain("LATE_CLOSED_DETAIL");
	});

	test("closing aborts a pending patch and reopening the same SHA selects the first file afresh", async () => {
		spyOn(api, "getGitCommitDetail").mockResolvedValue(detail());
		const pending = deferred<GitCommitPatch>();
		const patches = spyOn(api, "getGitCommitDiff")
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValue(textPatch("REOPENED_PATCH"));
		renderModal();
		await waitForFiles();
		click(`[data-commit-file="${FILE}"]`);
		await waitFor(() => patches.mock.calls.length === 1, "pending patch request");
		const signal = patches.mock.calls[0]?.[4];
		click('[aria-label="Close commit preview"]');
		await waitFor(() => signal?.aborted === true, "patch abort on close");
		pending.resolve(textPatch("LATE_CLOSED_PATCH"));
		renderModal();
		await waitForFiles();
		expect(element(`[data-commit-file="${FILE}"]`).getAttribute("aria-pressed")).toBe("true");
		expect(bodyText()).not.toContain("LATE_CLOSED_PATCH");
		await waitFor(() => bodyText().includes("REOPENED_PATCH"), "fresh default patch");
		expect(patches).toHaveBeenCalledTimes(2);
	});

	const identityChanges: Array<[string, string, GitTarget]> = [
		["SHA", SHA_B, TARGET],
		["workspace", SHA_A, OTHER_WORKSPACE],
		["narrator on the same workspace", SHA_A, OTHER_NARRATOR],
		["chapter target", SHA_A, "other-chapter"],
	];
	test.each(
		identityChanges,
	)("changing %s cancels detail and ignores the old response", async (_name, sha, target) => {
		const old = deferred<GitCommitDetail>();
		const details = spyOn(api, "getGitCommitDetail")
			.mockReturnValueOnce(old.promise)
			.mockResolvedValue(detail(sha, { message: "CURRENT_DETAIL" }));
		renderModal();
		await waitFor(() => details.mock.calls.length === 1, "old detail read");
		const oldSignal = details.mock.calls[0]?.[2];
		renderModal(sha, target);
		await waitForFiles();
		expect(oldSignal?.aborted).toBe(true);
		expect(details).toHaveBeenCalledTimes(2);
		expect(details.mock.calls[1]?.slice(0, 2)).toEqual([target, sha]);
		old.resolve(detail(SHA_A, { message: "OBSOLETE_DETAIL" }));
		await flushRender();
		expect(bodyText()).toContain("CURRENT_DETAIL");
		expect(bodyText()).not.toContain("OBSOLETE_DETAIL");
	});

	test.each(
		identityChanges,
	)("changing %s aborts the old patch and selects the new workspace's first file", async (_name, sha, target) => {
		const details = spyOn(api, "getGitCommitDetail").mockImplementation(
			async (_target, requestedSha) => detail(requestedSha),
		);
		const old = deferred<GitCommitPatch>();
		const patches = spyOn(api, "getGitCommitDiff")
			.mockReturnValueOnce(old.promise)
			.mockResolvedValue(textPatch("CURRENT_PATCH"));
		renderModal();
		await waitForFiles();
		click(`[data-commit-file="${FILE}"]`);
		await waitFor(() => patches.mock.calls.length === 1, "old patch read");
		const oldSignal = patches.mock.calls[0]?.[4];
		renderModal(sha, target);
		await waitFor(
			() => details.mock.calls.length === 2 && !!document.body.querySelector("[data-commit-file]"),
			"new identity files",
		);
		expect(oldSignal?.aborted).toBe(true);
		expect(element(`[data-commit-file="${FILE}"]`).getAttribute("aria-pressed")).toBe("true");
		old.resolve(textPatch("OBSOLETE_PATCH"));
		await flushRender();
		expect(bodyText()).not.toContain("OBSOLETE_PATCH");
		await waitFor(() => bodyText().includes("CURRENT_PATCH"), "new identity default patch");
		expect(patches).toHaveBeenCalledTimes(2);
		expect(patches.mock.calls[1]?.slice(0, 4)).toEqual([target, sha, FILE, undefined]);
	});

	test("switching files cancels the old diff and passes both rename paths", async () => {
		spyOn(api, "getGitCommitDetail").mockResolvedValue(detail());
		const old = deferred<GitCommitPatch>();
		const patches = spyOn(api, "getGitCommitDiff")
			.mockReturnValueOnce(old.promise)
			.mockResolvedValue({ diff: RENAME_PATCH, truncated: false });
		renderModal();
		await waitForFiles();
		click(`[data-commit-file="${FILE}"]`);
		await waitFor(() => patches.mock.calls.length === 1, "first file request");
		const signal = patches.mock.calls[0]?.[4];
		click(`[data-commit-file="${RENAMED_FILE}"]`);
		await waitFor(
			() => !!document.body.querySelector("[data-git-patch-metadata]"),
			"rename metadata",
		);
		expect(signal?.aborted).toBe(true);
		expect(patches.mock.calls[1]?.slice(0, 4)).toEqual([TARGET, SHA_A, RENAMED_FILE, OLD_PATH]);
		expect(element("[data-git-patch-metadata]").textContent).toBe(RENAME_PATCH);
		old.resolve(textPatch("OBSOLETE_FILE_PATCH"));
		await flushRender();
		expect(bodyText()).not.toContain("OBSOLETE_FILE_PATCH");
		expect(element(`[data-commit-file="${RENAMED_FILE}"]`).getAttribute("aria-pressed")).toBe(
			"true",
		);
	});

	test("switching the history tab workspace closes its preview instead of opening the old SHA in the new target", async () => {
		spyOn(api, "getGitLog").mockResolvedValue([
			{
				sha: SHA_A,
				shortSha: "aaaaaaa",
				message: "History",
				author: "Author",
				date: detail().authoredAt,
			},
		]);
		const details = spyOn(api, "getGitCommitDetail").mockResolvedValue(detail());
		const pending = deferred<GitCommitPatch>();
		const patches = spyOn(api, "getGitCommitDiff").mockReturnValue(pending.promise);
		renderUi(<GitCommitsTab target={TARGET} />);
		await waitFor(() => !!document.body.querySelector("[data-commit-row]"), "history");
		click("[data-commit-row]");
		await waitForFiles();
		click(`[data-commit-file="${FILE}"]`);
		await waitFor(() => patches.mock.calls.length === 1, "history patch");
		renderUi(<GitCommitsTab target={OTHER_WORKSPACE} />);
		await waitFor(() => patches.mock.calls[0]?.[4]?.aborted === true, "history patch abort");
		await waitFor(
			() => !!document.body.querySelector("[data-commit-row]"),
			"new workspace history",
		);
		expect(document.body.querySelector("[data-commit-message]")).toBeNull();
		expect(document.body.querySelector("[role='dialog']")).toBeNull();
		expect(details).toHaveBeenCalledTimes(1);
	});

	test.each([
		403, 404,
	])("a %d detail refetch hides cached metadata and unmounts the in-flight patch", async (status) => {
		const details = spyOn(api, "getGitCommitDetail")
			.mockResolvedValueOnce(detail())
			.mockRejectedValue(new ApiError(`Detail denied ${status}`, status));
		const pending = deferred<GitCommitPatch>();
		const patches = spyOn(api, "getGitCommitDiff").mockReturnValue(pending.promise);
		renderModal();
		await waitForFiles();
		click(`[data-commit-file="${FILE}"]`);
		await waitFor(() => patches.mock.calls.length === 1, "selected patch");
		await queryClient.refetchQueries({ queryKey: ["gitCommitDetail", TARGET.workspaceKey, SHA_A] });
		await waitFor(() => bodyText().includes(`Detail denied ${status}`), "detail failure");
		expect(details).toHaveBeenCalledTimes(2);
		// Prove this is a stale-data error, not just an initial-load failure.
		expect(queryClient.getQueriesData({ queryKey: ["gitCommitDetail"] })[0]?.[1]).toEqual(detail());
		expect(
			document.body.querySelector("[data-commit-message], [data-commit-file], [data-diff-row]"),
		).toBeNull();
		expect(patches.mock.calls[0]?.[4]?.aborted).toBe(true);
		pending.resolve(textPatch("LATE_FORBIDDEN_PATCH"));
		await flushRender();
		expect(bodyText()).not.toContain("LATE_FORBIDDEN_PATCH");
	});

	test.each([
		403, 404,
	])("a %d patch refetch replaces the cached patch with its error", async (status) => {
		spyOn(api, "getGitCommitDetail").mockResolvedValue(detail());
		const cached = textPatch("CACHED_PRIVATE_PATCH");
		spyOn(api, "getGitCommitDiff")
			.mockResolvedValueOnce(cached)
			.mockRejectedValue(new ApiError(`Patch denied ${status}`, status));
		renderModal();
		await waitForFiles();
		click(`[data-commit-file="${FILE}"]`);
		await waitFor(() => bodyText().includes("CACHED_PRIVATE_PATCH"), "initial patch");
		await queryClient.refetchQueries({ queryKey: ["gitCommitDiff", TARGET.workspaceKey, SHA_A] });
		await waitFor(() => bodyText().includes(`Patch denied ${status}`), "patch failure");
		expect(queryClient.getQueriesData({ queryKey: ["gitCommitDiff"] })[0]?.[1]).toEqual(cached);
		expect(bodyText()).not.toContain("CACHED_PRIVATE_PATCH");
		expect(document.body.querySelector("[data-diff-row], [data-git-patch-metadata]")).toBeNull();
	});

	test.each([
		"detail",
		"diff",
	] as const)("unsupported %s does not reset/re-probe the workspace or remount its consumer", async (kind) => {
		const unsupported = new ApiError("Unknown executor operation", 409, {
			code: GIT_COMMIT_PREVIEW_UNSUPPORTED,
		});
		const workspaces = spyOn(api, "getGitWorkspace").mockResolvedValue(workspace());
		const details = spyOn(api, "getGitCommitDetail");
		if (kind === "detail")
			details
				.mockRejectedValueOnce(unsupported)
				.mockReturnValue(deferred<GitCommitDetail>().promise);
		else details.mockResolvedValue(detail());
		const patches = spyOn(api, "getGitCommitDiff").mockRejectedValue(unsupported);
		const reset = spyOn(queryClient, "resetQueries");
		renderWorkspacePreview();
		if (kind === "diff") {
			await waitForFiles();
			click(`[data-commit-file="${FILE}"]`);
		}
		await waitFor(
			() => bodyText().includes(gitLocale["commitPreview.unsupported"]),
			"unsupported message",
		);
		await flushRender();
		await flushRender();
		expect(reset).not.toHaveBeenCalled();
		expect(workspaces).toHaveBeenCalledTimes(1);
		expect(details).toHaveBeenCalledTimes(1);
		expect(patches).toHaveBeenCalledTimes(kind === "diff" ? 1 : 0);
		expect(bodyText()).toContain(gitLocale["commitPreview.unsupported"]);
	});

	test("a genuine 409 still resets the workspace and loads only the newly resolved target", async () => {
		const nextWorkspace = deferred<GitWorkspace>();
		const workspaces = spyOn(api, "getGitWorkspace")
			.mockResolvedValueOnce(workspace())
			.mockReturnValueOnce(nextWorkspace.promise);
		const details = spyOn(api, "getGitCommitDetail")
			.mockRejectedValueOnce(new ApiError("Workspace changed", 409))
			.mockResolvedValue(detail(SHA_A, { message: "NEW_WORKSPACE_DETAIL" }));
		const reset = spyOn(queryClient, "resetQueries");
		renderWorkspacePreview();
		await waitFor(() => workspaces.mock.calls.length === 2, "workspace re-probe");
		expect(reset).toHaveBeenCalledWith({ queryKey: ["gitWorkspace", TARGET.narratorId] });
		expect(document.body.querySelector("[data-commit-message]")).toBeNull();
		nextWorkspace.resolve(workspace({ workspaceKey: OTHER_WORKSPACE.workspaceKey }));
		await waitFor(() => bodyText().includes("NEW_WORKSPACE_DETAIL"), "new workspace detail");
		expect(details).toHaveBeenCalledTimes(2);
		expect(gitTargetKey(details.mock.calls[1]?.[0])).toBe(OTHER_WORKSPACE.workspaceKey);
	});

	test("selecting a binary file lazily displays both binary and truncation notices", async () => {
		spyOn(api, "getGitCommitDetail").mockResolvedValue(
			detail(SHA_A, {
				files: [
					{
						path: "image.bin",
						status: "modified",
						binary: true,
						linesAdded: null,
						linesRemoved: null,
					},
				],
			}),
		);
		const patches = spyOn(api, "getGitCommitDiff").mockResolvedValue({
			diff: BINARY_PATCH,
			truncated: true,
		});
		renderModal();
		await waitForFiles();
		expect(element('[data-commit-file="image.bin"]').getAttribute("aria-pressed")).toBe("true");
		expect(element('[data-commit-file="image.bin"]').textContent).toContain(
			gitLocale["commitPreview.binary"],
		);
		click('[data-commit-file="image.bin"]');
		await waitFor(() => bodyText().includes(gitLocale.diffBinary), "binary patch");
		expect(bodyText()).toContain(gitLocale.diffTruncated);
		expect(patches.mock.calls[0]?.slice(0, 4)).toEqual([TARGET, SHA_A, "image.bin", undefined]);
		expect(document.body.querySelector("[data-diff-row]")).toBeNull();
	});

	test("a fully truncated file list is not presented as an empty commit", async () => {
		spyOn(api, "getGitCommitDetail").mockResolvedValue(
			detail(SHA_A, { files: [], filesTruncated: true }),
		);
		const patches = spyOn(api, "getGitCommitDiff");
		renderModal();
		const warning = i18n.t("commitPreview.filesTruncated", { ns: "git", count: 0 });
		await waitFor(() => bodyText().includes(warning), "truncated file list");
		expect(bodyText()).not.toContain(gitLocale["commitPreview.noFiles"]);
		expect(bodyText()).not.toContain(gitLocale["commitPreview.selectFile"]);
		expect(document.body.querySelector("[data-commit-file]")).toBeNull();
		expect(patches).not.toHaveBeenCalled();
	});
	test("an empty root commit shows its metadata and never requests a file patch", async () => {
		spyOn(api, "getGitCommitDetail").mockResolvedValue(
			detail(SHA_A, { files: [], parents: [], comparedTo: null }),
		);
		const patches = spyOn(api, "getGitCommitDiff");
		renderModal();
		await waitFor(() => bodyText().includes(gitLocale["commitPreview.noFiles"]), "empty commit");
		expect(bodyText()).toContain(gitLocale["commitPreview.rootCommit"]);
		expect(bodyText()).toContain(SHA_A);
		expect(document.body.querySelector("[data-commit-file]")).toBeNull();
		expect(patches).not.toHaveBeenCalled();
	});
});

describe("shared GitCommitPreview interactions", () => {
	test.each([
		"/nf/",
		"/proxy/7778/",
	])("native links and copied links retain mount %s", async (base) => {
		Object.defineProperty(document, "baseURI", {
			configurable: true,
			value: `https://preview.example${base}`,
		});
		Object.defineProperty(globalThis, "location", {
			configurable: true,
			value: { origin: "https://preview.example", href: `https://preview.example${base}` },
		});
		spyOn(api, "getGitCommitDetail").mockResolvedValue(detail());
		const writeText = mock(async (_value: string) => {});
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		renderUi(<GitCommitPreview target={TARGET} sha={SHA_A} selectedPath={RENAMED_FILE} />);
		await waitForFiles();
		const preview = element("[data-commit-open-page]").getAttribute("href") ?? "";
		expect(new URL(preview, location.origin).pathname).toBe(
			`${base}git/narrators/${TARGET.narratorId}/commits/${SHA_A}`,
		);
		expect(element(`[data-commit-parent="${PARENT}"]`).getAttribute("href")).toContain(
			`${base}git/narrators/${TARGET.narratorId}/commits/${PARENT}`,
		);
		click("[data-commit-copy-link]");
		await waitFor(() => writeText.mock.calls.length === 1, "copied mounted link");
		expect(writeText.mock.calls[0]?.[0]).toBe(`${location.origin}${preview}`);
	});
	test("copies the full SHA and an absolute link with the current file and workspace", async () => {
		spyOn(api, "getGitCommitDetail").mockResolvedValue(detail());
		const writeText = mock(async (_value: string) => {});
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		renderUi(<GitCommitPreview target={TARGET} sha={SHA_A} selectedPath={RENAMED_FILE} />);
		await waitForFiles();
		click('[aria-label="Copy full SHA"]');
		await waitFor(() => writeText.mock.calls.length === 1, "copied SHA");
		expect(writeText.mock.calls[0]?.[0]).toBe(SHA_A);
		click("[data-commit-copy-link]");
		await waitFor(() => writeText.mock.calls.length === 2, "copied link");
		const url = new URL(writeText.mock.calls[1]?.[0] ?? "");
		expect(url.origin).toBe("https://preview.example");
		expect(url.pathname).toContain(SHA_A);
		expect(url.searchParams.get("file")).toBe(RENAMED_FILE);
		expect(url.searchParams.get("workspaceKey")).toBe(TARGET.workspaceKey);
	});

	test("filters both rename paths without changing the selected patch or loading filtered files", async () => {
		spyOn(api, "getGitCommitDetail").mockResolvedValue(detail());
		const patches = spyOn(api, "getGitCommitDiff").mockResolvedValue(textPatch("FIRST_FILE_PATCH"));
		renderUi(<GitCommitPreview target={TARGET} sha={SHA_A} />);
		await waitFor(() => bodyText().includes("FIRST_FILE_PATCH"), "default patch");
		const input = element('input[aria-label="Filter file paths…"]') as HTMLInputElement;
		input.value = "OLD NAME";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		await waitFor(
			() => document.body.querySelectorAll("[data-commit-file]").length === 1,
			"rename filter",
		);
		expect(element("[data-commit-file]").getAttribute("data-commit-file")).toBe(RENAMED_FILE);
		expect(bodyText()).toContain("FIRST_FILE_PATCH");
		expect(patches).toHaveBeenCalledTimes(1);
		input.value = "no-such-file";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		await waitFor(
			() => bodyText().includes(gitLocale["commitPreview.noMatchingFiles"]),
			"no matches",
		);
		expect(document.body.querySelectorAll("[data-commit-file]")).toHaveLength(0);
		expect(bodyText()).toContain("FIRST_FILE_PATCH");
		input.value = "";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		await waitFor(
			() => document.body.querySelectorAll("[data-commit-file]").length === 2,
			"cleared filter",
		);
		expect(element(`[data-commit-file="${FILE}"]`).getAttribute("aria-pressed")).toBe("true");
		expect(patches).toHaveBeenCalledTimes(1);
	});

	test("collapsing a diff cancels its pending query and expanding ignores the late response", async () => {
		spyOn(api, "getGitCommitDetail").mockResolvedValue(detail());
		const pending = deferred<GitCommitPatch>();
		const patches = spyOn(api, "getGitCommitDiff")
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValue(textPatch("EXPANDED_PATCH"));
		renderUi(<GitCommitPreview target={TARGET} sha={SHA_A} />);
		await waitFor(() => patches.mock.calls.length === 1, "default pending patch");
		const signal = patches.mock.calls[0]?.[4];
		click("[data-commit-diff-toggle]");
		await waitFor(() => signal?.aborted === true, "collapse abort");
		expect(element("[data-commit-diff-toggle]").getAttribute("aria-expanded")).toBe("false");
		pending.resolve(textPatch("LATE_COLLAPSED_PATCH"));
		await flushRender();
		expect(bodyText()).not.toContain("LATE_COLLAPSED_PATCH");
		expect(patches).toHaveBeenCalledTimes(1);
		click("[data-commit-diff-toggle]");
		await waitFor(() => bodyText().includes("EXPANDED_PATCH"), "re-expanded patch");
		expect(patches).toHaveBeenCalledTimes(2);
		expect(element("[data-commit-diff-toggle]").getAttribute("aria-expanded")).toBe("true");
	});

	test("the narrow-screen file navigation can collapse without clearing selection or patch", async () => {
		spyOn(api, "getGitCommitDetail").mockResolvedValue(detail());
		const patches = spyOn(api, "getGitCommitDiff").mockResolvedValue(textPatch("VISIBLE_PATCH"));
		renderUi(<GitCommitPreview target={TARGET} sha={SHA_A} />);
		await waitFor(() => bodyText().includes("VISIBLE_PATCH"), "initial patch");
		const toggle = element("[data-commit-files-toggle]");
		const browser = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
		click("[data-commit-files-toggle]");
		await waitFor(() => toggle.getAttribute("aria-expanded") === "false", "collapsed navigation");
		expect(browser?.getAttribute("data-expanded")).toBe("false");
		expect(bodyText()).toContain("VISIBLE_PATCH");
		click("[data-commit-files-toggle]");
		await waitFor(() => toggle.getAttribute("aria-expanded") === "true", "expanded navigation");
		expect(browser?.getAttribute("data-expanded")).toBe("true");
		expect(element(`[data-commit-file="${FILE}"]`).getAttribute("aria-pressed")).toBe("true");
		expect(patches).toHaveBeenCalledTimes(1);
	});

	test("controlled null waits for the page, and an invalid selection aborts the previous patch without fetching", async () => {
		spyOn(api, "getGitCommitDetail").mockResolvedValue(detail());
		const pending = deferred<GitCommitPatch>();
		const patches = spyOn(api, "getGitCommitDiff").mockReturnValue(pending.promise);
		const onSelectPath = mock((_path: string) => {});
		const renderPage = (selectedPath: string | null) =>
			renderUi(
				<GitCommitPreview
					target={TARGET}
					sha={SHA_A}
					mode="page"
					selectedPath={selectedPath}
					onSelectPath={onSelectPath}
				/>,
			);
		renderPage(null);
		await waitForFiles();
		expect(patches).not.toHaveBeenCalled();
		expect(bodyText()).toContain(gitLocale["commitPreview.selectFile"]);
		click(`[data-commit-file="${RENAMED_FILE}"]`);
		expect(onSelectPath).toHaveBeenCalledWith(RENAMED_FILE);
		await flushRender();
		expect(patches).not.toHaveBeenCalled();
		expect(element(`[data-commit-file="${RENAMED_FILE}"]`).getAttribute("aria-pressed")).toBe(
			"false",
		);
		renderPage(RENAMED_FILE);
		await waitFor(() => patches.mock.calls.length === 1, "controlled file patch");
		expect(patches.mock.calls[0]?.slice(0, 4)).toEqual([TARGET, SHA_A, RENAMED_FILE, OLD_PATH]);
		renderPage("../not-in-this-commit");
		await waitFor(
			() => bodyText().includes("The selected path is not in the available file list"),
			"invalid file",
		);
		await waitFor(() => patches.mock.calls[0]?.[4]?.aborted === true, "invalid selection abort");
		expect(patches).toHaveBeenCalledTimes(1);
		pending.resolve(textPatch("LATE_INVALID_SELECTION_PATCH"));
		await flushRender();
		expect(bodyText()).not.toContain("LATE_INVALID_SELECTION_PATCH");
		expect(document.body.querySelector("[data-commit-diff-card]")).toBeNull();
	});

	test("parent anchors preserve modified clicks and standalone links track the selected file", async () => {
		spyOn(api, "getGitCommitDetail").mockResolvedValue(detail());
		const navigate = mock((_sha: string) => {});
		renderUi(<GitCommitPreview target={TARGET} sha={SHA_A} onNavigateCommit={navigate} />);
		await waitForFiles();
		const parent = element(`[data-commit-parent="${PARENT}"]`);
		expect(parent.tagName).toBe("A");
		const parentHref = parent.getAttribute("href") ?? "";
		expect(parentHref).toContain(PARENT);
		expect(new URL(parentHref, "https://example.test").searchParams.get("workspaceKey")).toBe(
			TARGET.workspaceKey,
		);
		expect(new URL(parentHref, "https://example.test").searchParams.has("file")).toBe(false);
		for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey", "middle"] as const) {
			const event = new Event("click", { bubbles: true, cancelable: true });
			Object.defineProperties(event, {
				button: { value: modifier === "middle" ? 1 : 0 },
				[modifier]: { value: true },
			});
			parent.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(false);
		}
		expect(navigate).not.toHaveBeenCalled();
		const clickEvent = new Event("click", { bubbles: true, cancelable: true });
		Object.defineProperty(clickEvent, "button", { value: 0 });
		parent.dispatchEvent(clickEvent);
		expect(clickEvent.defaultPrevented).toBe(true);
		expect(navigate).toHaveBeenCalledWith(PARENT);
		const standalone = element("[data-commit-open-page]");
		expect(standalone.tagName).toBe("A");
		expect(standalone.getAttribute("target")).toBe("_blank");
		expect(
			new URL(standalone.getAttribute("href") ?? "", "https://example.test").searchParams.get(
				"file",
			),
		).toBe(FILE);
		click(`[data-commit-file="${RENAMED_FILE}"]`);
		await waitFor(
			() => (standalone.getAttribute("href") ?? "").includes("new"),
			"selected file link",
		);
		expect(
			new URL(standalone.getAttribute("href") ?? "", "https://example.test").searchParams.get(
				"file",
			),
		).toBe(RENAMED_FILE);
	});

	test("statistics explicitly distinguish unknown counts, binary files and truncated lists", async () => {
		spyOn(api, "getGitCommitDetail").mockResolvedValue(
			detail(SHA_A, {
				filesTruncated: true,
				files: [
					{ path: FILE, status: "modified", linesAdded: null, linesRemoved: 2, binary: false },
					{
						path: "image.bin",
						status: "added",
						linesAdded: null,
						linesRemoved: null,
						binary: true,
					},
				],
			}),
		);
		renderUi(<GitCommitPreview target={TARGET} sha={SHA_A} mode="page" selectedPath={null} />);
		await waitForFiles();
		const statistics = element("[data-commit-statistics]").textContent;
		expect(statistics).toContain(gitLocale["commitPreview.partialStats"]);
		expect(statistics).toContain(gitLocale["commitPreview.unknownStats"]);
		expect(statistics).toContain(gitLocale["commitPreview.binaryStats"]);
		expect(statistics).toContain("Only the first 2 files are listed");
		expect(element(`[data-commit-file="${FILE}"]`).textContent).toContain("+?");
	});
});

describe("GitPatchView presentation", () => {
	function renderPatch(
		diff: string | undefined,
		options: { truncated?: boolean; error?: Error; loading?: boolean } = {},
	) {
		renderUi(<GitPatchView diff={diff} file={FILE} resetKey="patch" {...options} />);
	}

	test.each([undefined, "", " \n\t"])("shows an explicit empty state for %j", async (diff) => {
		renderPatch(diff);
		await waitFor(() => bodyText().includes(gitLocale.noDiff), "empty patch");
		expect(document.body.querySelector("[data-diff-row], [data-git-patch-metadata]")).toBeNull();
	});

	test.each([
		["rename", RENAME_PATCH],
		["mode change", MODE_PATCH],
		[
			"empty file addition",
			"diff --git a/empty b/empty\nnew file mode 100644\nindex 0000000..e69de29\n",
		],
	])("shows %s metadata instead of a blank diff", async (_name, diff) => {
		renderPatch(diff);
		await waitFor(
			() => !!document.body.querySelector("[data-git-patch-metadata]"),
			"patch metadata",
		);
		expect(bodyText()).toContain(gitLocale.diffMetadataOnly);
		expect(element("[data-git-patch-metadata]").textContent).toBe(diff);
		expect(document.body.querySelector("[data-diff-row]")).toBeNull();
	});

	test.each([
		["binary", BINARY_PATCH, gitLocale.diffBinary],
		[
			"binary payload",
			"diff --git a/img b/img\nGIT binary patch\nliteral 3\nabc\n",
			gitLocale.diffBinary,
		],
		["metadata", RENAME_PATCH, gitLocale.diffMetadataOnly],
		["empty", "", gitLocale.noDiff],
	])("keeps the truncation warning for a %s patch", async (_name, diff, state) => {
		renderPatch(diff, { truncated: true });
		await waitFor(() => bodyText().includes(state), "patch state");
		expect(bodyText()).toContain(gitLocale.diffTruncated);
	});

	test.each([
		["characters", `rename from ${"x".repeat(20_000)}`],
		["lines", Array.from({ length: 200 }, () => "old mode 100644").join("\n")],
	])("bounds raw metadata %s and identifies its own preview ceiling", async (_name, diff) => {
		renderPatch(diff);
		await waitFor(
			() => !!document.body.querySelector("[data-git-patch-metadata]"),
			"bounded metadata",
		);
		const shown = element("[data-git-patch-metadata]").textContent ?? "";
		expect(shown.length).toBeLessThanOrEqual(8_192);
		expect(shown.split("\n").length).toBeLessThanOrEqual(80);
		expect(diff.startsWith(shown)).toBe(true);
		expect(bodyText()).toContain(gitLocale.diffMetadataTruncated);
		expect(bodyText()).not.toContain(gitLocale.diffTruncated);
	});

	test.each([
		["text", textPatch("STALE_TEXT").diff, "STALE_TEXT"],
		["metadata", RENAME_PATCH, gitLocale.diffMetadataOnly],
		["binary", BINARY_PATCH, gitLocale.diffBinary],
	])("an error replaces stale %s and all associated warnings", async (_name, diff, previousState) => {
		renderPatch(diff, { truncated: true });
		await waitFor(() => bodyText().includes(previousState), "initial patch state");
		renderPatch(diff, { truncated: true, error: new ApiError("Access revoked", 403) });
		await waitFor(() => bodyText().includes("Access revoked"), "patch error");
		expect(bodyText()).not.toContain(previousState);
		expect(bodyText()).not.toContain(gitLocale.diffTruncated);
		expect(document.body.querySelector("[data-diff-row], [data-git-patch-metadata]")).toBeNull();
	});
});
