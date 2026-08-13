/**
 * RenderInjectionBubble.tsx — render copy of the FRAMED markdown bubble.
 *
 * Pairs with `measure-injection-bubble.ts`. Every offset is taken from the measured
 * element; nothing here decides geometry.
 *
 * ## The one thing that must not be "simplified"
 *
 * The body is painted at `measured.contentWidth` — the width the line breaking used —
 * NOT at the frame's inner width (`usedWidth - padding*2`). Those differ whenever the
 * bubble shrink-wrapped, and painting at the narrower one would re-wrap the text under
 * a height that was predicted for the wider box, i.e. clip the last line of every
 * short-but-shrunk bubble. The measure module documents the same invariant from the
 * other side.
 *
 * ## Why the header arrives as a slot
 *
 * The speaker row needs an avatar, and the pure render/ layer imports no avatar
 * component (measure/render parity has to stay auditable, so this layer stays
 * dependency-free). The integration layer builds the node and hands it in, exactly as
 * it already does for the user bubble's header.
 *
 * Side is fixed left: an injection speaks for somebody OTHER than the reader. That
 * side, plus the speaker row, is the whole distinction — there is deliberately NO
 * per-producer accent rail or tint.
 *
 * ⚠️ Do not add one back. The previous redesign removed exactly that (a coloured Paper
 * with a 2px coloured left rail, six hues from `SIDECAR_SOURCE_META`) because it put
 * the list's heaviest skin around its least important content, with four or five hues
 * on screen at once. A rail also fights the corner radius (the border gets clipped into
 * arcs at both ends) and, under `border-box`, silently steals content width the measure
 * pass never accounted for.
 */

import type { MeasuredInjectionBubble } from "../measure/measure-injection-bubble";
import {
	INJECTION_BUBBLE_PADDING,
	INJECTION_HEADER_HEIGHT,
	INJECTION_NOTE_HEIGHT,
} from "../measure/measure-injection-bubble";
import { FONT_SIZE, LINE_HEIGHT, SANS_FAMILY } from "../pretext-fonts";
import { RenderMarkdown } from "./RenderMarkdown";
import { RenderSpecTask } from "./RenderSpecTask";
import { RenderSystemSimple } from "./RenderSystemSimple";
import { RenderSystemText } from "./RenderSystemText";

const NOTE_FONT_SIZE = FONT_SIZE.xs;

export interface RenderInjectionBubbleProps {
	measured: MeasuredInjectionBubble;
	/**
	 * Speaker row (avatar + name + markers), built by the integration layer. When
	 * absent the reserved header space is left empty rather than collapsed — the
	 * height was already committed by the measure pass.
	 */
	header?: React.ReactNode;
	/** Localized trailing note ("result truncated"); only painted when measured. */
	noteText?: string;
	/**
	 * The framed payload's own data (a spec task's text/protected/blocked), forwarded
	 * by the integration layer. Height-neutral — the measure pass already reserved
	 * the wrap; this only lets the body renderer paint the row.
	 */
	payloadData?: unknown;
	/** Forwarded for mermaid/katex local-measure refinement inside the body. */
	onUnknownHeight?: (height: number) => void;
	/**
	 * Live slots the NESTED card needs, forwarded untouched.
	 *
	 * A framed card keeps every affordance it had standalone — that is the whole point of
	 * framing the existing element instead of flattening it to prose. The bubble does not
	 * interpret these; it only makes sure the card still receives them.
	 */
	payloadSlots?: {
		avatarSlot?: React.ReactNode;
		onOpenCompact?: () => void;
		onCancelCompact?: () => void;
		cancelCompactTitle?: string;
		specCarryoverActions?: never;
		errorActions?: never;
	};
}

export function RenderInjectionBubble({
	measured,
	header,
	noteText,
	payloadData,
	onUnknownHeight,
	payloadSlots,
}: RenderInjectionBubbleProps) {
	return (
		// Left, always: this is somebody else's voice. The reader's own turns are the
		// only thing that earns the right-hand side.
		<div data-vlist-injection-row style={{ display: "flex", justifyContent: "flex-start" }}>
			<div
				data-vlist-injection-frame
				style={{
					position: "relative",
					width: measured.usedWidth,
					height: measured.height,
					padding: INJECTION_BUBBLE_PADDING,
					// Same radius as a user bubble: an injection is a message in the same
					// conversation, so it must not look like a different species of object.
					borderRadius: 8,
					background: "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))",
					boxSizing: "border-box",
				}}
			>
				{measured.hasHeader && header != null ? (
					<div
						data-vlist-injection-header
						style={{
							position: "absolute",
							top: INJECTION_BUBBLE_PADDING,
							left: INJECTION_BUBBLE_PADDING,
							right: INJECTION_BUBBLE_PADDING,
							height: INJECTION_HEADER_HEIGHT,
						}}
					>
						{header}
					</div>
				) : null}
				<div
					data-vlist-injection-body
					style={{
						position: "absolute",
						top: measured.bodyTop,
						left: INJECTION_BUBBLE_PADDING,
						// The MEASURED wrap width. See the module header on why this is not
						// derived from the frame.
						width: measured.contentWidth,
					}}
				>
					<InjectionBody
						measured={measured}
						payloadData={payloadData}
						payloadSlots={payloadSlots}
						onUnknownHeight={onUnknownHeight}
					/>
				</div>
				{/*
				 * Drawn whenever the measure pass reserved the row, INDEPENDENT of whether a
				 * label arrived. CONTRACT §4 requires the two to be one-way consistent: the
				 * body box is a fixed-height clip, so "reserved but not drawn" leaves a hole
				 * and "drawn but not reserved" pushes content out of the box. A missing label
				 * therefore yields an empty row of exactly the reserved height, never a
				 * different height.
				 */}
				{measured.noteTop >= 0 ? (
					<div
						data-vlist-injection-note
						style={{
							position: "absolute",
							top: measured.noteTop,
							left: INJECTION_BUBBLE_PADDING,
							right: INJECTION_BUBBLE_PADDING,
							height: INJECTION_NOTE_HEIGHT,
							font: `400 ${NOTE_FONT_SIZE}px ${SANS_FAMILY}`,
							lineHeight: `${LINE_HEIGHT.xs}`,
							color: "var(--mantine-color-dimmed)",
							overflow: "hidden",
							whiteSpace: "nowrap",
							textOverflow: "ellipsis",
						}}
					>
						{noteText}
					</div>
				) : null}
			</div>
		</div>
	);
}

/**
 * The bubble's body: either markdown, or the system card the payload named.
 *
 * Branches on `measured.bodyForm`, never on the shape of `measured.blocks`. A card
 * body's blocks are `PreparedFixedBlock`s and markdown's are not, so shape sniffing
 * would work today and break the first time a payload happens to look like markdown —
 * the same trap the retired `payloadKind` marker existed to close.
 *
 * The nested card is handed the SAME `measured`: its own measure fn produced
 * `blocks`/`frame`, so it re-materializes exactly what was measured. An unrecognized
 * kind renders nothing, matching the zero height the measure pass reserved for it.
 */
function InjectionBody({
	measured,
	payloadData,
	payloadSlots,
	onUnknownHeight,
}: {
	measured: MeasuredInjectionBubble;
	payloadData?: unknown;
	payloadSlots?: RenderInjectionBubbleProps["payloadSlots"];
	onUnknownHeight?: (height: number) => void;
}) {
	if (measured.bodyForm === "markdown") {
		return <RenderMarkdown measured={measured} onUnknownHeight={onUnknownHeight} />;
	}
	const kind = measured.payloadKind;
	if (!kind) return null;
	const cardMeasured = {
		...measured,
		height: measured.frame.contentHeight,
	};
	// A spec task is drawn BY THE BUBBLE as a glyph + lock + wrapping-text row, never
	// as a nested card — that card-in-a-card (full-width band, one-line clamp, doubled
	// lock) is exactly what this branch removes. Its body height is the frame's
	// content height, not the bubble's chrome-inclusive total.
	if (kind === "spec-task") {
		return <RenderSpecTask measured={cardMeasured} data={(payloadData ?? {}) as never} />;
	}
	if (SYSTEM_SIMPLE_PAYLOADS.has(kind)) {
		return (
			<RenderSystemSimple
				measured={cardMeasured}
				avatarSlot={payloadSlots?.avatarSlot}
				onOpenCompact={payloadSlots?.onOpenCompact}
				onCancelCompact={payloadSlots?.onCancelCompact}
				cancelCompactTitle={payloadSlots?.cancelCompactTitle}
			/>
		);
	}
	if (SYSTEM_TEXT_PAYLOADS.has(kind)) {
		// `kind`/`data` are read off the measured block by the card itself; passing the
		// tag keeps its dispatch identical to the standalone path.
		return <RenderSystemText measured={cardMeasured} kind={kind as never} />;
	}
	return null;
}

/** Payload kinds drawn by `RenderSystemSimple`. Mirrors the measure-side set. */
const SYSTEM_SIMPLE_PAYLOADS = new Set([
	"merge_summary",
	"review_feedback",
	"spec_continuation",
	"spec_blocked_continuation",
]);

/** Payload kinds drawn by `RenderSystemText`. Mirrors the measure-side set. */
const SYSTEM_TEXT_PAYLOADS = new Set([
	"info",
	"error",
	"container_ready",
	"browser_session_lost",
	"origin_notice",
	"spec_goal_added",
	"spec_fork_carryover",
	"spec_context_cleared",
]);
