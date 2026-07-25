import {
	ActionIcon,
	Alert,
	Badge,
	Box,
	Button,
	Group,
	Loader,
	Paper,
	Stack,
	Table,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import {
	IconAlertCircle,
	IconDownload,
	IconPlugConnected,
	IconPlugConnectedX,
	IconRefresh,
	IconSearch,
	IconTrash,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "../../components/common/ConfirmDialogProvider";
import { isPluginsDisabledError, localizePluginError } from "../../components/plugins-admin/errors";
import { PluginInstallModal } from "../../components/plugins-admin/PluginInstallModal";
import { PluginStatusBadge } from "../../components/plugins-admin/PluginStatusBadge";
import { PluginTrustBadges } from "../../components/plugins-admin/PluginTrustBadges";
import {
	pluginKeys,
	useDisablePlugin,
	useEnablePlugin,
	usePlugins,
	useUninstallPlugin,
} from "../../hooks/usePlugins";
import type { PluginSummary } from "../../lib/api/plugins";

export const Route = createFileRoute("/settings/plugins/")({
	component: SettingsPluginsPage,
});

function pluginDisplayName(plugin: PluginSummary): string {
	return plugin.displayName ?? plugin.pluginId;
}

function SettingsPluginsPage() {
	const { t } = useTranslation("plugins");
	const navigate = useNavigate();
	const confirm = useConfirmDialog();
	const qc = useQueryClient();

	const [search, setSearch] = useState("");
	const [installOpen, setInstallOpen] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);

	// The plugin list is login-only (not admin-only): any user may browse plugins
	// and install/manage theme-only ones. Non-theme-only operations are enforced
	// server-side (403), surfaced via actionError.
	const pluginsQuery = usePlugins({ enabled: true });
	const enableMutation = useEnablePlugin();
	const disableMutation = useDisablePlugin();
	const uninstallMutation = useUninstallPlugin();

	const plugins = useMemo(() => {
		const list = pluginsQuery.data ?? [];
		const query = search.trim().toLowerCase();
		if (!query) return list;
		return list.filter((plugin) => {
			const name = pluginDisplayName(plugin).toLowerCase();
			return name.includes(query) || plugin.pluginId.toLowerCase().includes(query);
		});
	}, [pluginsQuery.data, search]);

	const anyMutationPending =
		enableMutation.isPending || disableMutation.isPending || uninstallMutation.isPending;

	const handleEnable = (plugin: PluginSummary) => {
		setActionError(null);
		enableMutation.mutate(plugin.pluginId, {
			onError: (error) => setActionError(localizePluginError(error, t)),
		});
	};

	const handleDisable = async (plugin: PluginSummary) => {
		const name = pluginDisplayName(plugin);
		const confirmed = await confirm({
			title: t("admin.confirm.disableTitle"),
			message: t("admin.confirm.disableMessage", { name }),
			confirmLabel: t("admin.confirm.confirmLabel"),
			confirmColor: "orange",
		});
		if (!confirmed) return;
		setActionError(null);
		disableMutation.mutate(plugin.pluginId, {
			onError: (error) => setActionError(localizePluginError(error, t)),
		});
	};

	const handleUninstall = async (plugin: PluginSummary) => {
		const name = pluginDisplayName(plugin);
		const confirmed = await confirm({
			title: t("admin.confirm.uninstallTitle"),
			message: t("admin.confirm.uninstallMessage", { name }),
			confirmLabel: t("admin.confirm.confirmLabel"),
			confirmColor: "red",
		});
		if (!confirmed) return;
		setActionError(null);
		uninstallMutation.mutate(plugin.pluginId, {
			onError: (error) => setActionError(localizePluginError(error, t)),
		});
	};

	const pluginsDisabled = pluginsQuery.error && isPluginsDisabledError(pluginsQuery.error);

	return (
		<Stack gap="md">
			<Group justify="space-between" align="flex-start" wrap="wrap">
				<div>
					<Title order={3}>{t("admin.title")}</Title>
					<Text size="sm" c="dimmed">
						{t("admin.subtitle")}
					</Text>
				</div>
				<Group gap="xs">
					<Tooltip label={t("admin.refresh")}>
						<ActionIcon
							variant="default"
							size="lg"
							onClick={() => qc.invalidateQueries({ queryKey: pluginKeys.all })}
							aria-label={t("admin.refresh")}
						>
							<IconRefresh size={18} />
						</ActionIcon>
					</Tooltip>
					<Button
						leftSection={<IconDownload size={16} />}
						onClick={() => setInstallOpen(true)}
						disabled={!!pluginsDisabled}
					>
						{t("admin.install")}
					</Button>
				</Group>
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

			{pluginsQuery.error && !pluginsDisabled && (
				<Alert color="red" variant="light" icon={<IconAlertCircle size={18} />}>
					{localizePluginError(pluginsQuery.error, t)}
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

			<TextInput
				leftSection={<IconSearch size={16} />}
				placeholder={t("admin.searchPlaceholder")}
				value={search}
				onChange={(event) => setSearch(event.currentTarget.value)}
			/>

			{pluginsQuery.isLoading ? (
				<Group justify="center" py="xl">
					<Loader size="sm" />
					<Text size="sm" c="dimmed">
						{t("admin.loading")}
					</Text>
				</Group>
			) : plugins.length === 0 ? (
				<Paper withBorder p="xl" radius="md">
					<Stack align="center" gap={4}>
						<Text fw={500}>{t("admin.empty")}</Text>
						<Text size="sm" c="dimmed">
							{t("admin.emptyHint")}
						</Text>
					</Stack>
				</Paper>
			) : (
				<Box style={{ overflowX: "auto" }}>
					<Table striped highlightOnHover withTableBorder miw={640}>
						<Table.Thead>
							<Table.Tr>
								<Table.Th>{t("admin.table.name")}</Table.Th>
								<Table.Th>{t("admin.table.status")}</Table.Th>
								<Table.Th>{t("admin.table.version")}</Table.Th>
								<Table.Th>{t("admin.table.trust")}</Table.Th>
								<Table.Th>{t("admin.table.diagnostics")}</Table.Th>
								<Table.Th>{t("admin.table.actions")}</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{plugins.map((plugin) => {
								const enabled = plugin.desiredState === "enabled";
								const diagnosticCount = plugin.diagnosticCount ?? plugin.diagnostics?.length ?? 0;
								return (
									<Table.Tr
										key={plugin.pluginId}
										style={{ cursor: "pointer" }}
										onClick={() =>
											navigate({
												to: "/settings/plugins/$pluginId",
												params: { pluginId: plugin.pluginId },
											})
										}
									>
										<Table.Td>
											<Text size="sm" fw={500} lineClamp={1}>
												{pluginDisplayName(plugin)}
											</Text>
											<Text size="xs" c="dimmed" lineClamp={1}>
												{plugin.pluginId}
											</Text>
										</Table.Td>
										<Table.Td>
											<PluginStatusBadge plugin={plugin} />
										</Table.Td>
										<Table.Td>
											<Text size="sm">{plugin.version ?? "—"}</Text>
										</Table.Td>
										<Table.Td>
											<PluginTrustBadges trustTier={plugin.trustTier} />
										</Table.Td>
										<Table.Td>
											{diagnosticCount > 0 ? (
												<Badge color="red" variant="light" size="sm">
													{diagnosticCount}
												</Badge>
											) : (
												<Text size="sm" c="dimmed">
													0
												</Text>
											)}
										</Table.Td>
										<Table.Td onClick={(event) => event.stopPropagation()}>
											<Group gap={4} wrap="nowrap">
												{enabled ? (
													<Tooltip label={t("admin.actions.disable")}>
														<ActionIcon
															variant="subtle"
															color="orange"
															disabled={anyMutationPending || !!pluginsDisabled}
															onClick={() => handleDisable(plugin)}
															aria-label={t("admin.actions.disable")}
														>
															<IconPlugConnectedX size={18} />
														</ActionIcon>
													</Tooltip>
												) : (
													<Tooltip label={t("admin.actions.enable")}>
														<ActionIcon
															variant="subtle"
															color="green"
															disabled={anyMutationPending || !!pluginsDisabled}
															onClick={() => handleEnable(plugin)}
															aria-label={t("admin.actions.enable")}
														>
															<IconPlugConnected size={18} />
														</ActionIcon>
													</Tooltip>
												)}
												<Tooltip label={t("admin.actions.uninstall")}>
													<ActionIcon
														variant="subtle"
														color="red"
														disabled={anyMutationPending || !!pluginsDisabled}
														onClick={() => handleUninstall(plugin)}
														aria-label={t("admin.actions.uninstall")}
													>
														<IconTrash size={18} />
													</ActionIcon>
												</Tooltip>
											</Group>
										</Table.Td>
									</Table.Tr>
								);
							})}
						</Table.Tbody>
					</Table>
				</Box>
			)}

			<PluginInstallModal opened={installOpen} onClose={() => setInstallOpen(false)} />
		</Stack>
	);
}
