/**
 * Document read-only preview: entry point used by the route (through the worker).
 *
 * Reads the file under a size cap, decides the format by content, and either renders it to
 * Markdown with addressable pictures or refuses with a machine-readable reason.
 *
 * Nothing here touches HTTP, the database, or the frontend — the worker entry imports this so
 * the CPU-heavy inflate/XML walk never runs on the server's main thread.
 */

import { stat } from "node:fs/promises";
import { parseDocx, readDocxAsset } from "./docx";
import { MAX_DOCUMENT_BYTES } from "./limits";
import { detectFormat } from "./probe";
import type { DocumentParseOutcome } from "./types";

async function readBounded(filePath: string): Promise<Buffer> {
	const info = await stat(filePath);
	if (!info.isFile()) throw new Error(`Not a file: ${filePath}`);
	if (info.size > MAX_DOCUMENT_BYTES) {
		throw new Error(`File is larger than ${MAX_DOCUMENT_BYTES} bytes to preview`);
	}
	const bytes = await Bun.file(filePath).arrayBuffer();
	return Buffer.from(bytes);
}

export async function readDocumentPreview(filePath: string): Promise<DocumentParseOutcome> {
	const buffer = await readBounded(filePath);
	const detected = detectFormat(buffer, filePath);

	if (detected.kind !== "docx") {
		return {
			ok: false,
			failure: {
				kind:
					detected.kind === "pdf"
						? "pdf"
						: detected.reason === "legacy-office"
							? "legacy-office"
							: "unsupported",
				reason: detected.reason ?? "unsupported",
				detail: detected.detail ?? "",
			},
		};
	}

	try {
		return { ok: true, result: parseDocx(buffer, { filePath }) };
	} catch (error) {
		return {
			ok: false,
			failure: {
				kind: "unsupported",
				reason: "unsupported",
				detail: error instanceof Error ? error.message : "unknown parse failure",
			},
		};
	}
}

export async function readDocumentAsset(
	filePath: string,
	assetId: string,
): Promise<{ bytes: Uint8Array; mime: string } | undefined> {
	const buffer = await readBounded(filePath);
	const detected = detectFormat(buffer, filePath);
	if (detected.kind !== "docx") return undefined;
	return readDocxAsset(buffer, assetId, filePath);
}
