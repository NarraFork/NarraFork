import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DbReadError, readAborted } from "../db-worker/errors";
import { ShutdownActivityTracker } from "../shutdown-activity";

// Evaluate only production teardown functions, never the application entry point.
const source = readFileSync(new URL("../../main.ts", import.meta.url), "utf8");
const start = source.indexOf("async function shutdownStep(");
const end = source.indexOf("\nasync function performGracefulShutdown(", start);
const stageStart = source.indexOf("const businessDeadlineAt = ownerDeadlineAt;");
const stageEnd = source.indexOf(
	'\n\t\tawait shutdownStep(\n\t\t\ttracker,\n\t\t\t"postgresRuntime.close"',
	stageStart,
);
if (start < 0 || end < start || stageStart < 0 || stageEnd < stageStart)
	throw new Error("Cannot locate production reader teardown stages");
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(`${source.slice(start, end)}
async function readerStages(tracker) {
const budget = createShutdownBudget();
const ownerDeadlineAt = Date.now() + budget.businessRemaining();
const options = {reason: "fixture"};
const startedAt = Date.now();
const translationStop = stopReasoningTranslations({ timeoutMs: budget.businessRemaining() });
const occupancyStop = stopBackgroundOccupancy();
const projectIndexStop = stopProjectIndexRebuild({ deadlineAt: ownerDeadlineAt });
const blockJobsStop = stopBlockBackgroundJobs({ deadlineAt: ownerDeadlineAt });
const storageHistoryStop = stopStorageHistoryRetention({ deadlineAt: ownerDeadlineAt });
const step = (label, fn, limit = 4000, ownsDeadline = false) => shutdownStep(tracker, label, fn, Math.min(limit, budget.businessRemaining()), ownsDeadline);
${source.slice(stageStart, stageEnd)} }
`);

function harness() {
	let now = 1_000;
	const trace: string[] = [];
	const budgets: number[] = [];
	const state = {
		session: { pending: 0, failed: 0 },
		context: { pending: 0, running: false, scheduled: false, failed: false, quiescing: true },
		buffered: { pending: 0, active: 0, waiting: 0, batches: 0, failed: 0 },
		communication: { pending: 0, failed: false },
		notification: { stopped: true, pending: 0, failed: 0 },
		storageHistory: { stopped: true, pending: 0, failed: false },
		bash: { stopped: true, pending: 0, failed: 0 },
		websocket: false,
	};
	const deps = {
		logger: { warn() {}, info() {} },
		DbReadError,
		Date: { now: () => now },
		performance: { now: () => now },
		outlineLiveDatabaseWork: new Set<Promise<unknown>>(),
		drainNarratorRunCompletions: async () => {},
		getNarratorRunShutdownSnapshot: () => ({ stopped: true, pending: 0, failed: 0 }),
		backgroundTaskService: {
			drainBashCollectors: async (_options: { deadlineAt: number }) => {
				state.bash.pending = 0;
				trace.push("bash.drain");
			},
			getBashShutdownSnapshot: () => state.bash,
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
		setTimeout: (callback: () => void, delay: number) => {
			budgets.push(delay);
			return setTimeout(callback, delay);
		},
		clearTimeout,
		stopRuntimePublications: () => {
			trace.push("producers.stop");
		},
		stopInboxWakes: () => {
			trace.push("inbox.stop");
		},
		stopBufferedFilePreparations() {},
		quiesceContextCharacterRefreshes() {},
		stopReasoningTranslations: async (_options: { timeoutMs: number }) => {
			trace.push("translation.stop");
		},
		stopBackgroundOccupancy: async () => {
			trace.push("occupancy.stop");
		},
		stopProjectIndexRebuild: async (_options: { deadlineAt: number }) => {
			trace.push("index.stop");
		},
		stopBlockBackgroundJobs: async (_options: { deadlineAt: number }) => {
			trace.push("blocks.stop");
		},
		stopStorageHistoryRetention: async (_options: { deadlineAt: number }) => {
			trace.push("history.stop");
		},
		getStorageHistoryShutdownSnapshot: () => state.storageHistory,
		drainNarratorSessionTails: async (_options: { deadlineAt: number }) => {
			state.session.pending = 0;
			trace.push("session.drain");
		},
		getNarratorSessionTailStatus: () => state.session,
		drainContextCharacterRefreshes: async (_options: { deadlineAt: number }) => {
			state.context.pending = 0;
			trace.push("context.drain");
		},
		getContextCharacterRefreshStatus: () => state.context,
		drainNarratorWsReadTasks: async (_options: { deadlineAt: number }) => {
			state.websocket = false;
			trace.push("websocket.drain");
		},
		hasPendingNarratorWsReadTasks: () => state.websocket,
		drainBufferedFilePreparations: async (_options: { deadlineAt: number }) => {
			state.buffered.pending = 0;
			trace.push("buffered.drain");
		},
		hasPendingBufferedFilePreparations: () => state.buffered.pending > 0,
		getBufferedFilePreparationStatus: () => state.buffered,
		drainCommunicationWork: async (_options: { deadlineAt: number }) => {
			trace.push("communication.drain");
		},
		getCommunicationWorkStatus: () => state.communication,
		drainNotificationBackgroundWork: async (_options: { deadlineAt: number }) => {
			state.notification.pending = 0;
			trace.push("notification.drain");
		},
		getNotificationBackgroundWorkSnapshot: () => state.notification,
		drainDbWorkerPool: async (_options: { deadlineAt: number }) => {
			trace.push("native.exit");
		},
		closePrefixSnapshotStore: async () => {
			trace.push("prefixSnapshots.close");
		},
	};
	const runtime = () =>
		new Function(
			...Object.keys(deps),
			`${compiled}\nreturn {readerStages, shutdownStep, drainShutdownDatabaseWork, auditShutdownDatabaseWork};`,
		)(...Object.values(deps)) as {
			readerStages(tracker: ShutdownActivityTracker): Promise<void>;
			shutdownStep(
				tracker: ShutdownActivityTracker,
				label: string,
				fn: () => unknown,
				timeoutMs: number,
				ownsDeadline?: boolean,
			): Promise<string>;
			drainShutdownDatabaseWork(deadlineAt: number): Promise<void>;
			auditShutdownDatabaseWork(tracker: ShutdownActivityTracker): string;
		};
	return {
		deps,
		state,
		trace,
		budgets,
		runtime,
		advance: (ms: number) => {
			now += ms;
		},
	};
}
const tracker = () => {
	const value = new ShutdownActivityTracker();
	value.markDrainComplete();
	return value;
};

describe("reader teardown sequencing", () => {
	test("stops current producers before drain and native release before the clean marker", () => {
		let cursor = source.indexOf("async function performGracefulShutdown(");
		for (const label of [
			"backgroundOccupancyInitializer.stop();",
			"quiesceNarratorWsReadTasks();",
			'"databaseProducers.stop"',
			"stopInboxWakes,",
			"stopOutlineLiveReplay,",
			"stopResourceProtectionIndex({ deadlineAt: ownerDeadlineAt })",
			"cancelBackgroundIntegrityCheck({ deadlineAt: ownerDeadlineAt })",
			"stopStorageHistoryRetention({ deadlineAt: ownerDeadlineAt })",
			'"checkpointRuns.pause"',
			"closeAllConnections();",
			'"gateway.stop"',
			'"integrityProbe.cancel"',
			'"pluginManager.shutdown"',
			'"mcpManager.shutdown"',
			'"codexWebSocket.clear"',
			'"backgroundOccupancy.stop"',
			'"projectIndex.stop"',
			'"blockBackgroundJobs.stop"',
			'"storageHistory.stop"',
			'"databaseWork.drain"',
			'"dbWorkerPool.drain"',
			'"prefixSnapshots.close"',
			'"postgresRuntime.close"',
			"auditShutdownDatabaseWork(tracker);",
			"const summary = tracker.summary();",
			"markDatabaseCleanShutdown()",
		]) {
			const next = source.indexOf(label, cursor);
			expect(next, label).toBeGreaterThan(cursor);
			cursor = next;
		}
		expect(source).toContain(
			"const cleanMarked = summary.clean ? markDatabaseCleanShutdown() : false;",
		);
	});

	test("prefix snapshots close after native reader exit before certifying a clean shutdown", async () => {
		const h = harness();
		const record = tracker();
		await h.runtime().readerStages(record);
		expect(h.trace.indexOf("native.exit")).toBeGreaterThanOrEqual(0);
		expect(h.trace.indexOf("history.stop")).toBeGreaterThanOrEqual(0);
		expect(h.trace.indexOf("history.stop")).toBeLessThan(h.trace.indexOf("native.exit"));
		expect(h.trace.indexOf("prefixSnapshots.close")).toBeGreaterThan(
			h.trace.indexOf("native.exit"),
		);
		expect(record.isCleanShutdown()).toBe(true);
	});

	test("a producer failure does not bypass draining and remains dirty", async () => {
		const h = harness();
		h.deps.stopRuntimePublications = () => {
			throw new Error("stop failed");
		};
		const record = tracker();
		const runtime = h.runtime();
		await runtime.shutdownStep(
			record,
			"databaseProducers.stop",
			h.deps.stopRuntimePublications,
			4000,
		);
		h.deps.stopInboxWakes();
		await runtime.readerStages(record);
		expect(h.trace).toContain("native.exit");
		expect(h.trace.indexOf("inbox.stop")).toBeGreaterThanOrEqual(0);
		expect(h.trace.indexOf("inbox.stop")).toBeLessThan(h.trace.indexOf("communication.drain"));
		expect(record.summary().degradedSteps).toContainEqual({
			label: "databaseProducers.stop",
			outcome: "failed",
		});
		expect(record.isCleanShutdown()).toBe(false);
	});

	test("communication-derived work reaches a fixed point before native exit", async () => {
		const h = harness();
		let pass = 0;
		h.deps.drainCommunicationWork = async () => {
			if (pass++ === 0) {
				h.state.session.pending = 1;
				h.state.buffered.pending = 1;
				h.state.context.pending = 1;
				h.state.websocket = true;
			}
		};
		const record = tracker();
		const runtime = h.runtime();
		await runtime.readerStages(record);
		expect(h.trace.filter((item) => item === "session.drain")).toHaveLength(2);
		expect(runtime.auditShutdownDatabaseWork(record)).toBe("ok");
		expect(record.isCleanShutdown()).toBe(true);
	});

	test("notification-derived work drains to a fixed point and retained notification failures stay dirty", async () => {
		const h = harness();
		let pass = 0;
		h.deps.drainNotificationBackgroundWork = async () => {
			h.trace.push("notification.drain");
			if (pass++ === 0) {
				h.state.session.pending = 1;
				h.state.context.pending = 1;
			}
		};
		const runtime = h.runtime();
		await runtime.readerStages(tracker());
		expect(h.trace.filter((entry) => entry === "session.drain")).toHaveLength(2);
		expect(h.trace.lastIndexOf("notification.drain")).toBeLessThan(h.trace.indexOf("native.exit"));
		for (const state of [
			{ stopped: true, pending: 1, failed: 0 },
			{ stopped: true, pending: 0, failed: 1 },
			{ stopped: false, pending: 0, failed: 0 },
		]) {
			h.state.notification = state;
			const record = tracker();
			expect(runtime.auditShutdownDatabaseWork(record)).toBe("failed");
			expect(record.isCleanShutdown()).toBe(false);
		}
	});

	test("Bash-derived reads reach a fixed point and retained lifecycle failures stay dirty", async () => {
		const h = harness();
		let pass = 0;
		h.deps.drainCommunicationWork = async () => {
			if (pass++ === 0) h.state.bash.pending = 1;
		};
		const runtime = h.runtime();
		await runtime.readerStages(tracker());
		expect(h.trace.filter((entry) => entry === "bash.drain")).toHaveLength(2);
		expect(h.trace.lastIndexOf("bash.drain")).toBeLessThan(h.trace.indexOf("native.exit"));
		for (const state of [
			{ stopped: true, pending: 1, failed: 0 },
			{ stopped: true, pending: 0, failed: 1 },
			{ stopped: false, pending: 0, failed: 0 },
		]) {
			h.state.bash = state;
			const record = tracker();
			expect(runtime.auditShutdownDatabaseWork(record)).toBe("failed");
			expect(record.isCleanShutdown()).toBe(false);
		}
	});

	test("business stages share a deadline while native exit has an independent budget", async () => {
		const h = harness();
		const deadlines: number[] = [];
		h.deps.stopProjectIndexRebuild = async ({ deadlineAt }) => {
			deadlines.push(deadlineAt);
			h.advance(1_000);
		};
		h.deps.stopBlockBackgroundJobs = async ({ deadlineAt }) => {
			deadlines.push(deadlineAt);
			h.advance(500);
		};
		h.deps.drainDbWorkerPool = async ({ deadlineAt }) => {
			deadlines.push(deadlineAt);
		};
		await h.runtime().readerStages(tracker());
		expect(deadlines).toEqual([31_000, 31_000, 12_500]);
	});

	test("business exhaustion preserves a full independent native exit budget", async () => {
		const h = harness();
		let readerBudget = 0;
		h.deps.drainNarratorSessionTails = async () => {
			h.advance(30_000);
		};
		h.deps.drainDbWorkerPool = async ({ deadlineAt }) => {
			readerBudget = deadlineAt - 31_000;
			h.trace.push("native.exit");
		};
		const record = tracker();
		await h.runtime().readerStages(record);
		expect(readerBudget).toBe(10_000);
		expect(h.trace).toContain("native.exit");
		expect(record.isCleanShutdown()).toBe(false);
	});

	test("global expiry skips database work rather than renewing stage deadlines", async () => {
		const h = harness();
		h.deps.stopProjectIndexRebuild = async () => {
			h.advance(50_000);
		};
		const record = tracker();
		await h.runtime().readerStages(record);
		expect(h.trace).toContain("blocks.stop");
		expect(h.trace).not.toContain("session.drain");
		expect(h.trace).not.toContain("native.exit");
		expect(record.isCleanShutdown()).toBe(false);
	});

	test("history retention admission, pending jobs and failures participate in the final audit", () => {
		const h = harness();
		for (const state of [
			{ stopped: false, pending: 0, failed: false },
			{ stopped: true, pending: 1, failed: false },
			{ stopped: true, pending: 0, failed: true },
		]) {
			h.state.storageHistory = state;
			const record = tracker();
			expect(h.runtime().auditShutdownDatabaseWork(record)).toBe("failed");
			expect(record.isCleanShutdown()).toBe(false);
		}
	});

	test("pending Outline live writes are part of the final clean audit", () => {
		const h = harness();
		const work = Promise.resolve();
		h.deps.outlineLiveDatabaseWork.add(work);
		const record = tracker();
		expect(h.runtime().auditShutdownDatabaseWork(record)).toBe("failed");
		expect(record.isCleanShutdown()).toBe(false);
		h.deps.outlineLiveDatabaseWork.delete(work);
	});

	test("maintenance and integrity owners are part of the final clean audit", () => {
		const h = harness();
		h.deps.getResourceProtectionShutdownSnapshot = () => ({
			stopped: true,
			pendingTasks: 1,
			pendingReceiptImports: 1,
			maintenanceScheduled: false,
		});
		expect(h.runtime().auditShutdownDatabaseWork(tracker())).toBe("failed");
		h.deps.getResourceProtectionShutdownSnapshot = () => ({
			stopped: true,
			pendingTasks: 0,
			pendingReceiptImports: 0,
			maintenanceScheduled: false,
		});
		h.deps.getIntegrityCheckShutdownSnapshot = () => ({
			stopped: true,
			pendingTasks: 0,
			pendingProcesses: 1,
			scheduled: false,
		});
		expect(h.runtime().auditShutdownDatabaseWork(tracker())).toBe("failed");
		h.deps.getIntegrityCheckShutdownSnapshot = () => ({
			stopped: true,
			pendingTasks: 0,
			pendingProcesses: 0,
			scheduled: false,
		});
		h.deps.getNarratorRunShutdownSnapshot = () => ({ stopped: true, pending: 0, failed: 1 });
		const record = tracker();
		expect(h.runtime().auditShutdownDatabaseWork(record)).toBe("failed");
		expect(record.isCleanShutdown()).toBe(false);
	});

	test("a self-deadline drain has no competing outer timeout or delayed duplicate failure", async () => {
		const h = harness();
		const record = tracker();
		const runtime = h.runtime();
		expect(
			await runtime.shutdownStep(
				record,
				"self-deadline",
				async () => {
					throw new Error("deadline expired");
				},
				20,
				true,
			),
		).toBe("failed");
		expect(h.budgets).toHaveLength(0);
	});

	test("unconfirmed native release and exhausted budgets cannot certify clean shutdown", async () => {
		const h = harness();
		h.deps.drainDbWorkerPool = async () => {
			throw new Error("exit unconfirmed");
		};
		const record = tracker();
		const runtime = h.runtime();
		await runtime.readerStages(record);
		expect(record.isCleanShutdown()).toBe(false);
		let stopped = false;
		expect(
			await runtime.shutdownStep(
				record,
				"exhausted",
				() => {
					stopped = true;
				},
				0,
			),
		).toBe("timeout");
		expect(stopped).toBe(false);
		h.state.buffered.failed = 1;
		expect(runtime.auditShutdownDatabaseWork(record)).toBe("failed");
	});
});

function retentionHarness() {
	const source = readFileSync(
		new URL("../../services/storage-history-runtime.ts", import.meta.url),
		"utf8",
	);
	const start = source.indexOf("export function stopStorageHistoryRetention(");
	if (start < 0) throw new Error("Cannot locate production history retention teardown");
	const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(
		source.slice(start).replace(/^export /gm, ""),
	);
	const release = Promise.withResolvers<void>();
	let unsubscribed = false;
	let stops = 0;
	const state = {
		stopping: false,
		pending: new Set<Promise<unknown>>(),
		shutdown: null as Promise<void> | null,
		shutdownSettled: false,
		shutdownFailed: false,
		unsubscribe: (() => {
			unsubscribed = true;
		}) as (() => void) | null,
		service: {
			stop: () => {
				stops++;
			},
			settled: () => release.promise,
		},
	};
	const runtime = new Function(
		"runtime",
		"DbReadError",
		"readAborted",
		`${compiled}\nreturn {stopStorageHistoryRetention, getStorageHistoryShutdownSnapshot};`,
	)(state, DbReadError, readAborted) as {
		stopStorageHistoryRetention(options?: {
			deadlineAt?: number;
			signal?: AbortSignal;
		}): Promise<void>;
		getStorageHistoryShutdownSnapshot(): { stopped: boolean; pending: number; failed: boolean };
	};
	return { state, runtime, release, unsubscribed: () => unsubscribed, stops: () => stops };
}

describe("history retention teardown ownership", () => {
	test("production stop freezes admission and keeps ownership until service jobs settle", async () => {
		const h = retentionHarness();
		const stopped = h.runtime.stopStorageHistoryRetention({ deadlineAt: Date.now() + 1_000 });
		expect(h.state.stopping).toBe(true);
		expect(h.unsubscribed()).toBe(true);
		expect(h.state.unsubscribe).toBeNull();
		expect(h.stops()).toBeGreaterThanOrEqual(1);
		expect(h.runtime.getStorageHistoryShutdownSnapshot()).toMatchObject({
			stopped: true,
			pending: 1,
		});
		h.release.resolve();
		await stopped;
		expect(h.runtime.getStorageHistoryShutdownSnapshot()).toEqual({
			stopped: true,
			pending: 0,
			failed: false,
		});
	});

	test("production deadline failure retains pending ownership until late completion", async () => {
		const h = retentionHarness();
		await expect(
			h.runtime.stopStorageHistoryRetention({ deadlineAt: Date.now() + 1 }),
		).rejects.toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
		expect(h.runtime.getStorageHistoryShutdownSnapshot()).toMatchObject({
			stopped: true,
			pending: 1,
		});
		h.release.resolve();
		await h.runtime.stopStorageHistoryRetention({ deadlineAt: Date.now() + 1_000 });
		expect(h.runtime.getStorageHistoryShutdownSnapshot()).toMatchObject({
			pending: 0,
			failed: false,
		});
	});
});
