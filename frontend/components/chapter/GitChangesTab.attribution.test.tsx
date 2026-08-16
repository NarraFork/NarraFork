/**
 * GitChangesTab.attribution.test.tsx — the "who changed this file" badge must not
 * count the contributor it is already naming.
 *
 * The bug this guards: the badge text and its "+N" were computed independently, so a
 * file whose ONLY contributor was an external edit rendered "External +1" — one
 * contributor presented as two. The deleted-session case had the same shape, and the
 * tooltip separately re-listed the very actor its first line already named.
 *
 * The existing GitPanel suite could not catch any of it: it only seeds `gitStatus`, so
 * `attrByPath` was always empty and no badge ever rendered. These tests seed the
 * attribution query too.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type {
	AttributionActor,
	FileModificationGroup,
	GitStatusSummary,
	WorkspaceModificationView,
} from "../../hooks/useGit";
import { __resetGitFolderPrefsCache } from "../../hooks/useGitFolderPrefs";
import commonLocale from "../../locales/en/common.json";
import gitLocale from "../../locales/en/git.json";
import { ConfirmDialogProvider } from "../common/ConfirmDialogProvider";

// Isolated i18next instance, for the same reason as GitPanel.test.tsx: sibling suites
// mutate the process-global default and would leave this one rendering raw keys.
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

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let root: Root | undefined;

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

/** One unstaged file, so a single badge is under test per render. */
function makeStatus(path = "src/one.ts"): GitStatusSummary {
	return {
		hasChanges: true,
		staged: 0,
		unstaged: 1,
		untracked: 0,
		files: [
			{
				status: " M",
				path,
				linesAdded: 1,
				linesRemoved: 0,
				stagedLinesAdded: 0,
				stagedLinesRemoved: 0,
				unstagedLinesAdded: 1,
				unstagedLinesRemoved: 0,
			},
		],
		totalFiles: 1,
		headSha: "abc1234",
		branch: "main",
		linesAdded: 1,
		linesRemoved: 0,
	};
}

const EXTERNAL_ACTOR: AttributionActor = {
	narratorId: null,
	title: null,
	subagentType: null,
	parentTitle: null,
	exists: false,
};

function narrator(overrides: Partial<AttributionActor> = {}): AttributionActor {
	return {
		narratorId: "n1",
		title: "Refactor auth",
		subagentType: null,
		parentTitle: null,
		exists: true,
		...overrides,
	};
}

function group(overrides: Partial<FileModificationGroup> = {}): FileModificationGroup {
	return {
		filePath: "src/one.ts",
		changeCount: 1,
		lastChangedAt: "2026-01-01T00:00:00.000Z",
		lastActor: EXTERNAL_ACTOR,
		actors: [EXTERNAL_ACTOR],
		hasExternalChange: false,
		hasImpreciseAttribution: false,
		hasDeletedActor: false,
		...overrides,
	};
}

function view(byFile: FileModificationGroup[]): WorkspaceModificationView {
	return {
		workspacePath: "/tmp/wt",
		deviceId: "local",
		byFile,
		hasMore: false,
		actors: byFile.flatMap((g) => g.actors),
		windowCount: byFile.reduce((sum, g) => sum + g.changeCount, 0),
	};
}

function flushRender() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Render the panel with BOTH queries seeded and open the folder so the file row (and
 * therefore its badge) exists.
 */
async function renderBadge(
	chapterId: string,
	modifications: WorkspaceModificationView,
	path = "src/one.ts",
): Promise<HTMLElement> {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
			mutations: { retry: false },
		},
	});
	queryClient.setQueryData(["gitStatus", chapterId], makeStatus(path));
	queryClient.setQueryData(["gitModifications", chapterId, "uncommitted"], modifications);

	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	root.render(
		<I18nextProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={queryClient}>
					<ConfirmDialogProvider>
						<GitChangesTab chapterId={chapterId} />
					</ConfirmDialogProvider>
				</QueryClientProvider>
			</MantineProvider>
		</I18nextProvider>,
	);
	await flushRender();

	// Folders default to collapsed, so the file row does not exist until one is opened.
	for (const row of Array.from(
		container.querySelectorAll('[role="button"][aria-label^="Expand folder "]'),
	)) {
		row.dispatchEvent(new Event("click", { bubbles: true }));
		await flushRender();
	}
	return container;
}

/** The attribution badge is the row element that carries a tooltip's text. */
function badgeText(container: HTMLElement, path = "src/one.ts"): string {
	const row = container.querySelector(`[role="button"][aria-label="View diff of ${path}"]`);
	if (!(row instanceof HTMLElement)) throw new Error(`Row not found: ${path}`);
	// Badges in the row: [0] is the porcelain status letter, [1] the attribution badge.
	const badges = Array.from(row.querySelectorAll(".mantine-Badge-root"));
	const badge = badges.at(1);
	if (!(badge instanceof HTMLElement)) throw new Error("Attribution badge not rendered");
	return badge.textContent ?? "";
}

/** Mantine puts the tooltip label on the trigger's aria-describedby target or title. */
function tooltipText(container: HTMLElement, path = "src/one.ts"): string {
	const row = container.querySelector(`[role="button"][aria-label="View diff of ${path}"]`);
	if (!(row instanceof HTMLElement)) throw new Error(`Row not found: ${path}`);
	const badge = Array.from(row.querySelectorAll(".mantine-Badge-root")).at(1);
	if (!(badge instanceof HTMLElement)) throw new Error("Attribution badge not rendered");
	// A closed Mantine Tooltip does not mount its label, so the badge also carries the
	// text as `aria-label` — which is where a screen reader reads it from too.
	return badge.getAttribute("aria-label") ?? "";
}

describe("GitChangesTab attribution badge", () => {
	beforeEach(async () => {
		installDom();
		__resetGitFolderPrefsCache();
		await initTestI18n();
	});

	afterEach(() => {
		if (!root) return;
		root.unmount();
		root = undefined;
	});

	test("a lone external contributor is not counted twice", async () => {
		// One contributor, one name, no "+1". The badge used to add the external flag on
		// top of the label already derived from it.
		const container = await renderBadge(
			"chapter-attr-external-only",
			view([group({ hasExternalChange: true })]),
		);

		expect(badgeText(container)).toBe("External");
		expect(badgeText(container)).not.toContain("+");
	});

	test("a lone deleted session is not counted twice", async () => {
		// Same shape via the other flag: a tool change whose narrator row is gone.
		const container = await renderBadge(
			"chapter-attr-deleted-only",
			view([group({ hasDeletedActor: true })]),
		);

		expect(badgeText(container)).toBe("Deleted session");
		expect(badgeText(container)).not.toContain("+");
	});

	test("a deleted lastActor is not also listed as an extra contributor", async () => {
		// `exists: false` on the last actor is the deleted-session case seen from a row
		// that still carries the id. The tooltip used to name it, then append "Also
		// modified by Deleted session" about the very same actor.
		const deleted = narrator({ narratorId: "gone", title: null, exists: false });
		const container = await renderBadge(
			"chapter-attr-deleted-lastactor",
			view([group({ lastActor: deleted, actors: [deleted], hasDeletedActor: true })]),
		);

		expect(badgeText(container)).toBe("Deleted session");
		expect(badgeText(container)).not.toContain("+");
		expect(tooltipText(container)).toBe("Last modified by Deleted session");
		expect(tooltipText(container)).not.toContain("Also modified by");
	});

	test("external and deleted together: the badge names one and counts the other", async () => {
		// External wins the label (it is the one still investigable), so the count must
		// subtract external and keep deleted — exactly one, not zero and not two.
		const container = await renderBadge(
			"chapter-attr-external-and-deleted",
			view([group({ hasExternalChange: true, hasDeletedActor: true })]),
		);

		expect(badgeText(container)).toBe("External +1");
		const tooltip = tooltipText(container);
		expect(tooltip).toContain("Last modified by External");
		// The remaining class is reported once, as an "also", and external is NOT
		// repeated as a separate line.
		expect(tooltip).toContain("Also modified by Deleted session");
		expect(tooltip).not.toContain("Also has external/terminal changes");
	});

	test("multiple narrator contributors are counted, excluding the one named", async () => {
		const last = narrator({ narratorId: "n1", title: "Refactor auth" });
		const other = narrator({ narratorId: "n2", title: "Fix tests" });
		const third = narrator({ narratorId: "n3", title: "Docs pass", subagentType: "general" });
		const container = await renderBadge(
			"chapter-attr-many-narrators",
			view([group({ lastActor: last, actors: [last, other, third], changeCount: 3 })]),
		);

		expect(badgeText(container)).toBe("Refactor auth +2");
		const tooltip = tooltipText(container);
		expect(tooltip).toContain("Last modified by Refactor auth");
		expect(tooltip).toContain("Also modified by Fix tests");
		expect(tooltip).toContain("Also modified by Docs pass (general subagent)");
	});

	test("an external change alongside a named narrator is reported as an extra", async () => {
		// The complement of the first test: here the label names a narrator, so the
		// external flag is genuinely additional information and must be counted.
		const last = narrator();
		const container = await renderBadge(
			"chapter-attr-narrator-plus-external",
			view([group({ lastActor: last, actors: [last], hasExternalChange: true })]),
		);

		expect(badgeText(container)).toBe("Refactor auth +1");
		expect(tooltipText(container)).toContain("Also has external/terminal changes");
	});

	test("a file with no recorded contributor renders no badge", async () => {
		// "Nobody wrote this" is the honest answer for an absent path; inventing a
		// contributor is worse than showing none.
		const container = await renderBadge("chapter-attr-none", view([]));

		expect(() => badgeText(container)).toThrow("Attribution badge not rendered");
	});

	test("an exhausted row window says so instead of implying nobody wrote the files", async () => {
		// `hasMore` with nothing in the rollup means the cap was spent entirely on rows
		// outside the per-file boundary — a missing badge here proves nothing.
		const container = await renderBadge("chapter-attr-truncated", {
			...view([]),
			hasMore: true,
			windowCount: 0,
		});

		expect(container.textContent).toContain("Attribution not fully loaded");
	});
});
