/**
 * RenderSpecTask.tsx — Dynamic Spec task rows inside an injection bubble.
 *
 * Paints exactly what measure-spec-task reserved: per row a status glyph, an optional
 * protected lock, and the task text wrapped over however many lines the measure pass
 * counted. No tinted band, no single-line clamp, no nested card.
 *
 * ## Why both producers land here
 *
 * The auto-continuation (`spec_continuation`) carries ONE task; the periodic digest
 * (`living_work_spec`) carries the whole open list. They used to render as different
 * species of object — a task row vs markdown bullets whose status was a text prefix
 * ("doing: …") and whose protected flag was the words "· protected". Same data, two
 * visual languages. Both now come through this renderer, so a continuation row and a
 * digest row are the same object at the same metrics.
 *
 * Each row re-derives its own text column with `specTaskChromeWidth`, mirroring the
 * measure pass: a protected row's lock lane makes its column narrower, and painting
 * every row at one shared width would re-wrap the locked ones.
 *
 * ## Why a `doing` row does not animate by itself
 *
 * `role: "doing"` is a RECORDED status, not a live one: every digest ever injected
 * carries the task that was in progress when it was written. Spinning on the status
 * alone therefore set the whole scrollback spinning — a reader scrolling through
 * history saw a dozen bubbles all claiming to be working right now.
 *
 * So animation is gated on `live`, which the integration layer sets for the NEWEST
 * spec-task bubble and only while the narrator is actually running (same rule the
 * chunked SpecTasksDetail uses: `isThinking && isLatestTasksCard`). A live row also
 * swaps its glyph for a LOADER: a spinning "play" triangle reads as a control being
 * operated, not as work in flight.
 */

import { Group, Text, ThemeIcon } from "@mantine/core";
import {
	IconBan,
	IconCheck,
	IconChevronRight,
	IconLoader2,
	IconLock,
	IconPlayerPlay,
} from "@tabler/icons-react";
import type { ComponentType } from "react";
import {
	SPEC_TASK_FONT,
	SPEC_TASK_GLYPH,
	SPEC_TASK_GLYPH_GAP,
	SPEC_TASK_LINE_HEIGHT,
	SPEC_TASK_LOCK,
	SPEC_TASK_LOCK_GAP,
	SPEC_TASK_ROW_GAP,
	type SpecTaskData,
	type SpecTaskRow,
	specTaskChromeWidth,
	specTaskRows,
} from "../measure/measure-spec-task";
import type { MeasuredElement } from "../prepared-block";

/**
 * Glyph per Dynamic Spec role, matching the tool card's task list so the two read as
 * one vocabulary. A continuation has no role and is `doing` by definition.
 */
const ROLE_GLYPH: Record<
	string,
	{ Icon: ComponentType<{ size?: number; className?: string }>; color: string }
> = {
	doing: { Icon: IconPlayerPlay, color: "blue" },
	next: { Icon: IconChevronRight, color: "indigo" },
	todo: { Icon: IconChevronRight, color: "yellow" },
	blocked: { Icon: IconBan, color: "orange" },
	done: { Icon: IconCheck, color: "green" },
};

export function RenderSpecTask({
	measured,
	data,
	live = false,
}: {
	measured: MeasuredElement;
	data: SpecTaskData;
	/**
	 * This bubble is the NEWEST spec-task injection AND the narrator is running, so
	 * a `doing` row is describing work happening right now. Height-neutral: it only
	 * swaps the glyph inside the already-reserved 16px lane.
	 */
	live?: boolean;
}) {
	const emptyLabel = data.emptyLabel?.trim();
	if (emptyLabel) {
		// A digest with nothing to list: one dimmed line at the full inner width, so an
		// empty spec still says so instead of leaving a header-only bubble.
		return (
			<Text
				size="xs"
				c="dimmed"
				style={{
					width: measured.contentWidth,
					lineHeight: `${SPEC_TASK_LINE_HEIGHT}px`,
					whiteSpace: "pre-wrap",
					overflowWrap: "anywhere",
				}}
			>
				{emptyLabel}
			</Text>
		);
	}

	const rows = specTaskRows(data);
	// The bubble overwrites `measured.contentWidth` with its own inner width, so the
	// per-row column has to be re-derived here (this is the overflow bug's fix: reading
	// contentWidth directly gave the text the full inner width and then placed the
	// glyph/lock lanes beside it, pushing the text past the bubble's right edge).
	const innerWidth = measured.contentWidth;
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				gap: SPEC_TASK_ROW_GAP,
				boxSizing: "border-box",
			}}
		>
			{rows.map((row, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: rows are a stable ordered list
				<SpecTaskRowView key={index} row={row} innerWidth={innerWidth} live={live} />
			))}
		</div>
	);
}

function SpecTaskRowView({
	row,
	innerWidth,
	live,
}: {
	row: SpecTaskRow;
	innerWidth: number;
	live: boolean;
}) {
	const blocked = row.blocked === true || row.role === "blocked";
	const isProtected = row.protected === true;
	const entry = ROLE_GLYPH[blocked ? "blocked" : (row.role ?? "doing")] ?? ROLE_GLYPH.doing;
	const { color } = entry;
	// Only the LIVE bubble's in-progress row animates (see the module header): a
	// recorded `doing` is history, and a whole scrollback of spinners claims work
	// that finished long ago. A live row also becomes a LOADER rather than a
	// spinning play triangle.
	const spinning = live && !blocked && (row.role ?? "doing") === "doing";
	const Icon = spinning ? IconLoader2 : entry.Icon;
	const textWidth = Math.max(1, innerWidth - specTaskChromeWidth(row));
	return (
		<Group gap={SPEC_TASK_GLYPH_GAP} wrap="nowrap" align="flex-start">
			<Group
				gap={SPEC_TASK_LOCK_GAP}
				wrap="nowrap"
				align="center"
				style={{ flexShrink: 0, height: SPEC_TASK_LINE_HEIGHT }}
			>
				<ThemeIcon size={SPEC_TASK_GLYPH} variant="light" color={color} radius="xl">
					<Icon size={10} className={spinning ? "vlist-spin" : undefined} />
				</ThemeIcon>
				{isProtected ? (
					<IconLock
						size={SPEC_TASK_LOCK}
						color="var(--mantine-color-yellow-6)"
						style={{ flexShrink: 0 }}
					/>
				) : null}
			</Group>
			<div
				style={{
					// `flex: 0 0 auto` with the measured width: letting flex shrink or grow
					// this column would re-wrap the text at a width the measure pass never
					// saw, while the frame's height is already pinned.
					flex: "0 0 auto",
					width: textWidth,
					font: SPEC_TASK_FONT,
					lineHeight: `${SPEC_TASK_LINE_HEIGHT}px`,
					whiteSpace: "pre-wrap",
					overflowWrap: "anywhere",
					color: blocked ? "var(--mantine-color-orange-6)" : undefined,
				}}
			>
				{row.text ?? ""}
			</div>
		</Group>
	);
}
