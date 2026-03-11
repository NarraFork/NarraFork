import { statusRegistry } from "@frontend/lib/status-registry";
import { BaseEdge, type EdgeProps, getSmoothStepPath } from "@xyflow/react";

export function ReviewEdge({
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
				stroke: statusRegistry.edgeType("review").color,
				strokeWidth: 2,
				strokeDasharray: "6 3",
				...style,
			}}
		/>
	);
}
