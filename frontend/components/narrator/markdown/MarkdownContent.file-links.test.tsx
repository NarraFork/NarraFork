import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MD_HEADING_SLUG_ATTR } from "@frontend/lib/markdown-anchor-scroll";
import { MantineProvider } from "@mantine/core";
import type { FileTarget } from "@shared/file-reference";
import { fileTargetFromHref } from "@shared/markdown-file-path";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FileReferenceScopeProvider, type FileReferenceScopeValue } from "../FileReferenceScope";
import { MarkdownContent } from "./MarkdownContent";

const { installCanvasStub } = await import("../vlist/measure/test-canvas-stub");

type Renderer = "flowing" | "prepared";
const context = { deviceId: "CapturedDevice", cwd: "/repo" };
const globals = [
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"Element",
	"Node",
	"Text",
	"getComputedStyle",
	"matchMedia",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;
let previousGlobals: Map<string, PropertyDescriptor | undefined>;
let disposeCanvas: () => void;
let container: HTMLDivElement;
let root: Root;
let animationId = 0;

beforeEach(() => {
	previousGlobals = new Map(
		globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	disposeCanvas = installCanvasStub();
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	Object.assign(globalThis, {
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
	});
	document.documentElement.setAttribute("data-advanced-anim", "true");
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	animationId++;
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	disposeCanvas();
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

async function render(
	renderer: Renderer,
	text: string,
	options: { scope?: FileReferenceScopeValue; streaming?: boolean; width?: number } = {},
) {
	const { measureMarkdown } = await import("../vlist/measure/measure-markdown");
	const { RenderMarkdown } = await import("../vlist/render/RenderMarkdown");
	const content =
		renderer === "flowing" ? (
			<MarkdownContent text={text} streaming={options.streaming} />
		) : (
			<RenderMarkdown
				measured={measureMarkdown(text, options.width ?? 800)}
				animateStreaming={options.streaming}
				animKeyBase={`file-links-${animationId}`}
				animScope={`file-links-${animationId}`}
			/>
		);
	await act(async () => {
		root.render(
			<MantineProvider env="test">
				{options.scope ? (
					<FileReferenceScopeProvider value={options.scope}>{content}</FileReferenceScopeProvider>
				) : (
					content
				)}
			</MantineProvider>,
		);
	});
}

function anchors() {
	return Array.from(container.querySelectorAll<HTMLAnchorElement>("a[href]"));
}

function distinctAnchors() {
	return [...new Map(anchors().map((anchor) => [anchor.getAttribute("href"), anchor])).values()];
}

function click(anchor: Element) {
	const event = new window.Event("click", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "button", { value: 0 });
	act(() => {
		anchor.dispatchEvent(event);
	});
	expect(event.defaultPrevented).toBe(true);
}

for (const renderer of ["flowing", "prepared"] as const) {
	describe(`${renderer} file navigation`, () => {
		test("opens authored links, including code labels, with the captured device and selection", async () => {
			const opened: FileTarget[] = [];
			await render(
				renderer,
				[
					"See [src/a.ts](src/a.ts:2:3-4:5) and [`docs/my notes.md`](docs/my%20notes.md#L6-L8).",
					"[file](file:///tmp/b.ts#L9) [windows](C:/repo/c.ts#L10)",
					"[remote](nf-file://open?device=OtherCase&path=%2Fapp%2Fd.ts#L11)",
					"[relative](src/e.ts#L12-L13)",
				].join("\n\n"),
				{ scope: { context, openFile: (target) => opened.push(target) } },
			);
			const found = distinctAnchors();
			expect(found).toHaveLength(6);
			for (const anchor of found) {
				expect(anchor.getAttribute("target")).toBeNull();
				click(anchor);
			}
			expect(opened).toEqual([
				{
					deviceId: "CapturedDevice",
					path: "/repo/src/a.ts",
					selection: { startLineNumber: 2, startColumn: 3, endLineNumber: 4, endColumn: 5 },
				},
				{
					deviceId: "CapturedDevice",
					path: "/repo/docs/my notes.md",
					selection: { startLineNumber: 6, startColumn: 1, endLineNumber: 9, endColumn: 1 },
				},
				{
					deviceId: "CapturedDevice",
					path: "/tmp/b.ts",
					selection: { startLineNumber: 9, startColumn: 1, endLineNumber: 10, endColumn: 1 },
				},
				{
					deviceId: "CapturedDevice",
					path: "C:/repo/c.ts",
					selection: { startLineNumber: 10, startColumn: 1, endLineNumber: 11, endColumn: 1 },
				},
				{
					deviceId: "OtherCase",
					path: "/app/d.ts",
					selection: { startLineNumber: 11, startColumn: 1, endLineNumber: 12, endColumn: 1 },
				},
				{
					deviceId: "CapturedDevice",
					path: "/repo/src/e.ts",
					selection: { startLineNumber: 12, startColumn: 1, endLineNumber: 14, endColumn: 1 },
				},
			]);
		});

		test("renders the single line or range from authored inline and reference-style links", async () => {
			const opened: FileTarget[] = [];
			await render(renderer, "[single](src/a.ts#L10) [range][lines]\n\n[lines]: src/b.ts#L10-L20", {
				scope: { context, openFile: (target) => opened.push(target) },
			});
			expect(anchors().map((anchor) => anchor.textContent)).toEqual(["single:10", "range:10-20"]);
			expect(anchors().map((anchor) => anchor.title)).toEqual([
				"/repo/src/a.ts:10",
				"/repo/src/b.ts:10-20",
			]);
			for (const anchor of anchors()) click(anchor);
			expect(opened.map((target) => target.selection)).toEqual([
				{ startLineNumber: 10, startColumn: 1, endLineNumber: 11, endColumn: 1 },
				{ startLineNumber: 10, startColumn: 1, endLineNumber: 21, endColumn: 1 },
			]);
		});

		test("does not repeat line numbers already written in the link label", async () => {
			await render(renderer, "[a.ts:10-20](src/a.ts#L10-L20) [`b.ts#L3`](src/b.ts#L3)", {
				scope: { context, openFile() {} },
				streaming: true,
			});
			expect(anchors().map((anchor) => anchor.textContent)).toEqual(["a.ts:10-20", "b.ts#L3"]);
		});

		test("keeps heading anchors based on the authored label rather than its added line suffix", async () => {
			await render(renderer, "## See [file](src/a.ts#L10)\n\n[Jump](#see-file)", {
				scope: { context, openFile() {} },
			});
			const heading = container.querySelector(`[${MD_HEADING_SLUG_ATTR}="see-file"]`);
			expect(heading).not.toBeNull();
			expect(heading?.textContent).toContain("file:10");
			expect(
				anchors()
					.find((anchor) => anchor.textContent === "Jump")
					?.getAttribute("href"),
			).toBe("#see-file");
		});

		test("does not infer file links from adjoining Chinese prose or inline code", async () => {
			const prose = "核对：实际调用只剩diff-core.test.ts、DiffView.tsx中的computeDiff。";
			const opened: FileTarget[] = [];
			await render(renderer, `${prose}\n\n\`中文diff-core.test.ts\` src/a.ts:2 /tmp/a.ts`, {
				scope: { context, openFile: (target) => opened.push(target) },
			});
			expect(anchors()).toEqual([]);
			expect(container.textContent).toContain(prose);
			expect(container.textContent).toContain("中文diff-core.test.ts");
			expect(opened).toEqual([]);
		});

		test("uses authored boundaries and preserves complete Chinese filenames", async () => {
			const opened: FileTarget[] = [];
			await render(
				renderer,
				"核对：实际调用只剩[diff-core.test.ts](shared/pretext-layout/diff-core.test.ts#L2)、[中文文件](中文diff-core.test.ts#L3)以及[真正的文件](实际调用只剩diff-core.test.ts#L4)。",
				{ scope: { context, openFile: (target) => opened.push(target) } },
			);
			const found = anchors();
			expect(found.map((anchor) => anchor.textContent)).toEqual([
				"diff-core.test.ts:2",
				"中文文件:3",
				"真正的文件:4",
			]);
			for (const anchor of found) click(anchor);
			expect(opened.map((target) => [target.path, target.selection?.startLineNumber])).toEqual([
				["/repo/shared/pretext-layout/diff-core.test.ts", 2],
				["/repo/中文diff-core.test.ts", 3],
				["/repo/实际调用只剩diff-core.test.ts", 4],
			]);
		});

		test("opens authored file links in table cells and list items", async () => {
			const opened: FileTarget[] = [];
			await render(
				renderer,
				"- [list](src/list.ts#L2)\n\n| File | Code |\n|---|---|\n| [table](src/table.ts:3) | [`src/code.ts`](src/code.ts#L4-L5) |",
				{ scope: { context, openFile: (target) => opened.push(target) } },
			);
			expect(
				anchors()
					.map((anchor) => anchor.textContent)
					.join(""),
			).toBe("list:2table:3src/code.ts:4-5");
			for (const anchor of distinctAnchors()) click(anchor);
			expect(
				opened.map((target) => [
					target.path,
					target.selection?.startLineNumber,
					target.selection?.endLineNumber,
				]),
			).toEqual([
				["/repo/src/list.ts", 2, 3],
				["/repo/src/table.ts", 3, 4],
				["/repo/src/code.ts", 4, 6],
			]);
		});

		test("keeps automatic paths and special file destinations inert without a scope", async () => {
			await render(
				renderer,
				"src/a.ts#L2 and `src/b.ts` [file](file:///tmp/c.ts#L3) [windows](C:/repo/d.ts) [remote](nf-file://open?device=RemoteCase&path=%2Fapp%2Fe.ts)",
			);
			expect(anchors()).toEqual([]);
			expect(container.querySelector(".is-link")).toBeNull();
			for (const label of ["src/a.ts#L2", "src/b.ts", "file", "windows", "remote"]) {
				expect(container.textContent).toContain(label);
			}
		});

		test("does not guess missing historical context but accepts an explicit device", async () => {
			const opened: FileTarget[] = [];
			await render(
				renderer,
				"src/a.ts [old](src/a.ts#L2) [explicit](nf-file://open?device=RemoteCase&path=%2Fapp%2Fb.ts#L2)",
				{ scope: { context: null, openFile: (target) => opened.push(target) } },
			);
			const [anchor] = anchors();
			expect(anchors()).toHaveLength(1);
			if (!anchor) throw new Error("missing explicit file link");
			click(anchor);
			expect(opened).toEqual([
				{
					deviceId: "RemoteCase",
					path: "/app/b.ts",
					selection: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 1 },
				},
			]);
		});

		test("preserves external links, application routes and anchors without relinking their labels", async () => {
			const opened: FileTarget[] = [];
			await render(
				renderer,
				"[src/a.ts `src/b.ts`](https://example.com/docs) [route](/knowledge/e1) [section](#fragment) [src/c.ts `src/d.ts`](javascript:alert(1))",
				{ scope: { context, openFile: (target) => opened.push(target) } },
			);
			const found = anchors().filter((anchor) => anchor.getAttribute("href"));
			expect(
				found.some(
					(anchor) =>
						fileTargetFromHref(anchor.getAttribute("href") ?? undefined, context) !== null,
				),
			).toBe(false);
			expect(
				found.some((anchor) => anchor.getAttribute("href") === "https://example.com/docs"),
			).toBe(true);
			for (const anchor of found) {
				expect(anchor.getAttribute("target")).toBe(
					anchor.getAttribute("href") === "#fragment" ? null : "_blank",
				);
			}
			expect(container.querySelector("a a")).toBeNull();
			expect(container.textContent).toContain("src/c.ts");
			expect(opened).toEqual([]);
		});

		test("opens repeated streaming references without dropping animation", async () => {
			const opened: FileTarget[] = [];
			const options = {
				streaming: true,
				scope: { context, openFile: (target: FileTarget) => opened.push(target) },
			};
			await render(
				renderer,
				"## Files\n\nStable [src/stable.ts](src/stable.ts#L2)\n\nTail [src/live.ts](src/live.ts#L",
				options,
			);
			expect(anchors().some((anchor) => anchor.textContent?.includes("live"))).toBe(false);
			await render(
				renderer,
				"## Files\n\nStable [src/stable.ts](src/stable.ts#L2)\n\nTail [src/live.ts](src/live.ts#L4)",
				options,
			);
			const live = anchors().find((anchor) => anchor.textContent?.includes("live"));
			expect(live).toBeDefined();
			if (!live) throw new Error("missing live link");
			click(live);
			click(live);
			expect(opened).toEqual(
				Array(2).fill({
					deviceId: "CapturedDevice",
					path: "/repo/src/live.ts",
					selection: { startLineNumber: 4, startColumn: 1, endLineNumber: 5, endColumn: 1 },
				}),
			);
			expect(
				container.querySelector(
					renderer === "flowing" ? "[data-markdown-segment-id]" : ".vlist-anim-token",
				),
			).not.toBeNull();
		});
	});
}

test("every prepared wrapped link fragment preserves the target and measured geometry", async () => {
	const opened: FileTarget[] = [];
	const path = `src/${"directory/".repeat(20)}a.ts#L12-L14`;
	const text = `[\`${path}\`](${path})`;
	await render("prepared", text, { width: 140, scope: { context: null } });
	const inertStyles = Array.from(container.querySelectorAll(".vlist-frag"), (node) =>
		node.getAttribute("style"),
	);
	const inertBodyStyle = container.querySelector("[data-md-body]")?.getAttribute("style");
	await render("prepared", text, {
		width: 140,
		scope: { context, openFile: (target) => opened.push(target) },
	});
	const found = anchors();
	expect(found.length).toBeGreaterThan(1);
	for (const anchor of found) {
		expect(anchor.className).toContain("vlist-frag--code");
		expect(anchor.className).toContain("is-link");
		click(anchor);
	}
	for (const target of opened) expect(target).toEqual(opened[0]);
	expect(opened[0]?.selection).toEqual({
		startLineNumber: 12,
		startColumn: 1,
		endLineNumber: 15,
		endColumn: 1,
	});
	expect(found.map((anchor) => anchor.getAttribute("style"))).toEqual(inertStyles);
	expect(container.querySelector("[data-md-body]")?.getAttribute("style")).toEqual(inertBodyStyle);
});
