import {
	TEXT_DOCUMENT_PACKET_BYTES,
	type TextDocumentRef,
} from "@shared/pretext-layout/text-document";
import type { TextDocumentTypography } from "@shared/pretext-layout/text-document-layout";
import type { DocumentToken } from "./text-document-pure-core";

export const TEXT_DOCUMENT_WORKER_WATCHDOG_MS = 60_000;
export const TEXT_DOCUMENT_DERIVED_CACHE_BYTES = 64 * 1024 * 1024;
export interface TextDocumentViewOptions extends TextDocumentTypography {
	language: string;
	theme: string;
	top: number;
	height: number;
	left: number;
	viewportWidth: number;
}
export interface DocumentPosition {
	index: number;
	top: number;
	left: number;
}
export interface DocumentRow {
	index: number;
	start: number;
	end: number;
	top: number;
	height: number;
	/** Full visual row width (not the horizontal crop width). */
	width: number;
	left: number;
}
export interface DocumentPoint {
	index: number;
	offset: number;
	x: number;
}
export type DocumentWorkerRequest =
	| { type: "boot"; role: "layout" | "tokens"; assetBase: string }
	| { type: "reset"; docId: string; epoch: string }
	| { type: "append"; docId: string; epoch: string; offset: number; text: string }
	| { type: "release"; docId: string }
	| { type: "cancel"; requestId: number; docId: string }
	| { type: "view"; requestId: number; ref: TextDocumentRef; options: TextDocumentViewOptions }
	| {
			type: "tokens";
			requestId: number;
			ref: TextDocumentRef;
			language: string;
			theme: string;
			ranges: { start: number; end: number }[];
	  }
	| {
			type: "position";
			requestId: number;
			ref: TextDocumentRef;
			options: TextDocumentViewOptions;
			offset: number;
	  };
export type DocumentWorkerResponse =
	| { type: "part"; requestId: number; section: "rows"; items: DocumentRow[] }
	| { type: "part"; requestId: number; section: "points"; items: DocumentPoint[] }
	| { type: "part"; requestId: number; section: "tokens"; items: DocumentToken[] }
	| {
			type: "done";
			requestId: number;
			epoch: string;
			revision: number;
			contentHeight?: number;
			contentWidth?: number;
			position?: DocumentPosition;
	  }
	| { type: "error"; requestId: number; error: string };

export function documentPacketBytes(packet: unknown): number {
	return new TextEncoder().encode(JSON.stringify(packet)).byteLength;
}
export function assertDocumentPacket(packet: unknown): void {
	if (documentPacketBytes(packet) > TEXT_DOCUMENT_PACKET_BYTES)
		throw new Error("Text document packet exceeds 64KiB");
}
/** Work remains bounded: no stringify of a full result/source to decide where to split. */
export function sendDocumentParts(
	requestId: number,
	section: "rows" | "points" | "tokens",
	items: readonly (DocumentRow | DocumentPoint | DocumentToken)[],
	send: (packet: DocumentWorkerResponse) => void,
): void {
	let batch: (DocumentRow | DocumentPoint | DocumentToken)[] = [];
	let bytes = 128;
	for (const item of items) {
		const cost = documentPacketBytes(item) + 1;
		if (bytes + cost > TEXT_DOCUMENT_PACKET_BYTES - 512 && batch.length) {
			const packet = { type: "part", requestId, section, items: batch } as DocumentWorkerResponse;
			assertDocumentPacket(packet);
			send(packet);
			batch = [];
			bytes = 128;
		}
		if (cost > TEXT_DOCUMENT_PACKET_BYTES - 512)
			throw new Error("Text document record exceeds packet budget");
		batch.push(item);
		bytes += cost;
	}
	if (batch.length) {
		const packet = { type: "part", requestId, section, items: batch } as DocumentWorkerResponse;
		assertDocumentPacket(packet);
		send(packet);
	}
}
