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
// Provenance only: never keep the original full input behind a preview descriptor.
const rendererMarkers = new WeakSet<object>();
const PREVIEW_CHARS = 2048;

/** A bounded preview must not be a sliced string retaining a megabyte source. */
function sourcePreview(text: string): string {
	// Joining UTF-16 code units preserves lone/split surrogates while owning the
	// small result; encode/decode would silently replace invalid source units.
	return text.slice(0, PREVIEW_CHARS).split("").join("");
}

export function bindWriteDocumentReader(value: unknown, reader?: TextDocumentRangeReader): unknown {
	if (!reader || !value || typeof value !== "object" || Array.isArray(value)) return value;
	const document = (value as Record<string, unknown>).textDocument;
	if (!isTextDocumentRef(document)) return value;
	const source = document.source;
	const pinned =
		!!source?.toolCallId &&
		!!source.messageId &&
		Number.isSafeInteger(source.executionAttempt) &&
		(source.executionAttempt as number) >= 0;
	// Imported local bytes remain preferred by the store. Once evicted, an exact
	// persisted source can use the existing transport/rebound path instead.
	if (document.id.startsWith("write:") && !pinned) return value;
	const known = textDocumentStore.getSnapshot(document.id);
	if (known?.epoch === document.epoch) {
		receiveWriteDocument({ ref: known, offset: 0 }, undefined, reader);
	} else if (!known && rendererMarkers.has(document)) {
		// Only descriptors emitted by this module may reopen an evicted source;
		// arbitrary provider/user markers must still fail the provenance gate.
		receiveWriteDocument(
			{ ref: currentRecoveredDocumentRef(document), offset: 0 },
			undefined,
			reader,
		);
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
	rendererMarkers.add(document);
	return {
		...fields,
		_truncated: undefined,
		content: sourcePreview(document.preview ?? readLeafText(fields.content) ?? ""),
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
	const document =
		preview === undefined ? snapshot : { ...snapshot, preview: sourcePreview(preview) };
	rendererMarkers.add(document);
	return document;
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
		if (
			known?.epoch === effective.epoch &&
			(matchingSource || matchingAlias) &&
			textDocumentStore.hasReadableSource(known.id, known.epoch)
		) {
			const preview =
				known.epoch === fields.textDocument.epoch
					? fields.textDocument.preview
					: textDocumentStore.peekRange(known.id, 0, Math.min(PREVIEW_CHARS, known.length));
			const document = { ...known, preview };
			rendererMarkers.add(document);
			return { ...fields, content: preview ?? "", textDocument: document };
		}
		if (rendererMarkers.has(fields.textDocument)) {
			// The content on a renderer marker is a preview, not the original body.
			// A cold descriptor must recover its exact source, never seal 2048 chars
			// as a new complete document under an old identity/epoch.
			const source = fields.textDocument.source;
			const sourcePin =
				source?.narratorId === narratorId && source.toolUseId === toolUseId
					? {
							toolCallId: source.toolCallId,
							messageId: source.messageId,
							executionAttempt: source.executionAttempt,
						}
					: {};
			return {
				...fields,
				_truncated: true,
				textDocument: undefined,
				textDocumentSource: { narratorId, toolUseId, field: "content", ...sourcePin, ...ref },
			};
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
	if (
		cached &&
		isTextDocumentRef(cached.textDocument) &&
		textDocumentStore.hasReadableSource(cached.textDocument.id, cached.textDocument.epoch)
	)
		return cached;
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
	const preview = sourcePreview(fields.content);
	const marker = { ...document, preview };
	rendererMarkers.add(marker);
	const result = {
		...fields,
		content: preview,
		textDocument: marker,
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
