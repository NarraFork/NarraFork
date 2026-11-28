/** Real assistant adapter → registry measure → renderElement/RenderMarkdown image regression. */
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { createInstance } from "i18next";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { ensureTypographyCssVars } from "../../../lib/typography-css-vars";
import { ImageViewerContext, type ImageViewerOptions } from "../../common/image-viewer-context";
import { FileReferenceScopeProvider } from "../composer/FileReferenceScope";
import { segmentMessages } from "../message/message-segments";
import type { NarratorMsg } from "../narrator-panel-types";
import { MARKDOWN_CONSTANTS } from "./parse-markdown";
import type { MeasuredElement } from "./prepared-block";
import { measureElement } from "./registry";
import { renderElement, resolveRenderExtra } from "./render-registry";
import { type AdapterSegment, adaptSegments } from "./segment-adapter";
import { useVListLabels } from "./useVListLabels";

ensureTypographyCssVars();
const i18n = createInstance();
await i18n.init({ lng: "en", resources: {}, react: { useSuspense: false } });

export interface FixtureOptions {
	width: number;
	src: string;
	scoped?: boolean;
}

let root: Root | undefined;
let options: FixtureOptions;
let mounted = true;
let epoch = 0;
let measured: MeasuredElement[] = [];
let unknownHeights: number[] = [];
let opens: ImageViewerOptions[] = [];
let abortedReads = 0;
const nativeFetch = window.fetch.bind(window);
// Observe the REAL request signal; do not mock the authenticated reader or its result.
window.fetch = Object.assign((...args: Parameters<typeof window.fetch>) => {
	const [input, init] = args;
	if (String(input).includes("/file-references/image-preview")) {
		init?.signal?.addEventListener("abort", () => abortedReads++, { once: true });
	}
	return nativeFetch(...args);
}, window.fetch);

function Rows() {
	const { adapterLabels } = useVListLabels();
	const text = `Before image.\n\n![preview alt](${options.src} "preview title")\n\nAfter image.`;
	const msg = rowWithElements(
		{
			id: "assistant-image",
			narratorId: "image-fixture",
			role: "assistant",
			createdAt: "2026-11-04T09:10:00.000Z",
		},
		[
			{
				type: "text",
				text,
				...(options.scoped
					? { fileReferenceContext: { deviceId: "local", cwd: "/historical/workspace" } }
					: {}),
			},
		] as never,
	) as unknown as NarratorMsg;
	const specs = adaptSegments(segmentMessages([msg]) as unknown as AdapterSegment[], {
		lod: 5,
		labels: adapterLabels,
	});
	measured = specs.map((spec) => measureElement(spec.kind, spec.data, options.width, 5, spec.opts));
	return (
		<div id="scroll" style={{ height: 280, width: options.width, overflow: "auto" }}>
			<div style={{ height: 180 }} />
			{specs.map((spec, index) => {
				const value = measured[index];
				if (!value) throw new Error("Missing measured assistant row");
				return (
					<div
						key={spec.key}
						data-image-row={spec.kind}
						style={{ position: "relative", height: value.height, width: options.width }}
					>
						{mounted && (
							<FileReferenceScopeProvider key={epoch} value={{ narratorId: "image-fixture" }}>
								{renderElement(spec.kind, value, {
									...resolveRenderExtra(spec),
									onUnknownHeight: (height: number) => unknownHeights.push(height),
								})}
							</FileReferenceScopeProvider>
						)}
					</div>
				);
			})}
			<div id="sentinel" style={{ height: 20 }}>
				Following row
			</div>
			<div style={{ height: 600 }} />
		</div>
	);
}

function draw() {
	flushSync(() => {
		root?.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider forceColorScheme="dark">
					<ImageViewerContext.Provider value={{ open: (value) => opens.push(value) }}>
						<Rows />
					</ImageViewerContext.Provider>
				</MantineProvider>
			</I18nextProvider>,
		);
	});
}

export function render(value: FixtureOptions) {
	root?.unmount();
	options = value;
	mounted = true;
	epoch++;
	unknownHeights = [];
	opens = [];
	abortedReads = 0;
	root = createRoot(document.getElementById("root") as HTMLElement);
	draw();
	// Keep the entire preview visible so Puppeteer's real click need not scroll it into view.
	(document.getElementById("scroll") as HTMLElement).scrollTop = 160;
}

/** Simulate a row leaving/reentering the virtual window, preserving its reserved spacer. */
export function mount(value: boolean) {
	mounted = value;
	epoch++;
	draw();
}

export async function settle() {
	await document.fonts.ready;
	await new Promise<void>((resolve) =>
		requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
	);
}

export function report() {
	const scroll = document.getElementById("scroll") as HTMLElement;
	const rows = [...document.querySelectorAll<HTMLElement>("[data-image-row]")];
	const slots = [...document.querySelectorAll<HTMLElement>("[data-vlist-markdown-image]")];
	return {
		previewHeight: MARKDOWN_CONSTANTS.IMAGE_PREVIEW_HEIGHT,
		rowHeights: rows.map((row) => row.getBoundingClientRect().height),
		measuredHeights: measured.map((value) => value.height),
		prepared: measured.flatMap((value) =>
			value.blocks.map((block) => ({ kind: block.kind, tag: "tag" in block ? block.tag : null })),
		),
		sentinel: (document.getElementById("sentinel") as HTMLElement).getBoundingClientRect().top,
		scrollHeight: scroll.scrollHeight,
		scrollTop: scroll.scrollTop,
		overflow: scroll.scrollWidth - scroll.clientWidth,
		unknownHeights,
		abortedReads,
		opens: opens.map(({ src, alt, filename, blob }) => ({ src, alt, filename, hasBlob: !!blob })),
		slots: slots.map((slot) => {
			const box = slot.getBoundingClientRect();
			const img = slot.querySelector("img");
			const image = img?.getBoundingClientRect();
			return {
				height: box.height,
				position: getComputedStyle(slot).position,
				text: slot.textContent,
				src: img?.src,
				title: img?.title,
				complete: img?.complete,
				loaded: !!img?.complete && img.naturalWidth > 0,
				naturalWidth: img?.naturalWidth,
				naturalHeight: img?.naturalHeight,
				contained:
					!image ||
					(image.top >= box.top - 0.5 &&
						image.bottom <= box.bottom + 0.5 &&
						image.left >= box.left - 0.5 &&
						image.right <= box.right + 0.5),
			};
		}),
	};
}
