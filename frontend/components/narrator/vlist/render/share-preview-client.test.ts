import { describe, expect, test } from "bun:test";
import {
	SHARE_TEXT_MAX_BYTES,
	SHARE_TEXT_MAX_CHARS,
	type SharePreviewRef,
} from "@shared/share-preview";
import {
	formatShareJson,
	readShareText,
	releaseShareMedia,
	shareDownloadUrl,
	shareErrorForStatus,
	sharePreviewUrl,
} from "./share-preview-client";

const ref: SharePreviewRef = {
	kind: "video",
	mime: "video/mp4",
	filename: "x.mp4",
	url: "/api/shares/id_123/preview",
	downloadUrl: "/api/shares/id_123",
};
describe("share preview client", () => {
	test("accepts only share endpoints, not arbitrary iframe URLs", () => {
		expect(sharePreviewUrl(ref)).toBe("/api/shares/id_123/preview");
		expect(shareDownloadUrl(ref)).toBe("/api/shares/id_123");
		for (const url of [
			"javascript:alert(1)",
			"https://example.com",
			"/api/fs/preview",
			"/api/shares/id/preview?x=1",
		])
			expect(sharePreviewUrl({ ...ref, url })).toBeNull();
	});
	test("maps failure statuses to distinct localized states", () => {
		expect(shareErrorForStatus(404)).toBe("unavailable");
		expect(shareErrorForStatus(400)).toBe("unsupported");
		expect(shareErrorForStatus(413)).toBe("tooLarge");
		expect(shareErrorForStatus(429)).toBe("busy");
		expect(shareErrorForStatus(504)).toBe("timeout");
	});
	test("caps characters and cancels an infinite response", async () => {
		let cancelled = false;
		const response = new Response(
			new ReadableStream({
				pull(c) {
					c.enqueue(new TextEncoder().encode("x".repeat(32768)));
				},
				cancel() {
					cancelled = true;
				},
			}),
		);
		const result = await readShareText(response, new AbortController().signal);
		expect(result.text.length).toBe(SHARE_TEXT_MAX_CHARS);
		expect(result.truncated).toBe(true);
		expect(cancelled).toBe(true);
	});
	test("caps byte allocation even for a single oversized chunk", async () => {
		const result = await readShareText(
			new Response(new Uint8Array(SHARE_TEXT_MAX_BYTES * 2).fill(65)),
			new AbortController().signal,
		);
		expect(result.text.length).toBe(SHARE_TEXT_MAX_CHARS);
		expect(result.truncated).toBe(true);
	});
	test("preserves UTF-8 across chunks and server truncation", async () => {
		const bytes = new TextEncoder().encode("中文");
		const response = new Response(
			new ReadableStream({
				start(c) {
					c.enqueue(bytes.slice(0, 2));
					c.enqueue(bytes.slice(2));
					c.close();
				},
			}),
			{ headers: { "X-Preview-Truncated": "true" } },
		);
		expect(await readShareText(response, new AbortController().signal)).toEqual({
			text: "中文",
			truncated: true,
		});
	});
	test("cancels a pending read when aborted", async () => {
		const controller = new AbortController();
		let cancelled = false;
		const pending = readShareText(
			new Response(
				new ReadableStream({
					cancel() {
						cancelled = true;
					},
				}),
			),
			controller.signal,
		);
		controller.abort();
		await expect(pending).rejects.toThrow();
		expect(cancelled).toBe(true);
	});
	test("JSON formatting preserves quoted brackets, escapes and nested values", () => {
		for (const value of [
			{ a: '["{\\\\', b: [[], {}, { c: true, d: null }] },
			[1, 2, { a: "string]" }],
			{},
			[],
			"hello",
		]) {
			const input = JSON.stringify(value);
			expect(JSON.parse(formatShareJson(input, false))).toEqual(value);
		}
	});
	test("deep JSON and excessive indentation fall back without unbounded output construction", () => {
		const deep = `${"[".repeat(1000)}0${"]".repeat(1000)}`;
		expect(formatShareJson(deep, false)).toBe(deep);
		const wide = JSON.stringify(Array.from({ length: 30000 }, () => 0));
		expect(formatShareJson(wide, false)).toBe(wide);
	});
	test("formats only complete valid JSON within the output budget", () => {
		expect(formatShareJson('{"a":1}', false)).toBe('{\n  "a": 1\n}');
		expect(formatShareJson('{"a":1}', true)).toBe('{"a":1}');
		expect(formatShareJson('{"a":', false)).toBe('{"a":');
	});
	test("release pauses and removes the media source before reloading", () => {
		const calls: string[] = [];
		releaseShareMedia({
			pause() {
				calls.push("pause");
			},
			removeAttribute(name: string) {
				calls.push(`remove:${name}`);
			},
			load() {
				calls.push("load");
			},
		} as unknown as HTMLMediaElement);
		expect(calls).toEqual(["pause", "remove:src", "load"]);
		releaseShareMedia(null);
	});
});
