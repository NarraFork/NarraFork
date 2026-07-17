import { AppError, ValidationError } from "@server/lib/errors";
import { generateShortId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import { contributionIdSchema, pluginIdSchema } from "@server/lib/plugins/manifest";
import {
	CAPABILITIES,
	COMPATIBILITY_STATES,
	type CompatibilityState,
	capabilityListSchema,
	capabilitySchema,
	type DesiredState,
	desiredStateSchema,
	type PermissionGrant,
	type InvocationScope as PermissionInvocationScope,
	type PermissionScope,
	permissionGrantSchema,
	invocationScopeSchema as permissionInvocationScopeSchema,
	type RuntimeState,
	runtimeStateSchema,
	TRUST_TIERS,
	type TrustTier,
} from "@server/lib/plugins/permissions";
import { type JsonValue, PLUGIN_ERROR_CODES } from "@server/lib/plugins/protocol";
import { z } from "zod";

const MAX_AUDIT_ENTRIES = 1_000;
const DEFAULT_CACHE_TTL_MS = 1_000;
const MAX_METHOD_ID_BYTES = 200;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
function hasNoControlCharacters(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint < 0x20 || codePoint === 0x7f) return false;
	}
	return true;
}

const VERSION_PATTERN =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export type InvocationScope = PermissionInvocationScope;
export const invocationScopeSchema = permissionInvocationScopeSchema;

const identifierSchema = z
	.string()
	.min(1)
	.max(128)
	.refine((value) => value === value.trim(), "identifier must not have surrounding whitespace")
	.refine(hasNoControlCharacters, "identifier contains control characters");

const versionSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(VERSION_PATTERN, "packageVersion must be valid SemVer");

export const pluginPrincipalSchema = z
	.object({
		pluginId: pluginIdSchema,
		packageVersion: versionSchema,
		runtimeId: identifierSchema,
		runtimeGeneration: z.number().int().nonnegative(),
		contributionId: contributionIdSchema.optional(),
		installationId: identifierSchema,
	})
	.strict();
export type PluginPrincipal = z.infer<typeof pluginPrincipalSchema>;

export const invocationPrincipalSchema = z
	.object({
		kind: z.enum(["user", "plugin_background", "system"]),
		userId: identifierSchema.optional(),
		userRole: z.enum(["admin", "user"]).optional(),
		source: z.enum(["ui", "command", "event", "schedule", "provider", "internal"]),
	})
	.strict()
	.superRefine((principal, context) => {
		if (principal.kind === "user" && !principal.userId) {
			context.addIssue({
				code: "custom",
				path: ["userId"],
				message: "user principal requires userId",
			});
		}
		if (principal.kind !== "user" && (principal.userId || principal.userRole)) {
			context.addIssue({
				code: "custom",
				path: ["userId"],
				message: "background and system principals cannot carry user authority",
			});
		}
		if (principal.kind === "plugin_background" && principal.source === "ui") {
			context.addIssue({
				code: "custom",
				path: ["source"],
				message: "background principals cannot originate from UI",
			});
		}
	});
export type InvocationPrincipal = z.infer<typeof invocationPrincipalSchema>;

const isoDateSchema = z.string().datetime({ offset: true });

export const hostCallContextSchema = z
	.object({
		requestId: identifierSchema,
		correlationId: identifierSchema,
		deadlineAt: isoDateSchema,
		plugin: pluginPrincipalSchema,
		invocation: invocationPrincipalSchema,
		scope: permissionInvocationScopeSchema,
	})
	.strict();
export type HostCallContext = z.infer<typeof hostCallContextSchema>;

const authorizationConstraintsSchema = z
	.object({
		topic: identifierSchema.max(200).optional(),
		topics: z.array(identifierSchema.max(200)).max(20).optional(),
		resourceId: identifierSchema.optional(),
		resourceIds: z.array(identifierSchema).max(20).optional(),
		path: z.string().trim().min(1).max(4_096).optional(),
		paths: z.array(z.string().trim().min(1).max(4_096)).max(50).optional(),
		field: identifierSchema.max(200).optional(),
		fields: z.array(identifierSchema.max(200)).max(50).optional(),
		method: identifierSchema.max(200).optional(),
		methods: z.array(identifierSchema.max(200)).max(50).optional(),
		providerInstanceId: identifierSchema.optional(),
		providerInstanceIds: z.array(identifierSchema).max(20).optional(),
		ratePerSecond: z.number().finite().positive().max(10_000).optional(),
		maxBytes: z.number().int().positive().max(MAX_REQUEST_BYTES).optional(),
	})
	.strict();
export type CapabilityAuthorizationConstraints = z.infer<typeof authorizationConstraintsSchema>;
export const capabilityAuthorizationConstraintsSchema = authorizationConstraintsSchema;

const resourceSchema = z
	.object({
		type: z.enum(["user", "project", "workspace", "chapter", "narrator", "provider", "device"]),
		id: identifierSchema,
	})
	.strict();
export type CapabilityResource = z.infer<typeof resourceSchema>;
export const capabilityResourceSchema = resourceSchema;

const lifecycleStateSchema = z
	.object({
		desiredState: desiredStateSchema,
		compatibilityState: z.enum(COMPATIBILITY_STATES),
		runtimeState: runtimeStateSchema,
		trustTier: z.enum(TRUST_TIERS).optional(),
		runtimeGeneration: z.number().int().nonnegative().optional(),
	})
	.strict();

export interface PluginCapabilityBinding {
	plugin: PluginPrincipal;
	desiredState: DesiredState;
	compatibilityState: CompatibilityState;
	runtimeState: RuntimeState;
	trustTier?: TrustTier;
	runtimeGeneration?: number;
	manifestRequested: readonly string[];
	installationGrants: readonly PermissionGrant[];
	hostPolicy: readonly string[];
	currentUserAuthority: readonly string[];
	contributionPolicy: readonly string[];
	runnerEnforcement: readonly string[];
	grantRevision?: number;
}

export interface PluginCapabilityBindingInput
	extends Partial<
		Pick<
			PluginCapabilityBinding,
			| "desiredState"
			| "compatibilityState"
			| "runtimeState"
			| "trustTier"
			| "runtimeGeneration"
			| "manifestRequested"
			| "installationGrants"
			| "hostPolicy"
			| "currentUserAuthority"
			| "contributionPolicy"
			| "runnerEnforcement"
			| "grantRevision"
		>
	> {
	plugin?: PluginPrincipal;
	principal?: PluginPrincipal;
	state?: {
		desiredState?: DesiredState;
		compatibility?: CompatibilityState;
		compatibilityState?: CompatibilityState;
		runtimeState?: RuntimeState;
		runtimeGeneration?: number;
		trustTier?: TrustTier;
	};
	manifest?: { permissions?: { host?: readonly string[] } };
}

export interface ScopeResolutionInput {
	mode: "grant" | "invocation";
	plugin: PluginPrincipal;
	context: HostCallContext;
	grantScope?: PermissionScope;
	currentScope: InvocationScope;
	requestedScope: InvocationScope;
}

export interface ScopeResolver {
	resolve?(input: ScopeResolutionInput): boolean | undefined | Promise<boolean | undefined>;
	isAllowed?(input: ScopeResolutionInput): boolean | undefined | Promise<boolean | undefined>;
	belongs?(
		child: { type: string; id: string },
		parent: { type: string; id: string },
		input: ScopeResolutionInput,
	): boolean | undefined | Promise<boolean | undefined>;
}

export type MaybePromise<T> = T | Promise<T>;
export type PluginBindingResolver = (
	pluginId: string,
	context: HostCallContext,
) => MaybePromise<PluginCapabilityBindingInput | undefined>;
export type CapabilitySourceResolver = (
	context: HostCallContext,
) => MaybePromise<readonly string[] | undefined>;

export interface PluginAuditSummary {
	pluginId: string;
	contributionId?: string;
	runtimeId?: string;
	requestId?: string;
	correlationId: string;
	principalKind: InvocationPrincipal["kind"];
	userId?: string;
	capability?: string;
	methodId: string;
	resourceType?: string;
	resourceId?: string;
	scopeType?: string;
	scopeId?: string;
	outcome: "allowed" | "denied";
	durationMs?: number;
	requestBytes: number;
	responseBytes: number;
	redactedSummary?: Record<string, JsonValue>;
}

export type PluginAuditSink =
	| ((summary: PluginAuditSummary) => MaybePromise<unknown>)
	| { write(summary: PluginAuditSummary): MaybePromise<unknown> };

export interface CapabilityBrokerOptions {
	bindings?:
		| Map<string, PluginCapabilityBindingInput>
		| Iterable<PluginCapabilityBindingInput & { pluginId?: string }>;
	pluginBindings?:
		| Map<string, PluginCapabilityBindingInput>
		| Iterable<PluginCapabilityBindingInput & { pluginId?: string }>;
	resolveBinding?: PluginBindingResolver;
	resolvePlugin?: PluginBindingResolver;
	pluginResolver?: PluginBindingResolver;
	scopeResolver?: ScopeResolver | ScopeResolver["resolve"];
	resolveScope?: ScopeResolver["resolve"];
	resolveManifestRequested?: CapabilitySourceResolver;
	resolveInstallationGrants?: (
		context: HostCallContext,
	) => MaybePromise<readonly PermissionGrant[] | undefined>;
	resolveHostPolicy?: CapabilitySourceResolver;
	resolveCurrentUserAuthority?: CapabilitySourceResolver;
	resolveContributionPolicy?: CapabilitySourceResolver;
	resolveRunnerEnforcement?: CapabilitySourceResolver;
	auditSink?: PluginAuditSink;
	maxAuditEntries?: number;
	cacheTtlMs?: number;
	now?: () => Date;
}

export interface CapabilityAuthorizationRequest {
	context: HostCallContext;
	capability: string;
	methodId?: string;
	scope?: InvocationScope;
	resource?: CapabilityResource;
	constraints?: CapabilityAuthorizationConstraints;
	requestBytes?: number;
	responseBytes?: number;
}

export interface AuthorizationSuccess {
	allowed: true;
	capability: (typeof CAPABILITIES)[number];
	context: HostCallContext;
	grant: PermissionGrant;
	effectiveCapabilities: readonly string[];
	grantRevision?: number;
	cacheHit: boolean;
}

export interface AuthorizationFailure {
	allowed: false;
	error: CapabilityBrokerError;
}

export type AuthorizationResult = AuthorizationSuccess | AuthorizationFailure;

export type CapabilityBrokerErrorReason =
	| "INVALID_CONTEXT"
	| "PLUGIN_IDENTITY_MISMATCH"
	| "RUNTIME_IDENTITY_MISMATCH"
	| "RUNTIME_GENERATION_MISMATCH"
	| "GRANT_EXPIRED"
	| "GRANT_REVOKED"
	| "INVALID_GRANT"
	| "MISSING_SOURCE"
	| "MISSING_SCOPE"
	| "SCOPE_ESCALATION"
	| "CONSTRAINT_MISMATCH"
	| "PLUGIN_NOT_ENABLED"
	| "PLUGIN_INCOMPATIBLE"
	| "PLUGIN_QUARANTINED"
	| "PLUGIN_RUNTIME_UNAVAILABLE"
	| "CAPABILITY_NOT_REQUESTED"
	| "CAPABILITY_NOT_GRANTED"
	| "HOST_POLICY_DENIED"
	| "USER_AUTHORITY_DENIED"
	| "CONTRIBUTION_POLICY_DENIED"
	| "RUNNER_DENIED"
	| "AUDIT_UNAVAILABLE";

export class CapabilityBrokerError extends AppError {
	readonly reason: CapabilityBrokerErrorReason;
	readonly diagnosticId: string;

	constructor(
		code: string,
		reason: CapabilityBrokerErrorReason,
		statusCode = 403,
		diagnosticId = generateShortId(12),
	) {
		super("Plugin capability request was denied", statusCode, code);
		this.name = "CapabilityBrokerError";
		this.reason = reason;
		this.diagnosticId = diagnosticId;
	}
}

interface NormalizedBinding {
	plugin: PluginPrincipal;
	desiredState: DesiredState;
	compatibilityState: CompatibilityState;
	runtimeState: RuntimeState;
	trustTier: TrustTier | undefined;
	runtimeGeneration: number;
	manifestRequested: string[];
	installationGrants: PermissionGrant[];
	hostPolicy: string[];
	currentUserAuthority: string[];
	contributionPolicy: string[];
	runnerEnforcement: string[];
	grantRevision: number | undefined;
}

interface NormalizedRequest {
	context: HostCallContext;
	capability: (typeof CAPABILITIES)[number];
	methodId: string;
	scope: InvocationScope;
	resource?: CapabilityResource;
	constraints: CapabilityAuthorizationConstraints;
	requestBytes: number;
	responseBytes: number;
}

interface CacheEntry {
	expiresAt: number;
	result: AuthorizationSuccess;
}

const scopeFieldByType: Record<
	Exclude<PermissionScope["type"], "global" | "session">,
	keyof InvocationScope
> = {
	user: "userId",
	project: "projectId",
	workspace: "workspaceId",
	chapter: "chapterId",
	narrator: "narratorId",
	provider: "providerInstanceId",
	device: "deviceId",
};

function clone<T>(value: T): T {
	return structuredClone(value);
}

function samePrincipal(left: PluginPrincipal, right: PluginPrincipal): boolean {
	return (
		left.pluginId === right.pluginId &&
		left.packageVersion === right.packageVersion &&
		left.runtimeId === right.runtimeId &&
		left.runtimeGeneration === right.runtimeGeneration &&
		left.installationId === right.installationId &&
		left.contributionId === right.contributionId
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively freeze JSON-like values without changing their wire-compatible representation. */
function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) {
		for (const item of value) deepFreeze(item);
	} else {
		for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
	}
	return Object.isFrozen(value) ? value : Object.freeze(value);
}

function safeBytes(value: unknown, max: number): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max
		? value
		: undefined;
}

function redactedSummary(
	request: NormalizedRequest,
	reason: CapabilityBrokerErrorReason | "CACHE_HIT",
	grantRevision?: number,
): Record<string, JsonValue> {
	const summary: Record<string, JsonValue> = { reason };
	if (grantRevision !== undefined) summary.grantRevision = grantRevision;
	if (request.resource) summary.resourceType = request.resource.type;
	if (request.constraints.topic) summary.constraintTopic = "present";
	if (request.constraints.path || request.constraints.paths?.length)
		summary.constraintPath = "present";
	if (request.constraints.maxBytes !== undefined) summary.maxBytes = request.constraints.maxBytes;
	if (request.constraints.ratePerSecond !== undefined) {
		summary.ratePerSecond = request.constraints.ratePerSecond;
	}
	return summary;
}

function safeMethodId(value: string | undefined, fallback: string): string {
	const methodId = value ?? fallback;
	return Buffer.byteLength(methodId, "utf8") <= MAX_METHOD_ID_BYTES &&
		identifierSchema.safeParse(methodId).success
		? methodId
		: fallback;
}

function sourceSet(value: readonly string[] | undefined): string[] | undefined {
	if (!value) return undefined;
	const parsed = capabilityListSchema.safeParse([...value]);
	return parsed.success ? [...parsed.data] : undefined;
}

function scopeForResource(resource: CapabilityResource): InvocationScope {
	switch (resource.type) {
		case "user":
			return { userId: resource.id };
		case "project":
			return { projectId: resource.id };
		case "workspace":
			return { workspaceId: resource.id };
		case "chapter":
			return { chapterId: resource.id };
		case "narrator":
			return { narratorId: resource.id };
		case "provider":
			return { providerInstanceId: resource.id };
		case "device":
			return { deviceId: resource.id };
	}
}

function mergeScope(current: InvocationScope, requested: InvocationScope): InvocationScope {
	return {
		...current,
		...requested,
	};
}

function scopeEntries(scope: InvocationScope): Array<[keyof InvocationScope, string]> {
	return Object.entries(scope).filter((entry): entry is [keyof InvocationScope, string] => {
		return typeof entry[1] === "string";
	});
}

function hasSameScope(a: InvocationScope, b: InvocationScope): boolean {
	return scopeEntries(a).every(([key, value]) => b[key] === value);
}

function grantScopeId(scope: PermissionScope): { type: string; id: string } | undefined {
	if (scope.type === "global" || scope.type === "session" || !scope.id) return undefined;
	return { type: scope.type, id: scope.id };
}

export class CapabilityBroker {
	private readonly staticBindings = new Map<string, PluginCapabilityBindingInput>();
	private readonly resolveBindingOption?: PluginBindingResolver;
	private readonly scopeResolver?: ScopeResolver | ScopeResolver["resolve"];
	private readonly resolveManifestRequested?: CapabilitySourceResolver;
	private readonly resolveInstallationGrants?: CapabilityBrokerOptions["resolveInstallationGrants"];
	private readonly resolveHostPolicy?: CapabilitySourceResolver;
	private readonly resolveCurrentUserAuthority?: CapabilitySourceResolver;
	private readonly resolveContributionPolicy?: CapabilitySourceResolver;
	private readonly resolveRunnerEnforcement?: CapabilitySourceResolver;
	private readonly auditSink?: PluginAuditSink;
	private readonly maxAuditEntries: number;
	private readonly cacheTtlMs: number;
	private readonly now: () => Date;
	private readonly cache = new Map<string, CacheEntry>();
	private readonly auditEntries: PluginAuditSummary[] = [];
	private readonly revokedPlugins = new Set<string>();
	private readonly revokedGrants = new Set<string>();

	/**
	 * Bindings are keyed per running instance (pluginId + runtimeId), not per pluginId, so
	 * concurrent UI sessions / runtimes of the same plugin never overwrite each other.
	 */
	private bindingKey(pluginId: string, runtimeId: string): string {
		return `${pluginId} ${runtimeId}`;
	}

	private runtimeIdOf(binding: PluginCapabilityBindingInput): string | undefined {
		return binding.plugin?.runtimeId ?? binding.principal?.runtimeId;
	}

	private lookupBinding(
		pluginId: string,
		runtimeId?: string,
	): PluginCapabilityBindingInput | undefined {
		if (runtimeId) {
			const byRuntime = this.staticBindings.get(this.bindingKey(pluginId, runtimeId));
			if (byRuntime) return byRuntime;
		}
		return this.staticBindings.get(pluginId);
	}

	constructor(options: CapabilityBrokerOptions = {}) {
		const bindings = options.bindings ?? options.pluginBindings;
		if (bindings instanceof Map) {
			for (const [pluginId, binding] of bindings) this.storeBinding(pluginId, binding);
		} else if (bindings) {
			for (const binding of bindings) {
				const plugin = binding.plugin ?? binding.principal;
				const pluginId = binding.pluginId ?? plugin?.pluginId;
				if (pluginId) this.storeBinding(pluginId, binding);
			}
		}
		this.resolveBindingOption =
			options.resolveBinding ?? options.resolvePlugin ?? options.pluginResolver;
		this.scopeResolver = options.scopeResolver ?? options.resolveScope;
		this.resolveManifestRequested = options.resolveManifestRequested;
		this.resolveInstallationGrants = options.resolveInstallationGrants;
		this.resolveHostPolicy = options.resolveHostPolicy;
		this.resolveCurrentUserAuthority = options.resolveCurrentUserAuthority;
		this.resolveContributionPolicy = options.resolveContributionPolicy;
		this.resolveRunnerEnforcement = options.resolveRunnerEnforcement;
		this.auditSink = options.auditSink;
		this.maxAuditEntries = Math.min(
			MAX_AUDIT_ENTRIES,
			Math.max(1, Math.floor(options.maxAuditEntries ?? MAX_AUDIT_ENTRIES)),
		);
		this.cacheTtlMs = Math.max(0, Math.floor(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS));
		this.now = options.now ?? (() => new Date());
	}

	/** Replace the host-resolved binding for one running instance and invalidate old decisions. */
	setBinding(pluginId: string, binding: PluginCapabilityBindingInput): void {
		if (!pluginId.trim()) throw new ValidationError("Plugin capability binding requires pluginId");
		this.storeBinding(pluginId, binding);
		this.invalidate(pluginId);
	}

	private storeBinding(pluginId: string, binding: PluginCapabilityBindingInput): void {
		const runtimeId = this.runtimeIdOf(binding);
		const key = runtimeId ? this.bindingKey(pluginId, runtimeId) : pluginId;
		this.staticBindings.set(key, binding);
	}

	/** Remove one running instance's binding and invalidate its cached decisions. */
	clearBinding(pluginId: string, runtimeId: string): void {
		this.staticBindings.delete(this.bindingKey(pluginId, runtimeId));
		this.staticBindings.delete(pluginId);
		this.invalidate(pluginId);
	}

	/** Remove every binding for a plugin (all running instances / UI sessions). */
	clearBindingsForPlugin(pluginId: string): void {
		const prefix = `${pluginId} `;
		for (const key of this.staticBindings.keys()) {
			if (key === pluginId || key.startsWith(prefix)) this.staticBindings.delete(key);
		}
		this.invalidate(pluginId);
	}

	/** Create a host-owned context. Plugin identity fields are never accepted from the call options. */
	withCallContext(input: {
		plugin: unknown;
		invocation: unknown;
		scope?: unknown;
		requestId?: unknown;
		correlationId?: unknown;
		deadlineAt?: unknown;
	}): HostCallContext;
	withCallContext(
		plugin: unknown,
		invocation: unknown,
		scope?: unknown,
		options?: { requestId?: unknown; correlationId?: unknown; deadlineAt?: unknown },
	): HostCallContext;
	withCallContext(
		inputOrPlugin: unknown,
		invocation?: unknown,
		scope?: unknown,
		options: { requestId?: unknown; correlationId?: unknown; deadlineAt?: unknown } = {},
	): HostCallContext {
		const input =
			isRecord(inputOrPlugin) && "plugin" in inputOrPlugin && "invocation" in inputOrPlugin
				? inputOrPlugin
				: {
						plugin: inputOrPlugin,
						invocation,
						scope,
						...options,
					};
		const allowedInputKeys = new Set([
			"plugin",
			"invocation",
			"scope",
			"requestId",
			"correlationId",
			"deadlineAt",
		]);
		if (Object.keys(input).some((key) => !allowedInputKeys.has(key))) {
			throw this.error(PLUGIN_ERROR_CODES.CONTEXT_UNAVAILABLE, "INVALID_CONTEXT");
		}
		const parsedPlugin = pluginPrincipalSchema.safeParse(input.plugin);
		if (parsedPlugin.success) {
			const staticBinding = this.lookupBinding(
				parsedPlugin.data.pluginId,
				parsedPlugin.data.runtimeId,
			);
			const boundPrincipal = staticBinding?.plugin ?? staticBinding?.principal;
			if (boundPrincipal && !samePrincipal(parsedPlugin.data, boundPrincipal)) {
				throw this.error(PLUGIN_ERROR_CODES.CONTEXT_UNAVAILABLE, "PLUGIN_IDENTITY_MISMATCH");
			}
		}
		const parsedInvocation = invocationPrincipalSchema.safeParse(input.invocation);
		const parsedScope = permissionInvocationScopeSchema.safeParse(input.scope ?? {});
		const requestId = input.requestId ?? `plugin_req_${generateShortId(16)}`;
		const correlationId = input.correlationId ?? `plugin_corr_${generateShortId(16)}`;
		const deadlineAt = input.deadlineAt ?? new Date(this.now().getTime() + 30_000).toISOString();
		const parsed = hostCallContextSchema.safeParse({
			requestId,
			correlationId,
			deadlineAt,
			plugin: parsedPlugin.success ? parsedPlugin.data : input.plugin,
			invocation: parsedInvocation.success ? parsedInvocation.data : input.invocation,
			scope: parsedScope.success ? parsedScope.data : input.scope,
		});
		if (!parsed.success)
			throw this.error(PLUGIN_ERROR_CODES.CONTEXT_UNAVAILABLE, "INVALID_CONTEXT");
		return deepFreeze(parsed.data);
	}

	async authorize(input: CapabilityAuthorizationRequest): Promise<AuthorizationResult>;
	async authorize(
		context: HostCallContext,
		capability: string,
		options?: Omit<CapabilityAuthorizationRequest, "context" | "capability">,
	): Promise<AuthorizationResult>;
	async authorize(
		inputOrContext: CapabilityAuthorizationRequest | HostCallContext,
		capability?: string,
		options: Omit<CapabilityAuthorizationRequest, "context" | "capability"> = {},
	): Promise<AuthorizationResult> {
		const startedAt = this.now().getTime();
		const rawRequest =
			"context" in inputOrContext
				? inputOrContext
				: { ...options, context: inputOrContext, capability: capability ?? "" };
		const normalized = this.normalizeRequest(rawRequest);
		if (!normalized.success) {
			const fallback = this.auditFallback(rawRequest);
			const error = this.error(PLUGIN_ERROR_CODES.INVALID_PARAMS, "INVALID_CONTEXT");
			await this.recordAudit(fallback, error, startedAt);
			return { allowed: false, error };
		}
		const request = normalized.data;
		const binding = await this.resolveBinding(request.context);
		if (!binding) {
			const error = this.error(PLUGIN_ERROR_CODES.CONTEXT_UNAVAILABLE, "INVALID_CONTEXT");
			await this.recordAudit(request, error, startedAt);
			return { allowed: false, error };
		}
		const stateError = this.validateBindingIdentity(request.context, binding);
		if (stateError) {
			await this.recordAudit(request, stateError, startedAt);
			return { allowed: false, error: stateError };
		}
		const stateGate = this.validateLifecycle(binding);
		if (stateGate) {
			await this.recordAudit(request, stateGate, startedAt);
			return { allowed: false, error: stateGate };
		}
		if (
			request.context.deadlineAt &&
			Date.parse(request.context.deadlineAt) <= this.now().getTime()
		) {
			const error = this.error(PLUGIN_ERROR_CODES.TIMEOUT, "INVALID_CONTEXT", 408);
			await this.recordAudit(request, error, startedAt);
			return { allowed: false, error };
		}
		if (this.revokedPlugins.has(binding.plugin.pluginId)) {
			const error = this.error(PLUGIN_ERROR_CODES.PERMISSION_DENIED, "GRANT_REVOKED");
			await this.recordAudit(request, error, startedAt);
			return { allowed: false, error };
		}

		const resolved = await this.resolveSources(request.context, binding);
		if (!resolved) {
			const error = this.error(PLUGIN_ERROR_CODES.PERMISSION_DENIED, "MISSING_SOURCE");
			await this.recordAudit(request, error, startedAt);
			return { allowed: false, error };
		}
		const scopeError = await this.validateInvocationScope(request, binding.plugin);
		if (scopeError) {
			await this.recordAudit(request, scopeError, startedAt, resolved.grantRevision);
			return { allowed: false, error: scopeError };
		}
		const cacheKey = this.cacheKey(request, resolved.grantRevision);
		const cached = this.cache.get(cacheKey);
		const cachedGrantExpired =
			cached?.result.grant.expiresAt !== undefined &&
			Date.parse(cached.result.grant.expiresAt) <= this.now().getTime();
		const cachedGrantRevoked =
			cached?.result.grant.grantId !== undefined &&
			this.revokedGrants.has(cached.result.grant.grantId);
		if (
			cached &&
			cached.expiresAt > this.now().getTime() &&
			!cachedGrantExpired &&
			!cachedGrantRevoked
		) {
			const result = {
				...clone(cached.result),
				context: request.context,
				cacheHit: true,
			};
			await this.recordAudit(request, undefined, startedAt, resolved.grantRevision, "CACHE_HIT");
			return result;
		}
		this.cache.delete(cacheKey);

		const capabilityGrants = resolved.installationGrants.filter(
			(grant) => grant.capability === request.capability,
		);
		const validGrants = capabilityGrants.filter((grant) => {
			if (grant.grantId && this.revokedGrants.has(grant.grantId)) return false;
			return true;
		});
		if (validGrants.length === 0) {
			const reason = capabilityGrants.some(
				(grant) => grant.grantId && this.revokedGrants.has(grant.grantId),
			)
				? "GRANT_REVOKED"
				: "CAPABILITY_NOT_GRANTED";
			const error = this.error(PLUGIN_ERROR_CODES.PERMISSION_DENIED, reason);
			await this.recordAudit(request, error, startedAt, resolved.grantRevision);
			return { allowed: false, error };
		}
		const grantResult = await this.findMatchingGrant(validGrants, request);
		if (grantResult.kind === "expired") {
			const error = this.error(PLUGIN_ERROR_CODES.PERMISSION_DENIED, "GRANT_EXPIRED");
			await this.recordAudit(request, error, startedAt, resolved.grantRevision);
			return { allowed: false, error };
		}
		if (grantResult.kind === "invalid") {
			const error = this.error(PLUGIN_ERROR_CODES.PERMISSION_DENIED, "INVALID_GRANT");
			await this.recordAudit(request, error, startedAt, resolved.grantRevision);
			return { allowed: false, error };
		}
		if (grantResult.kind === "constraints") {
			const code =
				grantResult.reason === "RATE_LIMITED"
					? PLUGIN_ERROR_CODES.RATE_LIMITED
					: grantResult.reason === "PAYLOAD_TOO_LARGE"
						? PLUGIN_ERROR_CODES.PAYLOAD_TOO_LARGE
						: PLUGIN_ERROR_CODES.PERMISSION_DENIED;
			const error = this.error(
				code,
				"CONSTRAINT_MISMATCH",
				code === PLUGIN_ERROR_CODES.RATE_LIMITED
					? 429
					: code === PLUGIN_ERROR_CODES.PAYLOAD_TOO_LARGE
						? 413
						: 403,
			);
			await this.recordAudit(request, error, startedAt, resolved.grantRevision);
			return { allowed: false, error };
		}

		const sourceIntersection = [
			resolved.manifestRequested,
			resolved.hostPolicy,
			resolved.currentUserAuthority,
			resolved.contributionPolicy,
			resolved.runnerEnforcement,
		];
		const effectiveCapabilities: string[] = [];
		for (const candidate of [...new Set(CAPABILITIES)]) {
			if (!sourceIntersection.every((source) => source.includes(candidate))) continue;
			if (await this.hasUsableGrant(candidate, request, resolved.installationGrants)) {
				effectiveCapabilities.push(candidate);
			}
		}
		if (!effectiveCapabilities.includes(request.capability)) {
			const error = this.intersectionError(request.capability, resolved);
			await this.recordAudit(request, error, startedAt, resolved.grantRevision);
			return { allowed: false, error };
		}

		const result: AuthorizationSuccess = {
			allowed: true,
			capability: request.capability,
			context: request.context,
			grant: clone(grantResult.grant),
			effectiveCapabilities,
			grantRevision: resolved.grantRevision,
			cacheHit: false,
		};
		if (this.cacheTtlMs > 0) {
			const grantExpiry = result.grant.expiresAt
				? Date.parse(result.grant.expiresAt)
				: Number.POSITIVE_INFINITY;
			this.cache.set(cacheKey, {
				expiresAt: Math.min(this.now().getTime() + this.cacheTtlMs, grantExpiry),
				result: clone(result),
			});
		}
		await this.recordAudit(request, undefined, startedAt, resolved.grantRevision);
		return result;
	}

	async require(input: CapabilityAuthorizationRequest): Promise<AuthorizationSuccess>;
	async require(
		context: HostCallContext,
		capability: string,
		options?: Omit<CapabilityAuthorizationRequest, "context" | "capability">,
	): Promise<AuthorizationSuccess>;
	async require(
		inputOrContext: CapabilityAuthorizationRequest | HostCallContext,
		capability?: string,
		options: Omit<CapabilityAuthorizationRequest, "context" | "capability"> = {},
	): Promise<AuthorizationSuccess> {
		const result =
			"context" in inputOrContext
				? await this.authorize(inputOrContext)
				: await this.authorize(inputOrContext, capability ?? "", options);
		if (!result.allowed) throw result.error;
		return result;
	}

	/** Revoke all cached capability decisions for a plugin or one grant and force a fresh lookup. */
	invalidate(pluginId?: string): void {
		if (!pluginId) {
			this.cache.clear();
			return;
		}
		for (const [key, entry] of this.cache) {
			if (entry.result.context.plugin.pluginId === pluginId) this.cache.delete(key);
		}
	}

	revoke(pluginId: string, grantId?: string): void {
		if (grantId) this.revokedGrants.add(grantId);
		else this.revokedPlugins.add(pluginId);
		this.invalidate(pluginId);
	}

	restore(pluginId: string, grantId?: string): void {
		if (grantId) this.revokedGrants.delete(grantId);
		else this.revokedPlugins.delete(pluginId);
		this.invalidate(pluginId);
	}

	clearCache(): void {
		this.cache.clear();
	}

	getAuditSummaries(): PluginAuditSummary[] {
		return clone(this.auditEntries);
	}

	private normalizeRequest(
		input: CapabilityAuthorizationRequest,
	): { success: true; data: NormalizedRequest } | { success: false } {
		if (!isRecord(input) || !isRecord(input.context)) return { success: false };
		const context = hostCallContextSchema.safeParse(input.context);
		const capability = capabilitySchema.safeParse(input.capability);
		const scope = permissionInvocationScopeSchema.safeParse(input.scope ?? {});
		const constraints = authorizationConstraintsSchema.safeParse(input.constraints ?? {});
		const resource =
			input.resource === undefined
				? { success: true, data: undefined }
				: resourceSchema.safeParse(input.resource);
		const requestBytes =
			input.requestBytes === undefined ? 0 : safeBytes(input.requestBytes, MAX_REQUEST_BYTES);
		const responseBytes =
			input.responseBytes === undefined ? 0 : safeBytes(input.responseBytes, MAX_RESPONSE_BYTES);
		if (
			!context.success ||
			!capability.success ||
			!scope.success ||
			!constraints.success ||
			!resource.success ||
			requestBytes === undefined ||
			responseBytes === undefined
		) {
			return { success: false };
		}
		return {
			success: true,
			data: {
				context: context.data,
				capability: capability.data,
				methodId: safeMethodId(input.methodId, capability.data),
				scope: scope.data,
				resource: resource.data,
				constraints: constraints.data,
				requestBytes,
				responseBytes,
			},
		};
	}

	private auditFallback(input: CapabilityAuthorizationRequest): NormalizedRequest {
		const context: Record<string, unknown> = isRecord(input?.context) ? input.context : {};
		const plugin: Record<string, unknown> = isRecord(context.plugin) ? context.plugin : {};
		const invocation: Record<string, unknown> = isRecord(context.invocation)
			? context.invocation
			: {};
		return {
			context: {
				requestId: typeof context.requestId === "string" ? context.requestId : "invalid",
				correlationId:
					typeof context.correlationId === "string"
						? context.correlationId
						: `invalid_${generateShortId(6)}`,
				deadlineAt:
					typeof context.deadlineAt === "string" ? context.deadlineAt : new Date(0).toISOString(),
				plugin: {
					pluginId: typeof plugin.pluginId === "string" ? plugin.pluginId : "invalid.plugin",
					packageVersion: "0.0.0",
					runtimeId: "invalid",
					runtimeGeneration: 0,
					installationId: "invalid",
				},
				invocation: {
					kind:
						invocation.kind === "user" || invocation.kind === "system"
							? invocation.kind
							: "plugin_background",
					source: "internal",
				},
				scope: {},
			},
			capability: capabilitySchema.safeParse(input?.capability).success
				? (input.capability as (typeof CAPABILITIES)[number])
				: "query.read.projects",
			methodId: safeMethodId(input?.methodId, "unknown"),
			scope: {},
			constraints: {},
			requestBytes: 0,
			responseBytes: 0,
		};
	}

	private async resolveBinding(context: HostCallContext): Promise<NormalizedBinding | undefined> {
		const raw = this.resolveBindingOption
			? await this.resolveBindingOption(context.plugin.pluginId, context)
			: this.lookupBinding(context.plugin.pluginId, context.plugin.runtimeId);
		if (!raw) return undefined;
		return this.normalizeBinding(raw, context.plugin.pluginId);
	}

	private normalizeBinding(
		raw: PluginCapabilityBindingInput,
		expectedPluginId: string,
	): NormalizedBinding | undefined {
		const plugin = raw.plugin ?? raw.principal;
		if (!plugin) return undefined;
		const state = raw.state ?? {};
		const desiredState = raw.desiredState ?? state.desiredState;
		const compatibilityState =
			raw.compatibilityState ?? state.compatibilityState ?? state.compatibility;
		const runtimeState = raw.runtimeState ?? state.runtimeState;
		const trustTier = raw.trustTier ?? state.trustTier;
		const runtimeGeneration =
			raw.runtimeGeneration ?? state.runtimeGeneration ?? plugin.runtimeGeneration;
		const manifestRequested = raw.manifestRequested ?? raw.manifest?.permissions?.host;
		const installationGrants = raw.installationGrants;
		const sources = [
			raw.hostPolicy,
			raw.currentUserAuthority,
			raw.contributionPolicy,
			raw.runnerEnforcement,
		];
		if (
			plugin.pluginId !== expectedPluginId ||
			!pluginPrincipalSchema.safeParse(plugin).success ||
			desiredState === undefined ||
			compatibilityState === undefined ||
			runtimeState === undefined ||
			runtimeGeneration === undefined ||
			manifestRequested === undefined ||
			installationGrants === undefined ||
			sources.some((source) => source === undefined)
		)
			return undefined;
		const parsedGrants = permissionGrantSchema.array().safeParse([...installationGrants]);
		if (!parsedGrants.success) return undefined;
		const parsedState = lifecycleStateSchema.safeParse({
			desiredState,
			compatibilityState,
			runtimeState,
			trustTier,
			runtimeGeneration,
		});
		if (!parsedState.success) return undefined;
		const parsedManifest = sourceSet(manifestRequested);
		const parsedSources = sources.map(sourceSet);
		if (!parsedManifest || parsedSources.some((source) => !source)) return undefined;
		return {
			plugin,
			desiredState: parsedState.data.desiredState,
			compatibilityState: parsedState.data.compatibilityState,
			runtimeState: parsedState.data.runtimeState,
			trustTier: parsedState.data.trustTier,
			runtimeGeneration: parsedState.data.runtimeGeneration ?? plugin.runtimeGeneration,
			manifestRequested: parsedManifest,
			installationGrants: parsedGrants.data,
			hostPolicy: parsedSources[0] ?? [],
			currentUserAuthority: parsedSources[1] ?? [],
			contributionPolicy: parsedSources[2] ?? [],
			runnerEnforcement: parsedSources[3] ?? [],
			grantRevision: raw.grantRevision,
		};
	}

	private async resolveSources(
		context: HostCallContext,
		binding: NormalizedBinding,
	): Promise<
		| {
				manifestRequested: string[];
				installationGrants: PermissionGrant[];
				hostPolicy: string[];
				currentUserAuthority: string[];
				contributionPolicy: string[];
				runnerEnforcement: string[];
				grantRevision?: number;
		  }
		| undefined
	> {
		const values = await Promise.all([
			this.resolveManifestRequested?.(context),
			this.resolveInstallationGrants?.(context),
			this.resolveHostPolicy?.(context),
			this.resolveCurrentUserAuthority?.(context),
			this.resolveContributionPolicy?.(context),
			this.resolveRunnerEnforcement?.(context),
		]);
		const manifestRequested = sourceSet(
			this.resolveManifestRequested ? values[0] : binding.manifestRequested,
		);
		const installationGrantsRaw = this.resolveInstallationGrants
			? values[1]
			: binding.installationGrants;
		const hostPolicy = sourceSet(this.resolveHostPolicy ? values[2] : binding.hostPolicy);
		const currentUserAuthority = sourceSet(
			this.resolveCurrentUserAuthority ? values[3] : binding.currentUserAuthority,
		);
		const contributionPolicy = sourceSet(
			this.resolveContributionPolicy ? values[4] : binding.contributionPolicy,
		);
		const runnerEnforcement = sourceSet(
			this.resolveRunnerEnforcement ? values[5] : binding.runnerEnforcement,
		);
		if (!installationGrantsRaw) return undefined;
		const grants = permissionGrantSchema.array().safeParse([...installationGrantsRaw]);
		if (
			!manifestRequested ||
			!hostPolicy ||
			!currentUserAuthority ||
			!contributionPolicy ||
			!runnerEnforcement ||
			!grants.success
		)
			return undefined;
		return {
			manifestRequested,
			installationGrants: grants.data,
			hostPolicy,
			currentUserAuthority,
			contributionPolicy,
			runnerEnforcement,
			grantRevision: binding.grantRevision,
		};
	}

	private validateBindingIdentity(
		context: HostCallContext,
		binding: NormalizedBinding,
	): CapabilityBrokerError | undefined {
		if (context.plugin.pluginId !== binding.plugin.pluginId) {
			return this.error(PLUGIN_ERROR_CODES.CONTEXT_UNAVAILABLE, "PLUGIN_IDENTITY_MISMATCH");
		}
		if (
			context.plugin.packageVersion !== binding.plugin.packageVersion ||
			context.plugin.installationId !== binding.plugin.installationId ||
			context.plugin.contributionId !== binding.plugin.contributionId
		) {
			return this.error(PLUGIN_ERROR_CODES.CONTEXT_UNAVAILABLE, "PLUGIN_IDENTITY_MISMATCH");
		}
		if (context.plugin.runtimeId !== binding.plugin.runtimeId) {
			return this.error(PLUGIN_ERROR_CODES.CONTEXT_UNAVAILABLE, "RUNTIME_IDENTITY_MISMATCH");
		}
		if (
			context.plugin.runtimeGeneration !== binding.runtimeGeneration ||
			context.plugin.runtimeGeneration !== binding.plugin.runtimeGeneration
		) {
			return this.error(PLUGIN_ERROR_CODES.CONTEXT_UNAVAILABLE, "RUNTIME_GENERATION_MISMATCH");
		}
		return undefined;
	}

	private validateLifecycle(binding: NormalizedBinding): CapabilityBrokerError | undefined {
		if (binding.desiredState !== "enabled") {
			return this.error(PLUGIN_ERROR_CODES.PLUGIN_DISABLED, "PLUGIN_NOT_ENABLED", 409);
		}
		if (binding.compatibilityState !== "compatible") {
			return this.error(PLUGIN_ERROR_CODES.INCOMPATIBLE, "PLUGIN_INCOMPATIBLE", 409);
		}
		if (binding.runtimeState === "quarantine") {
			return this.error(PLUGIN_ERROR_CODES.PLUGIN_DISABLED, "PLUGIN_QUARANTINED", 423);
		}
		if (binding.runtimeState !== "active" && binding.runtimeState !== "degraded") {
			return this.error(PLUGIN_ERROR_CODES.HOST_UNAVAILABLE, "PLUGIN_RUNTIME_UNAVAILABLE", 503);
		}
		if (binding.trustTier === "T3") {
			return this.error(PLUGIN_ERROR_CODES.PLUGIN_DISABLED, "PLUGIN_RUNTIME_UNAVAILABLE", 423);
		}
		return undefined;
	}

	private async validateInvocationScope(
		request: NormalizedRequest,
		plugin: PluginPrincipal,
	): Promise<CapabilityBrokerError | undefined> {
		const currentScope = request.context.scope;
		const requestedScope = mergeScope(currentScope, request.scope);
		if (
			request.context.invocation.kind === "user" &&
			requestedScope.userId !== undefined &&
			requestedScope.userId !== request.context.invocation.userId
		) {
			return this.error(PLUGIN_ERROR_CODES.PERMISSION_DENIED, "SCOPE_ESCALATION");
		}
		if (request.context.invocation.kind !== "user" && requestedScope.userId !== undefined) {
			return this.error(PLUGIN_ERROR_CODES.PERMISSION_DENIED, "SCOPE_ESCALATION");
		}
		const allowed = await this.resolveScope({
			mode: "invocation",
			plugin,
			context: request.context,
			currentScope,
			requestedScope: request.scope,
		});
		if (!allowed) return this.error(PLUGIN_ERROR_CODES.PERMISSION_DENIED, "SCOPE_ESCALATION");
		if (request.resource) {
			const resourceScope = scopeForResource(request.resource);
			const resourceAllowed = await this.resolveScope({
				mode: "invocation",
				plugin,
				context: request.context,
				currentScope: requestedScope,
				requestedScope: resourceScope,
			});
			if (!resourceAllowed)
				return this.error(PLUGIN_ERROR_CODES.NOT_FOUND_OR_DENIED, "MISSING_SCOPE");
		}
		return undefined;
	}

	private async resolveScope(input: ScopeResolutionInput): Promise<boolean> {
		const custom =
			typeof this.scopeResolver === "function"
				? this.scopeResolver
				: (this.scopeResolver?.resolve ?? this.scopeResolver?.isAllowed);
		if (custom) {
			const result = await custom(input);
			if (result !== undefined) return result;
		}
		if (input.mode === "grant") {
			const scope = input.grantScope;
			if (!scope || scope.type === "global") return true;
			if (scope.type === "session") return false;
			const id = scope.id;
			if (!id) return false;
			const field = scopeFieldByType[scope.type];
			if (input.currentScope[field] === id) return true;
			const grant = grantScopeId(scope);
			const currentEntries = scopeEntries(input.currentScope);
			if (
				grant &&
				this.scopeResolver &&
				"belongs" in this.scopeResolver &&
				this.scopeResolver.belongs
			) {
				for (const [currentField, currentId] of currentEntries) {
					const currentType = Object.entries(scopeFieldByType).find(
						([, value]) => value === currentField,
					)?.[0];
					if (!currentType || currentId === id) continue;
					const belongs = await this.scopeResolver.belongs(
						{ type: currentType, id: currentId },
						grant,
						input,
					);
					if (belongs === true) return true;
				}
			}
			return false;
		}
		if (hasSameScope(input.requestedScope, input.currentScope)) return true;
		if (scopeEntries(input.currentScope).length === 0) return true;
		for (const [requestedField, requestedId] of scopeEntries(input.requestedScope)) {
			const currentId = input.currentScope[requestedField];
			if (currentId === requestedId) continue;
			if (currentId !== undefined) return false;
			const requestedType = Object.entries(scopeFieldByType).find(
				([, value]) => value === requestedField,
			)?.[0];
			if (!requestedType) return false;
			const currentEntries = scopeEntries(input.currentScope);
			if (this.scopeResolver && "belongs" in this.scopeResolver && this.scopeResolver.belongs) {
				let matched = false;
				for (const [currentField, currentValue] of currentEntries) {
					const currentType = Object.entries(scopeFieldByType).find(
						([, value]) => value === currentField,
					)?.[0];
					if (!currentType) continue;
					const belongs = await this.scopeResolver.belongs(
						{ type: requestedType, id: requestedId },
						{ type: currentType, id: currentValue },
						input,
					);
					if (belongs === true) {
						matched = true;
						break;
					}
				}
				if (matched) continue;
			}
			return false;
		}
		return true;
	}

	private async hasUsableGrant(
		capability: string,
		request: NormalizedRequest,
		grants: PermissionGrant[],
	): Promise<boolean> {
		const currentScope = {
			...request.context.scope,
			...request.scope,
			...(request.resource ? scopeForResource(request.resource) : {}),
		};
		for (const grant of grants) {
			if (grant.capability !== capability) continue;
			if (grant.grantId && this.revokedGrants.has(grant.grantId)) continue;
			if (grant.expiresAt && Date.parse(grant.expiresAt) <= this.now().getTime()) continue;
			if (
				await this.resolveScope({
					mode: "grant",
					plugin: request.context.plugin,
					context: request.context,
					currentScope,
					requestedScope: request.scope,
					grantScope: grant.scope,
				})
			)
				return true;
		}
		return false;
	}

	private async findMatchingGrant(
		grants: PermissionGrant[],
		request: NormalizedRequest,
	): Promise<
		| { kind: "match"; grant: PermissionGrant }
		| { kind: "expired" }
		| { kind: "invalid" }
		| { kind: "constraints"; reason: "PERMISSION_DENIED" | "RATE_LIMITED" | "PAYLOAD_TOO_LARGE" }
	> {
		let sawExpired = false;
		let sawConstraintMismatch = false;
		let constraintReason: "PERMISSION_DENIED" | "RATE_LIMITED" | "PAYLOAD_TOO_LARGE" =
			"PERMISSION_DENIED";
		for (const grant of grants) {
			if (grant.expiresAt && Date.parse(grant.expiresAt) <= this.now().getTime()) {
				sawExpired = true;
				continue;
			}
			const currentScope = {
				...request.context.scope,
				...request.scope,
				...(request.resource ? scopeForResource(request.resource) : {}),
			};
			const scopeAllowed = await this.resolveScope({
				mode: "grant",
				plugin: request.context.plugin,
				context: request.context,
				currentScope,
				requestedScope: request.scope,
				grantScope: grant.scope,
			});
			if (!scopeAllowed) {
				sawConstraintMismatch = true;
				continue;
			}
			const constraintResult = this.matchConstraints(
				grant.constraints,
				request.constraints,
				request.resource,
			);
			if (constraintResult !== true) {
				sawConstraintMismatch = true;
				constraintReason = constraintResult;
				continue;
			}
			return { kind: "match", grant };
		}
		if (sawExpired) return { kind: "expired" };
		if (sawConstraintMismatch) return { kind: "constraints", reason: constraintReason };
		return { kind: "invalid" };
	}

	private matchConstraints(
		grant: PermissionGrant["constraints"],
		request: CapabilityAuthorizationConstraints,
		resource?: CapabilityResource,
	): true | "PERMISSION_DENIED" | "RATE_LIMITED" | "PAYLOAD_TOO_LARGE" {
		if (!grant) return true;
		let denied = false;
		const requestedTopics = [...(request.topics ?? []), ...(request.topic ? [request.topic] : [])];
		if (
			grant.topics &&
			(requestedTopics.length === 0 ||
				requestedTopics.some((topic) => !grant.topics?.includes(topic)))
		)
			denied = true;
		const requestedResources = [
			...(request.resourceIds ?? []),
			...(request.resourceId ? [request.resourceId] : []),
			...(resource ? [resource.id] : []),
		];
		if (
			grant.resourceIds &&
			(requestedResources.length === 0 ||
				requestedResources.some((id) => !grant.resourceIds?.includes(id)))
		)
			denied = true;
		const requestedPaths = [...(request.paths ?? []), ...(request.path ? [request.path] : [])];
		if (
			grant.paths &&
			(requestedPaths.length === 0 ||
				requestedPaths.some(
					(path) => !grant.paths?.some((allowed) => this.pathWithin(path, allowed)),
				))
		)
			denied = true;
		const requestedFields = [...(request.fields ?? []), ...(request.field ? [request.field] : [])];
		if (
			grant.fields &&
			(requestedFields.length === 0 ||
				requestedFields.some((field) => !grant.fields?.includes(field)))
		)
			denied = true;
		const requestedMethods = [
			...(request.methods ?? []),
			...(request.method ? [request.method] : []),
		];
		if (
			grant.methods &&
			(requestedMethods.length === 0 ||
				requestedMethods.some((method) => !grant.methods?.includes(method)))
		)
			denied = true;
		const providerIds = [
			...(request.providerInstanceIds ?? []),
			...(request.providerInstanceId ? [request.providerInstanceId] : []),
			...(resource?.type === "provider" ? [resource.id] : []),
		];
		if (
			grant.providerInstanceIds &&
			(providerIds.length === 0 ||
				providerIds.some((id) => !grant.providerInstanceIds?.includes(id)))
		)
			denied = true;
		if (
			grant.maxRatePerSecond !== undefined &&
			(request.ratePerSecond === undefined || request.ratePerSecond > grant.maxRatePerSecond)
		)
			return "RATE_LIMITED";
		if (
			grant.maxBytes !== undefined &&
			(request.maxBytes === undefined || request.maxBytes > grant.maxBytes)
		)
			return "PAYLOAD_TOO_LARGE";
		return denied ? "PERMISSION_DENIED" : true;
	}

	private pathWithin(candidate: string, allowed: string): boolean {
		const normalize = (value: string) =>
			value
				.replaceAll("\\", "/")
				.replace(/\/{2,}/g, "/")
				.replace(/\/$/, "");
		const candidatePath = normalize(candidate);
		const allowedPath = normalize(allowed);
		if (candidatePath === allowedPath) return true;
		return candidatePath.startsWith(`${allowedPath}/`) && !candidatePath.split("/").includes("..");
	}

	private intersectionError(
		capability: string,
		resolved: {
			manifestRequested: string[];
			hostPolicy: string[];
			currentUserAuthority: string[];
			contributionPolicy: string[];
			runnerEnforcement: string[];
		},
	): CapabilityBrokerError {
		if (!resolved.manifestRequested.includes(capability))
			return this.error(PLUGIN_ERROR_CODES.PERMISSION_DENIED, "CAPABILITY_NOT_REQUESTED");
		if (!resolved.hostPolicy.includes(capability))
			return this.error(PLUGIN_ERROR_CODES.PERMISSION_DENIED, "HOST_POLICY_DENIED");
		if (!resolved.currentUserAuthority.includes(capability))
			return this.error(PLUGIN_ERROR_CODES.PERMISSION_DENIED, "USER_AUTHORITY_DENIED");
		if (!resolved.contributionPolicy.includes(capability))
			return this.error(PLUGIN_ERROR_CODES.PERMISSION_DENIED, "CONTRIBUTION_POLICY_DENIED");
		if (!resolved.runnerEnforcement.includes(capability))
			return this.error(PLUGIN_ERROR_CODES.PERMISSION_DENIED, "RUNNER_DENIED");
		return this.error(PLUGIN_ERROR_CODES.PERMISSION_DENIED, "CAPABILITY_NOT_GRANTED");
	}

	private cacheKey(request: NormalizedRequest, grantRevision?: number): string {
		return JSON.stringify([
			request.context.plugin.pluginId,
			request.context.plugin.packageVersion,
			request.context.plugin.installationId,
			request.context.plugin.contributionId ?? null,
			request.context.plugin.runtimeId,
			request.context.plugin.runtimeGeneration,
			request.context.invocation.kind,
			request.context.invocation.userId ?? null,
			request.context.invocation.userRole ?? null,
			request.context.invocation.source,
			request.context.scope,
			request.scope,
			request.capability,
			request.methodId,
			request.resource ?? null,
			request.constraints,
			grantRevision ?? null,
		]);
	}

	private auditFallbackFromNormalized(request: NormalizedRequest): PluginAuditSummary {
		return {
			pluginId: request.context.plugin.pluginId,
			contributionId: request.context.plugin.contributionId,
			runtimeId: request.context.plugin.runtimeId,
			requestId: request.context.requestId,
			correlationId: request.context.correlationId,
			principalKind: request.context.invocation.kind,
			userId:
				request.context.invocation.kind === "user" ? request.context.invocation.userId : undefined,
			capability: request.capability,
			methodId: request.methodId,
			resourceType: request.resource?.type,
			resourceId: request.resource?.id,
			scopeType: request.resource?.type,
			scopeId: request.resource?.id,
			outcome: "denied",
			requestBytes: request.requestBytes,
			responseBytes: request.responseBytes,
		};
	}

	private async recordAudit(
		request: NormalizedRequest,
		error: CapabilityBrokerError | undefined,
		startedAt: number,
		grantRevision?: number,
		reason: CapabilityBrokerErrorReason | "CACHE_HIT" = error?.reason ?? "CACHE_HIT",
	): Promise<void> {
		const summary = this.auditFallbackFromNormalized(request);
		summary.outcome = error ? "denied" : "allowed";
		summary.durationMs = Math.max(0, this.now().getTime() - startedAt);
		summary.redactedSummary = redactedSummary(request, reason, grantRevision);
		this.auditEntries.push(summary);
		if (this.auditEntries.length > this.maxAuditEntries)
			this.auditEntries.splice(0, this.auditEntries.length - this.maxAuditEntries);
		if (!this.auditSink) return;
		try {
			if (typeof this.auditSink === "function") await this.auditSink(clone(summary));
			else await this.auditSink.write(clone(summary));
		} catch {
			logger.warn("Plugin capability audit sink failed", {
				code: PLUGIN_ERROR_CODES.HOST_UNAVAILABLE,
			});
		}
	}

	private error(
		code: string,
		reason: CapabilityBrokerErrorReason,
		statusCode = 403,
	): CapabilityBrokerError {
		return new CapabilityBrokerError(code, reason, statusCode);
	}
}

export const capabilityBroker = new CapabilityBroker();
