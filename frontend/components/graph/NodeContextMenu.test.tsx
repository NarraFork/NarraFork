import { afterAll, beforeEach, mock as bunMock, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import graphLocale from "../../locales/en/graph.json";

const i18n = i18next.createInstance();

const realModules = {
	"../../hooks/usePlatform": { ...(await import("../../hooks/usePlatform")) },
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
	"../../hooks/usePlatform": () => ({
		useFsRevealCapability: () => ({ supported: false }),
		useNarratorReviewToolsCapability: () => ({
			supported: true,
			convertToSubagent: true,
			promote: true,
			dismiss: true,
		}),
		useChapterBatchMergeCapability: () => ({ supported: true }),
		useUploadCapability: () => ({ supported: true }),
	}),
} satisfies Record<MockedSpecifier, () => unknown>;

for (const specifier of mockedSpecifiers) {
	mock.module(specifier, moduleMocks[specifier]);
}

const { NodeContextMenu } = await import("./NodeContextMenu");

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
			defaultNS: "graph",
			ns: ["graph"],
			resources: { en: { graph: graphLocale } },
			interpolation: { escapeValue: false },
			react: { useSuspense: false },
		});
	}
}

async function flush() {
	for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let forkClicks = 0;
let dormantClicks = 0;

function renderMenu(nodeData: {
	title: string;
	status: string;
	role: string;
	isRoot?: boolean;
	worktreePath?: string | null;
}) {
	if (!container || !root) throw new Error("test root not initialized");
	root.render(
		<I18nextProvider i18n={i18n}>
			<MantineProvider env="test">
				<NodeContextMenu
					x={0}
					y={0}
					nodeId="chapter-one"
					nodeData={nodeData}
					onClose={() => {}}
					onFork={() => {
						forkClicks++;
					}}
					onReview={() => {}}
					onSetRole={() => {}}
					onDormant={() => {
						dormantClicks++;
					}}
					onWake={() => {}}
					onUnmerge={() => {}}
					onDelete={() => {}}
					onReveal={() => {}}
					onConvertToSubagent={() => {}}
					onPromoteReview={() => {}}
					onDismissReview={() => {}}
				/>
			</MantineProvider>
		</I18nextProvider>,
	);
}

function itemByText(text: string): HTMLButtonElement {
	const found = Array.from(document.body.querySelectorAll("button")).find(
		(candidate) => candidate.textContent?.trim() === text,
	);
	if (!(found instanceof HTMLButtonElement)) throw new Error(`menu item not found: ${text}`);
	return found;
}

/**
 * Whether the menu treats an item as unavailable.
 *
 * Reads `aria-disabled`, not the native `disabled` property: `<button disabled>` gets no
 * pointer events, so the Tooltip explaining WHY never opened, and the button also left
 * the tab order, putting the reason out of keyboard reach. The item now stays focusable
 * and advertises its state to assistive tech instead.
 */
function isUnavailable(button: HTMLButtonElement): boolean {
	return button.getAttribute("aria-disabled") === "true";
}

describe("NodeContextMenu action availability", () => {
	beforeEach(async () => {
		installDom();
		await initTestI18n();
		forkClicks = 0;
		dormantClicks = 0;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	test("offers Request Review on a dormant chapter, which the server accepts", async () => {
		// `reviewService.createReview` takes active OR dormant, so hiding this on dormant
		// was a stricter-than-backend restriction that auto-dormant triggered on a timer.
		renderMenu({ title: "Parked", status: "dormant", role: "branch", worktreePath: null });
		await flush();

		const labels = Array.from(document.body.querySelectorAll("button")).map((b) =>
			b.textContent?.trim(),
		);
		expect(labels).toContain("Request Review");
	});

	test("allows fork and dormant on an active chapter with a worktree", async () => {
		renderMenu({
			title: "Feature",
			status: "active",
			role: "branch",
			worktreePath: "/repo/.worktrees/feature",
		});
		await flush();

		expect(isUnavailable(itemByText("Fork"))).toBe(false);
		expect(isUnavailable(itemByText("Set Dormant"))).toBe(false);

		itemByText("Fork").dispatchEvent(new Event("click", { bubbles: true }));
		itemByText("Set Dormant").dispatchEvent(new Event("click", { bubbles: true }));
		await flush();
		expect(forkClicks).toBe(1);
		expect(dormantClicks).toBe(1);
	});

	test("allows fork on a dormant chapter, which the server accepts", async () => {
		// `chapterFork.fork` takes an active OR dormant parent. Dormant is an ordinary
		// resting state produced on a timer by auto-dormant, so disabling fork here would
		// be a stricter-than-backend restriction, not a guard.
		renderMenu({ title: "Parked", status: "dormant", role: "branch", worktreePath: null });
		await flush();

		expect(isUnavailable(itemByText("Fork"))).toBe(false);
		itemByText("Fork").dispatchEvent(new Event("click", { bubbles: true }));
		await flush();
		expect(forkClicks).toBe(1);
	});

	test("blocks fork on a merged chapter, which the server rejects", async () => {
		renderMenu({ title: "Landed", status: "merged", role: "branch", worktreePath: null });
		await flush();
		expect(isUnavailable(itemByText("Fork"))).toBe(true);
		itemByText("Fork").dispatchEvent(new Event("click", { bubbles: true }));
		await flush();
		expect(forkClicks).toBe(0);
	});

	test("blocks dormant when an active chapter has no worktree", async () => {
		// `chapterCleanup.dormant` requires a worktree as well as an active status; the
		// status check alone let this through.
		renderMenu({ title: "Detached", status: "active", role: "branch", worktreePath: null });
		await flush();

		expect(isUnavailable(itemByText("Set Dormant"))).toBe(true);
		itemByText("Set Dormant").dispatchEvent(new Event("click", { bubbles: true }));
		await flush();
		expect(dormantClicks).toBe(0);
	});

	test("offers Wake for a dormant chapter", async () => {
		renderMenu({ title: "Parked", status: "dormant", role: "branch", worktreePath: null });
		await flush();
		expect(isUnavailable(itemByText("Wake Up"))).toBe(false);
	});

	test("offers Unmerge rather than Wake for a merged chapter", async () => {
		// `chapterCleanup.wake` now refuses merged chapters and points at unmerge: waking
		// one erased the merge coordinates while leaving its changes applied downstream.
		renderMenu({ title: "Landed", status: "merged", role: "branch", worktreePath: null });
		await flush();

		const labels = Array.from(document.body.querySelectorAll("button")).map((b) =>
			b.textContent?.trim(),
		);
		expect(labels).not.toContain("Wake Up");
		expect(labels).toContain("Unmerge");
	});

	test("an unavailable Fork explains itself to assistive tech and stays reachable", async () => {
		// `<button disabled>` receives no pointer events, so the Tooltip carrying
		// `forkRequiresActive` never opened and `opacity: 0.4` was the only cue; the button
		// was also out of the tab order, putting the reason beyond keyboard reach entirely.
		renderMenu({ title: "Landed", status: "merged", role: "branch", worktreePath: null });
		await flush();

		const fork = itemByText("Fork");
		expect(isUnavailable(fork)).toBe(true);
		// Focusable: a native `disabled` would remove it from the tab order along with the
		// hover/focus events the tooltip needs.
		expect(fork.hasAttribute("disabled")).toBe(false);
		expect(fork.getAttribute("tabindex")).not.toBe("-1");

		// The reason is announced via aria-describedby regardless of tooltip visibility.
		const describedBy = fork.getAttribute("aria-describedby");
		expect(describedBy).toBeTruthy();
		const description = document.getElementById(describedBy ?? "");
		expect(description?.textContent).toBe(
			"Only active or dormant chapters can be forked. This one is merged or abandoned.",
		);
	});

	test("an unavailable Set Dormant explains its worktree requirement", async () => {
		renderMenu({ title: "Detached", status: "active", role: "branch", worktreePath: null });
		await flush();

		const dormant = itemByText("Set Dormant");
		expect(isUnavailable(dormant)).toBe(true);
		expect(dormant.hasAttribute("disabled")).toBe(false);

		const describedBy = dormant.getAttribute("aria-describedby");
		const description = document.getElementById(describedBy ?? "");
		expect(description?.textContent).toBe(
			"This chapter has no worktree, so there is nothing to make dormant.",
		);
	});

	test("an available action carries no unavailability description", async () => {
		// The description must not leak into the accessible name of an enabled item.
		renderMenu({
			title: "Feature",
			status: "active",
			role: "branch",
			worktreePath: "/repo/.worktrees/feature",
		});
		await flush();

		expect(itemByText("Fork").getAttribute("aria-describedby")).toBeNull();
		expect(itemByText("Set Dormant").getAttribute("aria-describedby")).toBeNull();
	});
});
