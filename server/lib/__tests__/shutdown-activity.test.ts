import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { consumeCleanShutdownState, markCleanShutdown, readCleanShutdownState } from "../../db/fts";
import { preservesRecoveryOnShutdown, ShutdownActivityTracker } from "../shutdown-activity";

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
	const start = main.indexOf("async function performGracefulShutdown(");
	const shutdown = main.slice(start, main.indexOf("registerGracefulShutdownHandler(", start));
	const position = (label: string) => {
		const at = shutdown.indexOf(`"${label}"`);
		expect(at).toBeGreaterThanOrEqual(0);
		return at;
	};

	test.each([
		"ok",
		"failed",
		"timeout",
	] as const)("signal cleanup preserves Agent runs only after checkpoint preparation returns %s", async (outcome) => {
		const prepareStart = shutdown.indexOf("let preserveAgentRuns = false;");
		const prepareEnd = shutdown.indexOf("const shutdownRequestId", prepareStart);
		const cleanupStart = shutdown.indexOf("if (!options.skipBashProcessKill)");
		const cleanupEnd = shutdown.indexOf(
			'await shutdownStep(tracker, "vnetUdpRendezvous.stop"',
			cleanupStart,
		);
		expect(prepareStart).toBeGreaterThanOrEqual(0);
		expect(prepareEnd).toBeGreaterThan(prepareStart);
		expect(cleanupStart).toBeGreaterThan(prepareEnd);
		expect(cleanupEnd).toBeGreaterThan(cleanupStart);
		const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
			`async function close() { ${shutdown.slice(prepareStart, prepareEnd)}\n${shutdown.slice(cleanupStart, cleanupEnd)} }`,
		);
		const calls: unknown[] = [];
		const close = new Function(
			"options",
			"tracker",
			"shutdownStep",
			"prepareSignalRestartRecovery",
			"markUpdateRestarting",
			"killAllBashProcesses",
			`${code}\nreturn close();`,
		);
		await close(
			{ reason: "signal" },
			new ShutdownActivityTracker(),
			async (_tracker: unknown, label: string, action: () => Promise<unknown>) => {
				await action();
				return label === "restartRecovery.prepare" ? outcome : "ok";
			},
			async () => {
				calls.push("checkpoint");
			},
			() => {
				calls.push("restarting");
			},
			async (options: unknown) => {
				calls.push(options);
			},
		);
		expect(calls).toEqual([
			"checkpoint",
			...(outcome === "ok" ? ["restarting"] : []),
			{ preserveAgents: outcome === "ok" },
		]);
	});
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
		const result = { success: true };
		new Function(
			"registerGracefulShutdownHandler",
			"registerOperatorShutdownHandler",
			"logger",
			"performGracefulShutdown",
			"preservesRecoveryOnShutdown",
			"setTimeout",
			"process",
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
			async (requested: unknown) => {
				options.push(requested);
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
		);
		expect(handlers).toHaveLength(2);
		expect(await handlers[0]({ pid: 12345, version: "/private/HANDOFF_VERSION_CANARY" })).toBe(
			result,
		);
		for (const reason of ["operator_shutdown", "system_prepared_shutdown"]) {
			expect(await handlers[1]({ reason })).toBe(result);
		}
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
		expect(diagnostics).toHaveLength(3);
		for (const canary of ["/private/", "HANDOFF_VERSION_CANARY", "PRIVATE_SINK_FAILURE", "12345"])
			expect(JSON.stringify(diagnostics)).not.toContain(canary);
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
