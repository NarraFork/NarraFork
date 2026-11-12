import { describe, expect, it } from "bun:test";
import { rowWithElements } from "../narrator-blocks/message-blocks";
import { adaptSegment, classifyContentBlock } from "./segment-adapter";

describe("native image status projection", () => {
	const project = (block: Record<string, unknown>) =>
		adaptSegment(
			{
				kind: "message",
				msg: rowWithElements({ id: "native-image", role: "assistant" }, [
					{ type: "image_generation", ...block },
				]),
			},
			{ lod: 5 },
		)[0]?.data;

	it("requires a real final artifact before labeling legacy history generated", () => {
		expect(project({})).toMatchObject({ statusText: "No image received" });
		expect(project({ partialSavedPath: "/preview.png" })).toMatchObject({
			statusText: "No image received",
		});
		expect(project({ savedPath: "/final.png" })).toMatchObject({ statusText: "Generated image" });
		expect(project({ result: "image-bytes" })).toMatchObject({ statusText: "Generated image" });
		expect(project({ status: "completed" })).toMatchObject({ statusText: "No image received" });
	});

	for (const [status, label] of [
		["failed", "Image generation failed"],
		["cancelled", "Image generation cancelled"],
		["incomplete", "Image generation incomplete"],
	]) {
		it(`keeps ${status} and its partial preview without inventing a reason`, () => {
			expect(project({ status, partialSavedPath: "/preview.png" })).toMatchObject({
				status,
				statusText: label,
				partialSavedPath: "/preview.png",
			});
			expect(project({ status, error: "upstream detail", errorCode: "policy" })).toMatchObject({
				status,
				error: "upstream detail",
				errorCode: "policy",
				statusText: `${label}: policy: upstream detail`,
			});
		});
	}
});

const audio = {
	type: "audio",
	mediaId: "a1",
	filename: "voice.mp3",
	mediaType: "audio/mpeg",
	size: 1024,
};
const video = {
	type: "video",
	mediaId: "v1",
	filename: "clip.mp4",
	mediaType: "video/mp4",
	size: 2048,
};
const media = [audio, video];

describe("audio/video segment projection", () => {
	it("keeps media-only user messages in their bubble with upload ownership", () => {
		const specs = adaptSegment(
			{
				kind: "message",
				msg: rowWithElements({ id: "user-media", role: "user", narratorId: "owner" }, media),
			},
			{ lod: 5 },
		);
		expect(specs).toHaveLength(1);
		expect(specs[0]?.kind).toBe("message-bubble");
		expect(specs[0]?.data).toMatchObject({
			text: "",
			attachments: media.map((block) => ({ ...block, uploadNarratorId: "owner" })),
		});
	});

	it("preserves mixed attachment order, text, and explicit cross-narrator ownership", () => {
		const specs = adaptSegment(
			{
				kind: "message",
				msg: rowWithElements({ id: "mixed", role: "user", narratorId: "current" }, [
					{ type: "image", imageId: "i1", width: 640, height: 480 },
					{ ...audio, uploadNarratorId: "original" },
					{ type: "text", text: "caption" },
					{ type: "text_file", filename: "notes.txt", size: 3 },
					video,
				]),
			},
			{ lod: 5 },
		);
		const data = specs[0]?.data as { text: string; attachments: Record<string, unknown>[] };
		expect(data.text).toBe("caption");
		expect(data.attachments.map((block) => block.type)).toEqual([
			"image",
			"audio",
			"text_file",
			"video",
		]);
		expect(data.attachments[0]).toMatchObject({ imageId: "i1", width: 640, height: 480 });
		expect(data.attachments[1]).toMatchObject({ mediaId: "a1", uploadNarratorId: "original" });
	});

	it.each(media)("classifies and projects assistant $type blocks as media", (block) => {
		expect(classifyContentBlock(block)).toBe("media");
		const specs = adaptSegment(
			{
				kind: "message",
				msg: rowWithElements({ id: "assistant-media", role: "assistant" }, [
					{ ...block, uploadNarratorId: "owner" },
				]),
			},
			{ lod: 5 },
		);
		expect(specs).toHaveLength(1);
		expect(specs[0]?.kind).toBe("media");
		expect(specs[0]?.data).toMatchObject({ ...block, uploadNarratorId: "owner" });
	});
});
