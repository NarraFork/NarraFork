import { statusRegistry } from "@frontend/lib/status-registry";
import { BaseEdge, type EdgeProps, getSmoothStepPath } from "@xyflow/react";

export function CherryPickEdge({
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
				stroke: statusRegistry.edgeType("cherry_pick").color,
				strokeWidth: 2,
				strokeDasharray: "4 4",
				...style,
			}}
		/>
	);
}
