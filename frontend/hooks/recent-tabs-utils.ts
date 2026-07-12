export interface RecentTabViewer {
	userId: string;
	username: string;
	avatarColor: string | null;
	avatarImageId: string | null;
}

export interface RecentTab {
	type: "chapter" | "narrator" | "project" | "workspace" | "subagent" | "group";
	id: string;
	/** Primary narrator ID — used for WS subscriptions */
	narratorId?: string;
	/** Parent narrator ID — used for subagent back navigation */
	parentNarratorId?: string;
	/** If this tab belongs to a workspace, the workspace ID */
	workspaceId?: string | null;
	title: string;
	subtitle?: string;
	status?: string;
	substatus?: string[];
	lastVisitedAt: number;
	/** Whether this tab is pinned to the top */
	pinned?: boolean;
	// Runtime-enriched fields (not persisted to DB)
	activeTerminalCount?: number;
	viewers?: RecentTabViewer[];
	viewerCount?: number;
	containerStatus?: "created" | "running" | "paused" | "stopped" | null;
	/** Runtime-enriched marker: this narrator has unsent draft text. */
	hasDraft?: boolean;
	/** Runtime-enriched marker: this narrator was spawned by a scheduled task. */
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
	return {
		viewers: viewers.slice(0, RECENT_TAB_VIEWERS_MAX).map((viewer) => ({
			...viewer,
			username: clampRecentTabText(viewer.username) ?? "",
		})),
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
