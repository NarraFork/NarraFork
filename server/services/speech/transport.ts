import { AppError } from "@server/lib/errors";
import { outboundFetch } from "@server/lib/net/outbound-fetch";
import { resolveProxyForUrl } from "@server/lib/net/proxy";
import { SPEECH_LIMITS, type SpeechProvider } from "@shared/speech";

class SpeechTransportError extends AppError {
	constructor(code: string) {
		const status = [
			"SPEECH_INVALID_INPUT",
			"SPEECH_UNSUPPORTED_FORMAT",
			"SPEECH_UNSUPPORTED_STREAMING",
			"SPEECH_UNSUPPORTED_INSTRUCTIONS",
		].includes(code)
			? 400
			: code === "SPEECH_TIMEOUT"
				? 504
				: code === "SPEECH_ABORTED"
					? 499
					: 502;
		super("Speech request could not be completed.", status, code);
	}
}

export function speechError(code = "SPEECH_UPSTREAM_ERROR"): AppError {
	return new SpeechTransportError(code);
}

/** No upstream exception, response body, URL or caller text crosses this boundary. */
export async function guarded<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof SpeechTransportError) throw error;
		throw speechError();
	}
}

export async function timed<T>(
	work: Promise<T>,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<T> {
	if (signal.aborted) {
		void work.catch(() => {});
		throw speechError("SPEECH_ABORTED");
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: () => void = () => {};
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				abort = () => reject(speechError("SPEECH_ABORTED"));
				signal.addEventListener("abort", abort, { once: true });
				timer = setTimeout(() => reject(speechError("SPEECH_TIMEOUT")), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
	}
}

export interface SpeechResponse {
	headers: Headers;
	bytes(limit?: number): AsyncIterable<Uint8Array>;
	close(): void;
}

export async function postSpeech(
	provider: SpeechProvider,
	path: string,
	body: BodyInit,
	signal: AbortSignal,
	sse = false,
): Promise<SpeechResponse> {
	return guarded(async () => {
		const controller = new AbortController();
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			controller.abort();
			signal.removeEventListener("abort", close);
			if (reader) {
				const owned = reader;
				void owned
					.cancel()
					.catch(() => {})
					.finally(() => {
						try {
							owned.releaseLock();
						} catch {}
					});
			}
		};
		signal.addEventListener("abort", close, { once: true });
		try {
			if (signal.aborted) throw speechError("SPEECH_ABORTED");
			const url = `${provider.baseUrl.replace(/\/$/, "")}/${path}`;
			const headers = new Headers(provider.extraHeaders);
			if (provider.apiKey) headers.set("Authorization", `Bearer ${provider.apiKey}`);
			if (!(body instanceof FormData)) headers.set("Content-Type", "application/json");
			else headers.delete("Content-Type");
			if (sse) {
				headers.set("Accept", "text/event-stream");
				headers.set("X-DashScope-SSE", "enable");
			}
			const response = await timed(
				outboundFetch(
					url,
					{
						method: "POST",
						body,
						headers,
						signal: controller.signal,
						redirect: "error",
					},
					{ proxyUrl: resolveProxyForUrl(url, provider.proxy), retryPolicy: "never" },
				),
				signal,
				SPEECH_LIMITS.idleTimeoutMs,
			);
			if (!response.ok || !response.body) {
				void response.body?.cancel().catch(() => {});
				throw speechError();
			}
			reader = response.body.getReader();
			if (closed) {
				void reader.cancel().catch(() => {});
				throw speechError("SPEECH_ABORTED");
			}
			const ownedReader = reader;
			return {
				headers: response.headers,
				close,
				async *bytes(limit = SPEECH_LIMITS.outputBytes) {
					let total = 0;
					try {
						while (true) {
							const next = await guarded(() =>
								timed(ownedReader.read(), signal, SPEECH_LIMITS.idleTimeoutMs),
							);
							if (signal.aborted) throw speechError("SPEECH_ABORTED");
							if (next.done) return;
							total += next.value.byteLength;
							if (total > limit) throw speechError("SPEECH_OUTPUT_LIMIT");
							// Keep parser work and binary yields bounded even for unusually large fetch chunks.
							for (let i = 0; i < next.value.length; i += 65536)
								yield next.value.subarray(i, i + 65536);
						}
					} finally {
						close();
						ownedReader.releaseLock();
					}
				},
			};
		} catch (error) {
			close();
			throw error;
		}
	});
}

export function parseJson(text: string): Record<string, unknown> {
	try {
		const value = JSON.parse(text);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw speechError();
		return value;
	} catch {
		throw speechError("SPEECH_INVALID_RESPONSE");
	}
}

export function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function checkUpstream(value: Record<string, unknown>): void {
	if (
		value.error ||
		value.type === "error" ||
		(value.code && value.code !== "200") ||
		(typeof value.status_code === "number" && value.status_code >= 400)
	)
		throw speechError();
}

export async function jsonResponse(response: SpeechResponse): Promise<Record<string, unknown>> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let text = "";
	return guarded(async () => {
		for await (const chunk of response.bytes(SPEECH_LIMITS.frameBytes))
			text += decoder.decode(chunk, { stream: true });
		text += decoder.decode();
		const value = parseJson(text);
		checkUpstream(value);
		return value;
	});
}

/** Bounded SSE: CRLF may straddle chunks; multiple data lines join with LF; EOF dispatches a tail. */
export function finished(value: Record<string, unknown>): boolean {
	const choice = record(Array.isArray(value.choices) ? value.choices[0] : undefined);
	const reason = record(value.output).finish_reason ?? choice.finish_reason;
	if (reason && reason !== "stop") throw speechError("SPEECH_INCOMPLETE_RESPONSE");
	return reason === "stop";
}

export async function* sseEvents(
	response: SpeechResponse,
	requireCompletion = false,
): AsyncIterable<Record<string, unknown>> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let line = "";
	let data: string[] = [];
	let size = 0;
	let lineBytes = 0;
	let event = "";
	let skipLf = false;
	const newline = /[\r\n]/g;
	const dispatch = () => {
		const text = data.join("\n");
		data = [];
		size = 0;
		const kind = event;
		event = "";
		if (kind === "error") throw speechError();
		if (!text) return undefined;
		if (text.trim() === "[DONE]") return null;
		const value = parseJson(text);
		checkUpstream(value);
		return value;
	};
	const accept = () => {
		if (!line) return dispatch();
		if (line.startsWith("data:")) {
			const value = line.slice(5).replace(/^ /, "");
			data.push(value);
			size += lineBytes + 1;
		} else if (line.startsWith("event:")) event = line.slice(6).trim();
		line = "";
		lineBytes = 0;
		return undefined;
	};
	try {
		for await (const chunk of response.bytes(
			SPEECH_LIMITS.outputBytes * 2 + SPEECH_LIMITS.frameBytes,
		)) {
			const text = decoder.decode(chunk, { stream: true });
			let start = 0;
			if (skipLf && text.length) {
				skipLf = false;
				if (text[0] === "\n") start = 1;
			}
			while (start < text.length) {
				newline.lastIndex = start;
				const end = newline.exec(text)?.index ?? -1;
				const segment = text.slice(start, end < 0 ? text.length : end);
				line += segment;
				lineBytes += Buffer.byteLength(segment);
				if (lineBytes + size > SPEECH_LIMITS.frameBytes) throw speechError("SPEECH_FRAME_LIMIT");
				if (end < 0) break;
				const value = accept();
				line = "";
				lineBytes = 0;
				start = end + 1;
				if (text[end] === "\r") {
					if (start === text.length) skipLf = true;
					else if (text[start] === "\n") start++;
				}
				if (value === null) return;
				if (value) {
					const complete = finished(value);
					yield value;
					if (complete) return;
				}
			}
		}
		line += decoder.decode();
		if (line) {
			const value = accept();
			if (value === null) return;
			if (value) yield value;
		}
		const tail = dispatch();
		if (tail === null) return;
		if (tail) {
			const complete = finished(tail);
			yield tail;
			if (complete) return;
		}
		if (requireCompletion) throw speechError("SPEECH_INCOMPLETE_RESPONSE");
	} catch (error) {
		if (error instanceof SpeechTransportError) throw error;
		throw speechError("SPEECH_INVALID_RESPONSE");
	} finally {
		response.close();
	}
}

export function decodeAudio(data: string): Uint8Array {
	if (
		data.length > SPEECH_LIMITS.frameBytes ||
		data.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(data)
	)
		throw speechError("SPEECH_INVALID_AUDIO");
	const bytes = Buffer.from(data, "base64");
	if (bytes.toString("base64") !== data) throw speechError("SPEECH_INVALID_AUDIO");
	return bytes;
}
