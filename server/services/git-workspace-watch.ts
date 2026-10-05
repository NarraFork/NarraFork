import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { GitWorkspaceCategory } from "@shared/git-workspace-events";
import { logger } from "../lib/logger";
import { safeSpawn } from "../lib/spawn";
import { gitDiscoveryCache } from "./git-discovery-cache";
import type { GitWorkspaceTarget } from "./git-workspace";

export const WATCH_INTERVAL_MS = 3000;
export const WATCH_MAX_BYTES = 128 * 1024;
const CATEGORIES: GitWorkspaceCategory[] = ["worktree", "index", "refs", "head", "stash"];
export interface WatchSample {
	fingerprints: Partial<Record<GitWorkspaceCategory, string>>;
	uncertain: GitWorkspaceCategory[];
}

export function changedGitCategories(
	previous: WatchSample | undefined,
	sample: WatchSample,
): GitWorkspaceCategory[] {
	return CATEGORIES.filter(
		(category) =>
			sample.uncertain.includes(category) ||
			(previous === undefined
				? sample.fingerprints[category] !== undefined
				: sample.fingerprints[category] !== previous.fingerprints[category]),
	);
}

function fingerprint(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export async function probeGitWatch(
	target: GitWorkspaceTarget,
	signal: AbortSignal,
): Promise<WatchSample> {
	signal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
	const { backend, workspace } = target;
	const root = workspace.rootPath;
	if (!backend || !root) throw new Error("Workspace unavailable");
	const fingerprints: WatchSample["fingerprints"] = {};
	const uncertain = new Set<GitWorkspaceCategory>();
	if (backend.kind === "remote") {
		if (!backend.gitWorkspace) throw new Error("Git workspace RPC unavailable");
		if (backend.supportsGitWorkspaceWatch) {
			const sample = await backend.gitWorkspace(
				{
					cwd: root,
					expectedRoot: root,
					operation: "watch",
					maxBytes: WATCH_MAX_BYTES,
					timeoutMs: 5000,
				},
				signal,
			);
			const outputs = sample.outputs ?? {};
			for (const category of ["worktree", "index", "head", "stash"] as const) {
				if (typeof outputs[category] !== "string")
					throw new Error("Incomplete Git watch fingerprint");
				fingerprints[category] = outputs[category];
			}
			if (sample.truncated) {
				// Metadata budgets never invalidate the independently bounded HEAD identity.
				uncertain.add("worktree");
				uncertain.add("index");
				uncertain.add("stash");
			}
			if (outputs.uncertainWorktree === "true") uncertain.add("worktree");
			return { fingerprints, uncertain: [...uncertain] };
		}
		const status = await backend.gitWorkspace(
			{
				cwd: root,
				expectedRoot: root,
				operation: "status",
				maxBytes: WATCH_MAX_BYTES,
				timeoutMs: 5000,
			},
			signal,
		);
		if (status.state && status.state !== "ready") throw new Error("Git watch unavailable");
		const outputs = status.outputs ?? {};
		if (outputs.head === undefined || outputs.branch === undefined || outputs.status === undefined)
			throw new Error("Incomplete remote Git watch status");
		fingerprints.head = fingerprint(`${outputs.head}\0${outputs.branch}`);
		fingerprints.index = fingerprint(outputs.stagedNumstat ?? "");
		// v1 exposes HEAD/branch, not unrelated refs. Never turn this limitation
		// into periodic log invalidations. Bounded patches detect equal-line edits.
		let patch = "";
		if (outputs.status || status.truncated) {
			const diff = await backend.gitWorkspace(
				{
					cwd: root,
					expectedRoot: root,
					operation: "fullDiff",
					maxBytes: WATCH_MAX_BYTES,
					timeoutMs: 5000,
				},
				signal,
			);
			patch = diff.stdout ?? "";
			if (diff.truncated || /Binary files .* differ|Subproject commit/.test(patch))
				uncertain.add("worktree");
		}
		fingerprints.worktree = fingerprint(`${outputs.status}\0${patch}`);
		if (status.truncated) uncertain.add("worktree");
		const stash = await backend.gitWorkspace(
			{
				cwd: root,
				expectedRoot: root,
				operation: "stashList",
				maxBytes: WATCH_MAX_BYTES,
				timeoutMs: 5000,
				limit: 100,
			},
			signal,
		);
		fingerprints.stash = fingerprint(stash.stdout ?? "");
		// Comparing the bounded prefix never makes the log refresh periodically.
		if (stash.truncated) uncertain.add("stash");
	} else {
		const run = async (args: string[], category: GitWorkspaceCategory) => {
			const result = await safeSpawn({
				cmd: ["git", "--no-optional-locks", "-C", root, ...args],
				timeout: 5000,
				maxOutputBytes: WATCH_MAX_BYTES,
				signal,
			});
			if (result.stdoutTruncated || result.stderrTruncated) uncertain.add(category);
			if (result.exitCode !== 0 && !(args[0] === "rev-parse" && result.exitCode === 1))
				throw new Error("Git watch probe failed");
			return result.stdout;
		};
		const status = await run(
			["status", "--porcelain=v1", "-z", "--untracked-files=all", "--branch"],
			"worktree",
		);
		// The panel's log is HEAD-only (no --all or ref decorations). Enumerating
		// all refs is both unnecessary and makes large ref sets perpetually truncated.
		fingerprints.refs = fingerprint(
			await run(["rev-parse", "--verify", "--quiet", "HEAD"], "refs"),
		);
		fingerprints.stash = fingerprint(await run(["stash", "list", "--format=%gd:%H"], "stash"));
		fingerprints.index = fingerprint(
			await run(
				["diff", "--cached", "--raw", "--no-abbrev", "--no-ext-diff", "--no-textconv"],
				"index",
			),
		);
		const records = status.split("\0");
		fingerprints.head = fingerprint(records[0]?.startsWith("##") ? records[0] : "");
		const hash = createHash("sha256");
		let scanned = 0;
		for (let i = 0; i < records.length; i++) {
			const record = records[i];
			if (!record || record.startsWith("##")) continue;
			hash.update(record);
			if (++scanned > 2000) {
				uncertain.add("worktree");
				break;
			}
			signal.throwIfAborted();
			const path = record.slice(3);
			const metadata = await lstat(resolve(root, path), { bigint: true }).catch(() => null);
			if (metadata?.isDirectory()) uncertain.add("worktree");
			hash.update(
				metadata
					? `${path}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}:${metadata.ino}`
					: `${path}:missing`,
			);
			if (/[RC]/.test(record.slice(0, 2))) hash.update(records[++i] ?? "");
		}
		fingerprints.worktree = hash.digest("hex");
	}
	return { fingerprints, uncertain: [...uncertain] };
}

interface Listener {
	changed(categories: GitWorkspaceCategory[]): void;
}
interface Entry {
	target: GitWorkspaceTarget;
	listeners: Set<Listener>;
	controller: AbortController;
	timer?: ReturnType<typeof setTimeout>;
	previous?: WatchSample;
	failures: number;
	running: boolean;
}
/** One non-overlapping job per device/worktree. Timers exist only while panels subscribe. */
export class GitWorkspaceWatchPool {
	private entries = new Map<string, Entry>();
	private active = 0;
	constructor(
		private probe = probeGitWatch,
		private interval = WATCH_INTERVAL_MS,
	) {}
	subscribe(target: GitWorkspaceTarget, changed: Listener["changed"]): () => void {
		const key = `${target.workspace.deviceId}:${target.workspace.workspaceKey}`;
		let entry = this.entries.get(key);
		if (!entry) {
			if (this.entries.size >= 128) throw new Error("Git watch capacity reached");
			entry = {
				target,
				listeners: new Set(),
				controller: new AbortController(),
				failures: 0,
				running: false,
			};
			this.entries.set(key, entry);
		} else if (
			(target.backend?.runtimeGeneration ?? 0) > (entry.target.backend?.runtimeGeneration ?? 0)
		) {
			// Device generations increase monotonically. Upgrade the shared slot in
			// place, even at capacity; a late old subscriber must not roll it back.
			entry.target = target;
			entry.previous = undefined;
			entry.failures = 0;
			entry.controller.abort();
			entry.controller = new AbortController();
			clearTimeout(entry.timer);
			entry.timer = undefined;
			// An aborted probe may still be unwinding. Its tick schedules the new
			// generation only after it settles, keeping one probe per workspace.
		}
		const listener = { changed };
		entry.listeners.add(listener);
		if (!entry.timer && !entry.running) void this.tick(entry);
		return () => {
			entry.listeners.delete(listener);
			if (entry.listeners.size) return;
			entry.controller.abort();
			clearTimeout(entry.timer);
			if (this.entries.get(key) === entry) this.entries.delete(key);
		};
	}
	private async tick(entry: Entry): Promise<void> {
		if (entry.controller.signal.aborted || entry.running) return;
		entry.running = true;
		const { controller, target } = entry;
		if (this.active < 4) {
			this.active++;
			const started = performance.now();
			try {
				const sample = await this.probe(target, controller.signal);
				if (!controller.signal.aborted) {
					const categories = changedGitCategories(entry.previous, sample);
					if (categories.includes("head") || categories.includes("refs"))
						gitDiscoveryCache.invalidate(
							target.workspace.deviceId,
							target.workspace.rootPath ?? target.workspace.cwd,
							target.repositoryPath,
							target.backend?.paths.equals,
						);
					entry.failures = 0;
					entry.previous = sample;
					for (const listener of entry.listeners) listener.changed(categories);
				}
			} catch {
				// Failure is not evidence that history changed. Check authorization,
				// then retry with backoff without forcing a browser request storm.
				if (!controller.signal.aborted) {
					entry.failures = Math.min(entry.failures + 1, 4);
					for (const listener of entry.listeners) listener.changed([]);
				}
			} finally {
				this.active--;
				if (performance.now() - started > 5000)
					logger.warn("Slow Git workspace watch probe", {
						workspaceKey: target.workspace.workspaceKey,
						deviceId: target.workspace.deviceId,
						elapsedMs: Math.round(performance.now() - started),
					});
			}
		}
		entry.running = false;
		if (!entry.controller.signal.aborted) {
			// Old executors cannot produce a cheap watch digest; do not drive their
			// per-file diff implementation at the lightweight monitor's cadence.
			const legacyRemote =
				entry.target.backend?.kind === "remote" && !entry.target.backend.supportsGitWorkspaceWatch;
			const interval = legacyRemote ? Math.max(30_000, this.interval) : this.interval;
			entry.timer = setTimeout(
				() => void this.tick(entry),
				controller !== entry.controller ? 0 : Math.min(60_000, interval * 2 ** entry.failures),
			);
			entry.timer.unref?.();
		}
	}
}
