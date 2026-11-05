import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { type ModelCard, modelCardView, type RawMetadata } from "@shared/model-catalog/card";
import type { ModelCardMutation } from "@shared/model-catalog/card-local";
import type { ModelCardSnapshot } from "@shared/model-catalog/schema/api";
import type { FieldSource } from "@shared/model-catalog/schema/catalog";
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
import type { CustomApiProtocol } from "../providers/types";
import {
	type CatalogEditorTarget,
	ModelCatalogEditor,
	type ModelProtocolDraft,
} from "./ModelCatalogEditor";

const snapshot: ModelCardSnapshot = {
	schemaVersion: 2,
	catalog: {
		schemaVersion: 2,
		catalogVersion: "v2:test-v1",
		sourceVersion: "test-v1",
		publishedAt: "2026-01-01T00:00:00Z",
		models: [
			{
				id: "base",
				metadata: {
					working_context_tokens: 1000,
					input_cost_per_token: "0.000002",
					output_cost_per_token: "0.000004",
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
function resolvedCard(
	metadata: RawMetadata,
	provenance: Record<string, FieldSource> = {},
	localRevision = 7,
): ModelCard {
	return {
		schemaVersion: 2,
		catalogVersion: "v2:test-v1",
		localRevision,
		matchedVia: "exact",
		modelId: "base",
		metadata,
		provenance,
		view: modelCardView(metadata),
	};
}
const resolved = resolvedCard(snapshot.catalog.models[0].metadata, {
	working_context_tokens: { layer: "preset-model", id: "base" },
	input_cost_per_token: { layer: "preset-model", id: "base" },
});
const i18n = i18next.createInstance();
let root: Root;
let qc: QueryClient;
let mutations: ModelCardMutation[];
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
	target: CatalogEditorTarget = { kind: "model", id: "base", card: resolved },
	protocol?: ModelProtocolDraft,
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
							protocol={protocol}
							onClose={() => {
								closed += 1;
							}}
						/>
					</QueryClientProvider>
				</MantineProvider>
			</I18nextProvider>,
		);
	});
	await waitFor(() => !!document.querySelector('[data-catalog-field="working_context_tokens"]'));
}

describe("real catalog editor form", () => {
	test("rendered values distinguish missing, explicit unknown, false, empty arrays and free prices", async () => {
		await render(true, {
			kind: "model",
			id: "base",
			card: resolvedCard({
				working_context_tokens: null,
				supports_web_search: false,
				supported_modalities: [],
				input_cost_per_token: "0",
				output_cost_per_token: 1.5e-5,
			}),
		});
		expect(field("working_context_tokens").textContent).toContain("Effective: Unknown");
		expect(field("max_output_tokens").textContent).toContain("Effective: Not reported / inherited");
		expect(field("supports_web_search").textContent).toContain("Effective: Not supported");
		expect(field("supported_modalities").textContent).toContain("[] (explicit empty)");
		await click(button("Reference prices"));
		expect(field("input_cost_per_token").textContent).toContain("0 (free)");
		// Stored per token, shown per million.
		expect(field("output_cost_per_token").textContent).toContain("Effective: 15");
	});
	test("new variants do not freeze inherited effective cards", async () => {
		await render(false, {
			kind: "variant",
			id: "new-variant",
			isNew: true,
			modelId: "base",
			query: { upstreamModelId: "opaque:upstream", providerKey: "public-provider" },
			card: resolved,
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
	test("binding 只保留协议编辑，不再写连接标识与模型资料", async () => {
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
		// 连接标识与资料那六个输入框已经从入口移除，只剩协议与一句说明。
		expect(document.body.textContent).toContain("edits the protocol only");
		await click(button("Save"));
		await waitFor(() => closed === 1);
		expect(mutations).toEqual([]);
	});
	test("blanking a price is invalid, not a free price or an inherited value", async () => {
		await render();
		await click(button("Reference prices"));
		await inputValue(field("input_cost_per_token").querySelector("input") as HTMLInputElement, "");
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
			["model-pricing"],
			["model-catalog", "card-actual", "provider:base"],
		])
			qc.setQueryData(key, { old: true });
		await render();
		await click(button("Unknown", field("working_context_tokens")));
		await click(button("Reference prices"));
		await waitFor(() => !!field("input_cost_per_token").querySelector("input"));
		await click(button("Inherit", field("input_cost_per_token")));
		await click(button("Save"));
		await waitFor(() => closed === 1);
		expect(mutations).toEqual([
			{
				baseRevision: 7,
				action: "patch",
				target: "model",
				targetId: "base",
				patch: { set: { working_context_tokens: null }, reset: ["input_cost_per_token"] },
			},
		]);
		for (const key of [
			["settings"],
			["model-pricing"],
			["model-catalog", "card-actual", "provider:base"],
		])
			expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
	});
	test("typing a free price remains a decimal string rather than null/reset", async () => {
		await render();
		await click(button("Reference prices"));
		await waitFor(() => !!field("input_cost_per_token").querySelector("input"));
		await inputValue(field("input_cost_per_token").querySelector("input") as HTMLInputElement, "0");
		await click(button("Save"));
		await waitFor(() => closed === 1);
		expect(mutations[0]).toEqual({
			baseRevision: 7,
			action: "patch",
			target: "model",
			targetId: "base",
			patch: { set: { input_cost_per_token: "0" } },
		});
	});
	test("a newer snapshot cannot silently rebase an older effective detail view", async () => {
		await render(false, { kind: "model", id: "base", card: { ...resolved, localRevision: 6 } });
		await click(button("Unknown", field("working_context_tokens")));
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
		await click(button("Unknown", field("working_context_tokens")));
		await click(button("Save"));
		await waitFor(() => document.body.textContent?.includes("snapshot is stale") ?? false);
		expect(closed).toBe(0);
		expect(button("Save").disabled).toBe(true);
		expect(mutations).toHaveLength(1);
		expect(field("working_context_tokens").textContent).toContain("Unknown");
	});
	test("read-only form has no save or per-field mutation controls", async () => {
		await render(true);
		expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Save")).toBe(
			false,
		);
		expect(field("working_context_tokens").querySelector("input")?.disabled).toBe(true);
		expect(mutations).toEqual([]);
	});
	test("keeps the protocol override on its own layer and inherits the provider value back", async () => {
		const saved: Array<CustomApiProtocol | null> = [];
		await render(
			false,
			{ kind: "binding", id: "binding-1", card: resolved },
			{
				modelValue: "CommandCode:demo-model",
				value: "completions-compatible",
				inheritedValue: "openai-responses",
				onSave: async (protocol) => {
					saved.push(protocol);
				},
			},
		);
		const text = () => document.body.textContent ?? "";
		expect(text()).toContain("Protocol");
		expect(text()).toContain("CommandCode:demo-model");
		// 本层有覆盖：有效值取本层，来源标为 Override（与「能力」字段同一套说法）。
		expect(text()).toContain("Legacy Completions Compatible");
		expect(text()).toContain("Override");
		// 下拉显示本层覆盖，不显示继承来的协议。
		const select = document.querySelector(
			'input[aria-label="Model protocol"]',
		) as HTMLInputElement | null;
		expect(select?.value).toBe("Legacy Completions Compatible");
		// 渲染本身不落库：协议只在点「保存」时经调用方写出。
		expect(saved).toEqual([]);

		// 「恢复继承」清掉本层覆盖 → 有效值回到 provider 层写的协议，保存时写出 null。
		await click(button("Inherit"));
		expect(text()).toContain("OpenAI Responses");
		expect(text()).toContain("Provider setting");
		expect(
			(document.querySelector('input[aria-label="Model protocol"]') as HTMLInputElement).value,
		).toBe("Use default");
		await click(button("Save"));
		await waitFor(() => saved.length === 1);
		expect(saved[0]).toBeNull();
	});

	test("omits the protocol field when the caller does not provide one", async () => {
		await render(true, { kind: "binding", id: "binding-1", card: resolved });
		expect(document.body.textContent ?? "").not.toContain("Applies to");
	});
});
