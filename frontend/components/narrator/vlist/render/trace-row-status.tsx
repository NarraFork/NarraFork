/**
 * trace-row-status.tsx — the ONE status glyph every compact "row" in the vlist
 * render layer paints: a folded trace row (`RenderToolRun`) and a subagent card's
 * recent-call row (`RenderSubagent`).
 *
 * WHICH statuses get a mark is decided by `@shared/tool-row-status`, so the chunk
 * path and this one cannot disagree; this module only maps a mark kind to a glyph.
 * Notably SUCCESS is unmarked — see that module's header for why a column of green
 * checks is noise rather than information.
 *
 * HEIGHT-NEUTRAL by construction: every branch is a single `STATUS_ICON_SIZE` glyph
 * inside a fixed-size flex slot, so no measure module needs to know a row carries
 * one. A row with nothing to mark renders NOTHING — not a reserved blank — because
 * an empty 12px gap on every successful row is the same visual noise as the check it
 * replaced.
 */

import { resolveToolRowStatusMark } from "@shared/tool-row-status";
import { IconBan, IconCircleX, IconLoader2 } from "@tabler/icons-react";
import type { CSSProperties } from "react";

// Re-exported so the render layer has one import for "row status" concerns; the
// RULE itself lives in shared/ (see the file header).
export { hasToolRowStatusMark, isTerminalToolRowStatus } from "@shared/tool-row-status";

/** Glyph size (matches the chunk path's 12px `StatusIcon`). */
export const TRACE_ROW_STATUS_ICON_SIZE = 12;

/**
 * Fixed slot for the glyph.
 *
 * A block box holding an inline `<svg>` derives its line box from the ROOT font
 * size (16 × 1.55 = 24.8px), not from the 12px glyph — which is how the subagent
 * row used to be INFLATED by its own status icon. Laying the slot out as flex at
 * an explicit size makes the glyph height-neutral in both directions, and
 * `flexShrink: 0` keeps a long title from eating the reservation.
 */
export const TRACE_ROW_STATUS_SLOT_STYLE = {
	width: TRACE_ROW_STATUS_ICON_SIZE,
	height: TRACE_ROW_STATUS_ICON_SIZE,
	flexShrink: 0,
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
} as const satisfies CSSProperties;

function cssColor(color: string, shade: number): string {
	return `var(--mantine-color-${color}-${shade})`;
}

/**
 * One row's status glyph: a spinner while in flight, a red X on failure, an orange
 * ban on cancellation — and nothing at all otherwise.
 *
 * Returns null for every unmarked status (success included), so the caller can drop
 * the slot entirely rather than reserving blank width.
 */
export function TraceRowStatusGlyph({ status }: { status?: string | null }) {
	const mark = resolveToolRowStatusMark(status);
	if (mark === "running") {
		return (
			<IconLoader2
				size={TRACE_ROW_STATUS_ICON_SIZE}
				className="vlist-spin"
				style={{ color: cssColor("blue", 6), flexShrink: 0 }}
			/>
		);
	}
	if (mark === "failed") {
		return (
			<IconCircleX
				size={TRACE_ROW_STATUS_ICON_SIZE}
				style={{ color: cssColor("red", 6), flexShrink: 0 }}
			/>
		);
	}
	if (mark === "cancelled") {
		return (
			<IconBan
				size={TRACE_ROW_STATUS_ICON_SIZE}
				style={{ color: cssColor("orange", 6), flexShrink: 0 }}
			/>
		);
	}
	return null;
}
