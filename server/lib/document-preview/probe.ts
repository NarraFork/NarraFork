/**
 * Format detection by CONTENT, never by extension.
 *
 * A `.docx` renamed to `.zip`, or a legacy binary `.doc` mislabelled `.docx`, must route to
 * the right answer or be refused with a reason. Silently treating an OLE file as OOXML
 * produces garbage text that looks like a successful preview — the exact failure this module
 * exists to prevent.
 *
 * Ported from `examples/plugins/doc-markdown/server/lib/probe.js` (branch
 * `experiment/doc-to-markdown`), narrowed to the formats this preview supports.
 */

import type { DocumentKind } from "./types";
import { looksLikeZip, openZip } from "./zip";

const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const PDF_SIGNATURE = Buffer.from("%PDF-", "ascii");

export interface DetectedFormat {
	kind: DocumentKind;
	/** Machine-readable reason for a refusal; the client maps it to a localized message. */
	reason?: "legacy-office" | "pdf" | "unsupported";
	detail?: string;
}

export function detectFormat(buffer: Buffer, filePath: string): DetectedFormat {
	if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
		return { kind: "unsupported", reason: "unsupported", detail: "the file is empty" };
	}
	if (buffer.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
		return {
			kind: "pdf",
			reason: "pdf",
			detail: "PDF is rendered by the browser viewer, not by the document parser",
		};
	}
	if (
		buffer.length >= OLE_SIGNATURE.length &&
		buffer.subarray(0, OLE_SIGNATURE.length).equals(OLE_SIGNATURE)
	) {
		return {
			kind: "legacy-office",
			reason: "legacy-office",
			detail: "this is a legacy binary Office file (DOC/XLS/PPT); re-save it as DOCX to preview it",
		};
	}
	if (!looksLikeZip(buffer)) {
		return {
			kind: "unsupported",
			reason: "unsupported",
			detail: `unrecognised container for ${filePath}`,
		};
	}

	let zip: ReturnType<typeof openZip>;
	try {
		zip = openZip(buffer);
	} catch (error) {
		return {
			kind: "unsupported",
			reason: "unsupported",
			detail: `unreadable ZIP container: ${error instanceof Error ? error.message : "unknown"}`,
		};
	}

	if (zip.has("word/document.xml")) return { kind: "docx" };

	return {
		kind: "unsupported",
		reason: "unsupported",
		detail: "the ZIP container has no word/document.xml (not a Word document)",
	};
}
