/** Opt-in, process-local read-bridge observations. No SQL, binds or caller labels are retained. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Context, Next } from "hono";
import { matchedRoutes } from "hono/route";
import { hotSafe } from "./hot-safe";

const LIMITS = { sources: 128, templates: 512, scopes: 1024, sqlBytes: 64 * 1024 } as const;
const BUCKETS = [0.1, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 15000, 60000];
const READ_BUCKETS = [0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
const COUNT_KEYS = [
	"logicalReads",
	"logicalCompleted",
	"logicalFailed",
	"poolEntries",
	"poolCompleted",
	"poolFailed",
	"dedupeHits",
	"dispatched",
	"workerResults",
	"workerErrors",
	"workerDurationMissing",
	"cancelled",
	"timedOut",
	"admissionRejected",
	"dispatchFailed",
	"inlineReads",
	"postgresReads",
	"domainTasks",
	"logicalTemplateUnknown",
	"poolTemplateUnknown",
	"postMessageFailed",
	"preWindowResponses",
] as const;
type Count = (typeof COUNT_KEYS)[number];
type Counts = Record<Count, number>;
export type ReadFanoutPhase =
	| "compileSync"
	| "mapSync"
	| "workerAcquire"
	| "coldStart"
	| "queueWait"
	| "dispatchToResponse"
	| "dispatchToAbandon"
	| "workerWall";
export interface ReadFanoutHistogram {
	count: number;
	sumMs: number;
	maxMs: number;
	buckets: number[];
}
interface ReadCountHistogram {
	count: number;
	sumReads: number;
	maxReads: number;
	buckets: number[];
}
type Timings = Record<ReadFanoutPhase, ReadFanoutHistogram>;
interface Aggregate {
	counts: Counts;
	timings: Timings;
}
interface ScopeRow {
	scopeId: number;
	source: string;
	logicalReads: number;
	poolEntries: number;
	dispatched: number;
	completed: boolean;
}
interface SourceRow extends Aggregate {
	source: string;
	scopesStarted: number;
	scopesCompleted: number;
	readsPerScope: ReadCountHistogram;
}
export interface ReadFanoutReport {
	schemaVersion: 1;
	captureId: string;
	durationMs: number;
	startedAt: string;
	endedAt: string;
	endReason: "stop" | "timeout";
	coverage: typeof COVERAGE;
	limits: typeof LIMITS;
	histogramUpperBoundsMs: (number | "infinity")[];
	readsPerScopeUpperBounds: (number | "infinity")[];
	totals: Counts & {
		logicalUnfinished: number;
		poolUnfinished: number;
		dispatchedUnfinished: number;
		scopesStarted: number;
		scopesCompleted: number;
		scopesUnfinished: number;
	};
	timings: Timings;
	sources: SourceRow[];
	templates: { fingerprint: string; counts: Counts }[];
	scopes: ScopeRow[];
	overflow: {
		sources: number;
		templates: number;
		scopes: number;
		oversizedSql: number;
		observationErrors: number;
	};
}
const COVERAGE = {
	covered: "public_read_bridge_and_read_worker_pool",
	logicalReads: "One outer public bridge invocation; nested bridge delegation is not another read.",
	poolEntries: "Every pool invocation, including dedupe subscribers and rejected admission.",
	dispatched: "Successful task postMessage calls; chunk ACK and cancel messages excluded.",
	inFlight: "Existing pool inFlight is a dedupe map, not an active-task count; not used here.",
	outcomes:
		"Pool completion/failure counts callers (including shared subscribers). cancelled/timedOut/admissionRejected are disjoint failure classifications; admissionRejected means non-shared admission/acquisition failure before a successful task post; a failed dedupe subscription is not an admission rejection. postMessageFailed is a synchronous transport failure. dispatchFailed means a successfully posted task settled without a terminal reply. dispatchedUnfinished counts posts without a terminal reply, including dispatchFailed: native completion is unknown, not necessarily still running. workerDurationMissing counts terminal replies without a valid successful duration, not tasks lacking a reply.",
	overflow:
		"Source/template overflow counts observations routed to the reserved overflow bucket, not distinct dropped names/templates. Scope overflow counts scopes without per-scope rows; source totals and completed-scope read distributions continue. Empty reserved overflow rows count toward the limits.",
	sql: "Exact SQL template HMAC per capture; equal templates do not imply equal binds or safe merging.",
	unknown:
		"Direct synchronous SQLite and PostgreSQL-driver SQL are not observed. Inline/PG bridge calls are counted, not their SQL execution. Domain/batch internal SQL count and templates are unknown.",
	attribution:
		"Scopes correlate HTTP/WS work, not user actions across requests. background_or_unattributed means no observed scope (including requests begun before capture); detached means work after its observed scope returned; pre_window means a scope from another capture. preWindowResponses counts terminal replies to tasks admitted before capture with no span; they are not new dispatches.",
	timing:
		"Monotonic intervals except workerWall from existing successful worker durationMs (wall time, not SQL CPU). Intervals overlap; never sum them. compileSync counts adapter compile entry, not internal Drizzle constructions. mapSync excludes yields. dispatchToResponse measures terminal replies; dispatchToAbandon separately measures caller failure without a reply.",
} as const;
const PHASES: ReadFanoutPhase[] = [
	"compileSync",
	"mapSync",
	"workerAcquire",
	"coldStart",
	"queueWait",
	"dispatchToResponse",
	"dispatchToAbandon",
	"workerWall",
];
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const CHANNELS = new Set(["narrator", "external-narrator", "terminal", "vnet", "device"]);
// Only protocol-owned message names are emitted; never trust an arbitrary frame's type string.
const WS_TYPES = new Map<string, ReadonlySet<string>>([
	[
		"narrator",
		new Set([
			"pong",
			"subscribe",
			"unsubscribe",
			"outline_binary",
			"reasoning_translation_visibility",
			"editor_file_subscribe",
			"editor_file_unsubscribe",
			"git_workspace_subscribe",
			"git_workspace_unsubscribe",
			"git_workspace_refresh",
			"outline_page_subscribe",
			"outline_page_unsubscribe",
			"permission_decision",
			"buffer_message",
			"cancel_buffer",
			"update_buffer",
			"remove_buffer",
			"presence_join",
			"presence_leave",
			"chat_subscribe",
			"chat_unsubscribe",
			"subscribe_stats",
			"unsubscribe_stats",
			"sync_check",
			"update_timeout",
		]),
	],
	[
		"external-narrator",
		new Set(["pong", "subscribe", "unsubscribe", "sync_check", "send_message", "interrupt"]),
	],
	[
		"terminal",
		new Set(["pong", "subscribe", "unsubscribe", "input", "resize", "create", "kill", "rename"]),
	],
	["vnet", new Set(["hello", "relay_packet", "punch_request", "pong"])],
	[
		"device",
		new Set([
			"ping",
			"pong",
			"hello",
			"auth_init",
			"auth_proof",
			"rpc",
			"rpc_cancel",
			"rpc_result",
			"rpc_stream",
			"binary",
		]),
	],
]);
const CONTROL = new Set([
	"/api/admin/diagnostics/read-fanout/start",
	"/api/admin/diagnostics/read-fanout/stop",
]);
interface Scope {
	capture: Capture;
	source: SourceRow;
	row?: ScopeRow;
	logicalReads: number;
	open: boolean;
}
interface Capture extends Aggregate {
	captureId: string;
	durationMs: number;
	startedAt: string;
	startedMono: number;
	key: Buffer;
	sources: Map<string, SourceRow>;
	templates: Map<string, { fingerprint: string; counts: Counts }>;
	scopes: ScopeRow[];
	scopeCount: number;
	scopesCompleted: number;
	overflow: ReadFanoutReport["overflow"];
	timer?: ReturnType<typeof setTimeout>;
	closed: boolean;
}
export interface ReadFanoutSpan {
	/** Opaque to callers; only this module mutates observations. */
	capture: Capture;
	source: SourceRow;
	scope?: ScopeRow;
	scopeContext?: Scope;
	kind: "logical" | "pool";
	finished: boolean;
	posted: boolean;
	postFailed?: boolean;
	shared?: boolean;
	response: boolean;
	postedAt?: number;
	template?: string;
}
const captureState = hotSafe<{
	active?: Capture;
	recent?: ReadFanoutReport;
	recentExpiresAt?: number;
	recentTimer?: ReturnType<typeof setTimeout>;
	scopeStorage: AsyncLocalStorage<Scope | "excluded">;
}>("narrafork.readFanoutDiagnostics", () => ({
	scopeStorage: new AsyncLocalStorage<Scope | "excluded">(),
}));
const scopeStorage = captureState.scopeStorage;
function histogram(bounds = BUCKETS): ReadFanoutHistogram {
	return { count: 0, sumMs: 0, maxMs: 0, buckets: Array(bounds.length + 1).fill(0) };
}
function counts(): Counts {
	return Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])) as Counts;
}
function timings(): Timings {
	return Object.fromEntries(PHASES.map((key) => [key, histogram()])) as Timings;
}
function observe(hist: ReadFanoutHistogram, value: number, bounds = BUCKETS) {
	if (!Number.isFinite(value) || value < 0) return;
	hist.count++;
	hist.sumMs += value;
	hist.maxMs = Math.max(hist.maxMs, value);
	const index = bounds.findIndex((bound) => value <= bound);
	hist.buckets[index < 0 ? bounds.length : index]++;
}
function safely<T>(work: () => T): T | undefined {
	try {
		return work();
	} catch {
		if (captureState.active) captureState.active.overflow.observationErrors++;
		return undefined;
	}
}
function current(): Capture | undefined {
	if (scopeStorage.getStore() === "excluded") return undefined;
	return captureState.active;
}
function source(capture: Capture, name: string): SourceRow {
	const found = capture.sources.get(name);
	if (found) return found;
	if (capture.sources.size >= LIMITS.sources && name !== "overflow") {
		capture.overflow.sources++;
		return source(capture, "overflow");
	}
	const row = {
		source: name,
		counts: counts(),
		timings: timings(),
		scopesStarted: 0,
		scopesCompleted: 0,
		readsPerScope: {
			count: 0,
			sumReads: 0,
			maxReads: 0,
			buckets: Array(READ_BUCKETS.length + 1).fill(0),
		},
	};
	capture.sources.set(name, row);
	return row;
}
function valid(span: ReadFanoutSpan | undefined): span is ReadFanoutSpan {
	return !!span && span.capture === captureState.active && !span.capture.closed;
}
function increment(span: ReadFanoutSpan, key: Count) {
	span.capture.counts[key]++;
	span.source.counts[key]++;
	if (span.template) {
		const row = span.capture.templates.get(span.template);
		if (row) row.counts[key]++;
	}
}
export class ReadFanoutControlError extends Error {
	constructor(
		readonly status: 400 | 404 | 409,
		message: string,
	) {
		super(message);
	}
}
function forgetRecent() {
	clearTimeout(captureState.recentTimer);
	captureState.recentTimer = undefined;
	captureState.recent = undefined;
	captureState.recentExpiresAt = undefined;
}
export function startReadFanoutCapture(durationMs = 30_000) {
	if (!Number.isInteger(durationMs) || durationMs <= 0 || durationMs > 60_000)
		throw new ReadFanoutControlError(400, "durationMs must be an integer from 1 to 60000");
	if (captureState.active)
		throw new ReadFanoutControlError(409, "A read-fanout capture is already active");
	forgetRecent();
	const capture: Capture = {
		captureId: randomUUID(),
		durationMs,
		startedAt: new Date().toISOString(),
		startedMono: performance.now(),
		key: randomBytes(32),
		counts: counts(),
		timings: timings(),
		sources: new Map(),
		templates: new Map(),
		scopes: [],
		scopeCount: 0,
		scopesCompleted: 0,
		overflow: { sources: 0, templates: 0, scopes: 0, oversizedSql: 0, observationErrors: 0 },
		closed: false,
	};
	// Reserve one overflow bucket within the advertised source/template bounds.
	source(capture, "overflow");
	capture.templates.set("overflow", { fingerprint: "overflow", counts: counts() });
	captureState.active = capture;
	capture.timer = setTimeout(() => {
		safely(() => finishCapture(capture, "timeout"));
	}, durationMs);
	capture.timer.unref?.();
	return {
		captureId: capture.captureId,
		durationMs,
		startedAt: capture.startedAt,
		endsAt: new Date(Date.parse(capture.startedAt) + durationMs).toISOString(),
	};
}
function finishCapture(capture: Capture, reason: "stop" | "timeout"): ReadFanoutReport {
	clearTimeout(capture.timer);
	capture.closed = true;
	if (captureState.active === capture) captureState.active = undefined;
	const c = capture.counts;
	const endedMono = performance.now();
	const report: ReadFanoutReport = {
		schemaVersion: 1,
		captureId: capture.captureId,
		startedAt: capture.startedAt,
		endedAt: new Date().toISOString(),
		durationMs: endedMono - capture.startedMono,
		endReason: reason,
		coverage: COVERAGE,
		limits: LIMITS,
		histogramUpperBoundsMs: [...BUCKETS, "infinity"],
		readsPerScopeUpperBounds: [...READ_BUCKETS, "infinity"],
		totals: {
			...c,
			logicalUnfinished: c.logicalReads - c.logicalCompleted - c.logicalFailed,
			poolUnfinished: c.poolEntries - c.poolCompleted - c.poolFailed,
			dispatchedUnfinished: c.dispatched - c.workerResults - c.workerErrors,
			scopesStarted: capture.scopeCount,
			scopesCompleted: capture.scopesCompleted,
			scopesUnfinished: capture.scopeCount - capture.scopesCompleted,
		},
		timings: capture.timings,
		sources: [...capture.sources.values()],
		templates: [...capture.templates.values()],
		scopes: capture.scopes,
		overflow: capture.overflow,
	};
	// Snapshot: held spans must not mutate a consumed report after the window closes.
	const snapshot = structuredClone(report);
	capture.key.fill(0);
	capture.sources.clear();
	capture.templates.clear();
	capture.scopes = [];
	forgetRecent();
	captureState.recent = snapshot;
	captureState.recentExpiresAt = endedMono + 60_000;
	captureState.recentTimer = setTimeout(forgetRecent, 60_000);
	captureState.recentTimer.unref?.();
	return snapshot;
}
export function stopReadFanoutCapture(captureId: string): ReadFanoutReport {
	if (typeof captureId !== "string" || !captureId || captureId.length > 128)
		throw new ReadFanoutControlError(400, "captureId is required");
	if (captureState.active?.captureId === captureId) finishCapture(captureState.active, "stop");
	if (
		captureState.recentExpiresAt !== undefined &&
		performance.now() >= captureState.recentExpiresAt
	)
		forgetRecent();
	if (captureState.recent?.captureId !== captureId)
		throw new ReadFanoutControlError(404, "Capture not found");
	const report = captureState.recent;
	forgetRecent();
	return report;
}
export function isReadFanoutCaptureActive(): boolean {
	return !!current();
}
/** Capture once at pool admission: worker replies do not inherit the caller's ALS context. */
export function isReadFanoutScopeExcluded(): boolean {
	return scopeStorage.getStore() === "excluded";
}
export function beginReadFanoutSpan(kind: "logical" | "pool"): ReadFanoutSpan | undefined {
	if (!current()) return undefined;
	return safely(() => {
		const capture = current();
		if (!capture) return;
		const scope = scopeStorage.getStore();
		const observed = scope && scope !== "excluded" ? scope : undefined;
		const name = !observed
			? "background_or_unattributed"
			: observed.capture !== capture
				? "pre_window"
				: !observed.open
					? "detached"
					: observed.source.source;
		const span: ReadFanoutSpan = {
			capture,
			source: source(capture, name),
			scope: observed?.capture === capture && observed.open ? observed.row : undefined,
			scopeContext: observed?.capture === capture && observed.open ? observed : undefined,
			kind,
			finished: false,
			posted: false,
			response: false,
		};
		increment(span, kind === "logical" ? "logicalReads" : "poolEntries");
		if (span.scope) span.scope[kind === "logical" ? "logicalReads" : "poolEntries"]++;
		if (kind === "logical" && span.scopeContext) span.scopeContext.logicalReads++;
		return span;
	});
}
export function countReadFanout(span: ReadFanoutSpan | undefined, key: Count): void {
	if (!valid(span)) return;
	safely(() => increment(span, key));
}
export function recordReadFanoutSql(span: ReadFanoutSpan | undefined, sql: string): void {
	if (!valid(span) || span.template) return;
	safely(() => {
		let fingerprint: string;
		if (sql.length > LIMITS.sqlBytes || Buffer.byteLength(sql, "utf8") > LIMITS.sqlBytes) {
			span.capture.overflow.oversizedSql++;
			fingerprint = "oversized_sql";
		} else fingerprint = createHmac("sha256", span.capture.key).update(sql).digest("hex");
		if (!span.capture.templates.has(fingerprint)) {
			if (span.capture.templates.size >= LIMITS.templates) {
				span.capture.overflow.templates++;
				fingerprint = "overflow";
			} else span.capture.templates.set(fingerprint, { fingerprint, counts: counts() });
		}
		span.template = fingerprint;
		const row = span.capture.templates.get(fingerprint);
		if (row) row.counts[span.kind === "logical" ? "logicalReads" : "poolEntries"]++;
	});
}
export function readFanoutNow(span: ReadFanoutSpan | undefined): number | undefined {
	return valid(span) ? safely(() => performance.now()) : undefined;
}
export function recordReadFanoutTiming(
	span: ReadFanoutSpan | undefined,
	phase: ReadFanoutPhase,
	elapsedMs: number | undefined,
): void {
	if (!valid(span) || elapsedMs === undefined) return;
	safely(() => {
		observe(span.capture.timings[phase], elapsedMs);
		observe(span.source.timings[phase], elapsedMs);
	});
}
export function endReadFanoutTiming(
	span: ReadFanoutSpan | undefined,
	phase: ReadFanoutPhase,
	started: number | undefined,
): void {
	if (!valid(span) || started === undefined) return;
	safely(() => recordReadFanoutTiming(span, phase, performance.now() - started));
}
export function timeReadFanoutSync<T>(
	span: ReadFanoutSpan | undefined,
	phase: "compileSync" | "mapSync",
	work: () => T,
): T {
	if (!valid(span)) return work();
	const started = readFanoutNow(span);
	try {
		return work();
	} finally {
		endReadFanoutTiming(span, phase, started);
	}
}
export function postReadFanoutTask(span: ReadFanoutSpan | undefined): void {
	if (!valid(span) || span.posted) return;
	safely(() => {
		span.posted = true;
		span.postedAt = readFanoutNow(span);
		increment(span, "dispatched");
		if (span.scope) span.scope.dispatched++;
	});
}
export function shareReadFanoutTask(span: ReadFanoutSpan | undefined): void {
	if (!valid(span)) return;
	safely(() => {
		span.shared = true;
		increment(span, "dedupeHits");
	});
}
export function failReadFanoutPost(span: ReadFanoutSpan | undefined): void {
	if (!valid(span)) return;
	safely(() => {
		span.postFailed = true;
		increment(span, "postMessageFailed");
	});
}
export function receiveReadFanoutTask(
	span: ReadFanoutSpan | undefined,
	result: "result" | "error",
	durationMs?: number,
	excluded = false,
): void {
	if (excluded) return;
	if (!span) {
		// The worker callback may have inherited an unrelated/excluded creation context.
		const capture = captureState.active;
		if (capture) safely(() => capture.counts.preWindowResponses++);
		return;
	}
	if (!valid(span) || span.response || !span.posted) return;
	safely(() => {
		span.response = true;
		increment(span, result === "result" ? "workerResults" : "workerErrors");
		endReadFanoutTiming(span, "dispatchToResponse", span.postedAt);
		if (
			result === "result" &&
			typeof durationMs === "number" &&
			Number.isFinite(durationMs) &&
			durationMs >= 0
		)
			recordReadFanoutTiming(span, "workerWall", durationMs);
		else increment(span, "workerDurationMissing");
	});
}
export function finishReadFanoutSpan(span: ReadFanoutSpan | undefined, error?: unknown): void {
	if (!valid(span) || span.finished) return;
	safely(() => {
		span.finished = true;
		increment(
			span,
			span.kind === "logical"
				? error === undefined
					? "logicalCompleted"
					: "logicalFailed"
				: error === undefined
					? "poolCompleted"
					: "poolFailed",
		);
		if (span.kind !== "pool" || error === undefined) return;
		// Compare only trusted error codes; no error text, URLs or identifiers enter the report.
		const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
		if (code === "DB_READ_ABORTED") increment(span, "cancelled");
		else if (code === "DB_READ_TASK_TIMEOUT") increment(span, "timedOut");
		else if (!span.posted && !span.postFailed && !span.shared) increment(span, "admissionRejected");
		if (span.posted && !span.response) {
			increment(span, "dispatchFailed");
			endReadFanoutTiming(span, "dispatchToAbandon", span.postedAt);
		}
	});
}
function runScope<T>(name: string, work: () => T): T {
	const capture = current();
	if (!capture) return work();
	const scope = safely<Scope>(() => {
		const entry = source(capture, name);
		entry.scopesStarted++;
		capture.scopeCount++;
		const row =
			capture.scopes.length < LIMITS.scopes
				? {
						scopeId: capture.scopeCount,
						source: entry.source,
						logicalReads: 0,
						poolEntries: 0,
						dispatched: 0,
						completed: false,
					}
				: undefined;
		if (row) capture.scopes.push(row);
		else capture.overflow.scopes++;
		return { capture, source: entry, row, logicalReads: 0, open: true };
	});
	if (!scope) return work();
	const end = () => {
		safely(() => {
			scope.open = false;
			if (scope.capture !== captureState.active) return;
			scope.capture.scopesCompleted++;
			scope.source.scopesCompleted++;
			if (scope.row) scope.row.completed = true;
			const hist = scope.source.readsPerScope;
			hist.count++;
			hist.sumReads += scope.logicalReads;
			hist.maxReads = Math.max(hist.maxReads, scope.logicalReads);
			const index = READ_BUCKETS.findIndex((bound) => scope.logicalReads <= bound);
			hist.buckets[index < 0 ? READ_BUCKETS.length : index]++;
		});
	};
	return scopeStorage.run(scope, () => {
		let result: T;
		try {
			result = work();
		} catch (error) {
			end();
			throw error;
		}
		if (result instanceof Promise) return result.finally(end) as T;
		end();
		return result;
	});
}
export function runReadFanoutWebSocketScope<T>(
	channel: string,
	messageType: unknown,
	work: () => T,
): T {
	if (!current()) return work();
	const name = `WS ${CHANNELS.has(channel) ? channel : "unknown"} ${typeof messageType === "string" && WS_TYPES.get(channel)?.has(messageType) ? messageType : "unknown"}`;
	return runScope(name, work);
}
/** Hono route metadata is already matched before middleware/requireAuth executes. */
export function readFanoutHttpMiddleware(c: Context, next: Next): Promise<void> {
	if (!captureState.active) return next();
	const metadata = safely(() =>
		matchedRoutes(c)
			.filter((route) => route.method !== "ALL" && route.path.startsWith("/api/"))
			.at(-1),
	);
	if (metadata && CONTROL.has(metadata.path)) return scopeStorage.run("excluded", next);
	const method = METHODS.has(c.req.method) ? c.req.method : "unknown";
	// Paths come only from registered router metadata, never c.req.path/url/params/query.
	const routeTemplate = metadata && metadata.path.length <= 512 ? metadata.path : "unknown";
	return runScope(`HTTP ${method} ${routeTemplate}`, next);
}
/** Test isolation only; no production endpoint exposes internal state or keys. */
export function resetReadFanoutDiagnosticsForTest(): void {
	if (captureState.active) {
		clearTimeout(captureState.active.timer);
		captureState.active.closed = true;
		captureState.active.key.fill(0);
	}
	captureState.active = undefined;
	forgetRecent();
}
