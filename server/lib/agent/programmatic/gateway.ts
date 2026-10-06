import { createHash } from "node:crypto";
import {
	assertJson,
	type CallContext,
	type CallFrame,
	type JsonValue,
	type MethodDefinition,
	PROGRAMMATIC_LIMITS,
	ProgrammaticError,
	parseJson,
	type ReceiverDefinition,
	type ReceiverManifest,
	type ResponseFrame,
	type RunBudgets,
	type RunIdentity,
} from "./protocol";

export interface GatewayAuditEvent {
	readonly identity: Readonly<RunIdentity>;
	readonly sequence: number;
	readonly receiver: string;
	readonly method: string;
	readonly phase: "request" | "authorized" | "completed" | "failed";
	readonly requestBytes: number;
	readonly requestHash: string;
	readonly responseBytes?: number;
	readonly responseHash?: string;
	readonly durationMs: number;
	readonly errorCode?: string;
}
export interface GatewayOptions {
	identity: RunIdentity;
	receivers: readonly ReceiverDefinition[];
	budgets: RunBudgets;
	signal: AbortSignal;
	deadlineAt: number;
	authorize: (request: Readonly<CallFrame>, context: CallContext) => Promise<boolean>;
	audit: (event: GatewayAuditEvent) => Promise<void>;
	onFatal?: (error: ProgrammaticError) => void;
}

const forbidden = new Set([
	"constructor",
	"prototype",
	"__proto__",
	"then",
	"toJSON",
	...Object.getOwnPropertyNames(Object.prototype),
]);
const globals = new Set([
	...Object.getOwnPropertyNames(globalThis),
	"globalThis",
	"global",
	"window",
	"self",
	"console",
	"JSON",
	"Object",
	"Array",
	"Promise",
	"Error",
	"Function",
	"eval",
	"undefined",
	"NaN",
	"Infinity",
	"Atomics",
	"SharedArrayBuffer",
	"process",
	"require",
	"module",
	"exports",
	"arguments",
	"delivery",
	"result",
	..."await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield".split(
		" ",
	),
]);
function fail(code: string, message: string): never {
	throw new ProgrammaticError(code, message);
}
function name(value: string, max: number, receiver = false): void {
	if (
		typeof value !== "string" ||
		value.length > max ||
		!/^[A-Za-z_$][\w$]*$/.test(value) ||
		forbidden.has(value) ||
		(receiver && globals.has(value))
	) {
		fail("CONFIG", "Invalid or reserved capability name");
	}
}
function freezeJson<T extends JsonValue>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freezeJson(child);
		Object.freeze(value);
	}
	return value;
}
function jsonText(value: unknown, max: number): string {
	// Inspect descriptors before protocol.assertJson (which iterates arrays). Never
	// execute an array getter, custom iterator or toJSON supplied by a validator.
	const stack = [{ value, depth: 0 }];
	let nodes = 0;
	let chars = 0;
	while (stack.length) {
		const item = stack.pop();
		if (!item) break;
		if (++nodes > 20000 || item.depth > 32) fail("JSON_LIMIT", "JSON structure exceeds budget");
		const current = item.value;
		if (typeof current === "string") chars += current.length;
		if (chars > max) fail("OUTPUT_LIMIT", "JSON text exceeds budget");
		if (!current || typeof current !== "object") continue;
		if (Object.getOwnPropertySymbols(current).length)
			fail("JSON_TYPE", "JSON symbols are not supported");
		const array = Array.isArray(current);
		if (array && (Object.getPrototypeOf(current) !== Array.prototype || current.length > 20000))
			fail("JSON_TYPE", "Only bounded plain arrays are supported");
		const descriptors = Object.getOwnPropertyDescriptors(current);
		if (Object.keys(descriptors).length > 20001) fail("JSON_LIMIT", "Too many JSON fields");
		for (const [key, descriptor] of Object.entries(descriptors)) {
			if (array && key === "length") continue;
			if (
				descriptor.get ||
				descriptor.set ||
				!descriptor.enumerable ||
				(array && !/^(0|[1-9][0-9]*)$/.test(key))
			)
				fail("JSON_TYPE", "Only plain JSON fields are supported");
			chars += key.length;
			stack.push({ value: descriptor.value, depth: item.depth + 1 });
		}
	}
	assertJson(value);
	const text = JSON.stringify(value);
	if (text.length * 2 > max || Buffer.byteLength(text) > max)
		fail("OUTPUT_LIMIT", "JSON exceeds its slot budget");
	return text;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export function createGateway(options: GatewayOptions) {
	const { authorize, audit, onFatal } = options;
	if (typeof authorize !== "function" || typeof audit !== "function")
		fail("CONFIG", "Authorization and audit sinks are required");
	const identityFields = [
		"runId",
		"narratorId",
		"actorUserId",
		"outerToolCallId",
		"teamId",
		"projectId",
	] as const;
	const picked: Record<string, string> = {};
	for (const key of identityFields) {
		const value = options.identity?.[key];
		if (value === undefined && (key === "teamId" || key === "projectId")) continue;
		if (
			typeof value !== "string" ||
			!value.trim() ||
			value.length > 256 ||
			value.split("").some((character) => character.charCodeAt(0) < 32)
		)
			fail("IDENTITY", "Invalid host identity");
		picked[key] = value;
	}
	const identity = Object.freeze(picked) as unknown as Readonly<RunIdentity>;
	const budgets = Object.freeze({ ...options.budgets });
	for (const key of Object.keys(PROGRAMMATIC_LIMITS) as Array<keyof typeof PROGRAMMATIC_LIMITS>) {
		if (!(key in budgets)) continue;
		const value = budgets[key as keyof RunBudgets];
		if (!Number.isSafeInteger(value) || value <= 0 || value > PROGRAMMATIC_LIMITS[key])
			fail("CONFIG", "Invalid gateway budget");
	}
	for (const key of [
		"requestBytes",
		"responseBytes",
		"transferBytes",
		"maxCalls",
		"wallMs",
	] as const) {
		if (!Number.isSafeInteger(budgets[key]) || budgets[key] <= 0)
			fail("CONFIG", "Missing gateway budget");
	}
	if (!Number.isFinite(options.deadlineAt)) fail("CONFIG", "Invalid deadline");
	const deadlineAt = Math.min(options.deadlineAt, Date.now() + budgets.wallMs);
	const registry = new Map<string, Map<string, MethodDefinition>>();
	const receiverNames = new Set<string>();
	const manifest: ReceiverManifest[] = [];
	if (options.receivers.length > 128) fail("CONFIG", "Too many receivers");
	for (const receiver of options.receivers) {
		if (
			typeof receiver.id !== "string" ||
			!/^[A-Za-z0-9_$-]{1,128}$/.test(receiver.id) ||
			forbidden.has(receiver.id)
		)
			fail("CONFIG", "Invalid receiver id");
		name(receiver.name, 128, true);
		if (registry.has(receiver.id) || receiverNames.has(receiver.name))
			fail("CONFIG", "Duplicate receiver");
		receiverNames.add(receiver.name);
		const methods = new Map<string, MethodDefinition>();
		if (receiver.methods.length > 128) fail("CONFIG", "Too many methods");
		for (const method of receiver.methods) {
			name(method.name, 64);
			if (
				methods.has(method.name) ||
				method.effect !== "read" ||
				typeof method.validate !== "function" ||
				typeof method.invoke !== "function" ||
				typeof method.description !== "string" ||
				method.description.length > 2000
			)
				fail("CONFIG", "Only unique read methods with bounded descriptions are supported");
			methods.set(method.name, Object.freeze({ ...method }));
		}
		registry.set(receiver.id, methods);
		manifest.push({
			id: receiver.id,
			name: receiver.name,
			methods: [...methods.values()].map(({ name, description }) => ({ name, description })),
		});
	}
	const controller = new AbortController();
	let fatal: ProgrammaticError | undefined;
	let active: Promise<ResponseFrame> | undefined;
	let calls = 0;
	let requestBytes = 0;
	let responseBytes = 0;
	let stopResolve: (error: ProgrammaticError) => void = () => {};
	const stopped = new Promise<ProgrammaticError>((resolve) => {
		stopResolve = resolve;
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	function stop(error: ProgrammaticError): void {
		if (fatal) return;
		fatal = error;
		clearTimeout(timer);
		options.signal.removeEventListener("abort", aborted);
		controller.abort();
		stopResolve(error);
		try {
			onFatal?.(error);
		} catch {
			/* Notification cannot override fail-closed state. */
		}
	}
	function aborted(): void {
		stop(new ProgrammaticError("CANCELLED", "Run cancelled"));
	}
	function check(): void {
		if (!fatal && Date.now() >= deadlineAt)
			stop(new ProgrammaticError("EXPIRED", "Run deadline exceeded"));
		if (fatal) throw fatal;
	}
	options.signal.addEventListener("abort", aborted, { once: true });
	timer = setTimeout(
		() => stop(new ProgrammaticError("EXPIRED", "Run deadline exceeded")),
		Math.max(0, deadlineAt - Date.now()),
	);
	timer.unref?.();
	if (options.signal.aborted) aborted();
	function errorResponse(sequence: number, error: ProgrammaticError): ResponseFrame {
		return {
			type: "response",
			version: 1,
			sequence,
			ok: false,
			error: {
				code: error.code.slice(0, 80),
				message: error.message.slice(0, 160),
				fatal: error.fatal,
			},
		};
	}
	function account(response: ResponseFrame): ResponseFrame {
		const text = jsonText(response, budgets.responseBytes);
		const bytes = Buffer.byteLength(text);
		if (requestBytes + responseBytes + bytes > budgets.transferBytes)
			fail("TRANSFER_LIMIT", "Transfer budget exceeded");
		responseBytes += bytes;
		return response;
	}
	async function execute(input: CallFrame): Promise<ResponseFrame> {
		let request: CallFrame | undefined;
		let text = "";
		const started = Date.now();
		async function emit(
			phase: GatewayAuditEvent["phase"],
			response?: ResponseFrame,
			errorCode?: string,
		): Promise<void> {
			if (!request) return;
			const output = response ? JSON.stringify(response) : undefined;
			try {
				await audit(
					Object.freeze({
						identity,
						sequence: request.sequence,
						receiver: request.receiver,
						method: request.method,
						phase,
						requestBytes: Buffer.byteLength(text),
						requestHash: hash(text),
						...(output
							? { responseBytes: Buffer.byteLength(output), responseHash: hash(output) }
							: {}),
						durationMs: Math.max(0, Date.now() - started),
						...(errorCode ? { errorCode: errorCode.slice(0, 80) } : {}),
					}),
				);
			} catch {
				fail("AUDIT_FAILED", "Audit sink failed");
			}
		}
		try {
			check();
			text = jsonText(input, budgets.requestBytes);
			const decoded = parseJson(text, budgets.requestBytes) as unknown as CallFrame;
			if (
				!decoded ||
				typeof decoded !== "object" ||
				Array.isArray(decoded) ||
				Object.keys(decoded).sort().join(",") !== "args,method,receiver,sequence,type,version" ||
				decoded.type !== "call" ||
				decoded.version !== 1 ||
				!Number.isSafeInteger(decoded.sequence) ||
				decoded.sequence !== calls + 1 ||
				typeof decoded.receiver !== "string" ||
				typeof decoded.method !== "string"
			)
				fail("PROTOCOL", "Invalid call frame or sequence");
			const method = registry.get(decoded.receiver)?.get(decoded.method);
			if (!method) fail("PROTOCOL", "Unknown receiver or method");
			if (calls >= budgets.maxCalls) fail("CALL_LIMIT", "Call budget exceeded");
			calls++;
			requestBytes += Buffer.byteLength(text);
			if (requestBytes + responseBytes > budgets.transferBytes)
				fail("TRANSFER_LIMIT", "Transfer budget exceeded");
			request = freezeJson(decoded as unknown as JsonValue) as unknown as CallFrame;
			const context: CallContext = Object.freeze({
				identity,
				sequence: request.sequence,
				signal: controller.signal,
				deadlineAt,
			});
			await emit("request");
			check();
			let allowed: boolean;
			try {
				allowed = await authorize(request, context);
			} catch {
				fail("AUTHORIZATION", "Authorization failed");
			}
			check();
			if (allowed !== true) fail("DENIED", "Authorization denied");
			await emit("authorized");
			check();
			let args: JsonValue;
			try {
				args = method.validate(request.args);
				args = parseJson(jsonText(args, budgets.requestBytes), budgets.requestBytes);
			} catch {
				throw new ProgrammaticError("VALIDATION", "Invalid method arguments", false);
			}
			check();
			let output: string;
			try {
				output = await method.invoke(args, context);
			} catch (error) {
				if (error instanceof ProgrammaticError) throw error;
				throw new ProgrammaticError("DOMAIN", "Method failed", false);
			}
			check();
			if (typeof output !== "string") fail("OUTPUT_LIMIT", "Method must return bounded JSON text");
			const value = parseJson(output, budgets.responseBytes);
			const response: ResponseFrame = {
				type: "response",
				version: 1,
				sequence: request.sequence,
				ok: true,
				value,
			};
			jsonText(response, budgets.responseBytes);
			await emit("completed", response);
			check();
			return response;
		} catch (error) {
			let normalized =
				fatal ??
				(error instanceof ProgrammaticError
					? error
					: new ProgrammaticError("PROTOCOL", "Invalid call"));
			if (normalized.fatal) stop(normalized);
			try {
				await emit("failed", undefined, normalized.code);
			} catch {
				normalized = new ProgrammaticError("AUDIT_FAILED", "Audit sink failed");
				stop(normalized);
			}
			return errorResponse(request?.sequence ?? calls + 1, normalized);
		}
	}
	return {
		manifest,
		async dispatch(request: CallFrame): Promise<ResponseFrame> {
			if (active && !fatal)
				stop(new ProgrammaticError("CONCURRENT", "Only one call may be in flight"));
			if (fatal) return account(errorResponse(calls + 1, fatal));
			const work = execute(request);
			active = work;
			void work.finally(() => {
				if (active === work) active = undefined;
			});
			const response = await Promise.race([
				work,
				stopped.then((error) => errorResponse(calls || 1, error)),
			]);
			try {
				return account(response);
			} catch (error) {
				const normalized =
					error instanceof ProgrammaticError
						? error
						: new ProgrammaticError("OUTPUT_LIMIT", "Response exceeds budget");
				stop(normalized);
				throw normalized;
			}
		},
		close(): void {
			stop(new ProgrammaticError("CLOSED", "Gateway closed"));
		},
		async drained(): Promise<void> {
			while (active) await active;
		},
		get inFlight(): boolean {
			return active !== undefined;
		},
		stats() {
			return { calls, requestBytes, responseBytes };
		},
	};
}
