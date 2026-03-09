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
