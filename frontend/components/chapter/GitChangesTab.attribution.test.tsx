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
const UNKNOWN_NARRATOR: AttributionActor = {
	...EXTERNAL_ACTOR,
	kind: "narrator_unknown",
	deleted: null,
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
		await i18n.changeLanguage("en");
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

		expect(badgeText(container)).toBe("External · incomplete");
		expect(badgeText(container)).not.toContain("+");
	});

	test("a lone deleted session is not counted twice", async () => {
		// Same shape via the other flag: a tool change whose narrator row is gone.
		const container = await renderBadge(
			"chapter-attr-deleted-only",
			view([
				group({
					lastActor: UNKNOWN_NARRATOR,
					lastAction: "write",
					actors: [UNKNOWN_NARRATOR],
					hasDeletedActor: null,
				}),
			]),
		);

		expect(badgeText(container)).toBe("Unknown session (identity missing or deleted) · incomplete");
		expect(badgeText(container)).not.toContain("+");
	});

	test("a deleted lastActor is not also listed as an extra contributor", async () => {
		// `exists: false` on the last actor is the deleted-session case seen from a row
		// that still carries the id. The tooltip used to name it, then append "Also
		// modified by Deleted session" about the very same actor.
		const deleted = narrator({ narratorId: "gone", title: null, exists: false, deleted: true });
		const container = await renderBadge(
			"chapter-attr-deleted-lastactor",
			view([group({ lastActor: deleted, actors: [deleted], hasDeletedActor: true })]),
		);

		expect(badgeText(container)).toBe("Deleted session");
		expect(badgeText(container)).not.toContain("+");
		expect(tooltipText(container)).toContain("Latest observed actor: Deleted session");
		expect(tooltipText(container)).not.toContain("Previously observed participant:");
	});

	test("external then deleted narrator uses the last event, not historical flags", async () => {
		const container = await renderBadge(
			"chapter-attr-external-and-deleted",
			view([
				group({
					lastActor: UNKNOWN_NARRATOR,
					lastAction: "edit",
					actors: [UNKNOWN_NARRATOR, EXTERNAL_ACTOR],
					hasExternalChange: true,
					hasDeletedActor: null,
				}),
			]),
		);
		expect(badgeText(container)).toBe("Unknown session (identity missing or deleted) · incomplete");
		const tooltip = tooltipText(container);
		expect(tooltip).toContain("Latest observed actor: Unknown session");
		expect(tooltip).toContain("Latest observed action: Edit");
		expect(tooltip).toContain("Previously observed participant: External");
		expect(tooltip).not.toContain("Latest observed actor: External");
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
		expect(tooltip).toContain("Latest observed actor: Refactor auth");
		expect(tooltip).toContain("Previously observed participant: Fix tests");
		expect(tooltip).toContain("Previously observed participant: Docs pass (general subagent)");
	});

	test("an external observation is shown without inventing a distinct extra identity", async () => {
		const last = narrator();
		const container = await renderBadge(
			"chapter-attr-narrator-plus-external",
			view([group({ lastActor: last, actors: [last, EXTERNAL_ACTOR], hasExternalChange: true })]),
		);
		expect(badgeText(container)).toBe("Refactor auth · incomplete");
		expect(tooltipText(container)).toContain("Previously observed participant: External");
		expect(tooltipText(container)).toContain(gitLocale.attributionCountsLowerBound);
	});

	test("a file with no recorded contributor renders no badge", async () => {
		// An absent path has no observation to label. This is not evidence that no one
		// changed the file; the panel explains the distinction instead of inventing an actor.
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

		expect(container.textContent).toContain(gitLocale.attributionWindowTruncated);
	});

	test("a nonempty capped window still reports incomplete contributors", async () => {
		const last = narrator();
		const container = await renderBadge("chapter-attr-partial-nonempty", {
			...view([group({ lastActor: last, actors: [last] })]),
			hasMore: true,
			windowCount: 1,
		});

		expect(badgeText(container)).toBe("Refactor auth");
		expect(container.textContent).toContain(gitLocale.attributionWindowTruncated);
	});

	test("a complete nonempty window does not show the truncation warning", async () => {
		const container = await renderBadge(
			"chapter-attr-complete-nonempty",
			view([group({ hasExternalChange: true })]),
		);

		expect(badgeText(container)).toBe("External · incomplete");
		expect(container.textContent).not.toContain(gitLocale.attributionWindowTruncated);
	});

	test("the incomplete-window warning has the same meaning in Chinese", async () => {
		await i18n.changeLanguage("zh-CN");
		const container = await renderBadge(
			"chapter-attr-partial-zh",
			{ ...view([]), hasMore: true, windowCount: 4 },
			"one.ts",
		);

		expect(container.textContent).toContain(zhGitLocale.attributionWindowTruncated);
		expect(container.textContent).not.toContain(gitLocale.attributionWindowTruncated);
	});

	test("human saves name the real users and do not collapse null narratorIds", async () => {
		const alice = narrator({ kind: "human", narratorId: null, userId: "u1", title: "Alice" });
		const bob = narrator({ kind: "human", narratorId: null, userId: "u2", title: "Bob" });
		const container = await renderBadge(
			"chapter-human-users",
			view([group({ lastActor: bob, lastAction: "human", actors: [bob, alice] })]),
		);
		expect(badgeText(container)).toBe("User: Bob +1");
		expect(tooltipText(container)).toContain("Previously observed participant: User: Alice");
		expect(tooltipText(container)).toContain("Latest observed action: User save");
	});

	test("a deleted user's lost identity is explicitly unknown, never external", async () => {
		const missingUser = { ...EXTERNAL_ACTOR, kind: "human" as const, deleted: null };
		const container = await renderBadge(
			"chapter-human-unknown",
			view([group({ lastActor: missingUser, lastAction: "human", actors: [missingUser] })]),
		);
		expect(badgeText(container)).toBe("Unknown user (identity missing or deleted) · incomplete");
		expect(tooltipText(container)).not.toContain("Latest observed actor: External");
	});

	test("a ten-row slice renders lower-bound counts and unknown flags in its badge", async () => {
		const last = narrator();
		const other = narrator({ narratorId: "n2", title: "Earlier" });
		const container = await renderBadge("chapter-file-truncated", {
			...view([
				group({
					lastActor: last,
					actors: [last, other],
					changeCount: 10,
					hasExternalChange: null,
					hasDeletedActor: null,
					completeness: {
						fileHistoryComplete: false,
						contributorsTruncated: true,
						countsLowerBound: true,
						warningScanComplete: false,
						asOfRevision: null,
					},
				}),
			]),
			hasMore: true,
		});
		expect(badgeText(container)).toBe("Refactor auth +≥1 · incomplete");
		expect(tooltipText(container)).toContain(gitLocale.attributionHistoryTruncated);
		expect(tooltipText(container)).toContain(gitLocale.attributionFlagsUnknown);
		expect(tooltipText(container)).toContain(gitLocale.attributionCountsLowerBound);
		expect(container.textContent).toContain(gitLocale.attributionWindowTruncated);
	});

	test("complete Write history still distinguishes observations from the current net diff", async () => {
		const last = narrator();
		const container = await renderBadge(
			"chapter-legacy-observation",
			view([group({ lastActor: last, lastAction: "write", actors: [last] })]),
		);
		expect(container.textContent).toContain(gitLocale.attributionObservationOnly);
		expect(tooltipText(container)).toContain(gitLocale.attributionHistoryComplete);
		expect(tooltipText(container)).toContain(gitLocale.attributionLegacyObserved);
		expect(tooltipText(container)).toContain(gitLocale.attributionNotCurrentOwnership);
		expect(container.textContent).not.toContain(gitLocale.attributionWindowTruncated);
	});

	test("current index and worktree rows display their own evidence rather than history counts", async () => {
		const ai = narrator();
		const person = narrator({ kind: "human", narratorId: null, userId: "human", title: "Alice" });
		const status = makeStatus();
		status.staged = 1;
		status.files[0].status = "MM";
		status.files[0].stagedLinesAdded = 1;
		const current = currentView(
			currentTarget({ target: "index", modeScope: "git_executable_bit", actor: ai }),
			currentTarget({ actor: person }),
		);
		const container = await renderBadge(
			"chapter-current-split",
			{ ...view([group({ lastActor: ai, actors: [ai, person] })]), currentDiff: current },
			"src/one.ts",
			status,
		);
		const rows = Array.from(
			container.querySelectorAll('[role="button"][aria-label="View diff of src/one.ts"]'),
		);
		expect(rows).toHaveLength(2);
		const captions = rows.map((row) => row.querySelectorAll(".mantine-Badge-root")[1]?.textContent);
		expect(captions).toEqual(["Evidence: Refactor auth", "Evidence: User: Alice"]);
		expect(container.textContent).toContain(gitLocale.attributionCurrentExplanation);
		expect(tooltipText(container)).toContain(gitLocale.attributionContinuityUnknown);
		expect(tooltipText(container)).toContain("Baseline version: aaaaaaaaaaaa");
	});

	test("a clean live workspace suppresses historical badges even if the status cache is old", async () => {
		const clean = currentTarget({ status: "clean", actor: null });
		const container = await renderBadge("chapter-current-clean", {
			...view([group({ lastActor: narrator() })]),
			currentDiff: currentView(clean, clean, { clean: true }),
		});
		expect(() => badgeText(container)).toThrow("Attribution badge not rendered");
	});

	test("stale and unknown current baselines never show the historic actor as current", async () => {
		const matching = currentTarget();
		const container = await renderBadge("chapter-current-stale", {
			...view([group({ lastActor: narrator() })]),
			currentDiff: currentView(matching, matching, {
				baselineStatus: "stale",
				version: null,
				complete: false,
			}),
		});
		expect(badgeText(container)).toBe("Attribution unknown · incomplete");
		expect(tooltipText(container)).toContain(gitLocale.attributionCurrentUnknown);
		expect(tooltipText(container)).toContain(gitLocale.attributionHistorySection);
	});

	test("matching evidence retains deleted human type without inventing a name", async () => {
		const person = narrator({
			kind: "human",
			narratorId: null,
			userId: "gone",
			title: null,
			exists: false,
			deleted: true,
		});
		const current = currentTarget({ actor: person });
		const container = await renderBadge("chapter-current-deleted-human", {
			...view([]),
			currentDiff: currentView(currentTarget({ status: "clean", actor: null }), current),
		});
		expect(badgeText(container)).toBe("Evidence: Deleted user (name unknown)");
		expect(tooltipText(container)).toContain(gitLocale.attributionContinuityUnknown);
	});
});
