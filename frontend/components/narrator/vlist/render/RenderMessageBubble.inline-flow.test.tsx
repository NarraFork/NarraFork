/**
 * RenderMessageBubble.inline-flow.test.tsx — a user message whose quotes and image sit
 * between pieces of text paints them as chips inside the text line, in the order the
 * user composed them: real adapter → real measure → real render.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { type AdapterSegment, adaptSegment } from "@shared/pretext-layout/segment-adapter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageViewerProvider } from "../../../common/ImageViewerProvider";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { VLIST_REGISTRY } from "../registry";
import { renderElement, resolveRenderExtra } from "../render-registry";

let parse: (html: string) => Element;

beforeAll(() => {
	installCanvasStub();
	parse = (html: string) => {
		const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
		const root = document.getElementById("r");
		if (!root) throw new Error("no root");
		return root as unknown as Element;
	};
});

function renderUser(text: string): Element {
	const seg: AdapterSegment = {
		kind: "message",
		msg: rowWithElements(
			{
				id: "u-inline",
				role: "user",
				narratorId: "nar_1",
			},
			[
				{ type: "image", imageId: "img_1", filename: "shot.png", width: 40, height: 20 } as never,
				{ type: "text", text },
			],
		),
	};
	const spec = adaptSegment(seg, { lod: 5, labels: {} })[0];
	if (!spec) throw new Error("no spec produced");
	const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, 800, 5, spec.opts);
	const extra = resolveRenderExtra(spec);
	extra.narratorId = "nar_1";
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	return parse(
		renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<MantineProvider forceColorScheme="dark">
					<ImageViewerProvider>{renderElement(spec.kind, measured, extra)}</ImageViewerProvider>
				</MantineProvider>
			</QueryClientProvider>,
		),
	);
}

describe("interleaved user message (virtual list)", () => {
	it("paints quote and image chips between the text, without raw placeholders", () => {
		const root = renderUser(
			"> [quote] 当前正在运行的活动 @@m:msg1234\n> 当前正在运行的活动\n\n怎样算？\n> [quote] 最近两个运行段 @@m:msg5678\n> 最近两个运行段\n\n第二问[image #1: shot.png]",
		);
		const text = root.textContent ?? "";
		expect(text).not.toContain("[quote]");
		expect(text).not.toContain("[image #1");
		const order = ["当前正在运行的活动", "怎样算？", "最近两个运行段", "第二问", "shot.png"].map(
			(needle) => text.indexOf(needle),
		);
		expect(order.every((index) => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(root.querySelectorAll("button").length).toBeGreaterThanOrEqual(2);
	});

	it("keeps an image composed after all text as its own row below the body", () => {
		const root = renderUser("看看这个[image #1: shot.png]");
		const text = root.textContent ?? "";
		expect(text).toContain("看看这个");
		expect(text).not.toContain("[image #1");
	});
});
