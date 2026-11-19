import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import {
	beginReadFanoutSpan,
	countReadFanout,
	finishReadFanoutSpan,
	isReadFanoutCaptureActive,
	postReadFanoutTask,
	readFanoutHttpMiddleware,
	receiveReadFanoutTask,
	recordReadFanoutSql,
	resetReadFanoutDiagnosticsForTest,
	runReadFanoutWebSocketScope,
	startReadFanoutCapture,
	stopReadFanoutCapture,
	timeReadFanoutSync,
} from "./read-fanout-diagnostics";

function read() {
	const span = beginReadFanoutSpan("logical");
	finishReadFanoutSpan(span);
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
afterEach(resetReadFanoutDiagnosticsForTest);

describe("bounded opt-in read fanout", () => {
	test("closed path performs no timing or fingerprint work and preserves values/errors", () => {
		const clock = spyOn(performance, "now").mockImplementation(() => {
			throw new Error("clock unavailable");
		});
		try {
			expect(isReadFanoutCaptureActive()).toBe(false);
			expect(beginReadFanoutSpan("logical")).toBeUndefined();
			recordReadFanoutSql(undefined, "secret SQL");
			expect(timeReadFanoutSync(undefined, "compileSync", () => 42)).toBe(42);
			const failure = new Error("business failure");
			expect(() =>
				timeReadFanoutSync(undefined, "mapSync", () => {
					throw failure;
				}),
			).toThrow(failure);
			expect(clock).not.toHaveBeenCalled();
		} finally {
			clock.mockRestore();
		}
	});

	test("duration validation, conflict, capture matching and single-consumption lifecycle", () => {
		for (const duration of [0, -1, 1.5, 60_001, Number.NaN, Infinity])
			expect(() => startReadFanoutCapture(duration)).toThrow();
		const capture = startReadFanoutCapture();
		expect(capture.durationMs).toBe(30_000);
		expect(() => startReadFanoutCapture()).toThrow("already active");
		expect(() => stopReadFanoutCapture("wrong-capture")).toThrow("not found");
		read();
		const report = stopReadFanoutCapture(capture.captureId);
		expect(report).toMatchObject({
			captureId: capture.captureId,
			schemaVersion: 1,
			endReason: "stop",
			totals: { logicalReads: 1, logicalCompleted: 1, logicalUnfinished: 0 },
		});
		expect(() => stopReadFanoutCapture(capture.captureId)).toThrow("not found");
		expect(startReadFanoutCapture(60_000).durationMs).toBe(60_000);
	});

	test("module reevaluation shares the process window and retained report", async () => {
		const capture = startReadFanoutCapture();
		const reloadUrl = new URL("./read-fanout-diagnostics.ts?fanout-hot-reload", import.meta.url)
			.href;
		const reloaded: typeof import("./read-fanout-diagnostics") = await import(reloadUrl);
		expect(() => reloaded.startReadFanoutCapture()).toThrow("already active");
		read();
		expect(reloaded.stopReadFanoutCapture(capture.captureId).totals.logicalReads).toBe(1);
		expect(isReadFanoutCaptureActive()).toBe(false);
	});

	test("auto-end keeps one report for 60 seconds; expiry and new capture clear it", () => {
		const timers: { callback: () => void; ms: number | undefined }[] = [];
		const original = globalThis.setTimeout;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
			ms?: number,
		) => {
			timers.push({ callback, ms });
			const handle = original(() => {}, 60_000);
			handle.unref();
			return handle;
		}) as typeof setTimeout);
		try {
			const first = startReadFanoutCapture(10);
			timers[0].callback();
			expect(isReadFanoutCaptureActive()).toBe(false);
			expect(timers[1].ms).toBe(60_000);
			expect(stopReadFanoutCapture(first.captureId).endReason).toBe("timeout");
			const second = startReadFanoutCapture(10);
			timers[2].callback();
			timers[3].callback();
			expect(() => stopReadFanoutCapture(second.captureId)).toThrow("not found");
			const third = startReadFanoutCapture(10);
			timers[4].callback();
			startReadFanoutCapture();
			expect(() => stopReadFanoutCapture(third.captureId)).toThrow("not found");
		} finally {
			timer.mockRestore();
		}
	});

	test("HTTP authentication work uses registered route template; unknown and control reads are private", async () => {
		const app = new Hono();
		app.use("/api/*", readFanoutHttpMiddleware);
		app.use("/api/*", async (_c, next) => {
			read();
			await next();
		});
		app.get("/api/items/:id", (c) => {
			read();
			return c.json({ ok: true });
		});
		app.post("/api/admin/diagnostics/read-fanout/start", (c) => {
			read();
			return c.json({ ok: true });
		});
		app.post("/api/admin/diagnostics/read-fanout/stop", (c) => {
			read();
			return c.json({ ok: true });
		});
		const capture = startReadFanoutCapture();
		await app.request("http://local/api/items/private-user-id?token=private-token");
		await app.request("http://local/api/unknown-secret?query=secret-query");
		await app.request("http://local/api/admin/diagnostics/read-fanout/start", { method: "POST" });
		await app.request("http://local/api/admin/diagnostics/read-fanout/stop", { method: "POST" });
		const report = stopReadFanoutCapture(capture.captureId);
		expect(report.totals.logicalReads).toBe(3);
		expect(
			report.sources.find((row) => row.source === "HTTP GET /api/items/:id")?.counts.logicalReads,
		).toBe(2);
		expect(
			report.sources.find((row) => row.source === "HTTP GET unknown")?.counts.logicalReads,
		).toBe(1);
		for (const secret of ["private-user-id", "private-token", "unknown-secret", "secret-query"])
			expect(JSON.stringify(report)).not.toContain(secret);
	});

	test("WS classification uses each connection protocol's recognized message allowlist", () => {
		const capture = startReadFanoutCapture();
		for (const [channel, type] of [
			["narrator", "hello"],
			["device", "hello"],
			["external-narrator", "send_message"],
			["terminal", "rename"],
			["vnet", "relay_packet"],
			["narrator", "reasoning_translation_visibility"],
		])
			runReadFanoutWebSocketScope(channel, type, read);
		const report = stopReadFanoutCapture(capture.captureId);
		for (const name of [
			"WS narrator unknown",
			"WS device hello",
			"WS external-narrator send_message",
			"WS terminal rename",
			"WS vnet relay_packet",
			"WS narrator reasoning_translation_visibility",
		])
			expect(report.sources.find((row) => row.source === name)?.counts.logicalReads).toBe(1);
	});

	test("concurrent scopes, post-response work and background work stay isolated", async () => {
		const capture = startReadFanoutCapture();
		const gate = deferred();
		let detached!: Promise<void>;
		await Promise.all([
			runReadFanoutWebSocketScope("narrator", "subscribe", async () => {
				read();
				detached = gate.promise.then(read);
				await Promise.resolve();
				read();
			}),
			runReadFanoutWebSocketScope("narrator", "unsubscribe", async () => {
				read();
				await Promise.resolve();
				read();
				read();
			}),
		]);
		gate.resolve();
		await detached;
		read();
		const report = stopReadFanoutCapture(capture.captureId);
		expect(
			report.sources.find((row) => row.source === "WS narrator subscribe")?.counts.logicalReads,
		).toBe(2);
		expect(
			report.sources.find((row) => row.source === "WS narrator unsubscribe")?.counts.logicalReads,
		).toBe(3);
		expect(report.sources.find((row) => row.source === "detached")?.counts.logicalReads).toBe(1);
		expect(
			report.sources.find((row) => row.source === "background_or_unattributed")?.counts
				.logicalReads,
		).toBe(1);
		expect(report.scopes.map((row) => row.logicalReads).sort()).toEqual([2, 3]);
		expect(report.totals.scopesUnfinished).toBe(0);
	});

	test("real async work controls WS scope completion, not a synchronous message wrapper", async () => {
		const capture = startReadFanoutCapture();
		const gate = deferred();
		let tracked!: Promise<void>;
		function message() {
			tracked = runReadFanoutWebSocketScope("narrator", "subscribe", async () => {
				await gate.promise;
				read();
			});
		}
		message();
		expect(tracked).toBeInstanceOf(Promise);
		gate.resolve();
		await tracked;
		const report = stopReadFanoutCapture(capture.captureId);
		expect(
			report.sources.find((row) => row.source === "WS narrator subscribe")?.counts.logicalReads,
		).toBe(1);
		expect(report.sources.find((row) => row.source === "detached")).toBeUndefined();
	});

	test("old spans never mutate stopped reports or the next capture; old scopes label new work", async () => {
		const first = startReadFanoutCapture();
		const gate = deferred();
		let oldSpan = beginReadFanoutSpan("pool");
		postReadFanoutTask(oldSpan);
		const oldScope = runReadFanoutWebSocketScope("narrator", "subscribe", async () => {
			await gate.promise;
			read();
		});
		const report = stopReadFanoutCapture(first.captureId);
		expect(report.totals).toMatchObject({
			poolUnfinished: 1,
			dispatchedUnfinished: 1,
			scopesUnfinished: 1,
		});
		const snapshot = JSON.stringify(report);
		const next = startReadFanoutCapture();
		receiveReadFanoutTask(oldSpan, "result", 17);
		finishReadFanoutSpan(oldSpan);
		oldSpan = undefined;
		receiveReadFanoutTask(undefined, "error");
		gate.resolve();
		await oldScope;
		const nextReport = stopReadFanoutCapture(next.captureId);
		expect(nextReport.totals).toMatchObject({
			poolEntries: 0,
			dispatched: 0,
			workerResults: 0,
			preWindowResponses: 1,
			logicalReads: 1,
		});
		expect(nextReport.sources.find((row) => row.source === "pre_window")?.counts.logicalReads).toBe(
			1,
		);
		expect(JSON.stringify(report)).toBe(snapshot);
	});

	test("SQL HMAC is exact and per-window; oversized SQL and arbitrary WS types never leak", () => {
		const first = startReadFanoutCapture();
		for (const sql of [
			"SELECT 'private-token'",
			"SELECT 'private-token'",
			"SELECT  'private-token'",
			"private-huge-sql".repeat(10_000),
		]) {
			const span = beginReadFanoutSpan("pool");
			recordReadFanoutSql(span, sql);
			finishReadFanoutSpan(span);
		}
		runReadFanoutWebSocketScope("secret-channel", "private-type", read);
		const one = stopReadFanoutCapture(first.captureId);
		const repeated = one.templates.find((row) => row.counts.poolEntries === 2);
		expect(repeated?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(one.overflow.oversizedSql).toBe(1);
		for (const secret of ["private-token", "private-huge-sql", "secret-channel", "private-type"])
			expect(JSON.stringify(one)).not.toContain(secret);
		const second = startReadFanoutCapture();
		const span = beginReadFanoutSpan("pool");
		recordReadFanoutSql(span, "SELECT 'private-token'");
		const two = stopReadFanoutCapture(second.captureId);
		expect(two.templates.find((row) => row.counts.poolEntries === 1)?.fingerprint).not.toBe(
			repeated?.fingerprint,
		);
	});

	test("bounded aggregation reports scope/source/template overflow without dropping total counts", async () => {
		const app = new Hono();
		app.use("/api/*", readFanoutHttpMiddleware);
		for (let i = 0; i < 140; i++)
			app.get(`/api/registered-${i}`, (c) => {
				read();
				return c.text("ok");
			});
		const capture = startReadFanoutCapture();
		for (let i = 0; i < 1100; i++) await app.request(`http://local/api/registered-${i % 140}`);
		for (let i = 0; i < 550; i++) {
			const span = beginReadFanoutSpan("pool");
			recordReadFanoutSql(span, `SELECT ${i}`);
			finishReadFanoutSpan(span);
		}
		const report = stopReadFanoutCapture(capture.captureId);
		expect(report.sources.length).toBeLessThanOrEqual(128);
		expect(report.templates.length).toBeLessThanOrEqual(512);
		expect(report.scopes.length).toBe(1024);
		expect(report.overflow.scopes).toBe(76);
		expect(report.overflow.sources).toBeGreaterThan(0);
		expect(report.overflow.templates).toBe(39);
		expect(report.totals).toMatchObject({
			logicalReads: 1100,
			poolEntries: 550,
			scopesStarted: 1100,
			scopesCompleted: 1100,
		});
		expect(report.timings.compileSync.buckets).toHaveLength(report.histogramUpperBoundsMs.length);
	});

	test("successful duration and missing error duration remain separate; observer failures preserve work", () => {
		const capture = startReadFanoutCapture();
		const ok = beginReadFanoutSpan("pool");
		postReadFanoutTask(ok);
		receiveReadFanoutTask(ok, "result", 13);
		finishReadFanoutSpan(ok);
		const failed = beginReadFanoutSpan("pool");
		postReadFanoutTask(failed);
		receiveReadFanoutTask(failed, "error");
		finishReadFanoutSpan(failed, { code: "DB_READ_FAILED" });
		const span = beginReadFanoutSpan("logical");
		const clock = spyOn(performance, "now").mockImplementation(() => {
			throw new Error("broken observer clock");
		});
		try {
			expect(timeReadFanoutSync(span, "compileSync", () => 7)).toBe(7);
		} finally {
			clock.mockRestore();
		}
		countReadFanout(span, "inlineReads");
		finishReadFanoutSpan(span);
		const report = stopReadFanoutCapture(capture.captureId);
		expect(report.totals).toMatchObject({
			workerResults: 1,
			workerErrors: 1,
			workerDurationMissing: 1,
			poolCompleted: 1,
			poolFailed: 1,
		});
		expect(report.timings.workerWall).toMatchObject({ count: 1, sumMs: 13 });
		expect(report.overflow.observationErrors).toBeGreaterThan(0);
	});
});
