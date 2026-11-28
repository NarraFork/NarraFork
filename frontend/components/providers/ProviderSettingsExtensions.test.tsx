import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ProviderSettingsContribution } from "@shared/provider-settings";
import type { ProviderSettingsConfigView } from "@shared/provider-settings-values";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { ApiError } from "../../lib/api/client";
import {
	type ProviderSettingsExtensionView,
	type ProviderSettingsListResponse,
	type ProviderSettingsTarget,
	providerSettingsApi,
	providerSettingsKeys,
} from "../../lib/api/provider-settings";
import pluginsEn from "../../locales/en/plugins.json";
import { ConfirmDialogContext, type ConfirmOptions } from "../common/confirm-dialog-context";
import { SECRET_PLACEHOLDER } from "../plugins-admin/config-form-state";

// Use the real extension component, PluginConfigForm, Mantine controls, and QueryClient.
// Only API I/O and the answer to the confirmation prompt are controlled by the fixture.
const undoDom: Array<() => void> = [];
const frames = new Set<ReturnType<typeof setTimeout>>();
let makeEvent: (type: string) => Event;
let setNativeValue: (input: HTMLInputElement, value: string) => void;

function patch(target: object, key: string, descriptor: PropertyDescriptor) {
	const previous = Object.getOwnPropertyDescriptor(target, key);
	Object.defineProperty(target, key, { ...descriptor, configurable: true });
	undoDom.push(() => {
		if (previous) Object.defineProperty(target, key, previous);
		else Reflect.deleteProperty(target, key);
	});
}

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	makeEvent = (type) => new window.Event(type, { bubbles: true, cancelable: true });
	const inputProto = window.HTMLInputElement.prototype;
	const valueSetter = Object.getOwnPropertyDescriptor(inputProto, "value")?.set;
	if (!valueSetter) throw new Error("Input prototype has no native value setter");
	setNativeValue = (input, value) => valueSetter.call(input, value);
	const typeDescriptor = Object.getOwnPropertyDescriptor(inputProto, "type");
	if (typeDescriptor?.get) {
		const nativeGet = typeDescriptor.get;
		patch(inputProto, "type", {
			...typeDescriptor,
			get(this: HTMLInputElement) {
				return nativeGet.call(this) ?? "text";
			},
		});
	}
	for (const key of ["attachEvent", "detachEvent", "select", "setSelectionRange"]) {
		patch(inputProto, key, { value: () => {} });
	}
	patch(window.HTMLElement.prototype, "scrollIntoView", { value: () => {} });
	patch(window.document, "oninput", { value: null, writable: true });
	patch(window.document, "fonts", {
		value: { addEventListener() {}, removeEventListener() {} },
	});
	const matchMedia = (media: string) => ({
		matches: false,
		media,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	});
	const getComputedStyle = () =>
		new Proxy({}, { get: (_target, key) => (key === "getPropertyValue" ? () => "" : "") });
	const requestAnimationFrame = (callback: FrameRequestCallback) => {
		const id = setTimeout(() => {
			frames.delete(id);
			callback(performance.now());
		}, 0);
		frames.add(id);
		return id;
	};
	const cancelAnimationFrame = (id: ReturnType<typeof setTimeout>) => {
		frames.delete(id);
		clearTimeout(id);
	};
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		Document: window.Document,
		ShadowRoot: window.ShadowRoot ?? class {},
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
		matchMedia,
		getComputedStyle,
		requestAnimationFrame,
		cancelAnimationFrame,
		// The real useCurrentUser reads its seeded query without starting auth traffic.
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		patch(globalThis, key, { value, writable: true });
	}
}

function restoreDom() {
	for (const frame of frames) clearTimeout(frame);
	frames.clear();
	for (const undo of undoDom.splice(0).reverse()) undo();
}

// Match PluginConfigForm.test.tsx's native setter/focusin/keyup handling; installing
// oninput before importing React DOM also lets its modern input-event probe succeed.
installDom();
const { createRoot } = await import("react-dom/client");
const { MantineProvider } = await import("@mantine/core");
const { I18nextProvider } = await import("react-i18next");
const { ProviderSettingsExtensions } = await import("./ProviderSettingsExtensions");
restoreDom();

const i18n = createInstance();
await i18n.init({
	lng: "en",
	fallbackLng: "en",
	defaultNS: "plugins",
	resources: { en: { plugins: pluginsEn } },
	initImmediate: false,
});

const targetA: ProviderSettingsTarget = { kind: "custom-api", id: "provider-a" };
const targetB: ProviderSettingsTarget = { kind: "custom-api", id: "provider-b" };
const targetOtherKind: ProviderSettingsTarget = { kind: "nug", id: targetA.id };
const pluginId = "fixture.extensions";
const declaration: ProviderSettingsContribution = {
	id: "quota",
	schemaVersion: 1,
	title: "Fixture provider extension",
	targetKinds: ["custom-api", "nug"],
	configSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			label: { type: "string", title: "Extension label" },
			apiKey: { type: "string", title: "API key", "x-narrafork-secret": true },
		},
	},
	action: { title: "Check connection" },
};

function config(overrides: Partial<ProviderSettingsConfigView> = {}): ProviderSettingsConfigView {
	return {
		schemaVersion: 1,
		schemaFingerprint: "a".repeat(64),
		revision: 7,
		bindingRevision: "b".repeat(64),
		status: "ready",
		values: { label: "Saved extension" },
		secrets: { apiKey: { isSet: true } },
		...overrides,
	};
}

function extension(target: ProviderSettingsTarget, view = config()): ProviderSettingsExtensionView {
	return {
		pluginId,
		contributionId: declaration.id,
		declaration,
		pluginState: "enabled",
		compatible: true,
		target: { ...target, name: target.id, disabled: false, available: true },
		config: view,
	};
}

function testRouter() {
	return createRouter({
		routeTree: createRootRoute({ component: () => null }),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let router: ReturnType<typeof testRouter>;
let views: Map<string, ProviderSettingsListResponse>;
let answerConfirmation: ((confirmed: boolean) => void) | undefined;
const confirm = mock(
	(_options: ConfirmOptions) =>
		new Promise<boolean>((resolve) => {
			answerConfirmation = resolve;
		}),
);
let list: ReturnType<typeof spyOn<typeof providerSettingsApi, "list">>;
let save: ReturnType<typeof spyOn<typeof providerSettingsApi, "save">>;
let remove: ReturnType<typeof spyOn<typeof providerSettingsApi, "remove">>;
let action: ReturnType<typeof spyOn<typeof providerSettingsApi, "action">>;
let retained: ReturnType<typeof spyOn<typeof providerSettingsApi, "retained">>;
let rebind: ReturnType<typeof spyOn<typeof providerSettingsApi, "rebind">>;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

function targetKey(target: ProviderSettingsTarget) {
	return `${target.kind}:${target.id}`;
}

function seed(target: ProviderSettingsTarget, view = extension(target)) {
	const response = { extensions: [view] };
	views.set(targetKey(target), response);
	client.setQueryData(providerSettingsKeys.list(target), response);
}

beforeEach(() => {
	installDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: Infinity },
			mutations: { retry: false },
		},
	});
	router = testRouter();
	views = new Map();
	client.setQueryData(["auth", "me"], { id: "fixture-admin", role: "admin" });
	for (const target of [targetA, targetB, targetOtherKind]) seed(target);
	answerConfirmation = undefined;
	confirm.mockClear();
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
		throw new Error("Unexpected real network request");
	}) as unknown as typeof fetch);
	list = spyOn(providerSettingsApi, "list").mockImplementation(async (target) => {
		const response = views.get(targetKey(target));
		if (!response) throw new Error(`Unexpected target: ${targetKey(target)}`);
		return structuredClone(response);
	});
	save = spyOn(providerSettingsApi, "save").mockResolvedValue(config());
	remove = spyOn(providerSettingsApi, "remove").mockResolvedValue({ ok: true });
	action = spyOn(providerSettingsApi, "action").mockResolvedValue({ text: "Action complete" });
	retained = spyOn(providerSettingsApi, "retained").mockResolvedValue({
		items: [
			{ targetId: "another-retired-provider", revision: 11, updatedAt: "2026-01-01T00:00:00Z" },
			{ targetId: "retired-provider", revision: 23, updatedAt: "2026-01-02T00:00:00Z" },
		],
		nextCursor: null,
	});
	rebind = spyOn(providerSettingsApi, "rebind").mockResolvedValue(config());
});

afterEach(async () => {
	await act(async () => {
		answerConfirmation?.(false);
		root.unmount();
	});
	client.clear();
	container.remove();
	for (const spy of [list, save, remove, action, retained, rebind, fetchSpy]) spy.mockRestore();
	restoreDom();
});

afterAll(restoreDom);

async function render(target = targetA, coreDirty = false) {
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<I18nextProvider i18n={i18n}>
					<RouterContextProvider router={router}>
						<MantineProvider env="test">
							<ConfirmDialogContext.Provider value={{ confirm }}>
								<ProviderSettingsExtensions target={target} coreDirty={coreDirty} />
							</ConfirmDialogContext.Provider>
						</MantineProvider>
					</RouterContextProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		);
	});
}

async function until(check: () => boolean, description: string) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (check()) return;
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	}
	throw new Error(`Timed out waiting for ${description}`);
}

function findButton(key: string): HTMLButtonElement | undefined {
	return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(button) => button.textContent?.trim() === i18n.t(key),
	);
}

function button(key: string): HTMLButtonElement {
	const result = findButton(key);
	if (!result) throw new Error(`Missing button: ${key}`);
	return result;
}

function field(labelText: string): HTMLInputElement {
	const label = [...container.querySelectorAll("label")].find(
		(item) => item.textContent?.trim() === labelText,
	);
	const id = label?.getAttribute("for");
	const input = id ? document.getElementById(id) : null;
	if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input: ${labelText}`);
	return input;
}

async function click(element: Element) {
	await act(async () => {
		element.dispatchEvent(makeEvent("click"));
	});
}

async function typeInto(input: HTMLInputElement, value: string) {
	await act(async () => {
		input.dispatchEvent(makeEvent("focusin"));
	});
	await act(async () => {
		// Bypass React's instance value tracker, as in PluginConfigForm.test.tsx.
		setNativeValue(input, value);
		input.dispatchEvent(makeEvent("input"));
		input.dispatchEvent(makeEvent("keyup"));
	});
}

async function selectRetained(targetId: string) {
	const input = field(i18n.t("providerSettings.retainedSelect"));
	await until(() => !input.disabled, "retained providers to finish loading");
	await click(input);
	const option = [...document.querySelectorAll('[role="option"]')].find(
		(item) => item.textContent?.trim() === targetId,
	);
	if (!option) throw new Error(`Missing retained provider option: ${targetId}`);
	await click(option);
	expect(input.value).toBe(targetId);
}

async function answer(confirmed: boolean) {
	const resolve = answerConfirmation;
	if (!resolve) throw new Error("No pending confirmation");
	answerConfirmation = undefined;
	await act(async () => resolve(confirmed));
}

const saveKey = "admin.detail.config.save";
const actionKey = "providerSettings.runAction";

describe("ProviderSettingsExtensions DOM interactions", () => {
	test("core changes block extension writes and actions while preserving an existing draft", async () => {
		await render(targetA, true);
		expect(container.textContent).toContain(i18n.t("providerSettings.unsavedCore"));
		expect(field("Extension label").disabled).toBe(true);
		expect(field("API key").disabled).toBe(true);
		expect(button(saveKey).disabled).toBe(true);
		expect(findButton(actionKey)).toBeUndefined();
		expect(findButton("providerSettings.retained")).toBeUndefined();
		expect(findButton("providerSettings.delete")).toBeUndefined();
		await click(button(saveKey));
		expect(save).not.toHaveBeenCalled();
		expect(action).not.toHaveBeenCalled();
		expect(retained).not.toHaveBeenCalled();

		await render(targetA);
		expect(field("Extension label").disabled).toBe(false);
		expect(button(actionKey).disabled).toBe(false);
		await typeInto(field("Extension label"), "Unsaved extension draft");
		expect(button(saveKey).disabled).toBe(false);

		await render(targetA, true);
		expect(field("Extension label").value).toBe("Unsaved extension draft");
		expect(field("Extension label").disabled).toBe(true);
		expect(button(saveKey).disabled).toBe(true);
		expect(findButton(actionKey)).toBeUndefined();
		await click(button(saveKey));
		expect(save).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(rebind).not.toHaveBeenCalled();

		await render(targetA);
		expect(field("Extension label").value).toBe("Unsaved extension draft");
		expect(button(saveKey).disabled).toBe(false);
		expect(button(actionKey).disabled).toBe(true);
		await click(button(saveKey));
		await until(() => save.mock.calls.length === 1, "extension save after core becomes clean");
		expect(save).toHaveBeenCalledWith(targetA, pluginId, declaration.id, {
			schemaVersion: 1,
			schemaFingerprint: config().schemaFingerprint,
			expectedRevision: 7,
			expectedBindingRevision: config().bindingRevision,
			values: { label: "Unsaved extension draft" },
			secrets: { apiKey: { operation: "keep" } },
		});
	});

	test("a failed save keeps scalar and secret drafts and blocks actions until a successful save", async () => {
		save.mockRejectedValueOnce(
			new ApiError("fixture conflict", 409, { code: "PROVIDER_SETTINGS_REVISION_CONFLICT" }),
		);
		await render();
		expect(button(actionKey).disabled).toBe(false);
		await typeInto(field("Extension label"), "Retry this label");
		await typeInto(field("API key"), "fixture-secret-replacement");
		expect(button(actionKey).disabled).toBe(true);
		expect(button(actionKey).title).toBe(i18n.t("providerSettings.unsavedExtension"));
		await click(button(actionKey));
		expect(action).not.toHaveBeenCalled();

		await click(button(saveKey));
		await until(
			() => container.textContent?.includes("PROVIDER_SETTINGS_REVISION_CONFLICT") === true,
			"save failure to be displayed",
		);
		expect(save).toHaveBeenCalledTimes(1);
		expect(field("Extension label").value).toBe("Retry this label");
		expect(field("API key").value).toBe("fixture-secret-replacement");
		expect(button(saveKey).disabled).toBe(false);
		expect(button(actionKey).disabled).toBe(true);
		await render();
		expect(field("API key").value).toBe("fixture-secret-replacement");

		const saved = config({ revision: 8, values: { label: "Retry this label" } });
		save.mockImplementation(async (target) => {
			views.set(targetKey(target), { extensions: [extension(target, saved)] });
			return saved;
		});
		await click(button(saveKey));
		await until(
			() => button(saveKey).disabled && !button(actionKey).disabled,
			"the saved server revision to clear the draft",
		);
		expect(save).toHaveBeenCalledTimes(2);
		expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
		expect(save.mock.calls[1]?.[3]).toMatchObject({
			expectedRevision: 7,
			values: { label: "Retry this label" },
			secrets: { apiKey: { operation: "set", value: "fixture-secret-replacement" } },
		});
		expect(field("API key").value).toBe(SECRET_PLACEHOLDER);
		expect(container.textContent).not.toContain("PROVIDER_SETTINGS_REVISION_CONFLICT");
		expect(list).toHaveBeenCalled();
		await click(button(actionKey));
		await until(() => action.mock.calls.length === 1, "action after successful save");
		expect(action).toHaveBeenCalledWith(targetA, pluginId, declaration.id);
	});

	for (const [identity, nextTarget] of [
		["id", targetB],
		["kind", targetOtherKind],
	] as const) {
		test(`switching target ${identity} isolates drafts even when both saved views are identical`, async () => {
			// Both queries are already fresh in the same QueryClient. A loading/null render
			// must not accidentally unmount the form and conceal a missing target key.
			expect(views.get(targetKey(targetA))?.extensions[0]?.config).toEqual(
				views.get(targetKey(nextTarget))?.extensions[0]?.config,
			);
			await render(targetA);
			await click(button(actionKey));
			await until(
				() => container.textContent?.includes("Action complete") === true,
				"first target action result",
			);
			await typeInto(field("Extension label"), "Draft owned by first target");
			await typeInto(field("API key"), "fixture-first-target-secret");
			expect(button(actionKey).disabled).toBe(true);

			await render(nextTarget);
			expect(field("Extension label").value).toBe("Saved extension");
			expect(field("API key").value).toBe(SECRET_PLACEHOLDER);
			expect(button(saveKey).disabled).toBe(true);
			expect(button(actionKey).disabled).toBe(false);
			expect(container.textContent).not.toContain("Action complete");
			expect(list).not.toHaveBeenCalled();
			expect(save).not.toHaveBeenCalled();

			await typeInto(field("Extension label"), "Draft owned by second target");
			await click(button(saveKey));
			await until(() => save.mock.calls.length === 1, "second target save");
			expect(save).toHaveBeenCalledWith(nextTarget, pluginId, declaration.id, {
				schemaVersion: 1,
				schemaFingerprint: config().schemaFingerprint,
				expectedRevision: 7,
				expectedBindingRevision: config().bindingRevision,
				values: { label: "Draft owned by second target" },
				secrets: { apiKey: { operation: "keep" } },
			});
		});
	}

	test("retained selection requires confirmation and sends source and destination revisions", async () => {
		const destination = config({
			revision: 0,
			bindingRevision: "c".repeat(64),
			status: "incomplete",
			values: {},
			secrets: { apiKey: { isSet: false } },
		});
		seed(targetA, extension(targetA, destination));
		await render();
		expect(retained).not.toHaveBeenCalled();
		await click(button("providerSettings.retained"));
		await until(() => retained.mock.calls.length === 1, "retained providers request");
		expect(retained).toHaveBeenCalledWith(targetA, pluginId, declaration.id, undefined);
		expect(button("providerSettings.rebind").disabled).toBe(true);
		await click(button("providerSettings.rebind"));
		expect(confirm).not.toHaveBeenCalled();

		await selectRetained("retired-provider");
		expect(button("providerSettings.rebind").disabled).toBe(false);
		expect(rebind).not.toHaveBeenCalled();
		await click(button("providerSettings.rebind"));
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm).toHaveBeenCalledWith({
			title: i18n.t("providerSettings.rebindTitle"),
			message: i18n.t("providerSettings.moveMessage", {
				source: "retired-provider",
				target: targetA.id,
			}),
			confirmLabel: i18n.t("providerSettings.rebind"),
		});
		expect(rebind).not.toHaveBeenCalled();
		await answer(false);
		expect(rebind).not.toHaveBeenCalled();
		expect(field(i18n.t("providerSettings.retainedSelect")).value).toBe("retired-provider");

		await click(button("providerSettings.rebind"));
		expect(confirm).toHaveBeenCalledTimes(2);
		expect(rebind).not.toHaveBeenCalled();
		await answer(true);
		await until(() => rebind.mock.calls.length === 1, "confirmed rebind");
		expect(rebind).toHaveBeenCalledWith(targetA, pluginId, declaration.id, {
			expectedRevision: 0,
			schemaFingerprint: destination.schemaFingerprint,
			expectedBindingRevision: destination.bindingRevision,
			source: { targetId: "retired-provider", expectedRevision: 23 },
		});
		await until(
			() => findButton("providerSettings.rebind") === undefined,
			"retained chooser to close after success",
		);
		expect(save).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(action).not.toHaveBeenCalled();
	});

	test("core changes while rebind confirmation is pending prevent the confirmed write", async () => {
		const destination = config({
			revision: 0,
			status: "incomplete",
			values: {},
			secrets: { apiKey: { isSet: false } },
		});
		seed(targetA, extension(targetA, destination));
		await render();
		await click(button("providerSettings.retained"));
		await until(() => retained.mock.calls.length === 1, "retained providers request");
		await selectRetained("retired-provider");
		await click(button("providerSettings.rebind"));
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(rebind).not.toHaveBeenCalled();

		// Keep the same target mounted while its core settings become unsaved.
		// The already-open confirmation must not retain permission to write.
		await render(targetA, true);
		expect(container.textContent).toContain(i18n.t("providerSettings.unsavedCore"));
		expect(field("Extension label").disabled).toBe(true);
		expect(button(saveKey).disabled).toBe(true);
		expect(findButton("providerSettings.retained")).toBeUndefined();
		expect(findButton("providerSettings.rebind")).toBeUndefined();
		await answer(true);
		await act(async () => {
			// Drain mutation notifications before asserting the absence of an API call.
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(rebind).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(action).not.toHaveBeenCalled();

		await render(targetA);
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(rebind).not.toHaveBeenCalled();
	});

	for (const projection of ["public", "cached admin"] as const) {
		test(`non-admin users cannot write or inspect retained settings with a ${projection} view`, async () => {
			client.setQueryData(["auth", "me"], { id: "fixture-member", role: "user" });
			if (projection === "public") {
				seed(targetA, {
					pluginId,
					contributionId: declaration.id,
					title: declaration.title,
					config: { revision: 7, status: "ready", values: { label: "Saved extension" } },
				});
			}
			await render();
			expect(container.textContent).toContain(declaration.title);
			expect(findButton(actionKey)).toBeUndefined();
			expect(findButton("providerSettings.retained")).toBeUndefined();
			expect(findButton("providerSettings.rebind")).toBeUndefined();
			expect(findButton("providerSettings.delete")).toBeUndefined();
			expect(container.textContent).toContain("Saved extension");
			expect(container.querySelectorAll("input, textarea, select").length).toBe(0);
			expect(findButton(saveKey)).toBeUndefined();
			expect(container.textContent).not.toContain(SECRET_PLACEHOLDER);
			expect(save).not.toHaveBeenCalled();
			expect(remove).not.toHaveBeenCalled();
			expect(action).not.toHaveBeenCalled();
			expect(retained).not.toHaveBeenCalled();
			expect(rebind).not.toHaveBeenCalled();
			expect(confirm).not.toHaveBeenCalled();
			expect(fetchSpy).not.toHaveBeenCalled();
		});
	}
});
