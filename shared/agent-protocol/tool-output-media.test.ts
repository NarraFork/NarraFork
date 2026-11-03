import { describe, expect, test } from "bun:test";
import { type MediaContentBlock, mediaRefToContentBlock } from "../media-attachments";
import { decodeLegacyContent } from "../narrator-blocks/decode";
import { assembleContent, splitEnvelope } from "../narrator-blocks/storage";
import { isModelVisible } from "../narrator-blocks/types";
import {
	encodeToolOutput,
	outputToText,
	toolOutputForPersistence,
	toolOutputImages,
	toolOutputMedia,
} from "./tool-output";

const media: MediaContentBlock = {
	type: "audio",
	mediaId: "durable-audio",
	mediaType: "audio/wav",
	filename: "recording.wav",
	size: 44,
	uploadNarratorId: "asset-owner",
};

describe("durable native media tool output", () => {
	test("main canonical encoder preserves metadata, images, broken state and media without bytes", () => {
		const image = { imageId: "image", mediaType: "image/png", uploadNarratorId: "owner" };
		const output = encodeToolOutput("body", {
			metadata: { path: "tone.wav" },
			broken: true,
			images: [image],
			media: [{ ...media, base64: "PRIVATE_BYTES" } as MediaContentBlock],
		});
		expect(toolOutputMedia(output)).toEqual([media]);
		expect(toolOutputImages(output)).toEqual([image]);
		expect(output).toMatchObject({ _text: "body", _metadata: { path: "tone.wav" }, _broken: true });
		expect(JSON.stringify(output)).not.toContain("PRIVATE_BYTES");
	});
	test("pure audio/video canonical inputs remain visible and raw block storage roundtrips", () => {
		for (const ref of [
			media,
			{
				...media,
				type: "video" as const,
				mediaId: "video",
				mediaType: "video/mp4",
				filename: "clip.mp4",
			},
		]) {
			const row = {
				id: ref.type,
				role: "user" as const,
				contentJson: [ref],
				contentText: null,
				parentToolUseId: null,
			};
			const { envelope, blocks } = splitEnvelope(row);
			expect(isModelVisible(envelope.blocks[0])).toBe(true);
			expect(envelope.blocks[0]).toMatchObject({ kind: "input", payload: { parts: [ref] } });
			expect(assembleContent(blocks)).toEqual([ref]);
		}
	});
	test("canonical adopted tool results decode _media without dropping accompanying images", () => {
		const outputJson = encodeToolOutput("result", {
			media: [media],
			images: [{ imageId: "image", mediaType: "image/png", uploadNarratorId: "owner" }],
		});
		const envelope = decodeLegacyContent({
			id: "tool",
			role: "assistant",
			contentJson: [],
			contentText: null,
			parentToolUseId: null,
			toolCalls: [
				{ toolUseId: "r", toolName: "Read", inputJson: {}, outputJson, status: "success" },
			],
		});
		expect(envelope.blocks[0]).toMatchObject({
			kind: "tool",
			payload: { result: { parts: [{ type: "image", assetId: "image" }, media] } },
		});
	});
	test("malformed persisted media cannot silently disappear", () => {
		expect(() => toolOutputMedia({ _media: [{ type: "audio" }] })).toThrow(/invalid/);
	});
	test("persists references and metadata while preserving text projection", () => {
		const output = toolOutputForPersistence("heard audio", { filePath: "/recording.wav" }, [media]);
		expect(output).toEqual({
			_text: "heard audio",
			_metadata: { filePath: "/recording.wav" },
			_media: [media],
		});
		expect(outputToText(output)).toBe("heard audio");
	});

	test("persists media-only results without requiring other metadata", () => {
		expect(toolOutputForPersistence("", undefined, [media])).toEqual({
			_text: "",
			_media: [media],
		});
	});

	test("does not serialize extra binary payload fields into durable references", () => {
		const withBytes = { ...media, base64: "PRIVATE_AUDIO_BYTES" };
		const output = toolOutputForPersistence("read", undefined, [withBytes]);
		expect(JSON.stringify(output)).not.toContain("PRIVATE_AUDIO_BYTES");
		expect(outputToText(output)).toBe("read");
	});

	test("message references discard extra inline bytes at the durable boundary", () => {
		const withBytes = {
			...media,
			base64: "PRIVATE_AUDIO_BYTES",
			dataBase64: "PRIVATE_VIDEO_BYTES",
		};
		expect(mediaRefToContentBlock(withBytes)).toEqual(media);
		expect(JSON.stringify(mediaRefToContentBlock(withBytes))).not.toContain("PRIVATE_");
	});

	test("preserves compatibility with plain-text and existing metadata results", () => {
		expect(toolOutputForPersistence("text")).toBe("text");
		expect(toolOutputForPersistence("text", undefined, [])).toBe("text");
		expect(toolOutputForPersistence("text", { a: 1 })).toEqual({
			_text: "text",
			_metadata: { a: 1 },
		});
	});
});
