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
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		getComputedStyle: () => ({ getPropertyValue: () => "", overflow: "visible" }),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(values)) patch(globalThis, key, value);
}
function restoreDom() {
	for (const undo of undoDom.splice(0).reverse()) undo();
}
installDom();
const { createRoot } = await import("react-dom/client");
const { MantineProvider } = await import("@mantine/core");
const { I18nextProvider } = await import("react-i18next");
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
const restorers: Array<() => void> = [];

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
	const getSpy = spyOn(api, "getSettings").mockResolvedValue(initialSettings);
	const saveSpy = spyOn(api, "updateSettings").mockImplementation(async () => {
		saveCalls++;
		return initialSettings;
	});
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
async function submit() {
	expect(button("addProviderContinue").disabled).toBe(false);
	const form = container.querySelector("form");
	if (!form) throw new Error("Missing add form");
	await act(async () => {
		form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	});
	expect(router.state.location.pathname).toBe("/settings/providers");
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

	for (const protocol of ["custom", "nug"] as const) {
		test(`adding ${protocol} returns exactly one unsaved draft while retaining prior edits`, async () => {
			await mount();
			await dirtyOriginal();
			await openAdd();
			await click(button(protocol === "nug" ? "addProviderNug" : "addProviderCompletions"));
			await type("addProviderName", "New draft");
			await type("addProviderBaseUrl", "https://draft.example/v1");
			await type("addProviderApiKey", "draft-secret");
			await type("providerPrefix", "draft");
			await submit();
			const draft = protocol === "nug" ? nugDetail?.providers[0] : customDetail?.provider;
			expect(draft).toMatchObject({
				name: "New draft",
				prefix: "draft",
				baseUrl: "https://draft.example/v1",
				apiKey: "draft-secret",
			});
			if (protocol === "custom")
				expect(customDetail?.provider.protocol).toBe("completions-compatible");
			await leaveDetail();
			expectOriginalDisabled();
			expect(container.querySelectorAll('[role="button"]').length).toBe(3);
			expect(
				[...container.querySelectorAll('[role="button"]')].filter((node) =>
					node.textContent?.includes("New draft"),
				),
			).toHaveLength(1);
			expectNoSave();
		});
	}

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
