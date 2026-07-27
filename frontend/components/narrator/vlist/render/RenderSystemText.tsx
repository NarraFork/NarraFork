/**
 * RenderSystemText.tsx — Render copies of the multi-line / pre-wrap system cards
 * measured by measure-system-text.ts (batch-2 P5).
 *
 * Each card is a Paper (p="xs", radius=sm) with fixed chrome (icons / badges /
 * buttons / titles) plus a WRAPPING body. The body is materialized with pretext
 * (layoutWithLines) and painted line-by-line with the EXACT font the measure
 * layer used, so rendered wrapping matches the predicted height (zero drift,
 * zero DOM measurement).
 *
 * The body box is given the measured `contentWidth` (already the card inner
 * width minus this kind's flanking chrome), so the browser wraps identically to
 * the measure pass. Visuals mirror the original MessageBubble cards
 * (info notice / tool load notice / bash command / ErrorNotice / segment
 * failed / spec_goal_added / SpecForkCarryoverCard) using Mantine primitives +
 * @tabler icons — WITHOUT importing anything outside vlist/.
 */

import { layoutWithLines } from "@chenglou/pretext";
import { Badge, Button, CloseButton, Group, Paper, Stack, Text } from "@mantine/core";
import {
	IconAlertTriangle,
	IconEraser,
	IconGitFork,
	IconListCheck,
	IconLock,
	IconRepeat,
	IconRestore,
	IconTrash,
} from "@tabler/icons-react";
import { useMemo } from "react";
import {
	BODY_LINE_HEIGHT,
	CARD_PADDING,
	GROUP_GAP,
	ICON_16,
	ICON_MARGIN_TOP,
	KIND_CHROME,
	type SystemTextData,
	type SystemTextKind,
} from "../measure/measure-system-text";
import type { MeasuredElement, PreparedCodeBlock } from "../prepared-block";

/** Matches the original SYSTEM_MESSAGE_BG in MessageBubble.tsx (copied, not imported). */
const SYSTEM_MESSAGE_BG = "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))";

/**
 * Live actions for the spec carryover card's three buttons. The mutations
 * (spec REST calls, the confirm dialog, dismissing the notice) all live outside
 * vlist/, so the shell injects them; an absent handler renders the button
 * disabled instead of silently inert.
 */
export interface SpecCarryoverActions {
	/** Open the Spec task board. */
	onViewTasks?: () => void;
	/** Empty tasks.json for this narrator, then dismiss the card. */
	onClearTasks?: () => void;
	/** Reset the whole Dynamic Spec namespace (confirmed), then dismiss the card. */
	onResetSpec?: () => void;
	/** Which action is in flight (drives the Button loading state). */
	busy?: "clear" | "reset" | null;
}

interface RenderSystemTextProps {
	measured: MeasuredElement;
	/** The card kind (drives layout). Falls back to info if the tag is unknown. */
	kind: SystemTextKind;
	/** Optional render payload for chrome (title / badges / colour). */
	data?: SystemTextData;
	/** spec_fork_carryover / spec_context_cleared: live button handlers. */
	actions?: SpecCarryoverActions;
}

function cssColor(color: string, shade: number): string {
	return `var(--mantine-color-${color}-${shade})`;
}

function cssLight(color: string): string {
	return `var(--mantine-color-${color}-light)`;
}

/**
 * Render a multi-line / pre-wrap system card from its MeasuredElement. Dispatches
 * on `kind`; the wrapping body comes from the single PreparedCodeBlock.
 */
export function RenderSystemText({
	measured,
	kind,
	data = { text: "" },
	actions,
}: RenderSystemTextProps) {
	const body = measured.blocks[0] as PreparedCodeBlock | undefined;
	if (!body || body.kind !== "code") return null;
	const height = measured.height;
	const width = measured.contentWidth;
	// The exact font pretext measured with (measure/render parity, zero drift).
	const font = (KIND_CHROME[kind] ?? KIND_CHROME.info).font;

	switch (kind) {
		case "info":
		case "tool_loaded":
		case "tool_unloaded":
		case "bash_command":
			return <PlainNoticeCard body={body} width={width} font={font} height={height} />;
		case "error":
			return <ErrorCard body={body} width={width} font={font} height={height} data={data} />;
		case "segment_compact_failed":
			return (
				<SegmentFailedCard body={body} width={width} font={font} height={height} data={data} />
			);
		case "spec_goal_added":
			return (
				<SpecGoalCard
					body={body}
					width={width}
					font={font}
					height={height}
					data={data}
					onViewTasks={actions?.onViewTasks}
				/>
			);
		case "spec_fork_carryover":
		case "spec_context_cleared":
			return (
				<SpecCarryoverCard
					body={body}
					width={width}
					font={font}
					height={height}
					data={data}
					actions={actions}
				/>
			);
		default:
			return <PlainNoticeCard body={body} width={width} font={font} height={height} />;
	}
}

// ── Reusable wrapping-body renderer ──────────────────────────────────────────
// Paints the PreparedCodeBlock line-by-line at the measured width with the same
// font pretext measured, absolutely positioned. The box is width×bodyHeight.
function SystemTextBody({
	body,
	width,
	font,
	color,
}: {
	body: PreparedCodeBlock;
	width: number;
	/** The EXACT font string pretext measured with (from KIND_CHROME). */
	font: string;
	/** Optional CSS colour for the text (else inherits). */
	color?: string;
}) {
	const lines = useMemo(
		() => layoutWithLines(body.prepared, Math.max(1, width), body.lineHeight).lines,
		[body, width],
	);
	const bodyHeight = lines.length * body.lineHeight;

	return (
		<div style={{ position: "relative", width, height: bodyHeight }}>
			{lines.map((line, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: body lines are a stable ordered list
					key={i}
					style={{
						position: "absolute",
						top: i * body.lineHeight,
						left: 0,
						height: body.lineHeight,
						whiteSpace: "pre",
						font,
						color,
					}}
				>
					{line.text}
				</div>
			))}
		</div>
	);
}

// ── info / tool_loaded / tool_unloaded / bash_command ────────────────────────
function PlainNoticeCard({
	body,
	width,
	font,
	height,
}: {
	body: PreparedCodeBlock;
	width: number;
	font: string;
	height: number;
}) {
	return (
		<Paper
			p="xs"
			radius="sm"
			style={{ backgroundColor: SYSTEM_MESSAGE_BG, height, boxSizing: "border-box" }}
		>
			<SystemTextBody body={body} width={width} font={font} color="var(--mantine-color-dimmed)" />
		</Paper>
	);
}

// ── error: icon + body + retry/close actions ─────────────────────────────────
function ErrorCard({
	body,
	width,
	font,
	height,
	data,
}: {
	body: PreparedCodeBlock;
	width: number;
	font: string;
	height: number;
	data: SystemTextData;
}) {
	const showActions = data.actions !== false;
	return (
		<Paper
			p="xs"
			radius="sm"
			style={{ backgroundColor: cssLight("red"), height, boxSizing: "border-box" }}
		>
			<Group gap={GROUP_GAP} wrap="nowrap" align="flex-start" h="100%">
				<IconAlertTriangle
					size={ICON_16}
					style={{ flexShrink: 0, marginTop: ICON_MARGIN_TOP, color: cssColor("red", 7) }}
				/>
				<SystemTextBody body={body} width={width} font={font} color={cssColor("red", 9)} />
				{showActions ? (
					<>
						<IconRepeat
							size={14}
							style={{ flexShrink: 0, marginTop: ICON_MARGIN_TOP, color: cssColor("red", 7) }}
						/>
						<CloseButton size="xs" variant="subtle" c="red.7" style={{ flexShrink: 0 }} />
					</>
				) : null}
			</Group>
		</Paper>
	);
}

// ── segment_compact_failed: icon + Stack(title + body) + dismiss ─────────────
function SegmentFailedCard({
	body,
	width,
	font,
	height,
	data,
}: {
	body: PreparedCodeBlock;
	width: number;
	font: string;
	height: number;
	data: SystemTextData;
}) {
	return (
		<Paper
			p="xs"
			radius="sm"
			style={{ backgroundColor: cssLight("red"), height, boxSizing: "border-box" }}
		>
			<Group gap={GROUP_GAP} wrap="nowrap" align="flex-start" h="100%">
				<IconAlertTriangle size={ICON_16} style={{ flexShrink: 0, color: cssColor("red", 7) }} />
				<Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
					<Text size="xs" fw={600} c="red.8" style={{ height: BODY_LINE_HEIGHT }} lineClamp={1}>
						{data.title ?? ""}
					</Text>
					<SystemTextBody body={body} width={width} font={font} color={cssColor("red", 9)} />
				</Stack>
				{data.buttons?.[0] ? (
					<Button size="compact-xs" variant="subtle" color="dimmed" style={{ flexShrink: 0 }}>
						{data.buttons[0]}
					</Button>
				) : null}
			</Group>
		</Paper>
	);
}

// ── spec_goal_added: Stack(badge row [2 badges + task] + view-tasks button) ──
function SpecGoalCard({
	body,
	width,
	font,
	height,
	data,
	onViewTasks,
}: {
	body: PreparedCodeBlock;
	width: number;
	font: string;
	height: number;
	data: SystemTextData;
	onViewTasks?: () => void;
}) {
	const color = data.color ?? "indigo";
	const added = data.added !== false;
	const [protectedBadge, statusBadge] = data.badges ?? [];
	return (
		<Paper
			p="xs"
			radius="sm"
			style={{ backgroundColor: cssLight(color), height, boxSizing: "border-box" }}
		>
			<Stack gap={6} h="100%">
				<Group gap="xs" wrap="nowrap" align="flex-start">
					<Badge
						size="xs"
						color="yellow"
						variant="light"
						leftSection={<IconLock size={10} />}
						style={{ flexShrink: 0 }}
					>
						{protectedBadge ?? ""}
					</Badge>
					<Badge
						size="xs"
						color={added ? "green" : "gray"}
						variant="light"
						style={{ flexShrink: 0 }}
					>
						{statusBadge ?? ""}
					</Badge>
					<SystemTextBody body={body} width={width} font={font} color={cssColor(color, 7)} />
				</Group>
				{data.buttons?.[0] ? (
					<Button
						size="compact-xs"
						variant="subtle"
						color={color}
						leftSection={<IconListCheck size={12} />}
						style={{ alignSelf: "flex-start" }}
						disabled={!onViewTasks}
						onClick={onViewTasks}
					>
						{data.buttons[0]}
					</Button>
				) : null}
			</Stack>
		</Paper>
	);
}

// ── spec_fork_carryover / spec_context_cleared: badge + desc + 3 buttons ─────
function SpecCarryoverCard({
	body,
	width,
	font,
	height,
	data,
	actions,
}: {
	body: PreparedCodeBlock;
	width: number;
	font: string;
	height: number;
	data: SystemTextData;
	actions?: SpecCarryoverActions;
}) {
	const color = data.color ?? "indigo";
	const isCleared = data.variant === "contextCleared";
	const [badgeLabel] = data.badges ?? [];
	const buttons = data.buttons ?? [];
	const buttonIcons = [
		<IconListCheck size={12} key="view" />,
		<IconTrash size={12} key="clear" />,
		<IconRestore size={12} key="reset" />,
	];
	const buttonColors = [color, "orange", "red"];
	// Same order the adapter emits (view / clear / reset), so the injected
	// handlers line up with the labels the measure layer reserved room for.
	const buttonHandlers = [actions?.onViewTasks, actions?.onClearTasks, actions?.onResetSpec];
	const busy = actions?.busy ?? null;
	const busyIndex = busy === "clear" ? 1 : busy === "reset" ? 2 : -1;
	return (
		<Paper
			p="xs"
			radius="sm"
			style={{ backgroundColor: cssLight(color), height, boxSizing: "border-box" }}
		>
			<Stack gap={6} h="100%">
				<Group gap="xs" wrap="nowrap" align="flex-start">
					<Badge
						size="xs"
						color={color}
						variant="light"
						leftSection={isCleared ? <IconEraser size={10} /> : <IconGitFork size={10} />}
						style={{ flexShrink: 0 }}
					>
						{badgeLabel ?? ""}
					</Badge>
					<SystemTextBody body={body} width={width} font={font} color={cssColor(color, 7)} />
				</Group>
				<Group gap={6} wrap="wrap">
					{buttons.map((label, i) => {
						const onClick = buttonHandlers[i];
						return (
							<Button
								// biome-ignore lint/suspicious/noArrayIndexKey: buttons are a stable ordered list
								key={i}
								size="compact-xs"
								variant={i === 0 ? "subtle" : "light"}
								color={buttonColors[i] ?? color}
								leftSection={buttonIcons[i]}
								loading={busyIndex === i}
								disabled={!onClick || (busy !== null && busyIndex !== i)}
								onClick={onClick}
							>
								{label}
							</Button>
						);
					})}
				</Group>
			</Stack>
		</Paper>
	);
}

export const RENDER_SYSTEM_TEXT_CHROME = { CARD_PADDING, GROUP_GAP } as const;
