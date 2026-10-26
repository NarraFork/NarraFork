/**
 * RenderToolCall.sharelink.test.tsx — a ShareFile card's COPY button must hand over a
 * FULL URL, not the stored `/api/shares/…` path.
 *
 * Both actions on the card come from the server-stored `downloadUrl` (see classifyShare
 * in shared/pretext-layout/tool-detail.ts). A bare path is a perfectly good `href` — the
 * browser resolves it against the document — but a useless clipboard value: pasted into
 * another tab, a chat message or a ticket it names no host at all. The chunked renderer
 * always copied `${origin}${downloadUrl}`; the vlist renderer copied the raw path.
 *
 * Two surfaces are pinned, because they fail independently:
 *   1. the DOWNLOAD href must be the mount-prefix-resolved URL (`resolveServerUrl`) —
 *      the same treatment the preview URL already gets, and what the value needs under
 *      a reverse-proxy subpath;
 *   2. the COPIED text must be origin + that resolved path.
 *
 * The copy value lives inside a click handler, which a static render cannot reach, so
 * the mapping itself is asserted through the component's `__TEST__` seam; the href is
 * asserted off the real rendered DOM through the real segmentMessages → adapter →
 * measure → render chain.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { resetAppBaseForTest, resolveServerUrl } from "@frontend/lib/base-path";
import { MantineProvider } from "@mantine/core";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageViewerProvider } from "../../../common/ImageViewerProvider";
import { segmentMessages } from "../../message/message-segments";
import type { NarratorMsg } from "../../narrator-panel-types";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { VLIST_REGISTRY } from "../registry";
import { renderElement, resolveRenderExtra } from "../render-registry";
import { type AdapterContext, type AdapterSegment, adaptSegments } from "../segment-adapter";
import { __TEST__shareLinkForCopy } from "./RenderToolCall";

const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

const CONTENT_WIDTH = 800;
const DOWNLOAD_URL = "/api/shares/tid123";

/** LOD 5 expands every card, so the detail region (and its action row) is painted. */
const CTX: AdapterContext = {
	lod: 5,
	resolveToolCategory: () => "share",
};

let parse: (html: string) => Element;

beforeAll(() => {
	parse = (html: string) => {
		const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
		const root = document.getElementById("r");
		if (!root) throw new Error("no root");
		return root as unknown as Element;
	};
});

/**
 * Simulate a document mounted at `mountUrl`, exactly as tests/frontend/base-path.test.ts
 * does: `document.baseURI` is read-only and derived, so it is stubbed directly.
 */
function mountAt(mountUrl: string): void {
	resetAppBaseForTest();
	const g = globalThis as { document?: unknown; location?: unknown };
	g.document = { baseURI: mountUrl };
	g.location = { href: mountUrl, origin: new URL(mountUrl).origin };
}

afterEach(() => {
	resetAppBaseForTest();
	const g = globalThis as { document?: unknown; location?: unknown };
	delete g.document;
	delete g.location;
});

/**
 * A completed ShareFile call in the shape the backend actually persists: the metadata
 * nested under `outputJson._metadata` (see narrator-messages' enrichToolUseBlocks).
 * `previewRequested: false` keeps the card to its meta row, so the only anchor in the
 * DOM is the download action.
 */
function shareMessage(): NarratorMsg {
	const outputJson = {
		_text: `Files shared successfully.\n\nDownload link: ${DOWNLOAD_URL}`,
		_metadata: {
			shareId: "tid123",
			downloadUrl: DOWNLOAD_URL,
			filename: "share-report.zip",
			sizeFormatted: "1.2 MB",
			expiryHours: 24,
			previewRequested: false,
		},
	};
	const inputJson = { path: "/tmp/report" };
	return rowWithElements(
		{
			id: "a-share",
			narratorId: "n1",
			parentToolUseId: null,
			role: "assistant",
			contentText: null,
			toolCalls: [
				{
					toolUseId: "tu-share",
					toolName: "ShareFile",
					inputJson,
					outputJson,
					status: "completed",
				},
			],
			createdAt: "2026-01-01T00:00:00Z",
		},
		[
			{
				type: "tool_use",
				id: "tu-share",
				name: "ShareFile",
				input: inputJson,
				inputJson,
				outputJson,
				status: "completed",
			},
		],
	) as unknown as NarratorMsg;
}

function withProviders(node: ReactNode): Element {
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

/** Drive the full segment → adapter → measure → render chain for the share call. */
function renderShareCard(): Element {
	const segments = segmentMessages([shareMessage()]) as unknown as AdapterSegment[];
	const specs = adaptSegments(segments, CTX);
	const spec = specs.find((s) => s.kind === "tool-call" || s.kind === "tool-call-group");
	if (!spec) throw new Error(`no tool-call spec, got: ${specs.map((s) => s.kind).join(",")}`);
	const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, CONTENT_WIDTH, 5, spec.opts);
	const extra = resolveRenderExtra(spec);
	extra.narratorId = "n1";
	return withProviders(renderElement(spec.kind, measured, extra));
}

function anchorHrefs(root: Element): string[] {
	return Array.from(root.querySelectorAll("a[href]"))
		.map((a) => a.getAttribute("href") ?? "")
		.filter((href) => href.includes("/api/shares/"));
}

describe("share card — copy value", () => {
	it("prepends the frontend origin to the stored path", () => {
		mountAt("https://nf.example.com/");
		expect(__TEST__shareLinkForCopy(DOWNLOAD_URL)).toBe(`https://nf.example.com${DOWNLOAD_URL}`);
	});

	it("keeps the mount prefix in the copied URL", () => {
		mountAt("https://nf.example.com/nf/");
		// What the render layer actually feeds the seam: the resolved href.
		const href = resolveServerUrl(DOWNLOAD_URL);
		expect(href).toBe(`/nf${DOWNLOAD_URL}`);
		expect(__TEST__shareLinkForCopy(href)).toBe(`https://nf.example.com/nf${DOWNLOAD_URL}`);
	});

	it("returns the path untouched when there is no origin to prepend", () => {
		resetAppBaseForTest();
		expect(__TEST__shareLinkForCopy(DOWNLOAD_URL)).toBe(DOWNLOAD_URL);
	});

	it("leaves an already-absolute URL alone", () => {
		mountAt("https://nf.example.com/");
		expect(__TEST__shareLinkForCopy("https://cdn.example.com/x")).toBe("https://cdn.example.com/x");
	});
});

describe("share card — download href", () => {
	it("renders the download action off the resolved path", () => {
		mountAt("https://nf.example.com/");
		expect(anchorHrefs(renderShareCard())).toContain(DOWNLOAD_URL);
	});

	it("renders the mount prefix into the download href", () => {
		mountAt("https://nf.example.com/nf/");
		expect(anchorHrefs(renderShareCard())).toContain(`/nf${DOWNLOAD_URL}`);
	});
});
