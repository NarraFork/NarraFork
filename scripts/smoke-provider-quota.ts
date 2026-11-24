import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import type { Browser, BrowserContext, ElementHandle, HTTPRequest, Page } from "puppeteer-core";
import { CHROMIUM_PATHS } from "../shared/browser-paths";
import { copyReleaseFile, hashReleaseFile } from "./lib/ci-release-io";
import { type SmokeChild, SmokeProcessScope } from "./lib/ci-release-smoke-process";
import { removeSmokeDirectory, smokeFailure } from "./smoke-release-binary";

const MAX_RUN_MS = 8 * 60_000;
const REQUEST_MS = 15_000;
const BODY_BYTES = 1024 * 1024;
const MAX_BINARY_BYTES = 1024 ** 3;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const PLUGIN_ID = "io.narrafork.provider-quota";
const EXPECTED_VERSION = "1.0.3";
const EXPECTED_HOST_API = "1.0";
const MIN_LIFECYCLE_CHECKS = 37;
const MANUAL_THROTTLE_MS = 10_000;
const SITE_INITIAL_BALANCE = 31.27;
const SITE_REFRESHED_BALANCE = 42.56;
const SITE_GROUP = "quota-smoke-site-group";
const SITE_USER_ID = "424242";
const SITE_PATH = "/api/user/self";
const PROVIDER_ID = "quota-smoke-relay";
const PROVIDER_NAME = "Quota smoke relay";
const MODEL_ID = "quota-smoke-model";
const MODEL_PREFIX = "quota-smoke";
const FULL_MODEL_ID = `${MODEL_PREFIX}:${MODEL_ID}`;
const USAGE_UNIT = 500_000;

type JsonObject = Record<string, unknown>;
type CheckStatus = "passed" | "failed" | "baseline-only";

export interface QuotaSmokeOptions {
	binary: string;
	archive: string;
	out: string;
	browser?: string;
	baseline: boolean;
	timeoutMs: number;
}

export interface QuotaSmokeReport {
	schemaVersion: 1;
	status: "passed" | "failed" | "baseline-only";
	finalAcceptance: boolean;
	baseline: boolean;
	pluginId: string;
	expectedVersion: string;
	expectedHostApi: string;
	checks: { name: string; status: CheckStatus; detail?: unknown }[];
	http: { name: string; status: number; code?: string; summary?: unknown }[];
	artifacts: Record<string, unknown>;
	fixture?: unknown;
	siteFixture?: unknown;
	browser?: unknown;
	error?: string;
}

export function parseQuotaSmokeArgs(args: readonly string[]): QuotaSmokeOptions {
	const values = new Map<string, string>();
	const allowed = new Set(["binary", "archive", "out", "browser", "baseline", "timeout-ms"]);
	for (let index = 0; index < args.length; index++) {
		const argument = args[index] ?? "";
		const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argument);
		if (!match || !allowed.has(match[1] ?? "")) throw new Error(`Unknown argument: ${argument}`);
		const key = match[1] ?? "";
		if (values.has(key)) throw new Error(`Duplicate argument: --${key}`);
		let value = match[2];
		if (key === "baseline") value ??= "true";
		else if (value === undefined) value = args[++index];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
		values.set(key, value);
	}
	for (const key of ["binary", "archive", "out"])
		if (!values.get(key)) throw new Error(`Required argument: --${key}`);
	const baseline = values.get("baseline") ?? "false";
	if (!["true", "false"].includes(baseline)) throw new Error("--baseline must be true or false");
	const timeoutMs = Number(values.get("timeout-ms") ?? MAX_RUN_MS);
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_RUN_MS)
		throw new Error("--timeout-ms must be between 1000 and 480000");
	return {
		binary: resolve(values.get("binary") ?? ""),
		archive: resolve(values.get("archive") ?? ""),
		out: resolve(values.get("out") ?? ""),
		...(values.get("browser") ? { browser: resolve(values.get("browser") ?? "") } : {}),
		baseline: baseline === "true",
		timeoutMs,
	};
}

/** Never inherit a real account, proxy credential, database, module path or Bun installation. */
export function quotaSmokeEnvironment(
	root: string,
	ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv & Record<"HOME" | "NARRAFORK_HOME" | "TMP" | "PATH", string> {
	const env: NodeJS.ProcessEnv = {};
	const allowed = new Set([
		"pathext",
		"systemroot",
		"windir",
		"comspec",
		"processor_architecture",
		"lang",
		"lc_all",
	]);
	for (const [key, value] of Object.entries(ambient))
		if (allowed.has(key.toLowerCase())) env[key] = value;
	const rawPath = Object.entries(ambient).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
	const roots =
		process.platform === "win32"
			? [ambient.SystemRoot ?? ambient.SYSTEMROOT ?? "C:\\Windows"]
			: ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
	const path = rawPath
		.split(delimiter)
		.filter((part) => {
			if (!part || /node_modules|\.bun|toolchains/i.test(part)) return false;
			const normal = part.replaceAll("\\", "/").toLowerCase().replace(/\/$/, "");
			const system = roots.some((rootPath) => {
				const rootNormal = rootPath.replaceAll("\\", "/").toLowerCase().replace(/\/$/, "");
				return normal === rootNormal || normal.startsWith(`${rootNormal}/`);
			});
			const git =
				process.platform === "win32" &&
				/\/(?:git|mingw64)\/(?:cmd|bin|usr\/bin|mingw64\/bin)$/.test(normal);
			return (
				(system || git) &&
				!["bun", "bun.exe", "bunx", "bunx.exe"].some((name) => existsSync(join(part, name)))
			);
		})
		.join(delimiter);
	const home = join(root, "home");
	return {
		...env,
		PATH: path,
		HOME: home,
		USERPROFILE: home,
		APPDATA: join(home, "AppData", "Roaming"),
		LOCALAPPDATA: join(home, "AppData", "Local"),
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_CACHE_HOME: join(home, ".cache"),
		TMPDIR: join(root, "tmp"),
		TMP: join(root, "tmp"),
		TEMP: join(root, "tmp"),
		NARRAFORK_HOME: join(root, "data"),
		NF_DATABASE_BACKEND: "sqlite",
		NODE_ENV: "production",
		BROWSER: "none",
		NO_PROXY: "127.0.0.1,localhost",
		...(process.platform !== "win32" ? { SHELL: "/bin/sh" } : {}),
	};
}

function object(value: unknown): JsonObject {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

export function redactQuotaEvidence(value: unknown, secrets: readonly string[]): unknown {
	if (typeof value === "string") {
		let text = stripVTControlCharacters(value);
		for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[redacted]");
		return text
			.replace(/\bnfs_[A-Za-z0-9_-]+\b/g, "[redacted]")
			.replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [redacted]")
			.replace(/([?&](?:token|key|api_key|secret)=)[^&\s]+/gi, "$1[redacted]")
			.slice(0, 32 * 1024);
	}
	if (Array.isArray(value))
		return value.slice(0, 256).map((entry) => redactQuotaEvidence(entry, secrets));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.slice(0, 256)
				.map(([key, entry]) => [
					key,
					/^(?:authorization|password|token|api[_-]?key|quotaAccessToken|cookie|secret|masked)$/i.test(
						key,
					)
						? "[redacted]"
						: redactQuotaEvidence(entry, secrets),
				]),
		);
	return value;
}

/** Process closure and directory removal must both succeed to mark cleanup as passed. */
export function finishQuotaSmokeCleanup(
	context: Pick<QuotaSmokeContext, "report" | "stage" | "secrets">,
	primary: unknown,
	errors: readonly unknown[],
): unknown {
	const name = "owned process and home cleanup";
	context.report.checks.push({ name, status: errors.length ? "failed" : "passed" });
	if (errors.length === 0) return primary;
	if (primary === undefined) context.stage = name;
	const failure = smokeFailure(
		"Quota smoke cleanup failed",
		primary === undefined ? errors : [primary, ...errors],
	);
	context.report.status = "failed";
	context.report.finalAcceptance = false;
	context.report.error = String(redactQuotaEvidence(String(failure), context.secrets));
	return failure;
}

async function readQuotaBytes(
	body: ReadableStream<Uint8Array>,
	maximum: number,
	signal: AbortSignal,
): Promise<Buffer> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const chunk = await boundedQuotaWork(reader.read(), signal);
			if (chunk.done) return Buffer.concat(chunks);
			bytes += chunk.value.byteLength;
			if (bytes > maximum) throw new Error("HTTP response body exceeded smoke budget");
			chunks.push(chunk.value);
		}
	} finally {
		await boundedQuotaWork(
			reader.cancel().catch(() => {}),
			AbortSignal.timeout(1_000),
		).catch(() => {});
		reader.releaseLock();
	}
}

export async function readBoundedQuotaBody(
	response: Response,
	maximum = BODY_BYTES,
	signal: AbortSignal = AbortSignal.timeout(REQUEST_MS),
): Promise<string> {
	return response.body
		? (await readQuotaBytes(response.body, maximum, signal)).toString("utf8")
		: "";
}

async function reserveLoopbackPort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string")
				return server.close(() => reject(new Error("No reserved port")));
			server.close((error) => (error ? reject(error) : resolvePort(address.port)));
		});
	});
}

interface HttpResult {
	status: number;
	ok: boolean;
	body: unknown;
}

interface RunningServer {
	scope: SmokeProcessScope;
	child: SmokeChild;
}

export class QuotaSmokeContext {
	readonly env: ReturnType<typeof quotaSmokeEnvironment>;
	readonly scopes: SmokeProcessScope[] = [];
	readonly secrets: string[] = [];
	readonly localeTokens = new Map<SmokeLocale, string>();
	readonly report: QuotaSmokeReport;
	readonly signal: AbortSignal;
	readonly cwd: string;
	readonly executable: string;
	readonly controller = new AbortController();
	token = "";
	origin = "";
	server: RunningServer | undefined;
	stage = "prepare";
	browser: Browser | undefined;
	fixture: ReturnType<typeof createQuotaFixture> | undefined;
	siteFixture: ReturnType<typeof createSiteQuotaFixture> | undefined;
	/** Throwaway provider/key configuration only; never part of an evidence artifact. */
	providerConfig: JsonObject = {};
	inferenceKeyId = "";
	private readonly endAt: number;

	constructor(
		readonly options: QuotaSmokeOptions,
		readonly root: string,
		signal?: AbortSignal,
	) {
		this.env = quotaSmokeEnvironment(root);
		this.cwd = join(root, "run");
		this.executable = join(this.cwd, process.platform === "win32" ? "narrafork.exe" : "narrafork");
		this.endAt = performance.now() + options.timeoutMs;
		this.signal = AbortSignal.any([
			this.controller.signal,
			AbortSignal.timeout(options.timeoutMs),
			...(signal ? [signal] : []),
		]);
		this.report = {
			schemaVersion: 1,
			status: "failed",
			finalAcceptance: false,
			baseline: options.baseline,
			pluginId: PLUGIN_ID,
			expectedVersion: EXPECTED_VERSION,
			expectedHostApi: EXPECTED_HOST_API,
			checks: [],
			http: [],
			artifacts: {},
		};
		this.signal.addEventListener(
			"abort",
			() => {
				// Interrupt pending browser calls and close only handles spawned by this run.
				void Promise.resolve(this.browser?.disconnect()).catch(() => {});
				this.fixture?.stop();
				this.siteFixture?.stop();
				for (const scope of this.scopes) void scope.close().catch(() => {});
			},
			{ once: true },
		);
	}

	check(name: string, detail?: unknown): void {
		this.report.checks.push({
			name,
			status: "passed",
			...(detail === undefined ? {} : { detail }),
		});
	}

	newScope(): SmokeProcessScope {
		this.signal.throwIfAborted();
		if (this.scopes.length >= 8) throw new Error("Owned process scope count exceeds smoke budget");
		const remaining = Math.floor(this.endAt - performance.now());
		if (remaining <= 0) throw new Error("Smoke hard timeout");
		const scope = new SmokeProcessScope(this.cwd, this.env, {
			timeoutMs: Math.min(MAX_RUN_MS, remaining),
			maxOutputBytes: 8 * 1024 * 1024,
			signal: this.signal,
		});
		scope.signal.addEventListener("abort", () => this.controller.abort(scope.signal.reason), {
			once: true,
		});
		this.scopes.push(scope);
		return scope;
	}

	async http(
		path: string,
		init: RequestInit = {},
		logName?: string,
		origin = this.origin,
	): Promise<HttpResult> {
		this.signal.throwIfAborted();
		const headers = new Headers(init.headers);
		if (this.token && origin === this.origin) headers.set("Authorization", `Bearer ${this.token}`);
		const signal = AbortSignal.any([this.signal, AbortSignal.timeout(REQUEST_MS)]);
		const response = await fetch(`${origin}${path}`, {
			...init,
			headers,
			redirect: "error",
			signal,
		});
		const text = await readBoundedQuotaBody(response, BODY_BYTES, signal);
		let body: unknown;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = text.slice(0, 1000);
		}
		if (logName) {
			if (this.report.http.length >= 128)
				throw new Error("HTTP evidence count exceeds smoke budget");
			const fields = object(body);
			const code =
				typeof fields.code === "string"
					? fields.code
					: typeof object(fields.lastError).code === "string"
						? String(object(fields.lastError).code)
						: typeof fields.error === "string"
							? fields.error
							: undefined;
			this.report.http.push({
				name: logName,
				status: response.status,
				...(code ? { code } : {}),
				summary: redactQuotaEvidence(body, this.secrets),
			});
		}
		return { status: response.status, ok: response.ok, body };
	}

	async require(path: string, init: RequestInit = {}, logName?: string): Promise<unknown> {
		const result = await this.http(path, init, logName);
		if (!result.ok)
			throw new Error(
				`${logName ?? path}: HTTP ${result.status} ${String(object(result.body).error ?? "")}`,
			);
		return result.body;
	}

	async wait<T>(
		label: string,
		probe: () => Promise<T | undefined>,
		timeoutMs = 30_000,
	): Promise<T> {
		const end = performance.now() + timeoutMs;
		while (true) {
			this.signal.throwIfAborted();
			this.server?.child.assertRunning();
			const value = await probe();
			if (value !== undefined) return value;
			if (performance.now() >= end) throw new Error(`${label} timed out`);
			await delay(100, undefined, { signal: this.signal });
		}
	}

	async start(): Promise<void> {
		if (this.server) throw new Error("Refusing to adopt or replace a live smoke process");
		const port = this.origin ? Number(new URL(this.origin).port) : await reserveLoopbackPort();
		if ([7778, 7779, 41221].includes(port))
			throw new Error("Reserved port belongs to a protected instance");
		this.origin = `http://127.0.0.1:${port}`;
		const scope = this.newScope();
		const child = scope.spawn([
			this.executable,
			"--serve",
			"--host=127.0.0.1",
			`--port=${port}`,
			"--no-auto-resume",
		]);
		this.server = { scope, child };
		await this.wait(
			"isolated compiled startup",
			async () => {
				try {
					const health = await this.http("/api/health");
					return health.ok ? health.body : undefined;
				} catch {
					child.assertRunning();
					return undefined;
				}
			},
			90_000,
		);
		const identity = object(
			JSON.parse(
				await readBoundedQuotaBody(
					new Response(Bun.file(join(this.env.NARRAFORK_HOME, "narrafork.lock"))),
					16 * 1024,
					this.signal,
				),
			),
		);
		if (identity.pid !== child.process.pid)
			throw new Error("Isolated instance lock is not owned by the spawned executable");
		child.assertRunning();
	}

	async restart(): Promise<void> {
		if (!this.server) throw new Error("No owned server to restart");
		await this.server.scope.close();
		this.server = undefined;
		await this.start();
	}

	async upload(name: string): Promise<HttpResult> {
		const form = new FormData();
		const data = await readQuotaBytes(
			Bun.file(this.options.archive).stream(),
			MAX_ARCHIVE_BYTES,
			this.signal,
		);
		form.set(
			"archive",
			new File([new Uint8Array(data)], basename(this.options.archive), { type: "application/zip" }),
		);
		return this.http("/api/plugins/install", { method: "POST", body: form }, name);
	}

	async lifecycle(action: string): Promise<unknown> {
		return this.require(
			`/api/plugins/${PLUGIN_ID}/${action}`,
			{ method: "POST" },
			`plugin ${action}`,
		);
	}

	async plugin(): Promise<JsonObject | null> {
		const response = await this.http(`/api/plugins/${PLUGIN_ID}`);
		if (response.status === 404) return null;
		if (!response.ok) throw new Error(`Plugin status HTTP ${response.status}`);
		return object(response.body);
	}

	async artifact(name: string, data: unknown): Promise<void> {
		const text = `${JSON.stringify(redactQuotaEvidence(data, this.secrets), null, 2)}\n`;
		if (Buffer.byteLength(text) > 2 * BODY_BYTES)
			throw new Error("JSON evidence exceeds smoke budget");
		await writeFile(join(this.options.out, name), text, { flag: "wx", mode: 0o600 });
	}
}

export function createQuotaFixture(
	key: string,
	signal: AbortSignal,
	onFailure?: (error: Error) => void,
) {
	let remaining = 12.34;
	let requests = 0;
	let bytes = 0;
	const counts: Record<string, number> = {};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 15,
		maxRequestBodySize: 1024,
		fetch(request) {
			const path = new URL(request.url).pathname;
			requests++;
			if (
				signal.aborted ||
				requests > 256 ||
				path.length > 2048 ||
				(!(path in counts) && Object.keys(counts).length >= 32)
			) {
				onFailure?.(new Error("Fixture request budget exceeded"));
				return new Response("Fixture request budget exceeded", { status: 503 });
			}
			counts[path] = (counts[path] ?? 0) + 1;
			if (request.method !== "GET") return new Response(null, { status: 405 });
			if (path !== "/api/status" && request.headers.get("authorization") !== `Bearer ${key}`)
				return new Response("Fixture authentication rejected", { status: 401 });
			if (
				path === "/api/status" &&
				["authorization", "api-key", "x-api-key", "cookie"].some((header) =>
					request.headers.has(header),
				)
			)
				return new Response("Public fixture status must not carry credentials", { status: 400 });
			let status = 200;
			let value: unknown;
			if (path === "/v1/models")
				value = {
					object: "list",
					data: [
						{ id: MODEL_ID, object: "model", owned_by: "quota-smoke", context_length: 131072 },
					],
				};
			else if (path === "/api/usage/token/")
				value = {
					code: true,
					data: {
						object: "token_usage",
						unlimited_quota: false,
						total_available: Math.round(remaining * USAGE_UNIT),
						total_used: Math.round((50 - remaining) * USAGE_UNIT),
						total_granted: 50 * USAGE_UNIT,
					},
				};
			else if (path === "/api/status")
				value = { success: true, data: { quota_display_type: "USD", quota_per_unit: USAGE_UNIT } };
			else {
				status = 404;
				value = { error: "unsupported-fixture-route" };
			}
			const body = JSON.stringify(value);
			bytes += Buffer.byteLength(body);
			if (bytes > 4 * BODY_BYTES) {
				onFailure?.(new Error("Fixture response budget exceeded"));
				return new Response("Fixture response budget exceeded", { status: 503 });
			}
			return new Response(body, {
				status,
				headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
			});
		},
	});
	return {
		origin: `http://127.0.0.1:${server.port}`,
		setRemaining(value: number) {
			if (!Number.isFinite(value) || value < 0 || value > 50)
				throw new Error("Invalid fixture balance");
			remaining = value;
		},
		evidence: () => ({ requests, bytes, counts: { ...counts }, remaining }),
		stop: () => server.stop(true),
	};
}

export interface SiteQuotaFixtureOptions {
	accessToken: string;
	userId: string;
	/** All inference-only secret values must be absent from the site's wire headers. */
	inferenceSecrets: readonly string[];
}

export interface SiteQuotaRequestEvidence {
	request: number;
	status: number;
	tokenMatched: boolean;
	userMatched: boolean;
	inferenceSecretsAbsent: boolean;
	inferenceHeadersAbsent: boolean;
}

/** A separate real loopback origin: credentials are inspected, never returned or logged. */
export function createSiteQuotaFixture(
	options: SiteQuotaFixtureOptions,
	signal: AbortSignal,
	onFailure?: (error: Error) => void,
) {
	let remaining = SITE_INITIAL_BALANCE;
	let mode: "supported" | "unauthorized" = "supported";
	let requests = 0;
	let bytes = 0;
	let stopped = false;
	let disconnected = false;
	const records: SiteQuotaRequestEvidence[] = [];
	const counts: Record<string, number> = {};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 15,
		maxRequestBodySize: 1024,
		fetch(request) {
			const url = new URL(request.url);
			requests++;
			if (
				signal.aborted ||
				requests > 128 ||
				url.pathname.length > 2048 ||
				(!(url.pathname in counts) && Object.keys(counts).length >= 32)
			) {
				onFailure?.(new Error("Site fixture request budget exceeded"));
				return new Response("Site fixture request budget exceeded", { status: 503 });
			}
			counts[url.pathname] = (counts[url.pathname] ?? 0) + 1;
			if (request.method !== "GET" || url.pathname !== SITE_PATH || url.search) {
				onFailure?.(new Error("Site fixture received a non-account request"));
				return new Response("Unexpected site route", { status: 404 });
			}
			const tokenMatched = request.headers.get("authorization") === `Bearer ${options.accessToken}`;
			const userMatched = request.headers.get("new-api-user") === options.userId;
			const inferenceSecretsAbsent = [...request.headers.values()].every((value) =>
				options.inferenceSecrets.every((secret) => !secret || !value.includes(secret)),
			);
			const inferenceHeadersAbsent = [
				"api-key",
				"x-api-key",
				"cookie",
				"proxy-authorization",
				"x-smoke-inference",
			].every((header) => !request.headers.has(header));
			const authenticated =
				tokenMatched && userMatched && inferenceSecretsAbsent && inferenceHeadersAbsent;
			const status = authenticated ? (mode === "unauthorized" ? 401 : 200) : 400;
			if (records.length < 64)
				records.push({
					request: requests,
					status,
					tokenMatched,
					userMatched,
					inferenceSecretsAbsent,
					inferenceHeadersAbsent,
				});
			if (!authenticated)
				onFailure?.(new Error("Site authentication or inference-header isolation failed"));
			const body = JSON.stringify(
				status === 200
					? {
							success: true,
							data: {
								quota: Math.round(remaining * USAGE_UNIT),
								used_quota: Math.round(7.5 * USAGE_UNIT),
								group: SITE_GROUP,
							},
						}
					: {
							success: false,
							error:
								status === 401 ? "fixture-account-token-revoked" : "fixture-site-isolation-failed",
						},
			);
			bytes += Buffer.byteLength(body);
			if (bytes > 2 * BODY_BYTES) {
				onFailure?.(new Error("Site fixture response budget exceeded"));
				return new Response("Site fixture response budget exceeded", { status: 503 });
			}
			return new Response(body, {
				status,
				headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
			});
		},
	});
	const origin = `http://127.0.0.1:${server.port}`;
	const stop = () => {
		if (!stopped) {
			stopped = true;
			server.stop(true);
		}
	};
	return {
		origin,
		setRemaining(value: number) {
			if (stopped || !Number.isFinite(value) || value < 0 || value > 50)
				throw new Error("Invalid site fixture balance");
			remaining = value;
		},
		setMode(value: "supported" | "unauthorized") {
			if (stopped || !["supported", "unauthorized"].includes(value))
				throw new Error("Invalid site fixture mode");
			mode = value;
		},
		/** Stop only this fixture's socket; the host and inference origin stay healthy. */
		disconnect() {
			disconnected = true;
			stop();
		},
		evidence: () => ({
			origin,
			requests,
			bytes,
			counts: { ...counts },
			remaining,
			group: SITE_GROUP,
			mode,
			disconnected,
			records: records.map((entry) => ({ ...entry })),
		}),
		stop,
	};
}

export function assertQuotaSnapshot(value: unknown, remaining: number): void {
	const snapshot = object(value);
	const amounts = object(snapshot.data).amounts;
	if (
		snapshot.providerId !== PROVIDER_ID ||
		snapshot.status !== "supported" ||
		snapshot.error !== null ||
		snapshot.stale !== false
	)
		throw new Error(
			`Quota did not produce a fresh supported snapshot: ${String(snapshot.status)}/${String(snapshot.error)}`,
		);
	if (typeof snapshot.sourceId !== "string" || !snapshot.sourceId.startsWith(`${PLUGIN_ID}/`))
		throw new Error("Quota result did not originate from the installed plugin contribution");
	if (
		!Array.isArray(amounts) ||
		!amounts.some(
			(amount) => object(amount).unit === "USD" && object(amount).remaining === remaining,
		)
	)
		throw new Error(`Quota amount did not match fixture balance ${remaining}`);
}

export function assertSiteQuotaSnapshot(
	value: unknown,
	remaining: number,
	group = SITE_GROUP,
): void {
	assertQuotaSnapshot(value, remaining);
	const snapshot = object(value);
	const data = object(snapshot.data);
	if (
		snapshot.targetId !== `custom-api/${PROVIDER_ID}` ||
		snapshot.keyId !== undefined ||
		snapshot.pushCompatible !== false
	)
		throw new Error("Explicit site account quota was replaced by an inference-key subject");
	if (data.format !== "new-api-user" || data.scope !== "wallet" || data.planName !== group)
		throw new Error("Site wallet quota or group did not match /api/user/self");
}

export function assertSiteQuotaFailure(
	value: unknown,
	code: "auth_failed" | "request_failed",
): void {
	const snapshot = object(value);
	if (
		snapshot.providerId !== PROVIDER_ID ||
		snapshot.targetId !== `custom-api/${PROVIDER_ID}` ||
		snapshot.status !== "error" ||
		snapshot.error !== code ||
		snapshot.data !== null ||
		snapshot.stale !== true ||
		snapshot.keyId !== undefined ||
		snapshot.pushCompatible !== false
	)
		throw new Error(
			"Site quota failure retained a good value or fell back to inference-key allowance",
		);
}

export function assertSiteCredentialIsolation(records: readonly SiteQuotaRequestEvidence[]): void {
	if (
		!records.length ||
		records.some(
			(record) =>
				!record.tokenMatched ||
				!record.userMatched ||
				!record.inferenceSecretsAbsent ||
				!record.inferenceHeadersAbsent,
		)
	)
		throw new Error("Site token/UserId were not exclusively injected by the host");
}

async function requireSiteBalance(
	context: QuotaSmokeContext,
	remaining: number,
	label: string,
): Promise<JsonObject> {
	const snapshot = await context.wait(label, async () => {
		const current = await quotaSnapshot(context);
		if (!current || current.status !== "supported") return undefined;
		const amounts = object(current.data).amounts;
		if (
			!Array.isArray(amounts) ||
			!amounts.some((amount) => object(amount).remaining === remaining)
		)
			return undefined;
		assertSiteQuotaSnapshot(current, remaining);
		return current;
	});
	context.check(label, snapshot);
	return snapshot;
}

async function requireSiteFailure(
	context: QuotaSmokeContext,
	code: "auth_failed" | "request_failed",
	previousVersion: number,
	label: string,
): Promise<JsonObject> {
	const snapshot = await context.wait(label, async () => {
		const current = await quotaSnapshot(context);
		if (
			!current ||
			current.status !== "error" ||
			current.error !== code ||
			Number(current.version) <= previousVersion
		)
			return undefined;
		assertSiteQuotaFailure(current, code);
		return current;
	});
	context.check(label, snapshot);
	return snapshot;
}

export function quotaUiHasUnavailable(text: string): boolean {
	return /providerQuota\.(?:unavailable|errors\.unavailable)|quota source(?: plugin)? (?:is )?unavailable|额度来源(?:插件)?不可用|提供商额度不可用/i.test(
		text,
	);
}

async function boundedQuotaWork<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
	deadline.throwIfAborted();
	return new Promise((resolveWork, reject) => {
		const abort = () => reject(deadline.reason);
		deadline.addEventListener("abort", abort, { once: true });
		work.then(resolveWork, reject).finally(() => deadline.removeEventListener("abort", abort));
	});
}

async function requireActivePlugin(context: QuotaSmokeContext, label: string): Promise<JsonObject> {
	const plugin = await context.wait(label, async () => {
		const current = await context.plugin();
		if (!current) return undefined;
		if (current.runtimeState !== "active") return undefined;
		if (
			current.desiredState !== "enabled" ||
			current.compatibility !== "compatible" ||
			object(current.current).version !== EXPECTED_VERSION
		)
			throw new Error("Active plugin does not match enabled compatible builtin 1.0.2");
		return current;
	});
	context.check(label, plugin);
	return plugin;
}

async function requireInactivePlugin(
	context: QuotaSmokeContext,
	absent: boolean,
	label: string,
): Promise<void> {
	await context.wait(label, async () => {
		const plugin = await context.plugin();
		if (absent) return !plugin || !object(plugin.current).version ? true : undefined;
		return plugin?.desiredState === "disabled" && plugin.runtimeState === "inactive"
			? true
			: undefined;
	});
	context.check(label);
}

async function quotaSnapshot(context: QuotaSmokeContext): Promise<JsonObject | undefined> {
	const page = object(
		await context.require(`/api/provider-quotas?providerId=${PROVIDER_ID}&limit=10`),
	);
	if (!Array.isArray(page.snapshots))
		throw new Error("Quota endpoint did not return a snapshot page");
	return page.snapshots.map(object).find((snapshot) => snapshot.providerId === PROVIDER_ID);
}

async function requireBalance(
	context: QuotaSmokeContext,
	remaining: number,
	label: string,
): Promise<JsonObject> {
	const snapshot = await context.wait(label, async () => {
		const current = await quotaSnapshot(context);
		if (!current || current.status !== "supported" || object(current.data).amounts === undefined)
			return undefined;
		const amounts = object(current.data).amounts;
		if (
			!Array.isArray(amounts) ||
			!amounts.some((amount) => object(amount).remaining === remaining)
		)
			return undefined;
		assertQuotaSnapshot(current, remaining);
		return current;
	});
	context.check(label, snapshot);
	return snapshot;
}

async function requireUnavailableQuota(context: QuotaSmokeContext, label: string): Promise<void> {
	const snapshot = await context.wait(label, async () => {
		const current = await quotaSnapshot(context);
		if (!current) return true;
		return current.status === "unavailable" && current.data === null && current.sourceId === null
			? current
			: undefined;
	});
	context.check(label, snapshot);
}

type SmokeLocale = "en" | "zh-CN";
const LOCALES: SmokeLocale[] = ["en", "zh-CN"];
const QUOTA_TRIGGER = 'button[aria-label^="Provider quota"], button[aria-label^="提供商额度"]';
const MODEL_BALANCE = `[data-provider-balance="${MODEL_PREFIX}"]`;
const MODEL_SELECT = `select:has(option[value="${FULL_MODEL_ID}"])`;
const REFRESH_LABELS: Record<SmokeLocale, string> = { en: "Refresh quota", "zh-CN": "刷新额度" };
/** `plugins:admin.empty` (en), rendered only once the plugin list has loaded with no entries. */
const PLUGINS_EMPTY_TEXT = "No plugins installed yet.";
const PROBE_LABELS = ["Rediscover quota", "重新探测额度"];

export class QuotaBrowserSmoke {
	readonly settings = new Map<SmokeLocale, Page>();
	readonly narrators = new Map<SmokeLocale, Page>();
	private readonly localeContexts = new Map<SmokeLocale, BrowserContext>();
	private networkBytes = 0;
	private responses = 0;
	private screenshots = 0;
	private screenshotBytes = 0;
	private manualAt = 0;

	constructor(
		readonly context: QuotaSmokeContext,
		readonly narratorId: string,
	) {}

	async start(): Promise<void> {
		const candidates = [
			this.context.options.browser,
			process.env.NF_TEST_CHROMIUM_PATH,
			process.env.PUPPETEER_EXECUTABLE_PATH,
			...CHROMIUM_PATHS,
			"/usr/bin/google-chrome",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		];
		const executable = candidates.find((path) => path && existsSync(path));
		if (!executable)
			throw new Error("Installed Chrome/Edge is required; missing browser is not a pass");
		const port = await reserveLoopbackPort();
		const scope = this.context.newScope();
		const child = scope.spawn([
			executable,
			"--headless=new",
			"--remote-debugging-address=127.0.0.1",
			`--remote-debugging-port=${port}`,
			`--user-data-dir=${join(this.context.root, "browser-profile")}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-default-apps",
			"--disable-extensions",
			"--disable-background-networking",
			"--disable-component-update",
			"--disable-sync",
			"--disable-dev-shm-usage",
			"--disable-features=Translate,MediaRouter,OptimizationHints",
			"--password-store=basic",
			"--use-mock-keychain",
			"--window-size=1440,1000",
			"--mute-audio",
			"about:blank",
		]);
		const endpoint = await this.context.wait("owned Chromium debugging endpoint", async () => {
			child.assertRunning();
			const ownedEndpoint =
				/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-z0-9-]+)/i.exec(
					child.diagnostic,
				)?.[1];
			if (!ownedEndpoint) return undefined;
			try {
				const result = await this.context.http(
					"/json/version",
					{},
					undefined,
					`http://127.0.0.1:${port}`,
				);
				const endpoint = object(result.body).webSocketDebuggerUrl;
				return result.ok && endpoint === ownedEndpoint ? ownedEndpoint : undefined;
			} catch {
				child.assertRunning();
				return undefined;
			}
		});
		const parsed = new URL(endpoint);
		if (parsed.hostname !== "127.0.0.1" || Number(parsed.port) !== port)
			throw new Error("Refusing to connect to an unowned browser endpoint");
		const puppeteer = await import("puppeteer-core");
		this.context.browser = await boundedQuotaWork(
			puppeteer.default.connect({ browserWSEndpoint: endpoint, protocolTimeout: 30_000 }),
			this.context.signal,
		);
		for (const locale of LOCALES) {
			this.localeContexts.set(
				locale,
				await boundedQuotaWork(this.context.browser.createBrowserContext(), this.context.signal),
			);
			this.settings.set(locale, await this.newPage(locale));
			this.narrators.set(locale, await this.newPage(locale));
		}
		this.context.report.browser = {
			executable: basename(executable),
			locales: LOCALES,
			ownedProfile: true,
			sandboxDisabled: false,
		};
		this.context.check("real isolated Chrome/Edge startup");
	}

	async newPage(locale: SmokeLocale): Promise<Page> {
		const browser = this.localeContexts.get(locale);
		if (!browser) throw new Error("Owned locale browser context not connected");
		const page = await boundedQuotaWork(browser.newPage(), this.context.signal);
		page.setDefaultTimeout(30_000);
		page.setDefaultNavigationTimeout(30_000);
		await page.setViewport({ width: 1440, height: 1000 });
		page.on("pageerror", (error) =>
			this.context.controller.abort(
				new Error(
					`Browser runtime error: ${String(redactQuotaEvidence(String(error), this.context.secrets))}`,
				),
			),
		);
		await page.setRequestInterception(true);
		page.on("request", (request) => {
			const url = new URL(request.url());
			if (["data:", "blob:", "about:"].includes(url.protocol) || url.origin === this.context.origin)
				void request.continue().catch(() => {});
			else {
				this.context.controller.abort(
					new Error(`Browser attempted external request: ${url.origin}${url.pathname}`),
				);
				void request.abort("blockedbyclient").catch(() => {});
			}
		});
		const session = await page.createCDPSession();
		await session.send("Network.enable");
		// A full run makes ~30 page loads: the original 22 plus site configuration/reload.
		// Measured loads cost ~6 MiB/~350 responses; keep byte/response caps finite without
		// increasing browser process count or ever collecting full network bodies.
		session.on("Network.dataReceived", (event) => {
			this.networkBytes += Math.max(event.dataLength, event.encodedDataLength);
			if (this.networkBytes > 256 * BODY_BYTES)
				this.context.controller.abort(new Error("Browser network body budget exceeded"));
		});
		session.on("Network.loadingFinished", () => {
			if (++this.responses > 16_384)
				this.context.controller.abort(new Error("Browser response count budget exceeded"));
		});
		await page.evaluateOnNewDocument(
			(token, language) => {
				localStorage.setItem("narrafork_token", token);
				localStorage.setItem("narrafork_lang", language);
			},
			this.context.localeTokens.get(locale) ?? this.context.token,
			locale,
		);
		return page;
	}

	async navigate(): Promise<void> {
		for (const locale of LOCALES) {
			const settings = this.settings.get(locale);
			const narrator = this.narrators.get(locale);
			if (!settings || !narrator) throw new Error("Missing locale page");
			await settings.bringToFront();
			await boundedQuotaWork(
				settings.goto(`${this.context.origin}/settings/providers?provider=${PROVIDER_ID}`, {
					waitUntil: "domcontentloaded",
				}),
				this.context.signal,
			);
			try {
				await settings.waitForFunction(
					(name) =>
						[...document.querySelectorAll("input")].some(
							(input) => input.value === name && input.getBoundingClientRect().height > 0,
						),
					{ polling: 100 },
					PROVIDER_NAME,
				);
			} catch (error) {
				await this.screenshot(settings, `failure-provider-navigation-${locale}`);
				this.context.report.browser = {
					...object(this.context.report.browser),
					failurePage: redactQuotaEvidence(
						{ url: settings.url(), text: await this.text(settings) },
						this.context.secrets,
					),
				};
				throw error;
			}
			await narrator.bringToFront();
			await boundedQuotaWork(
				narrator.goto(`${this.context.origin}/narrators/${this.narratorId}`, {
					waitUntil: "domcontentloaded",
				}),
				this.context.signal,
			);
			await narrator.waitForSelector(MODEL_SELECT, { visible: true });
		}
	}

	private async screenshot(page: Page, name: string): Promise<void> {
		// 42 screenshots in a full pass, plus room for the failure capture.
		// ~38 original lifecycle captures + ~44 site/group/reload captures, plus failure evidence.
		// Images are written one at a time; never retain all screenshots in memory.
		if (++this.screenshots > 88) throw new Error("Screenshot count exceeds smoke budget");
		const image = await boundedQuotaWork(
			page.screenshot({ type: "png", fullPage: false }),
			this.context.signal,
		);
		this.screenshotBytes += image.byteLength;
		if (image.byteLength > 4 * BODY_BYTES || this.screenshotBytes > 96 * BODY_BYTES)
			throw new Error("Screenshot bytes exceed smoke budget");
		await writeFile(join(this.context.options.out, `${name}.png`), image, {
			flag: "wx",
			mode: 0o600,
		});
	}

	private async text(page: Page): Promise<string> {
		return boundedQuotaWork(
			page.evaluate(() => document.body.innerText.slice(0, 256 * 1024)),
			this.context.signal,
		);
	}

	/**
	 * The trigger's aria-expanded is the menu's real state. A dropdown that is still mounted
	 * only proves its close transition has not finished: Chromium pauses that transition
	 * while the tab is in the background, so after Escape and a tab switch the old dropdown
	 * can stay in the DOM until this tab is brought back to the front.
	 */
	private async openModelMenu(page: Page): Promise<void> {
		await page.bringToFront();
		const expanded = await page.evaluate(
			(selector) => document.querySelector(selector)?.getAttribute("aria-expanded") === "true",
			MODEL_SELECT,
		);
		// Locator waits for a stable bounding box while quota text changes the bar width.
		if (!expanded) await page.locator(MODEL_SELECT).click();
		await page.waitForFunction(
			(selector) => {
				const select = document.querySelector(selector);
				const dropdown = select ? document.getElementById(`${select.id}-dropdown`) : null;
				return (
					select?.getAttribute("aria-expanded") === "true" &&
					dropdown?.hasAttribute("data-model-menu-scroll") === true &&
					dropdown.getBoundingClientRect().height > 0
				);
			},
			{ polling: 100 },
			MODEL_SELECT,
		);
		// Current releases keep the logical model/Auto browser separate from provider badges.
		await this.modelMenuView(page, "provider");
	}

	private async modelMenuView(page: Page, mode: "model" | "provider"): Promise<void> {
		const button = await page.evaluateHandle(
			(selector, value) => {
				const trigger = document.querySelector(selector);
				const menu = trigger ? document.getElementById(`${trigger.id}-dropdown`) : null;
				return (
					menu?.querySelector<HTMLButtonElement>(`button[data-model-menu-mode="${value}"]`) ?? null
				);
			},
			MODEL_SELECT,
			mode,
		);
		try {
			const element = button.asElement() as ElementHandle<HTMLButtonElement> | null;
			if (!element) throw new Error("Current model/provider menu controls were not rendered");
			await element.click();
			await page.waitForFunction(
				(selector, value) => {
					const trigger = document.querySelector(selector);
					const menu = trigger ? document.getElementById(`${trigger.id}-dropdown`) : null;
					return (
						trigger?.getAttribute("aria-expanded") === "true" &&
						Boolean(
							menu?.querySelector(`button[data-model-menu-mode="${value}"][data-variant="light"]`),
						)
					);
				},
				{ polling: 100 },
				MODEL_SELECT,
				mode,
			);
		} finally {
			await button.dispose();
		}
	}

	/** Close the menu and wait, with this tab in front, until its dropdown has unmounted. */
	private async closeModelMenu(page: Page): Promise<void> {
		await page.bringToFront();
		const expanded = await page.evaluate(
			(selector) => document.querySelector(selector)?.getAttribute("aria-expanded") === "true",
			MODEL_SELECT,
		);
		if (expanded) await page.keyboard.press("Escape");
		await page.waitForFunction(
			(selector) => {
				const select = document.querySelector(selector);
				return (
					select?.getAttribute("aria-expanded") === "false" &&
					!document.getElementById(`${select.id}-dropdown`)
				);
			},
			{ polling: 100 },
			MODEL_SELECT,
		);
	}

	/** Keep the original error; failure evidence is best effort. */
	private async recordFailure(page: Page, name: string): Promise<void> {
		try {
			await this.screenshot(page, `failure-${name}`);
			const diagnostics = await page.evaluate((selector) => {
				const select = document.querySelector(selector);
				return {
					language: document.documentElement.lang,
					storedLanguage: localStorage.getItem("narrafork_lang"),
					modelMenu: {
						expanded: select?.getAttribute("aria-expanded") ?? null,
						dropdownMounted: select
							? document.getElementById(`${select.id}-dropdown`) !== null
							: false,
						mountedMenus: document.querySelectorAll("[data-model-menu-scroll]").length,
					},
					buttons: [...document.querySelectorAll("button")].slice(0, 80).map((button) => ({
						text: button.innerText,
						label: button.getAttribute("aria-label"),
						expanded: button.getAttribute("aria-expanded"),
					})),
				};
			}, MODEL_SELECT);
			this.context.report.browser = {
				...object(this.context.report.browser),
				failurePage: redactQuotaEvidence(
					{ name, url: page.url(), text: await this.text(page), diagnostics },
					this.context.secrets,
				),
			};
		} catch {
			// The page may already be gone; the original failure is what matters.
		}
	}

	async active(remaining: number, phase: string, group?: string): Promise<void> {
		const stage = this.context.stage;
		for (const locale of LOCALES) {
			const settings = this.settings.get(locale);
			const narrator = this.narrators.get(locale);
			if (!settings || !narrator) throw new Error("Missing locale page");
			for (const [kind, page] of [
				["settings", settings],
				["narrator", narrator],
			] as const) {
				await page.bringToFront();
				try {
					this.context.stage = `browser ${phase} ${locale} ${kind} quota indicator`;
					await page.waitForFunction(
						(selector, balance, group) =>
							[...document.querySelectorAll(selector)].some(
								(element) =>
									element.getBoundingClientRect().height > 0 &&
									element.textContent?.trim() === `USD ${balance}` &&
									(!group || element.getAttribute("aria-label")?.includes(group)),
							),
						{ polling: 100 },
						QUOTA_TRIGGER,
						String(remaining),
						group ?? "",
					);
					const text = await this.text(page);
					if (quotaUiHasUnavailable(text))
						throw new Error(`${locale} ${kind}: unavailable quota placeholder remained`);
					if (group) {
						await page.hover(QUOTA_TRIGGER);
						await page.waitForFunction(
							(value) => document.body.innerText.includes(value),
							{ polling: 100 },
							group,
						);
						await this.screenshot(page, `${phase}-group-${locale}-${kind}`);
						await page.mouse.move(0, 0);
						await page.waitForFunction(
							(selector) =>
								[...document.querySelectorAll(selector)].every(
									(element) => element.getAttribute("aria-expanded") === "false",
								),
							{ polling: 100 },
							QUOTA_TRIGGER,
						);
					}
					if (kind === "settings") {
						this.context.stage = `browser ${phase} ${locale} settings refresh label`;
						await page.waitForFunction(
							(label) =>
								[...document.querySelectorAll("button")].some(
									(button) => button.innerText.trim() === label,
								),
							{ polling: 100 },
							REFRESH_LABELS[locale],
						);
					} else {
						this.context.stage = `browser ${phase} ${locale} model menu balance`;
						await this.openModelMenu(page);
						await page.waitForFunction(
							(selector, balance) =>
								document.querySelector(selector)?.textContent?.trim() === `USD ${balance}`,
							{ polling: 100 },
							MODEL_BALANCE,
							String(remaining),
						);
					}
					await this.screenshot(page, `${phase}-${locale}-${kind}`);
					if (kind === "narrator") {
						this.context.stage = `browser ${phase} ${locale} model menu close`;
						await this.closeModelMenu(page);
					}
				} catch (error) {
					await this.recordFailure(page, `${phase}-${locale}-${kind}`);
					throw error;
				}
			}
		}
		this.context.stage = stage;
		this.context.check(`browser ${phase}: settings, status bar and model menu in en/zh-CN`, {
			remaining,
			...(group ? { group } : {}),
		});
	}

	async requestRefresh(
		locale: SmokeLocale,
		mode: "probe" | "refresh" = "refresh",
		prepare?: () => void,
	): Promise<void> {
		const stage = this.context.stage;
		const page = this.settings.get(locale);
		if (!page) throw new Error("No settings page for refresh");
		await page.bringToFront();
		// The real route enforces a ten-second manual cooldown; do not disable or bypass it.
		await this.context.wait(
			"real quota manual cooldown",
			async () => {
				const snapshot = await quotaSnapshot(this.context);
				const attemptedAt = Number(snapshot?.attemptedAt);
				return snapshot &&
					!["pending", "probing"].includes(String(snapshot.status)) &&
					Number.isFinite(attemptedAt) &&
					Date.now() - attemptedAt >= MANUAL_THROTTLE_MS + 100 &&
					performance.now() - this.manualAt >= MANUAL_THROTTLE_MS + 100
					? true
					: undefined;
			},
			30_000,
		);
		const refreshPath = `/api/provider-quotas/${PROVIDER_ID}/refresh`;
		// Bounded /api timeline, so a refresh that never answers shows whether the click sent
		// a request at all, and whether the request or only its response went missing.
		const startedAt = performance.now();
		const trace: Array<{
			at: number;
			event: string;
			method: string;
			path: string;
			detail?: string;
		}> = [];
		const record = (event: string, request: HTTPRequest, detail?: string) => {
			const path = new URL(request.url()).pathname;
			if (!path.startsWith("/api/") || trace.length >= 64) return;
			trace.push({
				at: Math.round(performance.now() - startedAt),
				event,
				method: request.method(),
				path,
				...(detail ? { detail: detail.slice(0, 120) } : {}),
			});
		};
		const onRequest = (request: HTTPRequest) => record("request", request);
		const onFinished = (request: HTTPRequest) =>
			record("finished", request, String(request.response()?.status() ?? ""));
		const onFailed = (request: HTTPRequest) =>
			record("failed", request, request.failure()?.errorText ?? "unknown");
		page.on("request", onRequest);
		page.on("requestfinished", onFinished);
		page.on("requestfailed", onFailed);
		const label =
			mode === "refresh" ? REFRESH_LABELS[locale] : PROBE_LABELS[locale === "en" ? 0 : 1];
		let clickedAt: number | undefined;
		try {
			this.context.stage = `browser ${locale} refresh button enabled`;
			await page.waitForFunction(
				(label) =>
					[...document.querySelectorAll("button")].some(
						(button) =>
							button.innerText.trim() === label &&
							!button.disabled &&
							button.getBoundingClientRect().height > 0,
					),
				{ polling: 100 },
				label,
			);
			prepare?.();
			const response = page.waitForResponse(
				(response) =>
					response.request().method() === "POST" &&
					new URL(response.url()).pathname === refreshPath,
				{ timeout: REQUEST_MS },
			);
			void response.catch(() => {});
			const button = await page.evaluateHandle(
				(label) =>
					[...document.querySelectorAll("button")].find(
						(button) =>
							button.innerText.trim() === label &&
							!button.disabled &&
							button.getBoundingClientRect().height > 0,
					) ?? null,
				label,
			);
			try {
				const element = button.asElement() as ElementHandle<HTMLButtonElement> | null;
				if (!element) throw new Error("Real localized refresh button is not available");
				this.context.stage = `browser ${locale} refresh request`;
				await element.click();
				clickedAt = Math.round(performance.now() - startedAt);
				const refreshed = await response;
				if (!refreshed.ok())
					throw new Error(`Real UI quota refresh failed with HTTP ${refreshed.status()}`);
				const sent = object(JSON.parse(refreshed.request().postData() ?? "{}"));
				if (sent.mode !== mode)
					throw new Error("Real UI quota action did not send the requested refresh/probe mode");
				this.manualAt = performance.now();
				const traces = object(this.context.report.browser).refreshTraces;
				const previous = Array.isArray(traces) ? traces : [];
				if (previous.length >= 12) throw new Error("Refresh timeline count exceeded smoke budget");
				this.context.report.browser = {
					...object(this.context.report.browser),
					refreshTraces: [
						...previous,
						{ locale, mode, clickedAt, status: refreshed.status(), requests: trace },
					],
				};
			} finally {
				await button.dispose();
			}
		} catch (error) {
			const button = await page
				.evaluate(
					(label) =>
						[...document.querySelectorAll("button")]
							.filter((button) => button.innerText.trim() === label)
							.map((button) => ({
								disabled: button.disabled,
								loading: button.hasAttribute("data-loading"),
								height: Math.round(button.getBoundingClientRect().height),
							})),
					label,
				)
				.catch(() => null);
			this.context.report.browser = {
				...object(this.context.report.browser),
				refreshTrace: {
					locale,
					startedAt: new Date(Date.now() - (performance.now() - startedAt)).toISOString(),
					clickedAt,
					button,
					requests: trace,
				},
			};
			await this.recordFailure(page, `refresh-${locale}-settings`);
			throw error;
		} finally {
			page.off("request", onRequest);
			page.off("requestfinished", onFinished);
			page.off("requestfailed", onFailed);
		}
		this.context.stage = stage;
	}

	async refresh(locale: SmokeLocale, remaining: number): Promise<void> {
		const fixture = this.context.fixture;
		if (!fixture) throw new Error("No inference fixture for refresh");
		const usageBefore = fixture.evidence().counts["/api/usage/token/"] ?? 0;
		await this.requestRefresh(locale, "refresh", () => fixture.setRemaining(remaining));
		await requireBalance(
			this.context,
			remaining,
			`${locale} UI refresh -> plugin RPC -> HTTP -> host cache`,
		);
		if ((fixture.evidence().counts["/api/usage/token/"] ?? 0) <= usageBefore)
			throw new Error("UI refresh did not reach the real upstream usage fixture");
	}

	async siteRefresh(locale: SmokeLocale, remaining: number): Promise<void> {
		const fixture = this.context.siteFixture;
		if (!fixture) throw new Error("No site fixture for refresh");
		const requestsBefore = fixture.evidence().requests;
		await this.requestRefresh(locale, "refresh", () => fixture.setRemaining(remaining));
		await requireSiteBalance(
			this.context,
			remaining,
			`${locale} UI refresh -> site-account RPC -> /api/user/self -> host cache`,
		);
		if (fixture.evidence().requests <= requestsBefore)
			throw new Error("Real site-account UI refresh did not reach its own origin");
		assertSiteCredentialIsolation(fixture.evidence().records);
	}

	async siteFields(siteOrigin: string, phase: string): Promise<void> {
		const tokenLabels: Record<SmokeLocale, string> = {
			en: "Site access token",
			"zh-CN": "站点访问令牌",
		};
		for (const locale of LOCALES) {
			const page = this.settings.get(locale);
			if (!page) throw new Error("Missing site settings page");
			await page.bringToFront();
			await page.waitForFunction(
				(origin, userId, label) => {
					const inputs = [...document.querySelectorAll("input")];
					const tokenLabel = [...document.querySelectorAll<HTMLLabelElement>("label[for]")].find(
						(element) => element.textContent?.trim() === label,
					);
					const tokenInput = tokenLabel
						? (document.getElementById(tokenLabel.htmlFor) as HTMLInputElement | null)
						: null;
					return (
						inputs.some((input) => input.value === origin) &&
						inputs.some((input) => input.value === userId) &&
						tokenInput?.type === "password" &&
						tokenInput.value.length > 0
					);
				},
				{ polling: 100 },
				siteOrigin,
				SITE_USER_ID,
				tokenLabels[locale],
			);
			await this.screenshot(page, `${phase}-${locale}-site-settings`);
		}
		this.context.check("saved site URL, masked access token and UserId fields in en/zh-CN");
	}

	async siteFailure(phase: string): Promise<void> {
		const stage = this.context.stage;
		for (const locale of LOCALES) {
			const settings = this.settings.get(locale);
			const narrator = this.narrators.get(locale);
			if (!settings || !narrator) throw new Error("Missing site failure page");
			for (const [kind, page] of [
				["settings", settings],
				["narrator", narrator],
			] as const) {
				try {
					this.context.stage = `browser ${phase} ${locale} ${kind} site good value cleared`;
					await page.bringToFront();
					await page.waitForFunction(
						(selector) =>
							[...document.querySelectorAll(selector)].some(
								(element) =>
									element.getBoundingClientRect().height > 0 &&
									element.textContent?.trim() &&
									!/USD\s+-?(?:\d+(?:\.\d+)?|\.\d+)/.test(element.getAttribute("aria-label") ?? ""),
							),
						{ polling: 100 },
						QUOTA_TRIGGER,
					);
					if (kind === "narrator") await this.openModelMenu(page);
					else
						await page.waitForFunction(
							(label) =>
								[...document.querySelectorAll("button")].some(
									(button) => button.innerText.trim() === label,
								),
							{ polling: 100 },
							PROBE_LABELS[locale === "en" ? 0 : 1],
						);
					const text = await this.text(page);
					if (
						quotaUiHasUnavailable(text) ||
						/USD\s+-?(?:\d+(?:\.\d+)?|\.\d+)/.test(text) ||
						text.includes(SITE_GROUP)
					)
						throw new Error(
							"Failed site account still displayed a good balance/group or key fallback",
						);
					await this.screenshot(page, `${phase}-${locale}-${kind}`);
					if (kind === "narrator") {
						await this.modelMenuView(page, "model");
						const menuText = await this.text(page);
						if (
							quotaUiHasUnavailable(menuText) ||
							/USD\s+-?(?:\d+(?:\.\d+)?|\.\d+)/.test(menuText) ||
							menuText.includes(SITE_GROUP)
						)
							throw new Error("Logical model/Auto view revived failed site quota");
						await this.screenshot(page, `${phase}-${locale}-model-view`);
						await this.modelMenuView(page, "provider");
						await this.closeModelMenu(page);
					}
				} catch (error) {
					await this.recordFailure(page, `${phase}-${locale}-${kind}`);
					throw error;
				}
			}
		}
		this.context.stage = stage;
		this.context.check(
			`browser ${phase}: cleared wallet/group without key fallback in settings, status bar and model/provider views`,
		);
	}

	async leavePanelsOpen(phase: string): Promise<void> {
		const stage = this.context.stage;
		for (const [locale, page] of this.settings) {
			this.context.stage = `browser ${phase} ${locale} settings quota popover`;
			try {
				await page.bringToFront();
				// After a navigation the trigger renders only once the quota snapshot has loaded.
				await page.waitForFunction(
					(selector) => (document.querySelector(selector)?.getBoundingClientRect().height ?? 0) > 0,
					{ polling: 100 },
					QUOTA_TRIGGER,
				);
				await page.hover(QUOTA_TRIGGER);
				await page.waitForFunction(
					(selector) =>
						[...document.querySelectorAll(selector)].some(
							(element) => element.getAttribute("aria-expanded") === "true",
						),
					{ polling: 100 },
					QUOTA_TRIGGER,
				);
			} catch (error) {
				await this.recordFailure(page, `${phase}-${locale}-settings`);
				throw error;
			}
		}
		for (const [locale, page] of this.narrators) {
			this.context.stage = `browser ${phase} ${locale} narrator model menu`;
			try {
				await this.openModelMenu(page);
			} catch (error) {
				await this.recordFailure(page, `${phase}-${locale}-narrator`);
				throw error;
			}
		}
		this.context.stage = stage;
	}

	async unavailable(phase: string): Promise<void> {
		const stage = this.context.stage;
		for (const locale of LOCALES) {
			const settings = this.settings.get(locale);
			const narrator = this.narrators.get(locale);
			if (!settings || !narrator) throw new Error("Missing locale page");
			for (const [kind, page] of [
				["settings", settings],
				["narrator", narrator],
			] as const) {
				try {
					this.context.stage = `browser ${phase} ${locale} ${kind} quota indicator hidden`;
					await page.bringToFront();
					await page.waitForFunction(
						(selector) => document.querySelectorAll(selector).length === 0,
						{ polling: 100 },
						QUOTA_TRIGGER,
					);
					if (kind === "narrator") {
						this.context.stage = `browser ${phase} ${locale} model menu badge hidden`;
						await this.openModelMenu(page);
						await page.waitForFunction(
							(selector) => document.querySelectorAll(selector).length === 0,
							{ polling: 100 },
							MODEL_BALANCE,
						);
					}
					const text = await this.text(page);
					if (quotaUiHasUnavailable(text) || /USD\s+(?:12\.34|23\.45|17\.89|0)(?![\d.])/.test(text))
						throw new Error(
							`${locale} ${kind}: unavailable placeholder or old quota survived ${phase}`,
						);
					const controls = await page.evaluate(
						(labels) =>
							[...document.querySelectorAll("button")].some((button) =>
								labels.includes(button.innerText.trim()),
							),
						[...Object.values(REFRESH_LABELS), ...PROBE_LABELS],
					);
					if (controls) throw new Error(`${locale} ${kind}: quota controls survived ${phase}`);
					await this.screenshot(page, `${phase}-${locale}-${kind}`);
					if (kind === "narrator") {
						this.context.stage = `browser ${phase} ${locale} model menu close`;
						await this.closeModelMenu(page);
					}
				} catch (error) {
					await this.recordFailure(page, `${phase}-${locale}-${kind}`);
					throw error;
				}
			}
		}
		this.context.stage = stage;
		this.context.check(
			`browser ${phase}: no placeholder, stale value, open quota popover or model badge`,
		);
	}

	async pluginPage(absent: boolean, phase: string): Promise<void> {
		const page = await this.newPage("en");
		const path = absent ? "/api/plugins" : `/api/plugins/${PLUGIN_ID}`;
		const loaded = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === path && response.request().method() === "GET",
			{ timeout: REQUEST_MS },
		);
		void loaded.catch(() => {});
		try {
			await boundedQuotaWork(
				page.goto(`${this.context.origin}/settings/plugins${absent ? "" : `/${PLUGIN_ID}`}`, {
					waitUntil: "domcontentloaded",
				}),
				this.context.signal,
			);
			if (!(await loaded).ok()) throw new Error("Real plugins page did not load its API data");
			if (absent) {
				await page.waitForFunction(
					(id, emptyText) =>
						document.body.innerText.includes(emptyText) &&
						Boolean(document.querySelector(`[data-builtin-plugin="${id}"]`)),
					{ polling: 100 },
					PLUGIN_ID,
					PLUGINS_EMPTY_TEXT,
				);
				const catalog = await this.context.require("/api/plugins/builtins");
				const entries = object(catalog).builtins;
				const builtin = Array.isArray(entries)
					? entries.map(object).find((item) => item.pluginId === PLUGIN_ID)
					: undefined;
				if (
					builtin?.installed !== false ||
					builtin?.canInstall !== true ||
					builtin.version !== EXPECTED_VERSION
				)
					throw new Error(
						"Uninstalled builtin is not directly reinstallable from the trusted catalog",
					);
			} else {
				await page.waitForFunction(
					(id, version) =>
						document.body.innerText.includes(id) && document.body.innerText.includes(version),
					{ polling: 100 },
					PLUGIN_ID,
					EXPECTED_VERSION,
				);
			}
			await this.screenshot(page, `${phase}-en-plugins`);
			this.context.check(`real plugins page ${phase}`);
		} finally {
			await boundedQuotaWork(page.close(), this.context.signal);
		}
	}

	async reinstallBuiltin(): Promise<void> {
		const page = await this.newPage("en");
		try {
			await page.goto(`${this.context.origin}/settings/plugins`, { waitUntil: "domcontentloaded" });
			const selector = `[data-builtin-plugin="${PLUGIN_ID}"] button`;
			await page.waitForSelector(selector);
			await page.waitForFunction(
				(selector) => {
					const button = document.querySelector(selector);
					return button instanceof HTMLButtonElement && !button.disabled;
				},
				{ polling: 100 },
				selector,
			);
			const installing = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === `/api/plugins/builtins/${PLUGIN_ID}/install` &&
					response.request().method() === "POST",
				{ timeout: REQUEST_MS },
			);
			void installing.catch(() => {});
			await page.click(selector);
			const response = await installing;
			if (response.status() !== 202)
				throw new Error("Builtin reinstall UI did not start the trusted local install job");
			const started = object(await response.json());
			if (typeof started.jobId !== "string") throw new Error("Builtin install job id missing");
			const job = await this.context.wait("builtin install job", async () => {
				const job = object(await this.context.require(`/api/plugins/update-jobs/${started.jobId}`));
				return ["succeeded", "failed", "cancelled", "manual_required"].includes(String(job.status))
					? job
					: undefined;
			});
			if (job.status !== "succeeded")
				throw new Error(`Builtin reinstall job failed: ${String(job.error)}`);
			await this.screenshot(page, "builtin-reinstalled-en-plugins");
			this.context.check("trusted builtin directly reinstalls through real plugin-page UI", {
				jobId: started.jobId,
				status: job.status,
			});
		} finally {
			await page.close();
		}
	}

	evidence(): unknown {
		return {
			networkBytes: this.networkBytes,
			responses: this.responses,
			screenshots: this.screenshots,
			screenshotBytes: this.screenshotBytes,
			locales: LOCALES,
		};
	}
}

async function runSiteAcceptance(
	context: QuotaSmokeContext,
	browser: QuotaBrowserSmoke,
): Promise<void> {
	const inference = context.fixture;
	if (!inference) throw new Error("Site acceptance requires the independent inference fixture");
	context.stage = "independent site-account configuration and credential isolation";
	const accessToken = `quota_site_${randomUUID()}`;
	const inferenceHeaderSecret = `inference_header_${randomUUID()}`;
	const inferenceCookie = `quota_inference_cookie=${randomUUID()}`;
	const inferenceUser = "not-the-site-user";
	const apiKey = String(context.providerConfig.apiKey);
	context.secrets.push(accessToken, inferenceHeaderSecret, inferenceCookie);
	const site = createSiteQuotaFixture(
		{
			accessToken,
			userId: SITE_USER_ID,
			inferenceSecrets: [apiKey, inferenceHeaderSecret, inferenceCookie, inferenceUser],
		},
		context.signal,
		(error) => context.controller.abort(error),
	);
	context.siteFixture = site;
	if (site.origin === inference.origin || site.origin === context.origin)
		throw new Error("Site quota must use an independent origin");
	context.providerConfig = {
		...context.providerConfig,
		quotaSiteUrl: site.origin,
		quotaAccessToken: accessToken,
		quotaUserId: SITE_USER_ID,
		extraHeaders: {
			"X-Smoke-Inference": inferenceHeaderSecret,
			"X-API-Key": apiKey,
			Cookie: inferenceCookie,
			"New-Api-User": inferenceUser,
		},
	};
	await context.require("/api/settings", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ customApiProviders: [context.providerConfig] }),
	});
	const settings = object(await context.require("/api/settings"));
	const provider = Array.isArray(settings.customApiProviders)
		? settings.customApiProviders.map(object).find((entry) => entry.id === PROVIDER_ID)
		: undefined;
	if (
		!provider ||
		provider.quotaSiteUrl !== site.origin ||
		provider.quotaUserId !== SITE_USER_ID ||
		typeof provider.quotaAccessToken !== "string" ||
		!provider.quotaAccessToken ||
		provider.quotaAccessToken === accessToken
	)
		throw new Error("Site settings were not saved with the exact origin/UserId and masked token");
	const keyList = object(await context.require(`/api/provider-keys/${PROVIDER_ID}`));
	if (
		!Array.isArray(keyList.keys) ||
		keyList.keys.length !== 1 ||
		object(keyList.keys[0]).id !== context.inferenceKeyId
	)
		throw new Error("Site token entered or displaced the inference key pool");
	context.check(context.stage, {
		siteOrigin: site.origin,
		inferenceOrigin: inference.origin,
		inferenceKeyPoolUnchanged: true,
		tokenMasked: true,
	});

	await requireSiteBalance(
		context,
		SITE_INITIAL_BALANCE,
		"authoritative /api/user/self -> plugin RPC -> host wallet cache",
	);
	assertSiteCredentialIsolation(site.evidence().records);
	context.check(
		"host injects only site token and New-Api-User; inference extraHeaders/API Key never reach site",
		site.evidence(),
	);
	inference.setRemaining(49.99); // A fallback would be visibly different from every account value.
	const keyQuotaCalls = () =>
		Object.entries(inference.evidence().counts).reduce(
			(total, [path, count]) => total + (path === "/v1/models" ? 0 : count),
			0,
		);
	const beforeSiteFailures = keyQuotaCalls();
	await browser.navigate();
	await browser.siteFields(site.origin, "site-configured");
	await browser.active(SITE_INITIAL_BALANCE, "site-initial", SITE_GROUP);
	context.stage = "real English site wallet refresh";
	await browser.siteRefresh("en", SITE_REFRESHED_BALANCE);
	await browser.active(SITE_REFRESHED_BALANCE, "site-refreshed", SITE_GROUP);
	context.stage = "real Chinese site wallet zero/group display";
	await browser.siteRefresh("zh-CN", 0);
	await browser.active(0, "site-zero", SITE_GROUP);

	context.stage = "site 401 clears an existing good zero/group without inference fallback";
	await browser.leavePanelsOpen("before-site-401");
	const previous = await quotaSnapshot(context);
	await browser.requestRefresh("en", "refresh", () => site.setMode("unauthorized"));
	const rejected = await requireSiteFailure(
		context,
		"auth_failed",
		Number(previous?.version),
		"site HTTP 401 -> auth_failed with null wallet cache",
	);
	assertSiteCredentialIsolation(site.evidence().records);
	if (!site.evidence().records.some((record) => record.status === 401))
		throw new Error("Account failure did not reach a real site HTTP 401");
	if (keyQuotaCalls() !== beforeSiteFailures)
		throw new Error("Site query silently fell back to inference-key allowance");
	await browser.siteFailure("site-401");
	context.check("site 401 does not query the still-healthy inference allowance", {
		inferenceQuotaRequests: beforeSiteFailures,
	});

	context.stage = "network failure after auth failure must not resurrect a previous wallet/group";
	await browser.requestRefresh("zh-CN", "probe", () => site.disconnect());
	const failed = await requireSiteFailure(
		context,
		"request_failed",
		Number(rejected.version),
		"site socket unavailable after 401 -> request_failed with null wallet cache",
	);
	if (keyQuotaCalls() !== beforeSiteFailures)
		throw new Error("Network failure retried inference-key allowance instead of the site account");
	await browser.siteFailure("site-network-after-401");
	const health = await context.http("/api/health");
	if (!health.ok) throw new Error("Fixture network failure affected the owned host process");
	const models = object(
		await context.require(`/api/openai/providers/${PROVIDER_ID}/models/refresh`, {
			method: "POST",
		}),
	);
	if (
		!Array.isArray(models.models) ||
		!models.models.some((model) => String(object(model).id).includes(MODEL_ID))
	)
		throw new Error(
			"Inference fixture did not remain healthy during the site-only network failure",
		);
	// Reload real readers as well: stale success must not survive a new query/client cache.
	await browser.navigate();
	await browser.siteFailure("site-network-after-reload");
	const reread = await quotaSnapshot(context);
	assertSiteQuotaFailure(reread, "request_failed");
	if (Number(reread?.version) < Number(failed.version) || keyQuotaCalls() !== beforeSiteFailures)
		throw new Error("A later read restored a previous good wallet or consulted the inference key");
	context.check(
		"network failure and subsequent reader reload do not revive cleared wallet/group or fall back",
		{
			accountError: "request_failed",
			inferenceStillHealthy: true,
			inferenceQuotaRequests: beforeSiteFailures,
		},
	);
	context.report.siteFixture = site.evidence();
}

async function runAcceptance(context: QuotaSmokeContext): Promise<void> {
	context.stage = "default bundled plugin enabled and active";
	const builtin = await requireActivePlugin(context, context.stage);
	context.stage = "real repeated multipart File archive installation";
	const first = await context.upload("multipart File archive install");
	const second = await context.upload("identical archive repeat install");
	if (!first.ok || !second.ok) throw new Error("Identical multipart archive installation failed");
	const hashes = [builtin.current, object(first.body).current, object(second.body).current].map(
		(current) => object(current).hash,
	);
	if (!hashes.every((hash) => typeof hash === "string" && hash === hashes[0]))
		throw new Error("Builtin and identical archive uploads did not preserve the same package hash");
	if (
		object(second.body).compatibility !== "compatible" ||
		object(second.body).desiredState !== "disabled"
	)
		throw new Error("Multipart install did not produce a compatible disabled package");
	context.check(context.stage, {
		hash: hashes[0],
		archiveField: "File archive",
		repeatStatus: second.status,
	});
	await context.lifecycle("enable");
	await context.lifecycle("activate");
	await requireActivePlugin(
		context,
		"explicit enable/activate after repeated upload without system Bun",
	);

	context.stage = "test Custom API fixture configuration";
	const key = `quota_test_${randomUUID()}`;
	context.secrets.push(key);
	context.fixture = createQuotaFixture(key, context.signal, (error) =>
		context.controller.abort(error),
	);
	context.providerConfig = {
		id: PROVIDER_ID,
		name: PROVIDER_NAME,
		prefix: MODEL_PREFIX,
		apiKey: "",
		baseUrl: `${context.fixture.origin}/v1`,
		defaultModel: MODEL_ID,
		protocol: "completions-compatible",
		proxy: { mode: "direct" },
	};
	await context.require("/api/settings", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			customApiProviders: [context.providerConfig],
			agent: { defaultModel: FULL_MODEL_ID },
		}),
	});
	const added = object(
		await context.require(`/api/provider-keys/${PROVIDER_ID}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ apiKey: key, label: "Quota smoke inference key" }),
		}),
	);
	const storedKey = object(added.key);
	if (
		typeof storedKey.id !== "string" ||
		storedKey.disabled !== false ||
		storedKey.apiKey !== undefined
	)
		throw new Error(
			"Real provider-key API did not store one active key with a credential-free response",
		);
	context.inferenceKeyId = storedKey.id;
	context.providerConfig.apiKey = key;
	const keyList = object(await context.require(`/api/provider-keys/${PROVIDER_ID}`));
	if (
		!Array.isArray(keyList.keys) ||
		keyList.keys.length !== 1 ||
		object(keyList.keys[0]).id !== storedKey.id
	)
		throw new Error("Provider settings did not preserve the newly stored inference key");
	context.check("real current provider-key API and masked key settings", { keyId: storedKey.id });
	const settings = object(await context.require("/api/settings"));
	if (typeof object(settings.providerQuotaGenerations)[PROVIDER_ID] !== "string")
		throw new Error("Saved provider did not receive a host quota generation");
	const models = object(
		await context.require(
			`/api/openai/providers/${PROVIDER_ID}/models/refresh`,
			{ method: "POST" },
			"real upstream model discovery",
		),
	);
	if (
		!Array.isArray(models.models) ||
		!models.models.some((model) => String(object(model).id).includes(MODEL_ID))
	)
		throw new Error("Real /v1/models fixture did not populate provider models");
	context.check(context.stage, {
		providerId: PROVIDER_ID,
		generation: object(settings.providerQuotaGenerations)[PROVIDER_ID],
	});
	const initialQuota = await requireBalance(
		context,
		12.34,
		"initial plugin RPC -> relay usage/status HTTP -> host quota API",
	);
	if (
		initialQuota.keyId !== context.inferenceKeyId ||
		initialQuota.targetId !== `custom-api/${PROVIDER_ID}`
	)
		throw new Error("Inference-key quota did not follow the current stored-key subject");
	context.check("current pooled inference-key quota identity", {
		keyId: context.inferenceKeyId,
		targetId: initialQuota.targetId,
	});
	const initialCounts = context.fixture.evidence().counts;
	for (const path of ["/v1/models", "/api/usage/token/", "/api/status"])
		if (!initialCounts[path])
			throw new Error(`Real upstream fixture route was not called: ${path}`);

	await context.require("/api/user-preferences", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ setupWizardCompleted: true }),
	});
	// App init restores the account's saved language. Use two real test accounts
	// and isolated browser contexts rather than mocking preferences or translations.
	const chineseUsername = `quota_zh_${randomUUID().replaceAll("-", "").slice(0, 14)}`;
	const chinesePassword = randomUUID();
	context.secrets.push(chinesePassword);
	await context.require(
		"/api/admin/users",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				username: chineseUsername,
				password: chinesePassword,
				role: "admin",
				language: "zh-CN",
			}),
		},
		"isolated Chinese-language test account",
	);
	const chineseLogin = object(
		await context.require("/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: chineseUsername, password: chinesePassword }),
		}),
	);
	if (typeof chineseLogin.token !== "string")
		throw new Error("Chinese test account login did not issue a token");
	context.secrets.push(chineseLogin.token);
	context.localeTokens.set("zh-CN", chineseLogin.token);
	const originalToken = context.token;
	try {
		context.token = chineseLogin.token;
		await context.require("/api/user-preferences", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ language: "zh-CN", setupWizardCompleted: true }),
		});
	} finally {
		context.token = originalToken;
	}
	const narrator = object(
		await context.require("/api/narrators", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Quota smoke narrator",
				cwd: context.cwd,
				model: FULL_MODEL_ID,
			}),
		}),
	);
	if (typeof narrator.id !== "string") throw new Error("Test narrator creation failed");
	context.check("test narrator using the fixture model");
	context.stage = "real browser initial UI";
	const browser = new QuotaBrowserSmoke(context, narrator.id);
	try {
		await browser.start();
		await browser.navigate();
		await browser.active(12.34, "initial");
		await browser.pluginPage(false, "installed");
		context.stage = "real English refresh and live quota UI";
		await browser.refresh("en", 23.45);
		await browser.active(23.45, "refreshed");
		context.stage = "real Chinese refresh and zero balance";
		await browser.refresh("zh-CN", 0);
		await browser.active(0, "zero");

		context.stage = "disable with live open UI";
		await browser.leavePanelsOpen("before-disable");
		await context.lifecycle("disable");
		await requireInactivePlugin(context, false, "disable runtime inactive");
		await requireUnavailableQuota(context, "disable host cache clears quota data and source");
		await browser.unavailable("disabled-live");
		context.stage = "owned process restart must preserve disabled choice";
		await context.restart();
		await requireInactivePlugin(
			context,
			false,
			"restart does not auto-enable the disabled builtin",
		);
		await requireUnavailableQuota(context, "disabled restart keeps host quota absent");
		await browser.navigate();
		await browser.unavailable("disabled-restart");

		context.stage = "re-enable before uninstall";
		await context.lifecycle("enable");
		await context.lifecycle("activate");
		await requireActivePlugin(context, "explicit re-enable restores compiled runtime");
		await requireBalance(context, 0, "re-enabled plugin retains real zero balance");
		await browser.navigate();
		// Re-enabling restores the quota UI, and a real zero still reads as zero, not as missing.
		await browser.active(0, "re-enabled");
		await browser.leavePanelsOpen("before-uninstall");
		context.stage = "uninstall with live open UI";
		await context.lifecycle("uninstall");
		await requireInactivePlugin(context, true, "plugin uninstall removes current package");
		await requireUnavailableQuota(context, "uninstall host cache clears quota data and source");
		await browser.unavailable("uninstalled-live");
		await browser.pluginPage(true, "uninstalled");
		context.stage = "owned process restart must preserve builtin removal";
		await context.restart();
		await requireInactivePlugin(context, true, "restart does not restore uninstalled builtin");
		await requireUnavailableQuota(context, "uninstalled restart keeps host quota absent");
		await browser.navigate();
		await browser.unavailable("uninstalled-restart");

		context.stage = "real reinstall after restart";
		context.fixture.setRemaining(17.89);
		await browser.reinstallBuiltin();
		await requireActivePlugin(context, "reinstalled archive enabled and active without system Bun");
		await requireBalance(context, 17.89, "reinstalled plugin produces fresh fixture quota");
		await browser.navigate();
		await browser.active(17.89, "reinstalled");
		await runSiteAcceptance(context, browser);
		if (
			context.report.checks.filter((check) => check.status === "passed").length <
			MIN_LIFECYCLE_CHECKS
		)
			throw new Error("Required lifecycle/site acceptance checks were not all executed");
		context.check("full native provider quota acceptance");
	} finally {
		context.report.browser = { ...object(context.report.browser), ...object(browser.evidence()) };
	}
}

/** The executable runs outside the checkout, with no source, node_modules or Bun on PATH. */
export async function smokeProviderQuota(
	options: QuotaSmokeOptions,
	signal?: AbortSignal,
	acceptance: (context: QuotaSmokeContext) => Promise<void> = runAcceptance,
): Promise<QuotaSmokeReport> {
	parseQuotaSmokeArgs([
		`--binary=${options.binary}`,
		`--archive=${options.archive}`,
		`--out=${options.out}`,
		`--baseline=${options.baseline}`,
		`--timeout-ms=${options.timeoutMs}`,
		...(options.browser ? [`--browser=${options.browser}`] : []),
	]);
	for (const [path, maximum] of [
		[options.binary, MAX_BINARY_BYTES],
		[options.archive, MAX_ARCHIVE_BYTES],
	] as const) {
		const stat = await lstat(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum)
			throw new Error("Smoke artifact must be a bounded regular file");
	}
	const parent = await lstat(dirname(options.out));
	if (!parent.isDirectory()) throw new Error("Smoke output parent must already exist");
	await mkdir(options.out, { mode: 0o700 });
	const root = await mkdtemp(join(tmpdir(), "narrafork-quota-native-"));
	await chmod(root, 0o700);
	const context = new QuotaSmokeContext(options, root, signal);
	const onCancel = () => context.controller.abort(new Error("Quota smoke cancelled"));
	process.once("SIGINT", onCancel);
	process.once("SIGTERM", onCancel);
	let failure: unknown;
	try {
		for (const path of [
			context.cwd,
			context.env.HOME,
			context.env.NARRAFORK_HOME,
			context.env.TMP,
			context.env.APPDATA,
			context.env.LOCALAPPDATA,
		])
			if (path) await mkdir(path, { recursive: true, mode: 0o700 });
		for (let path = context.cwd; ; path = dirname(path)) {
			if (existsSync(join(path, "node_modules")))
				throw new Error("Compiled smoke has ancestor node_modules");
			if (dirname(path) === path) break;
		}
		if (
			Bun.which("bun", { PATH: context.env.PATH }) ||
			Bun.which("bunx", { PATH: context.env.PATH })
		)
			throw new Error("System Bun remains available to compiled smoke");
		const binaryHash = await hashReleaseFile(options.binary, MAX_BINARY_BYTES, context.signal);
		const archiveHash = await hashReleaseFile(options.archive, MAX_ARCHIVE_BYTES, context.signal);
		await copyReleaseFile(options.binary, context.executable, MAX_BINARY_BYTES, context.signal);
		if (process.platform !== "win32") await chmod(context.executable, 0o700);
		const copiedHash = await hashReleaseFile(context.executable, MAX_BINARY_BYTES, context.signal);
		if (binaryHash.sha256 !== copiedHash.sha256)
			throw new Error("Copied executable differs from source");
		context.report.artifacts = {
			binary: binaryHash,
			archive: archiveHash,
			executableDirectory: await readdir(context.cwd),
			noSystemBun: true,
			noSource: true,
			noNodeModules: true,
		};
		await writeFile(
			join(context.env.NARRAFORK_HOME, "settings.json"),
			JSON.stringify({
				server: { openBrowser: "off" },
				proxy: { mode: "direct" },
				vnet: { enabled: false, udp: { enabled: false, host: "127.0.0.1", port: 0 } },
			}),
			{ flag: "wx", mode: 0o600 },
		);
		context.stage = "isolated compiled startup";
		await context.start();
		context.check(context.stage);
		context.stage = "test administrator";
		const password = randomUUID();
		context.secrets.push(password);
		const registration = object(
			await context.require("/api/auth/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					username: `quota_${randomUUID().replaceAll("-", "").slice(0, 18)}`,
					password,
					language: "en",
				}),
			}),
		);
		if (typeof registration.token !== "string")
			throw new Error("Test registration did not issue a session token");
		context.token = registration.token;
		context.secrets.push(context.token);
		context.check(context.stage);
		if (options.baseline) {
			context.stage = "old executable baseline";
			context.report.checks.push({
				name: "default builtin 1.0.2 and browser acceptance",
				status: "baseline-only",
				detail: "Old executable baseline only; skipped checks are never a final pass",
			});
			await context.http("/api/plugins", {}, "baseline initial plugins");
			await context.upload("baseline multipart archive upload");
			await context.upload("baseline repeated archive upload");
			for (const action of ["enable", "activate"])
				await context.http(
					`/api/plugins/${PLUGIN_ID}/${action}`,
					{ method: "POST" },
					`baseline ${action}`,
				);
			await context.http(`/api/plugins/${PLUGIN_ID}`, {}, "baseline plugin status");
			await context.http(
				`/api/plugins/${PLUGIN_ID}/diagnostics`,
				{},
				"baseline plugin diagnostics",
			);
			context.report.status = "baseline-only";
		} else {
			await acceptance(context);
			context.report.status = "passed";
			context.report.finalAcceptance = true;
		}
		context.signal.throwIfAborted();
		const finalBinaryHash = await hashReleaseFile(options.binary, MAX_BINARY_BYTES, context.signal);
		const finalArchiveHash = await hashReleaseFile(
			options.archive,
			MAX_ARCHIVE_BYTES,
			context.signal,
		);
		if (
			finalBinaryHash.sha256 !== binaryHash.sha256 ||
			finalArchiveHash.sha256 !== archiveHash.sha256
		)
			throw new Error("Source artifacts changed during smoke");
		context.check("artifact integrity");
	} catch (error) {
		failure = error;
		context.report.status = "failed";
		context.report.finalAcceptance = false;
		context.report.checks.push({ name: context.stage, status: "failed" });
		context.report.error = String(redactQuotaEvidence(String(error), context.secrets));
		if (context.token && context.server && !context.signal.aborted) {
			for (const [path, name] of [
				[`/api/plugins/${PLUGIN_ID}`, "failure plugin status"],
				[`/api/plugins/${PLUGIN_ID}/diagnostics`, "failure plugin diagnostics"],
				[`/api/provider-quotas?providerId=${PROVIDER_ID}&limit=10`, "failure quota snapshot"],
			])
				await context.http(path, {}, name).catch(() => {});
		}
	} finally {
		const errors: unknown[] = [];
		await Promise.resolve(context.browser?.disconnect()).catch((error) => errors.push(error));
		context.report.fixture = context.fixture?.evidence();
		context.report.siteFixture = context.siteFixture?.evidence();
		context.fixture?.stop();
		context.siteFixture?.stop();
		for (const scope of context.scopes.toReversed()) {
			try {
				await scope.close();
			} catch (error) {
				errors.push(error);
			}
		}
		await context
			.artifact("process-diagnostic.json", {
				ownedProcessScopes: context.scopes.map((scope) => scope.diagnostic),
			})
			.catch((error) => errors.push(error));
		try {
			await removeSmokeDirectory(root);
		} catch (error) {
			errors.push(error);
		}
		failure = finishQuotaSmokeCleanup(context, failure, errors);
		process.removeListener("SIGINT", onCancel);
		process.removeListener("SIGTERM", onCancel);
	}
	if (context.signal.aborted) {
		failure ??= context.signal.reason;
		context.report.status = "failed";
		context.report.finalAcceptance = false;
		context.report.error = String(redactQuotaEvidence(String(failure), context.secrets));
	}
	await context.artifact("smoke.json", context.report);
	if (failure)
		throw new Error(
			`Provider quota smoke failed at ${context.stage}; inspect ${join(options.out, "smoke.json")}`,
		);
	return context.report;
}

if (import.meta.main) {
	try {
		const report = await smokeProviderQuota(parseQuotaSmokeArgs(process.argv.slice(2)));
		console.log(
			`Provider quota smoke: ${report.status}; finalAcceptance=${report.finalAcceptance}`,
		);
		if (!report.finalAcceptance) process.exitCode = 1;
	} catch (error) {
		console.error(String(error));
		process.exitCode = 1;
	}
}
