/**
 * Detail area for a provider contributed by an executable plugin.
 *
 * Two rendering paths for the *configuration* part, chosen by what the plugin declares:
 *
 * - the plugin ships a `provider-settings` view → mount its iframe and let it own that
 *   area (credential tables, quota widgets, OAuth buttons — things a generated form
 *   cannot express);
 * - it ships no such view → fall back to the host's schema-driven `PluginConfigForm`.
 *
 * The fallback is the point: a provider plugin must stay configurable without writing
 * any UI. Requiring an iframe would make every plugin author reimplement a form the host
 * already generates from `configSchema`.
 *
 * ## Why the model area lives here rather than in the plugin
 *
 * Model visibility, context-window overrides and the model tester are host concerns: they
 * are stored in `settings.agent.hiddenModels` / `settings.agent.modelContextWindows` and
 * exercised through `/api/settings`, none of which a sandboxed iframe can reach
 * (`connect-src 'none'`). A plugin panel therefore *cannot* implement them, and until this
 * existed a plugin provider simply had no model controls — unlike the built-in providers,
 * whose sections all render `ModelList` + `InlineCustomModels`.
 *
 * This component is ordinary host React outside the iframe, so it reuses those same two
 * components against the same host state. The result is that a plugin provider's model area
 * is not merely similar to a built-in one, it is the identical component tree.
 */

import { Alert, Button, Divider, Group, Paper, SegmentedControl, Stack, Text } from "@mantine/core";
import { IconAlertTriangle, IconInfoCircle, IconRefresh } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
	pluginKeys,
	usePluginProviderConfig,
	useUpdatePluginProviderConfig,
} from "../../hooks/usePlugins";
import { ApiError } from "../../lib/api";
import { type PluginProviderConfigView, pluginsApi } from "../../lib/api/plugins";
import type { ModelOption } from "../../lib/constants";
import type { ProxyOverride } from "../../lib/proxy";
import { ProxyOverrideField } from "../common/ProxyOverrideField";
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
import type { CustomModelEntry } from "./InlineCustomModels";
import { InlineCustomModels } from "./InlineCustomModels";
import { ModelList } from "./ModelList";

/** Height of an embedded plugin view. Fixed so the iframe has a stable box. */
const SURFACE_HEIGHT = 560;

export interface PluginProviderSectionProps {
	pluginId: string;
	/** Provider contribution id within the plugin (stable across prefix edits). */
	contributionId: string;
	/**
	 * Model controls, wired to the same host state the built-in provider sections use.
	 *
	 * Optional as a group: a caller that has no model state to offer (a test, or a future
	 * surface that only configures credentials) still gets the configuration area, just
	 * without the model list. Passing a partial set is not meaningful, so the whole block is
	 * threaded together.
	 */
	models?: PluginProviderModelControls;
}

export interface PluginProviderModelControls {
	/** The provider's prefix, which is how models are namespaced (`<prefix>:<model>`). */
	prefix: string;
	/** Models the host discovered for this provider, already prefixed. */
	models: ModelOption[];
	hiddenModels: Set<string>;
	onToggleHidden: (modelValue: string) => void;
	onBatchToggleHidden?: (modelValues: string[], hidden: boolean) => void;
	modelContextWindows: Record<string, number>;
	onContextWindowChange: (modelValue: string, size: number | null) => void;
	customModels: CustomModelEntry[];
	onCustomModelsChange: (models: CustomModelEntry[]) => void;
	onTestModel?: (model: string) => void;
}

/** Result of a catalog refresh, reduced to what the section needs to report. */
interface CatalogRefreshOutcome {
	tone: "success" | "error";
	message: string;
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

export function PluginProviderSection({
	pluginId,
	contributionId,
	models,
}: PluginProviderSectionProps) {
	const { t } = useTranslation("settings");
	const { t: tp } = useTranslation("plugins");

	/**
	 * One provider-config query for the whole section.
	 *
	 * The proxy control and the model refresh both need the provider *instance* id, which only
	 * this payload carries. Querying it in each of them would issue the same request several
	 * times and — more importantly — would fetch the generated form's data even when the plugin
	 * ships its own view, which is exactly what the "does not fetch the form" guarantee forbids.
	 * So it is fetched once here and the instance id is passed down.
	 */
	const configQuery = usePluginProviderConfig(pluginId);
	const providerInstanceId = configQuery.data?.providers.find(
		(item) => item.contributionId === contributionId,
	)?.providerInstanceId;
	const storedProxy = configQuery.data?.providers.find(
		(item) => item.contributionId === contributionId,
	)?.proxy;

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

	return (
		<Stack gap="md">
			{views.length > 0 ? (
				<PluginProviderViews pluginId={pluginId} views={views} />
			) : (
				<PluginProviderConfigFallback
					pluginId={pluginId}
					contributionId={contributionId}
					label={t("pluginProviderNoCustomUi")}
					errorLabel={tp}
				/>
			)}
			{providerInstanceId ? (
				<PluginProviderProxy
					pluginId={pluginId}
					providerInstanceId={providerInstanceId}
					storedProxy={storedProxy}
				/>
			) : null}
			{models ? (
				<PluginProviderModels
					controls={models}
					pluginId={pluginId}
					providerInstanceId={providerInstanceId}
				/>
			) : null}
		</Stack>
	);
}

/**
 * Outbound proxy override for a plugin provider.
 *
 * Host-rendered for the same reason the model area is: the plugin's panel cannot reach the
 * host API, and the proxy is host policy about how the host reaches upstream rather than
 * something the plugin declares. Every built-in provider has had this control through
 * `settings.<provider>.proxy`; a plugin provider previously had none and could only follow the
 * global proxy.
 *
 * The plugin never learns the override itself — only the *resolved* URL, via `hostHints`.
 */
function PluginProviderProxy({
	pluginId,
	providerInstanceId,
	storedProxy,
}: {
	pluginId: string;
	providerInstanceId: string;
	storedProxy?: { mode: string; url?: string };
}) {
	const { t: tp } = useTranslation("plugins");
	const queryClient = useQueryClient();
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();

	// The stored shape is validated server-side, so a mode the client does not know would be a
	// newer host; treating it as "default" keeps the control usable instead of blank.
	const value = storedProxy
		? ({
				mode: (["default", "direct", "system", "custom"] as const).includes(
					storedProxy.mode as ProxyOverride["mode"],
				)
					? (storedProxy.mode as ProxyOverride["mode"])
					: "default",
				...(storedProxy.url ? { url: storedProxy.url } : {}),
			} satisfies ProxyOverride)
		: undefined;

	const handleChange = async (next: ProxyOverride | undefined) => {
		setSaving(true);
		setError(undefined);
		try {
			await pluginsApi.updateProviderProxy(
				pluginId,
				providerInstanceId,
				// `undefined` from the field means "default", which the server stores as no
				// override at all.
				next ? { mode: next.mode, ...(next.url ? { url: next.url } : {}) } : null,
			);
			// The value is read back from this query, so it must refetch or the field would snap
			// back to the previous setting on the next render. Uses the shared key factory
			// rather than a literal: a hand-written key that does not match is invisible at
			// compile time and shows up only as a control that silently reverts.
			await queryClient.invalidateQueries({ queryKey: pluginKeys.providerConfig(pluginId) });
		} catch (caught) {
			setError(errorText(caught, tp));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Stack gap="xs">
			<ProxyOverrideField
				value={value}
				onChange={(next) => void handleChange(next)}
				disabled={saving}
			/>
			{error ? (
				<Text size="xs" c="red">
					{error}
				</Text>
			) : null}
		</Stack>
	);
}

/**
 * Model area for a plugin provider.
 *
 * list, then the user's own additions. Both are the host's components reading host state, so
 * hiding a model here has exactly the same effect as hiding a built-in provider's model.
 *
 * provider's catalog may or may not report `contextWindow`, and where it does not, a manual
 * override is the only way to give the model a sensible budget.
 */
function PluginProviderModels({
	controls,
	pluginId,
	providerInstanceId,
}: {
	controls: PluginProviderModelControls;
	pluginId: string;
	/** Absent until the provider-config query resolves; the refresh button waits for it. */
	providerInstanceId?: string;
}) {
	const { t } = useTranslation("settings");
	const { t: tp } = useTranslation("plugins");
	const queryClient = useQueryClient();
	const [refreshing, setRefreshing] = useState(false);
	const [outcome, setOutcome] = useState<CatalogRefreshOutcome | undefined>();

	// Defaults come from the plugin's own catalog, so a model that reports its window shows
	// that value as the placeholder instead of appearing unconfigured.
	const defaultContextWindows = useMemo(() => {
		const defaults: Record<string, number> = {};
		for (const model of controls.models) {
			if (typeof model.contextWindow === "number") defaults[model.value] = model.contextWindow;
		}
		return defaults;
	}, [controls.models]);

	const handleRefresh = async () => {
		if (!providerInstanceId || refreshing) return;
		setRefreshing(true);
		setOutcome(undefined);
		try {
			const result = await pluginsApi.refreshProviderCatalog(pluginId, providerInstanceId);
			if (result.error) {
				// The endpoint reports an unreachable upstream as a successful response with an
				// error field, so treating any 2xx as success would claim a refresh that did not
				// happen.
				setOutcome({ tone: "error", message: result.error });
			} else {
				setOutcome({
					tone: "success",
					message: t("clineModelsCount", { count: result.modelCount }),
				});
				// The model list is derived from `/api/settings`, so the catalog change is only
				// visible after those queries refetch.
				await Promise.all([
					queryClient.invalidateQueries({ queryKey: ["settings"] }),
					queryClient.invalidateQueries({ queryKey: ["admin", "settings"] }),
				]);
			}
		} catch (error) {
			setOutcome({ tone: "error", message: errorText(error, tp) });
		} finally {
			setRefreshing(false);
		}
	};

	return (
		<Stack gap="md">
			<Divider />
			<Group justify="space-between">
				<Text fw={500} size="sm">
					{t("modelsSection")}
				</Text>
				<Group gap="xs">
					<Text size="xs" c="dimmed">
						{t("clineModelsCount", { count: controls.models.length })}
					</Text>
					<Button
						size="compact-xs"
						variant="light"
						leftSection={<IconRefresh size={14} />}
						loading={refreshing}
						// Until the config payload resolves there is no instance id to refresh.
						disabled={!providerInstanceId}
						onClick={handleRefresh}
					>
					</Button>
				</Group>
			</Group>
			{outcome ? (
				<Text size="xs" c={outcome.tone === "error" ? "red" : "green"}>
					{outcome.message}
				</Text>
			) : null}
			{controls.models.length > 0 ? (
				<ModelList
					models={controls.models}
					hiddenModels={controls.hiddenModels}
					onToggleHidden={controls.onToggleHidden}
					onBatchToggleHidden={controls.onBatchToggleHidden}
					modelContextWindows={controls.modelContextWindows}
					defaultContextWindows={defaultContextWindows}
					onContextWindowChange={controls.onContextWindowChange}
					onTestModel={controls.onTestModel}
				/>
			) : null}
			<InlineCustomModels
				prefix={controls.prefix}
				customModels={controls.customModels}
				onCustomModelsChange={controls.onCustomModelsChange}
				hiddenModels={controls.hiddenModels}
				onToggleHidden={controls.onToggleHidden}
				modelContextWindows={controls.modelContextWindows}
				onContextWindowChange={controls.onContextWindowChange}
				onTestModel={controls.onTestModel}
			/>
		</Stack>
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
