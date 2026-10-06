import type { JsonRpcRequest, JsonRpcResponse, JsonValue } from "@server/lib/plugins/protocol";
import { JSON_RPC_ERROR_CODES, jsonValueSchema } from "@server/lib/plugins/protocol";
import type {
	HostCallContext,
	InvocationPrincipal,
	InvocationScope,
	PluginPrincipal,
} from "./plugin-capability-broker";
import type {
	PluginRpcDispatcherLike,
	PluginRpcDispatchOptions,
	RpcId,
} from "./plugin-rpc-connection";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONCURRENCY = 16;
const DEFAULT_MAX_AUDIT_ENTRIES = 256;

export type PluginHostSideEffect = "none" | "idempotent" | "unknown";

export interface PluginHostSchema<T = unknown> {
	parse?(value: unknown): T;
	safeParse?(value: unknown): { success: true; data: T } | { success: false; error?: unknown };
}

export interface PluginHostCallContext extends HostCallContext {
	signal: AbortSignal;
	request: JsonRpcRequest;
	requestBytes: number;
	method: string;
}

export interface PluginHostResolverInput {
	method: string;
	params: unknown;
	context: PluginHostCallContext;
	signal: AbortSignal;
	capability?: string;
	resource?: unknown;
	/** Convenience aliases keep resolver injection ergonomic without trusting plugin fields. */
	plugin: PluginPrincipal;
	invocation: InvocationPrincipal;
	scope: InvocationScope;
	requestId: string;
	deadlineAt: string;
}

export interface PluginHostAuthorizationDecision {
	allowed: boolean;
	code?: string;
	message?: string;
	retryable?: boolean;
	data?: JsonValue;
}

export interface PluginHostMethodDefinition<TParams = unknown, TResult = unknown> {
	method: string;
	paramsSchema?: PluginHostSchema<TParams>;
	resultSchema?: PluginHostSchema<TResult>;
	capability?: string;
	capabilityResolver?: (
		input: PluginHostResolverInput,
	) =>
		| boolean
		| PluginHostAuthorizationDecision
		| undefined
		| Promise<boolean | PluginHostAuthorizationDecision | undefined>;
	resourceResolver?: (input: PluginHostResolverInput) => unknown | Promise<unknown>;
	maxRequestBytes?: number;
	maxResponseBytes?: number;
	timeoutMs?: number;
	maxConcurrency?: number;
	sideEffect?: PluginHostSideEffect;
	handler: (params: TParams, context: PluginHostCallContext) => TResult | Promise<TResult>;
}

export interface PluginHostMethodRegistryLike {
	get?(method: string): PluginHostMethodDefinition | undefined;
	has?(method: string): boolean;
	entries?(): Iterable<[string, PluginHostMethodDefinition]>;
}

export interface PluginHostIdentityInput {
	pluginId: string;
	packageVersion?: string;
	installationId?: string;
	runtimeId: string;
	runtimeGeneration: number;
	contributionId?: string;
}

export interface PluginHostContextFactoryInput {
	request: JsonRpcRequest;
	requestId: RpcId;
	correlationId: string;
	deadlineAt: string;
	signal: AbortSignal;
	plugin: PluginPrincipal;
	invocation: InvocationPrincipal;
	scope: InvocationScope;
}

export interface PluginHostAuditEntry {
	requestId: RpcId;
	method: string;
	pluginId: string;
	runtimeId: string;
	generation: number;
	outcome: "allowed" | "denied" | "succeeded" | "failed" | "cancelled" | "unknown";
	code?: string;
	durationMs: number;
	requestBytes: number;
	responseBytes: number;
}

export interface PluginHostDispatcherOptions {
	methods?:
		| Iterable<PluginHostMethodDefinition>
		| Map<string, PluginHostMethodDefinition>
		| Record<string, PluginHostMethodDefinition | PluginHostMethodDefinition["handler"]>;
	registry?:
		| PluginHostMethodRegistryLike
		| Record<string, PluginHostMethodDefinition | PluginHostMethodDefinition["handler"]>;
	methodRegistry?:
		| PluginHostMethodRegistryLike
		| Record<string, PluginHostMethodDefinition | PluginHostMethodDefinition["handler"]>;
	identity?: PluginHostIdentityInput;
	pluginId?: string;
	packageVersion?: string;
	installationId?: string;
	runtimeId?: string;
	runtimeGeneration?: number;
	contributionId?: string;
	invocation?: InvocationPrincipal;
	scope?: InvocationScope;
	contextFactory?: (
		input: PluginHostContextFactoryInput,
	) => HostCallContext | Promise<HostCallContext>;
	defaultTimeoutMs?: number;
	maxTimeoutMs?: number;
	maxRequestBytes?: number;
	maxResponseBytes?: number;
	maxConcurrency?: number;
	maxAuditEntries?: number;
	authorize?:
		| ((
				input: PluginHostResolverInput,
		  ) =>
				| boolean
				| PluginHostAuthorizationDecision
				| Promise<boolean | PluginHostAuthorizationDecision>)
		| ((
				context: PluginHostCallContext,
				capability?: string,
				options?: { methodId?: string; resource?: unknown },
		  ) =>
				| boolean
				| PluginHostAuthorizationDecision
				| Promise<boolean | PluginHostAuthorizationDecision>);
	capabilityBroker?: {
		authorize?: (...args: unknown[]) => unknown;
	};
	audit?: (entry: PluginHostAuditEntry) => void | Promise<void>;
	onLateResult?: (entry: PluginHostAuditEntry) => void | Promise<void>;
	now?: () => Date;
}

export class PluginHostDispatcherError extends Error {
	readonly code: string;
	readonly rpcCode: number;
	readonly retryable: boolean;
	readonly data?: JsonValue;
	readonly sideEffect?: PluginHostSideEffect;

	constructor(
		code: string,
		message: string,
		options: {
			rpcCode?: number;
			retryable?: boolean;
			data?: JsonValue;
			sideEffect?: PluginHostSideEffect;
			cause?: unknown;
		} = {},
	) {
		super(message, { cause: options.cause });
		this.name = "PluginHostDispatcherError";
		this.code = code;
		this.rpcCode = options.rpcCode ?? JSON_RPC_ERROR_CODES.INTERNAL_ERROR;
		this.retryable = options.retryable ?? false;
		this.data = options.data;
		this.sideEffect = options.sideEffect;
	}
}

interface ActiveCall {
	requestId: RpcId;
	key: string;
	method: string;
	sideEffect: PluginHostSideEffect;
	controller: AbortController;
	started: boolean;
	settled: boolean;
	cancelReason?: string;
}

interface NormalizedMethodDefinition extends PluginHostMethodDefinition<unknown, unknown> {
	sideEffect: PluginHostSideEffect;
	maxRequestBytes: number;
	maxResponseBytes: number;
	timeoutMs: number;
	maxConcurrency: number;
}

/**
 * Host-side method registry and request boundary. It deliberately has no
 * built-in service dependencies: the composition root injects method handlers
 * and authorization later, while transport tests can exercise the full loop
 * with small in-memory handlers.
 */
export class PluginHostDispatcher implements PluginRpcDispatcherLike {
	readonly methods = new Map<string, NormalizedMethodDefinition>();
	readonly inboundActive = new Map<string, ActiveCall>();

	private identity: PluginHostIdentityInput;
	private readonly invocation: InvocationPrincipal;
	private readonly scope: InvocationScope;
	private readonly contextFactory?: PluginHostDispatcherOptions["contextFactory"];
	private readonly defaultTimeoutMs: number;
	private readonly maxTimeoutMs: number;
	private readonly maxRequestBytes: number;
	private readonly maxResponseBytes: number;
	private readonly maxConcurrency: number;
	private readonly maxAuditEntries: number;
	private readonly authorizeOption?: PluginHostDispatcherOptions["authorize"];
	private readonly capabilityBroker?: PluginHostDispatcherOptions["capabilityBroker"];
	private readonly auditSink?: PluginHostDispatcherOptions["audit"];
	private readonly lateResultSink?: PluginHostDispatcherOptions["onLateResult"];
	private readonly now: () => Date;
	private readonly activeByMethod = new Map<string, number>();
	private readonly auditEntries: PluginHostAuditEntry[] = [];
	private readonly notificationHandlers = new Map<
		string,
		(value: unknown, context: PluginHostCallContext) => unknown | Promise<unknown>
	>();

	constructor(options: PluginHostDispatcherOptions = {}) {
		const identity = options.identity ?? {
			pluginId: options.pluginId ?? "unknown.plugin",
			packageVersion: options.packageVersion ?? "0.0.0",
			installationId: options.installationId,
			runtimeId: options.runtimeId ?? "runtime:unknown",
			runtimeGeneration: options.runtimeGeneration ?? 0,
			contributionId: options.contributionId,
		};
		this.identity = {
			pluginId: identity.pluginId,
			packageVersion: identity.packageVersion ?? "0.0.0",
			installationId: identity.installationId ?? `runtime:${identity.runtimeId}`,
			runtimeId: identity.runtimeId,
			runtimeGeneration: identity.runtimeGeneration,
			contributionId: identity.contributionId,
		};
		this.invocation = options.invocation ?? { kind: "plugin_background", source: "internal" };
		this.scope = { ...(options.scope ?? {}) };
		this.contextFactory = options.contextFactory;
		this.defaultTimeoutMs = positiveInteger(
			options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
			"defaultTimeoutMs",
		);
		this.maxTimeoutMs = positiveInteger(
			options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS,
			"maxTimeoutMs",
		);
		if (this.defaultTimeoutMs > this.maxTimeoutMs) {
			throw new RangeError("defaultTimeoutMs must not exceed maxTimeoutMs");
		}
		this.maxRequestBytes = positiveInteger(
			options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
			"maxRequestBytes",
		);
		this.maxResponseBytes = positiveInteger(
			options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
			"maxResponseBytes",
		);
		this.maxConcurrency = positiveInteger(
			options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
			"maxConcurrency",
		);
		this.maxAuditEntries = positiveInteger(
			options.maxAuditEntries ?? DEFAULT_MAX_AUDIT_ENTRIES,
			"maxAuditEntries",
		);
		this.authorizeOption = options.authorize;
		this.capabilityBroker = options.capabilityBroker;
		this.auditSink = options.audit;
		this.lateResultSink = options.onLateResult;
		this.now = options.now ?? (() => new Date());
		this.loadMethods(options.methods);
		this.loadRegistry(options.registry ?? options.methodRegistry);
	}

	setIdentity(identity: PluginHostIdentityInput): void {
		this.identity = {
			pluginId: identity.pluginId,
			packageVersion: identity.packageVersion ?? "0.0.0",
			installationId: identity.installationId ?? `runtime:${identity.runtimeId}`,
			runtimeId: identity.runtimeId,
			runtimeGeneration: identity.runtimeGeneration,
			contributionId: identity.contributionId,
		};
	}

	register<TParams, TResult>(definition: PluginHostMethodDefinition<TParams, TResult>): this {
		if (!definition || typeof definition.method !== "string" || !definition.method.trim()) {
			throw new TypeError("Plugin Host method requires a non-empty method name");
		}
		if (typeof definition.handler !== "function") {
			throw new TypeError(`Plugin Host method handler is missing: ${definition.method}`);
		}
		if (this.methods.has(definition.method)) {
			throw new Error(`Plugin Host method is already registered: ${definition.method}`);
		}
		this.methods.set(
			definition.method,
			normalizeMethod(definition as PluginHostMethodDefinition, this),
		);
		return this;
	}

	registerNotification(
		method: string,
		handler: (value: unknown, context: PluginHostCallContext) => unknown | Promise<unknown>,
	): this {
		if (!method.trim() || typeof handler !== "function")
			throw new TypeError("Invalid notification handler");
		this.notificationHandlers.set(method, handler);
		return this;
	}

	unregister(method: string): boolean {
		return this.methods.delete(method);
	}

	get(method: string): NormalizedMethodDefinition | undefined {
		return this.methods.get(method);
	}

	has(method: string): boolean {
		return this.methods.has(method);
	}

	listMethods(): string[] {
		return [...this.methods.keys()].sort();
	}

	getMethodSideEffect(method: string): PluginHostSideEffect | undefined {
		return this.methods.get(method)?.sideEffect;
	}

	isRequestStarted(requestId: RpcId): boolean {
		return this.inboundActive.get(rpcIdKey(requestId))?.started ?? false;
	}

	getAuditEntries(): PluginHostAuditEntry[] {
		return this.auditEntries.map((entry) => ({ ...entry }));
	}

	async dispatch(
		request: JsonRpcRequest,
		options: PluginRpcDispatchOptions = {},
	): Promise<JsonRpcResponse> {
		const key = rpcIdKey(request.id);
		const definition = this.methods.get(request.method);
		if (!definition)
			return this.errorResponse(
				request.id,
				new PluginHostDispatcherError("METHOD_NOT_FOUND", `Unknown RPC method: ${request.method}`, {
					rpcCode: JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
				}),
			);
		if (this.inboundActive.has(key)) {
			return this.errorResponse(
				request.id,
				new PluginHostDispatcherError("DUPLICATE_REQUEST_ID", "Duplicate JSON-RPC request id", {
					rpcCode: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
					data: { code: "DUPLICATE_REQUEST_ID", retryable: false },
				}),
			);
		}
		const requestBytes = options.requestBytes ?? jsonBytes(request);
		if (requestBytes > Math.min(this.maxRequestBytes, definition.maxRequestBytes)) {
			return this.errorResponse(
				request.id,
				new PluginHostDispatcherError(
					"PAYLOAD_TOO_LARGE",
					"Plugin Host request exceeds the byte limit",
					{
						rpcCode: JSON_RPC_ERROR_CODES.PAYLOAD_TOO_LARGE,
						retryable: false,
					},
				),
			);
		}
		const parsedParams = parseSchema(definition.paramsSchema, request.params);
		if (!parsedParams.success) {
			return this.errorResponse(
				request.id,
				new PluginHostDispatcherError(
					"INVALID_PARAMS",
					"Plugin Host request parameters are invalid",
					{
						rpcCode: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
						data: { code: "INVALID_PARAMS" },
						cause: parsedParams.error,
					},
				),
			);
		}
		if (
			this.inboundActive.size >= this.maxConcurrency ||
			this.methodConcurrency(definition) >= definition.maxConcurrency
		) {
			return this.errorResponse(
				request.id,
				new PluginHostDispatcherError(
					"PLUGIN_BUSY",
					"Plugin Host request concurrency is exhausted",
					{
						rpcCode: JSON_RPC_ERROR_CODES.PLUGIN_BUSY,
						retryable: true,
					},
				),
			);
		}

		const controller = new AbortController();
		const externalAbort = options.signal;
		const abortExternal = () => controller.abort(externalAbort?.reason ?? "cancelled");
		if (externalAbort?.aborted) abortExternal();
		else externalAbort?.addEventListener("abort", abortExternal, { once: true });
		const timeoutMs = this.resolveTimeout(definition, options.deadlineAt);
		const deadlineAt = new Date(this.now().getTime() + timeoutMs).toISOString();
		const active: ActiveCall = {
			requestId: request.id,
			key,
			method: request.method,
			sideEffect: definition.sideEffect,
			controller,
			started: false,
			settled: false,
		};
		this.inboundActive.set(key, active);
		this.incrementMethod(definition.method);
		const startedAt = this.now().getTime();
		const deadlineError = (call: ActiveCall) =>
			new PluginHostDispatcherError(
				call.started && call.sideEffect === "unknown" ? "UNKNOWN_RESULT" : "TIMEOUT",
				call.started && call.sideEffect === "unknown"
					? "The operation result is unknown"
					: "Plugin Host request timed out",
				{
					rpcCode: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
					retryable: call.started && call.sideEffect === "unknown",
					data: {
						code: call.started && call.sideEffect === "unknown" ? "UNKNOWN_RESULT" : "TIMEOUT",
					},
					sideEffect: call.sideEffect,
				},
			);
		let context: PluginHostCallContext | undefined;
		try {
			const contextOutcome = await raceWithAbort(
				this.createContext(request, options, deadlineAt, controller.signal),
				controller.signal,
				remainingDeadlineMs(deadlineAt, this.now),
			);
			if (contextOutcome.kind === "aborted")
				return await this.finishAbort(request, active, startedAt, requestBytes);
			if (contextOutcome.kind === "timeout") {
				controller.abort("deadline exceeded");
				return await this.finishError(
					request,
					deadlineError(active),
					startedAt,
					requestBytes,
					deadlineAt,
				);
			}
			context = contextOutcome.value;
			const resourceOutcome = await raceWithAbort(
				this.resolveResource(definition, parsedParams.data, context),
				controller.signal,
				remainingDeadlineMs(deadlineAt, this.now),
			);
			if (resourceOutcome.kind === "aborted")
				return await this.finishAbort(request, active, startedAt, requestBytes);
			if (resourceOutcome.kind === "timeout") {
				controller.abort("deadline exceeded");
				return await this.finishError(
					request,
					deadlineError(active),
					startedAt,
					requestBytes,
					deadlineAt,
				);
			}
			const resource = resourceOutcome.value;
			const authorizationOutcome = await raceWithAbort(
				this.authorize(definition, parsedParams.data, context, controller.signal, resource),
				controller.signal,
				remainingDeadlineMs(deadlineAt, this.now),
			);
			if (authorizationOutcome.kind === "aborted")
				return await this.finishAbort(request, active, startedAt, requestBytes);
			if (authorizationOutcome.kind === "timeout") {
				controller.abort("deadline exceeded");
				return await this.finishError(
					request,
					deadlineError(active),
					startedAt,
					requestBytes,
					deadlineAt,
				);
			}
			const authorization = authorizationOutcome.value;
			if (!authorization.allowed) {
				const denied = new PluginHostDispatcherError(
					authorization.code ?? "PERMISSION_DENIED",
					authorization.message ?? "Plugin Host capability request was denied",
					{
						rpcCode: JSON_RPC_ERROR_CODES.PERMISSION_DENIED,
						retryable: authorization.retryable,
						data: authorization.data,
					},
				);
				return await this.finishError(request, denied, startedAt, requestBytes);
			}
			if (controller.signal.aborted) {
				return await this.finishAbort(request, active, startedAt, requestBytes);
			}
			active.started = true;
			const operation = Promise.resolve().then(() =>
				definition.handler(parsedParams.data, context as PluginHostCallContext),
			);
			operation.then(
				() => {
					if (active.settled) void this.recordLateResult(request, active, requestBytes);
				},
				() => {
					if (active.settled) void this.recordLateResult(request, active, requestBytes);
				},
			);
			operation.catch(() => undefined);
			const outcome = await raceWithAbort(
				operation,
				controller.signal,
				remainingDeadlineMs(deadlineAt, this.now),
			);
			if (outcome.kind === "aborted") {
				return await this.finishAbort(request, active, startedAt, requestBytes);
			}
			if (outcome.kind === "timeout") {
				controller.abort("deadline exceeded");
				return await this.finishError(
					request,
					deadlineError(active),
					startedAt,
					requestBytes,
					deadlineAt,
				);
			}
			const parsedResult = parseSchema(definition.resultSchema, outcome.value);
			if (!parsedResult.success || !jsonValueSchema.safeParse(parsedResult.data).success) {
				return await this.finishError(
					request,
					new PluginHostDispatcherError(
						"INTERNAL_ERROR",
						"Plugin Host handler returned an invalid result",
						{
							rpcCode: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
							data: { code: "RESULT_SCHEMA_INVALID" },
							cause: parsedResult.success ? undefined : parsedResult.error,
						},
					),
					startedAt,
					requestBytes,
				);
			}
			const response: JsonRpcResponse = {
				jsonrpc: "2.0",
				id: request.id,
				result: parsedResult.data as never,
			};
			const responseBytes = jsonBytes(response);
			if (responseBytes > Math.min(this.maxResponseBytes, definition.maxResponseBytes)) {
				return await this.finishError(
					request,
					new PluginHostDispatcherError(
						"PAYLOAD_TOO_LARGE",
						"Plugin Host response exceeds the byte limit",
						{
							rpcCode: JSON_RPC_ERROR_CODES.PAYLOAD_TOO_LARGE,
						},
					),
					startedAt,
					requestBytes,
				);
			}
			active.settled = true;
			await this.audit(
				{
					requestId: request.id,
					method: request.method,
					pluginId: this.identity.pluginId,
					runtimeId: this.identity.runtimeId,
					generation: this.identity.runtimeGeneration,
					outcome: "succeeded",
					durationMs: this.now().getTime() - startedAt,
					requestBytes,
					responseBytes,
				},
				deadlineAt,
			);
			return response;
		} catch (error) {
			if (controller.signal.aborted || isAbortError(error)) {
				return await this.finishAbort(request, active, startedAt, requestBytes);
			}
			return await this.finishError(
				request,
				normalizeDispatcherError(error),
				startedAt,
				requestBytes,
			);
		} finally {
			externalAbort?.removeEventListener("abort", abortExternal);
			this.inboundActive.delete(key);
			this.decrementMethod(definition.method);
		}
	}

	async dispatchNotification(
		notification: { method: string; params?: unknown },
		options: PluginRpcDispatchOptions = {},
	): Promise<unknown> {
		const handler = this.notificationHandlers.get(notification.method);
		if (!handler) return undefined;
		const request = {
			jsonrpc: "2.0" as const,
			id: options.requestId ?? `notification_${Date.now()}`,
			method: notification.method,
			...(notification.params === undefined ? {} : { params: notification.params as never }),
		};
		const controller = new AbortController();
		const externalSignal = options.signal;
		const abortExternal = () => controller.abort(externalSignal?.reason ?? "cancelled");
		if (externalSignal?.aborted) abortExternal();
		else externalSignal?.addEventListener("abort", abortExternal, { once: true });
		const deadlineAt =
			options.deadlineAt ?? new Date(this.now().getTime() + this.defaultTimeoutMs).toISOString();
		try {
			const contextOutcome = await raceWithAbort(
				this.createContext(request, options, deadlineAt, controller.signal),
				controller.signal,
				remainingDeadlineMs(deadlineAt, this.now),
			);
			if (contextOutcome.kind !== "value") return undefined;
			const handlerOutcome = await raceWithAbort(
				Promise.resolve(handler(notification.params, contextOutcome.value)),
				controller.signal,
				remainingDeadlineMs(deadlineAt, this.now),
			);
			return handlerOutcome.kind === "value" ? handlerOutcome.value : undefined;
		} finally {
			externalSignal?.removeEventListener("abort", abortExternal);
		}
	}

	async cancel(requestId: RpcId, reason = "cancelled"): Promise<boolean> {
		const active = this.inboundActive.get(rpcIdKey(requestId));
		if (!active) return false;
		active.cancelReason = reason;
		active.controller.abort(reason);
		return true;
	}

	private async createContext(
		request: JsonRpcRequest,
		options: PluginRpcDispatchOptions,
		deadlineAt: string,
		signal: AbortSignal,
	): Promise<PluginHostCallContext> {
		const correlationId =
			correlationIdFromParams(request.params) ?? `rpc_corr_${Date.now().toString(36)}`;
		const plugin: PluginPrincipal = {
			pluginId: this.identity.pluginId,
			packageVersion: this.identity.packageVersion ?? "0.0.0",
			runtimeId: this.identity.runtimeId,
			runtimeGeneration: this.identity.runtimeGeneration,
			installationId: this.identity.installationId ?? `runtime:${this.identity.runtimeId}`,
			...(this.identity.contributionId ? { contributionId: this.identity.contributionId } : {}),
		};
		const base: PluginHostContextFactoryInput = {
			request,
			requestId: request.id,
			correlationId,
			deadlineAt,
			signal,
			plugin,
			invocation: this.invocation,
			scope: { ...this.scope },
		};
		const supplied = this.contextFactory
			? await this.contextFactory(base)
			: ({
					requestId: String(request.id),
					correlationId,
					deadlineAt,
					plugin,
					invocation: this.invocation,
					scope: { ...this.scope },
				} satisfies HostCallContext);
		return {
			...supplied,
			requestId: String(request.id),
			correlationId,
			deadlineAt,
			plugin,
			invocation: this.invocation,
			scope: { ...this.scope, ...(supplied.scope ?? {}) },
			signal,
			request,
			requestBytes: options.requestBytes ?? jsonBytes(request),
			method: request.method,
		};
	}

	private async resolveResource(
		definition: NormalizedMethodDefinition,
		params: unknown,
		context: PluginHostCallContext,
	): Promise<unknown> {
		if (!definition.resourceResolver) return undefined;
		return definition.resourceResolver({
			method: definition.method,
			params,
			context,
			signal: context.signal,
			capability: definition.capability,
			plugin: context.plugin,
			invocation: context.invocation,
			scope: context.scope,
			requestId: context.requestId,
			deadlineAt: context.deadlineAt,
		});
	}

	private async authorize(
		definition: NormalizedMethodDefinition,
		params: unknown,
		context: PluginHostCallContext,
		signal: AbortSignal,
		resource: unknown,
	): Promise<PluginHostAuthorizationDecision> {
		const input: PluginHostResolverInput = {
			method: definition.method,
			params,
			context,
			signal,
			capability: definition.capability,
			resource,
			plugin: context.plugin,
			invocation: context.invocation,
			scope: context.scope,
			requestId: context.requestId,
			deadlineAt: context.deadlineAt,
		};
		if (this.authorizeOption) {
			return normalizeAuthorization(await callAuthorizeOption(this.authorizeOption, input));
		}
		if (definition.capabilityResolver) {
			return normalizeAuthorization(await definition.capabilityResolver(input));
		}
		if (this.capabilityBroker) {
			if (definition.capability && typeof this.capabilityBroker.authorize === "function") {
				const brokerResult = await callCapabilityBroker(this.capabilityBroker.authorize, input);
				return normalizeAuthorization(brokerResult);
			}
			return {
				allowed: false,
				code: "PERMISSION_DENIED",
				message: "Plugin Host method has no capability authorization binding",
				data: { reason: "CAPABILITY_BINDING_MISSING" },
			};
		}
		return { allowed: true };
	}

	private resolveTimeout(
		definition: NormalizedMethodDefinition,
		requestedDeadlineAt?: string,
	): number {
		let timeout = Math.min(this.maxTimeoutMs, definition.timeoutMs);
		if (requestedDeadlineAt) {
			const remaining = Date.parse(requestedDeadlineAt) - this.now().getTime();
			if (Number.isFinite(remaining)) timeout = Math.min(timeout, Math.max(1, remaining));
		}
		return Math.max(1, timeout);
	}

	private methodConcurrency(definition: NormalizedMethodDefinition): number {
		return this.activeByMethod.get(definition.method) ?? 0;
	}

	private incrementMethod(method: string): void {
		this.activeByMethod.set(method, (this.activeByMethod.get(method) ?? 0) + 1);
	}

	private decrementMethod(method: string): void {
		const next = (this.activeByMethod.get(method) ?? 1) - 1;
		if (next <= 0) this.activeByMethod.delete(method);
		else this.activeByMethod.set(method, next);
	}

	private async finishAbort(
		request: JsonRpcRequest,
		active: ActiveCall,
		startedAt: number,
		requestBytes: number,
	): Promise<JsonRpcResponse> {
		const code = active.started && active.sideEffect === "unknown" ? "UNKNOWN_RESULT" : "CANCELLED";
		const response: JsonRpcResponse = {
			jsonrpc: "2.0",
			id: request.id,
			error: {
				code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
				message:
					code === "UNKNOWN_RESULT"
						? "The operation result is unknown"
						: "The request was cancelled",
				data: {
					code,
					reason: active.cancelReason ?? "cancelled",
					retryable: code === "UNKNOWN_RESULT",
				},
			},
		};
		active.settled = true;
		await this.audit({
			requestId: request.id,
			method: request.method,
			pluginId: this.identity.pluginId,
			runtimeId: this.identity.runtimeId,
			generation: this.identity.runtimeGeneration,
			outcome: code === "UNKNOWN_RESULT" ? "unknown" : "cancelled",
			code,
			durationMs: this.now().getTime() - startedAt,
			requestBytes,
			responseBytes: jsonBytes(response),
		});
		return response;
	}

	private async finishError(
		request: JsonRpcRequest,
		error: PluginHostDispatcherError,
		startedAt: number,
		requestBytes: number,
		deadlineAt?: string,
	): Promise<JsonRpcResponse> {
		const response = this.errorResponse(
			request.id,
			error,
			Math.min(
				this.maxResponseBytes,
				this.methods.get(request.method)?.maxResponseBytes ?? this.maxResponseBytes,
			),
		);
		const active = this.inboundActive.get(rpcIdKey(request.id));
		if (active) active.settled = true;
		await this.audit(
			{
				requestId: request.id,
				method: request.method,
				pluginId: this.identity.pluginId,
				runtimeId: this.identity.runtimeId,
				generation: this.identity.runtimeGeneration,
				outcome: error.code === "PERMISSION_DENIED" ? "denied" : "failed",
				code: error.code,
				durationMs: this.now().getTime() - startedAt,
				requestBytes,
				responseBytes: jsonBytes(response),
			},
			deadlineAt,
		);
		return response;
	}

	private async recordLateResult(
		request: JsonRpcRequest,
		active: ActiveCall,
		requestBytes: number,
	): Promise<void> {
		const entry: PluginHostAuditEntry = {
			requestId: request.id,
			method: request.method,
			pluginId: this.identity.pluginId,
			runtimeId: this.identity.runtimeId,
			generation: this.identity.runtimeGeneration,
			outcome: active.sideEffect === "unknown" ? "unknown" : "failed",
			code: "LATE_RESULT",
			durationMs: 0,
			requestBytes,
			responseBytes: 0,
		};
		await this.audit(entry);
		try {
			await this.lateResultSink?.(entry);
		} catch {
			// Late-result diagnostics are deliberately best effort.
		}
	}

	private errorResponse(
		id: RpcId,
		error: PluginHostDispatcherError,
		maxResponseBytes = this.maxResponseBytes,
	): JsonRpcResponse {
		const response: JsonRpcResponse = {
			jsonrpc: "2.0",
			id,
			error: {
				code: error.rpcCode,
				message: error.message.trim().slice(0, 4_000) || "Plugin Host request failed",
				data: {
					code: error.code,
					retryable: error.retryable,
					...(error.data === undefined ? {} : { details: error.data }),
				},
			},
		};
		if (jsonBytes(response) <= maxResponseBytes) return response;
		return {
			jsonrpc: "2.0",
			id,
			error: {
				code: JSON_RPC_ERROR_CODES.PAYLOAD_TOO_LARGE,
				message: "Plugin Host error response exceeds the byte limit",
				data: { code: "PAYLOAD_TOO_LARGE", retryable: false },
			},
		};
	}

	private async audit(entry: PluginHostAuditEntry, deadlineAt?: string): Promise<void> {
		this.auditEntries.push(entry);
		while (this.auditEntries.length > this.maxAuditEntries) this.auditEntries.shift();
		if (!this.auditSink) return;
		const auditPromise = Promise.resolve().then(() => this.auditSink?.(entry));
		auditPromise.catch(() => undefined);
		if (!deadlineAt) return;
		const remaining = remainingDeadlineMs(deadlineAt, this.now);
		try {
			await waitAtMost(auditPromise, Math.max(1, remaining));
		} catch {
			// Auditing must never change the RPC result.
		}
	}

	private loadMethods(methods: PluginHostDispatcherOptions["methods"]): void {
		if (!methods) return;
		if (methods instanceof Map) {
			for (const [method, definition] of methods) this.register({ ...definition, method });
			return;
		}
		if (Symbol.iterator in Object(methods) && typeof methods !== "string") {
			for (const definition of methods as Iterable<PluginHostMethodDefinition>)
				this.register(definition);
			return;
		}
		for (const [method, definition] of Object.entries(methods)) {
			if (typeof definition === "function") this.register({ method, handler: definition });
			else this.register({ ...definition, method });
		}
	}

	private loadRegistry(
		registry?:
			| PluginHostMethodRegistryLike
			| Record<string, PluginHostMethodDefinition | PluginHostMethodDefinition["handler"]>,
	): void {
		if (!registry) return;
		if (isMethodRegistryLike(registry)) {
			const entries = registry.entries;
			if (!entries) return;
			for (const [method, definition] of entries.call(registry))
				this.register({ ...definition, method });
			return;
		}
		for (const [method, definition] of Object.entries(registry)) {
			if (typeof definition === "function") this.register({ method, handler: definition });
			else this.register({ ...definition, method });
		}
	}
}

export type PluginHostMethodRegistry = PluginHostDispatcher;

function isMethodRegistryLike(
	value:
		| PluginHostMethodRegistryLike
		| Record<string, PluginHostMethodDefinition | PluginHostMethodDefinition["handler"]>,
): value is PluginHostMethodRegistryLike {
	return typeof value === "object" && value !== null && typeof value.entries === "function";
}

function normalizeMethod(
	definition: PluginHostMethodDefinition,
	dispatcher: PluginHostDispatcher,
): NormalizedMethodDefinition {
	const maxRequestBytes = positiveInteger(
		definition.maxRequestBytes ??
			(dispatcher as unknown as { maxRequestBytes: number }).maxRequestBytes,
		"maxRequestBytes",
	);
	const maxResponseBytes = positiveInteger(
		definition.maxResponseBytes ??
			(dispatcher as unknown as { maxResponseBytes: number }).maxResponseBytes,
		"maxResponseBytes",
	);
	const timeoutMs = positiveInteger(
		definition.timeoutMs ??
			(dispatcher as unknown as { defaultTimeoutMs: number }).defaultTimeoutMs,
		"timeoutMs",
	);
	const maxConcurrency = positiveInteger(
		definition.maxConcurrency ??
			(dispatcher as unknown as { maxConcurrency: number }).maxConcurrency,
		"maxConcurrency",
	);
	return {
		...definition,
		sideEffect: definition.sideEffect ?? "none",
		maxRequestBytes,
		maxResponseBytes,
		timeoutMs,
		maxConcurrency,
	};
}

function parseSchema<T>(
	schema: PluginHostSchema<T> | undefined,
	value: unknown,
): { success: true; data: T } | { success: false; error?: unknown } {
	if (!schema) return { success: true, data: value as T };
	if (typeof schema.safeParse === "function") {
		const result = schema.safeParse(value);
		return result.success
			? { success: true, data: result.data }
			: { success: false, error: result.error };
	}
	if (typeof schema.parse === "function") {
		try {
			return { success: true, data: schema.parse(value) };
		} catch (error) {
			return { success: false, error };
		}
	}
	return { success: false, error: new Error("Invalid method schema") };
}

function normalizeAuthorization(
	value: boolean | PluginHostAuthorizationDecision | undefined | unknown,
): PluginHostAuthorizationDecision {
	if (value === undefined || value === true) return { allowed: true };
	if (value === false) return { allowed: false };
	if (typeof value === "object" && value !== null && "allowed" in value) {
		const decision = value as PluginHostAuthorizationDecision;
		return {
			allowed: Boolean(decision.allowed),
			code: decision.code,
			message: decision.message,
			retryable: decision.retryable,
			data: decision.data,
		};
	}
	return { allowed: Boolean(value) };
}

async function callAuthorizeOption(
	authorize: NonNullable<PluginHostDispatcherOptions["authorize"]>,
	input: PluginHostResolverInput,
): Promise<boolean | PluginHostAuthorizationDecision> {
	if (authorize.length >= 2) {
		const legacy = authorize as (
			context: PluginHostCallContext,
			capability?: string,
			options?: { methodId?: string; resource?: unknown },
		) =>
			| boolean
			| PluginHostAuthorizationDecision
			| Promise<boolean | PluginHostAuthorizationDecision>;
		return legacy(input.context, input.capability, {
			methodId: input.method,
			resource: input.resource,
		});
	}
	const modern = authorize as (
		input: PluginHostResolverInput,
	) =>
		| boolean
		| PluginHostAuthorizationDecision
		| Promise<boolean | PluginHostAuthorizationDecision>;
	return modern(input);
}

async function callCapabilityBroker(
	authorize: (...args: unknown[]) => unknown,
	input: PluginHostResolverInput,
): Promise<unknown> {
	try {
		if (authorize.length >= 2) {
			return await authorize(input.context, input.capability, {
				methodId: input.method,
				resource: input.resource,
				scope: input.context.scope,
				requestBytes: input.context.requestBytes,
			});
		}
		return await authorize(input);
	} catch {
		return {
			allowed: false,
			code: "PERMISSION_DENIED",
			message: "Plugin capability request was denied",
			data: { reason: "BROKER_DENIED" },
		};
	}
}

function correlationIdFromParams(params: unknown): string | undefined {
	if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
	const value = (params as Record<string, unknown>).correlationId;
	return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : undefined;
}

function normalizeDispatcherError(error: unknown): PluginHostDispatcherError {
	if (error instanceof PluginHostDispatcherError) return error;
	if (isAbortError(error)) {
		return new PluginHostDispatcherError("CANCELLED", "The request was cancelled", {
			rpcCode: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
			data: { code: "CANCELLED" },
		});
	}
	if (error && typeof error === "object") {
		const value = error as {
			code?: unknown;
			message?: unknown;
			rpcCode?: unknown;
			retryable?: unknown;
			data?: unknown;
		};
		if (typeof value.code === "string") {
			return new PluginHostDispatcherError(
				value.code,
				typeof value.message === "string" ? value.message : "Plugin Host handler failed",
				{
					rpcCode:
						typeof value.rpcCode === "number" ? value.rpcCode : JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
					retryable: typeof value.retryable === "boolean" ? value.retryable : false,
					data: jsonValueSchema.safeParse(value.data).success
						? (value.data as JsonValue)
						: undefined,
					cause: error,
				},
			);
		}
	}
	return new PluginHostDispatcherError("INTERNAL_ERROR", "Plugin Host handler failed", {
		rpcCode: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
		cause: error,
	});
}

function remainingDeadlineMs(deadlineAt: string, now: () => Date): number {
	const remaining = Date.parse(deadlineAt) - now().getTime();
	return Number.isFinite(remaining) ? Math.max(1, remaining) : 1;
}

async function waitAtMost<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function raceWithAbort<T>(
	operation: Promise<T>,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<{ kind: "value"; value: T } | { kind: "aborted" } | { kind: "timeout" }> {
	if (signal.aborted) return { kind: "aborted" };
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abortListener!: () => void;
	const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
		abortListener = () => resolve({ kind: "aborted" });
		signal.addEventListener("abort", abortListener, { once: true });
	});
	const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
		timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
	});
	try {
		return await Promise.race([
			operation.then((value) => ({ kind: "value" as const, value })),
			aborted,
			timeout,
		]);
	} finally {
		if (timer) clearTimeout(timer);
		signal.removeEventListener("abort", abortListener);
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function jsonBytes(value: unknown): number {
	try {
		const json = JSON.stringify(value);
		return json === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(json, "utf8");
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function rpcIdKey(id: RpcId): string {
	return `${typeof id === "number" ? "number" : "string"}:${String(id)}`;
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new RangeError(`${name} must be a positive safe integer`);
	return value;
}
