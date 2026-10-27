import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { TokenDanceDraftSnapshot } from "@shared/tokendance";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Link,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act, type ComponentProps } from "react";
import type { Root } from "react-dom/client";
import commonLocale from "../../locales/en/common.json";
import settingsLocale from "../../locales/en/settings.json";
import { createSnapshot, providersStateFromSettings } from "./providers-reducer";
import { TOKENDANCE_FLOW_MARKER, tokenDanceDraftSnapshot } from "./tokendance-flow";

// Real parent reducer, file-route components, overview Link, and add form. Only
// authentication/API I/O and the unrelated provider-detail editors are substituted.
// Application/settings shells are minimal fixtures, not the production auth layout.
const undoDom: Array<() => void> = [];
const animationFrames = new Set<ReturnType<typeof setTimeout>>();
const windowTimeouts = new Set<ReturnType<typeof setTimeout>>();
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	function patch(object: object, key: string, value: unknown) {
		const old = Object.getOwnPropertyDescriptor(object, key);
		Object.defineProperty(object, key, { configurable: true, writable: true, value });
		undoDom.push(() =>
			old ? Object.defineProperty(object, key, old) : Reflect.deleteProperty(object, key),
		);
	}
	// Mantine transitions also use window timers after their animation frames.
	// Own both so an unmount/remount cannot leave callbacks using removed globals.
	patch(window, "setTimeout", ((
		callback: (...args: unknown[]) => void,
		delay?: number,
		...args: unknown[]
	) => {
		const id = nativeSetTimeout(() => {
			windowTimeouts.delete(id);
			callback(...args);
		}, delay);
		windowTimeouts.add(id);
		return id;
	}) as typeof setTimeout);
	patch(window, "clearTimeout", ((id: ReturnType<typeof setTimeout>) => {
		windowTimeouts.delete(id);
		nativeClearTimeout(id);
	}) as typeof clearTimeout);
	patch(window.document, "oninput", null);
	patch(window.document, "fonts", { addEventListener() {}, removeEventListener() {} });
	patch(window.HTMLElement.prototype, "scrollIntoView", () => {});
	// linkedom has no layout; Mantine's detail ScrollArea needs finite dimensions.
	for (const key of [
		"offsetHeight",
		"offsetWidth",
		"clientHeight",
		"clientWidth",
		"scrollHeight",
		"scrollWidth",
	]) {
		patch(window.HTMLElement.prototype, key, 0);
	}
	const storage = new Map<string, string>();
	const values = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		Document: window.Document,
		ShadowRoot: window.ShadowRoot ?? class {},
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
		HTMLButtonElement: window.HTMLButtonElement,
		HTMLTextAreaElement: window.HTMLTextAreaElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		location: new URL("https://example.test/settings/providers"),
		sessionStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		},
		localStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		},
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		matchMedia: (media: string) => ({
			matches: false,
			media,
			onchange: null,
			addListener() {},
			removeListener() {},
			addEventListener() {},
			removeEventListener() {},
			dispatchEvent: () => false,
		}),
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			const id = setTimeout(() => {
				animationFrames.delete(id);
				callback(performance.now());
			}, 0);
			animationFrames.add(id);
			return id;
		},
		cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => {
			clearTimeout(id);
			animationFrames.delete(id);
		},
		getComputedStyle: () => ({ getPropertyValue: () => "", overflow: "visible" }),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(values)) patch(globalThis, key, value);
}
function restoreDom() {
	// A transition can schedule its second frame after a flushSync unmount.
	// Drain every fixture-owned frame before removing the browser globals.
	for (const id of animationFrames) clearTimeout(id);
	animationFrames.clear();
	for (const id of windowTimeouts) nativeClearTimeout(id);
	windowTimeouts.clear();
	for (const undo of undoDom.splice(0).reverse()) undo();
}
installDom();
const { createRoot } = await import("react-dom/client");
const { MantineProvider } = await import("@mantine/core");
const { I18nextProvider } = await import("react-i18next");
const { notifications } = await import("@mantine/notifications");
const { ConfirmDialogContext } = await import("../common/confirm-dialog-context");
const auth = await import("../../hooks/useAuth");
const models = await import("../../hooks/useModels");
const customSection = await import("./CustomApiProviderSection");
const nugSection = await import("./NUGProvidersSection");
const { api, ApiError } = await import("../../lib/api");
const { Route: parentFileRoute } = await import("../../routes/settings/providers");
const { Route: addFileRoute } = await import("../../routes/settings/providers.add");
const { Route: callbackFileRoute } = await import(
	"../../routes/settings/providers.tokendance.callback"
);
const tokenDanceFlow = await import("./tokendance-flow");
restoreDom();

const initialSettings = {
	customApiProviders: [
		{
			id: "existing",
			name: "Existing provider",
			prefix: "existing",
			protocol: "completions-compatible",
			baseUrl: "https://existing.example/v1",
			apiKey: "",
			defaultModel: "",
		},
	],
	nugProviders: [],
	agent: { disabledProviders: [], hiddenModels: [] },
};
const i18n = createInstance();
await i18n.init({
	lng: "en",
	fallbackLng: "en",
	resources: { en: { settings: settingsLocale, common: commonLocale } },
	initImmediate: false,
});
const text = (key: string) => i18n.t(key, { ns: "settings" });
let root: Root | undefined;
let container: HTMLDivElement;
let queryClient: QueryClient;
let router: ReturnType<typeof makeRouter>;
let customDetail: ComponentProps<typeof customSection.CustomApiProviderSection> | undefined;
let nugDetail: ComponentProps<typeof nugSection.NUGProvidersSection> | undefined;
let saveCalls = 0;
let confirmAnswer = false;
let serverSettings: Record<string, unknown>;
let savedPayloads: Record<string, unknown>[];
let refreshCalls: Array<{ method: string; id: string }>;
let requestOptions: unknown[];
let warnings: Array<{ color?: string; title?: unknown }>;
let saveError: Error | undefined;
let refreshError: Error | undefined;
let saveGate: Promise<void> | undefined;
let settingsGate: Promise<void> | undefined;
let persistBeforeError = false;
const freshModels = [{ id: "fresh-model", name: "Fresh model" }];
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const restorers: Array<() => void> = [];
const protocols = [
	["completions-compatible", "addProviderCompletions", "openaiRefreshProviderModels"],
	["openai-responses", "addProviderOpenAIResponses", "openaiRefreshProviderModels"],
	["anthropic-messages", "addProviderAnthropicMessages", "anthropicRefreshProviderModels"],
	["gemini-compatible", "addProviderGemini", "geminiRefreshProviderModels"],
	["nug", "addProviderNug", "nugRefreshProviderModels"],
] as const;

function makeRouter(href: string) {
	const app = createRootRoute({
		component: () => (
			<main data-app-shell>
				<nav aria-label="Application navigation">NarraFork</nav>
				<Outlet />
			</main>
		),
	});
	const settings = createRoute({
		getParentRoute: () => app,
		path: "settings",
		component: () => (
			<section data-settings-shell>
				<nav aria-label="Settings navigation">
					<Link to="/settings/providers">Providers</Link>
				</nav>
				<Outlet />
			</section>
		),
	});
	const providers = createRoute({
		getParentRoute: () => settings,
		path: "providers",
		component: parentFileRoute.options.component,
	});
	const add = createRoute({
		getParentRoute: () => providers,
		path: "add",
		component: addFileRoute.options.component,
	});
	const callback = createRoute({
		getParentRoute: () => providers,
		path: "tokendance/callback",
		component: callbackFileRoute.options.component,
	});
	return createRouter({
		routeTree: app.addChildren([settings.addChildren([providers.addChildren([add, callback])])]),
		history: createMemoryHistory({ initialEntries: [href] }),
		defaultPendingMinMs: 0,
	});
}

beforeEach(() => {
	installDom();
	saveCalls = 0;
	confirmAnswer = false;
	serverSettings = clone(initialSettings);
	savedPayloads = [];
	refreshCalls = [];
	requestOptions = [];
	warnings = [];
	saveError = undefined;
	refreshError = undefined;
	saveGate = undefined;
	settingsGate = undefined;
	persistBeforeError = false;
	// Fail closed: every network operation used by the real fixture must be mocked.
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
		throw new Error("Unexpected real network request");
	}) as unknown as typeof fetch);
	const notifySpy = spyOn(notifications, "show").mockImplementation((notification) => {
		warnings.push(notification);
		return "test-notification";
	});
	restorers.push(
		() => fetchSpy.mockRestore(),
		() => notifySpy.mockRestore(),
	);
	customDetail = undefined;
	nugDetail = undefined;
	const authSpy = spyOn(auth, "useCurrentUser").mockReturnValue({
		data: { role: "admin", id: "admin-test" },
	} as ReturnType<typeof auth.useCurrentUser>);
	const modelsSpy = spyOn(models, "useAllModels").mockReturnValue({
		providerLabels: { existing: "Existing provider", draft: "New draft" },
		codexModels: [],
		commandcodeModels: [],
		openaiByProvider: [],
		anthropicByProvider: [],
		geminiByProvider: [],
		nugByProvider: [],
		pluginProviderGroups: [],
	} as unknown as ReturnType<typeof models.useAllModels>);
	const getSpy = spyOn(api, "getSettings").mockImplementation(async (options) => {
		requestOptions.push(options);
		if (settingsGate) await settingsGate;
		return clone(serverSettings);
	});
	const saveSpy = spyOn(api, "updateSettings").mockImplementation(async (payload, options) => {
		saveCalls++;
		savedPayloads.push(clone(payload));
		requestOptions.push(options);
		if (saveGate) await saveGate;
		if (!saveError || persistBeforeError) serverSettings = { ...serverSettings, ...clone(payload) };
		if (saveError) throw saveError;
		return clone(serverSettings);
	});
	for (const method of new Set(protocols.map((entry) => entry[2]))) {
		const refreshSpy = spyOn(api, method).mockImplementation(async (id, options) => {
			refreshCalls.push({ method, id });
			requestOptions.push(options);
			if (refreshError) throw refreshError;
			const field = method === "nugRefreshProviderModels" ? "nugProviders" : "customApiProviders";
			serverSettings[field] = (serverSettings[field] as Array<Record<string, unknown>>).map(
				(provider) => (provider.id === id ? { ...provider, groupModels: freshModels } : provider),
			);
			return { models: freshModels, fromCache: false };
		});
		restorers.push(() => refreshSpy.mockRestore());
	}
	// Bun replaces the memo component with a callable spy; the fixture itself does
	// not need React.memo's static $$typeof property.
	const customSpy = spyOn(customSection, "CustomApiProviderSection").mockImplementation(((
		props: ComponentProps<typeof customSection.CustomApiProviderSection>,
	) => {
		customDetail = props;
		return <output data-custom-detail>{props.provider.name}</output>;
	}) as unknown as typeof customSection.CustomApiProviderSection);
	const nugSpy = spyOn(nugSection, "NUGProvidersSection").mockImplementation(((
		props: ComponentProps<typeof nugSection.NUGProvidersSection>,
	) => {
		nugDetail = props;
		return <output data-nug-detail>{props.providers[0]?.name}</output>;
	}) as unknown as typeof nugSection.NUGProvidersSection);
	for (const spy of [authSpy, modelsSpy, getSpy, saveSpy, customSpy, nugSpy])
		restorers.push(() => spy.mockRestore());
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	queryClient.setQueryData(["admin", "settings"], initialSettings);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	queryClient.clear();
	container.remove();
	for (const restore of restorers.splice(0).reverse()) restore();
	restoreDom();
});
afterAll(restoreDom);

async function mount(href = "/settings/providers") {
	router = makeRouter(href);
	await act(async () => {
		await router.load();
		root?.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider env="test">
					<QueryClientProvider client={queryClient}>
						<ConfirmDialogContext value={{ confirm: async () => confirmAnswer }}>
							<RouterProvider router={router} />
						</ConfirmDialogContext>
					</QueryClientProvider>
				</MantineProvider>
			</I18nextProvider>,
		);
	});
}
function button(key: string) {
	const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(node) => node.textContent?.trim() === text(key),
	);
	if (!found) throw new Error(`Missing button: ${key}`);
	return found;
}
async function click(element: Element) {
	await act(async () => {
		const event = new Event("click", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "button", { value: 0 });
		element.dispatchEvent(event);
	});
}
async function openAdd() {
	const link = container.querySelector('a[href="/settings/providers/add"]');
	if (!link) throw new Error("Missing real overview add link");
	expect(link.textContent?.trim()).toBe(text("addProvider"));
	await click(link);
	expect(router.state.location.pathname).toBe("/settings/providers/add");
}
async function type(key: string, value: string) {
	const label = [...container.querySelectorAll("label")].find((node) =>
		node.textContent?.startsWith(text(key)),
	);
	const input = document.getElementById(label?.getAttribute("for") ?? "");
	if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input: ${key}`);
	if (!input.getAttribute("type")) input.setAttribute("type", "text");
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	if (!setter) throw new Error("Missing native value setter");
	await act(async () => {
		setter.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function dispatchSubmit(times = 1) {
	const form = container.querySelector("form");
	if (!form) throw new Error("Missing add form");
	await act(async () => {
		for (let index = 0; index < times; index++)
			form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	});
}
async function submit() {
	expect(button("addProviderContinue").disabled).toBe(false);
	await dispatchSubmit();
	expect(router.state.location.pathname).toBe("/settings/providers");
}
async function fillDraft(key = "addProviderCompletions") {
	await click(button(key));
	await type("addProviderName", "New draft");
	await type("addProviderBaseUrl", "https://draft.example/v1");
	await type("addProviderApiKey", "draft-secret");
	await type("providerPrefix", "draft");
}
function persistedProviders(field = "customApiProviders") {
	return serverSettings[field] as Array<Record<string, unknown>>;
}
async function leaveDetail() {
	const back = container.querySelector<HTMLButtonElement>("button.mantine-ActionIcon-root");
	if (!back) throw new Error("Missing provider configuration back button");
	await click(back);
}
function expectOriginalDisabled() {
	const card = [...container.querySelectorAll('[role="button"]')].find((node) =>
		node.textContent?.includes("Existing provider"),
	);
	expect(card).toBeDefined();
	expect(card?.querySelector("input")?.getAttribute("aria-label")).toBe(text("overviewEnable"));
}
async function dirtyOriginal() {
	const card = [...container.querySelectorAll('[role="button"]')].find((node) =>
		node.textContent?.includes("Existing provider"),
	);
	const toggle = card?.querySelector<HTMLInputElement>("input");
	if (!toggle) throw new Error("Missing existing provider toggle");
	await click(toggle);
	expectOriginalDisabled();
}
function expectNoSave() {
	expect(saveCalls).toBe(0);
	expect(queryClient.getQueryData<typeof initialSettings>(["admin", "settings"])).toEqual(
		initialSettings,
	);
}

/** Read through a call so TS does not narrow the mock slot after a reset. */
const currentCustomDetail = () => customDetail;
const resetCustomDetail = () => {
	customDetail = undefined;
};

describe("provider deep link", () => {
	test("`?provider=` opens the provider and follows URL changes while mounted", async () => {
		await mount("/settings/providers?provider=existing");
		expect(currentCustomDetail()?.provider.id).toBe("existing");
		expect(container.querySelector("button.mantine-ActionIcon-root")).not.toBeNull();

		// Leaving the detail returns to the overview and clears the link.
		await leaveDetail();
		expect(router.state.location.search).toEqual({});
		resetCustomDetail();

		// A link arriving while the page is already mounted (the model picker's
		// provider settings button) must still open the provider.
		await act(async () => {
			await router.navigate({ to: "/settings/providers", search: { provider: "existing" } });
		});
		expect(currentCustomDetail()?.provider.id).toBe("existing");

		// Browser back closes it again.
		resetCustomDetail();
		await act(async () => {
			router.history.back();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(router.state.location.search).toEqual({});
		expect(container.querySelector("button.mantine-ActionIcon-root")).toBeNull();
	});
});

describe("provider deep link resolution", () => {
	test("a prefix opens the configured provider, case-insensitively", async () => {
		await mount("/settings/providers?provider=EXISTING");
		expect(currentCustomDetail()?.provider.id).toBe("existing");
	});

	test("a prefix link still opens the provider when its group loads before the provider list", async () => {
		// The overview groups come from the models query, the provider list from the
		// settings query; a group can exist before its provider id is known. A one-shot
		// resolution in that window used to settle on the bare prefix: an empty detail.
		// As in real settings, the provider id differs from its model prefix.
		serverSettings = {
			...clone(initialSettings),
			customApiProviders: [
				{ ...initialSettings.customApiProviders[0], id: "xiaomi-id", prefix: "xiaomi" },
			],
		};
		queryClient.removeQueries({ queryKey: ["admin", "settings"] });
		const ready = Promise.withResolvers<void>();
		spyOn(api, "getSettings").mockImplementation(async () => {
			await ready.promise;
			return clone(serverSettings);
		});
		spyOn(models, "useAllModels").mockReturnValue({
			providerLabels: { xiaomi: "Xiaomi" },
			codexModels: [],
			commandcodeModels: [],
			openaiByProvider: [
				{
					prefix: "xiaomi",
					name: "Xiaomi",
					models: [{ value: "xiaomi:mimo", label: "mimo", provider: "xiaomi" }],
				},
			],
			anthropicByProvider: [],
			geminiByProvider: [],
			nugByProvider: [],
			pluginProviderGroups: [],
		} as unknown as ReturnType<typeof models.useAllModels>);
		await mount("/settings/providers?provider=xiaomi");
		expect(currentCustomDetail()).toBeUndefined();
		await act(async () => {
			ready.resolve();
		});
		for (let i = 0; i < 20 && !currentCustomDetail(); i++) {
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
			});
		}
		expect(currentCustomDetail()?.provider.id).toBe("xiaomi-id");
	});

	test("a prefix with no configured provider shows the overview, not an empty detail", async () => {
		// A custom model under a prefix no provider owns still forms an overview group; a
		// bare prefix with no provider behind it must never become the open detail.
		serverSettings = {
			...clone(initialSettings),
			agent: {
				...initialSettings.agent,
				customModels: [{ value: "xiaomi:mimo-v2.6-pro", label: "MiMo", provider: "xiaomi" }],
			},
		};
		await mount("/settings/providers?provider=xiaomi");
		expect(currentCustomDetail()).toBeUndefined();
		expect(container.querySelector("button.mantine-ActionIcon-root")).toBeNull();
		expect(container.querySelector('a[href="/settings/providers/add"]')).not.toBeNull();
	});
});

describe("provider add nested route", () => {
	test("overview Link opens a page, retaining outer navigation and hiding overview/save controls", async () => {
		await mount();
		await dirtyOriginal();
		await openAdd();
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(container.querySelector("[data-app-shell]")).not.toBeNull();
		expect(container.querySelector('[aria-label="Application navigation"]')).not.toBeNull();
		expect(container.querySelector('[aria-label="Settings navigation"]')).not.toBeNull();
		expect(container.querySelector('a[href="/settings/providers/add"]')).toBeNull();
		expect(container.textContent).not.toContain(text("unsavedSave"));
		expectNoSave();
	});

	for (const action of ["cancel", "browser back"] as const) {
		test(`${action} creates no provider and retains the parent's unsaved reducer state`, async () => {
			await mount();
			await dirtyOriginal();
			await openAdd();
			await click(button("addProviderCompletions"));
			await type("addProviderName", "Discard this draft");
			await type("addProviderBaseUrl", "https://discard.example/v1");
			if (action === "cancel") await click(button("addProviderCancel"));
			else
				await act(async () => {
					router.history.back();
				});
			expect(router.state.location.pathname).toBe("/settings/providers");
			expectOriginalDisabled();
			// codex + CommandCode + existing: CommandCode 平台卡加入概览后多一张。
			expect(container.querySelectorAll('[role="button"]').length).toBe(3);
			expect(container.textContent).not.toContain("Discard this draft");
			expectNoSave();
		});
	}

	for (const [protocol, key, method] of protocols) {
		test(`adding ${protocol} saves only the new record, refreshes its persisted ID and retains prior edits`, async () => {
			await mount();
			await dirtyOriginal();
			await openAdd();
			await fillDraft(key);
			await submit();
			const field = protocol === "nug" ? "nugProviders" : "customApiProviders";
			const draft = protocol === "nug" ? nugDetail?.providers[0] : customDetail?.provider;
			expect(draft).toMatchObject({
				name: "New draft",
				prefix: "draft",
				baseUrl: "https://draft.example/v1",
				apiKey: "draft-secret",
			});
			expect(draft?.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
			if (protocol !== "nug") {
				expect(customDetail?.provider.protocol).toBe(protocol);
				expect(customDetail?.isProviderDirty?.(draft?.id ?? "")).toBe(false);
			}
			expect(saveCalls).toBe(1);
			expect(Object.keys(savedPayloads[0] ?? {})).toEqual([field]);
			expect(refreshCalls).toEqual([{ method, id: draft?.id ?? "" }]);
			expect(persistedProviders().find((provider) => provider.id === "existing")).toEqual(
				initialSettings.customApiProviders[0],
			);
			expect(serverSettings.agent).toEqual(initialSettings.agent);
			expect(
				persistedProviders(field).find((provider) => provider.id === draft?.id)?.groupModels,
			).toEqual(freshModels);
			for (const cacheKey of [["admin", "settings"], ["settings"]])
				expect(queryClient.getQueryData<Record<string, unknown>>(cacheKey)).toEqual(serverSettings);
			for (const options of requestOptions.filter(Boolean)) {
				expect(options).toMatchObject({ maxResponseBytes: 8 * 1024 * 1024 });
				expect((options as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
			}
			await leaveDetail();
			expectOriginalDisabled();
			expect(container.textContent).toContain(text("unsavedSave"));
			// codex + CommandCode + existing + 新增的 draft。
			expect(container.querySelectorAll('[role="button"]').length).toBe(4);
		});
	}

	for (const lostResponse of [false, true]) {
		test(`save failure retains form/key and stable retry ID without duplicate (persisted=${lostResponse})`, async () => {
			await mount();
			await openAdd();
			await fillDraft();
			saveError = new Error("Save failed deliberately");
			persistBeforeError = lostResponse;
			await dispatchSubmit();
			expect(router.state.location.pathname).toBe("/settings/providers/add");
			expect(container.textContent).toContain("Save failed deliberately");
			expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe(
				"draft-secret",
			);
			expect(refreshCalls).toHaveLength(0);
			const first = (savedPayloads[0]?.customApiProviders as Array<{ id: string }>).at(-1)?.id;
			saveError = undefined;
			await submit();
			expect(saveCalls).toBe(2);
			expect(customDetail?.provider.id).toBe(first);
			expect(persistedProviders().filter((provider) => provider.id === first)).toHaveLength(1);
			expect(refreshCalls).toHaveLength(1);
		});
	}

	test("protocol switching after a lost save response preserves key and moves the same ID between arrays", async () => {
		await mount();
		await openAdd();
		await fillDraft();
		saveError = new Error("Lost save response");
		persistBeforeError = true;
		await dispatchSubmit();
		const id = persistedProviders().at(-1)?.id as string;
		await click(button("addProviderNug"));
		expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe(
			"draft-secret",
		);
		await type("addProviderName", "New draft");
		await type("addProviderBaseUrl", "https://draft.example/v1");
		await type("providerPrefix", "draft");
		saveError = undefined;
		await submit();
		expect(nugDetail?.providers[0]?.id).toBe(id);
		expect(persistedProviders().some((provider) => provider.id === id)).toBe(false);
		expect(
			persistedProviders("nugProviders").filter((provider) => provider.id === id),
		).toHaveLength(1);
		expect(refreshCalls).toEqual([{ method: "nugRefreshProviderModels", id }]);
		expect(Object.keys(savedPayloads[1] ?? {}).sort()).toEqual([
			"customApiProviders",
			"nugProviders",
		]);
	});

	test("an existing dirty provider edit is retained locally but never sent with the new record", async () => {
		await mount();
		const card = [...container.querySelectorAll('[role="button"]')].find((node) =>
			node.textContent?.includes("Existing provider"),
		);
		if (!card) throw new Error("Missing existing provider");
		await click(card);
		await act(async () =>
			customDetail?.onProvidersChange((providers) =>
				providers.map((provider) => ({ ...provider, name: "Unsaved existing edit" })),
			),
		);
		await leaveDetail();
		await openAdd();
		await fillDraft();
		await submit();
		expect(persistedProviders().find((provider) => provider.id === "existing")?.name).toBe(
			"Existing provider",
		);
		await leaveDetail();
		expect(container.textContent).toContain(text("unsavedSave"));
		const editedCard = [...container.querySelectorAll('[role="button"]')].find((node) =>
			node.textContent?.includes("Existing provider"),
		);
		if (!editedCard) throw new Error("Missing existing provider after rebase");
		await click(editedCard);
		expect(customDetail?.provider.name).toBe("Unsaved existing edit");
		expect(customDetail?.isProviderDirty?.("existing")).toBe(true);
	});

	test("refresh failure returns to the saved configuration and reports a yellow warning", async () => {
		await mount();
		await openAdd();
		await fillDraft();
		refreshError = new Error("Refresh failed deliberately");
		await submit();
		expect(saveCalls).toBe(1);
		expect(customDetail?.provider.name).toBe("New draft");
		expect(customDetail?.isProviderDirty?.(customDetail.provider.id)).toBe(false);
		expect(warnings).toContainEqual(
			expect.objectContaining({ color: "yellow", title: text("addProviderSavedRefreshFailed") }),
		);
		expect(queryClient.getQueryData<Record<string, unknown>>(["admin", "settings"])).toEqual(
			serverSettings,
		);
	});

	test("new creation does not persist an existing local deletion", async () => {
		await mount();
		const card = [...container.querySelectorAll('[role="button"]')].find((node) =>
			node.textContent?.includes("Existing provider"),
		);
		if (!card) throw new Error("Missing existing provider");
		await click(card);
		await act(async () =>
			customDetail?.onProvidersChange((providers) =>
				providers.filter((provider) => provider.id !== "existing"),
			),
		);
		// The removed provider no longer resolves from `?provider=`, so the page is back
		// on the overview instead of an empty detail view.
		expect(container.querySelector("button.mantine-ActionIcon-root")).toBeNull();
		await openAdd();
		await fillDraft();
		await submit();
		expect(persistedProviders().some((provider) => provider.id === "existing")).toBe(true);
		await leaveDetail();
		expect(container.textContent).not.toContain("Existing provider");
		expect(container.textContent).toContain(text("unsavedSave"));
	});

	test("duplicate programmatic submits are guarded during a pending request", async () => {
		let release = () => {};
		saveGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await mount();
		await openAdd();
		await fillDraft();
		await dispatchSubmit(2);
		expect(router.state.location.pathname).toBe("/settings/providers/add");
		expect(container.querySelector("fieldset")?.hasAttribute("disabled")).toBe(true);
		await dispatchSubmit();
		expect(saveCalls).toBe(1);
		await act(async () => {
			release();
		});
		expect(router.state.location.pathname).toBe("/settings/providers");
		expect(refreshCalls).toHaveLength(1);
	});

	test("browser back while saving never navigates back or selects the completed provider", async () => {
		let release = () => {};
		saveGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await mount();
		await openAdd();
		await fillDraft();
		await dispatchSubmit();
		await act(async () => {
			router.history.back();
		});
		expect(router.state.location.pathname).toBe("/settings/providers");
		await act(async () => {
			release();
		});
		expect(router.state.location.pathname).toBe("/settings/providers");
		expect(container.querySelector("[data-custom-detail]")).toBeNull();
		expect(container.textContent).toContain("New draft");
		expect(saveCalls).toBe(1);
	});

	for (const status of [
		"completed",
		"failed",
		"cancelled",
		"pending",
		"pending-cancel-failure",
	] as const)
		test(`TokenDance whole-page remount restores dirty key/sets and add form (${status})`, async () => {
			await mount();
			const baseline = providersStateFromSettings(initialSettings);
			const local = structuredClone(baseline);
			local.customApiProviders[0] = {
				...baseline.customApiProviders[0],
				name: "Recovered dirty edit",
				apiKey: "unsaved-other-key",
			};
			local.hiddenModels.add("existing:hidden");
			const snapshot: TokenDanceDraftSnapshot = tokenDanceDraftSnapshot(
				local,
				createSnapshot(baseline),
				{
					query: "",
					category: "all",
					presetId: "deepseek",
					showConfig: true,
					draft: {
						protocol: "openai-responses",
						name: "Unsubmitted API",
						baseUrl: "https://api.deepseek.com/v1",
						prefix: "new",
						apiKey: "new-unsaved-key",
					},
				},
			);
			await act(async () => root?.unmount());
			root = createRoot(container);
			serverSettings = {
				...clone(initialSettings),
				tokendance: {
					connected: true,
					name: "TokenDance fresh",
					disabled: false,
					generation: 9,
					models: [
						{
							id: "raw:model",
							name: "Fresh platform model",
							context_length: 64000,
							supported_protocols: ["openai:responses"],
						},
					],
				},
			};
			queryClient.setQueryData(["admin", "settings"], serverSettings);
			sessionStorage.setItem(TOKENDANCE_FLOW_MARKER, `remount-${status}`);
			const serverStatus = status === "pending-cancel-failure" ? "pending" : status;
			const restoreSpy = spyOn(api, "tokenDanceDraftRestore").mockResolvedValue({
				status: serverStatus,
				draftSnapshot: snapshot,
			});
			const cancelSpy = spyOn(api, "tokenDanceOAuthCancel").mockImplementation(async () => {
				if (status === "pending-cancel-failure")
					throw new Error("server restarted after successful claim");
				return { ok: true };
			});
			restorers.push(
				() => restoreSpy.mockRestore(),
				() => cancelSpy.mockRestore(),
			);
			await mount();
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 30));
			});
			expect(restoreSpy).toHaveBeenCalledTimes(1);
			expect(cancelSpy).toHaveBeenCalledTimes(serverStatus === "pending" ? 1 : 0);
			expect(sessionStorage.getItem(TOKENDANCE_FLOW_MARKER)).toBeNull();
			if (status === "completed") {
				expect(router.state.location.pathname).toBe("/settings/providers");
				await openAdd();
			}
			expect(router.state.location.pathname).toBe("/settings/providers/add");
			const password = container.querySelector<HTMLInputElement>('input[type="password"]');
			expect(password?.value).toBe("new-unsaved-key");
			await click(button("addProviderCancel"));
			const card = [...container.querySelectorAll('[role="button"]')].find((node) =>
				node.textContent?.includes("Existing provider"),
			);
			if (!card) throw new Error("Missing recovered provider");
			await click(card);
			expect(customDetail?.provider.name).toBe("Recovered dirty edit");
			expect(customDetail?.provider.apiKey).toBe("unsaved-other-key");
			expect(customDetail?.hiddenModels.has("existing:hidden")).toBe(true);
			expect((serverSettings.tokendance as { generation: number }).generation).toBe(9);
			expect(saveCalls).toBe(0);
		});

	for (const reason of ["expired", "actor mismatch", "server restarted"])
		test(`TokenDance ${reason} clears marker and shows draft recovery warning`, async () => {
			sessionStorage.setItem(TOKENDANCE_FLOW_MARKER, `failure-${reason}`);
			const restoreSpy = spyOn(api, "tokenDanceDraftRestore").mockRejectedValue(new Error(reason));
			restorers.push(() => restoreSpy.mockRestore());
			await mount();
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 30));
			});
			expect(restoreSpy).toHaveBeenCalledTimes(1);
			expect(sessionStorage.getItem(TOKENDANCE_FLOW_MARKER)).toBeNull();
			expect(container.textContent).toContain(text("tokendance.draftUnavailable"));
			expect(saveCalls).toBe(0);
		});

	test("fresh settings failure leaves snapshot unclaimed and marker retryable", async () => {
		const baseline = providersStateFromSettings(initialSettings);
		const local = structuredClone(baseline);
		local.customApiProviders[0] = {
			...baseline.customApiProviders[0],
			apiKey: "retry-preserved-key",
		};
		const snapshot = tokenDanceDraftSnapshot(local, createSnapshot(baseline));
		sessionStorage.setItem(TOKENDANCE_FLOW_MARKER, "fresh-retry-flow");
		const freshSpy = spyOn(api, "getSettings").mockRejectedValue(
			new Error("temporary network failure"),
		);
		const restoreSpy = spyOn(api, "tokenDanceDraftRestore").mockResolvedValue({
			status: "completed",
			draftSnapshot: snapshot,
		});
		restorers.push(
			() => freshSpy.mockRestore(),
			() => restoreSpy.mockRestore(),
		);
		await mount();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		expect(restoreSpy).not.toHaveBeenCalled();
		expect(sessionStorage.getItem(TOKENDANCE_FLOW_MARKER)).toBe("fresh-retry-flow");
		expect(container.textContent).toContain(text("tokendance.settingsUnavailable"));
		freshSpy.mockResolvedValue(clone(serverSettings));
		await click(button("tokendance.retryRestore"));
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		expect(restoreSpy).toHaveBeenCalledTimes(1);
		expect(sessionStorage.getItem(TOKENDANCE_FLOW_MARKER)).toBeNull();
		const card = [...container.querySelectorAll('[role="button"]')].find((node) =>
			node.textContent?.includes("Existing provider"),
		);
		if (!card) throw new Error("Missing recovered existing provider");
		await click(card);
		expect(customDetail?.provider.apiKey).toBe("retry-preserved-key");
	});

	test("TokenDance appears only when connected in platform and local-only delete is guarded", async () => {
		await mount();
		expect(container.textContent).not.toContain("TokenDance fresh");
		await act(async () => root?.unmount());
		root = createRoot(container);
		serverSettings = {
			...clone(initialSettings),
			tokendance: {
				connected: true,
				name: "TokenDance fresh",
				disabled: false,
				generation: 1,
				models: [],
			},
		};
		queryClient.setQueryData(["admin", "settings"], serverSettings);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const deleteSpy = spyOn(api, "tokenDanceDeleteConnection").mockImplementation(async () => {
			await gate;
			serverSettings = {
				...serverSettings,
				tokendance: {
					connected: false,
					name: "TokenDance",
					disabled: false,
					generation: 2,
					models: [],
				},
			};
		});
		restorers.push(() => deleteSpy.mockRestore());
		await mount();
		const card = [...container.querySelectorAll('[role="button"]')].find((node) =>
			node.textContent?.includes("TokenDance fresh"),
		);
		if (!card) throw new Error("Missing connected TokenDance");
		expect(card.textContent).toContain(text("providerTypePlatform"));
		await click(card);
		await click(button("tokendance.delete"));
		expect(deleteSpy).not.toHaveBeenCalled();
		confirmAnswer = true;
		const remove = button("tokendance.delete");
		await click(remove);
		expect(remove.disabled).toBe(true);
		await click(remove);
		expect(deleteSpy).toHaveBeenCalledTimes(1);
		await act(async () => {
			release();
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		expect(container.textContent).not.toContain("TokenDance fresh");
		expect(container.textContent).toContain("Existing provider");
		expect(saveCalls).toBe(0);
	});

	test("successful TokenDance callback opens its detail with unified hide/show model controls", async () => {
		serverSettings = {
			...clone(initialSettings),
			agent: { hiddenModels: ["existing:keep"], disabledProviders: [] },
			tokendance: {
				connected: true,
				name: "TokenDance fresh",
				disabled: false,
				generation: 1,
				models: [
					{
						id: "raw:model",
						name: "Platform model",
						context_length: 64000,
						supported_protocols: ["openai:responses"],
					},
					{
						id: "second",
						name: "Second model",
						context_length: 32000,
						supported_protocols: ["anthropic:messages"],
					},
				],
			},
		};
		queryClient.setQueryData(["admin", "settings"], serverSettings);
		// Row windows come from the catalog's window endpoint, which reports the platform's value.
		queryClient.setQueryData(["model-catalog", "window", "tokendance:raw:model"], {
			revision: 0,
			info: {
				model: "tokendance:raw:model",
				contextWindow: 64000,
				source: "discovered",
				inherited: 64000,
				inheritedSource: "discovered",
				others: [],
			},
		});
		const complete = spyOn(tokenDanceFlow, "completeTokenDanceCallback").mockResolvedValue(true);
		restorers.push(() => complete.mockRestore());
		await mount("/settings/providers/tokendance/callback");
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
		});
		expect(router.state.location.pathname).toBe("/settings/providers");
		expect(router.state.location.search).toMatchObject({ provider: "tokendance" });
		expect(container.textContent).toContain("tokendance:raw:model");
		expect(container.textContent).toContain("Platform model");
		const modelRow = () =>
			[...container.querySelectorAll("p")].find(
				(node) => node.textContent === "tokendance:raw:model",
			)?.parentElement;
		// The window column shows the value requests use and where it comes from.
		expect(modelRow()?.textContent).toContain("64k");
		// The unified row contains NumberInput controls and model testing; its last button toggles visibility.
		const rowButtons = modelRow()?.querySelectorAll<HTMLButtonElement>("button");
		const visibility = rowButtons?.item(rowButtons.length - 1);
		if (!visibility) throw new Error("Missing unified visibility control");
		await click(visibility);
		expect(modelRow()?.style.opacity).toBe("0.5");
		await click(button("unsavedSave"));
		expect((savedPayloads.at(-1)?.agent as { hiddenModels: string[] }).hiddenModels).toEqual(
			expect.arrayContaining(["existing:keep", "tokendance:raw:model"]),
		);
		const list = modelRow()?.parentElement;
		const batch = list?.querySelector<HTMLButtonElement>("button");
		if (!batch) throw new Error("Missing unified batch visibility control");
		await click(batch);
		await click(button("unsavedSave"));
		expect((savedPayloads.at(-1)?.agent as { hiddenModels: string[] }).hiddenModels).toEqual(
			expect.arrayContaining(["existing:keep", "tokendance:raw:model", "tokendance:second"]),
		);
		await click(batch);
		await click(button("unsavedSave"));
		expect((savedPayloads.at(-1)?.agent as { hiddenModels: string[] }).hiddenModels).toEqual([
			"existing:keep",
		]);
	});
	test("successful TokenDance refresh clears transient recovery action at the same generation", async () => {
		serverSettings = {
			...clone(initialSettings),
			tokendance: {
				connected: true,
				name: "TokenDance fresh",
				disabled: false,
				generation: 1,
				models: [],
			},
		};
		queryClient.setQueryData(["admin", "settings"], serverSettings);
		const refreshSpy = spyOn(api, "tokenDanceRefreshModels")
			.mockRejectedValueOnce(new ApiError("redacted", 402, { recoveryAction: "top_up_balance" }))
			.mockResolvedValue({ models: [] });
		restorers.push(() => refreshSpy.mockRestore());
		await mount();
		const card = [...container.querySelectorAll('[role="button"]')].find((node) =>
			node.textContent?.includes("TokenDance fresh"),
		);
		if (!card) throw new Error("Missing TokenDance card");
		await click(card);
		await click(button("tokendance.refresh"));
		expect(container.textContent).toContain(text("tokendance.top_up_balance"));
		await click(button("tokendance.refresh"));
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		expect(container.textContent).not.toContain(text("tokendance.top_up_balance"));
		expect(refreshSpy).toHaveBeenCalledTimes(2);
	});

	test("TokenDance overview switch drafts locally and only persists via the save bar", async () => {
		serverSettings = {
			...clone(initialSettings),
			tokendance: {
				connected: true,
				name: "TokenDance fresh",
				disabled: false,
				generation: 1,
				models: [],
			},
		};
		queryClient.setQueryData(["admin", "settings"], serverSettings);
		const updateSpy = spyOn(api, "tokenDanceUpdateConnection").mockImplementation(
			async (disabled) => {
				const connection = {
					...(serverSettings.tokendance as {
						connected: boolean;
						name: string;
						disabled: boolean;
						generation: number;
						models: [];
					}),
					disabled,
				};
				serverSettings = { ...serverSettings, tokendance: connection };
				return connection;
			},
		);
		restorers.push(() => updateSpy.mockRestore());
		await mount();
		const card = [...container.querySelectorAll('[role="button"]')].find((node) =>
			node.textContent?.includes("TokenDance fresh"),
		);
		const toggle = card?.querySelector<HTMLInputElement>('input[type="checkbox"]');
		if (!toggle) throw new Error("Missing platform switch");
		// 点击只写草稿：不触发任何连接接口，且底部保存条出现。
		await act(async () => {
			toggle.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(updateSpy).toHaveBeenCalledTimes(0);
		expect(saveCalls).toBe(0);
		expect(container.textContent).toContain(text("unsavedSave"));
		expect(container.textContent).toContain(text("unsavedDiscard"));
		// 保存条是唯一的提交点：点「保存更改」后才写连接与 settings。
		await click(button("unsavedSave"));
		expect(updateSpy).toHaveBeenCalledTimes(1);
		expect(updateSpy.mock.calls[0]?.[0]).toBe(true);
		expect(saveCalls).toBe(1);
		expect(
			(savedPayloads.at(-1)?.agent as { disabledProviders?: string[] }).disabledProviders,
		).not.toContain("tokendance");
	});

	test("TokenDance detail enable switch drafts locally too", async () => {
		serverSettings = {
			...clone(initialSettings),
			tokendance: {
				connected: true,
				name: "TokenDance fresh",
				disabled: false,
				generation: 1,
				models: [],
			},
		};
		queryClient.setQueryData(["admin", "settings"], serverSettings);
		const updateSpy = spyOn(api, "tokenDanceUpdateConnection").mockImplementation(
			async (disabled) => {
				const connection = {
					...(serverSettings.tokendance as {
						connected: boolean;
						name: string;
						disabled: boolean;
						generation: number;
						models: [];
					}),
					disabled,
				};
				serverSettings = { ...serverSettings, tokendance: connection };
				return connection;
			},
		);
		restorers.push(() => updateSpy.mockRestore());
		await mount();
		const card = [...container.querySelectorAll('[role="button"]')].find((node) =>
			node.textContent?.includes("TokenDance fresh"),
		);
		if (!card) throw new Error("Missing TokenDance card");
		await click(card);
		// 详情页的「启用」开关同样只写草稿，不直接改连接记录。
		const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
		if (!toggle) throw new Error("Missing detail enable switch");
		await act(async () => {
			toggle.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(updateSpy).toHaveBeenCalledTimes(0);
		expect(saveCalls).toBe(0);
		expect(container.textContent).toContain(text("unsavedSave"));
		await click(button("unsavedSave"));
		expect(updateSpy).toHaveBeenCalledTimes(1);
	});

	test("codex overview switch drafts locally and reorders only after saving", async () => {
		// codex 无凭据（codexAvailable 缺失）：排序过去会把它压在平台分区末尾，
		// 开关切了也不动。现在排序只看已保存的开关状态，无凭据只影响徽章。
		// 概览按「平台集成 / 自定义」分区渲染，排序语义是分区内 active 在前、
		// inactive 沉底 —— 所以断言 codex 与 CommandCode 的分区内相对顺序。
		serverSettings = clone(initialSettings);
		await mount();
		const cardIndex = (needle: string) =>
			[...container.querySelectorAll('[role="button"]')].findIndex((node) =>
				node.textContent?.includes(needle),
			);
		// 两者都启用：按插入序 codex 在 CommandCode 前。
		expect(cardIndex("codex")).toBeLessThan(cardIndex("CommandCode"));
		const codexCard = [...container.querySelectorAll('[role="button"]')].find((node) =>
			node.textContent?.includes("codex"),
		);
		const toggle = codexCard?.querySelector<HTMLInputElement>('input[type="checkbox"]');
		if (!toggle) throw new Error("Missing codex platform switch");
		// 点击只写草稿：不落库、保存条出现、卡片顺序不动。
		await act(async () => {
			toggle.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(saveCalls).toBe(0);
		expect(container.textContent).toContain(text("unsavedSave"));
		expect(cardIndex("codex")).toBeLessThan(cardIndex("CommandCode"));
		// 保存后才重排一次：codex 在平台分区内沉底。
		await click(button("unsavedSave"));
		expect(saveCalls).toBe(1);
		expect(
			(savedPayloads.at(-1)?.agent as { disabledProviders?: string[] }).disabledProviders,
		).toContain("codex");
		expect(cardIndex("codex")).toBeGreaterThan(cardIndex("CommandCode"));
	});

	test("slow settings keep the add-page title and back navigation visible", async () => {
		let release!: () => void;
		settingsGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		queryClient.removeQueries({ queryKey: ["admin", "settings"] });
		await mount("/settings/providers/add");
		expect(container.querySelector('[data-testid="providers-settings-skeleton"]')).not.toBeNull();
		expect(container.textContent).toContain(text("addProvider"));
		expect(button("addProviderBack")).toBeDefined();
		expect(container.textContent).not.toContain(text("addProviderContinue"));

		await act(async () => {
			release();
			await settingsGate;
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(container.querySelector('[data-testid="providers-settings-skeleton"]')).toBeNull();
		expect(button("addProviderCancel")).toBeDefined();
	});

	test("direct entry to add initializes the parent and cancellation returns to providers", async () => {
		await mount("/settings/providers/add");
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		await click(button("addProviderCancel"));
		expect(router.state.location.pathname).toBe("/settings/providers");
		expect(container.textContent).toContain("Existing provider");
		// codex + CommandCode + existing：CommandCode 平台卡加入概览后多一张。
		expect(container.querySelectorAll('[role="button"]').length).toBe(3);
		expectNoSave();
	});
});
