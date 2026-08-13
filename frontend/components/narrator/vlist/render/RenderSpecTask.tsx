/**
 * RenderSpecTask.tsx — the framed Dynamic Spec task row inside an injection bubble.
 *
 * Paints what measure-spec-task reserved: a status glyph, an optional protected lock,
 * and the task text wrapped over however many lines the measure pass counted. No
 * tinted band, no single-line clamp, no nested card — that was the card-in-a-card
 * (and the doubled lock) this replaces.
 *
 * The text is painted at the SAME font and width the measure pass wrapped it at
 * (`measured.contentWidth`), so the on-screen line breaks match the predicted height
 * instead of drifting from them. The glyph echoes the tool card's task language: a
 * continuation is the scheduler telling the model to keep GOING, so it reads as
 * `doing` (a spinning play glyph); a blocked continuation flips to the orange ban.
 * The lock is the same yellow the tool card uses for a protected task.
 */

import { Group, ThemeIcon } from "@mantine/core";
import { IconBan, IconLock, IconPlayerPlay } from "@tabler/icons-react";
import {
	SPEC_TASK_FONT,
	SPEC_TASK_GLYPH,
	SPEC_TASK_GLYPH_GAP,
	SPEC_TASK_LINE_HEIGHT,
	SPEC_TASK_LOCK,
	SPEC_TASK_LOCK_GAP,
	type SpecTaskData,
} from "../measure/measure-spec-task";
import type { MeasuredElement } from "../prepared-block";

export function RenderSpecTask({
	measured,
	data,
}: {
	measured: MeasuredElement;
	data: SpecTaskData;
}) {
	const blocked = data.blocked === true;
	const isProtected = data.protected === true;
	const Icon = blocked ? IconBan : IconPlayerPlay;
	const glyphColor = blocked ? "orange" : "blue";
	return (
		<Group
			gap={SPEC_TASK_GLYPH_GAP}
			wrap="nowrap"
			align="flex-start"
			style={{ height: measured.height, boxSizing: "border-box" }}
		>
			<Group
				gap={SPEC_TASK_LOCK_GAP}
				wrap="nowrap"
				align="center"
				style={{ flexShrink: 0, height: SPEC_TASK_LINE_HEIGHT }}
			>
				<ThemeIcon size={SPEC_TASK_GLYPH} variant="light" color={glyphColor} radius="xl">
					<Icon size={10} className={blocked ? undefined : "vlist-spin"} />
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
					// `flex: 0 0 auto`, NOT `flex: 1`: the width must be exactly the one the
					// measure pass wrapped the text at. With `flex: 1` (plus `minWidth: 0`)
					// a frame narrower than chrome + contentWidth would let the browser
					// shrink this column, wrapping into more lines than were measured —
					// while the outer frame's height is already pinned to `measured.height`,
					// so the extra lines would be clipped. Growing is equally wrong: it
					// would wrap at a width the measurement never saw.
					flex: "0 0 auto",
					width: measured.contentWidth,
					font: SPEC_TASK_FONT,
					lineHeight: `${SPEC_TASK_LINE_HEIGHT}px`,
					whiteSpace: "pre-wrap",
					overflowWrap: "anywhere",
					color: blocked ? "var(--mantine-color-orange-6)" : undefined,
				}}
			>
				{data.text ?? ""}
			</div>
		</Group>
	);
}
