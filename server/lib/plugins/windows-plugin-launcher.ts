import { fileURLToPath } from "node:url";
import { isCompiledRuntime } from "../runtime-target";
import { WorkerHandle } from "../worker-runtime/lifecycle";
import {
	validWindowsPluginJobName,
	type WindowsPluginJobNative,
	windowsPluginJobNative,
} from "./windows-plugin-job";

export const WINDOWS_PLUGIN_LAUNCHER_MODE = "--windows-plugin-launcher";

/** Internal argv only; plugin argv and its allowlisted environment are unchanged. */
export function buildWindowsPluginLauncherCommand(
	jobName: string,
	command: string[],
	compiled = isCompiledRuntime(),
	executable = process.execPath,
): string[] {
	return compiled
		? [executable, "--plugin-runtime-worker", WINDOWS_PLUGIN_LAUNCHER_MODE, jobName, ...command]
		: [executable, fileURLToPath(import.meta.url), jobName, ...command];
}

type Target = WorkerHandle<{ exited: Promise<number> }>;
type TargetSpawner = (command: string[]) => Target;

/** Testable launcher core. No target code runs until the current process belongs to the job. */
export async function launchWindowsPluginTarget(
	args: string[],
	native: WindowsPluginJobNative = windowsPluginJobNative(),
	spawn: TargetSpawner = (command) =>
		WorkerHandle.subprocess(command, {
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
			windowsHide: true,
		}),
): Promise<number> {
	const [jobName, ...command] = args;
	if (
		!jobName ||
		!validWindowsPluginJobName(jobName) ||
		!command.length ||
		command.some((part) => !part || part.includes("\0"))
	) {
		throw new Error("Invalid plugin Windows launcher arguments");
	}
	const job = native.open(jobName);
	try {
		native.assignCurrent(job);
	} finally {
		// Host retains the non-inheritable owner handle. Do not pass a job handle to
		// untrusted code or keep an extra handle that could defeat KILL_ON_JOB_CLOSE.
		native.close(job);
	}
	const target = spawn(command);
	const code = await target.exited;
	await target.close();
	return code;
}

export async function runWindowsPluginLauncher(args: string[]): Promise<never> {
	try {
		process.exit(await launchWindowsPluginTarget(args));
	} catch {
		// Neither the job name, command, filesystem paths nor native error body is telemetry.
		console.error("Plugin Windows launcher failed");
		process.exit(1);
	}
}

if (import.meta.main && !isCompiledRuntime()) {
	await runWindowsPluginLauncher(process.argv.slice(2));
}
