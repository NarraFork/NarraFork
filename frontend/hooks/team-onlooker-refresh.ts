/**
 * Keep the recent tabs' `teamOnlooker` marker current (M1). It silences "waiting" alerts of team
 * sessions the user may only read, so it must follow every access change that makes or unmakes a
 * member: a narrator sharing change (`narrator_access_changed`, sent to the people a change names
 * and, for a team coordinator's audiences, to its recent-tab holders) and a project membership
 * change (`project_access_changed`). Either one re-reads the runtime patches when it may matter.
 */
import type { ListenerHandle, ListenerOptions, MessageCallback } from "../lib/narrator-ws-manager";
import {
	accessChangeNeedsRuntimeRefresh,
	projectAccessChangeNeedsRuntimeRefresh,
	type RecentTab,
} from "./recent-tabs-utils";

export interface AccessChangeSource {
	addListener(opts: ListenerOptions, cb: MessageCallback): ListenerHandle;
	removeListener(handle: ListenerHandle): void;
}

/** Install the listener; returns its removal. */
export function installTeamOnlookerRefresh(
	source: AccessChangeSource,
	getTabs: () => readonly RecentTab[],
	refresh: () => void,
): () => void {
	const handle = source.addListener(
		{ narratorIds: "*", types: ["narrator_access_changed", "project_access_changed"] },
		(data) => {
			const tabs = getTabs();
			if (data.type === "project_access_changed") {
				if (projectAccessChangeNeedsRuntimeRefresh(tabs)) refresh();
				return;
			}
			const narratorId = typeof data.narratorId === "string" ? data.narratorId : null;
			if (narratorId && accessChangeNeedsRuntimeRefresh(tabs, narratorId)) refresh();
		},
	);
	return () => source.removeListener(handle);
}
