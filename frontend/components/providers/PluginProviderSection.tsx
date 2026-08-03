/**
 * Detail area for a provider contributed by an executable plugin.
 *
 * Two rendering paths, chosen by what the plugin declares:
 *
 * - the plugin ships a `provider-settings` view → mount its iframe and let it own the
 *   whole area (credential tables, quota widgets, OAuth buttons — things a generated
 *   form cannot express);
 * - it ships no such view → fall back to the host's schema-driven `PluginConfigForm`.
 *
 * The fallback is the point: a provider plugin must stay configurable without writing
 * any UI. Requiring an iframe would make every plugin author reimplement a form the host
 * already generates from `configSchema`.
 */

import { Alert, Paper, SegmentedControl, Stack, Text } from "@mantine/core";
import { IconAlertTriangle, IconInfoCircle } from "@tabler/icons-react";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { usePluginProviderConfig, useUpdatePluginProviderConfig } from "../../hooks/usePlugins";
import { ApiError } from "../../lib/api";
import type { PluginProviderConfigView } from "../../lib/api/plugins";
import {
	buildPluginDockPanelParams,
	type PluginDockPanelHostApi,
	PluginDockPanelView,
	PluginUiSurfaceProvider,
	pluginContributionStore,
	syncPluginUiContributions,
} from "../plugins";
import { PluginConfigForm, type SchemaNode } from "../plugins-admin";
import { localizePluginError } from "../plugins-admin/errors";

/** Height of an embedded plugin view. Fixed so the iframe has a stable box. */
const SURFACE_HEIGHT = 560;

export interface PluginProviderSectionProps {
	pluginId: string;
	/** Provider contribution id within the plugin (stable across prefix edits). */
	contributionId: string;
}

function errorText(error: unknown, t: TFunction<"plugins">): string {
	if (error instanceof ApiError && typeof error.data?.code === "string") {
		const code = error.data.code;
		// A schema rejection carries the failing path, which the generic localized string
		// cannot express, so show the server text verbatim.
		if (code === "VALIDATION_ERROR" || code === "PROVIDER_CONFIG_INVALID") return error.message;
	}
	return localizePluginError(error, t);
}

export function PluginProviderSection({ pluginId, contributionId }: PluginProviderSectionProps) {
	const { t } = useTranslation("settings");
	const { t: tp } = useTranslation("plugins");

	// Contribution snapshot tells us whether the plugin ships a provider-settings view.
	const snapshot = useSyncExternalStore(
		pluginContributionStore.subscribe,
		pluginContributionStore.getSnapshot,
		pluginContributionStore.getSnapshot,
	);
	useEffect(() => {
		if (snapshot.status === "idle") void syncPluginUiContributions().catch(() => {});
	}, [snapshot.status]);

	const views = useMemo(() => {
		return (
			Object.values(snapshot.contributions)
				.filter((contribution) => contribution.pluginId === pluginId)
				.filter((contribution) => contribution.surfaces?.includes("provider-settings") ?? false)
				// The settings surface has no workspace/narrator/project in scope, so a view
				// declaring one of those could never open a session here.
				.filter((contribution) => (contribution.scope ?? "global") === "global")
				.sort((left, right) => left.contributionId.localeCompare(right.contributionId))
		);
	}, [pluginId, snapshot.contributions]);

	if (views.length > 0) {
		return <PluginProviderViews pluginId={pluginId} views={views} />;
	}
	return (
		<PluginProviderConfigFallback
			pluginId={pluginId}
			contributionId={contributionId}
			label={t("pluginProviderNoCustomUi")}
			errorLabel={tp}
		/>
	);
}

function PluginProviderViews({
	pluginId,
	views,
}: {
	pluginId: string;
	views: Array<{ contributionId: string; title: string }>;
}) {
	const [activeId, setActiveId] = useState<string | null>(null);
	const active = views.find((view) => view.contributionId === activeId) ?? views[0];
	if (!active) return null;

	return (
		<Stack gap="md">
			{views.length > 1 ? (
				<SegmentedControl
					value={active.contributionId}
					onChange={setActiveId}
					data={views.map((view) => ({
						value: view.contributionId,
						label: view.title || view.contributionId,
					}))}
				/>
			) : null}
			<PluginProviderFrame
				key={`${pluginId}:${active.contributionId}`}
				pluginId={pluginId}
				contributionId={active.contributionId}
			/>
		</Stack>
	);
}

function PluginProviderFrame({
	pluginId,
	contributionId,
}: {
	pluginId: string;
	contributionId: string;
}) {
	const [title, setTitle] = useState<string | undefined>();

	// One stable instance id per mounted view: changing it would tear down and rebuild
	// the backend session on every re-render.
	const panelInstanceId = useMemo(
		() => `provider-settings:${pluginId}:${contributionId}`,
		[pluginId, contributionId],
	);
	const params = useMemo(
		() =>
			buildPluginDockPanelParams({
				pluginId,
				contributionId,
				panelInstanceId,
				binding: { kind: "host-surface", surface: "provider-settings" },
			}),
		[pluginId, contributionId, panelInstanceId],
	);

	// No dock chrome here, so the panel API is satisfied with local no-ops. `close` is
	// inert on purpose: the panel is part of the page, and letting a plugin remove it
	// would leave the provider unconfigurable with no way back.
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
		<PluginUiSurfaceProvider hostContext={{ surface: "provider-settings" }}>
			<Paper withBorder radius="md" style={{ height: SURFACE_HEIGHT, overflow: "hidden" }}>
				<PluginDockPanelView rawParams={params} hostApi={hostApi} />
			</Paper>
		</PluginUiSurfaceProvider>
	);
}

function PluginProviderConfigFallback({
	pluginId,
	contributionId,
	label,
	errorLabel,
}: {
	pluginId: string;
	contributionId: string;
	label: string;
	errorLabel: TFunction<"plugins">;
}) {
	const query = usePluginProviderConfig(pluginId);
	const mutation = useUpdatePluginProviderConfig(pluginId);

	const provider: PluginProviderConfigView | undefined = query.data?.providers.find(
		(item) => item.contributionId === contributionId,
	);

	if (query.isLoading) {
		return (
			<Text size="sm" c="dimmed">
				{errorLabel("admin.detail.config.loading")}
			</Text>
		);
	}
	if (query.isError) {
		return (
			<Alert variant="light" color="red" icon={<IconAlertTriangle size={16} />}>
				{errorText(query.error, errorLabel)}
			</Alert>
		);
	}
	if (!provider) {
		return (
			<Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />}>
				{errorLabel("admin.detail.config.empty")}
			</Alert>
		);
	}

	const schema: SchemaNode | undefined =
		provider.configSchema === null
			? undefined
			: typeof provider.configSchema === "boolean"
				? provider.configSchema
				: (provider.configSchema as SchemaNode);

	return (
		<Stack gap="md">
			<Alert variant="light" color="blue" icon={<IconInfoCircle size={16} />}>
				{label}
			</Alert>
			<PluginConfigForm
				schema={schema}
				view={{
					config: provider.config as Record<string, never>,
					secretFields: provider.secretFields,
					secretsSet: provider.secretsSet,
				}}
				submitting={mutation.isPending}
				submitError={mutation.isError ? errorText(mutation.error, errorLabel) : undefined}
				onSubmit={async (config) => {
					await mutation.mutateAsync({
						providerInstanceId: provider.providerInstanceId,
						config,
					});
				}}
			/>
		</Stack>
	);
}
