/**
 * SQLite call tracing: every statement executed through an instrumented `bun:sqlite`
 * connection is timed and attributed to the span (HTTP request, WS message, agent run,
 * tool call, worker task) that issued it, then written as NDJSON for offline analysis.
 *
 * Enable with `NF_SQL_TRACE=summary` (per-span aggregates by SQL fingerprint, plus every
 * statement slower than `NF_SQL_TRACE_SLOW_MS`) or `NF_SQL_TRACE=full` (one line per call).
 * `bun run start:dev` enables `summary` by default. Output:
 * `~/.narrafork/sql-trace/YYYY-MM-DD-p<pid>[-t<thread>].ndjson`; summarise it with
 * `bun run sql:report`.
 *
 * Record types (one JSON object per line, `t` is the discriminator):
 * - `meta`  process/thread start: mode, pid, threadId.
 * - `stmt`  fingerprint catalog: `h` (hash) → normalised `sql`. Emitted once per process per day.
 * - `span`  aggregate for one span (or a time window of a long/background span):
 *           id, parent, kind, label, ts, ms (wall, on end), n (calls), sqlMs, maxMs, txN, txMs,
 *           a (attrs), stmts [{h,n,ms,max,rows}]. A span may be emitted several times
 *           (`partial` while running, `late` for SQL that ran after it ended); sum by id.
 * - `sql`   one statement call (all calls in `full`, slow ones in `summary`): span, h, op, ms, rows.
 * - `tx`    a slow outermost transaction: span, ms, site.
 *
 * Bound parameters are never recorded. Writes are buffered and appended asynchronously; the
 * buffer is capped and drops (counted) instead of growing without bound.
 */

import type { Database, Statement } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isMainThread, threadId } from "node:worker_threads";
import { getNarraforkPath } from "./narrafork-home";

export type SqlTraceMode = "off" | "summary" | "full";
export type SqlTraceSpanKind = "http" | "ws" | "agent" | "tool" | "worker" | "job" | "bg";

const FLUSH_INTERVAL_MS = 1_000;
/** Long-running and background spans are emitted as windows of this length. */
const WINDOW_MS = 10_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_STMTS_PER_RECORD = 50;
const MAX_SQL_TEXT = 4_000;
const MAX_FINGERPRINT_CACHE = 5_000;
const MAX_BG_SPANS = 500;
const CALLSITE_RESAMPLE_EVERY = 64;

interface StmtAgg {
	n: number;
	ms: number;
	max: number;
	rows: number;
}

interface Fingerprint {
	h: string;
	text: string;
}

interface CallsiteCache {
	site: string;
	seen: number;
}

interface State {
	mode: SqlTraceMode;
	dir: string;
	slowMs: number;
	als: AsyncLocalStorage<SqlTraceSpan>;
	instrumented: WeakSet<object>;
	fingerprints: Map<string, Fingerprint>;
	catalog: Set<string>;
	catalogDay: string;
	callsites: Map<string, CallsiteCache>;
	bgSpans: Map<string, SqlTraceSpan>;
	dirty: Set<SqlTraceSpan>;
	buffer: string[];
	bufferBytes: number;
	dropped: number;
	writing: boolean;
	timer: ReturnType<typeof setInterval> | null;
	txDepth: number;
	procTag: string;
	fileTag: string;
	seq: number;
	started: boolean;
}

const STATE_KEY = Symbol.for("narrafork.sqlTrace");
type GlobalWithState = typeof globalThis & { [STATE_KEY]?: State };

function parseMode(raw: string | undefined): SqlTraceMode {
	const value = raw?.trim().toLowerCase();
	if (value === "full") return "full";
	if (value === "1" || value === "true" || value === "on" || value === "summary") return "summary";
	return "off";
}

function createState(mode: SqlTraceMode, dir: string): State {
	const slow = Number(process.env.NF_SQL_TRACE_SLOW_MS);
	return {
		mode,
		dir,
		slowMs: Number.isFinite(slow) && slow >= 0 ? slow : 5,
		als: new AsyncLocalStorage<SqlTraceSpan>(),
		instrumented: new WeakSet(),
		fingerprints: new Map(),
		catalog: new Set(),
		catalogDay: "",
		callsites: new Map(),
		bgSpans: new Map(),
		dirty: new Set(),
		buffer: [],
		bufferBytes: 0,
		dropped: 0,
		writing: false,
		timer: null,
		txDepth: 0,
		procTag: Math.random().toString(36).slice(2, 6),
		fileTag: `p${process.pid}${isMainThread ? "" : `-t${threadId}`}`,
		seq: 0,
		started: false,
	};
}

function state(): State {
	const g = globalThis as GlobalWithState;
	let s = g[STATE_KEY];
	if (!s) {
		// Test runs never trace unless a test configures it explicitly: agent shells inherit the
		// server's environment, so `NF_SQL_TRACE` would otherwise leak into `bun test`.
		const mode = process.env.NARRAFORK_TEST === "1" ? "off" : parseMode(process.env.NF_SQL_TRACE);
		s = createState(mode, getNarraforkPath("sql-trace"));
		g[STATE_KEY] = s;
	}
	return s;
}

export function sqlTraceMode(): SqlTraceMode {
	return state().mode;
}

export function getSqlTraceDir(): string {
	return state().dir;
}

const round = (ms: number) => Math.round(ms * 1000) / 1000;

function localDay(date = new Date()): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// Spans
// ---------------------------------------------------------------------------

export class SqlTraceSpan {
	readonly id: string;
	readonly parent: string | undefined;
	readonly kind: SqlTraceSpanKind;
	label: string;
	attrs: Record<string, unknown>;
	ended = false;
	/** Set by a caller that has taken over ending this span (WS dispatch). */
	claimed = false;
	private readonly t0 = performance.now();
	private readonly ts = new Date().toISOString();
	private windowStart = Date.now();
	private windowTs = this.ts;
	private emitted = false;
	private stmts = new Map<string, StmtAgg>();
	private n = 0;
	private ms = 0;
	private max = 0;
	private txN = 0;
	private txMs = 0;
	/** Totals across the whole span, for Server-Timing. */
	totalN = 0;
	totalMs = 0;

	constructor(
		kind: SqlTraceSpanKind,
		label: string,
		attrs: Record<string, unknown> = {},
		parent?: SqlTraceSpan | string,
	) {
		const s = state();
		this.id = `${s.procTag}${(++s.seq).toString(36)}`;
		this.kind = kind;
		this.label = label;
		this.attrs = attrs;
		this.parent = typeof parent === "string" ? parent : parent?.id;
	}

	add(h: string, ms: number, rows: number): void {
		let agg = this.stmts.get(h);
		if (!agg) {
			agg = { n: 0, ms: 0, max: 0, rows: 0 };
			this.stmts.set(h, agg);
		}
		agg.n++;
		agg.ms += ms;
		agg.rows += rows;
		if (ms > agg.max) agg.max = ms;
		this.n++;
		this.ms += ms;
		if (ms > this.max) this.max = ms;
		this.totalN++;
		this.totalMs += ms;
		state().dirty.add(this);
	}

	addTx(ms: number): void {
		this.txN++;
		this.txMs += ms;
		state().dirty.add(this);
	}

	/** End the span and emit its final record. Idempotent. */
	end(attrs?: Record<string, unknown>): void {
		if (this.ended) return;
		if (attrs) Object.assign(this.attrs, attrs);
		this.ended = true;
		this.emit({ end: true, ms: round(performance.now() - this.t0) });
	}

	/** `Server-Timing` header value describing this span's SQL so far. */
	serverTiming(): string {
		return `sql;dur=${round(this.totalMs)};desc="${this.totalN} queries"`;
	}

	/** Called by the periodic flusher for spans with pending stats. */
	tick(now: number): void {
		if (this.n === 0 && this.txN === 0) {
			state().dirty.delete(this);
			return;
		}
		if (this.ended) this.emit({ late: true });
		else if (now - this.windowStart >= WINDOW_MS) this.emit({ partial: true });
	}

	private emit(extra: Record<string, unknown>): void {
		const s = state();
		s.dirty.delete(this);
		// Spans that never ran SQL are still recorded once on end (for request-level context),
		// except background windows, which only exist to carry SQL.
		if (this.n === 0 && this.txN === 0 && (this.emitted || this.kind === "bg")) return;
		const sorted = [...this.stmts.entries()].sort((a, b) => b[1].ms - a[1].ms);
		const stmts = sorted.slice(0, MAX_STMTS_PER_RECORD).map(([h, agg]) => ({
			h,
			n: agg.n,
			ms: round(agg.ms),
			max: round(agg.max),
			rows: agg.rows,
		}));
		if (sorted.length > MAX_STMTS_PER_RECORD) {
			const rest = sorted.slice(MAX_STMTS_PER_RECORD);
			stmts.push({
				h: "_other",
				n: rest.reduce((sum, [, a]) => sum + a.n, 0),
				ms: round(rest.reduce((sum, [, a]) => sum + a.ms, 0)),
				max: round(Math.max(...rest.map(([, a]) => a.max))),
				rows: rest.reduce((sum, [, a]) => sum + a.rows, 0),
			});
		}
		push({
			t: "span",
			id: this.id,
			...(this.parent ? { parent: this.parent } : {}),
			kind: this.kind,
			label: this.label,
			ts: this.emitted ? this.windowTs : this.ts,
			...extra,
			n: this.n,
			sqlMs: round(this.ms),
			maxMs: round(this.max),
			...(this.txN ? { txN: this.txN, txMs: round(this.txMs) } : {}),
			...(Object.keys(this.attrs).length ? { a: this.attrs } : {}),
			stmts,
		});
		this.emitted = true;
		this.stmts = new Map();
		this.n = 0;
		this.ms = 0;
		this.max = 0;
		this.txN = 0;
		this.txMs = 0;
		this.windowStart = Date.now();
		this.windowTs = new Date(this.windowStart).toISOString();
	}
}

export function currentSqlTraceSpan(): SqlTraceSpan | undefined {
	const s = state();
	return s.mode === "off" ? undefined : s.als.getStore();
}

/** Start a span whose parent is the current span. Returns null when tracing is off. */
export function startSqlTraceSpan(
	kind: SqlTraceSpanKind,
	label: string,
	attrs?: Record<string, unknown>,
	/** Explicit parent id, for spans continuing work handed over from another thread. */
	parentId?: string,
): SqlTraceSpan | null {
	const s = state();
	if (s.mode === "off") return null;
	ensureStarted();
	return new SqlTraceSpan(kind, label, attrs, parentId ?? s.als.getStore());
}

/** Run `fn` with `span` as the current span (no-op wrapper when span is null). */
export function runInSqlTraceSpan<T>(span: SqlTraceSpan | null, fn: () => T): T {
	if (!span) return fn();
	return state().als.run(span, fn);
}

/** Start a child span, run `fn` inside it and end it when `fn` settles. */
export function withSqlTraceSpan<T>(
	kind: SqlTraceSpanKind,
	label: string,
	attrs: Record<string, unknown> | undefined,
	fn: () => T,
): T {
	const span = startSqlTraceSpan(kind, label, attrs);
	if (!span) return fn();
	let result: T;
	try {
		result = state().als.run(span, fn);
	} catch (error) {
		span.end({ error: true });
		throw error;
	}
	if (result instanceof Promise) {
		result.then(
			() => span.end(),
			() => span.end({ error: true }),
		);
	} else {
		span.end();
	}
	return result;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** Normalise literals so the same statement shape shares one fingerprint. */
export function normalizeSql(sql: string): string {
	return sql
		.replace(/'(?:[^']|'')*'/g, "?")
		.replace(/[?$:@]\d+/g, "?")
		.replace(/\b\d+(?:\.\d+)?\b/g, "?")
		.replace(/\s+/g, " ")
		.replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, "(?, …)")
		.replace(/(\(\?, …\)\s*,\s*)+\(\?, …\)/g, "(?, …), …")
		.trim();
}

function fingerprint(sql: string): Fingerprint {
	const s = state();
	let fp = s.fingerprints.get(sql);
	if (!fp) {
		const text = normalizeSql(sql).slice(0, MAX_SQL_TEXT);
		fp = { h: Bun.hash.wyhash(text).toString(16).padStart(16, "0").slice(0, 12), text };
		if (s.fingerprints.size >= MAX_FINGERPRINT_CACHE) s.fingerprints.clear();
		s.fingerprints.set(sql, fp);
	}
	const day = localDay();
	if (day !== s.catalogDay) {
		s.catalogDay = day;
		s.catalog.clear();
	}
	if (!s.catalog.has(fp.h)) {
		s.catalog.add(fp.h);
		push({ t: "stmt", h: fp.h, sql: fp.text });
	}
	return fp;
}

const SKIP_FRAME =
	/lib\/sql-trace\.ts|node_modules|bun:sqlite|server\/db\/connection\.ts|\[native code\]|^\s*at\s*$/;

/** First application frame below the SQLite call, as `fn@server/path.ts:line`. */
function captureCallsite(): string {
	const previous = Error.stackTraceLimit;
	Error.stackTraceLimit = 40;
	const stack = new Error().stack ?? "";
	Error.stackTraceLimit = previous;
	for (const line of stack.split("\n").slice(1)) {
		if (SKIP_FRAME.test(line)) continue;
		const match = /at\s+(?:(.+?)\s+\()?(.+?):(\d+)(?::\d+)?\)?\s*$/.exec(line);
		if (!match) continue;
		const file = match[2] ?? "";
		const idx = file.lastIndexOf("/server/");
		const rel = idx >= 0 ? file.slice(idx + 1) : (file.split("/").slice(-2).join("/") ?? file);
		return `${match[1] ? `${match[1]}@` : ""}${rel}:${match[3]}`;
	}
	return "unknown";
}

function backgroundSpanFor(key: string): SqlTraceSpan {
	const s = state();
	let cached = s.callsites.get(key);
	if (!cached || cached.seen % CALLSITE_RESAMPLE_EVERY === 0) {
		const site = captureCallsite();
		if (!cached) {
			if (s.callsites.size >= MAX_FINGERPRINT_CACHE) s.callsites.clear();
			cached = { site, seen: 0 };
			s.callsites.set(key, cached);
		} else {
			cached.site = site;
		}
	}
	cached.seen++;
	const label = s.bgSpans.has(cached.site) || s.bgSpans.size < MAX_BG_SPANS ? cached.site : "other";
	let span = s.bgSpans.get(label);
	if (!span) {
		span = new SqlTraceSpan("bg", label);
		s.bgSpans.set(label, span);
	}
	return span;
}

function record(sql: string, ms: number, rows: number, op: string): void {
	const s = state();
	if (typeof sql !== "string") return;
	ensureStarted();
	const fp = fingerprint(sql);
	const span = s.als.getStore() ?? backgroundSpanFor(fp.h);
	span.add(fp.h, ms, rows);
	if (s.mode === "full" || ms >= s.slowMs) {
		push({ t: "sql", at: Date.now(), span: span.id, h: fp.h, op, ms: round(ms), rows });
	}
}

function recordTx(ms: number): void {
	const s = state();
	const slow = s.mode === "full" || ms >= s.slowMs;
	const current = s.als.getStore();
	// Transactions are far rarer than statements, so resolving the call site here is affordable
	// whenever it is actually needed (background attribution or a slow-transaction record).
	const site = slow || !current ? captureCallsite() : "";
	const span = current ?? backgroundSpanFor(`tx:${site}`);
	span.addTx(ms);
	if (slow) push({ t: "tx", at: Date.now(), span: span.id, ms: round(ms), site });
}

// ---------------------------------------------------------------------------
// Instrumentation
// ---------------------------------------------------------------------------

type AnyFn = (...args: unknown[]) => unknown;

const rowCount = (result: unknown): number => {
	if (Array.isArray(result)) return result.length;
	if (result && typeof result === "object" && "changes" in result) {
		const changes = (result as { changes: unknown }).changes;
		return typeof changes === "number" ? changes : 0;
	}
	return result === null || result === undefined ? 0 : 1;
};

function timed(orig: AnyFn, sql: string, op: string): AnyFn {
	return (...args: unknown[]) => {
		const t0 = performance.now();
		let result: unknown;
		try {
			result = orig(...args);
			return result;
		} finally {
			record(sql, performance.now() - t0, rowCount(result), op);
		}
	};
}

function timedIterate(orig: AnyFn, sql: string): AnyFn {
	return (...args: unknown[]) => {
		let elapsed = 0;
		let rows = 0;
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			record(sql, elapsed, rows, "iterate");
		};
		const t0 = performance.now();
		const inner = orig(...args) as IterableIterator<unknown>;
		elapsed += performance.now() - t0;
		const wrapped: IterableIterator<unknown> = {
			[Symbol.iterator]() {
				return wrapped;
			},
			next() {
				const start = performance.now();
				try {
					const step = inner.next();
					elapsed += performance.now() - start;
					if (step.done) finish();
					else rows++;
					return step;
				} catch (error) {
					elapsed += performance.now() - start;
					finish();
					throw error;
				}
			},
			return(value?: unknown) {
				finish();
				return inner.return?.(value) ?? { done: true, value };
			},
		};
		return wrapped;
	};
}

const STATEMENT_METHODS = ["all", "get", "run", "values", "raw"] as const;

function wrapStatement(stmt: Statement, sql: string): Statement {
	const s = state();
	if (s.instrumented.has(stmt)) return stmt;
	s.instrumented.add(stmt);
	const target = stmt as unknown as Record<string, unknown>;
	for (const method of STATEMENT_METHODS) {
		const orig = target[method];
		if (typeof orig === "function") target[method] = timed(orig.bind(stmt) as AnyFn, sql, method);
	}
	if (typeof target.iterate === "function") {
		target.iterate = timedIterate((target.iterate as AnyFn).bind(stmt), sql);
	}
	return stmt;
}

function wrapTransaction(tx: AnyFn): AnyFn {
	const wrap = (fn: AnyFn): AnyFn => {
		return (...args: unknown[]) => {
			const s = state();
			if (s.txDepth > 0) return fn(...args);
			s.txDepth++;
			const t0 = performance.now();
			try {
				return fn(...args);
			} finally {
				s.txDepth--;
				recordTx(performance.now() - t0);
			}
		};
	};
	const wrapped = wrap(tx) as AnyFn & Record<string, unknown>;
	const source = tx as AnyFn & Record<string, unknown>;
	for (const variant of ["deferred", "immediate", "exclusive"]) {
		const fn = source[variant];
		if (typeof fn === "function") wrapped[variant] = wrap(fn as AnyFn);
	}
	return wrapped;
}

/**
 * Time every statement on `conn`. No-op when tracing is off or the connection is already
 * instrumented. Bound parameters are never recorded.
 */
export function instrumentSqliteConnection<T extends Database>(conn: T): T {
	const s = state();
	if (s.mode === "off" || s.instrumented.has(conn)) return conn;
	s.instrumented.add(conn);
	ensureStarted();
	const target = conn as unknown as Record<string, unknown>;
	for (const method of ["prepare", "query"] as const) {
		const orig = (target[method] as AnyFn).bind(conn);
		target[method] = (sql: unknown, ...rest: unknown[]) =>
			wrapStatement(orig(sql, ...rest) as Statement, String(sql));
	}
	for (const method of ["run", "exec"] as const) {
		const orig = target[method];
		if (typeof orig !== "function") continue;
		// The SQL text is the first argument here, so the timer is built per call.
		const bound = (orig as AnyFn).bind(conn);
		target[method] = (sql: unknown, ...rest: unknown[]) =>
			timed(bound, String(sql), method)(sql, ...rest);
	}
	const origTx = (target.transaction as AnyFn).bind(conn);
	target.transaction = (fn: unknown) => wrapTransaction(origTx(fn) as AnyFn);
	return conn;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function push(record: Record<string, unknown>): void {
	const s = state();
	const line = `${JSON.stringify(record)}\n`;
	if (s.bufferBytes + line.length > MAX_BUFFER_BYTES) {
		s.dropped++;
		return;
	}
	s.buffer.push(line);
	s.bufferBytes += line.length;
}

function currentFile(s: State): string {
	return join(s.dir, `${localDay()}-${s.fileTag}.ndjson`);
}

function takeBuffer(s: State): string {
	tickSpans(s);
	if (s.dropped > 0) {
		const line = `${JSON.stringify({ t: "dropped", at: Date.now(), count: s.dropped })}\n`;
		s.buffer.push(line);
		s.dropped = 0;
	}
	const text = s.buffer.join("");
	s.buffer = [];
	s.bufferBytes = 0;
	return text;
}

function tickSpans(s: State): void {
	const now = Date.now();
	for (const span of [...s.dirty]) span.tick(now);
}

async function flush(): Promise<void> {
	const s = state();
	if (s.writing) return;
	const text = takeBuffer(s);
	if (!text) return;
	s.writing = true;
	try {
		await appendFile(currentFile(s), text);
	} catch {
		// Tracing must never take the server down; a lost batch is acceptable.
	} finally {
		s.writing = false;
	}
}

/** Write everything still buffered, synchronously (exit paths). Background windows included. */
export function flushSqlTraceSync(): void {
	const s = state();
	if (s.mode === "off" || !s.started) return;
	for (const span of s.bgSpans.values()) span.tick(Number.POSITIVE_INFINITY);
	for (const span of [...s.dirty]) if (!span.ended) span.tick(Number.POSITIVE_INFINITY);
	const text = takeBuffer(s);
	if (!text) return;
	try {
		appendFileSync(currentFile(s), text);
	} catch {
		// best effort
	}
}

async function pruneOldFiles(dir: string): Promise<void> {
	const days = Number(process.env.NF_SQL_TRACE_RETENTION_DAYS ?? 14);
	if (!Number.isFinite(days) || days <= 0) return;
	const cutoff = Date.now() - days * 86_400_000;
	try {
		for (const name of await readdir(dir)) {
			if (!/^\d{4}-\d{2}-\d{2}-.*\.ndjson$/.test(name)) continue;
			const path = join(dir, name);
			if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
		}
	} catch {
		// best effort
	}
}

function ensureStarted(): void {
	const s = state();
	if (s.started || s.mode === "off") return;
	s.started = true;
	try {
		mkdirSync(s.dir, { recursive: true, mode: 0o700 });
	} catch {
		// appendFile will fail silently later
	}
	push({
		t: "meta",
		at: Date.now(),
		ts: new Date().toISOString(),
		mode: s.mode,
		pid: process.pid,
		threadId,
		slowMs: s.slowMs,
	});
	s.timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
	s.timer.unref?.();
	process.on("exit", flushSqlTraceSync);
	if (isMainThread) void pruneOldFiles(s.dir);
}

/** Test hook: reset state with an explicit mode/dir. Returns the previous state for restore. */
export function configureSqlTraceForTest(options: { mode: SqlTraceMode; dir: string }): void {
	const g = globalThis as GlobalWithState;
	const previous = g[STATE_KEY];
	if (previous?.timer) clearInterval(previous.timer);
	if (previous?.started) process.off("exit", flushSqlTraceSync);
	g[STATE_KEY] = createState(options.mode, options.dir);
}
