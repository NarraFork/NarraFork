/**
 * RenderReflectionNotice.tsx — Render copy of ToolCallCard's `ReflectionNotice`
 * (visual parity target: ToolCallCard.tsx:1684). Pairs with
 * measure-reflection-notice.ts.
 *
 * WHY A COPY RATHER THAN THE REAL COMPONENT
 *
 * The exact vlist originally MOUNTED the real `ReflectionNotice` through the
 * permission bridge and corrected the row height after paint. That made every
 * reflection row a dynamic row: it settled one frame late and shifted everything
 * below it while the reader was only scrolling. The notice is fully predictable,
 * so it belongs on the measured path like every other card region.
 *
 * The only behaviour the real component owns is the manual-takeover button, which
 * calls `api.stopXReflection` itself. That is injected here as an `onTakeOver`
 * callback so the interactive part stays outside vlist/ while the geometry stays
 * inside it. The button's row is measured only when it paints (running gates), so
 * a resolved notice ends right below its last text line.
 *
 * Layout: absolutely-positioned rows at the geometry the measure layer computed,
 * each fragment painted with the exact `font` string it was measured with. Zero
 * DOM measurement.
 */

import {
	materializeRichInlineLineRange,
	walkRichInlineLineRanges,
} from "@chenglou/pretext/rich-inline";
import { Button, ThemeIcon } from "@mantine/core";
import { shouldShowThinkingChars } from "@shared/progress-phase";
import {
	IconBan,
	IconCheck,
	IconLoader2,
	IconPlayerStop,
	IconShield,
	IconX,
} from "@tabler/icons-react";
import { useMemo } from "react";
import { useReflectionProgress } from "../../reflection-progress-store";
import {
	type MeasuredReflectionNotice,
	NOTICE_BODY_FONT,
	NOTICE_BORDER,
	NOTICE_BUTTON_HEIGHT,
	NOTICE_ICON_SIZE,
	NOTICE_PADDING,
	type ReflectionBlockMeta,
} from "../measure/measure-reflection-notice";
import type { PreparedInlineBlock } from "../prepared-block";
import { RADIUS } from "../pretext-fonts";

export interface ReflectionNoticeLabels {
	/** Manual-takeover button label. */
	takeOver?: string;
	/** Bare thinking-phase label (used below the char display threshold). */
	thinking?: string;
	/** Thinking-phase label with a count; `{{count}}` interpolated by the caller. */
	thinkingChars?: (chars: number) => string;
	/** Output-phase char count label. */
	outputChars?: (chars: number) => string;
}

const DEFAULT_LABELS: Required<Pick<ReflectionNoticeLabels, "takeOver">> = {
	takeOver: "Take over",
};

/**
 * Status/kind → icon, mirroring the original component's chain.
 *
 * A running gate shows a SHIELD rather than a spinner: a spinner says "wait, nothing for
 * you here", while the whole point of a gate is that the user MAY step in. The shield is
 * the same shape this state carries in the sidebar, so the surfaces agree.
 */
function noticeIcon(status: string | undefined) {
	if (status === "running") return <IconShield size={14} />;
	if (status === "confirmed") return <IconCheck size={14} />;
	if (status === "cancelled") return <IconX size={14} />;
	if (status === "aborted") return <IconBan size={14} />;
	return <IconShield size={14} />;
}

/**
 * Status → ThemeIcon colour, mirroring the original component.
 *
 * A running gate is ORANGE, grouping it with the states the user can act on: the gate can
 * be approved, rejected or taken over by hand, so it is genuinely interactive. Its SHIELD
 * shape (see the icon picker above) is what distinguishes it from a plain permission
 * prompt — colour groups by "what is asked of the reader", shape carries identity. The
 * palette had no free hue left to do both; see `StatusShape` in status-registry.
 */
function iconColor(status: string | undefined): string {
	if (status === "running") return "orange";
	if (status === "confirmed") return "green";
	if (status === "cancelled") return "red";
	if (status === "aborted") return "orange";
	return "gray";
}

interface RenderedLine {
	fragments: Array<{ text: string; font: string; className: string; gapBefore: number }>;
}

/** Re-derive each wrapped line from the measured flow (same math as measurement). */
function useInlineLines(
	block: PreparedInlineBlock | undefined,
	availableWidth: number,
): RenderedLine[] {
	return useMemo(() => {
		if (!block || block.kind !== "inline") return [];
		const out: RenderedLine[] = [];
		walkRichInlineLineRanges(block.flow, Math.max(1, availableWidth), (range) => {
			const line = materializeRichInlineLineRange(block.flow, range);
			out.push({
				fragments: line.fragments.map((f) => ({
					text: f.text,
					font: block.fonts[f.itemIndex] ?? "",
					className: block.classNames[f.itemIndex] ?? "",
					gapBefore: f.gapBefore,
				})),
			});
		});
		return out;
	}, [block, availableWidth]);
}

function InlineRow({
	block,
	top,
	height,
	availableWidth,
	color,
}: {
	block: PreparedInlineBlock;
	top: number;
	height: number;
	availableWidth: number;
	color: string;
}) {
	const lines = useInlineLines(block, availableWidth);
	return (
		<div
			style={{
				position: "absolute",
				top,
				left: block.contentLeft,
				width: availableWidth,
				height,
			}}
		>
			{lines.map((line, lineIndex) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: lines are a stable ordered list
					key={lineIndex}
					style={{
						position: "absolute",
						left: 0,
						top: lineIndex * block.lineHeight,
						height: block.lineHeight,
						display: "flex",
						alignItems: "center",
						width: "max-content",
					}}
				>
					{line.fragments.map((frag, fi) => (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: fragments are a stable ordered list
							key={fi}
							className={frag.className}
							style={{
								font: frag.font,
								marginLeft: frag.gapBefore,
								whiteSpace: "pre",
								display: "inline-block",
								color,
							}}
						>
							{frag.text}
						</span>
					))}
				</div>
			))}
		</div>
	);
}

/**
 * Live "thinking · N chars" / "N chars" text for a running gate.
 *
 * Reads the render-only progress store directly (never the measured data), so a
 * tick arriving several times a second re-renders one text node and cannot reach
 * the height model. Same escape hatch as `ElapsedTimer` in RenderToolCall.
 */
function ReflectionProgressText({
	requestId,
	labels,
	color,
}: {
	requestId: string | undefined;
	labels?: ReflectionNoticeLabels;
	color: string;
}) {
	const progress = useReflectionProgress(requestId);
	if (!progress) return null;
	const text =
		progress.phase === "output"
			? labels?.outputChars?.(progress.outputChars)
			: shouldShowThinkingChars(progress.thinkingChars)
				? labels?.thinkingChars?.(progress.thinkingChars)
				: labels?.thinking;
	if (!text) return null;
	return (
		<span
			style={{
				font: NOTICE_BODY_FONT,
				color,
				whiteSpace: "nowrap",
				overflow: "hidden",
				textOverflow: "ellipsis",
				minWidth: 0,
			}}
		>
			{text}
		</span>
	);
}

interface RenderReflectionNoticeProps {
	measured: MeasuredReflectionNotice;
	labels?: ReflectionNoticeLabels;
	/** Include the owner's top margin (the tool card's region gap). */
	includeTopMargin?: boolean;
	/**
	 * Manual takeover (stop the reflection and decide yourself). Supplied by the
	 * integration layer; the button is only PAINTED for a running gate.
	 */
	onTakeOver?: () => void;
	/** Whether the takeover request is in flight (button shows a loader). */
	takingOver?: boolean;
}

export function RenderReflectionNotice({
	measured,
	labels,
	includeTopMargin = false,
	onTakeOver,
	takingOver = false,
}: RenderReflectionNoticeProps) {
	const merged = { ...DEFAULT_LABELS, ...labels };
	const { blocks, frame, contentWidth, metas, status, height, topMargin } = measured;
	const running = status === "running";

	// Tinted ORANGE while the gate runs, neutral once resolved. See `iconColor` above for
	// why orange — the state is interactive, so it belongs with the attention family.
	const background = running
		? "light-dark(color-mix(in srgb, var(--mantine-color-orange-0) 88%, white), color-mix(in srgb, var(--mantine-color-orange-9) 34%, transparent))"
		: "light-dark(color-mix(in srgb, var(--mantine-color-gray-0) 88%, white), color-mix(in srgb, var(--mantine-color-dark-5) 52%, transparent))";
	const borderColor = running
		? "light-dark(var(--mantine-color-orange-3), color-mix(in srgb, var(--mantine-color-orange-6) 45%, transparent))"
		: "var(--mantine-color-default-border)";
	const titleColor = running
		? "light-dark(var(--mantine-color-orange-9), var(--mantine-color-orange-2))"
		: "var(--mantine-color-text)";
	const bodyColor = running
		? "light-dark(var(--mantine-color-orange-9), var(--mantine-color-orange-1))"
		: "var(--mantine-color-dimmed)";

	const colorFor = (meta: ReflectionBlockMeta | undefined): string =>
		meta?.role === "title" ? titleColor : bodyColor;

	return (
		<div
			style={{
				position: "relative",
				boxSizing: "border-box",
				height,
				...(includeTopMargin ? { marginTop: topMargin } : {}),
				padding: NOTICE_PADDING,
				border: `${NOTICE_BORDER}px solid ${borderColor}`,
				borderRadius: RADIUS.sm,
				background,
			}}
		>
			{/* Fixed icon column (mt={1} matches the original's optical alignment). */}
			<div style={{ position: "absolute", top: NOTICE_PADDING + 1, left: NOTICE_PADDING }}>
				<ThemeIcon size="sm" radius="sm" color={iconColor(status)} variant="light">
					{noticeIcon(status)}
				</ThemeIcon>
			</div>
			<div style={{ position: "relative", width: "100%", height: "100%" }}>
				{blocks.map((block, index) => {
					const blockFrame = frame.blocks[index];
					if (!blockFrame) return null;
					const meta = metas[index];
					if (block.kind === "inline") {
						return (
							<InlineRow
								// biome-ignore lint/suspicious/noArrayIndexKey: blocks are a stable ordered list
								key={index}
								block={block}
								top={blockFrame.top}
								height={blockFrame.height}
								availableWidth={contentWidth}
								color={colorFor(meta)}
							/>
						);
					}
					// The takeover row exists only while the gate is running — the measure
					// pass emits this block exactly when the button paints, so there is no
					// reserved-but-empty variant to skip here.
					if (meta?.role === "take-over") {
						return (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: blocks are a stable ordered list
								key={index}
								style={{
									position: "absolute",
									top: blockFrame.top,
									left: block.contentLeft,
									// The row spans the content box so the live progress text can sit
									// beside the button; its own height stays the measured constant.
									width: contentWidth,
									height: NOTICE_BUTTON_HEIGHT,
									display: "flex",
									alignItems: "center",
									gap: 8,
									minWidth: 0,
								}}
							>
								<Button
									size="xs"
									variant="light"
									color="orange"
									leftSection={<IconPlayerStop size={12} />}
									loading={takingOver}
									style={{ flexShrink: 0 }}
									onClick={(event) => {
										event.stopPropagation();
										onTakeOver?.();
									}}
								>
									{merged.takeOver}
								</Button>
								{/* Live progress. Deliberately painted in this FIXED row rather
								    than appended to the measured title: the title is a wrapping
								    inline flow, so trailing text would overlap its last line at
								    narrow widths. Here it is clipped with an ellipsis instead,
								    and the row height is a constant the measure pass reserved. */}
								<ReflectionProgressText
									requestId={measured.requestId}
									labels={labels}
									color={bodyColor}
								/>
							</div>
						);
					}
					return null;
				})}
			</div>
		</div>
	);
}

/** Left inset of the icon column, exported for harness/debug alignment checks. */
export const REFLECTION_ICON_COLUMN_WIDTH = NOTICE_ICON_SIZE;
