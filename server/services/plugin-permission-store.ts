import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { AsyncMutex } from "@server/lib/async-mutex";
import { AppError, ValidationError } from "@server/lib/errors";
import { generateShortId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import { getNarraforkPath } from "@server/lib/narrafork-home";
import { pluginIdSchema } from "@server/lib/plugins/manifest";
import {
	capabilitySchema,
	type PermissionGrant,
	type PermissionScope,
	permissionGrantSchema,
	permissionScopeSchema,
} from "@server/lib/plugins/permissions";
import { z } from "zod";
import type {
	PluginGrantSummary,
	PluginGrantSummaryUpdate,
	PluginStateStore,
} from "./plugin-state-store";

const PERMISSION_FILE_VERSION = 1;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_GRANTS_PER_INSTALLATION = 512;
const DEFAULT_MAX_INSTALLATIONS_PER_PLUGIN = 32;
const DEFAULT_MAX_PENDING_REQUESTS = 20;
const DEFAULT_MAX_JSON_DEPTH = 16;
const DEFAULT_MAX_ARRAY_LENGTH = 2_048;
const DEFAULT_MAX_OBJECT_KEYS = 8_192;
const DEFAULT_MAX_STRING_BYTES = 16 * 1024;
const DEFAULT_MAX_DIAGNOSTICS = 32;
const DEFAULT_ACTOR = "admin";
/**
 * Decided requests are kept only as recent history. The loader rejects an
 * installation with more rows than maxGrantsPerInstallation (512), and a
 * rejected file is reset as corrupt — wiping grants and permanent denials — so
 * the history must never be allowed to grow toward that bound.
 */
const MAX_RESOLVED_REQUEST_HISTORY = 100;

/** Keep every pending row plus the most recent decided rows, preserving order. */
function trimResolvedRequests(requests: PluginPermissionRequest[]): PluginPermissionRequest[] {
	let resolvedToDrop =
		requests.filter((r) => r.status !== "pending").length - MAX_RESOLVED_REQUEST_HISTORY;
	if (resolvedToDrop <= 0) return requests;
	return requests.filter((r) => {
		if (r.status === "pending" || resolvedToDrop <= 0) return true;
		resolvedToDrop--;
		return false;
	});
}

const identifierSchema = z
	.string()
	.trim()
	.min(1)
	.max(256)
	.refine((value) => !/[\0\r\n]/u.test(value), "identifier contains control characters");
const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export type PermissionGrantInput = Omit<PermissionGrant, "grantId" | "grantedBy"> &
	Partial<Pick<PermissionGrant, "grantId" | "grantedBy">>;

/** Host-owned durable representation. The grant payload is kept compatible with the C0 broker. */
export interface StoredPermissionGrant extends PermissionGrant {
	grantId: string;
	grantedBy: string;
	pluginId: string;
	installationId: string;
	revision: number;
}

export interface PluginPermissionSet {
	pluginId: string;
	installationId: string;
	revision: number;
	grants: StoredPermissionGrant[];
	updatedAt: string;
}

export interface PluginPermissionStoreSnapshot {
	sets: PluginPermissionSet[];
	diagnostics: PluginPermissionDiagnostic[];
}

export interface PluginPermissionDiagnostic {
	code: string;
	message: string;
	path: string;
	detectedAt: string;
	recoveryPath?: string;
}

export interface PluginPermissionStoreLimits {
	maxFileBytes: number;
	maxGrantsPerInstallation: number;
	maxInstallationsPerPlugin: number;
	maxJsonDepth: number;
	maxArrayLength: number;
	maxObjectKeys: number;
	maxStringBytes: number;
	maxDiagnostics: number;
}

export interface PluginPermissionStoreOptions {
	root?: string;
	fileName?: string;
	stateStore?: PluginStateStore;
	limits?: Partial<PluginPermissionStoreLimits>;
	defaultGrantedBy?: string;
	now?: () => Date;
	/** Injectable only for atomic-write failure tests. */
	renameFile?: (from: string, to: string) => Promise<void>;
}

export interface PermissionReplaceOptions {
	expectedRevision?: number;
	/** Internal migration/compatibility escape hatch; HTTP callers must not use it. */
	targetRevision?: number;
	grantedBy?: string;
}

export interface PermissionMutationResult {
	set: PluginPermissionSet;
	changed: boolean;
	idempotent: boolean;
}

export class PluginPermissionConflictError extends AppError {
	readonly expectedRevision?: number;
	readonly actualRevision: number;

	constructor(pluginId: string, expectedRevision: number | undefined, actualRevision: number) {
		super(
			`Plugin permission revision conflict for ${pluginId}: expected ${expectedRevision ?? "none"}, current ${actualRevision}`,
			409,
			"PERMISSION_REVISION_CONFLICT",
		);
		this.name = "PluginPermissionConflictError";
		this.expectedRevision = expectedRevision;
		this.actualRevision = actualRevision;
	}
}

export class PluginPermissionNotFoundError extends AppError {
	constructor(grantId: string) {
		super(`Plugin permission grant was not found: ${grantId}`, 404, "PERMISSION_GRANT_NOT_FOUND");
		this.name = "PluginPermissionNotFoundError";
	}
}

interface PermissionInstallationDocument {
	pluginId: string;
	installationId: string;
	revision: number;
	grants: StoredPermissionGrant[];
	/** Runtime permission prompts awaiting user resolution (capability not yet granted). */
	pendingRequests: PluginPermissionRequest[];
	/** "Deny and never ask again" records; matched requests are never queued. */
	permanentDenials: PluginPermanentDenial[];
	updatedAt: string;
}

/**
 * Why a capability is awaiting approval.
 *
 * - `runtime`: the plugin called a capability it holds no grant for, and the broker
 *   turned the denial into a prompt.
 * - `upgrade`: a new package version *declares* a capability the previous version was
 *   never granted. Nobody called it yet; the request exists so the upgrade cannot widen
 *   the allow set on its own.
 *
 * The distinction is not cosmetic: an upgrade request must be presented as "this update
 * wants more access than you approved before", which is a different decision from
 * "a running plugin just tried something new".
 */
export type PluginPermissionRequestSource = "runtime" | "upgrade";

/** A capability grant request awaiting admin resolution. */
export interface PluginPermissionRequest {
	requestId: string;
	capability: string;
	scope: PermissionScope;
	requestedAt: string;
	requestedByRuntimeId?: string;
	/**
	 * Absent in records written before the field existed; those are all runtime prompts,
	 * so readers must treat a missing value as `"runtime"` rather than rejecting the row.
	 */
	source?: PluginPermissionRequestSource;
	/** Package version that introduced the declaration. Only meaningful for `upgrade`. */
	requestedForVersion?: string;
	status: "pending" | "granted" | "denied";
	resolvedAt?: string;
}

/**
 * A "deny permanently, never ask again" decision for a (capability, scope) pair.
 *
 * Unlike a plain denial — which resolves only the one pending row and lets the
 * plugin re-ask on its next call — a permanent denial makes `addPendingRequest`
 * refuse to queue the pair at all, so neither the grant panel nor the global
 * prompt is raised again. It is NOT a grant revocation: existing grants keep
 * working. Removable by an admin when the decision should be revisited.
 */
export interface PluginPermanentDenial {
	capability: string;
	scope: PermissionScope;
	deniedAt: string;
	deniedBy?: string;
}

/** Identity key shared by pending-request dedupe and permanent-denial matching. */
function permissionPairKey(capability: string, scope: PermissionScope): string {
	return `${capability}${JSON.stringify(scope)}`;
}

interface PermissionFileDocument {
	version: number;
	plugins: Record<string, Record<string, PermissionInstallationDocument>>;
	diagnostics: PluginPermissionDiagnostic[];
	updatedAt: string;
}

function createLimits(
	overrides?: Partial<PluginPermissionStoreLimits>,
): PluginPermissionStoreLimits {
	const limits = {
		maxFileBytes: overrides?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
		maxGrantsPerInstallation:
			overrides?.maxGrantsPerInstallation ?? DEFAULT_MAX_GRANTS_PER_INSTALLATION,
		maxInstallationsPerPlugin:
			overrides?.maxInstallationsPerPlugin ?? DEFAULT_MAX_INSTALLATIONS_PER_PLUGIN,
		maxJsonDepth: overrides?.maxJsonDepth ?? DEFAULT_MAX_JSON_DEPTH,
		maxArrayLength: overrides?.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH,
		maxObjectKeys: overrides?.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS,
		maxStringBytes: overrides?.maxStringBytes ?? DEFAULT_MAX_STRING_BYTES,
		maxDiagnostics: overrides?.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS,
	};
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new ValidationError(`Plugin permission limit ${name} must be a positive integer`);
		}
	}
	return limits;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function assertJsonLimits(value: unknown, limits: PluginPermissionStoreLimits): void {
	let objectKeys = 0;
	const seen = new WeakSet<object>();
	const visit = (current: unknown, depth: number): void => {
		if (depth > limits.maxJsonDepth)
			throw new ValidationError("Plugin permissions exceed JSON depth");
		if (typeof current === "string") {
			if (Buffer.byteLength(current, "utf8") > limits.maxStringBytes) {
				throw new ValidationError("Plugin permissions contain an oversized string");
			}
			return;
		}
		if (
			current === null ||
			current === undefined ||
			typeof current === "boolean" ||
			(typeof current === "number" && Number.isFinite(current))
		) {
			return;
		}
		if (typeof current !== "object" || seen.has(current)) {
			if (typeof current === "object" && current !== null) {
				throw new ValidationError("Plugin permissions contain a cyclic value");
			}
			throw new ValidationError("Plugin permissions are not JSON-safe");
		}
		seen.add(current);
		if (Array.isArray(current)) {
			if (current.length > limits.maxArrayLength) {
				throw new ValidationError("Plugin permissions contain an oversized array");
			}
			for (const item of current) visit(item, depth + 1);
			return;
		}
		const entries = Object.entries(current);
		objectKeys += entries.length;
		if (objectKeys > limits.maxObjectKeys) {
			throw new ValidationError("Plugin permissions contain too many object keys");
		}
		for (const [key, item] of entries) {
			if (["__proto__", "prototype", "constructor"].includes(key)) {
				throw new ValidationError("Plugin permissions contain a forbidden object key");
			}
			visit(item, depth + 1);
		}
	};
	visit(value, 0);
}

function assertPluginIdentity(pluginId: string, installationId: string): void {
	if (!pluginIdSchema.safeParse(pluginId).success) throw new ValidationError("Invalid pluginId");
	if (!identifierSchema.safeParse(installationId).success) {
		throw new ValidationError("Invalid plugin installationId");
	}
}

function baseGrant(grant: StoredPermissionGrant | PermissionGrantInput): PermissionGrantInput {
	return {
		capability: grant.capability,
		scope: clone(grant.scope),
		...(grant.constraints === undefined ? {} : { constraints: clone(grant.constraints) }),
		...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
		...(grant.grantId === undefined ? {} : { grantId: grant.grantId }),
		...(grant.grantedBy === undefined ? {} : { grantedBy: grant.grantedBy }),
	};
}

function grantFingerprint(grant: PermissionGrantInput): string {
	return JSON.stringify({
		capability: grant.capability,
		scope: grant.scope,
		constraints: grant.constraints ?? null,
		expiresAt: grant.expiresAt ?? null,
		grantId: grant.grantId ?? null,
		grantedBy: grant.grantedBy ?? null,
	});
}

function grantsFingerprint(grants: readonly PermissionGrantInput[]): string {
	return JSON.stringify(grants.map((grant) => grantFingerprint(grant)).sort());
}

function parseStoredGrant(
	value: unknown,
	pluginId: string,
	installationId: string,
	limits: PluginPermissionStoreLimits,
): StoredPermissionGrant {
	if (!isRecord(value)) throw new ValidationError("Stored plugin permission grant is invalid");
	const parsed = permissionGrantSchema.safeParse({
		capability: value.capability,
		scope: value.scope,
		constraints: value.constraints,
		expiresAt: value.expiresAt,
		grantId: value.grantId,
		grantedBy: value.grantedBy,
	});
	if (!parsed.success) throw new ValidationError("Stored plugin permission grant is invalid");
	if (typeof value.pluginId !== "string" || value.pluginId !== pluginId) {
		throw new ValidationError("Stored plugin permission pluginId is invalid");
	}
	if (typeof value.installationId !== "string" || value.installationId !== installationId) {
		throw new ValidationError("Stored plugin permission installationId is invalid");
	}
	const parsedRevision = revisionSchema.safeParse(value.revision);
	if (!parsedRevision.success) {
		throw new ValidationError("Stored plugin permission revision is invalid");
	}
	if (!parsed.data.grantId || !parsed.data.grantedBy) {
		throw new ValidationError("Stored plugin permission grant identity is incomplete");
	}
	assertJsonLimits(parsed.data.constraints ?? {}, limits);
	return {
		...parsed.data,
		grantId: parsed.data.grantId,
		grantedBy: parsed.data.grantedBy,
		pluginId,
		installationId,
		revision: parsedRevision.data,
	};
}

function parsePendingRequest(value: unknown): PluginPermissionRequest {
	if (!isRecord(value)) throw new ValidationError("Pending permission request is invalid");
	const parsed = capabilitySchema.safeParse(value.capability);
	if (!parsed.success)
		throw new ValidationError("Pending permission request capability is invalid");
	const scopeParsed = permissionScopeSchema.safeParse(value.scope);
	if (!scopeParsed.success)
		throw new ValidationError("Pending permission request scope is invalid");
	if (typeof value.requestId !== "string" || !value.requestId || value.requestId.length > 256)
		throw new ValidationError("Pending permission request id is invalid");
	if (!isIsoDate(value.requestedAt))
		throw new ValidationError("Pending permission request timestamp is invalid");
	if (value.requestedByRuntimeId !== undefined && typeof value.requestedByRuntimeId !== "string")
		throw new ValidationError("Pending permission request runtime id is invalid");
	// Records written before `source` existed are runtime prompts by construction — the
	// upgrade path did not raise requests at all back then. Defaulting instead of
	// rejecting keeps an older permissions.json loadable (a throw here would take the
	// whole file down, losing every grant in it).
	if (value.source !== undefined && value.source !== "runtime" && value.source !== "upgrade")
		throw new ValidationError("Pending permission request source is invalid");
	if (
		value.requestedForVersion !== undefined &&
		(typeof value.requestedForVersion !== "string" || value.requestedForVersion.length > 128)
	)
		throw new ValidationError("Pending permission request version is invalid");
	if (value.status !== "pending" && value.status !== "granted" && value.status !== "denied")
		throw new ValidationError("Pending permission request status is invalid");
	if (value.resolvedAt !== undefined) {
		if (typeof value.resolvedAt !== "string" || !isIsoDate(value.resolvedAt))
			throw new ValidationError("Pending permission request resolvedAt is invalid");
	}
	if (value.status === "pending" && value.resolvedAt !== undefined)
		throw new ValidationError("Pending permission request cannot have resolvedAt while pending");
	return {
		requestId: value.requestId,
		capability: parsed.data,
		scope: scopeParsed.data,
		requestedAt: value.requestedAt,
		requestedByRuntimeId: value.requestedByRuntimeId,
		source: value.source ?? "runtime",
		requestedForVersion: value.requestedForVersion,
		status: value.status,
		resolvedAt: value.resolvedAt,
	};
}

function parsePermanentDenial(value: unknown): PluginPermanentDenial {
	if (!isRecord(value)) throw new ValidationError("Permanent permission denial is invalid");
	const capabilityParsed = capabilitySchema.safeParse(value.capability);
	if (!capabilityParsed.success)
		throw new ValidationError("Permanent permission denial capability is invalid");
	const scopeParsed = permissionScopeSchema.safeParse(value.scope);
	if (!scopeParsed.success)
		throw new ValidationError("Permanent permission denial scope is invalid");
	if (!isIsoDate(value.deniedAt))
		throw new ValidationError("Permanent permission denial timestamp is invalid");
	if (
		value.deniedBy !== undefined &&
		(typeof value.deniedBy !== "string" || !identifierSchema.safeParse(value.deniedBy).success)
	)
		throw new ValidationError("Permanent permission denial actor is invalid");
	return {
		capability: capabilityParsed.data,
		scope: scopeParsed.data,
		deniedAt: value.deniedAt,
		deniedBy: value.deniedBy as string | undefined,
	};
}

function parseInstallation(
	pluginId: string,
	installationId: string,
	value: unknown,
	limits: PluginPermissionStoreLimits,
): PermissionInstallationDocument {
	if (!isRecord(value)) throw new ValidationError("Stored plugin permission set is invalid");
	if (value.pluginId !== pluginId || value.installationId !== installationId) {
		throw new ValidationError("Stored plugin permission set identity is invalid");
	}
	const parsedRevision = revisionSchema.safeParse(value.revision);
	if (!parsedRevision.success) {
		throw new ValidationError("Stored plugin permission set revision is invalid");
	}
	if (!Array.isArray(value.grants) || value.grants.length > limits.maxGrantsPerInstallation) {
		throw new ValidationError("Stored plugin permission grant list is invalid");
	}
	if (!isIsoDate(value.updatedAt))
		throw new ValidationError("Stored plugin permission timestamp is invalid");
	const grants = value.grants.map((grant) =>
		parseStoredGrant(grant, pluginId, installationId, limits),
	);
	if (new Set(grants.map((grant) => grant.grantId)).size !== grants.length) {
		throw new ValidationError("Stored plugin permission grant ids must be unique");
	}
	const rawPending = Array.isArray(value.pendingRequests) ? value.pendingRequests : [];
	if (rawPending.length > limits.maxGrantsPerInstallation) {
		throw new ValidationError("Stored plugin pending requests list is invalid");
	}
	const pendingRequests = rawPending.map((raw) => parsePendingRequest(raw));
	if (new Set(pendingRequests.map((r) => r.requestId)).size !== pendingRequests.length) {
		throw new ValidationError("Stored plugin pending request ids must be unique");
	}
	// Absent in files written before permanent denials existed — treat as none.
	const rawDenials = Array.isArray(value.permanentDenials) ? value.permanentDenials : [];
	if (rawDenials.length > limits.maxGrantsPerInstallation) {
		throw new ValidationError("Stored plugin permanent denials list is invalid");
	}
	const permanentDenials = rawDenials.map((raw) => parsePermanentDenial(raw));
	if (
		new Set(permanentDenials.map((d) => permissionPairKey(d.capability, d.scope))).size !==
		permanentDenials.length
	) {
		throw new ValidationError("Stored plugin permanent denials must be unique");
	}
	return {
		pluginId,
		installationId,
		revision: parsedRevision.data,
		grants,
		pendingRequests,
		permanentDenials,
		updatedAt: value.updatedAt,
	};
}

function parseDiagnostic(value: unknown): PluginPermissionDiagnostic {
	if (!isRecord(value)) throw new ValidationError("Plugin permission diagnostic is invalid");
	if (typeof value.code !== "string" || !value.code || value.code.length > 128) {
		throw new ValidationError("Plugin permission diagnostic code is invalid");
	}
	if (typeof value.message !== "string" || !value.message || value.message.length > 4_096) {
		throw new ValidationError("Plugin permission diagnostic message is invalid");
	}
	if (typeof value.path !== "string" || !value.path || value.path.length > 4_096) {
		throw new ValidationError("Plugin permission diagnostic path is invalid");
	}
	if (!isIsoDate(value.detectedAt))
		throw new ValidationError("Plugin permission diagnostic timestamp is invalid");
	if (value.recoveryPath !== undefined && typeof value.recoveryPath !== "string") {
		throw new ValidationError("Plugin permission recoveryPath is invalid");
	}
	return {
		code: value.code,
		message: value.message,
		path: value.path,
		detectedAt: value.detectedAt,
		recoveryPath: value.recoveryPath,
	};
}

function parseDocument(
	value: unknown,
	limits: PluginPermissionStoreLimits,
): PermissionFileDocument {
	assertJsonLimits(value, limits);
	if (!isRecord(value) || value.version !== PERMISSION_FILE_VERSION || !isRecord(value.plugins)) {
		throw new ValidationError("Plugin permission file has an unsupported or invalid format");
	}
	if (!Array.isArray(value.diagnostics) || value.diagnostics.length > limits.maxDiagnostics) {
		throw new ValidationError("Plugin permission diagnostics are invalid");
	}
	if (!isIsoDate(value.updatedAt))
		throw new ValidationError("Plugin permission updatedAt is invalid");
	const plugins: Record<string, Record<string, PermissionInstallationDocument>> = {};
	for (const [pluginId, rawInstallations] of Object.entries(value.plugins)) {
		if (!pluginIdSchema.safeParse(pluginId).success || !isRecord(rawInstallations)) {
			throw new ValidationError("Plugin permission plugin map is invalid");
		}
		const installations: Record<string, PermissionInstallationDocument> = {};
		const entries = Object.entries(rawInstallations);
		if (entries.length > limits.maxInstallationsPerPlugin) {
			throw new ValidationError("Plugin permission installation count exceeds the limit");
		}
		for (const [installationId, rawSet] of entries) {
			assertPluginIdentity(pluginId, installationId);
			installations[installationId] = parseInstallation(pluginId, installationId, rawSet, limits);
		}
		plugins[pluginId] = installations;
	}
	return {
		version: PERMISSION_FILE_VERSION,
		plugins,
		diagnostics: value.diagnostics.map(parseDiagnostic),
		updatedAt: value.updatedAt,
	};
}

function emptyDocument(now: () => Date): PermissionFileDocument {
	return {
		version: PERMISSION_FILE_VERSION,
		plugins: {},
		diagnostics: [],
		updatedAt: now().toISOString(),
	};
}

function summaryForSet(set: PluginPermissionSet): PluginGrantSummaryUpdate {
	return {
		count: set.grants.length,
		capabilities: [...new Set(set.grants.map((grant) => grant.capability))].sort(),
		revision: set.revision,
		updatedAt: set.updatedAt,
	};
}

function isSameGrantSet(
	left: readonly PermissionGrantInput[],
	right: readonly StoredPermissionGrant[],
): boolean {
	return grantsFingerprint(left) === grantsFingerprint(right.map(baseGrant));
}

export class PluginPermissionStore {
	readonly root: string;
	readonly permissionsPath: string;
	readonly limits: PluginPermissionStoreLimits;
	private readonly stateStore?: PluginStateStore;
	private readonly defaultGrantedBy: string;
	private readonly renameFile: (from: string, to: string) => Promise<void>;
	private readonly now: () => Date;
	private readonly mutex = new AsyncMutex();
	private document?: PermissionFileDocument;

	constructor(options: PluginPermissionStoreOptions = {}) {
		this.root = resolve(options.root ?? options.stateStore?.root ?? getNarraforkPath("plugins"));
		this.permissionsPath = join(this.root, options.fileName ?? "permissions.json");
		this.limits = createLimits(options.limits);
		this.stateStore = options.stateStore;
		this.defaultGrantedBy = options.defaultGrantedBy ?? DEFAULT_ACTOR;
		if (!identifierSchema.safeParse(this.defaultGrantedBy).success) {
			throw new ValidationError("Invalid default permission actor");
		}
		this.renameFile = options.renameFile ?? rename;
		this.now = options.now ?? (() => new Date());
	}

	async initialize(): Promise<PluginPermissionStoreSnapshot> {
		await this.mutex.acquire("permissions", async () => this.ensureLoadedLocked());
		return this.snapshot();
	}

	async getSet(pluginId: string, installationId: string): Promise<PluginPermissionSet> {
		assertPluginIdentity(pluginId, installationId);
		await this.ensureLoaded();
		const set = this.document?.plugins[pluginId]?.[installationId];
		const revision = this.pluginRevision(pluginId);
		return set
			? this.toPublicSet(set, revision)
			: this.emptySet(pluginId, installationId, revision);
	}

	/**
	 * Fail-closed authorization for synchronous host hints, not a capability summary.
	 * Hints carry no invocation scope and cannot enforce constraints (rates, bytes, etc.),
	 * so only live, global, unrestricted grants can authorize them. An unloaded store denies.
	 */
	hasCachedUnrestrictedGlobalGrant(
		pluginId: string,
		installationId: string,
		capability: string,
	): boolean {
		const now = this.now().getTime();
		return (
			this.document?.plugins[pluginId]?.[installationId]?.grants.some(
				(grant) =>
					grant.capability === capability &&
					grant.scope.type === "global" &&
					(grant.expiresAt === undefined || Date.parse(grant.expiresAt) > now) &&
					(grant.constraints === undefined || Object.keys(grant.constraints).length === 0),
			) ?? false
		);
	}

	async get(pluginId: string, installationId: string): Promise<PluginPermissionSet> {
		return this.getSet(pluginId, installationId);
	}

	async list(pluginId: string, installationId?: string): Promise<StoredPermissionGrant[]> {
		assertPluginIdentity(pluginId, installationId ?? "placeholder");
		await this.ensureLoaded();
		if (installationId !== undefined) {
			return clone(this.document?.plugins[pluginId]?.[installationId]?.grants ?? []);
		}
		return clone(
			Object.values(this.document?.plugins[pluginId] ?? {})
				.flatMap((set) => set.grants)
				.sort(
					(left, right) =>
						left.revision - right.revision || left.grantId.localeCompare(right.grantId),
				),
		);
	}

	async listGrants(pluginId: string, installationId: string): Promise<StoredPermissionGrant[]> {
		return this.list(pluginId, installationId);
	}

	async getRevision(pluginId: string, installationId: string): Promise<number> {
		return (await this.getSet(pluginId, installationId)).revision;
	}

	async hasSet(pluginId: string, installationId: string): Promise<boolean> {
		assertPluginIdentity(pluginId, installationId);
		await this.ensureLoaded();
		return this.document?.plugins[pluginId]?.[installationId] !== undefined;
	}

	/**
	 * Ensure a package installation has its own durable grant set. A new package inherits the
	 * complete previous set without widening scope or dropping constraints/expiry/audit fields.
	 */
	async ensureInstallation(
		pluginId: string,
		installationId: string,
		sourceInstallationId?: string,
	): Promise<PluginPermissionSet> {
		assertPluginIdentity(pluginId, installationId);
		if (sourceInstallationId !== undefined) {
			assertPluginIdentity(pluginId, sourceInstallationId);
		}
		return this.mutex.acquire("permissions", async () => {
			await this.ensureLoadedLocked();
			const document = this.requireDocument();
			const revision = this.pluginRevision(pluginId, document);
			const existing = document.plugins[pluginId]?.[installationId];
			if (existing) {
				const set = this.toPublicSet(existing, revision);
				await this.syncStateSummary(pluginId);
				return set;
			}
			const source = sourceInstallationId
				? document.plugins[pluginId]?.[sourceInstallationId]
				: undefined;
			const updatedAt = this.timestamp();
			const next: PermissionInstallationDocument = {
				pluginId,
				installationId,
				revision,
				grants: (source?.grants ?? []).map((grant) => ({
					...clone(grant),
					pluginId,
					installationId,
				})),
				pendingRequests: clone(source?.pendingRequests ?? []),
				permanentDenials: clone(source?.permanentDenials ?? []),
				updatedAt,
			};
			const candidate = clone(document);
			candidate.plugins[pluginId] ??= {};
			candidate.plugins[pluginId][installationId] = next;
			this.assertInstallationCount(candidate, pluginId);
			candidate.updatedAt = updatedAt;
			await this.writeLocked(candidate);
			this.document = candidate;
			const set = this.toPublicSet(next, revision);
			await this.syncStateSummary(pluginId);
			return set;
		});
	}

	async listSets(pluginId?: string): Promise<PluginPermissionSet[]> {
		await this.ensureLoaded();
		const sets: PluginPermissionSet[] = [];
		for (const [id, installations] of Object.entries(this.document?.plugins ?? {})) {
			if (pluginId !== undefined && pluginId !== id) continue;
			const revision = this.pluginRevision(id);
			for (const set of Object.values(installations)) {
				sets.push(this.toPublicSet(set, revision));
			}
		}
		return sets.sort(
			(left, right) =>
				left.pluginId.localeCompare(right.pluginId) ||
				left.installationId.localeCompare(right.installationId),
		);
	}

	async replace(
		pluginId: string,
		installationId: string,
		grants: readonly PermissionGrantInput[],
		options: PermissionReplaceOptions = {},
	): Promise<PermissionMutationResult> {
		assertPluginIdentity(pluginId, installationId);
		if (grants.length > this.limits.maxGrantsPerInstallation) {
			throw new ValidationError("Too many plugin permission grants");
		}
		if (
			options.expectedRevision !== undefined &&
			!revisionSchema.safeParse(options.expectedRevision).success
		) {
			throw new ValidationError("Invalid expected permission revision");
		}
		return this.mutex.acquire("permissions", async () => {
			await this.ensureLoadedLocked();
			const current = this.document?.plugins[pluginId]?.[installationId];
			const pluginRevision = this.pluginRevision(pluginId);
			const currentSet = current
				? this.toPublicSet(current, pluginRevision)
				: this.emptySet(pluginId, installationId, pluginRevision);
			if (
				options.expectedRevision !== undefined &&
				options.expectedRevision !== currentSet.revision
			) {
				throw new PluginPermissionConflictError(
					pluginId,
					options.expectedRevision,
					currentSet.revision,
				);
			}
			const actor = options.grantedBy ?? this.defaultGrantedBy;
			if (!identifierSchema.safeParse(actor).success)
				throw new ValidationError("Invalid grantedBy");
			const normalized = grants.map((grant) =>
				this.normalizeInput(pluginId, installationId, grant, actor),
			);
			if (new Set(normalized.map((grant) => grant.grantId)).size !== normalized.length) {
				throw new ValidationError("Plugin permission grant ids must be unique");
			}
			if (isSameGrantSet(grants, currentSet.grants)) {
				return { set: currentSet, changed: false, idempotent: true };
			}
			const nextRevision =
				options.targetRevision === undefined
					? currentSet.revision + 1
					: this.targetRevision(pluginId, currentSet.revision, options.targetRevision);
			const next: PermissionInstallationDocument = {
				pluginId,
				installationId,
				revision: nextRevision,
				grants: normalized.map((grant) => ({ ...grant, revision: nextRevision })),
				pendingRequests: clone(current?.pendingRequests ?? []),
				permanentDenials: clone(current?.permanentDenials ?? []),
				updatedAt: this.timestamp(),
			};
			const candidate = clone(this.requireDocument());
			candidate.plugins[pluginId] ??= {};
			candidate.plugins[pluginId][installationId] = next;
			this.assertInstallationCount(candidate, pluginId);
			candidate.updatedAt = next.updatedAt;
			await this.writeLocked(candidate);
			this.document = candidate;
			const publicSet = this.toPublicSet(next, nextRevision);
			await this.syncStateSummary(pluginId);
			return { set: publicSet, changed: true, idempotent: false };
		});
	}

	async grant(
		pluginId: string,
		installationId: string,
		grant: PermissionGrantInput,
		options: PermissionReplaceOptions = {},
	): Promise<PermissionMutationResult> {
		const current = await this.getSet(pluginId, installationId);
		const existingId = grant.grantId;
		if (existingId) {
			const existing = current.grants.find((item) => item.grantId === existingId);
			if (existing && grantFingerprint(grant) === grantFingerprint(baseGrant(existing))) {
				if (
					options.expectedRevision !== undefined &&
					options.expectedRevision !== current.revision
				) {
					throw new PluginPermissionConflictError(
						pluginId,
						options.expectedRevision,
						current.revision,
					);
				}
				return { set: current, changed: false, idempotent: true };
			}
		}
		return this.replace(
			pluginId,
			installationId,
			[...current.grants.map(baseGrant), grant],
			options,
		);
	}

	async revoke(
		pluginId: string,
		installationId: string,
		grantIds: readonly string[],
		options: PermissionReplaceOptions = {},
	): Promise<PermissionMutationResult> {
		assertPluginIdentity(pluginId, installationId);
		if (!Array.isArray(grantIds) || grantIds.length > this.limits.maxGrantsPerInstallation) {
			throw new ValidationError("Invalid plugin permission grant ids");
		}
		for (const grantId of grantIds) {
			if (!identifierSchema.safeParse(grantId).success)
				throw new ValidationError("Invalid grantId");
		}
		const current = await this.getSet(pluginId, installationId);
		if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision) {
			throw new PluginPermissionConflictError(pluginId, options.expectedRevision, current.revision);
		}
		const ids = new Set(grantIds);
		const missing = [...ids].filter((id) => !current.grants.some((grant) => grant.grantId === id));
		if (missing.length > 0) throw new PluginPermissionNotFoundError(missing[0] as string);
		if (ids.size === 0) return { set: current, changed: false, idempotent: true };
		return this.replace(
			pluginId,
			installationId,
			current.grants.filter((grant) => !ids.has(grant.grantId)).map(baseGrant),
			options,
		);
	}

	async clearPlugin(pluginId: string): Promise<boolean> {
		if (!pluginIdSchema.safeParse(pluginId).success) throw new ValidationError("Invalid pluginId");
		return this.mutex.acquire("permissions", async () => {
			await this.ensureLoadedLocked();
			const candidate = clone(this.requireDocument());
			if (!candidate.plugins[pluginId]) return false;
			delete candidate.plugins[pluginId];
			candidate.updatedAt = this.timestamp();
			await this.writeLocked(candidate);
			this.document = candidate;
			if (this.stateStore && (await this.stateStore.getState(pluginId))) {
				await this.stateStore.updateGrantSummary(pluginId, {
					count: 0,
					capabilities: [],
					revision: 0,
					updatedAt: candidate.updatedAt,
				});
			}
			return true;
		});
	}

	/** Migrate a legacy summary only when no complete installation set can be recovered. */
	async ensureLegacySummary(
		pluginId: string,
		installationId: string,
		summary: PluginGrantSummary,
	): Promise<PluginPermissionSet> {
		const current = await this.getSet(pluginId, installationId);
		if (await this.hasSet(pluginId, installationId)) {
			return this.ensureInstallation(pluginId, installationId);
		}
		const expectedCapabilities = [...summary.capabilities].sort();
		const source = (await this.listSets(pluginId))
			.filter((set) => set.installationId !== installationId)
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
			.find((set) => {
				const capabilities = [...new Set(set.grants.map((grant) => grant.capability))].sort();
				return (
					set.grants.length === summary.count &&
					JSON.stringify(capabilities) === JSON.stringify(expectedCapabilities)
				);
			});
		if (source) {
			return this.ensureInstallation(pluginId, installationId, source.installationId);
		}
		if (summary.capabilities.length === 0) {
			return this.ensureInstallation(pluginId, installationId);
		}
		const grants: PermissionGrantInput[] = summary.capabilities.map((capability) => ({
			capability: capability as PermissionGrant["capability"],
			scope: { type: "global" },
			grantId: `legacy-${pluginId}-${capability}`.slice(0, 256),
			grantedBy: "legacy-state",
		}));
		const result = await this.replace(pluginId, installationId, grants, {
			expectedRevision: current.revision,
			targetRevision: Math.max(summary.revision, current.revision + 1),
			grantedBy: "legacy-state",
		});
		return result.set;
	}

	async snapshot(): Promise<PluginPermissionStoreSnapshot> {
		return { sets: await this.listSets(), diagnostics: await this.getDiagnostics() };
	}

	async getDiagnostics(): Promise<PluginPermissionDiagnostic[]> {
		await this.ensureLoaded();
		return clone(this.document?.diagnostics ?? []);
	}

	async listPendingRequests(
		pluginId: string,
		installationId: string,
	): Promise<PluginPermissionRequest[]> {
		assertPluginIdentity(pluginId, installationId);
		await this.ensureLoaded();
		const doc = this.document?.plugins[pluginId]?.[installationId];
		if (!doc) return [];
		return clone((doc.pendingRequests ?? []).filter((r) => r.status === "pending"));
	}

	/**
	 * Queue a permission prompt, or return `undefined` when the (capability, scope)
	 * pair is permanently denied — "never ask again" means exactly that, so no row
	 * is written and no UI prompt is raised. An existing pending row for the same
	 * pair is returned unchanged (idempotent).
	 */
	async addPendingRequest(
		pluginId: string,
		installationId: string,
		input: {
			capability: string;
			scope: PermissionScope;
			requestedByRuntimeId?: string;
			source?: PluginPermissionRequestSource;
			requestedForVersion?: string;
		},
	): Promise<PluginPermissionRequest | undefined> {
		assertPluginIdentity(pluginId, installationId);
		const capabilityResult = capabilitySchema.safeParse(input.capability);
		if (!capabilityResult.success) throw new ValidationError("Invalid capability");
		const scopeResult = permissionScopeSchema.safeParse(input.scope);
		if (!scopeResult.success) throw new ValidationError("Invalid permission scope");
		if (input.requestedForVersion !== undefined && input.requestedForVersion.length > 128)
			throw new ValidationError("Invalid permission request version");

		return this.mutex.acquire("permissions", async () => {
			await this.ensureLoadedLocked();
			const document = this.requireDocument();
			const doc = document.plugins[pluginId]?.[installationId];
			const existingRequests: PluginPermissionRequest[] = doc?.pendingRequests ?? [];
			const pairKey = permissionPairKey(input.capability, input.scope);

			// A permanent denial wins over everything, including a still-pending row
			// (reachable only if the denial was recorded out of band). No prompt, no row.
			if (
				(doc?.permanentDenials ?? []).some(
					(denial) => permissionPairKey(denial.capability, denial.scope) === pairKey,
				)
			) {
				return undefined;
			}

			// Idempotent: same capability + scope with pending status → return existing.
			// This deliberately ignores `source`: one pending request per (capability, scope)
			// is what the admin actually decides on, and approving it has the same effect
			// whichever path raised it. Re-running an upgrade therefore does not stack
			// duplicate rows, and a capability already queued by a runtime call is not
			// queued twice because the new manifest also declares it.
			const existing = existingRequests.find(
				(r) => permissionPairKey(r.capability, r.scope) === pairKey && r.status === "pending",
			);
			if (existing) return clone(existing);

			// Max pending check
			const pendingCount = existingRequests.filter((r) => r.status === "pending").length;
			if (pendingCount >= DEFAULT_MAX_PENDING_REQUESTS) {
				throw new ValidationError("Too many pending permission requests");
			}

			const request: PluginPermissionRequest = {
				requestId: generateShortId(),
				capability: input.capability,
				scope: clone(input.scope),
				requestedAt: this.timestamp(),
				requestedByRuntimeId: input.requestedByRuntimeId,
				source: input.source ?? "runtime",
				requestedForVersion: input.requestedForVersion,
				status: "pending",
			};

			const candidate = clone(document);
			candidate.plugins[pluginId] ??= {};
			const current = candidate.plugins[pluginId]?.[installationId];
			if (current) {
				const updated: PermissionInstallationDocument = {
					...clone(current),
					pendingRequests: [...trimResolvedRequests(current.pendingRequests ?? []), request],
					updatedAt: this.timestamp(),
				};
				candidate.plugins[pluginId][installationId] = updated;
			} else {
				const revision = this.pluginRevision(pluginId, document);
				candidate.plugins[pluginId][installationId] = {
					pluginId,
					installationId,
					revision,
					grants: [],
					pendingRequests: [request],
					permanentDenials: [],
					updatedAt: this.timestamp(),
				};
			}
			this.assertInstallationCount(candidate, pluginId);
			candidate.updatedAt = this.timestamp();
			await this.writeLocked(candidate);
			this.document = candidate;
			return clone(request);
		});
	}

	/**
	 * Resolve a request that is still pending. Returns `undefined` when the row is
	 * unknown OR already decided, so a stale client (or a replayed request id) can
	 * never flip an approved row to denied and report success while the grant
	 * stays in force.
	 *
	 * `permanentDenial` records "never ask again" in the SAME locked write as the
	 * denial. Two separate writes left a window in which a plugin retry could queue
	 * a fresh pending row (the old row was already denied, the permanent denial not
	 * yet recorded), and a failure of the second write left the request denied
	 * while the API reported an error.
	 */
	async resolvePendingRequest(
		pluginId: string,
		installationId: string,
		requestId: string,
		status: "granted" | "denied",
		options: { permanentDenial?: { deniedBy?: string } } = {},
	): Promise<PluginPermissionRequest | undefined> {
		assertPluginIdentity(pluginId, installationId);
		if (!identifierSchema.safeParse(requestId).success)
			throw new ValidationError("Invalid requestId");
		if (status !== "granted" && status !== "denied")
			throw new ValidationError("Invalid resolve status");
		const permanentDenial = options.permanentDenial;
		if (permanentDenial && status !== "denied")
			throw new ValidationError("A permanent denial requires a denied status");
		if (
			permanentDenial?.deniedBy !== undefined &&
			!identifierSchema.safeParse(permanentDenial.deniedBy).success
		)
			throw new ValidationError("Invalid deniedBy");

		return this.mutex.acquire("permissions", async () => {
			await this.ensureLoadedLocked();
			const document = this.requireDocument();
			const candidate = clone(document);
			const pluginEntry = candidate.plugins[pluginId];
			const current = pluginEntry?.[installationId];
			if (!pluginEntry || !current) return undefined;
			const nextRequests = [...(current.pendingRequests ?? [])];
			const index = nextRequests.findIndex((r) => r.requestId === requestId);
			const target = index === -1 ? undefined : nextRequests[index];
			if (!target || target.status !== "pending") return undefined;

			const resolved: PluginPermissionRequest = {
				...target,
				status,
				resolvedAt: this.timestamp(),
			};
			nextRequests[index] = resolved;

			let permanentDenials = current.permanentDenials ?? [];
			if (permanentDenial) {
				const pairKey = permissionPairKey(resolved.capability, resolved.scope);
				const exists = permanentDenials.some(
					(denial) => permissionPairKey(denial.capability, denial.scope) === pairKey,
				);
				if (!exists) {
					if (permanentDenials.length >= this.limits.maxGrantsPerInstallation) {
						throw new ValidationError("Too many permanent permission denials");
					}
					permanentDenials = [
						...permanentDenials,
						{
							capability: resolved.capability,
							scope: clone(resolved.scope),
							deniedAt: this.timestamp(),
							deniedBy: permanentDenial.deniedBy,
						},
					];
				}
			}

			pluginEntry[installationId] = {
				...current,
				pendingRequests: nextRequests,
				permanentDenials,
				updatedAt: this.timestamp(),
			};
			candidate.updatedAt = this.timestamp();
			await this.writeLocked(candidate);
			this.document = candidate;
			return clone(resolved);
		});
	}

	async listPermanentDenials(
		pluginId: string,
		installationId: string,
	): Promise<PluginPermanentDenial[]> {
		assertPluginIdentity(pluginId, installationId);
		await this.ensureLoaded();
		return clone(this.document?.plugins[pluginId]?.[installationId]?.permanentDenials ?? []);
	}

	/**
	 * Record a "never ask again" decision. Idempotent per (capability, scope): a
	 * repeat call returns the existing record untouched.
	 */
	async addPermanentDenial(
		pluginId: string,
		installationId: string,
		input: { capability: string; scope: PermissionScope; deniedBy?: string },
	): Promise<PluginPermanentDenial> {
		assertPluginIdentity(pluginId, installationId);
		const capabilityResult = capabilitySchema.safeParse(input.capability);
		if (!capabilityResult.success) throw new ValidationError("Invalid capability");
		const scopeResult = permissionScopeSchema.safeParse(input.scope);
		if (!scopeResult.success) throw new ValidationError("Invalid permission scope");
		if (input.deniedBy !== undefined && !identifierSchema.safeParse(input.deniedBy).success)
			throw new ValidationError("Invalid deniedBy");

		return this.mutex.acquire("permissions", async () => {
			await this.ensureLoadedLocked();
			const document = this.requireDocument();
			const doc = document.plugins[pluginId]?.[installationId];
			const pairKey = permissionPairKey(input.capability, input.scope);
			const existing = (doc?.permanentDenials ?? []).find(
				(denial) => permissionPairKey(denial.capability, denial.scope) === pairKey,
			);
			if (existing) return clone(existing);
			if ((doc?.permanentDenials ?? []).length >= this.limits.maxGrantsPerInstallation) {
				throw new ValidationError("Too many permanent permission denials");
			}

			const denial: PluginPermanentDenial = {
				capability: input.capability,
				scope: clone(input.scope),
				deniedAt: this.timestamp(),
				deniedBy: input.deniedBy,
			};
			const candidate = clone(document);
			candidate.plugins[pluginId] ??= {};
			const current = candidate.plugins[pluginId]?.[installationId];
			if (current) {
				candidate.plugins[pluginId][installationId] = {
					...clone(current),
					permanentDenials: [...(current.permanentDenials ?? []), denial],
					updatedAt: this.timestamp(),
				};
			} else {
				const revision = this.pluginRevision(pluginId, document);
				candidate.plugins[pluginId][installationId] = {
					pluginId,
					installationId,
					revision,
					grants: [],
					pendingRequests: [],
					permanentDenials: [denial],
					updatedAt: this.timestamp(),
				};
			}
			this.assertInstallationCount(candidate, pluginId);
			candidate.updatedAt = this.timestamp();
			await this.writeLocked(candidate);
			this.document = candidate;
			return clone(denial);
		});
	}

	/**
	 * Lift a permanent denial so the plugin may ask for the pair again. Returns
	 * false when no matching denial exists.
	 */
	async removePermanentDenial(
		pluginId: string,
		installationId: string,
		capability: string,
		scope: PermissionScope,
	): Promise<boolean> {
		assertPluginIdentity(pluginId, installationId);
		const capabilityResult = capabilitySchema.safeParse(capability);
		if (!capabilityResult.success) throw new ValidationError("Invalid capability");
		const scopeResult = permissionScopeSchema.safeParse(scope);
		if (!scopeResult.success) throw new ValidationError("Invalid permission scope");

		return this.mutex.acquire("permissions", async () => {
			await this.ensureLoadedLocked();
			const document = this.requireDocument();
			const doc = document.plugins[pluginId]?.[installationId];
			if (!doc) return false;
			const pairKey = permissionPairKey(capability, scope);
			const denials = doc.permanentDenials ?? [];
			const next = denials.filter(
				(denial) => permissionPairKey(denial.capability, denial.scope) !== pairKey,
			);
			if (next.length === denials.length) return false;

			const candidate = clone(document);
			const pluginEntry = candidate.plugins[pluginId];
			const current = pluginEntry?.[installationId];
			if (!pluginEntry || !current) return false;
			pluginEntry[installationId] = {
				...clone(current),
				permanentDenials: next,
				updatedAt: this.timestamp(),
			};
			candidate.updatedAt = this.timestamp();
			await this.writeLocked(candidate);
			this.document = candidate;
			return true;
		});
	}

	private normalizeInput(
		pluginId: string,
		installationId: string,
		input: PermissionGrantInput,
		defaultActor: string,
	): StoredPermissionGrant {
		const parsed = permissionGrantSchema.safeParse({
			capability: input.capability,
			scope: input.scope,
			constraints: input.constraints,
			expiresAt: input.expiresAt,
			grantId: input.grantId ?? `grant_${generateShortId(20)}`,
			grantedBy: input.grantedBy ?? defaultActor,
		});
		if (!parsed.success) throw new ValidationError("Plugin permission grant is invalid");
		const grantId = parsed.data.grantId;
		const grantedBy = parsed.data.grantedBy;
		if (!grantId || !grantedBy)
			throw new ValidationError("Plugin permission identity is incomplete");
		if (!identifierSchema.safeParse(grantId).success) throw new ValidationError("Invalid grantId");
		if (!identifierSchema.safeParse(grantedBy).success)
			throw new ValidationError("Invalid grantedBy");
		assertJsonLimits(parsed.data.constraints ?? {}, this.limits);
		return {
			...parsed.data,
			grantId,
			grantedBy,
			pluginId,
			installationId,
			revision: 0,
		};
	}

	private targetRevision(pluginId: string, current: number, requested: number): number {
		if (!revisionSchema.safeParse(requested).success || requested <= current) {
			throw new PluginPermissionConflictError(pluginId, requested, current);
		}
		return requested;
	}

	private emptySet(pluginId: string, installationId: string, revision = 0): PluginPermissionSet {
		return {
			pluginId,
			installationId,
			revision,
			grants: [],
			updatedAt: this.timestamp(),
		};
	}

	private toPublicSet(
		set: PermissionInstallationDocument,
		revision = set.revision,
	): PluginPermissionSet {
		return {
			pluginId: set.pluginId,
			installationId: set.installationId,
			revision,
			grants: clone(set.grants),
			updatedAt: set.updatedAt,
		};
	}

	private pluginRevision(
		pluginId: string,
		document: PermissionFileDocument = this.requireDocument(),
	): number {
		return Object.values(document.plugins[pluginId] ?? {}).reduce(
			(maximum, set) => Math.max(maximum, set.revision),
			0,
		);
	}

	private assertInstallationCount(document: PermissionFileDocument, pluginId: string): void {
		if (
			Object.keys(document.plugins[pluginId] ?? {}).length > this.limits.maxInstallationsPerPlugin
		) {
			throw new ValidationError("Plugin permission installation count exceeds the limit");
		}
	}

	private async syncStateSummary(pluginId: string): Promise<void> {
		if (!this.stateStore) return;
		const state = await this.stateStore.getState(pluginId);
		if (!state) return;
		// The state summary mirrors the canonical authority, keyed by the stable
		// installation UUID. Fall back through the authority generation and package
		// hash only for legacy states that predate the UUID migration.
		const installationId =
			state.installationId ?? state.authorityInstallationId ?? state.current?.hash;
		const set = installationId
			? this.document?.plugins[pluginId]?.[installationId]
			: Object.values(this.document?.plugins[pluginId] ?? {}).sort((a, b) =>
					b.updatedAt.localeCompare(a.updatedAt),
				)[0];
		const summary: PluginGrantSummaryUpdate = set
			? summaryForSet(this.toPublicSet(set, this.pluginRevision(pluginId)))
			: { count: 0, capabilities: [], revision: 0, updatedAt: this.timestamp() };
		const summaryIsCurrent =
			state.grants.count === summary.count &&
			state.grants.revision === summary.revision &&
			state.grants.updatedAt === summary.updatedAt &&
			state.grants.capabilities.length === summary.capabilities.length &&
			state.grants.capabilities.every(
				(capability, index) => capability === summary.capabilities[index],
			);
		if (!summaryIsCurrent) await this.stateStore.updateGrantSummary(pluginId, summary);
	}

	private timestamp(): string {
		return this.now().toISOString();
	}

	private async ensureLoaded(): Promise<void> {
		if (this.document) return;
		await this.mutex.acquire("permissions", async () => this.ensureLoadedLocked());
	}

	private async ensureLoadedLocked(): Promise<void> {
		if (this.document) return;
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		try {
			const parsed = parseDocument(await this.readJson(), this.limits);
			await chmod(this.permissionsPath, 0o600);
			this.document = parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				this.document = emptyDocument(this.now);
				return;
			}
			const diagnostic = await this.recoverCorruptFile(error);
			const document = emptyDocument(this.now);
			document.diagnostics.push(diagnostic);
			await this.writeLocked(document);
			this.document = document;
		}
	}

	private requireDocument(): PermissionFileDocument {
		if (!this.document) throw new Error("Plugin permission store is not initialized");
		return this.document;
	}

	private async readJson(): Promise<unknown> {
		const info = await lstat(this.permissionsPath);
		if (!info.isFile() || info.isSymbolicLink()) {
			throw new ValidationError("Plugin permissions file is not a regular host-owned file");
		}
		if (info.size > this.limits.maxFileBytes)
			throw new ValidationError("Plugin permissions file is too large");
		const bytes = await readFile(this.permissionsPath);
		if (bytes.byteLength > this.limits.maxFileBytes)
			throw new ValidationError("Plugin permissions file is too large");
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
	}

	private async recoverCorruptFile(error: unknown): Promise<PluginPermissionDiagnostic> {
		const detectedAt = this.timestamp();
		const recoveryPath = `${this.permissionsPath}.corrupt-${detectedAt.replace(/[:.]/g, "-")}-${generateShortId(6)}`;
		let preservedPath: string | undefined;
		try {
			await rename(this.permissionsPath, recoveryPath);
			await chmod(recoveryPath, 0o600).catch(() => undefined);
			preservedPath = recoveryPath;
		} catch (preserveError) {
			logger.error("Unable to preserve corrupt plugin permissions file", {
				path: this.permissionsPath,
				error: preserveError instanceof Error ? preserveError.message : String(preserveError),
			});
		}
		return {
			code: "PLUGIN_PERMISSIONS_CORRUPT",
			message: (error instanceof Error ? error.message : String(error)).slice(0, 4_096),
			path: this.permissionsPath,
			detectedAt,
			recoveryPath: preservedPath,
		};
	}

	private async writeLocked(document: PermissionFileDocument): Promise<void> {
		document.diagnostics = document.diagnostics.slice(-this.limits.maxDiagnostics);
		assertJsonLimits(document, this.limits);
		const json = `${JSON.stringify(document, null, 2)}\n`;
		if (Buffer.byteLength(json, "utf8") > this.limits.maxFileBytes) {
			throw new ValidationError("Plugin permissions file exceeds its size limit");
		}
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const temporaryPath = join(
			this.root,
			`.${basename(this.permissionsPath)}.${generateShortId(10)}.tmp`,
		);
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(temporaryPath, "wx", 0o600);
			await handle.writeFile(json, { encoding: "utf8" });
			await handle.chmod(0o600);
			await handle.sync();
			await handle.close();
			handle = undefined;
			await this.renameFile(temporaryPath, this.permissionsPath);
			await chmod(this.permissionsPath, 0o600);
			let directory: Awaited<ReturnType<typeof open>> | undefined;
			try {
				directory = await open(this.root, "r");
				await directory.sync();
			} catch {
				// Directory fsync is unavailable on some platforms/filesystems.
			} finally {
				await directory?.close().catch(() => undefined);
			}
		} catch (error) {
			await handle?.close().catch(() => undefined);
			await rm(temporaryPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}
}

export const pluginPermissionStore = new PluginPermissionStore();

export function permissionGrantPayload(
	grant: StoredPermissionGrant | PermissionGrant,
): PermissionGrant {
	return baseGrant(grant) as PermissionGrant;
}

export function permissionSummary(set: PluginPermissionSet): PluginGrantSummary {
	const summary = summaryForSet(set);
	return { ...summary, capabilities: [...summary.capabilities] };
}
