/** Complete code sources are independent of bounded card/transport previews. */
export interface TextDocumentSource {
	narratorId: string;
	toolUseId: string;
	field: string;
	toolCallId?: string;
	messageId?: string;
	executionAttempt?: number;
}

/** Raw source positions count UTF-16 code units, preserving CRLF and lone surrogates. */
export interface TextDocumentRef {
	id: string;
	epoch: string;
	revision: number;
	length: number;
	complete: boolean;
	originKnown: boolean;
	/** Bounded measurement input, never the visible document or copy source. */
	preview?: string;
	source?: TextDocumentSource;
}

/** The corresponding tool streamingField.delta supplies the text, without a duplicate payload. */
export interface TextDocumentStreamUpdate {
	ref: TextDocumentRef;
	offset: number;
}

export interface TextDocumentRange {
	ref: TextDocumentRef;
	offset: number;
	text: string;
}

export type TextDocumentRangeReader = (
	ref: TextDocumentRef,
	offset: number,
	limit: number,
	signal?: AbortSignal,
) => Promise<TextDocumentRange>;

/** Limits bound packets/work, never the total length of the accessible document. */
export const TEXT_DOCUMENT_PAGE_CHARS = 8 * 1024;
export const TEXT_DOCUMENT_PACKET_BYTES = 64 * 1024;
