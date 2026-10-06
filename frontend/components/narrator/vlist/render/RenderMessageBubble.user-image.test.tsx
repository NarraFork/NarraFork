/**
 * RenderMessageBubble.user-image.test.tsx — End-to-end contract for a USER
 * image attachment that carries its intrinsic dimensions: real adapter → real
 * measure → real render.
 *
 * What this locks down: a wide banner screenshot used to reserve a fixed 200px
 * box and then letterbox a ~35px-tall picture inside it — a bubble that was
 * mostly empty purple. With the upload-time dimensions flowing through the
 * adapter, the measure layer reserves the aspect-ratio-fitted box and the
 * render layer paints exactly that rectangle (zero DOM measurement).
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { type AdapterSegment, adaptSegment } from "@shared/pretext-layout/segment-adapter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageViewerProvider } from "../../../common/ImageViewerProvider";
// The cap is IMPORTED, not re-declared: a local copy of 400 is a third
// unsynchronized replica of the constant (see measure-media's note), and a test
// that drifts from the value under test stops protecting it.
import { IMAGE_MAX_DISPLAY_HEIGHT } from "../measure/measure-media";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { VLIST_REGISTRY } from "../registry";
import { renderElement, resolveRenderExtra } from "../render-registry";

let parse: (html: string) => Element;

beforeAll(() => {
	// measureMessageBubble prepares the pre-wrap body via pretext (canvas measureText).
	installCanvasStub();
	parse = (html: string) => {
		const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
		const root = document.getElementById("r");
		if (!root) throw new Error("no root");
		return root as unknown as Element;
	};
});

const CONTENT_WIDTH = 800;
const USER_BUBBLE_PADDING = 12;

function renderUserImage(block: Record<string, unknown>): Element {
	const seg: AdapterSegment = {
		kind: "message",
		msg: {
			id: "u-img",
			role: "user",
			narratorId: "nar_1",
			contentJson: [block as never, { type: "text", text: "look" }],
		},
	};
	const spec = adaptSegment(seg, { lod: 5, labels: {} })[0];
	if (!spec) throw new Error("no spec produced");
	expect(spec.kind).toBe("message-bubble");
	const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, CONTENT_WIDTH, 5, spec.opts);
	const extra = resolveRenderExtra(spec);
	extra.narratorId = "nar_1";
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
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

describe("user image attachment with intrinsic dimensions (virtual list)", () => {
	it("paints a wide strip at the exact aspect-fitted box, not a 200px letterbox", () => {
		// 12:1 banner; the column is 800, the bubble content width is 800-24.
		const root = renderUserImage({
			type: "image",
			imageId: "img_wide",
			filename: "banner.png",
			mediaType: "image/png",
			width: 1200,
			height: 100,
			// A data-url preview makes the <img> resolvable synchronously (no blob fetch).
			previewUrl: "data:image/png;base64,iVBORw0KGgo=",
		});
		const innerWidth = CONTENT_WIDTH - USER_BUBBLE_PADDING * 2;
		const expectedWidth = innerWidth;
		const expectedHeight = Math.floor((innerWidth * 100) / 1200);

		const img = root.querySelector("img");
		expect(img).not.toBeNull();
		expect(img?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
		// The box IS the fitted frame: exact width × height, no centring band.
		// (linkedom serializes styles without a space after the colon.)
		const box = img?.parentElement;
		expect(box?.getAttribute("style")).toContain(`width:${expectedWidth}px`);
		expect(box?.getAttribute("style")).toContain(`height:${expectedHeight}px`);
	});

	it("clamps a tall image at the display-height cap", () => {
		const root = renderUserImage({
			type: "image",
			imageId: "img_tall",
			filename: "capture.png",
			mediaType: "image/png",
			width: 800,
			height: 4000,
			previewUrl: "data:image/png;base64,iVBORw0KGgo=",
		});
		const img = root.querySelector("img");
		const box = img?.parentElement;
		expect(box?.getAttribute("style")).toContain(`height:${IMAGE_MAX_DISPLAY_HEIGHT}px`);
	});

	it("keeps the fixed 200px placeholder for a dimensionless image", () => {
		const root = renderUserImage({
			type: "image",
			imageId: "img_old",
			filename: "old.png",
			mediaType: "image/png",
			previewUrl: "data:image/png;base64,iVBORw0KGgo=",
		});
		const img = root.querySelector("img");
		const box = img?.parentElement;
		// Legacy box: full-width, fixed 200px tall, image centred inside it.
		expect(box?.getAttribute("style")).toContain("height:200px");
		expect(box?.getAttribute("style")).toContain("width:100%");
	});
});
