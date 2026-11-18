/**
 * The details panel's read-only list of subagents' terminals (Project Teams S2): who runs
 * which terminal, an "open" affordance only for people with write access, and a hint
 * instead for read-only viewers. en and zh-CN.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import i18next, { type i18n } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { TreeTerminal } from "../../../lib/api/terminals";
import en from "../../../locales/en/narrator.json";
import zh from "../../../locales/zh-CN/narrator.json";
import { SubagentTerminalsList } from "./SubagentTerminalsList";

let root: Root;
let container: HTMLDivElement;

function installDom() {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const matchMedia = (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	});
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		matchMedia,
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		IS_REACT_ACT_ENVIRONMENT: true,
	});
}

const TERMINALS: TreeTerminal[] = [
	{
		id: "t1",
		name: "dev",
		cwd: "/repo/.worktrees/a",
		createdAt: "2026-11-17T00:00:00.000Z",
		narratorId: "w1",
		narratorTitle: "build the page",
		subagentType: "worker",
	},
	{
		id: "t2",
		name: "repl",
		cwd: null,
		createdAt: "2026-11-17T00:01:00.000Z",
		narratorId: "w2",
		narratorTitle: null,
		subagentType: "worker",
	},
];

async function render(
	props: Partial<Parameters<typeof SubagentTerminalsList>[0]>,
	lng: "en" | "zh-CN" = "en",
) {
	const testI18n: i18n = i18next.createInstance();
	await testI18n.use(initReactI18next).init({
		lng,
		fallbackLng: "en",
		defaultNS: "narrator",
		resources: { en: { narrator: en }, "zh-CN": { narrator: zh } },
		interpolation: { escapeValue: false },
		react: { useSuspense: false },
	});
	const opened: string[] = [];
	await act(async () => {
		root.render(
			<I18nextProvider i18n={testI18n}>
				<MantineProvider>
					<SubagentTerminalsList
						terminals={TERMINALS}
						truncated={false}
						canOpen={false}
						onOpenSession={(id) => opened.push(id)}
						{...props}
					/>
				</MantineProvider>
			</I18nextProvider>,
		);
	});
	return opened;
}

beforeEach(() => {
	installDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

describe("SubagentTerminalsList", () => {
	test("read-only viewers see who runs which terminal, no open button, and why", async () => {
		await render({ canOpen: false });
		const rows = container.querySelectorAll('[data-testid="subagent-terminal-row"]');
		expect(rows).toHaveLength(2);
		expect(rows[0].textContent).toContain("dev");
		expect(rows[0].textContent).toContain("build the page");
		// No title: the template name stands in.
		expect(rows[1].textContent).toContain("worker");
		expect(container.querySelectorAll("button")).toHaveLength(0);
		expect(container.textContent).toContain(en["details.subagentTerminalsOpenHint"]);
	});

	test("writers get a button per row that opens the subagent's session", async () => {
		const opened = await render({ canOpen: true });
		const buttons = container.querySelectorAll("button");
		expect(buttons).toHaveLength(2);
		expect(buttons[0].getAttribute("aria-label")).toBe("Open build the page's session");
		expect(container.textContent).not.toContain(en["details.subagentTerminalsOpenHint"]);
		await act(async () => {
			buttons[1].dispatchEvent(new window.Event("click", { bubbles: true }));
		});
		expect(opened).toEqual(["w2"]);
	});

	test("empty and truncated lists, in Chinese", async () => {
		await render({ terminals: [], canOpen: true }, "zh-CN");
		expect(container.querySelectorAll('[data-testid="subagent-terminal-row"]')).toHaveLength(0);
		expect(container.textContent?.trim().endsWith(zh["details.none"])).toBe(true);
		await render({ truncated: true }, "zh-CN");
		expect(container.textContent).toContain("只显示前 2 个");
		expect(container.textContent).toContain(zh["details.subagentTerminalsOpenHint"]);
	});
});
