import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Center,
	Group,
	Loader,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { IconAlertTriangle, IconPlugConnected, IconRefresh, IconTrash } from "@tabler/icons-react";
import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useChapter } from "../../hooks/useChapters";
import { useNarrator } from "../../hooks/useNarrator";
import { pluginContributionStore } from "./PluginContributionStore";
import { PluginPanelSlot } from "./PluginUiRuntimeProvider";
import { usePluginUiSurface } from "./PluginUiSurfaceContext";
// The hook comes from the context module (a non-component export in the provider breaks
// its Fast Refresh boundary); the slot component from the provider itself.
import { useOptionalPluginUiRuntime } from "./plugin-ui-runtime-context";
import type { PluginDockPanelParams } from "./protocol";
import { parsePluginDockPanelParams } from "./protocol";
import { PluginUiHostError } from "./runtime";
import type { PluginUiContribution } from "./types";

function Placeholder({
	title,
	message,
	action,
	actionLabel,
	secondaryAction,
	secondaryActionLabel,
	icon = <IconAlertTriangle size={24} />,
}: {
	title: string;
	message: string;
	action?: () => void;
	actionLabel?: string;
	secondaryAction?: () => void;
	secondaryActionLabel?: string;
	icon?: React.ReactNode;
}) {
	return (
		<Center h="100%" p="md">
			<Stack align="center" gap="sm" maw={420}>
				<Box c="dimmed" style={{ display: "flex" }}>
					{icon}
				</Box>
				<Text fw={600} ta="center">
					{title}
				</Text>
				<Text size="sm" c="dimmed" ta="center">
					{message}
				</Text>
				<Group gap="xs">
					{action && actionLabel ? (
						<Button size="xs" variant="light" onClick={action}>
							{actionLabel}
						</Button>
					) : null}
					{secondaryAction && secondaryActionLabel ? (
						<Button size="xs" variant="subtle" color="gray" onClick={secondaryAction}>
							{secondaryActionLabel}
						</Button>
					) : null}
				</Group>
			</Stack>
		</Center>
	);
}

function statusPlaceholder(
	status: PluginUiContribution["status"],
	t: (key: string, options?: Record<string, unknown>) => string,
	contribution: PluginUiContribution,
	onRetry: () => void,
	onRemove: () => void,
) {
	const title = contribution.title || contribution.contributionId;
	const name = contribution.pluginName || contribution.pluginId;
	if (status === "disabled") {
		return (
			<Placeholder
				title={t("disabledTitle")}
				message={contribution.unavailableReason || t("disabledMessage", { name })}
				action={onRetry}
				actionLabel={t("reload")}
				secondaryAction={onRemove}
				secondaryActionLabel={t("removePanel")}
			/>
		);
	}
	if (status === "denied") {
		return (
			<Placeholder
				title={t("deniedTitle")}
				message={contribution.unavailableReason || t("deniedMessage")}
				action={onRemove}
				actionLabel={t("removePanel")}
			/>
		);
	}
	if (status === "incompatible") {
		return (
			<Placeholder
				title={t("incompatibleTitle")}
				message={contribution.unavailableReason || t("incompatibleMessage")}
				action={onRemove}
				actionLabel={t("removePanel")}
			/>
		);
	}
	if (status === "missing" || !status) {
		return (
			<Placeholder
				title={t("missingTitle")}
				message={t("missingMessage", { title, name })}
				action={onRemove}
				actionLabel={t("removePanel")}
			/>
		);
	}
	return (
		<Placeholder
			title={t("errorTitle")}
			message={contribution.unavailableReason || t("errorMessage")}
			action={onRetry}
			actionLabel={t("reload")}
		/>
	);
}

export interface PluginDockPanelHostApi {
	title?: string;
	isActive: boolean;
	setTitle: (title: string) => void;
	updateParameters: (params: PluginDockPanelParams) => void;
	setActive: () => void;
	close: () => void;
	/**
	 * Grow the panel's container to the plugin's reported content height.
	 *
	 * Absent on Dockview surfaces (the dock owns panel geometry), which makes
	 * `panel.setHeight` report NOT_SUPPORTED there; embedded surfaces like
	 * provider-settings provide it to let the iframe escape its fixed box.
	 */
	setHeight?: (height: number) => void;
}

export function PluginDockPanelView({
	rawParams,
	hostApi,
}: {
	rawParams: unknown;
	hostApi: PluginDockPanelHostApi;
}) {
	const { t } = useTranslation("plugins");
	const runtime = useOptionalPluginUiRuntime();
	const surface = usePluginUiSurface();
	const params = useMemo(() => parsePluginDockPanelParams(rawParams), [rawParams]);
	const lastAppliedTitleRef = useRef<string | null>(null);
	const ownerNarratorId = params ? surface?.resolveOwnerNarratorId(params) : undefined;
	const { data: ownerNarrator } = useNarrator(ownerNarratorId ?? "");
	// biome-ignore lint/suspicious/noExplicitAny: dynamic narrator API entity
	const ownerChapterId = (ownerNarrator as any)?.chapterId as string | null | undefined;
	const { data: ownerChapter } = useChapter(ownerChapterId ?? "");
	// biome-ignore lint/suspicious/noExplicitAny: dynamic chapter API entity
	const ownerProjectId = (ownerChapter as any)?.projectId as string | undefined;
	useEffect(() => {
		if (!surface || !ownerNarratorId) return;
		surface.registerNarratorContext({
			narratorId: ownerNarratorId,
			chapterId: ownerChapterId,
			projectId: ownerProjectId,
		});
	}, [surface, ownerNarratorId, ownerChapterId, ownerProjectId]);
	const sessionContext = params ? surface?.resolveSessionContext(params) : undefined;
	const remove = useCallback(() => hostApi.close(), [hostApi]);

	// Host-owned, reactive contribution lookup. Reading the store directly (via
	// the provider's useSyncExternalStore subscription) is what makes this panel
	// re-render when the backend snapshot lands — the serialized dock params are
	// static and must NOT be treated as the contribution source of truth.
	const contribution = params ? runtime?.resolveContribution(params) : undefined;
	const synced = pluginContributionStore.getSnapshot().synced;
	const missing = params !== null && synced && contribution === undefined;
	const status: PluginUiContribution["status"] =
		contribution?.status ?? (missing ? "missing" : undefined);

	const retry = useCallback(() => {
		if (params) runtime?.reloadSession(params.panelInstanceId);
	}, [params, runtime]);
	const snapshot =
		params && runtime ? runtime.getSessionSnapshot(params.panelInstanceId) : undefined;
	// The live session controller, if any. The session iframe renders INSIDE this
	// panel's dock content (mirroring how built-in tool panels render their
	// content), so the dock natively manages tab switching, hiding and movement.
	const controller =
		params && runtime ? runtime.getSessionController(params.panelInstanceId) : undefined;

	useEffect(() => {
		if (
			!params ||
			!runtime ||
			!sessionContext ||
			!contribution ||
			contribution.status !== "available"
		) {
			return;
		}
		runtime.ensureSession(params, contribution, sessionContext);
	}, [contribution, params, runtime, sessionContext]);

	useEffect(() => {
		if (!params || !runtime) return;
		runtime.updateSessionParams(params.panelInstanceId, params);
	}, [params, runtime]);

	// Dispose the session when the contribution leaves the available state so a
	// disabled/denied plugin never keeps a live backend session or iframe.
	useEffect(() => {
		if (!params || !runtime) return;
		if (contribution?.status === "available") return;
		runtime.disposeSession(params.panelInstanceId);
	}, [contribution?.status, params, runtime]);

	// Bridge Dockview chrome into host-local `panel.*` methods.
	useEffect(() => {
		if (!params || !runtime) return;
		return runtime.registerPanelDelegate(params.panelInstanceId, {
			getTitle: () => hostApi.title,
			isActive: () => hostApi.isActive,
			setTitle: hostApi.setTitle,
			updateParams: (patch) => {
				const next = parsePluginDockPanelParams({ ...params, ...patch });
				if (!next) {
					throw new PluginUiHostError("INVALID_PARAMS", "Plugin panel params are invalid", {
						retryable: false,
					});
				}
				hostApi.updateParameters(next);
				runtime.updateSessionParams(params.panelInstanceId, next);
			},
			focus: hostApi.setActive,
			close: hostApi.close,
			// Deliberately omitted when the surface has no sizing channel: the router
			// then reports NOT_SUPPORTED, which is the plugin's signal to stop reporting.
			...(hostApi.setHeight ? { setHeight: hostApi.setHeight } : {}),
		});
	}, [params, runtime, hostApi]);

	useLayoutEffect(() => {
		if (!params || !contribution) return;
		const title =
			contribution.title?.trim() || contribution.pluginName?.trim() || params.contributionId;
		// Only apply the title once per distinct value. `contribution` is a fresh
		// object on every render (toPluginUiContribution builds a new literal) and
		// `hostApi.title` does not reflect `setTitle` on every dock implementation,
		// so comparing against hostApi.title alone would re-invoke setTitle on every
		// render → Dockview updates state → render loop (React #185).
		if (title && lastAppliedTitleRef.current !== title) {
			lastAppliedTitleRef.current = title;
			hostApi.setTitle(title);
		}
	}, [contribution, params, hostApi]);

	if (!params) {
		return (
			<Placeholder
				title={t("recoveryTitle")}
				message={t("recoveryMessage")}
				action={remove}
				actionLabel={t("removePanel")}
			/>
		);
	}
	if (!runtime) {
		// The host runtime provider is absent on this surface — this is NOT the
		// same as the contribution being gone from the registry.
		return (
			<Placeholder
				title={t("runtimeUnavailableTitle")}
				message={t("runtimeUnavailableMessage")}
				action={remove}
				actionLabel={t("removePanel")}
			/>
		);
	}
	if (missing) {
		// Registry is synced and has no record → the plugin was uninstalled or
		// the contribution removed. Never show "runtime unavailable" here.
		return (
			<Placeholder
				title={t("missingTitle")}
				message={t("missingMessage", {
					title: params.fallback?.title || params.contributionId,
					name: params.fallback?.pluginName || params.pluginId,
				})}
				action={remove}
				actionLabel={t("removePanel")}
			/>
		);
	}
	if (!contribution) {
		// Snapshot not synced yet: wait for the first backend snapshot instead of
		// declaring the panel missing.
		return (
			<Placeholder
				title={t("loadingTitle")}
				message={t("loadingMessage", {
					name: params.fallback?.pluginName || params.pluginId,
				})}
				icon={<Loader size={24} />}
			/>
		);
	}
	if (status !== "available") return statusPlaceholder(status, t, contribution, retry, remove);
	if (!sessionContext) {
		return (
			<Placeholder
				title={t("recoveryTitle")}
				message={t("recoveryMessage")}
				action={remove}
				actionLabel={t("removePanel")}
			/>
		);
	}
	const withSlot = (content: React.ReactNode) => (
		<Box h="100%" w="100%" style={{ overflow: "hidden", background: "var(--mantine-color-body)" }}>
			<PluginPanelSlot panelInstanceId={params.panelInstanceId} active={hostApi.isActive}>
				{content}
			</PluginPanelSlot>
		</Box>
	);
	// A crashed/disposed session must show the error placeholder, not the iframe.
	const sessionBroken = snapshot && ["error", "crashed", "disposed"].includes(snapshot.status);
	if (controller && !sessionBroken) {
		// Live session: render the iframe directly in the panel content. The
		// handshake happens on iframe load (controller.attach), same as before.
		return withSlot(
			<iframe
				srcDoc={controller.getSrcdoc()}
				sandbox="allow-scripts"
				allow=""
				referrerPolicy="no-referrer"
				title={contribution.title || params.contributionId}
				onLoad={(event) => controller.attach(event.currentTarget)}
				onFocus={() => controller.setFocused(true)}
				onBlur={() => controller.setFocused(false)}
				style={{
					width: "100%",
					height: "100%",
					border: 0,
					display: "block",
					pointerEvents: "auto",
				}}
			/>,
		);
	}
	if (!snapshot || ["pending", "registered", "connecting"].includes(snapshot.status)) {
		return withSlot(
			<Placeholder
				title={t("loadingTitle")}
				message={t("loadingMessage", { name: contribution.pluginName || contribution.pluginId })}
				icon={<Loader size={24} />}
			/>,
		);
	}
	if (snapshot.status === "error" || snapshot.status === "crashed") {
		return withSlot(
			<Placeholder
				title={t("errorTitle")}
				message={snapshot.error || t("errorMessage")}
				action={retry}
				actionLabel={t("reload")}
			/>,
		);
	}
	return withSlot(
		<Group gap="xs" p="xs" c="dimmed" style={{ opacity: 0.65 }}>
			<IconPlugConnected size={14} />
			<Badge size="xs" variant="light">
				{contribution.pluginName || contribution.pluginId}
			</Badge>
			<Tooltip label={t("reload")}>
				<ActionIcon size="sm" variant="subtle" onClick={retry}>
					<IconRefresh size={14} />
				</ActionIcon>
			</Tooltip>
			<Tooltip label={t("removePanel")}>
				<ActionIcon size="sm" variant="subtle" onClick={remove}>
					<IconTrash size={14} />
				</ActionIcon>
			</Tooltip>
		</Group>,
	);
}

export function PluginDockPanel(props: IDockviewPanelProps<PluginDockPanelParams>) {
	const hostApi = useMemo<PluginDockPanelHostApi>(
		() => ({
			title: props.api.title ?? undefined,
			isActive: props.api.isActive,
			setTitle: (title) => props.api.setTitle(title),
			updateParameters: (params) => props.api.updateParameters(params),
			setActive: () => props.api.setActive(),
			close: () => props.api.close(),
		}),
		[props.api, props.api.title, props.api.isActive],
	);
	return <PluginDockPanelView rawParams={props.params} hostApi={hostApi} />;
}

// `PLUGIN_DOCKVIEW_COMPONENT`, `withPluginDockviewComponent` and
// `pluginDockviewComponents` moved to `plugin-dockview-components.ts`. They are not
// components, and a non-component export here invalidates this module's Fast Refresh
// boundary — see that file's header for the measurement.
