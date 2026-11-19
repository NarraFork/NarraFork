import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { Profiler, Session } from "node:inspector";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import { buildAppErrorResponse } from "../../../server/lib/app-error-response";
import { diagnosticsRoutes } from "../../../server/routes/diagnostics";
import { CpuProfiler, cpuProfiler } from "../../../server/services/cpu-profiler";

const profile: Profiler.Profile = { nodes: [], startTime: 1, endTime: 2, samples: [] };
const app = new Hono().route("/api/diagnostics", diagnosticsRoutes);
app.use("/api/*", async (c) => c.json({ error: "Session required" }, 401));
app.onError((error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: error.message }, 500));

afterEach(() => mock.restore());

class FakeSession {
	calls: { method: string; params: object }[] = [];
	connect = mock(() => {});
	disconnect = mock(() => {});
	failMethod?: string;
	pendingMethod?: string;
	started = Promise.withResolvers<void>();
	pending = Promise.withResolvers<void>();

	post(method: string, params: object, callback: (error: Error | null, result?: unknown) => void) {
		this.calls.push({ method, params });
		if (method === this.pendingMethod) {
			this.pending.resolve();
			return;
		}
		if (method === this.failMethod) {
			callback(new Error("Cannot change sampling interval while profiler is running"));
			return;
		}
		callback(null, method === "Profiler.stop" ? { profile } : {});
		if (method === "Profiler.start") this.started.resolve();
	}

	asSession() {
		return this as unknown as Session;
	}

	stopCount() {
		return this.calls.filter(({ method }) => method === "Profiler.stop").length;
	}
}

describe("POST /api/diagnostics/cpu-profile", () => {
	test("is mounted before authentication and returns a JSON attachment with the default duration", async () => {
		const capture = spyOn(cpuProfiler, "capture").mockResolvedValue(profile);
		const source = readFileSync(new URL("../../../server/app.ts", import.meta.url), "utf8");
		const mount = source.indexOf('app.route("/api/diagnostics", diagnosticsRoutes)');
		expect(mount).toBeGreaterThan(0);
		expect(mount).toBeLessThan(source.indexOf('app.use("/api/*", requireSessionAuth)'));
		for (const body of [undefined, "{}"]) {
			const response = await app.request("/api/diagnostics/cpu-profile", { method: "POST", body });
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(response.headers.get("content-type")).toContain("application/json");
			expect(response.headers.get("content-disposition")).toMatch(
				/^attachment; filename="cpu-\d+\.cpuprofile"$/,
			);
			expect(await response.json()).toEqual(profile);
			expect(capture).toHaveBeenLastCalledWith(15_000, expect.any(AbortSignal));
		}
	});

	test("forwards a custom duration and request cancellation signal", async () => {
		const capture = spyOn(cpuProfiler, "capture").mockResolvedValue(profile);
		const controller = new AbortController();
		const response = await app.request("/api/diagnostics/cpu-profile", {
			method: "POST",
			body: '{"durationMs":2147483647}',
			signal: controller.signal,
		});
		expect(response.status).toBe(200);
		const [duration, signal] = capture.mock.calls[0];
		expect(duration).toBe(2_147_483_647);
		controller.abort();
		expect(signal?.aborted).toBe(true);
	});

	test("rejects malformed bodies and durations outside the timer range", async () => {
		for (const body of [
			"{",
			"null",
			"[]",
			'{"durationMs":"1"}',
			...[0, -1, 1.5, 2_147_483_648].map((durationMs) => JSON.stringify({ durationMs })),
		]) {
			const response = await app.request("/api/diagnostics/cpu-profile", { method: "POST", body });
			expect(response.status).toBe(400);
			expect(response.headers.get("cache-control")).toBe("no-store");
		}
	});
});

describe("CPU profiler ownership", () => {
	test.skipIf(Bun.version !== "1.4.3")(
		"rejects the verified startup profiler conflict before creating a session",
		async () => {
			const previousOptions = process.env.BUN_OPTIONS;
			const previousArgs = process.execArgv;
			try {
				for (const source of ["execArgv", "BUN_OPTIONS"]) {
					process.execArgv = source === "execArgv" ? ["--cpu-prof"] : [];
					process.env.BUN_OPTIONS =
						source === "BUN_OPTIONS" ? "--cpu-prof --cpu-prof-dir=/tmp" : "";
					const session = new FakeSession();
					const createSession = mock(() => session.asSession());
					const profiler = new CpuProfiler(createSession);
					await expect(profiler.capture(1)).rejects.toMatchObject({
						statusCode: 503,
						code: "CPU_PROFILE_CONFLICT",
						message: expect.stringContaining("NARRAFORK_CPU_PROFILE=0"),
					});
					expect(createSession).not.toHaveBeenCalled();
					expect(session.connect).not.toHaveBeenCalled();
					await profiler.shutdown();
					expect(session.disconnect).not.toHaveBeenCalled();
				}
			} finally {
				process.execArgv = previousArgs;
				if (previousOptions === undefined) delete process.env.BUN_OPTIONS;
				else process.env.BUN_OPTIONS = previousOptions;
			}
		},
	);

	test("profiler filename and directory options do not enable startup recording", async () => {
		const previousOptions = process.env.BUN_OPTIONS;
		const previousArgs = process.execArgv;
		try {
			process.execArgv = ["--cpu-prof-name=recording.cpuprofile"];
			process.env.BUN_OPTIONS = '--cpu-prof-dir="/tmp/recordings --cpu-prof data"';
			const session = new FakeSession();
			const profiler = new CpuProfiler(() => session.asSession());
			expect(await profiler.capture(1)).toEqual(profile);
			expect(session.connect).toHaveBeenCalledTimes(1);
		} finally {
			process.execArgv = previousArgs;
			if (previousOptions === undefined) delete process.env.BUN_OPTIONS;
			else process.env.BUN_OPTIONS = previousOptions;
		}
	});

	test("uses 10ms samples and releases its session and slot after success", async () => {
		const session = new FakeSession();
		const profiler = new CpuProfiler(() => session.asSession());
		expect(await profiler.capture(1)).toEqual(profile);
		expect(session.calls.map(({ method }) => method)).toEqual([
			"Profiler.enable",
			"Profiler.setSamplingInterval",
			"Profiler.start",
			"Profiler.stop",
		]);
		expect(session.calls[1].params).toEqual({ interval: 10_000 });
		expect(session.disconnect).toHaveBeenCalledTimes(1);
		await profiler.capture(1);
		expect(session.disconnect).toHaveBeenCalledTimes(2);
	});

	test("returns busy while active and cancels only its own recording", async () => {
		const session = new FakeSession();
		const profiler = new CpuProfiler(() => session.asSession());
		const controller = new AbortController();
		const first = profiler.capture(15_000, controller.signal).catch((error) => error);
		await session.started.promise;
		await expect(profiler.capture(1)).rejects.toMatchObject({ statusCode: 409 });
		controller.abort();
		expect(await first).toMatchObject({ name: "AbortError" });
		expect(session.stopCount()).toBe(1);
		expect(session.disconnect).toHaveBeenCalledTimes(1);
		await profiler.capture(1);
	});

	test.each([
		"Profiler.enable",
		"Profiler.start",
		"Profiler.stop",
	])("cancels pending native %s without waiting for its callback", async (method) => {
		const session = new FakeSession();
		session.pendingMethod = method;
		const profiler = new CpuProfiler(() => session.asSession());
		const controller = new AbortController();
		const result = profiler.capture(1, controller.signal).catch((error) => error);
		await session.pending.promise;
		controller.abort();
		expect(await result).toMatchObject({ name: "AbortError" });
		expect(session.stopCount()).toBe(method === "Profiler.stop" ? 1 : 0);
		expect(session.disconnect).toHaveBeenCalledTimes(1);
		session.pendingMethod = undefined;
		await profiler.capture(1);
	});

	test("releases native command failures and only stops a recording it started", async () => {
		const session = new FakeSession();
		session.failMethod = "Profiler.setSamplingInterval";
		const profiler = new CpuProfiler(() => session.asSession());
		await expect(profiler.capture(1)).rejects.toMatchObject({
			statusCode: 503,
			code: "CPU_PROFILER_UNAVAILABLE",
			message: expect.stringContaining("Cannot change sampling interval while profiler is running"),
		});
		expect(session.stopCount()).toBe(0);
		expect(session.disconnect).toHaveBeenCalledTimes(1);
		session.failMethod = "Profiler.stop";
		await expect(profiler.capture(1)).rejects.toMatchObject({ statusCode: 503 });
		expect(session.stopCount()).toBe(1);
		expect(session.disconnect).toHaveBeenCalledTimes(2);
		session.failMethod = undefined;
		await profiler.capture(1);
	});

	test("shutdown stops its recording and closes admission before HTTP drain", async () => {
		const session = new FakeSession();
		const profiler = new CpuProfiler(() => session.asSession());
		const result = profiler.capture(15_000).catch((error) => error);
		await session.started.promise;
		await profiler.shutdown();
		expect(await result).toMatchObject({ code: "CPU_PROFILER_SHUTDOWN" });
		expect(session.stopCount()).toBe(1);
		expect(session.disconnect).toHaveBeenCalledTimes(1);
		await expect(profiler.capture(1)).rejects.toMatchObject({ code: "CPU_PROFILER_SHUTDOWN" });
	});
});

test("real Bun profiling records hot-function samples and preserves an existing CLI profiler", async () => {
	const exec = promisify(execFile);
	const moduleUrl = new URL("../../../server/services/cpu-profiler.ts", import.meta.url).href;
	for (const cli of [false, true]) {
		const directory = mkdtempSync(join(tmpdir(), "cpu-profile-native-"));
		try {
			const code = `
				import { cpuProfiler } from ${JSON.stringify(moduleUrl)};
				const cli = ${cli};
				function afterOnlineAttempt() {
					let value = 1;
					const end = performance.now() + 150;
					while (performance.now() < end) value = Math.sqrt(value + Math.random());
					return value;
				}
				let result;
				if (cli) {
					try { await cpuProfiler.capture(1); throw new Error("Expected native conflict"); }
					catch (error) {
						if (error.code !== "CPU_PROFILE_CONFLICT") throw error;
						result = { code: error.code, message: error.message };
					}
					afterOnlineAttempt();
				} else {
					const recording = cpuProfiler.capture(250);
					await Bun.sleep(30);
					afterOnlineAttempt();
					const profile = await recording;
					const ids = profile.nodes.filter(n => n.callFrame.functionName === "afterOnlineAttempt").map(n => n.id);
					result = { samples: profile.samples.length, hotSample: profile.samples.some(id => ids.includes(id)) };
				}
				await cpuProfiler.shutdown();
				console.log(JSON.stringify({ ...result, alive: await Promise.resolve(42), version: Bun.version }));
			`;
			const { stdout } = await exec(process.execPath, ["-e", code], {
				cwd: directory,
				timeout: 5_000,
				maxBuffer: 64 * 1024,
				env: {
					...process.env,
					HOME: directory,
					NARRAFORK_HOME: directory,
					TMPDIR: directory,
					TMP: directory,
					TEMP: directory,
					ALLOW_MULTIPLE: "1",
					NARRAFORK_ALLOW_MULTIPLE: "1",
					BUN_OPTIONS: cli ? `--cpu-prof --cpu-prof-dir=${directory}` : "",
				},
			});
			const result = JSON.parse(stdout);
			expect(result.alive).toBe(42);
			expect(result.version).toBe(Bun.version);
			if (cli) {
				expect(result.code).toBe("CPU_PROFILE_CONFLICT");
				expect(result.message).toContain("Bun 1.4.3");
				expect(result.message).toContain("NARRAFORK_CPU_PROFILE=0");
				const file = readdirSync(directory).find((name) => name.endsWith(".cpuprofile"));
				if (!file) throw new Error("CLI profiler output missing");
				const saved: Profiler.Profile = JSON.parse(readFileSync(join(directory, file), "utf8"));
				const ids = saved.nodes
					.filter((n) => n.callFrame.functionName === "afterOnlineAttempt")
					.map((n) => n.id);
				expect(saved.samples?.some((id) => ids.includes(id))).toBe(true);
			} else {
				expect(result.samples).toBeGreaterThan(0);
				expect(result.hotSample).toBe(true);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
}, 15_000);
