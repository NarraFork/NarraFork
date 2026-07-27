/**
 * RenderToolCall.screenshot-live.test.tsx — The LIVE (in-session) screenshot path.
 *
 * RenderToolCall.screenshot.test.tsx covers the RELOADED shape, where the server
 * has persisted `outputJson = { _text, _metadata }`. But during a live session the
 * card is updated by the WS live-patch channel instead, and `tool_completed`
 * delivers the output and the metadata as SEPARATE arguments:
 *
 *     onToolCompleted(toolUseId, status, output, durationMs, updatedInput, metadata, …)
 *
 * `toolCompletedPatch` therefore writes a bare-string `outputJson` plus a separate
 * `_metadata` field — a DIFFERENT shape from the persisted one, resolved by a
 * different branch of the adapter's metadata lookup. This drives that live shape
 * so a change to either the patch's field set or that lookup cannot silently
 * blank live screenshots while the reloaded path keeps working.
 *
 * Like its sibling, this covers the DATA CHAIN, not the share's lifetime: an
 * expired `previewUrl` still renders a correct `<img src=...>` here. The expiry
 * policy is pinned by server/lib/__tests__/screenshot-share-expiry.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageViewerProvider } from "../../../common/ImageViewerProvider";
import { segmentMessages } from "../../message-segments";
import type { NarratorMsg } from "../../narrator-panel-types";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { VLIST_REGISTRY } from "../registry";
import { renderElement, resolveRenderExtra } from "../render-registry";
import { type AdapterContext, type AdapterSegment, adaptSegments } from "../segment-adapter";
import { toolCompletedPatch } from "../vlist-live-events";

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
const CTX: AdapterContext = {
	lod: 6,
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

/** A still-RUNNING screenshot tool call, as it exists before the result lands. */
function runningScreenshotDoc(): NarratorMsg[] {
	const inputJson = { action: "screenshot", session_id: "xKIoNzQ5" };
	return [
		{
			id: "m-live",
			narratorId: "n1",
			parentToolUseId: null,
			role: "assistant",
			contentJson: [
				{
					type: "tool_use",
					id: "tu-live",
					name: "Browser",
					input: inputJson,
					inputJson,
					status: "running",
				},
			],
			contentText: null,
			toolCalls: [
				{
					id: "tc-tu-live",
					narratorId: "n1",
					messageId: "m-live",
					toolUseId: "tu-live",
					toolName: "Browser",
					inputJson,
					status: "running",
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			],
			createdAt: "2026-01-01T00:00:00.000Z",
			children: [],
		} as unknown as NarratorMsg,
	];
}

/** Render whatever the given message list produces for its tool-call spec. */
function renderDoc(messages: readonly NarratorMsg[]): Element {
	const segments = segmentMessages(messages as NarratorMsg[]) as unknown as AdapterSegment[];
	const specs = adaptSegments(segments, CTX);
	const spec = specs.find((s) => s.kind === "tool-call" || s.kind === "tool-call-group");
	if (!spec) throw new Error(`no tool-call spec, got: ${specs.map((s) => s.kind).join(",")}`);
	const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, CONTENT_WIDTH, 6, spec.opts);
	const extra = resolveRenderExtra(spec);
	extra.narratorId = "n1";
	return renderWithProviders(renderElement(spec.kind, measured, extra));
}

const imgsOf = (root: Element) => Array.from(root.querySelectorAll("img"));

describe("live screenshot completion reaches the DOM", () => {
	it("renders an <img> after tool_completed delivers output + metadata separately", () => {
		// Exactly what useVListLivePatches passes on a real `tool_completed`: the
		// output text and the metadata arrive as two independent arguments.
		const patched = toolCompletedPatch({
			toolUseId: "tu-live",
			status: "success",
			output: "Screenshot captured (1280x900)",
			durationMs: 152,
			metadata: {
				sessionId: "xKIoNzQ5",
				screenshotPreview: true,
				previewUrl: "/api/shares/Guvcda6o/preview",
				width: 1280,
				height: 900,
			},
		})(runningScreenshotDoc() as never);

		expect(patched.changed).toBe(true);

		const root = renderDoc(patched.messages as unknown as NarratorMsg[]);
		const imgs = imgsOf(root);
		expect(imgs).toHaveLength(1);
		expect(imgs[0]?.getAttribute("src")).toBe("/api/shares/Guvcda6o/preview");
	});
});
