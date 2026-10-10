import { isRecentTabBackgroundActive } from "@frontend/hooks/recent-tabs-utils";
import type { StatusShape } from "@frontend/lib/status-registry";
import { Box } from "@mantine/core";
import {
	IconBrain,
	IconCheck,
	IconClock,
	IconExclamationMark,
	IconMessageCircle,
	IconMessageCircleFilled,
	IconPencil,
	IconShield,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import {
	getNarratorStatusIconColor,
	getNarratorStatusShape,
	isFilledNarratorStatus,
	type NarratorStatusSource,
} from "./narrator-status-icon-logic";
import { RecentTabBackgroundBubble } from "./RecentTabBackgroundBubble";

/**
 * Tabler glyph per shape, drawn OVER the centre of the narrator's own icon.
 *
 * ⚠️ Not a corner badge. These started as 11px corner dots holding a 7px glyph — the
 * same treatment the draft / reasoning / scheduled markers use — and at that size a
 * shield and an exclamation mark were simply not legible. A shape that cannot be
 * recognised carries no information, so it defeats the whole reason shape was introduced
 * (the palette having no distinguishable hue left; see `StatusShape`).
 *
 * Overlaying the centre buys roughly 2× the glyph size.
 */
const SHAPE_MARKERS: Record<StatusShape, { Icon: typeof IconCheck }> = {
	check: { Icon: IconCheck },
	shield: { Icon: IconShield },
	alert: { Icon: IconExclamationMark },
};

/**
 * How much of the host icon the knocked-out glyph occupies.
 *
 * Sized by what the host can hold, not by taste. The icon renders at 14–20px, so a glyph
 * kept "inside" the icon at ~58% came out around 8px — no better than the 7px corner badge
 * it replaced, which was rejected for being unreadable. At 0.62 it lands at 9–12px and a
 * shield is distinguishable from an exclamation mark, while still leaving a rim of the
 * bubble's colour so the hue keeps doing its grouping job.
 */
const SHAPE_GLYPH_RATIO = 0.62;

/**
 * Nudge, as a fraction of icon size, from the icon's geometric centre to the visual centre
 * of the message bubble's round body.
 *
 * Tabler's message-circle is not a centred disc: its body occupies roughly x/y 2.3–20 of
 * the 24-unit viewBox and the remaining bottom strip is the tail. Centring the glyph on the
 * box therefore pushes it down-right and it reads as misaligned. ~4% of the size back along
 * both axes puts it on the body.
 */
const SHAPE_INK_OFFSET = 0.04;

/**
 * The state shape, knocked out in WHITE from the middle of the filled bubble.
 *
 * ── WHY THERE IS NO BACKGROUND HERE ───────────────────────────────────────────
 * Two earlier attempts went wrong in opposite directions, and both are worth recording
 * because the pull toward each is still there:
 *
 *  1. A 7px badge in the corner. Too small to tell a shield from an exclamation mark.
 *  2. A filled disc the full size of the icon. This one looked worse: the bubble's ink only
 *     covers about three quarters of its box (the rest is the tail and padding), so a
 *     full-size disc buried the bubble AND spilled past its edge — a blob stuck onto the
 *     tab rather than a symbol inside it. It also appeared off-centre, because the box
 *     centre is not the bubble's centre.
 *
 * What works is to add no body at all. The bubble is already solid in the state's colour
 * (`isFilledNarratorStatus` guarantees it for any state carrying a shape), so the glyph is
 * cut out of the colour that is already there. Nothing to align, nothing to cover.
 *
 * `pointerEvents: none` because the whole icon is one click target; the glyph must not
 * become a dead spot in the middle of it.
 */
function ShapeOverlay({ shape, size }: { shape: StatusShape; size: number }) {
	const { Icon } = SHAPE_MARKERS[shape];
	return (
		<Box
			component="span"
			data-tab-shape={shape}
			style={{
				position: "absolute",
				// Centre on the bubble's INK, not on the icon's box. Tabler's message-circle
				// draws its round body in the upper-left of the viewBox and spends the bottom
				// strip on the tail, so box-centre sits low and right of where the eye reads
				// the centre. `SHAPE_INK_OFFSET` walks it back onto the body.
				left: `calc(50% - ${(size * SHAPE_INK_OFFSET).toFixed(2)}px)`,
				top: `calc(50% - ${(size * SHAPE_INK_OFFSET).toFixed(2)}px)`,
				transform: "translate(-50%, -50%)",
				display: "inline-flex",
				// No disc of its own. The host bubble is already filled with the state's
				// colour, so the glyph is knocked out OF it. Painting another circle here
				// covered the bubble entirely and spilled past its ink, which read as a blob
				// stuck on the tab rather than as a symbol inside it.
				color: "var(--mantine-color-white)",
				pointerEvents: "none",
			}}
		>
			<Icon size={Math.round(size * SHAPE_GLYPH_RATIO)} stroke={3} />
		</Box>
	);
}

export interface NarratorStatusIconProps extends NarratorStatusSource {
	size: number;
	/** Background work counters — drive the diagonally half-filled bubble. */
	activeBackgroundWorkCount?: number | null;
	activeBackgroundTaskCount?: number | null;
	/** Corner markers; omit (or pass falsy) on surfaces that do not track them. */
	hasDraft?: boolean | null;
	isScheduled?: boolean | null;
}

/**
 * The narrator status bubble, shared verbatim between the sidebar's recent tabs and
 * the narrator list page.
 *
 * Hollow = idle, filled = something happened. A narrator whose FOREGROUND is idle while
 * background tasks still run gets a diagonally half-filled bubble: the outline keeps the
 * foreground state, the filled half (working blue) says the work has not actually stopped.
 *
 * The state SHAPE (tick / shield / alert), knocked out of the middle of the icon, is
 * only drawn once the bubble is filled, because the glyph is white and supplies no body
 * of its own — it needs solid colour behind it.
 */
export function NarratorStatusIcon(props: NarratorStatusIconProps) {
	const { size } = props;
	const iconColor = getNarratorStatusIconColor(props);
	const filledStatus = isFilledNarratorStatus(props);
	const backgroundActive = isRecentTabBackgroundActive(props, filledStatus);

	let icon: ReactNode;
	if (backgroundActive) {
		icon = (
			<RecentTabBackgroundBubble size={size} color={iconColor} foregroundFilled={filledStatus} />
		);
	} else if (filledStatus) {
		icon = <IconMessageCircleFilled size={size} color={iconColor} />;
	} else {
		icon = <IconMessageCircle size={size} color={iconColor} />;
	}

	const showDraft = !!props.hasDraft;
	const showReasoning = !!props.substatus?.includes("reasoning");
	const showScheduled = !!props.isScheduled;
	const shape = filledStatus ? getNarratorStatusShape(props) : undefined;
	if (!showDraft && !showReasoning && !showScheduled && !shape) return icon;

	return (
		<Box component="span" pos="relative" style={{ display: "inline-flex", lineHeight: 0 }}>
			{icon}
			{showScheduled && (
				<Box
					component="span"
					style={{
						position: "absolute",
						right: -4,
						bottom: -4,
						width: 11,
						height: 11,
						borderRadius: "50%",
						background: "var(--mantine-color-indigo-6)",
						border: "1px solid var(--mantine-color-body)",
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						color: "var(--mantine-color-white)",
						pointerEvents: "none",
					}}
				>
					<IconClock size={7} stroke={2.5} />
				</Box>
			)}
			{showReasoning && (
				<Box
					component="span"
					style={{
						position: "absolute",
						left: -4,
						top: -4,
						width: 11,
						height: 11,
						borderRadius: "50%",
						background: "var(--mantine-color-grape-light)",
						border: "1px solid var(--mantine-color-body)",
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						color: "var(--mantine-color-grape-light-color)",
						pointerEvents: "none",
					}}
				>
					<IconBrain size={7} stroke={2.5} />
				</Box>
			)}
			{showDraft && (
				<Box
					component="span"
					style={{
						position: "absolute",
						right: -4,
						top: -4,
						width: 11,
						height: 11,
						borderRadius: "50%",
						background: "var(--mantine-color-yellow-6)",
						border: "1px solid var(--mantine-color-body)",
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						color: "var(--mantine-color-dark-9)",
						pointerEvents: "none",
					}}
				>
					<IconPencil size={7} stroke={2.5} />
				</Box>
			)}
			{/* State shape, centred OVER the icon rather than tucked into a corner —
			    see SHAPE_MARKERS on why a corner badge was too small to read. The three
			    corner markers stay where they are; this one owns the middle. */}
			{shape && <ShapeOverlay shape={shape} size={size} />}
		</Box>
	);
}
