import { ActionIcon, Badge, Group, Table, Text, Tooltip } from "@mantine/core";
import { IconPlugConnected, IconPlugConnectedX } from "@tabler/icons-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { PluginSummary } from "../../lib/api/plugins";
import { PluginStatusBadge } from "./PluginStatusBadge";

/**
 * One row of the builtin-plugin section.
 *
 * Builtin plugins are ordinary plugins except for distribution, so the row shows the same
 * enable/disable control and the live health of their most recent calls. There is no uninstall
 * action: the package is part of the application.
 */
export function BuiltinPluginRow({
	plugin,
	disabled,
	onOpen,
	onEnable,
	onDisable,
}: {
	plugin: PluginSummary;
	disabled: boolean;
	onOpen: () => void;
	onEnable: () => void;
	onDisable: () => void;
}) {
	const { t } = useTranslation("plugins");
	const displayName = plugin.displayName ?? plugin.pluginId;
	const enabled = plugin.desiredState === "enabled";
	// The tool/runtime surfaces record every call; show the busiest one as the row summary.
	const health = useMemo(() => {
		const entries = plugin.health ?? [];
		return entries.find((entry) => entry.surface === "tool") ?? entries[0];
	}, [plugin.health]);
	const lastCall = health?.lastFailureAt
		? { at: health.lastFailureAt, ok: false }
		: health?.lastSuccessAt
			? { at: health.lastSuccessAt, ok: true }
			: undefined;

	return (
		<Table.Tr style={{ cursor: "pointer" }} onClick={onOpen}>
			<Table.Td>
				<Text size="sm" fw={500} lineClamp={1}>
					{displayName}
				</Text>
				<Text size="xs" c="dimmed" lineClamp={1}>
					{plugin.pluginId}
				</Text>
			</Table.Td>
			<Table.Td>
				<PluginStatusBadge plugin={plugin} />
			</Table.Td>
			<Table.Td>
				{lastCall ? (
					<Group gap={6} wrap="nowrap">
						<Badge color={lastCall.ok ? "green" : "red"} variant="light" size="sm">
							{lastCall.ok ? t("admin.builtin.lastCallOk") : t("admin.builtin.lastCallFailed")}
						</Badge>
						<Text size="xs" c="dimmed">
							{new Date(lastCall.at).toLocaleString()}
						</Text>
					</Group>
				) : (
					<Text size="sm" c="dimmed">
						{t("admin.builtin.noCalls")}
					</Text>
				)}
			</Table.Td>
			<Table.Td>
				<Text size="sm">{(plugin.restartCount ?? 0) + (plugin.crashCount ?? 0)}</Text>
			</Table.Td>
			<Table.Td onClick={(event) => event.stopPropagation()}>
				{enabled ? (
					<Tooltip label={t("admin.actions.disable")}>
						<ActionIcon
							variant="subtle"
							color="orange"
							disabled={disabled}
							onClick={onDisable}
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
							disabled={disabled}
							onClick={onEnable}
							aria-label={t("admin.actions.enable")}
						>
							<IconPlugConnected size={18} />
						</ActionIcon>
					</Tooltip>
				)}
			</Table.Td>
		</Table.Tr>
	);
}
