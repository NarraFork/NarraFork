import { createHash } from "node:crypto";
import { AppError, ValidationError } from "@server/lib/errors";
import { generateShortId } from "@server/lib/id";
import {
	type HostCallContext,
	hostCallContextSchema,
	type InvocationScope,
	type PluginPrincipal,
	pluginPrincipalSchema,
} from "@server/services/plugin-capability-broker";

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_MAX_LEASE_TTL_MS = 5 * 60_000;
const MAX_AUDIT_ENTRIES = 1_000;
const MAX_SECRET_ID_BYTES = 128;
const MAX_OPAQUE_REF_BYTES = 4_096;
const MAX_FINGERPRINT_BYTES = 256;

export const PLUGIN_SECRET_SCOPE_TYPES = [
	"global",
	"user",
	"project",
	"workspace",
	"chapter",
	"narrator",
	"provider",
	"device",
] as const;
export type PluginSecretScopeType = (typeof PLUGIN_SECRET_SCOPE_TYPES)[number];

export interface PluginSecretScope {
	type: PluginSecretScopeType;
	id?: string;
}

export type PluginSecretScopeInput =
	| PluginSecretScope
	| { scopeType: PluginSecretScopeType; scopeId?: string };

export type SecretProviderValue = string | Uint8Array;

export interface SecretProviderReadInput {
	pluginId: string;
	secretId: string;
	scope: PluginSecretScope;
	opaqueRef: string;
	requestId: string;
	runtimeId: string;
	runtimeGeneration: number;
	deadlineAt: string;
	purpose?: string;
}

export interface SecretProvider {
	isAvailable?: () => boolean | Promise<boolean>;
	read?: (
		input: SecretProviderReadInput,
	) => SecretProviderValue | undefined | Promise<SecretProviderValue | undefined>;
	resolve?: (
		input: SecretProviderReadInput,
	) => SecretProviderValue | undefined | Promise<SecretProviderValue | undefined>;
}

export interface SecretAuthorizationInput {
	pluginId: string;
	secretId: string;
	capability: "secret.use_self";
	method: "acquire" | "read";
	context: HostCallContext;
	scope: PluginSecretScope;
}

export type SecretAuthorizationResult = boolean | { allowed: boolean; reason?: string };

export type SecretAuthorization = (
	input: SecretAuthorizationInput,
) => SecretAuthorizationResult | Promise<SecretAuthorizationResult>;

export interface SecretConfigurationInput {
	pluginId: string;
	secretId: string;
	scope: PluginSecretScopeInput;
	opaqueRef: string;
	fingerprint?: string;
}

export interface SecretConfigurationSummary {
	pluginId: string;
	secretId: string;
	scope: PluginSecretScope;
	configured: true;
	fingerprint?: string;
	revision: number;
}

export interface SecretAcquireInput {
	secretId: string;
	scope?: PluginSecretScopeInput;
	context?: HostCallContext;
	plugin?: PluginPrincipal;
	runtimeId?: string;
	runtimeGeneration?: number;
	requestId?: string;
	correlationId?: string;
	deadlineAt?: string;
	invocationScope?: InvocationScope;
	purpose?: string;
	ttlMs?: number;
}

export interface SecretLease {
	leaseId: string;
	pluginId: string;
	secretId: string;
	scope: PluginSecretScope;
	runtimeId: string;
	runtimeGeneration: number;
	requestId: string;
	expiresAt: string;
	fingerprint?: string;
}

export interface SecretReadLeaseInput {
	leaseId: string;
	context?: HostCallContext;
	plugin?: PluginPrincipal;
	runtimeId?: string;
	runtimeGeneration?: number;
	requestId?: string;
	correlationId?: string;
	deadlineAt?: string;
	invocationScope?: InvocationScope;
}

export interface SecretAuditSummary {
	timestamp: string;
	operation: "configure" | "acquire" | "read" | "revoke";
	pluginId: string;
	secretId?: string;
	runtimeId?: string;
	runtimeGeneration?: number;
	requestId?: string;
	correlationId?: string;
	scopeType?: PluginSecretScopeType;
	scopeId?: string;
	outcome: "succeeded" | "denied" | "failed" | "expired" | "revoked";
	reason?: string;
	fingerprintPresent?: boolean;
	opaqueRefHash?: string;
	leaseHash?: string;
}

export type SecretAuditSink = (summary: SecretAuditSummary) => void | Promise<void>;

export interface PluginSecretBrokerOptions {
	provider?: SecretProvider;
	authorize?: SecretAuthorization;
	validateAccess?: SecretAuthorization;
	isPluginEnabled?: (pluginId: string) => boolean | Promise<boolean>;
	now?: () => Date;
	defaultLeaseTtlMs?: number;
	maxLeaseTtlMs?: number;
	maxAuditEntries?: number;
	auditSink?: SecretAuditSink;
}

interface SecretConfiguration {
	pluginId: string;
	secretId: string;
	scope: PluginSecretScope;
	opaqueRef: string;
	fingerprint?: string;
	revision: number;
}

interface LeaseRecord extends SecretLease {
	correlationId: string;
	purpose?: string;
	configurationRevision: number;
	opaqueRef: string;
}

interface RequestBinding {
	context: HostCallContext;
	plugin: PluginPrincipal;
	requestId: string;
	correlationId: string;
	deadlineAt: string;
	scope: InvocationScope;
}

export type PluginSecretBrokerErrorReason =
	| "INVALID_PARAMS"
	| "SECRET_NOT_CONFIGURED"
	| "PROVIDER_UNAVAILABLE"
	| "PROVIDER_ERROR"
	| "PERMISSION_DENIED"
	| "PLUGIN_DISABLED"
	| "PLUGIN_IDENTITY_MISMATCH"
	| "RUNTIME_IDENTITY_MISMATCH"
	| "RUNTIME_GENERATION_MISMATCH"
	| "REQUEST_MISMATCH"
	| "SCOPE_MISMATCH"
	| "LEASE_EXPIRED"
	| "LEASE_REVOKED"
	| "DEADLINE_EXPIRED";

export class PluginSecretBrokerError extends AppError {
	readonly reason: PluginSecretBrokerErrorReason;

	constructor(
		code: string,
		reason: PluginSecretBrokerErrorReason,
		message: string,
		statusCode = 403,
	) {
		super(message, statusCode, code);
		this.name = "PluginSecretBrokerError";
		this.reason = reason;
	}
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint < 0x20 || codePoint === 0x7f) return true;
	}
	return false;
}

function assertText(
	value: unknown,
	label: string,
	maxBytes: number,
	allowEmpty = false,
): asserts value is string {
	if (
		typeof value !== "string" ||
		(!allowEmpty && value.length === 0) ||
		hasControlCharacters(value) ||
		bytes(value) > maxBytes
	) {
		throw new PluginSecretBrokerError("INVALID_PARAMS", "INVALID_PARAMS", `${label} is invalid`);
	}
}

function assertSecretId(secretId: unknown): asserts secretId is string {
	assertText(secretId, "secretId", MAX_SECRET_ID_BYTES);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(secretId)) {
		throw new PluginSecretBrokerError(
			"INVALID_PARAMS",
			"INVALID_PARAMS",
			"secretId contains unsupported characters",
		);
	}
}

function assertPluginId(pluginId: unknown): asserts pluginId is string {
	if (!pluginPrincipalSchema.shape.pluginId.safeParse(pluginId).success) {
		throw new PluginSecretBrokerError("INVALID_PARAMS", "INVALID_PARAMS", "pluginId is invalid");
	}
}

function parseScope(scope: PluginSecretScopeInput): PluginSecretScope {
	if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
		throw new PluginSecretBrokerError(
			"INVALID_PARAMS",
			"INVALID_PARAMS",
			"Secret scope is invalid",
		);
	}
	const record = scope as Record<string, unknown>;
	const short = "type" in record;
	const allowed = short ? ["type", "id"] : ["scopeType", "scopeId"];
	if (Object.keys(record).some((key) => !allowed.includes(key))) {
		throw new PluginSecretBrokerError(
			"INVALID_PARAMS",
			"INVALID_PARAMS",
			"Secret scope has unknown fields",
		);
	}
	const type = (short ? record.type : record.scopeType) as unknown;
	const id = (short ? record.id : record.scopeId) as unknown;
	if (!(PLUGIN_SECRET_SCOPE_TYPES as readonly unknown[]).includes(type)) {
		throw new PluginSecretBrokerError(
			"INVALID_PARAMS",
			"INVALID_PARAMS",
			"Secret scope type is invalid",
		);
	}
	if (type === "global" && id !== undefined) {
		throw new PluginSecretBrokerError(
			"INVALID_PARAMS",
			"INVALID_PARAMS",
			"Global secret scope cannot have an id",
		);
	}
	if (type !== "global") {
		if (
			typeof id !== "string" ||
			id.length === 0 ||
			id !== id.trim() ||
			id.length > 128 ||
			hasControlCharacters(id)
		) {
			throw new PluginSecretBrokerError(
				"INVALID_PARAMS",
				"INVALID_PARAMS",
				"Secret scope id is invalid",
			);
		}
	}
	return type === "global"
		? { type: type as PluginSecretScopeType }
		: { type: type as PluginSecretScopeType, id: id as string };
}

function resolveScope(input: {
	scope?: PluginSecretScopeInput;
	scopeType?: PluginSecretScopeType;
	scopeId?: string;
}): PluginSecretScope {
	if (input.scope !== undefined) return parseScope(input.scope);
	if (input.scopeType === undefined)
		throw new PluginSecretBrokerError(
			"INVALID_PARAMS",
			"INVALID_PARAMS",
			"Secret scope is required",
		);
	return parseScope({ type: input.scopeType, id: input.scopeId });
}

function scopeKey(scope: PluginSecretScope): string {
	return `${scope.type}\u0000${scope.id ?? ""}`;
}

function scopeField(type: PluginSecretScopeType): keyof InvocationScope | undefined {
	const fields: Partial<Record<PluginSecretScopeType, keyof InvocationScope>> = {
		user: "userId",
		project: "projectId",
		workspace: "workspaceId",
		chapter: "chapterId",
		narrator: "narratorId",
		provider: "providerInstanceId",
		device: "deviceId",
	};
	return fields[type];
}

function hashOpaque(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function hashLease(value: string): string {
	return hashOpaque(value);
}

function cloneScope(scope: PluginSecretScope): PluginSecretScope {
	return scope.id === undefined ? { type: scope.type } : { type: scope.type, id: scope.id };
}

function sameScopeValue(left: PluginSecretScope, right: PluginSecretScope): boolean {
	return left.type === right.type && left.id === right.id;
}

function isBindingContext(value: unknown): value is HostCallContext {
	return hostCallContextSchema.safeParse(value).success;
}

export class PluginSecretBroker {
	private readonly provider?: SecretProvider;
	private readonly authorize?: SecretAuthorization;
	private readonly isPluginEnabled?: PluginSecretBrokerOptions["isPluginEnabled"];
	private readonly now: () => Date;
	private readonly defaultLeaseTtlMs: number;
	private readonly maxLeaseTtlMs: number;
	private readonly maxAuditEntries: number;
	private readonly auditSink?: SecretAuditSink;
	private readonly configurations = new Map<string, SecretConfiguration>();
	private readonly leases = new Map<string, LeaseRecord>();
	private readonly revokedPlugins = new Set<string>();
	private readonly revokedLeases = new Set<string>();
	private readonly auditEntries: SecretAuditSummary[] = [];

	constructor(options: PluginSecretBrokerOptions = {}) {
		this.provider = options.provider;
		this.authorize = options.authorize ?? options.validateAccess;
		this.isPluginEnabled = options.isPluginEnabled;
		this.now = options.now ?? (() => new Date());
		this.defaultLeaseTtlMs = this.positiveInteger(
			options.defaultLeaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
			"defaultLeaseTtlMs",
		);
		this.maxLeaseTtlMs = this.positiveInteger(
			options.maxLeaseTtlMs ?? DEFAULT_MAX_LEASE_TTL_MS,
			"maxLeaseTtlMs",
		);
		if (this.defaultLeaseTtlMs > this.maxLeaseTtlMs)
			throw new ValidationError("Secret lease default exceeds maximum");
		this.maxAuditEntries = Math.min(
			MAX_AUDIT_ENTRIES,
			this.positiveInteger(options.maxAuditEntries ?? MAX_AUDIT_ENTRIES, "maxAuditEntries"),
		);
		this.auditSink = options.auditSink;
	}

	configure(input: SecretConfigurationInput): SecretConfigurationSummary {
		if (
			!this.isPlainRecord(input) ||
			Object.keys(input).some(
				(key) => !["pluginId", "secretId", "scope", "opaqueRef", "fingerprint"].includes(key),
			)
		) {
			throw new PluginSecretBrokerError(
				"INVALID_PARAMS",
				"INVALID_PARAMS",
				"Secret configuration has unknown fields",
			);
		}
		assertPluginId(input.pluginId);
		assertSecretId(input.secretId);
		const scope = parseScope(input.scope);
		assertText(input.opaqueRef, "opaqueRef", MAX_OPAQUE_REF_BYTES);
		if (input.fingerprint !== undefined)
			assertText(input.fingerprint, "fingerprint", MAX_FINGERPRINT_BYTES);
		const key = this.configurationKey(input.pluginId, input.secretId, scope);
		const previous = this.configurations.get(key);
		const configuration: SecretConfiguration = {
			pluginId: input.pluginId,
			secretId: input.secretId,
			scope,
			opaqueRef: input.opaqueRef,
			fingerprint: input.fingerprint,
			revision: (previous?.revision ?? 0) + 1,
		};
		if (previous) {
			for (const [leaseId, lease] of this.leases) {
				if (
					lease.pluginId !== input.pluginId ||
					lease.secretId !== input.secretId ||
					!sameScopeValue(lease.scope, scope)
				)
					continue;
				this.leases.delete(leaseId);
				this.revokedLeases.add(leaseId);
				this.audit({
					operation: "revoke",
					pluginId: lease.pluginId,
					secretId: lease.secretId,
					runtimeId: lease.runtimeId,
					runtimeGeneration: lease.runtimeGeneration,
					requestId: lease.requestId,
					correlationId: lease.correlationId,
					scope: lease.scope,
					outcome: "revoked",
					reason: "CONFIGURATION_CHANGED",
					leaseHash: hashLease(lease.leaseId),
				});
			}
		}
		this.configurations.set(key, configuration);
		this.audit({
			operation: "configure",
			pluginId: input.pluginId,
			secretId: input.secretId,
			scope,
			outcome: "succeeded",
			fingerprintPresent: input.fingerprint !== undefined,
			opaqueRefHash: hashOpaque(input.opaqueRef),
		});
		return {
			pluginId: input.pluginId,
			secretId: input.secretId,
			scope: cloneScope(scope),
			configured: true,
			fingerprint: input.fingerprint,
			revision: configuration.revision,
		};
	}

	getConfiguration(input: {
		pluginId: string;
		secretId: string;
		scope: PluginSecretScopeInput;
	}): SecretConfigurationSummary | undefined {
		assertPluginId(input.pluginId);
		assertSecretId(input.secretId);
		const scope = parseScope(input.scope);
		const configuration = this.configurations.get(
			this.configurationKey(input.pluginId, input.secretId, scope),
		);
		if (!configuration) return undefined;
		return {
			pluginId: configuration.pluginId,
			secretId: configuration.secretId,
			scope: cloneScope(configuration.scope),
			configured: true,
			fingerprint: configuration.fingerprint,
			revision: configuration.revision,
		};
	}

	async acquireLease(input: SecretAcquireInput): Promise<SecretLease> {
		assertSecretId(input.secretId);
		const binding = this.normalizeBinding(input);
		const configuredScope =
			input.scope === undefined ? undefined : resolveScope({ scope: input.scope });
		const configuration = this.findConfiguration(
			binding.plugin.pluginId,
			input.secretId,
			configuredScope,
		);
		if (!configuration) {
			this.auditDenied(
				binding,
				"acquire",
				input.secretId,
				configuredScope,
				"SECRET_NOT_CONFIGURED",
			);
			throw this.error(
				"NOT_FOUND_OR_DENIED",
				"SECRET_NOT_CONFIGURED",
				"Secret is not configured",
				404,
			);
		}
		if (this.revokedPlugins.has(binding.plugin.pluginId)) {
			this.auditDenied(binding, "acquire", input.secretId, configuration.scope, "PLUGIN_DISABLED");
			throw this.error("PLUGIN_DISABLED", "PLUGIN_DISABLED", "Plugin is disabled", 409);
		}
		await this.assertPluginEnabled(binding, "acquire", input.secretId, configuration.scope);
		this.assertDeadline(binding);
		this.assertScopeBinding(binding, configuration.scope);
		await this.assertAuthorized(binding, "acquire", input.secretId, configuration.scope);
		await this.assertProviderAvailable(binding, input.secretId, configuration.scope);
		const requestedTtl = input.ttlMs ?? this.defaultLeaseTtlMs;
		if (
			!Number.isSafeInteger(requestedTtl) ||
			requestedTtl <= 0 ||
			requestedTtl > this.maxLeaseTtlMs
		) {
			throw this.error("INVALID_PARAMS", "INVALID_PARAMS", "Secret lease ttl is invalid", 400);
		}
		const expiresAtMs = Math.min(
			this.now().getTime() + requestedTtl,
			Date.parse(binding.deadlineAt),
		);
		if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now().getTime()) {
			this.auditDenied(binding, "acquire", input.secretId, configuration.scope, "DEADLINE_EXPIRED");
			throw this.error("TIMEOUT", "DEADLINE_EXPIRED", "Secret request deadline has expired", 408);
		}
		this.expireLeases();
		const lease: LeaseRecord = {
			leaseId: `secret_lease_${generateShortId(20)}`,
			pluginId: binding.plugin.pluginId,
			secretId: input.secretId,
			scope: cloneScope(configuration.scope),
			runtimeId: binding.plugin.runtimeId,
			runtimeGeneration: binding.plugin.runtimeGeneration,
			requestId: binding.requestId,
			expiresAt: new Date(expiresAtMs).toISOString(),
			fingerprint: configuration.fingerprint,
			correlationId: binding.correlationId,
			purpose: input.purpose,
			configurationRevision: configuration.revision,
			opaqueRef: configuration.opaqueRef,
		};
		this.leases.set(lease.leaseId, lease);
		this.audit({
			operation: "acquire",
			pluginId: binding.plugin.pluginId,
			secretId: input.secretId,
			runtimeId: binding.plugin.runtimeId,
			runtimeGeneration: binding.plugin.runtimeGeneration,
			requestId: binding.requestId,
			correlationId: binding.correlationId,
			scope: configuration.scope,
			outcome: "succeeded",
			fingerprintPresent: configuration.fingerprint !== undefined,
			leaseHash: hashLease(lease.leaseId),
		});
		return this.publicLease(lease);
	}

	async readLease(input: SecretReadLeaseInput): Promise<SecretProviderValue> {
		assertText(input.leaseId, "leaseId", 128);
		const lease = this.leases.get(input.leaseId);
		const binding = this.normalizeBinding(input);
		if (!lease || this.revokedLeases.has(input.leaseId)) {
			this.auditDenied(binding, "read", lease?.secretId, lease?.scope, "LEASE_REVOKED");
			throw this.error("PERMISSION_DENIED", "LEASE_REVOKED", "Secret lease is revoked or unknown");
		}
		if (Date.parse(lease.expiresAt) <= this.now().getTime()) {
			this.leases.delete(input.leaseId);
			this.auditDenied(binding, "read", lease.secretId, lease.scope, "LEASE_EXPIRED", "expired");
			throw this.error("TIMEOUT", "LEASE_EXPIRED", "Secret lease has expired", 408);
		}
		if (lease.pluginId !== binding.plugin.pluginId) {
			this.auditDenied(binding, "read", lease.secretId, lease.scope, "PLUGIN_IDENTITY_MISMATCH");
			throw this.error(
				"PERMISSION_DENIED",
				"PLUGIN_IDENTITY_MISMATCH",
				"Secret lease belongs to another plugin",
			);
		}
		if (lease.runtimeId !== binding.plugin.runtimeId) {
			this.auditDenied(binding, "read", lease.secretId, lease.scope, "RUNTIME_IDENTITY_MISMATCH");
			throw this.error(
				"PERMISSION_DENIED",
				"RUNTIME_IDENTITY_MISMATCH",
				"Secret lease runtime does not match",
			);
		}
		if (lease.runtimeGeneration !== binding.plugin.runtimeGeneration) {
			this.auditDenied(binding, "read", lease.secretId, lease.scope, "RUNTIME_GENERATION_MISMATCH");
			throw this.error(
				"PERMISSION_DENIED",
				"RUNTIME_GENERATION_MISMATCH",
				"Secret lease generation does not match",
			);
		}
		if (lease.requestId !== binding.requestId) {
			this.auditDenied(binding, "read", lease.secretId, lease.scope, "REQUEST_MISMATCH");
			throw this.error(
				"PERMISSION_DENIED",
				"REQUEST_MISMATCH",
				"Secret lease request does not match",
			);
		}
		this.assertDeadline(binding);
		this.assertScopeBinding(binding, lease.scope);
		const configuration = this.configurations.get(
			this.configurationKey(lease.pluginId, lease.secretId, lease.scope),
		);
		if (!configuration || configuration.revision !== lease.configurationRevision) {
			this.auditDenied(binding, "read", lease.secretId, lease.scope, "LEASE_REVOKED");
			throw this.error("PERMISSION_DENIED", "LEASE_REVOKED", "Secret configuration changed");
		}
		if (this.revokedPlugins.has(binding.plugin.pluginId)) {
			this.auditDenied(binding, "read", lease.secretId, lease.scope, "PLUGIN_DISABLED");
			throw this.error("PLUGIN_DISABLED", "PLUGIN_DISABLED", "Plugin is disabled", 409);
		}
		await this.assertPluginEnabled(binding, "read", lease.secretId, lease.scope);
		await this.assertAuthorized(binding, "read", lease.secretId, lease.scope);
		await this.assertProviderAvailable(binding, lease.secretId, lease.scope);
		const providerRead = this.provider?.read ?? this.provider?.resolve;
		if (!providerRead) {
			this.auditDenied(
				binding,
				"read",
				lease.secretId,
				lease.scope,
				"PROVIDER_UNAVAILABLE",
				"failed",
			);
			throw this.error(
				"HOST_UNAVAILABLE",
				"PROVIDER_UNAVAILABLE",
				"Secret provider is unavailable",
				503,
			);
		}
		let secret: SecretProviderValue | undefined;
		try {
			secret = await providerRead({
				pluginId: lease.pluginId,
				secretId: lease.secretId,
				scope: cloneScope(lease.scope),
				opaqueRef: lease.opaqueRef,
				requestId: lease.requestId,
				runtimeId: lease.runtimeId,
				runtimeGeneration: lease.runtimeGeneration,
				deadlineAt: lease.expiresAt,
				purpose: lease.purpose,
			});
		} catch {
			this.auditDenied(binding, "read", lease.secretId, lease.scope, "PROVIDER_ERROR", "failed");
			throw this.error("HOST_UNAVAILABLE", "PROVIDER_ERROR", "Secret provider failed", 503);
		}
		if (secret === undefined || !(typeof secret === "string" || secret instanceof Uint8Array)) {
			this.auditDenied(binding, "read", lease.secretId, lease.scope, "PROVIDER_ERROR", "failed");
			throw this.error(
				"HOST_UNAVAILABLE",
				"PROVIDER_ERROR",
				"Secret provider returned no secret",
				503,
			);
		}
		this.audit({
			operation: "read",
			pluginId: binding.plugin.pluginId,
			secretId: lease.secretId,
			runtimeId: binding.plugin.runtimeId,
			runtimeGeneration: binding.plugin.runtimeGeneration,
			requestId: binding.requestId,
			correlationId: binding.correlationId,
			scope: lease.scope,
			outcome: "succeeded",
			fingerprintPresent: configuration.fingerprint !== undefined,
			leaseHash: hashLease(lease.leaseId),
		});
		return typeof secret === "string" ? secret : new Uint8Array(secret);
	}

	revokeLease(leaseId: string): boolean {
		assertText(leaseId, "leaseId", 128);
		const lease = this.leases.get(leaseId);
		if (!lease) return false;
		this.revokedLeases.add(leaseId);
		this.leases.delete(leaseId);
		this.audit({
			operation: "revoke",
			pluginId: lease.pluginId,
			secretId: lease.secretId,
			runtimeId: lease.runtimeId,
			runtimeGeneration: lease.runtimeGeneration,
			requestId: lease.requestId,
			correlationId: lease.correlationId,
			scope: lease.scope,
			outcome: "revoked",
			leaseHash: hashLease(lease.leaseId),
		});
		return true;
	}

	revokePlugin(pluginId: string): number {
		assertPluginId(pluginId);
		this.revokedPlugins.add(pluginId);
		let count = 0;
		for (const [leaseId, lease] of this.leases) {
			if (lease.pluginId !== pluginId) continue;
			this.revokedLeases.add(leaseId);
			this.leases.delete(leaseId);
			count += 1;
		}
		return count;
	}

	restorePlugin(pluginId: string): void {
		assertPluginId(pluginId);
		this.revokedPlugins.delete(pluginId);
	}

	getAuditSummaries(): SecretAuditSummary[] {
		return clone(this.auditEntries);
	}

	private publicLease(lease: LeaseRecord): SecretLease {
		return {
			leaseId: lease.leaseId,
			pluginId: lease.pluginId,
			secretId: lease.secretId,
			scope: cloneScope(lease.scope),
			runtimeId: lease.runtimeId,
			runtimeGeneration: lease.runtimeGeneration,
			requestId: lease.requestId,
			expiresAt: lease.expiresAt,
			fingerprint: lease.fingerprint,
		};
	}

	private normalizeBinding(input: {
		context?: HostCallContext;
		plugin?: PluginPrincipal;
		runtimeId?: string;
		runtimeGeneration?: number;
		requestId?: string;
		correlationId?: string;
		deadlineAt?: string;
		invocationScope?: InvocationScope;
	}): RequestBinding {
		if (input.context !== undefined) {
			if (!isBindingContext(input.context))
				throw this.error("CONTEXT_UNAVAILABLE", "INVALID_PARAMS", "Secret call context is invalid");
			if (input.plugin && !this.samePrincipal(input.context.plugin, input.plugin)) {
				throw this.error(
					"CONTEXT_UNAVAILABLE",
					"PLUGIN_IDENTITY_MISMATCH",
					"Secret plugin identity mismatch",
				);
			}
			if (input.runtimeId !== undefined && input.runtimeId !== input.context.plugin.runtimeId) {
				throw this.error(
					"CONTEXT_UNAVAILABLE",
					"RUNTIME_IDENTITY_MISMATCH",
					"Secret runtime identity mismatch",
				);
			}
			if (
				input.runtimeGeneration !== undefined &&
				input.runtimeGeneration !== input.context.plugin.runtimeGeneration
			) {
				throw this.error(
					"CONTEXT_UNAVAILABLE",
					"RUNTIME_GENERATION_MISMATCH",
					"Secret runtime generation mismatch",
				);
			}
			if (input.requestId !== undefined && input.requestId !== input.context.requestId) {
				throw this.error(
					"CONTEXT_UNAVAILABLE",
					"REQUEST_MISMATCH",
					"Secret request identity mismatch",
				);
			}
			return {
				context: input.context,
				plugin: input.context.plugin,
				requestId: input.context.requestId,
				correlationId: input.context.correlationId,
				deadlineAt: input.context.deadlineAt,
				scope: input.context.scope,
			};
		}
		if (!input.plugin || !pluginPrincipalSchema.safeParse(input.plugin).success) {
			throw this.error(
				"CONTEXT_UNAVAILABLE",
				"INVALID_PARAMS",
				"Secret plugin context is required",
			);
		}
		const requestId = input.requestId ?? `secret_req_${generateShortId(16)}`;
		const correlationId = input.correlationId ?? `secret_corr_${generateShortId(16)}`;
		const deadlineAt =
			input.deadlineAt ?? new Date(this.now().getTime() + this.defaultLeaseTtlMs).toISOString();
		assertText(requestId, "requestId", 128);
		assertText(correlationId, "correlationId", 128);
		assertText(deadlineAt, "deadlineAt", 64);
		if (!Number.isFinite(Date.parse(deadlineAt)))
			throw this.error("INVALID_PARAMS", "INVALID_PARAMS", "Secret deadline is invalid");
		const context = {
			requestId,
			correlationId,
			deadlineAt,
			plugin: input.plugin,
			invocation: { kind: "plugin_background" as const, source: "internal" as const },
			scope: input.invocationScope ?? {},
		};
		const parsed = hostCallContextSchema.safeParse(context);
		if (!parsed.success)
			throw this.error("CONTEXT_UNAVAILABLE", "INVALID_PARAMS", "Secret plugin context is invalid");
		if (input.runtimeId !== undefined && input.runtimeId !== parsed.data.plugin.runtimeId) {
			throw this.error(
				"CONTEXT_UNAVAILABLE",
				"RUNTIME_IDENTITY_MISMATCH",
				"Secret runtime identity mismatch",
			);
		}
		if (
			input.runtimeGeneration !== undefined &&
			input.runtimeGeneration !== parsed.data.plugin.runtimeGeneration
		) {
			throw this.error(
				"CONTEXT_UNAVAILABLE",
				"RUNTIME_GENERATION_MISMATCH",
				"Secret runtime generation mismatch",
			);
		}
		return {
			context: parsed.data,
			plugin: parsed.data.plugin,
			requestId,
			correlationId,
			deadlineAt,
			scope: parsed.data.scope,
		};
	}

	private samePrincipal(left: PluginPrincipal, right: PluginPrincipal): boolean {
		return (
			left.pluginId === right.pluginId &&
			left.packageVersion === right.packageVersion &&
			left.runtimeId === right.runtimeId &&
			left.runtimeGeneration === right.runtimeGeneration &&
			left.installationId === right.installationId &&
			left.contributionId === right.contributionId
		);
	}

	private assertScopeBinding(binding: RequestBinding, scope: PluginSecretScope): void {
		const field = scopeField(scope.type);
		if (
			field !== undefined &&
			binding.scope[field] !== undefined &&
			binding.scope[field] !== scope.id
		) {
			throw this.error(
				"PERMISSION_DENIED",
				"SCOPE_MISMATCH",
				"Secret scope is outside the invocation scope",
			);
		}
	}

	private async assertPluginEnabled(
		binding: RequestBinding,
		operation: "acquire" | "read",
		secretId: string,
		scope: PluginSecretScope,
	): Promise<void> {
		if (this.isPluginEnabled) {
			let enabled = false;
			try {
				enabled = await this.isPluginEnabled(binding.plugin.pluginId);
			} catch {
				enabled = false;
			}
			if (!enabled) {
				this.auditDenied(binding, operation, secretId, scope, "PLUGIN_DISABLED");
				throw this.error("PLUGIN_DISABLED", "PLUGIN_DISABLED", "Plugin is disabled", 409);
			}
		}
	}

	private async assertAuthorized(
		binding: RequestBinding,
		method: "acquire" | "read",
		secretId: string,
		scope: PluginSecretScope,
	): Promise<void> {
		if (!this.authorize) {
			this.auditDenied(binding, method, secretId, scope, "PERMISSION_DENIED");
			throw this.error(
				"PERMISSION_DENIED",
				"PERMISSION_DENIED",
				"Secret capability is not granted",
			);
		}
		let result: SecretAuthorizationResult;
		try {
			result = await this.authorize({
				pluginId: binding.plugin.pluginId,
				secretId,
				capability: "secret.use_self",
				method,
				context: binding.context,
				scope: cloneScope(scope),
			});
		} catch {
			this.auditDenied(binding, method, secretId, scope, "PERMISSION_DENIED");
			throw this.error(
				"PERMISSION_DENIED",
				"PERMISSION_DENIED",
				"Secret capability validation failed",
			);
		}
		const allowed = typeof result === "boolean" ? result : result.allowed;
		if (!allowed) {
			const reason =
				typeof result === "boolean" ? "PERMISSION_DENIED" : (result.reason ?? "PERMISSION_DENIED");
			this.auditDenied(binding, method, secretId, scope, reason);
			throw this.error(
				"PERMISSION_DENIED",
				"PERMISSION_DENIED",
				"Secret capability is not granted",
			);
		}
	}

	private async assertProviderAvailable(
		binding: RequestBinding,
		secretId: string,
		scope: PluginSecretScope,
	): Promise<void> {
		const providerRead = this.provider?.read ?? this.provider?.resolve;
		if (!this.provider || !providerRead) {
			this.auditDenied(binding, "read", secretId, scope, "PROVIDER_UNAVAILABLE");
			throw this.error(
				"HOST_UNAVAILABLE",
				"PROVIDER_UNAVAILABLE",
				"Secret provider is unavailable",
				503,
			);
		}
		if (!this.provider.isAvailable) return;
		try {
			if (!(await this.provider.isAvailable())) {
				this.auditDenied(binding, "read", secretId, scope, "PROVIDER_UNAVAILABLE");
				throw this.error(
					"HOST_UNAVAILABLE",
					"PROVIDER_UNAVAILABLE",
					"Secret provider is unavailable",
					503,
				);
			}
		} catch (error) {
			if (error instanceof PluginSecretBrokerError) throw error;
			this.auditDenied(binding, "read", secretId, scope, "PROVIDER_UNAVAILABLE");
			throw this.error(
				"HOST_UNAVAILABLE",
				"PROVIDER_UNAVAILABLE",
				"Secret provider is unavailable",
				503,
			);
		}
	}

	private assertDeadline(binding: RequestBinding): void {
		if (
			!Number.isFinite(Date.parse(binding.deadlineAt)) ||
			Date.parse(binding.deadlineAt) <= this.now().getTime()
		) {
			this.auditDenied(binding, "acquire", undefined, undefined, "DEADLINE_EXPIRED");
			throw this.error("TIMEOUT", "DEADLINE_EXPIRED", "Secret request deadline has expired", 408);
		}
	}

	private findConfiguration(
		pluginId: string,
		secretId: string,
		requestedScope?: PluginSecretScope,
	): SecretConfiguration | undefined {
		if (requestedScope)
			return this.configurations.get(this.configurationKey(pluginId, secretId, requestedScope));
		const candidates = [...this.configurations.values()].filter(
			(configuration) => configuration.pluginId === pluginId && configuration.secretId === secretId,
		);
		return candidates.length === 1
			? candidates[0]
			: candidates.find((candidate) => candidate.scope.type === "global");
	}

	private configurationKey(pluginId: string, secretId: string, scope: PluginSecretScope): string {
		return `${pluginId}\u0000${secretId}\u0000${scopeKey(scope)}`;
	}

	private expireLeases(): void {
		const now = this.now().getTime();
		for (const [leaseId, lease] of this.leases) {
			if (Date.parse(lease.expiresAt) <= now) {
				this.leases.delete(leaseId);
				this.revokedLeases.add(leaseId);
			}
		}
	}

	private audit(
		summary: Omit<SecretAuditSummary, "timestamp" | "scopeType" | "scopeId"> & {
			scope?: PluginSecretScope;
		},
	): void {
		const { scope, ...safeSummary } = summary;
		const entry: SecretAuditSummary = {
			timestamp: this.now().toISOString(),
			...safeSummary,
			scopeType: scope?.type,
			scopeId: scope?.id,
		};
		this.auditEntries.push(clone(entry));
		if (this.auditEntries.length > this.maxAuditEntries)
			this.auditEntries.splice(0, this.auditEntries.length - this.maxAuditEntries);
		if (this.auditSink) {
			try {
				void Promise.resolve(this.auditSink(clone(entry))).catch(() => undefined);
			} catch {
				// Audit sinks are observational and must not expose secret material or change the result.
			}
		}
	}

	private auditDenied(
		binding: RequestBinding,
		operation: "acquire" | "read",
		secretId?: string,
		scope?: PluginSecretScope,
		reason = "PERMISSION_DENIED",
		outcome: SecretAuditSummary["outcome"] = "denied",
	): void {
		this.audit({
			operation,
			pluginId: binding.plugin.pluginId,
			secretId,
			runtimeId: binding.plugin.runtimeId,
			runtimeGeneration: binding.plugin.runtimeGeneration,
			requestId: binding.requestId,
			correlationId: binding.correlationId,
			scope,
			outcome,
			reason,
		});
	}

	private error(
		code: string,
		reason: PluginSecretBrokerErrorReason,
		message: string,
		statusCode = 403,
	): PluginSecretBrokerError {
		return new PluginSecretBrokerError(code, reason, message, statusCode);
	}

	private positiveInteger(value: number, name: string): number {
		if (!Number.isSafeInteger(value) || value <= 0)
			throw new ValidationError(`Secret broker ${name} must be a positive integer`);
		return value;
	}

	private isPlainRecord(value: unknown): value is Record<string, unknown> {
		return (
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
		);
	}
}
