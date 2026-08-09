import { afterAll, beforeEach, mock as bunMock, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import chaptersLocale from "../../locales/en/chapters.json";
import commonLocale from "../../locales/en/common.json";

// Isolated i18next instance + <I18nextProvider> so shared-singleton mutations from
// other frontend suites can't leave this suite rendering raw i18n keys.
const i18n = i18next.createInstance();

interface MergeCall {
	chapterId: string;
	data: { targetChapterId: string; strategy?: string; message?: string; mode?: string };
}

let mergeCalls: MergeCall[] = [];
let mergeResult: unknown = { success: true };
let notificationsShown: Array<{
	title?: unknown;
	message?: unknown;
	color?: string;
	autoClose?: unknown;
}> = [];
/** null = no conclusion recorded; "throw" = the conclusion query fails. */
let reviewConclusion: { verdict: string } | null | "throw" = null;
let requireReviewBeforeMerge = false;

/**
 * Real namespaces snapshotted BEFORE any mock is installed, so `afterAll` can point
 * each specifier back at the genuine module. `mock.module` is process-wide and
 * `mock.restore()` does not undo it, so a stub left standing — especially one that
 * omits an export — breaks unrelated suites loaded later in the same `bun test`
 * process with a misleading "Export named 'x' not found" at import time.
 */
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

class TestApiError extends Error {
	data?: Record<string, unknown>;
}

const moduleMocks = {
	"../../lib/api": () => ({
		ApiError: TestApiError,
		api: {
			getProject: () =>
				Promise.resolve({
					id: "project-one",
					chapterSettings: { requireReviewBeforeMerge },
				}),
			listChapters: () =>
				Promise.resolve([
					{ id: "chapter-one", title: "Source", status: "active" },
					{ id: "chapter-two", title: "Trunk", status: "active" },
				]),
			getReviewConclusionForSource: () =>
				reviewConclusion === "throw"
					? Promise.reject(new Error("network down"))
					: Promise.resolve({ conclusion: reviewConclusion }),
			checkMergeConflicts: () =>
				Promise.resolve({ hasConflicts: false, conflictFiles: [], isFastForward: false }),
			mergeChapter: (chapterId: string, data: MergeCall["data"]) => {
				mergeCalls.push({ chapterId, data });
				return Promise.resolve(mergeResult);
			},
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

const { ChapterMergeModal } = await import("./ChapterMergeModal");

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

	// linkedom has no `scrollIntoView`, and Mantine's combobox calls it on the
	// already-selected option when a dropdown with a value opens — which is every
	// Select in this modal except the empty target one.
	if (!window.Element.prototype.scrollIntoView) {
		window.Element.prototype.scrollIntoView = () => {};
	}

	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		MouseEvent: window.MouseEvent,
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
					<ChapterMergeModal
						chapterId="chapter-one"
						projectId="project-one"
						opened
						onClose={() => {}}
					/>
				</QueryClientProvider>
			</MantineProvider>
		</I18nextProvider>,
	);
}

function findButton(text: string): HTMLButtonElement {
	const button = Array.from(document.body.querySelectorAll("button")).find(
		(candidate) => candidate.textContent?.trim() === text,
	);
	if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`);
	return button;
}

/**
 * Choose a merge target, then click the modal's own Merge button.
 *
 * The target Select is a Mantine combobox; opening its dropdown and clicking an option
 * is what makes the component's `targetId` state real, which is what un-disables the
 * button. Everything after that — payload assembly, onSuccess, warning handling — is
 * the component's own code path.
 */
/**
 * Open the merge-mode Select and choose an option by its visible label.
 *
 * Identified by current value rather than position, so reordering the modal's fields
 * cannot silently retarget this at the strategy or target Select.
 */
async function chooseMergeMode(optionLabel: string) {
	const modeInput = Array.from(document.body.querySelectorAll("input")).find(
		(input) =>
			input.value === "Workspace (default)" || input.value === "Commit (real merge commit)",
	);
	if (!modeInput) throw new Error("merge mode input not found");
	modeInput.dispatchEvent(new Event("click", { bubbles: true }));
	await flush();

	const option = Array.from(document.body.querySelectorAll("[role='option']")).find(
		(candidate) => candidate.textContent?.trim() === optionLabel,
	);
	if (!option) throw new Error(`merge mode option not found: ${optionLabel}`);
	option.dispatchEvent(new Event("click", { bubbles: true }));
	await flush();
}

async function mergeWithTarget(targetLabel = "Trunk") {
	// `Event`, not `MouseEvent`: linkedom does not implement the latter, and React's
	// synthetic click handler only needs the type and bubbling.
	const targetInput = document.body.querySelector("input");
	if (!(targetInput instanceof HTMLInputElement)) throw new Error("target input not found");
	targetInput.dispatchEvent(new Event("click", { bubbles: true }));
	await flush();

	const option = Array.from(document.body.querySelectorAll("[role='option']")).find(
		(candidate) => candidate.textContent?.trim() === targetLabel,
	);
	if (!option) throw new Error(`target option not found: ${targetLabel}`);
	option.dispatchEvent(new Event("click", { bubbles: true }));
	await flush();

	const button = findButton("Merge");
	if (button.disabled) throw new Error("merge button still disabled after choosing a target");
	button.dispatchEvent(new Event("click", { bubbles: true }));
	await flush();
}

describe("ChapterMergeModal", () => {
	beforeEach(async () => {
		mergeCalls = [];
		mergeResult = { success: true };
		notificationsShown = [];
		reviewConclusion = null;
		requireReviewBeforeMerge = false;
		installDom();
		await initTestI18n();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterAll(() => {
		root?.unmount();
		container?.remove();
		queryClient?.clear();
	});

	test("offers both merge modes and describes the default as history-free", async () => {
		render();
		await flush();

		expect(document.body.textContent).toContain("Merge mode");
		// The default has to say it does not touch git history — that is the whole
		// difference from the commit mode, and the reason it is the default.
		expect(document.body.textContent).toContain("nothing is written to your git history");
		const modeInput = Array.from(document.body.querySelectorAll("input")).find(
			(input) => input.value === "Workspace (default)",
		);
		expect(modeInput).toBeDefined();
	});

	test("does not block the merge button when the review check fails", async () => {
		requireReviewBeforeMerge = true;
		reviewConclusion = "throw";
		render();
		await flush();

		// The failure is reported, and reported as a check failure rather than as a
		// missing approval: those are different states and only one of them is a block.
		expect(document.body.textContent).toContain("Could not check review status");
		expect(document.body.textContent).toContain("Retry check");
		expect(document.body.textContent).not.toContain("Review approval required");
		// The decisive assertion: with a target chosen, the merge actually goes through.
		// Before the fix the failed check left this button disabled forever, including
		// for chapters that did have an approval recorded.
		await mergeWithTarget();
		expect(mergeCalls).toHaveLength(1);
	});

	test("blocks the merge when a loaded conclusion is not an approval", async () => {
		requireReviewBeforeMerge = true;
		reviewConclusion = { verdict: "request_changes" };
		render();
		await flush();

		expect(document.body.textContent).toContain("Review requested changes");
		expect(document.body.textContent).not.toContain("Could not check review status");
	});

	test("accepts a loaded approval without any warning banner", async () => {
		requireReviewBeforeMerge = true;
		reviewConclusion = { verdict: "approve" };
		render();
		await flush();

		expect(document.body.textContent).not.toContain("Review approval required");
		expect(document.body.textContent).not.toContain("Could not check review status");
	});
});

/**
 * What the modal sends, and what it does with a warning that comes back.
 *
 * Driven by clicking the modal's own Merge button after seeding the target through the
 * Select's hidden input, so the assertions cover the component's payload assembly and
 * its onSuccess handler rather than the api stub. Mode selection itself is asserted
 * from the rendered Select above; here the default value is what matters, since that
 * is what every existing user of this modal will now send.
 */
describe("merge payload and warning presentation", () => {
	beforeEach(async () => {
		mergeCalls = [];
		notificationsShown = [];
		mergeResult = { success: true };
		reviewConclusion = null;
		requireReviewBeforeMerge = false;
		installDom();
		await initTestI18n();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	test("sends mode: snapshot by default, so no clean worktree is demanded", async () => {
		render();
		await flush();
		await mergeWithTarget();

		expect(mergeCalls).toHaveLength(1);
		expect(mergeCalls[0].chapterId).toBe("chapter-one");
		// The regression was that `mode` was absent from the request entirely, leaving
		// users no way to reach the commit path. It is now always explicit.
		expect(mergeCalls[0].data.mode).toBe("snapshot");
	});

	test("shows a non-expiring yellow notification for a warning on success", async () => {
		mergeResult = { success: true, warning: "The source worktree was kept." };
		render();
		await flush();
		await mergeWithTarget();

		expect(notificationsShown).toHaveLength(1);
		expect(notificationsShown[0].color).toBe("yellow");
		// autoClose:false is the point — this information must survive the user looking
		// away, unlike an ordinary success toast.
		expect(notificationsShown[0].autoClose).toBe(false);
		expect(notificationsShown[0].message).toContain("source worktree was kept");
	});

	test("shows nothing when a success carries no warning", async () => {
		mergeResult = { success: true };
		render();
		await flush();
		await mergeWithTarget();

		expect(mergeCalls).toHaveLength(1);
		expect(notificationsShown).toHaveLength(0);
	});

	test("sends mode: commit once the user picks the commit option", async () => {
		render();
		await flush();
		// This is the path that had no UI entry point at all: a user who needs a real
		// merge commit (to push, or to run CI on) could not ask for one.
		await chooseMergeMode("Commit (real merge commit)");
		await mergeWithTarget();

		expect(mergeCalls).toHaveLength(1);
		expect(mergeCalls[0].data.mode).toBe("commit");
	});

	test("describes the commit mode's clean-worktree requirement when selected", async () => {
		render();
		await flush();
		await chooseMergeMode("Commit (real merge commit)");

		expect(document.body.textContent).toContain("Both chapters must have a clean worktree");
	});
});
