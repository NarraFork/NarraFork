import { Box, Button, Group, Paper, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ModelOption } from "../../lib/constants";
import type { ProviderGroup } from "./ModelOverviewTab";
import { ProviderCard } from "./ProviderCard";

export interface ProviderOverviewViewProps {
	groups: ProviderGroup[];
	hiddenModels: Set<string>;
	onToggleProviderDisabled: (prefix: string) => void;
	onOpenProviderConfig: (prefix: string) => void;
}

export const ProviderOverviewView = React.memo(function ProviderOverviewView({
	groups,
	hiddenModels,
	onToggleProviderDisabled,
	onOpenProviderConfig,
}: ProviderOverviewViewProps) {
	const { t } = useTranslation("settings");

	const stats = useMemo(() => {
		const total = groups.length;
		const enabled = groups.filter((g) => !g.disabled).length;
		const totalModels = groups.reduce((sum, g) => sum + g.models.length, 0);
		const visibleModels = groups.reduce(
			(sum, g) => sum + g.models.filter((m) => !hiddenModels.has(m.value)).length,
			0,
		);
		return { total, enabled, totalModels, visibleModels };
	}, [groups, hiddenModels]);

	const platformGroups = groups.filter((g) => g.isPlatform);
	const customGroups = groups.filter((g) => !g.isPlatform);

	const renderProviderCard = (group: ProviderGroup) => {
		let hiddenCount = 0;
		const previewModels: ModelOption[] = [];
		for (const model of group.models) {
			if (hiddenModels.has(model.value)) {
				hiddenCount += 1;
				continue;
			}
			if (previewModels.length < 3) {
				previewModels.push(model);
			}
		}
		const canOpenConfig = group.isPlatform || !!group.providerId;

		return (
			<ProviderCard
				key={group.providerId ?? group.prefix}
				label={group.label}
				prefix={group.prefix}
				badgeLabel={group.badgeLabel}
				visibleCount={group.models.length - hiddenCount}
				hiddenCount={hiddenCount}
				previewModels={previewModels}
				disabled={group.disabled}
				autoExcluded={group.autoExcluded}
				onToggleDisabled={() => onToggleProviderDisabled(group.prefix)}
				onOpenConfig={
					canOpenConfig ? () => onOpenProviderConfig(group.providerId ?? group.prefix) : undefined
				}
			/>
		);
	};

	return (
		<Stack gap="md">
			{/* Stats bar */}
			<Paper withBorder p="sm">
				<Group justify="space-between" wrap="wrap">
					<Group gap="lg">
						<Box>
							<Text size="xs" c="dimmed">
								{t("providerStatsTotal")}
							</Text>
							<Text fw={600} size="lg">
								{stats.total}
							</Text>
						</Box>
						<Box>
							<Text size="xs" c="dimmed">
								{t("providerStatsEnabled")}
							</Text>
							<Text fw={600} size="lg">
								{stats.enabled}
							</Text>
						</Box>
						<Box>
							<Text size="xs" c="dimmed">
								{t("providerStatsModels")}
							</Text>
							<Text fw={600} size="lg">
								{stats.visibleModels} / {stats.totalModels}
							</Text>
						</Box>
					</Group>
					<Button
						component={Link}
						to="/settings/providers/add"
						variant="light"
						leftSection={<IconPlus size={16} />}
					>
						{t("addProvider")}
					</Button>
				</Group>
			</Paper>

			{/* Platform providers */}
			{platformGroups.length > 0 && (
				<Box>
					<Title order={4} mb="xs">
						{t("providerSectionPlatform")}
					</Title>
					<SimpleGrid minColWidth="min(100%, 16rem)" spacing="sm">
						{platformGroups.map(renderProviderCard)}
					</SimpleGrid>
				</Box>
			)}

			{/* Custom providers */}
			{customGroups.length > 0 && (
				<Box>
					<Title order={4} mb="xs">
						{t("providerSectionCustom")}
					</Title>
					<SimpleGrid minColWidth="min(100%, 16rem)" spacing="sm">
						{customGroups.map(renderProviderCard)}
					</SimpleGrid>
				</Box>
			)}

			{groups.length === 0 && (
				<Paper withBorder p="xl">
					<Text c="dimmed" ta="center">
						{t("overviewNoProviders")}
					</Text>
				</Paper>
			)}
		</Stack>
	);
});
