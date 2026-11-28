import {
	Badge,
	Group,
	Popover,
	Progress,
	Stack,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatFullLocaleDateTime } from "../../../lib/format";
import { QuotaWindowBars } from "./QuotaWindowBars";
import {
	formatQuotaBadgeText,
	formatQuotaCountdown,
	formatQuotaSummaryLines,
	formatQuotaWindowAmount,
	QUOTA_LEVEL_COLORS,
	type QuotaLevel,
	type QuotaPanelView,
	type QuotaWindowView,
} from "./quota-panel-view";

/** Countdown resolution; minutes are the smallest unit shown. */
const TICK_MS = 30_000;
const CLOSE_DELAY_MS = 150;

/** Re-render periodically while mounted so countdowns stay current. */
export function useQuotaNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
		return () => window.clearInterval(id);
	}, [active]);
	return now;
}

function WindowRow({
	window,
	now,
	locale,
}: {
	window: QuotaWindowView;
	now: number;
	locale: string;
}) {
	const { t } = useTranslation("narrator");
	const color = QUOTA_LEVEL_COLORS[window.level];
	const remaining =
		window.remainingPercent == null
			? t("quotaPanel.remainingUnknown")
			: t("quotaPanel.remainingPercent", { percent: window.remainingPercent });
	const amounts =
		window.used != null && window.limit != null
			? t("quotaPanel.usedOfLimit", {
					used: formatQuotaWindowAmount(window.used, window.unit),
					limit: formatQuotaWindowAmount(window.limit, window.unit),
				})
			: null;
	return (
		<Stack gap={2}>
			<Group justify="space-between" gap="xs" wrap="nowrap">
				<Text size="xs" fw={500}>
					{window.label}
				</Text>
				<Text size="xs" c={window.level === "ok" ? "dimmed" : color}>
					{window.level === "exhausted" ? t("quotaPanel.exhaustedShort") : remaining}
				</Text>
			</Group>
			<Progress
				value={window.usedPercent ?? 0}
				color={color}
				size="sm"
				radius="xl"
				aria-label={`${window.label}: ${remaining}`}
				striped={window.usedPercent == null}
			/>
			<Group justify="space-between" gap="xs" wrap="nowrap">
				<Text size="xs" c="dimmed">
					{amounts ??
						(window.usedPercent == null
							? t("quotaPanel.usedUnknown")
							: t("quotaPanel.usedPercent", { percent: Math.round(window.usedPercent) }))}
				</Text>
				{window.resetAt != null && (
					<Tooltip
						label={window.resetHint ?? formatFullLocaleDateTime(new Date(window.resetAt), locale)}
						withinPortal
					>
						<Text size="xs" c="dimmed">
							{t(window.resetCaptionKey ?? "quotaPanel.resetsIn", {
								time: formatQuotaCountdown(window.resetAt - now, t),
							})}
						</Text>
					</Tooltip>
				)}
			</Group>
			{window.remainingAmount != null && (
				<Text size="xs" c="dimmed">
					{t("quotaSnapshot.remainingAmount", {
						amount: formatQuotaWindowAmount(window.remainingAmount, window.unit),
					})}
				</Text>
			)}
		</Stack>
	);
}

function QuotaDetails({
	view,
	now,
	waitingText,
}: {
	view: QuotaPanelView;
	now: number;
	waitingText: string | null;
}) {
	const { t, i18n } = useTranslation("narrator");
	return (
		<Stack gap="sm" w={260}>
			<Text size="xs" fw={600}>
				{view.title}
			</Text>
			{waitingText && (
				<Text size="xs" c="red">
					{waitingText}
				</Text>
			)}
			{view.expired ? (
				<Text size="xs" c="red">
					{t("quotaSnapshot.expired")}
				</Text>
			) : view.windows.length === 0 ? (
				<Text size="xs" c="dimmed">
					{t("quotaPanel.noWindows")}
				</Text>
			) : null}
			{view.windows.map((window) => (
				<WindowRow key={window.id} window={window} now={now} locale={i18n.language} />
			))}
			{view.rows.map((row) => (
				<Group key={row.label} justify="space-between" gap="xs" wrap="nowrap">
					<Text size="xs" fw={500}>
						{row.label}
					</Text>
					<Text size="xs">{row.value}</Text>
				</Group>
			))}
			{view.failureDetail && (
				<Text size="xs" c="yellow" style={{ overflowWrap: "anywhere" }}>
					{t("quotaPanel.fetchError", { error: view.failureDetail })}
				</Text>
			)}
			{(view.failed || view.fetchedAt > 0) && (
				<Text size="xs" c={view.failed ? "yellow" : "dimmed"}>
					{view.failed
						? t("quotaPanel.staleHint")
						: t("quotaPanel.updatedAt", {
								time: formatFullLocaleDateTime(new Date(view.fetchedAt), i18n.language),
							})}
				</Text>
			)}
		</Stack>
	);
}

export interface QuotaPanelIndicatorProps {
	/** Null renders nothing (nothing to show yet). */
	view: QuotaPanelView | null;
	/**
	 * Clock the view was built with, so badge and countdowns stay in step. Omit
	 * when the view does not depend on the clock; the indicator then ticks its own.
	 */
	now?: number;
	/**
	 * The narrator is parked on this provider's quota wait. Forces the critical
	 * colour so the indicator agrees with the "waiting for quota" status even
	 * before the next refresh reports the window as spent.
	 */
	waitingForQuota?: boolean;
	/** Status text of that wait, e.g. "Waiting for quota · <time>". */
	waitingText?: string | null;
	isMobile?: boolean;
	/** Popover open/close animation in ms; tests pass 0 so no transition is scheduled. */
	transitionDuration?: number;
	/** Provider actions stay separate from the public snapshot display. */
	detailsFooter?: ReactNode;
}

/**
 * Status-bar allowance indicator: one Codex-style vertical bar per window
 * (5-hour, weekly, monthly …) filled to its remaining share — or a text badge
 * while no window is reported — opening a panel with one progress bar per window (remaining share,
 * used/total when known, reset countdown) plus provider-specific rows.
 */
export function QuotaPanelIndicator({
	view,
	now: givenNow,
	waitingForQuota = false,
	waitingText = null,
	isMobile = false,
	transitionDuration,
	detailsFooter,
}: QuotaPanelIndicatorProps) {
	const { t } = useTranslation("narrator");
	const [opened, setOpened] = useState(false);
	const ownNow = useQuotaNow(givenNow === undefined && view != null);
	const now = givenNow ?? ownNow;
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const cancelClose = useCallback(() => {
		if (closeTimer.current) {
			clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
	}, []);
	const scheduleClose = useCallback(() => {
		cancelClose();
		closeTimer.current = setTimeout(() => {
			setOpened(false);
			closeTimer.current = null;
		}, CLOSE_DELAY_MS);
	}, [cancelClose]);
	useEffect(() => () => cancelClose(), [cancelClose]);

	if (!view) return null;
	const level: QuotaLevel = waitingForQuota && view.level !== "exhausted" ? "critical" : view.level;
	const color = QUOTA_LEVEL_COLORS[level];
	const text = formatQuotaBadgeText(view, t);
	const ariaLabel = [view.title, text, ...formatQuotaSummaryLines(view, now, t)].join(". ");

	return (
		<Popover
			opened={opened}
			onChange={setOpened}
			position="top"
			withArrow
			withinPortal
			shadow="md"
			{...(transitionDuration === undefined
				? {}
				: { transitionProps: { duration: transitionDuration } })}
		>
			<Popover.Target>
				<UnstyledButton
					aria-label={ariaLabel}
					aria-expanded={opened}
					onClick={(event) => {
						event.stopPropagation();
						cancelClose();
						setOpened((value) => !value);
					}}
					onPointerEnter={() => {
						if (isMobile) return;
						cancelClose();
						setOpened(true);
					}}
					onPointerLeave={() => {
						if (!isMobile) scheduleClose();
					}}
					style={{
						flexShrink: 0,
						display: "flex",
						alignItems: "center",
						height: 24,
						cursor: "pointer",
					}}
				>
					{view.windows.length > 0 ? (
						<QuotaWindowBars
							bars={view.windows}
							forceLevel={waitingForQuota ? "critical" : undefined}
							stale={view.failed}
						/>
					) : (
						<Badge
							size="sm"
							radius="sm"
							variant={level === "ok" || level === "unknown" ? "light" : "filled"}
							color={color}
							style={{ cursor: "pointer", textTransform: "none" }}
						>
							{text}
						</Badge>
					)}
				</UnstyledButton>
			</Popover.Target>
			<Popover.Dropdown
				onPointerEnter={() => {
					if (!isMobile) cancelClose();
				}}
				onPointerLeave={() => {
					if (!isMobile) scheduleClose();
				}}
			>
				<QuotaDetails view={view} now={now} waitingText={waitingForQuota ? waitingText : null} />
				{detailsFooter}
			</Popover.Dropdown>
		</Popover>
	);
}
