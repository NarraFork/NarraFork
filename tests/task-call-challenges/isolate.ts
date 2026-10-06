import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { RUNTIME_CONTRACT, type RuntimeContract } from "./contract";
import type { EvalOutcome, MockState } from "./fixtures";

export const IMAGE = "0d36aaa2c1ad7cccd2dc0cf7fba4efb11ea7193023cecb1c27a84463c9ba01aa";
const runnerPath = fileURLToPath(new URL("./runner.ts", import.meta.url));

type Environment = Record<string, string | undefined>;

export function podmanTestsEnabled(env: Environment = process.env): boolean {
	return env.NF_TASK_CHALLENGES_PODMAN === "1";
}

/** Only the Podman CLI uses the host home; application tests remain fully isolated. */
export function podmanEnvironment(env: Environment = process.env): Environment {
	const home =
		env.NF_TASK_CHALLENGES_PODMAN_HOME?.trim() || env.NARRAFORK_ORIGINAL_HOME || env.HOME;
	return { ...env, ...(home ? { HOME: home, USERPROFILE: home } : {}) };
}

/** Explicit container entry points fail clearly, without pulling a substitute image. */
export async function assertPodmanReady(env: Environment = podmanEnvironment()): Promise<void> {
	try {
		const child = Bun.spawn(["podman", "image", "exists", IMAGE], {
			env,
			stdout: "ignore",
			stderr: "ignore",
			timeout: 5000,
			killSignal: "SIGKILL",
		});
		if ((await child.exited) === 0) return;
	} catch {
		// Missing executable and unavailable rootless storage have the same setup remedy.
	}
	throw new Error(
		`Podman or pinned image ${IMAGE} is unavailable. Prepare the image in the host storage ` +
			"selected by NF_TASK_CHALLENGES_PODMAN_HOME / CONTAINERS_STORAGE_CONF. No image was pulled.",
	);
}

export function codeProblem(code: string): string | undefined {
	if (code.length > 16_000) return "代码超过 16,000 字符";
	try {
		const ast = parse(`function answer() {\n${code}\n}`, {
			sourceType: "script",
			plugins: ["typescript"],
		});
		const queue: unknown[] = [ast];
		while (queue.length) {
			const value = queue.pop();
			if (!value || typeof value !== "object") continue;
			if (Array.isArray(value)) {
				queue.push(...value);
				continue;
			}
			const node = value as Record<string, unknown>;
			if (
				node.type === "AwaitExpression" ||
				node.async === true ||
				node.type === "ImportExpression" ||
				node.type === "Import" ||
				node.type === "ImportDeclaration"
			)
				return "本接口为同步脚本，不使用 async/await/import";
			if (node.type === "Identifier" && node.name === "Promise")
				return "本接口不使用 Promise；直接调用同步方法";
			for (const [key, child] of Object.entries(node))
				if (!["loc", "start", "end", "comments", "tokens"].includes(key)) queue.push(child);
		}
	} catch (error) {
		return `TypeScript 语法错误：${String(error).slice(0, 600)}`;
	}
	return undefined;
}

async function boundedText(
	stream: ReadableStream<Uint8Array>,
	limit: number,
	overflow: () => void,
): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > limit) {
				overflow();
				throw new Error("container output limit exceeded");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

async function removeContainer(name: string, env: Environment) {
	const child = Bun.spawn(["podman", "rm", "--force", "--ignore", name], {
		env,
		stdout: "ignore",
		stderr: "ignore",
		timeout: 4000,
		killSignal: "SIGKILL",
	});
	if ((await child.exited) !== 0)
		throw new Error(`Could not clean up experiment container ${name}`);
}

export interface SandboxOutcome extends EvalOutcome {
	delivery?: { summary?: string };
}

export async function executeEval(
	state: MockState,
	code: string,
	contract: RuntimeContract = RUNTIME_CONTRACT,
	runtimePath: string = runnerPath,
): Promise<SandboxOutcome> {
	const problem = codeProblem(code);
	if (problem)
		return {
			ok: false,
			state,
			logs: [],
			error: { code: "SCRIPT_CONTRACT", message: problem },
			interfaceViolation: problem,
		};
	const env = podmanEnvironment();
	await assertPodmanReady(env);
	const name = `nf-task-challenge-${crypto.randomUUID()}`;
	const child = Bun.spawn(
		[
			"podman",
			"run",
			"--rm",
			"--name",
			name,
			"--pull=never",
			"--network=none",
			"--read-only",
			"--cap-drop=ALL",
			"--security-opt=no-new-privileges",
			"--memory=256m",
			"--memory-swap=256m",
			"--cpus=1",
			"--pids-limit=32",
			"--user=65532:65532",
			"--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
			"--env=HOME=/tmp",
			"--timeout=8",
			"--stop-timeout=1",
			"--volume",
			`${runtimePath}:/eval/runner.ts:ro`,
			"--entrypoint=/usr/local/bin/bun",
			"-i",
			IMAGE,
			"/eval/runner.ts",
		],
		{ env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	let timedOut = false;
	let cleanup: Promise<void> | undefined;
	const stop = () => {
		cleanup ??= removeContainer(name, env);
		// Retain rejection for finally, but attach a handler while pipe shutdown settles.
		void cleanup.catch(() => undefined);
		child.kill("SIGKILL");
	};
	const timer = setTimeout(() => {
		timedOut = true;
		stop();
	}, 13_000);
	try {
		child.stdin.write(JSON.stringify({ state, code, contract }));
		child.stdin.end();
		const [stdout, stderr, exitCode] = await Promise.all([
			boundedText(child.stdout, 300_000, stop),
			boundedText(child.stderr, 16_000, stop),
			child.exited,
		]);
		if (exitCode !== 0)
			throw new Error(
				`${timedOut ? "sandbox deadline" : `sandbox exit ${exitCode}`}: ${stderr.slice(0, 1200)}`,
			);
		const result = JSON.parse(stdout) as SandboxOutcome;
		if (!result.state || !Array.isArray(result.state.trace) || typeof result.ok !== "boolean")
			throw new Error("invalid sandbox envelope");
		return result;
	} finally {
		clearTimeout(timer);
		if (cleanup) await cleanup;
		else await removeContainer(name, env);
	}
}
