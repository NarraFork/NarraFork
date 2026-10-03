import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	setDefaultTimeout,
	spyOn,
	test,
} from "bun:test";
import { MantineProvider } from "@mantine/core";
import { GIT_COMMIT_PREVIEW_UNSUPPORTED, type GitCommitDetail } from "@shared/git-commit-preview";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { ApiError, api } from "../../lib/api";
import { type GitWorkspace, gitBasePath } from "../../lib/api/git";
import { buildCommitPreviewHref } from "../../lib/git-commit-preview-navigation";
import commonLocale from "../../locales/en/common.json";
import gitLocale from "../../locales/en/git.json";
import { installCanvasStub } from "../narrator/vlist/measure/test-canvas-stub";

// Real Router/React transitions can exceed Bun's 5s default on busy Windows runners.
setDefaultTimeout(20_000);
// Actual file-route components, query hooks, and shared preview. Only API I/O is mocked.
const disposeCanvas = installCanvasStub();
const { Route: narratorRoute } = await import(
	"../../routes/git/narrators/$narratorId/commits/$sha"
);
const { Route: chapterRoute } = await import("../../routes/git/chapters/$chapterId/commits/$sha");
const SHA = "a".repeat(40);
const PARENT = "b".repeat(64);
const FILE = "src/one.ts";
const SECOND = "docs/中文 +#?% new.md";
const OLD = "docs/old.md";
const TARGET = { narratorId: "narrator-one", workspaceKey: "device-a:/repo", canWrite: false };

function workspace(overrides: Partial<GitWorkspace> = {}): GitWorkspace {
	return {
		workspaceKey: TARGET.workspaceKey,
		repositoryKey: "repo-key",
		deviceId: "device-a",
		cwd: "/repo",
		rootPath: "/repo",
		state: "ready",
		capabilities: { read: true, write: false },
		...overrides,
	};
}
function detail(sha = SHA): GitCommitDetail {
	return {
		sha,
		shortSha: sha.slice(0, 7),
		parents: sha === SHA ? [PARENT] : [],
		authorName: "Private Author",
		authorEmail: "private@example.test",
		authoredAt: "2026-06-10T11:00:00Z",
		committerName: "Private Author",
		committerEmail: "private@example.test",
		committedAt: "2026-06-10T11:00:00Z",
		message: `Private commit ${sha}`,
		messageTruncated: false,
		comparedTo: sha === SHA ? PARENT : null,
		files:
			sha === SHA
				? [
						{ path: FILE, status: "modified", linesAdded: 1, linesRemoved: 1, binary: false },
						{
							path: SECOND,
							oldPath: OLD,
							status: "renamed",
							linesAdded: 0,
							linesRemoved: 0,
							binary: false,
						},
					]
				: [{ path: "parent.txt", status: "added", linesAdded: 1, linesRemoved: 0, binary: false }],
		filesTruncated: false,
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

const i18n = createInstance();
let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
let restoreDom: () => void;
let router: ReturnType<typeof makeRouter> | undefined;

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const undo: Array<() => void> = [];
	const patch = (object: object, values: PropertyDescriptorMap) => {
		for (const [key, descriptor] of Object.entries(values)) {
			const old = Object.getOwnPropertyDescriptor(object, key);
			Object.defineProperty(object, key, descriptor);
			undo.push(() =>
				old ? Object.defineProperty(object, key, old) : Reflect.deleteProperty(object, key),
			);
		}
	};
	const matchMedia = (media: string) => ({
		matches: false,
		media,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
	});
	const storage = new Map<string, string>();
	const values = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
		HTMLButtonElement: window.HTMLButtonElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		location: new URL("https://example.test/"),
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		ShadowRoot: class {},
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
	patch(window.HTMLElement.prototype, {
		clientHeight: { configurable: true, get: () => 500 },
		clientWidth: { configurable: true, get: () => 700 },
		clientTop: { configurable: true, get: () => 0 },
		scrollHeight: { configurable: true, get: () => 500 },
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
	restoreDom = () => {
		for (const restore of undo.reverse()) restore();
	};
}
function makeRouter(href: string) {
	const rootRoute = createRootRoute({
		component: () => (
			<main data-app-shell>
				<Outlet />
			</main>
		),
	});
	const narrator = narratorRoute.update({
		getParentRoute: () => rootRoute,
		path: "/git/narrators/$narratorId/commits/$sha",
		id: "/git/narrators/$narratorId/commits/$sha",
	} as never);
	const chapter = chapterRoute.update({
		getParentRoute: () => rootRoute,
		path: "/git/chapters/$chapterId/commits/$sha",
		id: "/git/chapters/$chapterId/commits/$sha",
	} as never);
	return createRouter({
		routeTree: rootRoute.addChildren([
			narrator,
			chapter,
			createRoute({
				getParentRoute: () => rootRoute,
				path: "/narrators/$narratorId",
				component: () => <div data-narrator-dock />,
			}),
			createRoute({
				getParentRoute: () => rootRoute,
				path: "/chapters/$chapterId",
				component: () => <div data-chapter-owner />,
			}),
		]),
		history: createMemoryHistory({ initialEntries: [href] }),
		defaultPendingMinMs: 0,
	});
}
async function mount(href: string) {
	router = makeRouter(href);
	await router.load();
	root.render(
		<I18nextProvider i18n={i18n}>
			<MantineProvider env="test">
				<QueryClientProvider client={queryClient}>
					<RouterProvider router={router} />
				</QueryClientProvider>
			</MantineProvider>
		</I18nextProvider>,
	);
	return router;
}
async function tick() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}
async function waitFor(predicate: () => boolean, message = "render") {
	for (let i = 0; i < 150; i++) {
		if (predicate()) return;
		await tick();
	}
	throw new Error(`Timed out waiting for ${message}: ${document.body.textContent}`);
}
const text = () => document.body.textContent ?? "";
function click(selector: string) {
	const element = document.querySelector(selector);
	if (!element) throw new Error(`Missing ${selector}`);
	const event = new Event("click", { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		button: { value: 0 },
		metaKey: { value: false },
		ctrlKey: { value: false },
		shiftKey: { value: false },
		altKey: { value: false },
	});
	element.dispatchEvent(event);
}
async function expectSelected(file: string) {
	await waitFor(
		() =>
			Array.from(document.querySelectorAll("[data-commit-file]")).some(
				(element) =>
					element.getAttribute("data-commit-file") === file &&
					element.getAttribute("aria-pressed") === "true",
			),
		`selected ${file}`,
	);
}

beforeEach(async () => {
	installDom();
	if (!i18n.isInitialized)
		await i18n.use(initReactI18next).init({
			lng: "en",
			fallbackLng: "en",
			resources: { en: { git: gitLocale, common: commonLocale } },
			interpolation: { escapeValue: false },
			react: { useSuspense: false },
		});
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	spyOn(api, "getNarrator").mockResolvedValue({ id: TARGET.narratorId, cwd: "/repo" });
	spyOn(api, "getGitWorkspace").mockResolvedValue(workspace());
	spyOn(api, "getGitCommitDetail").mockImplementation(async (_target, sha) => detail(sha));
	spyOn(api, "getGitCommitDiff").mockResolvedValue({
		diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+PRIVATE_PATCH\n",
		truncated: false,
	});
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
	router?.history.destroy();
	router = undefined;
	await tick();
	container.remove();
	mock.restore();
	restoreDom();
});
afterAll(disposeCanvas);

describe("standalone commit file routes with real memory history", () => {
	test("chapter direct entry resolves metadata without a narrator Dock or previous state", async () => {
		const route = await mount(buildCommitPreviewHref("chapter-one", SHA));
		await expectSelected(FILE);
		expect(route.history.length).toBe(1);
		expect(new URLSearchParams(route.state.location.searchStr).get("file")).toBe(FILE);
		expect(api.getGitWorkspace).not.toHaveBeenCalled();
		expect(api.getGitCommitDetail).toHaveBeenCalledWith(
			"chapter-one",
			SHA,
			expect.any(AbortSignal),
		);
		expect(document.querySelector("[data-app-shell] [data-commit-preview=page]")).not.toBeNull();
		expect(document.querySelector("[data-narrator-dock]")).toBeNull();
		expect(document.querySelector('a[href="/chapters/chapter-one"]')).not.toBeNull();
	});

	test("a fresh narrator deep link probes its workspace and reads only the exact encoded selection", async () => {
		const route = await mount(
			`${buildCommitPreviewHref(TARGET, SHA, SECOND)}&rootPath=%2Fsecret&canWrite=true`,
		);
		await expectSelected(SECOND);
		expect(api.getNarrator).toHaveBeenCalledWith(TARGET.narratorId);
		expect(api.getGitWorkspace).toHaveBeenCalled();
		expect(api.getGitCommitDetail).toHaveBeenCalledWith(
			expect.objectContaining({ ...TARGET, rootPath: "/repo" }),
			SHA,
			expect.any(AbortSignal),
		);
		expect(api.getGitCommitDiff).toHaveBeenCalledTimes(1);
		expect(api.getGitCommitDiff).toHaveBeenCalledWith(
			expect.objectContaining(TARGET),
			SHA,
			SECOND,
			OLD,
			expect.any(AbortSignal),
		);
		expect(route.history.length).toBe(1);
		expect(document.querySelector('a[href="/narrators/narrator-one"]')).not.toBeNull();
	});

	test("missing pin and first selection replace; file clicks push; back/forward and parent navigation retain URL state", async () => {
		const route = await mount(`/git/narrators/${TARGET.narratorId}/commits/${SHA}`);
		await expectSelected(FILE);
		expect(route.history.length).toBe(1);
		expect(route.state.location.search).toMatchObject({
			file: FILE,
			workspaceKey: TARGET.workspaceKey,
		});
		click(`[data-commit-file="${SECOND}"]`);
		await expectSelected(SECOND);
		expect(route.history.length).toBe(2);
		route.history.back();
		await expectSelected(FILE);
		route.history.forward();
		await expectSelected(SECOND);
		const parentLink = document.querySelector(`[data-commit-parent="${PARENT}"]`);
		expect(parentLink?.getAttribute("href")).toBe(buildCommitPreviewHref(TARGET, PARENT));
		click(`[data-commit-parent="${PARENT}"]`);
		await expectSelected("parent.txt");
		expect(route.history.length).toBe(3);
		expect(route.state.location.pathname.endsWith(PARENT)).toBe(true);
		expect(route.state.location.search).toMatchObject({
			file: "parent.txt",
			workspaceKey: TARGET.workspaceKey,
		});
		route.history.back();
		await expectSelected(SECOND);
		expect(route.state.location.pathname.endsWith(SHA)).toBe(true);
	}, 20_000);

	test("reopening the copied URL with an empty query cache restores the selected file", async () => {
		const first = await mount(buildCommitPreviewHref(TARGET, SHA, SECOND));
		await expectSelected(SECOND);
		const href = first.state.location.href;
		root.unmount();
		first.history.destroy();
		queryClient.clear();
		root = createRoot(container);
		queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		await mount(href);
		await expectSelected(SECOND);
		expect(api.getGitCommitDetail).toHaveBeenCalledTimes(2);
		expect(api.getGitCommitDiff).toHaveBeenCalledTimes(2);
	}, 20_000);

	test("a workspace mismatch does not load commit facts or silently rewrite the pin", async () => {
		const old = { ...TARGET, workspaceKey: "previous-device:/repo" };
		const href = buildCommitPreviewHref(old, SHA, FILE);
		const route = await mount(href);
		await waitFor(() => text().includes("workspace has changed"));
		expect(api.getGitCommitDetail).not.toHaveBeenCalled();
		expect(api.getGitCommitDiff).not.toHaveBeenCalled();
		expect(route.state.location.href).toBe(href);
		click("button");
		await tick();
		expect(route.state.location.href).toBe(href);
	});

	test("changing the repository while mounted hides its old content and keeps the original pin", async () => {
		const route = await mount(buildCommitPreviewHref(TARGET, SHA, FILE));
		await expectSelected(FILE);
		spyOn(api, "getGitWorkspace").mockResolvedValue(
			workspace({ workspaceKey: "device-b:/elsewhere" }),
		);
		await queryClient.invalidateQueries({ queryKey: ["gitWorkspace"] });
		await waitFor(() => text().includes("workspace has changed"));
		expect(text()).not.toContain("Private Author");
		expect(text()).not.toContain("PRIVATE_PATCH");
		expect(route.state.location.search.workspaceKey).toBe(TARGET.workspaceKey);
		expect(api.getGitCommitDetail).toHaveBeenCalledTimes(1);
	});

	test("numeric and JSON-looking filenames survive direct entry, normalization, and file navigation", async () => {
		const paths = ["123", "[ 1, 2 ]", '"quoted"'];
		spyOn(api, "getGitCommitDetail").mockResolvedValue({
			...detail(),
			files: paths.map((path) => ({
				path,
				status: "added",
				linesAdded: 1,
				linesRemoved: 0,
				binary: false,
			})),
		});
		const route = await mount(buildCommitPreviewHref("chapter-one", SHA, paths[1]));
		await expectSelected(paths[1]);
		click(`[data-commit-file="${paths[0]}"]`);
		await expectSelected(paths[0]);
		expect(route.state.location.search.file).toBe(paths[0]);
		await route.navigate({ href: buildCommitPreviewHref("chapter-one", SHA) });
		await waitFor(() => route.state.location.search.file === paths[0]);
		await expectSelected(paths[0]);
		await route.navigate({ href: buildCommitPreviewHref("chapter-one", SHA, paths[2]) });
		await expectSelected(paths[2]);
		expect(route.state.location.search.file).toBe(paths[2]);
		expect(api.getGitCommitDiff).toHaveBeenCalledWith(
			"chapter-one",
			SHA,
			paths[1],
			undefined,
			expect.any(AbortSignal),
		);
	}, 20_000);

	test("an unavailable selected path is an explicit error, never an arbitrary diff request", async () => {
		await mount(buildCommitPreviewHref("chapter-one", SHA, "/arbitrary/secret"));
		await waitFor(() => text().includes("selected file is not"));
		expect(api.getGitCommitDetail).toHaveBeenCalledTimes(1);
		expect(api.getGitCommitDiff).not.toHaveBeenCalled();
	});

	test.each([
		`/git/chapters/chapter-one/commits/HEAD`,
		`/git/narrators/narrator-one/commits/${"a".repeat(41)}`,
		`/git/chapters/chapter-one/commits/${SHA}?file=`,
		`/git/chapters/chapter-one/commits/${SHA}?file=a&file=b`,
		`/git/chapters/chapter-one/commits/${SHA}?file=${"a".repeat(4097)}`,
		`/git/narrators/narrator-one/commits/${SHA}?workspaceKey=a&workspaceKey=b`,
	])("rejects invalid route parameters before any Git I/O: %.90s", async (href) => {
		await mount(href);
		await waitFor(() => text().includes("Invalid commit preview URL"));
		expect(api.getGitWorkspace).not.toHaveBeenCalled();
		expect(api.getGitCommitDetail).not.toHaveBeenCalled();
		expect(api.getGitCommitDiff).not.toHaveBeenCalled();
	});

	test("a fresh-looking workspace cache must be reauthorized before showing cached private facts", async () => {
		queryClient.setQueryData(["narrators", TARGET.narratorId], {
			id: TARGET.narratorId,
			cwd: "/repo",
		});
		queryClient.setQueryData(
			["gitWorkspace", TARGET.narratorId, ["/repo", undefined, undefined, undefined]],
			workspace(),
		);
		queryClient.setQueryData(
			["gitCommitDetail", TARGET.workspaceKey, SHA, gitBasePath(TARGET)],
			detail(),
		);
		const pending = deferred<GitWorkspace>();
		const probe = spyOn(api, "getGitWorkspace").mockReturnValue(pending.promise);
		await mount(buildCommitPreviewHref(TARGET, SHA, FILE));
		await waitFor(() => probe.mock.calls.length > 0);
		expect(text()).not.toContain("Private Author");
		expect(api.getGitCommitDetail).not.toHaveBeenCalled();
		pending.reject(new ApiError("Forbidden", 403));
		await waitFor(() => text().includes("do not have access"));
		expect(text()).not.toContain("Private Author");
		expect(api.getGitCommitDiff).not.toHaveBeenCalled();
	});

	test("chapter cache also requires fresh authorization; failure hides it and retry can recover", async () => {
		queryClient.setQueryData(
			["gitCommitDetail", "chapter-one", SHA, "/chapters/chapter-one/git"],
			detail(),
		);
		const pending = deferred<GitCommitDetail>();
		const read = spyOn(api, "getGitCommitDetail").mockReturnValue(pending.promise);
		await mount(buildCommitPreviewHref("chapter-one", SHA, FILE));
		await waitFor(() => read.mock.calls.length > 0);
		expect(text()).not.toContain("Private Author");
		pending.reject(new ApiError("Forbidden", 403));
		await waitFor(() => text().includes("do not have access"));
		expect(text()).not.toContain("Private Author");
		expect(api.getGitCommitDiff).not.toHaveBeenCalled();
		spyOn(api, "getGitCommitDetail").mockResolvedValue(detail());
		click("button");
		await expectSelected(FILE);
	});

	test.each([
		"device_offline",
		"unsupported",
		"access_denied",
	] as const)("workspace state %s is actionable and can recover", async (state) => {
		spyOn(api, "getGitWorkspace").mockResolvedValue(
			workspace({ state, capabilities: { read: false, write: false } }),
		);
		await mount(buildCommitPreviewHref(TARGET, SHA, FILE));
		await waitFor(() => !!document.querySelector('[role="alert"]'));
		expect(api.getGitCommitDetail).not.toHaveBeenCalled();
		spyOn(api, "getGitWorkspace").mockResolvedValue(workspace());
		click("button");
		await expectSelected(FILE);
	});

	test.each([404, 409, 503])("HTTP %i remains explicit and offers retry", async (status) => {
		spyOn(api, "getGitCommitDetail").mockRejectedValue(new ApiError("Unavailable", status));
		await mount(buildCommitPreviewHref("chapter-one", SHA));
		await waitFor(() => !!document.querySelector('[role="alert"]'));
		expect(document.querySelector("button")?.textContent).toBe("Refresh");
		expect(api.getGitCommitDiff).not.toHaveBeenCalled();
	});

	test("an old executor does not create a workspace re-probe retry loop", async () => {
		spyOn(api, "getGitCommitDetail").mockRejectedValue(
			new ApiError("Unsupported", 409, { code: GIT_COMMIT_PREVIEW_UNSUPPORTED }),
		);
		await mount(buildCommitPreviewHref(TARGET, SHA));
		await waitFor(() => text().includes("too old"));
		for (let i = 0; i < 5; i++) await tick();
		expect(api.getGitCommitDetail).toHaveBeenCalledTimes(1);
		expect(api.getGitCommitDiff).not.toHaveBeenCalled();
	});
});
