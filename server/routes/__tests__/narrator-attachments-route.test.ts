/**
 * The streaming upload route, end to end through Hono.
 *
 * The store is covered in `attachment-staging.test.ts`; this file pins what only
 * the route does: header decoding, the media-type gate, the write-access check,
 * and the error codes the composer maps to localized messages.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import {
	findStagedAttachment,
	setStagedAttachmentCeilingForTests,
	setStagedAttachmentLimitsForTests,
	setStagedAttachmentsDirForTests,
} from "../../lib/attachment-staging";
import { AppError, ForbiddenError } from "../../lib/errors";

const realAccess = { ...(await import("../../lib/narrator-access")) };
const access = mock(async (_c: unknown, id: string, need: string) => {
	if (id === "denied") throw new ForbiddenError("no");
	return { id, need };
});
mock.module("../../lib/narrator-access", () => ({ ...realAccess, requireNarratorAccess: access }));

const { decodeAttachmentFilenameHeader, narratorAttachmentRoutes } = await import(
	"../narrator-attachments"
);

afterAll(() => {
	mock.module("../../lib/narrator-access", () => realAccess);
});

let root: string;
beforeEach(() => {
	root = mkdtempSync(resolve(tmpdir(), "nf-attach-route-"));
	setStagedAttachmentsDirForTests(root);
	access.mockClear();
});
afterEach(() => {
	setStagedAttachmentsDirForTests(null);
	setStagedAttachmentCeilingForTests(null);
	setStagedAttachmentLimitsForTests();
	rmSync(root, { recursive: true, force: true });
});

function app() {
	const api = new Hono();
	api.route("/api/narrator-attachments", narratorAttachmentRoutes);
	api.onError((error, c) => {
		if (error instanceof AppError)
			return c.json({ code: error.code, error: error.message }, error.statusCode as 400);
		return c.json({ error: String(error) }, 500);
	});
	return api;
}

function upload(
	narratorId: string,
	body: string,
	headers: Record<string, string> = {},
): Promise<Response> {
	return Promise.resolve(
		app().request(`/api/narrator-attachments/${narratorId}`, {
			method: "POST",
			headers: { "content-type": "application/octet-stream", ...headers },
			body,
		}),
	);
}

describe("decodeAttachmentFilenameHeader", () => {
	test("restores a percent-encoded Unicode name", () => {
		expect(decodeAttachmentFilenameHeader(encodeURIComponent("大文件 📄.txt"))).toBe(
			"大文件 📄.txt",
		);
	});
	test("keeps a malformed escape verbatim instead of failing the upload", () => {
		expect(decodeAttachmentFilenameHeader("100%.log")).toBe("100%.log");
	});
	test("passes a plain ASCII name and an absent header through", () => {
		expect(decodeAttachmentFilenameHeader("build.log")).toBe("build.log");
		expect(decodeAttachmentFilenameHeader(undefined)).toBeUndefined();
	});
});

describe("POST /api/narrator-attachments/:narratorId", () => {
	test("a Chinese filename round-trips into the response and the staged record", async () => {
		const res = await upload("narr1", "hello", {
			"x-attachment-filename": encodeURIComponent("大文件.txt"),
			"x-attachment-type": "text/plain",
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { uploadId: string; filename: string; size: number };
		expect(body.filename).toBe("大文件.txt");
		expect(body.size).toBe(5);
		// The claim happens in a later request, so the decoded name must be on disk.
		expect(findStagedAttachment("narr1", body.uploadId)?.filename).toBe("大文件.txt");
	});

	test("requires write access on the narrator", async () => {
		const res = await upload("denied", "x");
		expect(res.status).toBe(403);
		expect(access).toHaveBeenCalledWith(expect.anything(), "denied", "write");
	});

	test("rejects a non-octet-stream body", async () => {
		const res = await upload("narr1", "x", { "content-type": "text/plain" });
		expect(res.status).toBe(415);
		expect(((await res.json()) as { code: string }).code).toBe("ATTACHMENT_INVALID_MEDIA_TYPE");
	});

	test("an oversized file is rejected with a code the composer can localize", async () => {
		setStagedAttachmentCeilingForTests(4);
		const res = await upload("narr1", "too large", {
			"x-attachment-filename": "big.log",
		});
		expect(res.status).toBe(413);
		expect(((await res.json()) as { code: string }).code).toBe("ATTACHMENT_TOO_LARGE");
	});

	test("a full staging area is rejected with its own code", async () => {
		setStagedAttachmentLimitsForTests({ count: 1 });
		expect((await upload("narr1", "first")).status).toBe(201);
		const res = await upload("narr1", "second");
		expect(res.status).toBe(413);
		expect(((await res.json()) as { code: string }).code).toBe("ATTACHMENT_STAGING_FULL");
	});
});
