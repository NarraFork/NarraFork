import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	BoundedConfirmedRefSet,
	type ConfirmedRefSet,
	dedupAnthropicHistoryImages,
	dedupOpenAIHistoryImages,
	imageRefForBase64,
	isImageCacheMissError,
	restoreAnthropicHistoryImages,
	restoreOpenAIHistoryImages,
} from "../nug-image-dedup";

const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

function expectedRef(b64: string): string {
	return `sha256:${createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex")}`;
}

function confirmed(...refs: string[]): ConfirmedRefSet {
	return new Set(refs);
}

describe("imageRefForBase64", () => {
	test("stable content hash with sha256 prefix", () => {
		expect(imageRefForBase64(PNG_B64)).toBe(expectedRef(PNG_B64));
	});
	test("empty payload yields empty ref", () => {
		expect(imageRefForBase64("")).toBe("");
	});
});

describe("BoundedConfirmedRefSet", () => {
	test("evicts the oldest ref when the limit is exceeded", () => {
		const refs = new BoundedConfirmedRefSet(2);
		refs.add("sha256:a");
		refs.add("sha256:b");
		refs.add("sha256:c");

		expect(refs.has("sha256:a")).toBe(false);
		expect(refs.has("sha256:b")).toBe(true);
		expect(refs.has("sha256:c")).toBe(true);
		expect(refs.size).toBe(2);
	});

	test("refreshes an existing ref before applying eviction", () => {
		const refs = new BoundedConfirmedRefSet(2);
		refs.add("sha256:a");
		refs.add("sha256:b");
		refs.add("sha256:a");
		refs.add("sha256:c");

		expect(refs.has("sha256:a")).toBe(true);
		expect(refs.has("sha256:b")).toBe(false);
		expect(refs.has("sha256:c")).toBe(true);
		expect(refs.size).toBe(2);
	});
});

describe("dedupOpenAIHistoryImages", () => {
	test("unconfirmed responses input_image keeps payload, tags ref", () => {
		const uri = `data:image/png;base64,${PNG_B64}`;
		const ref = expectedRef(PNG_B64);
		const history = [
			{
				role: "user",
				content: [
					{ type: "input_text", text: "look" },
					{ type: "input_image", image_url: uri },
				],
			},
		];
		const result = dedupOpenAIHistoryImages(history, confirmed());
		// biome-ignore lint/suspicious/noExplicitAny: test introspection
		const part = (history[0] as any).content[1];
		expect(part.imageRef).toBe(ref);
		expect(part.image_url).toBe(uri);
		expect(result.present).toEqual([ref]);
		expect(result.stripped.size).toBe(0);
	});

	test("confirmed responses input_image strips data uri and restores", () => {
		const uri = `data:image/png;base64,${PNG_B64}`;
		const ref = expectedRef(PNG_B64);
		const history = [
			{
				role: "user",
				content: [
					{ type: "input_text", text: "look" },
					{ type: "input_image", image_url: uri },
				],
			},
		];
		const result = dedupOpenAIHistoryImages(history, confirmed(ref));
		// biome-ignore lint/suspicious/noExplicitAny: test introspection
		const part = (history[0] as any).content[1];
		expect(part.imageRef).toBe(ref);
		expect(part.image_url).toBe("");
		expect(result.stripped.get(ref)).toBe(uri);

		restoreOpenAIHistoryImages(history, result.stripped);
		expect(part.image_url).toBe(uri);
	});

	test("confirmed chat image_url object strips url and restores", () => {
		const uri = `data:image/png;base64,${PNG_B64}`;
		const ref = expectedRef(PNG_B64);
		const history = [
			{
				role: "user",
				content: [{ type: "image_url", image_url: { url: uri } }],
			},
		];
		const result = dedupOpenAIHistoryImages(history, confirmed(ref));
		// biome-ignore lint/suspicious/noExplicitAny: test introspection
		const part = (history[0] as any).content[0];
		expect(part.imageRef).toBe(ref);
		expect(part.image_url.url).toBe("");

		restoreOpenAIHistoryImages(history, result.stripped);
		expect(part.image_url.url).toBe(uri);
	});

	test("ignores non-data-uri images (remote urls)", () => {
		const history = [
			{
				role: "user",
				content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
			},
		];
		const result = dedupOpenAIHistoryImages(history, confirmed());
		expect(result.stripped.size).toBe(0);
		expect(result.present).toEqual([]);
		// biome-ignore lint/suspicious/noExplicitAny: test introspection
		expect((history[0] as any).content[0].image_url.url).toBe("https://example.com/a.png");
	});
});

describe("dedupAnthropicHistoryImages", () => {
	test("unconfirmed ref keeps data, tags ref", () => {
		const ref = expectedRef(PNG_B64);
		const history = [
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
				],
			},
		];
		const result = dedupAnthropicHistoryImages(history, confirmed());
		// biome-ignore lint/suspicious/noExplicitAny: test introspection
		const part = (history[0] as any).content[1];
		expect(part.imageRef).toBe(ref);
		expect(part.source.data).toBe(PNG_B64);
		expect(result.present).toEqual([ref]);
	});

	test("confirmed ref strips data and restores it", () => {
		const ref = expectedRef(PNG_B64);
		const history = [
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
				],
			},
		];
		const result = dedupAnthropicHistoryImages(history, confirmed(ref));
		// biome-ignore lint/suspicious/noExplicitAny: test introspection
		const part = (history[0] as any).content[1];
		expect(part.imageRef).toBe(ref);
		expect(part.source.data).toBe("");
		expect(result.stripped.get(ref)).toBe(PNG_B64);

		restoreAnthropicHistoryImages(history, result.stripped);
		expect(part.source.data).toBe(PNG_B64);
	});

	test("no images is a no-op", () => {
		const history = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
		const result = dedupAnthropicHistoryImages(history, confirmed());
		expect(result.stripped.size).toBe(0);
		expect(result.present).toEqual([]);
	});
});

describe("isImageCacheMissError", () => {
	test("true for 409", () => {
		expect(isImageCacheMissError({ status: 409, message: "x" })).toBe(true);
	});
	test("false for other statuses", () => {
		expect(isImageCacheMissError({ status: 500 })).toBe(false);
		expect(isImageCacheMissError(null)).toBe(false);
		expect(isImageCacheMissError(new Error("nope"))).toBe(false);
	});
});
