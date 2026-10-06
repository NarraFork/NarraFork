import {
	type FileReference,
	type FileReferenceSnapshot,
	MAX_FILE_REFERENCE_COUNT,
	MAX_FILE_REFERENCE_METADATA_BYTES,
	MAX_FILE_REFERENCE_TOTAL_TEXT_BYTES,
} from "@shared/file-reference";
import { ValidationError } from "./errors";
import { fileReferencesSchema } from "./validators/file-references";

/** JSON bodies and multipart fields share the exact same strict input contract. */
export function parseFileReferenceInput(value: unknown): FileReference[] | undefined {
	if (value === undefined || value === null) return undefined;
	let input = value;
	if (typeof input === "string") {
		if (Buffer.byteLength(input, "utf8") > MAX_FILE_REFERENCE_METADATA_BYTES) {
			throw new ValidationError("File reference metadata exceeds 64 KiB");
		}
		try {
			input = JSON.parse(input);
		} catch {
			throw new ValidationError("Invalid fileReferences JSON");
		}
	}
	const parsed = fileReferencesSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return parsed.data;
}

function sameTarget(a: FileReference, b: FileReference): boolean {
	if (a.deviceId !== b.deviceId || a.path !== b.path || a.expectedHash !== b.expectedHash)
		return false;
	if (!a.selection || !b.selection) return a.selection === b.selection;
	return (
		a.selection.startLineNumber === b.selection.startLineNumber &&
		a.selection.startColumn === b.selection.startColumn &&
		a.selection.endLineNumber === b.selection.endLineNumber &&
		a.selection.endColumn === b.selection.endColumn
	);
}

/**
 * A text-only edit keeps accepted bytes, even if the source file no longer exists.
 * Only ids in THIS message/queue item can reuse a snapshot; everything else is
 * freshly authorized and captured. undefined keeps all, [] explicitly removes all.
 */
export async function replaceFileReferenceSnapshots(
	existing: readonly FileReferenceSnapshot[],
	requested: readonly FileReference[] | undefined,
	capture: (references: readonly FileReference[]) => Promise<FileReferenceSnapshot[]>,
): Promise<FileReferenceSnapshot[] | undefined> {
	if (requested === undefined) return undefined;
	const parsed = fileReferencesSchema.safeParse(requested);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const kept = new Map(existing.map((snapshot) => [snapshot.reference.id, snapshot]));
	const added = requested.filter((reference) => {
		const previous = kept.get(reference.id);
		return !previous || !sameTarget(previous.reference, reference);
	});
	const captured = added.length ? await capture(added) : [];
	const fresh = new Map(captured.map((snapshot) => [snapshot.reference.id, snapshot]));
	const result = requested.map((reference) => {
		const snapshot = fresh.get(reference.id) ?? kept.get(reference.id);
		if (!snapshot || (!fresh.has(reference.id) && !sameTarget(snapshot.reference, reference))) {
			throw new ValidationError("File reference capture did not return the requested target");
		}
		return {
			...snapshot,
			reference: {
				...snapshot.reference,
				label: reference.label,
				inputRange: reference.inputRange,
			},
		};
	});
	// Canonicalization can expand a short requested alias into a long saved path.
	// Validate the merged output, not just the requested list and newly captured subset.
	const mergedMetadata = fileReferencesSchema.safeParse(
		result.map((snapshot) => snapshot.reference),
	);
	if (!mergedMetadata.success) throw new ValidationError(mergedMetadata.error.message);
	const bytes = result.reduce(
		(total, snapshot) => total + Buffer.byteLength(snapshot.snapshotText, "utf8"),
		0,
	);
	if (result.length > MAX_FILE_REFERENCE_COUNT || bytes > MAX_FILE_REFERENCE_TOTAL_TEXT_BYTES) {
		throw new ValidationError("File reference snapshots exceed the message budget");
	}
	return result;
}
