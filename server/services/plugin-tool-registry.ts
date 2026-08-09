import { generateShortId } from "@server/lib/id";
import {
	getContributionFullId,
	type Manifest,
	safeParseManifest,
} from "@server/lib/plugins/manifest";
import type { Capability, InvocationScope } from "@server/lib/plugins/permissions";
import { type JsonValue, jsonValueSchema } from "@server/lib/plugins/protocol";
import { z } from "zod";
import {
	type AuthorizationResult,
	type CapabilityAuthorizationRequest,
	type HostCallContext,
	type InvocationPrincipal,
	invocationPrincipalSchema,
	invocationScopeSchema,
	type PluginPrincipal,
	pluginPrincipalSchema,
} from "./plugin-capability-broker";
import type { PluginPublicApi } from "./plugin-public-api";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_INPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_SCHEMA_BYTES = 256 * 1024;
const DEFAULT_MAX_SCHEMA_DEPTH = 24;
const DEFAULT_MAX_AUDIT_ENTRIES = 1_000;
const DEFAULT_AUTHORIZATION_CAPABILITY: Capability = "provider.use";
const MAX_VALIDATION_ISSUES = 20;
const MAX_PATTERN_LENGTH = 512;
const MAX_SCHEMA_NODES = 5_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SUPPORTED_SCHEMA_KEYS = new Set([
	"$id",
	"$schema",
	"$ref",
	"$defs",
	"definitions",
	"title",
	"description",
	"default",
	"examples",
	"deprecated",
	"readOnly",
	"writeOnly",
	"type",
	"enum",
	"const",
	"allOf",
	"anyOf",
	"oneOf",
	"not",
	"if",
	"then",
	"else",
	"properties",
	"required",
	"additionalProperties",
	"minProperties",
	"maxProperties",
	"items",
	"minItems",
	"maxItems",
	"uniqueItems",
	"contains",
	"minContains",
	"maxContains",
	"minLength",
	"maxLength",
	"pattern",
	"format",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
]);

export type PluginToolStatus = "available" | "unavailable";

export interface PluginToolDescriptor {
	pluginId: string;
	version: string;
	contributionId: string;
	fullId: string;
	name: string;
	title: string;
	description?: string;
	inputSchema: Readonly<Record<string, unknown>>;
	execution: "server" | "ui";
	allowBackground: boolean;
	status: PluginToolStatus;
	unavailableReason?: string;
}

export interface PluginToolTarget {
	kind: "local" | "device";
	deviceId?: string;
	backendKind?: "local" | "remote";
}

export interface PluginToolPermission {
	behavior: "allow" | "deny";
	decisionId?: string;
	decidedBy?: string;
}

export interface PluginToolInvocationOptions {
	context?: HostCallContext;
	invocation?: InvocationPrincipal;
	scope?: InvocationScope;
	target?: PluginToolTarget;
	permission?: PluginToolPermission;
	signal?: AbortSignal;
	timeoutMs?: number;
	requestId?: string;
	correlationId?: string;
	deadlineAt?: string;
}

export interface PluginToolResult {
	output: string;
	isError?: boolean;
	title?: string;
	metadata?: Record<string, JsonValue>;
}

export interface PluginToolHandlerContext {
	descriptor: PluginToolDescriptor;
	host: HostCallContext;
	invocation: InvocationPrincipal;
	scope: InvocationScope;
	target?: Readonly<PluginToolTarget>;
	permission: Readonly<{ behavior: "allow"; decisionId?: string }>;
	signal: AbortSignal;
	publicApi?: PluginPublicApi;
}

export type PluginToolHandler = (
	input: Record<string, JsonValue>,
	context: PluginToolHandlerContext,
) => unknown | Promise<unknown>;

export interface PluginToolRuntime {
	request(
		method: string,
		params?: unknown,
		options?: { signal?: AbortSignal; timeoutMs?: number },
	): Promise<unknown>;
}

export interface PluginToolCapabilityBroker {
	authorize(
		request: CapabilityAuthorizationRequest,
	): Promise<
		AuthorizationResult | { allowed: boolean; error?: { code?: string; reason?: string } }
	>;
	withCallContext?(input: {
		plugin: PluginPrincipal;
		invocation: InvocationPrincipal;
		scope?: InvocationScope;
		requestId?: string;
		correlationId?: string;
		deadlineAt?: string;
	}): HostCallContext;
}

export type PluginToolAuditOutcome =
	| "succeeded"
	| "failed"
	| "denied"
	| "timeout"
	| "cancelled"
	| "unavailable";

export interface PluginToolAuditEntry {
	pluginId: string;
	contributionId: string;
	fullId: string;
	runtimeId?: string;
	requestId?: string;
	correlationId?: string;
	principalKind?: InvocationPrincipal["kind"];
	methodId: "tools.invoke";
	capability: string;
	outcome: PluginToolAuditOutcome;
	durationMs: number;
	requestBytes: number;
	responseBytes: number;
	targetKind?: PluginToolTarget["kind"];
	targetId?: string;
	errorCode?: string;
}

export interface PluginToolRegistryOptions {
	capabilityBroker: PluginToolCapabilityBroker;
	resolvePrincipal?: (
		pluginId: string,
		contributionId: string,
	) => PluginPrincipal | undefined | Promise<PluginPrincipal | undefined>;
	resolveRuntime?: (
		pluginId: string,
		contributionId: string,
	) => PluginToolRuntime | undefined | Promise<PluginToolRuntime | undefined>;
	handler?: PluginToolHandler;
	publicApi?: PluginPublicApi;
	authorizationCapability?: Capability;
	capabilityForTool?: (descriptor: PluginToolDescriptor) => Capability;
	runtimeMethod?: string;
	defaultTimeoutMs?: number;
	maxTimeoutMs?: number;
	maxInputBytes?: number;
	maxOutputBytes?: number;
	maxSchemaBytes?: number;
	maxSchemaDepth?: number;
	maxAuditEntries?: number;
	auditSink?:
		| ((entry: PluginToolAuditEntry) => void | Promise<void>)
		| { write(entry: PluginToolAuditEntry): void | Promise<void> };
	now?: () => Date;
}

export class PluginToolRegistryError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(code: string, message: string, retryable = false) {
		super(message);
		this.name = "PluginToolRegistryError";
		this.code = code;
		this.retryable = retryable;
	}
}

interface RegistryEntry {
	descriptor: PluginToolDescriptor;
	principal?: PluginPrincipal;
	handler?: PluginToolHandler;
	schema: Record<string, unknown>;
}

interface ManifestRegistrationOptions {
	principal?: PluginPrincipal;
	handler?: PluginToolHandler;
}

interface ValidationIssue {
	path: string;
	message: string;
}

const runtimeResultSchema = z.union([
	z.string(),
	z
		.object({
			output: z.string(),
			isError: z.boolean().optional(),
			title: z.string().max(1_024).optional(),
			metadata: z.record(z.string(), jsonValueSchema).optional(),
		})
		.strict(),
]);

const toolTargetSchema = z
	.object({
		kind: z.enum(["local", "device"]),
		deviceId: z.string().trim().min(1).max(128).optional(),
		backendKind: z.enum(["local", "remote"]).optional(),
	})
	.strict()
	.superRefine((target, context) => {
		if (target.kind === "device" && !target.deviceId) {
			context.addIssue({
				code: "custom",
				path: ["deviceId"],
				message: "device target requires id",
			});
		}
		if (target.kind === "local" && (target.deviceId || target.backendKind === "remote")) {
			context.addIssue({ code: "custom", message: "local target cannot identify a remote device" });
		}
	});

const toolPermissionSchema = z
	.object({
		behavior: z.enum(["allow", "deny"]),
		decisionId: z.string().trim().min(1).max(128).optional(),
		decidedBy: z.string().trim().min(1).max(128).optional(),
	})
	.strict();

function clone<T>(value: T): T {
	return structuredClone(value) as T;
}

/** JSON round-trip: drops undefined fields and non-finite numbers → strict JsonValue. */
function toStrictJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object") {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return value;
}

function jsonBytes(value: unknown, code = "INVALID_PARAMS"): number {
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf8");
	} catch {
		throw new PluginToolRegistryError(code, "Tool payload must be serializable JSON");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(reason?: unknown): DOMException {
	return new DOMException(
		typeof reason === "string" ? reason : "Tool call cancelled",
		"AbortError",
	);
}

function errorCode(error: unknown): string {
	if (error instanceof PluginToolRegistryError) return error.code;
	if (error instanceof DOMException && error.name === "AbortError") return "CANCELLED";
	if (error && typeof error === "object" && "code" in error) return String(error.code);
	return "INTERNAL_ERROR";
}

function auditOutcome(error: unknown): PluginToolAuditOutcome {
	const code = errorCode(error);
	if (code === "PERMISSION_DENIED") return "denied";
	if (code === "PLUGIN_DISABLED" || code === "HOST_UNAVAILABLE") return "unavailable";
	if (code === "TIMEOUT" || code === "RPC_TIMEOUT") return "timeout";
	if (code === "CANCELLED") return "cancelled";
	return "failed";
}

function escapePathSegment(value: string): string {
	return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function childPath(path: string, key: string | number): string {
	return `${path}/${typeof key === "number" ? key : escapePathSegment(key)}`;
}

function resolvePointer(root: Record<string, unknown>, reference: string): unknown {
	if (reference === "#") return root;
	if (!reference.startsWith("#/")) {
		throw new PluginToolRegistryError("INVALID_PARAMS", "Tool schema references must be local");
	}
	let current: unknown = root;
	for (const raw of reference.slice(2).split("/")) {
		const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
		if (!isRecord(current) || FORBIDDEN_KEYS.has(key) || !(key in current)) {
			throw new PluginToolRegistryError(
				"INVALID_PARAMS",
				"Tool schema contains an invalid reference",
			);
		}
		current = current[key];
	}
	return current;
}

function schemaTypes(schema: Record<string, unknown>): string[] | undefined {
	if (typeof schema.type === "string") return [schema.type];
	if (Array.isArray(schema.type) && schema.type.every((item) => typeof item === "string")) {
		return schema.type as string[];
	}
	return undefined;
}

function valueType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (Number.isInteger(value)) return "integer";
	return typeof value;
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function checkNumberKeyword(
	value: number,
	schema: Record<string, unknown>,
	keyword: string,
	compare: (left: number, right: number) => boolean,
	issues: ValidationIssue[],
	path: string,
): void {
	const limit = schema[keyword];
	if (typeof limit === "number" && !compare(value, limit)) {
		issues.push({ path, message: `must satisfy ${keyword} ${limit}` });
	}
}

function validateFormat(value: string, format: unknown): boolean {
	if (format === "date-time") return Number.isFinite(Date.parse(value));
	if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
	if (format === "uri") {
		try {
			new URL(value);
			return true;
		} catch {
			return false;
		}
	}
	if (format === "uuid")
		return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
	return true;
}

function validateAgainstSchema(
	value: unknown,
	schemaValue: unknown,
	root: Record<string, unknown>,
	path: string,
	issues: ValidationIssue[],
	refStack: Set<string>,
): void {
	if (issues.length >= MAX_VALIDATION_ISSUES) return;
	if (schemaValue === true) return;
	if (schemaValue === false) {
		issues.push({ path, message: "is rejected by the schema" });
		return;
	}
	if (!isRecord(schemaValue)) {
		issues.push({ path, message: "uses an invalid schema node" });
		return;
	}
	const schema = schemaValue;
	if (typeof schema.$ref === "string") {
		if (refStack.has(schema.$ref)) {
			issues.push({ path, message: "contains a recursive schema reference" });
			return;
		}
		const nextStack = new Set(refStack).add(schema.$ref);
		validateAgainstSchema(value, resolvePointer(root, schema.$ref), root, path, issues, nextStack);
		return;
	}
	if ("const" in schema && !sameJson(value, schema.const)) {
		issues.push({ path, message: "must equal the schema const value" });
	}
	if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => sameJson(value, candidate))) {
		issues.push({ path, message: "must be one of the schema enum values" });
	}
	if (Array.isArray(schema.allOf)) {
		for (const child of schema.allOf)
			validateAgainstSchema(value, child, root, path, issues, refStack);
	}
	if (Array.isArray(schema.anyOf)) {
		const matches = schema.anyOf.some((child) => {
			const candidate: ValidationIssue[] = [];
			validateAgainstSchema(value, child, root, path, candidate, refStack);
			return candidate.length === 0;
		});
		if (!matches) issues.push({ path, message: "must match at least one anyOf schema" });
	}
	if (Array.isArray(schema.oneOf)) {
		let matches = 0;
		for (const child of schema.oneOf) {
			const candidate: ValidationIssue[] = [];
			validateAgainstSchema(value, child, root, path, candidate, refStack);
			if (candidate.length === 0) matches += 1;
		}
		if (matches !== 1) issues.push({ path, message: "must match exactly one oneOf schema" });
	}
	if (schema.not !== undefined) {
		const candidate: ValidationIssue[] = [];
		validateAgainstSchema(value, schema.not, root, path, candidate, refStack);
		if (candidate.length === 0)
			issues.push({ path, message: "must not match the forbidden schema" });
	}
	if (schema.if !== undefined) {
		const candidate: ValidationIssue[] = [];
		validateAgainstSchema(value, schema.if, root, path, candidate, refStack);
		const branch = candidate.length === 0 ? schema.then : schema.else;
		if (branch !== undefined) validateAgainstSchema(value, branch, root, path, issues, refStack);
	}

	const types = schemaTypes(schema);
	if (types) {
		const actual = valueType(value);
		const matches = types.some(
			(type) => type === actual || (type === "number" && actual === "integer"),
		);
		if (!matches) {
			issues.push({ path, message: `must be ${types.join(" or ")}` });
			return;
		}
	}

	if (typeof value === "string") {
		if (typeof schema.minLength === "number" && value.length < schema.minLength) {
			issues.push({ path, message: `must have at least ${schema.minLength} characters` });
		}
		if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
			issues.push({ path, message: `must have at most ${schema.maxLength} characters` });
		}
		if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
			issues.push({ path, message: "must match the schema pattern" });
		}
		if (!validateFormat(value, schema.format)) {
			issues.push({ path, message: `must match format ${String(schema.format)}` });
		}
	}

	if (typeof value === "number") {
		checkNumberKeyword(value, schema, "minimum", (left, right) => left >= right, issues, path);
		checkNumberKeyword(value, schema, "maximum", (left, right) => left <= right, issues, path);
		checkNumberKeyword(
			value,
			schema,
			"exclusiveMinimum",
			(left, right) => left > right,
			issues,
			path,
		);
		checkNumberKeyword(
			value,
			schema,
			"exclusiveMaximum",
			(left, right) => left < right,
			issues,
			path,
		);
		if (
			typeof schema.multipleOf === "number" &&
			schema.multipleOf > 0 &&
			Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-10
		) {
			issues.push({ path, message: `must be a multiple of ${schema.multipleOf}` });
		}
	}

	if (Array.isArray(value)) {
		if (typeof schema.minItems === "number" && value.length < schema.minItems) {
			issues.push({ path, message: `must contain at least ${schema.minItems} items` });
		}
		if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
			issues.push({ path, message: `must contain at most ${schema.maxItems} items` });
		}
		if (schema.uniqueItems === true) {
			const unique = new Set(value.map((item) => JSON.stringify(item)));
			if (unique.size !== value.length) issues.push({ path, message: "must contain unique items" });
		}
		if (schema.items !== undefined) {
			for (let index = 0; index < value.length; index += 1) {
				validateAgainstSchema(
					value[index],
					schema.items,
					root,
					childPath(path, index),
					issues,
					refStack,
				);
			}
		}
		if (schema.contains !== undefined) {
			let matches = 0;
			for (const item of value) {
				const candidate: ValidationIssue[] = [];
				validateAgainstSchema(item, schema.contains, root, path, candidate, refStack);
				if (candidate.length === 0) matches += 1;
			}
			const minContains = typeof schema.minContains === "number" ? schema.minContains : 1;
			const maxContains =
				typeof schema.maxContains === "number" ? schema.maxContains : Number.POSITIVE_INFINITY;
			if (matches < minContains || matches > maxContains) {
				issues.push({ path, message: "does not satisfy contains constraints" });
			}
		}
	}

	if (isRecord(value)) {
		const keys = Object.keys(value);
		if (typeof schema.minProperties === "number" && keys.length < schema.minProperties) {
			issues.push({ path, message: `must contain at least ${schema.minProperties} properties` });
		}
		if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) {
			issues.push({ path, message: `must contain at most ${schema.maxProperties} properties` });
		}
		const properties = isRecord(schema.properties) ? schema.properties : {};
		const required = Array.isArray(schema.required)
			? schema.required.filter((item): item is string => typeof item === "string")
			: [];
		for (const key of required) {
			if (!(key in value)) issues.push({ path: childPath(path, key), message: "is required" });
		}
		for (const [key, child] of Object.entries(value)) {
			if (FORBIDDEN_KEYS.has(key)) {
				issues.push({ path: childPath(path, key), message: "uses a forbidden property name" });
				continue;
			}
			if (key in properties) {
				validateAgainstSchema(child, properties[key], root, childPath(path, key), issues, refStack);
				continue;
			}
			const additional = schema.additionalProperties ?? false;
			if (additional === false) {
				issues.push({
					path: childPath(path, key),
					message: "is not declared by the strict schema",
				});
			} else if (additional !== true) {
				validateAgainstSchema(child, additional, root, childPath(path, key), issues, refStack);
			}
		}
	}
}

function validateSchemaShape(
	schema: Record<string, unknown>,
	maxBytes: number,
	maxDepth: number,
): Record<string, unknown> {
	if (!jsonValueSchema.safeParse(schema).success) {
		throw new PluginToolRegistryError("INVALID_PARAMS", "Tool schema must be restricted JSON");
	}
	if (jsonBytes(schema) > maxBytes) {
		throw new PluginToolRegistryError("PAYLOAD_TOO_LARGE", "Tool schema exceeds byte limit");
	}
	const root = clone(schema);
	let nodes = 0;
	const visit = (value: unknown, depth: number, path: string): void => {
		if (++nodes > MAX_SCHEMA_NODES || depth > maxDepth) {
			throw new PluginToolRegistryError("INVALID_PARAMS", "Tool schema is too complex");
		}
		if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index += 1) {
				visit(value[index], depth + 1, childPath(path, index));
			}
			return;
		}
		if (!isRecord(value)) return;
		for (const [key, child] of Object.entries(value)) {
			if (FORBIDDEN_KEYS.has(key)) {
				throw new PluginToolRegistryError("INVALID_PARAMS", "Tool schema uses a forbidden key");
			}
			if (
				path !== "/properties" &&
				!path.includes("/properties/") &&
				!path.includes("/$defs/") &&
				!path.includes("/definitions/") &&
				!SUPPORTED_SCHEMA_KEYS.has(key)
			) {
				throw new PluginToolRegistryError(
					"INVALID_PARAMS",
					`Tool schema keyword is unsupported: ${key}`,
				);
			}
			if (key === "$ref") {
				if (typeof child !== "string" || !child.startsWith("#")) {
					throw new PluginToolRegistryError(
						"INVALID_PARAMS",
						"Tool schema references must be local",
					);
				}
				resolvePointer(root, child);
			}
			if (key === "pattern") {
				if (typeof child !== "string" || child.length > MAX_PATTERN_LENGTH) {
					throw new PluginToolRegistryError("INVALID_PARAMS", "Tool schema pattern is invalid");
				}
				try {
					new RegExp(child, "u");
				} catch {
					throw new PluginToolRegistryError("INVALID_PARAMS", "Tool schema pattern is invalid");
				}
			}
			visit(child, depth + 1, childPath(path, key));
		}
	};
	visit(root, 0, "");
	const types = schemaTypes(root);
	if (types && !types.includes("object")) {
		throw new PluginToolRegistryError(
			"INVALID_PARAMS",
			"Tool input schema root must allow an object",
		);
	}
	if (
		!types &&
		!isRecord(root.properties) &&
		!Array.isArray(root.anyOf) &&
		!Array.isArray(root.oneOf)
	) {
		throw new PluginToolRegistryError(
			"INVALID_PARAMS",
			"Tool input schema root must describe an object",
		);
	}
	return root;
}

function validateInput(input: unknown, schema: Record<string, unknown>): Record<string, JsonValue> {
	if (!jsonValueSchema.safeParse(input).success || !isRecord(input)) {
		throw new PluginToolRegistryError(
			"INVALID_PARAMS",
			"Tool input must be a restricted JSON object",
		);
	}
	const issues: ValidationIssue[] = [];
	validateAgainstSchema(input, schema, schema, "", issues, new Set());
	if (issues.length > 0) {
		const summary = issues
			.slice(0, MAX_VALIDATION_ISSUES)
			.map((issue) => `${issue.path || "/"}: ${issue.message}`)
			.join("; ");
		throw new PluginToolRegistryError(
			"INVALID_PARAMS",
			`Tool input failed strict validation: ${summary}`,
		);
	}
	return clone(input) as Record<string, JsonValue>;
}

function normalizeResult(value: unknown): PluginToolResult {
	const parsed = runtimeResultSchema.safeParse(value);
	if (!parsed.success) {
		throw new PluginToolRegistryError("PROTOCOL_ERROR", "Plugin returned an invalid tool result");
	}
	if (typeof parsed.data === "string") return { output: parsed.data };
	return clone(parsed.data) as PluginToolResult;
}

function frozenDescriptor(descriptor: PluginToolDescriptor): PluginToolDescriptor {
	return deepFreeze({ ...descriptor, inputSchema: deepFreeze(clone(descriptor.inputSchema)) });
}

function copyDescriptor(descriptor: PluginToolDescriptor): PluginToolDescriptor {
	return clone(descriptor);
}

export class PluginToolRegistry {
	private readonly capabilityBroker: PluginToolCapabilityBroker;
	private readonly resolvePrincipal?: PluginToolRegistryOptions["resolvePrincipal"];
	private readonly resolveRuntime?: PluginToolRegistryOptions["resolveRuntime"];
	private readonly defaultHandler?: PluginToolHandler;
	private readonly publicApi?: PluginPublicApi;
	private readonly authorizationCapability: Capability;
	private readonly capabilityForTool?: PluginToolRegistryOptions["capabilityForTool"];
	private readonly runtimeMethod: string;
	private readonly defaultTimeoutMs: number;
	private readonly maxTimeoutMs: number;
	private readonly maxInputBytes: number;
	private readonly maxOutputBytes: number;
	private readonly maxSchemaBytes: number;
	private readonly maxSchemaDepth: number;
	private readonly maxAuditEntries: number;
	private readonly auditSink?: PluginToolRegistryOptions["auditSink"];
	private readonly now: () => Date;
	private readonly entries = new Map<string, RegistryEntry>();
	private readonly auditEntries: PluginToolAuditEntry[] = [];

	constructor(options: PluginToolRegistryOptions) {
		this.capabilityBroker = options.capabilityBroker;
		this.resolvePrincipal = options.resolvePrincipal;
		this.resolveRuntime = options.resolveRuntime;
		this.defaultHandler = options.handler;
		this.publicApi = options.publicApi;
		this.authorizationCapability =
			options.authorizationCapability ?? DEFAULT_AUTHORIZATION_CAPABILITY;
		this.capabilityForTool = options.capabilityForTool;
		this.runtimeMethod = options.runtimeMethod ?? "tools.invoke";
		this.maxTimeoutMs = Math.max(1, Math.floor(options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS));
		this.defaultTimeoutMs = Math.min(
			this.maxTimeoutMs,
			Math.max(1, Math.floor(options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS)),
		);
		this.maxInputBytes = Math.max(1, Math.floor(options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES));
		this.maxOutputBytes = Math.max(
			1,
			Math.floor(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES),
		);
		this.maxSchemaBytes = Math.max(
			1,
			Math.floor(options.maxSchemaBytes ?? DEFAULT_MAX_SCHEMA_BYTES),
		);
		this.maxSchemaDepth = Math.max(
			1,
			Math.floor(options.maxSchemaDepth ?? DEFAULT_MAX_SCHEMA_DEPTH),
		);
		this.maxAuditEntries = Math.max(
			1,
			Math.floor(options.maxAuditEntries ?? DEFAULT_MAX_AUDIT_ENTRIES),
		);
		this.auditSink = options.auditSink;
		this.now = options.now ?? (() => new Date());
	}

	registerManifest(
		manifestInput: Manifest | unknown,
		options: ManifestRegistrationOptions = {},
	): PluginToolDescriptor[] {
		const parsed = safeParseManifest(manifestInput);
		if (!parsed.success) {
			throw new PluginToolRegistryError(
				"INVALID_PARAMS",
				"Plugin Manifest failed strict validation",
			);
		}
		const manifest = parsed.data;
		if (options.principal && options.principal.pluginId !== manifest.pluginId) {
			throw new PluginToolRegistryError(
				"CONTEXT_UNAVAILABLE",
				"Manifest principal is inconsistent",
			);
		}
		const pending: RegistryEntry[] = [];
		const pendingIds = new Set<string>();
		for (const tool of manifest.contributes.tools) {
			const fullId = getContributionFullId(manifest.pluginId, tool.id);
			if (this.entries.has(fullId) || pendingIds.has(fullId)) {
				throw new PluginToolRegistryError("CONFLICT", `Tool is already registered: ${fullId}`);
			}
			pendingIds.add(fullId);
			const schema = validateSchemaShape(
				tool.inputSchema,
				this.maxSchemaBytes,
				this.maxSchemaDepth,
			);
			const descriptor = frozenDescriptor({
				pluginId: manifest.pluginId,
				version: manifest.version,
				contributionId: tool.id,
				fullId,
				name: fullId,
				title: tool.title,
				description: tool.description,
				inputSchema: schema,
				execution: tool.execution,
				allowBackground: tool.allowBackground,
				status: "available",
			});
			pending.push({
				descriptor,
				principal: options.principal,
				handler: options.handler,
				schema,
			});
		}
		for (const entry of pending) this.entries.set(entry.descriptor.fullId, entry);
		return pending.map((entry) => copyDescriptor(entry.descriptor));
	}

	register(
		manifestInput: Manifest | unknown,
		options: ManifestRegistrationOptions = {},
	): PluginToolDescriptor[] {
		return this.registerManifest(manifestInput, options);
	}

	replaceManifest(
		manifestInput: Manifest | unknown,
		options: ManifestRegistrationOptions = {},
	): PluginToolDescriptor[] {
		const parsed = safeParseManifest(manifestInput);
		if (!parsed.success) {
			throw new PluginToolRegistryError(
				"INVALID_PARAMS",
				"Plugin Manifest failed strict validation",
			);
		}
		const previous = [...this.entries.values()].filter(
			(entry) => entry.descriptor.pluginId === parsed.data.pluginId,
		);
		this.removePlugin(parsed.data.pluginId);
		try {
			return this.registerManifest(parsed.data, options);
		} catch (error) {
			for (const entry of previous) this.entries.set(entry.descriptor.fullId, entry);
			throw error;
		}
	}

	refreshManifest(
		manifestInput: Manifest | unknown,
		options: ManifestRegistrationOptions = {},
	): PluginToolDescriptor[] {
		return this.replaceManifest(manifestInput, options);
	}

	get(fullId: string): PluginToolDescriptor | undefined {
		const entry = this.entries.get(fullId);
		return entry ? copyDescriptor(entry.descriptor) : undefined;
	}

	list(pluginId?: string): PluginToolDescriptor[] {
		return [...this.entries.values()]
			.filter((entry) => !pluginId || entry.descriptor.pluginId === pluginId)
			.map((entry) => copyDescriptor(entry.descriptor))
			.sort((left, right) => left.fullId.localeCompare(right.fullId));
	}

	async invoke(
		fullId: string,
		input: unknown,
		options: PluginToolInvocationOptions = {},
	): Promise<PluginToolResult> {
		const startedAt = this.now().getTime();
		const entry = this.entries.get(fullId);
		if (!entry) throw new PluginToolRegistryError("NOT_FOUND", `Unknown plugin tool: ${fullId}`);
		const capability = this.capabilityForTool?.(entry.descriptor) ?? this.authorizationCapability;
		let host: HostCallContext | undefined;
		let requestBytes = 0;
		let responseBytes = 0;
		let target: Readonly<PluginToolTarget> | undefined;
		try {
			if (entry.descriptor.status !== "available") {
				throw new PluginToolRegistryError(
					entry.descriptor.unavailableReason?.includes("disabled")
						? "PLUGIN_DISABLED"
						: "HOST_UNAVAILABLE",
					entry.descriptor.unavailableReason ?? "Plugin tool is unavailable",
					true,
				);
			}
			const parsedInput = validateInput(input, entry.schema);
			requestBytes = jsonBytes(parsedInput);
			if (requestBytes > this.maxInputBytes) {
				throw new PluginToolRegistryError("PAYLOAD_TOO_LARGE", "Tool input exceeds byte limit");
			}
			const parsedInvocation = invocationPrincipalSchema.safeParse(
				options.context?.invocation ?? options.invocation,
			);
			if (!parsedInvocation.success) {
				throw new PluginToolRegistryError(
					"CONTEXT_UNAVAILABLE",
					"Tool invocation principal is required",
				);
			}
			const invocation = parsedInvocation.data;
			if (invocation.kind === "plugin_background" && !entry.descriptor.allowBackground) {
				throw new PluginToolRegistryError(
					"PERMISSION_DENIED",
					"Tool does not allow background calls",
				);
			}
			const parsedPermission = toolPermissionSchema.safeParse(
				options.permission ?? { behavior: "allow" },
			);
			if (!parsedPermission.success) {
				throw new PluginToolRegistryError("INVALID_PARAMS", "Tool permission context is invalid");
			}
			if (parsedPermission.data.behavior === "deny") {
				throw new PluginToolRegistryError("PERMISSION_DENIED", "Core tool permission was denied");
			}
			const principal = await this.principalFor(entry);
			const parsedScope = invocationScopeSchema.safeParse(
				options.context?.scope ?? options.scope ?? {},
			);
			if (!parsedScope.success) {
				throw new PluginToolRegistryError(
					"CONTEXT_UNAVAILABLE",
					"Tool invocation scope is invalid",
				);
			}
			const scope = clone(parsedScope.data);
			const timeoutMs = this.timeout(options.timeoutMs);
			const deadlineAt = this.deadline(options, timeoutMs);
			host = this.createContext(principal, invocation, scope, options, deadlineAt);
			if (options.target) {
				const parsedTarget = toolTargetSchema.safeParse(options.target);
				if (!parsedTarget.success) {
					throw new PluginToolRegistryError("INVALID_PARAMS", "Tool execution target is invalid");
				}
				target = deepFreeze(clone(parsedTarget.data));
			}
			const authorization = await this.capabilityBroker.authorize({
				context: host,
				capability,
				methodId: `tools.invoke:${entry.descriptor.fullId}`,
				scope,
				constraints: {
					maxBytes: requestBytes,
					...(target?.deviceId ? { resourceId: target.deviceId } : {}),
				},
				...(target?.kind === "device" && target.deviceId
					? { resource: { type: "device" as const, id: target.deviceId } }
					: {}),
				requestBytes,
				responseBytes: 0,
			});
			if (!authorization.allowed) {
				throw new PluginToolRegistryError(
					authorization.error?.code ?? "PERMISSION_DENIED",
					"Capability broker denied the plugin tool call",
				);
			}
			const result = await this.executeEntry(
				entry,
				parsedInput,
				{
					descriptor: copyDescriptor(entry.descriptor),
					host,
					invocation: clone(invocation),
					scope,
					target,
					permission: deepFreeze({
						behavior: "allow" as const,
						decisionId: parsedPermission.data.decisionId,
					}),
					publicApi: this.publicApi,
					signal: options.signal ?? new AbortController().signal,
				},
				timeoutMs,
				options.signal,
			);
			responseBytes = jsonBytes(result, "PROTOCOL_ERROR");
			if (responseBytes > this.maxOutputBytes) {
				throw new PluginToolRegistryError(
					"PAYLOAD_TOO_LARGE",
					"Plugin tool output exceeds byte limit",
				);
			}
			await this.audit({
				entry,
				host,
				capability,
				outcome: "succeeded",
				startedAt,
				requestBytes,
				responseBytes,
				target,
			});
			return result;
		} catch (error) {
			await this.audit({
				entry,
				host,
				capability,
				outcome: auditOutcome(error),
				startedAt,
				requestBytes,
				responseBytes,
				target,
				errorCode: errorCode(error),
			});
			throw error;
		}
	}

	execute(
		fullId: string,
		input: unknown,
		options: PluginToolInvocationOptions = {},
	): Promise<PluginToolResult> {
		return this.invoke(fullId, input, options);
	}

	markUnavailable(fullId: string, reason: string): boolean {
		const entry = this.entries.get(fullId);
		if (!entry) return false;
		entry.descriptor = frozenDescriptor({
			...entry.descriptor,
			status: "unavailable",
			unavailableReason: reason.trim().slice(0, 240) || "Plugin tool is unavailable",
		});
		return true;
	}

	markAvailable(fullId: string): boolean {
		const entry = this.entries.get(fullId);
		if (!entry) return false;
		entry.descriptor = frozenDescriptor({
			...entry.descriptor,
			status: "available",
			unavailableReason: undefined,
		});
		return true;
	}

	disablePlugin(pluginId: string, reason = "plugin-disabled"): number {
		return this.markPluginUnavailable(pluginId, reason);
	}

	runtimeCrashed(pluginId: string, reason = "runtime-crashed"): number {
		return this.markPluginUnavailable(pluginId, reason);
	}

	revokePlugin(pluginId: string, reason = "grant-revoked"): number {
		return this.markPluginUnavailable(pluginId, reason);
	}

	enablePlugin(pluginId: string): number {
		let changed = 0;
		for (const entry of this.entries.values()) {
			if (entry.descriptor.pluginId !== pluginId) continue;
			if (this.markAvailable(entry.descriptor.fullId)) changed += 1;
		}
		return changed;
	}

	removePlugin(pluginId: string): number {
		let removed = 0;
		for (const [fullId, entry] of this.entries) {
			if (entry.descriptor.pluginId !== pluginId) continue;
			this.entries.delete(fullId);
			removed += 1;
		}
		return removed;
	}

	getAuditEntries(): PluginToolAuditEntry[] {
		return this.auditEntries.map((entry) => ({ ...entry }));
	}

	private async executeEntry(
		entry: RegistryEntry,
		input: Record<string, JsonValue>,
		baseContext: Omit<PluginToolHandlerContext, "signal"> & { signal: AbortSignal },
		timeoutMs: number,
		externalSignal?: AbortSignal,
	): Promise<PluginToolResult> {
		const controller = new AbortController();
		const forwardAbort = (): void => controller.abort(externalSignal?.reason ?? "caller-cancelled");
		if (externalSignal?.aborted) forwardAbort();
		else externalSignal?.addEventListener("abort", forwardAbort, { once: true });
		const handler = entry.handler ?? this.defaultHandler;
		const context: PluginToolHandlerContext = {
			...baseContext,
			signal: controller.signal,
		};
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeout = setTimeout(() => {
				reject(new PluginToolRegistryError("TIMEOUT", "Plugin tool execution timed out", true));
				controller.abort("tool-timeout");
			}, timeoutMs);
		});
		const abortPromise = new Promise<never>((_, reject) => {
			if (controller.signal.aborted) {
				reject(abortError(controller.signal.reason));
				return;
			}
			controller.signal.addEventListener(
				"abort",
				() => reject(abortError(controller.signal.reason)),
				{ once: true },
			);
		});
		try {
			const execution = handler
				? Promise.resolve(handler(clone(input), context))
				: this.requestRuntime(entry, input, context, timeoutMs);
			const value = await Promise.race([execution, timeoutPromise, abortPromise]);
			return normalizeResult(value);
		} finally {
			if (timeout) clearTimeout(timeout);
			externalSignal?.removeEventListener("abort", forwardAbort);
		}
	}

	private async requestRuntime(
		entry: RegistryEntry,
		input: Record<string, JsonValue>,
		context: PluginToolHandlerContext,
		timeoutMs: number,
	): Promise<unknown> {
		if (entry.descriptor.execution !== "server") {
			throw new PluginToolRegistryError(
				"HOST_UNAVAILABLE",
				"UI tool contributions require an injected host handler",
			);
		}
		const runtime = await this.resolveRuntime?.(
			entry.descriptor.pluginId,
			entry.descriptor.contributionId,
		);
		if (!runtime) {
			throw new PluginToolRegistryError("HOST_UNAVAILABLE", "Plugin runtime is unavailable", true);
		}
		return runtime.request(
			this.runtimeMethod,
			{
				contributionId: entry.descriptor.contributionId,
				input: clone(input),
				// RPC params must be strictly JSON (jsonValueSchema): strip any
				// undefined fields (e.g. deadlineAt when absent) that would fail
				// the outbound envelope validation ("Cannot enqueue an invalid
				// JSON-RPC envelope").
				context: toStrictJson({
					requestId: context.host.requestId,
					correlationId: context.host.correlationId,
					deadlineAt: context.host.deadlineAt,
					invocation: clone(context.invocation),
					scope: clone(context.scope),
					target: context.target ? clone(context.target) : null,
					permission: clone(context.permission),
				}),
			},
			{ signal: context.signal, timeoutMs },
		);
	}

	private async principalFor(entry: RegistryEntry): Promise<PluginPrincipal> {
		const resolved = await this.resolvePrincipal?.(
			entry.descriptor.pluginId,
			entry.descriptor.contributionId,
		);
		const principal = resolved ?? entry.principal;
		const parsed = pluginPrincipalSchema.safeParse(principal);
		if (!parsed.success || parsed.data.pluginId !== entry.descriptor.pluginId) {
			throw new PluginToolRegistryError(
				"CONTEXT_UNAVAILABLE",
				"Plugin runtime principal is unavailable",
			);
		}
		return { ...parsed.data };
	}

	private createContext(
		plugin: PluginPrincipal,
		invocation: InvocationPrincipal,
		scope: InvocationScope,
		options: PluginToolInvocationOptions,
		deadlineAt: string,
	): HostCallContext {
		const requestId =
			options.requestId ?? options.context?.requestId ?? `tool_req_${generateShortId(16)}`;
		const correlationId =
			options.correlationId ?? options.context?.correlationId ?? `tool_corr_${generateShortId(16)}`;
		if (this.capabilityBroker.withCallContext) {
			return this.capabilityBroker.withCallContext({
				plugin,
				invocation,
				scope,
				requestId,
				correlationId,
				deadlineAt,
			});
		}
		return { requestId, correlationId, deadlineAt, plugin, invocation, scope };
	}

	private timeout(requested: number | undefined): number {
		if (requested === undefined) return this.defaultTimeoutMs;
		if (!Number.isInteger(requested) || requested < 1 || requested > this.maxTimeoutMs) {
			throw new PluginToolRegistryError("INVALID_PARAMS", "Tool timeout is outside host limits");
		}
		return requested;
	}

	private deadline(options: PluginToolInvocationOptions, timeoutMs: number): string {
		const hardDeadline = this.now().getTime() + timeoutMs;
		const requested = options.deadlineAt ?? options.context?.deadlineAt;
		if (!requested) return new Date(hardDeadline).toISOString();
		const parsed = Date.parse(requested);
		if (!Number.isFinite(parsed) || parsed <= this.now().getTime()) {
			throw new PluginToolRegistryError("TIMEOUT", "Tool deadline has expired", true);
		}
		return new Date(Math.min(parsed, hardDeadline)).toISOString();
	}

	private markPluginUnavailable(pluginId: string, reason: string): number {
		let changed = 0;
		for (const entry of this.entries.values()) {
			if (entry.descriptor.pluginId !== pluginId) continue;
			if (this.markUnavailable(entry.descriptor.fullId, reason)) changed += 1;
		}
		return changed;
	}

	private async audit(input: {
		entry: RegistryEntry;
		host?: HostCallContext;
		capability: string;
		outcome: PluginToolAuditOutcome;
		startedAt: number;
		requestBytes: number;
		responseBytes: number;
		target?: Readonly<PluginToolTarget>;
		errorCode?: string;
	}): Promise<void> {
		const entry: PluginToolAuditEntry = {
			pluginId: input.entry.descriptor.pluginId,
			contributionId: input.entry.descriptor.contributionId,
			fullId: input.entry.descriptor.fullId,
			runtimeId: input.host?.plugin.runtimeId,
			requestId: input.host?.requestId,
			correlationId: input.host?.correlationId,
			principalKind: input.host?.invocation.kind,
			methodId: "tools.invoke",
			capability: input.capability,
			outcome: input.outcome,
			durationMs: Math.max(0, this.now().getTime() - input.startedAt),
			requestBytes: input.requestBytes,
			responseBytes: input.responseBytes,
			targetKind: input.target?.kind,
			targetId: input.target?.deviceId,
			errorCode: input.errorCode,
		};
		this.auditEntries.push(entry);
		if (this.auditEntries.length > this.maxAuditEntries) {
			this.auditEntries.splice(0, this.auditEntries.length - this.maxAuditEntries);
		}
		if (!this.auditSink) return;
		try {
			if (typeof this.auditSink === "function") await this.auditSink({ ...entry });
			else await this.auditSink.write({ ...entry });
		} catch {
			// Audit storage must not change the already determined tool result.
		}
	}
}

export const PLUGIN_TOOL_DEFAULT_AUTHORIZATION_CAPABILITY = DEFAULT_AUTHORIZATION_CAPABILITY;
