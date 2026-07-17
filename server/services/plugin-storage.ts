import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { AsyncMutex } from "@server/lib/async-mutex";
import { AppError, ValidationError } from "@server/lib/errors";
import { generateShortId } from "@server/lib/id";
import { getNarraforkPath } from "@server/lib/narrafork-home";
import { pluginIdSchema } from "@server/lib/plugins/manifest";

const STORAGE_FILE_VERSION = 1;
const DEFAULT_MAX_VALUE_BYTES = 64 * 1024;
const DEFAULT_MAX_SCOPE_BYTES = 1024 * 1024;
const DEFAULT_MAX_PLUGIN_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES_PER_SCOPE = 1_000;
const DEFAULT_MAX_ENTRIES_PER_PLUGIN = 10_000;
const DEFAULT_MAX_JSON_DEPTH = 12;
const DEFAULT_MAX_ARRAY_LENGTH = 2_048;
const DEFAULT_MAX_OBJECT_KEYS = 4_096;
const DEFAULT_MAX_STRING_BYTES = 16 * 1024;
const DEFAULT_MAX_KEY_BYTES = 256;
const DEFAULT_MAX_FILE_BYTES = DEFAULT_MAX_PLUGIN_BYTES + 512 * 1024;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const MAX_CURSOR_BYTES = 4 * 1024;
const MAX_DIAGNOSTICS = 20;

export const PLUGIN_STORAGE_SCOPE_TYPES = [
	"global",
	"session",
	"user",
	"project",
	"workspace",
	"chapter",
	"narrator",
	"provider",
	"device",
] as const;
export type PluginStorageScopeType = (typeof PLUGIN_STORAGE_SCOPE_TYPES)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface PluginStorageScope {
	type: PluginStorageScopeType;
	id?: string;
}

export type PluginStorageScopeInput =
	| PluginStorageScope
	| { scopeType: PluginStorageScopeType; scopeId?: string };

export interface PluginStorageLimits {
	maxValueBytes: number;
	maxScopeBytes: number;
	maxPluginBytes: number;
	maxEntriesPerScope: number;
	maxEntriesPerPlugin: number;
	maxJsonDepth: number;
	maxArrayLength: number;
	maxObjectKeys: number;
	maxStringBytes: number;
	maxKeyBytes: number;
	maxFileBytes: number;
}

export interface PluginStorageEntry<T extends JsonValue = JsonValue> {
	pluginId: string;
	scope: PluginStorageScope;
	key: string;
	value: T;
	valueBytes: number;
	revision: number;
	createdAt: string;
	updatedAt: string;
}

export interface PluginStorageListItem {
	pluginId: string;
	scope: PluginStorageScope;
	key: string;
	valueBytes: number;
	revision: number;
	updatedAt: string;
}

export interface PluginStorageListResult {
	items: PluginStorageListItem[];
	hasMore: boolean;
	nextCursor?: string;
}

export interface PluginStorageQuota {
	pluginId: string;
	scope: PluginStorageScope;
	entries: number;
	bytes: number;
	maxEntries: number;
	maxBytes: number;
	pluginEntries: number;
	pluginBytes: number;
	maxPluginEntries: number;
	maxPluginBytes: number;
}

export type PluginStorageLimitsOptions = Partial<PluginStorageLimits>;

export interface PluginStorageOptions {
	pluginId: string;
	root?: string;
	limits?: PluginStorageLimitsOptions;
	now?: () => Date;
	/** Injectable only for atomic-write failure tests. */
	renameFile?: (from: string, to: string) => Promise<void>;
	/** Optional host-owned value schema. It must not mutate the value. */
	validateValue?: (input: {
		pluginId: string;
		scope: PluginStorageScope;
		key: string;
		value: JsonValue;
	}) => undefined | boolean | Promise<undefined | boolean>;
	valueSchema?: {
		safeParse(value: unknown): { success: boolean; error?: unknown };
	};
}

export interface PluginStorageGetInput {
	scope?: PluginStorageScopeInput;
	scopeType?: PluginStorageScopeType;
	scopeId?: string;
	key: string;
}

export interface PluginStorageSetInput extends PluginStorageGetInput {
	value: unknown;
	expectedRevision?: number;
}

export interface PluginStorageDeleteInput extends PluginStorageGetInput {
	expectedRevision?: number;
}

export interface PluginStorageListInput {
	scope?: PluginStorageScopeInput;
	scopeType?: PluginStorageScopeType;
	scopeId?: string;
	prefix?: string;
	cursor?: string;
	limit?: number;
}

export interface PluginStoragePurgeInput {
	scope?: PluginStorageScopeInput;
	scopeType?: PluginStorageScopeType;
	scopeId?: string;
}

interface StoredEntry {
	key: string;
	value: JsonValue;
	valueBytes: number;
	revision: number;
	createdAt: string;
	updatedAt: string;
}

interface StorageFileDocument {
	version: number;
	pluginId: string;
	scopes: Record<string, Record<string, StoredEntry>>;
	diagnostics: Array<{ code: string; message: string; detectedAt: string }>;
	updatedAt: string;
}

interface CursorDocument {
	version: 1;
	pluginId: string;
	scopeKey: string;
	prefix: string;
	after: string;
}

export type PluginStorageErrorReason =
	| "INVALID_SCOPE"
	| "INVALID_KEY"
	| "INVALID_JSON"
	| "SCHEMA_REJECTED"
	| "VALUE_TOO_LARGE"
	| "QUOTA_EXCEEDED"
	| "REVISION_CONFLICT"
	| "INVALID_CURSOR"
	| "PLUGIN_NAMESPACE_MISMATCH"
	| "CORRUPT_STORE";

export class PluginStorageError extends AppError {
	readonly reason: PluginStorageErrorReason;

	constructor(code: string, reason: PluginStorageErrorReason, message: string, statusCode = 400) {
		super(message, statusCode, code);
		this.name = "PluginStorageError";
		this.reason = reason;
	}
}

const pluginStorageMutex = new AsyncMutex();

function createLimits(overrides?: PluginStorageLimitsOptions): PluginStorageLimits {
	const limits = {
		maxValueBytes: overrides?.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES,
		maxScopeBytes: overrides?.maxScopeBytes ?? DEFAULT_MAX_SCOPE_BYTES,
		maxPluginBytes: overrides?.maxPluginBytes ?? DEFAULT_MAX_PLUGIN_BYTES,
		maxEntriesPerScope: overrides?.maxEntriesPerScope ?? DEFAULT_MAX_ENTRIES_PER_SCOPE,
		maxEntriesPerPlugin: overrides?.maxEntriesPerPlugin ?? DEFAULT_MAX_ENTRIES_PER_PLUGIN,
		maxJsonDepth: overrides?.maxJsonDepth ?? DEFAULT_MAX_JSON_DEPTH,
		maxArrayLength: overrides?.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH,
		maxObjectKeys: overrides?.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS,
		maxStringBytes: overrides?.maxStringBytes ?? DEFAULT_MAX_STRING_BYTES,
		maxKeyBytes: overrides?.maxKeyBytes ?? DEFAULT_MAX_KEY_BYTES,
		maxFileBytes: overrides?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
	};
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value <= 0)
			throw new ValidationError(`Plugin storage limit ${name} must be a positive integer`);
	}
	if (limits.maxScopeBytes > limits.maxPluginBytes) {
		throw new ValidationError("Plugin storage scope quota cannot exceed plugin quota");
	}
	return limits;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function timestamp(now: () => Date): string {
	return now().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint < 0x20 || codePoint === 0x7f) return true;
	}
	return false;
}

function assertJsonValue(value: unknown, limits: PluginStorageLimits): asserts value is JsonValue {
	const seen = new WeakSet<object>();
	let objectKeys = 0;
	const visit = (current: unknown, depth: number): void => {
		if (depth > limits.maxJsonDepth) {
			throw new PluginStorageError(
				"INVALID_PARAMS",
				"INVALID_JSON",
				`Plugin storage JSON exceeds depth ${limits.maxJsonDepth}`,
			);
		}
		if (current === null || typeof current === "boolean") return;
		if (typeof current === "string") {
			if (Buffer.byteLength(current, "utf8") > limits.maxStringBytes) {
				throw new PluginStorageError(
					"PAYLOAD_TOO_LARGE",
					"INVALID_JSON",
					"Plugin storage contains an oversized string",
					413,
				);
			}
			return;
		}
		if (typeof current === "number") {
			if (!Number.isFinite(current)) {
				throw new PluginStorageError(
					"INVALID_PARAMS",
					"INVALID_JSON",
					"Plugin storage number is invalid",
				);
			}
			return;
		}
		if (typeof current !== "object" || current === undefined) {
			throw new PluginStorageError(
				"INVALID_PARAMS",
				"INVALID_JSON",
				"Plugin storage value must be JSON-compatible",
			);
		}
		if (seen.has(current)) {
			throw new PluginStorageError(
				"INVALID_PARAMS",
				"INVALID_JSON",
				"Plugin storage value is cyclic",
			);
		}
		seen.add(current);
		try {
			if (Array.isArray(current)) {
				if (current.length > limits.maxArrayLength) {
					throw new PluginStorageError(
						"PAYLOAD_TOO_LARGE",
						"INVALID_JSON",
						"Plugin storage contains an oversized array",
						413,
					);
				}
				for (const item of current) visit(item, depth + 1);
				return;
			}
			const prototype = Object.getPrototypeOf(current);
			if (prototype !== Object.prototype && prototype !== null) {
				throw new PluginStorageError(
					"INVALID_PARAMS",
					"INVALID_JSON",
					"Plugin storage value must contain plain objects",
				);
			}
			const entries = Object.entries(current);
			objectKeys += entries.length;
			if (objectKeys > limits.maxObjectKeys) {
				throw new PluginStorageError(
					"PAYLOAD_TOO_LARGE",
					"INVALID_JSON",
					"Plugin storage contains too many object keys",
					413,
				);
			}
			for (const [key, item] of entries) {
				if (key === "__proto__" || key === "prototype" || key === "constructor") {
					throw new PluginStorageError(
						"INVALID_PARAMS",
						"INVALID_JSON",
						"Plugin storage contains a reserved object key",
					);
				}
				if (Buffer.byteLength(key, "utf8") > limits.maxStringBytes || hasControlCharacters(key)) {
					throw new PluginStorageError(
						"INVALID_PARAMS",
						"INVALID_JSON",
						"Plugin storage object key is invalid",
					);
				}
				visit(item, depth + 1);
			}
		} finally {
			seen.delete(current);
		}
	};
	visit(value, 0);
}

function jsonBytes(value: JsonValue): number {
	const json = JSON.stringify(value);
	if (json === undefined)
		throw new PluginStorageError("INVALID_PARAMS", "INVALID_JSON", "Value is not JSON");
	return Buffer.byteLength(json, "utf8");
}

function parsePluginId(pluginId: string): string {
	if (!pluginIdSchema.safeParse(pluginId).success) throw new ValidationError("Invalid pluginId");
	return pluginId;
}

function parseScope(scope: PluginStorageScopeInput): PluginStorageScope {
	if (!isRecord(scope))
		throw new PluginStorageError("INVALID_PARAMS", "INVALID_SCOPE", "Invalid storage scope");
	const record = scope as Record<string, unknown>;
	const isShort = "type" in record;
	const allowedKeys = isShort ? ["type", "id"] : ["scopeType", "scopeId"];
	if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
		throw new PluginStorageError(
			"INVALID_PARAMS",
			"INVALID_SCOPE",
			"Storage scope has unknown fields",
		);
	}
	const type = isShort ? record.type : record.scopeType;
	const id = isShort ? record.id : record.scopeId;
	if (!(PLUGIN_STORAGE_SCOPE_TYPES as readonly unknown[]).includes(type)) {
		throw new PluginStorageError("INVALID_PARAMS", "INVALID_SCOPE", "Invalid storage scope type");
	}
	if (type === "global" && id !== undefined) {
		throw new PluginStorageError(
			"INVALID_PARAMS",
			"INVALID_SCOPE",
			"Global storage scope cannot have an id",
		);
	}
	if (type !== "global") {
		if (typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 128) {
			throw new PluginStorageError(
				"INVALID_PARAMS",
				"INVALID_SCOPE",
				"Storage scope id is invalid",
			);
		}
		if (hasControlCharacters(id)) {
			throw new PluginStorageError(
				"INVALID_PARAMS",
				"INVALID_SCOPE",
				"Storage scope id contains control characters",
			);
		}
	}
	return type === "global"
		? { type: type as PluginStorageScopeType }
		: { type: type as PluginStorageScopeType, id: id as string };
}

function resolveScope(input: {
	scope?: PluginStorageScopeInput;
	scopeType?: PluginStorageScopeType;
	scopeId?: string;
}): PluginStorageScope {
	if (input.scope !== undefined) {
		if (input.scopeType !== undefined || input.scopeId !== undefined) {
			throw new PluginStorageError(
				"INVALID_PARAMS",
				"INVALID_SCOPE",
				"Storage scope was specified twice",
			);
		}
		return parseScope(input.scope);
	}
	if (input.scopeType === undefined) {
		throw new PluginStorageError("INVALID_PARAMS", "INVALID_SCOPE", "Storage scope is required");
	}
	return parseScope({ type: input.scopeType, id: input.scopeId });
}

function scopeKey(scope: PluginStorageScope): string {
	return `${scope.type}\u0000${scope.id ?? ""}`;
}

function cloneScope(scope: PluginStorageScope): PluginStorageScope {
	return scope.id === undefined ? { type: scope.type } : { type: scope.type, id: scope.id };
}

function assertOperationFields(
	record: Record<string, unknown>,
	allowed: readonly string[],
	label: string,
): void {
	if (Object.keys(record).some((key) => !allowed.includes(key))) {
		throw new PluginStorageError(
			"INVALID_PARAMS",
			"PLUGIN_NAMESPACE_MISMATCH",
			`${label} contains unknown fields`,
		);
	}
}

function assertKey(
	key: unknown,
	limits: PluginStorageLimits,
	allowEmpty = false,
): asserts key is string {
	if (typeof key !== "string" || (!allowEmpty && key.length === 0)) {
		throw new PluginStorageError("INVALID_PARAMS", "INVALID_KEY", "Storage key is required");
	}
	if (Buffer.byteLength(key, "utf8") > limits.maxKeyBytes || hasControlCharacters(key)) {
		throw new PluginStorageError(
			"INVALID_PARAMS",
			"INVALID_KEY",
			"Storage key exceeds its byte limit",
		);
	}
	if (key !== key.trim() || key.split("/").some((part) => part === "." || part === "..")) {
		throw new PluginStorageError(
			"INVALID_PARAMS",
			"INVALID_KEY",
			"Storage key contains an unsafe segment",
		);
	}
	if (key.startsWith("__narrafork") || key.startsWith("narrafork.")) {
		throw new PluginStorageError(
			"INVALID_PARAMS",
			"INVALID_KEY",
			"Storage key uses a reserved prefix",
		);
	}
}

function cloneStoredEntry(
	entry: StoredEntry,
	pluginId: string,
	scope: PluginStorageScope,
): PluginStorageEntry {
	return {
		pluginId,
		scope: cloneScope(scope),
		key: entry.key,
		value: clone(entry.value),
		valueBytes: entry.valueBytes,
		revision: entry.revision,
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
	};
}

function encodeCursor(cursor: CursorDocument): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(
	value: string | undefined,
	pluginId: string,
	scope: PluginStorageScope,
	prefix: string,
): string | undefined {
	if (value === undefined) return undefined;
	if (Buffer.byteLength(value, "utf8") > MAX_CURSOR_BYTES) {
		throw new PluginStorageError("INVALID_PARAMS", "INVALID_CURSOR", "Storage cursor is too large");
	}
	try {
		const parsed = JSON.parse(
			Buffer.from(value, "base64url").toString("utf8"),
		) as Partial<CursorDocument>;
		if (
			parsed.version !== 1 ||
			parsed.pluginId !== pluginId ||
			parsed.scopeKey !== scopeKey(scope) ||
			parsed.prefix !== prefix ||
			typeof parsed.after !== "string" ||
			parsed.after.length === 0
		) {
			throw new Error("cursor binding mismatch");
		}
		return parsed.after;
	} catch {
		throw new PluginStorageError("INVALID_PARAMS", "INVALID_CURSOR", "Storage cursor is invalid");
	}
}

function parseExpectedRevision(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new PluginStorageError(
			"INVALID_PARAMS",
			"REVISION_CONFLICT",
			"Storage expectedRevision is invalid",
		);
	}
	return value as number;
}

function emptyDocument(pluginId: string, now: () => Date): StorageFileDocument {
	return {
		version: STORAGE_FILE_VERSION,
		pluginId,
		scopes: {},
		diagnostics: [],
		updatedAt: timestamp(now),
	};
}

function validateStoredEntry(
	pluginId: string,
	scope: PluginStorageScope,
	key: string,
	value: unknown,
	limits: PluginStorageLimits,
): StoredEntry {
	if (!isRecord(value)) throw new ValidationError("Plugin storage entry is invalid");
	assertKey(key, limits);
	if (value.key !== key)
		throw new ValidationError("Plugin storage entry key does not match its namespace");
	assertJsonValue(value.value, limits);
	const valueBytes = value.valueBytes;
	if (!Number.isSafeInteger(valueBytes) || valueBytes !== jsonBytes(value.value)) {
		throw new ValidationError("Plugin storage entry byte count is invalid");
	}
	if (valueBytes > limits.maxValueBytes)
		throw new ValidationError("Plugin storage value exceeds its size limit");
	if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
		throw new ValidationError("Plugin storage entry revision is invalid");
	}
	if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
		throw new ValidationError("Plugin storage entry createdAt is invalid");
	}
	if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
		throw new ValidationError("Plugin storage entry updatedAt is invalid");
	}
	void pluginId;
	void scope;
	return {
		key,
		value: clone(value.value),
		valueBytes,
		revision: value.revision as number,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

function validateDocument(
	value: unknown,
	expectedPluginId: string,
	limits: PluginStorageLimits,
): StorageFileDocument {
	if (
		!isRecord(value) ||
		value.version !== STORAGE_FILE_VERSION ||
		value.pluginId !== expectedPluginId
	) {
		throw new ValidationError("Plugin storage file has an unsupported or mismatched format");
	}
	if (!isRecord(value.scopes) || !Array.isArray(value.diagnostics)) {
		throw new ValidationError("Plugin storage file has an invalid shape");
	}
	if (value.diagnostics.length > MAX_DIAGNOSTICS)
		throw new ValidationError("Plugin storage diagnostics are invalid");
	if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
		throw new ValidationError("Plugin storage updatedAt is invalid");
	}
	const scopes: Record<string, Record<string, StoredEntry>> = {};
	for (const [key, rawEntries] of Object.entries(value.scopes)) {
		if (!Array.isArray(rawEntries) && !isRecord(rawEntries)) {
			throw new ValidationError("Plugin storage scope entries are invalid");
		}
		const entries: Record<string, StoredEntry> = {};
		for (const [entryKey, rawEntry] of Object.entries(rawEntries)) {
			entries[entryKey] = validateStoredEntry(
				expectedPluginId,
				{ type: "global" },
				entryKey,
				rawEntry,
				limits,
			);
		}
		scopes[key] = entries;
	}
	return {
		version: STORAGE_FILE_VERSION,
		pluginId: expectedPluginId,
		scopes,
		diagnostics: value.diagnostics.map((diagnostic) => {
			if (
				!isRecord(diagnostic) ||
				typeof diagnostic.code !== "string" ||
				typeof diagnostic.message !== "string"
			) {
				throw new ValidationError("Plugin storage diagnostic is invalid");
			}
			return {
				code: diagnostic.code.slice(0, 128),
				message: diagnostic.message.slice(0, 2_048),
				detectedAt:
					typeof diagnostic.detectedAt === "string"
						? diagnostic.detectedAt
						: new Date(0).toISOString(),
			};
		}),
		updatedAt: value.updatedAt,
	};
}

export class PluginStorage {
	readonly pluginId: string;
	readonly root: string;
	readonly storagePath: string;
	readonly limits: PluginStorageLimits;
	private readonly renameFile: (from: string, to: string) => Promise<void>;
	private readonly now: () => Date;
	private readonly validateValue?: PluginStorageOptions["validateValue"];
	private readonly valueSchema?: PluginStorageOptions["valueSchema"];
	private readonly sessionScopes = new Map<string, Record<string, StoredEntry>>();
	private loadedSession = false;

	constructor(options: PluginStorageOptions);
	constructor(pluginId: string, options?: Omit<PluginStorageOptions, "pluginId">);
	constructor(
		optionsOrPluginId: PluginStorageOptions | string,
		partialOptions: Omit<PluginStorageOptions, "pluginId"> = {},
	) {
		const options =
			typeof optionsOrPluginId === "string"
				? { ...partialOptions, pluginId: optionsOrPluginId }
				: optionsOrPluginId;
		this.pluginId = parsePluginId(options.pluginId);
		this.root = resolve(options.root ?? getNarraforkPath("plugins", "storage"));
		this.storagePath = join(this.root, `${this.pluginId}.json`);
		this.limits = createLimits(options.limits);
		this.renameFile = options.renameFile ?? rename;
		this.now = options.now ?? (() => new Date());
		this.validateValue = options.validateValue;
		this.valueSchema = options.valueSchema;
	}

	async get(input: PluginStorageGetInput): Promise<PluginStorageEntry | undefined>;
	async get(scope: PluginStorageScopeInput, key: string): Promise<PluginStorageEntry | undefined>;
	async get(
		inputOrScope: PluginStorageGetInput | PluginStorageScopeInput,
		keyArgument?: string,
	): Promise<PluginStorageEntry | undefined> {
		const input = this.normalizeGetInput(inputOrScope, keyArgument);
		const scope = resolveScope(input);
		assertKey(input.key, this.limits);
		return this.withPluginLock(async () => {
			const entries = await this.readScopeLocked(scope);
			const entry = entries[input.key];
			return entry ? cloneStoredEntry(entry, this.pluginId, scope) : undefined;
		});
	}

	async set(input: PluginStorageSetInput): Promise<PluginStorageEntry>;
	async set(
		scope: PluginStorageScopeInput,
		key: string,
		value: unknown,
		expectedRevision?: number,
	): Promise<PluginStorageEntry>;
	async set(
		inputOrScope: PluginStorageSetInput | PluginStorageScopeInput,
		keyArgument?: string,
		valueArgument?: unknown,
		expectedRevisionArgument?: number,
	): Promise<PluginStorageEntry> {
		const input = this.normalizeSetInput(
			inputOrScope,
			keyArgument,
			valueArgument,
			expectedRevisionArgument,
		);
		const scope = resolveScope(input);
		assertKey(input.key, this.limits);
		assertJsonValue(input.value, this.limits);
		const value = clone(input.value);
		const valueBytes = jsonBytes(value);
		if (valueBytes > this.limits.maxValueBytes) {
			throw new PluginStorageError(
				"PAYLOAD_TOO_LARGE",
				"VALUE_TOO_LARGE",
				"Plugin storage value exceeds its size limit",
				413,
			);
		}
		if (this.valueSchema && !this.valueSchema.safeParse(value).success) {
			throw new PluginStorageError(
				"INVALID_PARAMS",
				"SCHEMA_REJECTED",
				"Plugin storage value does not match its schema",
			);
		}
		if (this.validateValue) {
			const result = await this.validateValue({
				pluginId: this.pluginId,
				scope: cloneScope(scope),
				key: input.key,
				value: clone(value),
			});
			if (result === false) {
				throw new PluginStorageError(
					"INVALID_PARAMS",
					"SCHEMA_REJECTED",
					"Plugin storage value was rejected by its schema",
				);
			}
		}
		const expectedRevision = parseExpectedRevision(input.expectedRevision);
		return this.withPluginLock(async () => {
			const isSession = scope.type === "session";
			let document: StorageFileDocument | undefined;
			let entries: Record<string, StoredEntry>;
			if (isSession) {
				entries = this.getSessionScope(scope);
			} else {
				document = await this.readDocumentLocked();
				entries = this.getDocumentScope(document, scope);
			}
			const previous = entries[input.key];
			this.assertExpectedRevision(previous, expectedRevision);
			const currentScopeBytes = this.scopeBytes(entries);
			const currentPluginStats = isSession
				? this.sessionStats()
				: this.documentStats(document ?? emptyDocument(this.pluginId, this.now));
			const nextScopeBytes = currentScopeBytes - (previous?.valueBytes ?? 0) + valueBytes;
			const nextScopeEntries = Object.keys(entries).length + (previous ? 0 : 1);
			const nextPluginBytes = currentPluginStats.bytes - (previous?.valueBytes ?? 0) + valueBytes;
			const nextPluginEntries = currentPluginStats.entries + (previous ? 0 : 1);
			if (
				nextScopeBytes > this.limits.maxScopeBytes ||
				nextScopeEntries > this.limits.maxEntriesPerScope
			) {
				throw new PluginStorageError(
					"STORAGE_QUOTA_EXCEEDED",
					"QUOTA_EXCEEDED",
					"Plugin storage scope quota exceeded",
					413,
				);
			}
			if (
				nextPluginBytes > this.limits.maxPluginBytes ||
				nextPluginEntries > this.limits.maxEntriesPerPlugin
			) {
				throw new PluginStorageError(
					"STORAGE_QUOTA_EXCEEDED",
					"QUOTA_EXCEEDED",
					"Plugin storage plugin quota exceeded",
					413,
				);
			}
			const now = timestamp(this.now);
			const next: StoredEntry = {
				key: input.key,
				value,
				valueBytes,
				revision: previous ? previous.revision + 1 : 1,
				createdAt: previous?.createdAt ?? now,
				updatedAt: now,
			};
			entries[input.key] = next;
			if (document) {
				const nextDocument = clone(document);
				nextDocument.scopes[scopeKey(scope)] = entries;
				nextDocument.updatedAt = now;
				await this.writeDocumentLocked(nextDocument);
			}
			return cloneStoredEntry(next, this.pluginId, scope);
		});
	}

	async delete(input: PluginStorageDeleteInput): Promise<boolean>;
	async delete(
		scope: PluginStorageScopeInput,
		key: string,
		expectedRevision?: number,
	): Promise<boolean>;
	async delete(
		inputOrScope: PluginStorageDeleteInput | PluginStorageScopeInput,
		keyArgument?: string,
		expectedRevisionArgument?: number,
	): Promise<boolean> {
		const input = this.normalizeDeleteInput(inputOrScope, keyArgument, expectedRevisionArgument);
		const scope = resolveScope(input);
		assertKey(input.key, this.limits);
		const expectedRevision = parseExpectedRevision(input.expectedRevision);
		return this.withPluginLock(async () => {
			const isSession = scope.type === "session";
			let document: StorageFileDocument | undefined;
			let entries: Record<string, StoredEntry>;
			if (isSession) {
				entries = this.getSessionScope(scope);
			} else {
				document = await this.readDocumentLocked();
				entries = this.getDocumentScope(document, scope);
			}
			const previous = entries[input.key];
			this.assertExpectedRevision(previous, expectedRevision);
			if (!previous) return false;
			const nextEntries = { ...entries };
			delete nextEntries[input.key];
			if (document) {
				const nextDocument = clone(document);
				if (Object.keys(nextEntries).length === 0) delete nextDocument.scopes[scopeKey(scope)];
				else nextDocument.scopes[scopeKey(scope)] = nextEntries;
				nextDocument.updatedAt = timestamp(this.now);
				await this.writeDocumentLocked(nextDocument);
			} else {
				this.sessionScopes.set(scopeKey(scope), nextEntries);
			}
			return true;
		});
	}

	async list(input: PluginStorageListInput): Promise<PluginStorageListResult>;
	async list(
		scope: PluginStorageScopeInput,
		cursor?: string,
		limit?: number,
		prefix?: string,
	): Promise<PluginStorageListResult>;
	async list(
		inputOrScope: PluginStorageListInput | PluginStorageScopeInput,
		cursorArgument?: string,
		limitArgument?: number,
		prefixArgument?: string,
	): Promise<PluginStorageListResult> {
		const input = this.normalizeListInput(
			inputOrScope,
			cursorArgument,
			limitArgument,
			prefixArgument,
		);
		const scope = resolveScope(input);
		const prefix = input.prefix ?? "";
		assertKey(prefix, this.limits, true);
		const limit = input.limit ?? DEFAULT_LIST_LIMIT;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
			throw new PluginStorageError(
				"INVALID_PARAMS",
				"INVALID_CURSOR",
				`Storage list limit must be 1-${MAX_LIST_LIMIT}`,
			);
		}
		const after = decodeCursor(input.cursor, this.pluginId, scope, prefix);
		return this.withPluginLock(async () => {
			const entries = await this.readScopeLocked(scope);
			const keys = Object.keys(entries)
				.filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
				.sort();
			const selected = keys.slice(0, limit + 1);
			const hasMore = selected.length > limit;
			const visible = selected.slice(0, limit);
			const result: PluginStorageListResult = {
				items: visible.map((key) => {
					const entry = entries[key];
					return {
						pluginId: this.pluginId,
						scope: cloneScope(scope),
						key,
						valueBytes: entry.valueBytes,
						revision: entry.revision,
						updatedAt: entry.updatedAt,
					};
				}),
				hasMore,
			};
			if (hasMore && visible.length > 0) {
				const lastKey = visible.at(-1);
				if (lastKey !== undefined) {
					result.nextCursor = encodeCursor({
						version: 1,
						pluginId: this.pluginId,
						scopeKey: scopeKey(scope),
						prefix,
						after: lastKey,
					});
				}
			}
			return result;
		});
	}

	async purge(input?: PluginStoragePurgeInput | PluginStorageScopeInput): Promise<number> {
		let scope: PluginStorageScope | undefined;
		if (input !== undefined) {
			const record = input as Record<string, unknown>;
			if ("type" in record || "scopeType" in record) {
				scope = parseScope(input as PluginStorageScopeInput);
			} else {
				assertOperationFields(record, ["scope", "scopeType", "scopeId"], "Storage purge input");
				scope = resolveScope(input as PluginStoragePurgeInput);
			}
		}
		return this.withPluginLock(async () => {
			if (scope?.type === "session") {
				const key = scopeKey(scope);
				const count = Object.keys(this.sessionScopes.get(key) ?? {}).length;
				this.sessionScopes.delete(key);
				return count;
			}
			const document = await this.readDocumentLocked();
			const nextDocument = clone(document);
			let count = 0;
			if (scope) {
				const key = scopeKey(scope);
				count = Object.keys(nextDocument.scopes[key] ?? {}).length;
				delete nextDocument.scopes[key];
			} else {
				count = Object.values(nextDocument.scopes).reduce(
					(total, entries) => total + Object.keys(entries).length,
					0,
				);
				nextDocument.scopes = {};
			}
			if (count > 0) {
				nextDocument.updatedAt = timestamp(this.now);
				await this.writeDocumentLocked(nextDocument);
			}
			return count;
		});
	}

	async getQuota(scopeInput: PluginStorageScopeInput): Promise<PluginStorageQuota> {
		const scope = parseScope(scopeInput);
		return this.withPluginLock(async () => {
			const entries = await this.readScopeLocked(scope);
			const stats =
				scope.type === "session"
					? this.sessionStats()
					: this.documentStats(await this.readDocumentLocked());
			return {
				pluginId: this.pluginId,
				scope: cloneScope(scope),
				entries: Object.keys(entries).length,
				bytes: this.scopeBytes(entries),
				maxEntries: this.limits.maxEntriesPerScope,
				maxBytes: this.limits.maxScopeBytes,
				pluginEntries: stats.entries,
				pluginBytes: stats.bytes,
				maxPluginEntries: this.limits.maxEntriesPerPlugin,
				maxPluginBytes: this.limits.maxPluginBytes,
			};
		});
	}

	async getDiagnostics(): Promise<Array<{ code: string; message: string; detectedAt: string }>> {
		return this.withPluginLock(async () =>
			(await this.readDocumentLocked()).diagnostics.map(clone),
		);
	}

	private normalizeGetInput(
		inputOrScope: PluginStorageGetInput | PluginStorageScopeInput,
		key?: string,
	): PluginStorageGetInput {
		if (typeof key === "string") return { scope: inputOrScope as PluginStorageScopeInput, key };
		const record = inputOrScope as Record<string, unknown>;
		if (!isRecord(inputOrScope) || typeof record.key !== "string") {
			throw new PluginStorageError("INVALID_PARAMS", "INVALID_KEY", "Storage get input is invalid");
		}
		assertOperationFields(record, ["scope", "scopeType", "scopeId", "key"], "Storage get input");
		return inputOrScope as PluginStorageGetInput;
	}

	private normalizeSetInput(
		inputOrScope: PluginStorageSetInput | PluginStorageScopeInput,
		key?: string,
		value?: unknown,
		expectedRevision?: number,
	): PluginStorageSetInput {
		if (typeof key === "string")
			return { scope: inputOrScope as PluginStorageScopeInput, key, value, expectedRevision };
		const record = inputOrScope as Record<string, unknown>;
		if (!isRecord(inputOrScope) || typeof record.key !== "string" || !("value" in record)) {
			throw new PluginStorageError(
				"INVALID_PARAMS",
				"INVALID_JSON",
				"Storage set input is invalid",
			);
		}
		assertOperationFields(
			record,
			["scope", "scopeType", "scopeId", "key", "value", "expectedRevision"],
			"Storage set input",
		);
		return inputOrScope as PluginStorageSetInput;
	}

	private normalizeDeleteInput(
		inputOrScope: PluginStorageDeleteInput | PluginStorageScopeInput,
		key?: string,
		expectedRevision?: number,
	): PluginStorageDeleteInput {
		if (typeof key === "string")
			return { scope: inputOrScope as PluginStorageScopeInput, key, expectedRevision };
		const record = inputOrScope as Record<string, unknown>;
		if (!isRecord(inputOrScope) || typeof record.key !== "string") {
			throw new PluginStorageError(
				"INVALID_PARAMS",
				"INVALID_KEY",
				"Storage delete input is invalid",
			);
		}
		assertOperationFields(
			record,
			["scope", "scopeType", "scopeId", "key", "expectedRevision"],
			"Storage delete input",
		);
		return inputOrScope as PluginStorageDeleteInput;
	}

	private normalizeListInput(
		inputOrScope: PluginStorageListInput | PluginStorageScopeInput,
		cursor?: string,
		limit?: number,
		prefix?: string,
	): PluginStorageListInput {
		if (cursor !== undefined || limit !== undefined || prefix !== undefined) {
			return { scope: inputOrScope as PluginStorageScopeInput, cursor, limit, prefix };
		}
		if (!isRecord(inputOrScope))
			throw new PluginStorageError(
				"INVALID_PARAMS",
				"INVALID_SCOPE",
				"Storage list input is invalid",
			);
		assertOperationFields(
			inputOrScope,
			["scope", "scopeType", "scopeId", "prefix", "cursor", "limit"],
			"Storage list input",
		);
		return inputOrScope as PluginStorageListInput;
	}

	private async withPluginLock<T>(fn: () => Promise<T>): Promise<T> {
		return pluginStorageMutex.acquire(`${this.root}\u0000${this.pluginId}`, fn);
	}

	private async readScopeLocked(scope: PluginStorageScope): Promise<Record<string, StoredEntry>> {
		if (scope.type === "session") return this.getSessionScope(scope);
		const document = await this.readDocumentLocked();
		return this.getDocumentScope(document, scope);
	}

	private getSessionScope(scope: PluginStorageScope): Record<string, StoredEntry> {
		const key = scopeKey(scope);
		if (!this.loadedSession) this.loadedSession = true;
		let entries = this.sessionScopes.get(key);
		if (!entries) {
			entries = {};
			this.sessionScopes.set(key, entries);
		}
		return entries;
	}

	private getDocumentScope(
		document: StorageFileDocument,
		scope: PluginStorageScope,
	): Record<string, StoredEntry> {
		return document.scopes[scopeKey(scope)] ? clone(document.scopes[scopeKey(scope)]) : {};
	}

	private assertExpectedRevision(
		previous: StoredEntry | undefined,
		expectedRevision: number | undefined,
	): void {
		if (expectedRevision === undefined) return;
		const actual = previous?.revision ?? 0;
		if (actual !== expectedRevision) {
			throw new PluginStorageError(
				"STORAGE_CONFLICT",
				"REVISION_CONFLICT",
				`Storage revision conflict: expected ${expectedRevision}, actual ${actual}`,
				409,
			);
		}
	}

	private scopeBytes(entries: Record<string, StoredEntry>): number {
		return Object.values(entries).reduce((total, entry) => total + entry.valueBytes, 0);
	}

	private documentStats(document: StorageFileDocument): { entries: number; bytes: number } {
		return Object.values(document.scopes).reduce(
			(stats, entries) => ({
				entries: stats.entries + Object.keys(entries).length,
				bytes: stats.bytes + this.scopeBytes(entries),
			}),
			{ entries: 0, bytes: 0 },
		);
	}

	private sessionStats(): { entries: number; bytes: number } {
		return [...this.sessionScopes.values()].reduce(
			(stats, entries) => ({
				entries: stats.entries + Object.keys(entries).length,
				bytes: stats.bytes + this.scopeBytes(entries),
			}),
			{ entries: 0, bytes: 0 },
		);
	}

	private async readDocumentLocked(): Promise<StorageFileDocument> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		try {
			const info = await lstat(this.storagePath);
			if (!info.isFile() || info.isSymbolicLink())
				throw new ValidationError("Plugin storage file is not host-owned");
			if (info.size > this.limits.maxFileBytes)
				throw new ValidationError("Plugin storage file exceeds its size limit");
			const bytes = await readFile(this.storagePath);
			if (bytes.byteLength > this.limits.maxFileBytes)
				throw new ValidationError("Plugin storage file exceeds its size limit");
			const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
			const document = validateDocument(parsed, this.pluginId, this.limits);
			await chmod(this.storagePath, 0o600);
			return document;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return emptyDocument(this.pluginId, this.now);
			const detectedAt = timestamp(this.now);
			const recoveryPath = `${this.storagePath}.corrupt-${detectedAt.replace(/[:.]/g, "-")}-${generateShortId(6)}`;
			await rename(this.storagePath, recoveryPath).catch(() => undefined);
			const diagnostic = {
				code: "PLUGIN_STORAGE_CORRUPT",
				message:
					error instanceof Error ? error.message.slice(0, 2_048) : String(error).slice(0, 2_048),
				detectedAt,
			};
			const document = emptyDocument(this.pluginId, this.now);
			document.diagnostics.push(diagnostic);
			await this.writeDocumentLocked(document);
			return document;
		}
	}

	private async writeDocumentLocked(document: StorageFileDocument): Promise<void> {
		const json = `${JSON.stringify(document, null, 2)}\n`;
		if (Buffer.byteLength(json, "utf8") > this.limits.maxFileBytes) {
			throw new PluginStorageError(
				"STORAGE_QUOTA_EXCEEDED",
				"QUOTA_EXCEEDED",
				"Plugin storage file exceeds its size limit",
				413,
			);
		}
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const temporaryPath = join(
			this.root,
			`.${basename(this.storagePath)}.${generateShortId(10)}.tmp`,
		);
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(temporaryPath, "wx", 0o600);
			await handle.writeFile(json, { encoding: "utf8" });
			await handle.chmod(0o600);
			await handle.sync();
			await handle.close();
			handle = undefined;
			await this.renameFile(temporaryPath, this.storagePath);
			await chmod(this.storagePath, 0o600);
			let directory: Awaited<ReturnType<typeof open>> | undefined;
			try {
				directory = await open(this.root, "r");
				await directory.sync();
			} catch {
				// Directory fsync is not available on every supported platform.
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
