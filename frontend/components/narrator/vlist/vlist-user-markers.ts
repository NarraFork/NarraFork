/**
 * vlist-user-markers.ts — pure geometry for the user-message quick index that
 * sits beside the exact list's scrollbar.
 *
 * The chunked path derives marker positions from a SEQUENCE ordinal
 * (`seq / totalSeqCount`), because it has no authoritative pixel geometry for
 * unmounted chunks — a long tool run and a one-line reply occupy the same share
 * of that scale, so the markers drift away from the content they point at.
 *
 * The exact list has the real thing: every row's absolute `top` is already known
 * for the current LOD/width (that is the whole point of the pretext model), so a
 * marker can be placed at the row's true document fraction and a click can jump
 * straight to its offset without resolving a seq, expanding a manifest window or
 * waiting for the row to mount.
 *
 * Pure (no React, no DOM) so the placement/jump arithmetic is unit-testable and
 * stays out of the shell.
 */

/** Minimal shape of a rendered item — only what marker collection reads. */
export interface VListUserMarkerItem {
	spec: { kind: string; key: string; data: unknown };
}

/** Minimal shape of a laid-out row — only its document offset. */
export interface VListUserMarkerGeometry {
	top: number;
}

export interface VListUserMarker {
	/** React key — the row's spec key (stable and unique per document). */
	key: string;
	/** Index into the exact layout item array. */
	itemIndex: number;
	/** Document offset (px) of the row's top edge — the jump target. */
	top: number;
	/** Position along the track, 0..1. */
	fraction: number;
	/** 1-based ordinal of this user message within the loaded document. */
	ordinal: number;
	/** Single-line preview for the tooltip / aria-label ("" when text-less). */
	preview: string;
	/** Message timestamp shown in the tooltip (null when the row carries none). */
	createdAt: string | null;
}

/** Tooltip preview budget — long enough to recognize a turn, short enough to read. */
const PREVIEW_MAX_CHARS = 80;

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value <= 0) return 0;
	return value >= 1 ? 1 : value;
}

/**
 * Collapse a user message into one tooltip line.
 *
 * Slash-command bubbles show the COMMAND rather than its expanded prompt: that is
 * what the bubble itself displays when folded, so the marker matches what the
 * reader will see when they land on it.
 */
export function resolveVListUserMarkerPreview(data: unknown): string {
	if (!data || typeof data !== "object") return "";
	const record = data as { commandText?: unknown; text?: unknown };
	const source =
		typeof record.commandText === "string" && record.commandText.length > 0
			? record.commandText
			: typeof record.text === "string"
				? record.text
				: "";
	const flat = source.replace(/\s+/g, " ").trim();
	if (flat.length <= PREVIEW_MAX_CHARS) return flat;
	return `${flat.slice(0, PREVIEW_MAX_CHARS).trimEnd()}…`;
}

/**
 * True for a HUMAN-authored chat bubble.
 *
 * `role === "user"` on the raw message is deliberately NOT the test used here.
 * Several row kinds are persisted as role=user for protocol reasons and are not
 * chat turns at all: `/bash` notices, tool load/unload notices (routed to system
 * cards) and auto-continuation / review kickoff sends (routed to the low-contrast
 * origin notice). The chunked path marks all of them, which is why its index
 * gains markers the reader never wrote. Keying on the adapted `message-bubble`
 * kind keeps the index to real user turns.
 */
function isUserBubble(item: VListUserMarkerItem | undefined): boolean {
	if (!item || item.spec.kind !== "message-bubble") return false;
	const data = item.spec.data as { role?: unknown } | null;
	return !!data && typeof data === "object" && data.role === "user";
}

/** Timestamp carried on the bubble spec (height-neutral adapter field). */
function resolveVListUserMarkerCreatedAt(data: unknown): string | null {
	if (!data || typeof data !== "object") return null;
	const createdAt = (data as { createdAt?: unknown }).createdAt;
	return typeof createdAt === "string" && createdAt.length > 0 ? createdAt : null;
}

/**
 * Collect one marker per user bubble in the loaded document.
 *
 * `items` and `layoutItems` are index-aligned (the shell only renders once
 * `hasRenderableExactLayout` confirms it); a row without geometry is skipped
 * rather than guessed.
 *
 * `documentHeight` is the full scrollable height — the canvas total PLUS any tail
 * footer — so the fractions span the same range the scrollbar does.
 */
export function collectVListUserMarkers(
	items: readonly (VListUserMarkerItem | undefined)[],
	layoutItems: readonly (VListUserMarkerGeometry | undefined)[],
	documentHeight: number,
): VListUserMarker[] {
	return projectVListUserMarkers(
		collectVListUserMarkerSemantics(items),
		layoutItems,
		documentHeight,
	);
}

export type VListUserMarkerSemantic = Omit<VListUserMarker, "top" | "fraction" | "ordinal">;

/** Read bodies only on semantic commits, never on a width/geometry frame. */
export function collectVListUserMarkerSemantics(
	items: readonly (VListUserMarkerItem | undefined)[],
): VListUserMarkerSemantic[] {
	const markers: VListUserMarkerSemantic[] = [];
	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		const item = items[itemIndex];
		if (!isUserBubble(item) || !item) continue;
		markers.push({
			key: item.spec.key,
			itemIndex,
			preview: resolveVListUserMarkerPreview(item.spec.data),
			createdAt: resolveVListUserMarkerCreatedAt(item.spec.data),
		});
	}
	return markers;
}

function projectMarkerGeometry<T extends { itemIndex: number }>(
	semantics: readonly T[],
	layoutItems: readonly (VListUserMarkerGeometry | undefined)[],
	documentHeight: number,
): (T & { top: number; fraction: number })[] {
	const markers: (T & { top: number; fraction: number })[] = [];
	const usable = Number.isFinite(documentHeight) && documentHeight > 0 ? documentHeight : 0;
	for (const semantic of semantics) {
		const geometry = layoutItems[semantic.itemIndex];
		if (!geometry || !Number.isFinite(geometry.top)) continue;
		const top = Math.max(0, geometry.top);
		markers.push({ ...semantic, top, fraction: usable > 0 ? clamp01(top / usable) : 0 });
	}
	return markers;
}

export function projectVListUserMarkers(
	semantics: readonly VListUserMarkerSemantic[],
	layoutItems: readonly (VListUserMarkerGeometry | undefined)[],
	documentHeight: number,
): VListUserMarker[] {
	return projectMarkerGeometry(semantics, layoutItems, documentHeight).map((marker, index) => ({
		...marker,
		ordinal: index + 1,
	}));
}

/**
 * Marker offset (px) within the track.
 *
 * The travel is `trackHeight - markerHeight`, not the full track: at fraction 1 a
 * percentage-positioned marker would hang half outside the viewport (the chunked
 * path's `top: 100%`), which is exactly where the newest turn sits.
 */
export function resolveVListUserMarkerTop(
	fraction: number,
	trackHeight: number,
	markerHeight: number,
): number {
	const travel = Math.max(0, (Number.isFinite(trackHeight) ? trackHeight : 0) - markerHeight);
	return Math.round(clamp01(fraction) * travel);
}

/**
 * Scroll offset for a marker click.
 *
 * Top-aligned with a small lead rather than centered: a user message OPENS a turn,
 * so the useful screen after the jump is the message plus the response below it.
 * Centering would spend half the viewport on the previous turn's output.
 */
export function resolveVListUserMarkerScrollTop(top: number, lead: number): number {
	if (!Number.isFinite(top)) return 0;
	return Math.max(0, top - Math.max(0, Number.isFinite(lead) ? lead : 0));
}

/**
 * Show the index only when it can do something: at least one marked turn and a
 * document actually taller than the viewport.
 */
export function shouldShowVListUserMarkers(
	markerCount: number,
	documentHeight: number,
	trackHeight: number,
): boolean {
	if (markerCount <= 0) return false;
	if (!Number.isFinite(documentHeight) || !Number.isFinite(trackHeight)) return false;
	if (trackHeight <= 0) return false;
	return documentHeight > trackHeight;
}

// ── Compact markers ─────────────────────────────────────────────────────────

/** Which compact flavour a scrollbar mark belongs to (drives its colour). */
export type VListCompactMarkerFlavor = "context" | "segment";

/** Lifecycle status a scrollbar mark renders (drives colour + pulse). */
export type VListCompactMarkerStatus = "compacting" | "compacted" | "failed";

export interface VListCompactMarker {
	/** React key — the row's spec key (stable and unique per document). */
	key: string;
	/** Index into the exact layout item array. */
	itemIndex: number;
	/** Document offset (px) of the row's top edge — the jump target. */
	top: number;
	/** Position along the track, 0..1. */
	fraction: number;
	flavor: VListCompactMarkerFlavor;
	status: VListCompactMarkerStatus;
	/**
	 * Single-line tooltip text. For live markers this is the adapter's ALREADY
	 * LOCALIZED indicator line (e.g. "Compacting context… · retry #2"), so the
	 * tooltip never drifts from what the row itself says; for the failed segment
	 * card it is the card's title, not the (arbitrarily long) error body.
	 */
	tooltip: string;
}

interface CompactMarkerCandidate {
	flavor: VListCompactMarkerFlavor;
	status: VListCompactMarkerStatus;
	tooltip: string;
}

/**
 * Resolve a rendered row into a compact marker candidate, or null when the row
 * is not a compact marker at all.
 *
 * Two row shapes carry compact state:
 *   - `system-simple` with `data.kind === "compact" | "segment_compact"` — the
 *     one-line indicator (all three statuses).
 *   - `system-text` with `data.kind === "segment_compact_failed"` — the failed
 *     segment compact, which routes to a full error card instead of the line.
 *
 * Reading the ADAPTED `spec.data` (not the raw message block) keeps this
 * collector in parity with whatever the row displays: the indicator's `text`
 * is composed from status by the adapter, so a row saying "retry #2" yields a
 * tooltip saying the same.
 */
function resolveCompactMarkerCandidate(
	item: VListUserMarkerItem | undefined,
): CompactMarkerCandidate | null {
	if (!item) return null;
	const data = item.spec.data as
		| { kind?: unknown; status?: unknown; text?: unknown; title?: unknown }
		| null
		| undefined;
	if (!data || typeof data !== "object") return null;
	if (item.spec.kind === "system-simple") {
		const flavor: VListCompactMarkerFlavor | null =
			data.kind === "compact" ? "context" : data.kind === "segment_compact" ? "segment" : null;
		if (!flavor) return null;
		const status: VListCompactMarkerStatus =
			data.status === "compacting" || data.status === "failed" ? data.status : "compacted";
		return {
			flavor,
			status,
			tooltip: typeof data.text === "string" ? data.text : "",
		};
	}
	if (item.spec.kind === "system-text" && data.kind === "segment_compact_failed") {
		return {
			flavor: "segment",
			status: "failed",
			tooltip:
				typeof data.title === "string" && data.title
					? data.title
					: typeof data.text === "string"
						? data.text
						: "",
		};
	}
	return null;
}

/**
 * Collect one marker per compact indicator in the loaded document. Same
 * geometry contract as {@link collectVListUserMarkers}: `items` and
 * `layoutItems` are index-aligned, rows without geometry are skipped, and
 * fractions are taken against the full scrollable height.
 */
export function collectVListCompactMarkers(
	items: readonly (VListUserMarkerItem | undefined)[],
	layoutItems: readonly (VListUserMarkerGeometry | undefined)[],
	documentHeight: number,
): VListCompactMarker[] {
	return projectVListCompactMarkers(
		collectVListCompactMarkerSemantics(items),
		layoutItems,
		documentHeight,
	);
}

export type VListCompactMarkerSemantic = Omit<VListCompactMarker, "top" | "fraction">;

export function collectVListCompactMarkerSemantics(
	items: readonly (VListUserMarkerItem | undefined)[],
): VListCompactMarkerSemantic[] {
	const markers: VListCompactMarkerSemantic[] = [];
	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		const candidate = resolveCompactMarkerCandidate(items[itemIndex]);
		if (!candidate) continue;
		markers.push({
			key: items[itemIndex]?.spec.key ?? `compact-${itemIndex}`,
			itemIndex,
			...candidate,
		});
	}
	return markers;
}

export function projectVListCompactMarkers(
	semantics: readonly VListCompactMarkerSemantic[],
	layoutItems: readonly (VListUserMarkerGeometry | undefined)[],
	documentHeight: number,
): VListCompactMarker[] {
	return projectMarkerGeometry(semantics, layoutItems, documentHeight);
}
