import { z } from "zod/v4";

export const PROGRAMMATIC_PROTOCOL_VERSION = 1;
export const PROGRAMMATIC_LIMITS = Object.freeze({
	sourceBytes: 64 * 1024,
	requestBytes: 64 * 1024,
	responseBytes: 256 * 1024,
	transferBytes: 8 * 1024 * 1024,
	wireFrameBytes: 1024 * 1024,
	maxCalls: 100,
	wallMs: 120_000,
	maxWallMs: 600_000,
	startupMs: 15_000,
	resultBytes: 64 * 1024,
	maxLogs: 20,
	logBytes: 8 * 1024,
	summaryChars: 2000,
});

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };
export type ErrorShape = { code: string; message: string; fatal: boolean };
export class ProgrammaticError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly fatal = true,
	) {
		super(message);
		this.name = "ProgrammaticError";
	}
}

export interface RunIdentity {
	readonly runId: string;
	readonly narratorId: string;
	readonly actorUserId: string;
	readonly outerToolCallId: string;
	readonly teamId?: string;
	readonly projectId?: string;
}
export interface CallContext {
	readonly identity: Readonly<RunIdentity>;
	readonly sequence: number;
	readonly signal: AbortSignal;
	readonly deadlineAt: number;
}
export interface MethodDefinition {
	readonly name: string;
	readonly description: string;
	readonly effect: "read";
	/** Host-only validation. The sandbox never supplies a validator or identity. */
	validate(args: JsonValue): JsonValue;
	/** Bounded JSON text avoids invoking foreign getters/toJSON on the app thread. */
	invoke(args: JsonValue, context: CallContext): Promise<string>;
}
export interface ReceiverDefinition {
	readonly id: string;
	readonly name: string;
	readonly methods: readonly MethodDefinition[];
}
export interface ReceiverManifest {
	id: string;
	name: string;
	methods: Array<{ name: string; description: string }>;
}
export interface RunBudgets {
	requestBytes: number;
	responseBytes: number;
	transferBytes: number;
	maxCalls: number;
	wallMs: number;
	resultBytes: number;
	maxLogs: number;
	logBytes: number;
	summaryChars: number;
}
export interface StartFrame {
	type: "start";
	version: 1;
	source: string;
	receivers: ReceiverManifest[];
	budgets: RunBudgets;
}
export interface CallFrame {
	type: "call";
	version: 1;
	sequence: number;
	receiver: string;
	method: string;
	args: JsonValue;
}
export type ResponseFrame = { type: "response"; version: 1; sequence: number } & (
	| { ok: true; value: JsonValue }
	| { ok: false; error: ErrorShape }
);
export interface SandboxResult {
	type: "result";
	version: 1;
	ok: boolean;
	value?: JsonValue;
	delivery?: { summary?: string };
	error?: ErrorShape;
	logs: string[];
}
export interface ReadyFrame {
	type: "ready";
	version: 1;
	probe: { uid: number; memoryBytes: number; pids: number; cpuQuota: number; cpuPeriod: number };
}
export type ChildFrame = CallFrame | SandboxResult | ReadyFrame;

const errorSchema = z
	.object({ code: z.string().min(1).max(80), message: z.string().max(2000), fatal: z.boolean() })
	.strict();
const base = { version: z.literal(1) };
const sequence = z.number().int().min(1).max(PROGRAMMATIC_LIMITS.maxCalls);
const childSchema = z.discriminatedUnion("type", [
	z
		.object({
			...base,
			type: z.literal("ready"),
			probe: z
				.object({
					uid: z.number().int().nonnegative(),
					memoryBytes: z.number().int().positive(),
					pids: z.number().int().positive(),
					cpuQuota: z.number().int().positive(),
					cpuPeriod: z.number().int().positive(),
				})
				.strict(),
		})
		.strict(),
	z
		.object({
			...base,
			type: z.literal("call"),
			sequence,
			receiver: z.string().min(1).max(128),
			method: z.string().min(1).max(64),
			args: z.unknown(),
		})
		.strict(),
	z
		.object({
			...base,
			type: z.literal("result"),
			ok: z.boolean(),
			value: z.unknown().optional(),
			delivery: z
				.object({ summary: z.string().max(PROGRAMMATIC_LIMITS.summaryChars).optional() })
				.strict()
				.optional(),
			error: errorSchema.optional(),
			logs: z.array(z.string().max(PROGRAMMATIC_LIMITS.logBytes)).max(PROGRAMMATIC_LIMITS.maxLogs),
		})
		.strict(),
]);

/** JSON has already been decoded from a bounded wire frame; guard depth and node count. */
export function assertJson(value: unknown): asserts value is JsonValue {
	const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
	let nodes = 0;
	while (stack.length) {
		const item = stack.pop();
		if (!item) break;
		if (++nodes > 20000 || item.depth > 32)
			throw new ProgrammaticError("JSON_LIMIT", "JSON structure exceeds its budget");
		const current = item.value;
		if (current === null || typeof current === "string" || typeof current === "boolean") continue;
		if (typeof current === "number" && Number.isFinite(current)) continue;
		if (!current || typeof current !== "object")
			throw new ProgrammaticError("JSON_TYPE", "Only finite JSON values are supported");
		if (Array.isArray(current)) {
			if (current.length > 20000)
				throw new ProgrammaticError("JSON_LIMIT", "Array exceeds its budget");
			for (let index = 0; index < current.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
				if (!descriptor || descriptor.get || descriptor.set)
					throw new ProgrammaticError(
						"JSON_TYPE",
						"Sparse arrays and JSON getters are not supported",
					);
				stack.push({ value: descriptor.value, depth: item.depth + 1 });
			}
		} else {
			const prototype = Object.getPrototypeOf(current);
			if (prototype !== Object.prototype && prototype !== null)
				throw new ProgrammaticError("JSON_TYPE", "Only plain JSON objects are supported");
			const descriptors = Object.getOwnPropertyDescriptors(current);
			if (Object.keys(descriptors).length > 20000)
				throw new ProgrammaticError("JSON_LIMIT", "Object exceeds its budget");
			for (const descriptor of Object.values(descriptors)) {
				if (descriptor.get || descriptor.set)
					throw new ProgrammaticError("JSON_TYPE", "JSON getters are not supported");
				stack.push({ value: descriptor.value, depth: item.depth + 1 });
			}
		}
	}
}
export function parseJson(text: string, maxBytes: number): JsonValue {
	if (text.length > maxBytes || Buffer.byteLength(text, "utf8") > maxBytes)
		throw new ProgrammaticError("OUTPUT_LIMIT", "JSON text exceeds its byte budget");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ProgrammaticError("PROTOCOL", "Invalid JSON");
	}
	assertJson(parsed);
	return parsed;
}
export function parseChildFrame(text: string): ChildFrame {
	if (Buffer.byteLength(text) > PROGRAMMATIC_LIMITS.wireFrameBytes)
		throw new ProgrammaticError("FRAME_LIMIT", "Wire frame exceeds its budget");
	let decoded: unknown;
	try {
		decoded = JSON.parse(text);
	} catch {
		throw new ProgrammaticError("PROTOCOL", "Invalid wire JSON");
	}
	const checked = childSchema.safeParse(decoded);
	if (!checked.success)
		throw new ProgrammaticError("PROTOCOL", "Unexpected wire frame fields or values");
	const result = checked.data;
	if (result.type === "call") {
		assertJson(result.args);
		return { ...result, args: result.args };
	}
	if (result.type === "result") {
		if (result.ok) {
			if (result.error || result.value === undefined)
				throw new ProgrammaticError(
					"PROTOCOL",
					"Successful result must contain a JSON value and no error",
				);
			assertJson(result.value);
			if (Buffer.byteLength(JSON.stringify(result.value)) > PROGRAMMATIC_LIMITS.resultBytes)
				throw new ProgrammaticError("OUTPUT_LIMIT", "Final result exceeds its budget");
		} else if (!result.error || result.delivery)
			throw new ProgrammaticError("PROTOCOL", "Failed result cannot commit a delivery");
		if (Buffer.byteLength(JSON.stringify(result.logs)) > PROGRAMMATIC_LIMITS.logBytes)
			throw new ProgrammaticError("OUTPUT_LIMIT", "Logs exceed their total budget");
		return result as SandboxResult;
	}
	return result;
}
export function errorShape(error: unknown, fallback = "HOST_ERROR", fatal = true): ErrorShape {
	return error instanceof ProgrammaticError
		? { code: error.code, message: error.message.slice(0, 2000), fatal: error.fatal }
		: {
				code: fallback,
				message: error instanceof Error ? error.message.slice(0, 2000) : "Host operation failed",
				fatal,
			};
}
