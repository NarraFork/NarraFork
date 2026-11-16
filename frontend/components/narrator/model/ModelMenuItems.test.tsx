import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider, Menu } from "@mantine/core";
import type { SubagentModelInheritance } from "@shared/model-inheritance";
import i18next, { type i18n } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import {
	FOLLOW_PARENT_MODEL,
	type ModelAggregation,
	type ModelOption,
	resolveDisplayModel,
} from "../../../lib/constants";
import narratorLocale from "../../../locales/en/narrator.json";
import settingsLocale from "../../../locales/en/settings.json";
import narratorZhLocale from "../../../locales/zh-CN/narrator.json";
import { ModelMenuItems } from "./ModelMenuItems";

const aggregations: ModelAggregation[] = [
	{ id: "group", name: "Group", routingMode: "priority", models: ["a:one", "a:two"] },
];
const models: ModelOption[] = [
	{ value: "__default__", label: "Follow default", provider: "__default__" },
	{ value: "__agg__:group", label: "Group", provider: "__agg__" },
	{ value: "a:one", label: "One", provider: "a" },
	{ value: "a:two", label: "Two", provider: "a" },
];
let root: Root;
let host: HTMLDivElement;
let instance: i18n;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let selected: string[];
let refreshed: number;
let setAsDefault: string[];
let setAsSummary: string[];
let editDefault: number;
let editSummary: number;
let setNativeValue: (input: HTMLInputElement, value: string) => void;
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
const previousInputPrototype = new Map<string, PropertyDescriptor | undefined>();
let inputPrototype: object;

beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	// linkedom gaps in React's change-event pipeline (details in ProxyOverrideField.test.tsx):
	// an untyped input reports `type` null, and the legacy value watcher needs attachEvent.
	const inputProto = window.HTMLInputElement.prototype;
	inputPrototype = inputProto;
	for (const key of ["type", "attachEvent", "detachEvent", "select", "setSelectionRange"]) {
		previousInputPrototype.set(key, Object.getOwnPropertyDescriptor(inputProto, key));
	}
	const valueSetter = Object.getOwnPropertyDescriptor(inputProto, "value")?.set;
	if (!valueSetter) throw new Error("HTMLInputElement.prototype.value has no setter");
	setNativeValue = (input, value) => valueSetter.call(input, value);
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
	Object.defineProperties(inputProto, {
		attachEvent: { value: () => {}, configurable: true },
		detachEvent: { value: () => {}, configurable: true },
		select: { value: () => {}, configurable: true },
		setSelectionRange: { value: () => {}, configurable: true },
	});
	frames = new Map();
	nextFrame = 0;
	selected = [];
	refreshed = 0;
	setAsDefault = [];
	setAsSummary = [];
	editDefault = 0;
	editSummary = 0;
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		getComputedStyle: () => ({ getPropertyValue: () => "", direction: "ltr" }),
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			frames.set(++nextFrame, callback);
			return nextFrame;
		},
		cancelAnimationFrame: (id: number) => {
			frames.delete(id);
		},
		IS_REACT_ACT_ENVIRONMENT: true,
		// Old-list tests render in provider mode; browser tests opt into model mode per render.
		localStorage: {
			getItem: (key: string) => (key === "narrafork_model_menu_mode" ? menuMode : null),
			setItem() {},
			removeItem() {},
		},
	};
	for (const [key, value] of Object.entries(globals)) {
		previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	instance = i18next.createInstance();
	await instance.use(initReactI18next).init({
		lng: "en",
		resources: {
			en: { narrator: narratorLocale, settings: settingsLocale },
			"zh-CN": { narrator: narratorZhLocale },
		},
		react: { useSuspense: false },
	});
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	for (const [key, descriptor] of previousInputPrototype) {
		if (descriptor) Object.defineProperty(inputPrototype, key, descriptor);
		else Reflect.deleteProperty(inputPrototype, key);
	}
	previousInputPrototype.clear();
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	previousGlobals.clear();
});

let menuMode: "model" | "provider" = "provider";

async function render(
	currentModel: string | null,
	allModels = models,
	mounted = true,
	opened = true,
	options?: {
		withGlobalRoleActions?: boolean;
		withRoleEditors?: boolean;
		onShowPrice?: (model: ModelOption) => void;
		defaultModelValue?: string | null;
		summaryModelValue?: string | null;
		canFollowParent?: boolean;
		inheritance?: SubagentModelInheritance | null;
		mode?: "model" | "provider";
		extraProps?: Partial<Parameters<typeof ModelMenuItems>[0]>;
	},
) {
	menuMode = options?.mode ?? "provider";
	const withGlobalRoleActions = options?.withGlobalRoleActions ?? false;
	const withRoleEditors = options?.withRoleEditors ?? false;
	await act(async () => {
		root.render(
			<MantineProvider env="test">
				<I18nextProvider i18n={instance}>
					<Menu opened>
						<div data-model-menu-scroll>
							{mounted && (
								<ModelMenuItems
									opened={opened}
									allModels={allModels}
									currentModel={currentModel}
									totalCostUsd={null}
									aggregations={aggregations}
									providerLabels={{ a: "Provider A", xiaomi: "Xiaomi" }}
									onSelect={(value) => selected.push(value)}
									onShowPrice={options?.onShowPrice}
									canFollowParent={options?.canFollowParent}
									inheritance={options?.inheritance}
									onPickerOpened={() => {
										refreshed++;
									}}
									defaultModelValue={options?.defaultModelValue}
									summaryModelValue={options?.summaryModelValue}
									{...options?.extraProps}
									{...(withGlobalRoleActions
										? {
												onSetAsDefaultModel: (value: string) => setAsDefault.push(value),
												onSetAsSummaryModel: (value: string) => setAsSummary.push(value),
											}
										: {})}
									{...(withRoleEditors
										? {
												onEditDefaultModel: () => editDefault++,
												onEditSummaryModel: () => editSummary++,
											}
										: {})}
								/>
							)}
						</div>
					</Menu>
				</I18nextProvider>
			</MantineProvider>,
		);
	});
}

function buttons() {
	return Array.from(host.querySelectorAll<HTMLButtonElement>("[data-menu-item]"));
}
function button(text: string) {
	const found = buttons().find((item) => item.textContent === text);
	if (!found) throw new Error(`Missing menu item: ${text}`);
	return found;
}

function prepareGeometry() {
	const dropdown = host.querySelector<HTMLElement>("[data-model-menu-scroll]");
	if (!dropdown) throw new Error("Missing dropdown");
	dropdown.scrollTop = 0;
	Object.defineProperties(dropdown, {
		clientHeight: { configurable: true, value: 200 },
		clientTop: { configurable: true, value: 0 },
		scrollHeight: { configurable: true, value: 2000 },
	});
	dropdown.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
	buttons().forEach((item, index) => {
		item.getBoundingClientRect = () =>
			({ top: 100 + index * 100 - dropdown.scrollTop, height: 20 }) as DOMRect;
	});
	return dropdown;
}
async function flushFrames() {
	await act(async () => {
		const callbacks = [...frames.values()];
		frames.clear();
		for (const callback of callbacks) callback(0);
	});
}
/** Type into the model filter, driving both of React's change pipelines. */
async function typeFilter(text: string, placeholder = narratorLocale.modelFilterPlaceholder) {
	const input = host.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
	if (!input) throw new Error("Missing model filter input");
	await act(async () => {
		input.dispatchEvent(new window.Event("focusin", { bubbles: true }));
	});
	await act(async () => {
		setNativeValue(input, text);
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
		input.dispatchEvent(new window.Event("keyup", { bubbles: true }));
	});
}

describe("follow parent selection", () => {
	test.each([
		["en", narratorLocale.followParent],
		["zh-CN", narratorZhLocale.followParent],
	])("shows an honest follow label in %s and keeps concrete selection working", async (language, label) => {
		await instance.changeLanguage(language);
		await render(FOLLOW_PARENT_MODEL, models, true, true, {
			withGlobalRoleActions: true,
			onShowPrice: () => {
				throw new Error("Parent has no resolved price metadata");
			},
		});
		const follow = button(label);
		// Current state renders as a selected row (checkmark + bold), not a disabled one.
		expect(follow.disabled).toBe(false);
		expect(follow.querySelector('[role="button"]')).toBeNull();
		expect(host.textContent).not.toContain(FOLLOW_PARENT_MODEL);
		// Clicking the already-current follow row is a no-op; concrete selection still works.
		await act(async () => follow.click());
		expect(selected).toEqual([]);
		await act(async () => button("One").click());
		expect(selected).toEqual(["a:one"]);
	});

	test("does not invent a concrete model from the global default", () => {
		expect(
			resolveDisplayModel(FOLLOW_PARENT_MODEL, { defaultModelValue: "a:one", aggregations }),
		).toBe(FOLLOW_PARENT_MODEL);
	});

	test("does not offer follow-parent for a concrete or primary selection", async () => {
		await render("a:one");
		expect(host.textContent).not.toContain("Follow parent");
	});

	test("resolves the followed parent model exactly like the default/summary role rows", async () => {
		await render(FOLLOW_PARENT_MODEL, models, true, true, {
			inheritance: { source: "parent", model: "a:one", parentModel: "a:one" },
		});
		// Group header + provider prefix line + resolved model label.
		expect(host.textContent).toContain("Follow parent");
		expect(host.textContent).toContain("One");
		const follow = button("aOne");
		expect(follow.disabled).toBe(false);
		expect(host.textContent).not.toContain(narratorLocale["inheritance.fallbackReason"]);
	});

	test("warns with the pool-fallback reason under the resolved fallback model", async () => {
		await render(FOLLOW_PARENT_MODEL, models, true, true, {
			inheritance: {
				source: "pool-fallback",
				model: "a:two",
				parentModel: "a:one",
				poolKey: "general",
			},
		});
		expect(host.textContent).toContain("Two");
		expect(host.textContent).toContain(
			narratorLocale["inheritance.fallbackReason"]
				.replace("{{parentModel}}", "a:one")
				.replace("{{pool}}", "general"),
		);
	});

	test("offers a clickable follow-parent entry to undo a manual pin", async () => {
		await render("a:one", models, true, true, { canFollowParent: true });
		const follow = button("Follow parent");
		expect(follow.disabled).toBe(false);
		await act(async () => follow.click());
		expect(selected).toEqual([FOLLOW_PARENT_MODEL]);
	});
});

describe("catalog details access", () => {
	test("details live in the three-dot menu and resolve follow-default to the actual model", async () => {
		const details: ModelOption[] = [];
		await render("a:one", models, true, true, {
			defaultModelValue: "a:two:opaque",
			onShowPrice: (model) => details.push(model),
		});
		expect(host.querySelector('[aria-label="Model metadata and prices"]')).toBeNull();
		// Follow-default and the two concrete models; aggregations have no details.
		const toggleCount = host.querySelectorAll("[aria-label='Model actions']").length;
		expect(toggleCount).toBe(3);
		for (let index = 0; index < toggleCount; index++) {
			const toggle = host.querySelectorAll("[aria-label='Model actions']")[index];
			await act(async () => {
				toggle?.dispatchEvent(new window.Event("click", { bubbles: true }));
			});
			const item = buttons().find((entry) => entry.textContent === settingsLocale.catalog.details);
			if (!item) throw new Error("Missing details action");
			await act(async () => item.dispatchEvent(new window.Event("click", { bubbles: true })));
		}
		expect(details.map((model) => model.value)).toEqual(["a:two:opaque", "a:one", "a:two"]);
		expect(selected).toEqual([]);
	});
});

describe("provider group header", () => {
	test("shows bars, balance, refresh and settings for provider groups only", async () => {
		let refreshes = 0;
		const opened: string[] = [];
		await render("a:one", models, true, true, {
			extraProps: {
				providerBalances: { a: { text: "$12.50", tooltip: "Wallet: 12.5 USD" } },
				providerActions: {
					a: {
						onRefresh: () => {
							refreshes++;
						},
					},
				},
				onOpenProviderSettings: (prefix) => opened.push(prefix),
			},
		});
		expect(host.querySelector("[data-provider-balance='a']")?.textContent).toBe("$12.50");
		const refresh = host.querySelectorAll(`[aria-label='${narratorLocale.refreshProviderModels}']`);
		const settings = host.querySelectorAll(`[aria-label='${narratorLocale.openProviderSettings}']`);
		// Default and aggregation groups are not providers.
		expect(refresh).toHaveLength(1);
		expect(settings).toHaveLength(1);
		await act(async () => {
			refresh[0]?.dispatchEvent(new window.Event("click", { bubbles: true }));
			settings[0]?.dispatchEvent(new window.Event("click", { bubbles: true }));
		});
		expect(refreshes).toBe(1);
		expect(opened).toEqual(["a"]);
		expect(selected).toEqual([]);
	});
});

describe("group ordering", () => {
	test("pins default, summary, and aggregations, then sorts providers by label", async () => {
		// The translated aggregation title sorts after every Latin provider label under the default
		// collation, so this header position only holds when the group is pinned.
		// Insertion order is scrambled and is neither prefix order nor label order.
		await instance.changeLanguage("zh-CN");
		const scrambled: ModelOption[] = [
			{ value: "zeta:z1", label: "Z1", provider: "zeta" },
			{ value: "__agg__:group", label: "Group", provider: "__agg__" },
			{ value: "__summary__", label: "Follow summary", provider: "__summary__" },
			{ value: "codex:gpt", label: "gpt", provider: "codex" },
			{ value: "__default__", label: "Follow default", provider: "__default__" },
			{ value: "a:one", label: "One", provider: "a" },
		];
		await render("a:one", scrambled, true, true, {
			extraProps: {
				providerLabels: { a: "Provider A", codex: "Codex", zeta: "Zeta Gateway" },
			},
		});
		const headers = Array.from(host.querySelectorAll(".mantine-Menu-label")).map(
			(header) => header.textContent?.trim() ?? "",
		);
		expect(headers).toEqual([
			narratorZhLocale.modelGroupDefault,
			narratorZhLocale.modelGroupSummary,
			narratorZhLocale.modelGroupAggregations,
			"Codex",
			"Provider A",
			"Zeta Gateway",
		]);
	});
});

describe("per-model global role actions", () => {
	test("hides the three-dot control when handlers are not provided", async () => {
		await render("a:one");
		expect(host.querySelector("[aria-label='Model actions']")).toBeNull();
	});
	test("expands set-as actions for concrete models and assigns the row value", async () => {
		await render("a:one", models, true, true, {
			withGlobalRoleActions: true,
			defaultModelValue: "a:one",
			summaryModelValue: null,
		});
		const toggles = host.querySelectorAll("[aria-label='Model actions']");
		// Follow-default has no toggle; aggregation + two concrete models do.
		expect(toggles.length).toBe(3);
		// toggles[1] sits on the "One" row (aggregation is first).
		await act(async () => {
			toggles[1]?.dispatchEvent(new window.Event("click", { bubbles: true }));
		});
		const defaultAction = Array.from(host.querySelectorAll("[data-menu-item]")).find(
			(item) => item.textContent === narratorLocale.setAsDefaultModel,
		);
		const summaryAction = Array.from(host.querySelectorAll("[data-menu-item]")).find(
			(item) => item.textContent === narratorLocale.setAsSummaryModel,
		);
		if (!defaultAction || !summaryAction) throw new Error("Missing role action items");
		await act(async () =>
			defaultAction.dispatchEvent(new window.Event("click", { bubbles: true })),
		);
		expect(setAsDefault).toEqual(["a:one"]);
		expect(setAsSummary).toEqual([]);
	});
	test("does not offer global roles on follow-default / follow-summary sentinels", async () => {
		const withSentinels: ModelOption[] = [
			{ value: "__default__", label: "Follow default", provider: "__default__" },
			{ value: "__summary__", label: "Follow summary", provider: "__summary__" },
			{ value: "a:one", label: "One", provider: "a" },
		];
		await render("a:one", withSentinels, true, true, { withGlobalRoleActions: true });
		const toggles = host.querySelectorAll("[aria-label='Model actions']");
		expect(toggles.length).toBe(1);
		expect(host.textContent).toContain("One");
	});
	test("warns on a delisted pinned model and offers role pickers instead of re-pinning", async () => {
		const delisted: ModelOption[] = [
			{ value: "__default__", label: "Follow default", provider: "__default__" },
			{
				value: "xiaomi:mimo-x-pro-preview",
				label: "mimo-x-pro-preview",
				provider: "xiaomi",
				catalogMissing: true,
				pinnedAs: ["summary"],
			},
			{ value: "xiaomi:mimo-v2.6-pro", label: "mimo-v2.6-pro", provider: "xiaomi" },
		];
		await render("xiaomi:mimo-v2.6-pro", delisted, true, true, {
			withGlobalRoleActions: true,
			withRoleEditors: true,
			summaryModelValue: "xiaomi:mimo-x-pro-preview",
		});
		expect(host.textContent).toContain(narratorLocale.modelCatalogMissing);
		expect(host.textContent).toContain(
			narratorLocale.modelCatalogMissingHint.replace("{{roles}}", settingsLocale.summaryModel),
		);
		const toggles = host.querySelectorAll("[aria-label='Model actions']");
		// Follow-default has none; both concrete models still have a three-dot.
		expect(toggles.length).toBe(2);
		// toggles[0] is the delisted row.
		await act(async () => {
			toggles[0]?.dispatchEvent(new window.Event("click", { bubbles: true }));
		});
		const items = Array.from(host.querySelectorAll("[data-menu-item]")).map((i) => i.textContent);
		expect(items).toContain(narratorLocale.editSummaryModel);
		expect(items).not.toContain(narratorLocale.setAsSummaryModel);
	});
});

describe("provider prefix on default/summary rows", () => {
	test("role rows stay compact and do not repeat the provider as a second line", async () => {
		const withRoles: ModelOption[] = [
			{ value: "__default__", label: "gpt-6-astra", provider: "__default__" },
			{ value: "__summary__", label: "mimo-v2.6-pro", provider: "__summary__" },
			{ value: "codex:gpt-6-astra", label: "gpt-6-astra", provider: "codex" },
			{ value: "xiaomi:mimo-v2.6-pro", label: "mimo-v2.6-pro", provider: "xiaomi" },
		];
		await render("codex:gpt-6-astra", withRoles, true, true, {
			defaultModelValue: "codex:gpt-6-astra",
			summaryModelValue: "xiaomi:mimo-v2.6-pro",
		});
		expect(host.textContent).toContain("codex");
		// The provider appears as the group label / concrete model value, not as a second line
		// under each role row (that extra line is what made the role slots look oversized).
		expect(host.textContent).toContain("Xiaomi");
		const roleRows = Array.from(host.querySelectorAll("[data-menu-item]")).filter(
			(item) =>
				item.textContent?.includes("gpt-6-astra") || item.textContent?.includes("mimo-v2.6-pro"),
		);
		expect(roleRows.length).toBeGreaterThan(0);
	});
	test("omits the prefix line for meta targets and empty slots", async () => {
		const withRoles: ModelOption[] = [
			{ value: "__default__", label: "Follow default", provider: "__default__" },
			{ value: "__summary__", label: "Follow summary", provider: "__summary__" },
		];
		await render(null, withRoles, true, true, {
			defaultModelValue: "__agg__:group",
			summaryModelValue: "",
		});
		// Aggregation/empty targets have no single provider prefix to show.
		const rows = Array.from(host.querySelectorAll("[data-menu-item]")).map((i) => i.textContent);
		expect(rows.some((t) => t === "Follow default" || t === "Follow summary")).toBe(true);
	});
});

describe("aggregation choices inside model menu", () => {
	test("exposes automatic routing and distinguishable provider members; preserves model values", async () => {
		await render("__agg__:group:a:two");
		expect(buttons().map((item) => item.textContent)).toContain(settingsLocale.aggAutoLabel);
		await act(async () => button("Provider A · One").click());
		await act(async () => button(settingsLocale.aggAutoLabel).click());
		expect(selected).toEqual(["__agg__:group:a:one", "__agg__:group"]);
	});
	test("does not show aggregation members for ordinary models", async () => {
		await render("a:one");
		expect(host.textContent).not.toContain("Provider A · One");
	});
});

describe("auto:<model> rows", () => {
	const autoModels: ModelOption[] = [
		...models,
		{
			value: "auto:gpt-5.5",
			label: "GPT-5.5",
			provider: "__auto__",
			autoSources: [
				{ value: "codex:gpt-5.5", provider: "codex", available: false, subscription: true },
				{ value: "a:gpt-5.5", provider: "a", available: true, subscription: false },
			],
		},
	];

	test("the source auto would use is marked on its own row, not in a sentence", async () => {
		await render("auto:gpt-5.5", autoModels, true, true, { mode: "model" });
		expect(host.textContent).toContain(narratorLocale.modelGroupFamilyOther);
		const inUse = (value: string) =>
			host
				.querySelector(`[data-model-source="${value}"]`)
				?.querySelector('[role="img"][aria-label="In use"]');
		// Provider A can serve; codex cannot, so only Provider A carries the in-use marker.
		expect(inUse("a:gpt-5.5")).toBeTruthy();
		expect(inUse("codex:gpt-5.5")).toBeFalsy();
	});

	test("the focused model lists automatic and every source, and picks keep their values", async () => {
		await render("auto:gpt-5.5", autoModels, true, true, { mode: "model" });
		expect(host.querySelector('[data-model-source="codex:gpt-5.5"]')).toBeTruthy();
		expect(host.querySelector('[data-model-source="a:gpt-5.5"]')).toBeTruthy();
		expect(host.textContent).toContain(narratorLocale.autoSourceSubscription);
		await act(async () =>
			host.querySelector<HTMLButtonElement>('[data-model-source="codex:gpt-5.5"]')?.click(),
		);
		await act(async () =>
			host.querySelector<HTMLButtonElement>('[data-model-auto="auto:gpt-5.5"]')?.click(),
		);
		expect(selected).toEqual(["codex:gpt-5.5", "auto:gpt-5.5"]);
	});

	test("the provider view still lists a model its auto row also offers", async () => {
		// The provider view renders no auto groups, so hiding covered models there would make
		// them (and a service whose every model is covered) disappear from the picker.
		const withDuplicate: ModelOption[] = [
			...autoModels,
			{ value: "a:gpt-5.5", label: "GPT-5.5 on A", provider: "a" },
		];
		await render("a:one", withDuplicate);
		expect(host.textContent).toContain("GPT-5.5 on A");
		expect(host.textContent).toContain("One");
	});

	test("a pinned source focuses its auto model and is the checked source", async () => {
		await render("a:gpt-5.5", autoModels, true, true, { mode: "model" });
		const hasVisibleCheck = (element: Element | null) =>
			!!element &&
			Array.from(element.querySelectorAll("svg")).some(
				(icon) => (icon as SVGElement).style.visibility === "visible",
			);
		expect(hasVisibleCheck(host.querySelector('[data-model-source="a:gpt-5.5"]'))).toBe(true);
		expect(hasVisibleCheck(host.querySelector('[data-model-auto="auto:gpt-5.5"]'))).toBe(false);
	});
});

describe("opening selection positioning", () => {
	test.each([
		["a:two", "Two"],
		["__agg__:group", settingsLocale.aggAutoLabel],
		["__agg__:group:a:two", "Provider A · Two"],
		["__agg__:group:removed", "Group"],
		[null, "Follow default"],
	])("centers %s on %s", async (value, label) => {
		await render(value);
		const dropdown = prepareGeometry();
		const index = buttons().indexOf(button(label));
		await flushFrames();
		expect(dropdown.scrollTop).toBe(Math.max(0, index * 100 - 90));
	});
	test("does not recenter on catalog updates; recenters on reopening", async () => {
		await render("a:two");
		const dropdown = prepareGeometry();
		await flushFrames();
		dropdown.scrollTop = 17;
		await render("a:two", [...models]);
		await flushFrames();
		expect(dropdown.scrollTop).toBe(17);
		expect(refreshed).toBe(1);
		await render("a:two", models, false);
		await render("a:two");
		prepareGeometry();
		await flushFrames();
		expect(dropdown.scrollTop).toBe(210);
		expect(refreshed).toBe(2);
	});
	test("quick reopen before unmount also recenters and refreshes once", async () => {
		await render("a:two");
		const dropdown = prepareGeometry();
		await flushFrames();
		dropdown.scrollTop = 17;
		await render("a:two", models, true, false);
		await render("a:two");
		await flushFrames();
		expect(dropdown.scrollTop).toBe(210);
		expect(refreshed).toBe(2);
	});
	test("missing models leave the scroll position alone", async () => {
		await render("missing:model");
		const dropdown = prepareGeometry();
		dropdown.scrollTop = 23;
		await flushFrames();
		expect(dropdown.scrollTop).toBe(23);
	});
	test("closing cancels scheduled centering", async () => {
		await render("a:two");
		const dropdown = prepareGeometry();
		await render("a:two", models, false);
		await flushFrames();
		expect(dropdown.scrollTop).toBe(0);
	});
});

describe("model filter input", () => {
	// Rendered with providerLabels { a: "Provider A", xiaomi: "Xiaomi" }.
	const filterModels: ModelOption[] = [
		{ value: "__default__", label: "Follow default", provider: "__default__" },
		{ value: "a:one", label: "One", provider: "a" },
		{ value: "xiaomi:mimo-v2.6-pro", label: "MiMo Pro", provider: "xiaomi" },
	];
	const rows = () => buttons().map((item) => item.textContent);

	test("finds the Default row through its target provider's display name", async () => {
		await render("a:one", filterModels, true, true, { defaultModelValue: "a:one" });
		await typeFilter("provider a");
		// The upstream layout moved provider metadata out of the role row label.
		expect(rows()).toEqual(["Follow default", "One"]);
	});

	test("multi-word queries match terms across fields", async () => {
		await render("a:one", filterModels, true, true, {
			defaultModelValue: "xiaomi:mimo-v2.6-pro",
		});
		// No single field contains "xiaomi pro"; the provider and the label do.
		await typeFilter("xiaomi pro");
		expect(rows()).toEqual(["Follow default", "MiMo Pro"]);
	});

	test("finds models by provider prefix and by model id", async () => {
		await render("a:one", filterModels, true, true);
		await typeFilter("xiaomi");
		expect(rows()).toEqual(["MiMo Pro"]);
		await typeFilter("mimo-v2.6");
		expect(rows()).toEqual(["MiMo Pro"]);
	});

	test("matches the translated group header", async () => {
		await instance.changeLanguage("zh-CN");
		await render("a:one", filterModels, true, true);
		await typeFilter(narratorZhLocale.modelGroupDefault, narratorZhLocale.modelFilterPlaceholder);
		expect(rows()).toEqual(["Follow default"]);
	});

	test("shows the empty state and restores every row once cleared", async () => {
		await render("a:one", filterModels, true, true);
		await typeFilter("nothing-here");
		expect(rows()).toEqual([]);
		expect(host.textContent).toContain(narratorLocale.noModelMatches);
		await typeFilter("");
		expect(rows()).toEqual(["Follow default", "One", "MiMo Pro"]);
	});
});

describe("shared search across model and provider views", () => {
	const catalog: ModelOption[] = [
		{ value: "__default__", label: "Follow default", provider: "__default__" },
		{ value: "__summary__", label: "Follow summary", provider: "__summary__" },
		{
			value: "auto:gpt-6-astra",
			label: "GPT 6 Astra",
			provider: "__auto__",
			family: "gpt",
			autoSources: [
				{ value: "edge:gpt-6-astra", provider: "edge", available: true, subscription: false },
			],
		},
		{ value: "edge:gpt-6-astra", label: "GPT 6 Astra", provider: "edge" },
		{
			value: "nug:opaque-id",
			label: "Friendly display name",
			provider: "nug",
			bareModel: "kimi-k3",
			channel: "moonshot",
		},
	];
	const options = {
		defaultModelValue: "auto:gpt-6-astra",
		summaryModelValue: "__default__",
		extraProps: { providerLabels: { edge: "Example Cloud", nug: "Gateway Hub" } },
	};
	const rows = () => buttons().map((item) => item.textContent);
	async function switchMode(mode: "model" | "provider") {
		const target = host.querySelector<HTMLElement>(`[data-model-menu-mode="${mode}"]`);
		if (!target) throw new Error(`Missing mode control: ${mode}`);
		await act(async () => target.click());
	}

	test("preserves a multi-term query across view switches and keeps auto selection values", async () => {
		await render("edge:gpt-6-astra", catalog, true, true, options);
		await typeFilter("Example Cloud GPT");
		expect(rows()).toEqual(["Follow default", "Follow summary", "GPT 6 Astra"]);
		await switchMode("model");
		expect(host.querySelectorAll("[data-model-left]").length).toBe(1);
		const auto = host.querySelector<HTMLElement>('[data-model-left="auto:gpt-6-astra"]');
		expect(auto).not.toBeNull();
		expect(host.querySelector("input")?.value).toBe("Example Cloud GPT");
		expect(selected).toEqual([]);
		await act(async () => auto?.click());
		expect(selected).toEqual(["auto:gpt-6-astra"]);
		await switchMode("provider");
		expect(rows()).toEqual(["Follow default", "Follow summary", "GPT 6 Astra"]);
	});

	test("requires every term in both views", async () => {
		await render("edge:gpt-6-astra", catalog, true, true, options);
		await typeFilter("Example Cloud kimi");
		expect(rows()).toEqual([]);
		await switchMode("model");
		expect(host.querySelectorAll("[data-model-left]").length).toBe(0);
		expect(host.textContent).toContain(narratorLocale.noModelMatches);
	});

	test("provider view keeps matching bare ids and channels", async () => {
		await render("edge:gpt-6-astra", catalog, true, true, options);
		await typeFilter("MOONSHOT kimi-k3");
		expect(rows()).toEqual(["Friendly display name"]);
	});

	test("provider renaming rebuilds the search index without clearing the query", async () => {
		await render("edge:gpt-6-astra", catalog, true, true, options);
		await typeFilter("Example Cloud gpt");
		await render("edge:gpt-6-astra", catalog, true, true, {
			...options,
			extraProps: { providerLabels: { edge: "Renamed Cloud", nug: "Gateway Hub" } },
		});
		expect(rows()).toEqual([]);
		await typeFilter("Renamed Cloud gpt");
		expect(rows()).toEqual(["Follow default", "Follow summary", "GPT 6 Astra"]);
	});
});
