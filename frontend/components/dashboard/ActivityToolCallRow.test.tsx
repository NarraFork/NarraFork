import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { TRACE_SHIMMER_CLASS, TRACE_SHIMMER_FLASH_HOLD_MS } from "@shared/tool-shimmer";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import zh from "../../locales/zh-CN/narrator.json";
import {
	getCategory,
	subagentRecentCallSummary,
	traceRowTitle,
} from "../narrator/tool-call/tool-display";
import { measureActivityTrace } from "../narrator/vlist/measure/measure-tool-run";
import { installCanvasStub } from "../narrator/vlist/measure/test-canvas-stub";
import { RenderToolRun } from "../narrator/vlist/render/RenderToolRun";
import { ActivityToolCallRow } from "./ActivityToolCallRow";
import { type ActivityToolRow, applyActivityEvent } from "./dashboard-activity";

const i18n = createInstance();
const disposeCanvas = installCanvasStub();
const globals = globalThis as unknown as Record<string, unknown>;
const saved = new Map<string, PropertyDescriptor | undefined>();
beforeAll(async () => {
	await i18n.init({
		lng: "zh-CN",
		resources: { "zh-CN": { narrator: zh } },
		interpolation: { escapeValue: false },
	});
	const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	})) {
		saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
});
afterAll(() => {
	disposeCanvas();
	for (const [key, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else delete globals[key];
	}
});

function wrap(node: ReactNode, scheme: "dark" | "light" = "dark") {
	return (
		<I18nextProvider i18n={i18n}>
			<MantineProvider defaultColorScheme={scheme}>{node}</MantineProvider>
		</I18nextProvider>
	);
}
function render(node: ReactNode, scheme: "dark" | "light" = "dark") {
	return parseHTML(`<html><body>${renderToStaticMarkup(wrap(node, scheme))}</body></html>`)
		.document;
}
function shimmer(root: ParentNode) {
	return Object.values(TRACE_SHIMMER_CLASS).filter((name) => root.querySelector(`.${name}`));
}
const tool: ActivityToolRow = {
	toolUseId: "t",
	toolName: "Read",
	status: "success",
	inputSummary: { file_path: "/src/main.ts" },
};

describe("recent activity rows match low-LOD tool traces", () => {
	it("uses the same category glyph, bold name, summary and shimmer in either scheme", () => {
		for (const scheme of ["dark", "light"] as const) {
			for (const toolName of [
				"Read",
				"Write",
				"Bash",
				"StructView",
				"Task",
				"KnowledgeRead",
				"OutlineEdit",
				"UnknownTool",
			]) {
				const call = { ...tool, toolName, status: "running" };
				const activity = render(<ActivityToolCallRow tool={call} />, scheme);
				const trace = render(
					<RenderToolRun
						measured={measureActivityTrace(
							[
								{
									key: "t",
									title: traceRowTitle(
										toolName,
										subagentRecentCallSummary(toolName, call.inputSummary),
									),
									toolName,
									hasIcon: true,
									category: getCategory(toolName, call.inputSummary),
									status: call.status,
								},
							],
							700,
						)}
					/>,
					scheme,
				);
				const activityGlyph = activity.querySelector("[data-trace-row-chip] svg");
				expect(activityGlyph?.outerHTML).toBe(
					trace.querySelector("[data-trace-row-chip] svg")?.outerHTML,
				);
				const text = activity.querySelector(`.${TRACE_SHIMMER_CLASS.running}`);
				expect(text?.textContent).toBe(
					trace.querySelector(`.${TRACE_SHIMMER_CLASS.running}`)?.textContent,
				);
				expect(text?.querySelector("span")?.getAttribute("style")).toContain("font-weight:600");
				expect(shimmer(activity as unknown as ParentNode)).toEqual(
					shimmer(trace as unknown as ParentNode),
				);
			}
		}
	});

	it("puts the status after the label and reserves no success slot", () => {
		const running = render(<ActivityToolCallRow tool={{ ...tool, status: "running" }} />);
		const row = running.querySelector("[data-activity-tool-row]");
		expect(row?.children[0]?.hasAttribute("data-trace-row-chip")).toBe(true);
		expect(row?.children[1]?.classList.contains(TRACE_SHIMMER_CLASS.running)).toBe(true);
		expect(row?.children[2]?.hasAttribute("data-activity-tool-status")).toBe(true);
		expect(row?.getAttribute("aria-label")).toContain(
			i18n.t("traceRowState.running", { ns: "narrator" }),
		);
		const settled = render(<ActivityToolCallRow tool={tool} />);
		expect(settled.querySelector("[data-activity-tool-status]")).toBeNull();
		expect(shimmer(settled as unknown as ParentNode)).toEqual([]);
		expect(settled.querySelector("[data-activity-tool-row]")?.textContent).toBe("Readmain.ts");
	});

	it("keeps pending and unknown statuses quiet, and only executes after tool_executing", () => {
		for (const status of ["pending", "success", "fail", "cancelled", "unknown"]) {
			const doc = render(<ActivityToolCallRow tool={{ ...tool, status }} />);
			expect(shimmer(doc as unknown as ParentNode)).toEqual([]);
			if (status === "pending") {
				expect(doc.querySelector(".tabler-icon-player-pause")).not.toBeNull();
				expect(doc.querySelector(".nf-trace-spin")).toBeNull();
			}
		}
		let state = applyActivityEvent(new Map(), {
			type: "tool_started",
			narratorId: "n",
			toolUseId: "t",
			toolName: "Read",
		});
		const started = state.get("n")?.tools[0];
		if (!started) throw new Error("missing started activity tool");
		expect(
			shimmer(render(<ActivityToolCallRow tool={started} />) as unknown as ParentNode),
		).toEqual([TRACE_SHIMMER_CLASS.streaming]);
		state = applyActivityEvent(state, { type: "tool_executing", narratorId: "n", toolUseId: "t" });
		const executing = state.get("n")?.tools[0];
		if (!executing) throw new Error("missing executing activity tool");
		expect(
			shimmer(render(<ActivityToolCallRow tool={executing} />) as unknown as ParentNode),
		).toEqual([TRACE_SHIMMER_CLASS.running]);
	});

	it("plays a closing sweep only for an observed outcome, then clears it", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		const update = async (status: string) => {
			await act(async () => root.render(wrap(<ActivityToolCallRow tool={{ ...tool, status }} />)));
		};
		try {
			await update("success");
			expect(shimmer(host)).toEqual([]);
			await update("running");
			expect(shimmer(host)).toEqual([TRACE_SHIMMER_CLASS.running]);
			await update("success");
			expect(shimmer(host)).toEqual([TRACE_SHIMMER_CLASS.success]);
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, TRACE_SHIMMER_FLASH_HOLD_MS + 50));
			});
			expect(shimmer(host)).toEqual([]);
			await update("running");
			await update("fail");
			expect(shimmer(host)).toEqual([TRACE_SHIMMER_CLASS.failed]);
			await update("running");
			await update("pending");
			expect(shimmer(host)).toEqual([]);
			await update("running");
			await update("cancelled");
			expect(shimmer(host)).toEqual([]);
		} finally {
			await act(async () => root.unmount());
			host.remove();
		}
	});
});
