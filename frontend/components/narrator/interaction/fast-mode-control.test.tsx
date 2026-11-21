import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import en from "../../../locales/en/narrator.json";
import zh from "../../../locales/zh-CN/narrator.json";
import { fastModeDetailLabel, fastModePresentation, isFastModeSubagent } from "./fast-mode-state";
import type { UseFastModeControlOptions } from "./use-fast-mode-control";

// Keep the real control and hook; replace only the UI primitives/portal machinery.
const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
mock.module("@mantine/core", () => ({
	Popover: Object.assign(Box, { Target: Box, Dropdown: Box }),
	Group: Box,
	Stack: Box,
	Text: Box,
	Tooltip: ({ children, label }: { children?: ReactNode; label: string }) => (
		<div data-tooltip={label}>{children}</div>
	),
	ActionIcon: ({
		children,
		color,
		...props
	}: import("react").ComponentProps<"button"> & { color: string }) => (
		<button type="button" data-color={color} {...props}>
			{children}
		</button>
	),
	SegmentedControl: ({
		data,
		onChange,
		value,
	}: {
		data: { value: string; label: string }[];
		onChange: (value: string) => void;
		value: string;
	}) => (
		<div>
			{data.map((item) => (
				<button
					key={item.value}
					type="button"
					data-value={item.value}
					aria-pressed={value === item.value}
					onClick={() => onChange(item.value)}
				>
					{item.label}
				</button>
			))}
		</div>
	),
	Switch: ({ checked, label }: { checked: boolean; label: string }) => (
		<label>
			<input type="checkbox" checked={checked} readOnly />
			{label}
		</label>
	),
}));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useFastModeControl } = await import("./use-fast-mode-control");

let root: Root;
let container: HTMLDivElement;
const originals = new Map<string, PropertyDescriptor | undefined>();
const mutate = mock((_input: { id: string; fastModeOverride: string }) => {});
const translate = (key: string, options?: Record<string, unknown>) => {
	const translated = zh[key as keyof typeof zh];
	const text = typeof translated === "string" ? translated : key;
	return text.replace("{{state}}", String(options?.state ?? ""));
};
function Probe({ options }: { options: UseFastModeControlOptions }) {
	return useFastModeControl(options).renderFastModeControl(
		options.fastModeUsesTapSettings ? "bottom-end" : "top-end",
	);
}
async function render(overrides: Partial<UseFastModeControlOptions> = {}) {
	const options: UseFastModeControlOptions = {
		narratorId: "session",
		narratorFastModeOverride: "inherit",
		effectiveFastMode: false,
		fastModeSource: "user-default",
		isSubagent: false,
		fastModeDefault: true,
		fastModeUsesTapSettings: false,
		fastModeMutation: { mutate },
		updateUserPrefs: { mutate: mock(() => {}) },
		t: translate,
		...overrides,
	};
	await act(async () => root.render(<Probe options={options} />));
}
async function click(selector: string) {
	const button = container.querySelector(selector);
	if (!button) throw new Error(`Missing control: ${selector}`);
	await act(async () => {
		button.dispatchEvent(new window.Event("click", { bubbles: true }));
	});
}
beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
	mutate.mockClear();
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});
afterAll(() => mock.restore());

describe("fast-mode session controls", () => {
	for (const isSubagent of [false, true]) {
		for (const mobile of [false, true]) {
			test(`${isSubagent ? "child" : "primary"} ${mobile ? "mobile" : "desktop"} keeps all three choices independent`, async () => {
				await render({
					isSubagent,
					fastModeUsesTapSettings: mobile,
					fastModeSource: isSubagent ? "primary" : "user-default",
				});
				expect(container.textContent).toContain(isSubagent ? "跟随主代理" : "跟随用户默认");
				expect(container.querySelector("input") !== null).toBe(!isSubagent);
				for (const value of ["on", "off", "inherit"]) {
					await click(`[data-value="${value}"]`);
					expect(mutate).toHaveBeenLastCalledWith({ id: "session", fastModeOverride: value });
				}
			});
		}
	}
	for (const isSubagent of [false, true]) {
		for (const fastModeDefault of [false, true]) {
			for (const effectiveFastMode of [false, true]) {
				test(`server state ${effectiveFastMode}, viewer ${fastModeDefault}, child ${isSubagent}: shortcut pins only this session`, async () => {
					await render({
						isSubagent,
						fastModeDefault,
						effectiveFastMode,
						fastModeSource: isSubagent ? "primary" : "user-default",
					});
					expect(container.querySelector("[aria-label]")?.getAttribute("data-color")).toBe(
						effectiveFastMode ? "yellow" : "gray",
					);
					expect(container.querySelector("[data-tooltip]")?.getAttribute("data-tooltip")).toContain(
						effectiveFastMode ? "开启" : "关闭",
					);
					await click("[aria-label]");
					expect(mutate).toHaveBeenLastCalledWith({
						id: "session",
						fastModeOverride: effectiveFastMode ? "off" : "on",
					});
				});
			}
		}
	}
	test("an unavailable source remains editable and explicit choices take display priority", async () => {
		await render({ isSubagent: true, fastModeSource: "unavailable", effectiveFastMode: false });
		expect(container.textContent).toContain("继承来源不可用");
		await click('[data-value="on"]');
		expect(mutate).toHaveBeenLastCalledWith({ id: "session", fastModeOverride: "on" });
		await render({
			isSubagent: true,
			narratorFastModeOverride: "on",
			fastModeSource: "override",
			effectiveFastMode: true,
		});
		expect(container.textContent).not.toContain("继承来源不可用");
		await click('[data-value="inherit"]');
		expect(mutate).toHaveBeenLastCalledWith({ id: "session", fastModeOverride: "inherit" });
	});
	test("old details resolve explicit overrides but never guess inherited state from the viewer or mirror", () => {
		const legacy = { fastMode: true, fastModeOverride: "inherit" };
		expect(fastModePresentation(legacy)).toEqual({
			override: "inherit",
			enabled: false,
			sourceUnavailable: true,
		});
		expect(fastModePresentation({ fastModeOverride: "on" })).toEqual({
			override: "on",
			enabled: true,
			sourceUnavailable: false,
		});
		expect(
			fastModePresentation({ fastModeOverride: "off", fastModeSource: "unavailable" }),
		).toEqual({ override: "off", enabled: false, sourceUnavailable: false });
	});
	test("detail labels distinguish inheritance from independent choices and preserve explicit priority", () => {
		expect(
			fastModeDetailLabel(
				{ fastModeOverride: "inherit", effectiveFastMode: true, fastModeSource: "primary" },
				true,
				translate,
			),
		).toBe("跟随主代理 · 开启");
		expect(
			fastModeDetailLabel(
				{ fastModeOverride: "inherit", effectiveFastMode: false, fastModeSource: "user-default" },
				false,
				translate,
			),
		).toBe("跟随用户默认 · 关闭");
		expect(
			fastModeDetailLabel(
				{ fastModeOverride: "off", effectiveFastMode: false, fastModeSource: "unavailable" },
				true,
				translate,
			),
		).toBe("独立关闭");
		expect(
			fastModeDetailLabel(
				{ fastModeOverride: "inherit", effectiveFastMode: false, fastModeSource: "unavailable" },
				true,
				translate,
			),
		).toContain("继承来源不可用");
	});
	test("both API variants and persisted types identify a child; default labels have no misleading state", () => {
		expect(isFastModeSubagent({ variant: "subagent:general" })).toBe(true);
		expect(isFastModeSubagent({ type: "subagent" })).toBe(true);
		expect(isFastModeSubagent({ variant: "primary", type: "primary" })).toBe(false);
		for (const locale of [en, zh]) {
			expect(locale.fast_mode_session_inherit).not.toContain("{{state}}");
			expect(locale.fast_mode_session_primary).not.toContain("{{state}}");
		}
	});
});
