/**
 * Pure placement decision for opening a resource (tool) panel in a focus dock
 * cluster. Extracted from `NarratorDockContext.openToolPanel` so the "first tool
 * splits right at ~1/3, subsequent tools stack as tabs" rule can be unit-tested
 * without a live DockviewApi.
 */

import type { DockviewApi } from "dockview-react";

/** Prefer an existing group away from the browser; otherwise split beside it. */
export function resolveFileBrowserPosition(api: DockviewApi, sourcePanelId?: string) {
	const source = sourcePanelId ? api.getPanel(sourcePanelId) : undefined;
	if (!source) return undefined;
	const candidates = api.panels.filter((panel) => panel.group.id !== source.group.id);
	const target = candidates.find((panel) => panel.params?.panelType === "file") ?? candidates[0];
	return target
		? { referenceGroup: target.group }
		: { referencePanel: source.id, direction: "right" as const };
}

/**
 * Tool panels whose content is a horizontal strip (a timeline): stacked as a tab in
 * the ~1/3-wide right column they would be unreadably narrow, so they open as their
 * own group BELOW chat instead.
 */
export const WIDE_TOOL_PANEL_TYPES: ReadonlySet<string> = new Set(["timeline"]);

/** Initial height of a wide panel split below chat. */
export const WIDE_TOOL_PANEL_HEIGHT = 300;

export interface ToolPlacementInputs {
	/** Whether a secondary (tool) group already exists in the surface. */
	hasSecondaryGroup: boolean;
	/** Whether the chat (protagonist) panel is present. */
	hasChatPanel: boolean;
	/** Current surface width in px (0 when unknown). */
	surfaceWidth: number;
}

export type ToolPlacement =
	| { mode: "within-secondary" }
	| { mode: "split-right"; initialWidth: number | undefined }
	| { mode: "split-below"; initialHeight: number | undefined }
	| { mode: "standalone" };

/**
 * Decide where a newly-opened tool panel should go:
 *   - a secondary group already exists → stack as a tab within it;
 *   - otherwise, if chat is present → split a new group to chat's right, sized
 *     to ~1/3 of the surface so main:secondary ≈ 2:1;
 *   - otherwise (no chat, defensive) → add standalone.
 */
export function resolveToolPlacement(
	inputs: ToolPlacementInputs & { wide?: boolean; surfaceHeight?: number },
): ToolPlacement {
	if (inputs.wide && inputs.hasChatPanel) {
		const height = inputs.surfaceHeight ?? 0;
		return {
			mode: "split-below",
			initialHeight:
				height > 0 ? Math.min(WIDE_TOOL_PANEL_HEIGHT, Math.round(height * 0.45)) : undefined,
		};
	}
	if (inputs.hasSecondaryGroup) return { mode: "within-secondary" };
	if (inputs.hasChatPanel) {
		return {
			mode: "split-right",
			initialWidth: inputs.surfaceWidth > 0 ? Math.round(inputs.surfaceWidth / 3) : undefined,
		};
	}
	return { mode: "standalone" };
}
