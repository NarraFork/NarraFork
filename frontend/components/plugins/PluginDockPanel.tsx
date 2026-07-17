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
import { useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { PluginPanelSlot, useOptionalPluginUiRuntime } from "./PluginUiRuntimeProvider";
import type { PluginDockPanelParams } from "./protocol";
import { parsePluginDockPanelParams } from "./protocol";
import type { PluginUiContribution } from "./types";

function Placeholder({
	title,
	message,
	action,
	actionLabel,
	icon = <IconAlertTriangle size={24} />,
}: {
	title: string;
	message: string;
	action?: () => void;
	actionLabel?: string;
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
				{action && actionLabel ? (
					<Button size="xs" variant="light" onClick={action}>
						{actionLabel}
					</Button>
				) : null}
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
				message={t("disabledMessage", { name })}
				action={onRemove}
				actionLabel={t("removePanel")}
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

export function PluginDockPanel(props: IDockviewPanelProps<PluginDockPanelParams>) {
	const { t } = useTranslation("plugins");
	const runtime = useOptionalPluginUiRuntime();
	const params = useMemo(() => parsePluginDockPanelParams(props.params), [props.params]);
	const remove = useCallback(() => props.api.close(), [props.api]);
	const contribution = params && runtime ? runtime.resolveContribution(params) : undefined;
	const status = contribution?.status ?? "available";
	const retry = useCallback(() => {
		if (params) runtime?.reloadSession(params.panelInstanceId);
	}, [params, runtime]);
	const snapshot =
		params && runtime ? runtime.getSessionSnapshot(params.panelInstanceId) : undefined;

	useEffect(() => {
		if (!params || !runtime || !contribution || status !== "available") return;
		runtime.ensureSession(params, contribution);
	}, [contribution, params, runtime, status]);

	useLayoutEffect(() => {
		if (!params || !contribution) return;
		const title =
			contribution.title?.trim() || contribution.pluginName?.trim() || params.contributionId;
		if (title && props.api.title !== title) props.api.setTitle(title);
	}, [contribution, params, props.api]);

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
	if (!runtime || !contribution) {
		return (
			<Placeholder
				title={t("runtimeUnavailableTitle")}
				message={t("runtimeUnavailableMessage")}
				action={remove}
				actionLabel={t("removePanel")}
			/>
		);
	}
	if (status !== "available") return statusPlaceholder(status, t, contribution, retry, remove);
	const withSlot = (content: React.ReactNode) => (
		<Box h="100%" w="100%" style={{ overflow: "hidden", background: "var(--mantine-color-body)" }}>
			<PluginPanelSlot panelInstanceId={params.panelInstanceId}>{content}</PluginPanelSlot>
		</Box>
	);
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

export const PLUGIN_DOCKVIEW_COMPONENT = "plugin" as const;

export function withPluginDockviewComponent<T extends Record<string, unknown>>(components: T) {
	return { ...components, [PLUGIN_DOCKVIEW_COMPONENT]: PluginDockPanel };
}

export const pluginDockviewComponents = { [PLUGIN_DOCKVIEW_COMPONENT]: PluginDockPanel };
