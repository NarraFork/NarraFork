import { randomBytes } from "node:crypto";

const EXPLICIT_IMAGE = process.env.PG_TEST_IMAGE;
const DEFAULT_IMAGE = "docker.io/library/postgres:17-alpine";
const TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 300_000;
const REASON_LIMIT = 2_048;
const PODMAN = "podman";
const HOST_HOME = process.env.NARRAFORK_ORIGINAL_HOME ?? process.env.HOME;
// tests/preload.ts intentionally isolates HOME. Podman uses HOME to select its
// rootless storage, so only Podman commands receive the original host home.
const COMMAND_ENV = { ...process.env, PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
const PODMAN_ENV = {
	...COMMAND_ENV,
	...(HOST_HOME ? { HOME: HOST_HOME, USERPROFILE: HOST_HOME } : {}),
};
export const OUTPUT_LIMIT = 16_384;

export type PgHarnessResult =
	| { status: "ready"; containerId: string; port: number; schema: string }
	| { status: "blocked"; errorType: "environment"; reason: string }
	| { status: "failed"; errorType: "callback"; reason: string };

export type CommandResult = { code: number; stdout: string; stderr: string };
export type CommandOptions = {
	timeout?: number;
	signal?: AbortSignal;
	env?: Record<string, string | undefined>;
	input?: string;
};
export class HarnessCommandError extends Error {
	constructor(readonly kind: "output-limit" | "timeout" | "cancelled" | "spawn" | "io") {
		super(`harness command ${kind}`);
	}
}

/** Retain at most OUTPUT_LIMIT bytes across both pipes; never include command/output in errors. */
export async function runHarnessCommand(
	args: string[],
	options: CommandOptions = {},
): Promise<CommandResult> {
	if (options.signal?.aborted) throw new HarnessCommandError("cancelled");
	let child: ReturnType<typeof Bun.spawn>;
	try {
		child = Bun.spawn(args, {
			stdout: "pipe",
			stderr: "pipe",
			stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
			env: options.env ?? COMMAND_ENV,
		});
	} catch {
		throw new HarnessCommandError("spawn");
	}
	const stdout = (child.stdout as ReadableStream<Uint8Array>).getReader();
	const stderr = (child.stderr as ReadableStream<Uint8Array>).getReader();
	let retained = 0;
	let failure: HarnessCommandError | undefined;
	let rejectStopped: (error: HarnessCommandError) => void = () => {};
	const stopped = new Promise<never>((_, reject) => {
		rejectStopped = reject;
	});
	const stop = (kind: HarnessCommandError["kind"]) => {
		if (failure) return;
		failure = new HarnessCommandError(kind);
		child.kill("SIGKILL");
		void stdout.cancel().catch(() => {});
		void stderr.cancel().catch(() => {});
		rejectStopped(failure);
	};
	const read = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			while (!failure) {
				const { done, value } = await reader.read();
				if (done) break;
				if (retained + value.byteLength > OUTPUT_LIMIT) {
					stop("output-limit");
					break;
				}
				retained += value.byteLength;
				length += value.byteLength;
				chunks.push(value.slice());
			}
			const bytes = new Uint8Array(length);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return new TextDecoder().decode(bytes);
		} catch {
			stop("io");
			return "";
		} finally {
			reader.releaseLock();
		}
	};
	const abort = () => stop("cancelled");
	const timer = setTimeout(() => stop("timeout"), options.timeout ?? TIMEOUT_MS);
	options.signal?.addEventListener("abort", abort, { once: true });
	const output = Promise.all([child.exited, read(stdout), read(stderr)]);
	if (options.signal?.aborted) abort();
	try {
		const [code, out, err] = await Promise.race([output, stopped]);
		if (failure) throw failure;
		return { code, stdout: out, stderr: err };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		await output;
	}
}

type Runner = typeof runHarnessCommand;
export async function withPostgres<T>(
	fn: (connection: {
		port: number;
		schema: string;
		exec: (sql: string) => Promise<CommandResult>;
		/**
		 * The throwaway role and database the container was created with, for callbacks
		 * that need a real network client (e.g. a connection pool for concurrent
		 * transactions, which the serialized `psql` exec cannot produce). Additive:
		 * callbacks that only relay statements keep using `exec`.
		 */
		credentials: { user: string; password: string; database: string };
	}) => Promise<T>,
	options: { signal?: AbortSignal; run?: Runner; image?: string } = {},
): Promise<T | PgHarnessResult> {
	const run = options.run ?? runHarnessCommand;
	// An explicitly requested image is never substituted for another major version:
	// if it is missing locally we pull exactly it, or report why we could not.
	const imageName = options.image ?? EXPLICIT_IMAGE ?? DEFAULT_IMAGE;
	try {
		const exists = await run([PODMAN, "image", "inspect", "--format", "{{.Id}}", imageName], {
			signal: options.signal,
			env: PODMAN_ENV,
		});
		if (exists.code !== 0) {
			const pulled = await run([PODMAN, "pull", imageName], {
				signal: options.signal,
				env: PODMAN_ENV,
				timeout: PULL_TIMEOUT_MS,
			});
			// Report the runtime's own diagnostic (bounded): "image not known" and
			// "no such host" demand opposite responses, and a generic
			// "validation unavailable" hides which one happened.
			if (pulled.code !== 0)
				return {
					status: "blocked",
					errorType: "environment",
					reason: `PostgreSQL test image ${imageName} unavailable: ${(
						pulled.stderr.trim() || pulled.stdout.trim() || `pull exit ${pulled.code}`
					).slice(-REASON_LIMIT)}`,
				};
		}
	} catch (error) {
		if (error instanceof HarnessCommandError && error.kind === "cancelled") throw error;
		return {
			status: "blocked",
			errorType: "environment",
			reason: `PostgreSQL test image ${imageName} could not be verified (${
				error instanceof Error ? error.message : "unknown Podman failure"
			})`,
		};
	}
	const name = `narrafork-pg-harness-${randomBytes(8).toString("hex")}`;
	const user = `nf_${randomBytes(6).toString("hex")}`;
	const password = randomBytes(18).toString("base64url");
	const database = "nf_harness";
	const schema = `h_${randomBytes(8).toString("hex")}`;
	const env = {
		...PODMAN_ENV,
		POSTGRES_USER: user,
		POSTGRES_PASSWORD: password,
		POSTGRES_DB: database,
	};
	let creationAttempted = false;
	let result: T | PgHarnessResult;
	let stage = "start";
	const exec = (sql: string) =>
		run(
			[
				PODMAN,
				"exec",
				"--interactive",
				"--env",
				"PGUSER",
				name,
				"psql",
				"-d",
				"nf_harness",
				"-v",
				"ON_ERROR_STOP=1",
				"-Atq",
			],
			{ signal: options.signal, env: { ...PODMAN_ENV, PGUSER: user }, input: sql },
		);
	try {
		creationAttempted = true;
		stage = "podman run";
		const started = await run(
			[
				PODMAN,
				"run",
				"--detach",
				"--rm",
				"--pull",
				"never",
				"--name",
				name,
				"-p",
				"127.0.0.1::5432",
				"-e",
				"POSTGRES_USER",
				"-e",
				"POSTGRES_PASSWORD",
				"-e",
				"POSTGRES_DB",
				imageName,
			],
			{ signal: options.signal, env: { ...PODMAN_ENV, ...env } },
		);
		if (started.code !== 0)
			throw new Error(`start:${started.code}:${started.stderr.slice(0, 256)}`);
		stage = "podman port";
		const portResult = await run([PODMAN, "port", name, "5432/tcp"], {
			signal: options.signal,
			env: PODMAN_ENV,
		});
		const port = Number(portResult.stdout.match(/(?:127\.0\.0\.1|0\.0\.0\.0):([0-9]+)\s*$/m)?.[1]);
		if (portResult.code !== 0 || !Number.isInteger(port) || port < 1 || port > 65535)
			throw new Error(`port:${portResult.code}:${portResult.stderr.slice(0, 256)}`);
		stage = "readiness";
		let ready = false;
		for (let i = 0; i < 20; i++) {
			const probe = await exec("SELECT 1;");
			if (probe.code === 0 && probe.stdout.trim() === "1") {
				ready = true;
				break;
			}
			await Bun.sleep(250);
		}
		if (!ready) throw new Error("readiness");
		stage = "validation";
		const check = await exec(
			`CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.sentinel(value integer); INSERT INTO ${schema}.sentinel VALUES (1); SELECT 1;`,
		);
		if (check.code !== 0 || check.stdout.trim().split("\n").at(-1) !== "1")
			throw new Error("validation");
		try {
			result = await fn({ port, schema, exec, credentials: { user, password, database } });
		} catch {
			result = { status: "failed", errorType: "callback", reason: "PostgreSQL callback failed" };
		}
	} catch (error) {
		result = {
			status: "blocked",
			errorType: "environment",
			reason:
				error instanceof HarnessCommandError
					? error.message
					: error instanceof Error
						? `temporary PostgreSQL validation unavailable (${error.message.slice(0, 256)})`
						: `temporary PostgreSQL validation unavailable (${stage})`,
		};
	} finally {
		// A timed out `run` may already have created the container: clean our random name,
		// even without a returned ID. Never inherit the cancelled operation's signal.
		if (creationAttempted) {
			try {
				const cleanup = await run([PODMAN, "rm", "--force", "--ignore", name], {
					env: PODMAN_ENV,
				});
				if (cleanup.code !== 0)
					result = {
						status: "blocked",
						errorType: "environment",
						reason: "temporary PostgreSQL cleanup failed",
					};
			} catch {
				result = {
					status: "blocked",
					errorType: "environment",
					reason: "temporary PostgreSQL cleanup failed",
				};
			}
		}
	}
	return result;
}
