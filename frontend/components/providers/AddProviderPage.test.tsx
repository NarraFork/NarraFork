import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { ApiError } from "../../lib/api";
import settingsEn from "../../locales/en/settings.json";
import settingsZhCn from "../../locales/zh-CN/settings.json";
import { TokenDanceAddContext } from "./provider-add-context";
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
let addHandler: (draft: AddProviderDraft) => void | Promise<void>;

beforeEach(async () => {
	installDom();
	await i18n.changeLanguage("en");
	added = [];
	closeCount = 0;
	addHandler = (draft) => {
		added.push(draft);
	};
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider env="test">
					<AddProviderPage onClose={() => closeCount++} onAdd={(draft) => addHandler(draft)} />
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
	const result = [
		...container.querySelectorAll<HTMLButtonElement>("button[data-provider-preset]"),
	].find((item) => item.querySelector("p")?.textContent === displayName);
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

async function selectOption(fieldKey: string, label: string) {
	await click(field(fieldKey));
	const option = [...container.querySelectorAll('[role="option"]')].find(
		(item) => item.textContent === i18n.t(label),
	);
	if (!option) throw new Error(`Missing protocol option: ${label}`);
	await click(option);
}

async function selectProtocol(label: string) {
	await selectOption("addProviderProtocol", label);
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
	for (const [error, key] of [
		[new ApiError("secret request body", 404), "loginBackendUnavailable"],
		[new ApiError("secret request body", 400), "loginStartFailed"],
		[new ApiError("secret request body", 401), "loginStartFailed"],
		[new ApiError("secret request body", 502), "loginStartFailed"],
		[
			new ApiError("secret request body", 400, { code: "TOKENDANCE_CALLBACK_INVALID" }),
			"loginCallbackInvalid",
		],
		[
			new ApiError("secret request body", 409, { code: "TOKENDANCE_PREFIX_CONFLICT" }),
			"prefixConflict",
		],
		[new Error("secret request body"), "loginStartClientFailed"],
	] as const) {
		for (const language of ["en", "zh-CN"] as const) {
			test(`TokenDance start failure is actionable and redacted (${language}, ${key}, ${error instanceof ApiError ? error.status : "client"})`, async () => {
				await act(async () => {
					await i18n.changeLanguage(language);
				});
				let calls = 0;
				await act(async () => {
					root?.render(
						<I18nextProvider i18n={i18n}>
							<MantineProvider env="test">
								<TokenDanceAddContext
									value={{
										login: async () => {
											calls++;
											throw error;
										},
									}}
								>
									<AddProviderPage onClose={() => closeCount++} onAdd={addHandler} />
								</TokenDanceAddContext>
							</MantineProvider>
						</I18nextProvider>,
					);
				});
				await click(preset("TokenDance"));
				await click(button("tokendance.login"));
				const alert = container.querySelector('[role="alert"]');
				expect(alert?.textContent).toContain(
					i18n.t(`tokendance.${key}`, {
						status: error instanceof ApiError ? error.status : undefined,
					}),
				);
				expect(alert?.textContent).not.toContain(i18n.t("tokendance.loginFailed"));
				expect(container.textContent).not.toContain("secret request body");
				expect(calls).toBe(1);
				expect(button("tokendance.login").disabled).toBe(false);
				expect(closeCount).toBe(0);
				expect(added).toEqual([]);
				await click(button("tokendance.login"));
				expect(calls).toBe(2);
			});
		}
	}
	test("a save rejection keeps the form and key available for a successful retry", async () => {
		await click(preset("OpenAI"));
		await type("addProviderApiKey", "retained-on-error");
		addHandler = async () => {
			throw new Error("save refused");
		};
		await submit();
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("save refused");
		expect(field("addProviderApiKey").value).toBe("retained-on-error");
		expect(closeCount).toBe(0);
		addHandler = (draft) => {
			added.push(draft);
		};
		await submit();
		expect(added).toHaveLength(1);
		expect(added[0]?.apiKey).toBe("retained-on-error");
	});

	test("pending creation blocks repeated form submission and preserves its captured inputs", async () => {
		await click(preset("OpenAI"));
		await type("addProviderApiKey", "captured-key");
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		addHandler = (draft) => {
			added.push(draft);
			return pending;
		};
		await act(async () => {
			const form = container.querySelector("form");
			form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
			form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		expect(added).toHaveLength(1);
		expect(button("addProviderContinue").disabled).toBe(true);
		await type("addProviderApiKey", "must-not-change-in-flight");
		expect(field("addProviderApiKey").value).toBe("captured-key");
		await act(async () => {
			release();
			await pending;
		});
		expect(button("addProviderContinue").disabled).toBe(false);
	});

	test("popular shows the seven requested providers in order and search spans the full catalog", async () => {
		const ids = () =>
			[...container.querySelectorAll("button[data-provider-preset]")].map((node) =>
				node.getAttribute("data-provider-preset"),
			);
		expect(ids()).toEqual([
			"tokendance",
			"deepseek",
			"zhipu",
			"moonshot",
			"minimax",
			"mimo",
			"openai",
			"anthropic",
		]);
		await click(button("addProviderCategoryAll"));
		expect(ids().length).toBe(PROVIDER_PRESETS.length);
		await click(button("addProviderCategoryPopular"));
		await type("addProviderSearch", "Groq");
		expect(ids()).toEqual(["groq"]);
		await type("addProviderSearch", "");
		expect(ids().length).toBe(8);
	});

	test("Chinese defaults the four configurable platforms to China without overriding manual choices", async () => {
		await act(async () => {
			await i18n.changeLanguage("zh-CN");
		});
		for (const id of ["moonshot", "minimax", "mimo", "zhipu"]) {
			await click(preset(id));
			expect(field("addProviderRegion").value).toBe(i18n.t("addProviderRegionChina"));
			expect(field("addProviderBilling").value).toBe(i18n.t("addProviderBillingPayg"));
		}
		await selectOption("addProviderRegion", "addProviderRegionInternational");
		await act(async () => {
			await i18n.changeLanguage("en");
		});
		expect(field("addProviderRegion").value).toBe(i18n.t("addProviderRegionInternational"));
		await act(async () => {
			await i18n.changeLanguage("zh-CN");
		});
		expect(field("addProviderRegion").value).toBe(i18n.t("addProviderRegionInternational"));
	});

	test("region and plan update the exact URLs for KIMI, MiniMax and Zhipu", async () => {
		for (const [id, internationalPayg, internationalPlan, chinaPayg, chinaPlan] of [
			[
				"moonshot",
				"https://api.moonshot.ai/v1",
				"https://api.kimi.ai/coding/v1",
				"https://api.moonshot.cn/v1",
				"https://api.kimi.com/coding/v1",
			],
			[
				"minimax",
				"https://api.minimax.io/anthropic/v1",
				"https://api.minimax.io/anthropic/v1",
				"https://api.minimax.cn/anthropic/v1",
				"https://api.minimax.cn/anthropic/v1",
			],
			[
				"zhipu",
				"https://api.z.ai/api/anthropic/v1",
				"https://api.z.ai/api/v1",
				"https://open.bigmodel.cn/api/v1",
				"https://open.bigmodel.cn/api/v1",
			],
		] as const) {
			await click(preset(id));
			expect(field("addProviderRegion").value).toBe(i18n.t("addProviderRegionInternational"));
			expect(field("addProviderBaseUrl").value).toBe(internationalPayg);
			await selectOption("addProviderBilling", "addProviderBillingTokenPlan");
			expect(field("addProviderBaseUrl").value).toBe(internationalPlan);
			await selectOption("addProviderRegion", "addProviderRegionChina");
			expect(field("addProviderBaseUrl").value).toBe(chinaPlan);
			await selectOption("addProviderBilling", "addProviderBillingPayg");
			expect(field("addProviderBaseUrl").value).toBe(chinaPayg);
		}
	});

	test("switching plans retains keys, name and prefix even with identical URLs", async () => {
		await click(preset("minimax"));
		await type("addProviderName", "My MiniMax");
		await type("providerPrefix", "my-minimax");
		await type("addProviderApiKey", "payg-account-key");
		const paygUrl = field("addProviderBaseUrl").value;
		await selectOption("addProviderBilling", "addProviderBillingTokenPlan");
		expect(field("addProviderApiKey").value).toBe("payg-account-key");
		expect(field("addProviderBaseUrl").value).toBe(paygUrl);
		expect(field("addProviderName").value).toBe("My MiniMax");
		expect(field("providerPrefix").value).toBe("my-minimax");
		await type("addProviderApiKey", "subscription-account-key");
		await selectOption("addProviderBilling", "addProviderBillingTokenPlan");
		expect(field("addProviderApiKey").value).toBe("subscription-account-key");
		await submit();
		expect(added[0]).toMatchObject({
			apiKey: "subscription-account-key",
			userAgentMode: "narrafork",
			name: "My MiniMax",
			prefix: "my-minimax",
		});
		await selectOption("addProviderBilling", "addProviderBillingPayg");
		expect(field("addProviderApiKey").value).toBe("subscription-account-key");
		await submit();
		expect(added[1]?.userAgentMode).toBeUndefined();
	});

	test("MiMo international Token Plan requires its assigned cluster while retaining the entered key", async () => {
		await click(preset("mimo"));
		expect(field("addProviderBaseUrl").value).toBe("https://api.xiaomimimo.com/v1");
		await type("addProviderApiKey", "sk-payg-account");
		await selectOption("addProviderBilling", "addProviderBillingTokenPlan");
		expect(field("addProviderApiKey").value).toBe("sk-payg-account");
		expect(field("addProviderBaseUrl").value).toBe("");
		expect(button("addProviderContinue").disabled).toBe(true);
		await type("addProviderBaseUrl", "https://manual.example.test/v1");
		await submit();
		expect(added).toEqual([]);
		await selectOption("addProviderCluster", "addProviderClusterSgp");
		expect(field("addProviderBaseUrl").value).toBe(
			"https://token-plan-sgp.xiaomimimo.com/anthropic/v1",
		);
		expect(field("addProviderProtocol").value).toBe(i18n.t("addProviderAnthropicMessages"));
		await type("addProviderApiKey", "tp-sgp-account");
		await selectOption("addProviderCluster", "addProviderClusterAms");
		expect(field("addProviderApiKey").value).toBe("tp-sgp-account");
		expect(field("addProviderBaseUrl").value).toBe(
			"https://token-plan-ams.xiaomimimo.com/anthropic/v1",
		);
		await selectOption("addProviderRegion", "addProviderRegionChina");
		expect(field("addProviderBaseUrl").value).toBe("https://token-plan-cn.xiaomimimo.com/v1");
		expect(field("addProviderProtocol").value).toBe(i18n.t("addProviderOpenAIResponses"));
		await selectOption("addProviderRegion", "addProviderRegionInternational");
		expect(field("addProviderCluster").value).toBe("");
		expect(button("addProviderContinue").disabled).toBe(true);
	});

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
		expect(container.textContent).not.toContain(i18n.t("addProviderDraftNotice"));
	});

	test("uses localized platform names for the catalog, search and initial form name", async () => {
		await act(async () => {
			await i18n.changeLanguage("zh-CN");
		});
		expect(preset("ZhiPu").textContent).toContain("智谱");
		await type("addProviderSearch", "硅基流动");
		expect(container.querySelectorAll("button[data-provider-preset]").length).toBe(1);
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
		expect(field("addProviderProtocol").value).toBe(i18n.t("addProviderAnthropicMessages"));
		expect(field("addProviderBaseUrl").value).toBe("https://api.z.ai/api/anthropic/v1");
		expect(added).toEqual([]);
		await type("addProviderApiKey", "discarded-key");
		await click(button("addProviderCancel"));
		expect(closeCount).toBe(1);
		expect(added).toEqual([]);
	});

	test("preset selection prioritizes Responses, Messages and then Completions", async () => {
		await click(button("addProviderCategoryAll"));
		for (const [name, label] of [
			["deepseek", "addProviderOpenAIResponses"],
			["zhipu", "addProviderAnthropicMessages"],
			["groq", "addProviderCompletions"],
			["gemini", "addProviderGemini"],
		] as const) {
			await click(preset(name));
			expect(field("addProviderProtocol").value).toBe(i18n.t(label));
		}
	});

	test("switching a real Select updates the protocol endpoint", async () => {
		await click(preset("ZhiPu"));
		await selectProtocol("addProviderCompletions");
		expect(field("addProviderBaseUrl").value).toBe("https://api.z.ai/api/paas/v4");
		await selectProtocol("addProviderAnthropicMessages");
		expect(field("addProviderBaseUrl").value).toBe("https://api.z.ai/api/anthropic/v1");
		await selectProtocol("addProviderCompletions");
		expect(field("addProviderBaseUrl").value).toBe("https://api.z.ai/api/paas/v4");
		expect(added).toEqual([]);
	});

	test("search filters presets and shows the empty state", async () => {
		await type("addProviderSearch", "ZhiPu");
		expect(container.querySelectorAll("button[data-provider-preset]").length).toBe(1);
		expect(preset("ZhiPu")).toBeDefined();
		await type("addProviderSearch", "no-provider-matches-this");
		expect(container.querySelectorAll("button[data-provider-preset]").length).toBe(0);
		expect(container.textContent).toContain(i18n.t("addProviderNoResults"));
		await type("addProviderSearch", "");
		expect(container.querySelectorAll("button[data-provider-preset]").length).toBeGreaterThan(1);
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
				protocol: "anthropic-messages",
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

	test("returning to the catalog and reselecting a preset retains the entered credentials", async () => {
		await click(preset("ZhiPu"));
		await type("addProviderApiKey", "entered-key");
		await type("providerPrefix", "old-prefix");
		await click(button("addProviderBack"));
		expect(container.querySelector("[data-config]")).toBeNull();
		await click(preset("OpenAI"));
		expect(field("addProviderName").value).toBe("OpenAI");
		expect(field("addProviderBaseUrl").value).toBe("https://api.openai.com/v1");
		expect(field("addProviderApiKey").value).toBe("entered-key");
		expect(field("providerPrefix").value).toBe("");
		expect(added).toEqual([]);
	});
});
