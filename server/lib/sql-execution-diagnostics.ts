import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { requestDiagnosticWriter } from "./request-diagnostic-writer";

export type SqlDiagnosticSite =
	| "request"
	| "background-task.listLegacyRows"
	| "background-task.listPageByParent"
	| "narrator-messages.resolveAggregateScopeTx"
	| "narrator-session.recoverPendingQuestionAnswerDeliveries"
	| "background-occupancy.scanNarrators";
type Context = {
	site: SqlDiagnosticSite;
	contextId: string;
	requestId: string | null;
	start: number;
	count: number;
	totalMs: number;
	maxMs: number;
	errors: number;
	workerCount: number;
	workerElapsedMs: number;
	workerDurationMs: number;
	workerTimedCount: number;
	workerRows: number | null;
	workerBytes: number | null;
	workerErrors: number;
	workerCancelled: number;
	closed: boolean;
};
export type SqlExecutionRecord = Record<string, string | number | null>;
const round = (n: number) => Math.round(n * 1000) / 1000;
const readQuerySites = new Set([
	"modifications.history.perPath",
	"modifications.history.workspace",
	"subagent.exact.boundary",
	"subagent.exact.segments",
	"subagent.exact.operations",
	"subagent.exact.effects",
]);
/** Only these bounded business sites enable additional timings; arbitrary caller strings are ignored. */
export function diagnosticReadQuerySite(site?: string): string | undefined {
	return site && readQuerySites.has(site) ? site : undefined;
}

export interface ReadWorkerDiagnosticStats {
	elapsedMs: number;
	queueWaitMs?: number;
	acquireMs?: number;
	workerActiveMs?: number;
	workerAckWaitMs?: number;
	/** Parent chunk callback synchronous mapping/collection; overlaps worker ACK wait. */
	consumeMs?: number;
	workerDurationMs?: number;
	rows?: number;
	bytes?: number;
	status: "ok" | "error" | "cancelled";
	task: string;
}
const workerTaskKinds = new Set([
	"searchQuery",
	"usageHistoryQuery",
	"storageScanContext",
	"storageScanTables",
	"storageScanSerial",
	"storageScanCleanupSummaries",
	"selectRowsV1",
	"narrator-read-transaction-v1",
	"git-current-diff-read-v1",
	"git-current-diff-validate-v1",
	"worktree-lifecycle-read-v1",
	"projectArchiveReadV1",
	"fileChangeBlobCatalogV1",
	"fileChangeRetentionInventoryV1",
	"workspace-recovery-effects-v1",
	"publication-terminal-result-v1",
	"revertPlanReadV1",
	"revertJournalReadV1",
	"databaseCleanupReadV1",
	"revertSelectionReadV1",
]);
const nonnegative = (value: number | undefined) =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** Fixed cardinality context, counters and event quotas. No query text, binds or exception messages. */
export class SqlExecutionDiagnostics {
	private readonly storage = new AsyncLocalStorage<Context>();
	private minute = -Infinity;
	private slowEvents = 0;
	private summaries = 0;
	private suppressed = 0;
	constructor(
		private readonly emit: (record: SqlExecutionRecord) => void,
		private readonly now = () => performance.now(),
	) {}

	scope<T>(site: SqlDiagnosticSite, run: () => T, requestId?: string): T {
		const parent = this.storage.getStore();
		const context: Context = {
			site,
			contextId: randomUUID(),
			requestId: requestId ?? parent?.requestId ?? null,
			start: this.now(),
			count: 0,
			totalMs: 0,
			maxMs: 0,
			errors: 0,
			workerCount: 0,
			workerElapsedMs: 0,
			workerDurationMs: 0,
			workerTimedCount: 0,
			workerRows: 0,
			workerBytes: 0,
			workerErrors: 0,
			workerCancelled: 0,
			closed: false,
		};
		return this.storage.run(context, () => {
			try {
				const result = run();
				if (result instanceof Promise) {
					// Observe settlement without substituting a promise: finally() adds adoption
					// microtasks to every caller and changes business scheduling.
					void result.then(
						() => this.finish(context),
						() => this.finish(context),
					);
					return result;
				}
				this.finish(context);
				return result;
			} catch (error) {
				this.finish(context);
				throw error;
			}
		});
	}

	private allow(slow: boolean): boolean {
		const now = this.now();
		if (now - this.minute >= 60_000) {
			this.minute = now;
			this.slowEvents = 0;
			this.summaries = 0;
		}
		if (slow ? this.slowEvents >= 30 : this.summaries >= 60) {
			this.suppressed++;
			return false;
		}
		if (slow) this.slowEvents++;
		else this.summaries++;
		return true;
	}

	private publish(record: SqlExecutionRecord): void {
		try {
			this.emit({
				ts: new Date().toISOString(),
				layer: "drizzle-prepared-sync-including-mapping",
				executionLocation: "main-sync",
				clock: "performance.now",
				loopAttribution: "not-established",
				suppressed: this.suppressed,
				...record,
			});
			this.suppressed = 0;
		} catch {
			// Diagnostics must never replace a database result or original error.
		}
	}

	private finish(context: Context): void {
		if (context.closed) return;
		context.closed = true;
		if (context.workerCount && this.allow(false)) {
			this.publish({
				kind: "sql-execution-summary",
				executionLocation: "read-worker",
				layer: "worker-task-wall-including-mapping-and-ack-wait",
				clock: "parent-elapsed; worker-local-duration",
				site: context.site,
				contextId: context.contextId,
				requestId: context.requestId,
				count: context.workerCount,
				elapsedMs: round(context.workerElapsedMs),
				workerDurationMs: round(context.workerDurationMs),
				workerTimedCount: context.workerTimedCount,
				rows: context.workerRows,
				bytes: context.workerBytes,
				errors: context.workerErrors,
				cancelled: context.workerCancelled,
				counting: "exclusive-nearest-scope; task-not-sql-count; not-additive-with-business",
			});
		}
		if (!context.count || !this.allow(false)) return;
		this.publish({
			kind: "sql-execution-summary",
			site: context.site,
			contextId: context.contextId,
			requestId: context.requestId,
			startMs: round(context.start),
			endMs: round(this.now()),
			count: context.count,
			totalMs: round(context.totalMs),
			maxMs: round(context.maxMs),
			errors: context.errors,
			counting: "exclusive-nearest-scope; not-additive-with-git-business-sql",
		});
	}

	correlation(): { requestId: string | null; contextId: string | null } {
		const context = this.storage.getStore();
		return { requestId: context?.requestId ?? null, contextId: context?.contextId ?? null };
	}

	/** Capture before IPC; callbacks may run outside the originating ALS scope. */
	beginReadWorkerDiagnostic(site?: string): (stats: ReadWorkerDiagnosticStats) => void {
		const context = this.storage.getStore();
		const querySite = diagnosticReadQuerySite(site);
		let completed = false;
		return (stats) => {
			if (completed) return;
			completed = true;
			const elapsed = nonnegative(stats.elapsedMs) ?? 0;
			const duration = nonnegative(stats.workerDurationMs);
			const rows = nonnegative(stats.rows);
			const bytes = nonnegative(stats.bytes);
			if (context && !context.closed) {
				context.workerCount++;
				context.workerElapsedMs += elapsed;
				context.workerDurationMs += duration ?? 0;
				context.workerTimedCount += Number(duration !== null);
				context.workerRows =
					context.workerRows === null || rows === null ? null : context.workerRows + rows;
				context.workerBytes =
					context.workerBytes === null || bytes === null ? null : context.workerBytes + bytes;
				context.workerErrors += Number(stats.status === "error");
				context.workerCancelled += Number(stats.status === "cancelled");
			}
			if ((elapsed >= 50 || stats.status !== "ok") && this.allow(true)) {
				this.publish({
					kind: "sql-worker-completion",
					executionLocation: "read-worker",
					layer: "worker-task-wall-including-mapping-and-ack-wait",
					clock: "parent-elapsed; worker-local-duration",
					site: context?.site ?? "unknown",
					contextId: context?.contextId ?? null,
					requestId: context?.requestId ?? null,
					contextClosed: Number(context?.closed ?? false),
					task: workerTaskKinds.has(stats.task) ? stats.task : "unknown",
					elapsedMs: round(elapsed),
					workerDurationMs: duration === null ? null : round(duration),
					...(querySite
						? {
								querySite,
								queueWaitMs: nonnegative(stats.queueWaitMs),
								acquireMs: nonnegative(stats.acquireMs),
								workerActiveMs: nonnegative(stats.workerActiveMs),
								workerAckWaitMs: nonnegative(stats.workerAckWaitMs),
								consumeMs: nonnegative(stats.consumeMs),
								timing:
									"queue-capacity-only; acquire-includes-startup-excludes-queue; worker-duration-includes-ack; active-select-preparation-iteration-conversion-sizing-not-pure-sql; consume-parent-sync-mapping-overlaps-ack; not-additive",
							}
						: {}),
					rows,
					bytes,
					status: stats.status,
					counting: "task-not-sql-count; not-additive-with-business",
				});
			}
		};
	}

	execute<T>(
		operation: string,
		method: string,
		run: () => T,
		executionContext: "transaction" | "independent" | "unknown" = "unknown",
	): T {
		const context = this.storage.getStore();
		const start = this.now();
		let failed = false;
		try {
			return run();
		} catch (error) {
			failed = true;
			throw error;
		} finally {
			const end = this.now();
			const duration = end - start;
			if (context && !context.closed) {
				context.count++;
				context.totalMs += duration;
				context.maxMs = Math.max(context.maxMs, duration);
				context.errors += Number(failed);
			}
			if (duration >= 50 && this.allow(true)) {
				this.publish({
					kind: "sql-execution-slow",
					site: context?.site === "request" ? "unknown" : (context?.site ?? "unknown"),
					contextId: context?.contextId ?? null,
					requestId: context?.requestId ?? null,
					contextClosed: Number(context?.closed ?? false),
					operation,
					method,
					executionContext,
					startMs: round(start),
					endMs: round(end),
					durationMs: round(duration),
					failed: Number(failed),
				});
			}
		}
	}
}
export const sqlExecutionDiagnostics = new SqlExecutionDiagnostics((record) =>
	requestDiagnosticWriter.write(`${JSON.stringify(record)}\n`),
);
export function beginReadWorkerDiagnostic(
	site?: string,
): (stats: ReadWorkerDiagnosticStats) => void {
	return sqlExecutionDiagnostics.beginReadWorkerDiagnostic(site);
}
export function withSqlDiagnosticSite<T>(site: SqlDiagnosticSite, run: () => T): T {
	return sqlExecutionDiagnostics.scope(site, run);
}
