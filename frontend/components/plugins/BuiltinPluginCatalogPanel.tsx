import { Alert, Badge, Button, Group, Loader, Paper, Stack, Text, Title } from "@mantine/core";
import type { BuiltinPluginSummary } from "@shared/plugin-source";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useBuiltinPlugins,
	useCancelPluginUpdateJob,
	useInstallBuiltinPlugin,
	usePluginUpdateJob,
} from "../../hooks/usePlugins";
import { PluginSourceName } from "./PluginSourceName";
import { PluginUpdateJobCard } from "./PluginUpdateJobCard";
import {
	pluginUpdateErrorMessage,
	pluginUpdateJobActive,
	pluginUpdateJobMissing,
} from "./plugin-source-management";

function BuiltinPluginCard({
	entry,
	disabled,
}: {
	entry: BuiltinPluginSummary;
	disabled: boolean;
}) {
	const { t } = useTranslation("plugins");
	const install = useInstallBuiltinPlugin();
	const cancel = useCancelPluginUpdateJob();
	const [jobId, setJobId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const jobQuery = usePluginUpdateJob(jobId);
	const jobMissing = pluginUpdateJobMissing(jobQuery.error);
	const job = !jobMissing && jobQuery.data?.pluginId === entry.pluginId ? jobQuery.data : undefined;
	const busy =
		install.isPending || pluginUpdateJobActive(job) || Boolean(jobId && !job && !jobMissing);
	return (
		<Paper withBorder p="sm" radius="sm" data-builtin-plugin={entry.pluginId}>
			<Stack gap="xs">
				<Group justify="space-between" wrap="wrap">
					<Text size="sm" fw={500}>
						<PluginSourceName name={entry.displayName} source={entry.source} />
					</Text>
					<Badge variant="light" color={entry.installed ? "green" : "gray"}>
						{t(entry.installed ? "admin.builtins.installed" : "admin.builtins.notInstalled")}
					</Badge>
				</Group>
				{entry.description && (
					<Text size="sm" c="dimmed">
						{entry.description}
					</Text>
				)}
				<Text size="xs" c="dimmed">
					{entry.pluginId}
				</Text>
				<Text size="sm">{t("admin.builtins.bundledVersion", { version: entry.version })}</Text>
				{entry.installedVersion && (
					<Text size="sm">
						{t("admin.updates.installedVersion", { version: entry.installedVersion })}
					</Text>
				)}
				{error && (
					<Alert color="red" role="alert">
						{error}
					</Alert>
				)}
				<Button
					size="xs"
					variant="light"
					disabled={disabled || !entry.canInstall || busy}
					loading={install.isPending}
					onClick={() => {
						setError(null);
						install.mutate(entry.pluginId, {
							onSuccess: (started) => {
								if (started.pluginId === entry.pluginId) setJobId(started.jobId);
							},
							onError: (cause) => setError(pluginUpdateErrorMessage(cause, t)),
						});
					}}
				>
					{t(
						entry.installed || entry.installedVersion
							? "admin.builtins.reinstall"
							: "admin.builtins.installEnable",
					)}
				</Button>
				{!entry.canInstall && (
					<Text size="xs" c="dimmed">
						{t("admin.builtins.installUnavailable")}
					</Text>
				)}
				{jobQuery.error && (
					<Alert color="yellow">
						<Stack gap="xs">
							<Text size="sm">{t("admin.updates.progressUnavailable")}</Text>
							<Button size="compact-xs" variant="light" onClick={() => void jobQuery.refetch()}>
								{t("admin.updates.retryProgress")}
							</Button>
						</Stack>
					</Alert>
				)}
				{job && (
					<PluginUpdateJobCard
						job={job}
						canCancel
						cancelling={cancel.isPending}
						onCancel={() =>
							cancel.mutate(job.id, {
								onError: (cause) => setError(pluginUpdateErrorMessage(cause, t)),
							})
						}
					/>
				)}
			</Stack>
		</Paper>
	);
}

export function BuiltinPluginCatalogPanel({
	canManage = false,
	disabled = false,
}: {
	canManage?: boolean;
	disabled?: boolean;
}) {
	const { t } = useTranslation("plugins");
	const query = useBuiltinPlugins({ enabled: canManage });
	if (!canManage) return null;
	return (
		<Stack gap="sm" data-builtin-plugin-catalog>
			<Title order={4}>{t("admin.builtins.title")}</Title>
			<Text size="sm" c="dimmed">
				{t("admin.builtins.description")}
			</Text>
			{query.isPending && (
				<Group gap="xs">
					<Loader size="xs" />
					<Text size="sm">{t("admin.builtins.loading")}</Text>
				</Group>
			)}
			{query.error && <Alert color="yellow">{pluginUpdateErrorMessage(query.error, t)}</Alert>}
			{query.data?.builtins.length === 0 && (
				<Text size="sm" c="dimmed">
					{t("admin.builtins.empty")}
				</Text>
			)}
			{query.data?.builtins.map((entry) => (
				<BuiltinPluginCard key={entry.pluginId} entry={entry} disabled={disabled} />
			))}
		</Stack>
	);
}
