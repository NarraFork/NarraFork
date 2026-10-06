import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import type { TerminalRuntime } from "../../server/terminal/runtime";

export const PG_STAGE_ENV = "NARRAFORK_PG_STAGE_OUT";
export const PG_SCHEMA_ENV = "NARRAFORK_PG_SCHEMA_PATH";
const OUTPUT_LIMIT = 256 * 1024;
const GUARD_MESSAGE = "Use db:generate:pg / db:check:pg with a guarded .narrafork/pg-* stage.";

function guardedPath(root: string, input: string, kind: "file" | "directory"): string {
	const base = resolve(root);
	if (realpathSync(base) !== base) throw new Error("PG root must not contain symlinks");
	if (input.split(/[\\/]/).includes("..")) throw new Error("PG path must not contain ..");
	const path = resolve(base, input);
	const rel = relative(base, path);
	if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
		throw new Error("PG path escapes root");
	}
	let cursor = base;
	for (const part of rel.split(sep)) {
		cursor = join(cursor, part);
		if (lstatSync(cursor).isSymbolicLink()) throw new Error("PG path contains a symlink");
	}
	const stat = lstatSync(path);
	if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) {
		throw new Error(`PG path must be an existing ordinary ${kind}`);
	}
	return path;
}

/** Return a relative out: Kit 0.31.10 prepends './' when reading snapshots. */
export function resolvePgStageOut(root: string, out?: string): string {
	const input = out ?? process.env[PG_STAGE_ENV];
	if (!input || isAbsolute(input) || /^[A-Za-z]:|^\\\\/.test(input)) {
		throw new Error(GUARD_MESSAGE);
	}
	const parts = input.replaceAll("\\", "/").split("/");
	if (parts.length !== 2 || parts[0] !== ".narrafork" || !/^pg-[\w -]+$/.test(parts[1])) {
		throw new Error(GUARD_MESSAGE);
	}
	return relative(resolve(root), guardedPath(root, input, "directory")).replaceAll("\\", "/");
}

export function resolvePgSchemaPath(root: string, input?: string): string {
	const path = guardedPath(
		root,
		input ?? process.env[PG_SCHEMA_ENV] ?? "server/db/postgres-schema.ts",
		"file",
	);
	if (!path.endsWith(".ts")) throw new Error("PG schema must be an ordinary TS file");
	return path;
}

export interface PostgresKitOptions {
	root: string;
	stageOut: string;
	operation: "generate" | "check";
	args?: string[];
	schemaPath?: string;
	interactive?: boolean;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface PostgresKitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
}

function validateArgs(operation: PostgresKitOptions["operation"], args: string[]) {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (operation === "generate" && arg === "--custom") continue;
		if (operation === "generate" && (arg === "--name" || arg.startsWith("--name="))) {
			const name = arg === "--name" ? args[++i] : arg.slice(7);
			if (name && /^[A-Za-z0-9_-]{1,128}$/.test(name)) continue;
		}
		throw new Error(`Unsupported PG Kit argument: ${arg}`);
	}
}

function plain(text: string): string {
	return stripVTControlCharacters(text);
}

function boundedText(text: string, limit: number): string {
	// StringDecoder leaves any partial trailing UTF-8 code point buffered, not expanded.
	return new StringDecoder("utf8").write(Buffer.from(text).subarray(0, Math.max(0, limit)));
}

/** No network/package resolution and no database operations: generate/check only. */
export async function runPostgresKit(opts: PostgresKitOptions): Promise<PostgresKitResult> {
	const root = resolve(opts.root);
	const stageOut = resolvePgStageOut(root, opts.stageOut);
	const schemaPath = resolvePgSchemaPath(root, opts.schemaPath);
	if (opts.operation !== "generate" && opts.operation !== "check") {
		throw new Error("Only PG generate/check are allowed");
	}
	const args = opts.args ?? [];
	validateArgs(opts.operation, args);
	const configPath = guardedPath(root, "drizzle.pg.config.ts", "file");
	const maxTimeout = opts.interactive ? 300_000 : 60_000;
	const timeoutMs = opts.timeoutMs ?? maxTimeout;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > maxTimeout) {
		throw new Error(`PG Kit timeout must be within 1..${maxTimeout}ms`);
	}
	const result: PostgresKitResult = {
		exitCode: 1,
		stdout: "",
		stderr: "",
		stdoutTruncated: false,
		stderrTruncated: false,
	};
	let failure = "";
	let bytes = 0;
	let stopChild = () => {};
	const fail = (reason: string) => {
		if (failure) return;
		failure = reason;
		stopChild();
	};
	const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
	const append = (target: "stdout" | "stderr", chunk: Uint8Array | string) => {
		const data = Buffer.from(chunk);
		// Reserve bounded room for fail-closed diagnostics inside the combined 256 KiB cap.
		const remaining = OUTPUT_LIMIT - 512 - bytes;
		const decoded = decoders[target].write(data.subarray(0, Math.max(0, remaining)));
		const kept = boundedText(decoded, remaining);
		result[target] += kept;
		bytes += Buffer.byteLength(kept);
		if (data.length > remaining || Buffer.byteLength(decoded) > remaining) {
			result[target === "stdout" ? "stdoutTruncated" : "stderrTruncated"] = true;
			fail("PG Kit output exceeded 256 KiB");
		}
		if (
			!opts.interactive &&
			/created or renamed|Interactive prompts require a TTY/i.test(plain(result[target]))
		) {
			fail("PG Kit needs an interactive TTY for rename selection");
		}
	};
	if (opts.signal?.aborted) {
		result.stderr = "PG Kit aborted before spawn";
		return result;
	}
	if (opts.interactive && (!process.stdin.isTTY || !process.stdout.isTTY)) {
		result.stderr = "Interactive PG Kit requires caller stdin and stdout TTY";
		return result;
	}
	const cmd = [
		process.execPath,
		join(root, "node_modules/drizzle-kit/bin.cjs"),
		opts.operation,
		`--config=${configPath}`,
		...args,
	];
	const env = { ...process.env, [PG_STAGE_ENV]: stageOut, [PG_SCHEMA_ENV]: schemaPath };
	const abort = () => fail("PG Kit aborted");
	const interrupt = () => fail("PG Kit interrupted (SIGINT)");
	let timer: ReturnType<typeof setTimeout> | undefined;
	let terminal: TerminalRuntime | undefined;
	let input: ((data: Buffer) => void) | undefined;
	let resize: (() => void) | undefined;
	const wasRaw = process.stdin.isRaw;
	const wasFlowing = process.stdin.readableFlowing;
	let rawChanged = false;
	const killOwnedGroup = (pid: number | null | undefined) => {
		if (pid && process.platform !== "win32") {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				/* already exited */
			}
		}
	};
	try {
		if (opts.interactive) {
			const spawn =
				process.platform === "win32"
					? (await import("../../server/terminal/runtime-pty")).spawnPortablePty
					: (await import("../../server/terminal/runtime-bun")).spawnBunTerminal;
			terminal = spawn({
				cmd,
				cwd: root,
				env,
				cols: process.stdout.columns || 80,
				rows: process.stdout.rows || 24,
				onData(data) {
					append("stdout", data);
					if (!failure && !process.stdout.write(data)) fail("PG Kit caller terminal backpressure");
				},
			});
			stopChild = () => {
				killOwnedGroup(terminal?.pid);
				terminal?.kill();
				terminal?.close();
			};
			input = (data) => {
				if (data.includes(3)) interrupt();
				else if (!failure) terminal?.write(data);
			};
			resize = () => terminal?.resize(process.stdout.columns || 80, process.stdout.rows || 24);
			process.stdin.setRawMode(true);
			rawChanged = true;
			process.stdin.on("data", input);
			process.stdout.on("resize", resize);
			process.stdin.resume();
		} else {
			const child = Bun.spawn(cmd, {
				cwd: root,
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				detached: process.platform !== "win32",
			});
			stopChild = () => {
				killOwnedGroup(child.pid);
				child.kill("SIGKILL");
			};
			const read = async (target: "stdout" | "stderr", stream: ReadableStream<Uint8Array>) => {
				const reader = stream.getReader();
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						append(target, value);
					}
				} finally {
					reader.releaseLock();
				}
			};
			timer = setTimeout(() => fail("PG Kit timed out"), timeoutMs);
			opts.signal?.addEventListener("abort", abort, { once: true });
			process.on("SIGINT", interrupt);
			if (opts.signal?.aborted) abort();
			const [code] = await Promise.all([
				child.exited,
				read("stdout", child.stdout),
				read("stderr", child.stderr),
			]);
			result.exitCode = code;
		}
		if (terminal) {
			timer = setTimeout(() => fail("PG Kit timed out"), timeoutMs);
			opts.signal?.addEventListener("abort", abort, { once: true });
			process.on("SIGINT", interrupt);
			if (opts.signal?.aborted || failure) {
				if (!failure) abort();
				else stopChild();
			}
			result.exitCode = (await terminal.exited) ?? 1;
		}
	} catch (error) {
		fail(`PG Kit failed: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		if (timer) clearTimeout(timer);
		opts.signal?.removeEventListener("abort", abort);
		process.off("SIGINT", interrupt);
		if (input) process.stdin.off("data", input);
		if (resize) process.stdout.off("resize", resize);
		if (rawChanged) process.stdin.setRawMode(wasRaw ?? false);
		if (rawChanged && wasFlowing !== true) process.stdin.pause();
		terminal?.close();
	}
	const output = plain(`${result.stdout}\n${result.stderr}`);
	const success =
		opts.operation === "check"
			? /Everything's fine/.test(output)
			: /No schema changes, nothing to migrate|Your SQL migration file/.test(output);
	if (
		!failure &&
		result.exitCode === 0 &&
		(!success || /(?:Error|TypeError|SyntaxError|ReferenceError):/.test(output))
	) {
		failure = "PG Kit exited 0 without a trustworthy success status";
	}
	if (failure) {
		result.exitCode = result.exitCode || 1;
		// Diagnostics use bounded reserved space even when native output filled the cap.
		const diagnostic = `\n${boundedText(failure, 500)}`;
		result.stderr = `${boundedText(result.stderr, OUTPUT_LIMIT - Buffer.byteLength(result.stdout) - Buffer.byteLength(diagnostic))}${diagnostic}`;
	}
	return result;
}
