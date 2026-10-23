import { afterEach, beforeEach, expect, test } from "bun:test";
import { narratorAttachmentApi } from "./narrator-attachments";

const originalFetch = globalThis.fetch;
let storage: PropertyDescriptor | undefined;
beforeEach(() => {
	storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: () => null },
	});
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	if (storage) Object.defineProperty(globalThis, "localStorage", storage);
	else Reflect.deleteProperty(globalThis, "localStorage");
});
function response(text = "original") {
	return new Response(text, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"X-Attachment-Size": String(new TextEncoder().encode(text).byteLength),
			"X-Attachment-Truncated": "false",
		},
	});
}
test("client sends only encoded message/attachment selectors", async () => {
	let url = "";
	globalThis.fetch = (async (input: unknown) => {
		url = String(input);
		return response();
	}) as unknown as typeof fetch;
	expect(
		(await narratorAttachmentApi.preview("n/id", { messageId: "m/id", attachmentId: "a/id" }))
			.content,
	).toBe("original");
	expect(url).toBe("/api/narrators/n%2Fid/messages/m%2Fid/attachments/a%2Fid/preview");
});
test("client rejects truncated and oversized responses without fallback", async () => {
	let calls = 0;
	globalThis.fetch = (async () => {
		calls++;
		const res = response();
		res.headers.set("X-Attachment-Truncated", "true");
		return res;
	}) as unknown as typeof fetch;
	await expect(
		narratorAttachmentApi.preview("n", { messageId: "m", attachmentId: "a" }),
	).rejects.toThrow();
	expect(calls).toBe(1);
	globalThis.fetch = (async () => response("x".repeat(1024 * 1024 + 1))) as unknown as typeof fetch;
	await expect(
		narratorAttachmentApi.preview("n", { messageId: "m", attachmentId: "a" }),
	).rejects.toThrow();
});
