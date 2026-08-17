/**
 * NarraFork Dockview layer — reusable Dockview surface + drag semantics.
 *
 * Import from here anywhere you embed Dockview and want the shared theme,
 * single-tab hiding, and three-zone (swap / merge / split) drop behaviour.
 */

export type { DockviewSurfaceProps } from "./DockviewSurface";
export {
	DOCKVIEW_THEME_CLASS,
	DockviewSurface,
	useDockviewSurfaceId,
} from "./DockviewSurface";
export {
	DEFAULT_THRESHOLDS,
	type DropIndicator,
	type DropIntent,
	type DropZoneThresholds,
	type GroupHit,
	hitTestGroups,
	intentToDirection,
	intentToPosition,
	type SplitDirection,
	toIndicator,
	VERTICAL_ONLY_THRESHOLDS,
} from "./drop-intent";
export { swapPanels } from "./panel-swap";
export {
	type DockviewDropTarget,
	isLocalPanelDrag,
	type UseDockviewDndOptions,
	type UseDockviewDndResult,
	useDockviewDnd,
} from "./useDockviewDnd";
