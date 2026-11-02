import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PluginSummary } from "../../lib/api/plugins";
import { BuiltinPluginRow } from "./BuiltinPluginRow";

/**
 * The builtin-plugin row is the only UI proof that a shipped plugin is a normal plugin: that it
 * reports real health, counts restarts, and offers the same enable/disable control as an
 * installed one. These cases render it directly, so the behaviour is pinned without a session.
 */
// The row only renders translation keys; returning the last key segment keeps the assertions
// readable and avoids booting the whole i18n stack in a unit test.
mock.module("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => {
			const table: Record<string, string> = {
				"admin.actions.disable": "Disable",
				"admin.actions.enable": "Enable",
				"admin.builtin.lastCallOk": "Succeeded",
				"admin.builtin.lastCallFailed": "Failed",
				"admin.builtin.noCalls": "No calls yet",
			};
			return table[key] ?? key;
		},
	}),
}));

// Mantine needs a theme and portal targets that Linkedom does not provide. Rendering the row
// through plain DOM elements keeps the assertions on real content (text and the toggle) while
// dropping only visual chrome.
type LooseProps = Record<string, unknown> & { children?: ReactNode };

const createLooseElement = createElement as unknown as (
	type: string,
	props: Record<string, unknown> | null,
	...children: ReactNode[]
) => ReactElement;

const passthrough = (tag: string) => {
	const Component = ({ children, ...rest }: LooseProps) => createLooseElement(tag, rest, children);
	return Component;
};

const TableRoot = Object.assign(passthrough("table"), {
	Thead: passthrough("thead"),
	Tbody: passthrough("tbody"),
	Tr: passthrough("tr"),
	Th: passthrough("th"),
	Td: passthrough("td"),
});

// The toggle renders through an icon button, so give the stand-in an explicit button type.
const ActionIcon = ({ children, ...rest }: LooseProps) =>
	createLooseElement("button", { type: "button", ...rest }, children);

const OnlyChildren = ({ children }: { children?: ReactNode }) => children;

mock.module("@mantine/core", () => ({
	MantineProvider: OnlyChildren,
	Table: TableRoot,
	Text: passthrough("span"),
	Badge: passthrough("span"),
	Group: passthrough("div"),
	Tooltip: OnlyChildren,
	ActionIcon,
}));

const originalGlobals = {
	window: globalThis.window,
	document: globalThis.document,
	HTMLElement: globalThis.HTMLElement,
};

const dom = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as Record<string, unknown>).window = dom.window;
(globalThis as Record<string, unknown>).document = dom.window.document;
(globalThis as Record<string, unknown>).HTMLElement = dom.window.HTMLElement;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
	Object.assign(globalThis, originalGlobals);
});

const plugin = (overrides: Partial<PluginSummary> = {}): PluginSummary => ({
	pluginId: "com.narrafork.apikey-quota",
	displayName: "API Key Quota Probe",
	version: "1.0.0",
	builtin: true,
	desiredState: "enabled",
	runtimeState: "active",
	status: "compatible",
	restartCount: 2,
	crashCount: 1,
	...overrides,
});

let root: Root | undefined;
let container: HTMLElement;

function render(
	entry: PluginSummary,
	handlers: { onEnable?: () => void; onDisable?: () => void } = {},
) {
	container = dom.window.document.createElement("div") as unknown as HTMLElement;
	root = createRoot(container);
	act(() => {
		root?.render(
			<BuiltinPluginRow
				plugin={entry}
				disabled={false}
				onOpen={() => undefined}
				onEnable={handlers.onEnable ?? (() => undefined)}
				onDisable={handlers.onDisable ?? (() => undefined)}
			/>,
		);
	});
	return container;
}

afterEach(() => {
	if (root) {
		const current = root;
		act(() => current.unmount());
		root = undefined;
	}
});

describe("BuiltinPluginRow", () => {
	test("shows the display name, its id, and a success badge with the last call time", () => {
		const text = render(
			plugin({
				health: [
					{
						surface: "tool",
						requests: 3,
						successes: 3,
						failures: 0,
						lastSuccessAt: "2026-01-02T03:04:05.000Z",
					},
				],
			}),
		);

		expect(text.textContent ?? "").toContain("API Key Quota Probe");
		expect(text.textContent ?? "").toContain("com.narrafork.apikey-quota");
		expect(text.textContent ?? "").toContain("Succeeded");
	});

	test("a recorded failure wins over an older success", () => {
		const text = render(
			plugin({
				health: [
					{
						surface: "tool",
						lastSuccessAt: "2026-01-02T03:04:05.000Z",
						lastFailureAt: "2026-01-02T04:00:00.000Z",
					},
				],
			}),
		);

		expect(text.textContent ?? "").toContain("Failed");
	});

	test("a plugin with no recorded calls says so instead of showing a fake timestamp", () => {
		const text = render(plugin({ health: undefined }));
		expect(text.textContent ?? "").toContain("No calls yet");
	});

	test("restart and crash counts are added, not hidden", () => {
		const text = render(plugin({ restartCount: 2, crashCount: 3 }));
		expect(text.textContent ?? "").toContain("5");
	});

	test("an enabled plugin offers disable; a disabled one offers enable", () => {
		const enabledButtons = render(plugin({ desiredState: "enabled" })).querySelectorAll("button");
		expect(enabledButtons.length).toBe(1);

		const disabledButtons = render(
			plugin({ desiredState: "disabled", runtimeState: "inactive" }),
		).querySelectorAll("button");
		expect(disabledButtons.length).toBe(1);
	});

	test("clicking the toggle calls the handler the enabled state implies", () => {
		let enabled = 0;
		let disabled = 0;
		const handlers = {
			onEnable: () => {
				enabled += 1;
			},
			onDisable: () => {
				disabled += 1;
			},
		};

		const enabledRow = render(plugin({ desiredState: "enabled" }), handlers);
		act(() => {
			(enabledRow.querySelector("button") as HTMLButtonElement).click();
		});
		// An enabled plugin offers "disable", so that is the handler that must fire.
		expect(disabled).toBe(1);
		expect(enabled).toBe(0);

		const disabledRow = render(
			plugin({ desiredState: "disabled", runtimeState: "inactive" }),
			handlers,
		);
		act(() => {
			(disabledRow.querySelector("button") as HTMLButtonElement).click();
		});
		expect(enabled).toBe(1);
		expect(disabled).toBe(1);
	});
});
