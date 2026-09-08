import type {
	PublicDiscussionMessage,
	PublicDiscussionPage,
	PublicSharedMessagePage,
	PublicSharedSession,
	PublicSharedToolDetail,
	PublicShareEvent,
} from "@shared/public-narrator-share";
import { apiUrl, assetUrl } from "./base-path";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_EVENT_CHARS = 64 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const STREAM_IDLE_TIMEOUT_MS = 45_000;
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

function validKind(value: unknown): value is "text" | "reasoning" {
	return value === "text" || value === "reasoning";
}

/** A closed display protocol, not a pass-through for internal WS or tool events. */
export function parsePublicShareEvent(raw: string): PublicShareEvent {
	if (raw.length > MAX_EVENT_CHARS) throw new PublicShareError(502);
	const event = JSON.parse(raw);
	if (!event || typeof event !== "object") throw new PublicShareError(502);
	switch (event.type) {
		case "ping":
		case "reset":
		case "revoked":
			return { type: event.type };
		case "invalidate":
			if (["messages", "discussion", "session"].includes(event.scope)) {
				return { type: "invalidate", scope: event.scope };
			}
			break;
		case "snapshot":
			if (
				Array.isArray(event.blocks) &&
				event.blocks.length <= 256 &&
				typeof event.truncated === "boolean" &&
				event.blocks.every(
					(block: { id?: unknown; kind?: unknown; text?: unknown }) =>
						block &&
						typeof block.id === "string" &&
						block.id.length <= 256 &&
						validKind(block.kind) &&
						typeof block.text === "string",
				)
			) {
				return {
					type: "snapshot",
					blocks: event.blocks.map(
						(block: { id: string; kind: "text" | "reasoning"; text: string }) => ({
							id: block.id,
							kind: block.kind,
							text: block.text,
						}),
					),
					truncated: event.truncated,
				};
			}
			break;
		case "delta":
			if (
				typeof event.blockId === "string" &&
				event.blockId.length <= 256 &&
				validKind(event.kind) &&
				typeof event.text === "string" &&
				Number.isSafeInteger(event.offset) &&
				event.offset >= 0
			) {
				return {
					type: "delta",
					blockId: event.blockId,
					kind: event.kind,
					text: event.text,
					offset: event.offset,
				};
			}
	}
	throw new PublicShareError(502);
}

export class PublicShareSseParser {
	private buffer = "";
	push(chunk: string): PublicShareEvent[] {
		this.buffer += chunk;
		const events: PublicShareEvent[] = [];
		while (true) {
			const end = /\r?\n\r?\n/.exec(this.buffer);
			if (!end) break;
			const frame = this.buffer.slice(0, end.index);
			this.buffer = this.buffer.slice(end.index + end[0].length);
			if (frame.length > MAX_EVENT_CHARS) throw new PublicShareError(502);
			const data = frame
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).replace(/^ /, ""))
				.join("\n");
			if (data) events.push(parsePublicShareEvent(data));
		}
		if (this.buffer.length > MAX_EVENT_CHARS) throw new PublicShareError(502);
		return events;
	}
}

async function readBoundedJson<T>(response: Response): Promise<T> {
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
			if (bytes > MAX_RESPONSE_BYTES) throw new PublicShareError(502);
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

export interface PublicShareClient {
	session(signal: AbortSignal): Promise<PublicSharedSession>;
	messages(
		signal: AbortSignal,
		beforeSeq?: number,
		messageVersion?: number,
	): Promise<PublicSharedMessagePage>;
	discussion(signal: AbortSignal, beforeSeq?: number): Promise<PublicDiscussionPage>;
	tool(id: string, signal: AbortSignal): Promise<PublicSharedToolDetail>;
	post(
		text: string,
		replyToMessageId: string | undefined,
		signal: AbortSignal,
	): Promise<PublicDiscussionMessage>;
	events(signal: AbortSignal, onEvent: (event: PublicShareEvent) => void): Promise<void>;
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
				Accept: suffix === "/events" ? "text/event-stream" : "application/json",
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
	async function json<T>(suffix: string, signal: AbortSignal, body?: string): Promise<T> {
		const timeout = new AbortController();
		const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
		const linked = linkPublicShareSignals([signal, timeout.signal]);
		try {
			return await readBoundedJson<T>(await fetchShare(suffix, linked.signal, body));
		} finally {
			clearTimeout(timer);
			linked.dispose();
		}
	}
	function paging(beforeSeq?: number, messageVersion?: number) {
		const query = new URLSearchParams({ limit: "50" });
		if (beforeSeq !== undefined && Number.isSafeInteger(beforeSeq) && beforeSeq > 0)
			query.set("beforeSeq", String(beforeSeq));
		if (messageVersion !== undefined && Number.isSafeInteger(messageVersion) && messageVersion >= 0)
			query.set("messageVersion", String(messageVersion));
		return query;
	}
	return {
		session: (signal) => json("", signal),
		messages: (signal, beforeSeq, version) =>
			json(`/messages?${paging(beforeSeq, version)}`, signal),
		discussion: (signal, beforeSeq) => json(`/discussion?${paging(beforeSeq)}`, signal),
		tool: (id, signal) => {
			if (!TOOL_IDENTIFIER.test(id) || id === "." || id === "..")
				return Promise.reject(new PublicShareError(400));
			return json(`/tools/${encodeURIComponent(id)}`, signal);
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
		async events(signal, onEvent) {
			const idle = new AbortController();
			let timer = setTimeout(() => idle.abort(), STREAM_IDLE_TIMEOUT_MS);
			const linked = linkPublicShareSignals([signal, idle.signal]);
			let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
			try {
				const response = await fetchShare("/events", linked.signal);
				if (!response.headers.get("content-type")?.includes("text/event-stream"))
					throw new PublicShareError(502);
				reader = response.body?.getReader();
				if (!reader) throw new PublicShareError(502);
				const decoder = new TextDecoder();
				const parser = new PublicShareSseParser();
				while (!signal.aborted) {
					const { value, done } = await reader.read();
					if (done) break;
					clearTimeout(timer);
					timer = setTimeout(() => idle.abort(), STREAM_IDLE_TIMEOUT_MS);
					// Parse bounded pieces even if a proxy coalesces many frames into one read.
					for (let offset = 0; offset < value.length; offset += 16_384) {
						for (const event of parser.push(
							decoder.decode(value.subarray(offset, offset + 16_384), { stream: true }),
						)) {
							if (signal.aborted) return;
							onEvent(event);
						}
					}
				}
			} finally {
				clearTimeout(timer);
				linked.dispose();
				await reader?.cancel().catch(() => {});
				reader?.releaseLock();
			}
		},
	};
}
