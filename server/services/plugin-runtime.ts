import { isAbsolute, relative, resolve } from "node:path";
import { AsyncMutex } from "@server/lib/async-mutex";
import { generateId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import {
	type JsonRpcEnvelope,
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
	jsonRpcEnvelopeSchema,
	NARRAFORK_RPC_PROTOCOL,
} from "@server/lib/plugins/protocol";
import {
	type PluginHealthRegistry,
	type PluginHealthSample,
	pluginHealthRegistry,
} from "./plugin-health";

const textEncoder = new TextEncoder();
const DEFAULT_MAX_HEADER_BYTES = 8 * 1024;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_STDERR_RING_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES_PER_SECOND = 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_SPAWN_TIMEOUT_MS = 15_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_ACTIVATION_TIMEOUT_MS = 30_000;
const DEFAULT_RPC_TIMEOUT_MS = 15_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_CANCEL_GRACE_MS = 2_000;
const DEFAULT_RESTART_WINDOW_MS = 60_000;
const DEFAULT_TOTAL_RESTART_WINDOW_MS = 15 * 60_000;
const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_MAX_TOTAL_RESTARTS = 10;
const DEFAULT_RESTART_BASE_DELAY_MS = 100;
const DEFAULT_RESTART_MAX_DELAY_MS = 30_000;
const DEFAULT_LOCAL_CPU_TIME_SECONDS = 300;
// Bun/Node runtimes commonly reserve more than 512 MiB of virtual address space
// before application code starts; keep the local hard cap conservative but usable.
const DEFAULT_LOCAL_MEMORY_BYTES = 1024 * 1024 * 1024;
const POSIX_RESOURCE_LIMIT_SHELL = "/bin/sh";
const POSIX_RESOURCE_LIMIT_SCRIPT = [
	"set -eu",
	'ulimit -t "$1"',
	'ulimit -v "$2"',
	"shift 2",
	'exec "$@"',
].join("; ");

const SAFE_ENV_KEYS = [
	"PATH",
	"LANG",
	"LC_ALL",
	"TZ",
	"NODE_ENV",
	"NF_PLUGIN_RUNTIME_ID",
	"NF_PLUGIN_GENERATION",
	"NF_PLUGIN_RPC_PROTOCOL",
	"NF_PLUGIN_PACKAGE_DIR",
	"NF_PLUGIN_DATA_DIR",
	"NF_PLUGIN_TEMP_DIR",
	"NF_PLUGIN_LOG_DIR",
] as const;

export type RuntimeState =
	| "starting"
	| "handshaking"
	| "active"
	| "draining"
	| "stopped"
	| "crashed"
	| "failed"
	| "quarantine";

export type RuntimeTimeoutKind = "spawn" | "idle" | "total" | "handshake" | "activation" | "rpc";

export class PluginRuntimeError extends Error {
	readonly code: string;
	readonly phase?: string;
	readonly retryable: boolean;
	readonly kind:
		| "spawn"
		| "transport"
		| "protocol"
		| "timeout"
		| "cancelled"
		| "handshake"
		| "shutdown";

	constructor(
		message: string,
		options: {
			code?: string;
			phase?: string;
			retryable?: boolean;
			kind?: PluginRuntimeError["kind"];
			cause?: unknown;
		} = {},
	) {
		super(message, { cause: options.cause });
		this.name = "PluginRuntimeError";
		this.code = options.code ?? "RUNTIME_ERROR";
		this.phase = options.phase;
		this.retryable = options.retryable ?? false;
		this.kind = options.kind ?? "transport";
	}
}

export class ContentLengthFrameError extends Error {
	readonly code:
		| "header_too_large"
		| "missing_content_length"
		| "invalid_header"
		| "invalid_content_length"
		| "body_too_large"
		| "invalid_utf8"
		| "invalid_json"
		| "batch_not_allowed"
		| "invalid_json_rpc"
		| "incomplete_frame";

	constructor(code: ContentLengthFrameError["code"], message: string, cause?: unknown) {
		super(message, { cause });
		this.name = "ContentLengthFrameError";
		this.code = code;
	}
}

export interface ContentLengthFrameParserOptions {
	maxHeaderBytes?: number;
	maxBodyBytes?: number;
}

/** Incremental Content-Length parser for one-object JSON-RPC 2.0 frames. */
export class ContentLengthFrameParser {
	private readonly maxHeaderBytes: number;
	private readonly maxBodyBytes: number;
	private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

	constructor(options: ContentLengthFrameParserOptions = {}) {
		this.maxHeaderBytes = options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
		this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_FRAME_BYTES;
		if (!Number.isSafeInteger(this.maxHeaderBytes) || this.maxHeaderBytes <= 0) {
			throw new RangeError("maxHeaderBytes must be a positive safe integer");
		}
		if (!Number.isSafeInteger(this.maxBodyBytes) || this.maxBodyBytes <= 0) {
			throw new RangeError("maxBodyBytes must be a positive safe integer");
		}
	}

	feed(chunk: Uint8Array): JsonRpcEnvelope[] {
		if (!(chunk instanceof Uint8Array)) {
			throw new TypeError("ContentLengthFrameParser.feed expects Uint8Array");
		}
		if (chunk.byteLength === 0) return [];
		this.buffer = concatBytes(this.buffer, chunk);
		const envelopes: JsonRpcEnvelope[] = [];

		while (true) {
			const delimiter = findBytes(this.buffer, Uint8Array.of(13, 10, 13, 10));
			if (delimiter < 0) {
				if (this.buffer[0] === 0x7b || this.buffer[0] === 0x5b) {
					throw new ContentLengthFrameError(
						"missing_content_length",
						"RPC body arrived without a Content-Length header",
					);
				}
				const lineEnd = this.buffer.indexOf(10);
				if (lineEnd >= 0) {
					const firstLine = decodeUtf8(this.buffer.slice(0, lineEnd), "invalid_utf8").replace(
						/\r$/,
						"",
					);
					if (!/^[A-Za-z0-9-]+\s*:/.test(firstLine)) {
						throw new ContentLengthFrameError(
							"invalid_header",
							"RPC stream does not start with a valid header",
						);
					}
				}
				if (this.buffer.byteLength > this.maxHeaderBytes) {
					throw new ContentLengthFrameError(
						"header_too_large",
						`RPC header exceeds ${this.maxHeaderBytes} bytes`,
					);
				}
				break;
			}
			if (delimiter > this.maxHeaderBytes) {
				throw new ContentLengthFrameError(
					"header_too_large",
					`RPC header exceeds ${this.maxHeaderBytes} bytes`,
				);
			}

			const headerBytes = this.buffer.slice(0, delimiter);
			const headerText = decodeUtf8(headerBytes, "invalid_utf8");
			const contentLength = parseContentLength(headerText);
			if (contentLength > this.maxBodyBytes) {
				throw new ContentLengthFrameError(
					"body_too_large",
					`RPC body exceeds ${this.maxBodyBytes} bytes`,
				);
			}

			const bodyStart = delimiter + 4;
			const frameEnd = bodyStart + contentLength;
			if (this.buffer.byteLength < frameEnd) break;

			const bodyBytes = this.buffer.slice(bodyStart, frameEnd);
			this.buffer = this.buffer.slice(frameEnd);
			const bodyText = decodeUtf8(bodyBytes, "invalid_utf8");
			envelopes.push(parseEnvelope(bodyText));
		}

		return envelopes;
	}

	/** Finish the stream and reject a partial header or body. */
	end(): void {
		if (this.buffer.byteLength !== 0) {
			throw new ContentLengthFrameError(
				"incomplete_frame",
				"RPC stream ended with an incomplete frame",
			);
		}
	}

	finish(): void {
		this.end();
	}

	reset(): void {
		this.buffer = new Uint8Array(0);
	}
}

function concatBytes(
	left: Uint8Array<ArrayBufferLike>,
	right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
	const result = new Uint8Array(left.byteLength + right.byteLength);
	result.set(left, 0);
	result.set(right, left.byteLength);
	return result;
}

function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
	outer: for (let index = 0; index <= haystack.length - needle.length; index++) {
		for (let offset = 0; offset < needle.length; offset++) {
			if (haystack[index + offset] !== needle[offset]) continue outer;
		}
		return index;
	}
	return -1;
}

function decodeUtf8(bytes: Uint8Array, code: ContentLengthFrameError["code"]): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new ContentLengthFrameError(code, "RPC frame contains invalid UTF-8", error);
	}
}

function parseContentLength(header: string): number {
	const lines = header.split("\r\n");
	let contentLength: number | undefined;
	for (const line of lines) {
		const separator = line.indexOf(":");
		if (separator <= 0) {
			throw new ContentLengthFrameError("invalid_header", "RPC header contains an invalid line");
		}
		const name = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();
		if (!name || !value) {
			throw new ContentLengthFrameError(
				"invalid_header",
				"RPC header contains an empty name or value",
			);
		}
		if (name !== "content-length") continue;
		if (contentLength !== undefined) {
			throw new ContentLengthFrameError(
				"invalid_content_length",
				"RPC frame has duplicate Content-Length headers",
			);
		}
		if (!/^\d+$/.test(value)) {
			throw new ContentLengthFrameError(
				"invalid_content_length",
				"Content-Length must be a decimal byte length",
			);
		}
		const parsed = Number(value);
		if (!Number.isSafeInteger(parsed)) {
			throw new ContentLengthFrameError(
				"invalid_content_length",
				"Content-Length is outside the safe integer range",
			);
		}
		contentLength = parsed;
	}
	if (contentLength === undefined) {
		throw new ContentLengthFrameError(
			"missing_content_length",
			"RPC frame is missing Content-Length",
		);
	}
	return contentLength;
}

function parseEnvelope(body: string): JsonRpcEnvelope {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch (error) {
		throw new ContentLengthFrameError("invalid_json", "RPC frame contains invalid JSON", error);
	}
	if (Array.isArray(parsed)) {
		throw new ContentLengthFrameError(
			"batch_not_allowed",
			"JSON-RPC batch messages are not supported",
		);
	}
	const result = jsonRpcEnvelopeSchema.safeParse(parsed);
	if (!result.success) {
		throw new ContentLengthFrameError(
			"invalid_json_rpc",
			"RPC frame is not a controlled JSON-RPC envelope",
			result.error,
		);
	}
	return result.data;
}

export function encodeContentLengthFrame(envelope: JsonRpcEnvelope): Uint8Array {
	const result = jsonRpcEnvelopeSchema.safeParse(envelope);
	if (!result.success) {
		throw new TypeError("Cannot encode an invalid JSON-RPC envelope");
	}
	const body = textEncoder.encode(JSON.stringify(result.data));
	const header = textEncoder.encode(
		`Content-Length: ${body.byteLength}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n`,
	);
	return concatBytes(header, body);
}

export interface RunnerProcess {
	pid?: number;
	stdin: unknown;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill?: () => void;
}

export interface RunnerSpawnOptions {
	cwd: string;
	env: Record<string, string>;
	stdin: "pipe";
	stdout: "pipe";
	stderr: "pipe";
}

export type PluginProcessSpawner = (
	command: string[],
	options: RunnerSpawnOptions,
) => RunnerProcess | Promise<RunnerProcess>;

export interface RunnerStartOptions {
	command: string[];
	cwd: string;
	env?: Record<string, string | undefined>;
	signal?: AbortSignal;
	generation?: number;
	onMessage?: (message: JsonRpcEnvelope) => void;
	onError?: (error: Error) => void;
	onExit?: (exitCode: number) => void;
	spawnTimeoutMs?: number;
	idleTimeoutMs?: number;
	totalTimeoutMs?: number;
	maxStderrBytes?: number;
	maxStderrBytesPerSecond?: number;
}

export interface PluginProcessHandle {
	readonly pid?: number;
	readonly exited: Promise<number>;
	send(message: JsonRpcEnvelope): Promise<void>;
	onMessage(handler: (message: JsonRpcEnvelope) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	onExit(handler: (exitCode: number) => void): () => void;
	getStderr(): string;
	kill(reason?: string): void;
	close(): Promise<void>;
}

export interface LocalProcessResourceLimits {
	/** Hard CPU time budget in seconds on POSIX hosts (not a CPU-core quota). */
	cpuTimeSeconds: number;
	/** Hard virtual address-space budget in bytes on POSIX hosts. */
	memoryBytes: number;
}

export interface LocalProcessRunnerOptions extends ContentLengthFrameParserOptions {
	spawn?: PluginProcessSpawner;
	allowedCwdRoots?: string[];
	allowedCwds?: string[];
	envAllowlist?: readonly string[];
	maxStdoutBytes?: number;
	stderrRingBytes?: number;
	maxStderrBytes?: number;
	maxStderrBytesPerSecond?: number;
	spawnTimeoutMs?: number;
	idleTimeoutMs?: number;
	totalTimeoutMs?: number;
	killProcessTree?: boolean;
	/** Override the default hard limits for this local process. */
	resourceLimits?: Partial<LocalProcessResourceLimits>;
	/** Explicit escape hatch for trusted, externally sandboxed processes only. */
	allowUnboundedResourceUsage?: boolean;
	/** @internal deterministic platform hook for tests. */
	platform?: NodeJS.Platform;
}

/**
 * A streaming stdio process runner. It deliberately does not use safeSpawn:
 * stdout remains a live framed RPC stream rather than a collected string.
 */
export class LocalProcessRunner {
	private readonly options: LocalProcessRunnerOptions;

	constructor(options: LocalProcessRunnerOptions = {}) {
		this.options = options;
	}

	async start(options: RunnerStartOptions): Promise<PluginProcessHandle> {
		validateCommand(options.command);
		validateCwd(options.cwd, this.options.allowedCwdRoots, this.options.allowedCwds);
		if (options.signal?.aborted) throw createAbortError(options.signal.reason);

		const env = filterEnvironment(options.env, this.options.envAllowlist ?? SAFE_ENV_KEYS);
		const spawnOptions: RunnerSpawnOptions = {
			cwd: resolve(options.cwd),
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		};
		const platform = this.options.platform ?? globalThis.process.platform;
		const allowUnboundedResourceUsage = this.options.allowUnboundedResourceUsage ?? false;
		if (allowUnboundedResourceUsage) {
			logger.warn("local plugin runtime is running without host resource limits", { platform });
		}
		const command = buildLocalProcessCommand(
			options.command,
			this.options.resourceLimits,
			platform,
			allowUnboundedResourceUsage,
		);
		const spawn = this.options.spawn ?? defaultSpawner;
		const process = await spawnWithTimeout(
			() => spawn(command, spawnOptions),
			options.spawnTimeoutMs ?? this.options.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS,
		);
		return new LocalProcessHandleImpl(process, {
			...this.options,
			...options,
			idleTimeoutMs: options.idleTimeoutMs ?? this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
			totalTimeoutMs:
				options.totalTimeoutMs ?? this.options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
			maxBodyBytes: this.options.maxBodyBytes ?? DEFAULT_MAX_FRAME_BYTES,
			maxStdoutBytes: this.options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES,
			stderrRingBytes: this.options.stderrRingBytes ?? DEFAULT_STDERR_RING_BYTES,
			maxStderrBytes:
				options.maxStderrBytes ?? this.options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
			maxStderrBytesPerSecond:
				options.maxStderrBytesPerSecond ??
				this.options.maxStderrBytesPerSecond ??
				DEFAULT_MAX_STDERR_BYTES_PER_SECOND,
			killProcessTree: this.options.killProcessTree ?? true,
		});
	}
}

interface LocalProcessHandleOptions extends RunnerStartOptions {
	maxStdoutBytes: number;
	stderrRingBytes: number;
	maxStderrBytes: number;
	maxStderrBytesPerSecond: number;
	killProcessTree: boolean;
	maxHeaderBytes?: number;
	maxBodyBytes?: number;
}

class LocalProcessHandleImpl implements PluginProcessHandle {
	readonly pid?: number;
	readonly exited: Promise<number>;
	private readonly process: RunnerProcess;
	private readonly options: LocalProcessHandleOptions;
	private readonly parser: ContentLengthFrameParser;
	private readonly stderrRing: ByteRingBuffer;
	private readonly messageHandlers = new Set<(message: JsonRpcEnvelope) => void>();
	private readonly errorHandlers = new Set<(error: Error) => void>();
	private readonly exitHandlers = new Set<(exitCode: number) => void>();
	private readonly queuedMessages: JsonRpcEnvelope[] = [];
	private readonly queuedErrors: Error[] = [];
	private exitCode: number | undefined;
	private writeQueue: Promise<void> = Promise.resolve();
	private stdoutBytes = 0;
	private stderrBytes = 0;
	private stderrWindowStartedAt = Date.now();
	private stderrWindowBytes = 0;
	private closed = false;
	private killed = false;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private totalTimer: ReturnType<typeof setTimeout> | undefined;
	constructor(process: RunnerProcess, options: LocalProcessHandleOptions) {
		this.process = process;
		this.options = options;
		this.pid = process.pid;
		this.parser = new ContentLengthFrameParser({
			maxHeaderBytes: options.maxHeaderBytes,
			maxBodyBytes: options.maxBodyBytes,
		});
		if (!Number.isSafeInteger(options.maxStderrBytes) || options.maxStderrBytes <= 0)
			throw new RangeError("maxStderrBytes must be a positive safe integer");
		if (
			!Number.isSafeInteger(options.maxStderrBytesPerSecond) ||
			options.maxStderrBytesPerSecond <= 0
		)
			throw new RangeError("maxStderrBytesPerSecond must be a positive safe integer");
		this.stderrRing = new ByteRingBuffer(options.stderrRingBytes);
		this.exited = process.exited.then((exitCode) => {
			this.clearTimers();
			this.closed = true;
			this.exitCode = exitCode;
			for (const handler of this.exitHandlers) handler(exitCode);
			options.onExit?.(exitCode);
			return exitCode;
		});

		void this.readStdout();
		void this.readStderr();
		if (options.idleTimeoutMs && options.idleTimeoutMs > 0) this.resetIdleTimer();
		if (options.totalTimeoutMs && options.totalTimeoutMs > 0) {
			this.totalTimer = setTimeout(() => this.timeout("total"), options.totalTimeoutMs);
		}
		if (options.signal) {
			const abort = () => this.kill("aborted");
			if (options.signal.aborted) abort();
			else options.signal.addEventListener("abort", abort, { once: true });
			void this.exited.finally(() => options.signal?.removeEventListener("abort", abort));
		}
	}

	send(message: JsonRpcEnvelope): Promise<void> {
		if (this.closed || this.killed) {
			return Promise.reject(
				new PluginRuntimeError("Plugin process is not writable", {
					code: "PROCESS_CLOSED",
					kind: "transport",
				}),
			);
		}
		const bodyBytes = textEncoder.encode(JSON.stringify(message));
		if (
			this.options.maxBodyBytes !== undefined &&
			bodyBytes.byteLength > this.options.maxBodyBytes
		) {
			return Promise.reject(
				new PluginRuntimeError("Outbound RPC frame exceeded the body limit", {
					code: "OUTBOUND_FRAME_LIMIT",
					phase: "stdin",
					kind: "protocol",
				}),
			);
		}
		const frame = encodeContentLengthFrame(message);
		this.writeQueue = this.writeQueue.then(async () => {
			const writer = this.process.stdin as {
				write?: (data: Uint8Array) => number | Promise<number> | undefined;
				flush?: () => void | Promise<void>;
			};
			if (typeof writer.write !== "function")
				throw new Error("Plugin process stdin is not writable");
			await writer.write(frame);
			if (typeof writer.flush === "function") await writer.flush();
		});
		return this.writeQueue;
	}

	onMessage(handler: (message: JsonRpcEnvelope) => void): () => void {
		this.messageHandlers.add(handler);
		while (this.queuedMessages.length > 0) handler(this.queuedMessages.shift() as JsonRpcEnvelope);
		return () => this.messageHandlers.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.errorHandlers.add(handler);
		while (this.queuedErrors.length > 0) handler(this.queuedErrors.shift() as Error);
		return () => this.errorHandlers.delete(handler);
	}

	onExit(handler: (exitCode: number) => void): () => void {
		if (this.exitCode !== undefined) {
			handler(this.exitCode);
			return () => undefined;
		}
		this.exitHandlers.add(handler);
		return () => this.exitHandlers.delete(handler);
	}

	getStderr(): string {
		return this.stderrRing.toString();
	}

	kill(reason = "killed"): void {
		if (this.killed || this.closed) return;
		this.killed = true;
		this.clearTimers();
		killProcessTree(this.process, this.options.killProcessTree);
		logger.debug("plugin runtime process killed", { pid: this.pid, reason });
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.clearTimers();
		const writer = this.process.stdin as { end?: () => void | Promise<void> };
		try {
			if (typeof writer.end === "function") await writer.end();
		} catch {
			// A pipe can already be closed when a plugin exits.
		}
	}

	private async readStdout(): Promise<void> {
		const reader = this.process.stdout.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					this.parser.end();
					return;
				}
				this.stdoutBytes += value.byteLength;
				if (this.stdoutBytes > this.options.maxStdoutBytes) {
					throw new PluginRuntimeError("Plugin stdout exceeded the runtime output limit", {
						code: "STDOUT_LIMIT",
						phase: "stdout",
						kind: "protocol",
					});
				}
				this.touchActivity();
				for (const message of this.parser.feed(value)) this.emitMessage(message);
			}
		} catch (error) {
			this.emitError(asError(error));
			this.kill("stdout protocol failure");
		} finally {
			reader.releaseLock();
		}
	}

	private async readStderr(): Promise<void> {
		const reader = this.process.stderr.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) return;
				const now = Date.now();
				if (now - this.stderrWindowStartedAt >= 1_000) {
					this.stderrWindowStartedAt = now;
					this.stderrWindowBytes = 0;
				}
				this.stderrBytes += value.byteLength;
				this.stderrWindowBytes += value.byteLength;
				this.stderrRing.append(value);
				if (this.stderrBytes > this.options.maxStderrBytes) {
					throw new PluginRuntimeError("Plugin stderr exceeded the runtime output limit", {
						code: "STDERR_LIMIT",
						phase: "stderr",
						kind: "protocol",
					});
				}
				if (this.stderrWindowBytes > this.options.maxStderrBytesPerSecond) {
					throw new PluginRuntimeError("Plugin stderr exceeded the runtime rate limit", {
						code: "STDERR_RATE_LIMIT",
						phase: "stderr",
						kind: "protocol",
					});
				}
				this.touchActivity();
			}
		} catch (error) {
			const runtimeError = asError(error);
			this.emitError(runtimeError);
			if (runtimeError instanceof PluginRuntimeError) this.kill("stderr limit exceeded");
		} finally {
			reader.releaseLock();
		}
	}

	private emitMessage(message: JsonRpcEnvelope): void {
		if (this.messageHandlers.size === 0) {
			if (this.queuedMessages.length < 64) this.queuedMessages.push(message);
			return;
		}
		for (const handler of this.messageHandlers) handler(message);
	}

	private emitError(error: Error): void {
		if (this.errorHandlers.size === 0 && !this.options.onError) {
			if (this.queuedErrors.length < 16) this.queuedErrors.push(error);
			return;
		}
		for (const handler of this.errorHandlers) handler(error);
		this.options.onError?.(error);
	}

	private touchActivity(): void {
		if (this.options.idleTimeoutMs && this.options.idleTimeoutMs > 0) this.resetIdleTimer();
	}

	private resetIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => this.timeout("idle"), this.options.idleTimeoutMs);
	}

	private timeout(kind: "idle" | "total"): void {
		if (this.closed || this.killed) return;
		const error = new PluginRuntimeError(`Plugin runtime ${kind} timeout`, {
			code: `${kind.toUpperCase()}_TIMEOUT`,
			phase: kind,
			kind: "timeout",
			retryable: true,
		});
		this.emitError(error);
		this.kill(`${kind} timeout`);
	}

	private clearTimers(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (this.totalTimer) clearTimeout(this.totalTimer);
		this.idleTimer = undefined;
		this.totalTimer = undefined;
	}
}

class ByteRingBuffer {
	private readonly bytes: Uint8Array;
	private start = 0;
	private length = 0;

	constructor(private readonly capacity: number) {
		if (!Number.isSafeInteger(capacity) || capacity <= 0)
			throw new RangeError("ring capacity must be positive");
		this.bytes = new Uint8Array(capacity);
	}

	append(chunk: Uint8Array): void {
		if (chunk.byteLength >= this.capacity) {
			this.bytes.set(chunk.slice(chunk.byteLength - this.capacity));
			this.start = 0;
			this.length = this.capacity;
			return;
		}
		for (const byte of chunk) {
			const index = (this.start + this.length) % this.capacity;
			this.bytes[index] = byte;
			if (this.length < this.capacity) this.length++;
			else this.start = (this.start + 1) % this.capacity;
		}
	}

	toString(): string {
		const result = new Uint8Array(this.length);
		for (let index = 0; index < this.length; index++) {
			result[index] = this.bytes[(this.start + index) % this.capacity];
		}
		return new TextDecoder().decode(result);
	}
}

function normalizeLocalProcessResourceLimits(
	limits: Partial<LocalProcessResourceLimits> | undefined,
): LocalProcessResourceLimits {
	const cpuTimeSeconds = limits?.cpuTimeSeconds ?? DEFAULT_LOCAL_CPU_TIME_SECONDS;
	const memoryBytes = limits?.memoryBytes ?? DEFAULT_LOCAL_MEMORY_BYTES;
	if (!Number.isSafeInteger(cpuTimeSeconds) || cpuTimeSeconds <= 0) {
		throw new RangeError("cpuTimeSeconds must be a positive safe integer");
	}
	if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 1024) {
		throw new RangeError("memoryBytes must be a safe integer of at least 1024 bytes");
	}
	return { cpuTimeSeconds, memoryBytes };
}

/**
 * Build the command used for a local plugin process.
 *
 * POSIX hosts use /bin/sh only as an exec-preserving rlimit setup shim. Windows
 * has no equivalent in Bun.spawn, so the default is to reject the launch rather
 * than silently run an unbounded local process. Callers that already provide an
 * external sandbox must opt into allowUnboundedResourceUsage explicitly.
 */
export function buildLocalProcessCommand(
	command: string[],
	limits?: Partial<LocalProcessResourceLimits>,
	platform: NodeJS.Platform = globalThis.process.platform,
	allowUnboundedResourceUsage = false,
): string[] {
	validateCommand(command);
	if (allowUnboundedResourceUsage) return [...command];
	const resourceLimits = normalizeLocalProcessResourceLimits(limits);
	if (platform === "win32") {
		throw new PluginRuntimeError(
			"Local plugin process resource limits are unavailable on win32; use an external sandbox or explicitly allow unbounded execution",
			{
				code: "RESOURCE_LIMITS_UNAVAILABLE",
				phase: "spawn",
				kind: "spawn",
			},
		);
	}
	return [
		POSIX_RESOURCE_LIMIT_SHELL,
		"-c",
		POSIX_RESOURCE_LIMIT_SCRIPT,
		"narrafork-resource-limit",
		String(resourceLimits.cpuTimeSeconds),
		String(Math.ceil(resourceLimits.memoryBytes / 1024)),
		...command,
	];
}

function validateCommand(command: string[]): void {
	if (
		!Array.isArray(command) ||
		command.length === 0 ||
		command.some((part) => typeof part !== "string" || !part)
	) {
		throw new PluginRuntimeError("Plugin command must be a non-empty argument array", {
			code: "INVALID_COMMAND",
			kind: "spawn",
		});
	}
}

function validateCwd(cwd: string, roots?: string[], allowedCwds?: string[]): void {
	if (typeof cwd !== "string" || !cwd || !isAbsolute(cwd)) {
		throw new PluginRuntimeError("Plugin cwd must be an absolute path", {
			code: "INVALID_CWD",
			kind: "spawn",
		});
	}
	const resolved = resolve(cwd);
	if (allowedCwds?.length && !allowedCwds.some((allowed) => resolve(allowed) === resolved)) {
		throw new PluginRuntimeError("Plugin cwd is not in the allowed cwd set", {
			code: "CWD_NOT_ALLOWED",
			kind: "spawn",
		});
	}
	if (roots?.length && !roots.some((root) => isContained(resolve(root), resolved))) {
		throw new PluginRuntimeError("Plugin cwd is outside the allowed cwd roots", {
			code: "CWD_NOT_ALLOWED",
			kind: "spawn",
		});
	}
}

function isContained(root: string, candidate: string): boolean {
	const remainder = relative(root, candidate);
	return remainder === "" || (remainder !== ".." && !remainder.startsWith(".."));
}

function filterEnvironment(
	provided: Record<string, string | undefined> | undefined,
	allowlist: readonly string[],
): Record<string, string> {
	const source = { ...process.env, ...provided };
	const result: Record<string, string> = {};
	for (const key of allowlist) {
		const value = source[key];
		if (typeof value === "string") result[key] = value;
	}
	return result;
}

async function spawnWithTimeout(
	spawn: () => RunnerProcess | Promise<RunnerProcess>,
	timeoutMs: number,
): Promise<RunnerProcess> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	const spawnPromise = Promise.resolve().then(spawn);
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			timedOut = true;
			reject(
				new PluginRuntimeError("Plugin process spawn timed out", {
					code: "SPAWN_TIMEOUT",
					phase: "spawn",
					kind: "timeout",
					retryable: true,
				}),
			);
		}, timeoutMs);
	});
	try {
		const process = await Promise.race([spawnPromise, timeout]);
		if (timedOut) {
			process.kill?.();
			throw new PluginRuntimeError("Plugin process spawn timed out", {
				code: "SPAWN_TIMEOUT",
				phase: "spawn",
				kind: "timeout",
			});
		}
		return process;
	} finally {
		if (timer) clearTimeout(timer);
		void spawnPromise.then((process) => {
			if (timedOut) process.kill?.();
		});
	}
}

function defaultSpawner(command: string[], options: RunnerSpawnOptions): RunnerProcess {
	const process = Bun.spawn(command, options);
	return {
		pid: process.pid,
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
		exited: process.exited,
		kill: () => process.kill(),
	};
}

function killProcessTree(childProcess: RunnerProcess, enabled: boolean): void {
	if (!enabled) {
		childProcess.kill?.();
		return;
	}
	const pid = childProcess.pid;
	if (pid) {
		if (globalThis.process.platform === "win32") {
			void runCleanupCommand(["taskkill", "/T", "/F", "/PID", String(pid)]);
		} else {
			void killUnixProcessTree(pid);
		}
	}
	// Always terminate the directly managed process immediately. Tree cleanup is
	// intentionally asynchronous so a slow OS utility cannot block the event loop.
	childProcess.kill?.();
}

async function killUnixProcessTree(pid: number): Promise<void> {
	for (const childPid of await getChildPids(pid)) {
		await killUnixProcessTree(childPid);
		try {
			globalThis.process.kill(childPid, "SIGTERM");
		} catch {
			// The child may already have exited.
		}
	}
}

async function runCleanupCommand(command: string[]): Promise<void> {
	let cleanupProcess: ReturnType<typeof Bun.spawn> | undefined;
	try {
		cleanupProcess = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		await promiseWithTimeout(cleanupProcess.exited, 1_000);
	} catch {
		cleanupProcess?.kill();
	}
}

async function getChildPids(pid: number): Promise<number[]> {
	let process: ReturnType<typeof Bun.spawn> | undefined;
	try {
		process = Bun.spawn(["pgrep", "-P", String(pid)], {
			stdout: "pipe",
			stderr: "ignore",
		});
		if (typeof process.stdout === "number" || process.stdout === undefined) {
			process.kill();
			return [];
		}
		const outputPromise = readLimitedProcessOutput(process.stdout, 64 * 1024, process);
		const exitCode = await promiseWithTimeout(process.exited, 1_000);
		if (exitCode !== 0) return [];
		return (await outputPromise)
			.split(/\s+/)
			.map((value) => Number.parseInt(value, 10))
			.filter((value) => Number.isInteger(value) && value > 0);
	} catch {
		process?.kill();
		return [];
	}
}

async function readLimitedProcessOutput(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
	process: { kill: () => void },
): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				process.kill();
				return "";
			}
			chunks.push(value);
		}
		const output = new Uint8Array(totalBytes);
		let offset = 0;
		for (const chunk of chunks) {
			output.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return new TextDecoder().decode(output);
	} finally {
		reader.releaseLock();
	}
}

export interface RuntimeTimeouts {
	handshakeMs: number;
	activationMs: number;
	rpcMs: number;
	drainMs: number;
	shutdownMs: number;
	cancelGraceMs: number;
}

export interface PluginRuntimeOptions {
	pluginId: string;
	pluginVersion?: string;
	version?: string;
	packageDigest?: string;
	command: string[];
	cwd: string;
	env?: Record<string, string | undefined>;
	runtimeId?: string;
	generation?: number;
	rpcProtocol?: string;
	hostApiVersion?: string;
	grantedCapabilities?: readonly string[];
	activationReason?: string;
	runner?: LocalProcessRunner | PluginRunner;
	runnerOptions?: LocalProcessRunnerOptions;
	healthRegistry?: PluginHealthRegistry;
	timeouts?: Partial<RuntimeTimeouts>;
	idleTimeoutMs?: number;
	totalTimeoutMs?: number;
	maxInFlight?: number;
	onStateChange?: (state: RuntimeState, previous: RuntimeState | undefined) => void;
	onCrash?: (error: Error) => void;
}

export interface PluginRunner {
	start(options: RunnerStartOptions): Promise<PluginProcessHandle>;
}

interface PendingRequest {
	resolve: (value: JsonRpcResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	signal?: AbortSignal;
	removeAbort?: () => void;
}

interface MessageWaiter {
	predicate: (message: JsonRpcEnvelope) => boolean;
	resolve: (message: JsonRpcEnvelope) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface RuntimeDiagnostics {
	pluginId: string;
	pluginVersion?: string;
	runtimeId: string;
	generation: number;
	state: RuntimeState;
	pid?: number;
	inFlight: number;
	capabilities: string[];
	stderr: string;
	lastError?: { code?: string; message: string; phase?: string };
	lateMessages: number;
	startedAt?: string;
	stoppedAt?: string;
}

/** One plugin process and its generation-bound RPC request registry. */
export class PluginRuntime {
	readonly pluginId: string;
	readonly pluginVersion?: string;
	readonly runtimeId: string;
	private readonly options: PluginRuntimeOptions;
	private readonly runner: PluginRunner;
	private readonly healthRegistry: PluginHealthRegistry;
	private readonly healthBreaker: ReturnType<PluginHealthRegistry["get"]>;
	private readonly timeouts: RuntimeTimeouts;
	private _generation: number;
	private _state: RuntimeState = "stopped";
	private handle?: PluginProcessHandle;
	private unsubscribeMessage?: () => void;
	private unsubscribeError?: () => void;
	private unsubscribeExit?: () => void;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly waiters = new Set<MessageWaiter>();
	private readonly writeMutex = new AsyncMutex();
	private acceptingRequests = false;
	private lastError?: PluginRuntimeError;
	private lateMessages = 0;
	private startedAt?: string;
	private stoppedAt?: string;

	constructor(options: PluginRuntimeOptions) {
		this.pluginId = options.pluginId;
		this.pluginVersion = options.pluginVersion ?? options.version;
		this.runtimeId = options.runtimeId ?? `rt_${generateId(12)}`;
		this._generation = options.generation ?? 0;
		this.options = options;
		this.healthRegistry = options.healthRegistry ?? pluginHealthRegistry;
		this.healthBreaker = this.healthRegistry.get(this.pluginId, undefined, "runtime");
		this.timeouts = {
			handshakeMs: options.timeouts?.handshakeMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
			activationMs: options.timeouts?.activationMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS,
			rpcMs: options.timeouts?.rpcMs ?? DEFAULT_RPC_TIMEOUT_MS,
			drainMs: options.timeouts?.drainMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
			shutdownMs: options.timeouts?.shutdownMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
			cancelGraceMs: options.timeouts?.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS,
		};
		this.runner = options.runner ?? new LocalProcessRunner(options.runnerOptions);
	}

	get state(): RuntimeState {
		return this._state;
	}

	get generation(): number {
		return this._generation;
	}

	get pid(): number | undefined {
		return this.handle?.pid;
	}

	async start(signal?: AbortSignal): Promise<void> {
		if (this._state === "active") return;
		if (this._state === "starting" || this._state === "handshaking") {
			throw new PluginRuntimeError("Plugin runtime is already starting", {
				code: "ALREADY_STARTING",
				kind: "transport",
			});
		}
		if (this._state === "quarantine") {
			throw new PluginRuntimeError("Plugin runtime is quarantined", {
				code: "QUARANTINED",
				kind: "handshake",
			});
		}
		this._generation += 1;
		const generation = this._generation;
		const operationStartedAt = Date.now();
		this.startedAt = new Date(operationStartedAt).toISOString();
		this.stoppedAt = undefined;
		this.acceptingRequests = false;
		this.setState("starting");
		try {
			const helloWait = this.waitForMessage(
				(message) => isNotification(message, "hello") || isRequest(message, "hello"),
				this.timeouts.handshakeMs,
				"hello",
			);
			this.handle = await this.runner.start({
				command: this.options.command,
				cwd: this.options.cwd,
				env: {
					...filterEnvironment(this.options.env, SAFE_ENV_KEYS),
					NF_PLUGIN_RUNTIME_ID: this.runtimeId,
					NF_PLUGIN_GENERATION: String(generation),
					NF_PLUGIN_RPC_PROTOCOL: this.options.rpcProtocol ?? NARRAFORK_RPC_PROTOCOL,
				},
				signal,
				generation,
				idleTimeoutMs: this.options.idleTimeoutMs,
				totalTimeoutMs: this.options.totalTimeoutMs,
			});
			this.unsubscribeMessage = this.handle.onMessage((message) =>
				this.handleMessage(message, generation),
			);
			this.unsubscribeError = this.handle.onError((error) =>
				this.handleProcessError(error, generation),
			);
			this.unsubscribeExit = this.handle.onExit((exitCode) =>
				this.handleProcessExit(exitCode, generation),
			);
			this.setState("handshaking");

			const hello = await helloWait;
			const helloParams = getParamsObject(hello);
			validateHello(helloParams, {
				pluginId: this.pluginId,
				version: this.pluginVersion,
				packageDigest: this.options.packageDigest,
				rpcProtocol: this.options.rpcProtocol ?? NARRAFORK_RPC_PROTOCOL,
			});
			if (isRequest(hello, "hello")) {
				await this.sendResponse(hello.id, {
					accepted: true,
					runtimeId: this.runtimeId,
					generation,
				});
			}

			await this.sendControlRequest(
				"initialize",
				{
					protocol: this.options.rpcProtocol ?? NARRAFORK_RPC_PROTOCOL,
					hostApiVersion: this.options.hostApiVersion ?? "1.0",
					pluginId: this.pluginId,
					runtimeId: this.runtimeId,
					generation,
					capabilities: [...(this.options.grantedCapabilities ?? [])],
					limits: {
						maxInboundFrameBytes: DEFAULT_MAX_FRAME_BYTES,
						maxInFlight: this.options.maxInFlight ?? 16,
					},
				},
				"initialized",
				this.timeouts.handshakeMs,
			);
			await this.sendControlRequest(
				"activate",
				{
					reason: this.options.activationReason ?? "runtime-start",
					runtimeId: this.runtimeId,
					generation,
				},
				"activated",
				this.timeouts.activationMs,
			);
			const health = await this.sendControlRequest(
				"health",
				{ runtimeId: this.runtimeId, generation },
				"healthy",
				this.timeouts.activationMs,
			);
			if (isUnhealthyResponse(health)) {
				throw new PluginRuntimeError("Plugin health check reported unhealthy", {
					code: "HEALTH_UNHEALTHY",
					phase: "health",
					kind: "handshake",
				});
			}
			this.acceptingRequests = true;
			this.setState("active");
			this.recordHealth({
				ok: true,
				durationMs: Date.now() - operationStartedAt,
				code: "STARTED",
			});
		} catch (error) {
			const runtimeError = normalizeRuntimeError(error, "handshake");
			this.recordHealth({
				ok: false,
				durationMs: Date.now() - operationStartedAt,
				code: runtimeError.code,
			});
			this.lastError = runtimeError;
			this.rejectAll(runtimeError);
			this.clearSubscriptions();
			this.handle?.kill("runtime start failed");
			if ((this._state as RuntimeState) !== "quarantine") {
				this.setState(
					runtimeError.kind === "protocol" || runtimeError.kind === "handshake"
						? "failed"
						: "crashed",
				);
			}
			throw runtimeError;
		}
	}

	async restart(signal?: AbortSignal): Promise<void> {
		if (this._state !== "stopped" && this._state !== "crashed" && this._state !== "failed") {
			await this.shutdown();
		}
		await this.start(signal);
	}

	async request<T = unknown>(
		method: string,
		params?: unknown,
		options: { signal?: AbortSignal; timeoutMs?: number } = {},
	): Promise<T> {
		if (!this.acceptingRequests || this._state !== "active") {
			throw new PluginRuntimeError("Plugin runtime is not active", {
				code: "RUNTIME_NOT_ACTIVE",
				kind: "transport",
				retryable: true,
			});
		}
		if (this.pending.size >= (this.options.maxInFlight ?? 16)) {
			throw new PluginRuntimeError("Plugin runtime request budget is exhausted", {
				code: "PLUGIN_BUSY",
				kind: "transport",
				retryable: true,
			});
		}
		const startedAt = Date.now();
		try {
			const response = await this.sendRequest(
				method,
				params,
				options.timeoutMs ?? this.timeouts.rpcMs,
				options.signal,
			);
			if ("error" in response) {
				throw new PluginRuntimeError(response.error.message, {
					code: String(response.error.code),
					phase: method,
					kind: "transport",
					retryable: response.error.code === -32009 || response.error.code === -32005,
				});
			}
			this.recordHealth({ ok: true, durationMs: Date.now() - startedAt, code: method });
			return response.result as T;
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw error;
			const runtimeError = normalizeRuntimeError(error, method);
			this.recordHealth({
				ok: false,
				durationMs: Date.now() - startedAt,
				code: runtimeError.code,
			});
			throw runtimeError;
		}
	}

	async notify(method: string, params?: unknown): Promise<void> {
		if (!this.handle || (!this.acceptingRequests && this._state !== "draining")) {
			throw new PluginRuntimeError("Plugin runtime is not writable", {
				code: "RUNTIME_NOT_WRITABLE",
				kind: "transport",
			});
		}
		await this.sendNotification(method, params);
	}

	async drain(timeoutMs = this.timeouts.drainMs): Promise<void> {
		if (this._state === "stopped") return;
		this.acceptingRequests = false;
		this.setState("draining");
		const deadline = Date.now() + timeoutMs;
		while (this.pending.size > 0 && Date.now() < deadline) {
			await new Promise((resolve) =>
				setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))),
			);
		}
		if (this.pending.size > 0) {
			await this.cancelInFlight("shutdown");
			await new Promise((resolve) => setTimeout(resolve, this.timeouts.cancelGraceMs));
		}
	}

	async shutdown(): Promise<void> {
		if (this._state === "stopped") return;
		await this.drain();
		const handle = this.handle;
		if (!handle) {
			this.setState("stopped");
			return;
		}
		try {
			await this.sendControlRequest(
				"deactivate",
				{ runtimeId: this.runtimeId, generation: this.generation },
				"deactivated",
				this.timeouts.shutdownMs,
			);
		} catch {
			// Shutdown remains fail-safe: the process is killed below.
		}
		try {
			await this.sendControlRequest(
				"shutdown",
				{ runtimeId: this.runtimeId, generation: this.generation },
				"shutdown",
				this.timeouts.shutdownMs,
			);
		} catch {
			// The process may have already crashed or not implement a response.
		}
		await handle.close();
		const exited = await promiseWithTimeout(handle.exited, this.timeouts.shutdownMs).catch(
			() => undefined,
		);
		if (exited === undefined) handle.kill("shutdown timeout");
		this.rejectAll(
			new PluginRuntimeError("Plugin runtime shut down", { code: "SHUTDOWN", kind: "shutdown" }),
		);
		this.clearSubscriptions();
		this.setState("stopped");
		this.stoppedAt = new Date().toISOString();
	}

	quarantine(reason: string): void {
		this.acceptingRequests = false;
		this.lastError = new PluginRuntimeError(reason, { code: "QUARANTINED", kind: "protocol" });
		this.handle?.kill("quarantine");
		this.rejectAll(this.lastError);
		this.setState("quarantine");
	}

	getDiagnostics(): RuntimeDiagnostics {
		return {
			pluginId: this.pluginId,
			pluginVersion: this.pluginVersion,
			runtimeId: this.runtimeId,
			generation: this.generation,
			state: this.state,
			pid: this.pid,
			inFlight: this.pending.size,
			capabilities: [...(this.options.grantedCapabilities ?? [])],
			stderr: this.handle?.getStderr() ?? "",
			lastError: this.lastError
				? {
						code: this.lastError.code,
						message: this.lastError.message,
						phase: this.lastError.phase,
					}
				: undefined,
			lateMessages: this.lateMessages,
			startedAt: this.startedAt,
			stoppedAt: this.stoppedAt,
		};
	}

	async startRunner(options: RunnerStartOptions): Promise<PluginProcessHandle> {
		return this.runner.start(options);
	}

	private async sendRequest(
		method: string,
		params: unknown,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<JsonRpcResponse> {
		const id = `rpc_${generateId(12)}`;
		const request: JsonRpcRequest = {
			jsonrpc: "2.0",
			id,
			method,
			...(params === undefined ? {} : { params: params as never }),
		};
		return new Promise<JsonRpcResponse>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				this.pending.delete(id);
				signal?.removeEventListener("abort", onAbort);
				void this.sendNotification("$/cancelRequest", { requestId: id, reason: "timeout" });
				reject(
					new PluginRuntimeError(`RPC request timed out: ${method}`, {
						code: "RPC_TIMEOUT",
						phase: method,
						kind: "timeout",
						retryable: true,
					}),
				);
			}, timeoutMs);
			const onAbort = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.pending.delete(id);
				void this.sendNotification("$/cancelRequest", { requestId: id, reason: "aborted" });
				reject(createAbortError(signal?.reason));
			};
			this.pending.set(id, {
				resolve,
				reject,
				timer,
				signal,
				removeAbort: signal ? () => signal.removeEventListener("abort", onAbort) : undefined,
			});
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			void this.writeSerialized(request).catch((error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.pending.delete(id);
				reject(asError(error));
			});
		});
	}

	private async sendControlRequest(
		method: string,
		params: unknown,
		notificationMethod: string,
		timeoutMs: number,
	): Promise<JsonRpcResponse | JsonRpcNotification> {
		const id = `rpc_${generateId(12)}`;
		const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params: params as never };
		const notificationWait = this.createWaiter(
			(message) => isNotification(message, notificationMethod),
			timeoutMs,
			notificationMethod,
		);
		const responseWait = this.sendRequestWithId(request, timeoutMs);
		try {
			return await Promise.race([responseWait, notificationWait.promise]);
		} finally {
			notificationWait.cancel();
			this.cancelPendingRequest(id);
		}
	}

	private cancelPendingRequest(id: string): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		clearTimeout(pending.timer);
		pending.removeAbort?.();
		this.pending.delete(id);
	}

	private sendRequestWithId(request: JsonRpcRequest, timeoutMs: number): Promise<JsonRpcResponse> {
		return new Promise<JsonRpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(String(request.id));
				reject(
					new PluginRuntimeError(`RPC request timed out: ${request.method}`, {
						code: "RPC_TIMEOUT",
						phase: request.method,
						kind: "timeout",
						retryable: true,
					}),
				);
			}, timeoutMs);
			this.pending.set(String(request.id), { resolve, reject, timer });
			void this.writeSerialized(request).catch((error) => {
				clearTimeout(timer);
				this.pending.delete(String(request.id));
				reject(asError(error));
			});
		});
	}

	private async sendResponse(id: string | number, result: unknown): Promise<void> {
		await this.writeSerialized({ jsonrpc: "2.0", id, result: result as never });
	}

	private async sendNotification(method: string, params?: unknown): Promise<void> {
		await this.writeSerialized({
			jsonrpc: "2.0",
			method,
			...(params === undefined ? {} : { params: params as never }),
		});
	}

	private async writeSerialized(message: JsonRpcEnvelope): Promise<void> {
		await this.writeMutex.acquire(this.runtimeId, async () => {
			if (!this.handle) throw new Error("Plugin process is not started");
			await this.handle.send(message);
		});
	}

	private waitForMessage(
		predicate: (message: JsonRpcEnvelope) => boolean,
		timeoutMs: number,
		label: string,
	): Promise<JsonRpcEnvelope> {
		return this.createWaiter(predicate, timeoutMs, label).promise;
	}

	private createWaiter(
		predicate: (message: JsonRpcEnvelope) => boolean,
		timeoutMs: number,
		label: string,
	): { promise: Promise<JsonRpcEnvelope>; cancel: () => void } {
		let waiter: MessageWaiter;
		const promise = new Promise<JsonRpcEnvelope>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(waiter);
				reject(
					new PluginRuntimeError(`Timed out waiting for ${label}`, {
						code: `${label.toUpperCase()}_TIMEOUT`,
						phase: label,
						kind: "timeout",
						retryable: true,
					}),
				);
			}, timeoutMs);
			waiter = { predicate, resolve, reject, timer };
			this.waiters.add(waiter);
		});
		return {
			promise,
			cancel: () => {
				if (!this.waiters.delete(waiter)) return;
				clearTimeout(waiter.timer);
			},
		};
	}

	private handleMessage(message: JsonRpcEnvelope, generation: number): void {
		if (
			generation !== this.generation ||
			(messageGeneration(message) !== undefined && messageGeneration(message) !== generation)
		) {
			this.lateMessages++;
			return;
		}
		if (isResponse(message)) {
			const pending = this.pending.get(String(message.id));
			if (pending) {
				this.pending.delete(String(message.id));
				clearTimeout(pending.timer);
				pending.removeAbort?.();
				if ("error" in message)
					pending.reject(
						new PluginRuntimeError(message.error.message, {
							code: String(message.error.code),
							phase: "rpc",
							kind: "transport",
						}),
					);
				else pending.resolve(message);
				return;
			}
		}
		for (const waiter of [...this.waiters]) {
			if (!waiter.predicate(message)) continue;
			this.waiters.delete(waiter);
			clearTimeout(waiter.timer);
			waiter.resolve(message);
		}
	}

	private handleProcessError(error: Error, generation: number): void {
		if (generation !== this.generation) return;
		this.lastError =
			error instanceof ContentLengthFrameError
				? new PluginRuntimeError(error.message, {
						code: error.code,
						phase: "stdout",
						kind: "protocol",
					})
				: normalizeRuntimeError(error, "transport");
		this.rejectAll(this.lastError);
		if (this._state !== "draining" && this._state !== "stopped") this.setState("failed");
	}

	private handleProcessExit(exitCode: number, generation: number): void {
		if (generation !== this.generation) {
			this.lateMessages++;
			return;
		}
		if (this._state === "draining" || this._state === "stopped" || this._state === "quarantine")
			return;
		const error = new PluginRuntimeError(`Plugin process exited with code ${exitCode}`, {
			code: "PROCESS_EXIT",
			kind: "transport",
			retryable: true,
		});
		this.lastError = error;
		this.rejectAll(error);
		this.acceptingRequests = false;
		this.clearSubscriptions();
		this.setState("crashed");
		this.options.onCrash?.(error);
	}

	private rejectAll(error: Error): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.removeAbort?.();
			pending.reject(pending.signal?.aborted ? createAbortError(pending.signal.reason) : error);
			this.pending.delete(id);
		}
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.waiters.clear();
	}

	private clearSubscriptions(): void {
		this.unsubscribeMessage?.();
		this.unsubscribeError?.();
		this.unsubscribeExit?.();
		this.unsubscribeMessage = undefined;
		this.unsubscribeError = undefined;
		this.unsubscribeExit = undefined;
	}

	private async cancelInFlight(reason: string): Promise<void> {
		if (this.pending.size === 0) return;
		await Promise.allSettled(
			[...this.pending.keys()].map((requestId) =>
				this.sendNotification("$/cancelRequest", { requestId, reason }),
			),
		);
	}

	private recordHealth(sample: Omit<PluginHealthSample, "at">): void {
		this.healthBreaker.record(sample);
	}

	private setState(state: RuntimeState): void {
		if (this._state === state) return;
		const previous = this._state;
		this._state = state;
		this.options.onStateChange?.(state, previous);
	}
}

export interface RuntimeSupervisorOptions {
	runtimeFactory?: (options: PluginRuntimeOptions) => PluginRuntime;
	maxRestarts?: number;
	restartWindowMs?: number;
	maxTotalRestarts?: number;
	totalRestartWindowMs?: number;
	restartBaseDelayMs?: number;
	restartMaxDelayMs?: number;
	restartJitterRatio?: number;
	random?: () => number;
}

interface RuntimeRecord {
	options: PluginRuntimeOptions;
	runtime: PluginRuntime;
	desiredEnabled: boolean;
	restarts: number[];
	totalRestarts: number[];
	restartTimer?: ReturnType<typeof setTimeout>;
	quarantineReason?: string;
}

/**
 * Supervises one or more PluginRuntime instances. It owns restart budgets and
 * quarantine policy; it does not grant capabilities or execute public APIs.
 */
export class RuntimeSupervisor {
	private readonly options: Required<RuntimeSupervisorOptions>;
	private readonly records = new Map<string, RuntimeRecord>();
	private readonly mutex = new AsyncMutex();

	constructor(options: RuntimeSupervisorOptions = {}) {
		this.options = {
			runtimeFactory:
				options.runtimeFactory ?? ((runtimeOptions) => new PluginRuntime(runtimeOptions)),
			maxRestarts: options.maxRestarts ?? DEFAULT_MAX_RESTARTS,
			restartWindowMs: options.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS,
			maxTotalRestarts: options.maxTotalRestarts ?? DEFAULT_MAX_TOTAL_RESTARTS,
			totalRestartWindowMs: options.totalRestartWindowMs ?? DEFAULT_TOTAL_RESTART_WINDOW_MS,
			restartBaseDelayMs: options.restartBaseDelayMs ?? DEFAULT_RESTART_BASE_DELAY_MS,
			restartMaxDelayMs: options.restartMaxDelayMs ?? DEFAULT_RESTART_MAX_DELAY_MS,
			restartJitterRatio: options.restartJitterRatio ?? 0.1,
			random: options.random ?? Math.random,
		};
	}

	register(options: PluginRuntimeOptions): PluginRuntime {
		const existing = this.records.get(options.pluginId);
		if (existing) return existing.runtime;
		const runtime = this.createRuntime(options);
		this.records.set(options.pluginId, {
			options,
			runtime,
			desiredEnabled: false,
			restarts: [],
			totalRestarts: [],
		});
		return runtime;
	}

	async start(options: PluginRuntimeOptions): Promise<PluginRuntime>;
	async start(pluginId: string, signal?: AbortSignal): Promise<PluginRuntime>;
	async start(
		optionsOrPluginId: PluginRuntimeOptions | string,
		signal?: AbortSignal,
	): Promise<PluginRuntime> {
		const pluginId =
			typeof optionsOrPluginId === "string" ? optionsOrPluginId : optionsOrPluginId.pluginId;
		let record = this.records.get(pluginId);
		if (!record && typeof optionsOrPluginId !== "string") {
			this.register(optionsOrPluginId);
			record = this.records.get(pluginId);
		}
		if (!record) throw new Error(`Runtime is not registered: ${pluginId}`);
		const runtimeRecord = record;
		return this.mutex.acquire(pluginId, async () => {
			if (runtimeRecord.quarantineReason) {
				throw new PluginRuntimeError(runtimeRecord.quarantineReason, {
					code: "QUARANTINED",
					kind: "protocol",
				});
			}
			runtimeRecord.desiredEnabled = true;
			if (runtimeRecord.restartTimer) {
				clearTimeout(runtimeRecord.restartTimer);
				runtimeRecord.restartTimer = undefined;
			}
			await runtimeRecord.runtime.start(signal);
			return runtimeRecord.runtime;
		});
	}

	async activate(
		optionsOrPluginId: PluginRuntimeOptions | string,
		signal?: AbortSignal,
	): Promise<PluginRuntime> {
		if (typeof optionsOrPluginId === "string") return this.start(optionsOrPluginId, signal);
		return this.start(optionsOrPluginId);
	}

	async disable(pluginId: string): Promise<void> {
		const record = this.records.get(pluginId);
		if (!record) return;
		await this.mutex.acquire(pluginId, async () => {
			record.desiredEnabled = false;
			if (record.restartTimer) clearTimeout(record.restartTimer);
			record.restartTimer = undefined;
			await record.runtime.shutdown();
		});
	}

	async drain(pluginId: string): Promise<void> {
		await this.records.get(pluginId)?.runtime.drain();
	}

	async shutdown(): Promise<void> {
		await Promise.all([...this.records.keys()].map((pluginId) => this.disable(pluginId)));
	}

	get(pluginId: string): PluginRuntime | undefined {
		return this.records.get(pluginId)?.runtime;
	}

	getDiagnostics(pluginId?: string): RuntimeDiagnostics[] {
		const records: RuntimeRecord[] = pluginId
			? [this.records.get(pluginId)].filter(
					(record): record is RuntimeRecord => record !== undefined,
				)
			: [...this.records.values()];
		return records.map((record) => record.runtime.getDiagnostics());
	}

	quarantine(pluginId: string, reason: string): void {
		const record = this.records.get(pluginId);
		if (!record) return;
		record.desiredEnabled = false;
		record.quarantineReason = reason;
		record.runtime.quarantine(reason);
	}

	private createRuntime(options: PluginRuntimeOptions): PluginRuntime {
		const userStateChange = options.onStateChange;
		const runtime = this.options.runtimeFactory({
			...options,
			onStateChange: (state, previous) => {
				userStateChange?.(state, previous);
				if (state === "crashed" || state === "failed")
					this.handleFailure(options.pluginId, runtime, state);
			},
		});
		return runtime;
	}

	private handleFailure(
		pluginId: string,
		runtime: PluginRuntime,
		state: "crashed" | "failed",
	): void {
		const record = this.records.get(pluginId);
		if (!record?.desiredEnabled || record.runtime !== runtime) return;
		const diagnostics = runtime.getDiagnostics();
		if (
			state === "failed" &&
			diagnostics.lastError?.code &&
			(diagnostics.lastError.phase === "stdout" ||
				diagnostics.lastError.code.startsWith("HELLO_") ||
				["STDOUT_LIMIT", "INVALID_JSON_RPC", "PROCESS_EXIT"].includes(diagnostics.lastError.code))
		) {
			record.quarantineReason = diagnostics.lastError.message;
			runtime.quarantine(record.quarantineReason);
			return;
		}
		const now = Date.now();
		record.restarts = record.restarts.filter(
			(timestamp) => now - timestamp <= this.options.restartWindowMs,
		);
		record.totalRestarts = record.totalRestarts.filter(
			(timestamp) => now - timestamp <= this.options.totalRestartWindowMs,
		);
		if (
			record.restarts.length >= this.options.maxRestarts ||
			record.totalRestarts.length >= this.options.maxTotalRestarts
		) {
			record.quarantineReason = "restart budget exhausted";
			runtime.quarantine(record.quarantineReason);
			return;
		}
		record.restarts.push(now);
		record.totalRestarts.push(now);
		const attempt = record.restarts.length;
		const exponential = Math.min(
			this.options.restartMaxDelayMs,
			this.options.restartBaseDelayMs * 2 ** Math.max(0, attempt - 1),
		);
		const jitter = exponential * this.options.restartJitterRatio * (this.options.random() * 2 - 1);
		const delay = Math.max(0, Math.round(exponential + jitter));
		record.restartTimer = setTimeout(() => {
			record.restartTimer = undefined;
			void this.mutex.acquire(pluginId, async () => {
				if (!record.desiredEnabled || record.quarantineReason) return;
				try {
					await runtime.restart();
				} catch (error) {
					runtime.getDiagnostics();
					logger.warn("plugin runtime restart failed", {
						pluginId,
						error: asError(error).message,
					});
				}
			});
		}, delay);
	}
}

function isRequest(message: JsonRpcEnvelope, method?: string): message is JsonRpcRequest {
	return (
		"id" in message && "method" in message && (method === undefined || message.method === method)
	);
}

function isNotification(message: JsonRpcEnvelope, method?: string): message is JsonRpcNotification {
	return (
		!("id" in message) && "method" in message && (method === undefined || message.method === method)
	);
}

function isResponse(message: JsonRpcEnvelope): message is JsonRpcResponse {
	return "id" in message && ("result" in message || "error" in message) && !("method" in message);
}

function getParamsObject(message: JsonRpcEnvelope): Record<string, unknown> {
	if (
		!("params" in message) ||
		message.params === undefined ||
		typeof message.params !== "object" ||
		message.params === null ||
		Array.isArray(message.params)
	) {
		return {};
	}
	return message.params as Record<string, unknown>;
}

function isUnhealthyResponse(message: JsonRpcResponse | JsonRpcNotification): boolean {
	const paramsOrResult =
		"result" in message ? message.result : "params" in message ? message.params : undefined;
	return (
		typeof paramsOrResult === "object" &&
		paramsOrResult !== null &&
		!Array.isArray(paramsOrResult) &&
		(paramsOrResult as { healthy?: unknown }).healthy === false
	);
}

function messageGeneration(message: JsonRpcEnvelope): number | undefined {
	const params = getParamsObject(message);
	const value = params.runtimeGeneration ?? params.generation;
	return typeof value === "number" ? value : undefined;
}

function validateHello(
	params: Record<string, unknown>,
	expected: { pluginId: string; version?: string; packageDigest?: string; rpcProtocol: string },
): void {
	const pluginId = params.pluginId ?? params.id;
	const version = params.version ?? params.pluginVersion;
	const rpcProtocol = params.rpcProtocol ?? params.protocol ?? params.protocolVersion;
	if (pluginId !== expected.pluginId) {
		throw new PluginRuntimeError("Plugin hello identity mismatch", {
			code: "HELLO_PLUGIN_ID_MISMATCH",
			phase: "hello",
			kind: "handshake",
		});
	}
	if (expected.version !== undefined && version !== expected.version) {
		throw new PluginRuntimeError("Plugin hello version mismatch", {
			code: "HELLO_VERSION_MISMATCH",
			phase: "hello",
			kind: "handshake",
		});
	}
	if (rpcProtocol !== expected.rpcProtocol) {
		throw new PluginRuntimeError("Plugin hello RPC protocol mismatch", {
			code: "HELLO_PROTOCOL_MISMATCH",
			phase: "hello",
			kind: "handshake",
		});
	}
	if (expected.packageDigest !== undefined && params.packageDigest !== expected.packageDigest) {
		throw new PluginRuntimeError("Plugin hello package digest mismatch", {
			code: "HELLO_DIGEST_MISMATCH",
			phase: "hello",
			kind: "handshake",
		});
	}
}

function normalizeRuntimeError(error: unknown, phase: string): PluginRuntimeError {
	if (error instanceof PluginRuntimeError) return error;
	return new PluginRuntimeError(asError(error).message, {
		code: "RUNTIME_ERROR",
		phase,
		kind: phase === "handshake" ? "handshake" : "transport",
		cause: error,
	});
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function createAbortError(reason?: unknown): Error {
	const error = new Error(reason instanceof Error ? reason.message : "The operation was aborted");
	error.name = "AbortError";
	return error;
}

async function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
