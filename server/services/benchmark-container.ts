/**
 * Podman container management for benchmark isolation.
 *
 * Provides lifecycle management for SWE-bench evaluation containers:
 * create → exec → collect results → destroy.
 *
 * Uses podman (rootless) directly, independent of NarraFork's container-service
 * which is designed around chapter-level compose workflows.
 */

import { logger } from "../lib/logger";

interface ContainerCreateOpts {
	/** Docker/OCI image to use, e.g. "python:3.9-slim" */
	image: string;
	/** Host directory to bind-mount into the container */
	hostDir: string;
	/** Mount point inside the container (default: /testbed) */
	containerDir?: string;
	/** Optional name for the container */
	name?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Memory limit, e.g. "4g" */
	memoryLimit?: string;
}

interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

const PODMAN = "podman";
const DEFAULT_MOUNT = "/testbed";
const EXEC_TIMEOUT_MS = 600_000; // 10 min default

/** Run a podman command and return stdout/stderr. */
async function podman(args: string[], timeoutMs = 60_000): Promise<ExecResult> {
	const proc = Bun.spawn([PODMAN, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});

	const timer = setTimeout(() => {
		try {
			proc.kill();
		} catch {
			/* ignore */
		}
	}, timeoutMs);

	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	clearTimeout(timer);

	return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Check if podman is available. */
export async function checkPodman(): Promise<{ available: boolean; version?: string }> {
	try {
		const r = await podman(["--version"], 5_000);
		if (r.exitCode === 0) {
			return { available: true, version: r.stdout };
		}
		return { available: false };
	} catch {
		return { available: false };
	}
}

/** Pull an image if not already present. */
export async function ensureImage(image: string): Promise<void> {
	const check = await podman(["image", "exists", image], 5_000);
	if (check.exitCode === 0) return;

	logger.info("Pulling container image", { image });
	const pull = await podman(["pull", image], 300_000); // 5 min for pull
	if (pull.exitCode !== 0) {
		throw new Error(`Failed to pull image ${image}: ${pull.stderr}`);
	}
}

/**
 * Create and start a container with a bind-mounted working directory.
 * Returns the container ID.
 */
export async function createContainer(opts: ContainerCreateOpts): Promise<string> {
	const mountTarget = opts.containerDir ?? DEFAULT_MOUNT;

	const args = [
		"run",
		"-d",
		"--name",
		opts.name ?? `nf-bench-${Date.now()}`,
		"-v",
		`${opts.hostDir}:${mountTarget}:Z`,
		"-w",
		mountTarget,
	];

	if (opts.memoryLimit) {
		args.push("--memory", opts.memoryLimit);
	}

	if (opts.env) {
		for (const [k, v] of Object.entries(opts.env)) {
			args.push("-e", `${k}=${v}`);
		}
	}

	// Keep container alive with tail -f /dev/null
	args.push(opts.image, "tail", "-f", "/dev/null");

	const r = await podman(args, 120_000);
	if (r.exitCode !== 0) {
		throw new Error(`Failed to create container: ${r.stderr}`);
	}

	const containerId = r.stdout.slice(0, 12);
	logger.info("Container created", { containerId, image: opts.image, hostDir: opts.hostDir });
	return containerId;
}

/**
 * Execute a command inside a running container.
 */
export async function execInContainer(
	containerId: string,
	command: string,
	timeoutMs = EXEC_TIMEOUT_MS,
): Promise<ExecResult> {
	return podman(["exec", containerId, "bash", "-c", command], timeoutMs);
}

/**
 * Execute a multi-line script inside a container.
 * Writes the script to a temp file inside the container, then runs it.
 */
export async function execScript(
	containerId: string,
	script: string,
	timeoutMs = EXEC_TIMEOUT_MS,
): Promise<ExecResult> {
	// Write script via stdin
	const proc = Bun.spawn(
		[PODMAN, "exec", "-i", containerId, "bash", "-c", "cat > /tmp/_eval.sh && bash /tmp/_eval.sh"],
		{
			stdin: new Blob([script]),
			stdout: "pipe",
			stderr: "pipe",
		},
	);

	const timer = setTimeout(() => {
		try {
			proc.kill();
		} catch {
			/* ignore */
		}
	}, timeoutMs);

	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	clearTimeout(timer);

	return { exitCode, stdout, stderr };
}

/**
 * Stop and remove a container.
 */
export async function destroyContainer(containerId: string): Promise<void> {
	await podman(["rm", "-f", containerId], 30_000);
	logger.info("Container destroyed", { containerId });
}

/**
 * Get container status.
 */
export async function getContainerStatus(containerId: string): Promise<string> {
	const r = await podman(["inspect", "--format", "{{.State.Status}}", containerId], 5_000);
	return r.exitCode === 0 ? r.stdout : "unknown";
}
