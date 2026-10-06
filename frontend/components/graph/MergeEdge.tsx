import { statusRegistry } from "@frontend/lib/status-registry";
import { type EdgeProps, getSmoothStepPath } from "@xyflow/react";

export function MergeEdge({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	style = {},
	markerEnd,
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
		<path
			id={id}
			style={{
				...style,
				strokeWidth: 2,
				stroke: statusRegistry.edgeType("merge").color,
				strokeDasharray: "5,5",
			}}
			className="react-flow__edge-path animated"
			d={edgePath}
			markerEnd={markerEnd}
		/>
	);
}
