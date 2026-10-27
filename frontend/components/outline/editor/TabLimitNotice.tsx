/**
 * Why a page is shown read only for lack of room: this tab already has as many pages live as its
 * socket takes. When some of them are hidden pages kept only until the page acknowledges what was
 * typed into them (`live-sessions.ts`, TYPING NOT ACKNOWLEDGED), it says so, with the time left
 * until the first of them goes at the latest.
 */
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { OUTLINE_LIVE_LIMITS } from "@shared/outline-live-protocol";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LiveTransport } from "./live-client";
import { liveSessionsWaitingOn } from "./live-sessions";

export function TabLimitNotice({
	transport,
	onRetry,
}: {
	transport: LiveTransport;
	onRetry: () => void;
}) {
	const { t } = useTranslation("outline");
	const [now, setNow] = useState(() => Date.now());
	const waiting = liveSessionsWaitingOn(transport);
	// The time left counts down while some wait (at most the wait for typing, 2 minutes).
	useEffect(() => {
		if (waiting.count === 0) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [waiting.count]);
	const seconds =
		waiting.freeBy === null ? 0 : Math.max(0, Math.ceil((waiting.freeBy - now) / 1000));
	return (
		<Alert variant="light" color="gray" py={6} mb="xs" data-testid="outline-tab-limit">
			<Stack gap={4}>
				<Group gap="xs" wrap="wrap">
					<Text size="sm">
						{t("editor.tabLimit", { count: OUTLINE_LIVE_LIMITS.sessionsPerSocket })}
					</Text>
					<Button size="compact-xs" variant="light" onClick={onRetry}>
						{t("editor.retry")}
					</Button>
				</Group>
				{waiting.count > 0 && (
					<Text size="sm" data-testid="outline-tab-limit-waiting">
						{t("editor.tabLimitWaiting", { count: waiting.count, seconds })}
					</Text>
				)}
			</Stack>
		</Alert>
	);
}
