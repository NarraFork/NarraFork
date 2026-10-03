import { textDocumentStore } from "@frontend/lib/text-document-store";
import type {
	TextDocumentRangeReader,
	TextDocumentRef,
	TextDocumentStreamUpdate,
} from "@shared/pretext-layout/text-document";
import { isTextDocumentRef } from "@shared/pretext-layout/tool-detail";
import { readLeafText } from "@shared/pretext-layout/tool-io-projection";
import { currentRecoveredDocumentRef } from "./document-range-recovery";

const aliases = new Map<string, string>();
const imported = new WeakMap<object, Map<string, Record<string, unknown>>>();
const PREVIEW_CHARS = 2048;

/** Valid renderer markers still need this surface's recoverable reader on reopened history. */
export function bindWriteDocumentReader(value: unknown, reader?: TextDocumentRangeReader): unknown {
	if (!reader || !value || typeof value !== "object" || Array.isArray(value)) return value;
	const document = (value as Record<string, unknown>).textDocument;
	if (isTextDocumentRef(document) && !document.id.startsWith("write:")) {
		const known = textDocumentStore.getSnapshot(document.id);
		if (known?.epoch === document.epoch)
			receiveWriteDocument({ ref: known, offset: 0 }, undefined, reader);
	}
	return value;
}

/** Source hydration supersedes transport truncation without materializing the document. */
export function documentSourceInput(
	input: unknown,
	document: TextDocumentRef,
): Record<string, unknown> {
	const fields =
		input && typeof input === "object" && !Array.isArray(input)
			? (input as Record<string, unknown>)
			: {};
	return {
		...fields,
		_truncated: undefined,
		content: document.preview ?? readLeafText(fields.content)?.slice(0, PREVIEW_CHARS) ?? "",
		textDocument: document,
		textDocumentSource: undefined,
		textDocumentError: undefined,
	};
}

function identity(
	narratorId: string,
	toolUseId: string,
	ref?: { toolCallId?: string; messageId?: string; executionAttempt?: number },
): string {
	return JSON.stringify([
		narratorId,
		toolUseId,
		ref?.toolCallId
			? ["call", ref.toolCallId]
			: ref?.messageId
				? ["message", ref.messageId, ref.executionAttempt ?? null]
				: ["attempt", ref?.executionAttempt ?? null],
	]);
}

export function receiveWriteDocument(
	update: TextDocumentStreamUpdate,
	text?: string,
	reader?: TextDocumentRangeReader,
): TextDocumentRef {
	const currentRef = currentRecoveredDocumentRef(update.ref);
	textDocumentStore.register(currentRef, reader);
	if (text !== undefined && currentRef.epoch === update.ref.epoch)
		textDocumentStore.append(currentRef, update.offset, text);
	const source = currentRef.source;
	if (source) {
		aliases.set(identity(source.narratorId, source.toolUseId, source), update.ref.id);
		if (source.executionAttempt !== undefined)
			aliases.set(
				identity(source.narratorId, source.toolUseId, {
					executionAttempt: source.executionAttempt,
				}),
				update.ref.id,
			);
		if (aliases.size > 8192) aliases.delete(aliases.keys().next().value as string);
		// Unpinned late started belongs to the current live attempt, never a historical row.
		aliases.set(identity(source.narratorId, source.toolUseId), update.ref.id);
	}
	const snapshot = textDocumentStore.getSnapshot(update.ref.id) ?? update.ref;
	const preview = textDocumentStore.peekRange(
		snapshot.id,
		0,
		Math.min(PREVIEW_CHARS, snapshot.length),
	);
	return preview === undefined ? snapshot : { ...snapshot, preview };
}

/** Once-only full input import; retained detail resolvers remain the owners of payloads. */
export function documentWriteInput(
	narratorId: string,
	toolUseId: string,
	input: unknown,
	ref?: { toolCallId?: string; messageId?: string; executionAttempt?: number },
	live = false,
): unknown {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input;
	const fields = input as Record<string, unknown>;
	if (isTextDocumentRef(fields.textDocument)) {
		const known = textDocumentStore.getSnapshot(fields.textDocument.id);
		const pinned = !!(ref?.toolCallId || ref?.messageId || ref?.executionAttempt !== undefined);
		const matchingSource =
			known?.source?.narratorId === narratorId &&
			known.source.toolUseId === toolUseId &&
			(!pinned ||
				(ref?.toolCallId !== undefined && known.source.toolCallId === ref.toolCallId) ||
				(ref?.executionAttempt !== undefined &&
					known.source.executionAttempt === ref.executionAttempt));
		const matchingAlias = aliases.get(identity(narratorId, toolUseId, ref)) === known?.id;
		const effective = currentRecoveredDocumentRef(fields.textDocument);
		if (known?.epoch === effective.epoch && (matchingSource || matchingAlias)) {
			const preview =
				known.epoch === fields.textDocument.epoch
					? fields.textDocument.preview
					: textDocumentStore.peekRange(known.id, 0, Math.min(PREVIEW_CHARS, known.length));
			return { ...fields, content: preview ?? "", textDocument: { ...known, preview } };
		}
	}
	// Unregistered input markers are user/provider data, not trusted source descriptors.
	if (typeof fields.content !== "string")
		return {
			...fields,
			textDocument: undefined,
			textDocumentSource: { narratorId, toolUseId, field: "content", ...ref },
		};
	const key = identity(narratorId, toolUseId, ref);
	const cached = imported.get(fields)?.get(key);
	if (cached) return cached;
	const id =
		aliases.get(key) ??
		(ref?.executionAttempt !== undefined
			? aliases.get(identity(narratorId, toolUseId, { executionAttempt: ref.executionAttempt }))
			: undefined) ??
		`write:${key}`;
	const importedRef = textDocumentStore.importText(id, fields.content, !live);
	textDocumentStore.register({
		...importedRef,
		source: { ...importedRef.source, narratorId, toolUseId, field: "content", ...ref },
	});
	const document = textDocumentStore.getSnapshot(id) ?? importedRef;
	const result = {
		...fields,
		content: fields.content.slice(0, PREVIEW_CHARS),
		textDocument: { ...document, preview: fields.content.slice(0, PREVIEW_CHARS) },
	};
	let values = imported.get(fields);
	if (!values) {
		values = new Map();
		imported.set(fields, values);
	}
	values.set(key, result);
	aliases.set(key, document.id);
	return result;
}
