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
	CurrentDiffTarget,
	CurrentDiffView,
	FileModificationGroup,
	GitStatusSummary,
	ModificationEventSummary,
	WorkspaceModificationView,
} from "../../hooks/useGit";
import { __resetGitFolderPrefsCache } from "../../hooks/useGitFolderPrefs";
import commonLocale from "../../locales/en/common.json";
import gitLocale from "../../locales/en/git.json";
import zhGitLocale from "../../locales/zh-CN/git.json";
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
			resources: {
				en: { common: commonLocale, git: gitLocale },
				"zh-CN": { git: zhGitLocale },
			},
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
	kind: "external_unknown",
	narratorId: null,
	userId: null,
	title: null,
	subagentType: null,
	parentTitle: null,
	exists: false,
	deleted: false,
	identityKnown: false,
};
function narrator(overrides: Partial<AttributionActor> = {}): AttributionActor {
	return {
		kind: "primary",
		narratorId: "n1",
		userId: null,
		deleted: false,
		identityKnown: true,
		title: "Refactor auth",
		subagentType: null,
		parentTitle: null,
		exists: true,
		...overrides,
	};
}

function group(overrides: Partial<FileModificationGroup> = {}): FileModificationGroup {
	const lastActor = overrides.lastActor ?? EXTERNAL_ACTOR;
	const actors = overrides.actors ?? [lastActor];
	return {
		filePath: "src/one.ts",
		changeCount: 1,
		lastChangedAt: "2026-01-01T00:00:00.000Z",
		lastAction: "external",
		lastActor,
		actors,
		recentEvents: [],
		hasExternalChange: false,
		hasImpreciseAttribution: true,
		hasDeletedActor: false,
		completeness: {
			fileHistoryComplete: true,
			contributorsTruncated: false,
			countsLowerBound: actors.some((actor) => !actor.identityKnown),
			warningScanComplete: actors.every((actor) => actor.deleted !== null),
			asOfRevision: null,
		},
		evidence: "legacy",
		attributionGrade: "observed_ambiguous",
		...overrides,
	};
}

function event(
	actor: AttributionActor,
	overrides: Partial<ModificationEventSummary> = {},
): ModificationEventSummary {
	return {
		id: "event-1",
		changedAt: "2026-01-01T12:34:00.000Z",
		action: "edit",
		actor,
		evidence: "legacy",
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
		completeness: {
			fileHistoryComplete: byFile.every((group) => group.completeness.fileHistoryComplete),
			contributorsTruncated: byFile.some((group) => group.completeness.contributorsTruncated),
			countsLowerBound: byFile.some((group) => group.completeness.countsLowerBound),
			warningScanComplete: byFile.every((group) => group.completeness.warningScanComplete),
			asOfRevision: null,
		},
		evidence: "legacy",
		baselineStatus: "unverified",
	};
}

function currentTarget(overrides: Partial<CurrentDiffTarget> = {}): CurrentDiffTarget {
	return {
		source: "current_diff",
		target: "worktree",
		status: "matching_evidence",
		actor: narrator(),
		effectId: "effect-id",
		reason: null,
		baselineVersion: "a".repeat(64),
		historyComplete: true,
		modeScope: "filesystem",
		continuity: "unverified",
		...overrides,
	};
}
function currentView(
	index: CurrentDiffTarget,
	worktree: CurrentDiffTarget,
	overrides: Partial<CurrentDiffView> = {},
): CurrentDiffView {
	return {
		source: "current_diff",
		baselineStatus: "stable",
		version: "a".repeat(64),
		headSha: "abc1234",
		clean: false,
		complete: true,
		scope: {
			id: "scope",
			sourceInstanceId: "source",
			workspaceInstanceId: "instance",
			revision: 2,
		},
		byFile: [{ filePath: "src/one.ts", index, worktree }],
		...overrides,
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
	statusOverride?: GitStatusSummary,
): Promise<HTMLElement> {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
			mutations: { retry: false },
		},
	});
	queryClient.setQueryData(["gitStatus", chapterId], statusOverride ?? makeStatus(path));
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

/** The row keeps only the porcelain status badge; attribution is behind its hover target. */
function rowFor(container: HTMLElement, path = "src/one.ts"): HTMLElement {
	const row = container.querySelector(`[role="button"][aria-label="View diff of ${path}"]`);
	if (!(row instanceof HTMLElement)) throw new Error(`Row not found: ${path}`);
	return row;
}

function statusBadge(container: HTMLElement, path = "src/one.ts"): HTMLElement {
	const badge = rowFor(container, path).querySelector(".mantine-Badge-root");
	if (!(badge instanceof HTMLElement)) throw new Error("Git status badge not rendered");
	return badge;
}

function attributionTarget(container: HTMLElement): HTMLElement {
	const target = container.querySelector('[data-attribution-hover-target="true"]');
	if (!(target instanceof HTMLElement)) throw new Error("Attribution hover target not rendered");
	return target;
}

async function hoverAttribution(container: HTMLElement): Promise<string> {
	const target = attributionTarget(container);
	target.dispatchEvent(new Event("mouseenter", { bubbles: true }));
	target.dispatchEvent(new Event("mouseover", { bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, 180));
	await flushRender();
	return document.body.textContent ?? "";
}

describe("GitChangesTab attribution hover card", () => {
	beforeEach(async () => {
		installDom();
		__resetGitFolderPrefsCache();
		await initTestI18n();
		await i18n.changeLanguage("en");
	});

	afterEach(() => {
		if (!root) return;
		root.unmount();
		root = undefined;
	});

	test("keeps attribution out of the file row and uses the Git status badge as target", async () => {
		const last = narrator();
		const container = await renderBadge(
			"chapter-attr-hover-target",
			view([
				group({
					lastActor: last,
					actors: [last],
					recentEvents: [event(last)],
				}),
			]),
		);
		const row = rowFor(container);

		expect(row.querySelectorAll(".mantine-Badge-root")).toHaveLength(1);
		expect(statusBadge(container).textContent).toBe("M");
		expect(row.textContent).not.toContain("Refactor auth");
		expect(attributionTarget(container).getAttribute("title")).toBeNull();
	});

	test("shows current evidence and a compact timeline only on hover", async () => {
		const currentActor = narrator();
		const external = { ...EXTERNAL_ACTOR };
		const container = await renderBadge("chapter-attr-hover-timeline", {
			...view([
				group({
					lastActor: currentActor,
					actors: [currentActor, external],
					recentEvents: [
						event(currentActor, { id: "event-current", action: "write" }),
						event(external, { id: "event-external", action: "external" }),
					],
				}),
			]),
			currentDiff: currentView(
				currentTarget({ actor: currentActor }),
				currentTarget({ actor: currentActor }),
			),
		});
		const row = rowFor(container);
		expect(row.textContent).not.toContain("Refactor auth");

		const hoverText = await hoverAttribution(container);
		expect(hoverText).toContain("Current diff evidence");
		expect(hoverText).toContain("Refactor auth");
		expect(hoverText).toContain("Recent changes");
		expect(hoverText).toContain("External");
		expect(hoverText).not.toContain(gitLocale.attributionCurrentExplanation);
	});

	test("unknown attribution shows one short reason instead of a text dump", async () => {
		const unknown = currentTarget({ status: "unknown", actor: null, reason: "state_mismatch" });
		const container = await renderBadge("chapter-attr-hover-unknown", {
			...view([group({ recentEvents: [event(EXTERNAL_ACTOR)] })]),
			currentDiff: currentView(unknown, unknown),
		});

		const hoverText = await hoverAttribution(container);
		expect(hoverText).toContain("Current diff evidence");
		expect(hoverText).toContain("Unknown");
		expect(hoverText).toContain("Current bytes do not match the record");
		expect(hoverText).not.toContain(gitLocale.attributionContinuityUnknown);
		expect(hoverText).not.toContain(gitLocale.attributionNotCurrentOwnership);
	});

	test("a clean target removes the attribution hover target", async () => {
		const clean = currentTarget({ status: "clean", actor: null });
		const container = await renderBadge("chapter-attr-hover-clean", {
			...view([group({ lastActor: narrator() })]),
			currentDiff: currentView(clean, clean, { clean: true }),
		});

		expect(rowFor(container).querySelectorAll(".mantine-Badge-root")).toHaveLength(1);
		expect(() => attributionTarget(container)).toThrow("Attribution hover target not rendered");
	});

	test("partial history is one short warning in the hover card", async () => {
		const last = narrator();
		const container = await renderBadge("chapter-attr-hover-partial", {
			...view([
				group({
					lastActor: last,
					recentEvents: [event(last)],
					completeness: {
						fileHistoryComplete: false,
						contributorsTruncated: true,
						countsLowerBound: true,
						warningScanComplete: false,
						asOfRevision: null,
					},
				}),
			]),
		});

		const hoverText = await hoverAttribution(container);
		expect(hoverText).toContain("History is incomplete");
		expect(hoverText).not.toContain(gitLocale.attributionHistoryTruncated);
	});

	test("the compact hover labels have Chinese translations", () => {
		expect(zhGitLocale.attributionHistoryShort).toBe("最近修改");
		expect(zhGitLocale.attributionCurrentUnknownShort).toBe("未知");
	});
});
