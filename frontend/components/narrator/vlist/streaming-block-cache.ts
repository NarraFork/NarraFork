/**
 * Pane-owned incremental Markdown preparation, using the lexer's block boundaries.
 *
 * Retain one current source, its settled blocks and the last two live units' offsets,
 * never a map of previous streaming prefixes. Growing live units are re-lexed; unchanged
 * units reuse prepared handles. A blank line is NOT a safe Markdown boundary (it
 * can belong to a fence or a loose list), so only lexer offsets advance settling.
 *
 * Source characters and unit counts are retention proxies, NOT heap bytes. Limits
 * apply across the whole instance. Oversized bodies still return complete results;
 * they simply do not stay cached. Returned prepared blocks must not be mutated.
 */

import {
	parseMarkdownToPreparedBlocks,
	parseMarkdownUnits,
} from "@shared/pretext-layout/parse-markdown";
import type { PreparedBlock } from "@shared/pretext-layout/prepared-block";
import { getPreparedFontRevision } from "@shared/pretext-layout/prepared-markdown-cache";
import { getTypographyRevision } from "@shared/pretext-layout/typography";
import { getKatexRevision } from "./katex-runtime";
import { markdownMathSupport } from "./measure/math-support";

// Keep the preceding unit live too: another list item can make its whole list loose.
const LIVE_TAIL_TOKENS = 2;
const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_MAX_SOURCE_CHARS = 256 * 1024;
const MAX_UNITS = 512;

interface LiveUnit {
	/** Offsets in this entry's current lastText; no separately retained raw string. */
	rawStart: number;
	rawEnd: number;
	isFirst: boolean;
	blocks: PreparedBlock[];
}

interface StreamingEntry {
	/** Only CURRENT live units, not old versions or already-settled raw keys. */
	memo: LiveUnit[];
	/** Exactly one current full source, needed to distinguish append from replacement. */
	lastText: string;
	settledLength: number;
	settledBlocks: PreparedBlock[];
	settledUnits: number;
	sourceChars: number;
	build: number;
}

export interface StreamingBlockCacheOptions {
	maxEntries?: number;
	/** UTF-16 source characters, not bytes or a measured heap-size limit. */
	maxSourceChars?: number;
	/** Aggregate top-level lexer units; capped at 512 even for a larger option. */
	maxUnits?: number;
}

export interface StreamingBlockCacheStats {
	entries: number;
	memoUnits: number;
	settledUnits: number;
	retainedUnits: number;
	/** Raw characters in the current live tail only. */
	memoSourceChars: number;
	/** Current full sources, including whitespace; excludes prepared object/heap sizes. */
	retainedSourceChars: number;
	maxEntries: number;
	maxSourceChars: number;
	maxUnits: number;
}

function limit(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function preparationRevision(): string {
	return `${getPreparedFontRevision()}:${getTypographyRevision()}:${getKatexRevision()}`;
}

export class StreamingBlockCache {
	private readonly entries = new Map<string, StreamingEntry>();
	private readonly maxEntries: number;
	private readonly maxSourceChars: number;
	private readonly maxUnits: number;
	private sourceChars = 0;
	private units = 0;
	private revision = preparationRevision();
	private build = 0;
	private building = false;

	constructor(options: StreamingBlockCacheOptions = {}) {
		this.maxEntries = limit(options.maxEntries, DEFAULT_MAX_ENTRIES);
		this.maxSourceChars = limit(options.maxSourceChars, DEFAULT_MAX_SOURCE_CHARS);
		this.maxUnits = Math.min(MAX_UNITS, limit(options.maxUnits, MAX_UNITS));
	}

	get(key: string, text: string): PreparedBlock[] {
		const revision = preparationRevision();
		if (revision !== this.revision) {
			// Drop every row, including settled blocks prepared with old font metrics.
			this.clear();
			this.revision = revision;
		}
		if (text.length === 0) {
			this.clear(key);
			return [];
		}

		const math = markdownMathSupport();
		if (
			this.maxEntries === 0 ||
			this.maxUnits === 0 ||
			text.length > this.maxSourceChars ||
			// Definitions can retroactively change references ANYWHERE in the body.
			// A suffix lexer cannot carry that global context. Conservatively use the
			// full parser for possible definitions (also safe for false positives).
			text.includes("]:")
		) {
			this.clear(key);
			return parseMarkdownToPreparedBlocks(text, math);
		}

		const previous = this.entries.get(key);
		// Matching only the settled prefix is insufficient: replacing "abc\n\n..."
		// with "abcDEF" merges that settled paragraph back into the new live text.
		const entry =
			previous && text.startsWith(previous.lastText)
				? previous
				: { memo: [], lastText: "", settledLength: 0, settledBlocks: [], settledUnits: 0 };
		const settledLength = entry.settledLength;
		const liveUnits = parseMarkdownUnits(text.slice(settledLength), math, {
			continuation: settledLength > 0,
			reuse: (raw, isFirst) =>
				entry.memo.find(
					(unit) =>
						unit.isFirst === isFirst && entry.lastText.slice(unit.rawStart, unit.rawEnd) === raw,
				)?.blocks,
		});
		const blocks = [...entry.settledBlocks];
		for (const unit of liveUnits) {
			for (const block of unit.blocks) blocks.push(block);
		}

		// Replace the old entry, rather than adding a new raw key on every frame.
		// The previous object is not mutated: its accounting is removed exactly once.
		this.clear(key);
		const retainedUnits = entry.settledUnits + liveUnits.length;
		if (retainedUnits > this.maxUnits) return blocks;

		const settleCount = Math.max(0, liveUnits.length - LIVE_TAIL_TOKENS);
		const boundary = liveUnits[settleCount - 1]?.consumedLength ?? 0;
		const settledBlockCount =
			entry.settledBlocks.length +
			liveUnits.slice(0, settleCount).reduce((sum, unit) => sum + unit.blocks.length, 0);
		const memo = liveUnits.slice(settleCount).map(({ raw, isFirst, blocks, consumedLength }) => ({
			rawStart: settledLength + consumedLength - raw.length,
			rawEnd: settledLength + consumedLength,
			isFirst,
			blocks,
		}));
		// The only retained source is lastText. Tail memo and settled boundary refer
		// to offsets in it, so source accounting includes all whitespace exactly once.
		const sourceChars = text.length;

		// LRU across rows. A single oversized row never evicts another pane/row.
		while (
			this.entries.size >= this.maxEntries ||
			this.sourceChars + sourceChars > this.maxSourceChars ||
			this.units + retainedUnits > this.maxUnits
		) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.clear(oldest);
		}
		this.entries.set(key, {
			memo,
			lastText: text,
			settledLength: settledLength + boundary,
			settledBlocks: blocks.slice(0, settledBlockCount),
			settledUnits: entry.settledUnits + settleCount,
			sourceChars,
			build: this.build,
		});
		this.sourceChars += sourceChars;
		this.units += retainedUnits;
		return blocks;
	}

	clear(key?: string): void {
		if (key === undefined) {
			this.entries.clear();
			this.sourceChars = 0;
			this.units = 0;
			return;
		}
		const entry = this.entries.get(key);
		if (!entry) return;
		this.entries.delete(key);
		this.sourceChars -= entry.sourceChars;
		this.units -= entry.settledUnits + entry.memo.length;
	}

	/** Start one full data build. Width-only resize must NOT bracket reads with this. */
	beginBuild(): void {
		this.build++;
		this.building = true;
	}

	/** Drop rows not read during this build, without retaining a separate key set. */
	endBuild(): void {
		if (!this.building) return;
		for (const [key, entry] of this.entries) {
			if (entry.build !== this.build) this.clear(key);
		}
		this.building = false;
	}

	get size(): number {
		return this.entries.size;
	}

	getStats(): StreamingBlockCacheStats {
		let memoUnits = 0;
		let memoSourceChars = 0;
		for (const entry of this.entries.values()) {
			memoUnits += entry.memo.length;
			for (const unit of entry.memo) memoSourceChars += unit.rawEnd - unit.rawStart;
		}
		return {
			entries: this.size,
			memoUnits,
			settledUnits: this.units - memoUnits,
			retainedUnits: this.units,
			memoSourceChars,
			retainedSourceChars: this.sourceChars,
			maxEntries: this.maxEntries,
			maxSourceChars: this.maxSourceChars,
			maxUnits: this.maxUnits,
		};
	}
}

// Compatibility for standalone callers. Production panes should own an instance.
const defaultCache = new StreamingBlockCache();

export function getStreamingPreparedBlocks(key: string, text: string): PreparedBlock[] {
	return defaultCache.get(key, text);
}

export function resetStreamingBlockCache(key?: string): void {
	defaultCache.clear(key);
}

export function streamingBlockCacheSize(): number {
	return defaultCache.size;
}
