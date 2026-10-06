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
import {
	ActionIcon,
	Badge,
	Button,
	CloseButton,
	Group,
	Paper,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import {
	IconAlertTriangle,
	IconEraser,
	IconGitFork,
	IconListCheck,
	IconLock,
	IconNetwork,
	IconPhotoOff,
	IconRepeat,
	IconRestore,
	IconTrash,
} from "@tabler/icons-react";
import { type ReactNode, useMemo } from "react";
import {
	CARD_PADDING,
	GROUP_GAP,
	ICON_16,
	ICON_MARGIN_TOP,
	KIND_CHROME,
	ORIGIN_HEADING_GAP,
	STACK_GAP,
	type SystemTextData,
	type SystemTextKind,
} from "../measure/measure-system-text";
import type { MeasuredElement, PreparedCodeBlock } from "../prepared-block";
import { typographyMetrics } from "../pretext-fonts";

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

/**
 * Live actions for the error card's right-side controls. Every mutation (the
 * provider-settings fix, the retry-rule dialog, the dismiss DELETE) lives outside
 * vlist/, so the shell injects them; an absent handler renders the control
 * disabled instead of silently inert — the regression this slot closes.
 *
 * The controls occupy the width the measure layer reserves for the strip
 * (ERROR_RIGHT = 3 × (gap + xs control)), so wiring them — including showing or
 * hiding the conditional fix — changes no height and no wrap point.
 */
export interface ErrorNoticeActions {
	/** Open the "mark as retryable" rule dialog prefilled with this error. */
	onMarkRetryable?: () => void;
	/** Delete this error message (and its resumable siblings). */
	onDismiss?: () => void;
	/** Dismiss request in flight (disables the close button). */
	dismissing?: boolean;
	/** Localized tooltip / aria-label for the retry-rule control. */
	markRetryableLabel?: string;
	/**
	 * Turn off the provider's native image_generation tool and retry.
	 *
	 * Whether the button EXISTS is decided by the adapter (it occupies a measured
	 * row, so `data.buttons` carries its label); this handler only makes the
	 * painted button live. An absent handler therefore renders it disabled, like
	 * the other controls.
	 */
	onDisableImageGen?: () => void;
	/** The disable+retry round trip is in flight. */
	disablingImageGen?: boolean;
	/**
	 * Open the model-test dialog for this narrator's resolved model.
	 *
	 * Same contract as `onDisableImageGen`: whether the button EXISTS is decided by
	 * the adapter (it shares the card's measured button row), and this only makes it
	 * live. Admin-only, network-errors-only — the eligibility rules live in the
	 * shell, which is also what hosts the dialog.
	 */
	onTestModel?: () => void;
}

/**
 * Live action for an interrupt task-guard reminder card (origin_notice whose
 * source is `interrupt_task_guard`): a close button in the heading row that
 * deletes the notice. The mutation (DELETE + cache prune) lives outside vlist/,
 * so the shell injects it; without the slot no button is painted at all —
 * unlike the error card's controls, other origin notices have no dismiss
 * affordance, so there is no "disabled but visible" state to preserve.
 */
export interface InjectionGuardActions {
	/** Delete this reminder message. */
	onDismiss?: () => void;
	/** Dismiss request in flight (disables the close button). */
	dismissing?: boolean;
	/** Localized tooltip / aria-label for the close button. */
	dismissLabel?: string;
}

interface RenderSystemTextProps {
	measured: MeasuredElement;
	/** The card kind (drives layout). Falls back to info if the tag is unknown. */
	kind: SystemTextKind;
	/** Optional render payload for chrome (title / badges / colour). */
	data?: SystemTextData;
	/** spec_fork_carryover / spec_context_cleared: live button handlers. */
	actions?: SpecCarryoverActions;
	/** error: live handlers for the retry-rule + dismiss controls. */
	errorActions?: ErrorNoticeActions;
	/** origin_notice (interrupt_task_guard only): live dismiss handler. */
	injectionGuardActions?: InjectionGuardActions;
	headerAction?: ReactNode;
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
	errorActions,
	injectionGuardActions,
	headerAction,
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
			return (
				<ErrorCard
					body={body}
					width={width}
					font={font}
					height={height}
					data={data}
					actions={errorActions}
				/>
			);
		case "segment_compact_failed":
			return (
				<SegmentFailedCard body={body} width={width} font={font} height={height} data={data} />
			);
		case "origin_notice":
			return (
				<OriginNoticeCard
					body={body}
					width={width}
					font={font}
					height={height}
					data={data}
					guardActions={injectionGuardActions}
					headerAction={headerAction}
				/>
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

// ── error: Stack(icon + body + retry/close actions, [optional button row]) ───
// The right-side icons are REAL controls (parity with the chunked ErrorNotice):
// "mark as retryable" opens the rule dialog, the close button deletes the notice.
// Handlers are injected; without them the controls render disabled rather than
// looking clickable while doing nothing.
//
// The conditional actions (provider fix, model probe) are LABELLED buttons on a
// shared row instead of extra icons: an icon-only control explains itself only
// through a hover tooltip, which touch users never see, so the actions that
// actually resolve the failure would be undiscoverable. Their labels come from
// `data.buttons` — the adapter put them there, which is also how the measure layer
// knew to reserve this row — and `data.buttonIds` says which is which, since each
// is independently eligible.
function ErrorCard({
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
	actions?: ErrorNoticeActions;
}) {
	const showActions = data.actions !== false;
	const markLabel = actions?.markRetryableLabel ?? "Mark as retryable";
	// Bound by ID, not position: both buttons are independently eligible, so on a
	// card that qualifies for only the model probe, `buttons[0]` IS the probe. Older
	// data (before buttonIds existed) carried the fix alone, hence the fallback.
	const buttonLabels = data.buttons ?? [];
	const buttonIds = data.buttonIds ?? (buttonLabels.length > 0 ? ["disableImageGen"] : []);
	const labelFor = (id: string): string | undefined => {
		const index = buttonIds.indexOf(id);
		return index < 0 ? undefined : buttonLabels[index];
	};
	const fixLabel = labelFor("disableImageGen");
	const modelTestLabel = labelFor("testCurrentModel");
	return (
		<Paper
			p="xs"
			radius="sm"
			style={{ backgroundColor: cssLight("red"), height, boxSizing: "border-box" }}
		>
			<Stack gap={STACK_GAP} h="100%">
				<Group gap={GROUP_GAP} wrap="nowrap" align="flex-start">
					<IconAlertTriangle
						size={ICON_16}
						style={{ flexShrink: 0, marginTop: ICON_MARGIN_TOP, color: cssColor("red", 7) }}
					/>
					<SystemTextBody body={body} width={width} font={font} color={cssColor("red", 9)} />
					{showActions ? (
						<>
							<Tooltip label={markLabel} withArrow>
								<ActionIcon
									size="xs"
									variant="subtle"
									color="red.7"
									style={{ flexShrink: 0 }}
									aria-label={markLabel}
									disabled={!actions?.onMarkRetryable}
									onClick={actions?.onMarkRetryable}
								>
									<IconRepeat size={14} />
								</ActionIcon>
							</Tooltip>
							<CloseButton
								size="xs"
								variant="subtle"
								c="red.7"
								style={{ flexShrink: 0 }}
								disabled={!actions?.onDismiss || actions.dismissing === true}
								onClick={actions?.onDismiss}
							/>
						</>
					) : null}
				</Group>
				{showActions && (fixLabel || modelTestLabel) ? (
					// One row for both: the measure layer reserves a single
					// BUTTON_COMPACT_XS row whenever any button qualifies, so a second
					// button must cost width rather than height.
					<Group gap={GROUP_GAP} wrap="nowrap">
						{fixLabel ? (
							<Button
								size="compact-xs"
								variant="light"
								color="red"
								leftSection={<IconPhotoOff size={12} />}
								loading={actions?.disablingImageGen === true}
								disabled={!actions?.onDisableImageGen}
								onClick={actions?.onDisableImageGen}
							>
								{fixLabel}
							</Button>
						) : null}
						{modelTestLabel ? (
							<Button
								size="compact-xs"
								variant="light"
								color="blue"
								leftSection={<IconNetwork size={12} />}
								disabled={!actions?.onTestModel}
								onClick={actions?.onTestModel}
							>
								{modelTestLabel}
							</Button>
						) : null}
					</Group>
				) : null}
			</Stack>
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
					<Text
						size="xs"
						fw={600}
						c="red.8"
						style={{ height: typographyMetrics().line.xs }}
						lineClamp={1}
					>
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

// ── origin_notice: Stack(heading row [icon + source + time] + body) ──────────
// Geometry mirrors measure-system-text's origin_notice chrome:
// preBody = the xs heading row + ORIGIN_HEADING_GAP, no side chrome.
function OriginNoticeCard({
	body,
	width,
	font,
	height,
	data,
	guardActions,
	headerAction,
}: {
	body: PreparedCodeBlock;
	width: number;
	font: string;
	height: number;
	data: SystemTextData;
	guardActions?: InjectionGuardActions;
	headerAction?: ReactNode;
}) {
	const timeLabel = typeof data.timeLabel === "string" ? data.timeLabel : "";
	return (
		<Paper
			p="xs"
			radius="sm"
			style={{ backgroundColor: SYSTEM_MESSAGE_BG, height, boxSizing: "border-box" }}
		>
			<Stack gap={ORIGIN_HEADING_GAP} style={{ minWidth: 0 }}>
				<Group gap={GROUP_GAP} wrap="nowrap" style={{ height: typographyMetrics().line.xs }}>
					<IconRepeat
						size={13}
						stroke={1.6}
						style={{ flexShrink: 0, color: "var(--mantine-color-dimmed)" }}
					/>
					<Text size="xs" c="dimmed" fw={600} lineClamp={1} style={{ whiteSpace: "nowrap" }}>
						{data.title ?? ""}
					</Text>
					{timeLabel ? (
						<Text size="xs" c="dimmed" ml="auto" style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
							{timeLabel}
						</Text>
					) : null}
					{headerAction}
					{guardActions ? (
						// Height-neutral: pinned to the 17px heading row the measure layer
						// already reserves; width only trims the clamped title, never the body.
						<Tooltip label={guardActions.dismissLabel ?? ""} disabled={!guardActions.dismissLabel}>
							<CloseButton
								size="xs"
								variant="subtle"
								c="dimmed"
								ml={timeLabel ? undefined : "auto"}
								style={{
									flexShrink: 0,
									height: typographyMetrics().line.xs,
									minHeight: typographyMetrics().line.xs,
								}}
								aria-label={guardActions.dismissLabel}
								disabled={!guardActions.onDismiss || guardActions.dismissing === true}
								onClick={guardActions.onDismiss}
							/>
						</Tooltip>
					) : null}
				</Group>
				<SystemTextBody body={body} width={width} font={font} />
			</Stack>
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

// A `review_feedback` card briefly lived here. It is gone: this module paints its body as
// PLAIN pre-wrap text line by line, which cannot render the markdown, inline code or
// fenced snippets a review conclusion is written in, and its cards grow rather than
// scroll. See render/RenderReviewCard.tsx.

export const RENDER_SYSTEM_TEXT_CHROME = { CARD_PADDING, GROUP_GAP } as const;
