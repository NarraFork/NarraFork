/**
 * Shared affordance for sidebar reordering and external narrator drops.
 *
 * Two shapes, because the two outcomes are not variations of each other: an insertion
 * LINE for "order it here", and a BOX around a workspace group for "join this workspace".
 * Drawing a line for the join case would promise ordering and deliver membership.
 *
 * Absolutely positioned inside the tab list (which is `position: relative`), rendered
 * above the rows but never interactive — the drag singleton owns the pointer, and a
 * pointer-catching overlay here would break the hit test the drop itself relies on.
 */

import { Z } from "@frontend/lib/z-index";
import {
	type RecentTabDropRow,
	type RecentTabDropTarget,
	recentTabDropIndicatorRow,
	recentTabWorkspaceBounds,
} from "./recent-tab-drop-target";

export interface RecentTabDropIndicatorProps {
	rows: RecentTabDropRow[];
	target: RecentTabDropTarget;
	/** Viewport-space top of the positioning container, captured with `rows`. */
	containerTop: number;
}

const ACCENT = "var(--mantine-color-indigo-5)";

export function RecentTabDropIndicator({
	rows,
	target,
	containerTop,
}: RecentTabDropIndicatorProps) {
	if (target.kind === "workspace") {
		const bounds = recentTabWorkspaceBounds(rows, target.workspaceId);
		if (!bounds) return null;
		return (
			<div
				aria-hidden
				style={{
					position: "absolute",
					left: 0,
					right: 0,
					top: bounds.top - containerTop,
					height: bounds.bottom - bounds.top,
					border: `2px solid ${ACCENT}`,
					borderRadius: "var(--mantine-radius-sm)",
					background: "var(--mantine-color-indigo-light)",
					pointerEvents: "none",
					zIndex: Z.raised,
				}}
			/>
		);
	}

	const indicator = recentTabDropIndicatorRow(rows, target);
	if (!indicator) return null;
	const edge = indicator.side === "top" ? indicator.row.top : indicator.row.bottom;
	return (
		<div
			aria-hidden
			style={{
				position: "absolute",
				left: 0,
				right: 0,
				// Centre the 2px line on the boundary so it reads as "between rows"
				// rather than as an underline belonging to the row above it.
				top: edge - containerTop - 1,
				height: 2,
				background: ACCENT,
				borderRadius: 1,
				pointerEvents: "none",
				zIndex: Z.raised,
			}}
		/>
	);
}
