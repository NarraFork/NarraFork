/**
 * NarraFork plugin RPC framing over stdio.
 *
 * `Content-Length`-delimited JSON-RPC 2.0, the same wire format the hand-written example
 * plugins implement. It lives in its own module because mixing transport with provider
 * logic would make both harder to follow.
 *
 * Two rules this layer exists to enforce:
 *
 * - **stdout carries protocol only.** Anything else corrupts the stream, so diagnostics go
 *   to stderr. A stray `console.log` in provider code is a protocol violation.
 * - **Every frame is bounded.** An unbounded buffer would let a malformed header grow
 *   memory without limit, so oversized headers and frames terminate the process instead.
 *
 *
 * The two files are byte-identical apart from the stderr prefix. That is deliberate: a
 * plugin is a self-contained package, and the example plugins do not import from each
 * other — a shared module would have to live in the host tree, which would make every
 * plugin depend on a host file it is supposed to be independent of. The cost is that a
 * framing fix has to be applied twice; the cost of the alternative is a coupling that
 * defeats the point of out-of-process plugins.
 */

export const RPC_PROTOCOL = "narrafork.rpc/1";

const MAX_HEADER_BYTES = 8 * 1024;
/**
 * Generous relative to the reference plugin's 64 KB: a chat request carries the full
 * conversation history, tool schemas and possibly base64 images, which legitimately
 * exceeds that.
 */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_BUFFER_BYTES = MAX_HEADER_BYTES + MAX_FRAME_BYTES + 4;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: string | number;
	method: string;
	params?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface HostRequestError extends Error {
	code: number;
	data?: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Diagnostics channel. stdout is reserved for protocol frames. */
export function log(message: string, detail?: unknown): void {
	const suffix = detail === undefined ? "" : ` ${safeJson(detail)}`;
	process.stderr.write(`[cline-external] ${message}${suffix}\n`);
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/** Concatenate into a freshly-allocated buffer, never a view over pooled memory. */
function append(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
	const next = new Uint8Array(new ArrayBuffer(left.byteLength + right.byteLength));
	next.set(left);
	next.set(right, left.byteLength);
	return next;
}

function delimiterIndex(bytes: Uint8Array): number {
	for (let index = 0; index <= bytes.byteLength - 4; index += 1) {
		if (
			bytes[index] === 13 &&
			bytes[index + 1] === 10 &&
			bytes[index + 2] === 13 &&
			bytes[index + 3] === 10
		) {
			return index;
		}
	}
	return -1;
}

function contentLength(header: string): number {
	let length: number | undefined;
	for (const line of header.split("\r\n")) {
		const separator = line.indexOf(":");
		if (separator <= 0) throw new Error("invalid RPC header");
		if (line.slice(0, separator).trim().toLowerCase() !== "content-length") continue;
		if (length !== undefined) throw new Error("duplicate Content-Length header");
		const value = line.slice(separator + 1).trim();
		if (!/^\d+$/.test(value)) throw new Error("invalid Content-Length header");
		length = Number(value);
	}
	if (length === undefined || !Number.isSafeInteger(length)) {
		throw new Error("missing Content-Length header");
	}
	return length;
}

export function send(message: unknown, callback?: () => void): void {
	const body = encoder.encode(JSON.stringify(message));
	const header = encoder.encode(
		`Content-Length: ${body.byteLength}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n`,
	);
	process.stdout.write(append(header, body), callback);
}

export function respond(id: string | number, result: unknown): void {
	send({ jsonrpc: "2.0", id, result });
}

export function reject(id: string | number, code: number, message: string, data?: unknown): void {
	send({
		jsonrpc: "2.0",
		id,
		error: { code, message, ...(data === undefined ? {} : { data }) },
	});
}

export function notify(method: string, params: unknown): void {
	send({ jsonrpc: "2.0", method, params });
}

// ---------------------------------------------------------------------------
// Plugin → Host request initiator
// ---------------------------------------------------------------------------

/**
 * Monotonically increasing ID for outgoing requests to the host.
 *
 * String prefix "p2h-" avoids collision with host-generated numeric IDs on the same
 * transport. The host does not restrict ID types: JSON-RPC 2.0 allows strings.
 */
let nextRequestId = 1;

interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: HostRequestError) => void;
	timer: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, PendingRequest>();

/** Default timeout for Plugin→Host requests (30 seconds). */
const HOST_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Send a JSON-RPC request to the host and await the response.
 *
 * The host processes Plugin→Host requests via `plugin-host-services.ts` and always
 * replies with either `result` or `error`. If the host closes the transport before
 * replying, the promise rejects with a timeout (the connection-end handler in `listen`
 * will call `process.exit(0)`, which cleans up all pending timers implicitly).
 *
 * Timeout is generous (30s) because the host may be writing to disk or contending with
 * other plugin calls. A `secrets.set` is a JSON read-modify-write on a vault file.
 *
 * This plugin uses it for `secrets.get`/`secrets.set`: unlike the reference plugin, its
 * commands read their own credentials this way rather than expecting the host to inject
 * config into the command input, because `commands.invoke` carries no config. See
 * `credentials.ts`.
 */
export function request(method: string, params: unknown): Promise<unknown> {
	const id = `p2h-${nextRequestId++}`;
	return new Promise<unknown>((resolve, rejectFn) => {
		const timer = setTimeout(() => {
			pendingRequests.delete(id);
			const error = new Error(`Host request timed out: ${method}`) as HostRequestError;
			error.code = -32001;
			rejectFn(error);
		}, HOST_REQUEST_TIMEOUT_MS);

		pendingRequests.set(id, { resolve, reject: rejectFn, timer });
		send({ jsonrpc: "2.0", id, method, params });
	});
}

/**
 * Resolve a pending request when the host sends a response frame.
 *
 * Returns true if the message was consumed as a response (so the caller does not try
 * to dispatch it as an inbound request).
 */
function handleResponse(message: Record<string, unknown>): boolean {
	if (typeof message.method === "string") return false; // It's a request, not a response.
	if (!("id" in message)) return false;
	if (!("result" in message || "error" in message)) return false;

	const id = String(message.id);
	const pending = pendingRequests.get(id);
	if (!pending) return true; // Already timed out or spurious; either way, consumed.

	clearTimeout(pending.timer);
	pendingRequests.delete(id);

	if ("error" in message && isRecord(message.error)) {
		const err = message.error;
		const error = new Error(
			typeof err.message === "string" ? err.message : "Host request failed",
		) as HostRequestError;
		error.code = typeof err.code === "number" ? err.code : -32603;
		error.data = err.data;
		pending.reject(error);
	} else {
		pending.resolve(message.result);
	}
	return true;
}

/**
 * Read framed messages from stdin and dispatch them.
 *
 * Requests (messages with `method` + `id`) go to `onRequest`.
 * Responses (messages with `id` + `result`/`error`, no `method`) resolve pending host requests.
 * Notifications and malformed messages are dropped rather than answered: a response to a
 * message with no `id` would itself be a protocol violation.
 */
export function listen(onRequest: (request: JsonRpcRequest) => void): void {
	let buffer = new Uint8Array(0);

	const parseFrames = (): void => {
		while (buffer.byteLength > 0) {
			const delimiter = delimiterIndex(buffer);
			if (delimiter < 0) {
				if (buffer.byteLength > MAX_HEADER_BYTES) throw new Error("RPC header exceeds limit");
				return;
			}
			if (delimiter > MAX_HEADER_BYTES) throw new Error("RPC header exceeds limit");
			const length = contentLength(decoder.decode(buffer.slice(0, delimiter)));
			if (length > MAX_FRAME_BYTES) throw new Error("RPC frame exceeds limit");
			const bodyStart = delimiter + 4;
			const frameEnd = bodyStart + length;
			if (buffer.byteLength < frameEnd) return;
			const message: unknown = JSON.parse(decoder.decode(buffer.slice(bodyStart, frameEnd)));
			buffer = buffer.slice(frameEnd);
			if (!isRecord(message) || message.jsonrpc !== "2.0") continue;

			// Route responses to the pending-request map before trying to dispatch as request.
			if (handleResponse(message)) continue;

			if (typeof message.method === "string" && "id" in message) {
				onRequest(message as unknown as JsonRpcRequest);
			}
		}
	};

	process.stdin.on("data", (chunk: Buffer) => {
		try {
			// Copy through a fresh buffer: a Node `Buffer` view is typed over `ArrayBufferLike`
			// and may share memory with the stream's internal pool.
			const bytes = new Uint8Array(chunk.byteLength);
			bytes.set(chunk);
			buffer = append(buffer, bytes);
			if (buffer.byteLength > MAX_BUFFER_BYTES) throw new Error("RPC input buffer exceeds limit");
			parseFrames();
		} catch (error) {
			log("fatal framing error", { error: error instanceof Error ? error.message : "unknown" });
			process.exit(2);
		}
	});

	process.stdin.on("end", () => process.exit(0));
}
