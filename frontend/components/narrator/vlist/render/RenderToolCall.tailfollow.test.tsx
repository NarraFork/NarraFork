import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { classifyToolDetail } from "@shared/pretext-layout/tool-detail";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { measureToolCall, type ToolCallStatus } from "../measure/measure-tool-call";
import { installCanvasStub } from "../measure/test-canvas-stub";
import type { VListViewControls } from "../VListContentViewHost";
import { resolveToolDetailViewTargets } from "../vlist-content-view-target";
import { RenderToolCall } from "./RenderToolCall";

let root: Root;
let container: HTMLDivElement;
let restore: () => void;
let restoreCanvas: () => void;
let clock = 0;
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const values: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		HTMLDivElement: window.HTMLDivElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		IS_REACT_ACT_ENVIRONMENT: true,
		getComputedStyle: () => ({ overflowY: "visible" }),
		matchMedia: () => ({
			matches: false,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
		}),
		requestAnimationFrame: (fn: FrameRequestCallback) => {
			frames.set(++frameId, fn);
			return frameId;
		},
		cancelAnimationFrame: (id: number) => frames.delete(id),
		ResizeObserver: class {
			observe() {}
			disconnect() {}
		},
	};
	const previous = new Map(
		Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	for (const [key, value] of Object.entries(values))
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	// linkedom shares one HTMLElement.prototype across every parseHTML window, so
	// these stubs are process-global and must be handed back (see AutoFollowScroll
	// .test.tsx): otherwise later test FILES inherit this file's fake layout.
	const geometryProto = window.HTMLElement.prototype;
	const previousGeometry = new Map(
		["scrollTop", "clientHeight", "clientWidth", "scrollHeight"].map((key) => [
			key,
			Object.getOwnPropertyDescriptor(geometryProto, key),
		]),
	);
	Object.defineProperties(geometryProto, {
		scrollTop: { configurable: true, writable: true, value: 0 },
		clientHeight: {
			configurable: true,
			get() {
				return 120;
			},
		},
		clientWidth: {
			configurable: true,
			get() {
				return 600;
			},
		},
		scrollHeight: {
			configurable: true,
			get() {
				return 2_000;
			},
		},
	});
	restore = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		for (const [key, descriptor] of previousGeometry) {
			if (descriptor) Object.defineProperty(geometryProto, key, descriptor);
			else Reflect.deleteProperty(geometryProto, key);
		}
	};
	restoreCanvas = installCanvasStub();
	frames.clear();
	clock = 0;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	expect(frames.size).toBe(0);
	container.remove();
	restoreCanvas();
	restore();
});

async function frame() {
	await act(async () => {
		clock += 16;
		const queue = [...frames];
		frames.clear();
		for (const [, callback] of queue) callback(clock);
	});
}
function card(opts: {
	toolName?: string;
	status?: ToolCallStatus;
	isStreaming?: boolean;
	inputJson?: unknown;
	outputJson?: unknown;
	metadata?: Record<string, unknown>;
}) {
	const toolName = opts.toolName ?? "Write";
	const category = toolName === "Bash" ? "bash" : toolName === "ExitPlanMode" ? "plan" : "file";
	const detail = classifyToolDetail({
		toolUseId: "call-1",
		category,
		...opts,
		status: opts.status ?? "running",
		toolName,
	});
	return measureToolCall(
		{
			toolUseId: "call-1",
			toolName,
			summary: "test",
			category,
			status: opts.status ?? "running",
			isStreaming: opts.isStreaming,
			detail,
		},
		620,
		5,
		{ opened: true },
	);
}
async function render(measured: ReturnType<typeof card>, controls?: VListViewControls) {
	await act(async () =>
		root.render(
			<MantineProvider>
				<RenderToolCall
					measured={measured}
					viewTargets={controls ? resolveToolDetailViewTargets("owner", measured) : undefined}
					viewControls={controls}
				/>
			</MantineProvider>,
		),
	);
	await frame();
}
function port(source: string): HTMLElement {
	const found = [...container.querySelectorAll<HTMLElement>("[data-content-scrollport]")].find(
		(node) => node.getAttribute("data-content-scrollport")?.includes(source),
	);
	if (!found) throw new Error(`missing body ${source}`);
	return found;
}
const controls: VListViewControls = {
	isWrapped: () => true,
	isSourceShown: () => false,
	toggleWrap() {},
	toggleSource() {},
	openFullscreen() {},
};

describe("tool bodies use one permanent viewport", () => {
	it("keeps Write identity across empty content, late path, settled state and toolbar arrival", async () => {
		await render(
			card({
				isStreaming: true,
				inputJson: { _streamingFieldName: "content", _streamingFieldValue: "" },
			}),
		);
		const node = port("input.content");
		await render(
			card({
				isStreaming: true,
				inputJson: {
					file_path: "late.ts",
					_streamingFieldName: "content",
					_streamingFieldValue: "line\n".repeat(80),
				},
			}),
			controls,
		);
		expect(port("input.content")).toBe(node);
		await render(
			card({ status: "success", inputJson: { file_path: "late.ts", content: "final" } }),
			controls,
		);
		expect(port("input.content")).toBe(node);
		expect(node.textContent).toContain("final");
	});
	it("gives both streaming command and execution output their own semantic viewport", async () => {
		await render(
			card({
				toolName: "Bash",
				isStreaming: true,
				inputJson: { _streamingFieldName: "command", _streamingFieldValue: "echo" },
			}),
		);
		const command = port("input.command");
		expect(command.getAttribute("data-following")).toBe("true");
		await render(
			card({
				toolName: "Bash",
				inputJson: { command: "echo hi" },
				outputJson: "hi",
				metadata: { _streamingOutput: true },
			}),
		);
		expect(port("input.command")).toBe(command);
		expect(port("output.main")).not.toBe(command);
		expect(port("output.main").getAttribute("data-following")).toBe("true");
	});
	it("opens static history at the head despite leftover output-stream metadata", async () => {
		await render(
			card({
				toolName: "Bash",
				status: "success",
				inputJson: { command: "echo hi", _streamingOutput: "stale" },
				outputJson: "history",
			}),
		);
		const output = port("output.main");
		expect(output.getAttribute("data-following")).toBe("false");
		expect(output.scrollTop).toBe(0);
	});
	it("an Edit grows from empty input without briefly reserving an empty 200px diff", async () => {
		await render(card({ toolName: "Edit", isStreaming: true, inputJson: {} }));
		expect(container.querySelector("[data-content-scrollport]")).toBeNull();
		let viewport: HTMLElement | undefined;
		let previousHeight = 0;
		for (const value of ["", "a", "a\nb\nc"]) {
			await render(
				card({
					toolName: "Edit",
					isStreaming: true,
					inputJson: { _streamingFieldName: "old_string", _streamingFieldValue: value },
				}),
			);
			const node = port("input.edit");
			viewport ??= node;
			expect(node).toBe(viewport);
			const height = Number.parseFloat(node.style.height);
			expect(height).toBeLessThan(200);
			expect(height).toBeGreaterThanOrEqual(previousHeight);
			previousHeight = height;
		}
		await render(
			card({
				toolName: "Edit",
				isStreaming: true,
				inputJson: {
					_streamingFieldName: "old_string",
					_streamingFieldValue: "line\n".repeat(100),
				},
			}),
		);
		if (!viewport) throw new Error("Streaming Edit viewport was never mounted");
		expect(port("input.edit")).toBe(viewport);
		expect(Number.parseFloat(port("input.edit").style.height)).toBe(200);
	});

	it("keeps one dynamic Diff painter from matching through replacing and completion", async () => {
		await render(
			card({
				toolName: "Edit",
				isStreaming: true,
				inputJson: { _streamingFieldName: "old_string", _streamingFieldValue: "one\ntwo" },
			}),
		);
		const viewport = port("input.edit");
		const diff = viewport.querySelector("[data-diff-content]");
		expect(diff).not.toBeNull();
		await render(
			card({
				toolName: "Edit",
				isStreaming: true,
				inputJson: {
					_streamingFields: { old_string: "one\ntwo" },
					_streamingFieldName: "new_string",
					_streamingFieldValue: "one\nnew",
				},
			}),
		);
		expect(port("input.edit")).toBe(viewport);
		expect(viewport.querySelector("[data-diff-content]")).toBe(diff);
		expect(viewport.querySelectorAll("[data-diff-row=added]").length).toBeGreaterThan(0);
		await render(
			card({
				toolName: "Edit",
				status: "success",
				inputJson: { file_path: "late.ts", old_string: "one\ntwo", new_string: "" },
			}),
		);
		expect(port("input.edit")).toBe(viewport);
		expect(viewport.querySelector("[data-diff-content]")).toBe(diff);
		expect(viewport.querySelectorAll("[data-diff-row=removed]").length).toBeGreaterThan(0);
	});
	it("keeps the viewport when switching markdown between pretext and source", async () => {
		const measured = card({
			toolName: "ExitPlanMode",
			status: "success",
			inputJson: { plan: "# Plan\n\n- first" },
		});
		await render(measured, controls);
		const viewport = port("input.plan");
		expect(viewport.querySelector("[data-tool-markdown]")).not.toBeNull();
		await render(measured, { ...controls, isSourceShown: () => true });
		expect(port("input.plan")).toBe(viewport);
		expect(viewport.textContent).toContain("# Plan");
	});
});
