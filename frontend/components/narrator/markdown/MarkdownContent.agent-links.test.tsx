import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import { MantineProvider } from "@mantine/core";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import commonMessages from "../../../locales/zh-CN/common.json";
import narratorMessages from "../../../locales/zh-CN/narrator.json";
import { FileReferenceScopeProvider } from "../composer/FileReferenceScope";
import { installCanvasStub } from "../vlist/measure/test-canvas-stub";
import { AgentReferenceOpenerContext } from "./AgentReferenceLink";
import { MarkdownContent } from "./MarkdownContent";

let root: Root;
let host: HTMLDivElement;
let disposeCanvas: () => void;
let originals: Map<string, PropertyDescriptor | undefined>;
let callback: ((data: Record<string, unknown>) => void) | undefined;
let restore: Array<() => void>;
const open = mock((_id: string) => {});
const i18n = createInstance();
await i18n.init({
	lng: "zh-CN",
	resources: { "zh-CN": { narrator: narratorMessages, common: commonMessages } },
});

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const values = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		getComputedStyle: window.getComputedStyle,
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	originals = new Map(
		Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	Object.assign(globalThis, values);
	disposeCanvas = installCanvasStub();
	host = document.body.appendChild(document.createElement("div"));
	root = createRoot(host);
	open.mockClear();
	callback = undefined;
	const listen = spyOn(narratorWSManager, "addListener").mockImplementation((_opts, cb) => {
		callback = cb;
		return { _id: 1 };
	});
	const subscribe = spyOn(narratorWSManager, "subscribe").mockReturnValue({
		_id: 1,
		_narratorIds: ["Child_A"],
		_kind: "activity",
	});
	const unlisten = spyOn(narratorWSManager, "removeListener").mockImplementation(() => {});
	const unsubscribe = spyOn(narratorWSManager, "unsubscribe").mockImplementation(() => {});
	restore = [listen, subscribe, unlisten, unsubscribe].map((spy) => () => spy.mockRestore());
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	for (const fn of restore) fn();
	disposeCanvas();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

async function render(
	renderer: "flowing" | "prepared",
	text: string,
	enabled = true,
	width = 150,
	streaming = false,
) {
	const { measureMarkdown } = await import("../vlist/measure/measure-markdown");
	const { RenderMarkdown } = await import("../vlist/render/RenderMarkdown");
	const measured = measureMarkdown(text, width);
	await act(async () =>
		root.render(
			<MantineProvider env="test">
				<I18nextProvider i18n={i18n}>
					<AgentReferenceOpenerContext.Provider value={enabled ? open : null}>
						<FileReferenceScopeProvider
							value={{
								context: { deviceId: "local", cwd: "/repo" },
								openFile: () => {
									throw new Error("agent is not a file");
								},
							}}
						>
							{renderer === "flowing" ? (
								<MarkdownContent text={text} streaming={streaming} />
							) : (
								<RenderMarkdown measured={measured} animateStreaming={streaming} />
							)}
						</FileReferenceScopeProvider>
					</AgentReferenceOpenerContext.Provider>
				</I18nextProvider>
			</MantineProvider>,
		),
	);
	return measured;
}

for (const renderer of ["flowing", "prepared"] as const)
	describe(`${renderer} agent references`, () => {
		test("opens through the session host, and never through file navigation or the custom scheme", async () => {
			await render(renderer, "交给 [任务名称](nf-agent://open?id=Child_A)。");
			const link = host.querySelector<HTMLAnchorElement>("a[data-agent-reference]");
			expect(link?.getAttribute("href")).toBe("/narrators/Child_A");
			const event = new window.Event("click", { bubbles: true, cancelable: true });
			Object.defineProperty(event, "button", { value: 0 });
			act(() => link?.dispatchEvent(event));
			expect(event.defaultPrevented).toBe(true);
			expect(open).toHaveBeenCalledWith("Child_A");
			expect(host.querySelectorAll("[data-agent-status]")).toHaveLength(1);
			expect(host.querySelector("[data-agent-status]")?.getAttribute("aria-label")).toBe(
				"子代理状态未知",
			);
		});
		test("keeps modified clicks native and keyboard activation opens through the host", async () => {
			await render(renderer, "[任务](nf-agent://open?id=Child_A)");
			const link = host.querySelector<HTMLAnchorElement>("a[data-agent-reference]");
			const modified = new window.Event("click", { bubbles: true, cancelable: true });
			Object.defineProperties(modified, { button: { value: 0 }, ctrlKey: { value: true } });
			act(() => link?.dispatchEvent(modified));
			expect(modified.defaultPrevented).toBe(false);
			expect(open).toHaveBeenCalledTimes(0);
			const keyboard = new window.Event("click", { bubbles: true, cancelable: true });
			Object.defineProperties(keyboard, { button: { value: 0 }, detail: { value: 0 } });
			act(() => link?.dispatchEvent(keyboard));
			expect(open).toHaveBeenCalledWith("Child_A");
		});
		test("renders reference-style links in lists, headings and table cells", async () => {
			await render(
				renderer,
				"## [标题][child]\n\n- [列表][child]\n\n| a | b |\n|---|---|\n| [表格][child] | x |\n\n[child]: nf-agent://open?id=Child_A",
			);
			expect(host.querySelectorAll("[data-agent-status]")).toHaveLength(3);
			expect(narratorWSManager.subscribe).toHaveBeenCalledTimes(1);
		});
		test("keeps a single plain-title atom stable across status changes", async () => {
			const text =
				"见 [很长的 **子代理名称** 和 `代码` 更多详细名称需要跨行显示](nf-agent://open?id=Child_A) 完毕。";
			const measured = await render(renderer, text);
			const before = host.textContent;
			const title = "很长的 子代理名称 和 代码 更多详细名称需要跨行显示";
			expect(host.querySelectorAll("[data-agent-reference]")).toHaveLength(1);
			expect(host.querySelector("[data-agent-label]")?.textContent).toBe(title);
			expect(host.querySelector("[data-agent-reference]")?.getAttribute("title")).toStartWith(
				title,
			);
			expect(
				host.querySelector("[data-agent-reference] code, [data-agent-reference] strong"),
			).toBeNull();
			const styles = [...host.querySelectorAll("[data-agent-reference]")].map((el) =>
				el.getAttribute("style"),
			);
			expect(narratorWSManager.subscribe).toHaveBeenCalledTimes(1);
			expect(host.querySelectorAll("[data-agent-status]")).toHaveLength(1);
			act(() =>
				callback?.({
					type: "list_state_snapshot",
					items: [{ narratorId: "Child_A", status: "working", substatus: ["reasoning"] }],
				}),
			);
			expect(host.querySelector("[data-agent-reference]")?.getAttribute("data-agent-state")).toBe(
				"working",
			);
			act(() =>
				callback?.({
					type: "status_change",
					narratorId: "Child_A",
					status: "idle",
					substatus: ["unread"],
				}),
			);
			expect(host.querySelector("[data-agent-reference]")?.getAttribute("data-agent-state")).toBe(
				"idle",
			);
			expect(host.textContent).toBe(before);
			expect(
				[...host.querySelectorAll("[data-agent-reference]")].map((el) => el.getAttribute("style")),
			).toEqual(styles);
			expect(measured.frame.contentHeight).toBeGreaterThan(0);
			act(() => callback?.({ type: "subscribe_denied", narratorId: "Child_A" }));
			expect(host.querySelector("a[data-agent-reference]")).toBeNull();
			expect(host.querySelector("[data-agent-reference]")?.getAttribute("data-agent-state")).toBe(
				"unavailable",
			);
		});
		test("normalizes reference titles without changing ordinary Markdown", async () => {
			await render(
				renderer,
				[
					"[首行  \n**后行**](nf-agent://open?id=Child_A)",
					"[图片 ![说明](https://example.com/icon.png)](nf-agent://open?id=Child_A)",
					"[](nf-agent://open?id=Child_A)",
					"**外面的粗体** 与 `外面代码`",
				].join("\n\n"),
			);
			expect([...host.querySelectorAll("[data-agent-label]")].map((el) => el.textContent)).toEqual([
				"首行 后行",
				"图片 说明",
				"Child_A",
			]);
			expect(host.querySelectorAll("a[data-agent-reference]")).toHaveLength(3);
			expect(
				host.querySelector(
					"[data-agent-reference] img, [data-agent-reference] code, [data-agent-reference] strong",
				),
			).toBeNull();
			expect(host.querySelector("strong, .is-strong")?.textContent).toBe("外面的粗体");
			expect(host.querySelector("code, .vlist-frag--code")?.textContent).toBe("外面代码");
		});
		test("public or non-session Markdown stays inert and makes no subscriptions", async () => {
			await render(renderer, "[任务](nf-agent://open?id=Child_A)", false);
			expect(host.textContent).toContain("任务");
			expect(host.querySelector("a")).toBeNull();
			expect(narratorWSManager.subscribe).toHaveBeenCalledTimes(0);
		});
		test("refuses malformed agent targets and still renders ordinary links", async () => {
			await render(
				renderer,
				"[无效](nf-agent://open?id=../bad) [普通](https://example.com) [脚本](javascript:alert)",
			);
			expect(host.textContent).toContain("无效");
			expect(host.querySelector("[data-agent-reference]")).toBeNull();
			expect(
				[...host.querySelectorAll("a")].some((el) =>
					el.getAttribute("href")?.startsWith("nf-agent:"),
				),
			).toBe(false);
			expect(host.querySelector('a[href^="https://example.com"]')).not.toBeNull();
			expect(narratorWSManager.subscribe).toHaveBeenCalledTimes(0);
		});
		test("streaming and adjacent links each paint exactly one marker", async () => {
			await render(
				renderer,
				"[甲](nf-agent://open?id=Child_A)[乙](nf-agent://open?id=Child_A)",
				true,
				800,
				true,
			);
			expect(host.querySelectorAll("[data-agent-status]")).toHaveLength(2);
			expect(narratorWSManager.subscribe).toHaveBeenCalledTimes(1);
		});
	});

describe("prepared chip lines", () => {
	test("mark exactly the lines holding a chip, so their CSS needs no :has()", async () => {
		await render(
			"prepared",
			"普通的一行文字\n\n交给 [任务](nf-agent://open?id=Child_A) 处理\n\n| a | b |\n|---|---|\n| [表格](nf-agent://open?id=Child_A) | 纯文本 |\n\n[外链](https://example.com)",
			true,
			400,
		);
		const lines = [...host.querySelectorAll("[data-vlist-line-frags]")];
		const marked = lines.filter((el) => el.hasAttribute("data-vlist-line-chip"));
		expect(marked).toHaveLength(2);
		for (const el of lines)
			expect(el.hasAttribute("data-vlist-line-chip")).toBe(
				el.querySelector(":scope > [data-agent-reference]") !== null,
			);
		const css = await Bun.file(new URL("./AgentReferenceLink.module.css", import.meta.url)).text();
		expect(css).not.toMatch(/\[data-vlist-line-frags\][^{]*:has\(/);
		expect(css).toMatch(/\[data-vlist-line-frags\]\[data-vlist-line-chip\] > \* \{/);
	});
});
