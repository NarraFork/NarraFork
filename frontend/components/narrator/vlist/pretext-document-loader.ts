import { narratorsApi } from "@frontend/lib/api/narrators";
import type { PretextDocumentPageResult, TreeMessage } from "@frontend/lib/api/types";

export interface PretextDocumentLoadOptions {
	/** Number of transport pages requested at a time; never a scroll coordinate. */
	pageSize?: number;
	/** Hard safety bound for one exact-layout build. */
	maxMessages?: number;
	fetchPage?: (
		narratorId: string,
		opts: { afterSeq?: number; limit: number; messageVersion?: number },
	) => Promise<PretextDocumentPageResult>;
	onProgress?: (loadedMessages: number) => void;
}

export interface PretextDocumentInput {
	messages: TreeMessage[];
	messageVersion: number;
	pruneBoundaryMessageId: string | null;
	prunedPercent: number | null;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_MESSAGES = 50_000;

/**
 * Load the complete ordered message input required to compute one exact layout.
 *
 * The transport is paged for byte/latency bounds, but pages are deliberately not
 * exposed as layout units. The caller must receive the complete ordered input
 * before committing a new scrollbar height manifest.
 */
export async function loadPretextDocument(
	narratorId: string,
	options: PretextDocumentLoadOptions = {},
): Promise<PretextDocumentInput> {
	const pageSize = Math.min(
		Math.max(Math.trunc(options.pageSize ?? DEFAULT_PAGE_SIZE), 1),
		MAX_PAGE_SIZE,
	);
	const maxMessages = Math.max(1, Math.trunc(options.maxMessages ?? DEFAULT_MAX_MESSAGES));
	const fetchPage =
		options.fetchPage ?? ((id, opts) => narratorsApi.getPretextDocumentPage(id, opts));
	const messages: TreeMessage[] = [];
	let fromSeq: number | undefined;
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
			if (!Number.isInteger(page.messageVersion) || page.messageVersion < 0)
				throw new Error("pretext document page has an invalid message version");
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
	};
}
