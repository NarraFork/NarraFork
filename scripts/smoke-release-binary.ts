import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { isValidGitHubRepository } from "../shared/github-repository";
import type { BinaryMetadata } from "./lib/binary-metadata";
import { copyReleaseFile, hashReleaseFile, readReleaseText } from "./lib/ci-release-io";
import {
	SMOKE_TIMEOUT_MS,
	type SmokeChild,
	SmokeProcessScope,
} from "./lib/ci-release-smoke-process";
import { CI_RELEASE_TARGETS, type CiReleaseSmokeResult } from "./lib/ci-release-types";

export interface SmokeOptions {
	repository?: string;
	target: string;
	binary: string;
	metadata: string;
	commit: string;
	version: string;
	output: string;
}
const MAX_BINARY = 1024 ** 3;
const MAX_MESSAGE = 64 * 1024;

export function parseSmokeArgs(args: readonly string[]): SmokeOptions {
	const keys = ["target", "binary", "metadata", "commit", "version", "output"] as const;
	const values: SmokeOptions = {
		target: "",
		binary: "",
		metadata: "",
		commit: "",
		version: "",
		output: "",
	};
	for (const arg of args) {
		if (arg.startsWith("--repository=")) {
			const repository = arg.slice("--repository=".length);
			if (values.repository !== undefined || !isValidGitHubRepository(repository))
				throw new Error("Invalid or duplicate smoke repository");
			values.repository = repository;
			continue;
		}
		const match = /^--([a-z]+)=(.+)$/.exec(arg);
		const key = keys.find((key) => key === match?.[1]);
		const value = match?.[2];
		if (!key || !value || values[key]) {
			throw new Error(`Unknown, duplicate or malformed smoke argument: ${arg}`);
		}
		values[key] = value;
	}
	for (const key of keys)
		if (!values[key] || values[key].includes("\0")) throw new Error(`Missing/invalid --${key}`);
	if (!/^[a-f0-9]{40}$/.test(values.commit))
		throw new Error("--commit must be a full lowercase SHA");
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(values.version))
		throw new Error("Invalid release version");
	if (!CI_RELEASE_TARGETS.some((entry) => entry.target === values.target))
		throw new Error("Unknown smoke target");
	return values;
}

export function smokeEnvironment(
	root: string,
	ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv &
	Record<"HOME" | "NARRAFORK_HOME" | "TMP" | "APPDATA" | "LOCALAPPDATA", string> {
	const env: NodeJS.ProcessEnv = {};
	// No provider credentials, NODE_PATH/NODE_OPTIONS, database URLs, runner tokens or user settings.
	const allowed = new Set([
		"path",
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
	for (const key of Object.keys(env))
		if (key.toLowerCase() === "path") {
			env[key] = env[key]
				?.split(process.platform === "win32" ? ";" : ":")
				.filter((part) => part && !/node_modules/i.test(part))
				.join(process.platform === "win32" ? ";" : ":");
		}
	const home = join(root, "home");
	return {
		...env,
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

export function validateSmokeMetadata(
	value: unknown,
	options: SmokeOptions,
	hash: { size: number; sha256: string; sha512: string },
): BinaryMetadata {
	const metadata = value as Partial<BinaryMetadata> | null;
	const target = CI_RELEASE_TARGETS.find((entry) => entry.target === options.target);
	if (
		!metadata ||
		!target ||
		metadata.target !== `bun-${target.target}` ||
		metadata.platform !== target.platform ||
		metadata.name !== basename(options.binary) ||
		metadata.version !== options.version ||
		typeof metadata.commit !== "string" ||
		!/^[a-f0-9]{7,40}$/.test(metadata.commit) ||
		!options.commit.startsWith(metadata.commit) ||
		metadata.size !== hash.size ||
		metadata.sha256 !== hash.sha256 ||
		metadata.sha512 !== hash.sha512 ||
		(metadata.repository !== undefined && !isValidGitHubRepository(metadata.repository)) ||
		(options.repository !== undefined &&
			metadata.repository?.toLowerCase() !== options.repository.toLowerCase())
	) {
		throw new Error("Release metadata does not match binary/target/version/commit");
	}
	return metadata as BinaryMetadata;
}

async function unusedLoopbackPort(): Promise<number> {
	const server = createServer();
	return new Promise((done, fail) => {
		server.once("error", fail);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close((error) => {
				if (error) fail(error);
				else if (!address || typeof address === "string") fail(new Error("No loopback port"));
				else done(address.port);
			});
		});
	});
}

async function boundedBody(response: Response, maximum: number): Promise<string> {
	if (!response.body) throw new Error("Empty HTTP body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.length;
			if (bytes > maximum) throw new Error("Smoke HTTP response exceeds budget");
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		await reader.cancel().catch(() => {});
	}
}

async function request(
	origin: string,
	path: string,
	scope: SmokeProcessScope,
	init: RequestInit = {},
	maximum = 1024 * 1024,
): Promise<{ response: Response; text: string }> {
	const response = await fetch(`${origin}${path}`, {
		...init,
		redirect: "error",
		signal: AbortSignal.any([scope.signal, AbortSignal.timeout(10_000)]),
	});
	const text = await boundedBody(response, maximum);
	if (!response.ok) throw new Error(`HTTP ${path}: ${response.status} ${text.slice(0, 256)}`);
	return { response, text };
}

export function assertHealthIdentity(value: unknown, options: SmokeOptions): void {
	const health = value as Record<string, unknown>;
	if (
		!health ||
		health.status !== "ok" ||
		health.readiness !== "ready" ||
		typeof health.commit !== "string" ||
		!/^[a-f0-9]{7,40}$/.test(health.commit) ||
		!options.commit.startsWith(health.commit) ||
		health.version !== `${options.version}+${health.commit}` ||
		health.gitAvailable !== true
	) {
		throw new Error("Health readiness/version/commit/git mismatch");
	}
}

async function startup(
	origin: string,
	child: SmokeChild,
	scope: SmokeProcessScope,
	options: SmokeOptions,
): Promise<void> {
	const deadline = performance.now() + 120_000;
	let last = "not listening";
	while (performance.now() < deadline) {
		scope.signal.throwIfAborted();
		child.assertRunning();
		try {
			const health = JSON.parse((await request(origin, "/api/health", scope)).text);
			assertHealthIdentity(health, options);
			return;
		} catch (error) {
			last = String(error);
		}
		await delay(100, undefined, { signal: scope.signal });
	}
	throw new Error(`Startup timed out: ${last}`);
}

/** Resolve the real Vite relative entry against the server-injected SPA base, never a remote URL. */
export function resolveFrontendAssetPath(html: string, origin: string): string {
	const documentUrl = new URL("/", origin);
	const markup = html.replace(/<!--[\s\S]*?-->/g, "");
	const baseHref = /<base\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/i.exec(markup)?.[1];
	const base = new URL(baseHref ?? "./", documentUrl);
	if (
		base.origin !== documentUrl.origin ||
		base.username ||
		base.password ||
		base.search ||
		base.hash
	) {
		throw new Error("Embedded frontend base must be same-origin");
	}
	const entry = [...markup.matchAll(/<script\b[^>]*>/gi)]
		.map(([tag]) => ({
			module: /\btype\s*=\s*["']module["']/i.test(tag),
			src: /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1],
		}))
		.find((script) => script.module && script.src)?.src;
	if (!entry) throw new Error("Embedded frontend JS asset missing");
	const decoded = decodeURIComponent(entry);
	if (decoded.includes("\\") || decoded.split(/[/?#]/).includes("..")) {
		throw new Error("Embedded frontend asset path escapes its directory");
	}
	const url = new URL(entry, base);
	if (
		url.origin !== documentUrl.origin ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!/^\/assets\/[A-Za-z0-9_.-]+\.js$/.test(url.pathname)
	) {
		throw new Error("Embedded frontend asset must be a same-origin assets JavaScript entry");
	}
	return url.pathname;
}

async function frontend(origin: string, scope: SmokeProcessScope): Promise<void> {
	const { response, text } = await request(origin, "/", scope);
	if (
		!response.headers.get("content-type")?.includes("text/html") ||
		!/<div[^>]+id=["']root["']/.test(text)
	)
		throw new Error("Embedded frontend index missing");
	const asset = resolveFrontendAssetPath(text, origin);
	const javascript = await request(origin, asset, scope, {}, 20 * 1024 * 1024);
	assertFrontendJavaScript(javascript.response.headers.get("content-type"), javascript.text);
}

export function assertFrontendJavaScript(contentType: string | null, text: string): void {
	if (!/javascript/.test(contentType ?? "") || text.length < 100 || /^\s*</.test(text)) {
		throw new Error("Embedded frontend asset did not return JavaScript");
	}
}

export class WatcherInbox {
	private pending = "";
	private decoder = new StringDecoder("utf8");
	private messages: Record<string, unknown>[] = [];
	push(chunk: Buffer): void {
		this.pending += this.decoder.write(chunk);
		if (Buffer.byteLength(this.pending) > MAX_MESSAGE)
			throw new Error("Watcher protocol line exceeds budget");
		let newline = this.pending.indexOf("\n");
		while (newline >= 0) {
			const line = this.pending.slice(0, newline);
			this.pending = this.pending.slice(newline + 1);
			const message = JSON.parse(line) as Record<string, unknown>;
			if (!message || typeof message.type !== "string")
				throw new Error("Malformed watcher protocol");
			if (message.type === "error")
				throw new Error(`Native watcher failed: ${String(message.error)}`);
			this.messages.push(message);
			if (this.messages.length > 128) throw new Error("Watcher message queue exceeds budget");
			newline = this.pending.indexOf("\n");
		}
	}
	take(
		predicate: (message: Record<string, unknown>) => boolean,
	): Record<string, unknown> | undefined {
		const index = this.messages.findIndex(predicate);
		return index < 0 ? undefined : this.messages.splice(index, 1)[0];
	}
}

async function watcher(binary: string, root: string, scope: SmokeProcessScope): Promise<void> {
	const inbox = new WatcherInbox();
	const child = scope.spawn([binary, "--narrafork-watcher-worker"], (chunk) => inbox.push(chunk));
	const wait = (label: string, predicate: (message: Record<string, unknown>) => boolean) =>
		scope.until(label, () => {
			child.assertRunning();
			return inbox.take(predicate);
		});
	const backend =
		process.platform === "win32"
			? "windows"
			: process.platform === "darwin"
				? "fs-events"
				: "inotify";
	await wait(
		"watcher ready",
		(message) =>
			message.type === "ready" && message.pid === child.process.pid && message.backend === backend,
	);
	const path = join(root, "watched");
	await mkdir(path);
	const id = randomUUID();
	child.send({ type: "watch", requestId: id, id, path, ignore: [] });
	await wait(
		"native watch ack",
		(message) => message.type === "watch_ack" && message.requestId === id && message.id === id,
	);
	const file = join(path, `event-${randomUUID()}.txt`);
	await writeFile(file, "native release watcher event\n", { flag: "wx" });
	await wait(
		"native watcher create event",
		(message) =>
			message.type === "events" &&
			message.id === id &&
			message.path === path &&
			Array.isArray(message.events) &&
			message.events.some((event) => event?.path === file && event?.type === 1),
	);
	await rm(file);
	await wait(
		"native watcher delete event",
		(message) =>
			message.type === "events" &&
			message.id === id &&
			Array.isArray(message.events) &&
			message.events.some((event) => event?.path === file && event?.type === 3),
	);
	child.send({ type: "unwatch", requestId: `${id}-stop`, id });
	await wait(
		"native unwatch ack",
		(message) => message.type === "unwatch_ack" && message.requestId === `${id}-stop`,
	);
	child.send({ type: "shutdown" });
	const status = await scope.until("watcher shutdown", () => child.status);
	if (status !== 0) throw new Error(`Watcher shutdown failed: ${child.diagnostic}`);
}

export function assertMigratedDatabase(path: string, username: string): void {
	const database = new Database(path, { readonly: true, create: false });
	try {
		const migration = database
			.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id DESC LIMIT 1")
			.get() as { hash: string; created_at: number } | null;
		if (
			!migration ||
			!/^[a-f0-9]{64}$/.test(migration.hash) ||
			!Number.isFinite(migration.created_at)
		)
			throw new Error("No valid embedded SQLite migrations applied");
		for (const table of ["users", "narrators", "narrator_messages", "terminals"]) {
			if (
				!database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
			)
				throw new Error(`Migrated table missing: ${table}`);
		}
		const user = database
			.query("SELECT username, role FROM users WHERE username = ? LIMIT 1")
			.get(username) as { username: string; role: string } | null;
		if (user?.username !== username || user.role !== "admin")
			throw new Error("API bootstrap user was not persisted to isolated SQLite");
	} finally {
		database.close();
	}
}

/** Requires an output line, not an echoed input command; supports Unix shells and Windows shells. */
export function hasPtyMarker(output: string, marker: string): boolean {
	// Strip CSI/OSC terminal control sequences before comparing whole lines.
	const clean = stripVTControlCharacters(output);
	return clean.split(/[\r\n]/).some((line) => line.trim() === marker);
}

async function pty(origin: string, token: string, scope: SmokeProcessScope): Promise<void> {
	// dtach deliberately escapes the server tree to survive restarts. A smoke crash must
	// not leave that daemon behind; standard hosted runners exercise the direct native PTY.
	if (process.platform !== "win32" && Bun.which("dtach", { PATH: scope.env.PATH })) {
		throw new Error("Native release smoke requires dtach absent from runner PATH");
	}
	const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
	const terminal = JSON.parse(
		(
			await request(origin, "/api/terminals", scope, {
				method: "POST",
				headers,
				body: JSON.stringify({ name: "Release CI smoke", cols: 100, rows: 30 }),
			})
		).text,
	) as { id?: string };
	if (!terminal.id) throw new Error("Terminal create returned no ID");
	let socket: WebSocket | undefined;
	try {
		socket = new WebSocket(
			`${origin.replace("http:", "ws:")}/ws/terminal?token=${encodeURIComponent(token)}`,
		);
		const ws = socket;
		let opened = false;
		let output = "";
		let failure: Error | undefined;
		const marker = `NF_RELEASE_PTY_${randomUUID().replaceAll("-", "")}`;
		ws.addEventListener("open", () => {
			opened = true;
		});
		ws.addEventListener("error", () => {
			failure = new Error("Terminal WebSocket failed");
		});
		ws.addEventListener("close", () => {
			failure ??= new Error("Terminal WebSocket closed before marker");
		});
		ws.addEventListener("message", (event) => {
			try {
				if (typeof event.data !== "string" || Buffer.byteLength(event.data) > MAX_MESSAGE)
					throw new Error("Terminal WS message exceeds budget");
				const message = JSON.parse(event.data);
				if (message.type === "ping") {
					ws.send(JSON.stringify({ type: "pong" }));
					return;
				}
				if (message.type === "error") throw new Error(`PTY error: ${message.message}`);
				if (
					message.type === "output" &&
					message.terminalId === terminal.id &&
					typeof message.data === "string"
				) {
					output += message.data;
					if (Buffer.byteLength(output) > 1024 * 1024)
						throw new Error("PTY output budget exceeded");
				}
			} catch (error) {
				failure = error instanceof Error ? error : new Error(String(error));
			}
		});
		await scope.until("PTY WebSocket connection", () => {
			if (failure) throw failure;
			return opened ? true : undefined;
		});
		ws.send(JSON.stringify({ type: "subscribe", terminalIds: [terminal.id] }));
		ws.send(JSON.stringify({ type: "resize", terminalId: terminal.id, cols: 100, rows: 30 }));
		ws.send(JSON.stringify({ type: "input", terminalId: terminal.id, data: `echo ${marker}\r` }));
		await scope.until("PTY shell round trip", () => {
			if (failure) throw failure;
			return hasPtyMarker(output, marker) ? true : undefined;
		});
	} finally {
		socket?.close();
		// Delete only this terminal even on cancellation, using an independent short cleanup budget.
		const response = await fetch(`${origin}/api/terminals/${encodeURIComponent(terminal.id)}`, {
			method: "DELETE",
			headers,
			signal: AbortSignal.timeout(5_000),
		});
		await boundedBody(response, MAX_MESSAGE);
		if (!response.ok) scope.fail(new Error(`Failed to delete owned smoke PTY: ${response.status}`));
	}
}

/** Runs only a byte-identical copy of the downloaded binary, with no repository dependencies nearby. */
export async function smokeReleaseBinary(
	options: SmokeOptions,
	signal?: AbortSignal,
): Promise<CiReleaseSmokeResult> {
	// Programmatic callers receive the same validation as CLI callers.
	parseSmokeArgs(Object.entries(options).map(([key, value]) => `--${key}=${value}`));
	const platform = process.platform === "win32" ? "windows" : process.platform;
	if (!options.target.startsWith(`${platform}-${process.arch}`))
		throw new Error("Smoke target does not match native runner OS/architecture");
	const binary = resolve(options.binary);
	const output = resolve(options.output);
	if (
		await lstat(output).then(
			() => true,
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return false;
				throw error;
			},
		)
	)
		throw new Error("Refusing to overwrite an existing smoke result");
	const root = await mkdtemp(join(tmpdir(), "narrafork-release-smoke-"));
	const cwd = join(root, "run");
	const env = smokeEnvironment(root);
	const deadlineSignal = AbortSignal.any([
		AbortSignal.timeout(SMOKE_TIMEOUT_MS),
		...(signal ? [signal] : []),
	]);
	const scope = new SmokeProcessScope(cwd, env, { signal: deadlineSignal });
	let result: CiReleaseSmokeResult | undefined;
	try {
		for (const directory of [
			cwd,
			env.HOME,
			env.NARRAFORK_HOME,
			env.TMP,
			env.APPDATA,
			env.LOCALAPPDATA,
		])
			await mkdir(directory, { recursive: true });
		// A compiled executable must not accidentally pick up a checkout's node_modules.
		for (let parent = cwd; ; parent = dirname(parent)) {
			if (
				await lstat(join(parent, "node_modules")).then(
					() => true,
					() => false,
				)
			)
				throw new Error("Smoke isolation contains ancestor node_modules");
			if (dirname(parent) === parent) break;
		}
		const before = await hashReleaseFile(binary, MAX_BINARY, scope.signal);
		const metadataText = await readReleaseText(resolve(options.metadata), MAX_MESSAGE);
		const metadata = validateSmokeMetadata(JSON.parse(metadataText), options, before);
		const repository = options.repository ?? metadata.repository;
		const executable = join(cwd, basename(binary));
		await copyReleaseFile(binary, executable, MAX_BINARY, scope.signal);
		if (process.platform !== "win32") await chmod(executable, 0o700);
		const copied = await hashReleaseFile(executable, MAX_BINARY, scope.signal);
		if (
			copied.sha256 !== before.sha256 ||
			copied.sha512 !== before.sha512 ||
			copied.size !== before.size
		)
			throw new Error("Copied binary differs from downloaded artifact");
		let signature = false;
		if (process.platform === "darwin") {
			await scope.command(["/usr/bin/codesign", "--verify", "--strict", "--verbose=2", executable]);
			signature = true;
		}
		await writeFile(
			join(env.NARRAFORK_HOME, "settings.json"),
			JSON.stringify({
				vnet: { enabled: false, udp: { enabled: false, host: "127.0.0.1", port: 0 } },
			}),
			{ flag: "wx", mode: 0o600 },
		);
		const port = await unusedLoopbackPort();
		const origin = `http://127.0.0.1:${port}`;
		const child = scope.spawn([
			executable,
			"--host=127.0.0.1",
			`--port=${port}`,
			"--no-auto-resume",
		]);
		await startup(origin, child, scope, options);
		await frontend(origin, scope);
		const username = `ci_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
		const registration = JSON.parse(
			(
				await request(origin, "/api/auth/register", scope, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ username, password: randomUUID(), language: "en" }),
				})
			).text,
		) as { token?: string };
		if (!registration.token) throw new Error("Isolated bootstrap registration did not issue token");
		if (repository) {
			const actual = JSON.parse(
				(
					await request(origin, "/api/settings", scope, {
						headers: { Authorization: `Bearer ${registration.token}` },
					})
				).text,
			) as { update?: { source?: string; githubRepository?: string } };
			if (
				actual.update?.source !== "github" ||
				actual.update.githubRepository?.toLowerCase() !== repository.toLowerCase()
			)
				throw new Error("Compiled default update repository does not match the release repository");
		}
		assertMigratedDatabase(join(env.NARRAFORK_HOME, "narrafork.db"), username);
		await watcher(executable, root, scope);
		await pty(origin, registration.token, scope);
		child.assertRunning();
		assertHealthIdentity(JSON.parse((await request(origin, "/api/health", scope)).text), options);
		await scope.close();
		const after = await hashReleaseFile(binary, MAX_BINARY, deadlineSignal);
		const afterRun = await hashReleaseFile(executable, MAX_BINARY, deadlineSignal);
		for (const hash of [after, afterRun])
			if (
				hash.size !== before.size ||
				hash.sha256 !== before.sha256 ||
				hash.sha512 !== before.sha512
			)
				throw new Error("Binary was modified during smoke");
		if ((await readReleaseText(resolve(options.metadata), MAX_MESSAGE)) !== metadataText)
			throw new Error("Metadata changed during smoke");
		result = {
			schemaVersion: 1,
			...(repository ? { repository } : {}),
			target: options.target,
			commit: options.commit,
			version: options.version,
			...before,
			checks: {
				startup: true,
				frontend: true,
				database: true,
				watcher: true,
				pty: true,
				signature,
			},
		};
	} catch (error) {
		throw new Error(`Release smoke failed: ${String(error)}\n${scope.diagnostic}`, {
			cause: error,
		});
	} finally {
		try {
			await scope.close();
		} finally {
			await rm(root, { recursive: true, force: true, maxRetries: 3 });
		}
	}
	if (!result) throw new Error("Smoke result missing");
	deadlineSignal.throwIfAborted();
	await mkdir(dirname(output), { recursive: true });
	await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	if (options.target.endsWith("-baseline"))
		console.log(
			"Baseline smoke on a modern x64 runner does not prove compatibility with a CPU lacking AVX2.",
		);
	console.log(`Release smoke passed: ${options.target} ${result.sha256}`);
	return result;
}

if (import.meta.main) {
	const controller = new AbortController();
	const abort = () => controller.abort(new Error("Release smoke interrupted"));
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	try {
		await smokeReleaseBinary(parseSmokeArgs(process.argv.slice(2)), controller.signal);
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
	} finally {
		process.removeListener("SIGINT", abort);
		process.removeListener("SIGTERM", abort);
	}
}
