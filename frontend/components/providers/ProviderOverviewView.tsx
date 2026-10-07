import {
	Badge,
	Box,
	Button,
	Card,
	Grid,
	Group,
	Modal,
	Paper,
	SimpleGrid,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProviderGroup } from "./ModelOverviewTab";
import { ProviderCard } from "./ProviderCard";
import type { ProviderStatus } from "./ProviderStatusBadge";
import type { CustomApiProtocol } from "./types";

export type AddProviderType = "nug" | CustomApiProtocol;

const ADD_PROVIDER_OPTIONS: Array<{
	type: AddProviderType;
	labelKey: string;
	badgeKey: string;
	descriptionKey: string;
	hintKey: string;
	color: string;
	recommendKey?: string;
	transportKey?: string;
}> = [
	{
		type: "anthropic-messages",
		labelKey: "addProviderAnthropicMessages",
		badgeKey: "addProviderBadgeAnthropic",
		descriptionKey: "addProviderAnthropicMessagesDesc",
		hintKey: "addProviderAnthropicMessagesHint",
		color: "green",
		recommendKey: "addProviderRecommendedChineseModels",
	},
	{
		type: "openai-responses",
		labelKey: "addProviderOpenAIResponses",
		badgeKey: "addProviderBadgeOpenAI",
		descriptionKey: "addProviderOpenAIResponsesDesc",
		hintKey: "addProviderOpenAIResponsesHint",
		color: "violet",
	},
	{
		type: "completions-compatible",
		labelKey: "addProviderCompletions",
		badgeKey: "addProviderBadgeOpenAI",
		descriptionKey: "addProviderCompletionsDesc",
		hintKey: "addProviderCompletionsHint",
		color: "blue",
	},
	{
		type: "nug",
		labelKey: "addProviderNug",
		badgeKey: "addProviderBadgeGateway",
		descriptionKey: "addProviderNugDesc",
		hintKey: "addProviderNugHint",
		color: "indigo",
	},
	{
		type: "gemini-compatible",
		labelKey: "addProviderGemini",
		badgeKey: "addProviderBadgeGemini",
		descriptionKey: "addProviderGeminiDesc",
		hintKey: "addProviderGeminiHint",
		transportKey: "addProviderGeminiTransportNote",
		color: "grape",
	},
];

export interface ProviderOverviewViewProps {
	groups: ProviderGroup[];
	hiddenModels: Set<string>;
	onToggleProviderDisabled: (prefix: string) => void;
	onOpenProviderConfig: (prefix: string) => void;
	onAddProvider: (type: AddProviderType) => void;
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
	const [addProviderOpened, setAddProviderOpened] = useState(false);

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

	const handleSelectProviderType = (type: AddProviderType) => {
		setAddProviderOpened(false);
		onAddProvider(type);
	};

	const renderProviderCard = (group: ProviderGroup) => {
		let hiddenCount = 0;
		const previewModels: string[] = [];
		for (const model of group.models) {
			if (hiddenModels.has(model.value)) {
				hiddenCount += 1;
				continue;
			}
			if (previewModels.length < 3) {
				previewModels.push(model.label);
			}
		}
		const visibleCount = group.models.length - hiddenCount;
		const status = getProviderStatus(group);

		return (
			<Grid.Col key={group.prefix} span={{ base: 12, sm: 6, md: 4, lg: 3 }}>
				<ProviderCard
					label={group.label}
					type={group.isPlatform ? "platform" : "custom"}
					badgeLabel={group.badgeLabel}
					status={status}
					visibleCount={visibleCount}
					hiddenCount={hiddenCount}
					previewModels={previewModels}
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
					<Button
						variant="light"
						leftSection={<IconPlus size={16} />}
						onClick={() => setAddProviderOpened(true)}
					>
						{t("addProvider")}
					</Button>
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

			<Modal
				opened={addProviderOpened}
				onClose={() => setAddProviderOpened(false)}
				title={t("addProviderModalTitle")}
				size="xl"
				centered
			>
				<Stack gap="md">
					<Text size="sm" c="dimmed">
						{t("addProviderModalDesc")}
					</Text>
					<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
						{ADD_PROVIDER_OPTIONS.map((option) => (
							<Card
								key={option.type}
								className="provider-add-card"
								withBorder
								padding="sm"
								radius="md"
								onClick={() => handleSelectProviderType(option.type)}
								onKeyDown={(event) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										handleSelectProviderType(option.type);
									}
								}}
								role="button"
								tabIndex={0}
								style={{
									height: "100%",
									cursor: "pointer",
									transition: "border-color 150ms ease, box-shadow 150ms ease",
								}}
							>
								<Stack gap="xs" style={{ height: "100%" }}>
									<Group justify="space-between" align="flex-start" gap="xs" wrap="nowrap">
										<Box style={{ minWidth: 0 }}>
											<Text fw={600} size="sm" truncate>
												{t(option.labelKey)}
											</Text>
										</Box>
										<Badge size="xs" variant="light" color={option.color} style={{ flexShrink: 0 }}>
											{t(option.badgeKey)}
										</Badge>
									</Group>
									{option.recommendKey && (
										<Badge
											size="xs"
											variant="outline"
											color="green"
											style={{ alignSelf: "flex-start" }}
										>
											{t(option.recommendKey)}
										</Badge>
									)}
									<Text size="xs" c="dimmed" style={{ lineHeight: 1.45 }}>
										{t(option.descriptionKey)}
									</Text>
									{option.transportKey && (
										<Badge
											size="xs"
											variant="light"
											color="grape"
											style={{ alignSelf: "flex-start" }}
										>
											{t(option.transportKey)}
										</Badge>
									)}
									<Text size="xs" c="dimmed" fs="italic" style={{ marginTop: "auto" }}>
										{t(option.hintKey)}
									</Text>
								</Stack>
							</Card>
						))}
					</SimpleGrid>
				</Stack>
			</Modal>

			<style>{`
				.provider-add-card:hover,
				.provider-add-card:focus-visible {
					border-color: var(--mantine-color-indigo-5);
					box-shadow: 0 0 0 1px var(--mantine-color-indigo-5);
				}
			`}</style>
		</Stack>
	);
});
