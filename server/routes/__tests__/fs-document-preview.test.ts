/**
 * `GET /api/fs/document-preview` and `/document-asset`.
 *
 * Two properties matter for a read-only document preview:
 *   1. the format verdict comes from the BYTES (a legacy `.doc` must be refused with a reason,
 *      never rendered as garbage text), and
 *   2. a caller can only address pictures the parser found — an asset id is never a ZIP path,
 *      so this endpoint cannot be used to read an arbitrary part of a container.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { buildDocx, pictureParagraph } from "../../lib/document-preview/__tests__/docx-fixture";
import { closeDocumentPreviewWorkers } from "../../lib/document-preview/client";
import { MAX_DOCUMENT_BYTES } from "../../lib/document-preview/limits";
import { fsRoutes } from "../fs";

const app = new Hono().route("/fs", fsRoutes).onError((error, c) => {
	return buildAppErrorResponse(error, c) ?? c.json({ error: String(error) }, 500);
});

const root = mkdtempSync(join(tmpdir(), "nf-document-route-"));
const docxPath = join(root, "spec.docx");
writeFileSync(
	docxPath,
	buildDocx({
		bodyXml: `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>报告</w:t></w:r></w:p>${pictureParagraph()}`,
	}),
);
const legacyPath = join(root, "legacy.doc");
writeFileSync(legacyPath, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]));

afterAll(async () => {
	await closeDocumentPreviewWorkers();
	rmSync(root, { recursive: true, force: true });
});

function preview(path: string) {
	return app.request(`http://localhost/fs/document-preview?path=${encodeURIComponent(path)}`);
}

function asset(path: string, id: string) {
	return app.request(
		`http://localhost/fs/document-asset?path=${encodeURIComponent(path)}&id=${encodeURIComponent(id)}`,
	);
}

describe("document preview route", () => {
	test("returns Markdown and asset metadata for a DOCX", async () => {
		const response = await preview(docxPath);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			ok: boolean;
			result: { markdown: string; assets: Array<{ id: string; mime: string }> };
		};
		expect(body.ok).toBe(true);
		expect(body.result.markdown).toContain("# 报告");
		expect(body.result.assets[0].mime).toBe("image/png");
	});

	test("refuses a legacy binary .doc with a reason rather than text", async () => {
		const response = await preview(legacyPath);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean; failure: { kind: string } };
		expect(body.ok).toBe(false);
		expect(body.failure.kind).toBe("legacy-office");
	});

	test("requires a path", async () => {
		const response = await app.request("http://localhost/fs/document-preview");
		expect(response.status).toBe(400);
	});

	test("rejects a file above the preview size cap without parsing it", async () => {
		const bigPath = join(root, "big.docx");
		writeFileSync(bigPath, Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x50));
		const response = await preview(bigPath);
		expect(response.status).toBe(413);
		rmSync(bigPath, { force: true });
	});
});

describe("document asset route", () => {
	test("serves one embedded picture with a nosniff content type", async () => {
		const response = await asset(docxPath, "a1");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
	});

	test("does not return an SVG part as image/svg+xml", async () => {
		const svgPath = join(root, "with-svg.docx");
		writeFileSync(
			svgPath,
			buildDocx({
				bodyXml: `<w:p><w:r><w:t>仍可预览</w:t></w:r></w:p>${pictureParagraph()}${pictureParagraph("rId2")}`,
				extraParts: [
					{
						name: "word/media/image2.svg",
						data: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
					},
				],
				extraRels: [{ id: "rId2", target: "media/image2.svg" }],
			}),
		);
		const response = await preview(svgPath);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			ok: boolean;
			result: { markdown: string; assets: Array<{ id: string; mime: string }> };
		};
		expect(body.ok).toBe(true);
		expect(body.result.markdown).toContain("仍可预览");
		expect(body.result.assets.map((asset) => asset.mime)).toEqual(["image/png"]);
		expect(body.result.assets.some((asset) => asset.mime === "image/svg+xml")).toBe(false);

		const picture = await asset(svgPath, "a1");
		expect(picture.status).toBe(200);
		expect(picture.headers.get("content-type")).toBe("image/png");
		expect(picture.headers.get("content-type")).not.toContain("svg");
		expect((await asset(svgPath, "a2")).status).toBe(400);
		rmSync(svgPath, { force: true });
	});

	test("refuses an id that is not a parser-minted asset id", async () => {
		// A ZIP part name must never be addressable: this is the path a caller would try.
		const response = await asset(docxPath, "word/media/image1.png");
		expect(response.status).toBe(400);
	});

	test("refuses an unknown asset id", async () => {
		const response = await asset(docxPath, "a9");
		expect(response.status).toBe(400);
	});

	test("requires both path and id", async () => {
		expect((await app.request("http://localhost/fs/document-asset")).status).toBe(400);
		const withoutId = await app.request(
			`http://localhost/fs/document-asset?path=${encodeURIComponent(docxPath)}`,
		);
		expect(withoutId.status).toBe(400);
	});
});
