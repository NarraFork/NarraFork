import { ApiError, authorizedFetch, BASE, getErrorMessage, readFetchError } from "./client";
import type { StorageCategoryResult, StorageScanResult } from "./types";

const MAX_SSE_BUFFER_CHARS = 64_000;

function createSseResidualError(): Error {
	return new Error(`SSE stream line exceeded ${MAX_SSE_BUFFER_CHARS} characters before a newline`);
}

async function cancelSseReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
	try {
		await reader.cancel();
	} catch {
		// Ignore cancellation failures; the original error is more important.
	}
}

function drainCompleteSseLines(buffer: string, onLine: (line: string) => void): string {
	let newlineIndex = buffer.indexOf("\n");
	while (newlineIndex !== -1) {
		let line = buffer.slice(0, newlineIndex);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		onLine(line);
		buffer = buffer.slice(newlineIndex + 1);
		newlineIndex = buffer.indexOf("\n");
	}
	return buffer;
}

interface ParsedSseEvent {
	eventName: string;
	data: string;
}

function readSseFieldValue(line: string, prefixLength: number): string {
	const value = line.slice(prefixLength);
	return value.startsWith(" ") ? value.slice(1) : value;
}

function createSseEventParser(defaultEventName: string) {
	let eventName = defaultEventName;
	let dataLines: string[] = [];

	const reset = () => {
		eventName = defaultEventName;
		dataLines = [];
	};

	const dispatch = (): ParsedSseEvent | null => {
		const hasExplicitEvent = eventName !== defaultEventName;
		if (dataLines.length === 0 && !hasExplicitEvent) {
			reset();
			return null;
		}

		const event = { eventName, data: dataLines.join("\n") };
		reset();
		return event;
	};

	return {
		handleLine(line: string): ParsedSseEvent | null {
			if (line.trim() === "") return dispatch();
			if (line.startsWith(":")) return null;
			if (line.startsWith("event:")) {
				eventName = readSseFieldValue(line, 6).trim();
				return null;
			}
			if (line.startsWith("data:")) {
				dataLines.push(readSseFieldValue(line, 5));
			}
			return null;
		},
		flushPending: dispatch,
	};
}

async function enforceSseResidualLimit(
	buffer: string,
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
	if (buffer.length <= MAX_SSE_BUFFER_CHARS) return;
	await cancelSseReader(reader);
	throw createSseResidualError();
}

	providers?: {
			routes?: {
				supported?: boolean;
				chat?: boolean;
				chatReason?: unknown;
				reason?: unknown;
			};
		};
	};
}

	supported: boolean;
	reason?: string;
} {
	if (!capabilities) return { supported: true };
	const supported = routes?.supported !== false && routes?.chat === true;
	const routeReason = routes?.chatReason;
	return {
		supported,
		reason: supported
			? undefined
			: typeof routeReason === "string"
				? routeReason
				: typeof routes?.reason === "string"
					? routes.reason
					: undefined,
	};
}

	if (capability.supported) return;
	throw new ApiError(reason, 501, {
		ok: false,
		code: "FEATURE_DISABLED",
		supported: false,
		fallback: true,
		reason,
		error: reason,
		message: reason,
	});
}

	text: string,
	model?: string,
	signal?: AbortSignal,
): AsyncGenerator<string> {
}

/**
 *
 */
	text: string,
	model?: string,
	signal?: AbortSignal,
): AsyncGenerator<string> {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text, model }),
		signal,
	});
	if (!res.ok) {
		const error = await readFetchError(res, "Request failed");
		throw new ApiError(error.message, res.status, error.data);
	}
	if (!res.body) throw new Error("No response body");

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	const parser = createSseEventParser("chunk");

	const consumeEvent = (event: ParsedSseEvent, chunks: string[]): Error | "done" | null => {
		if (event.eventName === "error") {
			try {
				const parsed = JSON.parse(event.data) as Record<string, unknown>;
				return new ApiError(getErrorMessage(parsed, "Unknown error"), 500, parsed);
			} catch {
				const message = event.data || "Unknown error";
				return new ApiError(message, 500, { error: message });
			}
		}
		if (event.eventName === "done") return "done";
		chunks.push(event.data);
		return null;
	};

	const flushLines = async (final = false): Promise<{ chunks: string[]; done: boolean }> => {
		const chunks: string[] = [];
		let terminal: Error | "done" | null = null;
		buf = drainCompleteSseLines(buf, (line) => {
			if (terminal) return;
			const event = parser.handleLine(line);
			if (event) terminal = consumeEvent(event, chunks);
		});
		if (!terminal && final) {
			if (buf.length > 0) {
				const finalLine = buf.endsWith("\r") ? buf.slice(0, -1) : buf;
				const event = parser.handleLine(finalLine);
				if (event) terminal = consumeEvent(event, chunks);
				buf = "";
			}
			if (!terminal) {
				const event = parser.flushPending();
				if (event) terminal = consumeEvent(event, chunks);
			}
		}
		if (terminal instanceof Error) {
			await cancelSseReader(reader);
			throw terminal;
		}
		return { chunks, done: terminal === "done" };
	};

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		const parsed = await flushLines();
		for (const chunk of parsed.chunks) yield chunk;
		if (parsed.done) {
			await cancelSseReader(reader);
			return;
		}
		await enforceSseResidualLimit(buf, reader);
	}

	buf += decoder.decode();
	const parsed = await flushLines(true);
	for (const chunk of parsed.chunks) yield chunk;
}

/**
 * Scan storage via SSE stream.
 * Calls onProgress for status updates, onCategory for each scanned category,
 * and resolves with the complete result.
 */
export async function scanStorageStream(callbacks: {
	/**
	 * `detail` carries table-level progress for the database step, which measures ~116 tables and
	 * dominates the scan. Without it the UI would sit on one static message for seconds.
	 */
	onProgress?: (message: string, detail?: { done: number; total: number }) => void;
	onCategory?: (data: StorageCategoryResult) => void;
	signal?: AbortSignal;
}): Promise<StorageScanResult> {
	// The signal is forwarded to fetch so aborting tears down the response body. The server's
	// ReadableStream cancel handler then aborts the scan itself, including its worker read tasks —
	// previously the scan ran to completion with nowhere to write its events.
	const response = await authorizedFetch(`${BASE}/storage/scan`, { signal: callbacks.signal });
	if (!response.ok) {
		const error = await readFetchError(response, "Scan failed");
		throw new ApiError(error.message, response.status, error.data);
	}
	const reader = response.body?.getReader();
	if (!reader) {
		throw new ApiError("No response body", 500);
	}

	const decoder = new TextDecoder();
	let buffer = "";
	const parser = createSseEventParser("");
	let result: StorageScanResult | null = null;
	let terminalError: Error | null = null;

	const handleEvent = ({ eventName, data }: ParsedSseEvent) => {
		const jsonStr = data.trim();
		if (!jsonStr) return;
		try {
			const parsed = JSON.parse(jsonStr);
			if (eventName === "progress") {
				callbacks.onProgress?.(parsed.message, parsed.detail);
			} else if (eventName === "category") {
				callbacks.onCategory?.(parsed);
			} else if (eventName === "complete") {
				result = parsed as StorageScanResult;
			} else if (eventName === "error") {
				terminalError = new ApiError(getErrorMessage(parsed, "Scan failed"), 500, parsed);
			}
		} catch {
			// Skip malformed JSON, matching the previous tolerant behavior.
		}
	};

	const flushLines = (final = false) => {
		buffer = drainCompleteSseLines(buffer, (line) => {
			const event = parser.handleLine(line);
			if (event) handleEvent(event);
		});
		if (!final) return;
		if (buffer.length > 0) {
			const finalLine = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
			const event = parser.handleLine(finalLine);
			if (event) handleEvent(event);
			buffer = "";
		}
		const event = parser.flushPending();
		if (event) handleEvent(event);
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			flushLines();
			if (terminalError) throw terminalError;
			if (result) {
				await cancelSseReader(reader);
				return result;
			}
			await enforceSseResidualLimit(buffer, reader);
		}

		buffer += decoder.decode();
		flushLines(true);
		if (terminalError) throw terminalError;
		if (result) return result;
		throw new ApiError("Scan stream ended before completion", 500);
	} catch (err) {
		await cancelSseReader(reader);
		throw err;
	}
}
