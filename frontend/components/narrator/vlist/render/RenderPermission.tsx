/**
 * RenderPermission.tsx — Render copies of the two permission / interaction
 * elements measured by measure-permission.ts (batch-2 P11).
 *
 *   - RenderAskUserQuestion : the Alert banner (header + Radio/Checkbox options
 *     with wrapping labels/descriptions + custom-input Textarea + optional
 *     countdown + action buttons). readOnly locks controls, drops the Textarea /
 *     countdown / buttons and shows the saved answer + an "answered" badge.
 *   - RenderInlinePermission : the tool-card permission form (execution target +
 *     plan-edit Textarea + decision reason + feedback Textarea + PermButtonBar,
 *     or a single "unavailable" line in readOnly).
 *
 * Both draw at the geometry the measure layer produced, using absolute
 * positioning so the rendered height matches the predicted height exactly. The
 * wrapping AskUserQuestion header / option label / option description / saved
 * answer are materialized from the SAME pretext flow the measure layer used
 * (walkRichInlineLineRanges + materializeRichInlineLineRange), painted with the
 * measured font string so wrapping never drifts. Zero DOM measurement.
 *
 * These are VISUAL copies: the live interactive controls (mutations, keyboard
 * navigation, sessionStorage drafts, i18n) live in AskUserQuestionBanner.tsx /
 * ToolCallCard.tsx outside vlist/. Callers may inject handlers via slots.
 *
 * Follows the RenderMarkdown.tsx / RenderWebSearch.tsx / RenderAskInPassing.tsx
 * template.
 */

import {
	materializeRichInlineLineRange,
	walkRichInlineLineRanges,
} from "@chenglou/pretext/rich-inline";
import { Alert, Badge, Box, Button, Group, Paper, Text } from "@mantine/core";
import { IconClockHour4 } from "@tabler/icons-react";
import { Fragment, useMemo } from "react";
import {
	ALERT_PADDING,
	ASK_BUTTON_ROW_HEIGHT,
	type AskBlockMeta,
	BADGE_XS_HEIGHT,
	COUNTDOWN_ROW_HEIGHT,
	type MeasuredAskUserQuestion,
	type MeasuredInlinePermission,
	OPTION_CONTROL_SIZE,
	PERM_BUTTON_ROW_HEIGHT,
	type PermBlockMeta,
	TARGET_PADDING,
} from "../measure/measure-permission";
import type { PreparedInlineBlock } from "../prepared-block";
import { FragmentGap, LineFragments } from "./line-fragments";

// ─────────────────────────────────────────────────────────────────────────────
// Shared inline-line materialization (mirrors RenderMarkdown InlineBlockView).
// ─────────────────────────────────────────────────────────────────────────────

interface RenderedLine {
	fragments: Array<{ text: string; font: string; className: string; gapBefore: number }>;
}

function useInlineLines(
	block: PreparedInlineBlock | undefined,
	availableWidth: number,
): RenderedLine[] {
	return useMemo(() => {
		if (!block || block.kind !== "inline") return [];
		const lineWidth = Math.max(1, availableWidth - block.contentLeft);
		const out: RenderedLine[] = [];
		walkRichInlineLineRanges(block.flow, lineWidth, (range) => {
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

function InlineLines({
	block,
	frameTop,
	frameHeight,
	availableWidth,
	color,
}: {
	block: PreparedInlineBlock;
	frameTop: number;
	frameHeight: number;
	availableWidth: number;
	color?: string;
}) {
	const lines = useInlineLines(block, availableWidth);
	return (
		<div
			style={{
				position: "absolute",
				top: frameTop,
				left: 0,
				width: availableWidth,
				height: frameHeight,
			}}
		>
			{lines.map((line, lineIndex) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: lines are a stable ordered list
					key={lineIndex}
					style={{
						position: "absolute",
						left: block.contentLeft,
						top: lineIndex * block.lineHeight,
						height: block.lineHeight,
						display: "flex",
						alignItems: "center",
						width: "max-content",
					}}
				>
					<LineFragments>
						{line.fragments.map((frag, fi) => (
							<Fragment
								// biome-ignore lint/suspicious/noArrayIndexKey: fragments are a stable ordered list
								key={fi}
							>
								<FragmentGap gapBefore={frag.gapBefore} />
								<span
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
							</Fragment>
						))}
					</LineFragments>
				</div>
			))}
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// AskUserQuestionBanner render copy.
// ─────────────────────────────────────────────────────────────────────────────

export interface AskUserQuestionLabels {
	submit?: string;
	skip?: string;
	answered?: string;
	countdown?: string;
	customPlaceholder?: string;
}

const ASK_DEFAULT_LABELS: Required<AskUserQuestionLabels> = {
	submit: "Submit",
	skip: "Skip",
	answered: "Answered",
	countdown: "Auto-answering soon…",
	customPlaceholder: "Type a custom answer…",
};

interface RenderAskUserQuestionProps {
	measured: MeasuredAskUserQuestion;
	labels?: AskUserQuestionLabels;
	onSubmit?: () => void;
	onSkip?: () => void;
}

/** Render the AskUserQuestionBanner Alert at the measured geometry. */
export function RenderAskUserQuestion({
	measured,
	labels,
	onSubmit,
	onSkip,
}: RenderAskUserQuestionProps) {
	const merged = { ...ASK_DEFAULT_LABELS, ...labels };
	const { blocks, frame, contentWidth, metas, outerWidth } = measured;

	return (
		<Alert
			color={measured.readOnly ? "gray" : "blue"}
			radius="md"
			p={ALERT_PADDING}
			styles={{ body: { margin: 0 }, message: { margin: 0 } }}
			style={{
				width: outerWidth,
				height: measured.height,
				boxSizing: "border-box",
			}}
		>
			<div style={{ position: "relative", width: contentWidth, height: frame.contentHeight }}>
				{blocks.map((block, index) => {
					const meta = metas[index]!;
					const bf = frame.blocks[index]!;
					if (block.kind === "inline") {
						return (
							<AskInlineRow
								// biome-ignore lint/suspicious/noArrayIndexKey: blocks are a stable ordered list
								key={index}
								block={block}
								meta={meta}
								frameTop={bf.top}
								frameHeight={bf.height}
								contentWidth={contentWidth}
							/>
						);
					}
					// Fixed rows: textarea placeholder, badge, countdown, buttons.
					return (
						<AskFixedRow
							// biome-ignore lint/suspicious/noArrayIndexKey: blocks are a stable ordered list
							key={index}
							meta={meta}
							frameTop={bf.top}
							frameHeight={bf.height}
							contentWidth={contentWidth}
							labels={merged}
							onSubmit={onSubmit}
							onSkip={onSkip}
						/>
					);
				})}
			</div>
		</Alert>
	);
}

function AskInlineRow({
	block,
	meta,
	frameTop,
	frameHeight,
	contentWidth,
}: {
	block: PreparedInlineBlock;
	meta: AskBlockMeta;
	frameTop: number;
	frameHeight: number;
	contentWidth: number;
}) {
	const color =
		meta.role === "option-desc"
			? "var(--mantine-color-dimmed)"
			: meta.role === "custom-answer"
				? // `c="teal"` equivalent: teal-4 on dark, teal-filled on light.
					"var(--mantine-color-teal-text)"
				: "var(--mantine-color-text)";

	return (
		<div style={{ position: "absolute", top: frameTop, left: 0, width: contentWidth }}>
			{/* Radio / Checkbox control glyph to the left of an option label. */}
			{meta.role === "option-label" ? (
				<div
					aria-hidden
					style={{
						position: "absolute",
						left: 0,
						top: Math.max(0, (block.lineHeight - OPTION_CONTROL_SIZE) / 2),
						width: OPTION_CONTROL_SIZE,
						height: OPTION_CONTROL_SIZE,
						border: "1px solid var(--mantine-color-gray-5)",
						borderRadius:
							meta.control === "radio" ? OPTION_CONTROL_SIZE : "var(--mantine-radius-default)",
						boxSizing: "border-box",
					}}
				/>
			) : null}
			<InlineLines
				block={block}
				frameTop={0}
				frameHeight={frameHeight}
				availableWidth={contentWidth}
				color={color}
			/>
		</div>
	);
}

function AskFixedRow({
	meta,
	frameTop,
	frameHeight,
	contentWidth,
	labels,
	onSubmit,
	onSkip,
}: {
	meta: AskBlockMeta;
	frameTop: number;
	frameHeight: number;
	contentWidth: number;
	labels: Required<AskUserQuestionLabels>;
	onSubmit?: () => void;
	onSkip?: () => void;
}) {
	const common = {
		position: "absolute" as const,
		top: frameTop,
		left: 0,
		width: contentWidth,
		height: frameHeight,
	};
	switch (meta.role) {
		case "ask-textarea":
			return (
				<div style={common}>
					<div
						style={{
							width: "100%",
							height: frameHeight,
							border: "1px solid var(--mantine-color-default-border)",
							borderRadius: "var(--mantine-radius-default)",
							background: "var(--mantine-color-body)",
							boxSizing: "border-box",
							padding: "4.5px 8px",
							font: "var(--mantine-font-size-xs)/1.55 var(--mantine-font-family)",
							color: "var(--mantine-color-placeholder)",
							overflow: "hidden",
						}}
					>
						{labels.customPlaceholder}
					</div>
				</div>
			);
		case "answered-badge":
			return (
				<div style={common}>
					<Badge size="xs" color="teal" variant="light" style={{ height: BADGE_XS_HEIGHT }}>
						{labels.answered}
					</Badge>
				</div>
			);
		case "countdown":
			return (
				<div style={common}>
					<Group gap={6} wrap="nowrap" style={{ height: COUNTDOWN_ROW_HEIGHT }}>
						<IconClockHour4
							size={14}
							color="var(--mantine-color-yellow-6)"
							style={{ flexShrink: 0 }}
						/>
						<Text size="xs" c="dimmed">
							{labels.countdown}
						</Text>
					</Group>
				</div>
			);
		case "buttons":
			return (
				<div style={common}>
					<Group gap="sm" style={{ height: ASK_BUTTON_ROW_HEIGHT }} wrap="nowrap">
						<Button size="xs" onClick={onSubmit}>
							{labels.submit}
						</Button>
						<Button size="xs" color="red" variant="light" onClick={onSkip}>
							{labels.skip}
						</Button>
					</Group>
				</div>
			);
		default:
			return null;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// InlinePermission render copy.
// ─────────────────────────────────────────────────────────────────────────────

export interface InlinePermissionLabels {
	executionTarget?: string;
	executionTargetLocal?: string;
	planEdited?: string;
	feedbackPlaceholder?: string;
	unavailable?: string;
	allow?: string;
	deny?: string;
}

const PERM_DEFAULT_LABELS: Required<InlinePermissionLabels> = {
	executionTarget: "Execution target",
	executionTargetLocal: "Local",
	planEdited: "Plan edited",
	feedbackPlaceholder: "Optional feedback…",
	unavailable: "Permission actions are unavailable.",
	allow: "Allow",
	deny: "Deny",
};

interface RenderInlinePermissionProps {
	measured: MeasuredInlinePermission;
	labels?: InlinePermissionLabels;
	/** Draw the external Box mt="xs" (default true; the tool card may own it). */
	includeTopMargin?: boolean;
	onAllow?: () => void;
	onDeny?: () => void;
}

/** Render the InlinePermission form at the measured geometry. */
export function RenderInlinePermission({
	measured,
	labels,
	includeTopMargin = true,
	onAllow,
	onDeny,
}: RenderInlinePermissionProps) {
	const merged = { ...PERM_DEFAULT_LABELS, ...labels };
	const { frame, contentWidth, metas } = measured;

	return (
		<Box
			mt={includeTopMargin ? measured.topMargin : 0}
			style={{ position: "relative", width: contentWidth, height: frame.contentHeight }}
		>
			{/* The InlinePermission element is all fixed rows; render from meta +
			    frame geometry (block payloads live in meta.data). */}
			{metas.map((meta, index) => {
				const bf = frame.blocks[index]!;
				return (
					<PermFixedRow
						// biome-ignore lint/suspicious/noArrayIndexKey: rows are a stable ordered list
						key={index}
						meta={meta}
						frameTop={bf.top}
						frameHeight={bf.height}
						contentWidth={contentWidth}
						labels={merged}
						onAllow={onAllow}
						onDeny={onDeny}
					/>
				);
			})}
		</Box>
	);
}

function PermFixedRow({
	meta,
	frameTop,
	frameHeight,
	contentWidth,
	labels,
	onAllow,
	onDeny,
}: {
	meta: PermBlockMeta;
	frameTop: number;
	frameHeight: number;
	contentWidth: number;
	labels: Required<InlinePermissionLabels>;
	onAllow?: () => void;
	onDeny?: () => void;
}) {
	const common = {
		position: "absolute" as const,
		top: frameTop,
		left: 0,
		width: contentWidth,
		height: frameHeight,
	};
	switch (meta.role) {
		case "exec-target":
			return (
				<Paper
					withBorder
					radius="sm"
					p={TARGET_PADDING}
					style={{ ...common, boxSizing: "border-box", overflow: "hidden" }}
				>
					<Group gap="xs" wrap="nowrap">
						<Text size="xs" fw={600}>
							{labels.executionTarget}
						</Text>
						<Badge size="xs" variant="light" color="gray">
							{labels.executionTargetLocal}
						</Badge>
					</Group>
				</Paper>
			);
		case "plan-edited-badge":
			return (
				<div style={common}>
					<Badge size="xs" color="indigo" variant="light" style={{ height: BADGE_XS_HEIGHT }}>
						{labels.planEdited}
					</Badge>
				</div>
			);
		case "plan-textarea":
			return (
				<div style={common}>
					<div
						style={{
							width: "100%",
							height: frameHeight,
							border: "1px solid var(--mantine-color-default-border)",
							borderRadius: "var(--mantine-radius-default)",
							background: "var(--mantine-color-body)",
							boxSizing: "border-box",
							padding: "5.5px 12px",
							font: "var(--mantine-font-size-xs)/1.55 monospace",
							color: "var(--mantine-color-text)",
							overflow: "hidden",
						}}
					/>
				</div>
			);
		case "decision-reason":
			return (
				<div style={common}>
					<Text size="xs" c="dimmed" style={{ height: frameHeight, overflow: "hidden" }} />
				</div>
			);
		case "feedback-textarea":
			return (
				<div style={common}>
					<div
						style={{
							width: "100%",
							height: frameHeight,
							border: "1px solid var(--mantine-color-default-border)",
							borderRadius: "var(--mantine-radius-default)",
							background: "var(--mantine-color-body)",
							boxSizing: "border-box",
							padding: "4.5px 8px",
							font: "var(--mantine-font-size-xs)/1.55 var(--mantine-font-family)",
							color: "var(--mantine-color-placeholder)",
							overflow: "hidden",
						}}
					>
						{labels.feedbackPlaceholder}
					</div>
				</div>
			);
		case "readonly-note":
			return (
				<div style={common}>
					<Text size="xs" c="dimmed">
						{labels.unavailable}
					</Text>
				</div>
			);
		case "button-bar":
			return (
				<div style={common}>
					<Group gap="sm" style={{ height: PERM_BUTTON_ROW_HEIGHT }} wrap="wrap">
						<Button size="sm" color="green" onClick={onAllow}>
							{labels.allow}
						</Button>
						<Button size="sm" color="red" variant="light" onClick={onDeny}>
							{labels.deny}
						</Button>
					</Group>
				</div>
			);
		default:
			return null;
	}
}

export const RENDER_PERMISSION_CHROME = {
	ALERT_PADDING,
	TARGET_PADDING,
} as const;
