import { afterAll, afterEach, beforeEach, mock as bunMock, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import chaptersLocale from "../../locales/en/chapters.json";
import commonLocale from "../../locales/en/common.json";
import errorsLocale from "../../locales/en/errors.json";
import chaptersZhLocale from "../../locales/zh-CN/chapters.json";
import commonZhLocale from "../../locales/zh-CN/common.json";
import errorsZhLocale from "../../locales/zh-CN/errors.json";

// Isolated i18next instance + <I18nextProvider> so shared-singleton mutations from
// other frontend suites can't leave this suite rendering raw i18n keys.
const i18n = i18next.createInstance();

interface MergeCall {
	chapterId: string;
	data: { targetChapterId: string; strategy?: string; message?: string; mode?: string };
}

let mergeCalls: MergeCall[] = [];
let mergeResult: unknown = { success: true };
/** When set, `mergeChapter` rejects with a TestApiError carrying this shape. */
let mergeRejection: { message: string; data: Record<string, unknown> } | null = null;
let previewRejection: { message: string; data: Record<string, unknown> } | null = null;
let previewResult: {
	hasConflicts: boolean;
	conflictFiles: string[];
	isFastForward: boolean;
} = { hasConflicts: false, conflictFiles: [], isFastForward: false };
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
			checkMergeConflicts: () => {
				if (previewRejection) {
					const error = new TestApiError(previewRejection.message);
					error.data = previewRejection.data;
					return Promise.reject(error);
				}
				return Promise.resolve(previewResult);
			},
			mergeChapter: (chapterId: string, data: MergeCall["data"]) => {
				mergeCalls.push({ chapterId, data });
				if (mergeRejection) {
					const error = new TestApiError(mergeRejection.message);
					error.data = mergeRejection.data;
					return Promise.reject(error);
				}
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
			ns: ["chapters", "common", "errors"],
			resources: {
				en: { chapters: chaptersLocale, common: commonLocale, errors: errorsLocale },
				"zh-CN": {
					chapters: chaptersZhLocale,
					common: commonZhLocale,
					errors: errorsZhLocale,
				},
			},
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

// Locale-switching tests must not leave earlier roots subscribed to the same i18n instance.
afterEach(async () => {
	root?.unmount();
	root = undefined;
	container?.remove();
	container = undefined;
	queryClient?.clear();
	queryClient = undefined;
	await i18n.changeLanguage("en");
});

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

/** Select a real target through the combobox, enabling both preview and merge. */
async function chooseMergeTarget(targetLabel = "Trunk") {
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
}

async function mergeWithTarget(targetLabel = "Trunk") {
	await chooseMergeTarget(targetLabel);
	const button = findButton("Merge");
	if (button.disabled) throw new Error("merge button still disabled after choosing a target");
	button.dispatchEvent(new Event("click", { bubbles: true }));
	await flush();
}

async function checkPreview() {
	const button = findButton(i18n.t("checkConflicts"));
	if (button.disabled) throw new Error("preview button still disabled after choosing a target");
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

/**
 * How a failed merge is presented.
 *
 * The dirty-worktree cases used to be recognized by comparing the response's `error` field
 * against the literal strings "MERGE_DIRTY_SOURCE"/"MERGE_DIRTY_TARGET" — the server smuggled a
 * code through a prose field, so `error` could not hold a real sentence. They now arrive as
 * `messageCode` and are translated from the `errors` namespace, with the server's English kept
 * behind a disclosure.
 */
describe("merge failure presentation", () => {
	beforeEach(async () => {
		mergeCalls = [];
		notificationsShown = [];
		mergeResult = { success: true };
		mergeRejection = null;
		reviewConclusion = null;
		requireReviewBeforeMerge = false;
		installDom();
		await initTestI18n();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	test("localizes a dirty source worktree from its messageCode", async () => {
		// The server prose is deliberately NOT the catalog wording here. If it matched, this test
		// would pass even with the messageCode lookup removed — the raw-prose fallback alone would
		// produce the expected text, and the assertion would prove nothing about the contract.
		mergeRejection = {
			message: "sentinel-raw-source-prose",
			data: {
				error: "sentinel-raw-source-prose",
				code: "VALIDATION_ERROR",
				messageCode: "MERGE_DIRTY_SOURCE",
			},
		};
		render();
		await flush();
		await mergeWithTarget();

		// Asserted as a substring of the localized sentence rather than the whole thing, so
		// rewording the translation does not break a test about which error was chosen.
		expect(document.body.textContent).toContain("clean source worktree");
		// The affordance that keeps the raw server text reachable without cluttering the message.
		expect(document.body.textContent).toContain("Show original message");
	});

	test("distinguishes a dirty target from a dirty source", async () => {
		mergeRejection = {
			message: "dirty target",
			data: { error: "dirty target", code: "VALIDATION_ERROR", messageCode: "MERGE_DIRTY_TARGET" },
		};
		render();
		await flush();
		await mergeWithTarget();

		expect(document.body.textContent).toContain("clean target worktree");
		expect(document.body.textContent).not.toContain("clean source worktree");
	});

	test("keeps the server's own wording for an error with no messageCode", async () => {
		// The un-migrated majority. Previously anything unrecognized here collapsed into
		// "unknown error", discarding the one sentence that said what went wrong.
		mergeRejection = {
			message: "refusing to merge unrelated histories",
			data: { error: "refusing to merge unrelated histories", code: "GIT_ERROR" },
		};
		render();
		await flush();
		await mergeWithTarget();

		expect(document.body.textContent).toContain("refusing to merge unrelated histories");
		// No disclosure: it would only repeat the sentence already shown.
		expect(document.body.textContent).not.toContain("Show original message");
	});
});

describe.each(["en", "zh-CN"])("merge preview failure presentation (%s)", (locale) => {
	beforeEach(async () => {
		previewRejection = null;
		previewResult = { hasConflicts: false, conflictFiles: [], isFastForward: false };
		mergeRejection = null;
		reviewConclusion = null;
		requireReviewBeforeMerge = false;
		installDom();
		await initTestI18n();
		await i18n.changeLanguage(locale);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	test.each([
		{
			messageCode: "GIT_TREE_MERGE_FAILED",
			messageParams: { detail: "unable to read tree" },
		},
		{
			messageCode: "GIT_TREE_MERGE_FALLBACK_FAILED",
			messageParams: {
				version: "2.39.5",
				feature: "merge-tree --merge-base",
				detail: "temporary directory permission denied",
			},
		},
		{ messageCode: "GIT_TREE_MERGE_CONFLICTS_UNLISTED", messageParams: {} },
	])("translates a preview error using $messageCode", async ({ messageCode, messageParams }) => {
		// Deliberately differs from the English translation, so even the English test
		// fails if the modal falls back to the server's prose instead of messageCode.
		const raw = "sentinel-raw-preview-prose";
		previewRejection = {
			message: raw,
			data: { error: raw, code: "GIT_ERROR", messageCode, messageParams },
		};
		render();
		await flush();
		await chooseMergeTarget();
		await checkPreview();

		expect(document.body.textContent).toContain(i18n.t("conflictCheckFailed"));
		const message = document.body.querySelector("[role='alert'] p")?.textContent;
		expect(message).toBe(i18n.t(messageCode, { ns: "errors", replace: messageParams }));
		expect(message).not.toContain(raw);
		expect(document.body.textContent).toContain(i18n.t("showOriginal", { ns: "errors" }));
	});

	test.each([
		{
			titleKey: "noConflicts",
			result: { hasConflicts: false, conflictFiles: [], isFastForward: false },
		},
		{
			titleKey: "fastForward",
			result: { hasConflicts: false, conflictFiles: [], isFastForward: true },
		},
		{
			titleKey: "conflictsDetected",
			result: { hasConflicts: true, conflictFiles: ["source.ts"], isFastForward: false },
		},
	])("clears a stale $titleKey result when preview fails", async ({ titleKey, result }) => {
		previewResult = { ...result, conflictFiles: [...result.conflictFiles] };
		render();
		await flush();
		await chooseMergeTarget();
		await checkPreview();
		expect(document.body.textContent).toContain(i18n.t(titleKey));

		previewRejection = {
			message: "Git tree merge failed: preview unavailable",
			data: {
				code: "GIT_ERROR",
				messageCode: "GIT_TREE_MERGE_FAILED",
				messageParams: { detail: "preview unavailable" },
			},
		};
		await checkPreview();

		expect(document.body.textContent).toContain(i18n.t("conflictCheckFailed"));
		expect(document.body.textContent).not.toContain(i18n.t(titleKey));
		expect(document.body.textContent).not.toContain(i18n.t("mergeClean"));
		expect(document.body.querySelectorAll("[role='alert']")).toHaveLength(1);
	});
});
