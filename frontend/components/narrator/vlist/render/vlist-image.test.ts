/**
 * vlist-image.test.ts — Locks the image_generation inline-source normalization.
 *
 * A generated image's `result` payload is either a data-url OR bare base64. The
 * bare form cannot be used as an `<img src>` directly, so it needs the
 * `data:image/png;base64,` prefix (the same normalization MessageBubble does).
 * Handing the raw string straight to `src` renders nothing — one of the reasons
 * generated images stayed invisible in the virtual list.
 *
 * Pure string logic: no DOM, no React, no fetch.
 */

import { describe, expect, it } from "bun:test";
import { MAX_INLINE_IMAGE_SOURCE_CHARS } from "../../composer/image-clipboard";
import { inlineImageSrcFromResult } from "./vlist-image";

describe("inlineImageSrcFromResult", () => {
	it("prefixes bare base64 so it is usable as an <img> src", () => {
		expect(inlineImageSrcFromResult("iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=");
	});

	it("passes an existing data-url through untouched", () => {
		const dataUrl = "data:image/webp;base64,UklGRg==";
		expect(inlineImageSrcFromResult(dataUrl)).toBe(dataUrl);
	});

	it("returns undefined for absent / empty payloads", () => {
		expect(inlineImageSrcFromResult(undefined)).toBeUndefined();
		expect(inlineImageSrcFromResult("")).toBeUndefined();
	});

	it("refuses an oversized payload rather than building a huge attribute", () => {
		const tooBig = "a".repeat(MAX_INLINE_IMAGE_SOURCE_CHARS + 1);
		expect(inlineImageSrcFromResult(tooBig)).toBeUndefined();
		// The cap itself is still accepted (boundary is inclusive).
		expect(inlineImageSrcFromResult("a".repeat(MAX_INLINE_IMAGE_SOURCE_CHARS))).toBeDefined();
	});
});
