import {
	MAX_FILE_PANEL_BYTES,
	MAX_FILE_REFERENCE_COUNT,
	MAX_FILE_REFERENCE_METADATA_BYTES,
	MAX_FILE_REFERENCE_PATH_CHARS,
	MAX_FILE_REFERENCE_POSITION,
	MAX_FILE_REFERENCE_QUERY_CHARS,
} from "@shared/file-reference";
import { z } from "zod";

const coordinate = z.number().int().min(1).max(MAX_FILE_REFERENCE_POSITION);
const path = z
	.string()
	.min(1)
	.max(MAX_FILE_REFERENCE_PATH_CHARS)
	.refine((value) => !value.includes("\0") && !/[\r\n]/.test(value), "Invalid file path");
const deviceId = z.string().min(1).max(256);

export const fileSelectionSchema = z
	.strictObject({
		startLineNumber: coordinate,
		startColumn: coordinate,
		endLineNumber: coordinate,
		endColumn: coordinate,
	})
	.refine(
		(s) =>
			s.endLineNumber > s.startLineNumber ||
			(s.endLineNumber === s.startLineNumber && s.endColumn >= s.startColumn),
		"Selection end precedes start",
	);

export const fileTargetSchema = z.strictObject({
	deviceId,
	path,
	selection: fileSelectionSchema.optional(),
});

/** Strict objects deliberately reject every server-owned snapshot field. */
export const fileReferenceSchema = fileTargetSchema.extend({
	id: z.string().min(1).max(256),
	label: z.string().min(1).max(MAX_FILE_REFERENCE_PATH_CHARS),
	inputRange: z
		.tuple([
			z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
			z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		])
		.refine(([start, end]) => end >= start, "Invalid input range")
		.optional(),
	expectedHash: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
});

const metadataWithinBudget = (value: unknown) =>
	Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_FILE_REFERENCE_METADATA_BYTES;

export const fileReferencesSchema = z
	.array(fileReferenceSchema)
	.max(MAX_FILE_REFERENCE_COUNT)
	.refine(metadataWithinBudget, "File reference metadata exceeds 64 KiB")
	.refine(
		(refs) => new Set(refs.map((ref) => ref.id)).size === refs.length,
		"Duplicate file reference id",
	);
export const resolveFileReferencesSchema = z.strictObject({
	targets: z
		.array(fileTargetSchema)
		.max(MAX_FILE_REFERENCE_COUNT)
		.refine(metadataWithinBudget, "File target metadata exceeds 64 KiB"),
});
export const searchFileReferencesSchema = z.strictObject({
	q: z.string().max(MAX_FILE_REFERENCE_QUERY_CHARS).default(""),
	deviceId: deviceId.optional(),
	directory: path.optional(),
});
export const previewFileReferenceSchema = z.strictObject({ deviceId, path });
export const filePanelPageSchema = previewFileReferenceSchema.extend({
	offset: z
		.string()
		.regex(/^\d+$/)
		.transform(Number)
		.pipe(z.number().int().min(0).max(MAX_FILE_PANEL_BYTES)),
});
