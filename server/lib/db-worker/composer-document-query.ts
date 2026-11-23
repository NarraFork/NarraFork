import type { Database } from "bun:sqlite";
import { MAX_COMPOSER_DOCUMENT_BYTES } from "@shared/composer-document";
import { isMediaContentBlock } from "@shared/media-attachments";
import { getFileReferenceSnapshots } from "../agent/file-reference-projection";
import { boundedBodyText, hasBlockStorage, hasRowsOnlyBodies } from "../narrator-bodies";
import { COMPOSER_DOCUMENT_RESULT_BYTES } from "./domain-protocol";

export interface ComposerDocumentParams {
	narratorId: string;
	messageId: string;
	blockReads: boolean;
}

export type ComposerDocumentMetadata =
	| { kind: "missing" }
	| { kind: "rejected" }
	| { kind: "found"; refId: string; bodyRevision: number; stateRevision: number };

type ComposerDocumentSnapshot = ComposerDocumentMetadata & { json?: string };

const BODY_BYTES = 4 * 1024 * 1024;

export function readComposerDocument(
	sqlite: Database,
	params: ComposerDocumentParams,
	signal: AbortSignal,
): ComposerDocumentSnapshot {
	const { narratorId, messageId } = params;
	signal.throwIfAborted();
	const snapshot = sqlite.transaction(() => {
		const row = sqlite
			.query<
				{
					refId: string;
					bodyRevision: number;
					stateRevision: number;
					role: string;
					documentBytes: number;
				},
				[string, string]
			>(
				`SELECT r.id AS refId, m.body_revision AS bodyRevision,
				        m.state_revision AS stateRevision, m.role,
				        coalesce(octet_length(m.composer_document), 0) AS documentBytes
				 FROM narrator_message_refs r JOIN narrator_messages m ON m.id = r.message_id
				 WHERE r.narrator_id = ? AND r.message_id = ? LIMIT 1`,
			)
			.get(narratorId, messageId);
		if (!row) return { kind: "missing" } as const;
		if (row.role !== "user" || row.documentBytes > MAX_COMPOSER_DOCUMENT_BYTES)
			return { kind: "rejected" } as const;

		const fromBlocks = hasBlockStorage(sqlite) && (params.blockReads || hasRowsOnlyBodies(sqlite));
		const body = boundedBodyText(sqlite, messageId, fromBlocks, { maxBytes: BODY_BYTES });
		if (body === undefined) return { kind: "rejected" } as const;
		signal.throwIfAborted();
		const document =
			sqlite
				.query<{ raw: string | null }, [string]>(
					"SELECT composer_document AS raw FROM narrator_messages WHERE id = ? LIMIT 1",
				)
				.get(messageId)?.raw ?? null;
		return {
			kind: "source",
			document,
			body,
			refId: row.refId,
			bodyRevision: row.bodyRevision,
			stateRevision: row.stateRevision,
		} as const;
	})();
	if (snapshot.kind !== "source") return snapshot;
	signal.throwIfAborted();
	const json = JSON.stringify(
		projectComposerDocument(
			narratorId,
			snapshot.document,
			snapshot.bodyRevision,
			JSON.parse(snapshot.body),
		),
	);
	if (Buffer.byteLength(json) > COMPOSER_DOCUMENT_RESULT_BYTES) return { kind: "rejected" };
	return {
		kind: "found",
		json,
		refId: snapshot.refId,
		bodyRevision: snapshot.bodyRevision,
		stateRevision: snapshot.stateRevision,
	};
}

export function projectComposerDocument(
	id: string,
	document: string | null,
	bodyRevision: number,
	blocks: Record<string, unknown>[],
) {
	const images = Array.isArray(blocks)
		? blocks
				.filter((block) => block.type === "image" && typeof block.imageId === "string")
				.map((block) => ({
					imageId: block.imageId,
					filename: block.filename,
					mediaType: block.mediaType,
					width: block.width,
					height: block.height,
					uploadNarratorId: block.uploadNarratorId ?? id,
					size: block.size,
					sourceMimeType: block.sourceMimeType,
				}))
		: [];
	const textFiles = Array.isArray(blocks)
		? blocks
				.filter((block) => block.type === "text_file" && typeof block.filePath === "string")
				.map((block) => ({ filename: block.filename, filePath: block.filePath, size: block.size }))
		: [];
	return {
		composerDocument: document === null ? undefined : (JSON.parse(document) ?? undefined),
		images,
		media: Array.isArray(blocks)
			? blocks.filter(isMediaContentBlock).map((media) => ({
					mediaId: media.mediaId,
					filename: media.filename,
					mediaType: media.mediaType,
					size: media.size,
					uploadNarratorId: media.uploadNarratorId ?? id,
				}))
			: [],
		textFiles,
		bodyRevision,
		text: Array.isArray(blocks)
			? blocks
					.filter((block) => block.type === "text" && typeof block.text === "string")
					.map((block) => block.text)
					.join("")
			: "",
		fileReferences: getFileReferenceSnapshots(blocks).map((snapshot) => snapshot.reference),
	};
}
