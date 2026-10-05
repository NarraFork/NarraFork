import type { GitWorkspaceState } from "@shared/git-workspace";

/** Filesystem facts only. Authorization is deliberately never retained here. */
export interface GitDiscovery {
	state: GitWorkspaceState;
	rootPath?: string;
	repositoryPath?: string;
	reason?: string;
	branch?: string | null;
}
interface Entry {
	deviceId: string;
	cwd: string;
	value?: GitDiscovery;
	expiresAt: number;
	inflight?: Promise<GitDiscovery>;
}

export class GitDiscoveryCache {
	private entries = new Map<string, Entry>();
	constructor(
		private readonly maxEntries = 128,
		private readonly ttlMs = 30_000,
		private readonly now: () => number = Date.now,
	) {}

	async get(
		deviceId: string,
		runtimeGeneration: number,
		cwd: string,
		load: () => Promise<GitDiscovery>,
		signal?: AbortSignal,
	): Promise<GitDiscovery> {
		signal?.throwIfAborted();
		const key = JSON.stringify([deviceId, runtimeGeneration, cwd]);
		let entry = this.entries.get(key);
		if (entry?.value && entry.expiresAt > this.now()) {
			this.entries.delete(key);
			this.entries.set(key, entry);
			return { ...entry.value };
		}
		if (!entry?.inflight) {
			// In-flight entries are not evicted: their promise deduplicates callers.
			if (!entry && this.entries.size >= this.maxEntries) {
				for (const [oldKey, old] of this.entries) {
					if (!old.inflight) {
						this.entries.delete(oldKey);
						break;
					}
				}
			}
			entry = { deviceId, cwd, expiresAt: 0 };
			if (this.entries.size < this.maxEntries || this.entries.has(key))
				this.entries.set(key, entry);
			const current = entry;
			current.inflight = Promise.resolve()
				.then(load)
				.then((value) => {
					// Errors/offline/permission failures are not negative Git evidence.
					if (value.state === "ready" || value.state === "not_git") {
						current.value = { ...value };
						current.expiresAt = this.now() + this.ttlMs;
					} else if (this.entries.get(key) === current) this.entries.delete(key);
					return value;
				})
				.finally(() => {
					current.inflight = undefined;
					if (!current.value && this.entries.get(key) === current) this.entries.delete(key);
				});
		}
		const pending = entry.inflight as Promise<GitDiscovery>;
		// A cancelled HTTP waiter must not abort another caller's shared probe.
		const value = await new Promise<GitDiscovery>((resolve, reject) => {
			const abort = () => reject(signal?.reason);
			signal?.addEventListener("abort", abort, { once: true });
			pending.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
			if (signal?.aborted) abort();
		});
		signal?.throwIfAborted();
		return { ...value };
	}

	invalidate(
		deviceId: string,
		path: string,
		repositoryPath?: string,
		equals: (a: string, b: string) => boolean = (a, b) => a === b,
	): void {
		for (const [key, entry] of this.entries) {
			if (
				entry.deviceId === deviceId &&
				(entry.inflight ||
					equals(entry.cwd, path) ||
					(entry.value?.rootPath && equals(entry.value.rootPath, path)) ||
					(repositoryPath &&
						entry.value?.repositoryPath &&
						equals(entry.value.repositoryPath, repositoryPath)))
			)
				this.entries.delete(key);
		}
	}

	get size(): number {
		return this.entries.size;
	}
}

export const gitDiscoveryCache = new GitDiscoveryCache();
