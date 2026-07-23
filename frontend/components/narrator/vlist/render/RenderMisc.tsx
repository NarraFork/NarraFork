/**
 * RenderMisc.tsx — Render copies of misc list-level decorative elements
 * measured by measure-misc.ts (batch-2 P12).
 *
 * Currently: the prune-divider — a Mantine <Divider my="xs" labelPosition="center"
 * label=… /> at the pruned-context boundary (visual parity target:
 * MessageRenderer.tsx:645). It is a fixed single row (label row + my="xs"
 * margins), so the root box is a fixed-height container and the divider fills it.
 *
 * Zero DOM measurement (height comes from the measure layer).
 */

import { Divider } from "@mantine/core";
import { PRUNE_DIVIDER_MARGIN_Y, type PruneDividerData } from "../measure/measure-misc";
import type { MeasuredElement } from "../prepared-block";

interface RenderPruneDividerProps {
	measured: MeasuredElement;
	/** Centered label text (falls back to a neutral default). */
	data?: PruneDividerData;
	/** Fallback label when `data.label` is absent. */
	fallbackLabel?: string;
}

/** Render the prune-divider at the measured (fixed) height. */
export function RenderPruneDivider({
	measured,
	data,
	fallbackLabel = "Pruned",
}: RenderPruneDividerProps) {
	const label = data?.label ?? fallbackLabel;
	return (
		<div
			style={{
				height: measured.height,
				display: "flex",
				alignItems: "center",
				paddingTop: PRUNE_DIVIDER_MARGIN_Y,
				paddingBottom: PRUNE_DIVIDER_MARGIN_Y,
				boxSizing: "border-box",
			}}
		>
			<Divider
				w="100%"
				label={label}
				labelPosition="center"
				color="yellow.7"
				styles={{ label: { color: "var(--mantine-color-yellow-5)", fontSize: 11 } }}
			/>
		</div>
	);
}
