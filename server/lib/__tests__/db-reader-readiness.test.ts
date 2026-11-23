import { Database } from "bun:sqlite";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	declaredBodyExceeds,
	isStorageImportUpload,
	MAX_ORDINARY_BODY_BYTES,
} from "../../../shared/storage-transfer";
import { isStreamingAttachmentUpload } from "../../../shared/text-file-types";
import { createServerRequestLifecycle } from "../../http-request-lifecycle";
import { toDatabaseReadUnavailablePayload, toErrorPayload } from "../app-error-response";
import {
	createDatabaseReaderReadiness,
	type DatabaseReaderReadiness,
	databaseReadersAvailable,
	databaseReaderUnavailableResponse,
	requiresDatabaseReaders,
} from "../db-reader-readiness";
import { createDatabaseReaderStartup } from "../db-reader-startup";
import { DbReadError } from "../db-worker/errors";
import {
	assertDbReadersReady,
	DbReadTaskOverloadedError,
	drainDbWorkerPool,
	getDbWorkerAvailability,
	resumeDbWorkerPool,
	setDbWorkerSpecifiersForTest,
	WorkersUnavailableError,
} from "../db-worker/pool";
import { AppError, catalogError } from "../errors";
import { logger } from "../logger";
import {
	beginGracefulRestartSession,
	cancelGracefulRestartSession,
	handleGracefullyShutdownRequest,
	registerGracefulShutdownHandler,
	registerRuntimeAddressGetter,
} from "../server-restart";
import {
	buildHealthPayload,
	createStartupReadinessGate,
	type StartupReadinessGate,
} from "../startup-readiness";

function gate(backend: "sqlite" | "postgres" = "sqlite") {
	const probe = Promise.withResolvers<void>();
	let available = true;
	const runProbe = mock(async () => probe.promise);
	const readiness = createDatabaseReaderReadiness({
		backend,
		probe: runProbe,
		availability: () => ({ available }),
	});
	return {
		readiness,
		probe,
		runProbe,
		disable() {
			available = false;
		},
		enable() {
			available = true;
		},
	};
}

const source = readFileSync(new URL("../../main.ts", import.meta.url), "utf8");
const dispatcherSource = readFileSync(new URL("../../http-dispatcher.ts", import.meta.url), "utf8");
const transpiler = new Bun.Transpiler({ loader: "ts" });
function entry(
	readiness: DatabaseReaderReadiness,
	backend = "sqlite",
	recoveryFailed = false,
	pendingStartup?: StartupReadinessGate,
) {
	const startupReadiness = pendingStartup ?? createStartupReadinessGate();
	if (!pendingStartup) {
		if (recoveryFailed) startupReadiness.markFailed("provider needs repair");
		else startupReadiness.markReady();
		startupReadiness.settle(
			recoveryFailed ? { ok: false, error: "provider needs repair" } : { ok: true },
		);
	}
	let businessCalls = 0;
	let upgrades = 0;
	const readUser = mock(async (_query: unknown, _options: unknown) => ({
		id: "fixture-user",
		username: "fixture",
		avatarColor: null,
		avatarImageId: null,
		role: "user",
	}));
	const verifySession = mock(async (token: string) => {
		expect(token).toBe("fixture-session");
		return { sub: "fixture-user", sid: "fixture-session", exp: 4_000_000_000 };
	});
	const dependencies = {
		AppError,
		catalogError,
		toDatabaseReadUnavailablePayload,
		toErrorPayload,
		databaseReaderReadiness: readiness,
		startupReadiness,
		activeDatabaseBackend: backend,
		requiresDatabaseReaders,
		databaseReadersAvailable,
		databaseReaderUnavailableResponse,
		buildHealthPayload,
		declaredBodyExceeds,
		isStorageImportUpload,
		isStreamingAttachmentUpload,
		MAX_ORDINARY_BODY_BYTES,
		narratorWebSocketBackendRefusal: () => null,
		lifecycle: createServerRequestLifecycle(),
		trustedRemoteRequestContext: () => null,
		settings: { auth: { trustedProxyCidrs: [] } },
		resolveClientIp: () => "127.0.0.1",
		isTrustedProxyAddress: () => false,
		resolveWSData: (url: URL) => ({
			channel: url.pathname === "/ws/device" ? "device" : "narrator",
		}),
		verifyToken: verifySession,
		readQuery: readUser,
		db: { query: { users: { findFirst: () => ({ source: "fixture-user" }) } } },
		users: { id: "fixture-user-id" },
		eq: (column: unknown, value: unknown) => ({ column, value }),
		app: {
			fetch: mock(async (request: Request) => {
				const path = new URL(request.url).pathname;
				if (path === "/api/health") return Response.json({ status: "ok", version: "test" });
				if (path === "/api/gracefully_shutdown") {
					const body = (await request.json().catch(() => ({}))) as { token?: string };
					const result = await handleGracefullyShutdownRequest({ token: body.token ?? "" });
					return Response.json(result.body, { status: result.status });
				}
				if (requiresDatabaseReaders(path, request.method)) businessCalls += 1;
				return new Response("served");
			}),
		},
	};
	const start = dispatcherSource.indexOf("function isCredentialFailure(");
	if (start < 0 || !dispatcherSource.includes("export function createServerRequestDispatcher("))
		throw new Error("Cannot locate production request dispatcher and credential check");
	const compiled = transpiler.transformSync(
		dispatcherSource.slice(start).replace(/^export /gm, ""),
	);
	const fetchEntry = new Function(
		...Object.keys(dependencies),
		`${compiled}\nreturn createServerRequestDispatcher({
			app, lifecycle, startupReadiness, activeDatabaseBackend, databaseReaderReadiness
		});`,
	)(...Object.values(dependencies)) as (
		request: Request,
		server: unknown,
	) => Promise<Response | undefined>;
	const server = {
		requestIP: () => ({ address: "127.0.0.1" }),
		upgrade() {
			upgrades += 1;
			return true;
		},
	};
	return {
		lifecycle: dependencies.lifecycle,
		async request(path: string, options?: RequestInit) {
			return fetchEntry(new Request(`http://127.0.0.1${path}`, options), server);
		},
		readUser,
		verifySession,
		fetchHttp: dependencies.app.fetch,
		get businessCalls() {
			return businessCalls;
		},
		get upgrades() {
			return upgrades;
		},
	};
}

function startupEntry(readiness: DatabaseReaderReadiness) {
	const calls: string[] = [];
	const start = source.indexOf("async function initializeDatabaseStartup(): Promise<void> {");
	const end = source.indexOf("// Migrate OAuth authorities first", start);
	if (start < 0 || end < start) throw new Error("Cannot locate production startup admission");
	const dependencies = {
		databaseReaderReadiness: readiness,
		httpLifecycle: { accepting: true },
		activeDatabaseBackend: "sqlite",
		startupShutdownState: {},
		scheduleBackgroundIntegrityCheck: () => calls.push("integrity"),
		startHeartbeat: () => calls.push("heartbeat"),
		initDeviceConnectionService: () => calls.push("devices"),
		initDeviceTransferService: () => calls.push("transfers"),
		logger: { warn: mock(() => {}) },
		importModule: async (path: string) => {
			if (path !== "./services/modeltrace-compat")
				throw new Error(`Unexpected startup import: ${path}`);
			return {
				adoptLegacyModelTraceNarrators: async () => {
					calls.push("modeltrace");
				},
			};
		},
	};
	const body = source.slice(start, end).replace(/\bimport\s*\(/g, "importModule(");
	const compiled = transpiler.transformSync(`${body} }`);
	if (/\bimport\s*\(/.test(compiled)) throw new Error("Startup sandbox contains a native import");
	const initialize = new Function(
		...Object.keys(dependencies),
		`${compiled}\nreturn initializeDatabaseStartup;`,
	)(...Object.values(dependencies)) as () => Promise<void>;
	const startup = createDatabaseReaderStartup({
		readiness,
		initialize,
		onUnavailable: () => {},
		onError: (error) => {
			throw error;
		},
	});
	return { calls, startWork: startup.start, stop: startup.stop, logger: dependencies.logger };
}

test("cancelling recovered startup releases requests waiting on the actual admission barrier", async () => {
	let probes = 0;
	const readiness = createDatabaseReaderReadiness({
		backend: "sqlite",
		probe: async () => {
			if (++probes === 1) throw new Error("injected startup failure");
		},
		retryIntervalMs: 0,
	});
	const gate = createStartupReadinessGate();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const start = source.indexOf("const databaseStartup = createDatabaseReaderStartup(");
	const end = source.indexOf("const databaseStartupPromise = databaseStartup.start();", start);
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	const cancelStart = source.indexOf("function cancelDatabaseStartup(): void {");
	const cancelEnd = source.indexOf("async function initializeDatabaseStartup()", cancelStart);
	expect(cancelStart).toBeGreaterThanOrEqual(0);
	expect(cancelEnd).toBeGreaterThan(cancelStart);
	const compiled = transpiler.transformSync(
		source.slice(cancelStart, cancelEnd) + source.slice(start, end),
	);
	const startup = new Function(
		"createDatabaseReaderStartup",
		"databaseReaderReadiness",
		"initializeDatabaseStartup",
		"startupReadiness",
		"logger",
		`${compiled}\nreturn databaseStartup;`,
	)(
		(options: Parameters<typeof createDatabaseReaderStartup>[0]) =>
			createDatabaseReaderStartup({ ...options, retryIntervalMs: 1 }),
		readiness,
		async () => {
			entered.resolve();
			await release.promise;
		},
		gate,
		{ error() {} },
	) as ReturnType<typeof createDatabaseReaderStartup>;
	const runtime = entry(readiness, "sqlite", false, gate);
	try {
		await startup.start();
		expect((await runtime.request("/api/data"))?.status).toBe(503);
		await entered.promise;
		const response = runtime.request("/api/data");
		await Bun.sleep(1);
		expect(runtime.lifecycle.activeCount).toBe(1);
		startup.stop();
		runtime.lifecycle.stopAccepting();
		runtime.lifecycle.abortAll();
		expect(
			await Promise.race([
				response.then((result) => result?.status),
				Bun.sleep(50).then(() => "timed out"),
			]),
		).toBe(503);
		expect(await gate.barrier).toEqual({ ok: false, error: "SERVER_SHUTTING_DOWN" });
		await runtime.lifecycle.drain();
		expect(runtime.lifecycle.activeCount).toBe(0);
		expect(runtime.businessCalls).toBe(0);
		expect(startup.pending).toBe(true);
	} finally {
		gate.settle({ ok: false, error: "fixture cleanup" });
		startup.stop();
		release.resolve();
		await startup.drain();
	}
});

describe("database reader readiness", () => {
	test("requires a completed probe and propagates the bounded probe options", async () => {
		const controlled = gate();
		expect(controlled.readiness.state).toEqual({ status: "waiting" });
		controlled.probe.resolve();
		expect(await controlled.readiness.wait()).toEqual({ ok: true });
		expect(controlled.readiness.state).toEqual({ status: "ready" });
		expect(controlled.runProbe).toHaveBeenCalledWith({
			signal: expect.any(AbortSignal),
			timeoutMs: 30_000,
		});
	});

	test("allows the first probe to register database identity before the path veto", async () => {
		const pending = Promise.withResolvers<void>();
		let registered = false;
		const databaseAvailability = mock(() => ({ available: registered }));
		const readiness = createDatabaseReaderReadiness({
			backend: "sqlite",
			availability: () => ({ available: true }),
			databaseAvailability,
			probe: async () => {
				await pending.promise;
				registered = true;
			},
		});
		expect(readiness.state).toEqual({ status: "waiting" });
		expect(databaseAvailability).not.toHaveBeenCalled();
		pending.resolve();
		expect(await readiness.wait()).toEqual({ ok: true });
		expect(databaseAvailability).toHaveBeenCalled();
		registered = false;
		expect(readiness.state).toEqual({ status: "failed", code: "DB_READERS_UNAVAILABLE" });
	});

	test("never promotes a failed probe merely because capability remains available", async () => {
		const controlled = gate();
		controlled.probe.reject(new Error("/private/db SELECT secret FROM credentials"));
		expect(await controlled.readiness.wait()).toEqual({
			ok: false,
			code: "DB_READERS_UNAVAILABLE",
		});
		controlled.enable();
		expect(controlled.readiness.state).toEqual({
			status: "failed",
			code: "DB_READERS_UNAVAILABLE",
		});
		expect(JSON.stringify(controlled.readiness.state)).not.toContain("private");
		const response = await entry(controlled.readiness).request("/api/data");
		const body = await response?.json();
		expect(response?.status).toBe(503);
		expect(body).toMatchObject({
			messageCode: "DATABASE_READ_UNAVAILABLE",
			databaseReaders: { status: "failed" },
		});
		expect(JSON.stringify(body)).not.toContain("credentials");
	});

	test("times out and aborts an unresponsive probe without later becoming ready", async () => {
		const pending = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		const readiness = createDatabaseReaderReadiness({
			backend: "sqlite",
			availability: () => ({ available: true }),
			timeoutMs: 2,
			probe: async (options) => {
				signal = options.signal;
				await pending.promise;
			},
		});
		expect(await readiness.wait()).toEqual({ ok: false, code: "DB_READERS_TIMEOUT" });
		expect(signal?.aborted).toBe(true);
		pending.resolve();
		await Promise.resolve();
		expect(readiness.state).toEqual({ status: "failed", code: "DB_READERS_TIMEOUT" });
	});

	for (const setting of ["off", "zero"] as const) {
		test(`fails closed for actual pool configuration ${setting}`, async () => {
			const previousOff = process.env.NARRAFORK_DB_WORKER;
			const previousConcurrency = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
			try {
				if (setting === "off") process.env.NARRAFORK_DB_WORKER = "off";
				else {
					delete process.env.NARRAFORK_DB_WORKER;
					process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "0";
				}
				const probe = mock(async () => {});
				const readiness = createDatabaseReaderReadiness({
					backend: "sqlite",
					probe,
					availability: getDbWorkerAvailability,
				});
				expect(await readiness.wait()).toEqual({ ok: false, code: "DB_READERS_UNAVAILABLE" });
				expect(probe).not.toHaveBeenCalled();
				expect((await entry(readiness).request("/api/data"))?.status).toBe(503);
			} finally {
				if (previousOff === undefined) delete process.env.NARRAFORK_DB_WORKER;
				else process.env.NARRAFORK_DB_WORKER = previousOff;
				if (previousConcurrency === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
				else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = previousConcurrency;
			}
		});
	}

	test("readiness retries a pool disabled by consecutive spawn failures", async () => {
		const directory = mkdtempSync(join(tmpdir(), "nf-reader-spawn-"));
		const path = join(directory, "ready.db");
		const database = new Database(path);
		database.run("CREATE TABLE readiness_fixture (id INTEGER PRIMARY KEY)");
		database.close();
		let now = 0;
		try {
			setDbWorkerSpecifiersForTest([new URL("missing-worker.ts", import.meta.url).href]);
			const readiness = createDatabaseReaderReadiness({
				backend: "sqlite",
				probe: (options) => assertDbReadersReady(path, options),
				availability: getDbWorkerAvailability,
				databaseAvailability: () => getDbWorkerAvailability(path),
				now: () => now,
			});
			expect((await readiness.wait()).ok).toBe(false);
			now += 5_000;
			expect((await readiness.wait()).ok).toBe(false);
			expect(getDbWorkerAvailability().reason).toBe("worker_unavailable");
			setDbWorkerSpecifiersForTest(null);
			now += 5_000;
			expect(await readiness.wait()).toEqual({ ok: true });
			expect(getDbWorkerAvailability(path)).toEqual({ available: true, reason: null });
		} finally {
			setDbWorkerSpecifiersForTest(null);
			await drainDbWorkerPool({ timeoutMs: 30_000 });
			resumeDbWorkerPool();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("real drain and resume re-probe before restoring API health", async () => {
		const previousOff = process.env.NARRAFORK_DB_WORKER;
		const previousConcurrency = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
		const directory = mkdtempSync(join(tmpdir(), "nf-reader-ready-"));
		const path = join(directory, "ready.db");
		const database = new Database(path);
		database.run("CREATE TABLE readiness_fixture (id INTEGER PRIMARY KEY)");
		database.close();
		delete process.env.NARRAFORK_DB_WORKER;
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
		try {
			let now = 0;
			const probe = mock((options: { signal: AbortSignal; timeoutMs: number }) =>
				assertDbReadersReady(path, options),
			);
			const readiness = createDatabaseReaderReadiness({
				backend: "sqlite",
				probe,
				availability: getDbWorkerAvailability,
				databaseAvailability: () => getDbWorkerAvailability(path),
				now: () => now,
			});
			expect(await readiness.wait()).toEqual({ ok: true });
			const runtime = entry(readiness);
			expect((await runtime.request("/api/data"))?.status).toBe(200);
			await drainDbWorkerPool({ timeoutMs: 30_000 });
			resumeDbWorkerPool();
			expect((await runtime.request("/api/health"))?.status).toBe(503);
			expect((await runtime.request("/api/data"))?.status).toBe(503);
			expect(probe).toHaveBeenCalledTimes(1);
			now += 5_000;
			expect(await readiness.wait()).toEqual({ ok: true });
			expect(probe).toHaveBeenCalledTimes(2);
			expect((await runtime.request("/api/health"))?.status).toBe(200);
			expect((await runtime.request("/api/data"))?.status).toBe(200);
		} finally {
			try {
				await drainDbWorkerPool({ timeoutMs: 30_000 });
				resumeDbWorkerPool();
				rmSync(directory, { recursive: true, force: true });
			} finally {
				if (previousOff === undefined) delete process.env.NARRAFORK_DB_WORKER;
				else process.env.NARRAFORK_DB_WORKER = previousOff;
				if (previousConcurrency === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
				else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = previousConcurrency;
			}
		}
	}, 35_000);

	test("PostgreSQL does not invoke SQLite probe or availability", async () => {
		const probe = mock(async () => {
			throw new Error("SQLite probe on PostgreSQL");
		});
		const availability = mock(() => {
			throw new Error("SQLite path on PostgreSQL");
		});
		const readiness = createDatabaseReaderReadiness({ backend: "postgres", probe, availability });
		expect(await readiness.wait()).toEqual({ ok: true });
		expect(readiness.state).toEqual({ status: "not-required" });
		expect(probe).not.toHaveBeenCalled();
		expect(availability).not.toHaveBeenCalled();
		expect((await entry(readiness, "postgres").request("/api/data"))?.status).toBe(200);
	});
});

describe("production reader admission entrypoints", () => {
	test("preserves verified public read-only UI surfaces during reader startup", async () => {
		const controlled = gate();
		const runtime = entry(controlled.readiness);
		try {
			for (const path of [
				"/api/branding",
				"/api/branding/favicon.svg",
				"/api/licenses",
				"/api/licenses/text/test-id",
				"/api/changelog",
			]) {
				expect((await runtime.request(path))?.status).toBe(200);
				expect((await runtime.request(path, { method: "HEAD" }))?.status).toBe(200);
				expect((await runtime.request(path, { method: "POST" }))?.status).toBe(503);
			}
			for (const path of [
				"/api/branding/admin",
				"/api/licenses/admin",
				"/api/changelog/reset",
				"/api/auth/status",
			]) {
				expect((await runtime.request(path))?.status).toBe(503);
			}
			expect(runtime.businessCalls).toBe(0);
		} finally {
			controlled.probe.resolve();
			await controlled.readiness.wait();
		}
	});
	test("returns prompt 503 for pending API and websocket upgrades while static and health stay live", async () => {
		const controlled = gate();
		const runtime = entry(controlled.readiness);
		try {
			expect((await runtime.request("/api/data"))?.status).toBe(503);
			expect((await runtime.request("/ws/device"))?.status).toBe(503);
			expect((await runtime.request("/ws/narrator?token=fixture-session"))?.status).toBe(503);
			expect(runtime.businessCalls).toBe(0);
			expect(runtime.upgrades).toBe(0);
			expect(runtime.readUser).not.toHaveBeenCalled();
			expect((await runtime.request("/assets/main.js"))?.status).toBe(200);
			const health = await runtime.request("/api/health");
			expect(health?.status).toBe(503);
			expect(await health?.json()).toMatchObject({
				status: "not_ready",
				databaseReaders: { status: "waiting" },
			});
		} finally {
			controlled.probe.resolve();
			await controlled.readiness.wait();
		}
		expect((await runtime.request("/api/data"))?.status).toBe(200);
		// Device tokens are verified by the hello frame after upgrade, not by a session JWT.
		expect(await runtime.request("/ws/device")).toBeUndefined();
		expect(runtime.upgrades).toBe(1);
		expect(runtime.readUser).not.toHaveBeenCalled();
		expect((await runtime.request("/ws/narrator"))?.status).toBe(401);
		expect(runtime.readUser).not.toHaveBeenCalled();
		expect(await runtime.request("/ws/narrator?token=fixture-session")).toBeUndefined();
		expect(runtime.upgrades).toBe(2);
		expect(runtime.readUser).toHaveBeenCalledTimes(1);
		expect(runtime.readUser).toHaveBeenCalledWith(
			{ source: "fixture-user" },
			{ executionPolicy: "worker-required", maxRows: 1, signal: expect.any(AbortSignal) },
		);
	});

	test("runtime unavailability vetoes prior readiness without starting another probe", async () => {
		const controlled = gate();
		controlled.probe.resolve();
		await controlled.readiness.wait();
		const runtime = entry(controlled.readiness);
		controlled.disable();
		expect((await runtime.request("/api/data"))?.status).toBe(503);
		const health = await runtime.request("/api/health");
		expect(health?.status).toBe(503);
		expect(await health?.json()).toMatchObject({
			databaseReaders: { status: "failed", code: "DB_READERS_UNAVAILABLE" },
		});
		controlled.enable();
		expect((await runtime.request("/api/data"))?.status).toBe(200);
		expect(controlled.runProbe).toHaveBeenCalledTimes(1);
	});

	test("reader-ready requests retain the recoverable narrator failure contract", async () => {
		const controlled = gate();
		controlled.probe.resolve();
		await controlled.readiness.wait();
		const runtime = entry(controlled.readiness, "sqlite", true);
		expect((await runtime.request("/api/settings"))?.status).toBe(200);
		expect(runtime.businessCalls).toBe(1);
		const health = await runtime.request("/api/health");
		expect(health?.status).toBe(200);
		expect(await health?.json()).toMatchObject({
			status: "failed",
			readiness: "failed",
			recoveryError: "provider needs repair",
			databaseReaders: { status: "ready" },
		});
		controlled.disable();
		expect((await runtime.request("/api/settings"))?.status).toBe(503);
		expect(runtime.businessCalls).toBe(1);
		const unavailable = await runtime.request("/api/health");
		expect(unavailable?.status).toBe(503);
		expect(await unavailable?.json()).toMatchObject({
			status: "not_ready",
			readiness: "failed",
			recoveryError: "provider needs repair",
			databaseReaders: { status: "failed", code: "DB_READERS_UNAVAILABLE" },
		});
	});

	test("reader bypass retains real handoff token authorization", async () => {
		const controlled = gate();
		const runtime = entry(controlled.readiness);
		const handler = mock(async () => ({
			success: true,
			reason: "test",
			pid: process.pid,
			durationMs: 0,
		}));
		registerRuntimeAddressGetter(() => ({ protocol: "http", host: "127.0.0.1", port: 7779 }));
		registerGracefulShutdownHandler(handler);
		const session = beginGracefulRestartSession();
		try {
			expect((await runtime.request("/api/gracefully_shutdown", { method: "POST" }))?.status).toBe(
				403,
			);
			expect(
				(
					await runtime.request("/api/gracefully_shutdown", {
						method: "POST",
						body: JSON.stringify({ token: "invalid" }),
					})
				)?.status,
			).toBe(403);
			expect(handler).not.toHaveBeenCalled();
			cancelGracefulRestartSession();
			expect(
				(
					await runtime.request("/api/gracefully_shutdown", {
						method: "POST",
						body: JSON.stringify({ token: session.token }),
					})
				)?.status,
			).toBe(409);
			expect(handler).not.toHaveBeenCalled();
		} finally {
			cancelGracefulRestartSession();
			registerGracefulShutdownHandler(async () => ({
				success: true,
				reason: "test-default",
				pid: process.pid,
				durationMs: 0,
			}));
			controlled.probe.resolve();
			await controlled.readiness.wait();
		}
	});

	test("startup producers await the actual reader probe and stay stopped on failure", async () => {
		const controlled = gate();
		const startup = startupEntry(controlled.readiness);
		const pending = startup.startWork();
		expect(startup.calls).toEqual([]);
		controlled.probe.resolve();
		await pending;
		expect(startup.calls).toEqual(["integrity", "heartbeat", "devices", "transfers", "modeltrace"]);
		expect(startup.logger.warn).not.toHaveBeenCalled();
		const failed = gate();
		const failedStartup = startupEntry(failed.readiness);
		const rejected = failedStartup.startWork();
		failed.probe.reject(new Error("workers unavailable"));
		await rejected;
		expect(failedStartup.calls).toEqual([]);
		expect(failedStartup.logger.warn).not.toHaveBeenCalled();
		startup.stop();
		failedStartup.stop();
	});
});

describe("production WebSocket upgrade error boundary", () => {
	const privateDetail =
		"SELECT private_column FROM private_table WHERE token = 'private-bind'; " +
		"/private/database.db user=private-user " +
		"http://127.0.0.1/ws/terminal?terminalId=private-terminal&token=fixture-session";
	const paths = [
		"/ws/terminal?terminalId=private-terminal&token=fixture-session",
		"/ws/narrator?token=fixture-session",
	];

	async function readyEntry() {
		const controlled = gate();
		controlled.probe.resolve();
		await controlled.readiness.wait();
		return entry(controlled.readiness);
	}

	async function expectUnavailable(error: Error, stage: "session" | "presence", code: string) {
		for (const path of paths) {
			const runtime = await readyEntry();
			const read = stage === "session" ? runtime.verifySession : runtime.readUser;
			read.mockRejectedValueOnce(error);
			const response = await runtime.request(path);
			expect(response?.status).toBe(503);
			const text = await response?.text();
			expect(JSON.parse(text ?? "null")).toEqual({
				...toErrorPayload(catalogError("DATABASE_READ_UNAVAILABLE")),
				code,
			});
			const wire = JSON.stringify({ text, headers: [...(response?.headers ?? [])] });
			for (const secret of ["SELECT", "private", "fixture-session", "?token=", "http://"]) {
				expect(wire).not.toContain(secret);
			}
			expect(runtime.upgrades).toBe(0);
			if (stage === "session") expect(runtime.readUser).not.toHaveBeenCalled();
		}
	}

	for (const stage of ["session", "presence"] as const) {
		for (const code of [
			"DB_READ_UNAVAILABLE",
			"DB_READ_OVERLOADED",
			"DB_READ_BUSY",
			"DB_READ_DATABASE_CLOSED",
			"DB_READ_WORKER_EXITED",
			"DB_READ_READER_EXIT_UNCONFIRMED",
			"DB_READ_TASK_TIMEOUT",
		]) {
			test(`${stage} ${code} returns a safe 503 before upgrading`, async () => {
				const error = Object.assign(new DbReadError(code, privateDetail), {
					reason: privateDetail,
					sql: privateDetail,
					binds: ["private-bind"],
					messageCode: "RESOURCE_NOT_FOUND",
					messageParams: { id: privateDetail },
				});
				await expectUnavailable(error, stage, code);
			});
		}

		test(`${stage} real count queue overload returns a safe 503`, async () => {
			await expectUnavailable(new DbReadTaskOverloadedError(), stage, "DB_READ_TASK_OVERLOADED");
		});

		test(`${stage} bytes queue overload returns a safe 503`, async () => {
			await expectUnavailable(
				new DbReadError("DB_READ_OVERLOADED", privateDetail),
				stage,
				"DB_READ_OVERLOADED",
			);
		});

		test(`${stage} real reader unavailability returns a safe 503`, async () => {
			await expectUnavailable(
				new WorkersUnavailableError(privateDetail),
				stage,
				"DB_READ_UNAVAILABLE",
			);
		});
	}

	test("worker-reconstructed plain errors use the shared stable code classification", async () => {
		await expectUnavailable(
			Object.assign(new Error(privateDetail), { code: "DB_READ_WORKER_EXITED" }),
			"session",
			"DB_READ_WORKER_EXITED",
		);
	});

	for (const status of [403, 404]) {
		test(`application ${status} remains non-retryable even if the request is aborted`, async () => {
			const runtime = await readyEntry();
			const controller = new AbortController();
			controller.abort("private abort reason");
			const error = new AppError("Access refused", status, "ACCESS_REFUSED");
			runtime.readUser.mockRejectedValueOnce(error);
			const response = await runtime.request(paths[0], { signal: controller.signal });
			expect(response?.status).toBe(status);
			expect(response?.headers.get("Retry-After")).toBeNull();
			expect(await response?.json()).toEqual(toErrorPayload(error));
			expect(runtime.upgrades).toBe(0);
		});
	}

	test("client cancellation never serializes an arbitrary parent abort reason", async () => {
		const runtime = await readyEntry();
		const controller = new AbortController();
		const reason = new Error(privateDetail);
		controller.abort(reason);
		runtime.verifySession.mockRejectedValueOnce(reason);
		const response = await runtime.request(paths[0], { signal: controller.signal });
		expect(response?.status).toBe(499);
		expect(await response?.text()).toBe("");
		expect(runtime.readUser).not.toHaveBeenCalled();
		expect(runtime.upgrades).toBe(0);
	});

	test("reader cancellation without a client abort is a safe service refusal", async () => {
		const runtime = await readyEntry();
		runtime.readUser.mockRejectedValueOnce(new DbReadError("DB_READ_ABORTED", privateDetail));
		const response = await runtime.request(paths[0]);
		expect(response?.status).toBe(503);
		expect(response?.headers.get("Retry-After")).toBe("5");
		expect(await response?.json()).toEqual({
			...toErrorPayload(catalogError("DATABASE_READ_UNAVAILABLE")),
			code: "DB_READ_ABORTED",
		});
		expect(runtime.upgrades).toBe(0);
	});

	for (const error of [
		new AppError("Invalid token", 401, "UNAUTHORIZED"),
		Object.assign(new Error("Session revoked"), { name: "SessionTokenRevoked" }),
		Object.assign(new Error("Session expired"), { name: "SessionTokenExpired" }),
	]) {
		test(`${error.name}: ${error.message} retains the existing 401`, async () => {
			for (const path of paths) {
				const runtime = await readyEntry();
				runtime.verifySession.mockRejectedValueOnce(error);
				const response = await runtime.request(path);
				expect(response?.status).toBe(401);
				expect(await response?.text()).toBe("Invalid or expired token");
				expect(runtime.readUser).not.toHaveBeenCalled();
				expect(runtime.upgrades).toBe(0);
			}
		});
	}

	test("missing credentials remain 401 and valid sessions still upgrade", async () => {
		const runtime = await readyEntry();
		expect((await runtime.request("/ws/terminal"))?.status).toBe(401);
		expect(runtime.verifySession).not.toHaveBeenCalled();
		expect(runtime.readUser).not.toHaveBeenCalled();
		expect(await runtime.request(paths[0])).toBeUndefined();
		expect(runtime.verifySession).toHaveBeenCalledTimes(1);
		expect(runtime.readUser).toHaveBeenCalledTimes(1);
		expect(runtime.upgrades).toBe(1);
	});

	for (const code of [
		"DB_READ_FAILED",
		"DB_READ_INVALID",
		"DB_READ_BUDGET",
		"DB_READ_ROW_TOO_LARGE",
		"DB_READ_UNSUPPORTED",
		"DB_READ_PROTOCOL",
		"DB_READ_CONSUMER_FAILED",
		"DB_READ_UNAVAILABLE_EXTRA",
		"SQLITE_BUSY",
		"SQLITE_ERROR",
	]) {
		test(`does not swallow ${code}`, async () => {
			const runtime = await readyEntry();
			const error = new DbReadError(code, privateDetail);
			runtime.readUser.mockRejectedValueOnce(error);
			await expect(runtime.request(paths[0])).rejects.toBe(error);
			expect(runtime.upgrades).toBe(0);
		});
	}

	test("unknown session errors retain their identity", async () => {
		const runtime = await readyEntry();
		const error = new Error(privateDetail);
		runtime.verifySession.mockRejectedValueOnce(error);
		await expect(runtime.request(paths[0])).rejects.toBe(error);
		expect(runtime.readUser).not.toHaveBeenCalled();
		expect(runtime.upgrades).toBe(0);
	});

	test("explicit application errors are not reclassified by infrastructure-shaped codes", async () => {
		const runtime = await readyEntry();
		const error = new AppError("Specific application conflict", 409, "DB_READ_BUSY");
		runtime.readUser.mockRejectedValueOnce(error);
		const response = await runtime.request(paths[0]);
		expect(response?.status).toBe(409);
		expect(await response?.json()).toEqual(toErrorPayload(error));
	});

	test("does not coerce code values or swallow non-Error throws", async () => {
		for (const error of [
			null,
			privateDetail,
			{ code: "DB_READ_OVERLOADED", message: privateDetail },
			Object.assign(new Error(privateDetail), {
				code: { toString: () => "DB_READ_OVERLOADED" },
			}),
		]) {
			const runtime = await readyEntry();
			runtime.readUser.mockRejectedValueOnce(error);
			await expect(runtime.request(paths[0])).rejects.toBe(error);
		}
	});

	test("leaves the ordinary HTTP error boundary unchanged", async () => {
		const runtime = await readyEntry();
		const error = new DbReadTaskOverloadedError();
		runtime.fetchHttp.mockRejectedValueOnce(error);
		await expect(runtime.request("/api/data")).rejects.toBe(error);
	});

	test("handled overloads do not log the request URL or infrastructure details", async () => {
		const runtime = await readyEntry();
		const logs = [
			spyOn(logger, "error").mockImplementation(() => {}),
			spyOn(logger, "warn").mockImplementation(() => {}),
			spyOn(console, "error").mockImplementation(() => {}),
			spyOn(console, "warn").mockImplementation(() => {}),
		];
		try {
			runtime.verifySession.mockRejectedValueOnce(
				new DbReadError("DB_READ_OVERLOADED", privateDetail),
			);
			expect((await runtime.request(paths[0]))?.status).toBe(503);
			for (const log of logs) expect(log).not.toHaveBeenCalled();
		} finally {
			for (const log of logs) log.mockRestore();
		}
	});
});
