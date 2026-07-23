/**
 * RenderAskInPassing.tsx — Render copies of the two "ask in passing" sub-cards
 * measured by measure-ask-in-passing.ts (batch-2 P8).
 *
 *   - pending  (AskInPassingPendingCard):  fixed 77px. A dashed Box with a hint
 *     row (icon + dimmed xs text) and an input row (TextInput sm + 2 Buttons sm).
 *   - resolved (AskInPassingResolvedCard): 57~77px. A Paper with a 3px left rail,
 *     a leading question icon, a Stack (dimmed xs label + sm/500 question clamped
 *     to 2 lines) and a trailing arrow icon.
 *
 * The pending form is a VISUAL copy (the real interactive form — mutations,
 * navigation, i18n — lives in AskInPassingCard.tsx outside vlist/). Callers may
 * inject the live controls via slots; otherwise inert placeholders are drawn.
 *
 * The resolved question is materialized from the SAME pretext flow the measure
 * layer used (walkRichInlineLineRanges + materializeRichInlineLineRange), painted
 * with QUESTION_FONT so wrapping matches the predicted (clamped) height. Zero DOM
 * measurement.
 */

import {
	materializeRichInlineLineRange,
	walkRichInlineLineRanges,
} from "@chenglou/pretext/rich-inline";
import { Box, Button, Group, Paper, Stack, Text, TextInput } from "@mantine/core";
import { IconArrowRight, IconMessageQuestion } from "@tabler/icons-react";
import { useMemo } from "react";
import {
	PENDING_HINT_MARGIN,
	PENDING_PADDING_X,
	PENDING_PADDING_Y,
	QUESTION_FONT,
	QUESTION_MAX_LINES,
	RESOLVED_GROUP_GAP,
	RESOLVED_ICON,
	RESOLVED_LABEL_HEIGHT,
	RESOLVED_PADDING_X,
	RESOLVED_PADDING_Y,
} from "../measure/measure-ask-in-passing";
import type { MeasuredElement, PreparedFixedBlock, PreparedInlineBlock } from "../prepared-block";

const CARD_BG = "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))";

interface RenderAskInPassingProps {
	kind: "pending" | "resolved";
	measured: MeasuredElement;
	/** Localized strings (fall back to English defaults if absent). */
	labels?: {
		hint?: string;
		placeholder?: string;
		confirm?: string;
		cancel?: string;
		resolvedLabel?: string;
	};
	/** pending: click handler for the confirm button (optional). */
	onConfirm?: () => void;
	/** pending: click handler for the cancel button (optional). */
	onCancel?: () => void;
	/** resolved: click handler for the whole card (navigate to target). */
	onOpen?: () => void;
}

interface AskInPassingLabels {
	hint: string;
	placeholder: string;
	confirm: string;
	cancel: string;
	resolvedLabel: string;
}

const DEFAULT_LABELS: AskInPassingLabels = {
	hint: "Ask this narrator a quick question",
	placeholder: "Type your question…",
	confirm: "Ask",
	cancel: "Cancel",
	resolvedLabel: "Asked in passing",
};

/** Dispatch on kind. */
export function RenderAskInPassing({
	kind,
	measured,
	labels,
	onConfirm,
	onCancel,
	onOpen,
}: RenderAskInPassingProps) {
	const merged = { ...DEFAULT_LABELS, ...labels };
	if (kind === "pending") {
		return (
			<PendingCard measured={measured} labels={merged} onConfirm={onConfirm} onCancel={onCancel} />
		);
	}
	return <ResolvedCard measured={measured} label={merged.resolvedLabel} onOpen={onOpen} />;
}

// ── pending: fixed 77px dashed box (visual copy of the input form) ────────────
function PendingCard({
	measured,
	labels,
	onConfirm,
	onCancel,
}: {
	measured: MeasuredElement;
	labels: AskInPassingLabels;
	onConfirm?: () => void;
	onCancel?: () => void;
}) {
	const block = measured.blocks[0] as PreparedFixedBlock | undefined;
	if (!block || block.kind !== "fixed") return null;
	return (
		<Box
			px={PENDING_PADDING_X}
			py={PENDING_PADDING_Y}
			style={{
				height: measured.height,
				boxSizing: "border-box",
				borderRadius: "var(--mantine-radius-md)",
				border: "1px dashed var(--mantine-color-indigo-7)",
				backgroundColor: CARD_BG,
			}}
		>
			<Group gap={6} mb={PENDING_HINT_MARGIN} wrap="nowrap">
				<IconMessageQuestion size={14} color="var(--mantine-color-indigo-5)" />
				<Text size="xs" c="dimmed" truncate>
					{labels.hint}
				</Text>
			</Group>
			<Group gap="xs" wrap="nowrap">
				<TextInput flex={1} size="sm" placeholder={labels.placeholder} readOnly />
				<Button size="sm" variant="filled" onClick={onConfirm}>
					{labels.confirm}
				</Button>
				<Button size="sm" variant="subtle" onClick={onCancel}>
					{labels.cancel}
				</Button>
			</Group>
		</Box>
	);
}

// ── resolved: Paper + left rail + label + clamped question ────────────────────
function ResolvedCard({
	measured,
	label,
	onOpen,
}: {
	measured: MeasuredElement;
	label: string;
	onOpen?: () => void;
}) {
	const block = measured.blocks[0] as PreparedInlineBlock | undefined;
	const questionLines = useMemo(() => {
		if (!block || block.kind !== "inline") return [];
		const out: Array<Array<{ text: string; font: string; gapBefore: number }>> = [];
		walkRichInlineLineRanges(block.flow, measured.contentWidth, (range) => {
			if (out.length >= QUESTION_MAX_LINES) return;
			const line = materializeRichInlineLineRange(block.flow, range);
			out.push(
				line.fragments.map((f) => ({
					text: f.text,
					font: block.fonts[f.itemIndex] ?? QUESTION_FONT,
					gapBefore: f.gapBefore,
				})),
			);
		});
		return out;
	}, [block, measured.contentWidth]);

	const lineHeight = block?.kind === "inline" ? block.lineHeight : 20;

	return (
		<Paper
			px={RESOLVED_PADDING_X}
			py={RESOLVED_PADDING_Y}
			radius="sm"
			style={{
				height: measured.height,
				boxSizing: "border-box",
				backgroundColor: CARD_BG,
				borderLeft: "3px solid var(--mantine-color-indigo-7)",
				cursor: onOpen ? "pointer" : undefined,
			}}
			onClick={onOpen}
		>
			<Group gap={RESOLVED_GROUP_GAP} wrap="nowrap" align="flex-start" h="100%">
				<IconMessageQuestion
					size={RESOLVED_ICON}
					color="var(--mantine-color-indigo-5)"
					style={{ flexShrink: 0, marginTop: 2 }}
				/>
				<Stack gap={0} flex={1} style={{ minWidth: 0 }}>
					<Text size="xs" c="dimmed" style={{ height: RESOLVED_LABEL_HEIGHT }}>
						{label}
					</Text>
					<div
						style={{
							position: "relative",
							height: questionLines.length * lineHeight,
						}}
					>
						{questionLines.map((frags, lineIndex) => (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: question lines are a stable ordered list
								key={lineIndex}
								style={{
									position: "absolute",
									left: 0,
									top: lineIndex * lineHeight,
									height: lineHeight,
									display: "flex",
									alignItems: "center",
									width: "max-content",
								}}
							>
								{frags.map((frag, fi) => (
									<span
										// biome-ignore lint/suspicious/noArrayIndexKey: fragments are a stable ordered list
										key={fi}
										style={{
											font: frag.font,
											marginLeft: frag.gapBefore,
											whiteSpace: "pre",
											display: "inline-block",
											color: "var(--mantine-color-text)",
										}}
									>
										{frag.text}
									</span>
								))}
							</div>
						))}
					</div>
				</Stack>
				<IconArrowRight
					size={RESOLVED_ICON}
					color="var(--mantine-color-indigo-5)"
					style={{ flexShrink: 0, marginTop: 2 }}
				/>
			</Group>
		</Paper>
	);
}

export const RENDER_ASK_IN_PASSING_CHROME = {
	PENDING_PADDING_X,
	PENDING_PADDING_Y,
	RESOLVED_PADDING_X,
	RESOLVED_PADDING_Y,
} as const;
