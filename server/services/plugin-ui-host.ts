import { z } from "zod";
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
import { type PluginEventGateway, pluginEventGateway } from "./plugin-event-gateway";
import {
	createCommandRequest,
	createQueryRequest,
	type PluginPublicApi,
	type PublicApiError,
} from "./plugin-public-api";
import { PluginStorage } from "./plugin-storage";
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
	capabilityBroker?: Pick<CapabilityBroker, "authorize">;
	eventGateway?: Pick<PluginEventGateway, "subscribe" | "unsubscribe" | "poll">;
	storageFactory?: (pluginId: string) => PluginStorage;
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

function scopeForStorage(type: string, id: string | undefined): InvocationScope {
	switch (type) {
		case "user":
			return id ? { userId: id } : {};
		case "project":
			return id ? { projectId: id } : {};
		case "workspace":
			return id ? { workspaceId: id } : {};
		case "chapter":
			return id ? { chapterId: id } : {};
		case "narrator":
			return id ? { narratorId: id } : {};
		case "provider":
			return id ? { providerInstanceId: id } : {};
		case "device":
			return id ? { deviceId: id } : {};
		default:
			return {};
	}
}

function boundStorageScopeId(type: string, context: HostCallContext): string | undefined {
	switch (type) {
		case "session":
			return context.plugin.runtimeId.slice(3);
		case "user":
			return context.scope.userId;
		case "project":
			return context.scope.projectId;
		case "workspace":
			return context.scope.workspaceId;
		case "chapter":
			return context.scope.chapterId;
		case "narrator":
			return context.scope.narratorId;
		case "provider":
			return context.scope.providerInstanceId;
		case "device":
			return context.scope.deviceId;
		default:
			return undefined;
	}
}

export class PluginUiHost {
	private readonly publicApi?: PluginPublicApi;
	private readonly capabilityBroker: Pick<CapabilityBroker, "authorize">;
	private readonly eventGateway: Pick<PluginEventGateway, "subscribe" | "unsubscribe" | "poll">;
	private readonly storageFactory: (pluginId: string) => PluginStorage;
	private readonly storages = new Map<string, PluginStorage>();
	private readonly subscriptions = new Map<string, string>();
	private readonly now: () => Date;
	private readonly timeoutMs: number;

	constructor(options: PluginUiHostOptions = {}) {
		this.publicApi = options.publicApi;
		this.capabilityBroker = options.capabilityBroker ?? defaultCapabilityBroker;
		this.eventGateway = options.eventGateway ?? pluginEventGateway;
		this.storageFactory = options.storageFactory ?? ((pluginId) => new PluginStorage({ pluginId }));
		this.now = options.now ?? (() => new Date());
		this.timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? PLUGIN_UI_HOST_TIMEOUT_MS, 60_000));
	}

	async dispatch(input: PluginUiHostRequest): Promise<UiRpcResponse> {
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
			const result = await this.withDeadline(input.signal, (signal) =>
				this.dispatchMethod({ ...input, request: request.data, signal }),
			);
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
	}

	private async dispatchMethod(input: PluginUiHostRequest): Promise<JsonValue> {
		const context = this.createContext(input);
		await this.authorizeUiPanel(context, input.request);
		switch (input.request.method) {
			case "queries.execute":
				return this.query(context, input.request.params);
			case "commands.execute":
				return this.command(context, input.request.params);
			case "events.subscribe":
				return this.subscribeEvents(context, input);
			case "events.unsubscribe":
				return this.unsubscribeEvents(input);
			case "events.poll":
				return this.pollEvents(input);
			case "storage.get":
				return this.storage("get", context, input.request.params);
			case "storage.set":
				return this.storage("set", context, input.request.params);
			case "storage.delete":
				return this.storage("delete", context, input.request.params);
			case "storage.list":
				return this.storage("list", context, input.request.params);
			case "context.get":
				return this.context(input);
			default:
				throw new PluginUiHostError(
					"METHOD_NOT_FOUND",
					`Plugin UI host method is not supported: ${input.request.method}`,
				);
		}
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
		return defaultCapabilityBroker.withCallContext({
			requestId: input.request.id,
			correlationId: `ui:${input.session.sessionId}:${input.request.id}`.slice(0, 128),
			deadlineAt: new Date(this.now().getTime() + this.timeoutMs).toISOString(),
			plugin,
			invocation: {
				kind: "user",
				userId: input.principalId,
				userRole: input.userRole,
				source: "ui",
			},
			scope: { userId: input.principalId, ...(input.session.scope ?? {}) },
		});
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

	private async query(context: HostCallContext, raw: unknown): Promise<JsonValue> {
		if (!this.publicApi)
			throw new PluginUiHostError("HOST_UNAVAILABLE", "Plugin query API is unavailable");
		const parsed = queryInputSchema.safeParse(raw);
		if (!parsed.success) throw new PluginUiHostError("INVALID_PARAMS", "Invalid query parameters");
		const result = await this.publicApi.query(
			context,
			createQueryRequest(context, parsed.data.queryId, parsed.data.input ?? null),
		);
		if (result.status === "failed") throw publicErrorToHostError(result.error);
		return result as unknown as JsonValue;
	}

	private async command(context: HostCallContext, raw: unknown): Promise<JsonValue> {
		if (!this.publicApi)
			throw new PluginUiHostError("HOST_UNAVAILABLE", "Plugin command API is unavailable");
		const parsed = commandInputSchema.safeParse(raw);
		if (!parsed.success)
			throw new PluginUiHostError("INVALID_PARAMS", "Invalid command parameters");
		const result = await this.publicApi.command(
			context,
			createCommandRequest(context, parsed.data.commandId, parsed.data.input ?? null, {
				idempotencyKey: parsed.data.idempotencyKey,
				expectedVersion: parsed.data.expectedVersion,
			}),
		);
		if (result.status === "failed" || result.status === "cancelled")
			throw publicErrorToHostError(result.error);
		return result as unknown as JsonValue;
	}

	private async subscribeEvents(
		context: HostCallContext,
		input: PluginUiHostRequest,
	): Promise<JsonValue> {
		if (!isRecord(input.request.params))
			throw new PluginUiHostError("INVALID_PARAMS", "Invalid event subscription parameters");
		const principal: PluginPrincipal = {
			pluginId: input.session.pluginId,
			packageVersion: input.session.version,
			runtimeId: `ui:${input.session.sessionId}`,
			runtimeGeneration: input.session.generation,
			contributionId: input.session.contributionId,
			installationId: input.session.hash,
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
		const result = await this.eventGateway.subscribe({
			...params,
			principal,
			invocationScope: context.scope,
		} as never);
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
		if (!scopeType) throw new PluginUiHostError("INVALID_PARAMS", "Storage scope is required");
		if (
			![
				"global",
				"session",
				"user",
				"project",
				"workspace",
				"chapter",
				"narrator",
				"provider",
				"device",
			].includes(scopeType)
		) {
			throw new PluginUiHostError("INVALID_PARAMS", "Invalid storage scope");
		}
		if (scopeType === "global") {
			if (scopeId !== undefined)
				throw new PluginUiHostError("INVALID_PARAMS", "Global storage must not include a scope id");
		} else if (!scopeId || scopeId !== boundStorageScopeId(scopeType, context)) {
			throw new PluginUiHostError(
				"PERMISSION_DENIED",
				"Storage scope is outside the bound UI session",
			);
		}
		const capability =
			method === "get" || method === "list" ? "storage.read_self" : "storage.write_self";
		const decision = await this.capabilityBroker.authorize({
			context,
			capability,
			methodId: `storage.${method}`,
			scope: scopeForStorage(scopeType, scopeId),
			requestBytes: jsonBytes(raw),
			responseBytes: 0,
		});
		if (!decision.allowed)
			throw new PluginUiHostError("PERMISSION_DENIED", "Plugin storage access denied");
		const pluginId = context.plugin.pluginId;
		let storage = this.storages.get(pluginId);
		if (!storage) {
			storage = this.storageFactory(pluginId);
			this.storages.set(pluginId, storage);
		}
		if (method === "get") return ((await storage.get(raw as never)) ?? null) as JsonValue;
		if (method === "set") return (await storage.set(raw as never)) as unknown as JsonValue;
		if (method === "delete") return (await storage.delete(raw as never)) as JsonValue;
		return (await storage.list(raw as never)) as unknown as JsonValue;
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
		operation: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		if (signal?.aborted)
			throw new PluginUiHostError("CANCELLED", "Plugin UI request was cancelled");
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			return await Promise.race([
				operation(controller.signal),
				new Promise<T>((_, reject) =>
					controller.signal.addEventListener(
						"abort",
						() =>
							reject(
								new PluginUiHostError(
									signal?.aborted ? "CANCELLED" : "TIMEOUT",
									"Plugin UI host request timed out",
								),
							),
						{ once: true },
					),
				),
			]);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}
}

export const pluginUiHost = new PluginUiHost();
