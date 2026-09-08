import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider, Menu } from "@mantine/core";
import i18next, { type i18n } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { ModelAggregation, ModelOption } from "../../lib/constants";
import narratorLocale from "../../locales/en/narrator.json";
import settingsLocale from "../../locales/en/settings.json";
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
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	frames = new Map();
	nextFrame = 0;
	selected = [];
	refreshed = 0;
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
	};
	for (const [key, value] of Object.entries(globals)) {
		previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	instance = i18next.createInstance();
	await instance.use(initReactI18next).init({
		lng: "en",
		resources: { en: { narrator: narratorLocale, settings: settingsLocale } },
		react: { useSuspense: false },
	});
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	previousGlobals.clear();
});

async function render(
	currentModel: string | null,
	allModels = models,
	mounted = true,
	opened = true,
) {
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
									providerLabels={{ a: "Provider A" }}
									onSelect={(value) => selected.push(value)}
									onPickerOpened={() => {
										refreshed++;
									}}
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
