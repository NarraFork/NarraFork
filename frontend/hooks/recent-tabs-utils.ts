import type { PersistedRecentTab, RecentTabRuntimePatch } from "@shared/recent-tabs";
import { RECENT_TABS_LIVE_LIMIT } from "@shared/recent-tabs";
import { getEffectiveNarratorDisplay } from "../lib/status-registry";

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
	activeBackgroundTaskCount?: number;
	activeBackgroundWorkCount?: number;
	activeBackgroundServiceCount?: number;
	viewers?: RecentTabViewer[];
	viewerCount?: number;
	/** Runtime-enriched marker: this narrator has unsent draft text. */
	hasDraft?: boolean;
	/**
	 * Runtime-enriched marker: a team session (coordinator or one of its subagents) this user
	 * may only read. Its calls wait for a member, so no "waiting for you" alert fires (M1).
	 */
	teamOnlooker?: boolean;
	/** Runtime-enriched marker: a team session (coordinator or one of its subagents). M1. */
	teamSession?: boolean;
	/**
	 * Team tabs only, runtime-enriched: the team tree's visible pending approvals, for members
	 * (null for an onlooker, who cannot decide them).
	 */
	pendingApprovalCount?: number | null;
	/** Team tabs only, runtime-enriched for members: work items ready to accept (R2). */
	readyItemCount?: number | null;
	/**
	 * Project tabs only, runtime-enriched for the hover card (`recent-tab-projects.ts`): the
	 * repository directory, this user's readable sessions running or waiting now, and readable
	 * active teams. Null when the project can no longer be read; `projectCountsCapped` means a
	 * read hit its cap, so the counts are lower bounds.
	 */
	projectPath?: string | null;
	activeSessionCount?: number | null;
	waitingSessionCount?: number | null;
	teamCount?: number | null;
	projectCountsCapped?: boolean;
	/** Persisted marker (see `PersistedRecentTab`): this narrator was spawned by a scheduled task. */
	isScheduled?: boolean;
}

/** Whether this narrator's tab is a team session the user may only read (M1). */
export function isTeamOnlookerTab(tabs: readonly RecentTab[], narratorId: string): boolean {
	return tabs.some(
		(tab) =>
			(tab.type === "narrator" || tab.type === "subagent") &&
			tab.id === narratorId &&
			tab.teamOnlooker === true,
	);
}

/**
 * A coordinator's session can sit beside a team tab with the same title. Only a session tab
 * drives notification recipients, and this label distinguishes it from the team tab.
 */
export function isCoordinatorSessionTab(tab: Pick<RecentTab, "type" | "teamSession">): boolean {
	return tab.type === "narrator" && tab.teamSession === true;
}

/**
 * The attention a narrator status calls for (after the reflecting and model-wait checks):
 * "waiting" for a person, "unread" (done), or none. A team onlooker (M1) cannot act on what
 * a team session waits for, so a waiting session alerts them only as far as it is unread.
 */
export function statusAttention(
	status: string | undefined,
	substatus: readonly string[] | null | undefined,
	teamOnlooker: boolean,
): "waiting" | "unread" | null {
	if (status === "waiting" && !teamOnlooker) return "waiting";
	if (substatus?.includes("unread")) return "unread";
	return null;
}

export const RECENT_TAB_TEXT_MAX_CHARS = 1_000;
const RECENT_TAB_VIEWERS_MAX = 20;

/**
 * Structural subset of `RecentTab` that background-activity detection reads.
 * Widened from `RecentTab` so the narrator list page (whose items are not tabs)
 * can run the same decision through `NarratorStatusIcon`.
 */
export interface RecentTabBackgroundSource {
	status?: string | null;
	substatus?: string[] | null;
	activeBackgroundWorkCount?: number | null;
	activeBackgroundTaskCount?: number | null;
}

/** Idle foreground + background work: half blue, with a hollow or unread-green base. */
export function isRecentTabBackgroundActive(
	tab: RecentTabBackgroundSource,
	filledStatus: boolean,
): boolean {
	if ((tab.activeBackgroundWorkCount ?? tab.activeBackgroundTaskCount ?? 0) <= 0) return false;
	if (!filledStatus) return true;
	// Unread fills the foreground half, but must not hide ongoing background work.
	// Keep stronger states (errors, planning, approvals) in their existing solid form.
	const substatus = tab.substatus?.filter((tag) => tag !== "reasoning");
	return (
		(tab.status ?? "idle") === "idle" &&
		getEffectiveNarratorDisplay("idle", substatus) ===
			getEffectiveNarratorDisplay("idle", ["unread"])
	);
}

/** Tab types whose `subtitle` is a working directory. */
export function hasDirectorySubtitle(tab: Pick<RecentTab, "type">): boolean {
	return tab.type === "narrator" || tab.type === "subagent";
}

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
	"activeBackgroundTaskCount",
	"activeBackgroundWorkCount",
	"activeBackgroundServiceCount",
	"viewers",
	"viewerCount",
	"hasDraft",
	"pendingApprovalCount",
	"readyItemCount",
	"teamOnlooker",
	"teamSession",
	"projectPath",
	"activeSessionCount",
	"waitingSessionCount",
	"teamCount",
	"projectCountsCapped",
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

/**
 * The narrator whose live state a tab shows: its own session, or a team tab's coordinator (the
 * team id is the coordinator's id). The narrator socket and the runtime endpoint follow this id.
 * Attention (sounds, favicon, PWA notifications) stays with session tabs: a pinned team is not
 * a subscription to its coordinator's alerts.
 */
export function recentTabLiveNarratorId(
	tab: Pick<RecentTab, "type" | "id" | "narratorId">,
): string | null {
	if (tab.type === "subagent") return tab.narratorId ?? tab.id;
	if (tab.type === "narrator" || tab.type === "team") return tab.id;
	return null;
}

/**
 * Where a tab leads: a session page, a project page or a team page. Null for a folder (not a
 * page), and for a team tab whose project is not known yet.
 */
export function recentTabHref(tab: Pick<RecentTab, "type" | "id" | "projectId">): string | null {
	if (tab.type === "narrator" || tab.type === "subagent") return `/narrators/${tab.id}`;
	if (tab.type === "project") return `/projects/${tab.id}`;
	if (tab.type === "team") {
		return tab.projectId ? `/projects/${tab.projectId}/teams/${tab.id}` : null;
	}
	return null;
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
): void {
	for (const narratorId of versions.keys()) {
		if (!liveNarratorIds.has(narratorId)) versions.delete(narratorId);
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
	const href = recentTabHref(tab);
	return href !== null && pathname === href;
}

/**
 * Project tabs whose runtime details (path and counts for the hover card,
 * `recent-tab-projects.ts`) the sidebar requests with the rest of its runtime patches. They have
 * no narrator socket, so they are chosen apart from the live window: the current page's first,
 * then pinned ones, then the rest, at most the server's per-request cap
 * (`PROJECT_TAB_DETAIL_LIMIT`). The sidebar takes their slots out of the live window's budget so
 * one request stays within `RECENT_TABS_LIVE_LIMIT` keys.
 */
export const PROJECT_TAB_RUNTIME_LIMIT = 20;

export function selectProjectRuntimeTabs(
	tabs: readonly RecentTab[],
	pathname: string,
	limit = PROJECT_TAB_RUNTIME_LIMIT,
): RecentTab[] {
	const projects = tabs.filter((tab) => tab.type === "project");
	const ordered = [
		...projects.filter((tab) => recentTabMatchesPath(tab, pathname)),
		...projects.filter((tab) => tab.pinned),
		...projects,
	];
	return [...new Map(ordered.map((tab) => [tab.id, tab])).values()].slice(0, limit);
}

export function selectRecentTabsLiveWindow(
	tabs: RecentTab[],
	pathname: string,
	limit = RECENT_TABS_LIVE_LIMIT,
): RecentTab[] {
	const selected: RecentTab[] = [];
	const narratorIds = new Set<string>();
	const add = (tab: RecentTab) => {
		const narratorId = recentTabLiveNarratorId(tab);
		// A team tab shares its coordinator's id with the coordinator's own session tab; both
		// are live, each under its own key.
		const slot = tab.type === "team" ? `team:${narratorId}` : narratorId;
		if (!narratorId || !slot || narratorIds.has(slot) || selected.length >= limit) return;
		narratorIds.add(slot);
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

/**
 * Identity of what a visit upsert would actually persist, used to skip repeat requests.
 *
 * A narrator page re-runs its visit effect whenever the narrator query object changes,
 * which happens on every status/substatus WS patch — several times per turn. Each of
 * those upserts wrote the same row and produced a revision, which then had to be
 * broadcast and applied by every client.
 *
 * `status` and `lastVisitedAt` are deliberately excluded: live status reaches the tab
 * over the narrator WS and the runtime endpoint (which both override the persisted
 * column), so re-sending it buys nothing, and `lastVisitedAt` does not affect ordering
 * on a revisit. Every other persisted field is included, so a real title/cwd change is
 * still written through. Folder membership is not sent by a visit (it only changes
 * through the folder endpoints), so it is not part of the signature.
 */
export function recentTabVisitSignature(tab: AddRecentTabInput): string {
	return JSON.stringify([
		tab.type,
		tab.id,
		tab.narratorId ?? null,
		tab.parentNarratorId ?? null,
		clampRecentTabText(tab.title) ?? "",
		clampRecentTabText(tab.subtitle) ?? null,
		tab.pinned ?? null,
		tab.isScheduled ?? null,
		tab.updateOnly ?? false,
	]);
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
