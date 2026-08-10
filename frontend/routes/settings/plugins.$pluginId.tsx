import {
	Alert,
	Badge,
	Button,
	Code,
	Group,
	Loader,
	Paper,
	Select,
	Stack,
	Table,
	Tabs,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import {
	IconAlertCircle,
	IconArrowLeft,
	IconCheck,
	IconPlayerPlay,
	IconPlugConnected,
	IconPlugConnectedX,
	IconRefresh,
	IconTrash,
	IconX,
} from "@tabler/icons-react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "../../components/common/ConfirmDialogProvider";
import { isPluginsDisabledError, localizePluginError } from "../../components/plugins-admin/errors";
import { PluginDiagnosticsPanel } from "../../components/plugins-admin/PluginDiagnosticsPanel";
import { PluginProviderConfigPanel } from "../../components/plugins-admin/PluginProviderConfigPanel";
import { PluginSettingsSurfacePanel } from "../../components/plugins-admin/PluginSettingsSurfacePanel";
import { PluginStatusBadge } from "../../components/plugins-admin/PluginStatusBadge";

import {
	useActivatePlugin,
	useDisablePlugin,
	useEnablePlugin,
	usePlugin,
	usePluginDiagnostics,
	useRetryPlugin,
	useUninstallPlugin,
} from "../../hooks/usePlugins";
import type { PluginDetail, PluginPermissionSet } from "../../lib/api/plugins";
import { pluginsApi } from "../../lib/api/plugins";
import { formatLocaleDateTime } from "../../lib/intl-format";
import { usePluginPermissionRequests } from "../../hooks/usePluginPermissionRequests";

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
	const confirm = useConfirmDialog();
	const [set, setSet] = useState<PluginPermissionSet | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [adding, setAdding] = useState(false);
	const [newCapability, setNewCapability] = useState("");
	const [newScopeType, setNewScopeType] = useState("global");
	const [newScopeId, setNewScopeId] = useState("");

	const load = useCallback(async () => {
		try {
			setSet(await pluginsApi.getGrants(plugin.pluginId));
			setError(null);
		} catch (err) {
			setError(localizePluginError(err, t));
		}
	}, [plugin.pluginId]);
	useEffect(() => {
		void load();
	}, [load]);

	const revokeGrant = async (grantId: string, capability: string) => {
		const ok = await confirm({
			title: t("admin.detail.grants.revokeConfirmTitle"),
			message: t("admin.detail.grants.revokeConfirmMessage", { capability }),
			confirmLabel: t("admin.detail.grants.revoke"),
		});
		if (!ok || !set) return;
		setBusy(true);
		try {
			await pluginsApi.revokeGrants(plugin.pluginId, {
				expectedRevision: set.revision,
				grantIds: [grantId],
			});
			await load();
		} catch (err) {
			setError(localizePluginError(err, t));
		} finally {
			setBusy(false);
		}
	};

	const addGrant = async () => {
		const capability = newCapability.trim();
		if (!capability || !set) return;
		setBusy(true);
		try {
			const existing = set.grants.map((grant) => ({
				capability: grant.capability,
				scope: grant.scope,
			}));
			await pluginsApi.replaceGrants(plugin.pluginId, {
				expectedRevision: set.revision,
				grants: [
					...existing,
					{
						capability,
						scope: {
							type: newScopeType,
							id: newScopeType === "global" ? undefined : (newScopeId.trim() || undefined),
						},
					},
				],
			});
			setNewCapability("");
			setNewScopeId("");
			setAdding(false);
			await load();
		} catch (err) {
			setError(localizePluginError(err, t));
		} finally {
			setBusy(false);
		}
	};

	const {
		requests: pendingRequests,
		loading: pendingLoading,
		refresh: refreshPending,
	} = usePluginPermissionRequests(plugin.pluginId);

	const approvePending = async (requestId: string) => {
		setBusy(true);
		try {
			await pluginsApi.approveGrantRequest(plugin.pluginId, requestId);
			await refreshPending();
			await load();
		} catch (err) {
			setError(localizePluginError(err, t));
		} finally {
			setBusy(false);
		}
	};

	const denyPending = async (requestId: string) => {
		setBusy(true);
		try {
			await pluginsApi.denyGrantRequest(plugin.pluginId, requestId);
			await refreshPending();
			await load();
		} catch (err) {
			setError(localizePluginError(err, t));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Stack gap="md">
			{error && (
				<Alert color="red" variant="light" title={t("common.error")}>
					<Text size="sm">{error}</Text>
				</Alert>
			)}
			<Group justify="space-between">
				<Text fw={600} size="sm">
					{t("admin.detail.grants.manageTitle")}
				</Text>
				<Group gap="xs">
					<Button size="xs" variant="light" onClick={() => void load()} disabled={busy}>
						{t("admin.detail.grants.refresh")}
					</Button>
					<Button
						size="xs"
						variant="outline"
						onClick={() => setAdding((v) => !v)}
						disabled={busy}
					>
						{t("admin.detail.grants.add")}
					</Button>
				</Group>
			</Group>
			{adding && (
				<Paper withBorder p="md" radius="md">
					<Stack gap="xs">
						<Field label={t("admin.detail.grants.addCapability")}>
							<TextInput
								value={newCapability}
								onChange={(event) => setNewCapability(event.currentTarget.value)}
								placeholder="command.narrator.send_message"
							/>
						</Field>
						<Group grow>
							<Field label={t("admin.detail.grants.scopeType")}>
								<Select
									data={["global", "project", "chapter", "narrator", "workspace", "device"]}
									value={newScopeType}
									onChange={(value) => setNewScopeType(value ?? "global")}
								/>
							</Field>
							<Field label={t("admin.detail.grants.scopeId")}>
								<TextInput
									value={newScopeId}
									onChange={(event) => setNewScopeId(event.currentTarget.value)}
									disabled={newScopeType === "global"}
									placeholder={t("admin.detail.grants.scopeIdHint")}
								/>
							</Field>
						</Group>
						<Button size="xs" onClick={() => void addGrant()} disabled={busy || !newCapability.trim()}>
							{t("admin.detail.grants.addSubmit")}
						</Button>
					</Stack>
				</Paper>
			)}
			{pendingRequests.length > 0 && (
				<Paper withBorder p="md" radius="md">
					<Stack gap="xs">
						<Group gap="xs" align="center">
							<Text fw={600} size="sm">
								{t("admin.detail.grants.pendingTitle")}
							</Text>
							<Badge color="orange" variant="filled" size="sm">
								{pendingRequests.length}
							</Badge>
						</Group>
						{pendingRequests.map((req) => (
							<Paper key={req.requestId} withBorder p="xs" radius="md">
								<Group justify="space-between" wrap="nowrap">
									<Group gap="sm" wrap="wrap">
										<Badge color="indigo" variant="light" size="sm">
											{req.capability}
										</Badge>
										<Badge color="gray" variant="light" size="sm">
											{req.scope.type}
											{req.scope.id ? `:${req.scope.id}` : ""}
										</Badge>
										<Text size="xs" c="dimmed">
											{formatLocaleDateTime(req.requestedAt)}
										</Text>
									</Group>
									<Group gap="xs" wrap="nowrap">
										<Button
											size="compact-xs"
											variant="light"
											color="green"
											leftSection={<IconCheck size={14} />}
											onClick={() => void approvePending(req.requestId)}
											disabled={busy}
										>
											{t("admin.detail.grants.approve")}
										</Button>
										<Button
											size="compact-xs"
											variant="light"
											color="red"
											leftSection={<IconX size={14} />}
											onClick={() => void denyPending(req.requestId)}
											disabled={busy}
										>
											{t("admin.detail.grants.deny")}
										</Button>
									</Group>
								</Group>
							</Paper>
						))}
					</Stack>
				</Paper>
			)}
			{set && (
				<Paper withBorder p="md" radius="md">
					<Stack gap="xs">
						<Group gap="lg">
							<Field label={t("admin.detail.grants.revision")}>
								<Text size="sm">{set.revision}</Text>
							</Field>
							<Field label={t("admin.detail.grants.installationId")}>
								<Text size="sm" style={{ wordBreak: "break-all" }}>
									{set.installationId}
								</Text>
							</Field>
							<Field label={t("admin.detail.grants.updatedAt")}>
								<Text size="sm">{formatLocaleDateTime(set.updatedAt)}</Text>
							</Field>
						</Group>
					</Stack>
				</Paper>
			)}
			<div>
				<Text fw={600} size="sm" mb="xs">
					{t("admin.detail.grants.capabilities")}
				</Text>
				{!set ? (
					<Text size="sm" c="dimmed">
						{t("admin.detail.grants.loading")}
					</Text>
				) : set.grants.length === 0 ? (
					<Text size="sm" c="dimmed">
						{t("admin.detail.grants.empty")}
					</Text>
				) : (
					<Stack gap="xs">
						{set.grants.map((grant) => (
							<Paper key={grant.grantId} withBorder p="xs" radius="md">
								<Group justify="space-between" wrap="nowrap">
									<Group gap="sm" wrap="wrap">
										<Badge color="indigo" variant="light" size="sm">
											{grant.capability}
										</Badge>
										<Badge color="gray" variant="light" size="sm">
											{grant.scope.type}
											{grant.scope.id ? `:${grant.scope.id}` : ""}
										</Badge>
										{grant.grantedBy && (
											<Text size="xs" c="dimmed">
												{t("admin.detail.grants.grantedBy")}: {grant.grantedBy}
											</Text>
										)}
									</Group>
									<Button
										size="compact-xs"
										variant="subtle"
										color="red"
										leftSection={<IconTrash size={14} />}
										onClick={() => void revokeGrant(grant.grantId, grant.capability)}
										disabled={busy}
									>
										{t("admin.detail.grants.revoke")}
									</Button>
								</Group>
							</Paper>
						))}
					</Stack>
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
	// The config tab is provider-specific, so it stays hidden for plugins that contribute
	// none rather than showing an empty panel on every plugin.
	const hasProviders = (plugin?.contributions ?? []).some(
		(contribution) => contribution.kind === "provider",
	);
	// Only offer the surface tab when a view actually declares `settings`, so the tab does
	// not appear for the many plugins whose views target the workspace only.
	const hasSettingsSurface = (plugin?.contributions ?? []).some(
		(contribution) =>
			contribution.kind === "view" && (contribution.surfaces?.includes("settings") ?? false),
	);
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
						{hasProviders ? (
							<Tabs.Tab value="config">{t("admin.detail.tabs.config")}</Tabs.Tab>
						) : null}
						{hasSettingsSurface ? (
							<Tabs.Tab value="surface">{t("admin.detail.tabs.surface")}</Tabs.Tab>
						) : null}
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
					{hasProviders ? (
						<Tabs.Panel value="config" pt="md">
							{/* keepMounted={false} means this only fetches while the tab is open. */}
							<PluginProviderConfigPanel pluginId={plugin.pluginId} />
						</Tabs.Panel>
					) : null}
					{hasSettingsSurface ? (
						<Tabs.Panel value="surface" pt="md">
							<PluginSettingsSurfacePanel pluginId={plugin.pluginId} />
						</Tabs.Panel>
					) : null}
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
