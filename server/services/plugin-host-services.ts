import {
	RESOURCE_SCOPE_FIELD_BY_TYPE,
	resourceScopeSchema,
	scopeToFieldBinding,
} from "@server/lib/integrations/resource-scope";
import { logger } from "@server/lib/logger";
import {
	eventsPollParamsSchema,
	eventsPollResultSchema,
	eventsSubscribeParamsSchema,
	type JsonRpcRequest,
	type JsonValue,
	jsonValueSchema,
	PLUGIN_TO_HOST_REQUEST_METHODS,
	publicEventSchema,
} from "@server/lib/plugins/protocol";
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
import type {
	PluginEventGateway,
	PluginPrincipal as PluginEventPrincipal,
} from "./plugin-event-gateway";
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
import {
	createCommandRequest,
	createQueryRequest,
	type PluginPublicApi,
} from "./plugin-public-api";
import type { RuntimeDiagnostics } from "./plugin-runtime";
import {
	PLUGIN_STORAGE_SCOPE_TYPES,
	PluginStorageFactory,
	type PluginStorageFactoryLike,
	type PluginStorageScope,
	type PluginStorageScopeType,
	resolvePluginStorage,
} from "./plugin-storage";

const MAX_AUDIT_ENTRIES = 256;
const MAX_DIAGNOSTIC_ITEMS = 32;
const MAX_DIAGNOSTIC_TEXT = 1_000;
const MAX_PUBLIC_METHOD_ID = 200;
const MAX_STORAGE_KEY = 256;

const emptyParamsSchema = z.object({}).strict().optional();
const queryParamsSchema = z
	.object({
		queryId: z.string().trim().min(1).max(MAX_PUBLIC_METHOD_ID),
		input: jsonValueSchema.optional(),
	})
	.strict();
const commandParamsSchema = z
	.object({
		commandId: z.string().trim().min(1).max(MAX_PUBLIC_METHOD_ID),
		input: jsonValueSchema.optional(),
		idempotencyKey: z.string().trim().min(1).max(128).optional(),
		expectedVersion: z.number().int().nonnegative().optional(),
	})
	.strict();
const storageScopeTypeSchema = z.enum([
	"global",
	"session",
	"user",
	"project",
	"workspace",
	"chapter",
	"narrator",
	"provider",
	"device",
]);
const storageScopeSchema = z
	.object({ type: storageScopeTypeSchema, id: z.string().trim().min(1).max(128).optional() })
	.strict();
const storageScopeFields = {
	scope: storageScopeSchema.optional(),
	scopeType: storageScopeTypeSchema.optional(),
	scopeId: z.string().trim().min(1).max(128).optional(),
};
/**
 * `config.get` and `secrets.list` take no arguments: the plugin is identified by the
 * host-bound principal, never by a parameter, so there is nothing for a caller to
 * forge. An empty strict object also leaves room to add filters later without
 * breaking the frozen shape.
 */
const noParamsSchema = z.object({}).strict();

const storageGetParamsSchema = z
	.object({
		...storageScopeFields,
		key: z.string().trim().min(1).max(MAX_STORAGE_KEY),
	})
	.strict();
const storageSetParamsSchema = z
	.object({
		...storageScopeFields,
		key: z.string().trim().min(1).max(MAX_STORAGE_KEY),
		value: jsonValueSchema,
		expectedRevision: z.number().int().nonnegative().optional(),
	})
	.strict();
const storageDeleteParamsSchema = z
	.object({
		...storageScopeFields,
		key: z.string().trim().min(1).max(MAX_STORAGE_KEY),
		expectedRevision: z.number().int().nonnegative().optional(),
	})
	.strict();
const storageListParamsSchema = z
	.object({
		...storageScopeFields,
		prefix: z.string().trim().max(MAX_STORAGE_KEY).optional(),
		cursor: z.string().trim().max(4_096).optional(),
		limit: z.number().int().positive().max(100).optional(),
	})
	.strict();
const eventsUnsubscribeParamsSchema = z
	.object({ subscriptionId: z.string().trim().min(1).max(128) })
	.strict();

/**
 * Secret params carry a `key` but never a `pluginId`: the host takes the owner from the
 * bound principal, so one plugin cannot address another's namespace.
 *
 * The 64KB value ceiling stays. It is not a trust limit — the vault is a synchronous
 * JSON read/modify/write on the main thread, so an unbounded value would stall every
 * request. See CLAUDE.md on main-thread blocking.
 */
const MAX_SECRET_KEY_LENGTH = 256;
const MAX_SECRET_VALUE_BYTES = 64 * 1024;
const secretKeyParamsSchema = z
	.object({ key: z.string().trim().min(1).max(MAX_SECRET_KEY_LENGTH) })
	.strict();
const secretSetParamsSchema = z
	.object({
		key: z.string().trim().min(1).max(MAX_SECRET_KEY_LENGTH),
		value: z.string().max(MAX_SECRET_VALUE_BYTES),
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
	/** Host-bound invocation scope; plugin params may only narrow to these exact resource ids. */
	scope?: InvocationScope;
	dispatcher?: PluginHostDispatcher;
	getDiagnostics?: () => RuntimeDiagnostics | undefined;
	/** @deprecated Inject PluginPublicApi through PluginHostServices instead. */
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
	publicApi?: PluginPublicApi;
	eventGateway?: PluginEventGateway;
	storageFactory?: PluginStorageFactoryLike;
	/** @deprecated Inject storageFactory so UI and backend share the same cached instances. */
	storageRoot?: string;
	/** @deprecated Inject publicApi instead. */
	queryHandler?: PluginHostQueryHandler;
	diagnosticsHandler?: (input: {
		context: PluginHostCallContext;
		binding: PluginHostRuntimeBinding;
	}) => JsonValue | Promise<JsonValue>;
	auditSink?: (entry: PluginHostAuditEntry) => void | Promise<void>;
	/**
	 * Non-secret provider config for `config.get`, keyed by contribution id.
	 *
	 * Secret-valued fields must already be stripped by the supplier. The host does not
	 * re-filter here, because it has no schema at this layer; the config service owns
	 * that split and is the intended supplier.
	 */
	providerConfigReader?: (pluginId: string) => Promise<JsonValue> | JsonValue;
	/** Secret *key names* for `secrets.list`, without values. */
	secretKeyLister?: (pluginId: string) => Promise<readonly string[]> | readonly string[];
	/**
	 * Read/write/delete access to the calling plugin's own secrets.
	 *
	 * Every function takes `pluginId` as its first argument and the host supplies it from
	 * the bound principal — plugins never pass it. That is the whole isolation mechanism,
	 * and it is the same one VS Code relies on (`JSON.stringify({ extensionId, key })` in
	 * `mainThreadSecretState`): identity is injected, not self-reported, so naming another
	 * plugin's secret is not expressible in the API.
	 *
	 * Values used to be withheld entirely, on the theory that a plugin should only ever
	 * receive a request-scoped injection. That cost real functionality — a settings view
	 * could not show which credential was configured — while preventing nothing, since a
	 * plugin's own backend could return the value anyway.
	 */
	secretReader?: (
		pluginId: string,
		key: string,
	) => Promise<string | undefined> | string | undefined;
	secretWriter?: (pluginId: string, key: string, value: string) => Promise<void> | void;
	secretDeleter?: (pluginId: string, key: string) => Promise<boolean> | boolean;
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

function toJsonValue(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function publicHostContext(context: PluginHostCallContext): HostCallContext {
	return {
		requestId: context.requestId,
		correlationId: context.correlationId,
		deadlineAt: context.deadlineAt,
		plugin: context.plugin,
		invocation: context.invocation,
		scope: context.scope,
	};
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

function storageScopeFromParams(params: unknown): PluginStorageScope {
	if (!isRecord(params)) {
		throw new PluginHostDispatcherError("INVALID_PARAMS", "Storage scope is invalid");
	}
	const nested = params.scope;
	if (nested !== undefined && (params.scopeType !== undefined || params.scopeId !== undefined)) {
		throw new PluginHostDispatcherError("INVALID_PARAMS", "Storage scope was specified twice");
	}
	const type = isRecord(nested) ? nested.type : params.scopeType;
	const id = isRecord(nested) ? nested.id : params.scopeId;
	if (!(PLUGIN_STORAGE_SCOPE_TYPES as readonly unknown[]).includes(type)) {
		throw new PluginHostDispatcherError("INVALID_PARAMS", "Storage scope is invalid");
	}
	const parsed = resourceScopeSchema.safeParse({ type, ...(id === undefined ? {} : { id }) });
	if (!parsed.success) {
		throw new PluginHostDispatcherError("INVALID_PARAMS", "Storage scope is invalid");
	}
	return parsed.data as PluginStorageScope;
}

function storageScopeBindingId(
	type: PluginStorageScopeType,
	context: PluginHostCallContext,
): string | undefined {
	if (type === "session") return context.plugin.runtimeId;
	if (type === "global") return undefined;
	const field = RESOURCE_SCOPE_FIELD_BY_TYPE[type] as keyof InvocationScope;
	return context.scope[field];
}

function storageAuthorizationScope(scope: PluginStorageScope): InvocationScope {
	if (scope.type === "global" || scope.type === "session") return {};
	return scopeToFieldBinding(scope) as InvocationScope;
}

function assertStorageScopeBound(scope: PluginStorageScope, context: PluginHostCallContext): void {
	if (scope.type === "global") return;
	if (!scope.id || storageScopeBindingId(scope.type, context) !== scope.id) {
		throw new PluginHostDispatcherError(
			"PERMISSION_DENIED",
			"Storage scope is outside the bound backend context",
			{ data: { reason: "STORAGE_SCOPE_OUTSIDE_BINDING" } },
		);
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
	readonly publicApi?: PluginPublicApi;
	readonly eventGateway?: PluginEventGateway;
	readonly storageFactory: PluginStorageFactoryLike;
	private readonly providerConfigReader?: PluginHostServicesOptions["providerConfigReader"];
	private readonly secretKeyLister?: PluginHostServicesOptions["secretKeyLister"];
	private readonly secretReader?: PluginHostServicesOptions["secretReader"];
	private readonly secretWriter?: PluginHostServicesOptions["secretWriter"];
	private readonly secretDeleter?: PluginHostServicesOptions["secretDeleter"];
	private readonly queryHandler?: PluginHostQueryHandler;
	private readonly diagnosticsHandler?: PluginHostServicesOptions["diagnosticsHandler"];
	private readonly auditSink?: PluginHostServicesOptions["auditSink"];
	private readonly now: () => Date;
	private readonly bindings = new Map<string, PluginHostRuntimeBinding>();
	private readonly runtimeInputs = new Map<string, PluginHostRuntimeBindingInput>();
	private readonly dispatchers = new Map<string, PluginHostDispatcher>();
	private readonly subscriptions = new Map<string, { bindingKey: string; topics: string[] }>();
	private readonly auditEntries: PluginHostAuditEntry[] = [];

	constructor(options: PluginHostServicesOptions = {}) {
		this.capabilityBroker = options.capabilityBroker ?? defaultCapabilityBroker;
		this.permissionStore = options.permissionStore;
		this.publicApi = options.publicApi;
		this.eventGateway = options.eventGateway;
		this.storageFactory =
			options.storageFactory ?? new PluginStorageFactory({ root: options.storageRoot });
		this.providerConfigReader = options.providerConfigReader;
		this.secretKeyLister = options.secretKeyLister;
		this.secretReader = options.secretReader;
		this.secretWriter = options.secretWriter;
		this.secretDeleter = options.secretDeleter;
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
			this.revokeSubscriptions(pluginId, runtimeId);
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
		this.revokeSubscriptions(pluginId);
		this.capabilityBroker.clearBindingsForPlugin(pluginId);
		return revoked;
	}

	clearRuntimeBinding(pluginId: string, runtimeId: string): boolean {
		const key = bindingKey(pluginId, runtimeId);
		const deleted = this.bindings.delete(key);
		this.runtimeInputs.delete(key);
		this.revokeSubscriptions(pluginId, runtimeId);
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
					maxRequestBytes: 256 * 1024,
					maxResponseBytes: 1024 * 1024,
					handler: (params, context) =>
						this.executeQuery(
							this.runtimeInput(context),
							params as z.infer<typeof queryParamsSchema>,
							context,
						),
				},
				"commands.execute": {
					method: "commands.execute",
					paramsSchema: commandParamsSchema,
					resultSchema: jsonValueSchema,
					maxRequestBytes: 256 * 1024,
					maxResponseBytes: 1024 * 1024,
					sideEffect: "unknown",
					handler: (params, context) =>
						this.executeCommand(params as z.infer<typeof commandParamsSchema>, context),
				},
				"events.subscribe": {
					method: "events.subscribe",
					paramsSchema: eventsSubscribeParamsSchema,
					resultSchema: jsonValueSchema,
					maxRequestBytes: 256 * 1024,
					maxResponseBytes: 256 * 1024,
					sideEffect: "unknown",
					handler: (params, context) =>
						this.subscribeEvents(params as z.infer<typeof eventsSubscribeParamsSchema>, context),
				},
				"events.unsubscribe": {
					method: "events.unsubscribe",
					paramsSchema: eventsUnsubscribeParamsSchema,
					resultSchema: jsonValueSchema,
					maxResponseBytes: 64 * 1024,
					handler: (params, context) =>
						this.unsubscribeEvents(
							params as z.infer<typeof eventsUnsubscribeParamsSchema>,
							context,
						),
				},
				"events.poll": {
					method: "events.poll",
					paramsSchema: eventsPollParamsSchema,
					resultSchema: eventsPollResultSchema,
					maxResponseBytes: 1024 * 1024,
					sideEffect: "unknown",
					handler: (params, context) =>
						this.pollEvents(params as z.infer<typeof eventsPollParamsSchema>, context),
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
				"storage.set": {
					method: "storage.set",
					paramsSchema: storageSetParamsSchema,
					resultSchema: jsonValueSchema,
					capability: "storage.write_self",
					maxRequestBytes: 256 * 1024,
					maxResponseBytes: 256 * 1024,
					sideEffect: "unknown",
					handler: (params, context) =>
						this.storageSet(
							this.runtimeInput(context),
							params as z.infer<typeof storageSetParamsSchema>,
							context,
						),
				},
				"storage.delete": {
					method: "storage.delete",
					paramsSchema: storageDeleteParamsSchema,
					resultSchema: jsonValueSchema,
					capability: "storage.write_self",
					maxResponseBytes: 64 * 1024,
					sideEffect: "unknown",
					handler: (params, context) =>
						this.storageDelete(
							this.runtimeInput(context),
							params as z.infer<typeof storageDeleteParamsSchema>,
							context,
						),
				},
				"config.get": {
					method: "config.get",
					paramsSchema: noParamsSchema,
					resultSchema: jsonValueSchema,
					capability: "config.read_self",
					maxResponseBytes: 256 * 1024,
					handler: (_params, context) => this.configGet(context),
				},
				"secrets.list": {
					method: "secrets.list",
					paramsSchema: noParamsSchema,
					resultSchema: jsonValueSchema,
					capability: "secret.use_self",
					maxResponseBytes: 64 * 1024,
					handler: (_params, context) => this.secretsList(context),
				},
				"secrets.get": {
					method: "secrets.get",
					paramsSchema: secretKeyParamsSchema,
					resultSchema: jsonValueSchema,
					capability: "secret.use_self",
					maxResponseBytes: 64 * 1024,
					handler: (params, context) =>
						this.secretsGet(context, params as z.infer<typeof secretKeyParamsSchema>),
				},
				"secrets.set": {
					method: "secrets.set",
					paramsSchema: secretSetParamsSchema,
					resultSchema: jsonValueSchema,
					capability: "secret.use_self",
					maxResponseBytes: 4 * 1024,
					handler: (params, context) =>
						this.secretsSet(context, params as z.infer<typeof secretSetParamsSchema>),
				},
				"secrets.delete": {
					method: "secrets.delete",
					paramsSchema: secretKeyParamsSchema,
					resultSchema: jsonValueSchema,
					capability: "secret.use_self",
					maxResponseBytes: 4 * 1024,
					handler: (params, context) =>
						this.secretsDelete(context, params as z.infer<typeof secretKeyParamsSchema>),
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
		const dispatcher = new PluginHostDispatcher(dispatcherOptions);
		const methods = dispatcher.listMethods();
		if (
			methods.length !== PLUGIN_TO_HOST_REQUEST_METHODS.length ||
			PLUGIN_TO_HOST_REQUEST_METHODS.some((method) => !dispatcher.has(method))
		) {
			throw new Error("Plugin Host dispatcher method inventory is out of sync with the protocol");
		}
		return dispatcher;
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
		const runtimeInput = this.runtimeInputs.get(
			bindingKey(input.plugin.pluginId, input.plugin.runtimeId),
		);
		const scope: InvocationScope = { ...(runtimeInput?.scope ?? {}) };
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
		try {
			if (input.method === "events.subscribe") {
				return this.eventGateway
					? { allowed: true }
					: {
							allowed: false,
							code: "HOST_UNAVAILABLE",
							message: "Plugin event service is unavailable",
							retryable: true,
						};
			}
			if (input.method === "events.unsubscribe" || input.method === "events.poll") {
				return this.authorizeEventSubscription(input);
			}

			let capability = input.capability;
			let scope = input.context.scope;
			if (input.method === "queries.execute" && isRecord(input.params)) {
				const queryId = input.params.queryId;
				capability =
					typeof queryId === "string"
						? this.publicApi?.queries.get(queryId)?.capability
						: undefined;
				if (!capability) {
					const runtimeInput = this.runtimeInput(input.context);
					if (runtimeInput.queryHandler ?? this.queryHandler) capability = "query.read.audit_self";
				}
			}
			if (input.method === "commands.execute" && isRecord(input.params)) {
				const commandId = input.params.commandId;
				capability =
					typeof commandId === "string"
						? this.publicApi?.commands.get(commandId)?.capability
						: undefined;
			}
			if (input.method.startsWith("storage.")) {
				const storageScope = storageScopeFromParams(input.params);
				assertStorageScopeBound(storageScope, input.context);
				scope = storageAuthorizationScope(storageScope);
			}
			if (!capability) {
				return {
					allowed: false,
					code: "PERMISSION_DENIED",
					message: "Plugin Host method has no capability binding",
					data: { reason: "CAPABILITY_NOT_DECLARED" },
				};
			}
			return this.authorizeCapability(input, capability, scope);
		} catch (error) {
			if (error instanceof PluginHostDispatcherError) {
				return {
					allowed: false,
					code: error.code,
					message: error.message,
					retryable: error.retryable,
					data: error.data,
				};
			}
			return {
				allowed: false,
				code: "PERMISSION_DENIED",
				message: "Plugin capability request was denied",
				data: { reason: "BROKER_UNAVAILABLE" },
			};
		}
	}

	private async authorizeEventSubscription(
		input: PluginHostResolverInput,
	): Promise<PluginHostAuthorizationDecision> {
		const subscriptionId = isRecord(input.params) ? input.params.subscriptionId : undefined;
		const subscription =
			typeof subscriptionId === "string" ? this.subscriptions.get(subscriptionId) : undefined;
		if (
			!subscription ||
			subscription.bindingKey !==
				bindingKey(input.context.plugin.pluginId, input.context.plugin.runtimeId)
		) {
			return {
				allowed: false,
				code: "NOT_FOUND",
				message: "Plugin event subscription was not found",
				data: { reason: "SUBSCRIPTION_NOT_OWNED" },
			};
		}
		return this.eventGateway
			?.getSubscriptionDiagnostics()
			.some((item) => item.subscriptionId === subscriptionId)
			? { allowed: true }
			: {
					allowed: false,
					code: "NOT_FOUND",
					message: "Plugin event subscription was not found",
					data: { reason: "SUBSCRIPTION_REVOKED" },
				};
	}

	private async authorizeCapability(
		input: PluginHostResolverInput,
		capability: string,
		scope: InvocationScope,
		constraints?: Record<string, JsonValue>,
	): Promise<PluginHostAuthorizationDecision> {
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
			capability: capability as never,
			methodId: input.method,
			scope,
			resource: resourceFromUnknown(input.resource),
			constraints,
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
	}

	private async executeQuery(
		input: PluginHostRuntimeBindingInput,
		params: { queryId: string; input?: JsonValue },
		context: PluginHostCallContext,
	): Promise<JsonValue> {
		if (this.publicApi) {
			const hostContext = publicHostContext(context);
			return toJsonValue(
				await this.publicApi.query(
					hostContext,
					createQueryRequest(hostContext, params.queryId, params.input ?? null),
				),
			);
		}
		const queryHandler = input.queryHandler ?? this.queryHandler;
		if (queryHandler) {
			return queryHandler({ queryId: params.queryId, input: params.input, context });
		}
		throw new PluginHostDispatcherError("HOST_UNAVAILABLE", "Plugin query service is unavailable", {
			retryable: true,
		});
	}

	private async executeCommand(
		params: z.infer<typeof commandParamsSchema>,
		context: PluginHostCallContext,
	): Promise<JsonValue> {
		if (!this.publicApi) {
			throw new PluginHostDispatcherError(
				"HOST_UNAVAILABLE",
				"Plugin command service is unavailable",
				{ retryable: true, sideEffect: "unknown" },
			);
		}
		const hostContext = publicHostContext(context);
		return toJsonValue(
			await this.publicApi.command(
				hostContext,
				createCommandRequest(hostContext, params.commandId, params.input ?? null, {
					idempotencyKey: params.idempotencyKey,
					expectedVersion: params.expectedVersion,
				}),
			),
		);
	}

	private async subscribeEvents(
		params: z.infer<typeof eventsSubscribeParamsSchema>,
		context: PluginHostCallContext,
	): Promise<JsonValue> {
		if (!this.eventGateway) {
			throw new PluginHostDispatcherError(
				"HOST_UNAVAILABLE",
				"Plugin event service is unavailable",
				{ retryable: true, sideEffect: "unknown" },
			);
		}
		const runtimeBinding = this.bindings.get(
			bindingKey(context.plugin.pluginId, context.plugin.runtimeId),
		);
		const principal: PluginEventPrincipal = {
			pluginId: context.plugin.pluginId,
			installationId: context.plugin.installationId,
			grantRevision: runtimeBinding?.grantRevision,
			packageVersion: context.plugin.packageVersion,
			runtimeId: context.plugin.runtimeId,
			generation: context.plugin.runtimeGeneration,
			contributionId: context.plugin.contributionId,
		};
		const delivery = params.delivery
			? {
					maxRatePerSecond: params.delivery.maxRatePerSecond,
					queueEvents: params.delivery.queueEvents,
					queueBytes: params.delivery.queueBytes,
				}
			: undefined;
		const result = await this.eventGateway.subscribe({
			principal,
			invocationScope: context.scope,
			topics: params.topics,
			filter: params.filter,
			scope: params.scope,
			mode: params.mode,
			delivery,
		});
		this.subscriptions.set(result.subscriptionId, {
			bindingKey: bindingKey(context.plugin.pluginId, context.plugin.runtimeId),
			topics: [...params.topics],
		});
		return result as unknown as JsonValue;
	}

	private unsubscribeEvents(
		params: z.infer<typeof eventsUnsubscribeParamsSchema>,
		_context: PluginHostCallContext,
	): JsonValue {
		if (!this.eventGateway) {
			throw new PluginHostDispatcherError(
				"HOST_UNAVAILABLE",
				"Plugin event service is unavailable",
				{ retryable: true },
			);
		}
		this.subscriptions.delete(params.subscriptionId);
		return {
			subscriptionId: params.subscriptionId,
			unsubscribed: this.eventGateway.unsubscribe(params.subscriptionId),
		};
	}

	private pollEvents(
		params: z.infer<typeof eventsPollParamsSchema>,
		_context: PluginHostCallContext,
	): JsonValue {
		if (!this.eventGateway) {
			throw new PluginHostDispatcherError(
				"HOST_UNAVAILABLE",
				"Plugin event service is unavailable",
				{ retryable: true, sideEffect: "unknown" },
			);
		}
		const events = this.eventGateway
			.poll(params.subscriptionId, params.limit)
			.map((event) => publicEventSchema.parse(event));
		const diagnostics = this.eventGateway
			.getSubscriptionDiagnostics()
			.find((item) => item.subscriptionId === params.subscriptionId);
		return {
			subscriptionId: params.subscriptionId,
			events,
			hasMore: (diagnostics?.queueEvents ?? 0) > 0,
			...(diagnostics?.status === "overflowed" ? { resyncRequired: true } : {}),
		};
	}

	private async storageGet(
		input: PluginHostRuntimeBindingInput,
		params: z.infer<typeof storageGetParamsSchema>,
		context: PluginHostCallContext,
	): Promise<JsonValue> {
		const scope = storageScopeFromParams(params);
		assertStorageScopeBound(scope, context);
		const entry = await this.storageFor(input).get({ scope, key: params.key });
		return (entry ? clone(entry) : null) as JsonValue;
	}

	private async storageSet(
		input: PluginHostRuntimeBindingInput,
		params: z.infer<typeof storageSetParamsSchema>,
		context: PluginHostCallContext,
	): Promise<JsonValue> {
		const scope = storageScopeFromParams(params);
		assertStorageScopeBound(scope, context);
		return (await this.storageFor(input).set({
			scope,
			key: params.key,
			value: params.value,
			expectedRevision: params.expectedRevision,
		})) as unknown as JsonValue;
	}

	private async storageDelete(
		input: PluginHostRuntimeBindingInput,
		params: z.infer<typeof storageDeleteParamsSchema>,
		context: PluginHostCallContext,
	): Promise<JsonValue> {
		const scope = storageScopeFromParams(params);
		assertStorageScopeBound(scope, context);
		return (await this.storageFor(input).delete({
			scope,
			key: params.key,
			expectedRevision: params.expectedRevision,
		})) as JsonValue;
	}

	private async storageList(
		input: PluginHostRuntimeBindingInput,
		params: z.infer<typeof storageListParamsSchema>,
		context: PluginHostCallContext,
	): Promise<JsonValue> {
		const scope = storageScopeFromParams(params);
		assertStorageScopeBound(scope, context);
		return (await this.storageFor(input).list({
			scope,
			...(params.prefix ? { prefix: params.prefix } : {}),
			...(params.cursor ? { cursor: params.cursor } : {}),
			...(params.limit ? { limit: params.limit } : {}),
		})) as unknown as JsonValue;
	}

	/**
	 * Own non-secret config. The plugin id comes from the host-bound principal, so a
	 * plugin cannot read another plugin's config by passing a different id.
	 */
	private async configGet(context: PluginHostCallContext): Promise<JsonValue> {
		if (!this.providerConfigReader) return {};
		return (await this.providerConfigReader(context.plugin.pluginId)) ?? {};
	}

	/** Own secret key names plus a configured flag. Values come from `secrets.get`. */
	private async secretsList(context: PluginHostCallContext): Promise<JsonValue> {
		if (!this.secretKeyLister) return { secrets: [] };
		const keys = await this.secretKeyLister(context.plugin.pluginId);
		return { secrets: keys.map((key) => ({ key, configured: true })) };
	}

	/**
	 * Read one of the plugin's own secrets.
	 *
	 * `context.plugin.pluginId` is host-supplied, so the namespace is not selectable by the
	 * caller. An unset key returns `{ value: null }` rather than an error, matching
	 * `secrets.get` in VS Code returning `undefined`.
	 */
	private async secretsGet(
		context: PluginHostCallContext,
		params: z.infer<typeof secretKeyParamsSchema>,
	): Promise<JsonValue> {
		if (!this.secretReader) return { key: params.key, value: null };
		const value = await this.secretReader(context.plugin.pluginId, params.key);
		return { key: params.key, value: value ?? null };
	}

	private async secretsSet(
		context: PluginHostCallContext,
		params: z.infer<typeof secretSetParamsSchema>,
	): Promise<JsonValue> {
		if (!this.secretWriter) {
			throw new PluginHostDispatcherError("HOST_UNAVAILABLE", "Secret storage is unavailable");
		}
		await this.secretWriter(context.plugin.pluginId, params.key, params.value);
		return { key: params.key, stored: true };
	}

	private async secretsDelete(
		context: PluginHostCallContext,
		params: z.infer<typeof secretKeyParamsSchema>,
	): Promise<JsonValue> {
		if (!this.secretDeleter) return { key: params.key, deleted: false };
		const deleted = await this.secretDeleter(context.plugin.pluginId, params.key);
		return { key: params.key, deleted };
	}

	private storageFor(input: PluginHostRuntimeBindingInput) {
		return resolvePluginStorage(this.storageFactory, input.pluginId);
	}

	private revokeSubscriptions(pluginId: string, runtimeId?: string): void {
		for (const [subscriptionId, subscription] of this.subscriptions) {
			const [ownerPluginId, ownerRuntimeId] = subscription.bindingKey.split(" ", 2);
			if (ownerPluginId !== pluginId || (runtimeId !== undefined && ownerRuntimeId !== runtimeId)) {
				continue;
			}
			this.subscriptions.delete(subscriptionId);
			this.eventGateway?.unsubscribe(subscriptionId, "runtime-binding-revoked");
		}
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
