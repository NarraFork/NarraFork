/**
 * trace-row-status.tsx — the ONE status glyph every compact "row" in the vlist
 * render layer paints: a folded trace row (`RenderToolRun`) and a subagent card's
 * recent-call row (`RenderSubagent`).
 *
 * WHICH state a row marks is decided by `@shared/tool-row-status`, so the chunk
 * path and this one cannot disagree; this module only maps a mark kind to a glyph.
 * Notably SUCCESS is unmarked — see that module's header for why a column of green
 * checks is noise rather than information.
 *
 * The caller resolves the mark and passes it in, rather than passing a status for
 * this module to resolve twice: the answer depends on a context (queued behind an
 * upstream call / a deliberating gate), and evaluating it separately for "draw a
 * slot?" and "draw which glyph?" is how a row ends up reserving 12px of nothing.
 *
 * HEIGHT-NEUTRAL by construction: every branch is a single `STATUS_ICON_SIZE` glyph
 * inside a fixed-size flex slot, so no measure module needs to know a row carries
 * one. A row with nothing to mark renders NOTHING — not a reserved blank — because
 * an empty 12px gap on every successful row is the same visual noise as the check it
 * replaced.
 */

import type { ToolRowStatusMark } from "@shared/tool-row-status";
import {
	IconBan,
	IconCircleX,
	IconClock,
	IconLoader2,
	IconPlayerPause,
	IconShield,
} from "@tabler/icons-react";
import type { CSSProperties } from "react";

// Re-exported so the render layer has one import for "row status" concerns; the
// RULE itself lives in shared/ (see the file header).
export type { ToolRowStatusContext, ToolRowStatusMark } from "@shared/tool-row-status";
export { isTerminalToolRowStatus, resolveToolRowStatusMark } from "@shared/tool-row-status";

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

/** English names for the marks, used when the caller injects none. */
const DEFAULT_MARK_LABELS: Readonly<Record<ToolRowStatusMark, string>> = {
	running: "running",
	queued: "waiting for earlier tools",
	reflecting: "reflecting",
	awaiting: "waiting for a decision",
	failed: "failed",
	cancelled: "cancelled",
};

/**
 * One row's status glyph, drawn from an ALREADY-RESOLVED mark.
 *
 * Takes the mark rather than a status on purpose: resolving it needs a context
 * (queued / reflecting), and a caller that passed that context to the "should I
 * draw a slot?" check but not to the glyph would reserve width for nothing. One
 * evaluation, handed to both decisions — see `@shared/tool-row-status`.
 *
 * ── MOTION IS THE CLAIM ───────────────────────────────────────────────────────
 * Only `running` spins. `queued` and `awaiting` are in flight but NOT executing,
 * and a spinner is the strongest activity signal a 12px slot has: spinning for a
 * parked call reported work that was not happening, directly beside shimmer text
 * that said the call was waiting. A static clock / pause glyph says "in flight,
 * not moving", which is what those two states are.
 */
export function TraceRowStatusGlyph({
	mark,
	labels,
}: {
	mark: ToolRowStatusMark;
	/** Localized mark names; the glyph is the only channel for these states. */
	labels?: Partial<Record<ToolRowStatusMark, string>>;
}) {
	const label = labels?.[mark] ?? DEFAULT_MARK_LABELS[mark];
	const common = { size: TRACE_ROW_STATUS_ICON_SIZE, "aria-label": label, role: "img" } as const;
	if (mark === "running") {
		return (
			<IconLoader2
				{...common}
				className="vlist-spin"
				style={{ color: cssColor("blue", 6), flexShrink: 0 }}
			/>
		);
	}
	if (mark === "queued") {
		// Slate, matching the parked queued wash both shimmer stylesheets paint
		// (`--queued` in card-shimmer.css / trace-shimmer.css). Static: the call has
		// not started.
		return <IconClock {...common} style={{ color: cssColor("slate", 5), flexShrink: 0 }} />;
	}
	if (mark === "reflecting") {
		return (
			<IconShield
				{...common}
				// Optical centering: the pointed shield reads lower than adjacent text.
				style={{
					color: cssColor("indigo", 6),
					flexShrink: 0,
					display: "block",
					transform: "translateY(-1px)",
				}}
			/>
		);
	}
	if (mark === "awaiting") {
		// Yellow, matching the card's own `STATUS_COLOR.pending` and the yellow border
		// a card with a live permission form draws — the reader already reads that hue
		// as "this is on you".
		return <IconPlayerPause {...common} style={{ color: cssColor("yellow", 6), flexShrink: 0 }} />;
	}
	if (mark === "failed") {
		return <IconCircleX {...common} style={{ color: cssColor("red", 6), flexShrink: 0 }} />;
	}
	return <IconBan {...common} style={{ color: cssColor("orange", 6), flexShrink: 0 }} />;
}
