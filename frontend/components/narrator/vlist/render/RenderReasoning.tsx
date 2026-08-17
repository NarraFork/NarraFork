/**
 * RenderReasoning.tsx — Render copy for the reasoning/thinking block.
 *
 * Pairs with measure-reasoning.ts. Draws the exact form the measure layer chose
 * (streaming / count / collapsed / expanded) at the predicted geometry, with
 * zero DOM measurement for ordinary text. Visual parity target: MessageBubble.tsx
 * ReasoningBlock + ReasoningCountLine.
 *
 *   - streaming : dimmed italic "thinking…" row (chevron + brain icon + text).
 *   - count     : ReasoningCountLine — brain badge + "reasoning" + "N steps".
 *   - collapsed : header row — chevron + brain badge + "reasoning" + char count
 *                 + a truncated 80-char preview.
 *   - expanded  : header row + a left-bordered body that renders the markdown
 *                 via RenderMarkdown (measured at sm — see measure note), plus
 *                 an optional translation-toggle row.
 *
 * Rebuilt to match measure-reasoning form geometry. Body markdown uses
 * RenderMarkdown with the same fonts the measure layer used.
 */

import { formatLocaleNumber } from "@frontend/lib/intl-format";
import { Box, Group, Text, ThemeIcon } from "@mantine/core";
import { IconBrain, IconChevronDown, IconChevronRight, IconLanguage } from "@tabler/icons-react";
import {
	type MeasuredReasoning,
	REASONING_BODY_BORDER_LEFT,
	REASONING_BODY_PADDING_LEFT,
	REASONING_BODY_PADDING_Y,
	REASONING_CHEVRON_SIZE,
	REASONING_HEADER_ROW_HEIGHT,
	REASONING_ICON_SIZE,
	REASONING_ROW_PADDING_Y,
	REASONING_TRANSLATION_TOGGLE_HEIGHT,
	REASONING_TRANSLATION_TOGGLE_MARGIN_TOP,
	REASONING_XS_LINE_HEIGHT,
} from "../measure/measure-reasoning";
import type { MeasuredElement } from "../prepared-block";
import { swallowSelectionClick } from "./key-activate";
import { RenderMarkdown } from "./RenderMarkdown";

/**
 * i18n-facing labels, injected by the dispatch/registry layer.
 *
 * `countLabel` / `charsLabel` are BUILDERS rather than plain strings: their text
 * embeds a per-element number (step count / char count), so the shell supplies a
 * formatter and this module passes the measured value (same pattern as
 * RenderToolRun's `showEarlier`).
 */
export interface ReasoningLabels {
	reasoning?: string;
	thinking?: string;
	countLabel?: (stepCount: number) => string;
	charsLabel?: (formatted: string) => string;
	/** Shown while the TRANSLATION is on screen (click → original). */
	translationLabel?: string;
	/** Shown while the ORIGINAL is on screen (click → translation). */
	originalLabel?: string;
}

interface RenderReasoningProps {
	measured: MeasuredReasoning;
	labels?: ReasoningLabels;
	/**
	 * Show the run's raw text instead of the rendered markdown (viewer toggle).
	 *
	 * Only the EXPANDED form has a body to swap; the other three are single header
	 * rows, which is why the shell only advertises the toggle for an expanded run.
	 */
	showSource?: boolean;
	/** The raw text, needed only while `showSource` holds. */
	sourceText?: string;
	onToggle?: () => void;
	onToggleTranslation?: () => void;
	/** Forwarded for mermaid/katex local-measure refinement in the body. */
	onUnknownHeight?: (height: number) => void;
	/** Streaming per-grapheme fade-in for the expanded body (streaming tail only). */
	animateStreaming?: boolean;
	/** Stable per-element key base (the vlist item's spec.key) for anim memory. */
	animKeyBase?: string;
}

const BRAIN_ICON_SIZE = 10;

function BrainBadge() {
	return (
		<ThemeIcon size={REASONING_ICON_SIZE} variant="light" color="grape" radius="sm">
			<IconBrain size={BRAIN_ICON_SIZE} />
		</ThemeIcon>
	);
}

export function RenderReasoning({
	measured,
	labels = {},
	showSource,
	sourceText,
	onToggle,
	onToggleTranslation,
	onUnknownHeight,
	animateStreaming,
	animKeyBase,
}: RenderReasoningProps) {
	switch (measured.form) {
		case "streaming":
			return <StreamingRow labels={labels} />;
		case "count":
			return <CountLine measured={measured} labels={labels} onExpand={onToggle} />;
		case "collapsed":
			return <CollapsedHeader measured={measured} labels={labels} onToggle={onToggle} />;
		case "expanded":
			return (
				<ExpandedView
					measured={measured}
					labels={labels}
					showSource={showSource}
					sourceText={sourceText}
					onToggle={onToggle}
					onToggleTranslation={onToggleTranslation}
					onUnknownHeight={onUnknownHeight}
					animateStreaming={animateStreaming}
					animKeyBase={animKeyBase}
				/>
			);
	}
}

function StreamingRow({ labels }: { labels: ReasoningLabels }) {
	const thinking = labels.thinking ?? "thinking…";
	return (
		<Group
			gap={6}
			py={REASONING_ROW_PADDING_Y}
			wrap="nowrap"
			style={{ height: REASONING_HEADER_ROW_HEIGHT, opacity: 0.7 }}
		>
			<IconChevronRight size={REASONING_CHEVRON_SIZE} style={{ flexShrink: 0, opacity: 0.5 }} />
			<BrainBadge />
			<Text
				size="xs"
				fs="italic"
				c="dimmed"
				style={{ lineHeight: `${REASONING_XS_LINE_HEIGHT}px` }}
			>
				{thinking}
			</Text>
		</Group>
	);
}

function CountLine({
	measured,
	labels,
	onExpand,
}: {
	measured: MeasuredReasoning;
	labels: ReasoningLabels;
	onExpand?: () => void;
}) {
	const reasoning = labels.reasoning ?? "reasoning";
	const countLabel = labels.countLabel?.(measured.stepCount) ?? `${measured.stepCount} steps`;
	return (
		<Group
			gap={6}
			py={REASONING_ROW_PADDING_Y}
			wrap="nowrap"
			style={{ height: REASONING_HEADER_ROW_HEIGHT, cursor: onExpand ? "pointer" : undefined }}
			// A modified click selects the block; only a plain click expands.
			onClick={onExpand ? swallowSelectionClick(onExpand) : undefined}
		>
			<BrainBadge />
			<Text size="xs" c="dimmed" style={{ lineHeight: `${REASONING_XS_LINE_HEIGHT}px` }}>
				{reasoning}
			</Text>
			<Text size="xs" c="dimmed" style={{ lineHeight: `${REASONING_XS_LINE_HEIGHT}px` }}>
				{countLabel}
			</Text>
			<IconChevronRight
				size={REASONING_CHEVRON_SIZE}
				style={{ marginLeft: "auto", opacity: 0.6 }}
			/>
		</Group>
	);
}

function CollapsedHeader({
	measured,
	labels,
	onToggle,
}: {
	measured: MeasuredReasoning;
	labels: ReasoningLabels;
	onToggle?: () => void;
}) {
	return (
		<ReasoningHeaderRow expanded={false} labels={labels} measured={measured} onToggle={onToggle} />
	);
}

function ReasoningHeaderRow({
	expanded,
	labels,
	measured,
	onToggle,
}: {
	expanded: boolean;
	labels: ReasoningLabels;
	measured: MeasuredReasoning;
	onToggle?: () => void;
}) {
	const reasoning = labels.reasoning ?? "reasoning";
	const formattedChars = formatLocaleNumber(measured.charCount);
	const charsLabel = labels.charsLabel?.(formattedChars) ?? `${formattedChars} chars`;
	const preview =
		!expanded && measured.displayText ? measured.displayText.replace(/\s+/g, " ").slice(0, 80) : "";
	const Chevron = expanded ? IconChevronDown : IconChevronRight;
	return (
		<Group
			gap={6}
			py={REASONING_ROW_PADDING_Y}
			wrap="nowrap"
			style={{
				height: REASONING_HEADER_ROW_HEIGHT,
				cursor: onToggle ? "pointer" : undefined,
			}}
			// A modified click selects the block; only a plain click toggles.
			onClick={onToggle ? swallowSelectionClick(onToggle) : undefined}
		>
			{onToggle ? (
				<Chevron size={REASONING_CHEVRON_SIZE} style={{ flexShrink: 0, opacity: 0.7 }} />
			) : (
				<span style={{ width: REASONING_CHEVRON_SIZE, flexShrink: 0 }} />
			)}
			<BrainBadge />
			<Text size="xs" c="dimmed" style={{ lineHeight: `${REASONING_XS_LINE_HEIGHT}px` }}>
				{reasoning}
			</Text>
			<Text size="xs" c="dimmed" style={{ lineHeight: `${REASONING_XS_LINE_HEIGHT}px` }}>
				{charsLabel}
			</Text>
			{preview ? (
				<Text
					size="xs"
					c="dimmed"
					lineClamp={1}
					style={{
						flex: 1,
						minWidth: 0,
						lineHeight: `${REASONING_XS_LINE_HEIGHT}px`,
						opacity: 0.75,
					}}
				>
					{preview}
				</Text>
			) : null}
		</Group>
	);
}

function ExpandedView({
	measured,
	labels,
	showSource,
	sourceText,
	onToggle,
	onToggleTranslation,
	onUnknownHeight,
	animateStreaming,
	animKeyBase,
}: {
	measured: MeasuredReasoning;
	labels: ReasoningLabels;
	showSource?: boolean;
	sourceText?: string;
	onToggle?: () => void;
	onToggleTranslation?: () => void;
	onUnknownHeight?: (height: number) => void;
	animateStreaming?: boolean;
	animKeyBase?: string;
}) {
	const showToggle = !measured.isStreaming;
	const bodyMeasured: MeasuredElement = {
		height: measured.frame.contentHeight,
		blocks: measured.blocks,
		frame: measured.frame,
		contentWidth: measured.contentWidth,
		usedWidth: measured.usedWidth,
	};
	// The toggle names the OTHER side, so its wording follows what is displayed.
	const translationLabel = measured.showingOriginal
		? (labels.originalLabel ?? "Show translated")
		: (labels.translationLabel ?? "Show original");
	return (
		<div style={{ position: "relative", minHeight: measured.height }}>
			<ReasoningHeaderRow
				expanded
				labels={labels}
				measured={measured}
				onToggle={showToggle ? onToggle : undefined}
			/>
			<Box
				py={REASONING_BODY_PADDING_Y}
				style={{
					position: "relative",
					// Match the measured body geometry (pl="md" = 16px + 2px rail).
					paddingLeft: REASONING_BODY_PADDING_LEFT,
					borderLeft: `${REASONING_BODY_BORDER_LEFT}px solid var(--mantine-color-grape-9)`,
					opacity: 0.75,
					marginTop: 0,
				}}
			>
				{/* Source view swaps the render for the raw text inside the SAME reserved
				    body geometry, so the card cannot move (RenderMarkdown pins the box). */}
				<RenderMarkdown
					measured={bodyMeasured}
					showSource={showSource}
					sourceText={sourceText}
					onUnknownHeight={onUnknownHeight}
					animateStreaming={animateStreaming}
					animKeyBase={animKeyBase != null ? `${animKeyBase}:reasoning` : undefined}
				/>
				{measured.hasTranslationToggle ? (
					<Group
						gap={4}
						mt={REASONING_TRANSLATION_TOGGLE_MARGIN_TOP}
						style={{
							height: REASONING_TRANSLATION_TOGGLE_HEIGHT - REASONING_TRANSLATION_TOGGLE_MARGIN_TOP,
							cursor: onToggleTranslation ? "pointer" : undefined,
							// Inline-flex keeps the hit area on the words themselves (parity with
							// the chunked ReasoningBlock), so a click beside the label does not
							// silently flip the language.
							display: "inline-flex",
						}}
						onClick={
							onToggleTranslation
								? (event) => {
										// The row's ancestors carry selection / fold handlers; a
										// language flip must not also toggle the card.
										event.stopPropagation();
										onToggleTranslation();
									}
								: undefined
						}
					>
						<IconLanguage size={12} />
						<Text size="xs" c="dimmed">
							{translationLabel}
						</Text>
					</Group>
				) : null}
			</Box>
		</div>
	);
}
