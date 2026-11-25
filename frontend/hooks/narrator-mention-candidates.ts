import {
	COMMUNICATION_LIMITS,
	type CommunicationCandidate,
	type CommunicationCandidates,
} from "@shared/narrator-communication";
import { foldHandle } from "@shared/narrator-handle";
import type { PersistedRecentTab } from "@shared/recent-tabs";

/** Flat recent-tab pages include members of collapsed folders; never use visual row order. */
export function localNarratorMentionCandidates(
	tabs: readonly PersistedRecentTab[],
	sourceId: string | undefined,
): CommunicationCandidate[] {
	const byId = new Map<string, CommunicationCandidate>();
	for (const tab of tabs) {
		const id = tab.type === "subagent" ? (tab.narratorId ?? tab.id) : tab.id;
		if ((tab.type !== "narrator" && tab.type !== "subagent") || id === sourceId) continue;
		const activity =
			(tab as PersistedRecentTab & { lastMessageAt?: string; lastActivityAt?: string })
				.lastMessageAt ?? (tab as { lastActivityAt?: string }).lastActivityAt;
		const visited = Number.isFinite(tab.lastVisitedAt) ? tab.lastVisitedAt : 0;
		const time =
			activity && Number.isFinite(Date.parse(activity))
				? activity
				: new Date(visited).toISOString();
		const previous = byId.get(id);
		if (previous && (previous.lastActivityAt ?? "") >= time) continue;
		byId.set(id, {
			id,
			title: tab.title || null,
			status: tab.status ?? "idle",
			lastActivityAt: time,
			isRecent: true,
			canConnect: true,
		});
	}
	return [...byId.values()];
}

export function mergeNarratorMentionCandidates(
	local: readonly CommunicationCandidate[],
	remote: readonly CommunicationCandidate[],
	query: string,
	sourceId?: string,
): CommunicationCandidate[] {
	const byId = new Map(local.map((item) => [item.id, item]));
	for (const item of remote) {
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
				(!folded ||
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
	options: { signal: AbortSignal; limit?: number },
) => Promise<CommunicationCandidates>;

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

	update(ownerId: string | undefined, sourceId: string | undefined, query: string | null): void {
		this.cancel();
		const scope = JSON.stringify([ownerId, sourceId]);
		if (scope !== this.scope) {
			this.cache.clear();
			this.lastStarted = Number.NEGATIVE_INFINITY;
			this.scope = scope;
		}
		const key = JSON.stringify([ownerId, sourceId, query]);
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
