/**
 * One credential's allowance, in the shape every quota probe produces
 * (docs/PROVIDER-SOURCING-DESIGN.md §15.4).
 *
 * Generic readers (the key pool, later the quota UI and auto routing) only read `windows`,
 * `balances` and `plan`; a template's own views read its original structure from `detail`.
 */
export type QuotaScope = "key" | "account" | "wallet" | "subscription";

export interface QuotaWindow {
	kind: "5h" | "weekly" | "monthly" | "other";
	/** The upstream's own name for an `other` window. */
	label?: string;
	/** Share of the window already used, 0..1 (1 = used up); null when unknown. */
	usedRatio: number | null;
	/** Epoch ms when the window refills, if known. */
	resetsAt: number | null;
}

export interface QuotaBalance {
	unit: string;
	remaining: number | null;
	total?: number;
	unlimited?: boolean;
}

export interface QuotaSnapshot {
	/** Epoch ms of the last attempt that produced this snapshot; 0 = never fetched. */
	fetchedAt: number;
	/** Last fetch error; the previous numbers may still be shown alongside it. */
	error?: string;
	scope: QuotaScope;
	windows: QuotaWindow[];
	balances: QuotaBalance[];
	/** Plan tier, when the upstream names one. */
	plan?: string;
	/** Template-private original data. */
	detail?: unknown;
}

/** Epoch ms for an upstream timestamp string, or null. */
export function epochOf(value: string | null | undefined): number | null {
	const ms = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(ms) ? ms : null;
}

/** When the latest used-up window refills, if any window is used up and still closed. */
export function quotaExhaustedUntil(
	snapshot: QuotaSnapshot | undefined,
	now: number,
): number | undefined {
	let until: number | undefined;
	for (const window of snapshot?.windows ?? []) {
		if (window.usedRatio === null || window.usedRatio < 1) continue;
		if (window.resetsAt === null || window.resetsAt <= now) continue;
		if (until === undefined || window.resetsAt > until) until = window.resetsAt;
	}
	return until;
}
