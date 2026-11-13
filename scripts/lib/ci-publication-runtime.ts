import { spawn } from "node:child_process";
import { updateServerChildEnvironment } from "../../shared/update-server-child-env";
import type { GhRunner } from "./github-release";

const TIMEOUT = 15 * 60_000;
/** Created only after the subprocess's first diagnostic passes strict gh api validation. */
export class PublicationGhApiError extends Error {
	constructor(readonly status: number) {
		super(`GitHub publication subprocess failed (HTTP ${status})`);
	}
}
/** All publisher stages share one workflow-created deadline, not fresh per-stage budgets. */
export function ciPublicationDeadlineSignal(
	env: NodeJS.ProcessEnv,
	parent: AbortSignal,
): AbortSignal {
	const raw = env.NF_RELEASE_DEADLINE_MS;
	const now = Date.now();
	if (
		raw !== undefined &&
		(!/^[1-9]\d{0,15}$/.test(raw) ||
			!Number.isSafeInteger(Number(raw)) ||
			Number(raw) > now + 30 * 60_000)
	)
		throw new Error("Invalid CI publication deadline");
	const remaining = raw === undefined ? 25 * 60_000 : Math.max(0, Number(raw) - now);
	return AbortSignal.any([
		parent,
		remaining === 0
			? AbortSignal.abort(new Error("CI publication deadline expired"))
			: AbortSignal.timeout(remaining),
	]);
}
export interface PublicationProcessOptions {
	signal?: AbortSignal;
	environment?: NodeJS.ProcessEnv;
	timeoutMs: number;
	maximumOutputBytes: number;
}
/** Only gh api's first diagnostic line is authoritative, never a response body or token. */
function failedGhApiStatus(command: string, args: string[], stderr: string): number | undefined {
	if (command !== "gh" || args[0] !== "api") return undefined;
	const lines = stderr.split(/\r?\n/);
	const diagnostic = /^gh: ([^\p{Cc}]+) \(HTTP ([45]\d{2})\)$/u.exec(lines[0] ?? "");
	if (!diagnostic) return undefined;
	// Ambiguous/malformed extra diagnoses and status text inside messages fail closed.
	if (/\bHTTP\s+\d/.test(diagnostic[1] ?? "")) return undefined;
	if (lines.slice(1).some((line) => /^gh:/.test(line) || /\bHTTP\s+\d/.test(line)))
		return undefined;
	const status = Number(diagnostic[2]);
	// Missing is deliberately narrower than arbitrary server-supplied error messages.
	if (status === 404 && diagnostic[1] !== "Not Found") return undefined;
	return status;
}
/** Bounded asynchronous children; failure/abort waits for close before filesystem cleanup. */
export async function runPublicationProcess(
	command: string,
	args: string[],
	options: PublicationProcessOptions,
): Promise<string> {
	if (
		!Number.isSafeInteger(options.maximumOutputBytes) ||
		options.maximumOutputBytes < 1 ||
		options.maximumOutputBytes > 1024 * 1024 ||
		!Number.isSafeInteger(options.timeoutMs) ||
		options.timeoutMs < 1 ||
		options.timeoutMs > TIMEOUT
	)
		throw new Error("Invalid CI subprocess budget");
	const env = options.environment ?? process.env;
	const signal = AbortSignal.any([
		...(options.signal ? [options.signal] : []),
		AbortSignal.timeout(options.timeoutMs),
	]);
	signal.throwIfAborted();
	const childEnv = {
		...updateServerChildEnvironment(env),
		GH_HOST: "github.com",
		GH_PROMPT_DISABLED: "1",
	};
	const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: childEnv });
	const cancel = () => {
		child.kill("SIGKILL");
	};
	signal.addEventListener("abort", cancel, { once: true });
	if (signal.aborted) cancel();
	const collect = async (stream: NodeJS.ReadableStream) => {
		const chunks: Buffer[] = [];
		let bytes = 0;
		let exceeded = false;
		try {
			for await (const chunk of stream) {
				const buffer = Buffer.from(chunk);
				bytes += buffer.length;
				if (bytes > options.maximumOutputBytes) {
					exceeded = true;
					throw new Error("GitHub publication output exceeds limit");
				}
				chunks.push(buffer);
			}
			return Buffer.concat(chunks, bytes).toString("utf8");
		} catch {
			cancel();
			throw new Error(
				exceeded
					? "GitHub publication output exceeds limit"
					: "GitHub publication output collection failed",
			);
		}
	};
	let spawnFailed = false;
	const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		// Do not expose native errors (which can contain paths/arguments/secrets).
		child.once("error", () => {
			spawnFailed = true;
			cancel();
		});
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	try {
		// Nonzero close must not race ahead of the bounded stderr reader. Rejected
		// readers already kill the child; every path waits for close and both readers.
		const [stdout, stderr, closed] = await Promise.allSettled([
			collect(child.stdout),
			collect(child.stderr),
			exit,
		]);
		signal.throwIfAborted();
		if (spawnFailed) throw new Error("GitHub publication subprocess failed");
		if (stdout.status === "rejected") throw stdout.reason;
		if (stderr.status === "rejected") throw stderr.reason;
		if (closed.status === "rejected") throw new Error("GitHub publication subprocess failed");
		if (spawnFailed || closed.value.signal || closed.value.code !== 0) {
			const status =
				!spawnFailed && !closed.value.signal && closed.value.code !== null
					? failedGhApiStatus(command, args, stderr.value)
					: undefined;
			// Log fixed categories and numbers only, never argv, URLs, or diagnostic payloads.
			const apiOperations = [
				[/\/releases\/assets\//, "release-asset"],
				[/\/releases(?:\/|\?)/, "release-read"],
				[/\/git\/(?:ref\/tags|tags)\//, "tag-read"],
				[/^graphql$/, "graphql"],
			] as const;
			const apiOperation =
				command === "gh" && args[0] === "api"
					? apiOperations.find(([pattern]) => pattern.test(args[1] ?? ""))?.[1]
					: undefined;
			const operation =
				command === "gh" &&
				args[0] === "release" &&
				["create", "upload", "download", "edit", "view"].includes(args[1] ?? "")
					? `gh release ${args[1]}`
					: apiOperation
						? `gh api ${apiOperation}`
						: undefined;
			const line = stderr.value.slice(0, 4096).split(/\r?\n/, 1)[0] ?? "";
			// Non-authoritative diagnostics deliberately use status=, never HTTP 404.
			// They cannot turn a failed API lookup into permission to create anything.
			const diagnosticStatus =
				operation && !closed.value.signal
					? /^(?:failed to create release: )?HTTP ([45]\d{2}):/.exec(line)?.[1]
					: undefined;
			const cause =
				!closed.value.signal &&
				/^(?:HTTP 403: |GraphQL: )Resource not accessible by integration\b/.test(line)
					? "integration-permission-denied"
					: !closed.value.signal && /^unknown flag:/.test(line)
						? "unsupported-option"
						: undefined;
			const detail =
				status !== undefined
					? ` (HTTP ${status})`
					: operation
						? ` (${operation}; exit=${closed.value.code ?? "signal"}${diagnosticStatus ? `; status=${diagnosticStatus}` : ""}${cause ? `; cause=${cause}` : ""})`
						: "";
			if (status !== undefined) throw new PublicationGhApiError(status);
			throw new Error(`GitHub publication subprocess failed${detail}`);
		}
		return stdout.value;
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}
export function createPublicationGhRunner(
	parent: AbortSignal,
	env: NodeJS.ProcessEnv = process.env,
): GhRunner {
	return (args) =>
		runPublicationProcess("gh", args, {
			signal: parent,
			environment: env,
			timeoutMs: 5 * 60_000,
			maximumOutputBytes: 1024 * 1024,
		});
}
