/**
 * NodeTitleEditor — the node header's title, and the two title actions that moved
 * here from the embedded NarratorPanel header.
 *
 * Scope note: this harness can drive CLICK and KEYDOWN, but not typing. React's
 * change-event path does not run under linkedom — dispatching `input` / `change` at
 * an `<input>` (Mantine's or a plain one) never reaches the synthetic `onChange`, so
 * a typed value cannot be simulated at all. What the committed value should be is
 * therefore pinned on the pure decision function instead
 * (`./node-title-commit.test.ts`), and this suite covers what the DOM really shows:
 * which controls exist, and what a click on each one does.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { api } from "../../lib/api";
import narratorLocale from "../../locales/en/narrator.json";

// Isolated i18next instance: other frontend suites mutate the process-global
// default (changeLanguage, differing namespace init), which would leave this one
// rendering raw keys. The lib/i18n mock points the component's own import at the
// same instance. Mirrors GitPanel.test.tsx.
const i18n = i18next.createInstance();
mock.module("../../lib/i18n", () => ({
	supportedLanguages: ["en", "zh-CN"],
	namespaces: ["narrator"],
	normalizeLanguage: (language: string | null | undefined) => language ?? "en",
	getNamespacesForPath: () => ["narrator"],
	getInitialNamespaces: () => ["narrator"],
	ensureI18nNamespaces: async () => {},
	changeAppLanguage: async () => i18n,
	initI18n: async () => i18n,
	default: i18n,
}));

const { NodeTitleEditor } = await import("./NodeTitleEditor");

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let restoreApi: (() => void) | undefined;

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const store = new Map<string, string>();
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

	// linkedom ships no `HTMLInputElement.select()`. Every real browser has it, and
	// the component calls it to select the existing title on entering edit mode, so
	// this is a harness gap rather than something the component should guard against.
	const inputPrototype = window.HTMLInputElement?.prototype as
		| (HTMLInputElement & { select?: () => void })
		| undefined;
	if (inputPrototype && typeof inputPrototype.select !== "function") {
		inputPrototype.select = () => {};
	}

	Object.assign(globalThis, {
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
		localStorage: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, value),
			removeItem: (key: string) => store.delete(key),
			clear: () => store.clear(),
		},
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
	if (i18n.isInitialized) return;
	await i18n.use(initReactI18next).init({
		lng: "en",
		fallbackLng: "en",
		defaultNS: "narrator",
		ns: ["narrator"],
		resources: { en: { narrator: narratorLocale } },
		interpolation: { escapeValue: false },
		react: { useSuspense: false },
	});
}

interface RecordedCall {
	name: string;
	id: string;
	body?: unknown;
}

function stubApi(calls: RecordedCall[]) {
	const original = {
		updateChapter: api.updateChapter,
		generateNarratorTitle: api.generateNarratorTitle,
	};
	api.updateChapter = (async (id: string, data: Record<string, unknown>) => {
		calls.push({ name: "updateChapter", id, body: data });
		return {} as never;
	}) as typeof api.updateChapter;
	api.generateNarratorTitle = (async (id: string) => {
		calls.push({ name: "generateNarratorTitle", id });
		return { title: "generated" };
	}) as typeof api.generateNarratorTitle;
	restoreApi = () => Object.assign(api, original);
}

function flush() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Settle a render whose result depends on an effect-driven state update: the
 * concurrent root commits, the effect runs, and only the NEXT pass paints the
 * outcome. One macrotask covers the commit but not that second pass.
 */
async function flushTwice() {
	await flush();
	await flush();
}

function render(props: {
	chapterId: string;
	narratorId: string | null;
	title: string;
	showActions: boolean;
}) {
	if (!root) throw new Error("test root not initialized");
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	root.render(
		<I18nextProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={queryClient}>
					<NodeTitleEditor {...props} />
				</QueryClientProvider>
			</MantineProvider>
		</I18nextProvider>,
	);
}

function buttonByLabel(label: string): HTMLButtonElement | null {
	const button = container?.querySelector(`button[aria-label="${label}"]`);
	return button instanceof HTMLButtonElement ? button : null;
}

function requireButton(label: string): HTMLButtonElement {
	const button = buttonByLabel(label);
	if (!button) throw new Error(`Button not found: ${label}`);
	return button;
}

function titleInput(): HTMLInputElement {
	const input = container?.querySelector("input");
	if (!(input instanceof HTMLInputElement)) throw new Error("Title input not found");
	return input;
}

function click(element: Element) {
	element.dispatchEvent(new Event("click", { bubbles: true }));
}

/**
 * linkedom has no `KeyboardEvent`, so the key rides on a plain bubbling Event —
 * which is all React's synthetic event reads to populate `event.key`.
 */
function pressKey(target: Element, key: string) {
	const event = new Event("keydown", { bubbles: true });
	Object.defineProperty(event, "key", { value: key });
	target.dispatchEvent(event);
}

describe("NodeTitleEditor", () => {
	beforeEach(async () => {
		installDom();
		await initTestI18n();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		restoreApi?.();
		restoreApi = undefined;
		root?.unmount();
		container?.remove();
		root = undefined;
		container = undefined;
	});

	test("shows the title without actions when they are not offered", async () => {
		stubApi([]);
		render({
			chapterId: "chapter-1",
			narratorId: "narrator-1",
			title: "Project manager",
			showActions: false,
		});
		await flush();

		expect(container?.textContent).toContain("Project manager");
		expect(buttonByLabel("Edit title")).toBeNull();
		expect(buttonByLabel("Generate title")).toBeNull();
	});

	test("the pencil opens an input seeded with the current title", async () => {
		stubApi([]);
		render({
			chapterId: "chapter-1",
			narratorId: "narrator-1",
			title: "Old title",
			showActions: true,
		});
		await flush();

		click(requireButton("Edit title"));
		await flush();

		// Seeded, not blank: an editor that starts empty turns "fix a typo" into
		// "retype the whole title".
		expect(titleInput().value).toBe("Old title");
	});

	test("committing an unchanged title writes nothing", async () => {
		const calls: RecordedCall[] = [];
		stubApi(calls);
		render({
			chapterId: "chapter-1",
			narratorId: "narrator-1",
			title: "Same title",
			showActions: true,
		});
		await flush();

		click(requireButton("Edit title"));
		await flush();
		pressKey(titleInput(), "Enter");
		await flush();

		expect(calls).toEqual([]);
	});

	test("escape closes the editor without writing", async () => {
		const calls: RecordedCall[] = [];
		stubApi(calls);
		render({
			chapterId: "chapter-1",
			narratorId: "narrator-1",
			title: "Old title",
			showActions: true,
		});
		await flush();

		click(requireButton("Edit title"));
		await flush();
		pressKey(titleInput(), "Escape");
		await flush();

		expect(calls).toEqual([]);
		expect(container?.querySelector("input")).toBeNull();
		expect(container?.textContent).toContain("Old title");
	});

	test("collapsing the node while editing drops the editor", async () => {
		stubApi([]);
		const props = {
			chapterId: "chapter-1",
			narratorId: "narrator-1",
			title: "Old title",
		};
		render({ ...props, showActions: true });
		await flush();
		click(requireButton("Edit title"));
		await flush();
		expect(container?.querySelector("input")).not.toBeNull();

		// A collapsed node offers no actions, so a half-finished edit must not stay
		// mounted — it would reappear, still holding a stale draft, on re-expand.
		render({ ...props, showActions: false });
		await flushTwice();
		expect(container?.querySelector("input")).toBeNull();
	});

	test("generates a title through the bound narrator", async () => {
		const calls: RecordedCall[] = [];
		stubApi(calls);
		render({
			chapterId: "chapter-1",
			narratorId: "narrator-1",
			title: "Untitled",
			showActions: true,
		});
		await flush();

		click(requireButton("Generate title"));
		await flush();

		expect(calls).toEqual([{ name: "generateNarratorTitle", id: "narrator-1" }]);
	});

	test("offers no generate action without a narrator", async () => {
		stubApi([]);
		render({
			chapterId: "chapter-1",
			narratorId: null,
			title: "No narrator here",
			showActions: true,
		});
		await flush();

		// Editing the chapter title still works; only AI generation needs a session.
		expect(buttonByLabel("Edit title")).not.toBeNull();
		expect(buttonByLabel("Generate title")).toBeNull();
	});
});
