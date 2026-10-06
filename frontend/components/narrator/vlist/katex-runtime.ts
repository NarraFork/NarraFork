/**
 * katex-runtime.ts — Lazy KaTeX loading + canvas-backed glyph measurement.
 *
 * KaTeX's main bundle is ~584KB of JS plus ~1.2MB of webfonts, so it must never
 * reach the first-paint path. But the prepared/measure layers are SYNCHRONOUS
 * (`parseMarkdownToPreparedBlocks` has no await), which leaves exactly one place
 * to absorb the load: the document coordinator's already-async `load()` /
 * `loadOlder()`. This module is that seam.
 *
 * Contract for callers:
 *   1. `await ensureKatexLoaded(text)` on the async path, BEFORE building layout.
 *      It resolves immediately when the text has no math.
 *   2. Once loaded, `getKatexRuntime()` returns a handle synchronously, so the
 *      pure measure path stays synchronous.
 *   3. `getKatexRevision()` changes when the runtime becomes available, so a
 *      layout built before the load can be invalidated (the measure cache keys
 *      on the layout revision).
 *
 * Glyph measurement uses the same OffscreenCanvas technique pretext uses, for
 * the same reason: KaTeX has no font metrics for CJK and silently substitutes
 * capital "M" (118% error on `\text{速度}`). Anything KaTeX cannot measure is
 * routed here instead.
 */

import type {
	GlyphVerticalResolver,
	GlyphWidthResolver,
	KatexRuntime,
} from "@shared/pretext-layout/katex-geometry";
import { hasMarkdownMath } from "@shared/pretext-layout/math-delimiters";
import {
	getPreparedFontRevision,
	setPreparedFontRevision,
} from "@shared/pretext-layout/prepared-markdown-cache";

let runtime: KatexRuntime | null = null;
let loadPromise: Promise<KatexRuntime | null> | null = null;
let revision = 0;

/**
 * Load the KaTeX module and its stylesheet. Idempotent and cached; a failed load
 * is retryable (the promise is cleared) so a transient chunk error is not fatal.
 */
function loadKatex(): Promise<KatexRuntime | null> {
	if (runtime) return Promise.resolve(runtime);
	if (!loadPromise) {
		loadPromise = Promise.all([import("katex"), import("katex/dist/katex.min.css")])
			.then(([katexModule]) => {
				runtime = katexModule.default as unknown as KatexRuntime;
				// Bump so layouts built before the runtime arrived are invalidated.
				revision++;
				// Kick off webfont loading in the background (non-blocking).
				scheduleWebfontWatch();
				return runtime;
			})
			.catch(() => {
				loadPromise = null;
				return null;
			});
	}
	return loadPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Webfont readiness — invalidate glyph cache once KaTeX fonts finish loading.
//
// CJK `\text{...}` formulas are measured via canvas `measureText`, which uses
// whatever font is available at call time. Before KaTeX webfonts load, the
// browser substitutes serif/sans-serif fallbacks, producing wrong advances.
// Once fonts are ready, we clear the glyph cache and bump the revision so the
// coordinator rebuilds layouts with correct measurements.
// ─────────────────────────────────────────────────────────────────────────────

/** Font families that affect CJK text measurement. Others (Size, Script, etc.)
 * only carry symbols KaTeX already has exact em metrics for. */
const KATEX_FONT_FAMILIES = ["KaTeX_Main", "KaTeX_Math", "KaTeX_AMS"];

/** Maximum time (ms) to wait for webfonts before giving up. Fonts arriving
 * after this still trigger a cache flush via the ongoing `document.fonts.ready`
 * promise, but the timeout prevents stalling on unreachable network fonts. */
const WEBFONT_TIMEOUT_MS = 8000;

let webfontWatchScheduled = false;

function scheduleWebfontWatch(): void {
	// Only run in browser environments with the Font Loading API.
	if (webfontWatchScheduled) return;
	if (typeof document === "undefined") return;
	const fonts = (document as { fonts?: FontFaceSet }).fonts;
	if (!fonts || typeof fonts.load !== "function") return;
	webfontWatchScheduled = true;

	const loadPromises = KATEX_FONT_FAMILIES.map((family) =>
		fonts.load(`1em ${family}`).catch(() => undefined),
	);

	const timeout = new Promise<void>((resolve) => setTimeout(resolve, WEBFONT_TIMEOUT_MS));
	Promise.race([Promise.all(loadPromises), timeout]).then(() => {
		onWebfontsReady();
	});
}

interface FontFaceSet {
	load: (font: string, text?: string) => Promise<unknown[]>;
	ready: Promise<FontFaceSet>;
}

function onWebfontsReady(): void {
	// Only act if there are stale entries that were measured with fallback fonts.
	// Vertical metrics are just as font-dependent as advances, so both caches go.
	if (glyphCache.size > 0 || verticalCache.size > 0) {
		glyphCache.clear();
		verticalCache.clear();
		revision++;
	}
}

/**
 * Ensure KaTeX is loaded when (and only when) the given text contains math.
 *
 * Call this from an async boundary before building a layout. Texts without math
 * resolve synchronously-ish with zero cost, so the common case pays nothing.
 */
export async function ensureKatexLoaded(texts: string | readonly string[]): Promise<void> {
	if (runtime) return;
	const list = typeof texts === "string" ? [texts] : texts;
	let needed = false;
	for (const text of list) {
		if (text.length > 0 && hasMarkdownMath(text)) {
			needed = true;
			break;
		}
	}
	if (!needed) return;
	await loadKatex();
}

/** Synchronous handle for the pure measure path; null until loaded. */
export function getKatexRuntime(): KatexRuntime | null {
	return runtime;
}

/** True when formulas can be measured/rendered synchronously. */
export function isKatexReady(): boolean {
	return runtime !== null;
}

/**
 * Revision counter that changes when KaTeX becomes available. Folded into the
 * layout revision so cached heights measured without the runtime get rebuilt.
 */
export function getKatexRevision(): number {
	return revision;
}

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT font readiness — the same hazard, one level up from KaTeX.
//
// `onWebfontsReady` above covers KaTeX's own faces. But the prepared layer bakes
// a pixel width into EVERY fragment of EVERY body (see prepared-markdown-cache's
// FONT REVISION note), math or not, and those widths come from canvas
// `measureText` against whatever face was resolvable at that moment. A body
// prepared under a fallback face therefore keeps its old wrap points while the
// DOM repaints with the real one — measurement and render diverge, which is the
// failure the exact list exists to prevent.
//
// This app currently ships no webfonts (system stacks only, verified: no
// `@font-face` and no font `<link>` in frontend/), so the generation below is
// expected to stay 0 in production. It is plumbed anyway because the assumption
// is one stylesheet away from being wrong and the failure mode is silent.
// ─────────────────────────────────────────────────────────────────────────────

let documentFontWatchScheduled = false;
/** Notified when the font generation advances, so the layout can be rebuilt. */
const fontRevisionListeners = new Set<() => void>();

/**
 * Subscribe to font-generation changes.
 *
 * Clearing the prepared cache is not enough on its own: heights derived from it
 * live in `measureCache` and the layout that placed them is already committed, so
 * the listener must clear that cache and rebuild. Returns an unsubscribe.
 */
export function onFontRevisionChange(listener: () => void): () => void {
	fontRevisionListeners.add(listener);
	ensureDocumentFontWatch();
	return () => fontRevisionListeners.delete(listener);
}

/** Current font generation (shared with the prepared cache's key). */
export function getFontRevision(): number {
	return getPreparedFontRevision();
}

/**
 * Watch `document.fonts.ready` once and advance the generation when it settles.
 *
 * Idempotent, and a no-op without the Font Loading API (Bun tests, older
 * engines) — an engine that cannot report readiness also cannot swap a face
 * underneath us mid-session in a way we could detect, so staying at generation 0
 * is the correct degradation.
 */
function ensureDocumentFontWatch(): void {
	if (documentFontWatchScheduled) return;
	if (typeof document === "undefined") return;
	const fonts = (document as { fonts?: FontFaceSet }).fonts;
	if (!fonts?.ready || typeof fonts.ready.then !== "function") return;
	documentFontWatchScheduled = true;
	fonts.ready.then(
		() => {
			bumpFontRevision();
		},
		() => {
			// A rejected readiness promise leaves us on the current generation, which
			// is the same state as an engine without the API.
		},
	);
}

/** Advance the font generation and notify subscribers when it actually moves. */
function bumpFontRevision(): void {
	if (!setPreparedFontRevision(getPreparedFontRevision() + 1)) return;
	for (const listener of fontRevisionListeners) listener();
}

/** Test seam: drive the font generation without a real FontFaceSet. */
export function bumpFontRevisionForTest(): void {
	bumpFontRevision();
}

/** Test seam: reset module state so each test starts from a known baseline. */
export function resetKatexRuntimeForTest(): void {
	runtime = null;
	loadPromise = null;
	revision = 0;
	glyphCache.clear();
	verticalCache.clear();
	measureCtx = undefined;
	webfontWatchScheduled = false;
	documentFontWatchScheduled = false;
	fontRevisionListeners.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Canvas-backed glyph measurement (the pretext technique)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capacity for the glyph width cache. Keyed by `glyph|fontCss`, the working
 * set is bounded by (unique CJK glyphs × font variants). 32768 is generous for
 * even the most math-heavy CJK sessions while preventing unbounded growth in a
 * long-lived SPA tab. Overflow triggers a bulk clear; advances are deterministic
 * so recalculation cost is negligible (one canvas measureText per glyph).
 */
export const GLYPH_CACHE_CEILING = 32768;

/** `glyph|fontCss` → advance px. */
const glyphCache = new Map<string, number>();

/** Test seam: expose cache size for assertions. */
export function getGlyphCacheSize(): number {
	return glyphCache.size;
}

/** `undefined` = not yet attempted, `null` = unavailable in this environment. */
let measureCtx:
	| { font: string; measureText: (text: string) => { width: number } }
	| null
	| undefined;

function getMeasureContext() {
	if (measureCtx !== undefined) return measureCtx;
	measureCtx = null;
	try {
		const Offscreen = (
			globalThis as unknown as {
				OffscreenCanvas?: new (w: number, h: number) => { getContext: (id: string) => unknown };
			}
		).OffscreenCanvas;
		if (Offscreen) {
			const ctx = new Offscreen(1, 1).getContext("2d");
			if (ctx) measureCtx = ctx as NonNullable<typeof measureCtx>;
		} else if (typeof document !== "undefined") {
			const ctx = document.createElement("canvas").getContext("2d");
			if (ctx) measureCtx = ctx as NonNullable<typeof measureCtx>;
		}
	} catch {
		measureCtx = null;
	}
	return measureCtx;
}

/**
 * Vertical extent of a glyph with a real font, via canvas `TextMetrics`'s
 * `fontBoundingBox*` (falling back to `actualBoundingBox*`).
 *
 * KaTeX substitutes capital "M" for CJK, and M has NO descender, so a `\text{…}`
 * CJK run reports `depth: 0` and an ink box too short — the width-pinned,
 * `overflow: hidden` math host then shaves the glyph's top and bottom. Real metrics
 * come from here instead. Returns null when unavailable so geometry degrades to
 * KaTeX's own numbers rather than guessing.
 */
export const measureGlyphVertical: GlyphVerticalResolver = (glyph, fontCss) => {
	const key = `${glyph}|${fontCss}`;
	const cached = verticalCache.get(key);
	if (cached !== undefined) return cached;
	const ctx = getMeasureContext();
	if (!ctx) return null;
	try {
		ctx.font = fontCss;
		const metrics = ctx.measureText(glyph) as {
			fontBoundingBoxAscent?: number;
			fontBoundingBoxDescent?: number;
			actualBoundingBoxAscent?: number;
			actualBoundingBoxDescent?: number;
		};
		// `fontBoundingBox*` describes the FONT's em box (stable across glyphs, which is
		// what a line box should reserve); `actualBoundingBox*` is per-glyph ink and is
		// the fallback where the former is unsupported (older Safari).
		const ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent;
		const descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent;
		if (!Number.isFinite(ascent) || !Number.isFinite(descent)) return null;
		const value = { ascent: ascent as number, descent: descent as number };
		if (verticalCache.size >= GLYPH_CACHE_CEILING) {
			verticalCache.clear();
		}
		verticalCache.set(key, value);
		return value;
	} catch {
		return null;
	}
};

/** `glyph|fontCss` → real vertical extent (px). Same bounding policy as glyphCache. */
const verticalCache = new Map<string, { ascent: number; descent: number }>();

/**
 * Measure a glyph with a real font. Returns null when no canvas is available,
 * letting the geometry engine fall back to KaTeX's own (approximate) metric.
 */
export const measureGlyphWidth: GlyphWidthResolver = (glyph, fontCss) => {
	const key = `${glyph}|${fontCss}`;
	const cached = glyphCache.get(key);
	if (cached !== undefined) return cached;
	const ctx = getMeasureContext();
	if (!ctx) return null;
	try {
		ctx.font = fontCss;
		const width = ctx.measureText(glyph).width;
		if (!Number.isFinite(width)) return null;
		// Bulk-clear at the ceiling. The `has(key)` guard this used to carry could never
		// be true here (a cache hit already returned above), and it made the full cache
		// clear on every new glyph — leaving one entry behind and re-clearing on the next,
		// so nothing stayed cached. See the same note in katex-geometry.ts.
		if (glyphCache.size >= GLYPH_CACHE_CEILING) {
			glyphCache.clear();
		}
		glyphCache.set(key, width);
		return width;
	} catch {
		return null;
	}
};
