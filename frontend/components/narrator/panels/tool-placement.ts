/**
 * Pure placement decision for opening a resource (tool) panel in a focus dock
 * cluster. Extracted from `NarratorDockContext.openToolPanel` so the "first tool
 * splits right at ~1/3, subsequent tools stack as tabs" rule can be unit-tested
 * without a live DockviewApi.
 */

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
	| { mode: "standalone" };

/**
 * Decide where a newly-opened tool panel should go:
 *   - a secondary group already exists → stack as a tab within it;
 *   - otherwise, if chat is present → split a new group to chat's right, sized
 *     to ~1/3 of the surface so main:secondary ≈ 2:1;
 *   - otherwise (no chat, defensive) → add standalone.
 */
export function resolveToolPlacement(inputs: ToolPlacementInputs): ToolPlacement {
	if (inputs.hasSecondaryGroup) return { mode: "within-secondary" };
	if (inputs.hasChatPanel) {
		return {
			mode: "split-right",
			initialWidth: inputs.surfaceWidth > 0 ? Math.round(inputs.surfaceWidth / 3) : undefined,
		};
	}
	return { mode: "standalone" };
}
