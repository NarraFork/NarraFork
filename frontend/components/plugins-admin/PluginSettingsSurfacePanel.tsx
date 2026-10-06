/**
 * Hosts a plugin's `surfaces: ["settings"]` views inside the plugin detail page.
 *
 * The mounting contract already existed for the workspace and director surfaces; the
 * settings surface was declarable in a manifest and accepted by the session route, but
 * nothing on the client ever mounted it. This panel closes that gap by reusing the same
 * pieces rather than introducing a parallel path:
 *
 * - `PluginUiSurfaceProvider` with `surface: "settings"` supplies the host context;
 * - `PluginDockPanelView` owns session lifecycle, iframe mounting and error placeholders;
 * - the app-level `PluginUiRuntimeProvider` (see `main.tsx`) is already in scope.
 *
 * Surface filtering here is a convenience, not a gate: `assertUiContribution` on the
 * server re-checks `surfaces` and `scope` when the session is created, so a view that
 * lies about its surfaces still cannot open a session.
 */

import { Alert, Paper, SegmentedControl, Stack, Text } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
	buildPluginDockPanelParams,
	type PluginDockPanelHostApi,
	PluginDockPanelView,
	PluginUiSurfaceProvider,
	pluginContributionStore,
	syncPluginUiContributions,
} from "../plugins";

/** Height of the embedded view. Fixed so the iframe has a stable box to lay out in. */
const SURFACE_HEIGHT = 520;

export interface PluginSettingsSurfacePanelProps {
	pluginId: string;
}

export function PluginSettingsSurfacePanel({ pluginId }: PluginSettingsSurfacePanelProps) {
	const { t } = useTranslation("plugins");
	// Subscribe to the host-owned store rather than issuing another fetch: the store is
	// the single source of truth the panel view also reads, so a separate query could
	// briefly disagree with what the view resolves.
	const snapshot = useSyncExternalStore(
		pluginContributionStore.subscribe,
		pluginContributionStore.getSnapshot,
		pluginContributionStore.getSnapshot,
	);

	// A direct visit to this page can land before the app-level sync has run.
	useEffect(() => {
		if (snapshot.status === "idle") void syncPluginUiContributions().catch(() => {});
	}, [snapshot.status]);

	const settingsViews = useMemo(() => {
		return (
			Object.values(snapshot.contributions)
				.filter((contribution) => contribution.pluginId === pluginId)
				.filter((contribution) => contribution.surfaces?.includes("settings") ?? false)
				// The settings page has no workspace, narrator or project in scope, so a view
				// declaring one of those cannot open a session here: `resolvePluginUiInvocationScope`
				// throws on a missing scope id. Excluding them keeps the tab honest instead of
				// showing a view that can only ever fail to load.
				.filter((contribution) => (contribution.scope ?? "global") === "global")
				// Disabled views are kept: `PluginDockPanelView` renders a placeholder that says
				// *why* the view is unavailable, which is more useful than this panel claiming
				// the plugin contributes no settings views at all.
				.sort((left, right) => left.contributionId.localeCompare(right.contributionId))
		);
	}, [pluginId, snapshot.contributions]);

	const [activeId, setActiveId] = useState<string | null>(null);
	const active =
		settingsViews.find((contribution) => contribution.contributionId === activeId) ??
		settingsViews[0];

	if (settingsViews.length === 0) {
		return (
			<Alert variant="light" color="blue" icon={<IconInfoCircle size={16} />}>
				{t("admin.detail.surface.empty")}
			</Alert>
		);
	}
	if (!active) return null;

	return (
		<Stack gap="md">
			{settingsViews.length > 1 ? (
				<SegmentedControl
					value={active.contributionId}
					onChange={setActiveId}
					data={settingsViews.map((contribution) => ({
						value: contribution.contributionId,
						label: contribution.title || contribution.contributionId,
					}))}
				/>
			) : (
				<Text size="sm" c="dimmed">
					{active.title || active.contributionId}
				</Text>
			)}
			<PluginSettingsSurfaceFrame
				key={`${active.pluginId}:${active.contributionId}`}
				pluginId={active.pluginId}
				contributionId={active.contributionId}
			/>
		</Stack>
	);
}

function PluginSettingsSurfaceFrame({
	pluginId,
	contributionId,
}: {
	pluginId: string;
	contributionId: string;
}) {
	const [title, setTitle] = useState<string | undefined>();

	// One stable instance id per mounted view. It must not change across re-renders or
	// the runtime would tear the session down and rebuild it on every update.
	const panelInstanceId = useMemo(
		() => `settings:${pluginId}:${contributionId}`,
		[pluginId, contributionId],
	);

	const params = useMemo(
		() =>
			buildPluginDockPanelParams({
				pluginId,
				contributionId,
				panelInstanceId,
				// `host-surface` binds the view to this surface family, which is what
				// `resolveCanonicalPluginUiSessionContext` matches on for settings.
				binding: { kind: "host-surface", surface: "settings" },
			}),
		[pluginId, contributionId, panelInstanceId],
	);

	// The settings page has no dock chrome, so the panel API is satisfied with local
	// no-ops. `close` is deliberately inert: the panel is part of the page, and letting a
	// plugin remove it would leave the tab blank with no way back.
	const hostApi = useMemo<PluginDockPanelHostApi>(
		() => ({
			title,
			isActive: true,
			setTitle,
			updateParameters: () => {},
			setActive: () => {},
			close: () => {},
		}),
		[title],
	);

	return (
		<PluginUiSurfaceProvider hostContext={{ surface: "settings" }}>
			<Paper withBorder radius="md" style={{ height: SURFACE_HEIGHT, overflow: "hidden" }}>
				<PluginDockPanelView rawParams={params} hostApi={hostApi} />
			</Paper>
		</PluginUiSurfaceProvider>
	);
}
