import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { pluginContributionStore } from "../plugins";

/**
 * The provider detail area has to pick between two very different renderings, and
 * getting the choice wrong is not a cosmetic problem:
 *
 * - a plugin that ships a `provider-settings` view must get its iframe, otherwise the
 *   credential UI it wrote is unreachable;
 * - a plugin that ships none must get the host's generated form, otherwise a provider
 *   that was configurable in phase C becomes unconfigurable.
 *
 * A view scoped to a workspace/narrator/project is excluded from the first path: the
 * settings page has no such scope, so its session could only ever fail to open.
 */

const configCalls: string[] = [];
let configResponse: unknown = { pluginId: "com.example.demo", providers: [] };

// Capture the real modules BEFORE mocking. `bun test` shares one module registry across
// files, so a mock left installed here would leak into every later test file that imports
// the same module — restoring them in afterAll is what keeps this file self-contained.
const realReactI18nextModule = { ...(await import("react-i18next")) };
const realRegistryModule = { ...(await import("../plugins/registry")) };
const realApiPluginsModule = { ...(await import("../../lib/api/plugins")) };

mock.module("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
mock.module("../plugins/registry", () => ({
	...realRegistryModule,
	syncPluginUiContributions: () => Promise.resolve(0),
}));
mock.module("../../lib/api/plugins", () => ({
	...realApiPluginsModule,
	pluginsApi: {
		...realApiPluginsModule.pluginsApi,
		listProviderConfig: (pluginId: string) => {
			configCalls.push(pluginId);
			return Promise.resolve(configResponse);
		},
		updateProviderConfig: () => Promise.resolve({ pluginId: "", provider: null }),
		updateProviderPrefix: () => Promise.resolve({ pluginId: "", provider: null }),
	},
}));

const { PluginProviderSection } = await import("./PluginProviderSection");

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

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
	configCalls.length = 0;
	configResponse = { pluginId: "com.example.demo", providers: [] };
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
	// Put every mocked module back, or later test files inherit these stubs.
	mock.module("react-i18next", () => realReactI18nextModule);
	mock.module("../plugins/registry", () => realRegistryModule);
	mock.module("../../lib/api/plugins", () => realApiPluginsModule);
	mock.restore();
});

function applyView(overrides: Record<string, unknown> = {}) {
	pluginContributionStore.applySnapshot([
		{
			pluginId: "com.example.demo",
			contributionId: "provider-ui",
			version: "1.0.0",
			hash: "a".repeat(64),
			title: "Credentials",
			entryPath: "ui/provider.js",
			scope: "global",
			surfaces: ["provider-settings"],
			status: "available",
			...overrides,
		},
	]);
}

function configView(overrides: Record<string, unknown> = {}) {
	return {
		providerInstanceId: "com.example.demo/demo@1.0.0:hash",
		providerTypeId: "com.example.demo/demo",
		pluginId: "com.example.demo",
		contributionId: "demo",
		providerPrefix: "demo",
		displayName: "Demo Provider",
		configSchema: {
			type: "object",
			properties: { apiMode: { type: "string", enum: ["offline", "verbose"] } },
		},
		config: { apiMode: "offline" },
		secretFields: [],
		secretsSet: [],
		...overrides,
	};
}

async function renderSection(contributionId = "demo") {
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
					<PluginProviderSection pluginId="com.example.demo" contributionId={contributionId} />
				</MantineProvider>
			</QueryClientProvider>,
		);
	});
	// React Query settles across several microtask hops before committing.
	for (let attempt = 0; attempt < 20; attempt += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		if (!text().includes("admin.detail.config.loading")) break;
	}
}

function text(): string {
	return container?.textContent ?? "";
}

describe("PluginProviderSection rendering choice", () => {
	test("renders the plugin's own view when it declares provider-settings", async () => {
		applyView();
		await renderSection();
		// `PluginDockPanelView` is mounted: with no PluginUiRuntimeProvider in this test it
		// renders its runtime placeholder, which is proof the iframe path was taken rather
		// than the generated form.
		expect(text()).toContain("runtimeUnavailable");
		expect(text()).not.toContain("pluginProviderNoCustomUi");
		// The generated form must not even be fetched when the plugin owns the area.
		expect(configCalls).toEqual([]);
	});

	test("shows a switcher only when several provider-settings views exist", async () => {
		pluginContributionStore.applySnapshot([
			{
				pluginId: "com.example.demo",
				contributionId: "creds",
				version: "1.0.0",
				hash: "a".repeat(64),
				title: "Credentials",
				entryPath: "ui/creds.js",
				scope: "global",
				surfaces: ["provider-settings"],
				status: "available",
			},
			{
				pluginId: "com.example.demo",
				contributionId: "quota",
				version: "1.0.0",
				hash: "a".repeat(64),
				title: "Quota",
				entryPath: "ui/quota.js",
				scope: "global",
				surfaces: ["provider-settings"],
				status: "available",
			},
		]);
		await renderSection();
		expect(text()).toContain("Credentials");
		expect(text()).toContain("Quota");
	});

	test("falls back to the generated form when no view is declared", async () => {
		configResponse = { pluginId: "com.example.demo", providers: [configView()] };
		await renderSection();
		// A provider that was configurable in phase C must stay configurable.
		expect(text()).toContain("pluginProviderNoCustomUi");
		expect(configCalls).toEqual(["com.example.demo"]);
	});

	test("ignores a view that only targets other surfaces", async () => {
		applyView({ surfaces: ["workspace", "settings"] });
		configResponse = { pluginId: "com.example.demo", providers: [configView()] };
		await renderSection();
		expect(text()).toContain("pluginProviderNoCustomUi");
	});

	test("ignores a provider-settings view that needs a scope this surface lacks", async () => {
		// `resolvePluginUiInvocationScope` throws without a workspace id, so offering this
		// view would guarantee a failed load.
		applyView({ scope: "workspace" });
		configResponse = { pluginId: "com.example.demo", providers: [configView()] };
		await renderSection();
		expect(text()).toContain("pluginProviderNoCustomUi");
	});

	test("ignores another plugin's provider-settings view", async () => {
		applyView({ pluginId: "com.example.other" });
		configResponse = { pluginId: "com.example.demo", providers: [configView()] };
		await renderSection();
		expect(text()).toContain("pluginProviderNoCustomUi");
	});

	test("reports the empty state when the fallback finds no matching provider", async () => {
		configResponse = {
			pluginId: "com.example.demo",
			providers: [configView({ contributionId: "other" })],
		};
		await renderSection("demo");
		expect(text()).toContain("admin.detail.config.empty");
	});
});
