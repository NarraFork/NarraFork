import { afterAll, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NarratorMsg } from "../../narrator-panel-types";
import type { MeasuredToolBody } from "../measure/measure-tool-call";
import type { AdapterSegment } from "../segment-adapter";

mock.module("@frontend/lib/build-target", () => ({ REMOTE_BUILD: true }));
const genUIHost = mock(() => {
	throw new Error("unsupported GenUI host mounted");
});
mock.module("@frontend/components/gen-ui/GenUICard", () => ({ GenUICard: genUIHost }));
const { ImageViewerContext } = await import("../../../common/image-viewer-context");
const { segmentMessages } = await import("../../message/message-segments");
const { installCanvasStub } = await import("../measure/test-canvas-stub");
const { VLIST_REGISTRY } = await import("../registry");
const { renderElement, resolveRenderExtra } = await import("../render-registry");
const { adaptSegments } = await import("../segment-adapter");
const { RenderToolBody } = await import("./RenderToolCall");
const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

function render(node: ReactNode) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	const html = renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<MantineProvider env="test">
				<ImageViewerContext.Provider value={{ open() {} }}>{node}</ImageViewerContext.Provider>
			</MantineProvider>
		</QueryClientProvider>,
	);
	client.clear();
	return parseHTML(`<html><body>${html}</body></html>`).document;
}

test("historical ShareFile keeps its record but neither preview nor metadata exposes a download URL", () => {
	const inputJson = { path: "/repo/report" };
	const outputJson = {
		_text: "Files shared",
		_metadata: {
			shareId: "old-share",
			downloadUrl: "/api/shares/old-share",
			filename: "report.zip",
			sizeFormatted: "1 MB",
			previewRequested: false,
		},
	};
	const row = rowWithElements(
		{
			id: "msg",
			narratorId: "n",
			role: "assistant",
			toolCalls: [
				{ toolUseId: "tool", toolName: "ShareFile", inputJson, outputJson, status: "completed" },
			],
			createdAt: "2026-01-01T00:00:00Z",
		},
		[
			{
				type: "tool_use",
				id: "tool",
				name: "ShareFile",
				input: inputJson,
				inputJson,
				outputJson,
				status: "completed",
			},
		],
	) as unknown as NarratorMsg;
	const specs = adaptSegments(segmentMessages([row]) as unknown as AdapterSegment[], {
		lod: 5,
		resolveToolCategory: () => "share",
	});
	const spec = specs.find((item) => item.kind === "tool-call" || item.kind === "tool-call-group");
	if (!spec) throw new Error("missing tool card");
	const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, 800, 5, spec.opts);
	const document = render(
		renderElement(spec.kind, measured, { ...resolveRenderExtra(spec), narratorId: "n" }),
	);
	expect(document.body.textContent).toContain("ShareFile");
	expect(document.querySelector("[data-remote-unsupported]")).not.toBeNull();
	expect(document.querySelector("a[href*='/api/'],iframe")).toBeNull();
});

test("historical GenUI body is an unsupported record and never mounts the executable host", () => {
	const measured = {
		model: { kind: "gen-ui", text: "<Button>submit</Button>", formToolUseId: "waiting-form" },
		blocks: [],
		frame: { contentHeight: 100, blocks: [], usedWidth: 300 },
		contentWidth: 300,
		height: 100,
		appliedCap: 100,
	} as unknown as MeasuredToolBody;
	const document = render(<RenderToolBody measured={measured} narratorId="n" />);
	expect(document.querySelector("[data-remote-unsupported]")).not.toBeNull();
	expect(document.querySelector("iframe,button,a")).toBeNull();
	expect(genUIHost).not.toHaveBeenCalled();
});
