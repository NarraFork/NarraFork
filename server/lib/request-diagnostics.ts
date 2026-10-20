import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { requestDiagnosticWriter } from "./request-diagnostic-writer";
import { sqlExecutionDiagnostics } from "./sql-execution-diagnostics";

const phaseNames = [
	"git.authorize",
	"git.modifications",
	"modifications.actor-access",
	"modifications.status",
	"modifications.scopes",
	"modifications.view",
	"modifications.redact",
	"modifications.identity",
	"modifications.history",
	"modifications.history.read",
	"modifications.history.mapFilter",
	"modifications.history.sortFilter",
	"modifications.actors",
	"modifications.current-diff",
	"baseline.before",
	"baseline.after",
	"blob.verify",
	"actor.resolve",
	"yield",
	"worker.startup",
	"worker.response",
	"worker.cleanup",
	"evidence.sync",
	"consistency.sync",
] as const;
const sqlNames = [
	"scope",
	"effect",
	"operation",
	"projection",
	"blobs",
	"summaries",
	"observations",
] as const;
type PhaseName = (typeof phaseNames)[number];
type SqlName = (typeof sqlNames)[number];
type Aggregate = { count: number; totalMs: number; maxMs: number; slowCount: number };
// Fixed instrumentation labels locate source call sites; never a workspace/file path.
type SlowSync = { name: string; site: string; startMs: number; endMs: number; durationMs: number };
type Trace = {
	id: string;
	route: string;
	scopeId?: string;
	start: number;
	end: number;
	status: number;
	cancelled: boolean;
	closed: boolean;
	clock: () => number;
	phases: Record<string, Aggregate>;
	sqlOperations: Record<string, Aggregate>;
	sql: Aggregate;
	sqlTop: SlowSync[];
	slowSync: SlowSync[];
};
type Sample = { start: number; end: number; lag: number };
export interface DiagnosticRecord {
	ts: string;
	kind: string;
	requestId: string;
	route: string;
	scopeId?: string;
	status: number;
	cancelled: boolean;
	wallMs: number;
	startMs: number;
	endMs: number;
	clock: string;
	loop: {
		maxLagMs: number;
		samples: number;
		coverage: string;
		truncated: boolean;
		attribution: string;
		window: string;
		delayStartMs: number | null;
		delayEndMs: number | null;
	};
	phases: Record<string, Aggregate>;
	sqlOperations: Record<string, Aggregate>;
	timing: string;
	sql: Aggregate;
	sqlTop: SlowSync[];
	slowSync: SlowSync[];
	suppressed: number;
	pendingDropped: number;
	writerDropped: number;
}
const storage = new AsyncLocalStorage<Trace>();
const aggregate = (): Aggregate => ({ count: 0, totalMs: 0, maxMs: 0, slowCount: 0 });
const round = (n: number) => Math.round(n * 100) / 100;
function add(a: Aggregate, ms: number) {
	a.count++;
	a.totalMs += ms;
	a.maxMs = Math.max(a.maxMs, ms);
	if (ms >= 50) a.slowCount++;
}
function top(items: SlowSync[], item: SlowSync) {
	items.push(item);
	items.sort((a, b) => b.durationMs - a.durationMs);
	items.length = Math.min(items.length, 3);
}

/** Values are fixed categories, never raw paths, methods, query strings or user labels. */
export function diagnosticRoute(path: string): string {
	if (/^\/api\/(?:projects|chapters|narrators)\/[^/]+\/git\/modifications$/.test(path))
		return "git.modifications";
	for (const name of [
		"git",
		"chapters",
		"narrators",
		"projects",
		"auth",
		"health",
		"settings",
		"storage",
		"devices",
	]) {
		if (path === `/api/${name}` || path.startsWith(`/api/${name}/`)) return name;
	}
	return "other";
}

export class RequestDiagnostics {
	private ring: Sample[] = [];
	private cursor = 0;
	private pending: Trace[] = [];
	private enabled = false;
	private last = 0;
	private perRoute = new Map<string, number>();
	private minute = 0;
	private emitted = 0;
	private suppressed = 0;
	private dropped = 0;
	constructor(
		private readonly emit: (record: DiagnosticRecord) => void,
		private readonly now = () => performance.now(),
	) {}
	start(at = this.now()): void {
		this.enabled = true;
		this.last = at;
		this.ring = [];
		this.cursor = 0;
	}
	stop(): void {
		this.enabled = false;
		for (const trace of this.pending) this.publish(trace, false);
		this.pending = [];
		this.ring = [];
	}
	tick(end: number, lag: number): void {
		if (!this.enabled) return;
		const sample = { start: this.last, end, lag };
		this.ring[this.cursor] = sample;
		this.cursor = (this.cursor + 1) % 600;
		this.last = end;
		const pending = this.pending;
		this.pending = [];
		for (const trace of pending) this.publish(trace, true);
	}
	async request<T>(
		path: string,
		run: (id: string) => Promise<T>,
		outcome: () => { status: number; cancelled: boolean },
	): Promise<T> {
		const trace: Trace = {
			id: randomUUID(),
			route: diagnosticRoute(path),
			start: this.now(),
			end: 0,
			status: 0,
			cancelled: false,
			closed: false,
			clock: this.now,
			phases: {},
			sqlOperations: {},
			sql: aggregate(),
			sqlTop: [],
			slowSync: [],
		};
		return storage.run(trace, async () => {
			try {
				return await sqlExecutionDiagnostics.scope("request", () => run(trace.id), trace.id);
			} finally {
				trace.end = this.now();
				trace.closed = true;
				Object.assign(trace, outcome());
				if (!this.enabled) this.publish(trace, false);
				else if (this.pending.length < 256) this.pending.push(trace);
				else {
					this.dropped++;
					this.publish(trace, false);
				}
			}
		});
	}
	private publish(trace: Trace, completed: boolean): void {
		const samples = this.ring.filter((s) => s.end > trace.start && s.start < trace.end);
		// Only the delayed part of a tick overlaps; time after request end is not evidence.
		const delayed = samples.filter((s) => s.lag > 0 && s.end - s.lag < trace.end);
		const worst = delayed.reduce<Sample | undefined>(
			(max, s) => (!max || s.lag > max.lag ? s : max),
			undefined,
		);
		const lag = worst?.lag ?? 0;
		const wall = trace.end - trace.start;
		if (wall < 1000 && trace.sql.maxMs < 50 && !trace.slowSync.length && lag < 100) return;
		const now = this.now();
		if (now - this.minute >= 60_000) {
			this.minute = now;
			this.emitted = 0;
		}
		if (this.emitted >= 30 || now - (this.perRoute.get(trace.route) ?? -Infinity) < 10_000) {
			this.suppressed++;
			return;
		}
		this.emitted++;
		this.perRoute.set(trace.route, now);
		const earliest = this.ring.reduce((min, s) => Math.min(min, s.start), Infinity);
		const coverage = completed && earliest <= trace.start && this.last >= trace.end;
		const roundedAggregate = (a: Aggregate) => ({
			...a,
			totalMs: round(a.totalMs),
			maxMs: round(a.maxMs),
		});
		this.emit({
			ts: new Date().toISOString(),
			kind: "request-diagnostic",
			requestId: trace.id,
			route: trace.route,
			...(trace.scopeId ? { scopeId: trace.scopeId } : {}),
			status: trace.status,
			cancelled: trace.cancelled,
			wallMs: round(wall),
			startMs: round(trace.start),
			endMs: round(trace.end),
			clock: "performance.now",
			loop: {
				maxLagMs: round(lag),
				samples: samples.length,
				coverage: coverage ? "complete" : "partial",
				truncated: !coverage,
				attribution: "unattributed",
				window: "overlapping-delayed-intervals",
				delayStartMs: worst ? round(worst.end - worst.lag - trace.start) : null,
				delayEndMs: worst ? round(worst.end - trace.start) : null,
			},
			phases: Object.fromEntries(
				Object.entries(trace.phases).map(([name, a]) => [name, roundedAggregate(a)]),
			),
			sqlOperations: Object.fromEntries(
				Object.entries(trace.sqlOperations).map(([name, a]) => [name, roundedAggregate(a)]),
			),
			timing: "git-business-sql-inclusive-wall; not-additive-with-drizzle-prepared-sync",
			sql: roundedAggregate(trace.sql),
			sqlTop: trace.sqlTop,
			slowSync: trace.slowSync,
			suppressed: this.suppressed,
			pendingDropped: this.dropped,
			writerDropped: requestDiagnosticWriter.dropped,
		});
		this.suppressed = 0;
	}
}
export const requestDiagnostics = new RequestDiagnostics((record) =>
	requestDiagnosticWriter.write(`${JSON.stringify(record)}\n`),
);

function record(
	trace: Trace | undefined,
	name: string,
	start: number,
	sql: boolean,
	sync: boolean,
) {
	if (!trace || trace.closed) return;
	const end = trace.clock();
	const ms = end - start;
	const item = {
		name,
		site: `git-current-diff:${name}`,
		startMs: round(start - trace.start),
		endMs: round(end - trace.start),
		durationMs: round(ms),
	};
	if (sql) {
		add(trace.sql, ms);
		trace.sqlOperations[name] ??= aggregate();
		add(trace.sqlOperations[name], ms);
		top(trace.sqlTop, item);
	} else {
		trace.phases[name] ??= aggregate();
		add(trace.phases[name], ms);
	}
	if (sync && ms >= 50) top(trace.slowSync, item);
}
export function diagnosticSql<T>(name: SqlName, fn: () => T): T {
	const trace = storage.getStore();
	if (!trace) return fn();
	const start = trace.clock();
	try {
		return fn();
	} finally {
		record(trace, `sql.${name}`, start, true, true);
	}
}
export function diagnosticSync<T>(
	name:
		| "evidence.sync"
		| "consistency.sync"
		| "modifications.history.mapFilter"
		| "modifications.history.sortFilter",
	fn: () => T,
): T {
	const trace = storage.getStore();
	if (!trace) return fn();
	const start = trace.clock();
	try {
		return fn();
	} finally {
		record(trace, name, start, false, true);
	}
}
/** Accept only the existing hashed Git query scope identity, never a raw path. */
export function diagnosticGitScope(scopeId: string): void {
	const trace = storage.getStore();
	if (trace && !trace.closed && /^[a-f0-9]{16}$/.test(scopeId)) trace.scopeId = scopeId;
}

export async function diagnosticAwait<T>(
	name: Exclude<PhaseName, "evidence.sync" | "consistency.sync">,
	fn: () => Promise<T>,
): Promise<T> {
	const trace = storage.getStore();
	if (!trace) return fn();
	const start = trace.clock();
	try {
		return await fn();
	} finally {
		record(trace, `${name}.await`, start, false, false);
	}
}
