import { afterAll, beforeEach, mock as bunMock, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import chaptersLocale from "../../locales/en/chapters.json";
import commonLocale from "../../locales/en/common.json";

const i18n = i18next.createInstance();

let cleanupReport: unknown = { cleaned: [], skipped: [], errors: [] };
let notificationsShown: Array<{
	title?: unknown;
	message?: unknown;
	color?: string;
	autoClose?: unknown;
}> = [];

const realModules = {
	"../../lib/api": { ...(await import("../../lib/api")) },
	"@mantine/notifications": { ...(await import("@mantine/notifications")) },
};

type MockedSpecifier = keyof typeof realModules;
const mockedSpecifiers = Object.keys(realModules) as MockedSpecifier[];

const mock = {
	module: (specifier: MockedSpecifier, factory: () => unknown) =>
		bunMock.module(specifier, factory),
	restore: () => bunMock.restore(),
};

afterAll(() => {
	for (const specifier of mockedSpecifiers) {
		const namespace = realModules[specifier];
		mock.module(specifier, () => namespace);
	}
	mock.restore();
});

const moduleMocks = {
	"../../lib/api": () => ({
		api: {
			cleanupChapters: () => Promise.resolve(cleanupReport),
		},
	}),
	"@mantine/notifications": () => ({
		notifications: {
			show: (payload: {
				title?: unknown;
				message?: unknown;
				color?: string;
				autoClose?: unknown;
			}) => {
				notificationsShown.push(payload);
				return "id";
			},
			hide: () => {},
			clean: () => {},
			update: () => {},
		},
		Notifications: () => null,
	}),
} satisfies Record<MockedSpecifier, () => unknown>;

for (const specifier of mockedSpecifiers) {
	mock.module(specifier, moduleMocks[specifier]);
}

const { ChapterCleanupModal } = await import("./ChapterCleanupModal");
const { ConfirmDialogProvider } = await import("../common/ConfirmDialogProvider");

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
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
	});
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		Document: window.Document,
		ShadowRoot: window.ShadowRoot,
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
			window.getComputedStyle?.bind(window) ?? (() => ({ getPropertyValue: () => "" })),
		IS_REACT_ACT_ENVIRONMENT: false,
	});
}

async function initTestI18n() {
	if (!i18n.isInitialized) {
		await i18n.use(initReactI18next).init({
			lng: "en",
			fallbackLng: "en",
			defaultNS: "chapters",
			ns: ["chapters", "common"],
			resources: { en: { chapters: chaptersLocale, common: commonLocale } },
			interpolation: { escapeValue: false },
			react: { useSuspense: false },
		});
	}
}

async function flush() {
	for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let queryClient: QueryClient | undefined;

function render() {
	if (!container || !root) throw new Error("test root not initialized");
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	root.render(
		<I18nextProvider i18n={i18n}>
			<MantineProvider env="test">
				<QueryClientProvider client={queryClient}>
					<ConfirmDialogProvider>
						<ChapterCleanupModal
							opened
							onClose={() => {}}
							chapters={[
								{ id: "ch-a", title: "Alpha branch", status: "active" },
								{ id: "ch-b", title: "Beta branch", status: "dormant" },
							]}
						/>
					</ConfirmDialogProvider>
				</QueryClientProvider>
			</MantineProvider>
		</I18nextProvider>,
	);
}

/** Tick the first chapter checkbox, then press the cleanup button. */
async function cleanupFirstChapter() {
	// React attaches its synthetic change handler for checkboxes to the click event, so
	// a bare "change" dispatch sets the DOM property without ever reaching `onChange`
	// and the component's `selected` state stays empty.
	const checkbox = document.body.querySelector("input[type='checkbox']");
	if (!(checkbox instanceof HTMLInputElement)) throw new Error("checkbox not found");
	checkbox.checked = true;
	checkbox.dispatchEvent(new Event("click", { bubbles: true }));
	await flush();

	const button = Array.from(document.body.querySelectorAll("button")).find((candidate) =>
		candidate.textContent?.includes("Cleanup 1 chapter(s)"),
	);
	if (!(button instanceof HTMLButtonElement)) {
		const seen = Array.from(document.body.querySelectorAll("button")).map((b) => b.textContent);
		throw new Error(`cleanup button not found; buttons: ${JSON.stringify(seen)}`);
	}
	button.dispatchEvent(new Event("click", { bubbles: true }));
	await flush();
}

describe("ChapterCleanupModal", () => {
	beforeEach(async () => {
		notificationsShown = [];
		cleanupReport = { cleaned: [], skipped: [], errors: [] };
		installDom();
		await initTestI18n();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	test("reports skipped chapters by title with a reason", async () => {
		// The request succeeds, so before the fix a cleanup that removed nothing looked
		// identical to one that removed everything.
		cleanupReport = { cleaned: [], skipped: ["ch-a"], errors: [] };
		render();
		await flush();
		await cleanupFirstChapter();

		expect(notificationsShown).toHaveLength(1);
		expect(notificationsShown[0].color).toBe("yellow");
		expect(notificationsShown[0].autoClose).toBe(false);
		expect(notificationsShown[0].message).toContain("Alpha branch");
		// The reason names Force, which is the action that resolves the common case.
		expect(notificationsShown[0].message).toContain("Force");
	});

	test("reports per-chapter errors alongside their titles", async () => {
		cleanupReport = {
			cleaned: [],
			skipped: [],
			errors: [{ chapterId: "ch-a", error: "worktree busy" }],
		};
		render();
		await flush();
		await cleanupFirstChapter();

		expect(notificationsShown).toHaveLength(1);
		expect(notificationsShown[0].message).toContain("Alpha branch");
		expect(notificationsShown[0].message).toContain("worktree busy");
	});

	test("stays quiet when everything was cleaned", async () => {
		cleanupReport = { cleaned: ["ch-a"], skipped: [], errors: [] };
		render();
		await flush();
		await cleanupFirstChapter();

		expect(notificationsShown).toHaveLength(0);
	});

	test("invalidates the graph and timeline views, not just the chapter list", async () => {
		// Cleanup removes worktrees and branches, so the story network and ruler views are
		// as stale afterwards as they are after a merge. Only ["chapters"] and ["graph"]
		// were invalidated, so both kept showing the chapter as active until something
		// else happened to refetch.
		cleanupReport = { cleaned: ["ch-a"], skipped: [], errors: [] };
		render();
		await flush();

		const invalidated: string[] = [];
		const client = queryClient;
		if (!client) throw new Error("query client not initialized");
		const original = client.invalidateQueries.bind(client);
		client.invalidateQueries = (filters?: { queryKey?: readonly unknown[] }) => {
			if (filters?.queryKey?.[0] != null) invalidated.push(String(filters.queryKey[0]));
			return original(filters as Parameters<typeof original>[0]);
		};

		await cleanupFirstChapter();

		expect(invalidated).toContain("chapters");
		expect(invalidated).toContain("graph");
		expect(invalidated).toContain("narraFlow");
		expect(invalidated).toContain("ruler");
		expect(invalidated).toContain("rulerSegment");
		expect(invalidated).toContain("chapterEdges");
	});
});
