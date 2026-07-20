import {
	Alert,
	Badge,
	Box,
	Card,
	Group,
	Loader,
	SimpleGrid,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import {
	IconAlertTriangle,
	IconApps,
	IconArrowRight,
	IconDeviceLaptop,
	IconPlugConnected,
	IconPuzzle,
	IconRoute,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { type IntegrationSummary, integrationsApi } from "../../lib/api/integrations";

export const Route = createFileRoute("/settings/integrations")({
	component: SettingsIntegrationsPage,
});

interface SummaryCardProps {
	icon: ReactNode;
	title: string;
	description: string;
	to: string;
	children: ReactNode;
}

function SummaryCard({ icon, title, description, to, children }: SummaryCardProps) {
	return (
		<Card withBorder padding="lg" radius="md" component={Link} to={to} td="none">
			<Stack gap="md">
				<Group justify="space-between" align="flex-start" wrap="nowrap">
					<Group gap="sm" wrap="nowrap">
						<Box c="indigo">{icon}</Box>
						<div>
							<Text fw={600}>{title}</Text>
							<Text size="xs" c="dimmed" mt={2}>
								{description}
							</Text>
						</div>
					</Group>
					<IconArrowRight size={18} color="var(--mantine-color-dimmed)" />
				</Group>
				{children}
			</Stack>
		</Card>
	);
}

function Metric({ label, value, color }: { label: string; value: number; color?: string }) {
	return (
		<div>
			<Text size="xl" fw={700} c={color}>
				{value}
			</Text>
			<Text size="xs" c="dimmed">
				{label}
			</Text>
		</div>
	);
}

function IntegrationCards({ summary }: { summary: IntegrationSummary }) {
	const { t } = useTranslation("settings");
	const admin = summary.admin;

	return (
		<SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
			<SummaryCard
				icon={<IconPlugConnected size={24} />}
				title={t("integrationsConnectedAppsTitle")}
				description={t("integrationsConnectedAppsDescription")}
				to="/settings/connected-apps"
			>
				<Group gap="xl">
					<Metric label={t("integrationsActive")} value={summary.connectedApps.active} />
					<Metric label={t("integrationsRevoked")} value={summary.connectedApps.revoked} />
				</Group>
			</SummaryCard>

			{admin && (
				<>
					<SummaryCard
						icon={<IconPuzzle size={24} />}
						title={t("integrationsPluginsTitle")}
						description={t("integrationsPluginsDescription")}
						to="/settings/plugins"
					>
						<Group gap="xl">
							<Metric label={t("integrationsTotal")} value={admin.plugins.total} />
							<Metric label={t("integrationsEnabled")} value={admin.plugins.enabled} />
							<Metric label={t("integrationsActive")} value={admin.plugins.active} />
							<Metric
								label={t("integrationsNeedsAttention")}
								value={admin.plugins.attention}
								color={admin.plugins.attention > 0 ? "orange" : undefined}
							/>
						</Group>
					</SummaryCard>

					<SummaryCard
						icon={<IconApps size={24} />}
						title={t("integrationsOAuthAppsTitle")}
						description={t("integrationsOAuthAppsDescription")}
						to="/settings/oauth-apps"
					>
						<Group gap="xl">
							<Metric label={t("integrationsActive")} value={admin.oauthClients.active} />
							<Metric label={t("integrationsRevoked")} value={admin.oauthClients.revoked} />
						</Group>
					</SummaryCard>

					<SummaryCard
						icon={<IconDeviceLaptop size={24} />}
						title={t("integrationsDevicesTitle")}
						description={t("integrationsDevicesDescription")}
						to="/settings/devices"
					>
						<Group gap="xl">
							<Metric label={t("deviceOnline")} value={admin.devices.online} />
							<Metric label={t("deviceOffline")} value={admin.devices.offline} />
							<Metric label={t("integrationsOAuthOwned")} value={admin.devices.oauthOwned} />
							<Metric
								label={t("integrationsOrphaned")}
								value={admin.devices.orphaned}
								color={admin.devices.orphaned > 0 ? "orange" : undefined}
							/>
						</Group>
					</SummaryCard>

					<SummaryCard
						icon={<IconRoute size={24} />}
						title={t("integrationsResourcesTitle")}
						description={t("integrationsResourcesDescription")}
						to="/settings/connected-apps"
					>
						<Group gap="xl">
							<Metric
								label={t("integrationsDevicesResource")}
								value={admin.externalResources.devices}
							/>
							<Metric
								label={t("integrationsNarratorsResource")}
								value={admin.externalResources.narrators}
							/>
							<Metric
								label={t("integrationsOrphaned")}
								value={admin.externalResources.orphaned}
								color={admin.externalResources.orphaned > 0 ? "orange" : undefined}
							/>
						</Group>
					</SummaryCard>
				</>
			)}
		</SimpleGrid>
	);
}

function SettingsIntegrationsPage() {
	const { t } = useTranslation("settings");
	const summaryQuery = useQuery({
		queryKey: ["integrations", "summary"],
		queryFn: ({ signal }) => integrationsApi.getIntegrationSummary(signal),
		staleTime: 15_000,
	});

	return (
		<Stack gap="lg" maw={1100}>
			<Box>
				<Title order={3}>{t("integrationsSection")}</Title>
				<Text size="sm" c="dimmed" mt={4} maw={760}>
					{t("integrationsDescription")}
				</Text>
			</Box>

			{summaryQuery.isLoading && (
				<Group justify="center" py="xl">
					<Loader size="sm" />
				</Group>
			)}

			{summaryQuery.isError && (
				<Alert color="red" title={t("integrationsLoadFailed")}>
					{summaryQuery.error instanceof Error
						? summaryQuery.error.message
						: t("integrationsLoadFailed")}
				</Alert>
			)}

			{summaryQuery.data && (
				<>
					<Alert
						color="indigo"
						icon={<IconRoute size={18} />}
						title={t("integrationsCapabilityCatalogTitle")}
					>
						{t("integrationsCapabilityCatalogDescription", {
							oauth: summaryQuery.data.capabilityCatalog.oauth,
							plugin: summaryQuery.data.capabilityCatalog.plugin,
							shared: summaryQuery.data.capabilityCatalog.shared,
						})}
					</Alert>
					{summaryQuery.data.attention.length > 0 && (
						<Stack gap="xs">
							<Text fw={600}>{t("integrationsNeedsAttention")}</Text>
							{summaryQuery.data.attention.map((item) => (
								<Box key={item.id} component={Link} to={item.target} td="none">
									<Alert
										color={item.severity === "critical" ? "red" : "orange"}
										icon={<IconAlertTriangle size={18} />}
									>
										<Group justify="space-between" wrap="nowrap">
											<Text size="sm">{t(`integrationsAttention_${item.id}`)}</Text>
											<Badge color={item.severity === "critical" ? "red" : "orange"}>
												{item.count}
											</Badge>
										</Group>
									</Alert>
								</Box>
							))}
						</Stack>
					)}
					<IntegrationCards summary={summaryQuery.data} />
				</>
			)}
		</Stack>
	);
}
