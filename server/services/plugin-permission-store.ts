import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { AsyncMutex } from "@server/lib/async-mutex";
import { AppError, ValidationError } from "@server/lib/errors";
import { generateShortId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import { getNarraforkPath } from "@server/lib/narrafork-home";
import { pluginIdSchema } from "@server/lib/plugins/manifest";
import { type PermissionGrant, permissionGrantSchema } from "@server/lib/plugins/permissions";
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
const DEFAULT_MAX_JSON_DEPTH = 16;
const DEFAULT_MAX_ARRAY_LENGTH = 2_048;
const DEFAULT_MAX_OBJECT_KEYS = 8_192;
const DEFAULT_MAX_STRING_BYTES = 16 * 1024;
const DEFAULT_MAX_DIAGNOSTICS = 32;
const DEFAULT_ACTOR = "admin";

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
	updatedAt: string;
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
	return {
		pluginId,
		installationId,
		revision: parsedRevision.data,
		grants,
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
		const installationId = state.current?.hash;
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

export function permissionGrantPayload(grant: StoredPermissionGrant): PermissionGrant {
	return baseGrant(grant) as PermissionGrant;
}

export function permissionSummary(set: PluginPermissionSet): PluginGrantSummary {
	const summary = summaryForSet(set);
	return { ...summary, capabilities: [...summary.capabilities] };
}
