export const EDITOR_WORKER_LIMITS = Object.freeze({
	chunkBytes: 64 * 1024,
	metadataBytes: 16 * 1024,
	inFlight: 4,
	workers: 2,
	queue: 2,
	mirrorBytes: 128 * 1024 * 1024,
	textLength: 20 * 1024 * 1024,
	utf8Bytes: 64 * 1024 * 1024,
	queryLength: 4096,
	page: 256,
	cache: 10000,
	selectAll: 1000,
	replaceAll: 10000,
	searchTimeout: 2000,
	exportTimeout: 30000,
	conflictInputLength: 32 * 1024,
	conflictLines: 300,
	conflictOutputBytes: 256 * 1024,
});

export interface SearchOptions {
	query: string;
	caseSensitive: boolean;
	wholeWord: boolean;
	regexp: boolean;
}
export interface TextMatch {
	offset: number;
	length: number;
	/** A partial normalized glyph may be highlighted but must never be replaced. */
	precise?: false;
}
export interface TextEdit extends TextMatch {
	text: string;
}
export interface SearchPage {
	matches: TextMatch[];
	count: number;
	more: boolean;
}
export interface ReplacePlan {
	revision: number;
	edits: TextEdit[];
	length: number;
	utf8Bytes: number;
}
export interface EditDescriptor extends TextMatch {
	textLength: number;
}
export interface Envelope {
	docId: string;
	revision: number;
	jobId: string;
	seq: number;
}
export type WorkerCommand =
	| { type: "begin"; mode: "snapshot" | "changes"; baseRevision: number; length: number }
	| { type: "parameter"; name: "query" | "replacement"; length: number }
	| { type: "edit"; edit: EditDescriptor }
	| { type: "chunk"; data: ArrayBuffer }
	| { type: "commit" }
	| {
			type: "search";
			options: SearchOptions;
			anchor: number;
			backwards: boolean;
			selectAll: boolean;
	  }
	| { type: "replace"; options: SearchOptions; replacement: string; all: boolean; anchor: number }
	| { type: "encode" }
	| { type: "hash" }
	| { type: "diff"; split: number }
	| { type: "descriptors"; start: number }
	| { type: "output"; index: number };
export type WorkerRequest = Envelope & WorkerCommand;
export type WorkerValue =
	| null
	| string
	| SearchPage
	| { count: number; length: number; utf8Bytes: number; chunks: number }
	| { chunks: number; bytes: number; digest?: string }
	| { mirrorStats: { decodeMs: number; buildMs: number; chunks: number } }
	| EditDescriptor[]
	| ArrayBuffer;
export interface WorkerReady extends Envelope {
	type: "ready";
}
export type WorkerReply = Envelope &
	({ ok: true; value: WorkerValue } | { ok: false; error: string });

export function validateEnvelope(value: Envelope): void {
	if (
		!value ||
		typeof value.docId !== "string" ||
		value.docId.length > 256 ||
		typeof value.jobId !== "string" ||
		value.jobId.length > 256 ||
		!Number.isSafeInteger(value.revision) ||
		value.revision < 0 ||
		!Number.isSafeInteger(value.seq) ||
		value.seq < 0
	)
		throw new Error("EDITOR_PROTOCOL");
}
export function metadataSize(value: object): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
/** Binary chunks use UTF-16 code units: boundaries cannot corrupt surrogate pairs. */
export function textToBuffer(text: string): ArrayBuffer {
	const data = new Uint16Array(text.length);
	for (let i = 0; i < text.length; i++) data[i] = text.charCodeAt(i);
	return data.buffer;
}
const utf16Encoding =
	new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? "utf-16le" : "utf-16be";
const utf16Decoder = new TextDecoder(utf16Encoding, { ignoreBOM: true, fatal: true });

export function bufferToText(data: ArrayBuffer): string {
	if (data.byteLength > EDITOR_WORKER_LIMITS.chunkBytes || data.byteLength % 2) {
		throw new Error("EDITOR_PROTOCOL");
	}
	const units = new Uint16Array(data);
	let start = 0;
	let end = units.length;
	let prefix = "";
	let suffix = "";
	// A valid document may split a pair at either transport boundary. Keep only
	// those lone boundary units verbatim instead of penalizing the entire 32K chunk.
	if (units[0] >= 0xdc00 && units[0] <= 0xdfff) prefix = String.fromCharCode(units[start++]);
	if (end > start && units[end - 1] >= 0xd800 && units[end - 1] <= 0xdbff)
		suffix = String.fromCharCode(units[--end]);
	try {
		// fatal:true validates natively without a JS scan and never silently repairs
		// interior invalid units. ignoreBOM also preserves a BOM after a stripped prefix.
		return prefix + utf16Decoder.decode(units.subarray(start, end)) + suffix;
	} catch {
		// Wire/search semantics must preserve even genuinely invalid interior UTF-16.
		// UTF-8 export/hash separately reject it with EDITOR_INVALID_UNICODE.
		return String.fromCharCode(...units);
	}
}
