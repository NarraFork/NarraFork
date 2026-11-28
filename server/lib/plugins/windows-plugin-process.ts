import { randomUUID } from "node:crypto";
import type { RunnerProcess, RunnerSpawnOptions } from "../../services/plugin-runtime";
import { WorkerHandle } from "../worker-runtime/lifecycle";
import { type WindowsPluginJobNative, windowsPluginJobNative } from "./windows-plugin-job";
import { buildWindowsPluginLauncherCommand } from "./windows-plugin-launcher";

interface WindowsPluginSpawnDependencies {
	native: WindowsPluginJobNative;
	spawn: (
		command: string[],
		options: RunnerSpawnOptions,
	) => WorkerHandle<Bun.Subprocess<"pipe", "pipe", "pipe">>;
}

/** Windows-only plugin owner. A root PID disappearing is never a tree-exit acknowledgement. */
export function spawnWindowsPluginProcess(
	command: string[],
	options: RunnerSpawnOptions,
	timeoutMs: number,
	dependencies?: WindowsPluginSpawnDependencies,
): RunnerProcess {
	const native = dependencies?.native ?? windowsPluginJobNative();
	const jobName = `Local\\NarraForkPlugin-${randomUUID()}`;
	const job = native.create(jobName);
	let raw: WorkerHandle<Bun.Subprocess<"pipe", "pipe", "pipe">>;
	try {
		const launcherCommand = buildWindowsPluginLauncherCommand(jobName, command);
		raw = dependencies
			? dependencies.spawn(launcherCommand, options)
			: WorkerHandle.subprocess(launcherCommand, { ...options, windowsHide: true });
	} catch {
		// Creation failed before a launcher existed, so the job is provably empty.
		native.close(job);
		throw new Error("Plugin Windows launcher creation failed");
	}
	let termination: Promise<void> | undefined;
	const terminate = () => {
		termination ??= (async () => {
			const deadline = Date.now() + timeoutMs;
			let failure: unknown;
			const terminateJob = () => {
				try {
					native.terminate(job);
				} catch {
					failure ??= new Error("Plugin Windows job termination failed");
				}
			};
			terminateJob();
			try {
				// Also kill an as-yet-unassigned launcher. After raw exit, it cannot
				// assign itself or launch a target after our final active=0 query.
				await beforeDeadline(raw.close(), deadline);
			} catch {
				failure ??= new Error("Plugin Windows launcher exit unconfirmed");
			}
			// A launcher may have assigned/spawned concurrently with the first stop.
			// A second job stop after observing raw exit closes that startup race.
			terminateJob();
			try {
				while (true) {
					const active = native.activeProcesses(job);
					if (!Number.isSafeInteger(active) || active < 0) {
						throw new Error("Plugin Windows job query failed");
					}
					if (active === 0) break;
					if (Date.now() >= deadline) throw new Error("Plugin Windows job exit unconfirmed");
					await new Promise((resolve) => setTimeout(resolve, Math.min(10, deadline - Date.now())));
				}
			} catch {
				failure ??= new Error("Plugin Windows job exit unconfirmed");
			}
			// Unknown/failed native cleanup retains the handle and the caller's
			// WorkerHandle/admission. Closing a job is not evidence of tree exit.
			if (failure) throw failure;
			try {
				native.close(job);
			} catch {
				throw new Error("Plugin Windows job handle close failed");
			}
		})();
		return termination;
	};
	const exited = raw.exited.then(async (code) => {
		await terminate();
		return code;
	});
	// A native failure can arrive before LocalProcessHandle attaches its error sink.
	void exited.catch(() => {});
	return {
		pid: raw.resource.pid,
		stdin: raw.resource.stdin,
		stdout: raw.resource.stdout,
		stderr: raw.resource.stderr,
		exited,
		kill: () => {
			void terminate().catch(() => {});
		},
		terminate,
	};
}

async function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Plugin Windows launcher exit unconfirmed")),
					Math.max(0, deadline - Date.now()),
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
