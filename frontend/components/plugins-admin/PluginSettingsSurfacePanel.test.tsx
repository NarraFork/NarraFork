import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { pluginContributionStore } from "../plugins";

/**
 * Which views the settings tab is willing to mount is the whole point of this panel, and
 * two of the rules are easy to get wrong in a way that only shows up as a permanently
 * broken iframe:
 *
 * - a view that does not declare `settings` must not appear here at all;
 * - a view scoped to a workspace/narrator/project cannot open a session on this surface
 *   (`resolvePluginUiInvocationScope` throws on the missing scope id), so offering it
 *   would guarantee a failed load.
 *
 * A disabled view is deliberately still listed: the panel view renders a placeholder
 * explaining why, which beats claiming the plugin has no settings views.
 */

const syncCalls: number[] = [];

const realReactI18nextModule = { ...(await import("react-i18next")) };
mock.module("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
mock.module("../plugins/registry", () => ({
	syncPluginUiContributions: () => {
		syncCalls.push(Date.now());
		return Promise.resolve(0);
	},
	resolvePluginUiContribution: () => undefined,
	invalidatePluginUiContributions: () => {},
	applyPluginUiContributionItems: () => {},
}));

const { PluginSettingsSurfacePanel } = await import("./PluginSettingsSurfacePanel");

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

/** Mantine's SegmentedControl observes DOM mutations; linkedom provides no implementation. */
class TestMutationObserver {
	observe() {}
	disconnect() {}
	takeRecords(): unknown[] {
		return [];
	}
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

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
	if (!window.document.fonts) {
		Object.defineProperty(window.document, "fonts", {
			configurable: true,
			value: { addEventListener() {}, removeEventListener() {} },
		});
	}
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		Document: window.Document,
		ShadowRoot: window.ShadowRoot ?? class ShadowRoot {},
		HTMLElement: window.HTMLElement,
		HTMLButtonElement: window.HTMLButtonElement,
		HTMLInputElement: window.HTMLInputElement,
		HTMLTextAreaElement: window.HTMLTextAreaElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		ResizeObserver: TestResizeObserver,
		MutationObserver: TestMutationObserver,
		matchMedia,
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		getComputedStyle: window.getComputedStyle?.bind(window) ?? (() => ({})),
		IS_REACT_ACT_ENVIRONMENT: true,
	});
}

beforeEach(() => {
	installDom();
	syncCalls.length = 0;
	pluginContributionStore.clear();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
});

afterAll(() => {
	mock.module("react-i18next", () => realReactI18nextModule);
	mock.restore();
});

type ViewOverrides = {
	contributionId?: string;
	surfaces?: Array<"workspace" | "director" | "focus" | "settings">;
	scope?: "workspace" | "narrator" | "project" | "global";
	status?: "available" | "disabled";
	title?: string;
};

function applyViews(views: ViewOverrides[], pluginId = "com.example.demo") {
	pluginContributionStore.applySnapshot(
		views.map((item) => ({
			pluginId,
			contributionId: item.contributionId ?? "panel",
			version: "1.0.0",
			hash: "a".repeat(64),
			title: item.title ?? "Panel",
			entryPath: "ui/panel.js",
			scope: item.scope ?? "global",
			surfaces: item.surfaces ?? ["settings"],
			status: item.status ?? "available",
		})),
	);
}

async function renderPanel(pluginId = "com.example.demo") {
	// PluginDockPanelView resolves owner narrator/chapter through React Query hooks, so a
	// client must be in scope even though this surface never has an owner narrator.
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
			mutations: { retry: false },
		},
	});
	await act(async () => {
		root?.render(
			<QueryClientProvider client={queryClient}>
				<MantineProvider>
					<PluginSettingsSurfacePanel pluginId={pluginId} />
				</MantineProvider>
			</QueryClientProvider>,
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function text(): string {
	return container?.textContent ?? "";
}

describe("PluginSettingsSurfacePanel view selection", () => {
	test("lists a settings-capable global view", async () => {
		applyViews([{ title: "Credentials", surfaces: ["workspace", "settings"] }]);
		await renderPanel();
		expect(text()).toContain("Credentials");
		expect(text()).not.toContain("admin.detail.surface.empty");
	});

	test("hides a view that does not declare the settings surface", async () => {
		applyViews([{ title: "Workspace only", surfaces: ["workspace"] }]);
		await renderPanel();
		expect(text()).toContain("admin.detail.surface.empty");
		expect(text()).not.toContain("Workspace only");
	});

	test("hides a settings view that needs a scope this surface cannot supply", async () => {
		// The settings page has no workspace id, so a session for this view could only fail.
		applyViews([{ title: "Needs workspace", surfaces: ["settings"], scope: "workspace" }]);
		await renderPanel();
		expect(text()).toContain("admin.detail.surface.empty");
		expect(text()).not.toContain("Needs workspace");
	});

	test("keeps a disabled settings view so the reason can be shown", async () => {
		applyViews([{ title: "Disabled view", surfaces: ["settings"], status: "disabled" }]);
		await renderPanel();
		expect(text()).not.toContain("admin.detail.surface.empty");
	});

	test("ignores views belonging to another plugin", async () => {
		applyViews([{ title: "Other plugin view" }], "com.example.other");
		await renderPanel("com.example.demo");
		expect(text()).toContain("admin.detail.surface.empty");
	});

	test("offers a switcher only when more than one settings view exists", async () => {
		applyViews([{ contributionId: "a", title: "First" }]);
		await renderPanel();
		const single = container?.querySelectorAll("input[type=radio]").length ?? 0;
		expect(single).toBe(0);

		applyViews([
			{ contributionId: "a", title: "First" },
			{ contributionId: "b", title: "Second" },
		]);
		await renderPanel();
		expect(text()).toContain("First");
		expect(text()).toContain("Second");
	});

	test("requests a contribution sync when the store has never synced", async () => {
		// A direct visit to the plugin detail page can land before the app-level sync runs.
		await renderPanel();
		expect(syncCalls.length).toBeGreaterThan(0);
	});

	test("does not re-sync once a snapshot has been applied", async () => {
		applyViews([{ title: "Credentials" }]);
		syncCalls.length = 0;
		await renderPanel();
		expect(syncCalls).toEqual([]);
	});
});
