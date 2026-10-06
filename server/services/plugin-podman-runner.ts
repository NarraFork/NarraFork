import {
	LocalProcessRunner,
	type PluginProcessHandle,
	type PluginProcessSpawner,
	type PluginRunner,
	type RunnerStartOptions,
} from "./plugin-runtime";

export interface PodmanResourceLimits {
	memoryBytes: number;
	cpus: number;
	pidsLimit: number;
	tmpfsBytes: number;
}

export interface PodmanPluginSpec {
	runtimeId: string;
	image: string;
	imageDigest: string;
	packagePath: string;
	dataPath: string;
	tempPath?: string;
	user?: string;
	network?: "none" | string;
	limits?: Partial<PodmanResourceLimits>;
}

export interface PodmanRunnerOptions {
	podmanBinary?: string;
	defaultLimits?: PodmanResourceLimits;
	spawn?: PluginProcessSpawner;
	available?: boolean;
	availabilityTimeoutMs?: number;
}

export const DEFAULT_PODMAN_AVAILABILITY_TIMEOUT_MS = 5_000;

export const DEFAULT_PODMAN_LIMITS: PodmanResourceLimits = {
	memoryBytes: 512 * 1024 * 1024,
	cpus: 1,
	pidsLimit: 128,
	tmpfsBytes: 64 * 1024 * 1024,
};

function formatBytes(bytes: number): string {
	if (!Number.isSafeInteger(bytes) || bytes <= 0)
		throw new RangeError("resource byte limit must be positive");
	return `${bytes}b`;
}

function assertAbsolutePath(path: string, label: string): void {
	if (!path || !/^(?:[A-Za-z]:[\\/]|\/)/.test(path)) throw new Error(`${label} must be absolute`);
}

/** Pure command builder; tests can validate the sandbox without Podman installed. */
export function buildPodmanCommand(spec: PodmanPluginSpec, command: readonly string[]): string[] {
	if (!spec.image || !spec.imageDigest.startsWith("sha256:"))
		throw new Error("Podman image digest is required");
	if (command.length === 0) throw new Error("Podman plugin command is required");
	assertAbsolutePath(spec.packagePath, "packagePath");
	assertAbsolutePath(spec.dataPath, "dataPath");
	if (spec.tempPath) assertAbsolutePath(spec.tempPath, "tempPath");
	const limits = { ...DEFAULT_PODMAN_LIMITS, ...spec.limits };
	if (limits.cpus <= 0 || limits.pidsLimit <= 0 || limits.tmpfsBytes <= 0)
		throw new RangeError("invalid Podman limits");
	const packageMount = `${spec.packagePath}:/plugin:ro`;
	const dataMount = `${spec.dataPath}:/data:rw`;
	// `/tmp` has exactly one target: use the bounded tmpfs by default, or the
	// explicitly supplied host temp directory. Never emit both mounts.
	const tempMount = spec.tempPath ? ["--volume", `${spec.tempPath}:/tmp:rw`] : [];
	const tmpfsMount = spec.tempPath
		? []
		: ["--tmpfs", `/tmp:rw,size=${formatBytes(limits.tmpfsBytes)},noexec,nosuid,nodev`];
	return [
		"run",
		"--rm",
		"--interactive",
		"--name",
		`nf-plugin-${spec.runtimeId}`,
		"--userns=keep-id",
		"--user",
		spec.user ?? "65532:65532",
		"--read-only",
		"--network",
		spec.network ?? "none",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--pids-limit",
		String(limits.pidsLimit),
		"--memory",
		formatBytes(limits.memoryBytes),
		"--cpus",
		String(limits.cpus),
		...tmpfsMount,
		"--volume",
		packageMount,
		"--volume",
		dataMount,
		...tempMount,
		`${spec.image}@${spec.imageDigest}`,
		...command,
	];
}

export function isPodmanUnavailable(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /ENOENT|not found|cannot connect|podman.*(unavailable|not installed)/i.test(message);
}

async function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Podman availability check timed out")),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Optional runner: callers must opt in; it never falls back to local execution. */
export class PodmanRunner implements PluginRunner {
	private readonly binary: string;
	private readonly defaults: PodmanResourceLimits;
	private readonly local: LocalProcessRunner;
	private readonly availableOverride?: boolean;
	private readonly availabilityTimeoutMs: number;

	constructor(
		private readonly spec: PodmanPluginSpec,
		options: PodmanRunnerOptions = {},
	) {
		this.binary = options.podmanBinary ?? "podman";
		this.defaults = { ...DEFAULT_PODMAN_LIMITS, ...options.defaultLimits };
		this.availableOverride = options.available;
		this.availabilityTimeoutMs =
			options.availabilityTimeoutMs ?? DEFAULT_PODMAN_AVAILABILITY_TIMEOUT_MS;
		if (!Number.isFinite(this.availabilityTimeoutMs) || this.availabilityTimeoutMs <= 0)
			throw new RangeError("availabilityTimeoutMs must be positive");
		this.local = new LocalProcessRunner({
			spawn: options.spawn,
			allowedCwds: [spec.packagePath, spec.dataPath, spec.tempPath ?? spec.dataPath],
		});
	}

	get commandPrefix(): string[] {
		return [this.binary];
	}

	buildCommand(command: readonly string[]): string[] {
		return [
			this.binary,
			...buildPodmanCommand(
				{ ...this.spec, limits: { ...this.defaults, ...this.spec.limits } },
				command,
			),
		];
	}

	async isAvailable(): Promise<boolean> {
		if (this.availableOverride !== undefined) return this.availableOverride;
		let process: ReturnType<typeof Bun.spawn> | undefined;
		try {
			process = Bun.spawn([this.binary, "info", "--format", "{{.Version}}"], {
				stdout: "ignore",
				stderr: "ignore",
			});
			const exitCode = await promiseWithTimeout(process.exited, this.availabilityTimeoutMs);
			return exitCode === 0;
		} catch {
			process?.kill();
			return false;
		}
	}

	async start(options: RunnerStartOptions): Promise<PluginProcessHandle> {
		if (!(await this.isAvailable()))
			throw new Error("Podman is unavailable; sandbox execution is disabled");
		const command = this.buildCommand(options.command);
		return this.local.start({ ...options, command, cwd: this.spec.packagePath });
	}
}
