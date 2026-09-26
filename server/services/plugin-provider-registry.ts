import type { ProviderAdapter } from "@server/lib/agent/provider";
import { isContributionId, isPluginId } from "@server/lib/plugins/manifest";
import type { JsonValue } from "@server/lib/plugins/protocol";

const DEFAULT_MODEL_PAGE_SIZE = 100;
const MAX_MODEL_PAGE_SIZE = 200;
const MAX_MODEL_ID_BYTES = 256;
const MAX_VALIDATION_ISSUES = 20;
const LOCAL_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const HOST_RESERVED_PREFIXES = new Set([
	"__agg__",
	"__default__",
	"__summary__",
	"default",
	"summary",
	"codex",
]);
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export type ProviderRegistryKind = "builtin" | "compatible-api" | "executable-plugin";
export type ProviderRegistryStatus = "available" | "unavailable";
export type ProviderSessionMode = "stateless" | "stateful";
export type ProviderReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ProviderModelCapabilities {
	chat: boolean;
	generate: boolean;
	streaming: boolean;
	tools: boolean;
	parallelToolCalls?: boolean;
	inputImages?: boolean;
	reasoning?: boolean;
	reasoningEfforts?: ProviderReasoningEffort[];
	sessionMode: ProviderSessionMode;
}

export interface ProviderModelDescriptor {
	id: string;
	displayName: string;
	description?: string;
	aliases?: string[];
	contextWindow?: number;
	maxOutputTokens?: number;
	deprecated?: boolean;
	deprecationMessage?: string;
	capabilities: ProviderModelCapabilities;
	metadata?: Record<string, JsonValue>;
}

export interface ProviderTypeCapabilities {
	validateConfig: boolean;
	listModels: boolean;
	chat: boolean;
	generate: boolean;
	reasoningContinuation?: boolean;
	inputImages?: boolean;
	mayLeakXmlToolCalls?: boolean;
}

/**
 * Provider-declared policy/payload limits retained by the registry.
 *
 * `maxConcurrentChat` and `maxConcurrentGenerate` describe plugin-owned provider/business
 * concurrency (including any plugin queue or throttle); they are not host admission limits.
 * Generic IPC safety budgets are enforced by the provider RPC client instead.
 */
export interface ProviderTypeLimits {
	maxConcurrentChat?: number;
	maxConcurrentGenerate?: number;
	maxConfigBytes?: number;
	maxModelPageSize?: number;
}

export interface ProviderTypeDescriptor {
	localId: string;
	displayName: string;
	description?: string;
	configSchema: Record<string, JsonValue> | boolean;
	defaultModelId?: string;
	capabilities: ProviderTypeCapabilities;
	limits?: ProviderTypeLimits;
}

export interface ProviderPluginState {
	desiredState?: "enabled" | "disabled" | "uninstalling" | string;
	compatibility?: "compatible" | "incompatible" | "unknown" | string;
	featureDisabled?: boolean;
	installed?: boolean;
}

export interface ProviderCatalogRegistration {
	models: readonly ProviderModelDescriptor[];
	catalogVersion?: string;
	stale?: boolean;
	fetchedAt?: string;
}

export interface ProviderRegistryRegistration {
	kind: ProviderRegistryKind;
	providerInstanceId: string;
	providerPrefix: string;
	displayName: string;
	providerTypeId?: string;
	pluginId?: string;
	localId?: string;
	description?: string;
	disabled?: boolean;
	compatible?: boolean;
	status?: ProviderRegistryStatus;
	unavailableReason?: string;
	pluginState?: ProviderPluginState;
	configSchema?: Record<string, JsonValue> | boolean;
	config?: Record<string, JsonValue>;
	defaultModelId?: string;
	capabilities?: Partial<ProviderTypeCapabilities>;
	limits?: ProviderTypeLimits;
	descriptor?: Partial<ProviderTypeDescriptor> & Pick<ProviderTypeDescriptor, "localId">;
	models?: readonly ProviderModelDescriptor[];
	catalog?: ProviderCatalogRegistration;
	catalogVersion?: string;
	catalogStale?: boolean;
	createAdapter?: () => ProviderAdapter;
	adapterFactory?: ProviderAdapterFactory;
}

export interface ProviderRegistryEntry {
	kind: ProviderRegistryKind;
	pluginId?: string;
	localId: string;
	providerTypeId: string;
	providerInstanceId: string;
	providerPrefix: string;
	displayName: string;
	description?: string;
	configSchema: Readonly<Record<string, JsonValue>> | boolean;
	defaultModelId?: string;
	capabilities: Readonly<ProviderTypeCapabilities>;
	limits?: Readonly<ProviderTypeLimits>;
	disabled: boolean;
	compatible: boolean;
	status: ProviderRegistryStatus;
	unavailableReason?: string;
	catalogVersion?: string;
	catalogStale: boolean;
	lastCatalogRefresh?: string;
	modelCount: number;
	createAdapter: () => ProviderAdapter;
	getModels: () => readonly ProviderModelDescriptor[];
	getModel: (modelId: string) => ProviderModelDescriptor | undefined;
}

export interface RemoteProviderAdapterFactoryContext {
	entry: ProviderRegistryEntry;
	config: Readonly<Record<string, JsonValue>>;
	modelCatalog: ReadonlyMap<string, ProviderModelDescriptor>;
}

export type RemoteProviderAdapterFactory = (
	context: RemoteProviderAdapterFactoryContext,
) => ProviderAdapter;
export type ProviderAdapterFactory = RemoteProviderAdapterFactory;

export interface ProviderRegistryOptions {
	reservedPrefixes?: Iterable<string>;
	remoteProviderAdapterFactory?: RemoteProviderAdapterFactory;
	remoteAdapterFactory?: RemoteProviderAdapterFactory;
	now?: () => Date;
}

export interface ProviderConfigValidationIssue {
	path: string;
	message: string;
}

export interface ProviderConfigValidationResult {
	valid: boolean;
	issues: ProviderConfigValidationIssue[];
	config?: Record<string, JsonValue>;
}

export interface ProviderModelListOptions {
	cursor?: string;
	limit?: number;
	query?: string;
}

export interface ProviderModelListResult {
	providerInstanceId: string;
	providerPrefix: string;
	models: ProviderModelDescriptor[];
	nextCursor?: string;
	catalogVersion?: string;
	stale: boolean;
	available: boolean;
	unavailableReason?: string;
}

export interface ProviderResolveOptions {
	modelId?: string;
	config?: Record<string, JsonValue>;
	requireKnownModel?: boolean;
	createAdapter?: boolean;
}

export interface ProviderRegistryResolution {
	requestedModel: string;
	provider: string;
	providerPrefix: string;
	providerTypeId: string;
	providerInstanceId: string;
	modelId: string;
	model: string;
	modelDescriptor?: ProviderModelDescriptor;
	entry: ProviderRegistryEntry;
	adapter?: ProviderAdapter;
	catalogStale: boolean;
}

export type ProviderRegistryErrorCode =
	| "INVALID_PROVIDER"
	| "PROVIDER_CONFLICT"
	| "PROVIDER_NOT_FOUND"
	| "PROVIDER_UNAVAILABLE"
	| "PROVIDER_CONFIG_INVALID"
	| "MODEL_CATALOG_INVALID"
	| "MODEL_NOT_FOUND"
	| "ADAPTER_UNAVAILABLE";

export class ProviderRegistryError extends Error {
	readonly code: ProviderRegistryErrorCode;

	constructor(code: ProviderRegistryErrorCode, message: string) {
		super(message);
		this.name = "ProviderRegistryError";
		this.code = code;
	}
}

interface InternalProviderEntry {
	registrationOrder: number;
	kind: ProviderRegistryKind;
	pluginId?: string;
	localId: string;
	providerTypeId: string;
	providerInstanceId: string;
	providerPrefix: string;
	displayName: string;
	description?: string;
	configSchema: Record<string, JsonValue> | boolean;
	config: Record<string, JsonValue>;
	defaultModelId?: string;
	capabilities: ProviderTypeCapabilities;
	limits?: ProviderTypeLimits;
	disabled: boolean;
	compatible: boolean;
	explicitUnavailableReason?: string;
	models: Map<string, ProviderModelDescriptor>;
	catalogVersion?: string;
	catalogStale: boolean;
	lastCatalogRefresh?: string;
	createAdapter?: () => ProviderAdapter;
	adapterFactory?: ProviderAdapterFactory;
}

/**
 * Opaque restore token from `detachPlugin`. Holds internal entries, so it must not be
 * exposed outside the host or persisted.
 */
export interface ProviderRegistrySnapshot {
	pluginId: string;
	entries: InternalProviderEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return value;
}

function containsControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint < 0x20 || codePoint === 0x7f) return true;
	}
	return false;
}

function normalizePrefix(prefix: string): string {
	return prefix.toLowerCase();
}

function assertPrefix(prefix: string): void {
	if (
		prefix.length < 1 ||
		prefix.length > 32 ||
		containsControlCharacter(prefix) ||
		/[:\s]/u.test(prefix) ||
		[...prefix].some((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint < 0x21 || codePoint > 0x7e;
		})
	) {
		throw new ProviderRegistryError(
			"INVALID_PROVIDER",
			"Provider prefix must be 1-32 visible ASCII characters without colon or whitespace",
		);
	}
}

function assertProviderInstanceId(providerInstanceId: string): void {
	if (
		!providerInstanceId.trim() ||
		providerInstanceId.length > 128 ||
		containsControlCharacter(providerInstanceId)
	) {
		throw new ProviderRegistryError("INVALID_PROVIDER", "Invalid providerInstanceId");
	}
}

function assertLocalProviderId(localId: string): void {
	if (!LOCAL_PROVIDER_ID_PATTERN.test(localId)) {
		throw new ProviderRegistryError(
			"INVALID_PROVIDER",
			"localProviderId must match [a-z][a-z0-9._-]{0,63}",
		);
	}
}

function parseExecutableIdentity(registration: ProviderRegistryRegistration): {
	pluginId: string;
	localId: string;
	providerTypeId: string;
} {
	let pluginId = registration.pluginId;
	let localId = registration.localId ?? registration.descriptor?.localId;
	if (registration.providerTypeId) {
		const slash = registration.providerTypeId.lastIndexOf("/");
		if (slash <= 0 || slash === registration.providerTypeId.length - 1) {
			throw new ProviderRegistryError("INVALID_PROVIDER", "Invalid executable providerTypeId");
		}
		const typePluginId = registration.providerTypeId.slice(0, slash);
		const typeLocalId = registration.providerTypeId.slice(slash + 1);
		if (pluginId && pluginId !== typePluginId) {
			throw new ProviderRegistryError(
				"INVALID_PROVIDER",
				"providerTypeId plugin identity does not match pluginId",
			);
		}
		if (localId && localId !== typeLocalId) {
			throw new ProviderRegistryError(
				"INVALID_PROVIDER",
				"providerTypeId local identity does not match localId",
			);
		}
		pluginId = typePluginId;
		localId = typeLocalId;
	}
	if (!pluginId || !isPluginId(pluginId)) {
		throw new ProviderRegistryError(
			"INVALID_PROVIDER",
			"Executable providers require a valid pluginId",
		);
	}
	if (!localId) {
		throw new ProviderRegistryError("INVALID_PROVIDER", "Executable providers require a localId");
	}
	assertLocalProviderId(localId);
	return { pluginId, localId, providerTypeId: `${pluginId}/${localId}` };
}

function resolveIdentity(registration: ProviderRegistryRegistration): {
	pluginId?: string;
	localId: string;
	providerTypeId: string;
} {
	if (registration.kind === "executable-plugin") return parseExecutableIdentity(registration);
	const localId =
		registration.localId ??
		registration.descriptor?.localId ??
		registration.providerTypeId?.split("/").at(-1) ??
		registration.providerPrefix.toLowerCase();
	if (!isContributionId(localId)) {
		throw new ProviderRegistryError("INVALID_PROVIDER", "Invalid provider localId");
	}
	const providerTypeId =
		registration.providerTypeId ??
		`${registration.kind === "builtin" ? "builtin" : "compatible-api"}/${localId}`;
	return { localId, providerTypeId };
}

function normalizeCapabilities(
	input: Partial<ProviderTypeCapabilities> | undefined,
): ProviderTypeCapabilities {
	return {
		validateConfig: input?.validateConfig ?? true,
		listModels: input?.listModels ?? true,
		chat: input?.chat ?? true,
		generate: input?.generate ?? true,
		reasoningContinuation: input?.reasoningContinuation,
		inputImages: input?.inputImages,
		mayLeakXmlToolCalls: input?.mayLeakXmlToolCalls,
	};
}

function assertModelId(modelId: string): void {
	if (
		!modelId ||
		new TextEncoder().encode(modelId).byteLength > MAX_MODEL_ID_BYTES ||
		containsControlCharacter(modelId) ||
		["__default__", "__summary__"].includes(modelId)
	) {
		throw new ProviderRegistryError("MODEL_CATALOG_INVALID", `Invalid model ID: ${modelId}`);
	}
}

function normalizeModelDescriptor(model: ProviderModelDescriptor): ProviderModelDescriptor {
	assertModelId(model.id);
	if (!model.displayName?.trim() || containsControlCharacter(model.displayName)) {
		throw new ProviderRegistryError(
			"MODEL_CATALOG_INVALID",
			`Model ${model.id} has an invalid displayName`,
		);
	}
	for (const alias of model.aliases ?? []) assertModelId(alias);
	for (const numberValue of [model.contextWindow, model.maxOutputTokens]) {
		if (numberValue !== undefined && (!Number.isSafeInteger(numberValue) || numberValue <= 0)) {
			throw new ProviderRegistryError(
				"MODEL_CATALOG_INVALID",
				`Model ${model.id} has an invalid token limit`,
			);
		}
	}
	const capabilities = model.capabilities ?? ({} as ProviderModelCapabilities);
	return deepFreeze({
		...clone(model),
		aliases: model.aliases ? [...model.aliases] : undefined,
		capabilities: {
			chat: capabilities.chat ?? true,
			generate: capabilities.generate ?? true,
			streaming: capabilities.streaming ?? true,
			tools: capabilities.tools ?? false,
			parallelToolCalls: capabilities.parallelToolCalls,
			inputImages: capabilities.inputImages,
			reasoning: capabilities.reasoning,
			reasoningEfforts: capabilities.reasoningEfforts
				? [...capabilities.reasoningEfforts]
				: undefined,
			sessionMode: capabilities.sessionMode ?? "stateful",
		},
		metadata: model.metadata ? clone(model.metadata) : undefined,
	});
}

function buildModelMap(
	models: readonly ProviderModelDescriptor[],
): Map<string, ProviderModelDescriptor> {
	const result = new Map<string, ProviderModelDescriptor>();
	const knownReferences = new Map<string, string>();
	for (const input of models) {
		const model = normalizeModelDescriptor(input);
		if (result.has(model.id)) {
			throw new ProviderRegistryError("MODEL_CATALOG_INVALID", `Duplicate model ID: ${model.id}`);
		}
		for (const reference of [model.id, ...(model.aliases ?? [])]) {
			const existing = knownReferences.get(reference);
			if (existing && existing !== model.id) {
				throw new ProviderRegistryError(
					"MODEL_CATALOG_INVALID",
					`Ambiguous model alias ${reference} for ${existing} and ${model.id}`,
				);
			}
			knownReferences.set(reference, model.id);
		}
		result.set(model.id, model);
	}
	return result;
}

function isJsonValue(value: unknown, seen = new Set<unknown>()): value is JsonValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	) {
		return true;
	}
	if (typeof value !== "object" || seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
	for (const [key, child] of Object.entries(value)) {
		if (FORBIDDEN_OBJECT_KEYS.has(key) || !isJsonValue(child, seen)) return false;
	}
	return true;
}

function childPath(path: string, key: string | number): string {
	const escaped = String(key).replaceAll("~", "~0").replaceAll("/", "~1");
	return `${path}/${escaped}`;
}

function valueType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (Number.isInteger(value)) return "integer";
	return typeof value;
}

function schemaTypes(schema: Record<string, unknown>): string[] | undefined {
	if (typeof schema.type === "string") return [schema.type];
	if (Array.isArray(schema.type) && schema.type.every((item) => typeof item === "string")) {
		return schema.type as string[];
	}
	return undefined;
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function resolveJsonPointer(root: unknown, pointer: string): unknown {
	if (pointer === "#") return root;
	if (!pointer.startsWith("#/")) return undefined;
	let current = root;
	for (const rawSegment of pointer.slice(2).split("/")) {
		if (!isRecord(current) && !Array.isArray(current)) return undefined;
		const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
		if (FORBIDDEN_OBJECT_KEYS.has(segment)) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function addIssue(issues: ProviderConfigValidationIssue[], path: string, message: string): void {
	if (issues.length < MAX_VALIDATION_ISSUES) issues.push({ path: path || "/", message });
}

function validateSchemaValue(
	value: unknown,
	schemaValue: unknown,
	root: unknown,
	path: string,
	issues: ProviderConfigValidationIssue[],
	refStack: Set<string>,
): void {
	if (issues.length >= MAX_VALIDATION_ISSUES || schemaValue === true) return;
	if (schemaValue === false) {
		addIssue(issues, path, "is rejected by the schema");
		return;
	}
	if (!isRecord(schemaValue)) {
		addIssue(issues, path, "uses an invalid schema node");
		return;
	}
	const schema = schemaValue;
	if (typeof schema.$ref === "string") {
		if (!schema.$ref.startsWith("#") || refStack.has(schema.$ref)) {
			addIssue(issues, path, "uses an invalid or recursive schema reference");
			return;
		}
		const target = resolveJsonPointer(root, schema.$ref);
		if (target === undefined) {
			addIssue(issues, path, "references an unknown schema location");
			return;
		}
		validateSchemaValue(value, target, root, path, issues, new Set(refStack).add(schema.$ref));
		return;
	}
	if ("const" in schema && !sameJson(value, schema.const)) {
		addIssue(issues, path, "must equal the schema const value");
	}
	if (Array.isArray(schema.enum) && !schema.enum.some((item) => sameJson(item, value))) {
		addIssue(issues, path, "must be one of the schema enum values");
	}
	if (Array.isArray(schema.allOf)) {
		for (const child of schema.allOf) {
			validateSchemaValue(value, child, root, path, issues, refStack);
		}
	}
	if (Array.isArray(schema.anyOf)) {
		const matched = schema.anyOf.some((child) => {
			const childIssues: ProviderConfigValidationIssue[] = [];
			validateSchemaValue(value, child, root, path, childIssues, refStack);
			return childIssues.length === 0;
		});
		if (!matched) addIssue(issues, path, "must match at least one anyOf schema");
	}
	if (Array.isArray(schema.oneOf)) {
		let matches = 0;
		for (const child of schema.oneOf) {
			const childIssues: ProviderConfigValidationIssue[] = [];
			validateSchemaValue(value, child, root, path, childIssues, refStack);
			if (childIssues.length === 0) matches += 1;
		}
		if (matches !== 1) addIssue(issues, path, "must match exactly one oneOf schema");
	}

	const expectedTypes = schemaTypes(schema);
	if (expectedTypes) {
		const actual = valueType(value);
		const matched = expectedTypes.some(
			(type) => type === actual || (type === "number" && actual === "integer"),
		);
		if (!matched) {
			addIssue(issues, path, `must be ${expectedTypes.join(" or ")}`);
			return;
		}
	}

	if (typeof value === "string") {
		if (typeof schema.minLength === "number" && value.length < schema.minLength) {
			addIssue(issues, path, `must have at least ${schema.minLength} characters`);
		}
		if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
			addIssue(issues, path, `must have at most ${schema.maxLength} characters`);
		}
		if (typeof schema.pattern === "string") {
			try {
				if (!new RegExp(schema.pattern, "u").test(value)) {
					addIssue(issues, path, "must match the schema pattern");
				}
			} catch {
				addIssue(issues, path, "uses an invalid schema pattern");
			}
		}
	}

	if (typeof value === "number") {
		const checks: Array<[string, (left: number, right: number) => boolean]> = [
			["minimum", (left, right) => left >= right],
			["maximum", (left, right) => left <= right],
			["exclusiveMinimum", (left, right) => left > right],
			["exclusiveMaximum", (left, right) => left < right],
		];
		for (const [keyword, check] of checks) {
			const limit = schema[keyword];
			if (typeof limit === "number" && !check(value, limit)) {
				addIssue(issues, path, `must satisfy ${keyword} ${limit}`);
			}
		}
	}

	if (Array.isArray(value)) {
		if (typeof schema.minItems === "number" && value.length < schema.minItems) {
			addIssue(issues, path, `must contain at least ${schema.minItems} items`);
		}
		if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
			addIssue(issues, path, `must contain at most ${schema.maxItems} items`);
		}
		if (schema.items !== undefined) {
			for (const [index, child] of value.entries()) {
				validateSchemaValue(child, schema.items, root, childPath(path, index), issues, refStack);
			}
		}
	}

	if (isRecord(value)) {
		const properties = isRecord(schema.properties) ? schema.properties : {};
		const required = Array.isArray(schema.required)
			? schema.required.filter((item): item is string => typeof item === "string")
			: [];
		for (const key of required) {
			if (!(key in value)) addIssue(issues, childPath(path, key), "is required");
		}
		for (const [key, child] of Object.entries(value)) {
			if (FORBIDDEN_OBJECT_KEYS.has(key)) {
				addIssue(issues, childPath(path, key), "uses a forbidden property name");
				continue;
			}
			if (key in properties) {
				validateSchemaValue(child, properties[key], root, childPath(path, key), issues, refStack);
				continue;
			}
			if (schema.additionalProperties === false) {
				addIssue(issues, childPath(path, key), "is not declared by the schema");
			} else if (isRecord(schema.additionalProperties) || schema.additionalProperties === false) {
				validateSchemaValue(
					child,
					schema.additionalProperties,
					root,
					childPath(path, key),
					issues,
					refStack,
				);
			}
		}
	}
}

function validateSchemaDefinition(
	schema: Record<string, JsonValue> | boolean,
): ProviderConfigValidationIssue[] {
	if (typeof schema === "boolean") return [];
	const issues: ProviderConfigValidationIssue[] = [];
	let nodes = 0;
	const visit = (value: unknown, path: string, depth: number): void => {
		if (issues.length >= MAX_VALIDATION_ISSUES) return;
		if (++nodes > 5_000 || depth > 32) {
			addIssue(issues, path, "schema is too complex");
			return;
		}
		if (value === true || value === false) return;
		if (!isRecord(value) || !isJsonValue(value)) {
			addIssue(issues, path, "schema node must be JSON object or boolean");
			return;
		}
		if (
			value.$ref !== undefined &&
			(typeof value.$ref !== "string" || !value.$ref.startsWith("#"))
		) {
			addIssue(issues, childPath(path, "$ref"), "schema references must be local");
		}
		if (value.type !== undefined) {
			const validTypes = new Set([
				"null",
				"boolean",
				"object",
				"array",
				"number",
				"integer",
				"string",
			]);
			const types = typeof value.type === "string" ? [value.type] : value.type;
			if (
				!Array.isArray(types) ||
				!types.every((type) => typeof type === "string" && validTypes.has(type))
			) {
				addIssue(issues, childPath(path, "type"), "schema type is invalid");
			}
		}
		if (value.properties !== undefined && !isRecord(value.properties)) {
			addIssue(issues, childPath(path, "properties"), "schema properties must be an object");
		}
		if (
			value.required !== undefined &&
			(!Array.isArray(value.required) || !value.required.every((key) => typeof key === "string"))
		) {
			addIssue(issues, childPath(path, "required"), "schema required must be an array of strings");
		}
		if (typeof value.pattern === "string") {
			try {
				new RegExp(value.pattern, "u");
			} catch {
				addIssue(issues, childPath(path, "pattern"), "schema pattern is invalid");
			}
		}
		if (isRecord(value.properties)) {
			for (const [key, child] of Object.entries(value.properties)) {
				visit(child, childPath(childPath(path, "properties"), key), depth + 1);
			}
		}
		for (const key of [
			"items",
			"additionalProperties",
			"contains",
			"propertyNames",
			"not",
			"if",
			"then",
			"else",
		]) {
			if (value[key] !== undefined) visit(value[key], childPath(path, key), depth + 1);
		}
		for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
			if (Array.isArray(value[key])) {
				for (const [index, child] of value[key].entries()) {
					visit(child, childPath(childPath(path, key), index), depth + 1);
				}
			}
		}
		for (const key of ["$defs", "definitions"]) {
			if (isRecord(value[key])) {
				for (const [name, child] of Object.entries(value[key])) {
					visit(child, childPath(childPath(path, key), name), depth + 1);
				}
			}
		}
	};
	visit(schema, "", 0);
	return issues;
}

function validateConfigValue(
	config: unknown,
	schema: Record<string, JsonValue> | boolean,
): ProviderConfigValidationResult {
	if (!isRecord(config) || !isJsonValue(config)) {
		return { valid: false, issues: [{ path: "/", message: "must be a JSON object" }] };
	}
	if (!isJsonValue(schema)) {
		return { valid: false, issues: [{ path: "/", message: "config schema is not JSON" }] };
	}
	const issues: ProviderConfigValidationIssue[] = [];
	validateSchemaValue(config, schema, schema, "", issues, new Set());
	return issues.length > 0
		? { valid: false, issues }
		: { valid: true, issues: [], config: clone(config) as Record<string, JsonValue> };
}

function entrySort(left: InternalProviderEntry, right: InternalProviderEntry): number {
	const kindOrder: Record<ProviderRegistryKind, number> = {
		builtin: 0,
		"compatible-api": 1,
		"executable-plugin": 2,
	};
	return (
		kindOrder[left.kind] - kindOrder[right.kind] ||
		normalizePrefix(left.providerPrefix).localeCompare(normalizePrefix(right.providerPrefix)) ||
		left.registrationOrder - right.registrationOrder
	);
}

function availability(entry: InternalProviderEntry): {
	status: ProviderRegistryStatus;
	reason?: string;
} {
	if (entry.disabled) {
		return {
			status: "unavailable",
			reason: entry.explicitUnavailableReason ?? "plugin-disabled",
		};
	}
	if (!entry.compatible) return { status: "unavailable", reason: "plugin-incompatible" };
	if (entry.explicitUnavailableReason) {
		return { status: "unavailable", reason: entry.explicitUnavailableReason };
	}
	return { status: "available" };
}

/**
 * Project an internal entry onto its frozen public shape.
 *
 * `fallbackFactory` is read through a getter rather than captured by value so an
 * adapter factory installed after registration still reaches existing entries.
 */
function publicEntry(
	entry: InternalProviderEntry,
	fallbackFactory?: () => ProviderAdapterFactory | undefined,
): ProviderRegistryEntry {
	const current = availability(entry);
	const publicValue = {
		kind: entry.kind,
		pluginId: entry.pluginId,
		localId: entry.localId,
		providerTypeId: entry.providerTypeId,
		providerInstanceId: entry.providerInstanceId,
		providerPrefix: entry.providerPrefix,
		displayName: entry.displayName,
		description: entry.description,
		configSchema: clone(entry.configSchema),
		defaultModelId: entry.defaultModelId,
		capabilities: clone(entry.capabilities),
		limits: entry.limits ? clone(entry.limits) : undefined,
		disabled: entry.disabled,
		compatible: entry.compatible,
		status: current.status,
		unavailableReason: current.reason,
		catalogVersion: entry.catalogVersion,
		catalogStale: entry.catalogStale || current.status === "unavailable",
		lastCatalogRefresh: entry.lastCatalogRefresh,
		modelCount: entry.models.size,
		createAdapter: (): ProviderAdapter => {
			const adapterStatus = availability(entry);
			if (adapterStatus.status === "unavailable") {
				throw new ProviderRegistryError(
					"PROVIDER_UNAVAILABLE",
					`Provider ${entry.providerPrefix} is unavailable: ${adapterStatus.reason}`,
				);
			}
			if (entry.createAdapter) return entry.createAdapter();
			const factory = entry.adapterFactory ?? fallbackFactory?.();
			if (factory) {
				return factory({
					entry: publicEntry(entry, fallbackFactory),
					config: deepFreeze(clone(entry.config)),
					modelCatalog: new Map(
						[...entry.models.entries()].map(([id, descriptor]) => [id, clone(descriptor)]),
					),
				});
			}
			throw new ProviderRegistryError(
				"ADAPTER_UNAVAILABLE",
				`No adapter factory is registered for ${entry.providerInstanceId}`,
			);
		},
		getModels: (): readonly ProviderModelDescriptor[] =>
			[...entry.models.values()].map((model) => clone(model)),
		getModel: (modelId: string): ProviderModelDescriptor | undefined => {
			const model = descriptorForModel(entry, modelId);
			return model ? clone(model) : undefined;
		},
	};
	return deepFreeze(publicValue);
}

function descriptorForModel(
	entry: InternalProviderEntry,
	modelId: string,
): ProviderModelDescriptor | undefined {
	const direct = entry.models.get(modelId);
	if (direct) return direct;
	for (const descriptor of entry.models.values()) {
		if (descriptor.aliases?.includes(modelId)) return descriptor;
	}
	return undefined;
}

/**
 * In-memory, side-effect-free provider registry. It owns identity, cached model metadata and
 * adapter construction only; callers remain responsible for persistence, refresh jobs and runtime lifecycle.
 */
export class PluginProviderRegistry {
	private readonly entriesByInstance = new Map<string, InternalProviderEntry>();
	private readonly instanceByPrefix = new Map<string, string>();
	private readonly instancesByType = new Map<string, Set<string>>();
	private readonly reservedPrefixes = new Set<string>(HOST_RESERVED_PREFIXES);
	private readonly builtinReservedPrefixes = new Set<string>();
	private remoteProviderAdapterFactory?: RemoteProviderAdapterFactory;
	/**
	 * Stable getter handed to `publicEntry` so frozen entries read the current
	 * registry-wide factory instead of whatever was installed when they were built.
	 */
	private readonly adapterFactoryAccessor = (): ProviderAdapterFactory | undefined =>
		this.remoteProviderAdapterFactory;
	private readonly now: () => Date;
	private registrationSequence = 0;

	constructor(options: ProviderRegistryOptions = {}) {
		for (const prefix of options.reservedPrefixes ?? []) {
			assertPrefix(prefix);
			this.reservedPrefixes.add(normalizePrefix(prefix));
		}
		this.remoteProviderAdapterFactory =
			options.remoteProviderAdapterFactory ?? options.remoteAdapterFactory;
		this.now = options.now ?? (() => new Date());
	}

	/**
	 * Install the factory used to build adapters for executable-plugin providers.
	 *
	 * The exported singleton is constructed at module load, before the plugin
	 * manager and runtime supervisor exist, so the factory cannot be supplied to the
	 * constructor. Already-registered entries pick it up too, because they resolve
	 * the fallback factory lazily inside `createAdapter()`.
	 */
	setRemoteProviderAdapterFactory(factory: RemoteProviderAdapterFactory | undefined): void {
		this.remoteProviderAdapterFactory = factory;
	}

	register(registration: ProviderRegistryRegistration): ProviderRegistryEntry {
		assertProviderInstanceId(registration.providerInstanceId);
		assertPrefix(registration.providerPrefix);
		if (!registration.displayName?.trim()) {
			throw new ProviderRegistryError("INVALID_PROVIDER", "Provider displayName is required");
		}
		const identity = resolveIdentity(registration);
		const normalizedPrefix = normalizePrefix(registration.providerPrefix);
		if (this.entriesByInstance.has(registration.providerInstanceId)) {
			throw new ProviderRegistryError(
				"PROVIDER_CONFLICT",
				`providerInstanceId already registered: ${registration.providerInstanceId}`,
			);
		}
		const conflictingInstance = this.instanceByPrefix.get(normalizedPrefix);
		if (conflictingInstance) {
			throw new ProviderRegistryError(
				"PROVIDER_CONFLICT",
				`Provider prefix conflicts with ${conflictingInstance}: ${registration.providerPrefix}`,
			);
		}
		if (
			registration.kind !== "builtin" &&
			(this.reservedPrefixes.has(normalizedPrefix) ||
				this.builtinReservedPrefixes.has(normalizedPrefix))
		) {
			throw new ProviderRegistryError(
				"PROVIDER_CONFLICT",
				`Provider prefix is reserved by the host: ${registration.providerPrefix}`,
			);
		}

		const descriptor = registration.descriptor;
		const configSchema = clone(
			registration.configSchema ??
				descriptor?.configSchema ?? {
					type: "object",
					additionalProperties: true,
				},
		) as Record<string, JsonValue> | boolean;
		const schemaIssues = validateSchemaDefinition(configSchema);
		if (schemaIssues.length > 0) {
			throw new ProviderRegistryError(
				"PROVIDER_CONFIG_INVALID",
				`Provider config schema is invalid: ${schemaIssues
					.map((issue) => `${issue.path}: ${issue.message}`)
					.join("; ")}`,
			);
		}
		const config = clone(registration.config ?? {});
		const validation = validateConfigValue(config, configSchema);
		if (!validation.valid) {
			throw new ProviderRegistryError(
				"PROVIDER_CONFIG_INVALID",
				`Provider config failed schema validation: ${validation.issues
					.map((issue) => `${issue.path}: ${issue.message}`)
					.join("; ")}`,
			);
		}

		const catalog = registration.catalog;
		const models = buildModelMap(catalog?.models ?? registration.models ?? []);
		const pluginState = registration.pluginState;
		const pluginDisabled =
			registration.disabled === true ||
			registration.status === "unavailable" ||
			pluginState?.featureDisabled === true ||
			pluginState?.desiredState === "disabled" ||
			pluginState?.desiredState === "uninstalling" ||
			pluginState?.installed === false;
		const pluginCompatible =
			registration.compatible !== false &&
			pluginState?.compatibility !== "incompatible" &&
			(pluginState?.compatibility === undefined || pluginState.compatibility === "compatible");
		const entry: InternalProviderEntry = {
			registrationOrder: this.registrationSequence++,
			kind: registration.kind,
			pluginId: identity.pluginId,
			localId: identity.localId,
			providerTypeId: identity.providerTypeId,
			providerInstanceId: registration.providerInstanceId,
			providerPrefix: registration.providerPrefix,
			displayName: registration.displayName,
			description: registration.description ?? descriptor?.description,
			configSchema,
			config: validation.config ?? {},
			defaultModelId: registration.defaultModelId ?? descriptor?.defaultModelId,
			capabilities: normalizeCapabilities(registration.capabilities ?? descriptor?.capabilities),
			limits: clone(registration.limits ?? descriptor?.limits),
			disabled: pluginDisabled,
			compatible: pluginCompatible,
			explicitUnavailableReason:
				registration.unavailableReason ??
				(registration.status === "unavailable" && !pluginDisabled
					? "provider-unavailable"
					: undefined),
			models,
			catalogVersion: catalog?.catalogVersion ?? registration.catalogVersion,
			catalogStale: catalog?.stale ?? registration.catalogStale ?? models.size === 0,
			lastCatalogRefresh:
				catalog?.fetchedAt ?? (models.size > 0 ? this.now().toISOString() : undefined),
			createAdapter: registration.createAdapter,
			// Only an explicitly supplied factory is captured here. The registry-wide
			// fallback is resolved when `createAdapter()` runs, so a factory installed
			// after registration (see `setRemoteProviderAdapterFactory`) still applies.
			adapterFactory: registration.adapterFactory,
		};
		if (entry.defaultModelId) assertModelId(entry.defaultModelId);

		this.entriesByInstance.set(entry.providerInstanceId, entry);
		this.instanceByPrefix.set(normalizedPrefix, entry.providerInstanceId);
		const typeInstances = this.instancesByType.get(entry.providerTypeId) ?? new Set<string>();
		typeInstances.add(entry.providerInstanceId);
		this.instancesByType.set(entry.providerTypeId, typeInstances);
		if (entry.kind === "builtin") this.builtinReservedPrefixes.add(normalizedPrefix);
		return publicEntry(entry, this.adapterFactoryAccessor);
	}

	unregister(providerInstanceIdOrPrefix: string): boolean {
		const entry = this.findInternal(providerInstanceIdOrPrefix);
		if (!entry) return false;
		this.entriesByInstance.delete(entry.providerInstanceId);
		this.instanceByPrefix.delete(normalizePrefix(entry.providerPrefix));
		const typeInstances = this.instancesByType.get(entry.providerTypeId);
		typeInstances?.delete(entry.providerInstanceId);
		if (typeInstances?.size === 0) this.instancesByType.delete(entry.providerTypeId);
		return true;
	}

	/**
	 * Drop every executable-plugin provider owned by `pluginId` and return how many
	 * were removed.
	 *
	 * This is the provider counterpart of `PluginToolRegistry.removePlugin()` and is
	 * what the contribution coordinator calls when a plugin leaves the catalog or its
	 * manifest generation changes. Builtin and compatible-API providers are never
	 * touched: they are host-owned and share no lifecycle with plugin packages.
	 * Removal also frees the provider prefix so a replacement generation can claim it.
	 */
	removePlugin(pluginId: string): number {
		let removed = 0;
		for (const entry of [...this.entriesByInstance.values()]) {
			if (entry.kind !== "executable-plugin" || entry.pluginId !== pluginId) continue;
			if (this.unregister(entry.providerInstanceId)) removed += 1;
		}
		return removed;
	}

	/**
	 * Move one provider to a different prefix, keeping everything else intact.
	 *
	 * Re-registering to change a prefix would lose the entry's config, cached model
	 * catalog and adapter factory, so the prefix index is re-keyed in place instead. The
	 * conflict and reservation rules are the same ones `register()` applies, because the
	 * prefix is a global namespace key regardless of how it got there.
	 */
	setProviderPrefix(reference: string, prefix: string): ProviderRegistryEntry {
		assertPrefix(prefix);
		const entry = this.requireInternal(reference);
		const normalized = normalizePrefix(prefix);
		const previous = normalizePrefix(entry.providerPrefix);
		if (normalized === previous) return publicEntry(entry, this.adapterFactoryAccessor);
		const conflicting = this.instanceByPrefix.get(normalized);
		if (conflicting && conflicting !== entry.providerInstanceId) {
			throw new ProviderRegistryError(
				"PROVIDER_CONFLICT",
				`Provider prefix conflicts with ${conflicting}: ${prefix}`,
			);
		}
		if (
			entry.kind !== "builtin" &&
			(this.reservedPrefixes.has(normalized) || this.builtinReservedPrefixes.has(normalized))
		) {
			throw new ProviderRegistryError("INVALID_PROVIDER", `Provider prefix is reserved: ${prefix}`);
		}
		this.instanceByPrefix.delete(previous);
		this.instanceByPrefix.set(normalized, entry.providerInstanceId);
		entry.providerPrefix = prefix;
		return publicEntry(entry, this.adapterFactoryAccessor);
	}

	/**
	 * Detach a plugin's entries and return an opaque token that can restore them.
	 *
	 * Rebuilding entries from the public `ProviderRegistryEntry` shape is lossy: it
	 * exposes neither `adapterFactory` nor the resolved `config`, so a rollback that
	 * re-registers from it would leave a provider unable to build an adapter and with
	 * its user config silently reset. Callers that need to undo a failed replace should
	 * use this instead of `removePlugin` + `register`.
	 */
	detachPlugin(pluginId: string): ProviderRegistrySnapshot {
		const detached: InternalProviderEntry[] = [];
		for (const entry of [...this.entriesByInstance.values()]) {
			if (entry.kind !== "executable-plugin" || entry.pluginId !== pluginId) continue;
			// Snapshot before unregister so later mutations cannot alias into the token.
			detached.push({ ...entry, models: new Map(entry.models), config: { ...entry.config } });
			this.unregister(entry.providerInstanceId);
		}
		return { pluginId, entries: detached };
	}

	/**
	 * Reinstate entries captured by `detachPlugin`, preserving config and adapters.
	 *
	 * Restoration is best-effort per entry: a prefix freed by the detach may have been
	 * claimed by another plugin in the meantime. Such an entry is skipped rather than
	 * throwing, because this runs on an error path whose original failure is the one
	 * worth reporting. Returns the number of entries actually restored.
	 */
	restorePlugin(snapshot: ProviderRegistrySnapshot): number {
		let restored = 0;
		for (const entry of snapshot.entries) {
			const normalizedPrefix = entry.providerPrefix;
			if (this.instanceByPrefix.has(normalizedPrefix)) continue;
			if (this.entriesByInstance.has(entry.providerInstanceId)) continue;
			this.entriesByInstance.set(entry.providerInstanceId, entry);
			this.instanceByPrefix.set(normalizedPrefix, entry.providerInstanceId);
			const typeInstances = this.instancesByType.get(entry.providerTypeId) ?? new Set<string>();
			typeInstances.add(entry.providerInstanceId);
			this.instancesByType.set(entry.providerTypeId, typeInstances);
			restored += 1;
		}
		return restored;
	}

	describe(reference: string): ProviderRegistryEntry | undefined {
		const entry = this.findInternal(reference);
		if (entry) return publicEntry(entry, this.adapterFactoryAccessor);
		const typeInstances = this.instancesByType.get(reference);
		const firstInstance = typeInstances?.values().next().value as string | undefined;
		const firstEntry = firstInstance ? this.entriesByInstance.get(firstInstance) : undefined;
		return firstEntry ? publicEntry(firstEntry, this.adapterFactoryAccessor) : undefined;
	}

	describeType(providerTypeId: string): ProviderRegistryEntry[] {
		return [...(this.instancesByType.get(providerTypeId) ?? [])]
			.map((instanceId) => this.entriesByInstance.get(instanceId))
			.filter((entry): entry is InternalProviderEntry => entry !== undefined)
			.sort(entrySort)
			.map((entry) => publicEntry(entry, this.adapterFactoryAccessor));
	}

	get(reference: string): ProviderRegistryEntry | undefined {
		return this.describe(reference);
	}

	list(): ProviderRegistryEntry[] {
		return [...this.entriesByInstance.values()]
			.sort(entrySort)
			.map((entry) => publicEntry(entry, this.adapterFactoryAccessor));
	}

	validateConfig(reference: string, config: unknown): ProviderConfigValidationResult {
		const entry = this.requireInternal(reference);
		return validateConfigValue(config, entry.configSchema);
	}

	/**
	 * The provider's stored config.
	 *
	 * `ProviderRegistryEntry` deliberately omits this — config can hold user-supplied
	 * values, so it is not part of the entry every caller receives. Callers that must
	 * forward config over RPC (model discovery, config validation) read it here.
	 */
	getConfig(reference: string): Record<string, JsonValue> {
		return clone(this.requireInternal(reference).config);
	}

	updateConfig(reference: string, config: Record<string, JsonValue>): ProviderRegistryEntry {
		const entry = this.requireInternal(reference);
		const result = validateConfigValue(config, entry.configSchema);
		if (!result.valid || !result.config) {
			throw new ProviderRegistryError(
				"PROVIDER_CONFIG_INVALID",
				`Provider config failed schema validation: ${result.issues
					.map((issue) => `${issue.path}: ${issue.message}`)
					.join("; ")}`,
			);
		}
		entry.config = result.config;
		return publicEntry(entry, this.adapterFactoryAccessor);
	}

	updateModelCatalog(
		reference: string,
		models: readonly ProviderModelDescriptor[],
		options: { catalogVersion?: string; stale?: boolean; fetchedAt?: string } = {},
	): ProviderModelListResult {
		const entry = this.requireInternal(reference);
		try {
			const nextModels = buildModelMap(models);
			entry.models = nextModels;
			entry.catalogVersion = options.catalogVersion ?? entry.catalogVersion;
			entry.catalogStale = options.stale ?? false;
			entry.lastCatalogRefresh = options.fetchedAt ?? this.now().toISOString();
		} catch (error) {
			entry.catalogStale = true;
			throw error;
		}
		return this.listModels(entry.providerInstanceId);
	}

	setModelCatalog(
		reference: string,
		models: readonly ProviderModelDescriptor[],
		options: { catalogVersion?: string; stale?: boolean; fetchedAt?: string } = {},
	): ProviderModelListResult {
		return this.updateModelCatalog(reference, models, options);
	}

	markCatalogStale(reference: string, _reason?: string): ProviderModelListResult {
		const entry = this.requireInternal(reference);
		entry.catalogStale = true;
		return this.listModels(entry.providerInstanceId);
	}

	listModels(reference: string, options: ProviderModelListOptions = {}): ProviderModelListResult {
		const entry = this.requireInternal(reference);
		const parsedCursor = options.cursor === undefined ? 0 : Number.parseInt(options.cursor, 10);
		if (!Number.isSafeInteger(parsedCursor) || parsedCursor < 0) {
			throw new ProviderRegistryError("INVALID_PROVIDER", "Invalid model catalog cursor");
		}
		const providerLimit = entry.limits?.maxModelPageSize ?? MAX_MODEL_PAGE_SIZE;
		const limit = Math.min(
			MAX_MODEL_PAGE_SIZE,
			providerLimit,
			Math.max(1, Math.floor(options.limit ?? DEFAULT_MODEL_PAGE_SIZE)),
		);
		const query = options.query?.trim().toLowerCase();
		const allModels = [...entry.models.values()].filter((model) => {
			if (!query) return true;
			return [model.id, model.displayName, model.description, ...(model.aliases ?? [])]
				.filter((value): value is string => Boolean(value))
				.some((value) => value.toLowerCase().includes(query));
		});
		const models = allModels.slice(parsedCursor, parsedCursor + limit).map((model) => clone(model));
		const current = availability(entry);
		return {
			providerInstanceId: entry.providerInstanceId,
			providerPrefix: entry.providerPrefix,
			models,
			nextCursor:
				parsedCursor + models.length < allModels.length
					? String(parsedCursor + models.length)
					: undefined,
			catalogVersion: entry.catalogVersion,
			stale: entry.catalogStale || current.status === "unavailable",
			available: current.status === "available",
			unavailableReason: current.reason,
		};
	}

	getModels(reference: string): ProviderModelDescriptor[] {
		const entry = this.requireInternal(reference);
		return [...entry.models.values()].map((model) => clone(model));
	}

	setPluginState(pluginId: string, state: ProviderPluginState): number {
		let changed = 0;
		for (const entry of this.entriesByInstance.values()) {
			if (entry.kind !== "executable-plugin" || entry.pluginId !== pluginId) continue;
			if (state.desiredState !== undefined) {
				entry.disabled =
					state.desiredState !== "enabled" ||
					state.featureDisabled === true ||
					state.installed === false;
			}
			if (state.featureDisabled === true || state.installed === false) entry.disabled = true;
			if (state.compatibility !== undefined) {
				entry.compatible = state.compatibility === "compatible";
			}
			changed += 1;
		}
		return changed;
	}

	disablePlugin(pluginId: string, reason = "plugin-disabled"): number {
		let changed = 0;
		for (const entry of this.entriesByInstance.values()) {
			if (entry.kind !== "executable-plugin" || entry.pluginId !== pluginId) continue;
			entry.disabled = true;
			entry.explicitUnavailableReason = reason === "plugin-disabled" ? undefined : reason;
			changed += 1;
		}
		return changed;
	}

	/**
	 * Re-enable every executable-plugin provider owned by `pluginId`.
	 *
	 * This clears the whole disable state, including any reason string recorded by
	 * `disablePlugin()`. Clearing only the literal `"plugin-disabled"` default would
	 * leave a caller-supplied reason (for example the lifecycle's "Plugin is
	 * disabled") latched forever, so the provider would stay unavailable after being
	 * re-enabled. Availability that is genuinely independent of the plugin's
	 * enable/disable state is expressed through `compatible` or by calling
	 * `markUnavailable()` again after this.
	 */
	enablePlugin(pluginId: string): number {
		let changed = 0;
		for (const entry of this.entriesByInstance.values()) {
			if (entry.kind !== "executable-plugin" || entry.pluginId !== pluginId) continue;
			entry.disabled = false;
			entry.explicitUnavailableReason = undefined;
			changed += 1;
		}
		return changed;
	}

	markPluginIncompatible(pluginId: string, reason = "plugin-incompatible"): number {
		let changed = 0;
		for (const entry of this.entriesByInstance.values()) {
			if (entry.kind !== "executable-plugin" || entry.pluginId !== pluginId) continue;
			entry.compatible = false;
			entry.explicitUnavailableReason = reason === "plugin-incompatible" ? undefined : reason;
			changed += 1;
		}
		return changed;
	}

	markUnavailable(reference: string, reason: string): boolean {
		const entry = this.findInternal(reference);
		if (!entry) return false;
		entry.explicitUnavailableReason = reason.trim() || "provider-unavailable";
		return true;
	}

	markAvailable(reference: string): boolean {
		const entry = this.findInternal(reference);
		if (!entry) return false;
		entry.explicitUnavailableReason = undefined;
		return true;
	}

	resolveProvider(
		reference: string,
		options: ProviderResolveOptions = {},
	): ProviderRegistryResolution {
		const trimmed = reference.trim();
		let entry: InternalProviderEntry | undefined;
		let modelId = options.modelId;
		let explicitPrefix = false;
		const colon = trimmed.indexOf(":");
		if (colon > 0) {
			explicitPrefix = true;
			entry = this.findInternal(trimmed.slice(0, colon));
			modelId = trimmed.slice(colon + 1);
			if (!entry) {
				throw new ProviderRegistryError(
					"PROVIDER_NOT_FOUND",
					`Provider is not registered: ${trimmed.slice(0, colon)}`,
				);
			}
		} else {
			const directProvider = this.findInternal(trimmed);
			if (directProvider && options.modelId !== undefined) {
				entry = directProvider;
				explicitPrefix = true;
			} else if (directProvider?.defaultModelId) {
				entry = directProvider;
				explicitPrefix = true;
				modelId = directProvider.defaultModelId;
			} else {
				modelId = modelId ?? trimmed;
				entry = this.findProviderForModel(modelId);
			}
		}
		if (!entry) entry = this.firstAvailableBuiltin();
		if (!entry) {
			throw new ProviderRegistryError(
				"PROVIDER_NOT_FOUND",
				explicitPrefix
					? `Provider is not registered: ${trimmed}`
					: `No provider can resolve model: ${modelId ?? trimmed}`,
			);
		}

		const current = availability(entry);
		if (current.status === "unavailable") {
			throw new ProviderRegistryError(
				"PROVIDER_UNAVAILABLE",
				`Provider ${entry.providerPrefix} is unavailable: ${current.reason}`,
			);
		}
		modelId = modelId || entry.defaultModelId || entry.models.keys().next().value || "default";
		assertModelId(modelId);
		const modelDescriptor = descriptorForModel(entry, modelId);
		if (options.requireKnownModel && !modelDescriptor) {
			throw new ProviderRegistryError(
				"MODEL_NOT_FOUND",
				`Model ${modelId} is not in the catalog for ${entry.providerPrefix}`,
			);
		}
		const canonicalModelId = modelDescriptor?.id ?? modelId;
		const validation = validateConfigValue(options.config ?? entry.config, entry.configSchema);
		if (!validation.valid || !validation.config) {
			throw new ProviderRegistryError(
				"PROVIDER_CONFIG_INVALID",
				`Provider config failed schema validation: ${validation.issues
					.map((issue) => `${issue.path}: ${issue.message}`)
					.join("; ")}`,
			);
		}
		const descriptorCatalog = new Map(
			[...entry.models.entries()].map(([id, descriptor]) => [id, clone(descriptor)]),
		);
		let adapter: ProviderAdapter | undefined;
		if (options.createAdapter !== false) {
			if (entry.createAdapter) adapter = entry.createAdapter();
			else {
				const factory = entry.adapterFactory ?? this.remoteProviderAdapterFactory;
				if (factory) {
					adapter = factory({
						entry: publicEntry(entry, this.adapterFactoryAccessor),
						config: deepFreeze(clone(validation.config)),
						modelCatalog: descriptorCatalog,
					});
				}
			}
		}
		return {
			requestedModel: trimmed,
			provider: entry.providerPrefix,
			providerPrefix: entry.providerPrefix,
			providerTypeId: entry.providerTypeId,
			providerInstanceId: entry.providerInstanceId,
			modelId: canonicalModelId,
			model: `${entry.providerPrefix}:${canonicalModelId}`,
			modelDescriptor: modelDescriptor ? clone(modelDescriptor) : undefined,
			entry: publicEntry(entry, this.adapterFactoryAccessor),
			adapter,
			catalogStale: entry.catalogStale,
		};
	}

	/** Agent resolver bridge; unlike catalog probes, errors here must reach the caller. */
	resolveExternalProvider(provider: string, model: string): ProviderAdapter | null {
		// Decline only unknown prefixes. Swallowing PROVIDER_UNAVAILABLE here turns
		// a temporary lifecycle transition into a misleading "not configured" error.
		if (!this.findInternal(provider)) return null;
		const resolved = this.resolveProvider(model);
		if (!resolved.adapter) {
			throw new ProviderRegistryError(
				"PROVIDER_UNAVAILABLE",
				`Provider ${resolved.providerPrefix} is unavailable: no adapter factory is registered`,
			);
		}
		return resolved.adapter;
	}

	tryResolveProvider(
		reference: string,
		options: ProviderResolveOptions = {},
	): ProviderRegistryResolution | undefined {
		try {
			return this.resolveProvider(reference, options);
		} catch (error) {
			if (error instanceof ProviderRegistryError) return undefined;
			throw error;
		}
	}

	private findInternal(reference: string): InternalProviderEntry | undefined {
		return (
			this.entriesByInstance.get(reference) ??
			this.entriesByInstance.get(this.instanceByPrefix.get(normalizePrefix(reference)) ?? "")
		);
	}

	private requireInternal(reference: string): InternalProviderEntry {
		const entry = this.findInternal(reference);
		if (!entry) {
			throw new ProviderRegistryError("PROVIDER_NOT_FOUND", `Provider not found: ${reference}`);
		}
		return entry;
	}

	private findProviderForModel(modelId: string): InternalProviderEntry | undefined {
		return [...this.entriesByInstance.values()]
			.sort(entrySort)
			.find(
				(entry) =>
					availability(entry).status === "available" &&
					descriptorForModel(entry, modelId) !== undefined,
			);
	}

	private firstAvailableBuiltin(): InternalProviderEntry | undefined {
		return [...this.entriesByInstance.values()]
			.filter((entry) => entry.kind === "builtin" && availability(entry).status === "available")
			.sort(entrySort)[0];
	}
}

export const ProviderRegistry = PluginProviderRegistry;

/** Host-owned registry used by the optional Agent Loop resolver bridge. */
export const pluginProviderRegistry = new PluginProviderRegistry();
