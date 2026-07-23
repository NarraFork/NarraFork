import type { PretextLayoutManifest } from "./index";

export interface PretextLayoutGoldenItem {
	itemKey: string;
	firstSeq: number;
	lastSeq: number;
	sourceMessageIds: readonly string[];
	kind: string;
	height: number;
	start: number;
	end: number;
}

export interface PretextLayoutGolden {
	layoutRevision: string;
	documentRevision: string | number;
	lod: number;
	widthBucket: string | number;
	metrics: PretextLayoutManifest["metrics"];
	totalHeight: number;
	items: readonly PretextLayoutGoldenItem[];
}

/**
 * Project only deterministic geometry fields for cross-runtime comparison.
 * Prepared handles, caches, and renderer payloads never enter a golden fixture.
 */
export function projectPretextLayoutGolden(
	manifest: PretextLayoutManifest,
	itemStarts: readonly number[],
	itemEnds: readonly number[],
	totalHeight: number,
): PretextLayoutGolden {
	if (manifest.items.length !== itemStarts.length || manifest.items.length !== itemEnds.length)
		throw new Error("pretext golden projection arrays must match manifest item count");
	return {
		layoutRevision: manifest.layoutRevision,
		documentRevision: manifest.documentRevision,
		lod: manifest.lod,
		widthBucket: manifest.widthBucket,
		metrics: { ...manifest.metrics },
		totalHeight,
		items: manifest.items.map((item, index) => ({
			itemKey: item.itemKey,
			firstSeq: item.firstSeq,
			lastSeq: item.lastSeq,
			sourceMessageIds: [...item.sourceMessageIds],
			kind: item.kind,
			height: item.height,
			start: itemStarts[index] ?? 0,
			end: itemEnds[index] ?? 0,
		})),
	};
}

export function serializePretextLayoutGolden(golden: PretextLayoutGolden): string {
	return JSON.stringify(golden);
}
