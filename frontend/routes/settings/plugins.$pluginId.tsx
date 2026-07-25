import {
	Alert,
	Badge,
	Button,
	Code,
	Group,
	Loader,
	Paper,
	Stack,
	Table,
	Tabs,
	Text,
	Title,
} from "@mantine/core";
import {
	IconAlertCircle,
	IconArrowLeft,
	IconPlayerPlay,
	IconPlugConnected,
	IconPlugConnectedX,
	IconRefresh,
	IconTrash,
} from "@tabler/icons-react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "../../components/common/ConfirmDialogProvider";
import { isPluginsDisabledError, localizePluginError } from "../../components/plugins-admin/errors";
import { PluginDiagnosticsPanel } from "../../components/plugins-admin/PluginDiagnosticsPanel";
import { PluginStatusBadge } from "../../components/plugins-admin/PluginStatusBadge";
import { PluginTrustBadges } from "../../components/plugins-admin/PluginTrustBadges";

import {
	useActivatePlugin,
	useDisablePlugin,
	useEnablePlugin,
	usePlugin,
	usePluginDiagnostics,
	useRetryPlugin,
	useUninstallPlugin,
} from "../../hooks/usePlugins";
import type { PluginDetail } from "../../lib/api/plugins";
import { formatLocaleDateTime } from "../../lib/intl-format";

export const Route = createFileRoute("/settings/plugins/$pluginId")({
	component: SettingsPluginDetailPage,
});

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
			<Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>
				{label}
			</Text>
			<div style={{ textAlign: "right", minWidth: 0, wordBreak: "break-word" }}>{children}</div>
		</Group>
	);
}

function OverviewTab({ plugin }: { plugin: PluginDetail }) {
	const { t } = useTranslation("plugins");
	return (
		<Stack gap="md">
			<Paper withBorder p="md" radius="md">
				<Stack gap="xs">
					<Field label={t("admin.detail.overview.pluginId")}>
						<Code>{plugin.pluginId}</Code>
					</Field>
					<Field label={t("admin.detail.overview.displayName")}>
						<Text size="sm">{plugin.displayName ?? "—"}</Text>
					</Field>
					<Field label={t("admin.detail.overview.version")}>
						<Text size="sm">{plugin.current?.version ?? plugin.version ?? "—"}</Text>
					</Field>
					<Field label={t("admin.detail.overview.hash")}>
						<Code>{plugin.current?.hash ?? plugin.hash ?? "—"}</Code>
					</Field>
					<Field label={t("admin.detail.overview.desiredState")}>
						<PluginStatusBadge plugin={plugin} />
					</Field>
					<Field label={t("admin.detail.overview.trustTier")}>
						<PluginTrustBadges trustTier={plugin.trustTier} />
					</Field>
					<Field label={t("admin.detail.overview.crashCount")}>
						<Text size="sm">{plugin.crashCount ?? 0}</Text>
					</Field>
					<Field label={t("admin.detail.overview.restartCount")}>
						<Text size="sm">{plugin.restartCount ?? 0}</Text>
					</Field>
					<Field label={t("admin.detail.overview.consecutiveFailures")}>
						<Text size="sm">{plugin.consecutiveFailures ?? 0}</Text>
					</Field>
				</Stack>
			</Paper>

			<Paper withBorder p="md" radius="md">
				<Text fw={600} size="sm" mb={4}>
					{t("admin.detail.overview.description")}
				</Text>
				<Text size="sm" c={plugin.description ? undefined : "dimmed"}>
					{plugin.description ?? t("admin.detail.overview.noDescription")}
				</Text>
			</Paper>

			{plugin.lastError && (
				<Alert color="red" variant="light" icon={<IconAlertCircle size={18} />}>
					<Text size="sm" fw={500} mb={4}>
						{t("admin.detail.overview.lastError")} · {plugin.lastError.code}
					</Text>
					<Text size="sm" style={{ wordBreak: "break-word" }}>
						{plugin.lastError.message}
					</Text>
				</Alert>
			)}

			{plugin.packages && plugin.packages.length > 0 && (
				<Paper withBorder p="md" radius="md">
					<Text fw={600} size="sm" mb="xs">
						{t("admin.detail.overview.packages")}
					</Text>
					<Stack gap={4}>
						{plugin.packages.map((pkg) => (
							<Group key={`${pkg.version}-${pkg.hash}`} gap="xs" wrap="wrap">
								<Code>{pkg.version ?? "?"}</Code>
								{pkg.isCurrent && (
									<Badge color="green" variant="light" size="sm">
										{t("admin.detail.overview.packageCurrent")}
									</Badge>
								)}
								{pkg.status && (
									<Badge color="gray" variant="outline" size="sm">
										{pkg.status}
									</Badge>
								)}
							</Group>
						))}
					</Stack>
				</Paper>
			)}
		</Stack>
	);
}

function ContributionsTab({ plugin }: { plugin: PluginDetail }) {
	const { t } = useTranslation("plugins");
	const contributions = plugin.contributions ?? [];
	if (contributions.length === 0) {
		return (
			<Text size="sm" c="dimmed">
				{t("admin.detail.contributions.empty")}
			</Text>
		);
	}
	return (
		<Table striped withTableBorder>
			<Table.Thead>
				<Table.Tr>
					<Table.Th>{t("admin.detail.contributions.id")}</Table.Th>
					<Table.Th>{t("admin.detail.contributions.kind")}</Table.Th>
					<Table.Th>{t("admin.detail.contributions.titleColumn")}</Table.Th>
					<Table.Th>{t("admin.detail.contributions.hasSchema")}</Table.Th>
				</Table.Tr>
			</Table.Thead>
			<Table.Tbody>
				{contributions.map((contribution, index) => (
					<Table.Tr key={contribution.fullId ?? contribution.id ?? index}>
						<Table.Td>
							<Code>{contribution.id ?? contribution.fullId ?? "?"}</Code>
						</Table.Td>
						<Table.Td>
							<Text size="sm">{contribution.kind ?? "—"}</Text>
						</Table.Td>
						<Table.Td>
							<Text size="sm">{contribution.title ?? "—"}</Text>
						</Table.Td>
						<Table.Td>
							<Text size="sm">{contribution.hasSchema ? "✓" : "—"}</Text>
						</Table.Td>
					</Table.Tr>
				))}
			</Table.Tbody>
		</Table>
	);
}

function GrantsTab({ plugin }: { plugin: PluginDetail }) {
	const { t } = useTranslation("plugins");
	const grants = plugin.grants;
	const capabilities = grants?.capabilities ?? [];
	return (
		<Stack gap="md">
			<Alert color="blue" variant="light" title={t("admin.detail.grants.readOnlyTitle")}>
				<Text size="sm">{t("admin.detail.grants.readOnlyMessage")}</Text>
			</Alert>
			{grants && (
				<Paper withBorder p="md" radius="md">
					<Stack gap="xs">
						{grants.revision !== undefined && (
							<Field label={t("admin.detail.grants.revision")}>
								<Text size="sm">{grants.revision}</Text>
							</Field>
						)}
						{grants.count !== undefined && (
							<Field label={t("admin.detail.grants.count")}>
								<Text size="sm">{grants.count}</Text>
							</Field>
						)}
						{grants.updatedAt && (
							<Field label={t("admin.detail.grants.updatedAt")}>
								<Text size="sm">{formatLocaleDateTime(grants.updatedAt)}</Text>
							</Field>
						)}
					</Stack>
				</Paper>
			)}
			<div>
				<Text fw={600} size="sm" mb="xs">
					{t("admin.detail.grants.capabilities")}
				</Text>
				{capabilities.length === 0 ? (
					<Text size="sm" c="dimmed">
						{t("admin.detail.grants.empty")}
					</Text>
				) : (
					<Group gap="xs" wrap="wrap">
						{capabilities.map((capability) => (
							<Badge key={capability} color="indigo" variant="light" size="sm">
								{capability}
							</Badge>
						))}
					</Group>
				)}
			</div>
		</Stack>
	);
}

function SettingsPluginDetailPage() {
	const { t } = useTranslation("plugins");
	const { pluginId } = Route.useParams();
	const navigate = useNavigate();
	const confirm = useConfirmDialog();

	const [activeTab, setActiveTab] = useState<string | null>("overview");
	const [actionError, setActionError] = useState<string | null>(null);

	// Detail/diagnostics come from login-only endpoints, so any user may view a
	// plugin. Lifecycle mutations are still enforced by tier server-side.
	const pluginQuery = usePlugin(pluginId);
	const diagnosticsQuery = usePluginDiagnostics(pluginId, {
		enabled: activeTab === "diagnostics",
	});

	const enableMutation = useEnablePlugin();
	const disableMutation = useDisablePlugin();
	const activateMutation = useActivatePlugin();
	const retryMutation = useRetryPlugin();
	const uninstallMutation = useUninstallPlugin();

	const plugin = pluginQuery.data;
	const displayName = plugin?.displayName ?? plugin?.pluginId ?? pluginId;
	const enabled = plugin?.desiredState === "enabled";
	const anyMutationPending =
		enableMutation.isPending ||
		disableMutation.isPending ||
		activateMutation.isPending ||
		retryMutation.isPending ||
		uninstallMutation.isPending;
	const pluginsDisabled = pluginQuery.error && isPluginsDisabledError(pluginQuery.error);

	const runMutation = (mutation: {
		mutate: (id: string, options?: { onError?: (e: unknown) => void }) => void;
	}) => {
		setActionError(null);
		mutation.mutate(pluginId, {
			onError: (error) => setActionError(localizePluginError(error, t)),
		});
	};

	const handleDisable = async () => {
		const confirmed = await confirm({
			title: t("admin.confirm.disableTitle"),
			message: t("admin.confirm.disableMessage", { name: displayName }),
			confirmLabel: t("admin.confirm.confirmLabel"),
			confirmColor: "orange",
		});
		if (confirmed) runMutation(disableMutation);
	};

	const handleUninstall = async () => {
		const confirmed = await confirm({
			title: t("admin.confirm.uninstallTitle"),
			message: t("admin.confirm.uninstallMessage", { name: displayName }),
			confirmLabel: t("admin.confirm.confirmLabel"),
			confirmColor: "red",
		});
		if (!confirmed) return;
		setActionError(null);
		uninstallMutation.mutate(pluginId, {
			onSuccess: () => navigate({ to: "/settings/plugins" }),
			onError: (error) => setActionError(localizePluginError(error, t)),
		});
	};

	return (
		<Stack gap="md">
			<Group justify="space-between" align="flex-start" wrap="wrap">
				<div>
					<Button
						component={Link}
						to="/settings/plugins"
						variant="subtle"
						size="compact-sm"
						leftSection={<IconArrowLeft size={14} />}
						mb={4}
					>
						{t("admin.detail.backToList")}
					</Button>
					<Group gap="sm" align="center">
						<Title order={3}>{displayName}</Title>
						{plugin && <PluginStatusBadge plugin={plugin} />}
						{plugin && <PluginTrustBadges trustTier={plugin.trustTier} />}
					</Group>
				</div>
				{plugin && (
					<Group gap="xs" wrap="wrap">
						{enabled ? (
							<Button
								variant="light"
								color="orange"
								size="xs"
								leftSection={<IconPlugConnectedX size={14} />}
								onClick={handleDisable}
								disabled={anyMutationPending || !!pluginsDisabled}
							>
								{t("admin.actions.disable")}
							</Button>
						) : (
							<Button
								variant="light"
								color="green"
								size="xs"
								leftSection={<IconPlugConnected size={14} />}
								onClick={() => runMutation(enableMutation)}
								disabled={anyMutationPending || !!pluginsDisabled}
							>
								{t("admin.actions.enable")}
							</Button>
						)}
						<Button
							variant="light"
							size="xs"
							leftSection={<IconPlayerPlay size={14} />}
							onClick={() => runMutation(activateMutation)}
							disabled={anyMutationPending || !!pluginsDisabled}
						>
							{t("admin.actions.activate")}
						</Button>
						<Button
							variant="light"
							color="yellow"
							size="xs"
							leftSection={<IconRefresh size={14} />}
							onClick={() => runMutation(retryMutation)}
							disabled={anyMutationPending || !!pluginsDisabled}
						>
							{t("admin.actions.retry")}
						</Button>
						<Button
							variant="light"
							color="red"
							size="xs"
							leftSection={<IconTrash size={14} />}
							onClick={handleUninstall}
							disabled={anyMutationPending || !!pluginsDisabled}
						>
							{t("admin.actions.uninstall")}
						</Button>
					</Group>
				)}
			</Group>

			{pluginsDisabled && (
				<Alert
					color="yellow"
					variant="light"
					icon={<IconAlertCircle size={18} />}
					title={t("admin.disabledBannerTitle")}
				>
					<Text size="sm">{t("admin.disabledBannerMessage")}</Text>
				</Alert>
			)}

			{pluginQuery.error && !pluginsDisabled && (
				<Alert color="red" variant="light" icon={<IconAlertCircle size={18} />}>
					{localizePluginError(pluginQuery.error, t)}
				</Alert>
			)}

			{actionError && (
				<Alert
					color="red"
					variant="light"
					icon={<IconAlertCircle size={18} />}
					withCloseButton
					onClose={() => setActionError(null)}
				>
					{actionError}
				</Alert>
			)}

			{pluginQuery.isLoading ? (
				<Group justify="center" py="xl">
					<Loader size="sm" />
				</Group>
			) : plugin ? (
				<Tabs value={activeTab} onChange={setActiveTab} keepMounted={false}>
					<Tabs.List>
						<Tabs.Tab value="overview">{t("admin.detail.tabs.overview")}</Tabs.Tab>
						<Tabs.Tab value="contributions">{t("admin.detail.tabs.contributions")}</Tabs.Tab>
						<Tabs.Tab value="grants">{t("admin.detail.tabs.grants")}</Tabs.Tab>
						<Tabs.Tab value="diagnostics">
							{t("admin.detail.tabs.diagnostics")}
							{(plugin.diagnosticCount ?? 0) > 0 && (
								<Badge color="red" variant="filled" size="xs" ml={6} circle>
									{plugin.diagnosticCount}
								</Badge>
							)}
						</Tabs.Tab>
					</Tabs.List>

					<Tabs.Panel value="overview" pt="md">
						<OverviewTab plugin={plugin} />
					</Tabs.Panel>
					<Tabs.Panel value="contributions" pt="md">
						<ContributionsTab plugin={plugin} />
					</Tabs.Panel>
					<Tabs.Panel value="grants" pt="md">
						<GrantsTab plugin={plugin} />
					</Tabs.Panel>
					<Tabs.Panel value="diagnostics" pt="md">
						<PluginDiagnosticsPanel
							diagnostics={diagnosticsQuery.data}
							isLoading={diagnosticsQuery.isLoading}
						/>
					</Tabs.Panel>
				</Tabs>
			) : (
				<Alert color="gray" variant="light" icon={<IconAlertCircle size={18} />}>
					{t("admin.detail.notFound")}
				</Alert>
			)}
		</Stack>
	);
}
