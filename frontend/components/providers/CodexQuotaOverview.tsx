import { Badge, Checkbox, Group, Paper, Progress, SimpleGrid, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	CodexPlanTier,
	CodexUsageForecast,
	CodexUsageSchedulerSnapshot,
	CodexUsageSummary,
	CodexUsageTierStats,
} from "../../lib/api/types";
import {
	CODEX_TIER_COLORS,
	getCodexDisplayTierOrder,
	getCodexTierLabel,
} from "../../lib/codex-tiers";
import {
	CodexQuotaTrendChart,
	formatAccountEquivalent,
	formatResetTimestamp,
} from "./CodexQuotaTrendChart";

function getEmptyCodexUsageTierStats(tier: CodexPlanTier): CodexUsageTierStats {
	return {
		tier,
		accountCount: 0,
		knownUsageCount: 0,
		modeledUsageCount: 0,
		unmodeledUsageCount: 0,
		zeroUsageCount: 0,
		scheduledAccountCount: 0,
		remainingAccountEquivalents: 0,
		averageRemainingPercent: null,
	};
}

function hasCoverageCounts(stat: CodexUsageTierStats): boolean {
	return stat.modeledUsageCount !== undefined && stat.unmodeledUsageCount !== undefined;
}

export function CodexQuotaOverview({
	summary,
	trend,
	scheduler,
	tierOrder,
}: {
	summary: CodexUsageSummary;
	trend: CodexUsageForecast;
	scheduler: CodexUsageSchedulerSnapshot;
	tierOrder: readonly CodexPlanTier[];
}) {
	const { t } = useTranslation("settings");
	const displayTierOrder = getCodexDisplayTierOrder(tierOrder);
	const summaryByTier = (summary.byTier ?? {}) as Partial<
		Record<CodexPlanTier, CodexUsageTierStats>
	>;
	const tiersWithAccounts = displayTierOrder.filter(
		(tier) => (summaryByTier[tier]?.accountCount ?? 0) > 0,
	);
	/**
	 * `null` means "the user has not touched the filter", in which case the
	 * selection follows the tiers that actually have accounts. A tier with zero
	 * accounts only renders a card full of "unknown", so defaulting to every tier
	 * spends a screenful of space saying nothing.
	 *
	 * Following the data until the first interaction also means a tier that gains
	 * its first account shows up on its own; hard-coding the default at mount
	 * would hide it until the panel remounted.
	 */
	const [userSelectedTiers, setUserSelectedTiers] = useState<string[] | null>(null);
	const selectedTierValues = userSelectedTiers ?? tiersWithAccounts;
	const selectedTiers = displayTierOrder.filter((tier) => selectedTierValues.includes(tier));
	const emptySelectionMessage =
		tiersWithAccounts.length === 0
			? t("codexQuotaNoTierWithAccounts")
			: t("codexQuotaNoTierSelected");
	const hasSummaryCoverage =
		summary.totalModeledUsageAccounts !== undefined &&
		summary.totalUnmodeledUsageAccounts !== undefined;

	return (
		<Paper withBorder p="sm">
			<Stack gap="sm">
				<Group justify="space-between" align="flex-start" wrap="wrap">
					<Stack gap={2} style={{ minWidth: 0 }}>
						<Text size="sm" fw={500}>
							{t("codexQuotaOverviewTitle")}
						</Text>
						<Text size="xs" c="dimmed">
							{hasSummaryCoverage
								? t("codexQuotaOverviewCoverageDesc", {
										modeled: summary.totalModeledUsageAccounts ?? 0,
										unmodeled: summary.totalUnmodeledUsageAccounts ?? 0,
										missing: summary.missingUsageAccounts,
									})
								: t("codexQuotaOverviewDesc", {
										known: summary.totalKnownUsageAccounts,
										missing: summary.missingUsageAccounts,
									})}
						</Text>
					</Stack>
					<Stack gap={2} align="flex-end">
						<Badge size="sm" color={scheduler.started ? "green" : "gray"} variant="light">
							{scheduler.started ? t("codexQuotaSchedulerOn") : t("codexQuotaSchedulerOff")}
						</Badge>
						<Text size="xs" c="dimmed">
							{scheduler.nextRunAt
								? t("codexQuotaSchedulerNext", {
										when: formatResetTimestamp(scheduler.nextRunAt),
									})
								: t("codexQuotaSchedulerIdle")}
						</Text>
					</Stack>
				</Group>

				<Stack gap={4}>
					<Text size="xs" c="dimmed">
						{t("codexQuotaVisibleTiers")}
					</Text>
					<Checkbox.Group value={selectedTierValues} onChange={setUserSelectedTiers}>
						<Group gap="xs" wrap="wrap">
							{displayTierOrder.map((tier) => (
								<Checkbox
									key={tier}
									value={tier}
									label={getCodexTierLabel(t, tier)}
									size="xs"
									color={CODEX_TIER_COLORS[tier]}
								/>
							))}
						</Group>
					</Checkbox.Group>
				</Stack>

				{selectedTiers.length === 0 ? (
					<Paper withBorder p="sm">
						<Text size="xs" c="dimmed" ta="center">
							{emptySelectionMessage}
						</Text>
					</Paper>
				) : (
					<SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }} spacing="xs">
						{selectedTiers.map((tier) => {
							const stat = summaryByTier[tier] ?? getEmptyCodexUsageTierStats(tier);
							const average = stat.averageRemainingPercent;
							const hasCoverage = hasCoverageCounts(stat);
							const modeledCount = stat.modeledUsageCount ?? 0;
							const unmodeledCount = stat.unmodeledUsageCount ?? 0;
							const hasModeledQuota = hasCoverage ? modeledCount > 0 : average !== null;
							const resetIsUnknown = hasCoverage ? unmodeledCount > 0 : average === null;
							return (
								<Paper key={tier} data-codex-tier={tier} withBorder p="xs">
									<Stack gap={6}>
										<Group justify="space-between" wrap="nowrap">
											<Badge color={CODEX_TIER_COLORS[tier]} variant="light">
												{getCodexTierLabel(t, tier)}
											</Badge>
											<Text size="xs" c="dimmed">
												{t("codexQuotaAccounts", { count: stat.accountCount })}
											</Text>
										</Group>
										{hasModeledQuota ? (
											<Text size="lg" fw={700}>
												{formatAccountEquivalent(stat.remainingAccountEquivalents)}{" "}
												<Text span size="xs" c="dimmed" fw={400}>
													{t("codexQuotaAccountEquivalent")}
												</Text>
											</Text>
										) : (
											<Text size="sm" fw={600} c="dimmed">
												{t("codexQuotaAmountUnknown")}
											</Text>
										)}
										{!hasModeledQuota || average === null ? (
											<Text size="xs" c="dimmed">
												{t("codexQuotaAverageUnknown")}
											</Text>
										) : (
											<>
												<Progress
													value={average}
													size="xs"
													color={CODEX_TIER_COLORS[tier]}
													aria-label={t("codexQuotaAverageProgressLabel", {
														tier: getCodexTierLabel(t, tier),
														average: average.toFixed(1),
													})}
												/>
												<Text size="xs" c="dimmed">
													{t("codexQuotaAverageRemaining")}: {average.toFixed(1)}%
												</Text>
											</>
										)}
										{hasCoverage ? (
											<Group gap="xs" wrap="wrap">
												<Text size="xs" c="dimmed">
													{t("codexQuotaModeled", { count: modeledCount })}
												</Text>
												{unmodeledCount > 0 && (
													<Text size="xs" c="orange">
														{t("codexQuotaUnmodeled", { count: unmodeledCount })}
													</Text>
												)}
											</Group>
										) : (
											<Text size="xs" c="dimmed">
												{t("codexQuotaKnown", { count: stat.knownUsageCount })}
											</Text>
										)}
										<Text size="xs" c="dimmed">
											{stat.nextResetAt
												? t("codexQuotaNextReset", {
														when: formatResetTimestamp(stat.nextResetAt),
													})
												: resetIsUnknown
													? t("codexQuotaResetUnknown")
													: t("codexQuotaNoResetScheduled")}
										</Text>
										{stat.zeroUsageCount > 0 && (
											<Text size="xs" c="dimmed">
												{t("codexQuotaZeroUsage", { count: stat.zeroUsageCount })}
											</Text>
										)}
									</Stack>
								</Paper>
							);
						})}
					</SimpleGrid>
				)}

				<Stack gap="xs">
					<Group justify="space-between" wrap="wrap">
						<Text size="sm" fw={500}>
							{t("codexQuotaTrendTitle")}
						</Text>
						<Text size="xs" c="dimmed">
							{t("codexQuotaTrendUnit")}
						</Text>
					</Group>
					<CodexQuotaTrendChart
						trend={trend}
						selectedTiers={selectedTiers}
						emptySelectionMessage={emptySelectionMessage}
					/>
				</Stack>
			</Stack>
		</Paper>
	);
}
