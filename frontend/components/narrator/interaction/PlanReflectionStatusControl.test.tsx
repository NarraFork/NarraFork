import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Group, MantineProvider, UnstyledButton } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import en from "../../../locales/en/narrator.json";
import zh from "../../../locales/zh-CN/narrator.json";
import { NarratorStatusBar } from "../header/NarratorStatusToolbar";
import {
	createPlanReflectionStatusAction,
	PlanReflectionStatusControl,
	type PlanReflectionStatusControlProps,
} from "./PlanReflectionStatusControl";
import type { BooleanOverride } from "./reflection-types";

let root: Root;
let container: HTMLDivElement;
let onChange: ReturnType<typeof mock<(value: BooleanOverride) => void>>;
let onWorkClick: ReturnType<typeof mock<() => void>>;
const originals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
	Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia });
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
	onChange = mock(() => {});
	onWorkClick = mock(() => {});
});

afterEach(async () => {
	await act(async () => root.unmount());
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

async function render(overrides: Partial<PlanReflectionStatusControlProps> = {}) {
	await act(async () => {
		root.render(
			<MantineProvider env="test">
				<NarratorStatusBar>
					<Group gap={6} align="center" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
						<UnstyledButton onClick={onWorkClick}>计划中</UnstyledButton>
						<PlanReflectionStatusControl
							hasPlanTrait
							supported
							isWorkspacePreview={false}
							effective={false}
							globalDefault={false}
							disabled={false}
							onChange={onChange}
							t={(key) => zh[key as keyof typeof zh] as string}
							{...overrides}
						/>
					</Group>
				</NarratorStatusBar>
			</MantineProvider>,
		);
	});
}

async function toggle(checked: boolean) {
	const input = container.querySelector<HTMLInputElement>("input");
	if (!input) throw new Error("Missing reflection switch");
	// linkedom has no checkbox default action: emulate the browser's checked update.
	await act(async () => {
		input.checked = checked;
		input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

describe("plan reflection status control", () => {
	test("shows both states with an accessible switch", async () => {
		await render();
		expect(container.textContent).toContain("反思批准已关闭");
		expect(container.querySelector("input")?.getAttribute("aria-label")).toBe("反思批准已关闭");
		await render({ effective: true });
		expect(container.textContent).toContain("反思批准已开启");
		expect(container.querySelector<HTMLInputElement>("input")?.checked).toBe(true);
		await render({ t: (key) => en[key as keyof typeof en] as string });
		expect(container.textContent).toContain("Reflection approval off");
	});

	for (const overrides of [
		{ hasPlanTrait: false },
		{ supported: false },
		{ isWorkspacePreview: true },
	]) {
		test(`hides for ${JSON.stringify(overrides)}`, async () => {
			await render(overrides);
			expect(container.querySelector("input")).toBeNull();
		});
	}

	for (const globalDefault of [false, true]) {
		for (const checked of [false, true]) {
			test(`switch ${checked}, global ${globalDefault}: inherit or override`, async () => {
				await render({ effective: !checked, globalDefault });
				await toggle(checked);
				expect(onChange).toHaveBeenCalledWith(
					checked === globalDefault ? "inherit" : checked ? "on" : "off",
				);
				expect(onWorkClick).not.toHaveBeenCalled();
			});
		}
	}

	test("menu mode preserves the accessible switch without nesting it in a button", async () => {
		await render({ mode: "menu", globalDefault: true });
		expect(container.querySelector("input")?.getAttribute("aria-label")).toBe("反思批准已关闭");
		expect(container.querySelector("input")?.closest("button")).toBeNull();
		await toggle(true);
		expect(onChange).toHaveBeenCalledWith("inherit");
		expect(onWorkClick).not.toHaveBeenCalled();
	});

	test("does not reserve a toolbar action for hidden reflection controls", () => {
		const props: PlanReflectionStatusControlProps = {
			hasPlanTrait: true,
			supported: true,
			isWorkspacePreview: false,
			effective: false,
			globalDefault: false,
			disabled: false,
			onChange,
			t: (key) => zh[key as keyof typeof zh] as string,
		};
		expect(createPlanReflectionStatusAction(props)?.key).toBe("plan-reflection");
		for (const override of [
			{ hasPlanTrait: false },
			{ supported: false },
			{ isWorkspacePreview: true },
		]) {
			expect(createPlanReflectionStatusAction({ ...props, ...override })).toBeNull();
		}
	});

	test("disables the switch while settings are unavailable or saving", async () => {
		await render({ disabled: true });
		expect(container.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
	});

	test("keeps the original row budget and a centered single-line control", async () => {
		await render();
		const row = container.querySelector<HTMLElement>('[data-testid="narrator-status-bar-content"]');
		const control = container.querySelector<HTMLElement>(
			'[data-testid="plan-reflection-status-control"]',
		);
		if (!row || !control) throw new Error("Missing status row or reflection control");
		expect(row.style.minHeight).toBe("30px");
		expect(control.style.height).toBe("22px");
		expect(control.style.getPropertyValue("--group-align")).toBe("center");
		expect(control.style.getPropertyValue("--group-wrap")).toBe("nowrap");
		expect(container.querySelector("input")?.closest("button")).toBeNull();
	});
});
