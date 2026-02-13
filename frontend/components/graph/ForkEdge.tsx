import { type EdgeProps, getBezierPath } from "@xyflow/react";

export function ForkEdge({
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
	const [edgePath] = getBezierPath({
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
			style={{ ...style, strokeWidth: 2, stroke: "#4c6ef5" }}
			className="react-flow__edge-path"
			d={edgePath}
			markerEnd={markerEnd}
		/>
	);
}
