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

import { type MeasuredTurnUsage, TURN_USAGE_PADDING_RIGHT } from "../measure/measure-turn-usage";
import { typographyMetrics } from "../pretext-fonts";

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
							height: typographyMetrics().line.xs,
							// Read live, like the two values around it. This was a frozen
							// `400 ${FONT_SIZE.xs}px` constant while `height` and `lineHeight`
							// scaled, so a scaled-up reader got a taller line box holding
							// baseline-sized text — self-evidently inconsistent within one style
							// object, and invisible because `nowrap + ellipsis` hides the overflow.
							font: typographyMetrics().font.xs,
							lineHeight: `${typographyMetrics().line.xs}px`,
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
