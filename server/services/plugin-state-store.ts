import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { AsyncMutex } from "@server/lib/async-mutex";
import { ValidationError } from "@server/lib/errors";
import { generateShortId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import { getNarraforkPath } from "@server/lib/narrafork-home";
import { pluginIdSchema } from "@server/lib/plugins/manifest";
import {
	COMPATIBILITY_STATES,
	type CompatibilityState,
	DESIRED_STATES,
	type DesiredState,
	RUNTIME_STATES,
	type RuntimeState,
} from "@server/lib/plugins/permissions";
import type { JsonValue } from "@server/lib/plugins/protocol";

const STATE_FILE_VERSION = 1;
const JOURNAL_FILE_VERSION = 1;
const DEFAULT_MAX_STATE_BYTES = 1024 * 1024;
const DEFAULT_MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_JSON_DEPTH = 12;
const DEFAULT_MAX_ARRAY_LENGTH = 2_048;
const DEFAULT_MAX_OBJECT_KEYS = 4_096;
const DEFAULT_MAX_STRING_BYTES = 16 * 1024;
const DEFAULT_MAX_OPERATIONS = 1_000;
const DEFAULT_MAX_DIAGNOSTICS = 50;
const DEFAULT_MAX_ERROR_BYTES = 4 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export type PluginJournalOperation =
	| "install"
	| "enable"
	| "disable"
	| "activate"
	| "deactivate"
	| "upgrade"
	| "rollback"
	| "uninstall";

export type PluginJournalStatus = "pending" | "running" | "succeeded" | "failed" | "rolled_back";

export interface PluginPackageReference {
	version: string;
	hash: string;
}

export interface PluginGrantSummary {
	count: number;
	capabilities: string[];
	revision: number;
	updatedAt?: string;
}

export interface PluginGrantSummaryUpdate {
	count: number;
	capabilities: readonly string[];
	revision: number;
	updatedAt?: string;
}

export interface PluginStateError {
	code: string;
	message: string;
	phase?: string;
	at: string;
}

/**
 * User-supplied configuration for this plugin's providers, keyed by the provider's
 * **contribution id** (the `id` in `contributes.providers`).
 *
 * Deliberately not keyed by `providerInstanceId`: that embeds the package generation,
 * so an upgrade would orphan the config and silently reset the user's settings. The
 * contribution id is stable across versions as long as the plugin keeps the same
 * provider.
 *
 * Stored here rather than in a database table because provider config is small,
 * low-frequency data that belongs to the same lifecycle as the rest of plugin
 * state — it inherits the atomic write, journal and corruption recovery this file
 * already provides, and adds no main-thread SQLite work.
 *
 * Secrets do NOT live here: API keys and tokens go through the secret broker. A
 * schema that wants a secret declares `format: "password"`, and the host stores the
 * value by reference instead of inlining it.
 */
export type PluginProviderConfigMap = Record<string, Record<string, JsonValue>>;

/**
 * Admin-chosen provider prefix overrides, keyed by the provider's contribution id.
 *
 * The manifest prefix is only a suggestion: two plugins may both want `openai`, and the
 * registry treats the prefix as a globally unique namespace key. Storing the override
 * next to the config (and keyed the same way) means it survives restarts and package
 * upgrades for the same reason config does.
 */
export type PluginProviderPrefixMap = Record<string, string>;

export interface PluginStateRecord {
	pluginId: string;
	current: PluginPackageReference | null;
	/** Internal authority generation; package hash remains the immutable package identity. */
	authorityInstallationId: string | null;
	desiredState: DesiredState;
	compatibility: CompatibilityState;
	runtimeState: RuntimeState;
	grants: PluginGrantSummary;
	/** Provider config by contribution id; empty when nothing is configured. */
	providerConfigs: PluginProviderConfigMap;
	/** Prefix overrides by contribution id; absent entries use the manifest prefix. */
	providerPrefixes: PluginProviderPrefixMap;
	crashCount: number;
	restartCount: number;
	consecutiveFailures: number;
	runtimeGeneration: number;
	lastError: PluginStateError | null;
	createdAt: string;
	updatedAt: string;
}

export interface PluginPersistenceDiagnostic {
	code: string;
	message: string;
	source: "state" | "journal";
	path: string;
	detectedAt: string;
	recoveryPath?: string;
}

export interface PluginJournalContext {
	from?: PluginPackageReference | null;
	to?: PluginPackageReference | null;
	phase?: string;
	reason?: string;
	recoveredAt?: string;
}

export interface PluginJournalEntry {
	id: string;
	pluginId: string;
	operation: PluginJournalOperation;
	status: PluginJournalStatus;
	context: PluginJournalContext;
	error: PluginStateError | null;
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
}

export interface PluginStateStoreLimits {
	maxStateBytes: number;
	maxJournalBytes: number;
	maxJsonDepth: number;
	maxArrayLength: number;
	maxObjectKeys: number;
	maxStringBytes: number;
	maxOperations: number;
	maxDiagnostics: number;
	maxErrorBytes: number;
}

export interface PluginStateStoreOptions {
	root?: string;
	stateFileName?: string;
	journalFileName?: string;
	limits?: Partial<PluginStateStoreLimits>;
	/** Injectable only for atomic-write failure tests. */
	renameFile?: (from: string, to: string) => Promise<void>;
	now?: () => Date;
}

export interface PluginStateStoreSnapshot {
	states: PluginStateRecord[];
	operations: PluginJournalEntry[];
	diagnostics: PluginPersistenceDiagnostic[];
}

export interface BeginPluginOperationInput {
	id?: string;
	pluginId: string;
	operation: PluginJournalOperation;
	status?: "pending" | "running";
	context?: PluginJournalContext;
}

interface StateFileDocument {
	version: number;
	plugins: Record<string, PluginStateRecord>;
	diagnostics: PluginPersistenceDiagnostic[];
	updatedAt: string;
}

interface JournalFileDocument {
	version: number;
	operations: PluginJournalEntry[];
	diagnostics: PluginPersistenceDiagnostic[];
	updatedAt: string;
}

function createLimits(overrides?: Partial<PluginStateStoreLimits>): PluginStateStoreLimits {
	return {
		maxStateBytes: overrides?.maxStateBytes ?? DEFAULT_MAX_STATE_BYTES,
		maxJournalBytes: overrides?.maxJournalBytes ?? DEFAULT_MAX_JOURNAL_BYTES,
		maxJsonDepth: overrides?.maxJsonDepth ?? DEFAULT_MAX_JSON_DEPTH,
		maxArrayLength: overrides?.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH,
		maxObjectKeys: overrides?.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS,
		maxStringBytes: overrides?.maxStringBytes ?? DEFAULT_MAX_STRING_BYTES,
		maxOperations: overrides?.maxOperations ?? DEFAULT_MAX_OPERATIONS,
		maxDiagnostics: overrides?.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS,
		maxErrorBytes: overrides?.maxErrorBytes ?? DEFAULT_MAX_ERROR_BYTES,
	};
}

function truncateUtf8(value: string, maxBytes: number): string {
	const bytes = new TextEncoder().encode(value);
	if (bytes.byteLength <= maxBytes) return value;
	return new TextDecoder().decode(bytes.slice(0, maxBytes));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function assertJsonLimits(value: unknown, limits: PluginStateStoreLimits): void {
	let objectKeys = 0;
	const visit = (current: unknown, depth: number): void => {
		if (depth > limits.maxJsonDepth) {
			throw new ValidationError(`Plugin metadata exceeds JSON depth ${limits.maxJsonDepth}`);
		}
		if (typeof current === "string") {
			if (Buffer.byteLength(current, "utf8") > limits.maxStringBytes) {
				throw new ValidationError("Plugin metadata contains an oversized string");
			}
			return;
		}
		if (
			current === undefined ||
			current === null ||
			typeof current === "boolean" ||
			(typeof current === "number" && Number.isFinite(current))
		) {
			return;
		}
		if (Array.isArray(current)) {
			if (current.length > limits.maxArrayLength) {
				throw new ValidationError("Plugin metadata contains an oversized array");
			}
			for (const item of current) visit(item, depth + 1);
			return;
		}
		if (!isRecord(current)) throw new ValidationError("Plugin metadata is not JSON-safe");
		const entries = Object.entries(current);
		objectKeys += entries.length;
		if (objectKeys > limits.maxObjectKeys) {
			throw new ValidationError("Plugin metadata contains too many object keys");
		}
		for (const [key, item] of entries) {
			if (Buffer.byteLength(key, "utf8") > limits.maxStringBytes) {
				throw new ValidationError("Plugin metadata contains an oversized object key");
			}
			visit(item, depth + 1);
		}
	};
	visit(value, 0);
}

function parsePackageReference(value: unknown, label: string): PluginPackageReference | null {
	if (value === null) return null;
	if (!isRecord(value)) throw new ValidationError(`${label} is invalid`);
	if (typeof value.version !== "string" || !VERSION_PATTERN.test(value.version)) {
		throw new ValidationError(`${label}.version is invalid`);
	}
	if (typeof value.hash !== "string" || !HASH_PATTERN.test(value.hash)) {
		throw new ValidationError(`${label}.hash is invalid`);
	}
	return { version: value.version, hash: value.hash };
}

function parseAuthorityInstallationId(
	value: unknown,
	current: PluginPackageReference | null,
	pluginId: string,
): string | null {
	// Legacy state files used the immutable package hash directly as the authority identity.
	if (value === undefined) return current?.hash ?? null;
	if (value === null) return null;
	if (
		typeof value !== "string" ||
		!value ||
		value.length > 128 ||
		value !== value.trim() ||
		/[\0\r\n]/u.test(value)
	) {
		throw new ValidationError(`Plugin authority installation id is invalid: ${pluginId}`);
	}
	return value;
}

function parseGrantSummary(value: unknown): PluginGrantSummary {
	if (!isRecord(value)) throw new ValidationError("Plugin grants summary is invalid");
	if (!isNonNegativeInteger(value.count))
		throw new ValidationError("Plugin grant count is invalid");
	if (!isNonNegativeInteger(value.revision)) {
		throw new ValidationError("Plugin grant revision is invalid");
	}
	if (!Array.isArray(value.capabilities) || value.capabilities.length > 512) {
		throw new ValidationError("Plugin grant capabilities are invalid");
	}
	const capabilities = value.capabilities.map((item) => {
		if (typeof item !== "string" || !item || item.length > 200) {
			throw new ValidationError("Plugin grant capability is invalid");
		}
		return item;
	});
	if (new Set(capabilities).size !== capabilities.length) {
		throw new ValidationError("Plugin grant capabilities must be unique");
	}
	if (value.updatedAt !== undefined && !isIsoDate(value.updatedAt)) {
		throw new ValidationError("Plugin grant updatedAt is invalid");
	}
	return {
		count: value.count,
		capabilities,
		revision: value.revision,
		updatedAt: value.updatedAt,
	};
}

function parseError(value: unknown, limits: PluginStateStoreLimits): PluginStateError | null {
	if (value === null) return null;
	if (!isRecord(value)) throw new ValidationError("Plugin error summary is invalid");
	if (typeof value.code !== "string" || !value.code || value.code.length > 128) {
		throw new ValidationError("Plugin error code is invalid");
	}
	if (typeof value.message !== "string" || !value.message) {
		throw new ValidationError("Plugin error message is invalid");
	}
	if (Buffer.byteLength(value.message, "utf8") > limits.maxErrorBytes) {
		throw new ValidationError("Plugin error message exceeds the size limit");
	}
	if (value.phase !== undefined && (typeof value.phase !== "string" || value.phase.length > 128)) {
		throw new ValidationError("Plugin error phase is invalid");
	}
	if (!isIsoDate(value.at)) throw new ValidationError("Plugin error timestamp is invalid");
	return {
		code: value.code,
		message: value.message,
		phase: value.phase,
		at: value.at,
	};
}

function parseStateRecord(
	key: string,
	value: unknown,
	limits: PluginStateStoreLimits,
): PluginStateRecord {
	if (!isRecord(value)) throw new ValidationError(`Plugin state ${key} is invalid`);
	const pluginId = value.pluginId;
	if (
		typeof pluginId !== "string" ||
		!pluginIdSchema.safeParse(pluginId).success ||
		pluginId !== key
	) {
		throw new ValidationError(`Plugin state identity is invalid: ${key}`);
	}
	if (!(DESIRED_STATES as readonly unknown[]).includes(value.desiredState)) {
		throw new ValidationError(`Plugin desired state is invalid: ${pluginId}`);
	}
	if (!(COMPATIBILITY_STATES as readonly unknown[]).includes(value.compatibility)) {
		throw new ValidationError(`Plugin compatibility is invalid: ${pluginId}`);
	}
	if (!(RUNTIME_STATES as readonly unknown[]).includes(value.runtimeState)) {
		throw new ValidationError(`Plugin runtime state is invalid: ${pluginId}`);
	}
	// A `trustTier` written by an older host is deliberately *not* validated here.
	//
	// The field is gone (see `server/lib/plugins/permissions.ts`), and every state.json
	// written before its removal carries one. Validating it would fail-closed on upgrade —
	// and this parser's failure path moves the file aside and starts from an empty document,
	// which would silently drop grants and provider config for every installed plugin. The
	// key is simply dropped on the next write, since the record below is rebuilt field by
	// field rather than spread from the raw input.
	const crashCount = value.crashCount;
	const restartCount = value.restartCount;
	const consecutiveFailures = value.consecutiveFailures;
	const runtimeGeneration = value.runtimeGeneration;
	if (!isNonNegativeInteger(crashCount)) {
		throw new ValidationError(`Plugin crashCount is invalid: ${pluginId}`);
	}
	if (!isNonNegativeInteger(restartCount)) {
		throw new ValidationError(`Plugin restartCount is invalid: ${pluginId}`);
	}
	if (!isNonNegativeInteger(consecutiveFailures)) {
		throw new ValidationError(`Plugin consecutiveFailures is invalid: ${pluginId}`);
	}
	if (!isNonNegativeInteger(runtimeGeneration)) {
		throw new ValidationError(`Plugin runtimeGeneration is invalid: ${pluginId}`);
	}
	if (!isIsoDate(value.createdAt) || !isIsoDate(value.updatedAt)) {
		throw new ValidationError(`Plugin timestamps are invalid: ${pluginId}`);
	}
	const current = parsePackageReference(value.current, `${pluginId}.current`);
	return {
		pluginId,
		current,
		authorityInstallationId: parseAuthorityInstallationId(
			value.authorityInstallationId,
			current,
			pluginId,
		),
		desiredState: value.desiredState as DesiredState,
		compatibility: value.compatibility as CompatibilityState,
		runtimeState: value.runtimeState as RuntimeState,
		grants: parseGrantSummary(value.grants),
		providerConfigs: parseProviderConfigs(value.providerConfigs, pluginId, limits),
		providerPrefixes: parseProviderPrefixes(value.providerPrefixes, pluginId),
		crashCount,
		restartCount,
		consecutiveFailures,
		runtimeGeneration,
		lastError: parseError(value.lastError, limits),
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

/**
 * Read the persisted provider config map.
 *
 * Unlike the lifecycle fields around it, a malformed entry here degrades to "no
 * config" instead of throwing. Rejecting the record would make one bad config value
 * quarantine the whole plugin (and, because `parseState` walks every plugin, risk the
 * entire state file being treated as corrupt). Losing a config the user can retype
 * is strictly better than losing lifecycle state; the authoritative schema check
 * happens in the provider registry on write and on use.
 */
/**
 * Parse prefix overrides, dropping anything the registry would reject anyway.
 *
 * Validating the shape here (not just at write time) matters because the file can be
 * hand-edited: an invalid prefix reaching the registry would fail provider registration
 * for the whole plugin, so a malformed entry is discarded in favour of the manifest
 * value instead.
 */
function parseProviderPrefixes(value: unknown, pluginId: string): PluginProviderPrefixMap {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) {
		logger.warn("Ignoring malformed plugin providerPrefixes", { pluginId });
		return {};
	}
	const result: PluginProviderPrefixMap = {};
	for (const [contributionId, prefix] of Object.entries(value)) {
		if (!contributionId || contributionId.length > 256 || typeof prefix !== "string") {
			logger.warn("Ignoring malformed plugin provider prefix entry", { pluginId, contributionId });
			continue;
		}
		if (!isValidProviderPrefix(prefix)) {
			logger.warn("Ignoring invalid plugin provider prefix", { pluginId, contributionId });
			continue;
		}
		result[contributionId] = prefix;
	}
	return result;
}

/** Mirrors `assertPrefix` in `plugin-provider-registry.ts`. */
export function isValidProviderPrefix(prefix: string): boolean {
	if (prefix.length < 1 || prefix.length > 32) return false;
	if (/[:\s]/u.test(prefix)) return false;
	return [...prefix].every((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint >= 0x21 && codePoint <= 0x7e;
	});
}

function parseProviderConfigs(
	value: unknown,
	pluginId: string,
	limits: PluginStateStoreLimits,
): PluginProviderConfigMap {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) {
		logger.warn("Ignoring malformed plugin providerConfigs", { pluginId });
		return {};
	}
	const result: PluginProviderConfigMap = {};
	for (const [contributionId, config] of Object.entries(value)) {
		if (!contributionId || contributionId.length > 256 || !isRecord(config)) {
			logger.warn("Ignoring malformed plugin provider config entry", { pluginId, contributionId });
			continue;
		}
		try {
			assertJsonLimits(config, limits);
			result[contributionId] = config as Record<string, JsonValue>;
		} catch (error) {
			logger.warn("Ignoring oversized plugin provider config entry", {
				pluginId,
				contributionId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return result;
}

function parseDiagnostic(value: unknown): PluginPersistenceDiagnostic {
	if (!isRecord(value)) throw new ValidationError("Plugin persistence diagnostic is invalid");
	if (typeof value.code !== "string" || !value.code || value.code.length > 128) {
		throw new ValidationError("Plugin persistence diagnostic code is invalid");
	}
	if (typeof value.message !== "string" || !value.message || value.message.length > 4_096) {
		throw new ValidationError("Plugin persistence diagnostic message is invalid");
	}
	if (value.source !== "state" && value.source !== "journal") {
		throw new ValidationError("Plugin persistence diagnostic source is invalid");
	}
	if (typeof value.path !== "string" || !value.path || value.path.length > 4_096) {
		throw new ValidationError("Plugin persistence diagnostic path is invalid");
	}
	if (!isIsoDate(value.detectedAt)) {
		throw new ValidationError("Plugin persistence diagnostic timestamp is invalid");
	}
	if (
		value.recoveryPath !== undefined &&
		(typeof value.recoveryPath !== "string" || value.recoveryPath.length > 4_096)
	) {
		throw new ValidationError("Plugin persistence recovery path is invalid");
	}
	return {
		code: value.code,
		message: value.message,
		source: value.source,
		path: value.path,
		detectedAt: value.detectedAt,
		recoveryPath: value.recoveryPath,
	};
}

function parseJournalContext(value: unknown): PluginJournalContext {
	if (!isRecord(value)) throw new ValidationError("Plugin journal context is invalid");
	const context: PluginJournalContext = {};
	if (value.from !== undefined) context.from = parsePackageReference(value.from, "journal.from");
	if (value.to !== undefined) context.to = parsePackageReference(value.to, "journal.to");
	for (const key of ["phase", "reason", "recoveredAt"] as const) {
		const item = value[key];
		if (item === undefined) continue;
		if (typeof item !== "string" || item.length > 2_048) {
			throw new ValidationError(`Plugin journal ${key} is invalid`);
		}
		context[key] = item;
	}
	if (context.recoveredAt !== undefined && !isIsoDate(context.recoveredAt)) {
		throw new ValidationError("Plugin journal recoveredAt is invalid");
	}
	return context;
}

function isJournalOperation(value: unknown): value is PluginJournalOperation {
	return [
		"install",
		"enable",
		"disable",
		"activate",
		"deactivate",
		"upgrade",
		"rollback",
		"uninstall",
	].includes(String(value));
}

function isJournalStatus(value: unknown): value is PluginJournalStatus {
	return ["pending", "running", "succeeded", "failed", "rolled_back"].includes(String(value));
}

function parseJournalEntry(value: unknown, limits: PluginStateStoreLimits): PluginJournalEntry {
	if (!isRecord(value)) throw new ValidationError("Plugin journal entry is invalid");
	if (typeof value.id !== "string" || !value.id || value.id.length > 128) {
		throw new ValidationError("Plugin journal operation id is invalid");
	}
	if (typeof value.pluginId !== "string" || !pluginIdSchema.safeParse(value.pluginId).success) {
		throw new ValidationError("Plugin journal pluginId is invalid");
	}
	if (!isJournalOperation(value.operation)) {
		throw new ValidationError("Plugin journal operation is invalid");
	}
	if (!isJournalStatus(value.status)) throw new ValidationError("Plugin journal status is invalid");
	if (!isIsoDate(value.startedAt) || !isIsoDate(value.updatedAt)) {
		throw new ValidationError("Plugin journal timestamps are invalid");
	}
	if (value.completedAt !== undefined && !isIsoDate(value.completedAt)) {
		throw new ValidationError("Plugin journal completedAt is invalid");
	}
	return {
		id: value.id,
		pluginId: value.pluginId,
		operation: value.operation,
		status: value.status,
		context: parseJournalContext(value.context),
		error: parseError(value.error, limits),
		startedAt: value.startedAt,
		updatedAt: value.updatedAt,
		completedAt: value.completedAt,
	};
}

function parseStateDocument(value: unknown, limits: PluginStateStoreLimits): StateFileDocument {
	assertJsonLimits(value, limits);
	if (!isRecord(value) || value.version !== STATE_FILE_VERSION || !isRecord(value.plugins)) {
		throw new ValidationError("Plugin state file has an unsupported or invalid format");
	}
	if (!Array.isArray(value.diagnostics) || value.diagnostics.length > limits.maxDiagnostics) {
		throw new ValidationError("Plugin state diagnostics are invalid");
	}
	if (!isIsoDate(value.updatedAt)) throw new ValidationError("Plugin state updatedAt is invalid");
	const plugins: Record<string, PluginStateRecord> = {};
	for (const [pluginId, state] of Object.entries(value.plugins)) {
		plugins[pluginId] = parseStateRecord(pluginId, state, limits);
	}
	return {
		version: STATE_FILE_VERSION,
		plugins,
		diagnostics: value.diagnostics.map(parseDiagnostic),
		updatedAt: value.updatedAt,
	};
}

function parseJournalDocument(value: unknown, limits: PluginStateStoreLimits): JournalFileDocument {
	assertJsonLimits(value, limits);
	if (
		!isRecord(value) ||
		value.version !== JOURNAL_FILE_VERSION ||
		!Array.isArray(value.operations)
	) {
		throw new ValidationError("Plugin journal file has an unsupported or invalid format");
	}
	if (value.operations.length > limits.maxOperations) {
		throw new ValidationError("Plugin journal contains too many operations");
	}
	if (!Array.isArray(value.diagnostics) || value.diagnostics.length > limits.maxDiagnostics) {
		throw new ValidationError("Plugin journal diagnostics are invalid");
	}
	if (!isIsoDate(value.updatedAt)) throw new ValidationError("Plugin journal updatedAt is invalid");
	const operations = value.operations.map((entry) => parseJournalEntry(entry, limits));
	if (new Set(operations.map((entry) => entry.id)).size !== operations.length) {
		throw new ValidationError("Plugin journal operation ids must be unique");
	}
	return {
		version: JOURNAL_FILE_VERSION,
		operations,
		diagnostics: value.diagnostics.map(parseDiagnostic),
		updatedAt: value.updatedAt,
	};
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function terminalJournalStatus(status: PluginJournalStatus): boolean {
	return status === "succeeded" || status === "failed" || status === "rolled_back";
}

export function createPluginStateRecord(
	pluginId: string,
	now = new Date().toISOString(),
): PluginStateRecord {
	if (!pluginIdSchema.safeParse(pluginId).success) throw new ValidationError("Invalid pluginId");
	return {
		pluginId,
		current: null,
		authorityInstallationId: null,
		desiredState: "disabled",
		compatibility: "unknown",
		runtimeState: "inactive",
		grants: { count: 0, capabilities: [], revision: 0 },
		providerConfigs: {},
		providerPrefixes: {},
		crashCount: 0,
		restartCount: 0,
		consecutiveFailures: 0,
		runtimeGeneration: 0,
		lastError: null,
		createdAt: now,
		updatedAt: now,
	};
}

export function pluginStateError(
	error: unknown,
	options: { code?: string; phase?: string; at?: string; maxBytes?: number } = {},
): PluginStateError {
	const source = error instanceof Error ? error : new Error(String(error));
	const sourceCode = (source as Error & { code?: unknown }).code;
	const code =
		options.code ?? (typeof sourceCode === "string" ? sourceCode : "PLUGIN_OPERATION_FAILED");
	return {
		code: truncateUtf8(code, 128),
		message: truncateUtf8(
			source.message || source.name,
			options.maxBytes ?? DEFAULT_MAX_ERROR_BYTES,
		),
		phase: options.phase ? truncateUtf8(options.phase, 128) : undefined,
		at: options.at ?? new Date().toISOString(),
	};
}

/**
 * Host-owned JSON state and lifecycle journal. Files are never plugin-writable,
 * are atomically replaced with mode 0600, and recover corrupt input by moving
 * the raw file aside before creating a fail-closed empty document.
 */
export class PluginStateStore {
	readonly root: string;
	readonly statePath: string;
	readonly journalPath: string;
	readonly limits: PluginStateStoreLimits;
	private readonly renameFile: (from: string, to: string) => Promise<void>;
	private readonly now: () => Date;
	private readonly mutex = new AsyncMutex();
	private stateDocument?: StateFileDocument;
	private journalDocument?: JournalFileDocument;

	constructor(rootOrOptions: string | PluginStateStoreOptions = {}) {
		const options = typeof rootOrOptions === "string" ? { root: rootOrOptions } : rootOrOptions;
		this.root = resolve(options.root ?? getNarraforkPath("plugins"));
		this.statePath = join(this.root, options.stateFileName ?? "state.json");
		this.journalPath = join(this.root, options.journalFileName ?? "journal.json");
		this.limits = createLimits(options.limits);
		this.renameFile = options.renameFile ?? rename;
		this.now = options.now ?? (() => new Date());
	}

	async initialize(): Promise<PluginStateStoreSnapshot> {
		await this.mutex.acquire("store", async () => {
			await this.ensureLoadedLocked();
		});
		return this.snapshot();
	}

	async get(pluginId: string): Promise<PluginStateRecord | undefined> {
		return this.getState(pluginId);
	}

	async getState(pluginId: string): Promise<PluginStateRecord | undefined> {
		await this.ensureLoaded();
		const state = this.stateDocument?.plugins[pluginId];
		return state ? clone(state) : undefined;
	}

	/**
	 * Read already-loaded state without awaiting a load.
	 *
	 * Returns `undefined` before the first load completes, so callers must treat a miss
	 * as "unknown", never as "absent". This exists for synchronous paths — notably
	 * provider registration inside the contribution-refresh critical section — that
	 * cannot await. Every mutation keeps `stateDocument` current, so after startup this
	 * reflects the persisted document.
	 */
	getCachedState(pluginId: string): PluginStateRecord | undefined {
		const state = this.stateDocument?.plugins[pluginId];
		return state ? clone(state) : undefined;
	}

	async list(): Promise<PluginStateRecord[]> {
		return this.listStates();
	}

	async listStates(): Promise<PluginStateRecord[]> {
		await this.ensureLoaded();
		return Object.values(this.stateDocument?.plugins ?? {})
			.sort((left, right) => left.pluginId.localeCompare(right.pluginId))
			.map(clone);
	}

	async upsert(state: PluginStateRecord): Promise<PluginStateRecord> {
		return this.setState(state);
	}

	async setState(state: PluginStateRecord): Promise<PluginStateRecord> {
		return this.mutex.acquire("store", async () => {
			await this.ensureLoadedLocked();
			const candidate = clone(this.requireStateDocument());
			const parsed = parseStateRecord(state.pluginId, state, this.limits);
			candidate.plugins[state.pluginId] = parsed;
			candidate.updatedAt = this.timestamp();
			await this.writeStateLocked(candidate);
			this.stateDocument = candidate;
			return clone(parsed);
		});
	}

	async updateState(
		pluginId: string,
		update:
			| Partial<Omit<PluginStateRecord, "pluginId" | "createdAt" | "updatedAt">>
			| ((state: PluginStateRecord) => PluginStateRecord),
	): Promise<PluginStateRecord> {
		return this.mutex.acquire("store", async () => {
			await this.ensureLoadedLocked();
			const candidate = clone(this.requireStateDocument());
			const timestamp = this.timestamp();
			const current = clone(
				candidate.plugins[pluginId] ?? createPluginStateRecord(pluginId, timestamp),
			);
			const next =
				typeof update === "function"
					? update(current)
					: {
							...current,
							...clone(update),
							pluginId,
							createdAt: current.createdAt,
							updatedAt: timestamp,
						};
			next.pluginId = pluginId;
			next.createdAt = current.createdAt;
			next.updatedAt = timestamp;
			const parsed = parseStateRecord(pluginId, next, this.limits);
			candidate.plugins[pluginId] = parsed;
			candidate.updatedAt = timestamp;
			await this.writeStateLocked(candidate);
			this.stateDocument = candidate;
			return clone(parsed);
		});
	}

	/**
	 * Replace the stored config for one provider contribution.
	 *
	 * Passing `null` removes the entry, which is how config is cleaned up when a plugin
	 * stops contributing that provider.
	 *
	 * This does not validate against the provider's schema — the caller must have done
	 * that through the provider registry, which owns the schema. Only structural JSON
	 * limits are enforced here.
	 */
	async setProviderConfig(
		pluginId: string,
		contributionId: string,
		config: Record<string, JsonValue> | null,
	): Promise<PluginStateRecord> {
		if (!contributionId || contributionId.length > 256) {
			throw new ValidationError("Provider contribution id is invalid");
		}
		if (config !== null) assertJsonLimits(config, this.limits);
		return this.updateState(pluginId, (current) => {
			const providerConfigs = { ...current.providerConfigs };
			if (config === null) delete providerConfigs[contributionId];
			else providerConfigs[contributionId] = clone(config);
			return { ...current, providerConfigs };
		});
	}

	/**
	 * Set or clear one provider's prefix override.
	 *
	 * Passing `null` reverts to the manifest prefix. Validation happens here as well as
	 * in the registry, so an invalid value never reaches disk where a later load would
	 * have to discard it.
	 */
	async setProviderPrefix(
		pluginId: string,
		contributionId: string,
		prefix: string | null,
	): Promise<PluginStateRecord> {
		if (!contributionId || contributionId.length > 256) {
			throw new ValidationError("Provider contribution id is invalid");
		}
		if (prefix !== null && !isValidProviderPrefix(prefix)) {
			throw new ValidationError(
				"Provider prefix must be 1-32 visible ASCII characters without colon or whitespace",
			);
		}
		return this.updateState(pluginId, (current) => {
			const providerPrefixes = { ...current.providerPrefixes };
			if (prefix === null) delete providerPrefixes[contributionId];
			else providerPrefixes[contributionId] = prefix;
			return { ...current, providerPrefixes };
		});
	}

	/** Drop stored config for provider contributions the plugin no longer declares. */
	async pruneProviderConfigs(
		pluginId: string,
		keepContributionIds: readonly string[],
	): Promise<PluginStateRecord> {
		const keep = new Set(keepContributionIds);
		return this.updateState(pluginId, (current) => {
			const providerConfigs: PluginProviderConfigMap = {};
			for (const [contributionId, config] of Object.entries(current.providerConfigs)) {
				if (keep.has(contributionId)) providerConfigs[contributionId] = config;
			}
			const providerPrefixes: PluginProviderPrefixMap = {};
			for (const [contributionId, prefix] of Object.entries(current.providerPrefixes)) {
				if (keep.has(contributionId)) providerPrefixes[contributionId] = prefix;
			}
			return { ...current, providerConfigs, providerPrefixes };
		});
	}

	/** Update only the bounded grant summary mirrored into the lifecycle state file. */
	async updateGrantSummary(
		pluginId: string,
		summary: PluginGrantSummaryUpdate,
	): Promise<PluginStateRecord> {
		if (!isNonNegativeInteger(summary.count)) {
			throw new ValidationError("Plugin grant summary count is invalid");
		}
		if (!isNonNegativeInteger(summary.revision)) {
			throw new ValidationError("Plugin grant summary revision is invalid");
		}
		if (!Array.isArray(summary.capabilities) || summary.capabilities.length > 512) {
			throw new ValidationError("Plugin grant summary capabilities are invalid");
		}
		return this.updateState(pluginId, {
			grants: {
				count: summary.count,
				capabilities: [...summary.capabilities],
				revision: summary.revision,
				updatedAt: summary.updatedAt ?? this.timestamp(),
			},
		});
	}

	async replaceStates(states: PluginStateRecord[]): Promise<void> {
		await this.mutex.acquire("store", async () => {
			await this.ensureLoadedLocked();
			const candidate = clone(this.requireStateDocument());
			const plugins: Record<string, PluginStateRecord> = {};
			for (const state of states) {
				if (plugins[state.pluginId]) throw new ValidationError("Duplicate plugin state");
				plugins[state.pluginId] = parseStateRecord(state.pluginId, state, this.limits);
			}
			candidate.plugins = plugins;
			candidate.updatedAt = this.timestamp();
			await this.writeStateLocked(candidate);
			this.stateDocument = candidate;
		});
	}

	async remove(pluginId: string): Promise<boolean> {
		return this.removeState(pluginId);
	}

	async removeState(pluginId: string): Promise<boolean> {
		return this.mutex.acquire("store", async () => {
			await this.ensureLoadedLocked();
			const candidate = clone(this.requireStateDocument());
			if (!candidate.plugins[pluginId]) return false;
			delete candidate.plugins[pluginId];
			candidate.updatedAt = this.timestamp();
			await this.writeStateLocked(candidate);
			this.stateDocument = candidate;
			return true;
		});
	}

	async beginOperation(input: BeginPluginOperationInput): Promise<PluginJournalEntry> {
		return this.mutex.acquire("store", async () => {
			await this.ensureLoadedLocked();
			const candidate = clone(this.requireJournalDocument());
			if (!pluginIdSchema.safeParse(input.pluginId).success) {
				throw new ValidationError("Invalid pluginId for journal operation");
			}
			if (!isJournalOperation(input.operation))
				throw new ValidationError("Invalid journal operation");
			const now = this.timestamp();
			const entry = parseJournalEntry(
				{
					id: input.id ?? `plugin_op_${generateShortId(16)}`,
					pluginId: input.pluginId,
					operation: input.operation,
					status: input.status ?? "pending",
					context: input.context ?? {},
					error: null,
					startedAt: now,
					updatedAt: now,
				},
				this.limits,
			);
			if (candidate.operations.some((item) => item.id === entry.id)) {
				throw new ValidationError(`Plugin journal operation already exists: ${entry.id}`);
			}
			candidate.operations.push(entry);
			this.compactJournalLocked(candidate);
			candidate.updatedAt = now;
			await this.writeJournalLocked(candidate);
			this.journalDocument = candidate;
			return clone(entry);
		});
	}

	async updateOperation(
		operationId: string,
		patch: {
			status?: PluginJournalStatus;
			context?: PluginJournalContext;
			error?: PluginStateError | null;
		},
	): Promise<PluginJournalEntry> {
		return this.mutex.acquire("store", async () => {
			await this.ensureLoadedLocked();
			const candidate = clone(this.requireJournalDocument());
			const index = candidate.operations.findIndex((item) => item.id === operationId);
			if (index < 0)
				throw new ValidationError(`Plugin journal operation not found: ${operationId}`);
			const current = candidate.operations[index];
			const now = this.timestamp();
			const status = patch.status ?? current.status;
			if (!isJournalStatus(status)) throw new ValidationError("Invalid plugin journal status");
			const next = parseJournalEntry(
				{
					...current,
					status,
					context: patch.context ? { ...current.context, ...patch.context } : current.context,
					error: patch.error === undefined ? current.error : patch.error,
					updatedAt: now,
					completedAt: terminalJournalStatus(status) ? (current.completedAt ?? now) : undefined,
				},
				this.limits,
			);
			candidate.operations[index] = next;
			candidate.updatedAt = now;
			await this.writeJournalLocked(candidate);
			this.journalDocument = candidate;
			return clone(next);
		});
	}

	async getOperation(operationId: string): Promise<PluginJournalEntry | undefined> {
		await this.ensureLoaded();
		const operation = this.journalDocument?.operations.find((item) => item.id === operationId);
		return operation ? clone(operation) : undefined;
	}

	async listOperations(pluginId?: string): Promise<PluginJournalEntry[]> {
		await this.ensureLoaded();
		return (this.journalDocument?.operations ?? [])
			.filter((entry) => pluginId === undefined || entry.pluginId === pluginId)
			.sort((left, right) => left.startedAt.localeCompare(right.startedAt))
			.map(clone);
	}

	async listIncompleteOperations(pluginId?: string): Promise<PluginJournalEntry[]> {
		return (await this.listOperations(pluginId)).filter(
			(entry) => !terminalJournalStatus(entry.status),
		);
	}

	async getDiagnostics(): Promise<PluginPersistenceDiagnostic[]> {
		await this.ensureLoaded();
		return [
			...(this.stateDocument?.diagnostics ?? []),
			...(this.journalDocument?.diagnostics ?? []),
		].map(clone);
	}

	private async snapshot(): Promise<PluginStateStoreSnapshot> {
		return {
			states: await this.listStates(),
			operations: await this.listOperations(),
			diagnostics: await this.getDiagnostics(),
		};
	}

	private timestamp(): string {
		return this.now().toISOString();
	}

	private async ensureLoaded(): Promise<void> {
		if (this.stateDocument && this.journalDocument) return;
		await this.mutex.acquire("store", async () => this.ensureLoadedLocked());
	}

	private async ensureLoadedLocked(): Promise<void> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		if (!this.stateDocument) {
			this.stateDocument = await this.loadStateDocument();
		}
		if (!this.journalDocument) {
			this.journalDocument = await this.loadJournalDocument();
		}
	}

	private requireStateDocument(): StateFileDocument {
		if (!this.stateDocument) throw new Error("Plugin state store is not initialized");
		return this.stateDocument;
	}

	private requireJournalDocument(): JournalFileDocument {
		if (!this.journalDocument) throw new Error("Plugin journal store is not initialized");
		return this.journalDocument;
	}

	private emptyStateDocument(diagnostics: PluginPersistenceDiagnostic[] = []): StateFileDocument {
		return {
			version: STATE_FILE_VERSION,
			plugins: {},
			diagnostics,
			updatedAt: this.timestamp(),
		};
	}

	private emptyJournalDocument(
		diagnostics: PluginPersistenceDiagnostic[] = [],
	): JournalFileDocument {
		return {
			version: JOURNAL_FILE_VERSION,
			operations: [],
			diagnostics,
			updatedAt: this.timestamp(),
		};
	}

	private async loadStateDocument(): Promise<StateFileDocument> {
		try {
			const parsed = parseStateDocument(
				await this.readJsonFile(this.statePath, this.limits.maxStateBytes),
				this.limits,
			);
			await chmod(this.statePath, 0o600);
			return parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.emptyStateDocument();
			const diagnostic = await this.recoverCorruptFile("state", this.statePath, error);
			const document = this.emptyStateDocument([diagnostic]);
			await this.atomicWrite(this.statePath, document, this.limits.maxStateBytes);
			return document;
		}
	}

	private async loadJournalDocument(): Promise<JournalFileDocument> {
		try {
			const parsed = parseJournalDocument(
				await this.readJsonFile(this.journalPath, this.limits.maxJournalBytes),
				this.limits,
			);
			await chmod(this.journalPath, 0o600);
			return parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.emptyJournalDocument();
			const diagnostic = await this.recoverCorruptFile("journal", this.journalPath, error);
			const document = this.emptyJournalDocument([diagnostic]);
			await this.atomicWrite(this.journalPath, document, this.limits.maxJournalBytes);
			return document;
		}
	}

	private async readJsonFile(path: string, maxBytes: number): Promise<unknown> {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink()) {
			throw new ValidationError(`${basename(path)} is not a regular host-owned file`);
		}
		if (info.size > maxBytes) throw new ValidationError(`${basename(path)} exceeds its size limit`);
		const bytes = await readFile(path);
		if (bytes.byteLength > maxBytes) {
			throw new ValidationError(`${basename(path)} exceeds its size limit`);
		}
		try {
			return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
		} catch (error) {
			throw new ValidationError(
				`${basename(path)} is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async recoverCorruptFile(
		source: "state" | "journal",
		path: string,
		error: unknown,
	): Promise<PluginPersistenceDiagnostic> {
		const detectedAt = this.timestamp();
		const recoveryPath = `${path}.corrupt-${detectedAt.replace(/[:.]/g, "-")}-${generateShortId(6)}`;
		let preservedPath: string | undefined;
		try {
			await rename(path, recoveryPath);
			await chmod(recoveryPath, 0o600).catch(() => undefined);
			preservedPath = recoveryPath;
		} catch (preserveError) {
			logger.error("Unable to preserve corrupt plugin metadata file", {
				source,
				path,
				error: preserveError instanceof Error ? preserveError.message : String(preserveError),
			});
		}
		const message = truncateUtf8(
			error instanceof Error ? error.message : String(error),
			this.limits.maxErrorBytes,
		);
		logger.error("Plugin metadata file is corrupt; recovering fail-closed", {
			source,
			path,
			recoveryPath: preservedPath,
			error: message,
		});
		return {
			code: source === "state" ? "PLUGIN_STATE_CORRUPT" : "PLUGIN_JOURNAL_CORRUPT",
			message,
			source,
			path,
			detectedAt,
			recoveryPath: preservedPath,
		};
	}

	private compactJournalLocked(document: JournalFileDocument): void {
		const operations = document.operations;
		if (operations.length <= this.limits.maxOperations) return;
		const incomplete = operations.filter((entry) => !terminalJournalStatus(entry.status));
		if (incomplete.length > this.limits.maxOperations) {
			throw new ValidationError("Plugin journal has too many incomplete operations");
		}
		const terminal = operations
			.filter((entry) => terminalJournalStatus(entry.status))
			.slice(-(this.limits.maxOperations - incomplete.length));
		document.operations = [...incomplete, ...terminal].sort((left, right) =>
			left.startedAt.localeCompare(right.startedAt),
		);
	}

	private async writeStateLocked(document: StateFileDocument): Promise<void> {
		document.diagnostics = document.diagnostics.slice(-this.limits.maxDiagnostics);
		await this.atomicWrite(this.statePath, document, this.limits.maxStateBytes);
	}

	private async writeJournalLocked(document: JournalFileDocument): Promise<void> {
		document.diagnostics = document.diagnostics.slice(-this.limits.maxDiagnostics);
		await this.atomicWrite(this.journalPath, document, this.limits.maxJournalBytes);
	}

	private async atomicWrite(path: string, value: unknown, maxBytes: number): Promise<void> {
		assertJsonLimits(value, this.limits);
		const json = `${JSON.stringify(value, null, 2)}\n`;
		if (Buffer.byteLength(json, "utf8") > maxBytes) {
			throw new ValidationError(`${basename(path)} exceeds its size limit`);
		}
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const temporaryPath = join(this.root, `.${basename(path)}.${generateShortId(10)}.tmp`);
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(temporaryPath, "wx", 0o600);
			await handle.writeFile(json, { encoding: "utf8" });
			await handle.chmod(0o600);
			await handle.sync();
			await handle.close();
			handle = undefined;
			await this.renameFile(temporaryPath, path);
			await this.syncDirectory();
		} catch (error) {
			await handle?.close().catch(() => undefined);
			await rm(temporaryPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	private async syncDirectory(): Promise<void> {
		let directory: Awaited<ReturnType<typeof open>> | undefined;
		try {
			directory = await open(this.root, "r");
			await directory.sync();
		} catch {
			// Directory fsync is unavailable on some supported platforms.
		} finally {
			await directory?.close().catch(() => undefined);
		}
	}
}

export const pluginStateStore = new PluginStateStore();
