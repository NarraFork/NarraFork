import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { consumeCleanShutdownState, markCleanShutdown, readCleanShutdownState } from "../../db/fts";
import { createServerRequestLifecycle } from "../../http-request-lifecycle";
import { createDatabaseReaderStartup } from "../db-reader-startup";
import {
	canRunCleanShutdownHooks,
	fenceUnattendedShutdown,
	preservesRecoveryOnShutdown,
	ShutdownActivityTracker,
} from "../shutdown-activity";

test("work arriving at the final idle boundary defers shutdown and reopens admission", async () => {
	const lifecycle = createServerRequestLifecycle();
	const work = Promise.withResolvers<Response>();
	let request: Promise<Response | undefined> | undefined;
	const ready = await fenceUnattendedShutdown(
		() => lifecycle.activeCount > 0,
		async () => {
			expect(lifecycle.accepting).toBe(false);
			request = lifecycle.track(1, new Request("http://localhost"), work.promise);
			return true;
		},
	);
	expect(ready).toBe(false);
	expect(lifecycle.accepting).toBe(true);
	work.resolve(new Response());
	await request;
});

test("post-shutdown hooks require a clean result from the requested teardown", () => {
	const tracker = new ShutdownActivityTracker();
	tracker.markDrainComplete();
	const reason = "unattended_idle";
	expect(canRunCleanShutdownHooks(reason, { reason, clean: tracker.isCleanShutdown() })).toBe(true);
	expect(canRunCleanShutdownHooks(reason, { reason: "signal", clean: true })).toBe(false);
	tracker.recordStep("workspace.persist", "timeout");
	expect(canRunCleanShutdownHooks(reason, { reason, clean: tracker.isCleanShutdown() })).toBe(
		false,
	);
});

describe("ShutdownActivityTracker", () => {
	test("is not clean until drain completes even when every step succeeds", () => {
		const tracker = new ShutdownActivityTracker();
		tracker.recordStep("terminals", "ok");
		tracker.recordStep("mcp", "ok");

		expect(tracker.hasDegradedSteps).toBe(false);
		// Requests were never proven drained, so the clean marker must not be written.
		expect(tracker.isCleanShutdown()).toBe(false);
		expect(tracker.summary()).toMatchObject({ clean: false, drainComplete: false });
	});

	test("is clean when drain completes and all steps succeed", () => {
		const tracker = new ShutdownActivityTracker();
		tracker.recordStep("terminals", "ok");
		tracker.recordStep("mcp", "ok");
		tracker.markDrainComplete();

		expect(tracker.isCleanShutdown()).toBe(true);
		expect(tracker.summary()).toMatchObject({
			clean: true,
			drainComplete: true,
			degradedSteps: [],
		});
	});

	test("a timed-out step keeps the shutdown from being clean", () => {
		const tracker = new ShutdownActivityTracker();
		tracker.recordStep("terminals", "ok");
		tracker.recordStep("browser", "timeout");
		tracker.markDrainComplete();

		expect(tracker.hasDegradedSteps).toBe(true);
		expect(tracker.isCleanShutdown()).toBe(false);
		expect(tracker.summary().degradedSteps).toEqual([{ label: "browser", outcome: "timeout" }]);
	});

	test("a failed step keeps the shutdown from being clean", () => {
		const tracker = new ShutdownActivityTracker();
		tracker.recordStep("mcp", "failed");
		tracker.markDrainComplete();

		expect(tracker.hasDegradedSteps).toBe(true);
		expect(tracker.isCleanShutdown()).toBe(false);
		expect(tracker.summary().degradedSteps).toEqual([{ label: "mcp", outcome: "failed" }]);
	});

	test("summary reports every recorded step and only flags the degraded ones", () => {
		const tracker = new ShutdownActivityTracker();
		tracker.recordStep("a", "ok");
		tracker.recordStep("b", "timeout");
		tracker.recordStep("c", "failed");
		tracker.markDrainComplete();

		const summary = tracker.summary();
		expect(summary.steps).toEqual([
			{ label: "a", outcome: "ok" },
			{ label: "b", outcome: "timeout" },
			{ label: "c", outcome: "failed" },
		]);
		expect(summary.degradedSteps.map((step) => step.label)).toEqual(["b", "c"]);
		expect(summary.clean).toBe(false);
	});

	test("an empty tracker with no drain is not clean", () => {
		const tracker = new ShutdownActivityTracker();
		expect(tracker.isCleanShutdown()).toBe(false);
	});
});

describe("clean shutdown marker lifecycle", () => {
	test("startup consumes the marker before later initialization work", () => {
		const sqlite = new Database(":memory:");
		try {
			markCleanShutdown(sqlite);
			expect(readCleanShutdownState(sqlite)).toEqual({ wasClean: true });
			expect(consumeCleanShutdownState(sqlite)).toEqual({ wasClean: true });
			expect(readCleanShutdownState(sqlite)).toEqual({ wasClean: false });
			expect(consumeCleanShutdownState(sqlite)).toEqual({ wasClean: false });
		} finally {
			sqlite.close();
		}
	});
});

describe("main shutdown wiring without booting the server", () => {
	const main = readFileSync(new URL("../../main.ts", import.meta.url), "utf8");
	test.each([
		["sqlite", true],
		["postgres", true],
		["sqlite", false],
		["postgres", false],
	] as const)("%s startup with reader admission=%s schedules maintenance only once on SQLite", async (backend, admitted) => {
		const maintenanceStart = main.lastIndexOf(
			'if (activeDatabaseBackend === "sqlite") {',
			main.indexOf('startTeamDatabaseMaintenance("status"'),
		);
		const maintenanceEnd = main.indexOf("\n}\n\nconst databaseStartup =", maintenanceStart);
		expect(maintenanceStart).toBeGreaterThanOrEqual(0);
		expect(maintenanceEnd).toBeGreaterThan(maintenanceStart);
		const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
			`async function start() { ${main.slice(maintenanceStart, maintenanceEnd)} }`,
		);
		const cleanup = mock(async () => {});
		const rebuild = mock(async () => {});
		const migrate = mock(async () => {});
		const initialize = new Function(
			"activeDatabaseBackend",
			"startTeamDatabaseMaintenance",
			"retireLegacyChapterResources",
			"scheduleProjectIndexRebuild",
			"migrateAggregationsOnStartup",
			"logger",
			"narratorRecovery",
			`${code}\nreturn start;`,
		)(
			backend,
			() => {},
			cleanup,
			rebuild,
			migrate,
			{ warn() {} },
			Promise.resolve(),
		) as () => Promise<void>;
		const startup = createDatabaseReaderStartup({
			readiness: {
				state: admitted
					? { status: "ready" }
					: { status: "failed", code: "DB_READERS_UNAVAILABLE" },
				wait: async () => (admitted ? { ok: true } : { ok: false, code: "DB_READERS_UNAVAILABLE" }),
			},
			initialize,
			onUnavailable: () => {},
			onError: (error) => {
				throw error;
			},
		});
		await startup.start();
		startup.stop();
		for (const operation of [cleanup, rebuild, migrate])
			expect(operation).toHaveBeenCalledTimes(backend === "sqlite" && admitted ? 1 : 0);
	});
	test("shutdown cancels reader startup before stopping its producers", () => {
		const stop = main.indexOf(
			"databaseStartup.stop();",
			main.indexOf("async function performGracefulShutdown("),
		);
		expect(stop).toBeGreaterThanOrEqual(0);
		expect(stop).toBeLessThan(main.indexOf("backgroundOccupancyInitializer.stop();", stop));
		expect(stop).toBeLessThan(main.indexOf("stopHeartbeat();", stop));
	});
	const start = main.indexOf("async function performGracefulShutdown(");
	const shutdown = main.slice(start, main.indexOf("registerGracefulShutdownHandler(", start));
	const position = (label: string) => {
		const at = shutdown.indexOf(`"${label}"`);
		expect(at).toBeGreaterThanOrEqual(0);
		return at;
	};

	for (const reason of ["signal", "replacement_started", "system_prepared_shutdown"] as const) {
		for (const producerOutcome of ["ok", "failed"] as const) {
			const outcomes =
				reason === "signal" ? (["ok", "failed", "timeout"] as const) : (["ok"] as const);
			test.each(
				outcomes,
			)(`${reason} cleanup with producer outcome ${producerOutcome} handles recovery preparation %s`, async (outcome) => {
				const prepareStart = shutdown.indexOf("httpLifecycle.abortAll();");
				const prepareEnd = shutdown.indexOf("const shutdownRequestId", prepareStart);
				const cleanupStart = shutdown.indexOf("if (!options.skipBashProcessKill)");
				const cleanupEnd = shutdown.indexOf('await step("integrityProbe.cancel"', cleanupStart);
				expect(prepareStart).toBeGreaterThanOrEqual(0);
				expect(prepareEnd).toBeGreaterThan(prepareStart);
				expect(cleanupStart).toBeGreaterThan(prepareEnd);
				expect(cleanupEnd).toBeGreaterThan(cleanupStart);
				const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
					`async function close() { ${shutdown.slice(prepareStart, prepareEnd)}\n${shutdown.slice(cleanupStart, cleanupEnd)} }`,
				);
				const calls: unknown[] = [];
				let phase = reason === "signal" ? "quiescing_tools" : "restarting";
				const close = new Function(
					"options",
					"tracker",
					"step",
					"prepareSignalRestartRecovery",
					"markUpdateRestarting",
					"killAllBashProcesses",
					"httpLifecycle",
					"producerOutcome",
					"stopCheckpointedNarratorRuns",
					`${code}\nreturn close();`,
				);
				await close(
					{ reason },
					new ShutdownActivityTracker(),
					async (label: string, action: () => unknown) => {
						await action();
						return label === "restartRecovery.prepare" ? outcome : "ok";
					},
					async () => {
						calls.push("prepare");
					},
					() => {
						phase = "restarting";
						calls.push("restarting");
					},
					async (options: unknown) => {
						calls.push(options);
					},
					{ abortAll: () => calls.push("abort") },
					producerOutcome,
					() => {
						calls.push(`pause:${phase}`);
						return phase === "restarting" ? 1 : 0;
					},
				);
				const prepared = reason === "signal" && outcome === "ok";
				expect(calls).toEqual([
					"abort",
					...(reason === "signal" ? ["prepare", ...(prepared ? ["restarting"] : [])] : []),
					...(producerOutcome === "ok"
						? [`pause:${reason !== "signal" || prepared ? "restarting" : "quiescing_tools"}`]
						: []),
					{ preserveAgents: prepared },
				]);
			});
		}
	}
	test("owners and compute threads drain before database closure and the clean marker", () => {
		const db = position("dbWorkerPool.shutdown");
		const pg = position("postgresRuntime.close");
		expect(shutdown).toContain("shutdownDbWorkerPool({ permanent: true })");
		expect(shutdown).toContain("closePrefixSnapshotStore({ permanent: true })");
		for (const owner of [
			"pluginManager.shutdown",
			"mcpManager.shutdown",
			"browserSessions.persistForUpdate",
			"browserMemoryWorkers.close",
			"browserPool.close",
			"codexWebSocket.clear",
			"editorDocuments.close",
			"computeWorkers.close",
			"gitWorkers.close",
			"requestRecorderWorkers.close",
			"outlineTextWorkers.close",
			"tokenWorkers.close",
			"modelHistoryWorkers.close",
			"toolInputHistoryWorkers.close",
			"fsScanWorkers.close",
		])
			expect(position(owner)).toBeLessThan(db);
		expect(position("httpHandlers.drain")).toBeLessThan(position("pluginManager.shutdown"));
		expect(position("websocketHandlers.drain")).toBeLessThan(position("computeWorkers.close"));
		expect(position("tokenWorkers.close")).toBeLessThan(position("modelHistoryWorkers.close"));
		expect(shutdown).toContain("TOKEN_RECALCULATION_BATCH_TIMEOUT_MS + 5_000");
		expect(position("prefixSnapshots.close")).toBeLessThan(pg);
		expect(pg).toBeLessThan(shutdown.indexOf("markDatabaseCleanShutdown()"));
	});

	test("editor and recording shutdown retain resource-stage budgets and drain before databases", () => {
		const editor = position("editorDocuments.close");
		const compute = position("computeWorkers.close");
		const recorder = position("requestRecorderWorkers.close");
		const history = position("modelHistoryWorkers.close");
		expect(editor).toBeLessThan(compute);
		expect(compute).toBeLessThan(recorder);
		expect(recorder).toBeLessThan(history);
		const editorStep = shutdown.slice(editor, compute);
		expect(editorStep).toContain("owner.closeEditorDocumentService()");
		expect(editorStep).toContain("70_000");
		const recorderStep = shutdown.slice(recorder, history);
		expect(recorderStep).toContain("owner.closeRequestRecorderWorkers()");
		expect(recorderStep).toContain("200_000");
	});
	test("outline workers stop after their producers and use a real permanent close barrier", () => {
		const outline = position("outlineTextWorkers.close");
		expect(position("outlineLive.close")).toBeLessThan(outline);
		expect(position("outlineTaskLeases.stop")).toBeLessThan(outline);
		expect(outline).toBeLessThan(position("tokenWorkers.close"));
		const step = shutdown.slice(outline, position("tokenWorkers.close"));
		expect(step).toContain("owner.closeEditTextWorkers()");
		expect(step).toContain("35_000");
		expect(step).not.toContain("stopEditTextWorker()");
	});
	test("Git and historical-input owners drain after their consumers without clearing durable data", () => {
		const git = position("gitWorkers.close");
		const recorder = position("requestRecorderWorkers.close");
		expect(position("computeWorkers.close")).toBeLessThan(git);
		expect(git).toBeLessThan(recorder);
		const gitStep = shutdown.slice(git, recorder);
		expect(gitStep).toContain("owner.closeGitCurrentBaselineWorkers()");
		expect(gitStep).toContain("owner.closeGitLineStatsWorkers()");
		expect(gitStep).toContain("35_000");
		const historical = position("toolInputHistoryWorkers.close");
		expect(position("modelHistoryWorkers.close")).toBeLessThan(historical);
		expect(historical).toBeLessThan(position("dbWorkerPool.shutdown"));
		const historicalStep = shutdown.slice(historical, position("fsScanWorkers.close"));
		expect(historicalStep).toContain("owner.closeToolInputHistoricalWorkers()");
		expect(historicalStep).toContain("15_000");
		expect(historicalStep).not.toContain("discardUnpersisted");
	});
	test("browser native cleanup finishes before close/preserve detach without shrinking its stage budgets", () => {
		const persist = position("browserSessions.persistForUpdate");
		const native = position("browserMemoryWorkers.close");
		const browser = position("browserPool.close");
		expect(persist).toBeLessThan(native);
		expect(native).toBeLessThan(browser);
		expect(shutdown.slice(persist, native)).toContain("35_000");
		const step = shutdown.slice(native, browser);
		expect(step).toContain("owner.closeMemoryDiagnosticWorkers()");
		expect(step).toContain("35_000");
		expect(step).not.toContain("closeAllSessions()");
	});
	test.each([
		"if (storageHistory.pending)",
		"if (outlineLiveDatabaseWork.size)",
		"if (getTeamDatabaseMaintenanceStatus().pending)",
	])("%s retains ownership without authorizing clean-shutdown hooks", (condition) => {
		const boundary = shutdown.indexOf(condition);
		expect(boundary).toBeGreaterThanOrEqual(0);
		const start = shutdown.indexOf("return {", boundary);
		const end = shutdown.indexOf("\n\t\t\t};", start);
		expect(end).toBeGreaterThan(start);
		const reason = "unattended_idle";
		const result = new Function("options", "process", "startedAt", shutdown.slice(start, end + 6))(
			{ reason },
			{ pid: 1 },
			Date.now(),
		);
		expect(result).toMatchObject({ success: false, clean: false, reason });
		expect(canRunCleanShutdownHooks(reason, result)).toBe(false);
	});
	test("real compute close promises are awaited together and failures degrade shutdown", () => {
		for (const close of [
			"owner.closeRevertManifestWorkers()",
			"owner.closeRevertBodyWorkers()",
			"owner.closeRevertRewriteWorkers()",
			"owner.closeSharePreviewHtmlWorkers()",
			"owner.closeRequestJsonWorkers()",
			"owner.closeImageGenerationResponseWorkers()",
		])
			expect(shutdown).toContain(close);
		expect(shutdown).toContain("await Promise.allSettled([");
		expect(shutdown).toContain('result.status === "rejected"');
		expect(shutdown).toContain("throw new AggregateError(failures");
		expect(shutdown).toContain("summary.clean ? markDatabaseCleanShutdown() : false");
	});

	test.each([
		"failed",
		"timeout",
	] as const)("%s is recorded with scalar diagnostics even if its sink throws", async (outcome) => {
		// Execute only this dependency-free helper, never import or boot main.
		const stepStart = main.indexOf("async function shutdownStep(");
		expect(stepStart).toBeGreaterThanOrEqual(0);
		const source = main.slice(stepStart, start);
		const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
		for (const throws of [false, true]) {
			const calls: unknown[][] = [];
			const runStep = new Function("logger", `${code}\nreturn shutdownStep;`)({
				warn(...args: unknown[]) {
					calls.push(args);
					if (throws) throw new Error("PRIVATE_LOG_FAILURE");
				},
			}) as (
				tracker: ShutdownActivityTracker,
				step: string,
				work: () => unknown,
				timeoutMs: number,
			) => Promise<string>;
			const tracker = new ShutdownActivityTracker();
			tracker.markDrainComplete();
			const work = () =>
				outcome === "failed"
					? Promise.reject(new Error("PRIVATE_CLOSE_BODY /private/worker-entry.ts"))
					: new Promise(() => {});
			expect(await runStep(tracker, "modelHistoryWorkers.close", work, 5)).toBe(outcome);
			expect(tracker.summary().degradedSteps).toEqual([
				{ label: "modelHistoryWorkers.close", outcome },
			]);
			expect(tracker.isCleanShutdown()).toBe(false);
			expect(calls).toEqual([
				[
					outcome === "failed" ? "Shutdown step failed" : "Shutdown step timed out",
					{
						step: "modelHistoryWorkers.close",
						outcome,
						...(outcome === "timeout" ? { timeoutMs: 5 } : {}),
					},
				],
			]);
			const logged = JSON.stringify(calls);
			for (const secret of [
				"PRIVATE_CLOSE_BODY",
				"PRIVATE_LOG_FAILURE",
				"/private/",
				"worker-entry.ts",
			])
				expect(logged).not.toContain(secret);
		}
	});
	test.each([
		false,
		true,
	])("handoff and operator hooks reach shutdown even when the sink throws: %s", async (throws) => {
		// Evaluate only the registrations with stubbed shutdown/timer/process; never boot main.
		const hooksStart = main.indexOf("registerGracefulShutdownHandler(");
		const hooksEnd = main.indexOf("const safeShutdown =", hooksStart);
		expect(hooksStart).toBeGreaterThanOrEqual(0);
		expect(hooksEnd).toBeGreaterThan(hooksStart);
		const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
			main.slice(hooksStart, hooksEnd),
		);
		type Handler = (request: {
			pid?: number;
			version?: string;
			reason?: string;
		}) => Promise<unknown>;
		const handlers: Handler[] = [];
		const diagnostics: unknown[] = [];
		const options: unknown[] = [];
		const delays: number[] = [];
		const hookReasons: string[] = [];
		const result = { success: true, reason: "", clean: true };
		const shutdownReason = "unattended_idle";
		let idle = false;
		let deferred = 0;
		new Function(
			"registerGracefulShutdownHandler",
			"registerOperatorShutdownHandler",
			"logger",
			"performGracefulShutdown",
			"preservesRecoveryOnShutdown",
			"setTimeout",
			"process",
			"runPostShutdownHooks",
			"UNATTENDED_SHUTDOWN_REASON",
			"canRunCleanShutdownHooks",
			"fenceUnattendedShutdown",
			"unattendedMode",
			"shutdownState",
			"httpLifecycle",
			"hasActiveWebSocketHandlers",
			"isScheduledTaskTickActive",
			code,
		)(
			(handler: Handler) => handlers.push(handler),
			(handler: Handler) => handlers.push(handler),
			{
				info(...args: unknown[]) {
					diagnostics.push(args);
					if (throws) throw new Error("PRIVATE_SINK_FAILURE");
				},
			},
			async (requested: { reason: string }) => {
				options.push(requested);
				result.reason = requested.reason;
				return result;
			},
			preservesRecoveryOnShutdown,
			(_callback: unknown, delay: number) => {
				delays.push(delay);
				return 0;
			},
			{
				exit() {
					throw new Error("must not exit a real process");
				},
			},
			// Post-shutdown hooks are the seam unattended mode's power-off uses; the operator
			// path must reach them for clean shutdowns.
			async (reason: string) => {
				hookReasons.push(reason);
			},
			shutdownReason,
			canRunCleanShutdownHooks,
			(...args: Parameters<typeof fenceUnattendedShutdown>) =>
				idle ? Promise.resolve(true) : fenceUnattendedShutdown(...args),
			{
				revalidateIdle: async () => idle,
				deferShutdown: () => deferred++,
			},
			{ promise: null },
			{ activeCount: 1 },
			() => false,
			() => false,
		);
		expect(handlers).toHaveLength(2);
		expect(await handlers[0]({ pid: 12345, version: "/private/HANDOFF_VERSION_CANARY" })).toBe(
			result,
		);
		for (const reason of ["operator_shutdown", "system_prepared_shutdown"]) {
			expect(await handlers[1]({ reason })).toBe(result);
		}
		expect(await handlers[1]({ reason: shutdownReason })).toBeNull();
		expect(deferred).toBe(1);
		expect(options).toEqual([
			{
				reason: "replacement_started",
				skipWindowsProcessTreeKill: true,
				skipBashProcessKill: true,
			},
			{
				reason: "operator_shutdown",
				skipWindowsProcessTreeKill: false,
				skipBashProcessKill: false,
			},
			{
				reason: "system_prepared_shutdown",
				skipWindowsProcessTreeKill: true,
				skipBashProcessKill: true,
			},
		]);
		expect(delays).toEqual([250, 250, 250]);
		expect(hookReasons).toEqual(["operator_shutdown", "system_prepared_shutdown"]);
		expect(diagnostics).toHaveLength(3);
		for (const canary of ["/private/", "HANDOFF_VERSION_CANARY", "PRIVATE_SINK_FAILURE", "12345"])
			expect(JSON.stringify(diagnostics)).not.toContain(canary);

		idle = true;
		result.clean = false;
		expect(await handlers[1]({ reason: shutdownReason })).toBe(result);
		expect(hookReasons).not.toContain(shutdownReason);
		expect(delays).toEqual([250, 250, 250, 250]);
	});
	test("HMR pins shutdown ownership and registers delegating process hooks only once", () => {
		expect(main).toContain('"narrafork.mainShutdown"');
		expect(main).not.toContain("let shutdownPromise");
		expect(main).toContain("if (shutdownState.promise) return shutdownState.promise;");
		expect(main).toContain("shutdownState.onSignal = safeShutdown;");
		expect(main).toContain('hotOnce("narrafork.mainShutdown.signals")');
		expect(main).toContain('["SIGINT", "SIGTERM", "SIGHUP"]');
		expect(main).toContain("() => shutdownState.onSignal?.()");
		const signalHook = main.indexOf("process.on(signal, () => shutdownState.onSignal?.());");
		const browserClaim = main.indexOf("claimBrowserShutdownOwnership();");
		expect(signalHook).toBeGreaterThanOrEqual(0);
		expect(browserClaim).toBeGreaterThan(signalHook);
		expect(main).toContain('hotOnce("narrafork.mainShutdown.exit")');
		expect(main).toContain("() => shutdownState.onExit?.()");
		expect(main).toContain("IS_WINDOWS && shutdownState.killWindowsProcessTreeOnExit");
	});

	test("the status page remains before main and main parses without executing it", () => {
		const serve = readFileSync(new URL("../../serve.ts", import.meta.url), "utf8");
		expect(serve.indexOf("await showStatusPage(settings)")).toBeGreaterThanOrEqual(0);
		expect(serve.indexOf("await showStatusPage(settings)")).toBeLessThan(
			serve.indexOf('await import("./main")'),
		);
		expect(new Bun.Transpiler({ loader: "ts" }).transformSync(main)).toContain("mainShutdown");
	});
});
