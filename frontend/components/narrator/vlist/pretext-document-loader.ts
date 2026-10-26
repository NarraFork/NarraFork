import { narratorsApi } from "@frontend/lib/api/narrators";
import type { PretextDocumentPageResult, TreeMessage } from "@frontend/lib/api/types";
import { narratorLoadingMetrics } from "@frontend/lib/narrator-loading-metrics";
import { isNestedRow } from "../message/nested-rows";
import { peekCachedPretextDocument } from "./pretext-document-cache";
import { onPretextSessionChange, pretextSessionEpoch } from "./pretext-session-scope";

export type PretextDocumentFetchPage = (
	narratorId: string,
	opts: {
		afterSeq?: number;
		beforeSeq?: number;
		limit: number;
		messageVersion?: number;
		signal?: AbortSignal;
		maxResponseBytes?: number;
		onResponseBytes?: (bytes: number) => void;
	},
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
	locateMessage?: (
		narratorId: string,
		messageId: string,
		signal?: AbortSignal,
	) => Promise<{ seq: number }>;
	onProgress?: (loadedMessages: number) => void;
	/** Explicit structural reloads supersede a pending transport, never a normal mount. */
	forceTailReload?: boolean;
	/** Restore retries share this remaining budget, always capped at 10 seconds. */
	windowTimeoutMs?: number;
	/** Cancel only this waiter; other panels/preloaders keep the shared request alive. */
	signal?: AbortSignal;
}

export interface PretextDocumentInput {
	messages: TreeMessage[];
	messageVersion: number;
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

const defaultFetchPage: PretextDocumentFetchPage = (id, opts) =>
	narratorsApi.getPretextDocumentPage(id, opts);
function resolveFetchPage(
	fetchPage: PretextDocumentFetchPage | undefined,
): PretextDocumentFetchPage {
	return fetchPage ?? defaultFetchPage;
}

function assertValidMessageVersion(version: number): void {
	if (!Number.isInteger(version) || version < 0)
		throw new Error("pretext document page has an invalid message version");
}

function oldestSeqOf(messages: readonly TreeMessage[]): number | null {
	let min: number | null = null;
	for (const message of messages) {
		const seq = typeof message.seq === "number" ? message.seq : null;
		if (seq == null || isNestedRow(message)) continue;
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
interface TailRequest {
	narratorId: string;
	fetchPage: PretextDocumentFetchPage;
	epoch: number;
	controller: AbortController;
	promise: Promise<PretextDocumentInput>;
	waiters: number;
	settled: boolean;
	consumed: boolean;
	reusable: boolean;
	timer?: ReturnType<typeof setTimeout>;
}
// Active grid panels are not cache entries: a fifth panel must never cancel the
// first panel's transport. Bound admission separately from idle handoff retention.
const MAX_ACTIVE_TAIL_REQUESTS = 32;
const MAX_TAIL_HANDOFFS = 4;
const TAIL_DEADLINE_MS = 15_000;
const activeTailRequests = new Set<TailRequest>();
const tailHandoffs = new Set<TailRequest>();
function dropTail(entry: TailRequest) {
	activeTailRequests.delete(entry);
	tailHandoffs.delete(entry);
	entry.reusable = false;
	clearTimeout(entry.timer);
}
function retainTailHandoff(entry: TailRequest) {
	activeTailRequests.delete(entry);
	tailHandoffs.add(entry);
	entry.timer = setTimeout(() => dropTail(entry), TAIL_DEADLINE_MS);
	while (tailHandoffs.size > MAX_TAIL_HANDOFFS) {
		const oldest = tailHandoffs.values().next().value;
		if (oldest) dropTail(oldest);
	}
}
const unsubscribeTailSession = onPretextSessionChange(() => {
	for (const entry of [...activeTailRequests, ...tailHandoffs]) {
		entry.controller.abort();
		dropTail(entry);
	}
});
export function invalidatePretextDocumentTail(narratorId: string): void {
	for (const entry of [...activeTailRequests, ...tailHandoffs]) {
		if (entry.narratorId !== narratorId) continue;
		entry.controller.abort();
		dropTail(entry);
	}
}
function abortTailError() {
	return new DOMException("Tail request cancelled", "AbortError");
}
function sharedTail(
	narratorId: string,
	options: PretextDocumentLoadOptions,
	preload: boolean,
): Promise<PretextDocumentInput> {
	if (options.signal?.aborted) return Promise.reject(abortTailError());
	const epoch = pretextSessionEpoch();
	const fetchPage = resolveFetchPage(options.fetchPage);
	if (options.forceTailReload) {
		for (const previous of [...activeTailRequests, ...tailHandoffs]) {
			if (previous.narratorId !== narratorId || previous.fetchPage !== fetchPage) continue;
			// Supersede lookup, not another consumer's transport or its active budget.
			previous.reusable = false;
			if (previous.settled && previous.waiters === 0) dropTail(previous);
		}
	}
	let entry = options.forceTailReload
		? undefined
		: [...activeTailRequests, ...tailHandoffs].find(
				(item) =>
					item.reusable &&
					item.narratorId === narratorId &&
					item.fetchPage === fetchPage &&
					item.epoch === epoch,
			);
	if (!entry) {
		if (activeTailRequests.size >= MAX_ACTIVE_TAIL_REQUESTS)
			return Promise.reject(new Error("Too many active tail requests (limit 32)"));
		const controller = new AbortController();
		entry = {
			narratorId,
			fetchPage,
			epoch,
			controller,
			promise: undefined as unknown as Promise<PretextDocumentInput>,
			waiters: 0,
			settled: false,
			consumed: false,
			reusable: true,
		};
		const request = entry;
		const metricToken = narratorLoadingMetrics.current(narratorId);
		if (metricToken) narratorLoadingMetrics.mark(metricToken, "tail-start");
		activeTailRequests.add(request);
		const deadline = setTimeout(() => controller.abort(), TAIL_DEADLINE_MS);
		let rejectAbort: () => void = () => {};
		const aborted = new Promise<never>((_resolve, reject) => {
			rejectAbort = () => reject(abortTailError());
			controller.signal.addEventListener("abort", rejectAbort, { once: true });
		});
		request.promise = (async () => {
			try {
				// Enforce the shared deadline even when a custom fetcher ignores abort.
				const page = await Promise.race([
					fetchPage(narratorId, {
						limit: resolvePageSize(options.firstScreenPageSize ?? options.pageSize),
						signal: controller.signal,
						maxResponseBytes: 8 * 1024 * 1024,
					}),
					aborted,
				]);
				if (controller.signal.aborted || epoch !== pretextSessionEpoch()) throw abortTailError();
				assertValidMessageVersion(page.messageVersion);
				if (metricToken)
					narratorLoadingMetrics.mark(metricToken, "tail-ready", { rows: page.messages.length });
				return {
					messages: [...page.messages],
					messageVersion: page.messageVersion,
					oldestLoadedSeq: oldestSeqOf(page.messages),
					hasPrev: page.hasPrev,
				};
			} catch (error) {
				dropTail(request);
				throw error;
			} finally {
				clearTimeout(deadline);
				controller.signal.removeEventListener("abort", rejectAbort);
				request.settled = true;
			}
		})();
	}
	const request = entry;
	// Adopting an idle handoff makes it a live shared entry until its consumers
	// finish; it is no longer a candidate for cache eviction or TTL expiry.
	if (tailHandoffs.delete(request)) {
		clearTimeout(request.timer);
		activeTailRequests.add(request);
	}
	request.waiters++;
	if (!preload) request.consumed = true;
	return new Promise((resolve, reject) => {
		let active = true;
		const finish = () => {
			if (!active) return false;
			active = false;
			options.signal?.removeEventListener("abort", cancel);
			if (--request.waiters === 0) {
				if (!request.settled) {
					request.controller.abort();
					dropTail(request);
				} else if (request.consumed || !request.reusable) dropTail(request);
				else retainTailHandoff(request);
			}
			return true;
		};
		const cancel = () => {
			if (finish()) reject(abortTailError());
		};
		options.signal?.addEventListener("abort", cancel, { once: true });
		request.promise.then(
			(input) => {
				if (!finish()) return;
				if (request.controller.signal.aborted || request.epoch !== pretextSessionEpoch()) {
					reject(abortTailError());
					return;
				}
				options.onProgress?.(input.messages.length);
				resolve(input);
			},
			(error) => {
				if (finish()) reject(error);
			},
		);
	});
}
export function loadPretextDocumentTail(
	narratorId: string,
	options: PretextDocumentLoadOptions = {},
): Promise<PretextDocumentInput> {
	return sharedTail(narratorId, options, false);
}
export function preloadPretextDocumentTail(
	narratorId: string,
	options: PretextDocumentLoadOptions = {},
): Promise<PretextDocumentInput> {
	if (options.signal?.aborted) return Promise.reject(abortTailError());
	// A warm window is adopted synchronously and revalidated canonically by the
	// coordinator. Do not race it with another unsolicited tail transport.
	if (!options.forceTailReload) {
		const cached = peekCachedPretextDocument(narratorId);
		if (cached) return Promise.resolve(cached);
	}
	return sharedTail(narratorId, options, true);
}
if (import.meta.hot) import.meta.hot.dispose(unsubscribeTailSession);

/**
 * Re-read the current window by stable first-message ID, not its shifted seq.
 * Budget follows the loaded window (+100 mutation slots), capped at 10,000 rows,
 * 100 pages, 32 MiB of wire JSON and a shared 10s cancellation budget. This covers
 * the normal 800–1200 row trim window AND several thousand browsed history rows.
 * No tail jump or unbounded history walk; a partial window is never committed.
 */
function windowAbortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error || signal.reason instanceof DOMException
		? signal.reason
		: new DOMException("Window refresh cancelled", "AbortError");
}
function readWithinWindowBudget<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(windowAbortReason(signal));
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(windowAbortReason(signal));
		signal.addEventListener("abort", abort, { once: true });
		Promise.resolve()
			.then(() => {
				if (signal.aborted) throw windowAbortReason(signal);
				return read();
			})
			.then(
				(value) => {
					signal.removeEventListener("abort", abort);
					if (signal.aborted) reject(windowAbortReason(signal));
					else resolve(value);
				},
				(error) => {
					signal.removeEventListener("abort", abort);
					reject(error);
				},
			);
	});
}

function isDocumentChangedError(error: unknown): boolean {
	const failure = error as { status?: number; data?: { code?: unknown } } | null;
	return failure?.status === 409 && failure.data?.code === "PRETEXT_DOCUMENT_CHANGED";
}

export async function refreshPretextDocumentWindow(
	narratorId: string,
	previous: PretextDocumentInput,
	options: PretextDocumentLoadOptions = {},
): Promise<PretextDocumentInput | undefined> {
	const firstId = previous.messages[0]?.id;
	if (!firstId || previous.messages.length > 10_000) return undefined;
	const pageBudget = Math.min(100, Math.max(5, Math.ceil((previous.messages.length + 100) / 100)));
	let remainingBytes = 32 * 1024 * 1024;
	const controller = new AbortController();
	const parentAbort = () => controller.abort(options.signal?.reason);
	if (options.signal?.aborted) parentAbort();
	else options.signal?.addEventListener("abort", parentAbort, { once: true });
	const timeoutMs = Number.isFinite(options.windowTimeoutMs)
		? Math.min(10_000, Math.max(1, options.windowTimeoutMs as number))
		: 10_000;
	const timer = setTimeout(
		() => controller.abort(new DOMException("Window refresh timed out", "TimeoutError")),
		timeoutMs,
	);
	try {
		const locate = options.locateMessage ?? narratorsApi.getMessageLocation;
		const location = await readWithinWindowBudget(
			() => locate(narratorId, firstId, controller.signal),
			controller.signal,
		);
		if (!Number.isSafeInteger(location.seq) || location.seq < 0) return undefined;
		const fetchPage = resolveFetchPage(options.fetchPage);
		let afterSeq = location.seq - 1;
		let version: number | undefined;
		let hasPrev = false;
		const messages: TreeMessage[] = [];
		const messageIds = new Set<string>();
		for (let pageIndex = 0; pageIndex < pageBudget; pageIndex++) {
			if (controller.signal.aborted) throw windowAbortReason(controller.signal);
			if (remainingBytes <= 0) return undefined;
			let reportedBytes: number | undefined;
			let page: Awaited<ReturnType<typeof fetchPage>>;
			try {
				page = await readWithinWindowBudget(
					() =>
						fetchPage(narratorId, {
							afterSeq,
							limit: 100,
							messageVersion: version,
							signal: controller.signal,
							maxResponseBytes: remainingBytes,
							onResponseBytes: (bytes) => {
								reportedBytes = bytes;
							},
						}),
					controller.signal,
				);
			} catch (error) {
				// The pinned revision moved on: the same "window no longer current"
				// outcome as a version mismatch below, which the caller answers with a
				// structural reload. Throwing instead skipped that reload entirely.
				if (isDocumentChangedError(error)) return undefined;
				throw error;
			}
			// Production reports actual streamed bytes before JSON parsing. Custom
			// fetchers used by embedders/tests still pay the serialized-payload budget.
			const pageBytes = reportedBytes ?? new TextEncoder().encode(JSON.stringify(page)).byteLength;
			remainingBytes -= pageBytes;
			if (controller.signal.aborted) throw windowAbortReason(controller.signal);
			if (remainingBytes < 0) return undefined;
			assertValidMessageVersion(page.messageVersion);
			if (version != null && version !== page.messageVersion) return undefined;
			version = page.messageVersion;
			if (pageIndex === 0) {
				// A concurrent insertion between locate and fetch can shift the boundary.
				if (page.messages[0]?.id !== firstId) return undefined;
				hasPrev = page.hasPrev;
			}
			// The page limit counts the conversation's rows, not the rows nested under them.
			const pageRows = page.messages.filter((message) => !isNestedRow(message)).length;
			if (!Number.isFinite(pageBytes) || pageBytes < 0 || pageRows > 100) return undefined;
			if (
				page.messages.length > 0 &&
				(page.minSeq == null ||
					page.maxSeq == null ||
					page.minSeq <= afterSeq ||
					page.maxSeq < page.minSeq)
			)
				return undefined;
			for (const message of page.messages) {
				if (messageIds.has(message.id)) return undefined;
				messageIds.add(message.id);
			}
			messages.push(...page.messages);
			if (!page.hasNext)
				return {
					messages,
					messageVersion: version,
					oldestLoadedSeq: oldestSeqOf(messages),
					hasPrev,
				};
			if (page.maxSeq == null || page.maxSeq <= afterSeq) return undefined;
			afterSeq = page.maxSeq;
		}
		return undefined;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", parentAbort);
	}
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
 * as the incoming page is STRICTLY OLDER than what is loaded, checked below.
 * Atomicity of the page
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
	let previousMaxSeq: number | undefined;
	for (;;) {
		const page = await fetchPage(narratorId, {
			afterSeq: fromSeq,
			limit: pageSize,
			...(messageVersion == null ? {} : { messageVersion }),
		});
		if (messageVersion == null) {
			assertValidMessageVersion(page.messageVersion);
			messageVersion = page.messageVersion;
		} else {
			if (page.messageVersion !== messageVersion)
				throw new Error("pretext document changed during pagination");
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
		oldestLoadedSeq: oldestSeqOf(messages),
		hasPrev: false,
	};
}
