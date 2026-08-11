/**
 * RenderSidecar.tsx — Paint one system injection as a FOOTNOTE, at the geometry
 * `measure-sidecar.ts` resolved.
 *
 * ## What this is not, any more
 *
 * It used to be a coloured `Paper` with a 2px accent rail, an info icon, a source
 * badge, a raw `tool_result` / `user_message` badge and a one-line preview — the
 * heaviest skin in the list, wrapped around its least important content, in one of
 * six hues. Now it is a bare header row (source name + headline + chevron + copy) at
 * the same height as a folded trace row, with indented body lines beneath it. No
 * card, no border, no background, no rail.
 *
 * Colour is down to three tones (`peer` / `background` / neutral) and lands only on
 * the source NAME, so a message addressed to the reader is findable while a routine
 * reminder stays quiet.
 *
 * ## Geometry pairs with the measure layer exactly
 *
 * Every body line is drawn from the SAME `PreparedCodeBlock` the measure pass
 * wrapped, at the same font and the same width (`measured.lines[i]` carries its own
 * `left` / `width`, because a bullet wraps narrower than a text line). The trailing
 * "show all" / "truncated" row's height was RESERVED by the measure pass, so drawing
 * it moves nothing. Zero DOM measurement.
 *
 * The copy button and the fold toggle are the only interactions, and both are
 * height-neutral (they live in the fixed header row). The toggle is injected
 * (`onToggle`); an `open` footnote that fits shows no chevron at all and does not
 * advertise a control that would do nothing.
 */

import { layoutWithLines } from "@chenglou/pretext";
import { ActionIcon, Box, CopyButton, Group, Text, Tooltip } from "@mantine/core";
import type { SideCarTone } from "@shared/sidecar-body";
import { IconCheck, IconChevronDown, IconChevronRight, IconCopy } from "@tabler/icons-react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useMemo } from "react";
import {
	type MeasuredSidecar,
	type MeasuredSidecarLine,
	SIDECAR_HEADER_ROW,
	SIDECAR_LINE_HEIGHT,
} from "../measure/measure-sidecar";
import type { PreparedCodeBlock } from "../prepared-block";
import { FONT_XS } from "../pretext-fonts";

/**
 * Tone → the colour of the source NAME.
 *
 * Three groups, not one hue per source: a screen showing four injections used to show
 * four different colours, which made a routine progress nudge shout as loudly as a
 * teammate's message. Neutral injections take the ordinary dimmed text colour, so they
 * recede into the column entirely.
 */
function toneColor(tone: SideCarTone): string {
	switch (tone) {
		case "peer":
			return "var(--mantine-color-grape-text)";
		case "background":
			return "var(--mantine-color-blue-text)";
		default:
			return "var(--mantine-color-dimmed)";
	}
}

const DIMMED = "var(--mantine-color-dimmed)";

export interface RenderSidecarProps {
	measured: MeasuredSidecar;
	/** Fold toggle (injected by the shell). Absent → the footnote renders inert. */
	onToggle?: () => void;
	/** Localized chrome (copy tooltip etc.). Optional; English fallbacks inside. */
	labels?: { copy?: string; copied?: string };
}

/**
 * Enter / Space activation for the header row, whose only affordance is a click
 * handler on a `Group` (a div). Attributes and handlers only, so the measured
 * geometry is untouched.
 *
 * Space is `preventDefault`ed because its default action on a focused element is to
 * scroll — which in a virtual list moves the very row being read.
 *
 * The `target !== currentTarget` bail-out is what keeps the header from becoming a
 * nested-interactive trap: the copy control inside it is a real focusable button, so
 * a keyboard user pressing Enter on IT produces a keydown that bubbles up here.
 * Without the check that one keypress would both copy AND fold. (The mouse path is
 * already isolated by the copy box's `stopPropagation` on click.)
 */
function activateOnKey(activate: () => void) {
	return (event: ReactKeyboardEvent) => {
		if (event.target !== event.currentTarget) return;
		if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
		event.preventDefault();
		event.stopPropagation();
		activate();
	};
}

/** Render one side-car footnote at the measured geometry. */
export function RenderSidecar({ measured, onToggle, labels }: RenderSidecarProps) {
	const { payload, expanded, height, lines, extraRow, extraRowText, extraRowTop } = measured;
	const copyLabel = labels?.copy ?? "Copy injected content";
	const copiedLabel = labels?.copied ?? "Copied";
	const nameColor = toneColor(payload.tone);

	// A chevron is only meaningful when there is something the toggle would change:
	// a folded footnote with a body, or an `open` one whose body was capped (its
	// "show all" row is the reserved affordance). An `open` footnote showing
	// everything has no fold, so it advertises no control.
	const hasBody = (payload.lines?.length ?? 0) > 0;
	const foldable = hasBody && (payload.form === "folded" || expanded || extraRow === "showAll");
	const interactive = foldable && !!onToggle;

	return (
		<div style={{ position: "relative", height, boxSizing: "border-box" }}>
			{/* Header row — the whole row is the fold affordance. */}
			<Group
				gap={6}
				wrap="nowrap"
				align="center"
				role={interactive ? "button" : undefined}
				tabIndex={interactive ? 0 : undefined}
				aria-expanded={interactive ? expanded : undefined}
				aria-label={interactive ? payload.sourceLabel : undefined}
				style={{
					height: SIDECAR_HEADER_ROW,
					cursor: interactive ? "pointer" : undefined,
					userSelect: interactive ? "none" : undefined,
				}}
				onClick={interactive ? onToggle : undefined}
				onKeyDown={interactive && onToggle ? activateOnKey(onToggle) : undefined}
			>
				{/* The source name carries the tone. No badge, no icon: the name IS the
				    label, and a pill around it was pure weight. */}
				<Text size="xs" fw={500} c={nameColor} style={{ flexShrink: 0 }}>
					{payload.sourceLabel}
				</Text>
				{/* Headline: shown while the body is hidden (a folded footnote). An open
				    one draws its body instead, so repeating the first line above it would
				    be noise. Clamped to one line → height-neutral. */}
				{!expanded && payload.form === "folded" ? (
					<Text size="xs" c="dimmed" lineClamp={1} style={{ flex: 1, minWidth: 0 }}>
						{payload.headline}
					</Text>
				) : (
					<span style={{ flex: 1, minWidth: 0 }} />
				)}
				{/* Copy yields what the MODEL saw, not this projection. */}
				<Box onClick={(event) => event.stopPropagation()} style={{ flexShrink: 0 }}>
					<CopyButton value={payload.fullText} timeout={1500}>
						{({ copied, copy }) => (
							<Tooltip label={copied ? copiedLabel : copyLabel} withArrow>
								<ActionIcon
									variant="subtle"
									color={copied ? "green" : "gray"}
									size="xs"
									aria-label={copied ? copiedLabel : copyLabel}
									onClick={copy}
								>
									{copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
								</ActionIcon>
							</Tooltip>
						)}
					</CopyButton>
				</Box>
				{foldable ? (
					expanded ? (
						<IconChevronDown size={12} style={{ flexShrink: 0, color: DIMMED }} />
					) : (
						<IconChevronRight size={12} style={{ flexShrink: 0, color: DIMMED }} />
					)
				) : null}
			</Group>

			{/* Body lines — each drawn from the block the measure pass wrapped, at the
			    width IT used (a bullet's is narrower by its marker lane). */}
			{lines.map((line, index) => {
				const block = measured.blocks[1 + index] as PreparedCodeBlock | undefined;
				if (!block) return null;
				return (
					<SidecarBodyLine
						// biome-ignore lint/suspicious/noArrayIndexKey: body lines are a stable ordered list produced by the measure pass
						key={index}
						block={block}
						line={line}
					/>
				);
			})}

			{/* The reserved trailing row: either "show all N lines" (an open footnote hit
			    its inline default) or the truncation notice (the hard ceiling bit, and
			    copy holds the rest). Its height was reserved by the measure pass, so
			    painting it here cannot move anything. */}
			{extraRow !== "none" && extraRowText ? (
				<Text
					size="xs"
					c="dimmed"
					fs={extraRow === "truncated" ? "italic" : undefined}
					td={extraRow === "showAll" ? "underline" : undefined}
					lineClamp={1}
					role={extraRow === "showAll" && onToggle ? "button" : undefined}
					tabIndex={extraRow === "showAll" && onToggle ? 0 : undefined}
					onClick={extraRow === "showAll" ? onToggle : undefined}
					onKeyDown={extraRow === "showAll" && onToggle ? activateOnKey(onToggle) : undefined}
					style={{
						position: "absolute",
						top: extraRowTop,
						left: measured.lines[0]?.left ?? 0,
						height: SIDECAR_LINE_HEIGHT,
						cursor: extraRow === "showAll" && onToggle ? "pointer" : undefined,
					}}
				>
					{extraRowText}
				</Text>
			) : null}
		</div>
	);
}

/**
 * One body line: materialize the block's wrapped lines and paint each
 * absolutely-positioned with the measured font, inside the box the measure layer
 * reserved. `heading` lines take a slightly stronger weight; `meta` and `dimmed`
 * lines recede — all colour/weight only, so nothing moves.
 */
function SidecarBodyLine({ block, line }: { block: PreparedCodeBlock; line: MeasuredSidecarLine }) {
	const wrapped = useMemo(
		() => layoutWithLines(block.prepared, Math.max(1, line.width), block.lineHeight).lines,
		[block, line.width],
	);
	const visible = wrapped.length > line.lineCount ? wrapped.slice(0, line.lineCount) : wrapped;
	const color =
		line.kind === "heading"
			? "var(--mantine-color-text)"
			: line.dimmed || line.kind === "meta"
				? DIMMED
				: "var(--mantine-color-dimmed)";
	return (
		<div
			style={{
				position: "absolute",
				top: line.top,
				left: line.left,
				width: line.width,
				height: line.height,
				overflow: "hidden",
			}}
		>
			{/* A bullet's marker sits in the lane the measure layer reserved to the LEFT
			    of this box. `aria-hidden` + `userSelect: none` are load-bearing: the
			    selection-copy walker (vlist-copy-text) collects the whole subtree, so a
			    decorative glyph would otherwise be pasted into the reader's clipboard. */}
			{line.kind === "bullet" ? (
				<span
					aria-hidden
					style={{
						position: "absolute",
						left: -10,
						top: 0,
						height: block.lineHeight,
						font: FONT_XS,
						color: DIMMED,
						opacity: 0.6,
						userSelect: "none",
					}}
				>
					·
				</span>
			) : null}
			{visible.map((wrappedLine, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines are a stable ordered list
					key={i}
					style={{
						position: "absolute",
						top: i * block.lineHeight,
						left: 0,
						height: block.lineHeight,
						whiteSpace: "pre",
						// The EXACT font the measure pass wrapped with — parity keeps the
						// painted wrap identical to the predicted height.
						font: FONT_XS,
						fontWeight: line.kind === "heading" ? 500 : undefined,
						color,
					}}
				>
					{wrappedLine.text}
				</div>
			))}
		</div>
	);
}

export const RENDER_SIDECAR_CHROME = { SIDECAR_HEADER_ROW, SIDECAR_LINE_HEIGHT } as const;
