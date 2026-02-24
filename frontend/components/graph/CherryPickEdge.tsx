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
				stroke: "#7950f2",
				strokeWidth: 2,
				strokeDasharray: "4 4",
				...style,
			}}
		/>
	);
}
