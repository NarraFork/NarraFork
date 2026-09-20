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
 *
 * `review_feedback` used to be one of these and is not any more: see the note where its
 * row used to be.
 */

import { Group, Loader, Paper, Text } from "@mantine/core";
import { IconAlertTriangle, IconArrowsMinimize, IconGitMerge, IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
	type CompactProgressLabels,
	formatCompactProgressText,
	useCompactProgress,
} from "../compact-progress-store";
import {
	CARD_PADDING,
	CENTER_ROW_PADDING_Y,
	type SystemSimpleData,
} from "../measure/measure-system-simple";
import type { MeasuredElement, PreparedFixedBlock } from "../prepared-block";
import type { VListViewControls } from "../VListContentViewHost";
import type { VListViewOwner } from "../vlist-content-view-target";
import { activateOnKey, swallowSelectionClick } from "./key-activate";

/** The single-line kinds this renderer knows how to draw. */
export type SystemSimpleKind = PreparedFixedBlock["tag"];

interface RenderSystemSimpleProps {
	measured: MeasuredElement;
	/**
	 * Optional avatar slot for merge_summary (the real UserAvatar lives outside
	 * vlist/, so callers may inject it; otherwise a neutral placeholder is drawn).
	 */
	avatarSlot?: React.ReactNode;
	/** Fullscreen snapshots belong to the list, which outlives virtual rows. */
	viewControls?: VListViewControls;
	viewOwner?: VListViewOwner;
	/**
	 * Open the compact / segment-compact summary for this marker. Injected by the
	 * integration layer (the modal + API live outside vlist/); absent → the row is
	 * inert, exactly like a marker whose narrator/message ids are unknown.
	 */
	onOpenCompact?: () => void;
	/**
	 * Abort the compaction this marker is currently running. Present ONLY while
	 * `status === "compacting"` and only for the context flavour, mirroring the
	 * chunked CompactIndicator (whose cancel affordance is the marker itself).
	 */
	onCancelCompact?: () => void;
	/** Localized `title` for the cancel affordance (native tooltip). */
	cancelCompactTitle?: string;
	/** Source message identity for repainting compact progress without relayout. */
	compactProgressMessageId?: string;
	/** Whether the source marker is a selected-message segment compact. */
	compactProgressIsSegment?: boolean;
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
export function RenderSystemSimple({
	measured,
	avatarSlot,
	viewControls,
	viewOwner,
	onOpenCompact,
	onCancelCompact,
	cancelCompactTitle,
	compactProgressMessageId,
	compactProgressIsSegment,
}: RenderSystemSimpleProps) {
	const block = measured.blocks[0] as PreparedFixedBlock | undefined;
	if (!block || block.kind !== "fixed") return null;
	const kind = block.tag;
	const data = (block.data ?? {}) as unknown as SystemSimpleData;
	const height = measured.height;

	switch (kind) {
		case "publication_result":
			return (
				<PublicationResultRow
					data={data}
					height={height}
					viewControls={viewControls}
					viewOwner={viewOwner}
				/>
			);
		case "compact":
			return (
				<CompactRow
					data={data}
					height={height}
					palette="orange"
					onOpen={onOpenCompact}
					onCancel={onCancelCompact}
					cancelTitle={cancelCompactTitle}
					messageId={compactProgressMessageId}
					isSegment={compactProgressIsSegment ?? false}
				/>
			);
		case "segment_compact":
			return (
				<CompactRow
					data={data}
					height={height}
					palette="teal"
					onOpen={onOpenCompact}
					messageId={compactProgressMessageId}
					isSegment
				/>
			);
		case "merge_summary":
			return <MergeSummaryRow data={data} height={height} avatarSlot={avatarSlot} />;
		default:
			return null;
	}
}

function PublicationResultRow({
	data,
	height,
	viewControls,
	viewOwner,
}: {
	data: SystemSimpleData;
	height: number;
	viewControls?: VListViewControls;
	viewOwner?: VListViewOwner;
}) {
	const { t } = useTranslation("narrator");
	const open = () =>
		viewControls?.openFullscreen({
			id: data.messageId ?? "publication-result",
			slot: "body",
			owner: viewOwner ?? { specKey: data.messageId ?? "publication-result" },
			kind: "markdown",
			title: t("publicationResultTitle"),
			// Receipt truncation is permanent, not a lazy payload-fetch signal.
			text: data.publicationResult?.truncated
				? `${t("publicationResultTruncated")}\n\n${data.snapshotText ?? ""}`
				: (data.snapshotText ?? ""),
		});
	return (
		<button
			type="button"
			disabled={!viewControls}
			onClick={swallowSelectionClick(open)}
			onKeyDown={activateOnKey(open)}
			style={{
				height,
				width: "100%",
				display: "block",
				boxSizing: "border-box",
				padding: "4px 8px",
				border: 0,
				borderRadius: 4,
				background: "var(--mantine-color-default)",
				color: "var(--mantine-color-dimmed)",
				font: "inherit",
				fontSize: "var(--mantine-font-size-xs)",
				whiteSpace: "nowrap",
				overflow: "hidden",
				textOverflow: "ellipsis",
				cursor: "pointer",
			}}
		>
			{t("publicationResultOpen")}
		</button>
	);
}

// ── compact / segment_compact: centered single line, py={4} ──────────────────
/**
 * The compact marker row.
 *
 * Interaction parity with the chunked CompactIndicator / SegmentCompactIndicator:
 * the WHOLE row is the affordance. A finished (or failed) marker opens the summary
 * modal; a RUNNING context compact instead asks to cancel, and grows a trailing
 * ✕ glyph. Both live inside the row's constant height — the ✕ is 12px inside a
 * 17px line box and the underline is decoration only — so no interaction here can
 * move the measured geometry (measure-system-simple's COMPACT_CARD_HEIGHT).
 */
function CompactRow({
	data,
	height,
	palette,
	onOpen,
	onCancel,
	cancelTitle,
	messageId,
	isSegment = false,
}: {
	data: SystemSimpleData;
	height: number;
	/** Base colour family for this compact flavour (compact=orange, segment=teal). */
	palette: string;
	onOpen?: () => void;
	onCancel?: () => void;
	cancelTitle?: string;
	messageId?: string;
	isSegment?: boolean;
}) {
	const status = data.status ?? "compacted";
	const liveProgress = useCompactProgress(messageId, isSegment);
	const liveText =
		status === "compacting" && liveProgress && data.compactLabels
			? formatCompactProgressText(
					data.compactLabels as CompactProgressLabels,
					liveProgress,
					isSegment,
				)
			: data.text;
	const isCompacting = status === "compacting";
	const isFailed = status === "failed";
	// failed only occurs for the context compact flavour; text turns red.
	const color = data.color ?? (isFailed ? "red" : palette);
	// While compacting the row cancels; otherwise it opens the summary. Never both
	// (a running compact has no summary to show yet), matching the chunked card.
	const canCancel = isCompacting && typeof onCancel === "function";
	const canOpen = !isCompacting && typeof onOpen === "function";
	const onClick = canCancel ? onCancel : canOpen ? onOpen : undefined;
	const interactive = data.interactive === true || canCancel || canOpen;
	// An actionable marker becomes a real button for assistive tech and keyboard
	// users (the chunked card only bound a mouse click). An INERT marker keeps its
	// plain-div identity so it never enters the tab order. `role`/`tabIndex`/focus
	// outline are all height-neutral, so the constant row geometry is unaffected.
	const actionProps = onClick
		? {
				role: "button" as const,
				tabIndex: 0,
				onClick,
				onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
					if (event.key !== "Enter" && event.key !== " ") return;
					event.preventDefault();
					onClick();
				},
			}
		: {};

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
				cursor: onClick ? "pointer" : undefined,
			}}
			{...actionProps}
			title={canCancel ? cancelTitle : undefined}
			data-compact-status={status}
			{...(canCancel ? { "data-compact-cancel": "1" } : {})}
			{...(canOpen ? { "data-compact-open": "1" } : {})}
		>
			{isCompacting ? (
				<Loader size={14} color={palette} />
			) : isFailed ? (
				<IconAlertTriangle size={14} style={{ color: cssColor("red", 6), flexShrink: 0 }} />
			) : (
				<IconArrowsMinimize size={14} style={{ color: cssColor(palette, 6), flexShrink: 0 }} />
			)}
			<Text size="xs" c={color} td={interactive ? "underline" : undefined} lineClamp={1}>
				{liveText}
			</Text>
			{canCancel ? (
				<IconX size={12} style={{ color: cssColor(palette, 6), flexShrink: 0 }} />
			) : null}
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

// ── review_feedback ──────────────────────────────────────────────────────────
// Removed: a verdict plus a findings list needs a wrapping body and an action row, so
// the card became a `system-text` one (see RenderSystemText's ReviewFeedbackCard). The
// clamped single line here could show neither.

// ── spec_continuation / spec_blocked_continuation ────────────────────────────
// Removed: the framed bubble now draws these as a task row itself (RenderSpecTask)
// instead of nesting this full-width clamped band. The bubble path owns the row.

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
