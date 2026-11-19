/**
 * `/api/fs/preview` response headers for binary previews.
 *
 * The PDF frame in the viewer is intentionally NOT sandboxed (Chrome's built-in PDF viewer
 * refuses to run in a sandboxed frame), so the MIME claim is what must hold: the type comes
 * from the file EXTENSION, and `nosniff` is what stops a `.pdf` whose bytes are HTML from being
 * sniffed and rendered as a document in that unsandboxed frame.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { fsRoutes } from "../fs";

const app = new Hono().route("/fs", fsRoutes).onError((error, c) => {
	return buildAppErrorResponse(error, c) ?? c.json({ error: String(error) }, 500);
});

const root = mkdtempSync(join(tmpdir(), "nf-preview-headers-"));

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function preview(path: string) {
	return app.request(`http://localhost/fs/preview?path=${encodeURIComponent(path)}`);
}

describe("binary preview headers", () => {
	test("serves a PDF inline as application/pdf with nosniff", async () => {
		const pdfPath = join(root, "report.pdf");
		// Bytes chosen to look like HTML: without nosniff this is the payload that would have
		// rendered as a document in the unsandboxed preview frame.
		writeFileSync(pdfPath, "<html><script>alert(1)</script></html>");
		const response = await preview(pdfPath);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/pdf");
		expect(response.headers.get("content-disposition")).toBe("inline");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	});

	test("serves an image inline with nosniff too", async () => {
		const imagePath = join(root, "shot.png");
		writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		const response = await preview(imagePath);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	});
});
