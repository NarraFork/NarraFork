import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { type SafeSpawnOptions, type SafeSpawnResult, safeSpawn } from "../lib/spawn";

export type SocketLiveness = "alive" | "dead" | "unknown";
export const DTACH_SNAPSHOT_TIMEOUT_MS = 2_000;
export const DTACH_SNAPSHOT_MAX_BYTES = 1024 * 1024;

export interface DtachRecoveryProbe {
	check(socketPath: string): Promise<SocketLiveness>;
	stats: {
		processProbes: number;
		processProbeMs: number;
		snapshotComplete: boolean;
		snapshotFailure: string | null;
		socketChecks: number;
	};
}

/** Only NarraFork's daemon form (-n PATH -z SHELL ...) proves ownership.
 * ps args are not shell-quoted: do not tokenize paths on spaces or interpret them as regexes.
 * An unrecognized dtach command makes negative results unknown, never proof of death.
 */
function parseSnapshot(stdout: string): { paths: Set<string>; complete: boolean } {
	const paths = new Set<string>();
	let complete = true;
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const process = line.trim().match(/^\d+\s+(\S+)\s+(.+)$/);
		if (!process) {
			complete = false;
			continue;
		}
		if (basename(process[1]) !== "dtach") continue;
		const args = process[2];
		// Attach clients alone do not establish that a daemon is alive.
		if (/^\S+\s+-a\s/.test(args)) continue;
		const daemon = args.match(/^\S+\s+-n\s+(.+)$/);
		if (!daemon) {
			complete = false;
			continue;
		}
		const delimiters = [...daemon[1].matchAll(/\s+-z(?:\s|$)/g)];
		if (delimiters.length !== 1) {
			complete = false;
			continue;
		}
		paths.add(daemon[1].slice(0, delimiters[0].index));
	}
	return { paths, complete };
}

/** One bounded process scan per recovery run, shared by both phases.
 * Failed/truncated scans are deliberately not used, including their positive prefix.
 * Unknown sessions stay detached/running for a later explicit retry; no N-process fallback storm.
 */
export async function createDtachRecoveryProbe(
	spawn: (opts: SafeSpawnOptions) => Promise<SafeSpawnResult> = safeSpawn,
	isSocket: (path: string) => Promise<SocketLiveness> = async (path) => {
		try {
			return (await stat(path)).isSocket() ? "alive" : "dead";
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			return code === "ENOENT" || code === "ENOTDIR" ? "dead" : "unknown";
		}
	},
): Promise<DtachRecoveryProbe> {
	const started = performance.now();
	let paths = new Set<string>();
	let complete = false;
	let failure: string | null = null;
	try {
		const result = await spawn({
			cmd: ["ps", "-axww", "-o", "pid=,comm=,args="],
			timeout: DTACH_SNAPSHOT_TIMEOUT_MS,
			maxOutputBytes: DTACH_SNAPSHOT_MAX_BYTES,
			maxStderrBytes: 4096,
		});
		if (result.terminationReason || result.exitCode !== 0 || result.stdoutTruncated) {
			failure = result.terminationReason ?? (result.stdoutTruncated ? "truncated" : "exit-code");
		} else if (!result.stdout.trim()) {
			failure = "empty";
		} else {
			({ paths, complete } = parseSnapshot(result.stdout));
			if (!complete) failure = "unrecognized-process";
		}
	} catch {
		failure = "spawn-failed";
	}
	const stats = {
		processProbes: 1,
		processProbeMs: Math.round(performance.now() - started),
		snapshotComplete: complete,
		snapshotFailure: failure,
		socketChecks: 0,
	};
	return {
		stats,
		async check(socketPath) {
			stats.socketChecks++;
			const socket = await isSocket(socketPath);
			if (socket !== "alive") return socket;
			if (paths.has(socketPath)) return "alive";
			return complete ? "dead" : "unknown";
		},
	};
}
