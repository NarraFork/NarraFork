/**
 * Workspace "director" mode helpers.
 *
 * Director mode promotes one panel's group to maximized so it fills the surface
 * while the remaining groups collapse to a rail — dockview's `maximizeGroup`
 * gives us "focus one, shrink the rest" without a bespoke layout engine.
 *
 * Workspace-specific (not part of the generic dockview layer): the notion of a
 * primary panel and director/grid mode belongs to the workspace domain.
 */

import type { DockviewApi, IDockviewPanel } from "dockview-react";
import type { WorkspaceDirectorState } from "./dockview-layout";

/** Maximize the primary panel's group (falls back to active / first panel). */
export function applyDirectorMode(api: DockviewApi, state: WorkspaceDirectorState): void {
	const primary = resolvePrimaryPanel(api, state.primaryPanelId);
	if (!primary) return;
	api.maximizeGroup(primary);
}

/** Exit director mode by restoring any maximized group. */
export function exitDirectorMode(api: DockviewApi): void {
	if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
}

function resolvePrimaryPanel(
	api: DockviewApi,
	primaryPanelId: string | null,
): IDockviewPanel | undefined {
	if (primaryPanelId) {
		const found = api.getPanel(primaryPanelId);
		if (found) return found;
	}
	return api.activePanel ?? api.panels[0];
}
