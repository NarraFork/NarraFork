import { BaseEdge, type EdgeProps, getSmoothStepPath } from "@xyflow/react";

export function DependencyEdge({
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
				stroke: "#fd7e14",
				strokeWidth: 2,
				strokeDasharray: "8 4",
				...style,
			}}
		/>
	);
}
