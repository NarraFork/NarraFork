import { generateId } from "@server/lib/id";
import {
	isPluginToHostRequestMethod,
	JSON_RPC_ERROR_CODES,
	type JsonRpcEnvelope,
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
	type JsonValue,
	jsonRpcEnvelopeSchema,
	jsonValueSchema,
	PLUGIN_TO_HOST_METHOD_REQUIRED_FEATURES,
	PLUGIN_TO_HOST_NOTIFICATION_REQUIRED_FEATURES,
	type PluginToHostFeature,
	pluginToHostFeatureListSchema,
	RPC_CANCEL_REQUEST_METHOD,
} from "@server/lib/plugins/protocol";

const DEFAULT_MAX_IN_FLIGHT = 16;
const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const DEFAULT_CONTROL_RESERVE_BYTES = 256 * 1024;
const DEFAULT_MAX_QUEUED_MESSAGES = 1_024;
const DEFAULT_CONTROL_RESERVE_MESSAGES = 32;
const DEFAULT_INBOUND_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_WAITERS = 128;
const CONTROL_BURST_LIMIT = 8;
const textEncoder = new TextEncoder();

export type RpcMessagePriority = "control" | "unary" | "stream";
export type RpcId = string | number;

export interface PluginRpcTransport {
	send(message: JsonRpcEnvelope): Promise<void>;
	onMessage(handler: (message: JsonRpcEnvelope) => void): () => void;
	onError?(handler: (error: Error) => void): () => void;
	onExit?(handler: (exitCode: number) => void): () => void;
}

export interface PluginRpcDispatcherLike {
	setIdentity?(identity: {
		pluginId: string;
		packageVersion?: string;
		installationId?: string;
		runtimeId: string;
		runtimeGeneration: number;
		contributionId?: string;
	}): void;
	dispatch(
		request: JsonRpcRequest,
		options?: PluginRpcDispatchOptions,
	): Promise<JsonRpcResponse | unknown>;
	cancel?(requestId: RpcId, reason?: string): boolean | Promise<boolean>;
	isRequestStarted?(requestId: RpcId): boolean;
	getMethodSideEffect?(method: string): "none" | "idempotent" | "unknown" | undefined;
	dispatchNotification?(
		notification: JsonRpcNotification,
		options?: PluginRpcDispatchOptions,
	): Promise<unknown>;
}

export interface PluginRpcDispatchOptions {
	signal?: AbortSignal;
	requestId?: RpcId;
	generation?: number;
	requestBytes?: number;
	deadlineAt?: string;
}

export interface PluginRpcConnectionErrorOptions {
	code?: string;
	phase?: string;
	retryable?: boolean;
	cause?: unknown;
}

export class PluginRpcConnectionError extends Error {
	readonly code: string;
	readonly phase?: string;
	readonly retryable: boolean;

	constructor(message: string, options: PluginRpcConnectionErrorOptions = {}) {
		super(message, { cause: options.cause });
		this.name = "PluginRpcConnectionError";
		this.code = options.code ?? "RPC_CONNECTION_ERROR";
		this.phase = options.phase;
		this.retryable = options.retryable ?? false;
	}
}

export interface PluginRpcErrorShape {
	code: number;
	message: string;
	data?: JsonValue;
}

export interface PluginRpcInboundRequest {
	request: JsonRpcRequest;
	key: string;
	generation: number;
	startedAt: number;
	deadlineAt: string;
	signal: AbortSignal;
	sideEffect: "none" | "idempotent" | "unknown";
	started: boolean;
	cancelled: boolean;
	responded: boolean;
}

interface MutableInboundRequest extends PluginRpcInboundRequest {
	controller: AbortController;
	resolveTerminal: (response: JsonRpcResponse) => void;
	terminal: Promise<JsonRpcResponse>;
	deadlineTimer?: ReturnType<typeof setTimeout>;
}

export interface PluginRpcOutboundPending {
	request: JsonRpcRequest;
	key: string;
	generation: number;
	startedAt: number;
	resolve: (response: JsonRpcResponse) => void;
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

export interface PluginPriorityWriterOptions {
	maxQueuedBytes?: number;
	controlReserveBytes?: number;
	maxQueuedMessages?: number;
	controlReserveMessages?: number;
	onError?: (error: Error) => void;
}

interface WriterItem {
	message: JsonRpcEnvelope;
	priority: RpcMessagePriority;
	bytes: number;
	resolve: () => void;
	reject: (error: Error) => void;
}

/**
 * Small, bounded, asynchronous writer used by the runtime connection.
 *
 * Ordinary frames cannot consume the reserved control budget. The pump always
 * selects control frames first, so cancellation and shutdown cannot sit behind
 * a flood of ordinary request/stream frames. The queue stores at most the
 * configured number of frames and bytes; it never collects unbounded output.
 */
export class PluginPriorityWriter {
	private readonly maxQueuedBytes: number;
	private readonly controlReserveBytes: number;
	private readonly maxQueuedMessages: number;
	private readonly controlReserveMessages: number;
	private readonly onError?: (error: Error) => void;
	private readonly queues: Record<RpcMessagePriority, WriterItem[]> = {
		control: [],
		unary: [],
		stream: [],
	};
	private queuedBytesValue = 0;
	private inFlightMessages = 0;
	private currentItem?: WriterItem;
	private pumping = false;
	private closed = false;
	private closeError?: Error;
	private controlBurst = 0;
	private idleResolvers: Array<() => void> = [];

	constructor(
		private readonly send: (message: JsonRpcEnvelope) => Promise<void>,
		options: PluginPriorityWriterOptions = {},
	) {
		this.maxQueuedBytes = positiveInteger(
			options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES,
			"maxQueuedBytes",
		);
		this.controlReserveBytes = positiveInteger(
			options.controlReserveBytes ??
				Math.min(DEFAULT_CONTROL_RESERVE_BYTES, Math.max(1, this.maxQueuedBytes - 1)),
			"controlReserveBytes",
		);
		this.maxQueuedMessages = positiveInteger(
			options.maxQueuedMessages ?? DEFAULT_MAX_QUEUED_MESSAGES,
			"maxQueuedMessages",
		);
		this.controlReserveMessages = positiveInteger(
			options.controlReserveMessages ??
				Math.min(DEFAULT_CONTROL_RESERVE_MESSAGES, Math.max(1, this.maxQueuedMessages - 1)),
			"controlReserveMessages",
		);
		if (this.controlReserveBytes >= this.maxQueuedBytes) {
			throw new RangeError("controlReserveBytes must be smaller than maxQueuedBytes");
		}
		if (this.controlReserveMessages >= this.maxQueuedMessages) {
			throw new RangeError("controlReserveMessages must be smaller than maxQueuedMessages");
		}
		this.onError = options.onError;
	}

	get queuedBytes(): number {
		return this.queuedBytesValue;
	}

	get queuedMessages(): number {
		return (
			this.inFlightMessages +
			this.queues.control.length +
			this.queues.unary.length +
			this.queues.stream.length
		);
	}

	get isClosed(): boolean {
		return this.closed;
	}

	enqueue(message: JsonRpcEnvelope, priority: RpcMessagePriority = "unary"): Promise<void> {
		if (this.closed) return Promise.reject(this.closeError ?? closedError());
		const bytes = encodedFrameBytes(message);
		const ordinary = priority !== "control";
		const byteLimit = ordinary
			? this.maxQueuedBytes - this.controlReserveBytes
			: this.maxQueuedBytes;
		const messageLimit = ordinary
			? this.maxQueuedMessages - this.controlReserveMessages
			: this.maxQueuedMessages;
		if (this.queuedBytesValue + bytes > byteLimit || this.queuedMessages + 1 > messageLimit) {
			return Promise.reject(
				new PluginRpcConnectionError("Plugin RPC outbound queue is full", {
					code: "OUTBOUND_QUEUE_FULL",
					phase: priority,
					retryable: true,
				}),
			);
		}
		return new Promise<void>((resolve, reject) => {
			this.queues[priority].push({ message, priority, bytes, resolve, reject });
			this.queuedBytesValue += bytes;
			this.pump();
		});
	}

	async flush(): Promise<void> {
		if (!this.pumping && this.queuedMessages === 0) return;
		await new Promise<void>((resolve) => this.idleResolvers.push(resolve));
	}

	close(error: Error = closedError()): void {
		if (this.closed) return;
		this.closed = true;
		this.closeError = error;
		this.currentItem?.reject(error);
		for (const queue of Object.values(this.queues)) {
			for (const item of queue) item.reject(error);
			queue.length = 0;
		}
		this.queuedBytesValue = 0;
		this.resolveIdle(true);
	}

	private pump(): void {
		if (this.pumping || this.closed) return;
		this.pumping = true;
		void this.runPump();
	}

	private async runPump(): Promise<void> {
		try {
			while (!this.closed) {
				const item = this.takeNext();
				if (!item) break;
				this.currentItem = item;
				this.inFlightMessages = 1;
				try {
					await this.send(item.message);
					item.resolve();
				} catch (error) {
					const runtimeError = asError(error);
					item.reject(runtimeError);
					this.onError?.(runtimeError);
					this.close(runtimeError);
					break;
				} finally {
					this.currentItem = undefined;
					this.inFlightMessages = 0;
					this.queuedBytesValue = Math.max(0, this.queuedBytesValue - item.bytes);
				}
			}
		} finally {
			this.pumping = false;
			this.resolveIdle();
			if (!this.closed && this.queuedMessages > 0) this.pump();
		}
	}

	private takeNext(): WriterItem | undefined {
		const control = this.queues.control;
		const unary = this.queues.unary;
		const stream = this.queues.stream;
		if (
			control.length > 0 &&
			(this.controlBurst < CONTROL_BURST_LIMIT || (unary.length === 0 && stream.length === 0))
		) {
			this.controlBurst++;
			return control.shift();
		}
		const ordinary = unary.length > 0 ? unary.shift() : stream.shift();
		if (ordinary) this.controlBurst = 0;
		return ordinary;
	}

	private resolveIdle(force = false): void {
		if (!force && (this.pumping || this.queuedMessages > 0)) return;
		const resolvers = this.idleResolvers.splice(0);
		for (const resolve of resolvers) resolve();
	}
}

/** Alias kept intentionally short for transport tests and adapters. */
export const BoundedPriorityWriter = PluginPriorityWriter;
export const PriorityWriter = PluginPriorityWriter;

export interface PluginRpcConnectionOptions {
	transport?: PluginRpcTransport;
	generation?: number;
	maxInFlight?: number;
	maxFrameBytes?: number;
	maxQueuedBytes?: number;
	controlReserveBytes?: number;
	maxQueuedMessages?: number;
	controlReserveMessages?: number;
	inboundTimeoutMs?: number;
	maxWaiters?: number;
	negotiatedFeatures?: readonly PluginToHostFeature[];
	enforceFeatureNegotiation?: boolean;
	hostIdentity?: {
		pluginId: string;
		packageVersion?: string;
		installationId?: string;
		runtimeId: string;
		runtimeGeneration: number;
		contributionId?: string;
	};
	dispatcher?: PluginRpcDispatcherLike;
	/** Alias for callers that name the boundary hostDispatcher. */
	hostDispatcher?: PluginRpcDispatcherLike;
	requestHandler?: PluginRpcRequestHandler;
	onNotification?: (notification: JsonRpcNotification, bodyBytes: number) => void;
	onLateMessage?: (message: JsonRpcEnvelope) => void;
	onError?: (error: Error) => void;
	onExit?: (exitCode: number) => void;
	onClose?: (error?: Error) => void;
	idFactory?: () => RpcId;
	autoStart?: boolean;
}

export interface PluginRpcRequestHandlerContext extends PluginRpcDispatchOptions {
	signal: AbortSignal;
	request: JsonRpcRequest;
}

export type PluginRpcRequestHandlerResult =
	| JsonValue
	| JsonRpcResponse
	| undefined
	| { handled: true; result?: JsonValue; response?: JsonRpcResponse }
	| typeof RPC_REQUEST_NOT_HANDLED;

export type PluginRpcRequestHandler = (
	request: JsonRpcRequest,
	context: PluginRpcRequestHandlerContext,
) => PluginRpcRequestHandlerResult | Promise<PluginRpcRequestHandlerResult>;

export const RPC_REQUEST_NOT_HANDLED = Symbol("RPC_REQUEST_NOT_HANDLED");

/**
 * Transport-level JSON-RPC connection. It owns one runtime generation and
 * keeps the two request directions in separate maps.
 */
export class PluginRpcConnection {
	readonly outboundPending = new Map<string, PluginRpcOutboundPending>();
	readonly inboundActive = new Map<string, MutableInboundRequest>();

	private readonly maxInFlight: number;
	private readonly maxFrameBytes: number;
	private readonly inboundTimeoutMs: number;
	private readonly maxWaiters: number;
	private readonly transport: PluginRpcTransport;
	private readonly idFactory: () => RpcId;
	private readonly notificationHandlers = new Set<
		(notification: JsonRpcNotification, bodyBytes: number) => void
	>();
	private readonly envelopeHandlers = new Set<(message: JsonRpcEnvelope) => void>();
	private readonly waiters = new Set<MessageWaiter>();
	private readonly closeHandlers = new Set<(error?: Error) => void>();
	private readonly options: PluginRpcConnectionOptions;
	private writer: PluginPriorityWriter;
	private generationValue: number;
	private readonly negotiatedFeatures = new Set<PluginToHostFeature>();
	private enforceFeatureNegotiation: boolean;
	private started = false;
	private closed = false;
	private closeError?: Error;
	private unsubscribeMessage?: () => void;
	private unsubscribeError?: () => void;
	private unsubscribeExit?: () => void;
	private lateMessagesValue = 0;
	private unknownNotifications = 0;

	constructor(
		transport: PluginRpcTransport,
		options?: Omit<PluginRpcConnectionOptions, "transport">,
	);
	constructor(options: PluginRpcConnectionOptions);
	constructor(
		transportOrOptions: PluginRpcTransport | PluginRpcConnectionOptions,
		maybeOptions: Omit<PluginRpcConnectionOptions, "transport"> = {},
	) {
		const transport = isTransport(transportOrOptions)
			? transportOrOptions
			: transportOrOptions.transport;
		if (!transport) throw new TypeError("PluginRpcConnection requires a transport");
		const options = isTransport(transportOrOptions)
			? { ...maybeOptions, transport: undefined }
			: transportOrOptions;
		this.options = options;
		this.transport = transport;
		this.generationValue = nonNegativeInteger(options.generation ?? 0, "generation");
		this.maxInFlight = positiveInteger(options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT, "maxInFlight");
		this.maxFrameBytes = positiveInteger(options.maxFrameBytes ?? 1024 * 1024, "maxFrameBytes");
		this.inboundTimeoutMs = positiveInteger(
			options.inboundTimeoutMs ?? DEFAULT_INBOUND_TIMEOUT_MS,
			"inboundTimeoutMs",
		);
		this.maxWaiters = positiveInteger(options.maxWaiters ?? DEFAULT_MAX_WAITERS, "maxWaiters");
		this.enforceFeatureNegotiation = options.enforceFeatureNegotiation ?? false;
		this.setNegotiatedFeatures(options.negotiatedFeatures ?? [], this.enforceFeatureNegotiation);
		this.idFactory = options.idFactory ?? (() => `rpc_${generateId(12)}`);
		this.writer = new PluginPriorityWriter((message) => this.transport.send(message), {
			maxQueuedBytes: options.maxQueuedBytes,
			controlReserveBytes: options.controlReserveBytes,
			maxQueuedMessages: options.maxQueuedMessages,
			controlReserveMessages: options.controlReserveMessages,
			onError: (error) => this.handleTransportError(error),
		});
		if (options.onNotification) this.notificationHandlers.add(options.onNotification);
		const dispatcher = options.dispatcher ?? options.hostDispatcher;
		if (dispatcher && options.hostIdentity) dispatcher.setIdentity?.(options.hostIdentity);
		if (options.autoStart !== false) this.start();
	}

	get generation(): number {
		return this.generationValue;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	get lateMessages(): number {
		return this.lateMessagesValue;
	}

	get unknownNotificationCount(): number {
		return this.unknownNotifications;
	}

	get queuedBytes(): number {
		return this.writer.queuedBytes;
	}

	get queuedMessages(): number {
		return this.writer.queuedMessages;
	}

	get outboundPendingCount(): number {
		return this.outboundPending.size;
	}

	get inboundActiveCount(): number {
		return this.inboundActive.size;
	}

	get priorityWriter(): PluginPriorityWriter {
		return this.writer;
	}

	get dispatcher(): PluginRpcDispatcherLike | undefined {
		return this.options.dispatcher ?? this.options.hostDispatcher;
	}

	start(): void {
		if (this.started || this.closed) return;
		this.started = true;
		this.unsubscribeMessage = this.transport.onMessage((message) => this.receive(message));
		this.unsubscribeError = this.transport.onError?.((error) => this.handleTransportError(error));
		this.unsubscribeExit = this.transport.onExit?.((exitCode) => {
			try {
				this.options.onExit?.(exitCode);
			} catch {
				// Exit observers must not prevent transport cleanup.
			}
			this.handleTransportError(
				new PluginRpcConnectionError(`Plugin process exited with code ${exitCode}`, {
					code: "PROCESS_EXIT",
					phase: "process",
					retryable: true,
				}),
			);
		});
	}

	setNegotiatedFeatures(
		features: readonly PluginToHostFeature[],
		enforce = this.enforceFeatureNegotiation,
	): void {
		const parsed = pluginToHostFeatureListSchema.parse([...features]);
		this.negotiatedFeatures.clear();
		for (const feature of parsed) this.negotiatedFeatures.add(feature);
		this.enforceFeatureNegotiation = enforce;
	}

	getNegotiatedFeatures(): PluginToHostFeature[] {
		return [...this.negotiatedFeatures];
	}

	setDispatcher(dispatcher: PluginRpcDispatcherLike | undefined): void {
		this.options.dispatcher = dispatcher;
		this.options.hostDispatcher = dispatcher;
	}

	setRequestHandler(handler: PluginRpcRequestHandler | undefined): void {
		this.options.requestHandler = handler;
	}

	onNotification(
		handler: (notification: JsonRpcNotification, bodyBytes: number) => void,
	): () => void {
		this.notificationHandlers.add(handler);
		return () => this.notificationHandlers.delete(handler);
	}

	subscribeNotifications(
		handler: (notification: JsonRpcNotification, bodyBytes: number) => void,
	): () => void {
		return this.onNotification(handler);
	}

	onEnvelope(handler: (message: JsonRpcEnvelope) => void): () => void {
		this.envelopeHandlers.add(handler);
		return () => this.envelopeHandlers.delete(handler);
	}

	onClose(handler: (error?: Error) => void): () => void {
		this.closeHandlers.add(handler);
		return () => this.closeHandlers.delete(handler);
	}

	waitForMessage(
		predicate: (message: JsonRpcEnvelope) => boolean,
		timeoutMs: number,
		label = "message",
	): Promise<JsonRpcEnvelope> {
		return this.createWaiter(predicate, timeoutMs, label).promise;
	}

	createWaiter(
		predicate: (message: JsonRpcEnvelope) => boolean,
		timeoutMs: number,
		label = "message",
	): { promise: Promise<JsonRpcEnvelope>; cancel: () => void } {
		if (this.waiters.size >= this.maxWaiters) {
			return {
				promise: Promise.reject(
					new PluginRpcConnectionError("RPC waiter budget is exhausted", {
						code: "WAITER_LIMIT",
						phase: label,
						retryable: true,
					}),
				),
				cancel: () => undefined,
			};
		}
		let waiter!: MessageWaiter;
		let settled = false;
		const promise = new Promise<JsonRpcEnvelope>((resolve, reject) => {
			const timer = setTimeout(
				() => {
					if (settled) return;
					settled = true;
					this.waiters.delete(waiter);
					reject(
						new PluginRpcConnectionError(`Timed out waiting for ${label}`, {
							code: `${label.toUpperCase()}_TIMEOUT`,
							phase: label,
							retryable: true,
						}),
					);
				},
				positiveInteger(timeoutMs, "timeoutMs"),
			);
			waiter = { predicate, resolve, reject, timer };
			this.waiters.add(waiter);
		});
		return {
			promise,
			cancel: () => {
				if (settled || !this.waiters.delete(waiter)) return;
				settled = true;
				clearTimeout(waiter.timer);
				waiter.reject(
					new PluginRpcConnectionError(`Cancelled waiting for ${label}`, {
						code: "WAITER_CANCELLED",
						phase: label,
						retryable: true,
					}),
				);
			},
		};
	}

	request(
		method: string,
		params?: unknown,
		options: {
			signal?: AbortSignal;
			timeoutMs?: number;
			id?: RpcId;
			priority?: RpcMessagePriority;
		} = {},
	): Promise<JsonRpcResponse> {
		this.ensureWritable(options.priority === "control");
		const id = options.id ?? this.idFactory();
		const key = rpcIdKey(id);
		if (this.outboundPending.has(key)) {
			return Promise.reject(
				new PluginRpcConnectionError("Outbound RPC request id is already pending", {
					code: "DUPLICATE_OUTBOUND_REQUEST_ID",
					phase: method,
				}),
			);
		}
		const request = {
			jsonrpc: "2.0" as const,
			id,
			method,
			...(params === undefined ? {} : { params: params as never }),
		};
		const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_INBOUND_TIMEOUT_MS, "timeoutMs");
		return new Promise<JsonRpcResponse>((resolve, reject) => {
			let settled = false;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				fn();
			};
			const timer = setTimeout(() => {
				finish(() => {
					this.outboundPending.delete(key);
					options.signal?.removeEventListener("abort", onAbort);
					void this.sendCancel(id, "timeout").catch(() => undefined);
					reject(
						new PluginRpcConnectionError(`RPC request timed out: ${method}`, {
							code: "RPC_TIMEOUT",
							phase: method,
							retryable: true,
						}),
					);
				});
			}, timeoutMs);
			const onAbort = () => {
				finish(() => {
					clearTimeout(timer);
					this.outboundPending.delete(key);
					options.signal?.removeEventListener("abort", onAbort);
					void this.sendCancel(id, "aborted").catch(() => undefined);
					reject(createAbortError(options.signal?.reason));
				});
			};
			const pending: PluginRpcOutboundPending = {
				request,
				key,
				generation: this.generationValue,
				startedAt: Date.now(),
				resolve: (response) =>
					finish(() => {
						clearTimeout(timer);
						options.signal?.removeEventListener("abort", onAbort);
						resolve(response);
					}),
				reject: (error) =>
					finish(() => {
						clearTimeout(timer);
						options.signal?.removeEventListener("abort", onAbort);
						reject(error);
					}),
				timer,
				signal: options.signal,
				removeAbort: () => options.signal?.removeEventListener("abort", onAbort),
			};
			this.outboundPending.set(key, pending);
			if (options.signal?.aborted) {
				onAbort();
				return;
			}
			options.signal?.addEventListener("abort", onAbort, { once: true });
			void this.enqueue(request, options.priority ?? "unary").catch((error) => {
				this.outboundPending.delete(key);
				pending.reject(asError(error));
			});
		});
	}

	sendRequest = this.request.bind(this);

	async notify(
		method: string,
		params?: unknown,
		options: { priority?: RpcMessagePriority } = {},
	): Promise<void> {
		this.ensureWritable(options.priority === "control" || method.startsWith("$/"));
		await this.enqueue(
			{
				jsonrpc: "2.0",
				method,
				...(params === undefined ? {} : { params: params as never }),
			},
			options.priority ?? (method.startsWith("$/") ? "control" : "stream"),
		);
	}

	async sendResult(id: RpcId, result: unknown): Promise<void> {
		await this.enqueue({ jsonrpc: "2.0", id, result: result as never }, "control");
	}

	async sendError(id: RpcId, code: number, message: string, data?: JsonValue): Promise<void> {
		const error: PluginRpcErrorShape = { code, message, ...(data === undefined ? {} : { data }) };
		await this.enqueue({ jsonrpc: "2.0", id, error }, "control");
	}

	async sendResponse(response: JsonRpcResponse): Promise<void> {
		await this.enqueue(response, "control");
	}

	async sendCancel(id: RpcId, reason: string): Promise<void> {
		if (this.closed) return;
		await this.notify(
			RPC_CANCEL_REQUEST_METHOD,
			{ requestId: id, reason: reason.slice(0, 500) },
			{ priority: "control" },
		);
	}

	async cancelInbound(id: RpcId, reason = "cancelled"): Promise<boolean> {
		const key = rpcIdKey(id);
		const active = this.inboundActive.get(key);
		if (!active) return false;
		active.cancelled = true;
		active.controller.abort(reason);
		try {
			void Promise.resolve(this.dispatcher?.cancel?.(id, reason)).catch(() => undefined);
		} catch {
			// Dispatcher cancellation is best effort; the transport response remains authoritative.
		}
		active.resolveTerminal(this.makeCancelledResponse(active, reason));

		return true;
	}

	async cancelAllInbound(reason = "shutdown"): Promise<void> {
		await Promise.allSettled(
			[...this.inboundActive.values()].map((active) =>
				this.cancelInbound(active.request.id, reason),
			),
		);
	}

	async cancelAllOutbound(reason = "shutdown"): Promise<void> {
		await Promise.allSettled(
			[...this.outboundPending.values()].map((pending) =>
				this.sendCancel(pending.request.id, reason),
			),
		);
	}

	forgetOutbound(id: RpcId): void {
		const key = rpcIdKey(id);
		const pending = this.outboundPending.get(key);
		if (!pending) return;
		this.outboundPending.delete(key);
		clearTimeout(pending.timer);
		pending.removeAbort?.();
	}

	rejectPending(error: Error): void {
		for (const pending of [...this.outboundPending.values()]) {
			this.outboundPending.delete(pending.key);
			clearTimeout(pending.timer);
			pending.removeAbort?.();
			pending.reject(error);
		}
	}

	rejectWaiters(error: Error): void {
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.waiters.clear();
	}

	async close(error?: Error): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.closeError = error;
		const closeError = error ?? closedError();
		this.rejectPending(closeError);
		for (const active of this.inboundActive.values()) {
			active.cancelled = true;
			active.controller.abort(closeError);
			if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
			active.resolveTerminal(this.makeCancelledResponse(active, closeError.message));
		}
		this.inboundActive.clear();
		this.rejectWaiters(closeError);
		this.writer.close(closeError);
		this.unsubscribeMessage?.();
		this.unsubscribeError?.();
		this.unsubscribeExit?.();
		this.unsubscribeMessage = undefined;
		this.unsubscribeError = undefined;
		this.unsubscribeExit = undefined;
		try {
			this.options.onClose?.(error);
		} catch {
			// Transport cleanup must not depend on observer behavior.
		}
		for (const handler of this.closeHandlers) {
			try {
				handler(error);
			} catch {
				// Close observers must not interfere with cleanup.
			}
		}
		this.closeHandlers.clear();
	}

	/** Generation fence for callers that replace a transport without constructing a new object. */
	setGeneration(generation: number): void {
		const next = nonNegativeInteger(generation, "generation");
		if (next === this.generationValue) return;
		this.generationValue = next;
		this.rejectPending(
			new PluginRpcConnectionError("RPC request belongs to an obsolete generation", {
				code: "STALE_GENERATION",
				phase: "generation",
				retryable: true,
			}),
		);
		void this.cancelAllInbound("generation changed");
	}

	/** Test/adaptor entry point; transport callbacks normally call this method. */
	receive(message: JsonRpcEnvelope): void {
		if (this.closed) {
			this.markLate(message);
			return;
		}
		const parsed = jsonRpcEnvelopeSchema.safeParse(message);
		if (!parsed.success) {
			this.handleTransportError(
				new PluginRpcConnectionError("Received an invalid JSON-RPC envelope", {
					code: "INVALID_JSON_RPC",
					phase: "inbound",
					cause: parsed.error,
				}),
			);
			return;
		}
		const envelope = parsed.data;
		if (jsonBodyBytes(envelope) > this.maxFrameBytes) {
			this.handleTransportError(
				new PluginRpcConnectionError("RPC frame exceeds the connection frame limit", {
					code: "INBOUND_FRAME_LIMIT",
					phase: "inbound",
				}),
			);
			return;
		}
		if (
			messageGeneration(envelope) !== undefined &&
			messageGeneration(envelope) !== this.generationValue
		) {
			this.markLate(envelope);
			return;
		}
		for (const handler of this.envelopeHandlers) {
			try {
				handler(envelope);
			} catch {
				// Envelope observers cannot alter transport routing.
			}
		}
		this.resolveWaiters(envelope);
		if (isResponse(envelope)) {
			this.handleResponse(envelope);
			return;
		}
		if (isRequest(envelope)) {
			void this.handleInboundRequest(envelope).catch((error) =>
				this.handleTransportError(asError(error)),
			);
			return;
		}
		if (isNotification(envelope)) {
			this.handleNotification(envelope);
			return;
		}
		this.markLate(envelope);
	}

	/** Backwards-compatible name for adapters that call the route method directly. */
	handleMessage(message: JsonRpcEnvelope): void {
		this.receive(message);
	}

	shutdown(error?: Error): Promise<void> {
		return this.close(error);
	}

	getDiagnostics(): {
		generation: number;
		outboundPending: number;
		inboundActive: number;
		queuedBytes: number;
		queuedMessages: number;
		lateMessages: number;
		unknownNotifications: number;
		negotiatedFeatures: PluginToHostFeature[];
	} {
		return {
			generation: this.generationValue,
			outboundPending: this.outboundPending.size,
			inboundActive: this.inboundActive.size,
			queuedBytes: this.writer.queuedBytes,
			queuedMessages: this.writer.queuedMessages,
			lateMessages: this.lateMessagesValue,
			unknownNotifications: this.unknownNotifications,
			negotiatedFeatures: this.getNegotiatedFeatures(),
		};
	}

	private async enqueue(message: JsonRpcEnvelope, priority: RpcMessagePriority): Promise<void> {
		if (this.closed) throw this.closeError ?? closedError();
		const parsed = jsonRpcEnvelopeSchema.safeParse(message);
		if (!parsed.success) {
			throw new PluginRpcConnectionError("Cannot enqueue an invalid JSON-RPC envelope", {
				code: "INVALID_JSON_RPC",
				phase: "outbound",
				cause: parsed.error,
			});
		}
		const bodyBytes = jsonBodyBytes(parsed.data);
		if (bodyBytes > this.maxFrameBytes) {
			throw new PluginRpcConnectionError("RPC frame exceeds the connection frame limit", {
				code: "OUTBOUND_FRAME_LIMIT",
				phase: "outbound",
			});
		}
		await this.writer.enqueue(message, priority);
	}

	private resolveWaiters(message: JsonRpcEnvelope): void {
		for (const waiter of [...this.waiters]) {
			let matches = false;
			try {
				matches = waiter.predicate(message);
			} catch (error) {
				this.waiters.delete(waiter);
				clearTimeout(waiter.timer);
				waiter.reject(asError(error));
				continue;
			}
			if (!matches) continue;
			this.waiters.delete(waiter);
			clearTimeout(waiter.timer);
			waiter.resolve(message);
		}
	}

	private handleResponse(response: JsonRpcResponse): void {
		const pending = this.outboundPending.get(rpcIdKey(response.id));
		if (!pending) {
			this.markLate(response);
			return;
		}
		this.outboundPending.delete(pending.key);
		clearTimeout(pending.timer);
		pending.removeAbort?.();
		pending.resolve(response);
	}

	private handleNotification(notification: JsonRpcNotification): void {
		const bodyBytes = jsonBodyBytes(notification);
		const notificationFeatures = this.requiredNotificationFeatures(notification.method);
		if (
			this.enforceFeatureNegotiation &&
			(notificationFeatures === undefined ||
				notificationFeatures.some((feature) => !this.negotiatedFeatures.has(feature)))
		) {
			this.unknownNotifications++;
			return;
		}
		if (notification.method === RPC_CANCEL_REQUEST_METHOD) {
			const params = notification.params;
			if (
				isRecord(params) &&
				(typeof params.requestId === "string" || typeof params.requestId === "number")
			) {
				void this.cancelInbound(
					params.requestId,
					typeof params.reason === "string" ? params.reason : "cancelled",
				);
			}
		}
		const dispatcher = this.dispatcher;
		if (dispatcher?.dispatchNotification) {
			try {
				void Promise.resolve(
					dispatcher.dispatchNotification(notification, {
						generation: this.generationValue,
						requestBytes: bodyBytes,
					}),
				).catch(() => undefined);
			} catch {
				// Notification dispatch is best effort and cannot break transport routing.
			}
		}
		if (notificationFeatures === undefined && !dispatcher?.dispatchNotification) {
			this.unknownNotifications++;
		}
		for (const handler of this.notificationHandlers) {
			try {
				handler(notification, bodyBytes);
			} catch {
				// A notification observer must not break transport dispatch.
			}
		}
	}

	private async handleInboundRequest(request: JsonRpcRequest): Promise<void> {
		const key = rpcIdKey(request.id);
		if (this.inboundActive.has(key)) {
			await this.sendError(
				request.id,
				JSON_RPC_ERROR_CODES.INVALID_REQUEST,
				"Duplicate JSON-RPC request id",
				{ code: "DUPLICATE_REQUEST_ID", retryable: false },
			);
			return;
		}
		const missingFeatures = this.missingRequestFeatures(request.method);
		if (missingFeatures.length > 0) {
			await this.sendError(
				request.id,
				JSON_RPC_ERROR_CODES.PERMISSION_DENIED,
				"Plugin did not negotiate the required Host API features",
				{ code: "INCOMPATIBLE", retryable: false, missingFeatures },
			);
			return;
		}
		if (this.inboundActive.size >= this.maxInFlight) {
			await this.sendError(
				request.id,
				JSON_RPC_ERROR_CODES.PLUGIN_BUSY,
				"Plugin host request budget is exhausted",
				{ code: "PLUGIN_BUSY", retryable: true },
			);
			return;
		}
		const controller = new AbortController();
		const sideEffect = this.dispatcher?.getMethodSideEffect?.(request.method) ?? "unknown";
		let resolveTerminal!: (response: JsonRpcResponse) => void;
		const terminal = new Promise<JsonRpcResponse>((resolve) => {
			resolveTerminal = resolve;
		});
		const inboundDeadline = resolveInboundDeadline(request.params, this.inboundTimeoutMs);
		const deadlineAt = inboundDeadline.at;
		const active: MutableInboundRequest = {
			request,
			key,
			generation: this.generationValue,
			startedAt: Date.now(),
			deadlineAt,
			signal: controller.signal,
			sideEffect,
			started: false,
			cancelled: false,
			responded: false,
			controller,
			resolveTerminal,
			terminal,
		};
		active.deadlineTimer = setTimeout(() => {
			if (active.responded || active.cancelled) return;
			active.cancelled = true;
			controller.abort("deadline exceeded");
			resolveTerminal(this.makeTimeoutResponse(active));
		}, inboundDeadline.timeoutMs);
		this.inboundActive.set(key, active);
		try {
			const operation = this.dispatchInbound(request, active);
			operation.catch(() => undefined);
			const response = await Promise.race([operation, terminal]);
			if (active.responded || this.closed || active.generation !== this.generationValue) return;
			active.responded = true;
			await this.sendResponse(response);
		} catch (error) {
			if (active.responded || this.closed) return;
			active.responded = true;
			await this.sendResponse(errorResponse(request.id, error, this.maxFrameBytes));
		} finally {
			if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
			this.inboundActive.delete(key);
		}
	}

	private async dispatchInbound(
		request: JsonRpcRequest,
		active: MutableInboundRequest,
	): Promise<JsonRpcResponse> {
		const context: PluginRpcRequestHandlerContext = {
			signal: active.controller.signal,
			request,
			requestId: request.id,
			generation: this.generationValue,
			requestBytes: jsonBodyBytes(request),
			deadlineAt: active.deadlineAt,
		};
		const handler = this.options.requestHandler;
		if (handler) {
			active.started = true;
			const result = await handler(request, context);
			if (result !== RPC_REQUEST_NOT_HANDLED) {
				return normalizeHandlerResult(request.id, result);
			}
			active.started = false;
		}
		const dispatcher = this.dispatcher;
		if (dispatcher) {
			const result = await dispatcher.dispatch(request, context);
			return normalizeHandlerResult(request.id, result);
		}
		return errorResponse(
			request.id,
			new PluginRpcConnectionError(`Unknown RPC method: ${request.method}`, {
				code: "METHOD_NOT_FOUND",
				phase: request.method,
			}),
			this.maxFrameBytes,
		);
	}

	private makeCancelledResponse(active: MutableInboundRequest, reason: string): JsonRpcResponse {
		const started = this.isInboundStarted(active);
		const code = started && active.sideEffect === "unknown" ? "UNKNOWN_RESULT" : "CANCELLED";
		return {
			jsonrpc: "2.0",
			id: active.request.id,
			error: {
				code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
				message:
					code === "UNKNOWN_RESULT"
						? "The operation result is unknown"
						: "The request was cancelled",
				data: { code, reason: reason.slice(0, 500), retryable: code === "UNKNOWN_RESULT" },
			},
		};
	}

	private makeTimeoutResponse(active: MutableInboundRequest): JsonRpcResponse {
		const started = this.isInboundStarted(active);
		const code = started && active.sideEffect === "unknown" ? "UNKNOWN_RESULT" : "TIMEOUT";
		return {
			jsonrpc: "2.0",
			id: active.request.id,
			error: {
				code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
				message:
					code === "UNKNOWN_RESULT"
						? "The operation result is unknown"
						: "The request deadline expired",
				data: { code, retryable: code === "UNKNOWN_RESULT" },
			},
		};
	}

	private missingRequestFeatures(method: string): PluginToHostFeature[] {
		if (!this.enforceFeatureNegotiation || !isPluginToHostRequestMethod(method)) return [];
		return PLUGIN_TO_HOST_METHOD_REQUIRED_FEATURES[method].filter(
			(feature) => !this.negotiatedFeatures.has(feature),
		);
	}

	private requiredNotificationFeatures(method: string): readonly PluginToHostFeature[] | undefined {
		if (!Object.hasOwn(PLUGIN_TO_HOST_NOTIFICATION_REQUIRED_FEATURES, method)) return undefined;
		return PLUGIN_TO_HOST_NOTIFICATION_REQUIRED_FEATURES[
			method as keyof typeof PLUGIN_TO_HOST_NOTIFICATION_REQUIRED_FEATURES
		];
	}

	private isInboundStarted(active: MutableInboundRequest): boolean {
		return active.started || this.dispatcher?.isRequestStarted?.(active.request.id) === true;
	}

	private handleTransportError(error: Error): void {
		if (this.closed) return;
		try {
			this.options.onError?.(error);
		} catch {
			// Observer failures must not prevent the connection from closing.
		}
		void this.close(error);
	}

	private markLate(message: JsonRpcEnvelope): void {
		this.lateMessagesValue++;
		try {
			this.options.onLateMessage?.(message);
		} catch {
			// Late-message observers are diagnostic only.
		}
	}

	private ensureWritable(control: boolean): void {
		if (this.closed) throw this.closeError ?? closedError();
		if (!control && this.outboundPending.size >= this.maxInFlight) {
			throw new PluginRpcConnectionError("RPC request budget is exhausted", {
				code: "PLUGIN_BUSY",
				phase: "outbound",
				retryable: true,
			});
		}
	}
}

function isTransport(
	value: PluginRpcTransport | PluginRpcConnectionOptions,
): value is PluginRpcTransport {
	return typeof (value as PluginRpcTransport).send === "function";
}

function isRequest(message: JsonRpcEnvelope): message is JsonRpcRequest {
	return "id" in message && "method" in message;
}

function isNotification(message: JsonRpcEnvelope): message is JsonRpcNotification {
	return !("id" in message) && "method" in message;
}

function isResponse(message: unknown): message is JsonRpcResponse {
	return (
		isRecord(message) &&
		"id" in message &&
		!("method" in message) &&
		("result" in message || "error" in message)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcIdKey(id: RpcId): string {
	return `${typeof id === "number" ? "number" : "string"}:${String(id)}`;
}

function messageGeneration(message: JsonRpcEnvelope): number | undefined {
	if (!("params" in message) || !isRecord(message.params)) return undefined;
	const params = message.params;
	const value = params.runtimeGeneration ?? params.generation;
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function resolveInboundDeadline(
	params: JsonValue | undefined,
	defaultTimeoutMs: number,
): { timeoutMs: number; at: string } {
	let timeoutMs = defaultTimeoutMs;
	if (isRecord(params)) {
		if (typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)) {
			timeoutMs = Math.min(timeoutMs, Math.max(1, Math.floor(params.timeoutMs)));
		}
		if (typeof params.deadlineAt === "string") {
			const requested = Date.parse(params.deadlineAt) - Date.now();
			if (Number.isFinite(requested)) timeoutMs = Math.min(timeoutMs, Math.max(1, requested));
		}
	}
	return { timeoutMs, at: new Date(Date.now() + timeoutMs).toISOString() };
}

function encodedFrameBytes(message: JsonRpcEnvelope): number {
	const body = JSON.stringify(message);
	if (body === undefined) throw new TypeError("RPC message is not JSON serializable");
	const bodyBytes = textEncoder.encode(body).byteLength;
	const header = `Content-Length: ${bodyBytes}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n`;
	return bodyBytes + textEncoder.encode(header).byteLength;
}

function jsonBodyBytes(message: JsonRpcEnvelope): number {
	try {
		const body = JSON.stringify(message);
		return body === undefined ? Number.POSITIVE_INFINITY : textEncoder.encode(body).byteLength;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function normalizeHandlerResult(id: RpcId, value: unknown): JsonRpcResponse {
	if (isResponse(value)) return { ...value, id };
	if (isRecord(value) && value.handled === true) {
		if (isResponse(value.response)) return { ...value.response, id };
		return { jsonrpc: "2.0", id, result: (value.result ?? null) as never };
	}
	return { jsonrpc: "2.0", id, result: (value ?? null) as never };
}

function errorResponse(id: RpcId, error: unknown, maxFrameBytes?: number): JsonRpcResponse {
	if (isResponse(error)) {
		const response = { ...error, id };
		return maxFrameBytes && jsonBodyBytes(response) > maxFrameBytes
			? compactErrorResponse(id)
			: response;
	}
	let response: JsonRpcResponse;
	if (error instanceof PluginRpcConnectionError) {
		const mapped = mapConnectionError(error);
		response = { jsonrpc: "2.0", id, error: mapped };
	} else {
		const value = error as { code?: unknown; rpcCode?: unknown; message?: unknown; data?: unknown };
		const rpcCode =
			typeof value?.rpcCode === "number" ? value.rpcCode : JSON_RPC_ERROR_CODES.INTERNAL_ERROR;
		const data = jsonValueSchema.safeParse(value?.data).success
			? (value.data as JsonValue)
			: undefined;
		response = {
			jsonrpc: "2.0",
			id,
			error: {
				code: rpcCode,
				message:
					typeof value?.message === "string" ? value.message.slice(0, 4_000) : "Internal RPC error",
				...(data === undefined ? {} : { data }),
			},
		};
	}
	return maxFrameBytes && jsonBodyBytes(response) > maxFrameBytes
		? compactErrorResponse(id)
		: response;
}

function compactErrorResponse(id: RpcId): JsonRpcResponse {
	return {
		jsonrpc: "2.0",
		id,
		error: {
			code: JSON_RPC_ERROR_CODES.PAYLOAD_TOO_LARGE,
			message: "RPC error response exceeds the frame limit",
			data: { code: "PAYLOAD_TOO_LARGE", retryable: false },
		},
	};
}

function mapConnectionError(error: PluginRpcConnectionError): PluginRpcErrorShape {
	const code =
		error.code === "METHOD_NOT_FOUND"
			? JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND
			: error.code === "INVALID_PARAMS"
				? JSON_RPC_ERROR_CODES.INVALID_PARAMS
				: error.code === "DUPLICATE_REQUEST_ID"
					? JSON_RPC_ERROR_CODES.INVALID_REQUEST
					: error.code === "PLUGIN_BUSY"
						? JSON_RPC_ERROR_CODES.PLUGIN_BUSY
						: JSON_RPC_ERROR_CODES.INTERNAL_ERROR;
	return {
		code,
		message: error.message,
		data: { code: error.code, retryable: error.retryable },
	};
}

function closedError(): PluginRpcConnectionError {
	return new PluginRpcConnectionError("Plugin RPC connection is closed", {
		code: "RPC_CONNECTION_CLOSED",
		retryable: true,
	});
}

function createAbortError(reason?: unknown): Error {
	const error = new Error(reason instanceof Error ? reason.message : "The operation was aborted");
	error.name = "AbortError";
	return error;
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new RangeError(`${name} must be a positive safe integer`);
	return value;
}

function nonNegativeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new RangeError(`${name} must be a non-negative safe integer`);
	return value;
}
