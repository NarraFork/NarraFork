/**
 * The ATTACHMENT edge: a dashed teal connector from a chapter to something that
 * belongs to it rather than to the story graph.
 *
 * Registered under the edge type `"terminal"`, which is historical — it once linked
 * chapters to standalone terminal nodes. Those are gone; its only remaining use is
 * the connector to a detached tool-panel node (see `buildLocalEdges`). The type
 * string is kept because renaming it would invalidate nothing but touch every
 * builder, and edge types are plain strings, so a mismatch fails silently by simply
 * not rendering.
 */

import { BaseEdge, type EdgeProps, getSmoothStepPath } from "@xyflow/react";

export function TerminalEdge({
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	style,
	...props
}: EdgeProps) {
	const [edgePath] = getSmoothStepPath({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
	});

	return (
		<BaseEdge
			{...props}
			path={edgePath}
			style={{
				stroke: "var(--mantine-color-teal-5)",
				strokeWidth: 1.5,
				strokeDasharray: "6 3",
				opacity: 0.6,
				...style,
			}}
		/>
	);
}
