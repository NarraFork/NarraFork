import { Badge, Progress, Stack, Text, Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { CodexUsageData, CodexUsageWindow } from "../../lib/api/types";
import { getCodexCreditsDisplay } from "../../lib/codex-credits";
import {
	CODEX_TIER_COLORS,
	getCodexPlanTypeLabel,
	normalizeCodexPlanTier,
} from "../../lib/codex-tiers";
import {
	getCodexUsageWindowLabelKey,
	getCodexUsageWindows,
	sortCodexUsageWindows,
} from "../../lib/codex-usage-windows";
import { relativeTime } from "../../lib/relative-time";

function formatPercent(value: number): string {
	return Number.isFinite(value) ? `${value.toFixed(1)}%` : "-";
}

function progressValue(value: number): number {
	return Math.min(100, Math.max(0, value));
}

function hasFinitePercentages(window: CodexUsageWindow): boolean {
	return Number.isFinite(window.used_percent) && Number.isFinite(window.remaining_percent);
}

function getProgressColor(window: CodexUsageWindow): string {
	if (!Number.isFinite(window.remaining_percent)) return "gray";
	if (window.remaining_percent < 10) return "red";
	if (window.remaining_percent < 30) return "yellow";
	return "green";
}

export function CodexUsageDisplay({ usage }: { usage?: CodexUsageData }) {
	const { t } = useTranslation("settings");

	if (!usage) {
		return (
			<Text size="xs" c="dimmed">
				-
			</Text>
		);
	}

	const planTier = normalizeCodexPlanTier(usage.plan_type);
	const windows = sortCodexUsageWindows(getCodexUsageWindows(usage));
	const creditsDisplay = getCodexCreditsDisplay(usage.credits);
	const resetCreditsAvailable = usage.reset_credits_available;
	const hasResetCredits =
		typeof resetCreditsAvailable === "number" && Number.isFinite(resetCreditsAvailable);
	const formatResetTime = (resetAt: number) => {
		if (!Number.isFinite(resetAt) || resetAt <= 0) return t("codexUsageResetUnknown");
		const timestamp = resetAt * 1000;
		const diff = timestamp - Date.now();
		if (!Number.isFinite(diff)) return t("codexUsageResetUnknown");
		if (diff < 0) return t("codexUsageExpired");
		const totalMinutes = Math.floor(diff / 60_000);
		const days = Math.floor(totalMinutes / 1440);
		const hours = Math.floor((totalMinutes % 1440) / 60);
		const minutes = totalMinutes % 60;
		if (days > 0) return `${days}d ${hours}h ${minutes}m`;
		if (hours > 0) return `${hours}h ${minutes}m`;
		return `${minutes}m`;
	};

	return (
		<Stack gap={4} maw="100%">
			<Badge size="xs" variant="light" color={CODEX_TIER_COLORS[planTier]} w="fit-content">
				{getCodexPlanTypeLabel(t, usage.plan_type)}
			</Badge>

			{creditsDisplay && (
				<Tooltip label={t("codexUsageCreditsFetchedAt", { time: relativeTime(usage.queriedAt) })}>
					<Badge size="xs" variant="light" color="grape" w="fit-content">
						{t("codexUsageCredits")}:{" "}
						{creditsDisplay.kind === "unlimited"
							? t("codexUsageCreditsUnlimited")
							: creditsDisplay.value}
					</Badge>
				</Tooltip>
			)}

			{windows.length === 0 ? (
				<Text size="xs" c="dimmed">
					{t("codexUsageNoWindows")}
				</Text>
			) : (
				windows.map((window) => {
					const windowLabel = t(getCodexUsageWindowLabelKey(window.window_type));
					const usedPercent = formatPercent(window.used_percent);
					const remainingPercent = formatPercent(window.remaining_percent);
					const windowKey = [
						window.window_type,
						window.limit_window_seconds,
						window.reset_at,
						window.used_percent,
						window.remaining_percent,
					].join("-");
					return (
						<Stack key={windowKey} gap={2} maw="100%">
							<Text size="xs" fw={500}>
								{windowLabel}
							</Text>
							<Text size="xs">
								{t("codexUsageRemaining")}: {remainingPercent}
							</Text>
							{hasFinitePercentages(window) && (
								<Progress
									value={progressValue(window.used_percent)}
									size="xs"
									color={getProgressColor(window)}
									aria-label={t("codexUsageProgressLabel", {
										window: windowLabel,
										used: usedPercent,
										remaining: remainingPercent,
									})}
									style={{ width: "100%" }}
								/>
							)}
							<Text size="xs" c="dimmed">
								{t("codexUsageReset")}: {formatResetTime(window.reset_at)}
							</Text>
						</Stack>
					);
				})
			)}

			{hasResetCredits && (
				<Text size="xs">{t("codexUsageResetCredits", { count: resetCreditsAvailable })}</Text>
			)}

			<Text size="xs" c="dimmed">
				{relativeTime(usage.queriedAt)}
			</Text>
		</Stack>
	);
}
