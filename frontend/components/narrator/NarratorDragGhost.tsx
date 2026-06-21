import { Box, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import {
	type NarratorDragState,
	onNarratorDragEnd,
	onNarratorDragMove,
} from "../../lib/narrator-drag";
import { Z } from "../../lib/z-index";

/** Floating ghost that follows the cursor during a narrator drag. */
export function NarratorDragGhost() {
	const [state, setState] = useState<NarratorDragState | null>(null);

	useEffect(() => {
		const unsubMove = onNarratorDragMove((s) => setState(s));
		const unsubEnd = onNarratorDragEnd(() => setState(null));
		return () => {
			unsubMove();
			unsubEnd();
		};
	}, []);

	if (!state) return null;

	return (
		<Box
			style={{
				position: "fixed",
				left: state.x + 12,
				top: state.y + 12,
				zIndex: Z.dragGhost,
				pointerEvents: "none",
				maxWidth: 200,
			}}
		>
			<Box
				px="xs"
				py={4}
				style={{
					backgroundColor: "var(--mantine-color-body)",
					border: "1px solid var(--mantine-color-indigo-7)",
					borderRadius: 4,
					boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
				}}
			>
				<Text size="xs" truncate>
					{state.title || state.narratorId.slice(0, 8)}
				</Text>
			</Box>
		</Box>
	);
}
