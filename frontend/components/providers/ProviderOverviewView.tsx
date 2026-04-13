import { Box, Grid, Group, Menu, Paper, Stack, Text, Title } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ProviderGroup } from "./ModelOverviewTab";
import { ProviderCard } from "./ProviderCard";
import type { ProviderStatus } from "./ProviderStatusBadge";

export interface ProviderOverviewViewProps {
	groups: ProviderGroup[];
	hiddenModels: Set<string>;
	onToggleProviderDisabled: (prefix: string) => void;
	onOpenProviderConfig: (prefix: string) => void;
	selectedProvider: string | null;
}

export const ProviderOverviewView = React.memo(function ProviderOverviewView({
	groups,
	hiddenModels,
	onToggleProviderDisabled,
	onOpenProviderConfig,
	onAddProvider,
	selectedProvider,
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

	const getProviderStatus = (group: ProviderGroup): ProviderStatus => {
		if (group.disabled) return "disabled";
		if (group.models.length === 0) return "unverified";
		return "connected";
	};

	const renderProviderCard = (group: ProviderGroup) => {
		const hiddenCount = group.models.filter((m) => hiddenModels.has(m.value)).length;
		const status = getProviderStatus(group);
		const visibleModelsList = group.models
			.filter((m) => !hiddenModels.has(m.value))
			.map((m) => m.label);

		return (
			<Grid.Col key={group.prefix} span={{ base: 12, sm: 6, md: 4, lg: 3 }}>
				<ProviderCard
					label={group.label}
					type={group.isPlatform ? "platform" : "custom"}
					badgeLabel={group.badgeLabel}
					status={status}
					modelCount={group.models.length}
					hiddenCount={hiddenCount}
					visibleModels={visibleModelsList}
					disabled={group.disabled}
					onToggleDisabled={() => onToggleProviderDisabled(group.prefix)}
					onOpenConfig={() => onOpenProviderConfig(group.providerId ?? group.prefix)}
					isSelected={selectedProvider === (group.providerId ?? group.prefix)}
				/>
			</Grid.Col>
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
					<Menu position="bottom-end">
						<Menu.Target>
							<Group gap="xs" style={{ cursor: "pointer" }} c="indigo">
								<IconPlus size={16} />
								<Text size="sm">{t("addProvider")}</Text>
							</Group>
						</Menu.Target>
						<Menu.Dropdown>
							<Menu.Item onClick={() => onAddProvider("openai")}>
								{t("addProviderOpenai")}
							</Menu.Item>
							<Menu.Item onClick={() => onAddProvider("anthropic")}>
								{t("addProviderAnthropic")}
							</Menu.Item>
							<Menu.Item onClick={() => onAddProvider("nug")}>{t("addProviderNug")}</Menu.Item>
						</Menu.Dropdown>
					</Menu>
				</Group>
			</Paper>

			{/* Platform providers */}
			{platformGroups.length > 0 && (
				<Box style={{ overflow: "hidden" }}>
					<Title order={4} mb="xs">
						{t("providerSectionPlatform")}
					</Title>
					<Grid>{platformGroups.map(renderProviderCard)}</Grid>
				</Box>
			)}

			{/* Custom providers */}
			{customGroups.length > 0 && (
				<Box style={{ overflow: "hidden" }}>
					<Title order={4} mb="xs">
						{t("providerSectionCustom")}
					</Title>
					<Grid>{customGroups.map(renderProviderCard)}</Grid>
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
