/**
 * "Which credential served this session last time", shared by the Codex account pool and the
 * custom API key pool (docs/PROVIDER-SOURCING-DESIGN.md P2 pooling merge).
 *
 * One small, generic store so the two pools stop keeping two slightly different maps. Values
 * are credential ids (or any comparable token); each write refreshes the entry's age, and the
 * store drops expired entries and, past its cap, the oldest ones.
 */
export class SessionAffinity<V> {
	private entries = new Map<string, { value: V; lastUsedAt: number }>();

	constructor(
		private readonly options: {
			maxEntries: number;
			/** Entries older than this are dropped on prune; undefined means no expiry. */
			ttlMs?: number;
		},
	) {}

	/** The credential bound to this session, or undefined when none/expired. */
	get(sessionKey: string, now = Date.now()): V | undefined {
		const entry = this.entries.get(sessionKey);
		if (!entry) return undefined;
		if (this.options.ttlMs !== undefined && now - entry.lastUsedAt > this.options.ttlMs) {
			this.entries.delete(sessionKey);
			return undefined;
		}
		return entry.value;
	}

	set(sessionKey: string, value: V, now = Date.now()): void {
		// Delete first so re-binding also moves the entry to the newest position.
		this.entries.delete(sessionKey);
		this.entries.set(sessionKey, { value, lastUsedAt: now });
		this.prune(now);
	}

	delete(sessionKey: string): void {
		this.entries.delete(sessionKey);
	}

	/** A credential left the pool (deleted, archived): forget every session that used it. */
	evictValue(value: V): void {
		for (const [sessionKey, entry] of this.entries) {
			if (entry.value === value) this.entries.delete(sessionKey);
		}
	}

	prune(now = Date.now()): void {
		const { ttlMs, maxEntries } = this.options;
		if (ttlMs !== undefined) {
			for (const [sessionKey, entry] of this.entries) {
				if (now - entry.lastUsedAt > ttlMs) this.entries.delete(sessionKey);
			}
		}
		if (this.entries.size <= maxEntries) return;
		const sorted = [...this.entries.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
		for (let i = 0; i < this.entries.size - maxEntries; i++) {
			const item = sorted[i];
			if (item) this.entries.delete(item[0]);
		}
	}

	get size(): number {
		return this.entries.size;
	}

	clear(): void {
		this.entries.clear();
	}
}
