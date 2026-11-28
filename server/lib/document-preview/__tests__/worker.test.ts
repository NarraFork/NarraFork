import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	closeDocumentPreviewWorkers,
	requestDocumentAsset,
	requestDocumentPreview,
	resetDocumentPreviewWorkersForTests,
} from "../client";
import { MAX_DOCUMENT_BYTES } from "../limits";
import { buildDocx, pictureParagraph } from "./docx-fixture";

let directory: string;
let docxPath: string;
let legacyPath: string;

const BODY = `
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>报告</w:t></w:r></w:p>
<w:p><w:r><w:t>正文内容</w:t></w:r></w:p>
${pictureParagraph()}
`;

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "nf-document-preview-"));
	docxPath = join(directory, "spec.docx");
	legacyPath = join(directory, "legacy.doc");
	await writeFile(docxPath, buildDocx({ bodyXml: BODY }));
	// OLE signature: the reader must refuse it rather than read it as text.
	await writeFile(
		legacyPath,
		Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]),
	);
});

afterAll(async () => {
	await closeDocumentPreviewWorkers();
	await rm(directory, { recursive: true, force: true });
});

describe("document preview worker", () => {
	test("parses a document off the main thread", async () => {
		const outcome = await requestDocumentPreview(docxPath);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.result.markdown).toContain("# 报告");
		expect(outcome.result.markdown).toContain("正文内容");
		expect(outcome.result.assets).toHaveLength(1);
	});

	test("returns the bytes of one embedded picture", async () => {
		const asset = await requestDocumentAsset(docxPath, "a1");
		expect(asset?.mime).toBe("image/png");
		expect(asset?.bytes.length).toBeGreaterThan(0);
		expect(await requestDocumentAsset(docxPath, "a9")).toBeNull();
	});

	test("refuses a legacy binary .doc with a reason instead of garbage text", async () => {
		const outcome = await requestDocumentPreview(legacyPath);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.failure.kind).toBe("legacy-office");
	});

	test("fails explicitly for a document over the size cap", async () => {
		const bigPath = join(directory, "big.docx");
		await writeFile(bigPath, Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x50));
		await expect(requestDocumentPreview(bigPath)).rejects.toThrow(/larger than/);
		await rm(bigPath, { force: true });
	});

	/**
	 * Failure injection: once the workers are closed there is deliberately NO main-thread
	 * fallback, so the call must reject. A passing parse here would mean the CPU-heavy
	 * inflate/XML walk silently ran on the server's single JS thread.
	 */
	test("never falls back to main-thread parsing after the workers are closed", async () => {
		await closeDocumentPreviewWorkers();
		await expect(requestDocumentPreview(docxPath)).rejects.toThrow(/closed/);
		await expect(requestDocumentAsset(docxPath, "a1")).rejects.toThrow(/closed/);
		await resetDocumentPreviewWorkersForTests();
		// Reusable after an explicit reset (tests only; production keeps the latch).
		const outcome = await requestDocumentPreview(docxPath);
		expect(outcome.ok).toBe(true);
	});
});
