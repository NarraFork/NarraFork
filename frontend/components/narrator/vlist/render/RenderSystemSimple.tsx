/**
 * RenderSystemSimple.tsx — Render copies of the fixed-height single-line system
 * cards measured by measure-system-simple.ts (batch-2 P4).
 *
 * Every card is ONE clamped line, so there is no inline/code materialization: the
 * root box is a fixed-height container (height === measured.height) and the single
 * row is laid out with flex. Visuals mirror the original MessageBubble cards
 * (CompactIndicator / SegmentCompactIndicator / MergeSummaryCard /
 * ReviewFeedbackCard / spec_continuation branch) using Mantine primitives +
 * @tabler icons — WITHOUT importing anything outside vlist/.
 *
 * Zero DOM measurement (heights come from the measure layer).
 */

import { Badge, Group, Loader, Paper, Text } from "@mantine/core";
import {
	IconAlertTriangle,
	IconArrowsMinimize,
	IconEyeCheck,
	IconGitMerge,
	IconLock,
} from "@tabler/icons-react";
import {
	CARD_PADDING,
	CENTER_ROW_PADDING_Y,
	type SystemSimpleData,
} from "../measure/measure-system-simple";
import type { MeasuredElement, PreparedFixedBlock } from "../prepared-block";

/** The single-line kinds this renderer knows how to draw. */
export type SystemSimpleKind = PreparedFixedBlock["tag"];

interface RenderSystemSimpleProps {
	measured: MeasuredElement;
	/**
	 * Optional avatar slot for merge_summary (the real UserAvatar lives outside
	 * vlist/, so callers may inject it; otherwise a neutral placeholder is drawn).
	 */
	avatarSlot?: React.ReactNode;
}

function cssColor(color: string, shade: number): string {
	return `var(--mantine-color-${color}-${shade})`;
}

function cssLight(color: string): string {
	return `var(--mantine-color-${color}-light)`;
}

/**
 * Render a fixed-height single-line system card from its MeasuredElement.
 * Dispatches on the prepared block's `tag` (the SystemSimpleKind).
 */
export function RenderSystemSimple({ measured, avatarSlot }: RenderSystemSimpleProps) {
	const block = measured.blocks[0] as PreparedFixedBlock | undefined;
	if (!block || block.kind !== "fixed") return null;
	const kind = block.tag;
	const data = (block.data ?? {}) as unknown as SystemSimpleData;
	const height = measured.height;

	switch (kind) {
		case "compact":
			return <CompactRow data={data} height={height} palette="orange" />;
		case "segment_compact":
			return <CompactRow data={data} height={height} palette="teal" />;
		case "merge_summary":
			return <MergeSummaryRow data={data} height={height} avatarSlot={avatarSlot} />;
		case "review_feedback":
			return <ReviewFeedbackRow data={data} height={height} />;
		case "spec_continuation":
		case "spec_blocked_continuation":
			return <SpecContinuationRow data={data} height={height} kind={kind} />;
		default:
			return null;
	}
}

// ── compact / segment_compact: centered single line, py={4} ──────────────────
function CompactRow({
	data,
	height,
	palette,
}: {
	data: SystemSimpleData;
	height: number;
	/** Base colour family for this compact flavour (compact=orange, segment=teal). */
	palette: string;
}) {
	const status = data.status ?? "compacted";
	const isCompacting = status === "compacting";
	const isFailed = status === "failed";
	// failed only occurs for the context compact flavour; text turns red.
	const color = data.color ?? (isFailed ? "red" : palette);

	return (
		<div
			style={{
				display: "flex",
				justifyContent: "center",
				alignItems: "center",
				gap: 6,
				height,
				paddingTop: CENTER_ROW_PADDING_Y,
				paddingBottom: CENTER_ROW_PADDING_Y,
				boxSizing: "border-box",
			}}
		>
			{isCompacting ? (
				<Loader size={14} color={palette} />
			) : isFailed ? (
				<IconAlertTriangle size={14} style={{ color: cssColor("red", 6), flexShrink: 0 }} />
			) : (
				<IconArrowsMinimize size={14} style={{ color: cssColor(palette, 6), flexShrink: 0 }} />
			)}
			<Text size="xs" c={color} td={data.interactive ? "underline" : undefined} lineClamp={1}>
				{data.text}
			</Text>
		</div>
	);
}

// ── merge_summary: Paper p="xs" + single lineClamp={1} row ───────────────────
function MergeSummaryRow({
	data,
	height,
	avatarSlot,
}: {
	data: SystemSimpleData;
	height: number;
	avatarSlot?: React.ReactNode;
}) {
	const color = data.color ?? "indigo";
	return (
		<Paper
			p="xs"
			radius="sm"
			style={{ backgroundColor: cssLight(color), height, boxSizing: "border-box" }}
		>
			<Group gap={6} wrap="nowrap" h="100%" align="center">
				{data.hasAvatar ? (avatarSlot ?? <AvatarPlaceholder />) : null}
				<IconGitMerge size={16} style={{ flexShrink: 0, color: cssColor(color, 6) }} />
				<Text size="xs" c={color} lineClamp={1}>
					{data.text}
				</Text>
			</Group>
		</Paper>
	);
}

// ── review_feedback: Paper p="xs" + single lineClamp={1} row ─────────────────
function ReviewFeedbackRow({ data, height }: { data: SystemSimpleData; height: number }) {
	const color = data.color ?? "gray";
	return (
		<Paper
			p="xs"
			radius="sm"
			style={{ backgroundColor: cssLight(color), height, boxSizing: "border-box" }}
		>
			<Group gap={6} wrap="nowrap" h="100%" align="center">
				<IconEyeCheck size={16} style={{ flexShrink: 0, color: cssColor(color, 6) }} />
				<Text size="xs" c={color} lineClamp={1}>
					{data.text}
				</Text>
			</Group>
		</Paper>
	);
}

// ── spec_continuation / spec_blocked_continuation: Paper p="xs" + truncate ───
function SpecContinuationRow({
	data,
	height,
	kind,
}: {
	data: SystemSimpleData;
	height: number;
	kind: "spec_continuation" | "spec_blocked_continuation";
}) {
	const color = data.color ?? (kind === "spec_blocked_continuation" ? "orange" : "indigo");
	return (
		<Paper
			p="xs"
			radius="sm"
			style={{ backgroundColor: cssLight(color), height, boxSizing: "border-box" }}
		>
			<Group gap="xs" wrap="nowrap" h="100%" align="center">
				{data.badgeLabel ? (
					<Badge size="xs" color={color} variant="light">
						{data.badgeLabel}
					</Badge>
				) : null}
				{data.protected ? (
					<Badge size="xs" color="yellow" variant="light" leftSection={<IconLock size={10} />}>
						{"\u{1F512}"}
					</Badge>
				) : null}
				<Text size="xs" c={color} truncate style={{ flex: 1 }}>
					{data.text}
				</Text>
			</Group>
		</Paper>
	);
}

/** Neutral 16px avatar placeholder (real UserAvatar lives outside vlist/). */
function AvatarPlaceholder() {
	return (
		<div
			style={{
				width: 16,
				height: 16,
				borderRadius: "50%",
				flexShrink: 0,
				background: "var(--mantine-color-gray-5)",
			}}
		/>
	);
}

export const RENDER_SYSTEM_SIMPLE_CHROME = { CARD_PADDING, CENTER_ROW_PADDING_Y } as const;
