import { Popover, Stack, Text, UnstyledButton } from "@mantine/core";
import { memo, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	calculateEffectiveTurnElapsedMs,
	formatColonDuration,
	formatFullLocaleDateTime,
} from "../../../lib/format";
import { TruncatedText } from "../../common/TruncatedText";
import type { RetryInfo } from "../useNarratorPanelWS";

/** A clock must update its small display, never the narrator shell or message list. */
function useDisplayClock(enabled: boolean) {
	const [, tick] = useReducer((value: number) => value + 1, 0);
	useEffect(() => {
		if (!enabled) return;
		const timer = setInterval(tick, 1000);
		return () => clearInterval(timer);
	}, [enabled]);
}

export interface TurnElapsedTimeProps {
	turnStartedAt?: string | null | undefined;
	endAt?: string | null | undefined;
	running?: boolean;
	substatus?: readonly string[];
	text?: string | null;
	startedAtLabel?: string | null;
	isMobile: boolean;
}

export const TurnElapsedTime = memo(function TurnElapsedTime({
	turnStartedAt,
	endAt,
	running,
	substatus,
	text: propText,
	startedAtLabel: propStartedAtLabel,
	isMobile,
}: TurnElapsedTimeProps) {
	const { t, i18n } = useTranslation("narrator");
	// Derive from current props during render: switching narrator/turn or stopping
	// must not display the previous turn's cached elapsed value for one commit.
	const elapsedMs =
		turnStartedAt != null
			? calculateEffectiveTurnElapsedMs({
					turnStartedAt,
					endAt: running ? undefined : endAt,
					nowMs: Date.now(),
					substatus,
				})
			: null;
	useDisplayClock(running === true && elapsedMs != null);
	const [opened, setOpened] = useState(false);
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
		}, 150);
	}, [cancelClose]);
	useEffect(() => () => cancelClose(), [cancelClose]);

	let text: string;
	let startedAtLabel: string | null;

	if (propText != null) {
		text = propText;
		startedAtLabel = propStartedAtLabel ?? null;
	} else {
		if (elapsedMs == null) return null;
		const duration = formatColonDuration(elapsedMs / 1000);
		text = running ? duration : `· ${t("lastTurnDuration", { duration })}`;
		const startedAt = turnStartedAt ? formatFullLocaleDateTime(turnStartedAt, i18n.language) : null;
		startedAtLabel = startedAt ? t("toolStartedAt", { time: startedAt }) : null;
	}

	// Without a popover, TruncatedText supplies the overflow reveal affordance.
	if (!startedAtLabel)
		return <TruncatedText size="xs" c="dimmed" text={text} style={{ maxWidth: "100%" }} />;

	return (
		<Popover opened={opened} onChange={setOpened} position="top" withArrow withinPortal shadow="md">
			<Popover.Target>
				<UnstyledButton
					type="button"
					onClick={(event) => {
						event.stopPropagation();
						cancelClose();
						setOpened((value) => !value);
					}}
					onPointerDown={(event) => event.stopPropagation()}
					onPointerEnter={() => {
						if (!isMobile) {
							cancelClose();
							setOpened(true);
						}
					}}
					onPointerLeave={() => {
						if (!isMobile) scheduleClose();
					}}
					aria-label={`${text}, ${startedAtLabel}`}
					style={{ display: "inline-flex", minWidth: 0, maxWidth: "100%", cursor: "pointer" }}
				>
					<Text size="xs" c="dimmed" truncate style={{ minWidth: 0, maxWidth: "100%" }}>
						{text}
					</Text>
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
				<Stack gap={2}>
					<Text size="xs" style={{ overflowWrap: "anywhere" }}>
						{text}
					</Text>
					<Text size="xs" c="dimmed">
						{startedAtLabel}
					</Text>
				</Stack>
			</Popover.Dropdown>
		</Popover>
	);
});

/** Countdown and overflow tooltip share the same live string. */
export const RetryCountdownText = memo(function RetryCountdownText({
	retryInfo,
	color,
}: {
	retryInfo: RetryInfo | null;
	color: string;
}) {
	const { t } = useTranslation("narrator");
	const remaining = retryInfo ? Math.max(0, Math.ceil((retryInfo.retryAt - Date.now()) / 1000)) : 0;
	useDisplayClock(remaining > 0);
	const params = {
		count: retryInfo?.retryCount,
		max: retryInfo?.maxRetries === -1 ? "∞" : retryInfo?.maxRetries,
	};
	const text =
		remaining > 0
			? t("retryingCountdown", { ...params, seconds: remaining })
			: t("retryingNow", params);
	return <TruncatedText size="xs" c={color} text={text} />;
});
