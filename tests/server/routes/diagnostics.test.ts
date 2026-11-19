import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { Profiler, Session } from "node:inspector";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createServerRequestDispatcher } from "../../../server/http-dispatcher";
import { createServerRequestLifecycle } from "../../../server/http-request-lifecycle";
import * as auth from "../../../server/lib/auth";
import * as oauthProvider from "../../../server/lib/oauth-provider";
import { createStartupReadinessGate } from "../../../server/lib/startup-readiness";
import { authSessionStore } from "../../../server/services/auth/store";
import { CpuProfiler, cpuProfiler } from "../../../server/services/cpu-profiler";

const profile: Profiler.Profile = { nodes: [], startTime: 1, endTime: 2, samples: [] };
type App = typeof import("../../../server/app").app;

function profileRequest(init: RequestInit = {}, token: string | null = "nfs_admin") {
	const headers = new Headers(init.headers);
	if (token) headers.set("Authorization", `Bearer ${token}`);
	return new Request("http://localhost/api/diagnostics/cpu-profile", {
		...init,
		method: "POST",
		headers,
	});
}

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
	let app: App;
	beforeAll(async () => {
		const previous = process.env.NARRAFORK_ENABLE_HTTP_CPU_PROFILE;
		process.env.NARRAFORK_ENABLE_HTTP_CPU_PROFILE = "1";
		try {
			({ app } = await import("../../../server/app"));
		} finally {
			if (previous === undefined) delete process.env.NARRAFORK_ENABLE_HTTP_CPU_PROFILE;
			else process.env.NARRAFORK_ENABLE_HTTP_CPU_PROFILE = previous;
		}
	});
	beforeEach(() => {
		spyOn(auth, "verifyToken").mockImplementation(async (token) => {
			const now = Math.floor(Date.now() / 1000);
			const role = token === "nfs_admin" ? "admin" : "user";
			return { sub: role, role, sid: `session-${role}`, iat: now, exp: now + 7 * 24 * 3600 };
		});
	});

	test("is not mounted by default", async () => {
		const home = mkdtempSync(join(tmpdir(), "cpu-profile-default-off-"));
		try {
			const moduleUrl = new URL("../../../server/app.ts", import.meta.url).href;
			// The app registers routes only once per process; check its default in a fresh one.
			const code = `
				import assert from "node:assert/strict";
				delete process.env.NARRAFORK_ENABLE_HTTP_CPU_PROFILE;
				const { app } = await import(${JSON.stringify(moduleUrl)});
				assert.equal(app.routes.some(({ method, path }) =>
					method === "POST" && path === "/api/diagnostics/cpu-profile"), false);
				process.exit(0);
			`;
			await promisify(execFile)(process.execPath, ["-e", code], {
				timeout: 10_000,
				env: { ...process.env, NARRAFORK_HOME: home, BUN_OPTIONS: "" },
			});
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}, 15_000);

	test("requires an admin session when enabled", async () => {
		const capture = spyOn(cpuProfiler, "capture").mockResolvedValue(profile);
		spyOn(oauthProvider, "validateAccessToken").mockResolvedValue({
			tokenId: "test-token",
			userId: "admin",
			clientId: "test-client",
			oauthClientId: "test-client-id",
			grantId: null,
			refreshFamilyId: null,
			expiresAt: "2099-01-01T00:00:00.000Z",
			scopes: [],
		});
		spyOn(authSessionStore, "findSessionState").mockResolvedValue({
			id: "admin",
			role: "admin",
			tokenVersion: 0,
		});
		expect((await app.fetch(profileRequest({}, null))).status).toBe(401);
		const oauth = await app.fetch(profileRequest({}, "oauth-admin"));
		expect(oauth.status).toBe(401);
		expect(await oauth.json()).toMatchObject({ code: "SESSION_REQUIRED" });
		expect((await app.fetch(profileRequest({}, "nfs_user"))).status).toBe(403);
		expect(capture).not.toHaveBeenCalled();
	});

	test("returns a JSON attachment with the default duration for an admin session", async () => {
		const capture = spyOn(cpuProfiler, "capture").mockResolvedValue(profile);
		for (const body of [undefined, "{}"]) {
			const response = await app.fetch(profileRequest({ body }));
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

	test("allows 1 KiB and rejects larger bodies with or without Content-Length", async () => {
		const capture = spyOn(cpuProfiler, "capture").mockResolvedValue(profile);
		const body = "{}".padEnd(1024);
		expect((await app.fetch(profileRequest({ body }))).status).toBe(200);
		const declared = profileRequest({ body: `${body} `, headers: { "Content-Length": "1025" } });
		expect((await app.fetch(declared)).status).toBe(413);
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(body));
				controller.enqueue(encoder.encode(" "));
				controller.close();
			},
		});
		expect((await app.fetch(profileRequest({ body: stream }))).status).toBe(413);
		expect(capture).toHaveBeenCalledTimes(1);
	});

	test("rejects malformed bodies and durations above 30 seconds", async () => {
		for (const body of [
			"{",
			"null",
			"[]",
			'{"durationMs":"1"}',
			...[0, -1, 1.5, 30_001].map((durationMs) => JSON.stringify({ durationMs })),
		]) {
			const response = await app.fetch(profileRequest({ body }));
			expect(response.status).toBe(400);
			expect(response.headers.get("cache-control")).toBe("no-store");
		}
	});

	test("allows 30 seconds, keeps the standard HTTP timeout and stops on request cancellation", async () => {
		const session = new FakeSession();
		const profiler = new CpuProfiler(() => session.asSession());
		const capture = spyOn(cpuProfiler, "capture").mockImplementation((duration, signal) =>
			profiler.capture(duration, signal),
		);
		const readiness = createStartupReadinessGate();
		readiness.settle({ ok: true });
		const dispatch = createServerRequestDispatcher({
			app,
			lifecycle: createServerRequestLifecycle(),
			startupReadiness: readiness,
			activeDatabaseBackend: "sqlite",
		});
		const server = { requestIP: () => null, upgrade: () => false, timeout: mock(() => {}) };
		const controller = new AbortController();
		const pending = dispatch(
			profileRequest({ body: '{"durationMs":30000}', signal: controller.signal }),
			server,
		);
		await session.started.promise;
		controller.abort();
		expect((await pending)?.status).toBe(499);
		expect(capture).toHaveBeenCalledWith(30_000, expect.any(AbortSignal));
		expect(server.timeout).not.toHaveBeenCalled();
		expect(session.stopCount()).toBe(1);
		expect(session.disconnect).toHaveBeenCalledTimes(1);
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
