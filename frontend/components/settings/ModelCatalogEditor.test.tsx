import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type {
	ModelCatalogMutation,
	ModelCatalogSnapshot,
	ResolvedModelMetadata,
} from "@shared/model-catalog";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { modelCatalogKeys } from "../../hooks/useModelCatalog";
import { ApiError } from "../../lib/api/client";
import { modelCatalogApi } from "../../lib/api/model-catalog";
import settings from "../../locales/en/settings.json";
import { type CatalogEditorTarget, ModelCatalogEditor } from "./ModelCatalogEditor";

const snapshot: ModelCatalogSnapshot = {
	catalog: {
		schemaVersion: 1,
		catalogVersion: "test-v1",
		publishedAt: "2026-01-01T00:00:00Z",
		models: [
			{
				id: "base",
				metadata: {
					limits: { contextWindow: 1000 },
					referencePricing: { input: "2", output: "4" },
				},
			},
		],
		variants: [
			{
				id: "selected-variant",
				modelId: "base",
				providerKey: "public-provider",
				upstreamModelIds: ["opaque:model:unchanged"],
				metadata: {},
			},
		],
	},
	local: { revision: 7 },
	update: {
		activeVersion: "test-v1",
		bundledVersion: "test-v1",
		autoApply: false,
		pinnedVersion: null,
		history: [],
	},
};
const resolved: ResolvedModelMetadata = {
	schemaVersion: 1,
	catalogVersion: "test-v1",
	localRevision: 7,
	matchedVia: "exact",
	modelId: "base",
	metadata: snapshot.catalog.models[0].metadata,
	provenance: {
		"limits.contextWindow": { layer: "preset-model", id: "base" },
		"referencePricing.input": { layer: "preset-model", id: "base" },
	},
};
const i18n = i18next.createInstance();
let root: Root;
let qc: QueryClient;
let mutations: ModelCatalogMutation[];
let closed: number;
const originalApi = { ...modelCatalogApi };

async function waitFor(predicate: () => boolean) {
	const deadline = Date.now() + 2000;
	while (!predicate()) {
		if (Date.now() > deadline)
			throw new Error(`Timed out. DOM: ${document.body.textContent?.slice(-1000)}`);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
}
function button(text: string, within: ParentNode = document): HTMLButtonElement {
	const found = [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
	if (!found) throw new Error(`Missing button ${text}`);
	return found;
}
async function click(element: HTMLElement) {
	await act(async () => {
		element.dispatchEvent(new window.Event("click", { bubbles: true }));
	});
}
function field(path: string) {
	const node = document.querySelector(`[data-catalog-field="${path}"]`);
	if (!node) throw new Error(path);
	return node;
}
/** Drive React's actual input event boundary in linkedom (which lacks browser input tracking). */
async function inputValue(input: HTMLInputElement, value: string) {
	await act(async () => {
		input.dispatchEvent(new window.Event("focusin", { bubbles: true }));
	});
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
		if (setter) setter.call(input, value);
		else input.value = value;
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
		input.dispatchEvent(new window.Event("keyup", { bubbles: true }));
	});
}

beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const inputProto = window.HTMLInputElement.prototype;
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
	Object.defineProperties(inputProto, {
		attachEvent: { value: () => {}, configurable: true },
		detachEvent: { value: () => {}, configurable: true },
	});
	(window.document as unknown as Record<string, unknown>).oninput = null;
	const matchMedia = () => ({
		matches: false,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
	});
	class ResizeObserver {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	Object.assign(window, {
		matchMedia,
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		cancelAnimationFrame: clearTimeout,
	});
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
		HTMLButtonElement: window.HTMLButtonElement,
		Element: window.Element,
		Node: window.Node,
		ShadowRoot: window.ShadowRoot,
		Document: window.Document,
		Event: window.Event,
		ResizeObserver,
		getComputedStyle: () => ({
			getPropertyValue: () => "",
			paddingRight: "0px",
			paddingLeft: "0px",
			marginRight: "0px",
		}),
		requestAnimationFrame: window.requestAnimationFrame,
		cancelAnimationFrame: clearTimeout,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	if (!i18n.isInitialized)
		await i18n.use(initReactI18next).init({
			lng: "en",
			fallbackLng: "en",
			resources: { en: { settings } },
			interpolation: { escapeValue: false },
			react: { useSuspense: false },
		});
	mutations = [];
	closed = 0;
	qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	qc.setQueryData(modelCatalogKeys.snapshot, snapshot);
	modelCatalogApi.snapshot = async () => snapshot;
	modelCatalogApi.mutate = async (mutation) => {
		mutations.push(mutation);
		return { ...snapshot, local: { revision: 8 } };
	};
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	qc?.clear();
	Object.assign(modelCatalogApi, originalApi);
});

async function render(
	readOnly = false,
	target: CatalogEditorTarget = { kind: "model", id: "base", resolved },
) {
	await act(async () => {
		root.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider
					env="test"
					theme={{
						components: {
							Accordion: { defaultProps: { transitionDuration: 0 } },
							Modal: { defaultProps: { transitionProps: { duration: 0 } } },
						},
					}}
				>
					<QueryClientProvider client={qc}>
						<ModelCatalogEditor
							target={target}
							snapshot={snapshot}
							readOnly={readOnly}
							onClose={() => {
								closed += 1;
							}}
						/>
					</QueryClientProvider>
				</MantineProvider>
			</I18nextProvider>,
		);
	});
	await waitFor(() => !!document.querySelector('[data-catalog-field="limits.contextWindow"]'));
}

describe("real catalog editor form", () => {
	test("rendered values distinguish missing, explicit unknown, false, empty arrays and free prices", async () => {
		await render(true, {
			kind: "model",
			id: "base",
			resolved: {
				...resolved,
				metadata: {
					limits: { contextWindow: null },
					nativeSearch: { supported: false },
					modalities: { input: [] },
					referencePricing: { input: "0" },
				},
			},
		});
		expect(field("limits.contextWindow").textContent).toContain("Effective: Unknown");
		expect(field("limits.maxOutputTokens").textContent).toContain(
			"Effective: Not reported / inherited",
		);
		expect(field("nativeSearch.supported").textContent).toContain("Effective: Not supported");
		expect(field("modalities.input").textContent).toContain("[] (explicit empty)");
		await click(button("Reference prices"));
		expect(field("referencePricing.input").textContent).toContain("0 (free)");
	});
	test("new variants do not freeze inherited effective cards", async () => {
		await render(false, {
			kind: "variant",
			id: "new-variant",
			isNew: true,
			modelId: "base",
			query: { upstreamModelId: "opaque:upstream", providerKey: "public-provider" },
			resolved,
		});
		await click(button("Save"));
		await waitFor(() => closed === 1);
		expect(mutations[0]).toEqual({
			baseRevision: 7,
			action: "upsert-variant",
			variant: {
				id: "new-variant",
				modelId: "base",
				providerKey: "public-provider",
				upstreamModelIds: ["opaque:upstream"],
				name: undefined,
				metadata: {},
			},
		});
	});
	test("new bindings keep an exact selected variant and opaque connection scope", async () => {
		await render(false, {
			kind: "binding",
			id: "connection-a",
			isNew: true,
			variantId: "selected-variant",
			query: {
				upstreamModelId: "opaque:model:unchanged",
				providerId: "provider-a",
				channelId: "channel-a",
			},
		});
		await click(button("Save"));
		await waitFor(() => closed === 1);
		expect(mutations[0]).toEqual({
			baseRevision: 7,
			action: "upsert-binding",
			binding: {
				id: "connection-a",
				upstreamModelId: "opaque:model:unchanged",
				providerId: "provider-a",
				channelId: "channel-a",
				variantId: "selected-variant",
				overrides: {},
			},
		});
	});
	test("blanking a price is invalid, not a free price or an inherited value", async () => {
		await render();
		await click(button("Reference prices"));
		await inputValue(
			field("referencePricing.input").querySelector("input") as HTMLInputElement,
			"",
		);
		await click(button("Save"));
		expect(closed).toBe(0);
		expect(mutations).toEqual([]);
		expect(document.body.textContent).toContain("Invalid field");
	});
	test("open and save unchanged performs no API mutation", async () => {
		await render();
		await click(button("Save"));
		await waitFor(() => closed === 1);
		expect(mutations).toEqual([]);
	});
	test("unknown and reset produce only leaf operations and invalidate every consumer", async () => {
		for (const key of [
			["settings"],
			["model-cards"],
			["model-pricing"],
			["model-catalog", "actual", "provider:base"],
		])
			qc.setQueryData(key, { old: true });
		await render();
		await click(button("Unknown", field("limits.contextWindow")));
		await click(button("Reference prices"));
		await waitFor(() => !!field("referencePricing.input").querySelector("input"));
		await click(button("Inherit", field("referencePricing.input")));
		await click(button("Save"));
		await waitFor(() => closed === 1);
		expect(mutations).toEqual([
			{
				baseRevision: 7,
				action: "patch",
				target: "model",
				targetId: "base",
				patch: { set: { "limits.contextWindow": null }, reset: ["referencePricing.input"] },
			},
		]);
		for (const key of [
			["settings"],
			["model-cards"],
			["model-pricing"],
			["model-catalog", "actual", "provider:base"],
		])
			expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
	});
	test("typing a free price remains a decimal string rather than null/reset", async () => {
		await render();
		await click(button("Reference prices"));
		await waitFor(() => !!field("referencePricing.input").querySelector("input"));
		await inputValue(
			field("referencePricing.input").querySelector("input") as HTMLInputElement,
			"0",
		);
		await click(button("Save"));
		await waitFor(() => closed === 1);
		expect(mutations[0]).toEqual({
			baseRevision: 7,
			action: "patch",
			target: "model",
			targetId: "base",
			patch: { set: { "referencePricing.input": "0" } },
		});
	});
	test("a newer snapshot cannot silently rebase an older effective detail view", async () => {
		await render(false, { kind: "model", id: "base", resolved: { ...resolved, localRevision: 6 } });
		await click(button("Unknown", field("limits.contextWindow")));
		await click(button("Save"));
		await waitFor(() => closed === 1);
		expect(mutations[0].baseRevision).toBe(6);
	});
	test("409 keeps the editor and draft open and refuses blind replay", async () => {
		modelCatalogApi.mutate = async (mutation) => {
			mutations.push(mutation);
			throw new ApiError("stale", 409);
		};
		await render();
		await click(button("Unknown", field("limits.contextWindow")));
		await click(button("Save"));
		await waitFor(() => document.body.textContent?.includes("snapshot is stale") ?? false);
		expect(closed).toBe(0);
		expect(button("Save").disabled).toBe(true);
		expect(mutations).toHaveLength(1);
		expect(field("limits.contextWindow").textContent).toContain("Unknown");
	});
	test("read-only form has no save or per-field mutation controls", async () => {
		await render(true);
		expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Save")).toBe(
			false,
		);
		expect(field("limits.contextWindow").querySelector("input")?.disabled).toBe(true);
		expect(mutations).toEqual([]);
	});
});
