import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Worker } from "node:worker_threads";
import { createServerRequestLifecycle } from "../../http-request-lifecycle";
import {
	drainCommunicationWork,
	trackCommunicationWork,
} from "../../services/agent-runtime/async-work";
import { BackgroundBashLifecycle } from "../../services/background-bash-lifecycle";
import {
	drainBufferedFilePreparations,
	getBufferedFilePreparationStatus,
	hasPendingBufferedFilePreparations,
	persistBufferedTextFiles,
	stopBufferedFilePreparations,
} from "../../services/narrator-buffer";
import {
	drainNarratorSessionTails,
	getNarratorSessionTailStatus,
} from "../../services/narrator-session";
import { TOKEN_RECALCULATION_BATCH_TIMEOUT_MS } from "../../services/token-recalculation";
import {
	drainContextCharacterRefreshes,
	getContextCharacterRefreshStatus,
	queueContextCharacterRefresh,
	quiesceContextCharacterRefreshes,
} from "../context-characters";
import { createDatabaseReaderStartup } from "../db-reader-startup";
import {
	getDbWorkerPoolStats,
	resetDbWorkerPoolForTest,
	resumeDbWorkerPool,
	runReadTask,
	runShortReadTask,
	shutdownDbWorkerPool,
} from "../db-worker/pool";
import type { SelectRowsParams } from "../db-worker/protocol";
import { generateId } from "../id";
import { logger } from "../logger";
import { ShutdownActivityTracker } from "../shutdown-activity";
import { WorkerHandle } from "../worker-runtime/lifecycle";

const source = readFileSync(new URL("../../main.ts", import.meta.url), "utf8");

// Each sandbox is a separate process lifetime; reset only after real native exit completes.
afterEach(async () => {
	await resetDbWorkerPoolForTest();
});

/** Execute the actual shutdown body without booting a server or touching process lifecycle. */
function sandbox(options: {
	trace: string[];
	onPluginShutdown(): Promise<void>;
	onBufferedDrain(): void;
	communicationStatus(): { pending: number; failed: boolean };
	now?: () => number;
	onHttpDrain?: () => void;
	replay?: Promise<unknown>;
	onReplayStop?: () => void;
	onLiveClose?: () => Promise<void>;
	stageTimeoutMs?: number;
	scheduleTimeout?: (callback: () => void, delay: number) => () => void;
	bufferedLifecycle?: {
		stop: typeof stopBufferedFilePreparations;
		drain: typeof drainBufferedFilePreparations;
		hasPending: typeof hasPendingBufferedFilePreparations;
		status: typeof getBufferedFilePreparationStatus;
	};
	bash?: {
		stop(options: { preserveProcesses?: boolean }): void;
		drain(options: { deadlineAt: number }): Promise<void>;
		snapshot(): { stopped: boolean; pending: number; failed: number };
		kill?(): Promise<void>;
	};
	notification?: {
		stop(options: { deadlineAt: number }): Promise<void>;
		drain(options: { deadlineAt: number }): Promise<void>;
		snapshot(): { stopped: boolean; pending: number; failed: number };
	};
	storageHistory?: {
		stop(options: { deadlineAt: number }): Promise<void>;
		snapshot(): { stopped: boolean; pending: number; failed: boolean };
	};
	teamMaintenance?: {
		stop(): Promise<void>;
		snapshot(): { stopped: boolean; pending: number; failed: boolean };
	};
	databaseStartup?: {
		stop(): void;
		drain(): Promise<void>;
		readonly pending: boolean;
	};
}) {
	let tracker: ShutdownActivityTracker | undefined;
	let cleanMarkers = 0;
	class CapturedTracker extends ShutdownActivityTracker {
		constructor() {
			super();
			tracker = this;
		}
	}
	const nothing = () => {};
	const settled = async () => {};
	const trace = options.trace;
	const bufferedLifecycle = options.bufferedLifecycle ?? {
		stop: stopBufferedFilePreparations,
		drain: drainBufferedFilePreparations,
		hasPending: hasPendingBufferedFilePreparations,
		status: getBufferedFilePreparationStatus,
	};
	const dependencies = {
		logger: { info: nothing, warn: nothing },
		activeDatabaseBackend: "sqlite",
		process: { pid: 4242 },
		performance: options.now ? { now: options.now } : performance,
		setTimeout:
			options.scheduleTimeout ??
			((callback: () => void, delay: number) => {
				const timer = setTimeout(callback, Math.min(delay, options.stageTimeoutMs ?? delay));
				return () => clearTimeout(timer);
			}),
		clearTimeout: (cancel?: () => void) => cancel?.(),
		outlineLiveDatabaseWork: new Set<Promise<unknown>>(),
		trackCommunicationWork,
		stopOutlineLiveReplay: () => {
			trace.push("outline.replay.stop");
			options.onReplayStop?.();
		},
		Bun: {},
		ShutdownActivityTracker: CapturedTracker,
		TOKEN_RECALCULATION_BATCH_TIMEOUT_MS,
		markUpdateRestarting: nothing,
		stopSessionCleanupTimer: settled,
		gateway: { shutdown: settled },
		stopPrefixSnapshotMaintenance: settled,
		stopInboxWakes: () => {
			trace.push("inbox.stop");
		},
		stopProjectIndexRebuild: settled,
		stopBlockBackgroundJobs: settled,
		stopStorageHistoryRetention: (input: { deadlineAt: number }) => {
			trace.push("history.stop");
			return options.storageHistory?.stop(input) ?? Promise.resolve();
		},
		getStorageHistoryShutdownSnapshot: () =>
			options.storageHistory?.snapshot() ?? { stopped: true, pending: 0, failed: false },
		stopTeamDatabaseMaintenance: () => {
			trace.push("team.stop");
			return options.teamMaintenance?.stop() ?? Promise.resolve();
		},
		getTeamDatabaseMaintenanceStatus: () =>
			options.teamMaintenance?.snapshot() ?? { stopped: true, pending: 0, failed: false },
		backgroundOccupancyInitializer: { stop: nothing },
		databaseStartup: options.databaseStartup ?? {
			stop: () => trace.push("databaseStartup.stop"),
			drain: settled,
			pending: false,
		},
		stopBackgroundOccupancy: async () => {
			trace.push("occupancy.stop");
		},
		stopHeartbeat: nothing,
		quiesceNarratorWsReadTasks: () => {
			trace.push("ws.quiesce");
		},
		httpRequestContext: { getStore: () => undefined },
		httpLifecycle: createServerRequestLifecycle(),
		cpuProfiler: { shutdown: settled },
		stopRemoteAccess: settled,
		closeAllConnections: () => {
			trace.push("ws.close");
		},
		stopHttpListener: nothing,
		waitForHttpRequestDrain: async () => {
			options.onHttpDrain?.();
			trace.push("http.drained");
		},
		waitForWebSocketActivityDrain: settled,
		prepareSignalRestartRecovery: settled,
		getCodexManager: () => ({ stopUsageRefreshScheduler: nothing }),
		stopScheduledTaskScheduler: async () => {
			trace.push("scheduled.stop");
		},
		stopNotificationFanout: async () => {
			trace.push("fanout.stop");
		},
		stopNotificationCenterMaintenance: async () => {
			trace.push("notificationMaintenance.stop");
		},
		stopNotificationBackgroundWork: (input: { deadlineAt: number }) => {
			trace.push("notificationBackground.stop");
			return options.notification?.stop(input) ?? Promise.resolve();
		},
		drainNotificationBackgroundWork: (input: { deadlineAt: number }) =>
			options.notification?.drain(input) ?? Promise.resolve(),
		getNotificationBackgroundWorkSnapshot: () =>
			options.notification?.snapshot() ?? { stopped: true, pending: 0, failed: 0 },
		terminalService: { shutdownAll: settled },
		backgroundTaskService: {
			stopBashCollectors: (input: { preserveProcesses?: boolean }) => {
				trace.push("bash.stop");
				options.bash?.stop(input);
			},
			drainBashCollectors: (input: { deadlineAt: number }) =>
				options.bash?.drain(input) ?? Promise.resolve(),
			getBashShutdownSnapshot: () =>
				options.bash?.snapshot() ?? { stopped: true, pending: 0, failed: 0 },
		},
		killAllBashProcesses: () => options.bash?.kill?.() ?? Promise.resolve(),
		cancelBackgroundIntegrityCheck: async () => {
			trace.push("integrity.stop");
		},
		stopResourceProtectionIndex: async () => {
			trace.push("maintenance.stop");
		},
		getResourceProtectionShutdownSnapshot: () => ({
			stopped: true,
			pendingTasks: 0,
			pendingReceiptImports: 0,
			maintenanceScheduled: false,
		}),
		getIntegrityCheckShutdownSnapshot: () => ({
			stopped: true,
			pendingTasks: 0,
			pendingProcesses: 0,
			scheduled: false,
		}),
		stopNarratorRunAdmission: nothing,
		stopCheckpointedNarratorRuns: nothing,
		drainNarratorRunCompletions: settled,
		getNarratorRunShutdownSnapshot: () => ({ stopped: true, pending: 0, failed: 0 }),
		stopVNetUdpRendezvous: settled,
		pluginManager: { shutdown: options.onPluginShutdown },
		unregisterExternalProviderResolver: nothing,
		mcpManager: { shutdown: settled },
		preservesRecoveryOnShutdown: () => false,
		outlineLiveReplay:
			options.replay ??
			Promise.resolve().then(() => {
				trace.push("outline.replay.done");
			}),
		importModule: async () => ({
			closeGitStatusPages: async () => {
				trace.push("gitStatusPages.close");
			},
			persistBrowserSessionsForUpdate: settled,
			closeBrowser: settled,
			clearCodexResponsesWebSocketSessions: settled,
			closeEditTextWorkers: settled,
			closeEditorDocumentService: settled,
			closeFileChangePhysicalAudits: settled,
			closeFsScanWorkers: settled,
			closeGenUiCompilerWorkers: settled,
			closeGitCurrentBaselineWorkers: settled,
			closeGitLineStatsWorkers: settled,
			closeImageGenerationResponseWorkers: settled,
			closeLocalGlobWorkers: settled,
			closeMemoryDiagnosticWorkers: settled,
			closeModelHistoryWorkers: settled,
			closeProgrammaticServices: settled,
			closeRequestJsonWorkers: settled,
			closeRequestRecorderWorkers: settled,
			closeRevertManifestWorkers: settled,
			closeRevertBodyWorkers: settled,
			closeRevertRewriteWorkers: settled,
			closeSharePreviewHtmlWorkers: settled,
			closeSnapshotBuilds: settled,
			closeTokenRecalculationWorkers: settled,
			closeToolInputHistoricalWorkers: settled,
			stopPluginPlatformProducers: settled,
			stopOutlineTaskLeaseJob: settled,
			stopOutlineInProcessRebuild: settled,
			stopOutlineDigestJob: settled,
			stopSpecImportJob: settled,
			stopSpecLossScanJob: settled,
			persistAllLiveSessions: async () => {
				trace.push("outline.persist");
			},
			closeAllLiveSessions: async () => {
				trace.push("outline.close");
				await options.onLiveClose?.();
			},
		}),
		killOwnWindowsChildProcesses: nothing,
		stopRuntimePublications: nothing,
		stopBufferedFilePreparations: bufferedLifecycle.stop,
		drainNarratorSessionTails,
		getNarratorSessionTailStatus,
		quiesceContextCharacterRefreshes,
		drainContextCharacterRefreshes: async (input: { deadlineAt: number }) => {
			if (trace.includes("context.queued") && getContextCharacterRefreshStatus().pending) {
				trace.push("context.drain");
			}
			await drainContextCharacterRefreshes(input);
		},
		getContextCharacterRefreshStatus,
		drainNarratorWsReadTasks: settled,
		hasPendingNarratorWsReadTasks: () => false,
		drainBufferedFilePreparations: async (input: { deadlineAt: number }) => {
			if (bufferedLifecycle.hasPending()) options.onBufferedDrain();
			await bufferedLifecycle.drain(input);
		},
		hasPendingBufferedFilePreparations: bufferedLifecycle.hasPending,
		getBufferedFilePreparationStatus: bufferedLifecycle.status,
		drainCommunicationWork,
		getCommunicationWorkStatus: options.communicationStatus,
		shutdownDbWorkerPool: async () => {
			trace.push("reader.close.begin");
			await shutdownDbWorkerPool({ permanent: true });
			trace.push("reader.closed");
		},
		closePrefixSnapshotStore: async () => {
			trace.push("prefixSnapshots.close");
		},
		closePostgresRuntime: async () => {
			trace.push("postgres.close");
		},
		markDatabaseCleanShutdown: () => {
			cleanMarkers += 1;
			trace.push("clean");
			return true;
		},
		releaseDatabaseInstanceLockOnly: () => {
			trace.push("dirty");
		},
	};
	const start = source.indexOf("function trackOutlineLiveDatabaseWork");
	const end = source.indexOf("\nregisterGracefulShutdownHandler(", start);
	if (start < 0 || end < start) throw new Error("Cannot locate production shutdown body");
	const body = source.slice(start, end).replace(/\bimport\s*\(/g, "importModule(");
	const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(`
		const shutdownState = { promise: null, killWindowsProcessTreeOnExit: true };
		${body}
	`);
	if (/\bimport\s*\(/.test(compiled)) throw new Error("Shutdown sandbox contains a native import");
	const run = new Function(
		...Object.keys(dependencies),
		`${compiled}\ntrackOutlineLiveDatabaseWork(outlineLiveReplay);\nreturn performGracefulShutdown;`,
	)(...Object.values(dependencies)) as (input: {
		reason: string;
		skipWindowsProcessTreeKill: boolean;
		skipBashProcessKill?: boolean;
	}) => Promise<{ success: boolean }>;
	return {
		run,
		get tracker() {
			return tracker;
		},
		get cleanMarkers() {
			return cleanMarkers;
		},
		get pendingOutlineWork() {
			return [...dependencies.outlineLiveDatabaseWork];
		},
	};
}

test("a pending recovered startup backfill retains database ownership after the shutdown budget", async () => {
	const trace: string[] = [];
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let attempts = 0;
	let now = 0;
	const startup = createDatabaseReaderStartup({
		readiness: {
			state: { status: "waiting" },
			wait: async () =>
				++attempts === 1 ? { ok: false, code: "DB_READERS_UNAVAILABLE" } : { ok: true },
		},
		initialize: async () => {
			entered.resolve();
			await release.promise;
			trace.push("startup.backfill.write");
		},
		onUnavailable() {},
		onError(error) {
			throw error;
		},
		retryIntervalMs: 1,
	});
	await startup.start();
	await entered.promise;
	const runtime = sandbox({
		trace,
		databaseStartup: startup,
		bufferedLifecycle: {
			stop() {},
			drain: async () => {},
			hasPending: () => false,
			status: () => ({ pending: 0, active: 0, waiting: 0, batches: 0, failed: 0 }),
		},
		now: () => now,
		onHttpDrain: () => {
			now = 30_000;
		},
		onPluginShutdown: async () => {},
		onBufferedDrain() {},
		communicationStatus: () => ({ pending: 0, failed: false }),
	});
	try {
		const result = await runtime.run({
			reason: "fixture-startup-deadline",
			skipWindowsProcessTreeKill: true,
		});
		for (const released of [
			"reader.close.begin",
			"prefixSnapshots.close",
			"postgres.close",
			"clean",
			"dirty",
		])
			expect(trace).not.toContain(released);
		expect(result.success).toBe(false);
		expect(trace).not.toContain("startup.backfill.write");
	} finally {
		startup.stop();
		release.resolve();
	}
});

test("shutdown deadline before native reader exit forbids clean marking and pool reuse", async () => {
	const previous = {
		disabled: process.env.NARRAFORK_DB_WORKER,
		concurrency: process.env.NARRAFORK_DB_WORKER_CONCURRENCY,
		diagnostics: process.env.NF_DB_WORKER_SQL_DIAGNOSTICS,
	};
	delete process.env.NARRAFORK_DB_WORKER;
	process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
	process.env.NF_DB_WORKER_SQL_DIAGNOSTICS = "1";
	const directory = mkdtempSync(join(tmpdir(), "nf-shutdown-reader-deadline-"));
	const path = join(directory, "reader.db");
	const sqlite = new Database(path);
	sqlite.run("CREATE TABLE fixture (value INTEGER)");
	sqlite.close();
	const task: SelectRowsParams = { kind: "selectRows", sql: "SELECT 1", params: [], maxRows: 1 };
	const handles: WorkerHandle<Worker>[] = [];
	const create = WorkerHandle.thread;
	const spawns = spyOn(WorkerHandle, "thread").mockImplementation((entry, options) => {
		const handle = create(entry, options);
		handles.push(handle);
		return handle;
	});
	const logs = spyOn(logger, "warn").mockImplementation(() => {});
	const sqlLogs = () =>
		logs.mock.calls
			.filter(([message]) => message === "Database read worker SQL diagnostic")
			.map(([, fields]) => fields);
	const release = Promise.withResolvers<void>();
	const stopping = Promise.withResolvers<void>();
	let terminateSpy: ReturnType<typeof spyOn<Worker, "terminate">> | undefined;
	let operation: Promise<{ success: boolean }> | undefined;
	let closing: Promise<void> | undefined;
	try {
		await runReadTask(path, task, { diagnosticSource: "auth.session" });
		expect(handles).toHaveLength(1);
		const handle = handles[0];
		if (!handle) throw new Error("Expected owned reader");
		let exitConfirmed = false;
		void handle.exited.then(() => {
			exitConfirmed = true;
		});
		const terminate = handle.resource.terminate.bind(handle.resource);
		terminateSpy = spyOn(handle.resource, "terminate").mockImplementation(async () => {
			stopping.resolve();
			await release.promise;
			return terminate();
		});
		let now = 0;
		const timers = new Map<() => void, { callback: () => void; delay: number }>();
		const trace: string[] = [];
		const runtime = sandbox({
			trace,
			now: () => now,
			bufferedLifecycle: {
				stop: () => {},
				drain: async () => {},
				hasPending: () => false,
				status: () => ({ pending: 0, active: 0, waiting: 0, batches: 0, failed: 0 }),
			},
			scheduleTimeout(callback, delay) {
				const cancel = () => {
					timers.delete(cancel);
				};
				timers.set(cancel, { callback, delay });
				return cancel;
			},
			onPluginShutdown: async () => {},
			onBufferedDrain() {},
			communicationStatus: () => ({ pending: 0, failed: false }),
		});
		operation = runtime.run({
			reason: "fixture-reader-deadline",
			skipWindowsProcessTreeKill: true,
		});
		await stopping.promise;
		let closed = false;
		closing = shutdownDbWorkerPool({ permanent: true }).then(() => {
			closed = true;
		});
		const start = sqlLogs().find((record) => record?.phase === "close-start");
		expect(start).toMatchObject({ source: "auth.session", requestId: expect.any(String) });
		expect(timers.size).toBe(1);
		const deadline = [...timers.values()][0];
		if (!deadline) throw new Error("Expected shutdown watchdog");
		expect(deadline.delay).toBe(50_000);
		now = deadline.delay;
		deadline.callback();
		await operation;
		expect(runtime.tracker?.summary()).toMatchObject({ clean: false, drainComplete: true });
		expect(runtime.tracker?.summary().degradedSteps).toContainEqual({
			label: "dbWorkerPool.shutdown",
			outcome: "timeout",
		});
		expect(runtime.cleanMarkers).toBe(0);
		expect(trace).not.toContain("clean");
		expect(closed).toBe(false);
		expect(exitConfirmed).toBe(false);
		expect(sqlLogs().some((record) => record?.phase === "close-complete")).toBe(false);
		expect(getDbWorkerPoolStats().workers).toBe(1);
		for (const read of [runReadTask, runShortReadTask]) {
			const result = await read(path, task).catch((error: unknown) => error);
			expect(result).toMatchObject({ reason: "pool_shutdown" });
		}
		expect(handles).toHaveLength(1);
		release.resolve();
		await closing;
		expect(typeof (await handle.exited)).toBe("number");
		expect(exitConfirmed).toBe(true);
		expect(sqlLogs().find((record) => record?.phase === "close-complete")).toMatchObject({
			requestId: start?.requestId,
			source: "auth.session",
			closeDurationMs: expect.any(Number),
		});
		expect(getDbWorkerPoolStats().workers).toBe(0);
		expect(timers.size).toBe(0);
		expect(runtime.cleanMarkers).toBe(0);
	} finally {
		release.resolve();
		await operation;
		await closing;
		await shutdownDbWorkerPool();
		terminateSpy?.mockRestore();
		spawns.mockRestore();
		logs.mockRestore();
		for (const [key, value] of Object.entries({
			NARRAFORK_DB_WORKER: previous.disabled,
			NARRAFORK_DB_WORKER_CONCURRENCY: previous.concurrency,
			NF_DB_WORKER_SQL_DIAGNOSTICS: previous.diagnostics,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(directory, { recursive: true, force: true });
	}
});

test("team maintenance pending after its budget retains readers and database ownership", async () => {
	const trace: string[] = [];
	const release = Promise.withResolvers<void>();
	let pending = 1;
	const runtime = sandbox({
		trace,
		stageTimeoutMs: 1,
		onPluginShutdown: async () => {},
		onBufferedDrain: () => {},
		communicationStatus: () => ({ pending: 0, failed: false }),
		bufferedLifecycle: {
			stop: () => {},
			drain: async () => {},
			hasPending: () => false,
			status: () => ({ pending: 0, active: 0, waiting: 0, batches: 0, failed: 0 }),
		},
		teamMaintenance: {
			stop: () =>
				release.promise.then(() => {
					pending = 0;
				}),
			snapshot: () => ({ stopped: true, pending, failed: false }),
		},
	});
	try {
		expect(
			await runtime.run({ reason: "fixture", skipWindowsProcessTreeKill: true }),
		).toMatchObject({ success: false });
		expect(trace.indexOf("team.stop")).toBeLessThan(trace.indexOf("http.drained"));
		expect(trace).not.toContain("reader.close.begin");
		expect(trace).not.toContain("dirty");
		expect(trace).not.toContain("clean");
	} finally {
		release.resolve();
		await release.promise;
	}
});

test("team maintenance failure cannot produce a clean marker after its work drained", async () => {
	const trace: string[] = [];
	const runtime = sandbox({
		trace,
		onPluginShutdown: async () => {},
		onBufferedDrain: () => {},
		communicationStatus: () => ({ pending: 0, failed: false }),
		bufferedLifecycle: {
			stop: () => {},
			drain: async () => {},
			hasPending: () => false,
			status: () => ({ pending: 0, active: 0, waiting: 0, batches: 0, failed: 0 }),
		},
		teamMaintenance: {
			stop: async () => {
				throw new Error("team drain failed");
			},
			snapshot: () => ({ stopped: true, pending: 0, failed: true }),
		},
	});
	expect(await runtime.run({ reason: "fixture", skipWindowsProcessTreeKill: true })).toMatchObject({
		success: false,
	});
	expect(trace).not.toContain("clean");
	expect(runtime.cleanMarkers).toBe(0);
});

test("late teardown buffered writes and communication reads finish before reader closure", async () => {
	const previousOff = process.env.NARRAFORK_DB_WORKER;
	const previousConcurrency = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	const directory = mkdtempSync(join(tmpdir(), "nf-shutdown-late-reader-"));
	const path = join(directory, "reader.db");
	const sqlite = new Database(path);
	sqlite.run("CREATE TABLE shutdown_fixture (id INTEGER PRIMARY KEY)");
	sqlite.close();
	delete process.env.NARRAFORK_DB_WORKER;
	process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
	const writeEntered = Promise.withResolvers<void>();
	const releaseWrite = Promise.withResolvers<void>();
	const releaseRead = Promise.withResolvers<void>();
	const bufferedDrainEntered = Promise.withResolvers<void>();
	const trace: string[] = [];
	const id = generateId();
	let pendingC = 0;
	let failedC = false;
	let buffered: ReturnType<typeof persistBufferedTextFiles> | undefined;
	let communication: Promise<void> | undefined;
	let operation: Promise<{ success: boolean }> | undefined;
	const originalWrite = Bun.write.bind(Bun) as (...args: unknown[]) => Promise<number>;
	const write = spyOn(Bun, "write").mockImplementation((...args) => {
		if (typeof args[0] === "string" && basename(args[0]) === "lifecycle-reader.txt") {
			writeEntered.resolve();
			return releaseWrite.promise.then(() => originalWrite(...args));
		}
		return originalWrite(...args);
	});
	try {
		await runReadTask(
			path,
			{ kind: "selectRows", sql: "SELECT 1", params: [], maxRows: 1 },
			{ timeoutMs: 30_000 },
		);
		// Accepted before shutdown; its real file IO finishes during the finalizer drain.
		buffered = persistBufferedTextFiles(id, [
			new File(["late file"], "lifecycle-reader.txt", { type: "text/plain" }),
			new File(["second late file"], "lifecycle-reader-second.txt", { type: "text/plain" }),
		]);
		void buffered.then(
			() => {
				trace.push("buffer.write.done");
			},
			() => {},
		);
		const runtime = sandbox({
			trace,
			onBufferedDrain: () => bufferedDrainEntered.resolve(),
			communicationStatus: () => ({ pending: pendingC, failed: failedC }),
			onPluginShutdown: async () => {
				trace.push("plugin.shutdown");

				pendingC += 1;
				communication = trackCommunicationWork(
					(async () => {
						await releaseRead.promise;
						await runReadTask(
							path,
							{ kind: "selectRows", sql: "SELECT 1", params: [], maxRows: 1 },
							{ timeoutMs: 30_000 },
						);
						trace.push("communication.read.done");
						expect(getContextCharacterRefreshStatus().quiescing).toBe(true);
						queueContextCharacterRefresh(id);
						expect(getContextCharacterRefreshStatus().pending).toBeGreaterThan(0);
						expect(getContextCharacterRefreshStatus().scheduled).toBe(false);
						trace.push("context.queued");
					})(),
				);
				void communication.then(
					() => {
						pendingC -= 1;
					},
					() => {
						pendingC -= 1;
						failedC = true;
					},
				);
				await writeEntered.promise;
			},
		});
		operation = runtime.run({ reason: "fixture", skipWindowsProcessTreeKill: true });
		expect(
			await Promise.race([
				bufferedDrainEntered.promise.then(() => "buffered"),
				operation.then(() => "shutdown"),
			]),
		).toBe("buffered");
		expect(trace).toContain("plugin.shutdown");
		expect(trace).not.toContain("reader.close.begin");
		releaseWrite.resolve();
		const savedFiles = await buffered;
		expect(savedFiles?.length).toBe(2);
		if (!savedFiles) throw new Error("Expected both persisted files");
		expect(savedFiles.map((file) => basename(dirname(file.path)))).toEqual([id, id]);
		expect(await Promise.all(savedFiles.map((file) => Bun.file(file.path).text()))).toEqual([
			"late file",
			"second late file",
		]);
		expect(savedFiles && basename(dirname(savedFiles[0].path))).toBe(id);
		expect(trace).not.toContain("reader.close.begin");
		releaseRead.resolve();
		expect((await operation).success).toBe(true);
		expect(runtime.tracker?.summary().clean).toBe(true);
		expect(runtime.cleanMarkers).toBe(1);
		const closed = trace.indexOf("reader.close.begin");
		expect(trace.indexOf("context.queued")).toBeGreaterThanOrEqual(0);
		expect(trace.indexOf("context.drain")).toBeGreaterThan(trace.indexOf("context.queued"));
		expect(trace.indexOf("context.drain")).toBeLessThan(closed);
		expect(getContextCharacterRefreshStatus()).toEqual({
			pending: 0,
			running: false,
			scheduled: false,
			failed: false,
			quiescing: true,
		});
		expect(getBufferedFilePreparationStatus()).toEqual({
			pending: 0,
			active: 0,
			waiting: 0,
			batches: 0,
			failed: 0,
		});
		expect(trace.indexOf("buffer.write.done")).toBeLessThan(closed);
		expect(trace.indexOf("inbox.stop")).toBeGreaterThanOrEqual(0);
		expect(trace.indexOf("inbox.stop")).toBeLessThan(trace.indexOf("communication.read.done"));
		expect(trace.indexOf("communication.read.done")).toBeLessThan(closed);
		expect(trace.indexOf("ws.quiesce")).toBeLessThan(trace.indexOf("ws.close"));
		expect(trace.indexOf("outline.persist")).toBeGreaterThanOrEqual(0);
		expect(trace.indexOf("outline.persist")).toBeLessThan(trace.indexOf("ws.close"));
		expect(trace.indexOf("outline.close")).toBeGreaterThan(trace.indexOf("http.drained"));
		expect(trace.indexOf("outline.replay.done")).toBeLessThan(trace.indexOf("outline.close"));
		expect(trace.indexOf("outline.close")).toBeLessThan(closed);
		expect(trace.indexOf("reader.closed")).toBeLessThan(trace.indexOf("prefixSnapshots.close"));
		expect(trace.indexOf("prefixSnapshots.close")).toBeLessThan(trace.indexOf("postgres.close"));
		expect(trace.indexOf("prefixSnapshots.close")).toBeLessThan(trace.indexOf("clean"));
	} finally {
		releaseWrite.resolve();
		releaseRead.resolve();
		await Promise.allSettled([operation, communication, buffered].filter(Boolean));
		write.mockRestore();
		try {
			await shutdownDbWorkerPool();
			resumeDbWorkerPool();
			const files = await buffered?.catch(() => []);
			if (files?.length) {
				const staging = dirname(files[0].path);
				if (basename(staging) === id) rmSync(staging, { recursive: true, force: true });
			}
			rmSync(directory, { recursive: true, force: true });
		} finally {
			if (previousOff === undefined) delete process.env.NARRAFORK_DB_WORKER;
			else process.env.NARRAFORK_DB_WORKER = previousOff;
			if (previousConcurrency === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
			else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = previousConcurrency;
		}
	}
}, 20_000);

for (const failBroadcast of [false, true]) {
	test(`Bash exit and detached list reads settle before reader closure, failure=${failBroadcast}`, async () => {
		const lifecycle = new BackgroundBashLifecycle();
		const exit = Promise.withResolvers<void>();
		const terminalEntered = Promise.withResolvers<void>();
		const terminalRead = Promise.withResolvers<void>();
		const broadcastEntered = Promise.withResolvers<void>();
		const broadcastRead = Promise.withResolvers<void>();
		const killed = Promise.withResolvers<void>();
		const trace: string[] = [];
		const collector = lifecycle.trackCollector(
			"bash-shutdown-fixture",
			(async () => {
				await exit.promise;
				terminalEntered.resolve();
				await terminalRead.promise;
				trace.push("bash.terminal.done");
				lifecycle.trackTerminal(
					(async () => {
						broadcastEntered.resolve();
						await broadcastRead.promise;
						expect(trace).not.toContain("reader.close.begin");
						trace.push("bash.list.read.done");
					})(),
				);
			})(),
		);
		const runtime = sandbox({
			trace,
			onPluginShutdown: async () => {},
			onBufferedDrain() {},
			communicationStatus: () => ({ pending: 0, failed: false }),
			bash: {
				stop: (input) => lifecycle.stop(input),
				drain: (input) => lifecycle.drain(input),
				snapshot: () => lifecycle.getSnapshot(),
				kill: async () => {
					trace.push("bash.kill.returned");
					killed.resolve();
				},
			},
		});
		const operation = runtime.run({ reason: "fixture-bash", skipWindowsProcessTreeKill: true });
		try {
			await killed.promise;
			expect(trace).not.toContain("reader.close.begin");
			exit.resolve();
			await terminalEntered.promise;
			expect(trace).not.toContain("reader.close.begin");
			terminalRead.resolve();
			await collector;
			await broadcastEntered.promise;
			expect(lifecycle.getSnapshot()).toMatchObject({ collectors: 0, pending: 1 });
			expect(trace).not.toContain("reader.close.begin");
			if (failBroadcast) broadcastRead.reject(new Error("late task-list read failed"));
			else broadcastRead.resolve();
			await operation;
			expect(runtime.cleanMarkers).toBe(failBroadcast ? 0 : 1);
			expect(runtime.tracker?.summary().clean).toBe(!failBroadcast);
			if (!failBroadcast) {
				expect(trace.indexOf("bash.list.read.done")).toBeLessThan(
					trace.indexOf("reader.close.begin"),
				);
			}
		} finally {
			exit.resolve();
			terminalRead.resolve();
			broadcastRead.resolve();
			await Promise.allSettled([collector, operation]);
			await shutdownDbWorkerPool();
			resumeDbWorkerPool();
		}
	});
}

for (const reason of ["replacement_started", "system_prepared_shutdown"]) {
	test(`${reason} preserves processes and freezes their late database tails`, async () => {
		const lifecycle = new BackgroundBashLifecycle();
		const exit = Promise.withResolvers<void>();
		const terminal = Promise.withResolvers<void>();
		const draining = Promise.withResolvers<void>();
		const trace: string[] = [];
		let lateWrites = 0;
		let kills = 0;
		const collector = lifecycle.trackCollector(
			"bash-preserved-fixture",
			exit.promise.then(() => {
				if (lifecycle.canStartTerminal("bash-preserved-fixture")) lateWrites++;
			}),
		);
		lifecycle.trackTerminal(terminal.promise);
		const runtime = sandbox({
			trace,
			onPluginShutdown: async () => {},
			onBufferedDrain() {},
			communicationStatus: () => ({ pending: 0, failed: false }),
			bash: {
				stop: (input) => lifecycle.stop(input),
				drain: (input) => {
					draining.resolve();
					return lifecycle.drain(input);
				},
				snapshot: () => lifecycle.getSnapshot(),
				kill: async () => {
					kills++;
				},
			},
		});
		const operation = runtime.run({
			reason,
			skipWindowsProcessTreeKill: true,
			skipBashProcessKill: true,
		});
		try {
			await draining.promise;
			expect(trace).not.toContain("reader.close.begin");
			terminal.resolve();
			await operation;
			expect(kills).toBe(0);
			expect(runtime.cleanMarkers).toBe(1);
			expect(lifecycle.getSnapshot()).toMatchObject({
				preserving: true,
				collectors: 1,
				pending: 0,
			});
			exit.resolve();
			await collector;
			expect(lateWrites).toBe(0);
		} finally {
			terminal.resolve();
			exit.resolve();
			await Promise.allSettled([collector, operation]);
			await shutdownDbWorkerPool();
			resumeDbWorkerPool();
		}
	});
}

test("exhausted Bash drain budget retains pending ownership and forbids the clean marker", async () => {
	let now = 0;
	const lifecycle = new BackgroundBashLifecycle();
	const late = Promise.withResolvers<void>();
	const collector = lifecycle.trackCollector("bash-over-budget", late.promise);
	const trace: string[] = [];
	const runtime = sandbox({
		trace,
		now: () => now,
		onHttpDrain: () => {
			now = 30_000;
		},
		onPluginShutdown: async () => {},
		onBufferedDrain() {},
		communicationStatus: () => ({ pending: 0, failed: false }),
		bash: {
			stop: (input) => lifecycle.stop(input),
			drain: (input) => lifecycle.drain(input),
			snapshot: () => lifecycle.getSnapshot(),
		},
	});
	try {
		await runtime.run({ reason: "fixture-bash-timeout", skipWindowsProcessTreeKill: true });
		expect(lifecycle.getSnapshot()).toMatchObject({ stopped: true, pending: 1 });
		expect(runtime.cleanMarkers).toBe(0);
		expect(runtime.tracker?.summary().degradedSteps).toContainEqual({
			label: "databaseWork.finalAudit",
			outcome: "failed",
		});
		late.reject(new Error("Bash settled after reader shutdown"));
		await collector.catch(() => {});
		expect(lifecycle.getSnapshot()).toMatchObject({ pending: 0, failed: 1 });
	} finally {
		late.resolve();
		await collector.catch(() => {});
		await shutdownDbWorkerPool();
		resumeDbWorkerPool();
	}
});

test("producer admission closes before request waits consume the entire business budget", async () => {
	let now = 0;
	const trace: string[] = [];
	const runtime = sandbox({
		trace,
		now: () => now,
		onHttpDrain: () => {
			now = 30_000;
		},
		onPluginShutdown: async () => {
			throw new Error("Expired business work must not start");
		},
		onBufferedDrain() {},
		communicationStatus: () => ({ pending: 0, failed: false }),
	});
	try {
		await runtime.run({ reason: "fixture-expired", skipWindowsProcessTreeKill: true });
		for (const owner of [
			"databaseStartup.stop",
			"bash.stop",
			"history.stop",
			"occupancy.stop",
			"scheduled.stop",
			"fanout.stop",
			"notificationMaintenance.stop",
			"notificationBackground.stop",
			"integrity.stop",
			"maintenance.stop",
		]) {
			expect(trace.indexOf(owner)).toBeGreaterThanOrEqual(0);
			expect(trace.indexOf(owner)).toBeLessThan(trace.indexOf("http.drained"));
		}
		expect(trace).toContain("reader.closed");
		expect(trace).toContain("dirty");
		expect(runtime.cleanMarkers).toBe(0);
	} finally {
		await shutdownDbWorkerPool();
		resumeDbWorkerPool();
	}
});

test("history cleanup freezes before request drain and settles before native reader closure", async () => {
	const trace: string[] = [];
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let stopped = false;
	let pending = 1;
	const completion = release.promise.then(() => {
		pending = 0;
		trace.push("history.done");
	});
	const runtime = sandbox({
		trace,
		onPluginShutdown: async () => entered.resolve(),
		onBufferedDrain() {},
		communicationStatus: () => ({ pending: 0, failed: false }),
		storageHistory: {
			stop: () => {
				stopped = true;
				return completion;
			},
			snapshot: () => ({ stopped, pending, failed: false }),
		},
	});
	const operation = runtime.run({ reason: "fixture-history", skipWindowsProcessTreeKill: true });
	try {
		await entered.promise;
		expect(stopped).toBe(true);
		expect(pending).toBe(1);
		expect(trace.indexOf("history.stop")).toBeLessThan(trace.indexOf("http.drained"));
		expect(trace).not.toContain("reader.close.begin");
		release.resolve();
		expect(await operation).toMatchObject({ success: true });
		expect(trace.indexOf("history.done")).toBeLessThan(trace.indexOf("reader.close.begin"));
		expect(runtime.cleanMarkers).toBe(1);
	} finally {
		release.resolve();
		await Promise.allSettled([completion, operation]);
		await shutdownDbWorkerPool();
		resumeDbWorkerPool();
	}
});

test("pending history cleanup retains native readers and the instance lock after its deadline", async () => {
	let now = 0;
	const trace: string[] = [];
	const late = Promise.withResolvers<void>();
	let pending = 1;
	const completion = late.promise.then(() => {
		pending = 0;
	});
	const runtime = sandbox({
		trace,
		now: () => now,
		onHttpDrain: () => {
			now = 30_000;
		},
		onPluginShutdown: async () => {},
		onBufferedDrain() {},
		communicationStatus: () => ({ pending: 0, failed: false }),
		storageHistory: {
			stop: () => completion,
			snapshot: () => ({ stopped: true, pending, failed: false }),
		},
	});
	try {
		expect(
			await runtime.run({ reason: "fixture-history-timeout", skipWindowsProcessTreeKill: true }),
		).toMatchObject({ success: false });
		expect(trace.indexOf("history.stop")).toBeGreaterThanOrEqual(0);
		expect(trace.indexOf("history.stop")).toBeLessThan(trace.indexOf("http.drained"));
		expect(runtime.cleanMarkers).toBe(0);
		for (const released of [
			"reader.close.begin",
			"prefixSnapshots.close",
			"postgres.close",
			"dirty",
		])
			expect(trace).not.toContain(released);
		expect(runtime.tracker?.summary().degradedSteps).toContainEqual({
			label: "storageHistory.quiescence",
			outcome: "failed",
		});
	} finally {
		late.resolve();
		await completion;
	}
});

for (const pendingOwner of ["replay", "close"] as const) {
	test(`pending Outline live ${pendingOwner} retains readers and the instance lock after its deadline`, async () => {
		let now = 0;
		const pending = Promise.withResolvers<void>();
		const trace: string[] = [];
		const runtime = sandbox({
			trace,
			now: () => now,
			stageTimeoutMs: 1,
			replay: pendingOwner === "replay" ? pending.promise : undefined,
			onHttpDrain:
				pendingOwner === "replay"
					? () => {
							now = 30_000;
						}
					: undefined,
			onLiveClose:
				pendingOwner === "close"
					? async () => {
							now = 30_000;
							await pending.promise;
							trace.push("outline.close.done");
						}
					: undefined,
			onPluginShutdown: async () => {},
			onBufferedDrain() {},
			communicationStatus: () => ({ pending: 0, failed: false }),
		});
		try {
			expect(
				await runtime.run({ reason: "fixture-outline-timeout", skipWindowsProcessTreeKill: true }),
			).toMatchObject({ success: false });
			expect(trace.indexOf("outline.replay.stop")).toBeGreaterThanOrEqual(0);
			expect(trace.indexOf("outline.replay.stop")).toBeLessThan(trace.indexOf("http.drained"));
			expect(runtime.pendingOutlineWork.length).toBeGreaterThan(0);
			expect(runtime.cleanMarkers).toBe(0);
			for (const released of [
				"reader.close.begin",
				"prefixSnapshots.close",
				"postgres.close",
				"dirty",
			])
				expect(trace).not.toContain(released);
			expect(runtime.tracker?.summary().degradedSteps).toContainEqual({
				label: "outlineLive.close",
				outcome: "timeout",
			});
			expect(runtime.tracker?.summary().degradedSteps).toContainEqual({
				label: "outlineLive.quiescence",
				outcome: "failed",
			});
		} finally {
			pending.resolve();
			await Promise.allSettled(runtime.pendingOutlineWork);
		}
		expect(runtime.pendingOutlineWork).toHaveLength(0);
		expect(trace).toContain("outline.close");
		expect(trace).not.toContain("reader.close.begin");
	});
}

for (const failRead of [false, true]) {
	test(`whole attention handler finishes its late Worker read before reader closure, failure=${failRead}`, async () => {
		const notifications = await import("../../services/notification-service");
		const recentTabs = await import("../../services/recent-tabs-service");
		const { eventBus } = await import("../event-bus");
		const { db } = await import("../../db");
		const { narrators } = await import("../../db/schema");
		const { eq } = await import("drizzle-orm");
		await notifications.resetNotificationBackgroundWorkForTests();
		const id = generateId();
		const now = new Date().toISOString();
		db.insert(narrators)
			.values({
				id,
				title: "Late attention fixture",
				status: "idle",
				visibility: "public",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		const readEntered = Promise.withResolvers<void>();
		const releaseRead = Promise.withResolvers<void>();
		const trace: string[] = [];
		const original = recentTabs.getRecentTabUserIdsForNarrator;
		const read = spyOn(recentTabs, "getRecentTabUserIdsForNarrator").mockImplementation(
			async (narratorId) => {
				if (narratorId !== id) return await original(narratorId);
				readEntered.resolve();
				await releaseRead.promise;
				const result = await original(narratorId);
				trace.push("notification.read.done");
				if (failRead) throw new Error("Injected late attention read failure");
				return result;
			},
		);
		let operation: Promise<{ success: boolean }> | undefined;
		try {
			eventBus.emit({ type: "narrator:attention", narratorId: id, reason: "done" });
			await readEntered.promise;
			expect(notifications.getNotificationBackgroundWorkSnapshot().pending).toBe(1);
			const runtime = sandbox({
				trace,
				onPluginShutdown: async () => {},
				onBufferedDrain() {},
				communicationStatus: () => ({ pending: 0, failed: false }),
				notification: {
					stop: notifications.stopNotificationBackgroundWork,
					drain: notifications.drainNotificationBackgroundWork,
					snapshot: notifications.getNotificationBackgroundWorkSnapshot,
				},
			});
			operation = runtime.run({ reason: "fixture-attention", skipWindowsProcessTreeKill: true });
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(notifications.getNotificationBackgroundWorkSnapshot()).toEqual({
				stopped: true,
				pending: 1,
				failed: 0,
			});
			expect(trace).not.toContain("reader.close.begin");
			expect(trace).not.toContain("clean");
			releaseRead.resolve();
			await operation;
			expect(trace.indexOf("notification.read.done")).toBeLessThan(
				trace.indexOf("reader.close.begin"),
			);
			expect(notifications.getNotificationBackgroundWorkSnapshot()).toEqual({
				stopped: true,
				pending: 0,
				failed: failRead ? 1 : 0,
			});
			expect(runtime.cleanMarkers).toBe(failRead ? 0 : 1);
			expect(runtime.tracker?.isCleanShutdown()).toBe(!failRead);
			if (failRead) expect(trace).toContain("dirty");
		} finally {
			releaseRead.resolve();
			await operation?.catch(() => {});
			await notifications.drainNotificationBackgroundWork().catch(() => {});
			read.mockRestore();
			await shutdownDbWorkerPool();
			resumeDbWorkerPool();
			await notifications.resetNotificationBackgroundWorkForTests({
				expectedFailures: failRead ? 1 : 0,
			});
			db.delete(narrators).where(eq(narrators.id, id)).run();
		}
	}, 10_000);
}
