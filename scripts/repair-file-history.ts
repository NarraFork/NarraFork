import { Database } from "bun:sqlite";
import { isInstanceProcessIdentity } from "../server/lib/instance-process-identity";
import {
	FILE_HISTORY_REPAIR_HELP,
	FileHistoryRepairSafetyError,
	parseFileHistoryRepairArguments,
	prepareFileHistoryRepair,
	type RepairArguments,
	type RepairCommitState,
	type RepairSafetyContext,
	readRepairProcessIdentity,
} from "./lib/file-history-repair";
import {
	applyFileHistoryRepair,
	FileHistoryRepairDataError,
	preflightFileHistoryRepair,
	verifyFileHistoryRepair,
} from "./lib/file-history-repair-data";

const OUTPUT_LIMIT = 64 * 1024;
const INTERNAL_WORKER = "--internal-file-history-worker";

/** Reports accept only bounded numeric aggregates, never rows, state JSON, source IDs or errors. */
function numericSummary(value: unknown, depth = 0): Record<string, unknown> {
	if (!value || typeof value !== "object" || depth > 2) return {};
	const result: Record<string, unknown> = {};
	for (const [name, item] of Object.entries(value).slice(0, 32)) {
		if (!/^[a-zA-Z][a-zA-Z0-9_]{0,50}$/.test(name)) continue;
		if (typeof item === "number" && Number.isSafeInteger(item)) result[name] = item;
		else if (typeof item === "boolean") result[name] = item;
		else if (item && typeof item === "object" && !Array.isArray(item)) {
			const nested = numericSummary(item, depth + 1);
			if (Object.keys(nested).length) result[name] = nested;
		}
	}
	return result;
}
function codeOf(error: unknown): string {
	if (error instanceof FileHistoryRepairSafetyError || error instanceof FileHistoryRepairDataError)
		return /^[a-zA-Z0-9_]{1,80}$/.test(error.code) ? error.code : "maintenance_failed";
	return "maintenance_io_or_sqlite_failed";
}

export interface RepairWorkerDependencies {
	prepare?: typeof prepareFileHistoryRepair;
	openDatabase?: (path: string, readonly: boolean) => Database;
	preflight?: typeof preflightFileHistoryRepair;
	apply?: typeof applyFileHistoryRepair;
	verify?: typeof verifyFileHistoryRepair;
}

/** This synchronous worker is supervised by a separate asynchronous process. */
export function runFileHistoryRepairWorker(
	args: RepairArguments,
	parentRaw: string,
	dependencies: RepairWorkerDependencies = {},
): number {
	let context: RepairSafetyContext | undefined;
	let db: Database | undefined;
	let commitState: RepairCommitState = "not_committed";
	let exitCode = 1;
	let succeeded = false;
	let failure = "maintenance_failed";
	let summary: Record<string, unknown> = {};
	try {
		const parent = JSON.parse(parentRaw);
		if (!isInstanceProcessIdentity(parent) || parent.pid !== process.ppid)
			throw new FileHistoryRepairSafetyError("invalid_supervisor_identity");
		context = (dependencies.prepare ?? prepareFileHistoryRepair)(args, { parentIdentity: parent });
		console.log(`阶段: offline_preflight；报告: ${context.reportPath}`);
		context.guard("before_database_open", true);
		db = dependencies.openDatabase
			? dependencies.openDatabase(args.database, args.mode !== "apply")
			: new Database(args.database, {
					create: false,
					strict: true,
					...(args.mode === "apply" ? { readwrite: true } : { readonly: true }),
				});
		context.guard("after_database_open", true);
		db.exec("PRAGMA busy_timeout = 100; PRAGMA foreign_keys = ON");
		const currentContext = context;
		let progressLines = 0;
		let lastProgress = 0;
		const options = {
			guard(phase: string) {
				currentContext.guard(phase);
			},
			beforeCommit() {
				// The data owner calls guard("before_commit") immediately before this hook.
				currentContext.writeReport({
					phase: "before_commit",
					status: "in_progress",
					commitState: "unknown",
				});
			},
			afterCommit() {
				commitState = "committed";
				// The data owner's after_commit guard has already repeated the full observation.
				currentContext.writeReport({ phase: "after_commit", status: "in_progress", commitState });
			},
			onProgress(progress: { phase: string; processedRows: number }) {
				if (progressLines >= 100 || Date.now() - lastProgress < 1000) return;
				lastProgress = Date.now();
				progressLines++;
				const phase = /^[a-zA-Z0-9_]{1,60}$/.test(progress.phase) ? progress.phase : "processing";
				console.log(`阶段: ${phase}；已处理行数: ${progress.processedRows}`);
			},
		};
		const identity = { namespaceKey: context.namespaceKey };
		let result: unknown;
		if (args.mode === "apply") {
			(dependencies.preflight ?? preflightFileHistoryRepair)(db, identity, options);
			result = (dependencies.apply ?? applyFileHistoryRepair)(db, identity, options);
			commitState = "committed";
			context.guard("before_verify", true);
			(dependencies.verify ?? verifyFileHistoryRepair)(db, identity, options);
		} else if (args.mode === "verify") {
			result = (dependencies.verify ?? verifyFileHistoryRepair)(db, identity, options);
		} else result = (dependencies.preflight ?? preflightFileHistoryRepair)(db, identity, options);
		context.guard("final_verification");
		summary = numericSummary(result);
		context.writeReport({ phase: "verified", status: "finalizing", commitState, summary });
		succeeded = true;
		exitCode = 0;
	} catch (error) {
		if (error instanceof FileHistoryRepairDataError && commitState !== "committed")
			commitState = error.commitState;
		failure = codeOf(error);
		try {
			context?.writeReport({
				phase: "failed",
				status: "failed",
				code: failure,
				commitState,
				startupAllowed: false,
			});
		} catch {
			failure = "maintenance_report_failed";
		}
	} finally {
		try {
			db?.close(false);
		} catch {
			succeeded = false;
			failure = "database_close_failed";
		}
		if (succeeded) {
			try {
				context?.guard("after_database_close", true);
			} catch (error) {
				succeeded = false;
				failure = codeOf(error);
			}
		}
		try {
			context?.close({
				phase: succeeded ? "complete" : "failed",
				status: succeeded ? "succeeded" : "failed",
				commitState,
				startupAllowed: succeeded && args.mode !== "check",
				...(succeeded ? { summary } : { code: failure }),
			});
		} catch {
			succeeded = false;
			failure = "maintenance_lock_release_failed";
		}
	}
	if (!succeeded) {
		console.error(
			`维护失败: ${failure}；提交状态: ${commitState}。禁止启动，需检查；报告目录: ${args.dataDir}/file-history-maintenance`,
		);
		return exitCode || 1;
	}
	console.log(`维护完成: ${args.mode}；提交状态: ${commitState}；报告: ${context?.reportPath}`);
	return 0;
}

/** Signals are sent ONLY to this invocation's own worker; never to a service or lock holder. */
export async function runFileHistoryRepairCli(args: readonly string[]): Promise<number> {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		console.log(FILE_HISTORY_REPAIR_HELP);
		return 0;
	}
	let parsed: RepairArguments;
	try {
		parsed = parseFileHistoryRepairArguments(args);
	} catch (error) {
		console.error(`参数拒绝: ${codeOf(error)}。使用 --help 查看用法。`);
		return 2;
	}
	let supervisor: string;
	try {
		supervisor = JSON.stringify(readRepairProcessIdentity());
	} catch {
		console.error("维护拒绝: process_identity_unknown");
		return 1;
	}
	const child = Bun.spawn(
		[process.execPath, import.meta.filename, ...args, INTERNAL_WORKER, supervisor],
		{
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	let interrupted = false;
	let terminated = false;
	const terminateWorker = () => {
		interrupted = true;
		if (terminated) return;
		terminated = true;
		try {
			child.kill("SIGTERM");
		} catch {
			// An already-exited owned worker needs no further termination.
		}
	};
	process.on("SIGINT", terminateWorker);
	process.on("SIGTERM", terminateWorker);
	const timer = setTimeout(terminateWorker, parsed.timeoutMs + 1000);
	let outputBytes = 0;
	async function forward(stream: ReadableStream<Uint8Array>, stderr: boolean): Promise<void> {
		const reader = stream.getReader();
		try {
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				outputBytes += next.value.byteLength;
				if (outputBytes > OUTPUT_LIMIT) {
					terminateWorker();
					continue;
				}
				if (stderr) process.stderr.write(next.value);
				else process.stdout.write(next.value);
			}
		} finally {
			reader.releaseLock();
		}
	}
	try {
		const [, , status] = await Promise.all([
			forward(child.stdout, false),
			forward(child.stderr, true),
			child.exited,
		]);
		if (interrupted || child.signalCode) {
			console.error(
				`维护中断；提交状态未确认。禁止启动，需检查摘要报告并单独运行 --verify。报告目录: ${parsed.dataDir}/file-history-maintenance`,
			);
			return 1;
		}
		return status === 0 ? 0 : 1;
	} finally {
		clearTimeout(timer);
		process.off("SIGINT", terminateWorker);
		process.off("SIGTERM", terminateWorker);
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const workerIndex = args.indexOf(INTERNAL_WORKER);
	if (workerIndex >= 0) {
		try {
			if (workerIndex !== args.length - 2) throw new Error("worker argument placement");
			process.exitCode = runFileHistoryRepairWorker(
				parseFileHistoryRepairArguments(args.slice(0, workerIndex)),
				args[workerIndex + 1] ?? "",
			);
		} catch {
			console.error("维护拒绝: invalid_worker_arguments");
			process.exitCode = 2;
		}
	} else process.exitCode = await runFileHistoryRepairCli(args);
}
