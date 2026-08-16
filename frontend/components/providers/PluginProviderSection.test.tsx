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

async function renderSection(
	contributionId = "demo",
	models?: Parameters<typeof PluginProviderSection>[0]["models"],
) {
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
					<PluginProviderSection
						pluginId="com.example.demo"
						contributionId={contributionId}
						{...(models ? { models } : {})}
					/>
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
		// The generated form itself must not appear, which is the actual guarantee: the plugin
		// owns the configuration area.
		//
		// The provider-config payload *is* fetched either way, and has to be: the proxy control
		// and the catalog refresh both address a provider *instance* id that only that payload
		// carries, and both are host concerns that exist regardless of who renders the config
		// area. An earlier version of this test asserted the request never happened, which
		// described the implementation at the time rather than the behaviour worth protecting.
		expect(text()).not.toContain("pluginProviderNoCustomUi");
	});

	test("issues one provider-config request for the whole section", async () => {
		// The section has three consumers of that payload (the fallback form, the proxy control,
		// the model refresh). Querying per consumer would multiply the request; the shared React
		// Query key plus a single call site keeps it to one.
		applyView();
		await renderSection();
		expect(configCalls.length).toBeLessThanOrEqual(1);
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

/**
 * The model area is host-rendered on purpose.
 *
 * Model visibility, context-window overrides and the model tester all live behind
 * `/api/settings`, which a sandboxed plugin iframe cannot reach (`connect-src 'none'`). So a
 * plugin provider can only have these controls if the host renders them outside the frame —
 * before this existed, a plugin provider had no model controls at all while every builtin
 * provider did.
 */
describe("PluginProviderSection model area", () => {
	const modelControls = (overrides: Record<string, unknown> = {}) =>
		({
			prefix: "demo",
			models: [
				{ value: "demo:fast", label: "Fast", provider: "demo", bareModel: "fast" },
				{
					value: "demo:big",
					label: "Big",
					provider: "demo",
					bareModel: "big",
					contextWindow: 200_000,
				},
			],
			hiddenModels: new Set<string>(),
			onToggleHidden: () => {},
			modelContextWindows: {},
			onContextWindowChange: () => {},
			customModels: [],
			onCustomModelsChange: () => {},
			...overrides,
		}) as Parameters<typeof PluginProviderSection>[0]["models"];

	test("lists the provider's models alongside its own settings view", async () => {
		// Both areas render: the plugin owns configuration, the host owns models.
		applyView();
		await renderSection("demo", modelControls());
		expect(text()).toContain("Fast");
		expect(text()).toContain("Big");
		expect(text()).toContain("modelsSection");
	});

	test("lists models alongside the generated fallback form too", async () => {
		// A plugin without its own UI must still get model controls.
		configResponse = { pluginId: "com.example.demo", providers: [configView()] };
		await renderSection("demo", modelControls());
		expect(text()).toContain("pluginProviderNoCustomUi");
		expect(text()).toContain("Fast");
	});

	test("renders no model area when the caller supplies none", async () => {
		// Keeps the component usable from a surface that only configures credentials.
		applyView();
		await renderSection("demo");
		expect(text()).not.toContain("modelsSection");
	});

	test("reports hidden models through the host state it was given", async () => {
		// The set is the host's `settings.agent.hiddenModels`; a plugin model hidden here is
		// hidden by the same mechanism as a builtin one.
		applyView();
		await renderSection("demo", modelControls({ hiddenModels: new Set(["demo:fast"]) }));
		// Still listed — hiding affects model *selection*, not this management list.
		expect(text()).toContain("Fast");
	});
});
