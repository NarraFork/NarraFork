import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes } from "node:crypto";
import { SELECT_ROWS_MAX_SQL_BYTES } from "./protocol";

export const SQL_DIAGNOSTIC_EVENT_BYTES = 2048;
export const SQL_DIAGNOSTIC_EVENTS_PER_SECOND = 128;
const MAX_ACTIVE = 32;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;

/** The key is transported only to workers, never included in snapshots or logs. */
export interface SqlDiagnosticConfig {
	session: string;
	key: string;
	/** Per-request continuity only: 0 means intact, positive values are fixed loss reasons. */
	continuity?: SharedArrayBuffer;
}
type SqlDiagnosticSession = Pick<SqlDiagnosticConfig, "session" | "key">;
const LOSS_CODES = {
	"rate-limit": 1,
	"post-failed": 2,
	instrumentation: 3,
	depth: 4,
	context: 5,
} as const;
const LOSS_REASONS = [
	undefined,
	"rate-limit",
	"post-failed",
	"instrumentation",
	"depth",
	"context",
] as const;
function continuityView(value: unknown): Int32Array | undefined {
	try {
		if (value instanceof SharedArrayBuffer && value.byteLength === 4) return new Int32Array(value);
	} catch {
		// A missing shared-memory capability is explicit, never assumed to provide coverage.
	}
}
export function createSqlDiagnosticConfig(session: SqlDiagnosticSession): SqlDiagnosticConfig {
	try {
		return { ...session, continuity: new SharedArrayBuffer(4) };
	} catch {
		return { ...session };
	}
}
export interface SqlDiagnosticSite {
	file: string;
	line: number;
	column: number;
	fn?: string;
}
type Stage = "prepare" | "execute" | "iterate";
type Operation = "prepare" | "query" | "run" | "exec" | "all" | "get" | "values" | "iterate";
type LossReason = "rate-limit" | "post-failed" | "instrumentation" | "depth" | "context";
export interface SqlDiagnosticStatement {
	id: number;
	stage: Stage;
	operation: Operation;
	hashStatus: "collected" | "oversize" | "unavailable";
	sqlHash?: string;
	workerSite?: SqlDiagnosticSite;
	workerSiteStatus?: "available" | "unavailable";
}
export type SqlDiagnosticEvent = {
	type: "sqlDiagnostic";
	requestId: string;
	session: string;
	sequence: number;
} & (
	| { phase: "start"; statement: SqlDiagnosticStatement }
	| {
			phase: "end";
			statement: SqlDiagnosticStatement;
			outcome: "returned" | "threw" | "exhausted" | "closed";
			durationMs: number;
	  }
	| { phase: "coverageLost"; reason: LossReason; suppressed: number }
);

type EventPayload = SqlDiagnosticEvent extends infer E
	? E extends SqlDiagnosticEvent
		? Omit<E, "sequence" | "session" | "requestId" | "type">
		: never
	: never;
let sessionConfig: SqlDiagnosticSession | undefined;
export function sqlDiagnosticsEnabled(): boolean {
	return process.env.NF_DB_WORKER_SQL_DIAGNOSTICS === "1";
}
export function getSqlDiagnosticSession(): SqlDiagnosticSession | undefined {
	if (!sqlDiagnosticsEnabled()) return;
	try {
		sessionConfig ??= {
			session: randomBytes(8).toString("hex"),
			key: randomBytes(32).toString("hex"),
		};
		return sessionConfig;
	} catch {
		return;
	}
}
function validConfig(config: SqlDiagnosticConfig): boolean {
	return /^[a-f0-9]{16}$/.test(config.session) && /^[a-f0-9]{64}$/.test(config.key);
}
function uint(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function onlyKeys(input: object, allowed: readonly string[]): boolean {
	return Object.keys(input).every((key) => allowed.includes(key));
}
function validSite(value: unknown): value is SqlDiagnosticSite {
	if (!value || typeof value !== "object") return false;
	const site = value as SqlDiagnosticSite;
	return (
		onlyKeys(site, ["file", "line", "column", "fn"]) &&
		typeof site.file === "string" &&
		site.file.length <= 160 &&
		/^(server|shared)\/[a-zA-Z0-9_./-]+\.[cm]?[jt]sx?$/.test(site.file) &&
		!site.file.includes("..") &&
		uint(site.line) &&
		site.line > 0 &&
		site.line <= 10_000_000 &&
		uint(site.column) &&
		site.column > 0 &&
		site.column <= 10_000_000 &&
		(site.fn === undefined ||
			(typeof site.fn === "string" && /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/.test(site.fn)))
	);
}
/** Select one source location; neither the full stack nor any absolute prefix survives. */
export function captureSqlDiagnosticSite(
	stack?: string,
	side: "host" | "worker" = "worker",
): SqlDiagnosticSite | undefined {
	try {
		const text = stack ?? new Error().stack;
		if (!text) return;
		for (const line of text.slice(0, 16_384).split("\n").slice(1, 40)) {
			const match = line.match(
				/(?:\(|\s|\/)((?:server|shared)\/[a-zA-Z0-9_./-]+\.[cm]?[jt]sx?):(\d+):(\d+)\)?$/,
			);
			if (!match || match[1] === "server/lib/db-worker/sql-diagnostics.ts") continue;
			if (match[1] === "server/lib/db-worker/pool.ts" || match[1] === "server/lib/sql-trace.ts")
				continue;
			if (
				side === "host" &&
				[
					"server/db/worker-read.ts",
					"server/db/worker-read-adapter.ts",
					"server/lib/read-fanout-diagnostics.ts",
				].includes(match[1])
			)
				continue;
			const fn = line.match(/^\s*at ([A-Za-z_$][A-Za-z0-9_$.]{0,63})\s+\(/)?.[1];
			const site = {
				file: match[1],
				line: Number(match[2]),
				column: Number(match[3]),
				...(fn ? { fn } : {}),
			};
			if (validSite(site)) return site;
		}
	} catch {
		// Stack formatting is optional and can be supplied by runtime hooks.
	}
}
function statementValid(value: unknown): value is SqlDiagnosticStatement {
	if (!value || typeof value !== "object") return false;
	const s = value as SqlDiagnosticStatement;
	return (
		onlyKeys(s, [
			"id",
			"stage",
			"operation",
			"hashStatus",
			"sqlHash",
			"workerSite",
			"workerSiteStatus",
		]) &&
		uint(s.id) &&
		s.id > 0 &&
		["prepare", "execute", "iterate"].includes(s.stage) &&
		["prepare", "query", "run", "exec", "all", "get", "values", "iterate"].includes(s.operation) &&
		(s.stage === "prepare"
			? ["prepare", "query"].includes(s.operation)
			: s.stage === "iterate"
				? s.operation === "iterate"
				: ["run", "exec", "all", "get", "values"].includes(s.operation)) &&
		(s.hashStatus === "collected"
			? typeof s.sqlHash === "string" && /^[a-f0-9]{64}$/.test(s.sqlHash)
			: ["oversize", "unavailable"].includes(s.hashStatus) && s.sqlHash === undefined) &&
		(s.workerSite === undefined || validSite(s.workerSite)) &&
		(s.workerSiteStatus === undefined ||
			s.workerSiteStatus === (s.workerSite ? "available" : "unavailable"))
	);
}
export function isSqlDiagnosticEvent(input: unknown): input is SqlDiagnosticEvent {
	try {
		if (!input || typeof input !== "object") return false;
		const event = input as SqlDiagnosticEvent;
		if (
			event.type !== "sqlDiagnostic" ||
			typeof event.requestId !== "string" ||
			!/^(?:dbr-[a-z0-9]{1,16}-[a-z0-9]{1,16}|[A-Za-z0-9_-]{21})$/.test(event.requestId) ||
			typeof event.session !== "string" ||
			!/^[a-f0-9]{16}$/.test(event.session) ||
			!uint(event.sequence) ||
			event.sequence === 0
		)
			return false;
		const base = ["type", "requestId", "session", "sequence", "phase"];
		if (event.phase === "coverageLost") {
			if (
				!onlyKeys(event, [...base, "reason", "suppressed"]) ||
				!["rate-limit", "post-failed", "instrumentation", "depth", "context"].includes(
					event.reason,
				) ||
				!uint(event.suppressed)
			)
				return false;
		} else if (event.phase === "start" || event.phase === "end") {
			if (
				!onlyKeys(event, [
					...base,
					"statement",
					...(event.phase === "end" ? ["outcome", "durationMs"] : []),
				]) ||
				!statementValid(event.statement)
			)
				return false;
			if (
				event.phase === "end" &&
				(!["returned", "threw", "exhausted", "closed"].includes(event.outcome) ||
					!uint(event.durationMs))
			)
				return false;
		} else return false;
		return Buffer.byteLength(JSON.stringify(event)) <= SQL_DIAGNOSTIC_EVENT_BYTES;
	} catch {
		return false;
	}
}

interface WorkerContext {
	config: SqlDiagnosticConfig;
	continuity?: Int32Array;
	requestId: string;
	active: boolean;
	lost: boolean;
	sequence: number;
	statementId: number;
	open: Map<number, Token>;
}
interface Token {
	context: WorkerContext;
	statement: SqlDiagnosticStatement;
	startedAt: number;
	ended: boolean;
	cleanup?: () => void;
}
// biome-ignore lint/suspicious/noExplicitAny: native SQLite methods have heterogeneous signatures.
type Method = (this: any, ...args: any[]) => any;

/** One reporter per worker; no global SQLite prototype changes and no per-row messages. */
export function createWorkerSqlDiagnostics(
	post: (event: SqlDiagnosticEvent) => void,
	now: () => number = Date.now,
) {
	let storage: AsyncLocalStorage<WorkerContext> | undefined;
	const connections = new WeakSet<object>();
	const statements = new WeakSet<object>();
	let windowStartedAt = -Infinity;
	let sent = 0;
	let instrumentationBroken = false;
	function deliver(context: WorkerContext, payload: EventPayload): void {
		const event = {
			type: "sqlDiagnostic",
			requestId: context.requestId,
			session: context.config.session,
			sequence: ++context.sequence,
			...payload,
		} as SqlDiagnosticEvent;
		if (!isSqlDiagnosticEvent(event)) throw new Error("Invalid diagnostic event");
		sent++;
		post(event);
	}
	function resetWindow(): void {
		const time = now();
		if (time - windowStartedAt >= 1000 || time < windowStartedAt) {
			windowStartedAt = time;
			sent = 0;
		}
	}
	function lose(context: WorkerContext, reason: LossReason): void {
		if (!context.active || context.lost) return;
		context.lost = true;
		// Independent of IPC: the host invalidates current SQL even if both diagnostic posts fail.
		try {
			if (context.continuity) Atomics.compareExchange(context.continuity, 0, 0, LOSS_CODES[reason]);
		} catch {
			// Host snapshots treat an unavailable continuity flag as unknown.
		}
		try {
			resetWindow();
			// The last slot is reserved for continuity loss, including a failed ordinary post.
			if (sent < SQL_DIAGNOSTIC_EVENTS_PER_SECOND)
				deliver(context, { phase: "coverageLost", reason, suppressed: 1 });
		} catch {
			// If the channel itself is broken, later sequence validation/terminal settlement is fail-closed.
		}
	}
	function emit(context: WorkerContext, payload: Parameters<typeof deliver>[1]): void {
		if (!context.active || context.lost) return;
		try {
			resetWindow();
			if (sent >= SQL_DIAGNOSTIC_EVENTS_PER_SECOND - 1) {
				lose(context, "rate-limit");
				return;
			}
			deliver(context, payload);
		} catch {
			lose(context, "post-failed");
		}
	}
	function begin(sql: unknown, stage: Stage, operation: Operation): Token | undefined {
		const context = storage?.getStore();
		if (!context?.active || context.lost) return;
		try {
			if (context.open.size >= MAX_ACTIVE || context.statementId >= MAX_SEQUENCE) {
				lose(context, "depth");
				return;
			}
			const statement: SqlDiagnosticStatement = {
				id: ++context.statementId,
				stage,
				operation,
				hashStatus: "unavailable",
			};
			if (typeof sql === "string") {
				if (
					sql.length > SELECT_ROWS_MAX_SQL_BYTES ||
					Buffer.byteLength(sql) > SELECT_ROWS_MAX_SQL_BYTES
				)
					statement.hashStatus = "oversize";
				else {
					statement.sqlHash = createHmac("sha256", Buffer.from(context.config.key, "hex"))
						.update(sql)
						.digest("hex");
					statement.hashStatus = "collected";
				}
			}
			statement.workerSite = captureSqlDiagnosticSite();
			statement.workerSiteStatus = statement.workerSite ? "available" : "unavailable";
			const token = { context, statement, startedAt: now(), ended: false };
			context.open.set(statement.id, token);
			emit(context, { phase: "start", statement } as Parameters<typeof emit>[1]);
			return token;
		} catch {
			lose(context, "instrumentation");
			return;
		}
	}
	function end(
		token: Token | undefined,
		outcome: "returned" | "threw" | "exhausted" | "closed",
	): void {
		if (!token || token.ended) return;
		token.ended = true;
		token.context.open.delete(token.statement.id);
		token.cleanup?.();
		if (!token.context.active || token.context.lost) return;
		try {
			emit(token.context, {
				phase: "end",
				statement: token.statement,
				outcome,
				durationMs: Math.max(0, Math.min(MAX_SEQUENCE, Math.floor(now() - token.startedAt))),
			} as Parameters<typeof emit>[1]);
		} catch {
			lose(token.context, "instrumentation");
		}
	}
	function invoke(
		original: Method,
		receiver: unknown,
		args: unknown[],
		sql: unknown,
		stage: Stage,
		operation: Operation,
	) {
		const token = begin(sql, stage, operation);
		try {
			const value = Reflect.apply(original, receiver, args);
			end(token, "returned");
			return value;
		} catch (error) {
			end(token, "threw");
			throw error;
		}
	}
	function iterator(
		original: Method,
		receiver: unknown,
		args: unknown[],
		sql: unknown,
		iterations: Set<Token>,
	) {
		const token = begin(sql, "iterate", "iterate");
		if (token) {
			iterations.add(token);
			token.cleanup = () => iterations.delete(token);
		}
		let value: Record<string | symbol, unknown>;
		try {
			value = Reflect.apply(original, receiver, args);
		} catch (error) {
			end(token, "threw");
			throw error;
		}
		if (!token) return value;
		try {
			for (const method of ["next", "return", "throw"] as const) {
				const raw = value[method];
				if (typeof raw !== "function") continue;
				value[method] = function (this: unknown, ...input: unknown[]) {
					const current = storage?.getStore();
					if (current !== token.context) {
						lose(token.context, "context");
						if (current) lose(current, "context");
					}
					let result: unknown;
					try {
						result = Reflect.apply(raw, this, input);
					} catch (error) {
						end(token, "threw");
						throw error;
					}
					try {
						// Native iterator results have a data property. Do not invoke caller getters.
						const done =
							result && typeof result === "object"
								? Object.getOwnPropertyDescriptor(result, "done")
								: undefined;
						if (!done || !("value" in done)) lose(token.context, "instrumentation");
						else if (done.value) end(token, method === "return" ? "closed" : "exhausted");
					} catch {
						lose(token.context, "instrumentation");
					}
					return result;
				};
			}
		} catch {
			lose(token.context, "instrumentation");
		}
		return value;
	}
	function wrapStatement(value: unknown, sql: unknown): void {
		if (!value || typeof value !== "object" || statements.has(value)) return;
		statements.add(value);
		const target = value as Record<string, unknown>;
		const iterations = new Set<Token>();
		try {
			for (const method of ["run", "all", "get", "values", "iterate"] as const) {
				const original = target[method];
				if (typeof original !== "function") continue;
				target[method] = function (this: unknown, ...args: unknown[]) {
					return method === "iterate"
						? iterator(original as Method, this, args, sql, iterations)
						: invoke(original as Method, this, args, sql, "execute", method);
				};
			}
			const finalize = target.finalize;
			if (typeof finalize === "function") {
				target.finalize = function (this: unknown, ...args: unknown[]) {
					try {
						const result = Reflect.apply(finalize, this, args);
						for (const token of iterations) end(token, "closed");
						return result;
					} catch (error) {
						for (const token of iterations) {
							lose(token.context, "instrumentation");
							end(token, "threw");
						}
						throw error;
					}
				};
			}
		} catch {
			instrumentationBroken = true;
			const context = storage?.getStore();
			if (context) lose(context, "instrumentation");
		}
	}
	return {
		/** No ALS, clocks, hashes, stacks or posts when configuration is absent. */
		run<T>(config: SqlDiagnosticConfig | undefined, requestId: string, work: () => T): T {
			if (!config) return work();
			let valid = false;
			try {
				valid = validConfig(config);
			} catch {
				// Configuration failures are observational only.
			}
			if (!valid) return work();
			storage ??= new AsyncLocalStorage<WorkerContext>();
			const context: WorkerContext = {
				config,
				continuity: continuityView(config.continuity),
				requestId,
				active: true,
				lost: false,
				sequence: 0,
				statementId: 0,
				open: new Map(),
			};
			const finish = () => {
				context.active = false;
				for (const token of context.open.values()) token.cleanup?.();
				context.open.clear();
			};
			return storage.run(context, () => {
				if (instrumentationBroken) lose(context, "instrumentation");
				try {
					const result = work();
					if (result instanceof Promise) return result.finally(finish) as T;
					finish();
					return result;
				} catch (error) {
					finish();
					throw error;
				}
			});
		},
		instrument<T extends object>(connection: T): T {
			const context = storage?.getStore();
			if (!context?.active || connections.has(connection)) return connection;
			connections.add(connection);
			try {
				const target = connection as Record<string, unknown>;
				for (const method of ["prepare", "query", "run", "exec"] as const) {
					const original = target[method];
					if (typeof original !== "function") continue;
					target[method] = function (this: unknown, ...args: unknown[]) {
						const value = invoke(
							original as Method,
							this,
							args,
							args[0],
							method === "prepare" || method === "query" ? "prepare" : "execute",
							method,
						);
						if (method === "prepare" || method === "query") wrapStatement(value, args[0]);
						return value;
					};
				}
			} catch {
				instrumentationBroken = true;
				lose(context, "instrumentation");
			}
			return connection;
		},
	};
}

interface ObservedStatement extends SqlDiagnosticStatement {
	observedAt: number;
	outcome?: "returned" | "threw" | "exhausted" | "closed";
	durationMs?: number;
}
export interface HostSqlDiagnosticState {
	session: string;
	hostSite?: SqlDiagnosticSite;
	worker?: string;
	coverage: "sqlite" | "postgres-uncovered";
	sequence: number;
	lastStatementId: number;
	lost?: "invalid-event" | "sequence" | "continuity-unavailable" | LossReason;
	continuity?: Int32Array;
	suppressed: number;
	logSuppressed: number;
	active: ObservedStatement[];
	recent?: ObservedStatement;
	endedAt?: number;
	outcome?: "completed" | "failed";
}
export function createHostSqlDiagnosticState(
	config: SqlDiagnosticConfig,
	postgres: boolean,
): HostSqlDiagnosticState {
	const continuity = continuityView(config.continuity);
	return {
		session: config.session,
		continuity,
		...(continuity ? {} : { lost: "continuity-unavailable" as const }),
		hostSite: captureSqlDiagnosticSite(undefined, "host"),
		coverage: postgres ? "postgres-uncovered" : "sqlite",
		sequence: 0,
		lastStatementId: 0,
		suppressed: 0,
		logSuppressed: 0,
		active: [],
	};
}
export function loseHostSqlCoverage(
	state: HostSqlDiagnosticState,
	reason: NonNullable<HostSqlDiagnosticState["lost"]>,
): void {
	state.lost ??= reason;
	state.active.length = 0;
	state.suppressed = Math.min(MAX_SEQUENCE, state.suppressed + 1);
}
function refreshHostSqlCoverage(state: HostSqlDiagnosticState): void {
	if (state.lost) return;
	try {
		if (!state.continuity) {
			loseHostSqlCoverage(state, "continuity-unavailable");
			return;
		}
		const code = Atomics.load(state.continuity, 0);
		if (code !== 0) loseHostSqlCoverage(state, LOSS_REASONS[code] ?? "invalid-event");
	} catch {
		loseHostSqlCoverage(state, "continuity-unavailable");
	}
}
/** Called only on the current worker/request branch. Invalid metadata never reaches business logic. */
export function acceptSqlDiagnosticEvent(
	state: HostSqlDiagnosticState,
	input: unknown,
	now: number,
): input is SqlDiagnosticEvent {
	try {
		refreshHostSqlCoverage(state);
		if (
			!isSqlDiagnosticEvent(input) ||
			input.session !== state.session ||
			state.coverage !== "sqlite" ||
			state.endedAt !== undefined
		) {
			loseHostSqlCoverage(state, "invalid-event");
			return false;
		}
		if (input.sequence !== state.sequence + 1) {
			loseHostSqlCoverage(state, "sequence");
			return false;
		}
		state.sequence = input.sequence;
		if (input.phase === "coverageLost") {
			if (!state.lost) loseHostSqlCoverage(state, input.reason);
			state.suppressed = Math.max(state.suppressed, input.suppressed);
		} else if (!state.lost) {
			if (input.phase === "start") {
				if (state.active.length >= MAX_ACTIVE || input.statement.id <= state.lastStatementId) {
					loseHostSqlCoverage(state, "sequence");
					return false;
				}
				state.lastStatementId = input.statement.id;
				state.active.push({ ...input.statement, observedAt: now });
			} else {
				const index = state.active.findIndex((item) => item.id === input.statement.id);
				const observed = state.active[index];
				const same =
					observed &&
					observed.stage === input.statement.stage &&
					observed.operation === input.statement.operation &&
					observed.hashStatus === input.statement.hashStatus &&
					observed.sqlHash === input.statement.sqlHash &&
					JSON.stringify(observed.workerSite) === JSON.stringify(input.statement.workerSite);
				if (!same) {
					loseHostSqlCoverage(state, "sequence");
					return false;
				}
				state.active.splice(index, 1);
				state.recent = {
					...input.statement,
					observedAt: now,
					outcome: input.outcome,
					durationMs: input.durationMs,
				};
			}
		}
		return true;
	} catch {
		loseHostSqlCoverage(state, "invalid-event");
		return false;
	}
}
export function sqlDiagnosticSnapshot(state: HostSqlDiagnosticState, now: number) {
	refreshHostSqlCoverage(state);
	const age = (statement: ObservedStatement | undefined, at = now) =>
		statement
			? {
					...statement,
					workerSiteStatus: statement.workerSite ? "available" : "unavailable",
					observedAt: undefined,
					ageMs: Math.max(0, Math.min(MAX_SEQUENCE, Math.floor(at - statement.observedAt))),
				}
			: undefined;
	const current = state.active.at(-1);
	return {
		session: state.session,
		coverage: state.coverage,
		worker: state.worker,
		hostSite: state.hostSite,
		hostSiteStatus: state.hostSite ? "available" : "unavailable",
		state: state.lost
			? "unknown"
			: state.coverage === "postgres-uncovered"
				? "uncovered"
				: state.endedAt !== undefined
					? "settled"
					: current
						? "running"
						: state.recent
							? "idle"
							: "unobserved",
		...(state.lost ? { reason: state.lost } : {}),
		current: state.endedAt === undefined ? age(current) : undefined,
		...(state.endedAt !== undefined
			? { taskOutcome: state.outcome, lastObserved: age(current, state.endedAt) }
			: {}),
		recent: age(state.recent),
		suppressed: state.suppressed,
		...(state.logSuppressed ? { logSuppressed: state.logSuppressed } : {}),
	};
}
