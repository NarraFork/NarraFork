/**
 * RenderMedia.imggen.test.tsx — End-to-end contract for a GENERATED image in the
 * virtual list: real adapter → real measure → real render, asserting an actual
 * `<img>` reaches the DOM.
 *
 * The bug this locks down: generated images were invisible in virtual-list mode.
 * A persisted image_generation block carries its image ONLY as `savedPath` (the
 * event handler writes the base64 to disk and keeps just the path), but the
 * adapter's media payload dropped that field. The measure layer then correctly
 * reserved an aspect-ratio box from width/height while the render layer had no
 * source to put in it — a perfectly sized, permanently empty frame.
 *
 * Unit tests on each layer pass in that state (each is individually correct), so
 * this test deliberately drives the whole chain instead.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
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
	// measureImageGeneration builds a rich-inline header flow (canvas measureText).
	installCanvasStub();
	parse = (html: string) => {
		const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
		const root = document.getElementById("r");
		if (!root) throw new Error("no root");
		return root as unknown as Element;
	};
});

const CONTENT_WIDTH = 800;

const LABELS = {
	imageGenerated: "Generated image",
	imageGenerating: "Generating image…",
	imageGenerationPreparing: "Preparing image generation…",
};

/**
 * Wrap in the providers the render layer's image loader depends on.
 *
 * VListImage reads the runtime capabilities (React Query) and the shared
 * fullscreen viewer. The integration shell injects NO `resolveImageSrc`, so this
 * fallback IS the production path — worth rendering for real rather than always
 * short-circuiting it with a stub resolver.
 */
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
 * Push one assistant image_generation block through the real pipeline and return
 * the produced DOM. `resolveImageSrc` stands in for the integration layer's blob
 * loader (VListImage's fetch needs a browser), so a non-null return proves the
 * source fields survived adaptation + measurement all the way to the renderer.
 */
function renderGenerated(block: Record<string, unknown>): {
	root: Element;
	resolvedData: Array<Record<string, unknown>>;
} {
	const seg: AdapterSegment = {
		kind: "message",
		msg: { id: "gen-msg", role: "assistant", contentJson: [block as never] },
	};
	const spec = adaptSegment(seg, { lod: 5, labels: LABELS })[0];
	if (!spec) throw new Error("no spec produced");
	expect(spec.kind).toBe("media");

	const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, CONTENT_WIDTH, 5, spec.opts);
	const extra = resolveRenderExtra(spec);

	// Capture what the render layer asks for, and hand back a usable URL for any
	// block that actually carries a source.
	const resolvedData: Array<Record<string, unknown>> = [];
	extra.resolveImageSrc = (_tag: string, data: Record<string, unknown>) => {
		resolvedData.push(data);
		const path = data.savedPath ?? data.partialSavedPath;
		if (typeof path === "string" && path) {
			return `/api/fs/preview?path=${encodeURIComponent(path)}`;
		}
		const result = data.result;
		return typeof result === "string" && result ? result : null;
	};

	return { root: renderWithProviders(renderElement(spec.kind, measured, extra)), resolvedData };
}

/**
 * Same chain, but with NO injected resolver — exactly how the app runs. Proves the
 * source fields reach VListImage, which turns a savedPath into an fs-preview fetch
 * and an inline data-url into a direct src.
 */
function renderGeneratedUninjected(block: Record<string, unknown>): Element {
	const seg: AdapterSegment = {
		kind: "message",
		msg: { id: "gen-real", role: "assistant", contentJson: [block as never] },
	};
	const spec = adaptSegment(seg, { lod: 5, labels: LABELS })[0]!;
	const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, CONTENT_WIDTH, 5, spec.opts);
	const extra = resolveRenderExtra(spec);
	extra.narratorId = "nar_1";
	return renderWithProviders(renderElement(spec.kind, measured, extra));
}

const imgsOf = (root: Element) => Array.from(root.querySelectorAll("img"));
const textOf = (root: Element) => root.textContent ?? "";

describe("generated image reaches the DOM (virtual list)", () => {
	it("renders an <img> for a persisted savedPath block", () => {
		// The exact shape the event handler persists: a path + intrinsic size, no
		// inline base64 and no status.
		const { root, resolvedData } = renderGenerated({
			type: "image_generation",
			id: "img_1",
			revisedPrompt: "A neon skyline at dusk",
			savedPath: "/home/u/.narrafork/generated/img_1.png",
			width: 1024,
			height: 512,
		});

		const imgs = imgsOf(root);
		expect(imgs).toHaveLength(1);
		expect(imgs[0]?.getAttribute("src")).toContain("img_1.png");
		// The source field must survive all the way into the render layer's payload.
		expect(resolvedData.some((d) => d.savedPath === "/home/u/.narrafork/generated/img_1.png")).toBe(
			true,
		);
	});

	it("renders the streaming partial preview while generating", () => {
		const { root } = renderGenerated({
			type: "image_generation",
			id: "img_2",
			status: "generating",
			partialSavedPath: "/tmp/gen/img_2.partial-0.png",
			width: 512,
			height: 512,
		});
		expect(imgsOf(root)[0]?.getAttribute("src")).toContain("img_2.partial-0.png");
	});

	it("still renders when only the inline base64 result survived (disk write failed)", () => {
		const { root } = renderGenerated({
			type: "image_generation",
			id: "img_3",
			result: "data:image/png;base64,iVBORw0KGgo=",
			width: 256,
			height: 256,
		});
		expect(imgsOf(root)[0]?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
	});

	it("paints the localized header status (a persisted block reads as generated)", () => {
		const done = renderGenerated({
			type: "image_generation",
			id: "img_4",
			savedPath: "/tmp/gen/img_4.png",
			width: 64,
			height: 64,
		});
		expect(textOf(done.root)).toContain("Generated image");

		const running = renderGenerated({
			type: "image_generation",
			id: "img_5",
			status: "generating",
		});
		expect(textOf(running.root)).toContain("Generating image…");
	});

	it("shows the revised prompt next to the status", () => {
		const { root } = renderGenerated({
			type: "image_generation",
			id: "img_6",
			revisedPrompt: "A neon skyline at dusk",
			savedPath: "/tmp/gen/img_6.png",
			width: 128,
			height: 64,
		});
		expect(textOf(root)).toContain("A neon skyline at dusk");
	});

	// Discriminating power: this is the EXACT payload the adapter produced before
	// the fix — every field except the image source. Measurement still reserves the
	// aspect-ratio box, so the height is right and only the picture is missing. If
	// this case ever renders an <img>, the tests above have stopped proving anything.
	it("renders NO <img> when the source fields are missing (the original bug)", () => {
		const sourceless = {
			type: "image_generation",
			status: null,
			statusText: "Generated image",
			revisedPrompt: "A neon skyline at dusk",
			result: null,
			width: 1024,
			height: 512,
		};
		const measured = VLIST_REGISTRY.media.measure(sourceless, CONTENT_WIDTH, 5);
		const extra = resolveRenderExtra({ kind: "media", data: sourceless });
		// Same resolver as the passing cases: it can only return a URL if a source
		// field is present, so a sourceless payload yields nothing to paint.
		extra.resolveImageSrc = (_tag: string, data: Record<string, unknown>) => {
			const path = data.savedPath ?? data.partialSavedPath ?? data.result;
			return typeof path === "string" && path ? path : null;
		};
		const root = renderWithProviders(renderElement("media", measured, extra));
		expect(imgsOf(root)).toHaveLength(0);
		// The header still paints — that is what made the bug look like a styling
		// issue rather than a dropped field.
		expect(textOf(root)).toContain("A neon skyline at dusk");
	});

	// The integration shell injects NO resolveImageSrc, so this fallback is what
	// users actually see. An inline data-url is usable synchronously, which makes it
	// the case that can be asserted without running the blob effect.
	it("renders an <img> with no injected resolver (the real app path)", () => {
		const root = renderGeneratedUninjected({
			type: "image_generation",
			id: "img_real",
			result: "data:image/png;base64,iVBORw0KGgo=",
			width: 320,
			height: 240,
		});
		expect(imgsOf(root)[0]?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
	});

	// Bare base64 (no data: prefix) is a valid provider payload and cannot be used
	// as a src directly — it must be normalized, or the image silently stays blank.
	it("normalizes a bare-base64 result into a usable data-url", () => {
		const root = renderGeneratedUninjected({
			type: "image_generation",
			id: "img_bare",
			result: "iVBORw0KGgo=",
			width: 320,
			height: 240,
		});
		expect(imgsOf(root)[0]?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
	});

	it("reserves the image box height from the intrinsic aspect ratio", () => {
		// Height must come from the measure layer, not from the loaded image, so the
		// box is already the right size before the blob resolves (zero drift).
		const seg: AdapterSegment = {
			kind: "message",
			msg: {
				id: "gen-h",
				role: "assistant",
				contentJson: [
					{
						type: "image_generation",
						savedPath: "/tmp/gen/wide.png",
						width: 1000,
						height: 500,
					} as never,
				],
			},
		};
		const spec = adaptSegment(seg, { lod: 5, labels: LABELS })[0]!;
		const measured = VLIST_REGISTRY.media.measure(spec.data, CONTENT_WIDTH, 5, spec.opts);
		const imageFrame = measured.frame.blocks[1];
		expect(imageFrame).toBeDefined();
		// 2:1 source capped at 512 wide → 256 tall.
		expect(imageFrame?.height).toBe(256);
	});
});
