import type { PersistedRecentTab, RecentTabRuntimePatch } from "@shared/recent-tabs";
import { RECENT_TABS_LIVE_LIMIT } from "@shared/recent-tabs";

export interface RecentTabViewer {
	userId: string;
	username: string;
	avatarColor: string | null;
	avatarImageId: string | null;
}

export interface RecentTab extends PersistedRecentTab {
	/** Runtime narrator substatus tags. */
	substatus?: string[];
	// Runtime-enriched fields (not persisted to DB)
	activeTerminalCount?: number;
	viewers?: RecentTabViewer[];
	viewerCount?: number;
	containerStatus?: "created" | "running" | "paused" | "stopped" | null;
	/** Runtime-enriched marker: this narrator has unsent draft text. */
	hasDraft?: boolean;
	/** Persisted marker (see `PersistedRecentTab`): this narrator was spawned by a scheduled task. */
	isScheduled?: boolean;
}

export const RECENT_TAB_TEXT_MAX_CHARS = 1_000;
const RECENT_TAB_VIEWERS_MAX = 20;

export function clampRecentTabText(value: string | null | undefined): string | undefined {
	if (value == null) return undefined;
	if (!value) return value;
	return value.length > RECENT_TAB_TEXT_MAX_CHARS
		? value.slice(0, RECENT_TAB_TEXT_MAX_CHARS)
		: value;
}

export function normalizeRecentTabViewers(viewers: RecentTabViewer[] | undefined): {
	viewers: RecentTabViewer[] | undefined;
	viewerCount: number | undefined;
} {
	if (!viewers) return { viewers, viewerCount: undefined };
	// Reuse the input array when nothing needed clamping, so repeated normalization keeps
	// object identity and memoized tab rows are not invalidated on every cache write.
	let changed = viewers.length > RECENT_TAB_VIEWERS_MAX;
	const normalized = viewers.slice(0, RECENT_TAB_VIEWERS_MAX).map((viewer) => {
		const username = clampRecentTabText(viewer.username) ?? "";
		if (username === viewer.username) return viewer;
		changed = true;
		return { ...viewer, username };
	});
	return {
		viewers: changed ? normalized : viewers,
		viewerCount: viewers.length,
	};
}

export function normalizeRecentTab(tab: RecentTab): RecentTab {
	const title = clampRecentTabText(tab.title) ?? "";
	const subtitle = clampRecentTabText(tab.subtitle);
	const normalizedViewers = normalizeRecentTabViewers(tab.viewers);
	if (
		title === tab.title &&
		subtitle === tab.subtitle &&
		normalizedViewers.viewers === tab.viewers &&
		normalizedViewers.viewerCount === tab.viewerCount
	) {
		return tab;
	}
	return {
		...tab,
		title,
		subtitle,
		viewers: normalizedViewers.viewers,
		viewerCount: normalizedViewers.viewerCount,
	};
}

/**
 * Fields that only ever come from the runtime endpoint or narrator WS events.
 * `status` is stored on the persisted row too, but the live value is always fresher.
 */
const RECENT_TAB_RUNTIME_KEYS = [
	"status",
	"substatus",
	"activeTerminalCount",
	"viewers",
	"viewerCount",
	"containerStatus",
	"hasDraft",
] as const satisfies ReadonlyArray<keyof RecentTab>;

function asFields(tab: RecentTab): Record<string, unknown> {
	return tab as unknown as Record<string, unknown>;
}

/** Shallow field comparison; array fields must already share identity to count as equal. */
export function isSameRecentTab(left: RecentTab, right: RecentTab): boolean {
	if (left === right) return true;
	const leftFields = asFields(left);
	const rightFields = asFields(right);
	const keys = new Set([...Object.keys(leftFields), ...Object.keys(rightFields)]);
	for (const key of keys) {
		if (leftFields[key] !== rightFields[key]) return false;
	}
	return true;
}

function sameSubstatus(left: string[] | undefined, right: string[] | undefined): boolean {
	if (left === right) return true;
	if (!left || !right || left.length !== right.length) return false;
	return left.every((value, index) => value === right[index]);
}

function sameViewers(
	left: RecentTabViewer[] | undefined,
	right: RecentTabViewer[] | undefined,
): boolean {
	if (left === right) return true;
	if (!left || !right || left.length !== right.length) return false;
	return left.every((viewer, index) => {
		const other = right[index];
		return (
			viewer === other ||
			(viewer.userId === other.userId &&
				viewer.username === other.username &&
				viewer.avatarColor === other.avatarColor &&
				viewer.avatarImageId === other.avatarImageId)
		);
	});
}

/**
 * Apply a runtime patch while preserving object identity for unchanged rows.
 *
 * Runtime polls re-send freshly allocated `substatus`/`viewers` arrays with identical
 * contents, so a naive spread would produce a new tab object on every tick and force
 * every memoized row (and its icons) to re-render.
 */
export function mergeRecentTabPatch(tab: RecentTab, patch: Record<string, unknown>): RecentTab {
	const next = normalizeRecentTab({ ...tab, ...patch } as RecentTab);
	if (next === tab) return tab;
	const reconciled: RecentTab = { ...next };
	if (sameSubstatus(tab.substatus, next.substatus)) reconciled.substatus = tab.substatus;
	if (sameViewers(tab.viewers, next.viewers)) reconciled.viewers = tab.viewers;
	return isSameRecentTab(tab, reconciled) ? tab : reconciled;
}

/**
 * Carry live runtime fields from the currently rendered tab onto an authoritative
 * persisted tab, so revisiting a tab (or refetching a page) never blanks its status
 * colour, terminal count, viewers or container badge.
 *
 * Returns `previous` itself when nothing changed, so memoized rows keep their identity
 * instead of remounting their icons.
 */
export function mergeRecentTabRuntime(tab: PersistedRecentTab, previous?: RecentTab): RecentTab {
	const normalized = normalizeRecentTab(tab as RecentTab);
	if (!previous) return normalized;
	const merged: RecentTab = { ...normalized };
	const mergedFields = asFields(merged);
	for (const key of RECENT_TAB_RUNTIME_KEYS) {
		const value = previous[key];
		if (value !== undefined) mergedFields[key] = value;
	}
	return isSameRecentTab(merged, previous) ? previous : merged;
}

function recentTabNarratorId(tab: RecentTab): string | null {
	if (tab.type === "narrator" || tab.type === "subagent") return tab.id;
	if (tab.type === "chapter") return tab.narratorId ?? null;
	return null;
}

export function shouldApplyRecentTabsRuntimeResponse(
	requestGeneration: number,
	currentGeneration: number,
): boolean {
	return requestGeneration === currentGeneration;
}

/**
 * Per-narrator, per-field counters of runtime updates delivered over the narrator WS.
 *
 * The runtime endpoint is a full snapshot of every runtime field, so a response that
 * left the server before a WS event landed would otherwise roll the tab back to the
 * pre-event value (a stale status colour / filled icon until the next poll).
 */
export type RecentTabRuntimeVersions = Map<string, Map<string, number>>;
export type ReadonlyRecentTabRuntimeVersions = ReadonlyMap<string, ReadonlyMap<string, number>>;

/** Record that a WS event just delivered newer values for these runtime fields. */
export function bumpRecentTabRuntimeVersions(
	versions: RecentTabRuntimeVersions,
	narratorId: string,
	fields: Iterable<string>,
): void {
	let byField = versions.get(narratorId);
	if (!byField) {
		byField = new Map();
		versions.set(narratorId, byField);
	}
	for (const field of fields) byField.set(field, (byField.get(field) ?? 0) + 1);
}

/** Freeze the counters a runtime request is allowed to overwrite when it returns. */
export function snapshotRecentTabRuntimeVersions(
	versions: ReadonlyRecentTabRuntimeVersions,
	narratorIds: Iterable<string>,
): RecentTabRuntimeVersions {
	const snapshot: RecentTabRuntimeVersions = new Map();
	for (const narratorId of narratorIds) {
		snapshot.set(narratorId, new Map(versions.get(narratorId) ?? []));
	}
	return snapshot;
}

export function pruneRecentTabsRuntimeVersions(
	versions: RecentTabRuntimeVersions,
	liveNarratorIds: ReadonlySet<string>,
	inFlightNarratorIdSnapshots: Iterable<ReadonlySet<string>>,
): void {
	const retainedNarratorIds = new Set(liveNarratorIds);
	for (const snapshot of inFlightNarratorIdSnapshots) {
		for (const narratorId of snapshot) retainedNarratorIds.add(narratorId);
	}
	for (const narratorId of versions.keys()) {
		if (!retainedNarratorIds.has(narratorId)) versions.delete(narratorId);
	}
}

/**
 * Drop every runtime field whose WS counter advanced after the request began, so a
 * slow poll can still refresh untouched fields without reverting fresher ones.
 */
export function reconcileRecentTabsRuntimePatches(
	patches: RecentTabRuntimePatch[],
	narratorIdsByKey: ReadonlyMap<string, string>,
	versionsAtRequest: ReadonlyRecentTabRuntimeVersions,
	currentVersions: ReadonlyRecentTabRuntimeVersions,
): RecentTabRuntimePatch[] {
	return patches.flatMap(({ key, patch }) => {
		const narratorId = narratorIdsByKey.get(key);
		if (!narratorId) return [{ key, patch }];
		const current = currentVersions.get(narratorId);
		if (!current || current.size === 0) return [{ key, patch }];
		const requested = versionsAtRequest.get(narratorId);
		const fresh: Record<string, unknown> = {};
		let stale = false;
		for (const [field, value] of Object.entries(patch)) {
			if ((current.get(field) ?? 0) !== (requested?.get(field) ?? 0)) {
				stale = true;
				continue;
			}
			fresh[field] = value;
		}
		if (!stale) return [{ key, patch }];
		return Object.keys(fresh).length > 0 ? [{ key, patch: fresh }] : [];
	});
}

function recentTabMatchesPath(tab: RecentTab, pathname: string): boolean {
	if (tab.type === "project") return pathname === `/projects/${tab.id}`;
	if (tab.type === "chapter") {
		return !!tab.narratorId && pathname === `/narrators/${tab.narratorId}`;
	}
	if (tab.type === "workspace") return pathname === `/narrators/workspace/${tab.id}`;
	return pathname === `/narrators/${tab.id}`;
}

export function selectRecentTabsLiveWindow(
	tabs: RecentTab[],
	pathname: string,
	limit = RECENT_TABS_LIVE_LIMIT,
): RecentTab[] {
	const selected: RecentTab[] = [];
	const narratorIds = new Set<string>();
	const add = (tab: RecentTab) => {
		const narratorId = recentTabNarratorId(tab);
		if (!narratorId || narratorIds.has(narratorId) || selected.length >= limit) return;
		narratorIds.add(narratorId);
		selected.push(tab);
	};
	for (const tab of tabs) {
		if (recentTabMatchesPath(tab, pathname)) add(tab);
	}
	for (const tab of tabs) {
		if (tab.pinned) add(tab);
	}
	for (const tab of tabs) {
		if (
			tab.status === "working" ||
			tab.status === "waiting" ||
			tab.substatus?.some((status) => status === "unread" || status === "error")
		) {
			add(tab);
		}
	}
	for (const tab of tabs) {
		if (tab.hasDraft) add(tab);
	}
	for (const tab of tabs) add(tab);
	return selected;
}

export type AddRecentTabInput = Omit<RecentTab, "lastVisitedAt"> & {
	lastVisitedAt?: number;
	updateOnly?: boolean;
};

export function buildRecentTabUpsert(tab: AddRecentTabInput): RecentTab & { updateOnly: boolean } {
	const { updateOnly: explicitUpdateOnly, ...rest } = tab;
	const entry = normalizeRecentTab({ ...rest, lastVisitedAt: rest.lastVisitedAt ?? Date.now() });
	return { ...entry, updateOnly: explicitUpdateOnly ?? false };
}

export interface SubagentRecentTabInput {
	id: string;
	parentNarratorId?: string | null;
	title?: string | null;
	cwd?: string | null;
	status?: string | null;
	isScheduled?: boolean;
}

export interface SubagentRecentTabPreferenceState {
	isLoading: boolean;
	addSubagentToRecentTabs?: boolean;
}

export function shouldAddSubagentRecentTab({
	isLoading,
	addSubagentToRecentTabs,
}: SubagentRecentTabPreferenceState): boolean {
	return !isLoading && addSubagentToRecentTabs !== false;
}

export function buildSubagentRecentTab(input: SubagentRecentTabInput): AddRecentTabInput {
	return {
		type: "subagent",
		id: input.id,
		parentNarratorId: input.parentNarratorId ?? undefined,
		title: input.title?.trim() || "Subagent",
		subtitle: input.cwd ?? undefined,
		status: input.status ?? undefined,
		isScheduled: input.isScheduled,
	};
}
