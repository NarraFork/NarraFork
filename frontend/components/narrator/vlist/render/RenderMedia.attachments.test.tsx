import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import {
	AUDIO_ATTACHMENT_HEIGHT,
	MEDIA_ATTACHMENT_WIDTH,
	VIDEO_ATTACHMENT_HEIGHT,
} from "@shared/pretext-layout/media-attachment-layout";
import { adaptSegment } from "@shared/pretext-layout/segment-adapter";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { segmentMessages } from "../../message/message-segments";
import type { ContentBlock, NarratorMsg } from "../../narrator-panel-types";
import { measureMedia, TEXT_FILE_HEIGHT } from "../measure/measure-media";
import {
	measureMessageBubble,
	USER_ATTACHMENT_GAP,
	USER_BUBBLE_PADDING,
	USER_HEADER_BODY_GAP,
	USER_HEADER_HEIGHT,
} from "../measure/measure-message-bubble";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { measureElement } from "../registry";
import { renderElement, resolveRenderExtra } from "../render-registry";

let dispose: () => void;
beforeAll(() => {
	dispose = installCanvasStub();
});
afterAll(() => dispose());

function block(type: "audio" | "video", preview = false): ContentBlock {
	return {
		type,
		mediaId: `${type}-id`,
		filename: `${type}.mp4`,
		mediaType: `${type}/mp4`,
		size: 1024,
		uploadNarratorId: "original-owner",
		...(preview ? { previewUrl: `blob:${type}-preview` } : {}),
	};
}

function render(role: "user" | "assistant", attachment: ContentBlock, command = false) {
	const msg: NarratorMsg = rowWithElements(
		{
			id: "media-message",
			role,
			narratorId: "panel-owner",
			parentToolUseId: null,
			contentText: null,
			toolCalls: [],
			createdAt: "2026-10-28T00:00:00.000Z",
			...(command ? { commandText: "/inspect" } : {}),
		},
		[attachment],
	);
	const segments = segmentMessages([msg]);
	expect(segments).toHaveLength(1);
	const segment = segments[0];
	if (!segment || segment.kind !== "message") {
		throw new Error("Media message was dropped or misclassified during segmentation");
	}
	const spec = adaptSegment(segment, { lod: 5 })[0];
	if (!spec) throw new Error("Media message was dropped during adaptation");
	const measured = measureElement(spec.kind, spec.data, 600, 5, spec.opts);
	const html = renderToStaticMarkup(
		<MantineProvider forceColorScheme="dark">
			{renderElement(spec.kind, measured, {
				...resolveRenderExtra(spec),
				narratorId: "panel-owner",
			})}
		</MantineProvider>,
	);
	const { document } = parseHTML(`<html><body>${html}</body></html>`);
	return { document, measured };
}

const cases = [
	["audio", AUDIO_ATTACHMENT_HEIGHT],
	["video", VIDEO_ATTACHMENT_HEIGHT],
] as const;

describe("virtual-list audio/video attachments", () => {
	it.each(cases)("reserves stable %s height at wide and narrow widths", (type, height) => {
		for (const width of [180, 600]) {
			const media = measureMedia(block(type), width);
			expect(media.height).toBe(height);
			expect(media.usedWidth).toBe(Math.min(width, MEDIA_ATTACHMENT_WIDTH));
			const user = measureMessageBubble(
				{ role: "user", text: "", attachments: [block(type)] },
				width,
			);
			expect(user.height).toBe(
				USER_BUBBLE_PADDING * 2 + USER_HEADER_HEIGHT + USER_HEADER_BODY_GAP + height,
			);
			expect(user.usedWidth).toBe(
				Math.min(width, MEDIA_ATTACHMENT_WIDTH + USER_BUBBLE_PADDING * 2),
			);
			expect(user.blocks[0]).toMatchObject({
				tag: `user-${type}`,
				data: { mediaId: `${type}-id`, uploadNarratorId: "original-owner" },
			});
			const longer = measureMedia(
				{ ...block(type), filename: "x".repeat(1000), size: 2 ** 30 },
				width,
			);
			expect(longer.height).toBe(height);
		}
	});

	it("stacks mixed attachments without losing image/text-file reservations", () => {
		const base = measureMessageBubble({ role: "user", text: "caption" }, 600);
		const mixed = measureMessageBubble(
			{
				role: "user",
				text: "caption",
				attachments: [
					{ type: "image", imageId: "img", width: 100, height: 50 },
					block("audio"),
					{ type: "text_file", filename: "notes.txt" },
					block("video"),
				],
			},
			600,
		);
		const imageHeight = 50; // Small images retain their intrinsic size; no upscaling.
		expect(mixed.height - base.height).toBe(
			imageHeight +
				AUDIO_ATTACHMENT_HEIGHT +
				TEXT_FILE_HEIGHT +
				VIDEO_ATTACHMENT_HEIGHT +
				USER_ATTACHMENT_GAP * 4,
		);
		expect(mixed.blocks.map((item) => (item.kind === "fixed" ? item.tag : item.kind))).toEqual([
			"user-image",
			"user-audio",
			"user-text-file",
			"user-video",
			"code",
		]);
	});

	for (const role of ["user", "assistant"] as const) {
		it.each(cases)(`renders ${role} %s controls in the measured box`, (type, height) => {
			const { document, measured } = render(role, block(type, true));
			const control = document.querySelector(type);
			expect(control).not.toBeNull();
			expect(control?.getAttribute("src")).toBe(`blob:${type}-preview`);
			expect(control?.hasAttribute("controls")).toBe(true);
			expect(control?.parentElement?.getAttribute("style")).toContain(`height:${height}px`);
			expect(control?.parentElement?.parentElement?.getAttribute("style")).toContain(
				`height:${height}px`,
			);
			expect(document.body.textContent).toContain(`${type}.mp4`);
			expect(measured.blocks[0]).toMatchObject({ height });
		});
	}

	it.each(cases)("reserves %s idle placeholder with an explicit preview button", (type, height) => {
		const { document } = render("user", block(type));
		const button = document.querySelector("button");
		expect(button).not.toBeNull();
		expect(button?.parentElement?.parentElement?.getAttribute("style")).toContain(
			`height:${height}px`,
		);
		expect(document.querySelector('[role="status"]')).toBeNull();
		expect(document.querySelector("audio, video, img")).toBeNull();
	});

	it("renders command-bubble media attachments through the same player", () => {
		const { document } = render("user", block("audio", true), true);
		expect(document.querySelector("audio")?.getAttribute("src")).toBe("blob:audio-preview");
		expect(document.body.textContent).toContain("/inspect");
	});
});
