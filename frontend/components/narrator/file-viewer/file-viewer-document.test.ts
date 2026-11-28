/**
 * Word documents in the file viewer.
 *
 * The defect this covers: `.docx` used to classify as `text`, so the viewer decoded a ZIP
 * container as UTF-8 and rendered garbage. Documents must now expose exactly one mode
 * (preview), and a line selection must not pull them back onto the text path.
 */

import { describe, expect, test } from "bun:test";
import { getFilePreviewType } from "../file-panel/FilePreviewModal";
import { fileViewerUsesText } from "./FileViewerContent";
import { availableModes, isDocumentPath, isLegacyDocumentPath } from "./file-viewer-modes";

describe("document classification", () => {
	test("routes Word files away from the text preview", () => {
		expect(getFilePreviewType("/repo/design/spec.docx")).toBe("document");
		expect(getFilePreviewType("C:\\repo\\design\\spec.DOCM")).toBe("document");
		expect(getFilePreviewType("/repo/design/spec.doc")).toBe("legacy-doc");
		// Unrelated types keep their existing route.
		expect(getFilePreviewType("/repo/design/spec.md")).toBe("text");
		expect(getFilePreviewType("/repo/design/spec.pdf")).toBe("pdf");
		expect(getFilePreviewType("/repo/design/shot.png")).toBe("image");
	});

	test("detects documents by extension helper alone", () => {
		expect(isDocumentPath("/a/spec.docx")).toBe(true);
		expect(isDocumentPath("/a/spec.doc")).toBe(false);
		expect(isLegacyDocumentPath("/a/spec.doc")).toBe(true);
		expect(isLegacyDocumentPath("/a/spec.docx")).toBe(false);
	});
});

describe("document viewer modes", () => {
	test("offers preview only — never raw, which would show a ZIP as text", () => {
		expect(availableModes("/repo/spec.docx")).toEqual(["preview"]);
		expect(availableModes("/repo/spec.doc")).toEqual(["preview"]);
		// A selection cannot add a raw mode either.
		expect(
			availableModes("/repo/spec.docx", {
				startLineNumber: 1,
				startColumn: 1,
				endLineNumber: 1,
				endColumn: 2,
			}),
		).toEqual(["preview"]);
	});

	test("keeps existing modes for other file types", () => {
		expect(availableModes("/repo/notes.md")).toEqual(["preview", "raw"]);
		expect(availableModes("/repo/code.ts")).toEqual(["raw"]);
	});
});

describe("document text routing", () => {
	test("a document never uses the UTF-8 text channel, even with a selection", () => {
		const selection = {
			startLineNumber: 1,
			startColumn: 1,
			endLineNumber: 1,
			endColumn: 2,
		};
		for (const deviceId of ["local", "remote-device"]) {
			expect(fileViewerUsesText("document", undefined, false, deviceId)).toBe(false);
			expect(fileViewerUsesText("document", selection, false, deviceId)).toBe(false);
			expect(fileViewerUsesText("legacy-doc", undefined, true, deviceId)).toBe(false);
			expect(fileViewerUsesText("legacy-doc", selection, true, deviceId)).toBe(false);
		}
	});

	test("other types keep their previous routing", () => {
		expect(fileViewerUsesText("text", undefined, false, "local")).toBe(true);
		expect(fileViewerUsesText("image", undefined, false, "local")).toBe(false);
		expect(fileViewerUsesText("pdf", undefined, false, "local")).toBe(false);
		expect(fileViewerUsesText("pdf", undefined, true, "local")).toBe(true);
	});
});
