/**
 * measure-cache.ts — Module-level measurement cache for pretext element heights.
 *
 * The cache eliminates redundant height computation when `buildPretextDocumentLayout`
 * rebuilds the full window on loadOlder (prepend). Items already measured with the
 * same (key, width, lod, opts, dataRevision) hit the cache, reducing rebuild cost
 * from O(window) to O(new items only).
 *
 * Design: plain Map (no per-entry LRU eviction).
 *
 * Why NOT LRU: the layout pipeline does a sequential full-window scan on every
 * rebuild. With a small LRU cap (e.g. 4000), once the window exceeds the cap the
 * scan evicts entries at the front that the NEXT rebuild will need again — classic
 * "LRU thrash on sequential access". The result is 0% hit rate and worse-than-no-
 * cache overhead.
 *
 * Instead we use a large ceiling with bulk-clear-on-overflow. Within a single
 * narrator session the working set grows monotonically and is always fully retained.
 * The ceiling (131072) accommodates ~65k items (a 30k-message narrator) plus stale
 * entries from 1-2 previously-viewed narrators. If somehow exceeded, a full clear
 * is a one-time cost (next build repopulates the current window).
 *
 * Memory budget: each MeasuredElement is ~0.3-1KB (height + PreparedBlock array +
 * frame). At 131k entries ≈ 40-130MB worst case — acceptable for a desktop app.
 * In practice, a single narrator's entries are 20-60MB.
 *
 * Cache key anatomy:
 *   `${spec.key}|${kind}|${roundedWidth}|${lod}|r:${dataRevision}|${optsDigest}`
 *
 * Streaming items (key contains "__streaming__") are never cached because their
 * content changes between measurements.
 */

import type { MeasuredElement } from "./prepared-block";

// ─────────────────────────────────────────────────────────────────────────────
// MeasureCache — Plain Map with high ceiling + bulk-clear fallback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Measurement cache backed by a plain Map. No per-entry eviction. When the
 * entry count exceeds `ceiling`, the entire map is cleared (rare, one-time cost).
 *
 * This avoids LRU thrash on sequential full-window scans while still bounding
 * memory for pathological multi-narrator usage.
 */
export class MeasureCache {
	private map = new Map<string, MeasuredElement>();
	private _hits = 0;
	private _misses = 0;

	constructor(private ceiling: number) {}

	get(key: string): MeasuredElement | undefined {
		const value = this.map.get(key);
		if (value === undefined) {
			this._misses++;
			return undefined;
		}
		this._hits++;
		return value;
	}

	set(key: string, value: MeasuredElement): void {
		// Bulk-clear when ceiling is exceeded. This is a safety valve — in normal
		// usage (single narrator) the map never reaches this. When it fires (e.g.
		// user scrolled through multiple huge narrators), the next build repopulates
		// the current window in one pass.
		if (this.map.size >= this.ceiling && !this.map.has(key)) {
			this.map.clear();
		}
		this.map.set(key, value);
	}

	clear(): void {
		this.map.clear();
		this._hits = 0;
		this._misses = 0;
	}

	get size(): number {
		return this.map.size;
	}

	get hits(): number {
		return this._hits;
	}

	get misses(): number {
		return this._misses;
	}

	resetStats(): void {
		this._hits = 0;
		this._misses = 0;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache key construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the spec key represents a streaming/transient item whose
 * content is still changing (height would be stale on next measure).
 */
export function isStreamingKey(key: string): boolean {
	return key.includes("__streaming__");
}

/**
 * Build a deterministic cache key from the inputs that affect measured height.
 * Designed to be fast (no JSON.stringify of large objects, no hash).
 */
export function buildCacheKey(
	specKey: string,
	kind: string,
	contentWidth: number,
	lod: number,
	opts: Record<string, unknown> | undefined,
	dataRevision?: string,
): string {
	const w = Math.round(contentWidth);
	let key = `${specKey}|${kind}|${w}|${lod}`;
	if (dataRevision) key += `|r:${dataRevision}`;
	if (opts && !optsIsEmpty(opts)) key += `|${digestOpts(opts)}`;
	return key;
}

/**
 * Extract a lightweight revision string from the data payload that captures
 * height-affecting mutations (status transitions, streaming flags) for items
 * whose spec.key stays stable across state changes.
 *
 * This is intentionally cheap: only pulls primitive fields known to affect
 * measure outcomes. Unknown/complex data gets no revision (safe — only means
 * no invalidation on status transition, but those items typically also change
 * opts which triggers a miss anyway).
 */
export function extractDataRevision(data: unknown): string | undefined {
	if (data == null || typeof data !== "object") return undefined;
	const d = data as Record<string, unknown>;
	// Collect height-affecting primitives that can change for the same spec.key.
	let rev = "";
	if ("status" in d && d.status != null) rev += `s:${d.status}`;
	if ("isStreaming" in d && d.isStreaming) rev += "|st:1";
	if ("isActive" in d && d.isActive) rev += "|ac:1";
	if ("isTerminal" in d && d.isTerminal) rev += "|te:1";
	return rev || undefined;
}

function optsIsEmpty(opts: Record<string, unknown>): boolean {
	for (const _k in opts) return false;
	return true;
}

/**
 * Produce a compact, deterministic string digest of the opts record.
 * Opts values are booleans, numbers, small arrays of numbers, or undefined.
 * We sort keys for stability and encode values concisely.
 */
function digestOpts(opts: Record<string, unknown>): string {
	const keys = Object.keys(opts).sort();
	let result = "";
	for (let i = 0; i < keys.length; i++) {
		const k = keys[i];
		if (!k) continue;
		const v = opts[k];
		if (v === undefined) continue;
		if (result.length > 0) result += ";";
		result += `${k}=`;
		if (typeof v === "boolean") {
			result += v ? "1" : "0";
		} else if (typeof v === "number") {
			result += String(v);
		} else if (Array.isArray(v)) {
			// Small sorted array of numbers (expandedIndices, expandedRows)
			const sorted = (v as number[]).slice().sort((a, b) => a - b);
			result += sorted.join(",");
		} else if (v instanceof Set) {
			const sorted = [...v].sort();
			result += sorted.join(",");
		} else if (typeof v === "string") {
			result += v;
		} else {
			// Unknown complex value — include a marker to ensure cache miss
			// rather than a stale hit.
			result += `?${typeof v}`;
		}
	}
	return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level singleton
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Module-level cache shared by all measureElement calls.
 *
 * Ceiling 131072 accommodates:
 * - A 30k-message narrator ≈ 60k items (well within ceiling)
 * - Plus stale entries from 1-2 previously-viewed narrators before bulk-clear fires
 *
 * No per-entry eviction. The working set is always fully retained.
 */
export const measureCache = new MeasureCache(131072);
