export const EDITOR_CACHE_LIMITS = { count: 8, bytes: 64 * 1024 * 1024, idleMs: 5 * 60_000 };

export interface EditorCacheItem {
	/** Includes pinned resident/candidate costs, not just evictable clean text. */
	cost(): { models: number; bytes: number };
	pins(): readonly string[];
	evict(): void;
}

/** Soft estimates, not a total JS heap limit. One deadline for all eligible residents;
 * updates never refresh LRU/TTL. Only actual visible consumption refreshes lastUsed. */
export class EditorModelCache<T extends EditorCacheItem> {
	private entries = new Map<T, number>();
	private reservations = new Set<{ models: number; bytes: number }>();
	/** Transient recovery bodies without a resident working copy still consume admission. */
	reserve(cost: { models: number; bytes: number }) {
		if (
			!Number.isFinite(cost.bytes) ||
			cost.bytes < 0 ||
			!Number.isInteger(cost.models) ||
			cost.models < 0
		)
			throw new Error("Invalid editor reservation");
		const held = { ...cost };
		this.reservations.add(held);
		this.enforce();
		return () => {
			if (this.reservations.delete(held)) this.enforce();
		};
	}
	private timer: ReturnType<typeof setTimeout> | undefined;
	constructor(
		readonly limits = EDITOR_CACHE_LIMITS,
		private now = Date.now,
		private schedule = (callback: () => void, ms: number) => setTimeout(callback, ms),
		private cancel = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
	) {}
	clear() {
		if (this.timer !== undefined) this.cancel(this.timer);
		this.timer = undefined;
		this.entries.clear();
	}
	add(item: T) {
		this.entries.set(item, this.now());
	}
	remove(item: T) {
		this.entries.delete(item);
		this.enforce();
	}
	used(item: T) {
		if (this.entries.has(item)) this.entries.set(item, this.now());
	}
	enforce() {
		if (this.timer !== undefined) this.cancel(this.timer);
		this.timer = undefined;
		let models = 0;
		let bytes = 0;
		for (const held of this.reservations) {
			models += held.models;
			bytes += held.bytes;
		}
		const eligible: [T, number][] = [];
		for (const [item, lastUsed] of this.entries) {
			const cost = item.cost();
			models += cost.models;
			bytes += cost.bytes;
			if (!item.pins().length) eligible.push([item, lastUsed]);
		}
		eligible.sort((a, b) => a[1] - b[1]);
		const now = this.now();
		let deadline: number | undefined;
		for (const [item, lastUsed] of eligible) {
			if (
				models > this.limits.count ||
				bytes > this.limits.bytes ||
				now - lastUsed >= this.limits.idleMs
			) {
				// Recheck synchronously immediately before disposal: no async eviction window.
				if (item.pins().length) continue;
				const cost = item.cost();
				this.entries.delete(item);
				models -= cost.models;
				bytes -= cost.bytes;
				item.evict();
			} else deadline ??= lastUsed + this.limits.idleMs;
		}
		if (deadline !== undefined) {
			this.timer = this.schedule(() => this.enforce(), Math.max(1, deadline - now));
			this.timer.unref?.();
		}
	}
}
