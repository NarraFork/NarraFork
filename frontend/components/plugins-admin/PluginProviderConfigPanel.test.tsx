import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SECRET_PLACEHOLDER } from "./config-form-state";

/**
 * Panel-level checks for the settings tab.
 *
 * The behaviours worth pinning are the ones that affect what an admin can do to a live
 * provider: a prefix change must warn and must go to the prefix endpoint (not the config
 * one), an invalid prefix must be refused locally, and a stored secret must never reach
 * the DOM as a value.
 */

const listCalls: string[] = [];
const configCalls: Array<{ instanceId: string; config: Record<string, unknown> }> = [];
const prefixCalls: Array<{ instanceId: string; prefix: string }> = [];
let listResponse: unknown = { pluginId: "com.example.demo", providers: [] };

// Capture the real modules BEFORE mocking. `bun test` shares one module registry across
// files, so a mock left installed here would leak into every later test file that imports
// the same module — restoring them in afterAll is what keeps this file self-contained.
const realReactI18nextModule = { ...(await import("react-i18next")) };
const realApiPluginsModule = { ...(await import("../../lib/api/plugins")) };

mock.module("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
mock.module("../../lib/api/plugins", () => ({
	...realApiPluginsModule,
	pluginsApi: {
		...realApiPluginsModule.pluginsApi,
		listProviderConfig: (pluginId: string) => {
			listCalls.push(pluginId);
			return Promise.resolve(listResponse);
		},
		updateProviderConfig: (
			_pluginId: string,
			providerInstanceId: string,
			config: Record<string, unknown>,
		) => {
			configCalls.push({ instanceId: providerInstanceId, config });
			return Promise.resolve({ pluginId: _pluginId, provider: null });
		},
		updateProviderPrefix: (
			_pluginId: string,
			providerInstanceId: string,
			providerPrefix: string,
		) => {
			prefixCalls.push({ instanceId: providerInstanceId, prefix: providerPrefix });
			return Promise.resolve({ pluginId: _pluginId, provider: null });
		},
	},
}));

const { PluginProviderConfigPanel } = await import("./PluginProviderConfigPanel");

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let makeEvent: (type: string, init?: EventInit) => Event;
let setNativeValue: (element: HTMLInputElement | HTMLTextAreaElement, value: string) => void;

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	makeEvent = (type, init) => new (window as unknown as { Event: typeof Event }).Event(type, init);
	const inputProto = window.HTMLInputElement.prototype;
	const areaProto = window.HTMLTextAreaElement.prototype;
	const inputSetter = Object.getOwnPropertyDescriptor(inputProto, "value")?.set;
	const areaSetter = Object.getOwnPropertyDescriptor(areaProto, "value")?.set;
	if (!inputSetter || !areaSetter) throw new Error("value setters unavailable");
	setNativeValue = (element, value) => {
		const setter = element instanceof window.HTMLTextAreaElement ? areaSetter : inputSetter;
		setter.call(element, value);
	};
	const typeDescriptor = Object.getOwnPropertyDescriptor(inputProto, "type");
	if (typeDescriptor?.get) {
		const nativeGet = typeDescriptor.get;
		Object.defineProperty(inputProto, "type", {
			...typeDescriptor,
			get(this: HTMLInputElement) {
				return nativeGet.call(this) ?? "text";
			},
		});
	}
	(window.document as unknown as Record<string, unknown>).oninput = null;
	for (const proto of [inputProto, areaProto]) {
		Object.defineProperties(proto, {
			attachEvent: { value: () => {}, configurable: true },
			detachEvent: { value: () => {}, configurable: true },
		});
	}
	if (!window.document.fonts) {
		Object.defineProperty(window.document, "fonts", {
			configurable: true,
			value: { addEventListener() {}, removeEventListener() {} },
		});
	}
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
		matchMedia,
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		getComputedStyle: window.getComputedStyle?.bind(window) ?? (() => ({})),
		IS_REACT_ACT_ENVIRONMENT: true,
	});
}

beforeEach(() => {
	installDom();
	listCalls.length = 0;
	configCalls.length = 0;
	prefixCalls.length = 0;
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
	mock.module("../../lib/api/plugins", () => realApiPluginsModule);
	mock.restore();
});

function providerView(overrides: Record<string, unknown> = {}) {
	return {
		providerInstanceId: "com.example.demo/p@1.0.0:hash",
		providerTypeId: "com.example.demo/p",
		pluginId: "com.example.demo",
		contributionId: "p",
		providerPrefix: "demo",
		displayName: "Demo Provider",
		configSchema: {
			type: "object",
			properties: {
				apiMode: { type: "string", enum: ["balanced", "fast"] },
				apiKey: { type: "string", format: "password" },
			},
		},
		config: { apiMode: "balanced" },
		secretFields: ["apiKey"],
		secretsSet: [],
		...overrides,
	};
}

async function renderPanel() {
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
					<PluginProviderConfigPanel pluginId="com.example.demo" />
				</MantineProvider>
			</QueryClientProvider>,
		);
	});
	// Let the query settle. React Query resolves through several microtask hops before
	// committing, so a single flush leaves the panel on its loading branch.
	for (let attempt = 0; attempt < 20; attempt += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		if (!(container?.textContent ?? "").includes("admin.detail.config.loading")) break;
	}
}

function inputByLabel(labelText: string): HTMLInputElement | undefined {
	const labels = [...(container?.querySelectorAll("label") ?? [])] as HTMLLabelElement[];
	const label = labels.find((item) => item.textContent?.includes(labelText));
	const id = label?.getAttribute("for");
	if (!id) return undefined;
	return (container?.querySelector(`#${id}`) as HTMLInputElement | null) ?? undefined;
}

function buttonByText(text: string): HTMLButtonElement | undefined {
	const buttons = [...(container?.querySelectorAll("button") ?? [])] as HTMLButtonElement[];
	return buttons.find((button) => button.textContent?.includes(text));
}

async function typeInto(element: HTMLInputElement, value: string) {
	await act(async () => {
		element.dispatchEvent(makeEvent("focusin", { bubbles: true }));
	});
	await act(async () => {
		setNativeValue(element, value);
		element.dispatchEvent(makeEvent("input", { bubbles: true }));
		element.dispatchEvent(makeEvent("keyup", { bubbles: true }));
	});
}

describe("PluginProviderConfigPanel", () => {
	test("renders one card per provider and fetches once", async () => {
		listResponse = { pluginId: "com.example.demo", providers: [providerView()] };
		await renderPanel();

		expect(listCalls).toEqual(["com.example.demo"]);
		expect(container?.textContent ?? "").toContain("Demo Provider");
		expect(container?.textContent ?? "").toContain("demo");
	});

	test("shows the empty state when the plugin has no providers", async () => {
		listResponse = { pluginId: "com.example.demo", providers: [] };
		await renderPanel();
		expect(container?.textContent ?? "").toContain("admin.detail.config.empty");
	});

	test("never renders a stored secret value", async () => {
		listResponse = {
			pluginId: "com.example.demo",
			providers: [
				providerView({
					config: { apiMode: "balanced", apiKey: SECRET_PLACEHOLDER },
					secretsSet: ["apiKey"],
				}),
			],
		};
		await renderPanel();

		const password = [...(container?.querySelectorAll("input") ?? [])].find(
			(input) => (input as HTMLInputElement).type === "password",
		) as HTMLInputElement | undefined;
		expect(password?.value).toBe(SECRET_PLACEHOLDER);
		expect(container?.innerHTML ?? "").not.toContain("sk-");
	});

	test("sends a prefix change to the prefix endpoint, not the config one", async () => {
		listResponse = { pluginId: "com.example.demo", providers: [providerView()] };
		await renderPanel();

		const prefixInput = inputByLabel("prefixLabel");
		expect(prefixInput).toBeDefined();
		if (prefixInput) await typeInto(prefixInput, "renamed");

		const saveButton = buttonByText("prefixSave");
		expect(saveButton?.disabled).toBe(false);
		await act(async () => {
			saveButton?.click();
		});

		expect(prefixCalls).toEqual([
			{ instanceId: "com.example.demo/p@1.0.0:hash", prefix: "renamed" },
		]);
		// Prefix and config are separate endpoints; changing one must not touch the other.
		expect(configCalls).toEqual([]);
	});

	test("warns before a prefix change is applied", async () => {
		listResponse = { pluginId: "com.example.demo", providers: [providerView()] };
		await renderPanel();
		expect(container?.textContent ?? "").not.toContain("admin.detail.config.prefixWarning");

		const prefixInput = inputByLabel("prefixLabel");
		if (prefixInput) await typeInto(prefixInput, "renamed");
		// Saved model references use the old prefix, so the consequence is surfaced first.
		expect(container?.textContent ?? "").toContain("admin.detail.config.prefixWarning");
	});

	test("refuses an invalid prefix locally instead of round-tripping it", async () => {
		listResponse = { pluginId: "com.example.demo", providers: [providerView()] };
		await renderPanel();

		const prefixInput = inputByLabel("prefixLabel");
		if (prefixInput) await typeInto(prefixInput, "bad:prefix");

		expect(container?.textContent ?? "").toContain("admin.detail.config.prefixInvalid");
		expect(buttonByText("prefixSave")?.disabled).toBe(true);
		await act(async () => {
			buttonByText("prefixSave")?.click();
		});
		expect(prefixCalls).toEqual([]);
	});

	test("keeps the prefix save button disabled until the value changes", async () => {
		listResponse = { pluginId: "com.example.demo", providers: [providerView()] };
		await renderPanel();
		expect(buttonByText("prefixSave")?.disabled).toBe(true);
	});

	test("submits config through the config endpoint, not the prefix one", async () => {
		listResponse = {
			pluginId: "com.example.demo",
			providers: [
				providerView({
					// A plain string field is easier to drive than a Combobox and exercises the
					// same submit path.
					configSchema: {
						type: "object",
						properties: {
							label: { type: "string" },
							apiKey: { type: "string", format: "password" },
						},
					},
					config: {},
				}),
			],
		};
		await renderPanel();

		const saveConfig = buttonByText("admin.detail.config.save");
		expect(saveConfig).toBeDefined();
		// Nothing has changed yet, so saving is not offered.
		expect(saveConfig?.disabled).toBe(true);

		const labelInput = inputByLabel("label");
		expect(labelInput).toBeDefined();
		if (labelInput) await typeInto(labelInput, "hello");

		const enabledSave = buttonByText("admin.detail.config.save");
		expect(enabledSave?.disabled).toBe(false);
		await act(async () => {
			enabledSave?.click();
		});

		expect(configCalls).toEqual([
			{ instanceId: "com.example.demo/p@1.0.0:hash", config: { label: "hello" } },
		]);
		// Saving config must not touch the prefix endpoint.
		expect(prefixCalls).toEqual([]);
	});
});
