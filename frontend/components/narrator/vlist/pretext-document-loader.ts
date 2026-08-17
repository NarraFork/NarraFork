import { narratorsApi } from "@frontend/lib/api/narrators";
import type { PretextDocumentPageResult, TreeMessage } from "@frontend/lib/api/types";

export type PretextDocumentFetchPage = (
	narratorId: string,
	opts: { afterSeq?: number; beforeSeq?: number; limit: number; messageVersion?: number },
) => Promise<PretextDocumentPageResult>;

export interface PretextDocumentLoadOptions {
	/** Number of transport pages requested at a time; never a scroll coordinate. */
	pageSize?: number;
	/**
	 * Tail (first-screen) page size. Kept separate from `pageSize` because the
	 * first screen should measure only enough messages to fill the viewport — an
	 * LOD-aware value (see {@link firstScreenPageSizeForLod}) — while older pages
	 * fetched during upward scroll use the larger `pageSize` to cut round-trips.
	 */
	firstScreenPageSize?: number;
	/** Hard safety bound for one exact-layout build. */
	maxMessages?: number;
	fetchPage?: PretextDocumentFetchPage;
	onProgress?: (loadedMessages: number) => void;
}

export interface PretextDocumentInput {
	messages: TreeMessage[];
	messageVersion: number;
	pruneBoundaryMessageId: string | null;
	prunedPercent: number | null;
	/** Smallest loaded top-level seq; the `beforeSeq` cursor for the next older page. */
	oldestLoadedSeq: number | null;
	/** More (older) top-level messages exist above the loaded window. */
	hasPrev: boolean;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_MESSAGES = 50_000;
/**
 * Sentinel `afterSeq` for "from the very start". Top-level ref seq is always >= 0
 * (allocated as `(max ?? -1) + 1`), and no cursor now means the tail page, so the
 * full forward walk must anchor before the first message with an explicit value.
 */
const FROM_START_AFTER_SEQ = -1;

function resolvePageSize(pageSize: number | undefined): number {
	return Math.min(Math.max(Math.trunc(pageSize ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
}

/**
 * LOD-aware first-screen page size, calibrated against real narrators of varied
 * content profiles (heavy tool trees, subagent-dense, plain text). It is the
 * count that fills the viewport + overscan in ONE page for the common case, so
 * the shell fill-loop rarely needs a follow-up fetch:
 *
 * - LOD 1/2: activity folds to trace rows / count-lines, so many messages are
 *   needed to fill the viewport — but each measures almost nothing (~1ms/100), so
 *   a large page has negligible cost.
 * - LOD 3-5: cards expand and each message is tall, so few are needed; capping at
 *   40 keeps the expensive high-LOD measurement bounded (≈2x faster first paint)
 *   while still filling the viewport for every profile measured.
 */
export function firstScreenPageSizeForLod(lod: number): number {
	return lod <= 2 ? 100 : 40;
}

function resolveFetchPage(
	fetchPage: PretextDocumentFetchPage | undefined,
): PretextDocumentFetchPage {
	return fetchPage ?? ((id, opts) => narratorsApi.getPretextDocumentPage(id, opts));
}

function assertValidMessageVersion(version: number): void {
	if (!Number.isInteger(version) || version < 0)
		throw new Error("pretext document page has an invalid message version");
}

function oldestSeqOf(messages: readonly TreeMessage[]): number | null {
	let min: number | null = null;
	for (const message of messages) {
		const seq = typeof message.seq === "number" ? message.seq : null;
		if (seq == null) continue;
		if (min == null || seq < min) min = seq;
	}
	return min;
}

/**
 * Load the newest (tail) transport page — the first screen of the exact layout.
 *
 * Unlike {@link loadPretextDocument} this does NOT walk the whole history. It
 * returns one bounded page plus the cursor/flags the coordinator needs to lazily
 * extend the loaded window upward (reverse infinite scroll) without ever
 * re-measuring committed rows.
 */
export async function loadPretextDocumentTail(
	narratorId: string,
	options: PretextDocumentLoadOptions = {},
): Promise<PretextDocumentInput> {
	// First screen: prefer the (LOD-derived) first-screen size, falling back to an
	// explicit pageSize, then the default. Older pages keep using pageSize.
	const pageSize = resolvePageSize(options.firstScreenPageSize ?? options.pageSize);
	const fetchPage = resolveFetchPage(options.fetchPage);
	const page = await fetchPage(narratorId, { limit: pageSize });
	assertValidMessageVersion(page.messageVersion);
	options.onProgress?.(page.messages.length);
	return {
		messages: [...page.messages],
		messageVersion: page.messageVersion,
		pruneBoundaryMessageId: page.pruneBoundaryMessageId ?? null,
		prunedPercent: page.prunedPercent ?? null,
		oldestLoadedSeq: oldestSeqOf(page.messages),
		hasPrev: page.hasPrev,
	};
}

/**
 * Fetch the page immediately older than `beforeSeq` and prepend it to the
 * existing input.
 *
 * Why this does NOT pin `messageVersion`
 * -------------------------------------
 * It used to send the loaded version and throw when the server's differed. That
 * looked like a safety check but was a live-lock: the server bumps
 * `messageVersion` on every message insert AND on tool completion, while a live
 * lifecycle patch deliberately keeps the client's version fixed (CONTRACT.md §4.5
 * — moving it would invalidate every committed row's cached measurement). So after
 * any tool finished, the two had drifted by construction and the next upward scroll
 * got a 409 that put the coordinator into `error`, where `loadOlder` early-returns
 * forever: older history became silently unloadable, with no visible error because
 * the canvas kept rendering the pages it already had.
 *
 * The version was never the property that mattered here. Prepending is safe as long
 * as the incoming page is STRICTLY OLDER than what is loaded and the prune metadata
 * still describes the same document — both checked below. Atomicity of the page
 * itself is enforced server-side (it re-checks its own version mid-build), so a page
 * spanning a mutation is still rejected there.
 *
 * A version difference is therefore informational: newer tail content the loaded
 * window does not have yet, which the structural reload path owns.
 */
export async function loadPretextDocumentOlder(
	narratorId: string,
	previous: PretextDocumentInput,
	options: PretextDocumentLoadOptions = {},
): Promise<PretextDocumentInput> {
	if (!previous.hasPrev || previous.oldestLoadedSeq == null) return previous;
	const pageSize = resolvePageSize(options.pageSize);
	const maxMessages = Math.max(1, Math.trunc(options.maxMessages ?? DEFAULT_MAX_MESSAGES));
	const fetchPage = resolveFetchPage(options.fetchPage);
	const page = await fetchPage(narratorId, {
		beforeSeq: previous.oldestLoadedSeq,
		limit: pageSize,
	});
	if (
		(page.pruneBoundaryMessageId ?? null) !== previous.pruneBoundaryMessageId ||
		(page.prunedPercent ?? null) !== previous.prunedPercent
	)
		throw new Error("pretext document prune metadata changed during pagination");
	if (page.messages.length === 0) {
		// The server has no older rows after all; close the upward window.
		return { ...previous, hasPrev: false };
	}
	const pageMaxSeq = page.maxSeq;
	if (pageMaxSeq != null && pageMaxSeq >= previous.oldestLoadedSeq)
		throw new Error("pretext document pages overlap or are not strictly older");
	const messages = [...page.messages, ...previous.messages];
	if (messages.length > maxMessages)
		throw new Error(`pretext document exceeds the ${maxMessages}-message exact-layout limit`);
	options.onProgress?.(messages.length);
	return {
		...previous,
		messages,
		// The loaded version is KEPT, not advanced to the server's. It is the
		// measurement cache generation for the rows already on screen; adopting a
		// newer one here would invalidate the whole window on every upward page — the
		// exact cost the cache exists to avoid — without making anything more correct.
		// A genuinely changed message arrives through the structural reload path, which
		// replaces the window and its version together.
		oldestLoadedSeq: oldestSeqOf(page.messages) ?? previous.oldestLoadedSeq,
		hasPrev: page.hasPrev,
	};
}

/**
 * Load the complete ordered message input required to compute one exact layout.
 *
 * Retained as a fallback (and for tests): it walks every transport page from the
 * start. Interactive first-screen rendering uses {@link loadPretextDocumentTail}
 * plus {@link loadPretextDocumentOlder} instead so long histories do not fetch
 * the entire document up front.
 */
export async function loadPretextDocument(
	narratorId: string,
	options: PretextDocumentLoadOptions = {},
): Promise<PretextDocumentInput> {
	const pageSize = resolvePageSize(options.pageSize);
	const maxMessages = Math.max(1, Math.trunc(options.maxMessages ?? DEFAULT_MAX_MESSAGES));
	const fetchPage = resolveFetchPage(options.fetchPage);
	const messages: TreeMessage[] = [];
	let fromSeq: number | undefined = FROM_START_AFTER_SEQ;
	let messageVersion: number | undefined;
	let pruneBoundaryMessageId: string | null = null;
	let prunedPercent: number | null = null;
	let previousMaxSeq: number | undefined;
	for (;;) {
		const page = await fetchPage(narratorId, {
			afterSeq: fromSeq,
			limit: pageSize,
			...(messageVersion == null ? {} : { messageVersion }),
		});
		const pagePruneBoundaryMessageId = page.pruneBoundaryMessageId ?? null;
		const pagePrunedPercent = page.prunedPercent ?? null;
		if (messageVersion == null) {
			assertValidMessageVersion(page.messageVersion);
			messageVersion = page.messageVersion;
			pruneBoundaryMessageId = pagePruneBoundaryMessageId;
			prunedPercent = pagePrunedPercent;
		} else {
			if (page.messageVersion !== messageVersion)
				throw new Error("pretext document changed during pagination");
			if (
				pagePruneBoundaryMessageId !== pruneBoundaryMessageId ||
				pagePrunedPercent !== prunedPercent
			)
				throw new Error("pretext document prune metadata changed during pagination");
		}
		if (page.messages.length === 0) break;
		const pageMinSeq = page.minSeq;
		const pageMaxSeq = page.maxSeq;
		if (pageMinSeq == null || pageMaxSeq == null || pageMaxSeq < pageMinSeq)
			throw new Error("pretext document page has invalid sequence bounds");
		if (previousMaxSeq != null && pageMinSeq <= previousMaxSeq)
			throw new Error("pretext document pages overlap or are not strictly newer");
		messages.push(...page.messages);
		if (messages.length > maxMessages)
			throw new Error(`pretext document exceeds the ${maxMessages}-message exact-layout limit`);
		options.onProgress?.(messages.length);
		if (!page.hasNext) break;
		if (previousMaxSeq != null && pageMaxSeq <= previousMaxSeq)
			throw new Error("pretext document pagination did not advance");
		previousMaxSeq = pageMaxSeq;
		fromSeq = pageMaxSeq;
	}
	return {
		messages,
		messageVersion: messageVersion ?? 0,
		pruneBoundaryMessageId,
		prunedPercent,
		oldestLoadedSeq: oldestSeqOf(messages),
		hasPrev: false,
	};
}
