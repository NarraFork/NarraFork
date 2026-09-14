const MAX_SSE_BUFFER_CHARS = 64_000;

export type CompactLiveStreamEvent =
	| {
			kind: "delta";
			channel: "output" | "thinking";
			delta: string;
			outputChars: number;
			thinkingChars: number;
	  }
	| { kind: "heartbeat"; outputChars: number; thinkingChars: number }
	| { kind: "finished"; status: "compacted" | "failed" };

/** Consume the bounded SSE stream used only while a compact detail modal is open. */
export async function consumeCompactLiveStream(
	response: Response,
	onEvent: (event: CompactLiveStreamEvent) => void,
	signal?: AbortSignal,
): Promise<void> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Compact live stream has no response body");
	const decoder = new TextDecoder();
	let buffer = "";
	let eventName = "message";
	let dataLines: string[] = [];
	let finished = false;

	const dispatch = () => {
		if (dataLines.length === 0) {
			eventName = "message";
			return;
		}
		const raw = dataLines.join("\n");
		dataLines = [];
		const name = eventName;
		eventName = "message";
		if (name !== "delta" && name !== "heartbeat" && name !== "finished") return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error("Malformed compact live SSE event");
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("Malformed compact live SSE payload");
		}
		const record = parsed as Record<string, unknown>;
		if (record.kind !== name) return;
		if (name === "delta") {
			if (
				(record.channel !== "output" && record.channel !== "thinking") ||
				typeof record.delta !== "string" ||
				typeof record.outputChars !== "number" ||
				typeof record.thinkingChars !== "number"
			) {
				throw new Error("Malformed compact live delta");
			}
			onEvent({
				kind: "delta",
				channel: record.channel,
				delta: record.delta,
				outputChars: record.outputChars,
				thinkingChars: record.thinkingChars,
			});
			return;
		}
		if (name === "heartbeat") {
			if (typeof record.outputChars !== "number" || typeof record.thinkingChars !== "number") {
				throw new Error("Malformed compact live heartbeat");
			}
			onEvent({
				kind: "heartbeat",
				outputChars: record.outputChars,
				thinkingChars: record.thinkingChars,
			});
			return;
		}
		if (record.status !== "compacted" && record.status !== "failed") {
			throw new Error("Malformed compact live terminal event");
		}
		onEvent({ kind: "finished", status: record.status });
		finished = true;
	};

	const handleLine = (line: string) => {
		if (line === "") {
			dispatch();
			return;
		}
		if (line.startsWith(":")) return;
		if (line.startsWith("event:")) {
			eventName = line.slice(6).trim();
			return;
		}
		if (line.startsWith("data:")) {
			const value = line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5);
			dataLines.push(value);
			if (dataLines.join("\n").length > MAX_SSE_BUFFER_CHARS) {
				throw new Error("Compact live SSE event exceeded the size limit");
			}
		}
	};

	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		while (!finished) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				let line = buffer.slice(0, newline);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				handleLine(line);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
			if (buffer.length > MAX_SSE_BUFFER_CHARS) {
				throw new Error("Compact live SSE line exceeded the size limit");
			}
		}
		if (!finished) {
			buffer += decoder.decode();
			if (buffer) handleLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
			dispatch();
		}
	} finally {
		signal?.removeEventListener("abort", abort);
		if (finished || signal?.aborted) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
