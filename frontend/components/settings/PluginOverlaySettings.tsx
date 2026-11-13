/**
 * "Plugin overlays" on Settings → Appearance: one switch per plugin that draws over the
 * whole app.
 *
 * Lives on a page every user can open (the plugin admin pages are admin-only), because
 * the choice is personal: an admin installs the plugin, and each person decides whether
 * they want it on their own screen. Renders nothing when no installed plugin has an
 * overlay, so most instances never see this section.
 */

import { Stack, Switch, Text, Title } from "@mantine/core";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { usePluginOverlayVisibility } from "../../hooks/usePluginOverlayVisibility";
import { pluginContributionStore } from "../plugins/PluginContributionStore";
import { syncPluginUiContributions } from "../plugins/registry";
import type { PluginContributionRecord } from "../plugins/types";

interface OverlayPlugin {
	pluginId: string;
	label: string;
	titles: string[];
}

/** Group available overlay views by plugin: visibility is chosen per plugin, not per view. */
export function listOverlayPlugins(
	contributions: Readonly<Record<string, PluginContributionRecord>>,
): OverlayPlugin[] {
	const byPlugin = new Map<string, OverlayPlugin>();
	for (const contribution of Object.values(contributions)) {
		if (!(contribution.surfaces?.includes("overlay") ?? false)) continue;
		if ((contribution.scope ?? "global") !== "global") continue;
		if (contribution.availability !== "available") continue;
		const entry = byPlugin.get(contribution.pluginId) ?? {
			pluginId: contribution.pluginId,
			label: contribution.pluginName || contribution.pluginId,
			titles: [],
		};
		if (contribution.title) entry.titles.push(contribution.title);
		byPlugin.set(contribution.pluginId, entry);
	}
	return [...byPlugin.values()].sort((left, right) => left.label.localeCompare(right.label));
}

export function PluginOverlaySettings() {
	const { t } = useTranslation("plugins");
	const snapshot = useSyncExternalStore(
		pluginContributionStore.subscribe,
		pluginContributionStore.getSnapshot,
		pluginContributionStore.getSnapshot,
	);

	useEffect(() => {
		if (snapshot.status === "idle") void syncPluginUiContributions().catch(() => {});
	}, [snapshot.status]);

	const plugins = useMemo(
		() => listOverlayPlugins(snapshot.contributions),
		[snapshot.contributions],
	);
	const visibility = usePluginOverlayVisibility({ enabled: plugins.length > 0 });

	if (plugins.length === 0) return null;

	return (
		<Stack gap="xs">
			<Title order={5}>{t("overlaySettings.title")}</Title>
			<Text size="sm" c="dimmed">
				{t("overlaySettings.description")}
			</Text>
			{plugins.map((plugin) => (
				<Switch
					key={plugin.pluginId}
					data-plugin-overlay-toggle={plugin.pluginId}
					label={plugin.label}
					description={plugin.titles.join(" · ") || undefined}
					checked={!visibility.hidden.has(plugin.pluginId)}
					disabled={!visibility.settled}
					onChange={(event) => visibility.setHidden(plugin.pluginId, !event.currentTarget.checked)}
				/>
			))}
		</Stack>
	);
}
