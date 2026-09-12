import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { PROGRAMMATIC_LIMITS, ProgrammaticError } from "./protocol";
import type {
	CleanupReport,
	IsolationDriver,
	SandboxLaunch,
	SandboxPolicy,
	SandboxSession,
} from "./sandbox";
import { BoundedStderr, NdjsonFrames, NdjsonWriter, WireBudget } from "./wire";

const POLICY: SandboxPolicy = Object.freeze({
	kind: "podman",
	uid: 65532,
	memoryBytes: 256 * 1024 * 1024,
	maxPids: 32,
	cpuCores: 1,
	cpuSeconds: 5,
});
const COMMAND_TIMEOUT_MS = 5000;
const COMMAND_OUTPUT_BYTES = 1024 * 1024;

/** Do not inherit remote Podman selectors, proxies, loader flags or provider credentials. */
function hostEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of [
		"PATH",
		"HOME",
		"XDG_RUNTIME_DIR",
		"DBUS_SESSION_BUS_ADDRESS",
		"LANG",
		"LC_ALL",
		"LC_CTYPE",
	]) {
		if (process.env[key] !== undefined) env[key] = process.env[key];
	}
	return env;
}

function command(
	path: string,
	args: string[],
	signal?: AbortSignal,
): Promise<{ code: number; stdout: string }> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new ProgrammaticError("CANCELLED", "Availability check cancelled"));
			return;
		}
		const child = spawn(path, ["--remote=false", ...args], {
			env: hostEnvironment(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		let bytes = 0;
		let settled = false;
		const finish = (error?: Error, code = -1) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			error ? reject(error) : resolve({ code, stdout: Buffer.concat(chunks).toString("utf8") });
		};
		const stop = (error: Error) => {
			child.kill("SIGKILL");
			finish(error);
		};
		const abort = () => stop(new ProgrammaticError("CANCELLED", "Availability check cancelled"));
		const timer = setTimeout(
			() => stop(new ProgrammaticError("SANDBOX_UNAVAILABLE", "Podman command timed out")),
			COMMAND_TIMEOUT_MS,
		);
		signal?.addEventListener("abort", abort, { once: true });
		for (const [stream, keep] of [
			[child.stdout, true],
			[child.stderr, false],
		] as const) {
			stream.on("data", (chunk: Buffer) => {
				if (settled) return;
				bytes += chunk.length;
				if (bytes > COMMAND_OUTPUT_BYTES) {
					stop(new ProgrammaticError("OUTPUT_LIMIT", "Podman command output exceeded budget"));
					return;
				}
				if (keep) chunks.push(chunk);
			});
		}
		child.once("error", (error) => finish(error));
		child.once("close", (code) => finish(undefined, code ?? -1));
	});
}

async function boundedExit(exited: Promise<number>): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			exited.then(() => true),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), COMMAND_TIMEOUT_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

const inspectSchema = z.object({
	Name: z.string(),
	Image: z.string(),
	State: z.object({ Running: z.literal(true) }),
	Mounts: z
		.array(
			z.object({
				Type: z.literal("bind"),
				Source: z.string(),
				Destination: z.string(),
				RW: z.literal(false),
				Propagation: z.literal("rprivate"),
			}),
		)
		.length(1),
	EffectiveCaps: z.array(z.string()).max(0).nullable(),
	BoundingCaps: z.array(z.string()).max(0).nullable(),
	Config: z.object({
		User: z.literal("65532:65532"),
		Env: z.array(z.string()).max(4),
		Entrypoint: z.tuple([z.literal("/usr/local/bin/bun")]),
		Cmd: z.tuple([z.literal("/eval/bootstrap.mjs")]),
		WorkingDir: z.literal("/eval"),
		Timeout: z.number().int().positive(),
		StopTimeout: z.literal(0),
	}),
	HostConfig: z.object({
		Privileged: z.literal(false),
		ReadonlyRootfs: z.literal(true),
		NetworkMode: z.literal("none"),
		PidMode: z.literal("private"),
		IpcMode: z.literal("private"),
		UTSMode: z.literal("private"),
		CgroupMode: z.literal("private"),
		Memory: z.literal(268435456),
		MemorySwap: z.literal(268435456),
		PidsLimit: z.literal(32),
		CpuQuota: z.literal(100000),
		CpuPeriod: z.literal(100000),
		ShmSize: z.literal(4194304),
		SecurityOpt: z.tuple([z.literal("no-new-privileges")]),
		Devices: z.array(z.unknown()).max(0),
		CapAdd: z.array(z.unknown()).max(0),
		GroupAdd: z.array(z.unknown()).max(0),
		Tmpfs: z.record(z.string(), z.string()),
		Ulimits: z.array(z.object({ Name: z.string(), Soft: z.number(), Hard: z.number() })),
	}),
});

/** Host-observed effective config, never a sandbox self-attestation. Exported for adversarial tests. */
export function assertContainerIsolation(
	value: unknown,
	expected: { name: string; imageId: string; bootstrap: string; wallMs: number },
): void {
	const parsed = inspectSchema.safeParse(value);
	if (!parsed.success)
		throw new ProgrammaticError(
			"SANDBOX_POLICY",
			"Actual container isolation differs from required policy",
		);
	const item = parsed.data;
	const mount = item.Mounts[0];
	const env = new Set(item.Config.Env);
	const cpu = item.HostConfig.Ulimits.find((limit) => limit.Name === "RLIMIT_CPU");
	const tmpfs = item.HostConfig.Tmpfs;
	if (
		item.Name !== expected.name ||
		item.Image.replace(/^sha256:/, "") !== expected.imageId ||
		mount?.Source !== expected.bootstrap ||
		mount.Destination !== "/eval/bootstrap.mjs" ||
		item.Config.Timeout !== Math.ceil(expected.wallMs / 1000) ||
		!env.has("PATH=/usr/local/bin:/usr/bin:/bin") ||
		!env.has("BUN_RUNTIME_TRANSPILER_CACHE_PATH=0") ||
		!item.Config.Env.every(
			(entry) =>
				entry === "PATH=/usr/local/bin:/usr/bin:/bin" ||
				entry === "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0" ||
				entry === "HOME=/eval" ||
				/^HOSTNAME=[a-f0-9]{12}$/.test(entry),
		) ||
		cpu?.Soft !== 5 ||
		cpu.Hard !== 6 ||
		Object.keys(tmpfs).length !== 1 ||
		!["rw", "nosuid", "nodev", "noexec", "size=16777216"].every((option) =>
			tmpfs["/tmp"]?.split(",").includes(option),
		)
	) {
		throw new ProgrammaticError(
			"SANDBOX_POLICY",
			"Container mounts, environment or resource limits are not allowlisted",
		);
	}
}

export function createPodmanDriver(options: {
	imageId: string;
	podmanPath?: string;
}): IsolationDriver {
	if (!/^(?:sha256:)?[a-fA-F0-9]{64}$/.test(options.imageId))
		throw new ProgrammaticError(
			"SANDBOX_UNAVAILABLE",
			"A complete immutable local image ID is required",
		);
	const imageId = options.imageId.replace(/^sha256:/, "").toLowerCase();
	const path = options.podmanPath ?? "podman";
	async function checkAvailable(signal?: AbortSignal): Promise<void> {
		if (process.platform !== "linux")
			throw new ProgrammaticError("SANDBOX_UNAVAILABLE", "Linux isolation is required");
		const info = await command(path, ["info", "--format=json"], signal);
		if (info.code !== 0)
			throw new ProgrammaticError("SANDBOX_UNAVAILABLE", "Local Podman info failed");
		const host = JSON.parse(info.stdout)?.host;
		if (
			host?.os !== "linux" ||
			host?.serviceIsRemote !== false ||
			host?.cgroupVersion !== "v2" ||
			host?.security?.rootless !== true ||
			host?.security?.seccompEnabled !== true ||
			!["cpu", "memory", "pids"].every((key) => host?.cgroupControllers?.includes(key))
		) {
			throw new ProgrammaticError(
				"SANDBOX_UNAVAILABLE",
				"Local rootless Podman, cgroup v2 controllers and seccomp are required",
			);
		}
		const inspected = await command(path, ["image", "inspect", imageId], signal);
		if (inspected.code !== 0)
			throw new ProgrammaticError(
				"SANDBOX_UNAVAILABLE",
				"Pinned local image is unavailable; pulling is prohibited",
			);
		const images = JSON.parse(inspected.stdout);
		if (
			!Array.isArray(images) ||
			images.length !== 1 ||
			typeof images[0]?.Id !== "string" ||
			images[0].Id.replace(/^sha256:/, "").toLowerCase() !== imageId ||
			images[0].Os !== "linux"
		)
			throw new ProgrammaticError("SANDBOX_UNAVAILABLE", "Local image ID does not match");
	}
	async function launch(options: SandboxLaunch): Promise<SandboxSession> {
		if (
			!Number.isInteger(options.wallMs) ||
			options.wallMs < 1 ||
			options.wallMs > PROGRAMMATIC_LIMITS.maxWallMs
		)
			throw new ProgrammaticError("SANDBOX_POLICY", "Invalid wall time budget");
		if (
			options.bootstrap.length > PROGRAMMATIC_LIMITS.wireFrameBytes ||
			Buffer.byteLength(options.bootstrap) > PROGRAMMATIC_LIMITS.wireFrameBytes
		)
			throw new ProgrammaticError("SANDBOX_POLICY", "Trusted bootstrap is too large");
		await checkAvailable(options.signal);
		const name = `nf-eval-${randomUUID()}`;
		const directory = await mkdtemp(join(tmpdir(), `${name}-`));
		const bootstrap = join(directory, "bootstrap.mjs");
		try {
			await chmod(directory, 0o700);
			await writeFile(bootstrap, options.bootstrap, { mode: 0o444, flag: "wx" });
			if (options.signal.aborted)
				throw new ProgrammaticError("CANCELLED", "Sandbox launch cancelled");
		} catch (error) {
			await rm(directory, { recursive: true, force: true });
			throw error;
		}
		// No shell, inherited mounts, image volumes, image entrypoint, host env, or pull fallback.
		const args = [
			"--remote=false",
			"run",
			"--default-mounts-file=/dev/null",
			"--name",
			name,
			"--rm",
			"--interactive",
			"--pull=never",
			"--read-only",
			"--read-only-tmpfs=false",
			"--network=none",
			"--cap-drop=ALL",
			"--security-opt=no-new-privileges",
			"--seccomp-policy=default",
			"--user=65532:65532",
			"--userns=host",
			"--pid=private",
			"--ipc=private",
			"--uts=private",
			"--cgroupns=private",
			"--cgroups=enabled",
			`--memory=${POLICY.memoryBytes}`,
			`--memory-swap=${POLICY.memoryBytes}`,
			"--pids-limit=32",
			"--cpus=1",
			"--ulimit=cpu=5:6",
			"--ulimit=core=0:0",
			"--ulimit=nofile=128:128",
			"--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=16777216,mode=1777",
			"--shm-size=4194304",
			"--image-volume=ignore",
			"--no-healthcheck",
			"--systemd=false",
			"--http-proxy=false",
			"--unsetenv-all",
			"--env=PATH=/usr/local/bin:/usr/bin:/bin",
			"--env=BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
			"--log-driver=none",
			"--stop-timeout=0",
			`--timeout=${Math.max(1, Math.ceil(options.wallMs / 1000))}`,
			"--workdir=/eval",
			"--entrypoint=/usr/local/bin/bun",
			"--mount",
			`type=bind,src=${bootstrap},dst=/eval/bootstrap.mjs,ro=true`,
			imageId,
			"/eval/bootstrap.mjs",
		];
		const child = spawn(path, args, { env: hostEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
		let exitCode: number | null = null;
		let clientClosed = false;
		let cleanup: Promise<CleanupReport> | undefined;
		const exited = new Promise<number>((resolve) => {
			child.once("exit", (code) => {
				clientClosed = true;
				exitCode = code ?? -1;
				resolve(exitCode);
			});
			child.once("error", () => {
				if (child.pid === undefined) {
					clientClosed = true;
					exitCode = -1;
					resolve(-1);
				}
			});
		});
		const terminate = (): Promise<CleanupReport> => {
			cleanup ??= (async () => {
				clearTimeout(wallTimer);
				options.signal.removeEventListener("abort", abort);
				writer.close();
				try {
					// First reap the launcher so cancellation cannot race a later container creation.
					if (!clientClosed) child.kill("SIGKILL");
					if (!(await boundedExit(exited)))
						return {
							confirmed: false,
							exitCode,
							message: "Owned Podman client did not exit; temporary bootstrap retained",
						};
					await command(path, ["rm", "--force", "--time=0", name]);
					const exists = await command(path, ["container", "exists", name]);
					if (exists.code !== 1)
						return {
							confirmed: false,
							exitCode,
							message: "Container absence could not be confirmed; temporary bootstrap retained",
						};
					await rm(directory, { recursive: true, force: true });
					return { confirmed: true, exitCode };
				} catch (error) {
					return {
						confirmed: false,
						exitCode,
						message: error instanceof Error ? error.message : "Sandbox cleanup failed",
					};
				}
			})();
			return cleanup;
		};
		const fail = (error: Error) => {
			frames.fail(error);
			void terminate();
		};
		const budget = new WireBudget();
		const frames = new NdjsonFrames(budget, () => {
			void terminate();
		});
		const writer = new NdjsonWriter(child.stdin, budget, fail);
		const stderr = new BoundedStderr(() =>
			fail(new ProgrammaticError("OUTPUT_LIMIT", "Sandbox stderr budget exceeded")),
		);
		const abort = () => fail(new ProgrammaticError("CANCELLED", "Sandbox cancelled"));
		const wallTimer = setTimeout(
			() => fail(new ProgrammaticError("WALL_LIMIT", "Sandbox wall time exceeded")),
			options.wallMs,
		);
		child.stdout.on("data", (chunk: Buffer) => frames.push(chunk));
		child.stdout.once("end", () => frames.finish());
		child.stdout.once("error", fail);
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.stderr.once("error", fail);
		child.once("error", fail);
		void exited.then(() => {
			writer.close();
			// Process exit is not stdout EOF; the stdout end handler owns frame completion.
			// If stdout never closes, terminate/outer wall deadline keeps the run bounded.
			void terminate();
		});
		options.signal.addEventListener("abort", abort, { once: true });
		if (options.signal.aborted) abort();
		let verification: Promise<void> | undefined;
		const verifyIsolation = (): Promise<void> => {
			verification ??= (async () => {
				if (cleanup || options.signal.aborted)
					throw new ProgrammaticError("CANCELLED", "Sandbox is closing");
				const result = await command(path, ["container", "inspect", name], options.signal);
				if (result.code !== 0)
					throw new ProgrammaticError("SANDBOX_POLICY", "Cannot inspect running sandbox");
				const containers = JSON.parse(result.stdout);
				if (!Array.isArray(containers) || containers.length !== 1)
					throw new ProgrammaticError("SANDBOX_POLICY", "Invalid container inspect response");
				assertContainerIsolation(containers[0], {
					name,
					imageId,
					bootstrap,
					wallMs: options.wallMs,
				});
				if (cleanup || options.signal.aborted)
					throw new ProgrammaticError("CANCELLED", "Sandbox closed during verification");
			})().catch((error: Error) => {
				fail(error);
				throw error;
			});
			return verification;
		};
		return {
			policy: POLICY,
			frames,
			exited,
			verifyIsolation,
			send: async (json) => {
				await verifyIsolation();
				if (cleanup || options.signal.aborted)
					throw new ProgrammaticError("CLOSED", "Sandbox input is closed");
				await writer.send(json);
			},
			terminate,
			stderr: () => stderr.text(),
		};
	}
	return { policy: POLICY, checkAvailable, launch };
}
