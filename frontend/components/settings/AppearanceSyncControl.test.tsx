import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import {
	APPEARANCE_KEYS,
	type AppearancePreferenceKey,
	appearanceDefinition,
} from "@shared/appearance-preferences";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act, type ReactNode, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import en from "../../locales/en/settings.json";
import zh from "../../locales/zh-CN/settings.json";
import type { AppearanceSectionProps } from "./AppearanceSection";

const originalSync = { ...(await import("../../hooks/useAppearanceSync")) };
const originalLocal = { ...(await import("../../hooks/useLocalPref")) };
const originalPlugin = { ...(await import("../../hooks/usePluginThemes")) };
const originalLanguage = { ...(await import("../LanguageSwitcher")) };
let ready = true;
let customEnabled = false;
let revision = 0;
const listeners = new Set<() => void>();
const policy = new Map<AppearancePreferenceKey, boolean>();
const policyWrites: [AppearancePreferenceKey, boolean][] = [];
const customWrites: boolean[] = [];
const valueWrites: Record<string, unknown>[] = [];
function publish() {
	revision++;
	for (const listener of listeners) listener();
}
mock.module("../../hooks/useAppearanceSync", () => ({
	...originalSync,
	useAppearanceSync: () => {
		useSyncExternalStore(
			(listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			() => revision,
			() => revision,
		);
		return {
			ready,
			customEnabled,
			setCustomEnabled: (enabled: boolean) => {
				customWrites.push(enabled);
				customEnabled = enabled;
				publish();
			},
			isSynced: (key: AppearancePreferenceKey) =>
				policy.get(key) ?? appearanceDefinition(key)?.defaultSync ?? false,
			setSynced: (key: AppearancePreferenceKey, synced: boolean) => {
				policyWrites.push([key, synced]);
				policy.set(key, synced);
				publish();
			},
		};
	},
}));
mock.module("../../hooks/useLocalPref", () => ({
	...originalLocal,
	useLocalPref: () => useState(false),
}));
mock.module("../../hooks/usePluginThemes", () => ({
	...originalPlugin,
	usePluginAvailableThemes: () => ({
		themes: [{ pluginId: "test", themeId: "theme", title: "Test theme", enabled: true }],
		setEnabled: async () => {},
	}),
	usePluginThemePref: () => useState<string | null>(null),
}));
mock.module("../LanguageSwitcher", () => ({
	...originalLanguage,
	LanguageSwitcher: () => (
		<select aria-label="Language">
			<option>English</option>
		</select>
	),
}));
const { AppearanceSection } = await import("./AppearanceSection");
const { AppearanceCustomSyncSwitch, AppearanceSyncControl, AppearanceSwitch } = await import(
	"./AppearanceSyncControl"
);
const i18n = createInstance();
await i18n.init({
	lng: "en",
	fallbackLng: "en",
	resources: { en: { settings: en }, "zh-CN": { settings: zh } },
	interpolation: { escapeValue: false },
});
let root: Root | null = null;
let container: HTMLElement;
const globals = new Map<string, PropertyDescriptor | undefined>();
function install(key: string, value: unknown) {
	globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}
function media() {
	return {
		matches: false,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
	};
}
beforeEach(async () => {
	ready = true;
	customEnabled = false;
	revision = 0;
	policy.clear();
	policyWrites.length = 0;
	customWrites.length = 0;
	valueWrites.length = 0;
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	install("window", window);
	install("document", window.document);
	install("navigator", { platform: "Linux", userAgent: "test", maxTouchPoints: 0 });
	install("HTMLElement", window.HTMLElement);
	install("Element", window.Element);
	install("Node", window.Node);
	install("Document", window.Document);
	install("ShadowRoot", window.ShadowRoot);
	install("MutationObserver", window.MutationObserver);
	install("IS_REACT_ACT_ENVIRONMENT", true);
	install("requestAnimationFrame", (callback: (time: number) => void) =>
		setTimeout(() => callback(Date.now()), 0),
	);
	install("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
	install("matchMedia", media);
	install(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	install("getComputedStyle", () => ({
		position: "static",
		overflow: "visible",
		overflowX: "visible",
		overflowY: "visible",
		transform: "none",
		perspective: "none",
		filter: "none",
		direction: "ltr",
		getPropertyValue: () => "",
	}));
	container = window.document.createElement("div") as unknown as HTMLElement;
	window.document.body.appendChild(container);
	await i18n.changeLanguage("en");
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	container.remove();
	listeners.clear();
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});
afterAll(() => mock.restore());
async function render(children: ReactNode) {
	root ??= createRoot(container);
	await act(async () =>
		root?.render(
			<MantineProvider env="test">
				<I18nextProvider i18n={i18n}>{children}</I18nextProvider>
			</MantineProvider>,
		),
	);
}
function indicator(key: AppearancePreferenceKey) {
	const button = container.querySelector<HTMLButtonElement>(`[data-appearance-sync="${key}"]`);
	if (!button) throw new Error(`Missing scope indicator: ${key}`);
	return button;
}
async function click(element: HTMLElement) {
	await act(async () => element.click());
}
async function toggleCustom(checked: boolean) {
	const input = container.querySelector<HTMLInputElement>("input[type=checkbox]");
	if (!input) throw new Error("Missing Custom sync switch");
	await act(async () => {
		input.checked = checked;
		input.dispatchEvent(new window.Event("click", { bubbles: true }));
	});
}
function controls() {
	return (
		<>
			<AppearanceCustomSyncSwitch />
			<AppearanceSyncControl preferenceKey="narrafork_oled" label="OLED" />
			<AppearanceSyncControl preferenceKey="wordWrapCode" label="Code wrap" />
		</>
	);
}
function section() {
	const updateUserPref = {
		isPending: false,
		mutate: (patch: Record<string, unknown>) => {
			valueWrites.push(patch);
		},
	} as unknown as AppearanceSectionProps["updateUserPref"];
	const setBoolean = () => {};
	return (
		<AppearanceSection
			userPrefs={{}}
			updateUserPref={updateUserPref}
			oledMode={false}
			setOledMode={setBoolean}
			isFullscreen={false}
			setIsFullscreen={setBoolean}
			wakeLock={false}
			setWakeLock={setBoolean}
			advancedAnim={true}
			setAdvancedAnim={setBoolean}
			blurInMs={400}
			setBlurInMs={() => {}}
			streamTokenMs={320}
			setStreamTokenMs={() => {}}
			expandReasoning={false}
			setExpandReasoning={setBoolean}
			centeredColumn={false}
			setCenteredColumn={setBoolean}
			lodAltGesture={true}
			setLodAltGesture={setBoolean}
		/>
	);
}

describe("Appearance sync controls", () => {
	test("default mode shows original scopes and leaves every setting visible", async () => {
		policy.set("narrafork_oled", true);
		policy.set("wordWrapCode", false);
		await render(controls());
		expect(container.textContent).toContain("Custom sync");
		expect(indicator("narrafork_oled").getAttribute("aria-pressed")).toBe("false");
		expect(indicator("wordWrapCode").getAttribute("aria-pressed")).toBe("true");
		for (const key of ["narrafork_oled", "wordWrapCode"] as const) {
			const button = indicator(key);
			expect(button.getAttribute("aria-disabled")).toBe("true");
			expect(button.disabled).toBe(false);
			expect(button.getAttribute("aria-label")).toContain("default");
			await click(button);
		}
		expect(policyWrites).toEqual([]);
	});

	test("Custom sync unlocks individual toggles and off/on retains the selection", async () => {
		await render(controls());
		await toggleCustom(true);
		expect(customWrites).toEqual([true]);
		expect(indicator("narrafork_oled").getAttribute("aria-disabled")).toBe("false");
		await click(indicator("narrafork_oled"));
		await click(indicator("wordWrapCode"));
		expect(policyWrites).toEqual([
			["narrafork_oled", true],
			["wordWrapCode", false],
		]);
		expect(indicator("narrafork_oled").getAttribute("aria-pressed")).toBe("true");
		expect(indicator("wordWrapCode").getAttribute("aria-pressed")).toBe("false");
		await toggleCustom(false);
		expect(indicator("narrafork_oled").getAttribute("aria-pressed")).toBe("false");
		expect(indicator("wordWrapCode").getAttribute("aria-pressed")).toBe("true");
		await toggleCustom(true);
		expect(indicator("narrafork_oled").getAttribute("aria-pressed")).toBe("true");
		expect(indicator("wordWrapCode").getAttribute("aria-pressed")).toBe("false");
	});

	test("unidentified account cannot change policy or display a stale custom scope", async () => {
		ready = false;
		customEnabled = true;
		policy.set("narrafork_oled", true);
		await render(controls());
		expect(container.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
		expect(indicator("narrafork_oled").getAttribute("aria-pressed")).toBe("false");
		expect(indicator("narrafork_oled").getAttribute("aria-disabled")).toBe("true");
		await click(indicator("narrafork_oled"));
		await toggleCustom(true);
		expect(policyWrites).toEqual([]);
		expect(customWrites).toEqual([]);
	});

	test("fixed account and device scopes remain focusable, read-only and correctly translated", async () => {
		customEnabled = true;
		await i18n.changeLanguage("zh-CN");
		const fixed = APPEARANCE_KEYS.filter((key) => !appearanceDefinition(key)?.customizable);
		await render(
			fixed.map((key) => <AppearanceSyncControl key={key} preferenceKey={key} label={key} />),
		);
		for (const key of fixed) {
			const button = indicator(key);
			expect(button.tagName).toBe("BUTTON");
			expect(button.disabled).toBe(false);
			expect(button.getAttribute("tabindex")).not.toBe("-1");
			expect(button.getAttribute("aria-disabled")).toBe("true");
			expect(button.getAttribute("aria-pressed")).toBe(
				String(appearanceDefinition(key)?.defaultSync),
			);
			expect(button.getAttribute("aria-label")).toContain("固定");
			await click(button);
		}
		expect(policyWrites).toEqual([]);
	});

	test("keyboard focus exposes the tooltip even while the indicator is read-only", async () => {
		await render(<AppearanceSyncControl preferenceKey="narrafork_oled" label="OLED" />);
		await act(async () => {
			indicator("narrafork_oled").dispatchEvent(new window.Event("focusin", { bubbles: true }));
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Local only · default");
		expect(policyWrites).toEqual([]);
	});

	test("changing sync never activates the setting value's switch", async () => {
		customEnabled = true;
		const onValueChange = mock(() => {});
		await render(
			<AppearanceSwitch
				preferenceKey="narrafork_oled"
				label="OLED"
				checked={false}
				onChange={onValueChange}
			/>,
		);
		const button = indicator("narrafork_oled");
		expect(button.closest("label")).toBeNull();
		expect(button.style.getPropertyValue("--ai-size")).toContain("2.5rem");
		expect(button.querySelectorAll("svg")).toHaveLength(1);
		expect(button.querySelector("svg")?.getAttribute("width")).toBe("16");
		await click(button);
		expect(policyWrites).toEqual([["narrafork_oled", true]]);
		expect(onValueChange).not.toHaveBeenCalled();
		expect(container.querySelectorAll("input[type=checkbox]")).toHaveLength(1);
	});

	test("full appearance section renders exactly one icon for every visible registered preference", async () => {
		await render(section());
		const keys = [...container.querySelectorAll("[data-appearance-sync]")].map((button) =>
			button.getAttribute("data-appearance-sync"),
		);
		const expected = APPEARANCE_KEYS.filter(
			(key) => !["narrafork_mock_stream", "narrafork_unified_morph"].includes(key),
		);
		expect(keys.toSorted()).toEqual(expected.toSorted());
		expect(new Set(keys).size).toBe(keys.length);
		const firstInput = container.querySelector<HTMLInputElement>("input");
		expect(firstInput?.type).toBe("checkbox");
		expect(firstInput?.closest(".mantine-Switch-root")?.textContent).toContain("Custom sync");
		const originalInputCount = container.querySelectorAll("input").length;
		await toggleCustom(true);
		expect(container.querySelectorAll("input")).toHaveLength(originalInputCount);
		expect(valueWrites).toEqual([]);
	});
});
