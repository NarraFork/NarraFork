import { Badge, Group, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { usePluginSource, usePluginUpdates } from "../../hooks/usePlugins";
import type { PluginSummary } from "../../lib/api/plugins";
import { PluginSourceName } from "./PluginSourceName";

export function PluginSourceUpdateSummary({
	plugin,
	canManage = false,
}: {
	plugin: PluginSummary;
	canManage?: boolean;
}) {
	const { t } = useTranslation("plugins");
	const sourceQuery = usePluginSource(plugin.pluginId, { enabled: canManage });
	const updateQuery = usePluginUpdates(plugin.pluginId, { enabled: canManage });
	const sourceView = sourceQuery.data ?? plugin.sourceView;
	const source = sourceView?.binding.source;
	const updates = updateQuery.data ?? plugin.updateView;
	return (
		<Stack gap={2}>
			<Group gap={6} wrap="nowrap">
				<Text size="sm" fw={500} lineClamp={1}>
					<PluginSourceName name={plugin.displayName ?? plugin.pluginId} source={source} />
				</Text>
				{(plugin.origin === "builtin" || plugin.builtin) && (
					<Badge size="xs" variant="light">
						{t("admin.builtins.label")}
					</Badge>
				)}
			</Group>
			<Text size="xs" c="dimmed" lineClamp={1}>
				{plugin.pluginId}
			</Text>
			{canManage && (
				<>
					<Text size="xs" c="dimmed">
						{sourceQuery.isPending
							? t("admin.sources.loading")
							: sourceQuery.error && !sourceView
								? t("admin.sources.unavailable")
								: t(`admin.sources.types.${source?.type ?? "none"}`)}
					</Text>
					{source && (
						<Text size="xs" c="dimmed">
							{t(sourceView?.binding.autoUpdate ? "admin.updates.autoOn" : "admin.updates.autoOff")}
						</Text>
					)}
					{updates && source && (
						<Text size="xs" c="dimmed">
							{updates.latest
								? t("admin.updates.latestVersion", { version: updates.latest.version })
								: t(`admin.updates.statuses.${updates.status}`)}
						</Text>
					)}
				</>
			)}
		</Stack>
	);
}
