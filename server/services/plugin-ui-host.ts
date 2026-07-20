import { z } from "zod";
import {
	RESOURCE_SCOPE_FIELD_BY_TYPE,
	resourceScopeSchema,
	scopeToFieldBinding,
} from "../lib/integrations/resource-scope";
import {
	type JsonValue,
	jsonValueSchema,
	NARRAFORK_UI_PROTOCOL,
	type UiRpcRequest,
	type UiRpcResponse,
	uiRpcRequestSchema,
} from "../lib/plugins/protocol";
import {
	type CapabilityBroker,
	capabilityBroker as defaultCapabilityBroker,
	type HostCallContext,
	type InvocationScope,
	type PluginPrincipal,
} from "./plugin-capability-broker";
import {
	type PluginEventGateway,
	type PluginPrincipal as PluginEventPrincipal,
	pluginEventGateway,
} from "./plugin-event-gateway";
import {
	createCommandRequest,
	createQueryRequest,
	type PluginPublicApi,
	type PublicApiError,
} from "./plugin-public-api";
import {
	PLUGIN_STORAGE_SCOPE_TYPES,
	type PluginStorageFactoryLike,
	type PluginStorageScope,
	type PluginStorageScopeType,
	pluginStorageFactory,
	resolvePluginStorage,
} from "./plugin-storage";
import type { PluginUiSession } from "./plugin-ui-session";

export const PLUGIN_UI_HOST_REQUEST_MAX_BYTES = 256 * 1024;
export const PLUGIN_UI_HOST_RESPONSE_MAX_BYTES = 1024 * 1024;
export const PLUGIN_UI_HOST_TIMEOUT_MS = 10_000;

const queryInputSchema = z
	.object({ queryId: z.string().trim().min(1).max(128), input: jsonValueSchema.optional() })
	.strict();
const commandInputSchema = z
	.object({
		commandId: z.string().trim().min(1).max(128),
		input: jsonValueSchema.optional(),
		idempotencyKey: z.string().trim().min(1).max(128).optional(),
		expectedVersion: z.number().int().nonnegative().optional(),
	})
	.strict();
const subscriptionInputSchema = z
	.object({ subscriptionId: z.string().trim().min(1).max(128) })
	.strict();

export interface PluginUiHostRequest {
	session: PluginUiSession;
	principalId: string;
	userRole: "admin" | "user";
	request: UiRpcRequest;
	signal?: AbortSignal;
}

export interface PluginUiHostOptions {
	publicApi?: PluginPublicApi;
	capabilityBroker?: Pick<CapabilityBroker, "authorize"> &
		Partial<Pick<CapabilityBroker, "withCallContext">>;
	eventGateway?: Pick<PluginEventGateway, "subscribe" | "unsubscribe" | "poll"> &
		Partial<Pick<PluginEventGateway, "revokeSession">>;
	storageFactory?: PluginStorageFactoryLike;
	now?: () => Date;
	timeoutMs?: number;
}

export class PluginUiHostError extends Error {
	readonly code:
		| "METHOD_NOT_FOUND"
		| "INVALID_PARAMS"
		| "PERMISSION_DENIED"
		| "CONTEXT_UNAVAILABLE"
		| "NOT_FOUND"
		| "CONFLICT"
		| "RATE_LIMITED"
		| "PAYLOAD_TOO_LARGE"
		| "TIMEOUT"
		| "CANCELLED"
		| "PLUGIN_DISABLED"
		| "HOST_UNAVAILABLE"
		| "STORAGE_QUOTA_EXCEEDED"
		| "STORAGE_CONFLICT"
		| "PLUGIN_BUSY"
		| "UNKNOWN_RESULT"
		| "INCOMPATIBLE"
		| "INTERNAL_ERROR";
	readonly retryable?: boolean;

	constructor(
		code: PluginUiHostError["code"],
		message: string,
		options: { retryable?: boolean } = {},
	) {
		super(message);
		this.name = "PluginUiHostError";
		this.code = code;
		this.retryable = options.retryable;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonBytes(value: unknown): number {
	try {
		const encoded = JSON.stringify(value);
		return encoded === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(encoded, "utf8");
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function makeResponse(id: string, result?: JsonValue, error?: PluginUiHostError): UiRpcResponse {
	if (error) {
		return {
			protocol: NARRAFORK_UI_PROTOCOL,
			kind: "response",
			id,
			error: {
				code: error.code,
				message: error.message,
				...(error.retryable === undefined ? {} : { retryable: error.retryable }),
			},
		};
	}
	return {
		protocol: NARRAFORK_UI_PROTOCOL,
		kind: "response",
		id,
		result: result ?? null,
	};
}

function publicErrorToHostError(error: PublicApiError | undefined): PluginUiHostError {
	if (!error) return new PluginUiHostError("INTERNAL_ERROR", "Plugin public API failed");
	const supported = new Set([
		"METHOD_NOT_FOUND",
		"INVALID_PARAMS",
		"PERMISSION_DENIED",
		"CONTEXT_UNAVAILABLE",
		"NOT_FOUND",
		"CONFLICT",
		"RATE_LIMITED",
		"PAYLOAD_TOO_LARGE",
		"TIMEOUT",
		"CANCELLED",
		"PLUGIN_DISABLED",
		"HOST_UNAVAILABLE",
		"STORAGE_QUOTA_EXCEEDED",
		"STORAGE_CONFLICT",
		"PLUGIN_BUSY",
		"UNKNOWN_RESULT",
		"INCOMPATIBLE",
		"INTERNAL_ERROR",
	]);
	const code = supported.has(error.code)
		? (error.code as PluginUiHostError["code"])
		: "INTERNAL_ERROR";
	return new PluginUiHostError(code, error.message, { retryable: error.retryable });
}

function hostError(error: unknown): PluginUiHostError {
	if (error instanceof PluginUiHostError) return error;
	if (error && typeof error === "object") {
		const value = error as { code?: unknown; message?: unknown; retryable?: unknown };
		const supported = new Set<PluginUiHostError["code"]>([
			"METHOD_NOT_FOUND",
			"INVALID_PARAMS",
			"PERMISSION_DENIED",
			"CONTEXT_UNAVAILABLE",
			"NOT_FOUND",
			"CONFLICT",
			"RATE_LIMITED",
			"PAYLOAD_TOO_LARGE",
			"TIMEOUT",
			"CANCELLED",
			"PLUGIN_DISABLED",
			"HOST_UNAVAILABLE",
			"INTERNAL_ERROR",
		]);
		if (typeof value.code === "string" && supported.has(value.code as PluginUiHostError["code"])) {
			return new PluginUiHostError(
				value.code as PluginUiHostError["code"],
				typeof value.message === "string" ? value.message : "Plugin UI request failed",
				{ retryable: typeof value.retryable === "boolean" ? value.retryable : undefined },
			);
		}
	}
	return new PluginUiHostError("INTERNAL_ERROR", "Plugin UI request failed");
}

function scopeForStorage(scope: PluginStorageScope): InvocationScope {
	if (scope.type === "global" || scope.type === "session") return {};
	return scopeToFieldBinding(scope) as InvocationScope;
}

function boundStorageScopeId(
	type: PluginStorageScopeType,
	context: HostCallContext,
): string | undefined {
	if (type === "session") return context.plugin.runtimeId.slice(3);
	if (type === "global") return undefined;
	const field = RESOURCE_SCOPE_FIELD_BY_TYPE[type] as keyof InvocationScope;
	return context.scope[field];
}

interface PluginUiSessionRequestFence {
	controller: AbortController;
	revoked: boolean;
	timedOut: boolean;
	externallyCancelled: boolean;
	commitStarted: boolean;
	reason?: string;
}

interface AbortableCallOptions {
	signal: AbortSignal;
}

export class PluginUiHost {
	private readonly publicApi?: PluginPublicApi;
	private readonly capabilityBroker: Pick<CapabilityBroker, "authorize"> &
		Partial<Pick<CapabilityBroker, "withCallContext">>;
	private readonly eventGateway: Pick<PluginEventGateway, "subscribe" | "unsubscribe" | "poll"> &
		Partial<Pick<PluginEventGateway, "revokeSession">>;
	private readonly storageFactory: PluginStorageFactoryLike;
	private readonly subscriptions = new Map<string, string>();
	private readonly inFlightSessionRequests = new Map<string, Set<PluginUiSessionRequestFence>>();
	private readonly now: () => Date;
	private readonly timeoutMs: number;

	constructor(options: PluginUiHostOptions = {}) {
		this.publicApi = options.publicApi;
		this.capabilityBroker = options.capabilityBroker ?? defaultCapabilityBroker;
		this.eventGateway = options.eventGateway ?? pluginEventGateway;
		this.storageFactory = options.storageFactory ?? pluginStorageFactory;
		this.now = options.now ?? (() => new Date());
		this.timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? PLUGIN_UI_HOST_TIMEOUT_MS, 60_000));
	}

	async dispatch(input: PluginUiHostRequest): Promise<UiRpcResponse> {
		const fence = this.trackSessionRequest(input.session.sessionId);
		try {
			const request = uiRpcRequestSchema.safeParse(input.request);
			if (!request.success) {
				return makeResponse(
					isRecord(input.request) && typeof input.request.id === "string"
						? input.request.id
						: "invalid-request",
					undefined,
					new PluginUiHostError("INVALID_PARAMS", "Invalid Plugin UI request envelope"),
				);
			}
			if (jsonBytes(request.data) > PLUGIN_UI_HOST_REQUEST_MAX_BYTES) {
				return makeResponse(
					request.data.id,
					undefined,
					new PluginUiHostError("PAYLOAD_TOO_LARGE", "Plugin UI request exceeds the byte limit"),
				);
			}
			try {
				const result = await this.withDeadline(input.signal, fence, (signal) =>
					this.dispatchMethod({ ...input, request: request.data, signal }, fence),
				);
				if (!fence.commitStarted) this.assertSessionRequestActive(fence);
				const response = makeResponse(request.data.id, result);
				if (jsonBytes(response) > PLUGIN_UI_HOST_RESPONSE_MAX_BYTES)
					throw new PluginUiHostError(
						"PAYLOAD_TOO_LARGE",
						"Plugin UI response exceeds the byte limit",
					);
				return response;
			} catch (error) {
				const response = makeResponse(request.data.id, undefined, hostError(error));
				if (jsonBytes(response) > PLUGIN_UI_HOST_RESPONSE_MAX_BYTES) {
					return makeResponse(
						request.data.id,
						undefined,
						new PluginUiHostError(
							"INTERNAL_ERROR",
							"Plugin UI error response exceeds the byte limit",
						),
					);
				}
				return response;
			}
		} finally {
			this.releaseSessionRequest(input.session.sessionId, fence);
		}
	}

	revokeSession(sessionId: string, reason = "session-revoked"): number {
		for (const fence of this.inFlightSessionRequests.get(sessionId) ?? []) {
			fence.revoked = true;
			fence.reason = reason;
			fence.controller.abort(reason);
		}
		let revoked = this.eventGateway.revokeSession?.(sessionId) ?? 0;
		for (const [subscriptionId, ownerSessionId] of [...this.subscriptions]) {
			if (ownerSessionId !== sessionId) continue;
			this.subscriptions.delete(subscriptionId);
			if (!this.eventGateway.revokeSession) {
				revoked += this.eventGateway.unsubscribe(subscriptionId, reason) ? 1 : 0;
			}
		}
		return revoked;
	}

	private async dispatchMethod(
		input: PluginUiHostRequest,
		fence: PluginUiSessionRequestFence,
	): Promise<JsonValue> {
		const context = this.createContext(input);
		await this.authorizeUiPanel(context, input.request);
		this.assertSessionRequestActive(fence);
		switch (input.request.method) {
			case "queries.execute":
				return this.query(context, input.request.params, input.signal, fence);
			case "commands.execute":
				return this.command(context, input.request.params, input.signal, fence);
			case "events.subscribe":
				return this.subscribeEvents(context, input, fence);
			case "events.unsubscribe":
				return this.unsubscribeEvents(input);
			case "events.poll":
				return this.pollEvents(input);
			case "storage.get":
				return this.storage("get", context, input.request.params, input.signal, fence);
			case "storage.set":
				return this.storage("set", context, input.request.params, input.signal, fence);
			case "storage.delete":
				return this.storage("delete", context, input.request.params, input.signal, fence);
			case "storage.list":
				return this.storage("list", context, input.request.params, input.signal, fence);
			case "diagnostics.getOwn":
				return this.diagnostics(context, input);
			case "context.get":
				return this.context(input);
			default:
				throw new PluginUiHostError(
					"METHOD_NOT_FOUND",
					`Plugin UI host method is not supported: ${input.request.method}`,
				);
		}
	}

	private trackSessionRequest(sessionId: string): PluginUiSessionRequestFence {
		const fence: PluginUiSessionRequestFence = {
			controller: new AbortController(),
			revoked: false,
			timedOut: false,
			externallyCancelled: false,
			commitStarted: false,
		};
		let requests = this.inFlightSessionRequests.get(sessionId);
		if (!requests) {
			requests = new Set();
			this.inFlightSessionRequests.set(sessionId, requests);
		}
		requests.add(fence);
		return fence;
	}

	private releaseSessionRequest(sessionId: string, fence: PluginUiSessionRequestFence): void {
		const requests = this.inFlightSessionRequests.get(sessionId);
		if (!requests) return;
		requests.delete(fence);
		if (requests.size === 0) this.inFlightSessionRequests.delete(sessionId);
	}

	private assertSessionRequestActive(fence: PluginUiSessionRequestFence): void {
		if (fence.revoked) {
			throw new PluginUiHostError(
				"CANCELLED",
				fence.reason
					? `Plugin UI session was removed: ${fence.reason}`
					: "Plugin UI session was removed",
			);
		}
		if (fence.timedOut) {
			throw new PluginUiHostError("TIMEOUT", "Plugin UI host request timed out");
		}
		if (fence.externallyCancelled || fence.controller.signal.aborted) {
			throw new PluginUiHostError("CANCELLED", "Plugin UI request was cancelled");
		}
	}

	private subscriptionCancellationReason(fence: PluginUiSessionRequestFence): string {
		if (fence.revoked) return fence.reason ?? "session-revoked";
		if (fence.timedOut) return "request-timeout";
		if (fence.externallyCancelled) return "request-cancelled";
		return "request-aborted";
	}

	private beginUncancellableCommit(fence: PluginUiSessionRequestFence): void {
		this.assertSessionRequestActive(fence);
		fence.commitStarted = true;
	}

	private createContext(input: PluginUiHostRequest): HostCallContext {
		const plugin: PluginPrincipal = {
			pluginId: input.session.pluginId,
			packageVersion: input.session.version,
			runtimeId: `ui:${input.session.sessionId}`,
			runtimeGeneration: input.session.generation,
			contributionId: input.session.contributionId,
			installationId: input.session.hash,
		};
		const contextInput = {
			requestId: input.request.id,
			correlationId: `ui:${input.session.sessionId}:${input.request.id}`.slice(0, 128),
			deadlineAt: new Date(this.now().getTime() + this.timeoutMs).toISOString(),
			plugin,
			invocation: {
				kind: "user" as const,
				userId: input.principalId,
				userRole: input.userRole,
				source: "ui",
			},
			scope: { userId: input.principalId, ...(input.session.scope ?? {}) },
		};
		return this.capabilityBroker.withCallContext
			? this.capabilityBroker.withCallContext(contextInput)
			: defaultCapabilityBroker.withCallContext(contextInput);
	}

	private async authorizeUiPanel(context: HostCallContext, request: UiRpcRequest): Promise<void> {
		const decision = await this.capabilityBroker.authorize({
			context,
			capability: "ui.panel",
			methodId: request.method,
			requestBytes: jsonBytes(request),
			responseBytes: 0,
		});
		if (!decision.allowed) {
			const code = decision.error?.code ?? "PERMISSION_DENIED";
			throw new PluginUiHostError(
				code === "PLUGIN_DISABLED" ? "PLUGIN_DISABLED" : "PERMISSION_DENIED",
				"Plugin UI host capability is not granted",
			);
		}
	}

	private async query(
		context: HostCallContext,
		raw: unknown,
		signal: AbortSignal | undefined,
		fence: PluginUiSessionRequestFence,
	): Promise<JsonValue> {
		if (!this.publicApi)
			throw new PluginUiHostError("HOST_UNAVAILABLE", "Plugin query API is unavailable");
		const parsed = queryInputSchema.safeParse(raw);
		if (!parsed.success) throw new PluginUiHostError("INVALID_PARAMS", "Invalid query parameters");
		this.assertSessionRequestActive(fence);
		const query = this.publicApi.query as unknown as (
			context: HostCallContext,
			request: ReturnType<typeof createQueryRequest>,
			options: AbortableCallOptions,
		) => ReturnType<PluginPublicApi["query"]>;
		const result = await query.call(
			this.publicApi,
			context,
			createQueryRequest(context, parsed.data.queryId, parsed.data.input ?? null),
			{ signal: signal ?? fence.controller.signal },
		);
		this.assertSessionRequestActive(fence);
		if (result.status === "failed") throw publicErrorToHostError(result.error);
		return result as unknown as JsonValue;
	}

	private async command(
		context: HostCallContext,
		raw: unknown,
		signal: AbortSignal | undefined,
		fence: PluginUiSessionRequestFence,
	): Promise<JsonValue> {
		if (!this.publicApi)
			throw new PluginUiHostError("HOST_UNAVAILABLE", "Plugin command API is unavailable");
		const parsed = commandInputSchema.safeParse(raw);
		if (!parsed.success)
			throw new PluginUiHostError("INVALID_PARAMS", "Invalid command parameters");
		this.beginUncancellableCommit(fence);
		const command = this.publicApi.command as unknown as (
			context: HostCallContext,
			request: ReturnType<typeof createCommandRequest>,
			options: AbortableCallOptions,
		) => ReturnType<PluginPublicApi["command"]>;
		try {
			const result = await command.call(
				this.publicApi,
				context,
				createCommandRequest(context, parsed.data.commandId, parsed.data.input ?? null, {
					idempotencyKey: parsed.data.idempotencyKey,
					expectedVersion: parsed.data.expectedVersion,
				}),
				{ signal: signal ?? fence.controller.signal },
			);
			if (result.status === "failed" || result.status === "cancelled")
				throw publicErrorToHostError(result.error);
			return result as unknown as JsonValue;
		} catch (error) {
			if (fence.controller.signal.aborted) this.assertSessionRequestActive(fence);
			throw error;
		}
	}

	private async subscribeEvents(
		context: HostCallContext,
		input: PluginUiHostRequest,
		fence: PluginUiSessionRequestFence,
	): Promise<JsonValue> {
		if (!isRecord(input.request.params))
			throw new PluginUiHostError("INVALID_PARAMS", "Invalid event subscription parameters");
		const principal: PluginEventPrincipal = {
			pluginId: input.session.pluginId,
			installationId: input.session.hash,
			packageVersion: input.session.version,
			runtimeId: `ui:${input.session.sessionId}`,
			generation: input.session.generation,
			sessionId: input.session.sessionId,
			contributionId: input.session.contributionId,
		};
		const params = { ...input.request.params } as Record<string, unknown>;
		delete params.plugin;
		delete params.principal;
		delete params.pluginId;
		delete params.runtimeId;
		delete params.generation;
		delete params.sessionId;
		delete params.contributionId;
		delete params.packageVersion;
		delete params.currentScope;
		this.assertSessionRequestActive(fence);
		const subscribe = this.eventGateway.subscribe as unknown as (
			request: Parameters<PluginEventGateway["subscribe"]>[0],
			options: AbortableCallOptions,
		) => ReturnType<PluginEventGateway["subscribe"]>;
		const result = await subscribe.call(
			this.eventGateway,
			{
				...params,
				principal,
				invocationScope: context.scope,
			} as never,
			{ signal: input.signal ?? fence.controller.signal },
		);
		try {
			this.assertSessionRequestActive(fence);
		} catch (error) {
			this.eventGateway.unsubscribe(
				result.subscriptionId,
				this.subscriptionCancellationReason(fence),
			);
			throw error;
		}
		this.subscriptions.set(result.subscriptionId, input.session.sessionId);
		return result as unknown as JsonValue;
	}

	private unsubscribeEvents(input: PluginUiHostRequest): JsonValue {
		const parsed = subscriptionInputSchema.safeParse(input.request.params);
		if (!parsed.success)
			throw new PluginUiHostError("INVALID_PARAMS", "Invalid subscription parameters");
		if (this.subscriptions.get(parsed.data.subscriptionId) !== input.session.sessionId)
			throw new PluginUiHostError("NOT_FOUND", "Event subscription was not found");
		this.subscriptions.delete(parsed.data.subscriptionId);
		return this.eventGateway.unsubscribe(parsed.data.subscriptionId);
	}

	private pollEvents(input: PluginUiHostRequest): JsonValue {
		const parsed = z
			.object({
				subscriptionId: z.string().trim().min(1).max(128),
				limit: z.number().int().min(1).max(100).optional(),
			})
			.strict()
			.safeParse(input.request.params);
		if (!parsed.success)
			throw new PluginUiHostError("INVALID_PARAMS", "Invalid event poll parameters");
		if (this.subscriptions.get(parsed.data.subscriptionId) !== input.session.sessionId)
			throw new PluginUiHostError("NOT_FOUND", "Event subscription was not found");
		return this.eventGateway.poll(
			parsed.data.subscriptionId,
			parsed.data.limit ?? 100,
		) as unknown as JsonValue;
	}

	private async storage(
		method: "get" | "set" | "delete" | "list",
		context: HostCallContext,
		raw: unknown,
		signal: AbortSignal | undefined,
		fence: PluginUiSessionRequestFence,
	): Promise<JsonValue> {
		if (!isRecord(raw)) throw new PluginUiHostError("INVALID_PARAMS", "Invalid storage parameters");
		const scopeValue = raw.scope;
		const scopeType =
			isRecord(scopeValue) && typeof scopeValue.type === "string"
				? scopeValue.type
				: typeof raw.scopeType === "string"
					? raw.scopeType
					: undefined;
		const scopeId =
			isRecord(scopeValue) && typeof scopeValue.id === "string"
				? scopeValue.id
				: typeof raw.scopeId === "string"
					? raw.scopeId
					: undefined;
		if (!(PLUGIN_STORAGE_SCOPE_TYPES as readonly unknown[]).includes(scopeType)) {
			throw new PluginUiHostError("INVALID_PARAMS", "Invalid storage scope");
		}
		const parsedScope = resourceScopeSchema.safeParse({
			type: scopeType,
			...(scopeId === undefined ? {} : { id: scopeId }),
		});
		if (!parsedScope.success) {
			throw new PluginUiHostError("INVALID_PARAMS", "Invalid storage scope");
		}
		const scope = parsedScope.data as PluginStorageScope;
		if (scope.type !== "global" && scope.id !== boundStorageScopeId(scope.type, context)) {
			throw new PluginUiHostError(
				"PERMISSION_DENIED",
				"Storage scope is outside the bound UI session",
			);
		}
		const capability =
			method === "get" || method === "list" ? "storage.read_self" : "storage.write_self";
		this.assertSessionRequestActive(fence);
		const decision = await this.capabilityBroker.authorize({
			context,
			capability,
			methodId: `storage.${method}`,
			scope: scopeForStorage(scope),
			requestBytes: jsonBytes(raw),
			responseBytes: 0,
		});
		if (!decision.allowed)
			throw new PluginUiHostError("PERMISSION_DENIED", "Plugin storage access denied");
		this.assertSessionRequestActive(fence);
		const storage = resolvePluginStorage(this.storageFactory, context.plugin.pluginId);
		const activeSignal = signal ?? fence.controller.signal;
		if (activeSignal.aborted) this.assertSessionRequestActive(fence);
		if (method === "get") {
			const result = ((await storage.get(raw as never)) ?? null) as JsonValue;
			this.assertSessionRequestActive(fence);
			return result;
		}
		if (method === "list") {
			const result = (await storage.list(raw as never)) as unknown as JsonValue;
			this.assertSessionRequestActive(fence);
			return result;
		}
		this.beginUncancellableCommit(fence);
		try {
			if (method === "set") return (await storage.set(raw as never)) as unknown as JsonValue;
			return (await storage.delete(raw as never)) as JsonValue;
		} catch (error) {
			if (activeSignal.aborted) this.assertSessionRequestActive(fence);
			throw error;
		}
	}

	private async diagnostics(
		context: HostCallContext,
		input: PluginUiHostRequest,
	): Promise<JsonValue> {
		const decision = await this.capabilityBroker.authorize({
			context,
			capability: "diagnostics.readOwnLogs",
			methodId: "diagnostics.getOwn",
			requestBytes: jsonBytes(input.request),
			responseBytes: 0,
		});
		if (!decision.allowed) {
			throw new PluginUiHostError(
				decision.error?.code === "PLUGIN_DISABLED" ? "PLUGIN_DISABLED" : "PERMISSION_DENIED",
				"Plugin diagnostics access denied",
			);
		}
		return {
			plugin: {
				pluginId: context.plugin.pluginId,
				packageVersion: context.plugin.packageVersion,
				installationId: context.plugin.installationId,
				runtimeId: context.plugin.runtimeId,
				runtimeGeneration: context.plugin.runtimeGeneration,
				contributionId: context.plugin.contributionId ?? null,
			},
			session: {
				sessionId: input.session.sessionId,
				panelInstanceId: input.session.panelInstanceId,
				surface: input.session.surface,
			},
		};
	}

	private context(input: PluginUiHostRequest): JsonValue {
		return {
			contextVersion: 1,
			host: { appVersion: "unknown", locale: "unknown", colorScheme: "dark", platform: "unknown" },
			plugin: {
				id: input.session.pluginId,
				version: input.session.version,
				contributionId: input.session.contributionId,
				panelInstanceId: input.session.panelInstanceId,
			},
			surface: {
				kind:
					input.session.surface === "focus"
						? "narrator-focus"
						: input.session.surface === "director"
							? "director"
							: input.session.surface === "settings"
								? "settings"
								: "workspace",
				active: true,
				visible: true,
			},
			route: { routeId: "plugin-ui" },
		};
	}

	private async withDeadline<T>(
		signal: AbortSignal | undefined,
		fence: PluginUiSessionRequestFence,
		operation: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const onAbort = () => {
			fence.externallyCancelled = true;
			fence.controller.abort(signal?.reason);
		};
		if (signal?.aborted) {
			onAbort();
			this.assertSessionRequestActive(fence);
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => {
			fence.timedOut = true;
			fence.controller.abort(new PluginUiHostError("TIMEOUT", "Plugin UI host request timed out"));
		}, this.timeoutMs);
		try {
			return await Promise.race([
				operation(fence.controller.signal),
				new Promise<T>((_, reject) => {
					fence.controller.signal.addEventListener(
						"abort",
						() => {
							if (fence.commitStarted) return;
							try {
								this.assertSessionRequestActive(fence);
							} catch (error) {
								reject(error);
							}
						},
						{ once: true },
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}
}

export const pluginUiHost = new PluginUiHost();
