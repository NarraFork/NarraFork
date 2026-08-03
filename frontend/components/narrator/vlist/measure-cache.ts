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
	// Effective timeout — the ONE height-neutral passthrough that needs keying.
	//
	// Height-neutral fields normally may be omitted (the `/ 2m` suffix rides the
	// card's fixed header row), but the cache stores the whole MeasuredElement,
	// including the values the renderer merely PAINTS. Every other passthrough
	// arrives alongside a field that already moves the key — durationMs and the
	// lifecycle stamps come with `tool_completed`'s status change. `timeout_updated`
	// is the exception: it writes the deadline and nothing else, so without this the
	// rebuild serves the pre-update measured payload and the header keeps showing
	// the OLD timeout even though the server already applied the new one.
	if (typeof d.timeoutMs === "number") rev += `|to:${d.timeoutMs}`;
	// Truncated-payload state. Height-AFFECTING (a non-zero count reserves the
	// truncation notice row) and, more importantly, the ONLY key component that
	// moves when a fetched payload lands: `status` is already terminal, and the
	// detail body's own signature can legitimately stay put because a capped box
	// only ever measures a bounded PREFIX — an 8KB preview and the 40KB full text
	// slice to the same measured prefix. Without this the rebuild after the fetch
	// hit the pre-fetch entry, so the card kept `truncatedLeafCount > 0`, the row
	// stayed in the shell's in-flight set, and the notice read "loading full
	// data…" forever. The nested (drilled-in trace row) path already keys it via
	// `|tdn:` — this is the same contract for a standalone card.
	if (typeof d.truncatedLeafCount === "number") rev += `|tp:${d.truncatedLeafCount}`;
	rev += detailTextRevision(d.detail);
	rev += reflectionRevision(d.reflection);
	rev += subagentRevision(d);
	rev += traceRevision(d);
	return rev || undefined;
}

/**
 * Revision of a FOLDED TRACE payload (`activity-trace`, `tool-run-summary`,
 * `tool-run-count`, `reasoning-steps`).
 *
 * Why these need their own revision
 * ---------------------------------
 * A trace's spec.key is minted from its FIRST member — `activity-<firstMsgId>-<i>`
 * for the cross-segment activity fold, `toolrun-summary-tool-<firstToolUseId>` /
 * `toolrun-count-tool-<...>` for a folded batch — while its height is
 * `header + rows(N) + …`, i.e. driven by the members that come AFTER the first.
 * So a fold that GROWS keeps its key, and none of the other key components move
 * either: the append/live-patch paths deliberately hold `messageVersion` fixed
 * (CONTRACT.md §4.5) and the trace's `opts` only carry fold/expand state.
 *
 * That made every low-LOD fold (L1-L3, where the folds exist at all) serve the
 * height AND the measured row list captured when it had one member. The visible
 * symptom: an activity trace stuck on "0 tools · 1 reasoning" with the tool rows
 * clipped away, which only "fixed itself" after an alt+wheel LOD change re-keyed
 * it by `lod` — and came back on return because the stale entry for the original
 * LOD was still cached.
 *
 * Cost is O(rows): a row's title is short (`truncateTitle` caps at 80 chars) and
 * expandable bodies contribute a bounded `textSignature`. Gated on `items`/`steps`
 * being an array so no other kind pays for the walk.
 */
function traceRevision(d: Record<string, unknown>): string {
	const rows = Array.isArray(d.items) ? d.items : Array.isArray(d.steps) ? d.steps : null;
	// `tool-run-count` has no row array at all — only the count and header text.
	if (!rows) return typeof d.count === "number" ? `|tn:${d.count}` : "";
	let rev = `|tc:${rows.length}`;
	// The composed header count ("N reasoning · M tools", "N calls") is what the
	// renderer PAINTS from the cached payload, so it must be keyed even though the
	// header row's height is fixed — this is the "0 tools" text that stayed stale.
	if (typeof d.headerCount === "string") rev += `|th:${d.headerCount}`;
	for (const row of rows) {
		if (row == null || typeof row !== "object") continue;
		const r = row as Record<string, unknown>;
		// Row identity + painted content. Titles are already length-capped upstream.
		if (typeof r.key === "string") rev += `|tk:${r.key}`;
		if (typeof r.title === "string") rev += `|tt:${textSignature(r.title)}`;
		if (typeof r.status === "string") rev += `|ts:${r.status}`;
		// The row's duration is height-neutral but PAINTED from the cached payload, so
		// it needs the same treatment `timeoutMs` gets above. `status` normally moves
		// with it (running → success arrives together with `durationMs`); this keys the
		// value directly so a duration-only correction cannot serve a stale row.
		if (r.timing != null && typeof r.timing === "object") {
			const duration = (r.timing as Record<string, unknown>).durationMs;
			if (typeof duration === "number") rev += `|tm:${duration}`;
		}
		// An expandable body is measured as markdown when its row is expanded.
		const body = typeof r.bodyText === "string" ? r.bodyText : r.body;
		if (typeof body === "string") rev += `|tb:${textSignature(body)}`;
		if (r.shimmer === true) rev += "|tw:1";
		// A DRILLED-IN row nests a whole tool card, so the trace's height now depends
		// on that card's own height-bearing fields. `opts.expandedIndices` only tells
		// us WHICH rows are open, not what is inside them — so the one transition it
		// cannot express is the interesting one: loading the full payload replaces the
		// truncated body (which reserved the whole cap) with the exact text, shrinking
		// the card, while spec.key, messageVersion and opts all stay put. Without this
		// the trace would serve the reserved-cap height around exact content.
		//
		// Only expanded rows carry a `card` (the adapter builds nothing for a folded
		// row), so a collapsed fold pays one null check per row.
		if (r.card != null && typeof r.card === "object") {
			const card = r.card as Record<string, unknown>;
			if (typeof card.status === "string") rev += `|tds:${card.status}`;
			if (typeof card.truncatedLeafCount === "number") rev += `|tdn:${card.truncatedLeafCount}`;
			rev += detailTextRevision(card.detail);
			rev += reflectionRevision(card.reflection);
		}
	}
	return rev;
}

/**
 * Revision of a SubagentCard payload.
 *
 * A subagent card is the one element the LIVE PATCH channel can grow without any
 * of the other key components moving: `spec.key` stays `tool-<toolUseId>`,
 * `applyLivePatch` deliberately keeps `messageVersion` fixed, and the activity /
 * conclusion patches never touch `opts`. Two concrete regressions this closes:
 *
 * - `patchSubagentActivity` writes only `_subagentActivity`, which the adapter
 *   turns into `recentCallCount`. The recent-calls block is pure arithmetic on
 *   that count (measure-subagent's `recentRowCount`), so a card that was measured
 *   with zero calls served a height with the whole block missing — the rows were
 *   then clipped away entirely because the renderer draws `recentCallsHeight`.
 * - `subagentConclusionPatch` writes `outputJson`, which the adapter turns into
 *   `resultText` / `resultPreview`. On a card that is ALREADY `success` with no
 *   error the status does not move, so nothing else in the key changes while the
 *   result preview line (collapsed) or the capped result body (expanded) appears.
 *
 * Gated on `agentType` — required on SubagentCardData and absent from every other
 * element's data — so no other kind pays for the walk.
 *
 * Cost is O(1): primitives plus bounded `textSignature`s (length + 512 sampled
 * chars regardless of body size, see below), and the adapter caps the recent-call
 * names at three short strings. No stringification of the payload.
 */
function subagentRevision(d: Record<string, unknown>): string {
	if (typeof d.agentType !== "string") return "";
	let rev = `|ga:${d.agentType}`;
	// Recent calls: the ROW COUNT is what drives the block height (capped at 3).
	if (typeof d.recentCallCount === "number") rev += `|gn:${d.recentCallCount}`;
	if (Array.isArray(d.recentCallNames)) {
		rev += `|gk:${d.recentCallNames.length}`;
		for (const name of d.recentCallNames) {
			if (typeof name === "string") rev += `|gm:${name}`;
		}
	}
	// Row label detail + category chip. Height-neutral, but PAINTED from the cached
	// payload (the measure layer slices both to the drawn rows), so they need the
	// same treatment `timeoutMs` gets. They are also the ONLY delta in a real case:
	// a live `tool_use_chunk` fills in a call's `inputSummary` while the row count,
	// names and status all stay put — without this the row keeps its bare tool name
	// until the next full rebuild. Bounded: at most 3 short strings each.
	if (Array.isArray(d.recentCallSummaries)) {
		for (const summary of d.recentCallSummaries) {
			if (typeof summary === "string") rev += `|gs:${textSignature(summary)}`;
		}
	}
	if (Array.isArray(d.recentCallCategories)) {
		for (const category of d.recentCallCategories) {
			if (typeof category === "string") rev += `|gc:${category}`;
		}
	}
	if (d.hasRecentCallsButton === true) rev += "|gb:1";
	// Badge labels ride the card's fixed badge row today, so they are height-neutral
	// — keyed anyway because the identity patch writes them ALONE (nothing else in
	// the key would move), which makes them free insurance if that row ever wraps.
	if (typeof d.model === "string") rev += `|go:${d.model}`;
	if (typeof d.reasoningEffort === "string") rev += `|ge:${d.reasoningEffort}`;
	if (d.isBackground === true) rev += "|gg:1";
	// Measured bodies: the description wraps when expanded, the prompt and result
	// are measured up to their caps.
	if (typeof d.description === "string") rev += `|gd:${textSignature(d.description)}`;
	if (typeof d.prompt === "string") rev += `|gp:${textSignature(d.prompt)}`;
	if (d.promptOpen === true) rev += "|gq:1";
	// A truncated prompt reserves the full cap, so its height differs from an
	// identical-length complete one; and the flag flips to false when the fetched
	// body lands, which must re-measure the (now exact) block.
	if (d.promptTruncated === true) rev += "|gt:1";
	if (typeof d.resultText === "string") rev += `|gr:${textSignature(d.resultText)}`;
	if (typeof d.resultPreview === "string") rev += `|gv:${textSignature(d.resultPreview)}`;
	if (d.hasResolveOverride === true) rev += "|gx:1";
	// Permission blocks force expansion and add their own bodies; presence + count
	// is enough because the bodies themselves are keyed by the permission measure.
	if (d.selfPermission != null) rev += "|gf:1";
	if (Array.isArray(d.pendingPermissions)) rev += `|gz:${d.pendingPermissions.length}`;
	return rev;
}

/**
 * Revision of a measured reflection notice.
 *
 * The notice's height comes from its localized title plus the optional summary /
 * nextSteps lines, all of which change as a gate progresses (running → confirmed
 * rewrites the title and often the summary). Without this the same spec.key would
 * serve the previous status's cached height.
 *
 * `hasTakeOver` is keyed too: the takeover row is measured only when it actually
 * paints (running gates), so it is height-affecting. `status` already moves in
 * lockstep with it today, but keying the flag directly keeps the cache correct if
 * that ever stops being true.
 */
function reflectionRevision(reflection: unknown): string {
	if (reflection == null || typeof reflection !== "object") return "";
	const r = reflection as Record<string, unknown>;
	let rev = "|rf:1";
	if (typeof r.status === "string") rev += `|rs:${r.status}`;
	if (r.hasTakeOver === true) rev += "|rk:1";
	if (typeof r.title === "string") rev += `|rt:${textSignature(r.title)}`;
	if (typeof r.summary === "string") rev += `|ru:${textSignature(r.summary)}`;
	if (typeof r.nextSteps === "string") rev += `|rn:${textSignature(r.nextSteps)}`;
	return rev;
}

/**
 * Capped tool-detail bodies now MEASURE their text (wrapping decides the height),
 * so the same spec.key can legitimately resolve to a different height when the
 * body changes — a plan arriving from a pending permission, an edited plan, or a
 * truncated body replaced by its full text after the async detail fetch.
 *
 * The walk must cover the COMPOSITE shapes too. A multi-part detail keeps its
 * text inside `sections[].body.text` and its result text inside
 * `structured.entries[]`, so reading only the top-level fields would return an
 * empty revision — and a card whose body just grew from a 200-char preview to
 * the full document would hit the stale cache entry and keep the old height,
 * silently defeating the fetch. Cost stays O(sections + entries + rows) with no
 * stringification — each text contributes a bounded `textSignature` rather than
 * being hashed in full.
 */
function detailTextRevision(detail: unknown): string {
	if (detail == null || typeof detail !== "object") return "";
	const d = detail as Record<string, unknown>;
	let rev = leafTextRevision(d);
	// Multi-part detail: fold every section body (bodies never nest further).
	if (Array.isArray(d.sections)) {
		rev += `|sc:${d.sections.length}`;
		for (const part of d.sections as unknown[]) {
			if (part == null || typeof part !== "object") continue;
			const p = part as Record<string, unknown>;
			if (typeof p.label === "string") rev += `|sl:${p.label}`;
			if (p.body != null && typeof p.body === "object") {
				rev += leafTextRevision(p.body as Record<string, unknown>);
			}
		}
	}
	return rev;
}

/**
 * Content signature of a measured string: exact length plus a sampled hash.
 *
 * Length alone is NOT enough for bodies whose height comes from how the text
 * wraps. `documentRevision` (the message version) covers most in-place content
 * swaps, but not the pending-permission plan injection: that path rebuilds the
 * layout from the SAME loaded input, so the version never moves. Two same-length
 * bodies with different line structure then share a cache key — measured at
 * 104px vs 164px at one width, so one of them is simply wrong.
 *
 * Sampling is STRIDED over the whole string rather than a contiguous prefix. The
 * measure layer parses up to `DETAIL_MARKDOWN_PREFIX_MAX_CHARS` (32KB), so a
 * prefix window smaller than that would leave a blind band where an edit changes
 * the measured height without changing the key. A fixed sample count keeps the
 * cost O(1) even for megabyte bodies (~0.1ms for 2MB) while covering every
 * region the measure layer can read.
 *
 * A miss therefore requires the same length AND the same character at all
 * sampled positions — a collision this cache treats as acceptable, matching how
 * `digestOpts` trades exactness for speed on the scroll path.
 */
const REVISION_HASH_SAMPLES = 512;

function textSignature(text: string): string {
	const len = text.length;
	let hash = 0x811c9dc5;
	const mix = (code: number) => {
		hash ^= code;
		// FNV prime via shifts, kept in 32-bit unsigned range.
		hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
	};
	if (len <= REVISION_HASH_SAMPLES) {
		for (let i = 0; i < len; i++) mix(text.charCodeAt(i));
	} else {
		const stride = len / REVISION_HASH_SAMPLES;
		for (let s = 0; s < REVISION_HASH_SAMPLES; s++) {
			mix(text.charCodeAt(Math.floor(s * stride)));
		}
		// Anchor the tail: a strided walk can stop short of the final characters.
		mix(text.charCodeAt(len - 1));
	}
	return `${len}.${hash.toString(36)}`;
}

/** Content-signature revision of one NON-composite detail body. */
function leafTextRevision(d: Record<string, unknown>): string {
	let rev = "";
	if (typeof d.text === "string") rev += `|tx:${textSignature(d.text)}`;
	if (typeof d.inputText === "string") rev += `|it:${textSignature(d.inputText)}`;
	if (typeof d.outputText === "string") rev += `|ot:${textSignature(d.outputText)}`;
	// Structured results: entry count + per-entry title/snippet signatures.
	if (Array.isArray(d.entries)) {
		rev += `|en:${d.entries.length}`;
		for (const entry of d.entries as unknown[]) {
			if (entry == null || typeof entry !== "object") continue;
			const e = entry as Record<string, unknown>;
			if (typeof e.title === "string") rev += `|et:${textSignature(e.title)}`;
			if (typeof e.snippet === "string") rev += `|es:${textSignature(e.snippet)}`;
		}
	}
	// Ask replay: an AskUserQuestion card keeps its spec.key across the whole
	// lifecycle, so the answer landing (or a truncated payload being replaced by the
	// full one) must move the revision — otherwise the answered card serves the
	// unanswered card's cached height and the answer row is clipped away.
	if (Array.isArray(d.questions)) {
		rev += `|aq:${d.questions.length}`;
		for (const question of d.questions as unknown[]) {
			if (question == null || typeof question !== "object") continue;
			const q = question as Record<string, unknown>;
			if (typeof q.header === "string") rev += `|ah:${textSignature(q.header)}`;
			if (q.omitHeader === true) rev += "|ao:1";
			if (typeof q.answer === "string") rev += `|aa:${textSignature(q.answer)}`;
			if (typeof q.customAnswer === "string") rev += `|ac:${textSignature(q.customAnswer)}`;
			if (!Array.isArray(q.options)) continue;
			rev += `|an:${q.options.length}`;
			for (const option of q.options as unknown[]) {
				if (option == null || typeof option !== "object") continue;
				const o = option as Record<string, unknown>;
				if (typeof o.label === "string") rev += `|al:${textSignature(o.label)}`;
				if (typeof o.description === "string") rev += `|ad:${textSignature(o.description)}`;
				// Selection is height-neutral on its own, but it flips with the answer and
				// keeping it here makes the revision a faithful digest of the payload.
				if (o.selected === true) rev += "|as:1";
			}
		}
	}
	// Meta rows: row count + per-row text signatures.
	if (Array.isArray(d.rows)) {
		rev += `|mr:${d.rows.length}`;
		for (const row of d.rows as unknown[]) {
			if (row == null || typeof row !== "object") continue;
			const r = row as Record<string, unknown>;
			if (typeof r.text === "string") rev += `|mt:${textSignature(r.text)}`;
		}
	}
	// Body lines: count only (each line is short and the count drives the height).
	if (Array.isArray(d.bodyLines)) rev += `|bl:${d.bodyLines.length}`;
	return rev;
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
