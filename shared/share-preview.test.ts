import { describe, expect, test } from "bun:test";
import { classifyToolDetail, type ToolCappedDetail } from "./pretext-layout/tool-detail";
import { classifySharePreview, isShareText, sharePreviewHeight } from "./share-preview";

describe("share preview contract", () => {
	test("classifies supported types and uppercase extensions", () => {
		for (const [name, kind] of Object.entries({
			"x.PNG": "image",
			"x.MP4": "video",
			"x.webm": "video",
			"x.mp3": "audio",
			"x.ogg": "audio",
			"x.m4a": "audio",
			"x.PDF": "pdf",
			"x.htm": "html",
			"x.ts": "text",
			"x.json": "text",
			"x.md": "text",
			"x.zip": "unsupported",
			"x.bin": "unsupported",
		} as const)) {
			expect(classifySharePreview(`C:\\work\\${name}`).kind).toBe(kind);
		}
		expect(classifySharePreview("README").probeText).toBe(true);
		expect(classifySharePreview("Dockerfile").kind).toBe("text");
		expect(classifySharePreview("x.json").textFormat).toBe("json");
		expect(classifySharePreview("x.md").textFormat).toBe("markdown");
	});
	test("prototype property names are unsupported, never undefined preview types", () => {
		for (const ext of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
			expect(classifySharePreview(`file.${ext}`)).toEqual({
				kind: "unsupported",
				mime: "application/octet-stream",
			});
			const detail = classifyToolDetail({
				previewId: "reserved-extension",
				toolName: "ShareFile",
				category: "share",
				inputJson: { preview: true },
				metadata: { filename: `file.${ext}`, downloadUrl: "/api/shares/test" },
			});
			if (detail?.kind !== "sections") throw new Error("expected sections");
			const body = detail.sections.find((s) => s.body.kind === "capped")?.body as ToolCappedDetail;
			expect(body.sharePreview?.kind).toBe("unsupported");
			expect(body.sharePreview?.url).toBeUndefined();
		}
	});
	test("does not treat binary bytes as UTF-8 text", () => {
		expect(isShareText(new TextEncoder().encode("中文\nhello\tworld"))).toBe(true);
		expect(isShareText(new Uint8Array([0, 1, 2]))).toBe(false);
		expect(isShareText(new Uint8Array([255, 255]))).toBe(false);
		expect(isShareText(new Uint8Array([0xe4, 0xb8]))).toBe(true);
		expect(isShareText(new Uint8Array([0xe4, 0xb8]), true)).toBe(false);
	});
	test("only video depends on width; asynchronous state cannot change geometry", () => {
		expect(sharePreviewHeight("video", 320)).toBe(216);
		expect(sharePreviewHeight("video", 900)).toBe(336);
		for (const kind of ["audio", "pdf", "html", "text", "unsupported"] as const)
			expect(sharePreviewHeight(kind, 300)).toBe(sharePreviewHeight(kind, 900));
	});
	test("legacy media metadata becomes typed preview instead of an image", () => {
		for (const [filename, kind] of [
			["movie.mp4", "video"],
			["song.wav", "audio"],
			["doc.pdf", "pdf"],
			["page.html", "html"],
			["code.ts", "text"],
		] as const) {
			const detail = classifyToolDetail({
				previewId: "share-test",
				toolName: "ShareFile",
				category: "share",
				metadata: {
					filename,
					preview: true,
					previewUrl: "/api/shares/test/preview",
					downloadUrl: "/api/shares/test",
				},
			});
			if (detail?.kind !== "sections") throw new Error("expected sections");
			const body = detail.sections.find((s) => s.body.kind === "capped")?.body as ToolCappedDetail;
			expect(body.sharePreview?.kind).toBe(kind);
			expect(body.media).toBeUndefined();
		}
	});
	test("unsupported requested previews have a notice and no PREVIEW badge", () => {
		const detail = classifyToolDetail({
			previewId: "share-test",
			toolName: "ShareFile",
			category: "share",
			metadata: {
				filename: "x.zip",
				downloadUrl: "/api/shares/test",
				previewRequested: true,
				previewType: "unsupported",
				previewReason: "compressed",
				compressed: true,
			},
		});
		if (detail?.kind !== "sections") throw new Error("expected sections");
		const body = detail.sections.find((s) => s.body.kind === "capped")?.body as ToolCappedDetail;
		expect(body.sharePreview?.kind).toBe("unsupported");
		expect(body.sharePreview?.reason).toBe("compressed");
		expect(JSON.stringify(detail)).not.toContain('"text":"preview"');
	});
});
