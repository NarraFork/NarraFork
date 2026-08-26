import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { chapters, narratorMessages, narrators } from "../db/schema";
import { BOOLEAN_OVERRIDE_VALUES, type BooleanOverride } from "../lib/boolean-override";
import { NotFoundError, ValidationError } from "../lib/errors";
import { RESOURCE_SCOPE_FIELD_BY_TYPE, scopeContains } from "../lib/integrations/resource-scope";
import { pluginIdSchema } from "../lib/plugins/manifest";
import type { Capability } from "../lib/plugins/permissions";
import type { JsonValue, PublicErrorCode } from "../lib/plugins/protocol";
import { EXTERNAL_V1_MAX_MESSAGE_CHARS } from "../lib/validators/external";
import { listIntegrationProjects } from "./integration-resource-service";
import { narratorService } from "./narrator-service";
import {
	addSpecTaskForPlugin as addSpecTaskForPluginSession,
	createNarratorForPlugin as createNarratorForPluginSession,
	deleteNarratorForPlugin as deleteNarratorForPluginSession,
	interruptNarrator as interruptNarratorSession,
	readSpecTasksForPlugin as readSpecTasksForPluginSession,
	sendMessage as sendNarratorMessage,
	sendSubagentMessage as sendSubagentMessageToSession,
	setSpecBehaviorFenceForPlugin as setSpecBehaviorFenceForPluginSession,
	updateNarratorProfileForPlugin as updateNarratorProfileForPluginSession,
	writeSpecForPlugin as writeSpecForPluginSession,
} from "./narrator-session";
import {
	type CapabilityAuthorizationRequest as BrokerAuthorizationRequest,
	type AuthorizationResult as BrokerAuthorizationResult,
	type CapabilityResource as BrokerCapabilityResource,
	type HostCallContext,
	hostCallContextSchema,
	type InvocationPrincipal,
	type InvocationScope,
	invocationPrincipalSchema,
	invocationScopeSchema,
	type PluginPrincipal,
	pluginPrincipalSchema,
} from "./plugin-capability-broker";
import type { PluginManager, PluginManagerStatus } from "./plugin-manager";

export type { HostCallContext, InvocationPrincipal, InvocationScope, PluginPrincipal };
export { hostCallContextSchema, invocationPrincipalSchema, pluginPrincipalSchema };

const QUERY_SCHEMA = "narrafork.query-request" as const;
const QUERY_RESULT_SCHEMA = "narrafork.query-result" as const;
const COMMAND_SCHEMA = "narrafork.command-request" as const;
const COMMAND_RESULT_SCHEMA = "narrafork.command-result" as const;
const PUBLIC_API_SCHEMA_VERSION = 1 as const;

const DEFAULT_QUERY_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_BYTES = 256 * 1024;
const DEFAULT_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_JSON_DEPTH = 12;
const DEFAULT_ARRAY_LENGTH = 100;
// Must comfortably exceed DEFAULT_ARRAY_LENGTH × typical row key count: a full
// 100-row narrators.list page (14 keys/row) alone is 1400 keys — 1000 would
// reject every full page (fire-and-forget "too many object keys" for plugins).
const DEFAULT_OBJECT_KEYS = 8_192;
const DEFAULT_STRING_BYTES = 64 * 1024;
const DEFAULT_DIAGNOSTICS = 20;
const DEFAULT_CURSOR_TTL_MS = 15 * 60 * 1000;
const DEFAULT_IDEMPOTENCY_TTL_MS = 60 * 60 * 1000;
const DEFAULT_IDEMPOTENCY_ENTRIES = 1_000;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const MAX_CURSOR_BYTES = 4_096;
const MAX_ID_BYTES = 128;
const MAX_DIAGNOSTIC_MESSAGE_BYTES = 2_048;

const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SENSITIVE_KEYS = new Set([
	"apikey",
	"authorization",
	"backgroundresult",
	"ciphertext",
	"contentjson",
	"cookie",
	"cwd",
	"diagnostics",
	"gitpath",
	"inputjson",
	"jwt",
	"outputjson",
	"password",
	"passphrase",
	"rawdump",
	"rawdumpjson",
	"remoteurl",
	"secret",
	"stderr",
	"systemprompt",
	"token",
	"tokenhash",
	"worktreepath",
]);
const METHOD_ID_PATTERN = /^narrafork(?:\.[A-Za-z0-9_-]+)+$/;

const idSchema = z.string().trim().min(1).max(MAX_ID_BYTES);
const methodIdSchema = idSchema.regex(METHOD_ID_PATTERN, "Invalid public API method id");
const deadlineSchema = z.string().datetime({ offset: true });
const redactionSchema = z.enum(["public", "user_scoped", "admin_scoped"]);
const publicErrorCodeSchema = z.enum([
	"METHOD_NOT_FOUND",
	"INVALID_PARAMS",
	"INVALID_FILTER",
	"PERMISSION_DENIED",
	"CONTEXT_UNAVAILABLE",
	"NOT_FOUND",
	"NOT_FOUND_OR_DENIED",
	"CONFLICT",
	"RATE_LIMITED",
	"PAYLOAD_TOO_LARGE",
	"TIMEOUT",
	"CANCELLED",
	"PLUGIN_DISABLED",
	"HOST_UNAVAILABLE",
	"INTERNAL_ERROR",
	"UNKNOWN_RESULT",
	"PLUGIN_BUSY",
	"PROTOCOL_ERROR",
	"INCOMPATIBLE",
	"CONFIG_CONFLICT",
	"STORAGE_CONFLICT",
	"STORAGE_QUOTA_EXCEEDED",
]);

export const hostInvocationScopeSchema = invocationScopeSchema;
export type HostInvocationScope = InvocationScope;

export const queryRequestSchema = z
	.object({
		schema: z.literal(QUERY_SCHEMA),
		schemaVersion: z.literal(PUBLIC_API_SCHEMA_VERSION),
		queryId: methodIdSchema,
		requestId: idSchema,
		correlationId: idSchema,
		deadlineAt: deadlineSchema,
		input: z.unknown(),
	})
	.strict();

export const commandRequestSchema = z
	.object({
		schema: z.literal(COMMAND_SCHEMA),
		schemaVersion: z.literal(PUBLIC_API_SCHEMA_VERSION),
		commandId: methodIdSchema,
		requestId: idSchema,
		correlationId: idSchema,
		idempotencyKey: z.string().min(1).max(128).optional(),
		expectedVersion: z.number().int().nonnegative().optional(),
		deadlineAt: deadlineSchema,
		input: z.unknown(),
	})
	.strict();

export type QueryRequest = z.infer<typeof queryRequestSchema>;
export type CommandRequest = z.infer<typeof commandRequestSchema>;

export interface PublicApiError {
	code: PublicErrorCode;
	message: string;
	retryable?: boolean;
}

export interface PublicDiagnostic {
	code: string;
	message: string;
	retryable?: boolean;
	field?: string;
}

export interface QueryPage {
	hasMore: boolean;
	nextCursor?: string;
	limit: number;
}

export interface QuerySucceeded<T extends JsonValue = JsonValue> {
	schema: typeof QUERY_RESULT_SCHEMA;
	schemaVersion: typeof PUBLIC_API_SCHEMA_VERSION;
	queryId: string;
	requestId: string;
	correlationId: string;
	status: "succeeded";
	data: T;
	page?: QueryPage;
	asOf?: string;
	stale?: boolean;
	redaction: "public" | "user_scoped" | "admin_scoped";
	diagnostics?: PublicDiagnostic[];
}

export interface QueryFailed {
	schema: typeof QUERY_RESULT_SCHEMA;
	schemaVersion: typeof PUBLIC_API_SCHEMA_VERSION;
	queryId: string;
	requestId: string;
	correlationId: string;
	status: "failed";
	error: PublicApiError;
	redaction: "public" | "user_scoped" | "admin_scoped";
	diagnostics?: PublicDiagnostic[];
}

export type QueryResult<T extends JsonValue = JsonValue> = QuerySucceeded<T> | QueryFailed;

export type CommandStatus =
	| "succeeded"
	| "accepted"
	| "running"
	| "failed"
	| "cancelled"
	| "unknown";

export interface CommandResult<T extends JsonValue = JsonValue> {
	schema: typeof COMMAND_RESULT_SCHEMA;
	schemaVersion: typeof PUBLIC_API_SCHEMA_VERSION;
	commandId: string;
	requestId: string;
	correlationId: string;
	status: CommandStatus;
	data?: T;
	operationId?: string;
	error?: PublicApiError;
	redaction: "public" | "user_scoped" | "admin_scoped";
	diagnostics?: PublicDiagnostic[];
}

const publicDiagnosticSchema = z
	.object({
		code: z.string().trim().min(1).max(128),
		message: z.string().trim().min(1).max(2_048),
		retryable: z.boolean().optional(),
		field: z.string().trim().min(1).max(256).optional(),
	})
	.strict();

const publicErrorSchema = z
	.object({
		code: publicErrorCodeSchema,
		message: z.string().trim().min(1).max(2_048),
		retryable: z.boolean().optional(),
	})
	.strict();

export const queryResultSchema = z.discriminatedUnion("status", [
	z
		.object({
			schema: z.literal(QUERY_RESULT_SCHEMA),
			schemaVersion: z.literal(PUBLIC_API_SCHEMA_VERSION),
			queryId: methodIdSchema,
			requestId: idSchema,
			correlationId: idSchema,
			status: z.literal("succeeded"),
			data: z.unknown(),
			page: z
				.object({
					hasMore: z.boolean(),
					nextCursor: z.string().min(1).max(MAX_CURSOR_BYTES).optional(),
					limit: z.number().int().min(1).max(MAX_PAGE_LIMIT),
				})
				.strict()
				.optional(),
			asOf: deadlineSchema.optional(),
			stale: z.boolean().optional(),
			redaction: redactionSchema,
			diagnostics: z.array(publicDiagnosticSchema).max(DEFAULT_DIAGNOSTICS).optional(),
		})
		.strict(),
	z
		.object({
			schema: z.literal(QUERY_RESULT_SCHEMA),
			schemaVersion: z.literal(PUBLIC_API_SCHEMA_VERSION),
			queryId: methodIdSchema,
			requestId: idSchema,
			correlationId: idSchema,
			status: z.literal("failed"),
			error: publicErrorSchema,
			redaction: redactionSchema,
			diagnostics: z.array(publicDiagnosticSchema).max(DEFAULT_DIAGNOSTICS).optional(),
		})
		.strict(),
]);

export const commandResultSchema = z
	.object({
		schema: z.literal(COMMAND_RESULT_SCHEMA),
		schemaVersion: z.literal(PUBLIC_API_SCHEMA_VERSION),
		commandId: methodIdSchema,
		requestId: idSchema,
		correlationId: idSchema,
		status: z.enum(["succeeded", "accepted", "running", "failed", "cancelled", "unknown"]),
		data: z.unknown().optional(),
		operationId: idSchema.optional(),
		error: publicErrorSchema.optional(),
		redaction: redactionSchema,
		diagnostics: z.array(publicDiagnosticSchema).max(DEFAULT_DIAGNOSTICS).optional(),
	})
	.strict();

export type CapabilityAuthorizationRequest = BrokerAuthorizationRequest;

export type CapabilityAuthorizationDecision =
	| BrokerAuthorizationResult
	| {
			allowed: true;
			constraints?: Readonly<Record<string, JsonValue>>;
			diagnostics?: PublicDiagnostic[];
	  }
	| {
			allowed: false;
			code?: PublicErrorCode;
			reason?: string;
			diagnostics?: PublicDiagnostic[];
	  };

/** Structurally accepts the concrete phase-1 CapabilityBroker and lightweight test brokers. */
export interface CapabilityBroker {
	authorize(request: BrokerAuthorizationRequest): Promise<CapabilityAuthorizationDecision>;
}

type GatewayAuthorizationDecision =
	| {
			allowed: true;
			constraints?: Readonly<Record<string, JsonValue>>;
			diagnostics?: PublicDiagnostic[];
	  }
	| {
			allowed: false;
			code?: PublicErrorCode;
			reason?: string;
			diagnostics?: PublicDiagnostic[];
	  };

export type PublicResource = {
	type:
		| "plugin"
		| "user"
		| "project"
		| "workspace"
		| "chapter"
		| "narrator"
		| "provider"
		| "device";
	id: string;
};

export interface PluginPublicApiAuditEntry {
	pluginId: string;
	contributionId?: string;
	runtimeId: string;
	requestId: string;
	correlationId: string;
	principalKind: InvocationPrincipal["kind"];
	userId?: string;
	operation: "query" | "command";
	methodId: string;
	capability?: string;
	resource?: PublicResource;
	outcome: "denied" | "succeeded" | "failed" | "timeout" | "cancelled" | "unknown";
	durationMs: number;
	requestBytes: number;
	responseBytes: number;
	idempotentReplay?: boolean;
	diagnostics?: PublicDiagnostic[];
}

export interface PluginPublicApiAuditSink {
	write(entry: PluginPublicApiAuditEntry): void | Promise<void>;
}

export interface PluginPublicApiLimits {
	maxRequestBytes: number;
	maxResponseBytes: number;
	maxJsonDepth: number;
	maxArrayLength: number;
	maxObjectKeys: number;
	maxStringBytes: number;
	maxDiagnostics: number;
	queryTimeoutMs: number;
	commandTimeoutMs: number;
	cursorTtlMs: number;
	idempotencyTtlMs: number;
	maxIdempotencyEntries: number;
}

export interface QueryHandlerPage {
	hasMore: boolean;
	limit: number;
	nextPosition?: JsonValue;
}

export interface QueryHandlerResponse<T extends JsonValue = JsonValue> {
	data: T;
	page?: QueryHandlerPage;
	asOf?: string;
	stale?: boolean;
	diagnostics?: PublicDiagnostic[];
}

export interface QueryHandlerContext {
	host: HostCallContext;
	signal: AbortSignal;
	cursor?: JsonValue;
	authorization: Extract<GatewayAuthorizationDecision, { allowed: true }>;
}

export interface CommandHandlerResponse<T extends JsonValue = JsonValue> {
	status?: Exclude<CommandStatus, "failed" | "cancelled" | "unknown">;
	data?: T;
	operationId?: string;
	diagnostics?: PublicDiagnostic[];
}

export interface CommandHandlerContext {
	host: HostCallContext;
	signal: AbortSignal;
	idempotencyKey?: string;
	expectedVersion?: number;
	authorization: Extract<GatewayAuthorizationDecision, { allowed: true }>;
}

export interface QueryDefinition<TInput = unknown, TOutput extends JsonValue = JsonValue> {
	queryId: string;
	capability: Capability;
	inputSchema: z.ZodType<TInput>;
	redaction?: "public" | "user_scoped" | "admin_scoped";
	paginated?: boolean;
	timeoutMs?: number;
	resource?: (input: TInput, context: HostCallContext) => PublicResource | undefined;
	handler: (
		input: TInput,
		context: QueryHandlerContext,
	) => QueryHandlerResponse<TOutput> | Promise<QueryHandlerResponse<TOutput>>;
}

export type CommandSideEffect = "none" | "idempotent" | "non_idempotent";

export interface CommandDefinition<TInput = unknown, TOutput extends JsonValue = JsonValue> {
	commandId: string;
	capability: Capability;
	inputSchema: z.ZodType<TInput>;
	redaction?: "public" | "user_scoped" | "admin_scoped";
	timeoutMs?: number;
	sideEffect: CommandSideEffect;
	idempotency?: "none" | "optional" | "required";
	requiresAdmin?: boolean;
	resource?: (input: TInput, context: HostCallContext) => PublicResource | undefined;
	handler: (
		input: TInput,
		context: CommandHandlerContext,
	) => CommandHandlerResponse<TOutput> | Promise<CommandHandlerResponse<TOutput>>;
}

type AnyQueryDefinition = QueryDefinition<unknown, JsonValue>;
type AnyCommandDefinition = CommandDefinition<unknown, JsonValue>;

function assertMethodId(methodId: string, kind: "query" | "command"): void {
	if (!methodIdSchema.safeParse(methodId).success) {
		throw new Error(`Invalid ${kind} id: ${methodId}`);
	}
}

export class QueryRegistry {
	private readonly definitions = new Map<string, AnyQueryDefinition>();

	register<TInput, TOutput extends JsonValue>(definition: QueryDefinition<TInput, TOutput>): this {
		assertMethodId(definition.queryId, "query");
		if (this.definitions.has(definition.queryId)) {
			throw new Error(`Query is already registered: ${definition.queryId}`);
		}
		if (!definition.inputSchema || typeof definition.handler !== "function") {
			throw new Error(`Query registration is incomplete: ${definition.queryId}`);
		}
		this.definitions.set(definition.queryId, definition as AnyQueryDefinition);
		return this;
	}

	get(queryId: string): AnyQueryDefinition | undefined {
		return this.definitions.get(queryId);
	}

	has(queryId: string): boolean {
		return this.definitions.has(queryId);
	}

	listIds(): string[] {
		return [...this.definitions.keys()].sort();
	}
}

export class CommandRegistry {
	private readonly definitions = new Map<string, AnyCommandDefinition>();

	register<TInput, TOutput extends JsonValue>(
		definition: CommandDefinition<TInput, TOutput>,
	): this {
		assertMethodId(definition.commandId, "command");
		if (this.definitions.has(definition.commandId)) {
			throw new Error(`Command is already registered: ${definition.commandId}`);
		}
		if (!definition.inputSchema || typeof definition.handler !== "function") {
			throw new Error(`Command registration is incomplete: ${definition.commandId}`);
		}
		if (definition.idempotency === "required" && definition.sideEffect === "none") {
			throw new Error(
				`Side-effect-free command cannot require idempotency: ${definition.commandId}`,
			);
		}
		this.definitions.set(definition.commandId, definition as AnyCommandDefinition);
		return this;
	}

	get(commandId: string): AnyCommandDefinition | undefined {
		return this.definitions.get(commandId);
	}

	has(commandId: string): boolean {
		return this.definitions.has(commandId);
	}

	listIds(): string[] {
		return [...this.definitions.keys()].sort();
	}
}

export class PluginPublicApiError extends Error {
	readonly code: PublicErrorCode;
	readonly retryable?: boolean;
	readonly commandStatus: "failed" | "cancelled" | "unknown";

	constructor(
		code: PublicErrorCode,
		message: string,
		options: { retryable?: boolean; commandStatus?: "failed" | "cancelled" | "unknown" } = {},
	) {
		super(message);
		this.name = "PluginPublicApiError";
		this.code = code;
		this.retryable = options.retryable;
		this.commandStatus = options.commandStatus ?? "failed";
	}
}

class DeadlineExceededError extends Error {
	constructor() {
		super("The public API deadline was exceeded");
		this.name = "DeadlineExceededError";
	}
}

class PayloadLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PayloadLimitError";
	}
}

class CursorError extends Error {
	constructor(message = "The cursor is invalid or no longer applicable") {
		super(message);
		this.name = "CursorError";
	}
}

interface JsonLimitState {
	keys: number;
	seen: Set<object>;
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function jsonBytes(value: unknown): number {
	try {
		return utf8Bytes(JSON.stringify(value));
	} catch {
		throw new PayloadLimitError("Payload is not serializable JSON");
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function inspectJsonLimits(
	value: unknown,
	limits: PluginPublicApiLimits,
	label: string,
	depth = 0,
	state: JsonLimitState = { keys: 0, seen: new Set() },
): void {
	if (depth > limits.maxJsonDepth) throw new PayloadLimitError(`${label} exceeds JSON depth limit`);
	if (value === null || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new PayloadLimitError(`${label} contains a non-finite number`);
		return;
	}
	if (typeof value === "string") {
		if (utf8Bytes(value) > limits.maxStringBytes) {
			throw new PayloadLimitError(`${label} contains an oversized string`);
		}
		return;
	}
	if (typeof value !== "object") throw new PayloadLimitError(`${label} is not JSON-safe`);
	if (state.seen.has(value)) throw new PayloadLimitError(`${label} contains a cycle`);
	state.seen.add(value);
	if (Array.isArray(value)) {
		if (value.length > limits.maxArrayLength) {
			throw new PayloadLimitError(`${label} contains an unbounded array`);
		}
		for (const item of value) inspectJsonLimits(item, limits, label, depth + 1, state);
		state.seen.delete(value);
		return;
	}
	if (!isPlainObject(value)) throw new PayloadLimitError(`${label} contains a host object`);
	const entries = Object.entries(value);
	state.keys += entries.length;
	if (state.keys > limits.maxObjectKeys) {
		throw new PayloadLimitError(`${label} contains too many object keys`);
	}
	for (const [key, item] of entries) {
		if (FORBIDDEN_OBJECT_KEYS.has(key))
			throw new PayloadLimitError(`${label} contains a forbidden key`);
		if (utf8Bytes(key) > 256) throw new PayloadLimitError(`${label} contains an oversized key`);
		inspectJsonLimits(item, limits, label, depth + 1, state);
	}
	state.seen.delete(value);
}

function assertNoStrippedKeys(input: unknown, parsed: unknown, path = "input"): void {
	if (Array.isArray(input) && Array.isArray(parsed)) {
		for (let index = 0; index < input.length; index += 1) {
			assertNoStrippedKeys(input[index], parsed[index], `${path}[${index}]`);
		}
		return;
	}
	if (!isPlainObject(input) || !isPlainObject(parsed)) return;
	for (const key of Object.keys(input)) {
		if (!Object.hasOwn(parsed, key)) {
			throw new PluginPublicApiError("INVALID_PARAMS", `Unknown field: ${path}.${key}`);
		}
		assertNoStrippedKeys(input[key], parsed[key], `${path}.${key}`);
	}
}

function normalizeSensitiveKey(key: string): string {
	return key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function isSensitiveKey(key: string): boolean {
	const normalized = normalizeSensitiveKey(key);
	if (SENSITIVE_KEYS.has(normalized)) return true;
	return (
		normalized.endsWith("secret") ||
		normalized.endsWith("token") ||
		normalized.endsWith("password") ||
		normalized.endsWith("passphrase")
	);
}

function sanitizeDiagnosticMessage(message: string): string {
	return message
		.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
		.replace(/(api[_-]?key|token|secret|password|passphrase)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
		.replace(/(?:[A-Za-z]:\\|\/(?:home|Users|tmp|var|etc)\/)[^\s,;]*/g, "[REDACTED_PATH]");
}

function truncateUtf8(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.byteLength <= maxBytes) return value;
	return bytes.subarray(0, maxBytes).toString("utf8");
}

function normalizeDiagnostics(
	diagnostics: readonly PublicDiagnostic[] | undefined,
	limits: PluginPublicApiLimits,
): PublicDiagnostic[] {
	if (!diagnostics?.length) return [];
	return diagnostics.slice(0, limits.maxDiagnostics).map((item) => ({
		code: truncateUtf8(String(item.code || "DIAGNOSTIC"), 128),
		message: truncateUtf8(
			sanitizeDiagnosticMessage(String(item.message || "Diagnostic unavailable")),
			MAX_DIAGNOSTIC_MESSAGE_BYTES,
		),
		retryable: item.retryable,
		field: item.field ? truncateUtf8(item.field, 256) : undefined,
	}));
}

function zodDiagnostics(error: z.ZodError, limits: PluginPublicApiLimits): PublicDiagnostic[] {
	return normalizeDiagnostics(
		error.issues.map((issue) => {
			const unknownKeys =
				"keys" in issue && Array.isArray(issue.keys) ? issue.keys.map(String).join(",") : undefined;
			return {
				code: "INVALID_PARAMS",
				message: issue.message,
				field: issue.path.map(String).join(".") || unknownKeys,
			};
		}),
		limits,
	);
}

function sanitizePublicValue(
	value: unknown,
	limits: PluginPublicApiLimits,
): { value: JsonValue; redactedFields: number } {
	let redactedFields = 0;
	const seen = new Set<object>();
	let objectKeys = 0;

	const visit = (current: unknown, depth: number): JsonValue => {
		if (depth > limits.maxJsonDepth)
			throw new PayloadLimitError("Response exceeds JSON depth limit");
		if (current === null || typeof current === "boolean") return current;
		if (typeof current === "number") {
			if (!Number.isFinite(current))
				throw new PayloadLimitError("Response contains a non-finite number");
			return current;
		}
		if (typeof current === "string") {
			if (utf8Bytes(current) > limits.maxStringBytes) {
				throw new PayloadLimitError("Response contains an oversized string");
			}
			return current;
		}
		if (typeof current !== "object" || current === undefined) {
			throw new PayloadLimitError("Response is not JSON-safe");
		}
		if (seen.has(current)) throw new PayloadLimitError("Response contains a cycle");
		seen.add(current);
		if (Array.isArray(current)) {
			if (current.length > limits.maxArrayLength) {
				throw new PayloadLimitError("Response contains an unbounded array");
			}
			const result = current.map((item) => visit(item, depth + 1));
			seen.delete(current);
			return result;
		}
		if (!isPlainObject(current)) throw new PayloadLimitError("Response contains a host object");
		const output: Record<string, JsonValue> = {};
		const entries = Object.entries(current);
		objectKeys += entries.length;
		if (objectKeys > limits.maxObjectKeys) {
			throw new PayloadLimitError("Response contains too many object keys");
		}
		for (const [key, item] of entries) {
			if (FORBIDDEN_OBJECT_KEYS.has(key))
				throw new PayloadLimitError("Response contains a forbidden key");
			if (isSensitiveKey(key)) {
				redactedFields += 1;
				continue;
			}
			if (item === undefined) continue;
			output[key] = visit(item, depth + 1);
		}
		seen.delete(current);
		return output;
	};

	return { value: visit(value, 0), redactedFields };
}

function stableJson(value: unknown): string {
	const normalize = (current: unknown): unknown => {
		if (Array.isArray(current)) return current.map(normalize);
		if (!isPlainObject(current)) return current;
		return Object.fromEntries(
			Object.keys(current)
				.sort()
				.map((key) => [key, normalize(current[key])]),
		);
	};
	return JSON.stringify(normalize(value));
}

function digest(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("base64url");
}

function contextCursorBinding(context: HostCallContext): unknown {
	return {
		pluginId: context.plugin.pluginId,
		installationId: context.plugin.installationId,
		runtimeGeneration: context.plugin.runtimeGeneration,
		invocationKind: context.invocation.kind,
		userId: context.invocation.userId,
		scope: context.scope,
	};
}

function filterCursorBinding(input: unknown): unknown {
	if (!isPlainObject(input)) return input;
	const { cursor: _cursor, limit: _limit, ...filter } = input;
	return filter;
}

const cursorPayloadSchema = z
	.object({
		v: z.literal(1),
		queryId: methodIdSchema,
		scopeDigest: z.string().length(43),
		filterDigest: z.string().length(43),
		position: z.unknown(),
		expiresAt: z.number().int().positive(),
	})
	.strict();

type CursorPayload = z.infer<typeof cursorPayloadSchema>;

class CursorCodec {
	private readonly secret: Buffer;
	private readonly now: () => Date;
	private readonly ttlMs: number;

	constructor(secret: string | Uint8Array | undefined, now: () => Date, ttlMs: number) {
		this.secret = secret === undefined ? randomBytes(32) : Buffer.from(secret);
		if (this.secret.byteLength < 16)
			throw new Error("Cursor secret must contain at least 16 bytes");
		this.now = now;
		this.ttlMs = ttlMs;
	}

	encode(queryId: string, input: unknown, context: HostCallContext, position: JsonValue): string {
		const payload: CursorPayload = {
			v: 1,
			queryId,
			scopeDigest: digest(contextCursorBinding(context)),
			filterDigest: digest(filterCursorBinding(input)),
			position,
			expiresAt: this.now().getTime() + this.ttlMs,
		};
		const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
		const signature = createHmac("sha256", this.secret).update(encoded).digest("base64url");
		const cursor = `${encoded}.${signature}`;
		if (utf8Bytes(cursor) > MAX_CURSOR_BYTES)
			throw new PayloadLimitError("Cursor exceeds size limit");
		return cursor;
	}

	decode(cursor: string, queryId: string, input: unknown, context: HostCallContext): JsonValue {
		if (utf8Bytes(cursor) > MAX_CURSOR_BYTES) throw new CursorError();
		const parts = cursor.split(".");
		if (parts.length !== 2) throw new CursorError();
		const [encoded, suppliedSignature] = parts;
		const expectedSignature = createHmac("sha256", this.secret).update(encoded).digest();
		let supplied: Buffer;
		let encodedBytes: Buffer;
		try {
			if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]+$/.test(suppliedSignature)) {
				throw new CursorError();
			}
			encodedBytes = Buffer.from(encoded, "base64url");
			supplied = Buffer.from(suppliedSignature, "base64url");
			if (
				encodedBytes.toString("base64url") !== encoded ||
				supplied.toString("base64url") !== suppliedSignature
			) {
				throw new CursorError();
			}
		} catch {
			throw new CursorError();
		}
		if (
			supplied.byteLength !== expectedSignature.byteLength ||
			!timingSafeEqual(supplied, expectedSignature)
		) {
			throw new CursorError();
		}
		let raw: unknown;
		try {
			raw = JSON.parse(encodedBytes.toString("utf8")) as unknown;
		} catch {
			throw new CursorError();
		}
		const parsed = cursorPayloadSchema.safeParse(raw);
		if (!parsed.success) throw new CursorError();
		const payload = parsed.data;
		if (
			payload.queryId !== queryId ||
			payload.scopeDigest !== digest(contextCursorBinding(context)) ||
			payload.filterDigest !== digest(filterCursorBinding(input)) ||
			payload.expiresAt <= this.now().getTime()
		) {
			throw new CursorError();
		}
		return sanitizePublicValue(payload.position, {
			...createLimits(),
			maxResponseBytes: DEFAULT_RESPONSE_BYTES,
		}).value;
	}
}

function createLimits(overrides: Partial<PluginPublicApiLimits> = {}): PluginPublicApiLimits {
	return {
		maxRequestBytes: overrides.maxRequestBytes ?? DEFAULT_REQUEST_BYTES,
		maxResponseBytes: overrides.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES,
		maxJsonDepth: overrides.maxJsonDepth ?? DEFAULT_JSON_DEPTH,
		maxArrayLength: overrides.maxArrayLength ?? DEFAULT_ARRAY_LENGTH,
		maxObjectKeys: overrides.maxObjectKeys ?? DEFAULT_OBJECT_KEYS,
		maxStringBytes: overrides.maxStringBytes ?? DEFAULT_STRING_BYTES,
		maxDiagnostics: overrides.maxDiagnostics ?? DEFAULT_DIAGNOSTICS,
		queryTimeoutMs: overrides.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
		commandTimeoutMs: overrides.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
		cursorTtlMs: overrides.cursorTtlMs ?? DEFAULT_CURSOR_TTL_MS,
		idempotencyTtlMs: overrides.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS,
		maxIdempotencyEntries: overrides.maxIdempotencyEntries ?? DEFAULT_IDEMPOTENCY_ENTRIES,
	};
}

function freezeDeep<T>(value: T): T {
	if (value && typeof value === "object") {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
	}
	return value;
}

function parseContext(value: unknown): HostCallContext {
	return freezeDeep(structuredClone(hostCallContextSchema.parse(value)));
}

function requestMatchesContext(
	request: Pick<QueryRequest, "requestId" | "correlationId" | "deadlineAt">,
	context: HostCallContext,
): boolean {
	return (
		request.requestId === context.requestId &&
		request.correlationId === context.correlationId &&
		request.deadlineAt === context.deadlineAt
	);
}

function safeRawId(value: unknown, fallback: string): string {
	return typeof value === "string" && methodIdSchema.safeParse(value).success ? value : fallback;
}

function safeRequestId(value: unknown, fallback: string): string {
	return typeof value === "string" && idSchema.safeParse(value).success ? value : fallback;
}

function safeErrorMessage(error: PluginPublicApiError): string {
	return truncateUtf8(sanitizeDiagnosticMessage(error.message), MAX_DIAGNOSTIC_MESSAGE_BYTES);
}

function publicError(code: PublicErrorCode, message: string, retryable?: boolean): PublicApiError {
	return {
		code,
		message: truncateUtf8(sanitizeDiagnosticMessage(message), MAX_DIAGNOSTIC_MESSAGE_BYTES),
		retryable,
	};
}

function failedQuery(
	request: Pick<QueryRequest, "queryId" | "requestId" | "correlationId">,
	error: PublicApiError,
	redaction: QueryFailed["redaction"] = "public",
	diagnostics?: PublicDiagnostic[],
): QueryFailed {
	return {
		schema: QUERY_RESULT_SCHEMA,
		schemaVersion: PUBLIC_API_SCHEMA_VERSION,
		queryId: request.queryId,
		requestId: request.requestId,
		correlationId: request.correlationId,
		status: "failed",
		error,
		redaction,
		diagnostics: diagnostics?.length ? diagnostics : undefined,
	};
}

function failedCommand(
	request: Pick<CommandRequest, "commandId" | "requestId" | "correlationId">,
	status: "failed" | "cancelled" | "unknown",
	error: PublicApiError,
	redaction: CommandResult["redaction"] = "public",
	diagnostics?: PublicDiagnostic[],
): CommandResult {
	return {
		schema: COMMAND_RESULT_SCHEMA,
		schemaVersion: PUBLIC_API_SCHEMA_VERSION,
		commandId: request.commandId,
		requestId: request.requestId,
		correlationId: request.correlationId,
		status,
		error,
		redaction,
		diagnostics: diagnostics?.length ? diagnostics : undefined,
	};
}

async function runWithDeadline<T>(
	handler: (signal: AbortSignal) => Promise<T>,
	deadlineAt: string,
	timeoutMs: number,
	now: () => Date,
): Promise<T> {
	const remaining = Date.parse(deadlineAt) - now().getTime();
	const duration = Math.min(timeoutMs, remaining);
	if (!Number.isFinite(duration) || duration <= 0) throw new DeadlineExceededError();
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort(new DeadlineExceededError());
			reject(new DeadlineExceededError());
		}, duration);
	});
	try {
		return await Promise.race([handler(controller.signal), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function parseStrictInput<T>(
	schema: z.ZodType<T>,
	input: unknown,
	limits: PluginPublicApiLimits,
): { success: true; data: T } | { success: false; diagnostics: PublicDiagnostic[] } {
	try {
		inspectJsonLimits(input, limits, "Request input");
	} catch (error) {
		return {
			success: false,
			diagnostics: normalizeDiagnostics(
				[
					{
						code: error instanceof PayloadLimitError ? "PAYLOAD_TOO_LARGE" : "INVALID_PARAMS",
						message: error instanceof Error ? error.message : "Invalid request input",
					},
				],
				limits,
			),
		};
	}
	const parsed = schema.safeParse(input);
	if (!parsed.success) return { success: false, diagnostics: zodDiagnostics(parsed.error, limits) };
	try {
		assertNoStrippedKeys(input, parsed.data);
	} catch (error) {
		return {
			success: false,
			diagnostics: normalizeDiagnostics(
				[
					{
						code: "INVALID_PARAMS",
						message: error instanceof Error ? error.message : "Unknown input field",
					},
				],
				limits,
			),
		};
	}
	return { success: true, data: parsed.data };
}

function redactionDiagnostic(redactedFields: number): PublicDiagnostic[] {
	return redactedFields > 0
		? [
				{
					code: "REDACTED_FIELDS",
					message: `${redactedFields} sensitive field(s) were removed from the public result`,
				},
			]
		: [];
}

function outcomeFromResult(
	result: QueryResult | CommandResult,
): PluginPublicApiAuditEntry["outcome"] {
	if (
		result.status === "succeeded" ||
		result.status === "accepted" ||
		result.status === "running"
	) {
		return "succeeded";
	}
	if (result.status === "unknown") return "unknown";
	if (result.status === "cancelled") return "cancelled";
	if (result.error?.code === "PERMISSION_DENIED") return "denied";
	if (result.error?.code === "TIMEOUT") return "timeout";
	return "failed";
}

function scopeAllowsResource(
	context: HostCallContext,
	resource: PublicResource | undefined,
): boolean {
	if (!resource || resource.type === "plugin") return true;
	// An unbound dimension remains governed by the capability grant. Once the invocation
	// binds a dimension, the shared scope helper enforces exact resource identity.
	const field = RESOURCE_SCOPE_FIELD_BY_TYPE[resource.type] as keyof InvocationScope;
	const boundId = context.scope[field];
	return (
		!boundId ||
		scopeContains({ type: resource.type, id: boundId }, { type: resource.type, id: resource.id })
	);
}

export interface PluginListSource {
	pluginId: string;
	version?: string;
	displayName?: string;
	desiredState: string;
	compatibility: string;
	runtimeState: string;
	installed: boolean;
	packageStatus?: string;
	contributionCount?: number;
	updatedAt?: string;
	diagnosticCodes?: string[];
}

export interface ProjectListSource {
	id: string;
	name: string;
	status: "active" | "archived";
	createdAt: string;
	updatedAt: string;
}

export interface ChapterListSource {
	id: string;
	projectId: string;
	title: string;
	/**
	 * Keeps `frozen` even though the column no longer produces it (see schema.ts).
	 * This is a published plugin contract: narrowing it would turn a request that
	 * used to return an empty list into a validation failure for any plugin still
	 * passing the old value. It simply never matches now.
	 */
	status: "active" | "dormant" | "merged" | "abandoned" | "frozen";
	role: "trunk" | "branch" | "exploration" | "review";
	commitCount: number | null;
	createdAt: string;
	updatedAt: string;
}

export interface PluginListCursor {
	pluginId: string;
}

export interface TimestampCursor {
	updatedAt: string;
	id: string;
}

export interface PluginOwnSource {
	pluginId: string;
	desiredState: string;
	compatibility: string;
	runtimeState: string;
	runtimeGeneration: number;
	current?: { version: string; hash: string } | null;
	grants?: JsonValue;
}

export interface PluginQueryAdapter {
	getOwn?(input: {
		pluginId: string;
		context: HostCallContext;
		signal: AbortSignal;
	}): Promise<PluginOwnSource | undefined>;
	list(input: {
		limit: number;
		after?: PluginListCursor;
		context: HostCallContext;
		signal: AbortSignal;
	}): Promise<PluginListSource[]>;
}

export interface ProjectQueryAdapter {
	list(input: {
		limit: number;
		after?: TimestampCursor;
		status?: Array<"active" | "archived">;
		projectId?: string;
		context: HostCallContext;
		signal: AbortSignal;
	}): Promise<ProjectListSource[]>;
}

export interface ChapterQueryAdapter {
	list(input: {
		limit: number;
		after?: TimestampCursor;
		projectId: string;
		chapterId?: string;
		status?: Array<"active" | "dormant" | "merged" | "abandoned" | "frozen">;
		role?: Array<"trunk" | "branch" | "exploration" | "review">;
		context: HostCallContext;
		signal: AbortSignal;
	}): Promise<ChapterListSource[]>;
}

export interface PluginLifecycleAdapter {
	enable(
		pluginId: string,
		context: HostCallContext,
		signal: AbortSignal,
	): Promise<PluginListSource>;
	disable(
		pluginId: string,
		context: HostCallContext,
		signal: AbortSignal,
	): Promise<PluginListSource>;
}

/**
 * Public narrator summary. A bounded projection of `narrators` joined with its
 * chapter's project; never carries `systemPrompt`, `cwd` or raw JSON columns.
 */
export interface NarratorListSource {
	id: string;
	chapterId: string | null;
	projectId: string | null;
	title: string | null;
	handle: string | null;
	variant: string;
	type: string;
	status: string;
	substatus: string[];
	model: string | null;
	permissionMode: string | null;
	messageCount: number;
	lastMessageAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface NarratorQueryAdapter {
	list(input: {
		limit: number;
		after?: TimestampCursor;
		projectId?: string;
		chapterId?: string;
		status?: Array<"idle" | "working" | "waiting" | "archived">;
		context: HostCallContext;
		signal: AbortSignal;
	}): Promise<NarratorListSource[]>;
	listMessages(input: {
		narratorId: string;
		limit: number;
		context: HostCallContext;
		signal: AbortSignal;
	}): Promise<Array<{ id: string; role: string; text: string | null; createdAt: string }>>;
}

export interface NarratorCommandAdapter {
	sendMessage(input: {
		narratorId: string;
		message: string;
		locale?: "en" | "zh-CN";
		replyInUserLanguage?: boolean;
		pluginId: string;
		context: HostCallContext;
		signal: AbortSignal;
	}): Promise<{ messageId: string }>;
	sendSubagentMessage(input: {
		narratorId: string;
		message: string;
		priority?: boolean;
		locale?: "en" | "zh-CN";
		pluginId: string;
		context: HostCallContext;
		signal: AbortSignal;
	}): Promise<{
		delivered: "buffered" | "started";
		messageId?: string;
		bufferedAt?: string;
		started?: boolean;
	}>;
	createNarrator(input: {
		title?: string;
		model?: string;
		cwd?: string;
		chapterId?: string | null;
		permissionMode?: string;
		planReflectionAutoApproveOverride?: BooleanOverride;
		type?: "primary" | "subagent";
		subagentType?: string;
		parentNarratorId?: string;
		pluginId: string;
		context: HostCallContext;
		signal: AbortSignal;
	}): Promise<{
		narratorId: string;
		title: string | null;
		variant: string;
		type: "primary" | "subagent";
		model: string | null;
		cwd: string | null;
		status: string;
	}>;
	deleteNarrator(input: {
		narratorId: string;
		pluginId: string;
		context: HostCallContext;
		signal: AbortSignal;
	}): Promise<{ deleted: true }>;
	specTasksGet(input: {
		narratorId: string;
		pluginId: string;
		context: HostCallContext;
		signal: AbortSignal;
	}): Promise<{
		content: string;
		revisionId: string | null;
		compiled: {
			tasks: Array<{ text: string; status: string; protected: boolean }>;
			openCount: number;
			protectedOpenCount: number;
		};
	}>;
	specTaskAdd(input: {
		narratorId: string;
		text: string;
		pluginId: string;
		context: HostCallContext;
		signal: AbortSignal;
	}): Promise<{ added: boolean; taskText: string; revisionId: string | null }>;
	specBehaviorFenceUpdate(input: {
		narratorId: string;
		mode: "upsert" | "clear";
		text?: string;
		pluginId: string;
		context: HostCallContext;
		signal: AbortSignal;
	}): Promise<{ updated: boolean; revisionId: string | null }>;
	updateProfile(input: {
		narratorId: string;
		title?: string;
		model?: string;
		reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max" | null;
		planReflectionAutoApproveOverride?: BooleanOverride;
		pluginId: string;
		context: HostCallContext;
		signal: AbortSignal;
	}): Promise<{ updated: string[] }>;
	specWrite(input: {
		narratorId: string;
		uri: string;
		content: string;
		pluginId: string;
		context: HostCallContext;
		signal: AbortSignal;
	}): Promise<{ path: string; uri: string; revisionId: string | null }>;
	interrupt(input: {
		narratorId: string;
		context: HostCallContext;
		signal: AbortSignal;
	}): Promise<{ interrupted: boolean }>;
}

export interface PluginPublicApiAdapters {
	plugins?: PluginQueryAdapter;
	projects?: ProjectQueryAdapter;
	chapters?: ChapterQueryAdapter;
	pluginLifecycle?: PluginLifecycleAdapter;
	narrators?: NarratorQueryAdapter;
	narratorCommands?: NarratorCommandAdapter;
}

const listInputBase = {
	cursor: z.string().min(1).max(MAX_CURSOR_BYTES).optional(),
	limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
};

export const pluginOwnInputSchema = z.object({}).strict();
export const pluginsListInputSchema = z.object(listInputBase).strict();
export const projectsListInputSchema = z
	.object({
		...listInputBase,
		status: z
			.array(z.enum(["active", "archived"]))
			.min(1)
			.max(2)
			.optional(),
	})
	.strict();
export const chaptersListInputSchema = z
	.object({
		...listInputBase,
		projectId: idSchema,
		status: z
			.array(z.enum(["active", "dormant", "merged", "abandoned", "frozen"]))
			.min(1)
			.max(5)
			.optional(),
		role: z
			.array(z.enum(["trunk", "branch", "exploration", "review"]))
			.min(1)
			.max(4)
			.optional(),
	})
	.strict();
export const pluginLifecycleInputSchema = z.object({ pluginId: pluginIdSchema }).strict();
export const narratorsListInputSchema = z
	.object({
		...listInputBase,
		projectId: idSchema.optional(),
		chapterId: idSchema.optional(),
		status: z
			.array(z.enum(["idle", "working", "waiting", "archived"]))
			.min(1)
			.max(4)
			.optional(),
	})
	.strict();
export const narratorSendMessageInputSchema = z
	.object({
		narratorId: idSchema,
		message: z.string().trim().min(1).max(EXTERNAL_V1_MAX_MESSAGE_CHARS),
		locale: z.enum(["en", "zh-CN"]).optional(),
		replyInUserLanguage: z.boolean().optional(),
	})
	.strict();
export const narratorSendSubagentMessageInputSchema = z
	.object({
		narratorId: idSchema,
		message: z.string().trim().min(1).max(EXTERNAL_V1_MAX_MESSAGE_CHARS),
		priority: z.boolean().optional(),
		locale: z.enum(["en", "zh-CN"]).optional(),
	})
	.strict();
export const narratorCreateInputSchema = z
	.object({
		title: z.string().min(1).max(200).optional(),
		model: z.string().min(1).max(200).optional(),
		cwd: z.string().min(1).max(4096).optional(),
		chapterId: idSchema.nullish(),
		permissionMode: z
			.enum(["default", "acceptEdits", "bypassPermissions", "readOnly", "dontAsk"])
			.optional(),
		type: z.enum(["primary", "subagent"]).optional(),
		subagentType: z.string().min(1).max(64).optional(),
		parentNarratorId: idSchema.optional(),
		planReflectionAutoApproveOverride: z.enum(BOOLEAN_OVERRIDE_VALUES).optional(),
	})
	.strict();
export const narratorDeleteInputSchema = z.object({ narratorId: idSchema }).strict();
export const narratorMessagesListInputSchema = z
	.object({
		narratorId: idSchema,
		limit: z.number().int().min(1).max(50).optional(),
	})
	.strict();
export const narratorSpecTasksGetInputSchema = z.object({ narratorId: idSchema }).strict();
export const narratorSpecTaskAddInputSchema = z
	.object({
		narratorId: idSchema,
		text: z.string().trim().min(1).max(1000),
	})
	.strict();
export const narratorSpecBehaviorFenceUpdateInputSchema = z
	.object({
		narratorId: idSchema,
		mode: z.enum(["upsert", "clear"]),
		text: z.string().trim().max(2000).optional(),
	})
	.strict();
export const narratorInterruptInputSchema = z.object({ narratorId: idSchema }).strict();

/** Reasoning effort values accepted for narrator profile updates. */
const narratorReasoningEffortSchema = z
	.enum(["none", "low", "medium", "high", "xhigh", "max"])
	.nullable()
	.optional();

/** Update a narrator's profile and reflection behavior (at least one field). */
export const narratorUpdateProfileInputSchema = z
	.object({
		narratorId: idSchema,
		title: z.string().trim().min(1).max(200).optional(),
		model: z.union([z.literal("__default__"), z.string().trim().min(1).max(200)]).optional(),
		reasoningEffort: narratorReasoningEffortSchema,
		planReflectionAutoApproveOverride: z.enum(BOOLEAN_OVERRIDE_VALUES).optional(),
	})
	.strict()
	.refine(
		(data) =>
			data.title !== undefined ||
			data.model !== undefined ||
			data.reasoningEffort !== undefined ||
			data.planReflectionAutoApproveOverride !== undefined,
		{
			message:
				"At least one of title, model, reasoningEffort or planReflectionAutoApproveOverride must be provided",
		},
	);

/** Spec files a plugin may write through the public API (safety allowlist). */
const SPEC_WRITE_WHITELIST = new Set(["tasks.json", "index.md"]);

/** Write (or replace) a plugin-managed Dynamic Spec file for a narrator. */
export const narratorSpecWriteInputSchema = z
	.object({
		narratorId: idSchema,
		uri: z.string().trim().min(1).max(256),
		content: z.string().max(256 * 1024),
	})
	.strict()
	.refine((data) => SPEC_WRITE_WHITELIST.has(data.uri), {
		message: `uri must be one of: ${[...SPEC_WRITE_WHITELIST].join(", ")}`,
	});

const pluginCursorSchema = z.object({ pluginId: pluginIdSchema }).strict();
const timestampCursorSchema = z.object({ updatedAt: deadlineSchema, id: idSchema }).strict();

function requireAdapter<T>(adapter: T | undefined, name: string): T {
	if (!adapter) {
		throw new PluginPublicApiError("HOST_UNAVAILABLE", `${name} adapter is unavailable`, {
			retryable: true,
		});
	}
	return adapter;
}

function boundedAdapterRows<T>(rows: T[], requestedLimit: number): T[] {
	if (!Array.isArray(rows) || rows.length > requestedLimit) {
		throw new PayloadLimitError("A list adapter returned an unbounded result");
	}
	return rows;
}

function boundedSummaryText(value: string | undefined, maxBytes = 512): string | undefined {
	return value === undefined ? undefined : truncateUtf8(value, maxBytes);
}

function mapPluginSummary(row: PluginListSource): Record<string, JsonValue> {
	return {
		pluginId: row.pluginId,
		version: row.version ?? null,
		displayName: boundedSummaryText(row.displayName) ?? null,
		desiredState: boundedSummaryText(row.desiredState, 64) ?? "unknown",
		compatibility: boundedSummaryText(row.compatibility, 64) ?? "unknown",
		runtimeState: boundedSummaryText(row.runtimeState, 64) ?? "unknown",
		installed: Boolean(row.installed),
		packageStatus: boundedSummaryText(row.packageStatus, 64) ?? null,
		contributionCount: Math.max(0, Math.trunc(row.contributionCount ?? 0)),
		updatedAt: row.updatedAt ?? null,
		diagnosticCodes: (row.diagnosticCodes ?? [])
			.slice(0, 20)
			.map((code) => boundedSummaryText(code, 128) ?? ""),
	};
}

function mapPluginOwn(row: PluginOwnSource): Record<string, JsonValue> {
	return {
		pluginId: row.pluginId,
		desiredState: boundedSummaryText(row.desiredState, 64) ?? "unknown",
		compatibility: boundedSummaryText(row.compatibility, 64) ?? "unknown",
		runtimeState: boundedSummaryText(row.runtimeState, 64) ?? "unknown",
		runtimeGeneration: Math.max(0, Math.trunc(row.runtimeGeneration)),
		current: row.current ?? null,
		grants: row.grants ?? null,
	};
}

function mapProjectSummary(row: ProjectListSource): Record<string, JsonValue> {
	return {
		id: row.id,
		name: boundedSummaryText(row.name, 1_024) ?? "",
		status: row.status,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function mapChapterSummary(row: ChapterListSource): Record<string, JsonValue> {
	return {
		id: row.id,
		projectId: row.projectId,
		title: boundedSummaryText(row.title, 1_024) ?? "",
		status: row.status,
		role: row.role,
		commitCount: Math.max(0, Math.trunc(row.commitCount ?? 0)),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** Parse the `substatus` JSON-array text column defensively; never throw. */
function parseNarratorSubstatus(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === "string").slice(0, 10);
	} catch {
		return [];
	}
}

function mapNarratorSummary(row: NarratorListSource): Record<string, JsonValue> {
	return {
		id: row.id,
		chapterId: row.chapterId ?? null,
		projectId: row.projectId ?? null,
		title: boundedSummaryText(row.title ?? undefined, 1_024) ?? null,
		handle: boundedSummaryText(row.handle ?? undefined, 256) ?? null,
		variant: boundedSummaryText(row.variant, 64) ?? "primary",
		type: boundedSummaryText(row.type, 64) ?? "primary",
		status: boundedSummaryText(row.status, 64) ?? "idle",
		substatus: Array.isArray(row.substatus) ? row.substatus.slice(0, 10) : [],
		model: boundedSummaryText(row.model ?? undefined, 256) ?? null,
		permissionMode: boundedSummaryText(row.permissionMode ?? undefined, 64) ?? null,
		messageCount: Math.max(0, Math.trunc(row.messageCount ?? 0)),
		lastMessageAt: row.lastMessageAt ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function pageResponse<T extends Record<string, JsonValue>>(
	rows: T[],
	limit: number,
	position: (row: T) => JsonValue,
): QueryHandlerResponse<{ items: T[] }> {
	const hasMore = rows.length > limit;
	const items = rows.slice(0, limit);
	return {
		data: { items },
		page: {
			hasMore,
			limit,
			nextPosition: hasMore && items.length > 0 ? position(items[items.length - 1]) : undefined,
		},
	};
}

function pluginStatusSource(status: PluginManagerStatus): PluginListSource {
	return {
		pluginId: status.pluginId,
		version: status.current?.version,
		displayName: status.manifest?.displayName,
		desiredState: status.desiredState,
		compatibility: status.compatibility,
		runtimeState: status.runtimeState,
		installed: status.installed,
		packageStatus: status.packageStatus,
		contributionCount: status.contributions.length,
		updatedAt: status.updatedAt,
		diagnosticCodes: status.diagnostics.slice(0, 20).map((item) => item.code),
	};
}

export interface PluginPublicApiOptions {
	capabilityBroker: CapabilityBroker;
	queryRegistry?: QueryRegistry;
	commandRegistry?: CommandRegistry;
	adapters?: PluginPublicApiAdapters;
	auditSink?: PluginPublicApiAuditSink;
	limits?: Partial<PluginPublicApiLimits>;
	cursorSecret?: string | Uint8Array;
	now?: () => Date;
	registerBuiltIns?: boolean;
}

interface IdempotencyEntry {
	requestDigest: string;
	createdAt: number;
	result: Promise<CommandResult>;
}

export class PluginPublicApi {
	readonly queries: QueryRegistry;
	readonly commands: CommandRegistry;
	readonly limits: PluginPublicApiLimits;
	private readonly capabilityBroker: CapabilityBroker;
	private adapters: PluginPublicApiAdapters;
	private readonly auditSink?: PluginPublicApiAuditSink;
	private readonly now: () => Date;
	private readonly cursorCodec: CursorCodec;
	private readonly idempotency = new Map<string, IdempotencyEntry>();

	constructor(options: PluginPublicApiOptions) {
		this.capabilityBroker = options.capabilityBroker;
		this.queries = options.queryRegistry ?? new QueryRegistry();
		this.commands = options.commandRegistry ?? new CommandRegistry();
		this.adapters = options.adapters ?? {};
		this.auditSink = options.auditSink;
		this.limits = createLimits(options.limits);
		this.now = options.now ?? (() => new Date());
		this.cursorCodec = new CursorCodec(options.cursorSecret, this.now, this.limits.cursorTtlMs);
		if (options.registerBuiltIns !== false) this.registerBuiltIns();
	}

	async query(context: HostCallContext, request: QueryRequest): Promise<QueryResult>;
	async query(request: QueryRequest, context: HostCallContext): Promise<QueryResult>;
	async query(
		first: HostCallContext | QueryRequest,
		second: HostCallContext | QueryRequest,
	): Promise<QueryResult> {
		const [rawContext, rawRequest] = isHostContextShape(first)
			? [first, second as QueryRequest]
			: [second as HostCallContext, first];
		return this.executeQuery(rawContext, rawRequest);
	}

	async command(context: HostCallContext, request: CommandRequest): Promise<CommandResult>;
	async command(request: CommandRequest, context: HostCallContext): Promise<CommandResult>;
	async command(
		first: HostCallContext | CommandRequest,
		second: HostCallContext | CommandRequest,
	): Promise<CommandResult> {
		const [rawContext, rawRequest] = isHostContextShape(first)
			? [first, second as CommandRequest]
			: [second as HostCallContext, first];
		return this.executeCommand(rawContext, rawRequest);
	}

	invokeQuery(context: HostCallContext, request: QueryRequest): Promise<QueryResult> {
		return this.executeQuery(context, request);
	}

	invokeCommand(context: HostCallContext, request: CommandRequest): Promise<CommandResult> {
		return this.executeCommand(context, request);
	}

	/** Late binding keeps one platform API instance while the PluginManager finishes composition. */
	configureAdapters(adapters: PluginPublicApiAdapters): void {
		this.adapters = { ...this.adapters, ...adapters };
	}

	private registerBuiltIns(): void {
		if (!this.queries.has("narrafork.plugin.getOwn")) {
			this.queries.register({
				queryId: "narrafork.plugin.getOwn",
				capability: "query.read.audit_self",
				inputSchema: pluginOwnInputSchema,
				redaction: "admin_scoped",
				resource: (_input, context) => ({ type: "plugin", id: context.plugin.pluginId }),
				handler: async (_input, call) => {
					const adapter = requireAdapter(this.adapters.plugins, "Plugin query");
					if (!adapter.getOwn) {
						throw new PluginPublicApiError(
							"HOST_UNAVAILABLE",
							"Plugin self query adapter is unavailable",
							{ retryable: true },
						);
					}
					const row = await adapter.getOwn({
						pluginId: call.host.plugin.pluginId,
						context: call.host,
						signal: call.signal,
					});
					if (!row) throw new PluginPublicApiError("NOT_FOUND", "Plugin was not found");
					return { data: mapPluginOwn(row) };
				},
			});
		}
		if (!this.queries.has("narrafork.plugins.list")) {
			this.queries.register({
				queryId: "narrafork.plugins.list",
				capability: "query.read.audit_all",
				inputSchema: pluginsListInputSchema,
				redaction: "admin_scoped",
				paginated: true,
				handler: async (input, call) => {
					const adapter = requireAdapter(this.adapters.plugins, "Plugin query");
					const after = call.cursor ? pluginCursorSchema.parse(call.cursor) : undefined;
					const requested = input.limit + 1;
					const rows = boundedAdapterRows(
						await adapter.list({
							limit: requested,
							after,
							context: call.host,
							signal: call.signal,
						}),
						requested,
					).map(mapPluginSummary);
					return pageResponse(rows, input.limit, (row) => ({ pluginId: row.pluginId }));
				},
			});
		}
		if (!this.queries.has("narrafork.projects.list")) {
			this.queries.register({
				queryId: "narrafork.projects.list",
				capability: "query.read.projects",
				inputSchema: projectsListInputSchema,
				redaction: "user_scoped",
				paginated: true,
				handler: async (input, call) => {
					const adapter = requireAdapter(this.adapters.projects, "Project query");
					const after = call.cursor ? timestampCursorSchema.parse(call.cursor) : undefined;
					const requested = input.limit + 1;
					const rows = boundedAdapterRows(
						await adapter.list({
							limit: requested,
							after,
							status: input.status,
							projectId: call.host.scope.projectId,
							context: call.host,
							signal: call.signal,
						}),
						requested,
					).map(mapProjectSummary);
					return pageResponse(rows, input.limit, (row) => ({
						updatedAt: row.updatedAt,
						id: row.id,
					}));
				},
			});
		}
		if (!this.queries.has("narrafork.chapters.list")) {
			this.queries.register({
				queryId: "narrafork.chapters.list",
				capability: "query.read.chapters",
				inputSchema: chaptersListInputSchema,
				redaction: "user_scoped",
				paginated: true,
				resource: (input) => ({ type: "project", id: input.projectId }),
				handler: async (input, call) => {
					const adapter = requireAdapter(this.adapters.chapters, "Chapter query");
					const after = call.cursor ? timestampCursorSchema.parse(call.cursor) : undefined;
					const requested = input.limit + 1;
					// A project-scoped invocation must never list another project's chapters,
					// even if the plugin supplies a different projectId. Mirror projects.list,
					// which always reads the host-bound scope instead of trusting the input.
					const projectId = call.host.scope.projectId ?? input.projectId;
					const rows = boundedAdapterRows(
						await adapter.list({
							limit: requested,
							after,
							projectId,
							chapterId: call.host.scope.chapterId,
							status: input.status,
							role: input.role,
							context: call.host,
							signal: call.signal,
						}),
						requested,
					).map(mapChapterSummary);
					return pageResponse(rows, input.limit, (row) => ({
						updatedAt: row.updatedAt,
						id: row.id,
					}));
				},
			});
		}
		for (const action of ["enable", "disable"] as const) {
			const commandId = `narrafork.plugins.${action}`;
			if (this.commands.has(commandId)) continue;
			this.commands.register({
				commandId,
				capability: `plugin.${action}`,
				inputSchema: pluginLifecycleInputSchema,
				redaction: "admin_scoped",
				sideEffect: "idempotent",
				idempotency: "required",
				requiresAdmin: true,
				resource: (input) => ({ type: "plugin", id: input.pluginId }),
				handler: async (input, call) => {
					const adapter = requireAdapter(this.adapters.pluginLifecycle, "Plugin lifecycle");
					const status = await adapter[action](input.pluginId, call.host, call.signal);
					return { data: mapPluginSummary(status) };
				},
			});
		}
		if (!this.queries.has("narrafork.narrators.list")) {
			this.queries.register({
				queryId: "narrafork.narrators.list",
				capability: "query.read.narrators",
				inputSchema: narratorsListInputSchema,
				redaction: "user_scoped",
				paginated: true,
				resource: (input, context) => {
					const projectId = context.scope.projectId ?? input.projectId;
					return projectId ? { type: "project", id: projectId } : undefined;
				},
				handler: async (input, call) => {
					const adapter = requireAdapter(this.adapters.narrators, "Narrator query");
					const after = call.cursor ? timestampCursorSchema.parse(call.cursor) : undefined;
					const requested = input.limit + 1;
					// A project-scoped invocation must never list another project's narrators,
					// even if the plugin supplies a different projectId. Mirror projects/chapters.
					const projectId = call.host.scope.projectId ?? input.projectId;
					const rows = boundedAdapterRows(
						await adapter.list({
							limit: requested,
							after,
							projectId,
							chapterId: input.chapterId,
							status: input.status,
							context: call.host,
							signal: call.signal,
						}),
						requested,
					).map(mapNarratorSummary);
					return pageResponse(rows, input.limit, (row) => ({
						updatedAt: row.updatedAt,
						id: row.id,
					}));
				},
			});
		}
		if (!this.queries.has("narrafork.narrator.messages.list")) {
			this.queries.register({
				queryId: "narrafork.narrator.messages.list",
				capability: "query.read.narrators",
				inputSchema: narratorMessagesListInputSchema,
				redaction: "user_scoped",
				resource: (input) => ({ type: "narrator", id: input.narratorId }),
				handler: async (input, call) => {
					// Reads back the narrator's recent messages (text + role only —
					// no tool payloads / tokens / cost). Used by team plugins to show
					// a member's latest replies to the leader without opening the
					// chat page. Bounded text per message keeps responses small.
					const adapter = requireAdapter(this.adapters.narrators, "Narrator query");
					const limit = input.limit ?? 10;
					const rows = await adapter.listMessages({
						narratorId: input.narratorId,
						limit,
						context: call.host,
						signal: call.signal,
					});
					return {
						data: {
							narratorId: input.narratorId,
							items: rows.map((row) => ({
								id: row.id,
								role: row.role,
								text:
									row.text === null || row.text === undefined
										? null
										: (boundedSummaryText(row.text, 1000) ?? null),
								createdAt: row.createdAt,
							})),
						},
					};
				},
			});
		}
		if (!this.commands.has("narrafork.narrator.send_message")) {
			this.commands.register({
				commandId: "narrafork.narrator.send_message",
				capability: "command.narrator.send_message",
				inputSchema: narratorSendMessageInputSchema,
				redaction: "user_scoped",
				sideEffect: "non_idempotent",
				idempotency: "optional",
				resource: (input) => ({ type: "narrator", id: input.narratorId }),
				handler: async (input, call) => {
					const adapter = requireAdapter(this.adapters.narratorCommands, "Narrator commands");
					const sent = await adapter.sendMessage({
						narratorId: input.narratorId,
						message: input.message,
						locale: input.locale,
						replyInUserLanguage: input.replyInUserLanguage,
						pluginId: call.host.plugin.pluginId,
						context: call.host,
						signal: call.signal,
					});
					return { data: { accepted: true, messageId: sent.messageId } };
				},
			});
		}
		if (!this.commands.has("narrafork.narrator.send_subagent_message")) {
			this.commands.register({
				commandId: "narrafork.narrator.send_subagent_message",
				capability: "command.narrator.send_subagent_message",
				inputSchema: narratorSendSubagentMessageInputSchema,
				redaction: "user_scoped",
				sideEffect: "non_idempotent",
				idempotency: "optional",
				resource: (input) => ({ type: "narrator", id: input.narratorId }),
				handler: async (input, call) => {
					const adapter = requireAdapter(this.adapters.narratorCommands, "Narrator commands");
					const sent = await adapter.sendSubagentMessage({
						narratorId: input.narratorId,
						message: input.message,
						priority: input.priority,
						locale: input.locale,
						pluginId: call.host.plugin.pluginId,
						context: call.host,
						signal: call.signal,
					});
					return {
						data: {
							delivered: sent.delivered,
							...(sent.messageId ? { messageId: sent.messageId } : {}),
							...(sent.bufferedAt ? { bufferedAt: sent.bufferedAt } : {}),
							...(typeof sent.started === "boolean" ? { started: sent.started } : {}),
						},
					};
				},
			});
		}
		if (!this.commands.has("narrafork.narrator.create")) {
			this.commands.register({
				commandId: "narrafork.narrator.create",
				capability: "command.narrator.create",
				inputSchema: narratorCreateInputSchema,
				redaction: "user_scoped",
				sideEffect: "non_idempotent",
				idempotency: "optional",
				// The narrator does not exist yet; the capability grant is the gate.
				resource: () => undefined,
				handler: async (input, call) => {
					const adapter = requireAdapter(this.adapters.narratorCommands, "Narrator commands");
					const created = await adapter.createNarrator({
						title: input.title,
						model: input.model,
						cwd: input.cwd,
						chapterId: input.chapterId,
						permissionMode: input.permissionMode,
						planReflectionAutoApproveOverride: input.planReflectionAutoApproveOverride,
						type: input.type,
						subagentType: input.subagentType,
						parentNarratorId: input.parentNarratorId,
						pluginId: call.host.plugin.pluginId,
						context: call.host,
						signal: call.signal,
					});
					return { data: created };
				},
			});
		}
		if (!this.commands.has("narrafork.narrator.delete")) {
			this.commands.register({
				commandId: "narrafork.narrator.delete",
				capability: "command.narrator.delete",
				inputSchema: narratorDeleteInputSchema,
				redaction: "user_scoped",
				sideEffect: "non_idempotent",
				idempotency: "optional",
				resource: (input) => ({ type: "narrator", id: input.narratorId }),
				handler: async (input, call) => {
					const adapter = requireAdapter(this.adapters.narratorCommands, "Narrator commands");
					await adapter.deleteNarrator({
						narratorId: input.narratorId,
						pluginId: call.host.plugin.pluginId,
						context: call.host,
						signal: call.signal,
					});
					return { data: { deleted: true } };
				},
			});
		}
		if (!this.commands.has("narrafork.narrator.spec_tasks_get")) {
			this.commands.register({
				commandId: "narrafork.narrator.spec_tasks_get",
				capability: "command.narrator.spec_tasks_get",
				inputSchema: narratorSpecTasksGetInputSchema,
				redaction: "user_scoped",
				sideEffect: "non_idempotent",
				idempotency: "optional",
				resource: (input) => ({ type: "narrator", id: input.narratorId }),
				handler: async (input, call) => {
					const adapter = requireAdapter(this.adapters.narratorCommands, "Narrator commands");
					const result = await adapter.specTasksGet({
						narratorId: input.narratorId,
						pluginId: call.host.plugin.pluginId,
						context: call.host,
						signal: call.signal,
					});
					return { data: result };
				},
			});
		}
		if (!this.commands.has("narrafork.narrator.spec_task_add")) {
			this.commands.register({
				commandId: "narrafork.narrator.spec_task_add",
				capability: "command.narrator.spec_task_add",
				inputSchema: narratorSpecTaskAddInputSchema,
				redaction: "user_scoped",
				sideEffect: "non_idempotent",
				idempotency: "optional",
				resource: (input) => ({ type: "narrator", id: input.narratorId }),
				handler: async (input, call) => {
					const adapter = requireAdapter(this.adapters.narratorCommands, "Narrator commands");
					const result = await adapter.specTaskAdd({
						narratorId: input.narratorId,
						text: input.text,
						pluginId: call.host.plugin.pluginId,
						context: call.host,
						signal: call.signal,
					});
					return { data: result };
				},
			});
		}
		if (!this.commands.has("narrafork.narrator.spec_behavior_fence_update")) {
			this.commands.register({
				commandId: "narrafork.narrator.spec_behavior_fence_update",
				capability: "command.narrator.spec_behavior_fence_update",
				inputSchema: narratorSpecBehaviorFenceUpdateInputSchema,
				redaction: "user_scoped",
				sideEffect: "non_idempotent",
				idempotency: "optional",
				resource: (input) => ({ type: "narrator", id: input.narratorId }),
				handler: async (input, call) => {
					const adapter = requireAdapter(this.adapters.narratorCommands, "Narrator commands");
					const result = await adapter.specBehaviorFenceUpdate({
						narratorId: input.narratorId,
						mode: input.mode,
						text: input.text,
						pluginId: call.host.plugin.pluginId,
						context: call.host,
						signal: call.signal,
					});
					return { data: result };
				},
			});
		}
		if (!this.commands.has("narrafork.narrator.spec_write")) {
			this.commands.register({
				commandId: "narrafork.narrator.spec_write",
				capability: "command.narrator.spec_write",
				inputSchema: narratorSpecWriteInputSchema,
				redaction: "user_scoped",
				sideEffect: "non_idempotent",
				idempotency: "optional",
				resource: (input) => ({ type: "narrator", id: input.narratorId }),
				handler: async (input, call) => {
					const adapter = requireAdapter(this.adapters.narratorCommands, "Narrator commands");
					const result = await adapter.specWrite({
						narratorId: input.narratorId,
						uri: input.uri,
						content: input.content,
						pluginId: call.host.plugin.pluginId,
						context: call.host,
						signal: call.signal,
					});
					return { data: result };
				},
			});
		}
		if (!this.commands.has("narrafork.narrator.update_profile")) {
			this.commands.register({
				commandId: "narrafork.narrator.update_profile",
				capability: "command.narrator.update_profile",
				inputSchema: narratorUpdateProfileInputSchema,
				redaction: "user_scoped",
				sideEffect: "non_idempotent",
				idempotency: "optional",
				resource: (input) => ({ type: "narrator", id: input.narratorId }),
				handler: async (input, call) => {
					const adapter = requireAdapter(this.adapters.narratorCommands, "Narrator commands");
					const result = await adapter.updateProfile({
						narratorId: input.narratorId,
						...(input.title !== undefined ? { title: input.title } : {}),
						...(input.model !== undefined ? { model: input.model } : {}),
						...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
						...(input.planReflectionAutoApproveOverride !== undefined
							? { planReflectionAutoApproveOverride: input.planReflectionAutoApproveOverride }
							: {}),
						pluginId: call.host.plugin.pluginId,
						context: call.host,
						signal: call.signal,
					});
					return { data: result };
				},
			});
		}
		if (!this.commands.has("narrafork.narrator.interrupt")) {
			this.commands.register({
				commandId: "narrafork.narrator.interrupt",
				capability: "command.narrator.interrupt",
				inputSchema: narratorInterruptInputSchema,
				redaction: "user_scoped",
				sideEffect: "idempotent",
				idempotency: "optional",
				resource: (input) => ({ type: "narrator", id: input.narratorId }),
				handler: async (input, call) => {
					const adapter = requireAdapter(this.adapters.narratorCommands, "Narrator commands");
					const result = await adapter.interrupt({
						narratorId: input.narratorId,
						context: call.host,
						signal: call.signal,
					});
					return { data: { interrupted: result.interrupted } };
				},
			});
		}
	}

	private async executeQuery(rawContext: unknown, rawRequest: unknown): Promise<QueryResult> {
		const startedAt = this.now().getTime();
		let context: HostCallContext;
		try {
			context = parseContext(rawContext);
		} catch {
			const fallback = {
				queryId: safeRawId(
					isPlainObject(rawRequest) ? rawRequest.queryId : undefined,
					"narrafork.unknown.query",
				),
				requestId: safeRequestId(
					isPlainObject(rawRequest) ? rawRequest.requestId : undefined,
					"invalid-request",
				),
				correlationId: safeRequestId(
					isPlainObject(rawRequest) ? rawRequest.correlationId : undefined,
					"invalid-correlation",
				),
			};
			return failedQuery(
				fallback,
				publicError("CONTEXT_UNAVAILABLE", "Host call context is invalid"),
			);
		}

		const outer = queryRequestSchema.safeParse(rawRequest);
		if (!outer.success) {
			const request = {
				queryId: safeRawId(
					isPlainObject(rawRequest) ? rawRequest.queryId : undefined,
					"narrafork.unknown.query",
				),
				requestId: context.requestId,
				correlationId: context.correlationId,
			};
			const result = failedQuery(
				request,
				publicError("INVALID_PARAMS", "Invalid query request envelope"),
				"public",
				zodDiagnostics(outer.error, this.limits),
			);
			await this.audit(context, undefined, undefined, result, startedAt, rawRequest, false);
			return result;
		}
		const request = outer.data;
		if (!requestMatchesContext(request, context)) {
			const result = failedQuery(
				request,
				publicError(
					"CONTEXT_UNAVAILABLE",
					"Request identity does not match the bound host context",
				),
			);
			await this.audit(context, undefined, undefined, result, startedAt, request, false);
			return result;
		}
		try {
			if (jsonBytes(request) > this.limits.maxRequestBytes)
				throw new PayloadLimitError("Query request exceeds byte limit");
		} catch (error) {
			const result = failedQuery(
				request,
				publicError(
					"PAYLOAD_TOO_LARGE",
					error instanceof Error ? error.message : "Query request is too large",
				),
			);
			await this.audit(context, undefined, undefined, result, startedAt, request, false);
			return result;
		}

		const definition = this.queries.get(request.queryId);
		let parsedInput: unknown = request.input;
		let resource: PublicResource | undefined;
		if (definition) {
			const parsed = parseStrictInput(definition.inputSchema, request.input, this.limits);
			if (!parsed.success) {
				const result = failedQuery(
					request,
					publicError(
						parsed.diagnostics.some((item) => item.code === "PAYLOAD_TOO_LARGE")
							? "PAYLOAD_TOO_LARGE"
							: "INVALID_PARAMS",
						"Query input failed strict validation",
					),
					definition.redaction,
					parsed.diagnostics,
				);
				await this.audit(context, definition, undefined, result, startedAt, request, false);
				return result;
			}
			parsedInput = parsed.data;
			resource = definition.resource?.(parsed.data, context);
		}

		const authorization = await this.authorize(
			context,
			"query",
			request.queryId,
			definition?.capability,
			resource,
			jsonBytes(request),
		);
		if (!authorization.allowed) {
			const result = failedQuery(
				request,
				publicError(
					authorization.code ?? "PERMISSION_DENIED",
					authorization.reason ?? "The query is not authorized",
				),
				definition?.redaction,
				normalizeDiagnostics(authorization.diagnostics, this.limits),
			);
			await this.audit(context, definition, resource, result, startedAt, request, false);
			return result;
		}
		if (!definition) {
			const result = failedQuery(
				request,
				publicError("METHOD_NOT_FOUND", "Unknown public query id"),
			);
			await this.audit(context, undefined, resource, result, startedAt, request, false);
			return result;
		}
		if (!scopeAllowsResource(context, resource)) {
			const result = failedQuery(
				request,
				publicError("NOT_FOUND_OR_DENIED", "The resource is outside the bound invocation scope"),
				definition.redaction,
			);
			await this.audit(context, definition, resource, result, startedAt, request, false);
			return result;
		}

		let cursor: JsonValue | undefined;
		try {
			if (
				definition.paginated &&
				isPlainObject(parsedInput) &&
				typeof parsedInput.cursor === "string"
			) {
				cursor = this.cursorCodec.decode(parsedInput.cursor, request.queryId, parsedInput, context);
			}
			const handlerResponse = await runWithDeadline(
				(signal) =>
					Promise.resolve(
						definition.handler(parsedInput, {
							host: context,
							signal,
							cursor,
							authorization,
						}),
					),
				request.deadlineAt,
				definition.timeoutMs ?? this.limits.queryTimeoutMs,
				this.now,
			);
			const sanitized = sanitizePublicValue(handlerResponse.data, this.limits);
			const diagnostics = normalizeDiagnostics(
				[
					...(authorization.diagnostics ?? []),
					...(handlerResponse.diagnostics ?? []),
					...redactionDiagnostic(sanitized.redactedFields),
				],
				this.limits,
			);
			let page: QueryPage | undefined;
			if (handlerResponse.page) {
				const pageDefinition = handlerResponse.page;
				if (
					!definition.paginated ||
					pageDefinition.limit < 1 ||
					pageDefinition.limit > MAX_PAGE_LIMIT ||
					(pageDefinition.hasMore && pageDefinition.nextPosition === undefined)
				) {
					throw new PluginPublicApiError(
						"INTERNAL_ERROR",
						"Query handler returned an invalid page",
					);
				}
				page = {
					hasMore: pageDefinition.hasMore,
					limit: pageDefinition.limit,
					nextCursor: pageDefinition.hasMore
						? this.cursorCodec.encode(
								request.queryId,
								parsedInput,
								context,
								pageDefinition.nextPosition as JsonValue,
							)
						: undefined,
				};
			}
			const result: QuerySucceeded = {
				schema: QUERY_RESULT_SCHEMA,
				schemaVersion: PUBLIC_API_SCHEMA_VERSION,
				queryId: request.queryId,
				requestId: request.requestId,
				correlationId: request.correlationId,
				status: "succeeded",
				data: sanitized.value,
				page,
				asOf: handlerResponse.asOf ?? this.now().toISOString(),
				stale: handlerResponse.stale,
				redaction: definition.redaction ?? "public",
				diagnostics: diagnostics.length ? diagnostics : undefined,
			};
			if (jsonBytes(result) > this.limits.maxResponseBytes) {
				throw new PayloadLimitError("Query result exceeds byte limit");
			}
			await this.audit(context, definition, resource, result, startedAt, request, false);
			return result;
		} catch (error) {
			const result = this.queryErrorResult(request, definition, error, authorization.diagnostics);
			await this.audit(context, definition, resource, result, startedAt, request, false);
			return result;
		}
	}

	private async executeCommand(rawContext: unknown, rawRequest: unknown): Promise<CommandResult> {
		const startedAt = this.now().getTime();
		let context: HostCallContext;
		try {
			context = parseContext(rawContext);
		} catch {
			const fallback = {
				commandId: safeRawId(
					isPlainObject(rawRequest) ? rawRequest.commandId : undefined,
					"narrafork.unknown.command",
				),
				requestId: safeRequestId(
					isPlainObject(rawRequest) ? rawRequest.requestId : undefined,
					"invalid-request",
				),
				correlationId: safeRequestId(
					isPlainObject(rawRequest) ? rawRequest.correlationId : undefined,
					"invalid-correlation",
				),
			};
			return failedCommand(
				fallback,
				"failed",
				publicError("CONTEXT_UNAVAILABLE", "Host call context is invalid"),
			);
		}
		const outer = commandRequestSchema.safeParse(rawRequest);
		if (!outer.success) {
			const request = {
				commandId: safeRawId(
					isPlainObject(rawRequest) ? rawRequest.commandId : undefined,
					"narrafork.unknown.command",
				),
				requestId: context.requestId,
				correlationId: context.correlationId,
			};
			const result = failedCommand(
				request,
				"failed",
				publicError("INVALID_PARAMS", "Invalid command request envelope"),
				"public",
				zodDiagnostics(outer.error, this.limits),
			);
			await this.audit(context, undefined, undefined, result, startedAt, rawRequest, false);
			return result;
		}
		const request = outer.data;
		if (!requestMatchesContext(request, context)) {
			const result = failedCommand(
				request,
				"failed",
				publicError(
					"CONTEXT_UNAVAILABLE",
					"Request identity does not match the bound host context",
				),
			);
			await this.audit(context, undefined, undefined, result, startedAt, request, false);
			return result;
		}
		try {
			if (jsonBytes(request) > this.limits.maxRequestBytes) {
				throw new PayloadLimitError("Command request exceeds byte limit");
			}
		} catch (error) {
			const result = failedCommand(
				request,
				"failed",
				publicError(
					"PAYLOAD_TOO_LARGE",
					error instanceof Error ? error.message : "Command request is too large",
				),
			);
			await this.audit(context, undefined, undefined, result, startedAt, request, false);
			return result;
		}

		const definition = this.commands.get(request.commandId);
		let parsedInput: unknown = request.input;
		let resource: PublicResource | undefined;
		if (definition) {
			const parsed = parseStrictInput(definition.inputSchema, request.input, this.limits);
			if (!parsed.success) {
				const result = failedCommand(
					request,
					"failed",
					publicError(
						parsed.diagnostics.some((item) => item.code === "PAYLOAD_TOO_LARGE")
							? "PAYLOAD_TOO_LARGE"
							: "INVALID_PARAMS",
						"Command input failed strict validation",
					),
					definition.redaction,
					parsed.diagnostics,
				);
				await this.audit(context, definition, undefined, result, startedAt, request, false);
				return result;
			}
			parsedInput = parsed.data;
			resource = definition.resource?.(parsed.data, context);
		}

		const authorization = await this.authorize(
			context,
			"command",
			request.commandId,
			definition?.capability,
			resource,
			jsonBytes(request),
		);
		if (!authorization.allowed) {
			const result = failedCommand(
				request,
				"failed",
				publicError(
					authorization.code ?? "PERMISSION_DENIED",
					authorization.reason ?? "The command is not authorized",
				),
				definition?.redaction,
				normalizeDiagnostics(authorization.diagnostics, this.limits),
			);
			await this.audit(context, definition, resource, result, startedAt, request, false);
			return result;
		}
		if (!definition) {
			const result = failedCommand(
				request,
				"failed",
				publicError("METHOD_NOT_FOUND", "Unknown public command id"),
			);
			await this.audit(context, undefined, resource, result, startedAt, request, false);
			return result;
		}
		if (!scopeAllowsResource(context, resource)) {
			const result = failedCommand(
				request,
				"failed",
				publicError("NOT_FOUND_OR_DENIED", "The resource is outside the bound invocation scope"),
				definition.redaction,
			);
			await this.audit(context, definition, resource, result, startedAt, request, false);
			return result;
		}
		if (
			definition.requiresAdmin &&
			(context.invocation.kind !== "user" || context.invocation.userRole !== "admin")
		) {
			const result = failedCommand(
				request,
				"failed",
				publicError(
					"PERMISSION_DENIED",
					"This host command requires an administrator user invocation",
				),
				definition.redaction,
			);
			await this.audit(context, definition, resource, result, startedAt, request, false);
			return result;
		}
		if (definition.idempotency === "required" && !request.idempotencyKey) {
			const result = failedCommand(
				request,
				"failed",
				publicError("INVALID_PARAMS", "This command requires an idempotency key"),
				definition.redaction,
			);
			await this.audit(context, definition, resource, result, startedAt, request, false);
			return result;
		}

		const execute = () =>
			this.runCommandHandler(context, request, definition, parsedInput, authorization);
		if (!request.idempotencyKey || definition.idempotency === "none") {
			const result = await execute();
			await this.audit(context, definition, resource, result, startedAt, request, false);
			return result;
		}

		this.pruneIdempotency();
		const cacheKey = digest({
			pluginId: context.plugin.pluginId,
			installationId: context.plugin.installationId,
			commandId: request.commandId,
			invocationKind: context.invocation.kind,
			userId: context.invocation.userId,
			scope: context.scope,
			idempotencyKey: request.idempotencyKey,
		});
		const requestDigest = digest({ input: parsedInput, expectedVersion: request.expectedVersion });
		const existing = this.idempotency.get(cacheKey);
		if (existing) {
			if (existing.requestDigest !== requestDigest) {
				const result = failedCommand(
					request,
					"failed",
					publicError("CONFLICT", "Idempotency key was already used with different input"),
					definition.redaction,
				);
				await this.audit(context, definition, resource, result, startedAt, request, true);
				return result;
			}
			const replayed = this.rebindCommandResult(await existing.result, request, true);
			await this.audit(context, definition, resource, replayed, startedAt, request, true);
			return replayed;
		}
		const resultPromise = execute();
		this.idempotency.set(cacheKey, {
			requestDigest,
			createdAt: this.now().getTime(),
			result: resultPromise,
		});
		const result = await resultPromise;
		await this.audit(context, definition, resource, result, startedAt, request, false);
		return result;
	}

	private async runCommandHandler(
		context: HostCallContext,
		request: CommandRequest,
		definition: AnyCommandDefinition,
		input: unknown,
		authorization: Extract<GatewayAuthorizationDecision, { allowed: true }>,
	): Promise<CommandResult> {
		try {
			const response = await runWithDeadline(
				(signal) =>
					Promise.resolve(
						definition.handler(input, {
							host: context,
							signal,
							idempotencyKey: request.idempotencyKey,
							expectedVersion: request.expectedVersion,
							authorization,
						}),
					),
				request.deadlineAt,
				definition.timeoutMs ?? this.limits.commandTimeoutMs,
				this.now,
			);
			const sanitized = sanitizePublicValue(response.data ?? {}, this.limits);
			const diagnostics = normalizeDiagnostics(
				[
					...(authorization.diagnostics ?? []),
					...(response.diagnostics ?? []),
					...redactionDiagnostic(sanitized.redactedFields),
				],
				this.limits,
			);
			const result: CommandResult = {
				schema: COMMAND_RESULT_SCHEMA,
				schemaVersion: PUBLIC_API_SCHEMA_VERSION,
				commandId: request.commandId,
				requestId: request.requestId,
				correlationId: request.correlationId,
				status: response.status ?? "succeeded",
				data: sanitized.value,
				operationId: response.operationId,
				redaction: definition.redaction ?? "public",
				diagnostics: diagnostics.length ? diagnostics : undefined,
			};
			if (jsonBytes(result) > this.limits.maxResponseBytes) {
				throw new PayloadLimitError("Command result exceeds byte limit");
			}
			return result;
		} catch (error) {
			return this.commandErrorResult(request, definition, error, authorization.diagnostics);
		}
	}

	private queryErrorResult(
		request: QueryRequest,
		definition: AnyQueryDefinition,
		error: unknown,
		authorizationDiagnostics?: PublicDiagnostic[],
	): QueryFailed {
		const diagnostics = normalizeDiagnostics(authorizationDiagnostics, this.limits);
		if (error instanceof CursorError || error instanceof z.ZodError) {
			return failedQuery(
				request,
				publicError("INVALID_PARAMS", "The query cursor is invalid or has been tampered with"),
				definition.redaction,
				[...diagnostics, { code: "CURSOR_INVALID", message: "Cursor validation failed" }],
			);
		}
		if (error instanceof DeadlineExceededError) {
			return failedQuery(
				request,
				publicError("TIMEOUT", "The query deadline was exceeded", true),
				definition.redaction,
				diagnostics,
			);
		}
		if (error instanceof PayloadLimitError) {
			return failedQuery(
				request,
				publicError("PAYLOAD_TOO_LARGE", error.message),
				definition.redaction,
				diagnostics,
			);
		}
		if (error instanceof PluginPublicApiError) {
			return failedQuery(
				request,
				publicError(error.code, safeErrorMessage(error), error.retryable),
				definition.redaction,
				diagnostics,
			);
		}
		return failedQuery(
			request,
			publicError("INTERNAL_ERROR", "The query failed inside the host"),
			definition.redaction,
			diagnostics,
		);
	}

	private commandErrorResult(
		request: CommandRequest,
		definition: AnyCommandDefinition,
		error: unknown,
		authorizationDiagnostics?: PublicDiagnostic[],
	): CommandResult {
		const diagnostics = normalizeDiagnostics(authorizationDiagnostics, this.limits);
		if (error instanceof DeadlineExceededError) {
			if (definition.sideEffect === "none") {
				return failedCommand(
					request,
					"failed",
					publicError("TIMEOUT", "The command deadline was exceeded", true),
					definition.redaction,
					diagnostics,
				);
			}
			return failedCommand(
				request,
				"unknown",
				publicError(
					"UNKNOWN_RESULT",
					"The command deadline expired after dispatch; the host will not replay it automatically",
				),
				definition.redaction,
				diagnostics,
			);
		}
		if (error instanceof PluginPublicApiError) {
			return failedCommand(
				request,
				error.commandStatus,
				publicError(error.code, safeErrorMessage(error), error.retryable),
				definition.redaction,
				diagnostics,
			);
		}
		if (error instanceof PayloadLimitError) {
			return failedCommand(
				request,
				definition.sideEffect === "none" ? "failed" : "unknown",
				publicError(
					definition.sideEffect === "none" ? "PAYLOAD_TOO_LARGE" : "UNKNOWN_RESULT",
					definition.sideEffect === "none"
						? error.message
						: "The command completed without a bounded public result; it will not be replayed automatically",
				),
				definition.redaction,
				diagnostics,
			);
		}
		if (definition.sideEffect !== "none") {
			return failedCommand(
				request,
				"unknown",
				publicError(
					"UNKNOWN_RESULT",
					"The host could not confirm the command outcome and will not replay it automatically",
				),
				definition.redaction,
				diagnostics,
			);
		}
		return failedCommand(
			request,
			"failed",
			publicError("INTERNAL_ERROR", "The command failed inside the host"),
			definition.redaction,
			diagnostics,
		);
	}

	private async authorize(
		context: HostCallContext,
		operation: "query" | "command",
		methodId: string,
		capability: Capability | undefined,
		resource: PublicResource | undefined,
		requestBytes: number,
	): Promise<GatewayAuthorizationDecision> {
		try {
			const brokerResource: BrokerCapabilityResource | undefined =
				resource && resource.type !== "plugin"
					? { type: resource.type, id: resource.id }
					: undefined;
			const decision = await this.capabilityBroker.authorize({
				context,
				capability:
					capability ?? (operation === "query" ? "query.read.host_settings" : "plugin.enable"),
				methodId,
				scope: context.scope,
				resource: brokerResource,
				constraints: resource?.type === "plugin" ? { resourceId: resource.id } : undefined,
				requestBytes,
				responseBytes: 0,
			});
			if (decision.allowed) {
				if ("grant" in decision) {
					return {
						allowed: true,
						diagnostics: decision.cacheHit
							? [
									{
										code: "CAPABILITY_CACHE_HIT",
										message: "Capability authorization used a current cached decision",
									},
								]
							: undefined,
					};
				}
				return decision;
			}
			if ("error" in decision) {
				const parsedCode = publicErrorCodeSchema.safeParse(decision.error.code);
				return {
					allowed: false,
					code: parsedCode.success ? parsedCode.data : "PERMISSION_DENIED",
					reason: "The capability broker denied this public API call",
					diagnostics: [
						{
							code: decision.error.reason,
							message: "Capability authorization failed",
						},
					],
				};
			}
			return decision;
		} catch {
			return {
				allowed: false,
				code: "HOST_UNAVAILABLE",
				reason: "Capability authorization is temporarily unavailable",
				diagnostics: [
					{
						code: "CAPABILITY_BROKER_FAILED",
						message: "The host could not complete authorization",
						retryable: true,
					},
				],
			};
		}
	}

	private rebindCommandResult(
		result: CommandResult,
		request: CommandRequest,
		replayed: boolean,
	): CommandResult {
		const diagnostics = normalizeDiagnostics(
			[
				...(result.diagnostics ?? []),
				...(replayed
					? [
							{
								code: "IDEMPOTENT_REPLAY",
								message: "A previous result was returned for this idempotency key",
							},
						]
					: []),
			],
			this.limits,
		);
		return {
			...structuredClone(result),
			requestId: request.requestId,
			correlationId: request.correlationId,
			diagnostics: diagnostics.length ? diagnostics : undefined,
		};
	}

	private pruneIdempotency(): void {
		const expiresBefore = this.now().getTime() - this.limits.idempotencyTtlMs;
		for (const [key, entry] of this.idempotency) {
			if (entry.createdAt <= expiresBefore) this.idempotency.delete(key);
		}
		while (this.idempotency.size >= this.limits.maxIdempotencyEntries) {
			const oldest = this.idempotency.keys().next().value as string | undefined;
			if (!oldest) break;
			this.idempotency.delete(oldest);
		}
	}

	private async audit(
		context: HostCallContext,
		definition: AnyQueryDefinition | AnyCommandDefinition | undefined,
		resource: PublicResource | undefined,
		result: QueryResult | CommandResult,
		startedAt: number,
		request: unknown,
		idempotentReplay: boolean,
	): Promise<void> {
		if (!this.auditSink) return;
		let requestBytes = 0;
		let responseBytes = 0;
		try {
			requestBytes = jsonBytes(request);
		} catch {
			requestBytes = this.limits.maxRequestBytes;
		}
		try {
			responseBytes = jsonBytes(result);
		} catch {
			responseBytes = this.limits.maxResponseBytes;
		}
		try {
			await this.auditSink.write({
				pluginId: context.plugin.pluginId,
				contributionId: context.plugin.contributionId,
				runtimeId: context.plugin.runtimeId,
				requestId: result.requestId,
				correlationId: result.correlationId,
				principalKind: context.invocation.kind,
				userId: context.invocation.userId,
				operation: result.schema === QUERY_RESULT_SCHEMA ? "query" : "command",
				methodId: result.schema === QUERY_RESULT_SCHEMA ? result.queryId : result.commandId,
				capability: definition?.capability,
				resource,
				outcome: outcomeFromResult(result),
				durationMs: Math.max(0, this.now().getTime() - startedAt),
				requestBytes,
				responseBytes,
				idempotentReplay: idempotentReplay || undefined,
				diagnostics: normalizeDiagnostics(result.diagnostics, this.limits),
			});
		} catch {
			// Audit storage must never alter the already-determined public API result.
		}
	}
}

function isHostContextShape(value: unknown): value is HostCallContext {
	return isPlainObject(value) && isPlainObject(value.plugin) && isPlainObject(value.invocation);
}

export function createQueryRequest<T>(
	context: HostCallContext,
	queryId: string,
	input: T,
): QueryRequest {
	return {
		schema: QUERY_SCHEMA,
		schemaVersion: PUBLIC_API_SCHEMA_VERSION,
		queryId,
		requestId: context.requestId,
		correlationId: context.correlationId,
		deadlineAt: context.deadlineAt,
		input,
	};
}

export function createCommandRequest<T>(
	context: HostCallContext,
	commandId: string,
	input: T,
	options: { idempotencyKey?: string; expectedVersion?: number } = {},
): CommandRequest {
	return {
		schema: COMMAND_SCHEMA,
		schemaVersion: PUBLIC_API_SCHEMA_VERSION,
		commandId,
		requestId: context.requestId,
		correlationId: context.correlationId,
		deadlineAt: context.deadlineAt,
		idempotencyKey: options.idempotencyKey,
		expectedVersion: options.expectedVersion,
		input,
	};
}

type NarraForkDatabase = typeof import("../db")["db"];
type PluginManagerPublicMethods = Pick<PluginManager, "list" | "getStatus" | "enable" | "disable">;

/** Narrow facade over narrator services so tests can inject a fake. */
export type NarratorSessionFacade = {
	sendMessage: typeof sendNarratorMessage;
	sendSubagentMessage: typeof sendSubagentMessageToSession;
	createNarrator: typeof createNarratorForPluginSession;
	deleteNarrator: typeof deleteNarratorForPluginSession;
	specTasksGet: typeof readSpecTasksForPluginSession;
	specTaskAdd: typeof addSpecTaskForPluginSession;
	specBehaviorFenceUpdate: typeof setSpecBehaviorFenceForPluginSession;
	updateProfile: typeof updateNarratorProfileForPluginSession;
	specWrite: typeof writeSpecForPluginSession;
	interruptNarrator: typeof interruptNarratorSession;
	getById: typeof narratorService.getById;
};

/** Map core narrator errors to stable public error codes. */
function mapNarratorCommandError(error: unknown): PluginPublicApiError {
	if (error instanceof PluginPublicApiError) return error;
	if (error instanceof NotFoundError) {
		return new PluginPublicApiError("NOT_FOUND", "Narrator was not found");
	}
	if (error instanceof ValidationError) {
		const message = error instanceof Error ? error.message : "";
		if (message.includes("already running")) {
			return new PluginPublicApiError("CONFLICT", "Narrator is busy", {
				retryable: true,
			});
		}
		if (message.includes("resumeSubagent")) {
			return new PluginPublicApiError(
				"INVALID_PARAMS",
				"Subagent messages must be sent through the parent narrator",
			);
		}
		// Keep the concrete validation reason (e.g. a subagent that has never
		// been started by its parent) instead of a generic message.
		return new PluginPublicApiError("INVALID_PARAMS", message || "Invalid narrator operation");
	}
	return new PluginPublicApiError(
		"INTERNAL_ERROR",
		"The narrator operation failed inside the host",
	);
}

/**
 * Concrete limited adapters for core integration. DB queries select finite columns and use
 * `(updatedAt,id)` keyset predicates with `LIMIT n+1`; plugin lifecycle results are projected
 * before they cross the public boundary.
 */
export function createCorePluginPublicApiAdapters(options: {
	db: NarraForkDatabase;
	pluginManager: PluginManagerPublicMethods;
	narratorSession?: NarratorSessionFacade;
}): PluginPublicApiAdapters {
	const { db, pluginManager } = options;
	const session = options.narratorSession ?? {
		sendMessage: sendNarratorMessage,
		sendSubagentMessage: sendSubagentMessageToSession,
		createNarrator: createNarratorForPluginSession,
		deleteNarrator: deleteNarratorForPluginSession,
		specTasksGet: readSpecTasksForPluginSession,
		specTaskAdd: addSpecTaskForPluginSession,
		specBehaviorFenceUpdate: setSpecBehaviorFenceForPluginSession,
		updateProfile: updateNarratorProfileForPluginSession,
		specWrite: writeSpecForPluginSession,
		interruptNarrator: interruptNarratorSession,
		getById: narratorService.getById,
	};
	return {
		plugins: {
			async getOwn(input) {
				if (input.signal.aborted)
					throw new PluginPublicApiError("CANCELLED", "Query was cancelled");
				const status = await pluginManager.getStatus(input.pluginId);
				if (!status) return undefined;
				return {
					pluginId: status.pluginId,
					desiredState: status.desiredState,
					compatibility: status.compatibility,
					runtimeState: status.runtimeState,
					runtimeGeneration: status.runtimeGeneration,
					current: status.current,
					grants: status.grants as unknown as JsonValue,
				};
			},
			async list(input) {
				if (input.signal.aborted)
					throw new PluginPublicApiError("CANCELLED", "Query was cancelled");
				const statuses = (await pluginManager.list())
					.map(pluginStatusSource)
					.sort((left, right) => left.pluginId.localeCompare(right.pluginId))
					.filter((item) => !input.after || item.pluginId > input.after.pluginId)
					.slice(0, input.limit);
				return statuses;
			},
		},
		projects: {
			async list(input) {
				if (input.signal.aborted)
					throw new PluginPublicApiError("CANCELLED", "Query was cancelled");
				const rows = await listIntegrationProjects(
					{
						limit: input.limit,
						order: "updated_desc",
						after: input.after ? { primary: input.after.updatedAt, id: input.after.id } : undefined,
						projectId: input.projectId,
						statuses: input.status,
					},
					db,
				);
				return rows.map(({ id, name, status, createdAt, updatedAt }) => ({
					id,
					name,
					status,
					createdAt,
					updatedAt,
				}));
			},
		},
		chapters: {
			async list(input) {
				if (input.signal.aborted)
					throw new PluginPublicApiError("CANCELLED", "Query was cancelled");
				const predicates: SQL[] = [eq(chapters.projectId, input.projectId)];
				if (input.chapterId) predicates.push(eq(chapters.id, input.chapterId));
				if (input.status?.length) {
					// The plugin contract still accepts `frozen` while the column no longer
					// produces it, so the requested set is narrowed to values the column can
					// actually hold. Filtering on `frozen` alone therefore yields an empty
					// list — the same answer as before it was removed — rather than a type
					// error here or a rejected request for the caller.
					const storedStatuses = input.status.filter(
						(s): s is (typeof chapters.status)["_"]["data"] => s !== "frozen",
					);
					// An all-`frozen` filter must stay empty rather than degrade to "no filter",
					// which would return every chapter — exactly the bug this value used to cause.
					if (storedStatuses.length === 0) return [];
					predicates.push(inArray(chapters.status, storedStatuses));
				}
				if (input.role?.length) predicates.push(inArray(chapters.role, input.role));
				if (input.after) {
					const afterPredicate = or(
						lt(chapters.updatedAt, input.after.updatedAt),
						and(eq(chapters.updatedAt, input.after.updatedAt), lt(chapters.id, input.after.id)),
					);
					if (afterPredicate) predicates.push(afterPredicate);
				}
				return db
					.select({
						id: chapters.id,
						projectId: chapters.projectId,
						title: chapters.title,
						status: chapters.status,
						role: chapters.role,
						commitCount: chapters.commitCount,
						createdAt: chapters.createdAt,
						updatedAt: chapters.updatedAt,
					})
					.from(chapters)
					.where(and(...predicates))
					.orderBy(desc(chapters.updatedAt), desc(chapters.id))
					.limit(input.limit);
			},
		},
		pluginLifecycle: {
			async enable(pluginId, _context, signal) {
				if (signal.aborted) throw new PluginPublicApiError("CANCELLED", "Command was cancelled");
				return pluginStatusSource(await pluginManager.enable(pluginId));
			},
			async disable(pluginId, _context, signal) {
				if (signal.aborted) throw new PluginPublicApiError("CANCELLED", "Command was cancelled");
				return pluginStatusSource(await pluginManager.disable(pluginId));
			},
		},
		narrators: {
			async list(input) {
				if (input.signal.aborted)
					throw new PluginPublicApiError("CANCELLED", "Query was cancelled");
				const predicates: SQL[] = [];
				if (input.chapterId) predicates.push(eq(narrators.chapterId, input.chapterId));
				if (input.status?.length) predicates.push(inArray(narrators.status, input.status));
				if (input.after) {
					const afterPredicate = or(
						lt(narrators.updatedAt, input.after.updatedAt),
						and(eq(narrators.updatedAt, input.after.updatedAt), lt(narrators.id, input.after.id)),
					);
					if (afterPredicate) predicates.push(afterPredicate);
				}
				if (input.projectId) predicates.push(eq(chapters.projectId, input.projectId));
				const rows = await db
					.select({
						id: narrators.id,
						chapterId: narrators.chapterId,
						projectId: chapters.projectId,
						title: narrators.title,
						handle: narrators.handle,
						variant: narrators.variant,
						type: narrators.type,
						status: narrators.status,
						substatus: narrators.substatus,
					model: narrators.model,
					permissionMode: narrators.permissionMode,
					reasoningEffort: narrators.reasoningEffort,
					messageCount: narrators.messageCount,
						lastMessageAt: narrators.lastMessageAt,
						createdAt: narrators.createdAt,
						updatedAt: narrators.updatedAt,
					})
					.from(narrators)
					.leftJoin(chapters, eq(narrators.chapterId, chapters.id))
					.where(predicates.length ? and(...predicates) : undefined)
					.orderBy(desc(narrators.updatedAt), desc(narrators.id))
					.limit(input.limit);
				return rows.map((row) => ({
					id: row.id,
					chapterId: row.chapterId,
					projectId: row.projectId ?? null,
					title: row.title,
					handle: row.handle,
					variant: row.variant,
					type: row.type,
					status: row.status,
					substatus: parseNarratorSubstatus(row.substatus),
					model: row.model,
					permissionMode: row.permissionMode,
					reasoningEffort: row.reasoningEffort,
					messageCount: row.messageCount ?? 0,
					lastMessageAt: row.lastMessageAt,
					createdAt: row.createdAt,
					updatedAt: row.updatedAt,
				}));
			},
			async listMessages(input) {
				if (input.signal.aborted)
					throw new PluginPublicApiError("CANCELLED", "Query was cancelled");
				const rows = await db
					.select({
						id: narratorMessages.id,
						role: narratorMessages.role,
						contentText: narratorMessages.contentText,
						createdAt: narratorMessages.createdAt,
					})
					.from(narratorMessages)
					.where(eq(narratorMessages.narratorId, input.narratorId))
					.orderBy(desc(narratorMessages.createdAt))
					.limit(input.limit);
				return rows.map((row) => ({
					id: row.id,
					role: row.role,
					text: row.contentText ?? null,
					createdAt: row.createdAt,
				}));
			},
		},
		narratorCommands: {
			async sendMessage(input) {
				if (input.signal.aborted)
					throw new PluginPublicApiError("CANCELLED", "Command was cancelled");
				try {
					const sent = await session.sendMessage(
						input.narratorId,
						input.message,
						undefined,
						input.locale ?? "en",
						input.replyInUserLanguage ?? false,
						null,
						null,
						undefined,
						null,
						{ origin: "user", originLabel: `plugin:${input.pluginId}` },
					);
					return { messageId: sent.id };
				} catch (error) {
					throw mapNarratorCommandError(error);
				}
			},
			async sendSubagentMessage(input) {
				if (input.signal.aborted)
					throw new PluginPublicApiError("CANCELLED", "Command was cancelled");
				try {
					const result = await session.sendSubagentMessage({
						subagentId: input.narratorId,
						message: input.message,
						priority: input.priority,
						locale: input.locale,
						createdBy: null,
						signal: input.signal,
					});
					return {
						delivered: result.delivered,
						...(result.messageId ? { messageId: result.messageId } : {}),
						...(result.bufferedAt ? { bufferedAt: result.bufferedAt } : {}),
						...(typeof result.started === "boolean" ? { started: result.started } : {}),
					};
				} catch (error) {
					throw mapNarratorCommandError(error);
				}
			},
			async createNarrator(input) {
				if (input.signal.aborted)
					throw new PluginPublicApiError("CANCELLED", "Command was cancelled");
				try {
					const result = await session.createNarrator({
						title: input.title,
						model: input.model,
						cwd: input.cwd,
						chapterId: input.chapterId,
						permissionMode: input.permissionMode,
						planReflectionAutoApproveOverride: input.planReflectionAutoApproveOverride,
						type: input.type,
						subagentType: input.subagentType,
						parentNarratorId: input.parentNarratorId,
					});
					return result;
				} catch (error) {
					throw mapNarratorCommandError(error);
				}
			},
			async deleteNarrator(input) {
				if (input.signal.aborted)
					throw new PluginPublicApiError("CANCELLED", "Command was cancelled");
				try {
					await session.deleteNarrator(input.narratorId);
					return { deleted: true };
				} catch (error) {
					throw mapNarratorCommandError(error);
				}
			},
			async specTasksGet(input) {
				if (input.signal.aborted)
					throw new PluginPublicApiError("CANCELLED", "Command was cancelled");
				try {
					const result = await session.specTasksGet(input.narratorId);
					return {
						content: result.content,
						revisionId: result.revisionId,
						compiled: {
							tasks: result.compiled.tasks.map((task) => ({
								text: task.text,
								status: task.status,
								protected: task.protected ?? false,
							})),
							openCount: result.compiled.tasks.filter((task) => task.status !== "done").length,
							protectedOpenCount: result.compiled.protectedOpenCount,
						},
					};
				} catch (error) {
					throw mapNarratorCommandError(error);
				}
			},
		async specTaskAdd(input) {
			if (input.signal.aborted)
				throw new PluginPublicApiError("CANCELLED", "Command was cancelled");
			try {
				const result = await session.specTaskAdd(input.narratorId, input.text);
				return {
					added: result.added,
					taskText: result.taskText,
					revisionId: result.revisionId,
				};
			} catch (error) {
				throw mapNarratorCommandError(error);
			}
		},
		async specBehaviorFenceUpdate(input) {
			if (input.signal.aborted)
				throw new PluginPublicApiError("CANCELLED", "Command was cancelled");
			try {
				const result = await session.specBehaviorFenceUpdate(
					input.narratorId,
					input.text ?? "",
					input.mode,
				);
				return {
					updated: result.updated,
					revisionId: result.revisionId,
				};
			} catch (error) {
				throw mapNarratorCommandError(error);
			}
		},
		async updateProfile(input) {
			if (input.signal.aborted)
				throw new PluginPublicApiError("CANCELLED", "Command was cancelled");
			try {
				// Resolve existence first so the caller gets a stable NOT_FOUND.
				await session.getById(input.narratorId);
				const result = await session.updateProfile(input.narratorId, {
					...(input.title !== undefined ? { title: input.title } : {}),
					...(input.model !== undefined ? { model: input.model } : {}),
					...(input.reasoningEffort !== undefined
						? { reasoningEffort: input.reasoningEffort }
						: {}),
					...(input.planReflectionAutoApproveOverride !== undefined
						? { planReflectionAutoApproveOverride: input.planReflectionAutoApproveOverride }
						: {}),
				});
				return { updated: result.updated };
			} catch (error) {
				throw mapNarratorCommandError(error);
			}
		},
		async specWrite(input) {
			if (input.signal.aborted)
				throw new PluginPublicApiError("CANCELLED", "Command was cancelled");
			try {
				// Resolve existence first so the caller gets a stable NOT_FOUND.
				await session.getById(input.narratorId);
				const result = await session.specWrite(input.narratorId, input.uri, input.content);
				return {
					path: result.path,
					uri: result.uri,
					revisionId: result.revisionId,
				};
			} catch (error) {
				throw mapNarratorCommandError(error);
			}
		},
			async interrupt(input) {
				if (input.signal.aborted)
					throw new PluginPublicApiError("CANCELLED", "Command was cancelled");
				// `interruptNarrator` returns false for unknown ids; resolve existence first so
				// the caller gets a stable NOT_FOUND instead of a silent no-op.
				try {
					await session.getById(input.narratorId);
				} catch (error) {
					throw mapNarratorCommandError(error);
				}
				const interrupted = session.interruptNarrator(input.narratorId);
				return { interrupted };
			},
		},
	};
}

export const PUBLIC_QUERY_IDS = [
	"narrafork.plugin.getOwn",
	"narrafork.plugins.list",
	"narrafork.projects.list",
	"narrafork.chapters.list",
	"narrafork.narrators.list",
] as const;

export const PUBLIC_COMMAND_IDS = [
	"narrafork.plugins.enable",
	"narrafork.plugins.disable",
	"narrafork.narrator.send_message",
	"narrafork.narrator.send_subagent_message",
	"narrafork.narrator.interrupt",
	"narrafork.narrator.create",
	"narrafork.narrator.delete",
	"narrafork.narrator.spec_tasks_get",
	"narrafork.narrator.spec_task_add",
	"narrafork.narrator.spec_behavior_fence_update",
	"narrafork.narrator.update_profile",
	"narrafork.narrator.spec_write",
] as const;

export type PublicQueryId = (typeof PUBLIC_QUERY_IDS)[number];
export type PublicCommandId = (typeof PUBLIC_COMMAND_IDS)[number];
