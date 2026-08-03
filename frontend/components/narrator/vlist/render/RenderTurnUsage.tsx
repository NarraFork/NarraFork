/**
 * RenderTurnUsage.tsx — Render copy of the per-turn token/cost rows measured by
 * measure-turn-usage.ts.
 *
 * Visual parity target: the `<Text size="xs" c="dimmed" ta="right" pr="sm">`
 * siblings the chunked path draws around a message bubble (MessageRenderer.tsx).
 *
 * Each line is absolutely positioned at its measured offset and clamped to a
 * single line (`nowrap` + `ellipsis`). The clamp is what makes the measured
 * height honest: without it a long usage summary on a narrow column would wrap
 * and overflow the box the layout reserved.
 *
 * Zero DOM measurement.
 */

import {
	type MeasuredTurnUsage,
	TURN_USAGE_LINE_HEIGHT,
	TURN_USAGE_PADDING_RIGHT,
} from "../measure/measure-turn-usage";
import { FONT_SIZE, SANS_FAMILY } from "../pretext-fonts";

const USAGE_FONT = `400 ${FONT_SIZE.xs}px ${SANS_FAMILY}`;

export function RenderTurnUsage({ measured }: { measured: MeasuredTurnUsage }) {
	return (
		<div style={{ position: "relative", height: measured.height }}>
			{measured.lines.map((text, index) => {
				const frame = measured.frame.blocks[index];
				if (!frame) return null;
				// The two rows have fixed, distinct ROLES (primary summary / mobile
				// overflow), so their identity comes from the role rather than the array
				// position — they are never reordered, inserted into, or filtered.
				const role = index === 0 ? "primary" : "overflow";
				return (
					<div
						key={`${measured.placement}:${role}`}
						style={{
							position: "absolute",
							top: frame.top,
							left: 0,
							right: TURN_USAGE_PADDING_RIGHT,
							height: TURN_USAGE_LINE_HEIGHT,
							font: USAGE_FONT,
							lineHeight: `${TURN_USAGE_LINE_HEIGHT}px`,
							color: "var(--mantine-color-dimmed)",
							textAlign: "right",
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis",
						}}
					>
						{text}
					</div>
				);
			})}
		</div>
	);
}
