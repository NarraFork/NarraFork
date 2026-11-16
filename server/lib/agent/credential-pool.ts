/** Shared decisions for the Codex account pool and custom-provider key pools. */
export type PoolSelectionMode = "priority" | "balanced" | "tier-balanced";

interface PoolEntry {
	id: string;
	priority: number;
	disabled?: boolean;
	archivedAt?: number;
}

interface SelectionOptions<T> {
	mode?: PoolSelectionMode;
	stickyId?: string;
	exclude?: ReadonlySet<string>;
	tierRank?: (entry: T) => number;
	cooldownUntil?: (entry: T) => number | undefined;
	/** Key pools let the upstream report/wait for the earliest reset; Codex does not. */
	fallbackToCooling?: boolean;
	now: number;
}

/** Returns the original entry, never a copy containing credentials. */
export function selectPoolEntry<T extends PoolEntry>(
	entries: readonly T[],
	options: SelectionOptions<T>,
): T | undefined {
	const candidates = entries
		.filter(
			(entry) =>
				!entry.disabled && !(Number(entry.archivedAt) > 0) && !options.exclude?.has(entry.id),
		)
		.map((entry) => ({ entry, until: options.cooldownUntil?.(entry) }));
	const ready = candidates.filter(({ until }) => !isPoolCooldownActive(until, options.now));
	if (ready.length === 0) {
		if (!options.fallbackToCooling) return undefined;
		return candidates.reduce<(typeof candidates)[number] | undefined>(
			(best, candidate) => (!best || (candidate.until ?? 0) < (best.until ?? 0) ? candidate : best),
			undefined,
		)?.entry;
	}

	const pinned = ready.find(({ entry }) => entry.id === options.stickyId);
	if (pinned) return pinned.entry;
	const mode = options.mode ?? "priority";
	if (mode === "priority") {
		return ready.reduce((best, candidate) =>
			candidate.entry.priority < best.entry.priority ? candidate : best,
		).entry;
	}

	let balanced = ready;
	const tierRank = options.tierRank;
	if (mode === "tier-balanced" && tierRank) {
		const ranked = ready.map((candidate) => ({ ...candidate, rank: tierRank(candidate.entry) }));
		const bestRank = ranked.reduce((best, { rank }) => Math.min(best, rank), Infinity);
		balanced = ranked.filter(({ rank }) => rank === bestRank);
	}
	return balanced[Math.floor(Math.random() * balanced.length)]?.entry;
}

/** An absent deadline is not a cooldown; callers keep permanent disables separate. */
export function isPoolCooldownActive(until: number | undefined, now: number): boolean {
	return until !== undefined && until > now;
}

export type PoolCooldownReason = "rate_limited" | "quota" | "forbidden";
export interface PoolCooldown {
	until: number;
	reason: PoolCooldownReason;
}

export type PoolFault =
	| { kind: "failure" }
	| { kind: "invalid" | "banned" }
	| { kind: "quota"; resetsAt?: number }
	| { kind: "cooldown"; ms: number; reason: PoolCooldownReason };

/** The caller persists permanent state and keeps cooldowns in memory. */
export interface PoolFailureState {
	failureCount: number;
	disabledReason?: "too_many_failures" | "quota_exhausted" | "invalid" | "banned";
	quotaResetsAt?: number;
	cooldown?: PoolCooldown;
}

export function poolFailureState(
	fault: PoolFault,
	failureCount: number,
	failureLimit: number,
	now: number,
): PoolFailureState {
	switch (fault.kind) {
		case "failure": {
			const count = failureCount + 1;
			return {
				failureCount: count,
				...(count >= failureLimit ? { disabledReason: "too_many_failures" as const } : {}),
			};
		}
		case "invalid":
		case "banned":
			return { failureCount: failureLimit, disabledReason: fault.kind };
		case "quota":
			return {
				failureCount: failureLimit,
				disabledReason: "quota_exhausted",
				quotaResetsAt: fault.resetsAt,
			};
		case "cooldown":
			return {
				failureCount,
				cooldown: { until: now + fault.ms, reason: fault.reason },
			};
	}
}
