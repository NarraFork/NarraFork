import {
	TEXT_DOCUMENT_PACKET_BYTES,
	TEXT_DOCUMENT_PAGE_CHARS,
	type TextDocumentRange,
	type TextDocumentRangeReader,
	type TextDocumentRef,
} from "@shared/pretext-layout/text-document";
import type {
	PublicDiscussionMessage,
	PublicDiscussionPage,
	PublicSharedSession,
} from "@shared/public-narrator-share";
import type { WriteDocumentSourceReference } from "./api/narrators";
import type { PretextDocumentPageResult } from "./api/types";
import { apiUrl, assetUrl } from "./base-path";

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const IDENTIFIER = /^[a-zA-Z0-9_-]{1,128}$/;
const TOOL_IDENTIFIER = /^[A-Za-z0-9_:.-]{1,128}$/;
const CREDENTIAL = /^[a-zA-Z0-9_-]{32,256}$/;

/** Deliberately unrelated to ApiError: an unavailable share must never log the user out. */
export class PublicShareError extends Error {
	constructor(public readonly status: number) {
		super(`Public share request failed (${status})`);
	}
	get unavailable() {
		return [401, 403, 404, 410].includes(this.status);
	}
}

export function readPublicShareToken(hash: string): string {
	const params = new URLSearchParams(hash.replace(/^#/, ""));
	const token = params.get("token") ?? "";
	return params.getAll("token").length === 1 && CREDENTIAL.test(token) ? token : "";
}

export function buildPublicShareUrl(shareId: string, token: string, pageUrl: string): string {
	if (!IDENTIFIER.test(shareId) || !CREDENTIAL.test(token)) throw new PublicShareError(400);
	const url = new URL(assetUrl(`shared/narrators/${shareId}`), pageUrl);
	url.hash = new URLSearchParams({ token }).toString();
	return url.href;
}

/** Only explicit off-origin HTTP(S) links are interactive; never resolve relative/file URLs. */
export function publicShareExternalHref(href: string | undefined, origin: string): string | null {
	if (!href || !/^https?:\/\//i.test(href)) return null;
	try {
		const url = new URL(href);
		if (url.origin === origin || url.username || url.password) return null;
		return url.href;
	} catch {
		return null;
	}
}

async function readBoundedJson<T>(response: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<T> {
	const reader = response.body?.getReader();
	if (!reader) throw new PublicShareError(502);
	let bytes = 0;
	let text = "";
	const decoder = new TextDecoder();
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new PublicShareError(502);
			text += decoder.decode(value, { stream: true });
		}
		return JSON.parse(text + decoder.decode()) as T;
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

/** Safari 14-compatible cancellation with explicit cleanup for long-lived session signals. */
export function linkPublicShareSignals(signals: readonly AbortSignal[]): {
	signal: AbortSignal;
	dispose: () => void;
} {
	const controller = new AbortController();
	const listeners = new Map<AbortSignal, () => void>();
	const dispose = () => {
		for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
		listeners.clear();
	};
	// Settle already-aborted inputs before registering any listeners.
	const aborted = signals.find((signal) => signal.aborted);
	if (aborted) controller.abort(aborted.reason);
	else {
		for (const signal of signals) {
			if (listeners.has(signal)) continue;
			const listener = () => {
				dispose();
				controller.abort(signal.reason);
			};
			listeners.set(signal, listener);
			signal.addEventListener("abort", listener, { once: true });
		}
	}
	return { signal: controller.signal, dispose };
}

/**
 * The share page's read surface. The document endpoints return the narrator's
 * OWN shapes (TreeMessage pages, tool detail) — the share link is the grant,
 * and the shell rendering them is the same PretextExactMessageList the owner
 * uses. Realtime rides `/ws/narrator` in share-auth mode, not a bespoke SSE.
 */
export interface PublicShareClient {
	ensureWriteDocumentSource(
		toolUseId: string,
		reference: WriteDocumentSourceReference,
		signal?: AbortSignal,
	): Promise<TextDocumentRef>;
	getTextDocumentRange(
		refId: string,
		offset: number,
		limit: number,
		signal?: AbortSignal,
	): Promise<TextDocumentRange>;
	readTextDocumentRange: TextDocumentRangeReader;
	session(signal: AbortSignal): Promise<PublicSharedSession>;
	pretextDocument(
		signal: AbortSignal,
		opts: { afterSeq?: number; beforeSeq?: number; limit?: number; messageVersion?: number },
	): Promise<PretextDocumentPageResult>;
	messageLocation(
		messageId: string,
		signal: AbortSignal,
	): Promise<{ messageId: string; topLevelMessageId?: string; seq: number }>;
	toolCallDetail(
		toolUseId: string,
		ref: { toolCallId?: string; messageId?: string },
		signal: AbortSignal,
	): Promise<{ inputJson?: unknown; outputJson?: unknown } | null>;
	discussion(signal: AbortSignal, beforeSeq?: number): Promise<PublicDiscussionPage>;
	post(
		text: string,
		replyToMessageId: string | undefined,
		signal: AbortSignal,
	): Promise<PublicDiscussionMessage>;
}

/** No internal client imports, storage access, JWT renewal, cookies, redirects or arbitrary URLs. */
export function createPublicShareClient(shareId: string, credential: string): PublicShareClient {
	const valid = IDENTIFIER.test(shareId) && CREDENTIAL.test(credential);
	const root = apiUrl(`public/narrator-shares/${encodeURIComponent(shareId)}`);
	async function fetchShare(suffix: string, signal: AbortSignal, body?: string) {
		if (!valid) throw new PublicShareError(404);
		const response = await fetch(`${root}${suffix}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: `Share ${credential}`,
				Accept: "application/json",
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body,
			signal,
			credentials: "omit",
			referrerPolicy: "no-referrer",
			cache: "no-store",
			redirect: "error",
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			throw new PublicShareError(response.status);
		}
		return response;
	}
	async function json<T>(
		suffix: string,
		signal: AbortSignal,
		body?: string,
		maxBytes = MAX_RESPONSE_BYTES,
		timeoutMs = REQUEST_TIMEOUT_MS,
	): Promise<T> {
		const timeout = new AbortController();
		const timer = setTimeout(() => timeout.abort(), timeoutMs);
		const linked = linkPublicShareSignals([signal, timeout.signal]);
		try {
			return await readBoundedJson<T>(await fetchShare(suffix, linked.signal, body), maxBytes);
		} finally {
			clearTimeout(timer);
			linked.dispose();
		}
	}
	const getTextDocumentRange: PublicShareClient["getTextDocumentRange"] = (
		refId,
		offset,
		limit,
		signal,
	) => {
		if (
			!IDENTIFIER.test(refId) ||
			!Number.isSafeInteger(offset) ||
			offset < 0 ||
			!Number.isSafeInteger(limit) ||
			limit < 1
		)
			return Promise.reject(new PublicShareError(400));
		const query = new URLSearchParams({
			offset: String(offset),
			limit: String(Math.min(limit, TEXT_DOCUMENT_PAGE_CHARS)),
		});
		return json<TextDocumentRange>(
			`/text-documents/${encodeURIComponent(refId)}?${query}`,
			signal ?? new AbortController().signal,
			undefined,
			TEXT_DOCUMENT_PACKET_BYTES,
			10_000,
		);
	};
	return {
		ensureWriteDocumentSource: (toolUseId, reference, signal) => {
			if (
				!TOOL_IDENTIFIER.test(toolUseId) ||
				toolUseId === "." ||
				toolUseId === ".." ||
				!IDENTIFIER.test(reference.toolCallId) ||
				!IDENTIFIER.test(reference.messageId) ||
				!Number.isSafeInteger(reference.executionAttempt) ||
				reference.executionAttempt < 0
			)
				return Promise.reject(new PublicShareError(400));
			const query = new URLSearchParams({
				toolCallId: reference.toolCallId,
				messageId: reference.messageId,
				executionAttempt: String(reference.executionAttempt),
			});
			return json<TextDocumentRef>(
				`/tool-calls/${encodeURIComponent(toolUseId)}/input-document?${query}`,
				signal ?? new AbortController().signal,
				undefined,
				TEXT_DOCUMENT_PACKET_BYTES,
				10_000,
			);
		},
		getTextDocumentRange,
		readTextDocumentRange: (ref, offset, limit, signal) =>
			getTextDocumentRange(ref.id, offset, limit, signal),
		session: (signal) => json("", signal),
		pretextDocument: (signal, opts) => {
			const query = new URLSearchParams();
			if (opts.afterSeq !== undefined && Number.isSafeInteger(opts.afterSeq))
				query.set("afterSeq", String(opts.afterSeq));
			if (opts.beforeSeq !== undefined && Number.isSafeInteger(opts.beforeSeq))
				query.set("beforeSeq", String(opts.beforeSeq));
			if (opts.limit !== undefined && Number.isSafeInteger(opts.limit))
				query.set("limit", String(opts.limit));
			if (opts.messageVersion !== undefined && Number.isSafeInteger(opts.messageVersion))
				query.set("messageVersion", String(opts.messageVersion));
			const suffix = query.size ? `/pretext-document?${query}` : "/pretext-document";
			return json(suffix, signal);
		},
		messageLocation: (messageId, signal) => {
			if (!IDENTIFIER.test(messageId)) return Promise.reject(new PublicShareError(400));
			return json(`/message-location/${encodeURIComponent(messageId)}`, signal);
		},
		toolCallDetail: (toolUseId, ref, signal) => {
			if (!TOOL_IDENTIFIER.test(toolUseId) || toolUseId === "." || toolUseId === "..")
				return Promise.reject(new PublicShareError(400));
			const query = new URLSearchParams();
			if (ref.toolCallId) query.set("toolCallId", ref.toolCallId);
			if (ref.messageId) query.set("messageId", ref.messageId);
			const suffix = query.size
				? `/tool-calls/${encodeURIComponent(toolUseId)}?${query}`
				: `/tool-calls/${encodeURIComponent(toolUseId)}`;
			return json(suffix, signal);
		},
		discussion: (signal, beforeSeq) => {
			const query = new URLSearchParams({ limit: "50" });
			if (beforeSeq !== undefined && Number.isSafeInteger(beforeSeq) && beforeSeq > 0)
				query.set("beforeSeq", String(beforeSeq));
			return json(`/discussion?${query}`, signal);
		},
		post: (text, replyToMessageId, signal) => {
			if (
				!text.trim() ||
				text.length > 8_000 ||
				(replyToMessageId && !IDENTIFIER.test(replyToMessageId))
			) {
				return Promise.reject(new PublicShareError(400));
			}
			// Construct fields, rather than spreading caller-provided data (especially author/room IDs).
			return json(
				"/discussion",
				signal,
				JSON.stringify({ text, ...(replyToMessageId ? { replyToMessageId } : {}) }),
			);
		},
	};
}
