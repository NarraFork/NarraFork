/**
 * RenderSidecar.tsx — Render copy for one system-injection (sidecar) card,
 * measured by measure-sidecar.ts.
 *
 * This is the vlist REDESIGN of the chunked aggregate SideCarNotice: EVERY record
 * is its own collapsible card (the product decision), so there is no "×N" header
 * and no shared fold — each card carries its own chevron + fold state.
 *
 * Geometry pairs with the measure layer exactly:
 *   collapsed : Paper p="xs" + one header row (accent rail + icon + source badge
 *               + target badge + clamped preview + chevron + copy). Constant
 *               height; the preview is truncated to a single line.
 *   expanded  : the same header row + the full body, materialized line-by-line
 *               from the SAME PreparedCodeBlock the measure pass wrapped (exact
 *               font, exact width — zero drift, zero DOM measurement), plus a
 *               truncation notice row when the measure pass clipped the body at
 *               its line cap (that row's height is RESERVED by the measure layer;
 *               see measure-sidecar's SIDECAR_TRUNCATION_NOTICE_*).
 *
 * The copy button and the fold toggle are the only interactions. The toggle is
 * injected (`onToggle`) and lives on the header row, which is keyboard-operable
 * (role/tabIndex/Enter-Space) — attributes only, so the measured geometry holds.
 * Copy is a local clipboard write with a transient check. Both are height-neutral
 * (they sit inside the fixed header row). No bridge/target module is needed because
 * a sidecar carries no app-level mutation or route.
 */

import { layoutWithLines } from "@chenglou/pretext";
import { ActionIcon, Badge, Box, CopyButton, Group, Paper, Text, Tooltip } from "@mantine/core";
import {
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconCopy,
	IconInfoCircle,
} from "@tabler/icons-react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useMemo } from "react";
import {
	type MeasuredSidecar,
	SIDECAR_CARD_PADDING,
	SIDECAR_HEADER_BODY_GAP,
	SIDECAR_HEADER_ROW,
	SIDECAR_TRUNCATION_NOTICE_GAP,
	SIDECAR_TRUNCATION_NOTICE_HEIGHT,
} from "../measure/measure-sidecar";
import type { PreparedCodeBlock } from "../prepared-block";
import { FONT_XS } from "../pretext-fonts";

function cssColor(color: string, shade: number): string {
	return `var(--mantine-color-${color}-${shade})`;
}

function cssLight(color: string): string {
	return `var(--mantine-color-${color}-light)`;
}

export interface RenderSidecarProps {
	measured: MeasuredSidecar;
	/** Fold toggle (injected by the shell). Absent → the card renders inert. */
	onToggle?: () => void;
	/** Localized chrome (copy tooltip etc.). Optional; English fallbacks inside. */
	labels?: { copy?: string; copied?: string };
}

/**
 * Enter / Space activation for the header row, whose only affordance is a click
 * handler on a `Group` (a div). Same helper shape RenderToolRun uses for its trace
 * folds: attributes and handlers only, so the measured geometry is untouched.
 *
 * Space is `preventDefault`ed because its default action on a focused element is to
 * scroll — which in a virtual list moves the very card being read.
 *
 * The `target !== currentTarget` bail-out is what keeps the header from becoming a
 * nested-interactive trap: the copy control inside it is a real focusable button, so
 * a keyboard user pressing Enter on IT produces a keydown that bubbles up here.
 * Without the check that one keypress would both copy AND fold the card. (The mouse
 * path is already isolated by the copy box's `stopPropagation` on click.)
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

/**
 * Render one sidecar card at the measured geometry. The outer box height equals
 * `measured.height`; the expanded body is the pretext-measured code block.
 */
export function RenderSidecar({ measured, onToggle, labels }: RenderSidecarProps) {
	const { payload, expanded, bodyHeight, bodyWidth, height, bodyTruncated, noticeText } = measured;
	const color = payload.color ?? "gray";
	const copyLabel = labels?.copy ?? "Copy sidecar content";
	const copiedLabel = labels?.copied ?? "Copied";

	const bodyBlock = expanded ? (measured.blocks[1] as PreparedCodeBlock | undefined) : undefined;

	return (
		<Paper
			p="xs"
			radius="sm"
			style={{
				backgroundColor: cssLight(color),
				borderLeft: `2px solid ${cssColor(color, 5)}`,
				height,
				boxSizing: "border-box",
			}}
		>
			{/* Header row — the whole row is the fold affordance (chunked parity: the
			    aggregate notice toggled on row click). */}
			<Group
				gap={6}
				wrap="nowrap"
				align="center"
				// Keyboard-operable fold: the row is a div, so it needs the role, a tab
				// stop and Enter/Space explicitly. All attributes — the measured geometry
				// is unchanged. Only declared when a toggle exists, so an inert card does
				// not advertise a control that does nothing.
				role={onToggle ? "button" : undefined}
				tabIndex={onToggle ? 0 : undefined}
				aria-expanded={onToggle ? expanded : undefined}
				aria-label={onToggle ? payload.sourceLabel : undefined}
				style={{
					height: SIDECAR_HEADER_ROW,
					cursor: onToggle ? "pointer" : undefined,
					userSelect: onToggle ? "none" : undefined,
				}}
				onClick={onToggle}
				onKeyDown={onToggle ? activateOnKey(onToggle) : undefined}
			>
				<IconInfoCircle
					size={14}
					style={{ flexShrink: 0, color: cssColor(color, 7) }}
					aria-hidden
				/>
				<Badge size="xs" variant="light" color={color} style={{ flexShrink: 0 }}>
					{payload.sourceLabel}
				</Badge>
				<Badge size="xs" variant="outline" color="gray" style={{ flexShrink: 0 }}>
					{payload.target}
				</Badge>
				{/* Collapsed preview: single clamped line (height-neutral — the row is
				    fixed). Hidden when expanded (the body below carries the full text). */}
				{!expanded ? (
					<Text size="xs" c="dimmed" lineClamp={1} style={{ flex: 1, minWidth: 0 }}>
						{payload.previewText}
					</Text>
				) : (
					<span style={{ flex: 1, minWidth: 0 }} />
				)}
				{/* Copy is the only content action; it never moves the geometry. */}
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
									{copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
								</ActionIcon>
							</Tooltip>
						)}
					</CopyButton>
				</Box>
				{expanded ? (
					<IconChevronDown size={13} style={{ flexShrink: 0, color: cssColor(color, 7) }} />
				) : (
					<IconChevronRight size={13} style={{ flexShrink: 0, color: cssColor(color, 7) }} />
				)}
			</Group>

			{/* Expanded body — pretext-measured lines, painted with the exact font the
			    measure pass used, at the reserved body height (cap already applied). */}
			{expanded && bodyBlock ? (
				<div style={{ marginTop: SIDECAR_HEADER_BODY_GAP }}>
					<SidecarBody block={bodyBlock} width={bodyWidth} height={bodyHeight} />
				</div>
			) : null}

			{/* Line cap reached — say so. The body lane is a fixed-height clipped box
			    with no scrollbar, so without this the text just stops and the reader
			    cannot tell whether that was the end. The row's height was reserved by
			    the measure pass (SIDECAR_TRUNCATION_NOTICE_*), so drawing it here does
			    not move anything. */}
			{expanded && bodyTruncated && noticeText ? (
				<Text
					size="xs"
					c="dimmed"
					fs="italic"
					lineClamp={1}
					style={{
						marginTop: SIDECAR_TRUNCATION_NOTICE_GAP,
						height: SIDECAR_TRUNCATION_NOTICE_HEIGHT,
						width: bodyWidth,
					}}
				>
					{noticeText}
				</Text>
			) : null}
		</Paper>
	);
}

/**
 * The expanded body: materialize the PreparedCodeBlock's wrapped lines and paint
 * each absolutely-positioned with the measured font. The box is width×height the
 * measure layer reserved, so the painted wrap matches the predicted height.
 */
function SidecarBody({
	block,
	width,
	height,
}: {
	block: PreparedCodeBlock;
	width: number;
	height: number;
}) {
	const lines = useMemo(
		() => layoutWithLines(block.prepared, Math.max(1, width), block.lineHeight).lines,
		[block, width],
	);
	// Clamp to the measured line budget (the measure pass capped at
	// SIDECAR_DETAIL_MAX_LINES); the fixed-height box hides any overflow anyway.
	const maxLines = Math.max(1, Math.floor(height / block.lineHeight));
	const visible = lines.length > maxLines ? lines.slice(0, maxLines) : lines;
	return (
		<div style={{ position: "relative", width, height, overflow: "hidden" }}>
			{visible.map((line, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: body lines are a stable ordered list
					key={i}
					style={{
						position: "absolute",
						top: i * block.lineHeight,
						left: 0,
						height: block.lineHeight,
						whiteSpace: "pre",
						// The EXACT font the measure pass wrapped with (FONT_XS) — parity
						// keeps the painted wrap identical to the predicted height.
						font: FONT_XS,
						color: "var(--mantine-color-dimmed)",
					}}
				>
					{line.text}
				</div>
			))}
		</div>
	);
}

export const RENDER_SIDECAR_CHROME = { SIDECAR_CARD_PADDING, SIDECAR_HEADER_ROW } as const;
