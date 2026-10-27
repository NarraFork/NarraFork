/**
 * Outline pages as workspace members: what a member opens (another outline page, a session) and
 * writing its place to its row. Shared by the grid panel and the Director cell.
 */
import { normalizeWorkspaceOutlineConfig } from "@shared/workspace-panels";
import { useQueryClient } from "@tanstack/react-query";
import type { IDockviewPanel } from "dockview-react";
import { useEffect, useMemo, useRef } from "react";
import { workspaceQueryKey } from "../../../hooks/useWorkspace";
import { api as apiClient } from "../../../lib/api";
import type { OutlineOpener, OutlineOpenOptions } from "../../../lib/outline-opener";
import { type OutlinePanelState, outlinePanelIdentity } from "../../../lib/outline-panel";
import { findOutlinePanel, navigateOutlinePanel } from "../dock/outline-dock";
import type { WorkspaceOutlineMemberParams } from "./panel-types";

/**
 * Write a member's place (`{ spaceId, blockId, view }`) to its row when it changes. Time is
 * not membership (the layout keeps it), so moving through the timeline writes nothing.
 */
export function usePersistOutlineMember(
	workspaceId: string | null,
	params: WorkspaceOutlineMemberParams,
): void {
	const config = normalizeWorkspaceOutlineConfig(params);
	const key = config ? JSON.stringify(config) : null;
	const saved = useRef(key);
	const panelRowId = params.panelRowId;
	useEffect(() => {
		if (!workspaceId || !panelRowId || !key || saved.current === key) return;
		saved.current = key;
		void apiClient
			.updateWorkspacePanelConfig(workspaceId, panelRowId, JSON.parse(key))
			.catch((error) => {
				console.warn("[workspace] failed to persist outline panel config", {
					workspaceId,
					panelRowId,
					error,
				});
			});
	}, [workspaceId, panelRowId, key]);
}

/**
 * Members being added, per workspace: a second click on the same page (or session) before the
 * first one's panel appears would otherwise add it twice. Kept until the workspace has been
 * read again with the new member, plus a moment for its panel to mount.
 */
const addingMembers = new Map<string, Set<string>>();
const ADDED_SETTLE_MS = 1_000;

/** Run `add` unless the same member of the workspace is already being added. */
export function addMemberOnce(
	workspaceId: string,
	member: string,
	add: () => Promise<unknown>,
): boolean {
	let adding = addingMembers.get(workspaceId);
	if (adding?.has(member)) return false;
	if (!adding) {
		adding = new Set();
		addingMembers.set(workspaceId, adding);
	}
	adding.add(member);
	const done = () => {
		const set = addingMembers.get(workspaceId);
		set?.delete(member);
		if (set?.size === 0) addingMembers.delete(workspaceId);
	};
	void add()
		.then(() => new Promise((resolve) => setTimeout(resolve, ADDED_SETTLE_MS)))
		.catch(() => {})
		.finally(done);
	return true;
}

/**
 * What a workspace member can open: another outline page (the page's panel if the surface has
 * one, else a new member) and a session (as a member, like dropping it on the canvas). A page
 * or session already being added is not added again.
 */
export function useOutlineMemberActions(
	workspaceId: string | null,
	containerApi: { readonly panels: readonly IDockviewPanel[] } | null,
): { opener: OutlineOpener | null; openSession?: (narratorId: string) => void } {
	const qc = useQueryClient();
	const containerRef = useRef(containerApi);
	containerRef.current = containerApi;
	return useMemo(() => {
		if (!workspaceId) return { opener: null };
		const refresh = () => qc.invalidateQueries({ queryKey: workspaceQueryKey(workspaceId) });
		const opener: OutlineOpener = {
			open: (state: OutlinePanelState, options: OutlineOpenOptions = {}) => {
				const config = normalizeWorkspaceOutlineConfig(state);
				if (!config) return false;
				const existing = options.newPanel
					? undefined
					: findOutlinePanel(containerRef.current?.panels ?? [], state);
				if (existing) {
					navigateOutlinePanel(existing, state);
					existing.api.setActive();
					return true;
				}
				const identity = outlinePanelIdentity(state);
				// A Ctrl/Cmd-click asks for another panel even when one shows the page: only an
				// identical request still being added is skipped.
				const member = options.newPanel
					? `outline-new:${JSON.stringify(config)}`
					: `outline:${identity}`;
				addMemberOnce(workspaceId, member, () =>
					apiClient
						.addWorkspacePanel(workspaceId, { kind: "outline", config })
						.then(refresh)
						.catch((error) => console.warn("[workspace] failed to add outline panel", error)),
				);
				return true;
			},
		};
		const openSession = (narratorId: string) => {
			addMemberOnce(workspaceId, `session:${narratorId}`, () =>
				apiClient
					.addWorkspacePanel(workspaceId, { kind: "narrator", narratorId })
					.then(refresh)
					.catch((error) => console.warn("[workspace] failed to add session panel", error)),
			);
		};
		return { opener, openSession };
	}, [workspaceId, qc]);
}
