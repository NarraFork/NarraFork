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
import { useOutlineLinkProps } from "@frontend/lib/outline-opener";
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
import type {
	TaskNoticeChip,
	TaskNoticeData,
	TaskNoticeRow,
	TaskNoticeVariant,
} from "@shared/pretext-layout/task-notice";
import {
	IconAlertTriangle,
	IconChevronDown,
	IconChevronRight,
	IconClockPause,
	IconDownload,
	IconEraser,
	IconFileSearch,
	IconGitFork,
	IconListCheck,
	IconLock,
	IconMessageReply,
	IconNetwork,
	IconPhotoOff,
	IconPlayerPause,
	IconRepeat,
	IconRestore,
	IconTrash,
	IconUserEdit,
} from "@tabler/icons-react";
import { type MouseEvent, type ReactNode, useMemo } from "react";
import {
	BUTTON_COMPACT_XS,
	CARD_PADDING,
	GROUP_GAP,
	ICON_16,
	ICON_MARGIN_TOP,
	KIND_CHROME,
	type MeasuredTaskNotice,
	ORIGIN_HEADING_GAP,
	STACK_GAP,
	type SystemTextData,
	type SystemTextKind,
	TASK_NOTICE_ROW_GAP,
	taskNoticeLineHeight,
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
	/**
	 * Why the buttons without a handler are off (an outline session's old card, outline P2
	 * PR 12a), shown on hover or tap. Such a button keeps its place and look (Mantine's disabled
	 * style through `data-disabled`, so the pointer still reaches it); nothing is measured
	 * differently.
	 */
	readOnlyHint?: string;
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
	/** Open details for the exact failed request, never the latest narrator request. */
	onViewRequest?: () => void;
	onDownloadDump?: () => void;
	downloadingDump?: boolean;
	/** Another error request is currently being downloaded in this narrator. */
	downloadDumpDisabled?: boolean;
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
	/** tasks_notice: fold / unfold the card (the generic per-key expansion). */
	onToggle?: () => void;
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
	onToggle,
}: RenderSystemTextProps) {
	// A task notice has no wrapping body: its lines are fixed, so it is drawn from its data and
	// the measured line count alone.
	if (kind === "tasks_notice") {
		return (
			<TaskNoticeCard
				measured={measured as MeasuredTaskNotice}
				data={data as unknown as TaskNoticeData & { timeLabel?: string }}
				guardActions={injectionGuardActions}
				onToggle={onToggle}
			/>
		);
	}
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
	const viewRequestLabel = labelFor("viewErrorRequest");
	const downloadDumpLabel = labelFor("downloadErrorDump");
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
				{showActions && (viewRequestLabel || downloadDumpLabel) ? (
					<Group gap={GROUP_GAP} wrap="nowrap">
						{viewRequestLabel ? (
							<Tooltip label={viewRequestLabel}>
								<Button
									size="compact-xs"
									h={BUTTON_COMPACT_XS}
									variant="light"
									color="blue"
									style={{ flex: 1, minWidth: 0 }}
									leftSection={<IconFileSearch size={12} />}
									disabled={!actions?.onViewRequest}
									onClick={actions?.onViewRequest}
								>
									{viewRequestLabel}
								</Button>
							</Tooltip>
						) : null}
						{downloadDumpLabel ? (
							<Tooltip label={downloadDumpLabel}>
								<Button
									size="compact-xs"
									h={BUTTON_COMPACT_XS}
									variant="light"
									color="blue"
									style={{ flex: 1, minWidth: 0 }}
									leftSection={<IconDownload size={12} />}
									loading={actions?.downloadingDump === true}
									disabled={!actions?.onDownloadDump || actions.downloadDumpDisabled === true}
									onClick={actions?.onDownloadDump}
								>
									{downloadDumpLabel}
								</Button>
							</Tooltip>
						) : null}
					</Group>
				) : null}
				{showActions && (fixLabel || modelTestLabel) ? (
					// One row for both: the measure layer reserves a single
					// BUTTON_COMPACT_XS row whenever any button qualifies, so a second
					// button must cost width rather than height.
					<Group gap={GROUP_GAP} wrap="nowrap">
						{fixLabel ? (
							<Button
								size="compact-xs"
								h={BUTTON_COMPACT_XS}
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
								h={BUTTON_COMPACT_XS}
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
						const hint = !onClick ? actions?.readOnlyHint : undefined;
						if (hint)
							return (
								<Tooltip
									// biome-ignore lint/suspicious/noArrayIndexKey: buttons are a stable ordered list
									key={i}
									label={hint}
									events={{ hover: true, focus: true, touch: true }}
									multiline
									maw={260}
								>
									<Button
										size="compact-xs"
										variant={i === 0 ? "subtle" : "light"}
										color={buttonColors[i] ?? color}
										leftSection={buttonIcons[i]}
										data-disabled
										aria-disabled
										data-readonly-spec-action=""
										onClick={(event) => event.preventDefault()}
									>
										{label}
									</Button>
								</Tooltip>
							);
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

// ── tasks_notice: Stack(heading line + task lines when unfolded) ──────────────
// Geometry mirrors measureTaskNotice: Paper p="xs", one heading line of
// `taskNoticeLineHeight()`, then — unfolded — ORIGIN_HEADING_GAP and one line per
// task with TASK_NOTICE_ROW_GAP between them. Every line is single and truncated
// (the full title is the link's tooltip), so nothing here can wrap past the box.

/** The indent of a row under the one before it (a question's answer). */
const TASK_NOTICE_INDENT = 16;

const TASK_NOTICE_ICON: Record<TaskNoticeVariant, typeof IconListCheck> = {
	turnEnd: IconClockPause,
	edited: IconUserEdit,
	interrupt: IconPlayerPause,
	view: IconListCheck,
	answers: IconMessageReply,
};

/** The reader's xs text, at the transcript's live typography (measure uses the same line). */
function noticeText(): { font: string; lineHeight: string } {
	return {
		font: typographyMetrics().font.xs,
		lineHeight: `${typographyMetrics().line.xs}px`,
	};
}

const NOWRAP_ELLIPSIS = {
	whiteSpace: "nowrap",
	overflow: "hidden",
	textOverflow: "ellipsis",
	minWidth: 0,
} as const;

/** A click on a link or a button inside the heading does its own thing, not the fold. */
function fromControl(event: MouseEvent<HTMLElement>): boolean {
	const target = event.target as HTMLElement | null;
	return !!target?.closest?.("a,button");
}

/**
 * Below this inner width (a phone) the folded line keeps only what names the task: the time label,
 * the tail ("等 2 项", "还没勾成完成") and a lead beside a task ("2 个未完成：") are left out; the
 * chevron and the chip say as much.
 */
const TASK_NOTICE_NARROW_WIDTH = 420;

/**
 * Width priorities, narrowest screens first (every line is one line, so none of this moves a
 * height): a task's title keeps at least about six characters (`taskTitleMinWidth`); on the folded
 * line the heading gives way before it (it shrinks eight times as fast, and never takes more than
 * `HEADING_MAX_WIDTH`), and so do the lead and the tail; on a row, the note takes only the width
 * the title leaves.
 */
const HEADING_MAX_WIDTH = "45%";

/**
 * The title's minimum width: six characters' worth, never more than half the line, and never more
 * than its own text (a short title must not leave a gap after it). The text's width is estimated
 * from its characters (CJK as 1em, a space as 0.3em, others as 0.6em): it only bounds a minimum,
 * nothing measured.
 */
function taskTitleMinWidth(title: string): string {
	return `min(${emEstimate(title, 6).toFixed(1)}em, 50%)`;
}

/** A rough width for `text` in em, up to `cap`: CJK 1em, a space 0.3em, anything else 0.6em. */
function emEstimate(text: string, cap: number): number {
	let em = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		em += code >= 0x2e80 ? 1 : char === " " ? 0.3 : 0.6;
		if (em >= cap) break;
	}
	return Math.min(cap, em);
}

function TaskNoticeCard({
	measured,
	data,
	guardActions,
	onToggle,
}: {
	measured: MeasuredTaskNotice;
	data: TaskNoticeData & { timeLabel?: string };
	guardActions?: InjectionGuardActions;
	onToggle?: () => void;
}) {
	const line = taskNoticeLineHeight();
	const expanded = measured.expanded === true;
	const rows = expanded ? (data.rows ?? []).slice(0, measured.rowCount) : [];
	const toggle = data.expandable === true && onToggle ? onToggle : undefined;
	const Icon = TASK_NOTICE_ICON[data.variant] ?? IconListCheck;
	// Height-neutral: the label and the tail sit in the one heading line either way.
	const narrow = measured.contentWidth < TASK_NOTICE_NARROW_WIDTH;
	// The answer takes the folded line's room only where it is drawn: on a phone the tail is left
	// out (#332's narrow rule), so the heading keeps who answered and how many.
	const answerFirst = !expanded && !narrow && data.summary?.tailFirst === true;
	const timeLabel = typeof data.timeLabel === "string" && !narrow ? data.timeLabel : "";
	const Chevron = expanded ? IconChevronDown : IconChevronRight;
	return (
		<Paper
			p="xs"
			radius="sm"
			data-task-notice={data.variant}
			style={{
				backgroundColor: SYSTEM_MESSAGE_BG,
				height: measured.height,
				boxSizing: "border-box",
				overflow: "hidden",
			}}
		>
			{/* The whole heading is a pointer shortcut for the chevron button at its end, which is
			    the keyboard / assistive-technology control (it carries aria-expanded). */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: the chevron button is the accessible control */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: the chevron button is the accessible control */}
			<div
				data-task-notice-head=""
				onClick={
					toggle
						? (event: MouseEvent<HTMLDivElement>) => {
								if (!fromControl(event)) toggle();
							}
						: undefined
				}
				style={{
					display: "flex",
					alignItems: "center",
					gap: GROUP_GAP,
					height: line,
					minWidth: 0,
					cursor: toggle ? "pointer" : undefined,
				}}
			>
				<Icon
					size={13}
					stroke={1.6}
					style={{ flexShrink: 0, color: "var(--mantine-color-dimmed)" }}
				/>
				<span
					data-task-notice-title=""
					style={{
						...noticeText(),
						...NOWRAP_ELLIPSIS,
						fontWeight: 600,
						color: "var(--mantine-color-dimmed)",
						// Folded, the heading yields its width to the task; unfolded, it has the line.
						flex: expanded ? "0 1 auto" : "0 8 auto",
						maxWidth: expanded ? undefined : HEADING_MAX_WIDTH,
						// Beside an answer it keeps who answered and how many, and gives the rest up.
						...(answerFirst ? { minWidth: "min(7em, 30%)" } : {}),
					}}
				>
					{data.title}
				</span>
				<div
					data-task-notice-summary=""
					style={{
						// The folded line's tail is what the notice is for (an answer): the summary
						// claims the line's room from the heading, not only what the heading leaves.
						flex: answerFirst ? "1 1 auto" : "1 1 0",
						minWidth: 0,
						display: "flex",
						alignItems: "center",
						gap: GROUP_GAP,
						overflow: "hidden",
					}}
				>
					{expanded ? null : <TaskNoticeSummaryLine data={data} narrow={narrow} />}
				</div>
				{timeLabel ? (
					<span
						data-task-notice-time=""
						style={{
							...noticeText(),
							whiteSpace: "nowrap",
							flexShrink: 0,
							color: "var(--mantine-color-dimmed)",
						}}
					>
						{timeLabel}
					</span>
				) : null}
				{guardActions ? (
					<Tooltip label={guardActions.dismissLabel ?? ""} disabled={!guardActions.dismissLabel}>
						<CloseButton
							size="xs"
							variant="subtle"
							c="dimmed"
							style={{ flexShrink: 0, height: line, minHeight: line }}
							aria-label={guardActions.dismissLabel}
							disabled={!guardActions.onDismiss || guardActions.dismissing === true}
							onClick={(event) => {
								event.stopPropagation();
								guardActions.onDismiss?.();
							}}
						/>
					</Tooltip>
				) : null}
				{toggle ? (
					<ActionIcon
						size="xs"
						variant="subtle"
						color="gray"
						aria-expanded={expanded}
						aria-label={data.title}
						data-task-notice-toggle=""
						style={{ flexShrink: 0, height: line, minHeight: line }}
						onClick={(event) => {
							event.stopPropagation();
							toggle();
						}}
					>
						<Chevron size={12} />
					</ActionIcon>
				) : null}
			</div>
			{rows.length > 0 ? (
				<div
					data-task-notice-rows=""
					style={{
						display: "flex",
						flexDirection: "column",
						gap: TASK_NOTICE_ROW_GAP,
						marginTop: ORIGIN_HEADING_GAP,
					}}
				>
					{rows.map((row, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: rows are a stable ordered list
						<TaskNoticeRowView key={index} row={row} line={line} />
					))}
				</div>
			) : null}
		</Paper>
	);
}

/**
 * The folded line after the heading: a lead, the first task (its status as it is now, and its
 * title), a tail. Where it changed from and what changed are the unfolded row's; the heading
 * already names who changed it.
 */
function TaskNoticeSummaryLine({ data, narrow }: { data: TaskNoticeData; narrow: boolean }) {
	const { lead, row, tail, tailFirst } = data.summary ?? {};
	const dim = {
		...noticeText(),
		...NOWRAP_ELLIPSIS,
		flex: "0 4 auto",
		color: "var(--mantine-color-dimmed)",
	};
	return (
		<>
			{/* On a phone a lead beside a task ("2 个未完成：") would only be cut to "2…": it is left
			    out like the tail, the chevron opens the list. A lead that is the whole line stays. */}
			{lead && !(narrow && row) ? (
				<span style={dim} data-task-notice-lead="">
					{lead}
				</span>
			) : null}
			{row ? (
				<>
					{row.status ? <StatusChip chip={row.status} /> : null}
					<TaskNoticeTitle row={row} yieldTo={tailFirst === true && !!tail && !narrow} />
				</>
			) : null}
			{tail && !narrow ? (
				// Kept readable beside a long title: the title is truncated first. A tail that is
				// what the notice is for (an answer) keeps most of the line.
				<span
					style={
						tailFirst
							? {
									...dim,
									// All of it, up to the whole summary but a question's chip and a few
									// characters of it (then truncated, in full on hover): the question
									// gives way instead.
									flex: "0 0 auto",
									maxWidth: `calc(100% - ${row?.status ? 5 : 2.5}em)`,
									color: "var(--mantine-color-text)",
								}
							: { ...dim, minWidth: "3em" }
					}
					title={tailFirst ? tail : undefined}
					data-task-notice-tail=""
				>
					{tail}
				</span>
			) : null}
		</>
	);
}

function TaskNoticeRowView({ row, line }: { row: TaskNoticeRow; line: number }) {
	if (row.dim) {
		return (
			<div
				data-task-notice-row="more"
				style={{
					...noticeText(),
					...NOWRAP_ELLIPSIS,
					height: line,
					display: "flex",
					alignItems: "center",
					color: "var(--mantine-color-dimmed)",
				}}
			>
				{row.title}
			</div>
		);
	}
	return (
		<div
			data-task-notice-row=""
			style={{
				display: "flex",
				alignItems: "center",
				gap: GROUP_GAP,
				height: line,
				minWidth: 0,
				overflow: "hidden",
				// Under the row before it (a question's answer), still one line.
				...(row.indent ? { paddingLeft: TASK_NOTICE_INDENT } : {}),
			}}
		>
			{row.lead ? (
				<span
					data-task-notice-by=""
					title={row.lead}
					style={{
						...noticeText(),
						...NOWRAP_ELLIPSIS,
						// Whole up to a third of the row: a short name never gives way to the title.
						flex: "0 0 auto",
						maxWidth: "33%",
						color: "var(--mantine-color-dimmed)",
					}}
				>
					{row.lead}
				</span>
			) : null}
			{row.statusFrom && row.status ? (
				<>
					<StatusChip chip={row.statusFrom} />
					<span style={{ ...noticeText(), color: "var(--mantine-color-dimmed)", flexShrink: 0 }}>
						→
					</span>
				</>
			) : null}
			{row.status ? <StatusChip chip={row.status} /> : null}
			<TaskNoticeTitle row={row} />
			{(row.marks ?? []).map((mark) => (
				<Badge
					key={mark}
					size="xs"
					// Outlined: a light gray chip has the card's own background and vanishes.
					variant="outline"
					color="gray"
					tt="none"
					title={mark}
					// Whole while the row has room; on a narrow row it gives way after the title has
					// (truncated, in full on hover) rather than being cut at the row's edge.
					style={{ flex: "0 1 auto", minWidth: "3em" }}
				>
					{mark}
				</Badge>
			))}
			{row.note ? (
				<span
					data-task-notice-note=""
					title={row.note}
					style={{
						...noticeText(),
						...NOWRAP_ELLIPSIS,
						// The title keeps its width before the note does: the note takes what is left.
						flex: "1 1 0",
						color: "var(--mantine-color-dimmed)",
					}}
				>
					{row.note}
				</span>
			) : null}
		</div>
	);
}

function StatusChip({ chip }: { chip: TaskNoticeChip }) {
	return (
		<Badge
			size="xs"
			// A gray chip is outlined: a light gray one has the card's own background.
			variant={chip.color === "gray" ? "outline" : "light"}
			color={chip.color}
			tt="none"
			data-task-notice-status=""
			style={{ flexShrink: 0 }}
		>
			{chip.label}
		</Badge>
	);
}

/**
 * The task's title: an outline link inside a host that opens outline panels (beside the session,
 * Ctrl/Cmd for a new panel), plain text anywhere else. Truncated to its line, never below
 * `taskTitleMinWidth`; the full title and its address are the tooltip.
 */
function TaskNoticeTitle({ row, yieldTo = false }: { row: TaskNoticeRow; yieldTo?: boolean }) {
	const link = useOutlineLinkProps(row.href);
	const tooltip =
		row.address && row.address !== row.title ? `${row.title}\n${row.address}` : row.title;
	const style = {
		...noticeText(),
		...NOWRAP_ELLIPSIS,
		// Beside a tail that matters more (an answer), the title gives way first.
		flex: yieldTo ? "0 8 auto" : "0 1 auto",
		minWidth: yieldTo ? "min(1.5em, 10%)" : taskTitleMinWidth(row.title),
	} as const;
	if (link) {
		return (
			<a
				href={link.href}
				onClick={link.onClick}
				data-outline-link=""
				data-task-notice-task=""
				title={tooltip}
				style={{ ...style, color: "var(--mantine-color-teal-text)", textDecoration: "none" }}
			>
				{row.title}
			</a>
		);
	}
	return (
		<span
			title={tooltip}
			data-task-notice-task=""
			style={{ ...style, color: "var(--mantine-color-text)" }}
		>
			{row.title}
		</span>
	);
}
