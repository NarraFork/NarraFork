import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import settingsEn from "../../locales/en/settings.json";
import settingsZhCn from "../../locales/zh-CN/settings.json";
import type { AddProviderDraft } from "./provider-add-draft";
import { PROVIDER_PRESETS } from "./provider-presets";

// Install before loading React DOM so its native input-event support is detected.
// Mantine's test environment keeps real controls but removes portals/transitions.
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
const elementPrototype = parseHTML("<html></html>").window.HTMLElement.prototype;
const originalScrollIntoView = Object.getOwnPropertyDescriptor(elementPrototype, "scrollIntoView");
function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	Object.defineProperty(window.document, "oninput", { configurable: true, value: null });
	Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
		configurable: true,
		value() {},
	});
	Object.defineProperty(window.document, "fonts", {
		configurable: true,
		value: { addEventListener() {}, removeEventListener() {} },
	});
	const globals = {
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
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		matchMedia: (query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener() {},
			removeListener() {},
			addEventListener() {},
			removeEventListener() {},
			dispatchEvent: () => false,
		}),
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		getComputedStyle: () => ({ getPropertyValue: () => "", overflow: "visible" }),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		if (!originalGlobals.has(key)) {
			originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		}
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
}
installDom();
const { createRoot } = await import("react-dom/client");
const { MantineProvider } = await import("@mantine/core");
const { I18nextProvider } = await import("react-i18next");
const { AddProviderPage } = await import("./AddProviderPage");
const i18n = createInstance();
await i18n.init({
	lng: "en",
	fallbackLng: "en",
	defaultNS: "settings",
	resources: { en: { settings: settingsEn }, "zh-CN": { settings: settingsZhCn } },
	initImmediate: false,
});

let root: Root | undefined;
let container: HTMLDivElement;
let added: AddProviderDraft[];
let closeCount: number;

beforeEach(async () => {
	installDom();
	await i18n.changeLanguage("en");
	added = [];
	closeCount = 0;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider env="test">
					<AddProviderPage onClose={() => closeCount++} onAdd={(draft) => added.push(draft)} />
				</MantineProvider>
			</I18nextProvider>,
		);
	});
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container.remove();
	root = undefined;
	restoreDom();
});

afterAll(restoreDom);

function restoreDom() {
	if (originalScrollIntoView) {
		Object.defineProperty(elementPrototype, "scrollIntoView", originalScrollIntoView);
	} else {
		Reflect.deleteProperty(elementPrototype, "scrollIntoView");
	}
	for (const [key, descriptor] of originalGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
}

function button(text: string): HTMLButtonElement {
	const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(item) => item.textContent?.trim() === i18n.t(text),
	);
	if (!result) throw new Error(`Missing button: ${text}`);
	return result;
}

function field(label: string): HTMLInputElement {
	const element = [...container.querySelectorAll("label")].find((item) =>
		item.textContent?.startsWith(i18n.t(label)),
	);
	const id = element?.getAttribute("for");
	const input = id ? document.getElementById(id) : null;
	if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input: ${label}`);
	// linkedom does not supply the browser's default input.type = "text".
	if (!input.getAttribute("type")) input.setAttribute("type", "text");
	return input;
}

function preset(name: string): HTMLButtonElement {
	const provider = PROVIDER_PRESETS.find((item) => item.name === name || item.id === name);
	const displayName = provider?.nameKey ? i18n.t(provider.nameKey) : name;
	const result = [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(
		(item) => item.querySelector("p")?.textContent === displayName,
	);
	if (!result) throw new Error(`Missing preset: ${name}`);
	return result;
}

async function click(element: Element) {
	await act(async () => element.dispatchEvent(new Event("click", { bubbles: true })));
}

async function type(label: string, value: string) {
	const input = field(label);
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	if (!setter) throw new Error("Input prototype has no native value setter");
	await act(async () => {
		setter.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function selectProtocol(label: string) {
	await click(field("addProviderProtocol"));
	const option = [...container.querySelectorAll('[role="option"]')].find(
		(item) => item.textContent === i18n.t(label),
	);
	if (!option) throw new Error(`Missing protocol option: ${label}`);
	await click(option);
}

async function submit() {
	// linkedom does not implement the browser's button default form submission.
	await click(button("addProviderContinue"));
	await act(async () => {
		container
			.querySelector("form")
			?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	});
}

describe("AddProviderPage interactions", () => {
	test("renders in the route content without a modal or explanatory paragraphs", async () => {
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		await click(preset("ZhiPu"));
		for (const key of [
			"addProviderIntro",
			"addProviderAttribution",
			"addProviderBaseUrlHint",
			"addProviderApiKeyHint",
			"addProviderPrefixHint",
			"addProviderCompletionsDesc",
		]) {
			expect(container.textContent).not.toContain(i18n.t(key));
		}
		expect(container.textContent).toContain(i18n.t("addProviderDraftNotice"));
	});

	test("uses localized platform names for the catalog, search and initial form name", async () => {
		await act(async () => {
			await i18n.changeLanguage("zh-CN");
		});
		expect(preset("ZhiPu").textContent).toContain("智谱");
		await type("addProviderSearch", "硅基流动");
		expect(container.querySelectorAll("button[aria-pressed]").length).toBe(1);
		await click(preset("silicon"));
		expect(field("addProviderName").value).toBe(settingsZhCn.providerNames.silicon);
		await type("addProviderName", "我的接入");
		await act(async () => {
			await i18n.changeLanguage("en");
		});
		expect(preset("silicon").textContent).toContain(settingsEn.providerNames.silicon);
		expect(field("addProviderName").value).toBe("我的接入");
	});

	test("selects a preset without adding it, and cancellation only closes", async () => {
		await click(preset("ZhiPu"));
		expect(field("addProviderName").value).toBe(settingsEn.providerNames.zhipu);
		expect(field("addProviderBaseUrl").value).toBe("https://open.bigmodel.cn/api/paas/v4");
		expect(added).toEqual([]);
		await type("addProviderApiKey", "discarded-key");
		await click(button("addProviderCancel"));
		expect(closeCount).toBe(1);
		expect(added).toEqual([]);
	});

	test("switching a real Select updates the protocol endpoint", async () => {
		await click(preset("ZhiPu"));
		await selectProtocol("addProviderAnthropicMessages");
		expect(field("addProviderBaseUrl").value).toBe("https://open.bigmodel.cn/api/anthropic/v1");
		await selectProtocol("addProviderCompletions");
		expect(field("addProviderBaseUrl").value).toBe("https://open.bigmodel.cn/api/paas/v4");
		expect(added).toEqual([]);
	});

	test("search filters presets and shows the empty state", async () => {
		await type("addProviderSearch", "ZhiPu");
		expect(container.querySelectorAll("button[aria-pressed]").length).toBe(1);
		expect(preset("ZhiPu")).toBeDefined();
		await type("addProviderSearch", "no-provider-matches-this");
		expect(container.querySelectorAll("button[aria-pressed]").length).toBe(0);
		expect(container.textContent).toContain(i18n.t("addProviderNoResults"));
		await type("addProviderSearch", "");
		expect(container.querySelectorAll("button[aria-pressed]").length).toBeGreaterThan(1);
	});

	test("invalid URLs disable submission and cannot emit a draft", async () => {
		await click(preset("ZhiPu"));
		for (const url of ["", "not-a-url", "ftp://example.com", "https://user:secret@example.com"]) {
			await type("addProviderBaseUrl", url);
			expect(button("addProviderContinue").disabled).toBe(true);
			await submit();
			expect(added).toEqual([]);
		}
		await type("addProviderBaseUrl", "http://localhost:8000/v1");
		expect(button("addProviderContinue").disabled).toBe(false);
	});

	test("editing credentials and adding returns the complete draft exactly once", async () => {
		await click(preset("ZhiPu"));
		await type("addProviderName", "My provider");
		await type("addProviderBaseUrl", "https://proxy.example.test/v1");
		await type("addProviderApiKey", "test-secret-key");
		await type("providerPrefix", "team");
		expect(added).toEqual([]);
		await submit();
		expect(added).toEqual([
			{
				protocol: "completions-compatible",
				name: "My provider",
				baseUrl: "https://proxy.example.test/v1",
				apiKey: "test-secret-key",
				prefix: "team",
			},
		]);
		expect(closeCount).toBe(0);
	});

	test("prefix input strips ASCII colons for custom API and NUG drafts", async () => {
		await click(preset("ZhiPu"));
		await type("providerPrefix", "team:api::");
		expect(field("providerPrefix").value).toBe("teamapi");
		await submit();
		expect(added[0]?.prefix).toBe("teamapi");

		await click(button("addProviderBack"));
		await click(button("addProviderNug"));
		await type("addProviderBaseUrl", "https://gateway.example.test");
		await type("providerPrefix", "nug:team:");
		expect(field("providerPrefix").value).toBe("nugteam");
		await submit();
		expect(added[1]).toMatchObject({ protocol: "nug", prefix: "nugteam" });
	});

	test("returning to the catalog and reselecting a preset clears credentials", async () => {
		await click(preset("ZhiPu"));
		await type("addProviderApiKey", "must-not-leak");
		await type("providerPrefix", "old-prefix");
		await click(button("addProviderBack"));
		expect(container.querySelector("[data-config]")).toBeNull();
		await click(preset("OpenAI"));
		expect(field("addProviderName").value).toBe("OpenAI");
		expect(field("addProviderBaseUrl").value).toBe("https://api.openai.com/v1");
		expect(field("addProviderApiKey").value).toBe("");
		expect(field("providerPrefix").value).toBe("");
		expect(added).toEqual([]);
	});
});
