/**
 * Windows TCP excluded port ranges.
 *
 * Windows reserves blocks of TCP ports for Hyper-V / WSL / WinNAT / docker and
 * similar components. A reserved port has NO listening process: `netstat -ano`
 * shows nothing, yet `bind()` fails with EADDRINUSE. The reserved blocks are
 * (re)chosen dynamically at boot, so a port that worked yesterday can be dead
 * today — which is exactly how NarraFork's default 7778 lands inside a
 * `7681-7780` block after a reboot.
 *
 * Reading the ranges up front lets the server skip an entire reserved block
 * instead of blindly probing consecutive ports (the blocks are typically 100
 * ports wide, so probing 7778..7788 can never escape one).
 *
 * Source of truth: `netsh interface ipv4 show excludedportrange protocol=tcp`.
 */

import { logger } from "./logger";
import { IS_WINDOWS } from "./platform";

export const MAX_TCP_PORT = 65535;

export interface PortRange {
	/** First reserved port, inclusive. */
	start: number;
	/** Last reserved port, inclusive. */
	end: number;
}

/**
 * Parse `netsh interface ipv4 show excludedportrange protocol=tcp` output.
 *
 * Deliberately locale-agnostic: the table header and the trailing legend are
 * localised (Chinese Windows prints 开始端口/结束端口 and `* - 管理的端口排除。`),
 * so parsing keys off the numeric shape of the row rather than any label. A row
 * looks like:
 *
 *   ```
 *      7681        7780
 *     50000       50059     *
 *   ```
 *
 * The optional trailing `*` marks an administered exclusion and is ignored: an
 * administered range blocks bind() exactly like a dynamic one.
 */
export function parseExcludedPortRanges(output: string): PortRange[] {
	const ranges: PortRange[] = [];
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		// Two integers, optionally followed by the administered-exclusion marker.
		const match = /^(\d{1,5})\s+(\d{1,5})(?:\s+\*)?$/.exec(line);
		if (!match) continue;
		const start = Number(match[1]);
		const end = Number(match[2]);
		if (!isValidPort(start) || !isValidPort(end) || end < start) continue;
		ranges.push({ start, end });
	}
	return mergeRanges(ranges);
}

function isValidPort(port: number): boolean {
	return Number.isInteger(port) && port >= 1 && port <= MAX_TCP_PORT;
}

/**
 * Merge overlapping/adjacent ranges so a run of consecutive blocks (the
 * `7681-7780` + `7781-7880` pair in the field report) is treated as one region
 * and skipped in a single jump.
 */
function mergeRanges(ranges: PortRange[]): PortRange[] {
	if (ranges.length === 0) return [];
	const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: PortRange[] = [{ ...sorted[0] }];
	for (const range of sorted.slice(1)) {
		const last = merged[merged.length - 1];
		// `start <= last.end + 1` also merges adjacent blocks, not just overlaps.
		if (range.start <= last.end + 1) {
			last.end = Math.max(last.end, range.end);
		} else {
			merged.push({ ...range });
		}
	}
	return merged;
}

/** Return the range containing `port`, or undefined when the port is free to try. */
export function findExcludingRange(port: number, ranges: PortRange[]): PortRange | undefined {
	return ranges.find((range) => port >= range.start && port <= range.end);
}

/** Whether `port` falls inside any reserved range. */
export function isPortExcluded(port: number, ranges: PortRange[]): boolean {
	return findExcludingRange(port, ranges) !== undefined;
}

/**
 * Return the first port >= `port` that is not reserved.
 *
 * Jumps past the whole containing block (and any adjacent block, thanks to
 * merging) instead of stepping one port at a time. Returns null when the jump
 * would run past the end of the TCP port space.
 */
export function nextAllowedPort(port: number, ranges: PortRange[]): number | null {
	let candidate = port;
	// Merged ranges are disjoint and non-adjacent, so at most one jump per range.
	for (let guard = 0; guard <= ranges.length; guard++) {
		if (candidate > MAX_TCP_PORT) return null;
		const range = findExcludingRange(candidate, ranges);
		if (!range) return candidate;
		candidate = range.end + 1;
	}
	return candidate > MAX_TCP_PORT ? null : candidate;
}

/** Human-readable range list for log lines and console diagnostics. */
export function formatPortRanges(ranges: PortRange[]): string {
	return ranges.map((range) => `${range.start}-${range.end}`).join(", ");
}

export const NETSH_EXCLUDED_PORT_COMMAND =
	"netsh interface ipv4 show excludedportrange protocol=tcp";

/** Injectable command runner so tests never shell out or depend on the host OS. */
export type ExcludedPortReader = () => string | null;

/**
 * Wall-clock ceiling for the `netsh` call.
 *
 * This runs SYNCHRONOUSLY on the startup path, so without a timeout a wedged
 * Windows firewall/network service does not merely delay port selection — it
 * hangs server startup with no recovery. `netsh` answers in milliseconds when
 * healthy; 5s matches the ceiling `dependency-service` already uses for its own
 * probes. A timeout kills the child and leaves `exitCode` non-zero, which the
 * caller already treats as "unknown" and fails open on.
 */
const NETSH_TIMEOUT_MS = 5_000;

/**
 * Retained-output ceiling.
 *
 * Real output is a few KB. Applied by slicing the decoded text rather than via
 * `spawnSync`'s `maxBuffer`, which is not honored by the Bun version in use
 * (verified: a 1 KB `maxBuffer` still returned 100 KB). Truncation is safe for
 * the parser — it reads whole lines and skips anything malformed — and the point
 * is only to keep a pathological writer from being retained in full.
 */
const NETSH_MAX_OUTPUT_CHARS = 64 * 1024;

function runNetsh(): string | null {
	try {
		const result = Bun.spawnSync(
			["netsh", "interface", "ipv4", "show", "excludedportrange", "protocol=tcp"],
			{ stdout: "pipe", stderr: "ignore", timeout: NETSH_TIMEOUT_MS },
		);
		// Also covers the timeout case: a killed child reports a null exit code.
		if (result.exitCode !== 0) return null;
		return new TextDecoder().decode(result.stdout).slice(0, NETSH_MAX_OUTPUT_CHARS);
	} catch {
		// netsh missing or not permitted — treated as "unknown", never fatal.
		return null;
	}
}

/**
 * Read the reserved TCP ranges on Windows.
 *
 * Fail-open by design: a missing/failing/unparsable `netsh` yields an empty list
 * so port selection falls back to plain bind attempts. Non-Windows platforms
 * have no such concept and short-circuit without spawning anything.
 */
export function readWindowsExcludedPortRanges(read: ExcludedPortReader = runNetsh): PortRange[] {
	if (!IS_WINDOWS) return [];
	const output = read();
	if (!output) {
		logger.debug("Could not read Windows excluded TCP port ranges", {
			command: NETSH_EXCLUDED_PORT_COMMAND,
		});
		return [];
	}
	const ranges = parseExcludedPortRanges(output);
	if (ranges.length > 0) {
		logger.info("Windows reserved TCP port ranges detected", {
			ranges: formatPortRanges(ranges),
		});
	}
	return ranges;
}
