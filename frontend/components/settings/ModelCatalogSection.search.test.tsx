import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MantineProvider, Select } from "@mantine/core";
import type { AutoModelInfo } from "@shared/auto-model";
import type { ModelDescription } from "@shared/model-catalog/schema/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next, { type i18n } from "i18next";
import { parseHTML } from "linkedom";
import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { modelCatalogKeys } from "../../hooks/useModelCatalog";
import { useAllModels } from "../../hooks/useModels";
import { modelCatalogApi } from "../../lib/api/model-catalog";
import commonEn from "../../locales/en/common.json";
import narratorEn from "../../locales/en/narrator.json";
import settingsEn from "../../locales/en/settings.json";
import OpenSessionModelSelect from "../outline/task-board/OpenSessionModelSelect";
import { ModelCatalogSection } from "./ModelCatalogSection";

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
let instance: i18n;
let originalFetch: typeof fetch;
let autoSpy: ReturnType<typeof spyOn<typeof modelCatalogApi, "autoModels">>;
let makeEvent: (type: string) => Event;
let setNativeValue: (input: HTMLInputElement, value: string) => void;
const globals = new Map<string, PropertyDescriptor | undefined>();
const patches: { target: object; key: string; descriptor: PropertyDescriptor | undefined }[] = [];
const frames = new Set<ReturnType<typeof setTimeout>>();
let selections: string[];
let latestModels: ReturnType<typeof useAllModels> | undefined;

const settings = {
	agent: {
		defaultModel: "auto:gpt-6-astra",
		summaryModel: "__default__",
		hiddenModels: ["edge:hidden-entry"],
		disabledProviders: [],
		autoExcludedProviders: [],
		customModels: [],
	},
	openaiProviders: [
		{ id: "edge-provider", prefix: "edge", name: "Example Cloud", apiKey: "test-key" },
		{ id: "disabled-provider", prefix: "disabled", name: "Disabled Cloud", disabled: true },
	],
	openaiModelsGrouped: [
		{
			providerId: "edge-provider",
			providerName: "Example Cloud",
			models: [{ id: "gpt-6-astra" }, { id: "hidden-entry" }],
		},
		{
			providerId: "disabled-provider",
			providerName: "Disabled Cloud",
			models: [{ id: "retired" }],
		},
	],
	nugProviders: [{ id: "nug-provider", prefix: "nug", name: "Gateway Hub", apiKey: "test-key" }],
	nugModelsGrouped: [
		{
			providerId: "nug-provider",
			providerName: "Gateway Hub",
			models: [{ id: "opaque-id", name: "Friendly card", model: "kimi-k3", channel: "moonshot" }],
		},
	],
};
const autoModels: AutoModelInfo[] = [
	{
		value: "auto:gpt-6-astra",
		modelId: "gpt-6-astra",
		name: "GPT 6 Astra",
		family: "gpt",
		sources: [
			{ value: "edge:gpt-6-astra", provider: "edge", available: true, subscription: false },
		],
	},
];

function patch(target: object, key: string, descriptor: PropertyDescriptor) {
	patches.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) });
	Object.defineProperty(target, key, { ...descriptor, configurable: true });
}

function installDom() {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	makeEvent = (type) => new window.Event(type, { bubbles: true });
	const inputProto = window.HTMLInputElement.prototype;
	const valueSetter = Object.getOwnPropertyDescriptor(inputProto, "value")?.set;
	if (!valueSetter) throw new Error("missing native input value setter");
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
	(window.document as unknown as Record<string, unknown>).oninput = null;
	const style = () =>
		new Proxy({}, { get: (_target, key) => (key === "getPropertyValue" ? () => "" : "") });
	const matchMedia = () => ({
		matches: false,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
	});
	const raf = (callback: FrameRequestCallback) => {
		const timer = setTimeout(() => {
			frames.delete(timer);
			callback(Date.now());
		}, 0);
		frames.add(timer);
		return timer;
	};
	const values: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
		Element: window.Element,
		Node: window.Node,
		Document: window.Document,
		ShadowRoot: class {},
		Event: window.Event,
		getComputedStyle: style,
		matchMedia,
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		requestAnimationFrame: raf,
		cancelAnimationFrame: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(values)) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	Object.assign(window, {
		getComputedStyle: style,
		matchMedia,
		requestAnimationFrame: raf,
		cancelAnimationFrame: values.cancelAnimationFrame,
	});
}

function description(model: string, catalogName: string, customized = false): ModelDescription {
	return {
		model,
		catalogName,
		matchedVia: "exact",
		modelWideEditable: true,
		effective: {},
		...(customized ? { connectionOverride: { nativeSearch: true } } : {}),
	};
}

beforeEach(async () => {
	originalFetch = globalThis.fetch;
	installDom();
	globalThis.fetch = Object.assign(
		async () => {
			throw new Error("unexpected network request");
		},
		{
			preconnect: () => {
				throw new Error("unexpected network preconnect");
			},
		},
	);
	autoSpy = spyOn(modelCatalogApi, "autoModels").mockResolvedValue({ models: autoModels });
	selections = [];
	latestModels = undefined;
	instance = i18next.createInstance();
	await instance.use(initReactI18next).init({
		lng: "en",
		fallbackLng: "en",
		defaultNS: "settings",
		resources: { en: { settings: settingsEn, narrator: narratorEn, common: commonEn } },
		react: { useSuspense: false },
	});
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	queryClient.setQueryData(["settings"], structuredClone(settings));
	queryClient.setQueryData(["auth", "me"], { id: "reader", role: "user" });
	queryClient.setQueryData(modelCatalogKeys.status, {
		version: "fixture",
		publishedAt: "2026-01-01T00:00:00Z",
		source: "builtin",
		models: 2,
		autoUpdate: false,
	});
	queryClient.setQueryData(
		modelCatalogKeys.model("edge:gpt-6-astra"),
		description("edge:gpt-6-astra", "Astral ultra"),
	);
	queryClient.setQueryData(
		modelCatalogKeys.model("nug:opaque-id"),
		description("nug:opaque-id", "Gateway friendly", true),
	);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	queryClient.clear();
	autoSpy.mockRestore();
	globalThis.fetch = originalFetch;
	container.remove();
	for (const timer of frames) clearTimeout(timer);
	frames.clear();
	for (const { target, key, descriptor } of patches.reverse()) {
		if (descriptor) Object.defineProperty(target, key, descriptor);
		else Reflect.deleteProperty(target, key);
	}
	patches.length = 0;
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});

async function render(node: ReactNode) {
	await act(async () =>
		root.render(
			<QueryClientProvider client={queryClient}>
				<I18nextProvider i18n={instance}>
					<MantineProvider env="test">{node}</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		),
	);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

async function type(input: HTMLInputElement | null, value: string) {
	if (!input) throw new Error("missing input");
	await act(async () => input.dispatchEvent(makeEvent("focusin")));
	await act(async () => {
		setNativeValue(input, value);
		input.dispatchEvent(makeEvent("input"));
		input.dispatchEvent(makeEvent("keyup"));
	});
}
function catalogInput() {
	return container.querySelector<HTMLInputElement>(
		`input[placeholder="${settingsEn.catalog.search}"]`,
	);
}
function rows() {
	return [...container.querySelectorAll("tbody tr")].map(
		(row) => row.querySelector("td")?.textContent ?? "",
	);
}
function pickerInput() {
	return container.querySelector<HTMLInputElement>('input[aria-label="model-picker"]');
}
function pickerOptions() {
	return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
}

function SelectorHarness() {
	const models = useAllModels();
	latestModels = models;
	const [value, setValue] = useState<string | null>(null);
	return (
		<Select
			aria-label="model-picker"
			data={models.groupedModels}
			filter={models.modelOptionsFilter}
			searchable
			value={value}
			onChange={(next) => {
				setValue(next);
				if (next) selections.push(next);
			}}
			comboboxProps={{ withinPortal: false }}
		/>
	);
}

describe("catalog search with real model hooks", () => {
	test("matches provider display names and combines them with catalog aliases", async () => {
		await render(<ModelCatalogSection />);
		await type(catalogInput(), "Example Cloud ULTRA");
		expect(rows()).toHaveLength(1);
		expect(rows()[0]).toContain("edge:gpt-6-astra");
		await type(catalogInput(), "ultra");
		expect(rows()).toHaveLength(1);
	});

	test("finds opaque gateway ids through bare model and channel metadata", async () => {
		await render(<ModelCatalogSection />);
		await type(catalogInput(), "MOONSHOT kimi-k3");
		expect(rows()).toHaveLength(1);
		expect(rows()[0]).toContain("nug:opaque-id");
		await type(catalogInput(), "Example Cloud kimi-k3");
		expect(rows()).toEqual([]);
	});

	test("clearing search restores only visible, enabled models", async () => {
		await render(<ModelCatalogSection />);
		await type(catalogInput(), "missing-model");
		expect(rows()).toEqual([]);
		await type(catalogInput(), "");
		expect(rows()).toHaveLength(2);
		expect(rows().join(" ")).not.toContain("hidden-entry");
		expect(rows().join(" ")).not.toContain("disabled:retired");
	});

	test("provider renaming refreshes the index without clearing the query", async () => {
		await render(<ModelCatalogSection />);
		await type(catalogInput(), "Example Cloud ultra");
		const next = structuredClone(settings);
		next.openaiProviders[0].name = "Renamed Cloud";
		next.openaiModelsGrouped[0].providerName = "Renamed Cloud";
		await act(async () => {
			queryClient.setQueryData(["settings"], next);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(rows()).toEqual([]);
		await type(catalogInput(), "Renamed Cloud ultra");
		expect(rows()).toHaveLength(1);
	});
});

describe("projected Mantine Select with real useAllModels", () => {
	test("recovers a bare model id and submits the original qualified value", async () => {
		await render(<SelectorHarness />);
		await type(pickerInput(), "kimi-k3");
		expect(pickerOptions()).toHaveLength(1);
		await act(async () => pickerOptions()[0].click());
		expect(selections).toEqual(["nug:opaque-id"]);
	});

	test("finds auto and both follow roles by their source provider", async () => {
		await render(<SelectorHarness />);
		expect(latestModels?.autoModels).toHaveLength(1);
		await type(pickerInput(), "Example Cloud gpt");
		expect(pickerOptions().map((option) => option.getAttribute("value"))).toEqual([
			"__default__",
			"__summary__",
			"auto:gpt-6-astra",
			"edge:gpt-6-astra",
		]);
		const auto = pickerOptions().find(
			(option) => option.getAttribute("value") === "auto:gpt-6-astra",
		);
		if (!auto) throw new Error("missing auto option");
		await act(async () => auto.click());
		expect(selections).toEqual(["auto:gpt-6-astra"]);
	});

	test("indexed hidden metadata cannot add hidden or disabled choices", async () => {
		await render(<SelectorHarness />);
		expect(latestModels?.allModels.some((model) => model.value === "edge:hidden-entry")).toBe(true);
		await type(pickerInput(), "hidden-entry");
		expect(pickerOptions()).toEqual([]);
		await type(pickerInput(), "Disabled Cloud");
		expect(pickerOptions()).toEqual([]);
	});
});

describe("task-board model picker with real useAllModels", () => {
	async function renderTaskPicker(value = "") {
		await render(
			<OpenSessionModelSelect
				label="Task model"
				value={value}
				onChange={(next) => selections.push(next)}
			/>,
		);
		return container.querySelector<HTMLInputElement>('[data-testid="task-open-session-model"]');
	}

	test("finds source display names across roles and auto rows without changing selection values", async () => {
		const input = await renderTaskPicker();
		await type(input, "Example Cloud gpt");
		expect(pickerOptions().map((option) => option.getAttribute("value"))).toEqual([
			"__default__",
			"__summary__",
			"auto:gpt-6-astra",
			"edge:gpt-6-astra",
		]);
		const auto = pickerOptions().find(
			(option) => option.getAttribute("value") === "auto:gpt-6-astra",
		);
		if (!auto) throw new Error("missing automatic model option");
		await act(async () => auto.click());
		expect(selections).toEqual(["auto:gpt-6-astra"]);
	});

	test("recovers opaque model metadata and keeps follow-default mapped to an empty value", async () => {
		const input = await renderTaskPicker("edge:gpt-6-astra");
		await type(input, "MOONSHOT kimi-k3");
		expect(pickerOptions().map((option) => option.getAttribute("value"))).toEqual([
			"nug:opaque-id",
		]);
		await act(async () => pickerOptions()[0].click());
		expect(selections).toEqual(["nug:opaque-id"]);
		await type(input, "Default");
		const follow = pickerOptions().find((option) => option.getAttribute("value") === "__default__");
		if (!follow) throw new Error("missing follow-default option");
		await act(async () => follow.click());
		expect(selections).toEqual(["nug:opaque-id", ""]);
	});
});
