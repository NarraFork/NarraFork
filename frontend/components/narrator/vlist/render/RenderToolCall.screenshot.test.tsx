/**
 * RenderToolCall.screenshot.test.tsx — DATA-CHAIN contract for a BROWSER /
 * WEBFETCH SCREENSHOT in the virtual list: real segmentMessages → real adapter →
 * real measure → real render, asserting an actual `<img>` with the right `src`
 * reaches the DOM.
 *
 * WHAT THIS DOES AND DOES NOT COVER
 *
 * It covers the CHAIN, not the URL's lifetime. `previewUrl` has to survive
 * segmentation, adaptation (`_metadata` lookup), classification into a media cap,
 * measurement, and the render layer's image resolution — five layers whose unit
 * tests all pass while the picture is still missing. Same reasoning as
 * RenderMedia.imggen.test.tsx, whose header records generated images going
 * invisible because the adapter dropped `savedPath`. If someone stops carrying
 * `_metadata` through the adapter, this is what fails.
 *
 * It does NOT reproduce the bug where old screenshots turned blank because their
 * share EXPIRED after an hour — a `previewUrl` that no longer resolves still
 * renders a correct `<img src=...>` here. That policy is pinned separately by
 * server/lib/__tests__/screenshot-share-expiry.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageViewerProvider } from "../../../common/ImageViewerProvider";
import { segmentMessages } from "../../message/message-segments";
import type { NarratorMsg } from "../../narrator-panel-types";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { VLIST_REGISTRY } from "../registry";
import { renderElement, resolveRenderExtra } from "../render-registry";
import { type AdapterContext, type AdapterSegment, adaptSegments } from "../segment-adapter";

const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

let parse: (html: string) => Element;

beforeAll(() => {
	parse = (html: string) => {
		const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
		const root = document.getElementById("r");
		if (!root) throw new Error("no root");
		return root as unknown as Element;
	};
});

const CONTENT_WIDTH = 800;

/** LOD 5 expands every card, so the detail region (and its image) is painted. */
const CTX: AdapterContext = {
	lod: 5,
	resolveToolCategory: (toolName: string) => (toolName === "Browser" ? "browser" : "webFetch"),
};

function renderWithProviders(node: React.ReactNode): Element {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	return parse(
		renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<MantineProvider forceColorScheme="dark">
					<ImageViewerProvider>{node}</ImageViewerProvider>
				</MantineProvider>
			</QueryClientProvider>,
		),
	);
}

/**
 * A realistic assistant message carrying one completed screenshot tool call, in
 * the shape the backend actually sends (enriched tool_use block + toolCalls row,
 * with the screenshot metadata nested under outputJson._metadata).
 */
function screenshotMessage(opts: {
	toolName: "Browser" | "WebFetch";
	inputJson: Record<string, unknown>;
	text: string;
	metadata: Record<string, unknown>;
}): NarratorMsg {
	const outputJson = { _text: opts.text, _metadata: opts.metadata };
	return {
		id: `a-${opts.toolName}`,
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: [
			{
				type: "tool_use",
				id: "tu-shot",
				name: opts.toolName,
				input: opts.inputJson,
				inputJson: opts.inputJson,
				outputJson,
				status: "completed",
			},
		],
		contentText: null,
		toolCalls: [
			{
				toolUseId: "tu-shot",
				toolName: opts.toolName,
				inputJson: opts.inputJson,
				outputJson,
				status: "completed",
			},
		],
		createdAt: "2026-01-01T00:00:00Z",
		children: [],
	} as unknown as NarratorMsg;
}

/** Drive the full chain and return the rendered DOM for the tool-call spec. */
function renderScreenshot(msg: NarratorMsg): Element {
	const segments = segmentMessages([msg]) as unknown as AdapterSegment[];
	const specs = adaptSegments(segments, CTX);
	const spec = specs.find((s) => s.kind === "tool-call" || s.kind === "tool-call-group");
	if (!spec) throw new Error(`no tool-call spec, got: ${specs.map((s) => s.kind).join(",")}`);
	const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, CONTENT_WIDTH, 5, spec.opts);
	const extra = resolveRenderExtra(spec);
	extra.narratorId = "n1";
	return renderWithProviders(renderElement(spec.kind, measured, extra));
}

const imgsOf = (root: Element) => Array.from(root.querySelectorAll("img"));

describe("screenshot reaches the DOM (virtual list)", () => {
	it("renders an <img> for a Browser screenshot", () => {
		// The exact metadata server/lib/agent/tools/browser.ts persists.
		const root = renderScreenshot(
			screenshotMessage({
				toolName: "Browser",
				inputJson: { action: "screenshot", session_id: "xKIoNzQ5" },
				text: "Screenshot captured (1280x900)",
				metadata: {
					sessionId: "xKIoNzQ5",
					screenshotPreview: true,
					previewUrl: "/api/shares/Guvcda6o/preview",
					width: 1280,
					height: 900,
					execDurationMs: 152,
				},
			}),
		);
		const imgs = imgsOf(root);
		expect(imgs).toHaveLength(1);
		expect(imgs[0]?.getAttribute("src")).toBe("/api/shares/Guvcda6o/preview");
	});

	it("renders an <img> for a WebFetch screenshot", () => {
		// The exact metadata server/lib/agent/tools/web-fetch.ts persists.
		const root = renderScreenshot(
			screenshotMessage({
				toolName: "WebFetch",
				inputJson: { url: "https://example.com", mode: "screenshot" },
				text: "Screenshot of https://example.com (1280x900)",
				metadata: {
					screenshotPreview: true,
					previewUrl: "/api/shares/sAMuG0aE/preview",
					width: 1280,
					height: 900,
				},
			}),
		);
		const imgs = imgsOf(root);
		expect(imgs).toHaveLength(1);
		expect(imgs[0]?.getAttribute("src")).toBe("/api/shares/sAMuG0aE/preview");
	});
});
