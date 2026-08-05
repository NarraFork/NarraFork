/**
 * Attachment-only sends: a message whose whole payload is an image (or a text
 * file) must be accepted.
 *
 * The multipart branch used to require non-empty text, so pasting a screenshot
 * and pressing send was rejected with "message is required" even though the
 * downstream loop already substitutes a "[user sent image(s)]" placeholder for
 * every provider. These tests pin the entry-point contract:
 *  - text alone: accepted (unchanged);
 *  - attachment alone: accepted with empty text;
 *  - neither: still rejected.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ValidationError } from "@server/lib/errors";
import { getUploadsDir } from "@server/lib/uploads";
import { parseMessageRequest } from "@server/routes/narrators";
import { MAX_TEXT_FILE_SIZE } from "@shared/text-file-types";

/**
 * Minimal FormData stand-in.
 *
 * The real `FormData.append` re-wraps a File, which drops a test-side `size`
 * override — needed to exercise the size limit without allocating 100 MiB. Only
 * the two accessors `parseMessageRequest` uses are implemented.
 */
class StubFormData {
	private readonly entries: Array<[string, string | File]> = [];

	append(name: string, value: string | File): void {
		this.entries.push([name, value]);
	}

	get(name: string): string | File | null {
		return this.entries.find(([key]) => key === name)?.[1] ?? null;
	}

	getAll(name: string): Array<string | File> {
		return this.entries.filter(([key]) => key === name).map(([, value]) => value);
	}
}

/** Minimal stand-in for the Hono context fields parseMessageRequest reads. */
function multipartContext(formData: StubFormData) {
	return {
		req: {
			header: (name: string) =>
				name.toLowerCase() === "content-type"
					? "multipart/form-data; boundary=----test"
					: undefined,
			formData: async () => formData as unknown as FormData,
			json: async () => {
				throw new Error("json() must not be used for a multipart request");
			},
		},
	};
}

function jsonContext(body: unknown) {
	return {
		req: {
			header: (name: string) =>
				name.toLowerCase() === "content-type" ? "application/json" : undefined,
			formData: async () => {
				throw new Error("formData() must not be used for a JSON request");
			},
			json: async () => body,
		},
	};
}

function pngFile(name = "pasted-image-1.png"): File {
	// 1x1 transparent PNG — real bytes so image validation/decoding has something valid.
	const base64 =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
	const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
	return new File([bytes], name, { type: "image/png" });
}

describe("parseMessageRequest attachment-only payloads", () => {
	test("accepts an image with no typed text", async () => {
		const formData = new StubFormData();
		formData.append("message", "");
		formData.append("images", pngFile());

		const parsed = await parseMessageRequest(
			multipartContext(formData),
			"narrator-attachment-only-image",
		);

		expect(parsed.message).toBe("");
		expect(parsed.images).toHaveLength(1);
		expect(parsed.textFiles).toHaveLength(0);
	});

	test("accepts an image when the message field is omitted entirely", async () => {
		const formData = new StubFormData();
		formData.append("images", pngFile("screenshot.png"));

		const parsed = await parseMessageRequest(
			multipartContext(formData),
			"narrator-attachment-only-missing-field",
		);

		expect(parsed.message).toBe("");
		expect(parsed.images).toHaveLength(1);
	});

	test("accepts a text file with no typed text", async () => {
		const formData = new StubFormData();
		formData.append("message", "   ");
		formData.append(
			"textFiles",
			new File(["console.log(1);\n"], "note.ts", { type: "text/plain" }),
		);

		const parsed = await parseMessageRequest(
			multipartContext(formData),
			"narrator-attachment-only-textfile",
		);

		expect(parsed.images).toHaveLength(0);
		expect(parsed.textFiles).toHaveLength(1);
		expect(parsed.textFiles[0].name).toBe("note.ts");
	});

	test("keeps whitespace-only text as-is when an attachment carries the turn", async () => {
		const formData = new StubFormData();
		formData.append("message", "  ");
		formData.append("images", pngFile());

		const parsed = await parseMessageRequest(
			multipartContext(formData),
			"narrator-attachment-only-whitespace",
		);

		expect(parsed.message).toBe("  ");
		expect(parsed.images).toHaveLength(1);
	});

	test("still rejects a request with neither text nor attachments", async () => {
		const formData = new StubFormData();
		formData.append("message", "   ");

		await expect(
			parseMessageRequest(multipartContext(formData), "narrator-empty-multipart"),
		).rejects.toThrow(ValidationError);
	});

	test("rejects an oversized text file before any image is written to disk", async () => {
		const formData = new StubFormData();
		formData.append("message", "");
		formData.append("images", pngFile());
		// Oversized by declared size only — allocating 100 MiB of real bytes would be
		// wasteful, and validateTextFile reads File.size.
		const oversized = new File(["x"], "huge.txt", { type: "text/plain" });
		Object.defineProperty(oversized, "size", { value: MAX_TEXT_FILE_SIZE + 1 });
		formData.append("textFiles", oversized);

		const narratorId = "narrator-oversized-textfile";
		await expect(parseMessageRequest(multipartContext(formData), narratorId)).rejects.toThrow(
			ValidationError,
		);

		// The image must not have been persisted: validation runs before any write.
		expect(existsSync(resolve(getUploadsDir(), narratorId))).toBe(false);
	});

	test("JSON sends still require text (no attachment channel exists there)", async () => {
		await expect(
			parseMessageRequest(jsonContext({ message: "" }), "narrator-json"),
		).rejects.toThrow(ValidationError);

		const parsed = await parseMessageRequest(
			jsonContext({ message: "hello", priority: true }),
			"narrator-json-ok",
		);
		expect(parsed).toMatchObject({ message: "hello", priority: true });
		expect(parsed.images).toHaveLength(0);
	});
});
