/**
 * RenderPlanCard.tsx — Render copy of the PlanCard (system compact subtype
 * "plan", non-editing state). Pairs with measure-plan-card.ts.
 *
 * Draws the teal-tinted Paper card: a header row (IconListCheck + "plan" label +
 * optional right-aligned action buttons) followed by the markdown body rendered
 * via RenderMarkdown at the exact geometry the measure layer computed.
 *
 * Visuals mirror the original MessageBubble.tsx PlanCard (teal border/bg). Zero
 * DOM measurement — the markdown body reuses RenderMarkdown's absolute layout.
 */

import { IconListCheck } from "@tabler/icons-react";
import {
	PLAN_CARD_BORDER,
	PLAN_CARD_PADDING,
	PLAN_CARD_RADIUS,
	PLAN_HEADER_ICON,
	PLAN_HEADER_MB,
	planCardHeaderHeight,
} from "../measure/measure-plan-card";
import type { MeasuredElement } from "../prepared-block";
import { FONT_SIZE, FONT_WEIGHT, SANS_FAMILY } from "../pretext-fonts";
import { RenderMarkdown } from "./RenderMarkdown";

const LABEL_FONT = `${FONT_WEIGHT.medium} ${FONT_SIZE.xs}px ${SANS_FAMILY}`;

interface RenderPlanCardProps {
	measured: MeasuredElement;
	/** Localized "plan" label (defaults to English). */
	label?: string;
	/** True when edit/delete action buttons are shown (reserves header height). */
	hasActions?: boolean;
	/** Optional right-aligned action node (edit/delete buttons). */
	actions?: React.ReactNode;
	/** Forwarded for mermaid/katex local-measure refinement. */
	onUnknownHeight?: (height: number) => void;
}

export function RenderPlanCard({
	measured,
	label = "plan",
	hasActions = false,
	actions,
	onUnknownHeight,
}: RenderPlanCardProps) {
	const headerHeight = planCardHeaderHeight(hasActions);
	return (
		<div
			style={{
				position: "relative",
				boxSizing: "border-box",
				padding: PLAN_CARD_PADDING,
				border: `${PLAN_CARD_BORDER}px solid var(--mantine-color-teal-light-color)`,
				borderRadius: PLAN_CARD_RADIUS,
				background: "var(--mantine-color-teal-light)",
			}}
		>
			{/* header row: icon + label + optional right-aligned actions */}
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 6,
					height: headerHeight,
					marginBottom: PLAN_HEADER_MB,
				}}
			>
				<IconListCheck
					size={PLAN_HEADER_ICON}
					style={{ color: "var(--mantine-color-teal-6)", flexShrink: 0 }}
				/>
				<span style={{ font: LABEL_FONT, color: "var(--mantine-color-teal-6)" }}>{label}</span>
				{actions != null ? <div style={{ marginLeft: "auto" }}>{actions}</div> : null}
			</div>
			{/* markdown body: absolute-positioned lines from the measured frame */}
			<RenderMarkdown measured={measured} onUnknownHeight={onUnknownHeight} />
		</div>
	);
}
