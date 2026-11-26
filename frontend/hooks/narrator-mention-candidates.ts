import {
	COMMUNICATION_LIMITS,
	type CommunicationCandidate,
	type CommunicationCandidates,
} from "@shared/narrator-communication";
import { foldHandle } from "@shared/narrator-handle";
import type { PersistedRecentTab } from "@shared/recent-tabs";
import type { CommunicationCandidatePurpose } from "../lib/api/narrator-communication";
import { recentTabLiveNarratorId } from "./recent-tabs-utils";

// A loaded recent tab proves visibility, not write eligibility for this source. A missing
// candidate in the bounded search page must stay unknown, not become false (or true).
export type NarratorMentionCandidate = Omit<CommunicationCandidate, "canConnect"> & {
	canConnect?: boolean;
};

/** Flat recent-tab pages include members of collapsed folders; never use visual row order. */
export function localNarratorMentionCandidates(
	tabs: readonly PersistedRecentTab[],
	sourceId: string | undefined,
): NarratorMentionCandidate[] {
	const byId = new Map<string, { item: NarratorMentionCandidate; fromTeam: boolean }>();
	for (const tab of tabs) {
		const id = recentTabLiveNarratorId(tab);
		if (!id || id === sourceId) continue;
		const activity =
			(tab as PersistedRecentTab & { lastMessageAt?: string; lastActivityAt?: string })
				.lastMessageAt ?? (tab as { lastActivityAt?: string }).lastActivityAt;
		const visited = Number.isFinite(tab.lastVisitedAt) ? tab.lastVisitedAt : 0;
		const time =
			activity && Number.isFinite(Date.parse(activity))
				? activity
				: new Date(visited).toISOString();
		const previous = byId.get(id);
		const previousTime = previous?.item.lastActivityAt ?? "";
		const fromTeam = tab.type === "team";
		// If both tabs exist, prefer the coordinator's session title/status (including local
		// renames), but keep the newer activity of either tab for ordering.
		if (previous && (fromTeam !== previous.fromTeam ? fromTeam : previousTime >= time)) {
			if (time > previousTime) previous.item.lastActivityAt = time;
			continue;
		}
		byId.set(id, {
			fromTeam,
			item: {
				id,
				title: tab.title || null,
				status: tab.status ?? "idle",
				lastActivityAt: previousTime > time ? previousTime : time,
				isRecent: true,
			},
		});
	}
	return [...byId.values()].map(({ item }) => item);
}

export function mergeNarratorMentionCandidates(
	local: readonly NarratorMentionCandidate[],
	remote: readonly CommunicationCandidate[],
	query: string,
	sourceId?: string,
): NarratorMentionCandidate[] {
	const byId = new Map(local.map((item) => [item.id, item]));
	const remoteMatches = new Set<string>();
	for (const item of remote) {
		remoteMatches.add(item.id);
		const previous = byId.get(item.id);
		byId.set(item.id, {
			...item,
			title: previous ? previous.title : item.title,
			status: previous ? previous.status : item.status,
			lastActivityAt: item.lastActivityAt ?? previous?.lastActivityAt ?? null,
			isRecent: item.isRecent || previous?.isRecent === true,
		});
	}
	const folded = foldHandle(query);
	return [...byId.values()]
		.filter(
			(item) =>
				item.id !== sourceId &&
				// The server matched and authorized this page already, possibly using a
				// field we don't show (or a newer title than the loaded sidebar row).
				(!folded ||
					remoteMatches.has(item.id) ||
					foldHandle(
						`${item.title ?? ""} ${item.handle ?? ""} ${item.parentTitle ?? ""} ${item.id}`,
					).includes(folded)),
		)
		.sort(
			(a, b) =>
				Number(b.isRecent) - Number(a.isRecent) ||
				(Date.parse(b.lastActivityAt ?? "") || 0) - (Date.parse(a.lastActivityAt ?? "") || 0) ||
				a.id.localeCompare(b.id),
		)
		.slice(0, COMMUNICATION_LIMITS.searchMaxLimit);
}

export interface MentionSearchState {
	key: string;
	items: CommunicationCandidate[];
	loading: boolean;
	error: boolean;
	hasMore: boolean;
}

type Search = (
	sourceId: string,
	query: string,
	options: { signal: AbortSignal; limit?: number; purpose?: CommunicationCandidatePurpose },
) => Promise<CommunicationCandidates>;

export function narratorMentionSearchKey(
	ownerId: string | undefined,
	sourceId: string | undefined,
	query: string | null,
	purpose?: CommunicationCandidatePurpose,
): string {
	return JSON.stringify([ownerId, sourceId, purpose, query]);
}

/** Leading + latest trailing throttle. Cancellation invalidates immediately, before the next window. */
export class NarratorMentionSearch {
	private generation = 0;
	private controller?: AbortController;
	private timer?: ReturnType<typeof setTimeout>;
	private lastStarted = Number.NEGATIVE_INFINITY;
	private scope = "";
	private key = "";
	private cache = new Map<string, { at: number; value: CommunicationCandidates }>();
	constructor(
		private search: Search,
		private emit: (value: MentionSearchState) => void,
	) {}

	update(
		ownerId: string | undefined,
		sourceId: string | undefined,
		query: string | null,
		purpose?: CommunicationCandidatePurpose,
	): void {
		this.cancel();
		const scope = narratorMentionSearchKey(ownerId, sourceId, null, purpose);
		if (scope !== this.scope) {
			this.cache.clear();
			this.lastStarted = Number.NEGATIVE_INFINITY;
			this.scope = scope;
		}
		const key = narratorMentionSearchKey(ownerId, sourceId, query, purpose);
		this.key = key;
		if (!ownerId || !sourceId || query === null) {
			this.emit({ key, items: [], loading: false, error: false, hasMore: false });
			return;
		}
		const cached = this.cache.get(key);
		if (cached && Date.now() - cached.at < 15_000) {
			this.emit({ key, ...cached.value, loading: false, error: false });
			return;
		}
		this.emit({ key, items: [], loading: true, error: false, hasMore: false });
		const generation = this.generation;
		const run = () => {
			this.timer = undefined;
			if (generation !== this.generation) return;
			this.lastStarted = Date.now();
			const controller = new AbortController();
			this.controller = controller;
			const timeout = setTimeout(() => controller.abort(), COMMUNICATION_LIMITS.searchTimeoutMs);
			void this.search(sourceId, query.slice(0, COMMUNICATION_LIMITS.searchQueryChars), {
				signal: controller.signal,
				limit: COMMUNICATION_LIMITS.searchMaxLimit,
				...(purpose !== undefined && { purpose }),
			})
				.then((result) => {
					if (generation !== this.generation || controller.signal.aborted) return;
					this.cache.set(key, { at: Date.now(), value: result });
					if (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value as string);
					this.emit({ key, ...result, loading: false, error: false });
				})
				.catch(() => {
					if (generation === this.generation)
						this.emit({ key, items: [], loading: false, error: true, hasMore: false });
				})
				.finally(() => {
					clearTimeout(timeout);
					if (this.controller === controller) this.controller = undefined;
				});
		};
		const wait = Math.max(
			0,
			COMMUNICATION_LIMITS.searchThrottleMs - (Date.now() - this.lastStarted),
		);
		if (wait) this.timer = setTimeout(run, wait);
		else run();
	}

	cancel(): void {
		++this.generation;
		this.controller?.abort();
		this.controller = undefined;
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	invalidate(): void {
		this.cancel();
		this.cache.clear();
		this.emit({ key: this.key, items: [], loading: false, error: false, hasMore: false });
	}
}
