import type { ExecutionBackend } from "@server/lib/agent/execution/backend";
import { type AuthorizeFile, uiError } from "./files";

export type KitPackageManager = "bun" | "pnpm" | "yarn" | "npm";
const LOCKFILES = [
	["bun.lock", "bun"],
	["bun.lockb", "bun"],
	["pnpm-lock.yaml", "pnpm"],
	["yarn.lock", "yarn"],
	["package-lock.json", "npm"],
	["npm-shrinkwrap.json", "npm"],
] as const;

export interface KitRunnerSignals {
	manager?: KitPackageManager;
	directories: string[];
	fingerprint: string;
	/** Human-readable source of the selected runner, or the device-probe policy. */
	basis?: string;
	diagnostics?: string[];
}

/** Only inspect the bounded ancestor chain owned by this workspace. */
export async function readKitRunnerSignals(
	backend: ExecutionBackend,
	root: string,
	workspaceRoot: string,
	authorize: AuthorizeFile,
	signal: AbortSignal,
): Promise<KitRunnerSignals> {
	const directories: string[] = [];
	let directory = root;
	for (;;) {
		if (
			!backend.paths.equals(directory, workspaceRoot) &&
			!backend.paths.contains(workspaceRoot, directory)
		)
			throw uiError("Vite root must stay inside the workspace", 403);
		directories.push(directory);
		if (backend.paths.equals(directory, workspaceRoot)) break;
		if (directories.length >= 32)
			throw uiError("Vite root exceeds the 32-directory inspection limit", 422);
		directory = backend.paths.dirname(directory);
	}
	const signals: string[] = [];
	let configured: KitPackageManager | undefined;
	let locked: KitPackageManager | undefined;
	let configuredAt: string | undefined;
	let lockedAt: string | undefined;
	const locks: Array<{ manager: KitPackageManager; path: string }> = [];
	for (const dir of directories) {
		signal.throwIfAborted();
		const path = backend.paths.resolve(dir, "package.json");
		const stat = await backend.statFile(path, { signal, timeoutMs: 15_000 });
		if (stat?.isFile) {
			await authorize(path, signal);
			if (stat.size > 65_536)
				throw uiError("package.json exceeds its 65536-byte inspection limit", 413);
			const read = await backend.readFileBytes(path, {
				maxBytes: 65_536,
				expectedResolvedPath: stat.resolvedPath,
				signal,
				timeoutMs: 15_000,
			});
			if (read.truncated)
				throw uiError("package.json exceeds its 65536-byte inspection limit", 413);
			let pkg: { packageManager?: unknown };
			try {
				pkg = JSON.parse(new TextDecoder().decode(read.bytes));
			} catch {
				throw uiError(`Invalid package.json at ${path}`, 422);
			}
			const value = pkg?.packageManager;
			signals.push(`${path}:${JSON.stringify(value)}`);
			if (value !== undefined && !configured) {
				const match =
					typeof value === "string" &&
					/^(bun|pnpm|yarn|npm)(?:@[0-9][A-Za-z0-9.+_-]*)?$/.exec(value);
				if (!match)
					throw uiError(`Unsupported packageManager in ${path}; use bun, pnpm, yarn or npm`, 422);
				configured = match[1] as KitPackageManager;
				configuredAt = path;
			}
		}
		for (const [name, manager] of LOCKFILES) {
			const lockPath = backend.paths.resolve(dir, name);
			const lock = await backend.statFile(lockPath, { signal, timeoutMs: 15_000 });
			if (lock?.isFile) {
				await authorize(lockPath, signal);
				locked ??= manager;
				lockedAt ??= lockPath;
				locks.push({ manager, path: lockPath });
				// Preserve the cheap size proxy; do not load multi-megabyte lockfiles.
				signals.push(`${lockPath}:${lock.size}`);
			}
		}
	}
	const manager = configured ?? locked;
	const basis = configuredAt
		? `packageManager in ${configuredAt}`
		: lockedAt
			? `lockfile ${lockedAt}`
			: "execution-device probe (Bun preferred)";
	const diagnostics = locks
		.filter((lock) => lock.manager !== manager)
		.map(
			(lock) =>
				`Runner conflict: ${lock.path} indicates ${lock.manager}; using ${manager} selected by ${basis}.`,
		);
	return { manager, directories, fingerprint: JSON.stringify(signals), basis, diagnostics };
}

export function quoteKitArgument(backend: ExecutionBackend, value: string): string {
	if (/[\0\r\n]/.test(value)) throw uiError("Invalid character in build argument", 422);
	const shell = backend.platform?.shellType;
	if (shell === "powershell") return `'${value.replaceAll("'", "''")}'`;
	if (shell === "cmd" || (!shell && backend.pathFlavor === "windows")) {
		// cmd expands these even inside quotes. Fail closed rather than reinterpret a path.
		if (/["%!]/.test(value))
			throw uiError("This build path cannot be quoted safely for cmd; use PowerShell", 422);
		return `"${value}"`;
	}
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function probeKitRunner(
	backend: ExecutionBackend,
	manager: KitPackageManager,
	cwd: string,
	signal: AbortSignal,
	limits = { timeoutMs: 5_000, outputBytes: 16_384 },
): Promise<boolean> {
	signal.throwIfAborted();
	const controller = new AbortController();
	let handle: Awaited<ReturnType<ExecutionBackend["execCommand"]>> | undefined;
	let stopped = false;
	let killRequested = false;
	let finishStop: (value: false) => void = () => {};
	const interrupted = new Promise<false>((resolve) => {
		finishStop = resolve;
	});
	const kill = () => {
		if (!handle || killRequested) return;
		killRequested = true;
		// Termination is best effort: neither an RPC rejection nor a hung kill may
		// prevent this bounded probe from returning. Do not claim the process exited.
		void Promise.resolve()
			.then(() => handle?.kill())
			.catch(() => {});
	};
	const stop = () => {
		stopped = true;
		controller.abort();
		kill();
		finishStop(false);
	};
	const timer = setTimeout(stop, limits.timeoutMs);
	signal.addEventListener("abort", stop, { once: true });
	if (signal.aborted) stop();
	const execution = (async () => {
		handle = await backend.execCommand({
			command: `${manager} --version`,
			cwd,
			signal: controller.signal,
			env: { CI: "1", COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
		});
		let bytes = 0;
		handle.onData((chunk) => {
			if (stopped) return;
			bytes += chunk.byteLength;
			if (bytes > limits.outputBytes) stop();
		});
		if (stopped) kill();
		return (await handle.exited) === 0 && !stopped;
	})();
	try {
		const result = await Promise.race([execution, interrupted]);
		signal.throwIfAborted();
		return result;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", stop);
	}
}

export async function kitBuildCommand(
	backend: ExecutionBackend,
	signals: KitRunnerSignals,
	config: string,
	authorize: AuthorizeFile,
	signal: AbortSignal,
	injectedRunner = false,
	report?: (diagnostic: string) => void,
): Promise<string> {
	let manager = signals.manager;
	if (!injectedRunner) {
		if (manager) {
			if (!(await probeKitRunner(backend, manager, signals.directories[0], signal)))
				throw uiError(
					`The project requires ${manager} (${signals.basis ?? "project configuration"}), but it is unavailable on the execution device. Install that runner; no alternative was used. ${(signals.diagnostics ?? []).join(" ").slice(0, 8_192)}`,
					422,
				);
		} else {
			for (const candidate of ["bun", "npm", "pnpm", "yarn"] as const) {
				if (await probeKitRunner(backend, candidate, signals.directories[0], signal)) {
					manager = candidate;
					break;
				}
			}
			if (!manager)
				throw uiError("No Bun, npm, pnpm or Yarn runner is available on the execution device", 422);
		}
	}
	manager ??= "bun";
	report?.(
		[
			`Build runner: ${manager}; selected by ${signals.basis ?? (signals.manager ? "project configuration" : "execution-device probe (Bun preferred)")}.`,
			...(signals.diagnostics ?? []),
		]
			.join("\n")
			.slice(0, 8_192),
	);
	let cli: string | undefined;
	for (const dir of signals.directories) {
		const path = backend.paths.resolve(dir, "node_modules/vite/bin/vite.js");
		if ((await backend.statFile(path, { signal, timeoutMs: 15_000 }))?.isFile) {
			await authorize(path, signal);
			cli = path;
			break;
		}
	}
	if (!cli && !injectedRunner)
		throw uiError(
			"Vite is not installed locally in this workspace. Install project dependencies before kit_build; dependencies are never downloaded automatically.",
			422,
		);
	// Explicit JS entry bypasses Vite's node shebang: Bun-only devices need no node/npx.
	const q = (value: string) => quoteKitArgument(backend, value);
	const entry = q(
		cli ?? backend.paths.resolve(signals.directories[0], "node_modules/vite/bin/vite.js"),
	);
	const runner =
		manager === "bun"
			? `bun --bun --no-install ${entry}`
			: manager === "pnpm"
				? `pnpm exec node ${entry}`
				: manager === "yarn"
					? `yarn node ${entry}`
					: `npm exec --offline --no -- node ${entry}`;
	return `${runner} build --mode production --config ${q(config)}`;
}
