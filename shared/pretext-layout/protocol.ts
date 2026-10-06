import type { PretextLayoutItem, PretextLayoutMetrics } from "./index";

export const PRETEXT_LAYOUT_PROTOCOL = "pretext-layout" as const;
export const PRETEXT_LAYOUT_PROTOCOL_VERSION = 1 as const;
export const PRETEXT_LAYOUT_MAX_ITEMS_PER_CHUNK = 512;
export const PRETEXT_LAYOUT_MAX_TOTAL_ITEMS = 50_000;
export const PRETEXT_LAYOUT_MAX_CHUNK_BYTES = 512 * 1024;

export interface PretextLayoutIdentity {
	layoutRevision: string;
	documentRevision: string | number;
	lod: number;
	widthBucket: string | number;
	layoutOptionsRevision: string;
}

export interface PretextLayoutRequest extends PretextLayoutIdentity {
	type: "pretext_layout_request";
	requestId: string;
	narratorId: string;
	protocolVersion?: number;
}

export interface PretextLayoutBegin extends PretextLayoutIdentity {
	type: "pretext_layout_begin";
	requestId: string;
	narratorId: string;
	protocol: typeof PRETEXT_LAYOUT_PROTOCOL;
	protocolVersion: typeof PRETEXT_LAYOUT_PROTOCOL_VERSION;
	itemCount: number;
	metrics: PretextLayoutMetrics;
}

export interface PretextLayoutChunk extends PretextLayoutIdentity {
	type: "pretext_layout_chunk";
	requestId: string;
	narratorId: string;
	chunkIndex: number;
	items: readonly PretextLayoutItem[];
}

export interface PretextLayoutEnd extends PretextLayoutIdentity {
	type: "pretext_layout_end";
	requestId: string;
	narratorId: string;
	chunkCount: number;
	itemCount: number;
	checksum: string;
}

export interface PretextLayoutInvalidation {
	type: "pretext_layout_invalidated";
	narratorId: string;
	documentRevision: string | number;
	reason: "document_changed" | "lod_changed" | "width_changed" | "structure_changed" | string;
}

export interface PretextContentRequest {
	type: "pretext_content_request";
	requestId: string;
	narratorId: string;
	layoutRevision: string;
	itemRange: { start: number; end: number };
	mask: readonly string[];
	maxBytes: number;
	maxItems: number;
}

export type PretextLayoutClientMessage = PretextLayoutRequest | PretextContentRequest;
export type PretextLayoutServerMessage =
	| PretextLayoutBegin
	| PretextLayoutChunk
	| PretextLayoutEnd
	| PretextLayoutInvalidation;
