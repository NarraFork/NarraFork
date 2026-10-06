/**
 * RenderAskInPassing.tsx — Render copies of the two "ask in passing" sub-cards
 * measured by measure-ask-in-passing.ts (batch-2 P8).
 *
 *   - pending  (AskInPassingPendingCard):  fixed 79px (including borders). A dashed Box with a hint
 *     row (icon + dimmed xs text) and an input row (TextInput sm + 2 Buttons sm).
 *   - resolved (AskInPassingResolvedCard): 57~77px. A Paper with a 3px left rail,
 *     a leading question icon, a Stack (dimmed xs label + sm/500 question clamped
 *     to 2 lines) and a trailing arrow icon.
 *
 * The pending form is controlled by the bridge. Its border-box geometry is shared
 * with the measure layer; interaction never substitutes a free-height subtree.
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
import { fragmentTextStyle, letterSpacingForFont } from "@shared/pretext-layout/fragment-style";
import { IconArrowRight, IconMessageQuestion } from "@tabler/icons-react";
import { Fragment, type KeyboardEvent, useCallback, useEffect, useMemo, useRef } from "react";
import {
	PENDING_BORDER,
	PENDING_CARD_HEIGHT,
	PENDING_HINT_MARGIN,
	PENDING_HINT_ROW,
	PENDING_INPUT_ROW,
	PENDING_PADDING_X,
	PENDING_PADDING_Y,
	QUESTION_MAX_LINES,
	RESOLVED_GROUP_GAP,
	RESOLVED_ICON,
	RESOLVED_LABEL_HEIGHT,
	RESOLVED_PADDING_X,
	RESOLVED_PADDING_Y,
} from "../measure/measure-ask-in-passing";
import type { MeasuredElement, PreparedFixedBlock, PreparedInlineBlock } from "../prepared-block";
import { typographyMetrics } from "../pretext-fonts";
import { FragmentGap, LineFragments } from "./line-fragments";

const CARD_BG = "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))";

/** Controlled by a message-scoped controller that survives virtual row remounts. */
export interface AskInPassingPendingInteraction {
	value: string;
	busy: boolean;
	operation?: "submitting" | "cancelling";
	onChange: (value: string) => void;
	onConfirm: () => void;
	onCancel: () => void;
	/** A fresh token requests focus. Clear it synchronously when consumed. */
	focusRequest?: number | null;
	onFocusConsumed?: (request: number) => boolean;
}

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
	/** State and effects belong to the bridge; geometry belongs to this renderer. */
	pending?: AskInPassingPendingInteraction;
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
	pending,
	onOpen,
}: RenderAskInPassingProps) {
	const merged = { ...DEFAULT_LABELS, ...labels };
	if (kind === "pending") {
		return <PendingCard measured={measured} labels={merged} pending={pending} />;
	}
	return <ResolvedCard measured={measured} label={merged.resolvedLabel} onOpen={onOpen} />;
}

// ── pending: fixed border-box geometry, fully controlled interaction ─────────
function PendingCard({
	measured,
	labels,
	pending,
}: {
	measured: MeasuredElement;
	labels: AskInPassingLabels;
	pending?: AskInPassingPendingInteraction;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const composing = useRef(false);
	const { focusRequest, onFocusConsumed } = pending ?? {};
	const busy = !pending || pending.busy;
	useEffect(() => {
		if (focusRequest == null || busy || !inputRef.current) return;
		// The controller atomically claims the token, including StrictMode replays.
		if (onFocusConsumed && !onFocusConsumed(focusRequest)) return;
		inputRef.current.focus({ preventScroll: true });
	}, [focusRequest, onFocusConsumed, busy]);
	const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
			return;
		if (event.key !== "Enter" && event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		if (busy) return;
		if (event.key === "Escape") pending?.onCancel();
		else if (pending?.value.trim()) pending.onConfirm();
	};
	const block = measured.blocks[0] as PreparedFixedBlock | undefined;
	if (!block || block.kind !== "fixed") return null;
	return (
		<Box
			style={{
				padding: `${PENDING_PADDING_Y}px ${PENDING_PADDING_X}px`,
				height: PENDING_CARD_HEIGHT,
				minWidth: 0,
				overflow: "hidden",
				boxSizing: "border-box",
				borderRadius: "var(--mantine-radius-md)",
				border: `${PENDING_BORDER}px dashed var(--mantine-color-indigo-7)`,
				backgroundColor: CARD_BG,
			}}
		>
			<Group
				gap={6}
				wrap="nowrap"
				style={{ overflow: "hidden", height: PENDING_HINT_ROW, marginBottom: PENDING_HINT_MARGIN }}
			>
				<IconMessageQuestion
					size={14}
					color="var(--mantine-color-indigo-5)"
					style={{ flexShrink: 0 }}
				/>
				<Text
					size="xs"
					c="dimmed"
					truncate
					style={{ minWidth: 0, lineHeight: `${PENDING_HINT_ROW}px` }}
				>
					{labels.hint}
				</Text>
			</Group>
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "minmax(0, 1fr) minmax(0, auto) minmax(0, auto)",
					gap: 6,
					height: PENDING_INPUT_ROW,
					minWidth: 0,
				}}
			>
				<TextInput
					ref={inputRef}
					size="sm"
					placeholder={labels.placeholder}
					aria-label={labels.placeholder}
					value={pending?.value ?? ""}
					disabled={busy}
					onChange={(event) => pending?.onChange(event.currentTarget.value)}
					onKeyDown={handleKeyDown}
					onCompositionStart={() => {
						composing.current = true;
					}}
					onCompositionEnd={() => {
						composing.current = false;
					}}
					styles={{
						root: { minWidth: 0 },
						wrapper: { height: PENDING_INPUT_ROW },
						input: {
							height: PENDING_INPUT_ROW,
							minHeight: PENDING_INPUT_ROW,
							boxSizing: "border-box",
						},
					}}
				/>
				<Button
					type="button"
					size="sm"
					variant="filled"
					disabled={busy || !pending?.value.trim()}
					onClick={pending?.onConfirm}
					px={8}
					style={{
						minWidth: 0,
						height: PENDING_INPUT_ROW,
						minHeight: PENDING_INPUT_ROW,
						boxSizing: "border-box",
					}}
					styles={{ label: { overflow: "hidden", textOverflow: "ellipsis" } }}
					title={labels.confirm}
				>
					{labels.confirm}
				</Button>
				<Button
					type="button"
					size="sm"
					variant="subtle"
					disabled={busy}
					onClick={pending?.onCancel}
					px={8}
					style={{
						minWidth: 0,
						height: PENDING_INPUT_ROW,
						minHeight: PENDING_INPUT_ROW,
						boxSizing: "border-box",
					}}
					styles={{ label: { overflow: "hidden", textOverflow: "ellipsis" } }}
					title={labels.cancel}
				>
					{labels.cancel}
				</Button>
			</div>
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
					font: block.fonts[f.itemIndex] ?? typographyMetrics().font.bodyMedium,
					gapBefore: f.gapBefore,
				})),
			);
		});
		return out;
	}, [block, measured.contentWidth]);

	const lineHeight = block?.kind === "inline" ? block.lineHeight : 20;

	const handleKeyDown = useCallback(
		(e: KeyboardEvent<HTMLDivElement>) => {
			if (!onOpen) return;
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				onOpen();
			}
		},
		[onOpen],
	);

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
			{...(onOpen
				? {
						role: "button",
						tabIndex: 0,
						onKeyDown: handleKeyDown,
					}
				: {})}
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
								<LineFragments>
									{frags.map((frag, fi) => (
										<Fragment
											// biome-ignore lint/suspicious/noArrayIndexKey: fragments are a stable ordered list
											key={fi}
										>
											<FragmentGap gapBefore={frag.gapBefore} />
											<span
												style={{
													...fragmentTextStyle({
														font: frag.font,
														gapBefore: frag.gapBefore,
														letterSpacing: letterSpacingForFont(frag.font),
													}),
													color: "var(--mantine-color-text)",
												}}
											>
												{frag.text}
											</span>
										</Fragment>
									))}
								</LineFragments>
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
