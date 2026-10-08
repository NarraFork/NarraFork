import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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

// Real parent reducer, file-route components, overview Link, and add form. Only
// authentication/API I/O and the unrelated provider-detail editors are substituted.
// Application/settings shells are minimal fixtures, not the production auth layout.
const undoDom: Array<() => void> = [];
const animationFrames = new Set<ReturnType<typeof setTimeout>>();
function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	function patch(object: object, key: string, value: unknown) {
		const old = Object.getOwnPropertyDescriptor(object, key);
		Object.defineProperty(object, key, { configurable: true, writable: true, value });
		undoDom.push(() =>
			old ? Object.defineProperty(object, key, old) : Reflect.deleteProperty(object, key),
		);
	}
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
const { api } = await import("../../lib/api");
const { Route: parentFileRoute } = await import("../../routes/settings/providers");
const { Route: addFileRoute } = await import("../../routes/settings/providers.add");
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
let serverSettings: Record<string, unknown>;
let savedPayloads: Record<string, unknown>[];
let refreshCalls: Array<{ method: string; id: string }>;
let requestOptions: unknown[];
let warnings: Array<{ color?: string; title?: unknown }>;
let saveError: Error | undefined;
let refreshError: Error | undefined;
let saveGate: Promise<void> | undefined;
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
	return createRouter({
		routeTree: app.addChildren([settings.addChildren([providers.addChildren([add])])]),
		history: createMemoryHistory({ initialEntries: [href] }),
		defaultPendingMinMs: 0,
	});
}

beforeEach(() => {
	installDom();
	saveCalls = 0;
	serverSettings = clone(initialSettings);
	savedPayloads = [];
	refreshCalls = [];
	requestOptions = [];
	warnings = [];
	saveError = undefined;
	refreshError = undefined;
	saveGate = undefined;
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
		data: { role: "admin" },
	} as ReturnType<typeof auth.useCurrentUser>);
	const modelsSpy = spyOn(models, "useAllModels").mockReturnValue({
		providerLabels: { existing: "Existing provider", draft: "New draft" },
		codexModels: [],
		openaiByProvider: [],
		anthropicByProvider: [],
		geminiByProvider: [],
		nugByProvider: [],
		pluginProviderGroups: [],
	} as unknown as ReturnType<typeof models.useAllModels>);
	const getSpy = spyOn(api, "getSettings").mockImplementation(async (options) => {
		requestOptions.push(options);
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
						<ConfirmDialogContext value={{ confirm: async () => false }}>
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
			expect(container.querySelectorAll('[role="button"]').length).toBe(2);
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
			expect(container.querySelectorAll('[role="button"]').length).toBe(3);
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
		await leaveDetail();
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

	test("direct entry to add initializes the parent and cancellation returns to providers", async () => {
		await mount("/settings/providers/add");
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		await click(button("addProviderCancel"));
		expect(router.state.location.pathname).toBe("/settings/providers");
		expect(container.textContent).toContain("Existing provider");
		expect(container.querySelectorAll('[role="button"]').length).toBe(2);
		expectNoSave();
	});
});
