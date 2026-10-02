import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import { MantineProvider } from "@mantine/core";
import {
	COMMUNICATION_PREVIEW_MAX_CHARS,
	limitCommunicationPreview,
} from "@shared/communication-tool";
import { resetTypographyForTest } from "@shared/pretext-layout/typography";
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RenderLodCtx } from "../../lod/RenderLodCtx";
import { segmentMessages } from "../../message/message-segments";
import type { NarratorMsg } from "../../narrator-panel-types";
import { groupRenderUnits } from "../../trace/render-units";
import type { MeasuredCommunicationBubble } from "../measure/measure-communication-bubble";
import type { MeasuredInjectionBubble } from "../measure/measure-injection-bubble";
import type { MeasuredSubagent, SubagentCardData } from "../measure/measure-subagent";
import type { MeasuredToolCall } from "../measure/measure-tool-call";
import { installCanvasStub } from "../measure/test-canvas-stub";
import type { MeasuredElement } from "../prepared-block";
import type { AdapterRenderUnit, CommunicationBubbleData, ElementSpec } from "../segment-adapter";
import { staticInlineMarkupCache } from "./static-inline-markup";

let adaptRenderUnits: typeof import("../segment-adapter").adaptRenderUnits;
let VLIST_REGISTRY: typeof import("../registry").VLIST_REGISTRY;
let renderElement: typeof import("../render-registry").renderElement;
let resolveRenderExtra: typeof import("../render-registry").resolveRenderExtra;
let measureActivityTrace: typeof import("../measure/measure-tool-run").measureActivityTrace;
let buildSelectionCopyText: typeof import("../vlist-copy-text").buildSelectionCopyText;
let resolveToolDetailViewTargets: typeof import("../vlist-content-view-target").resolveToolDetailViewTargets;
let disposeCanvas: () => void;

beforeAll(async () => {
	disposeCanvas = installCanvasStub();
	({ adaptRenderUnits } = await import("../segment-adapter"));
	({ VLIST_REGISTRY } = await import("../registry"));
	({ renderElement, resolveRenderExtra } = await import("../render-registry"));
	({ measureActivityTrace } = await import("../measure/measure-tool-run"));
	({ buildSelectionCopyText } = await import("../vlist-copy-text"));
	({ resolveToolDetailViewTargets } = await import("../vlist-content-view-target"));
});
afterAll(() => disposeCanvas());
beforeEach(() => {
	resetTypographyForTest();
	staticInlineMarkupCache.clear();
});
afterEach(() => {
	resetTypographyForTest();
	staticInlineMarkupCache.clear();
});

const WIDTH = 700;
const END = "END_OF_COMPLETE_MARKDOWN_末尾保留";

/** Same mixed Markdown producer at each entry, bounded BEFORE creating its persisted row. */
function fixture(budget: number) {
	const blocks = ["# 大正文审计"];
	const visible = ["大正文审计"];
	for (let i = 0; ; i++) {
		const prefix = ["", "> ", "- ", "- [x] "][i % 4] ?? "";
		const label = `P${String(i).padStart(4, "0")}`;
		const sentence =
			"中文 **mixedBold加粗** and *italic斜体* 与`inline.code`边界。 English complete body ";
		const paragraph = `${label} ${sentence.repeat(6)}段尾${label}`;
		const next = `${prefix}${paragraph}`;
		if ([...blocks, next, END].join("\n\n").length > budget) break;
		blocks.push(next);
		visible.push(
			`${label} ${"中文 mixedBold加粗 and italic斜体 与inline.code边界。 English complete body ".repeat(6)}段尾${label}`,
		);
	}
	blocks.push(END);
	visible.push(END);
	return { markdown: blocks.join("\n\n"), visible: visible.join("\n"), budget };
}
const LARGE = fixture(23_700);
// Send's inline preview has BOTH an 8Ki-character and 120-line ceiling; receive producer caps at 8000.
const COMMUNICATION = fixture(7_900);
// backgroundAgentNoticePreview retains at most 12000 chars; this is a complete report, not a pointer notice.
const BACKGROUND = fixture(11_900);

function message(id: string, role: string, contentJson: unknown[]): NarratorMsg {
	// Mirrors segment-adapter.integration.test's persisted message shape, not fabricated render data.
	return {
		id,
		narratorId: "large-body-narrator",
		parentToolUseId: null,
		role,
		contentJson,
		contentText: null,
		toolCalls: [],
		children: [],
		createdAt: "2026-01-01T00:00:00Z",
		seq: 1,
	} as unknown as NarratorMsg;
}
function tool(
	name: string,
	input: Record<string, unknown>,
	outputJson: unknown = { _text: "done" },
) {
	return message(`message-${name}`, "assistant", [
		{
			type: "tool_use",
			id: `tu-${name}`,
			name,
			input,
			inputJson: input,
			status: "success",
			outputJson,
		},
	]);
}
function injection(source: string, body: unknown, role = "sys") {
	return message(`message-${source}`, role, [
		{
			type: "system_injection",
			source,
			modelText: "MODEL_FACING_ONLY: do not show this instruction as the sender's speech.",
			body,
		},
	]);
}

function adapt(row: NarratorMsg): ElementSpec {
	const units = groupRenderUnits(segmentMessages([row]), false) as unknown as AdapterRenderUnit[];
	const specs = adaptRenderUnits(units, {
		lod: 5,
		isExpanded: () => true,
		resolveToolCategory: (name) =>
			name === "ExitPlanMode" ? "plan" : name === "Agent" ? "agent" : "send",
	});
	expect(specs).toHaveLength(1);
	const spec = specs[0];
	if (!spec) throw new Error("real adapter produced no spec");
	return spec;
}
function measure(spec: ElementSpec): MeasuredElement {
	const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, WIDTH, 5, spec.opts);
	expect(measured.height).toBeGreaterThan(0);
	return measured;
}
function render(node: ReactNode) {
	const document = parseHTML(
		`<html><body>${renderToStaticMarkup(
			<MantineProvider>
				<RenderLodCtx.Provider value={{ lod: 5, interactive: true }}>{node}</RenderLodCtx.Provider>
			</MantineProvider>,
		)}</body></html>`,
	).document;
	return document;
}
const originalDocuments = new WeakMap<Document, Document>();
function rememberOriginal(node: ReactNode, document: Document) {
	const spy = spyOn(staticInlineMarkupCache, "get").mockImplementation((_block, _width, lines) =>
		lines.map(() => null),
	);
	try {
		originalDocuments.set(document, render(node));
	} finally {
		spy.mockRestore();
	}
	return document;
}
function paint(spec: ElementSpec, measured: MeasuredElement) {
	const node = renderElement(spec.kind, measured, resolveRenderExtra(spec));
	const spy = spyOn(staticInlineMarkupCache, "get");
	let document: Document;
	try {
		document = render(node);
		expect(spy).toHaveBeenCalled();
		expect(
			spy.mock.results.some(
				(result) =>
					Array.isArray(result.value) && result.value.some((line) => typeof line === "string"),
			),
		).toBe(true);
	} finally {
		spy.mockRestore();
	}
	return rememberOriginal(node, document);
}

const compact = (text: string) => text.replace(/\s/g, "");
function completeBody(document: Document) {
	// A subagent also paints its short description through RenderMarkdown; select
	// the result body by its unique tail, then require exactly one complete copy.
	const bodies = [...document.querySelectorAll("[data-md-body]")].filter((body) =>
		body.textContent?.includes(END),
	);
	expect(bodies).toHaveLength(1);
	const body = bodies[0];
	if (!body) throw new Error("complete result body was not rendered");
	return body;
}
function copyBody(body: Element) {
	const range = {
		startContainer: body,
		startOffset: 0,
		endContainer: body,
		endOffset: body.childNodes.length,
		commonAncestorContainer: body,
	} as unknown as Range;
	return buildSelectionCopyText(range, body);
}
function assertBody(document: Document, expected: ReturnType<typeof fixture>) {
	const body = completeBody(document);
	const originalDocument = originalDocuments.get(document);
	if (!originalDocument) throw new Error("missing actual React-path reference render");
	const originalBody = completeBody(originalDocument);
	const fragments = [...body.querySelectorAll("[data-vlist-line-frags]")];
	expect(fragments.length).toBeGreaterThan(100);
	// Every character, not just the prefix or marker, reaches the visible fragment DOM.
	expect(compact(fragments.map((node) => node.textContent).join(""))).toBe(
		compact(expected.visible),
	);
	expect(fragments.map((node) => node.textContent)).toEqual(
		[...originalBody.querySelectorAll("[data-vlist-line-frags]")].map((node) => node.textContent),
	);
	expect(body.textContent).toContain(END);
	expect(body.querySelector(".is-strong")).not.toBeNull();
	expect(body.querySelector(".vlist-frag--code")).not.toBeNull();
	for (const line of body.querySelectorAll("[data-vlist-line]")) {
		const host = line.querySelector("[data-vlist-line-frags]");
		expect(host).not.toBeNull();
		if (!host) throw new Error("line is missing its copyable wrapper");
		expect([...line.children]).toEqual([host]);
		expect(host?.getAttribute("style")).toContain("flex-shrink:0");
	}
	// Real clipboard reconstruction against the rendered DOM, not a mocked renderer/string snapshot.
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Node");
	Object.defineProperty(globalThis, "Node", {
		configurable: true,
		value: document.defaultView?.Node,
	});
	try {
		const copied = copyBody(body);
		expect(copied).not.toBeNull();
		if (copied === null) throw new Error("real copy collector returned no body text");
		// Current pretext can discard a space at a fragment's soft-wrap boundary.
		// Preserve the actual React branch byte-for-byte; independently prove every
		// non-whitespace source character survives rather than accepting a prefix.
		const originalCopy = copyBody(originalBody);
		if (originalCopy === null) throw new Error("actual React reference could not be copied");
		expect(copied).toBe(originalCopy);
		expect(compact(copied)).toBe(compact(expected.visible));
		expect(copied).toContain(END);
	} finally {
		if (descriptor) Object.defineProperty(globalThis, "Node", descriptor);
		else Reflect.deleteProperty(globalThis, "Node");
	}
}

const controls = {
	isWrapped: () => true,
	isSourceShown: () => true,
	toggleWrap: () => {},
	toggleSource: () => {},
	openFullscreen: () => {},
};

describe("large Markdown: six production measure/render entry points", () => {
	test("assistant: real message segmentation → adapter → Markdown measure → render", () => {
		expect(LARGE.markdown.length).toBeGreaterThan(23_000);
		expect(LARGE.markdown.length).toBeLessThanOrEqual(LARGE.budget);
		const spec = adapt(
			message("ordinary-assistant", "assistant", [{ type: "text", text: LARGE.markdown }]),
		);
		expect(spec.kind).toBe("markdown");
		assertBody(paint(spec, measure(spec)), LARGE);
		expect(spec.data).toBe(LARGE.markdown);
	});

	test("ExitPlanMode: actual classifyPlan → tool measure → RenderToolBody keeps the entire 23K plan", () => {
		const spec = adapt(tool("ExitPlanMode", { plan: LARGE.markdown }));
		expect(spec.kind).toBe("tool-call");
		const measured = measure(spec) as MeasuredToolCall;
		const targets = resolveToolDetailViewTargets(spec.key, measured);
		expect(targets).toHaveLength(1);
		expect(targets[0]?.model).toMatchObject({
			format: "markdown",
			text: LARGE.markdown,
			source: "input.plan",
		});
		assertBody(paint(spec, measured), LARGE);
		const extra = { ...resolveRenderExtra(spec), viewTargets: targets, viewControls: controls };
		const source = render(renderElement(spec.kind, measured, extra));
		expect(source.querySelector("[data-tool-markdown]")).toBeNull();
		expect(source.querySelector("[data-content-scrollport]")?.firstElementChild?.textContent).toBe(
			LARGE.markdown,
		);
	});

	test("Send outgoing: bounded complete body still reaches DOM after the 480px scroll cap", () => {
		expect(limitCommunicationPreview(COMMUNICATION.markdown)).toEqual({
			text: COMMUNICATION.markdown,
			truncated: false,
		});
		const spec = adapt(
			tool(
				"Send",
				{ id: "worker", message: COMMUNICATION.markdown },
				{
					_text: "Sent",
					_metadata: {
						targets: [{ id: "worker", label: "Reviewer", deliveryMessageId: "receipt-real" }],
					},
				},
			),
		);
		expect(spec.kind).toBe("communication-bubble");
		const data = spec.data as CommunicationBubbleData;
		expect(data.message).toBe(COMMUNICATION.markdown);
		expect(data.messageTruncated).toBe(false);
		expect(data.toolUseId).toBe("tu-Send");
		expect(data.recipients[0]).toMatchObject({ id: "worker", deliveryMessageId: "receipt-real" });
		const measured = measure(spec) as MeasuredCommunicationBubble;
		const document = paint(spec, measured);
		assertBody(document, COMMUNICATION);
		expect(document.querySelector("[data-vlist-communication-frame]")).not.toBeNull();
		expect(
			document.querySelector("[data-vlist-communication-row]")?.getAttribute("style"),
		).toContain("justify-content:flex-start");
		expect(
			document.querySelector("[data-vlist-communication-body]")?.getAttribute("style"),
		).toContain("height:480px");
	});

	for (const source of ["subagent_message", "team_message"]) {
		test(`Send received ${source}: injected user-role transport is not a human input bubble or a 480px cap`, () => {
			expect(COMMUNICATION.markdown.length).toBeLessThanOrEqual(8_000);
			const spec = adapt(
				injection(
					source,
					{
						kind: "messages",
						items: [
							{
								fromId: "real-sender",
								fromTitle: "Sender title",
								fromType: "subagent",
								fromMessageId: "sending-message",
								fromToolUseId: "sending-tool",
								text: COMMUNICATION.markdown,
							},
						],
					},
					"user",
				),
			);
			expect(spec.kind).toBe("injection-bubble");
			expect(spec.data).toMatchObject({
				markdown: COMMUNICATION.markdown,
				speakerId: "real-sender",
				target: { kind: "narrator", narratorId: "real-sender", messageId: "sending-tool" },
			});
			const measured = measure(spec) as MeasuredInjectionBubble;
			expect(measured.height).toBeGreaterThan(480);
			const document = paint(spec, measured);
			assertBody(document, COMMUNICATION);
			expect(document.querySelector("[data-vlist-injection-frame]")).not.toBeNull();
			expect(document.querySelector("[data-vlist-injection-row]")?.getAttribute("style")).toContain(
				"justify-content:flex-start",
			);
			expect(document.querySelector("[data-vlist-communication-body]")).toBeNull();
			expect(
				document.querySelector("[data-vlist-injection-body]")?.getAttribute("style"),
			).not.toContain("height:480px");
			expect(document.body.textContent).not.toContain("MODEL_FACING_ONLY");
		});
	}

	test("bg_agent: complete producer-budget report retains its own result navigation id", () => {
		expect(BACKGROUND.markdown.length).toBeLessThanOrEqual(12_000);
		expect(BACKGROUND.markdown.length).toBeGreaterThan(11_000);
		const spec = adapt(
			injection("bg_agent", {
				kind: "tasksDone",
				flavor: "agent",
				items: [
					{
						id: "bg-real",
						alias: "audit",
						title: "Background audit",
						status: "success",
						preview: BACKGROUND.markdown,
						resultMessageId: "result-real",
					},
				],
			}),
		);
		expect(spec.kind).toBe("injection-bubble");
		expect(spec.data).toMatchObject({
			markdown: BACKGROUND.markdown,
			target: { kind: "narrator", narratorId: "bg-real", messageId: "result-real" },
		});
		assertBody(paint(spec, measure(spec)), BACKGROUND);
	});

	test("subagent result: real output envelope → SubagentBody → RenderToolBody, direct and trace drill", () => {
		const spec = adapt(
			tool(
				"Agent",
				{
					subagent_type: "explore",
					description: "Inspect complete result",
					prompt: "Read the repository",
				},
				{ _text: LARGE.markdown, _metadata: { subagentNarratorId: "child-real" } },
			),
		);
		expect(spec.kind).toBe("subagent-card");
		const measured = measure(spec) as MeasuredSubagent;
		expect(measured.resultMeasured).not.toBeNull();
		expect(spec.data).toMatchObject({
			toolUseId: "tu-Agent",
			resultText: LARGE.markdown,
			resultBody: { source: "output.main", format: "markdown", text: LARGE.markdown },
		});
		assertBody(paint(spec, measured), LARGE);
		// Same drilled-card fixture shape as RenderToolRun.drilldown.test, but its card
		// is derived from the shared adapter above rather than hand-authoring a false result.
		const trace = measureActivityTrace(
			[
				{
					title: "Agent · Inspect complete result",
					hasIcon: true,
					key: spec.key,
					canDrillDown: true,
					card: spec.data as SubagentCardData,
					cardKind: "subagent-card",
				},
			],
			WIDTH,
			{ expandedIndices: [0] },
			{},
			2,
		);
		expect(trace.rows[0]?.cardKind).toBe("subagent-card");
		expect(trace.rows[0]?.cardMeasured).not.toBeNull();
		const extra = {
			rowCard: (row: (typeof trace.rows)[number]) =>
				row.cardMeasured && row.cardKind === "subagent-card"
					? renderElement("subagent-card", row.cardMeasured, resolveRenderExtra(spec))
					: null,
		};
		const traceNode = renderElement("activity-trace", trace, extra);
		assertBody(rememberOriginal(traceNode, render(traceNode)), LARGE);
	});

	test("Send larger than preview budget explicitly reports truncation instead of pretending to show all 23K", () => {
		const spec = adapt(tool("Send", { id: "worker", message: LARGE.markdown }));
		const data = spec.data as CommunicationBubbleData;
		const preview = limitCommunicationPreview(LARGE.markdown);
		expect(preview.truncated).toBe(true);
		expect(data.message).toBe(preview.text);
		expect(data.message.length).toBeLessThanOrEqual(COMMUNICATION_PREVIEW_MAX_CHARS);
		expect(data.messageTruncated).toBe(true);
		expect(data.messageBody?.text).toBe(LARGE.markdown);
		const document = paint(spec, measure(spec));
		expect(document.querySelector("[data-vlist-communication-frame]")).not.toBeNull();
		expect(document.querySelector("[data-vlist-communication-view-full]")).not.toBeNull();
		expect(document.querySelector("[data-md-body]")?.textContent).not.toContain(END);
	});
});
