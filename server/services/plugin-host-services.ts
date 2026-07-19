import { dirname, join } from "node:path";
import { logger } from "@server/lib/logger";
import { type JsonRpcRequest, type JsonValue, jsonValueSchema } from "@server/lib/plugins/protocol";
import { z } from "zod";
import {
	type CapabilityBroker,
	capabilityBroker as defaultCapabilityBroker,
	type HostCallContext,
	type InvocationPrincipal,
	type InvocationScope,
	type PluginCapabilityBindingInput,
	type PluginPrincipal,
} from "./plugin-capability-broker";
import {
	type PluginHostAuditEntry,
	type PluginHostAuthorizationDecision,
	type PluginHostCallContext,
	PluginHostDispatcher,
	PluginHostDispatcherError,
	type PluginHostDispatcherOptions,
	type PluginHostResolverInput,
} from "./plugin-host-dispatcher";
import {
	type PluginPermissionStore,
	permissionGrantPayload,
	type StoredPermissionGrant,
} from "./plugin-permission-store";
import type { RuntimeDiagnostics } from "./plugin-runtime";
import { PluginStorage } from "./plugin-storage";

const MAX_AUDIT_ENTRIES = 256;
const MAX_DIAGNOSTIC_ITEMS = 32;
const MAX_DIAGNOSTIC_TEXT = 1_000;
const MAX_QUERY_ID = 200;
const MAX_STORAGE_KEY = 256;

const emptyParamsSchema = z.object({}).strict().optional();
const queryParamsSchema = z
	.object({
		queryId: z.string().trim().min(1).max(MAX_QUERY_ID),
		input: jsonValueSchema.optional(),
	})
	.strict();
const storageGetParamsSchema = z
	.object({
		scopeType: z.string().trim().min(1).max(32).optional(),
		scopeId: z.string().trim().min(1).max(256).optional(),
		key: z.string().trim().min(1).max(MAX_STORAGE_KEY),
	})
	.strict();
const storageListParamsSchema = z
	.object({
		scopeType: z.string().trim().min(1).max(32).optional(),
		scopeId: z.string().trim().min(1).max(256).optional(),
		prefix: z.string().trim().max(MAX_STORAGE_KEY).optional(),
		cursor: z.string().trim().max(4_096).optional(),
		limit: z.number().int().positive().max(100).optional(),
	})
	.strict();

export interface PluginHostRuntimeBindingInput {
	pluginId: string;
	packageVersion: string;
	installationId: string;
	runtimeId: string;
	runtimeGeneration: number;
	grantRevision: number;
	desiredState: "disabled" | "enabled" | "uninstalling";
	compatibilityState: "unknown" | "compatible" | "incompatible";
	runtimeState: string;
	trustTier?: "T0" | "T1" | "T2" | "T3";
	manifestRequested: readonly string[];
	grants: readonly StoredPermissionGrant[];
	contributionId?: string;
	dataPath?: string;
	packagePath?: string;
	dispatcher?: PluginHostDispatcher;
	getDiagnostics?: () => RuntimeDiagnostics | undefined;
	queryHandler?: PluginHostQueryHandler;
}

export interface PluginHostQueryHandlerInput {
	queryId: string;
	input: JsonValue | undefined;
	context: PluginHostCallContext;
}

export type PluginHostQueryHandler = (
	input: PluginHostQueryHandlerInput,
) => JsonValue | Promise<JsonValue>;

export interface PluginHostServicesOptions {
	capabilityBroker?: CapabilityBroker;
	permissionStore?: PluginPermissionStore;
	storageRoot?: string;
	queryHandler?: PluginHostQueryHandler;
	diagnosticsHandler?: (input: {
		context: PluginHostCallContext;
		binding: PluginHostRuntimeBinding;
	}) => JsonValue | Promise<JsonValue>;
	auditSink?: (entry: PluginHostAuditEntry) => void | Promise<void>;
	now?: () => Date;
}

export interface PluginHostRuntimeBinding {
	plugin: PluginPrincipal;
	grantRevision: number;
	grants: StoredPermissionGrant[];
	binding: PluginCapabilityBindingInput;
	dispatcher: PluginHostDispatcher;
	createdAt: string;
}

export interface PluginHostServicesDiagnostics {
	bindings: Array<{
		pluginId: string;
		runtimeId: string;
		generation: number;
		grantRevision: number;
		capabilities: string[];
		createdAt: string;
	}>;
	auditEntries: PluginHostAuditEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function bindingKey(pluginId: string, runtimeId: string): string {
	return `${pluginId} ${runtimeId}`;
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

function baseGrant(grant: StoredPermissionGrant) {
	return permissionGrantPayload(grant);
}

function jsonBytes(value: unknown): number {
	try {
		const json = JSON.stringify(value);
		return json === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(json, "utf8");
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function sanitizeText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value
		.replace(/(?:Bearer\s+)[A-Za-z0-9._~-]+/gi, "Bearer <redacted>")
		.replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
		.slice(-MAX_DIAGNOSTIC_TEXT);
}

function sanitizeRuntimeDiagnostics(
	value: RuntimeDiagnostics | undefined,
): Record<string, JsonValue> {
	if (!value) return { state: "unavailable" };
	return {
		pluginId: value.pluginId,
		...(value.pluginVersion === undefined ? {} : { pluginVersion: value.pluginVersion }),
		runtimeId: value.runtimeId,
		generation: value.generation,
		state: value.state,
		inFlight: value.inFlight,
		...(value.outboundPending === undefined ? {} : { outboundPending: value.outboundPending }),
		...(value.inboundActive === undefined ? {} : { inboundActive: value.inboundActive }),
		...(value.queuedBytes === undefined ? {} : { queuedBytes: value.queuedBytes }),
		...(value.queuedMessages === undefined ? {} : { queuedMessages: value.queuedMessages }),
		lateMessages: value.lateMessages,
		capabilities: value.capabilities.slice(0, MAX_DIAGNOSTIC_ITEMS),
		...(value.features ? { features: value.features.slice(0, MAX_DIAGNOSTIC_ITEMS) } : {}),
		...(value.lastError
			? {
					lastError: {
						...(value.lastError.code ? { code: value.lastError.code } : {}),
						message: sanitizeText(value.lastError.message) ?? "Runtime error",
						...(value.lastError.phase ? { phase: value.lastError.phase } : {}),
					},
				}
			: {}),
		...(value.startedAt ? { startedAt: value.startedAt } : {}),
		...(value.stoppedAt ? { stoppedAt: value.stoppedAt } : {}),
	};
}

function effectiveGrants(
	manifestRequested: readonly string[],
	grants: readonly StoredPermissionGrant[],
): StoredPermissionGrant[] {
	const requested = new Set(manifestRequested);
	return grants.filter((grant) => requested.has(grant.capability));
}

function capabilityForMethod(input: PluginHostResolverInput): string | undefined {
	switch (input.method) {
		case "diagnostics.getOwn":
			return "diagnostics.readOwnLogs";
		case "storage.get":
		case "storage.list":
			return "storage.read_self";
		case "queries.execute":
			return "query.read.audit_self";
		default:
			return input.capability;
	}
}

function resourceFromUnknown(value: unknown):
	| {
			type: "user" | "project" | "workspace" | "chapter" | "narrator" | "provider" | "device";
			id: string;
	  }
	| undefined {
	if (!isRecord(value) || typeof value.type !== "string" || typeof value.id !== "string")
		return undefined;
	if (
		!["user", "project", "workspace", "chapter", "narrator", "provider", "device"].includes(
			value.type,
		)
	) {
		return undefined;
	}
	return { type: value.type as never, id: value.id };
}

/**
 * C2 composition root for backend plugin Host APIs. It owns runtime bindings and never creates a
 * dispatcher that can authorize without a matching CapabilityBroker binding.
 */
export class PluginHostServices {
	readonly capabilityBroker: CapabilityBroker;
	readonly permissionStore?: PluginPermissionStore;
	private readonly storageRoot?: string;
	private readonly queryHandler?: PluginHostQueryHandler;
	private readonly diagnosticsHandler?: PluginHostServicesOptions["diagnosticsHandler"];
	private readonly auditSink?: PluginHostServicesOptions["auditSink"];
	private readonly now: () => Date;
	private readonly bindings = new Map<string, PluginHostRuntimeBinding>();
	private readonly runtimeInputs = new Map<string, PluginHostRuntimeBindingInput>();
	private readonly dispatchers = new Map<string, PluginHostDispatcher>();
	private readonly auditEntries: PluginHostAuditEntry[] = [];

	constructor(options: PluginHostServicesOptions = {}) {
		this.capabilityBroker = options.capabilityBroker ?? defaultCapabilityBroker;
		this.permissionStore = options.permissionStore;
		this.storageRoot = options.storageRoot;
		this.queryHandler = options.queryHandler;
		this.diagnosticsHandler = options.diagnosticsHandler;
		this.auditSink = options.auditSink;
		this.now = options.now ?? (() => new Date());
	}

	bindRuntime(input: PluginHostRuntimeBindingInput): PluginHostRuntimeBinding {
		if (!Number.isSafeInteger(input.runtimeGeneration) || input.runtimeGeneration < 0) {
			throw new Error("Runtime binding generation is invalid");
		}
		if (!Number.isSafeInteger(input.grantRevision) || input.grantRevision < 0) {
			throw new Error("Runtime binding grant revision is invalid");
		}
		const plugin: PluginPrincipal = {
			pluginId: input.pluginId,
			packageVersion: input.packageVersion,
			runtimeId: input.runtimeId,
			runtimeGeneration: input.runtimeGeneration,
			installationId: input.installationId,
			...(input.contributionId ? { contributionId: input.contributionId } : {}),
		};
		const selectedGrants = effectiveGrants(input.manifestRequested, input.grants);
		const capabilities = uniqueStrings(selectedGrants.map((grant) => grant.capability));
		const brokerGrants = selectedGrants.map(baseGrant);
		const binding: PluginCapabilityBindingInput = {
			plugin,
			desiredState: input.desiredState,
			compatibilityState: input.compatibilityState,
			runtimeState: input.runtimeState as never,
			trustTier: input.trustTier,
			runtimeGeneration: input.runtimeGeneration,
			manifestRequested: uniqueStrings(input.manifestRequested),
			installationGrants: brokerGrants,
			hostPolicy: capabilities,
			currentUserAuthority: capabilities,
			contributionPolicy: capabilities,
			runnerEnforcement: capabilities,
			grantRevision: input.grantRevision,
		};
		const key = bindingKey(input.pluginId, input.runtimeId);
		this.runtimeInputs.set(key, {
			...input,
			manifestRequested: [...input.manifestRequested],
			grants: input.grants.map((grant) => clone(grant)),
		});
		const existing = this.bindings.get(key);
		let dispatcher = input.dispatcher ?? existing?.dispatcher ?? this.dispatchers.get(key);
		if (!dispatcher) {
			dispatcher = this.createDispatcher(plugin);
		}
		dispatcher.setIdentity({
			pluginId: plugin.pluginId,
			packageVersion: plugin.packageVersion,
			installationId: plugin.installationId,
			runtimeId: plugin.runtimeId,
			runtimeGeneration: plugin.runtimeGeneration,
			...(plugin.contributionId ? { contributionId: plugin.contributionId } : {}),
		});
		this.capabilityBroker.setBinding(input.pluginId, binding);
		this.dispatchers.set(key, dispatcher);
		const record: PluginHostRuntimeBinding = {
			plugin,
			grantRevision: binding.grantRevision ?? 0,
			grants: input.grants.map((grant) => clone(grant)),
			binding,
			dispatcher,
			createdAt: existing?.createdAt ?? this.now().toISOString(),
		};
		this.bindings.set(key, record);
		return {
			...record,
			plugin: clone(record.plugin),
			grants: record.grants.map((grant) => clone(grant)),
			binding: clone(record.binding),
			dispatcher: record.dispatcher,
		};
	}

	/** Alias used by Manager/restart supervisors when a generation is replaced. */
	bindRuntimeGeneration(input: PluginHostRuntimeBindingInput): PluginHostRuntimeBinding {
		return this.bindRuntime(input);
	}

	getRuntimeBinding(pluginId: string, runtimeId: string): PluginHostRuntimeBinding | undefined {
		const value = this.bindings.get(bindingKey(pluginId, runtimeId));
		return value
			? {
					...value,
					plugin: clone(value.plugin),
					grants: value.grants.map((grant) => clone(grant)),
					binding: clone(value.binding),
					dispatcher: value.dispatcher,
				}
			: undefined;
	}

	hasRuntimeBinding(pluginId: string, runtimeId: string): boolean {
		return this.bindings.has(bindingKey(pluginId, runtimeId));
	}

	revokeRuntime(pluginId: string, runtimeId?: string, runtimeGeneration?: number): number {
		let revoked = 0;
		if (runtimeId) {
			const key = bindingKey(pluginId, runtimeId);
			const binding = this.bindings.get(key);
			if (
				binding &&
				(runtimeGeneration === undefined || binding.plugin.runtimeGeneration === runtimeGeneration)
			) {
				this.bindings.delete(key);
				this.runtimeInputs.delete(key);
				revoked += 1;
			}
			this.capabilityBroker.revokeRuntime(pluginId, runtimeId, runtimeGeneration);
			return revoked;
		}
		for (const [key, binding] of this.bindings) {
			if (binding.plugin.pluginId !== pluginId) continue;
			this.bindings.delete(key);
			this.runtimeInputs.delete(key);
			revoked += 1;
		}
		for (const key of this.runtimeInputs.keys()) {
			if (key.startsWith(`${pluginId} `)) this.runtimeInputs.delete(key);
		}
		this.capabilityBroker.clearBindingsForPlugin(pluginId);
		return revoked;
	}

	clearRuntimeBinding(pluginId: string, runtimeId: string): boolean {
		const key = bindingKey(pluginId, runtimeId);
		const deleted = this.bindings.delete(key);
		this.runtimeInputs.delete(key);
		this.capabilityBroker.clearBinding(pluginId, runtimeId);
		return deleted;
	}

	getDiagnostics(): PluginHostServicesDiagnostics {
		return {
			bindings: [...this.bindings.values()].map((binding) => ({
				pluginId: binding.plugin.pluginId,
				runtimeId: binding.plugin.runtimeId,
				generation: binding.plugin.runtimeGeneration,
				grantRevision: binding.grantRevision,
				capabilities: uniqueStrings(binding.grants.map((grant) => grant.capability)),
				createdAt: binding.createdAt,
			})),
			auditEntries: this.auditEntries.map((entry) => ({ ...entry })),
		};
	}

	private createDispatcher(plugin: PluginPrincipal): PluginHostDispatcher {
		const dispatcherOptions: PluginHostDispatcherOptions = {
			identity: plugin,
			invocation: { kind: "plugin_background", source: "internal" },
			scope: {},
			contextFactory: ({ request, requestId, correlationId, deadlineAt, signal, plugin }) =>
				this.createContext({
					request,
					requestId,
					correlationId,
					deadlineAt,
					signal,
					plugin,
				}),
			authorize: (resolverInput: PluginHostResolverInput) => this.authorize(resolverInput),
			audit: (entry) => this.recordAudit(entry),
			onLateResult: (entry) => this.recordAudit(entry),
			maxAuditEntries: MAX_AUDIT_ENTRIES,
			now: this.now,
			methods: {
				"queries.execute": {
					method: "queries.execute",
					paramsSchema: queryParamsSchema,
					resultSchema: jsonValueSchema,
					capability: "query.read.audit_self",
					maxRequestBytes: 256 * 1024,
					maxResponseBytes: 1024 * 1024,
					handler: (params, context) =>
						this.executeQuery(
							this.runtimeInput(context),
							params as z.infer<typeof queryParamsSchema>,
							context,
						),
				},
				"storage.get": {
					method: "storage.get",
					paramsSchema: storageGetParamsSchema,
					resultSchema: jsonValueSchema,
					capability: "storage.read_self",
					maxResponseBytes: 256 * 1024,
					handler: (params, context) =>
						this.storageGet(
							this.runtimeInput(context),
							params as z.infer<typeof storageGetParamsSchema>,
							context,
						),
				},
				"storage.list": {
					method: "storage.list",
					paramsSchema: storageListParamsSchema,
					resultSchema: jsonValueSchema,
					capability: "storage.read_self",
					maxResponseBytes: 256 * 1024,
					handler: (params, context) =>
						this.storageList(
							this.runtimeInput(context),
							params as z.infer<typeof storageListParamsSchema>,
							context,
						),
				},
				"diagnostics.getOwn": {
					method: "diagnostics.getOwn",
					paramsSchema: emptyParamsSchema,
					resultSchema: jsonValueSchema,
					capability: "diagnostics.readOwnLogs",
					maxResponseBytes: 256 * 1024,
					handler: (_params, context) =>
						this.getOwnDiagnostics(this.runtimeInput(context), context),
				},
			},
		};
		return new PluginHostDispatcher(dispatcherOptions);
	}

	private runtimeInput(context: PluginHostCallContext): PluginHostRuntimeBindingInput {
		const input = this.runtimeInputs.get(
			bindingKey(context.plugin.pluginId, context.plugin.runtimeId),
		);
		if (!input) {
			throw new PluginHostDispatcherError(
				"CONTEXT_UNAVAILABLE",
				"Plugin runtime binding is unavailable",
				{ retryable: true, data: { reason: "BINDING_MISSING" } },
			);
		}
		return input;
	}

	private createContext(input: {
		request: JsonRpcRequest;
		requestId: string | number;
		correlationId: string;
		deadlineAt: string;
		signal: AbortSignal;
		plugin: PluginPrincipal;
	}): PluginHostCallContext {
		const invocation: InvocationPrincipal = { kind: "plugin_background", source: "internal" };
		const scope: InvocationScope = {};
		let context: HostCallContext;
		try {
			context = this.capabilityBroker.withCallContext({
				requestId: String(input.requestId),
				correlationId: input.correlationId,
				deadlineAt: input.deadlineAt,
				plugin: input.plugin,
				invocation,
				scope,
			});
		} catch (error) {
			throw new PluginHostDispatcherError(
				"CONTEXT_UNAVAILABLE",
				"Plugin runtime binding is unavailable",
				{ retryable: true, data: { reason: "BINDING_MISSING" }, cause: error },
			);
		}
		return {
			...context,
			signal: input.signal,
			request: input.request,
			requestBytes: jsonBytes(input.request),
			method: input.request.method,
		};
	}

	private async authorize(
		input: PluginHostResolverInput,
	): Promise<PluginHostAuthorizationDecision> {
		const capability = capabilityForMethod(input);
		if (!capability) {
			return {
				allowed: false,
				code: "PERMISSION_DENIED",
				message: "Plugin Host method has no capability binding",
				data: { reason: "CAPABILITY_NOT_DECLARED" },
			};
		}
		try {
			const context: HostCallContext = {
				requestId: input.context.requestId,
				correlationId: input.context.correlationId,
				deadlineAt: input.context.deadlineAt,
				plugin: input.context.plugin,
				invocation: input.context.invocation,
				scope: input.context.scope,
			};
			const result = await this.capabilityBroker.authorize({
				context,
				capability,
				methodId: input.method,
				resource: resourceFromUnknown(input.resource),
				requestBytes: input.context.requestBytes,
			});
			if (result.allowed) return { allowed: true };
			const data: Record<string, JsonValue> = { reason: result.error.reason };
			if (result.error.diagnosticId) data.diagnosticId = result.error.diagnosticId;
			return {
				allowed: false,
				code: result.error.code,
				message: "Plugin capability request was denied",
				retryable: result.error.statusCode >= 500,
				data,
			};
		} catch {
			return {
				allowed: false,
				code: "PERMISSION_DENIED",
				message: "Plugin capability request was denied",
				data: { reason: "BROKER_UNAVAILABLE" },
			};
		}
	}

	private async executeQuery(
		input: PluginHostRuntimeBindingInput,
		params: { queryId: string; input?: JsonValue },
		context: PluginHostCallContext,
	): Promise<JsonValue> {
		const queryHandler = input.queryHandler ?? this.queryHandler;
		if (!queryHandler) {
			throw new PluginHostDispatcherError(
				"HOST_UNAVAILABLE",
				"Plugin query service is unavailable",
				{
					retryable: true,
				},
			);
		}
		return queryHandler({ queryId: params.queryId, input: params.input, context });
	}

	private async storageGet(
		input: PluginHostRuntimeBindingInput,
		params: z.infer<typeof storageGetParamsSchema>,
		_context: PluginHostCallContext,
	): Promise<JsonValue> {
		const storage = this.storageFor(input);
		const entry = await storage.get({
			key: params.key,
			...(params.scopeType ? { scopeType: params.scopeType as never } : {}),
			...(params.scopeId ? { scopeId: params.scopeId } : {}),
		});
		return (entry ? clone(entry) : null) as JsonValue;
	}

	private async storageList(
		input: PluginHostRuntimeBindingInput,
		params: z.infer<typeof storageListParamsSchema>,
		_context: PluginHostCallContext,
	): Promise<JsonValue> {
		const storage = this.storageFor(input);
		return (await storage.list({
			...(params.scopeType ? { scopeType: params.scopeType as never } : {}),
			...(params.scopeId ? { scopeId: params.scopeId } : {}),
			...(params.prefix ? { prefix: params.prefix } : {}),
			...(params.cursor ? { cursor: params.cursor } : {}),
			...(params.limit ? { limit: params.limit } : {}),
		})) as unknown as JsonValue;
	}

	private storageFor(input: PluginHostRuntimeBindingInput): PluginStorage {
		const root =
			input.dataPath ??
			this.storageRoot ??
			join(process.env.HOME ?? ".", ".narrafork", "plugin-storage");
		return new PluginStorage({
			pluginId: input.pluginId,
			root: input.dataPath ? dirname(root) : root,
		});
	}

	private async getOwnDiagnostics(
		input: PluginHostRuntimeBindingInput,
		context: PluginHostCallContext,
	): Promise<JsonValue> {
		const record = this.bindings.get(bindingKey(input.pluginId, input.runtimeId));
		if (!record) {
			throw new PluginHostDispatcherError(
				"CONTEXT_UNAVAILABLE",
				"Plugin runtime binding is unavailable",
				{
					retryable: true,
				},
			);
		}
		if (this.diagnosticsHandler) return this.diagnosticsHandler({ context, binding: record });
		return {
			plugin: {
				pluginId: record.plugin.pluginId,
				packageVersion: record.plugin.packageVersion,
				installationId: record.plugin.installationId,
				runtimeId: record.plugin.runtimeId,
				runtimeGeneration: record.plugin.runtimeGeneration,
			},
			grantRevision: record.grantRevision,
			capabilities: uniqueStrings(record.grants.map((grant) => grant.capability)),
			runtime: sanitizeRuntimeDiagnostics(input.getDiagnostics?.()),
			auditCount: this.auditEntries.filter((entry) => entry.pluginId === input.pluginId).length,
		} as JsonValue;
	}

	private recordAudit(entry: PluginHostAuditEntry): void {
		this.auditEntries.push(clone(entry));
		while (this.auditEntries.length > MAX_AUDIT_ENTRIES) this.auditEntries.shift();
		try {
			const result = this.auditSink?.(clone(entry));
			if (result && typeof (result as Promise<void>).catch === "function") {
				(result as Promise<void>).catch(() => undefined);
			}
		} catch {
			// Audit is best effort and must never turn a Host response into an error.
		}
		logger.debug("Plugin Host RPC audit", {
			pluginId: entry.pluginId,
			runtimeId: entry.runtimeId,
			method: entry.method,
			outcome: entry.outcome,
		});
	}
}

export function createPluginHostServices(
	options: PluginHostServicesOptions = {},
): PluginHostServices {
	return new PluginHostServices(options);
}
